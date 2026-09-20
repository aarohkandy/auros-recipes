/**
 * The committed Containerfiles, and the round trip from a recipe to the image it names.
 *
 * `customers/<fleet>/Containerfile` is generated and committed (DECISIONS.md D28), and a generated
 * file committed to a repository drifts. The guard is that CI regenerates it and fails on any diff,
 * and this file is that guard running locally, which matters for two different reasons at once:
 *
 *   1. A committed artefact that no longer matches its source is a worse lie than no artefact,
 *      because the whole reason it is committed is so that a customer can build from it without
 *      any of our tooling.
 *
 *   2. It makes every change to the compiler show up as a DIFF A HUMAN READS. That is the actual
 *      value here. A unit test tells you a property still holds; a golden file tells you what
 *      forty-seven thousand bytes of build instructions now say that they did not say before, which
 *      is the only way an unintended change gets noticed rather than approved.
 *
 * The second half is the round trip: every committed recipe validates, compiles, and its
 * Containerfile's FROM resolves to the digest the build was given. No recipe has been built yet, so
 * no digest exists -- which is exactly the state in which "the FROM matches the pin" passes for the
 * wrong reason forever. Each of those tests therefore has its mirror image beside it: one asserts the
 * unpinned state we are in, one drives the pinned path through a temporary fleet, and one plants
 * every lockfile an author might reach for inside customers/ and asserts that not one of them moves
 * a single byte of the output. That last one is a rule about a threat rather than about a format --
 * customers/ is the inside of a pull request from a stranger.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, resolveBaseDigest } from '../src/compile.ts';
import { baseReference, loadConfig } from '../src/config.ts';
import { validateDocument } from '../src/validate.ts';
import { loadRecipe } from '../src/recipe.ts';
import { ROOT, toolchain, type Doc } from './helpers.ts';

const config = loadConfig(ROOT);
const CUSTOMERS = join(ROOT, 'customers');

/** A literal string, safe to drop into a RegExp. */
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every fleet actually committed, read off disk rather than listed here, so a new one is covered. */
function fleets(): string[] {
  return readdirSync(CUSTOMERS)
    .sort()
    .filter((name) => existsSync(join(CUSTOMERS, name, 'recipe.yaml')));
}

function compileFleet(name: string): { text: string; digest: string | undefined; notes: ReadonlyArray<string> } {
  const path = join(CUSTOMERS, name, 'recipe.yaml');
  const loaded = loadRecipe(path);
  const result = validateDocument(toolchain(), loaded.doc, loaded.path);
  assert.ok(
    result.ok,
    `customers/${name}/recipe.yaml is committed and does not validate:\n` +
      result.refusals.map((r) => `  ${r.where}: ${r.what}`).join('\n'),
  );
  const digest = resolveBaseDigest({});
  return {
    text: compile({
      recipe: result.recipe!,
      recipePath: path,
      plan: result.plan!,
      fonts: result.fonts ?? [],
      config,
      catalogue: toolchain().catalogue,
      baseDigest: digest,
      notes: result.notes,
    }),
    digest,
    notes: result.notes,
  };
}

/**
 * The same thing for a fixture that lives OUTSIDE customers/.
 *
 * Fixtures must not be created under customers/, even temporarily. `node --test` runs these files in
 * parallel and cli.test.ts spawns `validate --all`, which lists that directory -- so a fixture there
 * appears in another test's run and fails it, intermittently, with an error about a recipe nobody
 * wrote. Nothing in these fixtures needs to be there: the only cross-file rule that cares is the one
 * checking a recipe's name against its folder, which is satisfied by naming the temporary folder.
 */
function compileAt(recipePath: string, env: NodeJS.ProcessEnv = {}): string {
  const loaded = loadRecipe(recipePath);
  const result = validateDocument(toolchain(), loaded.doc, loaded.path);
  assert.ok(
    result.ok,
    `${recipePath} does not validate:\n` + result.refusals.map((r) => `  ${r.where}: ${r.what}`).join('\n'),
  );
  return compile({
    recipe: result.recipe!,
    recipePath,
    plan: result.plan!,
    fonts: result.fonts ?? [],
    config,
    catalogue: toolchain().catalogue,
    baseDigest: resolveBaseDigest(env),
    notes: result.notes,
  });
}

