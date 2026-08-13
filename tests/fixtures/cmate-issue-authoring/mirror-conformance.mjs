#!/usr/bin/env node
// Conformance test: the planner mirror inside cmate-issue-authoring's validator
// must agree with the cmate-orchestrate planner it copies.
//
//   node tests/fixtures/cmate-issue-authoring/mirror-conformance.mjs
//
// `skills/cmate-issue-authoring/scripts/validate-plan.mjs` carries a verbatim
// copy of the body-extraction logic in
// `skills/cmate-orchestrate/scripts/orchestrate.mjs`. The copy is what lets an
// Issue body be checked for planner-readiness *before* the Issue exists. Nothing
// but review kept the two identical, and the reference to the planner's version
// number had already rotted in three separate places by the time this test was
// written — which is the drift this file exists to make impossible.
//
// Two layers, because either alone is a rubber stamp:
//
//  1. **The mirrored constants are byte-identical.** A regex or an extension set
//     that differs by one character changes which paths reach `suspected_files`,
//     i.e. which paths become the worker's `scope.allow`.
//  2. **The mirrored functions behave identically.** Constants can stay equal
//     while the code around them diverges, so both regions are loaded as modules
//     and run over a corpus that exercises every constant; every field of the
//     result must match.
//
// Scope, deliberately narrow — this compares the MIRRORED REGION, never the
// whole file:
//
//  * Only the extraction region of `orchestrate.mjs` is read (from
//    `firstNonEmptyLine` to just before `isSafeRepoPath`), plus the single
//    function `classifyFileCandidates`. A digest of the whole planner would fail
//    on any unrelated planner change, which is a test that trains people to
//    ignore it.
//  * `isSafeRepoPath` is NOT compared and NOT taken from either file. It sits
//    outside the mirrored region, it is owned by its own issue, and both
//    harnesses are given one shared predicate instead — so a difference there
//    can neither mask nor manufacture mirror drift. `SYSTEM_ROOTS`, which that
//    predicate consults, IS compared and IS taken from each file.
//  * `scopeDefaultsFor` (the planner's lockfile companions) is not mirrored by
//    the validator at all. It only ever ADDS paths, so it cannot change the
//    `suspected_files`-is-empty verdict the validator's `planner_ready` rule
//    depends on. Out of scope here, on purpose.
//
// Exit status: 0 the mirror is in sync, 1 it has drifted, 2 the test itself
// could not run (a region marker moved, a constant was renamed). A conformance
// test that cannot tell "they differ" from "I could not look" is one whose green
// means nothing.

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const PLANNER = resolve(REPO_ROOT, 'skills/cmate-orchestrate/scripts/orchestrate.mjs');
const MIRROR = resolve(REPO_ROOT, 'skills/cmate-issue-authoring/scripts/validate-plan.mjs');

const EXIT_SYNCED = 0;
const EXIT_DRIFTED = 1;
const EXIT_ERROR = 2;

// The constants both files declare. Byte-identical is the requirement: these are
// pattern sources and vocabulary sets, and "equivalent" is not a property this
// test is able to check.
const MIRRORED_CONSTANTS = [
  'ACCEPTANCE_HEADING_RE',
  'HEADING_RE',
  'FILE_EXT',
  'SYSTEM_ROOTS',
  'PATH_START',
  'CANDIDATE_BACKTICK',
  'CANDIDATE_KNOWN_ROOT',
  'CANDIDATE_WITH_EXT',
  'DELIVERABLE_HEADING_RE',
  'CONTEXT_HEADING_RE',
];

// Path safety is outside the mirrored region and belongs to the planner alone.
// Injecting one copy into both harnesses is what keeps this test measuring the
// mirror and nothing else. It still reads each side's own SYSTEM_ROOTS, so a
// drift in that set is caught behaviourally as well as byte for byte.
const SHARED_PATH_FILTER = `
function isSafeRepoPath(candidate) {
  if (!candidate || candidate.startsWith('/') || candidate.includes('..')) return false;
  if (candidate.includes('\\\\')) return false;
  if (/[\\u0000-\\u001f\\u007f]/.test(candidate)) return false;
  if (/^[A-Za-z]:/.test(candidate)) return false;
  const head = candidate.split('/', 1)[0].toLowerCase();
  if (SYSTEM_ROOTS.has(head)) return false;
  if (head.endsWith(':')) return false;
  return true;
}
const plannerIsSafeRepoPath = isSafeRepoPath;
`;

