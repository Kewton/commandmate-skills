#!/usr/bin/env node
// cmate-worktree-cleanup runner.
//
//   node cleanup.mjs --issues 179,181 [--profile node] [--base origin/main]
//   node cleanup.mjs --all-eligible [--integration develop]
//   node cleanup.mjs --issues 179 --apply --confirm <worktree_ref|branch>,... [--plan plan.json]
//
// Dry-run is the default: it prints a cleanup-plan.v1 document and deletes
// nothing. Only --apply together with --confirm deletes, and only the confirmed
// candidates whose proof holds and whose status / HEAD / ref did not move.
// --apply without --confirm stays a dry-run (a non-interactive caller cannot
// confirm). Flags, output and exit codes: references/runner-contract.md.
//
// Exit codes: 0 success, 1 some candidate was skipped (or the run is partial),
// 2 invalid input or no plan could be produced.

import fs from 'node:fs';
import { buildPlan, applyPlan, planExitCode, resultExitCode } from './lib.mjs';

const USAGE = `usage: node cleanup.mjs (--issues <n,...> | --all-eligible) [options]
  --repo <dir>            repository to inspect (default: current directory)
  --profile <name>        node | rust | <name> (unverified); auto-detected when omitted
  --base <ref>            base ref, e.g. origin/main (default: <remote>/HEAD)
  --remote <name>         remote to fetch the base from (default: origin)
  --integration <b,...>   extra integration branches never deleted (the base branch always is)
  --apply                 delete; requires --confirm, otherwise stays a dry-run
  --confirm <x,...>       worktree basenames or branch names approved for deletion
  --plan <file>           the reviewed plan; targets that moved since it are plan_drift
  --gh <cmd>              gh executable (default: $CMATE_WORKTREE_CLEANUP_GH or gh)
  --sync                  run commandmate sync after deleting
  --no-fetch              do not fetch (merged_equivalent is then never attempted)
  --now <timestamp>       fixed generated_at, for reproducible output`;

function parseList(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const o = { integration: [], confirm: [] };
  const needs = new Set(['--repo', '--issues', '--profile', '--base', '--remote', '--integration', '--confirm', '--plan', '--gh', '--now']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (needs.has(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      const v = argv[++i];
      switch (a) {
        case '--repo': o.repo = v; break;
        case '--issues': {
          const nums = parseList(v);
          if (!nums.length || nums.some((n) => !/^[1-9][0-9]{0,9}$/.test(n) || Number(n) > 2147483647)) throw new Error('--issues takes positive issue numbers');
          o.issues = nums.map(Number);
          break;
        }
        case '--profile': o.profile = v; break;
        case '--base': o.base = v; break;
        case '--remote': o.remote = v; break;
        case '--integration': o.integration = parseList(v); break;
        case '--confirm': o.confirm = parseList(v); break;
        case '--plan': o.planFile = v; break;
        case '--gh': o.ghCmd = v; break;
        case '--now': o.now = v; break;
        default: break;
      }
    } else if (a === '--all-eligible') o.allEligible = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '--sync') o.sync = true;
    else if (a === '--no-fetch') o.noFetch = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`cleanup.mjs: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (o.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (Boolean(o.issues) === Boolean(o.allEligible)) {
    process.stderr.write(`cleanup.mjs: give exactly one of --issues or --all-eligible\n${USAGE}\n`);
    return 2;
  }
  if ((o.confirm.length || o.planFile) && !o.apply) {
    process.stderr.write('cleanup.mjs: --confirm and --plan only make sense with --apply\n');
    return 2;
  }
  if (o.now && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(o.now)) {
    process.stderr.write('cleanup.mjs: --now must be YYYY-MM-DDTHH:MM:SSZ\n');
    return 2;
  }
  let priorPlan = null;
  if (o.planFile) {
    try {
      priorPlan = JSON.parse(fs.readFileSync(o.planFile, 'utf8'));
      if (priorPlan.plan_schema_version !== 1 || !Array.isArray(priorPlan.candidates)) throw new Error('not a cleanup-plan.v1 document');
    } catch (e) {
      process.stderr.write(`cleanup.mjs: --plan: ${e.message}\n`);
      return 2;
    }
  }

  const opts = {
    repo: o.repo,
    selection: o.allEligible ? 'all_eligible' : 'issues',
    issues: o.issues || [],
    profile: o.profile,
    base: o.base,
    remote: o.remote,
    integration: o.integration,
    ghCmd: o.ghCmd || process.env.CMATE_WORKTREE_CLEANUP_GH || 'gh',
    noFetch: Boolean(o.noFetch),
    now: o.now,
  };
  const built = buildPlan(opts);

  if (!o.apply || built.plan.blocking_reasons.length) {
    if (o.apply) built.plan.limitations.push('apply was requested but no plan could be produced; nothing was deleted');
    process.stdout.write(`${JSON.stringify(built.plan, null, 2)}\n`);
    return planExitCode(built.plan);
  }
  if (!o.confirm.length) {
    built.plan.limitations.push('apply was requested without --confirm; stayed in dry_run and deleted nothing');
    process.stdout.write(`${JSON.stringify(built.plan, null, 2)}\n`);
    return planExitCode(built.plan);
  }

  const result = applyPlan(built, { confirm: o.confirm, priorPlan, sync: Boolean(o.sync), now: o.now });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return resultExitCode(result);
}

process.exitCode = main();
