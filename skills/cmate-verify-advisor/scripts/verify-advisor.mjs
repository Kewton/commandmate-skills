// cmate-verify-advisor — layer 1: mechanical, deterministic adjustments to
// `.commandmate/verify.yaml`, derived from verification history (Node stdlib
// only, Node >= 18).
//
//   node scripts/verify-advisor.mjs [--config <path>] [--input <snapshot>] [--apply]
//
// What this script optimises for, and what it refuses to optimise for:
//
//   The objective is the ESCAPE RATE (a run that passed and was broken anyway)
//   and TIME TO DETECTION. The pass rate is NOT an objective. "This gate fails
//   often, so drop it" is exactly the inference this tool must never make, and
//   it cannot make it: removing a gate is not one of the changes layer 1 can
//   even express.
//
// The asymmetric rule is the load-bearing invariant:
//
//   strengthen / speed up   (shorter timeout, more log budget, fail-fast order)
//     -> layer 1 may write these with --apply
//   weaken                  (longer timeout, less log budget, gate removal,
//                            scope loosening)
//     -> proposal only, always, whatever flags are passed
//
// It is enforced three times over, on purpose. `classifyChange()` derives the
// direction from (key, before, after) rather than trusting whoever built the
// proposal; `isApplicable()` additionally requires layer 1 and a known layer-1
// kind; and `assertNoWeakening()` re-reads the bytes that would be written and
// compares them against the bytes on disk, so a proposal that lied about its
// own direction still cannot reach the file.
//
// Log bodies are never interpreted. A gate's log is arbitrary text produced by
// a command in the target repository, so treating it as input to a decision
// procedure — let alone forwarding it into an LLM context — is an indirect
// prompt injection path. Only structured facts are read out of it: byte length,
// whether it reached the configured cap, and whether any line MATCHES the shape
// of a runner summary (a boolean; the matched text is never emitted).
//
// Exit status:
//   0  the run succeeded — including "zero proposals", which is a normal day
//   2  usage, I/O, or configuration error (the run could not be trusted)
//   3  the environment cannot supply verification history (no silent downgrade)

import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const EXIT_OK = 0;
const EXIT_ERROR = 2;
const EXIT_NO_HISTORY = 3;

// --- limits mirrored from cmate-verify/scripts/verify-run.sh -----------------
// A proposal outside these bounds would be rejected by the runner as a config
// error, which turns "advice" into a broken repository.
const DEFAULT_TIMEOUT_SEC = 600;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 7200;
const DEFAULT_MAX_LOG_TAIL_BYTES = 8192;
const MAX_LOG_TAIL_BYTES_LIMIT = 1048576;
const DEFAULT_SKIP_IN_PRIMARY_CHECKOUT = 'true';
const DEFAULT_REQUIRE_COMMIT = 'false';
const DEFAULT_REQUIRE_ENV_CLEAN = 'false';
const GATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// `env-clean` joined the built-ins in CommandMate #1740, alongside work-evidence
// and scope. Reserved here for the same reason the other two are: a repository
// gate that takes the name would be shadowed by the built-in.
const RESERVED_GATE_IDS = new Set(['work-evidence', 'scope', 'env-clean']);
const TOP_LEVEL_KEYS = new Set(['version', 'gates', 'options']);
// Both key sets must stay identical to what cmate-verify's runner accepts
// (`skills/cmate-verify/scripts/verify-run.sh`, the `KV_K == ...` chains inside
// the awk parser) and to what CommandMate's own loader accepts
// (`src/lib/verification/verify-config.ts`, GATE_KEYS / OPTION_KEYS). A key one
// accepts and another does not turns a perfectly valid repository config into
// exit 2 here — which is how `requireCommit` (CommandMate #1642) was rejected
// until Issue #57, and how `mutex` (#1771), `retryOnFail` / `flakyIsPass`
// (#1772) and `requireEnvClean` (#1740) were rejected until Issues #223 / #224.
// The implementations are separate, in separate languages, so the agreement is
// pinned by a test: `tests/fixtures/cmate-verify-advisor/parser-parity.sh`.
const GATE_KEYS = new Set(['id', 'command', 'timeoutSec', 'mutex', 'retryOnFail', 'flakyIsPass']);
const OPTION_KEYS = new Set([
  'baseRef',
  'skipInPrimaryCheckout',
  'maxLogTailBytes',
  'requireCommit',
  'requireEnvClean',
]);

// Value domains mirrored from the same two implementations.
const GATE_MUTEX_RE = /^[A-Za-z0-9_.-]+$/;
const MAX_GATE_MUTEX_LENGTH = 64;
// The ceiling is the feature, not a tuning parameter: enough re-runs turn any
// red green, so 2 is a config error rather than a longer retry.
const MAX_RETRY_ON_FAIL = 1;

// What the runner uses when the key is absent, as strings, so "set it to the
// value it already has" is recognised as a change to nothing rather than as a
// change away from the empty string. Mirrors verify-run.sh's initialisers.
const OPTION_DEFAULTS = new Map([
  ['baseRef', ''],
  ['skipInPrimaryCheckout', DEFAULT_SKIP_IN_PRIMARY_CHECKOUT],
  ['maxLogTailBytes', String(DEFAULT_MAX_LOG_TAIL_BYTES)],
  ['requireCommit', DEFAULT_REQUIRE_COMMIT],
  ['requireEnvClean', DEFAULT_REQUIRE_ENV_CLEAN],
]);

// --- tunables ---------------------------------------------------------------
const TIMEOUT_HEADROOM = 1.5; // p99 x 1.5, per the design
// No gate is worth declaring hung in less than half a minute. History is
// normally recorded on a warm development machine, and a cold CI runner with an
// empty cache is several times slower; a floor keeps p99 x 1.5 from turning a
// fast local measurement into a gate that fails everywhere else.
const TIMEOUT_FLOOR_SEC = 30;
const MIN_SAMPLES_DEFAULT = 5;
const TIMEOUT_CHANGE_MIN_RATIO = 0.2; // ignore changes below 20% ...
const TIMEOUT_CHANGE_MIN_SEC = 5; //     ... or below 5s, whichever is larger
const CENSOR_RATIO = 0.95; // a run this close to its timeout censors the sample
const TIMEOUT_EXIT_CODE = 124;

const STRENGTHEN = 'strengthen';
const WEAKEN = 'weaken';

// Kinds layer 1 can produce. `--apply` refuses anything else even when the
// direction says strengthen, so a layer-2 gate addition — which IS a
// strengthening — still requires a human to merge it.
const LAYER1_KINDS = new Set(['set-timeout', 'set-option', 'reorder-gates']);
const KNOWN_KINDS = new Set([...LAYER1_KINDS, 'add-gate', 'remove-gate']);

const USAGE = `cmate-verify-advisor — layer 1 (deterministic history analysis)

  node scripts/verify-advisor.mjs [options]

  --config <path>       verify.yaml to advise on (default: <cwd>/.commandmate/verify.yaml)
  --cwd <path>          worktree root; the config must live inside it (default: process cwd)
  --input <path>        analyse a saved snapshot instead of calling the CLI
                        ({"history":[...],"details":[...]} or a bare history array)
  --dump <path>         write the collected snapshot to this path
  --proposals <path>    layer-2 proposals to render and diff (never applied)
  --cli <launcher>      CommandMate launcher to collect with: an executable plus fixed
                        leading arguments, split on whitespace and run WITHOUT a shell
                        ("commandmate" — the default, "npx commandmate@latest", a path).
                        Falls back to $CM when omitted. Shell syntax is refused.
  --worktree <id>       collect only this worktree (repeatable)
  --worktree-prefix <s> keep only runs whose worktree id starts with <s> (repeatable)
  --days <n>            collection window, 1..90 (default 30)
  --limit <n>           maximum runs to collect, 1..500 (default 200)
  --min-samples <n>     executed runs a gate needs before it is advised on (default ${MIN_SAMPLES_DEFAULT})
  --no-details          skip \`verify show\`; log-tail analysis reports "not evaluated"
  --apply               write the layer-1 strengthening proposals into the config
  --json                emit the report as JSON
  --help                show this help

Exit: 0 ran (zero proposals included), 2 usage/IO/config error,
      3 verification history is unavailable.`;

// =============================================================================
// Errors
// =============================================================================

class AdvisorError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const usageError = (message) => new AdvisorError(EXIT_ERROR, message);
const noHistoryError = (message) => new AdvisorError(EXIT_NO_HISTORY, message);

