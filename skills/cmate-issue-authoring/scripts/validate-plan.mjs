// cmate-issue-authoring — split-plan validator (Node stdlib only, Node >= 18).
//
//   node scripts/validate-plan.mjs <plan.json> [--schema <path>] [--json]
//   node scripts/validate-plan.mjs <plan.json> --derive-id
//
// Two layers, because one of them is not enough:
//
//  1. Conformance to `schemas/issue-split-plan.v1.json`. The schema file is read
//     and interpreted, not re-implemented here, so a schema edit cannot silently
//     stop being enforced.
//  2. The rules a JSON Schema cannot state: keys are unique, dependencies form a
//     DAG, a dry-run plan records no mutating command, a suspected duplicate is
//     blocked by an open question, and — the one that decides whether this Skill
//     did its job — every rendered body survives the cmate-orchestrate planner
//     with zero blocking questions.
//
// Exit status: 0 the plan is valid, 1 the plan is invalid, 2 the run itself
// failed (bad usage, unreadable file). A validator that cannot distinguish "your
// plan is wrong" from "I could not look" is a validator whose green means nothing.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA = resolve(HERE, '..', 'schemas', 'issue-split-plan.v1.json');

const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_ERROR = 2;

const USAGE = `cmate-issue-authoring split-plan validator

  node scripts/validate-plan.mjs <plan.json> [options]

  --schema <path>   Schema to validate against (default: the bundled v1 schema).
  --derive-id       Print the plan_id the plan's own inputs imply, then exit.
  --json            Emit findings as JSON instead of one line each.
  --help            Show this help.

Exit: 0 valid, 1 invalid, 2 usage or I/O error.`;

// =============================================================================
// Findings
// =============================================================================

class Findings {
  constructor() {
    this.items = [];
  }

  add(rule, pointer, detail) {
    this.items.push({ rule, pointer, detail });
  }

  get length() {
    return this.items.length;
  }
}

// =============================================================================
// JSON Schema subset
// =============================================================================
//
// Only the keywords the bundled schema uses are implemented, and an unknown
// keyword is reported rather than skipped: a schema that quietly loses half its
// constraints is worse than one that refuses to run.

const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value, expected) {
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number';
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'null') return value === null;
  return typeof value === expected;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
  let node = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node?.[segment];
    if (node === undefined) throw new Error(`unresolvable $ref: ${ref}`);
  }
  return node;
}

function validateAgainstSchema(value, schema, root, pointer, out) {
  if (schema.$ref) {
    validateAgainstSchema(value, resolveRef(schema.$ref, root), root, pointer, out);
    return;
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      out.add('schema_unsupported', pointer, `schema uses a keyword this validator does not implement: ${keyword}`);
    }
  }

  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    out.add('schema', pointer, `must be ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.some((allowed) => JSON.stringify(allowed) === JSON.stringify(value))) {
    out.add('schema', pointer, `must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    return;
  }
  if (schema.type && !typeMatches(value, schema.type)) {
    out.add('schema', pointer, `must be ${schema.type}, got ${typeOf(value)}`);
    return;
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      out.add('schema', pointer, `must be at least ${schema.minLength} character(s)`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      out.add('schema', pointer, `must be at most ${schema.maxLength} character(s)`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      out.add('schema', pointer, `must match ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      out.add('schema', pointer, `must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      out.add('schema', pointer, `must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.add('schema', pointer, `must have at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      out.add('schema', pointer, `must have at most ${schema.maxItems} item(s)`);
    }
    if (schema.uniqueItems) {
      const seen = new Set();
      value.forEach((item, index) => {
        const encoded = JSON.stringify(item);
        if (seen.has(encoded)) out.add('schema', `${pointer}/${index}`, 'duplicates an earlier item');
        seen.add(encoded);
      });
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validateAgainstSchema(item, schema.items, root, `${pointer}/${index}`, out);
      });
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const name of schema.required ?? []) {
      if (!(name in value)) out.add('schema', `${pointer}/${name}`, 'required property is missing');
    }
    const properties = schema.properties ?? {};
    for (const [name, child] of Object.entries(value)) {
      if (properties[name]) {
        validateAgainstSchema(child, properties[name], root, `${pointer}/${name}`, out);
      } else if (schema.additionalProperties === false) {
        out.add('schema', `${pointer}/${name}`, 'unknown property (the schema is closed)');
      }
    }
  }
}

