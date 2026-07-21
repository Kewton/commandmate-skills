#!/usr/bin/env node
// cmate-orchestrate — dispatch and supervision runner (Node stdlib only, Node >= 22).
//
// This runner does the *execution* half of official CommandMate issue
// orchestration. It takes an already-approved plan produced by the plan-core
// runner (scripts/orchestrate.mjs) and drives it, wave by wave, against the
// public `commandmate` CLI:
//
//   - it builds a self-contained, generic worker prompt from the plan (it does
//     not depend on a repository-local worker Skill) and dispatches it with
//     `commandmate send`;
//   - it supervises each worker with `commandmate wait` / `capture`, and when a
//     worker raises a prompt it STOPS and presents it to a human — it never
//     auto-answers (Auto Yes is off by default);
//   - it enforces a wave barrier: the next wave dispatches only when every
//     worker of the previous wave completed AND a versioned verification report
//     passed for each of them. Worker completion and verification success are
//     kept strictly separate;
//   - it honors max_parallel (1-3): a wave is never wider than the bound;
//   - before every mutating wave it re-checks post-plan drift
//     (branch / HEAD / worktree / permission) and refuses to dispatch on drift.
//
// The CLI surface it shells out to is documented in
// references/dispatch-contract.md. Every external command is injectable
// (--cli / --git / --gh) so the behavior can be exercised against a fake CLI
// without touching a real repository. Tokens, secrets, absolute paths and raw
// terminal output are redacted before they reach the report or an artifact.

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SKILL_ID = 'cmate-orchestrate';
const SKILL_VERSION = '0.2.0';
const DISPATCH_SCHEMA_VERSION = 1;
const SUPPORTED_PLAN_SCHEMA_VERSION = 1;

// The verification report version this runner understands. A worker that
// reports a different version is treated as an unverified worker, never as a
// pass — an unknown verification shape must never open the next-wave gate.
const SUPPORTED_VERIFICATION_REPORT_VERSION = 1;

const MAX_PARALLEL_MAX = 3;

// How many times a single worker is polled with `commandmate wait` before it is
// declared timed out. Each poll passes --timeout to the CLI, so the real bound
// is per-poll-timeout * poll-limit. Kept finite so the loop always terminates.
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
  --wait-timeout <sec>   Per-poll timeout passed to commandmate wait (default ${DEFAULT_WAIT_TIMEOUT_SECONDS}).
  --poll-limit <n>       Max wait polls per worker before timeout (default ${DEFAULT_POLL_LIMIT}).
  --help                 Show this help.

