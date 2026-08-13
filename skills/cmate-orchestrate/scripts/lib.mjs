// cmate-orchestrate — helpers shared by the four runners (Node stdlib only, Node >= 22).
//
// The package ships four deterministic runners — orchestrate.mjs (plan),
// dispatch.mjs, merge.mjs and uat.mjs — and they had accumulated copies of the
// same helpers. This module holds the copies that were BYTE-IDENTICAL, so that a
// fix applied to one is a fix applied to all. Nothing here changes behavior: each
// definition below is the text that already stood in the runners that used it.
//
// The rule this module is maintained by, because getting it wrong is how a
// refactor turns into a regression:
//
//   Only a helper whose every copy was byte-identical lives here. A helper that
//   merely SHARES A NAME across runners is left where it is. Same-named helpers
//   with different bodies are not "reconciled" into one — reconciling them picks
//   one runner's behavior and silently imposes it on the others.
//
// resolveLauncher() is the one entry that was never a copy: it was written here
// FIRST, precisely so dispatch and uat cannot drift on how a launcher is read
// (Issue #37). Divergence there is the bug it exists to prevent.
//
// Deliberately NOT hoisted, with the difference that keeps each one local:
//
//   parseCli / renderSummary  four different implementations (different flags,
//                             different report shapes). Nothing to share.
//   excerpt                   dispatch returns `null` for an empty excerpt,
//                             merge/uat return `''`. The report schemas differ.
//   bullets                   merge/uat redact each item, dispatch does not.
//   runCli                    dispatch/uat take an `extra` options bag and spread
//                             it into execFileSync; merge takes (bin, args) only.
//   validatePlan              dispatch additionally enforces max_parallel and the
//                             per-wave width bound — the pre-condition that stops
//                             it from dispatching beyond the plan's promise.
//   positiveInt               uat takes a `max` ceiling argument, dispatch does not.
//   preflight / eligibleIssues / halt
//                             merge and uat check different binaries, read
//                             different eligibility fields and halt into different
//                             report shapes.
//   redact (orchestrate.mjs)  the planner keeps its own non-tallying copy; see the
//                             note on REDACTIONS below.
//
// The planner's extraction constants (FILE_EXT, PATH_START, CANDIDATE_*,
// DELIVERABLE_HEADING_RE, CONTEXT_HEADING_RE) are NOT here either, and must not
// move: tests/fixtures/cmate-issue-authoring/run_tests.sh compares those
// declarations byte for byte against cmate-issue-authoring's mirror of them, by
// reading `^const NAME = ...` out of orchestrate.mjs.

import { readFileSync } from 'node:fs';

export const SKILL_ID = 'cmate-orchestrate';

// Stamped into the `skill_version` field of every report the four runners write,
// which is the field a bug report against this package is triaged by. It must
// equal `version:` in commandmate.skill.yaml, and scripts/validate.py fails the
// package when it does not — 0.15.0 through 0.17.0 shipped with this constant
// left at 0.13.0, and the reports named a version nobody had installed
// (Issue #92, observed in Kewton/CommandMate#1741).
export const SKILL_VERSION = '0.28.0';

// The dispatch report version merge.mjs and uat.mjs consume. It is the dispatch
// report's contract as a CONSUMER sees it, which is why it is stated here rather
// than imported from dispatch.mjs (which declares its own producer-side version).
export const SUPPORTED_DISPATCH_SCHEMA_VERSION = 1;

