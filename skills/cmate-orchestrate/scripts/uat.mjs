#!/usr/bin/env node
// cmate-orchestrate — UAT assessment and bounded fix-loop runner
// (Node stdlib only, Node >= 22).
//
// This runner does the *acceptance* half of official CommandMate issue
// orchestration. It runs after the merge runner (scripts/merge.mjs) has
// delivered the verification-passed issues of a plan; it takes the approved plan
// plus the dispatch report and, for the issues whose worker completed AND whose
// verification passed, performs exactly ONE phase per invocation, mirroring the
// CommandAgent explicit-phase-flag design (ADR #1447):
//
//   --write-uat                 Run the acceptance (UAT) assessment once over the
//                               eligible issues and write the report. Read-only:
//                               it never creates a worktree or dispatches a fix.
//   --create-uat-fix-worktrees  Run the bounded fix loop. When UAT fails it
//                               creates a fix worktree per failing issue (in the
//                               shape of the cmate-worktree-setup result, #1448),
//                               dispatches a fix worker, re-verifies it, re-merges
//                               it, and re-runs UAT — repeating up to a fixed
//                               attempt cap.
//
// Acceptance and re-verification are a profile-baseline run INSIDE the worktree,
// not a `commandmate uat`/`verify` call (those subcommands do not exist, #1467).
// The only commandmate calls are `send <worktree-id> <message>` / `wait
// <worktree-id>` for the fix worker; its worktree id is derived from the fix
// branch (a freshly-created worktree is not yet in `ls`).
//
// Two invariants are non-negotiable:
//
//   1. The loop is bounded. It never runs more than --max-attempts fix attempts.
//      Reaching the cap with issues still failing UAT is reported as `blocked`
//      with the unresolved issues named — never rounded up to success.
//   2. Explicit approval. Without --approve the fix loop is a no-mutation preview:
//      it runs the read-only UAT assessment and reports what it WOULD repair, but
//      creates no worktree, dispatches no fix and re-merges nothing. A fix is
//      re-merged only when its re-verification passed (the verification gate is
//      inherited).
//
// The run artifact is append-only: each attempt is written to its own
// attempts/attempt-<n>/ directory and appended to attempts/history.jsonl. A
// prior attempt is never overwritten, and the output directory must not pre-exist.
//
// Every external command is injectable (--cli / --git / --gh) so the behavior can
// be exercised against a fake CLI without a real repository or the network.
// Tokens, secrets, absolute paths and raw terminal output are redacted before
// they reach the report or an artifact.

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SKILL_ID = 'cmate-orchestrate';
const SKILL_VERSION = '0.5.0';
const UAT_SCHEMA_VERSION = 1;
const SUPPORTED_PLAN_SCHEMA_VERSION = 1;
const SUPPORTED_DISPATCH_SCHEMA_VERSION = 1;

// A CommandMate worktree id (mirrors the CLI's isValidWorktreeId).
const WORKTREE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

// `commandmate wait` reports the worker's terminal state by EXIT CODE:
// 0 completed, 10 a prompt is awaiting input, 124 the --timeout elapsed.
const WAIT_EXIT_COMPLETED = 0;
const WAIT_EXIT_PROMPT = 10;
const WAIT_EXIT_TIMEOUT = 124;

// The bounded fix loop's cap. The default is small on purpose: repair is
// expensive and an unbounded loop is out of scope (#1456 non-goal). 1..5.
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS_CEILING = 5;

const DEFAULT_WAIT_TIMEOUT_SECONDS = 300;
const DEFAULT_POLL_LIMIT = 120;

class SkillError extends Error {
  constructor(code, detail, exitCode) {
    super(detail);
    this.code = code;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

// =============================================================================
// Redaction (mirrors the plan-core, dispatch and merge runners; shapes only)
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
// stored: a bounded tail is enough for a human to act on a failure.
function excerpt(value, limit = 280) {
  const text = redact(value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text || '';
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

const USAGE = `cmate-orchestrate UAT runner (acceptance assessment / bounded fix loop)

Usage:
  uat.mjs --plan <path> --dispatch <path> (--write-uat | --create-uat-fix-worktrees) [options]

Exactly one phase is enabled per invocation:
  --write-uat                 Run UAT once over the eligible issues and write the
                              report. Read-only: no worktree, no fix, no re-merge.
  --create-uat-fix-worktrees  Run the bounded fix loop: on a UAT failure, create a
                              fix worktree, dispatch a fix, re-verify, re-merge and
                              re-run UAT, up to --max-attempts times.

Options:
  --plan <path>          Approved plan.json from the plan-core runner (required).
  --dispatch <path>      dispatch-report.json from the dispatch runner (required);
                         its completed+verified workers are the only eligible issues.
  --approve              Explicit approval to actually mutate in the fix loop.
                         WITHOUT it the loop is a no-mutation preview.
  --max-attempts <1-${MAX_ATTEMPTS_CEILING}>    Fix-attempt cap (default ${DEFAULT_MAX_ATTEMPTS}). The loop never exceeds it;
                         reaching it with failures remaining is reported as blocked.
  --out <dir>            Where UAT artifacts are written (default: <dispatch-dir>/<phase>).
  --cli <path>           The commandmate CLI to drive (default "commandmate").
  --git <path>           The git CLI for base/worktree/re-merge (default "git").
  --gh <path>            The gh CLI for the repo-access preflight (default "gh").
  --wait-timeout <sec>   --timeout for the fix worker's commandmate wait (default ${DEFAULT_WAIT_TIMEOUT_SECONDS}).
  --poll-limit <n>       Retained for compatibility; wait now blocks (default ${DEFAULT_POLL_LIMIT}).
  --help                 Show this help.

The fix loop is always bounded and never rounds a cap-reached stop up to success;
nothing is mutated without --approve, and a fix is re-merged only after it re-verifies.`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        plan: { type: 'string' },
        dispatch: { type: 'string' },
        'write-uat': { type: 'boolean' },
        'create-uat-fix-worktrees': { type: 'boolean' },
        approve: { type: 'boolean' },
        'max-attempts': { type: 'string' },
        out: { type: 'string' },
        cli: { type: 'string' },
        git: { type: 'string' },
        gh: { type: 'string' },
        'wait-timeout': { type: 'string' },
        'poll-limit': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new SkillError('invalid_input', error.message, 3);
  }
  return parsed;
}

function positiveInt(raw, name, fallback, max) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) < 1) {
    throw new SkillError('invalid_input', `${name} must be a positive integer`, 3);
  }
  const value = Number.parseInt(raw, 10);
  if (max !== undefined && value > max) {
    throw new SkillError('invalid_input', `${name} must be at most ${max}`, 3);
  }
  return value;
}

