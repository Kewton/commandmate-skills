#!/usr/bin/env node
// Conformance test: the `open-questions` block the PRODUCING package is told to
// build must be the block the CONSUMING package reads.
//
//   node tests/fixtures/cmate-issue-authoring/open-questions-conformance.mjs
//
// The 正本 is `skills/cmate-orchestrate/references/open-questions-notation.md`.
// Until Issue #198 the notation had a reader and no writer:
//
// | implementation | role |
// |---|---|
// | `cmate-orchestrate/scripts/orchestrate.mjs` | reads the block out of an Issue body and raises one blocking question per item |
// | `cmate-issue-refinement` | builds the block out of its blocking open questions, as `open_questions_block` |
//
// The producer is a package of INSTRUCTIONS — no `scripts/`, so there is no
// renderer to import and nothing to compare function bodies against. What holds
// the two sides together is therefore this file: the rule stated in
// `skills/cmate-issue-refinement/references/open-questions.md` is transcribed
// once, here, as `render()` and `blocking()`, and everything it produces is fed
// to the REAL planner. A rule copied into prose on the producing side would drift
// from the reader that enforces it; a rule executed against that reader cannot.
//
// It lives beside `acceptance-gates-conformance.mjs`, which is where producing-side
// notation conformance already lives (that file checks blocks shipped by BOTH
// producing packages, `cmate-issue-refinement` included), and runs from the same
// suite. `cmate-issue-authoring` does not emit this notation yet — that mirror is
// a separate Issue, and this file will grow a second producer when it lands.
//
// What is proved:
//
//  1. **The producer's prose states the values the consumer's code uses.** The
//     bound and the info string appear as literals in the rule document, so the
//     one number that has to be written twice cannot rot.
//  2. **Every block shipped in the producing package parses, and is the canonical
//     rendering of its own questions.** A documented example an author copies is
//     the producer's real output.
//  3. **The rule round-trips through the real parser over a corpus** — one
//     question, the bound exactly, a `#` mid-sentence, backticks, CJK — and comes
//     back as the same list in the same order.
//  4. **The constraints the rule names are load-bearing.** Every shape the rule
//     tells the producer not to emit is fed to the real parser and has to be
//     refused with `open_question_block_invalid`. A constraint nobody ever saw
//     stop anything is a sentence, not a constraint.
//  5. **The block is derived from `open_questions[]`**, by `blocks_required_section`
//     alone, in array order — and the result schema's own `open_questions_block`
//     pattern accepts exactly what the rule renders.
//  6. **End to end through the real planner binary**: a body carrying the block
//     comes back with one blocking question per item, verbatim and in order, and
//     the twin body with the block deleted comes back with none. Both halves, for
//     the reason the notation's §6 gives — a green-only fixture is not evidence
//     that a gate is doing anything.
//
// Exit status: 0 in sync, 1 drifted, 2 the test itself could not run (a region
// marker moved, a constant was renamed). "I could not look" must never read as
// "in sync".

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const PLANNER = resolve(REPO_ROOT, 'skills/cmate-orchestrate/scripts/orchestrate.mjs');
const NOTATION = resolve(REPO_ROOT, 'skills/cmate-orchestrate/references/open-questions-notation.md');
const PRODUCER = resolve(REPO_ROOT, 'skills/cmate-issue-refinement');
const PRODUCER_RULE = resolve(PRODUCER, 'references/open-questions.md');
const PRODUCER_SCHEMA = resolve(PRODUCER, 'schemas/refinement-result.v1.json');

const EXIT_SYNCED = 0;
const EXIT_DRIFTED = 1;
const EXIT_ERROR = 2;

// =============================================================================
// The producing rule, transcribed
// =============================================================================
//
// These two functions are `references/open-questions.md` in executable form, and
// they are the only copy of it in this repository. Change the document and this
// file changes with it in the same commit; everything below measures what they
// produce against the consumer, never against a second description of them.

// "one line per question — two spaces, `- `, then the question verbatim", with a
// final newline after the closing fence.
function render(questions) {
  return [
    '```open-questions',
    'version: 1',
    'questions:',
    ...questions.map((question) => `  - ${question}`),
    '```',
    '',
  ].join('\n');
}

// "an open question is blocking when `blocks_required_section` is true", in
// `open_questions[]` order, and nothing else decides it.
function blocking(openQuestions) {
  return openQuestions
    .filter((entry) => entry.blocks_required_section === true)
    .map((entry) => entry.question);
}