const PLANNER_EXPORT = `
export function analyze(text) {
  const extraction = extractFileCandidates(text);
  const classified = classifyFileCandidates(
    extraction.paths,
    extraction.deliverable,
    extraction.contextOnly,
  );
  return {
    objective: firstNonEmptyLine(text),
    acceptance: extractAcceptanceCriteria(text),
    paths: extraction.paths,
    deliverable: [...extraction.deliverable].sort(),
    context_only: [...extraction.contextOnly].sort(),
    suspected: classified.suspected,
  };
}
`;

const MIRROR_EXPORT = `
export function analyze(text) {
  const extraction = plannerFileCandidates(text);
  return {
    objective: firstNonEmptyLine(text),
    acceptance: plannerAcceptanceCriteria(text),
    paths: extraction.paths,
    deliverable: [...extraction.deliverable].sort(),
    context_only: [...extraction.contextOnly].sort(),
    suspected: plannerSuspectedFiles(text),
  };
}
`;

// =============================================================================
// Corpus
// =============================================================================
//
// Every case exists to make one mirrored constant or branch observable. A case
// removed here is a constant that stops being compared behaviourally, so the
// liveness assertions below pin what the corpus must still reach.

const CORPUS = [
  {
    name: 'acceptance heading vocabulary and list markers',
    text: [
      'refresh token を rotate する。',
      '',
      '## 受入条件',
      '- [ ] `npm test -- src/auth` が exit 0',
      '- [x] 使用済み token が 401',
      '* star marker も拾われる',
      '1. numbered marker も拾われる',
      '',
      '## Acceptance Criteria',
      '- an English heading matches too',
      '',
      '## 完了条件',
      '- 完了条件 も見出し語彙',
      '',
      '## 期待結果',
      '- 期待結果 も見出し語彙',
      '',
      '## 受け入れ基準',
      '- 受け入れ も見出し語彙',
      '',
      '## 対象ファイル',
      '- `src/auth/refresh.ts`',
    ].join('\n'),
  },
  {
    name: 'a non-acceptance heading closes the section',
    text: [
      'objective line',
      '',
      '## 受入条件',
      '- inside the section',
      '',
      '### やること',
      '- outside the section, must not be collected',
      '- neither must this',
      '',
      '| table | row |',
      '|---|---|',
      '| not | collected |',
    ].join('\n'),
  },
  {
    name: 'the FILE_EXT set, and one extension outside it',
    text: [
      'extension coverage',
      '',
      'pkg/a.rs pkg/b.md pkg/c.toml pkg/d.json pkg/e.yaml pkg/f.yml pkg/g.py',
      'pkg/h.sh pkg/i.ts pkg/j.tsx pkg/k.js pkg/l.jsx pkg/m.mjs pkg/n.cjs',
      'pkg/o.go pkg/p.rb pkg/q.java pkg/r.kt pkg/s.c pkg/t.h pkg/u.cpp',
      'pkg/v.css pkg/w.html pkg/x.sql',
      '`data/tiles/demo.geojson` `data/tiles/demo.topojson` `data/tiles/demo.geojsonl`',
      // Issue #56. Two shapes, because `jsonc` is the one extension in the set
      // whose real-world files sit at the repository ROOT under a framework-fixed
      // name: `wrangler.jsonc` has no "/" for CANDIDATE_WITH_EXT to anchor on and
      // reaches the set only through CANDIDATE_BACKTICK. It is also the alternative
      // that `json` is a prefix of, so a mirror that dropped it would still match
      // `pkg/d.json` and look healthy.
      '`wrangler.jsonc` `config/deno.jsonc`',
      '`data/tiles/demo.mbtiles` is outside the set and must not be extracted',
      '`config/legacy.json5` is outside the set too and must not be extracted',
    ].join('\n'),
  },
  {
    name: 'the known-root prefixes match without backticks',
    text: [
      'known roots',
      '',
      'src/a src/b/c tests/d test/e scripts/f docs/g lib/h app/i pkg/j',
      'internal/k cmd/l .github/workflows/m.yml',
      'vendor/n does not start with a known root and has no extension',
    ].join('\n'),
  },
  {
    name: 'a candidate must begin where a path can begin',
    text: [
      'anchoring',
      '',
      'bash .claude/skills/cmate-verify/scripts/verify-run.sh',
      'web/src/lib/filter.ts',
      'https://example.com/a/b.ts',
      'see also (docs/nested/note.md) in parentheses',
    ].join('\n'),
  },
  {
    name: 'a path-boundary suffix of another candidate is shadowed',
    text: [
      'shadowing',
      '',
      '## 対象ファイル',
      '- `web/src/lib/filter.ts`',
      '- `src/lib/filter.ts`',
      '',
      '## 受入条件',
      '- [ ] `npm test` が通る',
    ].join('\n'),
  },
  {
    name: 'a document under a deliverable heading is a deliverable',
    text: [
      'ADR を書く。',
      '',
      '## 成果物',
      '- `docs/adr/0002-profile-cache.md`',
      '',
      '## Affected files',
      '- `docs/adr/README.md`',
      '',
      '## files to create',
      '- `docs/adr/template.md`',
      '',
      '## 受入条件',
      '- [ ] ADR が採用案と却下案を述べている',
    ].join('\n'),
  },
  {
    name: 'a path cited only under a context heading is not a deliverable',
    text: [
      'bug report',
      '',
      '## 再現手順',
      '1. `src/api/handler.ts` を叩く',
      '',
      '## 根拠',
      '- src/api/router.ts:118 — ここで落ちる',
      '',
      '## References',
      '- `src/api/legacy.ts`',
      '',
      '## 参考',
      '- `src/api/notes.ts`',
    ].join('\n'),
  },
  {
    name: 'a deliverable heading outranks a context heading',
    text: [
      'both readings',
      '',
      '## 対象ファイル（参考）',
      '- `src/both/readings.ts`',
    ].join('\n'),
  },
  {
    name: 'a citation does not retract an instruction',
    text: [
      '`src/a.ts` を直す。',
      '',
      '## 根拠',
      '- src/a.ts:42 — 現在の実装',
      '- src/only-cited.ts:7 — 変更しない',
    ].join('\n'),
  },
  {
    name: 'escapes and system roots are refused',
    text: [
      'unsafe candidates',
      '',
      '/etc/passwd ../outside/secret.ts users/someone/x.ts home/someone/y.ts',
      'root/z.ts tmp/a.ts private/b.ts var/c.ts etc/d.ts proc/e.ts',
      '`C:/Windows/system32/config.sys` `src/ok.ts`',
    ].join('\n'),
  },
  {
    name: 'documentation outside a deliverable heading stays a reference',
    text: [
      'docs classification',
      '',
      'docs/guide/setup.ts README.md src/notes.md notes/plan.rst notes/plan.txt',
      '`src/real.ts`',
    ].join('\n'),
  },
  {
    name: 'an empty body extracts nothing',
    text: '',
  },
  {
    name: 'prose with no headings and no paths',
    text: 'なんとなく速くしたい。詳細は後で決める。',
  },
];

