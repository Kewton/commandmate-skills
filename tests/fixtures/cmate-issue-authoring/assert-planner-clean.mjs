// Compare a split plan against the execution plan cmate-orchestrate produced
// from it.
//
//   node assert-planner-clean.mjs <split-plan.json> <execution-plan.json>
//
// Prints one `ok`/`FAIL` line per assertion and exits non-zero if any failed.
// The assertions are the acceptance target of this Skill stated mechanically:
// the planner asked nothing, it saw the acceptance criteria and the target files
// the plan declared, and the dependencies it recovered from the rendered bodies
// are the ones the plan declared — no more, no fewer.

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
  check(
    `planner asked nothing about ${issue.key}`,
    analyzed.questions.length === 0,
    `questions: ${JSON.stringify(analyzed.questions)}`,
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

process.exit(failed === 0 ? 0 : 1);
