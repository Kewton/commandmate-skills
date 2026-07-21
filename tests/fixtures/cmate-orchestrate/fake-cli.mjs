#!/usr/bin/env node
// Fake CommandMate/git/gh CLI for the cmate-orchestrate dispatch tests.
//
// dispatch.mjs shells out to `commandmate` (send/wait/capture/respond/verify),
// `git` (drift checks) and `gh` (repo access) via injectable --cli/--git/--gh.
// Pointing all three at this one script lets the fixtures drive the whole
// supervision loop deterministically and inject failures — without a real
// repository, a real worker, or the network. Subcommand names are disjoint
// across the three tools, so a single dispatcher on argv is unambiguous.
//
// Behavior is read from a scenario JSON whose path is in CMATE_FAKE_SCENARIO.
// Every invocation is also appended (as one JSON line: {sub, args}) to the file
// in CMATE_FAKE_LOG when set, so a test can prove, for example, that `respond`
// was never called on the human-required path.
//
// Node stdlib only. Not part of the release pipeline; used only by run_tests.mjs.

import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const sub = argv[0] ?? '';

function scenario() {
  const path = process.env.CMATE_FAKE_SCENARIO;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function logInvocation() {
  const path = process.env.CMATE_FAKE_LOG;
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ sub, args: argv.slice(1) })}\n`);
  } catch {
    // A logging failure must never change the emulated CLI's behavior.
  }
}

function optionValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

// Workers are keyed by issue number. The task id encodes the issue so that the
// stateless per-process fake can look a worker's behavior back up on wait/verify.
function issueFromPromptFile(value) {
  const match = /issue-(\d+)/.exec(value ?? '');
  return match ? match[1] : null;
}
function issueFromTask(value) {
  const match = /task-(\d+)/.exec(value ?? '');
  return match ? match[1] : null;
}
function workerSpec(spec, issue) {
  const workers = spec.workers ?? {};
  return workers[issue] ?? workers[String(issue)] ?? {};
}

// The fake is stateless across processes, so an auto-yes flow (respond, then
// wait again expecting completion) needs a marker on disk. CMATE_FAKE_STATE
// names a directory the harness gives each case.
function markerPath(issue) {
  const dir = process.env.CMATE_FAKE_STATE;
  return dir ? join(dir, `responded-${issue}`) : null;
}

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
  process.exit(0);
}
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function main() {
  logInvocation();
  const spec = scenario();

  // --- commandmate availability probe -------------------------------------
  if (sub === '--version') {
    if (spec.cli_available === false) fail('commandmate: not available');
    process.stdout.write(`${spec.cli_version ?? 'commandmate 0.11.0'}\n`);
    process.exit(0);
  }

  // --- git drift probes ----------------------------------------------------
  if (sub === 'rev-parse') {
    if (argv.includes('--verify')) {
      const git = spec.git ?? {};
      if (git.base_resolvable === false) fail('fatal: needed a single revision');
      process.stdout.write('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
      process.exit(0);
    }
    if (argv.includes('--abbrev-ref')) {
      const git = spec.git ?? {};
      process.stdout.write(`${git.branch ?? 'feature/integration'}\n`);
      process.exit(0);
    }
    process.stdout.write('deadbeef\n');
    process.exit(0);
  }
  if (sub === 'status') {
    const git = spec.git ?? {};
    process.stdout.write(git.dirty ? ' M some/file.ts\n' : '');
    process.exit(0);
  }
  if (sub === 'worktree') {
    // `worktree list --porcelain`. Absent from the scenario means "all present":
    // echo the planned targets is impossible here, so emit a generic listing the
    // dispatcher's substring check will accept unless the scenario overrides it.
    const git = spec.git ?? {};
    const lines = (git.worktrees ?? ['<all>']).map((w) => `worktree ${w}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(0);
  }

  // --- gh repo access probe ------------------------------------------------
  if (sub === 'repo') {
    const gh = spec.gh ?? {};
    if (gh.repo_access === false) fail('gh: could not resolve repository');
    emit({ nameWithOwner: gh.name ?? 'Kewton/CommandMate' });
  }

  // --- commandmate worker lifecycle ---------------------------------------
  if (sub === 'send') {
    const issue = issueFromPromptFile(optionValue('--prompt-file'));
    if (!issue) fail('send: could not determine issue');
    const worker = workerSpec(spec, issue);
    if (worker.send === 'fail') fail('send: worker dispatch refused');
    emit({ task_id: `task-${issue}`, state: 'running' });
  }
  if (sub === 'wait') {
    const issue = issueFromTask(optionValue('--task'));
    const worker = workerSpec(spec, issue);
    let state = worker.state ?? 'completed';
    // Once a prompt has been answered (auto-yes), the worker moves on.
    const marker = markerPath(issue);
    if (state === 'prompt' && marker && existsSync(marker)) state = 'completed';
    emit({ state, detail: worker.detail ?? 'ok' });
  }
  if (sub === 'capture') {
    const issue = issueFromTask(optionValue('--task'));
    const worker = workerSpec(spec, issue);
    emit({ prompt: worker.prompt ?? 'Proceed? [y/N]', excerpt: worker.prompt ?? 'Proceed? [y/N]' });
  }
  if (sub === 'respond') {
    // Reaching here at all is the thing the default path must never do.
    const issue = issueFromTask(optionValue('--task'));
    const marker = markerPath(issue);
    if (marker) {
      try {
        writeFileSync(marker, 'responded');
      } catch {
        // best effort; the wait fallback simply won't advance
      }
    }
    emit({ state: 'running' });
  }
  if (sub === 'verify') {
    const issue = issueFromTask(optionValue('--task'));
    const worker = workerSpec(spec, issue);
    if (worker.verify_version !== undefined) {
      emit({ report_schema_version: worker.verify_version, outcome: worker.verify ?? 'pass', checks: ['baseline'] });
    }
    emit({ report_schema_version: 1, outcome: worker.verify ?? 'pass', checks: ['baseline'] });
  }

  fail(`fake-cli: unknown subcommand "${sub}"`);
}

main();
