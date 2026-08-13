#!/usr/bin/env node
// Deterministic fixture tests for skills/cmate-orchestrate.
//
//   node tests/fixtures/cmate-orchestrate/run_tests.mjs
//
// GitHub-independent: every case feeds the planner an --issue-json fixture, so
// the suite is a pure function of this repository. It proves the planner's
// contract — dependency kinds, cycle/override/order rejection, conflict-free
// waves, bounded parallelism, unverified-profile handling — and that the plan
// is deterministic (same input, byte-identical plan) and schema-conformant.
//
// Node stdlib only. Not part of the release pipeline; run on demand.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const RUNNER = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'scripts', 'orchestrate.mjs');
const DISPATCH_RUNNER = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'scripts', 'dispatch.mjs');
const MERGE_RUNNER = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'scripts', 'merge.mjs');
const UAT_RUNNER = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'scripts', 'uat.mjs');
const STATUS_RUNNER = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'scripts', 'status.mjs');
const PROFILE_INIT_RUNNER = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'scripts', 'profile-init.mjs');
const SCHEMA_DIR = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'schemas');
const CASES_DIR = join(HERE, 'cases');
const DISPATCH_CASES_DIR = join(HERE, 'dispatch-cases');
const RESUME_CASES_DIR = join(HERE, 'resume-cases');
const MERGE_CASES_DIR = join(HERE, 'merge-cases');
const UAT_CASES_DIR = join(HERE, 'uat-cases');
const STATUS_CASES_DIR = join(HERE, 'status-cases');
const PROFILE_INIT_CASES_DIR = join(HERE, 'profile-init-cases');
const PROFILES_DIR = join(HERE, 'profiles');
const FAKE_CLI = join(HERE, 'fake-cli.mjs');
// The dispatch/merge/uat runners execute the profile baseline INSIDE each
// worktree as the verification/UAT signal (there is no `commandmate verify|uat`).
// This profile's baseline is `cat cmate-verify-ok`, so a worktree "passes" iff it
// holds that marker file — which the harness (dispatch worktrees) and the fake CLI
// (fix worktrees) create for the workers a scenario says should pass.
const NODE_FAKE_PROFILE = join(PROFILES_DIR, 'node-fake.json');
const CLI_CONTRACT_PATH = join(HERE, 'commandmate-cli-contract.json');
// Written beside every generated plan: the issue bodies that plan was built from,
// which the fake `gh issue view` serves back to the dispatch runner (Issue #176).
const ISSUE_BODIES_FILE = 'issue-bodies.json';

const planSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'execution-plan.v2.json'), 'utf8'));
const planSchemaV1 = JSON.parse(readFileSync(join(SCHEMA_DIR, 'execution-plan.v1.json'), 'utf8'));
// A checked-in run artifact carries the version it was produced with; validate it
// against that schema rather than the one the current planner emits.
const planSchemaFor = (plan) => (plan && plan.plan_schema_version === 1 ? planSchemaV1 : planSchema);
const resultSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'orchestrate-result.v1.json'), 'utf8'));
const dispatchSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'dispatch-report.v1.json'), 'utf8'));
const mergeSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'merge-report.v1.json'), 'utf8'));
const uatSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'uat-report.v1.json'), 'utf8'));
// The semantic gate's input contract, owned by cmate-acceptance-test. The UAT
// runner consumes it and never writes it, so the fixtures are validated against
// the producing Skill's schema rather than against a local copy.
const acceptanceSchema = JSON.parse(readFileSync(
  join(REPO_ROOT, 'skills', 'cmate-acceptance-test', 'schemas', 'acceptance-result.v1.json'),
  'utf8',
));

// A dispatch scenario where both issues of the two-wave fixture complete and
// pass verification, so both are eligible for the merge phase. Merge cases that
// need a different eligible set override this with spec.dispatch_scenario.
const DEFAULT_DISPATCH_SCENARIO = {
  cli_available: true,
  git: { branch: 'feature/integration', dirty: false },
  gh: { repo_access: true },
  workers: {
    201: { state: 'completed', verify: 'pass' },
    200: { state: 'completed', verify: 'pass' },
  },
};

let failures = 0;
const log = (line) => process.stdout.write(`${line}\n`);

// =============================================================================
// Worktree-based CLI harness (Issue #1467)
// =============================================================================
//
// The real commandmate CLI is worktree-id based and has no verify/uat subcommand.
// These helpers stand up the world the runners now expect: a resolvable worktree
// id (fed to the fake `ls --json`), a real worktree directory per issue (the
// runner cwd's into it to run the profile baseline), and the `cmate-verify-ok`
// marker that makes that baseline pass. The runner is spawned with cwd set to a
// throwaway integration directory so the plan's `../repo-issue-…` worktree paths
// resolve into the temp area rather than next to this repository.

function readPlan(planPath) {
  return JSON.parse(readFileSync(planPath, 'utf8'));
}

// The environment every spawned runner starts from. `CM` is the launcher
// variable the runners now read (Issue #37), so an operator who exports it in
// their own shell would otherwise silently change what these tests exercise.
// Cases that care about `CM` set it explicitly.
function baseEnv() {
  const env = { ...process.env };
  delete env.CM;
  // The unattended exclusivity lock root (Issue #122). Deleted for the same
  // reason as CM: a developer who exported it would otherwise change which
  // directory these tests lock in — and every runDispatchRunner call below sets
  // it explicitly to a per-run temp directory, so the suite never touches the
  // shared default ($TMPDIR/cmate-orchestrate-locks).
  delete env.CMATE_ORCHESTRATE_LOCK_DIR;
  return env;
}

// Mirror CommandMate's generateWorktreeId(branch, repoName): lowercase, non
// [a-z0-9-] -> '-', collapse/trim hyphens, joined as `<repo>-<branch>`.
function sanitizeSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
function worktreeIdFor(repository, branch) {
  const repo = repository.split('/').pop() ?? repository;
  return `${sanitizeSlug(repo)}-${sanitizeSlug(branch)}`;
}

// The registered worktree path for an issue: a per-issue override when the
// scenario declares one (used to model a worktree registered under a path that
// differs from the plan's worktree_template — the #1473 asymmetry), otherwise the
// plan template path. `ls --json` reports this path and the real directory is
// created here, so a mismatch is exercised end to end.
function registeredPathFor(issue, pathOverrides) {
  return pathOverrides[issue.number] ?? pathOverrides[String(issue.number)] ?? issue.worktree;
}

// Issues CommandMate does not know about (Issue #90). Two shapes, because the
// runner must treat them differently:
//
//   unregistered_worktrees — nothing exists: no `ls` row and no `git worktree
//     list` entry. The blocking drift re-check fails, so the pre-flight refuses
//     the run BEFORE the out directory is created.
//   git_only_worktrees — the directory is a registered git worktree, but
//     CommandMate has no row for it. `worktrees_present` is satisfied by the
//     `git worktree list` fallback, so the pre-flight passes and the missing id
//     only surfaces when the wave tries to resolve a send target.
//   sync_only_worktrees (Issue #91) — same world as git_only, but the server has
//     simply not re-scanned since the worktree was created: a `commandmate sync`
//     registers it and the retried `ls` resolves it. With `cli_sync: false` (a
//     CommandMate older than 0.21.0) the sync fails and it stays a git_only case.
//   prepare_worktrees (Issue #93) — nothing exists either, exactly like
//     unregistered_worktrees, but the `worktree-setup` provider CAN create it
//     during the run: the row is handed to the fake as `prepared_worktrees`, which
//     it reveals to `git worktree list` once the provider created it and to
//     `commandmate ls` once a sync has re-scanned. Without --prepare-worktrees the
//     world is indistinguishable from unregistered_worktrees, which is what makes
//     the backward-compatibility case a real comparison.
//
// All four are hidden from `commandmate ls --json`; the first and the last are
// hidden from `git worktree list` too (and never created on disk up front).
function hiddenFromLs(scenario) {
  return [
    ...(scenario.unregistered_worktrees ?? []),
    ...(scenario.git_only_worktrees ?? []),
    ...(scenario.sync_only_worktrees ?? []),
    ...(scenario.prepare_worktrees ?? []),
  ].map(Number);
}

// The `ls --json` rows the runner resolves worktree ids from, one per plan issue
// CommandMate knows about.
function planToWorktrees(plan, pathOverrides = {}, hidden = []) {
  return plan.issues.filter((issue) => !hidden.includes(Number(issue.number))).map((issue) => ({
    id: worktreeIdFor(plan.profile.repository, issue.branch),
    name: issue.branch,
    branch: issue.branch,
    path: registeredPathFor(issue, pathOverrides),
  }));
}

// Create the integration cwd and one real worktree directory per issue, dropping
// the verify marker where `markerFor(issueNumber)` is true. The directory is
// created at the REGISTERED path (the `ls`-reported path, which may differ from
// the plan template) so a runner that cwd's into the template path instead finds
// nothing — the #1473 regression. Returns the integration directory the runner
// should be spawned in.
// `files` (Issue #114) is the worktree's CONTENT: `{ "<relative path>": "<text>" }`,
// written into every worktree that is created. It is what makes an acceptance
// gate measurable — `.commandmate/verify.yaml` declares the gate, and the
// deliverable the gate tests for is a file in this map. A mutation fixture is
// then the SAME case with one entry removed, so the difference between the green
// run and the red run is the artifact and nothing else (ADR §4 (2)).
function setupWorktrees(plan, work, markerFor, pathOverrides = {}, absent = [], files = {}) {
  const integration = join(work, 'integration');
  mkdirSync(integration, { recursive: true });
  for (const issue of plan.issues) {
    // An `unregistered_worktrees` issue has no worktree at all — not creating the
    // directory is the fixture's whole point (Issue #90).
    if (absent.includes(Number(issue.number))) continue;
    const dir = join(work, basename(registeredPathFor(issue, pathOverrides)));
    mkdirSync(dir, { recursive: true });
    if (markerFor(issue.number)) writeFileSync(join(dir, 'cmate-verify-ok'), 'ok');
    for (const [relative, content] of Object.entries(files)) {
      const target = join(dir, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    }
  }
  return integration;
}

function workerVerifyPasses(scenario, number) {
  const workers = scenario.workers ?? {};
  const spec = workers[number] ?? workers[String(number)] ?? {};
  return spec.verify === 'pass';
}

// Run dispatch.mjs against the fake CLI with a fully set-up worktree world.
// Returns { exit, stdout }; the dispatch-report.json lands in outDir.
//
// `opts` exists for the launcher-resolution suite only (Issue #37):
//   opts.launcher  string  -> passed as --cli instead of FAKE_CLI
//                  null    -> --cli is omitted entirely, so resolution falls
//                             through to $CM and then to the bare default
//   opts.env       extra environment entries (e.g. CM)
// and for the resume suite (Issue #98):
//   opts.resumeDir string  -> passed as --resume instead of --out, which is the
//                             one flag combination dispatch refuses
//   opts.reverifyDir string -> passed as --reverify instead of --out (Issue
//                             #121): the same "append into the prior run" flag
//                             shape, for the attempt that re-judges without
//                             sending
//   opts.state     string  -> a per-attempt CMATE_FAKE_STATE, so a second attempt
//                             starts from a fresh worker turn counter (the world
//                             it inherits is the worktrees on disk, not the fake's
//                             memory of how many turns a worker has taken)
// Every other caller gets the previous behaviour unchanged.
function runDispatchRunner(planPath, scenarioObject, work, outDir, extraArgs, logPath, opts = {}) {
  const plan = readPlan(planPath);
  const pathOverrides = scenarioObject.worktree_paths ?? {};
  const toPrepare = (scenarioObject.prepare_worktrees ?? []).map(Number);
  // A to-be-prepared worktree does not exist yet either: not creating the
  // directory up front is what makes "the provider created it" observable.
  const absent = [...(scenarioObject.unregistered_worktrees ?? []).map(Number), ...toPrepare];
  const syncOnly = (scenarioObject.sync_only_worktrees ?? []).map(Number);
  const scenario = { ...scenarioObject, worktrees: planToWorktrees(plan, pathOverrides, hiddenFromLs(scenarioObject)) };
  // The issue bodies generatePlan recorded beside this plan (Issue #176), handed to
  // the fake `gh issue view`. A scenario that declares its own `gh.issues` wins —
  // that is how a case models an issue whose body moved after the plan was
  // approved. A checked-in plan with no bodies file leaves `gh.issues` unset, and
  // the fake then fails the read, which is the honest answer for a world where
  // nobody said what the body is.
  const bodiesPath = join(dirname(planPath), ISSUE_BODIES_FILE);
  if (existsSync(bodiesPath)) {
    scenario.gh = { issues: JSON.parse(readFileSync(bodiesPath, 'utf8')), ...(scenarioObject.gh ?? {}) };
  }
  // The rows the `worktree-setup` provider may create (Issue #93). Handed to the
  // fake separately: it reveals them only once it has created them, and only to
  // `commandmate ls` once a sync has re-scanned.
  if (toPrepare.length > 0) {
    const hiddenFromPrepare = plan.issues.map((issue) => Number(issue.number)).filter((n) => !toPrepare.includes(n));
    scenario.prepared_worktrees = planToWorktrees(plan, pathOverrides, hiddenFromPrepare);
  }
  // The rows a `commandmate sync` makes visible (Issue #91): hidden from the
  // initial `ls`, handed to the fake separately so it can return them once the
  // server has been told to re-scan.
  if (syncOnly.length > 0) {
    const hiddenFromSync = plan.issues.map((issue) => Number(issue.number)).filter((n) => !syncOnly.includes(n));
    scenario.sync_worktrees = planToWorktrees(plan, pathOverrides, hiddenFromSync);
  }
  // A `git_only_worktrees` (or not-yet-synced) issue must still appear in `git
  // worktree list`: the worktree IS on disk, and the fake otherwise derives that
  // list from the (now shorter) `ls` rows.
  if ((scenarioObject.git_only_worktrees ?? []).length > 0 || syncOnly.length > 0) {
    scenario.git = {
      ...(scenarioObject.git ?? {}),
      worktrees: plan.issues
        .filter((issue) => !absent.includes(Number(issue.number)))
        .map((issue) => registeredPathFor(issue, pathOverrides)),
    };
  }
  const integration = setupWorktrees(plan, work, (n) => workerVerifyPasses(scenario, n), pathOverrides, absent, scenarioObject.worktree_files ?? {});
  const scenarioPath = join(work, 'dispatch-scenario.json');
  writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  const stateDir = opts.state ?? work;
  mkdirSync(stateDir, { recursive: true });
  const env = {
    ...baseEnv(),
    CMATE_FAKE_SCENARIO: scenarioPath,
    CMATE_FAKE_STATE: stateDir,
    // Per-run by default so an unattended case cannot collide with another case
    // (or with a real run on the developer's machine); the exclusivity suite
    // overrides it with a SHARED root, which is what makes a second run collide.
    CMATE_ORCHESTRATE_LOCK_DIR: join(work, 'locks'),
    ...(opts.env ?? {}),
  };
  if (logPath) env.CMATE_FAKE_LOG = logPath;
  const launcher = 'launcher' in opts ? opts.launcher : FAKE_CLI;
  // A case's dispatch_args may need the fake's own path (the `--worktree-setup`
  // provider is this same script under another subcommand), and a fixture cannot
  // know where the checkout lives. `FAKE_CLI` in an argument is that path.
  const resolvedExtra = extraArgs.map((arg) => String(arg).replace(/FAKE_CLI/g, FAKE_CLI));
  const args = [
    DISPATCH_RUNNER,
    '--plan', planPath,
    ...(launcher === null ? [] : ['--cli', launcher]),
    '--git', FAKE_CLI, '--gh', FAKE_CLI,
    ...(opts.reverifyDir
      ? ['--reverify', opts.reverifyDir]
      : (opts.resumeDir ? ['--resume', opts.resumeDir] : ['--out', outDir])),
    ...resolvedExtra,
  ];
  try {
    const stdout = execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, cwd: integration });
    return { exit: 0, stdout };
  } catch (error) {
    return { exit: error.status ?? 1, stdout: error.stdout ? error.stdout.toString() : '' };
  }
}

// =============================================================================
// Minimal JSON Schema validator (the subset the two schemas use)
// =============================================================================

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`unresolved $ref: ${ref}`);
  }
  return node;
}

function typeOk(type, value) {
  // JSON Schema allows a union of types (`"type": ["string", "null"]`), which the
  // acceptance-result schema uses for its optional fields.
  if (Array.isArray(type)) return type.some((member) => typeOk(member, value));
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function validate(schema, data, root, path, errors) {
  if (schema.$ref) {
    validate(resolveRef(root, schema.$ref), data, root, path, errors);
    return;
  }
  if (schema.oneOf) {
    const matched = schema.oneOf.filter((sub) => {
      const local = [];
      validate(sub, data, root, path, local);
      return local.length === 0;
    });
    if (matched.length === 0) errors.push(`${path}: matched none of oneOf`);
    return;
  }
  if (schema.const !== undefined && data !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path}: ${JSON.stringify(data)} not in enum`);
  }
  if (schema.type && !typeOk(schema.type, data)) {
    errors.push(`${path}: expected type ${schema.type}, got ${data === null ? 'null' : typeof data}`);
    return;
  }
  if (typeof data === 'string' && schema.pattern && !new RegExp(schema.pattern, 'u').test(data)) {
    errors.push(`${path}: "${data}" does not match /${schema.pattern}/`);
  }
  if (typeof data === 'string' && schema.minLength !== undefined && data.length < schema.minLength) {
    errors.push(`${path}: shorter than minLength ${schema.minLength}`);
  }
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && data > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${path}: fewer than minItems`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) errors.push(`${path}: more than maxItems`);
    if (schema.items) data.forEach((item, i) => validate(schema.items, item, root, `${path}[${i}]`, errors));
  }
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of schema.required ?? []) {
      if (!(key in data)) errors.push(`${path}: missing required "${key}"`);
    }
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!(key in props)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, subschema] of Object.entries(props)) {
      if (key in data) validate(subschema, data[key], root, `${path}/${key}`, errors);
    }
  }
}

function validateAgainst(schema, data, label) {
  const errors = [];
  validate(schema, data, schema, label, errors);
  return errors;
}

// =============================================================================
// Case running
// =============================================================================

function buildArgs(rawArgs, issuesPath, runsDir) {
  const args = rawArgs.map((arg) =>
    arg.startsWith('PROFILE:') ? join(PROFILES_DIR, arg.slice('PROFILE:'.length)) : arg,
  );
  return [...args, '--issue-json', issuesPath, '--runs-dir', runsDir];
}

function runRunner(args, cwd, env = baseEnv()) {
  try {
    const stdout = execFileSync('node', [RUNNER, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd, env });
    return { exit: 0, stdout };
  } catch (error) {
    // execFileSync throws on a non-zero exit; the result JSON is still on stdout.
    return { exit: error.status ?? 1, stdout: error.stdout ? error.stdout.toString() : '' };
  }
}

// The working directory a plan case runs the planner in (Issue #36). The default
// profile cross-checks `git remote get-url origin` against the repository it
// targets, so the cwd is a real fixture input: a throwaway repository with an
// injected origin, or a plain directory that is not a repository at all. A case
// without `cwd` inherits the harness's own directory and never reaches the probe
// (every such case names its profile explicitly).
function setupCaseCwd(spec) {
  if (!spec.cwd) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'cmate-orch-cwd-'));
  if (spec.cwd.git) {
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
    if (spec.cwd.origin) {
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', spec.cwd.origin], { stdio: 'ignore' });
    }
  }
  return dir;
}

function warningCodesOf(result) {
  return (result.warnings ?? []).map((w) => w.code);
}

function check(condition, message) {
  if (!condition) {
    failures += 1;
    log(`    FAIL ${message}`);
  }
  return condition;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function classificationsOf(plan) {
  const map = {};
  for (const issue of plan.issues) map[String(issue.number)] = issue.classification;
  return map;
}

function dependencyMatches(actual, expected) {
  return expected.every((exp) =>
    actual.some((dep) => dep.issue === exp.issue && dep.depends_on === exp.depends_on && dep.kind === exp.kind),
  );
}

function runCase(caseId) {
  const caseDir = join(CASES_DIR, caseId);
  const spec = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'));
  const issuesPath = join(caseDir, 'issues.json');
  log(`  ${caseId}: ${spec.description}`);

  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-orch-'));
  const cwd = setupCaseCwd(spec);
  const args = buildArgs(spec.args, issuesPath, runsDir);
  const { exit, stdout } = runRunner(args, cwd);

  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    check(false, `stdout is not valid JSON (exit ${exit}): ${stdout.slice(0, 200)}`);
    return;
  }

  const expect = spec.expect;
  check(exit === expect.exit, `exit ${exit} !== expected ${expect.exit}`);
  check(result.status === expect.status, `status "${result.status}" !== "${expect.status}"`);

  // The result envelope always conforms to its schema, success or failure.
  const resultErrors = validateAgainst(resultSchema, result, 'result');
  check(resultErrors.length === 0, `result schema: ${resultErrors.slice(0, 3).join('; ')}`);

  // Warning codes are the machine-readable half of a `partial`: an expectation of
  // exactly this set proves both that a real concern is raised and that a clean
  // run stays clean (no code is invented out of a skipped probe).
  if (expect.warning_codes) {
    check(
      deepEqual(warningCodesOf(result), expect.warning_codes),
      `warning codes ${JSON.stringify(warningCodesOf(result))} !== ${JSON.stringify(expect.warning_codes)}`,
    );
  }
  // A warning's DETAIL is what a reviewer acts on, and a detail that names the
  // wrong direction is worse than no warning at all (Issue #51). Each listed
  // substring must appear in some warning's detail.
  if (expect.warning_details_include) {
    const details = (result.warnings ?? []).map((w) => w.detail);
    for (const needle of expect.warning_details_include) {
      check(
        details.some((detail) => detail.includes(needle)),
        `no warning detail contains "${needle}"; details: ${JSON.stringify(details)}`,
      );
    }
  }

  if (expect.status === 'failure') {
    check(result.plan === null, 'plan should be null on failure');
    check(
      result.errors.some((e) => e.code === expect.error_code),
      `error code "${expect.error_code}" not in ${JSON.stringify(result.errors.map((e) => e.code))}`,
    );
    check(result.completion_check.passed === false, 'completion_check.passed should be false on failure');
    return;
  }

  const plan = result.plan;
  if (!check(plan !== null, 'plan should be present on success/partial')) return;

  // The plan conforms to its own schema.
  const planErrors = validateAgainst(planSchema, plan, 'plan');
  check(planErrors.length === 0, `plan schema: ${planErrors.slice(0, 3).join('; ')}`);

  if (expect.waves) check(deepEqual(plan.waves, expect.waves), `waves ${JSON.stringify(plan.waves)} !== ${JSON.stringify(expect.waves)}`);
  if (expect.merge_order) check(deepEqual(plan.merge_order, expect.merge_order), `merge_order ${JSON.stringify(plan.merge_order)} !== ${JSON.stringify(expect.merge_order)}`);
  if (expect.dependencies) {
    check(plan.dependencies.length === expect.dependencies.length, `dependency count ${plan.dependencies.length} !== ${expect.dependencies.length}`);
    check(dependencyMatches(plan.dependencies, expect.dependencies), `dependencies ${JSON.stringify(plan.dependencies)} do not match ${JSON.stringify(expect.dependencies)}`);
  }
  if (expect.classifications) {
    check(deepEqual(classificationsOf(plan), expect.classifications), `classifications ${JSON.stringify(classificationsOf(plan))} !== ${JSON.stringify(expect.classifications)}`);
  }
  // An edge's `reason` is the only place dependency-plan.md explains WHY the
  // planner read a body line the way it did. Keyed "<issue>:<depends_on>", each
  // listed substring must appear in that edge's reason, so a direction decided
  // from a body line can be re-derived from the artifact alone (Issue #51).
  if (expect.dependency_reasons_include) {
    for (const [key, needles] of Object.entries(expect.dependency_reasons_include)) {
      const [issue, dependsOn] = key.split(':').map(Number);
      const edge = plan.dependencies.find((d) => d.issue === issue && d.depends_on === dependsOn);
      if (check(edge !== undefined, `no dependency edge ${key} in ${JSON.stringify(plan.dependencies)}`)) {
        for (const needle of needles) {
          check(edge.reason.includes(needle), `edge ${key} reason "${edge.reason}" does not contain "${needle}"`);
        }
      }
    }
  }
  // Exact per-issue extraction: suspected_files IS the scope the worker will be
  // allowed to touch, so a case that pins it proves a named file is inside it.
  if (expect.suspected_files) {
    for (const [number, files] of Object.entries(expect.suspected_files)) {
      const issue = plan.issues.find((i) => i.number === Number(number));
      check(
        issue !== undefined && deepEqual(issue.suspected_files, files),
        `suspected_files of #${number} ${JSON.stringify(issue?.suspected_files)} !== ${JSON.stringify(files)}`,
      );
    }
  }
  // Planner-added lockfile allowances (#44): the plan must SAY which entries the
  // planner added, so a reviewer can tell them from the issue's own paths.
  if (expect.scope_defaults) {
    for (const [number, files] of Object.entries(expect.scope_defaults)) {
      const issue = plan.issues.find((i) => i.number === Number(number));
      check(
        issue !== undefined && deepEqual(issue.scope_defaults, files),
        `scope_defaults of #${number} ${JSON.stringify(issue?.scope_defaults)} !== ${JSON.stringify(files)}`,
      );
    }
  }
  // The other side of the same decision (#50): what the planner classified as
  // context to READ rather than a file to write. A case that pins both proves
  // the split, not just that something landed somewhere.
  if (expect.reference_files) {
    for (const [number, files] of Object.entries(expect.reference_files)) {
      const issue = plan.issues.find((i) => i.number === Number(number));
      check(
        issue !== undefined && deepEqual(issue.reference_files, files),
        `reference_files of #${number} ${JSON.stringify(issue?.reference_files)} !== ${JSON.stringify(files)}`,
      );
    }
  }
  // `issues[].questions` is the field DISPATCH reads to refuse an issue, and the
  // only place the planner's reason survives into the plan artifact. Two shapes are
  // asserted (Issue #145): the exact COUNT, because "one warning and one question"
  // is the contract an inferred question joins — a second copy would double-report a
  // single finding — and substrings, because the L3 question quotes the acceptance
  // criterion VERBATIM, which is what lets a reviewer confirm a false positive
  // without opening the issue. A warning detail containing the text is not the same
  // assertion: dispatch reads this field, not `warnings`.
  if (expect.questions_count) {
    for (const [number, count] of Object.entries(expect.questions_count)) {
      const issue = plan.issues.find((i) => i.number === Number(number));
      check(
        issue !== undefined && issue.questions.length === count,
        `questions of #${number} number ${issue?.questions.length} !== ${count}: ${JSON.stringify(issue?.questions)}`,
      );
    }
  }
  if (expect.questions_include) {
    for (const [number, needles] of Object.entries(expect.questions_include)) {
      const issue = plan.issues.find((i) => i.number === Number(number));
      if (check(issue !== undefined, `no issue #${number} in the plan`)) {
        for (const needle of needles) {
          check(
            issue.questions.some((question) => question.includes(needle)),
            `no question of #${number} contains "${needle}"; questions: ${JSON.stringify(issue.questions)}`,
          );
        }
      }
    }
  }
  // The machine-readable acceptance block (Issue #114), asserted exactly —
  // including `null`, which is what a body with no block and a body with a
  // BROKEN block both produce. The two are told apart by warning_codes, and a
  // case that pins both proves the planner never rounds one to the other.
  if (expect.acceptance_gates) {
    for (const [number, gates] of Object.entries(expect.acceptance_gates)) {
      const issue = plan.issues.find((i) => i.number === Number(number));
      check(
        issue !== undefined && deepEqual(issue.acceptance_gates, gates),
        `acceptance_gates of #${number} ${JSON.stringify(issue?.acceptance_gates)} !== ${JSON.stringify(gates)}`,
      );
    }
  }
  // Phase 0 item 3 of the ADR, pinned: the advisory command extraction must be
  // BYTE-IDENTICAL whether or not an acceptance-gates block sits above the code
  // fence it reads. The measured defect was the block's CLOSING fence pairing
  // with the next block's OPENING fence, which swallowed the following ```bash
  // block whole.
  if (expect.test_expectations) {
    for (const [number, commands] of Object.entries(expect.test_expectations)) {
      const issue = plan.issues.find((i) => i.number === Number(number));
      check(
        issue !== undefined && deepEqual(issue.test_expectations, commands),
        `test_expectations of #${number} ${JSON.stringify(issue?.test_expectations)} !== ${JSON.stringify(commands)}`,
      );
    }
  }
  if (expect.risk_level) check(plan.risk.level === expect.risk_level, `risk ${plan.risk.level} !== ${expect.risk_level}`);
  if (expect.profile_verified !== undefined) check(plan.profile.verified === expect.profile_verified, `profile.verified ${plan.profile.verified} !== ${expect.profile_verified}`);
  if (expect.base) check(plan.profile.base === expect.base, `base ${plan.profile.base} !== ${expect.base}`);

  // max_parallel is honored: no wave is wider than the bound.
  check(plan.waves.every((w) => w.length <= plan.max_parallel), `a wave exceeds max_parallel ${plan.max_parallel}`);

  // No wave contains a file-overlapping pair.
  const filesOf = (n) => new Set(plan.issues.find((i) => i.number === n).suspected_files);
  for (const wave of plan.waves) {
    for (let i = 0; i < wave.length; i += 1) {
      for (let j = i + 1; j < wave.length; j += 1) {
        const left = filesOf(wave[i]);
        check(![...filesOf(wave[j])].some((p) => left.has(p)), `wave ${JSON.stringify(wave)} has a file overlap`);
      }
    }
  }

  // The plan carries the same warnings the envelope reports; a reviewer reading
  // only the plan artifact must not miss a concern the result envelope raised.
  check(deepEqual(plan.warnings, result.warnings), 'plan.warnings and result.warnings disagree');

  // Determinism: a second run into a fresh directory — from the SAME working
  // directory, which is part of the input — yields the same plan.
  const runsDir2 = mkdtempSync(join(tmpdir(), 'cmate-orch-'));
  const second = runRunner(buildArgs(spec.args, issuesPath, runsDir2), cwd);
  const secondPlan = JSON.parse(second.stdout).plan;
  check(deepEqual(plan, secondPlan), 'plan is not deterministic across two runs');

  // Golden parity: an exact byte match against a checked-in expected plan.
  if (spec.golden) {
    const goldenPath = join(caseDir, spec.golden);
    if (check(existsSync(goldenPath), `golden ${spec.golden} is missing`)) {
      const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
      check(deepEqual(plan, golden), 'plan does not match the golden expected-plan.json');
    }
  }
}

// =============================================================================
// Dispatch cases: drive the supervision loop against a fake commandmate/git/gh
// =============================================================================

// Each dispatch case first generates a real plan from an issue fixture (proving
// the plan -> dispatch handoff), then runs dispatch.mjs against the fake CLI with
// an injected scenario, and asserts the report's status, the wave barrier, the
// verification gate, max_parallel, and — via the fake's invocation log — that
// prompts were never auto-answered.

function generatePlan(spec, runsDir) {
  const issuesPath = join(HERE, spec.plan.issues_fixture);
  // Force the fake profile so the plan's baseline is `cat cmate-verify-ok` — a
  // real, controllable command the worktree-based verification/UAT runs execute.
  const raw = spec.plan.orchestrate_args;
  const args = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '--profile' || raw[i] === '--profile-json') { i += 1; continue; }
    args.push(raw[i]);
  }
  // `plan.profile_json` names a different fixture profile when a case needs one
  // (e.g. a baseline long enough that the PR body has to cut its check list).
  const profile = spec.plan.profile_json ? join(PROFILES_DIR, spec.plan.profile_json) : NODE_FAKE_PROFILE;
  args.push('--profile-json', profile, '--issue-json', issuesPath, '--runs-dir', runsDir);
  runRunner(args); // exit code is irrelevant here; a partial plan is still a plan
  // The run id is pinned to "plan" by every dispatch case's orchestrate_args.
  // A resume case that needs a SECOND, different plan (to prove the run_id guard)
  // pins a different one and names it here.
  const planPath = join(runsDir, spec.plan.run_dir ?? 'plan', 'plan.json');
  // The bodies the plan was built from, dropped beside it (Issue #176). The
  // dispatch runner re-reads the issue body with `gh issue view` — the plan cannot
  // carry a prohibition it never extracted — so the fake `gh` has to answer with
  // the SAME body this plan came from. Writing it here, next to the plan, is what
  // makes that true for every one of the ~25 runDispatchRunner call sites at once:
  // a per-case knob would leave the ones nobody remembered serving a body that
  // disagrees with the plan, and a fixture that pins a contract against a
  // disagreement pins nothing.
  // Guarded: a planner that REFUSED (a cycle, an order violation) writes no run
  // directory at all, and the caller reports that missing plan itself. Throwing
  // here would replace that case's finding with an ENOENT from the harness.
  if (existsSync(dirname(planPath))) {
    writeFileSync(join(dirname(planPath), ISSUE_BODIES_FILE), `${JSON.stringify(issueBodiesFrom(issuesPath), null, 2)}\n`);
  }
  return planPath;
}

// `{ "<number>": "<body>" }` from a planner issue fixture, in the shape the fake
// `gh issue view` serves.
function issueBodiesFrom(issuesPath) {
  const bodies = {};
  const fixture = JSON.parse(readFileSync(issuesPath, 'utf8'));
  for (const issue of fixture.issues ?? []) bodies[String(issue.number)] = String(issue.body ?? '');
  return bodies;
}

function readCliLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function sentIssuesFromLog(cliLog) {
  const sent = [];
  for (const entry of cliLog) {
    if (entry.sub !== 'send') continue;
    // `send <worktree-id> <message>`: the id (first positional) carries the issue.
    const match = /issue-(\d+)/.exec(entry.args[0] ?? '');
    if (match) sent.push(Number(match[1]));
  }
  return sent;
}

// Every `commandmate send` this run made to one issue's worktree, in order. The
// first is the send that opened that worker's supervision (Issue #136).
function sendsTo(cliLog, number) {
  return cliLog.filter((entry) => entry.sub === 'send' && /issue-(\d+)/.exec(entry.args[0] ?? '')?.[1] === String(number));
}

// Does `args` contain `tokens` as a contiguous run, in order? Used to assert a
// flag AND its value (`--duration 1h`) rather than the flag alone.
function containsSequence(args, tokens) {
  if (tokens.length === 0) return true;
  for (let i = 0; i + tokens.length <= args.length; i += 1) {
    if (tokens.every((token, offset) => args[i + offset] === token)) return true;
  }
  return false;
}