function resolveInputs(parsed) {
  const { values } = parsed;

  // Exactly one phase — the core of the explicit-phase-flag design. Both or
  // neither is a hard input error, never a silent default.
  const phases = [];
  if (values['write-uat']) phases.push('write_uat');
  if (values['create-uat-fix-worktrees']) phases.push('fix_uat');
  if (phases.length !== 1) {
    throw new SkillError(
      'invalid_input',
      'exactly one phase must be enabled: pass either --write-uat or --create-uat-fix-worktrees (not both, not neither)',
      3,
    );
  }

  if (!values.plan) throw new SkillError('invalid_input', '--plan <path> is required', 3);
  if (!values.dispatch) throw new SkillError('invalid_input', '--dispatch <path> is required', 3);

  return {
    phase: phases[0],
    planPath: values.plan,
    dispatchPath: values.dispatch,
    approve: Boolean(values.approve),
    maxAttempts: positiveInt(values['max-attempts'], 'max-attempts', DEFAULT_MAX_ATTEMPTS, MAX_ATTEMPTS_CEILING),
    outDir: values.out ?? null,
    cli: values.cli ?? 'commandmate',
    git: values.git ?? 'git',
    gh: values.gh ?? 'gh',
    waitTimeout: positiveInt(values['wait-timeout'], 'wait-timeout', DEFAULT_WAIT_TIMEOUT_SECONDS),
    pollLimit: positiveInt(values['poll-limit'], 'poll-limit', DEFAULT_POLL_LIMIT),
  };
}

// =============================================================================
// Plan / dispatch-report loading (mirrors merge.mjs)
// =============================================================================

function loadJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SkillError('load_error', `cannot read ${what} at ${path}: ${redact(error.message)}`, 6);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SkillError('load_error', `${what} at ${path} is not valid JSON: ${redact(error.message)}`, 6);
  }
}

function validatePlan(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new SkillError('plan_invalid', 'plan must be a JSON object', 3);
  }
  if (plan.plan_schema_version !== SUPPORTED_PLAN_SCHEMA_VERSION) {
    throw new SkillError('plan_invalid', `unsupported plan_schema_version ${plan.plan_schema_version}; this runner understands ${SUPPORTED_PLAN_SCHEMA_VERSION}`, 3);
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
  if (!Array.isArray(plan.issues)) {
    throw new SkillError('plan_invalid', 'plan.issues is missing', 3);
  }
  return plan;
}

function validateDispatch(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new SkillError('dispatch_invalid', 'dispatch report must be a JSON object', 3);
  }
  if (report.dispatch_schema_version !== SUPPORTED_DISPATCH_SCHEMA_VERSION) {
    throw new SkillError('dispatch_invalid', `unsupported dispatch_schema_version ${report.dispatch_schema_version}; this runner understands ${SUPPORTED_DISPATCH_SCHEMA_VERSION}`, 3);
  }
  if (report.skill_id !== SKILL_ID) {
    throw new SkillError('dispatch_invalid', `dispatch report skill_id "${report.skill_id}" is not ${SKILL_ID}`, 3);
  }
  if (!Array.isArray(report.waves)) {
    throw new SkillError('dispatch_invalid', 'dispatch report has no waves', 3);
  }
  return report;
}

// The eligible set — the same verification gate the merge runner inherits: an
// issue is subjected to UAT (and repaired) ONLY when its worker completed AND its
// verification passed. Processed in the plan's merge order.
function eligibleIssues(plan, dispatch) {
  const passed = new Set();
  for (const wave of dispatch.waves) {
    for (const worker of wave.workers ?? []) {
      if (worker.worker_state === 'completed' && worker.verification && worker.verification.outcome === 'pass') {
        passed.add(worker.issue);
      }
    }
  }
  const order = Array.isArray(plan.merge_order) ? plan.merge_order : [];
  const ordered = order.filter((n) => passed.has(n));
  for (const n of [...passed].sort((a, b) => a - b)) {
    if (!ordered.includes(n)) ordered.push(n);
  }
  return ordered;
}

