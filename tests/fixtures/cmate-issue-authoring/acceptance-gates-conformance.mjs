#!/usr/bin/env node
// Conformance test: the acceptance-gates notation the PRODUCING packages emit
// must be the notation the CONSUMING package reads.
//
//   node tests/fixtures/cmate-issue-authoring/acceptance-gates-conformance.mjs
//
// The 正本 is `skills/cmate-orchestrate/references/acceptance-gates-notation.md`.
// Three implementations have to agree with it and with each other:
//
// | implementation | role |
// |---|---|
// | `cmate-orchestrate/scripts/orchestrate.mjs` | reads the block out of an Issue body |
// | `cmate-orchestrate/scripts/dispatch.mjs` | resolves `require:` ids against `.commandmate/verify.yaml` |
// | `cmate-issue-authoring/scripts/validate-plan.mjs` | writes the block, and refuses to write one it cannot resolve |
//
// The producer went in second (Issue #124). That order is what makes this file
// necessary rather than decorative: a mirror written after the thing it mirrors
// has nothing but review holding it in place, and review is what had already let
// three copies of a version number rot before `mirror-conformance.mjs` existed.
//
// What is proved, and why each layer is not enough on its own:
//
//  1. **The constants are byte-identical.** One character of difference in the
//     fence pattern or the gate-id pattern is a body the producer calls
//     conforming and the consumer refuses.
//  2. **The function bodies are byte-identical**, modulo the renames listed in
//     RENAMES and with comment lines dropped. Constants can stay equal while the
//     code around them diverges.
//  3. **The behaviour is identical over a corpus**, positive and negative, for
//     both the block reader and the verify.yaml reader. Byte equality of the
//     source is the strong check; running both is what catches a mirror that
//     was restructured rather than copied.
//  4. **The block the producer EMITS is the block the 正本 shows.** Every
//     `acceptance-gates` block in the notation document is re-rendered from its
//     own ids by the producer's renderer and must come back byte for byte, and
//     every block shipped in either producing package must parse, must be that
//     same canonical shape, and must not declare `gates:` — which is valid
//     notation that no release enforces, so a producer that emitted it would be
//     writing Issues that stop at dispatch.
//
// Scope is the MIRRORED REGIONS, never a digest of a whole file: a test that
// fails on any unrelated change to the planner is a test people learn to ignore.
//
// Exit status: 0 in sync, 1 drifted, 2 the test itself could not run (a region
// marker moved, a constant was renamed). "I could not look" must never read as
// "in sync".

import { Buffer } from 'node:buffer';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const PLANNER = resolve(REPO_ROOT, 'skills/cmate-orchestrate/scripts/orchestrate.mjs');
const DISPATCH = resolve(REPO_ROOT, 'skills/cmate-orchestrate/scripts/dispatch.mjs');
const MIRROR = resolve(REPO_ROOT, 'skills/cmate-issue-authoring/scripts/validate-plan.mjs');
const NOTATION = resolve(REPO_ROOT, 'skills/cmate-orchestrate/references/acceptance-gates-notation.md');
const PRODUCERS = [
  resolve(REPO_ROOT, 'skills/cmate-issue-authoring'),
  resolve(REPO_ROOT, 'skills/cmate-issue-refinement'),
];

const EXIT_SYNCED = 0;
const EXIT_DRIFTED = 1;
const EXIT_ERROR = 2;

// =============================================================================
// What has to be identical
// =============================================================================

// Same name on both sides. Compared as the declaration text, byte for byte:
// these are pattern sources and bounds, and "equivalent" is not a property this
// test can check.
const SHARED_CONSTANTS = [
  { file: PLANNER, label: 'planner', names: [
    'ACCEPTANCE_GATES_INFO',
    'ACCEPTANCE_GATES_VERSION',
    'ACCEPTANCE_GATES_OPEN_RE',
    'ACCEPTANCE_GATES_BLOCK_RE',
    'ACCEPTANCE_GATE_ID_RE',
    'MAX_ACCEPTANCE_GATE_IDS',
  ] },
  { file: DISPATCH, label: 'dispatch', names: [
    'VERIFY_CONFIG_RELATIVE',
    'CONTRACT_BUILT_IN_GATE_IDS',
  ] },
];

// Different name, same value — the two runners disagree on what to call the gate
// id pattern and its bound, and the mirror follows the planner. Comparing them
// anyway is what keeps `send --contract` and this validator refusing the same ids.
const CROSS_NAMED_CONSTANTS = [
  { left: { file: DISPATCH, label: 'dispatch', name: 'GATE_ID_RE' },
    right: { file: MIRROR, label: 'mirror', name: 'ACCEPTANCE_GATE_ID_RE' } },
  { left: { file: DISPATCH, label: 'dispatch', name: 'MAX_GATE_IDS' },
    right: { file: MIRROR, label: 'mirror', name: 'MAX_ACCEPTANCE_GATE_IDS' } },
];

