#!/usr/bin/env node
// cmate-orchestrate — deterministic plan-core runner (Node stdlib only, Node >= 22).
//
// This runner does the *planning* half of official CommandMate issue
// orchestration: it reads issues, analyses each one, resolves explicit and
// inferred dependencies, refuses unsafe graphs, packs issues into conflict-free
// waves bounded by max_parallel, and writes an inspectable dry-run plan.
//
// It never mutates anything outside its own run directory: no worktree, no
// dispatch, no PR, no merge, no UAT loop. Those phases (#1454-1456) are refused
// here on purpose. The default invocation is a dry run and stays a dry run.
//
// Determinism: the plan is a pure function of its inputs (issue set AND issue
// content — title/body/labels —, base, profile, max_parallel, dependency
// overrides, phase). The default run_id is a hash of those inputs, so the same
// input yields the same plan — the parity a Claude run and a Codex run are
// checked against — and a distinct input yields a distinct run directory that
// never overwrites an existing one. Because issue content is in the hash, the
// normal "fix the issue body, re-plan" loop lands in a new run directory
// instead of being refused (#46 / CommandMate #1678 B-4).

import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REDACTIONS, SKILL_ID, SKILL_VERSION, SkillError } from './lib.mjs';

const PLAN_SCHEMA_VERSION = 2;
const RESULT_SCHEMA_VERSION = 1;

// The permissions the full orchestration would require, mirrored from the
// package manifest. Reported in the plan so a reviewer sees, before any mutating
// phase exists, what consent the eventual execution will ask for.
const DECLARED_PERMISSIONS = [
  'filesystem_read',
  'filesystem_write',
  'process_execution',
  'network_access',
];

const MAX_PARALLEL_MIN = 1;
const MAX_PARALLEL_MAX = 3;
const DEFAULT_MAX_PARALLEL = 3;

// Only the planning phase is implemented in this version. Any mutating phase is
// refused rather than silently ignored.
const PHASE_PLAN = 'plan';
const MUTATING_PHASES = new Set(['dispatch', 'pr', 'merge', 'uat']);

const DEFAULT_RUNS_DIR = '.commandmate/orchestrate/runs';

// The two profiles verified in the #1447 ADR. branch/base/worktree/baseline all
// come from here rather than being hardcoded in the planner, so a third
// repository is a data change, not a code change.
const BUILTIN_PROFILES = {
  'node-commandmate': {
    id: 'node-commandmate',
    repository: 'Kewton/CommandMate',
    base: 'origin/develop',
    branch_template: 'feature/issue-{number}-{slug}',
    worktree_template: '../{repo}-issue-{number}-{slug}',
    baseline: ['npm ci', 'npm run build', 'npm test'],
    verified: true,
  },
  'rust-commandagent': {
    id: 'rust-commandagent',
    repository: 'Kewton/CommandAgent',
    base: 'origin/develop',
    branch_template: 'feature/issue-{number}-{slug}',
    worktree_template: '../{repo}-issue-{number}-{slug}',
    baseline: ['cargo fmt --check', 'cargo clippy --all-targets -- -D warnings', 'cargo test'],
    verified: true,
  },
};

const PROFILE_FIELDS = [
  'id',
  'repository',
  'base',
  'branch_template',
  'worktree_template',
  'baseline',
  'verified',
];

// =============================================================================
// Redaction
// =============================================================================

// Applied to every free-text field lifted out of an issue before it is stored.
// A token or an absolute host path in an issue body must not survive into a
// plan, a result or an audit artifact. The pattern list is shared with the three
// mutating runners (lib.mjs REDACTIONS) because a shape added to one runner and
// missed in another leaks from the one that missed it.
//
// This copy of redact() is deliberately NOT the shared one: the three mutating
// runners tally what they removed so their reports can carry a `redactions[]`
// field, and the plan result envelope has no such field. Hoisting the tallying
// version here would be a behavior change, so the difference stays local.
function redact(value) {
  let text = String(value);
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

// =============================================================================
// Argument parsing
// =============================================================================

const USAGE = `cmate-orchestrate plan-core runner (dry-run only)

Usage:
  orchestrate.mjs <issue>... [options]

Options:
  --issues <n,n,...>     Issue numbers (alternative to positionals).
  --issue-json <path>    Issue fixture JSON for offline, deterministic planning.
  --profile <id>         Built-in profile: node-commandmate | rust-commandagent.
  --profile-json <path>  Custom profile JSON (see references/profile-contract.md).
  --base <ref>           Override the profile's base branch.
  --repo <owner/name>    Override the profile's repository.
  --max-parallel <1-3>   Wave width bound (default 3).
  --phase <plan>         Only "plan" is implemented; mutating phases are refused.
  --depends <a:b>        Override: issue a depends on issue b (repeatable).
  --no-infer             Disable inferred dependencies (explicit/override only).
  --order <n,n,...>      Assert an issue ordering; rejected if it breaks the DAG.
  --run-id <id>          Stable run id (default: a hash of the inputs).
  --runs-dir <path>      Where run directories are written (default ${DEFAULT_RUNS_DIR}).
  --allow-unverified     Permit planning against an unverified profile.
  --help                 Show this help.

The default invocation is a dry run: it writes a plan and mutates nothing else.`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        issues: { type: 'string' },
        'issue-json': { type: 'string' },
        profile: { type: 'string' },
        'profile-json': { type: 'string' },
        base: { type: 'string' },
        repo: { type: 'string' },
        'max-parallel': { type: 'string' },
        phase: { type: 'string' },
        depends: { type: 'string', multiple: true },
        'no-infer': { type: 'boolean' },
        order: { type: 'string' },
        'run-id': { type: 'string' },
        'runs-dir': { type: 'string' },
        'allow-unverified': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new SkillError('invalid_input', error.message, 3);
  }
  return parsed;
}

function parseIssueNumbers(values, name) {
  const numbers = [];
  const seen = new Set();
  for (const raw of values) {
    const token = String(raw).trim().replace(/^#/, '');
    if (!/^\d+$/.test(token)) {
      throw new SkillError('invalid_input', `${name} must be positive integers: got "${raw}"`, 3);
    }
    const number = Number.parseInt(token, 10);
    if (!seen.has(number)) {
      seen.add(number);
      numbers.push(number);
    }
  }
  return numbers;
}

function resolveInputs(parsed) {
  const { values, positionals } = parsed;

  const issueTokens = [
    ...positionals,
    ...(values.issues ? values.issues.split(',') : []),
  ].filter((token) => String(token).trim() !== '');
  const issues = parseIssueNumbers(issueTokens, 'issue numbers');
  if (issues.length === 0) {
    throw new SkillError('invalid_input', 'at least one issue number is required', 3);
  }

  const phase = values.phase ?? PHASE_PLAN;
  if (MUTATING_PHASES.has(phase)) {
    throw new SkillError(
      'not_implemented',
      `phase "${phase}" is a mutating phase not implemented in this version; ` +
        'run the default "plan" phase to produce a dry-run plan',
      2,
    );
  }
  if (phase !== PHASE_PLAN) {
    throw new SkillError('invalid_input', `unknown phase "${phase}"; only "plan" is supported`, 3);
  }

  let maxParallel = DEFAULT_MAX_PARALLEL;
  if (values['max-parallel'] !== undefined) {
    if (!/^\d+$/.test(values['max-parallel'])) {
      throw new SkillError('invalid_input', 'max-parallel must be an integer', 3);
    }
    maxParallel = Number.parseInt(values['max-parallel'], 10);
  }
  if (maxParallel < MAX_PARALLEL_MIN || maxParallel > MAX_PARALLEL_MAX) {
    throw new SkillError(
      'invalid_input',
      `max-parallel must be between ${MAX_PARALLEL_MIN} and ${MAX_PARALLEL_MAX}`,
      3,
    );
  }

  const order = values.order
    ? parseIssueNumbers(values.order.split(','), 'order')
    : null;

  return {
    issues,
    phase,
    maxParallel,
    order,
    infer: !values['no-infer'],
    dependsRaw: values.depends ?? [],
    issueJson: values['issue-json'] ?? null,
    profileId: values.profile ?? null,
    profileJson: values['profile-json'] ?? null,
    baseOverride: values.base ?? null,
    repoOverride: values.repo ?? null,
    runIdOverride: values['run-id'] ?? null,
    runsDir: values['runs-dir'] ?? DEFAULT_RUNS_DIR,
    allowUnverified: Boolean(values['allow-unverified']),
  };
}

// =============================================================================
// Profile resolution
// =============================================================================

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SkillError('load_error', `cannot read ${what} at ${path}: ${error.message}`, 6);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SkillError('load_error', `${what} at ${path} is not valid JSON: ${error.message}`, 6);
  }
}

// The remote URL of the current working directory, normalized to `owner/name`.
// Both git URL forms the CLI writes are accepted:
//
//   git@github.com:Owner/Name.git        ssh://git@github.com/Owner/Name.git
//   https://github.com/Owner/Name.git    https://user@github.com/Owner/Name
//
// Returns null when the cwd is not a git repository, has no `origin`, or the
// URL does not normalize to exactly two path segments. A null is a *skip*, never
// a mismatch: the planner must not invent a discrepancy out of a failed probe.
function cwdOriginRepository() {
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  return normalizeRemoteUrl(url);
}

function normalizeRemoteUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let rest = url.trim();
  const scp = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(rest); // scp-like ssh form
  if (scp) {
    rest = scp[2];
  } else {
    const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(.*)$/.exec(rest);
    if (!withScheme) return null;
    const afterHost = withScheme[1].replace(/^[^/]*\//, ''); // drop [user@]host[:port]
    if (afterHost === withScheme[1]) return null;
    rest = afterHost;
  }
  rest = rest.replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = rest.split('/').filter((s) => s !== '');
  if (segments.length !== 2) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(segments[0]) || !/^[A-Za-z0-9._-]+$/.test(segments[1])) return null;
  return `${segments[0]}/${segments[1]}`;
}

