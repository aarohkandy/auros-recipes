/**
 * The catalogue loader's refusals.
 *
 * catalogue/*.tsv is the whole vocabulary of this toolchain: an application reaches a machine only
 * by having a row here, a language brings fonts only because a row says which, and the protected set
 * — the list whose loss makes a fleet unrepairable — is a file somebody maintains by hand.
 *
 * prune.test.ts already asserts that the catalogue as committed is SOUND. This file asserts the
 * different and more important thing: that a broken catalogue is REFUSED. Those are not the same
 * claim, and a mutation run on 2026-09-20 showed it — the duplicate-row check, the capability
 * whitelist and the empty-file check could each be deleted outright with all 433 tests still green,
 * because nothing had ever handed the loader a file with the fault in it.
 *
 * Every test here therefore builds a deliberately broken catalogue and requires the loader to stop.
 * See scripts/prove-red.mjs rows K01, K02 and K03, which reintroduce exactly these bugs and require
 * exactly these tests to go red.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalogue, readTsv, type Catalogue } from '../src/catalogue.ts';
import { planPrune } from '../src/prune.ts';
import type { Recipe } from '../src/recipe.ts';
import { ROOT } from './helpers.ts';

/**
 * A copy of the real catalogue with one file rewritten.
 *
 * A copy rather than a hand-written minimum, so that the fault under test is the ONLY difference
 * between this catalogue and the one that works. A four-row fixture would leave open the question of
 * whether the refusal came from the fault or from the fixture being thin.
 */
function brokenCatalogue<T>(file: string, rewrite: (text: string) => string, body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'auros-catalogue-'));
  try {
    cpSync(join(ROOT, 'catalogue'), dir, { recursive: true });
    writeFileSync(join(dir, file), rewrite(readFileSync(join(dir, file), 'utf8')));
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the control: the catalogue as committed loads', () => {
  // Without this, every test below could be passing because loadCatalogue throws on everything.
  const c = loadCatalogue(join(ROOT, 'catalogue'));
  assert.ok(c.apps.size > 10, 'the real catalogue loaded almost nothing, so the fixtures below prove little');
  assert.ok(c.protectedSet.size > 5);
});

// -------------------------------------------------------------------------------------------------
// K01 — a duplicate app row is an error, not a last-one-wins
// -------------------------------------------------------------------------------------------------

test('a duplicate app row is an error, not a last-one-wins', () => {
  brokenCatalogue('apps.tsv', (t) => `${t.trimEnd()}\nFirefox\trpm\tfirefox-esr-but-not-really\t-\t-\n`, (dir) => {
    assert.throws(
      () => loadCatalogue(dir),
      (err: unknown) => {
        assert.match((err as Error).message, /Firefox/);
        assert.match((err as Error).message, /appears twice/);
        return true;
      },
      'a second row for Firefox was accepted, so which package a fleet gets depends on row order',
    );
  });
});

test('and the reason it matters: the second row would otherwise win silently', () => {
  // The mutation deletes the throw. What is left is a Map.set that overwrites, so the last row wins
  // and nothing anywhere says so. This test states that consequence out loud, so the refusal above
  // reads as a decision rather than as a tidiness rule.
  const real = loadCatalogue(join(ROOT, 'catalogue'));
  const firefox = real.apps.get('Firefox');
  assert.ok(firefox, 'the fixture below assumes Firefox is in the catalogue');
  assert.notEqual(firefox.ref, 'firefox-esr-but-not-really');
});

// -------------------------------------------------------------------------------------------------
// K02 — a capability the toolchain cannot enforce
// -------------------------------------------------------------------------------------------------

test('a capability this toolchain cannot enforce is refused at load time, by value', () => {
  // 'terminl' is a typo for 'terminal'. Accepted, it enforces NOTHING: appRefusals asks whether an
  // app's capability is 'terminal' before refusing it on a fleet with can_reach_a_terminal: false,
  // so the fleet gets a terminal and the policy mode still reads as locked.
  brokenCatalogue('apps.tsv', (t) => t.replace(/\tterminal\n/, '\tterminl\n'), (dir) => {
    assert.throws(
      () => loadCatalogue(dir),
      (err: unknown) => {
        assert.match((err as Error).message, /terminl/, 'the refusal did not name the value it refused');
        assert.match((err as Error).message, /not one this toolchain knows how to enforce/);
        return true;
      },
    );
  });
});

