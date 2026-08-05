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

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const RUNNER = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'scripts', 'orchestrate.mjs');
const DISPATCH_RUNNER = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'scripts', 'dispatch.mjs');
const MERGE_RUNNER = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'scripts', 'merge.mjs');
const UAT_RUNNER = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'scripts', 'uat.mjs');
const SCHEMA_DIR = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'schemas');
const CASES_DIR = join(HERE, 'cases');
const DISPATCH_CASES_DIR = join(HERE, 'dispatch-cases');
const MERGE_CASES_DIR = join(HERE, 'merge-cases');
const UAT_CASES_DIR = join(HERE, 'uat-cases');
const PROFILES_DIR = join(HERE, 'profiles');
const FAKE_CLI = join(HERE, 'fake-cli.mjs');
// The dispatch/merge/uat runners execute the profile baseline INSIDE each
// worktree as the verification/UAT signal (there is no `commandmate verify|uat`).
// This profile's baseline is `cat cmate-verify-ok`, so a worktree "passes" iff it
// holds that marker file — which the harness (dispatch worktrees) and the fake CLI
// (fix worktrees) create for the workers a scenario says should pass.
const NODE_FAKE_PROFILE = join(PROFILES_DIR, 'node-fake.json');
const CLI_CONTRACT_PATH = join(HERE, 'commandmate-cli-contract.json');

const planSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'execution-plan.v1.json'), 'utf8'));
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

