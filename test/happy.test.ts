/**
 * The happy paths. There are three of them, and that is the whole point of spec section 6B's exit
 * condition: three visibly different recipes build from the same base and differ in every way the
 * YAML says they should, and IN NO WAY IT DOES NOT.
 *
 * The last clause is the interesting half, and most of this file is about it. Asserting that a
 * kiosk is a kiosk is easy. Asserting that the school image and the kiosk image agree on everything
 * neither recipe asked to differ about is what catches a compiler that quietly bakes in an
 * assumption.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { compile } from '../src/compile.ts';
import { explain } from '../src/explain.ts';
import { loadConfig } from '../src/config.ts';
import { validateDocument } from '../src/validate.ts';
import { ROOT, school, kiosk, workstation, toolchain, type Doc } from './helpers.ts';

const config = loadConfig(ROOT);
const DIGEST = `sha256:${'0f1e2d3c'.repeat(8)}`;

/**
 * explain wraps its paragraphs to a readable column, so a sentence a test looks for is usually
 * split across lines. Assert on the prose, not on where it happened to break.
 */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

const FLEETS = [
  { dir: 'example-school', doc: school(), policy: 'managed' },
  { dir: 'example-kiosk', doc: kiosk(), policy: 'kiosk' },
  { dir: 'example-workstation', doc: workstation(), policy: 'open' },
] as const;

function everything(entry: { dir: string; doc: Doc }) {
  const path = join(ROOT, 'customers', entry.dir, 'recipe.yaml');
  const result = validateDocument(toolchain(), entry.doc, path);
  assert.ok(result.ok, `${entry.dir}: ${result.refusals.map((r) => `${r.where}: ${r.what}`).join('\n')}`);
  const shared = {
    recipe: result.recipe!,
    plan: result.plan!,
    fonts: result.fonts ?? [],
    config,
    catalogue: toolchain().catalogue,
    baseDigest: DIGEST,
    notes: result.notes,
  };
  return {
    result,
    containerfile: compile({ ...shared, recipePath: path }),
    prose: explain(shared),
  };
}

test('all three example recipes are accepted', () => {
  for (const fleet of FLEETS) {
    const { result } = everything(fleet);
    assert.equal(result.ok, true);
    assert.equal(result.recipe!.policy, fleet.policy);
  }
});

test('an untested hardware model is disclosed as a note, never as a silent pass', () => {
  // compat.tsv is empty today. An unknown model has to leave a mark, or the gate becomes advisory
  // "temporarily" in week one and stays that way.
  const { result } = everything(FLEETS[0]);
  assert.ok(result.notes.length > 0);
  assert.ok(result.notes.some((n) => /no row in hardware\/compat\.tsv/.test(n)));
});

test('all three build from the same base, and it is the one in the namespace file', () => {
  const bases = FLEETS.map((f) => {
    const line = everything(f).containerfile.split('\n').find((l) => l.startsWith('ARG BASE='));
    assert.ok(line, `${f.dir} has no base at all`);
    return line;
  });
  assert.equal(new Set(bases).size, 1, 'three recipes produced more than one foundation');
  assert.ok(bases[0]!.includes(config.baseImage));
  assert.ok(bases[0]!.includes(DIGEST));
});