test("a capability column the loader does know is accepted — so the check above is not 'refuse everything'", () => {
  for (const capability of ['-', 'terminal', 'installs-software']) {
    brokenCatalogue('apps.tsv', (t) => `${t.trimEnd()}\nSome New App\trpm\tsome-new-app\t-\t${capability}\n`, (dir) => {
      const c = loadCatalogue(dir);
      assert.equal(c.apps.get('Some New App')?.capability, capability === '-' ? null : capability);
    });
  }
});

// -------------------------------------------------------------------------------------------------
// K03 — an empty catalogue file is an error, not an empty set
// -------------------------------------------------------------------------------------------------

test('an empty catalogue file is an error, not an empty set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auros-tsv-'));
  try {
    for (const [label, text] of [
      ['zero-byte', ''],
      ['blank-lines-only', '\n\n\n'],
      ['comments and whitespace only', '# a comment\n\n   \n'],
    ] as const) {
      const path = join(dir, 'empty.tsv');
      writeFileSync(path, text);
      assert.throws(
        () => readTsv(path),
        /no rows at all|a catalogue that refuses everything/,
        `a ${label} catalogue file loaded as zero rows instead of stopping`,
      );
    }
    // A header row and nothing else is the OTHER empty: readTsv consumes the header, so this is the
    // file that yields an empty set rather than throwing. It has to be allowed -- groups.tsv may
    // legitimately be short -- which is exactly why the callers below matter.
    writeFileSync(join(dir, 'header.tsv'), 'a\tb\tc\n');
    assert.deepEqual(readTsv(join(dir, 'header.tsv')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated protected.tsv is refused, because an empty protected set removes systemd', () => {
  brokenCatalogue('protected.tsv', () => '', (dir) => {
    assert.throws(() => loadCatalogue(dir), /no rows at all/, 'an empty protected.tsv loaded as "nothing is protected"');
  });
});

test('and the reason THAT matters: an empty protected set lets a bad groups.tsv edit remove bootc', () => {
  /*
   * The demonstration, not a rule.
   *
   * PROTECTED.md says the protected set is enforced twice: by CONSTRUCTION, because protected
   * packages are members of the keep set, and by ASSERTION, because anything protected that reaches
   * the removal set is a refusal rather than a silent filter. The assertion half exists for exactly
   * one scenario -- somebody edits catalogue/groups.tsv and puts a protected package inside a
   * removable group. prune.test.ts calls that "the failure mode being guarded against".
   *
   * Both halves are the protected set. Empty it, and a groups.tsv that names bootc as part of
   * "developer tools" produces a clean plan that removes bootc: no violation, no signal, and a fleet
   * that can never be repaired remotely again. That is what "a catalogue file that is empty is a
   * catalogue that refuses everything" is protecting, and it is why the refusal above is not
   * pedantry about file formats.
   */
  const real = loadCatalogue(join(ROOT, 'catalogue'));
  assert.ok(real.protectedSet.has('bootc'), 'this test assumes bootc is on the protected set');

  const badGroups = new Map(real.groups);
  badGroups.set('developer tools', [
    ...(real.groups.get('developer tools') ?? []),
    { kind: 'rpm', ref: 'bootc' },
  ]);

  const recipe = {
    name: 'demonstration',
    apps: ['Calculator'],
    prune: { keep_only_the_apps_above: false, also_remove: ['developer tools'], must_remove_at_least: 1 },
    size_budget_gb: 9,
  } as unknown as Recipe;

  const guarded: Catalogue = { ...real, groups: badGroups };
  const unguarded: Catalogue = { ...real, groups: badGroups, protectedSet: new Map() };

  const withSet = planPrune(recipe, guarded, []);
  assert.ok(
    withSet.violations.some((v) => `${v.where} ${v.what}`.includes('bootc')),
    'the protected set did not refuse a group that names bootc, which is its entire second job',
  );
  assert.ok(!withSet.remove.some((r) => r.ref === 'bootc'));

  const withoutSet = planPrune(recipe, unguarded, []);
  assert.deepEqual(withoutSet.violations, [], 'with no protected set there is nothing left to refuse');
  assert.ok(
    withoutSet.remove.some((r) => r.ref === 'bootc'),
    'emptying the protected set did not change the plan, so this test is measuring the wrong thing',
  );
  assert.deepEqual(
    withoutSet.protectedKept,
    [],
    'and the removal report would tell the customer that nothing needed keeping',
  );
});
