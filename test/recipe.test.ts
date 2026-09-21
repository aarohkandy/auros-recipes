/**
 * The desktop defaults, asserted BY VALUE.
 *
 * DECISIONS.md D4 binds the product to a Windows-shaped desktop shipped system-wide, so the familiar
 * answer is what an omitted field means: taskbar, Explorer-like file manager, familiar folder names,
 * double-click, guided first boot. Two fields deliberately default the other way -- installing
 * software and reaching a terminal -- because a capability nobody asked for must not appear because
 * a field was left out.
 *
 * That table was tested only through compiled output: a mutation run on 2026-09-20 flipped
 * can_reach_a_terminal to true and discarded every explicit `false`, and in both cases the ONLY
 * thing that went red was a byte-for-byte comparison against a committed Containerfile, whose own
 * failure message tells the reader to regenerate it. Do that and the suite is green and the fleet
 * has a terminal.
 *
 * So these assertions are on the values, in this module, where the rule is written -- plus the two
 * consequences that make the rule matter. See scripts/prove-red.mjs rows R03 and R05.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_DEFAULTS, desktopSettings, type Recipe } from '../src/recipe.ts';
import { check, mutate, said, school, type Doc } from './helpers.ts';

const nothingDeclared = {} as Recipe;

test('the desktop defaults are restrictive where a capability is concerned', () => {
  assert.equal(DESKTOP_DEFAULTS.can_reach_a_terminal, false);
  assert.equal(DESKTOP_DEFAULTS.can_install_apps, false);
});

test('the desktop defaults are familiar where the SHAPE of the desktop is concerned (D4)', () => {
  assert.equal(DESKTOP_DEFAULTS.taskbar_and_start_menu, true);
  assert.equal(DESKTOP_DEFAULTS.explorer_like_file_manager, true);
  assert.equal(DESKTOP_DEFAULTS.familiar_folder_names, true);
  assert.equal(DESKTOP_DEFAULTS.double_click_to_open, true);
  assert.equal(DESKTOP_DEFAULTS.guided_first_boot, true);
});

test('a recipe that says nothing about the desktop gets exactly those defaults', () => {
  // The whole table, by value, so that adding a field without deciding its default fails here rather
  // than shipping whatever `undefined` happens to mean downstream.
  assert.deepEqual(desktopSettings(nothingDeclared), {
    taskbar_and_start_menu: true,
    explorer_like_file_manager: true,
    familiar_folder_names: true,
    double_click_to_open: true,
    guided_first_boot: true,
    can_install_apps: false,
    can_reach_a_terminal: false,
  });
});

test('an explicit false in the desktop block overrides a true default', () => {
  /*
   * `if (value)` instead of `if (typeof value === 'boolean')` discards every explicit false, and
   * four of the seven settings default to true -- so the file says guided_first_boot: false and the
   * machine ships with it on. The recipe is the statement of what the machines are; a field the
   * machine does not honour is a lie in a file whose whole claim is that it IS the machine.
   */
  const off = desktopSettings({
    desktop: {
      guided_first_boot: false,
      taskbar_and_start_menu: false,
      explorer_like_file_manager: false,
      familiar_folder_names: false,
      double_click_to_open: false,
    },
  } as Recipe);
  assert.equal(off.guided_first_boot, false);
  assert.equal(off.taskbar_and_start_menu, false);
  assert.equal(off.explorer_like_file_manager, false);
  assert.equal(off.familiar_folder_names, false);
  assert.equal(off.double_click_to_open, false);
});

test('an explicit true still turns a false default on, so the override works in both directions', () => {
  const on = desktopSettings({ desktop: { can_reach_a_terminal: true, can_install_apps: true } } as Recipe);
  assert.equal(on.can_reach_a_terminal, true);
  assert.equal(on.can_install_apps, true);
});

test('a value that is not a boolean is ignored rather than coerced', () => {
  // The reason the check is `typeof value === 'boolean'` and not merely `value !== undefined`.
  const odd = desktopSettings({ desktop: { guided_first_boot: 'no' as unknown as boolean } } as Recipe);
  assert.equal(odd.guided_first_boot, true, "the string 'no' was read as false");
});

test('desktopSettings never returns the defaults object itself', () => {
  // A returned reference would let one recipe's settings edit the table every other recipe reads.
  const a = desktopSettings(nothingDeclared);
  a.can_reach_a_terminal = true;
  assert.equal(DESKTOP_DEFAULTS.can_reach_a_terminal, false, 'the defaults table is shared and mutable');
  assert.equal(desktopSettings(nothingDeclared).can_reach_a_terminal, false);
});

// -------------------------------------------------------------------------------------------------
// Why the defaults are worth a test of their own: what changes downstream when they move
// -------------------------------------------------------------------------------------------------

test('the terminal refusal depends on that default, so a fleet with no desktop block has no terminal', () => {
  /*
   * appRefusals asks `policy === 'open' && desktop.can_reach_a_terminal` before allowing a terminal
   * application. Flip the default and this refusal stops firing on every recipe that omits the
   * block -- which is most of them, because omitting it is what the schema encourages.
   */
  // Konsole is a member of the "developer tools" group the school removes, and installing something
  // you are also removing is a separate refusal. Drop the group, so the only thing left under test
  // is the terminal rule.
  const withKonsole = (d: Doc): void => {
    (d['apps'] as string[]).push('Konsole');
    const prune = d['prune'] as Record<string, unknown>;
    prune['also_remove'] = (prune['also_remove'] as string[]).filter((g) => g !== 'developer tools');
  };

  const silent = check(mutate(school(), (d) => { delete d['desktop']; withKonsole(d); d['policy'] = 'open'; }));
  assert.equal(silent.ok, false, 'a fleet that said nothing about terminals was given one');
  assert.match(said(silent), /is a terminal, and this fleet is open with can_reach_a_terminal left false/);

  // And stated out loud, it is allowed. The rule is "say it in the file", not "never".
  const stated = check(mutate(school(), (d) => {
    withKonsole(d);
    d['policy'] = 'open';
    d['desktop'] = { can_reach_a_terminal: true };
  }));
  assert.ok(stated.ok, said(stated));
});

test('the same for installing software: silence is no, and the explicit yes is honoured', () => {
  const withCentre = (d: Doc): void => { (d['apps'] as string[]).push('Software Centre'); };

  const silent = check(mutate(school(), (d) => { delete d['desktop']; withCentre(d); }));
  assert.equal(silent.ok, false, 'a fleet that said nothing was given a way to install software');

  const stated = check(mutate(school(), (d) => { withCentre(d); d['desktop'] = { can_install_apps: true }; }));
  assert.ok(stated.ok, said(stated));
});
