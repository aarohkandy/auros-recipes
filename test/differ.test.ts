/**
 * THE MIDDLE CLAUSE OF SPEC SECTION 6B.
 *
 * The exit condition is that three visibly different recipes "build from the same base, boot, and
 * differ in every way the YAML says they should and IN NO WAY IT DOESN'T." Every other test in this
 * directory checks one recipe against itself: does it validate, does it compile, is it deterministic,
 * does it refuse what it should. Nothing checked the three against EACH OTHER, which is the only
 * place the two halves of that sentence can be tested at all.
 *
 * Two properties, and the second one is the one that finds things:
 *
 *   FORWARD -- every difference between two compiled image definitions traces to a line of YAML.
 *     Proved by construction rather than by inspection: take one recipe, overwrite every top-level
 *     key with the other recipe's value except the folder-bound `name`, compile, and the result must
 *     be the other recipe's image definition, differing only where the recipe's own name appears.
 *     If the compiler ever reads anything that is not in the file -- a clock, an environment
 *     variable, the order of a directory listing -- this is where it shows up.
 *
 *   INVERSE -- every difference in the YAML produces a difference in the image definition.
 *     For each field that differs between two recipes, swap that one field and nothing else. The
 *     output must change, or the swap must be refused with a sentence. A swap that is accepted and
 *     changes nothing is a field the machine ignores, which schema/README.md section 4 names
 *     directly: "a field the machine does not honour is a lie in a file whose whole claim is that it
 *     is the machine."
 *
 * WHAT THE INVERSE FOUND THE FIRST TIME IT RAN, all three in files that had been reviewed:
 *
 *   - `updates.install_between`. Three recipes, three different windows, and the field reached the
 *     image as nothing at all. Only `explain` printed it -- into the pull request body the customer
 *     reads and agrees to. It now carries a disclosure note, and explain says RECORDED, NOT YET
 *     APPLIED rather than stating a time the machine does not keep.
 *   - `hardware.also_test`. Sold in two READMEs as the reason "it cannot ask for less testing", and
 *     read by nothing: a recipe asking for uefi-secureboot got the same build and the same tests as
 *     one asking for nothing. It is now a label on the image, and CI reads that label back off the
 *     built artifact to drive the check matrix.
 *   - `prune.also_keep` under `keep_only_the_apps_above: false`. Nothing is swept, so nothing needs
 *     rescuing, so the line protected nothing while reading exactly like protection. Now refused.
 *
 * And one this test could NOT have found, which is why section 4 below exists separately: under
 * `keep_only_the_apps_above: true`, `prune.also_remove` removes zero additional packages, while
 * still changing the compiled bytes because every removal carries a `reason` string. The output
 * differs; the machine does not. Subtraction is the product (spec section 2), so the prune SET gets
 * its own assertions rather than being left to the byte comparison.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { compile } from '../src/compile.ts';
import { loadConfig } from '../src/config.ts';
import { validateDocument } from '../src/validate.ts';
import { ROOT, toolchain, type Doc } from './helpers.ts';

const config = loadConfig(ROOT);
const DIGEST = `sha256:${'a1b2c3d4'.repeat(8)}`;
const FLEETS = ['example-kiosk', 'example-school', 'example-workstation'] as const;
type Fleet = (typeof FLEETS)[number];

const PAIRS: Array<[Fleet, Fleet]> = [];
for (const a of FLEETS) for (const b of FLEETS) if (a !== b) PAIRS.push([a, b]);

function readFleet(name: Fleet): Doc {
  return parseYaml(readFileSync(join(ROOT, 'customers', name, 'recipe.yaml'), 'utf8')) as Doc;
}

type Built =
  | { ok: true; text: string; removals: string[]; floor: number; notes: ReadonlyArray<string> }
  | { ok: false; why: string };

/** Validate and compile one document as if it sat in `dir`. A refusal is a result, not a crash. */
function build(doc: Doc, dir: Fleet): Built {
  const path = join(ROOT, 'customers', dir, 'recipe.yaml');
  let result;
  try {
    result = validateDocument(toolchain(), doc, path);
  } catch (err) {
    return { ok: false, why: `validation threw: ${(err as Error).message}` };
  }
  if (!result.ok) return { ok: false, why: result.refusals.map((r) => `${r.where}: ${r.what}`).join(' ;; ') };
  let text: string;
  try {
    text = compile({
      recipe: result.recipe!,
      recipePath: path,
      plan: result.plan!,
      fonts: result.fonts ?? [],
      config,
      catalogue: toolchain().catalogue,
      baseDigest: DIGEST,
      notes: result.notes,
    });
  } catch (err) {
    return { ok: false, why: `compile threw: ${(err as Error).message}` };
  }
  return { ok: true, text, removals: result.plan!.remove.map((r) => r.ref), floor: result.plan!.floor, notes: result.notes };
}