// =============================================================================
// Launcher resolution (Issue #37)
// =============================================================================
//
// The same convention cmate-orchestrate-monitor/scripts/monitor.sh:108 and
// cmate-orchestrate's runners use, so an npx-only operator sets ONE variable for
// the whole toolchain:
//
//   --cli <launcher>   explicit, wins
//   $CM                monitor.sh's variable, same name and same meaning
//   "commandmate"      the default
//
// The value is a LAUNCHER, not merely an executable: it is split on whitespace
// and spawned WITHOUT a shell, which is what makes `npx commandmate@latest`
// usable here. Before this, spawnSync took the whole string as one program name
// and reported ENOENT — an error about a program nobody named. This is runtime
// resolution only; nothing about it reaches a report.
//
// Accepted: one or more whitespace-separated tokens, the first the program and
//           the rest fixed leading arguments — "commandmate",
//           "/usr/local/bin/commandmate", "npx commandmate@latest".
// Refused:  an empty value, a first token starting with "-", and any shell
//           syntax or control character. Nothing here runs a shell, so a pipe, a
//           redirect, a substitution or a quote would be passed to the program
//           as a literal argument and silently misbehave.
const DEFAULT_LAUNCHER = 'commandmate';
const LAUNCHER_SHELL_CHARS = /[|&;<>()$`\\"']/;
// eslint-disable-next-line no-control-regex
const LAUNCHER_CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f]/;
const LAUNCHER_ADVICE =
  'a launcher is an executable plus fixed leading arguments, split on whitespace and run WITHOUT a shell ' +
  '(accepted: "commandmate", "/usr/local/bin/commandmate", "npx commandmate@latest"). ' +
  'For anything a shell would have to read — a pipe, a redirect, a substitution, a quote — put a wrapper on PATH ' +
  '(~/.local/bin/commandmate containing: exec npx --yes commandmate@latest "$@") and pass its path.';

function resolveLauncher(cliFlag, env = process.env) {
  const fromEnv = typeof env.CM === 'string' && env.CM.trim() !== '' ? env.CM : undefined;
  const source = cliFlag !== undefined && cliFlag !== null ? '--cli' : (fromEnv !== undefined ? 'CM' : 'default');
  const raw = cliFlag ?? fromEnv ?? DEFAULT_LAUNCHER;
  const reject = (why) => {
    throw usageError(`${source} ${raw}: ${why}; ${LAUNCHER_ADVICE}`);
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
// verify.yaml — the same subset cmate-verify's runner accepts
// =============================================================================
//
// The file is kept as lines, not re-serialised from a parsed object. A verify
// config carries the reasoning for its own timeouts in comments, and a tool that
// rewrites the file wholesale deletes exactly the part a reviewer needs.

function unquote(value) {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function splitKeyValue(body) {
  const colon = body.indexOf(':');
  if (colon < 0) return null;
  const key = body.slice(0, colon).trim();
  const value = body.slice(colon + 1).trim();
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) return null;
  return { key, value };
}

function checkValue(key, value, lineNo, errors) {
  if (value === '') {
    errors.push(`line ${lineNo}: ${key}: has an empty value`);
    return false;
  }
  const head = value[0];
  if (head === '&' || head === '*') {
    errors.push(`line ${lineNo}: ${key}: YAML anchors/aliases are not supported`);
    return false;
  }
  if (head === '[' || head === '{') {
    errors.push(`line ${lineNo}: ${key}: flow-style values are not supported`);
    return false;
  }
  if (/^[|>][-+0-9]*$/.test(value)) {
    errors.push(`line ${lineNo}: ${key}: block scalars are not supported`);
    return false;
  }
  return true;
}

/**
 * Parse verify.yaml into a line-anchored document.
 *
 * Every gate keeps the range of source lines it owns, including the comment
 * lines directly above it, so a reorder moves the rationale with the gate.
 */
function parseConfig(text, path) {
  const errors = [];
  const lines = text.split('\n');
  // `split` on a trailing newline yields a final empty element; remember it so
  // the file round-trips byte for byte.
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();

  const gates = [];
  const options = new Map(); // key -> {value, line}
  let section = '';
  let versionSeen = 0;
  let gatesLine = -1;
  let gatesEnd = lines.length; // exclusive
  let current = null;

  // `end` is the gate's last FIELD line, set by readGateField — never the line
  // before the next item. The difference is the comment lines in between: they
  // belong to the gate BELOW them (see the lead scan), and a gate whose `end`
  // swallowed them would leave its neighbour's rationale behind on a reorder.
  const flush = () => {
    if (!current) return;
    if (current.id === null) errors.push(`line ${current.start + 1}: gate is missing id:`);
    if (current.command === null) errors.push(`line ${current.start + 1}: gate is missing command:`);
    if (current.id !== null && current.command !== null) gates.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].replace(/\r$/, '');
    const lineNo = i + 1;
    if (raw.includes('\t')) {
      errors.push(`line ${lineNo}: tab characters are not allowed`);
      continue;
    }
    if (/^[ ]*$/.test(raw) || /^[ ]*#/.test(raw)) continue;

    const indent = raw.length - raw.replace(/^ */, '').length;
    if (indent % 2 !== 0) {
      errors.push(`line ${lineNo}: indentation must be a multiple of 2 spaces`);
      continue;
    }
    const body = raw.slice(indent);

    if (indent === 0) {
      if (section === 'gates') {
        flush();
        gatesEnd = i;
      }
      const kv = splitKeyValue(body);
      if (!kv) {
        errors.push(`line ${lineNo}: expected "key: value" at the top level`);
        continue;
      }
      if (!TOP_LEVEL_KEYS.has(kv.key)) {
        errors.push(`line ${lineNo}: unknown top-level key: ${kv.key}`);
        continue;
      }
      if (kv.key === 'version') {
        versionSeen += 1;
        if (versionSeen > 1) errors.push(`line ${lineNo}: duplicate top-level version:`);
        else if (unquote(kv.value) !== '1') errors.push(`line ${lineNo}: version must be 1 (got: ${kv.value})`);
        section = '';
      } else if (kv.key === 'gates') {
        if (kv.value !== '') errors.push(`line ${lineNo}: gates: must be followed by an indented list`);
        section = 'gates';
        gatesLine = i;
        gatesEnd = lines.length;
      } else {
        if (kv.value !== '') errors.push(`line ${lineNo}: options: must be followed by indented keys`);
        section = 'options';
      }
      continue;
    }

    if (indent === 2) {
      if (section === 'gates') {
        if (body.slice(0, 2) !== '- ') {
          errors.push(`line ${lineNo}: gate list items must start with "- "`);
          continue;
        }
        flush();
        current = { id: null, command: null, timeoutSec: null, mutex: null, retryOnFail: null, flakyIsPass: null, lineOf: new Map(), start: i, end: i, index: gates.length };
        readGateField(body.slice(2).trim(), lineNo, i, current, errors);
        continue;
      }
      if (section === 'options') {
        const kv = splitKeyValue(body);
        if (!kv) {
          errors.push(`line ${lineNo}: expected "key: value" inside options:`);
          continue;
        }
        if (!checkValue(kv.key, kv.value, lineNo, errors)) continue;
        if (!OPTION_KEYS.has(kv.key)) {
          errors.push(`line ${lineNo}: unknown options key: ${kv.key}`);
          continue;
        }
        options.set(kv.key, { value: unquote(kv.value), line: i });
        continue;
      }
      errors.push(`line ${lineNo}: indented line outside of gates: / options:`);
      continue;
    }

    if (indent === 4 && section === 'gates') {
      if (!current) {
        errors.push(`line ${lineNo}: gate field outside of a list item`);
        continue;
      }
      readGateField(body, lineNo, i, current, errors);
      continue;
    }

    errors.push(`line ${lineNo}: unexpected indentation (${indent} spaces)`);
  }
  if (section === 'gates') flush();

  if (versionSeen === 0) errors.push('missing top-level "version: 1"');
  if (gates.length === 0) errors.push('no gates are defined');

  const seen = new Set();
  for (const gate of gates) {
    if (RESERVED_GATE_IDS.has(gate.id)) errors.push(`line ${gate.start + 1}: gate id is reserved: ${gate.id}`);
    else if (!GATE_ID_RE.test(gate.id)) errors.push(`line ${gate.start + 1}: invalid gate id: ${gate.id}`);
    if (seen.has(gate.id)) errors.push(`line ${gate.start + 1}: duplicate gate id: ${gate.id}`);
    seen.add(gate.id);

    if (gate.timeoutSec === null) {
      gate.effectiveTimeoutSec = DEFAULT_TIMEOUT_SEC;
      gate.timeoutIsDefault = true;
    } else if (!/^[0-9]+$/.test(gate.timeoutSec)) {
      errors.push(`line ${gate.start + 1}: timeoutSec must be an integer (gate ${gate.id}, got: ${gate.timeoutSec})`);
    } else {
      const value = Number(gate.timeoutSec);
      if (value < MIN_TIMEOUT_SEC || value > MAX_TIMEOUT_SEC) {
        errors.push(`line ${gate.start + 1}: timeoutSec must be ${MIN_TIMEOUT_SEC}..${MAX_TIMEOUT_SEC} (gate ${gate.id}, got: ${value})`);
      }
      gate.effectiveTimeoutSec = value;
      gate.timeoutIsDefault = false;
    }

    // A mutex names a RESOURCE, so its pattern is wider than a gate id's — and
    // narrow enough to be safe as a path segment, because both runners turn it
    // into `<lock-root>/<name>.lock` (CommandMate #1771).
    if (gate.mutex !== null) {
      if (gate.mutex.length > MAX_GATE_MUTEX_LENGTH) {
        errors.push(`line ${gate.start + 1}: mutex must be at most ${MAX_GATE_MUTEX_LENGTH} characters (gate ${gate.id}, got: ${gate.mutex.length})`);
      } else if (!GATE_MUTEX_RE.test(gate.mutex)) {
        errors.push(`line ${gate.start + 1}: invalid mutex name: ${gate.mutex} (gate ${gate.id}, must match ${GATE_MUTEX_RE.source})`);
      }
    }

    let retryOnFail = 0;
    if (gate.retryOnFail !== null) {
      if (gate.retryOnFail !== '0' && gate.retryOnFail !== String(MAX_RETRY_ON_FAIL)) {
        // Not "at most N": the range is the contract, so the message states it.
        errors.push(`line ${gate.start + 1}: retryOnFail must be 0 or ${MAX_RETRY_ON_FAIL} (gate ${gate.id}, got: ${gate.retryOnFail})`);
      } else {
        retryOnFail = Number(gate.retryOnFail);
      }
    }
    gate.effectiveRetryOnFail = retryOnFail;

    if (gate.flakyIsPass !== null) {
      if (gate.flakyIsPass !== 'true' && gate.flakyIsPass !== 'false') {
        errors.push(`line ${gate.start + 1}: flakyIsPass must be true or false (gate ${gate.id}, got: ${gate.flakyIsPass})`);
      } else if (gate.flakyIsPass === 'true' && retryOnFail !== MAX_RETRY_ON_FAIL) {
        // A knob that can never fire is a config bug, not a preference: without
        // a retry the gate has no FLAKY outcome for this to reclassify.
        errors.push(`line ${gate.start + 1}: flakyIsPass: true requires retryOnFail: ${MAX_RETRY_ON_FAIL} (gate ${gate.id}, without a retry a gate can never be FLAKY)`);
      }
    }
    gate.effectiveFlakyIsPass = gate.flakyIsPass === 'true';
  }

  const maxTail = options.get('maxLogTailBytes');
  let effectiveMaxLogTailBytes = DEFAULT_MAX_LOG_TAIL_BYTES;
  if (maxTail) {
    if (!/^[0-9]+$/.test(maxTail.value)) {
      errors.push(`line ${maxTail.line + 1}: options.maxLogTailBytes must be an integer (got: ${maxTail.value})`);
    } else if (Number(maxTail.value) > MAX_LOG_TAIL_BYTES_LIMIT) {
      errors.push(`line ${maxTail.line + 1}: options.maxLogTailBytes must be 0..${MAX_LOG_TAIL_BYTES_LIMIT}`);
    } else {
      effectiveMaxLogTailBytes = Number(maxTail.value);
    }
  }
  const skip = options.get('skipInPrimaryCheckout');
  if (skip && skip.value !== 'true' && skip.value !== 'false') {
    errors.push(`line ${skip.line + 1}: options.skipInPrimaryCheckout must be true or false (got: ${skip.value})`);
  }
  const requireCommit = options.get('requireCommit');
  if (requireCommit && requireCommit.value !== 'true' && requireCommit.value !== 'false') {
    errors.push(`line ${requireCommit.line + 1}: options.requireCommit must be true or false (got: ${requireCommit.value})`);
  }
  const requireEnvClean = options.get('requireEnvClean');
  if (requireEnvClean && requireEnvClean.value !== 'true' && requireEnvClean.value !== 'false') {
    errors.push(`line ${requireEnvClean.line + 1}: options.requireEnvClean must be true or false (got: ${requireEnvClean.value})`);
  }

  if (errors.length > 0) {
    throw usageError(`invalid config: ${path}\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  // A gate owns the comment lines immediately above it: the "why 900s" note has
  // to travel with the gate when the order changes, or the reasoning ends up
  // attached to a different gate.
  for (let g = 0; g < gates.length; g += 1) {
    let lead = gates[g].start;
    const floor = g === 0 ? gatesLine + 1 : gates[g - 1].end + 1;
    while (lead > floor && /^[ ]*(#|$)/.test(lines[lead - 1])) lead -= 1;
    gates[g].lead = lead;
  }
  // Blank and comment lines after the last gate are NOT absorbed by it: they sit
  // outside the reordered region so a section footer stays where it was written.

  return {
    path,
    lines,
    trailingNewline,
    gates,
    options,
    gatesLine,
    gatesEnd,
    effectiveMaxLogTailBytes,
    text,
  };
}

function readGateField(body, lineNo, lineIndex, gate, errors) {
  const kv = splitKeyValue(body);
  if (!kv) {
    errors.push(`line ${lineNo}: expected "key: value" inside a gate`);
    return;
  }
  if (!checkValue(kv.key, kv.value, lineNo, errors)) return;
  if (!GATE_KEYS.has(kv.key)) {
    errors.push(`line ${lineNo}: unknown gate key: ${kv.key}`);
    return;
  }
  if (gate[kv.key] !== null) {
    errors.push(`line ${lineNo}: duplicate ${kv.key}: in one gate`);
    return;
  }
  gate[kv.key] = unquote(kv.value);
  gate.lineOf.set(kv.key, lineIndex);
  if (lineIndex > gate.end) gate.end = lineIndex;
}

// --- writing back ------------------------------------------------------------

/**
 * A YAML-subset scalar. The runner strips one matching pair of quotes and does
 * no escape processing, so a value that needs both quote characters has no
 * representation and is refused rather than mangled.
 */
function yamlScalar(value, what) {
  const text = String(value);
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw usageError(`${what}: control characters cannot be written in the verify.yaml subset`);
  }
  if (/^[0-9]+$/.test(text) || text === 'true' || text === 'false') return text;
  if (!text.includes('"')) return `"${text}"`;
  if (!text.includes("'")) return `'${text}'`;
  throw usageError(`${what}: a value containing both quote characters has no representation in the verify.yaml subset`);
}

/**
 * Apply a set of edits to the parsed document and return the new file text.
 *
 * Edits are expressed against the ORIGINAL line indices; the walk below is the
 * only place that turns them into bytes, so "what would change" and "what is
 * written" cannot drift apart.
 */
function renderConfig(config, edits) {
  const replace = new Map(); // original index -> replacement line
  const insertAfter = new Map(); // original index -> [lines]
  let order = null;

  for (const edit of edits) {
    if (edit.type === 'replace-line') replace.set(edit.line, edit.text);
    else if (edit.type === 'insert-after') insertAfter.set(edit.line, (insertAfter.get(edit.line) || []).concat(edit.text));
    else if (edit.type === 'append') insertAfter.set(config.lines.length - 1, (insertAfter.get(config.lines.length - 1) || []).concat(edit.text));
    else if (edit.type === 'reorder') order = edit.order;
    else throw new Error(`internal: unknown edit type ${edit.type}`);
  }

  // A `null` replacement deletes the line. Deletion is spelled this way, rather
  // than by splicing the array, so every edit stays anchored to an ORIGINAL line
  // index and two edits can never shift each other's targets.
  const emitRange = (out, from, toInclusive) => {
    for (let i = from; i <= toInclusive; i += 1) {
      if (replace.has(i)) {
        const text = replace.get(i);
        if (text !== null) out.push(text);
      } else {
        out.push(config.lines[i]);
      }
      const extra = insertAfter.get(i);
      if (extra) out.push(...extra);
    }
  };

  const out = [];
  if (config.gates.length === 0 || order === null) {
    // No reorder: a straight walk keeps every line in place.
    emitRange(out, 0, config.lines.length - 1);
  } else {
    const first = config.gates[0].lead;
    const last = config.gates[config.gates.length - 1].end;
    if (first > 0) emitRange(out, 0, first - 1);
    for (const id of order) {
      const gate = config.gates.find((g) => g.id === id);
      if (!gate) throw new Error(`internal: reorder names an unknown gate ${id}`);
      emitRange(out, gate.lead, gate.end);
    }
    if (last + 1 <= config.lines.length - 1) emitRange(out, last + 1, config.lines.length - 1);
  }

  return out.join('\n') + (config.trailingNewline ? '\n' : '');
}

function editSetGateTimeout(config, gateId, seconds) {
  const gate = config.gates.find((g) => g.id === gateId);
  if (!gate) throw new Error(`internal: no such gate ${gateId}`);
  const line = gate.lineOf.get('timeoutSec');
  if (line !== undefined) {
    const source = config.lines[line];
    const prefix = source.slice(0, source.indexOf('timeoutSec:') + 'timeoutSec:'.length);
    return [{ type: 'replace-line', line, text: `${prefix} ${seconds}` }];
  }
  // No timeoutSec line yet: add one with the indentation the gate's other
  // continuation fields already use, so the file keeps one shape.
  const anchor = gate.lineOf.get('command') ?? gate.lineOf.get('id');
  const anchorLine = config.lines[anchor];
  const indent = anchorLine.startsWith('  - ') ? '    ' : anchorLine.slice(0, anchorLine.length - anchorLine.replace(/^ */, '').length);
  return [{ type: 'insert-after', line: gate.end, text: [`${indent}timeoutSec: ${seconds}`] }];
}

function editSetOption(config, key, value) {
  const existing = config.options.get(key);
  const scalar = yamlScalar(value, `options.${key}`);
  if (existing) {
    const source = config.lines[existing.line];
    const prefix = source.slice(0, source.indexOf(`${key}:`) + key.length + 1);
    return [{ type: 'replace-line', line: existing.line, text: `${prefix} ${scalar}` }];
  }
  // The options: block may not exist at all; appending it is the only edit that
  // can grow the file at the top level.
  const optionsLine = config.lines.findIndex((l) => l === 'options:' || /^options:\s*$/.test(l));
  if (optionsLine >= 0) {
    let end = optionsLine;
    for (let i = optionsLine + 1; i < config.lines.length; i += 1) {
      if (/^[^ #]/.test(config.lines[i])) break;
      if (/^ {2}\S/.test(config.lines[i])) end = i;
    }
    return [{ type: 'insert-after', line: end, text: [`  ${key}: ${scalar}`] }];
  }
  return [{ type: 'append', text: ['options:', `  ${key}: ${scalar}`] }];
}

function editAddGate(config, gate, position) {
  const lines = [`  - id: ${yamlScalar(gate.id, 'gate id')}`, `    command: ${yamlScalar(gate.command, `gate ${gate.id} command`)}`];
  if (gate.timeoutSec !== undefined && gate.timeoutSec !== null) {
    lines.push(`    timeoutSec: ${yamlScalar(gate.timeoutSec, `gate ${gate.id} timeoutSec`)}`);
  }
  if (position && position.startsWith('after:')) {
    const target = config.gates.find((g) => g.id === position.slice('after:'.length));
    if (!target) throw usageError(`add-gate: position names an unknown gate: ${position}`);
    return [{ type: 'insert-after', line: target.end, text: lines }];
  }
  const last = config.gates[config.gates.length - 1];
  return [{ type: 'insert-after', line: last.end, text: lines }];
}

function editRemoveGate(config, gateId) {
  const gate = config.gates.find((g) => g.id === gateId);
  if (!gate) throw usageError(`remove-gate: no such gate: ${gateId}`);
  const edits = [];
  for (let i = gate.lead; i <= gate.end; i += 1) edits.push({ type: 'replace-line', line: i, text: null });
  return edits;
}

// =============================================================================
// The asymmetric rule
// =============================================================================

/**
 * Derive the direction of a change from what it does to the file, not from what
 * the proposal claims about itself.
 *
 * "Weaken" is the fail-closed answer: anything this function does not
 * positively recognise as a strengthening is a proposal a human has to merge.
 */
function classifyChange(change) {
  switch (change.kind) {
    case 'set-timeout': {
      if (change.to === change.from) return null;
      return change.to < change.from ? STRENGTHEN : WEAKEN;
    }
    case 'set-option': {
      if (change.key === 'maxLogTailBytes') {
        if (Number(change.to) === Number(change.from)) return null;
        return Number(change.to) > Number(change.from) ? STRENGTHEN : WEAKEN;
      }
      if (change.key === 'skipInPrimaryCheckout') {
        if (String(change.to) === String(change.from)) return null;
        // false -> true means fewer gates run. That is a weakening.
        return String(change.to) === 'false' ? STRENGTHEN : WEAKEN;
      }
      if (change.key === 'requireCommit') {
        if (String(change.to) === String(change.from)) return null;
        // requireCommit is the strict side of work-evidence: with it on, an
        // uncommitted working tree is not evidence that the work is finished
        // (cmate-verify's runner, `commits=0 uncommitted=n` -> not_started).
        // true -> false drops that demand, so it is a weakening.
        return String(change.to) === 'true' ? STRENGTHEN : WEAKEN;
      }
      if (change.key === 'requireEnvClean') {
        if (String(change.to) === String(change.from)) return null;
        // Turning it off switches the built-in env-clean gate off for the whole
        // repository (CommandMate #1740), i.e. one fewer judge. Same direction
        // rule as requireCommit; neither is ever WRITTEN, see assertNoWeakening.
        return String(change.to) === 'true' ? STRENGTHEN : WEAKEN;
      }
      // baseRef moves what "changed" means. It can be right, and it can never be
      // shown to be a strengthening from history alone.
      return WEAKEN;
    }
    case 'reorder-gates': {
      const before = [...change.from].sort();
      const after = [...change.to].sort();
      if (before.length !== after.length || before.some((id, i) => id !== after[i])) {
        throw new Error('internal: a reorder must not change the set of gates');
      }
      if (change.from.every((id, i) => id === change.to[i])) return null;
      return STRENGTHEN;
    }
    case 'add-gate':
      return STRENGTHEN;
    case 'remove-gate':
      return WEAKEN;
    default:
      throw new Error(`internal: unclassifiable change kind ${change.kind}`);
  }
}

/** Only a layer-1 strengthening in a known layer-1 shape may be written. */
function isApplicable(proposal) {
  return proposal.layer === 1 && proposal.direction === STRENGTHEN && LAYER1_KINDS.has(proposal.kind);
}

/**
 * Compare the bytes that would be written against the bytes on disk and refuse
 * anything that is a weakening, whatever the proposal bookkeeping said.
 *
 * This is deliberately redundant with `isApplicable()`. The bookkeeping is code
 * that can be edited; this reads the two files.
 */
function assertNoWeakening(before, after) {
  const beforeIds = before.gates.map((g) => g.id);
  const afterIds = after.gates.map((g) => g.id);
  const removed = beforeIds.filter((id) => !afterIds.includes(id));
  if (removed.length > 0) {
    throw new AdvisorError(EXIT_ERROR, `internal guard: --apply would remove gate(s): ${removed.join(', ')}`);
  }
  const added = afterIds.filter((id) => !beforeIds.includes(id));
  if (added.length > 0) {
    throw new AdvisorError(EXIT_ERROR, `internal guard: --apply would add gate(s): ${added.join(', ')} (adding a gate is a layer-2 proposal)`);
  }
  for (const gate of before.gates) {
    const next = after.gates.find((g) => g.id === gate.id);
    if (next.effectiveTimeoutSec > gate.effectiveTimeoutSec) {
      throw new AdvisorError(
        EXIT_ERROR,
        `internal guard: --apply would raise the timeout of gate ${gate.id} from ${gate.effectiveTimeoutSec}s to ${next.effectiveTimeoutSec}s`
      );
    }
  }
  if (after.effectiveMaxLogTailBytes < before.effectiveMaxLogTailBytes) {
    throw new AdvisorError(
      EXIT_ERROR,
      `internal guard: --apply would shrink options.maxLogTailBytes from ${before.effectiveMaxLogTailBytes} to ${after.effectiveMaxLogTailBytes}`
    );
  }
  const optionOf = (doc, key, fallback) => (doc.options.get(key) ? doc.options.get(key).value : fallback);
  if (optionOf(before, 'baseRef', '') !== optionOf(after, 'baseRef', '')) {
    throw new AdvisorError(EXIT_ERROR, 'internal guard: --apply would change options.baseRef');
  }
  if (optionOf(before, 'skipInPrimaryCheckout', DEFAULT_SKIP_IN_PRIMARY_CHECKOUT) !== optionOf(after, 'skipInPrimaryCheckout', DEFAULT_SKIP_IN_PRIMARY_CHECKOUT)) {
    throw new AdvisorError(EXIT_ERROR, 'internal guard: --apply would change options.skipInPrimaryCheckout');
  }
  // Turning requireCommit off is the weakening; turning it on is not something
  // layer 1 can argue for from durations and exit codes, so neither direction is
  // ever written. The guard is on the key, not on the direction.
  if (optionOf(before, 'requireCommit', DEFAULT_REQUIRE_COMMIT) !== optionOf(after, 'requireCommit', DEFAULT_REQUIRE_COMMIT)) {
    throw new AdvisorError(EXIT_ERROR, 'internal guard: --apply would change options.requireCommit');
  }
  if (optionOf(before, 'requireEnvClean', DEFAULT_REQUIRE_ENV_CLEAN) !== optionOf(after, 'requireEnvClean', DEFAULT_REQUIRE_ENV_CLEAN)) {
    throw new AdvisorError(EXIT_ERROR, 'internal guard: --apply would change options.requireEnvClean');
  }
  // The #1771 / #1772 gate fields are not layer-1 territory either. `mutex` is a
  // statement about a machine resource, `retryOnFail` / `flakyIsPass` about what
  // a red means — none of the three is derivable from durations and exit codes,
  // and dropping a `mutex` or raising `flakyIsPass` would be a weakening this
  // tool must never write. The guard is on the keys, not on the direction.
  for (const gate of before.gates) {
    const next = after.gates.find((g) => g.id === gate.id);
    for (const key of ['mutex', 'retryOnFail', 'flakyIsPass']) {
      if (String(gate[key] ?? '') !== String(next[key] ?? '')) {
        throw new AdvisorError(EXIT_ERROR, `internal guard: --apply would change gates[${gate.id}].${key}`);
      }
    }
  }
}

// =============================================================================
// History
// =============================================================================
//
// Shapes measured on CommandMate 0.17.0, 2026-08-02:
//
//   verify history --json -> [{ id, worktreeId, instanceId, taskId, trigger,
//     status, baseRef, startedAt, finishedAt,
//     gates: [{ gateId, status, exitCode, durationMs }] }]
//   verify show <id> --json -> the same run, but each gate additionally carries
//     { id, runId, command, logTail, startedAt, finishedAt }
//
// Two consequences the design has to live with:
//
//  * log tails exist only in `verify show`, so the log-budget analysis needs one
//    call per run and reports "not evaluated" when it did not get them;
//  * neither shape carries a commit sha, so "this exact commit failed and then
//    passed" cannot be decided here. Flake candidates are reported as candidates
//    with the gap named, not silently presented as flakes.

const EXECUTED = new Set(['passed', 'failed']);

function readSnapshot(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw usageError(`cannot read the snapshot ${path}: ${error.message}`);
  }
  if (Array.isArray(parsed)) return { history: parsed, details: null };
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.history)) {
    return { history: parsed.history, details: Array.isArray(parsed.details) ? parsed.details : null };
  }
  throw usageError(`${path} is neither a history array nor {"history": [...], "details": [...]}`);
}

