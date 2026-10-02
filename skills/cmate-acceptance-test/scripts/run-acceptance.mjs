// cmate-acceptance-test runner: executes one command per acceptance criterion
// and writes an acceptance-result.v1 document (commandmate-skills#299).
//
//   node skills/cmate-acceptance-test/scripts/run-acceptance.mjs \
//     --plan <plan.json> --out <result.json> [--cwd <target worktree>]
//
// Why it exists: an agent that wrote its own judging script read `node --test`
// output wrongly (it looked for TAP's `# pass 28` while the default spec
// reporter prints `ℹ pass 28`) and called a 28/28, exit-0 run NO-GO. This
// runner judges each command by its EXIT CODE only. Test counts are picked up
// from spec (`ℹ tests N`) and TAP (`# tests N`) output when present and are
// recorded as reference text in the evidence summary; they never decide an
// outcome, and their absence changes nothing.
//
// status and verdict follow references/verdict-rubric.md §2/§3 as written; the
// runner adds no rule of its own. Node standard library only, no executable bit:
// invoke it through `node`.
//
// Exit codes: 0 the result document was written (whatever the verdict),
// 2 usage error or the document could not be written.
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ID = 'cmate-acceptance-test';
export const SKILL_VERSION = '0.3.0';

// Bytes of the combined stdout/stderr tail kept in output_excerpt. The schema
// allows 4000 characters; the tail is where test runners print their totals
// and their first failure, which is what a reader needs.
export const OUTPUT_TAIL_MAX = 3000;
export const DEFAULT_TIMEOUT_SEC = 600;
const MAX_ATTEMPTS = 5;
const UNRESOLVED = new Set(['flaky', 'blocked', 'not_run', 'manual_pending', 'not_verifiable']);

// ---------------------------------------------------------------------------
// Judgement
// ---------------------------------------------------------------------------

// One attempt's outcome. The exit code is the primary evidence; counts are
// passed in only so that the reference text can be built from the same place.
export function attemptOutcome(exitCode, _counts) {
  if (exitCode === null) return 'not_run';
  return exitCode === 0 ? 'pass' : 'fail';
}

// Several attempts of the same command: differing exit codes are flaky, never
// the successful attempt (verdict-rubric §1).
export function combineAttempts(outcomes) {
  const distinct = new Set(outcomes);
  if (distinct.size === 1) return outcomes[0];
  return 'flaky';
}

// Test counts from `node --test` (and anything else printing the same lines),
// spec or TAP. Reference information only. Returns null when nothing is found.
export function parseTestCounts(text) {
  const clean = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  const keys = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const found = {};
  let format = null;
  for (const line of clean.split(/\r?\n/)) {
    const spec = /^\s*ℹ\s+([a-z]+)\s+(\d+)\s*$/.exec(line);
    const tap = /^\s*#\s+([a-z]+)\s+(\d+)\s*$/.exec(line);
    const m = spec || tap;
    if (!m || !keys.includes(m[1])) continue;
    found[m[1]] = Number(m[2]);
    format = spec ? 'spec' : 'tap';
  }
  if (!('tests' in found) && !('pass' in found) && !('fail' in found)) return null;
  return { format, ...found };
}

export function describeCounts(counts) {
  if (!counts) return null;
  const parts = ['tests', 'pass', 'fail', 'skipped', 'todo', 'cancelled']
    .filter((k) => k in counts)
    .map((k) => `${k} ${counts[k]}`);
  return `件数 (参考, ${counts.format}): ${parts.join(' / ')}`;
}

// verdict-rubric §2: status.
export function deriveStatus(criteria, failed) {
  if (failed) return 'failure';
  if (criteria.some((c) => c.outcome !== 'pass' && c.outcome !== 'fail')) return 'partial';
  return 'success';
}

// verdict-rubric §3: verdict, rows evaluated top to bottom.
export function deriveVerdict(status, criteria, nextActions) {
  if (status === 'failure') return 'no_go';
  if (criteria.some((c) => c.outcome === 'fail')) return 'no_go';
  if (status === 'success') return 'go';
  const covered = new Set(
    nextActions.filter((a) => String(a.owner || '').trim()).flatMap((a) => a.criterion_ids || []),
  );
  const unresolved = criteria.filter((c) => UNRESOLVED.has(c.outcome));
  if (unresolved.every((c) => covered.has(c.id))) return 'conditional_go';
  return 'no_go';
}

