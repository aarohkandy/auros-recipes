#!/usr/bin/env node
/**
 * Watch test/differ.test.ts fail, on purpose, seven times.
 *
 * D34: "a test file that only demonstrates the happy path looks identical to one that works." The
 * differ suite makes claims about what three customer images have in common and what separates them,
 * and a green run of it proves nothing unless somebody has seen it disagree with wrong code.
 *
 * Each mutation below reintroduces ONE specific bug into a scratch copy of this repository and
 * requires the suite to go red AND to name the thing that is wrong. A mutation that reddens the
 * suite for an unrelated reason is scored as a MISS, not a catch, because a suite that fails for the
 * wrong reason will not tell the next person what broke.
 *
 * Every mutation here is a bug that either existed in this repository today or is one edit away:
 *
 *   M1  the compiler stops stamping hardware.also_test on the image      (the original bug)
 *   M2  the updates.install_between disclosure disappears                (the original bug)
 *   M3  prune.also_keep is accepted again with nothing to keep from      (the original bug)
 *   M4  the compiler derives SOURCE_DATE_EPOCH from something not in the recipe
 *   M5  the keep-only sweep silently stops when a group list is present
 *   M6  the kiosk configuration file stops being written, so kiosk.* goes inert
 *   M7  a recipe starts keeping something another recipe removes, breaking the nesting chain
 *
 * Usage:  node scripts/prove-red-differ.mjs          (exit 0 = every mutation was caught)
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A mutation is a file, a literal string to find, what to put there, and what the suite must say. */
const MUTATIONS = [
  {
    id: 'M1',
    what: 'the compiler stops stamping hardware.also_test on the image',
    file: 'src/compile.ts',
    find: '[`${config.product}.test-profiles`, testProfiles(recipe).join(\',\')],',
    replace: '[`${config.product}.test-profiles`, ALWAYS_TESTED_PROFILE],',
    expect: 'hardware.also_test reaches the image',
  },
  {
    id: 'M2',
    what: 'the updates.install_between disclosure disappears',
    file: 'src/validate.ts',
    find: 'if (recipe.updates?.install_between) {',
    replace: 'if (false as boolean) {',
    expect: 'are accepted by the validator when swapped',
  },
  {
    id: 'M3',
    what: 'prune.also_keep is accepted again with nothing to keep from',
    file: 'src/validate.ts',
    find: 'if (recipe.prune.keep_only_the_apps_above === false && keep.size > 0) {',
    replace: 'if (false as boolean) {',
    expect: 'also_keep with nothing to keep from was accepted',
  },
  {
    id: 'M4',
    what: 'the compiler derives SOURCE_DATE_EPOCH from something that is not in the recipe',
    file: 'src/compile.ts',
    find: 'const epoch = options.sourceDateEpoch ?? resolveSourceDateEpoch(recipe);',
    replace: 'const epoch = options.sourceDateEpoch ?? recipe.name.length * 1000;',
    expect: 'are not accounted for by any field',
  },
  {
    id: 'M5',
    what: 'the keep-only sweep silently stops when a group list is present',
    file: 'src/prune.ts',
    find: '  if (recipe.prune.keep_only_the_apps_above) {',
    replace: '  if (recipe.prune.keep_only_the_apps_above && !(recipe.prune.also_remove ?? []).length) {',
    expect: 'emptying also_remove changed the removal set',
  },
  {
    id: 'M6',
    what: 'the kiosk configuration file stops being written, so every kiosk.* field goes inert',
    file: 'src/compile.ts',
    find: "if (recipe.policy === 'kiosk' && recipe.kiosk)",
    replace: 'if ((false as boolean) && recipe.kiosk)',
    expect: 'kiosk.printing',
  },
  {
    id: 'M7',
    what: 'the kiosk starts keeping something the school removes, breaking the nesting chain',
    file: 'customers/example-kiosk/recipe.yaml',
    find: '  also_keep: [printing]',
    replace: '  also_keep: [printing, scanning]',
    expect: 'the school now removes something the kiosk does not',
  },
];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'auros-differ-red-'));
  for (const entry of ['src', 'test', 'schema', 'catalogue', 'customers', 'package.json', 'tsconfig.json', 'tsconfig.test.json']) {
    cpSync(join(REPO, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
  // src/config.ts looks in .auros-meta/ before walking up, and validate.ts's compatPath does the
  // same for hardware/compat.tsv. Feeding the scratch copy through that documented path is better
  // than reproducing the meta repo's directory shape somewhere in /tmp and hoping it matches.
  mkdirSync(join(dir, '.auros-meta'), { recursive: true });
  cpSync(join(REPO, '..', 'auros.config.json'), join(dir, '.auros-meta', 'auros.config.json'));
  cpSync(join(REPO, '..', 'hardware'), join(dir, '.auros-meta', 'hardware'), { recursive: true });
  return dir;
}

let caught = 0;
const missed = [];
console.log(`proving test/differ.test.ts can go red — ${MUTATIONS.length} mutations\n`);

for (const m of MUTATIONS) {
  const dir = scratch();
  try {
    const path = join(dir, m.file);
    const before = readFileSync(path, 'utf8');
    if (!before.includes(m.find)) {
      missed.push(`${m.id}  the mutation no longer applies: ${m.file} does not contain the text it patches.\n      looking for: ${m.find}`);
      continue;
    }
    if (before.split(m.find).length !== 2) {
      missed.push(`${m.id}  the text it patches appears more than once in ${m.file}; the mutation is ambiguous`);
      continue;
    }
    writeFileSync(path, before.replace(m.find, m.replace));

    const run = spawnSync(process.execPath, ['--test', 'test/differ.test.ts'], { cwd: dir, encoding: 'utf8' });
    const out = `${run.stdout}${run.stderr}`;
    if (run.status === 0) {
      missed.push(`${m.id}  NOT CAUGHT — the suite stayed green with this bug in it: ${m.what}`);
      continue;
    }
    if (!out.includes(m.expect)) {
      const why = out.split('\n').filter((l) => l.startsWith('not ok')).slice(0, 3).join('\n        ');
      missed.push(`${m.id}  red for the WRONG REASON. Expected the suite to say: ${m.expect}\n      it said:\n        ${why}`);
      continue;
    }
    caught++;
    console.log(`  ${m.id}  caught — ${m.what}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\ncaught ${caught} of ${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error('\nMISSED:');
  for (const line of missed) console.error(`  ${line}`);
  process.exit(1);
}