// The issues a run handed to `commandmate verify <worktree-id> --json`. On the
// ordinary path that is only the confirming run after an exit-20 wait; on a
// `--reverify` attempt it IS the adjudication, so the list is what "which issues
// were re-judged" means (Issue #121).
function verifiedIssuesFromLog(cliLog) {
  const verified = [];
  for (const entry of cliLog) {
    if (entry.sub !== 'verify') continue;
    const match = /issue-(\d+)/.exec(entry.args[0] ?? '');
    if (match) verified.push(Number(match[1]));
  }
  return verified;
}

function allWorkers(report) {
  return report.waves.flatMap((wave) => wave.workers);
}

// CommandMate's task contract v1 is a CLOSED key set (docs/design/task-contract.md):
// an unknown top-level key is a contract error, not something the parser ignores.
const CONTRACT_TOP_LEVEL_KEYS = new Set(['version', 'title', 'goal', 'scope', 'verify', 'autoYes', 'success']);

// Structural conformance of a generated contract, checked without a YAML parser
// (this suite is Node-stdlib only). It asserts the properties whose violation
// makes `send --contract` exit 2: an off-contract key, a missing required key,
// and the `verify.gates: []` that the parser rejects outright.
function checkContractShape(text, label) {
  const topKeys = text
    .split('\n')
    .filter((line) => /^[A-Za-z]/.test(line))
    .map((line) => line.split(':')[0]);
  for (const key of topKeys) {
    check(CONTRACT_TOP_LEVEL_KEYS.has(key), `${label}: off-contract top-level key "${key}" (v1 is a closed set)`);
  }
  for (const required of ['version', 'title', 'goal', 'scope', 'autoYes', 'success']) {
    check(topKeys.includes(required), `${label}: missing required key "${required}"`);
  }
  check(/^version: 1$/m.test(text), `${label}: version must be 1`);
  check(!/gates:\s*\[\]/.test(text), `${label}: verify.gates: [] is a contract error`);
  // requireScopeClean true with an empty allow list is a contract error too.
  if (/^\s*requireScopeClean: true$/m.test(text)) {
    check(!/^\s*allow: \[\]$/m.test(text), `${label}: requireScopeClean is true but scope.allow is empty`);
  }
}

// Contract generation (#1588): byte-identical for the same plan, matching a
// checked-in golden, actually placed in the worktree, and actually named by the
// `send --contract` call. Determinism is proved by a SECOND dispatch of the same
// plan into a fresh world, so a generator that depended on a clock, on the
// filesystem or on iteration order would diverge here.
function checkContracts(spec, expect, planPath, scenarioObject, caseDir, outDir, cliLog) {
  const numbers = expect.contract_issues;
  const secondWork = mkdtempSync(join(tmpdir(), 'cmate-disp-det-'));
  const secondOut = join(secondWork, 'dispatch');
  runDispatchRunner(planPath, scenarioObject, secondWork, secondOut, spec.dispatch_args ?? [], null);

  for (const number of numbers) {
    const label = `contract #${number}`;
    const artifact = join(outDir, 'contracts', `issue-${number}.yaml`);
    if (!check(existsSync(artifact), `${label}: no artifact was written to <out>/contracts/`)) continue;
    const text = readFileSync(artifact, 'utf8');
    checkContractShape(text, label);

    const goldenPath = join(caseDir, 'contracts', `issue-${number}.yaml`);
    if (check(existsSync(goldenPath), `${label}: golden contracts/issue-${number}.yaml is missing`)) {
      check(text === readFileSync(goldenPath, 'utf8'), `${label}: does not match the golden contract byte for byte`);
    }

    // A golden pins EVERY byte, which also means a golden regenerated alongside a
    // wrong change still matches itself. These two say out loud what the contract
    // must and must not contain, so the semantic claims of a case (the union
    // written into verify.gates; the acceptance section absent for a block-less
    // issue) are readable in the case file rather than buried in the golden.
    for (const needle of (expect.contract_contains ?? {})[number] ?? []) {
      check(text.includes(needle), `${label}: does not contain ${JSON.stringify(needle)}`);
    }
    for (const needle of (expect.contract_absent ?? {})[number] ?? []) {
      check(!text.includes(needle), `${label}: unexpectedly contains ${JSON.stringify(needle)}`);
    }

    // Section ORDER, not just presence. Where a section sits is load-bearing:
    // the goal is truncated from the END, so a section that drifts down the
    // document is a section that can be silently cut, and a worker reads top to
    // bottom, so a method stated after the objective arrives too late
    // (Issue #128 / ADR §3.3).
    const order = (expect.contract_section_order ?? {})[number];
    if (order) {
      let previous = -1;
      let previousName = null;
      for (const section of order) {
        const at = text.indexOf(`\n  ${section}\n`);
        if (!check(at >= 0, `${label}: section "${section}" is missing from the goal`)) break;
        check(at > previous, `${label}: section "${section}" must come after "${previousName}" but does not`);
        previous = at;
        previousName = section;
      }
    }

    const repeatPath = join(secondOut, 'contracts', `issue-${number}.yaml`);
    if (check(existsSync(repeatPath), `${label}: missing on the determinism re-run`)) {
      check(text === readFileSync(repeatPath, 'utf8'), `${label}: is not byte-identical across two runs of the same plan`);
    }

    // The send must have named this contract; the fake exits 2 when the file is
    // not in the worktree, so a send that succeeded also proves it was placed.
    const relative = `.commandmate/tasks/cmate-orchestrate-issue-${number}.yaml`;
    const named = cliLog.some((entry) =>
      entry.sub === 'send' && /issue-(\d+)/.exec(entry.args[0] ?? '')?.[1] === String(number) && entry.args.includes(relative));
    check(named, `${label}: no "send --contract ${relative}" was logged for #${number}`);
  }
}

function runDispatchCase(caseId) {
  const caseDir = join(DISPATCH_CASES_DIR, caseId);
  const spec = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'));
  log(`  ${caseId}: ${spec.description}`);

  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-disp-plan-'));
  const planPath = generatePlan(spec, runsDir);
  if (!check(existsSync(planPath), `plan.json was not generated at ${planPath}`)) return;

  const work = mkdtempSync(join(tmpdir(), 'cmate-disp-'));
  const outDir = join(work, 'dispatch'); // must not pre-exist; dispatch creates it
  const logPath = join(work, 'cli.log');
  const scenarioObject = JSON.parse(readFileSync(join(caseDir, spec.scenario), 'utf8'));

  const { exit, stdout } = runDispatchRunner(planPath, scenarioObject, work, outDir, spec.dispatch_args ?? [], logPath);
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    check(false, `dispatch stdout is not valid JSON (exit ${exit}): ${stdout.slice(0, 200)}`);
    return;
  }

  const expect = spec.expect;
  check(exit === expect.exit, `exit ${exit} !== expected ${expect.exit}`);

  const schemaErrors = validateAgainst(dispatchSchema, report, 'dispatch');
  check(schemaErrors.length === 0, `dispatch schema: ${schemaErrors.slice(0, 3).join('; ')}`);

  check(report.status === expect.status, `status "${report.status}" !== "${expect.status}"`);
  check(report.stop_reason === expect.stop_reason, `stop_reason "${report.stop_reason}" !== "${expect.stop_reason}"`);
  if (expect.human_required !== undefined) {
    check(report.human_required === expect.human_required, `human_required ${report.human_required} !== ${expect.human_required}`);
  }
  if (expect.waves_count !== undefined) {
    check(report.waves.length === expect.waves_count, `waves ${report.waves.length} !== ${expect.waves_count}`);
  }

  // Issue #90: a refusal that happens BEFORE the first wave must not consume the
  // output directory. `--out` is the one input an operator cannot repeat once it
  // exists (`out_exists`), so a run directory left behind by a stop that
  // dispatched nothing turns a one-line fix (create the worktree) into "invent a
  // new --out". The report says the same thing with `out_dir: null`.
  if (expect.out_dir_created !== undefined) {
    check(existsSync(outDir) === expect.out_dir_created,
      `outDir ${existsSync(outDir) ? 'was created' : 'was not created'}, expected created=${expect.out_dir_created}`);
    if (expect.out_dir_created === false) {
      check(report.out_dir === null, `report.out_dir should be null when nothing was written, got ${JSON.stringify(report.out_dir)}`);
    }
  }
  // The empty-truth guard (Issue #90 item 6): a run that dispatched nobody must
  // not self-report a passed completion check just because every invariant it
  // checks is vacuously true.
  if (expect.completion_check_passed !== undefined) {
    check(report.completion_check.passed === expect.completion_check_passed,
      `completion_check.passed ${report.completion_check.passed} !== ${expect.completion_check_passed}`);
  }
  // The re-run the refusal is supposed to leave possible: the SAME command, the
  // same `--out`, with every worktree now registered. It must run to completion
  // instead of dying on `out_exists`.
  if (expect.rerun_when_registered) {
    const rerunScenario = { ...scenarioObject };
    delete rerunScenario.unregistered_worktrees;
    delete rerunScenario.git_only_worktrees;
    delete rerunScenario.sync_only_worktrees;
    delete rerunScenario.prepare_worktrees;
    const rerun = runDispatchRunner(planPath, rerunScenario, work, outDir, spec.dispatch_args ?? [], null);
    check(rerun.exit === expect.rerun_when_registered.exit,
      `re-run with the same --out exited ${rerun.exit} !== ${expect.rerun_when_registered.exit}`);
    let rerunReport = null;
    try {
      rerunReport = JSON.parse(rerun.stdout);
    } catch {
      check(false, `re-run stdout is not valid JSON: ${rerun.stdout.slice(0, 200)}`);
    }
    if (rerunReport) {
      check(rerunReport.status === expect.rerun_when_registered.status,
        `re-run status "${rerunReport.status}" !== "${expect.rerun_when_registered.status}"`);
      check(!rerunReport.blocking_reasons.some((entry) => entry.code === 'out_exists'),
        'the re-run was refused with out_exists: the first run consumed --out');
      check(existsSync(join(outDir, 'dispatch-report.json')), 'the re-run wrote no dispatch-report.json');
    }
  }

  // The same shape for the worker-method refusal (Issue #128 / ADR §3.4): the
  // stop is only cheap if `commandmate skill install <id>` + the SAME command
  // gets the operator all the way through. The re-run adds the Skill to both
  // roots of every worktree and changes nothing else — same plan, same `--out`,
  // same argv. A refusal that had consumed `--out` dies here on `out_exists`.
  if (expect.rerun_when_installed) {
    const skill = 'cmate-worker-development';
    const body = `# ${skill}\n\nInstalled between the refusal and the re-run.\n`;
    const rerunScenario = {
      ...scenarioObject,
      worktree_files: {
        ...(scenarioObject.worktree_files ?? {}),
        [`.claude/skills/${skill}/SKILL.md`]: body,
        [`.agents/skills/${skill}/SKILL.md`]: body,
      },
    };
    const rerun = runDispatchRunner(planPath, rerunScenario, work, outDir, spec.dispatch_args ?? [], null);
    check(rerun.exit === expect.rerun_when_installed.exit,
      `re-run after installing the skill exited ${rerun.exit} !== ${expect.rerun_when_installed.exit}`);
    let rerunReport = null;
    try {
      rerunReport = JSON.parse(rerun.stdout);
    } catch {
      check(false, `re-run stdout is not valid JSON: ${rerun.stdout.slice(0, 200)}`);
    }
    if (rerunReport) {
      check(rerunReport.status === expect.rerun_when_installed.status,
        `re-run status "${rerunReport.status}" !== "${expect.rerun_when_installed.status}"`);
      check(!rerunReport.blocking_reasons.some((entry) => entry.code === 'out_exists'),
        'the re-run was refused with out_exists: the refusal consumed --out');
      check(!rerunReport.blocking_reasons.some((entry) => entry.code === 'worker_method_unavailable'),
        'the re-run still reports worker_method_unavailable after the skill was installed in both roots');
      check(rerunReport.limitations.some((entry) => entry.code === 'worker_method_applied'),
        'the re-run dispatched without recording worker_method_applied');
      check(existsSync(join(outDir, 'dispatch-report.json')), 'the re-run wrote no dispatch-report.json');
    }
  }

  // The two-point measurement `--unattended` has to survive (Issue #122 /
  // ADR §12.1 (2)). The SAME world is dispatched twice — once with the flag and
  // once with `spec.unattended_parity.dispatch_args`, which is the same argv
  // minus the unattended-only flags — and the two reports must agree on
  // everything except the two limitations the mode records.
  //
  // This is the mechanical proof of "unattended relaxes nothing", and it is
  // strictly stronger than any self-report: a runner that quietly downgraded a
  // blocking reason, skipped a gate, advanced a wave it should not have or
  // rounded a status up would differ here, while a `relaxed_nothing: true`
  // field would still be written by the implementation that did all four.
  if (spec.unattended_parity) {
    const parityWork = mkdtempSync(join(tmpdir(), 'cmate-disp-parity-'));
    const parity = runDispatchRunner(
      planPath, scenarioObject, parityWork, join(parityWork, 'dispatch'), spec.unattended_parity.dispatch_args, null,
    );
    let plain = null;
    try {
      plain = JSON.parse(parity.stdout);
    } catch {
      check(false, `the without-flag twin printed no report (exit ${parity.exit}): ${parity.stdout.slice(0, 200)}`);
    }
    if (plain) {
      check(parity.exit === exit, `unattended exit ${exit} !== the without-flag twin's ${parity.exit}`);
      check(plain.status === report.status, `unattended status "${report.status}" !== the twin's "${plain.status}"`);
      check(plain.stop_reason === report.stop_reason, `unattended stop_reason "${report.stop_reason}" !== the twin's "${plain.stop_reason}"`);
      check(plain.human_required === report.human_required, `unattended human_required ${report.human_required} !== the twin's ${plain.human_required}`);
      check(deepEqual(plain.waves, report.waves), 'unattended waves[] differ from the without-flag twin');
      check(deepEqual(plain.blocking_reasons, report.blocking_reasons), 'unattended blocking_reasons differ from the without-flag twin');
      check(deepEqual(plain.drift_checks, report.drift_checks), 'unattended drift_checks differ from the without-flag twin');
      check(deepEqual(plain.completion_check, report.completion_check), 'unattended completion_check differs from the without-flag twin');
      // A redaction the twin did not make would mean the mode wrote an absolute
      // path (or a token) into the report — the one way these two limitations
      // could smuggle in a third difference.
      check(deepEqual(plain.redactions, report.redactions), 'unattended redactions differ from the without-flag twin');

      const key = (entry) => `${entry.code} ${entry.detail}`;
      const twinKeys = new Set(plain.limitations.map(key));
      const runKeys = new Set(report.limitations.map(key));
      const missing = plain.limitations.filter((entry) => !runKeys.has(key(entry)));
      check(missing.length === 0,
        `unattended dropped limitation(s) the twin recorded: ${JSON.stringify(missing.map((entry) => entry.code))}`);
      const extraCodes = [...new Set(report.limitations.filter((entry) => !twinKeys.has(key(entry))).map((entry) => entry.code))].sort();
      check(deepEqual(extraCodes, ['unattended_baseline', 'unattended_mode']),
        `the only limitations --unattended may add are unattended_mode / unattended_baseline; it added ${JSON.stringify(extraCodes)}`);
    }
  }

  // max_parallel is never exceeded in any dispatched wave — the core guarantee.
  check(report.waves.every((wave) => wave.dispatched.length <= report.max_parallel), `a wave dispatched more than max_parallel ${report.max_parallel}`);
  if (expect.max_dispatched_per_wave !== undefined) {
    check(report.waves.every((wave) => wave.dispatched.length <= expect.max_dispatched_per_wave), `a wave dispatched more than ${expect.max_dispatched_per_wave}`);
  }

  const cliLog = readCliLog(logPath);
  const sent = sentIssuesFromLog(cliLog);
  const respondCount = cliLog.filter((entry) => entry.sub === 'respond').length;

  // How many times a given commandmate subcommand was reached for. This is the
  // only place `commandmate sync` is visible at all: whether the worktree registry
  // was re-scanned — and that it was re-scanned exactly ONCE per run rather than
  // once per unresolved branch — cannot be read off the report (Issue #91).
  if (expect.cli_subcommand_counts) {
    for (const [name, count] of Object.entries(expect.cli_subcommand_counts)) {
      const actual = cliLog.filter((entry) => entry.sub === name).length;
      check(actual === count, `commandmate ${name} was called ${actual} time(s) !== ${count}`);
    }
  }

  if (expect.no_respond) check(respondCount === 0, `respond was called ${respondCount} time(s) on a no-auto-response path`);
  if (expect.expect_respond) check(respondCount >= 1, 'respond was never called on the auto-yes path');
  for (const number of expect.never_sent ?? []) check(!sent.includes(number), `#${number} was dispatched but the barrier should have stopped it`);
  for (const number of expect.sent ?? []) check(sent.includes(number), `#${number} should have been dispatched`);

  // Per-issue send count proves the supervision loop: a worker driven to a commit
  // over N turns is sent N times (initial dispatch + nudges / a re-sent unconfirmed
  // send), while a one-turn worker is sent exactly once (Issue #1468).
  if (expect.send_counts) {
    for (const [num, count] of Object.entries(expect.send_counts)) {
      const actual = sent.filter((n) => n === Number(num)).length;
      check(actual === count, `#${num} was sent ${actual} time(s) !== ${count}`);
    }
  }
  // Content of a sent message (#44): at least one message sent to the issue's
  // worker must contain ALL the listed substrings — used to prove the scope-gate
  // re-instruction transcribes the violating paths and the where-to-fix guidance.
  if (expect.sent_message_includes) {
    for (const [num, needles] of Object.entries(expect.sent_message_includes)) {
      const messages = cliLog
        .filter((entry) => entry.sub === 'send' && /issue-(\d+)/.exec(entry.args[0] ?? '')?.[1] === String(num))
        .map((entry) => String(entry.args[1] ?? ''));
      check(
        messages.some((message) => needles.every((needle) => message.includes(needle))),
        `#${num}: no sent message contains all of ${JSON.stringify(needles)}; sent: ${JSON.stringify(messages.map((m) => m.slice(0, 300)))}`,
      );
    }
  }
  // The argv of the send that OPENED a worker's supervision (Issue #136). The
  // worktree auto-yes state — the one the server's Auto-Yes poller checks before
  // it reads any policy at all (ADR §14.6) — is enabled by `commandmate send
  // --auto-yes` and by nothing else, so the contract's `autoYes.mode` cannot be
  // the evidence that `--auto-yes` did anything. What the fake CLI received can.
  //
  // The tokens are matched IN ORDER and CONTIGUOUSLY, which is what makes
  // `--duration <value>` a measurement of the value rather than of the flag: a
  // runner that armed 8h where the case says 1h fails here.
  if (expect.dispatch_send_args) {
    for (const [num, tokens] of Object.entries(expect.dispatch_send_args)) {
      const sends = sendsTo(cliLog, num);
      if (!check(sends.length > 0, `#${num} was never sent, so no send argv can carry ${JSON.stringify(tokens)}`)) continue;
      check(containsSequence(sends[0].args, tokens),
        `#${num}: the dispatch send argv ${JSON.stringify(sends[0].args)} does not contain ${JSON.stringify(tokens)} in order`);
    }
  }
  // What the SERVER's Auto-Yes poller did with a prompt (Issue #136). This is the
  // assertion the issue's correction is about: `--auto-yes` on the send enables
  // the state, but the contract's policy decides the prompt's TYPE, and
  // `mode: safe` refuses `multiple_choice` — the type Claude's permission menu
  // raises. The verdicts are the resolver's own vocabulary: `answered`,
  // `type-not-allowed`, `mode-off`, `not-answerable`, `not-enabled`.
  //
  // A prompt the poller answered never reaches the runner, so this cannot be
  // confused with the runner's own `--auto-yes` path (`no_respond` pins that half).
  if (expect.auto_yes_poller) {
    for (const [num, verdict] of Object.entries(expect.auto_yes_poller)) {
      const events = cliLog.filter((entry) => entry.sub === 'auto-yes-poller'
        && /issue-(\d+)/.exec(entry.args[0] ?? '')?.[1] === String(num));
      if (!check(events.length > 0, `#${num}: the auto-yes poller never judged a prompt`)) continue;
      const last = events[events.length - 1];
      check(last.args[1] === verdict,
        `#${num}: the poller's verdict was "${last.args[1]}" (type ${last.args[2]}, contract mode ${last.args[3]}) !== "${verdict}"`);
    }
  }

  // The other half of the two-point measurement: a run that did NOT ask for
  // auto-yes must not arm it on any send — not on the dispatch send, not on a
  // nudge, not on a re-instruction. Asserted over every send to the issue, so a
  // runner that armed "just once more, later" is caught too.
  if (expect.absent_send_args) {
    for (const [num, tokens] of Object.entries(expect.absent_send_args)) {
      const sends = sendsTo(cliLog, num);
      if (!check(sends.length > 0, `#${num} was never sent, so the absence of ${JSON.stringify(tokens)} would be vacuous`)) continue;
      for (const token of tokens) {
        const carrying = sends.filter((entry) => entry.args.includes(token));
        check(carrying.length === 0,
          `#${num}: ${carrying.length} send(s) carry ${token} on a run that never asked for it: ${JSON.stringify(carrying[0]?.args ?? [])}`);
      }
    }
  }

  // Per-issue worker_state: a worker that never commits within --max-turns is
  // recorded as failed (an honest non-completion), never as completed.
  if (expect.worker_states) {
    for (const [num, state] of Object.entries(expect.worker_states)) {
      const worker = allWorkers(report).find((w) => w.issue === Number(num));
      check(worker !== undefined, `#${num} has no worker record`);
      if (worker) check(worker.worker_state === state, `#${num} worker_state "${worker.worker_state}" !== "${state}"`);
    }
  }

  // The worker `note` is the half of the record a human actually reads. Pinning
  // its text is what proves the verification sentence is rendered from the
  // recorded verdict and not composed independently (Issue #83).
  if (expect.worker_notes_include) {
    for (const [num, needles] of Object.entries(expect.worker_notes_include)) {
      const worker = allWorkers(report).find((w) => w.issue === Number(num));
      if (check(worker !== undefined, `#${num} has no worker record`)) {
        for (const needle of needles) {
          check(String(worker.note ?? '').includes(needle), `#${num} note ${JSON.stringify(worker.note)} does not contain "${needle}"`);
        }
      }
    }
  }
  for (const id of expect.completion_checks_failed ?? []) {
    const entry = report.completion_check.checks.find((c) => c.id === id);
    if (check(entry !== undefined, `completion_check is missing "${id}"`)) {
      check(entry.passed === false, `completion check "${id}" passed, but the case expects it to fail`);
    }
  }

  if (expect.advanced) {
    report.waves.forEach((wave, index) => {
      if (index < expect.advanced.length) {
        check(wave.barrier.advanced === expect.advanced[index], `wave ${index} advanced ${wave.barrier.advanced} !== ${expect.advanced[index]}`);
      }
    });
  }
  if (expect.wave0_all_workers_completed !== undefined) {
    check(report.waves[0].barrier.all_workers_completed === expect.wave0_all_workers_completed, 'wave0 all_workers_completed mismatch');
  }
  if (expect.wave0_all_verifications_passed !== undefined) {
    check(report.waves[0].barrier.all_verifications_passed === expect.wave0_all_verifications_passed, 'wave0 all_verifications_passed mismatch');
  }
  if (expect.wave0_advanced !== undefined) {
    check(report.waves[0].barrier.advanced === expect.wave0_advanced, 'wave0 advanced mismatch');
  }
  for (const number of expect.prompt_detected ?? []) {
    const detected = allWorkers(report).filter((worker) => worker.prompt.detected).map((worker) => worker.issue);
    check(detected.includes(number), `#${number} prompt was not detected`);
  }
  // Worker completion is never conflated with verification success: a worker can
  // be "completed" while its verification did not pass.
  for (const number of expect.completed_but_unverified ?? []) {
    const conflated = allWorkers(report).filter((worker) => worker.worker_state === 'completed' && worker.verification.outcome !== 'pass').map((worker) => worker.issue);
    check(conflated.includes(number), `#${number} was not recorded as completed-but-unverified`);
  }

  // Parallel supervision crossover (#1474): the early worker's dispatch send must
  // land in the log before the late (multi-turn) worker's FINAL send. Under the
  // old sequential supervision the late worker was driven fully to completion
  // before the early worker was dispatched, so every one of its sends would
  // precede the early worker's — the crossover proves the wave is supervised
  // concurrently, bounded by max_parallel.
  if (expect.parallel_send_crossover) {
    const { early, late } = expect.parallel_send_crossover;
    const sendIndicesFor = (n) => cliLog
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.sub === 'send' && /issue-(\d+)/.exec(entry.args[0] ?? '')?.[1] === String(n))
      .map(({ index }) => index);
    const earlyIdx = sendIndicesFor(early);
    const lateIdx = sendIndicesFor(late);
    if (check(earlyIdx.length > 0 && lateIdx.length > 0, `parallel crossover: missing sends for #${early}/#${late}`)) {
      check(
        Math.min(...earlyIdx) < Math.max(...lateIdx),
        `parallel crossover: #${early} first send (idx ${Math.min(...earlyIdx)}) should precede #${late} last send (idx ${Math.max(...lateIdx)}) — sequential supervision detected`,
      );
    }
  }

  // Drift limitations that must NOT be recorded (#1473): a worktree registered at
  // a non-template path but resolvable by branch via `commandmate ls` must not be
  // reported as a missing worktree.
  for (const code of expect.absent_limitation_codes ?? []) {
    check(!report.limitations.some((entry) => entry.code === code), `limitation "${code}" should be absent but was recorded`);
  }
  // The version gate is never silent: falling back to the profile baseline, or
  // refusing to fall back, is stated in the report (#1588).
  for (const code of expect.limitation_codes ?? []) {
    check(report.limitations.some((entry) => entry.code === code), `limitation "${code}" was expected but not recorded`);
  }
  // A limitation's DETAIL is where the worktree-preparation evidence lives
  // (Issue #93): which branch, from which base SHA, with which baseline verdict.
  // A code alone would prove the stage ran, not what it produced.
  if (expect.limitation_details_include) {
    const details = report.limitations.map((entry) => entry.detail);
    for (const needle of expect.limitation_details_include) {
      check(details.some((detail) => detail.includes(needle)), `no limitation detail contains "${needle}"; details: ${JSON.stringify(details)}`);
    }
  }
  // The arguments a composed step was actually invoked with. "Pass the same
  // profile to both" means the plan's profile and base reach the worktree-setup
  // provider, and no field of the report can show that (Issue #93).
  if (expect.cli_args_include) {
    for (const [name, needles] of Object.entries(expect.cli_args_include)) {
      const calls = cliLog.filter((entry) => entry.sub === name).map((entry) => entry.args.map(String));
      check(
        calls.some((args) => needles.every((needle) => args.includes(needle))),
        `no "${name}" invocation carried all of ${JSON.stringify(needles)}; calls: ${JSON.stringify(calls)}`,
      );
    }
  }
  // The structured preparation evidence written beside the report (Issue #93).
  if (expect.prepared_artifact) {
    const artifactPath = join(outDir, 'worktree-setup', 'prepared.json');
    if (check(existsSync(artifactPath), 'no <out>/worktree-setup/prepared.json was written')) {
      let artifact = null;
      try {
        artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
      } catch {
        check(false, 'prepared.json is not valid JSON');
      }
      if (artifact) {
        for (const key of ['requested', 'prepared', 'missing']) {
          if (expect.prepared_artifact[key] === undefined) continue;
          check(deepEqual(artifact[key], expect.prepared_artifact[key]),
            `prepared.json ${key} ${JSON.stringify(artifact[key])} !== ${JSON.stringify(expect.prepared_artifact[key])}`);
        }
        for (const expected of expect.prepared_artifact.worktrees ?? []) {
          const row = (artifact.worktrees ?? []).find((entry) => entry.issue === expected.issue);
          if (check(row !== undefined, `prepared.json has no worktree entry for #${expected.issue}`)) {
            for (const [key, value] of Object.entries(expected)) {
              check(deepEqual(row[key], value), `prepared.json #${expected.issue} ${key} ${JSON.stringify(row[key])} !== ${JSON.stringify(value)}`);
            }
          }
        }
      }
    }
  }
  for (const code of expect.blocking_codes ?? []) {
    check(report.blocking_reasons.some((entry) => entry.code === code), `blocking reason "${code}" was expected but not recorded`);
  }
  for (const code of expect.absent_blocking_codes ?? []) {
    check(!report.blocking_reasons.some((entry) => entry.code === code), `blocking reason "${code}" should be absent but was recorded`);
  }
  // A blocking reason's DETAIL is what an operator acts on: a refusal that names
  // only a code cannot tell them what to write in the issue (Issue #52).
  if (expect.blocking_details_include) {
    const details = report.blocking_reasons.map((entry) => entry.detail);
    for (const needle of expect.blocking_details_include) {
      check(details.some((detail) => detail.includes(needle)), `no blocking detail contains "${needle}"; details: ${JSON.stringify(details)}`);
    }
  }
  // The human-facing half of the same finding. `summary_markdown` is what a
  // reviewer reads first, so a fact that only exists in the JSON is not reported.
  if (expect.summary_includes) {
    for (const needle of expect.summary_includes) {
      check(report.summary_markdown.includes(needle), `dispatch summary does not contain "${needle}"`);
    }
  }
  // An opt-in stage that was not opted into must leave no trace: a section about
  // worktree preparation in a run that never prepared anything would be the
  // report claiming work nobody asked for (Issue #93).
  if (expect.summary_excludes) {
    for (const needle of expect.summary_excludes) {
      check(!report.summary_markdown.includes(needle), `dispatch summary should not contain "${needle}"`);
    }
  }

  // ---- #93 invariant, asserted on EVERY dispatch case -----------------------
  //
  // The dispatch runner composes cmate-worktree-setup; it never creates a
  // worktree itself. Collision detection, the base-SHA re-confirmation and the
  // baseline all live in that Skill, and a second implementation here is one that
  // only gets fixed in one place. Asserted unconditionally, including on the
  // --prepare-worktrees cases where a worktree really does appear mid-run: there,
  // the `git worktree add` belongs to the provider process, never to this runner.
  const worktreeAdds = cliLog.filter((entry) => entry.sub === 'worktree' && entry.args[0] === 'add');
  check(worktreeAdds.length === 0,
    `dispatch called git worktree add ${worktreeAdds.length} time(s); creating worktrees belongs to cmate-worktree-setup`);

  // ---- #83 invariants, asserted on EVERY dispatch case ----------------------
  //
  // A case-by-case expectation would not have caught #83: every fixture that
  // named a verification outcome was a fixture whose wave completed, which is
  // exactly the shape where the bug does not appear. These two run unconditionally
  // instead, so any case whose report contradicts itself fails without anyone
  // having to have predicted it.
  //
  //  1. The note never claims a verification result the structured field does not.
  //     #83 shipped reports whose note said "verification passed" beside
  //     `"outcome": "not_run"`, and merge/uat believe the field — so the report's
  //     wording alone decided whether verified work was delivered.
  //  2. A completed worker always carries the verdict that judged it. `ran: false`
  //     on a completed worker is the runner losing the verdict, and it must fail
  //     the `verification_recorded` completion check rather than pass quietly.
  for (const worker of allWorkers(report)) {
    const note = String(worker.note ?? '');
    if (/verification passed/.test(note)) {
      check(
        worker.verification.outcome === 'pass',
        `#${worker.issue}: note claims "verification passed" but verification.outcome is "${worker.verification.outcome}" (note: ${JSON.stringify(note)})`,
      );
    }
    if (/verification failed/.test(note)) {
      check(
        worker.verification.outcome === 'fail',
        `#${worker.issue}: note claims "verification failed" but verification.outcome is "${worker.verification.outcome}" (note: ${JSON.stringify(note)})`,
      );
    }
    if (worker.worker_state === 'completed' && worker.verification.ran === false) {
      const gate = report.completion_check.checks.find((entry) => entry.id === 'verification_recorded');
      check(
        gate !== undefined && gate.passed === false,
        `#${worker.issue}: completed with verification.ran false, but the verification_recorded completion check did not fail`,
      );
    }
  }
  // The completion check itself is part of the report contract, not an optional
  // extra: a run that drops it can no longer report the defect above at all.
  check(
    report.completion_check.checks.some((entry) => entry.id === 'verification_recorded'),
    'completion_check is missing verification_recorded',
  );

  // Contract adjudication (#1588). The per-issue verification outcome is asserted
  // separately from worker_state so a case cannot pass with the two conflated —
  // in particular exit 99 must land as `not_run` (not judged), never as `fail`
  // (judged and failed) and never as `pass`.
  for (const [num, outcome] of Object.entries(expect.verification_outcomes ?? {})) {
    const worker = allWorkers(report).find((w) => w.issue === Number(num));
    if (check(worker !== undefined, `#${num} has no worker record`)) {
      check(worker.verification.outcome === outcome, `#${num} verification.outcome "${worker.verification.outcome}" !== "${outcome}"`);
    }
  }
  // Per-issue executed gates (#47 / #1678 B-5): the report alone must say WHICH
  // gates judged the work and each gate's verdict, transcribed from the wait
  // --verify GATE lines. Asserted exactly, so an invented or dropped gate fails.
  for (const [num, gates] of Object.entries(expect.verification_gates ?? {})) {
    const worker = allWorkers(report).find((w) => w.issue === Number(num));
    if (check(worker !== undefined, `#${num} has no worker record`)) {
      check(
        deepEqual(worker.verification.gates, gates),
        `#${num} verification.gates ${JSON.stringify(worker.verification.gates)} !== ${JSON.stringify(gates)}`,
      );
    }
  }
  // Why a run was red. A two-point acceptance-gate measurement is worthless
  // unless the red run is red for the RIGHT reason (ADR §4 (3)): exit 20 — a gate
  // judged the work and failed — and not 21/99/124/2, which mean the gate never
  // reached a verdict. The exit code is quoted verbatim in `checks`, and the
  // failing gate id is named there too, so pinning substrings here pins both.
  for (const [num, needles] of Object.entries(expect.verification_checks_include ?? {})) {
    const worker = allWorkers(report).find((w) => w.issue === Number(num));
    if (check(worker !== undefined, `#${num} has no worker record`)) {
      const checksText = (worker.verification.checks ?? []).join(' | ');
      for (const needle of needles) {
        check(checksText.includes(needle), `#${num} verification.checks ${JSON.stringify(worker.verification.checks)} does not contain "${needle}"`);
      }
    }
  }
  for (const [num, taskId] of Object.entries(expect.task_ids ?? {})) {
    const worker = allWorkers(report).find((w) => w.issue === Number(num));
    if (check(worker !== undefined, `#${num} has no worker record`)) {
      check(worker.task_id === taskId, `#${num} task_id ${JSON.stringify(worker.task_id)} !== ${JSON.stringify(taskId)}`);
    }
  }
  // `commandmate verify --json` names the failing gates of a 20. It must NOT be
  // reached by a 99: "we could not judge" is not a verification failure to fix.
  const verifyCalls = cliLog.filter((entry) => entry.sub === 'verify').length;
  if (expect.verify_calls !== undefined) {
    check(verifyCalls === expect.verify_calls, `commandmate verify was called ${verifyCalls} time(s) !== ${expect.verify_calls}`);
  }
  const waitVerifyCalls = cliLog.filter((entry) => entry.sub === 'wait' && entry.args.includes('--verify')).length;
  if (expect.wait_verify_calls_min !== undefined) {
    check(waitVerifyCalls >= expect.wait_verify_calls_min, `wait --verify was called ${waitVerifyCalls} time(s) < ${expect.wait_verify_calls_min}`);
  }
  // The fallback path must stay the pre-contract path: no --contract, no --verify.
  if (expect.no_contract_calls) {
    const contractSends = cliLog.filter((entry) => entry.sub === 'send' && entry.args.includes('--contract')).length;
    check(contractSends === 0, `send --contract was called ${contractSends} time(s) on the fallback path`);
    check(waitVerifyCalls === 0, `wait --verify was called ${waitVerifyCalls} time(s) on the fallback path`);
    check(verifyCalls === 0, `commandmate verify was called ${verifyCalls} time(s) on the fallback path`);
  }
  if (expect.contract_issues) {
    checkContracts(spec, expect, planPath, scenarioObject, caseDir, outDir, cliLog);
  }

  // The prompt artifact — `<out>/prompts/issue-<n>.md`, the file that shows what
  // the worker was actually given. On the contract path it holds the goal; on the
  // fallback path it holds the worker prompt, which is the ONLY place that second
  // generator's output is inspectable after the run (Issue #128 / ADR §1.2: a
  // section written into only one of the two generators disappears exactly on the
  // `--contract-mode auto` fallback, where nobody is looking).
  for (const [num, needles] of Object.entries(expect.prompt_artifact_contains ?? {})) {
    const promptPath = join(outDir, 'prompts', `issue-${num}.md`);
    if (check(existsSync(promptPath), `no <out>/prompts/issue-${num}.md was written`)) {
      const text = readFileSync(promptPath, 'utf8');
      for (const needle of needles) {
        check(text.includes(needle), `prompts/issue-${num}.md does not contain ${JSON.stringify(needle)}`);
      }
    }
  }
  for (const [num, needles] of Object.entries(expect.prompt_artifact_absent ?? {})) {
    const promptPath = join(outDir, 'prompts', `issue-${num}.md`);
    if (check(existsSync(promptPath), `no <out>/prompts/issue-${num}.md was written`)) {
      const text = readFileSync(promptPath, 'utf8');
      for (const needle of needles) {
        check(!text.includes(needle), `prompts/issue-${num}.md unexpectedly contains ${JSON.stringify(needle)}`);
      }
    }
  }

  // Exact limitation counts. `limitation_codes` proves a code was recorded;
  // this proves it was recorded the RIGHT NUMBER of times — the run-wide
  // declaration exactly once, the per-issue record exactly once per issue
  // (ADR §9). A duplicated declaration reads as two runs in one report.
  for (const [code, count] of Object.entries(expect.limitation_code_counts ?? {})) {
    const actual = report.limitations.filter((entry) => entry.code === code).length;
    check(actual === count, `limitation "${code}" was recorded ${actual} time(s) !== ${count}`);
  }

  // The report's schema version, asserted from the CASE rather than only from the
  // schema file: "we added a fact without touching dispatch_schema_version" is a
  // claim about this number, and a case that means it should say so (ADR §9).
  if (expect.dispatch_schema_version !== undefined) {
    check(report.dispatch_schema_version === expect.dispatch_schema_version,
      `dispatch_schema_version ${report.dispatch_schema_version} !== ${expect.dispatch_schema_version}`);
  }

  // Redaction: a secret shape in a captured prompt must not survive into the
  // report, and must be tallied by kind only.
  if (expect.redaction_token) {
    check(!stdout.includes(expect.redaction_token), 'a raw token survived into the dispatch report');
    check(stdout.includes('[REDACTED-TOKEN]'), 'the token was not replaced with a redaction marker');
  }
  if (expect.redaction_kind) {
    check(report.redactions.some((entry) => entry.kind === expect.redaction_kind && entry.count >= 1), `redactions did not record kind "${expect.redaction_kind}"`);
  }
}

