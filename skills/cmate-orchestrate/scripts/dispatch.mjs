#!/usr/bin/env node
// cmate-orchestrate — dispatch and supervision runner (Node stdlib only, Node >= 22).
//
// This runner does the *execution* half of official CommandMate issue
// orchestration. It takes an already-approved plan produced by the plan-core
// runner (scripts/orchestrate.mjs) and drives it, wave by wave, against the
// public `commandmate` CLI:
//
//   - it resolves each issue's CommandMate worktree id AND real path from a single
//     `commandmate ls --json` row matched on the plan's branch (Issue #1473).
//     Because `send`/`wait`/`capture` (id) and the git operations below (path)
//     both come from that one row, they can never diverge onto different
//     worktrees; the plan's template path is only a fallback when `ls` omits a
//     path;
//   - it dispatches each issue under an EXECUTION CONTRACT when the CommandMate in
//     front of it supports one (Issue #1588): it generates
//     `.commandmate/tasks/cmate-orchestrate-issue-<n>.yaml` deterministically from
//     the approved plan, places it in the worktree, and sends it with `commandmate
//     send <worktree-id> --contract <path>`, which records a task row and prints
//     the TASK ID on stdout. (`send` also still takes a plain positional message —
//     that is the fallback path below.) The verdict then comes from CommandMate
//     itself instead of from a re-implementation here;
//   - it supervises each worker as a loop, not a single wait (Issue #1468): a real
//     worker idles after every turn, so `commandmate wait` returning exit 0 means
//     "idle", not "done". Completion is a NEW COMMIT on the worktree branch (read
//     with `git rev-parse HEAD` inside the ls-resolved path). While the worker
//     idles without a new commit the runner nudges it to keep going, bounded by
//     --max-turns; a prompt (exit 10) STOPS and is presented (via `commandmate
//     capture --json`) to a human — it never auto-answers unless --auto-yes;
//     hitting the turn cap with no commit is an honest `failed`, never a false
//     completion. Within a wave every worker's supervision loop runs CONCURRENTLY
//     (Issue #1474): `wait` blocks until its worker idles, so the wave takes the
//     slowest single worker instead of the sum, with runtime parallelism bounded
//     by the wave width (already <= max_parallel);
//   - it enforces a wave barrier: the next wave dispatches only when every worker
//     of the previous wave completed (committed) AND its verification passed.
//     Under a contract the verdict is `commandmate wait --verify`'s EXIT CODE
//     (0 pass / 20 judged-and-failed / 21 no work evidence / 99 NO VERDICT AT ALL);
//     without one it falls back to re-running the profile baseline inside the
//     worktree. Worker completion and verification success are kept strictly
//     separate, and a 99 is never folded into 20 — "we could not judge" must not
//     be re-instructed as "we judged it and it failed";
//   - it version-gates that choice out loud: `send --help` / `wait --help` are
//     probed once at start-up and the mode it settled on is stated in the report,
//     so the run never degrades silently to the weaker check;
//   - it honors max_parallel (1-3): a wave is never wider than the bound;
//   - before every mutating wave it re-checks post-plan drift
//     (branch / HEAD / worktree / permission) and refuses to dispatch on drift.
//
// The CLI surface it shells out to is documented in
// references/dispatch-contract.md. Every external command is injectable
// (--cli / --git / --gh) so the behavior can be exercised against a fake CLI
// without touching a real repository. Tokens, secrets, absolute paths and raw
// terminal output are redacted before they reach the report or an artifact.

import { parseArgs, promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SKILL_ID,
  SKILL_VERSION,
  SkillError,
  issueOf,
  parseCliJson,
  redact,
  redactionsList,
  resolveLauncher,
  safeWorktreeTarget,
} from './lib.mjs';

const DISPATCH_SCHEMA_VERSION = 1;
const SUPPORTED_PLAN_SCHEMA_VERSION = 1;

const MAX_PARALLEL_MAX = 3;

// A CommandMate worktree id (mirrors the CLI's isValidWorktreeId): an
// alphanumeric-led token of [A-Za-z0-9_-], at most 200 chars. The runner refuses
// to hand anything else to `commandmate send/wait/capture`.
const WORKTREE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

// `commandmate wait` reports the worker's terminal state by EXIT CODE, not by a
// JSON field: 0 the worker went idle (a turn finished), 10 a prompt is awaiting
// input (prompt JSON on stdout), 124 the --timeout elapsed. Any other non-zero
// exit is an infrastructure failure. IMPORTANT (Issue #1468): a real Claude worker
// idles after every TURN, so exit 0 means "idle", not "task done". Completion is
// detected separately, from a new commit on the worktree branch.
const WAIT_EXIT_IDLE = 0;
const WAIT_EXIT_PROMPT = 10;
const WAIT_EXIT_TIMEOUT = 124;

// `commandmate wait --verify` and `commandmate verify` report the VERDICT by exit
// code (CommandMate 0.17.0 / Issue #1544):
//
//   0    passed          — every gate ran and passed
//   20   VERIFY_FAILED   — a gate failed, timed out or errored: judged, and failed
//   21   NOT_STARTED     — the work-evidence gate found no commit and no change
//   99   UNEXPECTED_ERROR— the run ended `error`/`cancelled`: NO VERDICT WAS REACHED
//   124  TIMEOUT
//   1/2  infrastructure (dependency / configuration)
//
// 99 is the one that must never be folded into 20. CommandMate's own source says
// why: "`error` and `cancelled` mean no verdict was reached, so they take the
// generic UNEXPECTED_ERROR code rather than VERIFY_FAILED — a caller branching on
// 20 must be able to trust that gates actually ran and judged the work." A 99 is
// therefore escalated to a human, not fed to the re-instruction loop: asking a
// worker to repair something nobody ever judged is asking it to guess.
const VERIFY_EXIT_PASS = 0;
const VERIFY_EXIT_FAILED = 20;
const VERIFY_EXIT_NOT_STARTED = 21;
const VERIFY_EXIT_NO_VERDICT = 99;

// Gate statuses that mean the gate did not pass (mirrors FAILED_GATE_STATUSES in
// CommandMate's verify command). `skipped` is not a failure.
const FAILED_GATE_STATUSES = new Set(['failed', 'timeout', 'error']);

// How the run decides whether to dispatch under an execution contract.
//   auto    probe the CLI; use a contract when it has one, fall back (loudly) otherwise
//   require probe the CLI; refuse to dispatch at all when it has none
//   off     do not probe; use the legacy profile-baseline verification
const CONTRACT_MODES = ['auto', 'require', 'off'];
const DEFAULT_CONTRACT_MODE = 'auto';

// Where the contract is placed inside the worktree. CommandMate resolves
// `--contract` relative to the worktree root, and `.commandmate/tasks/**` is
// excluded from both the work-evidence count and the scope gate (#1580), so
// dropping the file in needs neither a commit nor a base merge.
const CONTRACT_DIR = '.commandmate/tasks';
const CONTRACT_FILE_PREFIX = 'cmate-orchestrate-issue-';

// Bounds from CommandMate's contract parser (docs/design/task-contract.md v1).
// Enforced here so a contract this runner writes is rejected locally rather than
// by the server after a task row already exists.
const MAX_CONTRACT_TITLE = 200;
const MAX_CONTRACT_GOAL = 8000;
const MAX_SCOPE_PATTERNS = 200;
const MAX_SCOPE_PATTERN_LENGTH = 200;
const MAX_GATE_IDS = 32;
const GATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// The id `send --contract` prints on stdout. Kept deliberately permissive (the
// real one is a UUID) but bounded, so a stray log line never becomes a task id.
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// The per-worker `commandmate wait` timeout. `wait` blocks internally until the
// worker idles, raises a prompt, or this timeout elapses. --poll-limit is retained
// for input compatibility but no longer drives a polling loop (there is none).
const DEFAULT_WAIT_TIMEOUT_SECONDS = 300;
const DEFAULT_POLL_LIMIT = 120;

// The supervision loop drives each worker turn by turn. Because a worker idles
// after every turn without necessarily being done, the runner nudges it to keep
// going until it commits — bounded by this many turns (initial send + nudges).
// Reaching the cap with no commit is an honest `failed`, never a false completion.
const DEFAULT_MAX_TURNS = 8;

// The artifacts a dispatch attempt writes, and where a resume appends the next
// attempt's copies (Issue #98). Attempt 1 keeps the run directory's root, so
// every existing reader — merge, uat, the status matrix — finds exactly what it
// found before; attempt N writes the SAME file names one directory down, under
// `resume-attempt-<N>/`, and never touches an earlier attempt's bytes.
const DISPATCH_REPORT_FILE = 'dispatch-report.json';
const DISPATCH_SUMMARY_FILE = 'dispatch-summary.md';
const RESUME_ATTEMPT_PREFIX = 'resume-attempt-';
// The append-only ledger of attempts, at the run directory's root. It is the
// machine-readable half of the attempt history: which report each attempt wrote,
// which report it resumed from, what it carried over and what it re-dispatched.
const ATTEMPT_HISTORY_FILE = 'attempt-history.jsonl';
// A bound on the attempt search, so a directory somebody filled with
// `resume-attempt-*` names cannot turn a resume into an unbounded scan.
const MAX_ATTEMPTS = 99;

// =============================================================================
// Redaction (SkillError, the pattern list and redact/redactionsList are shared
// with the merge and uat runners in lib.mjs)
// =============================================================================

// A short, redacted excerpt of terminal-ish output. The raw stream is never
// stored: a bounded tail is enough for a human to act on a prompt or a failure.
// NOT shared with merge/uat: an empty excerpt is `null` here and `''` there,
// because the dispatch report schema makes this field nullable.
function excerpt(value, limit = 280) {
  const text = redact(value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text || null;
  return `…${text.slice(text.length - limit)}`;
}

// =============================================================================
// Argument parsing
// =============================================================================

const USAGE = `cmate-orchestrate dispatch runner (executes an approved plan)

Usage:
  dispatch.mjs --plan <path> [options]

Options:
  --plan <path>          Approved plan.json from the plan-core runner (required).
  --out <dir>            Where dispatch artifacts are written
                         (default: <plan-dir>/dispatch). Mutually exclusive with
                         --resume, which appends into the prior run's directory.
  --resume <dir>         Resume a partially failed dispatch: <dir> is the --out
                         directory of the run being resumed. The newest report in
                         it is read, every issue whose worker completed AND whose
                         verification passed is carried over instead of being
                         re-dispatched (its verdict is transcribed, not re-run),
                         and only the rest is dispatched. The wave barrier is
                         recomputed, so an issue whose dependency already passed
                         is dispatched without waiting. Artifacts are appended
                         under <dir>/${RESUME_ATTEMPT_PREFIX}<n>/; nothing is
                         overwritten. Refused when the report was produced for a
                         different plan.
  --cli <launcher>       The CommandMate launcher to drive: an executable plus
                         fixed leading arguments, split on whitespace and run
                         WITHOUT a shell — "commandmate" (default),
                         "/usr/local/bin/commandmate", "npx commandmate@latest".
                         Falls back to $CM (monitor.sh's variable) when omitted.
                         Shell syntax is refused; wrap it in a script instead.
  --git <path>           The git CLI used for drift checks (default "git").
  --gh <path>            The gh CLI used for the repo-access check (default "gh").
  --auto-yes             Answer worker prompts automatically. OFF by default; a
                         prompt otherwise halts the loop for a human.
  --allow-questions      Dispatch a plan whose issues still carry unanswered
                         open questions. OFF by default: an issue the planner
                         could not read acceptance criteria or affected files
                         out of halts the run before anything is dispatched.
                         Setting this records that an operator took the risk.
  --prepare-worktrees    Prepare the worktrees the pre-flight could not resolve,
                         by invoking the cmate-worktree-setup provider named by
                         --worktree-setup, re-scanning the registry and resolving
                         again before the first wave. OFF by default: without it
                         an unresolved worktree stops the run exactly as before.
  --worktree-setup <launcher>
                         The cmate-worktree-setup provider --prepare-worktrees
                         invokes: an executable plus fixed leading arguments,
                         split on whitespace and run WITHOUT a shell. It is called
                         as "<launcher> --issues <n,n> --profile <id> --base <ref>"
                         and must print a worktree-setup.result.v1 document on
                         stdout. Passing --profile/--base/--issues yourself is
                         refused: all three come from the approved plan.
  --contract-mode <m>    auto (default) | require | off. auto dispatches under an
                         execution contract when the CLI supports one and falls
                         back to the profile baseline with an explicit limitation
                         otherwise; require refuses to fall back; off never
                         probes and always uses the profile baseline.
  --verify-gates <ids>   Comma-separated verify.yaml gate ids to name in the
                         contract's verify.gates. Omitted means every gate the
                         repository declares (this runner never invents an id).
  --expect-branch <name> Integration branch the plan was approved from; a
                         mismatch at dispatch time is treated as drift.
  --wait-timeout <sec>   --timeout passed to commandmate wait (default ${DEFAULT_WAIT_TIMEOUT_SECONDS}).
  --max-turns <n>        Max turns to drive each worker (initial send + nudges)
                         before giving up with no commit (default ${DEFAULT_MAX_TURNS}).
  --poll-limit <n>       Retained for compatibility; wait now blocks (default ${DEFAULT_POLL_LIMIT}).
  --help                 Show this help.

The dispatch runner mutates: it sends work to real workers, nudging each until it
commits its work (a worker idles after every turn, so idle is not "done"). It
refuses to dispatch on post-plan drift and never answers a worker prompt on its own.`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        plan: { type: 'string' },
        out: { type: 'string' },
        resume: { type: 'string' },
        cli: { type: 'string' },
        git: { type: 'string' },
        gh: { type: 'string' },
        'auto-yes': { type: 'boolean' },
        'allow-questions': { type: 'boolean' },
        'prepare-worktrees': { type: 'boolean' },
        'worktree-setup': { type: 'string' },
        'contract-mode': { type: 'string' },
        'verify-gates': { type: 'string' },
        'expect-branch': { type: 'string' },
        'wait-timeout': { type: 'string' },
        'max-turns': { type: 'string' },
        'poll-limit': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new SkillError('invalid_input', error.message, 3);
  }
  return parsed;
}

function positiveInt(raw, name, fallback) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) < 1) {
    throw new SkillError('invalid_input', `${name} must be a positive integer`, 3);
  }
  return Number.parseInt(raw, 10);
}

// `--contract-mode` is validated here rather than defaulted silently: a typo'd
// mode that fell back to `auto` would look like the operator chose the fallback.
function resolveContractMode(raw) {
  if (raw === undefined) return DEFAULT_CONTRACT_MODE;
  if (!CONTRACT_MODES.includes(raw)) {
    throw new SkillError('invalid_input', `--contract-mode must be one of ${CONTRACT_MODES.join(', ')}`, 3);
  }
  return raw;
}

// Gate ids for the contract's `verify.gates`. They are checked against
// CommandMate's own GATE_ID_PATTERN and bounds so an unusable list fails here,
// where the message is about the flag, instead of at `send --contract` (exit 2)
// where it is about a file this runner wrote.
function resolveVerifyGates(raw) {
  if (raw === undefined) return [];
  const ids = String(raw).split(',').map((value) => value.trim()).filter((value) => value !== '');
  if (ids.length === 0) {
    throw new SkillError('invalid_input', '--verify-gates must name at least one gate id', 3);
  }
  if (ids.length > MAX_GATE_IDS) {
    throw new SkillError('invalid_input', `--verify-gates accepts at most ${MAX_GATE_IDS} gate ids`, 3);
  }
  const seen = new Set();
  for (const id of ids) {
    if (!GATE_ID_RE.test(id)) {
      throw new SkillError('invalid_input', `--verify-gates: "${id}" is not a valid gate id (${GATE_ID_RE.source})`, 3);
    }
    if (seen.has(id)) {
      throw new SkillError('invalid_input', `--verify-gates: duplicate gate id "${id}"`, 3);
    }
    seen.add(id);
  }
  return ids;
}

// Flags the worktree-setup provider must not be handed a second time (Issue #93).
// The profile, the base and the issue set come from the APPROVED PLAN; a provider
// invoked with a second, operator-supplied profile resolves a different
// `branch_template` and creates branches the plan does not name. The symptom of
// that is "no registered worktree matches branch …" — a message about the
// registry, for a cause that is a disagreement between two profiles. Refusing the
// double specification here is what keeps the two sides on one profile.
const SETUP_RESERVED_FLAGS = ['--profile', '--profile-json', '--base', '--repo', '--issues', '--issue-numbers'];

// The provider launcher. It shares `--cli`'s guards (no shell syntax, no control
// characters, program first) but NOT its fallbacks: `$CM` names the CommandMate
// CLI, which is not a worktree-setup provider, and there is no sensible default
// binary to guess — an unset provider is the "not installed" case (ADR section 5),
// not something to fill in.
function resolveSetupLauncher(raw, prepareWorktrees) {
  if (raw === undefined) return null;
  if (!prepareWorktrees) {
    throw new SkillError('invalid_input',
      '--worktree-setup needs --prepare-worktrees: a provider that is never invoked is a silent no-op', 3);
  }
  let argv;
  try {
    argv = resolveLauncher(raw, {});
  } catch (error) {
    // resolveLauncher names the flag it was written for; this is the same guard
    // reached through a different flag, so the advice must name that one.
    throw new SkillError('invalid_input', String(error.detail ?? error.message).replace(/^--cli /, '--worktree-setup '), 3);
  }
  for (const token of argv.slice(1)) {
    const flag = String(token).split('=')[0];
    if (SETUP_RESERVED_FLAGS.includes(flag)) {
      throw new SkillError('invalid_input',
        `--worktree-setup must not carry ${flag}: the profile, the base and the issue set come from the approved plan, ` +
          'and a second value for them is how the two sides end up creating different branches', 3);
    }
  }
  return argv;
}

function resolveInputs(parsed) {
  const { values } = parsed;
  if (!values.plan) {
    throw new SkillError('invalid_input', '--plan <path> is required', 3);
  }
  // The launcher is argv, not a program name: `npx commandmate@latest` is two
  // tokens and execFileSync takes no shell (Issue #37). `cli` keeps the resolved
  // string for messages; every spawn goes through cliArgv.
  const cliArgv = resolveLauncher(values.cli);
  const prepareWorktrees = Boolean(values['prepare-worktrees']);
  // `--out` claims a NEW directory (and refuses an existing one); `--resume`
  // appends into an EXISTING one. Accepting both would mean guessing which of the
  // two the operator meant, and the wrong guess either overwrites the prior
  // attempt or writes this attempt somewhere nobody will look for it (Issue #98).
  if (values.resume !== undefined && values.out !== undefined) {
    throw new SkillError('invalid_input',
      '--out and --resume are mutually exclusive: a resume appends into the directory it resumes ' +
        `(<resume-dir>/${RESUME_ATTEMPT_PREFIX}<n>/), so there is no second output path to choose`, 3);
  }
  return {
    planPath: values.plan,
    outDir: values.out ?? null,
    resumeDir: values.resume ?? null,
    cliArgv,
    cli: cliArgv.join(' '),
    git: values.git ?? 'git',
    gh: values.gh ?? 'gh',
    autoYes: Boolean(values['auto-yes']),
    allowQuestions: Boolean(values['allow-questions']),
    prepareWorktrees,
    worktreeSetupArgv: resolveSetupLauncher(values['worktree-setup'], prepareWorktrees),
    contractMode: resolveContractMode(values['contract-mode']),
    verifyGates: resolveVerifyGates(values['verify-gates']),
    expectBranch: values['expect-branch'] ?? null,
    waitTimeout: positiveInt(values['wait-timeout'], 'wait-timeout', DEFAULT_WAIT_TIMEOUT_SECONDS),
    maxTurns: positiveInt(values['max-turns'], 'max-turns', DEFAULT_MAX_TURNS),
    pollLimit: positiveInt(values['poll-limit'], 'poll-limit', DEFAULT_POLL_LIMIT),
  };
}