// What the corpus must still reach. Without these a future edit could quietly
// reduce the corpus to cases that exercise nothing, and this file would keep
// reporting a synchronised mirror it never actually tested.
const LIVENESS = [
  {
    name: 'the corpus reaches the acceptance extraction',
    holds: (results) => results.some((entry) => entry.planner.acceptance.length > 0),
  },
  {
    name: 'the corpus reaches suspected files',
    holds: (results) => results.some((entry) => entry.planner.suspected.length > 0),
  },
  {
    name: 'the corpus reaches a deliverable heading',
    holds: (results) => results.some((entry) => entry.planner.deliverable.length > 0),
  },
  {
    name: 'the corpus reaches a context-only path',
    holds: (results) => results.some((entry) => entry.planner.context_only.length > 0),
  },
  {
    name: 'the corpus reaches the geojson extensions',
    holds: (results) =>
      results.some((entry) => entry.planner.paths.includes('data/tiles/demo.geojson')),
  },
  {
    name: 'the corpus reaches the jsonc extension and stops at json5',
    holds: (results) =>
      results.some(
        (entry) =>
          entry.planner.paths.includes('wrangler.jsonc') &&
          entry.planner.paths.includes('config/deno.jsonc') &&
          !entry.planner.paths.includes('config/legacy.json5'),
      ),
  },
  // Planner Issue #182 turned the shadow DROP into a question and both sides
  // stopped dropping in the same commit, so this asserts the pair survives
  // whole. The assertion is not weaker for having flipped: it still requires the
  // corpus to reach the shadow branch, and it now fails on either copy that
  // drops one side — which is the drift that would make an author's `paths`
  // differ from the planner's `suspected_files`.
  {
    name: 'the corpus reaches the shadow pair and keeps both spellings',
    holds: (results) =>
      results.some(
        (entry) =>
          entry.planner.paths.includes('web/src/lib/filter.ts') &&
          entry.planner.paths.includes('src/lib/filter.ts'),
      ),
  },
  {
    name: 'the corpus reaches the objective extraction',
    holds: (results) => results.some((entry) => entry.planner.objective !== ''),
  },
];