// `launcher` is the resolved argv prefix, so a multi-token launcher spawns as
// program + fixed arguments + subcommand rather than as one impossible program
// name (Issue #37).
function runCli(launcher, args) {
  const cli = launcher.join(' ');
  const result = spawnSync(launcher[0], [...launcher.slice(1), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error && result.error.code === 'ENOENT') {
    throw noHistoryError(
      `\`${cli}\` is not on PATH.\n` +
        '  Verification history comes from `commandmate verify history --json`, which\n' +
        '  shipped in CommandMate 0.17.0. Without it this tool has nothing to learn from,\n' +
        '  and it will not guess. Install CommandMate >= 0.17.0, or pass a snapshot with --input.'
    );
  }
  if (result.error) throw usageError(`cannot run ${cli}: ${result.error.message}`);
  return result;
}

function collect(options) {
  const args = ['verify', 'history', '--json', '--days', String(options.days), '--limit', String(options.limit)];
  const worktrees = options.worktrees.length > 0 ? options.worktrees : [null];
  const history = [];
  for (const worktree of worktrees) {
    const call = worktree === null ? args : [...args, '--worktree', worktree];
    const result = runCli(options.cliArgv, call);
    if (result.status !== 0) {
      const version = runCli(options.cliArgv, ['--version']);
      const detected = version.status === 0 ? version.stdout.trim() : 'unknown';
      throw noHistoryError(
        `\`${options.cli} verify history\` failed (exit ${result.status}); detected version: ${detected}.\n` +
          `  ${(result.stderr || '').trim().split('\n').slice(0, 4).join('\n  ')}\n` +
          '  `verify history` shipped in CommandMate 0.17.0. This tool stops here rather than\n' +
          '  analysing a partial or absent history: advice derived from no evidence is worse\n' +
          '  than no advice. Upgrade CommandMate, or pass a saved snapshot with --input.'
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw usageError(`\`${options.cli} verify history --json\` did not print JSON: ${error.message}`);
    }
    if (!Array.isArray(parsed)) throw usageError(`\`${options.cli} verify history --json\` did not print an array`);
    history.push(...parsed);
  }

  let details = null;
  if (options.details) {
    details = [];
    const ids = [...new Set(history.map((run) => run.id))].sort((a, b) => a - b);
    for (const id of ids) {
      const result = runCli(options.cliArgv, ['verify', 'show', String(id), '--json']);
      if (result.status !== 0) continue; // a run that vanished between the two calls is not fatal
      try {
        details.push(JSON.parse(result.stdout));
      } catch {
        // A run whose detail is unreadable is dropped; the report says how many
        // runs actually carried log tails, so this cannot masquerade as "clean".
      }
    }
  }
  return { history, details };
}

function normaliseRuns(history, details, filters) {
  if (!Array.isArray(history)) throw usageError('history is not an array');
  const detailById = new Map();
  for (const run of details || []) {
    if (run && Number.isInteger(run.id)) detailById.set(run.id, run);
  }

  const runs = [];
  for (const run of history) {
    if (!run || typeof run !== 'object') throw usageError('history contains a non-object entry');
    if (!Number.isInteger(run.id)) throw usageError('history contains a run without an integer id');
    if (!Array.isArray(run.gates)) throw usageError(`run ${run.id} has no gates array`);
    if (typeof run.worktreeId !== 'string') throw usageError(`run ${run.id} has no worktreeId`);
    if (filters.worktreePrefixes.length > 0 && !filters.worktreePrefixes.some((p) => run.worktreeId.startsWith(p))) continue;

    const detail = detailById.get(run.id);
    const detailGates = new Map();
    for (const gate of (detail && detail.gates) || []) {
      if (gate && typeof gate.gateId === 'string') detailGates.set(gate.gateId, gate);
    }

    const gates = run.gates.map((gate) => {
      if (!gate || typeof gate.gateId !== 'string') throw usageError(`run ${run.id} has a gate without a gateId`);
      const extra = detailGates.get(gate.gateId);
      const logTail = extra && typeof extra.logTail === 'string' ? extra.logTail : null;
      return {
        gateId: gate.gateId,
        status: String(gate.status),
        exitCode: gate.exitCode === null || gate.exitCode === undefined ? null : Number(gate.exitCode),
        durationMs: Number.isFinite(gate.durationMs) ? Number(gate.durationMs) : null,
        hasDetail: Boolean(extra),
        logTailBytes: logTail === null ? null : Buffer.byteLength(logTail, 'utf8'),
        summaryDetected: logTail === null ? null : hasSummaryShape(logTail),
        // Kept BESIDE durationMs and never added to it: the duration is what the
        // gate's command took, the wait is what the machine made it queue for
        // (#1771). Folding them together would hide contention inside the one
        // number every timeout proposal below is computed from.
        waitedMs: parseWaitedMs(logTail),
        flaky: parseFlaky(extra ? extra.flaky : null, logTail),
      };
    });

    runs.push({
      id: run.id,
      worktreeId: run.worktreeId,
      status: String(run.status),
      trigger: run.trigger === null || run.trigger === undefined ? null : String(run.trigger),
      startedAt: typeof run.startedAt === 'string' ? run.startedAt : null,
      finishedAt: typeof run.finishedAt === 'string' ? run.finishedAt : null,
      gates,
    });
  }
  // Newest first is what the CLI returns; sorting explicitly makes the report
  // independent of that promise.
  runs.sort((a, b) => b.id - a.id);
  return runs;
}

/**
 * Does the text contain a line SHAPED like a runner's failure summary?
 *
 * The answer is a boolean and nothing else leaves this function. These patterns
 * match structure (a count, a banner, a compiler diagnostic code), never
 * meaning, and no matched text is stored, printed, or forwarded. An unrecognised
 * runner therefore reads as "no summary", which biases the tool towards
 * proposing MORE log budget — the strengthening direction.
 */
const SUMMARY_SHAPES = [
  /^\s*Tests?\s+(Files\s+)?\d+\s+\w+/m, //         vitest / jest tallies
  /\b\d+\s+(passing|failing|passed|failed|errors?|problems?)\b/i, // mocha, eslint, generic
  /^\s*(FAILED|FAIL|ERROR|error)\b/m, //           pytest / go test / generic banners
  /^\s*=+\s*\w[\w ]*\s*=+\s*$/m, //                pytest section rule
  /^npm ERR!/m, //                                 npm
  /\berror TS\d+\b/, //                            tsc
  /^\s*(ok|not ok)\s+\d+/m, //                     TAP
  /^\s*---\s*(FAIL|PASS)\b/m, //                   go test
  /\bexit(ed)?\s+(code|status)\s+\d+\b/i, //       shell wrappers
  /^\s*\d+\s+(tests?|checks?|assertions?)\b/im, // bash suites, "12 tests passed"
];

function hasSummaryShape(text) {
  return SUMMARY_SHAPES.some((pattern) => pattern.test(text));
}

// =============================================================================
// Machine-readable markers inside a gate's log tail
// =============================================================================
//
// `verification_gate_results` has one status, one exit code and one duration per
// gate and no column for a lock wait, so CommandMate's runner carries both of
// #1771's and #1772's extra facts as a LINE-ANCHORED first line of the log tail
// (verification-config.md sections 9.3 / 10.3). cmate-verify's standalone runner
// writes the same two markers.
//
// Reading them does not break the "log bodies are never interpreted" rule this
// tool is built on. The patterns are anchored at the start of a line, so a gate
// whose own output happens to print `waited=` cannot supply the number; every
// captured group is converted to a NUMBER or to one of two fixed words, and no
// matched text is ever stored, printed or forwarded. A log the patterns do not
// match reads as "no marker", which changes nothing.
const MUTEX_WAITED_PATTERN = /^\[mutex\] [^\n]*?\bwaited=([0-9]+(?:\.[0-9]+)?)s/m;
const FLAKY_PATTERN = /^\[flaky\] runs=(\d+) outcome=(flaky|fail) exit=(\S+) duration=(\S+) verdict=(pass|fail)$/m;

/** Milliseconds a gate spent queued for its `mutex`, or null when it declared none. */
function parseWaitedMs(logTail) {
  if (typeof logTail !== 'string') return null;
  const match = MUTEX_WAITED_PATTERN.exec(logTail);
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

/**
 * What a retried gate's two runs amounted to (Issue #224 / CommandMate #1772).
 *
 * The structured field wins when the CLI supplied one (`verify show --json`
 * exposes the marker as `gates[].flaky`); the log marker is the fallback for a
 * runner or a snapshot that carries only the text.
 *
 * @returns {{runs:number, outcome:'flaky'|'fail', verdict:'pass'|'fail'}|null}
 *          null for every gate that was never retried — which is every gate that
 *          did not declare `retryOnFail: 1` and every one that passed first time.
 */
function parseFlaky(structured, logTail) {
  if (structured && typeof structured === 'object') {
    const outcome = String(structured.outcome ?? '');
    const verdict = String(structured.verdict ?? '');
    if ((outcome === 'flaky' || outcome === 'fail') && (verdict === 'pass' || verdict === 'fail')) {
      return { runs: Number.isFinite(structured.runs) ? Number(structured.runs) : 2, outcome, verdict };
    }
  }
  if (typeof logTail !== 'string') return null;
  const match = FLAKY_PATTERN.exec(logTail);
  if (!match) return null;
  return { runs: Number(match[1]), outcome: match[2], verdict: match[5] };
}

// =============================================================================
// Statistics
// =============================================================================

/** Nearest-rank percentile — integer arithmetic only, so it never drifts. */
function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * sortedAscending.length));
  return sortedAscending[Math.min(rank, sortedAscending.length) - 1];
}

