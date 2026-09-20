/**
 * The prune engine and the data it stands on.
 *
 * Two kinds of test here. The first kind asserts the catalogue is internally sound -- nothing on the
 * protected set hides inside a removable group, every application resolves, every language brings a
 * font. Those are the checks that stop a bad edit to a TSV from becoming a fleet-wide brick, and
 * PROTECTED.md says explicitly that a human maintaining a list is the failure mode being guarded
 * against.
 *
 * The second kind proves the refusal actually fires, by handing the engine a DELIBERATELY BROKEN
 * catalogue. Without that, "the plan never contains a protected package" is a claim that passes
 * because nothing has ever put one there, which is not the same as a check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalogue } from '../src/catalogue.ts';
import { planPrune, postConditions, removalReportShape, pruneScript } from '../src/prune.ts';
import type { Recipe } from '../src/recipe.ts';
import { ROOT, school, kiosk, workstation, toolchain } from './helpers.ts';
import { validateDocument } from '../src/validate.ts';

const catalogue = loadCatalogue(join(ROOT, 'catalogue'));

function planFor(doc: Record<string, unknown>, path: string) {
  const result = validateDocument(toolchain(), doc, path);
  assert.ok(result.ok, `fixture did not validate: ${result.refusals.map((r) => r.what).join('; ')}`);
  return result.plan!;
}

// -------------------------------------------------------------------------------------------------
// The catalogue has to be sound before anything built on it means anything
// -------------------------------------------------------------------------------------------------

test('no protected package hides inside a removable group', () => {
  const offenders: string[] = [];
  for (const [group, members] of catalogue.groups) {
    for (const member of members) {
      if (member.kind === 'rpm' && catalogue.protectedSet.has(member.ref)) {
        offenders.push(`${member.ref} is in "${group}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'A protected package inside a removable group is a fleet-wide brick that every recipe would then ' +
      'be permitted to ask for. See schema/PROTECTED.md, "for whoever maintains the removable list".',
  );
});

test('every member of the protected set named in PROTECTED.md is in the machine-readable copy', () => {
  // PROTECTED.md is the authority and this file is its rendering. Parsing prose is brittle, so the
  // assertion is on the six roles the document names rather than on its exact wording.
  const doc = readFileSync(join(ROOT, 'schema', 'PROTECTED.md'), 'utf8');
  const roles = new Set([...catalogue.protectedSet.values()].map((e) => e.role));
  for (const role of ['update', 'rollback', 'network', 'init', 'security', 'signature', 'accessibility']) {
    assert.ok(roles.has(role), `catalogue/protected.tsv has no entry with role '${role}'`);
  }
  for (const pkg of ['bootc', 'greenboot', 'NetworkManager', 'systemd']) {
    assert.ok(catalogue.protectedSet.has(pkg), `${pkg} is missing from catalogue/protected.tsv`);
    assert.match(doc, new RegExp(pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `PROTECTED.md never mentions ${pkg}`);
  }
  assert.match(doc, /accessibility/i);
});

test('every protected entry carries a sentence, not a shrug', () => {
  for (const entry of catalogue.protectedSet.values()) {
    assert.ok(entry.why.length > 40, `${entry.pkg} has no real explanation: "${entry.why}"`);
  }
});

test('every application in the catalogue has a resolvable reference and a known group', () => {
  const groups = new Set(catalogue.groups.keys());
  for (const app of catalogue.apps.values()) {
    assert.ok(app.ref.length > 1, `${app.name} has no reference`);
    if (app.group) assert.ok(groups.has(app.group), `${app.name} claims group "${app.group}", which groups.tsv does not have`);
    assert.doesNotMatch(app.name, /[0-9]/, `${app.name} contains a digit, which makes it unspellable in a recipe`);
  }
});

test('every language brings at least one font package', () => {
  for (const entry of catalogue.languages.values()) {
    assert.ok(entry.fonts.length > 0, `${entry.language} has no font package, so an image in it would draw empty boxes`);
    assert.ok(entry.scripts.length > 0, `${entry.language} declares no script`);
  }
});

// -------------------------------------------------------------------------------------------------
// The engine
// -------------------------------------------------------------------------------------------------

test('a keep-only plan removes what was not asked for and keeps what was', () => {
  const plan = planFor(school(), join(ROOT, 'customers', 'example-school', 'recipe.yaml'));
  const removed = new Set(plan.remove.map((r) => r.ref));
  assert.ok(plan.keepOnly);
  assert.ok(removed.has('kpat'), 'a solitaire game survived "keep only the applications above"');
  assert.ok(!removed.has('dolphin'), 'Files was named in apps and was still removed');
  assert.ok(!removed.has('cups'), 'printing was in also_keep and was still removed');
  assert.ok(plan.install.rpm.includes('google-noto-sans-devanagari-vf-fonts'), 'Marathi did not bring its fonts');
});

test('a plan that keeps the ordinary desktop only removes the groups it named', () => {
  const plan = planFor(workstation(), join(ROOT, 'customers', 'example-workstation', 'recipe.yaml'));
  assert.equal(plan.keepOnly, false);
  const groups = new Set(plan.remove.map((r) => r.group));
  assert.deepEqual([...groups].sort(), ['games', 'sample wallpapers and media']);
});

test('no plan from any example recipe touches the protected set', () => {
  for (const [doc, dir] of [
    [school(), 'example-school'],
    [kiosk(), 'example-kiosk'],
    [workstation(), 'example-workstation'],
  ] as const) {
    const plan = planFor(doc, join(ROOT, 'customers', dir, 'recipe.yaml'));
    assert.deepEqual(plan.violations, [], `${dir} produced a protected-set violation`);
    for (const item of plan.remove) {
      assert.ok(!catalogue.protectedSet.has(item.ref), `${dir} would remove protected package ${item.ref}`);
    }
  }
});

test('the protected set is printed on every plan whether or not anybody asked about it', () => {
  const plan = planFor(workstation(), join(ROOT, 'customers', 'example-workstation', 'recipe.yaml'));
  assert.equal(plan.protectedKept.length, catalogue.protectedSet.size);
});

// -------------------------------------------------------------------------------------------------
// The refusal, proved against a catalogue that is deliberately wrong
// -------------------------------------------------------------------------------------------------

function brokenCatalogueDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auros-cat-'));
  for (const name of ['apps.tsv', 'languages.tsv', 'keyboards.tsv', 'protected.tsv']) {
    writeFileSync(join(dir, name), readFileSync(join(ROOT, 'catalogue', name), 'utf8'));
  }
  // The realistic mistake: somebody tidying groups.tsv decides the init system is a developer tool.
  writeFileSync(
    join(dir, 'groups.tsv'),
    `group\tkind\tref\ndeveloper tools\trpm\tgcc\ndeveloper tools\trpm\tsystemd\ngames\trpm\tkpat\nprinting\trpm\tcups\n`,
  );
  return dir;
}

test('a protected package reaching the removal set is refused, not quietly filtered', () => {
  const broken = loadCatalogue(brokenCatalogueDir());
  // example-school asks for "developer tools" to come out, and the broken catalogue has put the
  // init system in that group. This is the exact shape of the accident PROTECTED.md warns about:
  // a recipe that is entirely reasonable, sitting on a list that somebody edited wrongly.
  const recipe = school() as unknown as Recipe;
  const plan = planPrune(recipe, broken, []);

  assert.ok(plan.violations.length > 0, 'the engine accepted a plan that would remove systemd');
  const text = plan.violations.map((v) => `${v.what} ${v.why}`).join('\n');
  assert.match(text, /systemd/);
  assert.match(text, /fault in catalogue\/groups\.tsv/);
  assert.ok(!plan.remove.some((r) => r.ref === 'systemd'), 'systemd was refused AND still left in the removal set');
});

test('a fleet whose recipe is fine is still refused when the catalogue under it is not', () => {
  // The refusal has to reach the caller, not stop at the engine. This is the path CI takes.
  const broken = loadCatalogue(brokenCatalogueDir());
  const plan = planPrune(school() as unknown as Recipe, broken, []);
  assert.ok(plan.violations.some((v) => /protected set/i.test(v.what)));
});

// -------------------------------------------------------------------------------------------------
// The report shape and the post-conditions
// -------------------------------------------------------------------------------------------------

test('the removal report leaves every measured number null', () => {
  const plan = planFor(school(), join(ROOT, 'customers', 'example-school', 'recipe.yaml'));
  const report = removalReportShape(plan, { base: 'example/base@sha256:0', generatedBy: 'test' });
  assert.equal(report.measured.removed_count, null);
  assert.equal(report.measured.bytes_reclaimed, null);
  assert.equal(report.measured.image_size_bytes, null);
  assert.equal(report.floor.met, null);
  for (const item of report.planned) {
    assert.equal(item.version, null, `${item.package} came with a version nobody measured`);
    assert.equal(item.bytes_reclaimed, null, `${item.package} came with a byte count nobody measured`);
  }
});

test('the report prints the protected set under the heading PROTECTED.md promises', () => {
  const plan = planFor(kiosk(), join(ROOT, 'customers', 'example-kiosk', 'recipe.yaml'));
  const report = removalReportShape(plan, { base: 'example/base@sha256:0', generatedBy: 'test' });
  assert.match(report.kept_although_nothing_asked_for_them.heading, /Kept although nothing asked for them/);
  assert.equal(report.kept_although_nothing_asked_for_them.packages.length, catalogue.protectedSet.size);
});

test('the post-conditions assert the floor against the measured count, never against the plan', () => {
  const plan = planFor(school(), join(ROOT, 'customers', 'example-school', 'recipe.yaml'));
  const floor = postConditions(plan).find((p) => p.id === 'P1-floor');
  assert.ok(floor);
  assert.match(floor.assert, /measured removal count is at least 240/);
  assert.match(floor.why, /checked against what the build measured, never against the plan/);
  // And the guard that makes that sentence load-bearing: the plan alone does NOT meet the floor, so
  // asserting the plan would be an alarm that can never go off.
  assert.ok(plan.remove.length < plan.floor);
});

test('a kiosk carries the no-shell post-condition and says what it does not claim', () => {
  const plan = planFor(kiosk(), join(ROOT, 'customers', 'example-kiosk', 'recipe.yaml'));
  const recipe = kiosk() as unknown as Recipe;
  const conditions = postConditions(plan, recipe);
  const shell = conditions.find((p) => p.id === 'P6-kiosk-no-shell');
  assert.ok(shell, 'a kiosk plan has no assertion that the desktop shell is gone');
  assert.match(shell.why, /larger than a purpose-built minimal one/);
});

test('a desktop fleet does not carry the kiosk post-condition', () => {
  const plan = planFor(school(), join(ROOT, 'customers', 'example-school', 'recipe.yaml'));
  assert.equal(postConditions(plan, school() as unknown as Recipe).find((p) => p.id === 'P6-kiosk-no-shell'), undefined);
});

// -------------------------------------------------------------------------------------------------
// The in-image runner
// -------------------------------------------------------------------------------------------------

test('the prune script is a constant with no recipe text in it', () => {
  const script = pruneScript();
  // If a customer string ever reached this function, the most likely way in is a template hole.
  assert.doesNotMatch(script, /example-school|Vidyalaya|नमस्कार/);
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /--assumeno/, 'the script removes without resolving the transaction first');
  assert.match(script, /rpm -q --quiet "\$pkg" \|\| MISSING/, 'the script never verifies the protected set afterwards');
});

test('two calls to the prune script produce identical bytes', () => {
  assert.equal(pruneScript(), pruneScript());
});
