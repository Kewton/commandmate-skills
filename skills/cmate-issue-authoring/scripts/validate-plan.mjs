// cmate-issue-authoring — split-plan validator (Node stdlib only, Node >= 18).
//
//   node scripts/validate-plan.mjs <plan.json> [--schema <path>] [--json]
//   node scripts/validate-plan.mjs <plan.json> --checkout <path>
//   node scripts/validate-plan.mjs <plan.json> --derive-id
//   node scripts/validate-plan.mjs <plan.json> --render-open-questions <issue-key>
//   node scripts/validate-plan.mjs --render-acceptance-gates <id,id> --checkout <path>
//
// Two layers, because one of them is not enough:
//
//  1. Conformance to `schemas/issue-split-plan.v1.json`. The schema file is read
//     and interpreted, not re-implemented here, so a schema edit cannot silently
//     stop being enforced.
//  2. The rules a JSON Schema cannot state: keys are unique, dependencies form a
//     DAG, a dry-run plan records no mutating command, a suspected duplicate is
//     blocked by an open question, an `acceptance-gates` block names only gate
//     ids that exist in a `.commandmate/verify.yaml` this run actually read, every
//     body states the open questions the plan says block it, and — the one that
//     decides whether this Skill did its job — every rendered body survives the
//     cmate-orchestrate planner with no blocking question the plan did not
//     already declare.
//
// Exit status: 0 the plan is valid, 1 the plan is invalid, 2 the run itself
// failed (bad usage, unreadable file). A validator that cannot distinguish "your
// plan is wrong" from "I could not look" is a validator whose green means nothing.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA = resolve(HERE, '..', 'schemas', 'issue-split-plan.v1.json');

const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_ERROR = 2;