// The renames the mirror applies, and the only differences allowed in a mirrored
// function body. They are scoped to the pair they belong to on purpose: the block
// reader keeps the planner's `ACCEPTANCE_GATE_ID_RE`, and applying the dispatch
// rename to it would hide a real divergence behind a rewrite. Longest first, so
// `checkoutPath` is not caught by the `checkout` entry.
const BLOCK_RENAMES = [
  [/\bplanner([A-Z])([A-Za-z0-9_]*)/g, (match, head, tail) => head.toLowerCase() + tail],
];
const VERIFY_RENAMES = [
  [/\bcheckoutGateIds\b/g, 'readWorktreeGateIds'],
  [/\bcheckoutPath\b/g, 'worktreePath'],
  [/\bACCEPTANCE_GATE_ID_RE\b/g, 'GATE_ID_RE'],
  [/does not exist in the checkout/g, 'does not exist in the worktree'],
];

const MIRRORED_FUNCTIONS = [
  { left: { file: PLANNER, label: 'planner', name: 'stripAcceptanceGateBlocks' },
    right: { file: MIRROR, label: 'mirror', name: 'plannerStripAcceptanceGateBlocks' },
    renames: BLOCK_RENAMES },
  { left: { file: PLANNER, label: 'planner', name: 'countAcceptanceGateBlocks' },
    right: { file: MIRROR, label: 'mirror', name: 'plannerCountAcceptanceGateBlocks' },
    renames: BLOCK_RENAMES },
  { left: { file: PLANNER, label: 'planner', name: 'readAcceptanceGates' },
    right: { file: MIRROR, label: 'mirror', name: 'plannerReadAcceptanceGates' },
    renames: BLOCK_RENAMES },
  { left: { file: DISPATCH, label: 'dispatch', name: 'readWorktreeGateIds' },
    right: { file: MIRROR, label: 'mirror', name: 'checkoutGateIds' },
    renames: VERIFY_RENAMES },
  { left: { file: DISPATCH, label: 'dispatch', name: 'unquoteYaml' },
    right: { file: MIRROR, label: 'mirror', name: 'unquoteYaml' },
    renames: VERIFY_RENAMES },
];

// =============================================================================
// The one place the producer has NOT caught up (Issue #125)
// =============================================================================
//
// `gates:` — a block that DEFINES a new command gate — is implemented on the
// consumer side: the planner reads it and dispatch carries it in the execution
// contract's `verify.gateDefinitions`. The producing packages still refuse it
// (`acceptance_gate_block_unsupported`), because writing Issues that declare one
// is a separate Issue (ADR §5) and a producer that emitted a shape it cannot
// resolve would be writing Issues that stop at dispatch.
//
// That makes `parseAcceptanceGatesBlock` the one mirrored function that is NOT a
// verbatim copy any more, and the interesting question becomes "diverged HOW".
// Dropping it from MIRRORED_FUNCTIONS would answer that with "somehow", and the
// `require:` half — every rule the two sides still share — would stop being
// pinned at all. So the divergence is written down instead: applying these
// patches to the planner's function must produce the mirror's, byte for byte.
// A change to anything else in either function lands outside a patch and fails.
//
// When the producer catches up, delete this list and move the pair back into
// MIRRORED_FUNCTIONS. Until then, a patch that stops applying is the signal that
// the two implementations moved apart somewhere nobody wrote down.
const PRODUCER_LAG = {
  left: { file: PLANNER, label: 'planner', name: 'parseAcceptanceGatesBlock' },
  right: { file: MIRROR, label: 'mirror', name: 'plannerParseAcceptanceGatesBlock' },
  renames: BLOCK_RENAMES,
  patches: [
    {
      what: 'the definitions the planner accumulates',
      planner: '  const value = { version: ACCEPTANCE_GATES_VERSION, require: [] };\n  const defined = [];\n',
      mirror: '  const value = { version: ACCEPTANCE_GATES_VERSION, require: [] };\n',
    },
    {
      what: 'the sections the block may open',
      planner: "  let section = null; // null | 'require' | 'gates'\n",
      mirror: "  let section = null; // null | 'require'\n",
    },
    {
      what: 'the `gates:` key — read by the consumer, refused by the producer',
      planner: '      if (key === \'gates\') {\n'
        + '        if (rest !== \'\') return bad(\'acceptance_gate_block_invalid\', \'"gates:" takes a block sequence on the following lines, not an inline value\');\n'
        + "        section = 'gates';\n"
        + '        continue;\n'
        + '      }\n',
      mirror: '      if (key === \'gates\') {\n'
        + '        return bad(\'acceptance_gate_block_unsupported\', \'"gates:" (new command gates) is stage 2 of the ADR and is not enforced by this release; use "require:" with gate ids that already exist in .commandmate/verify.yaml, or keep the condition out of the block and state it for UAT\');\n'
        + '      }\n',
    },
    {
      what: 'the two-indent-level entry reader the producer has no need for',
      planner: "    if (section === 'gates') {\n"
        + '      const problem = readAcceptanceGateDefinition(defined, indent, content);\n'
        + "      if (problem !== null) return bad('acceptance_gate_block_invalid', problem);\n"
        + '      continue;\n'
        + '    }\n',
      mirror: '',
    },
    {
      what: 'the end-of-block checks over BOTH lists',
      planner: '  const commandless = defined.find((gate) => gate.command === null);\n'
        + '  if (commandless !== undefined) return bad(\'acceptance_gate_block_invalid\', `gate "${commandless.id}" declares no command; a gate that runs nothing cannot judge anything`);\n'
        + '  const declaredIds = new Set();\n'
        + '  for (const id of [...value.require, ...defined.map((gate) => gate.id)]) {\n'
        + '    if (declaredIds.has(id)) return bad(\'acceptance_gate_block_invalid\', `duplicate gate id "${id}"`);\n'
        + '    declaredIds.add(id);\n'
        + '  }\n'
        + '  if (declaredIds.size > MAX_ACCEPTANCE_GATE_IDS) {\n'
        + '    return bad(\'acceptance_gate_block_invalid\', `at most ${MAX_ACCEPTANCE_GATE_IDS} gate ids may be required and defined together, and this block declares ${declaredIds.size}; the list is NOT cut to fit`);\n'
        + '  }\n'
        + '  if (declaredIds.size === 0) return bad(\'acceptance_gate_block_invalid\', \'the block requires no gate; remove it, or name at least one gate id under "require:" or define one under "gates:"\');\n'
        + '  if (defined.length > 0) value.gates = defined;\n',
      mirror: '  if (value.require.length === 0) return bad(\'acceptance_gate_block_invalid\', \'the block requires no gate; remove it, or name at least one gate id under "require:"\');\n',
    },
  ],
};

