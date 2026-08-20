#!/usr/bin/env node
// cmate-orchestrate — read-only inspection runner (Node stdlib only, Node >= 22).
//
// Issue #217.
//
// The planner's input is the issue's number / title / body / labels and nothing
// else: it never opens the target repository (references/profile-contract.md
// §9.1). That is a design invariant and this runner does not touch it. What it
// closes is the hole the invariant leaves open — nothing on the way to dispatch
// ever checks whether the FACTS THE BODY ASSERTS are still true.
//
// Measured in Kewton/CommandMate#1831 (Kewton/BorderFreeKidsMap): 16 issues of
// one epic dispatched in a day, and 11 of the 16 had a body the tree had moved
// out from under. `repository.ts` was written as 1,070 lines and measured 1,129;
// five `path:line` citations in one body were all off (`:979` → `:1038`); an
// acceptance criterion said "the e2e suite still has 130 tests" when it had 136,
// so satisfying the issue AS WRITTEN meant deleting the six an earlier issue had
// added. The workaround was a human collating sixteen bodies by hand.
//
// So: a separate runner, with `profile-init.mjs --check`'s discipline
// (references/profile-contract.md §9.7) —
//
//   IT WRITES NOTHING into the plan and nothing into the repository. `--out`
//   writes the report where the operator names it, and refuses to clobber.
//
//   IT DOES NOT ADJUDICATE. Every finding is a warning, `status` becomes
//   `partial`, and the exit stays 0. A body that is out of date is not a body
//   that must not be dispatched — a human reads the report and decides.
//
//   IT REFUSES WHAT IT CANNOT READ. A missing `--repo-root`, an unreadable
//   issue fixture and a `--ref` git will not resolve stop the run instead of
//   producing an inspection over a subset nobody chose. "We checked" and "we
//   could not look" must not come back in the same envelope.
//
// It is NOT `profile-init.mjs --check`, on purpose: that mode holds "no
// subprocess, no network" as a property (§9.7), and `--ref` here shells out to
// `git show`. Bolting this onto it would quietly retire that property. The
// follow-up work — evaluating an issue's declared acceptance gates against the
// base before dispatch — runs commands too, and belongs on this runner.
//
// ---- What it can and cannot decide ------------------------------------------
//
// Only claims a machine can settle: does the file exist, does the line exist,
// is the identifier still on that line, is the line count still that number.
// A body that CONTRADICTS ITSELF in prose — a 決定事項 that the 受入条件 then
// rules out — is not in scope and never will be; that reading is
// cmate-issue-refinement Step 4's, and a runner that pretended to do it would
// be inventing a verdict. The one contradiction reported here is the mechanical
// subset: two different line counts for the same path, or one `path:line`
// bound to two different identifiers.
//
// Spelling variants (`web/src/lib/filter.ts` vs `src/lib/filter.ts`) are the
// planner's `ambiguous_file_candidate` (plan-contract.md §5.4) and are not
// re-detected here. Such a candidate is NOT inspected — at most one of the two
// spellings is the file the author means, and the runner does not get to choose
// — and the count of what it skipped is in the report.

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import {
  SKILL_ID,
  SKILL_VERSION,
  SkillError,
  redact,
} from './lib.mjs';

// The planner's own reading of a body, imported rather than copied. A citation
// the planner does not turn into a candidate is a citation the plan never
// carried, so checking one would be reporting about a different document than
// the one that was planned (see the export block at the end of orchestrate.mjs).
import {
  extractFileCandidates,
  loadIssuesFromFixture,
  fetchIssueWithGh,
  FILE_EXT,
  PATH_START,
  CANDIDATE_BACKTICK,
  CANDIDATE_KNOWN_ROOT,
  CANDIDATE_WITH_EXT,
} from './orchestrate.mjs';

const INSPECT_SCHEMA_VERSION = 1;