// =============================================================================
// Resume cases: a partial failure, then `--resume` (Issue #98)
// =============================================================================
//
// A resume case is a SEQUENCE of dispatch runs against one plan, one work
// directory and one output directory: attempt 1 dispatches normally, and every
// later attempt runs `--resume <out>` against a scenario that models the world
// after somebody fixed something. That sequence is the fixture — the property
// under test ("the pass-ed issues are not re-run, and their verdicts survive")
// cannot be observed from a single run, and a hand-written prior report would
// only prove that the runner can read a file this repository wrote by hand.
//
// Two invariants are asserted on every attempt rather than per case:
//
//   1. APPEND-ONLY. Every file that existed in the output directory before an
//      attempt has byte-identical content after it. That is the whole "既存
//      artifact を上書きしない" rule, and a per-path expectation would only catch
//      the paths somebody thought of.
//   2. The report on stdout IS the report on disk, at the attempt's own path.
//
// Each attempt gets its own CMATE_FAKE_STATE, so a later attempt starts from a
// fresh worker turn counter. What it inherits from the earlier one is the real
// world: the worktrees on disk, their baseline markers, and the output directory.

// Every file under `dir` as relpath -> bytes, for the append-only comparison.
function snapshotTree(dir, prefix = '') {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(prefix === '' ? dir : join(dir, prefix), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) for (const [key, value] of snapshotTree(dir, relative)) out.set(key, value);
    else if (entry.isFile()) out.set(relative, readFileSync(join(dir, relative), 'utf8'));
  }
  return out;
}

// The attempt ledger, as parsed lines. Absent is an empty history, not a crash:
// a run that stopped before writing anything writes no line either.
function readAttemptHistory(outDir) {
  const path = join(outDir, 'attempt-history.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// merge.mjs in preview mode over a given dispatch report. This is the acceptance
// question "does the resumed report still deliver?" asked of the real consumer
// rather than of a re-implementation of its eligibility rule.
function mergeEligibleFor(planPath, dispatchPath, work, label) {
  const mergeOut = join(work, `merge-${label}`);
  const scenarioPath = writeScenario(work, `merge-scenario-${label}.json`, withDiffDefaults({
    cli_available: true,
    gh: { repo_access: true },
    git: { base_resolvable: true },
  }, readPlan(planPath)));
  const env = { ...baseEnv(), CMATE_FAKE_SCENARIO: scenarioPath };
  const { exit, stdout } = runMerge(planPath, dispatchPath, mergeOut, '--create-prs', [], env, join(work, 'integration'));
  try {
    return { exit, report: JSON.parse(stdout) };
  } catch {
    return { exit, report: null };
  }
}

function assertResumeAttempt(label, spec, exit, stdout, cliLog, outDir, planPath, work) {
  const expect = spec.expect;
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    check(false, `${label}: dispatch stdout is not valid JSON (exit ${exit}): ${stdout.slice(0, 200)}`);
    return null;
  }

  check(exit === expect.exit, `${label}: exit ${exit} !== expected ${expect.exit}`);
  const schemaErrors = validateAgainst(dispatchSchema, report, 'dispatch');
  check(schemaErrors.length === 0, `${label}: dispatch schema: ${schemaErrors.slice(0, 3).join('; ')}`);
  check(report.status === expect.status, `${label}: status "${report.status}" !== "${expect.status}"`);
  check(report.stop_reason === expect.stop_reason, `${label}: stop_reason "${report.stop_reason}" !== "${expect.stop_reason}"`);
  if (expect.completion_check_passed !== undefined) {
    check(report.completion_check.passed === expect.completion_check_passed,
      `${label}: completion_check.passed ${report.completion_check.passed} !== ${expect.completion_check_passed}`);
  }
  if (expect.waves_count !== undefined) {
    check(report.waves.length === expect.waves_count, `${label}: waves ${report.waves.length} !== ${expect.waves_count}`);
  }
  // Exactly which issues each wave dispatched. The core claim of a resume — "only
  // the failed one was re-run" — is this list, and an inclusive check would pass
  // on a run that re-dispatched everything.
  if (expect.wave_dispatched) {
    const actual = report.waves.map((wave) => wave.dispatched);
    check(deepEqual(actual, expect.wave_dispatched),
      `${label}: wave dispatched ${JSON.stringify(actual)} !== ${JSON.stringify(expect.wave_dispatched)}`);
  }

  const sent = sentIssuesFromLog(cliLog);
  for (const number of expect.sent ?? []) check(sent.includes(number), `${label}: #${number} should have been dispatched`);
  for (const number of expect.never_sent ?? []) {
    check(!sent.includes(number), `${label}: #${number} was sent, but it should not have been re-dispatched`);
  }
  // "This attempt sent NOBODY" — the whole claim of `--reverify` (Issue #121).
  // Stronger than listing every issue in `never_sent`: it also catches a send to
  // a worktree the plan does not name.
  if (expect.sent !== undefined && expect.sent.length === 0) {
    check(sent.length === 0, `${label}: ${sent.length} send(s) were made (${JSON.stringify(sent)}), but this attempt must send nothing`);
  }
  // WHICH issues were re-judged, read from the judge's own invocations rather
  // than from the report. A carried issue must not be re-judged, and an issue
  // with no work evidence must not even be asked about — neither claim is
  // observable in a report that only shows outcomes.
  const verified = verifiedIssuesFromLog(cliLog);
  for (const number of expect.verified ?? []) {
    check(verified.includes(number), `${label}: #${number} should have been re-judged with commandmate verify`);
  }
  for (const number of expect.never_verified ?? []) {
    check(!verified.includes(number), `${label}: #${number} was handed to commandmate verify, but it should not have been re-judged`);
  }
  // "The dependent is dispatched from the FIRST wave" is only observable as an
  // ordering: with its dependency carried over, nothing precedes it.
  if (expect.first_sent !== undefined) {
    check(sent[0] === expect.first_sent,
      `${label}: the first send was #${sent[0]} !== #${expect.first_sent} (a carried wave must not put a worker in front of it)`);
  }
  check(cliLog.filter((entry) => entry.sub === 'respond').length === 0,
    `${label}: respond was called; Auto-Yes stays off on a resume exactly as on a first dispatch`);
  // What a resume with nothing to do must NOT do. "Dispatched nobody" is weaker
  // than what the runner promises: with no mutating wave there is nothing for a
  // drift re-check to guard, so no CLI is reached for at all.
  if (expect.cli_calls_total !== undefined) {
    check(cliLog.length === expect.cli_calls_total,
      `${label}: ${cliLog.length} CLI call(s) were made !== ${expect.cli_calls_total}: ${JSON.stringify(cliLog.map((entry) => entry.sub))}`);
  }
  // Per-subcommand counts, the same expectation the dispatch cases carry.
  if (expect.cli_subcommand_counts) {
    for (const [name, count] of Object.entries(expect.cli_subcommand_counts)) {
      const actual = cliLog.filter((entry) => entry.sub === name).length;
      check(actual === count, `${label}: commandmate ${name} was called ${actual} time(s) !== ${count}`);
    }
  }
  // "No worker was driven at all" — the central claim of `--reverify` (Issue
  // #121), and one no field of the report can show. Stronger than an empty
  // `sent`: it also rules out a `wait`, a `capture` and a `respond`, i.e. every
  // way this runner can touch a live worker. The version probes (`send --help` /
  // `wait --help`) are excluded by construction: they carry no worktree id, and
  // it is the id that makes a call an interaction with somebody's worker.
  if (expect.no_worker_driven) {
    const driving = cliLog.filter((entry) => ['send', 'wait', 'capture', 'respond'].includes(entry.sub)
      && /issue-\d+/.test(String(entry.args[0] ?? '')));
    check(driving.length === 0,
      `${label}: ${driving.length} call(s) drove a worker, but this attempt must drive none: ${JSON.stringify(driving)}`);
  }

  for (const [num, state] of Object.entries(expect.worker_states ?? {})) {
    const worker = allWorkers(report).find((w) => w.issue === Number(num));
    if (check(worker !== undefined, `${label}: #${num} has no worker record`)) {
      check(worker.worker_state === state, `${label}: #${num} worker_state "${worker.worker_state}" !== "${state}"`);
    }
  }
  for (const [num, outcome] of Object.entries(expect.verification_outcomes ?? {})) {
    const worker = allWorkers(report).find((w) => w.issue === Number(num));
    if (check(worker !== undefined, `${label}: #${num} has no worker record`)) {
      check(worker.verification.outcome === outcome, `${label}: #${num} verification.outcome "${worker.verification.outcome}" !== "${outcome}"`);
    }
  }
  // A carried record must carry the EVIDENCE too, not just a passing outcome: a
  // resume that dropped the checks would hand merge a pass with nothing behind it.
  for (const [num, needles] of Object.entries(expect.verification_checks_include ?? {})) {
    const worker = allWorkers(report).find((w) => w.issue === Number(num));
    if (check(worker !== undefined, `${label}: #${num} has no worker record`)) {
      const checksText = (worker.verification.checks ?? []).join(' | ');
      for (const needle of needles) {
        check(checksText.includes(needle), `${label}: #${num} verification.checks ${JSON.stringify(worker.verification.checks)} does not contain "${needle}"`);
      }
    }
  }
  for (const [num, needles] of Object.entries(expect.worker_notes_include ?? {})) {
    const worker = allWorkers(report).find((w) => w.issue === Number(num));
    if (check(worker !== undefined, `${label}: #${num} has no worker record`)) {
      for (const needle of needles) {
        check(String(worker.note ?? '').includes(needle), `${label}: #${num} note ${JSON.stringify(worker.note)} does not contain "${needle}"`);
      }
    }
  }
  for (const code of expect.limitation_codes ?? []) {
    check(report.limitations.some((entry) => entry.code === code), `${label}: limitation "${code}" was expected but not recorded`);
  }
  for (const code of expect.absent_limitation_codes ?? []) {
    check(!report.limitations.some((entry) => entry.code === code), `${label}: limitation "${code}" should be absent but was recorded`);
  }
  if (expect.limitation_details_include) {
    const details = report.limitations.map((entry) => entry.detail);
    for (const needle of expect.limitation_details_include) {
      check(details.some((detail) => detail.includes(needle)), `${label}: no limitation detail contains "${needle}"; details: ${JSON.stringify(details)}`);
    }
  }
  for (const code of expect.blocking_codes ?? []) {
    check(report.blocking_reasons.some((entry) => entry.code === code), `${label}: blocking reason "${code}" was expected but not recorded`);
  }
  if (expect.blocking_details_include) {
    const details = report.blocking_reasons.map((entry) => entry.detail);
    for (const needle of expect.blocking_details_include) {
      check(details.some((detail) => detail.includes(needle)), `${label}: no blocking detail contains "${needle}"; details: ${JSON.stringify(details)}`);
    }
  }
  for (const needle of expect.summary_includes ?? []) {
    check(report.summary_markdown.includes(needle), `${label}: the summary does not contain ${JSON.stringify(needle)}`);
  }
  for (const needle of expect.summary_excludes ?? []) {
    check(!report.summary_markdown.includes(needle), `${label}: the summary should not contain ${JSON.stringify(needle)}`);
  }

  // The #83 invariant, unchanged and asserted here too: the note never claims a
  // verification result the structured field does not. A carried record is
  // exactly where that could drift, because its note is transcribed.
  for (const worker of allWorkers(report)) {
    const note = String(worker.note ?? '');
    if (/verification passed/.test(note)) {
      check(worker.verification.outcome === 'pass',
        `${label}: #${worker.issue} note claims "verification passed" but outcome is "${worker.verification.outcome}"`);
    }
    if (worker.worker_state === 'completed' && worker.verification.ran === false) {
      const gate = report.completion_check.checks.find((entry) => entry.id === 'verification_recorded');
      check(gate !== undefined && gate.passed === false,
        `${label}: #${worker.issue} completed with verification.ran false, but verification_recorded did not fail`);
    }
  }

  // The report is on disk where the contract says it is, and it is the same
  // bytes stdout carried.
  if (expect.report_file !== undefined) {
    const path = join(outDir, expect.report_file);
    if (check(existsSync(path), `${label}: no report was written to <out>/${expect.report_file}`)) {
      check(JSON.parse(readFileSync(path, 'utf8')).summary_markdown === report.summary_markdown,
        `${label}: <out>/${expect.report_file} is not the report that was printed`);
    }
    const summaryPath = join(outDir, expect.report_file.replace(/dispatch-report\.json$/, 'dispatch-summary.md'));
    check(existsSync(summaryPath), `${label}: no summary was written beside <out>/${expect.report_file}`);
  }
  if (expect.report_file_absent !== undefined) {
    check(!existsSync(join(outDir, expect.report_file_absent)),
      `${label}: <out>/${expect.report_file_absent} was created, but this attempt wrote nothing`);
  }

  // The consumer's answer, from the consumer (merge.mjs), over THIS report.
  if (expect.merge_eligible) {
    const dispatchPath = join(outDir, expect.report_file);
    const merged = mergeEligibleFor(planPath, dispatchPath, work, label.replace(/[^A-Za-z0-9]/g, '-'));
    if (check(merged.report !== null, `${label}: merge stdout is not valid JSON (exit ${merged.exit})`)) {
      check(deepEqual(merged.report.eligible_issues, expect.merge_eligible),
        `${label}: merge eligible ${JSON.stringify(merged.report.eligible_issues)} !== ${JSON.stringify(expect.merge_eligible)}`);
    }
  }
  return report;
}

function runResumeCase(caseId) {
  const caseDir = join(RESUME_CASES_DIR, caseId);
  const spec = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'));
  log(`  ${caseId}: ${spec.description}`);

  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-resume-plan-'));
  const planPath = generatePlan(spec, runsDir);
  if (!check(existsSync(planPath), `plan.json was not generated at ${planPath}`)) return;

  // A second plan over the same issues but with its own run id: the input the
  // run_id guard exists to refuse. Generated rather than hand-written so the
  // guard is exercised against a real plan, not against a crafted mismatch.
  let otherPlanPath = null;
  if (spec.other_plan) {
    const otherRunsDir = mkdtempSync(join(tmpdir(), 'cmate-resume-other-'));
    otherPlanPath = generatePlan({ plan: spec.other_plan }, otherRunsDir);
    if (!check(existsSync(otherPlanPath), `the second plan.json was not generated at ${otherPlanPath}`)) return;
  }

  const work = mkdtempSync(join(tmpdir(), 'cmate-resume-'));
  const outDir = join(work, 'dispatch'); // attempt 1 creates it; later attempts append into it

  spec.attempts.forEach((attemptSpec, index) => {
    const label = `${caseId} attempt ${index + 1}`;
    const scenarioObject = JSON.parse(readFileSync(join(caseDir, attemptSpec.scenario), 'utf8'));
    const usePlan = attemptSpec.plan === 'other' ? otherPlanPath : planPath;
    const logPath = join(work, `cli-${index + 1}.log`);

    // A damaged prior report. The dispatch report is this package's own artifact,
    // but a resume reads it back as an INPUT that decides what counts as finished,
    // so the shapes it must refuse can only be exercised by handing it one.
    // Applied BEFORE the snapshot, so the damage is the attempt's starting world
    // rather than a violation of the append-only check below.
    const priorPath = join(outDir, 'dispatch-report.json');
    if (attemptSpec.prior_report_raw !== undefined) {
      writeFileSync(priorPath, attemptSpec.prior_report_raw);
    }
    if (attemptSpec.prior_report_patch) {
      const document = JSON.parse(readFileSync(priorPath, 'utf8'));
      writeFileSync(priorPath, `${JSON.stringify({ ...document, ...attemptSpec.prior_report_patch }, null, 2)}\n`);
    }
    // The same reasoning one level down, per issue (Issue #171). Some shapes a
    // transcription must handle cannot be produced by the runner that writes the
    // report — a PASSING run records two check lines, so a carried record whose
    // `checks` overflows the report bound only ever arrives from a report this
    // runner did not write. That is a real input (an older runner, a hand-edited
    // report), and the only way to exercise it is to hand one over.
    if (attemptSpec.prior_worker_verification_patch) {
      const document = JSON.parse(readFileSync(priorPath, 'utf8'));
      for (const wave of document.waves ?? []) {
        for (const worker of wave.workers ?? []) {
          const entry = attemptSpec.prior_worker_verification_patch[String(worker.issue)];
          if (entry) worker.verification = { ...worker.verification, ...entry };
        }
      }
      writeFileSync(priorPath, `${JSON.stringify(document, null, 2)}\n`);
    }
    const before = snapshotTree(outDir);

    const state = join(work, `state-${index + 1}`);
    // Exactly one of the three shapes: a first dispatch (--out), a resume, or a
    // reverify. The state directory is per attempt in all three, so the fake's
    // turn counter never leaks across attempts — the world a later attempt
    // inherits is the worktrees on disk, which is what the scenario describes.
    const { exit, stdout } = runDispatchRunner(
      usePlan, scenarioObject, work, outDir, attemptSpec.dispatch_args ?? [], logPath,
      attemptSpec.reverify
        ? { reverifyDir: outDir, state }
        : (attemptSpec.resume ? { resumeDir: outDir, state } : { state }),
    );

    assertResumeAttempt(label, attemptSpec, exit, stdout, readCliLog(logPath), outDir, usePlan, work);

    // Invariant 1: append-only. Nothing that was in the output directory before
    // this attempt has different bytes after it.
    const after = snapshotTree(outDir);
    for (const [relative, bytes] of before) {
      // The ledger is the one append-only FILE (it grows); everything else must
      // be untouched, ledger included up to its previous content being a prefix.
      if (relative === 'attempt-history.jsonl') {
        check(String(after.get(relative) ?? '').startsWith(bytes),
          `${label}: attempt-history.jsonl was rewritten rather than appended to`);
        continue;
      }
      check(after.get(relative) === bytes, `${label}: <out>/${relative} was overwritten by a later attempt`);
    }

    // Invariant 2: the ledger says what this attempt was.
    if (attemptSpec.expect.history) {
      const history = readAttemptHistory(outDir);
      const line = history[history.length - 1];
      if (check(line !== undefined, `${label}: nothing was appended to attempt-history.jsonl`)) {
        for (const [key, value] of Object.entries(attemptSpec.expect.history)) {
          check(deepEqual(line[key], value), `${label}: history ${key} ${JSON.stringify(line[key])} !== ${JSON.stringify(value)}`);
        }
      }
    }
    if (attemptSpec.expect.history_length !== undefined) {
      const history = readAttemptHistory(outDir);
      check(history.length === attemptSpec.expect.history_length,
        `${label}: attempt-history.jsonl has ${history.length} line(s) !== ${attemptSpec.expect.history_length}`);
    }
  });
}

// =============================================================================
// Merge cases: drive the PR-creation / guarded-merge runner against the fake gh
// =============================================================================

// Each merge case first generates a real plan, then a real dispatch report
// (proving the plan -> dispatch -> merge handoff), then runs merge.mjs for a
// single mutating phase against the fake gh/git with an injected merge scenario.
// It asserts the report's status/stop_reason, the approval gate and the CI gate,
// and — via the fake's invocation log — that no PR was created or merged without
// approval, that a failed CI never reaches `gh pr merge`, and that a create
// failure or merge conflict stops the phase as partial rather than success.

function writeScenario(dir, name, object) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(object, null, 2)}\n`);
  return path;
}

function generateDispatchReport(planPath, scenarioObject, work) {
  const outDir = join(work, 'dispatch');
  // A partial dispatch (e.g. an injected verification failure) still writes a
  // report; the caller reads whatever eligible set it produced.
  runDispatchRunner(planPath, scenarioObject, work, outDir, ['--expect-branch', 'feature/integration'], null);
  return join(outDir, 'dispatch-report.json');
}

// The merge runner is spawned in the integration directory the dispatch harness
// created, exactly as an operator runs it: the plan's worktree paths are relative
// (`../<repo>-issue-<n>-…`), and since Issue #97 the runner cwd's into them to
// read each branch's real change set. Spawning it anywhere else would resolve
// those paths outside the temp world and make every case's evidence unavailable.
function runMerge(planPath, dispatchPath, outDir, phaseFlag, extraArgs, env, cwd) {
  const args = [
    MERGE_RUNNER,
    '--plan', planPath,
    '--dispatch', dispatchPath,
    phaseFlag,
    '--gh', FAKE_CLI, '--git', FAKE_CLI,
    '--out', outDir,
    ...extraArgs,
  ];
  try {
    const stdout = execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, cwd });
    return { exit: 0, stdout };
  } catch (error) {
    return { exit: error.status ?? 1, stdout: error.stdout ? error.stdout.toString() : '' };
  }
}

// The merge scenario the fake `git diff` answers from (Issue #97). Every plan
// issue defaults to "changed exactly its declared scope" — the ordinary
// scope-clean branch the contract's `requireScopeClean` gate already passed — so
// only a case that cares about the diff declares one, and a case that declares a
// diff for #201 does not silently blank #200's.
function withDiffDefaults(scenario, plan) {
  const diff = {};
  for (const issue of plan.issues) {
    // The files the ISSUE declared, not every file the contract allows. Since
    // Issue #147 the planner also permits each declared source file's
    // conventional test paths (reported in `scope_defaults`), and a branch does
    // not create a file merely because it was allowed to — a default that
    // "changed" all of them would model a worker nobody has.
    const derived = new Set(issue.scope_defaults ?? []);
    diff[issue.number] = { files: (issue.suspected_files ?? []).filter((path) => !derived.has(path)) };
  }
  return { ...scenario, diff: { ...diff, ...(scenario.diff ?? {}) } };
}

// A merge case may rewrite the generated dispatch report before merge reads it.
// The merge runner does not produce that file — it is an INPUT, and one this
// repository's dispatch runner is not the only possible producer of — so the
// shapes it must not misread (a verdict recorded with `ran: false`, an unredacted
// secret in a check line) can only be exercised by handing it such a report.
// The patch is applied per issue to the worker's `verification` object.
function patchDispatchReport(dispatchPath, patch) {
  const report = JSON.parse(readFileSync(dispatchPath, 'utf8'));
  for (const wave of report.waves ?? []) {
    for (const worker of wave.workers ?? []) {
      const entry = patch[worker.issue] ?? patch[String(worker.issue)];
      if (entry) worker.verification = { ...worker.verification, ...entry };
    }
  }
  writeFileSync(dispatchPath, `${JSON.stringify(report, null, 2)}\n`);
}

function countCalls(cliLog, sub, action) {
  return cliLog.filter((entry) => entry.sub === sub && (action === undefined || entry.args[0] === action)).length;
}

function runMergeCase(caseId) {
  const caseDir = join(MERGE_CASES_DIR, caseId);
  const spec = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'));
  log(`  ${caseId}: ${spec.description}`);

  // 1. plan -> 2. dispatch report -> 3. merge phase.
  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-merge-plan-'));
  const planPath = generatePlan(spec, runsDir);
  if (!check(existsSync(planPath), `plan.json was not generated at ${planPath}`)) return;

  const work = mkdtempSync(join(tmpdir(), 'cmate-merge-'));
  const dispatchPath = generateDispatchReport(planPath, spec.dispatch_scenario ?? DEFAULT_DISPATCH_SCENARIO, work);
  if (!check(existsSync(dispatchPath), `dispatch-report.json was not generated at ${dispatchPath}`)) return;
  if (spec.dispatch_report_patch) patchDispatchReport(dispatchPath, spec.dispatch_report_patch);

  const mergeOut = join(work, 'merge'); // must not pre-exist; merge creates it
  const logPath = join(work, 'gh.log');
  const scenarioPath = writeScenario(work, 'merge-scenario.json', withDiffDefaults(spec.merge_scenario ?? {}, readPlan(planPath)));
  const env = { ...baseEnv(), CMATE_FAKE_SCENARIO: scenarioPath, CMATE_FAKE_LOG: logPath };

  const phaseFlag = spec.phase === 'merge-prs' ? '--merge-prs' : '--create-prs';
  const { exit, stdout } = runMerge(planPath, dispatchPath, mergeOut, phaseFlag, spec.merge_args ?? [], env, join(work, 'integration'));

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    check(false, `merge stdout is not valid JSON (exit ${exit}): ${stdout.slice(0, 200)}`);
    return;
  }

  const expect = spec.expect;
  check(exit === expect.exit, `exit ${exit} !== expected ${expect.exit}`);

  const schemaErrors = validateAgainst(mergeSchema, report, 'merge');
  check(schemaErrors.length === 0, `merge schema: ${schemaErrors.slice(0, 3).join('; ')}`);

  check(report.status === expect.status, `status "${report.status}" !== "${expect.status}"`);
  check(report.stop_reason === expect.stop_reason, `stop_reason "${report.stop_reason}" !== "${expect.stop_reason}"`);
  if (expect.approved !== undefined) check(report.approved === expect.approved, `approved ${report.approved} !== ${expect.approved}`);
  if (expect.mutated !== undefined) check(report.mutated === expect.mutated, `mutated ${report.mutated} !== ${expect.mutated}`);
  if (expect.eligible) check(deepEqual(report.eligible_issues, expect.eligible), `eligible ${JSON.stringify(report.eligible_issues)} !== ${JSON.stringify(expect.eligible)}`);
  if (expect.completion_passed !== undefined) check(report.completion_check.passed === expect.completion_passed, `completion_check.passed ${report.completion_check.passed} !== ${expect.completion_passed}`);

  // Per-issue outcome: proves failures are recorded (never rounded to success)
  // and that unreached targets are marked skipped.
  if (expect.targets_outcome) {
    for (const [num, outcome] of Object.entries(expect.targets_outcome)) {
      const target = report.targets.find((t) => t.issue === Number(num));
      check(target !== undefined, `#${num} has no target record`);
      if (target) check(target.outcome === outcome, `#${num} outcome "${target.outcome}" !== "${outcome}"`);
    }
  }

  // The gate proofs come from the fake's invocation log.
  const cliLog = readCliLog(logPath);
  const pushCalls = countCalls(cliLog, 'push');
  const createCalls = countCalls(cliLog, 'pr', 'create');
  const mergeCalls = countCalls(cliLog, 'pr', 'merge');

  if (expect.push_calls !== undefined) check(pushCalls === expect.push_calls, `push called ${pushCalls} time(s) !== ${expect.push_calls}`);
  if (expect.pr_create_calls !== undefined) check(createCalls === expect.pr_create_calls, `pr create called ${createCalls} time(s) !== ${expect.pr_create_calls}`);
  if (expect.pr_merge_calls !== undefined) check(mergeCalls === expect.pr_merge_calls, `pr merge called ${mergeCalls} time(s) !== ${expect.pr_merge_calls}`);
  // Approval gate: without --approve nothing is pushed, created or merged.
  if (expect.no_mutation) {
    check(pushCalls === 0 && createCalls === 0 && mergeCalls === 0, `a mutating gh/git call ran on a no-approve path (push=${pushCalls}, create=${createCalls}, merge=${mergeCalls})`);
  }
  // CI gate: a non-green CI must never reach gh pr merge.
  if (expect.no_merge) check(mergeCalls === 0, `pr merge was called ${mergeCalls} time(s) when CI was not green`);

  if (expect.redaction_token) {
    check(!stdout.includes(expect.redaction_token), 'a raw token survived into the merge report');
  }

  // Limitations are the "did not stop the phase, but you need to know" channel
  // (Issue #39). Both directions are asserted: the code that must be recorded,
  // and the code that must NOT appear when there is nothing to report or the
  // probe could not answer.
  const limitationCodes = (report.limitations ?? []).map((l) => l.code);
  for (const code of expect.limitation_codes ?? []) {
    check(limitationCodes.includes(code), `limitation "${code}" not in ${JSON.stringify(limitationCodes)}`);
  }
  for (const code of expect.absent_limitation_codes ?? []) {
    check(!limitationCodes.includes(code), `limitation "${code}" should not have been recorded`);
  }

  // The PR body artifact is the operator-facing half of the same finding.
  if (expect.pr_body_contains || expect.pr_body_absent) {
    assertPrBody(mergeOut, report.eligible_issues[0], expect.pr_body_contains, expect.pr_body_absent);
  }
  // The evidence the body must carry is per issue (Issue #97): one case can hold
  // a scope-clean issue beside one whose branch reached outside its scope, and a
  // whole-run assertion could not tell those two bodies apart.
  for (const [num, needles] of Object.entries(expect.pr_bodies_contain ?? {})) {
    assertPrBody(mergeOut, Number(num), needles, []);
  }
  for (const [num, needles] of Object.entries(expect.pr_bodies_absent ?? {})) {
    assertPrBody(mergeOut, Number(num), [], needles);
  }
  // gh refuses a body over 65536 characters, so a body that grew past it would
  // fail the create for real. Asserted on every case that writes one.
  if (expect.pr_body_contains || expect.pr_bodies_contain) {
    for (const number of report.eligible_issues) {
      const bodyPath = join(mergeOut, 'pr-bodies', `issue-${number}.md`);
      if (!existsSync(bodyPath)) continue;
      const size = readFileSync(bodyPath, 'utf8').length;
      check(size <= 65536, `PR body for #${number} is ${size} characters, over gh's 65536 limit`);
    }
  }
}

function assertPrBody(mergeOut, number, contains, absent) {
  const bodyPath = join(mergeOut, 'pr-bodies', `issue-${number}.md`);
  if (!check(existsSync(bodyPath), `PR body ${bodyPath} was not written`)) return;
  const body = readFileSync(bodyPath, 'utf8');
  for (const needle of contains ?? []) {
    check(body.includes(needle), `PR body for #${number} does not mention "${needle}"`);
  }
  for (const needle of absent ?? []) {
    check(!body.includes(needle), `PR body for #${number} should not mention "${needle}"`);
  }
}

// =============================================================================
// UAT cases: drive the acceptance assessment / bounded fix loop
// =============================================================================