// =============================================================================
// Corpus — the block reader
// =============================================================================
//
// Every case makes one rule of the notation observable. The negative half
// carries the code the consumer answers with, because "both refused it" is not
// enough: `acceptance_gate_block_invalid` (fix the block) and
// `acceptance_gate_block_unsupported` (this release will never run it) send the
// author to two different places.

const BLOCK_CORPUS = [
  { name: 'no block at all', body: 'ふつうの Issue 本文。\n\n## 受入条件\n\n- [ ] 動く\n' },
  { name: 'the notation section 2 example', body: '```acceptance-gates\nversion: 1\nrequire:\n  - verify-selftest\n  - orchestrate-fixtures\n```\n' },
  { name: 'one gate, no trailing newline', body: '```acceptance-gates\nversion: 1\nrequire:\n  - validate\n```' },
  { name: 'a comment line at column 0 is allowed', body: '```acceptance-gates\n# 測れるものだけ\nversion: 1\nrequire:\n  - validate\n```\n' },
  { name: 'blank lines inside the block are allowed', body: '```acceptance-gates\nversion: 1\n\nrequire:\n  - validate\n\n```\n' },
  { name: 'the block is surrounded by prose and other fences', body: '目的。\n\n```bash\nnpm test\n```\n\n## 受入条件\n\n- [ ] `npm test` が通る\n\n```acceptance-gates\nversion: 1\nrequire:\n  - validate\n```\n\nゲート外: 文言の読みやすさ。\n' },
  { name: 'ids may carry digits and hyphens', body: '```acceptance-gates\nversion: 1\nrequire:\n  - gate-1\n  - 2nd-gate\n  - a\n```\n' },
  { name: 'the 32-id bound is reached exactly', body: `\`\`\`acceptance-gates\nversion: 1\nrequire:\n${Array.from({ length: 32 }, (_, index) => `  - gate-${index}`).join('\n')}\n\`\`\`\n` },
  { name: 'a 32-character id', body: `\`\`\`acceptance-gates\nversion: 1\nrequire:\n  - a${'b'.repeat(31)}\n\`\`\`\n` },
  { name: 'info string with trailing spaces', body: '```acceptance-gates  \nversion: 1\nrequire:\n  - validate\n```\n' },
  { name: 'CRLF line endings', body: '```acceptance-gates\r\nversion: 1\r\nrequire:\r\n  - validate\r\n```\r\n' },
];