// =============================================================================
// Plan loading and validation
// =============================================================================

function loadPlan(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SkillError('load_error', `cannot read plan at ${path}: ${redact(error.message)}`, 6);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SkillError('load_error', `plan at ${path} is not valid JSON: ${redact(error.message)}`, 6);
  }
  return raw;
}

// The plan is trusted (it is this Skill's own approved artifact), but a wrong or
// tampered file must be refused rather than half-executed. Only the fields the
// loop needs are asserted, and any wave wider than max_parallel is a hard stop.
function validatePlan(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new SkillError('plan_invalid', 'plan must be a JSON object', 3);
  }
  if (plan.plan_schema_version !== SUPPORTED_PLAN_SCHEMA_VERSION) {
    throw new SkillError(
      'plan_invalid',
      `unsupported plan_schema_version ${plan.plan_schema_version}; this runner understands ${SUPPORTED_PLAN_SCHEMA_VERSION}`,
      3,
    );
  }
  if (plan.skill_id !== SKILL_ID) {
    throw new SkillError('plan_invalid', `plan.skill_id "${plan.skill_id}" is not ${SKILL_ID}`, 3);
  }
  if (typeof plan.run_id !== 'string' || plan.run_id.length === 0) {
    throw new SkillError('plan_invalid', 'plan.run_id is missing', 3);
  }
  const profile = plan.profile;
  if (!profile || typeof profile.repository !== 'string' || typeof profile.base !== 'string') {
    throw new SkillError('plan_invalid', 'plan.profile is missing repository/base', 3);
  }
  const maxParallel = plan.max_parallel;
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > MAX_PARALLEL_MAX) {
    throw new SkillError('plan_invalid', 'plan.max_parallel is out of the 1-3 range', 3);
  }
  if (!Array.isArray(plan.waves) || plan.waves.length === 0) {
    throw new SkillError('plan_invalid', 'plan.waves is empty', 3);
  }
  for (const wave of plan.waves) {
    if (!Array.isArray(wave) || wave.length === 0) {
      throw new SkillError('plan_invalid', 'a wave is empty or malformed', 3);
    }
    // The single most important pre-condition of the whole runner: the plan
    // already promised waves no wider than the bound. If that promise is
    // broken we refuse rather than dispatch beyond max_parallel.
    if (wave.length > maxParallel) {
      throw new SkillError(
        'plan_invalid',
        `wave ${JSON.stringify(wave)} exceeds max_parallel ${maxParallel}`,
        3,
      );
    }
  }
  if (!Array.isArray(plan.issues)) {
    throw new SkillError('plan_invalid', 'plan.issues is missing', 3);
  }
  return plan;
}

// =============================================================================
// Resume — re-run only what did not finish (Issue #98)
// =============================================================================
//
// A partial failure inside a wave is the normal case in parallel development:
// one issue of three fails while the other two are finished AND judged. Before
// this the only way forward was to re-plan and dispatch all three again, which
// re-runs a worker over a deliverable a gate already passed and throws away the
// verdict that passed it — the exact opposite of what the verification gate is
// for. `--resume <prior-out-dir>` splits the plan in two instead:
//
//   carried      `worker_state: completed` AND `verification.outcome: pass`.
//                NOT re-dispatched. Its verification record is TRANSCRIBED into
//                the new report, because merge and uat read exactly those two
//                fields and nothing else — a carried issue therefore stays
//                eligible for delivery without anything being re-judged here.
//   re-dispatch  everything else: failed, timed out, prompted, never dispatched,
//                a verdict that was not a pass, or no record at all.
//
// The wave barrier is RECOMPUTED, not replayed. A wave whose issues were all
// carried dispatches nothing and advances immediately, so an issue whose
// dependency already passed is dispatched at once instead of behind a worker
// that has nothing left to do. Everything else is the ordinary dispatch path,
// unchanged and deliberately so: the drift re-check before every mutating wave,
// the verification gate, the stop conditions, the exit codes, and Auto-Yes
// staying off. A resume is not a weaker run — it is the same run over a smaller
// issue set.
//
// Artifacts are APPENDED, never overwritten — the shape the UAT fix loop already
// uses for its attempt history. references/dispatch-contract.md section 8 defines
// the layout and states which report merge/uat/status must read.

function resumeAttemptDir(outDir, attempt) {
  return join(outDir, `${RESUME_ATTEMPT_PREFIX}${attempt}`);
}

// This attempt's report, as a path relative to the run directory. Relative on
// purpose: it goes into a report field a human reads, and an absolute host path
// there is redacted to `[REDACTED-PATH]`, which names nothing.
function attemptReportRelative(attempt) {
  return attempt === 1 ? DISPATCH_REPORT_FILE : `${RESUME_ATTEMPT_PREFIX}${attempt}/${DISPATCH_REPORT_FILE}`;
}

function attemptSummaryRelative(attempt) {
  return attempt === 1 ? DISPATCH_SUMMARY_FILE : `${RESUME_ATTEMPT_PREFIX}${attempt}/${DISPATCH_SUMMARY_FILE}`;
}

// The attempt this resume becomes: the first number whose directory does not
// exist yet. Derived from the DIRECTORY rather than from the history ledger, so a
// missing, truncated or hand-edited ledger can never make a run overwrite an
// artifact — the one thing the append-only rule exists to prevent.
function nextAttemptNumber(outDir) {
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (!existsSync(resumeAttemptDir(outDir, attempt))) return attempt;
  }
  // `out_exists` rather than a resume-specific code: the finding is the one that
  // code already names — every output location this run could claim is taken.
  throw new SkillError('out_exists',
    `${outDir} already holds ${MAX_ATTEMPTS - 1} resume attempts; refusing to append another`, 4);
}

// The report a resume reads: the NEWEST attempt in the directory. Each attempt
// re-states what it carried over, so the newest report alone is the whole
// picture — which is the same rule merge, uat and the status matrix follow.
function priorReport(outDir) {
  if (!existsSync(outDir)) {
    throw new SkillError('load_error',
      `--resume ${outDir} does not exist; it must be the --out directory of the dispatch being resumed`, 6);
  }
  let newest = { path: join(outDir, DISPATCH_REPORT_FILE), attempt: 1 };
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const candidate = join(resumeAttemptDir(outDir, attempt), DISPATCH_REPORT_FILE);
    if (!existsSync(candidate)) break;
    newest = { path: candidate, attempt };
  }
  if (!existsSync(newest.path)) {
    throw new SkillError('load_error',
      `--resume ${outDir} holds no ${DISPATCH_REPORT_FILE}; there is no dispatch run there to resume`, 6);
  }
  return newest;
}

// Conformance of the report being resumed, limited to what the carry-over
// depends on. The dispatch report is this runner's OWN artifact, but on the way
// back in it is an INPUT — possibly hand-edited, possibly from another
// producer — and a resume turns it into claims about what is finished. So it is
// checked rather than trusted, and a shape that cannot be checked is refused
// rather than half-read. Returns null when usable, or the reason it is not.
function resumeNonConformance(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'it is not a JSON object';
  if (doc.dispatch_schema_version !== DISPATCH_SCHEMA_VERSION) {
    return `its dispatch_schema_version is ${JSON.stringify(doc.dispatch_schema_version)}; this runner understands ${DISPATCH_SCHEMA_VERSION}`;
  }
  if (doc.skill_id !== SKILL_ID) return `its skill_id is ${JSON.stringify(doc.skill_id)}, not ${SKILL_ID}`;
  if (typeof doc.plan_run_id !== 'string' || doc.plan_run_id.length === 0) return 'it carries no plan_run_id';
  if (doc.profile === null || typeof doc.profile !== 'object' || Array.isArray(doc.profile)) return 'it carries no profile object';
  if (typeof doc.profile.repository !== 'string' || typeof doc.profile.base !== 'string') {
    return 'its profile names no repository/base, so it cannot be checked against the plan';
  }
  if (!Array.isArray(doc.waves)) return 'its waves is not an array';
  for (const wave of doc.waves) {
    if (wave === null || typeof wave !== 'object' || !Array.isArray(wave.workers)) return 'a wave carries no workers array';
    for (const worker of wave.workers) {
      if (worker === null || typeof worker !== 'object' || Array.isArray(worker)) return 'a worker record is not an object';
      if (!Number.isInteger(worker.issue)) return 'a worker record carries no integer issue number';
      if (typeof worker.worker_state !== 'string') return `#${worker.issue} carries no worker_state`;
      const verification = worker.verification;
      if (verification === null || typeof verification !== 'object' || Array.isArray(verification) || typeof verification.outcome !== 'string') {
        return `#${worker.issue} carries no verification.outcome`;
      }
    }
  }
  return null;
}

function loadResumeReport(path, plan) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SkillError('load_error', `cannot read the dispatch report at ${path}: ${redact(error.message)}`, 6);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new SkillError('resume_invalid',
      `the report at ${path} cannot be resumed: it is not valid JSON (${redact(error.message)}). ` +
        'A resume carries verification verdicts forward as fact, so a report this runner cannot read is refused rather than partly believed', 3);
  }
  const nonConformance = resumeNonConformance(doc);
  if (nonConformance !== null) {
    throw new SkillError('resume_invalid',
      `the report at ${path} is not a dispatch report v${DISPATCH_SCHEMA_VERSION} this runner can resume: ${nonConformance}. ` +
        'A resume carries verification verdicts forward as fact, so a report whose shape cannot be checked is refused rather than partly believed', 3);
  }
  // The plan guard (Issue #98 item 2). run_id is the plan's identity; repository
  // and base are the two profile fields the report copies out of it, so a report
  // that agrees on all three was produced FOR THIS PLAN. Refusing the rest is not
  // pedantry: carrying a foreign report's records over would state that issues of
  // THIS plan are completed and verified on the strength of work planned
  // elsewhere, and merge would then open PRs for them.
  if (doc.plan_run_id !== plan.run_id
    || doc.profile.repository !== plan.profile.repository
    || doc.profile.base !== plan.profile.base) {
    throw new SkillError('resume_plan_mismatch',
      `the report at ${path} was produced for plan run_id "${redact(String(doc.plan_run_id))}" ` +
        `(${redact(String(doc.profile.repository))} / ${redact(String(doc.profile.base))}), but --plan is run_id "${plan.run_id}" ` +
        `(${plan.profile.repository} / ${plan.profile.base}). Refusing to resume a different plan's run: the carried-over records would ` +
        'claim that issues of THIS plan are completed and verified on the strength of work that was planned somewhere else. ' +
        "Point --resume at that plan's own dispatch directory, or start a fresh dispatch with --out", 3);
  }
  return doc;
}

// The record each issue carries in the prior report, newest wins — the same
// "last record wins" rule merge.mjs reads a re-dispatched issue by.
function priorWorkerRecords(doc) {
  const latest = new Map();
  for (const wave of doc.waves) {
    for (const worker of wave.workers) latest.set(worker.issue, worker);
  }
  return latest;
}

// The one condition that means "do not run this again": the worker finished AND
// a gate judged it and passed. Exactly the pair merge/uat read, so an issue this
// returns true for is an issue already on the delivery path.
function isCarryable(worker) {
  return worker.worker_state === 'completed'
    && worker.verification !== null
    && typeof worker.verification === 'object'
    && worker.verification.outcome === 'pass';
}

// A carried worker record for the new report. The verification is TRANSCRIBED,
// never re-judged: this attempt ran no gate against this issue, so it may only
// repeat what the attempt that did ran, and it says so in the note. Every field
// is re-validated on the way through because the source is an input — a
// hand-edited report must not be able to write a record the dispatch schema
// rejects, which would make the whole new report unreadable.
function carriedWorkerRecord(prior, priorAttempt) {
  const verification = prior.verification;
  const gates = (Array.isArray(verification.gates) ? verification.gates : [])
    .filter((gate) => gate !== null && typeof gate === 'object'
      && typeof gate.id === 'string' && gate.id.length > 0
      && (gate.verdict === 'pass' || gate.verdict === 'fail'))
    .slice(0, MAX_REPORTED_GATES)
    .map((gate) => ({ id: redact(gate.id), verdict: gate.verdict }));
  const checks = (Array.isArray(verification.checks) ? verification.checks : [])
    .filter((check) => typeof check === 'string' && check.length > 0)
    .slice(0, MAX_REPORTED_GATES)
    .map((check) => redact(check));
  const worker = {
    issue: prior.issue,
    task_id: typeof prior.task_id === 'string' && prior.task_id.length > 0 ? redact(prior.task_id) : null,
    worker_state: 'completed',
    verification: {
      ran: verification.ran === true,
      report_schema_version: Number.isInteger(verification.report_schema_version) ? verification.report_schema_version : null,
      outcome: 'pass',
      gates,
      checks,
    },
    // A carried issue raised no prompt in THIS attempt; a prompt from an earlier
    // one was either answered or is not what carried it (a prompted worker is
    // never `completed`). Carrying the flag forward would halt a run for a human
    // who has nothing left to look at.
    prompt: { detected: false, excerpt: null },
    note: redact(typeof prior.note === 'string' ? prior.note : ''),
  };
  worker.note = appendNote(worker.note,
    `carried over from attempt ${priorAttempt}: this attempt did NOT re-dispatch #${prior.issue} — its worker completed and its ` +
      'verification passed there, and that verdict is transcribed here rather than re-run');
  return worker;
}

// The whole resume decision, computed once before anything is probed or written.
function buildResume(inputs, plan) {
  const prior = priorReport(inputs.resumeDir);
  const doc = loadResumeReport(prior.path, plan);
  const latest = priorWorkerRecords(doc);

  const carried = new Map();
  // Per plan wave, the issues this attempt still has to dispatch. Not truncated
  // here: the wave loop applies the max_parallel bound itself, and doing it in
  // one place is what keeps the bound the same rule on both paths.
  const waveDispatch = [];
  for (const wave of plan.waves) {
    const pending = [];
    for (const number of wave) {
      const record = latest.get(number);
      if (record !== undefined && isCarryable(record)) carried.set(number, carriedWorkerRecord(record, prior.attempt));
      else pending.push(number);
    }
    waveDispatch.push(pending);
  }

  const attempt = nextAttemptNumber(inputs.resumeDir);
  return {
    attempt,
    attemptDir: resumeAttemptDir(inputs.resumeDir, attempt),
    priorAttempt: prior.attempt,
    priorRelative: attemptReportRelative(prior.attempt),
    carried,
    carriedIssues: [...carried.keys()].sort((a, b) => a - b),
    waveDispatch,
    redispatchIssues: waveDispatch.flat(),
    firstActiveWave: waveDispatch.findIndex((entries) => entries.length > 0),
  };
}

// The `resumed_from` + attempt-number record the Issue asks the report to carry.
// It lives in `limitations` rather than in a new top-level field on purpose: the
// dispatch report is a CLOSED schema whose reader set (merge, uat, status) is
// versioned on it, and the same adjudication was already made for the execution
// contract (#1588) — a run-specific fact goes into limitations / blocking_reasons
// / note / summary_markdown, and `dispatch_schema_version` stays 1. The full
// machine-readable record is the attempt-history ledger beside the report.
function resumeLimitation(plan, resume) {
  const list = (numbers) => (numbers.length === 0 ? 'なし' : numbers.map((n) => `#${n}`).join(', '));
  return {
    code: 'resume_attempt',
    detail: `--resume: attempt ${resume.attempt} of plan ${plan.run_id}; resumed_from=${resume.priorRelative} (attempt ${resume.priorAttempt}). `
      + `Carried over without re-dispatching (worker completed and verification passed there): ${list(resume.carriedIssues)}. `
      + `Re-dispatched here: ${list(resume.redispatchIssues)}. The carried verification records are transcribed from that report and were NOT re-judged; `
      + `this attempt's artifacts are under ${RESUME_ATTEMPT_PREFIX}${resume.attempt}/ and no earlier attempt was overwritten`,
  };
}

// One line per attempt, appended at the run directory's root. Best effort: the
// ledger is evidence about the run, never part of deciding it, so a filesystem
// that will not take the line must not fail a dispatch that already happened.
function appendAttemptHistory(outDir, entry) {
  try {
    appendFileSync(join(outDir, ATTEMPT_HISTORY_FILE), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // ignored on purpose; see above
  }
}

// =============================================================================
// CLI invocation
// =============================================================================

// One structured call to an external CLI. Never throws: a non-zero exit or a
// missing binary comes back as { ok: false }, so the caller decides whether that
// is drift, a worker failure, or fatal.
function runCli(bin, args, extra = {}) {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
      ...extra,
    });
    return { ok: true, stdout, stderr: '', status: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ? error.stdout.toString() : '',
      stderr: error.stderr ? error.stderr.toString() : redact(error.message ?? ''),
      status: error.status ?? null,
    };
  }
}

const execFileAsync = promisify(execFile);

// The async twin of runCli, used only by the per-worker supervision path so that a
// whole wave's `commandmate wait` calls — each of which blocks until its worker
// idles — run CONCURRENTLY instead of one worker at a time (Issue #1474). It keeps
// runCli's non-throwing contract and the same { ok, stdout, stderr, status } shape,
// so the supervision code reads identically to the sync version. The sync runCli
// still backs the preflight drift checks and the post-barrier verification, which
// stay synchronous. NOTE: promisified execFile surfaces a non-zero exit as
// error.code (a number) where execFileSync used error.status; a spawn failure keeps
// a string code (e.g. "ENOENT"). Normalizing to a numeric `status` lets the wait
// exit-code checks (prompt 10 / timeout 124) read exactly as the sync path does.
async function runCliAsync(bin, args, extra = {}) {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      ...extra,
    });
    return { ok: true, stdout, stderr: '', status: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ? error.stdout.toString() : '',
      stderr: error.stderr ? error.stderr.toString() : redact(error.message ?? ''),
      status: typeof error.code === 'number' ? error.code : (error.status ?? null),
    };
  }
}

// One call to the CommandMate CLI. The launcher may carry fixed leading
// arguments (`npx commandmate@latest` is program "npx" plus one argument), so
// the subcommand is appended to it rather than passed as the whole argv. Every
// commandmate spawn in this runner goes through these two — a direct
// runCli(inputs.cli, …) would pass the launcher string as a program name and
// reintroduce the ENOENT this replaced (Issue #37).
function runCm(inputs, args, extra = {}) {
  return runCli(inputs.cliArgv[0], [...inputs.cliArgv.slice(1), ...args], extra);
}

function runCmAsync(inputs, args, extra = {}) {
  return runCliAsync(inputs.cliArgv[0], [...inputs.cliArgv.slice(1), ...args], extra);
}

// =============================================================================
// Drift re-check (branch / HEAD / worktree / permission)
// =============================================================================