function sameRepository(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

// Resolves the profile and reports what about that resolution the reviewer has
// to know before approving the plan. Returns { profile, warnings }: a warning is
// never fatal, but it does downgrade the run to `partial` so a plan built on a
// shaky premise cannot read as a clean success.
function resolveProfile(inputs) {
  let profile;
  // Whether the profile is the *default* one — nobody named it. That is the case
  // the repository cross-check below exists for: an explicit --profile is a
  // deliberate choice, a default is an assumption the runner made for you.
  const defaultResolved = !inputs.profileJson && !inputs.profileId;
  const warnings = [];

  if (inputs.profileJson) {
    const raw = readJson(inputs.profileJson, 'profile');
    profile = normalizeProfile(raw);
  } else {
    const id = inputs.profileId ?? 'node-commandmate';
    profile = BUILTIN_PROFILES[id];
    if (!profile) {
      const known = Object.keys(BUILTIN_PROFILES).join(', ');
      throw new SkillError(
        'invalid_input',
        `unknown profile "${id}"; built-in profiles are: ${known}. ` +
          'Pass --profile-json for a custom profile.',
        3,
      );
    }
    profile = { ...profile };
  }

  // A repository override moves the profile off the repository its branch/base/
  // worktree/baseline were verified against, so the verification no longer
  // covers it. Downgrade rather than carry a stale `verified: true` forward.
  const repoOverridden = Boolean(inputs.repoOverride) && !sameRepository(inputs.repoOverride, profile.repository);
  if (inputs.repoOverride) profile.repository = inputs.repoOverride;
  if (inputs.baseOverride) profile.base = inputs.baseOverride;

  if (repoOverridden && profile.verified) {
    profile.verified = false;
    profile.verified_downgraded = true;
  }

  if (!profile.verified && !inputs.allowUnverified) {
    const because = profile.verified_downgraded
      ? `profile "${profile.id}" was verified against a different repository and --repo re-pointed it at ` +
        `${profile.repository}, which drops that verification; `
      : `profile "${profile.id}" is not a verified profile; `;
    throw new SkillError(
      'unverified_profile',
      `${because}re-run with --allow-unverified after confirming branch/base/worktree/baseline are correct`,
      3,
    );
  }
  if (profile.verified_downgraded) {
    warnings.push({
      code: 'profile_repository_override',
      detail:
        `--repo re-pointed profile "${profile.id}" at ${profile.repository}; its branch/base/worktree/baseline ` +
        'were verified against a different repository, so this plan runs on an unverified profile',
    });
  }
  delete profile.verified_downgraded;

  // The #36 cross-check: a default profile plans against *its* repository, not
  // the one the operator is standing in. Reading another repository's issues
  // that way produces a plan that looks clean and is about the wrong work.
  if (defaultResolved) {
    const origin = cwdOriginRepository();
    if (origin !== null && !sameRepository(origin, profile.repository)) {
      warnings.push({
        code: 'profile_repository_mismatch',
        detail:
          `the working directory's origin is ${origin} but the default profile "${profile.id}" targets ` +
          `${profile.repository}; the issues in this plan were read from ${profile.repository}. ` +
          'Pass --profile / --profile-json / --repo to plan against this repository.',
      });
    }
  }

  return { profile, warnings };
}

function normalizeProfile(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillError('load_error', 'profile must be a JSON object', 6);
  }
  for (const key of Object.keys(raw)) {
    if (!PROFILE_FIELDS.includes(key)) {
      throw new SkillError('load_error', `profile has an unknown field "${key}"`, 6);
    }
  }
  const required = ['id', 'repository', 'base', 'branch_template', 'worktree_template', 'baseline'];
  for (const key of required) {
    if (raw[key] === undefined || raw[key] === null) {
      throw new SkillError('load_error', `profile is missing "${key}"`, 6);
    }
  }
  if (!Array.isArray(raw.baseline) || raw.baseline.some((c) => typeof c !== 'string')) {
    throw new SkillError('load_error', 'profile.baseline must be an array of strings', 6);
  }
  return {
    id: String(raw.id),
    repository: String(raw.repository),
    base: String(raw.base),
    branch_template: String(raw.branch_template),
    worktree_template: String(raw.worktree_template),
    baseline: raw.baseline.map(String),
    // A profile is unverified unless it explicitly claims verification.
    verified: raw.verified === true,
  };
}

// =============================================================================
// Issue loading
// =============================================================================

function normalizeLabels(raw) {
  if (!Array.isArray(raw)) return [];
  const labels = [];
  for (const item of raw) {
    if (typeof item === 'string') labels.push(item);
    else if (item && typeof item === 'object' && typeof item.name === 'string') labels.push(item.name);
  }
  return labels;
}

function loadIssues(inputs, profile) {
  if (inputs.issueJson) {
    return loadIssuesFromFixture(inputs.issues, inputs.issueJson);
  }
  return inputs.issues.map((number) => fetchIssueWithGh(number, profile.repository));
}

function loadIssuesFromFixture(numbers, path) {
  const raw = readJson(path, 'issue fixture');
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.issues) ? raw.issues : null;
  if (!items) {
    throw new SkillError(
      'load_error',
      '--issue-json must be a list or an object with an "issues" list',
      6,
    );
  }
  const byNumber = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const number = Number.parseInt(item.number, 10);
    if (!Number.isInteger(number)) continue;
    byNumber.set(number, {
      number,
      title: String(item.title ?? ''),
      body: String(item.body ?? ''),
      labels: normalizeLabels(item.labels),
    });
  }
  const missing = numbers.filter((n) => !byNumber.has(n));
  if (missing.length > 0) {
    throw new SkillError('load_error', `fixture does not contain issues: ${missing.join(', ')}`, 6);
  }
  return numbers.map((n) => byNumber.get(n));
}

function fetchIssueWithGh(number, repo) {
  let stdout;
  try {
    stdout = execFileSync(
      'gh',
      ['issue', 'view', String(number), '--repo', repo, '--json', 'number,title,body,labels'],
      { encoding: 'utf8' },
    );
  } catch (error) {
    throw new SkillError(
      'load_error',
      `gh could not read issue #${number} from ${repo}; ` +
        'pass --issue-json to plan offline. ' +
        redact(error.message ?? ''),
      6,
    );
  }
  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new SkillError('load_error', `gh returned unparseable JSON for #${number}`, 6);
  }
  return {
    number: Number.parseInt(raw.number, 10),
    title: String(raw.title ?? ''),
    body: String(raw.body ?? ''),
    labels: normalizeLabels(raw.labels),
  };
}

// =============================================================================
// Issue analysis
// =============================================================================

function slugify(value, maxLen = 48) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  const compact = normalized.slice(0, maxLen).replace(/^-+|-+$/g, '');
  return compact || 'task';
}

function firstNonEmptyLine(value) {
  for (const line of value.split(/\r?\n/)) {
    const stripped = line.replace(/^[\s\-#>*]+/, '').trim();
    if (stripped) return stripped;
  }
  return '';
}

const ACCEPTANCE_HEADING_RE = /(acceptance|criteria|受入|受け入れ|完了条件|期待結果|受入条件)/i;
const HEADING_RE = /^#{1,6}\s+/;

function extractAcceptanceCriteria(body) {
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
      out.push(cleanCriterion(stripped.replace(/^[-*]\s+/, '')));
    } else if (/^\d+\.\s+/.test(stripped)) {
      out.push(cleanCriterion(stripped.replace(/^\d+\.\s+/, '')));
    }
  }
  return out.filter(Boolean);
}

// Task-list checkboxes (`- [ ] ...`) are common in acceptance sections; keep the
// text, drop the marker.
function cleanCriterion(text) {
  return text.replace(/^\[[ xX]\]\s*/, '').trim();
}

// A deliberately broad extension set: a path wrongly kept is a candidate a
// reviewer can drop, a path missed is context the plan never had.
// Mirrored verbatim in cmate-issue-authoring scripts/validate-plan.mjs; the
// issue-authoring test suite asserts the two stay identical.
//
// `jsonc` (Issue #56) is here for the same reason `geojson` is (#43), with one
// difference that removes the usual escape hatch: the affected files carry
// FRAMEWORK-FIXED names. `wrangler.jsonc` is what Cloudflare Workers reads and
// `deno.jsonc` is what Deno reads, so "name it .json instead" is not advice an
// issue author can take. Worse than the geojson case, the drop was completely
// silent for a repository-root file: `extractUnrecognizedPaths` only looks at
// backtick paths containing a "/", so `wrangler.jsonc` produced no
// `unrecognized_file_extension` warning either — it simply was not in
// suspected_files, hence not in the contract's scope.allow, and the worker was
// failed by the scope gate the moment it edited the file it was told to edit.
// `json5` is deliberately NOT added: no widely deployed tool requires a file
// literally named `*.json5` (the JSON5 readers all accept another extension or
// are configured by file name), so it would widen every worker's scope.allow for
// a demand nobody has reported. Same for `jsonl`. Add them when an issue shows
// a fixed name that forces them.
const FILE_EXT = 'rs|md|toml|json|jsonc|yaml|yml|py|sh|ts|tsx|js|jsx|mjs|cjs|go|rb|java|kt|c|h|cpp|css|html|sql|geojson|topojson|geojsonl';
const SYSTEM_ROOTS = new Set(['users', 'home', 'root', 'tmp', 'private', 'var', 'etc', 'proc']);

// A candidate must begin where a path can begin (Issue #49). `\b` does not: it
// also matches between "/" and a word character, so the SAME path matched a
// second time from the middle. Measured on 0.11.0:
// "bash .claude/skills/cmate-verify/scripts/verify-run.sh" yielded
// "scripts/verify-run.sh" and "claude/skills/cmate-verify/scripts/verify-run.sh"
// (neither exists, and the real ".claude/..." path was never produced —
// a leading "." carries no word boundary); "web/src/lib/filter.ts" additionally
// yielded "src/lib/filter.ts"; "https://example.com/a/b.ts" yielded
// "example.com/a/b.ts". suspected_files becomes the worker's scope.allow
// verbatim, so every one of those was write permission granted to an invented
// path. The lookbehind pins each match to a token start — a position no path
// character precedes — which both stops the partials and lets a dotfile root
// ("`.claude/…`", ".github/…") match from its real first character.
//
// PATH_START and the three pattern sources below are mirrored byte for byte in
// cmate-issue-authoring scripts/validate-plan.mjs; the issue-authoring suite
// asserts the two copies stay identical.
const PATH_START = '(?<![A-Za-z0-9_./\\\\-])';
const CANDIDATE_BACKTICK = '`([^`\\s]+\\.(?:' + FILE_EXT + '))`';
const CANDIDATE_KNOWN_ROOT = PATH_START + '((?:src|tests|test|scripts|docs|lib|app|pkg|internal|cmd|\\.github)/[A-Za-z0-9_./-]+)\\b';
const CANDIDATE_WITH_EXT = PATH_START + '([A-Za-z0-9_.-]+/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\\.(?:' + FILE_EXT + '))\\b';

// Headings under which a path is the issue's PRODUCT rather than its context
// (Issue #50). See classifyFileCandidates for why the extension alone cannot
// decide that. Mirrored in cmate-issue-authoring scripts/validate-plan.mjs.
const DELIVERABLE_HEADING_RE = /(deliverable|成果物|対象ファイル|変更対象|変更ファイル|作成ファイル|編集対象|出力ファイル|生成ファイル|affected files|target files|output files|files to (?:change|edit|create|write|add))/i;

