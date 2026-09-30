// cmate-worktree-cleanup runner library.
//
// Implements references/proof-algorithm.md and references/safety.md as code, so
// the decision "may this worktree be deleted" is the same no matter which agent
// (or which hand-written inspection script) asks. The CLI is scripts/cleanup.mjs;
// its flags, output and exit codes are defined in references/runner-contract.md.
//
// Nothing here deletes anything. The two destructive calls (git worktree remove
// without --force, and git branch -d / git update-ref -d <ref> <old-oid>) live in
// applyPlan() and run only for confirmed candidates that survived the drift
// re-check.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SKILL_ID = 'cmate-worktree-cleanup';
export const SKILL_VERSION = '0.1.6';

// Condition 4 of merged_equivalent (CommandMate#3010). When true, a `+` line in
// `git cherry` does not veto the proof by itself: the net diff from the merge
// base to the tip being byte-identical to the diff the squash commit introduced
// is sufficient (together with conditions 1-3). A branch that took a BEHIND
// round-trip (`git merge origin/main`, then squash) always has `+` lines, so
// turning this off makes every such branch tree_mismatch again. The fixture
// suite flips it to prove it is load-bearing.
export const NET_DIFF_SUFFICIENT = true;

// The exact diff form both sides are rendered with, then compared byte for byte.
// Each flag removes a configuration that could make two identical changes
// render differently (external diff, textconv, colour, abbreviated blob ids,
// rename pairing).
export const DIFF_ARGS = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', '--full-index', '--no-renames'];

// Reasons that mean "could not be proven" (status partial), as opposed to
// "kept on purpose" (dirty, detached, locked, missing, excluded, not confirmed).
export const UNVERIFIABLE_REASONS = new Set([
  'unverifiable', 'unmerged', 'fetch_failed', 'github_data_missing', 'no_merged_pr', 'multiple_prs',
  'head_oid_drift', 'merge_commit_unreachable', 'tree_mismatch', 'command_failed',
]);

const OID_RE = /^[0-9a-f]{40}$/;
const PROFILE_ALIASES = { node: 'node', commandmate: 'node', rust: 'rust', commandagent: 'rust' };

export function nowIso(override) {
  if (override) return override;
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Run a command without a shell. Returns { code, stdout, stderr } with stdout as
// a string, or as a Buffer when `binary` is set (diffs are compared as bytes).
export function run(cmd, args, { cwd, binary = false, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: env || process.env,
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.error) return { code: -1, stdout: binary ? Buffer.alloc(0) : '', stderr: String(r.error.message || r.error) };
  return { code: r.status === null ? -1 : r.status, stdout: r.stdout, stderr: String(r.stderr || '') };
}

export function git(cwd, args, opts = {}) {
  return run('git', args, { cwd, ...opts });
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function parseWorktreePorcelain(text) {
  const entries = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, locked: false, prunable: false, bare: false };
      entries.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      cur.locked = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      cur.prunable = true;
    } else if (line === 'bare') {
      cur.bare = true;
    }
  }
  return entries;
}

// The issue number is a hint, never the truth: the branch name first
// (feature/179-x, feature/issue-179, fix/179), then the directory basename
// (Project-issue-179).
export function issueNumberOf(branch, worktreeRef) {
  if (branch) {
    const m = branch.match(/(?:^|\/)(?:issue[-_]?)?(\d+)(?=[-_/]|$)/i);
    if (m) return Number(m[1]);
  }
  const m = String(worktreeRef || '').match(/issue[-_]?(\d+)(?:$|[^0-9])/i);
  return m ? Number(m[1]) : null;
}

export function resolveProfile(requested, top) {
  const limitations = [];
  let name;
  let verified;
  let detected = false;
  if (requested) {
    const canonical = PROFILE_ALIASES[String(requested).toLowerCase()];
    if (canonical) {
      name = canonical;
      verified = true;
      if (canonical !== String(requested).toLowerCase()) {
        limitations.push(`profile alias ${requested} was mapped to ${canonical}`);
      }
    } else {
      name = String(requested).slice(0, 60);
      verified = false;
    }
  } else {
    detected = true;
    const hasNode = fs.existsSync(path.join(top, 'package.json'));
    const hasRust = fs.existsSync(path.join(top, 'Cargo.toml'));
    if (hasNode && !hasRust) { name = 'node'; verified = true; }
    else if (hasRust && !hasNode) { name = 'rust'; verified = true; }
    else { name = 'unverified'; verified = false; }
    limitations.push(`profile was auto-detected as ${name}; confirm it together with the plan`);
  }
  return { name, verified, detected, limitations };
}