// =============================================================================
// Planner mirror
// =============================================================================
//
// Verbatim behaviour of the extraction in cmate-orchestrate 0.11.0
// `scripts/orchestrate.mjs` (`analyzeIssue`), measured 2026-08-04. The planner
// raises exactly two blocking questions — "acceptance criteria are unclear" and
// "affected files are unclear" — and both are decided by this extraction. Keeping
// a copy here is what lets a body be checked before the Issue exists; if the
// planner's extraction changes, this mirror and the version above change with it.
// The FILE_EXT set below must stay byte-identical to the planner's; the suite in
// tests/fixtures/cmate-issue-authoring/run_tests.sh asserts the two match.

const ACCEPTANCE_HEADING_RE = /(acceptance|criteria|受入|受け入れ|完了条件|期待結果|受入条件)/i;
const HEADING_RE = /^#{1,6}\s+/;
const FILE_EXT = 'rs|md|toml|json|yaml|yml|py|sh|ts|tsx|js|jsx|mjs|cjs|go|rb|java|kt|c|h|cpp|css|html|sql|geojson|topojson|geojsonl';
const SYSTEM_ROOTS = new Set(['users', 'home', 'root', 'tmp', 'private', 'var', 'etc', 'proc']);

function firstNonEmptyLine(value) {
  for (const line of value.split(/\r?\n/)) {
    const stripped = line.replace(/^[\s\-#>*]+/, '').trim();
    if (stripped) return stripped;
  }
  return '';
}

function plannerAcceptanceCriteria(body) {
  const out = [];
  let inSection = false;
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim();
    if (HEADING_RE.test(stripped)) {
      inSection = ACCEPTANCE_HEADING_RE.test(stripped);
      continue;
    }
    if (!inSection) continue;
    if (/^[-*]\s+/.test(stripped)) {
      out.push(stripped.replace(/^[-*]\s+/, '').replace(/^\[[ xX]\]\s*/, '').trim());
    } else if (/^\d+\.\s+/.test(stripped)) {
      out.push(stripped.replace(/^\d+\.\s+/, '').replace(/^\[[ xX]\]\s*/, '').trim());
    }
  }
  return out.filter(Boolean);
}

function plannerIsSafeRepoPath(candidate) {
  if (!candidate || candidate.startsWith('/') || candidate.includes('..')) return false;
  if (candidate.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return false;
  if (/^[A-Za-z]:/.test(candidate)) return false;
  const head = candidate.split('/', 1)[0].toLowerCase();
  if (SYSTEM_ROOTS.has(head)) return false;
  if (head.endsWith(':')) return false;
  return true;
}

// Anchoring (planner Issue #49): a candidate must begin where a path can begin.
// `\b` also matches between "/" and a word character, which made the planner
// emit partial paths ("src/lib/filter.ts" out of "web/src/lib/filter.ts") and
// miss dotfile roots (".claude/…" matched only from "claude/…"). Since
// suspected_files becomes the worker's scope.allow, a partial was write
// permission on a path that does not exist. Byte-identical to the planner's.
const PATH_START = '(?<![A-Za-z0-9_./\\\\-])';
const CANDIDATE_BACKTICK = '`([^`\\s]+\\.(?:' + FILE_EXT + '))`';
const CANDIDATE_KNOWN_ROOT = PATH_START + '((?:src|tests|test|scripts|docs|lib|app|pkg|internal|cmd|\\.github)/[A-Za-z0-9_./-]+)\\b';
const CANDIDATE_WITH_EXT = PATH_START + '([A-Za-z0-9_.-]+/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\\.(?:' + FILE_EXT + '))\\b';

function plannerFileCandidates(text) {
  const patterns = [
    new RegExp(CANDIDATE_BACKTICK, 'g'),
    new RegExp(CANDIDATE_KNOWN_ROOT, 'g'),
    new RegExp(CANDIDATE_WITH_EXT, 'g'),
  ];
  const seen = new Set();
  const found = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1].trim();
      if (!plannerIsSafeRepoPath(candidate)) continue;
      if (!seen.has(candidate)) {
        seen.add(candidate);
        found.push(candidate);
      }
    }
  }
  // A candidate that is a path-boundary suffix of another is a partial of it and
  // never reaches suspected_files (planner Issue #49).
  return found.filter((candidate) => !found.some((other) => other !== candidate && other.endsWith(`/${candidate}`)));
}

