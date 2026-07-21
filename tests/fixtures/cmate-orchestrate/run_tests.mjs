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
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const RUNNER = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'scripts', 'orchestrate.mjs');
const SCHEMA_DIR = join(REPO_ROOT, 'skills', 'cmate-orchestrate', 'schemas');
const CASES_DIR = join(HERE, 'cases');
const PROFILES_DIR = join(HERE, 'profiles');

const planSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'execution-plan.v1.json'), 'utf8'));
const resultSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'orchestrate-result.v1.json'), 'utf8'));

let failures = 0;
const log = (line) => process.stdout.write(`${line}\n`);

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

function runRunner(args) {
  try {
    const stdout = execFileSync('node', [RUNNER, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { exit: 0, stdout };
  } catch (error) {
    // execFileSync throws on a non-zero exit; the result JSON is still on stdout.
    return { exit: error.status ?? 1, stdout: error.stdout ? error.stdout.toString() : '' };
  }
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
  const args = buildArgs(spec.args, issuesPath, runsDir);
  const { exit, stdout } = runRunner(args);

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

  // Determinism: a second run into a fresh directory yields the same plan.
  const runsDir2 = mkdtempSync(join(tmpdir(), 'cmate-orch-'));
  const second = runRunner(buildArgs(spec.args, issuesPath, runsDir2));
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
// Self-test of the validator: it must reject a broken plan, not wave it through.
// =============================================================================

function selfTestValidator() {
  log('  validator self-test');
  const broken = { plan_schema_version: 2 };
  check(validateAgainst(planSchema, broken, 'broken').length > 0, 'validator accepted a broken plan');

  const good = JSON.parse(readFileSync(join(CASES_DIR, '01-independent', 'issues.json'), 'utf8'));
  check(Array.isArray(good.issues), 'fixture 01 is malformed'); // sanity anchor
}

function main() {
  log('cmate-orchestrate fixture tests');
  selfTestValidator();
  const caseIds = readdirSync(CASES_DIR).filter((name) => existsSync(join(CASES_DIR, name, 'case.json'))).sort();
  for (const caseId of caseIds) runCase(caseId);
  log('');
  if (failures > 0) {
    log(`FAILED: ${failures} assertion(s) did not pass`);
    process.exit(1);
  }
  log(`PASSED: ${caseIds.length} cases`);
}

main();
