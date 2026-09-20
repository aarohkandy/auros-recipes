/**
 * Determinism, as a property rather than as an example.
 *
 * Spec section 6B's exit condition is verified by building the same recipe twice in one run and
 * comparing content digests. That check is only meaningful if the compiler is a function of the
 * recipe's MEANING rather than of the order somebody happened to type it in: a recipe is a list of
 * lists, nothing in the file format gives those lists a meaning that depends on order, and a
 * customer who alphabetises their own applications must not get a different image for it.
 *
 * compile.test.ts already reverses three lists once. This file shuffles EVERY list in every example
 * recipe, a hundred times each, with a seeded generator so a failure is reproducible from the seed
 * printed in the message. That difference is the point: reversing one list found nothing for weeks,
 * and shuffling all of them found two real bugs the first time it ran --
 *
 *   - windows_apps.tested flowed into branding.json in the order it was written, because
 *     canonicalJson sorts object keys and does not touch arrays;
 *   - a kiosk's one window was chosen with `.find()` over the apps list, so alphabetising the apps
 *     list changed which browser forty machines in six buildings actually opened.
 *
 * Both are fixed in src/. This file is what keeps them fixed, and what would find the third one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { compile } from '../src/compile.ts';
import { loadConfig } from '../src/config.ts';
import { validateDocument } from '../src/validate.ts';
import { ROOT, school, kiosk, workstation, toolchain, type Doc } from './helpers.ts';

const config = loadConfig(ROOT);
const DIGEST = `sha256:${'a1b2c3d4'.repeat(8)}`;
const SHUFFLES = 100;

/**
 * A seeded generator, so that a failure reports a seed somebody can put back in and reproduce.
 * Math.random() here would mean a red build nobody can turn back into a test case.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

function shuffled<T>(items: ReadonlyArray<T>, next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Every array anywhere in the document, shuffled in place. Returns how many it found. */
function shuffleEveryList(node: unknown, next: () => number): number {
  let count = 0;
  if (Array.isArray(node)) {
    const order = shuffled(node, next);
    for (let i = 0; i < node.length; i++) node[i] = order[i];
    count += 1;
    for (const child of node) count += shuffleEveryList(child, next);
    return count;
  }
  if (typeof node === 'object' && node !== null) {
    for (const value of Object.values(node as Record<string, unknown>)) count += shuffleEveryList(value, next);
  }
  return count;
}

function build(doc: Doc, dir: string): string {
  const path = join(ROOT, 'customers', dir, 'recipe.yaml');
  const result = validateDocument(toolchain(), doc, path);
  assert.ok(result.ok, `${dir} did not validate: ${result.refusals.map((r) => `${r.where}: ${r.what}`).join('; ')}`);
  return compile({
    recipe: result.recipe!,
    recipePath: path,
    plan: result.plan!,
    fonts: result.fonts ?? [],
    config,
    catalogue: toolchain().catalogue,
    baseDigest: DIGEST,
    notes: result.notes,
  });
}

const FLEETS = [
  { dir: 'example-school', read: school },
  { dir: 'example-kiosk', read: kiosk },
  { dir: 'example-workstation', read: workstation },
] as const;

// -------------------------------------------------------------------------------------------------
// The property
// -------------------------------------------------------------------------------------------------

