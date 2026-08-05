// Break verify-advisor.mjs on purpose, one guard at a time.
//
//   node mutate.mjs <path-to-verify-advisor.mjs> <mutation> > mutant.mjs
//   node mutate.mjs --list
//
// The suite runs itself against each mutant and requires assertions to go red.
// A test that never saw its subject fail is a test whose green means nothing —
// and for the asymmetric rule in particular, "weakenings are not applied" is a
// claim that has to be shown to be load-bearing rather than incidental.
//
// Every mutation is an exact string replacement, and a target that is no longer
// present is a hard error. A mutant that silently degrades to a no-op would
// report the suite as "still red-proof" while testing nothing.

const MUTATIONS = {
  'apply-weakening': {
    describes: 'isApplicable() stops discriminating: every proposal becomes applicable',
    edits: [
      [
        "  return proposal.layer === 1 && proposal.direction === STRENGTHEN && LAYER1_KINDS.has(proposal.kind);",
        '  return true;',
      ],
    ],
  },
  'apply-weakening-without-guard': {
    describes: 'isApplicable() stops discriminating AND assertNoWeakening() is neutered',
    edits: [
      [
        "  return proposal.layer === 1 && proposal.direction === STRENGTHEN && LAYER1_KINDS.has(proposal.kind);",
        '  return true;',
      ],
      ['function assertNoWeakening(before, after) {', 'function assertNoWeakening(before, after) {\n  if (before || after) return;'],
    ],
  },
  'classify-timeout-increase-as-strengthen': {
    describes: 'a longer timeout is reported as a strengthening',
    edits: [['      return change.to < change.from ? STRENGTHEN : WEAKEN;', '      return STRENGTHEN;']],
  },
  'classify-removal-as-strengthen': {
    describes: 'dropping a gate is reported as a strengthening',
    edits: [["    case 'remove-gate':\n      return WEAKEN;", "    case 'remove-gate':\n      return STRENGTHEN;"]],
  },
  'classify-requirecommit-off-as-strengthen': {
    describes: 'dropping options.requireCommit is reported as a strengthening',
    edits: [["        return String(change.to) === 'true' ? STRENGTHEN : WEAKEN;", '        return STRENGTHEN;']],
  },
  // The guard alone is unreachable while isApplicable() still refuses layer 2,
  // so removing it has to be paired with the bookkeeping failure it exists to
  // survive — the same shape as apply-weakening-without-guard above.
  'requirecommit-guard-removed': {
    describes: 'the layer check is dropped AND the internal guard stops watching options.requireCommit',
    edits: [
      [
        '  return proposal.layer === 1 && proposal.direction === STRENGTHEN && LAYER1_KINDS.has(proposal.kind);',
        '  return true;',
      ],
      [
        "  if (optionOf(before, 'requireCommit', DEFAULT_REQUIRE_COMMIT) !== optionOf(after, 'requireCommit', DEFAULT_REQUIRE_COMMIT)) {\n    throw new AdvisorError(EXIT_ERROR, 'internal guard: --apply would change options.requireCommit');\n  }",
        '  // requireCommit guard removed by mutation',
      ],
    ],
  },
  'layer2-is-applicable': {
    describes: 'the layer check is dropped, so layer-2 proposals become writable',
    edits: [
      [
        "  return proposal.layer === 1 && proposal.direction === STRENGTHEN && LAYER1_KINDS.has(proposal.kind);",
        '  return proposal.direction === STRENGTHEN;',
      ],
    ],
  },
  'unsorted-history': {
    describes: 'the explicit run sort is dropped, so output depends on the order the CLI happened to return',
    edits: [['  runs.sort((a, b) => b.id - a.id);', '  // runs.sort removed by mutation']],
  },
  'unsorted-proposals': {
    describes: 'the proposal sort is dropped',
    edits: [['function sortProposals(proposals) {', 'function sortProposals(proposals) {\n  if (proposals) return proposals;']],
  },
  'ignore-log-cap': {
    describes: 'truncation stops requiring the tail to have reached the cap',
    edits: [
      [
        '        const capped = gate.logTailBytes >= config.effectiveMaxLogTailBytes && config.effectiveMaxLogTailBytes > 0;',
        '        const capped = true;',
      ],
    ],
  },
  'ignore-summary-detection': {
    describes: 'truncation stops asking whether a summary line survived',
    edits: [['        if (capped && gate.summaryDetected === false) {', '        if (capped) {']],
  },
  'no-truncation-detection': {
    describes: 'truncated failure logs are never noticed at all',
    edits: [['        if (capped && gate.summaryDetected === false) {', '        if (false && capped && gate.summaryDetected === false) {']],
  },
  'ignore-censoring': {
    describes: 'a shorter timeout may be argued for from runs the timeout itself cut off',
    edits: [
      [
        '    if (target < current && stat.censoredBy.length > 0) continue;',
        '    // censoring guard removed by mutation',
      ],
    ],
  },
  'forward-log-bodies': {
    describes: 'the gate log body is carried into the evidence instead of structured facts',
    edits: [
      ['        hasDetail: Boolean(extra),', '        hasDetail: Boolean(extra),\n        logTail,'],
      [
        'const citation = (gateId) => (sample) => ({\n  runId: sample.runId,',
        'const citation = (gateId) => (sample) => ({\n  ...sample,\n  runId: sample.runId,',
      ],
    ],
  },
  'no-timeout-floor': {
    describes: 'the slowest observed run stops being a floor under a shortened timeout',
    edits: [['    target = Math.max(target, Math.ceil(stat.maxMs / 1000));', '    // max floor removed by mutation']],
  },
  // Launcher resolution (Issue #37). Each of the three mutations below restores
  // one piece of the behaviour that made this tool unusable without a global
  // install, so the launcher suite is shown to be load-bearing rather than
  // green-by-construction.
  'ignore-cm-env': {
    describes: '$CM stops being consulted, so only --cli and the bare default remain',
    edits: [[
      "  const fromEnv = typeof env.CM === 'string' && env.CM.trim() !== '' ? env.CM : undefined;",
      '  const fromEnv = undefined;',
    ]],
  },
  'no-launcher-split': {
    describes: 'the launcher stops being split on whitespace — the pre-#37 ENOENT on any multi-token launcher',
    edits: [[
      "  const argv = raw.trim().split(/\\s+/).filter((token) => token !== '');",
      '  const argv = [raw];',
    ]],
  },
  'accept-shell-syntax': {
    describes: 'a launcher carrying shell syntax is accepted and handed to spawn as literal argv',
    edits: [[
      "  if (LAUNCHER_SHELL_CHARS.test(raw)) reject('contains shell syntax, which nothing here interprets');",
      '  // shell-syntax guard removed by mutation',
    ]],
  },
};

const [, , source, name] = process.argv;

if (source === '--list' || name === '--list') {
  for (const [key, value] of Object.entries(MUTATIONS)) console.log(`${key}\t${value.describes}`);
  process.exit(0);
}
if (!source || !name) {
  console.error('usage: node mutate.mjs <path-to-verify-advisor.mjs> <mutation>');
  console.error('       node mutate.mjs --list');
  process.exit(2);
}
const mutation = MUTATIONS[name];
if (!mutation) {
  console.error(`unknown mutation: ${name}`);
  process.exit(2);
}

const { readFileSync } = await import('node:fs');
let text = readFileSync(source, 'utf8');
for (const [from, to] of mutation.edits) {
  if (!text.includes(from)) {
    console.error(`mutation ${name}: the target text is no longer in ${source}:\n${from}`);
    process.exit(2);
  }
  text = text.replace(from, to);
}
process.stdout.write(text);
