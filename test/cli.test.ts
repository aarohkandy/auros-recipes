/**
 * The command line, the namespace, and the ratchet.
 *
 * Exit codes matter more here than usual, because CI reads them: 0 acceptable, 1 refused, 2 the tool
 * could not run. Collapsing 1 and 2 would let a broken toolchain look like a clean run, which is the
 * "a step that cannot fail is not a check" failure in its most expensive form -- see DECISIONS.md
 * D19, where exactly that cost us a build that reported success and produced no image.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseReference, imageNameFor, loadConfig, findConfigPath, ConfigNotFound } from '../src/config.ts';
import { validateDocument } from '../src/validate.ts';
import { ROOT, SCHOOL_PATH, school, toolchain, said, type Doc } from './helpers.ts';

const CLI = join(ROOT, 'src', 'cli.ts');

function run(args: string[], cwd = ROOT) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd });
}

// -------------------------------------------------------------------------------------------------
// Exit codes
// -------------------------------------------------------------------------------------------------

test('validate exits 0 when every recipe is acceptable', () => {
  const r = run(['validate', '--all']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /3 recipes accepted/);
});

test('validate exits 1 on a refused recipe, and 2 when it cannot read one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auros-cli-'));
  const bad = join(dir, 'recipe.yaml');
  writeFileSync(bad, 'name: nope\nthis is: not a recipe\n');
  assert.equal(run(['validate', bad]).status, 1);
  assert.equal(run(['validate', join(dir, 'absent.yaml')]).status, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('a file that is not YAML at all is a VERDICT about the file, not a broken toolchain', () => {
  // Exit 1, not 2, and the distinction is the whole point of having two codes. Unreadable YAML is a
  // fact about a stranger's pull request; exit 2 is reserved for failures that are genuinely ours --
  // a missing schema, an unreadable catalogue, no auros.config.json -- because that is the code an
  // operator triaging a red build uses to decide whether to look at the file or at us.
  const dir = mkdtempSync(join(tmpdir(), 'auros-cli-'));
  const bad = join(dir, 'recipe.yaml');
  writeFileSync(bad, 'apps: [unclosed\n  - broken: : :\n');
  const r = run(['validate', bad]);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match((r.stdout + r.stderr).replace(/\s+/g, " "), /is not valid YAML/);
  rmSync(dir, { recursive: true, force: true });
});

test('a duplicate key is a verdict too, and a missing file is still ours', () => {
  // The two sides of the line above, asserted together so that collapsing them shows up here.
  const dir = mkdtempSync(join(tmpdir(), 'auros-cli-'));
  const dup = join(dir, 'recipe.yaml');
  writeFileSync(dup, 'schema: 1\nname: a\nname: b\n');
  assert.equal(run(['validate', dup]).status, 1, 'a duplicate key was reported as a broken toolchain');
  assert.equal(run(['validate', join(dir, 'absent.yaml')]).status, 2, 'a path CI got wrong was reported as a verdict about a recipe');
  rmSync(dir, { recursive: true, force: true });
});

test('compile refuses to run on a recipe validate would refuse', () => {
  // The hole every rule in this repository would otherwise fall through: a compiler that compiles
  // what the validator rejects.
  const dir = mkdtempSync(join(tmpdir(), 'auros-cli-'));
  const path = join(dir, 'recipe.yaml');
  const doc = school();
  doc['from'] = 'ghcr.io/somebody/else:latest';
  writeFileSync(path, JSON.stringify(doc));
  const r = run(['compile', path]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '', 'a refused recipe still produced a Containerfile on stdout');
  assert.match(r.stderr, /compile does not run on a recipe validate would not accept/);
  rmSync(dir, { recursive: true, force: true });
});

test('explain refuses the same way', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auros-cli-'));
  const path = join(dir, 'recipe.yaml');
  const doc = school();
  (doc['prune'] as Doc)['must_remove_at_least'] = 0;
  writeFileSync(path, JSON.stringify(doc));
  const r = run(['explain', path]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------------------------------------------
// There is no flag that weakens anything
// -------------------------------------------------------------------------------------------------

test('there is no --force, --skip-checks or --allow-untested', () => {
  for (const flag of ['--force', '--skip-checks', '--skip-tests', '--allow-untested', '--no-verify', '--unsigned']) {
    const r = run(['validate', '--all', flag]);
    assert.equal(r.status, 2, `${flag} was accepted`);
    assert.match(r.stderr, /There is no flag that skips a check/);
  }
});

test('the help text says so out loud, so nobody goes looking', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no flag that skips a check, forces a publish, or accepts an untested image/);
});

test('compile writes a Containerfile and explain writes prose', () => {
  const compiled = run(['compile', SCHOOL_PATH]);
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.match(compiled.stdout, /^# ={20,}/);
  assert.match(compiled.stdout, /^FROM /m);

  const explained = run(['explain', SCHOOL_PATH]);
  assert.equal(explained.status, 0, explained.stderr);
  assert.match(explained.stdout, /WHAT GETS DELETED/);
  assert.doesNotMatch(explained.stdout, /^FROM /m, 'explain is for a person, not a build');
});

// -------------------------------------------------------------------------------------------------
// The namespace lives in exactly one file
// -------------------------------------------------------------------------------------------------

test('every image name is derived from auros.config.json, never written down', () => {
  const config = loadConfig(ROOT);
  assert.equal(imageNameFor(config, 'example-school'), `${config.registry}/${config.org}/${config.product}-example-school`);
  assert.equal(baseReference(config, undefined), `${config.baseImage}:${config.baseTag}`);
  assert.equal(baseReference(config, 'sha256:abc'), `${config.baseImage}@sha256:abc`);
});

test('no source file hardcodes the organisation or the product name', () => {
  // DECISIONS.md D1: renaming the company is a change to one file plus a registry re-tag, and
  // nothing else. A literal anywhere in src/ turns that into a grep across five repositories.
  const config = loadConfig(ROOT);
  const grep = spawnSync('grep', ['-rn', '-e', config.org, '-e', `'${config.product}-base'`, join(ROOT, 'src')], { encoding: 'utf8' });
  assert.equal(grep.stdout.trim(), '', `the namespace is written down in src/:\n${grep.stdout}`);
});

test('a missing namespace file is an error in words, not a FROM line reading undefined', () => {
  const empty = mkdtempSync(join(tmpdir(), 'auros-noconfig-'));
  assert.throws(
    () => findConfigPath(empty),
    (err: unknown) => {
      assert.ok(err instanceof ConfigNotFound);
      assert.match((err as Error).message, /will not guess at a namespace/);
      assert.match((err as Error).message, /Rebuilding without us/);
      return true;
    },
  );
  rmSync(empty, { recursive: true, force: true });
});

// -------------------------------------------------------------------------------------------------
// The ratchet on must_remove_at_least
// -------------------------------------------------------------------------------------------------

function fleetWithLock(lock: string, floor: number): { path: string; doc: Doc; cleanup: () => void } {
  // A real directory with a real file beside the recipe, because the ratchet reads that file and a
  // fixture that faked it would be testing the fake.
  //
  // NOT under customers/, though it used to be. `node --test` runs these files in parallel, and
  // golden.test.ts asserts that customers/ holds exactly the three committed examples while
  // cli.test.ts runs `validate --all` over the same directory -- so a fixture living there for a few
  // milliseconds fails a test in another file, intermittently, with an error about a recipe nobody
  // wrote. The only cross-file rule that needs a real location is the one checking a recipe's name
  // against its folder, and naming the temporary folder satisfies it.
  const root = mkdtempSync(join(tmpdir(), 'auros-ratchet-'));
  const dir = join(root, 'ratchet-fixture');
  mkdirSync(dir, { recursive: true });
  const doc = school();
  doc['name'] = 'ratchet-fixture';
  (doc['prune'] as Doc)['must_remove_at_least'] = floor;
  writeFileSync(join(dir, 'recipe.yaml'), JSON.stringify(doc));
  writeFileSync(join(dir, 'removal-floor.lock'), lock);
  return { path: join(dir, 'recipe.yaml'), doc, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the removal floor may rise freely', () => {
  const fixture = fleetWithLock('MUST_REMOVE_AT_LEAST=240\n', 300);
  try {
    const result = validateDocument(toolchain(), fixture.doc, fixture.path);
    assert.ok(!said(result).includes('lowers the removal floor'), said(result));
  } finally {
    fixture.cleanup();
  }
});

test('lowering it without a reason and a second approval is refused', () => {
  const fixture = fleetWithLock('MUST_REMOVE_AT_LEAST=240\n', 100);
  try {
    const result = validateDocument(toolchain(), fixture.doc, fixture.path);
    assert.equal(result.ok, false);
    assert.match(said(result), /lowers the removal floor from 240 to 100/);
    assert.match(said(result), /alarm you can turn down one point at a time is not an alarm/);
  } finally {
    fixture.cleanup();
  }
});

test('lowering it with a stated reason and an explicit allowance is accepted', () => {
  const fixture = fleetWithLock(
    'MUST_REMOVE_AT_LEAST=240\nALLOW_LOWER_TO=100\nREASON=upstream split the KDE games metapackage, so 140 of those packages no longer exist\n',
    100,
  );
  try {
    const result = validateDocument(toolchain(), fixture.doc, fixture.path);
    assert.ok(!said(result).includes('lowers the removal floor'), said(result));
  } finally {
    fixture.cleanup();
  }
});