function mustBuild(doc: Doc, dir: Fleet): Extract<Built, { ok: true }> {
  const out = build(doc, dir);
  assert.ok(out.ok, `${dir} did not compile: ${out.ok === false ? out.why : ''}`);
  return out;
}

/**
 * THE IMAGE DEFINITION AS SOMETHING A TEST CAN READ.
 *
 * A compiled Containerfile carries every human string as base64, so a raw text diff between two of
 * them says "line 86 differs" and nothing else. This decodes the payloads back, so an unexplained
 * difference can be printed as the sentence it is rather than as 1.4 KB of [A-Za-z0-9+/=]. The
 * instruction lines are kept verbatim with the long blobs elided, because their SHAPE is what the
 * forward property is about.
 */
interface View {
  readonly lines: string[];
  readonly files: Record<string, string>;
}

const PAYLOAD = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > (\S+)/g;

function view(text: string): View {
  const files: Record<string, string> = {};
  for (const m of text.matchAll(PAYLOAD)) files[m[2]!] = Buffer.from(m[1]!, 'base64').toString('utf8');
  const lines = text.split('\n').map((line) => line.replace(/'[A-Za-z0-9+/=]{40,}'/g, "'<payload>'"));
  return { lines, files };
}

/** Every difference between two views, as readable strings. */
function differences(a: View, b: View): string[] {
  const out: string[] = [];
  const n = Math.max(a.lines.length, b.lines.length);
  for (let i = 0; i < n; i++) {
    if (a.lines[i] !== b.lines[i]) out.push(`line ${i + 1}\n    left : ${a.lines[i] ?? '(absent)'}\n    right: ${b.lines[i] ?? '(absent)'}`);
  }
  for (const path of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
    const left = a.files[path], right = b.files[path];
    if (left === right) continue;
    if (left === undefined || right === undefined) { out.push(`${path} exists on only one side`); continue; }
    const la = left.split('\n'), lb = right.split('\n');
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      if (la[i] !== lb[i]) out.push(`${path} line ${i + 1}\n    left : ${la[i] ?? '(absent)'}\n    right: ${lb[i] ?? '(absent)'}`);
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// 0. The three recipes are visibly different before anything clever happens
// -------------------------------------------------------------------------------------------------

test('the three example recipes compile, and no two produce the same image definition', () => {
  const built = new Map<Fleet, string>();
  for (const fleet of FLEETS) built.set(fleet, mustBuild(readFleet(fleet), fleet).text);
  for (const [a, b] of PAIRS) {
    assert.notEqual(
      built.get(a),
      built.get(b),
      `${a} and ${b} compile to the same Containerfile. Spec section 6B wants three VISIBLY DIFFERENT ` +
        'recipes; two names over one image is the thing that sentence exists to prevent.',
    );
  }
});

// -------------------------------------------------------------------------------------------------
// 1. FORWARD — every difference traces to a line of YAML
// -------------------------------------------------------------------------------------------------

/**
 * `name` is the one field that cannot be swapped: the validator refuses a recipe whose name does not
 * match the folder it sits in, and refuses a name another fleet already uses. Both refusals are
 * correct and both are tested in refusals.test.ts. So the forward property is stated modulo the
 * name, and the residual differences must each CONTAIN one of the two names -- which is itself the
 * assertion, not an excuse: a residual difference that mentions neither name is a difference the
 * YAML does not account for.
 */
for (const [a, b] of PAIRS) {
  test(`forward: ${a} + every field of ${b} == ${b}, except where its own name appears`, () => {
    const target = readFleet(b);
    const doc = readFleet(a);
    let swapped = 0;
    for (const key of new Set([...Object.keys(readFleet(a)), ...Object.keys(target)])) {
      if (key === 'name') continue;
      if (key in target) doc[key] = structuredClone(target[key]);
      else delete doc[key];
      swapped++;
    }
    assert.ok(swapped >= 15, `only ${swapped} keys were swapped; this recipe format has more than that`);

    const got = build(doc, a);
    assert.ok(
      got.ok,
      `${a} carrying every one of ${b}'s fields did not validate, so the forward property could not ` +
        `be tested for this pair. That is a finding in itself -- two recipes whose fields cannot be ` +
        `interchanged have a coupling the schema does not express.\n  ${got.ok === false ? got.why : ''}`,
    );

    const unexplained = differences(view(got.text), view(mustBuild(target, b).text)).filter(
      (d) => !d.includes(a) && !d.includes(b),
    );
    assert.deepEqual(
      unexplained,
      [],
      `${unexplained.length} difference(s) between these two image definitions are not accounted for by ` +
        'any field in either recipe.yaml. Everything the compiler emits must come out of the file it ' +
        'was handed; anything else is a clock, an environment variable or a directory listing leaking ' +
        `into a customer's operating system.\n\n${unexplained.slice(0, 8).join('\n\n')}`,
    );
  });
}

// -------------------------------------------------------------------------------------------------
// 2. INVERSE — every difference in the YAML produces a difference in the image definition
// -------------------------------------------------------------------------------------------------

const ABSENT = Symbol('absent');

function leafPaths(node: unknown, prefix = '', out: string[] = []): string[] {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const k of Object.keys(node as Doc)) leafPaths((node as Doc)[k], prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out.push(prefix);
  return out;
}

function at(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(k in (cur as Doc))) return ABSENT;
    cur = (cur as Doc)[k];
  }
  return cur;
}

