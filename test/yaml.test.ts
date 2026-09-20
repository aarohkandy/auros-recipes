/**
 * The parser, which is the part of this toolchain an attacker reaches FIRST.
 *
 * Everything in refusals.test.ts starts from a document that has already been parsed. That is one
 * layer too late for a whole class of attack: a recipe arrives as a pull request from a stranger, and
 * before any rule in recipe.schema.json gets a vote, `yaml` has to turn their bytes into a document.
 * A YAML file can expand exponentially, can define one key twice, can say one thing and mean another
 * through an anchor, and can smuggle a forbidden key in under a merge key that no reviewer reads as a
 * key at all.
 *
 * Every test here therefore goes through `loadRecipe` on a real file rather than through a literal,
 * because the literal would be the thing being tested rather than the thing being defended against.
 *
 * TWO OUTCOMES ARE ACCEPTABLE and they are not the same outcome, which is why the assertions say
 * which one they want:
 *
 *   - the parser REFUSES the bytes (loadRecipe throws, the CLI exits 2, "this tool could not run");
 *   - the parser produces a document and the VALIDATOR refuses it (exit 1, a verdict).
 *
 * What is never acceptable is a third thing: parsing to a document that quietly differs from what a
 * reviewer read in the diff.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecipe } from '../src/recipe.ts';
import { validateDocument } from '../src/validate.ts';
import { SCHOOL_PATH, toolchain, said } from './helpers.ts';

/** Write YAML to a real file and load it exactly as the CLI would. */
function load(text: string): { ok: true; doc: unknown } | { ok: false; message: string } {
  const dir = mkdtempSync(join(tmpdir(), 'auros-yaml-'));
  try {
    const path = join(dir, 'recipe.yaml');
    writeFileSync(path, text);
    try {
      return { ok: true, doc: loadRecipe(path).doc };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Parsed and then refused by the validator, with the sentence it gave. */
function refusedAfterParsing(doc: unknown): string {
  const result = validateDocument(toolchain(), doc, SCHOOL_PATH);
  assert.equal(result.ok, false, 'this document parsed AND validated, which is the outcome this file exists to prevent');
  return said(result);
}

// -------------------------------------------------------------------------------------------------
// Expansion: a small file that becomes a large document
// -------------------------------------------------------------------------------------------------

test('a billion-laughs expansion is refused by the parser rather than expanded', () => {
  // Nine aliases, nine deep: 9^9 is 387 million nodes from about 600 bytes. This is the attack that
  // takes a CI runner down without ever reaching a rule, so the defence has to be before the rules.
  let text = 'a: &a ["x","x","x","x","x","x","x","x","x"]\n';
  const letters = ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  let previous = 'a';
  for (const letter of letters) {
    text += `${letter}: &${letter} [${Array(9).fill(`*${previous}`).join(',')}]\n`;
    previous = letter;
  }

  const started = Date.now();
  const outcome = load(text);
  const elapsed = Date.now() - started;

  assert.equal(outcome.ok, false, 'a 600-byte file expanded into a document instead of being refused');
  assert.match(outcome.message, /alias|resource exhaustion/i);
  // The number matters as much as the refusal: refusing after ninety seconds of expansion is still a
  // runner that is unavailable for ninety seconds.
  assert.ok(elapsed < 2000, `the parser took ${elapsed}ms to refuse it, which is long enough to be the attack`);
});

test('a merely large but honest file is NOT refused, so the guard above is not just "large is bad"', () => {
  // The negative control. Without it, "billion laughs is refused" would also pass on a parser that
  // refused every file over a kilobyte, which would refuse real recipes too.
  const outcome = load(`schema: 1\nname: big\nfiller: [${Array(5000).fill('"x"').join(',')}]\n`);
  assert.equal(outcome.ok, true, 'an ordinary five-thousand-element list was refused as an attack');
  assert.equal(((outcome as { doc: unknown }).doc as Record<string, unknown[]>)['filler']!.length, 5000);
});

test('one anchor used many times is not mistaken for an expansion attack, up to a measured limit', () => {
  // The other half of the same control. Anchors are a legitimate way to avoid repeating a phone
  // number; what makes billion laughs an attack is aliases OF aliases, not aliases.
  //
  // The limit is real and it is worth writing down rather than discovering: this parser accepts 99
  // aliases in a document and refuses the hundredth as a resource-exhaustion attack. That is far
  // above anything a recipe needs -- the largest field in the schema holds 60 applications and the
  // whole document is about forty lines -- so the ceiling is recorded here rather than raised. If a
  // legitimate recipe ever approaches it, this test is where that becomes visible.
  const aliases = (n: number) =>
    load(`schema: 1\nphone: &p "+91 20 2555 0143"\n${Array(n).fill(0).map((_, i) => `k${i}: *p`).join('\n')}\n`);

  const fine = aliases(99);
  assert.equal(fine.ok, true, 'ninety-nine uses of one anchor were refused as an attack');
  assert.equal(((fine as { doc: unknown }).doc as Record<string, string>)['k98'], '+91 20 2555 0143');

  const refused = aliases(100);
  assert.equal(refused.ok, false, 'the alias ceiling has moved; the number in this test is now wrong');
  assert.match(refused.message, /alias|resource exhaustion/i);
});

// -------------------------------------------------------------------------------------------------
// Duplicate keys: the file says one thing and means the other
// -------------------------------------------------------------------------------------------------

test('a key defined twice is refused rather than silently resolved to one of them', () => {
  // Left to last-wins, a reviewer reads `must_remove_at_least: 240` at the top of a diff and the
  // build uses the 1 further down. There is no reading of a duplicate key that is safe here.
  const outcome = load('schema: 1\nname: a\nname: b\n');
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /unique|duplicate/i);
});

test('a duplicate key nested inside the prune block is refused too', () => {
  const outcome = load(
    'schema: 1\nprune:\n  must_remove_at_least: 240\n  also_remove: [games]\n  must_remove_at_least: 1\n',
  );
  assert.equal(outcome.ok, false, 'the removal floor was silently overwritten by a second copy of the key');
  assert.match(outcome.message, /unique|duplicate/i);
});

test('a duplicate key inside a list item is refused', () => {
  const outcome = load('schema: 1\nwindows_apps:\n  tested:\n    - app: X\n      result: works\n      result: fails\n');
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /unique|duplicate/i);
});

test('the same VALUE appearing twice is fine, so the guard above is about keys and not about repetition', () => {
  // Negative control again. `also_keep: [printing, printing]` is a duplicate the SCHEMA refuses with
  // a sentence; it must not be mistaken for a parse error, because the two exit codes mean different
  // things to CI.
  const outcome = load('schema: 1\nprune:\n  also_keep: [printing, printing]\n');
  assert.equal(outcome.ok, true, 'a duplicate list VALUE was treated as a malformed file');
  assert.match(refusedAfterParsing((outcome as { doc: unknown }).doc), /duplicate items/i);
});

// -------------------------------------------------------------------------------------------------
// Anchors and aliases: a forbidden key arriving by reference
// -------------------------------------------------------------------------------------------------

test('an anchor expanding into a forbidden key is refused after it expands', () => {
  // The document a reviewer reads has no `from:` line containing a registry. The document the
  // compiler would see does. The rules run on the expanded document, which is the only version that
  // matters, and this asserts that rather than assuming it.
  const outcome = load('schema: 1\nwhatever: &elsewhere ghcr.io/somebody/else:latest\nfrom: *elsewhere\n');
  assert.equal(outcome.ok, true, 'the parser refused this, which is fine but is not what this test is about');
  const text = refusedAfterParsing((outcome as { doc: unknown }).doc);
  assert.match(text, /cannot name what it is built on|no field for the base image/i);
});

test('an alias inside a list is refused the same way as a literal', () => {
  const outcome = load('schema: 1\npin: &v firefox-140.0\napps: [*v]\n');
  assert.equal(outcome.ok, true);
  const text = refusedAfterParsing((outcome as { doc: unknown }).doc);
  assert.match(text, /held at a version|No digits anywhere|not a field this file has/i);
});

test('a merge key does not quietly merge a forbidden block into the document', () => {
  // `<<` is a YAML extension, not core YAML, and this parser does not apply it by default. Either
  // behaviour would be survivable -- merged, the family detector sees `from`; unmerged, `<<` is an
  // unknown key -- and what must not happen is the block taking effect with nothing reported. This
  // asserts the outcome we actually have, so that a parser upgrade that starts merging shows up here
  // rather than in a build.
  const outcome = load('schema: 1\ndefaults: &d\n  from: ghcr.io/somebody/else\n<<: *d\n');
  assert.equal(outcome.ok, true);
  const doc = (outcome as { doc: unknown }).doc as Record<string, unknown>;
  assert.ok(!('from' in doc), 'the merge key was applied, so a forbidden key arrived by a route no reviewer reads as a key');
  assert.match(refusedAfterParsing(doc), /not a field this file has|cannot name what it is built on/i);
});

test('a merge key nested inside a known block is still refused', () => {
  const outcome = load('schema: 1\ndefaults: &d\n  can_reach_a_terminal: true\ndesktop:\n  <<: *d\n');
  assert.equal(outcome.ok, true);
  assert.match(refusedAfterParsing((outcome as { doc: unknown }).doc), /not a field this file has/i);
});

test('a recursive anchor does not hang the parser', () => {
  const outcome = load('schema: 1\na: &a\n  b: *a\n');
  // Either refused or resolved; what must not happen is this test timing out.
  if (outcome.ok) {
    assert.ok(typeof outcome.doc === 'object');
  } else {
    assert.ok(outcome.message.length > 0);
  }
});

// -------------------------------------------------------------------------------------------------
// Bytes that are not a document
// -------------------------------------------------------------------------------------------------

test('a file that is not YAML at all fails as a tool error with the file named', () => {
  const outcome = load('apps: [unclosed\n  - broken: : :\n');
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /is not valid YAML/);
});