// ---------------------------------------------------------------------------
// Redaction (references/evidence.md §3)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'token'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'token'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, 'api-key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'api-key'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/g, 'token'],
  [/\b((?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|PRIVATE_KEY))\s*[=:]\s*)(?!<redacted:)[^\s'"]+/g, 'env-value'],
];

export function redact(text, roots) {
  let out = String(text);
  let changed = false;
  for (const [pattern, kind] of SECRET_PATTERNS) {
    out = out.replace(pattern, (...m) => {
      changed = true;
      const prefix = typeof m[1] === 'string' && m.length > 3 ? m[1] : '';
      return `${prefix}<redacted:${kind}>`;
    });
  }
  for (const [root, replacement] of roots) {
    if (root && root.length > 1 && out.includes(root)) {
      out = out.split(root).join(replacement);
      changed = true;
    }
  }
  return { text: out, changed };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function readTail(file, max) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    // Read a little more than max bytes so a cut multi-byte char can be dropped.
    const want = Math.min(size, max * 4);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    const text = buf.toString('utf8').replace(/^�+/, '');
    const chars = [...text];
    const truncated = size > want || chars.length > max;
    return { tail: chars.slice(-max).join(''), truncated };
  } finally {
    fs.closeSync(fd);
  }
}

// Runs `command` once through /bin/sh, stdout and stderr interleaved into one
// temporary file. Returns the measured exit code (null when killed/timed out).
export function runOnce(command, { cwd, timeoutSec }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmate-acceptance-'));
  const logFile = path.join(dir, 'output.log');
  const fd = fs.openSync(logFile, 'w');
  const env = { ...process.env };
  // A nested `node --test` changes its reporting when it believes it is a
  // child of another test run.
  delete env.NODE_TEST_CONTEXT;
  const started = process.hrtime.bigint();
  let res;
  try {
    res = spawnSync('/bin/sh', ['-c', command], {
      cwd,
      env,
      stdio: ['ignore', fd, fd],
      timeout: timeoutSec * 1000,
      killSignal: 'SIGKILL',
    });
  } finally {
    fs.closeSync(fd);
  }
  const durationMs = Number((process.hrtime.bigint() - started) / 1000000n);
  try {
    const full = fs.readFileSync(logFile, 'utf8');
    const { tail, truncated } = readTail(logFile, OUTPUT_TAIL_MAX);
    let exitCode = typeof res.status === 'number' ? res.status : null;
    let note = null;
    if (res.error && res.error.code === 'ETIMEDOUT') note = `timed out after ${timeoutSec}s`;
    else if (res.error) note = `could not start: ${res.error.code || res.error.message}`;
    else if (res.signal) note = `killed by ${res.signal}`;
    if (note) exitCode = null;
    return { exitCode, durationMs, full, tail, truncated, note, spawnFailed: Boolean(res.error && res.error.code !== 'ETIMEDOUT') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Plan -> result document
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function clip(text, max) {
  const chars = [...String(text)];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function gitValue(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function resolveTarget(plan, cwd, limitations) {
  const given = plan.target || {};
  const commit = given.commit !== undefined ? given.commit : gitValue(cwd, ['rev-parse', 'HEAD']);
  const branch = given.branch !== undefined ? given.branch : gitValue(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  let dirty = given.dirty;
  if (dirty === undefined) {
    const porcelain = gitValue(cwd, ['status', '--porcelain']);
    dirty = porcelain === null ? null : porcelain.length > 0;
  }
  let repository = given.repository === undefined ? null : given.repository;
  if (repository !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)) {
    limitations.push(`target.repository ${clip(JSON.stringify(repository), 80)} is not owner/repo; recorded as null`);
    repository = null;
  }
  const target = {
    issue_ref: typeof plan.issue_ref === 'string' && plan.issue_ref.trim() ? clip(plan.issue_ref.trim(), 200) : 'unspecified',
    issue_title: typeof plan.issue_title === 'string' ? clip(plan.issue_title, 300) : null,
    repository,
    branch: typeof branch === 'string' && branch ? clip(branch, 200) : null,
    commit: typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    dirty: typeof dirty === 'boolean' ? dirty : null,
  };
  return target;
}

export function planProblems(plan) {
  const out = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return ['plan is not a JSON object'];
  if (typeof plan.issue_ref !== 'string' || !plan.issue_ref.trim()) out.push('入力 issue_ref が無い');
  if (!Array.isArray(plan.criteria) || plan.criteria.length === 0) out.push('受入条件が 0 件');
  else if (plan.criteria.length > 99) out.push('受入条件が 99 件を超える');
  else {
    plan.criteria.forEach((c, i) => {
      const at = `criteria[${i}]`;
      if (!c || typeof c !== 'object') { out.push(`${at} is not an object`); return; }
      if (typeof c.text !== 'string' || !c.text.trim()) out.push(`${at}.text が無い`);
      if (c.id !== undefined && !/^AC-[0-9]{2}[a-z]?$/.test(c.id)) out.push(`${at}.id は AC-NN 形式でない`);
      if (c.command !== undefined && (typeof c.command !== 'string' || !c.command.trim())) out.push(`${at}.command が空`);
      if (c.risk_tier !== undefined && !['safe', 'confirm_required', 'blocked'].includes(c.risk_tier)) out.push(`${at}.risk_tier が不正`);
      if (c.attempts !== undefined && !(Number.isInteger(c.attempts) && c.attempts >= 1 && c.attempts <= MAX_ATTEMPTS)) out.push(`${at}.attempts は 1..${MAX_ATTEMPTS}`);
      if (c.risk_tier === 'confirm_required' && (!c.confirmation || typeof c.confirmation.cleanup_plan !== 'string' || !c.confirmation.cleanup_plan.trim())) {
        out.push(`${at} は confirm_required だが confirmation.cleanup_plan が無い`);
      }
    });
    const ids = plan.criteria.map((c, i) => (c && c.id) || `AC-${pad2(i + 1)}`);
    if (new Set(ids).size !== ids.length) out.push('criteria の id が重複している');
  }
  return out;
}

export function buildResult(plan, { cwd, now = utcNow, exec = runOnce } = {}) {
  const limitations = [];
  const problems = planProblems(plan);
  let realCwd = cwd;
  try {
    realCwd = fs.realpathSync(cwd);
    if (!fs.statSync(realCwd).isDirectory()) throw new Error('not a directory');
  } catch {
    problems.push('対象 directory (--cwd) が存在しない');
  }
  const roots = [[cwd, '.'], [realCwd, '.'], [os.homedir(), '<redacted:home>']];
  const safePlan = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : {};
  const invocation = safePlan.environment && safePlan.environment.invocation === 'interactive' ? 'interactive' : 'non_interactive';
  const doc = {
    result_schema_version: 1,
    skill: { id: SKILL_ID, version: SKILL_VERSION },
    generated_at: now(),
    status: 'failure',
    verdict: 'no_go',
    verdict_reason: '',
    target: resolveTarget(safePlan, cwd, limitations),
    environment: {
      agent: clip((safePlan.environment && safePlan.environment.agent) || 'unknown', 60),
      agent_version: safePlan.environment && typeof safePlan.environment.agent_version === 'string' ? clip(safePlan.environment.agent_version, 60) : null,
      invocation,
    },
    criteria: [],
    checks: [],
    confirmations: [],
    evidence: [],
    next_actions: [],
    blocking_reasons: [],
    limitations,
  };

  if (problems.length) {
    doc.blocking_reasons = problems.map((p) => clip(p, 300));
    doc.verdict_reason = clip(`検証を実行できなかった: ${problems[0]}`, 300);
    return doc;
  }

  plan.criteria.forEach((c, i) => {
    const n = pad2(i + 1);
    const id = c.id || `AC-${n}`;
    const checkId = `CK-${n}`;
    const tier = c.risk_tier || 'safe';
    const criterion = {
      id,
      text: clip(c.text, 500),
      classification: c.command ? 'automated' : 'manual',
      risk_tier: tier,
      outcome: 'not_run',
      evidence_ids: [],
      notes: '',
    };
    const check = {
      id: checkId,
      kind: c.command ? (c.kind === 'test' ? 'test' : 'command') : 'manual_observation',
      description: clip(c.command ? redact(c.command, roots).text : `手動確認: ${c.text}`, 300),
      criterion_ids: [id],
      risk_tier: tier,
      executed: false,
      skip_reason: null,
      evidence_ids: [],
    };
    if (tier === 'confirm_required') {
      const conf = c.confirmation;
      doc.confirmations.push({
        check_id: checkId,
        risk_tier: tier,
        requested: invocation === 'interactive',
        granted: invocation === 'interactive' && typeof conf.granted === 'boolean' ? conf.granted : null,
        cleanup_plan: clip(conf.cleanup_plan, 1000),
      });
    }

    let skip = null;
    if (!c.command) {
      criterion.outcome = 'manual_pending';
      skip = '手動確認が未実施（runner は command の無い受入条件を実行しない）';
    } else if (tier === 'blocked') {
      criterion.outcome = 'blocked';
      skip = 'risk_tier が blocked のため実行しない';
    } else if (tier === 'confirm_required' && invocation !== 'interactive') {
      skip = '非対話実行のため confirm_required の check を実行しない';
    } else if (tier === 'confirm_required' && c.confirmation.granted !== true) {
      skip = '承認が得られなかった (risk: confirm_required)';
    }

    if (skip) {
      check.skip_reason = skip;
      criterion.notes = clip(c.notes ? `${skip}。${c.notes}` : skip, 500);
    } else {
      const attempts = c.attempts || 1;
      const timeoutSec = Number.isFinite(c.timeout_sec) && c.timeout_sec > 0 ? c.timeout_sec : DEFAULT_TIMEOUT_SEC;
      const runs = [];
      for (let k = 0; k < attempts; k += 1) runs.push(exec(c.command, { cwd, timeoutSec }));
      const last = runs[runs.length - 1];
      const counts = parseTestCounts(last.full);
      const outcomes = runs.map((r) => attemptOutcome(r.exitCode, counts));
      let outcome = combineAttempts(outcomes);
      if (runs.every((r) => r.spawnFailed)) outcome = 'blocked';

      const evId = `EV-${n}`;
      const cmd = redact(c.command, roots);
      const tail = redact(last.tail, roots);
      const codes = runs.map((r) => (r.exitCode === null ? 'null' : String(r.exitCode)));
      const countText = describeCounts(counts);
      const summaryParts = [`${clip(cmd.text, 200)} → exit ${codes.join(', ')}`];
      if (last.note) summaryParts.push(last.note);
      if (countText) summaryParts.push(countText);
      const evidence = {
        id: evId,
        type: 'command',
        collected_at: now(),
        summary: clip(summaryParts.join('。'), 500),
        redacted: cmd.changed || tail.changed,
        path: null,
        command: clip(cmd.text, 500),
        exit_code: last.exitCode,
        duration_ms: runs.reduce((s, r) => s + r.durationMs, 0),
        output_excerpt: tail.text,
        truncated: last.truncated,
      };
      if (attempts > 1) evidence.attempts = runs.map((r, k) => ({ attempt: k + 1, exit_code: r.exitCode }));
      doc.evidence.push(evidence);
      check.executed = true;
      check.evidence_ids = [evId];
      criterion.evidence_ids = [evId];
      criterion.outcome = outcome;

      const why = {
        pass: `exit code 0 のため pass（合否は exit code で判定。件数は参考）`,
        fail: `exit code ${codes[codes.length - 1]} のため fail（合否は exit code で判定）`,
        flaky: `${attempts} 回の試行で exit code が一致しない (${codes.join(', ')}) ため flaky`,
        not_run: `exit code を取得できなかった (${last.note}) ため not_run`,
        blocked: `command を起動できなかった (${last.note}) ため blocked`,
      }[outcome];
      let notes = why;
      if (counts && outcome === 'pass' && (counts.fail || 0) > 0) notes += `。件数行は fail ${counts.fail} を示すが判定には使わない`;
      if (c.notes) notes += `。${c.notes}`;
      criterion.notes = clip(notes, 500);
    }

    if (UNRESOLVED.has(criterion.outcome) && c.next_action && typeof c.next_action === 'object') {
      const action = String(c.next_action.action || '').trim();
      const owner = String(c.next_action.owner || '').trim();
      if (action && owner) doc.next_actions.push({ action: clip(action, 300), owner: clip(owner, 100), criterion_ids: [id] });
    }
    doc.criteria.push(criterion);
    doc.checks.push(check);
  });

  doc.status = deriveStatus(doc.criteria, false);
  doc.verdict = deriveVerdict(doc.status, doc.criteria, doc.next_actions);

  const failed = doc.criteria.filter((c) => c.outcome === 'fail').map((c) => c.id);
  const unresolved = doc.criteria.filter((c) => UNRESOLVED.has(c.outcome));
  const covered = new Set(doc.next_actions.flatMap((a) => a.criterion_ids));
  if (failed.length) doc.blocking_reasons.push(clip(`fail の受入条件がある: ${failed.join(', ')}`, 300));
  const orphan = unresolved.filter((c) => !covered.has(c.id)).map((c) => c.id);
  if (doc.verdict === 'no_go' && orphan.length) {
    doc.blocking_reasons.push(clip(`未確定で次 action と担当が無い受入条件がある: ${orphan.join(', ')}`, 300));
  }
  const passCount = doc.criteria.filter((c) => c.outcome === 'pass').length;
  doc.verdict_reason = clip(
    {
      go: `全 ${doc.criteria.length} 件の受入条件が exit code 0 で pass`,
      conditional_go: `pass ${passCount}/${doc.criteria.length}。未確定 ${unresolved.map((c) => c.id).join(', ')} は次 action と担当つき`,
      no_go: doc.blocking_reasons[0] || 'no_go',
    }[doc.verdict],
    300,
  );
  return doc;
}

// verdict-rubric §5, in that order.
export function renderSummary(doc, resultPath) {
  const label = { go: 'GO', conditional_go: 'CONDITIONAL GO', no_go: 'NO-GO' }[doc.verdict];
  const t = doc.target;
  const lines = [];
  lines.push(`受入テスト結果: ${label}`);
  lines.push(`理由: ${doc.verdict_reason}`);
  lines.push('');
  lines.push('対象');
  lines.push(`  Issue      ${t.issue_ref}${t.issue_title ? ` ${t.issue_title}` : ''}`);
  lines.push(`  repository ${t.repository || '(不明)'}`);
  lines.push(`  branch     ${t.branch || '(不明)'} @ ${t.commit ? t.commit.slice(0, 7) : '(不明)'}${t.dirty ? ', 未 commit の変更あり' : ''}`);
  lines.push(`  実行        ${doc.environment.agent} ${doc.environment.agent_version || '(version 不明)'} / ${doc.generated_at}`);
  lines.push('');
  const passCount = doc.criteria.filter((c) => c.outcome === 'pass').length;
  lines.push(`受入条件 (${passCount}/${doc.criteria.length} 検証済み)`);
  const tag = { pass: 'PASS', fail: 'FAIL', flaky: 'FLAKY', blocked: 'BLOCKED', not_run: 'NOT RUN', manual_pending: 'PENDING', not_verifiable: 'N/V' };
  for (const c of doc.criteria) {
    const ev = c.evidence_ids.length ? `  evidence: ${c.evidence_ids.join(', ')}` : ` — ${c.notes}`;
    lines.push(`  [${tag[c.outcome]}] ${c.id} ${clip(c.text, 60)}${ev}`);
  }
  lines.push('');
  const evById = new Map(doc.evidence.map((e) => [e.id, e]));
  lines.push('実行した check');
  const ran = doc.checks.filter((k) => k.executed);
  if (!ran.length) lines.push('  (なし)');
  for (const k of ran) {
    const e = evById.get(k.evidence_ids[0]);
    lines.push(`  - ${k.description} → exit ${e.exit_code === null ? 'null' : e.exit_code}`);
  }
  lines.push('');
  lines.push('実行しなかった check');
  const skipped = doc.checks.filter((k) => !k.executed);
  if (!skipped.length) lines.push('  (なし)');
  for (const k of skipped) lines.push(`  - ${k.description} — ${k.skip_reason}`);
  lines.push('');
  lines.push('次 action');
  if (!doc.next_actions.length) lines.push('  (なし)');
  doc.next_actions.forEach((a, i) => lines.push(`  ${i + 1}. ${a.action} — 担当: ${a.owner}`));
  if (doc.blocking_reasons.length) {
    lines.push('');
    lines.push('blocking');
    for (const b of doc.blocking_reasons) lines.push(`  - ${b}`);
  }
  lines.push('');
  lines.push(`evidence: result に埋め込み  (result: ${resultPath})`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--plan' || a === '--out' || a === '--cwd') {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      args[a.slice(2)] = argv[(i += 1)];
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

const USAGE = 'usage: node run-acceptance.mjs --plan <plan.json> --out <result.json> [--cwd <dir>]';

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!args.plan || !args.out) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  let plan;
  let planError = null;
  try {
    plan = JSON.parse(fs.readFileSync(args.plan, 'utf8'));
  } catch (err) {
    planError = `plan を読めない: ${err.code || err.name}`;
    plan = {};
  }
  const doc = buildResult(plan, { cwd });
  if (planError) {
    doc.blocking_reasons.unshift(planError);
    doc.verdict_reason = clip(`検証を実行できなかった: ${planError}`, 300);
  }
  const shownOut = redact(args.out, [[cwd, '.'], [os.homedir(), '<redacted:home>']]).text;
  const summary = renderSummary(doc, shownOut);
  doc.summary_text = clip(summary, 20000);
  process.stdout.write(`${summary}\n`);
  try {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(doc, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`result document を書けなかった: ${err.code || err.message}\n`);
    return 2;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
