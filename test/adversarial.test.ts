/**
 * The adversarial inputs that got through, kept as tests so they stay refused.
 *
 * Every case here was ACCEPTED by the validator when an audit ran it. Each one is the verifier's
 * exact input, or the smallest edit to the committed school recipe that reproduces it. A test that
 * only asserts the rules we thought of cannot discover that the rules are short; these are the ones
 * somebody else thought of.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditScripts, scriptsUsedIn } from '../src/scripts.ts';
import { ROOT, check, mutate, said, school, type Doc } from './helpers.ts';

// -------------------------------------------------------------------------------------------------
// first_boot_message: the check failed OPEN on every script it did not have a name for
// -------------------------------------------------------------------------------------------------

/** The school fleet, switched to English-only fonts, with one first-boot sentence. */
function englishFleetSaying(message: string): Doc {
  return mutate(school(), (d) => {
    d['language'] = 'English (United States)';
    delete d['other_languages'];
    delete d['second_script'];
    delete d['switch_scripts_with'];
    d['keyboard'] = 'English (US)';
    d['first_boot_message'] = message;
  });
}

test('the control: an English fleet may greet in English, with ordinary punctuation', () => {
  const r = check(englishFleetSaying('Welcome — “this laptop” is yours… since 2026!'));
  assert.ok(r.ok, said(r));
});

for (const [id, message, script] of [
  ['c060', '你好，欢迎使用这台电脑', 'Han'],
  ['c061', '안녕하세요 환영합니다', 'Hangul'],
  ['c062', 'こんにちは、ようこそ', 'Japanese'],
  ['c063', 'Բարեւ ձեզ', 'Armenian'],
  ['c064', 'გამარჯობა', 'Georgian'],
  ['c065', 'សួស្តី', 'Khmer'],
  ['c066', 'Welcome \u{1F600}\u{1F3EB}', 'Emoji'],
] as const) {
  test(`${id}: a first-boot message in ${script} is refused on a fleet that cannot draw it`, () => {
    const r = check(englishFleetSaying(message));
    assert.equal(r.ok, false, `${id} was ACCEPTED — the screen of empty boxes this rule exists to prevent`);
    assert.match(said(r), /first_boot_message/);
    assert.match(said(r), new RegExp(script));
  });
}

test('a character in NO range this table names is still refused, by code point', () => {
  // Cuneiform. Nobody will write a school's welcome in it, which is exactly the point: the check
  // must not depend on somebody having thought of the script first.
  const r = check(englishFleetSaying('Welcome \u{12000}'));
  assert.equal(r.ok, false);
  assert.match(said(r), /U\+12000/);
  assert.match(said(r), /no name for/);
});

test('Vietnamese diacritics are Latin, so a Latin fleet can draw them', () => {
  // The old Latin range stopped at U+024F and so could not see Latin Extended Additional at all.
  // Under the old fail-open rule that was invisible; under the inverted rule it would be a false
  // refusal. Both directions matter.
  assert.deepEqual(auditScripts('Chào mừng', new Set(['Latin'])), { missing: [], unnamed: [] });
});

test('a script a chosen language DOES bring fonts for is still accepted', () => {
  const r = check(mutate(school(), (d) => { d['first_boot_message'] = 'नमस्कार'; }));
  assert.ok(r.ok, said(r));
});

// -------------------------------------------------------------------------------------------------
// other_languages: uniqueItems knew nothing about `language`, and the pointer used indexOf
// -------------------------------------------------------------------------------------------------

test('c071: other_languages may not repeat the primary language, and the pointer names the entry', () => {
  const r = check(mutate(school(), (d) => {
    d['other_languages'] = ['English (India)', d['language']];
  }));
  assert.equal(r.ok, false, 'the primary language was accepted a second time');
  assert.ok(r.refusals.some((x) => x.where === 'other_languages[1]'), said(r));
});