function put(doc: Doc, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Doc = doc;
  for (const k of parts.slice(0, -1)) {
    if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Doc;
  }
  const last = parts.at(-1)!;
  if (value === ABSENT) delete cur[last];
  else cur[last] = structuredClone(value);
}

/**
 * A single-field swap that is ACCEPTED and changes NOTHING is normally a lie. These are the cases
 * where it is not, each with the reason printed in the run output -- D34's rule, because an
 * exemption nobody reads is how the next real one gets waved through.
 *
 * The test asserts these are still exempt-worthy: an entry that starts producing a difference is
 * reported, so this list cannot rot into a permanent excuse.
 */
const EXEMPT: Array<{ path: string; reason: string }> = [
  {
    path: 'kiosk.usb_storage',
    reason:
      'recipe.schema.json declares "default": false for this field, so DELETING it is semantically ' +
      'the same request as setting it false, and an identical image is the correct answer. Setting ' +
      'it to true does change the image (KIOSK_USB_STORAGE in /etc/auros/kiosk.conf), which the ' +
      'test below asserts, so the field itself is load-bearing and only its absence is inert.',
  },
];

for (const [a, b] of PAIRS) {
  test(`inverse: every field where ${a} differs from ${b} is load-bearing`, (t) => {
    const A = readFleet(a), B = readFleet(b);
    const baseline = mustBuild(readFleet(a), a).text;
    const paths = [...new Set([...leafPaths(A), ...leafPaths(B)])].sort();

    const ignored: string[] = [];
    let tested = 0, refused = 0, moved = 0;
    for (const path of paths) {
      const left = at(A, path), right = at(B, path);
      if (JSON.stringify(left === ABSENT ? null : left) === JSON.stringify(right === ABSENT ? null : right) && (left === ABSENT) === (right === ABSENT)) continue;
      tested++;
      const doc = readFleet(a);
      put(doc, path, right);
      const got = build(doc, a);
      if (!got.ok) { refused++; continue; }          // coupled, and refused with a sentence: load-bearing
      if (got.text !== baseline) { moved++; continue; }
      const exempt = EXEMPT.find((e) => e.path === path);
      if (exempt) { t.diagnostic(`exempt  ${path}  ${exempt.reason}`); continue; }
      ignored.push(`${path}\n      ${a} says ${JSON.stringify(left === ABSENT ? '(absent)' : left)}, ${b} says ${JSON.stringify(right === ABSENT ? '(absent)' : right)}`);
    }

    // The guard that stops this test passing by testing nothing. Two recipes in this repository
    // differ in well over twenty fields; a run that examined three of them proved almost nothing.
    assert.ok(tested >= 12, `only ${tested} differing fields were found between ${a} and ${b}, which cannot be right`);
    assert.ok(moved >= 8, `only ${moved} of ${tested} swaps changed the output, which suggests the harness is not compiling anything`);

    assert.deepEqual(
      ignored,
      [],
      `${ignored.length} field(s) differ between ${a} and ${b}, are accepted by the validator when ` +
        'swapped, and produce a byte-identical image definition. schema/README.md section 4: "a field ' +
        'the machine does not honour is a lie in a file whose whole claim is that it is the machine." ' +
        'Either wire the field through to the image, refuse it, or disclose it in a validation note ' +
        `the way theme and updates.install_between are disclosed.\n\n    ${ignored.join('\n    ')}`,
    );
  });
}

