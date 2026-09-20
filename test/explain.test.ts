/**
 * `explain`, which is the only artefact in this repository a customer definitely reads.
 *
 * It becomes the body of the pull request an order opens (spec section 6D), so it is the document an
 * IT coordinator at a school signs off a hundred and eighty laptops against. Three things therefore
 * have to be true of it, and they are tested here in the order of how badly each one fails:
 *
 *   1. IT MUST NOT CLAIM A NUMBER NOBODY COMPUTED. Every count in the text has to be derivable from
 *      the plan in front of it. A package count that was close enough is prohibition 4.4 in the one
 *      place a customer would act on it.
 *
 *   2. IT MUST NAME EVERY GROUP IT REMOVES. Subtraction is the product (spec section 1.2). A summary
 *      line where the list should be is a brochure for the wrong half of what we sell.
 *
 *   3. IT MUST BE READABLE BY THE PERSON IT IS FOR. Where a human name exists for something, the
 *      text uses it. `kcalc` is not a thing a school IT coordinator agreed to.
 *
 * happy.test.ts already checks that the big sections exist. This file is about what is inside them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { explain } from '../src/explain.ts';
import { loadConfig } from '../src/config.ts';
import { validateDocument } from '../src/validate.ts';
import { ROOT, school, kiosk, workstation, toolchain, type Doc } from './helpers.ts';
import type { PrunePlan } from '../src/prune.ts';

const config = loadConfig(ROOT);
const DIGEST = `sha256:${'0f1e2d3c'.repeat(8)}`;

function explained(doc: Doc, dir: string): { prose: string; flat: string; plan: PrunePlan } {
  const path = join(ROOT, 'customers', dir, 'recipe.yaml');
  const result = validateDocument(toolchain(), doc, path);
  assert.ok(result.ok, `${dir}: ${result.refusals.map((r) => `${r.where}: ${r.what}`).join('; ')}`);
  const prose = explain({
    recipe: result.recipe!,
    plan: result.plan!,
    catalogue: toolchain().catalogue,
    config,
    fonts: result.fonts ?? [],
    baseDigest: DIGEST,
    notes: result.notes,
  });
  return { prose, flat: prose.replace(/\s+/g, ' '), plan: result.plan! };
}

const FLEETS = [
  { dir: 'example-school', read: school },
  { dir: 'example-kiosk', read: kiosk },
  { dir: 'example-workstation', read: workstation },
] as const;

// -------------------------------------------------------------------------------------------------
// 1. Every number in the text was computed
// -------------------------------------------------------------------------------------------------

test('every number printed as a package count is one this text actually computed', () => {
  for (const fleet of FLEETS) {
    const { flat, plan } = explained(fleet.read(), fleet.dir);
    const recipe = fleet.read();

    // The four counts explain is allowed to print, each checked against the plan it was handed.
    assert.ok(
      flat.includes(`Those are the ${plan.remove.length} packages this recipe names by hand`),
      `${fleet.dir}: the named-removal count is not the plan's`,
    );
    assert.ok(
      flat.includes(`${plan.protectedKept.length} packages cannot be removed by any recipe`),
      `${fleet.dir}: the protected count is not the plan's`,
    );
    assert.ok(
      flat.includes(`this fleet's floor is ${plan.floor}`),
      `${fleet.dir}: the floor printed is not the recipe's floor`,
    );
    const apps = (recipe['apps'] as string[]).length;
    assert.match(flat, new RegExp(`What is on them: ${apps} application`, 'i'), `${fleet.dir}: the application count is wrong`);
  }
});

test('the text says the real number is larger and that the build measures it, rather than implying a plan is a result', () => {
  for (const fleet of FLEETS) {
    const { flat } = explained(fleet.read(), fleet.dir);
    assert.match(flat, /The real number will be larger/, `${fleet.dir}: the closure is not disclosed`);
    assert.match(flat, /measured on the built image, not estimated here/, `${fleet.dir}: nothing says the numbers are measured elsewhere`);
  }
});

test('no number in the text is a percentage, a saving, or a count of anything we have not got', () => {
  // Prohibition 4.4, enforced against the text rather than against an intention. The list of shapes
  // is deliberately broader than the words happy.test.ts checks for, because the failure is a
  // plausible sentence rather than a stock phrase.
  for (const fleet of FLEETS) {
    const { flat } = explained(fleet.read(), fleet.dir);
    assert.doesNotMatch(flat, /\d+\s?% of (?:apps|applications|programs|customers|schools)/i, `${fleet.dir}: a compatibility percentage`);
    assert.doesNotMatch(flat, /(?:saves?|saving|saved)\s+[£$€]\s?\d/i, `${fleet.dir}: a savings figure`);
    assert.doesNotMatch(flat, /\d+\s+(?:schools|charities|nonprofits|customers|organisations) (?:use|trust|chose)/i, `${fleet.dir}: a customer count`);
    assert.doesNotMatch(flat, /\b\d+ years? of (?:updates|support)\b/i, `${fleet.dir}: a support horizon we have not got`);
    assert.doesNotMatch(flat, /up to \d+% (?:faster|smaller|lighter)/i, `${fleet.dir}: a performance claim`);
  }
});

test('a number this text did compute changes when the recipe changes, so the assertions above are not matching a constant', () => {
  // Without this, every count test above would pass against a compiler that printed "240" always.
  const raised = school();
  (raised['prune'] as Doc)['must_remove_at_least'] = 999;
  assert.match(explained(raised, 'example-school').flat, /this fleet's floor is 999/);

  const fewer = workstation();
  const before = (fewer['apps'] as string[]).length;
  (fewer['apps'] as string[]).pop();
  assert.match(explained(fewer, 'example-workstation').flat, new RegExp(`WHAT IS ON THEM: ${before - 1} APPLICATION`));
});

// -------------------------------------------------------------------------------------------------
// 2. Every group it removes is named
// -------------------------------------------------------------------------------------------------

test('every group in the removal plan appears by name in the text', () => {
  for (const fleet of FLEETS) {
    const { prose, plan } = explained(fleet.read(), fleet.dir);
    const groups = new Set(plan.remove.map((item) => item.group).filter((g): g is string => g !== null));
    assert.ok(groups.size > 0, `${fleet.dir}: the plan removes nothing by group, so this test proves nothing`);
    for (const group of groups) {
      assert.ok(prose.includes(group), `${fleet.dir}: the text never names the removed group "${group}"`);
    }
  }
});

test('packages that fell out of a keep-only subtraction are accounted for rather than left off the page', () => {
  // The interesting half of a keep-only plan: most of what goes has no group at all, and a text that
  // only listed grouped removals would show a school a short list and delete a long one.
  const { prose, plan } = explained(school(), 'example-school');
  const ungrouped = plan.remove.filter((item) => item.group === null);
  assert.ok(ungrouped.length > 0, 'the school plan has no ungrouped removals, so this test proves nothing');
  assert.ok(prose.includes('not one of the applications above'), 'ungrouped removals are not given a heading of their own');
  for (const item of ungrouped) {
    assert.ok(prose.includes(item.ref), `${item.ref} is removed and appears nowhere in the text`);
  }
});

test('every package in the plan appears in the text exactly once, so nothing is deleted silently', () => {
  for (const fleet of FLEETS) {
    const { prose, plan } = explained(fleet.read(), fleet.dir);
    for (const item of plan.remove) {
      assert.ok(prose.includes(item.ref), `${fleet.dir}: ${item.ref} is on the removal plan and is not in the text`);
    }
    // And the totals have to agree with the list, not just be present.
    const listed = prose
      .split('\n')
      .filter((l) => /^ {6}\S/.test(l))
      .join(' ');
    for (const item of plan.remove) {
      assert.ok(listed.includes(item.ref), `${fleet.dir}: ${item.ref} appears in the text but not inside a removal list`);
    }
  }
});

test('the count printed for each group equals the number of packages listed under it', () => {
  for (const fleet of FLEETS) {
    const { prose, plan } = explained(fleet.read(), fleet.dir);
    const byGroup = new Map<string, number>();
    for (const item of plan.remove) {
      const key = item.group ?? 'not one of the applications above';
      byGroup.set(key, (byGroup.get(key) ?? 0) + 1);
    }
    for (const [group, count] of byGroup) {
      const line = new RegExp(`^ {2}${group.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -- ${count} package`, 'm');
      assert.match(prose, line, `${fleet.dir}: the heading for "${group}" does not say ${count} packages`);
    }
  }
});

test('the deletion section comes before the policy section, because subtraction is the product', () => {
  for (const fleet of FLEETS) {
    const { prose } = explained(fleet.read(), fleet.dir);
    const deleted = prose.indexOf('WHAT GETS DELETED');
    const stays = prose.indexOf('WHAT STAYS, WHATEVER ANYBODY ASKS');
    const rules = prose.indexOf('THE RULES IN FORCE');
    const notdo = prose.indexOf('WHAT THIS WILL NOT DO');
    assert.ok(deleted > 0 && stays > deleted, `${fleet.dir}: the protected set is not printed after the deletions`);
    assert.ok(rules > stays, `${fleet.dir}: the policy section is not after both`);
    assert.ok(notdo > rules, `${fleet.dir}: the disclosures are not at the end where they are read`);
  }
});

// -------------------------------------------------------------------------------------------------
// 3. Readable by the person it is for
// -------------------------------------------------------------------------------------------------

test('the application list uses the names a person chose, never the package identifiers', () => {
  // The apps section is the one place a human name definitely exists for every entry: the recipe
  // wrote them. Printing `kcalc` or `org.mozilla.firefox` there would be showing somebody an
  // identifier they never typed, in the document they are signing.
  for (const fleet of FLEETS) {
    const { prose } = explained(fleet.read(), fleet.dir);
    const section = prose.slice(prose.indexOf('WHAT IS ON THEM'), prose.indexOf('WHAT GETS DELETED'));
    assert.ok(section.length > 50, `${fleet.dir}: there is no applications section to read`);
    for (const name of fleet.read()['apps'] as string[]) {
      assert.ok(section.includes(name), `${fleet.dir}: "${name}" is installed and is not named in the text`);
    }
    const catalogue = toolchain().catalogue;
    for (const name of fleet.read()['apps'] as string[]) {
      const ref = catalogue.apps.get(name)!.ref;
      if (ref.toLowerCase() === name.toLowerCase()) continue; // Konsole is called Konsole
      assert.ok(
        !section.includes(ref),
        `${fleet.dir}: the applications section shows the identifier '${ref}' where the name "${name}" exists`,
      );
    }
  }
});

test('nothing in the text is a raw container reference, a digest or a schema path', () => {
  for (const fleet of FLEETS) {
    const { prose } = explained(fleet.read(), fleet.dir);
    // The base reference is printed once, deliberately, on the "Built on" line. Anywhere else a
    // digest appears, somebody has leaked plumbing into a document for a non-engineer.
    const digests = prose.split('\n').filter((l) => l.includes('sha256:'));
    assert.equal(digests.length, 1, `${fleet.dir}: a digest appears ${digests.length} times:\n${digests.join('\n')}`);
    assert.match(digests[0]!, /Built on/);
    assert.doesNotMatch(prose, /\$\{|#\/\$defs|additionalProperties|instancePath/, `${fleet.dir}: a schema or template fragment leaked into the prose`);
    assert.doesNotMatch(prose, /\bundefined\b|\bnull\b|\[object Object\]|NaN/, `${fleet.dir}: a missing value printed as code rather than as words`);
  }
});

test('no line is too long to read, because this is a pull request body and not a log', () => {
  // The exception is exact rather than generous: a line may exceed the column only when it is a
  // single unbreakable token -- a digest, a package reference -- because breaking one of those is
  // worse than a long line. A line with a space in it past the column has simply not been wrapped,
  // which is what the labelled rows in "what these machines are" used to be.
  const COLUMN = 96;
  for (const fleet of FLEETS) {
    const { prose } = explained(fleet.read(), fleet.dir);
    prose.split('\n').forEach((line, i) => {
      if (line.length <= COLUMN) return;
      const longestToken = Math.max(...line.trim().split(/\s+/).map((w) => w.length));
      assert.ok(
        longestToken > COLUMN - line.search(/\S/),
        `${fleet.dir}: line ${i + 1} is ${line.length} characters and could have been wrapped:\n${line}`,
      );
    });
  }
});

test('a labelled row long enough to need wrapping actually wraps, with the value kept in its column', () => {
  // The negative control for the rule above: without a case that WOULD overflow, "every line fits"
  // passes on a fixture whose lines all happened to be short.
  const wide = school();
  (wide['hardware'] as Doc)['models'] = ['dell-latitude-e6440', 'hp-probook-650-g1', 'lenovo-thinkpad-t440'];
  (wide['organisation'] as Doc)['helpdesk'] = {
    label: 'School IT helpdesk, second floor, next to the staff room and the photocopier',
    phone: '+91 20 2555 0143',
  };
  const { prose } = explained(wide, 'example-school');
  const lines = prose.split('\n');
  const at = lines.findIndex((l) => l.startsWith('  Help is'));
  assert.ok(at > 0, 'the helpdesk row is not in the text');
  assert.ok(lines[at]!.length <= 96, `the helpdesk row did not wrap: ${lines[at]}`);
  assert.match(lines[at + 1]!, /^ {21}\S/, 'the continuation line is not indented into the value column');
  assert.ok(
    prose.replace(/\s+/g, ' ').includes('next to the staff room and the photocopier'),
    'wrapping the row lost part of the value',
  );
});

test('the protected set is grouped by the job each package does, not dumped as a list', () => {
  // "Read their jobs in order and it is one sentence" is a promise the text makes about itself.
  const { prose, plan } = explained(school(), 'example-school');
  const roles = new Set(plan.protectedKept.map((p) => p.role));
  assert.ok(roles.size >= 5, `only ${roles.size} distinct roles, so the grouping is not doing anything`);
  for (const role of roles) assert.ok(prose.includes(role), `the protected set is not grouped under "${role}"`);
  for (const entry of plan.protectedKept) assert.ok(prose.includes(entry.pkg), `${entry.pkg} is protected and is not listed`);
});

// -------------------------------------------------------------------------------------------------
// The disclosures, which are the part a customer is owed before they find out
// -------------------------------------------------------------------------------------------------

test('the rollout disclosure is sized to this fleet rather than to somebody else\'s', () => {
  // A forty-kiosk customer reading about "the other 175" learns the page was written for somebody
  // else, and that is the moment a disclosure stops being read.
  const { flat: schoolText } = explained(school(), 'example-school');
  assert.match(schoolText, /these 5 go first and the other 175 follow next week/);

  const { flat: kioskText } = explained(kiosk(), 'example-kiosk');
  assert.match(kioskText, /these 5 go first and the other 35 follow next week/);

  const one = workstation();
  (one['hardware'] as Doc)['machines'] = 1;
  const { flat: single } = explained(one, 'example-workstation');
  assert.match(single, /There is only one machine on this order, so this changes nothing today/);
  assert.doesNotMatch(single, /the other -?\d+ follow/, 'a one-machine order was told about the other zero machines');
});

test('a fleet of two machines does not produce a rollout sentence that reads as nonsense', () => {
  const two = workstation();
  (two['hardware'] as Doc)['machines'] = 2;
  const { flat } = explained(two, 'example-workstation');
  assert.match(flat, /these 1 go first and the other 1 follow next week|only one machine/);
  assert.doesNotMatch(flat, /other 0 follow|other -\d/);
});

test('every disclosure in "what this will NOT do" is present for every fleet, enabled or not', () => {
  const required = [
    /Move your Windows programs across/,
    /Bring across saved passwords, cookies or payment details/,
    /Touch a machine's system disk before your files are copied off it and verified/,
    /Roll out to some machines before others/,
    /Hold a package back, pin a version, or stay on an older image/,
    /Run anything a stranger wrote in your build/,
  ];
  for (const fleet of FLEETS) {
    const { flat } = explained(fleet.read(), fleet.dir);
    for (const line of required) assert.match(flat, line, `${fleet.dir}: a standing disclosure is missing`);
  }
});

test('the theme gap is disclosed on a fleet that sets one and absent on a fleet that does not', () => {
  // A disclosure that appears unconditionally is one a reader learns to skip, and one that never
  // appears is a field quietly doing nothing. Both directions are checked here.
  const { flat: withTheme } = explained(school(), 'example-school');
  assert.match(withTheme, /the layer that applies them is not built yet/);

  const without = workstation();
  delete without['theme'];
  const { flat: none } = explained(without, 'example-workstation');
  assert.doesNotMatch(none, /the layer that applies them is not built yet/, 'a fleet with no theme was told its theme does nothing');
  assert.doesNotMatch(none, /HOW IT LOOKS/, 'an empty appearance section was printed anyway');
});

test('a fleet with no Windows-compatibility layer is told so plainly rather than left to infer it', () => {
  const { flat } = explained(kiosk(), 'example-kiosk');
  assert.match(flat, /Not enabled on this fleet\. Windows programs will not run on these machines\./);
});

test('a fleet that enables the layer with nothing tested says exactly that', () => {
  // The worst case for prohibition 4.2: the capability is on, and the honest position is that we do
  // not know whether anything runs.
  const untested = workstation();
  untested['windows_apps'] = { enabled: true, we_promise_nothing_else: true };
  const { flat } = explained(untested, 'example-workstation');
  assert.match(flat, /Nothing has been tested yet/);
  assert.match(flat, /we do not know whether your programs run/);
  assert.doesNotMatch(flat, /most (?:programs|apps) (?:work|run)/i);
});

test('every tested Windows program reaches the text with its date, its result and its caveat', () => {
  const { prose } = explained(school(), 'example-school');
  for (const entry of (school()['windows_apps'] as Doc)['tested'] as Array<{ app: string; date: string; result: string; note: string }>) {
    assert.ok(prose.includes(entry.app), `${entry.app} was tested and is not in the text`);
    assert.ok(prose.includes(entry.date), `${entry.app}'s test date is not in the text`);
    assert.ok(prose.includes(entry.result), `${entry.app}'s result is not in the text`);
    assert.ok(prose.includes(entry.note.split('.')[0]!), `${entry.app}'s caveat is not in the text`);
  }
  assert.match(prose.replace(/\s+/g, ' '), /Anything not on it is untested, and untested means unknown rather than fine/);
});

// -------------------------------------------------------------------------------------------------
// The licence claim, which D30 and D31 made it possible to get wrong in the one document that ships
// -------------------------------------------------------------------------------------------------

test('the sign-off does not offer a right we have not granted', () => {
  // DECISIONS.md D30/D31: proprietary, all rights reserved, repositories readable. This paragraph
  // used to tell the customer to fork the repository and rebuild, which is a licence grant printed in
  // the pull request body they sign off on -- prohibition 4.4 in the place it would do most damage.
  for (const fleet of FLEETS) {
    const { flat } = explained(fleet.read(), fleet.dir);
    // These match a GRANT, not the word. The honest replacement text says "it is not permission to
    // redistribute it" and "readable; it is not open source", so a pattern that matched the bare
    // words would go red on the fix and green on the bug, which is the wrong way round.
    for (const forbidden of [
      /you (?:may|can|are free to) (?:fork|copy|redistribute|distribute|share)/i,
      /fork (?:this|the|our) repositor/i,
      /\bfork it\b/i,
      /\bis open[- ]source\b/i,
      /licen[cs]ed under/i,
      /\bapache\b/i,
      /\bMIT licen[cs]e\b/i,
      /free to (?:copy|share|distribute|redistribute)/i,
      /rebuild this exact operating system/i,
      /that is the point\b/i,
    ]) {
      assert.doesNotMatch(flat, forbidden, `${fleet.dir}: the customer-facing text offers a right we have not granted`);
    }
  }
});

test('the sign-off still makes the narrower promise, so the fix was not simply a deletion', () => {
  // D31's actual commitment. Removing the false claim and putting nothing in its place would leave a
  // school with no answer to "what happens to us if you stop", which is the question that decides a
  // first pilot.
  for (const fleet of FLEETS) {
    const { flat } = explained(fleet.read(), fleet.dir);
    assert.match(flat, /if we ever cease operating you are given the build files for your own image/i, `${fleet.dir}`);
    assert.match(flat, /not a licence to our tooling/i, `${fleet.dir}`);
    assert.match(flat, /it is not permission to redistribute it/i, `${fleet.dir}`);
    assert.match(flat, /readable; it is not open source/i, `${fleet.dir}`);
  }
});

test('a pending enrolment is stated as a thing that blocks the machines, not as a footnote', () => {
  const { flat } = explained(school(), 'example-school');
  assert.match(flat, /enrolment record is still pending/);
  assert.match(flat, /will test-build but will not reach a machine/);

  const settled = school();
  (settled['approved_by'] as Doc)['enrolment'] = 'ENR-2026-0041';
  const { flat: done } = explained(settled, 'example-school');
  assert.doesNotMatch(done, /enrolment record is still pending/, 'a settled enrolment was reported as pending');
  assert.match(done, /Enrolment record ENR-2026-0041/);
});

test('the disclosed notes from validation reach the customer-facing text', () => {
  const { flat } = explained(school(), 'example-school');
  assert.match(flat, /DISCLOSED ON THIS ORDER/);
  assert.match(flat, /no row in hardware\/compat\.tsv yet/);
  assert.match(flat, /stamped on the build report and on the pull request as untested hardware/);
});