// Each UAT case first generates a real plan, then a real dispatch report
// (proving the plan -> dispatch -> UAT handoff), then runs uat.mjs for a single
// phase (--write-uat or --create-uat-fix-worktrees) against the fake CLI with an
// injected UAT scenario. It asserts the report's status/stop_reason, the approval
// gate, the bounded attempt count and the blocked outcome, and — via the fake's
// invocation log — that a preview never creates a worktree, dispatches a fix or
// re-merges, and that the fix loop stopped at the cap rather than running forever.

function uatSpecPasses(scenario, number) {
  const uat = scenario.uat ?? {};
  return (uat[number] ?? uat[String(number)]) === 'pass';
}

// The semantic gate's input (#1616): one cmate-acceptance-test result document per
// issue at <dir>/issue-<n>.json. A case declares them as `acceptance_results`,
// mapping an issue number to either an object (written as JSON) or a raw string —
// the string form is how the not-valid-JSON branch is exercised. A case may also
// set `acceptance_dir: true` with no results at all, which is the directory-given-
// but-document-missing branch. Returns the directory to pass as --acceptance-dir,
// or null when the case does not configure the gate.
function setupAcceptanceDir(spec, work) {
  const results = spec.acceptance_results;
  const wanted = spec.acceptance_dir ?? results !== undefined;
  if (!wanted) return null;
  const dir = join(work, 'acceptance');
  mkdirSync(dir, { recursive: true });
  const deliberatelyBroken = new Set((spec.acceptance_nonconformant ?? []).map(String));
  for (const [number, document] of Object.entries(results ?? {})) {
    const path = join(dir, `issue-${number}.json`);
    writeFileSync(path, typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`);
    // A fixture that is supposed to be a real acceptance result is validated
    // against cmate-acceptance-test's own schema, so the go/conditional_go/no_go
    // branches are exercised with documents that Skill could actually have
    // produced — not with a shape invented here. The deliberately broken ones are
    // exempt: being rejected is what they test.
    if (deliberatelyBroken.has(String(number)) || typeof document === 'string') continue;
    const errors = validateAgainst(acceptanceSchema, document, `acceptance/issue-${number}`);
    check(errors.length === 0, `acceptance fixture for #${number} is not acceptance-result.v1: ${errors.slice(0, 3).join('; ')}`);
  }
  return dir;
}

// The run's verdict for an issue is its LAST assessment: the fix loop re-assesses,
// and an earlier attempt's failure is history, not the outcome.
function lastAssessmentOf(report, issue) {
  let found;
  for (const attempt of report.attempts) {
    for (const result of attempt.uat_results) {
      if (result.issue === issue) found = result;
    }
  }
  return found;
}

function allAssessments(report) {
  return report.attempts.flatMap((attempt) => attempt.uat_results);
}

// The #1616 central rule, asserted on EVERY uat case rather than only the ones that
// configure acceptance: nothing that was not verified is reported as passed. A
// conditional_go or no_go must never reach a passing verdict, must never surface as
// the legacy `outcome: pass` an older reader would consume, and a run still holding
// a conditional_go must not be an unqualified success.
function checkAcceptanceNeverRounded(report) {
  for (const result of allAssessments(report)) {
    const acceptance = result.acceptance;
    if (!acceptance || acceptance.state !== 'loaded' || acceptance.verdict === 'go') continue;
    check(result.verdict !== 'pass', `#${result.issue}: acceptance ${acceptance.verdict} was composed into verdict "pass"`);
    check(result.outcome !== 'pass', `#${result.issue}: acceptance ${acceptance.verdict} surfaced as the legacy outcome "pass"`);
  }
  const conditional = (report.conditional_issues ?? []);
  if (conditional.length > 0) {
    check(report.status !== 'success', `conditional_go for ${JSON.stringify(conditional)} but the run reported success`);
  }
  for (const result of allAssessments(report)) {
    if (result.verdict === 'conditional') {
      check(conditional.includes(result.issue), `#${result.issue} was conditional but is not in conditional_issues`);
    }
  }
  const gate = report.completion_check.checks.find((c) => c.id === 'acceptance_not_rounded');
  if (check(gate !== undefined, 'completion_check is missing acceptance_not_rounded')) {
    check(gate.passed === true, 'the acceptance_not_rounded completion check did not pass');
  }
}

// `opts` mirrors runDispatchRunner's, and exists for the same suite (Issue #37).
function runUatRunner(planPath, dispatchPath, outDir, phaseFlag, extraArgs, env, cwd, opts = {}) {
  const launcher = 'launcher' in opts ? opts.launcher : FAKE_CLI;
  const args = [
    UAT_RUNNER,
    '--plan', planPath,
    '--dispatch', dispatchPath,
    phaseFlag,
    ...(launcher === null ? [] : ['--cli', launcher]),
    '--git', FAKE_CLI, '--gh', FAKE_CLI,
    '--out', outDir,
    ...extraArgs,
  ];
  try {
    const stdout = execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, cwd });
    return { exit: 0, stdout };
  } catch (error) {
    return { exit: error.status ?? 1, stdout: error.stdout ? error.stdout.toString() : '' };
  }
}

function runUatCase(caseId) {
  const caseDir = join(UAT_CASES_DIR, caseId);
  const spec = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'));
  log(`  ${caseId}: ${spec.description}`);

  // 1. plan -> 2. dispatch report -> 3. UAT phase.
  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-uat-plan-'));
  const planPath = generatePlan(spec, runsDir);
  if (!check(existsSync(planPath), `plan.json was not generated at ${planPath}`)) return;
  const plan = readPlan(planPath);

  // The dispatch report (which issues are eligible) and the UAT run use SEPARATE
  // worktree worlds: dispatch marks verify-passed worktrees for eligibility, while
  // the UAT run marks worktrees per the uat scenario — so an eligible issue can
  // still fail UAT (the two gates are distinct).
  const workDispatch = mkdtempSync(join(tmpdir(), 'cmate-uat-disp-'));
  const dispatchPath = generateDispatchReport(planPath, spec.dispatch_scenario ?? DEFAULT_DISPATCH_SCENARIO, workDispatch);
  if (!check(existsSync(dispatchPath), `dispatch-report.json was not generated at ${dispatchPath}`)) return;

  const workUat = mkdtempSync(join(tmpdir(), 'cmate-uat-'));
  const uatScenario = spec.uat_scenario ?? {};
  const integration = setupWorktrees(plan, workUat, (n) => uatSpecPasses(uatScenario, n));
  const uatOut = join(workUat, 'uat'); // must not pre-exist; uat.mjs creates it
  const logPath = join(workUat, 'uat-cli.log');
  const scenarioPath = writeScenario(workUat, 'uat-scenario.json', { ...uatScenario, worktrees: planToWorktrees(plan) });
  const env = { ...baseEnv(), CMATE_FAKE_SCENARIO: scenarioPath, CMATE_FAKE_LOG: logPath, CMATE_FAKE_STATE: workUat };

  const acceptanceDir = setupAcceptanceDir(spec, workUat);
  const uatArgs = [...(spec.uat_args ?? []), ...(acceptanceDir ? ['--acceptance-dir', acceptanceDir] : [])];

  const phaseFlag = spec.phase === 'fix_uat' ? '--create-uat-fix-worktrees' : '--write-uat';
  const { exit, stdout } = runUatRunner(planPath, dispatchPath, uatOut, phaseFlag, uatArgs, env, integration);

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    check(false, `uat stdout is not valid JSON (exit ${exit}): ${stdout.slice(0, 200)}`);
    return;
  }

  const expect = spec.expect;
  check(exit === expect.exit, `exit ${exit} !== expected ${expect.exit}`);

  const schemaErrors = validateAgainst(uatSchema, report, 'uat');
  check(schemaErrors.length === 0, `uat schema: ${schemaErrors.slice(0, 3).join('; ')}`);

  check(report.status === expect.status, `status "${report.status}" !== "${expect.status}"`);
  check(report.stop_reason === expect.stop_reason, `stop_reason "${report.stop_reason}" !== "${expect.stop_reason}"`);
  if (expect.approved !== undefined) check(report.approved === expect.approved, `approved ${report.approved} !== ${expect.approved}`);
  if (expect.mutated !== undefined) check(report.mutated === expect.mutated, `mutated ${report.mutated} !== ${expect.mutated}`);
  if (expect.attempts_used !== undefined) check(report.attempts_used === expect.attempts_used, `attempts_used ${report.attempts_used} !== ${expect.attempts_used}`);
  if (expect.eligible) check(deepEqual(report.eligible_issues, expect.eligible), `eligible ${JSON.stringify(report.eligible_issues)} !== ${JSON.stringify(expect.eligible)}`);
  if (expect.unresolved) check(deepEqual(report.unresolved_issues, expect.unresolved), `unresolved ${JSON.stringify(report.unresolved_issues)} !== ${JSON.stringify(expect.unresolved)}`);
  if (expect.conditional) check(deepEqual(report.conditional_issues, expect.conditional), `conditional ${JSON.stringify(report.conditional_issues)} !== ${JSON.stringify(expect.conditional)}`);
  if (expect.attempts_count !== undefined) check(report.attempts.length === expect.attempts_count, `attempts ${report.attempts.length} !== ${expect.attempts_count}`);
  if (expect.completion_passed !== undefined) check(report.completion_check.passed === expect.completion_passed, `completion_check.passed ${report.completion_check.passed} !== ${expect.completion_passed}`);
  if (expect.next_actions_min !== undefined) check(report.next_actions.length >= expect.next_actions_min, `next_actions ${report.next_actions.length} < ${expect.next_actions_min}`);

  // Two-layer adjudication (#1616): the per-issue composite verdict, the state the
  // semantic gate reached, and the verdict its document carried are all asserted
  // separately, so a case cannot pass by accident with the gates conflated.
  for (const [num, verdict] of Object.entries(expect.verdicts ?? {})) {
    const assessment = lastAssessmentOf(report, Number(num));
    if (check(assessment !== undefined, `#${num} has no assessment`)) {
      check(assessment.verdict === verdict, `#${num} verdict "${assessment.verdict}" !== "${verdict}"`);
    }
  }
  for (const [num, state] of Object.entries(expect.acceptance_states ?? {})) {
    const assessment = lastAssessmentOf(report, Number(num));
    if (check(assessment !== undefined, `#${num} has no assessment`)) {
      check(assessment.acceptance.state === state, `#${num} acceptance state "${assessment.acceptance.state}" !== "${state}"`);
    }
  }
  for (const [num, verdict] of Object.entries(expect.acceptance_verdicts ?? {})) {
    const assessment = lastAssessmentOf(report, Number(num));
    if (check(assessment !== undefined, `#${num} has no assessment`)) {
      check(assessment.acceptance.verdict === verdict, `#${num} acceptance verdict ${JSON.stringify(assessment.acceptance.verdict)} !== ${JSON.stringify(verdict)}`);
    }
  }
  for (const [num, source] of Object.entries(expect.verdict_sources ?? {})) {
    const assessment = lastAssessmentOf(report, Number(num));
    if (check(assessment !== undefined, `#${num} has no assessment`)) {
      check(assessment.verdict_source === source, `#${num} verdict_source "${assessment.verdict_source}" !== "${source}"`);
    }
  }
  // A degraded acceptance gate is recorded, never silent.
  for (const code of expect.limitation_codes ?? []) {
    check(report.limitations.some((entry) => entry.code === code), `limitation "${code}" was expected but not recorded`);
  }
  for (const code of expect.absent_limitation_codes ?? []) {
    check(!report.limitations.some((entry) => entry.code === code), `limitation "${code}" should be absent but was recorded`);
  }
  for (const code of expect.blocking_codes ?? []) {
    check(report.blocking_reasons.some((entry) => entry.code === code), `blocking reason "${code}" was expected but not recorded`);
  }
  if (expect.acceptance_summary) {
    for (const [key, count] of Object.entries(expect.acceptance_summary)) {
      check(report.acceptance.verdicts[key] === count, `acceptance verdict count ${key}=${report.acceptance.verdicts[key]} !== ${count}`);
    }
  }
  if (expect.acceptance_configured !== undefined) {
    check(report.acceptance.configured === expect.acceptance_configured, `acceptance.configured ${report.acceptance.configured} !== ${expect.acceptance_configured}`);
  }
  // The no_go findings must actually reach the fix worker: a repair driven by
  // "UAT failed" is a guess, one driven by the failing criterion is not.
  for (const [num, needles] of Object.entries(expect.fix_prompt_contains ?? {})) {
    const promptPath = join(uatOut, 'attempts', 'attempt-0', `fix-issue-${num}.md`);
    if (check(existsSync(promptPath), `fix prompt for #${num} was not written at attempts/attempt-0/`)) {
      const prompt = readFileSync(promptPath, 'utf8');
      for (const needle of needles) check(prompt.includes(needle), `fix prompt for #${num} does not quote ${JSON.stringify(needle)}`);
    }
  }
  checkAcceptanceNeverRounded(report);

  // The bounded-loop guarantee: attempts_used never exceeds max_attempts.
  check(report.attempts_used <= report.max_attempts, `attempts_used ${report.attempts_used} exceeded max_attempts ${report.max_attempts}`);
  // A cap-reached stop is reported as blocked with the unresolved issue named,
  // never rounded up to success.
  if (report.stop_reason === 'max_attempts_reached') {
    check(report.status === 'blocked', `max_attempts_reached but status is "${report.status}", not blocked`);
    check(report.unresolved_issues.length > 0, 'blocked at the cap but no unresolved issue was named');
  }

  // The gate proofs come from the fake's invocation log.
  const cliLog = readCliLog(logPath);
  const worktreeAddCalls = countCalls(cliLog, 'worktree', 'add');
  const sendCalls = countCalls(cliLog, 'send');
  const mergeCalls = countCalls(cliLog, 'merge');
  // UAT acceptance is a profile-baseline run in the worktree (not a commandmate
  // call), so it is counted from the report's per-issue assessments.
  const uatCalls = report.attempts.reduce((sum, a) => sum + a.uat_results.length, 0);

  if (expect.worktree_add_calls !== undefined) check(worktreeAddCalls === expect.worktree_add_calls, `worktree add called ${worktreeAddCalls} time(s) !== ${expect.worktree_add_calls}`);
  if (expect.send_calls !== undefined) check(sendCalls === expect.send_calls, `send called ${sendCalls} time(s) !== ${expect.send_calls}`);
  if (expect.merge_calls !== undefined) check(mergeCalls === expect.merge_calls, `git merge called ${mergeCalls} time(s) !== ${expect.merge_calls}`);
  if (expect.uat_calls_min !== undefined) check(uatCalls >= expect.uat_calls_min, `uat called ${uatCalls} time(s) < ${expect.uat_calls_min}`);
  if (expect.uat_calls_max !== undefined) check(uatCalls <= expect.uat_calls_max, `uat called ${uatCalls} time(s) > ${expect.uat_calls_max}`);
  // Approval gate: without --approve nothing is created, dispatched or re-merged.
  if (expect.no_mutation) {
    check(worktreeAddCalls === 0 && sendCalls === 0 && mergeCalls === 0, `a mutating call ran on a no-approve path (worktree=${worktreeAddCalls}, send=${sendCalls}, merge=${mergeCalls})`);
  }

  // Append-only history: each attempt is written under attempts/attempt-<n>/ and
  // recorded once in attempts/history.jsonl — a prior attempt is never overwritten.
  const historyPath = join(uatOut, 'attempts', 'history.jsonl');
  if (report.attempts.length > 0) {
    if (check(existsSync(historyPath), 'attempts/history.jsonl was not written')) {
      const lines = readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
      check(lines.length === report.attempts.length, `history has ${lines.length} line(s) but the report has ${report.attempts.length} attempt(s)`);
      const indices = report.attempts.map((a) => a.index);
      check(deepEqual(indices, indices.map((_, i) => i)), `attempt indices ${JSON.stringify(indices)} are not a 0..n append sequence`);
    }
    // The output directory must refuse to be overwritten on a second run.
    const second = runUatRunner(planPath, dispatchPath, uatOut, phaseFlag, uatArgs, env, integration);
    let secondReport;
    try {
      secondReport = JSON.parse(second.stdout);
      check(secondReport.blocking_reasons.some((r) => r.code === 'out_exists'), 're-running into the same out dir did not refuse with out_exists');
    } catch {
      check(false, 'second uat run did not emit a JSON failure envelope');
    }
  }

  // Determinism of the composition (#1616): the same acceptance documents and the
  // same worktree world must yield the same per-issue adjudication. Only the
  // read-only phase is re-run — a fix loop mutates the fake CLI's state, so a
  // second run of it is a different world by construction, not a different verdict.
  if (acceptanceDir && spec.phase !== 'fix_uat') {
    const third = runUatRunner(planPath, dispatchPath, join(workUat, 'uat-again'), phaseFlag, uatArgs, env, integration);
    try {
      const repeat = JSON.parse(third.stdout);
      check(third.exit === exit, `re-run exit ${third.exit} !== ${exit} — the adjudication is not deterministic`);
      const shapeOf = (r) => allAssessments(r).map((u) => [u.issue, u.verdict, u.verdict_source, u.acceptance.state, u.acceptance.verdict]);
      check(deepEqual(shapeOf(repeat), shapeOf(report)), 'the composed adjudication differs across two identical runs');
    } catch {
      check(false, 'the determinism re-run did not emit a JSON report');
    }
  }
}

// =============================================================================
// Status cases: the read-only run status view (phase × issue matrix)
// =============================================================================
//
// The status runner joins the four artifacts a run leaves behind, so unlike every
// other suite here its input IS a run directory rather than a scenario to execute.
// Each case therefore ships `run/` — real output of the real runners, generated
// once and checked in — and the suite runs status.mjs against it twice.
//
// Two properties make checked-in artifacts safe to assert against:
//
//   1. Every artifact is validated against the SHIPPED schema before the view is
//      examined (`schema_unvalidatable` exempts the deliberately corrupt ones), so
//      a fixture cannot drift into a shape the runners no longer write and quietly
//      keep the suite green.
//   2. The two runs must be byte-identical, which is what `--json` promises
//      (Claude/Codex parity). A view that reached for a clock, a temp path or an
//      unordered iteration would fail here.
//
// The invariants asserted on EVERY case — not per case — are the three the runner
// exists to hold: a phase with no artifact is 未実行, a phase whose artifact will
// not parse is 読取不能 and takes nothing else down with it, and neither is ever
// silently upgraded into a state the artifacts do not prove.

const STATUS_ARTIFACT_SCHEMAS = new Map([
  ['plan.json', planSchemaFor],
  ['dispatch-report.json', dispatchSchema],
  ['merge-report.json', mergeSchema],
  ['uat-report.json', uatSchema],
]);

function runStatusRunner(runDir, extraArgs = []) {
  try {
    const stdout = execFileSync('node', [STATUS_RUNNER, '--run', runDir, ...extraArgs], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: baseEnv(),
    });
    return { exit: 0, stdout };
  } catch (error) {
    return { exit: error.status ?? 1, stdout: error.stdout ? error.stdout.toString() : '' };
  }
}

