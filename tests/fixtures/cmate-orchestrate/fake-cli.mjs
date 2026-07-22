#!/usr/bin/env node
// Fake CommandMate/git/gh CLI for the cmate-orchestrate dispatch/merge/uat tests.
//
// The runners shell out to `commandmate` (ls/send/wait/capture/respond), `git`
// (drift checks, fix worktrees, re-merge) and `gh` (repo access, PR lifecycle)
// via injectable --cli/--git/--gh. Pointing all of them at this one script lets
// the fixtures drive the whole supervision/delivery/UAT loop deterministically
// and inject failures — without a real repository, a real worker, or the network.
// Subcommand names are disjoint across the tools, so a single dispatcher on argv
// is unambiguous.
//
// Contract parity (Issue #1467): every `commandmate` invocation is validated
// against commandmate-cli-contract.json (the real CLI surface transcribed from
// `commandmate <cmd> --help`). A subcommand or flag the real CLI does not accept
// makes the fake exit non-zero — so a runner that reaches for a fictional flag
// fails the suite here, not only in production. The real CLI is worktree-id based:
// `send <worktree-id> <message>`, `wait <worktree-ids...>`, `capture <worktree-id>
// --json`, `respond <worktree-id> <answer>`, `ls --json`. There is no `--json
// --worktree --prompt-file` on send, no `--task` anywhere, and no `verify`/`uat`
// subcommand. `wait` signals state by EXIT CODE (0 completed, 10 prompt, 124
// timeout), printing prompt JSON to stdout on a prompt.
//
// Verification/UAT is NOT a commandmate call in the real CLI: the runners run the
// profile baseline inside the worktree. The tests model that with the node-fake
// profile whose baseline is `cat cmate-verify-ok`, so a worktree "passes" iff it
// contains that marker file. This fake writes the marker into a fix worktree it
// creates when the scenario says that fix should succeed.
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

import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const sub = argv[0] ?? '';

// The marker file the node-fake profile's baseline (`cat cmate-verify-ok`) reads.
// Present in a worktree => that worktree's baseline passes.
const VERIFY_MARKER = 'cmate-verify-ok';

// commandmate subcommands this fake emulates. Only these are contract-checked.
const COMMANDMATE_SUBS = new Set(['ls', 'send', 'wait', 'capture', 'respond']);

// wait exit codes (mirror the real CLI's WaitExitCode).
const WAIT_COMPLETED = 0;
const WAIT_PROMPT = 10;
const WAIT_TIMEOUT = 124;
const WAIT_FAILED = 1;

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

// Contract parity: reject any commandmate flag the real CLI does not accept.
function enforceContract() {
  if (!COMMANDMATE_SUBS.has(sub)) return;
  let contract;
  try {
    contract = JSON.parse(readFileSync(join(HERE, 'commandmate-cli-contract.json'), 'utf8'));
  } catch {
    return; // no contract on disk => skip enforcement rather than mis-fail
  }
  const spec = contract.subcommands?.[sub];
  if (!spec) {
    process.stderr.write(`fake-cli: contract violation: commandmate has no subcommand "${sub}"\n`);
    process.exit(2);
  }
  const allowed = new Set(spec.flags ?? []);
  for (const token of argv.slice(1)) {
    if (typeof token !== 'string' || !token.startsWith('--')) continue;
    const flag = token.split('=')[0];
    if (!allowed.has(flag)) {
      process.stderr.write(`fake-cli: contract violation: commandmate ${sub} does not accept ${flag}\n`);
      process.exit(2);
    }
  }
}

// Workers are keyed by issue number. Every worktree id the runner uses carries
// the issue in its slug (…issue-<n>…), so a stateless per-process fake can look a
// worker's behavior back up from the id it was handed.
function issueFromId(value) {
  const match = /issue-(\d+)/.exec(value ?? '');
  return match ? match[1] : null;
}
function issueFromBranch(value) {
  const match = /issue-(\d+)/.exec(value ?? '');
  return match ? match[1] : null;
}
// Fix worktrees/branches are suffixed `-uat-fix-<attempt>`; recover the attempt.
function attemptFromBranch(value) {
  const match = /-uat-fix-(\d+)/.exec(value ?? '');
  return match ? Number(match[1]) : null;
}
function workerSpec(spec, issue) {
  const workers = spec.workers ?? {};
  return workers[issue] ?? workers[String(issue)] ?? {};
}
function prSpec(spec, issue) {
  const prs = spec.prs ?? {};
  return prs[issue] ?? prs[String(issue)] ?? {};
}
function uatSpec(spec, issue) {
  const uat = spec.uat ?? {};
  return uat[issue] ?? uat[String(issue)] ?? undefined;
}

// Should a fix worktree for `issue` created at `attempt` pass its baseline?
// "pass" => always; {fix_on:N} => from the N-th attempt onward; anything else
// (including "fail") => never. Mirrors the harness's dispatch-worktree logic.
function fixWorktreePasses(spec, issue, attempt) {
  const u = uatSpec(spec, issue);
  if (u === 'pass') return true;
  if (u && typeof u === 'object' && typeof u.fix_on === 'number') {
    return attempt !== null && attempt >= u.fix_on;
  }
  return false;
}

