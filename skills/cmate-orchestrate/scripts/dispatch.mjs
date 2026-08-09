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
import { mkdirSync, existsSync, writeFileSync, readFileSync, appendFileSync, statSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
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
const SUPPORTED_PLAN_SCHEMA_VERSIONS = [1, 2];

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
// Unattended — the declaration that nobody is watching this invocation
// (Issue #122 / #142 / references/adr-unattended-mode.md sections 2, 3, 6.5,
// 8, 14.1, 14.2)
// =============================================================================
//
// `--unattended` is an INPUT DECLARATION, not a permission (ADR "裁定 0"). It
// disables no gate, downgrades no blocking reason to a limitation and raises no
// status by one step; what it adds is tightening, and nothing else. In
// particular it does NOT imply `--approve` (a flag this runner does not even
// have) and it does not answer prompts: a run that says "there is no human here"
// cannot also say "answer every prompt with yes".
//
// Stage C (Issue #142) reaches every runner: dispatch, `merge.mjs` (both
// phases) and `uat.mjs`. What it adds HERE over stage A is exactly one thing
// (ADR section 6.5): `verification_gates_unrecorded` becomes BLOCKING. A pass
// whose gates the report cannot name is an unattributed pass — readable, and
// correctable, by a human who opens the run, and with nobody reading it it is
// the whole basis on which an unattended `--merge-prs` would move a base branch.
// The promotion is tied to `--unattended`, not to any downstream flag, for the
// reason section 16.1 gives: an invocation's declaration must not mean different
// things depending on what some other job does later.
//
// `change_evidence_unavailable` is NOT promoted here — it is a merge-side
// limitation and stage B already promoted it (ADR section 6.5's correction note;
// section 16). Nothing about it is re-decided in this runner.
const UNATTENDED_STAGE = 'C（dispatch + merge + uat）';

// The exclusivity lock (ADR section 14.1). Issue #115 measured the window
// between process start and the creation of `--out`: two runs started 700 ms
// apart both passed the pre-flight, both invoked the `--prepare-worktrees`
// provider, and both then drove the SAME worktrees, interleaving their `send`s.
// `out_exists` is not a mutex there — the directory does not exist yet — and it
// is not one at all when `--out` varies per run (a timestamped cron output path)
// or when `--resume` appends into an existing directory.
//
// Ownership is the RUNNER's (candidate A of that section's table). The
// granularity is one lock per WORKTREE, because the harm is "two supervisors in
// one worktree", not "one plan run twice": two different plans can name the same
// worktree. The lock is NOT `--out` — Issue #90 decided that a run stopped in
// the pre-flight does not consume `--out`, and re-using it as a mutex would undo
// that decision.
//
// It is taken only under `--unattended`. A run without the flag is byte-for-byte
// what it was before this feature existed (ADR section 11), which is the
// property the whole fixture suite is pinned on; the residual gap — a human's
// ad-hoc run does not take the lock, so it can still collide with a cron run —
// is stated in the contract rather than papered over.
const LOCK_ROOT_ENV = 'CMATE_ORCHESTRATE_LOCK_DIR';
const LOCK_DIR_NAME = 'cmate-orchestrate-locks';
const LOCK_OWNER_FILE = 'owner.json';
// A lock whose owner record cannot be read is only reclaimed once it is older
// than this: the gap between `mkdirSync` and the `owner.json` write is
// microseconds, so an unreadable record in a fresh lock means "a run is starting
// right now", while an old one means "a run died between the two".
const LOCK_STALE_GRACE_MS = 60_000;
// Long enough for any branch a profile template produces, short enough that the
// key is a legal directory name everywhere. A truncation collision can only
// produce a spurious refusal, never a missed one.
const LOCK_KEY_MAX = 200;

// =============================================================================
// Worker method — the opt-in reference to a worker-side development Skill
// (Issue #128 / references/adr-worker-development-skill.md sections 3 and 9)
// =============================================================================
//
// What `--worker-method` adds is METHOD, never PERMISSION (ADR section 2). It
// relaxes no gate, widens no `scope.allow`, and grants no push/PR right; the
// contract still decides, and the task text says so in as many words.
//
// BOTH roots are required, and that is a measured decision rather than a
// cautious one. CommandMate deploys a Skill byte-identically into
// `.agents/skills/<id>/` (Codex) and `.claude/skills/<id>/` (Claude), and this
// runner does not know which Agent will pick the task up: it never passes
// `send --agent`, and the `ls --json` rows it resolves worktrees from carry
// id/branch/path and no agent at all. Accepting one side would therefore mean
// writing "read the skill in this worktree" into a contract whose worker may be
// structurally unable to see it — asserting something this runner cannot
// measure (ADR section 3.5). Requiring both is the only condition that holds
// whichever Agent runs, and the measurement says it costs nothing real: of the
// 45 `cmate-*` installs found across the worktrees on the development machine,
// 45 were two-sided (the one-sided packages there were all hand-authored,
// non-catalog ones). The runbook tells hand-placers to use both roots too, and
// the cost of being wrong is one `commandmate skill install` plus a re-run of
// the same command — `--out` is never consumed by this refusal.
const WORKER_METHOD_ROOTS = ['.claude/skills', '.agents/skills'];
// The file whose presence IS the install. A directory alone can be an empty
// leftover of an uninstall; the Skill's entry point existing is what makes
// "read it before you start" a true sentence.
const WORKER_METHOD_ENTRY = 'SKILL.md';
// A Skill id, mirroring the catalog's own id shape. It is interpolated into a
// path, so the pattern is also the path-escape guard: no separator, no dot, no
// leading dash can survive it.
const WORKER_METHOD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
  --reverify <dir>       Re-judge a prior dispatch WITHOUT sending anything:
                         <dir> is the --out directory of the run being re-judged.
                         The same carry-over rule as --resume applies (worker
                         completed AND verification passed is transcribed, never
                         re-judged); of the rest, every issue whose worktree
                         still HOLDS WORK — a commit on the work branch or an
                         uncommitted change, the two facts the work-evidence gate
                         counts — is put through the verification gate again as
                         it stands. Nothing is sent, no contract is written and
                         no worker turn is consumed, so an issue whose worker
                         finished after its report was frozen can rejoin the
                         delivery path without being asked to work again. An
                         issue with no work evidence is NOT re-judged: its prior
                         record is transcribed unchanged. Artifacts append under
                         <dir>/${RESUME_ATTEMPT_PREFIX}<n>/ exactly as a resume's
                         do. Mutually exclusive with --out and --resume.
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
  --worker-method <id>   Name a worker-side development Skill (e.g.
                         cmate-worker-development) whose method every dispatched
                         worker must follow. OFF by default, and the default is
                         not "on when it happens to be installed": without this
                         flag the run is byte-for-byte what it was before the
                         flag existed. With it, dispatch verifies the Skill is
                         installed in EVERY worktree it is about to dispatch into
                         (both ${WORKER_METHOD_ROOTS.join(' and ')}) and refuses the
                         run if it is not, then writes a "## Method" section
                         naming it into the task text. It adds METHOD only: no
                         gate is relaxed and no permission is widened.
  --unattended           Declare that NO HUMAN is watching this invocation (CI /
                         cron). It grants nothing: it does not imply --approve,
                         it answers no prompt, it disables no gate and it never
                         turns a blocking reason into a limitation. What it adds
                         is tightening — it implies --contract-mode require,
                         checks BEFORE creating --out that every issue in the
                         plan declares a scope (all-or-nothing), takes a
                         per-worktree exclusivity lock so a second run cannot
                         drive the same worktrees, requires --wall-clock-budget,
                         and records the pre-dispatch HEAD of every worktree it
                         drives so the run can be undone. Combining it with a
                         relaxing flag (--auto-yes, --allow-questions,
                         --contract-mode off|auto) is refused with invalid_input
                         rather than silently overridden.
  --wall-clock-budget <sec>
                         Stop the run once it has been running this long. The
                         remaining budget is also the timeout of every child
                         process the run spawns, which is the only bound on the
                         profile baseline and the acceptance commands (they have
                         none of their own). Reaching it is a partial run with
                         stop_reason "timeout" — never a success. OFF by default;
                         required with --unattended.
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
        reverify: { type: 'string' },
        cli: { type: 'string' },
        git: { type: 'string' },
        gh: { type: 'string' },
        'auto-yes': { type: 'boolean' },
        'allow-questions': { type: 'boolean' },
        unattended: { type: 'boolean' },
        'wall-clock-budget': { type: 'string' },
        'prepare-worktrees': { type: 'boolean' },
        'worktree-setup': { type: 'string' },
        'worker-method': { type: 'string' },
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

// The worker-method Skill id, validated here rather than at the probe. The id is
// interpolated into a path this runner reads inside somebody's worktree, so an id
// that is not an id is an input error, not a missing install: reporting
// `worker_method_unavailable` for `../../etc` would send the operator off to
// install something that was never nameable in the first place.
function resolveWorkerMethod(raw) {
  if (raw === undefined) return null;
  const id = String(raw).trim();
  if (!WORKER_METHOD_ID_RE.test(id)) {
    throw new SkillError('invalid_input',
      `--worker-method must be a skill id matching ${WORKER_METHOD_ID_RE.source} (e.g. cmate-worker-development); ` +
        'it names a directory this runner reads inside each worktree, so nothing else is accepted', 3);
  }
  return id;
}

// The unattended declaration and the tightening it implies (Issue #122 / ADR
// sections 2, 3, 4, 5). Returns the contract mode and the wall-clock budget
// because both are DECIDED here: under `--unattended` the mode is forced to
// `require` and the budget stops being optional.
//
// The three refusals are refusals rather than overrides on purpose (ADR
// section 2, invariant 2). A run that declared two contradictory things must not
// have one of them silently win: the reader of the report — which in unattended
// operation is the next CI job, not a person — cannot tell which one did. The
// same shape as #93's refusal of a double-specified `--worktree-setup`.
function resolveUnattended(values) {
  const contractMode = resolveContractMode(values['contract-mode']);
  const budget = positiveInt(values['wall-clock-budget'], 'wall-clock-budget', null);
  if (!values.unattended) return { unattended: false, contractMode, wallClockBudget: budget };

  if (values['auto-yes']) {
    throw new SkillError('invalid_input',
      '--unattended and --auto-yes cannot both hold: --auto-yes consumes the prompt stop (exit 10) with an unconditional '
        + '"yes", which makes the one halt that exists FOR the absent human structurally unreachable. Drop one of the two', 3);
  }
  if (values['allow-questions']) {
    throw new SkillError('invalid_input',
      '--unattended and --allow-questions cannot both hold: --allow-questions declares that somebody TAKES ON an unanswered '
        + 'planner question, and --unattended declares that nobody is here to take it on. Answer the questions in the issue '
        + 'body and re-plan', 3);
  }
  if (values['contract-mode'] !== undefined && contractMode !== 'require') {
    throw new SkillError('invalid_input',
      `--unattended implies --contract-mode require, so --contract-mode ${contractMode} is refused rather than overridden: `
        + 'the fallback path has no scope gate at all (an issue with no declared scope is dispatched there), and "no execution '
        + 'contract" is precisely the silent degradation nobody is present to read', 3);
  }
  if (budget === null) {
    throw new SkillError('invalid_input',
      '--unattended requires --wall-clock-budget <sec>: the turn caps bound the number of turns, not the clock, and the '
        + 'profile baseline and the acceptance commands have no timeout of their own. With a human present, the person who '
        + 'starts the run is the budget; with nobody present, the job definition is the only place the limit can be chosen', 3);
  }
  return { unattended: true, contractMode: 'require', wallClockBudget: budget };
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
  // The same reasoning for `--reverify` (Issue #121): it appends into the
  // directory it re-judges, so `--out` has nothing to choose either.
  if (values.reverify !== undefined && values.out !== undefined) {
    throw new SkillError('invalid_input',
      '--out and --reverify are mutually exclusive: a reverify appends into the directory it re-judges ' +
        `(<reverify-dir>/${RESUME_ATTEMPT_PREFIX}<n>/), so there is no second output path to choose`, 3);
  }
  // `--resume` and `--reverify` are opposite answers to the same question. A
  // resume decides "this issue is not finished, send it back to its worker"; a
  // reverify decides "the work is already there, judge it again as it stands and
  // send nothing". Accepting both would make the runner pick one of the two for
  // every non-carried issue, and the wrong pick either consumes a worker turn
  // nobody asked for or leaves unfinished work unfinished.
  if (values.reverify !== undefined && values.resume !== undefined) {
    throw new SkillError('invalid_input',
      '--resume and --reverify cannot both hold: a resume RE-DISPATCHES what did not finish, a reverify RE-JUDGES what is '
        + 'already in the worktree and sends nothing. Choose the one that matches why the prior attempt stopped', 3);
  }
  const unattended = resolveUnattended(values);
  return {
    planPath: values.plan,
    outDir: values.out ?? null,
    resumeDir: values.resume ?? null,
    reverifyDir: values.reverify ?? null,
    cliArgv,
    cli: cliArgv.join(' '),
    git: values.git ?? 'git',
    gh: values.gh ?? 'gh',
    autoYes: Boolean(values['auto-yes']),
    allowQuestions: Boolean(values['allow-questions']),
    unattended: unattended.unattended,
    wallClockBudget: unattended.wallClockBudget,
    prepareWorktrees,
    worktreeSetupArgv: resolveSetupLauncher(values['worktree-setup'], prepareWorktrees),
    workerMethod: resolveWorkerMethod(values['worker-method']),
    contractMode: unattended.contractMode,
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
  if (!SUPPORTED_PLAN_SCHEMA_VERSIONS.includes(plan.plan_schema_version)) {
    throw new SkillError(
      'plan_invalid',
      `unsupported plan_schema_version ${plan.plan_schema_version}; this runner understands ${SUPPORTED_PLAN_SCHEMA_VERSIONS.join(' or ')}`,
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

// =============================================================================
// Reverify — re-judge what is already there, without sending (Issue #121)
// =============================================================================
//
// `--resume` gave the recovery path Issue #89 was missing, but it recovers by
// RE-DISPATCHING. In #89's situation that is the wrong instrument: the worker
// timed out, then finished and committed anyway, and the only thing that is
// stale is the VERDICT frozen into the report. Re-dispatching there spends a
// worker turn on work that is done and hands the contract back to a worker that
// has no reason to touch anything — room for a diff nobody asked for.
//
// `--reverify <prior-out-dir>` splits the plan the same way `--resume` does and
// then does the opposite thing with the second half:
//
//   carried    `worker_state: completed` AND `verification.outcome: pass`.
//              Transcribed, exactly as on a resume, and NOT re-judged. Identical
//              code (`isCarryable` / `carriedWorkerRecord`) on purpose: the two
//              flags must not disagree about who is already finished.
//   re-judged  the rest, RESTRICTED to the issues whose worktree still holds
//              work. Put through the verification gate as they stand.
//   left       the rest of the rest — no work evidence. The prior record is
//              transcribed unchanged and a limitation says why.
//
// `send` is never called. That is the whole reason the flag exists, and it is
// what the fixtures pin (`sent: []`).
//
// WHAT COUNTS AS "THERE IS WORK HERE" (the one thing this must not guess).
// It is the work-evidence gate's own criterion, and nothing else: A COMMIT ON
// THE WORK BRANCH, OR AN UNCOMMITTED CHANGE IN THE WORKTREE. CommandMate's
// work-evidence gate counts exactly those two facts, `wait --verify`'s exit 21
// is that gate finding neither, and this repository's own work-evidence check
// asks the same question. Three reasons it is measured HERE, with git, rather
// than inferred or delegated:
//
//   1. The prior report cannot answer it. A `timeout` worker's record says
//      `verification.outcome: not_run` — the gate never ran, so the report holds
//      no measurement at all. Reading "timed out" as "probably has work" is the
//      guess the Issue forbids.
//   2. Delegating it to `commandmate verify` would make the answer arrive as a
//      VERDICT (exit 21 = fail). Recording that would DOWNGRADE the record of an
//      issue nobody ever worked on, on the strength of a run this flag exists to
//      avoid making. The adjudication rules are fixed (exit 21 means what it has
//      always meant), so the only way to keep them fixed is not to ask.
//   3. It must hold on the fallback path too. Without an execution contract the
//      judge is the profile baseline, which measures the deliverable and knows
//      nothing about work evidence; a criterion that only existed under a
//      contract would make `--reverify` mean two different things.
//
// The measurement is fail-closed: a worktree whose commits AND whose status
// cannot be read is NOT re-judged (`reverify_evidence_unreadable`). "We could not
// look" is not "there is something there".
//
// THE VERDICT is taken from the same judge the ordinary path uses, in the same
// mode: `commandmate verify <worktree-id> --json` under a contract (whose exit
// code IS the verdict, 0/20/21/99 with the meanings section 2.1 already fixes),
// and the profile-baseline re-run without one. No new CLI surface is asked for.
//
// COMPLETION stays what it has always been: a commit on the work branch. A
// re-judged issue is `completed` when the branch carries one — which is what
// makes it eligible for merge again — and keeps its prior state when the work in
// the tree is uncommitted, because nothing downstream can deliver an uncommitted
// change and this flag cannot ask for the commit (it does not send).
//
// THE EXCLUSIVITY LOCK IS TAKEN, on the same terms as any other unattended run
// (ADR section 14.1). Adjudicated rather than assumed: the flag sends nothing,
// so no second SUPERVISOR appears — but `commandmate verify` RUNS THE
// REPOSITORY'S GATES INSIDE THE WORKTREE, and the verdict it produces is written
// into a report that merge reads as eligibility. Judging a tree another run's
// worker is actively writing to yields a verdict about a state that never
// existed as a deliverable, and then delivers it. The lock's granularity is
// already "one supervisor per worktree" for that reason; a reader-that-judges is
// inside it. Carried issues are excluded from the lock set exactly as on a
// resume — their worktree is never touched and may legitimately be gone.
//
// Everything else is deliberately unchanged: the attempt layout
// (`resume-attempt-<n>/`, append-only, one ledger line), the consistency guards
// (a report from another plan or one that cannot be read is refused before
// anything is probed), the exit codes, and `dispatch_schema_version` staying 1.

// The two operations that read a prior dispatch report back in. They are the
// same refusals reached through different flags, so the wording is parameterised
// instead of duplicated — a second copy is a second thing to keep true.
const RESUME_OP = {
  flag: '--resume',
  verb: 'resume',
  verbed: 'resumed',
  because: 'A resume carries verification verdicts forward as fact',
};
const REVERIFY_OP = {
  flag: '--reverify',
  verb: 'reverify',
  verbed: 're-judged',
  because: 'A reverify carries the passing verdicts forward as fact and re-judges the rest against the same report',
};

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
function priorReport(outDir, op = RESUME_OP) {
  if (!existsSync(outDir)) {
    throw new SkillError('load_error',
      `${op.flag} ${outDir} does not exist; it must be the --out directory of the dispatch being ${op.verbed}`, 6);
  }
  let newest = { path: join(outDir, DISPATCH_REPORT_FILE), attempt: 1 };
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const candidate = join(resumeAttemptDir(outDir, attempt), DISPATCH_REPORT_FILE);
    if (!existsSync(candidate)) break;
    newest = { path: candidate, attempt };
  }
  if (!existsSync(newest.path)) {
    throw new SkillError('load_error',
      `${op.flag} ${outDir} holds no ${DISPATCH_REPORT_FILE}; there is no dispatch run there to ${op.verb}`, 6);
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

function loadResumeReport(path, plan, op = RESUME_OP) {
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
      `the report at ${path} cannot be ${op.verbed}: it is not valid JSON (${redact(error.message)}). ` +
        `${op.because}, so a report this runner cannot read is refused rather than partly believed`, 3);
  }
  const nonConformance = resumeNonConformance(doc);
  if (nonConformance !== null) {
    throw new SkillError('resume_invalid',
      `the report at ${path} is not a dispatch report v${DISPATCH_SCHEMA_VERSION} this runner can ${op.verb}: ${nonConformance}. ` +
        `${op.because}, so a report whose shape cannot be checked is refused rather than partly believed`, 3);
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
        `(${plan.profile.repository} / ${plan.profile.base}). Refusing to ${op.verb} a different plan's run: the carried-over records would ` +
        'claim that issues of THIS plan are completed and verified on the strength of work that was planned somewhere else. ' +
        `Point ${op.flag} at that plan's own dispatch directory, or start a fresh dispatch with --out`, 3);
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
    .map((gate) => (gate.origin === 'repo' || gate.origin === 'issue'
      // Carried, never invented: a report written before origin existed has none,
      // and filling one in here would turn "nobody recorded this" into a claim
      // about where the gate came from (ADR §8.2).
      ? { id: redact(gate.id), verdict: gate.verdict, origin: gate.origin }
      : { id: redact(gate.id), verdict: gate.verdict }));
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

// The worker_state values the report schema allows. Needed only where a prior
// report's value is copied forward: the conformance check asserts the field is a
// string, and a hand-edited one that is a string but not a state must not be
// able to make THIS report unreadable.
const WORKER_STATE_VALUES = ['completed', 'failed', 'timeout', 'prompt', 'not_dispatched'];

// A prior worker's verification, re-validated on the way through. Same reasoning
// as `carriedWorkerRecord`'s — the report is an INPUT here — but unlike that one
// this transcribes the verdict AS IT STANDS. A reverify repeats what the prior
// attempt found for the issues it does not re-judge; it never promotes them.
function transcribedVerification(verification) {
  const source = (verification !== null && typeof verification === 'object' && !Array.isArray(verification)) ? verification : {};
  const gates = (Array.isArray(source.gates) ? source.gates : [])
    .filter((gate) => gate !== null && typeof gate === 'object'
      && typeof gate.id === 'string' && gate.id.length > 0
      && (gate.verdict === 'pass' || gate.verdict === 'fail'))
    .slice(0, MAX_REPORTED_GATES)
    .map((gate) => (gate.origin === 'repo' || gate.origin === 'issue'
      ? { id: redact(gate.id), verdict: gate.verdict, origin: gate.origin }
      : { id: redact(gate.id), verdict: gate.verdict }));
  const checks = (Array.isArray(source.checks) ? source.checks : [])
    .filter((check) => typeof check === 'string' && check.length > 0)
    .slice(0, MAX_REPORTED_GATES)
    .map((check) => redact(check));
  return {
    ran: source.ran === true,
    report_schema_version: Number.isInteger(source.report_schema_version) ? source.report_schema_version : null,
    // Anything that is not one of the two verdicts is `not_run`, which is what
    // the schema already means by it: nothing judged this.
    outcome: (source.outcome === 'pass' || source.outcome === 'fail') ? source.outcome : 'not_run',
    gates,
    checks,
  };
}

// A prior worker's prompt, re-validated the same way. Transcribed rather than
// cleared (which is what a CARRIED record does): a prompt the prior attempt
// stopped on is still pending in that worktree, and a reverify did not answer
// it — it does not send.
function transcribedPrompt(prompt) {
  const source = (prompt !== null && typeof prompt === 'object' && !Array.isArray(prompt)) ? prompt : {};
  const text = typeof source.excerpt === 'string' && source.excerpt.length > 0 ? redact(source.excerpt) : null;
  return { detected: source.detected === true, excerpt: text };
}

// The whole resume (or reverify) decision, computed once before anything is
// probed or written. `mode` selects which of the two this attempt is; the SPLIT
// is identical in both — same carry-over rule, same "everything else" set — and
// only what the second half is then subjected to differs (Issue #121).
function buildResume(inputs, plan, mode = 'resume') {
  const reverifying = mode === 'reverify';
  const dir = reverifying ? inputs.reverifyDir : inputs.resumeDir;
  const op = reverifying ? REVERIFY_OP : RESUME_OP;
  const prior = priorReport(dir, op);
  const doc = loadResumeReport(prior.path, plan, op);
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

  const attempt = nextAttemptNumber(dir);
  return {
    mode,
    reverifying,
    dir,
    attempt,
    attemptDir: resumeAttemptDir(dir, attempt),
    priorAttempt: prior.attempt,
    priorRelative: attemptReportRelative(prior.attempt),
    carried,
    carriedIssues: [...carried.keys()].sort((a, b) => a - b),
    // The prior record of every issue, carried and not. A reverify needs the
    // not-carried ones too: an issue it does not re-judge is transcribed as it
    // stood rather than blanked, so the report keeps saying what the attempt
    // that DID dispatch it found.
    priorRecords: latest,
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
  // The reverify twin (Issue #121). Its own code, because the two attempts are
  // not the same event and a reader that grepped `resume_attempt` must not find
  // an attempt that dispatched nobody. The carry-over half is worded identically
  // because it IS identical.
  if (resume.reverifying) {
    return {
      code: 'reverify_attempt',
      detail: `--reverify: attempt ${resume.attempt} of plan ${plan.run_id}; resumed_from=${resume.priorRelative} (attempt ${resume.priorAttempt}). `
        + `NOTHING WAS SENT: this attempt called no \`commandmate send\`, wrote no execution contract and consumed no worker turn. `
        + `Carried over without re-judging (worker completed and verification passed there): ${list(resume.carriedIssues)}. `
        + `Re-judged here from the worktree as it stands, if it holds work evidence (a commit on the work branch or an uncommitted change): ${list(resume.redispatchIssues)}. `
        + `The carried verification records are transcribed from that report and were NOT re-judged; `
        + `this attempt's artifacts are under ${RESUME_ATTEMPT_PREFIX}${resume.attempt}/ and no earlier attempt was overwritten`,
    };
  }
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

// The wall-clock deadline of this invocation, or null when no budget was set
// (Issue #122 / ADR section 14.2). Module state rather than a field on `inputs`
// because the two functions that have to honour it — `runCli` and its async twin
// — are module-level and are called from places that hold no `inputs`.
//
// Issue #115 measured why the budget cannot live in the supervision loop alone:
// `runCli` passes no `timeout` to `execFileSync`, so a profile baseline of
// `sleep 6` runs for six seconds with `--wait-timeout 1`. A budget checked only
// between turns would never be reached by a run wedged inside such a child. The
// order the spike prescribed ("first the child timeout, then the budget") is
// implemented as ONE rule: the remaining budget IS every child's timeout.
let wallClockDeadline = null;

function startWallClockBudget(seconds) {
  wallClockDeadline = typeof seconds === 'number' ? Date.now() + (seconds * 1000) : null;
}

function wallClockExhausted() {
  return wallClockDeadline !== null && Date.now() >= wallClockDeadline;
}

// A caller's own `timeout` always wins: this bounds children that have no bound,
// it does not lengthen one that was chosen deliberately.
function budgetedExtra(extra) {
  if (wallClockDeadline === null || extra.timeout !== undefined) return extra;
  return { ...extra, timeout: Math.max(1, wallClockDeadline - Date.now()) };
}

// One structured call to an external CLI. Never throws: a non-zero exit or a
// missing binary comes back as { ok: false }, so the caller decides whether that
// is drift, a worker failure, or fatal.
function runCli(bin, args, extra = {}) {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
      ...budgetedExtra(extra),
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
      ...budgetedExtra(extra),
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

// The two paths a worker-method Skill has to occupy in one worktree, in a fixed
// order so every message, every contract and every limitation names them the same
// way. Relative on purpose: they go into a contract a worker reads, and the
// worktree they are relative to is the worker's own cwd.
function workerMethodPaths(skillId) {
  return WORKER_METHOD_ROOTS.map((root) => `${root}/${skillId}/${WORKER_METHOD_ENTRY}`);
}

// Is the Skill really in this worktree? The same shape as the acceptance-gate
// probe (#114): read the worktree the `ls` resolution named, decide from what is
// actually there, and never from what the plan or the operator asserted.
//
// A path that cannot be stat'ed counts as missing rather than as an error. The
// question here is only "can a worker open this file", and every way the answer
// is no — absent, a directory, unreadable — has the same fix and the same
// consequence.
function probeWorkerMethod(worktreePath, skillId) {
  const found = [];
  const missing = [];
  for (const relative of workerMethodPaths(skillId)) {
    let readable = false;
    try {
      readable = statSync(join(worktreePath, relative)).isFile();
    } catch {
      readable = false;
    }
    (readable ? found : missing).push(relative);
  }
  return { ok: missing.length === 0, found, missing };
}

// Probe every issue of a wave whose worktree actually resolved. An issue whose
// worktree could not be resolved is already reported as `worktree_unresolved`;
// re-reporting it here as a missing Skill would name the wrong fix.
function workerMethodUnavailable(inputs, resolutions) {
  if (inputs.workerMethod === null) return [];
  return resolutions
    .filter((entry) => entry.templatePath !== null && entry.resolved.id !== null && Boolean(entry.worktreePath))
    .map((entry) => ({ number: entry.number, probe: probeWorkerMethod(entry.worktreePath, inputs.workerMethod) }))
    .filter((entry) => !entry.probe.ok);
}

// One blocking reason per issue whose worktree does not carry the Skill (ADR
// section 3.4). All-or-nothing: dispatching only the workers that happen to have
// it would make "the whole wave passed" mean something different in every run,
// which is the promise the wave barrier is built on (#93 論点2).
function workerMethodUnavailableReasons(entries, skillId) {
  return entries.map(({ number, probe }) => ({
    code: 'worker_method_unavailable',
    detail: redact(`#${number}: --worker-method ${skillId} was requested, but this worktree does not carry ${probe.missing.join(' or ')}`
      + `${probe.found.length > 0 ? ` (it does carry ${probe.found.join(', ')}, which is only half an install: the other Agent cannot see it, and this runner never learns which Agent takes the task)` : ''}`
      + `. Nothing was dispatched — a run started with --worker-method is a run whose premise is that the method is in place, and a contract naming a file the worker cannot open would state something this runner cannot measure. `
      + `Run \`commandmate skill install ${skillId}\` for this worktree and re-run the same command, or drop --worker-method`),
  }));
}

// The run-wide declaration (ADR section 9). One entry, recorded whether or not
// the run goes on to dispatch anything, because "this run was started with a
// method" is what every other line of the report is read against.
function workerMethodDeclaredLimitation(skillId) {
  return {
    code: 'worker_method_declared',
    detail: `--worker-method ${skillId}: this run declares a worker-side development method. Before dispatching, each worktree is checked for ${workerMethodPaths(skillId).join(' and ')}, and every dispatched issue's task text carries a \`## Method\` section naming them. `
      + 'The method adds HOW only: it does not widen scope.allow, relax a gate or authorise a push or PR — where the two disagree the contract wins. '
      + 'This records that the reference was DECLARED; whether a worker actually followed the method is not measured by dispatch',
  };
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
  // The worker-method probe, and why it is HERE (Issue #128 / ADR section 3.4).
  // A missing method Skill is refused on the same terms #90 refuses a missing
  // worktree: before the run directory exists, so the fix (`skill install`) is
  // followed by the SAME command rather than by inventing a new `--out`.
  // Only reached when the world is otherwise sound — a worktree that did not
  // resolve has no path to probe, and its own reason already names the fix.
  const methodMissing = blocking ? [] : workerMethodUnavailable(inputs, resolutions);
  const reasons = blocking
    ? (blocking.code === 'worktrees_present' && unresolved.length > 0
      ? worktreeUnresolvedReasons(unresolved)
      : [{ code: `drift_${blocking.code}`, detail: blocking.detail }])
    : workerMethodUnavailableReasons(methodMissing, inputs.workerMethod);
  return {
    waveIndex,
    resolutions,
    checks,
    unresolved,
    blocked: Boolean(blocking) || methodMissing.length > 0,
    reasons,
  };
}

// The report a blocked pre-flight prints. `out_dir` is null because nothing was
// written — the field already means "null when nothing was written", and it is
// how a reader (and the summary) can tell that the same command may simply be
// re-run once the drift is fixed.
function preflightFailureReport(inputs, plan, preflight, preparation = null, resume = null, lockKeys = []) {
  const report = emptyReport(inputs, plan, null);
  report.status = 'failure';
  // The unattended declaration outlives the refusal, exactly like the
  // worker-method one below: what a stopped run was declared to be is part of
  // reading why it stopped (Issue #122 / ADR section 7.2).
  if (inputs.unattended) report.limitations.push(unattendedModeLimitation(inputs, lockKeys));
  // A refused resume still says it WAS a resume, and what it would have carried:
  // otherwise the reader cannot tell a first attempt that stopped from a fourth
  // one, and the re-run advice below ("re-run the same command") is only true
  // because this attempt's directory was never created either (Issue #98).
  if (resume !== null) report.limitations.push(resumeLimitation(plan, resume));
  // The declaration survives the refusal: a report that stopped because the
  // method was missing must still say which method the operator asked for
  // (Issue #128 / ADR section 9).
  if (inputs.workerMethod !== null) report.limitations.push(workerMethodDeclaredLimitation(inputs.workerMethod));
  // A preparation that could not run is not drift: nothing about branch, base or
  // permission moved — a conditional dependency was missing, misconfigured or
  // disagreed with the plan's profile. `dispatch_error` is the pre-dispatch stop
  // the schema already reserves for that shape (Issue #93).
  // A missing worker-method Skill is the same shape and reuses the same
  // stop_reason rather than adding one to the enum: the operator's move is
  // "install the conditional dependency and re-run", exactly as it is for #93.
  const preparationFailed = preparation !== null && preparation.reasons.length > 0;
  const methodBlocked = preflight.reasons.some((reason) => reason.code === 'worker_method_unavailable');
  report.stop_reason = preparationFailed || methodBlocked ? 'dispatch_error' : 'drift';
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
// Unattended — exclusivity, the plan-only refusal, and the undo baseline
// (Issue #122 / references/adr-unattended-mode.md sections 3, 7.2, 14.1)
// =============================================================================

// Where the per-worktree locks live. `$TMPDIR` (per user, per machine) is the
// default because the lock has to be found by EVERY starter on the machine — a
// cron job, a CI step and a person all reach the same directory. The override
// exists for a caller that needs an explicit location (and for this repository's
// fixtures, which must not touch a shared directory); a job definition that
// points it somewhere different per run has turned the lock off, which is why
// the contract says so out loud.
function lockRoot() {
  const override = process.env[LOCK_ROOT_ENV];
  return override && override.trim() !== '' ? override.trim() : join(tmpdir(), LOCK_DIR_NAME);
}

// CommandMate derives a worktree id from (repository, branch); so does this key.
// It does not have to EQUAL the server's id — nothing compares the two — it has
// to be a stable, collision-free function of the same pair, because that pair is
// what identifies the worktree before `commandmate ls` has been asked (the lock
// is taken before the pre-flight, which is where `ls` happens).
function worktreeLockKey(plan, issue) {
  const slug = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const repo = slug(String(plan.profile.repository ?? '').split('/').pop() ?? '');
  const branch = slug(issue.branch);
  const key = `${repo}-${branch}`.replace(/^-|-$/g, '');
  return (key === '' ? `issue-${issue.number}` : key).slice(0, LOCK_KEY_MAX);
}

// Is the process that wrote this lock still running? EPERM means "alive, owned
// by somebody else" — the answer is still alive, so the lock still holds.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// The stale-lock rule, decided here because a lock nobody can reclaim is worse
// than no lock at all (ADR section 14.1 requires this rule to be stated):
//
//   1. the owner record names a LIVE pid on THIS host  -> held, refuse;
//   2. the owner record names a DEAD pid on this host  -> stale, reclaim. This is
//      the `kill -9` case: the run died without releasing;
//   3. the owner record names ANOTHER host             -> refuse. This process
//      cannot judge the liveness of a pid on a machine it is not on;
//   4. the owner record is missing or unreadable       -> reclaim only once the
//      directory is older than the grace period. A fresh one means a run is
//      between its `mkdirSync` and its `owner.json` write, which is microseconds.
//
// Refusing is always the safe error: it costs a re-run, while reclaiming a live
// lock costs two supervisors in one worktree — the exact state this prevents.
function lockOwnerVerdict(dir) {
  let owner = null;
  try {
    owner = JSON.parse(readFileSync(join(dir, LOCK_OWNER_FILE), 'utf8'));
  } catch {
    owner = null;
  }
  if (owner === null || typeof owner !== 'object') {
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(dir).mtimeMs;
    } catch {
      ageMs = 0;
    }
    return ageMs >= LOCK_STALE_GRACE_MS
      ? { stale: true, why: 'its owner record is unreadable and the lock is older than the stale grace period' }
      : { stale: false, why: 'it was just created and its owner record is not written yet' };
  }
  if (owner.host !== hostname()) {
    return { stale: false, why: `it is owned by a run on another host (${redact(String(owner.host ?? 'unknown'))})` };
  }
  if (pidAlive(owner.pid)) {
    return { stale: false, why: `its owner (pid ${owner.pid}, plan ${redact(String(owner.plan_run_id ?? 'unknown'))}) is still running` };
  }
  return { stale: true, why: `its owner (pid ${owner.pid}) is gone, so the lock was left behind by a killed run` };
}

// Locks this process holds, released on exit. Only paths THIS run created are
// ever removed — a release that walked the root would delete other runs' locks.
const heldLocks = [];
let releaseRegistered = false;

function releaseUnattendedLocks() {
  for (const dir of heldLocks.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a lock that outlives its process is reclaimed by the stale
      // rule above, which is exactly the `kill -9` path.
    }
  }
}

// Take one lock, atomically. `mkdirSync` WITHOUT `recursive` fails with EEXIST
// when the directory is already there, and that failure is the mutex: there is
// no read-then-write window for a second run to slip into (the TOCTOU the ADR
// warns about). The `owner.json` write comes after, so it describes a lock that
// is already ours.
function acquireOneLock(dir, meta) {
  const create = () => {
    try {
      mkdirSync(dir);
      return { ok: true };
    } catch (error) {
      if (error.code === 'EEXIST') return { ok: false, exists: true };
      return { ok: false, exists: false, detail: redact(error.message ?? String(error)) };
    }
  };
  let attempt = create();
  if (!attempt.ok && attempt.exists) {
    const verdict = lockOwnerVerdict(dir);
    if (!verdict.stale) return { ok: false, why: verdict.why };
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      return { ok: false, why: `it could not be reclaimed (${redact(error.message ?? String(error))})` };
    }
    // Exactly one retry. A loop here would be the TOCTOU this design avoids:
    // losing the retry means another run took the reclaimed lock first, which is
    // a refusal, not something to race for.
    attempt = create();
    if (!attempt.ok) return { ok: false, why: 'another run took it while this one was reclaiming it' };
  }
  if (!attempt.ok) return { ok: false, why: `the lock directory could not be created (${attempt.detail ?? 'unknown error'})` };
  heldLocks.push(dir);
  if (!releaseRegistered) {
    process.on('exit', releaseUnattendedLocks);
    releaseRegistered = true;
  }
  writeFileSync(join(dir, LOCK_OWNER_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return { ok: true };
}

// All-or-nothing over the worktrees this attempt may drive. Partial exclusivity
// is not exclusivity: holding three of four locks and dispatching anyway puts a
// second supervisor in the fourth worktree, which is the whole harm.
//
// `issues` is what this attempt may dispatch — the whole plan on an ordinary
// run, and only the not-carried issues on a resume (a carried issue is never
// sent to, and its worktree may legitimately be gone).
function acquireUnattendedLocks(plan, issues) {
  const root = lockRoot();
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      keys: [],
      reasons: [{
        code: 'unattended_locked',
        detail: `the exclusivity lock root could not be created (${redact(error.message ?? String(error))}); `
          + `--unattended will not dispatch without it. Set ${LOCK_ROOT_ENV} to a writable directory that is the SAME for every run on this machine`,
      }],
    };
  }
  const keys = [];
  const meta = { host: hostname(), pid: process.pid, plan_run_id: String(plan.run_id ?? 'unknown'), stage: UNATTENDED_STAGE };
  for (const issue of issues) {
    const key = worktreeLockKey(plan, issue);
    const result = acquireOneLock(join(root, key), meta);
    if (result.ok) {
      keys.push(key);
      continue;
    }
    releaseUnattendedLocks();
    return {
      ok: false,
      keys: [],
      reasons: [{
        code: 'unattended_locked',
        detail: `#${issue.number}: the worktree lock "${key}" is held — ${result.why}. Another dispatch run is driving this worktree, `
          + 'so this one stopped before the pre-flight: nothing was probed, no worktree was prepared and no worker was sent to. '
          + `Locks live in $${LOCK_ROOT_ENV} (default $TMPDIR/${LOCK_DIR_NAME}/<worktree-key>) and are released when the owning run exits`,
      }],
    };
  }
  return { ok: true, keys, reasons: [] };
}

// The run-wide declaration (ADR section 7.2). One entry, in EVERY unattended
// report including the ones that stopped, so what the run declared — and what
// that declaration implied — is readable from the report alone.
//
// Deliberately free of absolute paths: `redact()` would replace them with
// `[REDACTED-PATH]` and, worse, would tally a redaction that a run without the
// flag does not have, so the "an unattended run differs only by these two
// limitations" property would stop being true.
function unattendedModeLimitation(inputs, lockKeys) {
  return {
    code: 'unattended_mode',
    detail: `--unattended（段階 ${UNATTENDED_STAGE}）: この invocation に人間は居ない、という入力の宣言である。`
      + '締め付けだけを含意し、権限は1つも足していない — **`--approve` は含意しない**、prompt には答えない、'
      + 'ゲートを無効化せず、blocking を limitation に格下げせず、status を1段も上げない。'
      + `含意した締め付け: --contract-mode require / pre-flight で全 Issue の scope 宣言を all-or-nothing 検査（--out を作る前）/ `
      + `--wall-clock-budget ${inputs.wallClockBudget}s / worktree 単位の排他 lock ${lockKeys.length} 件（${lockKeys.join(', ') || 'なし'}）/ `
      + 'verification_gates_unrecorded を limitation ではなく blocking として扱う'
      + '（gate を名指しできない pass は、無人 merge の根拠にしない。段階 C）。'
      + '拒否する緩和フラグ: --auto-yes / --allow-questions / --contract-mode off|auto（invalid_input, exit 3）。'
      + 'monitor を併用するなら monitor 側の `--no-auto-approve` は要件である（契約の autoYes: off は monitor を止めない）。',
  };
}

// The undo baseline (ADR section 7.2), one entry per worktree this run drives,
// recorded BEFORE the first message reaches its worker.
//
// Branch name and short SHA, never a path — measured in Issue #115 (ADR section
// 14.4): once the worktree has been cleaned up `git reset --hard` exits 128 and
// the only move left is `git branch -f <branch> <sha>`, which needs the branch
// name. The four conditions under which the baseline is NOT enough are in
// SKILL.md section 5; they are stated there rather than here because they are
// about the undo procedure, not about this run.
function unattendedBaselineLimitation(issue, sha) {
  const short = shortSha(sha ?? '');
  return {
    code: 'unattended_baseline',
    detail: redact(`#${issue.number}: branch ${issue.branch} @ ${short} — dispatch 開始時の worktree HEAD。`)
      + (short === 'unknown'
        ? 'HEAD を読めなかった（worktree が無い/壊れている）ので、この Issue の取り消し起点は記録できていない。'
        : '取り消しは worktree が在れば `git reset --hard <sha>`、片付いていれば `git branch -f <branch> <sha>`。'
          + 'untracked file は戻らず、merge / push 済みなら戻せない（SKILL.md 第5節）。'),
  };
}

// The plan-only gates, evaluated together BEFORE `--out` exists (ADR section 3).
//
// Two findings, one refusal:
//
//   - `open_questions` — the existing gate (Issue #52), which under
//     `--unattended` can no longer be waived (`--allow-questions` is refused);
//   - `contract_scope_unknown` — the scope declaration, per issue. Today this is
//     decided inside the wave loop, by which time the other workers of the wave
//     have already been sent to: the refusal is real but it lands on a world
//     that is already mutating, and no one is present to clean it up.
//
// Both are pure functions of the plan, so evaluating them here costs nothing and
// buys the property #90 established for missing worktrees: the run stops without
// consuming `--out`, so the same command can be re-run after the issue bodies
// are fixed and re-planned. Reporting them TOGETHER matters because an issue
// with no declared files usually also carries the planner's "affected files are
// unclear" question — reporting only one of the two would hide half the fix.
//
// The scope condition is the CONTRACT's, not the plan's: `contractScopeAllow`
// drops patterns the contract parser would reject, so an issue can name files
// and still produce an empty `scope.allow`. That is the condition the wave loop
// refuses on, so it is the condition checked here.
function unattendedPlanReasons(plan) {
  const reasons = [];
  const openQuestions = collectOpenQuestions(plan);
  if (openQuestions.length > 0) {
    reasons.push({
      code: 'open_questions',
      detail: `${openQuestions.length} issue(s) carry an unanswered planner question: ${formatOpenQuestions(openQuestions)} `
        + 'Nothing was dispatched and --out was not created: answer them in the issue body and re-plan. '
        + '--allow-questions is refused under --unattended, because taking on a question needs somebody to take it on',
    });
  }
  for (const issue of plan.issues ?? []) {
    if (contractScopeAllow(issue).length > 0) continue;
    reasons.push({
      code: 'contract_scope_unknown',
      detail: `#${issue.number}: the plan names no file this issue may write, so its execution contract would declare no scope. `
        + 'Under --unattended this is checked for EVERY issue of the plan before anything is dispatched, so no worker of any wave '
        + 'was started (with a human present the same issue is refused inside its wave, by which time the rest of the wave is already running). '
        + "State the issue's target files and re-run the planner",
    });
  }
  return reasons;
}

// The report an unattended refusal prints. Same shape as #90's pre-flight
// refusal: `out_dir: null` because nothing was written, `dispatch_error` because
// the stop is before any wave, and the declaration is still recorded — a report
// that stopped must still say what it was declared to be.
function unattendedRefusalReport(inputs, plan, reasons, { humanRequired, lockKeys = [], resume = null }) {
  const report = emptyReport(inputs, plan, null);
  report.status = 'failure';
  report.stop_reason = 'dispatch_error';
  report.human_required = humanRequired;
  report.limitations.push(unattendedModeLimitation(inputs, lockKeys));
  if (resume !== null) report.limitations.push(resumeLimitation(plan, resume));
  if (inputs.workerMethod !== null) report.limitations.push(workerMethodDeclaredLimitation(inputs.workerMethod));
  report.blocking_reasons = reasons;
  report.completion_check = buildCompletionCheck({
    planApproved: true,
    driftReconfirmed: false,
    parallelismBounded: true,
    barrierEnforced: true,
    noAutoPromptResponse: true,
    reportStatus: 'failure',
  });
  report.redactions = redactionsList();
  report.summary_markdown = renderSummary(report, false, collectOpenQuestions(plan), resume);
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

// The `## Method` section, or nothing at all (Issue #128 / ADR section 3.3).
//
// It goes into BOTH task-text generators — the contract goal and the fallback
// worker prompt — at the same place, immediately before `## Objective`:
//
//   - Not first. `yamlBlockScalar` relies on the goal opening with a non-blank
//     header line, and the header is also what identifies the task to a human.
//   - Not inside `## Rules`. Rules are last, and last is what the 8000-char
//     truncation eats first: a contract could then lose its method reference
//     without saying so. Measured: the insertion point sits at a FIXED offset of
//     365 chars for every issue whose title is of ordinary length, no matter how
//     many acceptance criteria or files it declares, so the truncation cannot
//     reach this section at all.
//   - Before `## Objective`, because a worker reads top to bottom. A method
//     stated after the objective arrives after the work has started.
//
// Only ONE generator carrying it would be worse than neither carrying it:
// `--contract-mode auto` silently falls back to `buildWorkerPrompt()` on a CLI
// with no `send --contract`, and the method would then disappear from exactly the
// runs nobody is watching (ADR section 1.2).
//
// The text names the Skill, its two paths and the precedence rule, and nothing
// else. Summarising the method here would put a second copy of it in this
// runner, which is the case ADR section 3.2 rejects: the copy and the Skill drift
// apart, and the worker reads the copy.
function workerMethodSection(skillId) {
  if (skillId === null) return [];
  return [
    '## Method',
    `Follow the \`${skillId}\` Skill installed in this worktree. Read it before you`,
    'start, and follow it for the whole task:',
    ...workerMethodPaths(skillId).map((relative) => `- ${relative}`),
    'The two copies are byte-identical; read whichever one your agent can see.',
    'The Skill supplies METHOD only. It does not widen the files you may change,',
    'does not relax any gate, and does not authorise a push or a pull request.',
    'Where the Skill and this task disagree, THIS TASK WINS.',
    'If the Skill is not there, STOP and report it — do not improvise a method.',
    '',
  ];
}

// The contract's `goal` — the body CommandMate sends after the preamble it
// composes itself.
//
// Deliberately NOT the same text as buildWorkerPrompt(): the preamble already
// states the allowed paths, the commit requirement and the completion criterion,
// and it writes that criterion out as the REAL gate commands resolved from
// verify.yaml. Repeating the profile baseline here would tell the worker to
// satisfy one thing while a different thing judges it.
// `requiredGates` adds ONE section, and only when the issue declared gates. An
// issue with no `acceptance-gates` block produces the same bytes as before this
// feature existed — the non-regression the ADR §4 (6) fixture pins.
//
// The section is what finally makes the "## Rules" sentence below true for the
// mechanized part of the acceptance criteria: until now the goal told the worker
// that "the same gates decide the verdict" while the verdict was actually the
// repository's common gate set, which the issue had no way to speak to (ADR §1.1).
function buildContractGoal(plan, issue, requiredGates = [], workerMethod = null) {
  const goal = [
    `# Issue #${issue.number} — ${issue.title ?? 'no title'}`,
    '',
    `Repository: ${plan.profile.repository}`,
    `Base branch: ${plan.profile.base}`,
    `Work branch: ${issue.branch ?? '(from profile template)'}`,
    `Worktree: ${issue.worktree ?? '(from profile template)'}`,
    '',
    ...workerMethodSection(workerMethod),
    '## Objective',
    issue.objective ?? issue.title ?? `Resolve issue #${issue.number}.`,
    '',
    '## Acceptance criteria',
    bullets(issue.acceptance_criteria, 'Derive from the issue; if unclear, stop and ask.'),
    '',
    '## Files you may change',
    bullets(issue.suspected_files, 'Unknown — inspect first; do not touch files owned by another issue.'),
    '',
    ...(requiredGates.length === 0 ? [] : [
      '## Acceptance gates this issue declared',
      ...requiredGates.map((id) => `- ${id}`),
      'These are gate ids from this repository\'s .commandmate/verify.yaml, named by the',
      'issue itself. They take part in the verdict; run them and make them pass.',
      '',
    ]),
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

// The prompt types the contract authorises under `--auto-yes`, and why the runner
// stopped writing `mode: safe` (Issue #136, the correction on the issue).
//
// MEASURED, in the installed CommandMate 0.22.1:
//   - `dist/server/src/lib/polling/auto-yes-resolver.js`, `evaluatePolicyAgainstTexts`:
//       mode 'off'          -> {reason: 'mode-off'} for everything;
//       mode 'safe'         -> `promptType === 'yes_no' ? null : {reason: 'type-not-allowed'}`
//                              — the allow list is NOT consulted, `yes_no` is hardcoded;
//       mode 'allow-listed' -> `policy.allowPromptTypes.includes(promptType)`;
//       mode null (no block)-> falls through to `return null`, i.e. no constraint.
//   - `dist/server/src/lib/detection/prompt-detect-multiple-choice.js`: Claude's
//     permission menu (`❯ 1.` / `2.` / `3.`) is detected as `multiple_choice`.
//   - `dist/server/src/lib/tasks/contract-parser.js`: AUTO_YES_MODES is
//     ['off','safe','allow-listed'] and PROMPT_TYPES is ['yes_no','multiple_choice',
//     'approval','choice','input','continue'].
//   - the same resolver's `resolveBaseAnswer`: an answer is only ever produced for
//     `yes_no` ('y') and `multiple_choice` (the default option, else the first).
//     The other four types resolve to null before any policy is consulted.
//
// So `mode: safe` suppressed the ONE type that a Claude worker raises most —
// which is the bug: `--auto-yes` promised "prompts do not stop this run" and then
// wrote the policy that stops it on every edit approval.
//
// DECISION: under `--auto-yes` the contract states `mode: allow-listed` with
// exactly the two types the resolver can answer at all. The two alternatives were
// weighed against this:
//   - writing NO autoYes block (mode null, "no constraint") would work today, and
//     is rejected because it makes the run's authorisation unreadable: this runner
//     writes `mode: off` precisely because an active prohibition and an omission
//     are different things, and the same argument applies to permission. A null
//     policy also silently inherits whatever a future CommandMate teaches the base
//     rules to answer, without this Skill ever deciding to grant it.
//   - listing all six PROMPT_TYPES would grant four types that `resolveBaseAnswer`
//     never answers — a contract claiming an authorisation nobody can use, which
//     is exactly the kind of line a reader would later take as evidence.
// Under no `--auto-yes` the block stays `mode: off`: the safe default is an active
// prohibition, unchanged (ADR §4).
//
// `denyPatterns` is deliberately NEVER written. CommandMate #1699 measured what a
// deny list costs when it is matched against pane text: a command approved several
// turns earlier stayed inside the scrollback window and went on suppressing every
// later prompt — the run looked hung, and nothing said why. The scope gate and the
// verification gates are where this Skill constrains a worker; the parser's
// default (an empty list) is what the contract carries.
const AUTO_YES_ALLOWED_PROMPT_TYPES = ['yes_no', 'multiple_choice'];

// The contract document for one issue. Field order is fixed, so is every list.
//
// `requiredGates` is the issue's resolved `require:` list (empty when the issue
// declared none). It is passed in rather than re-read here because the CALLER is
// what verified those ids exist in the worktree — a contract must never name a
// gate this run has not seen in `.commandmate/verify.yaml`.
function buildTaskContract(plan, issue, inputs, requiredGates = [], workerMethod = null) {
  const allow = contractScopeAllow(issue);
  const verifyGates = contractVerifyGates(inputs.verifyGates, requiredGates);
  const lines = [];
  lines.push('# Generated by cmate-orchestrate (dispatch runner) from an approved plan.');
  lines.push('# Do not edit by hand: the same plan regenerates this file byte for byte.');
  lines.push('version: 1');
  lines.push(`title: ${yamlString(contractTitle(issue))}`);
  lines.push(yamlBlockScalar('goal', buildContractGoal(plan, issue, requiredGates, workerMethod)));
  lines.push('scope:');
  if (allow.length === 0) {
    lines.push('  allow: []');
  } else {
    lines.push('  allow:');
    for (const pattern of allow) lines.push(`    - ${yamlString(pattern)}`);
  }
  lines.push('  deny: []');
  // `verify` is omitted unless the operator named gates: an id that does not
  // exist in the repository's verify.yaml makes `send --contract` exit 2.
  // Omitting the key means "run every declared gate", which is the stricter
  // reading, never the looser one — and it is why an issue's `require:` list
  // alone does NOT write this key (contractVerifyGates, ADR §3.4).
  if (verifyGates.length > 0) {
    lines.push('verify:');
    lines.push('  gates:');
    for (const gate of verifyGates) lines.push(`    - ${yamlString(gate)}`);
  }
  // The contract states the same Auto-Yes stance the runner itself takes, so the
  // server-side policy and the supervision loop cannot disagree. `off` is an
  // active prohibition (distinct from omitting the block, which says nothing).
  //
  // These lines are a POLICY DECLARATION and nothing else (Issue #136): the
  // server's Auto-Yes poller reads them only after it has already started, and it
  // starts only when the WORKTREE's auto-yes state is enabled. Enabling that state
  // is the separate job of `send --auto-yes` (autoYesSendFlags). BOTH are needed —
  // the policy decides which prompts may be answered, the state decides whether
  // anything is looking — and neither one alone answers a single prompt.
  //
  // Which types are authorised, and why not `safe`, is decided at
  // AUTO_YES_ALLOWED_PROMPT_TYPES above.
  lines.push('autoYes:');
  lines.push(`  mode: ${yamlString(inputs.autoYes ? 'allow-listed' : 'off')}`);
  if (inputs.autoYes) {
    lines.push('  allowPromptTypes:');
    for (const type of AUTO_YES_ALLOWED_PROMPT_TYPES) lines.push(`    - ${yamlString(type)}`);
  }
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

// =============================================================================
// Acceptance gates (Issue #114 / references/adr-issue-acceptance-gates.md)
// =============================================================================
//
// The plan carries `issues[].acceptance_gates.require` — gate ids the ISSUE said
// must take part in its verdict. The planner checked their SYNTAX only; it never
// opens the target repository. This runner does: it holds the `ls`-resolved
// worktree path, so it can read that worktree's own `.commandmate/verify.yaml`
// and answer whether the ids exist (ADR §3.4).
//
// Nothing here writes to the worktree. `require:` selects gates that are ALREADY
// declared, which is what makes stage 1 shippable on its own — the `gates:`
// (new command) half of the notation is stage 2 and is refused by the planner.

// The file both judges read: `commandmate verify` and cmate-verify's
// verify-run.sh. That is the whole reason the ADR put issue-specific gates here
// instead of in the contract (ADR §3.2).
const VERIFY_CONFIG_RELATIVE = '.commandmate/verify.yaml';

// The ids a contract's `verify.gates` may name WITHOUT them appearing in
// verify.yaml. Transcribed from CommandMate's own contract-vs-config check,
// which builds its known set as {work-evidence, scope} ∪ declared gate ids.
// `env-clean` is a built-in gate but is deliberately NOT in that set, so a
// `require: [env-clean]` is refused here exactly as `send --contract` would.
const CONTRACT_BUILT_IN_GATE_IDS = ['work-evidence', 'scope'];

// Gate ids declared in a worktree's `.commandmate/verify.yaml`.
//
// The YAML subset is the one cmate-verify's verify-run.sh awk parser accepts —
// 2-space indent, single-line scalars, comments on their own line, no tabs, no
// anchors, no flow collections, no block scalars — mirrored here so both readers
// agree on what the file says. It is read-only and extracts ids only.
//
// FAIL-CLOSED: anything the subset cannot read returns an error rather than a
// partial id set. An unreadable config would otherwise make a required gate look
// absent (dispatch refused for the wrong reason) or, worse, make the id set look
// complete when it is not. The file is read ONLY for issues that require a gate,
// so a repository whose verify.yaml this cannot parse keeps its previous
// behaviour everywhere else.
function readWorktreeGateIds(worktreePath) {
  const path = join(worktreePath, VERIFY_CONFIG_RELATIVE);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: error.code === 'ENOENT'
        ? `${VERIFY_CONFIG_RELATIVE} does not exist in the worktree, so no gate id can be resolved`
        : `${VERIFY_CONFIG_RELATIVE} could not be read (${error.code ?? 'error'})`,
    };
  }
  const bad = (reason) => ({ ok: false, reason: `${VERIFY_CONFIG_RELATIVE}: ${reason}` });
  const ids = [];
  let section = '';
  let sawVersion = false;
  let gateOpen = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (line.includes('\t')) return bad('tab characters are not allowed');
    if (/^[ ]*$/.test(line)) continue;
    if (/^[ ]*#/.test(line)) continue;
    const indent = line.length - line.replace(/^ +/, '').length;
    if (indent % 2 !== 0) return bad('indentation must be a multiple of 2 spaces');
    const body = line.slice(indent);

    if (indent === 0) {
      gateOpen = false;
      const colon = body.indexOf(':');
      if (colon <= 0) return bad(`expected "key: value" at the top level, got "${body.slice(0, 40)}"`);
      const key = body.slice(0, colon).trim();
      const value = body.slice(colon + 1).trim();
      if (key === 'version') {
        sawVersion = true;
        if (unquoteYaml(value) !== '1') return bad(`version must be 1 (got "${value}")`);
        section = '';
      } else if (key === 'gates') {
        if (value !== '') return bad('gates: must be followed by an indented list');
        section = 'gates';
      } else if (key === 'options') {
        if (value !== '') return bad('options: must be followed by indented keys');
        section = 'options';
      } else {
        return bad(`unknown top-level key "${key}"`);
      }
      continue;
    }
    // An indented line with nothing open above it is a shape this reader does not
    // understand, and the sibling awk parser rejects it too. Skipping it would be
    // the one way a gate id could go unseen, which is the failure mode fail-closed
    // exists to prevent.
    if (section === '') return bad('indented line outside of gates: / options:');
    if (section !== 'gates') continue; // options and their nested keys carry no id
    if (indent === 2) {
      if (!body.startsWith('- ')) return bad('gate list items must start with "- "');
      gateOpen = true;
      const first = body.slice(2).trim();
      const colon = first.indexOf(':');
      if (colon <= 0) return bad('expected "key: value" inside a gate');
      if (first.slice(0, colon).trim() === 'id') ids.push(unquoteYaml(first.slice(colon + 1).trim()));
      continue;
    }
    if (indent === 4) {
      if (!gateOpen) return bad('gate field outside of a list item');
      const colon = body.indexOf(':');
      if (colon <= 0) return bad('expected "key: value" inside a gate');
      if (body.slice(0, colon).trim() === 'id') ids.push(unquoteYaml(body.slice(colon + 1).trim()));
      continue;
    }
    return bad(`unexpected indentation (${indent} spaces)`);
  }
  if (!sawVersion) return bad('missing top-level "version: 1"');
  if (ids.length === 0) return bad('no gate is declared');
  for (const id of ids) {
    if (!GATE_ID_RE.test(id)) return bad(`declared gate id "${id}" does not match ${GATE_ID_RE.source}`);
  }
  return { ok: true, ids };
}

// The single- or double-quoted scalar forms the subset allows. A value with no
// quotes is returned unchanged.
function unquoteYaml(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

// The `require:` list of one plan issue, re-validated on the way in. The plan is
// an INPUT — a hand-edited one must not be able to put a malformed id into a
// contract, where the failure would be reported as "the runner wrote a bad
// contract" instead of "the plan declares something unusable".
function issueRequiredGates(issue) {
  const declared = issue.acceptance_gates;
  if (declared === null || declared === undefined) return { ids: [], error: null };
  const bad = (reason) => ({ ids: [], error: reason });
  if (typeof declared !== 'object' || Array.isArray(declared)) return bad('acceptance_gates must be an object or null');
  if (declared.version !== 1) return bad(`acceptance_gates.version must be 1 (got ${JSON.stringify(declared.version)})`);
  if (!Array.isArray(declared.require) || declared.require.length === 0) return bad('acceptance_gates.require must be a non-empty list');
  if (declared.require.length > MAX_GATE_IDS) return bad(`acceptance_gates.require names more than ${MAX_GATE_IDS} gate ids`);
  const ids = [];
  for (const id of declared.require) {
    if (typeof id !== 'string' || !GATE_ID_RE.test(id)) return bad(`acceptance_gates.require contains "${redact(String(id))}", which is not a valid gate id`);
    if (ids.includes(id)) return bad(`acceptance_gates.require repeats "${id}"`);
    ids.push(id);
  }
  return { ids, error: null };
}

// The contract's `verify.gates` list — ADR §3.4, whose whole point is that
// adding a requirement must never NARROW what runs.
//
//   operator   issue      contract
//   --------   -------    ----------------------------------------------------
//   none       none       key omitted  (= every declared gate runs)
//   none       require    key omitted  (= every declared gate runs, and the
//                                        required ones are necessarily among
//                                        them — their existence was verified)
//   --gates    none       the operator's list, in the operator's order
//   --gates    require    the union, sorted and de-duplicated
//
// Writing `verify.gates: [<require>]` for row 2 is the mistake this table
// exists to prevent: it would turn "these gates must also judge me" into "only
// these gates judge me", and lint and test would stop running on the very issue
// that asked for a stricter verdict.
function contractVerifyGates(operatorGates, requiredGates) {
  if (operatorGates.length === 0) return [];
  if (requiredGates.length === 0) return operatorGates.slice();
  return [...new Set([...operatorGates, ...requiredGates])].sort();
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
function buildWorkerPrompt(plan, issue, workerMethod = null) {
  return [
    `# Worker task — issue #${issue.number}`,
    '',
    `Repository: ${plan.profile.repository}`,
    `Base branch: ${plan.profile.base}`,
    `Work branch: ${issue.branch ?? '(from profile template)'}`,
    `Worktree: ${issue.worktree ?? '(from profile template)'}`,
    '',
    ...workerMethodSection(workerMethod),
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

// The auto-yes window `commandmate send --auto-yes` opens, and why this runner
// names one instead of taking the CLI's default (Issue #136).
//
// MEASURED, in the installed CommandMate 0.22.1 — the same bundle ADR §14.6 read
// the poller out of:
//   - `dist/cli/config/duration-constants.js`: `DURATION_MAP = {'1h': 3600000,
//     '3h': 10800000, '8h': 28800000}` and `parseDurationToMs` returns null for
//     anything else; `dist/cli/commands/send.js` then prints "Error: Invalid
//     duration. Must be one of: 1h, 3h, 8h" and exits BEFORE any side effect. The
//     window is therefore not a free number — it is one of exactly three, and a
//     computed "seconds" value would abort the dispatch rather than widen it.
//   - `dist/cli/commands/send.js`: `DEFAULT_AUTO_YES_DURATION = '1h'` when
//     `--duration` is omitted. Omitting it is a choice of 1h, not a choice of
//     "no expiry".
//
// WHAT HAS TO BE COVERED is one worker's supervision in ONE worktree. The state
// `send --auto-yes` enables is per worktree and every issue in a plan has its own,
// so neither the wave count nor the wave width multiplies the need (ADR §14.2
// measured that wave width does not move the wall clock either: a wave is
// supervised concurrently, so 3 issues cost the same 8×`--wait-timeout` as 1).
// The per-worker ceiling that section measured is `--max-turns × --wait-timeout`:
//   - defaults, 8 × 300 s = 40 min      → 1h covers it with 20 min to spare;
//   - the run in #136, 10 × 2700 s = 7 h 30 min → the default 1h is gone during the
//     second wait, which is this same bug wearing different clothes.
//
// DECISION: arm the SMALLEST of the three windows that covers `--max-turns ×
// --wait-timeout`, and never a flat 8h. Two reasons, and the second is what rules
// out "just always take the widest":
//   1. the window OUTLIVES this process. Auto-yes is server-side worktree state;
//      revoking it is not on the CLI surface these runners are allowed to use
//      (commandmate-cli-contract.json has no `auto-yes` subcommand), and a run
//      that is killed mid-wave would not get to revoke anything anyway. Hours of
//      auto-yes nobody asked for means answered prompts for whoever opens that
//      worktree next.
//   2. expiry is NOT fatal. The prompt path this runner drives itself — `wait
//      --on-prompt agent` → exit 10 → `commandmate respond` under `--auto-yes` —
//      does not consult the worktree state at all, so a window that closes early
//      degrades to exactly the pre-#136 behaviour instead of stalling the run.
// So over-granting costs something real and under-granting costs the tail of a
// very long run; the window is sized to the ceiling, not to the backstop
// (`hardIterations`, which exists so a prompt/respond ping-pong cannot spin
// forever — sizing to it would buy 8h for a default run that needs 40 min).
//
// `--max-turns × --wait-timeout` is a FLOOR: ADR §14.2 measured the real elapsed
// ABOVE the formula by the per-turn CLI overhead, and could not put a number on
// that overhead for a real server. The comparison is therefore STRICT — a need
// that reaches a window's exact length takes the next one up — which leaves the
// remainder of the window as headroom for the overhead instead of inventing a
// figure for it.
const AUTO_YES_WINDOWS = [
  { duration: '1h', seconds: 3600 },
  { duration: '3h', seconds: 10800 },
  { duration: '8h', seconds: 28800 },
];

// The supervision one armed worktree has to outlive, in seconds.
function autoYesCeilingSeconds(inputs) {
  return inputs.maxTurns * inputs.waitTimeout;
}

function autoYesWindow(inputs) {
  const need = autoYesCeilingSeconds(inputs);
  return AUTO_YES_WINDOWS.find((window) => need < window.seconds) ?? AUTO_YES_WINDOWS[AUTO_YES_WINDOWS.length - 1];
}

// The flags that ENABLE auto-yes on the worktree, for the one send that opens a
// worker's supervision (Issue #136). Empty unless `--auto-yes` was explicitly
// passed, so the safe default — and every run that predates this — sends exactly
// what it sent before. The contract's `autoYes.mode` is written either way: it
// declares the policy, this enables the state the poller checks before it reads
// any policy at all.
function autoYesSendFlags(inputs) {
  if (!inputs.autoYes) return [];
  return ['--auto-yes', '--duration', autoYesWindow(inputs).duration];
}

// `commandmate send <worktree-id> <message>`, then confirm the worker actually
// started (Issue #1468). A send can leave the message unsubmitted (Enter not
// confirmed), which would leave the worker idle so the next `wait` returns
// "completed" with nothing done. We capture the worker's live state right after
// sending; if it is neither generating nor holding a prompt, we treat the send as
// unconfirmed and re-send once to force submission. The commit check below is the
// real ground truth, so this is a best-effort confirmation, not a guarantee.
//
// `armAutoYes` is set by the ONE send that opens a worker's supervision (Issue
// #136), never by a nudge or a re-instruction: the state is already enabled by
// then, and the flags carry a duration whose clock the first send started on
// purpose. The re-send below stays plain for the same reason — it exists to submit
// a message the first send may have left in the input box, not to re-arm anything.
async function sendAndConfirm(inputs, worktreeId, message, { armAutoYes = false } = {}) {
  const first = await runCmAsync(inputs, ['send', worktreeId, message, ...(armAutoYes ? autoYesSendFlags(inputs) : [])]);
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
//
// `--auto-yes` rides on THIS send (Issue #136), and that is the SECOND of the two
// things the flag has to do. The contract's `autoYes` block is a policy the server
// only ever consults from inside its Auto-Yes poller, and that poller does not
// start unless the worktree's auto-yes state is enabled (`if
// (!autoYesState?.enabled) return { started: false, reason: 'auto-yes not enabled'
// }` — `dist/server/src/lib/auto-yes-poller.js`, ADR §14.6). So however permissive
// the contract is, a worktree nobody enabled answers nothing; and however enabled
// the worktree is, a policy that forbids the prompt's type answers nothing either
// (see AUTO_YES_ALLOWED_PROMPT_TYPES). This send is where the state is enabled,
// because it is the send that opens the supervision.
async function sendContractAndConfirm(inputs, worktreeId, relativeContractPath) {
  const first = await runCmAsync(inputs, ['send', worktreeId, '--contract', relativeContractPath, ...autoYesSendFlags(inputs)]);
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

// Where a gate came from, for #97's PR evidence: `issue` when this issue's
// `acceptance-gates` block named the id, `repo` when it is part of the
// repository's common set and the issue said nothing about it.
//
// MEASURED (ADR §10 item 4): the CLI's own gate line carries no provenance. It is
// `GATE <id> PASS|FAIL (<detail>)`, where detail is `exit=`/duration or the
// work-evidence counts — CommandMate's verify-runner formatGateLine builds it and
// there is nothing else in it. So origin cannot be READ; it is DECIDED here, from
// the one fact this runner owns: which ids it resolved out of the issue's
// `require:` and wrote into the contract. That decision is deterministic, and it
// fixes the case the ADR asked to fix: a gate that is in verify.yaml but was not
// required is `repo`, because being in the common set is exactly what makes it
// common. Absence of the field means "not recorded" and is never read as `repo`.
function gateOrigin(id, requiredGateIds) {
  return requiredGateIds.has(id) ? 'issue' : 'repo';
}

function gatesFromWaitOutput(stdout, requiredGateIds = new Set()) {
  const gates = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const match = GATE_LINE_RE.exec(line.trim());
    if (match) {
      const id = redact(match[1]);
      gates.push({ id, verdict: match[2] === 'PASS' ? 'pass' : 'fail', origin: gateOrigin(id, requiredGateIds) });
    }
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
//
// EVERY line is kept (Issue #164). The bound below is a DISPLAY bound and
// nothing else. It used to be applied HERE, before the dedup/sort that builds
// the loop guard's comparison set, which made the guard compare "the first 20
// lines of the logTail" rather than "the violations": two turns whose only
// difference fell outside that window read as the SAME answer, so a worker that
// was really converging was cut off with `scope_unsatisfiable` (measured on the
// fixture d67: 22 violations each turn, differing only from line 21 on — the old
// code stopped the run on turn 2). The reverse misreading was possible too, a fix
// inside the window pulling an untouched line into it and reading as progress.
// Keeping them all is cheap: CommandMate bounds a logTail at 8192 bytes
// (`DEFAULT_MAX_LOG_TAIL_BYTES` in src/lib/verification/verify-config.ts), a few
// hundred lines at worst — and the runs that overflow 20 are the repo-wide
// formatter / `lint --fix` accidents the scope gate exists to catch.
function scopeViolationLines(logTail) {
  return String(logTail ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => redact(line));
}

// How many transcribed violation lines one MESSAGE may carry. Bounding the
// re-instruction and the report detail is still right — an unbounded quote of a
// repo-wide accident helps nobody — so the number is unchanged. What changed is
// that a cut is now COUNTED and NAMED wherever it happens, the rule merge.mjs
// already applies to PR bodies with `capped()` / `droppedNote()`: shortening a
// list is fine, shortening it silently is not.
const MAX_SCOPE_VIOLATION_LINES = 20;

// The bounded view of one failing verification's scope violations: what a message
// may print, how many lines it had to leave out, and the full count so the
// message can say what it is a view OF.
function scopeViolationDisplay(failing) {
  const lines = failing.filter((gate) => gate.isScope).flatMap((gate) => gate.violations);
  return {
    shown: lines.slice(0, MAX_SCOPE_VIOLATION_LINES),
    dropped: Math.max(0, lines.length - MAX_SCOPE_VIOLATION_LINES),
    total: lines.length,
  };
}

// The scope-gate violations of ONE failing verification, as a comparable set —
// the input to the loop guard below (ADR section 6 / Issue #148). The lines come
// from the same transcription the re-instruction prints, so nothing new is read
// from the CLI to decide whether the loop is converging — but this set is built
// from ALL of them, never from the bounded view a message shows (Issue #164):
// what the worker was told is a display decision, and a display decision must not
// decide whether a run continues.
//
// Deduplicated and sorted, because "the same answer" is about the SET of paths:
// two turns that named the same two files in a different order are the worker
// repeating itself, not making progress. `null` means this turn produced nothing
// comparable — no scope gate failed, or its logTail could not be read — and a
// null never compares equal to anything, including another null: "we could not
// see the paths twice" is not evidence that they are the same paths.
function scopeViolationSet(failing) {
  const scopeGates = failing.filter((gate) => gate.isScope);
  if (scopeGates.length === 0) return null;
  const violations = [...new Set(scopeGates.flatMap((gate) => gate.violations))].sort();
  return violations.length === 0 ? null : violations;
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
    const violations = scopeViolationDisplay(failing);
    lines.push('');
    lines.push('scope ゲートについて: 実行契約 scope.allow の外のファイルが変更されています。違反 path（scope ゲートの記録から転記）:');
    if (violations.total === 0) {
      lines.push('- （logTail から違反 path を読み取れませんでした。`commandmate verify <worktree-id>` で確認してください）');
    }
    for (const line of violations.shown) lines.push(`- ${line}`);
    // A worker that is told about 20 of 23 violations cannot fix the other 3, and
    // silence about the cut would read as "these are all of them" (Issue #164).
    if (violations.dropped > 0) {
      lines.push(`- （ほか ${violations.dropped} 行は、このメッセージの表示上限 ${MAX_SCOPE_VIOLATION_LINES} 行を超えたため省略しました。`
        + `scope ゲートの記録は全部で ${violations.total} 行あります —— 残りは \`commandmate verify <worktree-id>\` で確認してください）`);
    }
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
async function superviseWithContract(inputs, worktreeId, worktreePath, relativeContractPath, requiredGates = []) {
  // The ids the ISSUE named, as a set, so every gate this loop records can say
  // where it came from (#97 / ADR §8.2).
  const requiredGateIds = new Set(requiredGates);
  const baseSha = await worktreeHeadSha(inputs, worktreePath);
  let autoResponded = false;

  const sent0 = await sendContractAndConfirm(inputs, worktreeId, relativeContractPath);
  if (!sent0.sent) {
    // A send that failed after the deadline failed BECAUSE of the deadline: the
    // remaining budget is every child's timeout, so the runner killed it. Saying
    // "dispatch failed" would send the operator to a worker that never got the
    // message, for a clock this runner stopped (Issue #122).
    const cutShort = wallClockExhausted();
    return {
      state: cutShort ? 'timeout' : 'failed', taskId: null, verdict: null, notJudged: false,
      promptExcerpt: null, nudges: 0, autoResponded,
      note: cutShort
        ? 'the --wall-clock-budget was exhausted before this worker was dispatched'
        : `contract dispatch failed: ${sent0.note}`,
    };
  }
  const taskId = sent0.taskId;
  let turns = 1;
  // The same reading for every later send in this loop (nudge, commit request,
  // re-instruction): a send the budget cut short is a stopped clock, not a
  // failed worker.
  const budgetCutoff = () => (wallClockExhausted()
    ? {
      state: 'timeout', taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded,
      note: `the --wall-clock-budget was exhausted during turn ${turns}; this worker was left mid-supervision`,
    }
    : null);
  // Once a pass is in hand it is FINAL for this run: the passing run moved the
  // task to `succeeded`, and a later verification run that cannot bind to a live
  // contract is exactly the detached-contract `error` → exit 99 case (#1620).
  // Asking twice would manufacture the very "no verdict" state we escalate on.
  let verdict = null;
  let passed = false;
  // The previous turn's scope violations (ADR section 6 / Issue #148), kept so
  // this loop can tell a worker that is CONVERGING from one that is repeating
  // itself. Reset by every turn that is not a scope-gate failure, so only two
  // CONSECUTIVE identical answers count — the narrow reading, which blocks less.
  let previousScopeViolations = null;
  // The worst cut any turn's scope re-instruction had to make (Issue #164). The
  // loop guard compares every violating line, but a MESSAGE is bounded, so a
  // worker can be told about 20 of 23. That is a fact about what the worker was
  // given to act on, and it belongs in the record rather than only in the message
  // that was sent — a report listing 20 paths must not read as a run that had 20.
  let scopeViolationCut = null;
  const scopeCutClause = () => (scopeViolationCut === null
    ? ''
    : `; a scope re-instruction was bounded: ${scopeViolationCut.shown.length} of ${scopeViolationCut.total} violating line(s) were transcribed `
      + `and ${scopeViolationCut.dropped} were left out of the message (the loop guard compared all ${scopeViolationCut.total})`);

  const hardIterations = inputs.maxTurns * 4 + 8;
  for (let i = 0; i < hardIterations; i += 1) {
    // The wall-clock budget, checked between turns (Issue #122). The remaining
    // budget is already every child's timeout, so a wedged `wait` cannot outlive
    // it; this check is what turns "the child was killed" into an honest
    // `timeout` state instead of an infrastructure failure attributed to the
    // worker. Any verdict already in hand is kept — it was really reached.
    if (wallClockExhausted()) {
      return {
        state: 'timeout', taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded,
        note: `the --wall-clock-budget was exhausted after ${turns} turn(s); supervision stopped without waiting for this worker`,
      };
    }
    const waitArgs = passed
      ? ['wait', worktreeId, '--on-prompt', 'agent', '--timeout', String(inputs.waitTimeout)]
      : ['wait', worktreeId, '--on-prompt', 'agent', '--verify', '--timeout', String(inputs.waitTimeout)];
    const waited = await runCmAsync(inputs, waitArgs);
    // The same check AFTER the call, and it is not redundant: the remaining
    // budget is this child's timeout, so a `wait` that outlives the deadline
    // comes back killed. Classifying that as an infrastructure failure would
    // blame the worker for a clock this runner stopped — the operator would go
    // read a worker log to find out why the run they time-boxed ended.
    if (wallClockExhausted()) {
      return {
        state: 'timeout', taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded,
        note: `the --wall-clock-budget was exhausted during turn ${turns}; the pending \`commandmate wait\` was cut short and this worker was left mid-supervision`,
      };
    }
    const code = waited.ok ? VERIFY_EXIT_PASS : (waited.status ?? null);
    const done = (state, note) => ({ state, taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded, note: `${note}${scopeCutClause()}` });

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
          gates: gatesFromWaitOutput(waited.stdout, requiredGateIds),
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
      previousScopeViolations = null; // this turn was not a scope-gate failure
      const asked = await sendAndConfirm(inputs, worktreeId, COMMIT_REQUEST_MESSAGE);
      if (!asked.sent) return budgetCutoff() ?? done('failed', `commit request failed: ${asked.note}`);
      turns += 1;
      continue;
    }

    if (code === VERIFY_EXIT_NOT_STARTED) {
      // work-evidence found no commit and no change: the worker has not started,
      // or has nothing to show yet. Never a pass.
      verdict = {
        ran: true,
        outcome: 'fail',
        gates: gatesFromWaitOutput(waited.stdout, requiredGateIds),
        checks: [`commandmate wait --verify → exit ${VERIFY_EXIT_NOT_STARTED} (work-evidence found no commit and no uncommitted change)`],
      };
      if (turns >= inputs.maxTurns) {
        return done('failed', `no work evidence after ${turns} turn(s); gave up at the --max-turns ${inputs.maxTurns} cap`);
      }
      previousScopeViolations = null; // this turn was not a scope-gate failure
      const nudged = await sendAndConfirm(inputs, worktreeId, NUDGE_MESSAGE);
      if (!nudged.sent) return budgetCutoff() ?? done('failed', `nudge failed: ${nudged.note}`);
      turns += 1;
      continue;
    }

    if (code === VERIFY_EXIT_FAILED) {
      const waitGates = gatesFromWaitOutput(waited.stdout, requiredGateIds);
      const failing = await describeFailingGates(inputs, worktreeId);
      verdict = {
        ran: true,
        outcome: 'fail',
        // The wait's own GATE lines are primary; when a CLI prints none, the
        // confirming verify run's failing gates still name what was judged.
        gates: waitGates.length > 0 ? waitGates : failing.failing.map((gate) => ({ id: gate.id, verdict: 'fail', origin: gateOrigin(gate.id, requiredGateIds) })),
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
      // The loop guard (ADR section 6 / Issue #148). Ranked BELOW the --max-turns
      // cap on purpose: the cap is the operator's own bound and the note it
      // writes is the one existing runs are read by, so a run that reached it
      // ends the way it always has.
      //
      // "Is this change unavoidable?" cannot be decided here. "Is this loop
      // converging?" can: `scope.allow` is a snapshot taken when the contract
      // was sent, so a worker cannot widen it from inside the worktree — the
      // only move it has is to make the violating change go away. A turn that
      // names the SAME paths as the turn before is a worker that has answered,
      // and re-sending the same re-instruction spends turns to receive the same
      // answer again (measured: Kewton/BorderFreeKidsMap #35 burned a whole run
      // this way). One fewer violating path is progress and is re-instructed as
      // before — this stops the repeat, not the retry.
      //
      // The comparison runs on the WHOLE violation set; the bounded view below is
      // only what the next message may print (Issue #164). Which lines fit in a
      // message is a display decision, and it decided this stop until #164.
      const scopeViolations = scopeViolationSet(failing.failing);
      const shownViolations = scopeViolationDisplay(failing.failing);
      if (shownViolations.dropped > (scopeViolationCut?.dropped ?? 0)) scopeViolationCut = shownViolations;
      if (scopeViolations !== null && previousScopeViolations !== null
        && scopeViolations.join('\n') === previousScopeViolations.join('\n')) {
        // Recorded on the EXISTING adjudication-failure path: no new state, no
        // new stop_reason, and the verdict is untouched — verification really
        // did fail, and that is CommandMate's exit code to give (#142's rule).
        // What changes is only that the run stops here instead of at the cap.
        return {
          state: committed ? 'completed' : 'failed',
          taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded,
          scopeUnsatisfiable: { violations: scopeViolations, turns },
          note: `the scope gate named the same violating path(s) on two consecutive turns, so this re-instruction loop is not converging; `
            + `stopped after ${turns} turn(s) without sending turn ${turns + 1} (the --max-turns cap is ${inputs.maxTurns})${scopeCutClause()}`,
        };
      }
      previousScopeViolations = scopeViolations;
      const resent = await sendAndConfirm(inputs, worktreeId, buildVerifyReinstruction(failing.failing));
      if (!resent.sent) return budgetCutoff() ?? done('failed', `re-instruction failed: ${resent.note}`);
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

  // The fallback path arms the worktree exactly as the contract path does (Issue
  // #136): `--auto-yes` promises "prompts do not stop this run", and which
  // dispatch path a CLI version put the run on is not something the operator who
  // passed the flag chose.
  const sent0 = await sendAndConfirm(inputs, worktreeId, initialMessage, { armAutoYes: true });
  if (!sent0.sent) {
    // As on the contract path: a send the budget killed is a stopped clock.
    const cutShort = wallClockExhausted();
    return {
      state: cutShort ? 'timeout' : 'failed', promptExcerpt: null, nudges: 0, autoResponded,
      note: cutShort
        ? 'the --wall-clock-budget was exhausted before this worker was dispatched'
        : `dispatch failed: ${sent0.note}`,
    };
  }
  let turns = 1;
  const budgetCutoff = () => (wallClockExhausted()
    ? {
      state: 'timeout', promptExcerpt: null, nudges: turns - 1, autoResponded,
      note: `the --wall-clock-budget was exhausted during turn ${turns}; this worker was left mid-supervision`,
    }
    : null);

  // A hard bound on wait iterations, above the turn cap, so an unexpected
  // prompt/respond ping-pong under --auto-yes can never spin forever.
  const hardIterations = inputs.maxTurns * 4 + 8;
  for (let i = 0; i < hardIterations; i += 1) {
    // The wall-clock budget (Issue #122), on the fallback path too: the profile
    // baseline this path is judged by is the very command with no timeout of its
    // own, so a run without this check would sit inside it past its deadline.
    if (wallClockExhausted()) {
      return {
        state: 'timeout', promptExcerpt: null, nudges: turns - 1, autoResponded,
        note: `the --wall-clock-budget was exhausted after ${turns} turn(s); supervision stopped without waiting for this worker`,
      };
    }
    const waited = await runCmAsync(inputs, ['wait', worktreeId, '--timeout', String(inputs.waitTimeout)]);
    // As on the contract path: a `wait` killed by the budget's own timeout is a
    // stopped clock, not a failed worker.
    if (wallClockExhausted()) {
      return {
        state: 'timeout', promptExcerpt: null, nudges: turns - 1, autoResponded,
        note: `the --wall-clock-budget was exhausted during turn ${turns}; the pending \`commandmate wait\` was cut short and this worker was left mid-supervision`,
      };
    }
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
      const cutShort = budgetCutoff();
      if (cutShort) return cutShort;
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
// `unattributed` is the stage-C promotion channel (Issue #142 / ADR sections 6.5
// and 8). Under `--unattended` the same finding is written to `blocking_reasons`
// instead of `limitations` and its issue number is collected here, so the wave
// barrier below can stop the run on it. The VERDICT is untouched either way: it
// is an exit code and it stands (that is what Issue #83 decided), so
// `verification.outcome` stays `pass` and the `checks` line is added on both
// paths. What the promotion changes is whether the run keeps going.
function recordVerification(report, worker, verification, source, unattended = false, unattributed = null) {
  worker.verification = verification;
  worker.note = appendNote(worker.note, verificationNoteClause(verification, source));
  if (source === 'contract' && verification.outcome === 'pass' && verification.gates.length === 0) {
    const detail = `#${worker.issue} passed verification, but no \`GATE <id> PASS|FAIL\` line could be read from the \`commandmate wait --verify\` output, so the report cannot name which gates the pass was based on; the verdict is the exit code and stands, but treat the pass as unattributed`;
    if (unattended) {
      if (unattributed) unattributed.add(worker.issue);
      report.blocking_reasons.push({
        code: 'verification_gates_unrecorded',
        detail: `${detail}. Under --unattended this is blocking rather than a limitation (ADR section 6.5): nobody is here to open the run and see WHAT judged it, and an unattributed pass is the whole basis an unattended merge would act on`,
      });
    } else {
      report.limitations.push({ code: 'verification_gates_unrecorded', detail });
    }
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

// =============================================================================
// Reverify — measuring work evidence, and re-judging without sending (#121)
// =============================================================================

// The two facts CommandMate's `work-evidence` gate counts, measured inside the
// worktree with the git CLI this runner already drives:
//
//   commits      `git rev-list --count <base>..HEAD` — the work branch's own
//                commits. The same range the gate counts, and the same range
//                merge later turns into a PR.
//   uncommitted  `git status --porcelain` — a non-empty listing.
//
// Positive evidence wins: one readable half that says "there is something here"
// is enough, because the question is whether there is anything to judge. The
// negative answer is the one that must be complete — "there is nothing here"
// requires BOTH halves to be readable and empty, and anything less comes back as
// `unreadable` so the caller can say "we could not look" instead of "it is
// empty". Neither answer is ever guessed from the prior report's worker_state.
async function workEvidence(inputs, plan, worktreePath) {
  if (!worktreePath) {
    return { present: false, unreadable: true, commits: null, uncommitted: null };
  }
  const counted = await runCliAsync(inputs.git, ['rev-list', '--count', `${plan.profile.base}..HEAD`], { cwd: worktreePath });
  const raw = counted.ok ? counted.stdout.trim() : '';
  const commits = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
  const status = await runCliAsync(inputs.git, ['status', '--porcelain'], { cwd: worktreePath });
  const uncommitted = status.ok ? status.stdout.trim().length > 0 : null;
  return {
    present: (commits !== null && commits > 0) || uncommitted === true,
    unreadable: commits === null || uncommitted === null,
    commits,
    uncommitted,
  };
}

// How the measurement reads in a report line.
function workEvidenceDetail(evidence) {
  const commits = evidence.commits === null ? 'unreadable' : String(evidence.commits);
  const dirty = evidence.uncommitted === null ? 'unreadable' : (evidence.uncommitted ? 'yes' : 'no');
  return `commits on the work branch: ${commits}; uncommitted change in the worktree: ${dirty}`;
}

// The gate list of a `commandmate verify --json` run document. The ordinary path
// reads `GATE <id> PASS|FAIL` lines off `wait --verify`; a reverify has no wait,
// so the same facts are read out of the document's own `gates[]` (the shape
// describeFailingGates already reads). `skipped` is not a verdict and is left
// out rather than rounded, exactly as the ordinary path leaves it out.
function gatesFromVerifyDocument(run, requiredGateIds = new Set()) {
  const gates = [];
  for (const gate of (run !== null && typeof run === 'object' && Array.isArray(run.gates)) ? run.gates : []) {
    if (gate === null || typeof gate !== 'object') continue;
    const id = typeof gate.gateId === 'string' ? gate.gateId.trim() : '';
    if (id === '') continue;
    const status = String(gate.status ?? '');
    const verdict = FAILED_GATE_STATUSES.has(status) ? 'fail' : (status === 'passed' ? 'pass' : null);
    if (verdict === null) continue;
    gates.push({ id: redact(id), verdict, origin: gateOrigin(id, requiredGateIds) });
    if (gates.length >= MAX_REPORTED_GATES) break;
  }
  return gates;
}

// Re-judge ONE worktree as it stands. Nothing is sent, no contract is written
// and no worker turn is consumed; the only thing that happens is the same
// verification the ordinary path runs, against a tree whose work is finished.
//
// The verdict vocabulary is the ordinary one, unchanged (contract §2.1 / §2.6):
// 0 pass, 20 judged-and-failed, 21 the work-evidence gate finding nothing,
// 99 NO VERDICT AT ALL (escalated, never re-instructed), anything else
// infrastructure and therefore no verdict to record.
async function reverifyWorker(inputs, plan, contractMode, worktreeId, worktreePath, requiredGates) {
  if (!contractMode) {
    // The fallback judge, unchanged: the profile baseline re-run inside the
    // worktree. It is the same function, called with the same arguments, as the
    // one the ordinary fallback path calls — a reverify must not be judged by a
    // different instrument than the run it is re-judging.
    const verification = verifyWorker(inputs, worktreePath, plan.profile.baseline);
    return {
      source: 'baseline',
      notJudged: false,
      verdict: {
        ran: verification.ran,
        report_schema_version: null,
        outcome: verification.outcome,
        gates: [],
        checks: verification.checks,
      },
      note: verification.note,
    };
  }
  const result = await runCmAsync(inputs, ['verify', worktreeId, '--json']);
  // `verify` exits WITH the verdict, so on a failing run the exit is 20 and the
  // run document is still on stdout. Parse it regardless of exit status — the
  // same reading describeFailingGates takes, and for the same reason.
  let run = null;
  try {
    run = JSON.parse(result.stdout);
  } catch {
    run = null;
  }
  const code = result.ok ? VERIFY_EXIT_PASS : (result.status ?? null);
  const gates = gatesFromVerifyDocument(run, new Set(requiredGates));
  const done = (outcome, checks, extra = {}) => ({
    source: 'contract',
    notJudged: false,
    verdict: { ran: true, report_schema_version: null, outcome, gates, checks },
    note: '',
    ...extra,
  });
  if (code === VERIFY_EXIT_PASS) {
    return done('pass', [`commandmate verify --json → exit ${VERIFY_EXIT_PASS} (every declared gate passed; re-judged in place, nothing was sent)`]);
  }
  if (code === VERIFY_EXIT_FAILED) {
    return done('fail', [`commandmate verify --json → exit ${VERIFY_EXIT_FAILED} (a gate failed; re-judged in place, nothing was sent)`]);
  }
  if (code === VERIFY_EXIT_NOT_STARTED) {
    // The judge disagrees with the git measurement that selected this issue.
    // Recorded as the verdict it is (exit 21 has always been `fail`), and the
    // disagreement itself is reported by the caller rather than smoothed over.
    return done('fail',
      [`commandmate verify --json → exit ${VERIFY_EXIT_NOT_STARTED} (work-evidence found no commit and no uncommitted change)`],
      { workEvidenceDisagreed: true });
  }
  if (code === VERIFY_EXIT_NO_VERDICT) {
    return {
      source: 'contract',
      notJudged: true,
      verdict: {
        ran: true,
        report_schema_version: null,
        outcome: 'not_run',
        gates: [],
        checks: [`commandmate verify --json → exit ${VERIFY_EXIT_NO_VERDICT} (the verification run ended error/cancelled; no verdict was reached)`],
      },
      note: `escalated to a human rather than re-judged (exit ${VERIFY_EXIT_NO_VERDICT}: the run ended error/cancelled)`,
    };
  }
  // 1 / 2 / 124 / anything else: infrastructure, not a verdict. No verdict is
  // recorded at all — the prior record stands, and the caller says why.
  return {
    source: 'contract',
    notJudged: false,
    verdict: null,
    note: excerpt(result.stderr || result.stdout || `commandmate verify exited ${code ?? 'with an error'}`) ?? 'commandmate verify could not be run',
  };
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
async function runDispatch(inputs, plan, outDir, preflight = null, preparation = null, resume = null, lockKeys = []) {
  const promptsDir = join(outDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });

  const report = emptyReport(inputs, plan, outDir);
  // This attempt re-judges instead of re-dispatching (Issue #121). Read off the
  // same decision object as the resume split, because it IS that split — only
  // what happens to the not-carried half differs.
  const reverifying = resume !== null && resume.reverifying === true;
  // The mode of the whole invocation, stated first: everything below is read
  // against it (Issue #122 / ADR section 7.2). Nothing is pushed when the flag
  // was not passed, which is what keeps a run without it byte-identical to a run
  // from before the flag existed.
  if (inputs.unattended) report.limitations.push(unattendedModeLimitation(inputs, lockKeys));
  // Stated before anything else the run says: which attempt this is, what it
  // carried, and what it re-dispatched. Every other line of the report is read
  // against that.
  if (resume !== null) report.limitations.push(resumeLimitation(plan, resume));
  // The run-wide method declaration (Issue #128 / ADR section 9), stated before
  // any wave: everything below — the `## Method` section in each contract, the
  // per-issue `worker_method_applied` entries — is read against it. Nothing is
  // pushed when the flag was not passed, which is what keeps a run without it
  // byte-identical to a run from before the flag existed.
  if (inputs.workerMethod !== null) report.limitations.push(workerMethodDeclaredLimitation(inputs.workerMethod));
  // The one case the arming above cannot cover (Issue #136): 8h is the longest
  // window the CLI accepts, and a run whose per-worker ceiling reaches it will
  // outlive its own auto-yes. That is not a failure — the runner's own exit-10
  // response path keeps working after the window closes — but it IS the run
  // silently becoming a different run halfway through, so it is written down
  // rather than left for the operator to infer from a stalled worker.
  if (inputs.autoYes) {
    const ceiling = autoYesCeilingSeconds(inputs);
    const window = autoYesWindow(inputs);
    if (ceiling >= window.seconds) {
      report.limitations.push({
        code: 'auto_yes_window_short',
        detail: `--auto-yes armed the worktree auto-yes for ${window.duration}, the longest window commandmate send accepts, but `
          + `--max-turns ${inputs.maxTurns} × --wait-timeout ${inputs.waitTimeout}s = ${ceiling}s of supervision can outlive it. `
          + 'After it expires the server answers no prompt on its own; this runner still answers the prompts `wait --on-prompt agent` '
          + 'returns to it, so the run continues, but a prompt raised inside a turn will sit until the wait of that turn times out. '
          + 'Lower --max-turns or --wait-timeout to bring the ceiling under 8h',
      });
    }
  }
  // Nothing is left to dispatch: every issue the plan names was already
  // completed AND verified. Reported as its own fact rather than as a silent
  // success, because "the run did nothing" and "the run did everything" produce
  // the same exit code and must not read the same.
  const nothingToDispatch = resume !== null && resume.firstActiveWave < 0;
  if (nothingToDispatch) {
    report.limitations.push(reverifying
      ? {
        code: 'reverify_no_work',
        detail: `再判定対象なし: every issue in plan ${plan.run_id} was already completed and verified in a prior attempt, so this attempt judged nobody again, `
          + 'sent nothing and started no worker. The verification records below are all carried over; this report is the one to hand to merge/uat',
      }
      : {
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
  // Not on a reverify: it writes no contract, and an empty `contracts/` beside
  // its report would say it did (Issue #121).
  if (contractMode && !reverifying) mkdirSync(contractsDir, { recursive: true });
  // Issues whose verification reached NO verdict (exit 99). Kept beside the
  // report rather than inside it: dispatch_schema_version 1 is a closed field set
  // and merge/uat both refuse any other version, so the fact travels through the
  // blocking reason and the worker note instead of a new field.
  const notJudged = new Set();
  // Issues that completed with no verification verdict recorded at all (#83).
  // Feeds the `verification_recorded` completion check below.
  const verificationUnrecorded = new Set();
  // Issues whose contract pass could not name a single gate, under `--unattended`
  // only (Issue #142 / ADR sections 6.5, 8 — stage C). `recordVerification` has
  // already written the blocking reason; this set is what makes the wave loop
  // STOP on it rather than carry an unattributed pass into the next wave.
  const unattributedPasses = new Set();

  for (let waveIndex = 0; waveIndex < plan.waves.length && !stopped; waveIndex += 1) {
    // The budget, checked before a wave is STARTED as well as between turns
    // (Issue #122 / ADR section 14.2): a wave is the largest mutating unit this
    // runner has, and starting one it cannot finish inside the budget is how a
    // run ends with workers nobody ever came back for.
    if (wallClockExhausted()) {
      halt('partial', 'timeout', 'wall_clock_budget_exhausted',
        `--wall-clock-budget ${inputs.wallClockBudget}s was exhausted before wave ${waveIndex + 1} was dispatched; `
          + 'the remaining waves were not started. This is a stop, not a success: re-run with --resume once the cause of the slowness is understood');
      break;
    }
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

    // 2b. The worker-method probe for a wave the pre-flight did not cover
    //     (Issue #128 / ADR section 3.4). Wave 0 was probed before the run
    //     directory existed; a later wave is probed HERE, at the moment its
    //     worktrees resolve, for the same reason #93 re-checks worktrees per
    //     wave: a worktree can be created, moved or emptied while an earlier
    //     wave was running. All-or-nothing, like the drift block above — the
    //     wave stops rather than dispatching the subset that happens to be
    //     equipped.
    const methodMissing = preflighted ? [] : workerMethodUnavailable(inputs, resolutions);
    if (methodMissing.length > 0) {
      report.waves.push({
        index: waveIndex,
        dispatched: [],
        workers: carriedWorkers,
        barrier: { all_workers_completed: false, all_verifications_passed: false, advanced: false },
      });
      haltWith(waveIndex === 0 ? 'failure' : 'partial', 'dispatch_error',
        workerMethodUnavailableReasons(methodMissing, inputs.workerMethod));
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
    // The reverify counterpart of `supervisable` (Issue #121): the not-carried
    // issues of this wave whose worktree resolved. Whether each of them is
    // actually re-judged is decided in step 3b, by the work-evidence
    // measurement — not here, and never from the prior report's worker_state.
    const reverifiable = [];
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

      // The reverify branch (Issue #121). Everything below this point exists in
      // order to SEND: it resolves the issue's acceptance gates so a contract can
      // carry them, refuses the issue when that contract could not be written,
      // places the contract in the worktree, and writes the prompt artifact the
      // worker is about to read. A reverify writes no contract and sends no
      // message, so none of it applies — and running those dispatch-time
      // refusals here would report "#N was not dispatched" inside an attempt that
      // dispatches nobody by definition. What replaces them is the work-evidence
      // measurement and the same verification gate, both in step 3b.
      if (reverifying) {
        // The prior record is the STARTING POINT, not a blank one: an issue this
        // attempt turns out not to be able to re-judge must keep saying what the
        // attempt that dispatched it found.
        const prior = resume.priorRecords.get(number);
        if (prior !== undefined) {
          worker.worker_state = WORKER_STATE_VALUES.includes(prior.worker_state)
            ? prior.worker_state
            // A string the conformance check accepted but this runner cannot
            // read is not a state it may repeat. `failed` is the only value that
            // neither claims a deliverable (`completed`) nor claims that nothing
            // ever ran (`not_dispatched`).
            : 'failed';
          worker.task_id = typeof prior.task_id === 'string' && prior.task_id.length > 0 ? redact(prior.task_id) : null;
          worker.verification = transcribedVerification(prior.verification);
          worker.prompt = transcribedPrompt(prior.prompt);
          worker.note = redact(typeof prior.note === 'string' ? prior.note : '');
        }
        worktreePaths.set(number, res.worktreePath);
        // The issue's `require:` ids, for gate PROVENANCE only (#97). A
        // malformed block cannot refuse a dispatch that is not happening, so it
        // degrades to "no issue-declared gate" instead of stopping the issue.
        const declaredGates = issueRequiredGates(res.issue);
        reverifiable.push({
          worker,
          worktreeId: res.resolved.id,
          worktreePath: res.worktreePath,
          requiredGates: declaredGates.error === null ? declaredGates.ids : [],
        });
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

      // The issue's own acceptance gates, resolved against THIS worktree's
      // verify.yaml before anything is sent. `send --contract` would exit 2 on an
      // id that does not exist, but that reports "the contract was invalid" about
      // a worker that never ran; naming what is missing is what a human can act
      // on — the same reading `contract_scope_unknown` takes (ADR §3.4).
      const declared = issueRequiredGates(res.issue);
      const requiredGates = declared.ids;
      if (declared.error !== null) {
        worker.note = redact(`#${number} was not dispatched: ${declared.error}`);
        report.limitations.push({
          code: 'acceptance_gate_block_invalid',
          detail: `#${number}: the plan's acceptance_gates could not be read (${declared.error}). The planner writes this field only from a syntactically valid \`acceptance-gates\` block, so a plan that reaches dispatch with a malformed one was edited by hand; re-run the planner rather than dispatching against a requirement nobody can enforce`,
        });
        workers.push(worker);
        continue;
      }
      if (requiredGates.length > 0) {
        if (!contractMode) {
          // Without an execution contract there is no `verify.gates` and no
          // `wait --verify`: the judge is the profile baseline re-run in the
          // worktree, which cannot be told about a gate id. Dispatching anyway
          // would produce exactly the run this whole feature exists to prevent —
          // a green verdict that never measured the condition the issue wrote.
          worker.note = redact(`#${number} was not dispatched: it declares acceptance gates, and this run has no execution contract to carry them`);
          report.limitations.push({
            code: 'acceptance_gates_not_enforceable',
            detail: `#${number}: the issue requires gate(s) ${requiredGates.join(', ')}, but this dispatch runs without an execution contract (--contract-mode off, or the CLI has no \`send --contract\`), so nothing can carry the requirement into the verdict. The fallback judge is the profile baseline, which has no gate ids. Use a CommandMate with contract support, or remove the \`acceptance-gates\` block and state the condition for UAT`,
          });
          workers.push(worker);
          continue;
        }
        const config = readWorktreeGateIds(res.worktreePath);
        if (!config.ok) {
          worker.note = redact(`#${number} was not dispatched: ${config.reason}`);
          report.limitations.push({
            code: 'acceptance_gate_id_unknown',
            detail: `#${number}: the issue requires gate(s) ${requiredGates.join(', ')}, but ${config.reason}. The ids are resolved against the worktree's own ${VERIFY_CONFIG_RELATIVE} because that is the one file BOTH judges read (\`commandmate verify\` and cmate-verify); declare the gates there, or drop the requirement from the issue`,
          });
          workers.push(worker);
          continue;
        }
        const known = new Set([...CONTRACT_BUILT_IN_GATE_IDS, ...config.ids]);
        const missing = requiredGates.filter((id) => !known.has(id));
        if (missing.length > 0) {
          worker.note = redact(`#${number} was not dispatched: required gate id(s) ${missing.join(', ')} are not declared in the worktree`);
          report.limitations.push({
            code: 'acceptance_gate_id_unknown',
            detail: `#${number}: the issue requires gate id(s) ${missing.join(', ')}, which ${VERIFY_CONFIG_RELATIVE} does not declare. Available there: ${[...known].sort().join(', ')}. The issue is NOT dispatched — a contract naming an unknown id exits 2 at \`send\`, which reports a bad contract instead of a missing gate`,
          });
          workers.push(worker);
          continue;
        }
        if (contractVerifyGates(inputs.verifyGates, requiredGates).length > MAX_GATE_IDS) {
          worker.note = redact(`#${number} was not dispatched: the operator's --verify-gates and the issue's require: exceed the contract's ${MAX_GATE_IDS}-id bound`);
          report.limitations.push({
            code: 'acceptance_gate_block_invalid',
            detail: `#${number}: the union of --verify-gates and the issue's \`require:\` names more than ${MAX_GATE_IDS} gate ids, which CommandMate's contract parser rejects. Narrowing the union is not an option — it would drop a requirement one side declared — so the issue is not dispatched. Reduce one of the two lists`,
          });
          workers.push(worker);
          continue;
        }
      }

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
          contractPath = placeContract(res.worktreePath, number, buildTaskContract(plan, res.issue, inputs, requiredGates, inputs.workerMethod), contractsDir);
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
      const prompt = contractMode
        ? buildContractGoal(plan, res.issue, requiredGates, inputs.workerMethod)
        : buildWorkerPrompt(plan, res.issue, inputs.workerMethod);
      writeFileSync(promptFile, `${prompt}\n`, 'utf8');

      // The per-issue half of the evidence (ADR section 9): the Skill was found
      // in THIS worktree and the reference really went into the text this worker
      // is about to be sent. Recorded here rather than up front because up front
      // it would only repeat the declaration — this entry exists to say the
      // writing happened, for the issues where it happened.
      if (inputs.workerMethod !== null) {
        const probe = probeWorkerMethod(res.worktreePath, inputs.workerMethod);
        report.limitations.push({
          code: 'worker_method_applied',
          detail: redact(`#${number}: ${inputs.workerMethod} was found in this worktree (${probe.found.join(', ')}), and a \`## Method\` section naming it was written into ${contractMode ? "the execution contract's goal" : 'the worker prompt'}. `
            + '適用されたことは、守られたことではない — dispatch can see that the reference was written, not that the worker followed it; that evidence is the worker\'s own deliverable'),
        });
      }

      // The undo baseline (Issue #122 / ADR section 7.2), read HERE: after the
      // runner has decided to dispatch this issue and before the first message
      // reaches its worker, so the SHA really is the state the worker started
      // from. Only under `--unattended` — a run with a human present has a
      // person who can read `git reflog`, and this costs one `git rev-parse` per
      // issue that a run without the flag must not pay.
      if (inputs.unattended) {
        report.limitations.push(unattendedBaselineLimitation(res.issue, await worktreeHeadSha(inputs, res.worktreePath)));
      }

      workers.push(worker);
      supervisable.push({ worker, worktreeId: res.resolved.id, worktreePath: res.worktreePath, prompt, contractPath, requiredGates });
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
    // The workers whose scope re-instruction loop was cut short (Issue #148),
    // collected here and written to `blocking_reasons` once supervision has
    // joined, in `workers` order: this map is filled CONCURRENTLY, so pushing
    // from inside it would order the report by whichever worker happened to
    // finish first and two runs of the same plan could differ.
    const scopeUnsatisfiable = new Map();
    await Promise.all(supervisable.map(async ({ worker, worktreeId, worktreePath, prompt, contractPath, requiredGates }) => {
      const supervised = contractMode
        ? await superviseWithContract(inputs, worktreeId, worktreePath, contractPath, requiredGates)
        : await superviseUntilCommit(inputs, worktreeId, worktreePath, prompt);
      worker.worker_state = supervised.state;
      worker.note = redact(supervised.note);
      if (supervised.taskId) worker.task_id = supervised.taskId;
      if (supervised.verdict) contractVerdicts.set(worker.issue, supervised.verdict);
      if (supervised.notJudged) notJudged.add(worker.issue);
      if (supervised.autoResponded) autoResponded = true;
      if (supervised.scopeUnsatisfiable) scopeUnsatisfiable.set(worker.issue, supervised.scopeUnsatisfiable);
      if (supervised.state === 'prompt') {
        worker.prompt = { detected: true, excerpt: supervised.promptExcerpt };
      }
    }));

    // The L4 finding, named in the report (ADR sections 6 and 9 / Issue #148).
    // The VIOLATING PATHS are carried verbatim, because they are the whole
    // actionable content: they are what has to be added to the Issue's 対象ファイル
    // (or declared as a repo convention) before this plan can succeed, and an
    // operator who only reads the report has nowhere else to get them.
    //
    // Verbatim, but bounded: a repo-wide accident can name hundreds of paths, and
    // a detail that long stops being read. The list is cut to the same display
    // bound the re-instruction uses and the cut is stated with its count and with
    // how many the guard actually compared (Issue #164) — merge.mjs's
    // `capped()` / `droppedNote()` rule, so a shortened list never passes for a
    // complete one.
    for (const worker of workers) {
      const cut = scopeUnsatisfiable.get(worker.issue);
      if (!cut) continue;
      const shownPaths = cut.violations.slice(0, MAX_SCOPE_VIOLATION_LINES);
      const droppedPaths = cut.violations.length - shownPaths.length;
      report.blocking_reasons.push({
        code: 'scope_unsatisfiable',
        detail: redact(`#${worker.issue}: the scope gate named the SAME violating path(s) on two consecutive turns, so the re-instruction loop was not converging and supervision `
          + `stopped after ${cut.turns} turn(s) rather than spending the rest of --max-turns ${inputs.maxTurns} on the same answer. `
          + 'The contract\'s `scope.allow` is a snapshot of the Issue\'s 対象ファイル taken when the contract was sent, so a worker cannot widen it from inside the worktree — '
          + 'when the violating change is unavoidable, the fix is in the Issue, not in the worktree. '
          + `Violating path(s), transcribed from the scope gate: ${shownPaths.join(' | ')}`
          + (droppedPaths > 0
            ? ` (+${droppedPaths} more line(s) not listed here; this detail is cut to ${MAX_SCOPE_VIOLATION_LINES} line(s) — the loop guard compared all ${cut.violations.length}, and \`commandmate verify <worktree-id>\` prints the rest)`
            : '')
          + '. '
          + 'The verdict is untouched: verification really did fail, and that is CommandMate\'s exit code to give — what this stops is the run going further'),
      });
    }

    // 3b'. The reverify pass (Issue #121), in the place of the supervision loop
    //      and never beside it: `reverifiable` is empty on every other run, and
    //      `supervisable` is empty on a reverify. Two steps per issue, in this
    //      order and no other:
    //
    //        1. MEASURE whether the worktree holds work — the work-evidence
    //           criterion, with git, before anything is judged. An issue that
    //           holds none is not re-judged at all: asking the gate would turn
    //           "nobody worked here" into a verdict (exit 21 is `fail`) and
    //           downgrade a record on the strength of a run this flag exists to
    //           avoid making.
    //        2. JUDGE the ones that do, with the same instrument the ordinary
    //           path uses in the same mode.
    //
    //      Concurrent for the same reason the supervision loop is: a gate run is
    //      the slow part, the wave width is already <= max_parallel, and one
    //      issue's gates must not wait behind another's.
    const reverifyVerdicts = new Map();
    await Promise.all(reverifiable.map(async ({ worker, worktreeId, worktreePath, requiredGates }) => {
      // A pending prompt is a worker still mid-turn, waiting for a human. The
      // tree under it is being changed by somebody who has not finished, so a
      // verdict about it would describe a state that is not a deliverable — and
      // promoting the issue to `completed` would quietly take the human out of
      // the loop this runner exists to keep them in.
      if (worker.worker_state === 'prompt') {
        report.limitations.push({
          code: 'reverify_prompt_pending',
          detail: `#${worker.issue} was NOT re-judged: its prior attempt stopped on a worker prompt that is still pending. A prompt is a worker mid-turn `
            + 'waiting for a human, so the worktree is not a finished deliverable and judging it would describe a state nobody delivered. Answer the prompt '
            + '(or re-dispatch the issue with --resume), then re-judge',
        });
        worker.note = appendNote(worker.note, 'not re-judged by this --reverify attempt: a worker prompt is still pending');
        return;
      }
      const evidence = await workEvidence(inputs, plan, worktreePath);
      if (!evidence.present) {
        report.limitations.push(evidence.unreadable
          ? {
            code: 'reverify_evidence_unreadable',
            detail: `#${worker.issue} was NOT re-judged: this runner could not read whether its worktree holds work (${workEvidenceDetail(evidence)}). `
              + '"We could not look" is not "there is nothing there", so the prior record is transcribed unchanged rather than re-judged against a tree nobody measured',
          }
          : {
            code: 'reverify_no_work_evidence',
            detail: `#${worker.issue} was NOT re-judged: its worktree holds no work evidence (${workEvidenceDetail(evidence)}) — the same two facts CommandMate's `
              + 'work-evidence gate counts. --reverify re-judges work that is already there; an issue with nothing there needs a worker, not a verdict, so its prior '
              + 'record is transcribed unchanged. Use --resume to dispatch it',
          });
        worker.note = appendNote(worker.note, evidence.unreadable
          ? 'not re-judged by this --reverify attempt: the work evidence in its worktree could not be read'
          : 'not re-judged by this --reverify attempt: its worktree holds no work evidence (no commit, no uncommitted change)');
        return;
      }
      const judged = await reverifyWorker(inputs, plan, contractMode, worktreeId, worktreePath, requiredGates);
      if (judged.workEvidenceDisagreed) {
        report.limitations.push({
          code: 'reverify_evidence_disagreement',
          detail: `#${worker.issue}: git says the worktree holds work (${workEvidenceDetail(evidence)}) but the verification run's own work-evidence gate found none `
            + `(exit ${VERIFY_EXIT_NOT_STARTED}). The gate's verdict stands — this runner does not overrule the judge — but the two disagree, which usually means the `
            + 'work is on a different branch than the one the plan names, or the gate counts a different range',
        });
      }
      // Completion is what it has always been: a COMMIT on the work branch
      // (#1468). The verdict does not decide it and never has — the two are
      // separate facts and the barrier reads them separately. Work that is only
      // in the working tree is left at its prior state on purpose: nothing
      // downstream can deliver an uncommitted change, and this flag cannot ask
      // for the commit, because asking is sending.
      if (evidence.commits !== null && evidence.commits > 0) {
        worker.worker_state = 'completed';
        worker.note = appendNote(worker.note,
          `re-judged in place by --reverify (nothing was sent); ${workEvidenceDetail(evidence)}`);
      } else {
        worker.note = appendNote(worker.note,
          `re-judged in place by --reverify (nothing was sent), but the work is NOT committed, so this issue is not a deliverable and its worker_state stays "${worker.worker_state}"; ${workEvidenceDetail(evidence)}`);
      }
      if (judged.note) worker.note = appendNote(worker.note, redact(judged.note));
      if (judged.notJudged) notJudged.add(worker.issue);
      if (judged.verdict === null) {
        // Infrastructure, not a verdict: the prior record stands untouched.
        report.limitations.push({
          code: 'reverify_judge_unavailable',
          detail: `#${worker.issue}: the verification could not be run against its worktree, so NO verdict was recorded and the prior attempt's record stands as it was. `
            + 'This is an infrastructure failure of this attempt, not a finding about the work',
        });
        return;
      }
      reverifyVerdicts.set(worker.issue, judged);
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
      if (reverifying) {
        // The verdict already exists too, for the same reason: step 3b' ran the
        // gate. Recorded through the SAME function as every other verdict, so
        // the note a human reads is derived from the field merge reads — the #83
        // invariant holds on this path by construction. An issue step 3b' did
        // not re-judge has no entry here, and its transcribed record stands.
        const judged = reverifyVerdicts.get(worker.issue);
        if (judged) recordVerification(report, worker, judged.verdict, judged.source, inputs.unattended, unattributedPasses);
      } else if (contractMode) {
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
          }, 'contract', inputs.unattended, unattributedPasses);
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
      // `dispatched` means "issues actually sent in this wave" (schema). A
      // reverify sends nothing, so the honest value is the empty list — and the
      // list being empty while `workers` is not is exactly the claim the flag
      // makes. Which issues it re-judged is in the `reverify_attempt` limitation,
      // in each worker's note, and in the ledger's `reverified`.
      dispatched: reverifying ? [] : toDispatch.slice(),
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
      } else if (wallClockExhausted()) {
        // Ranked below the two human_required stops and above everything else
        // (Issue #122). A worker abandoned because the clock ran out looks like
        // `failed`/`timeout` from the inside, and reporting it as a worker
        // failure would send the operator into a worktree to debug a worker that
        // was doing nothing wrong. Ranked below the prompt and the 99 because
        // those two are findings the run really made and re-running cannot
        // resolve, while this one says only "there was not enough time".
        // `timeout` is reused rather than a new stop_reason value invented: the
        // enum is a schema-versioned closed set (ADR section 11).
        halt('partial', 'timeout', 'wall_clock_budget_exhausted',
          `--wall-clock-budget ${inputs.wallClockBudget}s was exhausted during wave ${waveIndex + 1}; the workers of this wave were left mid-supervision `
            + 'and the next wave was not dispatched. The worktree branches are where their workers left them (the unattended_baseline limitation records where each one started)');
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

    // The stage-C stop (Issue #142 / ADR sections 6.5, 8). Placed AFTER the
    // ranking above, deliberately: every stop in that chain is a finding this
    // run really made about a worker, and this one is a finding about what the
    // report can SHOW. When both hold, the worker-level cause is the one an
    // operator acts on first, and the promoted reason is in `blocking_reasons`
    // either way (`recordVerification` wrote it when it happened, not here), so
    // ranking it last loses nothing.
    //
    // The wave DID advance: `barrier.advanced` stays true, because the barrier
    // measures completion and verification and both held. What stops the run is
    // that the next wave would be dispatched on top of a pass nobody can attribute.
    if (unattributedPasses.size > 0) {
      report.status = 'partial';
      report.stop_reason = 'dispatch_error';
      stopped = true;
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
  // A reverify's `dispatched` is empty by construction, so the "carried
  // everything" sentence above would be a lie about the one attempt that judges
  // WITHOUT dispatching (Issue #121). It gets its own sentence, naming the
  // instrument it really used.
  const dispatchedAny = report.waves.some((wave) => wave.dispatched.length > 0);
  const reverifying = resume !== null && resume.reverifying === true;
  lines.push(report.waves.length === 0
    ? '裁定: 1件も dispatch していないため、裁定は行っていない。'
    : reverifying
      ? (contractMode
        ? '裁定: `--reverify` — 1件も send せず、worktree の現状を `commandmate verify --json` の exit code で判定し直した。引き継ぎ分は前回記録の転記で、再判定していない。'
        : '裁定: `--reverify` — 1件も send せず、worktree の現状を profile baseline の再実行で判定し直した。引き継ぎ分は前回記録の転記で、再判定していない。')
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
  if (resume !== null && reverifying) {
    lines.push('## reverify');
    lines.push(`- attempt ${resume.attempt}（resumed_from: \`${resume.priorRelative}\` / attempt ${resume.priorAttempt}）。既存 artifact は上書きしていない。この attempt の artifact は \`${RESUME_ATTEMPT_PREFIX}${resume.attempt}/\` 配下。`);
    lines.push('- **`send` を1回も呼んでいない。** 実行契約も書いていないし、worker のターンも1つも消費していない。');
    lines.push(resume.carriedIssues.length === 0
      ? '- 引き継ぎ: なし（前回 attempt に「worker completed かつ verification pass」の Issue が無かった）。'
      : `- 引き継ぎ（再判定もしない）: ${resume.carriedIssues.map((n) => `#${n}`).join(', ')} — worker completed かつ verification pass。verification 記録は転記しただけである。`);
    lines.push(resume.redispatchIssues.length === 0
      ? '- **再判定対象なし**: plan の全 Issue が既に completed かつ verification pass だった。'
      : `- 再判定の候補: ${resume.redispatchIssues.map((n) => `#${n}`).join(', ')}。このうち **worktree に作業証跡（work ブランチの commit / 未 commit の変更）が在るものだけ**を判定し直した。`);
    const notReverified = report.limitations.filter((entry) => entry.code === 'reverify_no_work_evidence'
      || entry.code === 'reverify_evidence_unreadable' || entry.code === 'reverify_prompt_pending');
    if (notReverified.length > 0) {
      lines.push('- 判定し直していない Issue（前回記録をそのまま転記した）:');
      for (const entry of notReverified) lines.push(`  - ${entry.detail}`);
    }
    lines.push('- 完了の定義は通常経路と同じ「work ブランチの新規 commit」である。未 commit の作業だけの Issue は `completed` に上げない（納品できないし、この経路は commit を要求できない — 要求は send だからである）。');
    lines.push('');
  } else if (resume !== null) {
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

  // The unattended section (Issue #122). Printed only when the operator opted
  // in, so a run without `--unattended` reads exactly as it did before the flag
  // existed — including this summary. It is placed before the waves because it
  // is the frame every line below is read in: what was declared, what that
  // implied, and where each worktree stood before this run touched it.
  const unattendedDeclared = report.limitations.find((entry) => entry.code === 'unattended_mode');
  if (unattendedDeclared) {
    const baselines = report.limitations.filter((entry) => entry.code === 'unattended_baseline');
    lines.push('## 無人運転（unattended）');
    lines.push(`- 宣言: ${unattendedDeclared.detail}`);
    lines.push(baselines.length === 0
      ? '- 取り消しの起点: なし（1件も dispatch していないので、この run が動かした worktree は無い）。'
      : `- 取り消しの起点: ${baselines.length} 件の worktree について branch と開始時 SHA を記録した（unattended_baseline）。**untracked file・merge/push 済みの変更・gc 済みの object は戻らない**（SKILL.md 第5節）。`);
    lines.push('- **`--unattended` は mutation の許可ではない。** merge / uat を無人で回すなら `--approve` を別に書く。');
    lines.push('');
  }

  // The method section (Issue #128 / ADR section 9). Printed only when the
  // operator opted in, so a run without `--worker-method` reads exactly as it
  // did before the flag existed — including this summary.
  const methodDeclared = report.limitations.find((entry) => entry.code === 'worker_method_declared');
  const methodApplied = report.limitations.filter((entry) => entry.code === 'worker_method_applied');
  const methodBlocked = report.blocking_reasons.filter((entry) => entry.code === 'worker_method_unavailable');
  if (methodDeclared || methodBlocked.length > 0) {
    lines.push('## 方法論');
    if (methodDeclared) lines.push(`- 宣言: ${methodDeclared.detail}`);
    for (const entry of methodBlocked) lines.push(`- 停止: ${entry.code} — ${entry.detail}`);
    lines.push(methodApplied.length === 0
      ? '- 適用: なし（契約 / prompt を1件も書いていない）。'
      : `- 適用: ${methodApplied.length} 件の Issue の task text に \`## Method\` 節を書いた。`);
    // The one sentence this whole feature must not let a reader lose: dispatch
    // measures that the reference was written, never that it was obeyed
    // (ADR section 3.5 — the same discipline as cmate-verify's "PASS は宣言した
    // ゲートが通った以上のことを意味しない").
    lines.push('- **「適用された」と「守られた」は別の事実である。** dispatch が測れるのは、宣言・install の実在・契約への記載の3つだけで、worker が実際に方法論に従ったかは測っていない。');
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
      lines.push(report.limitations.some((entry) => entry.code === 'unattended_mode')
        // Same reason as the contract line below: `--allow-questions` is a
        // refused input under `--unattended`, so it is not an option to offer.
        ? '- next: 上記 open question を Issue 本文に反映して plan を作り直す。`--unattended` は `--allow-questions` を拒否するので、未回答のまま押し通す道は無い（引き受ける人が居ないときに立てられる旗ではない）（owner: human）。'
        : '- next: 上記 open question を Issue 本文に反映して plan を作り直す。回答せずに進めると判断したなら `--allow-questions` を明示して再実行する（owner: human）。');
    }
    if (report.human_required && !haltedOnQuestions && !report.blocking_reasons.some((reason) => reason.code === 'verification_not_judged')) {
      lines.push('- next: 提示した prompt を human が確認し、承認のうえ再開する（owner: human）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'verification_not_judged')) {
      lines.push('- next: 判定に到達しなかった検証 run（exit 99）を human が調べる。契約が run に束ねられたか・タスクが既に終端でないかを確認する。20（判定して不合格）ではないので worker への再指示ループには流さない（owner: human）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'contract_unsupported')) {
      lines.push(report.limitations.some((entry) => entry.code === 'unattended_mode')
        // `--contract-mode auto` is the advice for an attended run; under
        // --unattended it is a refused input, so naming it here would send the
        // operator to a flag combination that exits 3 (Issue #122).
        ? '- next: CommandMate を 0.17.0 以上へ更新して契約経路で再実行する。`--unattended` は `--contract-mode require` を含意するので、フォールバックへ落とす選択肢は無い（落とすなら `--unattended` を外し、人間が読む運転に戻す）（owner: operator）。'
        : '- next: CommandMate を 0.17.0 以上へ更新して契約経路で再実行するか、`--contract-mode auto` でフォールバック実行する（owner: operator）。');
    }
    // The two unattended-only stops (Issue #122). Both are re-runnable, but for
    // opposite reasons, and saying which is which is the whole point of the line.
    if (report.blocking_reasons.some((reason) => reason.code === 'unattended_locked')) {
      lines.push('- next: 同じ worktree を別の dispatch run が動かしている。**その run の終了を待って同じコマンドを再実行する**（`--out` は消費していない）。lock が残り続けるなら、所有 run の pid が生きているかを確認する（死んでいれば次の run が自動で回収する）（owner: operator）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'wall_clock_budget_exhausted')) {
      lines.push('- next: `--wall-clock-budget` に到達して打ち切った。**成功ではない。** 何に時間を使ったか（baseline / acceptance コマンドは自前の timeout を持たない）を確認し、原因を潰すか budget を実測に合わせて増やしたうえで `--resume` で再開する（owner: operator）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'contract_scope_unknown')) {
      lines.push('- next: 対象 file を1件も宣言していない Issue がある。**Issue 本文に対象ファイルを書いて re-plan する。** `--unattended` は plan 全体を pre-flight で検査するので、1件でも欠けていれば1人も dispatch しない（`--out` は消費していない）（owner: human）。');
    }
    // The stage-C promotion (Issue #142). The verdict itself is not in doubt —
    // it is an exit code — so the action is about the EVIDENCE, and the line
    // says so rather than sending the operator to debug a worker.
    if (report.blocking_reasons.some((reason) => reason.code === 'verification_gates_unrecorded')) {
      lines.push('- next: pass の根拠となった gate を report が名指しできていない。`GATE <id> PASS|FAIL` 行を出す CommandMate で再実行して根拠を残す。**裁定（exit code）は pass のままだが、無人 merge の根拠にはしない**（段階 C）。人間が読む運転に戻すなら `--unattended` を外せば従来どおり limitation として続行する（owner: operator）。');
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
    if (report.limitations.some((entry) => entry.code === 'reverify_no_work')) {
      lines.push('- next: 再判定対象は無い。この attempt の report をそのまま merge / uat に渡す（owner: operator）。');
    }
    // The reverify next-action (Issue #121). An issue this attempt could not
    // re-judge needs a WORKER, not another verdict, so the command it names is
    // the other one — saying "re-run --reverify" would loop on the same finding.
    if (report.limitations.some((entry) => entry.code === 'reverify_no_work_evidence'
      || entry.code === 'reverify_evidence_unreadable' || entry.code === 'reverify_prompt_pending')) {
      lines.push('- next: 判定し直せなかった Issue（作業証跡が無い / 読めない / prompt 保留）は、裁定ではなく worker が要る。`dispatch.mjs --plan <plan.json> --resume <この run の dispatch ディレクトリ>` で dispatch し直す（owner: operator）。');
    }
    // The L4 stop (Issue #148). It replaces the generic verification-failure line
    // rather than sitting beside it: "worktree を診断して再 dispatch" is the one
    // instruction that is WRONG here — re-dispatching the same plan re-runs the
    // same unsatisfiable loop, because `scope.allow` is a snapshot of the Issue's
    // 対象ファイル and nothing in the worktree can widen it.
    const scopeUnsatisfiable = report.blocking_reasons.some((reason) => reason.code === 'scope_unsatisfiable');
    if (scopeUnsatisfiable) {
      lines.push('- next: **worker では直せない。** 契約の `scope.allow` は send 時 snapshot なので worktree の中からは広げられない。上記 blocking の違反 path を **Issue の対象ファイルに足して re-plan する**（repo の規約なら profile 側に宣言する）。同じ plan のまま再 dispatch すると同じ所で止まる（owner: human）。');
    }
    if (report.stop_reason === 'verification_failed' && !scopeUnsatisfiable) lines.push('- next: verification 失敗の worktree を診断し、修正後に再 dispatch する（owner: operator）。');
    if (report.status !== 'success' && report.out_dir !== null) {
      lines.push('- next: 原因を直したら `dispatch.mjs --plan <plan.json> --resume <この run の dispatch ディレクトリ>` で再開する。worker completed かつ verification pass の Issue は再 dispatch されず、その verification 記録だけが引き継がれる（owner: operator）。');
    }
    // The conditional dependency, named (Issue #93). A stage the operator asked
    // for and that could not run must say what to install and what to pass —
    // "worktree を作成して再実行" is the answer to a different question.
    // The conditional dependency the operator named themselves (Issue #128).
    // "install it and re-run the same command" is the whole fix, and it is worth
    // saying that `--out` was not consumed — that is why the same command works.
    if (methodBlocked.length > 0) {
      lines.push('- next: `commandmate skill install <skill-id>` で方法論スキルを対象 worktree に入れ（`.claude/skills` と `.agents/skills` の両方に入る）、**同じコマンドをそのまま再実行**する。`--out` は消費していない。方法論なしで走らせてよいなら `--worker-method` を外す（owner: operator）。');
    }
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
  // The clock starts at the top of the run, not at the first wave: the budget is
  // the invocation's wall clock, and the pre-flight, the contract probe and the
  // worktree preparation stage are part of what it pays for (Issue #122).
  startWallClockBudget(inputs.wallClockBudget);
  const rawPlan = loadPlan(inputs.planPath);
  const plan = validatePlan(rawPlan);

  // The resume decision (Issue #98) is made FIRST: it decides which directory
  // this attempt writes into, which wave the pre-flight has to probe, and which
  // issues it may demand a worktree for. It is also where a report from another
  // plan is refused — before anything is probed, sent or written.
  // `--reverify` (Issue #121) is the same decision reached through a different
  // flag, so it is built by the same function and travels in the same variable:
  // every "this attempt appends into a prior run" rule below — the directory it
  // writes into, which wave the pre-flight probes, which worktrees it may lock,
  // which report it refuses — is one rule, not two.
  const resume = inputs.reverifyDir !== null
    ? buildResume(inputs, plan, 'reverify')
    : (inputs.resumeDir === null ? null : buildResume(inputs, plan));
  const outDir = resume !== null ? resume.dir : (inputs.outDir ?? join(dirname(inputs.planPath), 'dispatch'));
  // `--out` claims a new directory; `--resume` appends into an existing one, and
  // protects the earlier attempts by writing under a `resume-attempt-<n>/` name
  // that does not exist yet (nextAttemptNumber) rather than by refusing here.
  if (resume === null && existsSync(outDir)) {
    throw new SkillError('out_exists', `dispatch directory ${outDir} already exists; refusing to overwrite`, 4);
  }
  // Where THIS attempt's artifacts go — the run directory on a first dispatch,
  // `<run-dir>/resume-attempt-<n>/` on a resume.
  const attemptDir = resume === null ? outDir : resume.attemptDir;

  // ---- unattended: exclusivity, then the plan-only gates (Issue #122) -------
  //
  // Both happen BEFORE the pre-flight, and in this order.
  //
  // The lock comes first because the window Issue #115 measured opens at process
  // start: two runs that are both inside their pre-flight have neither created
  // `--out` nor sent anything, and the `--prepare-worktrees` stage — which
  // creates worktrees and branches — sits inside exactly that window. A lock
  // taken after the pre-flight would be taken after the mutation it guards.
  //
  // The plan-only refusal comes second because it needs no world at all: an
  // unanswered planner question and an undeclarable scope are facts about the
  // plan, and refusing on them before probing anything is what leaves `--out`
  // unconsumed for the re-run after the re-plan.
  let lockKeys = [];
  if (inputs.unattended) {
    const lockable = resume === null
      ? (plan.issues ?? [])
      : (plan.issues ?? []).filter((issue) => !resume.carried.has(issue.number));
    const locks = acquireUnattendedLocks(plan, lockable);
    if (!locks.ok) {
      const report = unattendedRefusalReport(inputs, plan, locks.reasons, { humanRequired: false, resume });
      process.stderr.write(`nothing was dispatched; another run holds the worktree lock, so ${attemptDir} was not created — re-run once it has finished\n`);
      return { exitCode: 1, stdout: `${JSON.stringify(report, null, 2)}\n` };
    }
    lockKeys = locks.keys;

    const planReasons = unattendedPlanReasons(plan);
    if (planReasons.length > 0) {
      // human_required: these are not re-dispatchable. The fix is an edit to the
      // issue body followed by a re-plan, which is what the field means (the
      // schema says "None of the three is resolvable by re-dispatching"), and it
      // is what stops a CI job from retrying the same plan forever.
      const report = unattendedRefusalReport(inputs, plan, planReasons, { humanRequired: true, lockKeys, resume });
      process.stderr.write(`nothing was dispatched; ${attemptDir} was not created, so the same command can be re-run once the issues are fixed and re-planned\n`);
      return { exitCode: 1, stdout: `${JSON.stringify(report, null, 2)}\n` };
    }
  }

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
    const report = preflightFailureReport(inputs, plan, preflight, preparation, resume, lockKeys);
    // The advice names what actually blocked. "once the drift is fixed" is the
    // wrong instruction for a missing worker-method Skill, and the operator only
    // gets one line on stderr (Issue #128).
    const methodBlocked = preflight.reasons.some((reason) => reason.code === 'worker_method_unavailable');
    process.stderr.write(methodBlocked
      ? `nothing was dispatched; ${attemptDir} was not created, so the same command can be re-run once ${inputs.workerMethod} is installed in every worktree it dispatches into\n`
      : `nothing was dispatched; ${attemptDir} was not created, so the same command can be re-run once the drift is fixed\n`);
    return { exitCode: 1, stdout: `${JSON.stringify(report, null, 2)}\n` };
  }

  mkdirSync(attemptDir, { recursive: true });

  const report = await runDispatch(inputs, plan, attemptDir, preflight, preparation, resume, lockKeys);
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
    kind: resume === null ? 'initial' : resume.mode,
    plan_run_id: plan.run_id,
    resumed_from: resume === null ? null : { attempt: resume.priorAttempt, report: resume.priorRelative },
    report: attemptReportRelative(attempt),
    summary: attemptSummaryRelative(attempt),
    status: report.status,
    stop_reason: report.stop_reason,
    carried_over: resume === null ? [] : resume.carriedIssues,
    dispatched: report.waves.flatMap((wave) => wave.dispatched),
    // The reverify half of the ledger (Issue #121). `dispatched` is empty on such
    // an attempt — nothing was sent — so without this line the ledger could not
    // say what the attempt actually did. Absent on every other kind rather than
    // written as `[]`, so an old reader sees the file it has always seen.
    ...(resume !== null && resume.reverifying ? { reverified: resume.redispatchIssues.slice() } : {}),
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