test('an empty file is not mistaken for an empty recipe', () => {
  const outcome = load('');
  assert.equal(outcome.ok, true, 'an empty file threw where it should have produced an empty document');
  assert.match(refusedAfterParsing((outcome as { doc: unknown }).doc), /not a list or a bare value|and it is required/i);
});

test('a file of only comments is refused with a sentence, not accepted as a recipe', () => {
  const outcome = load('# just a comment\n# and another\n');
  assert.equal(outcome.ok, true);
  assert.match(refusedAfterParsing((outcome as { doc: unknown }).doc), /not a list or a bare value|and it is required/i);
});

test('two YAML documents in one file do not let the second one hide', () => {
  // `---` starts a second document. A parser that returned only the first would let somebody put the
  // recipe a reviewer reads first and the one that builds second, or the reverse.
  const outcome = load('schema: 1\nname: example-school\n---\nfrom: ghcr.io/somebody/else\n');
  if (outcome.ok) {
    // Single-document parse: the second document was dropped, which means the FIRST is what builds,
    // and the first is the one in the diff. Assert that, so a parser change is visible here.
    const doc = outcome.doc as Record<string, unknown>;
    assert.ok(!('from' in doc), 'the second document leaked its keys into the first');
    assert.match(refusedAfterParsing(doc), /and it is required/i);
  } else {
    assert.match(outcome.message, /is not valid YAML/);
  }
});