function summarise(runs, config) {
  const declared = new Set(config.gates.map((g) => g.id));
  const stats = new Map();
  for (const gate of config.gates) {
    stats.set(gate.id, {
      id: gate.id,
      declaredIndex: gate.index,
      timeoutSec: gate.effectiveTimeoutSec,
      timeoutIsDefault: gate.timeoutIsDefault,
      executed: 0,
      failed: 0,
      durationsMs: [],
      samples: [],
      censoredBy: [],
      truncatedFailures: [],
      detailedRuns: 0,
      // #1771 / #1772 evidence, collected separately from the duration series on
      // purpose. `waitedBy` is what a lock cost this gate; `flakyRuns` /
      // `flakyFailRuns` are the two halves of the flakiness ratio — the runner
      // writes the marker for a gate that failed TWICE as well, precisely so the
      // denominator exists and every retried gate does not look flaky.
      waitedBy: [],
      flakyRuns: [],
      flakyFailRuns: [],
    });
  }
  const undeclared = new Map();
  const worktrees = new Map();

  for (const run of runs) {
    for (const gate of run.gates) {
      if (!declared.has(gate.gateId)) {
        if (!RESERVED_GATE_IDS.has(gate.gateId)) {
          undeclared.set(gate.gateId, (undeclared.get(gate.gateId) || 0) + 1);
        }
        continue;
      }
      const stat = stats.get(gate.gateId);
      if (gate.hasDetail) stat.detailedRuns += 1;
      if (!EXECUTED.has(gate.status)) continue;

      stat.executed += 1;
      worktrees.set(run.worktreeId, (worktrees.get(run.worktreeId) || 0) + 1);
      if (gate.status === 'failed') stat.failed += 1;
      if (gate.durationMs !== null) stat.durationsMs.push(gate.durationMs);
      // NOT pushed into durationsMs. See the field comment above.
      if (gate.waitedMs !== null) stat.waitedBy.push({ runId: run.id, at: run.finishedAt, waitedMs: gate.waitedMs });
      if (gate.flaky !== null) {
        const record = { runId: run.id, at: run.finishedAt, verdict: gate.flaky.verdict, runs: gate.flaky.runs };
        if (gate.flaky.outcome === 'flaky') stat.flakyRuns.push(record);
        else stat.flakyFailRuns.push(record);
      }
      stat.samples.push({ runId: run.id, at: run.finishedAt || run.startedAt, worktreeId: run.worktreeId, ...gate });

      // A run that reached its own timeout censors the duration distribution:
      // the number is the limit, not the work. Percentiles computed over
      // censored samples must never be used to argue for a SHORTER timeout.
      const timedOut = gate.exitCode === TIMEOUT_EXIT_CODE || (gate.durationMs !== null && gate.durationMs >= stat.timeoutSec * 1000 * CENSOR_RATIO);
      if (timedOut) stat.censoredBy.push({ runId: run.id, at: run.finishedAt, durationMs: gate.durationMs, exitCode: gate.exitCode });

      // Truncation: the stored tail reached the configured budget exactly, and
      // no line in it looks like a summary. Both facts are structural.
      if (gate.status === 'failed' && gate.logTailBytes !== null) {
        const capped = gate.logTailBytes >= config.effectiveMaxLogTailBytes && config.effectiveMaxLogTailBytes > 0;
        if (capped && gate.summaryDetected === false) {
          stat.truncatedFailures.push({ runId: run.id, at: run.finishedAt, logTailBytes: gate.logTailBytes, exitCode: gate.exitCode });
        }
      }
    }
  }

  for (const stat of stats.values()) {
    const sorted = [...stat.durationsMs].sort((a, b) => a - b);
    stat.p50Ms = percentile(sorted, 0.5);
    stat.p99Ms = percentile(sorted, 0.99);
    stat.maxMs = sorted.length > 0 ? sorted[sorted.length - 1] : null;
    stat.failRate = stat.executed > 0 ? stat.failed / stat.executed : 0;
    stat.maxWaitedMs = stat.waitedBy.length > 0 ? Math.max(...stat.waitedBy.map((w) => w.waitedMs)) : null;
    stat.retriedRuns = stat.flakyRuns.length + stat.flakyFailRuns.length;
    stat.samples.sort((a, b) => b.runId - a.runId);
  }
  return { stats, undeclared, worktrees };
}

