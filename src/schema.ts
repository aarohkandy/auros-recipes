/**
 * recipe.schema.json, and turning its errors back into the sentences a person wrote.
 *
 * The schema is not a type declaration with prose bolted on. Nearly every rule in it carries a
 * `title` and a `description` written for a school IT coordinator, and the keyword that actually
 * fails is usually a level or two below the sentence that explains it. A raw
 *
 *     must NOT be valid
 *
 * teaches nobody anything. This module walks from the failing keyword back up to the nearest
 * sentence an author wrote and prints that instead.
 *
 * `schema/validate.py` does the same thing in Python. The two exist because the promise in
 * schema/README.md section 1 -- "if we disappear you validate and rebuild your own operating
 * system with tools you already have" -- is only true if the rules live in a data file that more
 * than one program can read. test/parity.test.ts asserts they agree.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// ajv/dist/2020 rather than plain ajv: recipe.schema.json declares draft 2020-12, and validating a
// 2020-12 document against a draft-07 validator is the kind of mismatch that passes almost all the
// time and then quietly accepts something it should have refused.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import { refuse, nearest, sentenceList, type Refusal } from './refusal.ts';

interface Authored { title: string; description: string }

export interface CompiledSchema {
  readonly validate: ValidateFunction;
  readonly schema: Record<string, unknown>;
  /** Every property name the schema declares anywhere. Used to decide what counts as an unknown key. */
  readonly knownKeys: ReadonlySet<string>;
}

export function compileSchema(repoRoot: string): CompiledSchema {
  const schema = JSON.parse(
    readFileSync(join(repoRoot, 'schema', 'recipe.schema.json'), 'utf8'),
  ) as Record<string, unknown>;
  // `strictSchema: true` is the one option in here that is a SECURITY control rather than ergonomics.
  //
  // Ajv's default under `strict: false` is to IGNORE a keyword it does not recognise. A rule in
  // recipe.schema.json is therefore one typo away from not existing: rename `pattern` to `patern` on
  // `properties.name` and this validator compiles the schema without a word and returns ZERO errors
  // for `name: "../../../etc"` — the rule that keeps a customer name out of a filesystem path is
  // simply gone, and every test that does not happen to exercise that exact string still passes.
  //
  // The Worker's own evaluator (auros-web/worker/lib/jsonschema.js) already fails closed on an
  // unknown keyword and says why: "a validator that silently skips keywords it has not heard of gets
  // weaker every time somebody edits the schema, and gets weaker invisibly." That was true of THIS
  // validator, which is the one that gates the merge. `strictSchema` makes an unknown keyword a
  // compile error here too, so the two sides fail the same way.
  //
  // Not `strict: true`: that also turns on `strictRequired`, which this schema legitimately trips
  // (`$defs` branches that require a property declared in a sibling `if`). Narrow beats broad — the
  // broad version refuses our own schema, which is how a strict flag gets turned back off.
  const ajv = new Ajv2020({ allErrors: true, strict: false, strictSchema: true, allowUnionTypes: true });
  // The only format the schema uses. Declared here rather than pulling in ajv-formats: one format,
  // already backed by a pattern in the schema, is not worth a dependency in a toolchain whose whole
  // claim is that you can run it yourself.
  ajv.addFormat('date', /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  return { validate: ajv.compile(schema), schema, knownKeys: collectKnownKeys(schema) };
}

function collectKnownKeys(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) collectKnownKeys(child, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const obj = node as Record<string, unknown>;
  const props = obj['properties'];
  if (typeof props === 'object' && props !== null) for (const key of Object.keys(props)) out.add(key);
  const required = obj['required'];
  if (Array.isArray(required)) for (const key of required) if (typeof key === 'string') out.add(key);
  for (const value of Object.values(obj)) collectKnownKeys(value, out);
  return out;
}

/**
 * The keys the schema refuses BY NAME, with its own authored sentence for each.
 *
 * validate.ts recognises whole families of near-miss keys (`baseImage`, `kernelArgs`). For a key
 * that is already on this list the schema's sentence is the better one and the family detector
 * stands aside, so a reader gets one explanation rather than two of the same thing.
 */
export function reservedByName(schema: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const defs = schema['$defs'];
  if (typeof defs !== 'object' || defs === null) return out;
  const refusals = (defs as Record<string, unknown>)['refusals'];
  if (typeof refusals !== 'object' || refusals === null) return out;
  for (const group of Object.values(refusals as Record<string, unknown>)) {
    if (typeof group !== 'object' || group === null) continue;
    const not = (group as Record<string, unknown>)['not'];
    if (typeof not !== 'object' || not === null) continue;
    const branches = (not as Record<string, unknown>)['anyOf'];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (typeof branch !== 'object' || branch === null) continue;
      const required = (branch as Record<string, unknown>)['required'];
      if (Array.isArray(required) && typeof required[0] === 'string') out.add(required[0]);
    }
  }
  return out;
}

