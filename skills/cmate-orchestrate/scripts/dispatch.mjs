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
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SKILL_ID = 'cmate-orchestrate';
const SKILL_VERSION = '0.11.0';
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

class SkillError extends Error {
  constructor(code, detail, exitCode) {
    super(detail);
    this.code = code;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

// =============================================================================
// Redaction (mirrors the plan-core runner; shapes only, never example secrets)
// =============================================================================

const REDACTIONS = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED-TOKEN]'],
  [/github_pat_[A-Za-z0-9_]{40,}/g, '[REDACTED-TOKEN]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED-TOKEN]'],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED-TOKEN]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED-TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED-TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED-TOKEN]'],
  [/\b[Bb]earer\s+[A-Za-z0-9._-]{10,}/g, 'Bearer [REDACTED-TOKEN]'],
  [/(?:\/Users\/|\/home\/|\/root\/|\/var\/|\/private\/|\/tmp\/)[^\s"'`)\]]*/g, '[REDACTED-PATH]'],
  [/\b[A-Za-z]:\\[^\s"'`)\]]*/g, '[REDACTED-PATH]'],
];

// Tallied by kind so the report can say "we found and removed N of these"
// without ever echoing the value itself.
const REDACTION_KIND = [
  [/\[REDACTED-TOKEN\]/g, 'token'],
  [/Bearer \[REDACTED-TOKEN\]/g, 'bearer_token'],
  [/\[REDACTED-PATH\]/g, 'absolute_path'],
];

const redactionTally = new Map();

function redact(value) {
  let text = String(value);
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  for (const [pattern, kind] of REDACTION_KIND) {
    const hits = text.match(pattern);
    if (hits) redactionTally.set(kind, (redactionTally.get(kind) ?? 0) + hits.length);
  }
  return text;
}

// A short, redacted excerpt of terminal-ish output. The raw stream is never
// stored: a bounded tail is enough for a human to act on a prompt or a failure.
function excerpt(value, limit = 280) {
  const text = redact(value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text || null;
  return `…${text.slice(text.length - limit)}`;
}

function redactionsList() {
  return [...redactionTally.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([kind, count]) => ({ kind, count }));
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
                         (default: <plan-dir>/dispatch).
  --cli <path>           The commandmate CLI to drive (default "commandmate").
  --git <path>           The git CLI used for drift checks (default "git").
  --gh <path>            The gh CLI used for the repo-access check (default "gh").
  --auto-yes             Answer worker prompts automatically. OFF by default; a
                         prompt otherwise halts the loop for a human.
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
        cli: { type: 'string' },
        git: { type: 'string' },
        gh: { type: 'string' },
        'auto-yes': { type: 'boolean' },
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

function resolveInputs(parsed) {
  const { values } = parsed;
  if (!values.plan) {
    throw new SkillError('invalid_input', '--plan <path> is required', 3);
  }
  return {
    planPath: values.plan,
    outDir: values.out ?? null,
    cli: values.cli ?? 'commandmate',
    git: values.git ?? 'git',
    gh: values.gh ?? 'gh',
    autoYes: Boolean(values['auto-yes']),
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
// Worktree target safety
// =============================================================================

// The worktree path comes from a verified profile template (e.g. "../repo-…"),
// so a single leading "../" to a sibling directory is legitimate. Anything that
// could escape further — an absolute path, a drive path, a backslash, a control
// character, or a "../" that is not the single leading segment — is refused.
function safeWorktreeTarget(pathValue) {
  if (typeof pathValue !== 'string' || pathValue.length === 0) return null;
  if (pathValue.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(pathValue)) return null;
  if (pathValue.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[ -]/.test(pathValue)) return null;
  let rest = pathValue;
  if (rest.startsWith('../')) rest = rest.slice(3);
  if (rest.split('/').some((segment) => segment === '..')) return null;
  return pathValue;
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

function parseCliJson(result) {
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
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
function driftChecks(inputs, plan, waveIndex, resolutions) {
  const checks = [];
  const add = (code, ok, blocking, detail) =>
    checks.push({ wave_index: waveIndex, code, ok, blocking, detail });

  const cli = runCli(inputs.cli, ['--version']);
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
  add('worktrees_present', present, false, present ? 'planned worktrees resolve (commandmate ls branch match or git worktree list)' : `${unresolved.length} planned worktree(s) neither resolve via commandmate ls nor appear in git worktree list`);

  return checks;
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
  const send = runCli(inputs.cli, ['send', '--help']);
  const wait = runCli(inputs.cli, ['wait', '--help']);
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

function issueOf(plan, number) {
  return plan.issues.find((issue) => issue.number === number) ?? { number };
}

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

// Resolve the CommandMate worktree id an issue's work lives in, at dispatch time.
// The public CLI is worktree-id based (`send <id> …`); the id is the one
// CommandMate assigned, a `<repo>-<branch>` slug we cannot reconstruct reliably.
// A plan may already carry a resolved `worktree_id`; otherwise we ask the live
// CLI (`ls --json`) which worktree currently holds the issue's branch. There is
// no `commandmate sync` — `ls` is the source of truth for the id.
function resolveWorktreeId(inputs, issue) {
  if (typeof issue.worktree_id === 'string' && WORKTREE_ID_RE.test(issue.worktree_id)) {
    return { id: issue.worktree_id, path: null, note: '' };
  }
  const branch = typeof issue.branch === 'string' ? issue.branch : null;
  if (!branch) return { id: null, path: null, note: 'issue has no branch to resolve a worktree from' };
  const result = runCli(inputs.cli, ['ls', '--json']);
  const rows = parseCliJson(result);
  if (!Array.isArray(rows)) {
    return { id: null, path: null, note: excerpt(result.stderr || result.stdout || 'ls returned no worktree list') };
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
  return { id, path, note: id ? '' : `no registered worktree matches branch ${redact(branch)}` };
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
  const first = await runCliAsync(inputs.cli, ['send', worktreeId, message]);
  if (!first.ok) {
    return { sent: false, note: excerpt(first.stderr || first.stdout || 'send failed') };
  }
  const capture = parseCliJson(await runCliAsync(inputs.cli, ['capture', worktreeId, '--json']));
  const started = capture && (capture.isGenerating === true || capture.isRunning === true || capture.isPromptWaiting === true);
  if (started) return { sent: true, confirmed: true, note: '' };
  const again = await runCliAsync(inputs.cli, ['send', worktreeId, message]);
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
  const first = await runCliAsync(inputs.cli, ['send', worktreeId, '--contract', relativeContractPath]);
  if (!first.ok) {
    return { sent: false, taskId: null, note: excerpt(first.stderr || first.stdout || 'contract send failed') };
  }
  const taskId = readTaskId(first.stdout);
  const capture = parseCliJson(await runCliAsync(inputs.cli, ['capture', worktreeId, '--json']));
  const started = capture && (capture.isGenerating === true || capture.isRunning === true || capture.isPromptWaiting === true);
  if (started) return { sent: true, taskId, confirmed: true, note: '' };
  // Re-sending WITH --contract would create a second task row for the same work
  // and leave the first one running forever, so the confirmation is a plain
  // message: it submits whatever the first send left in the input box.
  const again = await runCliAsync(inputs.cli, ['send', worktreeId, CONTRACT_CONFIRM_MESSAGE]);
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
  const result = await runCliAsync(inputs.cli, ['verify', worktreeId, '--json']);
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
    const waited = await runCliAsync(inputs.cli, waitArgs);
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
        note: 'verification reached no verdict (exit 99: the run ended error/cancelled); escalated to a human rather than re-instructed as a verification failure',
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
        const note = turns > 1
          ? `completed after ${turns - 1} follow-up message(s); verification passed and a new commit was detected`
          : 'completed; verification passed and a new commit was detected';
        return done('completed', note);
      }
      if (turns >= inputs.maxTurns) {
        return done('failed', `verification passed but no commit was produced after ${turns} turn(s); gave up at the --max-turns ${inputs.maxTurns} cap`);
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
        return done(
          committed ? 'completed' : 'failed',
          `verification failed (${failing.summary}) and the --max-turns ${inputs.maxTurns} cap was reached${committed ? '' : ' with no commit'}`,
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
    const waited = await runCliAsync(inputs.cli, ['wait', worktreeId, '--timeout', String(inputs.waitTimeout)]);
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
  const result = await runCliAsync(inputs.cli, ['capture', worktreeId, '--json']);
  const payload = parseCliJson(result);
  const raw = payload?.promptData?.question ?? payload?.content ?? result.stdout ?? '';
  return excerpt(raw) ?? 'a prompt is awaiting input';
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
  const result = await runCliAsync(inputs.cli, ['respond', worktreeId, 'yes']);
  return result.ok;
}

// =============================================================================
// The supervision loop
// =============================================================================

async function runDispatch(inputs, plan, outDir) {
  const promptsDir = join(outDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });

  const report = {
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

  // Loop-wide facts the completion check is derived from.
  let parallelismBounded = true;
  let barrierEnforced = true;
  let autoResponded = false;
  let stopped = false;

  const halt = (status, stopReason, code, detail) => {
    report.status = status;
    report.stop_reason = stopReason;
    report.blocking_reasons.push({ code, detail });
    stopped = true;
  };

  // The version gate (#1588). Decided ONCE, before the first wave, and always
  // stated: `auto` falls back with an explicit limitation, `require` refuses to
  // fall back at all, `off` never probes. What is not allowed is degrading in
  // silence — the fallback reports the same `verification.outcome: pass` from a
  // materially weaker check.
  let contractMode = false;
  if (inputs.contractMode === 'off') {
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

  for (let waveIndex = 0; waveIndex < plan.waves.length && !stopped; waveIndex += 1) {
    const waveIssues = plan.waves[waveIndex];
    // Resolve each issue's CommandMate worktree ONCE, up front: its id (what
    // send/wait/capture address) and the real `path` `commandmate ls` reports
    // (what git rev-parse and the baseline cwd into). The drift probe, the
    // supervision loop and the verification gate all read this single resolution,
    // so the id path and the git path can never diverge (Issue #1473). The plan's
    // template path is only a fallback for when `ls` omits a path.
    const resolutions = waveIssues.map((number) => {
      const issue = issueOf(plan, number);
      const templatePath = safeWorktreeTarget(issue.worktree ?? '');
      const resolved = resolveWorktreeId(inputs, issue);
      const worktreePath = resolved.path ?? templatePath;
      return { number, issue, templatePath, resolved, worktreePath };
    });

    // 1. Drift re-check before this (mutating) wave.
    const checks = driftChecks(inputs, plan, waveIndex, resolutions);
    report.drift_checks.push(...checks);
    for (const check of checks) {
      if (!check.ok && !check.blocking) {
        report.limitations.push({ code: `drift_${check.code}`, detail: check.detail });
      }
    }
    const blockingDrift = checks.find((check) => check.blocking && !check.ok);
    if (blockingDrift) {
      const waveRecord = { index: waveIndex, dispatched: [], workers: [], barrier: { all_workers_completed: false, all_verifications_passed: false, advanced: false } };
      report.waves.push(waveRecord);
      // Drift before the very first wave means nothing was dispatched at all.
      const status = waveIndex === 0 ? 'failure' : 'partial';
      halt(status, 'drift', `drift_${blockingDrift.code}`, blockingDrift.detail);
      break;
    }

    // 2. max_parallel guard (belt-and-braces; validatePlan already refused a
    //    wider wave, but the runner never dispatches beyond the bound).
    const toDispatch = waveIssues.slice(0, plan.max_parallel);
    if (waveIssues.length > plan.max_parallel) {
      parallelismBounded = false;
      report.limitations.push({ code: 'parallelism_truncated', detail: `wave ${waveIndex} had ${waveIssues.length} issues; capped at ${plan.max_parallel}` });
    }

    // 3a. Prepare every issue in the wave (sequential, cheap): build its worker
    //     record, take its already-resolved worktree id/path, and write its prompt
    //     artifact. `worktreePaths` remembers the git path per issue so the
    //     verification gate reuses the exact same worktree the supervisor drove
    //     (Issue #1473). Workers that cannot be dispatched (unsafe target /
    //     unresolved worktree) are recorded terminal here and never supervised.
    const workers = [];
    const worktreePaths = new Map();
    const supervisable = [];
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
    let allVerified = allCompleted;
    if (allCompleted) {
      for (const worker of workers) {
        if (contractMode) {
          // The verdict already exists: it is the exit code CommandMate returned
          // while the worker was supervised. Re-running anything here would be a
          // second opinion from a weaker judge.
          const verdict = contractVerdicts.get(worker.issue);
          worker.verification = verdict
            ? { ran: verdict.ran, report_schema_version: null, outcome: verdict.outcome, gates: verdict.gates ?? [], checks: verdict.checks }
            : { ran: false, report_schema_version: null, outcome: 'not_run', gates: [], checks: [] };
        } else {
          const worktreePath = worktreePaths.get(worker.issue) ?? safeWorktreeTarget(issueOf(plan, worker.issue).worktree ?? '');
          const verification = verifyWorker(inputs, worktreePath, plan.profile.baseline);
          worker.verification = {
            ran: verification.ran,
            report_schema_version: null,
            outcome: verification.outcome,
            // The fallback judge is the baseline re-run: it has no contract
            // gates, and the commands it ran are already named in checks.
            gates: [],
            checks: verification.checks,
          };
          if (verification.note) worker.note = worker.note ? `${worker.note}; ${verification.note}` : verification.note;
        }
        if (worker.verification.outcome !== 'pass') allVerified = false;
      }
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

  // Completion self-check. `no_auto_prompt_response` guards the safe default: a
  // prompt is never answered UNLESS --auto-yes was explicitly set.
  report.completion_check = buildCompletionCheck({
    planApproved: true,
    driftReconfirmed: report.drift_checks.length > 0,
    parallelismBounded,
    barrierEnforced,
    noAutoPromptResponse: !autoResponded || inputs.autoYes,
    reportStatus: report.status,
  });
  if (!report.completion_check.passed && report.status === 'success') {
    report.status = 'partial';
    report.limitations.push({ code: 'completion_check_failed', detail: 'a completion check did not pass; see completion_check' });
  }

  report.redactions = redactionsList();
  report.summary_markdown = renderSummary(report, contractMode);
  return report;
}

function buildCompletionCheck({ planApproved, driftReconfirmed, parallelismBounded, barrierEnforced, noAutoPromptResponse, reportStatus }) {
  const checks = [
    { id: 'plan_approved', passed: planApproved, detail: planApproved ? 'an approved plan was loaded and validated' : 'no valid plan was loaded' },
    { id: 'drift_reconfirmed', passed: driftReconfirmed, detail: driftReconfirmed ? 'drift was re-checked before dispatch' : 'no drift check ran' },
    { id: 'parallelism_bounded', passed: parallelismBounded, detail: parallelismBounded ? 'no wave dispatched more than max_parallel workers' : 'a wave exceeded max_parallel and was truncated' },
    { id: 'barrier_enforced', passed: barrierEnforced, detail: barrierEnforced ? 'the next wave dispatched only after completion AND verification' : 'the wave barrier was not enforced' },
    { id: 'no_auto_prompt_response', passed: noAutoPromptResponse, detail: noAutoPromptResponse ? 'no prompt was answered without explicit --auto-yes' : 'a worker prompt was answered without authorization' },
  ];
  // A failure result is a legitimate outcome, but it still must not claim a
  // passed completion check unless every invariant above actually held.
  const passed = checks.every((check) => check.passed) && reportStatus !== 'failure';
  return { passed, checks };
}

// =============================================================================
// Summary
// =============================================================================

function renderSummary(report, contractMode = false) {
  const lines = [];
  lines.push('## 対象と結論');
  const verb = report.status === 'success' ? '完了' : report.status === 'partial' ? '途中停止' : '未実行';
  lines.push(`plan ${report.plan_run_id} を ${report.profile.repository} に dispatch: ${report.status}（${verb}, stop=${report.stop_reason}）。`);
  lines.push(contractMode
    ? '裁定: 実行契約（`commandmate send --contract` / `wait --verify` の exit code）を一次ソースにした。'
    : '裁定: 実行契約は使わず、profile baseline を worktree 内で再実行するフォールバックで判定した。');
  const notJudged = report.blocking_reasons.find((reason) => reason.code === 'verification_not_judged');
  if (notJudged) lines.push('検証が判定に到達しなかった（exit 99）ため、不合格として再指示せず human 提示で停止した。');
  else if (report.human_required) lines.push('worker が prompt を出したため、自動応答せず human 提示で停止した。');
  lines.push('');
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
    if (report.human_required && !report.blocking_reasons.some((reason) => reason.code === 'verification_not_judged')) {
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
    if (report.stop_reason === 'verification_failed') lines.push('- next: verification 失敗の worktree を診断し、修正後に再 dispatch する（owner: operator）。');
    if (report.stop_reason === 'drift') lines.push('- next: drift（branch/base/permission）を解消し、plan を再確認して再開する（owner: operator）。');
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

  const outDir = inputs.outDir ?? join(dirname(inputs.planPath), 'dispatch');
  if (existsSync(outDir)) {
    throw new SkillError('out_exists', `dispatch directory ${outDir} already exists; refusing to overwrite`, 4);
  }
  mkdirSync(outDir, { recursive: true });

  const report = await runDispatch(inputs, plan, outDir);
  writeFileSync(join(outDir, 'dispatch-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'dispatch-summary.md'), `${report.summary_markdown}\n`, 'utf8');

  process.stderr.write(`wrote dispatch artifacts to ${outDir}\n`);
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