for (const fleet of FLEETS) {
  test(`${fleet.dir}: ${SHUFFLES} shuffles of every list produce one Containerfile`, () => {
    const reference = build(fleet.read(), fleet.dir);
    let listsFound = 0;
    for (let seed = 1; seed <= SHUFFLES; seed++) {
      const doc = fleet.read();
      listsFound = shuffleEveryList(doc, rng(seed));
      const text = build(doc, fleet.dir);
      if (text !== reference) {
        const a = reference.split('\n');
        const b = text.split('\n');
        const at = a.findIndex((line, i) => line !== b[i]);
        assert.fail(
          `shuffling the lists in ${fleet.dir}/recipe.yaml changed the Containerfile.\n` +
            `  reproduce with seed ${seed}\n` +
            `  first difference at line ${at + 1}\n` +
            `    reference: ${a[at]}\n` +
            `    shuffled:  ${b[at]}\n` +
            'Determinism (spec S7) is the property that makes "same recipe plus same base digest gives ' +
            'the same content digest" checkable at all. A compiler that depends on the order somebody ' +
            'typed their apps in cannot have that property, and the customer who alphabetises their ' +
            'own file gets an image nobody built before.',
        );
      }
    }
    // The guard that makes the loop above mean something. If shuffleEveryList found no lists, every
    // iteration would compare a recipe to itself and pass forever.
    assert.ok(listsFound >= 3, `only ${listsFound} lists were shuffled in ${fleet.dir}, so this test proved almost nothing`);
  });
}

test('the shuffler really does reorder things, so the property tests above are not vacuous', () => {
  // Two independent checks that the machinery works, because "same in, same out" passes trivially if
  // "same in" is all that ever happens. This is the check on the check.
  const original = school();
  const copy = school();
  const found = shuffleEveryList(copy, rng(7));
  assert.ok(found >= 5, `the school recipe has more than ${found} lists in it`);
  assert.notDeepEqual(copy, original, 'the shuffler returned the document unchanged');

  const next = rng(99);
  const order = shuffled(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], next);
  assert.notDeepEqual(order, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual([...order].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'the shuffle lost or duplicated an element');
});

test('the same seed shuffles the same way, so a failure message can be acted on', () => {
  const a = school();
  const b = school();
  shuffleEveryList(a, rng(42));
  shuffleEveryList(b, rng(42));
  assert.deepEqual(a, b);
  const c = school();
  shuffleEveryList(c, rng(43));
  assert.notDeepEqual(c, a, 'two different seeds produced the same shuffle');
});

// -------------------------------------------------------------------------------------------------
// The two bugs this file was written to find, named individually so a regression says which one
// -------------------------------------------------------------------------------------------------

test('reordering the Windows-programs evidence does not change the image', () => {
  // canonicalJson sorts object KEYS. It does not touch array order, and branding.json carries this
  // array verbatim, so before compile sorted it two rows swapped in a recipe produced a different
  // Containerfile for an identical fleet.
  const reference = build(school(), 'example-school');
  const swapped = school();
  const tested = (swapped['windows_apps'] as Doc)['tested'] as unknown[];
  assert.ok(tested.length >= 2, 'the fixture no longer has two test rows to swap, so this test proves nothing');
  (swapped['windows_apps'] as Doc)['tested'] = [...tested].reverse();
  assert.equal(build(swapped, 'example-school'), reference);
});

test('the evidence still reaches the image intact after being sorted', () => {
  // The other half: sorting must not be a way of losing a row. A determinism fix that dropped the
  // second entry would pass the test above and be much worse than the bug.
  const text = build(school(), 'example-school');
  const blob = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/usr\/share\/auros\/branding\/branding\.json/.exec(text);
  assert.ok(blob, 'the branding blob is not in the output');
  const branding = JSON.parse(Buffer.from(blob[1]!, 'base64').toString('utf8')) as {
    windows_apps: { tested: Array<{ app: string; date: string; result: string; note?: string }> };
  };
  const source = (school()['windows_apps'] as Doc)['tested'] as Array<{ app: string }>;
  assert.equal(branding.windows_apps.tested.length, source.length, 'a row of test evidence was lost in the sort');
  assert.deepEqual(
    branding.windows_apps.tested.map((t) => t.app).sort(),
    source.map((t) => t.app).sort(),
  );
  assert.deepEqual(
    branding.windows_apps.tested.map((t) => t.app),
    [...branding.windows_apps.tested.map((t) => t.app)].sort(),
    'the list reached the image unsorted, which is the determinism hole coming back',
  );
});

