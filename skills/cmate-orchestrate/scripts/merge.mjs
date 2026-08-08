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
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import {
  SKILL_ID,
  SKILL_VERSION,
  SkillError,
  issueOf,
  loadJson,
  parseCliJson,
  redact,
  redactionsList,
  safeBranch,
  validateDispatch,
} from './lib.mjs';

const MERGE_SCHEMA_VERSION = 1;
const SUPPORTED_PLAN_SCHEMA_VERSIONS = [1, 2];

const MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);
const DEFAULT_MERGE_METHOD = 'squash';

// gh check states, split into the three buckets the CI gate cares about. Any
// state not listed as a pass or a pending is treated as a failure — an unknown
// state must never be read optimistically as green.
const CI_PASS_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CI_PENDING_STATES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED']);

// =============================================================================
// Unattended — the declaration that nobody is watching this invocation
// (Issue #134 / #142 / references/adr-unattended-mode.md sections 2, 6.5, 8, 9)
// =============================================================================
//
// `--unattended` is an INPUT DECLARATION, not a permission (ADR "裁定 0"). It
// disables no gate, downgrades no blocking reason to a limitation and raises no
// status by one step; what it adds is tightening, and nothing else. In
// particular it does NOT imply `--approve`: a CI that opens PRs with nobody
// watching writes BOTH flags, and `approved: true` keeps meaning "this mutation
// was explicitly approved" rather than "the runner decided it was fine".
//
// Stage B is this runner's `--create-prs` phase only. What it adds over a run
// without the flag is exactly one thing (ADR section 6.5): the
// `change_evidence_unavailable` limitation becomes BLOCKING, because with a
// human reading the report a PR whose body could not show its diff is a
// degradation somebody notices, and with nobody reading it it is a PR created on
// no evidence at all.
//
// `--merge-prs --unattended` is STAGE C (Issue #142). Until stage C it was
// refused with `invalid_input` rather than accepted and ignored, and the refusal
// was not deleted — it was replaced by the stage it named. What stage C adds to
// this phase is the condition ADR section 9 puts on unattended merging: an issue
// the plan cannot show an acceptance-gate block for is not merged with nobody
// watching. Stage A and B reach a PR at the furthest, and a PR is a place a human
// reads; here the furthest point is the base branch, and a misreading of "lint
// and test passed" as "the issue is done" lands there with nobody reading it.
//
// The requirement STOPS the phase rather than shrinking the target set (ADR
// section 9 item 2, same reason as the scope pre-flight in section 3): quietly
// merging the subset that happens to qualify would report success over a run
// that did less than it was asked to. Nothing is merged, including the issues
// that DO qualify — the eligible set is the unit, not the issue.
//
// It applies to `--merge-prs` only. `--create-prs` is stage B, whose one
// tightening is `change_evidence_unavailable`, and adding a second one there
// would change what stage B means after the fact.
//
// No stop was added for `gh`. Issue #115 measured it (ADR section 14.5): `gh pr
// create` / `gh pr merge` decide for themselves that no TTY is present and exit
// non-zero without waiting, which the existing `pr_create_failed` /
// `merge_failed` / `preflight_failed` already receive. What unattended operation
// actually needs there is input hygiene in the JOB definition (`GH_TOKEN` /
// `GIT_TERMINAL_PROMPT=0`, SKILL.md section 3.3) — the runner does not check it,
// for the same reason it does not check the monitor: it cannot guarantee another
// process's environment.
const UNATTENDED_STAGE = 'C（dispatch + merge + uat）';

// =============================================================================
// Redaction (SkillError, the pattern list and redact/redactionsList are shared
// with the dispatch and uat runners in lib.mjs)
// =============================================================================

