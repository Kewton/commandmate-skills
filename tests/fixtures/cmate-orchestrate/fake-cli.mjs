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
// fails the suite here, not only in production. A flag whose argument is an enum
// carries its values in the contract's `flag_values` and is checked the same way
// (Issue #136: `send --duration` takes 1h/3h/8h, and the real CLI rejects anything
// else before it sends). The real CLI is worktree-id based:
// `send <worktree-id> <message>`, `wait <worktree-ids...>`, `capture <worktree-id>
// --json`, `respond <worktree-id> <answer>`, `ls --json`. There is no `--json
// --worktree --prompt-file` on send, no `--task` anywhere, and no `verify`/`uat`
// subcommand. `wait` signals state by EXIT CODE (0 completed, 10 prompt, 124
// timeout), printing prompt JSON to stdout on a prompt.
//
// Worktree registration (Issue #91): `commandmate sync` re-scans repositories and
// registers their worktrees with the server (CommandMate 0.21.0+). It creates no
// worktree, so it fixes only "on disk but never scanned". A scenario models that
// with `sync_worktrees` — rows `ls` hides until a sync has run — and opts out of
// the subcommand entirely with `cli_sync: false`, which is what an older binary
// does (`error: unknown command 'sync'`, exit 1).
//
// Worktree preparation (Issue #93): `--prepare-worktrees` makes dispatch invoke a
// cmate-worktree-setup provider for the issues whose worktree it could not
// resolve. This script doubles as that provider under the `worktree-setup`
// subcommand: it creates the directory (and the baseline marker), records that it
// did in CMATE_FAKE_STATE, and prints a worktree-setup.result.v1 document on
// stdout — the contract dispatch validates. A scenario's `prepared_worktrees`
// rows are the worktrees it can create; they are hidden from BOTH `commandmate ls`
// and `git worktree list` until the provider has created them, and hidden from
// `ls` alone until a sync has re-scanned, which is exactly the world the stage
// exists for. `worktree_setup` tunes the provider (create only a subset, produce a
// branch the plan does not name, exit non-zero, emit a non-conformant document).
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
// Auto-Yes (Issue #136). Answering a prompt automatically takes TWO things that
// live in different places: the worktree's auto-yes STATE (enabled by `send
// --auto-yes`, without which the server's poller does not start) and the
// contract's autoYes POLICY (which decides whether the prompt's TYPE may be
// answered — `mode: safe` allows `yes_no` only, so Claude's `multiple_choice`
// permission menu is refused). A scenario with `auto_yes_poller: true` models the
// server getting to the prompt first: the fake then applies both gates itself,
// answers when they allow it, and records the verdict in the invocation log as an
// `auto-yes-poller` event. Without the knob, `wait` returns the prompt to the
// caller exactly as before, which is the other real ordering. `workers.<n>.
// prompt_type` chooses the type the policy is judged against (default `yes_no`).
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

import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// `git -c <key>=<value> … <sub>` (Issue #174): git's global config options come
// BEFORE the subcommand, so they are consumed here — the rest of this file keeps
// reading `argv[0]` as the subcommand, and a runner that sets one gets the same
// behaviour change the real git would give it (see cQuotePath below).
const rawArgv = process.argv.slice(2);
const gitConfig = new Map();
let firstArg = 0;
while (rawArgv[firstArg] === '-c' && typeof rawArgv[firstArg + 1] === 'string') {
  const setting = rawArgv[firstArg + 1];
  const eq = setting.indexOf('=');
  const key = (eq === -1 ? setting : setting.slice(0, eq)).toLowerCase();
  gitConfig.set(key, eq === -1 ? 'true' : setting.slice(eq + 1));
  firstArg += 2;
}
const argv = rawArgv.slice(firstArg);
const sub = argv[0] ?? '';

// The marker file the node-fake profile's baseline (`cat cmate-verify-ok`) reads.
// Present in a worktree => that worktree's baseline passes.
const VERIFY_MARKER = 'cmate-verify-ok';

