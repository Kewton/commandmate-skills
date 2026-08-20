#!/usr/bin/env node
// A stand-in for an acceptance gate, for the `--evaluate-gates` cases (Issue
// #218). Copied into each case's temporary checkout by run_tests.mjs and
// committed there, so the tree the runner measures is clean and the command the
// issue declares (`node gate-fake.mjs <spec> <tag>`) resolves from the repo root.
//
// It exists to make two things measurable that a real gate cannot:
//
//   THE CALL RECORD. Every invocation appends its tag to $CMATE_GATE_FAKE_LOG,
//   OUTSIDE the checkout. That file is how the dirty-tree case proves the claim
//   that matters there — not "the runner exited 3", but "and it ran nothing".
//
//   A GATE THAT CHANGES ITS MIND. `flip` passes the first time and fails after,
//   which is the shape of the acceptance condition measured in CommandMate#1832
//   (a sha256 over output carrying `判定時刻 : <ISO8601>`). No real command can
//   be relied on to do that on demand.
//
// Nothing here writes into the repository: a fake that dirtied the tree it was
// run in would break the very precondition the mode enforces.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [spec, tag] = process.argv.slice(2);
const log = process.env.CMATE_GATE_FAKE_LOG;
if (log === undefined || log === '') {
  process.stderr.write('CMATE_GATE_FAKE_LOG is not set; refusing to run untracked\n');
  process.exit(97);
}
if (tag === undefined) {
  process.stderr.write('usage: gate-fake.mjs <spec> <tag>\n');
  process.exit(96);
}

// How many times THIS tag has been called before now. Per-tag rather than
// per-file so two gates in one case cannot advance each other's counter.
const before = existsSync(log)
  ? readFileSync(log, 'utf8').split('\n').filter((line) => line === tag).length
  : 0;
appendFileSync(log, `${tag}\n`);

if (spec === 'pass') process.exit(0);
if (spec === 'fail') process.exit(1);
if (spec === 'flip') process.exit(before === 0 ? 0 : 1);
// Fails every time, with a DIFFERENT exit code each time: the verdict is stable
// and the measurement is not.
if (spec === 'codes') process.exit(before === 0 ? 1 : 2);
if (spec === 'hang') {
  // Long enough that no plausible machine finishes it inside the case's
  // timeoutSec, and short enough that a leaked child cannot outlive the suite.
  setTimeout(() => process.exit(0), 30000);
} else {
  process.stderr.write(`unknown spec ${spec}\n`);
  process.exit(98);
}