const USAGE = `cmate-orchestrate inspection runner (read-only, never adjudicates)

Usage:
  inspect.mjs --check-references [--repo-root <path>] [--ref <rev>] <issue>...
  inspect.mjs --check-references [--repo-root <path>] --issue-json <path>

Options:
  --check-references     Check the path:line and "N 行" claims an issue body
                         makes against the tree under --repo-root.
  --repo-root <path>     The checkout to check against. Default: cwd.
  --ref <rev>            Read the files out of this git revision instead of the
                         working tree. Resolved with git rev-parse first.
  --issues <n>[,<n>]     Issue numbers (repeatable). Bare numbers work too.
  --issue-json <path>    Issue fixture, same format as orchestrate.mjs
                         (plan-contract.md §1.1). No GitHub access. Without
                         --issues, every issue in the fixture is inspected.
  --repo <owner/name>    Repository to read issues from when there is no
                         fixture. Default: the origin remote of --repo-root.
  --out <path>           Write the report here as well as to stdout. Refuses an
                         existing path.
  -h, --help             This text.

Findings are warnings: status becomes partial and the exit stays 0. Input this
runner cannot read is refused (exit 3 / 4 / 6) and nothing is inspected.`;

// =============================================================================
// Input
// =============================================================================

function parseCli(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'check-references': { type: 'boolean' },
        'repo-root': { type: 'string' },
        ref: { type: 'string' },
        issues: { type: 'string', multiple: true },
        'issue-json': { type: 'string' },
        repo: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new SkillError('invalid_input', redact(error.message), 3);
  }
}

// Issue numbers arrive as positionals (`inspect.mjs --check-references 231 234`)
// and as --issues values, which may be repeated or comma-separated. All three
// spellings appear in the Issue that asked for this runner, so all three are
// read; anything that is not an integer is refused rather than coerced, for the
// reason plan-contract.md §1.1 gives — a mistyped number that is READ plans, or
// here inspects, a DIFFERENT issue.
function issueNumbers(parsed) {
  const raw = [...parsed.positionals, ...(parsed.values.issues ?? [])]
    .flatMap((value) => String(value).split(/[\s,]+/))
    .filter((value) => value !== '');
  const numbers = [];
  for (const token of raw) {
    if (!/^[0-9]+$/.test(token)) {
      throw new SkillError('invalid_input', `issue number is not an integer: ${redact(token)}`, 3);
    }
    const number = Number(token);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new SkillError('invalid_input', `issue number is out of range: ${redact(token)}`, 3);
    }
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

function resolveInputs(parsed) {
  const values = parsed.values;

  // The mode is required rather than defaulted. This runner is where the
  // read-only checks that DO run commands accumulate (the acceptance-gate
  // pre-evaluation is the next one), and a default mode would make "which check
  // did I just run" a function of the version installed.
  if (values['check-references'] !== true) {
    throw new SkillError(
      'invalid_input',
      'no inspection was requested. Pass --check-references (the only mode this version has)',
      3,
    );
  }

  const repoRootArg = values['repo-root'] ?? process.cwd();
  if (String(repoRootArg).trim() === '') {
    throw new SkillError('invalid_input', '--repo-root must name a directory', 3);
  }
  const repoRoot = resolve(String(repoRootArg));
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    // Refused, not defaulted to cwd: an inspection run against the wrong tree
    // reports mismatches that say nothing about the issue.
    throw new SkillError('load_error', `no directory at --repo-root ${redact(repoRoot)}`, 6);
  }

  const ref = values.ref === undefined ? null : String(values.ref);
  if (ref !== null && (ref.trim() === '' || ref.startsWith('-'))) {
    throw new SkillError('invalid_input', `--ref is not a revision: ${redact(ref)}`, 3);
  }

  const issueJson = values['issue-json'] ?? null;
  if (issueJson !== null && String(issueJson).trim() === '') {
    throw new SkillError('invalid_input', '--issue-json must name a JSON file', 3);
  }

  const out = values.out ?? null;
  if (out !== null) {
    if (String(out).trim() === '') {
      throw new SkillError('invalid_input', '--out must name a file', 3);
    }
    if (existsSync(out)) {
      throw new SkillError('out_exists', `--out ${redact(out)} already exists; this runner does not overwrite`, 4);
    }
  }

  const numbers = issueNumbers(parsed);
  if (numbers.length === 0 && issueJson === null) {
    throw new SkillError(
      'invalid_input',
      'no issue was named. Pass issue numbers, or --issue-json to inspect every issue in a fixture',
      3,
    );
  }

  return { repoRoot, ref, issueJson: issueJson === null ? null : String(issueJson), repo: values.repo ?? null, out, numbers };
}