// =============================================================================
// Corpora
// =============================================================================

// Rendered, then read back by the planner. Each case makes one property of the
// rule observable; the interesting ones are the characters a generator is tempted
// to escape and must not.
const ROUND_TRIP = [
  { name: 'a single question', questions: ['Does the token rotate on read, or on write?'] },
  { name: 'two questions keep the array order', questions: ['B comes second', 'A comes first'] },
  { name: 'an issue reference mid-sentence keeps its #', questions: ['Do we keep the old API, or follow #63?'] },
  { name: 'a question that starts with an issue reference', questions: ['#63 decides this — do we wait for it?'] },
  { name: 'backticked paths survive unescaped', questions: ['Is `src/legacy/topo.ts` kept, or deleted in this Issue?'] },
  { name: 'quotes and colons survive unescaped', questions: ['Is "expired" measured at read time: yes or no?'] },
  { name: 'CJK text', questions: ['座標変換を保存時に行うか、描画時に行うか'] },
  { name: 'a hyphen at the start of the text', questions: ['- prefixed text is still one question'] },
  { name: 'the bound is reached exactly', questions: Array.from({ length: 32 }, (_, i) => `question number ${i + 1}`) },
];

// Shapes the rule tells the producer not to emit. Fed to the real parser: the
// refusal is the evidence that the rule is a constraint and not a preference.
const REFUSALS = [
  { name: 'no question at all', questions: [] },
  { name: 'an empty question', questions: ['a real question', ''] },
  { name: 'an exact duplicate', questions: ['the same sentence', 'the same sentence'] },
  { name: 'a question spanning two lines', questions: ['first line\nsecond line'] },
  { name: 'one past the bound', questions: Array.from({ length: 33 }, (_, i) => `question number ${i + 1}`) },
  ...['&', '*', '[', '{', '|', '>'].map((char) => ({
    name: `a question starting with ${char}`,
    questions: [`${char} reserved by YAML`],
  })),
];

// The projection layer: `open_questions[]` in, block out. `blocks_required_section`
// alone decides, and the array's order is kept.
const PROJECTION = [
  {
    name: 'only the blocking questions reach the block',
    open_questions: [
      { id: 'Q-001', question: 'blocking, and first', blocks_required_section: true },
      { id: 'Q-002', question: 'not blocking', blocks_required_section: false },
      { id: 'Q-003', question: 'blocking, and second', blocks_required_section: true },
    ],
    expected: ['blocking, and first', 'blocking, and second'],
  },
  {
    name: 'an absent flag is not blocking',
    open_questions: [
      { id: 'Q-001', question: 'flag absent' },
      { id: 'Q-002', question: 'flag true', blocks_required_section: true },
    ],
    expected: ['flag true'],
  },
  {
    name: 'nothing blocking means no block at all',
    open_questions: [{ id: 'Q-001', question: 'nothing blocks', blocks_required_section: false }],
    expected: [],
  },
];