const BLOCK_REFUSALS = [
  { name: 'two blocks are not merged and the first does not win', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\nrequire:\n  - a\n```\n\n```acceptance-gates\nversion: 1\nrequire:\n  - b\n```\n' },
  { name: 'an unknown version is not rounded forward', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 2\nrequire:\n  - validate\n```\n' },
  { name: 'version is not the first key', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nrequire:\n  - validate\nversion: 1\n```\n' },
  { name: 'no version at all', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nrequire:\n  - validate\n```\n' },
  { name: 'a tab is not indentation', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\nrequire:\n\t- validate\n```\n' },
  { name: 'three spaces is not two', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\nrequire:\n   - validate\n```\n' },
  { name: 'a trailing comment is part of the value', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\nrequire:\n  - validate # 既存ゲート\n```\n' },
  { name: 'a flow collection is not the subset', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\nrequire: [validate]\n```\n' },
  { name: 'a quoted id is not the subset', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\nrequire:\n  - "validate"\n```\n' },
  { name: 'an uppercase id', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\nrequire:\n  - Validate\n```\n' },
  { name: 'a 33-character id', code: 'acceptance_gate_block_invalid',
    body: `\`\`\`acceptance-gates\nversion: 1\nrequire:\n  - a${'b'.repeat(32)}\n\`\`\`\n` },
  { name: 'a duplicate id', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\nrequire:\n  - validate\n  - validate\n```\n' },
  { name: 'more than 32 ids', code: 'acceptance_gate_block_invalid',
    body: `\`\`\`acceptance-gates\nversion: 1\nrequire:\n${Array.from({ length: 33 }, (_, index) => `  - gate-${index}`).join('\n')}\n\`\`\`\n` },
  // Both refuse it, with the same code, for the same reason — but the sentences
  // differ: the consumer's names `gates:` as the other way to fill the block, and
  // the producer has no such key to offer. That one wording is inside the
  // PRODUCER_LAG patch that records it, so comparing the code (rather than the
  // whole answer) here is not a hole: it is the same difference, counted once.
  { name: 'an empty block declares a requirement and names none', code: 'acceptance_gate_block_invalid',
    laggedReason: true,
    body: '```acceptance-gates\nversion: 1\nrequire:\n```\n' },
  { name: 'an unknown key', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\nexpect_exit: 1\n```\n' },
  { name: 'a document marker', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\n---\nversion: 1\nrequire:\n  - validate\n```\n' },
  { name: 'the block is never closed', code: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\nrequire:\n  - validate\n' },
];

// The corpus for the ONE key the two sides read differently (Issue #125). Every
// case states both answers, so "they disagree" is a fact this file records rather
// than a hole it leaves. `consumer` is what the planner returns — an accepted
// block or the code it refuses with; `producer` is always the same refusal,
// because the producing packages do not emit `gates:` at all yet.
//
// The consumer's refusals are here for the same reason the shared corpus has a
// negative half: `gates:` is where a definition is checked against CommandMate's
// own gate rules (reserved ids, a command that must exist, the timeout range),
// and a reader of this file should be able to see which of those the planner
// enforces without opening it.
const GATES_KEY_CORPUS = [
  { name: 'a definition with a command and a timeout',
    consumer: 'accept',
    body: '```acceptance-gates\nversion: 1\ngates:\n  - id: issue-1-repro\n    command: "node scripts/repro.mjs"\n    timeoutSec: 300\n```\n' },
  { name: 'a definition alongside a require: list',
    consumer: 'accept',
    body: '```acceptance-gates\nversion: 1\nrequire:\n  - validate\ngates:\n  - id: issue-1-repro\n    command: "true"\n```\n' },
  { name: 'a bare (unquoted) command',
    consumer: 'accept',
    body: '```acceptance-gates\nversion: 1\ngates:\n  - id: issue-1-repro\n    command: test -f docs/adr.md\n```\n' },
  { name: 'a definition that names no command', consumer: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\ngates:\n  - id: issue-1-repro\n```\n' },
  { name: 'a reserved id', consumer: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\ngates:\n  - id: work-evidence\n    command: "true"\n```\n' },
  { name: 'a timeout outside 1..7200', consumer: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\ngates:\n  - id: issue-1-repro\n    command: "true"\n    timeoutSec: 7201\n```\n' },
  { name: 'an unknown key inside a gate', consumer: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\ngates:\n  - id: issue-1-repro\n    command: "true"\n    retries: 2\n```\n' },
  { name: 'an entry that does not open with its id', consumer: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\ngates:\n  - command: "true"\n    id: issue-1-repro\n```\n' },
  { name: 'the same id required and defined', consumer: 'acceptance_gate_block_invalid',
    body: '```acceptance-gates\nversion: 1\nrequire:\n  - issue-1-repro\ngates:\n  - id: issue-1-repro\n    command: "true"\n```\n' },
  { name: 'one gate past the combined bound', consumer: 'acceptance_gate_block_invalid',
    body: `\`\`\`acceptance-gates\nversion: 1\nrequire:\n${Array.from({ length: 32 }, (_, index) => `  - gate-${index}`).join('\n')}\ngates:\n  - id: issue-1-repro\n    command: "true"\n\`\`\`\n` },
];

// The ids the emitter is asked to render. A round trip through the consumer's own
// reader is what makes "this is the notation" a measurement instead of a claim.
const RENDER_CORPUS = [
  ['validate'],
  ['issue-authoring-fixtures', 'validate'],
  ['gate-1', '2nd-gate', 'a'],
  Array.from({ length: 32 }, (_, index) => `gate-${index}`),
];

// =============================================================================
// Corpus — the verify.yaml reader
// =============================================================================

const VERIFY_CORPUS = [
  { name: 'this repository\'s own verify.yaml', root: REPO_ROOT },
  { name: 'a minimal config', text: 'version: 1\ngates:\n  - id: only\n    command: "true"\n' },
  { name: 'quoted ids, comments, options and a nested id field', text: '# leading comment\nversion: "1"\ngates:\n  - id: \'first\'\n    command: "true"\n    timeoutSec: 60\n  - command: "true"\n    id: second\noptions:\n  baseRef: origin/main\n' },
  { name: 'no config at all', missing: true },
  { name: 'a tab', text: 'version: 1\ngates:\n\t- id: only\n' },
  { name: 'odd indentation', text: 'version: 1\ngates:\n   - id: only\n' },
  { name: 'no version', text: 'gates:\n  - id: only\n' },
  { name: 'a wrong version', text: 'version: 2\ngates:\n  - id: only\n' },
  { name: 'no gate at all', text: 'version: 1\noptions:\n  baseRef: origin/main\n' },
  { name: 'an unknown top-level key', text: 'version: 1\nprofiles:\n  - id: only\n' },
  { name: 'an inline value after gates:', text: 'version: 1\ngates: [only]\n' },
  { name: 'an indented line with nothing open', text: '  - id: only\nversion: 1\n' },
  { name: 'a gate id the pattern refuses', text: 'version: 1\ngates:\n  - id: Not-Valid\n    command: "true"\n' },
  { name: 'a list item that is not "- key: value"', text: 'version: 1\ngates:\n  - only\n' },
];

// =============================================================================
// Source extraction
// =============================================================================

class HarnessError extends Error {}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new HarnessError(`${relative(REPO_ROOT, path)} is not readable: ${error.message}`);
  }
}

const SOURCES = new Map();
function source(path) {
  if (!SOURCES.has(path)) SOURCES.set(path, read(path));
  return SOURCES.get(path);
}

// The declaration text of `const <name> = ...;`, which every compared constant is
// written as, on one line. A constant that stops being one line is a harness
// error rather than a silent skip.
function constantDeclaration(path, label, name) {
  const text = source(path);
  const single = new RegExp(`^const ${name} = (.*);$`, 'm');
  const match = single.exec(text);
  if (match) return match[1];
  if (new RegExp(`^const ${name}\\b`, 'm').test(text)) {
    throw new HarnessError(
      `${label}: ${name} is no longer a single-line \`const NAME = ...;\` declaration; ` +
        'teach this test how to read its new shape rather than dropping it',
    );
  }
  return null;
}

// The lines from the first line matching `startRe` up to, and not including, the
// first line after it matching `endRe`.
function region(path, label, startRe, endRe) {
  const lines = source(path).split('\n');
  const start = lines.findIndex((line) => startRe.test(line));
  if (start === -1) throw new HarnessError(`${label}: no line matches the region start ${startRe}`);
  const end = lines.findIndex((line, index) => index > start && endRe.test(line));
  if (end === -1) throw new HarnessError(`${label}: no line after ${start + 1} matches the region end ${endRe}`);
  return { text: lines.slice(start, end).join('\n'), first: start + 1, last: end };
}

// A top-level `function <name>(...) { ... }`, ended by the first line that is
// exactly `}` — which holds for every function compared here, all declared at
// module scope with two-space indentation inside.
function functionBlock(path, label, name) {
  const found = region(path, label, new RegExp(`^function ${name}\\(`), /^\}$/);
  return `${found.text}\n}`;
}

// Code only: comment-only lines and blank lines are where the mirror is expected
// to say different things (it explains that it IS a mirror), and where a byte
// comparison would otherwise turn into a prose comparison.
function codeOnly(text, renames = []) {
  let out = text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
    .join('\n');
  for (const [pattern, replacement] of renames) out = out.replace(pattern, replacement);
  return out;
}

function moduleUrl(text) {
  return `data:text/javascript;charset=utf-8;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
}

async function loadModule(text, label, where) {
  try {
    return await import(moduleUrl(text));
  } catch (error) {
    throw new HarnessError(
      `${label}: ${where} does not load as a module (${error.message}); the mirrored region has grown ` +
        'a dependency this harness does not supply',
    );
  }
}

function markdownFiles(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out.sort();
}

// =============================================================================
// Reporting
// =============================================================================

let passed = 0;
let failed = 0;

function pass(name) {
  passed += 1;
  process.stdout.write(`ok   ${name}\n`);
}

function fail(name, detail) {
  failed += 1;
  process.stdout.write(`FAIL ${name}\n     ${String(detail).split('\n').join('\n     ')}\n`);
}

function same(name, left, right, leftLabel, rightLabel) {
  if (left === right) pass(name);
  else fail(name, `${leftLabel}: ${left}\n${rightLabel}: ${right}`);
}

// =============================================================================
// Entry point
// =============================================================================

const PLANNER_EXPORT = `
export function readBlock(body) { return readAcceptanceGates(body); }
export function stripBlocks(text) { return stripAcceptanceGateBlocks(text); }
export function findBlocks(text) {
  return [...String(text).matchAll(ACCEPTANCE_GATES_BLOCK_RE)].map((match) => match[0]);
}
`;

const MIRROR_EXPORT = `
export function readBlock(body) { return plannerReadAcceptanceGates(body); }
export function stripBlocks(text) { return plannerStripAcceptanceGateBlocks(text); }
export function findBlocks(text) {
  return [...String(text).matchAll(ACCEPTANCE_GATES_BLOCK_RE)].map((match) => match[0]);
}
export function render(ids) { return renderAcceptanceGatesBlock(ids); }
`;

const VERIFY_EXPORT_PREAMBLE = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
`;

const VERIFY_EXPORT = `
export function gateIds(root) { return readGateIds(root); }
`;

async function main() {
  // ---- layer 1: the constants ----------------------------------------------
  for (const group of SHARED_CONSTANTS) {
    for (const name of group.names) {
      const theirs = constantDeclaration(group.file, group.label, name);
      const ours = constantDeclaration(MIRROR, 'mirror', name);
      const label = `constant ${name} is byte-identical to ${group.label}'s`;
      if (theirs === null || ours === null) {
        fail(label, `declared in ${group.label}: ${theirs !== null}, declared in mirror: ${ours !== null}; ` +
          'a mirrored constant that disappears from either side is drift, not an exemption');
        continue;
      }
      same(label, theirs, ours, group.label, 'mirror');
    }
  }
  for (const pair of CROSS_NAMED_CONSTANTS) {
    const left = constantDeclaration(pair.left.file, pair.left.label, pair.left.name);
    const right = constantDeclaration(pair.right.file, pair.right.label, pair.right.name);
    const label = `${pair.left.label} ${pair.left.name} equals mirror ${pair.right.name}`;
    if (left === null || right === null) {
      fail(label, `declared on the left: ${left !== null}, on the right: ${right !== null}`);
      continue;
    }
    same(label, left, right, pair.left.label, 'mirror');
  }

  // ---- layer 2: the function bodies ----------------------------------------
  for (const pair of MIRRORED_FUNCTIONS) {
    const left = codeOnly(functionBlock(pair.left.file, pair.left.label, pair.left.name));
    const right = codeOnly(functionBlock(pair.right.file, pair.right.label, pair.right.name), pair.renames);
    const label = `${pair.right.name} is a verbatim copy of ${pair.left.label}'s ${pair.left.name}`;
    if (left === right) pass(label);
    else fail(label, `${pair.left.label}:\n${left}\n\nmirror (renames applied):\n${right}`);
  }

  // ---- layer 2b: the ONE function that diverged, and exactly how ------------
  {
    const lag = PRODUCER_LAG;
    // Trailing newlines make each patch a whole-line region, so a patch can never
    // match half of a line it was not written for.
    let patched = `${codeOnly(functionBlock(lag.left.file, lag.left.label, lag.left.name))}\n`;
    const expected = `${codeOnly(functionBlock(lag.right.file, lag.right.label, lag.right.name), lag.renames)}\n`;
    let applied = true;
    for (const patch of lag.patches) {
      const label = `producer lag: ${patch.what}`;
      const occurrences = patched.split(patch.planner).length - 1;
      if (occurrences !== 1) {
        fail(label, `the planner's ${lag.left.name} carries this region ${occurrences} time(s), not once:\n${patch.planner}\n` +
          'the two implementations moved apart somewhere this file does not describe; update the patch (or delete it, ' +
          'if the producer has caught up) rather than widening what counts as "the same"');
        applied = false;
        continue;
      }
      patched = patched.replace(patch.planner, patch.mirror);
      pass(label);
    }
    const label = `${lag.right.name} is ${lag.left.label}'s ${lag.left.name} with only the recorded divergences`;
    if (!applied) fail(label, 'a patch did not apply, so the remainder could not be compared');
    else if (patched === expected) pass(label);
    else fail(label, `planner (patched):\n${patched}\nmirror (renames applied):\n${expected}`);
  }

  // ---- the modules ---------------------------------------------------------
  const plannerBlockRegion = region(PLANNER, 'planner', /^const ACCEPTANCE_GATES_INFO\b/, /^\/\/ Topic tokens power/);
  const mirrorBlockRegion = region(MIRROR, 'mirror', /^const ACCEPTANCE_GATES_INFO\b/, /^\/\/ ---- the block this package emits/);
  const dispatchVerifyRegion = region(DISPATCH, 'dispatch', /^const VERIFY_CONFIG_RELATIVE\b/, /^\/\/ The `require:` list of one plan issue/);
  const mirrorVerifyRegion = region(MIRROR, 'mirror', /^const VERIFY_CONFIG_RELATIVE\b/, /^\/\/ Planner mirror$/);

  const plannerBlocks = await loadModule(
    [plannerBlockRegion.text, PLANNER_EXPORT].join('\n'),
    'planner',
    `lines ${plannerBlockRegion.first}-${plannerBlockRegion.last}`,
  );
  const mirrorBlocks = await loadModule(
    [
      mirrorBlockRegion.text,
      functionBlock(MIRROR, 'mirror', 'renderAcceptanceGatesBlock'),
      MIRROR_EXPORT,
    ].join('\n'),
    'mirror',
    `lines ${mirrorBlockRegion.first}-${mirrorBlockRegion.last}`,
  );
  const dispatchVerify = await loadModule(
    [
      VERIFY_EXPORT_PREAMBLE,
      `const GATE_ID_RE = ${constantDeclaration(DISPATCH, 'dispatch', 'GATE_ID_RE')};`,
      dispatchVerifyRegion.text,
      'const readGateIds = readWorktreeGateIds;',
      VERIFY_EXPORT,
    ].join('\n'),
    'dispatch',
    `lines ${dispatchVerifyRegion.first}-${dispatchVerifyRegion.last}`,
  );
  const mirrorVerify = await loadModule(
    [
      VERIFY_EXPORT_PREAMBLE,
      `const ACCEPTANCE_GATE_ID_RE = ${constantDeclaration(MIRROR, 'mirror', 'ACCEPTANCE_GATE_ID_RE')};`,
      mirrorVerifyRegion.text,
      'const readGateIds = checkoutGateIds;',
      VERIFY_EXPORT,
    ].join('\n'),
    'mirror',
    `lines ${mirrorVerifyRegion.first}-${mirrorVerifyRegion.last}`,
  );

  process.stdout.write(
    `     block reader:   ${relative(REPO_ROOT, PLANNER)}:${plannerBlockRegion.first}-${plannerBlockRegion.last}` +
      ` vs ${relative(REPO_ROOT, MIRROR)}:${mirrorBlockRegion.first}-${mirrorBlockRegion.last}\n` +
      `     verify.yaml:    ${relative(REPO_ROOT, DISPATCH)}:${dispatchVerifyRegion.first}-${dispatchVerifyRegion.last}` +
      ` vs ${relative(REPO_ROOT, MIRROR)}:${mirrorVerifyRegion.first}-${mirrorVerifyRegion.last}\n`,
  );

  // ---- layer 3a: the block reader over a corpus ----------------------------
  for (const item of [...BLOCK_CORPUS, ...BLOCK_REFUSALS]) {
    let left;
    let right;
    try {
      left = plannerBlocks.readBlock(item.body);
      right = mirrorBlocks.readBlock(item.body);
    } catch (error) {
      fail(`block: ${item.name}`, `the reader threw: ${error.message}`);
      continue;
    }
    const shown = (value) => (item.laggedReason ? { gates: value.gates, code: value.error?.code ?? null } : value);
    const leftJson = JSON.stringify(shown(left), null, 2);
    const rightJson = JSON.stringify(shown(right), null, 2);
    if (leftJson !== rightJson) {
      fail(`block: ${item.name}`, `planner:\n${leftJson}\nmirror:\n${rightJson}`);
      continue;
    }
    const stripLeft = plannerBlocks.stripBlocks(item.body);
    const stripRight = mirrorBlocks.stripBlocks(item.body);
    if (stripLeft !== stripRight) {
      fail(`block: ${item.name}`, `strip differs:\nplanner: ${JSON.stringify(stripLeft)}\nmirror:  ${JSON.stringify(stripRight)}`);
      continue;
    }
    if (item.code !== undefined) {
      if (left.gates !== null) {
        fail(`block: ${item.name}`, `expected a refusal with ${item.code}, but the block was accepted`);
        continue;
      }
      if (left.error?.code !== item.code) {
        fail(`block: ${item.name}`, `expected ${item.code}, got ${left.error?.code}: ${left.error?.text}`);
        continue;
      }
    } else if (left.error !== null) {
      fail(`block: ${item.name}`, `expected acceptance, got ${left.error.code}: ${left.error.text}`);
      continue;
    }
    pass(`block: ${item.name}`);
  }

  // ---- layer 3a': the key they read differently ----------------------------
  for (const item of GATES_KEY_CORPUS) {
    const name = `gates: ${item.name}`;
    let consumer;
    let producer;
    try {
      consumer = plannerBlocks.readBlock(item.body);
      producer = mirrorBlocks.readBlock(item.body);
    } catch (error) {
      fail(name, `a reader threw: ${error.message}`);
      continue;
    }
    // The producer's answer is the same for every case: it does not emit this key
    // and refuses to resolve one. If that ever changes, it changes here first.
    if (producer.gates !== null || producer.error?.code !== 'acceptance_gate_block_unsupported') {
      fail(name, `the producer no longer refuses \`gates:\` with acceptance_gate_block_unsupported (got ${producer.error?.code ?? 'an accepted block'}); ` +
        'if it has caught up, this corpus and PRODUCER_LAG are what to retire');
      continue;
    }
    if (item.consumer === 'accept') {
      if (consumer.gates === null) {
        fail(name, `the planner refused a block it should read: ${consumer.error?.code}: ${consumer.error?.text}`);
        continue;
      }
      if (!Array.isArray(consumer.gates.gates) || consumer.gates.gates.length === 0) {
        fail(name, `the planner accepted the block but carried no definition: ${JSON.stringify(consumer.gates)}`);
        continue;
      }
    } else if (consumer.gates !== null) {
      fail(name, `expected the planner to refuse with ${item.consumer}, but the block was accepted`);
      continue;
    } else if (consumer.error?.code !== item.consumer) {
      fail(name, `expected ${item.consumer}, got ${consumer.error?.code}: ${consumer.error?.text}`);
      continue;
    }
    // Whatever they decide, they must agree on what the block IS: stripping it
    // out of a body is how both sides keep the prose extractors from reading gate
    // ids as acceptance criteria, and that half is not allowed to drift.
    const stripLeft = plannerBlocks.stripBlocks(item.body);
    const stripRight = mirrorBlocks.stripBlocks(item.body);
    if (stripLeft !== stripRight) {
      fail(name, `strip differs:\nplanner: ${JSON.stringify(stripLeft)}\nmirror:  ${JSON.stringify(stripRight)}`);
      continue;
    }
    pass(name);
  }

  // ---- layer 3b: the verify.yaml reader over a corpus -----------------------
  const workRoot = mkdtempSync(join(tmpdir(), 'cmate-gates-conformance.'));
  for (const item of VERIFY_CORPUS) {
    let root = item.root ?? null;
    if (root === null) {
      root = join(workRoot, item.name.replace(/[^a-z0-9]+/gi, '-'));
      if (!item.missing) {
        mkdirSync(join(root, '.commandmate'), { recursive: true });
        writeFileSync(join(root, '.commandmate', 'verify.yaml'), item.text, 'utf8');
      } else {
        mkdirSync(root, { recursive: true });
      }
    }
    let left;
    let right;
    try {
      left = dispatchVerify.gateIds(root);
      right = mirrorVerify.gateIds(root);
    } catch (error) {
      fail(`verify.yaml: ${item.name}`, `the reader threw: ${error.message}`);
      continue;
    }
    // The one documented difference is the word for the tree being read, which is
    // the rename this harness normalises everywhere else too.
    const normalise = (value) => JSON.stringify(value, null, 2).replace(/in the (worktree|checkout)/g, 'in the tree');
    same(`verify.yaml: ${item.name}`, normalise(left), normalise(right), 'dispatch', 'mirror');
  }

  // ---- layer 4a: what the producer emits IS the 正本's shape ----------------
  const notation = read(NOTATION);
  const notationBlocks = plannerBlocks.findBlocks(notation);
  if (notationBlocks.length === 0) {
    fail('the notation document carries at least one example block',
      'no ```acceptance-gates block was found in acceptance-gates-notation.md; the 正本 this test ' +
        'compares against has nothing in it to compare');
  } else {
    pass(`the notation document carries ${notationBlocks.length} example block(s)`);
  }
  notationBlocks.forEach((block, index) => {
    const name = `notation example ${index + 1} round-trips through the emitter`;
    const parsed = plannerBlocks.readBlock(block);
    if (parsed.gates === null) {
      fail(name, `the 正本's own example is refused by the planner: ${parsed.error?.text}`);
      return;
    }
    // An example that DEFINES a gate is one the producer cannot render (Issue
    // #125), so the round trip does not apply to it. What is asserted instead is
    // the pair of facts that make the lag legible: the consumer reads the 正本's
    // own example, and the producer refuses it for the one recorded reason.
    if (parsed.gates.gates !== undefined) {
      const refusal = mirrorBlocks.readBlock(block).error?.code;
      if (refusal === 'acceptance_gate_block_unsupported') {
        pass(`notation example ${index + 1} declares gates: — read by the consumer, refused by the emitter`);
      } else {
        fail(`notation example ${index + 1} declares gates: — read by the consumer, refused by the emitter`,
          `the producer answered ${refusal ?? 'by accepting it'}; if it has learned to emit \`gates:\`, teach this ` +
            'test to round-trip the definition instead of skipping it');
      }
      return;
    }
    const rendered = mirrorBlocks.render(parsed.gates.require);
    const written = block.endsWith('\n') ? block : `${block}\n`;
    same(name, written, rendered, 'notation', 'emitter');
  });

  // The notation states the id pattern and the bound in prose. A producer that
  // read the document instead of the code has to arrive at the same values.
  const idPattern = constantDeclaration(MIRROR, 'mirror', 'ACCEPTANCE_GATE_ID_RE');
  const idSource = idPattern.slice(1, idPattern.lastIndexOf('/'));
  for (const [what, literal] of [
    ['the gate id pattern', idSource],
    ['the id bound', constantDeclaration(MIRROR, 'mirror', 'MAX_ACCEPTANCE_GATE_IDS')],
    ['the info string', 'acceptance-gates'],
  ]) {
    const name = `the notation document states ${what} the code uses (${literal})`;
    if (notation.includes(literal)) pass(name);
    else fail(name, `the document does not contain ${JSON.stringify(literal)}; prose and code disagree`);
  }

  // ---- layer 4b: every block the producing packages ship --------------------
  for (const root of PRODUCERS) {
    const packageName = relative(REPO_ROOT, root);
    let found = 0;
    for (const file of markdownFiles(root)) {
      const text = read(file);
      const blocks = plannerBlocks.findBlocks(text);
      for (const [index, block] of blocks.entries()) {
        found += 1;
        const where = `${relative(REPO_ROOT, file)} block ${index + 1}`;
        const parsed = plannerBlocks.readBlock(block);
        if (parsed.gates === null) {
          fail(`${where} is read by the planner`, parsed.error?.text ?? 'refused');
          continue;
        }
        if (/^gates:/m.test(block)) {
          fail(`${where} declares no gates:`, 'the producing packages must not emit `gates:`; it is valid ' +
            'notation that no release enforces, so an Issue carrying it stops at dispatch');
          continue;
        }
        const rendered = mirrorBlocks.render(parsed.gates.require);
        const written = block.endsWith('\n') ? block : `${block}\n`;
        same(`${where} is the canonical rendering`, written, rendered, 'shipped', 'emitter');
      }
    }
    if (found === 0) {
      fail(`${packageName} documents the notation`,
        'no ```acceptance-gates block is shipped anywhere in this package, so nothing here tells an ' +
          'author what to emit and this test compared nothing');
    } else {
      pass(`${packageName} ships ${found} block(s), all conforming`);
    }
  }

  // ---- layer 4c: the emitter's output is read back unchanged ---------------
  for (const ids of RENDER_CORPUS) {
    const name = `the emitter round-trips [${ids.length > 3 ? `${ids.length} ids` : ids.join(', ')}]`;
    const rendered = mirrorBlocks.render(ids);
    const parsed = plannerBlocks.readBlock(rendered);
    same(name, JSON.stringify({ version: 1, require: ids }), JSON.stringify(parsed.gates), 'emitted', 'planner read');
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  return failed === 0 ? EXIT_SYNCED : EXIT_DRIFTED;
}

try {
  process.exit(await main());
} catch (error) {
  if (error instanceof HarnessError) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(EXIT_ERROR);
  }
  throw error;
}