test('desktop.layout: every change of layout changes the image definition, and windows is the absent default', () => {
  const images = new Map<string, string>();
  for (const layout of [undefined, 'windows', 'browser-first', 'simple', 'mac']) {
    const doc = readFleet('example-workstation');
    const desktop = (doc['desktop'] ??= {}) as Doc;
    if (layout === undefined) delete desktop['layout']; else desktop['layout'] = layout;
    images.set(String(layout), mustBuild(doc, 'example-workstation').text);
  }
  // windows is declared "default": "windows", so it is the same request as leaving it out.
  assert.equal(images.get('windows'), images.get('undefined'));
  // Every other value is a different machine, and each is different from the other two.
  const distinct = new Set(['undefined', 'browser-first', 'simple', 'mac'].map((k) => images.get(k)));
  assert.equal(distinct.size, 4, 'two different layouts compiled to the same image definition');
  // And under kiosk the field is refused, not ignored.
  const k = readFleet('example-kiosk');
  k['desktop'] = { layout: 'mac' };
  const got = build(k, 'example-kiosk');
  assert.equal(got.ok, false, 'a kiosk accepted a desktop layout it has no desktop to show');
});

test('the exemptions are still exemptions, and each one is load-bearing when it is set', () => {
  // kiosk.usb_storage: absent behaves as false (exempt), but false -> true must move the image, or
  // the exemption above is covering a genuinely dead field.
  const doc = readFleet('example-kiosk');
  const before = mustBuild(readFleet('example-kiosk'), 'example-kiosk');
  (doc['kiosk'] as Doc)['usb_storage'] = true;
  const after = mustBuild(doc, 'example-kiosk');
  assert.notEqual(before.text, after.text, 'kiosk.usb_storage is exempt from the inverse test and does nothing when set either');
  assert.match(view(after.text).files['/etc/auros/kiosk.conf'] ?? '', /KIOSK_USB_STORAGE=yes/);
  assert.match(view(before.text).files['/etc/auros/kiosk.conf'] ?? '', /KIOSK_USB_STORAGE=no/);
});

// -------------------------------------------------------------------------------------------------
// 3. The three fields the inverse property found, pinned individually
// -------------------------------------------------------------------------------------------------

test('hardware.also_test reaches the image, and adds test machines rather than replacing them', () => {
  const profiles = (fleet: Fleet, doc = readFleet(fleet)) => {
    const m = /auros\.test-profiles="([^"]*)"/.exec(mustBuild(doc, fleet).text);
    assert.ok(m, `${fleet} carries no auros.test-profiles label; the check matrix has nothing to read`);
    return m![1]!.split(',');
  };

  // Three recipes, three different answers -- which is the whole point, and was not true before.
  assert.deepEqual(profiles('example-school'), ['bios-legacy', 'uefi-modern']);
  assert.deepEqual(profiles('example-kiosk'), ['bios-legacy', 'small-disk', 'uefi-modern']);
  assert.deepEqual(profiles('example-workstation'), ['uefi-modern', 'uefi-secureboot']);

  // "There is no also_skip." A recipe may only ADD, and uefi-modern is there whatever it says,
  // because it is the profile the update group runs on.
  const stripped = readFleet('example-school');
  delete (stripped['hardware'] as Doc)['also_test'];
  assert.deepEqual(profiles('example-school', stripped), ['uefi-modern']);

  const asked = readFleet('example-school');
  (asked['hardware'] as Doc)['also_test'] = ['low-ram', 'old-cpu'];
  assert.deepEqual(profiles('example-school', asked), ['low-ram', 'old-cpu', 'uefi-modern']);
});