// ---------------------------------------------------------------------------
// Proof (references/proof-algorithm.md)
// ---------------------------------------------------------------------------

function emptyProof(base) {
  return {
    type: 'unverifiable',
    base,
    ancestor_verified: null,
    pr_number: null,
    merged_pr_exact: null,
    head_oid_match: null,
    merge_commit_oid: null,
    merge_commit_reachable: null,
    tree_equal: null,
    cherry_unmatched: null,
    equivalence_path: null,
  };
}

function fail(proof, reason) {
  proof.type = 'unverifiable';
  proof.unverifiable_reasons = [reason];
  return proof;
}

// Condition 4. Renders `mb..tip` and `merge^..merge` in the same fixed form and
// compares the bytes. `git cherry` is recorded as evidence; with
// NET_DIFF_SUFFICIENT it no longer vetoes on its own.
export function netDiffEquivalence(top, base, tip, mergeOid) {
  const mb = git(top, ['merge-base', base, tip]);
  if (mb.code !== 0) return { ok: false, reason: 'command_failed' };
  const mbOid = mb.stdout.trim();
  const branchDiff = git(top, [...DIFF_ARGS, mbOid, tip], { binary: true });
  const mergeDiff = git(top, [...DIFF_ARGS, `${mergeOid}^`, mergeOid], { binary: true });
  if (branchDiff.code !== 0 || mergeDiff.code !== 0) return { ok: false, reason: 'tree_mismatch', treeEqual: false };
  const treeEqual = Buffer.compare(branchDiff.stdout, mergeDiff.stdout) === 0;

  const cherry = git(top, ['cherry', base, tip]);
  let cherryUnmatched = null;
  if (cherry.code === 0) {
    cherryUnmatched = cherry.stdout.split('\n').filter((l) => l.startsWith('+')).length;
  }

  if (!treeEqual) return { ok: false, reason: 'tree_mismatch', treeEqual, cherryUnmatched };
  if (cherryUnmatched === 0) return { ok: true, treeEqual, cherryUnmatched, path: 'patch_equivalent' };
  // cherry has `+` (or could not run): the byte-identical net diff decides.
  // --full-index puts every touched path's pre- and post-image blob id into the
  // bytes, so a squash whose parent differs from mb in a touched path already
  // failed the comparison above.
  if (!NET_DIFF_SUFFICIENT) return { ok: false, reason: 'tree_mismatch', treeEqual, cherryUnmatched };
  return { ok: true, treeEqual, cherryUnmatched, path: 'net_diff_equal' };
}

export function fetchPrs(ghCmd, top, branch, baseBranch) {
  const r = run(ghCmd, [
    'pr', 'list', '--state', 'merged', '--head', branch, '--base', baseBranch,
    '--json', 'number,headRefName,baseRefName,headRefOid,mergeCommit,mergedAt',
  ], { cwd: top });
  if (r.code !== 0) return { ok: false };
  try {
    const data = JSON.parse(r.stdout);
    if (!Array.isArray(data)) return { ok: false };
    return { ok: true, prs: data };
  } catch {
    return { ok: false };
  }
}

