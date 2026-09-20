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
 * The second half of the file is the round trip: every committed recipe validates, compiles, and its
 * Containerfile's FROM resolves to the digest in base.lock when there is one. No recipe has been
 * built yet, so there is no base.lock -- which is exactly the state in which a "the FROM matches the
 * lock" test passes for the wrong reason forever. So the tests below assert what is true today AND
 * build a lockfile in a temporary fleet to prove the same code goes red when the two disagree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { compile, resolveBaseDigest } from '../src/compile.ts';
import { baseReference, loadConfig } from '../src/config.ts';
import { validateDocument } from '../src/validate.ts';
import { loadRecipe } from '../src/recipe.ts';
import { ROOT, toolchain, type Doc } from './helpers.ts';

const config = loadConfig(ROOT);
const CUSTOMERS = join(ROOT, 'customers');

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
  const digest = resolveBaseDigest(path, {});
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

test('with no base.lock the FROM carries the tag, and the file SAYS that is why', () => {
  // This is the state today: nothing has been built, so no digest exists. The disclosure matters
  // more than the tag does -- an unpinned build that looked pinned is how a rebuild silently moves.
  for (const name of fleets()) {
    const lock = join(CUSTOMERS, name, 'base.lock');
    assert.ok(!existsSync(lock), `customers/${name}/base.lock now exists, so this test is asserting the wrong state`);
    const text = readFileSync(join(CUSTOMERS, name, 'Containerfile'), 'utf8');
    assert.match(text, new RegExp(`^ARG BASE=${config.baseImage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:${config.baseTag}$`, 'm'));
    assert.match(text, /base pinned by\s+tag only -- this recipe has never been built/);
  }
});

test('when a base.lock exists the FROM resolves to exactly that digest', () => {
  // Built in a temporary fleet rather than asserted about the committed ones, because the committed
  // ones have no lockfile and a test that only ever sees the unpinned case would pass forever
  // whatever the pinning code did. This is the same check going the other way, which is the only
  // reason the one above means anything.
  const dir = join(CUSTOMERS, 'golden-lock-fixture');
  const digest = `sha256:${'7'.repeat(64)}`;
  mkdirSync(dir, { recursive: true });
  try {
    const source = loadRecipe(join(CUSTOMERS, 'example-workstation', 'recipe.yaml')).doc as Doc;
    source['name'] = 'golden-lock-fixture';
    writeFileSync(join(dir, 'recipe.yaml'), JSON.stringify(source));
    writeFileSync(join(dir, 'base.lock'), `BASE_DIGEST=${digest}\n`);

    const resolved = resolveBaseDigest(join(dir, 'recipe.yaml'), {});
    assert.equal(resolved, digest, 'the lockfile beside the recipe was not read at all');

    const { text } = compileFleet('golden-lock-fixture');
    assert.match(text, new RegExp(`^ARG BASE=${config.baseImage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@${digest}$`, 'm'));
    assert.match(text, /base pinned by\s+the digest published when this build started/);
    assert.ok(!text.includes(`:${config.baseTag}\n`), 'the tag is still in the FROM alongside the digest');

    // And the digest has to be a digest. A lockfile holding a tag, or a truncated hash, must not
    // produce a build that looks pinned and is not.
    for (const bad of ['BASE_DIGEST=stable\n', 'BASE_DIGEST=sha256:abc\n', 'BASE_DIGEST=sha1:' + '0'.repeat(40) + '\n', '']) {
      writeFileSync(join(dir, 'base.lock'), bad);
      assert.equal(
        resolveBaseDigest(join(dir, 'recipe.yaml'), {}),
        undefined,
        `a lockfile reading ${JSON.stringify(bad)} was accepted as a pin`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the environment can pin a build, and only with a real digest', () => {
  const path = join(CUSTOMERS, 'example-school', 'recipe.yaml');
  const good = `sha256:${'b'.repeat(64)}`;
  assert.equal(resolveBaseDigest(path, { AUROS_BASE_DIGEST: good }), good);
  for (const bad of ['stable', 'sha256:xyz', `sha256:${'b'.repeat(63)}`, `SHA256:${'b'.repeat(64)}`, `sha256:${'B'.repeat(64)}`]) {
    assert.equal(resolveBaseDigest(path, { AUROS_BASE_DIGEST: bad }), undefined, `'${bad}' was accepted as a digest`);
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