test('updates.install_between is disclosed as not applied, on the report and in the explain text', () => {
  for (const fleet of FLEETS) {
    const doc = readFleet(fleet);
    const window = (doc['updates'] as Doc | undefined)?.['install_between'];
    assert.ok(typeof window === 'string', `${fleet} no longer sets an update window; retarget this test`);
    const built = mustBuild(doc, fleet);
    const note = built.notes.find((n) => n.startsWith('updates.install_between:'));
    assert.ok(note, `${fleet} states an update window and discloses nothing about it`);
    assert.match(note!, /NOT applied/);
    // The note reaches the Containerfile header, so it is on the artifact and not only in a
    // terminal somebody ran once.
    assert.ok(built.text.includes('DISCLOSED AT VALIDATION TIME'), `${fleet}'s Containerfile carries no disclosure block`);
    assert.ok(built.text.includes('NOT applied'), `${fleet}'s Containerfile does not carry the update-window disclosure`);
  }
});

test('prune.also_keep is refused when keep_only_the_apps_above is false, because it protects nothing', () => {
  const doc = readFleet('example-workstation');
  assert.equal((doc['prune'] as Doc)['keep_only_the_apps_above'], false, 'this fixture must keep keep_only false');
  (doc['prune'] as Doc)['also_keep'] = ['printing'];
  const got = build(doc, 'example-workstation');
  assert.equal(got.ok, false, 'also_keep with nothing to keep from was accepted');
  assert.match((got as { why: string }).why, /also_keep/);
  assert.match((got as { why: string }).why, /keep_only_the_apps_above is false/);
});

// -------------------------------------------------------------------------------------------------
// 4. The prune sets, which the byte comparison above cannot judge
// -------------------------------------------------------------------------------------------------

/**
 * Spec section 2: "Craft here is subtraction... A machine with eleven applications instead of three
 * hundred is the entire value proposition." Three recipes that remove the same things are one recipe
 * with three names, and the byte diff will not say so, because the REASON strings differ even when
 * the removal set does not.
 */
test('the three prune sets are three sets, and the numbers are reported not assumed', (t) => {
  const sets = new Map<Fleet, Set<string>>();
  for (const fleet of FLEETS) sets.set(fleet, new Set(mustBuild(readFleet(fleet), fleet).removals));

  for (const fleet of FLEETS) t.diagnostic(`${fleet}: ${sets.get(fleet)!.size} packages named for removal`);

  for (const [a, b] of PAIRS) {
    const A = sets.get(a)!, B = sets.get(b)!;
    const shared = [...A].filter((x) => B.has(x)).length;
    const jaccard = shared / (A.size + B.size - shared);
    t.diagnostic(`${a} vs ${b}: ${[...A].filter((x) => !B.has(x)).length} only in ${a}, ${shared} shared, jaccard ${jaccard.toFixed(3)}`);
    assert.notDeepEqual([...A].sort(), [...B].sort(), `${a} and ${b} remove exactly the same packages, so they are one recipe with two names`);
  }
});

/**
 * A FINDING PINNED AS A TRIPWIRE, not a property we are pleased with.
 *
 * example-school's removal set is a STRICT SUBSET of example-kiosk's. A 180-machine Marathi
 * classroom fleet and a 40-machine walk-up kiosk -- the two most different fleets in the spec's own
 * exit condition -- are separated by five KDE applications and nothing else, because
 * keep_only_the_apps_above does all of the removing in both and they keep nearly the same catalogue.
 * The kiosk's ten-group also_remove block contributes zero packages (see the next test).
 *
 * Asserted exactly, so that the day this relationship changes -- in either direction, for a good
 * reason or a bad one -- somebody has to look at it and decide. An inequality with a threshold
 * somebody invented would not do that.
 */
test('the three prune sets are a nested chain: workstation ⊂ school ⊂ kiosk', () => {
  const school = new Set(mustBuild(readFleet('example-school'), 'example-school').removals);
  const kiosk = new Set(mustBuild(readFleet('example-kiosk'), 'example-kiosk').removals);
  const workstation = new Set(mustBuild(readFleet('example-workstation'), 'example-workstation').removals);

  // Not three sets that overlap. A total order by inclusion: every package any recipe removes, the
  // kiosk also removes. There is no fleet in this repository that subtracts something another fleet
  // keeps, which is a much weaker claim than "three visibly different recipes" sounds like.
  assert.deepEqual([...workstation].filter((p) => !school.has(p)), [], 'the workstation now removes something the school keeps; re-read this test');
  assert.deepEqual([...school].filter((p) => !kiosk.has(p)), [], 'the school now removes something the kiosk does not; re-read this test');
  assert.deepEqual(
    [...kiosk].filter((p) => !school.has(p)).sort(),
    ['dolphin', 'gwenview', 'kcalc', 'kwrite', 'okular'],
    'the kiosk/school subtraction gap has moved. That is either a real product change or a regression, ' +
      'and either way it is the difference between the two fleets spec section 6B calls most different.',
  );
});