test('an unknown other_language is pointed at by its own index, not by indexOf', () => {
  const r = check(mutate(school(), (d) => {
    d['other_languages'] = ['English (India)', 'Klingon'];
  }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => x.where === 'other_languages[1]'), said(r));
  assert.ok(!r.refusals.some((x) => x.where === 'other_languages[-1]'), 'the pointer is -1 again');
});

// -------------------------------------------------------------------------------------------------
// The removal-floor ratchet: a property of HISTORY, which the working tree cannot see
// -------------------------------------------------------------------------------------------------

/** A throwaway git repository holding one fleet and the ratchet script. */
function ratchetRepo(): { dir: string; git: (...a: string[]) => string; run: (base?: string) => { status: number | null; out: string } } {
  const dir = mkdtempSync(join(tmpdir(), 'auros-ratchet-'));
  mkdirSync(join(dir, 'scripts'));
  cpSync(join(ROOT, 'scripts', 'floor-ratchet.mjs'), join(dir, 'scripts', 'floor-ratchet.mjs'));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  mkdirSync(join(dir, 'customers', 'lincoln'), { recursive: true });
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  // The base ref is a parameter, not a literal. It was 'main' in every call, which is the only ref
  // that resolves -- so the script's "a check that cannot run has not passed" branch had never been
  // reached by anything.
  const run = (base = 'main') => {
    const r = spawnSync(process.execPath, ['scripts/floor-ratchet.mjs', base], { cwd: dir, encoding: 'utf8' });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  return { dir, git, run };
}

const recipeWithFloor = (n: number) => `name: lincoln\nprune:\n  must_remove_at_least: ${n}\n`;

test('c091: lowering the floor AND granting yourself permission in the same diff is refused', () => {
  const { dir, git, run } = ratchetRepo();
  try {
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(1100));
    writeFileSync(join(dir, 'customers/lincoln/removal-floor.lock'), 'MUST_REMOVE_AT_LEAST=1100\n');
    git('add', '-A'); git('commit', '-qm', 'base');

    // The verifier's exact step 2, as one pull request.
    git('checkout', '-qb', 'pr');
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(1));
    writeFileSync(join(dir, 'customers/lincoln/removal-floor.lock'),
      'MUST_REMOVE_AT_LEAST=1100\nALLOW_LOWER_TO=1\nREASON=we felt like it\n');
    git('add', '-A'); git('commit', '-qm', 'lower it');

    const r = run();
    assert.equal(r.status, 1, `the same-diff self-permission was accepted:\n${r.out}`);
    assert.match(r.out, /same diff granting itself/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lowering the floor after the permission was merged separately is allowed, to exactly that value', () => {
  const { dir, git, run } = ratchetRepo();
  try {
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(1100));
    writeFileSync(join(dir, 'customers/lincoln/removal-floor.lock'),
      'MUST_REMOVE_AT_LEAST=1100\nALLOW_LOWER_TO=1050\nREASON=upstream folded two packages into one\n');
    git('add', '-A'); git('commit', '-qm', 'permission, merged on its own');

    git('checkout', '-qb', 'pr');
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(1050));
    git('add', '-A'); git('commit', '-qm', 'use it');
    assert.equal(run().status, 0, 'a properly separated lowering was refused');

    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(1));
    git('add', '-A'); git('commit', '-qm', 'and then some');
    const r = run();
    assert.equal(r.status, 1, 'a permission for 1050 was used to drop to 1');
    assert.match(r.out, /one number, not for a direction/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('raising the floor needs nothing at all', () => {
  const { dir, git, run } = ratchetRepo();
  try {
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(1100));
    writeFileSync(join(dir, 'customers/lincoln/removal-floor.lock'), 'MUST_REMOVE_AT_LEAST=1100\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    git('checkout', '-qb', 'pr');
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(1200));
    git('add', '-A'); git('commit', '-qm', 'raise');
    assert.equal(run().status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// -------------------------------------------------------------------------------------------------
// c100: the version discriminator, which parsed as 1 however it was spelled
// -------------------------------------------------------------------------------------------------

test('c100: `schema: 1.0` and other spellings of 1 are refused; plain `schema: 1` is not', async () => {
  const { nonCanonicalSchemaLiteral } = await import('../src/recipe.ts');
  for (const spelling of ['1.0', '0x1', '+1', '1e0', '"1"', "'1'", '01']) {
    assert.equal(nonCanonicalSchemaLiteral(`schema: ${spelling}\nname: x\n`), spelling.replace(/^["']|["']$/g, ''),
      `schema: ${spelling} was treated as canonical`);
  }
  assert.equal(nonCanonicalSchemaLiteral('schema: 1\nname: x\n'), null);
  assert.equal(nonCanonicalSchemaLiteral('name: x\n'), null, 'a missing field is the schema\'s refusal to give, not this one');
});

test('c100 through the CLI: exit 1, and the Python validator agrees', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auros-c100-'));
  try {
    const text = readFileSync(join(ROOT, 'customers', 'example-school', 'recipe.yaml'), 'utf8')
      .replace(/^schema: 1$/m, 'schema: 1.0')
      .replace(/^name: .*$/m, 'name: auros-c100');
    mkdirSync(join(dir, 'auros-c100'));
    const path = join(dir, 'auros-c100', 'recipe.yaml');
    writeFileSync(path, text);
    const ts = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'validate', path], { encoding: 'utf8' });
    assert.equal(ts.status, 1, ts.stdout + ts.stderr);
    assert.match(ts.stdout, /written as '1\.0'/);
    const py = spawnSync('python3', ['-c', 'import jsonschema, yaml'], { encoding: 'utf8' });
    if (py.status === 0) {
      const r = spawnSync('python3', [join(ROOT, 'schema', 'validate.py'), path], { encoding: 'utf8' });
      assert.notEqual(r.status, 0, `the Python validator accepted schema: 1.0\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /written as '1\.0'/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// -------------------------------------------------------------------------------------------------
// S01: Latin is a script, and the font-coverage check had never been asked about it
// -------------------------------------------------------------------------------------------------

/*
 * The check above is tested for Han, Hangul, Kana, Armenian, Georgian, Khmer, emoji and an unnamed
 * code point -- and never for the script the tests themselves are written in. isNeutral() calls
 * U+0020..U+0040 "punctuation every font carries", and widening that range by one nibble to 0x7E
 * makes every ASCII LETTER neutral too. Every test above still passes, because none of them is in
 * Latin; scriptsUsedIn('Hello') quietly returns [].
 *
 * A Marathi-medium school is the fleet where this matters, and it is the first customer profile in
 * the spec: Devanagari fonts, no Latin ones, and a welcome sentence somebody typed in English.
 */

test('Latin is a script like any other, and scriptsUsedIn says so', () => {
  assert.deepEqual(scriptsUsedIn('Hello'), ['Latin']);
  assert.deepEqual(scriptsUsedIn('Welcome to the library'), ['Latin']);
  // The other half of the same line: the characters that really are neutral must stay neutral, or
  // the fix for this is "call everything a script" and every message is refused.
  assert.deepEqual(scriptsUsedIn('0123456789 !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ — “…”'), []);
});

test('Latin is a script like any other: an English message on a Devanagari-only fleet is refused', () => {
  const marathiOnly = mutate(school(), (d) => {
    d['language'] = 'Marathi';           // catalogue/languages.tsv: scripts = Devanagari, fonts = Noto Devanagari
    delete d['other_languages'];          // ... so nothing on this fleet brings a Latin font
    d['first_boot_message'] = 'Welcome to the library';
  });
  const r = check(marathiOnly);
  assert.equal(r.ok, false, 'an English sentence was accepted on a fleet with no Latin fonts');
  assert.ok(r.refusals.some((x) => x.where === 'first_boot_message'), said(r));
  assert.match(said(r), /Latin/);
});

test('the control for that: the same fleet may greet in Marathi, and adding English fonts fixes it', () => {
  const inMarathi = mutate(school(), (d) => {
    d['language'] = 'Marathi';
    delete d['other_languages'];
    d['first_boot_message'] = 'नमस्कार! काही अडचण असल्यास शिक्षकांना सांगा.';
  });
  assert.ok(check(inMarathi).ok, said(check(inMarathi)));

  const andEnglish = mutate(school(), (d) => {
    d['language'] = 'Marathi';
    d['other_languages'] = ['English (India)'];
    d['first_boot_message'] = 'Welcome to the library';
  });
  assert.ok(check(andEnglish).ok, said(check(andEnglish)));
});

test('auditScripts agrees, directly, so the rule is pinned below the validator too', () => {
  assert.deepEqual(auditScripts('Welcome', new Set(['Devanagari'])), { missing: ['Latin'], unnamed: [] });
  assert.deepEqual(auditScripts('Welcome', new Set(['Latin'])), { missing: [], unnamed: [] });
});

// -------------------------------------------------------------------------------------------------
// The ratchet, in the half that gates merges: the three ways it could be made to pass
// -------------------------------------------------------------------------------------------------

/*
 * c091 above proves the ratchet catches the obvious attack. A mutation run on 2026-09-20 found four
 * changes to scripts/floor-ratchet.mjs that it does not catch, and every one of them turns the gate
 * green rather than red:
 *
 *   F01  `wanted >= atBase.published`    -> `>= atBase.published - 1`   one package per pull request
 *   F02  `allowLower === null || reason === ''` -> `&&`                 a permission slip with no reason
 *   F05  the "checked nothing" guard deleted                           a pass having examined zero fleets
 *   F06  the merge-base catch exits 0 instead of 2                     a shallow clone verifies nothing
 *
 * F05 and F06 are the same class as the SELinux kernel-argument check: a check that cannot run, or
 * that ran over nothing, is indistinguishable from one that passed -- unless something asserts it.
 */

test('a pull request that lowers the floor by one is refused', () => {
  const { dir, git, run } = ratchetRepo();
  try {
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(240));
    writeFileSync(join(dir, 'customers/lincoln/removal-floor.lock'), 'MUST_REMOVE_AT_LEAST=240\n');
    git('add', '-A'); git('commit', '-qm', 'base');

    git('checkout', '-qb', 'pr');
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(239));
    git('add', '-A'); git('commit', '-qm', 'just one, nobody will notice');

    const r = run();
    assert.equal(r.status, 1, `a one-package lowering passed CI:\n${r.out}`);
    assert.match(r.out, /lowers the removal floor from 240 to 239/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a merged permission slip with no REASON does not let CI pass', () => {
  // The base branch carries ALLOW_LOWER_TO and no REASON. The number alone is somebody's typing; the
  // reason is the half a reviewer reads, and it is what tells an upstream repackaging apart from a
  // build that quietly stopped removing things.
  const { dir, git, run } = ratchetRepo();
  try {
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(240));
    writeFileSync(join(dir, 'customers/lincoln/removal-floor.lock'), 'MUST_REMOVE_AT_LEAST=240\nALLOW_LOWER_TO=235\n');
    git('add', '-A'); git('commit', '-qm', 'permission with no reason, merged on its own');

    git('checkout', '-qb', 'pr');
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(235));
    git('add', '-A'); git('commit', '-qm', 'use it');

    const r = run();
    assert.equal(r.status, 1, `a permission slip with no reason let the floor fall:\n${r.out}`);
    assert.match(r.out, /the permission to do so is not on the base branch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('and the mirror image: a REASON with no number does not let CI pass either', () => {
  const { dir, git, run } = ratchetRepo();
  try {
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(240));
    writeFileSync(join(dir, 'customers/lincoln/removal-floor.lock'), 'MUST_REMOVE_AT_LEAST=240\nREASON=upstream folded two packages into one\n');
    git('add', '-A'); git('commit', '-qm', 'a reason and no number');

    git('checkout', '-qb', 'pr');
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(235));
    git('add', '-A'); git('commit', '-qm', 'use it');

    assert.equal(run().status, 1, 'a reason with no number let the floor fall');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('floor-ratchet refuses to report a pass when it checked nothing', () => {
  /*
   * The guard whose whole purpose is to prove the check ran. Deleted, the gate prints
   * "0 fleet(s), the floor only turned one way" and exits 0 -- which is what a green CI run looks
   * like when customers/ failed to check out, when the recipes moved, or when somebody renamed the
   * field. D34: a check that cannot fail is not a check, and this one exists to fail.
   */
  for (const [label, write] of [
    ['no recipes at all', () => {}],
    ['a recipe with no floor in it', (d: string) => writeFileSync(join(d, 'customers/lincoln/recipe.yaml'), 'name: lincoln\nprune:\n  keep_only_the_apps_above: true\n')],
    ['a floor that is not a number', (d: string) => writeFileSync(join(d, 'customers/lincoln/recipe.yaml'), 'name: lincoln\nprune:\n  must_remove_at_least: "240"\n')],
  ] as const) {
    const { dir, git, run } = ratchetRepo();
    try {
      write(dir);
      writeFileSync(join(dir, 'README.md'), 'a repository with nothing to ratchet\n');
      git('add', '-A'); git('commit', '-qm', 'base');
      git('checkout', '-qb', 'pr');
      writeFileSync(join(dir, 'README.md'), 'still nothing\n');
      git('add', '-A'); git('commit', '-qm', 'pr');

      const r = run();
      assert.equal(r.status, 2, `${label}: the gate reported a pass having examined zero fleets:\n${r.out}`);
      assert.match(r.out, /refusing to report a pass/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('the control for that: one fleet with a floor IS examined, and says so', () => {
  const { dir, git, run } = ratchetRepo();
  try {
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(240));
    writeFileSync(join(dir, 'customers/lincoln/removal-floor.lock'), 'MUST_REMOVE_AT_LEAST=240\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    git('checkout', '-qb', 'pr');
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(260));
    git('add', '-A'); git('commit', '-qm', 'raise');

    const r = run();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /1 fleet\(s\)/, 'the pass did not say how many fleets it looked at');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unresolvable base ref is exit 2, not a pass', () => {
  /*
   * Fail-open is the worst failure a gate has, because it is silent and it looks like success. A
   * shallow clone, a fork whose base branch was renamed, or an `actions/checkout` with
   * fetch-depth: 1 all produce a base ref that shares no history with HEAD -- and the script's own
   * comment says "a check that cannot run has not passed." Nothing asserted that sentence.
   */
  const { dir, git, run } = ratchetRepo();
  try {
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(240));
    writeFileSync(join(dir, 'customers/lincoln/removal-floor.lock'), 'MUST_REMOVE_AT_LEAST=240\n');
    git('add', '-A'); git('commit', '-qm', 'main');

    // A branch that shares no history at all: `git merge-base` has nothing to answer with.
    git('checkout', '-q', '--orphan', 'unrelated');
    writeFileSync(join(dir, 'unrelated.txt'), 'a history of its own\n');
    git('add', '-A'); git('commit', '-qm', 'orphan');
    git('checkout', '-q', 'main');

    const unrelated = run('unrelated');
    assert.equal(unrelated.status, 2, `a base ref sharing no history was reported as a pass:\n${unrelated.out}`);
    assert.match(unrelated.out, /cannot resolve a merge base/);
    assert.match(unrelated.out, /has not passed/);

    const absent = run('origin/no-such-branch');
    assert.equal(absent.status, 2, `a base ref that does not exist was reported as a pass:\n${absent.out}`);

    // The control: the ref that does resolve still exits 0, so exit 2 above is about the ref.
    assert.equal(run('main').status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no base ref at all is exit 2, and the message says why', () => {
  const { dir, git } = ratchetRepo();
  try {
    writeFileSync(join(dir, 'customers/lincoln/recipe.yaml'), recipeWithFloor(240));
    git('add', '-A'); git('commit', '-qm', 'main');
    const r = spawnSync(process.execPath, ['scripts/floor-ratchet.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no base ref given/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
