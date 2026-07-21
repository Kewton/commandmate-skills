#!/usr/bin/env node
// cmate-orchestrate — PR creation, CI confirmation and guarded merge runner
// (Node stdlib only, Node >= 22).
//
// This runner does the *delivery* half of official CommandMate issue
// orchestration. It runs after the dispatch runner (scripts/dispatch.mjs) has
// executed a plan and produced a dispatch report; it takes that report plus the
// approved plan and, for the issues whose worker completed AND whose
// verification passed, performs exactly ONE mutating phase per invocation:
//
//   --create-prs : push each verification-passed branch and open a PR for it.
//   --merge-prs  : discover each PR, confirm its CI, and — only if CI passed —
//                  merge it (a guarded merge).
//
// Two gates are non-negotiable, mirroring the CommandAgent explicit-phase-flag
// design (ADR #1447):
//
//   1. Explicit approval. Without --approve the phase is a no-mutation preview:
//      it reports what it WOULD do (and, for merge, what CI says) but pushes,
//      creates and merges nothing. A PR is never created and a PR is never
//      merged without --approve.
//   2. CI pass. A PR is merged only when its versioned CI checks are all green.
//      A red or still-pending CI blocks the merge; it is never overridden.
//
// A create failure, a red/pending CI, a missing PR, or a merge conflict stops
// the phase and is reported as `partial` with the blocking reason recorded — a
// failure is never rounded up to success. UAT repair (#1456) and issue editing
// are out of scope and are not attempted here.
//
// Every external command is injectable (--gh / --git) so the behavior can be
// exercised against a fake GitHub CLI without a real repository or the network.
// Tokens, secrets, absolute paths and raw terminal output are redacted before
// they reach the report or an artifact.

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SKILL_ID = 'cmate-orchestrate';
const SKILL_VERSION = '0.3.0';
const MERGE_SCHEMA_VERSION = 1;
const SUPPORTED_PLAN_SCHEMA_VERSION = 1;
const SUPPORTED_DISPATCH_SCHEMA_VERSION = 1;

const MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);
const DEFAULT_MERGE_METHOD = 'squash';

// gh check states, split into the three buckets the CI gate cares about. Any
// state not listed as a pass or a pending is treated as a failure — an unknown
// state must never be read optimistically as green.
const CI_PASS_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CI_PENDING_STATES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED']);

class SkillError extends Error {
  constructor(code, detail, exitCode) {
    super(detail);
    this.code = code;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

// =============================================================================
// Redaction (mirrors the plan-core and dispatch runners; shapes only)
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

const USAGE = `cmate-orchestrate merge runner (PR creation / CI confirmation / guarded merge)

Usage:
  merge.mjs --plan <path> --dispatch <path> (--create-prs | --merge-prs) [options]

Exactly one mutating phase is enabled per invocation:
  --create-prs           Push each verification-passed branch and open a PR.
  --merge-prs            Confirm each PR's CI and, if green, merge it (guarded).

Options:
  --plan <path>          Approved plan.json from the plan-core runner (required).
  --dispatch <path>      dispatch-report.json from the dispatch runner (required);
                         its completed+verified workers are the only eligible issues.
  --approve              Explicit approval to actually mutate. WITHOUT it the phase
                         is a no-mutation preview: nothing is pushed, created or merged.
  --merge-method <m>     merge | squash | rebase for --merge-prs (default ${DEFAULT_MERGE_METHOD}).
  --out <dir>            Where merge artifacts are written
                         (default: <dispatch-dir>/<phase>).
  --gh <path>            The gh CLI to drive (default "gh").
  --git <path>           The git CLI used for push and the base preflight (default "git").
  --help                 Show this help.

Two gates always hold: a PR is neither created nor merged without --approve, and a
PR is merged only when its CI is green. Failures stop the phase and are reported as
partial — never rounded up to success.`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        plan: { type: 'string' },
        dispatch: { type: 'string' },
        'create-prs': { type: 'boolean' },
        'merge-prs': { type: 'boolean' },
        approve: { type: 'boolean' },
        'merge-method': { type: 'string' },
        out: { type: 'string' },
        gh: { type: 'string' },
        git: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new SkillError('invalid_input', error.message, 3);
  }
  return parsed;
}