const USAGE = `cmate-issue-authoring split-plan validator

  node scripts/validate-plan.mjs <plan.json> [options]
  node scripts/validate-plan.mjs --render-acceptance-gates <id,id> --checkout <path>

  --schema <path>     Schema to validate against (default: the bundled v1 schema).
  --checkout <path>   Root of the target repository's checkout. Required before a
                      body may declare an \`acceptance-gates\` block: the gate ids
                      are resolved against <path>/.commandmate/verify.yaml, which
                      is the file dispatch resolves them against.
  --render-acceptance-gates <id,id>
                      Print the canonical block for those gate ids and exit. Needs
                      --checkout, and every id must exist there.
  --render-open-questions <issue-key>
                      Print the canonical \`open-questions\` block for that issue —
                      the plan's own open_questions[] whose \`blocks\` names the key,
                      in array order — then exit. Prints nothing when none does.
  --derive-id         Print the plan_id the plan's own inputs imply, then exit.
  --json              Emit findings as JSON instead of one line each.
  --help              Show this help.

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
// Open questions mirror
// =============================================================================
//
// The second machine-readable block an Issue body carries. The notation's 正本 is
// `skills/cmate-orchestrate/references/open-questions-notation.md`; this package
// is a MIRROR of it and never extends it
// ([open-questions.md](../references/open-questions.md)).
//
// It went in reader-first: the planner has parsed the block since 0.28.0 and
// nothing wrote one, so an author who left something undecided had to transcribe
// it by hand — and a transcription that is skipped is an undecided thing that
// reaches a worker as a free choice, which is Issue #178 pointed at the authoring
// path instead of the refinement one.
//
// One reader is mirrored here, verbatim, comments included: the planner's block
// reader, so a body can be told before the Issue exists whether the block it
// carries will be read or will stop the run. The two halves of that reader are
// both load-bearing here:
//
//  1. `plannerReadOpenQuestions` decides whether the block PARSES, which is what
//     lets this package refuse to write one the planner would refuse to read;
//  2. `plannerStripOpenQuestionBlocks` is applied to the body before every prose
//     extractor below, exactly as `analyzeIssue` applies it. Without the strip
//     this mirror would read a `  - …` question as an acceptance criterion and a
//     backticked path inside a question as a file to WRITE, and would therefore
//     call a body ready that the planner calls unready.
//
// As with the mirrors below, no version number is written here: the invariant is
// that this mirror changes in the same commit as the code it copies, and the
// repository's conformance test
// (`tests/fixtures/cmate-issue-authoring/open-questions-conformance.mjs`) holds
// the two together — constants byte for byte, function bodies modulo the
// documented rename, and behaviour over a corpus.

// ---- the block as the planner reads it (verbatim mirror) --------------------

const OPEN_QUESTIONS_INFO = 'open-questions';
const OPEN_QUESTIONS_VERSION = 1;

// Counted on its own so "two blocks" is detected even when the second one is
// malformed; `m` makes `^`/`$` line anchors and the info string must be the whole
// word, so ```open-questions-v2 is not this block. Same shape as
// ACCEPTANCE_GATES_OPEN_RE / ACCEPTANCE_GATES_BLOCK_RE below, on purpose.
const OPEN_QUESTIONS_OPEN_RE = /^```open-questions[ \t]*$/gm;
const OPEN_QUESTIONS_BLOCK_RE = /^```open-questions[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm;

// Same bound as the acceptance block's id list. An issue that cannot state what
// it is doing in 32 undecidables is not an issue, it is a design phase.
const MAX_OPEN_QUESTIONS = 32;

// A question's value is free text, so the id regex that rejects YAML's reserved
// leading characters for gate ids cannot do it here. These are the shapes
// acceptance-gates-notation.md §3 forbids outright (anchor / alias / flow
// collection / block scalar) and they are refused for the same reason: read as
// plain text they would silently mean something other than what a YAML reader
// would make of them.
const OPEN_QUESTION_RESERVED_RE = /^[&*[{|>]/;

// Stripped from the prose extractors' input for the same two measured reasons the
// acceptance block is (see stripAcceptanceGateBlocks): the fence pattern in
// `extractTestExpectations` cannot match `open-questions` as an INFO STRING (the
// hyphen is outside [a-zA-Z]) but does match this block's CLOSING fence as an
// opening one, swallowing the following ```bash block whole — measured on fixture
// 59-open-questions-declared, where 3 test_expectations drop to 1 — and a
// `  - …` line inside the block is shaped like a bullet, so an unstripped body
// reads the author's questions as acceptance criteria and any path inside one as
// a file to WRITE. The second half is not hypothetical either: the same fixture's
// `src/legacy/topo.ts`, named inside a question, reaches scope.allow with its
// four derived test companions behind it.
function plannerStripOpenQuestionBlocks(text) {
  return String(text).replace(OPEN_QUESTIONS_BLOCK_RE, '');
}

function plannerCountOpenQuestionBlocks(text) {
  return [...String(text).matchAll(OPEN_QUESTIONS_OPEN_RE)].length;
}

// The same YAML subset `parseAcceptanceGatesBlock` reads, with `questions:` in
// place of `require:`. Kept as a separate function rather than parameterising the
// gates parser: the two notations are allowed to diverge (they are separate
// documents with separate versions), and a shared parser would make a change to
// one silently a change to the other. Returns {ok, value} or {ok:false, reason}.
function plannerParseOpenQuestionsBlock(raw) {
  const bad = (reason) => ({ ok: false, reason });
  const lines = String(raw).split(/\r?\n/);
  const value = { version: OPEN_QUESTIONS_VERSION, questions: [] };
  const seenKeys = new Set();
  let sawVersion = false;
  let section = null; // null | 'questions'

  for (const line of lines) {
    if (line.includes('\t')) return bad('a tab character is not allowed; the block is indented with 2 spaces');
    if (line.trim() === '') continue;
    // 行頭 `#` のみコメント: a `#` anywhere else is part of the value. Here that
    // rule earns its keep twice over — a question ending in "…, or #63?" keeps
    // its issue reference instead of losing half the sentence.
    if (line.startsWith('#')) continue;
    if (line === '---' || line === '...') return bad('YAML document markers are not part of the subset');

    const indent = line.length - line.trimStart().length;
    const content = line.slice(indent);

    if (indent === 0) {
      section = null;
      const match = /^([a-zA-Z][a-zA-Z0-9_]*):[ \t]*(.*)$/.exec(content);
      if (match === null) return bad(`"${content}" is not a "key: value" line at the top level`);
      const [, key, rest] = match;
      if (seenKeys.has(key)) return bad(`duplicate key "${key}"`);
      seenKeys.add(key);
      if (!sawVersion && key !== 'version') {
        return bad('"version: 1" must be the first key of the block');
      }
      if (key === 'version') {
        sawVersion = true;
        if (rest !== String(OPEN_QUESTIONS_VERSION)) {
          // Not rounded forward, for the reason the gates parser gives: an
          // unknown version means the block was written against a notation this
          // runner does not implement.
          return bad(`version must be exactly ${OPEN_QUESTIONS_VERSION} (got "${rest}")`);
        }
        continue;
      }
      if (key === 'questions') {
        if (rest !== '') return bad('"questions:" takes a block sequence on the following lines, not an inline value');
        section = 'questions';
        continue;
      }
      return bad(`unknown key "${key}" (the v1 block accepts only version, questions)`);
    }

    if (indent !== 2) return bad(`unexpected indentation of ${indent} space(s); list items are indented by exactly 2`);
    if (section !== 'questions') return bad(`"${content}" is indented but no list is open above it`);
    const item = /^-[ \t]+(.*)$/.exec(content);
    if (item === null) return bad(`"${content}" is not a "- <question>" list item`);
    const question = item[1];
    if (question === '') return bad('an empty question; write the undecided thing, or delete the item');
    if (OPEN_QUESTION_RESERVED_RE.test(question)) {
      return bad(`"${question}" starts with a character YAML reserves (${OPEN_QUESTION_RESERVED_RE.source}); anchors, flow collections and block scalars are not part of the subset`);
    }
    if (value.questions.includes(question)) return bad(`duplicate question "${question}"`);
    value.questions.push(question);
    if (value.questions.length > MAX_OPEN_QUESTIONS) {
      return bad(`at most ${MAX_OPEN_QUESTIONS} open questions may be declared`);
    }
  }

  if (!sawVersion) return bad('the block declares no "version: 1"');
  // The empty block is the same contract error `require: []` is: it announces
  // that something is undecided and then names nothing, exactly where the author
  // meant to state it.
  if (value.questions.length === 0) return bad('the block asks nothing; remove it, or write at least one question under "questions:"');
  return { ok: true, value };
}

// The whole block reading for one issue body. Returns {questions, error} —
// `questions` is the author's list in the author's order (empty when there is no
// block), `error` is the open question describing an unreadable block (null when
// there is nothing to say). The two are never both set: "no block" and "broken
// block" are different states and the second must never be rounded to the first
// (acceptance-gates-notation.md §7, applied unchanged).
function plannerReadOpenQuestions(body) {
  const text = String(body ?? '');
  const opens = plannerCountOpenQuestionBlocks(text);
  if (opens === 0) return { questions: [], error: null };
  const invalid = (reason) => ({
    questions: [],
    error: {
      code: 'open_question_block_invalid',
      text: `The \`${OPEN_QUESTIONS_INFO}\` block could not be read: ${reason}. `
        + 'It is NOT treated as absent: fix the block or remove it, then re-plan. '
        + 'The planner never reads an open question out of prose.',
    },
  });
  if (opens > 1) {
    return invalid(`the body carries ${opens} blocks and exactly one is allowed (they are not merged, and the first does not win)`);
  }
  const blocks = [...text.matchAll(OPEN_QUESTIONS_BLOCK_RE)];
  if (blocks.length !== 1) return invalid('the block is never closed by a ``` fence at the start of a line');
  const parsed = plannerParseOpenQuestionsBlock(blocks[0][1]);
  if (!parsed.ok) return invalid(parsed.reason);
  return { questions: parsed.value.questions, error: null };
}

// ---- the block this package emits -------------------------------------------
//
// The one rendering this package produces, for the reason the gates emitter
// gives: the notation is emitted by code rather than recalled from a document.
// The questions come from `open_questions[]` and nowhere else — this function
// receives them already projected, so there is no second place where "which
// questions are undecided" could be decided.
function renderOpenQuestionsBlock(questions) {
  const lines = ['```' + OPEN_QUESTIONS_INFO, `version: ${OPEN_QUESTIONS_VERSION}`, 'questions:'];
  for (const question of questions) lines.push(`  - ${question}`);
  lines.push('```');
  return `${lines.join('\n')}\n`;
}

//: The blocking questions of one planned issue, in `open_questions[]` order.
//: Membership is decided by `blocks` alone — the same field `duplicate_needs_open_question`
//: reads — so the array stays the single statement of what is undecided and the
//: block is a projection of it rather than a second copy.
function blockingQuestionsFor(plan, key) {
  return (plan.open_questions ?? [])
    .filter((question) => (question?.blocks ?? []).includes(key))
    .map((question) => String(question?.question ?? ''));
}

// =============================================================================
// Acceptance gates mirror
// =============================================================================
//
// The other machine-readable block an Issue body carries, and the one that
// decides a verdict: cmate-orchestrate's planner parses it and its dispatch
// runner turns it into the execution contract's verdict. The notation's 正本 is
// `skills/cmate-orchestrate/references/acceptance-gates-notation.md`; this
// package is a MIRROR of it and never extends it
// ([acceptance-gates.md](../references/acceptance-gates.md)).
//
// Two readers are mirrored here, verbatim, comments included:
//
//  1. the planner's block reader — so a body can be told, before the Issue
//     exists, whether the block it carries will be read or will stop the run;
//  2. dispatch's `.commandmate/verify.yaml` reader — so a `require:` id can be
//     checked against the file dispatch will check it against, instead of being
//     guessed. An id that does not exist there stops the run BEFORE `send`
//     (`acceptance_gate_id_unknown`), which is why this package refuses to write
//     one it has not seen.
//
// As with the planner mirror below, no version number is written here: the
// invariant is that this mirror changes in the same commit as the code it
// copies, and the repository's conformance test
// (`tests/fixtures/cmate-issue-authoring/acceptance-gates-conformance.mjs`)
// holds the two together — constants byte for byte, function bodies modulo the
// documented renames, and behaviour over a corpus.

// ---- the block as the planner reads it (verbatim mirror) --------------------

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
function plannerStripAcceptanceGateBlocks(text) {
  return String(text).replace(ACCEPTANCE_GATES_BLOCK_RE, '');
}

function plannerCountAcceptanceGateBlocks(text) {
  return [...String(text).matchAll(ACCEPTANCE_GATES_OPEN_RE)].length;
}

// The YAML subset the block is written in — the same one `.commandmate/verify.yaml`
// uses: 2-space indent, single-line scalars, comments only at column 0, no
// anchors, no flow collections, no multi-line strings. Deliberately NOT
// best-effort: a block this cannot read becomes an open question, never a guess
// (ADR §2.4). Returns {ok, value} or {ok:false, code, reason}.
function plannerParseAcceptanceGatesBlock(raw) {
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
function plannerReadAcceptanceGates(body) {
  const text = String(body ?? '');
  const opens = plannerCountAcceptanceGateBlocks(text);
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
  const parsed = plannerParseAcceptanceGatesBlock(blocks[0][1]);
  if (!parsed.ok) return invalid(parsed.code, parsed.reason);
  return { gates: parsed.value, error: null };
}

// ---- the block this package emits -------------------------------------------
//
// The one rendering this package produces. It exists so the notation is emitted
// by code rather than recalled from a document: an author asks for the bytes and
// gets exactly the shape the 正本 shows, with no room for a trailing comment, a
// three-space indent or a tab to be introduced by hand. Everything the mirrored
// reader above accepts is legal in an Issue body; only this shape is legal in a
// body THIS package wrote, which is what `acceptance_gates_block_is_canonical`
// enforces and what the conformance test pins against the 正本's own example.
function renderAcceptanceGatesBlock(ids) {
  const lines = ['```' + ACCEPTANCE_GATES_INFO, `version: ${ACCEPTANCE_GATES_VERSION}`, 'require:'];
  for (const id of ids) lines.push(`  - ${id}`);
  lines.push('```');
  return `${lines.join('\n')}\n`;
}

// ---- verify.yaml as dispatch reads it (verbatim mirror) ---------------------
//
// Renamed on the way in, and only that: `readWorktreeGateIds` is
// `checkoutGateIds` here because this package holds a read-only checkout rather
// than a dispatched worktree, and the planner's `ACCEPTANCE_GATE_ID_RE` is the
// same pattern dispatch calls `GATE_ID_RE`. The conformance test normalises
// exactly those renames and requires the rest to be byte-identical.

const VERIFY_CONFIG_RELATIVE = '.commandmate/verify.yaml';

// The ids a contract's `verify.gates` may name WITHOUT them appearing in
// verify.yaml. Transcribed from CommandMate's own contract-vs-config check,
// which builds its known set as {work-evidence, scope} ∪ declared gate ids.
// `env-clean` is a built-in gate but is deliberately NOT in that set, so a
// `require: [env-clean]` is refused here exactly as `send --contract` would.
const CONTRACT_BUILT_IN_GATE_IDS = ['work-evidence', 'scope'];

// Gate ids declared in a worktree's `.commandmate/verify.yaml`.
//
// The YAML subset is the one cmate-verify's verify-run.sh awk parser accepts —
// 2-space indent, single-line scalars, comments on their own line, no tabs, no
// anchors, no flow collections, no block scalars — mirrored here so both readers
// agree on what the file says. It is read-only and extracts ids only.
//
// FAIL-CLOSED: anything the subset cannot read returns an error rather than a
// partial id set. An unreadable config would otherwise make a required gate look
// absent (dispatch refused for the wrong reason) or, worse, make the id set look
// complete when it is not. The file is read ONLY for issues that require a gate,
// so a repository whose verify.yaml this cannot parse keeps its previous
// behaviour everywhere else.
function checkoutGateIds(checkoutPath) {
  const path = join(checkoutPath, VERIFY_CONFIG_RELATIVE);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: error.code === 'ENOENT'
        ? `${VERIFY_CONFIG_RELATIVE} does not exist in the checkout, so no gate id can be resolved`
        : `${VERIFY_CONFIG_RELATIVE} could not be read (${error.code ?? 'error'})`,
    };
  }
  const bad = (reason) => ({ ok: false, reason: `${VERIFY_CONFIG_RELATIVE}: ${reason}` });
  const ids = [];
  let section = '';
  let sawVersion = false;
  let gateOpen = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (line.includes('\t')) return bad('tab characters are not allowed');
    if (/^[ ]*$/.test(line)) continue;
    if (/^[ ]*#/.test(line)) continue;
    const indent = line.length - line.replace(/^ +/, '').length;
    if (indent % 2 !== 0) return bad('indentation must be a multiple of 2 spaces');
    const body = line.slice(indent);

    if (indent === 0) {
      gateOpen = false;
      const colon = body.indexOf(':');
      if (colon <= 0) return bad(`expected "key: value" at the top level, got "${body.slice(0, 40)}"`);
      const key = body.slice(0, colon).trim();
      const value = body.slice(colon + 1).trim();
      if (key === 'version') {
        sawVersion = true;
        if (unquoteYaml(value) !== '1') return bad(`version must be 1 (got "${value}")`);
        section = '';
      } else if (key === 'gates') {
        if (value !== '') return bad('gates: must be followed by an indented list');
        section = 'gates';
      } else if (key === 'options') {
        if (value !== '') return bad('options: must be followed by indented keys');
        section = 'options';
      } else {
        return bad(`unknown top-level key "${key}"`);
      }
      continue;
    }
    // An indented line with nothing open above it is a shape this reader does not
    // understand, and the sibling awk parser rejects it too. Skipping it would be
    // the one way a gate id could go unseen, which is the failure mode fail-closed
    // exists to prevent.
    if (section === '') return bad('indented line outside of gates: / options:');
    if (section !== 'gates') continue; // options and their nested keys carry no id
    if (indent === 2) {
      if (!body.startsWith('- ')) return bad('gate list items must start with "- "');
      gateOpen = true;
      const first = body.slice(2).trim();
      const colon = first.indexOf(':');
      if (colon <= 0) return bad('expected "key: value" inside a gate');
      if (first.slice(0, colon).trim() === 'id') ids.push(unquoteYaml(first.slice(colon + 1).trim()));
      continue;
    }
    if (indent === 4) {
      if (!gateOpen) return bad('gate field outside of a list item');
      const colon = body.indexOf(':');
      if (colon <= 0) return bad('expected "key: value" inside a gate');
      if (body.slice(0, colon).trim() === 'id') ids.push(unquoteYaml(body.slice(colon + 1).trim()));
      continue;
    }
    return bad(`unexpected indentation (${indent} spaces)`);
  }
  if (!sawVersion) return bad('missing top-level "version: 1"');
  if (ids.length === 0) return bad('no gate is declared');
  for (const id of ids) {
    if (!ACCEPTANCE_GATE_ID_RE.test(id)) return bad(`declared gate id "${id}" does not match ${ACCEPTANCE_GATE_ID_RE.source}`);
  }
  return { ok: true, ids };
}

// The single- or double-quoted scalar forms the subset allows. A value with no
// quotes is returned unchanged.
function unquoteYaml(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

// =============================================================================
// Planner mirror
// =============================================================================
//
// Verbatim behaviour of the extraction in the cmate-orchestrate planner
// (`scripts/orchestrate.mjs`, `analyzeIssue`). The planner raises exactly two
// blocking questions — "acceptance criteria are unclear" and "affected files are
// unclear" — and both are decided by this extraction. Keeping a copy here is what
// lets a body be checked before the Issue exists.
//
// No planner version number is written here on purpose: one did rot in three
// separate places before this note replaced it. The rule is the invariant, not a
// number — **this mirror changes in the same commit as the planner it copies**,
// and the constants below stay byte-identical to the planner's. The repository's
// own CI proves it (a conformance test compares the constants and runs both
// copies over a corpus); it is not something the installed package can check,
// and nothing here asks you to run it.

const ACCEPTANCE_HEADING_RE = /(acceptance|criteria|受入|受け入れ|完了条件|期待結果|受入条件)/i;
const HEADING_RE = /^#{1,6}\s+/;
const FILE_EXT = 'rs|md|toml|json|jsonc|yaml|yml|py|sh|ts|tsx|js|jsx|mjs|cjs|go|rb|java|kt|c|h|cpp|css|html|sql|geojson|topojson|geojsonl';
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

// Headings under which a path is the Issue's product, not its context
// (planner Issue #50). Byte-identical to the planner's.
const DELIVERABLE_HEADING_RE = /(deliverable|成果物|対象ファイル|変更対象|変更ファイル|作成ファイル|編集対象|出力ファイル|生成ファイル|affected files|target files|output files|files to (?:change|edit|create|write|add))/i;

// Headings under which a path is cited, not claimed (planner Issue #54).
// Byte-identical to the planner's.
const CONTEXT_HEADING_RE = /(根拠|出典|参考|参照|背景|関連|references?|context|background|see also|appendix)/i;

function plannerHeadingSpans(text, matches) {
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

const plannerDeliverableSpans = (text) =>
  plannerHeadingSpans(text, (line) => DELIVERABLE_HEADING_RE.test(line));

// A heading that reads as both is a deliverable heading, as in the planner.
const plannerContextSpans = (text) =>
  plannerHeadingSpans(text, (line) => !DELIVERABLE_HEADING_RE.test(line) && CONTEXT_HEADING_RE.test(line));

function plannerFileCandidates(text) {
  const patterns = [
    new RegExp(CANDIDATE_BACKTICK, 'g'),
    new RegExp(CANDIDATE_KNOWN_ROOT, 'g'),
    new RegExp(CANDIDATE_WITH_EXT, 'g'),
  ];
  const spans = plannerDeliverableSpans(text);
  const cSpans = plannerContextSpans(text);
  const seen = new Set();
  const deliverable = new Set();
  const inContext = new Set();
  const outsideContext = new Set();
  const found = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1].trim();
      if (!plannerIsSafeRepoPath(candidate)) continue;
      if (spans.some(([start, end]) => match.index >= start && match.index < end)) deliverable.add(candidate);
      if (cSpans.some(([start, end]) => match.index >= start && match.index < end)) inContext.add(candidate);
      else outsideContext.add(candidate);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        found.push(candidate);
      }
    }
  }
  // Excluded only when every mention is under a context heading (planner #54).
  const contextOnly = new Set([...inContext].filter((candidate) => !outsideContext.has(candidate)));
  // A candidate that is a path-boundary suffix of another used to be dropped as
  // a partial of it (planner Issue #49). It is NOT dropped any more (planner
  // Issue #182): which of the two overlapping spellings the Issue means is a
  // question for its author, and the planner asks it (`ambiguous_file_candidate`)
  // instead of guessing "the longer one" — a guess measured wrong exactly when it
  // cost the most, dropping the DECLARED path and keeping a build output. Both
  // reach suspected_files, so this mirror keeps both too: an Issue whose only
  // paths shadow each other is planner-READY, and a copy that still dropped one
  // would call the same body unready.
  return { paths: found, deliverable, contextOnly };
}