// The counterpart of DELIVERABLE_HEADING_RE (Issue #54). #50 gave an issue a way
// to say "this path IS what I produce" but no way to say the opposite, and a bug
// report cites the file it reproduces in — as `path:line`, under 根拠 — far more
// often than it lists deliverables. Those citations became suspected_files, i.e.
// the worker's scope.allow, so an issue that wrote "this file is NOT changed"
// handed out write permission on it anyway.
//
// The set is deliberately narrow. Over-excluding is the worse error: it drops a
// real target out of scope.allow and the worker is refused by the scope gate for
// writing what it was told to write — the exact failure #50 removed. Headings
// that a bug report uses for the file it is about (現状 / 調査 / 再現手順) are
// therefore NOT here, even though they are "context" in a loose sense.
// Mirrored in cmate-issue-authoring scripts/validate-plan.mjs.
const CONTEXT_HEADING_RE = /(根拠|出典|参考|参照|背景|関連|references?|context|background|see also|appendix)/i;

// Character offsets covered by the sections whose heading `matches`, so a
// candidate's position in the body decides how it is classified. A section runs
// from the line after its heading to the next heading of any level (or end of
// text).
function headingSpans(text, matches) {
  const spans = [];
  let offset = 0;
  let open = null;
  for (const line of text.split('\n')) {
    if (HEADING_RE.test(line.trim())) {
      if (open !== null) {
        spans.push([open, offset]);
        open = null;
      }
      if (matches(line.trim())) open = offset + line.length + 1;
    }
    offset += line.length + 1;
  }
  if (open !== null) spans.push([open, offset]);
  return spans;
}

const deliverableSpans = (text) => headingSpans(text, (line) => DELIVERABLE_HEADING_RE.test(line));

// A heading that reads as both ("## 対象ファイル（参考）") is a deliverable
// heading: the statement that something is produced outranks the one that it is
// only context, the same precedence a candidate gets below.
const contextSpans = (text) =>
  headingSpans(text, (line) => !DELIVERABLE_HEADING_RE.test(line) && CONTEXT_HEADING_RE.test(line));

function inSpans(spans, index) {
  return spans.some(([start, end]) => index >= start && index < end);
}

// Returns { paths, deliverable, contextOnly, shadowed }: the de-duplicated
// candidates in order of first appearance, the subset a deliverable heading
// covers, the subset that appears ONLY under a context heading, and the ones
// dropped for being a partial of another candidate.
function extractFileCandidates(text) {
  const patterns = [
    new RegExp(CANDIDATE_BACKTICK, 'g'),
    new RegExp(CANDIDATE_KNOWN_ROOT, 'g'),
    new RegExp(CANDIDATE_WITH_EXT, 'g'),
  ];
  const spans = deliverableSpans(text);
  const cSpans = contextSpans(text);
  const seen = new Set();
  const deliverable = new Set();
  const inContext = new Set();
  const outsideContext = new Set();
  const found = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1].trim();
      if (!isSafeRepoPath(candidate)) continue;
      // A path written as context in one place and as a deliverable in another
      // is a deliverable: the stronger statement wins.
      if (inSpans(spans, match.index)) deliverable.add(candidate);
      if (inSpans(cSpans, match.index)) inContext.add(candidate);
      else outsideContext.add(candidate);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        found.push(candidate);
      }
    }
  }
  // Excluded only when EVERY mention sits under a context heading. A path the
  // issue also names in prose ("src/a.ts を直す") is still a target however many
  // times it is cited as evidence further down — the citation does not retract
  // the instruction. This also gives deliverable headings their precedence for
  // free, since a deliverable span is never a context span.
  const contextOnly = new Set([...inContext].filter((candidate) => !outsideContext.has(candidate)));
  const { kept, shadowed } = dropShadowedCandidates(found);
  return { paths: kept, deliverable, contextOnly, shadowed, found };
}

// The other half of Issue #49. Anchoring stops the extraction INVENTING a
// partial path, but an issue can still write "web/src/lib/filter.ts" in one
// place and "src/lib/filter.ts" in another. At most one of the two is the file
// the issue means, and the shorter one is a path-boundary suffix of the longer:
// keeping it would hand the worker a second directory the issue never named.
// It is dropped — and, like an unrecognised extension, reported rather than
// silently discarded, because the drop is what removes it from scope.allow.
function dropShadowedCandidates(paths) {
  const kept = [];
  const shadowed = [];
  for (const candidate of paths) {
    const covering = paths.find((other) => other !== candidate && other.endsWith(`/${candidate}`));
    if (covering === undefined) kept.push(candidate);
    else shadowed.push({ path: candidate, covered_by: covering });
  }
  return { kept, shadowed };
}

// Client-controlled text must never name anything outside the target repository:
// no absolute path, no drive-letter path, no ".." escape, no control character.
function isSafeRepoPath(candidate) {
  if (!candidate || candidate.startsWith('/') || candidate.includes('..')) return false;
  if (candidate.includes('\\')) return false;
  if (/[\x00-\x1f\x7f]/.test(candidate)) return false;
  if (/^[A-Za-z]:/.test(candidate)) return false;
  const head = candidate.split('/', 1)[0].toLowerCase();
  if (SYSTEM_ROOTS.has(head)) return false;
  if (head.endsWith(':')) return false; // e.g. "https:" from a URL
  return true;
}