// Every file under a case's run/, as run-relative paths in sorted order.
function statusRunFiles(runDir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(prefix === '' ? runDir : join(runDir, prefix), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...statusRunFiles(runDir, relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

function statusArtifactPaths(runDir) {
  return statusRunFiles(runDir).filter((relative) => STATUS_ARTIFACT_SCHEMAS.has(basename(relative)));
}

// The whole fixture, content included. The status runner is read-only, so this
// must be identical after it has run — a view that left a cache or a report
// behind would not be safe to point at a live run.
function statusRunSnapshot(runDir) {
  return statusRunFiles(runDir).map((relative) => `${relative}\n${readFileSync(join(runDir, relative), 'utf8')}`).join(' ');
}

function statusActionKeys(actions) {
  return actions.map((action) => `${action.phase}/${action.source}/${action.code}`);
}

// The hint for a code, from wherever it was reported. A code is expected to carry
// the SAME action whether it surfaced at run level or against an issue.
function statusHintsByCode(view) {
  const hints = new Map();
  for (const action of [...view.next_actions, ...view.issues.flatMap((issue) => issue.next_actions)]) {
    if (!hints.has(action.code)) hints.set(action.code, action.hint);
  }
  return hints;
}

function runStatusCase(caseId) {
  const caseDir = join(STATUS_CASES_DIR, caseId);
  const spec = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'));
  const runDir = join(caseDir, 'run');
  log(`  ${caseId}: ${spec.description}`);
  if (!check(existsSync(join(runDir, 'plan.json')), `${caseId}: run/plan.json is missing`)) return;

  const expect = spec.expect;
  const before = statusRunSnapshot(runDir);

  // ---- the fixture artifacts are what the runners actually write -------------
  const unvalidatable = new Set(expect.schema_unvalidatable ?? []);
  for (const relative of statusArtifactPaths(runDir)) {
    if (unvalidatable.has(relative)) continue;
    let document;
    try {
      document = JSON.parse(readFileSync(join(runDir, relative), 'utf8'));
    } catch (error) {
      check(false, `fixture ${relative} is not JSON and is not declared in schema_unvalidatable: ${error.message}`);
      continue;
    }
    const schemaOrPicker = STATUS_ARTIFACT_SCHEMAS.get(basename(relative));
    const schema = typeof schemaOrPicker === 'function' ? schemaOrPicker(document) : schemaOrPicker;
    const errors = validateAgainst(schema, document, relative);
    check(errors.length === 0, `fixture ${relative} does not conform to its shipped schema: ${errors.slice(0, 3).join('; ')}`);
  }

  // ---- the text view --------------------------------------------------------
  const text = runStatusRunner(runDir);
  check(text.exit === expect.exit, `text exit ${text.exit} !== expected ${expect.exit}`);
  for (const needle of expect.text_includes ?? []) {
    check(text.stdout.includes(needle), `the text view does not contain ${JSON.stringify(needle)}`);
  }
  for (const needle of expect.text_absent ?? []) {
    check(!text.stdout.includes(needle), `the text view should not contain ${JSON.stringify(needle)}`);
  }

  // ---- the structured view --------------------------------------------------
  const json = runStatusRunner(runDir, ['--json']);
  check(json.exit === expect.exit, `--json exit ${json.exit} !== expected ${expect.exit}`);
  let view;
  try {
    view = JSON.parse(json.stdout);
  } catch {
    check(false, `--json stdout is not valid JSON (exit ${json.exit}): ${json.stdout.slice(0, 200)}`);
    return;
  }

  // Determinism: the same run directory yields byte-identical JSON.
  const repeat = runStatusRunner(runDir, ['--json']);
  check(repeat.stdout === json.stdout, '--json is not byte-identical across two runs of the same run directory');

  if (expect.latest_phase !== undefined) {
    check(view.latest_phase_with_evidence === expect.latest_phase, `latest_phase_with_evidence "${view.latest_phase_with_evidence}" !== "${expect.latest_phase}"`);
  }
  if (expect.run_id !== undefined) check(view.run.run_id === expect.run_id, `run_id ${JSON.stringify(view.run.run_id)} !== ${JSON.stringify(expect.run_id)}`);
  if (expect.profile_id !== undefined) check(view.run.profile?.id === expect.profile_id, `profile.id ${JSON.stringify(view.run.profile?.id)} !== ${JSON.stringify(expect.profile_id)}`);

  for (const [phase, state] of Object.entries(expect.phase_states ?? {})) {
    check(view.phases[phase]?.state === state, `phase ${phase} state "${view.phases[phase]?.state}" !== "${state}"`);
  }
  if (expect.unreadable_paths) {
    check(
      deepEqual(view.unreadable.map((entry) => entry.path), expect.unreadable_paths),
      `unreadable ${JSON.stringify(view.unreadable.map((e) => e.path))} !== ${JSON.stringify(expect.unreadable_paths)}`,
    );
  }
  if (expect.issues) {
    check(deepEqual(view.issues.map((issue) => issue.number), expect.issues), `issues ${JSON.stringify(view.issues.map((i) => i.number))} !== ${JSON.stringify(expect.issues)}`);
  }

  const issueOfView = (number) => view.issues.find((issue) => issue.number === number);
  for (const [number, states] of Object.entries(expect.issue_states ?? {})) {
    const issue = issueOfView(Number(number));
    if (!check(issue !== undefined, `#${number} has no row in the view`)) continue;
    for (const [phase, state] of Object.entries(states)) {
      check(issue[phase].state === state, `#${number} ${phase} state "${issue[phase].state}" !== "${state}"`);
    }
  }
  // plan / dispatch / merge / uat facts, asserted per issue and per field, so a
  // cell that reads plausibly but names the wrong wave, PR or verdict fails.
  for (const [number, plan] of Object.entries(expect.plan ?? {})) {
    const issue = issueOfView(Number(number));
    if (!check(issue !== undefined, `#${number} has no row in the view`)) continue;
    if (plan.wave !== undefined) check(issue.plan.wave === plan.wave, `#${number} plan.wave ${issue.plan.wave} !== ${plan.wave}`);
    if (plan.depends_on !== undefined) {
      check(deepEqual(issue.plan.depends_on.map((dep) => dep.issue), plan.depends_on), `#${number} depends_on ${JSON.stringify(issue.plan.depends_on)} !== ${JSON.stringify(plan.depends_on)}`);
    }
    if (plan.branch_includes !== undefined) check(String(issue.plan.branch).includes(plan.branch_includes), `#${number} branch ${JSON.stringify(issue.plan.branch)} does not contain "${plan.branch_includes}"`);
  }
  for (const [number, dispatch] of Object.entries(expect.dispatch ?? {})) {
    const issue = issueOfView(Number(number));
    if (!check(issue !== undefined, `#${number} has no row in the view`)) continue;
    for (const field of ['worker_state', 'verification_outcome', 'wave_index']) {
      if (dispatch[field] !== undefined) check(issue.dispatch[field] === dispatch[field], `#${number} dispatch.${field} ${JSON.stringify(issue.dispatch[field])} !== ${JSON.stringify(dispatch[field])}`);
    }
    if (dispatch.gates !== undefined) {
      const gates = issue.dispatch.gates.map((gate) => `${gate.id}=${gate.verdict}`);
      check(deepEqual(gates, dispatch.gates), `#${number} gates ${JSON.stringify(gates)} !== ${JSON.stringify(dispatch.gates)}`);
    }
  }
  for (const [number, merge] of Object.entries(expect.merge ?? {})) {
    const issue = issueOfView(Number(number));
    if (!check(issue !== undefined, `#${number} has no row in the view`)) continue;
    for (const field of ['pr_number', 'merged', 'ci_verdict']) {
      if (merge[field] !== undefined) check(issue.merge[field] === merge[field], `#${number} merge.${field} ${JSON.stringify(issue.merge[field])} !== ${JSON.stringify(merge[field])}`);
    }
    if (merge.outcomes !== undefined) {
      const outcomes = issue.merge.outcomes.map((entry) => `${entry.phase}:${entry.outcome}`);
      check(deepEqual(outcomes, merge.outcomes), `#${number} merge outcomes ${JSON.stringify(outcomes)} !== ${JSON.stringify(merge.outcomes)}`);
    }
    if (merge.pr_url_includes !== undefined) check(String(issue.merge.pr_url).includes(merge.pr_url_includes), `#${number} pr_url ${JSON.stringify(issue.merge.pr_url)} does not contain "${merge.pr_url_includes}"`);
  }
  for (const [number, uat] of Object.entries(expect.uat ?? {})) {
    const issue = issueOfView(Number(number));
    if (!check(issue !== undefined, `#${number} has no row in the view`)) continue;
    for (const field of ['verdict', 'outcome', 'fix_attempts', 'unresolved', 'conditional']) {
      if (uat[field] !== undefined) check(issue.uat[field] === uat[field], `#${number} uat.${field} ${JSON.stringify(issue.uat[field])} !== ${JSON.stringify(uat[field])}`);
    }
  }

  // ---- next actions: exact and ordered --------------------------------------
  // Exact rather than "contains", in both directions: an invented action is as
  // wrong as a dropped one. This is the assertion that pins the §5 mapping.
  if (expect.run_next) {
    check(deepEqual(statusActionKeys(view.next_actions), expect.run_next), `run next_actions ${JSON.stringify(statusActionKeys(view.next_actions))} !== ${JSON.stringify(expect.run_next)}`);
  }
  for (const [number, keys] of Object.entries(expect.issue_next ?? {})) {
    const issue = issueOfView(Number(number));
    if (!check(issue !== undefined, `#${number} has no row in the view`)) continue;
    check(deepEqual(statusActionKeys(issue.next_actions), keys), `#${number} next_actions ${JSON.stringify(statusActionKeys(issue.next_actions))} !== ${JSON.stringify(keys)}`);
  }
  // A hint is what the operator actually acts on: a code mapped to the wrong
  // sentence is worse than an unmapped code, which at least says so.
  const hints = statusHintsByCode(view);
  for (const [code, needle] of Object.entries(expect.hints_include ?? {})) {
    const hint = hints.get(code);
    if (check(hint !== undefined, `no next action carries the code "${code}"`)) {
      check(hint.includes(needle), `the hint for "${code}" (${JSON.stringify(hint)}) does not contain "${needle}"`);
      check(text.stdout.includes(hint), `the hint for "${code}" is in the JSON but not in the text view`);
    }
  }

  // ---- redaction ------------------------------------------------------------
  if (expect.redaction_token) {
    check(!json.stdout.includes(expect.redaction_token), 'a raw token survived into the structured status view');
    check(!text.stdout.includes(expect.redaction_token), 'a raw token survived into the text status view');
    check(json.stdout.includes('[REDACTED-TOKEN]'), 'the token was not replaced with a redaction marker');
  }
  if (expect.redaction_kind) {
    check(
      view.redactions.some((entry) => entry.kind === expect.redaction_kind && entry.count >= 1),
      `redactions did not record kind "${expect.redaction_kind}"`,
    );
  }
  // The run directory is a displayed value, so it obeys the same policy. Only
  // asserted when this checkout sits under a path the redaction list covers —
  // otherwise there is nothing to redact and a failure here would be about where
  // the repository happens to live.
  if (/^(?:\/Users\/|\/home\/|\/root\/|\/var\/|\/private\/|\/tmp\/)/.test(runDir)) {
    check(view.run.dir === '[REDACTED-PATH]', `the run directory was displayed unredacted: ${JSON.stringify(view.run.dir)}`);
  }

  // ---- invariants asserted on every case ------------------------------------
  //
  // 1. A phase state is never invented: no artifact => 未実行 for every issue, and
  //    every artifact unreadable => 読取不能 for every issue. This is the guarantee
  //    that a status view cannot fill a gap with the phase before it.
  for (const phase of ['plan', 'dispatch', 'merge', 'uat']) {
    const phaseView = view.phases[phase];
    for (const issue of view.issues) {
      if (phaseView.state === 'not_run') {
        check(issue[phase].state === 'not_run', `#${issue.number} ${phase} is "${issue[phase].state}" while the phase has no artifact`);
      }
      if (phaseView.state === 'unreadable') {
        check(issue[phase].state === 'unreadable', `#${issue.number} ${phase} is "${issue[phase].state}" while every ${phase} artifact is unreadable`);
      }
    }
    // 2. The human-readable half says the same thing. A fact that only exists in
    //    the JSON is a fact the supervisor reading the table will miss.
    if (phaseView.state === 'not_run') check(text.stdout.includes('未実行'), `${phase} has no artifact but the text view never says 未実行`);
    if (phaseView.state === 'unreadable') check(text.stdout.includes('読取不能'), `${phase} is unreadable but the text view never says 読取不能`);
    // 3. Every artifact the view names is a file that exists, and every readable
    //    one carries the report headline the matrix was built from.
    for (const artifact of phaseView.artifacts) {
      check(existsSync(join(runDir, artifact.path)), `${phase} names an artifact that does not exist: ${artifact.path}`);
      check(
        (artifact.state === 'ok') === (artifact.report !== null),
        `${phase} artifact ${artifact.path} is "${artifact.state}" but its report headline is ${artifact.report === null ? 'null' : 'present'}`,
      );
    }
  }
  // 4. Nothing is written. Three invocations have run against this directory by
  //    now; every file in it must still be byte-identical, and no file added.
  check(statusRunSnapshot(runDir) === before, 'the status runner changed the run directory — it must be read-only');
}

// =============================================================================
// Contract parity: the runners only ever call the real commandmate CLI surface
// =============================================================================
//
// This is the #1467 regression guard. The runners used to shell out to a task
// based CLI (`send --json --worktree --prompt-file`, `wait --task`, `verify`,
// `uat`) that the real `commandmate` does not have, so they failed on first
// contact. Here we (B) drive a real dispatch run and assert every commandmate
// call the runner makes is within commandmate-cli-contract.json (subcommand and
// flags), and (C) — when a real `commandmate` is on PATH — assert that contract
// is itself a subset of the live `--help`. The fake CLI additionally rejects any
// off-contract flag at call time, so every fixture case is a parity check too.

const COMMANDMATE_SUBS = ['ls', 'send', 'wait', 'capture', 'respond', 'verify', 'sync'];

function resolveRealCli() {
  const bin = process.env.CMATE_REAL_CLI || 'commandmate';
  try {
    const version = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { bin, version: parseVersion(version) };
  } catch (error) {
    // ENOENT => not installed (skip live check); any other error => it exists.
    return error.code === 'ENOENT' ? null : { bin, version: null };
  }
}

function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// Is the installed CLI at least `since`? An unreadable version is treated as
// "too old" so the check errs toward skipping rather than toward a false drift.
function atLeast(version, since) {
  const want = parseVersion(since);
  if (!want) return true;
  if (!version) return false;
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== want[i]) return version[i] > want[i];
  }
  return true;
}

// (C) Contract ⊆ real CLI. Entries carrying a `since` (Issue #1588: `verify`,
// `send --contract`, `wait --verify`) are asserted only against a binary new
// enough to have them, and every skip is printed — a silent skip would let the
// contract drift on exactly the flags the version gate exists for.
function liveContractCheck(contract) {
  const real = resolveRealCli();
  if (!real) {
    log('    (no real commandmate on PATH; skipping live --help parity)');
    return;
  }
  const { bin, version } = real;
  log(`    (live commandmate ${version ? version.join('.') : 'version unknown'})`);
  for (const [sub, spec] of Object.entries(contract.subcommands)) {
    if (spec.since && !atLeast(version, spec.since)) {
      log(`    (skipping live parity for "${sub}": needs commandmate >= ${spec.since})`);
      continue;
    }
    let help = '';
    try {
      help = execFileSync(bin, [sub, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      help = error.stdout ? error.stdout.toString() : '';
    }
    if (!check(help.length > 0, `real commandmate ${sub} --help produced no output (subcommand missing?)`)) continue;
    for (const flag of spec.flags) {
      const since = spec.since_flags?.[flag];
      if (since && !atLeast(version, since)) {
        log(`    (skipping live parity for "${sub} ${flag}": needs commandmate >= ${since})`);
        continue;
      }
      check(help.includes(flag), `real commandmate ${sub} --help does not list ${flag} — the contract drifted from the CLI`);
      // A flag whose argument is an enum is only useful if the enum is right: the
      // runner picks ONE of these values and a wrong one aborts the dispatch
      // (Issue #136). The real `--help` prints them ("Auto-yes duration (1h, 3h,
      // 8h)"), so drift in the set is visible here rather than in production.
      for (const value of spec.flag_values?.[flag] ?? []) {
        check(help.includes(value), `real commandmate ${sub} --help does not offer ${flag} ${value} — the contract's value set drifted`);
      }
    }
  }
}

function parityTest() {
  log('  contract parity (commandmate CLI surface)');
  const contract = JSON.parse(readFileSync(CLI_CONTRACT_PATH, 'utf8'));
  const subs = contract.subcommands ?? {};
  check(COMMANDMATE_SUBS.every((s) => subs[s]), 'the CLI contract is missing a commandmate subcommand the runners use');

  // (B) Runner ⊆ contract. Three runs are needed to reach the whole surface:
  //   1. a legacy --auto-yes prompt run: ls -> send -> wait (prompt) -> capture
  //      -> respond -> wait;
  //   2. a contract run whose verdict is 20: send --help / wait --help (the
  //      version gate) -> send --contract -> wait --verify -> verify --json;
  //   3. a run whose worktree is registered only after a re-scan: ls -> sync ->
  //      ls (Issue #91).
  // The logs are unioned, so a flag that only one path uses is still
  // parity-checked (Issue #1588).
  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-parity-plan-'));
  const spec = { plan: { issues_fixture: 'cases/02-explicit-dependency/issues.json', orchestrate_args: ['200', '201', '--max-parallel', '3', '--run-id', 'plan'] } };
  const planPath = generatePlan(spec, runsDir);
  if (!check(existsSync(planPath), 'parity: plan.json was not generated')) return;

  const work = mkdtempSync(join(tmpdir(), 'cmate-parity-'));
  const outDir = join(work, 'dispatch');
  const logPath = join(work, 'cli.log');
  const scenario = {
    cli_available: true,
    git: { branch: 'feature/integration', dirty: false },
    gh: { repo_access: true },
    workers: {
      201: { state: 'prompt', prompt: 'Proceed? [y/N]', verify: 'pass' },
      200: { state: 'completed', verify: 'pass' },
    },
  };
  runDispatchRunner(planPath, scenario, work, outDir, ['--auto-yes'], logPath);

  const contractWork = mkdtempSync(join(tmpdir(), 'cmate-parity-contract-'));
  const contractLog = join(contractWork, 'cli.log');
  runDispatchRunner(planPath, {
    cli_available: true,
    cli_contract: true,
    git: { branch: 'feature/integration', dirty: false },
    gh: { repo_access: true },
    workers: {
      201: { state: 'completed', verify_exits: [20], failed_gates: ['lint'] },
      200: { state: 'completed', verify_exits: [0] },
    },
  }, contractWork, join(contractWork, 'dispatch'), ['--max-turns', '1'], contractLog);

  const syncWork = mkdtempSync(join(tmpdir(), 'cmate-parity-sync-'));
  const syncLog = join(syncWork, 'cli.log');
  runDispatchRunner(planPath, {
    cli_available: true,
    git: { branch: 'feature/integration', dirty: false },
    gh: { repo_access: true },
    sync_only_worktrees: [201],
    workers: {
      201: { state: 'completed', verify: 'pass' },
      200: { state: 'completed', verify: 'pass' },
    },
  }, syncWork, join(syncWork, 'dispatch'), [], syncLog);

  const calls = [...readCliLog(logPath), ...readCliLog(contractLog), ...readCliLog(syncLog)].filter((entry) => COMMANDMATE_SUBS.includes(entry.sub));
  const used = new Set(calls.map((entry) => entry.sub));
  for (const sub of COMMANDMATE_SUBS) {
    check(used.has(sub), `the runner never exercised commandmate ${sub}, so its parity is untested`);
  }
  let violations = 0;
  for (const entry of calls) {
    const allowed = new Set(subs[entry.sub]?.flags ?? []);
    for (const token of entry.args) {
      if (typeof token !== 'string' || !token.startsWith('--')) continue;
      const flag = token.split('=')[0];
      if (!allowed.has(flag)) {
        violations += 1;
        check(false, `runner called commandmate ${entry.sub} with ${flag}, outside the CLI contract`);
      }
    }
  }
  check(violations === 0, `runner made ${violations} commandmate call(s) outside the CLI contract`);

  // (C) Contract ⊆ real CLI, when a real binary is available.
  liveContractCheck(contract);
}

// =============================================================================
// Launcher resolution (Issue #37)
// =============================================================================
//
// Removing the global install takes the bare `commandmate` off PATH, so the
// orchestrator-side runners have to reach the CLI the way monitor.sh does. Three
// claims are proved here, against the real dispatch and uat runners:
//
//   1. a MULTI-TOKEN launcher runs. `npx commandmate@latest` is a program plus an
//      argument, and execFileSync takes no shell, so before this it died with
//      ENOENT on a program name containing a space. The stand-in here is
//      `node <fake-cli>` — same shape, no network.
//   2. `CM` alone is enough. The acceptance criterion is "no global install, only
//      CM set", so the run must succeed with --cli omitted entirely.
//   3. a launcher nothing can execute is refused WITH ADVICE, not with ENOENT
//      from somewhere deep in the run — and --cli still beats CM.
//
// And the property the resolution must not cost: the plan is unchanged by it.

const LAUNCHER_SCENARIO = {
  cli_available: true,
  git: { branch: 'feature/integration', dirty: false },
  gh: { repo_access: true },
  workers: {
    201: { state: 'completed', verify: 'pass' },
    200: { state: 'completed', verify: 'pass' },
  },
};

// A dispatch run that must reach the workers, driven through `launcher`.
function dispatchWithLauncher(planPath, opts) {
  const work = mkdtempSync(join(tmpdir(), 'cmate-launcher-'));
  return runDispatchRunner(planPath, LAUNCHER_SCENARIO, work, join(work, 'dispatch'), [], null, opts);
}

function launcherReport(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// The worktree-setup provider's ARGUMENT contract (Issue #93). These four
// refusals never reach a world, so they are checked here rather than as dispatch
// cases: what is being asserted is that a misconfiguration is refused up front,
// with a message about the flag the operator actually typed.
//
// The `--profile` / `--base` refusals are the "same profile on both sides" rule
// made mechanical. A provider handed a second profile resolves a second
// `branch_template` and creates branches the plan does not name; the symptom is
// "no registered worktree matches branch …", which reads as a missing worktree
// and is really a disagreement between two profiles.
function worktreeSetupInputTest() {
  log('  worktree-setup input (#93)');
  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-wtsetup-plan-'));
  const spec = { plan: { issues_fixture: 'cases/02-explicit-dependency/issues.json', orchestrate_args: ['200', '201', '--max-parallel', '3', '--run-id', 'plan'] } };
  const planPath = generatePlan(spec, runsDir);
  if (!check(existsSync(planPath), 'worktree-setup: plan.json was not generated')) return;

  const refusals = [
    ['a provider with no --prepare-worktrees', ['--worktree-setup', `${FAKE_CLI} worktree-setup`], 'needs --prepare-worktrees'],
    ['a second profile on the provider', ['--prepare-worktrees', '--worktree-setup', `${FAKE_CLI} worktree-setup --profile rust`], 'must not carry --profile'],
    ['a second base on the provider', ['--prepare-worktrees', '--worktree-setup', `${FAKE_CLI} worktree-setup --base origin/main`], 'must not carry --base'],
    ['a second issue set on the provider', ['--prepare-worktrees', '--worktree-setup', `${FAKE_CLI} worktree-setup --issues 9999`], 'must not carry --issues'],
    ['shell syntax in --worktree-setup', ['--prepare-worktrees', '--worktree-setup', `${FAKE_CLI} | tee /tmp/x`], 'contains shell syntax'],
  ];
  for (const [label, args, needle] of refusals) {
    const work = mkdtempSync(join(tmpdir(), 'cmate-wtsetup-'));
    const outDir = join(work, 'dispatch');
    const result = runDispatchRunner(planPath, LAUNCHER_SCENARIO, work, outDir, args, null);
    const report = launcherReport(result);
    const detail = (report?.blocking_reasons ?? []).map((entry) => `${entry.code} ${entry.detail}`).join(' ');
    check(result.exit === 3, `${label}: expected exit 3, got ${result.exit}: ${result.stdout.slice(0, 200)}`);
    check(detail.includes('invalid_input'), `${label}: expected an invalid_input error, got: ${detail.slice(0, 200)}`);
    check(detail.includes(needle), `${label}: the error should say "${needle}", got: ${detail.slice(0, 300)}`);
    // The guard is shared with `--cli`; the MESSAGE must not be. An operator who
    // typed --worktree-setup and is told to fix --cli has been sent to the wrong
    // flag — both are launchers and both are usually set.
    check(!detail.includes('--cli '), `${label}: the error names --cli, but the operator typed --worktree-setup: ${detail.slice(0, 300)}`);
    check(!existsSync(outDir), `${label}: a refused invocation created ${outDir}`);
  }
}

// =============================================================================
// Reverify: the refused flag combinations (Issue #121)
// =============================================================================
//
// Checked here rather than as resume cases because none of them reaches a world:
// what is asserted is that the invocation is refused BEFORE anything is probed —
// exit 3 (or 6 for a directory that is not there), `invalid_input`, no output
// directory, and not one call to any CLI.
//
// `--resume` + `--reverify` is the row that matters. They are opposite answers
// to the same question about every not-carried issue — "send it back to its
// worker" vs "judge what is already there and send nothing" — so accepting both
// would make the runner pick one, and the wrong pick either burns a worker turn
// or leaves unfinished work unfinished. Refusing is the same shape as #98's
// `--out` + `--resume` refusal and #93's double-specified provider profile.
function reverifyInputTest() {
  log('  reverify input (#121)');
  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-reverify-plan-'));
  const spec = { plan: { issues_fixture: 'cases/02-explicit-dependency/issues.json', orchestrate_args: ['200', '201', '--max-parallel', '3', '--run-id', 'plan'] } };
  const planPath = generatePlan(spec, runsDir);
  if (!check(existsSync(planPath), 'reverify: plan.json was not generated')) return;

  const refusals = [
    ['--out with --reverify', {}, ['--reverify', runsDir], 3, 'mutually exclusive'],
    ['--resume with --reverify', { resumeDir: runsDir }, ['--reverify', runsDir], 3, 'cannot both hold'],
    // Not a combination but the same "refused before the world" family: a
    // directory that holds no prior run cannot be re-judged, and saying so with
    // load_error (exit 6) is what --resume already does.
    ['--reverify on a directory that does not exist', { reverifyDir: join(runsDir, 'nope') }, [], 6, 'does not exist'],
  ];
  for (const [label, opts, args, exitCode, needle] of refusals) {
    const work = mkdtempSync(join(tmpdir(), 'cmate-reverify-'));
    const outDir = join(work, 'dispatch');
    const logPath = join(work, 'cli.log');
    const result = runDispatchRunner(planPath, LAUNCHER_SCENARIO, work, outDir, args, logPath, opts);
    const report = launcherReport(result);
    const detail = (report?.blocking_reasons ?? []).map((entry) => `${entry.code} ${entry.detail}`).join(' ');
    check(result.exit === exitCode, `${label}: expected exit ${exitCode}, got ${result.exit}: ${result.stdout.slice(0, 200)}`);
    check(detail.includes(needle), `${label}: the error should say "${needle}", got: ${detail.slice(0, 300)}`);
    check(!existsSync(outDir), `${label}: a refused invocation created ${outDir}`);
    check(readCliLog(logPath).length === 0, `${label}: a refused invocation called the CLI ${readCliLog(logPath).length} time(s)`);
  }
}

// =============================================================================
// Unattended: refused inputs and the exclusivity lock (Issue #122)
// =============================================================================
//
// The world every unattended run below expects: a contract-capable CLI (the mode
// implies `--contract-mode require`) whose two workers complete and pass.
const UNATTENDED_SCENARIO = {
  cli_available: true,
  cli_contract: true,
  git: { branch: 'feature/integration', dirty: false },
  gh: { repo_access: true },
  workers: {
    201: { state: 'completed', verify_exits: [0] },
    200: { state: 'completed', verify_exits: [0] },
  },
};

const UNATTENDED_ARGS = ['--expect-branch', 'feature/integration', '--unattended', '--wall-clock-budget', '600'];

function unattendedPlan(prefix) {
  const runsDir = mkdtempSync(join(tmpdir(), prefix));
  const spec = { plan: { issues_fixture: 'cases/02-explicit-dependency/issues.json', orchestrate_args: ['200', '201', '--max-parallel', '3', '--run-id', 'plan'] } };
  return generatePlan(spec, runsDir);
}

// The refused combinations (ADR §2 invariant 2 / §12.1 (5)). Checked here rather
// than as dispatch cases because what is asserted is that the invocation is
// refused BEFORE it reaches a world: exit 3, `invalid_input`, no output
// directory, and — the part a status code alone would not show — not one call to
// any CLI. "Nothing was mutated" is the claim; the empty invocation log is the
// evidence.
//
// The last row is the control that keeps this suite honest: `--unattended
// --contract-mode require` states the SAME mode the flag implies and is
// accepted. Without it, a runner that refused `--unattended` outright would pass
// every other row.
function unattendedInputTest() {
  log('  unattended input (#122)');
  const planPath = unattendedPlan('cmate-unattended-plan-');
  if (!check(existsSync(planPath), 'unattended: plan.json was not generated')) return;

  const refusals = [
    ['--unattended with --auto-yes', [...UNATTENDED_ARGS, '--auto-yes'], 'cannot both hold'],
    ['--unattended with --allow-questions', [...UNATTENDED_ARGS, '--allow-questions'], '--allow-questions declares'],
    ['--unattended with --contract-mode off', [...UNATTENDED_ARGS, '--contract-mode', 'off'], 'implies --contract-mode require'],
    ['--unattended with an explicit --contract-mode auto', [...UNATTENDED_ARGS, '--contract-mode', 'auto'], 'implies --contract-mode require'],
    ['--unattended with no --wall-clock-budget', ['--expect-branch', 'feature/integration', '--unattended'], 'requires --wall-clock-budget'],
  ];
  for (const [label, args, needle] of refusals) {
    const work = mkdtempSync(join(tmpdir(), 'cmate-unattended-'));
    const outDir = join(work, 'dispatch');
    const logPath = join(work, 'cli.log');
    const result = runDispatchRunner(planPath, UNATTENDED_SCENARIO, work, outDir, args, logPath);
    const report = launcherReport(result);
    const detail = (report?.blocking_reasons ?? []).map((entry) => `${entry.code} ${entry.detail}`).join(' ');
    check(result.exit === 3, `${label}: expected exit 3, got ${result.exit}: ${result.stdout.slice(0, 200)}`);
    check(detail.includes('invalid_input'), `${label}: expected an invalid_input error, got: ${detail.slice(0, 200)}`);
    check(detail.includes(needle), `${label}: the error should say "${needle}", got: ${detail.slice(0, 300)}`);
    check(!existsSync(outDir), `${label}: a refused invocation created ${outDir}`);
    check(readCliLog(logPath).length === 0, `${label}: a refused invocation called the CLI ${readCliLog(logPath).length} time(s)`);
  }

  // The control: stating the implied mode explicitly is agreement, not conflict.
  const work = mkdtempSync(join(tmpdir(), 'cmate-unattended-ok-'));
  const accepted = runDispatchRunner(
    planPath, UNATTENDED_SCENARIO, work, join(work, 'dispatch'), [...UNATTENDED_ARGS, '--contract-mode', 'require'], null,
  );
  check(accepted.exit === 0,
    `--unattended --contract-mode require should dispatch (it states the implied mode), exited ${accepted.exit}: ${accepted.stdout.slice(0, 300)}`);

  // Stage C reaches every runner (ADR §8; Issue #142), so the row that used to
  // assert "uat.mjs refuses --unattended outright" now asserts the three things
  // that flag IMPLIES there. All are refusals of an under-specified invocation,
  // not of the flag: `--unattended` without the semantic gate is a baseline
  // re-run calling itself an acceptance run, without an explicit
  // `--max-attempts` it is a bound nobody chose, and without `--expect-branch`
  // the cwd pre-flight has nothing to compare HEAD against.
  //
  // The third row is a `fix_uat` invocation because that is the only phase the
  // requirement applies to (`--write-uat` is read-only and re-merges nothing).
  // It is pinned as its own row rather than left to the pre-flight: with the
  // refusal removed the run still stops, but on `preflight_failed` naming
  // `--expect-branch names null` instead of saying which flag is missing —
  // safe, and unactionable. Mutation-measured: without this row, deleting the
  // refusal keeps the whole suite green.
  for (const [label, phase, args, needle] of [
    ['uat --unattended with no --require-acceptance', '--write-uat', ['--unattended'], 'requires --require-acceptance'],
    ['uat --unattended with no --max-attempts', '--write-uat', ['--unattended', '--acceptance-dir', work, '--require-acceptance'], 'requires --max-attempts'],
    ['uat --unattended --create-uat-fix-worktrees with no --expect-branch', '--create-uat-fix-worktrees',
      ['--unattended', '--acceptance-dir', work, '--require-acceptance', '--max-attempts', '1'], 'requires --expect-branch'],
  ]) {
    const refused = runUatRunner(planPath, '/dev/null', join(work, 'uat'), phase, args, baseEnv(), work);
    check(refused.exit === 3, `${label}: expected exit 3, got ${refused.exit}`);
    let doc = null;
    try { doc = JSON.parse(refused.stdout); } catch { /* a refused invocation still prints a failure envelope */ }
    const detail = (doc?.blocking_reasons ?? []).map((entry) => `${entry.code} ${entry.detail}`).join(' ');
    check(detail.includes('invalid_input'), `${label}: expected an invalid_input error, got: ${detail.slice(0, 200)}`);
    check(detail.includes(needle), `${label}: the error should say "${needle}", got: ${detail.slice(0, 300)}`);
  }
}

// The auto-yes arming table (Issue #136).
//
// `--auto-yes` names two things that are not the same thing: the contract's
// `autoYes.mode`, which is a POLICY the server only ever reads from inside its
// Auto-Yes poller, and the worktree's auto-yes STATE, which is what decides
// whether that poller starts at all (`if (!autoYesState?.enabled) return {
// started: false, reason: 'auto-yes not enabled' }`, ADR §14.6). d57/d58 pin the
// presence/absence pair; what no single case can pin is the DURATION, because the
// window is a function of the run's own `--max-turns × --wait-timeout` and every
// row below is therefore a different run.
//
// The rows ARE the arbitration, written as measurements: the smallest of the
// CLI's three windows (1h/3h/8h — DURATION_MAP accepts nothing else, and an
// unlisted value aborts the send before it happens) that covers the per-worker
// supervision ceiling, compared STRICTLY, so a need that reaches a window's exact
// length takes the next one up. The last row is the only one that cannot be
// covered at all, and it must say so in the report rather than silently arm 8h
// for a 15-hour run.
//
// Each row also re-reads the contract this same run wrote: the division of labour
// only holds if BOTH halves are there, and a change that moved the arming into
// the contract (or dropped the policy line now that the flag rides on the send)
// would still pass an assertion that looked at one of them.
function autoYesWindowTest() {
  log('  auto-yes arming and window (#136)');
  const planPath = unattendedPlan('cmate-auto-yes-plan-');
  if (!check(existsSync(planPath), 'auto-yes: plan.json was not generated')) return;
  const scenario = {
    cli_available: true,
    cli_contract: true,
    git: { branch: 'feature/integration', dirty: false },
    gh: { repo_access: true },
    workers: {
      201: { state: 'completed', verify_exits: [0] },
      200: { state: 'completed', verify_exits: [0] },
    },
  };

  const rows = [
    { label: 'the defaults (8 × 300 s = 40 min)', args: ['--auto-yes'], duration: '1h', capped: false },
    { label: 'a need that REACHES 1h (8 × 450 s) takes the next window', args: ['--auto-yes', '--wait-timeout', '450'], duration: '3h', capped: false },
    { label: '8 × 600 s = 80 min', args: ['--auto-yes', '--wait-timeout', '600'], duration: '3h', capped: false },
    { label: 'the run reported in #136 (10 × 2700 s = 7 h 30 min)', args: ['--auto-yes', '--wait-timeout', '2700', '--max-turns', '10'], duration: '8h', capped: false },
    { label: 'past the longest window (20 × 2700 s = 15 h)', args: ['--auto-yes', '--wait-timeout', '2700', '--max-turns', '20'], duration: '8h', capped: true },
  ];

  for (const row of rows) {
    const work = mkdtempSync(join(tmpdir(), 'cmate-auto-yes-'));
    const outDir = join(work, 'dispatch');
    const logPath = join(work, 'cli.log');
    const result = runDispatchRunner(planPath, scenario, work, outDir, row.args, logPath);
    if (!check(result.exit === 0, `${row.label}: dispatch exited ${result.exit}: ${result.stdout.slice(0, 300)}`)) continue;
    const cliLog = readCliLog(logPath);
    for (const number of [201, 200]) {
      const sends = sendsTo(cliLog, number);
      if (!check(sends.length > 0, `${row.label}: #${number} was never sent`)) continue;
      check(containsSequence(sends[0].args, ['--auto-yes', '--duration', row.duration]),
        `${row.label}: #${number} was dispatched with ${JSON.stringify(sends[0].args)}, expected --auto-yes --duration ${row.duration}`);
    }
    const report = launcherReport(result);
    const short = (report?.limitations ?? []).some((entry) => entry.code === 'auto_yes_window_short');
    check(short === row.capped,
      `${row.label}: auto_yes_window_short was ${short ? 'recorded' : 'not recorded'}, expected ${row.capped ? 'recorded' : 'not recorded'}`);
    const contractPath = join(outDir, 'contracts', 'issue-201.yaml');
    if (check(existsSync(contractPath), `${row.label}: no contract was written for #201`)) {
      const contract = readFileSync(contractPath, 'utf8');
      check(/^ {2}mode: "allow-listed"$/m.test(contract),
        `${row.label}: the contract stopped declaring autoYes.mode "allow-listed" — the send arms the state, the contract still states the policy`);
      check(/^ {4}- "multiple_choice"$/m.test(contract),
        `${row.label}: the contract does not authorise multiple_choice, the type Claude's permission menu raises`);
    }
  }

  // The control, and the other half of the two-point measurement d58 makes on the
  // argv: without the flag, the contract must go on PROHIBITING auto-yes. A run
  // that armed nothing and also declared nothing would pass every "no --auto-yes
  // on the send" assertion while quietly dropping the prohibition.
  const plainWork = mkdtempSync(join(tmpdir(), 'cmate-auto-yes-off-'));
  const plainOut = join(plainWork, 'dispatch');
  const plainLog = join(plainWork, 'cli.log');
  const plain = runDispatchRunner(planPath, scenario, plainWork, plainOut, [], plainLog);
  check(plain.exit === 0, `without --auto-yes: dispatch exited ${plain.exit}: ${plain.stdout.slice(0, 300)}`);
  const plainSends = readCliLog(plainLog).filter((entry) => entry.sub === 'send');
  const armed = plainSends.filter((entry) => entry.args.includes('--auto-yes') || entry.args.includes('--duration'));
  check(armed.length === 0, `without --auto-yes: ${armed.length} send(s) armed it anyway: ${JSON.stringify(armed[0]?.args ?? [])}`);
  const plainContract = join(plainOut, 'contracts', 'issue-201.yaml');
  if (check(existsSync(plainContract), 'without --auto-yes: no contract was written for #201')) {
    check(/^ {2}mode: "off"$/m.test(readFileSync(plainContract, 'utf8')),
      'without --auto-yes: the contract must still declare autoYes.mode "off" — an active prohibition, not an omission');
  }
}

// The exclusivity lock (ADR §14.1 candidate A). Issue #115 reproduced two runs
// driving one worktree by starting them 700 ms apart; reproducing that timing in
// a fixture would be a flaky test of a sleep. What is asserted instead is the
// STATE that race produces — a lock directory whose owner is alive — plus the
// two reclamation rules, which is what the timing test could not have pinned:
//
//   1. a live owner on this host        -> refused, nothing probed, no --out;
//   2. an owner that was killed (`kill -9` leaves no release) -> reclaimed;
//   3. an owner on another host         -> refused (this process cannot judge the
//      liveness of a pid on a machine it is not on);
//   4. a run that finishes              -> releases every lock it took.
function unattendedLockTest() {
  log('  unattended exclusivity lock (#122)');
  const planPath = unattendedPlan('cmate-unattended-lock-plan-');
  if (!check(existsSync(planPath), 'unattended lock: plan.json was not generated')) return;
  const plan = readPlan(planPath);

  // The key the runner derives, mirrored here from (repository, branch) — the
  // same pair CommandMate derives a worktree id from, which is what makes the
  // granularity "one lock per worktree" rather than "one per plan".
  const keyFor = (number) => worktreeIdFor(plan.profile.repository, plan.issues.find((issue) => issue.number === number).branch);

  const seedLock = (lockRoot, number, owner) => {
    const dir = join(lockRoot, keyFor(number));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    return dir;
  };

  // A pid that is certainly gone: a process this suite started and waited for.
  const deadPid = spawnSync('node', ['-e', 'process.exit(0)']).pid;

  // --- 1. a live owner refuses the second run -------------------------------
  {
    const lockRoot = mkdtempSync(join(tmpdir(), 'cmate-unattended-locks-'));
    seedLock(lockRoot, 201, { host: hostname(), pid: process.pid, plan_run_id: 'other-run', stage: 'A' });
    const work = mkdtempSync(join(tmpdir(), 'cmate-unattended-held-'));
    const outDir = join(work, 'dispatch');
    const logPath = join(work, 'cli.log');
    const result = runDispatchRunner(planPath, UNATTENDED_SCENARIO, work, outDir, UNATTENDED_ARGS, logPath, {
      env: { CMATE_ORCHESTRATE_LOCK_DIR: lockRoot },
    });
    const report = launcherReport(result);
    check(result.exit === 1, `a held worktree lock should refuse the second run with exit 1, exited ${result.exit}`);
    check(report?.status === 'failure', `a refused run should report failure, got ${report?.status}`);
    check(report?.stop_reason === 'dispatch_error', `a refused run should stop with dispatch_error, got ${report?.stop_reason}`);
    check((report?.blocking_reasons ?? []).some((entry) => entry.code === 'unattended_locked'),
      `the refusal should name unattended_locked, got ${JSON.stringify(report?.blocking_reasons)}`);
    check((report?.blocking_reasons ?? []).some((entry) => entry.detail.includes('is still running')),
      'the refusal should say the owning run is still running');
    // Nothing was probed, nothing was prepared, nothing was sent — the stop is
    // BEFORE the pre-flight, which is the window Issue #115 measured.
    check(report?.out_dir === null, `a refused run must not consume --out, got ${JSON.stringify(report?.out_dir)}`);
    check(!existsSync(outDir), 'a refused run created the output directory');
    check(readCliLog(logPath).length === 0, `a refused run called the CLI ${readCliLog(logPath).length} time(s)`);
    // The lock it did not take is still the FIRST run's, untouched.
    check(existsSync(join(lockRoot, keyFor(201), 'owner.json')), 'the refused run removed the lock it did not own');
    // All-or-nothing: the lock it DID take for the other issue is given back, so
    // a partially-locked run leaves nothing behind for the next one to trip on.
    check(!existsSync(join(lockRoot, keyFor(200))), 'the refused run kept a lock it took before hitting the held one');
  }

  // --- 2. a killed owner's lock is reclaimed, and a finished run releases ----
  {
    const lockRoot = mkdtempSync(join(tmpdir(), 'cmate-unattended-locks-'));
    seedLock(lockRoot, 201, { host: hostname(), pid: deadPid, plan_run_id: 'killed-run', stage: 'A' });
    const work = mkdtempSync(join(tmpdir(), 'cmate-unattended-stale-'));
    const result = runDispatchRunner(planPath, UNATTENDED_SCENARIO, work, join(work, 'dispatch'), UNATTENDED_ARGS, null, {
      env: { CMATE_ORCHESTRATE_LOCK_DIR: lockRoot },
    });
    const report = launcherReport(result);
    check(result.exit === 0, `a stale lock should be reclaimed and the run should dispatch, exited ${result.exit}: ${result.stdout.slice(0, 300)}`);
    check(report?.status === 'success', `the reclaiming run should succeed, got ${report?.status}`);
    check(!existsSync(join(lockRoot, keyFor(201))) && !existsSync(join(lockRoot, keyFor(200))),
      'a finished run left its worktree locks behind');
  }

  // --- 3. an owner on another host is refused, not reclaimed ----------------
  {
    const lockRoot = mkdtempSync(join(tmpdir(), 'cmate-unattended-locks-'));
    // Dead pid AND a foreign host: the pid alone would be reclaimable, so this
    // isolates the host rule rather than measuring the same thing twice.
    seedLock(lockRoot, 201, { host: `${hostname()}-somewhere-else`, pid: deadPid, plan_run_id: 'other-host', stage: 'A' });
    const work = mkdtempSync(join(tmpdir(), 'cmate-unattended-foreign-'));
    const result = runDispatchRunner(planPath, UNATTENDED_SCENARIO, work, join(work, 'dispatch'), UNATTENDED_ARGS, null, {
      env: { CMATE_ORCHESTRATE_LOCK_DIR: lockRoot },
    });
    const report = launcherReport(result);
    check(result.exit === 1, `a lock owned by another host should refuse the run, exited ${result.exit}`);
    check((report?.blocking_reasons ?? []).some((entry) => entry.detail.includes('another host')),
      `the refusal should say the lock belongs to another host, got ${JSON.stringify(report?.blocking_reasons)}`);
  }

  // --- 4. a run WITHOUT --unattended takes no lock at all --------------------
  // The non-regression half: the lock is part of the unattended contract, so a
  // run without the flag must be byte-for-byte what it was before this existed —
  // including creating no lock directory and being refused by none.
  {
    const lockRoot = mkdtempSync(join(tmpdir(), 'cmate-unattended-locks-'));
    seedLock(lockRoot, 201, { host: hostname(), pid: process.pid, plan_run_id: 'other-run', stage: 'A' });
    const work = mkdtempSync(join(tmpdir(), 'cmate-attended-'));
    const result = runDispatchRunner(planPath, UNATTENDED_SCENARIO, work, join(work, 'dispatch'), ['--expect-branch', 'feature/integration'], null, {
      env: { CMATE_ORCHESTRATE_LOCK_DIR: lockRoot },
    });
    check(result.exit === 0, `a run without --unattended must ignore the lock entirely, exited ${result.exit}`);
    check(readdirSync(lockRoot).length === 1, 'a run without --unattended created or removed a lock');
  }

  // --- 5. a --reverify run takes the lock too (Issue #121) -------------------
  // Adjudicated in dispatch-contract.md §8.5.6. The flag sends nothing, so no
  // second SUPERVISOR appears — but `commandmate verify` RUNS THE REPOSITORY'S
  // GATES INSIDE THE WORKTREE, and the verdict it produces is written into the
  // report merge reads as eligibility. Judging a tree another run's worker is
  // still writing to yields a verdict about a state nobody delivered, and then
  // delivers it. Pinned here so "it only reads, so it needs no lock" cannot come
  // back as an optimisation.
  {
    // #201 times out, so the reverify has one not-carried issue — and therefore
    // exactly one lock to take. #200 is carried: its worktree is never touched,
    // so no lock is taken for it, exactly as on a resume.
    const scenario = {
      ...UNATTENDED_SCENARIO,
      workers: { 200: { state: 'completed', verify_exits: [0] }, 201: { state: 'timeout' } },
    };
    const work = mkdtempSync(join(tmpdir(), 'cmate-reverify-lock-'));
    const outDir = join(work, 'dispatch');
    const first = runDispatchRunner(planPath, scenario, work, outDir, UNATTENDED_ARGS, null, {
      env: { CMATE_ORCHESTRATE_LOCK_DIR: mkdtempSync(join(tmpdir(), 'cmate-unattended-locks-')) },
      state: join(work, 'state-1'),
    });
    check(first.exit === 7, `the seeding dispatch should stop partial (#201 timed out), exited ${first.exit}: ${first.stdout.slice(0, 200)}`);

    const lockRoot = mkdtempSync(join(tmpdir(), 'cmate-unattended-locks-'));
    seedLock(lockRoot, 201, { host: hostname(), pid: process.pid, plan_run_id: 'other-run', stage: 'A' });
    const logPath = join(work, 'reverify.log');
    const result = runDispatchRunner(planPath, scenario, work, outDir, UNATTENDED_ARGS, logPath, {
      reverifyDir: outDir,
      env: { CMATE_ORCHESTRATE_LOCK_DIR: lockRoot },
      state: join(work, 'state-2'),
    });
    const report = launcherReport(result);
    check(result.exit === 1, `--unattended --reverify should be refused by a held worktree lock, exited ${result.exit}: ${result.stdout.slice(0, 300)}`);
    check((report?.blocking_reasons ?? []).some((entry) => entry.code === 'unattended_locked'),
      `the refusal should name unattended_locked, got ${JSON.stringify(report?.blocking_reasons)}`);
    // Refused BEFORE anything: no gate was run in anybody's worktree, and the
    // attempt directory the reverify would have appended was not created.
    check(readCliLog(logPath).length === 0, `a refused reverify called the CLI ${readCliLog(logPath).length} time(s)`);
    check(!existsSync(join(outDir, 'resume-attempt-2')), 'a refused reverify created its attempt directory');
    check(!existsSync(join(lockRoot, keyFor(200))), 'the reverify took a lock for an issue it carries over and never touches');
    // The report still says what the attempt WAS, and that it re-judges rather
    // than re-dispatches — a refusal must not read as a resume.
    check((report?.limitations ?? []).some((entry) => entry.code === 'reverify_attempt'),
      `a refused reverify should still record reverify_attempt, got ${JSON.stringify((report?.limitations ?? []).map((entry) => entry.code))}`);
  }
}

// Stage B: `merge.mjs --create-prs --unattended` (Issue #134 / ADR §6.5, §8).
//
// Written as one suite rather than as merge-cases because the load-bearing
// assertion is a COMPARISON of two runs over the same world: "the unattended run
// differs from its flagless twin only by the unattended limitation" is the
// machine-checkable form of "the flag relaxes nothing", and it is strictly
// stronger than a self-reported boolean (a runner that DID relax something can
// still write `relaxed: false`). Two independent cases could not compare their
// reports, so the twin runs and the two-point evidence measurement live here.
function unattendedMergeTest() {
  log('  unattended merge --create-prs (#134)');
  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-unattended-merge-plan-'));
  const spec = { plan: { issues_fixture: 'cases/02-explicit-dependency/issues.json', orchestrate_args: ['200', '201', '--max-parallel', '3', '--run-id', 'plan'] } };
  const planPath = generatePlan(spec, runsDir);
  if (!check(existsSync(planPath), 'unattended merge: plan.json was not generated')) return;

  const work = mkdtempSync(join(tmpdir(), 'cmate-unattended-merge-'));
  const dispatchPath = generateDispatchReport(planPath, DEFAULT_DISPATCH_SCENARIO, work);
  if (!check(existsSync(dispatchPath), 'unattended merge: dispatch-report.json was not generated')) return;
  const plan = readPlan(planPath);
  const integration = join(work, 'integration');

  // One merge invocation against the fake gh/git, in the same world every time.
  // `diff` overrides what an issue's worktree answers to `git diff`: `"fail"` is
  // the #97 degradation path this stage promotes to blocking, and a `files` list
  // is what the branch actually touched.
  let runIndex = 0;
  const mergePhase = (phaseFlag, args, diff = {}) => {
    runIndex += 1;
    const label = `run-${runIndex}`;
    const outDir = join(work, `merge-${label}`);
    const logPath = join(work, `${label}.log`);
    const scenarioPath = writeScenario(work, `scenario-${label}.json`, withDiffDefaults({
      cli_available: true,
      gh: { repo_access: true },
      git: { base_resolvable: true },
      prs: { 200: { create: 'ok' }, 201: { create: 'ok' } },
      diff,
    }, plan));
    const env = { ...baseEnv(), CMATE_FAKE_SCENARIO: scenarioPath, CMATE_FAKE_LOG: logPath };
    const { exit, stdout } = runMerge(planPath, dispatchPath, outDir, phaseFlag, args, env, integration);
    let report = null;
    try { report = JSON.parse(stdout); } catch { /* a refused invocation still prints a failure envelope */ }
    return { exit, report, outDir, log: readCliLog(logPath) };
  };

  const codesOf = (entries) => (entries ?? []).map((entry) => entry.code);
  // Everything about a target that the flag must not move. `note` is included on
  // purpose: an identical outcome reached by a different path would show up here.
  const targetShape = (report) => (report?.targets ?? []).map((target) => ({
    issue: target.issue, branch: target.branch, outcome: target.outcome, pushed: target.pushed,
    pr_created: target.pr_created, pr_number: target.pr_number, pr_url: target.pr_url, note: target.note,
  }));
  // The branches a run actually opened a PR for, read from the fake's invocation
  // log rather than from the report the runner wrote about itself.
  const createdHeads = (log) => log
    .filter((entry) => entry.sub === 'pr' && entry.args[0] === 'create')
    .map((entry) => entry.args[entry.args.indexOf('--head') + 1])
    .sort();

  // --- 1. the twin: --approve --unattended vs --approve ----------------------
  // #200's branch reached one file outside its declared scope, so BOTH runs carry
  // a real limitation. That is deliberate: ADR §6.5 rules that
  // `branch_changed_outside_declared_scope` is NOT promoted (the contract gate
  // `requireScopeClean` already judged it upstream, and unattended dispatch makes
  // the contract path mandatory), and a twin whose only limitation list is empty
  // could not tell a preserved limitation from an absent one.
  const filesOf = (number) => [...(plan.issues.find((issue) => issue.number === number).suspected_files ?? [])];
  const OUT_OF_SCOPE = { 200: { files: [...filesOf(200), 'docs/unplanned.md'] } };
  {
    const plain = mergePhase('--create-prs', ['--approve'], OUT_OF_SCOPE);
    const unattended = mergePhase('--create-prs', ['--approve', '--unattended'], OUT_OF_SCOPE);

    check(plain.exit === 0 && unattended.exit === 0,
      `both twins should exit 0, got plain=${plain.exit} unattended=${unattended.exit}`);
    check(validateAgainst(mergeSchema, unattended.report, 'merge').length === 0,
      `the unattended report is not schema-valid: ${validateAgainst(mergeSchema, unattended.report, 'merge').slice(0, 3).join('; ')}`);
    check(unattended.report?.merge_schema_version === 1,
      `stage B must not bump merge_schema_version, got ${unattended.report?.merge_schema_version}`);
    check(unattended.report?.status === plain.report?.status && unattended.report?.status === 'success',
      `status differs between the twins: ${plain.report?.status} vs ${unattended.report?.status}`);
    check(unattended.report?.stop_reason === plain.report?.stop_reason && unattended.report?.stop_reason === 'completed',
      `stop_reason differs between the twins: ${plain.report?.stop_reason} vs ${unattended.report?.stop_reason}`);
    check(deepEqual(unattended.report?.eligible_issues, plain.report?.eligible_issues),
      'the eligible set differs between the twins');
    check(deepEqual(targetShape(unattended.report), targetShape(plain.report)),
      `the targets differ between the twins: ${JSON.stringify(targetShape(unattended.report))} vs ${JSON.stringify(targetShape(plain.report))}`);
    // The PRs that were actually opened, not the report's account of them.
    check(createdHeads(plain.log).length === 2, `the flagless twin should have opened 2 PRs, opened ${createdHeads(plain.log).length}`);
    check(deepEqual(createdHeads(unattended.log), createdHeads(plain.log)),
      `the PRs created differ between the twins: ${JSON.stringify(createdHeads(unattended.log))} vs ${JSON.stringify(createdHeads(plain.log))}`);
    check(deepEqual(unattended.report?.blocking_reasons, plain.report?.blocking_reasons),
      'the unattended twin recorded a different blocking reason');
    check(deepEqual(unattended.report?.completion_check, plain.report?.completion_check),
      'the unattended twin recorded a different completion_check');

    // The ONLY permitted difference: one `unattended_mode` limitation.
    const extra = (unattended.report?.limitations ?? []).filter((entry) => entry.code !== 'unattended_mode');
    check(codesOf(plain.report?.limitations).includes('branch_changed_outside_declared_scope'),
      `the twin world should produce a scope limitation to compare, got ${JSON.stringify(codesOf(plain.report?.limitations))}`);
    check(codesOf(extra).includes('branch_changed_outside_declared_scope'),
      'branch_changed_outside_declared_scope must stay a limitation under --unattended (ADR §6.5): it is the human-readable copy of a machine gate that already ruled');
    check(codesOf(unattended.report?.limitations).filter((code) => code === 'unattended_mode').length === 1,
      `the unattended run should record exactly one unattended_mode limitation, got ${JSON.stringify(codesOf(unattended.report?.limitations))}`);
    check(deepEqual(extra, plain.report?.limitations ?? []),
      `the twins differ by more than the unattended record: ${JSON.stringify(extra)} vs ${JSON.stringify(plain.report?.limitations)}`);
    // The declaration must not itself redact anything: a tallied redaction the
    // flagless run does not have would break the "only difference" property.
    check(deepEqual(unattended.report?.redactions, plain.report?.redactions),
      `the unattended record changed the redaction tally: ${JSON.stringify(unattended.report?.redactions)} vs ${JSON.stringify(plain.report?.redactions)}`);
    // It does not imply approval either way round: approved still means approved.
    check(unattended.report?.approved === true && unattended.report?.mutated === true,
      'the approved unattended twin should report approved and mutated');
  }

  // --- 2. --unattended alone opens nothing (it does not imply --approve) -----
  // ADR "裁定 0": the flag declares that nobody is watching, not that the runner
  // may act. A CI that wants PRs writes BOTH flags.
  {
    const preview = mergePhase('--create-prs', ['--unattended']);
    check(preview.exit === 0, `--create-prs --unattended should be a preview (exit 0), exited ${preview.exit}`);
    check(preview.report?.status === 'success', `an unattended preview should succeed, got ${preview.report?.status}`);
    check(preview.report?.approved === false, `--unattended must not imply --approve, got approved=${preview.report?.approved}`);
    check(preview.report?.mutated === false, `an unattended preview must not mutate, got mutated=${preview.report?.mutated}`);
    check(countCalls(preview.log, 'push') === 0 && countCalls(preview.log, 'pr', 'create') === 0,
      `--unattended alone pushed or created something (push=${countCalls(preview.log, 'push')}, create=${countCalls(preview.log, 'pr', 'create')})`);
    check((preview.report?.targets ?? []).every((target) => target.outcome === 'previewed'),
      `every target of an unattended preview should be previewed, got ${JSON.stringify((preview.report?.targets ?? []).map((t) => t.outcome))}`);
    check(codesOf(preview.report?.limitations).includes('unattended_mode'),
      'an unattended preview should still record what it declared');
  }

  // --- 3. change_evidence_unavailable: the two-point measurement -------------
  // The same world (#201's worktree cannot answer `git diff`) read twice. With a
  // human present it is a limitation and the run continues; with nobody present
  // it is blocking and no PR is opened at all. Measuring only the promoted side
  // would not show that the promotion is what did it.
  {
    const attended = mergePhase('--create-prs', ['--approve'], { 201: 'fail' });
    check(attended.exit === 0, `without --unattended an unreadable diff should not stop the phase, exited ${attended.exit}`);
    check(attended.report?.status === 'success', `the attended run should still succeed, got ${attended.report?.status}`);
    check(codesOf(attended.report?.limitations).includes('change_evidence_unavailable'),
      `the attended run should record change_evidence_unavailable as a limitation, got ${JSON.stringify(codesOf(attended.report?.limitations))}`);
    check(codesOf(attended.report?.blocking_reasons).length === 0,
      `the attended run should record no blocking reason, got ${JSON.stringify(codesOf(attended.report?.blocking_reasons))}`);
    check(createdHeads(attended.log).length === 2, `the attended run should still open both PRs, opened ${createdHeads(attended.log).length}`);

    const unattended = mergePhase('--create-prs', ['--approve', '--unattended'], { 201: 'fail' });
    check(unattended.exit === 7, `an unreadable diff should stop an unattended run as partial (exit 7), exited ${unattended.exit}`);
    check(unattended.report?.status === 'partial', `the unattended run should be partial, got ${unattended.report?.status}`);
    // The existing vocabulary receives it: no value was added to the enum.
    check(unattended.report?.stop_reason === 'pr_create_failed',
      `the stop should reuse pr_create_failed, got ${unattended.report?.stop_reason}`);
    check(codesOf(unattended.report?.blocking_reasons).includes('change_evidence_unavailable'),
      `the unattended run should name change_evidence_unavailable as blocking, got ${JSON.stringify(codesOf(unattended.report?.blocking_reasons))}`);
    check(!codesOf(unattended.report?.limitations).includes('change_evidence_unavailable'),
      'the promoted finding should be blocking, not blocking AND a limitation');
    // Stage C must not promote this a SECOND time (Issue #142; ADR §6.5's
    // correction note — the stage table put it in stage B and #134 shipped it).
    // A second promotion would show up here as two reasons for one finding.
    check(codesOf(unattended.report?.blocking_reasons).filter((code) => code === 'change_evidence_unavailable').length === 1,
      `change_evidence_unavailable should be promoted exactly once, got ${JSON.stringify(codesOf(unattended.report?.blocking_reasons))}`);
    // No PR, and not even a push: the stop is before the first mutation.
    check(countCalls(unattended.log, 'pr', 'create') === 0 && countCalls(unattended.log, 'push') === 0,
      `a blocked unattended run pushed or created something (push=${countCalls(unattended.log, 'push')}, create=${countCalls(unattended.log, 'pr', 'create')})`);
    check(unattended.report?.mutated === false, `a blocked unattended run must not report mutated, got ${unattended.report?.mutated}`);
    const blocked = (unattended.report?.targets ?? []).find((target) => target.issue === 201);
    check(blocked?.outcome === 'pr_failed', `#201 should be recorded as pr_failed, got ${blocked?.outcome}`);
    const notReached = (unattended.report?.targets ?? []).find((target) => target.issue === 200);
    check(notReached?.outcome === 'skipped', `#200 should be left skipped, got ${notReached?.outcome}`);
    // And no body was written for a PR that was refused.
    check(!existsSync(join(unattended.outDir, 'pr-bodies', 'issue-201.md')),
      'a refused PR still had its body written');
  }

  // --- 4. --merge-prs --unattended is ACCEPTED now (stage C, Issue #142) ------
  // The stage-B refusal was not deleted, it was replaced by the stage it named.
  // What it refuses instead is the ISSUE it cannot merge unattended (§9), which
  // this plan's issues all are — so the phase stops, and the stop is a stop
  // rather than an `invalid_input` about the flag.
  {
    const stageC = mergePhase('--merge-prs', ['--approve', '--unattended']);
    check(stageC.exit === 1, `--merge-prs --unattended should be accepted and stop on its issues (exit 1), exited ${stageC.exit}`);
    check(!codesOf(stageC.report?.blocking_reasons).includes('invalid_input'),
      `the flag itself must no longer be refused, got ${JSON.stringify(codesOf(stageC.report?.blocking_reasons))}`);
    check(stageC.report?.stop_reason === 'preflight_failed',
      `the stage-C stop should reuse preflight_failed, got ${stageC.report?.stop_reason}`);
    check(codesOf(stageC.report?.blocking_reasons).includes('acceptance_gates_required'),
      `the stop should name acceptance_gates_required, got ${JSON.stringify(codesOf(stageC.report?.blocking_reasons))}`);
    check(countCalls(stageC.log, 'pr', 'merge') === 0, `an accepted-but-stopped run merged ${countCalls(stageC.log, 'pr', 'merge')} PR(s)`);
  }

  // --- 5. the relaxing flags of the dispatch runner are refused here too -----
  // merge.mjs has no such option, so the refusal comes from parseArgs — the same
  // exit 3 with the same meaning. Pinned so a later stage cannot start accepting
  // one of them (and quietly relaxing something) without a fixture saying so.
  {
    for (const relaxing of [['--auto-yes'], ['--allow-questions'], ['--contract-mode', 'off']]) {
      const refused = mergePhase('--create-prs', ['--approve', '--unattended', ...relaxing]);
      check(refused.exit === 3, `--unattended with ${relaxing[0]} should be refused with exit 3, exited ${refused.exit}`);
      check(codesOf(refused.report?.blocking_reasons).includes('invalid_input'),
        `${relaxing[0]}: the refusal should be invalid_input, got ${JSON.stringify(codesOf(refused.report?.blocking_reasons))}`);
      check(!existsSync(refused.outDir), `${relaxing[0]}: a refused invocation created its output directory`);
      check(refused.log.length === 0, `${relaxing[0]}: a refused invocation called the CLI ${refused.log.length} time(s)`);
    }
  }
}

// =============================================================================
// Stage C (Issue #142 / ADR §6.5, §8, §9, §14.3)
// =============================================================================
//
// Stage C is the first stage whose furthest reach is not a PR. Everything below
// is written as a COMPARISON or as a count taken from the fake CLI's invocation
// log rather than from the report the runner wrote about itself: "no fix
// worktree was created" is a claim about the world, and the empty `worktree add`
// log is the evidence for it.

// The one file BOTH judges read, declaring the gate id the stage-C issue fixture
// requires. Without it dispatch refuses the issue before `send`
// (`acceptance_gate_id_unknown`), so the plan would never reach merge/uat.
const STAGE_C_VERIFY_YAML = 'version: 1\ngates:\n  - id: uat-smoke\n    command: "true"\n    timeoutSec: 60\n';
const STAGE_C_ISSUES = 'dispatch-cases/issues-unattended-stage-c.json';

// plan -> dispatch report over a contract-capable world, for a chosen subset of
// the stage-C issue fixture. `--allow-questions` is needed only for the subset
// that includes the issue with no acceptance criteria (the planner raises a
// question for it, and dispatch would otherwise refuse the whole plan). Passing
// it to DISPATCH is legitimate here and is the point of ADR §8's "unattended is
// not propagated between runners": this dispatch had a human, the merge does not.
function stageCWorld(prefix, issues, { allowQuestions = false } = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), `${prefix}-plan-`));
  const spec = {
    plan: {
      issues_fixture: STAGE_C_ISSUES,
      orchestrate_args: [...issues.map(String), '--max-parallel', '3', '--run-id', 'plan'],
    },
  };
  const planPath = generatePlan(spec, runsDir);
  if (!existsSync(planPath)) return null;
  const work = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const scenario = {
    cli_available: true,
    cli_contract: true,
    git: { branch: 'feature/integration', dirty: false },
    gh: { repo_access: true },
    workers: Object.fromEntries(issues.map((n) => [n, { state: 'completed', verify: 'pass' }])),
    worktree_files: { '.commandmate/verify.yaml': STAGE_C_VERIFY_YAML },
  };
  const dispatchOut = join(work, 'dispatch');
  runDispatchRunner(planPath, scenario, work, dispatchOut, [
    '--expect-branch', 'feature/integration',
    ...(allowQuestions ? ['--allow-questions'] : []),
  ], null);
  const dispatchPath = join(dispatchOut, 'dispatch-report.json');
  if (!existsSync(dispatchPath)) return null;
  return { planPath, plan: readPlan(planPath), work, dispatchPath, integration: join(work, 'integration') };
}

// Stage C: `merge.mjs --merge-prs --unattended` (Issue #142 / ADR §8, §9).
function unattendedMergePrsTest() {
  log('  unattended merge --merge-prs (#142)');
  const green = stageCWorld('cmate-stagec-green', [350, 351]);
  if (!check(green !== null, 'stage C: the green plan/dispatch world was not generated')) return;

  let runIndex = 0;
  const mergePhase = (world, args, extraScenario = {}) => {
    runIndex += 1;
    const label = `run-${runIndex}`;
    const outDir = join(world.work, `merge-${label}`);
    const logPath = join(world.work, `${label}.log`);
    const prs = {};
    for (const issue of world.plan.issues) {
      prs[issue.number] = { view_state: 'OPEN', checks: [{ name: 'build', state: 'SUCCESS' }], merge: 'ok', create: 'ok' };
    }
    const scenarioPath = writeScenario(world.work, `scenario-${label}.json`, withDiffDefaults({
      cli_available: true,
      gh: { repo_access: true },
      git: { base_resolvable: true },
      prs,
      ...extraScenario,
    }, world.plan));
    const env = { ...baseEnv(), CMATE_FAKE_SCENARIO: scenarioPath, CMATE_FAKE_LOG: logPath };
    const { exit, stdout } = runMerge(world.planPath, world.dispatchPath, outDir, '--merge-prs', args, env, world.integration);
    let report = null;
    try { report = JSON.parse(stdout); } catch { /* a refused invocation still prints a failure envelope */ }
    return { exit, report, outDir, log: readCliLog(logPath) };
  };
  const codesOf = (entries) => (entries ?? []).map((entry) => entry.code);
  const targetShape = (report) => (report?.targets ?? []).map((target) => ({
    issue: target.issue, branch: target.branch, outcome: target.outcome, pr_number: target.pr_number,
    ci_passed: target.ci_passed, merge_attempted: target.merge_attempted, merged: target.merged, note: target.note,
  }));
  const mergedPrs = (log) => log
    .filter((entry) => entry.sub === 'pr' && entry.args[0] === 'merge')
    .map((entry) => entry.args[1])
    .sort();

  // --- 1. the twin: --merge-prs --approve --unattended vs --approve ----------
  // Both issues of this plan declare an acceptance-gate block AND acceptance
  // criteria, so the stage-C condition is satisfied and the unattended run must
  // reach exactly the same place as its flagless twin: same status, same stop,
  // same targets, and the same PRs really merged (read from the fake's log, not
  // from the report). The only permitted difference is the declaration itself.
  {
    const plain = mergePhase(green, ['--approve']);
    const unattended = mergePhase(green, ['--approve', '--unattended']);

    check(plain.exit === 0 && unattended.exit === 0,
      `both twins should exit 0, got plain=${plain.exit} unattended=${unattended.exit}`);
    check(validateAgainst(mergeSchema, unattended.report, 'merge').length === 0,
      `the unattended report is not schema-valid: ${validateAgainst(mergeSchema, unattended.report, 'merge').slice(0, 3).join('; ')}`);
    check(unattended.report?.merge_schema_version === 1,
      `stage C must not bump merge_schema_version, got ${unattended.report?.merge_schema_version}`);
    check(unattended.report?.status === plain.report?.status && unattended.report?.status === 'success',
      `status differs between the twins: ${plain.report?.status} vs ${unattended.report?.status}`);
    check(unattended.report?.stop_reason === plain.report?.stop_reason && unattended.report?.stop_reason === 'completed',
      `stop_reason differs between the twins: ${plain.report?.stop_reason} vs ${unattended.report?.stop_reason}`);
    check(deepEqual(unattended.report?.eligible_issues, plain.report?.eligible_issues),
      'the eligible set differs between the twins');
    check(deepEqual(targetShape(unattended.report), targetShape(plain.report)),
      `the targets differ between the twins: ${JSON.stringify(targetShape(unattended.report))} vs ${JSON.stringify(targetShape(plain.report))}`);
    check(mergedPrs(plain.log).length === 2, `the flagless twin should have merged 2 PRs, merged ${mergedPrs(plain.log).length}`);
    check(deepEqual(mergedPrs(unattended.log), mergedPrs(plain.log)),
      `the PRs merged differ between the twins: ${JSON.stringify(mergedPrs(unattended.log))} vs ${JSON.stringify(mergedPrs(plain.log))}`);
    check(deepEqual(unattended.report?.blocking_reasons, plain.report?.blocking_reasons),
      'the unattended twin recorded a different blocking reason');
    check(deepEqual(unattended.report?.completion_check, plain.report?.completion_check),
      'the unattended twin recorded a different completion_check');
    check(deepEqual(unattended.report?.redactions, plain.report?.redactions),
      `the unattended record changed the redaction tally: ${JSON.stringify(unattended.report?.redactions)} vs ${JSON.stringify(plain.report?.redactions)}`);
    // The ONLY permitted difference: one `unattended_mode` limitation.
    const extra = (unattended.report?.limitations ?? []).filter((entry) => entry.code !== 'unattended_mode');
    check(codesOf(unattended.report?.limitations).filter((code) => code === 'unattended_mode').length === 1,
      `the unattended run should record exactly one unattended_mode limitation, got ${JSON.stringify(codesOf(unattended.report?.limitations))}`);
    check(deepEqual(extra, plain.report?.limitations ?? []),
      `the twins differ by more than the unattended record: ${JSON.stringify(extra)} vs ${JSON.stringify(plain.report?.limitations)}`);
    check(unattended.report?.approved === true && unattended.report?.mutated === true,
      'the approved unattended twin should report approved and mutated');
  }

  // --- 2. --unattended alone merges nothing (it does not imply --approve) ----
  {
    const preview = mergePhase(green, ['--unattended']);
    check(preview.exit === 0, `--merge-prs --unattended should be a preview (exit 0), exited ${preview.exit}`);
    check(preview.report?.status === 'success', `an unattended preview should succeed, got ${preview.report?.status}`);
    check(preview.report?.approved === false, `--unattended must not imply --approve, got approved=${preview.report?.approved}`);
    check(preview.report?.mutated === false, `an unattended preview must not mutate, got mutated=${preview.report?.mutated}`);
    check(mergedPrs(preview.log).length === 0, `--unattended alone merged ${mergedPrs(preview.log).length} PR(s)`);
    check((preview.report?.targets ?? []).every((target) => target.outcome === 'previewed'),
      `every target of an unattended preview should be previewed, got ${JSON.stringify((preview.report?.targets ?? []).map((t) => t.outcome))}`);
    check(codesOf(preview.report?.limitations).includes('unattended_mode'),
      'an unattended preview should still record what it declared');
  }

  // --- 3. an issue with no acceptance-gate block STOPS the phase -------------
  // ADR §9 condition 2: refuse, do not exclude. #350 qualifies and #352 does
  // not, so the load-bearing assertion is that #350 was NOT merged either — a
  // run that quietly shrank its target set would have merged it and reported
  // success. Measured twice, so the promotion is visibly what did it.
  {
    const world = stageCWorld('cmate-stagec-noblock', [350, 352]);
    if (check(world !== null, 'stage C: the no-block world was not generated')) {
      const attended = mergePhase(world, ['--approve']);
      check(attended.exit === 0, `without --unattended a block-less issue must not stop the phase, exited ${attended.exit}`);
      check(attended.report?.status === 'success', `the attended run should still succeed, got ${attended.report?.status}`);
      check(mergedPrs(attended.log).length === 2, `the attended run should merge both PRs, merged ${mergedPrs(attended.log).length}`);

      const unattended = mergePhase(world, ['--approve', '--unattended']);
      check(unattended.exit === 1, `a block-less issue should stop an unattended merge (exit 1), exited ${unattended.exit}`);
      check(unattended.report?.status === 'failure', `the unattended run should be a failure, got ${unattended.report?.status}`);
      check(unattended.report?.stop_reason === 'preflight_failed',
        `the stop should reuse preflight_failed, got ${unattended.report?.stop_reason}`);
      const named = (unattended.report?.blocking_reasons ?? []).filter((entry) => entry.code === 'acceptance_gates_required');
      check(named.length === 1, `exactly #352 should be named, got ${JSON.stringify(codesOf(unattended.report?.blocking_reasons))}`);
      check((named[0]?.detail ?? '').startsWith('#352:'), `the reason should name #352, got ${named[0]?.detail?.slice(0, 60)}`);
      // Nothing merged — INCLUDING the issue that qualifies. That is the whole
      // difference between "stop" and "exclude".
      check(mergedPrs(unattended.log).length === 0, `a stopped unattended run merged ${JSON.stringify(mergedPrs(unattended.log))}`);
      check(unattended.report?.mutated === false, `a stopped unattended run reported mutated=${unattended.report?.mutated}`);
      check(deepEqual(unattended.report?.eligible_issues, attended.report?.eligible_issues),
        'the eligible set was shrunk instead of the phase being stopped');
      check((unattended.report?.targets ?? []).length === 0,
        `a run stopped before the phase should have no targets, got ${JSON.stringify(targetShape(unattended.report))}`);
      check((unattended.report?.summary_markdown ?? '').includes('acceptance-gates'),
        'the summary should say what to write into the issue body');
    }
  }

  // --- 4. an issue with no acceptance criteria STOPS the phase too -----------
  // The other half of ADR §9 condition 2, and it reuses the planner's own code
  // (`no_acceptance_criteria`) rather than inventing a merge-side synonym.
  {
    const world = stageCWorld('cmate-stagec-nocriteria', [350, 353], { allowQuestions: true });
    if (check(world !== null, 'stage C: the no-criteria world was not generated')) {
      const attended = mergePhase(world, ['--approve']);
      check(attended.report?.status === 'success', `the attended run should still succeed, got ${attended.report?.status}`);
      check(mergedPrs(attended.log).length === 2, `the attended run should merge both PRs, merged ${mergedPrs(attended.log).length}`);

      const unattended = mergePhase(world, ['--approve', '--unattended']);
      check(unattended.exit === 1, `a criteria-less issue should stop an unattended merge (exit 1), exited ${unattended.exit}`);
      const named = (unattended.report?.blocking_reasons ?? []).filter((entry) => entry.code === 'no_acceptance_criteria');
      check(named.length === 1, `exactly #353 should be named, got ${JSON.stringify(codesOf(unattended.report?.blocking_reasons))}`);
      check((named[0]?.detail ?? '').startsWith('#353:'), `the reason should name #353, got ${named[0]?.detail?.slice(0, 60)}`);
      check(mergedPrs(unattended.log).length === 0, `a stopped unattended run merged ${JSON.stringify(mergedPrs(unattended.log))}`);
    }
  }

  // --- 5. --create-prs is NOT given the stage-C condition --------------------
  // Stage B's tightening list is one entry long, and it stays that way: the same
  // block-less world reaches a PR under `--create-prs --unattended`. Adding the
  // acceptance requirement there would change what stage B means after the fact.
  {
    const world = stageCWorld('cmate-stagec-createprs', [350, 352]);
    if (check(world !== null, 'stage C: the create-prs world was not generated')) {
      const outDir = join(world.work, 'merge-create');
      const logPath = join(world.work, 'create.log');
      const scenarioPath = writeScenario(world.work, 'scenario-create.json', withDiffDefaults({
        cli_available: true,
        gh: { repo_access: true },
        git: { base_resolvable: true },
        prs: { 350: { create: 'ok' }, 352: { create: 'ok' } },
      }, world.plan));
      const env = { ...baseEnv(), CMATE_FAKE_SCENARIO: scenarioPath, CMATE_FAKE_LOG: logPath };
      const { exit, stdout } = runMerge(world.planPath, world.dispatchPath, outDir, '--create-prs', ['--approve', '--unattended'], env, world.integration);
      let report = null;
      try { report = JSON.parse(stdout); } catch { /* ignore */ }
      check(exit === 0, `--create-prs --unattended must not inherit the stage-C condition, exited ${exit}`);
      check(report?.status === 'success', `--create-prs --unattended over a block-less plan should succeed, got ${report?.status}`);
      check(countCalls(readCliLog(logPath), 'pr', 'create') === 2,
        `--create-prs --unattended should still open both PRs, opened ${countCalls(readCliLog(logPath), 'pr', 'create')}`);
    }
  }
}

// Stage C: `uat.mjs --unattended` (Issue #142 / ADR §8, §14.3).
function unattendedUatTest() {
  log('  unattended uat (#142)');
  const world = stageCWorld('cmate-stagec-uat', [350, 351]);
  if (!check(world !== null, 'stage C uat: the plan/dispatch world was not generated')) return;

  // Each UAT run gets its OWN worktree world, exactly as runUatCase does: the
  // dispatch report says which issues are eligible, the uat scenario says which
  // of them pass their baseline.
  let runIndex = 0;
  const uatPhase = (phaseFlag, args, uatScenario = {}) => {
    runIndex += 1;
    const workUat = mkdtempSync(join(tmpdir(), `cmate-stagec-uat-run${runIndex}-`));
    const integration = setupWorktrees(world.plan, workUat, (n) => uatSpecPasses(uatScenario, n));
    const outDir = join(workUat, 'uat');
    const logPath = join(workUat, 'uat-cli.log');
    const scenarioPath = writeScenario(workUat, 'uat-scenario.json', { ...uatScenario, worktrees: planToWorktrees(world.plan) });
    const env = { ...baseEnv(), CMATE_FAKE_SCENARIO: scenarioPath, CMATE_FAKE_LOG: logPath, CMATE_FAKE_STATE: workUat };
    const { exit, stdout } = runUatRunner(world.planPath, world.dispatchPath, outDir, phaseFlag, args, env, integration);
    let report = null;
    try { report = JSON.parse(stdout); } catch { /* a refused invocation still prints a failure envelope */ }
    return { exit, report, outDir, log: readCliLog(logPath) };
  };
  const codesOf = (entries) => (entries ?? []).map((entry) => entry.code);
  // A world where both eligible issues fail their baseline, so an approved fix
  // loop has something to repair — and therefore a reason to create a worktree.
  const FAILING = { uat: { 350: { fix_on: 1 }, 351: { fix_on: 1 } }, workers: { 350: { state: 'completed' }, 351: { state: 'completed' } } };
  const acceptanceDir = mkdtempSync(join(tmpdir(), 'cmate-stagec-acc-'));

  // --- 1. the control: HEAD attached and on --expect-branch → it DOES fix ----
  // Without this row every assertion below would pass on a harness that simply
  // never gets as far as creating a worktree.
  {
    const control = uatPhase('--create-uat-fix-worktrees', [
      '--approve', '--unattended', '--require-acceptance', '--acceptance-dir', acceptanceDir,
      '--max-attempts', '1', '--expect-branch', 'feature/integration',
    ], FAILING);
    check(validateAgainst(uatSchema, control.report, 'uat').length === 0,
      `the unattended uat report is not schema-valid: ${validateAgainst(uatSchema, control.report, 'uat').slice(0, 3).join('; ')}`);
    check(control.report?.uat_schema_version === 1,
      `stage C must not bump uat_schema_version, got ${control.report?.uat_schema_version}`);
    check(countCalls(control.log, 'worktree', 'add') > 0,
      'the control run created no fix worktree, so the two stops below prove nothing');
    check(codesOf(control.report?.limitations).includes('unattended_mode'),
      `an unattended uat run should record what it declared, got ${JSON.stringify(codesOf(control.report?.limitations))}`);
  }

  // --- 2. detached HEAD: not one fix worktree is created ---------------------
  // Issue #115 measured it: the re-merge exits 0, builds a commit no branch can
  // reach, and this runner reports `outcome: merged`. The stop is BEFORE that.
  {
    const detached = uatPhase('--create-uat-fix-worktrees', [
      '--approve', '--unattended', '--require-acceptance', '--acceptance-dir', acceptanceDir,
      '--max-attempts', '1', '--expect-branch', 'feature/integration',
    ], { ...FAILING, git: { branch: 'feature/integration', head_ref: null } });
    check(detached.exit === 1, `a detached HEAD should stop the fix loop (exit 1), exited ${detached.exit}`);
    check(detached.report?.status === 'failure', `the detached run should be a failure, got ${detached.report?.status}`);
    check(detached.report?.stop_reason === 'preflight_failed',
      `the stop should reuse preflight_failed, got ${detached.report?.stop_reason}`);
    check(codesOf(detached.report?.blocking_reasons).includes('unattended_cwd_detached'),
      `the stop should name unattended_cwd_detached, got ${JSON.stringify(codesOf(detached.report?.blocking_reasons))}`);
    check(countCalls(detached.log, 'worktree', 'add') === 0,
      `a detached-HEAD run created ${countCalls(detached.log, 'worktree', 'add')} fix worktree(s)`);
    check(countCalls(detached.log, 'merge') === 0, `a detached-HEAD run re-merged ${countCalls(detached.log, 'merge')} time(s)`);
    check(countCalls(detached.log, 'send') === 0, `a detached-HEAD run sent ${countCalls(detached.log, 'send')} fix worker(s)`);
    check(detached.report?.mutated === false, `a stopped run reported mutated=${detached.report?.mutated}`);
    check((detached.report?.attempts ?? []).length === 0,
      `a run stopped in the pre-flight should have no attempt, got ${(detached.report?.attempts ?? []).length}`);
  }

  // --- 3. HEAD on another branch: same stop, different reason ----------------
  // The `main`-checkout shape: the fix would land on the checked-out branch with
  // no PR, no CI and no review, and be irreversible once pushed.
  {
    const wrong = uatPhase('--create-uat-fix-worktrees', [
      '--approve', '--unattended', '--require-acceptance', '--acceptance-dir', acceptanceDir,
      '--max-attempts', '1', '--expect-branch', 'feature/integration',
    ], { ...FAILING, git: { branch: 'main', head_ref: 'main' } });
    check(wrong.exit === 1, `a mismatched HEAD should stop the fix loop (exit 1), exited ${wrong.exit}`);
    check(wrong.report?.stop_reason === 'preflight_failed',
      `the stop should reuse preflight_failed, got ${wrong.report?.stop_reason}`);
    check(codesOf(wrong.report?.blocking_reasons).includes('unattended_cwd_branch_mismatch'),
      `the stop should name unattended_cwd_branch_mismatch, got ${JSON.stringify(codesOf(wrong.report?.blocking_reasons))}`);
    check(countCalls(wrong.log, 'worktree', 'add') === 0,
      `a mismatched-HEAD run created ${countCalls(wrong.log, 'worktree', 'add')} fix worktree(s)`);
    check(countCalls(wrong.log, 'merge') === 0, `a mismatched-HEAD run re-merged ${countCalls(wrong.log, 'merge')} time(s)`);
  }

  // --- 4. the same two worlds WITHOUT --unattended run as they always did ----
  // The non-regression half: the cwd check is part of the unattended contract,
  // and a run with a human present chose its own cwd (ADR §14.3).
  {
    for (const [label, scenario] of [
      ['detached', { ...FAILING, git: { branch: 'feature/integration', head_ref: null } }],
      ['mismatched', { ...FAILING, git: { branch: 'main', head_ref: 'main' } }],
    ]) {
      const attended = uatPhase('--create-uat-fix-worktrees', ['--approve', '--max-attempts', '1'], scenario);
      check(attended.report?.stop_reason !== 'preflight_failed',
        `${label}: a run without --unattended must not take the cwd pre-flight, got ${attended.report?.stop_reason}`);
      check(countCalls(attended.log, 'worktree', 'add') > 0,
        `${label}: a run without --unattended created no fix worktree`);
    }
  }

  // --- 5. --unattended implies --require-acceptance, so acceptance_not_run
  //        cannot happen (ADR §6.5: not promoted — made impossible) -----------
  // The acceptance directory is EMPTY, which is exactly the world that produces
  // `acceptance_not_run` for a run that tolerates the degradation. Measured
  // twice: without the flag it is a limitation and the issues pass on the
  // baseline alone; with it the run cannot even be invoked without the gate, and
  // once the gate is required the same world is a failure with no limitation.
  {
    const degraded = { uat: { 350: 'pass', 351: 'pass' } };
    const tolerated = uatPhase('--write-uat', ['--acceptance-dir', acceptanceDir], degraded);
    check(tolerated.report?.status === 'success', `the tolerating run should succeed, got ${tolerated.report?.status}`);
    check(codesOf(tolerated.report?.limitations).includes('acceptance_not_run'),
      `the tolerating run should record acceptance_not_run, got ${JSON.stringify(codesOf(tolerated.report?.limitations))}`);

    const required = uatPhase('--write-uat', [
      '--unattended', '--require-acceptance', '--acceptance-dir', acceptanceDir, '--max-attempts', '1',
    ], degraded);
    check(required.exit === 7, `the unattended run should fail UAT on the missing result (exit 7), exited ${required.exit}`);
    check(required.report?.stop_reason === 'uat_failed', `the unattended run should stop as uat_failed, got ${required.report?.stop_reason}`);
    check(!codesOf(required.report?.limitations).includes('acceptance_not_run'),
      `acceptance_not_run must not be reachable under --unattended, got ${JSON.stringify(codesOf(required.report?.limitations))}`);
    check(required.report?.acceptance?.required === true,
      `the report should say the semantic gate was required, got ${required.report?.acceptance?.required}`);
    const verdicts = (required.report?.attempts ?? []).flatMap((a) => a.uat_results).map((r) => r.verdict_source);
    check(verdicts.every((source) => source === 'acceptance_required'),
      `every verdict should come from the required gate, got ${JSON.stringify(verdicts)}`);
  }

  // --- 6. --write-uat --unattended does not take the cwd pre-flight ----------
  // It creates no worktree and re-merges nothing, so there is no cwd to protect;
  // a gate there would refuse a run it cannot make safer.
  {
    const detachedRead = uatPhase('--write-uat', [
      '--unattended', '--require-acceptance', '--acceptance-dir', acceptanceDir, '--max-attempts', '1',
    ], { uat: { 350: 'pass', 351: 'pass' }, git: { branch: 'feature/integration', head_ref: null } });
    check(detachedRead.report?.stop_reason !== 'preflight_failed',
      `--write-uat is read-only and must not take the cwd pre-flight, got ${detachedRead.report?.stop_reason}`);
    check(!codesOf(detachedRead.report?.blocking_reasons).includes('unattended_cwd_detached'),
      'a read-only phase must not report a cwd stop');
  }
}

// Stage C: the `verification_gates_unrecorded` promotion in dispatch
// (Issue #142 / ADR §6.5, §8).
//
// The two-point measurement. The second point is the FLAGLESS twin, and that is
// not a shortcut: the promotion is tied to `--unattended` (ADR §16.1 rules that
// a declaration must not mean different things depending on what a later job
// does), stages are releases rather than an invocation-level selector, and the
// un-promoted reading is exactly the one stage A and stage B shipped. So "a
// limitation at stage A/B, blocking at stage C" is measured as "a limitation
// without the flag, blocking with it", over one world read twice.
function unattendedGatesTest() {
  log('  unattended dispatch: unattributed pass (#142)');
  const planPath = unattendedPlan('cmate-unattributed-plan-');
  if (!check(existsSync(planPath), 'unattributed: plan.json was not generated')) return;

  // A contract-capable CLI whose `wait --verify` exits 0 but prints no
  // `GATE <id> PASS|FAIL` line — the Issue #83 world, which d26 already pins for
  // an attended run.
  const scenario = {
    ...UNATTENDED_SCENARIO,
    workers: {
      201: { state: 'completed', verify_exits: [0], gate_lines: false },
      200: { state: 'completed', verify_exits: [0], gate_lines: false },
    },
  };
  const runOnce = (args) => {
    const work = mkdtempSync(join(tmpdir(), 'cmate-unattributed-'));
    const logPath = join(work, 'cli.log');
    const result = runDispatchRunner(planPath, scenario, work, join(work, 'dispatch'), args, logPath);
    return { ...result, report: launcherReport(result), log: readCliLog(logPath) };
  };
  const codesOf = (entries) => (entries ?? []).map((entry) => entry.code);

  // --- point 1: no flag → a limitation, and the run finishes -----------------
  const attended = runOnce(['--expect-branch', 'feature/integration']);
  check(attended.exit === 0, `without --unattended an unattributed pass must not stop the run, exited ${attended.exit}`);
  check(attended.report?.status === 'success', `the attended run should succeed, got ${attended.report?.status}`);
  check(codesOf(attended.report?.limitations).filter((code) => code === 'verification_gates_unrecorded').length === 2,
    `the attended run should record one limitation per unattributed pass, got ${JSON.stringify(codesOf(attended.report?.limitations))}`);
  check(codesOf(attended.report?.blocking_reasons).length === 0,
    `the attended run should record no blocking reason, got ${JSON.stringify(codesOf(attended.report?.blocking_reasons))}`);
  check(deepEqual(sentIssuesFromLog(attended.log), [201, 200]),
    `the attended run should dispatch both waves, sent ${JSON.stringify(sentIssuesFromLog(attended.log))}`);

  // --- point 2: --unattended → blocking, and the next wave is not dispatched --
  const unattended = runOnce(UNATTENDED_ARGS);
  check(unattended.exit === 7, `an unattributed pass should stop an unattended run as partial (exit 7), exited ${unattended.exit}`);
  check(unattended.report?.status === 'partial', `the unattended run should be partial, got ${unattended.report?.status}`);
  // The existing vocabulary receives it: no value was added to the enum.
  check(unattended.report?.stop_reason === 'dispatch_error',
    `the stop should reuse dispatch_error, got ${unattended.report?.stop_reason}`);
  check(unattended.report?.dispatch_schema_version === 1,
    `stage C must not bump dispatch_schema_version, got ${unattended.report?.dispatch_schema_version}`);
  check(validateAgainst(dispatchSchema, unattended.report, 'dispatch').length === 0,
    `the unattended report is not schema-valid: ${validateAgainst(dispatchSchema, unattended.report, 'dispatch').slice(0, 3).join('; ')}`);
  check(codesOf(unattended.report?.blocking_reasons).includes('verification_gates_unrecorded'),
    `the unattended run should name verification_gates_unrecorded as blocking, got ${JSON.stringify(codesOf(unattended.report?.blocking_reasons))}`);
  check(!codesOf(unattended.report?.limitations).includes('verification_gates_unrecorded'),
    'the promoted finding should be blocking, not blocking AND a limitation');
  // The stop is what a stop means here: the second wave was never dispatched.
  check(deepEqual(sentIssuesFromLog(unattended.log), [201]),
    `the unattended run should stop before the second wave, sent ${JSON.stringify(sentIssuesFromLog(unattended.log))}`);
  // The VERDICT is untouched — it is an exit code and it stands (Issue #83). What
  // the promotion changes is whether the run carries it any further.
  const judged = (unattended.report?.waves ?? []).flatMap((wave) => wave.workers ?? []);
  check(judged.every((worker) => worker.verification.outcome === 'pass'),
    `the promotion must not rewrite the verdict, got ${JSON.stringify(judged.map((w) => w.verification.outcome))}`);
  check(unattended.report?.waves?.[0]?.barrier?.advanced === true,
    'the wave barrier itself measures completion and verification, and both held; the stop is a separate finding');
  // Not a human_required stop: whatever swallowed the GATE lines can be fixed
  // without a judgement call — since #160/#170 the first suspect is the RUNNER's
  // own version (the lines go to stderr, which dispatch did not read until
  // 0.26.0), not CommandMate's. Either way it is a version to raise, not a
  // decision to make, so `human_required` stays false.
  check(unattended.report?.human_required === false,
    `an unattributed pass is re-runnable, so human_required should stay false, got ${unattended.report?.human_required}`);
  // dispatch owns no merge-side code: `change_evidence_unavailable` is stage B's
  // promotion and must not appear here at all (no double promotion).
  check(!codesOf(unattended.report?.blocking_reasons).includes('change_evidence_unavailable')
    && !codesOf(unattended.report?.limitations).includes('change_evidence_unavailable'),
  'the dispatch runner must not touch change_evidence_unavailable (stage B promoted it in merge)');

  // --- point 3: the next action agrees with the recovery table (Issue #170) ---
  //
  // The line below is the ONLY place an operator meets this stop, and it is the
  // short form of one row of codes-and-recovery.md. #160 disproved what both used
  // to say — "re-run with a CommandMate that prints GATE lines" — twice over:
  // CommandMate printed them all along (measured on 0.22.2's verify-runner
  // `reportGates`) and printed them to STDERR, which the dispatch runner did not
  // read until 0.26.0, so on that runner the advised re-run stops in the same
  // place forever. The correction reached the two documents and was left out of
  // the runner's own output; this asserts the pair together so a later correction
  // cannot land on one side only.
  //
  // Deliberately NOT a general table-vs-next-line equivalence, which was
  // considered and dropped: of the recovery table's `dispatch` rows, several name
  // a stop_reason rather than a reason code (`drift`, `worker_failed`,
  // `verification_failed`) or a refusal that never renders a summary
  // (`resume_plan_mismatch`, `resume_invalid`), so the check would need an
  // exception list — a THIRD place to keep in sync, which is the disease rather
  // than the cure. `status.mjs`'s hint map carries the same refuted sentence and
  // is outside this change's declared scope, so it is not asserted here either.
  const summary = unattended.report?.summary_markdown ?? '';
  const nextLine = summary.split('\n').find((line) => line.startsWith('- next:') && line.includes('gate を report が名指しできていない'));
  if (check(nextLine !== undefined, 'the unattended stop must render a next action for the unattributed pass')) {
    for (const needle of ['runner の版', 'stderr', '#160']) {
      check(nextLine.includes(needle),
        `the next action must name ${needle} (the runner's version is what #160 measured), got ${JSON.stringify(nextLine)}`);
    }
  }
  check(!summary.includes('行を出す CommandMate で再実行'),
    'the refuted advice ("re-run with a CommandMate that prints GATE lines") must not be back in the summary');
  const recoveryRow = readFileSync(join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'references', 'codes-and-recovery.md'), 'utf8')
    .split('\n').find((line) => line.startsWith('| dispatch `verification_gates_unrecorded`'));
  if (check(recoveryRow !== undefined, 'codes-and-recovery.md has no verification_gates_unrecorded row')) {
    for (const needle of ['まず runner の版を疑う', 'stderr']) {
      check(recoveryRow.includes(needle), `the recovery row must name ${needle}`);
    }
  }
  const skillRow = readFileSync(join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'SKILL.md'), 'utf8')
    .split('\n').find((line) => line.includes('dispatch `verification_gates_unrecorded`'));
  if (check(skillRow !== undefined, 'SKILL.md has no verification_gates_unrecorded row')) {
    for (const needle of ['runner の版', 'stderr']) {
      check(skillRow.includes(needle), `the SKILL.md row must name ${needle}`);
    }
  }
  // The ADR defends `human_required: false` from this same fact, so its reasoning
  // is part of the pair: the fix is a RUNNER version, which is why no human
  // judgement is required (§17.3).
  const adr = readFileSync(join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'references', 'adr-unattended-mode.md'), 'utf8');
  const adrSection = adr.slice(adr.indexOf('### 17.3'), adr.indexOf('### 17.4'));
  for (const needle of ['runner の版', '#160']) {
    check(adrSection.includes(needle), `ADR §17.3 must name ${needle} as the reason human_required stays false`);
  }
}