/** A fixture folder named after the recipe it holds, outside customers/. */
function fixture(name: string): { dir: string; recipePath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'auros-golden-'));
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const source = loadRecipe(join(CUSTOMERS, 'example-workstation', 'recipe.yaml')).doc as Doc;
  source['name'] = name;
  const recipePath = join(dir, 'recipe.yaml');
  writeFileSync(recipePath, JSON.stringify(source));
  return { dir, recipePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The first line that differs, quoted, because a 47,000-byte diff is not a test failure message. */
function firstDifference(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n    committed: ${JSON.stringify(a[i] ?? '(end of file)')}\n    compiled:  ${JSON.stringify(b[i] ?? '(end of file)')}`;
    }
  }
  return 'the files differ only in length';
}

// -------------------------------------------------------------------------------------------------
// The golden files
// -------------------------------------------------------------------------------------------------

test('there are three committed example recipes, and this test knows if one disappears', () => {
  // Spec section 6B's exit condition names three visibly different recipes. If somebody deletes one,
  // every "for each fleet" test below quietly covers less, and nothing says so.
  assert.deepEqual(fleets(), ['example-kiosk', 'example-school', 'example-workstation']);
});

for (const name of ['example-kiosk', 'example-school', 'example-workstation']) {
  test(`${name}: the committed Containerfile is exactly what the compiler produces`, () => {
    const golden = join(CUSTOMERS, name, 'Containerfile');
    assert.ok(existsSync(golden), `customers/${name}/Containerfile is not committed, and the rebuild instructions need it`);
    const committed = readFileSync(golden, 'utf8');
    const { text } = compileFleet(name);
    assert.equal(
      text,
      committed,
      `customers/${name}/Containerfile has drifted from customers/${name}/recipe.yaml.\n` +
        `  ${firstDifference(committed, text)}\n\n` +
        '  If the compiler changed on purpose, regenerate it and READ THE DIFF -- that diff is a\n' +
        '  plain record of what changed on somebody\'s machines, and it is the only place an\n' +
        '  unintended change to the compiler is visible before it ships:\n' +
        `      node dist/cli.js compile customers/${name}/recipe.yaml -o customers/${name}/Containerfile`,
    );
  });
}

test('a committed Containerfile carries everything it needs, so the rebuild instruction is true', () => {
  // The claim the README makes about these files is that `podman build -f Containerfile` works with
  // no build context. Anything that reads from the context breaks that, silently, for the one person
  // who ever tries it -- and by then we are not around to ask.
  for (const name of fleets()) {
    const text = readFileSync(join(CUSTOMERS, name, 'Containerfile'), 'utf8');
    for (const line of text.split('\n')) {
      assert.doesNotMatch(line, /^COPY\s/, `${name}: a COPY needs a build context`);
      assert.doesNotMatch(line, /^ADD\s/, `${name}: an ADD needs a build context or the network`);
    }
    assert.doesNotMatch(text, /--mount=type=(bind|secret|ssh)/, `${name}: a mount needs something outside the file`);
    assert.doesNotMatch(text, /\bcurl\b|\bwget\b|\bgit clone\b/, `${name}: the build reaches the network for something`);
  }
});

test('every committed Containerfile is generated and says so in its first lines', () => {
  for (const name of fleets()) {
    const text = readFileSync(join(CUSTOMERS, name, 'Containerfile'), 'utf8');
    const head = text.split('\n').slice(0, 6).join('\n');
    assert.match(head, /GENERATED FILE\. DO NOT EDIT\./, `${name}: nothing at the top of the file says it is generated`);
    assert.match(text, new RegExp(`customers/${name}/recipe\\.yaml`), `${name}: the file does not name the recipe it came from`);
  }
});

test('the golden files are large enough to be the whole build, not a stub', () => {
  // A regeneration bug that emitted a header and stopped would pass every `assert.match` above.
  for (const name of fleets()) {
    const text = readFileSync(join(CUSTOMERS, name, 'Containerfile'), 'utf8');
    assert.ok(text.length > 10_000, `${name}: the committed Containerfile is only ${text.length} bytes`);
    for (const required of [/^FROM \$\{BASE\}$/m, /^RUN \/usr\/libexec\/auros\/auros-prune$/m, /^RUN bootc container lint$/m, /^LABEL \\$/m]) {
      assert.match(text, required, `${name}: the committed file is missing ${required}`);
    }
  }
});

// -------------------------------------------------------------------------------------------------
// The round trip
// -------------------------------------------------------------------------------------------------

test('every committed recipe validates, compiles, and names the base from the namespace file', () => {
  for (const name of fleets()) {
    const { text, digest } = compileFleet(name);
    const expected = baseReference(config, digest);
    const argLine = text.split('\n').find((l) => l.startsWith('ARG BASE='));
    assert.ok(argLine, `${name}: the compiled file has no base at all`);
    assert.equal(argLine, `ARG BASE=${expected}`, `${name}: the base is not the one auros.config.json names`);
    assert.equal(text.split('\n').filter((l) => l.startsWith('FROM ')).length, 1, `${name}: more than one FROM`);
  }
});

test('with no digest supplied the FROM carries the tag, and the file SAYS that is why', () => {
  // The state today: nothing has been built, so no digest exists. The disclosure matters more than
  // the tag does -- an unpinned build that LOOKED pinned is how a rebuild silently stops moving.
  for (const name of fleets()) {
    const text = readFileSync(join(CUSTOMERS, name, 'Containerfile'), 'utf8');
    assert.match(text, new RegExp(`^ARG BASE=${escaped(config.baseImage)}:${config.baseTag}$`, 'm'));
    assert.match(text, /base pinned by\s+tag only -- no digest was supplied to the compiler/);
    assert.doesNotMatch(text, /base pinned by\s+\$AUROS_BASE_DIGEST/);
  }
});

test('nothing inside a customer directory can pin the base, whatever it is called', () => {
  // The one that matters most in this file, and it is a rule about a THREAT rather than about a
  // format. A recipe's own directory is the inside of a pull request from a stranger. A lockfile
  // there used to pin the build, so two lines beside recipe.yaml chose the image for a fleet --
  // under a generated header claiming the digest had been "published when this build started",
  // which nothing had published and nothing had checked. Worse, propagation decides a recipe is up
  // to date by finding the published digest in its lockfile, so a file naming today's digest made
  // that fleet permanently not-stale: never rebuilt, never patched, still booting. That is the
  // abandoned machine this product exists to replace, produced by us.
  //
  // It is closed twice over, and both halves are asserted because either alone would rot: the digest
  // comes from the environment and from nowhere else, AND a recipe folder holding a file nobody named
  // is refused rather than ignored. Ignoring it alone would be silent about an author plainly trying.
  const f = fixture('golden-lock-fixture');
  const attacker = `sha256:${'7'.repeat(64)}`;
  try {
    const clean = compileAt(f.recipePath);
    assert.ok(!clean.includes(attacker));

    for (const filename of ['base.lock', 'base.lock.json', 'BASE.lock', '.base.lock', 'digest', 'pin.txt', 'Containerfile.extra']) {
      writeFileSync(join(f.dir, filename), `BASE_DIGEST=${attacker}\n`);
      try {
        // Half one: the resolver does not read the recipe's directory at all.
        assert.equal(resolveBaseDigest({}), undefined, `a file called ${filename} beside the recipe pinned the build`);

        // Half two: the file is refused by name, so nobody finds out by it working.
        const result = validateDocument(toolchain(), loadRecipe(f.recipePath).doc, f.recipePath);
        assert.equal(result.ok, false, `${filename} was ignored rather than refused`);
        assert.match(
          result.refusals.map((r) => `${r.where} ${r.what}`).join('\n'),
          new RegExp(`${escaped(filename)} is not a file a recipe folder may contain`),
          `${filename} was refused, but not with a sentence naming it`,
        );
      } finally {
        rmSync(join(f.dir, filename), { force: true });
      }
    }

    // And with every planted file gone the fleet is acceptable again, so the rule is about the file
    // rather than about the fixture having been broken all along.
    assert.equal(compileAt(f.recipePath), clean);
  } finally {
    f.cleanup();
  }
});

test('the files a recipe folder IS allowed to hold are still allowed, so the rule above is not "refuse everything"', () => {
  const f = fixture('golden-allowed-fixture');
  try {
    writeFileSync(join(f.dir, 'Containerfile'), compileAt(f.recipePath));
    writeFileSync(join(f.dir, 'removal-floor.lock'), 'MUST_REMOVE_AT_LEAST=1\n');
    const result = validateDocument(toolchain(), loadRecipe(f.recipePath).doc, f.recipePath);
    assert.ok(
      result.ok,
      'a folder holding only the files it is supposed to was refused:\n' +
        result.refusals.map((r) => `  ${r.where}: ${r.what}`).join('\n'),
    );
  } finally {
    f.cleanup();
  }
});

test('when the environment supplies a digest the FROM resolves to exactly it, and the header stops saying "tag only"', () => {
  // The other direction, and the only reason the two tests above mean anything: a compiler that had
  // simply lost the ability to pin would pass both of them and pin nothing, forever.
  const digest = `sha256:${'c'.repeat(64)}`;
  const f = fixture('golden-pin-fixture');
  try {
    const text = compileAt(f.recipePath, { AUROS_BASE_DIGEST: digest });
    assert.match(text, new RegExp(`^ARG BASE=${escaped(config.baseImage)}@${digest}$`, 'm'));
    assert.match(text, /base pinned by\s+\$AUROS_BASE_DIGEST, resolved from the registry by the caller/);
    assert.doesNotMatch(text, new RegExp(`^ARG BASE=.*:${config.baseTag}$`, 'm'), 'the tag is in the FROM alongside the digest');
    assert.equal(text.split('\n').filter((l) => l.startsWith('ARG BASE=')).length, 1);

    // ...and the unpinned build of the very same recipe says the opposite, in words.
    const unpinned = compileAt(f.recipePath, {});
    assert.match(unpinned, /base pinned by\s+tag only -- no digest was supplied to the compiler/);
    assert.ok(!unpinned.includes(digest));
  } finally {
    f.cleanup();
  }
});

test('only a real digest pins a build, so a pin that is not one falls back to the tag rather than looking pinned', () => {
  const good = `sha256:${'b'.repeat(64)}`;
  assert.equal(resolveBaseDigest({ AUROS_BASE_DIGEST: good }), good);
  for (const bad of [
    'stable',
    'sha256:xyz',
    `sha256:${'b'.repeat(63)}`,
    `sha256:${'b'.repeat(65)}`,
    `SHA256:${'b'.repeat(64)}`,
    `sha256:${'B'.repeat(64)}`,
    `sha1:${'b'.repeat(40)}`,
    ` sha256:${'b'.repeat(64)}`,
    `sha256:${'b'.repeat(64)} `,
    `sha256:${'b'.repeat(64)}\nAUROS_BASE_DIGEST=sha256:${'a'.repeat(64)}`,
    'ghcr.io/somebody/else@sha256:' + 'b'.repeat(64),
    '',
  ]) {
    assert.equal(resolveBaseDigest({ AUROS_BASE_DIGEST: bad }), undefined, `${JSON.stringify(bad)} was accepted as a digest`);
  }
});

test('the image a recipe publishes to is derived, and a recipe cannot influence any part of it but its own name', () => {
  for (const name of fleets()) {
    const { text } = compileFleet(name);
    const title = /org\.opencontainers\.image\.title="([^"]+)"/.exec(text);
    assert.ok(title, `${name}: the image has no title label`);
    assert.equal(title[1], `${config.registry}/${config.org}/${config.product}-${name}`);
  }
});
