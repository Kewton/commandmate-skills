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
// The `scope_companions` section at the bottom is the same kind of entry, arrived
// at from the other direction: it was HOISTED out of orchestrate.mjs when a
// second reader appeared (`profile-init.mjs --check`, Issue #197). A rule
// vocabulary read by two runners is a vocabulary two runners can disagree about,
// and the disagreement would be silent — `--check` reporting a match the planner
// does not make is exactly the "a rule that never matches and never says so"
// failure #197 exists to remove. So the matcher is written once and both callers
// import it; the extraction is provably behaviour-preserving because every
// full-text plan golden is byte-unchanged by it.
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
export const SKILL_VERSION = '0.31.0';

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
// The GATE line vocabulary (Issue #224 / CommandMate #1772)
// =============================================================================
//
// `commandmate wait --verify` and cmate-verify's standalone runner both report
// one `GATE <id> <WORD>` line per executed gate, and three runners in this Skill
// read those lines or the verdicts transcribed from them: dispatch parses them,
// merge renders them into the PR body, status renders them into the matrix. (uat
// reads the same report but only `verification.outcome`, which is the exit code
// and not a word from this vocabulary.) The vocabulary lives here so there is one
// definition of what the words mean rather than one per reader — a third word
// added to one reader and not the others is how `FLAKY` would have arrived as
// "unknown" in one place and `fail` in another.
//
// `FLAKY` means the gate failed and then passed on a re-run against the same
// tree. It is a THIRD word, not a decoration on PASS or FAIL: neither of those
// was true of the gate. Whether the run COUNTED it as a pass is decided by the
// gate's own `flakyIsPass`, and that decision is already in the runner's exit
// code — which is the verdict (dispatch-contract.md section 2.6). Nothing here
// re-adjudicates it.
//
// The regex matches the word and stops. Both spellings carry a detail after it
// and they differ — the product CLI parenthesises (`GATE unit FLAKY (exit=1,0,
// 45.0s,44.0s)`) and the standalone runner does not (`GATE unit FLAKY exit=1,0
// duration=45s,44s waited=42s`) — so a reader that parsed the detail would be
// reading one runner's punctuation as a contract. `\b` after the word is what
// keeps `waited=` and a two-valued `exit=` from breaking the match.
export const GATE_LINE_RE = /^GATE\s+(\S+)\s+(PASS|FAIL|FLAKY)\b/;

/** The report's spelling of each GATE word. */
export const GATE_VERDICT_BY_LABEL = new Map([
  ['PASS', 'pass'],
  ['FAIL', 'fail'],
  ['FLAKY', 'flaky'],
]);

/**
 * Verdicts that are not a clean pass.
 *
 * `flaky` is in here for DISPLAY and ordering — a report that has to cut its
 * gate list keeps these first, because they are what the reader opened it for.
 * It is NOT a claim that the run failed: a `flakyIsPass: true` gate is FLAKY and
 * the run passed. The exit code says which, and it always did.
 */
export const NON_PASS_GATE_VERDICTS = new Set(['fail', 'flaky']);

/**
 * The gate id and verdict of one GATE line, or null when the line is not one.
 *
 * @param {string} line one line of a runner's output, already trimmed
 */
export function parseGateLine(line) {
  const match = GATE_LINE_RE.exec(String(line ?? ''));
  if (!match) return null;
  return { id: match[1], verdict: GATE_VERDICT_BY_LABEL.get(match[2]) };
}

/** The report's word for a gate whose two runs disagreed. */
export const FLAKY_GATE_VERDICT = 'flaky';

/**
 * Was this gate FLAKY?
 *
 * Asked by name rather than by a bare string comparison at each call site,
 * because every one of them has to resist the same temptation: the answer is NOT
 * "therefore the run failed" or "therefore it passed". `flakyIsPass` decided
 * that, the runner's exit code carries the decision, and neither is on the gate
 * line this verdict came from.
 */
