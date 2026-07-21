#!/usr/bin/env node
// Fake CommandMate/git/gh CLI for the cmate-orchestrate dispatch and merge tests.
//
// dispatch.mjs shells out to `commandmate` (send/wait/capture/respond/verify),
// `git` (drift checks) and `gh` (repo access) via injectable --cli/--git/--gh.
// merge.mjs shells out to `git` (push) and `gh` (pr create/view/checks/merge)
// via injectable --git/--gh. Pointing all of them at this one script lets the
// fixtures drive the whole supervision and delivery loop deterministically and
// inject failures — without a real repository, a real worker, or the network.
// Subcommand names are disjoint across the tools, so a single dispatcher on argv
// is unambiguous.
//
// A PR number in this fake is always equal to its issue number, so that
// `pr view` (keyed by branch) and `pr checks`/`pr merge` (keyed by number) can
// look the same worker's behavior up by a single key.
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
function issueFromBranch(value) {
  const match = /issue-(\d+)/.exec(value ?? '');
  return match ? match[1] : null;
}
function workerSpec(spec, issue) {
  const workers = spec.workers ?? {};
  return workers[issue] ?? workers[String(issue)] ?? {};
}
function prSpec(spec, issue) {
  const prs = spec.prs ?? {};
  return prs[issue] ?? prs[String(issue)] ?? {};
}

// The fake is stateless across processes, so an auto-yes flow (respond, then
// wait again expecting completion) needs a marker on disk. CMATE_FAKE_STATE
// names a directory the harness gives each case.
function markerPath(issue) {
  const dir = process.env.CMATE_FAKE_STATE;
  return dir ? join(dir, `responded-${issue}`) : null;
}

// The UAT fix loop calls `commandmate uat` once per issue per attempt, all from a
// single uat.mjs process but as separate fake subprocesses. A per-issue counter
// on disk lets a scenario make an issue fail the first N assessments and pass the
// (N+1)-th — the fail -> fix -> pass path — or fail forever (the blocked path).
function uatCountPath(issue) {
  const dir = process.env.CMATE_FAKE_STATE;
  return dir ? join(dir, `uat-count-${issue}`) : null;
}
function bumpUatCount(issue) {
  const path = uatCountPath(issue);
  if (!path) return 1;
  let count = 0;
  try {
    if (existsSync(path)) count = Number.parseInt(readFileSync(path, 'utf8'), 10) || 0;
  } catch {
    count = 0;
  }
  count += 1;
  try {
    writeFileSync(path, String(count));
  } catch {
    // best effort; a scenario with no state dir simply cannot vary by attempt
  }
  return count;
}
function uatSpec(spec, issue) {
  const uat = spec.uat ?? {};
  return uat[issue] ?? uat[String(issue)] ?? {};
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
    const action = argv[1] ?? '';
    if (action === 'add') {
      // `git worktree add <dir> -b <branch> <sha>` from uat.mjs's fix loop.
      const issue = issueFromBranch(optionValue('-b'));
      const worker = workerSpec(spec, issue);
      if (worker.worktree_add === 'fail') fail('fatal: could not create work tree: directory already exists');
      process.stdout.write(`Preparing worktree (new branch '${optionValue('-b')}')\nHEAD is now at ${(argv[argv.length - 1] || 'deadbeef').slice(0, 8)}\n`);
      process.exit(0);
    }
    // `worktree list --porcelain`. Absent from the scenario means "all present":
    // echo the planned targets is impossible here, so emit a generic listing the
    // dispatcher's substring check will accept unless the scenario overrides it.
    const git = spec.git ?? {};
    const lines = (git.worktrees ?? ['<all>']).map((w) => `worktree ${w}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(0);
  }
  if (sub === 'merge') {
    // `git merge --no-ff --no-edit <branch>` from uat.mjs's re-merge of a fix.
    const issue = issueFromBranch(argv[argv.length - 1]);
    const worker = workerSpec(spec, issue);
    if (worker.remerge === 'conflict') fail('CONFLICT (content): Merge conflict in some/file.ts\nAutomatic merge failed; fix conflicts and then commit the result.');
    process.stdout.write(`Merge made by the 'ort' strategy.\n`);
    process.exit(0);
  }
  if (sub === 'push') {
    // `git push --set-upstream origin <branch>` from merge.mjs --create-prs.
    const branch = argv[argv.length - 1];
    const pr = prSpec(spec, issueFromBranch(branch));
    if (pr.push === 'fail') fail('fatal: failed to push some refs');
    process.stdout.write(`Branch '${branch}' set up to track 'origin/${branch}'.\n`);
    process.exit(0);
  }

  // --- gh repo access probe ------------------------------------------------
  if (sub === 'repo') {
    const gh = spec.gh ?? {};
    if (gh.repo_access === false) fail('gh: could not resolve repository');
    emit({ nameWithOwner: gh.name ?? 'Kewton/CommandMate' });
  }

  // --- gh pull-request lifecycle (merge.mjs) -------------------------------
  if (sub === 'pr') {
    const action = argv[1] ?? '';
    if (action === 'create') {
      const issue = issueFromBranch(optionValue('--head'));
      const pr = prSpec(spec, issue);
      if (pr.create === 'fail') fail('pull request create failed: a PR already exists or the branch is unpushed');
      const repo = optionValue('--repo') ?? 'Kewton/CommandMate';
      process.stdout.write(`https://github.com/${repo}/pull/${issue}\n`);
      process.exit(0);
    }
    if (action === 'view') {
      const branch = argv[2];
      const issue = issueFromBranch(branch);
      const pr = prSpec(spec, issue);
      const state = (pr.view_state ?? 'OPEN').toUpperCase();
      if (state === 'MISSING') fail('no pull requests found for branch');
      const repo = 'Kewton/CommandMate';
      emit({ number: Number(issue), url: `https://github.com/${repo}/pull/${issue}`, state });
    }
    if (action === 'checks') {
      const number = argv[2];
      const pr = prSpec(spec, number);
      // Default: a single green check. A scenario injects a failing/pending run.
      emit(pr.checks ?? [{ name: 'build', state: 'SUCCESS' }]);
    }
    if (action === 'merge') {
      const number = argv[2];
      const pr = prSpec(spec, number);
      if (pr.merge === 'conflict') fail('failed to merge: merge conflict between base and head');
      if (pr.merge === 'blocked') fail('failed to merge: required status checks or reviews are missing');
      process.stdout.write(`Merged pull request #${number}\n`);
      process.exit(0);
    }
    fail(`fake-cli: unknown pr action "${action}"`);
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
  if (sub === 'uat') {
    // `commandmate uat --json --task task-<n>` from uat.mjs. A scenario controls
    // the acceptance outcome, optionally varying it by attempt via a disk counter.
    const issue = issueFromTask(optionValue('--task'));
    const uat = uatSpec(spec, issue);
    const count = bumpUatCount(issue);
    let outcome;
    if (typeof uat === 'string') {
      outcome = uat === 'pass' ? 'pass' : 'fail';
    } else if (typeof uat.pass_on === 'number') {
      // Fail every assessment before the pass_on-th, then pass from it onward.
      outcome = count >= uat.pass_on ? 'pass' : 'fail';
    } else if (uat.outcome !== undefined) {
      outcome = uat.outcome === 'pass' ? 'pass' : 'fail';
    } else {
      outcome = 'pass';
    }
    const version = uat.report_version !== undefined ? uat.report_version : 1;
    emit({ report_schema_version: version, outcome, scenarios: uat.scenarios ?? ['acceptance'] });
  }

  fail(`fake-cli: unknown subcommand "${sub}"`);
}

main();
