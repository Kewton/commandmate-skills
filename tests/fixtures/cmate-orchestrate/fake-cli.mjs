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
// Worker lifecycle (Issue #1468): a real Claude worker runs one TURN per message
// and then goes idle waiting for input — `wait` returns exit 0 on that idle, which
// is NOT task completion. The runners' ground truth for completion is a new commit
// on the worktree branch, so this fake models a worker that idles after every turn
// and only "commits" once it has been driven `commit_on` turns (default 1: commits
// on the first turn). Each `send` (the initial dispatch and every supervision
// nudge) counts as one turn; `git rev-parse HEAD` in a worktree returns a SHA
// derived from how many commits the worker has produced so far, so the supervisor
// can tell "committed" from "merely idle" and knows when to nudge, when to stop at
// the --max-turns cap, and — via `commit_on` far above the cap — never commits.
// `capture` reports whether the send actually registered (a send can leave the
// message unsubmitted); `confirm_after: N` withholds the "generating" signal until
// the N-th send so the send-confirm/re-send path is exercisable.
//
// Execution contract (Issue #1588). CommandMate 0.17.0 added `send --contract`,
// `wait --verify` and a `verify` subcommand; older CLIs have none of them. A
// scenario opts in with `cli_contract: true`, and when it is false this fake
// REJECTS those flags the way an older binary would (unknown option) and omits
// them from `<sub> --help` — which is what the runner's version gate probes. That
// is what makes the fallback path a tested path rather than dead code.
//
// Under a contract the verdict is an EXIT CODE, not a marker file:
// `wait --verify` returns the scenario's `workers.<n>.verify_exits` entry for the
// current turn (0 pass / 20 judged-and-failed / 21 no work evidence / 99 NO
// VERDICT REACHED), and `verify <id> --json` prints a verification run document
// whose failing gates come from `workers.<n>.failed_gates`.
//
// Without a contract, verification is NOT a commandmate call in the real CLI: the
// runners run the profile baseline inside the worktree. The tests model that with
// the node-fake profile whose baseline is `cat cmate-verify-ok`, so a worktree
// "passes" iff it contains that marker file. This fake writes the marker into a
// fix worktree it creates when the scenario says that fix should succeed.
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
const COMMANDMATE_SUBS = new Set(['ls', 'send', 'wait', 'capture', 'respond', 'verify']);

// The flags a pre-0.17.0 commandmate does not have. A scenario without
// `cli_contract: true` refuses them and hides them from --help, so the runner's
// version gate sees exactly what an older binary would show it.
const CONTRACT_GATED_FLAGS = { send: ['--contract'], wait: ['--verify', '--require-work'] };

// The options each subcommand lists in `commandmate <sub> --help`, in the real
// CLI's order. The gated ones above are appended only when the scenario says the
// CLI is new enough.
const HELP_FLAGS = {
  send: ['--agent', '--instance', '--register', '--model', '--auto-yes', '--duration', '--stop-pattern', '--token'],
  wait: ['--timeout', '--on-prompt', '--stall-timeout', '--instance', '--token'],
  capture: ['--json', '--agent', '--instance', '--token'],
  respond: ['--agent', '--instance', '--token'],
  ls: ['--json', '--quiet', '--branch', '--id', '--token'],
  verify: ['--instance', '--gates', '--json', '--timeout', '--token'],
};

// wait exit codes (mirror the real CLI's WaitExitCode).
const WAIT_COMPLETED = 0;
const WAIT_PROMPT = 10;
const WAIT_TIMEOUT = 124;
const WAIT_FAILED = 1;

// verify / wait --verify verdict exit codes (mirror VerifyExitCode + ExitCode).
const VERIFY_FAILED = 20;
const VERIFY_NOT_STARTED = 21;

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