The dispatch runner mutates: it sends work to real workers. It refuses to
dispatch on post-plan drift and never answers a worker prompt on its own.`;

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

// =============================================================================
// Drift re-check (branch / HEAD / worktree / permission)
// =============================================================================

// Re-run before every wave. `blocking` checks that fail stop the dispatch;
// non-blocking failures are recorded as limitations so the operator sees them
// without the run stalling on something a just-in-time setup step will fix.
function driftChecks(inputs, plan, waveIndex, worktreeTargets) {
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
  const missing = worktreeTargets.filter((target) => !registered.includes(target.replace(/^\.\.\//, '')));
  const present = missing.length === 0;
  add('worktrees_present', present, false, present ? 'planned worktrees are registered' : `${missing.length} planned worktree(s) not yet registered`);

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
    '- If a step is destructive, ambiguous, or blocked, STOP and ask. Do not guess.',
    '- Do not print tokens, secrets, or absolute host paths.',
  ].join('\n');
}

// =============================================================================
// Supervision primitives
// =============================================================================

function dispatchWorker(inputs, worktreeTarget, promptFile) {
  const result = runCli(inputs.cli, ['send', '--json', '--worktree', worktreeTarget, '--prompt-file', promptFile]);
  const payload = parseCliJson(result);
  if (!payload || typeof payload.task_id !== 'string' || payload.task_id.length === 0) {
    return { taskId: null, error: excerpt(result.stderr || result.stdout || 'send returned no task id') };
  }
  return { taskId: payload.task_id, error: null };
}

// Poll `commandmate wait` until the worker reaches a terminal state (completed /
// failed) or raises a prompt, or the poll budget is exhausted (timeout). A
// prompt is returned as its own state — it is never answered here.
function superviseWorker(inputs, taskId) {
  for (let poll = 0; poll < inputs.pollLimit; poll += 1) {
    const result = runCli(inputs.cli, ['wait', '--json', '--task', taskId, '--timeout', String(inputs.waitTimeout)]);
    const payload = parseCliJson(result);
    if (!payload || typeof payload.state !== 'string') {
      return { state: 'failed', note: excerpt(result.stderr || result.stdout || 'wait returned no state') };
    }
    const state = payload.state;
    if (state === 'completed') return { state: 'completed', note: '' };
    if (state === 'failed') return { state: 'failed', note: excerpt(payload.detail ?? 'worker reported failure') };
    if (state === 'prompt') return { state: 'prompt', note: '' };
    // Any other value (e.g. "running") means keep waiting.
  }
  return { state: 'timeout', note: `no terminal state after ${inputs.pollLimit} poll(s)` };
}

function capturePrompt(inputs, taskId) {
  const result = runCli(inputs.cli, ['capture', '--json', '--task', taskId]);
  const payload = parseCliJson(result);
  const raw = payload?.prompt ?? payload?.excerpt ?? result.stdout ?? '';
  return excerpt(raw) ?? 'a prompt is awaiting input';
}

// A versioned verification report. Worker completion got us here; this is the
// second, independent gate. An unknown report version or a missing outcome is
// treated as "not a pass" — never optimistically opened.
function verifyWorker(inputs, worktreeTarget, taskId) {
  const result = runCli(inputs.cli, ['verify', '--json', '--worktree', worktreeTarget, '--task', taskId]);
  const payload = parseCliJson(result);
  if (!payload) {
    return { ran: true, report_schema_version: null, outcome: 'fail', checks: [], note: excerpt(result.stderr || 'verify returned no report') };
  }
  const version = Number.isInteger(payload.report_schema_version) ? payload.report_schema_version : null;
  if (version !== SUPPORTED_VERIFICATION_REPORT_VERSION) {
    return { ran: true, report_schema_version: version, outcome: 'fail', checks: [], note: `unsupported verification report version ${version}` };
  }
  const outcome = payload.outcome === 'pass' ? 'pass' : 'fail';
  const checks = Array.isArray(payload.checks) ? payload.checks.map((c) => redact(String(c))) : [];
  return { ran: true, report_schema_version: version, outcome, checks, note: '' };
}

function respondWorker(inputs, taskId) {
  // Only ever reached when --auto-yes is explicitly set. A generic affirmative;
  // the default path never calls this, which is what keeps prompt handling
  // human-in-the-loop.
  const result = runCli(inputs.cli, ['respond', '--json', '--task', taskId, '--input', 'yes']);
  return result.ok;
}

// =============================================================================
// The supervision loop
// =============================================================================

function runDispatch(inputs, plan, outDir) {
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
    const worktreeTargets = waveIssues.map((number) => {
      const issue = issueOf(plan, number);
      return issue.worktree_id ?? issue.worktree ?? '';
    });

    // 1. Drift re-check before this (mutating) wave.
    const checks = driftChecks(inputs, plan, waveIndex, worktreeTargets);
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

    // 3. Dispatch every issue in the wave, then supervise each to a terminal
    //    state or a prompt.
    const workers = [];
    for (const number of toDispatch) {
      const issue = issueOf(plan, number);
      const rawTarget = issue.worktree_id ?? issue.worktree ?? '';
      const target = safeWorktreeTarget(rawTarget);
      const worker = {
        issue: number,
        task_id: null,
        worker_state: 'not_dispatched',
        verification: { ran: false, report_schema_version: null, outcome: 'not_run', checks: [] },
        prompt: { detected: false, excerpt: null },
        note: '',
      };
      if (target === null) {
        worker.note = redact(`refused unsafe worktree target for #${number}`);
        report.limitations.push({ code: 'unsafe_worktree_target', detail: `#${number}: worktree target rejected by path-escape guard` });
        workers.push(worker);
        continue;
      }

      const promptFile = join(promptsDir, `issue-${number}.md`);
      writeFileSync(promptFile, `${buildWorkerPrompt(plan, issue)}\n`, 'utf8');

      const sent = dispatchWorker(inputs, target, promptFile);
      if (sent.taskId === null) {
        worker.worker_state = 'failed';
        worker.note = redact(`dispatch failed: ${sent.error}`);
        workers.push(worker);
        continue;
      }
      worker.task_id = sent.taskId;

      const supervised = superviseWorker(inputs, sent.taskId);
      worker.worker_state = supervised.state;
      worker.note = redact(supervised.note);
      if (supervised.state === 'prompt') {
        worker.prompt = { detected: true, excerpt: capturePrompt(inputs, sent.taskId) };
        if (inputs.autoYes) {
          autoResponded = true;
          respondWorker(inputs, sent.taskId);
          worker.note = 'auto-yes responded; re-supervising';
          const again = superviseWorker(inputs, sent.taskId);
          worker.worker_state = again.state;
        }
      }
      workers.push(worker);
    }

    // 4. Wave barrier — every dispatched worker must have completed.
    const allCompleted = workers.length > 0 && workers.every((worker) => worker.worker_state === 'completed');

    // 5. Verification gate — only completed workers are verified, and every one
    //    must produce a passing versioned report. Worker completion alone does
    //    not open this gate.
    let allVerified = allCompleted;
    if (allCompleted) {
      for (const worker of workers) {
        const target = safeWorktreeTarget(issueOf(plan, worker.issue).worktree_id ?? issueOf(plan, worker.issue).worktree ?? '');
        const verification = verifyWorker(inputs, target, worker.task_id);
        worker.verification = {
          ran: verification.ran,
          report_schema_version: verification.report_schema_version,
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

function run(argv) {
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

  const report = runDispatch(inputs, plan, outDir);
  writeFileSync(join(outDir, 'dispatch-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'dispatch-summary.md'), `${report.summary_markdown}\n`, 'utf8');

  process.stderr.write(`wrote dispatch artifacts to ${outDir}\n`);
  const exitCode = report.status === 'success' ? 0 : report.status === 'partial' ? 7 : 1;
  return { exitCode, stdout: `${JSON.stringify(report, null, 2)}\n` };
}

function main() {
  const argv = process.argv.slice(2);
  try {
    const { exitCode, stdout } = run(argv);
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