// =============================================================================
// Safety (branch and worktree targets; mirrors merge.mjs / dispatch.mjs)
// =============================================================================

function issueOf(plan, number) {
  return plan.issues.find((issue) => issue.number === number) ?? { number };
}

// A branch headed into `git worktree add -b` must be a plain ref: no whitespace,
// no shell metacharacter, no path escape.
function safeBranch(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^[A-Za-z0-9._\/-]+$/.test(value)) return null;
  if (value.includes('..')) return null;
  if (value.startsWith('/') || value.startsWith('-')) return null;
  return value;
}

// The worktree path comes from a verified profile template (e.g. "../repo-…"), so
// a single leading "../" to a sibling directory is legitimate. Anything that
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
// CLI invocation (mirrors merge.mjs / dispatch.mjs)
// =============================================================================

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

// The CommandMate worktree id for a branch, computed the way the CLI does
// (generateWorktreeId): lowercase, non [a-z0-9-] -> '-', collapse/trim hyphens,
// joined as `<repo>-<branch>`. Used for a freshly-created fix worktree, which is
// not yet in `ls`. Returns null when the result is not a valid id.
function deriveWorktreeId(repository, branch) {
  const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const repo = String(repository).split('/').pop() ?? '';
  const id = `${slug(repo)}-${slug(branch)}`;
  return WORKTREE_ID_RE.test(id) ? id : null;
}

// The acceptance/verification signal in the worktree-based model: run the profile
// baseline INSIDE a worktree (there is no `commandmate uat`/`verify`). Passes only
// when every baseline command exits zero. A missing worktree or any non-zero step
// is a fail. Returns { outcome, checks, note } where checks label the steps run.
function runBaseline(baseline, worktreePath) {
  if (!Array.isArray(baseline) || baseline.length === 0) {
    return { outcome: 'fail', checks: [], note: 'profile has no baseline to run' };
  }
  const checks = [];
  for (const command of baseline) {
    const argv = String(command).trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) continue;
    checks.push(redact(String(command)));
    const res = runCli(argv[0], argv.slice(1), { cwd: worktreePath });
    if (!res.ok) {
      return { outcome: 'fail', checks, note: excerpt(res.stderr || res.stdout || `baseline step failed: ${command}`) };
    }
  }
  return { outcome: 'pass', checks, note: '' };
}

// =============================================================================
// Preflight (read-only; mirrors merge's delivery-scoped drift re-check)
// =============================================================================

function preflight(inputs, plan) {
  const checks = [];
  const add = (code, ok, detail) => checks.push({ code, ok, blocking: true, detail });

  const cli = runCli(inputs.cli, ['--version']);
  add('cli_available', cli.ok, cli.ok ? 'commandmate CLI is runnable' : 'commandmate CLI is not runnable (permission or install)');

  const repo = runCli(inputs.gh, ['repo', 'view', plan.profile.repository, '--json', 'nameWithOwner']);
  add('repo_access', repo.ok, repo.ok ? `repo ${plan.profile.repository} is reachable` : `cannot reach repo ${plan.profile.repository} (permission)`);

  const base = runCli(inputs.git, ['rev-parse', '--verify', plan.profile.base]);
  add('base_resolvable', base.ok, base.ok ? `base ${plan.profile.base} resolves` : `base ${plan.profile.base} no longer resolves`);

  return checks;
}

// =============================================================================
// UAT assessment (read-only)
// =============================================================================

// Run acceptance for one issue by executing the profile baseline inside the
// worktree that currently holds its work (its dispatch worktree, or — after a
// fix landed — that fix's worktree). There is no `commandmate uat`; the acceptance
// signal is a real baseline run. A missing worktree or a non-zero step is a fail,
// never an optimistic pass.
function runUat(inputs, plan, number, worktreePath) {
  const baseline = runBaseline(plan.profile.baseline, worktreePath);
  return {
    issue: number,
    ran: true,
    report_schema_version: null,
    outcome: baseline.outcome,
    scenarios: baseline.checks,
    note: baseline.note,
  };
}

// =============================================================================
// Fix worktree (aligned with the cmate-worktree-setup result contract, #1448)
// =============================================================================