function launcherTest() {
  log('  launcher resolution (#37)');
  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-launcher-plan-'));
  const spec = { plan: { issues_fixture: 'cases/02-explicit-dependency/issues.json', orchestrate_args: ['200', '201', '--max-parallel', '3', '--run-id', 'plan'] } };
  const planPath = generatePlan(spec, runsDir);
  if (!check(existsSync(planPath), 'launcher: plan.json was not generated')) return;

  // --- 1. a multi-token --cli is split into argv and executed ----------------
  const split = dispatchWithLauncher(planPath, { launcher: `node ${FAKE_CLI}` });
  const splitReport = launcherReport(split);
  check(split.exit === 0, `a multi-token --cli should dispatch, exited ${split.exit}: ${split.stdout.slice(0, 300)}`);
  check(splitReport?.status === 'success', `a multi-token --cli should reach the workers, got status ${splitReport?.status}`);

  // --- 2. CM alone, with no --cli at all -------------------------------------
  const viaEnv = dispatchWithLauncher(planPath, { launcher: null, env: { CM: `node ${FAKE_CLI}` } });
  const envReport = launcherReport(viaEnv);
  check(viaEnv.exit === 0, `CM alone should dispatch, exited ${viaEnv.exit}: ${viaEnv.stdout.slice(0, 300)}`);
  check(envReport?.status === 'success', `CM alone should reach the workers, got status ${envReport?.status}`);

  // A CM that names nothing executable stops the run at the drift re-check with
  // cli_available NG — proving CM is what was spawned rather than being quietly
  // ignored in favour of a `commandmate` that happens to be on this PATH.
  const badEnv = dispatchWithLauncher(planPath, { launcher: null, env: { CM: 'commandmate-does-not-exist' } });
  const badEnvReport = launcherReport(badEnv);
  check(badEnvReport?.stop_reason === 'drift', `an unrunnable CM should stop the run on drift, got stop_reason ${badEnvReport?.stop_reason}`);
  check(
    (badEnvReport?.drift_checks ?? []).some((c) => c.code === 'cli_available' && c.ok === false),
    `an unrunnable CM should fail the cli_available drift check, got ${JSON.stringify(badEnvReport?.drift_checks)}`,
  );

  // --- 3. --cli wins over CM -------------------------------------------------
  const precedence = dispatchWithLauncher(planPath, { launcher: FAKE_CLI, env: { CM: 'commandmate-does-not-exist' } });
  check(launcherReport(precedence)?.status === 'success', '--cli should override CM, but the run did not succeed');

  // --- 4. an unexecutable launcher is refused with advice --------------------
  // The refused launchers are built from the fake CLI on purpose. The shape
  // an operator actually types is `npx commandmate@latest | tee …`, but if the
  // guard is ever removed the tokens have to reach a program this suite owns —
  // a suite that fetches from the npm registry to prove a guard works is a suite
  // that hangs on the first machine without network.
  const refusals = [
    ['shell syntax in --cli', { launcher: `${FAKE_CLI} | tee /tmp/x` }, 'contains shell syntax'],
    ['a quoted --cli', { launcher: `node "${FAKE_CLI}"` }, 'contains shell syntax'],
    ['an empty --cli', { launcher: '   ' }, 'is empty'],
    // A leading dash can only arrive via CM: node:util's parseArgs refuses
    // `--cli --verbose` before this runner ever sees it.
    ['a CM that is a flag', { launcher: null, env: { CM: '-verbose' } }, 'would be read as a flag'],
    ['shell syntax in CM', { launcher: null, env: { CM: `${FAKE_CLI} && echo hi` } }, 'contains shell syntax'],
  ];
  const blockingText = (report) => (report?.blocking_reasons ?? []).map((e) => `${e.code} ${e.detail}`).join(' ');
  for (const [label, opts, needle] of refusals) {
    const refused = dispatchWithLauncher(planPath, opts);
    const detail = blockingText(launcherReport(refused));
    check(refused.exit === 3, `${label}: expected exit 3, got ${refused.exit}`);
    check(detail.includes('invalid_input'), `${label}: expected an invalid_input error, got: ${detail.slice(0, 200)}`);
    check(detail.includes(needle), `${label}: the error should say "${needle}", got: ${detail.slice(0, 300)}`);
    // The advice is the whole point of the improved error: it has to name the way out.
    check(detail.includes('npx --yes commandmate@latest'), `${label}: the error should name the wrapper recipe, got: ${detail.slice(0, 300)}`);
    check(detail.includes('WITHOUT a shell'), `${label}: the error should say no shell is involved, got: ${detail.slice(0, 300)}`);
  }
  // Naming which source produced the bad value, so an inherited CM is not
  // mistaken for a typo on the command line.
  const fromEnv = dispatchWithLauncher(planPath, { launcher: null, env: { CM: `${FAKE_CLI} | cat` } });
  check(
    (launcherReport(fromEnv)?.blocking_reasons ?? []).some((e) => e.detail.startsWith('CM ')),
    `a bad CM should be attributed to CM rather than to --cli, got: ${blockingText(launcherReport(fromEnv)).slice(0, 200)}`,
  );

  // --- 5. uat.mjs resolves identically ---------------------------------------
  // The third file Issue #37's table omits. It gets the same launcher, so the
  // same two claims are made against it: multi-token runs, shell syntax refused.
  const uatWork = mkdtempSync(join(tmpdir(), 'cmate-launcher-uat-'));
  const dispatchPath = generateDispatchReport(planPath, DEFAULT_DISPATCH_SCENARIO, uatWork);
  const uatScenarioPath = writeScenario(uatWork, 'uat-scenario.json', {
    ...LAUNCHER_SCENARIO,
    worktrees: planToWorktrees(readPlan(planPath)),
  });
  const uatEnv = { ...baseEnv(), CMATE_FAKE_SCENARIO: uatScenarioPath, CMATE_FAKE_STATE: uatWork };
  setupWorktrees(readPlan(planPath), uatWork, () => true, {});

  // The UAT verdict itself is irrelevant here; what matters is that the launcher
  // ran at all, i.e. cli_available passed instead of failing on a program name
  // with a space in it.
  const uatSplit = runUatRunner(planPath, dispatchPath, join(uatWork, 'uat-split'), '--write-uat', [], uatEnv, uatWork, { launcher: `node ${FAKE_CLI}` });
  const uatSplitReport = launcherReport(uatSplit);
  check(
    (uatSplitReport?.preflight ?? []).some((c) => c.code === 'cli_available' && c.ok === true),
    `uat with a multi-token --cli should find the CLI runnable, got ${JSON.stringify(uatSplitReport?.preflight)}`,
  );

  const uatRefused = runUatRunner(planPath, dispatchPath, join(uatWork, 'uat-refused'), '--write-uat', [], uatEnv, uatWork, { launcher: `${FAKE_CLI} | tee /tmp/x` });
  check(uatRefused.exit === 3, `uat should refuse an unexecutable --cli with exit 3, got ${uatRefused.exit}`);
  const uatDetail = blockingText(launcherReport(uatRefused));
  check(uatDetail.includes('contains shell syntax'), `uat's refusal should say why, got: ${uatDetail.slice(0, 300)}`);
  check(uatDetail.includes('npx --yes commandmate@latest'), `uat's refusal should name the wrapper recipe, got: ${uatDetail.slice(0, 300)}`);

  // --- 6. the plan is untouched by any of it ---------------------------------
  // Launcher resolution is a RUNTIME concern. If it ever leaks into plan.json the
  // plan stops being a pure function of its inputs, and two operators with
  // different shells stop agreeing on what was planned.
  const planUnderCm = mkdtempSync(join(tmpdir(), 'cmate-launcher-plan-cm-'));
  const issuesPath = join(HERE, spec.plan.issues_fixture);
  const argv = [
    '200', '201', '--max-parallel', '3', '--run-id', 'plan',
    '--profile-json', NODE_FAKE_PROFILE, '--issue-json', issuesPath, '--runs-dir', planUnderCm,
  ];
  const planned = runRunner(argv, undefined, { ...baseEnv(), CM: 'npx commandmate@latest' });
  check(planned.exit === 0, `planning under CM should succeed, exited ${planned.exit}: ${planned.stdout.slice(0, 300)}`);
  const withCm = join(planUnderCm, 'plan', 'plan.json');
  if (check(existsSync(withCm), 'planning under CM produced no plan.json')) {
    check(
      readFileSync(withCm, 'utf8') === readFileSync(planPath, 'utf8'),
      'CM changed plan.json — launcher resolution leaked into the plan',
    );
  }
}