// Re-run before every wave. `blocking` checks that fail stop the dispatch;
// non-blocking failures are recorded as limitations so the operator sees them
// without the run stalling on something a just-in-time setup step will fix.
// `resolutions` is the wave's up-front worktree resolution (id + real path from
// `commandmate ls`), so `worktrees_present` can judge reachability the same way
// the supervisor does — by a live branch match — instead of string-matching the
// plan's template path against `git worktree list` (Issue #1473).
//
// Returns the checks AND the resolutions that did not resolve, because the two
// are one finding: `worktrees_present` counts them, and the caller names each of
// them in a `worktree_unresolved` blocking reason (Issue #90).
function driftChecks(inputs, plan, waveIndex, resolutions) {
  const checks = [];
  const add = (code, ok, blocking, detail) =>
    checks.push({ wave_index: waveIndex, code, ok, blocking, detail });

  const cli = runCm(inputs, ['--version']);
  add('cli_available', cli.ok, true, cli.ok ? 'commandmate CLI is runnable' : 'commandmate CLI is not runnable (permission or install)');

  const repo = runCli(inputs.gh, ['repo', 'view', plan.profile.repository, '--json', 'nameWithOwner']);
  add('repo_access', repo.ok, true, repo.ok ? `repo ${plan.profile.repository} is reachable` : `cannot reach repo ${plan.profile.repository} (permission)`);

  const base = runCli(inputs.git, ['rev-parse', '--verify', plan.profile.base]);
  add('base_resolvable', base.ok, true, base.ok ? `base ${plan.profile.base} resolves` : `base ${plan.profile.base} no longer resolves (drift)`);

  if (inputs.expectBranch) {
    const head = runCli(inputs.git, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const current = head.ok ? head.stdout.trim() : '';
    const matches = head.ok && current === inputs.expectBranch;
    add('branch_matches', matches, true, matches ? `HEAD is on ${inputs.expectBranch}` : `HEAD is "${current || 'unknown'}", expected ${inputs.expectBranch} (drift)`);
  }

  const dirty = runCli(inputs.git, ['status', '--porcelain']);
  const clean = dirty.ok && dirty.stdout.trim() === '';
  add('integration_clean', clean, false, clean ? 'integration worktree is clean' : 'integration worktree has uncommitted changes');

  const listed = runCli(inputs.git, ['worktree', 'list', '--porcelain']);
  const registered = listed.ok ? listed.stdout : '';
  // A planned worktree is "present" if `commandmate ls` resolved its branch to a
  // registered worktree id (the same reachability the supervisor relies on) OR its
  // template path shows up in `git worktree list`. Resolving by branch means a
  // worktree registered under a path that differs from the plan template no longer
  // false-NGs here and silently masks a real dispatch (Issue #1473).
  const unresolved = resolutions.filter((r) => {
    if (r.resolved && r.resolved.id) return false;
    const target = r.templatePath ?? '';
    return !(target && registered.includes(target.replace(/^\.\.\//, '')));
  });
  const present = unresolved.length === 0;
  // BLOCKING since Issue #90. It used to be a limitation the run continued past,
  // which is the one shape where continuing cannot help: a worktree the CLI
  // cannot resolve has no `send` target, so every issue behind it is recorded
  // `failed` without a single worker having been started. Refusing here is what
  // makes the report say `worktree_unresolved` instead of `worker_failed`, and
  // — because the pre-flight runs before the run directory exists — what leaves
  // the same `--out` free for the re-run after the worktree is created.
  add('worktrees_present', present, true, present ? 'planned worktrees resolve (commandmate ls branch match or git worktree list)' : `${unresolved.length} planned worktree(s) neither resolve via commandmate ls nor appear in git worktree list`);

  return { checks, unresolved };
}

// One blocking reason per unresolved worktree (Issue #90). A single aggregate
// count ("2 planned worktrees do not resolve") tells an operator that something
// is missing but not WHICH issue to create a worktree for, and the branch is the
// only handle `cmate-worktree-setup` takes. `entries` are drift resolutions;
// `resolved.note` already carries the redacted branch.
function worktreeUnresolvedReasons(entries) {
  return entries.map((entry) => ({
    code: 'worktree_unresolved',
    detail: redact(`#${entry.number}: ${entry.resolved?.note || 'no registered worktree resolved for this issue'}`),
  }));
}

// The blocking pre-flight (Issue #90): the first wave's worktree resolution and
// its drift re-check, run BEFORE the run directory is created. It is the same
// check the wave loop performs — the loop reuses this result for wave 0 rather
// than probing the world twice — moved earlier for one reason: a refusal must
// not consume `--out`. The old order created `<plan-dir>/dispatch` first, so a
// run refused for a missing worktree left a directory behind and the re-run
// (after `cmate-worktree-setup` created that worktree) died on `out_exists`
// with the operator's only recourse being to invent a new `--out`.
//
// `waveIndex` / `waveIssues` name the first wave this run will actually
// dispatch. On an ordinary run that is wave 0 and the whole of it; on a resume
// (Issue #98) it is the first wave with anything left to do, holding only the
// issues that were not carried over — a carried issue's worktree may well have
// been removed after its branch was merged, and demanding it resolve would
// refuse a run that has no reason to touch it.
function preflightDispatch(inputs, plan, waveIndex, waveIssues) {
  const resolutions = resolveWave(inputs, plan, waveIssues);
  const { checks, unresolved } = driftChecks(inputs, plan, waveIndex, resolutions);
  const blocking = checks.find((check) => check.blocking && !check.ok);
  const reasons = !blocking
    ? []
    : blocking.code === 'worktrees_present' && unresolved.length > 0
      ? worktreeUnresolvedReasons(unresolved)
      : [{ code: `drift_${blocking.code}`, detail: blocking.detail }];
  return { waveIndex, resolutions, checks, unresolved, blocked: Boolean(blocking), reasons };
}

// The report a blocked pre-flight prints. `out_dir` is null because nothing was
// written — the field already means "null when nothing was written", and it is
// how a reader (and the summary) can tell that the same command may simply be
// re-run once the drift is fixed.
function preflightFailureReport(inputs, plan, preflight, preparation = null, resume = null) {
  const report = emptyReport(inputs, plan, null);
  report.status = 'failure';
  // A refused resume still says it WAS a resume, and what it would have carried:
  // otherwise the reader cannot tell a first attempt that stopped from a fourth
  // one, and the re-run advice below ("re-run the same command") is only true
  // because this attempt's directory was never created either (Issue #98).
  if (resume !== null) report.limitations.push(resumeLimitation(plan, resume));
  // A preparation that could not run is not drift: nothing about branch, base or
  // permission moved — a conditional dependency was missing, misconfigured or
  // disagreed with the plan's profile. `dispatch_error` is the pre-dispatch stop
  // the schema already reserves for that shape (Issue #93).
  const preparationFailed = preparation !== null && preparation.reasons.length > 0;
  report.stop_reason = preparationFailed ? 'dispatch_error' : 'drift';
  report.drift_checks = preflight.checks;
  // The preparation's reasons come first: when the stage was asked for, why it
  // could not deliver a worktree is the actionable half, and "this issue has no
  // worktree" is the symptom it explains.
  report.blocking_reasons = [...(preparation?.reasons ?? []), ...preflight.reasons];
  recordPreparation(report, preparation);
  // The pre-flight is where a `commandmate sync` is most likely to have run: it is
  // the first thing that resolves worktrees. A refusal must say the registry was
  // re-scanned (or could not be) before it concluded "no registered worktree".
  recordSyncAttempt(report);
  report.completion_check = buildCompletionCheck({
    planApproved: true,
    driftReconfirmed: preflight.checks.length > 0,
    parallelismBounded: true,
    barrierEnforced: true,
    noAutoPromptResponse: true,
    reportStatus: 'failure',
  });
  report.redactions = redactionsList();
  report.summary_markdown = renderSummary(report, false, [], resume);
  return report;
}

// =============================================================================
// Worktree preparation — composition of cmate-worktree-setup (Issue #93)
// =============================================================================
//
// `--prepare-worktrees` closes the one hand-off that kept this from being a
// single entry point: the worktrees a plan dispatches into have to exist before
// the first wave, and creating them lived in another Skill invoked by hand. If it
// was forgotten the run stopped at the pre-flight (Issue #90) — correct, but not
// end to end.
//
// What this runner does NOT do is create them itself. Collision detection, the
// base-SHA re-confirmation immediately before creation, the proportional baseline
// and the sync all already exist in cmate-worktree-setup; re-implementing them
// here would be two implementations of one rule, of which only one ever gets
// fixed. So the stage is a COMPOSITION: an injected provider performs that
// Skill's procedure, and this runner
//
//   1. decides WHO to prepare (the issues the pre-flight could not resolve —
//      the only side that knows this),
//   2. checks the result document against the provider's own contract
//      (worktree-setup.result.v1) and against the plan (branch agreement), and
//   3. re-scans the registry and resolves again, falling back to #90's unchanged
//      refusal for anything still unresolved.
//
// The shape is the same one the UAT runner uses for its semantic gate: the
// judgement (what to create / whether acceptance passed) happens outside, the
// runner validates a contract document and never re-implements the procedure.
// The full adjudication, including why a partial preparation stops the run and
// why nothing is ever deleted, is in references/adr-worktree-preparation.md.

const SETUP_SKILL_ID = 'cmate-worktree-setup';
const SUPPORTED_SETUP_SCHEMA_VERSION = 1;

// The top-level fields worktree-setup.result.v1 requires. A document missing any
// of them is not the contract, whatever else it contains.
const SETUP_REQUIRED_FIELDS = [
  'result_schema_version', 'skill_id', 'skill_version', 'generated_at', 'status', 'phase_reached',
  'request', 'repository', 'profile', 'plan', 'worktrees', 'baseline', 'commandmate_sync',
  'collisions', 'redactions', 'next_actions', 'blocking_reasons', 'limitations',
  'completion_check', 'summary_markdown',
];
const SETUP_STATUSES = new Set(['success', 'partial', 'failure']);

// How many of the provider's own blocking reasons are lifted into this report.
// Enough to act on, bounded so a provider cannot flood a dispatch report.
const MAX_SETUP_REASONS = 5;

// Where the cmate-worktree-setup package sits when it is installed: next to this
// one, which is the layout both this repository and the installer produce. The
// probe only sharpens the message — "not installed" and "installed but nothing
// was given to invoke it with" are different sentences for the operator — and it
// never decides the outcome on its own.
const SETUP_PACKAGE_SKILL_MD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', SETUP_SKILL_ID, 'SKILL.md');

function setupPackageNote() {
  return existsSync(SETUP_PACKAGE_SKILL_MD)
    ? `the ${SETUP_SKILL_ID} package is installed next to this skill, but nothing was given to invoke it with`
    : `the ${SETUP_SKILL_ID} package is not installed next to this skill (commandmate skill install ${SETUP_SKILL_ID})`;
}

// Conformance against worktree-setup.result.v1, limited to what this composition
// depends on. Returns null when the document is usable, or the reason it is not.
function setupNonConformance(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'not a JSON object';
  for (const field of SETUP_REQUIRED_FIELDS) {
    if (!(field in doc)) return `missing required field "${field}"`;
  }
  if (doc.result_schema_version !== SUPPORTED_SETUP_SCHEMA_VERSION) {
    return `unsupported result_schema_version ${JSON.stringify(doc.result_schema_version)}; this runner understands ${SUPPORTED_SETUP_SCHEMA_VERSION}`;
  }
  if (doc.skill_id !== SETUP_SKILL_ID) return `skill_id is not ${SETUP_SKILL_ID}`;
  if (typeof doc.skill_version !== 'string' || !/^\d+\.\d+\.\d+$/.test(doc.skill_version)) {
    return 'skill_version is not a semantic version';
  }
  if (!SETUP_STATUSES.has(doc.status)) return `status ${JSON.stringify(doc.status)} is not one of success/partial/failure`;
  for (const field of ['worktrees', 'baseline', 'blocking_reasons', 'limitations']) {
    if (!Array.isArray(doc[field])) return `${field} is not an array`;
  }
  return null;
}

// One invocation for the whole unresolved set, not one per issue: the provider's
// input contract takes `issue_numbers` as a list, and its collision detection and
// base resolution are repository-wide work that would otherwise be redone N times.
function runWorktreeSetup(inputs, plan, numbers) {
  const argv = inputs.worktreeSetupArgv;
  const args = [
    ...argv.slice(1),
    '--issues', numbers.join(','),
    '--profile', String(plan.profile.id ?? 'unknown'),
    '--base', String(plan.profile.base),
  ];
  return runCli(argv[0], args);
}

// A 40-hex base SHA, shortened for a human-readable evidence line. Never invented:
// a provider that recorded no SHA (an entry it did not create) says so.
function shortSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value.slice(0, 12) : 'unknown';
}

function preparationRecord(requested) {
  return {
    attempted: true,
    requested,
    ok: false,
    reasons: [],
    limitations: [],
    prepared: [],
    missing: [...requested],
    artifact: null,
  };
}

// `--prepare-worktrees` was set, but the pre-flight was blocked by something a
// worktree cannot fix. Recorded rather than silently skipped: an operator who
// asked for the stage must be told it did not run, and why.
function skippedPreparation(preflight) {
  const first = preflight.reasons[0];
  return {
    attempted: false,
    requested: [],
    ok: false,
    reasons: [],
    limitations: [{
      code: 'worktree_setup_skipped',
      detail: `--prepare-worktrees was set, but the pre-flight was blocked by ${first ? first.code : 'a drift check'} first, so the ${SETUP_SKILL_ID} provider was not invoked: creating worktrees cannot fix branch/base/permission drift`,
    }],
    prepared: [],
    missing: [],
    artifact: null,
  };
}

// The stage itself. `unresolved` is the pre-flight's own list of issues whose
// worktree neither `commandmate ls` nor `git worktree list` knew about.
//
// Returns evidence, never throws: every way it can fail is a named blocking
// reason the caller renders into the same pre-flight refusal #90 already prints,
// so a failed preparation still leaves `--out` unconsumed and the same command
// re-runnable.
function prepareWorktrees(inputs, plan, unresolved) {
  const requested = unresolved.map((entry) => entry.number).sort((a, b) => a - b);
  const evidence = preparationRecord(requested);

  if (inputs.worktreeSetupArgv === null) {
    evidence.reasons.push({
      code: 'worktree_setup_unavailable',
      detail: `--prepare-worktrees was set but no ${SETUP_SKILL_ID} provider was given: pass --worktree-setup <launcher>, which is invoked as \`<launcher> --issues <n,n> --profile <id> --base <ref>\` and must print a worktree-setup.result.v1 document on stdout (${setupPackageNote()}). Nothing was prepared and nothing was dispatched`,
    });
    return evidence;
  }

  const result = runWorktreeSetup(inputs, plan, requested);
  let doc = null;
  try {
    doc = JSON.parse(result.stdout);
  } catch {
    doc = null;
  }
  // The document is authoritative and the exit code is only consulted when there
  // is no usable document: a provider that created a worktree whose baseline then
  // failed reports `partial` and may well exit non-zero, and folding that into
  // "nothing happened" would lose a worktree that exists on disk.
  const nonConformance = doc === null ? 'stdout is not valid JSON' : setupNonConformance(doc);
  if (nonConformance !== null) {
    const detail = excerpt(result.stderr || result.stdout || 'the provider produced no output');
    if (result.status === null) {
      evidence.reasons.push({
        code: 'worktree_setup_unavailable',
        detail: `the ${SETUP_SKILL_ID} provider could not be run (${redact(detail ?? 'spawn failed')}); ${setupPackageNote()}. Nothing was prepared and nothing was dispatched`,
      });
      return evidence;
    }
    evidence.reasons.push({
      code: 'worktree_setup_failed',
      detail: `the ${SETUP_SKILL_ID} provider exited ${result.status} and its output is not a worktree-setup.result.v${SUPPORTED_SETUP_SCHEMA_VERSION} document (${nonConformance}): ${redact(detail ?? 'no output')}`,
    });
    return evidence;
  }

  evidence.limitations.push({
    code: 'worktree_setup_ran',
    detail: redact(`--prepare-worktrees invoked ${SETUP_SKILL_ID} ${doc.skill_version} once for ${requested.map((n) => `#${n}`).join(', ')} with the plan's profile (${String(plan.profile.id ?? 'unknown')} / base ${plan.profile.base}): status ${doc.status}, phase_reached ${doc.phase_reached}, ${doc.worktrees.length} worktree entr(ies), ${doc.limitations.length} limitation(s) of its own`),
  });

  const rows = new Map();
  for (const row of doc.worktrees) {
    if (row && typeof row === 'object' && Number.isInteger(row.issue_number)) rows.set(row.issue_number, row);
  }
  const baselines = new Map();
  for (const row of doc.baseline) {
    if (row && typeof row === 'object' && Number.isInteger(row.issue_number)) baselines.set(row.issue_number, row);
  }

  // Branch agreement is how "the same profile" is actually checked (ADR section 6):
  // the two `branch_template`s cannot be compared as strings — their placeholder
  // spellings are not standardised across the two Skills — but the branch they
  // produce is exactly what `commandmate ls` matches on, so that is what is
  // asserted. A mismatch is a profile disagreement, not a missing worktree, and
  // it gets a message that says so.
  const mismatched = [];
  const evidenceRows = [];
  for (const number of requested) {
    const issue = issueOf(plan, number);
    const row = rows.get(number);
    if (!row) continue;
    const made = row.created === true || row.reused === true;
    const branch = typeof issue.branch === 'string' ? issue.branch : null;
    if (made && branch !== null && row.branch !== branch) {
      mismatched.push({ number, planned: branch, produced: String(row.branch) });
      continue;
    }
    if (!made) continue;
    const baseline = baselines.get(number) ?? null;
    const outcome = baseline && typeof baseline.outcome === 'string' ? baseline.outcome : 'not_run';
    const exitCode = baseline && Number.isInteger(baseline.exit_code) ? baseline.exit_code : null;
    evidence.prepared.push(number);
    evidenceRows.push({
      issue: number,
      branch: redact(String(row.branch)),
      directory: redact(String(row.directory ?? '')),
      created: row.created === true,
      reused: row.reused === true,
      base_sha: typeof row.base_sha === 'string' ? redact(row.base_sha) : null,
      baseline_outcome: outcome,
      baseline_exit_code: exitCode,
    });
    evidence.limitations.push({
      code: 'worktree_prepared',
      detail: redact(`#${number}: ${SETUP_SKILL_ID} ${row.created === true ? 'created' : 'reused'} branch ${row.branch} at ${row.directory} from base ${shortSha(row.base_sha)}; baseline ${outcome}${exitCode === null ? '' : ` (exit ${exitCode})`}`),
    });
  }
  evidence.missing = requested.filter((number) => !evidence.prepared.includes(number));

  if (mismatched.length > 0) {
    for (const entry of mismatched) {
      evidence.reasons.push({
        code: 'worktree_profile_mismatch',
        detail: redact(`#${entry.number}: ${SETUP_SKILL_ID} created branch ${entry.produced}, but the plan dispatches into ${entry.planned}. The two sides resolved different profiles (different branch_template), so \`commandmate ls\` can never match the plan's branch. Pass the SAME profile to both`),
      });
    }
    return evidence;
  }

  if (evidence.prepared.length === 0) {
    const own = doc.blocking_reasons
      .slice(0, MAX_SETUP_REASONS)
      .map((reason) => (typeof reason === 'string' ? reason : JSON.stringify(reason)))
      .join('; ');
    evidence.reasons.push({
      code: 'worktree_setup_failed',
      detail: redact(`the ${SETUP_SKILL_ID} provider reported status ${doc.status} and created no worktree for ${requested.map((n) => `#${n}`).join(', ')}${own ? `; it blocked on: ${excerpt(own, 400)}` : ' and named no blocking reason'}`),
    });
    return evidence;
  }

  if (evidence.missing.length > 0) {
    // Partial preparation does not become a partial dispatch (ADR section 3). The
    // run still stops — through #90's unchanged path, on the issues that are
    // still unresolved — and what WAS created is kept and named here.
    evidence.limitations.push({
      code: 'worktree_setup_partial',
      detail: `the ${SETUP_SKILL_ID} provider prepared ${evidence.prepared.map((n) => `#${n}`).join(', ')} but not ${evidence.missing.map((n) => `#${n}`).join(', ')}; the prepared worktrees are kept (nothing is deleted here) and the run stops on the ones that are still unresolved`,
    });
  }

  // The registry re-scan the created worktrees need. `git worktree add` does not
  // register anything with the CommandMate server, so a worktree that was just
  // created has no id to send to until a sync makes it visible. This one is
  // FORCED: the run's earlier sync (Issue #91) ran before these worktrees
  // existed, so its answer says nothing about them.
  const sync = attemptSync(inputs, { force: true });
  evidence.ok = true;
  evidence.artifact = {
    provider: {
      skill_id: SETUP_SKILL_ID,
      skill_version: redact(String(doc.skill_version)),
      status: doc.status,
      phase_reached: String(doc.phase_reached),
    },
    requested,
    prepared: [...evidence.prepared],
    missing: [...evidence.missing],
    worktrees: evidenceRows,
    provider_sync: {
      available: doc.commandmate_sync?.available === true,
      attempted: doc.commandmate_sync?.attempted === true,
    },
    dispatch_sync: { ran: true, ok: sync.ok, detail: redact(sync.detail) },
  };
  return evidence;
}

// The evidence, in the report. No new field: `dispatch_schema_version` stays 1
// because merge and uat refuse any other version, and what they read
// (`worker_state`, `verification.outcome`) has not changed — so the preparation
// travels the same way #91's sync attempt does, through `limitations` (ADR section 7).
function recordPreparation(report, preparation) {
  if (preparation === null) return;
  report.limitations.push(...preparation.limitations);
}

// The structured half of the same evidence. Written only once the run has an
// output directory, which means only when the preparation let the run proceed:
// a refusal writes nothing at all (#90), so its evidence lives in the report.
function writePreparationArtifact(outDir, preparation) {
  if (preparation === null || preparation.artifact === null) return;
  const dir = join(outDir, 'worktree-setup');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prepared.json'), `${JSON.stringify(preparation.artifact, null, 2)}\n`, 'utf8');
}

// Is this pre-flight refusal one the preparation stage can address? Only when
// every blocking reason is a missing worktree. `driftChecks` reports the FIRST
// blocking failure, so a run blocked on `cli_available` / `repo_access` /
// `base_resolvable` / `branch_matches` never reaches here — and must not, since
// creating a worktree on a drifted world is a mutation that cannot help.
function blockedOnWorktreesOnly(preflight) {
  return preflight.blocked
    && preflight.unresolved.length > 0
    && preflight.reasons.length > 0
    && preflight.reasons.every((reason) => reason.code === 'worktree_unresolved');
}

// =============================================================================
// Version gate: does this CommandMate speak the execution contract? (#1588)
// =============================================================================

// The execution contract (`send --contract`) and the contract verdict
// (`wait --verify`, `commandmate verify`) landed together in CommandMate 0.17.0
// (Issues #1544 / #1545). Rather than assume, the runner asks the binary in front
// of it once, before the first wave, and records the answer. The point of the
// probe is not the branch, it is the DISCLOSURE: falling back silently would keep
// reporting `verification.outcome: pass` while the thing that produced it had
// changed from "every declared gate passed" to "the profile baseline exited 0".
function probeContractSupport(inputs) {
  const send = runCm(inputs, ['send', '--help']);
  const wait = runCm(inputs, ['wait', '--help']);
  const hasContract = send.ok && `${send.stdout}${send.stderr}`.includes('--contract');
  const hasVerify = wait.ok && `${wait.stdout}${wait.stderr}`.includes('--verify');
  if (hasContract && hasVerify) {
    return { supported: true, detail: 'commandmate accepts send --contract and wait --verify' };
  }
  if (!send.ok && !wait.ok) {
    return {
      supported: false,
      detail: 'commandmate did not answer `send --help` / `wait --help` (not installed, not on PATH, or not permitted)',
    };
  }
  const missing = [];
  if (!hasContract) missing.push('send --contract');
  if (!hasVerify) missing.push('wait --verify');
  return {
    supported: false,
    detail: `commandmate is missing ${missing.join(' and ')} (the execution contract needs CommandMate >= 0.17.0)`,
  };
}

// =============================================================================
// Execution contract generation (CommandMate task contract v1)
// =============================================================================
//
// Canonical spec: CommandMate's docs/design/task-contract.md. v1 is a CLOSED key
// set — version / title / goal / scope / verify / autoYes / success — where an
// unknown key is a hard error, `title` and `goal` are required, `verify.gates: []`
// is an error, and `scope.allow` is effectively required because
// `success.requireScopeClean` defaults to true.
//
// Everything below is derived from the approved plan alone, in a fixed order,
// with no clock, no randomness and no environment read: the same plan must
// produce a BYTE-IDENTICAL contract. That is the same Claude/Codex parity rule
// the planner already lives under, and it is what makes a contract reviewable —
// a diff between two runs is a change in the plan, never a change in the runner.

// A double-quoted YAML scalar. JSON string escaping is a strict subset of YAML
// 1.2's double-quoted style, so JSON.stringify is both correct and stable — and,
// unlike a bare scalar, the result can never be re-read as a boolean (`off`), a
// number, or the start of a comment (`#123 …`).
function yamlString(value) {
  return JSON.stringify(String(value));
}

// The goal as a literal block scalar. The contract is a reviewed, committed
// artifact rather than a wire format, so the goal stays readable instead of
// becoming one escaped line. The text is normalised first — CR removed, trailing
// whitespace removed, trailing blank lines dropped — so the block can never
// acquire an ambiguous indentation, and buildContractGoal always opens with a
// header line (a whitespace-led first line would need an explicit indentation
// indicator to be legal).
function yamlBlockScalar(key, text, indent = '  ') {
  const lines = String(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((line) => (line === '' ? '' : `${indent}${line}`)).join('\n');
  return `${key}: |\n${body}`;
}

// `scope.allow` for one issue: the files the plan says this issue owns.
//
// Patterns the contract parser would reject (absolute, `..`-escaping, over-long,
// NUL-bearing, Windows drive or backslash paths) are dropped rather than sent —
// a contract rejected at `send` is a dispatch that never happens. The result is
// sorted so the contract does not depend on the plan's iteration order, and
// de-duplicated so a file listed twice does not produce two identical patterns.
function contractScopeAllow(issue) {
  const seen = new Set();
  const allow = [];
  const files = Array.isArray(issue.suspected_files) ? issue.suspected_files : [];
  for (const raw of files) {
    if (typeof raw !== 'string') continue;
    const pattern = raw.trim();
    if (pattern === '' || pattern.length > MAX_SCOPE_PATTERN_LENGTH) continue;
    if (pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern) || pattern.includes('\\')) continue;
    if (pattern.split('/').includes('..') || pattern.includes('\u0000')) continue;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    allow.push(pattern);
  }
  allow.sort();
  return allow.slice(0, MAX_SCOPE_PATTERNS);
}

function contractTitle(issue) {
  const title = typeof issue.title === 'string' ? issue.title.trim() : '';
  const raw = redact(title === '' ? `Issue #${issue.number}` : `#${issue.number} ${title}`);
  return raw.length > MAX_CONTRACT_TITLE ? `${raw.slice(0, MAX_CONTRACT_TITLE - 1)}…` : raw;
}

// The contract's `goal` — the body CommandMate sends after the preamble it
// composes itself.
//
// Deliberately NOT the same text as buildWorkerPrompt(): the preamble already
// states the allowed paths, the commit requirement and the completion criterion,
// and it writes that criterion out as the REAL gate commands resolved from
// verify.yaml. Repeating the profile baseline here would tell the worker to
// satisfy one thing while a different thing judges it.
function buildContractGoal(plan, issue) {
  const goal = [
    `# Issue #${issue.number} — ${issue.title ?? 'no title'}`,
    '',
    `Repository: ${plan.profile.repository}`,
    `Base branch: ${plan.profile.base}`,
    `Work branch: ${issue.branch ?? '(from profile template)'}`,
    `Worktree: ${issue.worktree ?? '(from profile template)'}`,
    '',
    '## Objective',
    issue.objective ?? issue.title ?? `Resolve issue #${issue.number}.`,
    '',
    '## Acceptance criteria',
    bullets(issue.acceptance_criteria, 'Derive from the issue; if unclear, stop and ask.'),
    '',
    '## Files you may change',
    bullets(issue.suspected_files, 'Unknown — inspect first; do not touch files owned by another issue.'),
    '',
    '## Rules',
    '- Stay within this issue. Do not modify files another issue in the plan owns.',
    '- The completion criterion above is the contract\'s, not a suggestion: run those',
    '  commands yourself and make them pass before reporting done. Do not report done',
    '  on a failing gate — the same gates decide the verdict.',
    '- Keep working across turns until the whole task is finished; do not stop half-done.',
    '- When the work is complete, make a SINGLE commit of this issue\'s changes on the',
    '  work branch. Verification can pass on uncommitted work, but nothing downstream',
    '  can deliver it, so the commit is what ends the task.',
    '- If a step is destructive, ambiguous, or blocked, STOP and ask. Do not guess.',
    '- Do not print tokens, secrets, or absolute host paths.',
  ].join('\n');
  const redacted = redact(goal);
  if (redacted.length <= MAX_CONTRACT_GOAL) return redacted;
  const marker = '\n\n（この goal は契約の上限 8000 文字に合わせて切り詰められています）';
  return `${redacted.slice(0, MAX_CONTRACT_GOAL - marker.length)}${marker}`;
}

// The contract document for one issue. Field order is fixed, so is every list.
function buildTaskContract(plan, issue, inputs) {
  const allow = contractScopeAllow(issue);
  const lines = [];
  lines.push('# Generated by cmate-orchestrate (dispatch runner) from an approved plan.');
  lines.push('# Do not edit by hand: the same plan regenerates this file byte for byte.');
  lines.push('version: 1');
  lines.push(`title: ${yamlString(contractTitle(issue))}`);
  lines.push(yamlBlockScalar('goal', buildContractGoal(plan, issue)));
  lines.push('scope:');
  if (allow.length === 0) {
    lines.push('  allow: []');
  } else {
    lines.push('  allow:');
    for (const pattern of allow) lines.push(`    - ${yamlString(pattern)}`);
  }
  lines.push('  deny: []');
  // `verify` is omitted unless the operator named gates: this runner cannot know
  // a repository's verify.yaml, and an id that does not exist there makes
  // `send --contract` exit 2. Omitting the key means "run every declared gate",
  // which is the stricter reading, never the looser one.
  if (inputs.verifyGates.length > 0) {
    lines.push('verify:');
    lines.push('  gates:');
    for (const gate of inputs.verifyGates) lines.push(`    - ${yamlString(gate)}`);
  }
  // The contract states the same Auto-Yes stance the runner itself takes, so the
  // server-side policy and the supervision loop cannot disagree. `off` is an
  // active prohibition (distinct from omitting the block, which says nothing).
  lines.push('autoYes:');
  lines.push(`  mode: ${yamlString(inputs.autoYes ? 'safe' : 'off')}`);
  lines.push('success:');
  lines.push('  requireWorkEvidence: true');
  // Always true (Issue #50). It used to be `allow.length > 0`, which turned an
  // empty scope into the ONE configuration where a worker may write any file in
  // the worktree and still be judged clean — the plan that named no file got the
  // widest permission of all. The gate is now unconditional, and an empty scope
  // is refused before a contract is ever sent (see the dispatch loop); a
  // contract built with no allow list therefore fails closed rather than open.
  lines.push('  requireScopeClean: true');
  lines.push('  autoVerifyOnStop: false');
  return `${lines.join('\n')}\n`;
}

function contractRelativePath(issueNumber) {
  return `${CONTRACT_DIR}/${CONTRACT_FILE_PREFIX}${issueNumber}.yaml`;
}

// Place the contract in the worktree (what `send --contract` reads) and keep a
// copy in the run artifact (what a human or a later audit reads — the worktree
// copy can be edited or deleted by the worker it constrains).
function placeContract(worktreePath, issueNumber, text, artifactDir) {
  const relative = contractRelativePath(issueNumber);
  const target = join(worktreePath, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf8');
  writeFileSync(join(artifactDir, `issue-${issueNumber}.yaml`), text, 'utf8');
  return relative;
}

// =============================================================================
// Worker prompt (self-contained, generic — no repository-local worker Skill)
// =============================================================================

// NOT shared with merge/uat: those two redact each item on the way in, because
// their bullets render values lifted from a terminal. Here every caller passes
// already-redacted plan text.
function bullets(items, fallback) {
  if (!Array.isArray(items) || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join('\n');
}

// Everything a worker needs to act on one issue, drawn only from the plan. It is
// deliberately Agent-agnostic and repository-agnostic: the same prompt works for
// any worker CLI because it names the objective, the boundary (only the
// issue's files), the branch/worktree, the baseline to run, and the rule that a
// blocking question must stop and ask rather than be guessed.
function buildWorkerPrompt(plan, issue) {
  return [
    `# Worker task — issue #${issue.number}`,
    '',
    `Repository: ${plan.profile.repository}`,
    `Base branch: ${plan.profile.base}`,
    `Work branch: ${issue.branch ?? '(from profile template)'}`,
    `Worktree: ${issue.worktree ?? '(from profile template)'}`,
    '',
    '## Objective',
    issue.objective ?? issue.title ?? `Resolve issue #${issue.number}.`,
    '',
    '## Acceptance criteria',
    bullets(issue.acceptance_criteria, 'Derive from the issue; if unclear, stop and ask.'),
    '',
    '## Files you may change',
    bullets(issue.suspected_files, 'Unknown — inspect first; do not touch files owned by another issue.'),
    '',
    '## Verification to run before reporting done',
    bullets(plan.profile.baseline, 'Run the repository baseline.'),
    '',
    '## Rules',
    '- Stay within this issue. Do not modify files another issue in the plan owns.',
    '- Run the verification above and report its real result. Do not report done on a failing baseline.',
    '- Keep working across turns until the whole task is finished; do not stop half-done.',
    '- When the work is complete, make a SINGLE commit of this issue\'s changes on the',
    '  work branch. That commit is the completion signal — the supervisor treats a new',
    '  commit as "done" and will otherwise nudge you to keep going.',
    '- If a step is destructive, ambiguous, or blocked, STOP and ask. Do not guess.',
    '- Do not print tokens, secrets, or absolute host paths.',
  ].join('\n');
}

// =============================================================================
// Supervision primitives
// =============================================================================

// One `commandmate ls --json` lookup by branch. `listed` distinguishes the two
// ways this comes back empty, which the sync retry below has to tell apart: a
// parsed list that simply holds no matching row (a registry that may be stale)
// versus an `ls` that produced no list at all (a broken or unreachable CLI, which
// re-scanning cannot fix).
function lookupWorktree(inputs, branch) {
  const result = runCm(inputs, ['ls', '--json']);
  const rows = parseCliJson(result);
  if (!Array.isArray(rows)) {
    return { id: null, path: null, note: excerpt(result.stderr || result.stdout || 'ls returned no worktree list'), listed: false };
  }
  const match = rows.find((row) => row && (row.branch === branch || row.name === branch));
  const id = match && typeof match.id === 'string' && WORKTREE_ID_RE.test(match.id) ? match.id : null;
  // Issue #1473: git operations (commit detection and baseline verification) must
  // run in the SAME worktree that `send`/`wait`/`capture` target — the one
  // CommandMate actually registered — not the plan's `worktree_template` path,
  // which can differ. `ls --json` reports each worktree's real `path`; carry it
  // (path-escape checked) so the supervisor cwd's into the registered directory.
  // The plan template stays a fallback for when `ls` omits a path.
  const path = match && typeof match.path === 'string' ? safeWorktreeTarget(match.path) : null;
  return { id, path, note: id ? '' : `no registered worktree matches branch ${redact(branch)}`, listed: true };
}

// The one `commandmate sync` a run is allowed, and what came of it. Null until an
// unresolved branch triggers it; read again when the report is assembled so the
// attempt is stated in `limitations` rather than changing the run's behaviour in
// silence (Issue #91).
let syncAttempt = null;

// `commandmate sync` re-scans every repository and registers the worktrees it
// finds with the server. It is a SERVER-WIDE rescan, so one call answers for every
// branch in the run: syncing per branch would re-scan the same registry N times
// for the same answer. `fresh` says whether this caller is the one that ran it.
//
// `force` is the one thing that buys a SECOND re-scan, and only the worktree
// preparation stage sets it (Issue #93): once worktrees have been created, the
// world the earlier sync answered about no longer exists, so "we already asked"
// stops being a reason not to ask again. Anything the earlier attempt could not
// resolve is dropped from the tally for the same reason — it was measured against
// a registry that predates the new worktrees.
function attemptSync(inputs, { force = false } = {}) {
  const fresh = force || syncAttempt === null;
  if (fresh) {
    const previous = syncAttempt;
    const result = runCm(inputs, ['sync']);
    syncAttempt = {
      runs: (previous?.runs ?? 0) + 1,
      ok: result.ok,
      detail: result.ok
        ? 'the server re-scanned its repositories'
        : excerpt(result.stderr || result.stdout || 'commandmate sync failed'),
      resolved: previous?.resolved ?? [],
      unresolved: force ? [] : (previous?.unresolved ?? []),
    };
  }
  return { fresh, ok: syncAttempt.ok, detail: syncAttempt.detail };
}

// Resolve the CommandMate worktree id an issue's work lives in, at dispatch time.
// The public CLI is worktree-id based (`send <id> …`); the id is the one
// CommandMate assigned, a `<repo>-<branch>` slug we cannot reconstruct reliably.
// A plan may already carry a resolved `worktree_id`; otherwise we ask the live
// CLI which worktree currently holds the issue's branch — `commandmate ls --json`
// is the source of truth for the id.
//
// `commandmate sync` DOES exist (CommandMate 0.21.0+, Kewton/CommandMate#1680):
// it re-scans repositories and registers their worktrees with the server. It
// CREATES nothing, so it cannot conjure a worktree that was never made — but it
// does close the one gap `ls` alone cannot see: a worktree that exists on disk and
// was created after the server last scanned is registered nowhere, so it has no
// id to send to. When `ls` lists rows but none match the branch we therefore sync
// ONCE and read `ls` again (Issue #91). A CLI too old to have `sync` fails that
// call; the branch then stays unresolved and the run stops exactly as it did
// before (Issue #90) — the sync failure itself never stops it.
function resolveWorktreeId(inputs, issue) {
  if (typeof issue.worktree_id === 'string' && WORKTREE_ID_RE.test(issue.worktree_id)) {
    return { id: issue.worktree_id, path: null, note: '' };
  }
  const branch = typeof issue.branch === 'string' ? issue.branch : null;
  if (!branch) return { id: null, path: null, note: 'issue has no branch to resolve a worktree from' };
  const first = lookupWorktree(inputs, branch);
  // Resolved, or `ls` did not answer at all: a re-scan is only meaningful against
  // a registry we could actually read.
  if (first.id !== null || !first.listed) return { id: first.id, path: first.path, note: first.note };

  const sync = attemptSync(inputs);
  const stillUnresolved = (note) => {
    syncAttempt.unresolved.push(redact(branch));
    return { id: null, path: null, note };
  };
  if (!sync.ok) {
    return stillUnresolved(`${first.note} (commandmate sync could not re-scan the registry: ${sync.detail})`);
  }
  if (!sync.fresh) {
    // The rescan already happened earlier in this run, so the `ls` above already
    // read the post-sync registry. Re-syncing would ask the same question twice.
    return stillUnresolved(`${first.note} (commandmate sync had already re-scanned the registry earlier in this run)`);
  }
  const retried = lookupWorktree(inputs, branch);
  if (retried.id !== null) {
    syncAttempt.resolved.push(redact(branch));
    return { id: retried.id, path: retried.path, note: '' };
  }
  return stillUnresolved(`${retried.note} (commandmate sync re-scanned the registry and ls still resolves no id)`);
}

// State the sync attempt in the report. Both outcomes are worth a limitation: a
// successful re-scan means the id an operator reads was NOT the one the plan or a
// first `ls` produced, and a failed one means an unresolved-worktree stop was
// judged on a registry that could not be refreshed (a CommandMate older than
// 0.21.0 has no `sync`). Neither is a blocking reason — the run's outcome is
// decided by whether the worktree resolved, not by the sync (Issue #91).
function recordSyncAttempt(report) {
  if (syncAttempt === null) return;
  const resolved = syncAttempt.resolved.length > 0 ? syncAttempt.resolved.join(', ') : 'none';
  const unresolved = syncAttempt.unresolved.length > 0 ? syncAttempt.unresolved.join(', ') : 'none';
  // More than one re-scan means the preparation stage forced a second one after
  // creating worktrees (Issue #93). Stated, because "sync ran once per run" is a
  // property the report has always asserted and this is the one exception to it.
  if (syncAttempt.runs > 1) {
    report.limitations.push({
      code: 'worktree_sync_rescanned',
      detail: `commandmate sync ran ${syncAttempt.runs} times in this run: once while resolving worktrees and once more after --prepare-worktrees created worktrees the earlier re-scan could not have seen`,
    });
  }
  // "run once" is the ordinary case and stays worded that way; a preparation run
  // says how many times instead, so this sentence never contradicts the
  // `worktree_sync_rescanned` one above it.
  const howOften = syncAttempt.runs > 1 ? `was run ${syncAttempt.runs} times` : 'was run once';
  report.limitations.push(syncAttempt.ok
    ? {
      code: 'worktree_sync_ran',
      detail: `commandmate ls resolved no worktree for a planned branch, so commandmate sync ${howOften} and ls was retried: ${syncAttempt.detail}; resolved after the re-scan: ${resolved}; still unresolved: ${unresolved}`,
    }
    : {
      code: 'worktree_sync_unavailable',
      detail: `commandmate ls resolved no worktree for a planned branch and commandmate sync failed (${syncAttempt.detail}), so the registry could not be re-scanned and ${unresolved} stayed unresolved; the sync failure alone did not stop the run (a CommandMate older than 0.21.0 has no sync subcommand)`,
    });
}

// Resolve every issue of one wave ONCE: its id (what send/wait/capture address),
// the real `path` `commandmate ls` reports (what git rev-parse and the baseline
// cwd into), and the plan template path that is the fallback when `ls` omits a
// path. The drift probe, the supervision loop and the verification gate all read
// this single resolution, so the id path and the git path can never diverge
// (Issue #1473). Called once per wave — and, for the first wave, by the
// pre-flight, whose result the loop reuses rather than resolving twice.
function resolveWave(inputs, plan, waveIssues) {
  return waveIssues.map((number) => {
    const issue = issueOf(plan, number);
    const templatePath = safeWorktreeTarget(issue.worktree ?? '');
    const resolved = resolveWorktreeId(inputs, issue);
    const worktreePath = resolved.path ?? templatePath;
    return { number, issue, templatePath, resolved, worktreePath };
  });
}

// The HEAD commit of a worktree, read INSIDE it (there is no commandmate call for
// this). The supervisor snapshots this before dispatch and compares after each
// idle: a changed HEAD means the worker committed its work — the real completion
// signal (Issue #1468). Null when HEAD cannot be read (a broken/absent worktree),
// which the supervisor treats as "no commit yet", never as done.
async function worktreeHeadSha(inputs, worktreePath) {
  if (!worktreePath) return null;
  const result = await runCliAsync(inputs.git, ['rev-parse', 'HEAD'], { cwd: worktreePath });
  if (!result.ok) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

// `commandmate send <worktree-id> <message>`, then confirm the worker actually
// started (Issue #1468). A send can leave the message unsubmitted (Enter not
// confirmed), which would leave the worker idle so the next `wait` returns
// "completed" with nothing done. We capture the worker's live state right after
// sending; if it is neither generating nor holding a prompt, we treat the send as
// unconfirmed and re-send once to force submission. The commit check below is the
// real ground truth, so this is a best-effort confirmation, not a guarantee.
async function sendAndConfirm(inputs, worktreeId, message) {
  const first = await runCmAsync(inputs, ['send', worktreeId, message]);
  if (!first.ok) {
    return { sent: false, note: excerpt(first.stderr || first.stdout || 'send failed') };
  }
  const capture = parseCliJson(await runCmAsync(inputs, ['capture', worktreeId, '--json']));
  const started = capture && (capture.isGenerating === true || capture.isRunning === true || capture.isPromptWaiting === true);
  if (started) return { sent: true, confirmed: true, note: '' };
  const again = await runCmAsync(inputs, ['send', worktreeId, message]);
  if (!again.ok) {
    return { sent: true, confirmed: false, note: 'send may not have submitted and the re-send failed' };
  }
  return { sent: true, confirmed: false, note: 're-sent after an unconfirmed first send' };
}

// The message that nudges an idle-but-uncommitted worker to keep going.
const NUDGE_MESSAGE = [
  '続けて作業を進め、この Issue の実装を最後まで完遂してください。',
  'まだ変更が commit されていません。完了したら work ブランチに単一 commit を作成してください（それが完了の合図です）。',
].join('\n');

// Sent after a `send --contract` that capture says never started. It doubles as
// the submission the first send may have left unconfirmed and as a harmless nudge
// if it did register.
const CONTRACT_CONFIRM_MESSAGE = [
  '上の実行契約に従って作業を開始してください。',
  '完了したら work ブランチに単一 commit を作成してください（それが完了の合図です）。',
].join('\n');

// Sent when the gates passed but nothing was committed. work-evidence counts
// uncommitted changes, so this is a real pass on work nothing downstream can
// deliver — the commit, not the verdict, is what is missing.
const COMMIT_REQUEST_MESSAGE = [
  '検証（ゲート）は通りましたが、変更がまだ commit されていません。',
  'この Issue の変更を work ブランチに単一 commit として作成してください（それが完了の合図です）。',
].join('\n');

// `commandmate send <worktree-id> --contract <path>`: CommandMate parses the
// contract, records a task row, composes preamble + goal as the message, and
// prints the TASK ID on stdout. A contract the server rejects exits 2 with every
// violation on stderr and sends nothing, so a rejected contract is an honest
// failed dispatch — never a quiet downgrade to a plain send.
async function sendContractAndConfirm(inputs, worktreeId, relativeContractPath) {
  const first = await runCmAsync(inputs, ['send', worktreeId, '--contract', relativeContractPath]);
  if (!first.ok) {
    return { sent: false, taskId: null, note: excerpt(first.stderr || first.stdout || 'contract send failed') };
  }
  const taskId = readTaskId(first.stdout);
  const capture = parseCliJson(await runCmAsync(inputs, ['capture', worktreeId, '--json']));
  const started = capture && (capture.isGenerating === true || capture.isRunning === true || capture.isPromptWaiting === true);
  if (started) return { sent: true, taskId, confirmed: true, note: '' };
  // Re-sending WITH --contract would create a second task row for the same work
  // and leave the first one running forever, so the confirmation is a plain
  // message: it submits whatever the first send left in the input box.
  const again = await runCmAsync(inputs, ['send', worktreeId, CONTRACT_CONFIRM_MESSAGE]);
  if (!again.ok) {
    return { sent: true, taskId, confirmed: false, note: 'the contract send may not have submitted and the confirmation send failed' };
  }
  return { sent: true, taskId, confirmed: false, note: 're-sent a plain confirmation after an unconfirmed contract send' };
}

// The task id `send --contract` prints. The last non-empty stdout line is the id;
// anything that does not look like one is treated as absent rather than recorded.
function readTaskId(stdout) {
  const lines = String(stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines.length > 0 ? lines[lines.length - 1] : null;
  return last && TASK_ID_RE.test(last) ? last : null;
}

// `commandmate wait --verify` prints one `GATE <id> PASS|FAIL` line per executed
// gate (CommandMate verify-runner's reportGates). Transcribing them into the
// report is what lets a reviewer read WHAT judged the work — not only that
// something passed (#47 / CommandMate #1678 B-5: three static-only gate sets
// passed while the app's core feature was broken, and the report could not show
// what the pass was based on). Unparseable output degrades to an empty list,
// never to an invented gate.
const GATE_LINE_RE = /^GATE\s+(\S+)\s+(PASS|FAIL)\b/;
const MAX_REPORTED_GATES = 50;

function gatesFromWaitOutput(stdout) {
  const gates = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const match = GATE_LINE_RE.exec(line.trim());
    if (match) gates.push({ id: redact(match[1]), verdict: match[2] === 'PASS' ? 'pass' : 'fail' });
    if (gates.length >= MAX_REPORTED_GATES) break;
  }
  return gates;
}

// `commandmate verify <worktree-id> --json` prints the verification run document
// (CommandMate's VerificationRunView), whose `gates[]` is what turns "verification
// failed" into something a worker can act on.
//
// NOTE: this starts a SECOND run, so its own verdict can differ from the wait's.
// The wait's exit code stays the verdict; this call is used only to NAME gates.
// When it cannot, that is recorded rather than papered over — a re-instruction
// that cannot say what failed is a guess, and the worker should be told so.
//
// Async on purpose: it runs inside the per-worker supervision that a wave drives
// concurrently (#1474). A synchronous execFileSync here would block the event loop
// for a whole gate run and stall every other worker in the wave.
async function describeFailingGates(inputs, worktreeId) {
  // `verify` exits with the verdict, so on the very runs this function exists to
  // read — a failing gate — the exit is 20, not 0. The run document is still on
  // stdout; parse it regardless of exit status (parseCliJson's ok-check would
  // discard every failing run and leave the re-instruction with no gate names).
  const result = await runCmAsync(inputs, ['verify', worktreeId, '--json']);
  let run = null;
  try {
    run = JSON.parse(result.stdout);
  } catch {
    run = null;
  }
  const gates = run && Array.isArray(run.gates) ? run.gates : null;
  if (!gates) {
    return {
      failing: [],
      checks: [`commandmate wait --verify → exit ${VERIFY_EXIT_FAILED} (a gate failed; the breakdown could not be read from commandmate verify --json)`],
      summary: 'the failing gates could not be read from commandmate verify --json',
    };
  }
  const failing = gates
    .filter((gate) => gate && FAILED_GATE_STATUSES.has(gate.status))
    .map((gate) => {
      const isScope = /scope/i.test(String(gate.gateId ?? ''));
      return {
        id: redact(String(gate.gateId ?? 'unknown')),
        status: String(gate.status),
        exitCode: Number.isInteger(gate.exitCode) ? gate.exitCode : null,
        tail: excerpt(gate.logTail ?? '', 200),
        isScope,
        violations: isScope ? scopeViolationLines(gate.logTail) : [],
      };
    });
  if (failing.length === 0) {
    return {
      failing,
      checks: [`commandmate wait --verify → exit ${VERIFY_EXIT_FAILED} (a gate failed; the confirming commandmate verify run named none)`],
      summary: 'the confirming verify run named no failing gate',
    };
  }
  return {
    failing,
    checks: failing.map((gate) => `gate ${gate.id}: ${gate.status}${gate.exitCode !== null ? ` (exit ${gate.exitCode})` : ''}`),
    summary: failing.map((gate) => gate.id).join(', '),
  };
}

// The violating paths of a scope-gate failure, transcribed line by line from
// that gate's logTail — the scope gate already lists every out-of-scope path
// there (CommandMate #1678 B-2; CLI display is #1683). Lines are copied rather
// than parsed for path shapes, so a format change on the CommandMate side
// degrades to a verbatim quote instead of an empty list.
const MAX_SCOPE_VIOLATION_LINES = 20;

function scopeViolationLines(logTail) {
  return String(logTail ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_SCOPE_VIOLATION_LINES)
    .map((line) => redact(line));
}

// The re-instruction sent to a worker whose contract verification failed. It
// quotes the gates, because "verification failed" alone makes the worker guess.
function buildVerifyReinstruction(failing) {
  const lines = ['検証（commandmate verify）が不合格でした。次のゲートが通っていません。'];
  if (failing.length === 0) {
    lines.push('- （失敗ゲートの内訳を取得できませんでした。`commandmate verify <worktree-id>` を自分で実行して確認してください）');
  }
  for (const gate of failing) {
    const exit = gate.exitCode !== null ? ` (exit ${gate.exitCode})` : '';
    const tail = gate.tail ? ` — ${gate.tail}` : '';
    lines.push(`- ${gate.id}: ${gate.status}${exit}${tail}`);
  }
  // A scope failure is the one gate the worker may be structurally unable to fix:
  // scope.allow comes from the Issue's 対象ファイル via the plan, so when the
  // violating change is unavoidable the fix lives in the Issue, not the worktree.
  // Name the paths and say so, instead of asking for a retry that cannot succeed.
  const scopeGates = failing.filter((gate) => gate.isScope);
  if (scopeGates.length > 0) {
    const violations = scopeGates.flatMap((gate) => gate.violations);
    lines.push('');
    lines.push('scope ゲートについて: 実行契約 scope.allow の外のファイルが変更されています。違反 path（scope ゲートの記録から転記）:');
    if (violations.length === 0) {
      lines.push('- （logTail から違反 path を読み取れませんでした。`commandmate verify <worktree-id>` で確認してください）');
    }
    for (const line of violations) lines.push(`- ${line}`);
    lines.push('scope.allow は Issue の対象ファイルから生成されます。違反 path を許可するには Issue の対象ファイルに追加して plan を作り直す必要があります。');
    lines.push('この変更が受入条件の達成に不可避なら worker 側では解決できません — 停止してその旨を報告してください。回避できるなら、違反 path への変更を取り消して scope 内で完了してください。');
  }
  lines.push('原因を修正し、すべてのゲートが通る状態にしてから、work ブランチに単一 commit を作成してください。');
  lines.push('判断が要る・直しようがない場合は推測せず停止して質問してください。');
  return lines.join('\n');
}

// Has the worker committed since dispatch started? Null HEAD (a broken or absent
// worktree) is "no commit yet", never "done" — the same rule as the legacy loop.
async function hasNewCommit(inputs, worktreePath, baseSha) {
  const current = await worktreeHeadSha(inputs, worktreePath);
  return current !== null && current !== baseSha;
}

// Supervise one worker that was dispatched under an execution contract.
//
// The verdict is CommandMate's, read from `commandmate wait --verify`'s exit code
// — the runner no longer re-implements verification. Completion is still a NEW
// COMMIT (#1468), because a verdict and a deliverable are different things:
// work-evidence counts uncommitted changes, so the gates can pass on a tree that
// nothing downstream can push.
//
// `--on-prompt agent` is explicit and deliberate. The mode names who ANSWERS the
// prompt: `agent` returns it to this caller as exit 10 (which is how the runner
// halts and shows it to a human), while `human` makes `wait` block until someone
// answers it in the UI and never returns 10 at all. The Issue body's
// `--on-prompt human` would therefore have replaced "stop and present the prompt"
// with "hang until --timeout, then report a timeout" — the opposite of the
// human-in-the-loop rule it was written to serve.
async function superviseWithContract(inputs, worktreeId, worktreePath, relativeContractPath) {
  const baseSha = await worktreeHeadSha(inputs, worktreePath);
  let autoResponded = false;

  const sent0 = await sendContractAndConfirm(inputs, worktreeId, relativeContractPath);
  if (!sent0.sent) {
    return {
      state: 'failed', taskId: null, verdict: null, notJudged: false,
      promptExcerpt: null, nudges: 0, autoResponded,
      note: `contract dispatch failed: ${sent0.note}`,
    };
  }
  const taskId = sent0.taskId;
  let turns = 1;
  // Once a pass is in hand it is FINAL for this run: the passing run moved the
  // task to `succeeded`, and a later verification run that cannot bind to a live
  // contract is exactly the detached-contract `error` → exit 99 case (#1620).
  // Asking twice would manufacture the very "no verdict" state we escalate on.
  let verdict = null;
  let passed = false;

  const hardIterations = inputs.maxTurns * 4 + 8;
  for (let i = 0; i < hardIterations; i += 1) {
    const waitArgs = passed
      ? ['wait', worktreeId, '--on-prompt', 'agent', '--timeout', String(inputs.waitTimeout)]
      : ['wait', worktreeId, '--on-prompt', 'agent', '--verify', '--timeout', String(inputs.waitTimeout)];
    const waited = await runCmAsync(inputs, waitArgs);
    const code = waited.ok ? VERIFY_EXIT_PASS : (waited.status ?? null);
    const done = (state, note) => ({ state, taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded, note });

    if (code === WAIT_EXIT_PROMPT) {
      const promptExcerpt = await capturePrompt(inputs, worktreeId);
      if (inputs.autoYes) {
        autoResponded = true;
        await respondWorker(inputs, worktreeId);
        continue; // answered; wait again within the same turn
      }
      return { state: 'prompt', taskId, verdict, notJudged: false, promptExcerpt, nudges: turns - 1, autoResponded, note: '' };
    }
    if (code === WAIT_EXIT_TIMEOUT) {
      return done('timeout', `wait timed out after ${inputs.waitTimeout}s`);
    }

    if (!passed && code === VERIFY_EXIT_NO_VERDICT) {
      // No gate judged this work. That is neither a pass nor a failure, so it is
      // not re-instructed, not retried, and not rounded either way.
      verdict = {
        ran: true,
        outcome: 'not_run',
        gates: [],
        checks: [`commandmate wait --verify → exit ${VERIFY_EXIT_NO_VERDICT} (the verification run ended error/cancelled; no verdict was reached)`],
      };
      const committed = await hasNewCommit(inputs, worktreePath, baseSha);
      return {
        state: committed ? 'completed' : 'failed',
        taskId, verdict, notJudged: true, promptExcerpt: null, nudges: turns - 1, autoResponded,
        note: `escalated to a human rather than re-instructed as a verification failure (exit ${VERIFY_EXIT_NO_VERDICT}: the run ended error/cancelled)`,
      };
    }

    if (code === VERIFY_EXIT_PASS) {
      if (!passed) {
        passed = true;
        verdict = {
          ran: true,
          outcome: 'pass',
          // The GATE lines of THIS passing run are the only safe source of the
          // gate list: a `commandmate verify` after a pass cannot bind to the
          // succeeded task and manufactures exit 99 (#1620).
          gates: gatesFromWaitOutput(waited.stdout),
          checks: [`commandmate wait --verify → exit ${VERIFY_EXIT_PASS} (every declared gate passed)`],
        };
      }
      if (await hasNewCommit(inputs, worktreePath, baseSha)) {
        // The note states only what THIS loop observed — the turn count and the
        // commit. It deliberately no longer asserts the verification result
        // (Issue #83): that sentence was a SECOND, independent claim, and when
        // the recording of `verdict` was skipped the note went on saying
        // "verification passed" beside `outcome: not_run`. The verification
        // clause is appended once, at the recording site, from the very object
        // the report carries — see `verificationNoteClause`.
        const note = turns > 1
          ? `completed after ${turns - 1} follow-up message(s); a new commit was detected`
          : 'completed; a new commit was detected';
        return done('completed', note);
      }
      if (turns >= inputs.maxTurns) {
        return done('failed', `no commit was produced after ${turns} turn(s); gave up at the --max-turns ${inputs.maxTurns} cap`);
      }
      const asked = await sendAndConfirm(inputs, worktreeId, COMMIT_REQUEST_MESSAGE);
      if (!asked.sent) return done('failed', `commit request failed: ${asked.note}`);
      turns += 1;
      continue;
    }

    if (code === VERIFY_EXIT_NOT_STARTED) {
      // work-evidence found no commit and no change: the worker has not started,
      // or has nothing to show yet. Never a pass.
      verdict = {
        ran: true,
        outcome: 'fail',
        gates: gatesFromWaitOutput(waited.stdout),
        checks: [`commandmate wait --verify → exit ${VERIFY_EXIT_NOT_STARTED} (work-evidence found no commit and no uncommitted change)`],
      };
      if (turns >= inputs.maxTurns) {
        return done('failed', `no work evidence after ${turns} turn(s); gave up at the --max-turns ${inputs.maxTurns} cap`);
      }
      const nudged = await sendAndConfirm(inputs, worktreeId, NUDGE_MESSAGE);
      if (!nudged.sent) return done('failed', `nudge failed: ${nudged.note}`);
      turns += 1;
      continue;
    }

    if (code === VERIFY_EXIT_FAILED) {
      const waitGates = gatesFromWaitOutput(waited.stdout);
      const failing = await describeFailingGates(inputs, worktreeId);
      verdict = {
        ran: true,
        outcome: 'fail',
        // The wait's own GATE lines are primary; when a CLI prints none, the
        // confirming verify run's failing gates still name what was judged.
        gates: waitGates.length > 0 ? waitGates : failing.failing.map((gate) => ({ id: gate.id, verdict: 'fail' })),
        checks: failing.checks,
      };
      const committed = await hasNewCommit(inputs, worktreePath, baseSha);
      if (turns >= inputs.maxTurns) {
        // As above: the failing gates are named by the verification clause the
        // recording site appends, out of the same `verdict` the report carries,
        // so this note states only the cap and the missing commit.
        return done(
          committed ? 'completed' : 'failed',
          `the --max-turns ${inputs.maxTurns} cap was reached${committed ? '' : ' with no commit'}`,
        );
      }
      const resent = await sendAndConfirm(inputs, worktreeId, buildVerifyReinstruction(failing.failing));
      if (!resent.sent) return done('failed', `re-instruction failed: ${resent.note}`);
      turns += 1;
      continue;
    }

    // 1 / 2 / anything else: infrastructure, not a verdict.
    return done('failed', excerpt(waited.stderr || waited.stdout || `wait exited ${code ?? 'with an error'}`));
  }
  return { state: 'failed', taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded, note: 'supervision exceeded its hard iteration bound' };
}

// Supervise one worker to a real completion. A worker idles after every turn, so
// the loop drives it turn by turn: dispatch, then wait; on idle-with-no-new-commit
// nudge it and wait again, until it commits (completed), raises a prompt, times
// out, fails, or the --max-turns cap is reached with no commit (an honest failed).
// A prompt is answered only under --auto-yes; otherwise it halts for a human.
async function superviseUntilCommit(inputs, worktreeId, worktreePath, initialMessage) {
  const baseSha = await worktreeHeadSha(inputs, worktreePath);
  let autoResponded = false;

  const sent0 = await sendAndConfirm(inputs, worktreeId, initialMessage);
  if (!sent0.sent) {
    return { state: 'failed', promptExcerpt: null, nudges: 0, autoResponded, note: `dispatch failed: ${sent0.note}` };
  }
  let turns = 1;

  // A hard bound on wait iterations, above the turn cap, so an unexpected
  // prompt/respond ping-pong under --auto-yes can never spin forever.
  const hardIterations = inputs.maxTurns * 4 + 8;
  for (let i = 0; i < hardIterations; i += 1) {
    const waited = await runCmAsync(inputs, ['wait', worktreeId, '--timeout', String(inputs.waitTimeout)]);
    if (!waited.ok && waited.status === WAIT_EXIT_PROMPT) {
      const promptExcerpt = await capturePrompt(inputs, worktreeId);
      if (inputs.autoYes) {
        autoResponded = true;
        await respondWorker(inputs, worktreeId);
        continue; // answered; wait again within the same turn
      }
      return { state: 'prompt', promptExcerpt, nudges: turns - 1, autoResponded, note: '' };
    }
    if (!waited.ok && waited.status === WAIT_EXIT_TIMEOUT) {
      return { state: 'timeout', promptExcerpt: null, nudges: turns - 1, autoResponded, note: `wait timed out after ${inputs.waitTimeout}s` };
    }
    if (!waited.ok) {
      return { state: 'failed', promptExcerpt: null, nudges: turns - 1, autoResponded, note: excerpt(waited.stderr || waited.stdout || `wait exited ${waited.status ?? 'with an error'}`) };
    }

    // wait returned idle. Real completion is a NEW commit, not the idle itself.
    const currentSha = await worktreeHeadSha(inputs, worktreePath);
    if (currentSha !== null && currentSha !== baseSha) {
      const note = turns > 1 ? `completed after ${turns - 1} nudge(s); new commit detected` : 'completed; new commit detected';
      return { state: 'completed', promptExcerpt: null, nudges: turns - 1, autoResponded, note };
    }
    if (turns >= inputs.maxTurns) {
      return {
        state: 'failed',
        promptExcerpt: null,
        nudges: turns - 1,
        autoResponded,
        note: `no new commit after ${turns} turn(s); gave up at the --max-turns ${inputs.maxTurns} cap`,
      };
    }
    const nudged = await sendAndConfirm(inputs, worktreeId, NUDGE_MESSAGE);
    if (!nudged.sent) {
      return { state: 'failed', promptExcerpt: null, nudges: turns - 1, autoResponded, note: `nudge failed: ${nudged.note}` };
    }
    turns += 1;
  }
  return { state: 'failed', promptExcerpt: null, nudges: turns - 1, autoResponded, note: 'supervision exceeded its hard iteration bound' };
}

async function capturePrompt(inputs, worktreeId) {
  const result = await runCmAsync(inputs, ['capture', worktreeId, '--json']);
  const payload = parseCliJson(result);
  const raw = payload?.promptData?.question ?? payload?.content ?? result.stdout ?? '';
  return excerpt(raw) ?? 'a prompt is awaiting input';
}

// =============================================================================
// Recording a verification verdict (Issue #83)
// =============================================================================
//
// ONE function writes a worker's verification, and the same function writes the
// sentence about it that a human reads in `note`. That is the whole point: #83
// was two independent claims about the same fact — a note string composed inside
// the supervision loop ("verification passed and a new commit was detected") and
// a `verification` object assembled somewhere else — drifting apart, with the
// note right and the structured field wrong. A reader cannot tell which half to
// believe, and merge/uat believe the field, so the report's WORDING alone
// decided whether verified work was delivered. Deriving the wording from the
// recorded object makes the contradiction unrepresentable rather than merely
// unlikely.

function appendNote(note, clause) {
  return note ? `${note}; ${clause}` : clause;
}

// The human-readable half of `verification`, rendered from `verification`.
// `source` is how the verdict was reached: `contract` (CommandMate's
// `wait --verify` exit code) or `baseline` (the profile re-run fallback).
function verificationNoteClause(verification, source) {
  const gateIds = verification.gates.map((gate) => gate.id);
  if (verification.outcome === 'pass') {
    if (gateIds.length > 0) return `verification passed (${gateIds.join(', ')})`;
    return source === 'baseline'
      ? 'verification passed (profile baseline re-run; it declares no gates)'
      : 'verification passed, but the run named no gate (see checks)';
  }
  if (verification.outcome === 'fail') {
    const failed = verification.gates.filter((gate) => gate.verdict === 'fail').map((gate) => gate.id);
    return failed.length > 0 ? `verification failed (${failed.join(', ')})` : 'verification failed (see checks)';
  }
  return 'verification reached no verdict (not_run)';
}

// Record a verdict on a worker: the structured field, the note clause derived
// from it, and — when a pass names no gate — the fact that the gate list could
// not be read. That last one is the same shape as the planner's
// `unrecognized_file_extension` (orchestrate.mjs): what the runner FAILED to
// pick up is recorded, instead of an empty list that reads as "nothing ran".
// #47 / CommandMate #1678 B-5 exists so a report alone can answer WHAT a pass
// was based on; a silently empty `gates` returns the report to before that.
function recordVerification(report, worker, verification, source) {
  worker.verification = verification;
  worker.note = appendNote(worker.note, verificationNoteClause(verification, source));
  if (source === 'contract' && verification.outcome === 'pass' && verification.gates.length === 0) {
    report.limitations.push({
      code: 'verification_gates_unrecorded',
      detail: `#${worker.issue} passed verification, but no \`GATE <id> PASS|FAIL\` line could be read from the \`commandmate wait --verify\` output, so the report cannot name which gates the pass was based on; the verdict is the exit code and stands, but treat the pass as unattributed`,
    });
    worker.verification.checks = [
      ...verification.checks,
      'gate list unavailable: the wait --verify output carried no parseable `GATE <id> PASS|FAIL` line',
    ];
  }
}

// The FALLBACK verification gate, used when the CLI has no execution contract
// (`--contract-mode off`, or a CommandMate older than 0.17.0). Worker completion
// got us here; this re-runs the profile baseline INSIDE the worktree and passes
// only when every baseline command exits zero. A missing worktree or any non-zero
// step is a fail — never optimistically opened. Under a contract this is not
// called at all: the verdict is `commandmate wait --verify`'s exit code.
function verifyWorker(inputs, worktreePath, baseline) {
  if (!Array.isArray(baseline) || baseline.length === 0) {
    return { ran: true, outcome: 'fail', checks: [], note: 'profile has no baseline to verify against' };
  }
  const checks = [];
  for (const command of baseline) {
    const argv = String(command).trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) continue;
    checks.push(redact(String(command)));
    const res = runCli(argv[0], argv.slice(1), { cwd: worktreePath });
    if (!res.ok) {
      return { ran: true, outcome: 'fail', checks, note: excerpt(res.stderr || res.stdout || `baseline step failed: ${command}`) };
    }
  }
  return { ran: true, outcome: 'pass', checks, note: '' };
}

async function respondWorker(inputs, worktreeId) {
  // Only ever reached when --auto-yes is explicitly set. A generic affirmative;
  // the default path never calls this, which is what keeps prompt handling
  // human-in-the-loop.
  const result = await runCmAsync(inputs, ['respond', worktreeId, 'yes']);
  return result.ok;
}

// =============================================================================
// The open-questions gate (Issue #52)
// =============================================================================

// Every issue in the plan that still carries a planner question, in plan order.
// A plan written by an older runner may have no `questions` field at all; a
// missing field is "nothing to report", not a reason to refuse the plan.
function collectOpenQuestions(plan) {
  const out = [];
  for (const issue of plan.issues ?? []) {
    const questions = Array.isArray(issue.questions) ? issue.questions.filter((q) => typeof q === 'string' && q !== '') : [];
    if (questions.length > 0) out.push({ issue: issue.number, questions });
  }
  return out;
}

// The question TEXT, not just a count — an operator cannot act on "3 open
// questions", only on what they say. Bounded so a long question cannot flood the
// blocking reason, and redacted like every other field lifted out of an issue.
function formatOpenQuestions(entries) {
  return entries
    .map((entry) => `#${entry.issue}: ${entry.questions.map((q) => excerpt(redact(q), 200)).join(' / ')}`)
    .join('; ');
}

// =============================================================================
// The supervision loop
// =============================================================================

// The report every dispatch starts from — a success envelope the run then
// contradicts. Shared with the pre-flight refusal (Issue #90) so a run that
// stops before the first wave reports the same field set as one that dispatched;
// `outDir` is null there, because nothing was written.
function emptyReport(inputs, plan, outDir) {
  return {
    dispatch_schema_version: DISPATCH_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    status: 'success',
    stop_reason: 'completed',
    human_required: false,
    plan_run_id: plan.run_id,
    out_dir: outDir,
    auto_yes: inputs.autoYes,
    max_parallel: plan.max_parallel,
    profile: {
      id: String(plan.profile.id ?? 'unknown'),
      repository: plan.profile.repository,
      base: plan.profile.base,
      verified: plan.profile.verified === true,
    },
    drift_checks: [],
    waves: [],
    blocking_reasons: [],
    limitations: [],
    redactions: [],
    completion_check: { passed: false, checks: [] },
    summary_markdown: '',
  };
}

// `preflight` is the first wave's already-computed resolution + drift re-check
// (Issue #90), or null when the run will refuse before any wave for a reason
// that does not depend on the state of the world (an unanswered planner
// question). The loop reuses it for wave 0 instead of probing the CLI twice.
//
// `resume` is the carry-over decision (Issue #98) or null on an ordinary run.
// `outDir` is THIS ATTEMPT's directory — the run directory on attempt 1, and
// `<run-dir>/resume-attempt-<n>/` on a resume — so every artifact this function
// writes lands beside the report that describes it and nothing an earlier
// attempt wrote is touched.
async function runDispatch(inputs, plan, outDir, preflight = null, preparation = null, resume = null) {
  const promptsDir = join(outDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });

  const report = emptyReport(inputs, plan, outDir);
  // Stated before anything else the run says: which attempt this is, what it
  // carried, and what it re-dispatched. Every other line of the report is read
  // against that.
  if (resume !== null) report.limitations.push(resumeLimitation(plan, resume));
  // Nothing is left to dispatch: every issue the plan names was already
  // completed AND verified. Reported as its own fact rather than as a silent
  // success, because "the run did nothing" and "the run did everything" produce
  // the same exit code and must not read the same.
  const nothingToDispatch = resume !== null && resume.firstActiveWave < 0;
  if (nothingToDispatch) {
    report.limitations.push({
      code: 'resume_no_work',
      detail: `再実行対象なし: every issue in plan ${plan.run_id} was already completed and verified in a prior attempt, so this attempt dispatched nobody, `
        + 'started no worker and re-judged nothing. The verification records below are all carried over; this report is the one to hand to merge/uat',
    });
  }
  // The pre-flight's drift verdict is part of THIS report even when the run
  // stops before the first wave for an unrelated reason: it was really checked,
  // so it is really recorded.
  if (preflight) report.drift_checks.push(...preflight.checks);
  // Same for the worktree preparation (Issue #93): the worktrees this run
  // dispatches into may have been created minutes ago by another Skill, and what
  // was created, from which base, with which baseline verdict, is evidence this
  // report owns rather than points at.
  recordPreparation(report, preparation);
  writePreparationArtifact(outDir, preparation);

  // Loop-wide facts the completion check is derived from.
  let parallelismBounded = true;
  let barrierEnforced = true;
  let autoResponded = false;
  let stopped = false;

  const haltWith = (status, stopReason, reasons) => {
    report.status = status;
    report.stop_reason = stopReason;
    report.blocking_reasons.push(...reasons);
    stopped = true;
  };
  const halt = (status, stopReason, code, detail) => haltWith(status, stopReason, [{ code, detail }]);

  // The open-questions gate (Issue #52). The planner writes a question for every
  // issue it could not read acceptance criteria or affected files out of. Nothing
  // downstream used to read that field, so an issue with no stated definition of
  // done reached a real worker with exit 0. It is checked FIRST — before the
  // contract probe and before any drift check — because the answer never depends
  // on the state of the world, only on the plan.
  const openQuestions = collectOpenQuestions(plan);
  if (openQuestions.length > 0) {
    const detail = `${openQuestions.length} issue(s) carry an unanswered planner question: ${formatOpenQuestions(openQuestions)}`;
    if (inputs.allowQuestions) {
      report.limitations.push({
        code: 'open_questions_accepted',
        detail: `--allow-questions was set, so dispatch proceeded with the questions unanswered. ${detail}`,
      });
    } else {
      report.human_required = true;
      halt('failure', 'dispatch_error', 'open_questions',
        `${detail} Nothing was dispatched: answer them in the issue body and re-plan, ` +
          'or re-run with --allow-questions to take the risk explicitly.');
    }
  }

  // The version gate (#1588). Decided ONCE, before the first wave, and always
  // stated: `auto` falls back with an explicit limitation, `require` refuses to
  // fall back at all, `off` never probes. What is not allowed is degrading in
  // silence — the fallback reports the same `verification.outcome: pass` from a
  // materially weaker check.
  // Skipped once the open-questions gate has already stopped the run: probing a
  // CLI whose answer can no longer change anything is a side effect for nothing.
  let contractMode = false;
  if (stopped || nothingToDispatch) {
    // nothing to decide; no wave will be dispatched
  } else if (inputs.contractMode === 'off') {
    report.limitations.push({
      code: 'contract_disabled',
      detail: '--contract-mode off: dispatched without an execution contract; verification is the profile baseline re-run inside the worktree',
    });
  } else {
    const probe = probeContractSupport(inputs);
    if (probe.supported) {
      contractMode = true;
    } else if (inputs.contractMode === 'require') {
      halt('failure', 'dispatch_error', 'contract_unsupported',
        `${probe.detail}; --contract-mode require refuses to fall back, so nothing was dispatched`);
    } else {
      report.limitations.push({
        code: 'contract_unsupported',
        detail: `${probe.detail}; falling back to the profile-baseline verification (the pre-contract behaviour)`,
      });
    }
  }
  const contractsDir = join(outDir, 'contracts');
  if (contractMode) mkdirSync(contractsDir, { recursive: true });
  // Issues whose verification reached NO verdict (exit 99). Kept beside the
  // report rather than inside it: dispatch_schema_version 1 is a closed field set
  // and merge/uat both refuse any other version, so the fact travels through the
  // blocking reason and the worker note instead of a new field.
  const notJudged = new Set();
  // Issues that completed with no verification verdict recorded at all (#83).
  // Feeds the `verification_recorded` completion check below.
  const verificationUnrecorded = new Set();

  for (let waveIndex = 0; waveIndex < plan.waves.length && !stopped; waveIndex += 1) {
    const waveIssues = plan.waves[waveIndex];
    // 0. The resume split (Issue #98), before anything is probed. The issues a
    //    prior attempt completed AND verified are not dispatched again; their
    //    records join this wave as they stand, so the barrier below is computed
    //    over BOTH halves. That is what RECOMPUTES the barrier rather than
    //    replaying it: a wave whose issues were all carried dispatches nothing
    //    and advances at once, which is how an issue whose dependency already
    //    passed reaches a worker without waiting behind one.
    const carriedWorkers = resume === null
      ? []
      : waveIssues.filter((number) => resume.carried.has(number)).map((number) => resume.carried.get(number));
    const pending = resume === null ? waveIssues : resume.waveDispatch[waveIndex];

    // Guarded on `resume` rather than on emptiness alone: validatePlan already
    // refuses an empty wave, and an ordinary run that somehow reached one must
    // keep falling through to the barrier (which fails on zero workers) instead
    // of advancing past a wave nobody dispatched.
    if (resume !== null && pending.length === 0) {
      report.waves.push({
        index: waveIndex,
        dispatched: [],
        workers: carriedWorkers,
        // Every worker of this wave is a carried `completed` + `pass`, so both
        // halves of the barrier hold and the next wave may dispatch. Nothing was
        // sent and nothing mutated, which is also why no drift re-check ran for
        // it: there was no mutation for a drift check to guard.
        barrier: { all_workers_completed: true, all_verifications_passed: true, advanced: true },
      });
      continue;
    }

    // 1. max_parallel guard (belt-and-braces; validatePlan already refused a
    //    wider wave, but the runner never dispatches beyond the bound).
    const toDispatch = pending.slice(0, plan.max_parallel);
    if (pending.length > plan.max_parallel) {
      parallelismBounded = false;
      report.limitations.push({ code: 'parallelism_truncated', detail: `wave ${waveIndex} had ${pending.length} issues; capped at ${plan.max_parallel}` });
    }

    // Resolve each issue's CommandMate worktree ONCE, up front (see
    // `resolveWave`). The first dispatching wave was already resolved and
    // drift-checked by the pre-flight, whose result is reused here so the CLI is
    // not probed twice.
    const preflighted = preflight !== null && preflight.waveIndex === waveIndex;
    const resolutions = preflighted ? preflight.resolutions : resolveWave(inputs, plan, toDispatch);

    // 2. Drift re-check before this (mutating) wave.
    const drift = preflighted ? preflight : driftChecks(inputs, plan, waveIndex, resolutions);
    const checks = drift.checks;
    if (!preflighted) report.drift_checks.push(...checks);
    for (const check of checks) {
      if (!check.ok && !check.blocking) {
        report.limitations.push({ code: `drift_${check.code}`, detail: check.detail });
      }
    }
    const blockingDrift = checks.find((check) => check.blocking && !check.ok);
    if (blockingDrift) {
      // The carried workers of this wave are still recorded: they are facts a
      // prior attempt established, and drift found now does not un-verify work
      // that was already judged (Issue #98).
      const waveRecord = { index: waveIndex, dispatched: [], workers: carriedWorkers, barrier: { all_workers_completed: false, all_verifications_passed: false, advanced: false } };
      report.waves.push(waveRecord);
      // Drift before the very first wave means nothing was dispatched at all.
      // (Wave 0 never reaches this: the pre-flight already refused the run
      // before the run directory existed.)
      const status = waveIndex === 0 ? 'failure' : 'partial';
      const reasons = blockingDrift.code === 'worktrees_present' && drift.unresolved.length > 0
        ? worktreeUnresolvedReasons(drift.unresolved)
        : [{ code: `drift_${blockingDrift.code}`, detail: blockingDrift.detail }];
      haltWith(status, 'drift', reasons);
      break;
    }

    // 3a. Prepare every issue in the wave (sequential, cheap): build its worker
    //     record, take its already-resolved worktree id/path, and write its prompt
    //     artifact. `worktreePaths` remembers the git path per issue so the
    //     verification gate reuses the exact same worktree the supervisor drove
    //     (Issue #1473). Workers that cannot be dispatched (unsafe target /
    //     unresolved worktree) are recorded terminal here and never supervised.
    // Seeded with this wave's carried records (empty on an ordinary run), so the
    // barrier and the verification loop below see one wave, not two halves.
    const workers = [...carriedWorkers];
    const worktreePaths = new Map();
    const supervisable = [];
    // Issues whose worktree the CLI could not resolve at dispatch time, in wave
    // order. The drift re-check above passed, so this is the narrow window it
    // cannot cover: a worktree registered in `git worktree list` but not with
    // CommandMate, or one that disappeared between the pre-flight and now. Kept
    // apart from the other failures because the cause and the fix are different
    // (create the worktree — the worker never started), Issue #90.
    const unresolvedWorktrees = [];
    for (const number of toDispatch) {
      const res = resolutions.find((r) => r.number === number);
      const worker = {
        issue: number,
        // The worker is tracked by its worktree id (there is no task id in the
        // public CLI); this field carries that id, or null when it did not run.
        task_id: null,
        worker_state: 'not_dispatched',
        verification: { ran: false, report_schema_version: null, outcome: 'not_run', gates: [], checks: [] },
        prompt: { detected: false, excerpt: null },
        note: '',
      };
      if (res.templatePath === null) {
        worker.note = redact(`refused unsafe worktree target for #${number}`);
        report.limitations.push({ code: 'unsafe_worktree_target', detail: `#${number}: worktree target rejected by path-escape guard` });
        workers.push(worker);
        continue;
      }
      if (res.resolved.id === null) {
        worker.worker_state = 'failed';
        worker.note = redact(`worktree unresolved: ${res.resolved.note}`);
        unresolvedWorktrees.push(res);
        workers.push(worker);
        continue;
      }
      // Without a contract the worktree id is the only handle the public CLI
      // gives a worker, so it is what `task_id` carries. With one, the field
      // holds the REAL task id `send --contract` returns — recorded below, once
      // the send actually happened, so a failed dispatch reports no task rather
      // than a plausible-looking wrong one.
      worker.task_id = contractMode ? null : res.resolved.id;
      worktreePaths.set(number, res.worktreePath);

      let contractPath = null;
      if (contractMode) {
        const allow = contractScopeAllow(res.issue);
        if (allow.length === 0) {
          // Issue #50: an empty scope used to be dispatched with
          // `requireScopeClean: false`, which disabled the scope gate entirely —
          // so the issue whose files the planner could NOT name was the one
          // whose worker could write anything. Refusing here is the only reading
          // that is not a widening: the boundary was never declared, so nothing
          // is dispatched against it. Name the issue's 対象ファイル and re-plan.
          worker.note = redact(`#${number} was not dispatched: the plan declares no scope for it`);
          report.limitations.push({
            code: 'contract_scope_unknown',
            detail: `#${number}: the plan names no suspected file, so the contract would declare no scope; the issue is NOT dispatched (a scope-less contract would either disable the scope gate or reject every change). State the issue's target files and re-run the planner`,
          });
          workers.push(worker);
          continue;
        }
        try {
          contractPath = placeContract(res.worktreePath, number, buildTaskContract(plan, res.issue, inputs), contractsDir);
        } catch (error) {
          worker.worker_state = 'failed';
          worker.note = redact(`could not place the execution contract in the worktree: ${error.message}`);
          workers.push(worker);
          continue;
        }
      }

      const promptFile = join(promptsDir, `issue-${number}.md`);
      // In contract mode the artifact is the goal — the body CommandMate sends
      // after its own preamble — so the file still shows what the worker read.
      const prompt = contractMode ? buildContractGoal(plan, res.issue) : buildWorkerPrompt(plan, res.issue);
      writeFileSync(promptFile, `${prompt}\n`, 'utf8');

      workers.push(worker);
      supervisable.push({ worker, worktreeId: res.resolved.id, worktreePath: res.worktreePath, prompt, contractPath });
    }

    // 3b. Supervise the wave's workers CONCURRENTLY (Issue #1474). Each worker
    //     runs its own send -> wait -> commit-check -> nudge loop; because
    //     `commandmate wait` blocks until its worker idles, running them in
    //     parallel (the wave width is already <= max_parallel, so the runtime
    //     parallelism matches the plan bound) makes the wave take the slowest
    //     single worker instead of the sum. Each worker's commit detection,
    //     --max-turns, prompt handling and auto-yes respond stay strictly
    //     independent; the wave barrier below is unchanged.
    const contractVerdicts = new Map();
    await Promise.all(supervisable.map(async ({ worker, worktreeId, worktreePath, prompt, contractPath }) => {
      const supervised = contractMode
        ? await superviseWithContract(inputs, worktreeId, worktreePath, contractPath)
        : await superviseUntilCommit(inputs, worktreeId, worktreePath, prompt);
      worker.worker_state = supervised.state;
      worker.note = redact(supervised.note);
      if (supervised.taskId) worker.task_id = supervised.taskId;
      if (supervised.verdict) contractVerdicts.set(worker.issue, supervised.verdict);
      if (supervised.notJudged) notJudged.add(worker.issue);
      if (supervised.autoResponded) autoResponded = true;
      if (supervised.state === 'prompt') {
        worker.prompt = { detected: true, excerpt: supervised.promptExcerpt };
      }
    }));

    // 4. Wave barrier — every dispatched worker must have completed.
    const allCompleted = workers.length > 0 && workers.every((worker) => worker.worker_state === 'completed');

    // 5. Verification gate — only completed workers are verified, and every one
    //    must pass its profile baseline (re-run inside the worktree). Worker
    //    completion alone does not open this gate. Verification cwd's into the
    //    SAME worktree path the supervisor drove — the `commandmate ls` path, not
    //    the plan template — so a completed worker is never false-failed on a git
    //    path the send target never used (Issue #1473).
    //
    //    Issue #83: this loop used to be wrapped in `if (allCompleted)`, which
    //    conflated the GATE with the RECORDING. A wave where any one worker
    //    failed, timed out, raised a prompt or was refused a dispatch skipped the
    //    body entirely, so every OTHER worker of that wave kept the initialiser
    //    `{ran: false, outcome: 'not_run', gates: [], checks: []}` — including
    //    workers whose `wait --verify` had already returned exit 0 and whose note
    //    said so. merge/uat read exactly `worker_state === 'completed' &&
    //    verification.outcome === 'pass'`, so verified deliverables silently left
    //    the delivery path (`no_eligible_issues`) with the PR, CI, guarded-merge
    //    and UAT gates all bypassed rather than failed. The verdict is now
    //    recorded for every worker that has one; the barrier below is unchanged,
    //    because `allVerified` still starts at `allCompleted` and this loop can
    //    only ever clear it.
    let allVerified = allCompleted;
    for (const worker of workers) {
      // A carried worker was judged by the attempt that dispatched it, and this
      // attempt sent it nothing. Re-running the fallback baseline against its
      // worktree here would be a SECOND, weaker opinion about work a contract
      // gate already passed — and would fail outright once the branch is merged
      // and the worktree removed (Issue #98). Its transcribed verdict still
      // counts towards the barrier, in the `allVerified` line at the bottom.
      if (resume !== null && resume.carried.has(worker.issue)) {
        if (worker.verification.outcome !== 'pass') allVerified = false;
        continue;
      }
      if (contractMode) {
        // The verdict already exists: it is the exit code CommandMate returned
        // while the worker was supervised. Re-running anything here would be a
        // second opinion from a weaker judge.
        const verdict = contractVerdicts.get(worker.issue);
        if (verdict) {
          recordVerification(report, worker, {
            ran: verdict.ran,
            report_schema_version: null,
            outcome: verdict.outcome,
            gates: verdict.gates ?? [],
            checks: verdict.checks,
          }, 'contract');
        }
      } else if (worker.worker_state === 'completed') {
        // The fallback judge is an ACTION, not a stored verdict, so it runs for
        // the workers it can judge: the ones that completed. A failed or never
        // dispatched worker has no deliverable to re-run a baseline against.
        const worktreePath = worktreePaths.get(worker.issue) ?? safeWorktreeTarget(issueOf(plan, worker.issue).worktree ?? '');
        const verification = verifyWorker(inputs, worktreePath, plan.profile.baseline);
        recordVerification(report, worker, {
          ran: verification.ran,
          report_schema_version: null,
          outcome: verification.outcome,
          // The fallback judge is the baseline re-run: it has no contract
          // gates, and the commands it ran are already named in checks.
          gates: [],
          checks: verification.checks,
        }, 'baseline');
        if (verification.note) worker.note = worker.note ? `${worker.note}; ${verification.note}` : verification.note;
      }
      // A completed worker whose verdict was never recorded is the #83 defect
      // itself. It is reported rather than passed over in silence: the note says
      // so, a limitation names it, and the completion check below fails.
      if (worker.worker_state === 'completed' && !worker.verification.ran) {
        verificationUnrecorded.add(worker.issue);
        report.limitations.push({
          code: 'verification_unrecorded',
          detail: `#${worker.issue} completed but no verification verdict was recorded for it, so its verification.outcome stays not_run and merge/uat will not treat it as eligible; this is a runner defect, not a worker one`,
        });
        worker.note = appendNote(worker.note, 'verification was NEVER RECORDED for this completed worker (outcome not_run)');
      }
      if (worker.verification.outcome !== 'pass') allVerified = false;
    }

    const advanced = allCompleted && allVerified;
    const waveRecord = {
      index: waveIndex,
      dispatched: toDispatch.slice(),
      workers,
      barrier: { all_workers_completed: allCompleted, all_verifications_passed: allVerified, advanced },
    };
    report.waves.push(waveRecord);

    // 6. Decide whether the loop may continue to the next wave. `advanced` is
    //    `allCompleted && allVerified`, so a non-advanced wave halts the loop
    //    here — the barrier and the verification gate are enforced by that break.
    if (!advanced) {
      const prompted = workers.find((worker) => worker.prompt.detected && worker.worker_state === 'prompt');
      const unjudged = workers.find((worker) => notJudged.has(worker.issue));
      if (prompted) {
        report.human_required = true;
        halt('partial', 'human_required', 'human_input_required', `#${prompted.issue} raised a prompt; halted for a human (no auto-response)`);
      } else if (unjudged) {
        // Ranked above worker_failed and verification_failed on purpose: 99 is
        // "nothing judged this", which no amount of re-dispatching can resolve.
        report.human_required = true;
        halt('partial', 'dispatch_error', 'verification_not_judged',
          `#${unjudged.issue}: verification exited ${VERIFY_EXIT_NO_VERDICT} — the run ended error/cancelled, so no gate judged the work. Halted for a human; not re-instructed as a verification failure (exit ${VERIFY_EXIT_FAILED}) and not rounded to a pass`);
      } else if (unresolvedWorktrees.length > 0) {
        // Ranked above worker_failed (Issue #90). Both are `worker_state:
        // 'failed'`, but they are opposite findings: worker_failed means a
        // worker ran and did not finish (read its log, split the issue), while
        // this means NO worker was ever started because there was nothing to
        // send to. Reporting the generic code sent operators to re-plan an issue
        // whose only defect was a missing worktree.
        haltWith('partial', 'drift', worktreeUnresolvedReasons(unresolvedWorktrees));
      } else if (workers.some((worker) => worker.worker_state === 'failed')) {
        const failed = workers.find((worker) => worker.worker_state === 'failed');
        halt('partial', 'worker_failed', 'worker_failed', `#${failed.issue} did not complete; the next wave was not dispatched`);
      } else if (workers.some((worker) => worker.worker_state === 'timeout')) {
        const timed = workers.find((worker) => worker.worker_state === 'timeout');
        halt('partial', 'timeout', 'worker_timeout', `#${timed.issue} timed out; the next wave was not dispatched`);
      } else if (workers.some((worker) => worker.worker_state === 'not_dispatched')) {
        // A worker the runner REFUSED to start — no declared scope (Issue #50),
        // an unsafe worktree target — never ran, so it cannot be a verification
        // failure. Saying it was would name the wrong cause and send the
        // operator into a worktree to debug a plan-level defect.
        const skipped = workers.find((worker) => worker.worker_state === 'not_dispatched');
        halt('partial', 'dispatch_error', 'not_dispatched', `#${skipped.issue} was never dispatched: ${skipped.note || 'the runner refused to start it'}`);
      } else if (!allVerified) {
        const failedVerify = workers.find((worker) => worker.verification.outcome !== 'pass');
        halt('partial', 'verification_failed', 'verification_failed', `#${failedVerify.issue} completed but its verification did not pass; the next wave was not dispatched`);
      } else {
        halt('partial', 'dispatch_error', 'wave_not_advanced', `wave ${waveIndex} did not advance`);
      }
      break;
    }
  }

  // Auto-yes is an explicit deviation from the safe default; surface it, but do
  // not treat an authorized auto-response as a broken invariant.
  if (autoResponded) {
    report.limitations.push({ code: 'auto_yes_used', detail: 'a worker prompt was auto-answered because --auto-yes was set' });
  }

  // Whether a worktree id came from the first `ls` or from the one after a
  // `commandmate sync` is a fact about how this run resolved its targets, so it is
  // recorded whatever the outcome — including on the runs it made succeed.
  recordSyncAttempt(report);

  // Completion self-check. `no_auto_prompt_response` guards the safe default: a
  // prompt is never answered UNLESS --auto-yes was explicitly set.
  // A resume with nothing left to dispatch mutates nothing, so there is no
  // mutating wave for a drift re-check to guard. That is a satisfied check, not
  // a skipped one — but it must SAY so rather than borrow the sentence about a
  // check that really ran (Issue #98).
  const driftReconfirmed = report.drift_checks.length > 0 || nothingToDispatch;
  report.completion_check = buildCompletionCheck({
    planApproved: true,
    driftReconfirmed,
    driftDetail: report.drift_checks.length === 0 && nothingToDispatch
      ? 'nothing was dispatched (every issue was already completed and verified in a prior attempt), so there was no mutating wave to re-check drift before'
      : null,
    parallelismBounded,
    barrierEnforced,
    noAutoPromptResponse: !autoResponded || inputs.autoYes,
    verificationRecorded: [...verificationUnrecorded],
    reportStatus: report.status,
  });
  if (!report.completion_check.passed && report.status === 'success') {
    report.status = 'partial';
    report.limitations.push({ code: 'completion_check_failed', detail: 'a completion check did not pass; see completion_check' });
  }

  report.redactions = redactionsList();
  report.summary_markdown = renderSummary(report, contractMode, openQuestions, resume);
  return report;
}

function buildCompletionCheck({ planApproved, driftReconfirmed, driftDetail = null, parallelismBounded, barrierEnforced, noAutoPromptResponse, verificationRecorded = [], reportStatus }) {
  const checks = [
    { id: 'plan_approved', passed: planApproved, detail: planApproved ? 'an approved plan was loaded and validated' : 'no valid plan was loaded' },
    { id: 'drift_reconfirmed', passed: driftReconfirmed, detail: driftDetail ?? (driftReconfirmed ? 'drift was re-checked before dispatch' : 'no drift check ran') },
    { id: 'parallelism_bounded', passed: parallelismBounded, detail: parallelismBounded ? 'no wave dispatched more than max_parallel workers' : 'a wave exceeded max_parallel and was truncated' },
    { id: 'barrier_enforced', passed: barrierEnforced, detail: barrierEnforced ? 'the next wave dispatched only after completion AND verification' : 'the wave barrier was not enforced' },
    { id: 'no_auto_prompt_response', passed: noAutoPromptResponse, detail: noAutoPromptResponse ? 'no prompt was answered without explicit --auto-yes' : 'a worker prompt was answered without authorization' },
    // Issue #83. `completed` with no verdict recorded is not a verification
    // failure and not a worker failure — it is the RUNNER failing to write down
    // what it was told. It used to be indistinguishable from "verification did
    // not run", which merge/uat read as ineligible and no one read as a bug.
    {
      id: 'verification_recorded',
      passed: verificationRecorded.length === 0,
      detail: verificationRecorded.length === 0
        ? 'every completed worker carries the verification verdict that judged it'
        : `no verification verdict was recorded for completed worker(s) ${verificationRecorded.map((n) => `#${n}`).join(', ')}; the report cannot say what judged them`,
    },
  ];
  // A failure result is a legitimate outcome, but it still must not claim a
  // passed completion check unless every invariant above actually held.
  const passed = checks.every((check) => check.passed) && reportStatus !== 'failure';
  return { passed, checks };
}

// =============================================================================
// Summary
// =============================================================================

// The preparation stage's own vocabulary (Issue #93). The summary is rendered
// from the REPORT rather than from the stage's return value so the two cannot
// disagree: every sentence below is a code that is also in the JSON.
const PREPARATION_LIMITATION_CODES = ['worktree_setup_ran', 'worktree_prepared', 'worktree_setup_partial', 'worktree_setup_skipped'];
const PREPARATION_BLOCKING_CODES = ['worktree_setup_unavailable', 'worktree_setup_failed', 'worktree_profile_mismatch'];

function renderSummary(report, contractMode = false, openQuestions = [], resume = null) {
  const lines = [];
  const haltedOnQuestions = report.blocking_reasons.some((reason) => reason.code === 'open_questions');
  const worktreeUnresolved = report.blocking_reasons.some((reason) => reason.code === 'worktree_unresolved');
  const preparationLimitations = report.limitations.filter((entry) => PREPARATION_LIMITATION_CODES.includes(entry.code));
  const preparationBlocking = report.blocking_reasons.filter((entry) => PREPARATION_BLOCKING_CODES.includes(entry.code));
  lines.push('## 対象と結論');
  const verb = report.status === 'success' ? '完了' : report.status === 'partial' ? '途中停止' : '未実行';
  lines.push(`plan ${report.plan_run_id} を ${report.profile.repository} に dispatch: ${report.status}（${verb}, stop=${report.stop_reason}）。`);
  // A run that dispatched nobody judged nobody. Naming the adjudication
  // mechanism there states a past-tense fact that never happened (Issue #90).
  // A resume that had nothing left to dispatch judged nobody either, but it does
  // hold verdicts — carried ones. Saying "契約で裁定した" there would claim this
  // attempt ran a gate it never ran (Issue #98).
  const dispatchedAny = report.waves.some((wave) => wave.dispatched.length > 0);
  lines.push(report.waves.length === 0
    ? '裁定: 1件も dispatch していないため、裁定は行っていない。'
    : (resume !== null && !dispatchedAny)
        ? '裁定: この attempt では 1件も dispatch していない。verification はすべて前回 attempt の記録を引き継いだもので、ここで再判定はしていない。'
        : contractMode
          ? '裁定: 実行契約（`commandmate send --contract` / `wait --verify` の exit code）を一次ソースにした。'
          : '裁定: 実行契約は使わず、profile baseline を worktree 内で再実行するフォールバックで判定した。');
  const notJudged = report.blocking_reasons.find((reason) => reason.code === 'verification_not_judged');
  if (haltedOnQuestions) lines.push('plan の Issue に未回答の open question が残っていたため、worker を 1 人も dispatch せずに停止した。');
  else if (notJudged) lines.push('検証が判定に到達しなかった（exit 99）ため、不合格として再指示せず human 提示で停止した。');
  else if (report.human_required) lines.push('worker が prompt を出したため、自動応答せず human 提示で停止した。');
  else if (worktreeUnresolved) lines.push('対象 Issue の worktree が `commandmate ls` で解決できなかったため、その Issue には worker を dispatch していない（worker の失敗ではない）。');
  lines.push('');

  // The resume section (Issue #98). Placed first because every other section is
  // read against it: which attempt this is, what was NOT re-run and why, and
  // what this attempt actually dispatched.
  if (resume !== null) {
    lines.push('## resume');
    lines.push(`- attempt ${resume.attempt}（resumed_from: \`${resume.priorRelative}\` / attempt ${resume.priorAttempt}）。既存 artifact は上書きしていない。この attempt の artifact は \`${RESUME_ATTEMPT_PREFIX}${resume.attempt}/\` 配下。`);
    lines.push(resume.carriedIssues.length === 0
      ? '- 引き継ぎ: なし（前回 attempt に「worker completed かつ verification pass」の Issue が無かった）。'
      : `- 引き継ぎ（再 dispatch しない）: ${resume.carriedIssues.map((n) => `#${n}`).join(', ')} — worker completed かつ verification pass。verification 記録は転記しただけで、ここで再判定はしていない。`);
    lines.push(resume.redispatchIssues.length === 0
      ? '- **再実行対象なし**: plan の全 Issue が既に completed かつ verification pass だった。1件も dispatch していない。'
      : `- 再実行対象: ${resume.redispatchIssues.map((n) => `#${n}`).join(', ')}。`);
    lines.push('- 引き継ぎ分は Wave barrier 上「完了」として数えるので、依存元が pass 済みの Issue はその Wave を待たずに dispatch される。');
    lines.push('');
  }

  // The questions themselves, verbatim. A code alone ("open_questions") tells an
  // operator that something is missing but not what to write in the issue, so the
  // text is reproduced here whether the gate stopped the run or was waived
  // (Issue #52).
  if (openQuestions.length > 0) {
    lines.push('## open question');
    lines.push(haltedOnQuestions
      ? '- 次の question に Issue 本文で答えて re-plan する（引き受けて進めるなら `--allow-questions`）。'
      : '- `--allow-questions` により、次の question を未回答のまま dispatch した。');
    for (const entry of openQuestions) {
      for (const question of entry.questions) {
        lines.push(`- #${entry.issue}: ${excerpt(redact(question), 200)}`);
      }
    }
    lines.push('');
  }
  // The preparation stage, when it was asked for. Placed before the waves
  // because it happened before them, and because a run that stopped here never
  // had a wave to report (Issue #93).
  if (preparationLimitations.length > 0 || preparationBlocking.length > 0) {
    lines.push('## worktree 準備');
    lines.push('- `--prepare-worktrees` 指定。pre-flight で未解決だった Issue の worktree は `cmate-worktree-setup` に作らせる（dispatch 自身は worktree を作らない）。');
    for (const entry of preparationBlocking) lines.push(`- 停止: ${entry.code} — ${entry.detail}`);
    for (const entry of preparationLimitations) lines.push(`- ${entry.code}: ${entry.detail}`);
    lines.push('');
  }

  lines.push('## Wave');
  if (report.waves.length === 0) {
    lines.push('- dispatch 前に停止（wave なし）。');
  } else {
    for (const wave of report.waves) {
      const dispatched = wave.dispatched.map((n) => `#${n}`).join(', ') || 'なし';
      lines.push(`- Wave ${wave.index + 1}: dispatch=${dispatched} / worker完了=${wave.barrier.all_workers_completed} / verify pass=${wave.barrier.all_verifications_passed} / 次waveへ=${wave.barrier.advanced}`);
    }
  }
  lines.push('');
  lines.push('## worker と verification');
  const workers = report.waves.flatMap((wave) => wave.workers);
  if (workers.length === 0) {
    lines.push('- worker なし。');
  } else {
    for (const worker of workers) {
      lines.push(`- #${worker.issue}: worker=${worker.worker_state} / verify=${worker.verification.outcome}${worker.prompt.detected ? ' / prompt検出（human必要）' : ''}`);
    }
  }
  lines.push('');
  lines.push('## drift 再確認');
  const lastWave = report.waves.length ? report.waves[report.waves.length - 1].index : 0;
  const lastChecks = report.drift_checks.filter((check) => check.wave_index === lastWave);
  if (lastChecks.length === 0) {
    lines.push('- drift check なし。');
  } else {
    for (const check of lastChecks) {
      lines.push(`- ${check.code}: ${check.ok ? 'ok' : 'NG'}${check.blocking ? '' : '（非blocking）'}`);
    }
  }
  lines.push('');
  lines.push('## 未解決と next action');
  if (report.blocking_reasons.length === 0 && report.limitations.length === 0) {
    lines.push('- なし。全 wave が完了し verification も pass した。');
  } else {
    for (const reason of report.blocking_reasons) lines.push(`- blocking: ${reason.code} — ${reason.detail}`);
    for (const limitation of report.limitations) lines.push(`- limitation: ${limitation.code} — ${limitation.detail}`);
    if (haltedOnQuestions) {
      lines.push('- next: 上記 open question を Issue 本文に反映して plan を作り直す。回答せずに進めると判断したなら `--allow-questions` を明示して再実行する（owner: human）。');
    }
    if (report.human_required && !haltedOnQuestions && !report.blocking_reasons.some((reason) => reason.code === 'verification_not_judged')) {
      lines.push('- next: 提示した prompt を human が確認し、承認のうえ再開する（owner: human）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'verification_not_judged')) {
      lines.push('- next: 判定に到達しなかった検証 run（exit 99）を human が調べる。契約が run に束ねられたか・タスクが既に終端でないかを確認する。20（判定して不合格）ではないので worker への再指示ループには流さない（owner: human）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'contract_unsupported')) {
      lines.push('- next: CommandMate を 0.17.0 以上へ更新して契約経路で再実行するか、`--contract-mode auto` でフォールバック実行する（owner: operator）。');
    }
    if (report.limitations.some((reason) => reason.code === 'contract_unsupported')) {
      lines.push('- next: 契約非対応の CLI だったため裁定はフォールバック（baseline 再実行）である。契約ゲートで裁定したい場合は CommandMate を 0.17.0 以上へ更新する（owner: operator）。');
    }
    // `commandmate sync` is the only fix for "the worktree is on disk but the
    // server never scanned it", so a CLI without it turns a registration gap into
    // an unresolved worktree the operator would otherwise re-create by hand.
    if (report.limitations.some((reason) => reason.code === 'worktree_sync_unavailable')) {
      lines.push('- next: `commandmate sync` が使えない CLI だったため、server 未登録の worktree を登録し直せていない。worktree が disk に実在するなら CommandMate を 0.21.0 以上へ更新して再実行する（owner: operator）。');
    }
    // The resume next-actions (Issue #98). The point of the whole feature is that
    // a partial failure now has a one-command answer, so the summary states that
    // command instead of leaving "再 dispatch する" to be interpreted as re-plan.
    if (report.limitations.some((entry) => entry.code === 'resume_no_work')) {
      lines.push('- next: 再実行対象は無い。この attempt の report をそのまま merge / uat に渡す（owner: operator）。');
    }
    if (report.stop_reason === 'verification_failed') lines.push('- next: verification 失敗の worktree を診断し、修正後に再 dispatch する（owner: operator）。');
    if (report.status !== 'success' && report.out_dir !== null) {
      lines.push('- next: 原因を直したら `dispatch.mjs --plan <plan.json> --resume <この run の dispatch ディレクトリ>` で再開する。worker completed かつ verification pass の Issue は再 dispatch されず、その verification 記録だけが引き継がれる（owner: operator）。');
    }
    // The conditional dependency, named (Issue #93). A stage the operator asked
    // for and that could not run must say what to install and what to pass —
    // "worktree を作成して再実行" is the answer to a different question.
    if (report.blocking_reasons.some((reason) => reason.code === 'worktree_setup_unavailable')) {
      lines.push('- next: `cmate-worktree-setup` を install し、`--worktree-setup <launcher>` でその呼び出し口を渡して再実行する。`--prepare-worktrees` を外せば従来どおり「worktree を自分で作ってから dispatch」になる（owner: operator）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'worktree_setup_failed')) {
      lines.push('- next: `cmate-worktree-setup` provider の出力（blocking reason）を読んで原因を直し、同じコマンドで再実行する。**作成済みの worktree は削除していない**ので、再実行の対象は残りの Issue だけになる（owner: operator）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'worktree_profile_mismatch')) {
      lines.push('- next: plan と `cmate-worktree-setup` に**同じ profile（同じ `branch_template`）**を渡す。branch が一致しないと `commandmate ls` の branch 一致では解決できない。既に作られた branch を使いたいなら、その branch を作る profile で plan を作り直す（owner: operator）。');
    }
    // The worktree case names the fix (Issue #90). "drift を解消して再開" is true
    // but useless here: nothing about branch/base/permission moved — a worktree
    // was never created. The `--out` sentence matters because it is the whole
    // reason the pre-flight runs before the run directory: the operator can
    // re-run the SAME command, not invent a new output path.
    if (worktreeUnresolved) {
      lines.push(`- next: cmate-worktree-setup で未解決 Issue の worktree を作成し（plan と同じ profile / 同じ branch_template）、${report.out_dir === null ? '同じコマンドで再実行する（`--out` は消費していない）' : '再 dispatch する'}（owner: operator）。1つのコマンドで通したいなら \`--prepare-worktrees --worktree-setup <launcher>\` を付けて再実行する。`);
    } else if (report.stop_reason === 'drift') {
      lines.push('- next: drift（branch/base/permission）を解消し、plan を再確認して再開する（owner: operator）。');
    }
  }
  return lines.join('\n');
}

// =============================================================================
// Failure envelope
// =============================================================================

function dispatchFailure(error) {
  return {
    dispatch_schema_version: DISPATCH_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    status: 'failure',
    stop_reason: 'dispatch_error',
    human_required: false,
    plan_run_id: 'unknown',
    out_dir: null,
    auto_yes: false,
    max_parallel: 1,
    profile: { id: 'unknown', repository: 'unknown/unknown', base: 'unknown', verified: false },
    drift_checks: [],
    waves: [],
    blocking_reasons: [{ code: error.code, detail: redact(error.detail ?? error.message) }],
    limitations: [],
    redactions: redactionsList(),
    completion_check: buildCompletionCheck({
      planApproved: false,
      driftReconfirmed: false,
      parallelismBounded: true,
      barrierEnforced: true,
      noAutoPromptResponse: true,
      reportStatus: 'failure',
    }),
    summary_markdown: `## 対象と結論\ndispatch 失敗（${error.code}）。${redact(error.detail ?? error.message)}`,
  };
}

// =============================================================================
// Entry point
// =============================================================================

async function run(argv) {
  const parsed = parseCli(argv);
  if (parsed.values.help) {
    process.stderr.write(`${USAGE}\n`);
    return { exitCode: 0, stdout: null };
  }

  const inputs = resolveInputs(parsed);
  const rawPlan = loadPlan(inputs.planPath);
  const plan = validatePlan(rawPlan);

  // The resume decision (Issue #98) is made FIRST: it decides which directory
  // this attempt writes into, which wave the pre-flight has to probe, and which
  // issues it may demand a worktree for. It is also where a report from another
  // plan is refused — before anything is probed, sent or written.
  const resume = inputs.resumeDir === null ? null : buildResume(inputs, plan);
  const outDir = resume !== null ? inputs.resumeDir : (inputs.outDir ?? join(dirname(inputs.planPath), 'dispatch'));
  // `--out` claims a new directory; `--resume` appends into an existing one, and
  // protects the earlier attempts by writing under a `resume-attempt-<n>/` name
  // that does not exist yet (nextAttemptNumber) rather than by refusing here.
  if (resume === null && existsSync(outDir)) {
    throw new SkillError('out_exists', `dispatch directory ${outDir} already exists; refusing to overwrite`, 4);
  }
  // Where THIS attempt's artifacts go — the run directory on a first dispatch,
  // `<run-dir>/resume-attempt-<n>/` on a resume.
  const attemptDir = resume === null ? outDir : resume.attemptDir;

  // Blocking pre-flight, BEFORE the attempt directory exists (Issue #90).
  // Skipped when the plan alone already refuses the run: the open-questions gate
  // is a pure function of the plan, and probing a world whose answer can no
  // longer change anything is a side effect for nothing (the same reason the
  // contract probe is skipped once the run has stopped). That gate still reports
  // from inside runDispatch, so its artifacts are written exactly as before.
  // Skipped too when a resume has nothing left to dispatch: there is no mutating
  // wave to guard, and a carried issue's worktree may legitimately be gone.
  const refusedOnQuestions = !inputs.allowQuestions && collectOpenQuestions(plan).length > 0;
  const preflightWave = resume === null ? 0 : resume.firstActiveWave;
  const preflightIssues = resume === null
    ? plan.waves[0]
    : (preflightWave < 0 ? [] : resume.waveDispatch[preflightWave].slice(0, plan.max_parallel));
  const skipPreflight = refusedOnQuestions || preflightWave < 0;
  let preflight = skipPreflight ? null : preflightDispatch(inputs, plan, preflightWave, preflightIssues);

  // The worktree preparation stage (Issue #93), between the refusal and the
  // refusal's report. It runs ONLY when the operator asked for it and only when
  // the pre-flight's whole complaint is missing worktrees; when it delivers, the
  // pre-flight is re-run against the changed world rather than patched — the
  // decision to dispatch is made by the same check either way, and anything the
  // preparation did not fix falls through to #90's unchanged refusal.
  let preparation = null;
  if (preflight !== null && preflight.blocked && inputs.prepareWorktrees) {
    preparation = blockedOnWorktreesOnly(preflight)
      ? prepareWorktrees(inputs, plan, preflight.unresolved)
      : skippedPreparation(preflight);
    if (preparation.ok) preflight = preflightDispatch(inputs, plan, preflightWave, preflightIssues);
  }

  if (preflight !== null && preflight.blocked) {
    const report = preflightFailureReport(inputs, plan, preflight, preparation, resume);
    process.stderr.write(`nothing was dispatched; ${attemptDir} was not created, so the same command can be re-run once the drift is fixed\n`);
    return { exitCode: 1, stdout: `${JSON.stringify(report, null, 2)}\n` };
  }

  mkdirSync(attemptDir, { recursive: true });

  const report = await runDispatch(inputs, plan, attemptDir, preflight, preparation, resume);
  writeFileSync(join(attemptDir, DISPATCH_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(attemptDir, DISPATCH_SUMMARY_FILE), `${report.summary_markdown}\n`, 'utf8');

  // The attempt ledger (Issue #98), at the run directory's root and append-only.
  // It is what makes the history readable by a machine without reopening every
  // report: which report each attempt wrote, what it resumed from, what it
  // carried and what it dispatched. Written for the first attempt too, so the
  // history has no implicit first line.
  const attempt = resume === null ? 1 : resume.attempt;
  appendAttemptHistory(outDir, {
    attempt,
    kind: resume === null ? 'initial' : 'resume',
    plan_run_id: plan.run_id,
    resumed_from: resume === null ? null : { attempt: resume.priorAttempt, report: resume.priorRelative },
    report: attemptReportRelative(attempt),
    summary: attemptSummaryRelative(attempt),
    status: report.status,
    stop_reason: report.stop_reason,
    carried_over: resume === null ? [] : resume.carriedIssues,
    dispatched: report.waves.flatMap((wave) => wave.dispatched),
  });

  process.stderr.write(`wrote dispatch artifacts to ${attemptDir}\n`);
  const exitCode = report.status === 'success' ? 0 : report.status === 'partial' ? 7 : 1;
  return { exitCode, stdout: `${JSON.stringify(report, null, 2)}\n` };
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    const { exitCode, stdout } = await run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      const report = dispatchFailure(error);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`error [${error.code}]: ${redact(error.detail ?? error.message)}\n`);
      process.exit(error.exitCode ?? 1);
    }
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

main();
