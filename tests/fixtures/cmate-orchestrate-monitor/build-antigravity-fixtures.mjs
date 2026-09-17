#!/usr/bin/env node
/**
 * Re-cut fixtures/antigravity/*.json — the Antigravity (agy) payloads that
 * run_tests.sh classifies (CommandMate #2606).
 *
 *   node tests/fixtures/cmate-orchestrate-monitor/build-antigravity-fixtures.mjs <commandmate-checkout>
 *
 * The suite never runs this and never reads the CommandMate checkout: the
 * generated JSON is committed, and this script only records how it was made
 * (see README.md "Antigravity の payload"). Re-running it against the same
 * CommandMate revision must reproduce the committed files byte for byte.
 *
 * Every frame is an existing live agy capture from CommandMate's
 * `tests/fixtures/` (no new recording). The `capture --json` payload around it
 * is built the way CommandMate's own test for #2606
 * (`tests/unit/skills/orchestrate-monitor/classify-state-antigravity.test.ts`)
 * builds it, which is the way the server does
 * (`src/lib/session/current-output-builder.ts`): `realtimeSnippet` is
 * `lines.slice(-100)` and `content` is `lines.slice(lastCapturedLine)`, both
 * over the untrimmed 1000-row pane. The status fields are the idle-looking
 * ones on purpose, so a PROMPT can only come from the text marker.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const checkout = process.argv[2];
if (!checkout) {
  console.error('usage: build-antigravity-fixtures.mjs <commandmate-checkout>');
  process.exit(2);
}
const SOURCE = path.join(checkout, 'tests/fixtures');
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/antigravity');

/** The geometry every agy session is launched with (TUI_PANE_HEIGHT). */
const PANE_ROWS = 1000;

const stripAnsi = (s) => s.replace(/\[[0-9;]*[a-zA-Z]/g, '');

/**
 * The only bytes changed from the captures. Nothing the monitor reads is on
 * these rows: the shell prompt that launched agy, and the working directory in
 * agy's banner.
 */
function redact(pane) {
  return pane
    .replace(/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+(?= \S+ % )/gm, 'user@host')
    .replace(/~\/share\/work\/[^/\s]+\//g, '~/');
}

function liveFrame(rel) {
  return redact(readFileSync(path.join(SOURCE, rel), 'utf8'));
}

/** Pad a top-anchored capture down to the pane height, as tmux returns it. */
function padToPane(text) {
  const rows = text.split('\n');
  while (rows.length < PANE_ROWS) rows.push('');
  return `${rows.join('\n')}\n`;
}

/** The one generating agy capture CommandMate has (a TS string constant). */
function generatingFrame() {
  const ts = readFileSync(path.join(SOURCE, 'model-info-captures.ts'), 'utf8');
  const m = ts.match(/export const ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13 = ("(?:[^"\\]|\\.)*");/);
  if (!m) throw new Error('ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13 not found');
  return redact(padToPane(JSON.parse(m[1])));
}

/** The rows of a frame down to its last non-blank one. */
function contentRows(pane) {
  const rows = pane.split('\n');
  let last = rows.length - 1;
  while (last >= 0 && stripAnsi(rows[last]).trim() === '') last--;
  return rows.slice(0, last + 1);
}

function insertRowsAbove(pane, at, extra) {
  if (!(at > 0)) throw new Error(`no anchor row (${at})`);
  const rows = pane.split('\n');
  rows.splice(at, 0, ...extra);
  return rows.join('\n');
}

/** Index of the last row matching `anchor` (ANSI stripped). */
function lastRow(pane, anchor) {
  const rows = pane.split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    if (anchor.test(stripAnsi(rows[i]))) return i;
  }
  return -1;
}

/** Index of the input box's UPPER rule: the nearest rule above the last bare `>`. */
function inputBoxTop(pane) {
  const rows = pane.split('\n');
  for (let i = lastRow(pane, /^>\s*$/) - 1; i >= 0; i--) {
    if (/^─{3,}$/.test(stripAnsi(rows[i]))) return i;
  }
  return -1;
}

/** Rows inserted above the input box, i.e. at the end of the transcript. */
function withRowsAboveBox(pane, extra) {
  return insertRowsAbove(pane, inputBoxTop(pane), extra);
}

function lastTurnSeparator(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/^─{60}$/.test(stripAnsi(rows[i]).trim())) return i;
  }
  return 0;
}

/**
 * Where the poller's cursor (`lastCapturedLine`) sits, which decides what
 * `content` holds:
 *  - whole:     0 — `content` is the whole pane;
 *  - last-turn: the last `─×60` turn separator — `content` is the current turn
 *               and the live UI under it;
 *  - scrolled:  the transcript has outgrown the pane (filler history above the
 *               verbatim frame, no padding below) and the cursor is at the end,
 *               so `content` is empty and only `realtimeSnippet` has the frame.
 */
