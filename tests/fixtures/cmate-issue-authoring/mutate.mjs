// Apply one documented mutation to a split-plan fixture and print the result.
//
//   node mutate.mjs <plan.json> delete <json-pointer>
//   node mutate.mjs <plan.json> set    <json-pointer> <json-value>
//
// The suite injects mutations instead of committing thirty near-identical bad
// fixtures: what a case asserts is then the *edit* ("delete /issues/0/objective"),
// which is reviewable in one line and cannot drift away from the good fixture it
// was derived from.

import { readFileSync } from 'node:fs';

const [file, op, pointer, rawValue] = process.argv.slice(2);
if (!file || !op || !pointer) {
  process.stderr.write('usage: node mutate.mjs <plan.json> <delete|set> <pointer> [json-value]\n');
  process.exit(2);
}

const document = JSON.parse(readFileSync(file, 'utf8'));
const segments = pointer.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
if (segments.length === 0) {
  process.stderr.write('error: the root cannot be mutated\n');
  process.exit(2);
}

let node = document;
for (const segment of segments.slice(0, -1)) {
  node = Array.isArray(node) ? node[Number(segment)] : node[segment];
  if (node === undefined) {
    process.stderr.write(`error: ${pointer} does not resolve\n`);
    process.exit(2);
  }
}

const last = segments[segments.length - 1];
if (op === 'delete') {
  if (Array.isArray(node)) node.splice(Number(last), 1);
  else delete node[last];
} else if (op === 'set') {
  if (rawValue === undefined) {
    process.stderr.write('error: set needs a JSON value\n');
    process.exit(2);
  }
  const value = JSON.parse(rawValue);
  if (Array.isArray(node)) node[Number(last)] = value;
  else node[last] = value;
} else {
  process.stderr.write(`error: unknown op ${op}\n`);
  process.exit(2);
}

process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