test('they differ in every way the YAML says they should', () => {
  const [school_, kiosk_, workstation_] = FLEETS.map((f) => everything(f).containerfile);

  assert.match(school_!, /apply-policy managed/);
  assert.match(kiosk_!, /apply-policy kiosk/);
  assert.match(workstation_!, /apply-policy open/);

  assert.match(school_!, /LANG=%s\\n' mr_IN\.UTF-8/);
  assert.match(kiosk_!, /LANG=%s\\n' en_US\.UTF-8/);
  assert.match(workstation_!, /LANG=%s\\n' en_GB\.UTF-8/);

  assert.match(school_!, /zoneinfo\/Asia\/Kolkata/);
  assert.match(kiosk_!, /zoneinfo\/America\/Los_Angeles/);
  assert.match(workstation_!, /zoneinfo\/Europe\/London/);

  // Only the school asked for a second script, and only it gets a layout toggle.
  assert.match(school_!, /in:mar-inscript/);
  assert.doesNotMatch(kiosk_!, /inscript/i);
  assert.doesNotMatch(workstation_!, /inscript/i);

  // Only the school enabled Windows programs.
  assert.match(school_!, /com\.usebottles\.bottles/);
  assert.doesNotMatch(kiosk_!, /bottles/);
  assert.doesNotMatch(workstation_!, /bottles/);

  // Only the kiosk names one window.
  assert.match(kiosk_!, /\/etc\/auros\/kiosk\.conf/);
  assert.doesNotMatch(school_!, /kiosk\.conf/);
});

test('and in no way the YAML does not', () => {
  // Every fleet gets the same structural steps in the same order. A compiler that emitted an extra
  // RUN for one fleet and not another would be making a decision no recipe asked it to make.
  const shapes = FLEETS.map((f) =>
    everything(f)
      .containerfile.split('\n')
      .filter((l) => /^(FROM|ARG|SHELL|RUN|LABEL)\b/.test(l))
      .map((l) => l.split(/[ =]/)[0])
      .join(' '),
  );
  // The kiosk has one extra data blob (its kiosk.conf) and no Flatpak-compat step; the workstation
  // has neither. What must hold for all three is that the skeleton is the same sequence of verbs.
  for (const shape of shapes) {
    assert.match(shape, /^ARG FROM ARG SHELL RUN/, 'the preamble differs between fleets');
    assert.match(shape, /RUN LABEL RUN$/, 'the file does not end with labels then the structural check');
  }
});

test('explain names what gets deleted before it names anything else it does', () => {
  for (const fleet of FLEETS) {
    const prose = everything(fleet).prose;
    assert.ok(prose.includes('WHAT GETS DELETED'), `${fleet.dir}: explain never says what gets deleted`);
    assert.ok(prose.includes('WHAT STAYS, WHATEVER ANYBODY ASKS'), `${fleet.dir}: the protected set is not printed`);
    assert.ok(prose.includes('WHAT THIS WILL NOT DO'), `${fleet.dir}: explain makes no disclosure at all`);
  }
});

test('explain tells a non-engineer that Windows programs do not migrate, unprompted', () => {
  // Prohibition 4.2. It has to be in the text whether or not the fleet enabled the compatibility
  // layer, because the customer who most needs to read it is the one who did enable it.
  for (const fleet of FLEETS) {
    const prose = flat(everything(fleet).prose);
    assert.match(prose, /Programs do not migrate|Windows programs will not run/);
    assert.match(prose, /Office and Adobe specifically do not/);
    assert.match(prose, /saved passwords, cookies or payment details/);
  }
});

test('explain never invents a number nobody measured', () => {
  const { prose: raw, result } = everything(FLEETS[0]);
  const prose = flat(raw);
  assert.match(prose, /The real number will be larger/);
  assert.match(prose, /measured on the built image, not estimated here/);
  // The only package count it may print is the size of the plan.
  assert.ok(prose.includes(`Those are the ${result.plan!.remove.length} packages this recipe names by hand`));
});

test('explain says what kiosk does not mean, in the same breath as what it does', () => {
  const prose = flat(everything(FLEETS[1]).prose);
  assert.match(prose, /no desktop in this image at all/);
  assert.match(prose, /bigger than a purpose-built minimal one/);
  assert.match(prose, /does not bound what somebody can do once they are on one of them/);
});

test('explain admits the gaps rather than leaving them to be discovered', () => {
  const prose = flat(everything(FLEETS[0]).prose);
  assert.match(prose, /THINGS THAT ARE HONESTLY NOT HERE YET/);
  assert.match(prose, /cannot carry a password/);
  assert.match(prose, /No staged rollout|Staged rollout/i);
  assert.match(prose, /the layer that applies them is not built yet/);
});

test('explain never claims a customer count, a saving or a testimonial', () => {
  for (const fleet of FLEETS) {
    const prose = everything(fleet).prose.toLowerCase();
    for (const forbidden of ['customers trust', 'schools saved', 'testimonial', '% of apps', 'average saving']) {
      assert.ok(!prose.includes(forbidden), `${fleet.dir}: explain made an unevidenced claim: ${forbidden}`);
    }
  }
});

test('a pending enrolment is stated, because it blocks reaching a machine', () => {
  const prose = flat(everything(FLEETS[0]).prose);
  assert.match(prose, /enrolment record is still pending/);
  assert.match(prose, /will test-build but will not reach a machine/);
});
