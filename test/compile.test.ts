/**
 * The compiler: determinism, and the promise that no free text reaches a build instruction.
 *
 * Both properties are load-bearing and neither is visible by reading one generated file.
 * Determinism is what makes spec section 6B's "same recipe plus same pinned base digest gives the
 * same content digest" checkable at all. The free-text property is the one that matters if an order
 * from a stranger ever arrives as a pull request, which is the design.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { compile, canonicalJson, resolveSourceDateEpoch, token, UnsafeToken } from '../src/compile.ts';
import { loadConfig } from '../src/config.ts';
import type { Recipe } from '../src/recipe.ts';
import { validateDocument } from '../src/validate.ts';
import { ROOT, school, kiosk, workstation, mutate, toolchain, type Doc } from './helpers.ts';

const config = loadConfig(ROOT);

function build(doc: Doc, dir: string, extra: { baseDigest?: string; sourceDateEpoch?: number } = {}): string {
  const path = join(ROOT, 'customers', dir, 'recipe.yaml');
  const result = validateDocument(toolchain(), doc, path);
  assert.ok(result.ok, `fixture did not validate: ${result.refusals.map((r) => r.what).join('; ')}`);
  return compile({
    recipe: result.recipe!,
    recipePath: path,
    plan: result.plan!,
    fonts: result.fonts ?? [],
    config,
    catalogue: toolchain().catalogue,
    baseDigest: extra.baseDigest,
    sourceDateEpoch: extra.sourceDateEpoch,
    notes: result.notes,
  });
}

const DIGEST = `sha256:${'a1b2c3d4'.repeat(8)}`;

/** Everything above the first build instruction. */
function headerOf(text: string): string {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l !== '' && !l.startsWith('#'));
  return lines.slice(0, first === -1 ? lines.length : first).join('\n');
}

// -------------------------------------------------------------------------------------------------
// Determinism
// -------------------------------------------------------------------------------------------------

test('the same recipe and the same base digest produce the same bytes', () => {
  const a = build(school(), 'example-school', { baseDigest: DIGEST });
  const b = build(school(), 'example-school', { baseDigest: DIGEST });
  assert.equal(a, b);
});

test('reordering lists in the recipe does not change the Containerfile', () => {
  // A customer who alphabetises their own apps list must not produce a different image. If this ever
  // fails, "same recipe in, same image out" has stopped being true for a reason nobody would guess.
  const shuffled = mutate(school(), (d) => {
    (d['apps'] as string[]).reverse();
    ((d['prune'] as Doc)['also_remove'] as string[]).reverse();
    (d['hardware'] as Doc)['models'] = [...((d['hardware'] as Doc)['models'] as string[])].reverse();
  });
  assert.equal(
    build(shuffled, 'example-school', { baseDigest: DIGEST }),
    build(school(), 'example-school', { baseDigest: DIGEST }),
  );
});

test('nothing machine-specific reaches the output', () => {
  const text = build(school(), 'example-school', { baseDigest: DIGEST });
  assert.doesNotMatch(text, /\/Users\/|\/home\/|C:\\\\/, 'an absolute path from the build machine leaked in');
  assert.doesNotMatch(text, new RegExp(String(new Date().getFullYear()) + '-\\d\\d-\\d\\dT'), 'a wall-clock timestamp leaked in');
});

test('the build clock comes out of the recipe, not out of the machine', () => {
  const recipe = school() as unknown as Recipe;
  const withoutEnv = resolveSourceDateEpoch(recipe, {});
  assert.equal(withoutEnv, Math.floor(Date.parse('2026-09-18T00:00:00Z') / 1000));
  assert.equal(resolveSourceDateEpoch(recipe, { SOURCE_DATE_EPOCH: '1700000000' }), 1700000000);
});

test('canonical JSON sorts keys so two equal documents are equal byte for byte', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
});

// -------------------------------------------------------------------------------------------------
// The FROM line is not the recipe's to choose
// -------------------------------------------------------------------------------------------------