// =============================================================================
// Source extraction
// =============================================================================

class HarnessError extends Error {}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new HarnessError(`${relative(REPO_ROOT, path)} is not readable: ${error.message}`);
  }
}

// The declaration text of `const <name> = ...;`, which every mirrored constant
// is written as, on one line, in both files. A declaration that stops being one
// line is a harness error rather than a silent skip.
function constantDeclaration(source, label, name) {
  const single = new RegExp(`^const ${name} = (.*);$`, 'm');
  const match = single.exec(source);
  if (match) return match[1];
  if (new RegExp(`^const ${name}\\b`, 'm').test(source)) {
    throw new HarnessError(
      `${label}: ${name} is no longer a single-line \`const NAME = ...;\` declaration; ` +
        'teach this test how to read its new shape rather than dropping it',
    );
  }
  return null;
}

// The lines from the first line matching `startRe` up to, and not including, the
// first line after it matching `endRe`.
function region(source, label, startRe, endRe) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => startRe.test(line));
  if (start === -1) {
    throw new HarnessError(`${label}: no line matches the region start ${startRe}`);
  }
  const end = lines.findIndex((line, index) => index > start && endRe.test(line));
  if (end === -1) {
    throw new HarnessError(`${label}: no line after ${start + 1} matches the region end ${endRe}`);
  }
  return { text: lines.slice(start, end).join('\n'), first: start + 1, last: end };
}

// A top-level `function <name>(...) { ... }`, ended by the first line that is
// exactly `}` — which holds for every function in both files, all of which are
// declared at module scope with two-space indentation inside.
function functionBlock(source, label, name) {
  const found = region(source, label, new RegExp(`^function ${name}\\(`), /^\}$/);
  return `${found.text}\n}`;
}

function moduleUrl(source) {
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return `data:text/javascript;charset=utf-8;base64,${encoded}`;
}

// =============================================================================
// Reporting
// =============================================================================

let passed = 0;
let failed = 0;

function pass(name) {
  passed += 1;
  process.stdout.write(`ok   ${name}\n`);
}

function fail(name, detail) {
  failed += 1;
  process.stdout.write(`FAIL ${name}\n     ${String(detail).split('\n').join('\n     ')}\n`);
}

// =============================================================================
// Entry point
// =============================================================================