test('a kiosk that names one application opens that application, whatever order anything is in', () => {
  const reference = build(kiosk(), 'example-kiosk');
  for (let seed = 1; seed <= 25; seed++) {
    const doc = kiosk();
    shuffleEveryList(doc, rng(seed));
    assert.equal(build(doc, 'example-kiosk'), reference, `seed ${seed} changed a single-application kiosk`);
  }
  const conf = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/auros\/kiosk\.conf/.exec(reference);
  assert.ok(conf);
  assert.match(Buffer.from(conf[1]!, 'base64').toString('utf8'), /KIOSK_EXEC="flatpak run org\.mozilla\.firefox /);
});

// -------------------------------------------------------------------------------------------------
// Determinism against the machine, rather than against the file
// -------------------------------------------------------------------------------------------------

test('compiling the same recipe a hundred times on this machine produces one answer', () => {
  // The cheapest possible check and the one that catches a Map iteration order, a Set, a Date, or a
  // hash seed leaking into the output.
  const first = build(school(), 'example-school');
  for (let i = 0; i < 100; i++) assert.equal(build(school(), 'example-school'), first, `run ${i} differed`);
});

test('nothing about the machine or the clock reaches the output', () => {
  for (const fleet of FLEETS) {
    const text = build(fleet.read(), fleet.dir);
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]|C:\\/, `${fleet.dir}: a path from the build machine leaked in`);
    assert.doesNotMatch(text, /\b(?:19|20)\d\dT\d\d:\d\d:\d\d/, `${fleet.dir}: a wall-clock timestamp leaked in`);
    assert.doesNotMatch(text, new RegExp(`${new Date().getFullYear()}-\\d\\d-\\d\\dT`), `${fleet.dir}: today's date leaked in`);
    assert.doesNotMatch(text, /\/tmp\/|\/private\/var\//, `${fleet.dir}: a temporary path leaked in`);
  }
});

test('the environment cannot change the output except through the one variable that is supposed to', () => {
  // SOURCE_DATE_EPOCH is the contract every reproducible-build tool speaks, and it is the ONLY thing
  // in the environment the compiler is allowed to read. A second one would be a machine the build
  // depends on.
  const path = join(ROOT, 'customers', 'example-school', 'recipe.yaml');
  const result = validateDocument(toolchain(), school(), path);
  assert.ok(result.ok);
  const shared = {
    recipe: result.recipe!,
    recipePath: path,
    plan: result.plan!,
    fonts: result.fonts ?? [],
    config,
    catalogue: toolchain().catalogue,
    baseDigest: DIGEST,
    notes: result.notes,
  };
  const a = compile({ ...shared, sourceDateEpoch: 1_700_000_000 });
  const b = compile({ ...shared, sourceDateEpoch: 1_700_000_000 });
  assert.equal(a, b);
  const c = compile({ ...shared, sourceDateEpoch: 1_800_000_000 });
  assert.notEqual(a, c, 'SOURCE_DATE_EPOCH had no effect at all, so the field is decoration');
  assert.match(a, /ARG SOURCE_DATE_EPOCH=1700000000/);
});

test('a recipe with no lists left to shuffle still compiles, so the loop above has a floor case', () => {
  // The single-app, single-model shape a one-machine order produces. If the property tests only ever
  // saw rich recipes, a bug in the degenerate case would never be seen.
  const doc = workstation();
  doc['apps'] = ['Firefox'];
  (doc['hardware'] as Doc)['models'] = ['dell-latitude-e6440'];
  (doc['hardware'] as Doc)['machines'] = 1;
  delete (doc['hardware'] as Doc)['also_test'];
  const a = build(doc, 'example-workstation');
  const b = build(doc, 'example-workstation');
  assert.equal(a, b);
  assert.match(a, /FROM \$\{BASE\}/);
});