export function isFlakyVerdict(verdict) {
  return String(verdict ?? '') === FLAKY_GATE_VERDICT;
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

// =============================================================================
// The agent harness — deny-by-default (Issue #177)
// =============================================================================
//
// The paths that make up the AGENT'S OWN HARNESS: the Skill packages the worker
// and its verifier ARE, and the CommandMate configuration that decides what
// "verified" means. A worker allowed to write there can pass its gate by
// rewriting the judge, so the planner keeps them out of `scope.allow` by default
// and a profile may not re-grant them (references/profile-contract.md §9.6). The
// full argument for hardcoding the set — rather than making it declarable — is
// at the planner's use site in orchestrate.mjs.
//
// Here rather than there because the refusal is part of reading a PROFILE, and
// two runners now read one: the planner refuses the declaration, and
// `profile-init.mjs --check` must refuse the same declaration for the same
// reason. A per-runner copy of a permission boundary is a permission boundary
// with a second, quieter door.
export const HARNESS_PATH_PREFIXES = ['.claude/skills/', '.agents/skills/', '.commandmate/'];

// `./`-prefixed forms are stripped first. A repository-relative path filter
// accepts `./.claude/skills/x.sh` (it escapes nothing), and a prefix test alone
// would read it as a non-harness path — a one-character bypass of a permission
// boundary. Every other escape (`..`, absolute, backslash) is already refused
// before a path reaches here, so this is the only normalisation needed.
export function isHarnessPath(path) {
  const normalized = path.replace(/^(?:\.\/)+/, '');
  return HARNESS_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// =============================================================================
// scope_companions — the rule vocabulary and its evaluation (Issues #149 / #181)
// =============================================================================
//
// Layer L2 of references/adr-scope-derivation.md. L1 (the planner's
// testScopeDefaultsFor) derives the CONVENTIONAL test path of every declared
// source file. What it cannot derive is a convention it has never heard of: a
// `spec/` tree mirroring `app/`, a generated `*_pb.ts` beside every `.proto`, a
// locale table regenerated from its source. The planner never opens the target
// repository, and dispatch must not observe the worktree either — a contract that
// depended on worktree state would stop being byte-identical across worktrees,
// which is the property dispatch-contract.md:212 rests on. The one place
// repository knowledge is already allowed to enter is the PROFILE, and the
// profile is part of the plan, so a declaration there keeps both properties
// (ADR §3).
//
// ---- Why this lives in lib.mjs (Issue #197) ---------------------------------
//
// Because a second runner now evaluates the same rules. `profile-init.mjs
// --check` counts, for each declared rule, how many real files in a repository
// tree its `when` matches and how many of the paths its `add` produces exist —
// which is the review question "is this rule doing anything?" that could
// previously only be answered by writing an issue fixture and reading
// `scope_defaults` out of a plan.
//
// A `--check` with its own reading of `{dir}` / `{base}` would make two truths
// out of one, and the divergence would be silent in the worst direction: a rule
// `--check` calls matched while the planner does not is precisely the "rule that
// never matches and never says so" the field's error handling is built around.
// So the vocabulary, the compiler and the matcher are written once, here, and
// both runners import them. The planner keeps only what is PLANNER POLICY —
// deduplication against paths it already has, the harness-template filter that
// depends on where a binding came from, and the `MAX_SCOPE_PATTERNS` bound.
//
// ---- The shape, and why this one -------------------------------------------
//
//   "scope_companions": {
//     "derive": [
//       { "when": "app/{dir}{base}.rb", "add": ["spec/{dir}{base}_spec.rb"] }
//     ],
//     "require": [
//       { "when": "scripts/{dir}{base}.mjs", "add": ["scripts/tests/shared-contract.test.mjs"] }
//     ]
//   }
//
// A `derive` rule is a pair of PATH TEMPLATES over one shared vocabulary. `when` matches a
// DECLARED path and binds its placeholders; `add` re-emits those bindings into
// concrete paths. Two placeholders exist, and they are the two pieces a companion
// convention is ever a function of:
//
//   {dir}   zero or more path segments, each with its trailing "/" (so it is ""
//           at the repository root). This is what makes a MIRROR expressible:
//           `app/{dir}{base}.rb` -> `spec/{dir}{base}_spec.rb` moves
//           app/models/user.rb to spec/models/user_spec.rb, prefix stripped.
//   {base}  exactly one path segment. Normally the file's stem, because the
//           extension is written literally in the template — which is also why
//           there is no `{ext}` yet: one rule per extension is more explicit, and
//           adding `{ext}` later is a compatible widening (§15.2 of the ADR).
//
// The three invariants of ADR §2 are structural properties of this shape rather
// than checks bolted onto it:
//
//   1. DERIVED FROM THE DECLARATION. There is no glob syntax at all: `*`, `?` and
//      `[` are refused in both templates, and the only wildcards are placeholders,
//      whose captured text is LITERALLY A SUBSTRING OF A DECLARED PATH. An `add`
//      must carry at least one placeholder bound by its `when`, so no rule can
//      grant a path that does not contain a piece of a path the issue declared.
//      `**/*.test.*` and a bare `docs/module-reference.md` are both rejected at
//      load time. A profile therefore cannot re-open the hole #50 closed, and
//      |closure| <= (total `add` entries) x |declared| holds by construction.
//   2. VISIBLE. The derivation returns a list the caller appends to
//      `scope_defaults` and `suspected_files` in one statement, exactly as L1's
//      does — the two cannot drift apart.
//   3. A PURE FUNCTION OF THE PLAN. The input is the profile, which is part of
//      the plan; nothing is read from disk, nothing is sorted, no Set is walked.
//
// Invariant 3 is about the PLANNER's use of these functions. `--check` reads a
// repository tree by construction — that is what it is for — and it is a separate
// runner precisely so that reading one never happens on the planner's path
// (references/profile-contract.md §9.1 is unchanged).
//
// ---- `require`: the companion no template can name (Issue #181) -------------
//
// ADR §15.2 left the constant companion out of the first cut and named the two
// things that would bring it in: a real case, and a KEY OF ITS OWN, so that the
// key name states that the added path is not derived from the declaration. Both
// arrived.
//
// The case is the AGGREGATE test — one file checking several modules against a
// shared contract, `scripts/tests/shared-contract.test.mjs`. Its name
// corresponds to no source name BY CONSTRUCTION; that is what makes it
// aggregate. L1 cannot reach it (L1 derives the conventional test path OF a
// source file) and neither can `derive` (every `add` there is a function of the
// declared path), so the only channel left was the issue body — which measured,
// on a live repository, as a standing instruction to every author of a
// `scripts/**` issue to write the path out by hand, and a worker losing its run
// to the scope gate whenever somebody forgot.
//
// A `require` rule is the same `{when, add}` pair with the roles of the two
// halves split: `when` still has to match a DECLARED path, so nothing is granted
// unconditionally and the closure is still bounded by what the issue declared,
// while `add` holds LITERAL paths and no placeholders at all.
//
// This does NOT loosen `derive`. A placeholder-free `add` is still a load_error
// there, and each key refuses the other's shape:
//
//   derive[].add    must carry >= 1 placeholder, every one bound by its `when`
//   require[].add   must carry ZERO placeholders, and each entry must be a
//                   repository-relative path outside the agent harness
//
// That pair is what keeps a MISTYPED TEMPLATE from silently becoming a literal —
// the one degradation this key could otherwise introduce. Braces are never
// ambiguous to begin with: parseCompanionTemplate tokenizes every `{...}` in
// both keys and refuses an unknown name or an unbalanced brace, so `{Base}`,
// `{ext}` and `{base` cannot be re-read as text anywhere. What remains is the
// typo that DROPS the braces — `spec/dir/base_spec.rb` written for
// `spec/{dir}{base}_spec.rb` — and that one is caught by the key it sits under:
// refused in `derive`, and legal only after being MOVED to a key whose name says
// the path is fixed. The discrimination is the author's stated intent, not a
// guess about the content.
//
// What none of that catches is the rule that is WELL FORMED AND MATCHES NOTHING,
// which is the gap Issue #197 opened `--check` for. It is not a load error —
// a declaration written ahead of the files it describes is legitimate — so it is
// reported, by a runner a human runs, and never adjudicated.
//
// Invariant 1 is genuinely weaker for `require` than for `derive`: a literal is
// not a function of the declared path, only gated on one. That is precisely why
// it is a separate key and not a widening of `add` — the strong statement holds
// where it was made, and the weaker one is legible at every use site. The bound
// is unchanged: |closure| <= (total `add` entries) x |declared|. Invariants 2
// and 3 hold identically — the literals join the same single list the caller
// appends to `scope_defaults` and `suspected_files`, and nothing is read from
// disk.
//
// Still out, for the reasons in ADR §15.2 and §18: an `{ext}` placeholder,
// per-rule exclusions, and any form that lets `when` match something other than
// a declared path. `require` did not touch that last one, which is what keeps
// "a profile cannot grant a path no issue asked for" true.

// The wildcard vocabulary. Order matters only for the error message; the regex
// fragments are what a `when` template compiles to. `{dir}` is greedy so
// `src/{dir}{base}.ts` reads `src/a/b/c.ts` as dir="a/b/", base="c" — the same
// split a human makes.
const COMPANION_PLACEHOLDERS = {
  dir: '((?:[^/]+/)*)',
  base: '([^/]+)',
};

// Anything brace-shaped is a placeholder attempt. Captured loosely on purpose:
// `{Base}` and `{ext}` must be REFUSED, not silently treated as literal text —
// a typo that becomes a literal is a rule that never matches and never says so.
const COMPANION_TOKEN_RE = /\{([^{}]*)\}/g;

// Glob metacharacters, refused in both templates. This is the check that makes
// "a profile cannot write a bare glob" true rather than merely discouraged.
const COMPANION_GLOB_RE = /[*?[\]]/;

// Every refusal in this section is `load_error` (exit 6), the same code an
// unknown profile field gets, and it names the FIELD rather than a runner: a
// declaration one reader had to repair is a declaration whose author should be
// told, and both readers must say the same thing about it.
export function companionError(detail) {
  return new SkillError('load_error', `profile.scope_companions: ${detail}`, 6);
}

// Splits a template into literal spans and placeholder names. Throws load_error
// on anything that is not a well-formed template, so a malformed declaration is
// refused where the profile is read rather than producing a rule that quietly
// matches nothing.
export function parseCompanionTemplate(text, label) {
  if (typeof text !== 'string' || text.length === 0) {
    throw companionError(`${label} must be a non-empty string`);
  }
  if (COMPANION_GLOB_RE.test(text)) {
    throw companionError(
      `${label} "${text}" contains a glob metacharacter; companions are derived from declared paths, ` +
        'never matched by a pattern of their own (adr-scope-derivation.md §2, invariant 1). ' +
        // A `when` is where an author reaches for a glob, and the two shapes they
        // reach for have exact spellings in this vocabulary. Issue #181 proposed
        // its own rule as `"when": "scripts/**"`, so the message that refuses it
        // has to carry the translation rather than leave the author guessing
        // which of `{dir}` / `{base}` covers a whole subtree.
        'In a "when", write "{dir}{base}" where you would write "**" and "{base}" where you would write "*"',
    );
  }
  if (text.startsWith('/') || text.includes('..') || text.includes('\\')) {
    throw companionError(`${label} "${text}" must be a relative repository path with no ".." segment`);
  }
  const parts = [];
  const names = [];
  let cursor = 0;
  for (const match of text.matchAll(COMPANION_TOKEN_RE)) {
    const name = match[1];
    if (!Object.prototype.hasOwnProperty.call(COMPANION_PLACEHOLDERS, name)) {
      throw companionError(
        `${label} "${text}" uses unknown placeholder "{${name}}"; the placeholders are ` +
          Object.keys(COMPANION_PLACEHOLDERS).map((key) => `{${key}}`).join(' / '),
      );
    }
    if (match.index > cursor) parts.push({ literal: text.slice(cursor, match.index) });
    parts.push({ name });
    names.push(name);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ literal: text.slice(cursor) });
  // A stray brace left in a literal span means the template was not fully
  // tokenized (`{dir` , `dir}`), which is a typo, not a path.
  for (const part of parts) {
    if (part.literal !== undefined && /[{}]/.test(part.literal)) {
      throw companionError(`${label} "${text}" has an unbalanced brace`);
    }
  }
  return { parts, names };
}

// Validates the declaration and returns it in canonical form, or null when the
// profile does not carry the key.
//
// `checkLiteral` is the one refusal this module does not own. It is called for
// every `require[].add` entry, in written order, at the point the per-template
// loop reaches it, and the planner passes the predicate that decides whether a
// literal is repository-relative at all (`users/…`, `C:/…`, `https://…` — a
// vocabulary whose constant, SYSTEM_ROOTS, is byte-mirrored by
// cmate-issue-authoring and therefore has to stay declared in orchestrate.mjs;
// see tests/fixtures/cmate-issue-authoring/mirror-conformance.mjs). A caller that
// passes nothing — `profile-init.mjs --check`, which grants no permissions —
// skips exactly that refusal and reports the literal as a path that does not
// exist in the tree, which is what it is. Everything else, including the harness
// boundary of §9.6, is enforced for every caller.
export function normalizeScopeCompanions(raw, { checkLiteral } = {}) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw companionError('must be a JSON object');
  }
  // An OBJECT rather than a bare list, so a later layer of this feature arrives
  // as a sibling KEY instead of overloading the meaning of the list. `require`
  // (Issue #181) is that mechanism used once, exactly as ADR §15.2 said the
  // constant companion would have to arrive. Unknown keys are refused for the
  // reason profile fields are: a newer profile must fail loudly on an older
  // runner, never have half of itself ignored.
  for (const key of Object.keys(raw)) {
    if (key !== 'derive' && key !== 'require') {
      throw companionError(`unknown key "${key}"; the keys are "derive" and "require"`);
    }
  }
  // Both keys are optional and ABSENCE IS PRESERVED — the canonical form carries
  // only what the profile wrote, so a `derive`-only declaration echoes into the
  // plan as the same bytes it did before `require` existed. A key filled in with
  // an empty list would be a byte in `plan.profile` that was never in the
  // profile, which is the compatibility property fixture 45 measures one level
  // up (see the ABSENT-stays-absent note in normalizeProfile).
  if (raw.derive === undefined && raw.require === undefined) {
    throw companionError(
      'must declare "derive" and/or "require"; an empty object states nothing about the repository, ' +
        'where {"derive": []} states that there is no convention to declare',
    );
  }
  const out = {};
  if (raw.derive !== undefined) out.derive = normalizeCompanionRules(raw.derive, 'derive', checkLiteral);
  if (raw.require !== undefined) out.require = normalizeCompanionRules(raw.require, 'require', checkLiteral);
  return out;
}