test('under keep_only_the_apps_above, also_remove removes nothing further — and says so', () => {
  // This is a property of planPrune, not of these fixtures: the keep-only universe is every group
  // member plus every catalogue application, and also_remove draws from group members.
  for (const fleet of ['example-school', 'example-kiosk'] as const) {
    const base = mustBuild(readFleet(fleet), fleet);
    assert.equal((readFleet(fleet)['prune'] as Doc)['keep_only_the_apps_above'], true);
    const stripped = readFleet(fleet);
    (stripped['prune'] as Doc)['also_remove'] = [];
    const got = mustBuild(stripped, fleet);
    assert.deepEqual(
      [...got.removals].sort(),
      [...base.removals].sort(),
      `${fleet}: emptying also_remove changed the removal set, which contradicts the note this recipe ` +
        'now carries. Update the note before updating this test.',
    );
    const note = base.notes.find((n) => n.startsWith('prune.also_remove:'));
    assert.ok(note, `${fleet} names groups in also_remove under keep_only and discloses nothing`);
    assert.match(note!, /already removed by/);
  }

  // The inverse, so the note is not merely pessimism: with keep_only false, also_remove is the only
  // lever there is, and it moves.
  const ws = readFleet('example-workstation');
  const before = mustBuild(ws, 'example-workstation').removals.length;
  const fewer = readFleet('example-workstation');
  (fewer['prune'] as Doc)['also_remove'] = ['games'];
  const after = mustBuild(fewer, 'example-workstation').removals.length;
  assert.ok(after < before, `also_remove did nothing on a keep_only:false recipe either (${before} -> ${after})`);
});

test('the floors and the size budgets are three different numbers, because the fleets are three fleets', () => {
  const floors = FLEETS.map((f) => mustBuild(readFleet(f), f).floor);
  assert.equal(new Set(floors).size, FLEETS.length, `the prune floors are ${floors.join(', ')} — two fleets sharing a floor means one of them was copied`);
});

// -------------------------------------------------------------------------------------------------
// 5. The check on the check
// -------------------------------------------------------------------------------------------------

/**
 * D34: a check that has only ever been watched going green is indistinguishable from one that cannot
 * fail. Every assertion above rests on `build()` actually compiling and `differences()` actually
 * seeing things, so both are driven into failure here with deliberate damage.
 */
test('the machinery goes red on purpose', () => {
  // differences() sees a changed payload, not just a changed instruction line.
  const school = mustBuild(readFleet('example-school'), 'example-school').text;
  const tampered = readFleet('example-school');
  (tampered['organisation'] as Doc)['display_name'] = 'A Completely Different School';
  const other = mustBuild(tampered, 'example-school').text;
  const found = differences(view(school), view(other));
  assert.ok(found.length > 0, 'differences() reported nothing after the organisation name changed');
  assert.ok(
    found.some((d) => d.includes('A Completely Different School')),
    'differences() saw a changed line but could not decode it, so every payload difference above was invisible:\n' + found.join('\n'),
  );

  // build() really does refuse, rather than returning ok for everything.
  const broken = readFleet('example-school');
  broken['policy'] = 'not-a-policy';
  const refused = build(broken, 'example-school');
  assert.equal(refused.ok, false, 'build() accepted a policy mode that does not exist');

  // The inverse test's swap machinery really writes, and really deletes.
  const doc = readFleet('example-school');
  put(doc, 'theme.accent', '#000000');
  assert.equal((doc['theme'] as Doc)['accent'], '#000000');
  put(doc, 'theme.accent', ABSENT);
  assert.equal(at(doc, 'theme.accent'), ABSENT);
  assert.ok(leafPaths(readFleet('example-school')).length >= 25, 'leafPaths found almost nothing to compare');
});
