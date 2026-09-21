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
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
      assert.match((err as Error).message, /Changing a recipe/);
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

/*
 * The three tests above are the ones somebody wrote while looking at the happy path. A mutation run
 * on 2026-09-20 showed what they leave open: each of the following changes to src/validate.ts could
 * be made with all 433 tests still green.
 *
 *   V30  `< published`                        -> `< published - 1`
 *   V31  `&& reason !== ''` deleted
 *   V32  `allowLower === wanted`              -> `allowLower <= wanted`
 *
 * All three are the same shape -- the rule is tested in the direction it is usually used, and not in
 * the direction somebody would push it. The refusal text in validate.ts says an alarm you can turn
 * down one point at a time is not an alarm; V30 is that sentence, unopposed. See
 * scripts/prove-red.mjs, which reintroduces each one and requires the test below it to go red.
 */

test('lowering the floor by ONE is still lowering it', () => {
  // The classic: no single pull request looks wrong, and after forty of them the floor is zero.
  const fixture = fleetWithLock('MUST_REMOVE_AT_LEAST=240\n', 239);
  try {
    const result = validateDocument(toolchain(), fixture.doc, fixture.path);
    assert.equal(result.ok, false, 'the floor was lowered from 240 to 239 with no permission at all');
    assert.match(said(result), /lowers the removal floor from 240 to 239/);
    assert.ok(
      result.refusals.some((r) => r.where === 'prune.must_remove_at_least'),
      `the refusal did not point at the field that moved:\n${said(result)}`,
    );
  } finally {
    fixture.cleanup();
  }
});

test('the control for that: holding at 240 and rising to 241 are both fine', () => {
  // Without this, "lowering by one is refused" could be passing because the floor rule refuses
  // everything, which is a different bug wearing the same green tick.
  for (const floor of [240, 241]) {
    const fixture = fleetWithLock('MUST_REMOVE_AT_LEAST=240\n', floor);
    try {
      const result = validateDocument(toolchain(), fixture.doc, fixture.path);
      assert.ok(!said(result).includes('lowers the removal floor'), `a floor of ${floor} was treated as a lowering:\n${said(result)}`);
    } finally {
      fixture.cleanup();
    }
  }
});