function capturePayload(pane, window) {
  let lines = pane.split('\n');
  let cursor = 0;
  if (window === 'last-turn') {
    cursor = lastTurnSeparator(lines);
  } else if (window === 'scrolled') {
    const history = Array.from({ length: PANE_ROWS }, (_, i) => `  scrolled history row ${i}`);
    lines = [...history, ...contentRows(pane), ''];
    cursor = lines.length;
  }
  return {
    isRunning: true,
    cliToolId: 'antigravity',
    sessionStatus: 'ready',
    sessionStatusReason: 'input_prompt',
    content: lines.slice(cursor).join('\n'),
    realtimeSnippet: lines.slice(-100).join('\n'),
    lineCount: lines.length,
    lastCapturedLine: cursor,
    isComplete: false,
    isGenerating: false,
    thinking: false,
    thinkingMessage: null,
    isPromptWaiting: false,
    promptData: null,
  };
}

const WINDOWS = ['whole', 'last-turn', 'scrolled'];

// [fixture name, source frame] — classified in all three windows.
const FRAMES = [
  ['generating', null],
  ['dialog-create-file', 'antigravity-live-2364/dialog-create-file.txt'],
  ['dialog-create-file-highlight-2', 'antigravity-live-2364/dialog-create-file-highlight-2.txt'],
  ['dialog-bash-oneline', 'antigravity-live-2364/dialog-bash-oneline.txt'],
  ['dialog-bash-wrapped', 'antigravity-live-2364/dialog-bash-wrapped.txt'],
  ['dialog-bash-wrapped-highlight-4', 'antigravity-live-2364/dialog-bash-wrapped-highlight-4.txt'],
  ['dialog-bash-wrapped-six', 'antigravity-live-2364/dialog-bash-wrapped-six.txt'],
  ['boot-idle', 'antigravity-live-2364/boot-idle.txt'],
  ['idle-after-deny', 'antigravity-live-2364/idle-after-deny.txt'],
  ['after-tool-turn', 'antigravity-live-2478/after-tool-turn.txt'],
  ['after-plain-turns', 'antigravity-live-2478/after-plain-turns.txt'],
  ['mode-default', 'agent-mode-2592/antigravity-default.txt'],
  ['mode-accept-edits', 'agent-mode-2592/antigravity-accept-edits.txt'],
  ['mode-plan', 'agent-mode-2592/antigravity-plan.txt'],
  ['trust-dialog', 'antigravity-live-2364/trust-dialog.txt'],
  ['picker-switch-model', 'antigravity-live-2364/picker-switch-model.txt'],
  ['popup-slash-commands', 'antigravity-live-2364/popup-slash-commands.txt'],
];

// Numbered rows under a footer that is not `↑/↓ Navigate`: read in `whole` only.
const WHOLE_ONLY = [
  ['dialog-feedback-category', 'antigravity-live-2364/dialog-feedback-category.txt'],
  ['survey-after-deny-reconstructed', 'antigravity-live-2364/survey-after-deny.reconstructed.txt'],
];

const RETRY_ROW = '  429 Too Many Requests · Retrying in 30s · attempt 3/10';

// Live frames with rows inserted, for text no capture carries. Every row agy
// drew is kept verbatim; only the listed rows are added.
function derivedFrames(generating) {
  const afterToolTurn = liveFrame('antigravity-live-2478/after-tool-turn.txt');
  const createFile = liveFrame('antigravity-live-2364/dialog-create-file.txt');
  return [
    // A footer and a numbered list quoted in the transcript, above the box.
    ['derived-quoted-footer', withRowsAboveBox(afterToolTurn, [
      '  The dialog reads:',
      '  1. Yes',
      '  2. No',
      '  ↑/↓ Navigate · tab Amend',
      '',
    ])],
    // A backoff line on a live turn.
    ['derived-generating-retrying', withRowsAboveBox(generating, [RETRY_ROW])],
    // The same line left over on a finished turn.
    ['derived-idle-stale-retry', withRowsAboveBox(afterToolTurn, [RETRY_ROW])],
    // The same line above an open dialog's `Create file` header.
    ['derived-dialog-retry', insertRowsAbove(createFile, lastRow(createFile, /^Create file$/), [RETRY_ROW])],
  ];
}

function write(name, window, pane) {
  const file = path.join(OUT, `${name}.${window}.json`);
  // What `capture --json` prints: JSON.stringify(payload, null, 2) and a newline.
  writeFileSync(file, `${JSON.stringify(capturePayload(pane, window), null, 2)}\n`);
  return file;
}

mkdirSync(OUT, { recursive: true });
const generating = generatingFrame();
const written = [];
for (const [name, rel] of FRAMES) {
  const pane = rel ? liveFrame(rel) : generating;
  for (const window of WINDOWS) written.push(write(name, window, pane));
}
for (const [name, rel] of WHOLE_ONLY) written.push(write(name, 'whole', liveFrame(rel)));
for (const [name, pane] of derivedFrames(generating)) written.push(write(name, 'whole', pane));
console.log(`wrote ${written.length} payloads to ${OUT}`);