// One validator for both keys, because everything except the `add` side is the
// same statement: a rule is `{when, add}`, `when` is a template over the shared
// vocabulary, and `add` is a non-empty list. `kind` decides the two rules that
// differ, and both are stated as REFUSALS so that neither key can quietly accept
// what the other's typo produces.
function normalizeCompanionRules(rawRules, kind, checkLiteral) {
  if (!Array.isArray(rawRules)) throw companionError(`"${kind}" must be an array of rules`);
  const rules = [];
  for (const [index, rule] of rawRules.entries()) {
    const at = `${kind}[${index}]`;
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw companionError(`${at} must be a JSON object`);
    }
    for (const key of Object.keys(rule)) {
      if (key !== 'when' && key !== 'add') throw companionError(`${at} has an unknown key "${key}"`);
    }
    const when = parseCompanionTemplate(rule.when, `${at}.when`);
    // A `when` that binds nothing is a rule that can only match one fixed path.
    // In `derive` that is a contradiction — there would be no binding to write
    // back, so the `add` could not be a function of the declaration and would be
    // refused below anyway. In `require` it is a COMPLETE rule: "if the issue
    // declares this file, it may also touch that one", still gated on the
    // declaration, and the most precise gate an author can write.
    if (kind === 'derive' && when.names.length === 0) {
      throw companionError(
        `${at}.when "${rule.when}" binds no placeholder, so it can only match one fixed path; ` +
          'a rule that adds nothing derived from the declaration is not a companion rule ' +
          '(a fixed "when" is legal under "require", whose "add" is a literal path)',
      );
    }
    // Refused in both keys. The compiler gives each placeholder its own capture
    // group rather than requiring the two to be equal, so a repeat does not mean
    // what it looks like it means in either key.
    if (new Set(when.names).size !== when.names.length) {
      throw companionError(`${at}.when "${rule.when}" repeats a placeholder; each may appear once`);
    }
    if (!Array.isArray(rule.add) || rule.add.length === 0) {
      throw companionError(`${at}.add must be a non-empty array of path templates`);
    }
    const bound = new Set(when.names);
    for (const template of rule.add) {
      const parsed = parseCompanionTemplate(template, `${at}.add`);
      if (kind === 'derive') {
        if (parsed.names.length === 0) {
          throw companionError(
            `${at}.add "${template}" contains no placeholder, so it would grant a path unrelated to ` +
              'anything the issue declared (adr-scope-derivation.md §2, invariant 1). ' +
              'A companion whose name is genuinely fixed — an aggregate contract test, a required ' +
              'document — is declared under "require", where the path is literal by definition',
          );
        }
        for (const name of parsed.names) {
          if (!bound.has(name)) {
            throw companionError(`${at}.add "${template}" uses {${name}}, which its "when" does not bind`);
          }
        }
      } else {
        // The inverse refusal, and the reason a dropped-braces typo cannot cross
        // between the keys: a template written here is a `derive` rule filed
        // under the wrong key, and emitting it would put the characters
        // "{base}" into a worker's scope.allow.
        if (parsed.names.length > 0) {
          throw companionError(
            `${at}.add "${template}" must be a literal path: a "require" companion is granted as written, ` +
              `so it has no binding to expand {${parsed.names[0]}} from. Move the rule to "derive" if the ` +
              'path is a function of the declared one',
          );
        }
        // A literal is the ONLY companion shape not built out of a path the
        // extraction already vetted, so it is the only one that could name
        // something outside the repository. Without this, a profile is a path
        // traversal: `users/<someone>/…` is repository-relative in form and
        // absolute in effect. `..`, a leading "/" and a backslash are refused by
        // the template parser above; a system root, a drive letter and a URL host
        // are refused only by the caller's predicate.
        if (checkLiteral !== undefined) checkLiteral(template, at);
        // Issue #177's boundary, held on the profile side. The harness deny-list
        // is what protects the judge from the judged, and #177 refused to make it
        // declarable precisely so that a `scope_companions`-style key could not
        // become its second, quieter door. Refused at LOAD because a literal is
        // decidable here, and because a rule silently dropped later is a rule
        // that never says so. The escape hatch is unchanged and stays in the
        // issue body, where a warning is attached to using it.
        if (isHarnessPath(template)) {
          throw companionError(
            `${at}.add "${template}" is part of the agent harness ` +
              `(${HARNESS_PATH_PREFIXES.join(' / ')}) — the Skill packages the worker and its verifier are, ` +
              'and the config that decides what "verified" means. The planner keeps those out of scope.allow ' +
              'by default (Issue #177) and a profile may not re-grant them: the issue that really must edit ' +
              'one names it under a deliverable heading, which is reported as harness_path_in_scope',
          );
        }
      }
    }
    rules.push({ when: String(rule.when), add: rule.add.map(String) });
  }
  return rules;
}