export function proveCandidate(ctx, cand) {
  const { top, base, baseBranch, fetchOk, ghCmd } = ctx;
  const proof = emptyProof(base);
  const tip = cand.tip;

  // Direct ancestry (section 2).
  const anc = git(top, ['merge-base', '--is-ancestor', tip, base]);
  if (anc.code === 0) {
    proof.type = 'direct';
    proof.ancestor_verified = true;
    return proof;
  }
  if (anc.code !== 1) return fail(proof, 'command_failed');
  proof.ancestor_verified = false;

  // merged_equivalent needs a fresh remote (section 0).
  if (!fetchOk) return fail(proof, 'fetch_failed');

  // Condition 1 — exactly one merged PR for this head/base.
  const prsResult = fetchPrs(ghCmd, top, cand.branch, baseBranch);
  if (!prsResult.ok) return fail(proof, 'github_data_missing');
  const exact = prsResult.prs.filter((p) => p && p.headRefName === cand.branch && p.baseRefName === baseBranch);
  if (exact.length === 0) { proof.merged_pr_exact = false; return fail(proof, 'no_merged_pr'); }
  if (exact.length > 1) { proof.merged_pr_exact = false; return fail(proof, 'multiple_prs'); }
  const pr = exact[0];
  if (!Number.isInteger(pr.number) || pr.number < 1 || typeof pr.headRefOid !== 'string' || !('mergeCommit' in pr)) {
    return fail(proof, 'github_data_missing');
  }
  proof.merged_pr_exact = true;
  proof.pr_number = pr.number;

  // Condition 2 — the PR head is exactly this tip.
  proof.head_oid_match = pr.headRefOid === tip;
  if (!proof.head_oid_match) return fail(proof, 'head_oid_drift');

  // Condition 3 — the merge commit exists and base reaches it.
  const mergeOid = pr.mergeCommit && typeof pr.mergeCommit.oid === 'string' ? pr.mergeCommit.oid : null;
  if (!mergeOid || !OID_RE.test(mergeOid)) { proof.merge_commit_reachable = false; return fail(proof, 'merge_commit_unreachable'); }
  proof.merge_commit_oid = mergeOid;
  const exists = git(top, ['cat-file', '-e', `${mergeOid}^{commit}`]);
  const reach = exists.code === 0 ? git(top, ['merge-base', '--is-ancestor', mergeOid, base]) : exists;
  proof.merge_commit_reachable = exists.code === 0 && reach.code === 0;
  if (!proof.merge_commit_reachable) return fail(proof, 'merge_commit_unreachable');

  // Condition 4 — net diff equality (cherry recorded as evidence).
  const eq = netDiffEquivalence(top, base, tip, mergeOid);
  proof.tree_equal = eq.treeEqual === undefined ? null : eq.treeEqual;
  proof.cherry_unmatched = eq.cherryUnmatched === undefined ? null : eq.cherryUnmatched;
  if (!eq.ok) return fail(proof, eq.reason);
  proof.equivalence_path = eq.path;
  proof.type = 'merged_equivalent';
  return proof;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function inspectState(entry) {
  if (entry.prunable || !fs.existsSync(entry.path)) return { state: 'missing', tip: null };
  if (entry.locked) return { state: 'locked', tip: entry.head && OID_RE.test(entry.head) ? entry.head : null };
  const st = git(entry.path, ['status', '--porcelain']);
  if (st.code !== 0) return { state: 'missing', tip: null, commandFailed: true };
  const head = git(entry.path, ['rev-parse', 'HEAD']);
  const tip = head.code === 0 && OID_RE.test(head.stdout.trim()) ? head.stdout.trim() : null;
  if (st.stdout.trim() !== '') return { state: 'dirty', tip };
  const br = git(entry.path, ['branch', '--show-current']);
  if (br.code !== 0 || br.stdout.trim() === '') return { state: 'detached', tip };
  if (!tip) return { state: 'missing', tip: null, commandFailed: true };
  return { state: 'clean', tip, branch: br.stdout.trim() };
}

export function buildPlan(opts) {
  const repo = opts.repo || process.cwd();
  const remote = opts.remote || 'origin';
  const blocking = [];
  const limitations = [];

  const topR = git(repo, ['rev-parse', '--show-toplevel']);
  if (topR.code !== 0) {
    blocking.push('not inside a git repository');
    return { plan: failurePlan(opts, remote, blocking), top: null, entries: [] };
  }
  const top = topR.stdout.trim();

  let base = opts.base;
  if (!base) {
    const sym = git(top, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
    if (sym.code === 0 && sym.stdout.trim()) base = sym.stdout.trim();
  }
  if (!base) {
    blocking.push(`base could not be resolved: pass --base or set refs/remotes/${remote}/HEAD`);
    return { plan: failurePlan(opts, remote, blocking), top, entries: [] };
  }
  const baseBranch = base.startsWith(`${remote}/`) ? base.slice(remote.length + 1) : base;

  const profile = resolveProfile(opts.profile, top);
  limitations.push(...profile.limitations);
  if (!profile.verified) limitations.push(`profile ${profile.name} is unverified; nothing is deleted without an explicit --confirm`);

  // Step 2 — freshness. A failed fetch never lets a stale base count as current.
  const fetchArgs = ['fetch', remote, baseBranch, '--prune'];
  const fetchR = opts.noFetch ? { code: 1 } : git(top, fetchArgs);
  const fetchOk = fetchR.code === 0;
  if (!fetchOk) limitations.push(opts.noFetch ? 'fetch was skipped (--no-fetch); merged_equivalent is not attempted' : `git fetch ${remote} ${baseBranch} failed; merged_equivalent is not attempted and base may be stale`);

  const baseOk = git(top, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (baseOk.code !== 0) {
    blocking.push(`base ${base} does not resolve to a commit`);
    return { plan: failurePlan(opts, remote, blocking, profile, base, fetchOk), top, entries: [] };
  }

  const list = git(top, ['worktree', 'list', '--porcelain']);
  if (list.code !== 0) {
    blocking.push('git worktree list --porcelain failed');
    return { plan: failurePlan(opts, remote, blocking, profile, base, fetchOk), top, entries: [] };
  }
  const entries = parseWorktreePorcelain(list.stdout);
  const realTop = safeRealpath(top);
  const integration = new Set([baseBranch, ...(opts.integration || [])]);
  const targets = opts.issues || [];

  const ctx = { top, base, baseBranch, fetchOk, ghCmd: opts.ghCmd || 'gh' };
  const candidates = [];
  const excluded = [];
  const liveEntries = [];

  entries.forEach((entry, idx) => {
    if (entry.bare) return;
    const ref = path.basename(entry.path);
    if (idx === 0 || safeRealpath(entry.path) === realTop) {
      excluded.push({ worktree_ref: ref, reason: 'current_worktree' });
      return;
    }
    if (entry.branch && integration.has(entry.branch)) {
      excluded.push({ worktree_ref: ref, reason: 'integration_worktree' });
      return;
    }
    const issue = issueNumberOf(entry.branch, ref);
    if (opts.selection === 'issues' && (issue === null || !targets.includes(issue))) {
      excluded.push({ worktree_ref: ref, reason: 'not_in_scope' });
      return;
    }

    const st = inspectState(entry);
    const cand = {
      worktree_ref: ref,
      issue_number: issue,
      branch: st.state === 'detached' ? null : (st.branch || entry.branch || null),
      tip: st.tip,
      state: st.state,
      proof: null,
      decision: 'skip',
      delete_method: null,
      skip_reason: null,
      diagnostics: [],
    };
    if (st.state === 'clean') {
      cand.proof = proveCandidate(ctx, cand);
      if (cand.proof.type === 'direct') {
        cand.decision = 'delete';
        cand.delete_method = 'direct_branch_d';
      } else if (cand.proof.type === 'merged_equivalent') {
        cand.decision = 'delete';
        cand.delete_method = 'guarded_ref_delete';
      } else {
        cand.skip_reason = cand.proof.unverifiable_reasons[0];
      }
    } else {
      cand.proof = emptyProof(base);
      cand.skip_reason = st.commandFailed ? 'command_failed' : st.state;
    }
    candidates.push(cand);
    liveEntries.push({ ref, path: entry.path });
  });

  const plan = {
    plan_schema_version: 1,
    skill: { id: SKILL_ID, version: SKILL_VERSION },
    generated_at: nowIso(opts.now),
    mode: 'dry_run',
    profile: { name: profile.name, verified: profile.verified, base, remote, baseline: null },
    request: { selection_mode: opts.selection, targets: opts.selection === 'issues' ? targets : [] },
    fetch: { attempted: !opts.noFetch, succeeded: fetchOk, remote, base },
    candidates,
    excluded,
    blocking_reasons: blocking,
    limitations,
    summary_markdown: '',
  };
  plan.summary_markdown = planSummary(plan);
  return { plan, top, entries: liveEntries, ctx };
}

function failurePlan(opts, remote, blocking, profile, base, fetchOk) {
  const b = base || `${remote}/HEAD`;
  const plan = {
    plan_schema_version: 1,
    skill: { id: SKILL_ID, version: SKILL_VERSION },
    generated_at: nowIso(opts.now),
    mode: 'dry_run',
    profile: { name: profile ? profile.name : 'unverified', verified: profile ? profile.verified : false, base: b, remote, baseline: null },
    request: { selection_mode: opts.selection || 'issues', targets: opts.selection === 'issues' ? (opts.issues || []) : [] },
    fetch: { attempted: fetchOk !== undefined, succeeded: Boolean(fetchOk), remote, base: b },
    candidates: [],
    excluded: [],
    blocking_reasons: blocking,
    limitations: [],
    summary_markdown: '',
  };
  plan.summary_markdown = planSummary(plan);
  return plan;
}

function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// 0 = every candidate is deletable, 1 = some candidate is skipped, 2 = no plan.
// Excluded worktrees (current / integration / out of scope) never count.
export function planExitCode(plan) {
  if (plan.blocking_reasons.length) return 2;
  return plan.candidates.some((c) => c.decision === 'skip') ? 1 : 0;
}

// 0 = success with nothing skipped, 1 = partial or some candidate skipped
// (a deletable one left out of --confirm is the caller's choice, not a skip),
// 2 = failure.
export function resultExitCode(result) {
  if (result.status === 'failure') return 2;
  if (result.status === 'partial') return 1;
  return result.skipped.some((s) => s.proof_type !== 'excluded' && s.reason !== 'not_in_scope') ? 1 : 0;
}

function proofLine(c) {
  const p = c.proof;
  if (p.type === 'direct') return 'direct（tip が base の祖先）';
  if (p.type === 'merged_equivalent') {
    const via = p.equivalence_path === 'net_diff_equal'
      ? `正味の差分が squash の差分とバイト一致（git cherry の + ${p.cherry_unmatched} 行は evidence のみ）`
      : 'git cherry で patch 等価、差分もバイト一致';
    return `merged_equivalent（PR #${p.pr_number}・head OID 一致・merge commit 到達可能・${via}）`;
  }
  return 'unverifiable';
}

function planSummary(plan) {
  const del = plan.candidates.filter((c) => c.decision === 'delete');
  const keep = plan.candidates.filter((c) => c.decision === 'skip');
  const lines = [];
  lines.push('## 判定');
  lines.push(plan.blocking_reasons.length
    ? `failure — plan を作れなかった: ${plan.blocking_reasons.join(' / ')}`
    : `dry_run preview — 削除候補 ${del.length} 件・残す ${keep.length + plan.excluded.length} 件。これは preview であり、何も削除していない。`);
  lines.push('## 対象と profile');
  lines.push(`profile ${plan.profile.name}（verified: ${plan.profile.verified}）・base ${plan.profile.base}・remote ${plan.profile.remote}・selection ${plan.request.selection_mode}`);
  lines.push('## 削除したもの');
  lines.push('なし（dry_run）。apply すれば削除される候補:');
  for (const c of del) lines.push(`- ${c.worktree_ref}（${c.branch}）: ${proofLine(c)}`);
  lines.push('## 残したもの（理由つき）');
  for (const c of keep) lines.push(`- ${c.worktree_ref}: ${c.skip_reason}`);
  for (const e of plan.excluded) lines.push(`- ${e.worktree_ref}: ${e.reason}`);
  if (!keep.length && !plan.excluded.length) lines.push('なし');
  lines.push('## 診断と手動next action');
  lines.push('server / process / tmux / DB / log は診断対象外（runner は観測も停止もしない）。');
  lines.push('## sync と走査範囲');
  lines.push(`fetch ${plan.fetch.succeeded ? '成功' : '失敗または未実行'}。worktree は git worktree list --porcelain から ${plan.candidates.length + plan.excluded.length} 件を走査。sync は dry_run では実行しない。`);
  for (const l of plan.limitations) lines.push(`- limitation: ${l}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

// Re-read status / HEAD / ref immediately before deletion (proof-algorithm §5).
export function driftCheck(top, wtPath, branch, tip) {
  const st = git(wtPath, ['status', '--porcelain']);
  if (st.code !== 0 || st.stdout.trim() !== '') return false;
  const head = git(wtPath, ['rev-parse', 'HEAD']);
  if (head.code !== 0 || head.stdout.trim() !== tip) return false;
  const ref = git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return ref.code === 0 && ref.stdout.trim() === tip;
}

export function applyPlan(built, opts) {
  const { plan, top, entries } = built;
  const pathOf = new Map(entries.map((e) => [e.ref, e.path]));
  const confirm = new Set(opts.confirm || []);
  const priorPlan = opts.priorPlan || null;
  const priorByRef = priorPlan ? new Map((priorPlan.candidates || []).map((c) => [c.worktree_ref, c])) : null;
  const removed = [];
  const skipped = [];
  const nextActions = [];
  const limitations = [...plan.limitations];
  const grantedTargets = [];
  let raced = false;
  let removeFailed = false;

  for (const e of plan.excluded) {
    skipped.push({ worktree_ref: e.worktree_ref, issue_number: null, branch: null, reason: e.reason, proof_type: 'excluded', detail: confirm.has(e.worktree_ref) ? 'named in --confirm, refused: never deletable' : null });
  }

  let syncIds = null;
  if (opts.sync) syncIds = commandmateIds(top);

  for (const c of plan.candidates) {
    const confirmed = confirm.has(c.worktree_ref) || (c.branch && confirm.has(c.branch));
    if (confirmed) grantedTargets.push(c.worktree_ref);
    const base = { worktree_ref: c.worktree_ref, issue_number: c.issue_number, branch: c.branch };
    const proofType = c.proof.type;

    // With --plan, the reviewed plan is what was confirmed: a target whose
    // tip, state or decision moved since then is plan_drift, never re-judged.
    if (priorByRef && confirmed) {
      const prior = priorByRef.get(c.worktree_ref);
      const wasDeletable = Boolean(prior && prior.decision === 'delete');
      const isDeletable = c.decision === 'delete';
      if ((wasDeletable || isDeletable) && !(wasDeletable && isDeletable && prior.tip === c.tip)) {
        skipped.push({ ...base, reason: 'plan_drift', proof_type: proofType, detail: 'state, tip or proof changed since the reviewed plan' });
        continue;
      }
    }
    if (c.decision !== 'delete') {
      skipped.push({ ...base, reason: c.skip_reason, proof_type: proofType, detail: null });
      nextActions.push(nextActionFor(c));
      continue;
    }
    if (!confirmed) {
      skipped.push({ ...base, reason: 'not_in_scope', proof_type: proofType, detail: 'deletable but not named in --confirm' });
      continue;
    }

    const wtPath = pathOf.get(c.worktree_ref);
    if (!driftCheck(top, wtPath, c.branch, c.tip)) {
      skipped.push({ ...base, reason: 'plan_drift', proof_type: proofType, detail: 'status, HEAD or ref changed before deletion' });
      continue;
    }
    const verifiedAt = nowIso(opts.now);

    const rm = git(top, ['worktree', 'remove', wtPath]);
    if (rm.code !== 0) {
      removeFailed = true;
      skipped.push({ ...base, reason: 'command_failed', proof_type: proofType, detail: 'git worktree remove (without --force) refused' });
      continue;
    }

    let branchDeleted = false;
    let method = c.delete_method;
    if (proofType === 'direct') {
      const d = git(top, ['branch', '-d', c.branch]);
      if (d.code === 0) branchDeleted = true;
      else branchDeleted = git(top, ['update-ref', '-d', `refs/heads/${c.branch}`, c.tip]).code === 0;
    } else {
      method = 'guarded_ref_delete';
      branchDeleted = git(top, ['update-ref', '-d', `refs/heads/${c.branch}`, c.tip]).code === 0;
    }
    if (!branchDeleted) {
      raced = true;
      nextActions.push({ action: `branch ${c.branch} was not deleted (the ref moved or the guarded delete failed); check it by hand`, reason: 'unverifiable', worktree_ref: c.worktree_ref });
    }

    const evidence = { base: c.proof.base, verified_at: verifiedAt };
    if (proofType === 'direct') {
      evidence.ancestor_verified = true;
    } else {
      evidence.pr_number = c.proof.pr_number;
      evidence.merge_commit_oid = c.proof.merge_commit_oid;
      evidence.expected_old_oid = c.tip;
      evidence.equivalence_path = c.proof.equivalence_path;
      evidence.cherry_unmatched = c.proof.cherry_unmatched;
    }
    removed.push({
      worktree_ref: c.worktree_ref,
      issue_number: c.issue_number,
      branch: c.branch,
      tip: c.tip,
      proof_type: proofType,
      method,
      worktree_removed: true,
      branch_deleted: branchDeleted,
      evidence,
      _path: wtPath,
    });
  }
  const prune = git(top, ['worktree', 'prune']);

  // Sync (optional). Never turns the run into a failure.
  let sync = { attempted: false, outcome: 'skipped', worktree_ids: [] };
  if (opts.sync && removed.length) {
    const r = run(opts.commandmateCmd || 'commandmate', ['sync'], { cwd: top });
    const ids = removed.map((rm) => (syncIds && syncIds.get(safeRealpath(rm._path))) || null);
    if (r.code === 0) sync = { attempted: true, outcome: 'synced', worktree_ids: ids };
    else if (r.code === -1 || r.code === 127) sync = { attempted: true, outcome: 'unavailable', worktree_ids: removed.map(() => null) };
    else sync = { attempted: true, outcome: 'failed', worktree_ids: removed.map(() => null) };
    if (sync.outcome !== 'synced') {
      nextActions.push({ action: 'run commandmate sync once the CommandMate server is up, so the removed worktrees leave its list', reason: 'sync', worktree_ref: null });
    }
  } else if (removed.length) {
    nextActions.push({ action: 'run commandmate sync so the removed worktrees leave the CommandMate list (the runner syncs only with --sync)', reason: 'sync', worktree_ref: null });
  }
  for (const r of removed) delete r._path;

  const excludedRefs = new Set(plan.excluded.map((e) => e.worktree_ref));
  const checks = [
    { id: 'exclusions_honored', passed: removed.every((r) => !excludedRefs.has(r.worktree_ref)), detail: 'no current, integration or out-of-scope worktree was removed' },
    { id: 'zero_delete_honored', passed: removed.every((r) => r.proof_type === 'direct' || r.proof_type === 'merged_equivalent'), detail: 'only clean worktrees with a direct or merged_equivalent proof were removed' },
    { id: 'proof_sufficient', passed: removed.every((r) => (r.proof_type === 'direct' ? r.evidence.ancestor_verified === true : Boolean(r.evidence.pr_number && r.evidence.merge_commit_oid && r.evidence.expected_old_oid === r.tip))), detail: 'every removal carries its proof evidence' },
    { id: 'guarded_delete_used', passed: removed.every((r) => r.proof_type !== 'merged_equivalent' || r.method === 'guarded_ref_delete'), detail: 'merged_equivalent removals used git update-ref -d with the verified tip; no --force, no -D' },
    { id: 'drift_rechecked', passed: true, detail: 'status, HEAD and ref were re-read immediately before each deletion' },
    { id: 'no_sensitive_values', passed: true, detail: 'worktrees are recorded by basename; no absolute path or raw GitHub response' },
  ];

  const partial = raced || removeFailed || skipped.some((s) => UNVERIFIABLE_REASONS.has(s.reason))
    || sync.outcome === 'unavailable' || sync.outcome === 'failed';

  const result = {
    result_schema_version: 1,
    skill: { id: SKILL_ID, version: SKILL_VERSION },
    generated_at: nowIso(opts.now),
    status: partial ? 'partial' : 'success',
    mode: 'apply',
    profile: plan.profile,
    request: plan.request,
    confirmation: { required: true, granted: true, granted_targets: grantedTargets, note: priorPlan ? 'confirmed with --confirm against a reviewed plan (--plan)' : 'confirmed with --confirm' },
    fetch: plan.fetch,
    removed,
    skipped,
    worktree_prune: { ran: prune.code === 0 },
    commandmate_sync: sync,
    next_actions: nextActions.filter(Boolean),
    blocking_reasons: [],
    limitations,
    completion_check: { passed: false, checks },
    summary_markdown: '',
  };
  result.summary_markdown = resultSummary(result);
  // The last check is measured on the serialised receipt itself.
  const text = JSON.stringify(result);
  const leaks = [top, os.homedir(), ...entries.map((e) => e.path)].filter((p) => p && p.length > 1 && text.includes(p));
  checks[5].passed = leaks.length === 0;
  result.completion_check.passed = checks.every((c) => c.passed);
  if (!result.completion_check.passed) result.status = 'partial';
  return result;
}

function nextActionFor(c) {
  if (c.skip_reason === 'locked' || c.skip_reason === 'missing') return null;
  const reason = ['dirty', 'detached'].includes(c.skip_reason) ? c.skip_reason
    : c.skip_reason === 'no_merged_pr' ? 'unmerged' : 'unverifiable';
  const text = {
    dirty: 'commit, push or discard the local changes, then run the cleanup again',
    detached: 'check out a branch or remove the worktree by hand after checking it',
    unmerged: 'merge the branch (or confirm it is abandoned) before cleaning it up',
    unverifiable: `could not prove the merge (${c.skip_reason}); inspect tip, tree and PR by hand`,
  }[reason];
  return { action: text, reason, worktree_ref: c.worktree_ref };
}

function commandmateIds(top) {
  const r = run('commandmate', ['ls', '--json'], { cwd: top });
  if (r.code !== 0) return null;
  const map = new Map();
  try {
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        if (typeof v.id === 'string' && typeof v.path === 'string') map.set(safeRealpath(v.path), v.id);
        Object.values(v).forEach(walk);
      }
    };
    walk(JSON.parse(r.stdout));
  } catch {
    return null;
  }
  return map;
}

function resultSummary(result) {
  const lines = [];
  lines.push('## 判定');
  lines.push(`${result.status} — 削除 ${result.removed.length} 件・残した ${result.skipped.length} 件（mode: ${result.mode}）`);
  lines.push('## 対象と profile');
  lines.push(`profile ${result.profile.name}（verified: ${result.profile.verified}）・base ${result.profile.base}・remote ${result.profile.remote}・selection ${result.request.selection_mode}`);
  lines.push('## 削除したもの');
  if (!result.removed.length) lines.push('なし');
  for (const r of result.removed) {
    const how = r.proof_type === 'direct'
      ? 'tip が base の祖先'
      : `PR #${r.evidence.pr_number}・head OID 一致・merge commit 到達可能・${r.evidence.equivalence_path === 'net_diff_equal' ? '正味の差分がバイト一致（git cherry の + は evidence のみ）' : 'patch 等価かつ差分がバイト一致'}`;
    lines.push(`- ${r.worktree_ref}（${r.branch}）: ${r.proof_type} / ${r.method}${r.branch_deleted ? '' : '（branch は残った）'} — ${how}`);
  }
  lines.push('## 残したもの（理由つき）');
  if (!result.skipped.length) lines.push('なし');
  for (const s of result.skipped) lines.push(`- ${s.worktree_ref}: ${s.reason}${s.detail ? `（${s.detail}）` : ''}`);
  lines.push('## 診断と手動next action');
  if (!result.next_actions.length) lines.push('なし');
  for (const a of result.next_actions) lines.push(`- [${a.reason}] ${a.worktree_ref ? `${a.worktree_ref}: ` : ''}${a.action}`);
  lines.push('## sync と走査範囲');
  lines.push(`sync: ${result.commandmate_sync.outcome}。worktree prune: ${result.worktree_prune.ran ? '実行' : '未実行'}。fetch: ${result.fetch.succeeded ? '成功' : '失敗または未実行'}。`);
  for (const l of result.limitations) lines.push(`- limitation: ${l}`);
  return lines.join('\n');
}
