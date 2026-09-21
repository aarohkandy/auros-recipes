/**
 * A RULE IN THE SCHEMA MUST NOT BE ONE TYPO AWAY FROM NOT EXISTING.
 *
 * `recipe.schema.json` is the rulebook for four programs: this toolchain (ajv), `schema/validate.py`
 * (Python `jsonschema`), the Cloudflare Worker (`auros-web/worker/lib/jsonschema.js`) and the
 * configurator in the browser (`auros-web/src/lib/json-schema.ts`). Two of those four refuse a
 * keyword they do not recognise. Two of them silently ignore it — and, until this file existed, the
 * two that ignored it were the two that gate a merge.
 *
 * The failure is invisible by construction. `properties.name.pattern` is the rule that keeps a
 * customer name out of a filesystem path, a git branch name and an image tag. Rename it to `patern`
 * and ajv, under its default `strict: false`, compiles the schema without a word and reports ZERO
 * errors for `name: "../../../etc"`. Every other test in this suite still passes, because none of
 * them happens to submit that string. A rule that can disappear without a single red test is not a
 * rule.
 *
 * ── WHY THIS FILE GOES THROUGH `compileSchema()` AND NEVER BUILDS ITS OWN `Ajv2020` ──
 *
 * The first version of this test constructed an `Ajv2020` with the options copied out of
 * `src/schema.ts`. It passed. It also passed with `strictSchema: true` deleted from `src/schema.ts`,
 * because it was asserting a property of its own literal rather than of the product — the same
 * defect as a SELinux check that was permanently green (DECISIONS.md D34/D37). So every assertion
 * below drives `compileSchema()` itself, pointed at a temporary repository root holding a
 * deliberately broken copy of the real schema. Deleting `strictSchema: true` from `src/schema.ts`
 * turns this file red, which was checked by deleting it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileSchema } from '../src/schema.ts';
import { ROOT } from './helpers.ts';

const SCHEMA_PATH = join(ROOT, 'schema', 'recipe.schema.json');

function realSchema(): Record<string, any> {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, any>;
}

/**
 * Put a schema document where `compileSchema()` looks for one, and return that root. This is what
 * makes the test exercise the production options instead of a copy of them.
 */
function rootHolding(schema: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'auros-schema-'));
  mkdirSync(join(root, 'schema'));
  writeFileSync(join(root, 'schema', 'recipe.schema.json'), JSON.stringify(schema));
  return root;
}

/** The exact shape of the bug: the rule is still there, spelled one letter wrong. */
function withTypedKeyword(place: (s: Record<string, any>) => void): string {
  const broken = realSchema();
  broken.$id = `urn:auros:test:${Math.random().toString(36).slice(2)}`;
  place(broken);
  return rootHolding(broken);
}

test('the real schema still compiles — a strict flag that refuses our own rulebook gets turned back off', () => {
  const t = compileSchema(ROOT);
  assert.equal(typeof t.validate, 'function');
  assert.ok(t.knownKeys.has('name'));
});

test('a keyword this validator does not implement is REFUSED, not ignored', () => {
  const root = withTypedKeyword((s) => {
    s.properties.name.patern = s.properties.name.pattern;
    delete s.properties.name.pattern;
  });
  assert.throws(
    () => compileSchema(root),
    /unknown keyword: "patern"/,
    'compileSchema accepted a schema whose `name` pattern had silently stopped applying',
  );
});

test('every other unknown keyword is refused the same way, wherever it sits', () => {
  const places: Array<[string, (s: Record<string, any>) => void]> = [
    ['exclusiveEnum on a policy', (s) => { s.properties.policy.exclusiveEnum = ['open']; }],
    ['maxLenght on $defs/line', (s) => { s.$defs.line.maxLenght = 200; }],
    ['mininum on a machine count', (s) => { s.properties.hardware.properties.machines.mininum = 1; }],
  ];
  for (const [label, place] of places) {
    assert.throws(
      () => compileSchema(withTypedKeyword(place)),
      /strict mode: unknown keyword/,
      `${label} was ignored rather than refused`,
    );
  }
});

test('and this is what being ignored costs: the name stops being a name', async () => {
  // Evidence for the paragraph at the top of this file rather than a check on the product. The
  // permissive validator is constructed here on purpose — it is the thing being shown, not the
  // thing being tested — so that nobody reading the fix later has to take the damage on trust.
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const broken = realSchema();
  broken.$id = 'urn:auros:test:permissive';
  broken.properties.name.patern = broken.properties.name.pattern;
  delete broken.properties.name.pattern;

  const permissive = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  permissive.addFormat('date', /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  const validate = permissive.compile(broken);
  validate({ name: '../../../etc' });
  const onTheName = (validate.errors ?? []).filter((e) => e.instancePath === '/name');
  assert.equal(
    onTheName.length,
    0,
    'the permissive validator caught it after all — if so, rewrite the comment above rather than the test',
  );
});