// Turns a validated declaration into matchers. Cannot throw: every template here
// already passed normalizeScopeCompanions.
//
// The two keys compile to ONE ordered list, `derive` first, because a rule is a
// rule once its `add` is a list of template parts: a literal `add` is simply a
// parts list with no placeholder in it, and the emitter below treats it that way
// without a branch. Declaration order is preserved so the derivation stays a
// pure function of (plan, profile).
//
// Each compiled rule also carries where it came from — `key`, `index`, and the
// SOURCE text of `when` and each `add`. The planner ignores all four; they exist
// so `--check` can report per rule, in the author's own words, without keeping a
// parallel copy of the declaration and risking the two falling out of step.
export function compileScopeCompanions(declaration) {
  if (!declaration) return [];
  const rules = [
    ...(declaration.derive ?? []).map((rule, index) => ({ rule, key: 'derive', index })),
    ...(declaration.require ?? []).map((rule, index) => ({ rule, key: 'require', index })),
  ];
  return rules.map(({ rule, key, index }) => {
    const when = parseCompanionTemplate(rule.when, 'when');
    const source = when.parts
      .map((part) => (part.name === undefined
        ? part.literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        : COMPANION_PLACEHOLDERS[part.name]))
      .join('');
    return {
      key,
      index,
      when: rule.when,
      addTemplates: rule.add.map(String),
      match: new RegExp(`^${source}$`),
      names: when.names,
      add: rule.add.map((template) => parseCompanionTemplate(template, 'add').parts),
    };
  });
}

// THE matcher. Every companion the compiled rules produce for ONE path, rule by
// rule in declaration order and then `add` by `add` in written order, each paired
// with the rule that produced it and the index of the template inside that rule.
//
// Nothing is filtered, deduplicated, sorted or bounded here, and that is the
// whole of the division of labour: what a rule SAYS about a path is this
// function, and what a caller then DOES with the answer is the caller's. The
// planner drops harness expansions and stops at MAX_SCOPE_PATTERNS; `--check`
// counts. Neither policy can change what "matches" means for the other.
export function companionsForPath(rules, path) {
  const out = [];
  for (const rule of rules) {
    const matched = rule.match.exec(path);
    if (matched === null) continue;
    const binding = {};
    rule.names.forEach((name, index) => { binding[name] = matched[index + 1]; });
    for (const [at, parts] of rule.add.entries()) {
      out.push({
        rule,
        at,
        companion: parts
          .map((part) => (part.name === undefined ? part.literal : binding[part.name]))
          .join(''),
      });
    }
  }
  return out;
}