// A short, redacted excerpt of terminal-ish output. The raw stream is never
// stored: a bounded tail is enough for a human to act on a failure. NOT shared
// with dispatch: an empty excerpt is `''` here and `null` there.
function excerpt(value, limit = 280) {
  const text = redact(value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text || '';
  return `…${text.slice(text.length - limit)}`;
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
  --unattended           Declare that NO HUMAN is watching this invocation (CI /
                         cron). It grants nothing: it does NOT imply --approve, it
                         disables no gate and it never turns a blocking reason into
                         a limitation. What it adds is tightening, per phase:
                         --create-prs  the change_evidence_unavailable limitation
                                       becomes blocking, so a PR whose body could
                                       not show what the branch changed is not
                                       opened at all;
                         --merge-prs   every eligible issue must carry an
                                       acceptance-gate block AND acceptance
                                       criteria. One that does not stops the
                                       phase — nothing is merged, and the target
                                       set is never quietly shrunk instead.
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
        unattended: { type: 'boolean' },
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

  // Stage C accepts `--unattended` for BOTH phases (Issue #142 / ADR section 8).
  // The stage-B refusal of `--merge-prs --unattended` was not removed as a
  // refusal — it was replaced by the stage it named, which is the discipline the
  // refusal existed for: an invocation that declared something this runner cannot
  // honour must not have that declaration silently dropped, because the reader of
  // the report — in unattended operation the next CI job, not a person — cannot
  // tell that it was. What each phase's declaration now implies is enforced
  // below, in `unattendedAcceptanceReasons` and `recordEvidenceFindings`.
  //
  // A relaxing flag of the dispatch runner (`--auto-yes`, `--allow-questions`,
  // `--contract-mode off`) is refused one step earlier, by parseArgs: this runner
  // has no such option, and an unknown option is already `invalid_input`. That is
  // the same exit 3 with the same meaning, so nothing is re-implemented here.

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
    unattended: Boolean(values.unattended),
    mergeMethod: method,
    outDir: values.out ?? null,
    gh: values.gh ?? 'gh',
    git: values.git ?? 'git',
  };
}

// =============================================================================
// Plan / dispatch-report loading (loadJson and validateDispatch are shared with
// the uat runner in lib.mjs)
// =============================================================================