// The `ls --json` rows the runner resolves worktree ids from, one per plan issue.
function planToWorktrees(plan, pathOverrides = {}) {
  return plan.issues.map((issue) => ({
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
function setupWorktrees(plan, work, markerFor, pathOverrides = {}) {
  const integration = join(work, 'integration');
  mkdirSync(integration, { recursive: true });
  for (const issue of plan.issues) {
    const dir = join(work, basename(registeredPathFor(issue, pathOverrides)));
    mkdirSync(dir, { recursive: true });
    if (markerFor(issue.number)) writeFileSync(join(dir, 'cmate-verify-ok'), 'ok');
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
function runDispatchRunner(planPath, scenarioObject, work, outDir, extraArgs, logPath) {
  const plan = readPlan(planPath);
  const pathOverrides = scenarioObject.worktree_paths ?? {};
  const scenario = { ...scenarioObject, worktrees: planToWorktrees(plan, pathOverrides) };
  const integration = setupWorktrees(plan, work, (n) => workerVerifyPasses(scenario, n), pathOverrides);
  const scenarioPath = join(work, 'dispatch-scenario.json');
  writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  const env = { ...process.env, CMATE_FAKE_SCENARIO: scenarioPath, CMATE_FAKE_STATE: work };
  if (logPath) env.CMATE_FAKE_LOG = logPath;
  const args = [
    DISPATCH_RUNNER,
    '--plan', planPath,
    '--cli', FAKE_CLI, '--git', FAKE_CLI, '--gh', FAKE_CLI,
    '--out', outDir,
    ...extraArgs,
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

function runRunner(args, cwd) {
  try {
    const stdout = execFileSync('node', [RUNNER, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd });
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
  args.push('--profile-json', NODE_FAKE_PROFILE, '--issue-json', issuesPath, '--runs-dir', runsDir);
  runRunner(args); // exit code is irrelevant here; a partial plan is still a plan
  // The run id is pinned to "plan" by every dispatch case's orchestrate_args.
  return join(runsDir, 'plan', 'plan.json');
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

  // max_parallel is never exceeded in any dispatched wave — the core guarantee.
  check(report.waves.every((wave) => wave.dispatched.length <= report.max_parallel), `a wave dispatched more than max_parallel ${report.max_parallel}`);
  if (expect.max_dispatched_per_wave !== undefined) {
    check(report.waves.every((wave) => wave.dispatched.length <= expect.max_dispatched_per_wave), `a wave dispatched more than ${expect.max_dispatched_per_wave}`);
  }

  const cliLog = readCliLog(logPath);
  const sent = sentIssuesFromLog(cliLog);
  const respondCount = cliLog.filter((entry) => entry.sub === 'respond').length;

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
  // Per-issue worker_state: a worker that never commits within --max-turns is
  // recorded as failed (an honest non-completion), never as completed.
  if (expect.worker_states) {
    for (const [num, state] of Object.entries(expect.worker_states)) {
      const worker = allWorkers(report).find((w) => w.issue === Number(num));
      check(worker !== undefined, `#${num} has no worker record`);
      if (worker) check(worker.worker_state === state, `#${num} worker_state "${worker.worker_state}" !== "${state}"`);
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
  for (const code of expect.blocking_codes ?? []) {
    check(report.blocking_reasons.some((entry) => entry.code === code), `blocking reason "${code}" was expected but not recorded`);
  }
  for (const code of expect.absent_blocking_codes ?? []) {
    check(!report.blocking_reasons.some((entry) => entry.code === code), `blocking reason "${code}" should be absent but was recorded`);
  }

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

function runMerge(planPath, dispatchPath, outDir, phaseFlag, extraArgs, env) {
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
    const stdout = execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
    return { exit: 0, stdout };
  } catch (error) {
    return { exit: error.status ?? 1, stdout: error.stdout ? error.stdout.toString() : '' };
  }
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

  const mergeOut = join(work, 'merge'); // must not pre-exist; merge creates it
  const logPath = join(work, 'gh.log');
  const scenarioPath = writeScenario(work, 'merge-scenario.json', spec.merge_scenario ?? {});
  const env = { ...process.env, CMATE_FAKE_SCENARIO: scenarioPath, CMATE_FAKE_LOG: logPath };

  const phaseFlag = spec.phase === 'merge-prs' ? '--merge-prs' : '--create-prs';
  const { exit, stdout } = runMerge(planPath, dispatchPath, mergeOut, phaseFlag, spec.merge_args ?? [], env);

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
    const bodyPath = join(mergeOut, 'pr-bodies', `issue-${report.eligible_issues[0]}.md`);
    if (check(existsSync(bodyPath), `PR body ${bodyPath} was not written`)) {
      const body = readFileSync(bodyPath, 'utf8');
      for (const needle of expect.pr_body_contains ?? []) {
        check(body.includes(needle), `PR body does not mention "${needle}"`);
      }
      for (const needle of expect.pr_body_absent ?? []) {
        check(!body.includes(needle), `PR body should not mention "${needle}"`);
      }
    }
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

function runUatRunner(planPath, dispatchPath, outDir, phaseFlag, extraArgs, env, cwd) {
  const args = [
    UAT_RUNNER,
    '--plan', planPath,
    '--dispatch', dispatchPath,
    phaseFlag,
    '--cli', FAKE_CLI, '--git', FAKE_CLI, '--gh', FAKE_CLI,
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
  const env = { ...process.env, CMATE_FAKE_SCENARIO: scenarioPath, CMATE_FAKE_LOG: logPath, CMATE_FAKE_STATE: workUat };

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

const COMMANDMATE_SUBS = ['ls', 'send', 'wait', 'capture', 'respond', 'verify'];

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
    }
  }
}

function parityTest() {
  log('  contract parity (commandmate CLI surface)');
  const contract = JSON.parse(readFileSync(CLI_CONTRACT_PATH, 'utf8'));
  const subs = contract.subcommands ?? {};
  check(COMMANDMATE_SUBS.every((s) => subs[s]), 'the CLI contract is missing a commandmate subcommand the runners use');

  // (B) Runner ⊆ contract. Two runs are needed to reach the whole surface:
  //   1. a legacy --auto-yes prompt run: ls -> send -> wait (prompt) -> capture
  //      -> respond -> wait;
  //   2. a contract run whose verdict is 20: send --help / wait --help (the
  //      version gate) -> send --contract -> wait --verify -> verify --json.
  // Both logs are unioned, so a flag that only the contract path uses is still
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

  const calls = [...readCliLog(logPath), ...readCliLog(contractLog)].filter((entry) => COMMANDMATE_SUBS.includes(entry.sub));
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

function main() {
  log('cmate-orchestrate fixture tests');
  selfTestValidator();

  log('  -- plan cases --');
  const caseIds = readdirSync(CASES_DIR).filter((name) => existsSync(join(CASES_DIR, name, 'case.json'))).sort();
  for (const caseId of caseIds) runCase(caseId);
  rerunSemanticsTest();

  log('  -- dispatch cases --');
  const dispatchIds = existsSync(DISPATCH_CASES_DIR)
    ? readdirSync(DISPATCH_CASES_DIR).filter((name) => existsSync(join(DISPATCH_CASES_DIR, name, 'case.json'))).sort()
    : [];
  for (const caseId of dispatchIds) runDispatchCase(caseId);

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

  log('  -- contract parity --');
  parityTest();

  log('');
  if (failures > 0) {
    log(`FAILED: ${failures} assertion(s) did not pass`);
    process.exit(1);
  }
  log(`PASSED: ${caseIds.length} plan cases, ${dispatchIds.length} dispatch cases, ${mergeIds.length} merge cases, ${uatIds.length} uat cases, contract parity`);
}

main();
