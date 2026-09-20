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
import { auditScripts } from '../src/scripts.ts';
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
function ratchetRepo(): { dir: string; git: (...a: string[]) => string; run: () => { status: number | null; out: string } } {
  const dir = mkdtempSync(join(tmpdir(), 'auros-ratchet-'));
  mkdirSync(join(dir, 'scripts'));
  cpSync(join(ROOT, 'scripts', 'floor-ratchet.mjs'), join(dir, 'scripts', 'floor-ratchet.mjs'));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  mkdirSync(join(dir, 'customers', 'lincoln'), { recursive: true });
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const run = () => {
    const r = spawnSync(process.execPath, ['scripts/floor-ratchet.mjs', 'main'], { cwd: dir, encoding: 'utf8' });
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