// Create one fix worktree for a failing issue: resolve the base ref to a commit
// SHA, then (only under --approve) create the branch and worktree from that SHA.
// An existing worktree is never implicitly overwritten — the per-attempt suffix
// keeps each attempt's target distinct. No absolute path is ever recorded.
function createFixWorktree(inputs, plan, number, attemptNo) {
  const issue = issueOf(plan, number);
  const branch = safeBranch(`${issue.branch ?? `feature/issue-${number}`}-uat-fix-${attemptNo}`);
  const directory = safeWorktreeTarget(`${issue.worktree ?? `../issue-${number}`}-uat-fix-${attemptNo}`);
  const record = {
    issue: number,
    branch: branch ?? String(issue.branch ?? `feature/issue-${number}`),
    directory: directory ?? `../issue-${number}-uat-fix-${attemptNo}`,
    base_sha: null,
    created: false,
    reused: false,
    note: '',
  };

  if (branch === null || directory === null) {
    record.note = 'fix branch or worktree target rejected by the safe-ref/path-escape guard';
    return record;
  }

  // Re-confirm the base as a resolved commit SHA before creating (the setup
  // contract's base_reconfirmed rule): a symbolic ref alone is never enough.
  const base = runCli(inputs.git, ['rev-parse', '--verify', plan.profile.base]);
  const sha = base.ok ? base.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    record.note = `base ${plan.profile.base} did not resolve to a commit SHA`;
    return record;
  }
  record.base_sha = sha;

  if (!inputs.approve) {
    record.note = `would create ${branch} from ${sha.slice(0, 8)} (preview; --approve to execute)`;
    return record;
  }

  const added = runCli(inputs.git, ['worktree', 'add', directory, '-b', branch, sha]);
  record.created = added.ok;
  record.note = added.ok ? `created fix worktree from ${sha.slice(0, 8)}` : excerpt(added.stderr || added.stdout || 'git worktree add failed');
  return record;
}

// =============================================================================
// Fix dispatch (self-contained fix prompt; send / wait / verify)
// =============================================================================

function bullets(items, fallback) {
  if (!Array.isArray(items) || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${redact(String(item))}`).join('\n');
}

function buildFixPrompt(plan, issue, failingScenarios) {
  return [
    `# UAT fix task — issue #${issue.number}`,
    '',
    `Repository: ${plan.profile.repository}`,
    `Base branch: ${plan.profile.base}`,
    '',
    '## What failed',
    'User acceptance testing failed for this issue after it was merged. Repair it so',
    'the acceptance scenarios below pass, without regressing the original objective.',
    '',
    '## Failing acceptance scenarios',
    bullets(failingScenarios, 'The UAT report did not name a scenario; reproduce the acceptance check and fix the failure.'),
    '',
    '## Objective (unchanged)',
    redact(issue.objective ?? issue.title ?? `Resolve issue #${issue.number}.`),
    '',
    '## Acceptance criteria',
    bullets(issue.acceptance_criteria, 'See the issue.'),
    '',
    '## Verification to run before reporting done',
    bullets(plan.profile.baseline, 'Run the repository baseline, then the acceptance scenarios above.'),
    '',
    '## Rules',
    '- Stay within this issue. Do not modify files another issue in the plan owns.',
    '- Run the verification above and report its real result. Do not report done on a failing check.',
    '- If a step is destructive, ambiguous, or blocked, STOP and ask. Do not guess.',
    '- Do not print tokens, secrets, or absolute host paths.',
  ].join('\n');
}

function dispatchFix(inputs, plan, number, fixBranch, worktreeDir, message) {
  const fix = {
    issue: number,
    task_id: null,
    dispatched: false,
    worker_state: 'not_dispatched',
    verification: { ran: false, report_schema_version: null, outcome: 'not_run', checks: [] },
    note: '',
  };

  // The fix worktree was just created, so it is not yet in `ls`; derive its
  // CommandMate id from the fix branch (the id the CLI would assign it).
  const worktreeId = deriveWorktreeId(plan.profile.repository, fixBranch);
  if (worktreeId === null) {
    fix.worker_state = 'failed';
    fix.note = 'could not derive a valid worktree id for the fix branch';
    return fix;
  }
  fix.task_id = worktreeId;

  const sent = runCli(inputs.cli, ['send', worktreeId, message]);
  if (!sent.ok) {
    fix.worker_state = 'failed';
    fix.note = redact(`fix dispatch failed: ${excerpt(sent.stderr || sent.stdout || 'send failed')}`);
    return fix;
  }
  fix.dispatched = true;

  // Supervise with a single blocking wait (the fix loop does not auto-answer
  // prompts; a prompt is a non-completion that stops the loop). State is the
  // process exit code.
  const waited = runCli(inputs.cli, ['wait', worktreeId, '--timeout', String(inputs.waitTimeout)]);
  let state;
  let note;
  if (waited.ok) { state = 'completed'; note = ''; }
  else if (waited.status === WAIT_EXIT_PROMPT) { state = 'prompt'; note = 'fix worker raised a prompt; the loop does not auto-answer'; }
  else if (waited.status === WAIT_EXIT_TIMEOUT) { state = 'timeout'; note = `wait timed out after ${inputs.waitTimeout}s`; }
  else { state = 'failed'; note = excerpt(waited.stderr || waited.stdout || `wait exited ${waited.status ?? 'with an error'}`); }
  fix.worker_state = state;
  fix.note = redact(note);
  if (state !== 'completed') return fix;

  // Re-verify: worker completion got us here; the profile baseline re-run inside
  // the fix worktree is the separate gate it must clear before it may be re-merged.
  const baseline = runBaseline(plan.profile.baseline, worktreeDir);
  fix.verification = { ran: true, report_schema_version: null, outcome: baseline.outcome, checks: baseline.checks };
  if (baseline.note) fix.note = fix.note ? `${fix.note}; ${redact(baseline.note)}` : redact(baseline.note);
  return fix;
}