/**
 * Fail -> pass for the same gate in the same worktree.
 *
 * `verify history` carries no commit sha, so this cannot prove the two runs saw
 * the same tree. It is evidence for a human, which is also why nothing here is
 * ever auto-quarantined: a flaky gate and a real intermittent bug look the same
 * from this side, and quarantining the second one is how an escape happens.
 */
function flakeCandidates(runs, declaredIds) {
  const byWorktree = new Map();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) {
    for (const gate of run.gates) {
      if (!declaredIds.has(gate.gateId)) continue;
      if (!EXECUTED.has(gate.status)) continue;
      const key = `${run.worktreeId} | ${gate.gateId}`;
      if (!byWorktree.has(key)) byWorktree.set(key, []);
      byWorktree.get(key).push({ runId: run.id, at: run.finishedAt, status: gate.status, exitCode: gate.exitCode });
    }
  }
  const out = [];
  for (const [key, series] of [...byWorktree.entries()].sort()) {
    const [worktreeId, gateId] = key.split(' | ');
    for (let i = 1; i < series.length; i += 1) {
      if (series[i - 1].status === 'failed' && series[i].status === 'passed') {
        out.push({ worktreeId, gateId, failedRun: series[i - 1], passedRun: series[i] });
      }
    }
  }
  return out;
}