// Only the fields this runner reads are asserted; a wrong or tampered file is
// refused rather than half-executed. NOT shared with dispatch, which additionally
// enforces max_parallel and the per-wave width bound before it dispatches.
function validatePlan(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new SkillError('plan_invalid', 'plan must be a JSON object', 3);
  }
  if (!SUPPORTED_PLAN_SCHEMA_VERSIONS.includes(plan.plan_schema_version)) {
    throw new SkillError('plan_invalid', `unsupported plan_schema_version ${plan.plan_schema_version}; this runner understands ${SUPPORTED_PLAN_SCHEMA_VERSIONS.join(' or ')}`, 3);
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
// Safety (issueOf and safeBranch are shared in lib.mjs)
// =============================================================================

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
// `extra` is spread into execFileSync (as in dispatch/uat) so the change-evidence
// probe can run `git diff` INSIDE an issue's worktree; a cwd that no longer
// exists surfaces as { ok: false }, which the caller reports rather than hides.
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
// Verification evidence (Issue #97)
// =============================================================================
//
// The PR body is the only place most reviewers ever look. Until #97 its
// Verification section was one sentence — "dispatched and verified against the
// profile baseline" — that read identically whatever had actually happened: the
// gates that judged the branch, their verdicts and their exit codes were sitting
// in the dispatch report this runner already loads, and never reached a human.
// Nor did the other half of the question a reviewer asks: the issue declared how
// far it was allowed to reach (`scope.allow`), so what did the branch actually
// touch?
//
// Everything below is TRANSCRIBED, never asserted. Values come from a file this
// runner did not write (the dispatch report) or from a subprocess (`git diff`),
// so each one goes through redact() on the way in — an upstream document is not
// assumed to have been redacted already. When a value cannot be read, the body
// says so; "we could not measure this" is never rendered as a pass.

// gh rejects a pull-request body over 65536 characters. A worker with a long gate
// list must not push `Resolves #n` out of the body — or fail the create outright
// — so every transcribed list is capped. The cap is always STATED in the body:
// a silently shortened evidence list reads as complete evidence, which is exactly
// the failure this whole section exists to remove.
const PR_BODY_LIMIT = 65536;
const MAX_BODY_GATES = 30;
const MAX_BODY_CHECKS = 15;
const MAX_BODY_PATHS = 50;
const MAX_BODY_CELL = 200;

function bullets(items, fallback) {
  if (!Array.isArray(items) || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${redact(String(item))}`).join('\n');
}

// One markdown table cell: redacted, flattened to a single line, `|` escaped so a
// transcribed value cannot forge a column, and bounded so one long line cannot
// dominate the body.
function cell(value, limit = MAX_BODY_CELL) {
  const text = redact(String(value)).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  if (text === '') return '(empty)';
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

// Split a list into what the body shows and how many it had to drop.
function capped(items, max) {
  const list = Array.isArray(items) ? items : [];
  return { shown: list.slice(0, max), dropped: Math.max(0, list.length - max) };
}

function droppedNote(dropped, what) {
  return `_Not listed here: ${dropped} further ${what}. The list was cut to keep this body under GitHub's ${PR_BODY_LIMIT}-character limit._`;
}

// The worker record the dispatch report holds for this issue. The LAST one wins:
// an issue re-dispatched in a later wave appears more than once, and the newest
// verdict is the one that judged the branch being delivered.
function workerRecordOf(dispatch, number) {
  let found = null;
  for (const wave of dispatch.waves ?? []) {
    for (const worker of wave.workers ?? []) {
      if (worker && worker.issue === number) found = worker;
    }
  }
  return found;
}

// The exit code a recorded line carries — `… → exit 20 (…)`, `gate lint: failed
// (exit 2)`. Null when the line names none, which is rendered as "—" rather than
// filled in with a plausible zero.
function exitCodeOf(text) {
  const match = /\bexit\s+(-?\d+)\b/.exec(String(text));
  return match ? match[1] : null;
}

// The exit code recorded for ONE gate, when a check line is about that gate.
// dispatch writes those lines as `gate <id>: <status> (exit <n>)`.
function gateExitCode(checks, gateId) {
  for (const check of Array.isArray(checks) ? checks : []) {
    const text = String(check);
    if (!text.toLowerCase().startsWith(`gate ${gateId.toLowerCase()}:`)) continue;
    const code = exitCodeOf(text);
    if (code !== null) return code;
  }
  return null;
}

// The verdict half of the evidence: what judged this issue, and how it ruled.
function verificationLines(worker) {
  const lines = [];
  const verification = worker && worker.verification ? worker.verification : null;
  if (verification === null) {
    lines.push(
      'The dispatch report holds **no verification record for this issue**, so this PR carries no evidence that anything judged it. Do not read this as a pass.',
    );
    return lines;
  }

  lines.push('Transcribed from the dispatch report for this issue — the verdict that actually judged this branch, not a statement of intent.');
  lines.push('');
  lines.push(`- Verdict: **${cell(verification.outcome ?? 'unknown')}**`);
  if (verification.ran === false) {
    lines.push(
      '- **The verification did not run** (`ran: false`): no gate and no command was executed for this issue, so the verdict above is not backed by a run. Treat this branch as unverified.',
    );
  }

  const gates = capped(verification.gates, MAX_BODY_GATES);
  if (gates.shown.length === 0) {
    lines.push('- Gates: **none recorded** — the run named no gate, so the checks below are all this verdict can point at.');
  } else {
    lines.push('');
    lines.push('**Gates**');
    lines.push('');
    lines.push('| Gate | Verdict | Exit |');
    lines.push('| --- | --- | --- |');
    for (const gate of gates.shown) {
      const id = cell(gate && gate.id != null ? gate.id : 'unknown');
      const verdict = cell(gate && gate.verdict != null ? gate.verdict : 'unknown');
      lines.push(`| ${id} | ${verdict} | ${gateExitCode(verification.checks, id) ?? '—'} |`);
    }
    if (gates.dropped > 0) {
      lines.push('');
      lines.push(droppedNote(gates.dropped, 'gate(s)'));
    }
  }

  const checks = capped(verification.checks, MAX_BODY_CHECKS);
  lines.push('');
  lines.push('**Checks**');
  lines.push('');
  if (checks.shown.length === 0) {
    lines.push('_The run recorded no check line._');
  } else {
    lines.push('| # | Check (as recorded) | Exit |');
    lines.push('| --- | --- | --- |');
    checks.shown.forEach((check, index) => {
      lines.push(`| ${index + 1} | ${cell(check)} | ${exitCodeOf(check) ?? '—'} |`);
    });
    if (checks.dropped > 0) {
      lines.push('');
      lines.push(droppedNote(checks.dropped, 'check(s)'));
    }
  }
  return lines;
}

// The scope the plan declared for this issue. `suspected_files` is exactly what
// the dispatch runner turns into the execution contract's `scope.allow`, so this
// is the permission the worker was actually given — reported, not re-derived.
function declaredScope(issue) {
  const files = Array.isArray(issue.suspected_files) ? issue.suspected_files : [];
  const cleaned = files
    .filter((file) => typeof file === 'string' && file.trim() !== '')
    .map((file) => redact(file.trim()));
  return [...new Set(cleaned)].sort();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Is a changed path inside one declared scope entry? Entries are normally plain
// repository paths, but the contract accepts patterns, so `*` (within a segment)
// and `**` (across segments) are honored. Treating a pattern as a literal would
// report an in-scope change as a violation — the one thing this comparison must
// not get wrong, since it is the human-readable half of `requireScopeClean`.
function scopeMatches(pattern, path) {
  if (pattern === path) return true;
  if (!pattern.includes('*')) return false;
  const source = pattern
    .split('**')
    .map((part) => part.split('*').map(escapeRegExp).join('[^/]*'))
    .join('.*');
  try {
    return new RegExp(`^${source}$`).test(path);
  } catch {
    return false;
  }
}

function inDeclaredScope(scope, path) {
  return scope.some((pattern) => scopeMatches(pattern, path));
}

// `git diff --numstat` is parsed rather than `--shortstat`: the numeric form is
// machine-readable and locale-independent. A binary file reports `-` for both
// counts and is counted as a file without inventing line numbers for it.
function parseNumstat(stdout) {
  let files = 0;
  let added = 0;
  let deleted = 0;
  let binary = 0;
  for (const line of String(stdout).split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    files += 1;
    if (parts[0] === '-' || parts[1] === '-') {
      binary += 1;
      continue;
    }
    added += Number.parseInt(parts[0], 10) || 0;
    deleted += Number.parseInt(parts[1], 10) || 0;
  }
  return { files, added, deleted, binary };
}

// What the branch ACTUALLY changed, read from the issue's own worktree. Read-only
// and never fatal: a worktree that has already been cleaned up makes the evidence
// unavailable, which is reported as unavailable — never as "nothing changed" and
// never as "the branch stayed in scope".
function changeEvidence(inputs, plan, issue) {
  const branch = safeBranch(issue.branch);
  const worktree = typeof issue.worktree === 'string' && issue.worktree !== '' ? issue.worktree : null;
  const range = branch === null ? null : `${plan.profile.base}...${branch}`;
  if (branch === null || worktree === null) {
    return { ok: false, range, reason: 'the plan names no worktree or no safe branch for this issue', files: [], stat: null };
  }

  const names = runCli(inputs.git, ['diff', '--name-only', range], { cwd: worktree });
  if (!names.ok) {
    return {
      ok: false,
      range,
      reason: excerpt(names.stderr || names.stdout || 'git diff --name-only failed', 200) || 'git diff --name-only failed',
      files: [],
      stat: null,
    };
  }
  // The WHOLE change set, not the part the body has room for: the out-of-scope
  // count is computed from this list, and counting only the first page of it
  // would report a clean branch that is not one. Capping happens at render time.
  const files = names.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => redact(line));

  const numstat = runCli(inputs.git, ['diff', '--numstat', range], { cwd: worktree });
  const stat = numstat.ok ? parseNumstat(numstat.stdout) : null;
  return { ok: true, range, reason: '', files, stat };
}

// The scope half of the evidence: what the issue was allowed to touch, beside what
// the branch touched, so a reviewer can see the out-of-scope count without
// re-running the diff themselves.
function scopeLines(issue, change) {
  const scope = declaredScope(issue);
  const lines = ['**Declared scope vs. actual changes**', ''];

  if (!change.ok) {
    lines.push(
      `The branch's actual change set could NOT be read (\`git diff --name-only ${change.range ?? '<range>'}\`: ${cell(change.reason)}), so this section cannot show what changed. **This is not evidence that the branch stayed in scope.**`,
    );
    lines.push('');
    lines.push(`- Declared scope (\`scope.allow\`, ${scope.length} entr${scope.length === 1 ? 'y' : 'ies'}):`);
    const listed = capped(scope, MAX_BODY_PATHS);
    if (listed.shown.length === 0) lines.push('  - (the plan declares no target file for this issue)');
    for (const path of listed.shown) lines.push(`  - \`${cell(path)}\``);
    if (listed.dropped > 0) lines.push('', droppedNote(listed.dropped, 'scope entr(y/ies)'));
    return lines;
  }

  const outOfScope = change.files.filter((path) => !inDeclaredScope(scope, path));
  const stat = change.stat;
  const total = change.files.length;

  lines.push(`Declared scope (\`scope.allow\`, from the plan's target files) against \`git diff --name-only ${change.range}\`, run in this issue's worktree.`);
  lines.push('');
  if (outOfScope.length === 0) {
    lines.push(`- Out-of-scope changes: **0** — every one of the ${total} changed file(s) is inside the declared scope.`);
  } else {
    // The COUNT is over the whole change set; only the naming is bounded, and a
    // bounded naming says how many it did not name.
    const named = capped(outOfScope, MAX_BODY_PATHS);
    const suffix = named.dropped > 0 ? ` (+${named.dropped} more not listed here)` : '';
    lines.push(`- Out-of-scope changes: **${outOfScope.length}** — changed but NOT declared: ${named.shown.map((path) => `\`${cell(path)}\``).join(', ')}${suffix}.`);
  }
  lines.push(
    stat === null
      ? `- Diff size: **${total} file(s) changed** (line counts unavailable: \`git diff --numstat\` did not answer).`
      : `- Diff size: **${stat.files} file(s) changed, +${stat.added} / -${stat.deleted} line(s)**${stat.binary > 0 ? ` (${stat.binary} binary file(s) counted without line numbers)` : ''}.`,
  );
  lines.push('');

  const rows = capped([...new Set([...scope, ...change.files])].sort(), MAX_BODY_PATHS);
  if (rows.shown.length === 0) {
    lines.push('_The plan declares no target file and the branch changed none._');
    return lines;
  }
  lines.push('| Path | Declared (`scope.allow`) | Changed |');
  lines.push('| --- | --- | --- |');
  for (const path of rows.shown) {
    lines.push(`| \`${cell(path)}\` | ${inDeclaredScope(scope, path) ? 'yes' : '**no**'} | ${change.files.includes(path) ? 'yes' : 'no'} |`);
  }
  if (rows.dropped > 0) {
    lines.push('');
    lines.push(droppedNote(rows.dropped, 'path(s)'));
  }
  return lines;
}

// =============================================================================
// PR body (plan + the run's measured evidence)
// =============================================================================

// Last-resort guard. Every list above is capped, but a plan with a very long
// objective or acceptance-criteria list could still exceed what gh accepts.
// Truncating beats a create that fails — but a truncated body must SAY it was
// truncated, so the marker is part of the truncation, not an optional extra.
function fitPrBody(body) {
  if (body.length <= PR_BODY_LIMIT) return body;
  const marker = `\n\n_This body was truncated to fit GitHub's ${PR_BODY_LIMIT}-character limit; the complete evidence is in the run's merge artifacts._\n`;
  let head = body.slice(0, PR_BODY_LIMIT - marker.length);
  // Never end on half of a surrogate pair: an emoji cut down the middle would be
  // written out as a replacement character.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}${marker}`;
}

function buildPrBody(plan, issue, autoCloseNote, evidence) {
  const lines = [
    `## Summary`,
    redact(issue.objective ?? issue.title ?? `Resolve issue #${issue.number}.`),
    '',
    '## Acceptance criteria',
    bullets(issue.acceptance_criteria, 'See the issue.'),
    '',
    '## Verification',
    ...verificationLines(evidence.worker),
    '',
    ...scopeLines(issue, evidence.change),
    '',
    `Resolves #${issue.number}.`,
  ];
  if (autoCloseNote) lines.push('', autoCloseNote);
  return fitPrBody(lines.join('\n'));
}

// =============================================================================
// Issue auto-close reachability (Issue #39)
// =============================================================================

// GitHub only honors a closing keyword (`Resolves #n`) when the PR merges into
// the repository's DEFAULT branch. A profile base is free to be anything —
// `origin/develop` in a feature → develop → stg → main flow — and in that case
// the keyword this runner writes is inert: the PR merges and the issue stays
// open. That is not a defect this runner can fix (auto-closing an issue on the
// operator's behalf is out of scope by product policy), so it is recorded.
const AUTOCLOSE_LIMITATION_CODE = 'issue_autoclose_not_default_branch';

// One read-only `gh repo view` for the repository's default branch. Returns null
// when the query fails or the field is absent — a null skips the comparison
// entirely rather than guessing, so a gh outage never blocks the merge flow.
function defaultBranchOf(inputs, plan) {
  const result = runCli(inputs.gh, ['repo', 'view', plan.profile.repository, '--json', 'defaultBranchRef']);
  const parsed = parseCliJson(result);
  const name = parsed && parsed.defaultBranchRef ? parsed.defaultBranchRef.name : null;
  return typeof name === 'string' && name !== '' ? name : null;
}

// Records the limitation when the PR base is not the default branch, and returns
// the note to append to each PR body (null when nothing is wrong or unknown).
function checkIssueAutoClose(inputs, plan, report) {
  const base = baseBranchName(plan.profile.base);
  const defaultBranch = defaultBranchOf(inputs, plan);
  if (defaultBranch === null) return null; // unknown: skip the comparison
  if (defaultBranch === base) return null; // merging into the default branch: the keyword works

  const detail =
    `PR base is "${base}" but the default branch of ${plan.profile.repository} is "${defaultBranch}"; ` +
    'GitHub only auto-closes on a merge into the default branch, so `Resolves #n` in these PR bodies ' +
    'will not close the issues. Close them manually after the merge.';
  report.limitations.push({ code: AUTOCLOSE_LIMITATION_CODE, detail });
  return (
    `> Note: this PR targets \`${base}\`, which is not the default branch (\`${defaultBranch}\`). ` +
    'GitHub will not auto-close the issue above on merge — close it manually.'
  );
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

// What the PR body says about the evidence, said again in the report — the two
// must never disagree. Neither of these stops the phase (the verification gate
// already ran upstream and passed); they are the "did not stop it, but you need
// to know" channel, so a reviewer who reads only merge-report.json still sees
// that a body could not show its diff, or showed a change outside the scope the
// plan declared.
const EVIDENCE_UNAVAILABLE_CODE = 'change_evidence_unavailable';
const SCOPE_EXCEEDED_CODE = 'branch_changed_outside_declared_scope';

// =============================================================================
// Stage C: what an unattended `--merge-prs` requires of its issues
// (Issue #142 / references/adr-unattended-mode.md sections 8, 9)
// =============================================================================
//
// ADR section 9's condition 2, taken as a REQUIREMENT rather than a possibility:
// an issue whose plan record carries no acceptance-gate block, or no acceptance
// criteria at all, is not merged with nobody watching. Both readings are of the
// PLAN — the document a human approved — and neither is re-derived here:
//
//   - `acceptance_gates.require` is the transcription of the issue body's
//     ```acceptance-gates block (Issue #114, #100 stage 1). Null means the body
//     carried no block, or carried one the planner refused to read; the plan
//     tells the two apart with an open question, not with this field, and for
//     this gate they are the same finding — no machine condition was declared.
//   - an empty `acceptance_criteria` is exactly what makes the planner raise
//     `no_acceptance_criteria`, so the code the report carries is that same one:
//     the operator's action is identical (write it in the issue and re-plan) and
//     the status runner's hint for it already says so.
//
// The check is deliberately shallow. Whether the required ids EXIST is the
// dispatch runner's question (it holds the worktree; `acceptance_gate_id_unknown`
// is its answer), and re-asking it here would be a second, worse opinion about a
// worktree that may already be gone.
const ACCEPTANCE_GATES_REQUIRED_CODE = 'acceptance_gates_required';
const NO_ACCEPTANCE_CRITERIA_CODE = 'no_acceptance_criteria';

function hasAcceptanceGateBlock(issue) {
  const declared = issue.acceptance_gates;
  if (declared === null || declared === undefined) return false;
  if (typeof declared !== 'object' || Array.isArray(declared)) return false;
  if (declared.version !== 1) return false;
  return Array.isArray(declared.require) && declared.require.some((id) => typeof id === 'string' && id.trim() !== '');
}

function hasAcceptanceCriteria(issue) {
  return Array.isArray(issue.acceptance_criteria)
    && issue.acceptance_criteria.some((line) => typeof line === 'string' && line.trim() !== '');
}

// Every reason the whole eligible set fails the stage-C condition — every one,
// not the first: the operator has to edit the issues and re-plan, and a list
// that stops at the first one turns that into as many round trips as there are
// issues. Empty means the phase may proceed.
function unattendedAcceptanceReasons(plan, eligible) {
  const reasons = [];
  for (const number of eligible) {
    const issue = issueOf(plan, number) ?? {};
    if (!hasAcceptanceGateBlock(issue)) {
      reasons.push({
        code: ACCEPTANCE_GATES_REQUIRED_CODE,
        detail: `#${number}: the plan records no acceptance-gate block for this issue, so no machine-checkable acceptance condition was ever declared for it. `
          + 'Under --unattended --merge-prs the base branch moves with nobody reading the result, and "lint and test passed" is not "the issue is done": '
          + 'add an ```acceptance-gates block naming the gate id(s) that must judge it and re-plan. '
          + 'The issue is NOT excluded from the target set — nothing was merged, including the issues that do carry one',
      });
    }
    if (!hasAcceptanceCriteria(issue)) {
      reasons.push({
        code: NO_ACCEPTANCE_CRITERIA_CODE,
        detail: `#${number}: the plan read no acceptance criteria out of this issue (the planner's no_acceptance_criteria finding), so the issue never stated what "done" means. `
          + 'Under --unattended --merge-prs that is refused rather than merged: write 1-3 concrete completion checks in the issue body and re-plan',
      });
    }
  }
  return reasons;
}

// Returns the blocking detail when the phase must stop here, null otherwise.
//
// Under `--unattended` the FIRST finding stops the phase (ADR section 6.5, stage
// B of section 8): "the change set could not be read" is a degradation a human
// reading the report can absorb — they open the branch and look — and with
// nobody reading it, it is a PR opened on no evidence at all. Promoting it is
// the whole of what stage B adds, and it is a promotion, never a relaxation.
//
// The SECOND finding is NOT promoted, deliberately. The contract gate
// `requireScopeClean` has already judged the same question upstream, and
// `--unattended` makes the contract path mandatory on the dispatch side, so a
// branch that reaches this runner with changes outside its declared scope has
// already been ruled on by a machine; this limitation is the human-readable copy
// of that ruling (ADR section 6.5, last paragraph).
function recordEvidenceFindings(inputs, report, number, issue, evidence) {
  if (!evidence.change.ok) {
    if (inputs.unattended) {
      return `#${number}: the branch's actual change set could not be read (${redact(evidence.change.reason)}); `
        + 'under --unattended no PR is opened for it, because the body would have to say it cannot show what changed and '
        + 'nobody is here to read that sentence';
    }
    report.limitations.push({
      code: EVIDENCE_UNAVAILABLE_CODE,
      detail: `#${number}: the branch's actual change set could not be read (${redact(evidence.change.reason)}); the PR body reports it as unread rather than claiming the change stayed in scope`,
    });
    return null;
  }
  const scope = declaredScope(issue);
  const outOfScope = evidence.change.files.filter((path) => !inDeclaredScope(scope, path));
  if (outOfScope.length > 0) {
    report.limitations.push({
      code: SCOPE_EXCEEDED_CODE,
      detail: `#${number}: ${outOfScope.length} changed file(s) are outside the scope the plan declared for this issue (${outOfScope.slice(0, 10).map((path) => redact(path)).join(', ')}); the PR body names them`,
    });
  }
  return null;
}

function runCreatePrs(inputs, plan, dispatch, eligible, outDir, report) {
  const bodyDir = join(outDir, 'pr-bodies');
  mkdirSync(bodyDir, { recursive: true });

  // Read-only, once per invocation — not once per issue.
  const autoCloseNote = checkIssueAutoClose(inputs, plan, report);

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

    // The measured half of the PR body (Issue #97). Both probes are read-only and
    // neither can stop the phase: what they cannot read is reported as unread.
    const evidence = { worker: workerRecordOf(dispatch, number), change: changeEvidence(inputs, plan, issue) };
    const evidenceBlocked = recordEvidenceFindings(inputs, report, number, issue, evidence);
    if (evidenceBlocked !== null) {
      // Before the body is written and before anything is pushed: an unattended
      // run that cannot show the diff does not open the PR, so it does not leave
      // a body for a PR it refused to open either.
      target.outcome = 'pr_failed';
      target.note = 'unattended: the branch change set could not be read, so no PR was opened (its body would carry no evidence)';
      report.targets.push(target);
      halt(report, 'partial', 'pr_create_failed', EVIDENCE_UNAVAILABLE_CODE, evidenceBlocked);
      stopped = true;
      continue;
    }

    const bodyFile = join(bodyDir, `issue-${number}.md`);
    writeFileSync(bodyFile, `${buildPrBody(plan, issue, autoCloseNote, evidence)}\n`, 'utf8');

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

// The run-wide declaration (mirrors the dispatch runner's entry of the same
// code). One entry, in EVERY unattended report including the ones that stopped,
// so what the run declared — and what that declaration implied — is readable
// from the report alone.
//
// Deliberately free of absolute paths: `redact()` would replace them with
// `[REDACTED-PATH]` and, worse, would tally a redaction a run without the flag
// does not have, so the "an unattended run differs only by this limitation"
// property would stop being true.
const UNATTENDED_MODE_CODE = 'unattended_mode';

// Phase-aware because the two phases imply DIFFERENT tightenings (ADR section 8's
// stage table gives one to each). A single sentence covering both would tell the
// reader of a `--merge-prs` report about a promotion that phase never applies.
function unattendedModeLimitation(phase) {
  const implied = phase === 'merge_prs'
    ? '全 eligible Issue が受入ゲートブロック（```acceptance-gates）と受入条件を持つことを要求する'
      + '（1件でも欠ければ **1つも merge せずに停止**する。対象集合を黙って縮めない。段階 C）'
    : `${EVIDENCE_UNAVAILABLE_CODE} を limitation ではなく blocking として扱う（実変更を示せない PR は開かない。段階 B）`;
  return {
    code: UNATTENDED_MODE_CODE,
    detail: `--unattended（段階 ${UNATTENDED_STAGE}）: この invocation に人間は居ない、という入力の宣言である。`
      + '締め付けだけを含意し、権限は1つも足していない — **`--approve` は含意しない**、'
      + 'ゲートを無効化せず、blocking を limitation に格下げせず、status を1段も上げない。'
      + `含意した締め付け: ${implied}。`
      + '拒否する入力: dispatch の緩和フラグ（--auto-yes / --allow-questions / --contract-mode。invalid_input, exit 3）。'
      + '`gh` 由来の停止は足していない（実測どおり gh は TTY 非依存で完結する）ので、'
      + '`GH_TOKEN` と `GIT_TERMINAL_PROMPT=0` は job 定義側で置くこと（runner は検査しない）。',
  };
}

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
  // The unattended section (Issue #134). Printed only when the operator opted in,
  // so a run without `--unattended` reads exactly as it did before the flag
  // existed.
  const unattendedDeclared = report.limitations.find((entry) => entry.code === UNATTENDED_MODE_CODE);
  if (unattendedDeclared) {
    lines.push('## 無人運転（unattended）');
    lines.push(`- 宣言: ${unattendedDeclared.detail}`);
    lines.push(report.phase === 'merge_prs'
      ? '- **`--unattended` は mutation の許可ではない。** 無人で merge する CI は `--approve` を別に書く。'
      : '- **`--unattended` は mutation の許可ではない。** 無人で PR を作る CI は `--approve` を別に書く。');
    lines.push('- job 定義側で `GH_TOKEN`（または `GH_ENTERPRISE_TOKEN`）と `GIT_TERMINAL_PROMPT=0` を置くこと。**`git push` の資格情報プロンプトだけは「止まる」ではなく無言で待つに化ける**（SKILL.md 第3.3節）。');
    lines.push('');
  }
  lines.push('## 未解決と next action');
  const evidenceBlocked = report.blocking_reasons.some((r) => r.code === EVIDENCE_UNAVAILABLE_CODE);
  const acceptanceBlocked = report.blocking_reasons.some(
    (r) => r.code === ACCEPTANCE_GATES_REQUIRED_CODE || r.code === NO_ACCEPTANCE_CRITERIA_CODE,
  );
  if (report.blocking_reasons.length === 0 && report.limitations.length === 0) {
    lines.push(report.approved ? '- なし。全 eligible を処理した。' : '- なし。preview のみ（mutation なし）。');
  } else {
    for (const r of report.blocking_reasons) lines.push(`- blocking: ${r.code} — ${r.detail}`);
    for (const l of report.limitations) lines.push(`- limitation: ${l.code} — ${l.detail}`);
    if (report.stop_reason === 'ci_failed' || report.stop_reason === 'ci_pending') lines.push('- next: CI を green にしてから再実行する（owner: operator）。無条件 merge はしない。');
    if (report.stop_reason === 'merge_failed') lines.push('- next: conflict/branch protection を解消し、再実行する（owner: operator）。');
    // The evidence stop shares `pr_create_failed`, but nothing about push or gh
    // failed there, so it gets its own next action instead of the generic one.
    if (evidenceBlocked) lines.push('- next: 対象 Issue の worktree を復旧してから再実行する（`git diff <base>...<branch>` が答える状態にする）。人間が読む運転に戻すなら `--unattended` を外せば従来どおり limitation として続行する（owner: operator）。');
    if (report.stop_reason === 'pr_create_failed' && !evidenceBlocked) lines.push('- next: push/PR 作成の失敗要因を解消し、再実行する（owner: operator）。');
    if (report.stop_reason === 'pr_missing') lines.push('- next: 先に --create-prs で PR を作成する（owner: operator）。');
    // The stage-C stop shares `preflight_failed` with the gh/git probes, but
    // nothing about gh or git failed there: the action is on the ISSUE bodies.
    if (acceptanceBlocked) {
      lines.push('- next: 無人 merge の対象 Issue に受入ゲートブロック（```acceptance-gates）／受入条件が無い。**Issue 本文に書いて re-plan する。** 該当 Issue を除外して回す道は用意していない（対象集合を黙って縮めないため）。人間が読む運転に戻すなら `--unattended` を外す（owner: human）。');
    }
    if (report.stop_reason === 'preflight_failed' && !acceptanceBlocked) lines.push('- next: gh 認証・repo 到達性・base 解決を復旧し、再実行する（owner: operator）。');
  }
  return lines.join('\n');
}

// =============================================================================
// Orchestration
// =============================================================================

function runMerge(inputs, plan, dispatch, outDir) {
  const eligible = eligibleIssues(plan, dispatch);
  const report = baseReport(inputs, plan, eligible, outDir);
  // Recorded before anything else so it survives every early return below: a run
  // that stopped in the preflight still says what it had declared.
  if (inputs.unattended) report.limitations.push(unattendedModeLimitation(inputs.phase));

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

  // Stage C (Issue #142 / ADR sections 8, 9). Read-only, over the WHOLE eligible
  // set, and before the phase touches a single PR: an unattended merge either
  // runs on issues that all declared what "done" means, or it does not run.
  if (inputs.unattended && inputs.phase === 'merge_prs') {
    const reasons = unattendedAcceptanceReasons(plan, eligible);
    if (reasons.length > 0) {
      // `preflight_failed` receives it: the enum is a schema-versioned closed set
      // (ADR section 11), and what actually happened is named by the codes in
      // `blocking_reasons` — the shape section 15.2 used for
      // `wall_clock_budget_exhausted` and section 16 for the stage-B promotion.
      for (const reason of reasons) halt(report, 'failure', 'preflight_failed', reason.code, reason.detail);
      finalize(report);
      return report;
    }
  }

  if (inputs.phase === 'create_prs') {
    runCreatePrs(inputs, plan, dispatch, eligible, outDir, report);
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