// A documentation path is context to read, not a file the Issue is expected to
// change — so an Issue whose only paths are docs leaves `suspected_files` empty
// and the planner asks "affected files are unclear" no matter how many paths it
// listed. This is the asymmetry the planner-readiness rule exists to catch.
function plannerSuspectedFiles(text) {
  return plannerFileCandidates(text).filter(
    (candidate) => !/^docs\//.test(candidate) && !/\.(md|rst|txt)$/i.test(candidate),
  );
}

// =============================================================================
// Rules the schema cannot state
// =============================================================================

function derivePlanId(plan) {
  const keys = (plan.issues ?? []).map((issue) => issue?.key ?? '').join(',');
  const material = `${plan.repository ?? ''}\n${plan.source?.digest ?? ''}\n${keys}\n`;
  return `split-${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 12)}`;
}

function checkPlanId(plan, out) {
  const expected = derivePlanId(plan);
  if (plan.plan_id !== expected) {
    out.add(
      'plan_id_is_derived',
      '/plan_id',
      `plan_id must be derived from repository, source.digest and the issue keys: expected ${expected}`,
    );
  }
}

function checkIssueKeys(plan, out) {
  const seen = new Set();
  plan.issues.forEach((issue, index) => {
    if (seen.has(issue.key)) {
      out.add('unique_issue_key', `/issues/${index}/key`, `duplicate issue key "${issue.key}"`);
    }
    seen.add(issue.key);
  });
  return seen;
}

function checkDependencies(plan, keys, out) {
  const edges = new Map();
  plan.issues.forEach((issue, index) => {
    const targets = [];
    (issue.depends_on ?? []).forEach((target, position) => {
      const pointer = `/issues/${index}/depends_on/${position}`;
      if (target === issue.key) {
        out.add('known_dependency', pointer, `"${issue.key}" depends on itself`);
        return;
      }
      if (!keys.has(target)) {
        out.add('known_dependency', pointer, `depends on "${target}", which is not an issue in this plan`);
        return;
      }
      targets.push(target);
    });
    edges.set(issue.key, targets);
  });

  // Iterative depth-first search with an explicit stack: a plan is caller-shaped
  // input, and recursion would turn a long chain into a stack overflow — which
  // reads as a crashed validator rather than as a rejected plan.
  const state = new Map();
  const reported = new Set();
  for (const start of edges.keys()) {
    if (state.get(start) === 'done') continue;
    const stack = [{ node: start, path: [start], iterator: 0 }];
    state.set(start, 'open');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const children = edges.get(frame.node) ?? [];
      if (frame.iterator >= children.length) {
        state.set(frame.node, 'done');
        stack.pop();
        continue;
      }
      const child = children[frame.iterator];
      frame.iterator += 1;
      if (state.get(child) === 'open') {
        // Back edge: the path from `child` back to here is a cycle. Report it
        // once per edge — the same cycle is reachable from every node on it, and
        // a plan with one mistake should not produce five findings.
        const edge = `${frame.node}->${child}`;
        if (!reported.has(edge)) {
          reported.add(edge);
          const cycle = [...frame.path.slice(frame.path.indexOf(child)), child];
          out.add('acyclic_dependencies', '/issues', `dependency cycle: ${cycle.join(' -> ')}`);
        }
        continue;
      }
      if (state.get(child) === 'done') continue;
      state.set(child, 'open');
      stack.push({ node: child, path: [...frame.path, child], iterator: 0 });
    }
  }
}