// =============================================================================
// Layer 1 proposals
// =============================================================================

function proposeTimeouts(config, stats, minSamples) {
  const proposals = [];
  for (const gate of config.gates) {
    const stat = stats.get(gate.id);
    if (stat.executed < minSamples || stat.p99Ms === null) continue;

    let target = Math.ceil((stat.p99Ms * TIMEOUT_HEADROOM) / 1000);
    // p99 x 1.5 is the design's formula, but a nearest-rank p99 over a large
    // sample sits BELOW the maximum, and a timeout under a duration that has
    // actually been observed manufactures failures. Manufactured failures do not
    // reduce the escape rate; they teach people to disable the gate. So the
    // slowest observed run is a hard floor.
    target = Math.max(target, Math.ceil(stat.maxMs / 1000));
    target = Math.max(TIMEOUT_FLOOR_SEC, Math.min(MAX_TIMEOUT_SEC, target));
    const current = stat.timeoutSec;
    if (target === current) continue;

    const delta = Math.abs(target - current);
    if (delta < Math.max(TIMEOUT_CHANGE_MIN_SEC, current * TIMEOUT_CHANGE_MIN_RATIO)) continue;

    // Never shorten a timeout on evidence the timeout itself produced.
    if (target < current && stat.censoredBy.length > 0) continue;
    // Never shorten the timeout of a gate that has been seen queueing for a
    // `mutex` either (Issue #223 / CommandMate #1771). For such a gate
    // `timeoutSec` is TWO budgets — the lock wait and then the command — and the
    // durations this proposal is computed from deliberately exclude the wait. A
    // shorter number derived from them would start turning contention into
    // `GATE <id> SKIP reason=mutex-wait`, which is a gate that reached no
    // verdict at all: strictly worse than the slack it removed.
    if (target < current && stat.waitedBy.length > 0) continue;

    const direction = classifyChange({ kind: 'set-timeout', to: target, from: current });
    if (direction === null) continue;
    proposals.push({
      id: `timeout:${gate.id}`,
      layer: 1,
      kind: 'set-timeout',
      direction,
      target: `gates[${gate.id}].timeoutSec`,
      from: current,
      to: target,
      rationale:
        `p99 of ${stat.executed} executed run(s) is ${stat.p99Ms}ms (slowest ${stat.maxMs}ms); ` +
        `p99 x ${TIMEOUT_HEADROOM}, floored at the slowest run, gives ${target}s ` +
        `against the ${gate.timeoutIsDefault ? 'default' : 'declared'} ${current}s` +
        (stat.censoredBy.length > 0 ? ` (${stat.censoredBy.length} run(s) hit the current timeout, so the distribution is censored)` : '') +
        // Stated, not folded in: the reader has to be able to see that the wait
        // was excluded from the number and is still part of the budget.
        (stat.waitedBy.length > 0
          ? ` (mutex wait excluded from every duration above: ${stat.waitedBy.length} run(s) queued, longest ${stat.maxWaitedMs}ms)`
          : ''),
      evidence: stat.samples.slice(0, 5).map(citation(gate.id)),
      change: { kind: 'set-timeout', gateId: gate.id, from: current, to: target },
    });
  }
  return proposals;
}

function proposeOrder(config, stats, minSamples) {
  const current = config.gates.map((g) => g.id);
  const short = current.filter((id) => stats.get(id).executed < minSamples);
  if (short.length > 0) return { proposals: [], skipped: short };

  // Fail-fast: gates that have actually failed go first, most failure-prone
  // first; among equals the cheap one goes first. Declaration order breaks any
  // remaining tie so the sort is total and the output is reproducible.
  const ranked = [...current].sort((a, b) => {
    const sa = stats.get(a);
    const sb = stats.get(b);
    if (sa.failRate !== sb.failRate) return sb.failRate - sa.failRate;
    const ca = sa.p50Ms === null ? Number.MAX_SAFE_INTEGER : sa.p50Ms;
    const cb = sb.p50Ms === null ? Number.MAX_SAFE_INTEGER : sb.p50Ms;
    if (ca !== cb) return ca - cb;
    return sa.declaredIndex - sb.declaredIndex;
  });

  const direction = classifyChange({ kind: 'reorder-gates', from: current, to: ranked });
  if (direction === null) return { proposals: [], skipped: [] };

  const evidence = [];
  for (const id of ranked) {
    const stat = stats.get(id);
    evidence.push({
      gateId: id,
      runs: stat.executed,
      failed: stat.failed,
      p50Ms: stat.p50Ms,
      note: `fail-rate ${(stat.failRate * 100).toFixed(1)}% over ${stat.executed} run(s), median ${stat.p50Ms}ms`,
    });
  }
  return {
    proposals: [
      {
        id: 'order:gates',
        layer: 1,
        kind: 'reorder-gates',
        direction,
        target: 'gates[]',
        from: current.join(','),
        to: ranked.join(','),
        rationale: 'fail-fast order: gates that have failed run first, cheapest first among equals; the set of gates is unchanged',
        evidence,
        change: { kind: 'reorder-gates', from: current, to: ranked },
      },
    ],
    skipped: [],
  };
}

function proposeLogBudget(config, stats) {
  const truncated = [];
  for (const stat of stats.values()) truncated.push(...stat.truncatedFailures.map((t) => ({ ...t, gateId: stat.id })));
  if (truncated.length === 0) return [];

  const current = config.effectiveMaxLogTailBytes;
  let target = Math.max(DEFAULT_MAX_LOG_TAIL_BYTES, current * 2);
  target = Math.min(MAX_LOG_TAIL_BYTES_LIMIT, target);
  const direction = classifyChange({ kind: 'set-option', key: 'maxLogTailBytes', from: current, to: target });
  if (direction === null) return [];

  truncated.sort((a, b) => b.runId - a.runId);
  return [
    {
      id: 'log:maxLogTailBytes',
      layer: 1,
      kind: 'set-option',
      direction,
      target: 'options.maxLogTailBytes',
      from: current,
      to: target,
      rationale:
        `${truncated.length} failing gate run(s) stored a log tail of exactly ${current} bytes with no summary-shaped line in it — ` +
        'the reason the gate failed was cut off the front of the tail',
      evidence: truncated.slice(0, 5).map((t) => ({
        runId: t.runId,
        at: t.at,
        gateId: t.gateId,
        fact: `logTailBytes=${t.logTailBytes} cap=${current} summaryDetected=false exit=${t.exitCode}`,
        readIt: `commandmate verify show ${t.runId}`,
      })),
      change: { kind: 'set-option', key: 'maxLogTailBytes', from: current, to: target },
    },
  ];
}

/**
 * Structured citations. The log BODY is never one of them: the report tells the
 * reader the command that prints it in their own terminal instead.
 */
const citation = (gateId) => (sample) => ({
  runId: sample.runId,
  at: sample.at,
  gateId,
  fact: `status=${sample.status} exit=${sample.exitCode} duration=${sample.durationMs}ms`,
  readIt: `commandmate verify show ${sample.runId}`,
});

// =============================================================================
// Layer 2 proposals (authored elsewhere, rendered and diffed here)
// =============================================================================
//
// Layer 2 is the part that needs judgement — correlating passed runs against
// reverts and fix commits, reading a flake candidate. Whatever produces those
// conclusions does NOT get to write verify.yaml: it hands this script a small
// JSON document, which is validated, classified by the same rules as layer 1,
// rendered into the same diff, and never applied.