test('a byte-order mark at the front does not become part of the first key', () => {
  const outcome = load('﻿schema: 1\nname: example-school\n');
  assert.equal(outcome.ok, true);
  const doc = (outcome as { doc: unknown }).doc as Record<string, unknown>;
  assert.ok('schema' in doc, `the BOM was absorbed into the key name: ${JSON.stringify(Object.keys(doc))}`);
});

test('CRLF line endings produce the same document as LF, so a Windows editor is not a build difference', () => {
  const lf = load('schema: 1\nname: example-school\ntimezone: Asia/Kolkata\n');
  const crlf = load('schema: 1\r\nname: example-school\r\ntimezone: Asia/Kolkata\r\n');
  assert.equal(lf.ok, true);
  assert.equal(crlf.ok, true);
  assert.deepEqual((crlf as { doc: unknown }).doc, (lf as { doc: unknown }).doc);
});

test('a tab used for indentation is refused rather than read as something else', () => {
  const outcome = load('schema: 1\nprune:\n\tmust_remove_at_least: 240\n');
  assert.equal(outcome.ok, false, 'a tab-indented block parsed, and tabs and spaces do not nest the same way');
  assert.match(outcome.message, /is not valid YAML|tab/i);
});

test('a YAML tag cannot ask the parser to construct something that is not data', () => {
  // The historic remote-code-execution shape in YAML libraries. This parser has no constructor
  // registry, so the assertion is that the tag produces data or an error -- never an object with
  // behaviour.
  for (const text of [
    'schema: 1\nname: !!python/object/apply:os.system ["id"]\n',
    'schema: 1\nname: !!js/function "function(){return 1}"\n',
    'schema: 1\nname: !ruby/object:Gem::Requirement {}\n',
  ]) {
    const outcome = load(text);
    if (outcome.ok) {
      const name = (outcome.doc as Record<string, unknown>)['name'];
      assert.notEqual(typeof name, 'function', 'a YAML tag constructed a function');
      assert.match(refusedAfterParsing(outcome.doc), /must be string|is not a value this field can hold|and it is required/i);
    }
  }
});

test('YAML booleans that are not booleans do not silently become one', () => {
  // The Norway problem: `no` parses as false in YAML 1.1 and as the string "no" in 1.2. A field that
  // means "keep only these apps" must not flip on a spelling.
  const outcome = load('schema: 1\nprune:\n  keep_only_the_apps_above: no\n  must_remove_at_least: 240\n');
  assert.equal(outcome.ok, true);
  const value = ((outcome as { doc: unknown }).doc as Record<string, Record<string, unknown>>)['prune']!['keep_only_the_apps_above'];
  // Whatever this parser decides, it must be recorded, because the answer changes what a fleet keeps.
  assert.ok(value === false || value === 'no', `unexpected reading of YAML "no": ${JSON.stringify(value)}`);
});