// =============================================================================
// profile-init cases (Issue #94)
// =============================================================================
//
// The drafting runner turns a repository's own declarations into a profile
// draft. Each case is a miniature repository under `<case>/repo` plus the golden
// profile it must produce, and the suite holds the runner to the four promises
// the feature is worth having for:
//
//   the golden        same tree in, byte-identical profile out (Claude/Codex
//                     parity, and the reason no clock/network/subprocess is used)
//   the gaps          a field with no evidence gets a safe template AND a TODO;
//                     never a quiet guess that reads like a detected value
//   the provenance    every evidence path names a file that actually exists in
//                     the fixture, at a line that actually contains the quote
//   the handoff       the draft feeds straight into orchestrate.mjs
//                     --profile-json and plans

function runProfileInit(args) {
  try {
    const stdout = execFileSync('node', [PROFILE_INIT_RUNNER, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: baseEnv(),
    });
    return { exit: 0, stdout };
  } catch (error) {
    return { exit: error.status ?? 1, stdout: error.stdout ? error.stdout.toString() : '' };
  }
}

// The draft has to survive the round trip it exists for: written to a file and
// handed to the planner exactly as emitted. --allow-unverified is required and
// that is the point — a drafted profile is unverified by construction.
function planWithDraft(profilePath, label) {
  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-profile-init-plan-'));
  const planned = runRunner([
    '100',
    '--profile-json', profilePath,
    '--allow-unverified',
    '--issue-json', join(CASES_DIR, '01-independent', 'issues.json'),
    '--runs-dir', runsDir,
  ]);
  if (!check(planned.exit === 0, `${label}: the draft should plan, exited ${planned.exit}: ${planned.stdout.slice(0, 400)}`)) {
    return;
  }
  const result = JSON.parse(planned.stdout);
  const errors = validateAgainst(planSchema, result.plan, `${label} plan`);
  check(errors.length === 0, `${label}: plan from the draft is not schema-conformant: ${errors.join('; ')}`);
  check(
    result.plan.profile.verified === false,
    `${label}: a drafted profile must reach the plan as unverified`,
  );
  check(
    result.plan.risk.factors.some((factor) => factor.code === 'unverified_profile'),
    `${label}: planning on a draft must carry the unverified_profile risk factor`,
  );
}

function runProfileInitCase(caseId) {
  const caseDir = join(PROFILE_INIT_CASES_DIR, caseId);
  const spec = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'));
  const repoDir = join(caseDir, 'repo');
  log(`  ${caseId}: ${spec.description}`);

  const args = ['--repo-root', repoDir, ...(spec.args ?? [])];
  const run = runProfileInit(args);
  if (!check(run.exit === 0, `drafting should exit 0, exited ${run.exit}: ${run.stdout.slice(0, 400)}`)) return;

  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    check(false, 'the envelope on stdout is not JSON');
    return;
  }
  const expect = spec.expect ?? {};

  check(result.draft === true, 'the envelope must declare itself a draft');
  check(result.profile.verified === false, 'a drafted profile must never claim verification');
  check(result.status === expect.status, `status ${result.status} != ${expect.status}`);
  check(result.completion_check.passed === true, 'the drafting completion check should pass');

  // The golden. Compared as BYTES, not as a parsed object: field order is part of
  // what a reviewer diffs, and `--emit profile` is what gets piped into a file.
  const golden = readFileSync(join(caseDir, 'expected-profile.json'), 'utf8');
  const emitted = runProfileInit([...args, '--emit', 'profile']);
  check(emitted.exit === 0, `--emit profile should exit 0, exited ${emitted.exit}`);
  check(emitted.stdout === golden, `--emit profile does not match the golden profile:\n${emitted.stdout}`);
  check(deepEqual(result.profile, JSON.parse(golden)), 'the envelope profile and the golden disagree');

  // Determinism: the same tree twice is the same bytes. This is the property the
  // whole no-clock/no-network/sorted-listing discipline exists to buy.
  const again = runProfileInit(args);
  check(again.stdout === run.stdout, 'two runs over the same tree produced different output');

  const sources = {};
  for (const entry of result.provenance) sources[entry.field] = entry.source;
  for (const [field, source] of Object.entries(expect.sources ?? {})) {
    check(sources[field] === source, `provenance source for ${field} is ${sources[field]}, expected ${source}`);
  }
  check(
    deepEqual((result.todos ?? []).map((todo) => todo.code), expect.todos ?? []),
    `todo codes ${JSON.stringify((result.todos ?? []).map((t) => t.code))} != ${JSON.stringify(expect.todos ?? [])}`,
  );
  check(
    deepEqual((result.warnings ?? []).map((warning) => warning.code), expect.warnings ?? []),
    `warning codes ${JSON.stringify((result.warnings ?? []).map((w) => w.code))} != ${JSON.stringify(expect.warnings ?? [])}`,
  );

  // A default with no TODO is the failure this feature is about: it reads
  // exactly like a detected value and nobody goes looking for it.
  for (const entry of result.provenance) {
    if (entry.source !== 'default') continue;
    check(
      (result.todos ?? []).some((todo) => todo.field === entry.field),
      `${entry.field} fell back to a template with no TODO to say so`,
    );
    check(entry.evidence.length === 0, `${entry.field} is a template yet claims evidence`);
  }

  // Provenance has to point at something real. A cited line that does not
  // contain the quoted text is a citation that cannot be checked.
  for (const entry of result.provenance) {
    for (const item of entry.evidence) {
      const full = join(repoDir, item.file);
      if (!check(existsSync(full), `${entry.field} cites ${item.file}, which is not in the fixture`)) continue;
      if (item.line === null) continue;
      const line = readFileSync(full, 'utf8').split(/\r?\n/)[item.line - 1] ?? '';
      check(
        line.trim() === item.text || line.includes(item.text.replace(/…$/, '')),
        `${entry.field} cites ${item.file}:${item.line} but that line does not contain the quoted text`,
      );
    }
    const expectedFiles = (expect.evidence_files ?? {})[entry.field];
    if (expectedFiles !== undefined) {
      check(
        deepEqual(entry.evidence.map((item) => item.file), expectedFiles),
        `${entry.field} evidence files ${JSON.stringify(entry.evidence.map((i) => i.file))} != ${JSON.stringify(expectedFiles)}`,
      );
    }
  }

  // A baseline nobody could infer must FAIL, not pass by having nothing to run:
  // dispatch.mjs treats an empty baseline as a fail, and a placeholder that
  // exits zero would be worse than either.
  if (expect.baseline_fails_closed) {
    check(result.profile.baseline.length > 0, 'a placeholder baseline must not be empty');
    for (const command of result.profile.baseline) {
      const argv = command.trim().split(/\s+/);
      let ok = true;
      try {
        execFileSync(argv[0], argv.slice(1), { stdio: 'ignore' });
      } catch {
        ok = false;
      }
      check(!ok, `the placeholder baseline command "${command}" exited zero; it must fail closed`);
    }
  }

  // --out writes the same bytes as --emit profile, and refuses to clobber.
  const outDir = mkdtempSync(join(tmpdir(), 'cmate-profile-init-out-'));
  const outPath = join(outDir, 'profile.json');
  const written = runProfileInit([...args, '--out', outPath]);
  check(written.exit === 0, `--out should exit 0, exited ${written.exit}`);
  check(existsSync(outPath) && readFileSync(outPath, 'utf8') === golden, '--out did not write the golden profile');
  const clobber = runProfileInit([...args, '--out', outPath]);
  check(clobber.exit === 4, `a second --out to the same path should be refused with exit 4, exited ${clobber.exit}`);
  check(
    JSON.parse(clobber.stdout).errors.some((error) => error.code === 'out_exists'),
    '--out over an existing file should fail with out_exists',
  );

  planWithDraft(outPath, caseId);
}

// The drafting runner's argument and failure handling: bad input is refused with
// a machine code, not absorbed into a plausible-looking draft.
function profileInitInputTest() {
  log('  profile-init input handling');
  const bad = [
    { args: ['--repo-root', join(PROFILE_INIT_CASES_DIR, 'does-not-exist')], code: 'load_error', exit: 6 },
    { args: ['--emit', 'yaml'], code: 'invalid_input', exit: 3 },
    { args: ['--repo', 'not-a-slug'], code: 'invalid_input', exit: 3 },
    { args: ['--id', '-leading-dash'], code: 'invalid_input', exit: 3 },
  ];
  for (const scenario of bad) {
    const run = runProfileInit(scenario.args);
    check(run.exit === scenario.exit, `${scenario.args.join(' ')} should exit ${scenario.exit}, exited ${run.exit}`);
    const result = JSON.parse(run.stdout);
    check(result.status === 'failure', `${scenario.args.join(' ')} should report status failure`);
    check(
      result.errors.some((error) => error.code === scenario.code),
      `${scenario.args.join(' ')} should fail with ${scenario.code}, got ${JSON.stringify(result.errors)}`,
    );
  }

  // The two declarations override detection rather than being merged with it.
  const repoDir = join(PROFILE_INIT_CASES_DIR, '01-node-npm', 'repo');
  const declared = runProfileInit(['--repo-root', repoDir, '--repo', 'Other/name', '--id', 'my-profile']);
  check(declared.exit === 0, `declaring --repo/--id should exit 0, exited ${declared.exit}`);
  const result = JSON.parse(declared.stdout);
  check(result.profile.repository === 'Other/name', '--repo did not override the detected slug');
  check(result.profile.id === 'my-profile', '--id did not override the derived id');
  const sources = Object.fromEntries(result.provenance.map((entry) => [entry.field, entry.source]));
  check(sources.repository === 'flag' && sources.id === 'flag', 'a declared value must be recorded as coming from a flag');
}

// =============================================================================
// Self-test of the validator: it must reject a broken plan, not wave it through.
// =============================================================================

function selfTestValidator() {
  log('  validator self-test');
  const broken = { plan_schema_version: 2 };
  check(validateAgainst(planSchema, broken, 'broken').length > 0, 'validator accepted a broken plan');

  const good = JSON.parse(readFileSync(join(CASES_DIR, '01-independent', 'issues.json'), 'utf8'));
  check(Array.isArray(good.issues), 'fixture 01 is malformed'); // sanity anchor
}

// Re-plan semantics (#46 / CommandMate #1678 B-4): fixing an issue body is the
// normal answer to a blocking question, so the SAME issue set with a CHANGED
// body must derive a new run id and succeed into the same runs dir — while a
// byte-identical re-run is still refused (run_exists) with the workarounds
// (--run-id / --runs-dir) named in the error detail.
function rerunSemanticsTest() {
  log('  re-plan after an issue edit (#46)');
  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-orch-rerun-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'cmate-orch-rerun-issues-'));
  const issuesV1 = JSON.parse(readFileSync(join(CASES_DIR, '01-independent', 'issues.json'), 'utf8'));
  const v1Path = join(fixtureDir, 'v1.json');
  writeFileSync(v1Path, JSON.stringify(issuesV1));
  const argsFor = (issuesPath) => ['100', '--profile', 'node-commandmate', '--issue-json', issuesPath, '--runs-dir', runsDir];

  const first = runRunner(argsFor(v1Path));
  if (!check(first.exit === 0, `first plan should succeed, exited ${first.exit}`)) return;
  const firstId = JSON.parse(first.stdout).run_id;

  const second = runRunner(argsFor(v1Path));
  check(second.exit === 4, `an unchanged re-plan should be refused with exit 4, exited ${second.exit}`);
  const secondResult = JSON.parse(second.stdout);
  check(secondResult.errors.some((e) => e.code === 'run_exists'), 'an unchanged re-plan should fail with run_exists');
  const detail = secondResult.errors.map((e) => e.detail).join(' ');
  check(detail.includes('--run-id'), `run_exists detail should name the --run-id workaround: ${detail}`);
  check(detail.includes('--runs-dir'), `run_exists detail should name the --runs-dir workaround: ${detail}`);

  const issuesV2 = JSON.parse(JSON.stringify(issuesV1));
  issuesV2.issues[0].body += '\n\n## 決定\n- blocking question への回答を本文に追記した。\n';
  const v2Path = join(fixtureDir, 'v2.json');
  writeFileSync(v2Path, JSON.stringify(issuesV2));
  const third = runRunner(argsFor(v2Path));
  check(third.exit === 0, `a re-plan with an edited body should succeed, exited ${third.exit}`);
  if (third.exit === 0) {
    const thirdId = JSON.parse(third.stdout).run_id;
    check(thirdId !== firstId, `an edited body should derive a new run id (both were ${firstId})`);
    check(existsSync(join(runsDir, thirdId, 'plan.json')), 'the edited re-plan should land in its own run directory');
  }
}

