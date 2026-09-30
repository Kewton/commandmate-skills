// Validates a JSON document against one of the cmate-worktree-cleanup schemas.
//
//   node check-schema.mjs <schema.json> <document.json>
//
// A deliberately small JSON Schema subset — exactly the keywords the two
// schemas use (type, const, enum, required, properties, additionalProperties,
// items, $ref to #/$defs, anyOf, pattern, minimum, maximum, minLength,
// maxLength, minItems, maxItems) — so the suite needs no package from a
// registry. An unknown keyword is an error, not a silent pass.
import fs from 'node:fs';

const KNOWN = new Set(['$schema', '$id', 'title', 'description', '$defs', 'type', 'const', 'enum', 'required',
  'properties', 'additionalProperties', 'items', '$ref', 'anyOf', 'pattern', 'minimum', 'maximum',
  'minLength', 'maxLength', 'minItems', 'maxItems']);

const [schemaPath, docPath] = process.argv.slice(2);
const root = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
const errors = [];

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

function check(schema, v, at) {
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) errors.push(`${at}: unsupported keyword ${k}`);
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '');
    check(root.$defs[name], v, at);
  }
  if (schema.anyOf) {
    const saved = errors.length;
    const ok = schema.anyOf.some((s) => {
      const before = errors.length;
      check(s, v, at);
      const pass = errors.length === before;
      errors.length = before;
      return pass;
    });
    errors.length = saved;
    if (!ok) errors.push(`${at}: matches no anyOf branch`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(v, t))) { errors.push(`${at}: type ${typeOf(v)} not in ${types}`); return; }
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(v)) errors.push(`${at}: not const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => e === v)) errors.push(`${at}: ${JSON.stringify(v)} not in enum`);
  if (typeof v === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(v)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && [...v].length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && [...v].length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) v.forEach((item, i) => check(schema.items, item, `${at}[${i}]`));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of schema.required || []) if (!(r in v)) errors.push(`${at}: missing ${r}`);
    const props = schema.properties || {};
    for (const [k, val] of Object.entries(v)) {
      if (props[k]) check(props[k], val, `${at}.${k}`);
      else if (schema.additionalProperties === false) errors.push(`${at}: unknown field ${k}`);
    }
  }
}

check(root, doc, '$');
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exit(1);
}