function checkDryRunIsReadOnly(plan, out) {
  plan.commands.forEach((entry, index) => {
    if (entry.mutating) {
      out.add(
        'dry_run_has_no_mutating_command',
        `/commands/${index}`,
        `a dry-run plan records only read-only commands, got mutating: ${entry.command}`,
      );
    }
  });
}

function checkDuplicateGuard(plan, keys, out) {
  const blocked = new Set();
  plan.open_questions.forEach((question, index) => {
    (question.blocks ?? []).forEach((key, position) => {
      if (!keys.has(key)) {
        out.add(
          'known_question_target',
          `/open_questions/${index}/blocks/${position}`,
          `blocks "${key}", which is not an issue in this plan`,
        );
        return;
      }
      blocked.add(key);
    });
  });

  const ids = new Set();
  plan.open_questions.forEach((question, index) => {
    if (ids.has(question.id)) {
      out.add('unique_question_id', `/open_questions/${index}/id`, `duplicate question id "${question.id}"`);
    }
    ids.add(question.id);
  });

  plan.duplicate_suspicions.forEach((suspicion, index) => {
    if (!keys.has(suspicion.issue_key)) {
      out.add(
        'known_duplicate_target',
        `/duplicate_suspicions/${index}/issue_key`,
        `names "${suspicion.issue_key}", which is not an issue in this plan`,
      );
      return;
    }
    if (suspicion.verdict === 'duplicate' && !blocked.has(suspicion.issue_key)) {
      out.add(
        'duplicate_needs_open_question',
        `/duplicate_suspicions/${index}`,
        `"${suspicion.issue_key}" is a suspected duplicate of ${suspicion.ref} but no open question blocks it; ` +
          'a duplicate must not be registered on the user\'s behalf',
      );
    }
  });
}

function checkEvidence(plan, out) {
  plan.issues.forEach((issue, index) => {
    (issue.evidence ?? []).forEach((entry, position) => {
      if (entry.kind !== 'file') return;
      const path = String(entry.ref).split(':', 1)[0];
      if (path.startsWith('/') || path.split('/').includes('..')) {
        out.add(
          'evidence_ref_stays_in_repo',
          `/issues/${index}/evidence/${position}/ref`,
          `file evidence must name a repository-relative path, got ${entry.ref}`,
        );
      }
    });
  });
}

//: A planned Issue has no number yet, so a cross-link is written as a
//: placeholder and Phase 2 substitutes `#<number>` when it creates the Issue the
//: key refers to. Registration follows dependency order, so the substitution
//: always has a number to put there.
const DEPENDENCY_PLACEHOLDER_RE = /\{\{issue:([a-z0-9-]+)\}\}/g;