// =============================================================================
// The issues
// =============================================================================

// Which issues a fixture declares, so `--issue-json` without `--issues` can
// inspect all of them. Anything unreadable is left for loadIssuesFromFixture to
// refuse — it owns what a fixture IS (plan-contract.md §1.1), and a second
// opinion here would be a second set of messages to keep in step.
function fixtureIssueNumbers(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    loadIssuesFromFixture([], path);
    return [];
  }
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.issues) ? raw.issues : null;
  if (items === null) {
    loadIssuesFromFixture([], path);
    return [];
  }
  const numbers = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item.number;
    if (typeof value === 'number' && Number.isSafeInteger(value)) numbers.push(value);
    else if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) numbers.push(Number(value));
  }
  return numbers;
}

const ORIGIN_SLUG_RE = /(?:github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\s*$/;

function originSlug(repoRoot) {
  try {
    const url = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const matched = ORIGIN_SLUG_RE.exec(url);
    return matched === null ? null : matched[1];
  } catch {
    return null;
  }
}

function loadIssues(inputs) {
  if (inputs.issueJson !== null) {
    const numbers = inputs.numbers.length > 0 ? inputs.numbers : fixtureIssueNumbers(inputs.issueJson);
    if (numbers.length === 0) {
      throw new SkillError('load_error', `--issue-json ${redact(inputs.issueJson)} declares no issues`, 6);
    }
    return loadIssuesFromFixture(numbers, inputs.issueJson);
  }
  const repo = inputs.repo ?? originSlug(inputs.repoRoot);
  if (repo === null) {
    throw new SkillError(
      'invalid_input',
      'no repository to read issues from: pass --repo <owner/name>, or --issue-json to run offline',
      3,
    );
  }
  return inputs.numbers.map((number) => fetchIssueWithGh(number, repo));
}

// =============================================================================
// The tree
// =============================================================================

// `git rev-parse` is what decides whether a revision exists, so it is what is
// asked. A `--ref` it cannot resolve is refused: reading the working tree
// instead would report the wrong tree's line numbers under the operator's ref.
function resolveRef(repoRoot, ref) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new SkillError(
      'load_error',
      `--ref ${redact(ref)} does not resolve to a commit in ${redact(repoRoot)}`,
      6,
    );
  }
}

