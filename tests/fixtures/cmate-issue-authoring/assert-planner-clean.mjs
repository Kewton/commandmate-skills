// Compare a split plan against the execution plan cmate-orchestrate produced
// from it.
//
//   node assert-planner-clean.mjs <split-plan.json> <execution-plan.json>
//
// Prints one `ok`/`FAIL` line per assertion and exits non-zero if any failed.
// The assertions are the acceptance target of this Skill stated mechanically:
// the planner asked nothing the plan had not already declared, it saw the
// acceptance criteria and the target files the plan declared, and the
// dependencies it recovered from the rendered bodies are the ones the plan
// declared — no more, no fewer.
//
// "nothing the plan had not already declared" is the exact wording, and it is
// not a weakening of "nothing" (Issue #209). An open question in
// `open_questions[]` whose `blocks` names an issue reaches that issue's body as
// an `open-questions` block, so the planner MUST raise it: that is the whole
// point of writing it down. What must not happen is a question the plan does not
// account for — an inference the planner drew about an absence — or a declared
// question the planner failed to raise, which would mean the body lost it. Both
// halves are checked below, verbatim and in order.

import { readFileSync } from 'node:fs';

const [splitPath, executionPath] = process.argv.slice(2);
if (!splitPath || !executionPath) {
  process.stderr.write('usage: node assert-planner-clean.mjs <split-plan.json> <execution-plan.json>\n');
  process.exit(2);
}

const split = JSON.parse(readFileSync(splitPath, 'utf8'));
const execution = JSON.parse(readFileSync(executionPath, 'utf8'));

const FIRST_NUMBER = 9000;
const numbers = new Map();
split.issues.forEach((issue, index) => numbers.set(issue.key, FIRST_NUMBER + index));

let failed = 0;
//: How many times the "a path named only inside an open question stays out of
//: scope" assertion actually had something to look at. A fixture that stops
//: naming a path inside a question would make that assertion vacuous, and a
//: vacuous assertion prints `ok` — so the count is asserted at the end.
let questionPathsSeen = 0;
function check(name, condition, detail) {
  if (condition) {
    process.stdout.write(`ok   ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`FAIL ${name}\n     ${detail}\n`);
  }
}

for (const issue of split.issues) {
  const number = numbers.get(issue.key);
  const analyzed = execution.issues.find((candidate) => candidate.number === number);
  if (!analyzed) {
    check(`planner analyzed ${issue.key}`, false, `#${number} is missing from the execution plan`);
    continue;
  }
  const declared = (split.open_questions ?? [])
    .filter((question) => (question.blocks ?? []).includes(issue.key))
    .map((question) => question.question);
  check(
    `planner asked exactly the ${declared.length} declared open question(s) about ${issue.key}`,
    analyzed.questions.length === declared.length &&
      declared.every((question, index) => analyzed.questions[index].includes(`Question: "${question}"`)),
    `declared: ${JSON.stringify(declared)}\n     questions: ${JSON.stringify(analyzed.questions)}`,
  );
  check(
    `planner read the objective of ${issue.key}`,
    analyzed.objective === issue.objective,
    `objective: ${JSON.stringify(analyzed.objective)}`,
  );
  check(
    `planner read every acceptance criterion of ${issue.key}`,
    issue.acceptance_criteria.every((criterion) => analyzed.acceptance_criteria.includes(criterion)),
    `acceptance_criteria: ${JSON.stringify(analyzed.acceptance_criteria)}`,
  );
  // A path named inside a declared open question is a path the author has NOT
  // decided to change. The planner strips the block before its path extractor
  // runs, so such a path must not reach `suspected_files` — which is the worker's
  // `scope.allow`. Asserted from the fixture side because "the block is stripped"
  // is exactly the kind of claim that stops being true quietly: without the strip
  // the fixture's `tests/auth/fixtures/replay.json` becomes a file the worker may
  // write, off a sentence saying nobody has decided whether it should exist.
  for (const path of declared.flatMap((question) =>
    [...question.matchAll(/`([^`\s]+\.[A-Za-z0-9]+)`/g)].map((match) => match[1]))) {
    if (issue.target_files.includes(path)) continue;
    questionPathsSeen += 1;
    check(
      `${path}, named only inside an open question, stays out of the scope of ${issue.key}`,
      !analyzed.suspected_files.includes(path),
      `suspected_files: ${JSON.stringify(analyzed.suspected_files)}`,
    );
  }
  check(
    `planner suspects every target file of ${issue.key}`,
    issue.target_files
      .filter((path) => !/^docs\//.test(path) && !/\.(md|rst|txt)$/i.test(path))
      .every((path) => analyzed.suspected_files.includes(path)),
    `suspected_files: ${JSON.stringify(analyzed.suspected_files)}`,
  );
}

const declared = new Set();
for (const issue of split.issues) {
  for (const target of issue.depends_on) {
    declared.add(`${numbers.get(issue.key)}->${numbers.get(target)}`);
  }
}
const recovered = new Set(execution.dependencies.map((edge) => `${edge.issue}->${edge.depends_on}`));
check(
  'planner recovered exactly the declared dependencies',
  declared.size === recovered.size && [...declared].every((edge) => recovered.has(edge)),
  `declared ${JSON.stringify([...declared])} vs recovered ${JSON.stringify([...recovered])}`,
);

// The `open_questions` risk factor counts the questions across every issue, so it
// is a second, independent reading of the same projection: it must appear exactly
// when the split plan declares blocking questions, and count the same number. A
// plan that declares none must still produce no factor at all — that half is the
// one this file asserted before Issue #209 and it has not been relaxed.
const declaredQuestions = split.issues.reduce(
  (sum, issue) =>
    sum + (split.open_questions ?? []).filter((question) => (question.blocks ?? []).includes(issue.key)).length,
  0,
);
const factor = (execution.risk?.factors ?? []).find((entry) => entry.code === 'open_questions');
check(
  `the plan carries the open_questions risk factor the split plan implies (${declaredQuestions})`,
  declaredQuestions === 0
    ? factor === undefined
    : factor !== undefined && factor.detail.includes(`${declaredQuestions} blocking question(s)`),
  `factor: ${JSON.stringify(factor)}`,
);

// Only meaningful for a plan that declares open questions at all — a minimal plan
// legitimately has none, and demanding one here would turn this file into a
// fixture requirement rather than an assertion about the planner.
if (declaredQuestions > 0) {
  check(
    'a declared open question names a path, so the scope assertion above had something to look at',
    questionPathsSeen > 0,
    'no declared question names a backticked path any more; the "stays out of scope" assertion is vacuous',
  );
}

process.exit(failed === 0 ? 0 : 1);