function resolveInputs(parsed) {
  const { values } = parsed;

  // Exactly one mutating phase — the core of the explicit-phase-flag design.
  // Both or neither is a hard input error, never a silent default.
  const phases = [];
  if (values['create-prs']) phases.push('create_prs');
  if (values['merge-prs']) phases.push('merge_prs');
  if (phases.length !== 1) {
    throw new SkillError(
      'invalid_input',
      'exactly one mutating phase must be enabled: pass either --create-prs or --merge-prs (not both, not neither)',
      3,
    );
  }

  if (!values.plan) throw new SkillError('invalid_input', '--plan <path> is required', 3);
  if (!values.dispatch) throw new SkillError('invalid_input', '--dispatch <path> is required', 3);

  const method = values['merge-method'] ?? DEFAULT_MERGE_METHOD;
  if (!MERGE_METHODS.has(method)) {
    throw new SkillError('invalid_input', `--merge-method must be one of merge|squash|rebase`, 3);
  }

  return {
    phase: phases[0],
    planPath: values.plan,
    dispatchPath: values.dispatch,
    approve: Boolean(values.approve),
    mergeMethod: method,
    outDir: values.out ?? null,
    gh: values.gh ?? 'gh',
    git: values.git ?? 'git',
  };
}

// =============================================================================
// Plan / dispatch-report loading
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

// Only the fields this runner reads are asserted; a wrong or tampered file is
// refused rather than half-executed.
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

// The eligible set is the whole point of the verification gate reaching this
// runner: an issue is acted on ONLY when its worker completed AND its
// verification passed. Anything less is never turned into a PR or a merge.
function eligibleIssues(plan, dispatch) {
  const passed = new Set();
  for (const wave of dispatch.waves) {
    for (const worker of wave.workers ?? []) {
      if (worker.worker_state === 'completed' && worker.verification && worker.verification.outcome === 'pass') {
        passed.add(worker.issue);
      }
    }
  }
  // Process in the plan's merge order so PRs/merges respect dependency order.
  const order = Array.isArray(plan.merge_order) ? plan.merge_order : [];
  const ordered = order.filter((n) => passed.has(n));
  // Any passed issue not in merge_order (shouldn't happen) is appended stably.
  for (const n of [...passed].sort((a, b) => a - b)) {
    if (!ordered.includes(n)) ordered.push(n);
  }
  return ordered;
}

// =============================================================================
// Safety
// =============================================================================

function issueOf(plan, number) {
  return plan.issues.find((issue) => issue.number === number) ?? { number };
}

// A branch name headed into `git push` / `gh pr create --head` must be a plain
// ref: no whitespace, no shell metacharacters, no path escape. A profile
// template produces exactly this shape; anything else is refused, not quoted.
function safeBranch(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^[A-Za-z0-9._\/-]+$/.test(value)) return null;
  if (value.includes('..')) return null;
  if (value.startsWith('/') || value.startsWith('-')) return null;
  return value;
}