// Per-issue turn counter (Issue #1468). Every `send` — the initial dispatch and
// every supervision nudge — bumps it; `git rev-parse HEAD` reads it to decide how
// far the worker has progressed. Stored under CMATE_FAKE_STATE so it survives the
// stateless per-process fake.
function sendsCountPath(issue) {
  const dir = process.env.CMATE_FAKE_STATE;
  return dir && issue != null ? join(dir, `sends-${issue}`) : null;
}
function readSends(issue) {
  const path = sendsCountPath(issue);
  if (!path) return 0;
  try {
    return Number.parseInt(readFileSync(path, 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}
function bumpSends(issue) {
  const path = sendsCountPath(issue);
  if (!path) return;
  try {
    writeFileSync(path, String(readSends(issue) + 1));
  } catch {
    // best effort; commit progression simply will not advance if we cannot record it
  }
}

// The issue an in-worktree git call is about, recovered from the process cwd
// (…/repo-issue-<n>[-uat-fix-<a>]). The runners cwd into the worktree to run the
// baseline and to read HEAD, so the fake can look the worker's spec back up.
function issueFromCwd() {
  const match = /issue-(\d+)/.exec(process.cwd());
  return match ? match[1] : null;
}

// How many commits the worker for `issue` has produced so far: none until it has
// been driven `commit_on` turns (default 1), then one per further turn. A worker
// whose `commit_on` sits above the runner's --max-turns cap never commits, which
// is exactly the "idle forever, never completes" case the supervisor must escape.
function commitsFor(spec, issue) {
  const worker = workerSpec(spec, issue);
  const commitOn = typeof worker.commit_on === 'number' ? worker.commit_on : 1;
  const sends = readSends(issue);
  return sends < commitOn ? 0 : sends - commitOn + 1;
}
// A 40-hex worktree HEAD that advances by one each time the worker commits; 40
// zeros before its first commit. Distinct SHAs per commit let the supervisor see
// progress across attempts, not just "changed vs base".
function headShaFor(spec, issue) {
  return String(commitsFor(spec, issue)).padStart(40, '0');
}

// Does this scenario's CommandMate speak the execution contract (0.17.0+)?
function contractCapable(spec) {
  return spec.cli_contract === true;
}

// `commandmate <sub> --help`. The runner's version gate reads exactly this, so a
// pre-contract CLI must not list the gated flags.
function helpFor(sub, spec) {
  const flags = [...(HELP_FLAGS[sub] ?? [])];
  if (contractCapable(spec)) flags.push(...(CONTRACT_GATED_FLAGS[sub] ?? []));
  const lines = [`Usage: commandmate ${sub} [options]`, '', 'Options:'];
  for (const flag of flags) lines.push(`  ${flag} <value>`);
  lines.push('  -h, --help                 display help for command');
  return lines.join('\n');
}

// An older binary rejects the 0.17.0 flags outright. Without this the fallback
// cases would "pass" against a fake that quietly accepted a flag the CLI they
// model does not have.
function refuseGatedFlags(spec) {
  if (contractCapable(spec)) return;
  for (const flag of CONTRACT_GATED_FLAGS[sub] ?? []) {
    if (argv.includes(flag)) fail(`error: unknown option '${flag}'`, 1);
  }
}

// The verdict `wait --verify` returns on this turn. `verify_exits` is consumed
// per turn (one send = one turn) so a scenario can model "20, then 0 after the
// re-instruction"; the last entry repeats once the list runs out.
function verifyExitFor(worker, issue) {
  const exits = Array.isArray(worker.verify_exits) ? worker.verify_exits : null;
  if (!exits || exits.length === 0) return WAIT_COMPLETED;
  const turn = Math.max(1, readSends(issue));
  return exits[Math.min(turn - 1, exits.length - 1)];
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

  // --- commandmate <sub> --help (the runner's version gate) ----------------
  if (COMMANDMATE_SUBS.has(sub) && argv.includes('--help')) {
    if (sub === 'verify' && !contractCapable(spec)) {
      fail(`error: unknown command 'verify'`, 1);
    }
    process.stdout.write(`${helpFor(sub, spec)}\n`);
    process.exit(0);
  }
  refuseGatedFlags(spec);

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
    // `git rev-parse HEAD` inside a worktree — the commit-completion ground truth
    // (Issue #1468). The SHA only moves once the worker has committed, so the
    // supervisor can distinguish a real completion from a bare idle.
    if (argv[1] === 'HEAD') {
      process.stdout.write(`${headShaFor(spec, issueFromCwd())}\n`);
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
    // `gh repo view <repo> --json defaultBranchRef` — merge.mjs's Issue #39
    // auto-close probe. The default answer is `develop`, which is the base the
    // node-commandmate profile plans against, so a scenario that says nothing
    // about it models "base IS the default branch" and records no limitation.
    // `default_branch` models a 3-branch flow; `default_branch_query` injects a
    // failed ("fail") or field-less ("absent") answer, both of which the runner
    // must skip rather than let block the merge flow.
    const jsonFields = String(optionValue('--json') ?? '').split(',');
    if (jsonFields.includes('defaultBranchRef')) {
      if (gh.default_branch_query === 'fail') fail('gh: could not query defaultBranchRef');
      if (gh.default_branch_query === 'absent') emit({});
      emit({ defaultBranchRef: { name: gh.default_branch ?? 'develop' } });
    }
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
    // `commandmate send <worktree-id> [message]` — positional. With --contract
    // the message is omitted (the server composes it) and the TASK ID is printed
    // on stdout; that id is what the runner records (Issue #1588/#1545).
    const worktreeId = argv[1];
    const issue = issueFromId(worktreeId);
    if (!issue) fail('send: could not determine worktree');
    const worker = workerSpec(spec, issue);
    if (worker.send === 'fail') fail('send: worker dispatch refused');
    const contractPath = optionValue('--contract');
    if (contractPath !== null) {
      if (worker.contract === 'reject') {
        fail('Error: invalid task contract:\n  - scope.allow: at least one pattern is required while success.requireScopeClean is true', 2);
      }
      // The real CLI resolves --contract relative to the worktree root and exits
      // 2 when the file is not there. Checking it here is what proves the runner
      // actually placed the contract in the worktree it dispatched to.
      const row = (spec.worktrees ?? []).find((entry) => entry.id === worktreeId);
      const absolute = resolve(process.cwd(), row?.path ?? '.', contractPath);
      if (!existsSync(absolute)) {
        fail(`Error: invalid task contract:\n  - ${contractPath}: contract file not found in the worktree`, 2);
      }
      const taskId = `task-issue-${issue}`;
      process.stderr.write(`Task created: ${taskId}\n`);
      process.stdout.write(`${taskId}\n`);
    }
    // A successful send drives the worker one more turn (Issue #1468).
    bumpSends(issue);
    process.stderr.write('Message sent.\n');
    process.exit(0);
  }
  if (sub === 'wait') {
    // `commandmate wait <worktree-id> [--timeout <s>] [--verify]`. State is the
    // EXIT CODE: 0 completed, 10 prompt (prompt JSON on stdout), 124 timeout,
    // 1 failed. With --verify the completion path returns the VERDICT instead:
    // 0 pass / 20 judged-and-failed / 21 no work evidence / 99 no verdict.
    // Prompts and timeouts are returned unchanged and never verified — the real
    // CLI only verifies a worktree whose completion it detected (#1544).
    const worktreeId = argv[1];
    const issue = issueFromId(worktreeId);
    const worker = workerSpec(spec, issue);
    let state = worker.state ?? 'completed';
    // Once a prompt has been answered (auto-yes), the worker moves on.
    const marker = respondedMarkerPath(issue);
    if (state === 'prompt' && marker && existsSync(marker)) state = 'completed';
    if (state === 'completed') {
      if (!argv.includes('--verify')) process.exit(WAIT_COMPLETED);
      // Like the real CLI (verify-runner's reportGates), a judged run prints one
      // `GATE <id> PASS|FAIL` line per executed gate (#1678 B-5): pass runs list
      // work-evidence plus the scenario's pass_gates (default ['baseline']),
      // fail runs list work-evidence plus the failed_gates. Exit 99 judged
      // nothing, so nothing is printed.
      const exit = verifyExitFor(worker, issue);
      const gateLines = [];
      if (exit === 0) {
        gateLines.push('GATE work-evidence PASS');
        for (const id of worker.pass_gates ?? ['baseline']) gateLines.push(`GATE ${id} PASS`);
      } else if (exit === VERIFY_FAILED) {
        gateLines.push('GATE work-evidence PASS');
        for (const entry of worker.failed_gates ?? []) {
          gateLines.push(`GATE ${typeof entry === 'string' ? entry : entry.id} FAIL`);
        }
      } else if (exit === VERIFY_NOT_STARTED) {
        gateLines.push('GATE work-evidence FAIL');
      }
      // `gate_lines: false` models a CLI whose verdict is an exit code alone —
      // an older build, or one whose gate reporting the runner cannot parse. The
      // verdict still stands; what the report loses is the ability to say WHAT
      // the pass was based on, which the runner must record rather than leave as
      // an empty list (Issue #83).
      if (worker.gate_lines === false) gateLines.length = 0;
      for (const line of gateLines) process.stdout.write(`${line}\n`);
      process.exit(exit);
    }
    if (state === 'prompt') {
      process.stdout.write(`${JSON.stringify({ worktreeId, cliToolId: 'claude', type: 'confirm', question: worker.prompt ?? 'Proceed? [y/N]', options: [], status: 'pending' })}\n`);
      process.exit(WAIT_PROMPT);
    }
    if (state === 'timeout') process.exit(WAIT_TIMEOUT);
    // failed
    process.stderr.write(`${worker.detail ?? 'worker exited non-zero'}\n`);
    process.exit(WAIT_FAILED);
  }
  if (sub === 'verify') {
    // `commandmate verify <worktree-id> --json` — the verification run document
    // (VerificationRunView). The runner reads `gates[]` only to NAME the gates a
    // failing verdict is about; the verdict itself stays the wait's exit code.
    if (!contractCapable(spec)) fail(`error: unknown command 'verify'`, 1);
    const worktreeId = argv[1];
    const issue = issueFromId(worktreeId);
    const worker = workerSpec(spec, issue);
    // A failed_gates entry is a gate id string, or an object {id, logTail, exit}
    // when a scenario needs to control the gate's log — e.g. a scope gate whose
    // logTail lists the out-of-scope paths (#1678 B-2).
    const failedGates = Array.isArray(worker.failed_gates) ? worker.failed_gates : [];
    const gates = [
      { gateId: 'work-evidence', status: 'passed', exitCode: null, durationMs: 12, logTail: 'commits=1 uncommitted=0' },
      ...failedGates.map((entry) => {
        const gate = typeof entry === 'string' ? { id: entry } : entry;
        return {
          gateId: gate.id,
          status: 'failed',
          exitCode: Number.isInteger(gate.exit) ? gate.exit : 1,
          durationMs: 340,
          logTail: gate.logTail ?? `${gate.id}: 1 problem`,
        };
      }),
    ];
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({
        id: 1,
        worktreeId,
        instanceId: null,
        taskId: `task-issue-${issue}`,
        trigger: 'manual',
        status: failedGates.length > 0 ? 'failed' : 'passed',
        baseRef: 'origin/develop',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        gates,
      })}\n`);
    }
    process.exit(failedGates.length > 0 ? VERIFY_FAILED : 0);
  }
  if (sub === 'capture') {
    // `commandmate capture <worktree-id> --json` — CurrentOutputResponse shape.
    // Reports the worker's live state so the supervisor can (a) present a pending
    // prompt and (b) confirm a send actually registered (Issue #1468). A prompt
    // worker shows a pending prompt until it is answered; otherwise the worker is
    // "generating" only once it has received `confirm_after` sends (default 1), so
    // a scenario can withhold that signal to exercise the send-confirm/re-send path.
    const worktreeId = argv[1];
    const issue = issueFromId(worktreeId);
    const worker = workerSpec(spec, issue);
    const marker = respondedMarkerPath(issue);
    const responded = Boolean(marker && existsSync(marker));
    if (worker.state === 'prompt' && !responded) {
      const prompt = worker.prompt ?? 'Proceed? [y/N]';
      emit({
        isRunning: true,
        isGenerating: false,
        isPromptWaiting: true,
        content: prompt,
        promptData: { type: 'confirm', question: prompt, options: [], status: 'pending' },
        sessionStatus: 'waiting',
      });
    }
    const confirmAfter = typeof worker.confirm_after === 'number' ? worker.confirm_after : 1;
    const started = readSends(issue) >= confirmAfter;
    emit({
      isRunning: started,
      isGenerating: started,
      isPromptWaiting: false,
      content: started ? 'working…' : '',
      promptData: null,
      sessionStatus: started ? 'working' : 'idle',
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