test('the base comes from the namespace file and carries the digest when one is known', () => {
  // The base arrives as the DEFAULT of ARG BASE, so an ordinary build with no arguments produces
  // exactly the pinned image and a fork can point at its own copy without editing this file. What
  // matters for the guarantee is that the default is derived from auros.config.json and that no
  // recipe can influence it -- see the refusal table, which covers the recipe side.
  const escaped = config.baseImage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pinned = build(school(), 'example-school', { baseDigest: DIGEST });
  assert.match(pinned, new RegExp(`^ARG BASE=${escaped}@${DIGEST}$`, 'm'));
  const unpinned = build(school(), 'example-school');
  assert.match(unpinned, new RegExp(`^ARG BASE=${escaped}:${config.baseTag}$`, 'm'));
});

test('there is exactly one FROM line', () => {
  const text = build(kiosk(), 'example-kiosk', { baseDigest: DIGEST });
  assert.equal(text.split('\n').filter((l) => l.startsWith('FROM ')).length, 1, 'a multi-stage build would let a recipe reach a base nobody reviewed');
  assert.equal(text.split('\n').filter((l) => l.startsWith('ARG BASE=')).length, 1, 'more than one default for the foundation is no default at all');
});

test('the header says it is generated and names the recipe and the base', () => {
  const text = build(school(), 'example-school', { baseDigest: DIGEST });
  const header = headerOf(text);
  assert.match(header, /GENERATED FILE\. DO NOT EDIT\./);
  assert.match(header, /recipe\s+example-school/);
  assert.match(header, new RegExp(DIGEST));
  assert.match(header, /THE BASE IS NOT CHOSEN HERE/);
});

// -------------------------------------------------------------------------------------------------
// Free text never reaches a build instruction
// -------------------------------------------------------------------------------------------------

/** Every line that a shell will actually execute: RUN, and its backslash continuations. */
function instructionLines(text: string): string[] {
  const out: string[] = [];
  let continuing = false;
  for (const line of text.split('\n')) {
    const isRun = /^(RUN|SHELL|LABEL|ARG|FROM|ENV|COPY|ADD|CMD|ENTRYPOINT)\b/.test(line);
    if (isRun || continuing) {
      out.push(line);
      continuing = line.trimEnd().endsWith('\\');
    }
  }
  return out;
}

test('no sentence a human wrote appears in any build instruction', () => {
  const text = build(school(), 'example-school', { baseDigest: DIGEST });
  const instructions = instructionLines(text).join('\n');
  const recipe = school();
  const org = recipe['organisation'] as Doc;
  for (const human of [
    org['display_name'] as string,
    (org['helpdesk'] as Doc)['label'] as string,
    (org['helpdesk'] as Doc)['phone'] as string,
    recipe['first_boot_message'] as string,
    (recipe['for'] as string).trim().split('\n')[0]!.trim(),
  ]) {
    assert.ok(
      !instructions.includes(human),
      `"${human}" reached a build instruction. It is supposed to arrive inside a base64 blob, so that ` +
        'no byte a customer wrote is ever a shell word.',
    );
  }
});

test('an organisation name full of shell metacharacters still cannot reach a shell', () => {
  // The validator refuses command substitution, so this is the residue: quotes, semicolons and
  // ampersands, which are legitimate in a name and must survive into the image as text.
  const nasty = `O'Brien & Sons; "rm -rf /" <school>`;
  const doc = mutate(school(), (d) => { (d['organisation'] as Doc)['display_name'] = nasty; });
  const text = build(doc, 'example-school', { baseDigest: DIGEST });
  assert.ok(!instructionLines(text).join('\n').includes(nasty));
  // ...and it did arrive, decodable, as data.
  const blob = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/usr\/share\/auros\/branding\/branding\.json/.exec(text);
  assert.ok(blob, 'the branding blob is not in the output at all');
  const branding = JSON.parse(Buffer.from(blob[1]!, 'base64').toString('utf8')) as { organisation: string };
  assert.equal(branding.organisation, nasty, 'the name did not survive its trip through base64 intact');
});