/** Resolve a `#/a/b/c` schema pointer to the chain of nodes along it, root first. */
function chain(root: Record<string, unknown>, schemaPath: string): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [root];
  let node: unknown = root;
  for (const rawPart of schemaPath.replace(/^#\/?/, '').split('/')) {
    if (rawPart === '') continue;
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) node = node[Number(part)];
    else if (typeof node === 'object' && node !== null) node = (node as Record<string, unknown>)[part];
    else return nodes;
    if (typeof node === 'object' && node !== null && !Array.isArray(node)) {
      nodes.push(node as Record<string, unknown>);
    }
  }
  return nodes;
}

/** The deepest ancestor of the failing keyword that carries a sentence a human wrote. */
function authoredFor(root: Record<string, unknown>, schemaPath: string): Authored | null {
  const nodes = chain(root, schemaPath);
  for (let i = nodes.length - 1; i >= 1; i--) {
    const node = nodes[i]!;
    const title = node['title'];
    const description = node['description'];
    if (typeof title === 'string' && typeof description === 'string') return { title, description };
  }
  return null;
}

function descriptionFor(root: Record<string, unknown>, schemaPath: string): string | null {
  const nodes = chain(root, schemaPath);
  for (let i = nodes.length - 1; i >= 1; i--) {
    const description = nodes[i]!['description'];
    if (typeof description === 'string') return description;
  }
  return null;
}

/** The key names a by-name refusal was written about, so we can suppress the duplicate "unknown key". */
function refusedKeys(root: Record<string, unknown>, schemaPath: string): string[] {
  const nodes = chain(root, schemaPath);
  const node = nodes[nodes.length - 1];
  if (!node) return [];
  const branches = node['anyOf'];
  if (!Array.isArray(branches)) return [];
  const keys: string[] = [];
  for (const branch of branches) {
    if (typeof branch === 'object' && branch !== null) {
      const required = (branch as Record<string, unknown>)['required'];
      if (Array.isArray(required) && typeof required[0] === 'string') keys.push(required[0]);
    }
  }
  return keys;
}

/** `/prune/also_remove/2` becomes `prune.also_remove[2]` */
export function instancePathToPointer(instancePath: string): string {
  if (instancePath === '') return '(top level)';
  let out = '';
  for (const rawPart of instancePath.split('/')) {
    if (rawPart === '') continue;
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (/^[0-9]+$/.test(part)) out += `[${part}]`;
    else out += out === '' ? part : `.${part}`;
  }
  return out === '' ? '(top level)' : out;
}

function valueAt(doc: unknown, instancePath: string): unknown {
  let node: unknown = doc;
  for (const rawPart of instancePath.split('/')) {
    if (rawPart === '') continue;
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) node = node[Number(part)];
    else if (typeof node === 'object' && node !== null) node = (node as Record<string, unknown>)[part];
    else return undefined;
  }
  return node;
}

/**
 * A value, quoted, for a message a person reads.
 *
 * Truncated, because a recipe is a pull request from a stranger and one of the things a stranger can
 * send is a ten-megabyte string. Echoing it whole would turn a refusal into a denial of service
 * against whoever is reading the CI log.
 */
const SHOW_LIMIT = 60;
function show(value: unknown): string {
  if (typeof value !== 'string') return `'${String(value)}'`;
  // Control characters are what the display_name pattern exists to refuse, so they must not be
  // echoed raw into a terminal that would act on them.
  const safe = value.replace(/[ --​-‏‪-‮⁠-⁯]/g, '�');
  return safe.length > SHOW_LIMIT ? `'${safe.slice(0, SHOW_LIMIT)}...' (${value.length} characters)` : `'${safe}'`;
}

const UNKNOWN_KEY_WHY =
  'Every effect a recipe can have is a named field with a description. An unknown key is refused ' +
  'rather than ignored, because a subtraction instruction that is quietly dropped means the prune ' +
  'list silently shrinks while the build still passes, which is the worst possible failure in a ' +
  'product whose whole thesis is subtraction. See schema/README.md section 3.';