// The counterpart of FILE_EXT being a closed set (CommandMate #1678 B-1): a
// backtick path whose extension is outside it used to vanish from the plan
// silently, and because suspected_files becomes the worker's scope.allow, the
// scope gate then refused the very file the issue named — unresolvable from
// inside the worker. Extraction stays conservative; the drop is reported.
const BACKTICK_PATH_RE = /`([^`\s]*\/[^`\s]*\.[A-Za-z][A-Za-z0-9]*)`/g;

function extractUnrecognizedPaths(text, candidates) {
  const extracted = new Set(candidates);
  const seen = new Set();
  const out = [];
  for (const match of text.matchAll(BACKTICK_PATH_RE)) {
    const candidate = match[1].trim();
    if (extracted.has(candidate) || seen.has(candidate)) continue;
    if (!isSafeRepoPath(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

function extractionWarnings(analyses) {
  const out = [];
  for (const analysis of analyses) {
    for (const path of analysis._unrecognizedPaths) {
      const ext = path.slice(path.lastIndexOf('.') + 1);
      out.push({
        code: 'unrecognized_file_extension',
        detail: redact(
          `#${analysis.number} writes \`${path}\` in backticks, but ".${ext}" is not a recognised extension, ` +
            "so the path is not in suspected_files and stays outside the worker's scope; " +
            "extend the planner's FILE_EXT or state a path with a recognised extension if the worker must touch it",
        ),
      });
    }
    for (const { path, covered_by: coveredBy } of analysis._shadowedPaths) {
      out.push({
        code: 'shadowed_file_candidate',
        detail: redact(
          `#${analysis.number} names \`${path}\`, which is a path-boundary suffix of \`${coveredBy}\`; ` +
            'at most one of the two is the file the issue means, so the shorter path is not in ' +
            "suspected_files and stays outside the worker's scope; write the full repository-relative " +
            'path if the worker must also touch it',
        ),
      });
    }
  }
  return out;
}

// An open question is a thing the planner could NOT read out of the issue, so it
// belongs in `warnings` — the channel that drops `status` to `partial` — and not
// only in `issues[].questions`, which nothing downstream was obliged to look at
// (Issue #52). Before this, an issue with no acceptance criteria at all planned
// as a clean `success` with exit 0 and flowed straight into dispatch.
function openQuestionWarnings(analyses) {
  const out = [];
  for (const analysis of analyses) {
    for (const question of analysis._openQuestions) {
      out.push({
        code: question.code,
        detail: redact(
          `#${analysis.number}: ${question.text} ` +
            'The dispatch runner refuses an issue with an unanswered question; ' +
            'edit the issue body and re-plan, or accept the risk explicitly with --allow-questions.',
        ),
      });
    }
  }
  return out;
}

// The extension alone cannot decide whether a path is context or product
// (Issue #50). A documentation path is USUALLY context to read — but an issue
// whose deliverable IS a Markdown document (a design note, an ADR, a runbook)
// named every file it had to write and still got an empty suspected_files, so
// the contract declared no scope and the worker was refused by the scope gate
// for writing exactly what it was told to write. A path under a "成果物 /
// 対象ファイル / 変更対象 / Deliverables" heading is the issue stating what it
// produces, and that statement outranks the extension rule. Anywhere else a
// .md/.rst/.txt or docs/ path stays a reference.
//
// The symmetric statement is a path mentioned only under a context heading
// (Issue #54): the issue is citing it, not claiming it. Extension says nothing
// about that case — a cited `src/foo.ts` is code — so the position has to.
function classifyFileCandidates(candidates, deliverable, contextOnly) {
  const suspected = [];
  const references = [];
  for (const candidate of candidates) {
    if (contextOnly.has(candidate)) {
      references.push(candidate);
    } else if (!deliverable.has(candidate) && (/^docs\//.test(candidate) || /\.(md|rst|txt)$/i.test(candidate))) {
      references.push(candidate);
    } else {
      suspected.push(candidate);
    }
  }
  return { suspected, references };
}

// Ecosystem lockfiles that a dependency-manifest edit drags along (CommandMate
// #1678 B-2): `npm install` rewrites the lockfile next to the package.json it
// changed, and a lockfile missing from suspected_files — the worker's future
// scope.allow — fails the scope gate in a way the worker cannot resolve. When an
// issue names a manifest, its same-directory lockfiles are therefore allowed by
// default, and reported in the plan's `scope_defaults` so a reviewer sees which
// entries the planner added on the issue's behalf rather than read in the issue.
const SCOPE_DEFAULT_COMPANIONS = {
  'package.json': ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
  'Cargo.toml': ['Cargo.lock'],
  'go.mod': ['go.sum'],
  'pyproject.toml': ['poetry.lock', 'uv.lock'],
  'Gemfile': ['Gemfile.lock'],
};

function scopeDefaultsFor(suspected) {
  const have = new Set(suspected);
  const out = [];
  for (const path of suspected) {
    const cut = path.lastIndexOf('/');
    const dir = cut === -1 ? '' : path.slice(0, cut + 1);
    for (const name of SCOPE_DEFAULT_COMPANIONS[path.slice(cut + 1)] ?? []) {
      const companion = `${dir}${name}`;
      if (!have.has(companion)) {
        have.add(companion);
        out.push(companion);
      }
    }
  }
  return out;
}

// =============================================================================
// Test companions — layer L1 of references/adr-scope-derivation.md (Issue #147)
// =============================================================================
//
// The same failure as the lockfile case above, and the same fix. An issue that
// names only the implementation file produces a scope.allow with no test path in
// it, so a worker that writes the test its OWN acceptance criteria demand is
// failed by the scope gate — and the contract's scope is a send-time snapshot,
// so the worker cannot resolve it. Measured three times now (#56 = extraction,
// #44 = lockfiles, #145 = tests), each time as a whole worker run lost to a file
// the issue forgot to write down. The planner therefore allows the CONVENTIONAL
// test paths of every source file the issue declared and reports them in
// `scope_defaults`, exactly as it already does for lockfiles.
//
// Two properties keep this from re-opening the hole #50 closed:
//
//   * Every derived path is a function of a DECLARED path. No bare glob
//     (`**/*.test.*`) is ever added, so an issue that declares nothing derives
//     nothing and the blast radius stays proportional to the declaration
//     (ADR section 2, invariant 1).
//   * An allowance nobody uses costs nothing. Test layout is a repository
//     CONVENTION, so this derivation is a guess by construction — but
//     `scope.allow` is a PERMISSION, not an instruction. Allowing
//     `session.test.ts`, `session.spec.ts` and `__tests__/session.ts` when the
//     repo uses one of the three wastes two patterns that never match anything;
//     allowing none of them wastes a worker's run.
//
// Which shapes an extension gets is decided per ecosystem rather than once for
// all, because FILE_EXT already spans `go|py|java|kt|rb` and a JS-only rule would
// leave exactly those issues with the failure this exists to remove. The
// reasoning per family is on each branch of testCompanionShapes below.

// Mirrors dispatch.mjs MAX_SCOPE_PATTERNS. That runner SORTS scope.allow and
// then `.slice(0, 200)`s it, so an over-long list does not merely lose its
// derived tail — it can drop a DECLARED file in favour of an alphabetically
// earlier derived one, which is the very failure this feature removes. The
// derivation therefore stops at a source-file boundary before the issue's
// de-duplicated total can reach the bound. In practice no fixture comes close
// (the widest shape is 4 paths per source file), but the guard is what makes
// "derived paths never displace declared ones" a property rather than a hope.
const MAX_SCOPE_PATTERNS = 200;

// Directory names that mean "everything below me is already test material".
// Matched as whole path segments, never as substrings: `src/latest/render.ts`
// is not a test file.
const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testdata']);

// File names that are already a test, in the shapes the rules below emit plus
// the ones adjacent to them:
//   `session.test.ts` `session.spec.tsx` `session-test.js`   (JS/TS)
//   `session_test.go` `session_test.py`  `session_spec.rb`   (Go / Python / Ruby)
//   `test_session.py`                                        (Python, pytest)
//   `SessionTest.java` `SessionSpec.kt`  `SessionIT.java`    (JVM)
// Without this, `session.test.ts` in a body would derive `session.test.test.ts`
// — a path that cannot exist, and one more pattern eating the scope budget.
const TEST_FILE_RE = /^test_|[._-](test|spec)\.[A-Za-z0-9]+$|(Test|Tests|Spec|IT)\.(java|kt)$/;

function isTestPath(path) {
  const segments = path.split('/');
  const file = segments.pop();
  if (segments.some((segment) => TEST_DIR_SEGMENTS.has(segment))) return true;
  return TEST_FILE_RE.test(file);
}

// Jest, Vitest and Mocha all resolve a sibling `*.test.*`/`*.spec.*`, and
// `__tests__/` is the layout Jest's default testMatch documents. All three are
// in live use side by side, and the planner cannot open the repository to learn
// which one this repo picked (orchestrate.mjs never does — see the comment above
// the acceptance-gates parser), so all three are allowed.
const JS_TEST_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);

// The conventional test paths of one source file, in a fixed order. An extension
// with no entry here yields NOTHING, which is what keeps a `.md` / `.json` /
// `.yaml` / lockfile / `Makefile` issue from deriving anything at all: the
// non-source exclusion is not a deny-list to maintain, it is the absence of a
// rule. `.rs`, `.sh`, `.c`, `.sql`, `.css`, `.html` are deliberately absent too:
// Rust's unit tests live INSIDE the source file (`#[cfg(test)] mod tests`),
// which is already in scope, and its integration tests are named after an
// intent rather than a module, while shell and the C family have no convention
// a path alone can predict (`*.bats`, `test_*.sh`, `*_test.c`, `check_*.c` are
// all common). Guessing there would spend scope budget on paths no repository
// has. Add an ecosystem when an issue shows the shape it actually needs — the
// same rule SCOPE_DEFAULT_COMPANIONS and FILE_EXT are maintained by.
function testCompanionShapes(dir, base, ext) {
  if (JS_TEST_EXTENSIONS.has(ext)) {
    return [
      `${dir}${base}.test.${ext}`,
      `${dir}${base}.spec.${ext}`,
      `${dir}__tests__/${base}.${ext}`,
      `${dir}__tests__/${base}.test.${ext}`,
    ];
  }
  // Go: `go test` only recognises `_test.go` in the SAME package directory, so
  // there is exactly one shape and no guesswork.
  if (ext === 'go') return [`${dir}${base}_test.go`];
  // Python: pytest's default discovery is `test_*.py`, found either beside the
  // module or under a top-level `tests/`. Both are ubiquitous and neither is
  // derivable from the other, so both are allowed (ADR section 5).
  if (ext === 'py') return [`${dir}test_${base}.py`, `tests/test_${base}.py`];
  // Ruby: RSpec's `_spec.rb`.
  if (ext === 'rb') return [`${dir}${base}_spec.rb`];
  // JVM: NOT in the ADR's table, added here because FILE_EXT accepts `java|kt`
  // and leaving them out would reproduce the JS-only asymmetry the ADR rejects.
  // Maven and Gradle both mirror `src/main/<lang>/…/Foo.java` into
  // `src/test/<lang>/…/FooTest.java`, which is as mechanical as Go's rule, so
  // the mirror is emitted whenever the declared path actually carries a
  // `src/main/` segment. The sibling `FooTest.java` is emitted as well for the
  // single-module and Android-style trees that do not use that layout.
  if (ext === 'java' || ext === 'kt') {
    const shapes = [`${dir}${base}Test.${ext}`];
    const mirrored = dir.replace(/(^|\/)src\/main\//, '$1src/test/');
    if (mirrored !== dir) shapes.push(`${mirrored}${base}Test.${ext}`);
    return shapes;
  }
  return [];
}

// `suspected` is the DECLARED file list and `added` the defaults already chosen
// for this issue (the lockfiles). Both are read, neither is mutated: the caller
// appends the return value to `scope_defaults` and to `suspected_files` in one
// place, so "added to the scope" and "reported in the plan" cannot drift apart
// (ADR section 2, invariant 2).
//
// Deterministic by construction — the declared list is walked in order, each
// file's shapes are emitted in the fixed order above, and nothing is sorted or
// read out of a Set — so the same plan input still produces a byte-identical
// plan and hence a byte-identical contract (dispatch-contract.md section on
// determinism, invariant 3).
function testScopeDefaultsFor(suspected, added) {
  const have = new Set([...suspected, ...added]);
  const out = [];
  for (const path of suspected) {
    if (isTestPath(path)) continue;
    const cut = path.lastIndexOf('/');
    const dir = cut === -1 ? '' : path.slice(0, cut + 1);
    const file = path.slice(cut + 1);
    const dot = file.lastIndexOf('.');
    // `dot <= 0` covers both the extensionless name (`Makefile`) and the dotfile
    // whose leading dot is not an extension separator (`.gitignore`).
    if (dot <= 0) continue;
    const fresh = testCompanionShapes(dir, file.slice(0, dot), file.slice(dot + 1))
      .filter((companion) => !have.has(companion));
    if (fresh.length === 0) continue;
    if (have.size + fresh.length > MAX_SCOPE_PATTERNS) break;
    for (const companion of fresh) {
      have.add(companion);
      out.push(companion);
    }
  }
  return out;
}

// Verification commands the issue text names, recognised by the binaries the
// profile's baseline uses plus a small generic set. Nothing is hardcoded to one
// ecosystem: the recognised binaries are derived from the active profile.
const GENERIC_VERIFY_BINARIES = ['make', 'bash', 'sh', 'pytest', 'go', 'node', 'python3', 'python'];

function verifyBinaries(profile) {
  const set = new Set(GENERIC_VERIFY_BINARIES);
  for (const command of profile.baseline) {
    const head = command.trim().split(/\s+/, 1)[0];
    if (head) set.add(head);
  }
  return set;
}

function extractTestExpectations(text, binaries) {
  const out = [];
  const seen = new Set();
  const codeSpans = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) codeSpans.push(match[1]);
  for (const match of text.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)) {
    for (const line of match[1].split(/\r?\n/)) codeSpans.push(line);
  }
  for (const span of codeSpans) {
    const command = span.trim();
    const head = command.split(/\s+/, 1)[0];
    if (binaries.has(head) && !seen.has(command)) {
      seen.add(command);
      out.push(command);
    }
  }
  return out;
}

// =============================================================================
// Acceptance gates — the machine-readable acceptance block (Issue #114)
// =============================================================================
//
// The notation's 正本 is references/acceptance-gates-notation.md; this parser and
// that document must be changed in the same commit. Everything here is SYNTAX
// only: the planner never opens the target repository, so it cannot know which
// gate ids exist. Resolving them against `.commandmate/verify.yaml` is dispatch's
// job (ADR §3.4).
//
// The one invariant: ONLY an explicitly marked block reaches the contract.
// Nothing is inferred from prose, bullet lists or tables — see the ADR §2.3 and
// `extractTestExpectations` below, whose output is advisory for exactly this
// reason. A gate nobody wrote down is a gate nobody approved.
const ACCEPTANCE_GATES_INFO = 'acceptance-gates';
const ACCEPTANCE_GATES_VERSION = 1;

// The opening fence, counted on its own so "two blocks" is detected even when the
// second one is malformed. `m` makes `^`/`$` line anchors; the info string must be
// the whole word, so ```acceptance-gates-v2 is not this block.
const ACCEPTANCE_GATES_OPEN_RE = /^```acceptance-gates[ \t]*$/gm;
// A complete block. Non-greedy to the first closing fence at a line start.
const ACCEPTANCE_GATES_BLOCK_RE = /^```acceptance-gates[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm;

// Mirrors CommandMate's GATE_ID_PATTERN (lib/verification/verify-config) and
// dispatch.mjs GATE_ID_RE. An id this rejects is one `send --contract` would
// reject, so accepting it here would only move the failure later.
const ACCEPTANCE_GATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Same bound as the contract's verify.gates list (dispatch.mjs MAX_GATE_IDS).
const MAX_ACCEPTANCE_GATE_IDS = 32;

// Removing the block before the prose extractors run is NOT tidiness — it is a
// correctness fix measured on the current regexes (ADR §10 item 3). The fence
// pattern in `extractTestExpectations` is /```[a-zA-Z]*\n([\s\S]*?)```/g, which
// cannot match `acceptance-gates` as an INFO STRING (the hyphen is outside
// [a-zA-Z]) — but it happily matches this block's CLOSING fence as an opening
// one, pairs it with the next block's opening fence, and thereby swallows the
// following ```bash block whole. Measured: a body with one acceptance-gates
// block followed by a bash block dropped 2 of its 3 test_expectations. Stripping
// restores the extraction byte for byte.
//
// The same strip is applied to every prose extractor, not just that one: the
// block is a machine contract, and reading `  - verify-selftest` inside it as an
// acceptance-criteria bullet or a path candidate is the Issue #54 category error
// (position and explicit marking decide intent) pointed the other way.
function stripAcceptanceGateBlocks(text) {
  return String(text).replace(ACCEPTANCE_GATES_BLOCK_RE, '');
}

function countAcceptanceGateBlocks(text) {
  return [...String(text).matchAll(ACCEPTANCE_GATES_OPEN_RE)].length;
}

// The YAML subset the block is written in — the same one `.commandmate/verify.yaml`
// uses: 2-space indent, single-line scalars, comments only at column 0, no
// anchors, no flow collections, no multi-line strings. Deliberately NOT
// best-effort: a block this cannot read becomes an open question, never a guess
// (ADR §2.4). Returns {ok, value} or {ok:false, code, reason}.
function parseAcceptanceGatesBlock(raw) {
  const bad = (code, reason) => ({ ok: false, code, reason });
  const lines = String(raw).split(/\r?\n/);
  const value = { version: ACCEPTANCE_GATES_VERSION, require: [] };
  const seenKeys = new Set();
  let sawVersion = false;
  let section = null; // null | 'require'

  for (const line of lines) {
    if (line.includes('\t')) return bad('acceptance_gate_block_invalid', 'a tab character is not allowed; the block is indented with 2 spaces');
    if (line.trim() === '') continue;
    // 行頭 `#` のみコメント: a `#` anywhere else is part of the value, so a
    // trailing "# note" is a syntax error rather than something silently dropped.
    if (line.startsWith('#')) continue;
    if (line === '---' || line === '...') return bad('acceptance_gate_block_invalid', 'YAML document markers are not part of the subset');

    const indent = line.length - line.trimStart().length;
    const content = line.slice(indent);

    if (indent === 0) {
      section = null;
      const match = /^([a-zA-Z][a-zA-Z0-9_]*):[ \t]*(.*)$/.exec(content);
      if (match === null) return bad('acceptance_gate_block_invalid', `"${content}" is not a "key: value" line at the top level`);
      const [, key, rest] = match;
      if (seenKeys.has(key)) return bad('acceptance_gate_block_invalid', `duplicate key "${key}"`);
      seenKeys.add(key);
      if (!sawVersion && key !== 'version') {
        return bad('acceptance_gate_block_invalid', '"version: 1" must be the first key of the block');
      }
      if (key === 'version') {
        sawVersion = true;
        if (rest !== String(ACCEPTANCE_GATES_VERSION)) {
          // Not rounded forward: an unknown version means the block was written
          // against a notation this runner does not implement, and reading it as
          // v1 would enforce something other than what the author wrote.
          return bad('acceptance_gate_block_invalid', `version must be exactly ${ACCEPTANCE_GATES_VERSION} (got "${rest}")`);
        }
        continue;
      }
      if (key === 'require') {
        if (rest !== '') return bad('acceptance_gate_block_invalid', '"require:" takes a block sequence on the following lines, not an inline value');
        section = 'require';
        continue;
      }
      if (key === 'gates') {
        // Valid notation, not yet enforceable. `gates:` declares NEW commands,
        // which means writing them into the worktree's verify.yaml — ADR §3.5
        // stage 2, whose preconditions are unresolved (measured: an uncommitted
        // .commandmate/verify.yaml DOES count towards work-evidence, so a
        // worktree that only received a gate definition reports uncommitted=1 and
        // exit 21 stops meaning "nothing was done"). Accepting the key and then
        // not enforcing it would be the silent-drop this whole feature exists to
        // prevent, so it stops the run instead.
        return bad('acceptance_gate_block_unsupported', '"gates:" (new command gates) is stage 2 of the ADR and is not enforced by this release; use "require:" with gate ids that already exist in .commandmate/verify.yaml, or keep the condition out of the block and state it for UAT');
      }
      return bad('acceptance_gate_block_invalid', `unknown key "${key}" (the v1 block accepts only version, require, gates)`);
    }

    if (indent !== 2) return bad('acceptance_gate_block_invalid', `unexpected indentation of ${indent} space(s); list items are indented by exactly 2`);
    if (section !== 'require') return bad('acceptance_gate_block_invalid', `"${content}" is indented but no list is open above it`);
    const item = /^-[ \t]+(.*)$/.exec(content);
    if (item === null) return bad('acceptance_gate_block_invalid', `"${content}" is not a "- <gate-id>" list item`);
    const id = item[1];
    if (!ACCEPTANCE_GATE_ID_RE.test(id)) {
      return bad('acceptance_gate_block_invalid', `"${id}" is not a valid gate id (${ACCEPTANCE_GATE_ID_RE.source}); quoting, inline comments and flow syntax are not part of the subset`);
    }
    if (value.require.includes(id)) return bad('acceptance_gate_block_invalid', `duplicate gate id "${id}"`);
    value.require.push(id);
    if (value.require.length > MAX_ACCEPTANCE_GATE_IDS) {
      return bad('acceptance_gate_block_invalid', `at most ${MAX_ACCEPTANCE_GATE_IDS} gate ids may be required`);
    }
  }

  if (!sawVersion) return bad('acceptance_gate_block_invalid', 'the block declares no "version: 1"');
  // An empty block is the same contract error as `verify.gates: []`: it declares
  // a requirement set and then names nothing, which reads as "no requirement"
  // exactly where the author meant to state one.
  if (value.require.length === 0) return bad('acceptance_gate_block_invalid', 'the block requires no gate; remove it, or name at least one gate id under "require:"');
  return { ok: true, value };
}

// The whole block reading for one issue body. Returns
// {gates, error} — `gates` is the plan field (null when there is no block),
// `error` is the open question (null when there is nothing to say). The two are
// never both set: "no block" and "broken block" are different states and the
// second must never be rounded to the first (ADR §2.4).
function readAcceptanceGates(body) {
  const text = String(body ?? '');
  const opens = countAcceptanceGateBlocks(text);
  if (opens === 0) return { gates: null, error: null };
  const invalid = (code, reason) => ({
    gates: null,
    error: {
      code,
      text: `The \`${ACCEPTANCE_GATES_INFO}\` block could not be read: ${reason}. `
        + 'It is NOT treated as absent: fix the block or remove it, then re-plan. '
        + 'The planner never guesses acceptance gates from prose.',
    },
  });
  if (opens > 1) {
    return invalid('acceptance_gate_block_invalid', `the body carries ${opens} blocks and exactly one is allowed (they are not merged, and the first does not win)`);
  }
  const blocks = [...text.matchAll(ACCEPTANCE_GATES_BLOCK_RE)];
  if (blocks.length !== 1) return invalid('acceptance_gate_block_invalid', 'the block is never closed by a ``` fence at the start of a line');
  const parsed = parseAcceptanceGatesBlock(blocks[0][1]);
  if (!parsed.ok) return invalid(parsed.code, parsed.reason);
  return { gates: parsed.value, error: null };
}

// Topic tokens power the inferred-dependency heuristic. Short and stopword-like
// tokens carry no domain signal, so they are dropped.
const STOPWORDS = new Set([
  'feat', 'fix', 'chore', 'add', 'the', 'and', 'for', 'with', 'into', 'from',
  'core', 'skill', 'issue', 'support', 'implement', 'update', 'refactor', 'test',
  'tests', 'plan', 'phase', 'part',
]);

function topicTokens(text) {
  const tokens = new Set();
  for (const match of String(text).toLowerCase().matchAll(/[a-z][a-z0-9]{3,}/g)) {
    const token = match[0];
    if (!STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

const PRODUCER_RE = /(schema|contract|interface|protocol|type\s*def|定義|スキーマ|契約|インターフェース|プロトコル|型定義)/i;
const CONSUMER_RE = /(implement|integrat|consume|connect|wire|apply|利用|連携|接続|適用|参照|使用)/i;

function analyzeIssue(issue, profile, binaries) {
  // The machine-readable block is read from the RAW body, and every prose
  // extractor below reads the body with the block removed. Both halves matter:
  // reading the block from the stripped text would find nothing, and running the
  // prose extractors over the raw text mis-pairs the fences (see
  // stripAcceptanceGateBlocks) and reads gate ids as acceptance-criteria bullets.
  // With no block in the body, `body`/`text` are the raw strings unchanged, so a
  // plan for such an issue is byte-identical to the one this runner produced
  // before acceptance gates existed (ADR §7).
  const acceptanceGates = readAcceptanceGates(issue.body);
  const body = stripAcceptanceGateBlocks(issue.body);
  const text = `${issue.title}\n\n${body}`;
  const objective = redact(firstNonEmptyLine(body) || issue.title);
  const acceptance = extractAcceptanceCriteria(body).map(redact);
  const extraction = extractFileCandidates(text);
  const { suspected, references } = classifyFileCandidates(
    extraction.paths,
    extraction.deliverable,
    extraction.contextOnly,
  );
  // Both default sources feed ONE list, which is then appended to
  // suspected_files and reported as `scope_defaults` — the plan can never grant
  // a path it does not also declare it granted. Test companions are derived from
  // the DECLARED files only (`suspected` before the push below): the lockfiles
  // just chosen are themselves derived, and deriving from derived paths is what
  // invariant 1 forbids.
  const scopeDefaults = scopeDefaultsFor(suspected);
  scopeDefaults.push(...testScopeDefaultsFor(suspected, scopeDefaults));
  suspected.push(...scopeDefaults);
  const tests = extractTestExpectations(text, binaries).map(redact);

  // Open questions are built with their warning code attached, so the question a
  // reviewer reads and the warning that drops the run to `partial` can never
  // disagree about what is missing (Issue #52). `questions` stays a string list —
  // that is the plan schema — and the codes stay private to the planner.
  const openQuestions = [];
  // Raised FIRST: a body whose acceptance block is broken is a body whose author
  // did write acceptance conditions, so this question is the one to read before
  // `no_acceptance_criteria`.
  if (acceptanceGates.error !== null) openQuestions.push(acceptanceGates.error);
  if (acceptance.length === 0) {
    openQuestions.push({
      code: 'no_acceptance_criteria',
      text: 'Acceptance criteria are unclear; add 1-3 concrete completion checks.',
    });
  }
  if (suspected.length === 0) {
    openQuestions.push({
      code: 'no_suspected_files',
      text: 'Affected files are unclear; add likely modules or paths.',
    });
  }
  const questions = openQuestions.map((question) => question.text);

  const slug = slugify(issue.title);
  const repoName = profile.repository.split('/').pop() || 'repo';
  const branch = profile.branch_template
    .replaceAll('{number}', String(issue.number))
    .replaceAll('{slug}', slug)
    .replaceAll('{repo}', repoName);
  const worktree = profile.worktree_template
    .replaceAll('{number}', String(issue.number))
    .replaceAll('{slug}', slug)
    .replaceAll('{repo}', repoName);

  return {
    number: issue.number,
    title: redact(issue.title),
    objective,
    acceptance_criteria: acceptance,
    // Null when the issue declares no block AND when it declares a broken one:
    // the difference is carried by the open question above, never by pretending
    // a requirement was read. `require` is transcribed in the author's order —
    // the contract is a COPY of what the issue wrote, not a re-encoding of it.
    acceptance_gates: acceptanceGates.gates,
    suspected_files: suspected,
    scope_defaults: scopeDefaults,
    reference_files: references,
    test_expectations: tests,
    labels: issue.labels,
    branch,
    worktree,
    // worktree_id is resolved at DISPATCH time from `commandmate ls --json` by
    // branch — `ls` is the source of truth for the id, and the planner is a dry
    // run that creates nothing, so it reports the id as missing rather than
    // guessing a slug. `commandmate sync` (CommandMate 0.21.0+) re-scans the
    // server's worktree registry but creates no worktree; the dispatch runner
    // calls it when `ls` resolves nothing, which is what registers a worktree
    // made after the server last scanned.
    worktree_id: null,
    questions,
    _openQuestions: openQuestions,
    // Producer/consumer signals feed the inferred-dependency rule below.
    _producer: PRODUCER_RE.test(text),
    _consumer: CONSUMER_RE.test(text),
    _topics: topicTokens(`${issue.title} ${body}`),
    _rawBody: body,
    // `found` rather than `paths`: a candidate dropped as a partial was still
    // recognised, so it must not be re-reported as an unknown extension.
    _unrecognizedPaths: extractUnrecognizedPaths(text, extraction.found),
    _shadowedPaths: extraction.shadowed,
  };
}

// =============================================================================
// Dependencies
// =============================================================================

const EXPLICIT_HEADING_RE = /(depend|dependenc|prerequisite|requires|依存|前提)/i;
// Forward: the issue that WRITES the line comes after the issue it references.
const EXPLICIT_FORWARD_RE = /(depends?\s+on|blocked\s+by|requires?|needs?|prerequisite|依存|前提)/i;
// Reverse: the issue that WRITES the line comes BEFORE the one it references.
// `\bblocks\b` / `\bblocking\b` deliberately do not match "blocked by", which is
// forward — the word boundary is what keeps the two readings apart.
const EXPLICIT_REVERSE_RE = /(\bblocks\b|\bblocking\b|ブロックする)/i;

const MAX_REASON_LINE = 100;

// The body line an edge was read from, redacted and bounded, so a reviewer can
// re-derive the edge from `dependency-plan.md` without opening the issue.
function quoteBodyLine(line) {
  const text = redact(line);
  return `"${text.length > MAX_REASON_LINE ? `${text.slice(0, MAX_REASON_LINE - 1)}…` : text}"`;
}

// A dependency reference carries a DIRECTION, and the direction is a property of
// the line, not of the section the line sits in. "## 依存" says the section is
// about dependencies; it does not say which way "- blocks #29" points. Reading a
// whole section as "everything here is a prerequisite" silently inverted every
// reverse statement (Issue #51), so the section now only supplies the DEFAULT for
// a line that names no direction of its own.
//
// Returns an ordered list of {ref, direction, cue, ambiguous, line}; `direction`
// is 'depends_on' (this issue is after `ref`) or 'blocks' (this issue is before
// it). Deduplication is per (ref, direction): a body that states both directions
// about the same issue contradicts itself, and the contradiction must surface as
// a cycle rather than be resolved by whichever line came first.
function extractExplicitRefs(body) {
  const refs = [];
  const seen = new Set();
  let inSection = false;
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim();
    if (HEADING_RE.test(stripped)) {
      inSection = EXPLICIT_HEADING_RE.test(stripped);
      continue;
    }
    const forward = EXPLICIT_FORWARD_RE.exec(stripped);
    const reverse = EXPLICIT_REVERSE_RE.exec(stripped);
    if (!forward && !reverse && !inSection) continue;
    // Both readings on one line is a statement this planner cannot resolve. It
    // keeps the forward (section-default) reading and says so in a warning,
    // rather than picking one of the two in silence.
    const ambiguous = Boolean(forward && reverse);
    const direction = reverse && !forward ? 'blocks' : 'depends_on';
    const cue = ambiguous ? null : (reverse ?? forward)?.[0] ?? null;
    for (const match of stripped.matchAll(/#(\d+)/g)) {
      const ref = Number.parseInt(match[1], 10);
      const key = `${ref}:${direction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ ref, direction, cue, ambiguous, line: stripped });
    }
  }
  return refs;
}

// How the direction was decided — the evidence half of an explicit edge's reason.
function directionEvidence(ref) {
  if (ref.ambiguous) {
    return `both a forward and a reverse direction word in ${quoteBodyLine(ref.line)}, read as forward`;
  }
  if (ref.cue) return `direction word "${ref.cue}" in ${quoteBodyLine(ref.line)}`;
  return `no direction word in ${quoteBodyLine(ref.line)}, dependency-section default`;
}

function explicitReason(issueNumber, ref) {
  const evidence = directionEvidence(ref);
  if (ref.direction === 'blocks') {
    return `#${ref.ref} depends on #${issueNumber}: #${issueNumber} states it blocks #${ref.ref} (${evidence})`;
  }
  return `#${issueNumber} states a dependency on #${ref.ref} (${evidence})`;
}

function hasFileOverlap(a, b) {
  const left = new Set(a.suspected_files);
  return b.suspected_files.some((path) => left.has(path));
}

// Builds the dependency edge set from three sources, in precedence order:
// override > explicit > inferred. Returns edges plus any validation errors and
// warnings. Each edge is {issue, depends_on, kind, reason}: `issue` depends on
// `depends_on`.
function buildDependencies(analyses, inputs) {
  const inSet = new Set(analyses.map((a) => a.number));
  const errors = [];
  const warnings = [];

  // consumer -> Map(dependency -> edge), so a stronger source overrides a weaker.
  const edges = new Map();
  const put = (issue, dependsOn, kind, reason, precedence) => {
    if (!edges.has(issue)) edges.set(issue, new Map());
    const existing = edges.get(issue).get(dependsOn);
    if (!existing || precedence > existing._precedence) {
      edges.get(issue).set(dependsOn, { issue, depends_on: dependsOn, kind, reason, _precedence: precedence });
    }
  };

  // 1. Explicit — parsed from issue bodies. A reference outside the input set is
  //    a warning, not a failure: the prerequisite may already be merged. Both
  //    directions are honored (Issue #51): "blocks #N" places THIS issue first.
  for (const analysis of analyses) {
    for (const ref of extractExplicitRefs(analysis._rawBody)) {
      if (ref.ref === analysis.number) continue;
      if (ref.ambiguous) {
        warnings.push({
          code: 'ambiguous_dependency_direction',
          detail: redact(
            `#${analysis.number} states both a forward and a reverse direction about #${ref.ref} on one line ` +
              `(${quoteBodyLine(ref.line)}); the planner read it as "#${analysis.number} depends on #${ref.ref}". ` +
              'Split the line so one direction word governs each reference, or state the edge with --depends.',
          ),
        });
      }
      // 'blocks' means the referenced issue is the consumer: it depends on this one.
      const [issue, dependsOn] = ref.direction === 'blocks'
        ? [ref.ref, analysis.number]
        : [analysis.number, ref.ref];
      if (inSet.has(ref.ref)) {
        put(issue, dependsOn, 'explicit', redact(explicitReason(analysis.number, ref)), 2);
      } else {
        warnings.push({
          code: 'external_dependency',
          detail: ref.direction === 'blocks'
            ? `#${analysis.number} blocks #${ref.ref}, which is not in this plan (#${ref.ref} would depend on #${analysis.number})`
            : `#${analysis.number} depends on #${ref.ref}, which is not in this plan`,
        });
      }
    }
  }

  // 2. Inferred — a consumer of a shared contract depends on its producer. A
  //    shared topic token grounds the link; file overlap is a conflict, not a
  //    dependency, and is handled by wave packing.
  if (inputs.infer) {
    for (const consumer of analyses) {
      if (!consumer._consumer) continue;
      for (const producer of analyses) {
        if (producer.number === consumer.number || !producer._producer) continue;
        const shared = [...consumer._topics].filter((t) => producer._topics.has(t));
        if (shared.length === 0) continue;
        put(
          consumer.number,
          producer.number,
          'inferred',
          `#${consumer.number} consumes the contract from #${producer.number} (shared: ${shared.slice(0, 3).join(', ')})`,
          1,
        );
      }
    }
  }

  // 3. Override — authoritative. Malformed or dangling overrides are rejected.
  for (const raw of inputs.dependsRaw) {
    const match = /^#?(\d+)\s*[:>]\s*#?(\d+)$/.exec(String(raw).trim());
    if (!match) {
      errors.push({ code: 'override_incomplete', detail: `dependency override "${raw}" is malformed; use <issue>:<dependency>` });
      continue;
    }
    const issue = Number.parseInt(match[1], 10);
    const dependsOn = Number.parseInt(match[2], 10);
    if (!inSet.has(issue) || !inSet.has(dependsOn)) {
      errors.push({
        code: 'override_incomplete',
        detail: `dependency override "${raw}" references an issue not in this plan`,
      });
      continue;
    }
    if (issue === dependsOn) {
      errors.push({ code: 'override_incomplete', detail: `dependency override "${raw}" makes an issue depend on itself` });
      continue;
    }
    put(issue, dependsOn, 'override', `override: #${issue} depends on #${dependsOn}`, 3);
  }

  // Flatten to a sorted, deterministic list.
  const list = [];
  for (const perIssue of edges.values()) {
    for (const edge of perIssue.values()) {
      list.push({ issue: edge.issue, depends_on: edge.depends_on, kind: edge.kind, reason: edge.reason });
    }
  }
  list.sort((a, b) => a.issue - b.issue || a.depends_on - b.depends_on);

  // Cycle detection over the resolved graph.
  const cycle = findCycle(analyses, list);
  if (cycle) {
    errors.push({
      code: 'cycle_detected',
      detail: `dependency cycle: ${cycle.map((n) => `#${n}`).join(' -> ')}`,
    });
  }

  // A caller-asserted order must be a permutation of the set that respects the
  // DAG; otherwise the plan it implies cannot be honored.
  if (inputs.order && !cycle) {
    validateOrder(inputs.order, analyses, list, errors);
  }

  return { edges: list, errors, warnings };
}

function adjacency(analyses, edges) {
  // deps.get(x) = issues x depends on.
  const deps = new Map(analyses.map((a) => [a.number, new Set()]));
  for (const edge of edges) {
    if (deps.has(edge.issue)) deps.get(edge.issue).add(edge.depends_on);
  }
  return deps;
}

function findCycle(analyses, edges) {
  const deps = adjacency(analyses, edges);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(analyses.map((a) => [a.number, WHITE]));
  const stack = [];

  const visit = (node) => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of [...deps.get(node)].sort((a, b) => a - b)) {
      if (color.get(next) === GRAY) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (color.get(next) === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const node of analyses.map((a) => a.number)) {
    if (color.get(node) === WHITE) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

function validateOrder(order, analyses, edges, errors) {
  const inSet = new Set(analyses.map((a) => a.number));
  const orderSet = new Set(order);
  if (order.length !== inSet.size || [...inSet].some((n) => !orderSet.has(n))) {
    errors.push({
      code: 'dependency_order_violation',
      detail: '--order must be a permutation of the planned issues',
    });
    return;
  }
  const position = new Map(order.map((n, index) => [n, index]));
  for (const edge of edges) {
    if (position.get(edge.depends_on) > position.get(edge.issue)) {
      errors.push({
        code: 'dependency_order_violation',
        detail: `--order places #${edge.issue} before its dependency #${edge.depends_on}`,
      });
      return;
    }
  }
}

// =============================================================================
// Wave planning
// =============================================================================

// Packs issues into waves: dependencies satisfied by an earlier wave, no two
// file-overlapping issues in one wave, and each wave bounded by max_parallel.
function planWaves(analyses, edges, maxParallel, order) {
  const deps = adjacency(analyses, edges);
  const byNumber = new Map(analyses.map((a) => [a.number, a]));

  // Deterministic candidate order: caller-asserted order if given, else input.
  const sequence = order
    ? order.slice()
    : analyses.map((a) => a.number);

  const completed = new Set();
  let remaining = sequence.slice();
  const waves = [];

  while (remaining.length > 0) {
    let ready = remaining.filter((n) => [...deps.get(n)].every((d) => completed.has(d)));
    // A stalled graph (only possible if a cycle slipped through) still makes
    // progress one issue at a time rather than looping forever.
    if (ready.length === 0) ready = [remaining[0]];

    const wave = [];
    for (const number of ready) {
      if (wave.length >= maxParallel) break;
      const candidate = byNumber.get(number);
      if (wave.some((n) => hasFileOverlap(candidate, byNumber.get(n)))) continue;
      wave.push(number);
    }
    if (wave.length === 0) wave.push(ready[0]);

    waves.push(wave);
    for (const number of wave) completed.add(number);
    const used = new Set(wave);
    remaining = remaining.filter((n) => !used.has(n));
  }
  return waves;
}

// =============================================================================
// Risk / commands
// =============================================================================

const SEVERITY_ORDER = { low: 0, moderate: 1, high: 2 };

function assessRisk(analyses, edges, profile) {
  const factors = [];
  if (!profile.verified) {
    factors.push({ code: 'unverified_profile', severity: 'high', detail: `profile "${profile.id}" is not verified` });
  }
  const conflicts = countConflicts(analyses);
  if (conflicts > 0) {
    factors.push({ code: 'file_conflict', severity: 'moderate', detail: `${conflicts} issue pair(s) touch shared files` });
  }
  if (edges.length > 0) {
    factors.push({ code: 'cross_issue_dependency', severity: 'moderate', detail: `${edges.length} dependency edge(s) constrain ordering` });
  }
  const open = analyses.reduce((sum, a) => sum + a.questions.length, 0);
  if (open > 0) {
    factors.push({ code: 'open_questions', severity: 'moderate', detail: `${open} blocking question(s) across issues` });
  }
  if (analyses.length > MAX_PARALLEL_MAX) {
    factors.push({ code: 'batch_size', severity: 'low', detail: `${analyses.length} issues exceed a single wave` });
  }
  let level = 'low';
  for (const factor of factors) {
    if (SEVERITY_ORDER[factor.severity] > SEVERITY_ORDER[level]) level = factor.severity;
  }
  return { level, factors };
}

function countConflicts(analyses) {
  let count = 0;
  for (let i = 0; i < analyses.length; i += 1) {
    for (let j = i + 1; j < analyses.length; j += 1) {
      if (hasFileOverlap(analyses[i], analyses[j])) count += 1;
    }
  }
  return count;
}

// The commands the plan is grounded in and the verification a worker would run.
// Every entry is executed:false — this is a dry run. Mutating phases (worktree
// creation, dispatch, PR, merge) are deferred to #1454-1456 and are not emitted.
function planCommands(analyses, profile) {
  const commands = [];
  for (const analysis of analyses) {
    commands.push({
      phase: 'analyze',
      command: `gh issue view ${analysis.number} --repo ${profile.repository} --json number,title,body,labels`,
      mutating: false,
      executed: false,
    });
  }
  commands.push({ phase: 'analyze', command: `git rev-parse ${profile.base}`, mutating: false, executed: false });
  for (const command of profile.baseline) {
    commands.push({ phase: 'verify', command, mutating: false, executed: false });
  }
  return commands;
}

// =============================================================================
// Plan / result assembly
// =============================================================================

function canonicalInputSignature(inputs, profile, issues) {
  // Everything that determines the plan, and nothing that does not (not the
  // runs directory, not the wall clock). Same signature => same plan. Issue
  // content is included (#46 / CommandMate #1678 B-4): fixing an issue body and
  // re-planning is the normal answer to a blocking question, and it must derive
  // a NEW run id — while a byte-identical re-run still derives the same id and
  // is still refused, so the no-overwrite intent stands. Labels are sorted:
  // their order carries no meaning and must not shift the id.
  return JSON.stringify({
    issues: inputs.issues,
    issue_content: issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: [...issue.labels].sort(),
    })),
    base: profile.base,
    profile: profile.id,
    repository: profile.repository,
    max_parallel: inputs.maxParallel,
    phase: inputs.phase,
    infer: inputs.infer,
    depends: [...inputs.dependsRaw].sort(),
    order: inputs.order,
  });
}

function makeRunId(inputs, profile, issues) {
  if (inputs.runIdOverride) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(inputs.runIdOverride)) {
      throw new SkillError('invalid_input', 'run-id must be a short filesystem-safe token', 3);
    }
    return inputs.runIdOverride;
  }
  const digest = createHash('sha256').update(canonicalInputSignature(inputs, profile, issues)).digest('hex');
  return `plan-${digest.slice(0, 12)}`;
}

function publicProfile(profile) {
  return {
    id: profile.id,
    repository: profile.repository,
    base: profile.base,
    branch_template: profile.branch_template,
    worktree_template: profile.worktree_template,
    baseline: profile.baseline,
    verified: profile.verified,
  };
}

function issueForPlan(analysis, analyses, edges) {
  return {
    number: analysis.number,
    title: analysis.title,
    objective: analysis.objective,
    acceptance_criteria: analysis.acceptance_criteria,
    acceptance_gates: analysis.acceptance_gates,
    suspected_files: analysis.suspected_files,
    scope_defaults: analysis.scope_defaults,
    reference_files: analysis.reference_files,
    test_expectations: analysis.test_expectations,
    labels: analysis.labels,
    branch: analysis.branch,
    worktree: analysis.worktree,
    worktree_id: analysis.worktree_id,
    questions: analysis.questions,
    classification: classifyIssue(analysis, analyses, edges),
  };
}

function classifyIssue(analysis, analyses, edges) {
  if (edges.some((e) => e.issue === analysis.number)) return 'dependent';
  if (analyses.some((o) => o.number !== analysis.number && hasFileOverlap(analysis, o))) return 'conflicting';
  return 'independent';
}

function buildPlan({ runId, profile, inputs, analyses, edges, waves }) {
  const risk = assessRisk(analyses, edges, profile);
  const commands = planCommands(analyses, profile);
  return {
    plan_schema_version: PLAN_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    run_id: runId,
    generated_mode: 'dry-run',
    profile: publicProfile(profile),
    inputs: {
      issues: inputs.issues,
      base: profile.base,
      profile_id: profile.id,
      max_parallel: inputs.maxParallel,
      phase: inputs.phase,
      infer: inputs.infer,
      dependency_overrides: inputs.dependsRaw.map(String),
      order: inputs.order,
    },
    issues: analyses.map((a) => issueForPlan(a, analyses, edges)),
    dependencies: edges,
    waves,
    merge_order: waves.flat(),
    max_parallel: inputs.maxParallel,
    risk,
    permissions: DECLARED_PERMISSIONS,
    commands,
    warnings: [],
    notes: [
      'Dry run: no worktree was created, no worker dispatched, no PR opened or merged.',
      'This plan is executed by the dispatch runner (scripts/dispatch.mjs) once approved; PR, merge and UAT are deferred to CommandMate issues #1455-1456.',
      'worktree_id is null in the plan: the dispatch runner resolves it from `commandmate ls --json` by branch. A worktree created after the CommandMate server last scanned is not registered yet, so it has no id — register it with `commandmate sync` (CommandMate 0.21.0+, a re-scan that creates no worktree; the dispatch runner also attempts it once).',
      'Issue input is number, title, body and labels only: comments are never read, so a decision recorded only in an issue comment is invisible to this plan and to the execution contract — fold it into the issue body and re-plan.',
    ],
  };
}

function completionChecks(plan, dependencyErrors, ranOverwriteGuard) {
  const conflictFree = plan.waves.every((wave) => {
    const inWave = wave.map((n) => plan.issues.find((i) => i.number === n));
    for (let i = 0; i < inWave.length; i += 1) {
      for (let j = i + 1; j < inWave.length; j += 1) {
        const left = new Set(inWave[i].suspected_files);
        if (inWave[j].suspected_files.some((p) => left.has(p))) return false;
      }
    }
    return true;
  });

  const checks = [
    { id: 'dry_run_only', passed: plan.generated_mode === 'dry-run', detail: 'no mutating phase was executed' },
    { id: 'dependencies_validated', passed: dependencyErrors.length === 0, detail: dependencyErrors.length === 0 ? 'no cycle, incomplete override, or order violation' : dependencyErrors.map((e) => e.code).join(', ') },
    { id: 'waves_conflict_free', passed: conflictFree, detail: conflictFree ? 'no shared-file pair shares a wave' : 'a wave contains a file-overlapping pair' },
    { id: 'run_isolated', passed: ranOverwriteGuard, detail: ranOverwriteGuard ? 'run directory is unique and was not overwritten' : 'run directory already existed' },
    { id: 'deterministic', passed: true, detail: 'plan is a pure function of its inputs' },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

function buildResult({ status, runId, runDir, artifacts, plan, errors, warnings, completionCheck, summary }) {
  return {
    result_schema_version: RESULT_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    status,
    run_id: runId,
    run_dir: runDir,
    artifacts,
    plan,
    errors,
    warnings,
    completion_check: completionCheck,
    summary_markdown: summary,
  };
}

// =============================================================================
// Markdown artifacts
// =============================================================================

function listItems(items) {
  return items.length === 0 ? ['- none'] : items.map((item) => `- ${item}`);
}

function renderManifest(plan) {
  const lines = [
    '# cmate-orchestrate dry-run manifest',
    '',
    `- Run id: \`${plan.run_id}\``,
    `- Profile: \`${plan.profile.id}\`${plan.profile.verified ? '' : ' (unverified)'}`,
    `- Repository: \`${plan.profile.repository}\``,
    `- Base: \`${plan.profile.base}\``,
    `- Mode: ${plan.generated_mode}`,
    `- Issues: ${plan.inputs.issues.map((n) => `#${n}`).join(', ')}`,
    `- Max parallel: ${plan.max_parallel}`,
    `- Merge order: ${plan.merge_order.map((n) => `#${n}`).join(', ')}`,
    `- Risk: ${plan.risk.level}`,
    '',
    '## Waves',
    '',
  ];
  plan.waves.forEach((wave, index) => {
    lines.push(`- Wave ${index + 1}: ${wave.map((n) => `#${n}`).join(', ')}`);
  });
  lines.push('', '## Planned worktrees', '');
  for (const issue of plan.issues) {
    lines.push(`- #${issue.number}: \`${issue.branch}\` at \`${issue.worktree}\``);
  }
  lines.push('', '## Safety', '', ...plan.notes.map((n) => `- ${n}`), '');
  return lines.join('\n');
}

function renderIssueAnalysis(plan) {
  const lines = ['# Issue analysis', ''];
  for (const issue of plan.issues) {
    lines.push(
      `## #${issue.number} ${issue.title}`,
      '',
      `- Objective: ${issue.objective}`,
      `- Classification: ${issue.classification}`,
      `- Branch: \`${issue.branch}\``,
      `- Worktree: \`${issue.worktree}\``,
      `- Labels: ${issue.labels.length ? issue.labels.join(', ') : 'none'}`,
      '',
      'Acceptance criteria:',
      ...listItems(issue.acceptance_criteria),
      '',
      'Suspected files:',
      ...listItems(issue.suspected_files),
      '',
      'Scope defaults (planner-added lockfiles, included above):',
      ...listItems(issue.scope_defaults),
      '',
      // The paths the planner read and deliberately kept OUT of scope.allow. It
      // is the only place a reviewer can see that decision before dispatch; a
      // path missing from "Suspected files" is otherwise indistinguishable from
      // one the planner never noticed (Issue #54).
      'Reference files (read, not in scope.allow):',
      ...listItems(issue.reference_files),
      '',
      'Test expectations:',
      ...listItems(issue.test_expectations),
      '',
      'Open questions:',
      ...listItems(issue.questions),
      '',
    );
  }
  return lines.join('\n');
}

function renderDependencyPlan(plan) {
  const lines = ['# Dependency plan', '', '## Edges', ''];
  if (plan.dependencies.length === 0) {
    lines.push('- none');
  } else {
    for (const edge of plan.dependencies) {
      lines.push(`- #${edge.issue} depends on #${edge.depends_on} (${edge.kind}): ${edge.reason}`);
    }
  }
  lines.push('', '## Waves', '');
  plan.waves.forEach((wave, index) => {
    lines.push(`- Wave ${index + 1}: ${wave.map((n) => `#${n}`).join(', ')}`);
  });
  lines.push('', '## Merge order', '');
  plan.merge_order.forEach((number, index) => {
    lines.push(`${index + 1}. #${number}`);
  });
  if (plan.warnings.length) {
    lines.push('', '## Warnings', '', ...plan.warnings.map((w) => `- ${w.code}: ${w.detail}`));
  }
  lines.push('');
  return lines.join('\n');
}

function renderSummary(plan) {
  const conflicts = plan.issues.filter((i) => i.classification === 'conflicting').length;
  return [
    '## 目的',
    `${plan.inputs.issues.map((n) => `#${n}`).join(', ')} を ${plan.profile.repository} に対して並列実行するための dry-run plan。`,
    '',
    '## 結論',
    `${plan.waves.length} wave / merge order ${plan.merge_order.map((n) => `#${n}`).join(' → ')}。risk=${plan.risk.level}。mutation なし。`,
    '',
    '## Wave',
    ...plan.waves.map((wave, index) => `- Wave ${index + 1}: ${wave.map((n) => `#${n}`).join(', ')}`),
    '',
    '## 依存とconflict',
    `- 依存 edge: ${plan.dependencies.length} 件`,
    `- file conflict のある issue: ${conflicts} 件（同一 wave に置かない）`,
    '',
    '## risk と権限',
    `- risk: ${plan.risk.level}（${plan.risk.factors.map((f) => f.code).join(', ') || 'none'}）`,
    `- 要求権限: ${plan.permissions.join(', ')}`,
    '',
    '## 次の一手',
    '- この plan を確認し、後続 phase（#1454-1456）で dispatch/PR/merge を実行する。',
  ].join('\n');
}

// =============================================================================
// Entry point
// =============================================================================

function planFailure(error, runId) {
  const status = 'failure';
  const errors = [{ code: error.code, detail: redact(error.detail ?? error.message) }];
  const completionCheck = {
    passed: false,
    checks: [
      { id: 'dry_run_only', passed: true, detail: 'no mutating phase was executed' },
      { id: 'dependencies_validated', passed: error.code !== 'cycle_detected' && error.code !== 'override_incomplete' && error.code !== 'dependency_order_violation', detail: error.code },
      { id: 'waves_conflict_free', passed: false, detail: 'no plan was produced' },
      { id: 'run_isolated', passed: true, detail: 'no run directory was written' },
      { id: 'deterministic', passed: true, detail: 'failure is a pure function of inputs' },
    ],
  };
  return buildResult({
    status,
    runId: runId ?? null,
    runDir: null,
    artifacts: [],
    plan: null,
    errors,
    warnings: [],
    completionCheck,
    summary: `## 結論\n失敗（${error.code}）。${redact(error.detail ?? error.message)}`,
  });
}

function run(argv) {
  const parsed = parseCli(argv);
  if (parsed.values.help) {
    process.stderr.write(`${USAGE}\n`);
    return { exitCode: 0, stdout: null };
  }

  const inputs = resolveInputs(parsed);
  const { profile, warnings: profileWarnings } = resolveProfile(inputs);

  // Issues are loaded before the run id exists: their content is part of the id.
  const rawIssues = loadIssues(inputs, profile);
  const runId = makeRunId(inputs, profile, rawIssues);
  const binaries = verifyBinaries(profile);
  const analyses = rawIssues.map((issue) => analyzeIssue(issue, profile, binaries));

  const { edges, errors: depErrors, warnings: dependencyWarnings } = buildDependencies(analyses, inputs);
  // Profile warnings first: a plan built against the wrong repository is the
  // premise a reviewer has to settle before reading anything downstream of it.
  // Then per-issue extraction warnings, the unanswered questions those issues
  // still carry, then cross-issue dependency warnings.
  const warnings = [
    ...profileWarnings,
    ...extractionWarnings(analyses),
    ...openQuestionWarnings(analyses),
    ...dependencyWarnings,
  ];
  if (depErrors.length > 0) {
    const first = depErrors[0];
    throw new SkillError(first.code, first.detail, 5);
  }

  const waves = planWaves(analyses, edges, inputs.maxParallel, inputs.order);
  const plan = buildPlan({ runId, profile, inputs, analyses, edges, waves });
  plan.warnings = warnings;

  const runDir = join(inputs.runsDir, runId);
  if (existsSync(runDir)) {
    throw new SkillError(
      'run_exists',
      `run directory ${runDir} already exists; refusing to overwrite. ` +
        'The default run id hashes the planner inputs INCLUDING each issue title/body/labels, so this means ' +
        'nothing changed since that run (an edited issue body derives a new id by itself). ' +
        'To re-plan anyway: pass --run-id <new-id> (e.g. --run-id plan-retry-1) or --runs-dir <dir> to write elsewhere.',
      4,
    );
  }
  mkdirSync(runDir, { recursive: true });

  const artifacts = [
    { path: 'plan.json', kind: 'plan' },
    { path: 'result.json', kind: 'result' },
    { path: 'manifest.md', kind: 'report' },
    { path: 'issue-analysis.md', kind: 'report' },
    { path: 'dependency-plan.md', kind: 'report' },
  ];

  const completionCheck = completionChecks(plan, depErrors, true);
  const status = warnings.length > 0 ? 'partial' : 'success';
  const result = buildResult({
    status,
    runId,
    runDir,
    artifacts,
    plan,
    errors: [],
    warnings,
    completionCheck,
    summary: renderSummary(plan),
  });

  writeFileSync(join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  writeFileSync(join(runDir, 'manifest.md'), renderManifest(plan), 'utf8');
  writeFileSync(join(runDir, 'issue-analysis.md'), renderIssueAnalysis(plan), 'utf8');
  writeFileSync(join(runDir, 'dependency-plan.md'), renderDependencyPlan(plan), 'utf8');

  process.stderr.write(`wrote dry-run artifacts to ${runDir}\n`);
  return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n` };
}

function main() {
  const argv = process.argv.slice(2);
  try {
    const { exitCode, stdout } = run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      const result = planFailure(error);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.stderr.write(`error [${error.code}]: ${redact(error.detail ?? error.message)}\n`);
      process.exit(error.exitCode ?? 1);
    }
    // An unexpected error is a bug in the planner, not a plan outcome.
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

main();