// =============================================================================
// run_id covers the WHOLE resolved profile (Issue #157)
// =============================================================================
//
// The default run id used to hash three profile fields (`base` / `id` /
// `repository`) while five more decide plan content, so two plans with different
// content could claim the same id. This suite is the measurement that the
// enumeration is gone: for each field it plans TWICE from profiles that differ in
// that ONE field and asserts both that the ids diverge AND that the plans really
// do differ where that field lands. The second half matters — an id that churned
// on a field with no effect on the plan would pass the first assertion alone and
// prove nothing about the property the id is supposed to carry.
//
// The two-point measurement (the acceptance condition of #157) is the pair at
// the end: identical profile + identical issues + identical options still derive
// the SAME id and are still refused by `run_exists`, so widening the hash did not
// quietly turn no-overwrite into overwrite.

// The base profile every variant below is a one-field edit of. Kept separate from
// writeProfile() above (which varies only `scope_companions`) because these cases
// need to reach every field, including ones that profile has to hold fixed.
const RUN_ID_BASE_PROFILE = {
  id: 'run-id-base',
  repository: 'Kewton/CommandMate',
  base: 'origin/develop',
  branch_template: 'feature/issue-{number}-{slug}',
  worktree_template: '../{repo}-issue-{number}-{slug}',
  baseline: ['npm test'],
  verified: true,
};

function writeProfileVariant(dir, name, overrides) {
  const path = join(dir, name);
  const profile = { ...RUN_ID_BASE_PROFILE, ...overrides };
  if (overrides.scope_companions === undefined) delete profile.scope_companions;
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`);
  return path;
}

// One issue that touches every field under measurement at once: a declared ruby
// source (so `scope_companions` has something to mirror), a title that slugifies
// (so branch/worktree templates expand visibly), and two commands in code spans
// whose heads — `npm` and `bundle` — are recognised only when the profile's
// `baseline` names them, which is how `baseline` reaches test_expectations.
const RUN_ID_ISSUE = {
  issues: [{
    number: 471,
    title: 'fix: user profile を直す',
    body: '## 対象ファイル\n- `app/models/user.rb`\n\n'
      + '## Acceptance criteria\n- [ ] 直っている\n\n'
      + '## 検証\n- `npm test`\n- `bundle exec rspec`\n',
    labels: ['bug'],
  }],
};

function planWithProfile(profilePath, issuesPath, extraArgs = []) {
  const runsDir = mkdtempSync(join(tmpdir(), 'cmate-orch-runid-'));
  const args = ['471', '--profile-json', profilePath, ...extraArgs, '--issue-json', issuesPath, '--runs-dir', runsDir];
  const { exit, stdout } = runRunner(args);
  return { exit, runsDir, result: exit === 0 || stdout ? JSON.parse(stdout) : null };
}

function runIdCoversProfileTest() {
  const dir = mkdtempSync(join(tmpdir(), 'cmate-orch-runid-in-'));
  const issuesPath = join(dir, 'issues.json');
  writeFileSync(issuesPath, JSON.stringify(RUN_ID_ISSUE));

  const basePath = writeProfileVariant(dir, 'base.json', {});

  // Each entry: the field, the profile that differs only in it, the extra CLI
  // options both sides need, and the plan projection that must ALSO differ.
  const variants = [
    {
      field: 'baseline',
      overrides: { baseline: ['bundle exec rspec'] },
      args: [],
      project: (plan) => plan.issues[0].test_expectations,
    },
    {
      field: 'branch_template',
      overrides: { branch_template: 'work/{number}-{slug}' },
      args: [],
      project: (plan) => plan.issues[0].branch,
    },
    {
      field: 'worktree_template',
      overrides: { worktree_template: '../wt-{number}' },
      args: [],
      project: (plan) => plan.issues[0].worktree,
    },
    {
      // Both sides pass --allow-unverified, so the flag is not what differs —
      // without it the unverified side would exit 3 and never reach a run id.
      field: 'verified',
      overrides: { verified: false },
      args: ['--allow-unverified'],
      project: (plan) => [plan.risk.level, plan.risk.factors.map((f) => f.code)],
    },
    {
      // `app/{dir}{base}.rb` -> `spec/{dir}{base}_spec.rb` is the L2 mirror of
      // #149: a convention no L1 path rule derives, declared in the profile.
      field: 'scope_companions',
      overrides: {
        scope_companions: {
          derive: [{ when: 'app/{dir}{base}.rb', add: ['spec/{dir}{base}_spec.rb'] }],
        },
      },
      args: [],
      project: (plan) => plan.issues[0].suspected_files,
    },
  ];

  for (const variant of variants) {
    log(`  a profile differing only in \`${variant.field}\` derives a different run id (#157)`);
    const variantPath = writeProfileVariant(dir, `${variant.field}.json`, variant.overrides);
    const left = planWithProfile(basePath, issuesPath, variant.args);
    const right = planWithProfile(variantPath, issuesPath, variant.args);
    if (!check(left.exit === 0 && right.exit === 0, `both plans should succeed, exited ${left.exit}/${right.exit}`)) continue;
    check(
      left.result.run_id !== right.result.run_id,
      `editing \`${variant.field}\` alone left the run id at ${left.result.run_id}`,
    );
    // The half that makes the assertion above mean something: the field really
    // does move the plan, so the two ids are naming two different plans.
    check(
      !deepEqual(variant.project(left.result.plan), variant.project(right.result.plan)),
      `\`${variant.field}\` did not change the plan it is supposed to decide `
        + `(${JSON.stringify(variant.project(left.result.plan))}); the run-id assertion above is measuring nothing`,
    );
  }

  // Key ORDER is not a difference. A profile is a JSON object, and a hand-edited
  // one whose keys moved is the same profile, so re-ordering its keys must not
  // fork a run id. Nothing in the signature sorts keys — the guarantee comes from
  // normalizeProfile REBUILDING the profile field by field before it is ever
  // hashed. That is a load-time property nothing else measures, and hashing the
  // whole profile is what made it load-bearing: a future field that passed a
  // caller-supplied object through unrebuilt would fork the id on a cosmetic
  // edit, and this is the assertion that would say so.
  log('  re-ordering a profile\'s keys does not change the run id (#157)');
  const reorderedPath = join(dir, 'reordered.json');
  const reordered = {};
  for (const key of Object.keys(RUN_ID_BASE_PROFILE).reverse()) reordered[key] = RUN_ID_BASE_PROFILE[key];
  writeFileSync(reorderedPath, `${JSON.stringify(reordered, null, 2)}\n`);
  const straight = planWithProfile(basePath, issuesPath);
  const shuffled = planWithProfile(reorderedPath, issuesPath);
  if (check(straight.exit === 0 && shuffled.exit === 0, 'both key orders should plan successfully')) {
    check(
      straight.result.run_id === shuffled.result.run_id,
      `re-ordering profile keys forked the run id (${straight.result.run_id} / ${shuffled.result.run_id})`,
    );
  }

  // Point two of the two-point measurement: nothing about widening the hash
  // loosened no-overwrite. The same profile, issues and options derive the same
  // id, the plan artifact is byte-identical across two runs directories (the runs
  // directory is not an input and must not reach a byte of the plan), and a
  // second run into the SAME directory is still refused.
  log('  an identical re-run still derives the same run id and is still refused (#157)');
  const again = planWithProfile(basePath, issuesPath);
  if (check(again.exit === 0, `the repeat plan should succeed, exited ${again.exit}`)) {
    check(
      straight.result.run_id === again.result.run_id,
      `an identical re-run forked the run id (${straight.result.run_id} / ${again.result.run_id})`,
    );
    const bytes = [
      readFileSync(join(straight.runsDir, straight.result.run_id, 'plan.json'), 'utf8'),
      readFileSync(join(again.runsDir, again.result.run_id, 'plan.json'), 'utf8'),
    ];
    check(bytes[0] === bytes[1], 'two runs of the same input produced different plan bytes');
  }

  const overwrite = runRunner([
    '471', '--profile-json', basePath, '--issue-json', issuesPath, '--runs-dir', straight.runsDir,
  ]);
  check(overwrite.exit === 4, `re-planning into an existing run directory should exit 4, exited ${overwrite.exit}`);
  const overwriteResult = JSON.parse(overwrite.stdout);
  check(overwriteResult.errors.some((e) => e.code === 'run_exists'), 'the repeat run should fail with run_exists');
  const detail = overwriteResult.errors.map((e) => e.detail).join(' ');
  check(detail.includes('--run-id'), `run_exists detail should name the --run-id workaround: ${detail}`);
  check(detail.includes('--runs-dir'), `run_exists detail should name the --runs-dir workaround: ${detail}`);
  // The claim the message is no longer allowed to make (#157). The hash cannot
  // see the cwd origin the default-profile cross-check reads, so "nothing
  // changed" is a conclusion for the operator to reach, not one for the runner
  // to assert. The message must point at the existing plan instead.
  check(
    !/nothing changed/i.test(detail),
    `run_exists detail still asserts that nothing changed: ${detail}`,
  );
  check(detail.includes('plan.json'), `run_exists detail should point at the existing plan.json: ${detail}`);
  // The five fields the old three-field hash missed are named, because the
  // operator reading this is deciding whether their profile edit is the reason
  // this id already exists.
  for (const field of ['baseline', 'branch_template', 'worktree_template', 'verified', 'scope_companions']) {
    check(detail.includes(field), `run_exists detail should name the profile field ${field}: ${detail}`);
  }
}

// =============================================================================
// Test companions: byte-identical derivation (Issue #147)
// =============================================================================
//
// Every plan case already re-runs the planner and compares the two plans as
// PARSED objects, which cannot see field order. The derivation feeds the
// contract, and dispatch-contract.md's guarantee is that the same plan yields a
// byte-identical contract, so this compares the two runs' plan.json artifacts as
// BYTES — a derivation that walked a Set, sorted by a locale rule, or appended in
// discovery order would pass deepEqual and fail here. The two runs use different
// --runs-dir values on purpose: the run directory is not an input, so it must not
// reach a single byte of the plan (the result envelope quotes it in `run_dir`,
// which is why the artifact rather than stdout is the thing compared).
function testCompanionDeterminismTest() {
  const issuesPath = join(CASES_DIR, '34-test-companions-go-python', 'issues.json');
  const args = ['443', '--profile', 'node-commandmate'];
  const runs = [mkdtempSync(join(tmpdir(), 'cmate-orch-det-')), mkdtempSync(join(tmpdir(), 'cmate-orch-det-'))];
  const results = runs.map((runsDir) => runRunner(buildArgs(args, issuesPath, runsDir)));
  log('  test companion derivation is byte-identical across runs (#147)');
  if (!check(results.every((r) => r.exit === 0), `both runs should succeed, exited ${results.map((r) => r.exit).join('/')}`)) return;
  const [firstId, secondId] = results.map((r) => JSON.parse(r.stdout).run_id);
  check(firstId === secondId, `the same input derived two run ids (${firstId} / ${secondId})`);
  const bytes = runs.map((runsDir, i) => readFileSync(join(runsDir, JSON.parse(results[i].stdout).run_id, 'plan.json'), 'utf8'));
  check(bytes[0] === bytes[1], 'two runs of the same plan input produced different plan bytes');

  // The bound the derivation must stay inside. dispatch.mjs sorts scope.allow and
  // truncates it to MAX_SCOPE_PATTERNS, so an issue whose derived entries pushed
  // the total past 200 would lose DECLARED files to alphabetically earlier
  // derived ones — the very failure this feature removes.
  const plan = JSON.parse(results[0].stdout).plan;
  for (const issue of plan.issues) {
    check(
      issue.suspected_files.length <= 200,
      `#${issue.number} has ${issue.suspected_files.length} scope patterns, over dispatch's MAX_SCOPE_PATTERNS`,
    );
    // Invariant 2: nothing reaches scope.allow without being reported.
    const declared = new Set(issue.suspected_files);
    for (const path of issue.scope_defaults) {
      check(declared.has(path), `#${issue.number}: scope_defaults entry ${path} is not in suspected_files`);
    }
  }
}

// The bound, exercised rather than asserted. dispatch.mjs SORTS scope.allow and
// then truncates it to MAX_SCOPE_PATTERNS (200), so a derivation that ignored the
// bound would not merely lose its own tail — an alphabetically earlier derived
// path would displace a DECLARED file, which is the failure Issue #147 exists to
// remove. 60 declared `.ts` files is past the point where the JS shapes (4 each)
// fit: exactly 35 of them derive (60 + 35*4 = 200) and the derivation stops at
// that source-file boundary, whole rather than half-emitted.
function testCompanionBoundTest() {
  const dir = mkdtempSync(join(tmpdir(), 'cmate-orch-bound-'));
  const declared = Array.from({ length: 60 }, (_, i) => `src/m${String(i + 1).padStart(2, '0')}.ts`);
  const issuesPath = join(dir, 'issues.json');
  writeFileSync(issuesPath, JSON.stringify({
    issues: [{
      number: 450,
      title: 'refactor: module 名を一括で揃える',
      body: `次のファイルの module 名を揃える。\n\n${declared.map((p) => `- \`${p}\``).join('\n')}\n\n## Acceptance criteria\n- [ ] すべての module が新しい命名である\n`,
      labels: ['chore'],
    }],
  }));

  log('  test companion derivation stays inside dispatch\'s scope bound (#147)');
  const result = runRunner(buildArgs(['450', '--profile', 'node-commandmate'], issuesPath, join(dir, 'runs')));
  if (!check(result.exit === 0, `the planner should succeed, exited ${result.exit}`)) return;
  const issue = JSON.parse(result.stdout).plan.issues[0];
  check(issue.suspected_files.length === 200, `expected exactly 200 scope patterns, got ${issue.suspected_files.length}`);
  check(issue.scope_defaults.length === 140, `expected 140 derived entries, got ${issue.scope_defaults.length}`);
  // Every declared file survives — the bound must never cost the issue its own
  // paths — and the cut falls between two source files rather than inside one.
  for (const path of declared) check(issue.suspected_files.includes(path), `declared ${path} was pushed out of scope`);
  for (const shape of ['src/m35.test.ts', 'src/m35.spec.ts', 'src/__tests__/m35.ts', 'src/__tests__/m35.test.ts']) {
    check(issue.suspected_files.includes(shape), `${shape} should have been derived before the bound`);
  }
  for (const shape of ['src/m36.test.ts', 'src/m36.spec.ts', 'src/__tests__/m36.ts', 'src/__tests__/m36.test.ts']) {
    check(!issue.suspected_files.includes(shape), `${shape} was derived past the bound`);
  }
  check(issue.suspected_files.includes('src/m36.ts'), 'the 36th source file is declared and must stay in scope');
}

// =============================================================================
// scope_companions: layer L2 (Issue #149)
// =============================================================================
//
// Per-case fixtures pin what a declared rule derives (44 / 48 / 49) and that a
// profile without the key plans byte-for-byte as it did before the feature (45,
// against a golden generated by the 0.24.0 runner). Three properties they cannot
// see live here: the derivation is byte-identical across runs, it obeys the same
// scope bound L1 does when the two are SUMMED, and the shapes that would grant a
// permission unrelated to the declaration are refused rather than ignored.

function writeProfile(dir, name, scopeCompanions) {
  const path = join(dir, name);
  const profile = {
    id: name.replace(/\.json$/, ''),
    repository: 'Kewton/CommandMate',
    base: 'origin/develop',
    branch_template: 'feature/issue-{number}-{slug}',
    worktree_template: '../{repo}-issue-{number}-{slug}',
    baseline: ['npm test'],
    verified: true,
  };
  if (scopeCompanions !== undefined) profile.scope_companions = scopeCompanions;
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`);
  return path;
}

// The same property the L1 suite measures, extended to the profile-driven half.
// Plan cases compare two runs as PARSED objects, which cannot see field order;
// the contract's byte-identical guarantee needs the ARTIFACTS compared as bytes.
// A derivation that walked a Set or sorted its output would pass deepEqual and
// fail here. The two runs use different --runs-dir values because the run
// directory is not an input and must not reach a byte of the plan.
function profileCompanionDeterminismTest() {
  log('  a profile-declared companion derives byte-identically across runs (#149)');
  const dir = mkdtempSync(join(tmpdir(), 'cmate-orch-l2-det-'));
  const profilePath = writeProfile(dir, 'mirror.json', {
    derive: [
      { when: 'app/{dir}{base}.rb', add: ['spec/{dir}{base}_spec.rb', 'spec/factories/{base}.rb'] },
      { when: 'config/locales/{base}.yml', add: ['config/locales/generated/{base}.yml'] },
    ],
  });
  const issuesPath = join(dir, 'issues.json');
  writeFileSync(issuesPath, JSON.stringify({
    issues: [{
      number: 480,
      title: 'feat: locale を追加する',
      body: '## 対象ファイル\n- `app/models/user.rb`\n- `app/jobs/mailer.rb`\n- `config/locales/ja.yml`\n\n'
        + '## Acceptance criteria\n- [ ] ja の文言が出る\n',
      labels: ['feature'],
    }],
  }));
  const args = ['480', '--profile-json', profilePath];
  const runs = [mkdtempSync(join(tmpdir(), 'cmate-orch-l2-det-')), mkdtempSync(join(tmpdir(), 'cmate-orch-l2-det-'))];
  const results = runs.map((runsDir) => runRunner(buildArgs(args, issuesPath, runsDir)));
  if (!check(results.every((r) => r.exit === 0), `both runs should succeed, exited ${results.map((r) => r.exit).join('/')}`)) return;
  const [firstId, secondId] = results.map((r) => JSON.parse(r.stdout).run_id);
  check(firstId === secondId, `the same input derived two run ids (${firstId} / ${secondId})`);
  const bytes = runs.map((runsDir, i) => readFileSync(join(runsDir, JSON.parse(results[i].stdout).run_id, 'plan.json'), 'utf8'));
  check(bytes[0] === bytes[1], 'two runs of the same plan input produced different plan bytes');

  // L1 first (the ruby `_spec.rb` sibling of each declared source), then L2's
  // block: declared-file order, then declaration order, then `add` order. The
  // whole list is re-derivable by hand from the profile and the issue, which is
  // the property that makes it a contract rather than an implementation detail.
  const issue = JSON.parse(results[0].stdout).plan.issues[0];
  check(
    deepEqual(issue.scope_defaults, [
      'app/models/user_spec.rb',
      'app/jobs/mailer_spec.rb',
      'spec/models/user_spec.rb',
      'spec/factories/user.rb',
      'spec/jobs/mailer_spec.rb',
      'spec/factories/mailer.rb',
      'config/locales/generated/ja.yml',
    ]),
    `scope_defaults are not the declaration read in order: ${JSON.stringify(issue.scope_defaults)}`,
  );
  // Invariant 2: nothing reaches scope.allow without also being reported.
  const declared = new Set(issue.suspected_files);
  for (const path of issue.scope_defaults) {
    check(declared.has(path), `scope_defaults entry ${path} is not in suspected_files`);
  }
  // And the plan carries the declaration that produced them, so a reviewer can
  // trace an entry no L1 rule explains back to the profile.
  const plan = JSON.parse(results[0].stdout).plan;
  check(plan.profile.scope_companions?.derive?.length === 2, 'the plan should echo the profile declaration');
}

// The bound, SUMMED. L1 already stops before dispatch's MAX_SCOPE_PATTERNS (200,
// after which dispatch.mjs sorts scope.allow and truncates it, letting an
// alphabetically earlier DERIVED path displace a DECLARED one). L2 runs after L1,
// so the only bound that matters is the combined one: 30 declared `.ts` files
// take 30 + 30*4 = 150 slots from L1, and the profile's 2 patterns per file fit
// for exactly 25 more files before the next whole file would cross 200.
function profileCompanionBoundTest() {
  log('  L1 + L2 together stay inside dispatch\'s scope bound (#149)');
  const dir = mkdtempSync(join(tmpdir(), 'cmate-orch-l2-bound-'));
  const profilePath = writeProfile(dir, 'wide.json', {
    derive: [
      { when: 'src/{base}.ts', add: ['spec/{base}_spec.ts'] },
      { when: 'src/{base}.ts', add: ['stories/{base}.stories.ts'] },
    ],
  });
  const declared = Array.from({ length: 30 }, (_, i) => `src/m${String(i + 1).padStart(2, '0')}.ts`);
  const issuesPath = join(dir, 'issues.json');
  writeFileSync(issuesPath, JSON.stringify({
    issues: [{
      number: 481,
      title: 'refactor: module 名を一括で揃える',
      body: `次のファイルの module 名を揃える。\n\n${declared.map((p) => `- \`${p}\``).join('\n')}\n\n## Acceptance criteria\n- [ ] すべての module が新しい命名である\n`,
      labels: ['chore'],
    }],
  }));

  const result = runRunner(buildArgs(['481', '--profile-json', profilePath], issuesPath, join(dir, 'runs')));
  if (!check(result.exit === 0, `the planner should succeed, exited ${result.exit}`)) return;
  const issue = JSON.parse(result.stdout).plan.issues[0];
  check(issue.suspected_files.length === 200, `expected exactly 200 scope patterns, got ${issue.suspected_files.length}`);
  for (const path of declared) check(issue.suspected_files.includes(path), `declared ${path} was pushed out of scope`);
  // The cut falls between two declared files, never inside one: a file gets all
  // of its companions or none.
  for (const shape of ['spec/m25_spec.ts', 'stories/m25.stories.ts']) {
    check(issue.suspected_files.includes(shape), `${shape} should have been derived before the bound`);
  }
  for (const shape of ['spec/m26_spec.ts', 'stories/m26.stories.ts']) {
    check(!issue.suspected_files.includes(shape), `${shape} was derived past the bound`);
  }
}

// A declaration this runner had to repair is a declaration whose author should be
// told. Every shape below is refused at profile load with `load_error` (exit 6),
// the code an unknown profile field already gets — and refused BEFORE an issue is
// read, so no plan built on one can exist. The first two are the ones invariant 1
// is about; the rest are the typos that would otherwise become a rule that
// silently matches nothing.
function profileCompanionRejectionTest() {
  log('  a companion declaration unrelated to the issue\'s files is refused (#149)');
  const dir = mkdtempSync(join(tmpdir(), 'cmate-orch-l2-bad-'));
  const issuesPath = join(CASES_DIR, '01-independent', 'issues.json');
  const bad = [
    ['a bare glob in add', { derive: [{ when: 'app/{dir}{base}.rb', add: ['spec/**/*_spec.rb'] }] }],
    // The next two carry a real placeholder so that only the glob check can be
    // refusing them: a bare glob trips the "no placeholder" check as well, which
    // makes it useless for telling the two checks apart.
    ['a glob beside a placeholder in add', { derive: [{ when: 'app/{base}.rb', add: ['spec/**/{base}_spec.rb'] }] }],
    ['a glob in when', { derive: [{ when: 'app/*/{base}.rb', add: ['spec/{base}_spec.rb'] }] }],
    ['a constant add', { derive: [{ when: 'app/{base}.rb', add: ['docs/module-reference.md'] }] }],
    ['a when that binds nothing', { derive: [{ when: 'app/models.rb', add: ['spec/x_spec.rb'] }] }],
    ['an add placeholder its when does not bind', { derive: [{ when: 'app/{base}.rb', add: ['spec/{dir}{base}_spec.rb'] }] }],
    ['an unknown placeholder', { derive: [{ when: 'app/{Base}.rb', add: ['spec/{base}_spec.rb'] }] }],
    ['an unbalanced brace', { derive: [{ when: 'app/{base.rb', add: ['spec/{base}_spec.rb'] }] }],
    ['a repeated placeholder in when', { derive: [{ when: '{dir}{base}{dir}.rb', add: ['spec/{base}_spec.rb'] }] }],
    ['an escaping add', { derive: [{ when: 'app/{base}.rb', add: ['../{base}_spec.rb'] }] }],
    ['an absolute add', { derive: [{ when: 'app/{base}.rb', add: ['/etc/{base}'] }] }],
    ['an unknown top-level key', { rules: [] }],
    ['an unknown rule key', { derive: [{ when: 'app/{base}.rb', add: ['spec/{base}_spec.rb'], unless: 'x' }] }],
    ['an empty add', { derive: [{ when: 'app/{base}.rb', add: [] }] }],
    ['a list instead of an object', []],
  ];
  bad.forEach(([label, declaration], index) => {
    const profilePath = writeProfile(dir, `bad-${index}.json`, declaration);
    const result = runRunner(buildArgs(['100', '--profile-json', profilePath], issuesPath, join(dir, `runs-${index}`)));
    if (!check(result.exit === 6, `${label} should be refused with exit 6, exited ${result.exit}`)) return;
    const parsed = JSON.parse(result.stdout);
    check(parsed.plan === null, `${label}: a refused profile must not produce a plan`);
    check(
      parsed.errors.some((error) => error.code === 'load_error' && error.detail.includes('scope_companions')),
      `${label}: expected a load_error naming scope_companions, got ${JSON.stringify(parsed.errors)}`,
    );
  });

  // And the degenerate declaration is legal and inert: an EMPTY `derive` derives
  // what no declaration derives, which is what lets profile-init emit the key on
  // every draft without changing any plan's scope.
  const emptyPath = writeProfile(dir, 'empty.json', { derive: [] });
  const nonePath = writeProfile(dir, 'none.json', undefined);
  const [empty, none] = [emptyPath, nonePath].map((path, index) =>
    runRunner(buildArgs(['100', '--profile-json', path], issuesPath, join(dir, `ok-${index}`))));
  if (!check(empty.exit === 0 && none.exit === 0, 'an empty declaration and no declaration should both plan')) return;
  const strip = (result) => {
    const plan = JSON.parse(JSON.stringify(JSON.parse(result.stdout).plan));
    plan.run_id = null;
    plan.profile = null;
    plan.inputs.profile_id = null;
    return plan;
  };
  check(
    deepEqual(strip(empty), strip(none)),
    'an empty scope_companions changed the plan somewhere other than the echoed profile',
  );
}

// =============================================================================
// 裁定 A: an inference may stop the machine, never instruct it (Issue #145)
// =============================================================================
//
// adr-scope-derivation.md section 8 draws the line L3 must not cross: it writes
// ZERO bytes into the fields a machine consumes — `suspected_files` (which
// dispatch copies into scope.allow verbatim), `scope_defaults`, and
// `acceptance_gates` (which becomes the contract's `require`). Its only outputs
// are `warnings` and `questions`, which a human reads and which stop the run.
//
// A per-case expectation cannot see this: it pins what the fields ARE, not that
// they are UNAFFECTED. So the same issue is planned twice, differing only in the
// one criterion that trips the detector, and the two plans are compared field by
// field. Everything but the two human-facing channels — down to `run_id`, which
// hashes the issue bodies and therefore MUST differ — has to be identical. An
// implementation that "helpfully" added a `*.test.*` pattern to the scope, or a
// gate to the contract, on the strength of a sentence it read in prose would pass
// every case fixture in this suite and fail here.
function inferenceDoesNotInstructTest() {
  log('  an L3 inference stops the run without touching the contract fields (#145)');
  const dir = mkdtempSync(join(tmpdir(), 'cmate-orch-l3-'));
  const bodyFor = (criterion) =>
    '`scripts/verify-run.sh` の gate 判定が新しい GATE 行を読めていない。\n\n'
    + '## 対象ファイル\n- `scripts/verify-run.sh`\n\n'
    + `## Acceptance criteria\n- [ ] ${criterion}\n`;
  const plans = [
    // Fires: an active demand for a test, and `.sh` derives no test path.
    '新しい GATE 行を読む unit test を追加し、それが判定する',
    // Silent: the same issue asking for the same behaviour without a test.
    '新しい GATE 行が判定に反映される',
  ].map((criterion, index) => {
    const issuesPath = join(dir, `issues-${index}.json`);
    writeFileSync(issuesPath, JSON.stringify({
      issues: [{ number: 470, title: 'fix: verify-run の gate 判定を直す', body: bodyFor(criterion), labels: ['bug'] }],
    }));
    const result = runRunner(buildArgs(['470', '--profile', 'node-commandmate'], issuesPath, join(dir, `runs-${index}`)));
    return JSON.parse(result.stdout);
  });

  const [fired, silent] = plans;
  check(fired.status === 'partial', `the demanding body should plan as partial, got "${fired.status}"`);
  check(silent.status === 'success', `the neutral body should plan as a clean success, got "${silent.status}"`);
  check(
    warningCodesOf(fired).join() === 'acceptance_requires_tests_but_scope_has_none' && warningCodesOf(silent).length === 0,
    `warning codes ${JSON.stringify(warningCodesOf(fired))} / ${JSON.stringify(warningCodesOf(silent))} are not the expected fired/silent pair`,
  );

  const firedIssue = fired.plan.issues[0];
  const silentIssue = silent.plan.issues[0];
  check(firedIssue.questions.length === 1, `the firing plan should carry exactly one question, got ${firedIssue.questions.length}`);
  check(silentIssue.questions.length === 0, `the silent plan should carry no question, got ${silentIssue.questions.length}`);
  for (const field of ['suspected_files', 'scope_defaults', 'reference_files', 'acceptance_gates', 'test_expectations']) {
    check(
      deepEqual(firedIssue[field], silentIssue[field]),
      `L3 changed ${field}: ${JSON.stringify(firedIssue[field])} !== ${JSON.stringify(silentIssue[field])}`,
    );
  }
  // The rest of the plan, minus the channels the detector is allowed to write and
  // the identifiers that hash the issue body it read. `risk` is nulled for a
  // different reason: assessRisk has counted `questions.length` since Issue #52,
  // so a run whose only finding is a question has read "moderate" off the question
  // channel rather than out of anything L3 wrote — the same value
  // `no_acceptance_criteria` produces, and advisory either way.
  const machineFacing = (result) => {
    const plan = JSON.parse(JSON.stringify(result.plan));
    plan.run_id = null;
    plan.warnings = null;
    plan.risk = null;
    for (const issue of plan.issues) {
      issue.questions = null;
      // acceptance_criteria differs by construction: it holds the criterion that
      // was edited to make one body fire and the other not.
      issue.acceptance_criteria = null;
    }
    return plan;
  };
  check(
    deepEqual(machineFacing(fired), machineFacing(silent)),
    'L3 changed a machine-facing part of the plan outside warnings/questions',
  );
}

function main() {
  log('cmate-orchestrate fixture tests');
  selfTestValidator();

  log('  -- plan cases --');
  const caseIds = readdirSync(CASES_DIR).filter((name) => existsSync(join(CASES_DIR, name, 'case.json'))).sort();
  for (const caseId of caseIds) runCase(caseId);
  rerunSemanticsTest();

  log('  -- run id --');
  runIdCoversProfileTest();

  log('  -- dispatch cases --');
  const dispatchIds = existsSync(DISPATCH_CASES_DIR)
    ? readdirSync(DISPATCH_CASES_DIR).filter((name) => existsSync(join(DISPATCH_CASES_DIR, name, 'case.json'))).sort()
    : [];
  for (const caseId of dispatchIds) runDispatchCase(caseId);

  log('  -- resume cases --');
  const resumeIds = existsSync(RESUME_CASES_DIR)
    ? readdirSync(RESUME_CASES_DIR).filter((name) => existsSync(join(RESUME_CASES_DIR, name, 'case.json'))).sort()
    : [];
  for (const caseId of resumeIds) runResumeCase(caseId);

  log('  -- merge cases --');
  const mergeIds = existsSync(MERGE_CASES_DIR)
    ? readdirSync(MERGE_CASES_DIR).filter((name) => existsSync(join(MERGE_CASES_DIR, name, 'case.json'))).sort()
    : [];
  for (const caseId of mergeIds) runMergeCase(caseId);

  log('  -- uat cases --');
  const uatIds = existsSync(UAT_CASES_DIR)
    ? readdirSync(UAT_CASES_DIR).filter((name) => existsSync(join(UAT_CASES_DIR, name, 'case.json'))).sort()
    : [];
  for (const caseId of uatIds) runUatCase(caseId);

  log('  -- status cases --');
  const statusIds = existsSync(STATUS_CASES_DIR)
    ? readdirSync(STATUS_CASES_DIR).filter((name) => existsSync(join(STATUS_CASES_DIR, name, 'case.json'))).sort()
    : [];
  for (const caseId of statusIds) runStatusCase(caseId);
  log('  -- profile-init cases --');
  const profileInitIds = existsSync(PROFILE_INIT_CASES_DIR)
    ? readdirSync(PROFILE_INIT_CASES_DIR).filter((name) => existsSync(join(PROFILE_INIT_CASES_DIR, name, 'case.json'))).sort()
    : [];
  for (const caseId of profileInitIds) runProfileInitCase(caseId);
  profileInitInputTest();

  log('  -- contract parity --');
  parityTest();

  log('  -- launcher resolution --');
  launcherTest();

  log('  -- worktree-setup input --');
  worktreeSetupInputTest();

  log('  -- reverify input --');
  reverifyInputTest();

  log('  -- auto-yes arming --');
  autoYesWindowTest();

  log('  -- unattended --');
  unattendedInputTest();
  unattendedLockTest();
  unattendedMergeTest();

  log('  -- unattended stage C --');
  unattendedGatesTest();
  unattendedMergePrsTest();
  unattendedUatTest();

  log('  -- scope derivation --');
  testCompanionDeterminismTest();
  testCompanionBoundTest();
  inferenceDoesNotInstructTest();
  profileCompanionDeterminismTest();
  profileCompanionBoundTest();
  profileCompanionRejectionTest();

  log('');
  if (failures > 0) {
    log(`FAILED: ${failures} assertion(s) did not pass`);
    process.exit(1);
  }
  log(`PASSED: ${caseIds.length} plan cases, ${dispatchIds.length} dispatch cases, ${resumeIds.length} resume/reverify cases, ${mergeIds.length} merge cases, ${uatIds.length} uat cases, ${statusIds.length} status cases, ${profileInitIds.length} profile-init cases, run id vs profile, contract parity, launcher resolution, worktree-setup input, reverify input, auto-yes arming, unattended input + exclusivity + merge, unattended stage C (gates + merge-prs + uat)`);
}

main();