test('a lock that grants permission but states no reason does not grant permission', () => {
  /*
   * ALLOW_LOWER_TO on its own is a number somebody typed. The REASON is the half a reviewer reads,
   * and it is the half that makes the next person able to tell an upstream repackaging (a real
   * reason for the floor to fall) from a build that quietly stopped removing things (the event this
   * alarm exists for). A permission slip with no reason on it is not a permission slip.
   */
  for (const [label, lock] of [
    ['no REASON line at all', 'MUST_REMOVE_AT_LEAST=240\nALLOW_LOWER_TO=235\n'],
    ['a REASON line that is only whitespace', 'MUST_REMOVE_AT_LEAST=240\nALLOW_LOWER_TO=235\nREASON=    \n'],
  ] as const) {
    const fixture = fleetWithLock(lock, 235);
    try {
      const result = validateDocument(toolchain(), fixture.doc, fixture.path);
      assert.equal(result.ok, false, `${label}: the floor fell from 240 to 235 with no stated reason`);
      assert.match(said(result), /lowers the removal floor from 240 to 235/);
      assert.ok(
        result.refusals.some((r) => r.where === 'prune.must_remove_at_least'),
        `${label}: the refusal did not point at prune.must_remove_at_least:\n${said(result)}`,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('a lock permitting 235 does not permit 238', () => {
  // A permission slip is for one number, not for a direction. scripts/floor-ratchet.mjs says exactly
  // that and has a test for it; this is the same rule in the half that runs in a working tree, and
  // until now only the half that runs in CI was held to it.
  const lock = 'MUST_REMOVE_AT_LEAST=240\nALLOW_LOWER_TO=235\nREASON=upstream merged two font packages\n';
  for (const floor of [236, 238, 239]) {
    const fixture = fleetWithLock(lock, floor);
    try {
      const result = validateDocument(toolchain(), fixture.doc, fixture.path);
      assert.equal(result.ok, false, `a permission slip for 235 was used to lower the floor to ${floor}`);
      assert.match(said(result), new RegExp(`lowers the removal floor from 240 to ${floor}`));
    } finally {
      fixture.cleanup();
    }
  }

  // And the control: the number it actually names still works.
  const exact = fleetWithLock(lock, 235);
  try {
    const result = validateDocument(toolchain(), exact.doc, exact.path);
    assert.ok(!said(result).includes('lowers the removal floor'), said(result));
  } finally {
    exact.cleanup();
  }
});

// -------------------------------------------------------------------------------------------------
// auros.config.json: a broken namespace file, and a $AUROS_CONFIG that points at nothing
// -------------------------------------------------------------------------------------------------

/** A config file with one key replaced, written somewhere $AUROS_CONFIG can point at. */
function configFixture(edit: (raw: Record<string, unknown>) => void): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'auros-config-'));
  const raw = JSON.parse(readFileSync(loadConfig(ROOT).configPath, 'utf8')) as Record<string, unknown>;
  edit(raw);
  const path = join(dir, 'auros.config.json');
  writeFileSync(path, JSON.stringify(raw, null, 2));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a config with an empty org is refused, not silently used', () => {
  /*
   * requireString checks BOTH that the value is a string and that it is not empty, and only the
   * first half was tested. An empty org produces an image name like `ghcr.io//auros-example-school`
   * and a FROM line with an empty component -- a name that looks almost right in a log, resolves
   * nowhere, and is derived rather than written down, so there is no literal for anybody to grep.
   */
  for (const key of ['org', 'product', 'registry', 'baseImage', 'baseTag', 'arch']) {
    const fixture = configFixture((raw) => { raw[key] = ''; });
    try {
      assert.throws(
        () => loadConfig(join(fixture.path, '..')),
        (err: unknown) => {
          assert.match((err as Error).message, new RegExp(`'${key}' is missing or is not a string`), `an empty ${key} was accepted`);
          return true;
        },
        `an empty ${key} was accepted`,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('the control: the same fixture with every key present loads', () => {
  const fixture = configFixture(() => {});
  try {
    const config = loadConfig(join(fixture.path, '..'));
    assert.ok(config.org.length > 0);
    assert.equal(config.configPath, fixture.path);
  } finally {
    fixture.cleanup();
  }
});

test('$AUROS_CONFIG pointing at a file that does not exist is an error, never a fallback', () => {
  /*
   * The refusal text promises this in words: "Looked for it in $AUROS_CONFIG, in .auros-meta/, and
   * in every directory above ...". A typo in that variable must not silently resolve to some OTHER
   * auros.config.json found by walking upwards -- the build would then be namespaced from a file
   * the operator did not name, and everything downstream would look normal.
   *
   * Run from inside this repository ON PURPOSE, because a discoverable config DOES exist above it.
   * That is the whole point: the fallback is available, and must not be taken.
   */
  // `compile`, not `validate`: validate never reads the namespace file, so pointing the variable at
  // nothing would exit 0 there for a reason that has nothing to do with this rule. The verb under
  // test has to be one that actually loads the config, or the test is green for free.
  const discoverable = loadConfig(ROOT).configPath;
  assert.ok(existsSync(discoverable), 'this test needs a config that a directory search WOULD find');

  const missing = join(tmpdir(), 'auros-no-such-config', 'auros.config.json');
  const r = spawnSync(process.execPath, [CLI, 'compile', SCHOOL_PATH], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, AUROS_CONFIG: missing },
  });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 2, `a $AUROS_CONFIG that points at nothing did not stop the tool:\n${out}`);
  assert.match(out, /AUROS_CONFIG/, 'the message did not name the variable that was wrong');
  assert.match(out, /which does not exist/);
  assert.doesNotMatch(r.stdout, /^FROM /m, 'it fell back to another config and compiled a Containerfile anyway');

  // Two controls, because exit 2 on its own could mean compile is broken for everybody.
  const withVar = spawnSync(process.execPath, [CLI, 'compile', SCHOOL_PATH], {
    encoding: 'utf8', cwd: ROOT, env: { ...process.env, AUROS_CONFIG: discoverable },
  });
  assert.equal(withVar.status, 0, `the variable pointing at a real file failed:\n${withVar.stderr}`);

  const withoutVar = { ...process.env };
  delete withoutVar['AUROS_CONFIG'];
  const found = spawnSync(process.execPath, [CLI, 'compile', SCHOOL_PATH], { encoding: 'utf8', cwd: ROOT, env: withoutVar });
  assert.equal(found.status, 0, `the directory search failed, so the fallback under test does not exist:\n${found.stderr}`);
});