// =============================================================================
// Re-merge (guarded: only re-verified fixes are re-merged)
// =============================================================================

function runRemerge(inputs, plan, issues, attemptNo) {
  const remerge = { attempted_issues: issues.slice(), merged_issues: [], outcome: 'skipped', note: '' };
  if (issues.length === 0) {
    remerge.outcome = 'skipped';
    remerge.note = 'no re-verified fix to re-merge';
    return remerge;
  }
  for (const number of issues) {
    const issue = issueOf(plan, number);
    const branch = safeBranch(`${issue.branch ?? `feature/issue-${number}`}-uat-fix-${attemptNo}`);
    if (branch === null) {
      remerge.outcome = 'conflict';
      remerge.note = `#${number}: fix branch rejected by the safe-ref guard`;
      return remerge;
    }
    const merged = runCli(inputs.git, ['merge', '--no-ff', '--no-edit', branch]);
    if (!merged.ok) {
      remerge.outcome = 'conflict';
      remerge.note = redact(`#${number}: re-merge failed (${excerpt(merged.stderr || merged.stdout || 'merge conflict')})`);
      return remerge;
    }
    remerge.merged_issues.push(number);
  }
  remerge.outcome = 'merged';
  remerge.note = `re-merged ${remerge.merged_issues.map((n) => `#${n}`).join(', ')}`;
  return remerge;
}

// =============================================================================
// Report assembly
// =============================================================================

function halt(report, status, stopReason, code, detail) {
  // The first blocking condition wins the status/stop_reason; later ones only
  // add to blocking_reasons.
  if (report.status === 'success') {
    report.status = status;
    report.stop_reason = stopReason;
  }
  report.blocking_reasons.push({ code, detail });
}

function baseReport(inputs, plan, eligible, outDir) {
  return {
    uat_schema_version: UAT_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    phase: inputs.phase,
    status: 'success',
    stop_reason: 'completed',
    approved: inputs.approve,
    mutated: false,
    plan_run_id: plan.run_id,
    out_dir: outDir,
    max_attempts: inputs.maxAttempts,
    attempts_used: 0,
    profile: {
      id: String(plan.profile.id ?? 'unknown'),
      repository: plan.profile.repository,
      base: plan.profile.base,
      verified: plan.profile.verified === true,
    },
    eligible_issues: eligible.slice(),
    preflight: [],
    attempts: [],
    unresolved_issues: [],
    blocking_reasons: [],
    limitations: [],
    redactions: [],
    next_actions: [],
    completion_check: { passed: false, checks: [] },
    summary_markdown: '',
  };
}

// Append one attempt to the history: push it into the report and append a line
// to attempts/history.jsonl. A prior attempt is never rewritten.
function appendAttempt(report, attempt, historyPath) {
  report.attempts.push(attempt);
  try {
    appendFileSync(historyPath, `${JSON.stringify(attempt)}\n`, 'utf8');
  } catch {
    // A history-logging failure must not change the loop's outcome.
  }
}

// =============================================================================
// Phase: write_uat (read-only assessment, one pass)
// =============================================================================