export function schemaRefusals(compiled: CompiledSchema, doc: unknown): Refusal[] {
  if (compiled.validate(doc)) return [];
  const errors = (compiled.validate.errors ?? []) as ErrorObject[];
  const root = compiled.schema;
  const topLevel = (typeof doc === 'object' && doc !== null) ? (doc as Record<string, unknown>) : {};

  // A reserved key produces two errors: "unknown key" and the by-name refusal that explains why we
  // reserved it. Only the second teaches anything, so the first is dropped for that key.
  const explainedByName = new Set<string>();
  for (const error of errors) {
    if (error.keyword !== 'not') continue;
    for (const key of refusedKeys(root, error.schemaPath)) {
      if (key in topLevel) explainedByName.add(key);
    }
  }

  const out: Refusal[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    const where = instancePathToPointer(error.instancePath);
    const authored = authoredFor(root, error.schemaPath);

    if (error.keyword === 'additionalProperties') {
      const key = String((error.params as { additionalProperty?: string }).additionalProperty ?? '');
      if (explainedByName.has(key)) continue;
      const parent = chain(root, error.schemaPath.replace(/\/additionalProperties$/, '')).pop();
      const props = parent && typeof parent['properties'] === 'object' && parent['properties'] !== null
        ? Object.keys(parent['properties'] as Record<string, unknown>)
        : [];
      const near = nearest(key, props, 2);
      const hint = near.length ? ` Did you mean ${sentenceList(near)}?` : '';
      push(out, seen, refuse(where, `'${key}' is not a field this file has.${hint}`, UNKNOWN_KEY_WHY));
      continue;
    }

    if (error.keyword === 'not') {
      const keys = refusedKeys(root, error.schemaPath);
      const present = keys.filter((k) => k in topLevel);
      if (keys.length > 0 && present.length === 0) continue; // fired for a document that does not have them
      const subject = present.length ? sentenceList(present.map((k) => `'${k}'`)) : 'this value';
      if (authored) push(out, seen, refuse(where, `${authored.title} (${subject}).`, authored.description));
      else push(out, seen, refuse(where, `${subject} is refused here.`));
      continue;
    }

    if (error.keyword === 'required') {
      // A missing required field is the one error where the default message is worst: "must have
      // required property 'prune'" tells a reader nothing about why the file needs a prune block.
      // The field's own description does, and it is right there in the schema.
      const missing = String((error.params as { missingProperty?: string }).missingProperty ?? '');
      const parent = chain(root, error.schemaPath.replace(/\/required$/, '')).pop();
      const props = parent && typeof parent['properties'] === 'object' && parent['properties'] !== null
        ? (parent['properties'] as Record<string, unknown>)
        : {};
      const own = props[missing];
      const description = typeof own === 'object' && own !== null && typeof (own as Record<string, unknown>)['description'] === 'string'
        ? String((own as Record<string, unknown>)['description'])
        : '';
      const at = where === '(top level)' ? missing : `${where}.${missing}`;
      push(out, seen, refuse(at, `This file has no '${missing}', and it is required.`, description));
      continue;
    }

    if (error.keyword === 'enum') {
      const allowed = ((error.params as { allowedValues?: unknown[] }).allowedValues ?? []).map(String);
      const value = valueAt(doc, error.instancePath);
      const near = nearest(String(value), allowed, 3);
      const tail = near.length ? `Nearest: ${sentenceList(near)}.` : `Choose from: ${allowed.join(', ')}.`;
      const why = authored ? authored.description : (descriptionFor(root, error.schemaPath) ?? '');
      push(out, seen, refuse(where, `'${String(value)}' is not one of the published choices. ${tail}`, why));
      continue;
    }

    if (authored) {
      push(out, seen, refuse(where, authored.title, authored.description));
      continue;
    }

    if (error.keyword === 'pattern') {
      // ajv's message for a pattern is the pattern: `must match pattern
      // "^[A-Za-z][A-Za-z+#]*(?: [A-Za-z][A-Za-z+#]*)*$"`. That is the single most common refusal
      // this toolchain produces -- every version pin, every homoglyph, every path traversal in a
      // name arrives here -- and it is addressed to an IT coordinator at a school, who is owed a
      // sentence rather than a regular expression. The SHAPE is the rule, and every one of these
      // fields already explains its shape in words, in `why`, which is where a reader should look.
      const value = show(valueAt(doc, error.instancePath));
      push(
        out,
        seen,
        refuse(
          where,
          `${value} is not a value this field can hold. The rule here is the shape of what you can ` +
            'write, not a list of things we decided to block, so this is not a request that was ' +
            'refused -- it is a sentence this file cannot contain.',
          descriptionFor(root, error.schemaPath) ?? '',
        ),
      );
      continue;
    }

    const description = descriptionFor(root, error.schemaPath);
    const what = error.message ?? 'refused';
    push(out, seen, refuse(where, what.charAt(0).toUpperCase() + what.slice(1) + '.', description ?? ''));
  }
  return out;
}

function push(out: Refusal[], seen: Set<string>, refusal: Refusal): void {
  const key = `${refusal.where}::${refusal.what}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(refusal);
}