// A skill error carries a machine code so the result envelope, the exit status
// and the audit line all agree on what went wrong. All four runners branch on
// `error instanceof SkillError` in main(), so there must be exactly one class:
// a per-file copy would make an error thrown by a helper here unrecognizable.
export class SkillError extends Error {
  constructor(code, detail, exitCode) {
    super(detail);
    this.code = code;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

// =============================================================================
// Redaction
// =============================================================================

// Applied to every free-text field lifted out of an issue or a terminal before it
// is stored. A token or an absolute host path must not survive into a plan, a
// report or an audit artifact. Patterns are shapes, never example secrets, so
// this file itself trips no credential scanner.
//
// All four runners share this list, including orchestrate.mjs, which keeps its
// own `redact()`. Drift in the PATTERNS between runners is the failure that
// matters — a token shape added to one runner and missed in another leaks from
// the runner that missed it — so the list is shared even where the function
// around it is not.
export const REDACTIONS = [
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

// The tallying redaction used by the three mutating runners, whose reports carry
// a `redactions[]` field. orchestrate.mjs has no such field and keeps its own
// copy without the tally; that difference is why this one is not imposed on it.
export function redact(value) {
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

export function redactionsList() {
  return [...redactionTally.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([kind, count]) => ({ kind, count }));
}

// =============================================================================
// Loading and validating the upstream artifacts
// =============================================================================

export function loadJson(path, what) {
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

export function validateDispatch(report) {
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

export function issueOf(plan, number) {
  return plan.issues.find((issue) => issue.number === number) ?? { number };
}

// =============================================================================
// Subprocess output
// =============================================================================

export function parseCliJson(result) {
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// =============================================================================
// Launcher resolution (Issue #37)
// =============================================================================

// Every runner that drives the CommandMate CLI resolves its launcher the same
// way `cmate-orchestrate-monitor/scripts/monitor.sh:108` does, so one operator
// setting covers the whole toolchain instead of one convention per Skill:
//
//   --cli <launcher>   explicit, wins
//   $CM                monitor.sh's variable, same name and same meaning
//   "commandmate"      the default
//
// The value is a LAUNCHER, not merely an executable. It is split on whitespace
// and spawned WITHOUT a shell, which is what makes `npx commandmate@latest`
// usable: before this, execFileSync took the whole string as one program name
// and died with ENOENT on the space. The default stays the bare name so that an
// npx-only operator sets exactly one thing — `CM` — as the acceptance criteria
// ask, and nobody who already has the binary starts paying npx startup per call.
//
// This is RUNTIME resolution only. No runner writes the resolved launcher into
// plan.json: the plan stays a pure function of its inputs.
export const DEFAULT_LAUNCHER = 'commandmate';

// Shell syntax we would never interpret. Nothing here goes through a shell, so a
// pipe, a redirect, a substitution or a quote would be handed to the program as
// a literal argument and silently misbehave — a wrapper script is the answer,
// and the error says so. Whitespace is the separator, so tab and space are fine;
// every other control character is not.
const LAUNCHER_SHELL_CHARS = /[|&;<>()$`\\"']/;
// eslint-disable-next-line no-control-regex
const LAUNCHER_CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f]/;

export const LAUNCHER_ADVICE =
  'a launcher is an executable plus fixed leading arguments, split on whitespace and run WITHOUT a shell ' +
  '(accepted: "commandmate", "/usr/local/bin/commandmate", "npx commandmate@latest", "node /path/to/cli.mjs"). ' +
  'For anything a shell would have to read — a pipe, a redirect, a substitution, a quote — put a wrapper on PATH ' +
  '(~/.local/bin/commandmate containing: exec npx --yes commandmate@latest "$@") and pass its path.';

// Returns the argv prefix: [program, ...fixed args]. Never empty.
export function resolveLauncher(cliFlag, env = process.env) {
  const fromEnv = typeof env.CM === 'string' && env.CM.trim() !== '' ? env.CM : undefined;
  const source = cliFlag !== undefined && cliFlag !== null ? '--cli' : (fromEnv !== undefined ? 'CM' : 'default');
  const raw = cliFlag ?? fromEnv ?? DEFAULT_LAUNCHER;
  const reject = (why) => {
    throw new SkillError('invalid_input', `${source} ${redact(String(raw))}: ${why}; ${LAUNCHER_ADVICE}`, 3);
  };
  if (typeof raw !== 'string') reject('must be a string');
  if (LAUNCHER_CONTROL_CHARS.test(raw)) reject('contains a control character');
  if (LAUNCHER_SHELL_CHARS.test(raw)) reject('contains shell syntax, which nothing here interprets');
  const argv = raw.trim().split(/\s+/).filter((token) => token !== '');
  if (argv.length === 0) reject('is empty');
  if (argv[0].startsWith('-')) reject('starts with "-", so it would be read as a flag rather than a program');
  return argv;
}

// =============================================================================
// Path and ref guards
// =============================================================================

// A branch name headed into `git push` / `gh pr create --head` must be a plain
// ref: no whitespace, no shell metacharacters, no path escape. A profile
// template produces exactly this shape; anything else is refused, not quoted.
export function safeBranch(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^[A-Za-z0-9._\/-]+$/.test(value)) return null;
  if (value.includes('..')) return null;
  if (value.startsWith('/') || value.startsWith('-')) return null;
  return value;
}

// The worktree path comes from a verified profile template (e.g. "../repo-…"),
// so a single leading "../" to a sibling directory is legitimate. Anything that
// could escape further — an absolute path, a drive path, a backslash, a control
// character, or a "../" that is not the single leading segment — is refused.
export function safeWorktreeTarget(pathValue) {
  if (typeof pathValue !== 'string' || pathValue.length === 0) return null;
  if (pathValue.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(pathValue)) return null;
  if (pathValue.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(pathValue)) return null;
  let rest = pathValue;
  if (rest.startsWith('../')) rest = rest.slice(3);
  if (rest.split('/').some((segment) => segment === '..')) return null;
  return pathValue;
}