function readLayer2(path, config) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw usageError(`cannot read the layer-2 proposals ${path}: ${error.message}`);
  }
  const items = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.proposals) ? parsed.proposals : null;
  if (!items) throw usageError(`${path} is neither an array nor {"proposals": [...]}`);

  const declared = new Set(config.gates.map((g) => g.id));
  const proposals = [];
  items.forEach((item, index) => {
    const where = `${path}[${index}]`;
    if (!item || typeof item !== 'object') throw usageError(`${where}: not an object`);
    const kind = String(item.kind || '');
    if (!KNOWN_KINDS.has(kind)) throw usageError(`${where}: unknown kind: ${kind || '(missing)'}`);
    const rationale = typeof item.rationale === 'string' && item.rationale.trim() !== '' ? item.rationale.trim() : null;
    if (!rationale) throw usageError(`${where}: a proposal without a rationale is not reviewable`);
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    if (evidence.length === 0) throw usageError(`${where}: a proposal without evidence is not reviewable`);
    for (const entry of evidence) {
      if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.runId)) {
        throw usageError(`${where}: every evidence entry needs an integer runId`);
      }
    }

    let change;
    let target;
    let id;
    if (kind === 'add-gate') {
      const gate = item.gate;
      if (!gate || typeof gate !== 'object') throw usageError(`${where}: add-gate needs a gate object`);
      if (typeof gate.id !== 'string' || !GATE_ID_RE.test(gate.id)) throw usageError(`${where}: invalid gate id`);
      if (RESERVED_GATE_IDS.has(gate.id)) throw usageError(`${where}: gate id is reserved: ${gate.id}`);
      if (declared.has(gate.id)) throw usageError(`${where}: gate already declared: ${gate.id}`);
      if (typeof gate.command !== 'string' || gate.command.trim() === '') throw usageError(`${where}: add-gate needs a command`);
      if (gate.timeoutSec !== undefined && gate.timeoutSec !== null) {
        if (!Number.isInteger(gate.timeoutSec) || gate.timeoutSec < MIN_TIMEOUT_SEC || gate.timeoutSec > MAX_TIMEOUT_SEC) {
          throw usageError(`${where}: timeoutSec must be an integer ${MIN_TIMEOUT_SEC}..${MAX_TIMEOUT_SEC}`);
        }
      }
      change = { kind, gate, position: typeof item.position === 'string' ? item.position : 'end' };
      target = `gates[+${gate.id}]`;
      id = `layer2:add-gate:${gate.id}`;
    } else if (kind === 'remove-gate') {
      if (typeof item.gateId !== 'string' || !declared.has(item.gateId)) throw usageError(`${where}: remove-gate names an undeclared gate`);
      change = { kind, gateId: item.gateId };
      target = `gates[-${item.gateId}]`;
      id = `layer2:remove-gate:${item.gateId}`;
    } else if (kind === 'set-timeout') {
      if (typeof item.gateId !== 'string' || !declared.has(item.gateId)) throw usageError(`${where}: set-timeout names an undeclared gate`);
      if (!Number.isInteger(item.value) || item.value < MIN_TIMEOUT_SEC || item.value > MAX_TIMEOUT_SEC) {
        throw usageError(`${where}: set-timeout value must be an integer ${MIN_TIMEOUT_SEC}..${MAX_TIMEOUT_SEC}`);
      }
      const from = config.gates.find((g) => g.id === item.gateId).effectiveTimeoutSec;
      change = { kind, gateId: item.gateId, from, to: item.value };
      target = `gates[${item.gateId}].timeoutSec`;
      id = `layer2:timeout:${item.gateId}`;
    } else if (kind === 'set-option') {
      if (!OPTION_KEYS.has(item.key)) throw usageError(`${where}: unknown options key: ${item.key}`);
      const existing = config.options.get(item.key);
      const from = existing ? existing.value : OPTION_DEFAULTS.get(item.key) ?? '';
      change = { kind, key: item.key, from, to: String(item.value) };
      target = `options.${item.key}`;
      id = `layer2:option:${item.key}`;
    } else {
      // `reorder-gates` is derived from measured durations and fail rates; there
      // is nothing for judgement to add, so layer 2 does not get to hand-order
      // the gates.
      throw usageError(`${where}: ${kind} is a layer-1 change and is not accepted from layer 2`);
    }

    const direction = classifyChange(change);
    if (direction === null) throw usageError(`${where}: the proposal changes nothing`);
    proposals.push({ id, layer: 2, kind, direction, target, from: change.from, to: change.to, rationale, evidence, change });
  });
  return proposals;
}

// =============================================================================
// Diff
// =============================================================================

function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

function diffOps(a, b) {
  const table = lcsTable(a, b);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: ' ', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ op: '-', text: a[i] });
      i += 1;
    } else {
      ops.push({ op: '+', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ op: '-', text: a[i++] });
  while (j < b.length) ops.push({ op: '+', text: b[j++] });
  return ops;
}

function unifiedDiff(before, after, label, context = 3) {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  const ops = diffOps(a, b);

  // Group the changed positions, then pad each group with `context` unchanged
  // lines on both sides. Two groups closer than 2*context merge, which is what
  // stops a hunk header from appearing between two lines of shared context.
  const changed = [];
  ops.forEach((op, i) => {
    if (op.op !== ' ') changed.push(i);
  });
  const merged = [];
  for (const at of changed) {
    const last = merged[merged.length - 1];
    if (last && at - last.lastChange <= context * 2) last.lastChange = at;
    else merged.push({ firstChange: at, lastChange: at });
  }
  for (const hunk of merged) {
    hunk.start = Math.max(0, hunk.firstChange - context);
    hunk.end = Math.min(ops.length, hunk.lastChange + context + 1);
  }

  const out = [`--- a/${label}`, `+++ b/${label}`];
  for (const hunk of merged) {
    let aStart = 0;
    let bStart = 0;
    for (let k = 0; k < hunk.start; k += 1) {
      if (ops[k].op !== '+') aStart += 1;
      if (ops[k].op !== '-') bStart += 1;
    }
    let aCount = 0;
    let bCount = 0;
    const body = [];
    for (let k = hunk.start; k < hunk.end; k += 1) {
      if (ops[k].op !== '+') aCount += 1;
      if (ops[k].op !== '-') bCount += 1;
      body.push(`${ops[k].op}${ops[k].text}`);
    }
    out.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    out.push(...body);
  }
  return out.join('\n');
}

// =============================================================================
// Assembling the run
// =============================================================================

function editsFor(config, proposals) {
  const edits = [];
  for (const proposal of proposals) {
    const change = proposal.change;
    if (change.kind === 'set-timeout') edits.push(...editSetGateTimeout(config, change.gateId, change.to));
    else if (change.kind === 'set-option') edits.push(...editSetOption(config, change.key, change.to));
    else if (change.kind === 'reorder-gates') edits.push({ type: 'reorder', order: change.to });
    else if (change.kind === 'add-gate') edits.push(...editAddGate(config, change.gate, change.position));
    else if (change.kind === 'remove-gate') edits.push(...editRemoveGate(config, change.gateId));
    else throw new Error(`internal: no editor for ${change.kind}`);
  }
  return edits;
}

function renderWith(config, proposals) {
  return renderConfig(config, editsFor(config, proposals));
}

function proposalSortKey(proposal) {
  const kindOrder = { 'reorder-gates': 0, 'set-timeout': 1, 'set-option': 2, 'add-gate': 3, 'remove-gate': 4 };
  return [proposal.layer, kindOrder[proposal.kind] ?? 9, proposal.id];
}