function runWriteUat(inputs, plan, eligible, outDir, report) {
  const attemptsRoot = join(outDir, 'attempts');
  mkdirSync(attemptsRoot, { recursive: true });
  const historyPath = join(attemptsRoot, 'history.jsonl');

  const uatResults = eligible.map((n) => runUat(inputs, plan, n, issueOf(plan, n).worktree));
  const failing = eligible.filter((n) => uatResults.find((u) => u.issue === n).outcome !== 'pass');
  const attempt = {
    index: 0,
    kind: 'assess',
    fix_performed: false,
    uat_results: uatResults,
    failing_issues: failing.slice(),
    worktrees: [],
    fixes: [],
    remerge: null,
    advanced: failing.length === 0,
  };
  appendAttempt(report, attempt, historyPath);

  if (failing.length > 0) {
    report.unresolved_issues = failing.slice();
    halt(report, 'partial', 'uat_failed', 'uat_failed', `UAT failed for ${failing.map((n) => `#${n}`).join(', ')}`);
    report.next_actions.push({
      action: `run --create-uat-fix-worktrees --approve to repair ${failing.map((n) => `#${n}`).join(', ')}`,
      owner: 'operator',
    });
  }
}

// =============================================================================
// Phase: fix_uat (bounded fix loop)
// =============================================================================

function runFixLoop(inputs, plan, eligible, outDir, report) {
  const attemptsRoot = join(outDir, 'attempts');
  mkdirSync(attemptsRoot, { recursive: true });
  const historyPath = join(attemptsRoot, 'history.jsonl');

  let target = eligible.slice();
  let fixCount = 0;
  let iteration = 0;

  // Each issue is assessed in the worktree that currently holds its work: its
  // dispatch worktree initially, and — once a fix re-verifies and re-merges — that
  // fix's worktree, so the next assessment reflects the repair.
  const worktreeOf = new Map(eligible.map((n) => [n, issueOf(plan, n).worktree]));

  while (true) {
    const attemptDir = join(attemptsRoot, `attempt-${iteration}`);
    mkdirSync(attemptDir, { recursive: true });

    // 1. Assess: re-run the profile baseline (the acceptance signal) in each
    //    target's current worktree. Read-only, so it runs in a preview too — the
    //    difference is that a preview never fixes.
    const uatResults = target.map((n) => runUat(inputs, plan, n, worktreeOf.get(n)));
    const failing = target.filter((n) => uatResults.find((u) => u.issue === n).outcome !== 'pass');

    const attempt = {
      index: iteration,
      kind: 'assess',
      fix_performed: false,
      uat_results: uatResults,
      failing_issues: failing.slice(),
      worktrees: [],
      fixes: [],
      remerge: null,
      advanced: failing.length === 0,
    };

    // 2. UAT passed for every target → success.
    if (failing.length === 0) {
      appendAttempt(report, attempt, historyPath);
      report.unresolved_issues = [];
      break;
    }

    // 3. Preview (no approve): the assessment found failures; report the repair
    //    scope and stop. No worktree, no fix, no re-merge — nothing is mutated.
    if (!inputs.approve) {
      attempt.remerge = { attempted_issues: [], merged_issues: [], outcome: 'not_attempted', note: 'preview: --approve to run the fix loop' };
      appendAttempt(report, attempt, historyPath);
      report.unresolved_issues = failing.slice();
      halt(report, 'partial', 'uat_failed', 'uat_failed_preview', `UAT failed for ${failing.map((n) => `#${n}`).join(', ')}; would run the fix loop (preview; --approve to execute)`);
      report.next_actions.push({ action: 're-run with --approve to create fix worktrees and repair', owner: 'operator' });
      break;
    }

    // 4. Cap reached with failures remaining → blocked. The loop never exceeds
    //    max_attempts, and a cap-reached stop is never rounded up to success.
    if (fixCount >= inputs.maxAttempts) {
      appendAttempt(report, attempt, historyPath);
      report.unresolved_issues = failing.slice();
      report.status = 'blocked';
      report.stop_reason = 'max_attempts_reached';
      report.blocking_reasons.push({
        code: 'max_attempts_reached',
        detail: `UAT still failing for ${failing.map((n) => `#${n}`).join(', ')} after ${inputs.maxAttempts} fix attempt(s); stopping as blocked`,
      });
      report.next_actions.push({
        action: `manual triage: the bounded fix loop could not make ${failing.map((n) => `#${n}`).join(', ')} pass UAT within ${inputs.maxAttempts} attempt(s)`,
        owner: 'human',
      });
      break;
    }

    // 5. Perform a fix attempt (mutation, gated above by --approve).
    fixCount += 1;
    attempt.kind = 'fix';
    attempt.fix_performed = true;
    report.mutated = true;

    // 5a. Create a fix worktree per failing issue.
    let hardStop = false;
    for (const number of failing) {
      const wt = createFixWorktree(inputs, plan, number, fixCount);
      attempt.worktrees.push(wt);
      if (!wt.created) {
        halt(report, 'partial', 'worktree_failed', 'worktree_failed', `#${number}: fix worktree could not be created (${wt.note})`);
        hardStop = true;
      }
    }
    if (hardStop) {
      appendAttempt(report, attempt, historyPath);
      report.unresolved_issues = failing.slice();
      break;
    }

    // 5b. Dispatch a fix worker per failing issue, then re-verify (baseline in
    //     the fix worktree). A fix worker that never COMPLETES is a hard stop
    //     (it broke mid-flight); a worker that completes but whose baseline still
    //     fails is a failed attempt that the loop retries until the cap.
    for (const number of failing) {
      const wt = attempt.worktrees.find((w) => w.issue === number);
      const issue = issueOf(plan, number);
      const failingScenarios = attempt.uat_results.find((u) => u.issue === number)?.scenarios ?? [];
      const promptFile = join(attemptDir, `fix-issue-${number}.md`);
      const message = buildFixPrompt(plan, issue, failingScenarios);
      writeFileSync(promptFile, `${message}\n`, 'utf8');
      const fix = dispatchFix(inputs, plan, number, wt.branch, wt.directory, message);
      attempt.fixes.push(fix);
    }
    const brokenWorker = attempt.fixes.find((f) => f.worker_state !== 'completed');
    if (brokenWorker) {
      appendAttempt(report, attempt, historyPath);
      report.unresolved_issues = failing.slice();
      halt(report, 'partial', 'fix_failed', 'fix_failed', `#${brokenWorker.issue}: fix worker did not complete; stopping before re-merge`);
      report.next_actions.push({ action: `diagnose the fix worktree for #${brokenWorker.issue} and repair manually`, owner: 'operator' });
      break;
    }

    // 5c. Re-merge only the fixes whose baseline re-verified. A fix whose baseline
    //     still fails did not land: it is not merged, and its issue stays failing.
    const reverified = attempt.fixes.filter((f) => f.verification.outcome === 'pass').map((f) => f.issue);
    const remerge = runRemerge(inputs, plan, reverified, fixCount);
    attempt.remerge = remerge;
    if (remerge.outcome === 'conflict') {
      appendAttempt(report, attempt, historyPath);
      report.unresolved_issues = failing.slice();
      halt(report, 'partial', 'remerge_failed', 'remerge_failed', `re-merge failed: ${remerge.note}`);
      report.next_actions.push({ action: 'resolve the re-merge conflict and re-run', owner: 'operator' });
      break;
    }

    // 5d. A re-verified+re-merged issue is now assessed against its fix worktree,
    //     so the next assessment reflects the repair; the rest retry from theirs.
    for (const number of reverified) {
      worktreeOf.set(number, attempt.worktrees.find((w) => w.issue === number).directory);
    }
    appendAttempt(report, attempt, historyPath);
    target = failing.slice();
    iteration += 1;
  }

  report.attempts_used = fixCount;
}

// =============================================================================
// Completion check
// =============================================================================

function buildCompletionCheck(report, inputs) {
  const eligibleSet = new Set(report.eligible_issues);
  const uatTargetsEligible = report.attempts.every((a) => a.uat_results.every((u) => eligibleSet.has(u.issue)));
  const remergeGated = report.attempts.every((a) =>
    (a.remerge?.merged_issues ?? []).every((n) => a.fixes.find((f) => f.issue === n)?.verification.outcome === 'pass'),
  );
  const hasUnresolved = report.unresolved_issues.length > 0;

  const checks = [
    {
      id: 'single_phase',
      passed: report.phase === 'write_uat' || report.phase === 'fix_uat',
      detail: `exactly one phase was enabled (${report.phase})`,
    },
    {
      id: 'approval_enforced',
      passed: !report.mutated || report.approved,
      detail: report.mutated ? 'a mutation ran and it was explicitly approved' : 'no mutation ran without --approve',
    },
    {
      id: 'attempts_bounded',
      passed: report.attempts_used <= report.max_attempts,
      detail: `${report.attempts_used} fix attempt(s) used of a ${report.max_attempts} cap`,
    },
    {
      id: 'blocked_reported',
      passed: report.status === 'blocked'
        ? (hasUnresolved && report.stop_reason === 'max_attempts_reached')
        : report.stop_reason !== 'max_attempts_reached',
      detail: report.status === 'blocked'
        ? 'the cap was reached with failures remaining and the status is blocked (not rounded up)'
        : 'the run did not reach the attempt cap',
    },
    {
      id: 'verification_gated',
      passed: uatTargetsEligible && remergeGated,
      detail: 'every UAT target was a verification-passed issue, and every re-merged fix had re-verified',
    },
  ];
  const passed = checks.every((c) => c.passed) && report.status !== 'failure';
  return { passed, checks };
}

// =============================================================================
// Summary
// =============================================================================

function renderSummary(report) {
  const lines = [];
  const phaseLabel = report.phase === 'write_uat' ? 'UAT 実行（assess）' : 'UAT 修正ループ';
  const verb = report.status === 'success' ? '完了'
    : report.status === 'partial' ? '途中停止'
    : report.status === 'blocked' ? '上限到達で停止（blocked）'
    : '未実行';
  lines.push('## 対象と結論');
  lines.push(`${phaseLabel}（${report.approved ? '承認あり' : 'preview'}）を ${report.profile.repository} で実行: ${report.status}（${verb}, stop=${report.stop_reason}）。`);
  if (report.status === 'blocked') lines.push(`fix 上限 ${report.max_attempts} 回に到達しても UAT が通らなかったため blocked とした（成功に丸めない）。`);
  if (!report.approved && report.phase === 'fix_uat') lines.push('明示承認（--approve）が無いため mutation はしていない（preview）。');
  lines.push('');
  lines.push('## eligible（verification pass 済み）');
  lines.push(report.eligible_issues.length ? `- ${report.eligible_issues.map((n) => `#${n}`).join(', ')}` : '- なし（verification pass した Issue が無い）。');
  lines.push('');
  lines.push('## attempt 履歴');
  if (report.attempts.length === 0) {
    lines.push('- attempt なし。');
  } else {
    for (const a of report.attempts) {
      const uat = a.uat_results.map((u) => `#${u.issue}=${u.outcome}`).join(', ') || 'なし';
      const fix = a.fix_performed ? ` / fix=${a.fixes.map((f) => `#${f.issue}:${f.worker_state}/${f.verification.outcome}`).join(', ')}` : '';
      const rem = a.remerge && a.remerge.outcome !== 'not_attempted' ? ` / re-merge=${a.remerge.outcome}` : '';
      lines.push(`- attempt ${a.index} (${a.kind}): UAT ${uat}${fix}${rem}`);
    }
  }
  lines.push('');
  lines.push('## preflight');
  for (const c of report.preflight) lines.push(`- ${c.code}: ${c.ok ? 'ok' : 'NG'}`);
  lines.push('');
  lines.push('## 未解決と next action');
  if (report.unresolved_issues.length === 0 && report.blocking_reasons.length === 0) {
    lines.push('- なし。全 eligible が UAT を通過した。');
  } else {
    if (report.unresolved_issues.length > 0) lines.push(`- 未解決（UAT 未通過）: ${report.unresolved_issues.map((n) => `#${n}`).join(', ')}`);
    for (const r of report.blocking_reasons) lines.push(`- blocking: ${r.code} — ${r.detail}`);
    for (const l of report.limitations) lines.push(`- limitation: ${l.code} — ${l.detail}`);
    for (const n of report.next_actions) lines.push(`- next: ${n.action}（owner: ${n.owner}）`);
  }
  return lines.join('\n');
}

// =============================================================================
// Orchestration
// =============================================================================

function runUatPhase(inputs, plan, dispatch, outDir) {
  const eligible = eligibleIssues(plan, dispatch);
  const report = baseReport(inputs, plan, eligible, outDir);

  // Read-only preflight before any mutation.
  report.preflight = preflight(inputs, plan);
  const blocked = report.preflight.find((c) => c.blocking && !c.ok);
  if (blocked) {
    halt(report, 'failure', 'preflight_failed', `preflight_${blocked.code}`, blocked.detail);
    report.next_actions.push({ action: 'restore commandmate availability, repo access and base resolution, then re-run', owner: 'operator' });
    finalize(report, inputs);
    return report;
  }

  if (eligible.length === 0) {
    report.limitations.push({ code: 'no_eligible_issues', detail: 'the dispatch report has no completed-and-verified issue; nothing to UAT' });
    finalize(report, inputs);
    return report;
  }

  if (inputs.phase === 'write_uat') {
    runWriteUat(inputs, plan, eligible, outDir, report);
  } else {
    runFixLoop(inputs, plan, eligible, outDir, report);
  }

  finalize(report, inputs);
  return report;
}

function finalize(report, inputs) {
  report.completion_check = buildCompletionCheck(report, inputs);
  if (!report.completion_check.passed && report.status === 'success') {
    report.status = 'partial';
    report.limitations.push({ code: 'completion_check_failed', detail: 'a completion check did not pass; see completion_check' });
  }
  // A non-success outcome always carries at least one next action, even on a
  // path that did not add a specific one.
  if (report.status !== 'success' && report.next_actions.length === 0) {
    report.next_actions.push({ action: `resolve "${report.stop_reason}" and re-run`, owner: 'operator' });
  }
  report.redactions = redactionsList();
  report.summary_markdown = renderSummary(report);
}

// =============================================================================
// Failure envelope
// =============================================================================

function uatFailure(error, phase) {
  const report = {
    uat_schema_version: UAT_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    phase: phase ?? 'write_uat',
    status: 'failure',
    stop_reason: 'runner_error',
    approved: false,
    mutated: false,
    plan_run_id: 'unknown',
    out_dir: null,
    max_attempts: DEFAULT_MAX_ATTEMPTS,
    attempts_used: 0,
    profile: { id: 'unknown', repository: 'unknown/unknown', base: 'unknown', verified: false },
    eligible_issues: [],
    preflight: [],
    attempts: [],
    unresolved_issues: [],
    blocking_reasons: [{ code: error.code, detail: redact(error.detail ?? error.message) }],
    limitations: [],
    redactions: redactionsList(),
    next_actions: [{ action: 'fix the invocation or inputs and re-run', owner: 'operator' }],
    completion_check: { passed: false, checks: [] },
    summary_markdown: `## 対象と結論\nUAT runner 失敗（${error.code}）。${redact(error.detail ?? error.message)}`,
  };
  report.completion_check = buildCompletionCheck(report, { phase: report.phase });
  return report;
}

// =============================================================================
// Entry point
// =============================================================================

function run(argv) {
  const parsed = parseCli(argv);
  if (parsed.values.help) {
    process.stderr.write(`${USAGE}\n`);
    return { exitCode: 0, stdout: null };
  }

  const inputs = resolveInputs(parsed);
  const plan = validatePlan(loadJson(inputs.planPath, 'plan'));
  const dispatch = validateDispatch(loadJson(inputs.dispatchPath, 'dispatch report'));

  const defaultOut = join(dirname(inputs.dispatchPath), inputs.phase === 'write_uat' ? 'write-uat' : 'uat-fix');
  const outDir = inputs.outDir ?? defaultOut;
  if (existsSync(outDir)) {
    throw new SkillError('out_exists', `UAT directory ${outDir} already exists; refusing to overwrite`, 4);
  }
  mkdirSync(outDir, { recursive: true });

  const report = runUatPhase(inputs, plan, dispatch, outDir);
  writeFileSync(join(outDir, 'uat-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'uat-summary.md'), `${report.summary_markdown}\n`, 'utf8');

  process.stderr.write(`wrote UAT artifacts to ${outDir}\n`);
  const exitCode = report.status === 'success' ? 0
    : report.status === 'partial' ? 7
    : report.status === 'blocked' ? 8
    : 1;
  return { exitCode, stdout: `${JSON.stringify(report, null, 2)}\n` };
}

function main() {
  const argv = process.argv.slice(2);
  // Recover the phase for the failure envelope even when arg parsing failed.
  const phaseGuess = argv.includes('--create-uat-fix-worktrees') && !argv.includes('--write-uat') ? 'fix_uat' : 'write_uat';
  try {
    const { exitCode, stdout } = run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      const report = uatFailure(error, phaseGuess);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`error [${error.code}]: ${redact(error.detail ?? error.message)}\n`);
      process.exit(error.exitCode ?? 1);
    }
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

main();
