// Compare the acceptance-gates block a split plan wrote into a body against what
// the real cmate-orchestrate planner read out of it.
//
//   node assert-planner-gates.mjs <split-plan.json> <execution-plan.json>
//
// The producer's whole claim is that the notation it emits is the notation the
// consumer reads. `acceptance-gates-conformance.mjs` pins that at the source
// level (constants, function bodies, corpus); this pins it end to end: the plan
// is rendered the way Phase 2 renders it, fed to the actual planner, and the
// `acceptance_gates` field that comes out has to be the block that went in — same
// ids, same ORDER, because the contract is a copy of what the Issue wrote and not
// a re-encoding of it (notation section 3).
//
// The expected value is extracted here by a deliberately dumb line reader rather
// than by importing either implementation. A third reader that agrees with both
// is evidence; a test that asks one implementation to confirm itself is not.
//
// Prints one ok/FAIL line per assertion and exits non-zero if any failed.

import { readFileSync } from 'node:fs';

const [splitPath, executionPath] = process.argv.slice(2);
if (!splitPath || !executionPath) {
  process.stderr.write('usage: node assert-planner-gates.mjs <split-plan.json> <execution-plan.json>\n');
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

// Everything between the opening fence and the next line that is exactly ```,
// read as "version: N" plus "  - id" lines. No tolerance, no repair: this reader
// exists to state what a human sees in the body, so a body that needs cleverness
// to read is a body this test should not be able to call conforming.
function blockInBody(body) {
  const lines = String(body).split('\n');
  const open = lines.indexOf('```acceptance-gates');
  if (open === -1) return null;
  const close = lines.indexOf('```', open + 1);
  if (close === -1) return { broken: 'the block is never closed' };
  const inner = lines.slice(open + 1, close);
  if (inner[0] !== 'version: 1') return { broken: `the first line is ${JSON.stringify(inner[0])}` };
  if (inner[1] !== 'require:') return { broken: `the second line is ${JSON.stringify(inner[1])}` };
  const require = [];
  for (const line of inner.slice(2)) {
    if (!line.startsWith('  - ')) return { broken: `${JSON.stringify(line)} is not a "  - id" item` };
    require.push(line.slice(4));
  }
  if (require.length === 0) return { broken: 'the block requires no gate' };
  return { version: 1, require };
}

for (const issue of split.issues) {
  const number = numbers.get(issue.key);
  const analyzed = execution.issues.find((candidate) => candidate.number === number);
  if (!analyzed) {
    check(`planner analyzed ${issue.key}`, false, `#${number} is missing from the execution plan`);
    continue;
  }

  const expected = blockInBody(issue.body);
  if (expected !== null && expected.broken) {
    check(`the body of ${issue.key} carries a readable block`, false, expected.broken);
    continue;
  }

  check(
    `planner read the block of ${issue.key} exactly as written`,
    JSON.stringify(analyzed.acceptance_gates) === JSON.stringify(expected),
    `body declares ${JSON.stringify(expected)}, planner produced ${JSON.stringify(analyzed.acceptance_gates)}`,
  );

  // A block the planner refused shows up as a question, never as a silent null —
  // which is exactly why null alone is not evidence that the body had no block.
  check(
    `planner raised no acceptance-gate question about ${issue.key}`,
    !analyzed.questions.some((question) => question.includes('acceptance-gates')),
    `questions: ${JSON.stringify(analyzed.questions)}`,
  );
}

const gateWarnings = (execution.warnings ?? []).filter((warning) =>
  String(warning.code ?? '').startsWith('acceptance_gate'),
);
check(
  'the plan carries no acceptance-gate warning',
  gateWarnings.length === 0,
  `warnings: ${JSON.stringify(gateWarnings)}`,
);

process.exit(failed === 0 ? 0 : 1);