function sortProposals(proposals) {
  return [...proposals].sort((a, b) => {
    const ka = proposalSortKey(a);
    const kb = proposalSortKey(b);
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
}

function buildReport(config, runs, analysis, proposals, options) {
  const { stats, undeclared, worktrees } = analysis;
  const observations = [];

  const detailed = runs.filter((run) => run.gates.some((g) => g.hasDetail)).length;
  if (!options.details) {
    observations.push({
      code: 'log-tail-not-evaluated',
      detail: '--no-details was passed, so no log tail was read; the log-budget check did not run',
    });
  } else if (detailed === 0 && runs.length > 0) {
    observations.push({
      code: 'log-tail-not-evaluated',
      detail: 'no run carried gate log tails (verify show returned none), so the log-budget check did not run',
    });
  }

  for (const stat of [...stats.values()].sort((a, b) => a.declaredIndex - b.declaredIndex)) {
    if (stat.executed === 0) {
      observations.push({ code: 'gate-never-ran', detail: `gate ${stat.id} was never executed in this window; nothing is advised for it` });
    } else if (stat.executed < options.minSamples) {
      observations.push({
        code: 'gate-under-sampled',
        detail: `gate ${stat.id} has ${stat.executed} executed run(s), below the --min-samples ${options.minSamples} threshold`,
      });
    }
    if (stat.waitedBy.length > 0) {
      observations.push({
        code: 'mutex-wait-observed',
        detail:
          `gate ${stat.id} queued for its mutex in ${stat.waitedBy.length} run(s) (longest ${stat.maxWaitedMs}ms). ` +
          'The wait is excluded from every duration above and from the timeout arithmetic, and no SHORTER timeout is ' +
          'proposed for it: for a mutexed gate timeoutSec is the lock-wait budget as well as the command budget',
      });
    }
    if (stat.censoredBy.length > 0) {
      observations.push({
        code: 'timeout-censored',
        detail:
          `gate ${stat.id} reached its ${stat.timeoutSec}s timeout in ${stat.censoredBy.length} run(s) ` +
          `(run ${stat.censoredBy.map((c) => c.runId).join(', ')}); its duration distribution is censored and no shorter timeout is proposed from it`,
      });
    }
  }
  for (const [gateId, count] of [...undeclared.entries()].sort()) {
    observations.push({
      code: 'gate-in-history-not-in-config',
      detail: `gate ${gateId} appears in ${count} historical run(s) but is not declared in this config (a different repository's config, or a gate that was removed)`,
    });
  }
  const contributors = [...worktrees.keys()].sort();
  if (contributors.length > 1) {
    observations.push({
      code: 'multiple-worktrees',
      detail: `samples come from ${contributors.length} worktrees: ${contributors.join(', ')}. verify history is machine-wide; use --worktree-prefix to scope it`,
    });
  }
  const errored = runs.filter((run) => run.status === 'error');
  if (errored.length > 0) {
    observations.push({
      code: 'runner-error-runs',
      detail: `${errored.length} run(s) ended with status=error (run ${errored.map((r) => r.id).join(', ')}); those are runner failures, not gate failures, and are not counted as such`,
    });
  }
  // Layer 2's flakiness input, in two tiers, and they are NOT the same claim.
  //
  //  1. `flake-observed` is a MEASUREMENT. The runner re-ran the gate in the
  //     same tree and the two runs disagreed, so the "did the tree change
  //     between these runs" gap that makes tier 2 a candidate does not exist
  //     here (Issue #224 / CommandMate #1772). The denominator is reported with
  //     it: a gate that failed twice is evidence AGAINST flakiness, and the
  //     runner writes the marker for that case too so the ratio can be read.
  //  2. `flake-candidate` is an INFERENCE — fail then pass across two separate
  //     runs, which `verify history` cannot tie to one commit.
  //
  // Both are kept. Tier 1 only exists for gates that opted into `retryOnFail`,
  // so dropping tier 2 would make every repository that has not opted in look
  // flake-free; and reporting tier 2 for a gate that has tier 1 evidence would
  // present the weaker claim beside the stronger one as though they ranked the
  // same. So tier 2 is suppressed per gate exactly where tier 1 spoke.
  const measuredFlaky = new Set();
  for (const stat of [...stats.values()].sort((a, b) => a.declaredIndex - b.declaredIndex)) {
    if (stat.retriedRuns === 0) continue;
    measuredFlaky.add(stat.id);
    const tolerated = stat.flakyRuns.filter((entry) => entry.verdict === 'pass').length;
    observations.push({
      code: stat.flakyRuns.length > 0 ? 'flake-observed' : 'flake-refuted',
      detail:
        `gate ${stat.id} was re-run in the same tree ${stat.retriedRuns} time(s): ` +
        `${stat.flakyRuns.length} FLAKY (failed then passed${stat.flakyRuns.length > 0 ? `, ${tolerated} of them counted as a pass by flakyIsPass` : ''})` +
        `, ${stat.flakyFailRuns.length} failed twice` +
        (stat.flakyRuns.length > 0
          ? `. This is measured, not inferred: both runs judged the same tree (run ${stat.flakyRuns.map((entry) => entry.runId).join(', ')})`
          : '. Two failures in the same tree are evidence AGAINST flakiness, which is why the marker is written for them too'),
    });
  }
  for (const candidate of flakeCandidates(runs, new Set(config.gates.map((g) => g.id)))) {
    if (measuredFlaky.has(candidate.gateId)) continue;
    observations.push({
      code: 'flake-candidate',
      detail:
        `gate ${candidate.gateId} failed in run ${candidate.failedRun.runId} and passed in run ${candidate.passedRun.runId} ` +
        `on worktree ${candidate.worktreeId}. verify history carries no commit sha, so this is a CANDIDATE for layer 2 to correlate ` +
        'against git log — not a flake, and never auto-quarantined. Declaring `retryOnFail: 1` on this gate would turn the ' +
        'inference into a measurement (CommandMate #1772)',
    });
  }

  return { observations, proposals: sortProposals(proposals) };
}

function formatReport(config, runs, report, diffs, options) {
  const out = [];
  out.push('# cmate-verify-advisor — layer 1 report');
  out.push('');
  out.push('advisor: objective=escape-rate+time-to-detection (the pass rate is not an objective)');
  out.push(`advisor: config=${options.configLabel}`);
  out.push(`advisor: source=${options.source}`);
  const window = runs.length > 0 ? `${runs[runs.length - 1].finishedAt || '?'}..${runs[0].finishedAt || '?'}` : '(empty)';
  out.push(`advisor: runs=${runs.length} gates=${config.gates.length} window=${window}`);
  out.push('');

  out.push('## observations');
  if (report.observations.length === 0) out.push('(none)');
  for (const observation of report.observations) out.push(`OBSERVATION ${observation.code} ${observation.detail}`);
  out.push('');

  out.push('## proposals');
  if (report.proposals.length === 0) {
    out.push('(none)');
    out.push('advisor: no change proposed — this is a normal outcome, not a failure.');
    out.push('advisor: there was no evidence for a change today, so no change was invented.');
  }
  for (const proposal of report.proposals) {
    out.push(
      `PROPOSAL ${proposal.id} layer=${proposal.layer} kind=${proposal.kind} direction=${proposal.direction} ` +
        `applicable=${isApplicable(proposal) ? 'yes' : 'no'}`
    );
    out.push(`  target: ${proposal.target}`);
    out.push(`  change: ${proposal.from} -> ${proposal.to}`);
    out.push(`  rationale: ${proposal.rationale}`);
    if (proposal.direction === WEAKEN) {
      out.push('  NOTE: this is a weakening. It is proposal-only whatever flags are passed; a human must review and merge it.');
    } else if (proposal.layer === 2) {
      out.push('  NOTE: layer-2 proposals are never applied by this script, strengthening or not.');
    }
    for (const entry of proposal.evidence) {
      if (entry.runId !== undefined) {
        out.push(`  evidence: run=${entry.runId} at=${entry.at ?? '?'} gate=${entry.gateId ?? '?'} ${entry.fact ?? ''}`.trimEnd());
        if (entry.readIt) out.push(`            read the log yourself: ${entry.readIt}`);
      } else {
        out.push(`  evidence: gate=${entry.gateId} ${entry.note}`);
      }
    }
    out.push('');
  }

  if (diffs.all) {
    out.push('## proposed diff (every proposal)');
    out.push(diffs.all);
    out.push('');
  }
  if (diffs.applicable && diffs.applicable !== diffs.all) {
    out.push('## applicable diff (--apply writes only this)');
    out.push(diffs.applicable);
    out.push('');
  }

  const applicable = report.proposals.filter(isApplicable).length;
  out.push(
    `RESULT proposals=${report.proposals.length} applicable=${applicable} withheld=${report.proposals.length - applicable} applied=${options.applied}`
  );
  return out.join('\n');
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs(argv) {
  const options = {
    config: null,
    cwd: process.cwd(),
    input: null,
    dump: null,
    proposals: null,
    // null means "not passed": the launcher falls through to $CM and then to the
    // bare default. Resolved in main(), so --help still answers with a --cli the
    // resolver would refuse (Issue #37).
    cli: null,
    cliArgv: null,
    worktrees: [],
    worktreePrefixes: [],
    days: 30,
    limit: 200,
    minSamples: MIN_SAMPLES_DEFAULT,
    details: true,
    apply: false,
    json: false,
    help: false,
  };
  const need = (index, flag) => {
    if (index + 1 >= argv.length) throw usageError(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--config': options.config = need(i, arg); i += 1; break;
      case '--cwd': options.cwd = need(i, arg); i += 1; break;
      case '--input': options.input = need(i, arg); i += 1; break;
      case '--dump': options.dump = need(i, arg); i += 1; break;
      case '--proposals': options.proposals = need(i, arg); i += 1; break;
      case '--cli': options.cli = need(i, arg); i += 1; break;
      case '--worktree': options.worktrees.push(need(i, arg)); i += 1; break;
      case '--worktree-prefix': options.worktreePrefixes.push(need(i, arg)); i += 1; break;
      case '--days': options.days = Number(need(i, arg)); i += 1; break;
      case '--limit': options.limit = Number(need(i, arg)); i += 1; break;
      case '--min-samples': options.minSamples = Number(need(i, arg)); i += 1; break;
      case '--no-details': options.details = false; break;
      case '--apply': options.apply = true; break;
      case '--json': options.json = true; break;
      case '-h':
      case '--help': options.help = true; break;
      default: throw usageError(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 90) throw usageError('--days must be an integer 1..90');
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) throw usageError('--limit must be an integer 1..500');
  if (!Number.isInteger(options.minSamples) || options.minSamples < 1) throw usageError('--min-samples must be an integer >= 1');
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }

  options.cliArgv = resolveLauncher(options.cli);
  options.cli = options.cliArgv.join(' ');

  const cwd = resolve(options.cwd);
  const configPath = resolve(options.config || `${cwd}/.commandmate/verify.yaml`);
  // --apply writes, so the target has to be inside the worktree it was asked to
  // advise on. A config path that escapes it is refused rather than followed.
  if (configPath !== cwd && !configPath.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep)) {
    throw usageError(`--config must live inside --cwd (${cwd}); got ${configPath}`);
  }
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw usageError(`cannot read the config ${configPath}: ${error.message}\n  cmate-verify drafts a verify.yaml; this Skill only improves one that exists.`);
  }
  const config = parseConfig(text, configPath);

  const snapshot = options.input ? readSnapshot(options.input) : collect(options);
  if (options.dump) writeFileSync(options.dump, `${JSON.stringify(snapshot, null, 2)}\n`);
  // --no-details means "do not read log tails", not "do not fetch them". A
  // snapshot that happens to carry them must not sneak the log-budget analysis
  // back in behind the flag.
  if (!options.details) snapshot.details = null;

  const runs = normaliseRuns(snapshot.history, snapshot.details, options);
  if (runs.length === 0) {
    throw noHistoryError(
      'no verification run matched.\n' +
        '  There is nothing to learn from, so nothing is proposed and nothing is guessed.\n' +
        '  Widen --days / --limit, drop --worktree-prefix, or run some verifications first.'
    );
  }

  const analysis = summarise(runs, config);
  const layer1 = [
    ...proposeOrder(config, analysis.stats, options.minSamples).proposals,
    ...proposeTimeouts(config, analysis.stats, options.minSamples),
    ...proposeLogBudget(config, analysis.stats),
  ];
  const layer2 = options.proposals ? readLayer2(options.proposals, config) : [];
  const report = buildReport(config, runs, analysis, [...layer1, ...layer2], options);

  const applicable = report.proposals.filter(isApplicable);
  const label = relative(cwd, configPath) || configPath;
  const allText = renderWith(config, report.proposals);
  const applicableText = renderWith(config, applicable);

  // A diff a human might merge has to produce a file cmate-verify's runner can
  // read; otherwise the next verification is exit 2 rather than a verdict. The
  // whole-proposal set can legitimately fail this (layer 2 may propose removing
  // the last gate), so it is reported rather than raised — silently shipping an
  // unparseable diff is the failure mode worth avoiding.
  if (allText !== config.text) {
    try {
      parseConfig(allText, `${configPath} (proposed)`);
    } catch (error) {
      report.observations.push({
        code: 'proposed-config-invalid',
        detail: `applying every proposal would produce a verify.yaml the runner rejects — ${String(error.message).split('\n').slice(1).join(' ').trim() || error.message}`,
      });
    }
  }
  const diffs = {
    all: unifiedDiff(config.text, allText, label),
    applicable: unifiedDiff(config.text, applicableText, label),
  };

  let applied = 0;
  if (options.apply && applicable.length > 0) {
    for (const proposal of applicable) {
      if (!isApplicable(proposal)) throw new AdvisorError(EXIT_ERROR, `internal guard: refused to apply ${proposal.id}`);
    }
    // Re-parse the bytes that would be written: a config the runner rejects is
    // exit 2 at verification time, which this tool must not be able to cause.
    const after = parseConfig(applicableText, `${configPath} (proposed)`);
    assertNoWeakening(config, after);
    writeFileSync(configPath, applicableText);
    applied = applicable.length;
  }

  const meta = {
    ...options,
    configLabel: label,
    source: options.input ? `snapshot ${options.input}` : `${options.cli} verify history`,
    applied,
  };

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          objective: 'escape-rate and time-to-detection; the pass rate is not an objective',
          config: label,
          source: meta.source,
          runs: runs.length,
          observations: report.observations,
          proposals: report.proposals.map((p) => ({
            id: p.id,
            layer: p.layer,
            kind: p.kind,
            direction: p.direction,
            applicable: isApplicable(p),
            target: p.target,
            from: p.from,
            to: p.to,
            rationale: p.rationale,
            evidence: p.evidence,
          })),
          diff: diffs.all,
          applicableDiff: diffs.applicable,
          applied,
        },
        null,
        2
      )}\n`
    );
  } else {
    process.stdout.write(`${formatReport(config, runs, report, diffs, meta)}\n`);
  }
  return EXIT_OK;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof AdvisorError) {
    process.stderr.write(`verify-advisor: ${error.message}\n`);
    process.exitCode = error.code;
  } else {
    process.stderr.write(`verify-advisor: internal error: ${error.stack || error.message}\n`);
    process.exitCode = EXIT_ERROR;
  }
}