// A documentation path is context to read, not a file the Issue is expected to
// change — so an Issue whose only paths are docs leaves `suspected_files` empty
// and the planner asks "affected files are unclear" no matter how many paths it
// listed. This is the asymmetry the planner-readiness rule exists to catch. The
// one exception is an Issue that says a document IS its deliverable, by writing
// the path under a 成果物 / 対象ファイル / Deliverables heading (Issue #50).
//
// The mirror of that exception: a path mentioned only under a 根拠 / 参考 /
// References heading is cited, not claimed, and does not reach suspected_files
// whatever its extension (Issue #54). An Issue that names its files ONLY as
// evidence therefore reads as planner-unready here, which is what the planner
// will conclude too.
function plannerSuspectedFiles(text) {
  const { paths, deliverable, contextOnly } = plannerFileCandidates(text);
  return paths.filter(
    (candidate) =>
      !contextOnly.has(candidate) &&
      (deliverable.has(candidate) || (!/^docs\//.test(candidate) && !/\.(md|rst|txt)$/i.test(candidate))),
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
    // Every check below reads the body the PLANNER reads, which is the body with
    // BOTH machine-readable blocks removed, in the planner's own order
    // (`analyzeIssue` strips them before every prose extractor). Reading the raw
    // body here would make this mirror disagree with the planner exactly where it
    // matters: a block sitting under the 受入条件 heading would make
    // `  - orchestrate-fixtures` look like an acceptance criterion, and an Issue
    // with no prose criteria at all would be reported ready while the planner asks
    // its blocking question. The open-questions block is worse in the same
    // direction — its items are free text, so a question naming
    // `` `src/legacy/topo.ts` `` would put a path in `suspected_files` here that
    // the planner never sees, and this validator would call a body planner-ready
    // whose only declared file is one nobody asked to change.
    const body = plannerStripOpenQuestionBlocks(plannerStripAcceptanceGateBlocks(String(issue.body ?? '')));
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
// Open questions — the rules (references/open-questions.md)
// =============================================================================
//
// One sentence: **`open_questions[]` is the statement, the block is its
// projection.** The array already records what the author refused to decide on
// the user's behalf; before this rule existed the body said nothing about it, so
// an Issue registered with the question still open reached dispatch as an Issue
// with nothing undecided — and the worker decided it. That is Issue #178 on the
// authoring path, and it is not fixed by asking authors to copy the questions
// across by hand: a transcription that is skipped looks exactly like a plan that
// had nothing to transcribe.
//
// So the projection is checked in both directions. A question that blocks an
// issue must appear in that issue's body, and a block in a body must be exactly
// the questions the plan says block it, in the plan's order. Neither half alone
// is enough: checking only what is written leaves the omission (the actual
// failure) unmeasured, and checking only what is declared would let a body carry
// a question the plan never recorded — a stop nobody can answer from the artifact.
//
// Deleting the block is what records the decision (正本 §5), so a resolved
// question leaves `open_questions[]` and the block leaves the body in the same
// edit. The two can never disagree, because this rule re-derives one from the
// other rather than comparing two hand-written copies.

function checkOpenQuestions(plan, out) {
  plan.issues.forEach((issue, index) => {
    const body = String(issue.body ?? '');
    const pointer = `/issues/${index}/body`;
    const read = plannerReadOpenQuestions(body);

    if (read.error !== null) {
      out.add(
        'open_questions_block_parses',
        pointer,
        `the planner would not read this block and would raise ${read.error.code}: ${read.error.text} ` +
          'Render it with `--render-open-questions ' + issue.key + '` instead of writing it by hand',
      );
      return;
    }

    const declared = blockingQuestionsFor(plan, issue.key);

    // Can the projection be written down at all? The reader itself answers, so a
    // constraint of the notation cannot be restated (and mis-stated) here. A
    // question that cannot be an item is not repaired: rewriting an author-facing
    // sentence to fit a serializer is how the sentence stops meaning what the plan
    // meant (references/open-questions.md).
    if (declared.length > 0) {
      const reread = plannerReadOpenQuestions(renderOpenQuestionsBlock(declared));
      if (reread.error !== null) {
        const ids = (plan.open_questions ?? [])
          .filter((question) => (question?.blocks ?? []).includes(issue.key))
          .map((question) => question?.id);
        out.add(
          'open_questions_are_representable',
          pointer,
          `the ${declared.length} open question(s) blocking "${issue.key}" (${ids.join(', ')}) cannot be ` +
            `written as a block the planner reads: ${reread.error.text} ` +
            (declared.length > MAX_OPEN_QUESTIONS
              ? `${declared.length} exceeds the notation's bound of ${MAX_OPEN_QUESTIONS}. Do not cut the ` +
                'list to fit — a cut block would claim this issue has fewer undecidables than it has. An ' +
                'issue with more undecidables than the notation carries is one Step 4 has not finished ' +
                'splitting, so split it'
              : 'Rewrite the question field itself so it is one answerable sentence, and let the block ' +
                'carry that same text'),
        );
        return;
      }
    }

    if (read.questions.length > 0) {
      const match = [...body.matchAll(OPEN_QUESTIONS_BLOCK_RE)][0];
      const written = match[0].endsWith('\n') ? match[0] : `${match[0]}\n`;
      const canonical = renderOpenQuestionsBlock(read.questions);
      if (written !== canonical) {
        out.add(
          'open_questions_block_is_canonical',
          pointer,
          'the block is readable but is not the shape this package emits; render it with ' +
            `\`--render-open-questions ${issue.key}\` and paste the result verbatim`,
        );
      }
    }

    if (JSON.stringify(read.questions) !== JSON.stringify(declared)) {
      out.add(
        'open_questions_block_is_derived',
        pointer,
        `the body's open-questions block is ${JSON.stringify(read.questions)} but ${JSON.stringify(declared)} ` +
          `is what open_questions[] says blocks "${issue.key}". The array is the statement and the block is ` +
          'its projection: ' +
          (declared.length === 0
            ? 'nothing in the plan blocks this issue, so its body must carry no block. Delete the block, or — ' +
              'if the question is real — record it in open_questions[] with this key in its `blocks`, where a ' +
              'reviewer can read it alongside its options'
            : read.questions.length === 0
              ? 'the body says nothing about it, so the Issue would be registered with the question still open ' +
                'and dispatch would not stop. Render the block with ' +
                `\`--render-open-questions ${issue.key}\` and put it in the body`
              : `re-render it with \`--render-open-questions ${issue.key}\``),
      );
    }
  });
}

//: The block a `--render-open-questions` request asks for, refused rather than
//: repaired — the emitter is the last place a block that does not match the plan
//: could enter a body, so it is the place that has to be unable to produce one.
function openQuestionsBlockFromCli(plan, key) {
  const issues = Array.isArray(plan.issues) ? plan.issues : [];
  const keys = issues.map((issue) => issue?.key);
  if (!keys.includes(key)) {
    throw new Error(
      `"${key}" is not an issue in this plan (keys: ${keys.filter((entry) => typeof entry === 'string').join(', ')})`,
    );
  }
  const declared = blockingQuestionsFor(plan, key);
  if (declared.length === 0) return '';
  const block = renderOpenQuestionsBlock(declared);
  const read = plannerReadOpenQuestions(block);
  if (read.error !== null) {
    throw new Error(
      `the ${declared.length} open question(s) blocking "${key}" cannot be written as a block the planner ` +
        `reads: ${read.error.text}` +
        (declared.length > MAX_OPEN_QUESTIONS
          ? ` The notation's bound is ${MAX_OPEN_QUESTIONS}; the list is not cut to fit, because a cut block ` +
            'would claim the issue has fewer undecidables than it has. Split the issue instead'
          : ''),
    );
  }
  return block;
}

// =============================================================================
// Acceptance gates — the rules (references/acceptance-gates.md)
// =============================================================================
//
// The discipline these implement is one sentence: **only a condition this run
// could actually verify becomes a gate.** Everything else stays prose, which is
// not a lesser outcome — an Issue with no block behaves exactly as it did before
// this notation existed (notation §7), while an Issue with a guessed gate id
// stops the run at dispatch, before `send`, with `acceptance_gate_id_unknown`.
// A helpful guess is strictly worse than saying nothing.

//: Raised when the run cannot decide, as opposed to deciding "invalid". It exits
//: 2, which is the whole reason the three exit codes exist.
class RunError extends Error {}

function checkAcceptanceGates(plan, options, out) {
  // Read once, and only if some issue actually declares a block — the same
  // laziness dispatch has, so a repository whose verify.yaml this cannot parse
  // keeps validating exactly as before for plans that declare no gate.
  let known = null;
  const knownGateIds = () => {
    if (known === null) {
      const result = checkoutGateIds(options.checkout);
      if (!result.ok) {
        throw new RunError(
          `${result.reason}. An issue in this plan declares acceptance gates, and they can only be ` +
            'checked against the file dispatch checks them against; this run could not look, which is ' +
            'not the same as the plan being wrong',
        );
      }
      known = new Set([...CONTRACT_BUILT_IN_GATE_IDS, ...result.ids]);
    }
    return known;
  };

  plan.issues.forEach((issue, index) => {
    const body = String(issue.body ?? '');
    const pointer = `/issues/${index}/body`;
    const read = plannerReadAcceptanceGates(body);

    if (read.error !== null) {
      if (read.error.code === 'acceptance_gate_block_unsupported') {
        out.add(
          'acceptance_gates_no_new_commands',
          pointer,
          'the block declares `gates:` (new command gates), which the planner refuses with ' +
            'acceptance_gate_block_unsupported: it is stage 2 of the ADR and no release enforces it yet. ' +
            'Name an existing gate id under `require:`, or keep the condition out of the block and state ' +
            'it as prose for UAT',
        );
        return;
      }
      out.add(
        'acceptance_gates_block_parses',
        pointer,
        `the planner would not read this block and would raise ${read.error.code}: ${read.error.text}`,
      );
      return;
    }
    // No block is the ordinary case and is never a finding: the notation is
    // opt-in, and a condition nobody could measure belongs in prose.
    if (read.gates === null) return;

    const match = [...body.matchAll(ACCEPTANCE_GATES_BLOCK_RE)][0];
    const written = match[0].endsWith('\n') ? match[0] : `${match[0]}\n`;
    const canonical = renderAcceptanceGatesBlock(read.gates.require);
    if (written !== canonical) {
      out.add(
        'acceptance_gates_block_is_canonical',
        pointer,
        'the block is readable but is not the shape this package emits; render it with ' +
          `\`--render-acceptance-gates ${read.gates.require.join(',')}\` and paste the result verbatim`,
      );
    }

    if (options.checkout === null) {
      out.add(
        'acceptance_gates_verify_yaml_read',
        pointer,
        'the body declares acceptance gates but this run was given no --checkout, so no ' +
          `${VERIFY_CONFIG_RELATIVE} was read and nothing here has seen the ids exist. Re-run with ` +
          '--checkout <path to the target repository>, or remove the block: an id that does not exist ' +
          'stops the dispatch of this issue before `send`',
      );
      return;
    }

    const ids = knownGateIds();
    read.gates.require.forEach((id) => {
      if (ids.has(id)) return;
      out.add(
        'acceptance_gates_id_exists',
        pointer,
        `\`require: ${id}\` names a gate that ${options.checkout}/${VERIFY_CONFIG_RELATIVE} does not ` +
          `declare (resolvable ids are ${[...ids].sort().join(', ')}). dispatch refuses this issue with ` +
          'acceptance_gate_id_unknown before it sends anything, so the block would stop the run rather ' +
          'than strengthen it',
      );
    });
  });
}

//: The gate ids of a `--render-acceptance-gates` request, refused rather than
//: repaired. The emitter is the last place a guessed id could enter a body, so it
//: is the place that has to be unable to invent one.
function acceptanceGateIdsFromCli(spec, checkout) {
  const ids = String(spec).split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (ids.length === 0) throw new Error('--render-acceptance-gates needs at least one gate id');
  if (ids.length > MAX_ACCEPTANCE_GATE_IDS) {
    throw new Error(`--render-acceptance-gates accepts at most ${MAX_ACCEPTANCE_GATE_IDS} gate ids`);
  }
  const seen = new Set();
  for (const id of ids) {
    if (!ACCEPTANCE_GATE_ID_RE.test(id)) {
      throw new Error(`"${id}" is not a valid gate id (${ACCEPTANCE_GATE_ID_RE.source})`);
    }
    if (seen.has(id)) throw new Error(`duplicate gate id "${id}"`);
    seen.add(id);
  }
  if (checkout === null) {
    throw new Error(
      '--render-acceptance-gates needs --checkout: a block may only name gate ids that were read from ' +
        `the target repository's ${VERIFY_CONFIG_RELATIVE}`,
    );
  }
  const result = checkoutGateIds(checkout);
  if (!result.ok) throw new Error(result.reason);
  const declared = new Set([...CONTRACT_BUILT_IN_GATE_IDS, ...result.ids]);
  for (const id of ids) {
    if (!declared.has(id)) {
      throw new Error(
        `"${id}" is not declared in ${checkout}/${VERIFY_CONFIG_RELATIVE} ` +
          `(declared: ${[...declared].sort().join(', ')})`,
      );
    }
  }
  return ids;
}

// =============================================================================
// Entry point
// =============================================================================

function parseArgs(argv) {
  const options = {
    plan: null,
    schema: DEFAULT_SCHEMA,
    checkout: null,
    render: null,
    renderQuestions: null,
    json: false,
    deriveId: false,
    help: false,
  };
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
    } else if (arg === '--checkout') {
      index += 1;
      if (index >= argv.length) throw new Error('--checkout needs a path');
      options.checkout = argv[index];
    } else if (arg === '--render-acceptance-gates') {
      index += 1;
      if (index >= argv.length) throw new Error('--render-acceptance-gates needs a gate id list');
      options.render = argv[index];
    } else if (arg === '--render-open-questions') {
      index += 1;
      if (index >= argv.length) throw new Error('--render-open-questions needs an issue key');
      options.renderQuestions = argv[index];
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (options.plan === null) {
      options.plan = arg;
    } else {
      throw new Error('exactly one plan file is accepted');
    }
  }
  if (options.render !== null && options.renderQuestions !== null) {
    throw new Error('the two renderers print two different blocks; ask for one of them');
  }
  if (options.render !== null && options.plan !== null) {
    throw new Error('--render-acceptance-gates prints a block; it does not validate a plan');
  }
  // The open-questions block is derived from the plan itself, so unlike the gates
  // renderer this one NEEDS the plan file. It still refuses to validate at the
  // same time: a run that printed findings and a block together would leave the
  // author reading a block whose plan had just been called invalid.
  if (!options.help && options.render === null && options.plan === null) {
    throw new Error('a plan file is required');
  }
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

  if (options.render !== null) {
    let ids;
    try {
      ids = acceptanceGateIdsFromCli(options.render, options.checkout);
    } catch (error) {
      process.stderr.write(`error: ${error.message}\n`);
      return EXIT_ERROR;
    }
    process.stdout.write(renderAcceptanceGatesBlock(ids));
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

  if (options.renderQuestions !== null) {
    let block;
    try {
      block = openQuestionsBlockFromCli(plan, options.renderQuestions);
    } catch (error) {
      process.stderr.write(`error: ${error.message}\n`);
      return EXIT_ERROR;
    }
    // Nothing on stdout when nothing blocks the issue, and the reason on stderr.
    // An empty block is not a representable value (the planner refuses it), so
    // "no block" is the correct body for an issue with nothing undecided — and a
    // caller redirecting stdout to a file gets an empty file, which is what it
    // should paste.
    if (block === '') {
      process.stderr.write(
        `note: no open question in this plan blocks "${options.renderQuestions}", so there is no block to ` +
          'write. An issue nothing is undecided about carries none\n',
      );
    } else {
      process.stdout.write(block);
    }
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
    checkOpenQuestions(plan, findings);
    try {
      checkAcceptanceGates(plan, options, findings);
    } catch (error) {
      if (!(error instanceof RunError)) throw error;
      process.stderr.write(`error: ${error.message}\n`);
      return EXIT_ERROR;
    }
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