// Strings the result schema's `open_questions_block` pattern must refuse. The
// field's promise is "paste it unchanged", so a document may not carry a shape a
// human would have to repair first.
const SCHEMA_REFUSALS = [
  { name: 'three-space indentation', text: '```open-questions\nversion: 1\nquestions:\n   - a\n```\n' },
  { name: 'a tab', text: '```open-questions\nversion: 1\nquestions:\n\t- a\n```\n' },
  { name: 'no version', text: '```open-questions\nquestions:\n  - a\n```\n' },
  { name: 'version is not the first key', text: '```open-questions\nquestions:\n  - a\nversion: 1\n```\n' },
  { name: 'an unknown version', text: '```open-questions\nversion: 2\nquestions:\n  - a\n```\n' },
  { name: 'no item', text: '```open-questions\nversion: 1\nquestions:\n```\n' },
  { name: 'no closing fence', text: '```open-questions\nversion: 1\nquestions:\n  - a\n' },
  { name: 'no trailing newline', text: '```open-questions\nversion: 1\nquestions:\n  - a\n```' },
  { name: 'prose around the block', text: 'see below\n\n```open-questions\nversion: 1\nquestions:\n  - a\n```\n' },
  { name: 'the wrong info string', text: '```open-questions-v2\nversion: 1\nquestions:\n  - a\n```\n' },
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

// The declaration text of a one-line `const <name> = ...;`. A constant that stops
// being one line is a harness error rather than a silent skip.
function constantDeclaration(path, label, name) {
  const text = source(path);
  const match = new RegExp(`^const ${name} = (.*);$`, 'm').exec(text);
  if (match) return match[1];
  throw new HarnessError(
    `${label}: no single-line \`const ${name} = ...;\` declaration; teach this test how to read its ` +
      'new shape rather than dropping it',
  );
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

async function loadModule(text, label, where) {
  const url = `data:text/javascript;charset=utf-8;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
  try {
    return await import(url);
  } catch (error) {
    throw new HarnessError(
      `${label}: ${where} does not load as a module (${error.message}); the region has grown a ` +
        'dependency this harness does not supply',
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
  else fail(name, `${leftLabel}: ${JSON.stringify(left)}\n${rightLabel}: ${JSON.stringify(right)}`);
}

// =============================================================================
// Entry point
// =============================================================================

const PLANNER_EXPORT = `
export function readBlock(body) { return readOpenQuestions(body); }
export function findBlocks(text) {
  return [...String(text).matchAll(OPEN_QUESTIONS_BLOCK_RE)].map((match) => match[0]);
}
`;

// A body the planner can plan, so the end-to-end half measures the block and not
// some unrelated question the planner would have raised anyway.
function issueBody(block) {
  return [
    'Move the facility coordinates onto the new coordinate system.',
    '',
    '## 対象ファイル',
    '',
    '- `src/geo.ts`',
    '',
    '## 受入条件',
    '',
    '- [ ] Facilities render on the new coordinate system',
    '',
    ...(block === null ? [] : [block]),
  ].join('\n');
}

function runPlanner(workRoot, runId, body) {
  const issuesPath = join(workRoot, `${runId}-issues.json`);
  writeFileSync(issuesPath, `${JSON.stringify({
    issues: [{ number: 9200, title: 'feat: move to the new coordinate system', body, labels: ['feature'] }],
  }, null, 2)}\n`, 'utf8');
  const runsDir = join(workRoot, 'runs');
  try {
    execFileSync('node', [
      PLANNER, '--issues', '9200', '--issue-json', issuesPath,
      '--runs-dir', runsDir, '--run-id', runId,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new HarnessError(
      `the planner failed on ${runId}: ${error.stderr ?? error.message}`,
    );
  }
  return JSON.parse(readFileSync(join(runsDir, runId, 'plan.json'), 'utf8'));
}

async function main() {
  const notation = read(NOTATION);
  const rule = read(PRODUCER_RULE);
  const schema = JSON.parse(read(PRODUCER_SCHEMA));

  const plannerRegion = region(PLANNER, 'planner', /^const OPEN_QUESTIONS_INFO\b/, /^\/\/ Topic tokens power/);
  const planner = await loadModule(
    [plannerRegion.text, PLANNER_EXPORT].join('\n'),
    'planner',
    `lines ${plannerRegion.first}-${plannerRegion.last}`,
  );
  process.stdout.write(
    `     block reader:   ${relative(REPO_ROOT, PLANNER)}:${plannerRegion.first}-${plannerRegion.last}\n` +
      `     producing rule: ${relative(REPO_ROOT, PRODUCER_RULE)}\n`,
  );

  const info = constantDeclaration(PLANNER, 'planner', 'OPEN_QUESTIONS_INFO').replace(/^'|'$/g, '');
  const bound = Number(constantDeclaration(PLANNER, 'planner', 'MAX_OPEN_QUESTIONS'));
  if (!Number.isInteger(bound) || bound < 1) {
    throw new HarnessError(`planner: MAX_OPEN_QUESTIONS is not an integer (${bound})`);
  }

  // ---- layer 1: the producer's prose states what the consumer's code uses ----
  for (const [what, literal, where, text] of [
    ['the bound', String(bound), 'the producing rule', rule],
    ['the info string', info, 'the producing rule', rule],
    ['the bound', String(bound), 'the 正本', notation],
    ['the info string', info, 'the 正本', notation],
  ]) {
    const name = `${where} states ${what} the code uses (${literal})`;
    if (text.includes(literal)) pass(name);
    else fail(name, `the document does not contain ${JSON.stringify(literal)}; prose and code disagree`);
  }
  const notationName = 'open-questions-notation.md';
  if (rule.includes(notationName)) pass(`the producing rule names the 正本 (${notationName})`);
  else {
    fail(`the producing rule names the 正本 (${notationName})`,
      'a document that mirrors a notation it does not own has to say where the notation lives, or the ' +
        'next author will extend it here');
  }

  // ---- layer 2: every block the producing package ships ---------------------
  let shipped = 0;
  for (const file of markdownFiles(PRODUCER)) {
    const blocks = planner.findBlocks(read(file));
    for (const [index, block] of blocks.entries()) {
      shipped += 1;
      const where = `${relative(REPO_ROOT, file)} block ${index + 1}`;
      const parsed = planner.readBlock(block);
      if (parsed.error !== null) {
        fail(`${where} is read by the planner`, parsed.error.text);
        continue;
      }
      const written = block.endsWith('\n') ? block : `${block}\n`;
      same(`${where} is the canonical rendering`, written, render(parsed.questions), 'shipped', 'rule');
    }
  }
  if (shipped === 0) {
    fail(`${relative(REPO_ROOT, PRODUCER)} documents the notation`,
      'no ```open-questions block is shipped anywhere in this package, so nothing here shows an author ' +
        'what to emit and this test compared nothing');
  } else {
    pass(`${relative(REPO_ROOT, PRODUCER)} ships ${shipped} block(s), all conforming`);
  }

  // ---- layer 3: the rule round-trips through the real parser -----------------
  const blockPattern = schema.properties?.open_questions_block?.pattern;
  if (typeof blockPattern !== 'string') {
    throw new HarnessError(
      'the result schema declares no string pattern for open_questions_block; the field this test ' +
        'measures is not in the contract it is supposed to be in',
    );
  }
  const blockRe = new RegExp(blockPattern, 'u');

  for (const item of ROUND_TRIP) {
    const rendered = render(item.questions);
    const parsed = planner.readBlock(rendered);
    if (parsed.error !== null) {
      fail(`round trip: ${item.name}`, `the planner refused what the rule renders: ${parsed.error.text}`);
      continue;
    }
    if (JSON.stringify(parsed.questions) !== JSON.stringify(item.questions)) {
      fail(`round trip: ${item.name}`,
        `rendered: ${JSON.stringify(item.questions)}\nplanner read: ${JSON.stringify(parsed.questions)}`);
      continue;
    }
    if (!blockRe.test(rendered)) {
      fail(`round trip: ${item.name}`,
        `the result schema's open_questions_block pattern refuses what the rule renders:\n${rendered}`);
      continue;
    }
    pass(`round trip: ${item.name}`);
  }

  // ---- layer 4: the constraints are load-bearing -----------------------------
  for (const item of REFUSALS) {
    const parsed = planner.readBlock(render(item.questions));
    if (parsed.error === null) {
      fail(`refusal: ${item.name}`,
        'the planner accepted a block the producing rule forbids; either the rule is stale or the ' +
          'constraint stopped existing');
      continue;
    }
    if (parsed.error.code !== 'open_question_block_invalid') {
      fail(`refusal: ${item.name}`, `expected open_question_block_invalid, got ${parsed.error.code}`);
      continue;
    }
    pass(`refusal: ${item.name}`);
  }

  // ---- layer 5: the projection, and the schema field ------------------------
  for (const item of PROJECTION) {
    const questions = blocking(item.open_questions);
    if (JSON.stringify(questions) !== JSON.stringify(item.expected)) {
      fail(`projection: ${item.name}`,
        `selected ${JSON.stringify(questions)}, expected ${JSON.stringify(item.expected)}`);
      continue;
    }
    if (questions.length === 0) {
      // "Omit the field entirely when none is blocking": the empty block is not a
      // representable value, and the planner is what says so.
      const parsed = planner.readBlock(render(questions));
      if (parsed.error === null) fail(`projection: ${item.name}`, 'an empty block was accepted');
      else pass(`projection: ${item.name}`);
      continue;
    }
    const parsed = planner.readBlock(render(questions));
    if (parsed.error !== null) {
      fail(`projection: ${item.name}`, `the planner refused the projection: ${parsed.error.text}`);
      continue;
    }
    same(`projection: ${item.name}`,
      JSON.stringify(parsed.questions), JSON.stringify(item.expected), 'planner read', 'expected');
  }

  // Past the bound the rule cuts at an item boundary and names what it cut. The
  // half a test can pin is that the cut list is what the consumer accepts and the
  // uncut one is not — the naming is a `limitations` entry, which is prose.
  const overflow = Array.from({ length: bound + 8 }, (_, i) => `question number ${i + 1}`);
  const cut = overflow.slice(0, bound);
  const cutParsed = planner.readBlock(render(cut));
  const uncutParsed = planner.readBlock(render(overflow));
  if (cutParsed.error === null && cutParsed.questions.length === bound && uncutParsed.error !== null) {
    pass(`past the bound, the first ${bound} are a block the planner reads and all ${overflow.length} are not`);
  } else {
    fail(`past the bound, the first ${bound} are a block the planner reads and all ${overflow.length} are not`,
      `cut: ${cutParsed.error?.text ?? `${cutParsed.questions.length} questions`}\n` +
        `uncut: ${uncutParsed.error?.text ?? 'accepted'}`);
  }

  for (const item of SCHEMA_REFUSALS) {
    const name = `the schema's open_questions_block pattern refuses ${item.name}`;
    if (blockRe.test(item.text)) {
      fail(name, `the pattern accepted a string a human would have to repair before pasting:\n${item.text}`);
    } else {
      pass(name);
    }
  }

  // The block is exactly the `blocks_required_section: true` subset, so a document
  // carrying one has to state that flag on every question. An optional flag would
  // let a stopping question fall out of the block silently.
  const conditional = (schema.allOf ?? []).some((entry) =>
    (entry.if?.required ?? []).includes('open_questions_block') &&
    (entry.then?.properties?.open_questions?.items?.required ?? []).includes('blocks_required_section'));
  if (conditional) {
    pass('the schema requires blocks_required_section once a block is present');
  } else {
    fail('the schema requires blocks_required_section once a block is present',
      'no allOf branch conditions on open_questions_block; the flag that decides membership of the ' +
        'block would stay optional in the document that carries it');
  }

  // The eleventh completion-check statement needs a representable id.
  const ccPattern = schema.properties?.completion_check?.items?.properties?.id?.pattern;
  if (typeof ccPattern === 'string' && new RegExp(ccPattern, 'u').test('CC-11')) {
    pass('the completion-check id pattern can express the eleventh statement');
  } else {
    fail('the completion-check id pattern can express the eleventh statement',
      `pattern is ${JSON.stringify(ccPattern)}, which cannot hold CC-11`);
  }

  // ---- layer 6: end to end, through the real planner binary ------------------
  const workRoot = mkdtempSync(join(tmpdir(), 'cmate-open-questions-conformance.'));
  const questions = [
    'Does the coordinate conversion happen on write, or on render?',
    'Is `src/legacy/topo.ts` kept, or deleted in this Issue?',
  ];
  const withBlock = runPlanner(workRoot, 'with-block', issueBody(render(questions)));
  const withoutBlock = runPlanner(workRoot, 'without-block', issueBody(null));

  const raised = (withBlock.issues[0]?.questions ?? []).filter((text) => text.includes('Question: "'));
  if (raised.length !== questions.length) {
    fail('the planner raises one blocking question per item',
      `expected ${questions.length}, got ${raised.length}: ${JSON.stringify(withBlock.issues[0]?.questions)}`);
  } else if (!questions.every((question, index) => raised[index].includes(`Question: "${question}"`))) {
    fail('the planner raises one blocking question per item',
      `verbatim and in order was expected; got ${JSON.stringify(raised)}`);
  } else {
    pass('the planner raises one blocking question per item, verbatim and in order');
  }

  const declared = (withBlock.warnings ?? []).filter((warning) => warning.code === 'open_question_declared');
  same('the plan carries one open_question_declared warning per item',
    declared.length, questions.length, 'warnings', 'items');

  const twinDeclared = (withoutBlock.warnings ?? []).filter((w) => w.code === 'open_question_declared');
  const twinQuestions = (withoutBlock.issues[0]?.questions ?? []).filter((t) => t.includes('Question: "'));
  if (twinDeclared.length === 0 && twinQuestions.length === 0) {
    pass('the same body without the block raises none of them');
  } else {
    fail('the same body without the block raises none of them',
      `warnings: ${twinDeclared.length}, questions: ${JSON.stringify(twinQuestions)}`);
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