// gh pr create --base wants a branch name, while a profile base is a tracking
// ref like "origin/develop". Strip a single leading remote segment.
function baseBranchName(base) {
  return base.replace(/^[A-Za-z0-9._-]+\//, '');
}

// =============================================================================
// CLI invocation
// =============================================================================

// One structured call to an external CLI. Never throws: a non-zero exit or a
// missing binary comes back as { ok: false } so the caller decides what it means.
function runCli(bin, args) {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
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
// Preflight (read-only; mirrors dispatch's drift re-check, scoped to delivery)
// =============================================================================

function preflight(inputs, plan) {
  const checks = [];
  const add = (code, ok, detail) => checks.push({ code, ok, blocking: true, detail });

  const gh = runCli(inputs.gh, ['--version']);
  add('cli_available', gh.ok, gh.ok ? 'gh CLI is runnable' : 'gh CLI is not runnable (permission or install)');

  const repo = runCli(inputs.gh, ['repo', 'view', plan.profile.repository, '--json', 'nameWithOwner']);
  add('repo_access', repo.ok, repo.ok ? `repo ${plan.profile.repository} is reachable` : `cannot reach repo ${plan.profile.repository} (permission)`);

  const base = runCli(inputs.git, ['rev-parse', '--verify', plan.profile.base]);
  add('base_resolvable', base.ok, base.ok ? `base ${plan.profile.base} resolves` : `base ${plan.profile.base} no longer resolves`);

  return checks;
}

// =============================================================================
// PR body (self-contained, drawn only from the plan)
// =============================================================================

function bullets(items, fallback) {
  if (!Array.isArray(items) || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${redact(String(item))}`).join('\n');
}

function buildPrBody(plan, issue) {
  return [
    `## Summary`,
    redact(issue.objective ?? issue.title ?? `Resolve issue #${issue.number}.`),
    '',
    '## Acceptance criteria',
    bullets(issue.acceptance_criteria, 'See the issue.'),
    '',
    '## Verification',
    `Dispatched by cmate-orchestrate and verified against the profile baseline before this PR was opened.`,
    bullets(plan.profile.baseline, 'repository baseline'),
    '',
    `Resolves #${issue.number}.`,
  ].join('\n');
}

// =============================================================================
// CI evaluation
// =============================================================================

// Reduce gh's per-check states to a single verdict. Green requires at least one
// check and every check in the pass bucket; any failure state fails; otherwise
// (a pending check, or no checks at all) it is pending — never green by default.
function evaluateCi(checks) {
  const normalized = (Array.isArray(checks) ? checks : []).map((c) => ({
    name: redact(String(c && c.name != null ? c.name : 'check')),
    state: String(c && c.state != null ? c.state : 'UNKNOWN').toUpperCase(),
  }));
  const failed = normalized.filter((c) => !CI_PASS_STATES.has(c.state) && !CI_PENDING_STATES.has(c.state));
  const pending = normalized.filter((c) => CI_PENDING_STATES.has(c.state));
  const passedCount = normalized.filter((c) => CI_PASS_STATES.has(c.state)).length;

  let verdict;
  if (normalized.length === 0) verdict = 'pending'; // no checks proven → not green
  else if (failed.length > 0) verdict = 'failed';
  else if (pending.length > 0) verdict = 'pending';
  else verdict = 'passed';

  const summary = normalized.length === 0
    ? 'no checks reported'
    : `${passedCount} passed, ${failed.length} failed, ${pending.length} pending`;
  return { verdict, summary, checks: normalized };
}

// =============================================================================
// gh/git operations
// =============================================================================

function pushBranch(inputs, branch) {
  const result = runCli(inputs.git, ['push', '--set-upstream', 'origin', branch]);
  return { ok: result.ok, note: result.ok ? '' : excerpt(result.stderr || result.stdout || 'push failed') };
}

function createPr(inputs, plan, issue, branch, bodyFile) {
  const title = redact(issue.title ?? `Resolve issue #${issue.number}`);
  const result = runCli(inputs.gh, [
    'pr', 'create',
    '--repo', plan.profile.repository,
    '--base', baseBranchName(plan.profile.base),
    '--head', branch,
    '--title', title,
    '--body-file', bodyFile,
  ]);
  if (!result.ok) {
    return { ok: false, number: null, url: null, note: excerpt(result.stderr || result.stdout || 'pr create failed') };
  }
  const url = (result.stdout.match(/https?:\/\/\S+/) ?? [null])[0];
  const number = url ? Number((url.match(/\/pull\/(\d+)/) ?? [null, null])[1]) || null : null;
  return { ok: true, number, url: url ? redact(url) : null, note: '' };
}

function viewPr(inputs, plan, branch) {
  const result = runCli(inputs.gh, ['pr', 'view', branch, '--repo', plan.profile.repository, '--json', 'number,url,state']);
  const payload = parseCliJson(result);
  if (!payload || typeof payload.number !== 'number') {
    return { found: false, number: null, url: null, state: null, note: excerpt(result.stderr || 'no PR for branch') };
  }
  return {
    found: true,
    number: payload.number,
    url: typeof payload.url === 'string' ? redact(payload.url) : null,
    state: typeof payload.state === 'string' ? payload.state.toUpperCase() : 'UNKNOWN',
    note: '',
  };
}

function prChecks(inputs, plan, number) {
  const result = runCli(inputs.gh, ['pr', 'checks', String(number), '--repo', plan.profile.repository, '--json', 'name,state']);
  const payload = parseCliJson(result);
  if (payload === null) {
    // A non-JSON / failed checks call is treated as "not proven green".
    return { verdict: 'pending', summary: excerpt(result.stderr || 'checks unavailable') || 'checks unavailable', checks: [] };
  }
  return evaluateCi(payload);
}

function mergePr(inputs, plan, number, method) {
  const result = runCli(inputs.gh, ['pr', 'merge', String(number), '--repo', plan.profile.repository, `--${method}`]);
  return { ok: result.ok, note: result.ok ? '' : excerpt(result.stderr || result.stdout || 'merge failed') };
}

// =============================================================================
// Target factory
// =============================================================================

function newTarget(issue, branch, action) {
  return {
    issue,
    branch,
    eligible: true,
    action,
    pr_number: null,
    pr_url: null,
    pushed: false,
    pr_created: false,
    ci_checked: false,
    ci_passed: false,
    ci_summary: 'not checked',
    ci_checks: [],
    merge_attempted: false,
    merged: false,
    outcome: 'skipped',
    note: '',
  };
}

// =============================================================================
// Phases
// =============================================================================

function runCreatePrs(inputs, plan, eligible, outDir, report) {
  const bodyDir = join(outDir, 'pr-bodies');
  mkdirSync(bodyDir, { recursive: true });

  let stopped = false;
  for (const number of eligible) {
    const issue = issueOf(plan, number);
    const branch = safeBranch(issue.branch);
    const target = newTarget(number, branch ?? String(issue.branch ?? ''), 'create_pr');

    if (stopped) {
      target.note = 'not reached: a prior PR creation failed and stopped the phase';
      report.targets.push(target);
      continue;
    }
    if (branch === null) {
      target.outcome = 'pr_failed';
      target.note = 'branch name rejected by the safe-ref guard';
      report.limitations.push({ code: 'unsafe_branch', detail: `#${number}: branch rejected by safe-ref guard` });
      report.targets.push(target);
      halt(report, 'partial', 'pr_create_failed', 'unsafe_branch', `#${number}: unsafe branch name`);
      stopped = true;
      continue;
    }

    const bodyFile = join(bodyDir, `issue-${number}.md`);
    writeFileSync(bodyFile, `${buildPrBody(plan, issue)}\n`, 'utf8');

    if (!inputs.approve) {
      target.outcome = 'previewed';
      target.note = `would push ${branch} and open a PR onto ${baseBranchName(plan.profile.base)} (preview; --approve to execute)`;
      report.targets.push(target);
      continue;
    }

    // Approved: push then open the PR. Either mutation counts as `mutated`.
    report.mutated = true;
    const pushed = pushBranch(inputs, branch);
    target.pushed = pushed.ok;
    if (!pushed.ok) {
      target.outcome = 'pr_failed';
      target.note = redact(`branch push failed: ${pushed.note}`);
      report.targets.push(target);
      halt(report, 'partial', 'pr_create_failed', 'push_failed', `#${number}: branch push failed`);
      stopped = true;
      continue;
    }

    const created = createPr(inputs, plan, issue, branch, bodyFile);
    if (!created.ok) {
      target.outcome = 'pr_failed';
      target.note = redact(`pr create failed: ${created.note}`);
      report.targets.push(target);
      halt(report, 'partial', 'pr_create_failed', 'pr_create_failed', `#${number}: gh pr create failed`);
      stopped = true;
      continue;
    }
    target.pr_created = true;
    target.pr_number = created.number;
    target.pr_url = created.url;
    target.outcome = 'pr_created';
    target.note = created.number ? `opened PR #${created.number}` : 'opened PR (number not parsed)';
    report.targets.push(target);
  }
}

function runMergePrs(inputs, plan, eligible, report) {
  let stopped = false;
  for (const number of eligible) {
    const issue = issueOf(plan, number);
    const branch = safeBranch(issue.branch);
    const target = newTarget(number, branch ?? String(issue.branch ?? ''), 'merge_pr');

    if (stopped) {
      target.note = 'not reached: a prior target blocked the phase';
      report.targets.push(target);
      continue;
    }
    if (branch === null) {
      target.outcome = 'pr_missing';
      target.note = 'branch name rejected by the safe-ref guard';
      report.limitations.push({ code: 'unsafe_branch', detail: `#${number}: branch rejected by safe-ref guard` });
      report.targets.push(target);
      halt(report, 'partial', 'pr_missing', 'unsafe_branch', `#${number}: unsafe branch name`);
      stopped = true;
      continue;
    }

    // 1. Discover the PR (read-only).
    const pr = viewPr(inputs, plan, branch);
    if (!pr.found) {
      target.outcome = 'pr_missing';
      target.note = redact(`no open PR for ${branch}; run --create-prs first (${pr.note})`);
      report.targets.push(target);
      halt(report, 'partial', 'pr_missing', 'pr_missing', `#${number}: no PR to merge`);
      stopped = true;
      continue;
    }
    target.pr_number = pr.number;
    target.pr_url = pr.url;

    if (pr.state === 'MERGED') {
      target.merged = true;
      target.outcome = 'already_merged';
      target.note = `PR #${pr.number} is already merged`;
      report.targets.push(target);
      continue;
    }
    if (pr.state !== 'OPEN') {
      target.outcome = 'pr_closed';
      target.note = `PR #${pr.number} is ${pr.state}, not open; refusing to act`;
      report.targets.push(target);
      halt(report, 'partial', 'pr_closed', 'pr_closed', `#${number}: PR #${pr.number} is ${pr.state}`);
      stopped = true;
      continue;
    }

    // 2. Confirm CI (read-only). This is the second, independent gate.
    const ci = prChecks(inputs, plan, pr.number);
    target.ci_checked = true;
    target.ci_summary = ci.summary || 'no checks reported';
    target.ci_checks = ci.checks;
    target.ci_passed = ci.verdict === 'passed';

    if (ci.verdict !== 'passed') {
      target.outcome = ci.verdict === 'failed' ? 'ci_failed' : 'ci_pending';
      target.note = `CI is ${ci.verdict} (${ci.summary}); merge refused`;
      report.targets.push(target);
      halt(report, 'partial', ci.verdict === 'failed' ? 'ci_failed' : 'ci_pending', target.outcome, `#${number}: CI ${ci.verdict}, not merging`);
      stopped = true;
      continue;
    }

    // 3. Merge only with both gates satisfied: CI green AND explicit approval.
    if (!inputs.approve) {
      target.outcome = 'previewed';
      target.note = `CI green; would merge PR #${pr.number} via ${inputs.mergeMethod} (preview; --approve to execute)`;
      report.targets.push(target);
      continue;
    }

    report.mutated = true;
    target.merge_attempted = true;
    const merged = mergePr(inputs, plan, pr.number, inputs.mergeMethod);
    if (!merged.ok) {
      target.outcome = 'merge_failed';
      target.note = redact(`merge failed (conflict or protection): ${merged.note}`);
      report.targets.push(target);
      halt(report, 'partial', 'merge_failed', 'merge_failed', `#${number}: PR #${pr.number} merge failed`);
      stopped = true;
      continue;
    }
    target.merged = true;
    target.outcome = 'merged';
    target.note = `merged PR #${pr.number} via ${inputs.mergeMethod}`;
    report.targets.push(target);
  }
}

// =============================================================================
// Report assembly
// =============================================================================

function halt(report, status, stopReason, code, detail) {
  // The first blocking condition wins; later ones only add to blocking_reasons.
  if (report.status === 'success') {
    report.status = status;
    report.stop_reason = stopReason;
  }
  report.blocking_reasons.push({ code, detail });
}

function baseReport(inputs, plan, eligible, outDir) {
  return {
    merge_schema_version: MERGE_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    phase: inputs.phase,
    status: 'success',
    stop_reason: 'completed',
    approved: inputs.approve,
    mutated: false,
    merge_method: inputs.mergeMethod,
    plan_run_id: plan.run_id,
    out_dir: outDir,
    profile: {
      id: String(plan.profile.id ?? 'unknown'),
      repository: plan.profile.repository,
      base: plan.profile.base,
      verified: plan.profile.verified === true,
    },
    eligible_issues: eligible.slice(),
    preflight: [],
    targets: [],
    blocking_reasons: [],
    limitations: [],
    redactions: [],
    completion_check: { passed: false, checks: [] },
    summary_markdown: '',
  };
}

function buildCompletionCheck(report, phase) {
  const merges = report.targets.filter((t) => t.merged && t.merge_attempted);
  const failureOutcomes = new Set(['pr_failed', 'pr_missing', 'pr_closed', 'ci_failed', 'ci_pending', 'merge_failed']);
  const anyFailure = report.targets.some((t) => failureOutcomes.has(t.outcome));

  const checks = [
    {
      id: 'single_phase',
      passed: phase === 'create_prs' || phase === 'merge_prs',
      detail: `exactly one mutating phase was enabled (${phase})`,
    },
    {
      id: 'approval_enforced',
      passed: !report.mutated || report.approved,
      detail: report.mutated
        ? 'a mutation ran and it was explicitly approved'
        : 'no mutation ran without --approve',
    },
    {
      id: 'verification_gated',
      passed: report.targets.every((t) => t.eligible === true),
      detail: 'every target was a completed-and-verification-passed issue',
    },
    {
      id: 'ci_gated',
      passed: merges.every((t) => t.ci_passed === true),
      detail: merges.length === 0
        ? 'no PR was merged'
        : 'every merged PR had green CI before the merge',
    },
    {
      id: 'failures_not_rounded',
      passed: !anyFailure || report.status !== 'success',
      detail: anyFailure
        ? 'a failure was recorded and the status is not success'
        : 'no blocking failure was recorded',
    },
  ];
  const passed = checks.every((c) => c.passed) && report.status !== 'failure';
  return { passed, checks };
}

function renderSummary(report) {
  const lines = [];
  const phaseLabel = report.phase === 'create_prs' ? 'PR 作成' : 'guarded merge';
  const verb = report.status === 'success' ? '完了' : report.status === 'partial' ? '途中停止' : '未実行';
  lines.push('## 対象と結論');
  lines.push(`${phaseLabel}（${report.approved ? '承認あり' : 'preview'}）を ${report.profile.repository} で実行: ${report.status}（${verb}, stop=${report.stop_reason}）。`);
  if (!report.approved) lines.push('明示承認（--approve）が無いため mutation はしていない（preview）。');
  lines.push('');
  lines.push('## eligible（verification pass 済み）');
  lines.push(report.eligible_issues.length ? `- ${report.eligible_issues.map((n) => `#${n}`).join(', ')}` : '- なし（verification pass した Issue が無い）。');
  lines.push('');
  lines.push('## target');
  if (report.targets.length === 0) {
    lines.push('- target なし。');
  } else {
    for (const t of report.targets) {
      const ci = t.ci_checked ? ` / CI=${t.ci_passed ? 'green' : t.ci_summary}` : '';
      const pr = t.pr_number ? ` / PR#${t.pr_number}` : '';
      lines.push(`- #${t.issue}: ${t.outcome}${pr}${ci}`);
    }
  }
  lines.push('');
  lines.push('## preflight');
  for (const c of report.preflight) lines.push(`- ${c.code}: ${c.ok ? 'ok' : 'NG'}`);
  lines.push('');
  lines.push('## 未解決と next action');
  if (report.blocking_reasons.length === 0 && report.limitations.length === 0) {
    lines.push(report.approved ? '- なし。全 eligible を処理した。' : '- なし。preview のみ（mutation なし）。');
  } else {
    for (const r of report.blocking_reasons) lines.push(`- blocking: ${r.code} — ${r.detail}`);
    for (const l of report.limitations) lines.push(`- limitation: ${l.code} — ${l.detail}`);
    if (report.stop_reason === 'ci_failed' || report.stop_reason === 'ci_pending') lines.push('- next: CI を green にしてから再実行する（owner: operator）。無条件 merge はしない。');
    if (report.stop_reason === 'merge_failed') lines.push('- next: conflict/branch protection を解消し、再実行する（owner: operator）。');
    if (report.stop_reason === 'pr_create_failed') lines.push('- next: push/PR 作成の失敗要因を解消し、再実行する（owner: operator）。');
    if (report.stop_reason === 'pr_missing') lines.push('- next: 先に --create-prs で PR を作成する（owner: operator）。');
    if (report.stop_reason === 'preflight_failed') lines.push('- next: gh 認証・repo 到達性・base 解決を復旧し、再実行する（owner: operator）。');
  }
  return lines.join('\n');
}

// =============================================================================
// Orchestration
// =============================================================================

function runMerge(inputs, plan, dispatch, outDir) {
  const eligible = eligibleIssues(plan, dispatch);
  const report = baseReport(inputs, plan, eligible, outDir);

  // Read-only preflight before any mutation.
  report.preflight = preflight(inputs, plan);
  const blocked = report.preflight.find((c) => c.blocking && !c.ok);
  if (blocked) {
    halt(report, 'failure', 'preflight_failed', `preflight_${blocked.code}`, blocked.detail);
    finalize(report);
    return report;
  }

  if (eligible.length === 0) {
    report.limitations.push({ code: 'no_eligible_issues', detail: 'the dispatch report has no completed-and-verified issue; nothing to do' });
    finalize(report);
    return report;
  }

  if (inputs.phase === 'create_prs') {
    runCreatePrs(inputs, plan, eligible, outDir, report);
  } else {
    runMergePrs(inputs, plan, eligible, report);
  }

  finalize(report);
  return report;
}

function finalize(report) {
  report.completion_check = buildCompletionCheck(report, report.phase);
  if (!report.completion_check.passed && report.status === 'success') {
    report.status = 'partial';
    report.limitations.push({ code: 'completion_check_failed', detail: 'a completion check did not pass; see completion_check' });
  }
  report.redactions = redactionsList();
  report.summary_markdown = renderSummary(report);
}

// =============================================================================
// Failure envelope
// =============================================================================

function mergeFailure(error, phase) {
  const report = {
    merge_schema_version: MERGE_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    phase: phase ?? 'create_prs',
    status: 'failure',
    stop_reason: 'runner_error',
    approved: false,
    mutated: false,
    merge_method: DEFAULT_MERGE_METHOD,
    plan_run_id: 'unknown',
    out_dir: null,
    profile: { id: 'unknown', repository: 'unknown/unknown', base: 'unknown', verified: false },
    eligible_issues: [],
    preflight: [],
    targets: [],
    blocking_reasons: [{ code: error.code, detail: redact(error.detail ?? error.message) }],
    limitations: [],
    redactions: redactionsList(),
    completion_check: { passed: false, checks: [] },
    summary_markdown: `## 対象と結論\nmerge runner 失敗（${error.code}）。${redact(error.detail ?? error.message)}`,
  };
  report.completion_check = buildCompletionCheck(report, report.phase);
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

  const defaultOut = join(dirname(inputs.dispatchPath), inputs.phase === 'create_prs' ? 'create-prs' : 'merge-prs');
  const outDir = inputs.outDir ?? defaultOut;
  if (existsSync(outDir)) {
    throw new SkillError('out_exists', `merge directory ${outDir} already exists; refusing to overwrite`, 4);
  }
  mkdirSync(outDir, { recursive: true });

  const report = runMerge(inputs, plan, dispatch, outDir);
  writeFileSync(join(outDir, 'merge-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'merge-summary.md'), `${report.summary_markdown}\n`, 'utf8');

  process.stderr.write(`wrote merge artifacts to ${outDir}\n`);
  const exitCode = report.status === 'success' ? 0 : report.status === 'partial' ? 7 : 1;
  return { exitCode, stdout: `${JSON.stringify(report, null, 2)}\n` };
}

function main() {
  const argv = process.argv.slice(2);
  // Recover the phase for the failure envelope even when arg parsing failed.
  const phaseGuess = argv.includes('--merge-prs') && !argv.includes('--create-prs') ? 'merge_prs' : 'create_prs';
  try {
    const { exitCode, stdout } = run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      const report = mergeFailure(error, phaseGuess);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`error [${error.code}]: ${redact(error.detail ?? error.message)}\n`);
      process.exit(error.exitCode ?? 1);
    }
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

main();