async function main() {
  const plannerSource = read(PLANNER);
  const mirrorSource = read(MIRROR);

  // ---- layer 1: the constants ----------------------------------------------
  for (const name of MIRRORED_CONSTANTS) {
    const inPlanner = constantDeclaration(plannerSource, 'planner', name);
    const inMirror = constantDeclaration(mirrorSource, 'mirror', name);
    const label = `constant ${name} is byte-identical`;
    if (inPlanner === null || inMirror === null) {
      fail(
        label,
        `declared in planner: ${inPlanner !== null}, declared in mirror: ${inMirror !== null}; ` +
          'a mirrored constant that disappears from either side is drift, not an exemption',
      );
      continue;
    }
    if (inPlanner === inMirror) {
      pass(label);
    } else {
      fail(label, `planner: ${inPlanner}\nmirror:  ${inMirror}`);
    }
  }

  // ---- layer 2: the behaviour ----------------------------------------------
  const plannerRegion = region(
    plannerSource,
    'planner',
    /^function firstNonEmptyLine\(/,
    /^function isSafeRepoPath\(/,
  );
  const mirrorRegion = region(
    mirrorSource,
    'mirror',
    /^const ACCEPTANCE_HEADING_RE\b/,
    /^\/\/ Rules the schema cannot state$/,
  );
  const mirrorSafePath = functionBlock(mirrorSource, 'mirror', 'plannerIsSafeRepoPath');
  if (!mirrorRegion.text.includes(mirrorSafePath)) {
    throw new HarnessError(
      'mirror: plannerIsSafeRepoPath is not inside the mirrored region, so the harness cannot ' +
        'replace it with the shared path filter',
    );
  }

  const plannerModule = [
    plannerRegion.text,
    functionBlock(plannerSource, 'planner', 'classifyFileCandidates'),
    SHARED_PATH_FILTER,
    PLANNER_EXPORT,
  ].join('\n');
  const mirrorModule = [
    mirrorRegion.text.replace(mirrorSafePath, ''),
    SHARED_PATH_FILTER,
    MIRROR_EXPORT,
  ].join('\n');

  let plannerImpl;
  let mirrorImpl;
  try {
    plannerImpl = await import(moduleUrl(plannerModule));
  } catch (error) {
    throw new HarnessError(
      `planner: lines ${plannerRegion.first}-${plannerRegion.last} do not load as a module ` +
        `(${error.message}); the extraction region has grown a dependency the harness does not supply`,
    );
  }
  try {
    mirrorImpl = await import(moduleUrl(mirrorModule));
  } catch (error) {
    throw new HarnessError(
      `mirror: lines ${mirrorRegion.first}-${mirrorRegion.last} do not load as a module ` +
        `(${error.message}); the mirrored region has grown a dependency the harness does not supply`,
    );
  }

  process.stdout.write(
    `     planner region: ${relative(REPO_ROOT, PLANNER)}:${plannerRegion.first}-${plannerRegion.last}` +
      ` (+ classifyFileCandidates)\n` +
      `     mirror region:  ${relative(REPO_ROOT, MIRROR)}:${mirrorRegion.first}-${mirrorRegion.last}\n`,
  );

  const results = [];
  for (const item of CORPUS) {
    let planner;
    let mirror;
    try {
      planner = plannerImpl.analyze(item.text);
      mirror = mirrorImpl.analyze(item.text);
    } catch (error) {
      fail(`corpus: ${item.name}`, `the extraction threw: ${error.message}`);
      continue;
    }
    results.push({ name: item.name, planner, mirror });
    const left = JSON.stringify(planner, null, 2);
    const right = JSON.stringify(mirror, null, 2);
    if (left === right) {
      pass(`corpus: ${item.name}`);
    } else {
      fail(`corpus: ${item.name}`, `planner:\n${left}\nmirror:\n${right}`);
    }
  }

  // ---- the corpus is not allowed to go quiet -------------------------------
  for (const check of LIVENESS) {
    if (check.holds(results)) {
      pass(check.name);
    } else {
      fail(
        check.name,
        'no corpus case exercises this any more; the comparison above passed without testing it',
      );
    }
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  return failed === 0 ? EXIT_SYNCED : EXIT_DRIFTED;
}

try {
  process.exit(await main());
} catch (error) {
  if (error instanceof HarnessError) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(EXIT_ERROR);
  }
  throw error;
}