function checkBodies(plan, keys, out) {
  plan.issues.forEach((issue, index) => {
    const body = String(issue.body ?? '');
    const pointer = `/issues/${index}`;

    if (firstNonEmptyLine(body) !== issue.objective) {
      out.add(
        'body_states_objective',
        `${pointer}/body`,
        'the first non-empty line of body must be the objective verbatim, because that is what the ' +
          'cmate-orchestrate planner reads as the objective',
      );
    }

    const criteria = plannerAcceptanceCriteria(body);
    if (criteria.length === 0) {
      out.add(
        'planner_ready',
        `${pointer}/body`,
        'the planner would ask "Acceptance criteria are unclear": body has no acceptance heading with list items',
      );
    }

    const suspected = plannerSuspectedFiles(`${issue.title}\n\n${body}`);
    if (suspected.length === 0) {
      out.add(
        'planner_ready',
        `${pointer}/body`,
        'the planner would ask "Affected files are unclear": body names no non-documentation path ' +
          '(a docs/ path or a .md/.rst/.txt file is classified as a reference, never as a suspected file)',
      );
    }

    (issue.target_files ?? []).forEach((path, position) => {
      if (!body.includes(path)) {
        out.add(
          'body_lists_target_files',
          `${pointer}/target_files/${position}`,
          `"${path}" is a target file but does not appear in body, so the planner never sees it`,
        );
      }
    });

    const linked = new Set();
    for (const match of body.matchAll(DEPENDENCY_PLACEHOLDER_RE)) {
      const target = match[1];
      linked.add(target);
      if (target === issue.key) {
        out.add('dependency_link_in_body', `${pointer}/body`, `body links to itself ({{issue:${target}}})`);
      } else if (!keys.has(target)) {
        out.add(
          'dependency_link_in_body',
          `${pointer}/body`,
          `body links to {{issue:${target}}}, which is not an issue in this plan`,
        );
      }
    }
    (issue.depends_on ?? []).forEach((target, position) => {
      if (!linked.has(target)) {
        out.add(
          'dependency_link_in_body',
          `${pointer}/depends_on/${position}`,
          `depends on "${target}" but body carries no {{issue:${target}}} placeholder, ` +
            'so the registered Issue would not state the dependency',
        );
      }
    });
  });
}

// =============================================================================
// Entry point
// =============================================================================

function parseArgs(argv) {
  const options = { plan: null, schema: DEFAULT_SCHEMA, json: false, deriveId: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--derive-id') {
      options.deriveId = true;
    } else if (arg === '--schema') {
      index += 1;
      if (index >= argv.length) throw new Error('--schema needs a path');
      options.schema = argv[index];
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (options.plan === null) {
      options.plan = arg;
    } else {
      throw new Error('exactly one plan file is accepted');
    }
  }
  if (!options.help && options.plan === null) throw new Error('a plan file is required');
  return options;
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`${label} is not readable: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n\n${USAGE}\n`);
    return EXIT_ERROR;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_VALID;
  }

  let plan;
  let schema;
  try {
    plan = readJson(options.plan, 'plan');
    schema = readJson(options.schema, 'schema');
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return EXIT_ERROR;
  }

  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    process.stderr.write('error: plan must be a JSON object\n');
    return EXIT_ERROR;
  }

  if (options.deriveId) {
    process.stdout.write(`${derivePlanId(plan)}\n`);
    return EXIT_VALID;
  }

  const findings = new Findings();
  try {
    validateAgainstSchema(plan, schema, schema, '', findings);
  } catch (error) {
    process.stderr.write(`error: schema could not be applied: ${error.message}\n`);
    return EXIT_ERROR;
  }

  // The semantic rules index into the plan's own arrays, so they run only once
  // the shape is known good. Reporting "dependency cycle" for a plan whose
  // `issues` is a string would be noise on top of the finding that matters.
  if (findings.length === 0) {
    checkPlanId(plan, findings);
    const keys = checkIssueKeys(plan, findings);
    checkDependencies(plan, keys, findings);
    checkDryRunIsReadOnly(plan, findings);
    checkDuplicateGuard(plan, keys, findings);
    checkEvidence(plan, findings);
    checkBodies(plan, keys, findings);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      valid: findings.length === 0,
      plan_id: typeof plan.plan_id === 'string' ? plan.plan_id : null,
      findings: findings.items,
    }, null, 2)}\n`);
  } else if (findings.length === 0) {
    process.stdout.write(`VALID ${plan.plan_id} (${plan.issues.length} issue(s))\n`);
  } else {
    for (const finding of findings.items) {
      process.stdout.write(`FAIL ${finding.rule} ${finding.pointer || '/'} ${finding.detail}\n`);
    }
    process.stdout.write(`INVALID ${findings.length} finding(s)\n`);
  }

  return findings.length === 0 ? EXIT_VALID : EXIT_INVALID;
}

process.exit(main(process.argv.slice(2)));