// The fake is stateless across processes, so an auto-yes flow (respond, then
// wait again expecting completion) needs a marker on disk. CMATE_FAKE_STATE
// names a directory the harness gives each case.
function respondedMarkerPath(issue) {
  const dir = process.env.CMATE_FAKE_STATE;
  return dir ? join(dir, `responded-${issue}`) : null;
}

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
  process.exit(0);
}
function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function main() {
  logInvocation();
  enforceContract();
  const spec = scenario();

  // --- commandmate availability probe -------------------------------------
  if (sub === '--version') {
    if (spec.cli_available === false) fail('commandmate: not available');
    process.stdout.write(`${spec.cli_version ?? 'commandmate 0.12.0'}\n`);
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
      // `git worktree add <dir> -b <branch> <sha>` from uat.mjs's fix loop. On
      // success create the real directory so the runner's baseline can cwd into
      // it, and drop the verify marker iff the scenario says this fix succeeds.
      const dir = argv[2];
      const branch = optionValue('-b');
      const issue = issueFromBranch(branch);
      const worker = workerSpec(spec, issue);
      if (worker.worktree_add === 'fail') fail('fatal: could not create work tree: directory already exists');
      const absDir = resolve(process.cwd(), dir ?? '.');
      try {
        mkdirSync(absDir, { recursive: true });
        if (fixWorktreePasses(spec, issue, attemptFromBranch(branch))) {
          writeFileSync(join(absDir, VERIFY_MARKER), 'ok');
        }
      } catch {
        // best effort; a spawn into a missing dir will surface as a baseline fail
      }
      process.stdout.write(`Preparing worktree (new branch '${branch}')\nHEAD is now at ${(argv[argv.length - 1] || 'deadbeef').slice(0, 8)}\n`);
      process.exit(0);
    }
    // `worktree list --porcelain`. Echo the planned worktree paths (injected by
    // the harness) so the dispatch `worktrees_present` probe can see them.
    const git = spec.git ?? {};
    const paths = git.worktrees ?? (spec.worktrees ?? []).map((w) => w.path).filter(Boolean);
    const lines = (paths.length ? paths : ['<all>']).map((w) => `worktree ${w}`);
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

  // --- commandmate worktree/worker lifecycle ------------------------------
  if (sub === 'ls') {
    // `commandmate ls --json` — the dispatch-time worktree-id resolver. Returns
    // the worktrees the harness injected from the plan's branches.
    if (argv.includes('--json')) {
      const rows = spec.worktrees ?? [];
      process.stdout.write(`${JSON.stringify(rows)}\n`);
      process.exit(0);
    }
    const rows = spec.worktrees ?? [];
    process.stdout.write(`${rows.map((w) => w.id).join('\n')}\n`);
    process.exit(0);
  }
  if (sub === 'send') {
    // `commandmate send <worktree-id> <message>` — positional, no task id back.
    const worktreeId = argv[1];
    const issue = issueFromId(worktreeId);
    if (!issue) fail('send: could not determine worktree');
    const worker = workerSpec(spec, issue);
    if (worker.send === 'fail') fail('send: worker dispatch refused');
    process.stderr.write('Message sent.\n');
    process.exit(0);
  }
  if (sub === 'wait') {
    // `commandmate wait <worktree-id> [--timeout <s>]`. State is the EXIT CODE:
    // 0 completed, 10 prompt (prompt JSON on stdout), 124 timeout, 1 failed.
    const worktreeId = argv[1];
    const issue = issueFromId(worktreeId);
    const worker = workerSpec(spec, issue);
    let state = worker.state ?? 'completed';
    // Once a prompt has been answered (auto-yes), the worker moves on.
    const marker = respondedMarkerPath(issue);
    if (state === 'prompt' && marker && existsSync(marker)) state = 'completed';
    if (state === 'completed') process.exit(WAIT_COMPLETED);
    if (state === 'prompt') {
      process.stdout.write(`${JSON.stringify({ worktreeId, cliToolId: 'claude', type: 'confirm', question: worker.prompt ?? 'Proceed? [y/N]', options: [], status: 'pending' })}\n`);
      process.exit(WAIT_PROMPT);
    }
    if (state === 'timeout') process.exit(WAIT_TIMEOUT);
    // failed
    process.stderr.write(`${worker.detail ?? 'worker exited non-zero'}\n`);
    process.exit(WAIT_FAILED);
  }
  if (sub === 'capture') {
    // `commandmate capture <worktree-id> --json` — CurrentOutputResponse shape.
    const worktreeId = argv[1];
    const issue = issueFromId(worktreeId);
    const worker = workerSpec(spec, issue);
    const prompt = worker.prompt ?? 'Proceed? [y/N]';
    emit({
      isRunning: true,
      isPromptWaiting: true,
      content: prompt,
      promptData: { type: 'confirm', question: prompt, options: [], status: 'pending' },
      sessionStatus: 'waiting',
    });
  }
  if (sub === 'respond') {
    // `commandmate respond <worktree-id> <answer>`. Reaching here at all is the
    // thing the default (no --auto-yes) path must never do.
    const worktreeId = argv[1];
    const issue = issueFromId(worktreeId);
    const marker = respondedMarkerPath(issue);
    if (marker) {
      try {
        writeFileSync(marker, 'responded');
      } catch {
        // best effort; the wait fallback simply won't advance
      }
    }
    process.stderr.write('Responded.\n');
    process.exit(0);
  }

  fail(`fake-cli: unknown subcommand "${sub}"`);
}

main();
