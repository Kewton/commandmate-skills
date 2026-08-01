// Render a split plan into the `--issue-json` fixture cmate-orchestrate reads.
//
//   node to-issue-json.mjs <split-plan.json>
//
// This is exactly what Phase 2 does to a body before posting it, minus the
// posting: keys are assigned numbers in dependency-respecting plan order, and
// every {{issue:<key>}} placeholder becomes #<number>. Feeding the result to the
// real planner is how the suite shows that a plan this Skill accepts produces
// Issues the planner can schedule without asking a blocking question.

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node to-issue-json.mjs <split-plan.json>\n');
  process.exit(2);
}

const plan = JSON.parse(readFileSync(file, 'utf8'));
const FIRST_NUMBER = 9000;

const numbers = new Map();
plan.issues.forEach((issue, index) => numbers.set(issue.key, FIRST_NUMBER + index));

const issues = plan.issues.map((issue) => ({
  number: numbers.get(issue.key),
  title: issue.title,
  body: issue.body.replace(/\{\{issue:([a-z0-9-]+)\}\}/g, (match, key) =>
    numbers.has(key) ? `#${numbers.get(key)}` : match,
  ),
  labels: issue.labels,
}));

process.stdout.write(`${JSON.stringify({ issues }, null, 2)}\n`);