// commandmate subcommands this fake emulates. Only these are contract-checked.
const COMMANDMATE_SUBS = new Set(['ls', 'send', 'wait', 'capture', 'respond', 'verify', 'sync']);

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
  sync: ['--json', '--token'],
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
  const enums = spec.flag_values ?? {};
  const tokens = argv.slice(1);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (typeof token !== 'string' || !token.startsWith('--')) continue;
    const [flag, inline] = [token.split('=')[0], token.includes('=') ? token.slice(token.indexOf('=') + 1) : null];
    if (!allowed.has(flag)) {
      process.stderr.write(`fake-cli: contract violation: commandmate ${sub} does not accept ${flag}\n`);
      process.exit(2);
    }
    // A flag whose argument is an enum (Issue #136: `send --duration` takes
    // 1h/3h/8h and nothing else). The real CLI validates BEFORE it sends, and its
    // failure is the whole dispatch, so the fake refuses the same way instead of
    // accepting a value that would have aborted the run in production.
    const values = enums[flag];
    if (!values) continue;
    const given = inline ?? tokens[i + 1] ?? null;
    if (given === null || !values.includes(given)) {
      process.stderr.write(`Error: Invalid ${flag.replace(/^--/, '')}. Must be one of: ${values.join(', ')}\n`);
      process.exit(1);
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

// ============================================================================
// The server-side Auto-Yes poller (Issue #136)
// ============================================================================
//
// Two independent gates decide whether a prompt is answered by the SERVER, and
// the runner has to satisfy both. Modelling them here is what makes the fixtures
// able to tell "auto-yes worked" from "the runner answered the prompt itself",
// which is precisely the difference the issue is about.
//
//   1. worktree state — `auto-yes-poller.js`: `if (!autoYesState?.enabled)
//      return { started: false, reason: 'auto-yes not enabled' }`. The state is
//      enabled by `commandmate send --auto-yes` (or `auto-yes --enable`), so the
//      marker below is written by the send handler and by nothing else.
//   2. contract policy — `polling/auto-yes-resolver.js`,
//      `evaluatePolicyAgainstTexts`: `off` refuses everything, `safe` allows
//      `yes_no` ONLY (the allow list is not consulted), `allow-listed` allows the
//      listed types, and no `autoYes` block at all means no constraint. Under
//      that, `resolveBaseAnswer` can only ever answer `yes_no` and
//      `multiple_choice`; the other four PROMPT_TYPES resolve to null first.
//
// A scenario opts in with `auto_yes_poller: true`, which models the ordering
// where the poller reaches the prompt BEFORE `wait --on-prompt agent` returns it
// to the caller. The other ordering — `wait` returns exit 10 and the runner
// answers with `commandmate respond` — is what every scenario without the knob
// models, and both really happen: the poller runs on an interval, `wait` does
// not. What is NOT a race is a suppressed prompt: no poller answer is coming, so
// the prompt stands until a human (or the runner's own --auto-yes path) answers.
const AUTO_YES_ANSWERABLE_TYPES = new Set(['yes_no', 'multiple_choice']);

// The question a prompting worker shows. Kept in one place so `wait` and
// `capture` cannot disagree about what the worker is asking.
function promptQuestion(worker) {
  if (worker.prompt) return worker.prompt;
  return (worker.prompt_type ?? 'yes_no') === 'multiple_choice'
    ? 'Do you want to make this edit to src/base.ts?'
    : 'Proceed? [y/N]';
}

function autoYesMarkerPath(issue) {
  const dir = process.env.CMATE_FAKE_STATE;
  return dir && issue != null ? join(dir, `auto-yes-${issue}`) : null;
}
function enableAutoYes(issue) {
  const path = autoYesMarkerPath(issue);
  try {
    if (path) writeFileSync(path, optionValue('--duration') ?? '1h');
  } catch {
    // best effort; the poller simply stays "not enabled" if we cannot record it
  }
}
function contractMarkerPath(issue) {
  const dir = process.env.CMATE_FAKE_STATE;
  return dir && issue != null ? join(dir, `contract-${issue}`) : null;
}
function recordContractPath(issue, absolute) {
  const path = contractMarkerPath(issue);
  try {
    if (path) writeFileSync(path, absolute);
  } catch {
    // best effort; without it the fake reads "no contract", i.e. no policy
  }
}

// The `autoYes` block of the contract this worktree was dispatched with, read
// without a YAML parser (this fixture tree is Node stdlib only, and the generator
// writes a fixed, flat shape). Null when no contract was sent — which the
// resolver treats as "no policy", not as "off".
function contractAutoYesPolicy(issue) {
  const marker = contractMarkerPath(issue);
  if (!marker || !existsSync(marker)) return null;
  let text;
  try {
    text = readFileSync(readFileSync(marker, 'utf8'), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === 'autoYes:');
  if (start < 0) return null;
  const policy = { mode: null, allowPromptTypes: [] };
  let inAllowList = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key ends the block
    const mode = /^ {2}mode:\s*"?([a-z-]+)"?\s*$/.exec(line);
    if (mode) {
      policy.mode = mode[1];
      inAllowList = false;
      continue;
    }
    if (/^ {2}allowPromptTypes:\s*$/.test(line)) {
      inAllowList = true;
      continue;
    }
    const entry = /^ {4}- "?([a-z_]+)"?\s*$/.exec(line);
    if (inAllowList && entry) {
      policy.allowPromptTypes.push(entry[1]);
      continue;
    }
    if (/^ {2}\S/.test(line)) inAllowList = false;
  }
  return policy;
}

// `evaluatePolicyAgainstTexts` + `resolveBaseAnswer`, transcribed. Returns null
// when the server would answer, or the reason it would not.
function autoYesSuppression(policy, promptType) {
  if (!AUTO_YES_ANSWERABLE_TYPES.has(promptType)) return 'not-answerable';
  if (!policy) return null; // no contract => no policy => no constraint
  if (policy.mode === 'off') return 'mode-off';
  if (policy.mode === 'safe') return promptType === 'yes_no' ? null : 'type-not-allowed';
  if (policy.mode === 'allow-listed') {
    return policy.allowPromptTypes.includes(promptType) ? null : 'type-not-allowed';
  }
  return null; // mode null: the contract states no constraint
}

// What the poller did with this prompt, as one log line the tests can read. It is
// deliberately NOT a commandmate subcommand: the poller is server-side, so it
// appears in the invocation log as an event, and the CLI-contract parity check
// (which filters on the real subcommands) never sees it.
function recordPollerVerdict(worktreeId, verdict, promptType, mode) {
  const path = process.env.CMATE_FAKE_LOG;
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ sub: 'auto-yes-poller', args: [worktreeId, verdict, promptType, mode ?? 'none'] })}\n`);
  } catch {
    // as with logInvocation: a logging failure must not change behaviour
  }
}

// Would the server have answered this prompt before `wait` returned it? Records
// the verdict either way, so a fixture can assert WHY nothing was answered.
function serverAnswersPrompt(spec, issue, worktreeId, promptType) {
  if (spec.auto_yes_poller !== true) return false;
  const policy = contractAutoYesPolicy(issue);
  const enabled = markerExists(autoYesMarkerPath(issue));
  if (!enabled) {
    recordPollerVerdict(worktreeId, 'not-enabled', promptType, policy?.mode);
    return false;
  }
  const suppression = autoYesSuppression(policy, promptType);
  recordPollerVerdict(worktreeId, suppression ?? 'answered', promptType, policy?.mode);
  return suppression === null;
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

// `commandmate sync` (CommandMate 0.21.0+) re-scans repositories and registers
// their worktrees with the server; it creates nothing. The fake models exactly
// that: a scenario's `sync_worktrees` rows are worktrees that exist on disk but
// that the server has not scanned, so `ls` hides them until a sync has run. The
// marker is what carries "a sync has run" across this stateless per-process fake.
function syncMarkerPath() {
  const dir = process.env.CMATE_FAKE_STATE;
  return dir ? join(dir, 'synced') : null;
}
function syncHasRun() {
  const marker = syncMarkerPath();
  return Boolean(marker && existsSync(marker));
}
// A worktree the `worktree-setup` provider created (Issue #93). Two markers,
// because the two facts are genuinely separate and the runner depends on the
// difference: `prepared-<n>` means the worktree now exists on disk (git sees it
// immediately), `registered-<n>` means a `commandmate sync` re-scanned WHILE it
// existed and the server therefore knows it. A sync that ran before the worktree
// was created registers nothing — which is exactly why the preparation stage has
// to force a second re-scan rather than reuse the run's first one.
function preparedMarkerPath(issue) {
  const dir = process.env.CMATE_FAKE_STATE;
  return dir && issue != null ? join(dir, `prepared-${issue}`) : null;
}
function registeredMarkerPath(issue) {
  const dir = process.env.CMATE_FAKE_STATE;
  return dir && issue != null ? join(dir, `registered-${issue}`) : null;
}
function markerExists(path) {
  return Boolean(path && existsSync(path));
}
// Created on disk: what `git worktree list` reports.
function preparedRows(spec) {
  return (spec.prepared_worktrees ?? []).filter((row) => markerExists(preparedMarkerPath(issueFromBranch(row.branch))));
}
// Created AND scanned since: what `commandmate ls` reports.
function registeredPreparedRows(spec) {
  return (spec.prepared_worktrees ?? []).filter((row) => markerExists(registeredMarkerPath(issueFromBranch(row.branch))));
}

// The rows `commandmate ls` reports right now: the always-registered ones, plus
// the sync-only ones once the server has been told to re-scan, plus the ones the
// provider created that a re-scan has since picked up.
function visibleWorktrees(spec) {
  const rows = [...(spec.worktrees ?? [])];
  if (syncHasRun()) rows.push(...(spec.sync_worktrees ?? []));
  rows.push(...registeredPreparedRows(spec));
  return rows;
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
// `commits: N` is the commits the branch ALREADY carries when this invocation
// starts — the work a previous attempt's worker left behind (Issue #121). The
// harness gives every attempt a fresh CMATE_FAKE_STATE, so the turn counter
// cannot express "the worktree still holds what was committed last time", and
// `--reverify` exists precisely for that world. Default 0, so every scenario
// written before this knob behaves exactly as it did.
function commitsFor(spec, issue) {
  const worker = workerSpec(spec, issue);
  const commitOn = typeof worker.commit_on === 'number' ? worker.commit_on : 1;
  const sends = readSends(issue);
  const existing = Number.isInteger(worker.commits) ? worker.commits : 0;
  return existing + (sends < commitOn ? 0 : sends - commitOn + 1);
}
// A 40-hex worktree HEAD that advances by one each time the worker commits; 40
// zeros before its first commit. Distinct SHAs per commit let the supervisor see
// progress across attempts, not just "changed vs base".
function headShaFor(spec, issue) {
  return String(commitsFor(spec, issue)).padStart(40, '0');
}

// The base SHA the provider reports for a worktree it created. The same value
// `git rev-parse --verify <base>` answers above, so the document and the git
// probes agree about which commit the branch came from.
const SETUP_BASE_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

// One worktree-setup.result.v1 document. Every top-level field the contract
// requires is present — a fixture that omitted one would be testing dispatch's
// conformance check rather than the preparation it is meant to exercise.
function setupResultDocument(spec, requested, worktrees, baseline, status) {
  const created = worktrees.filter((entry) => entry.created).length;
  return {
    result_schema_version: 1,
    skill_id: 'cmate-worktree-setup',
    skill_version: spec.worktree_setup?.skill_version ?? '0.1.0',
    generated_at: '2026-01-01T00:00:00Z',
    status,
    phase_reached: created > 0 ? 'complete' : 'plan',
    request: { issue_numbers: requested, max_issues: 5, reuse_existing: false },
    repository: {
      slug: 'Kewton/CommandMate',
      current_branch: (spec.git ?? {}).branch ?? 'feature/integration',
      integration_branch: 'develop',
      default_base: 'origin/develop',
      remote_name: 'origin',
      dirty: Boolean((spec.git ?? {}).dirty),
    },
    profile: {
      selected: 'node',
      verified: true,
      detection_evidence: [{ signal: 'package.json', path: 'package.json' }],
      base_ref: 'origin/develop',
      base_sha: SETUP_BASE_SHA,
      branch_template: 'feature/issue-{N}-{slug}',
      directory_template: '../{repo}-issue-{N}-{slug}',
      baseline_command: 'cat cmate-verify-ok',
    },
    plan: worktrees.map((entry) => ({
      issue_number: entry.issue_number,
      branch: entry.branch,
      directory: entry.directory,
      base_ref: 'origin/develop',
      base_sha: SETUP_BASE_SHA,
      baseline_command: 'cat cmate-verify-ok',
      sync_planned: true,
      blocked_by: entry.created ? [] : ['local_branch'],
    })),
    worktrees,
    baseline,
    commandmate_sync: {
      available: spec.cli_sync !== false,
      attempted: true,
      worktree_id: null,
      detail: 'the server was asked to re-scan; the id is resolved by the caller',
    },
    collisions: worktrees.filter((entry) => !entry.created).map((entry) => ({
      issue_number: entry.issue_number,
      kind: 'local_branch',
      detail: entry.branch,
    })),
    redactions: [],
    next_actions: [{ action: 'review the created worktrees', owner: 'operator' }],
    blocking_reasons: created === 0 ? ['every planned target collided with an existing branch'] : [],
    limitations: [],
    completion_check: {
      passed: created > 0,
      checks: ['input_validated', 'plan_confirmed', 'no_implicit_overwrite', 'base_reconfirmed', 'baseline_reported', 'no_secret_or_abspath']
        .map((id) => ({ id, passed: created > 0, detail: created > 0 ? 'checked' : 'nothing was created' })),
    },
    summary_markdown: '## 対象と結論\nfake provider result\n',
  };
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

// The gates that FAIL on this turn. `failed_gates` is one list for the whole run
// — every turn of a failing worker reports it unchanged, which is what a worker
// stuck on the same complaint looks like. `failed_gates_by_turn` is the per-turn
// form, consumed exactly like `verify_exits` (index by turn, last entry repeats),
// so a scenario can model a worker whose scope violations SHRINK turn by turn
// (Issue #148): without it, "the same answer twice" and "progress" would be
// indistinguishable to the fake and the loop guard could only ever be measured
// on one side.
function failedGatesFor(worker, issue) {
  const byTurn = Array.isArray(worker.failed_gates_by_turn) ? worker.failed_gates_by_turn : null;
  if (byTurn && byTurn.length > 0) {
    const turn = Math.max(1, readSends(issue));
    const entry = byTurn[Math.min(turn - 1, byTurn.length - 1)];
    return Array.isArray(entry) ? entry : [];
  }
  return Array.isArray(worker.failed_gates) ? worker.failed_gates : [];
}

// ---------------------------------------------------------------------------
// Really running the worktree's declared gates (Issue #114)
// ---------------------------------------------------------------------------
//
// Every other verification path in this fake is a scenario knob: `verify_exits`
// SAYS the run passed or failed. That is enough to exercise the supervision loop,
// but it cannot be evidence that an ACCEPTANCE gate measured anything — a knob
// returns 20 whether the deliverable is broken or not, so a "mutation" fixture
// built on it proves only that the harness can be told to say 20.
//
// The ADR's §4 (2) requires the mutation to live in the JUDGED ARTIFACT. So for
// the acceptance-gate cases this fake does what CommandMate does: it reads the
// worktree's own `.commandmate/verify.yaml`, runs each gate's command with
// `sh -c` in the worktree, and derives the verdict from the exit status. The two
// runs of a two-point measurement then differ ONLY in the worktree's contents,
// and the red run is red because a command actually failed.
//
// Opted into per scenario with `run_declared_gates: true`, so the 36 existing
// dispatch cases keep the knob behaviour unchanged.
function declaredGatesOf(worktreePath) {
  const path = join(worktreePath, '.commandmate', 'verify.yaml');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const gates = [];
  let inGates = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ ]*(#|$)/.test(raw)) continue;
    if (/^[a-zA-Z]/.test(raw)) {
      inGates = raw.startsWith('gates:');
      continue;
    }
    if (!inGates) continue;
    const item = /^ {2}- id:\s*(.+?)\s*$/.exec(raw);
    if (item) {
      gates.push({ id: item[1], command: '' });
      continue;
    }
    const field = /^ {4}command:\s*(.+?)\s*$/.exec(raw);
    if (field && gates.length > 0) {
      const value = field[1];
      gates[gates.length - 1].command = /^".*"$/.test(value) || /^'.*'$/.test(value) ? value.slice(1, -1) : value;
    }
  }
  return gates.filter((gate) => gate.id !== '' && gate.command !== '');
}

// The gate ids the contract selected, or null when it declares no `verify.gates`
// (which means "every declared gate runs" — the case an issue's `require:` list
// deliberately produces, ADR §3.4).
function contractGateIds(worktreePath, issue) {
  const path = join(worktreePath, '.commandmate', 'tasks', `cmate-orchestrate-issue-${issue}.yaml`);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === 'verify:');
  if (start < 0) return null;
  const ids = [];
  for (const line of lines.slice(start + 2)) {
    const item = /^ {4}- (.+?)\s*$/.exec(line);
    if (!item) break;
    const value = item[1];
    ids.push(/^".*"$/.test(value) || /^'.*'$/.test(value) ? value.slice(1, -1) : value);
  }
  return ids;
}

// Run them. Returns { lines, exit, failing } shaped like the real CLI's output:
// one `GATE <id> PASS|FAIL (exit=<n>)` line per gate, exit 20 if any failed.
function runDeclaredGates(spec, issue, worktreeId) {
  const row = visibleWorktrees(spec).find((entry) => entry.id === worktreeId);
  const worktreePath = resolve(process.cwd(), row?.path ?? '.');
  const declared = declaredGatesOf(worktreePath);
  const selected = contractGateIds(worktreePath, issue);
  const toRun = selected === null ? declared : declared.filter((gate) => selected.includes(gate.id));
  const lines = ['GATE work-evidence PASS (commits=1, uncommitted=0)'];
  const failing = [];
  for (const gate of toRun) {
    const result = spawnSync('sh', ['-c', gate.command], { cwd: worktreePath, encoding: 'utf8' });
    // A command that could not be launched at all still has an exit status here
    // (sh reports 127); it is recorded as the gate's exit, never as "skipped".
    const code = result.status === null ? 1 : result.status;
    lines.push(`GATE ${gate.id} ${code === 0 ? 'PASS' : 'FAIL'} (exit=${code})`);
    if (code !== 0) {
      failing.push({ id: gate.id, exit: code, logTail: `${(result.stderr || result.stdout || '').trim().slice(-200) || `${gate.command}: exited ${code}`}` });
    }
  }
  return { lines, exit: failing.length > 0 ? VERIFY_FAILED : 0, failing };
}

// Where a `GATE <id> PASS|FAIL` line goes. MEASURED against CommandMate 0.22.2:
// verify-runner's reportGates writes them to **stderr**, keeping stdout free for
// the machine-readable output a caller pipes. This fake used to print them to
// stdout, which copied WHAT the real CLI prints but not WHERE — so every fixture
// asserting `verification_gates` was exercising a stream the real CLI never uses,
// and the runner's "read stdout only" bug (#160) stayed green here while it
// emptied `verification.gates` on every real contract pass. Keep this on stderr:
// it is the only thing making those assertions mean anything.
function writeGateLine(line) {
  process.stderr.write(`${line}\n`);
}

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
  process.exit(0);
}
function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// A scenario's `delay_ms` makes a subcommand take real time — the one thing a
// local fake otherwise cannot model. `commandmate wait` blocks on a worker turn
// and the profile baseline runs a repository's whole test suite; both collapse
// to zero here, so a wall-clock budget (#122) would never be reached and its
// fixture would prove nothing. Written as `{"delay_ms": {"wait": 400}}`, keyed by
// subcommand. The sleep is synchronous on purpose: the runner measures the child
// process's elapsed time, and the child is this process.
function applyDelay(spec) {
  const ms = Number((spec.delay_ms ?? {})[sub] ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// How git PRINTS a pathname (Issue #174). `git diff --name-only|--numstat` does
// not emit the path it holds: `quote_c_style` wraps it in double quotes and
// escapes the offending bytes whenever the path contains `"`, a backslash or a
// control character — and, while `core.quotePath` is true (git's default), every
// byte >= 0x80 as a three-digit octal escape. That is why a UTF-8 path from
// `plan.json` never equalled the "same" path from a diff. `-c
// core.quotePath=false` only removes the third rule; only `-z` turns the munging
// off entirely, which is what this models: the caller passing `-z` never reaches
// here.
//
// Bytes, not code units: the escapes are per UTF-8 byte, so the path is encoded
// first and reassembled at the end (a non-ASCII byte left unquoted must go back
// out unchanged).
const C_ESCAPES = new Map([[0x07, '\\a'], [0x08, '\\b'], [0x0c, '\\f'], [0x0a, '\\n'], [0x0d, '\\r'], [0x09, '\\t'], [0x0b, '\\v']]);
function cQuotePath(path, quotePath) {
  const out = [];
  let quoted = false;
  for (const byte of Buffer.from(path, 'utf8')) {
    if (byte === 0x22 || byte === 0x5c) {
      quoted = true;
      out.push(0x5c, byte);
    } else if (byte < 0x20 || byte === 0x7f || (byte >= 0x80 && quotePath)) {
      quoted = true;
      const escape = C_ESCAPES.get(byte) ?? `\\${byte.toString(8).padStart(3, '0')}`;
      out.push(...Buffer.from(escape, 'ascii'));
    } else {
      out.push(byte);
    }
  }
  return quoted ? `"${Buffer.from(out).toString('utf8')}"` : path;
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
    if (sub === 'sync' && spec.cli_sync === false) {
      fail(`error: unknown command 'sync'`, 1);
    }
    process.stdout.write(`${helpFor(sub, spec)}\n`);
    process.exit(0);
  }
  refuseGatedFlags(spec);
  // After the --help gate, so the version probe stays instant and only the calls
  // a real run spends its clock on are slowed.
  applyDelay(spec);

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
  if (sub === 'symbolic-ref') {
    // `git symbolic-ref -q HEAD` — the detached-HEAD probe uat.mjs's stage-C
    // pre-flight runs (Issue #142 / ADR §14.3). `head_ref` is the knob:
    //   absent        -> refs/heads/<git.branch>, i.e. the same branch
    //                    `rev-parse --abbrev-ref HEAD` reports, so a scenario
    //                    written before this knob answers both probes the same way
    //   null | false  -> DETACHED: exit 1 with no output, which is what `-q` turns
    //                    a detached HEAD into (without `-q` it is exit 128 + a
    //                    message on stderr)
    //   "<branch>"    -> that branch, whatever `git.branch` says
    const git = spec.git ?? {};
    const head = 'head_ref' in git ? git.head_ref : (git.branch ?? 'feature/integration');
    if (head === null || head === false) process.exit(1);
    process.stdout.write(`refs/heads/${head}\n`);
    process.exit(0);
  }
  if (sub === 'rev-list') {
    // `git rev-list --count <base>..HEAD`, run INSIDE a worktree: how many
    // commits the work branch carries over the base. It is one half of the
    // work-evidence measurement `--reverify` selects its targets by (Issue #121),
    // and it answers from the same commit model `git rev-parse HEAD` does, so the
    // two can never disagree about whether the worker committed.
    process.stdout.write(`${commitsFor(spec, issueFromCwd())}\n`);
    process.exit(0);
  }
  if (sub === 'status') {
    const git = spec.git ?? {};
    // From a worktree cwd this is the OTHER half of the work-evidence
    // measurement, so a scenario answers it per worker (`uncommitted: true`).
    // Falls back to the run-wide `git.dirty` — which is what the integration
    // directory's drift check reads — whenever the worker says nothing, so every
    // scenario written before this knob is unchanged.
    const issue = issueFromCwd();
    const worker = issue === null ? {} : workerSpec(spec, issue);
    const dirty = worker.uncommitted === undefined ? git.dirty : Boolean(worker.uncommitted);
    process.stdout.write(dirty ? ' M some/file.ts\n' : '');
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
    // the harness) so the dispatch `worktrees_present` probe can see them. A
    // worktree the provider created counts immediately: git knows it the moment
    // it exists, and only the CommandMate server needs the sync (Issue #93).
    const git = spec.git ?? {};
    const paths = git.worktrees ?? [...(spec.worktrees ?? []), ...preparedRows(spec)].map((w) => w.path).filter(Boolean);
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
  if (sub === 'diff') {
    // `git diff --name-only|--numstat <base>...<branch>`, run by merge.mjs inside
    // the issue's worktree to read what the branch ACTUALLY changed (Issue #97).
    // The issue is recovered from the diff range (…issue-<n>…), falling back to
    // the cwd the runner spawned this in — the worktree carries the number too.
    //
    // Scenario shape, per issue: `{ files: [...] }`, or the string "fail" to model
    // a worktree that is gone / a range git cannot resolve. The harness injects a
    // default of the issue's own plan scope, so a case that says nothing models
    // the ordinary scope-clean branch and only a case that CARES declares a diff.
    const range = argv[argv.length - 1];
    const issue = issueFromBranch(range) ?? issueFromCwd();
    const diff = (spec.diff ?? {})[issue] ?? (spec.diff ?? {})[String(issue)] ?? {};
    if (diff === 'fail') fail(`fatal: ambiguous argument '${range}': unknown revision or path not in the working tree`, 128);
    const files = Array.isArray(diff.files) ? diff.files : [];
    // Path MUNGING (Issue #174). Real git does not print the pathname it holds:
    // unless `-z` is given it C-quotes anything it considers unsafe and separates
    // the results with newlines. A fake that echoed the scenario's paths verbatim
    // modelled a git nobody runs, and made the escaping bug invisible here while
    // it misreported every non-ASCII path in production.
    const nul = argv.includes('-z');
    const render = (file) => (nul ? file : cQuotePath(file, gitConfig.get('core.quotepath') !== 'false'));
    // Deterministic per-file line counts: the Nth changed file is +10N / -N, so a
    // fixture can assert an exact "+X / -Y" summary without pinning real content.
    const body = argv.includes('--numstat')
      ? files.map((file, i) => `${(i + 1) * 10}\t${i + 1}\t${render(file)}`)
      : files.map(render);
    // `-z` TERMINATES each record with NUL (it does not separate them), so the
    // output of a one-file diff ends in NUL and an empty diff is empty.
    process.stdout.write(body.length ? `${body.join(nul ? '\0' : '\n')}${nul ? '\0' : '\n'}` : '');
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

  // --- cmate-worktree-setup provider (Issue #93) ---------------------------
  if (sub === 'worktree-setup') {
    // Invoked by dispatch as `<launcher> --issues <n,n> --profile <id> --base <ref>`.
    // The contract is the STDOUT DOCUMENT (worktree-setup.result.v1); the exit
    // code only matters when that document is unusable, so a scenario can drive
    // the two independently.
    const setup = spec.worktree_setup ?? {};
    const requested = String(optionValue('--issues') ?? '')
      .split(',').map((value) => value.trim()).filter(Boolean).map(Number);
    if (setup.emit === 'not_a_document') {
      process.stdout.write('worktree-setup: prepared 1 worktree(s)\n');
      process.exit(setup.exit ?? 0);
    }
    const creatable = Array.isArray(setup.create) ? setup.create.map(Number) : requested;
    const overrides = setup.branch_override ?? {};
    const worktrees = [];
    const baseline = [];
    for (const issue of requested) {
      const row = (spec.prepared_worktrees ?? []).find((entry) => issueFromBranch(entry.branch) === String(issue));
      if (!row || !creatable.includes(issue)) {
        // Planned but not created — the collision shape the Skill records rather
        // than forcing (created and reused both false).
        worktrees.push({
          issue_number: issue,
          branch: row?.branch ?? `feature/issue-${issue}-unknown`,
          directory: row?.path ?? `../unknown-issue-${issue}`,
          base_sha: null,
          created: false,
          reused: false,
          note: 'a branch of this name already exists; not overwritten',
        });
        baseline.push({ issue_number: issue, command: 'cat cmate-verify-ok', outcome: 'not_run', exit_code: null, redacted: false, output_excerpt: null });
        continue;
      }
      const marker = preparedMarkerPath(issue);
      const absDir = resolve(process.cwd(), row.path);
      try {
        mkdirSync(absDir, { recursive: true });
        if (workerSpec(spec, issue).verify === 'pass') writeFileSync(join(absDir, VERIFY_MARKER), 'ok');
        if (marker) writeFileSync(marker, 'prepared');
      } catch {
        // best effort; an uncreated directory surfaces as a baseline failure
      }
      worktrees.push({
        issue_number: issue,
        branch: overrides[issue] ?? overrides[String(issue)] ?? row.branch,
        directory: row.path,
        base_sha: SETUP_BASE_SHA,
        created: true,
        reused: false,
        note: null,
      });
      baseline.push({ issue_number: issue, command: 'cat cmate-verify-ok', outcome: 'pass', exit_code: 0, redacted: false, output_excerpt: null });
    }
    const created = worktrees.filter((entry) => entry.created).length;
    const status = setup.status ?? (created === 0 ? 'failure' : created === requested.length ? 'success' : 'partial');
    process.stdout.write(`${JSON.stringify(setupResultDocument(spec, requested, worktrees, baseline, status))}\n`);
    process.exit(setup.exit ?? 0);
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

  // --- gh issue view (dispatch.mjs, Issue #176) ----------------------------
  //
  // `gh issue view <n> --repo <owner/repo> --json body`. The dispatch runner reads
  // the body to transcribe its prohibitions into the task text, so the world this
  // serves has to be the SAME body the plan was built from — otherwise a fixture
  // would pin a contract generated from one issue against a plan generated from
  // another. run_tests.mjs injects `gh.issues` straight from the case's planner
  // fixture for exactly that reason; nothing here invents a body.
  //
  // An issue the scenario knows nothing about FAILS rather than returning an empty
  // body: "the body is empty" and "nobody could read the body" are different facts
  // and the runner reports them differently. `gh.issue_view: "fail"` injects the
  // second one for a known issue (no network, no auth, no `gh`).
  if (sub === 'issue') {
    const gh = spec.gh ?? {};
    if (String(argv[1] ?? '') !== 'view') fail(`fake-cli: unsupported gh issue subcommand "${argv[1] ?? ''}"`);
    if (gh.issue_view === 'fail') fail('gh: could not read the issue (HTTP 403)');
    const number = String(argv[2] ?? '');
    const known = gh.issues ?? {};
    if (!Object.prototype.hasOwnProperty.call(known, number)) {
      fail(`gh: no issue ${number} in this scenario (the case's issue fixture is what the fake serves)`);
    }
    emit({ body: String(known[number] ?? '') });
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
    // the worktrees the harness injected from the plan's branches, plus any
    // `sync_worktrees` row once a `commandmate sync` has registered it (#91).
    const rows = visibleWorktrees(spec);
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(rows)}\n`);
      process.exit(0);
    }
    process.stdout.write(`${rows.map((w) => w.id).join('\n')}\n`);
    process.exit(0);
  }
  if (sub === 'sync') {
    // `commandmate sync` — the server-side worktree re-scan. `cli_sync: false`
    // models a CommandMate older than 0.21.0, which has no such subcommand: the
    // call fails and nothing becomes visible, which is the world the runner's
    // "sync failed, the branch stays unresolved" path is judged against.
    if (spec.cli_sync === false) fail(`error: unknown command 'sync'`, 1);
    const marker = syncMarkerPath();
    if (marker) {
      try {
        writeFileSync(marker, 'synced');
      } catch {
        // best effort; a sync-only row simply stays invisible if we cannot record it
      }
    }
    // The re-scan registers what exists AT THIS MOMENT. A worktree created after
    // this call stays unregistered until the next one (Issue #93).
    for (const row of preparedRows(spec)) {
      const registered = registeredMarkerPath(issueFromBranch(row.branch));
      try {
        if (registered) writeFileSync(registered, 'registered');
      } catch {
        // best effort; the row simply stays invisible to `ls`
      }
    }
    process.stdout.write(`Synced ${(spec.sync_worktrees ?? []).length} worktree(s)\n`);
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
      const row = visibleWorktrees(spec).find((entry) => entry.id === worktreeId);
      const absolute = resolve(process.cwd(), row?.path ?? '.', contractPath);
      if (!existsSync(absolute)) {
        fail(`Error: invalid task contract:\n  - ${contractPath}: contract file not found in the worktree`, 2);
      }
      const taskId = `task-issue-${issue}`;
      // The contract this send RECORDED is what the server's Auto-Yes poller
      // later reads its policy out of (Issue #136), so the path is remembered
      // exactly as the real server remembers the task's contract snapshot.
      recordContractPath(issue, absolute);
      process.stderr.write(`Task created: ${taskId}\n`);
      process.stdout.write(`${taskId}\n`);
    }
    // `--auto-yes` enables auto-yes on the worktree BEFORE sending (Issue #136;
    // the real CLI's send.js posts /api/worktrees/<id>/auto-yes first). Without
    // that state the poller does not start at all, whatever the contract says, so
    // this marker is the fake's `autoYesState.enabled`.
    if (argv.includes('--auto-yes')) enableAutoYes(issue);
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
    // The prompt's TYPE is what the contract's autoYes policy is judged against
    // (Issue #136). `yes_no` is the default so every scenario written before this
    // behaves exactly as it did; Claude's permission menu is `multiple_choice`,
    // the type `mode: safe` refuses.
    const promptType = worker.prompt_type ?? 'yes_no';
    // The server-side poller may answer the prompt BEFORE this wait returns it.
    // When it does, the caller never sees exit 10 at all — which is what
    // "--auto-yes worked" looks like from the runner's side, and the only thing
    // that distinguishes it from the runner answering the prompt itself.
    if (state === 'prompt' && serverAnswersPrompt(spec, issue, worktreeId, promptType)) {
      if (marker) {
        try {
          writeFileSync(marker, 'auto-yes-poller');
        } catch {
          // best effort; the worker simply raises the same prompt again
        }
      }
      state = 'completed';
    }
    if (state === 'completed') {
      if (!argv.includes('--verify')) process.exit(WAIT_COMPLETED);
      // Issue #114: with `run_declared_gates` the verdict is not a knob — the
      // gates declared in the worktree's verify.yaml are really executed there,
      // so the exit code follows the DELIVERABLE. That is what lets an
      // acceptance-gate fixture measure two points (adapted → green, mutated →
      // red) instead of asserting that the fake was told to say 20.
      if (spec.run_declared_gates) {
        const run = runDeclaredGates(spec, issue, worktreeId);
        for (const line of run.lines) writeGateLine(line);
        process.exit(run.exit);
      }
      // Like the real CLI (verify-runner's reportGates), a judged run prints one
      // `GATE <id> PASS|FAIL` line per executed gate (#1678 B-5): pass runs list
      // work-evidence plus the scenario's pass_gates (default ['baseline']),
      // fail runs list work-evidence plus the failed_gates. Exit 99 judged
      // nothing, so nothing is printed. They go to STDERR — see writeGateLine.
      const exit = verifyExitFor(worker, issue);
      const gateLines = [];
      if (exit === 0) {
        gateLines.push('GATE work-evidence PASS');
        for (const id of worker.pass_gates ?? ['baseline']) gateLines.push(`GATE ${id} PASS`);
      } else if (exit === VERIFY_FAILED) {
        gateLines.push('GATE work-evidence PASS');
        for (const entry of failedGatesFor(worker, issue)) {
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
      for (const line of gateLines) writeGateLine(line);
      process.exit(exit);
    }
    if (state === 'prompt') {
      // `confirm` is what this fake has always emitted for a yes/no prompt; a
      // `multiple_choice` scenario emits the detector's own vocabulary and the
      // shape of Claude's permission menu, because that is the prompt whose type
      // the policy decides (Issue #136).
      const promptJson = promptType === 'multiple_choice'
        ? {
          worktreeId,
          cliToolId: 'claude',
          type: 'multiple_choice',
          question: promptQuestion(worker),
          options: ['1. Yes', '2. Yes, and don\'t ask again this session', '3. No, and tell Claude what to do differently'],
          status: 'pending',
        }
        : { worktreeId, cliToolId: 'claude', type: 'confirm', question: promptQuestion(worker), options: [], status: 'pending' };
      process.stdout.write(`${JSON.stringify(promptJson)}\n`);
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
    // logTail lists the out-of-scope paths (#1678 B-2). Under
    // `run_declared_gates` the list is not declared at all: it is whatever really
    // failed when the worktree's own gates were run, so the breakdown the runner
    // reads names the actual command and its actual exit status (Issue #114).
    const failedGates = spec.run_declared_gates
      ? runDeclaredGates(spec, issue, worktreeId).failing
      : failedGatesFor(worker, issue);
    // The gates a PASSING run names. Empty by default, so every scenario written
    // before `--reverify` keeps the document it had; a case that re-judges a
    // worktree in place declares `pass_gates` so the report can say what the
    // pass was based on (Issue #121 / #1678 B-5).
    const passGates = failedGates.length === 0 && !spec.run_declared_gates
      ? (worker.pass_gates ?? [])
      : [];
    const gates = [
      { gateId: 'work-evidence', status: 'passed', exitCode: null, durationMs: 12, logTail: 'commits=1 uncommitted=0' },
      ...passGates.map((id) => ({ gateId: id, status: 'passed', exitCode: 0, durationMs: 210, logTail: `${id}: ok` })),
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
    // `verify` reports the VERDICT by exit code, exactly as `wait --verify` does.
    // Derived from the gates by default; `verify_exit` overrides it so a scenario
    // can model the two verdicts the gate list cannot express — 21 (the
    // work-evidence gate finding nothing) and 99 (the run ending error/cancelled
    // with no verdict at all) — which `--reverify` must handle the same way the
    // ordinary path does (Issue #121).
    process.exit(Number.isInteger(worker.verify_exit)
      ? worker.verify_exit
      : (failedGates.length > 0 ? VERIFY_FAILED : 0));
  }
  if (sub === 'capture') {
    // `commandmate capture <worktree-id> --json` — CurrentOutputResponse shape.
    // Reports the worker's live state so the supervisor can (a) present a pending
    // prompt and (b) confirm a send actually registered (Issue #1468). A prompt
    // worker shows a pending prompt until it is answered; otherwise the worker is
    // "generating" only once it has received `confirm_after` sends (default 1), so
    // a scenario can withhold that signal to exercise the send-confirm/re-send path.
    //
    // Liveness at a wait timeout (Issue #179). `--wait-timeout` bounds ONE
    // `commandmate wait`, not the worker, so a timeout is either "the runner
    // stopped watching" or "the worker stopped" — and `capture` is the only thing
    // that can tell them apart. `workers.<n>.capture` injects that answer:
    //
    //   (absent)      the default above: running once `confirm_after` sends landed
    //   "idle"        a session that answers, with no sign of work in flight
    //   "fail"        the call itself fails (exit 1) — NOTHING was measured
    //   "unparseable" exit 0 with output that is not the documented JSON
    //
    // The last two are the world acceptance condition 4 is about: a runner that
    // reads them as either verdict is worse than one that says it could not look.
    // `idle`/`fail` also hold back the send-confirmation signal, so a worker in
    // those worlds is re-sent once — the same world, told consistently.
    const worktreeId = argv[1];
    const issue = issueFromId(worktreeId);
    const worker = workerSpec(spec, issue);
    if (worker.capture === 'fail') fail('capture: could not read the session for this worktree', 1);
    if (worker.capture === 'unparseable') {
      process.stdout.write('Session: <no output captured>\n');
      process.exit(0);
    }
    const marker = respondedMarkerPath(issue);
    const responded = Boolean(marker && existsSync(marker));
    if (worker.state === 'prompt' && !responded) {
      const prompt = promptQuestion(worker);
      emit({
        isRunning: true,
        isGenerating: false,
        isPromptWaiting: true,
        content: prompt,
        promptData: { type: (worker.prompt_type ?? 'yes_no') === 'multiple_choice' ? 'multiple_choice' : 'confirm', question: prompt, options: [], status: 'pending' },
        sessionStatus: 'waiting',
      });
    }
    const confirmAfter = typeof worker.confirm_after === 'number' ? worker.confirm_after : 1;
    const started = worker.capture === 'idle' ? false : readSends(issue) >= confirmAfter;
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