// Recorded, never required: with no --ref the working tree is what was read, and
// the report says which commit it was sitting on so a reader can reproduce it.
// A --repo-root that is not a git repository at all is still inspectable.
function headOf(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// `wc -l` counts newline CHARACTERS, so a file whose last line has no newline
// comes back one short of what an editor shows and one short of what an author
// counts when they write "N 行". The measure here is the number of ADDRESSABLE
// lines: the same as `wc -l` for a newline-terminated file, one more for a file
// without a trailing newline, and 0 for an empty one. Fixed here because a line
// count that is right or wrong by convention is a warning nobody can act on.
function countLines(text) {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

// Reads one repository-relative path, at the ref if there is one, and caches the
// answer: a body cites the same file five times and the fifth read must not be a
// fifth subprocess.
function makeFileReader(repoRoot, ref) {
  const cache = new Map();
  const root = resolve(repoRoot);
  const read = (path) => {
    if (ref !== null) {
      let kind;
      try {
        kind = execFileSync('git', ['-C', root, 'cat-file', '-t', `${ref}:${path}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return { exists: false, text: null, lines: 0 };
      }
      if (kind !== 'blob') return { exists: false, text: null, lines: 0 };
      const text = execFileSync('git', ['-C', root, 'show', `${ref}:${path}`], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { exists: true, text, lines: countLines(text) };
    }
    // The candidate already passed the planner's isSafeRepoPath, which refuses
    // "..", a leading "/" and a drive letter. Re-checked against the resolved
    // path anyway: this is the line that says "nothing outside --repo-root is
    // read", and it should be true because it is enforced, not because an
    // earlier function is believed.
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(root + sep)) return { exists: false, text: null, lines: 0 };
    if (!existsSync(full) || !statSync(full).isFile()) return { exists: false, text: null, lines: 0 };
    const text = readFileSync(full, 'utf8');
    return { exists: true, text, lines: countLines(text) };
  };
  return (path) => {
    if (!cache.has(path)) cache.set(path, read(path));
    return cache.get(path);
  };
}

// =============================================================================
// Reading the claims out of a body
// =============================================================================

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Everything the three planner patterns matched, minus what the extraction
// kept. What is left was refused by isSafeRepoPath — a "..", an absolute path,
// a system root, a URL host — and the report names it rather than staying
// silent, because "we did not inspect that citation" is a fact about the run.
// The patterns are the planner's own sources, so this cannot drift into a
// second candidate vocabulary.
const CANDIDATE_PATTERNS = [CANDIDATE_BACKTICK, CANDIDATE_KNOWN_ROOT, CANDIDATE_WITH_EXT];

function droppedCandidates(text, kept) {
  const seen = new Set(kept);
  const dropped = [];
  for (const source of CANDIDATE_PATTERNS) {
    for (const match of text.matchAll(new RegExp(source, 'g'))) {
      const candidate = match[1].trim();
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      dropped.push(candidate);
    }
  }
  return dropped;
}

// A backtick token on the same line as the citation, which is how a body says
// what it expects to find AT that line ("`resolveLauncher` — lib.mjs:309").
// Restricted to identifier shapes, and a token that ends in one of the
// planner's own file extensions is not one: `filter.ts` next to
// `src/lib/filter.ts:42` is the path again, and searching a file for its own
// name would report every citation as moved.
const BACKTICK_SPAN = /`([^`]+)`/g;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const FILE_LIKE_TOKEN_RE = new RegExp(`\\.(?:${FILE_EXT})$`, 'i');

function identifierOn(line) {
  for (const match of line.matchAll(BACKTICK_SPAN)) {
    const token = match[1].trim().replace(/\(\)$/, '');
    if (!IDENTIFIER_RE.test(token)) continue;
    if (FILE_LIKE_TOKEN_RE.test(token)) continue;
    return token;
  }
  return null;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let at = 0; at < index; at += 1) if (text[at] === '\n') line += 1;
  return line;
}

// `<path>:N` and `<path>:N-M`, anchored with the planner's own PATH_START so a
// candidate that is a suffix of another one cannot match from the middle of it.
function citationsOf(body, path) {
  const pattern = new RegExp(`${PATH_START}${escapeForRegExp(path)}:([0-9]+)(?:-([0-9]+))?`, 'g');
  const found = [];
  const lines = body.split('\n');
  for (const match of body.matchAll(pattern)) {
    const at = lineNumberAt(body, match.index);
    found.push({
      path,
      line: Number(match[1]),
      line_end: match[2] === undefined ? null : Number(match[2]),
      body_line: at,
      identifier: identifierOn(lines[at - 1] ?? ''),
    });
  }
  return found;
}

// `<path>（N 行）` / `<path> N 行` / `<path> は N 行`, with the closing backtick
// of a quoted path and a thousands separator both allowed, because that is how
// the bodies this runner exists for are actually written (`repository.ts` は
// 1,070 行). Nothing looser: a number that is not adjacent to the path is a
// number about something else.
const LINE_CLAIM_TAIL = '`?\\s*(?:は|が)?\\s*[（(]?\\s*([0-9][0-9,]*)\\s*行';

function lineClaimsOf(body, path) {
  const pattern = new RegExp(`${PATH_START}${escapeForRegExp(path)}${LINE_CLAIM_TAIL}`, 'g');
  const claims = [];
  for (const match of body.matchAll(pattern)) {
    claims.push({ path, claimed: Number(match[1].replace(/,/g, '')), body_line: lineNumberAt(body, match.index) });
  }
  return claims;
}

// =============================================================================
// The inspection
// =============================================================================

function warn(warnings, code, issue, detail, extra = {}) {
  warnings.push({ code, issue, detail, ...extra });
}

function inspectIssue(issue, readFile, warnings) {
  const body = issue.body ?? '';
  const extraction = extractFileCandidates(body);
  // Both spellings of a shadowed pair are skipped. The planner asks the author
  // which one it is (`ambiguous_file_candidate`); this runner cannot ask, and
  // picking one would produce a finding about a file the issue may not mean.
  const ambiguous = new Set();
  for (const pair of extraction.shadowed) {
    ambiguous.add(pair.path);
    ambiguous.add(pair.covered_by);
  }
  const dropped = droppedCandidates(body, extraction.paths);
  const inspectable = extraction.paths.filter((path) => !ambiguous.has(path));

  const references = [];
  const lineClaims = [];
  // path -> the distinct line counts the body claims for it; `path:line` -> the
  // distinct identifiers it binds. Both are the mechanical half of "the body
  // disagrees with itself" (§3 of the Issue); the semantic half is not here.
  const claimedByPath = new Map();
  const identifiersByCitation = new Map();

  for (const path of inspectable) {
    const file = readFile(path);
    for (const citation of citationsOf(body, path)) {
      const key = `${path}:${citation.line}`;
      if (citation.identifier !== null) {
        if (!identifiersByCitation.has(key)) identifiersByCitation.set(key, new Set());
        identifiersByCitation.get(key).add(citation.identifier);
      }
      references.push({ ...citation, file });
    }
    for (const claim of lineClaimsOf(body, path)) {
      if (!claimedByPath.has(path)) claimedByPath.set(path, []);
      if (!claimedByPath.get(path).includes(claim.claimed)) claimedByPath.get(path).push(claim.claimed);
      lineClaims.push({ ...claim, file });
    }
  }

  const reported = [];
  for (const reference of references) {
    const { path, line, line_end: lineEnd, identifier, body_line: bodyLine, file } = reference;
    const entry = {
      path,
      line,
      line_end: lineEnd,
      identifier,
      body_line: bodyLine,
      measured_lines: file.exists ? file.lines : null,
      found_at: null,
      verdict: 'ok',
    };
    if (!file.exists) {
      entry.verdict = 'file_missing';
      warn(warnings, 'reference_file_missing', issue.number, `${path}:${line} — 本文が引く file が対象 tree に無い`, { path, line });
    } else if (Math.max(line, lineEnd ?? line) > file.lines) {
      entry.verdict = 'line_out_of_range';
      warn(
        warnings,
        'reference_line_out_of_range',
        issue.number,
        `${path}:${lineEnd === null ? line : `${line}-${lineEnd}`} — 実測 ${file.lines} 行しか無い`,
        { path, line, line_end: lineEnd, measured: file.lines },
      );
    } else if (identifier !== null) {
      const lines = file.text.split('\n');
      const from = line - 1;
      const to = (lineEnd ?? line) - 1;
      let onCitedLine = false;
      for (let at = from; at <= to && !onCitedLine; at += 1) {
        if ((lines[at] ?? '').includes(identifier)) onCitedLine = true;
      }
      if (onCitedLine) {
        entry.verdict = 'ok';
      } else {
        const foundAt = lines.findIndex((text) => text.includes(identifier));
        if (foundAt === -1) {
          // The identifier is nowhere in the file, so the premise that it IS an
          // identifier of this file is what failed — not the line number. A
          // "moved" warning here would be a verdict on a word in prose, which
          // is the adjudication this runner does not do. Counted, not warned.
          entry.verdict = 'identifier_absent';
        } else {
          entry.verdict = 'identifier_moved';
          entry.found_at = foundAt + 1;
          warn(
            warnings,
            'reference_identifier_moved',
            issue.number,
            `${path}:${line} — \`${identifier}\` は実測 ${foundAt + 1} 行目にある`,
            { path, line, identifier, found_at: foundAt + 1 },
          );
        }
      }
    } else {
      // A citation with no identifier beside it is a line number and nothing to
      // check it against. The file and the range were checked; the report says
      // so rather than counting it as agreement.
      entry.verdict = 'unchecked';
    }
    reported.push(entry);
  }

  const reportedClaims = [];
  const inconsistentPaths = new Set(
    [...claimedByPath.entries()].filter(([, values]) => values.length > 1).map(([path]) => path),
  );
  const claimWarned = new Set();
  for (const claim of lineClaims) {
    const { path, claimed, body_line: bodyLine, file } = claim;
    const entry = {
      path,
      claimed,
      measured: file.exists ? file.lines : null,
      body_line: bodyLine,
      verdict: 'ok',
    };
    if (inconsistentPaths.has(path)) {
      // Two different counts for one path: which of them the author meant is not
      // decidable here, so the stale-count warning is NOT also raised. The
      // measurement is carried in this warning's detail — it is the same next
      // action either way (reconcile the body against the file).
      entry.verdict = 'inconsistent';
      if (!claimWarned.has(path)) {
        claimWarned.add(path);
        warn(
          warnings,
          'reference_claim_inconsistent',
          issue.number,
          `${path} — 本文が ${claimedByPath.get(path).join(' 行 / ')} 行と2通り主張している` +
            `（実測 ${file.exists ? `${file.lines} 行` : 'file 無し'}）`,
          { path, claimed: claimedByPath.get(path), measured: file.exists ? file.lines : null },
        );
      }
    } else if (!file.exists) {
      entry.verdict = 'file_missing';
      warn(warnings, 'reference_file_missing', issue.number, `${path} — 行数を主張している file が対象 tree に無い`, { path });
    } else if (claimed !== file.lines) {
      entry.verdict = 'stale';
      warn(
        warnings,
        'reference_line_count_stale',
        issue.number,
        `${path} — 本文は ${claimed} 行、実測は ${file.lines} 行`,
        { path, claimed, measured: file.lines },
      );
    }
    reportedClaims.push(entry);
  }

  for (const [key, identifiers] of identifiersByCitation) {
    if (identifiers.size < 2) continue;
    const [path, line] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
    warn(
      warnings,
      'reference_claim_inconsistent',
      issue.number,
      `${key} — 本文が同じ行に ${[...identifiers].map((name) => `\`${name}\``).join(' / ')} を結び付けている`,
      { path, line: Number(line), identifiers: [...identifiers] },
    );
  }

  return {
    number: issue.number,
    candidates: extraction.paths.length,
    inspected: inspectable.length,
    ambiguous: extraction.shadowed.map((pair) => ({ path: pair.path, covered_by: pair.covered_by })),
    dropped,
    references: reported,
    line_claims: reportedClaims,
  };
}

// =============================================================================
// Reporting
// =============================================================================

const CODE_LABELS = {
  reference_file_missing: 'file が無い',
  reference_line_out_of_range: '行番号が範囲外',
  reference_identifier_moved: '識別子が別の行',
  reference_line_count_stale: '行数の主張が古い',
  reference_claim_inconsistent: '本文内で主張が食い違う',
};

function renderSummary({ inspection, warnings }) {
  const issues = inspection.issues;
  const totalReferences = issues.reduce((sum, issue) => sum + issue.references.length, 0);
  const totalClaims = issues.reduce((sum, issue) => sum + issue.line_claims.length, 0);
  const skipped = issues.reduce((sum, issue) => sum + issue.ambiguous.length, 0);
  const droppedCount = issues.reduce((sum, issue) => sum + issue.dropped.length, 0);
  const lines = [
    '## 目的',
    'Issue 本文が主張する事実（`path:line` と「N 行」）を、対象リポジトリの実物に突き合わせた' +
      '（read-only・**裁定しない**・plan には何も書かない）。',
    '',
    '## 結論',
    `Issue ${issues.length} 件 / 参照 ${totalReferences} 件 / 行数主張 ${totalClaims} 件を、` +
      `${inspection.ref === null ? `working tree（HEAD ${inspection.head ?? '不明'}）` : `\`${inspection.ref}\`（${inspection.resolved_ref}）`}に対して点検した。` +
      `**ずれ ${warnings.length} 件。**` +
      (warnings.length === 0 ? ' 本文と実物は一致している。' : ' 下記はすべて warning であり、dispatch を止めない。'),
  ];
  if (skipped > 0 || droppedCount > 0) {
    lines.push(
      '',
      '## 点検対象外',
      ...(skipped > 0
        ? [`- 表記ゆれ（\`ambiguous_file_candidate\` 相当）の候補 ${skipped} 件。どちらの綴りが対象かを決めるのは著者であり、この runner は選ばない。`]
        : []),
      ...(droppedCount > 0
        ? [`- planner と同じ規則で候補になる前に落ちた path ${droppedCount} 件（\`..\` / 絶対 path / system root / URL host）。`]
        : []),
    );
  }
  for (const issue of issues) {
    const mine = warnings.filter((warning) => warning.issue === issue.number);
    lines.push(
      '',
      `## #${issue.number}`,
      `- 候補 ${issue.candidates} 件のうち ${issue.inspected} 件を点検（参照 ${issue.references.length} / 行数主張 ${issue.line_claims.length}）。`,
    );
    if (mine.length === 0) lines.push('- ずれは無い。');
    for (const warning of mine) {
      lines.push(`- ${CODE_LABELS[warning.code] ?? warning.code}: ${warning.detail}`);
    }
  }
  lines.push(
    '',
    '## 次の一手',
    '- ずれた行は **実測を正とする**（`cmate-worker-development` 規律4と同じ）。本文を直して re-plan すると run_id も変わる。',
    '- 「N 行」は末尾改行の無い最終行も1行として数える（`wc -l` より1多くなる場合がある）。',
    '- **本文の意味的な矛盾（決定事項 対 受入条件など）はここでは見ていない。** それは `cmate-issue-refinement` Step 4 の仕事である。',
    '- **この runner は Issue を承認も却下もしない。** dispatch を止めるのは planner の question と dispatch の blocking reason だけである。',
  );
  return lines.join('\n');
}

function completionChecks(inspection, warnings) {
  const checks = [
    { id: 'read_only', passed: true, detail: 'plan にもリポジトリにも書いていない' },
    {
      id: 'shared_extraction',
      passed: true,
      detail: '候補抽出は planner と同じ関数（orchestrate.mjs の extractFileCandidates）である',
    },
    {
      id: 'no_adjudication',
      passed: warnings.every((warning) => CODE_LABELS[warning.code] !== undefined),
      detail: `所見 ${warnings.length} 件はすべて warning であり、exit は 0 である`,
    },
    {
      id: 'repo_root_bounded',
      passed: inspection.issues.every((issue) => issue.references.every((reference) => !reference.path.startsWith('/'))),
      detail: `--repo-root の外は読んでいない（候補になる前に落ちた path ${inspection.issues.reduce((sum, issue) => sum + issue.dropped.length, 0)} 件を報告している）`,
    },
    {
      id: 'deterministic',
      passed: true,
      detail: '同じ本文と同じ tree からは同じ報告が出る（clock も乱数も使わない）',
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

function buildResult({ status, inspection, warnings, errors, completionCheck, summary, artifacts }) {
  return {
    inspect_schema_version: INSPECT_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    mode: 'check-references',
    status,
    // `null` whenever the run refused its input. Stated as data so a consumer
    // cannot read "we could not look" as "we looked and found nothing".
    inspection,
    artifacts,
    errors,
    warnings,
    completion_check: completionCheck,
    summary_markdown: summary,
  };
}

function inspectFailure(error) {
  return buildResult({
    status: 'failure',
    inspection: null,
    warnings: [],
    errors: [{ code: error.code, detail: redact(error.detail ?? error.message) }],
    artifacts: [],
    completionCheck: {
      passed: false,
      checks: [
        { id: 'read_only', passed: true, detail: '何も書いていない' },
        { id: 'shared_extraction', passed: false, detail: '本文を1件も読んでいない' },
        { id: 'no_adjudication', passed: true, detail: '入力を読めなかったのであって、Issue を裁定してはいない' },
        { id: 'repo_root_bounded', passed: true, detail: '1 file も読んでいない' },
        { id: 'deterministic', passed: true, detail: '失敗は入力の純粋関数である' },
      ],
    },
    summary: `## 結論\n点検していない（${error.code}）。${redact(error.detail ?? error.message)}`,
  });
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
  const resolvedRef = inputs.ref === null ? null : resolveRef(inputs.repoRoot, inputs.ref);
  const issues = loadIssues(inputs);

  const readFile = makeFileReader(inputs.repoRoot, inputs.ref);
  const warnings = [];
  const inspection = {
    repo_root: redact(inputs.repoRoot),
    source: inputs.ref === null ? 'worktree' : 'ref',
    ref: inputs.ref,
    resolved_ref: resolvedRef,
    head: inputs.ref === null ? headOf(inputs.repoRoot) : resolvedRef,
    issues: issues.map((issue) => inspectIssue(issue, readFile, warnings)),
  };

  const status = warnings.length > 0 ? 'partial' : 'success';
  // Declared before the report is serialized, so the bytes written to --out and
  // the bytes on stdout are the same bytes: a report that named itself only in
  // one of the two copies would be a report whose provenance depends on which
  // copy you read.
  const result = buildResult({
    status,
    inspection,
    warnings,
    errors: [],
    completionCheck: completionChecks(inspection, warnings),
    summary: renderSummary({ inspection, warnings }),
    artifacts: inputs.out === null ? [] : [redact(inputs.out)],
  });

  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (inputs.out !== null) {
    try {
      writeFileSync(inputs.out, rendered, 'utf8');
    } catch (error) {
      throw new SkillError('write_error', `cannot write --out ${redact(inputs.out)}: ${redact(error.message)}`, 6);
    }
    process.stderr.write(`wrote inspection report to ${inputs.out}\n`);
  }

  process.stderr.write(
    `inspected ${issues.length} issue(s) against ${inputs.ref === null ? 'the working tree' : inputs.ref}: ` +
      `${warnings.length} mismatch(es). This runner does not adjudicate; exit is 0.\n`,
  );
  return { exitCode: 0, stdout: rendered };
}

function main() {
  const argv = process.argv.slice(2);
  try {
    const { exitCode, stdout } = run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      process.stdout.write(`${JSON.stringify(inspectFailure(error), null, 2)}\n`);
      process.stderr.write(`error [${error.code}]: ${redact(error.detail ?? error.message)}\n`);
      process.exit(error.exitCode ?? 1);
    }
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

main();