test('every base64 payload really is base64 and nothing else', () => {
  for (const [doc, dir] of [[school(), 'example-school'], [kiosk(), 'example-kiosk']] as const) {
    const text = build(doc, dir, { baseDigest: DIGEST });
    for (const match of text.matchAll(/printf '%s' '([^']*)' \| base64 -d/g)) {
      assert.match(match[1]!, /^[A-Za-z0-9+/]+={0,2}$/, 'a payload escaped its own encoding');
    }
  }
});

test('every comment line in the output is actually a comment', () => {
  // The `for` paragraph and the helpdesk notes go into the header. A newline that was not re-prefixed
  // would turn a customer sentence into an instruction.
  const doc = mutate(school(), (d) => { d['for'] = `${d['for'] as string}\nRUN echo pwned\n`.repeat(1); });
  const text = build(doc, 'example-school', { baseDigest: DIGEST });
  for (const line of headerOf(text).split('\n')) {
    assert.ok(line === '' || line.startsWith('#'), `a header line is not a comment: ${line}`);
  }
});

test('the compiler refuses to emit a token it did not expect, rather than quoting harder', () => {
  assert.throws(() => token('a locale', 'mr_IN.UTF-8; rm -rf /'), UnsafeToken);
  assert.equal(token('a locale', 'mr_IN.UTF-8'), 'mr_IN.UTF-8');
});

// -------------------------------------------------------------------------------------------------
// The recipe's own instructions actually appear
// -------------------------------------------------------------------------------------------------

test('a kiosk compiles to the kiosk policy and one window', () => {
  const text = build(kiosk(), 'example-kiosk', { baseDigest: DIGEST });
  assert.match(text, /apply-policy kiosk/);
  const conf = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/auros\/kiosk\.conf/.exec(text);
  assert.ok(conf, 'a kiosk image was compiled without naming the application it runs');
  const decoded = Buffer.from(conf[1]!, 'base64').toString('utf8');
  assert.match(decoded, /KIOSK_EXEC="flatpak run org\.mozilla\.firefox --kiosk https:\/\/start\.example\.org\/kiosk"/);
  assert.match(decoded, /THE ALLOW-LIST IS NOT A SECURITY BOUNDARY/);
});

test('an open workstation compiles to the open policy and keeps its terminal', () => {
  const text = build(workstation(), 'example-workstation', { baseDigest: DIGEST });
  assert.match(text, /apply-policy open/);
  assert.match(text, /^\s+konsole( \\)?$/m, 'the recipe asked for Konsole and the build does not install it');
});

test('every application in the recipe reaches the image, by exactly one mechanism', () => {
  const text = build(school(), 'example-school', { baseDigest: DIGEST });
  for (const ref of ['kcalc', 'okular', 'dolphin', 'gwenview', 'kwrite']) {
    assert.match(text, new RegExp(`^\\s+${ref}( &&)?( \\\\)?$`, 'm'), `${ref} is not installed`);
  }
  for (const id of ['org.mozilla.firefox', 'com.google.Chrome', 'org.kde.gcompris', 'edu.mit.Scratch', 'org.videolan.VLC']) {
    assert.ok(text.includes(`[Flatpak Preinstall %s]\\n' ${id}`), `${id} is not declared for preinstall`);
  }
});

test('the prune runs, and the floor and the protected count are stated in the file', () => {
  const text = build(school(), 'example-school', { baseDigest: DIGEST });
  assert.match(text, /RUN \/usr\/libexec\/auros\/auros-prune/);
  assert.match(text, /the floor is 240: a build that removes fewer FAILS/);
  assert.match(text, /kept whatever anybody asked/);
});

test('the disclosed unknowns from validation are stamped into the generated file', () => {
  const text = build(school(), 'example-school', { baseDigest: DIGEST });
  assert.match(text, /DISCLOSED AT VALIDATION TIME/);
  assert.match(text, /no row in hardware\/compat\.tsv yet/);
  assert.match(text, /theme: recorded in the image as data/);
});
