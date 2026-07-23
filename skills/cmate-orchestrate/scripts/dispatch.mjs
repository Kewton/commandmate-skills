#!/usr/bin/env node
// cmate-orchestrate — dispatch and supervision runner (Node stdlib only, Node >= 22).
//
// This runner does the *execution* half of official CommandMate issue
// orchestration. It takes an already-approved plan produced by the plan-core
// runner (scripts/orchestrate.mjs) and drives it, wave by wave, against the
// public `commandmate` CLI:
//
//   - it resolves each issue's CommandMate worktree id AND real path from a single
//     `commandmate ls --json` row matched on the plan's branch (Issue #1473), and
//     dispatches a self-contained, generic worker prompt to it with `commandmate
//     send <worktree-id> <message>` (the public CLI is worktree-id based; there is
//     no task id, --worktree or --prompt-file). Because `send`/`wait`/`capture`
//     (id) and the git operations below (path) both come from that one row, they
//     can never diverge onto different worktrees; the plan's template path is only
//     a fallback when `ls` omits a path;
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
//     of the previous wave completed (committed) AND its profile baseline, re-run
//     inside the worktree, passed (there is no `commandmate verify`). Worker
//     completion and verification success are kept strictly separate;
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
const SKILL_VERSION = '0.7.0';
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

// The independent verification gate. Worker completion got us here; this re-runs
// the profile baseline INSIDE the worktree (there is no `commandmate verify`) and
// passes only when every baseline command exits zero. A missing worktree or any
// non-zero step is a fail — never optimistically opened.
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
        verification: { ran: false, report_schema_version: null, outcome: 'not_run', checks: [] },
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
      worker.task_id = res.resolved.id;
      worktreePaths.set(number, res.worktreePath);

      const promptFile = join(promptsDir, `issue-${number}.md`);
      const prompt = buildWorkerPrompt(plan, res.issue);
      writeFileSync(promptFile, `${prompt}\n`, 'utf8');

      workers.push(worker);
      supervisable.push({ worker, worktreeId: res.resolved.id, worktreePath: res.worktreePath, prompt });
    }

    // 3b. Supervise the wave's workers CONCURRENTLY (Issue #1474). Each worker
    //     runs its own send -> wait -> commit-check -> nudge loop; because
    //     `commandmate wait` blocks until its worker idles, running them in
    //     parallel (the wave width is already <= max_parallel, so the runtime
    //     parallelism matches the plan bound) makes the wave take the slowest
    //     single worker instead of the sum. Each worker's commit detection,
    //     --max-turns, prompt handling and auto-yes respond stay strictly
    //     independent; the wave barrier below is unchanged.
    await Promise.all(supervisable.map(async ({ worker, worktreeId, worktreePath, prompt }) => {
      const supervised = await superviseUntilCommit(inputs, worktreeId, worktreePath, prompt);
      worker.worker_state = supervised.state;
      worker.note = redact(supervised.note);
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
        const worktreePath = worktreePaths.get(worker.issue) ?? safeWorktreeTarget(issueOf(plan, worker.issue).worktree ?? '');
        const verification = verifyWorker(inputs, worktreePath, plan.profile.baseline);
        worker.verification = {
          ran: verification.ran,
          report_schema_version: null,
          outcome: verification.outcome,
          checks: verification.checks,
        };
        if (verification.note) worker.note = worker.note ? `${worker.note}; ${verification.note}` : verification.note;
        if (verification.outcome !== 'pass') allVerified = false;
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
      if (prompted) {
        report.human_required = true;
        halt('partial', 'human_required', 'human_input_required', `#${prompted.issue} raised a prompt; halted for a human (no auto-response)`);
      } else if (workers.some((worker) => worker.worker_state === 'failed')) {
        const failed = workers.find((worker) => worker.worker_state === 'failed');
        halt('partial', 'worker_failed', 'worker_failed', `#${failed.issue} did not complete; the next wave was not dispatched`);
      } else if (workers.some((worker) => worker.worker_state === 'timeout')) {
        const timed = workers.find((worker) => worker.worker_state === 'timeout');
        halt('partial', 'timeout', 'worker_timeout', `#${timed.issue} timed out; the next wave was not dispatched`);
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
  report.summary_markdown = renderSummary(report);
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

function renderSummary(report) {
  const lines = [];
  lines.push('## 対象と結論');
  const verb = report.status === 'success' ? '完了' : report.status === 'partial' ? '途中停止' : '未実行';
  lines.push(`plan ${report.plan_run_id} を ${report.profile.repository} に dispatch: ${report.status}（${verb}, stop=${report.stop_reason}）。`);
  if (report.human_required) lines.push('worker が prompt を出したため、自動応答せず human 提示で停止した。');
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
    if (report.human_required) lines.push('- next: 提示した prompt を human が確認し、承認のうえ再開する（owner: human）。');
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
