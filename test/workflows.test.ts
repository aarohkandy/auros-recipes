/**
 * REGRESSION - what an order branch is allowed to do.
 *
 * == THE FATAL THIS FILE EXISTS FOR ============================================================
 *
 * An order from the website becomes a branch `order/<name>-<date>-<hash>`, committed and pushed into
 * this repository by our GitHub App. A push authored by a GitHub App DOES start workflow runs -- only
 * a workflow's own GITHUB_TOKEN is suppressed, and that exemption is the whole point of using an App
 * token here. So:
 *
 *   propagate.yml triggered on `push: paths: [customers/**]` with NO branches filter
 *     -> fired on the order branch
 *     -> detect globbed every customer folder and marked the new one stale (it has no lockfile)
 *     -> rebuild called build-recipe.yml
 *     -> whose publish step, named "gated, with no bypass", carried no ref guard at all
 *     -> an image under our namespace reached the registry
 *
 * A pull request opened by a stranger on the internet, with no human review and no merge, published
 * an image into our namespace. The check matrix did not stop it and never could have: it answers
 * "does this image work", and the question was "may this image carry our name". The promise repeated
 * in the pull request body, in the configurator panel and on the order page -- nothing is built until
 * you and we have both read it -- was false on the first order.
 *
 * These assertions read the workflow FILES, because that is where the bug was: every one of them
 * would have failed before the fix and none of them can be satisfied by anything but the guard.
 * ==============================================================================================
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF = join(ROOT, '.github', 'workflows');
const read = (name: string): string => readFileSync(join(WF, name), 'utf8');

/** The named steps of a workflow, as (name, whole-step-text) pairs. Indentation-based, like the file. */
function steps(text: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  let current: { name: string; body: string } | null = null;
  let indent = 0;
  for (const line of text.split('\n')) {
    const start = /^(\s*)-\s+name:\s*(.+?)\s*$/.exec(line);
    if (start) {
      if (current) out.push(current);
      indent = start[1]!.length;
      current = { name: start[2]!, body: line + '\n' };
      continue;
    }
    if (!current) continue;
    const here = line.length - line.trimStart().length;
    if (line.trim() !== '' && here <= indent) {
      out.push(current);
      current = null;
      continue;
    }
    current.body += line + '\n';
  }
  if (current) out.push(current);
  return out;
}

/**
 * Does this workflow actually run an image push?
 *
 * Comment lines are stripped first. A comment naming the command is documentation -- order-check.yml
 * says in words that it never runs one -- and a check that cannot tell a sentence about a command
 * from a command is a check people route around by rewording their comments.
 */
const PUSH_COMMAND = /podman push|docker push/;
function publishes(text: string): boolean {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .some((line) => PUSH_COMMAND.test(line));
}

test('propagate.yml does not fire on a branch a stranger pushed', () => {
  const text = read('propagate.yml');
  const push = text.slice(text.indexOf('\n  push:'));
  assert.match(
    push,
    /\n\s*branches:\s*\[\s*main\s*\]/,
    'propagate.yml has a `push:` trigger with no `branches: [main]`. An order branch matches its ' +
      'customers path filter, so this workflow fires on an unreviewed pull request from the internet ' +
      'and hands it to build-recipe.yml.',
  );
});

test('build-recipe.yml publishes only from main, and the guard is not an input anyone can pass', () => {
  const text = read('build-recipe.yml');
  const publish = steps(text).find((s) => /^Publish/.test(s.name));
  assert.ok(publish, 'the publish step has been renamed -- rename it here and keep the assertion');
  assert.match(
    publish.body,
    /if:[^\n]*github\.ref\s*==\s*'refs\/heads\/main'/,
    "the publish step has no `github.ref == 'refs/heads/main'` guard. In a reusable workflow " +
      "github.ref is the CALLER's ref, which is the one thing a caller cannot assert -- that is why " +
      'the guard is this and not only an input.',
  );
  assert.match(
    publish.body,
    /if:[^\n]*inputs\.publish/,
    'the publish step no longer consults inputs.publish. Both guards are wanted: the input is the ' +
      "caller's stated intent, the ref is the fact.",
  );
});

test('the lockfile is written only from main, for the same reason', () => {
  const text = read('build-recipe.yml');
  const record = steps(text).find((s) => /Record the base digest/.test(s.name));
  assert.ok(record, 'the lockfile step has been renamed -- rename it here and keep the assertion');
  assert.match(
    record.body,
    /if:[^\n]*github\.ref\s*==\s*'refs\/heads\/main'/,
    'a lockfile written from an unreviewed branch marks that fleet up to date against a build nobody ' +
      'published: propagate.yml then never rebuilds it, so it never receives the next security fix.',
  );
});

test('exactly one workflow can put an image in the registry', () => {
  for (const file of readdirSync(WF)) {
    const text = readFileSync(join(WF, file), 'utf8');
    if (!publishes(text)) continue;
    assert.equal(
      file,
      'build-recipe.yml',
      `${file} publishes an image. Publishing lives in exactly one workflow so that exactly one ` +
        'guard has to be right.',
    );
  }
});

test('order-check.yml test-builds an order branch and publishes nothing', () => {
  const text = read('order-check.yml');
  assert.match(text, /branches:\s*\['order\/\*\*'\]/, 'order-check.yml no longer watches order branches');
  assert.match(text, /publish:\s*false/, 'order-check.yml must call build-recipe.yml with publish: false');
  assert.ok(!publishes(text), 'order-check.yml publishes an image. It test-builds; it does not publish.');
  const directives = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.doesNotMatch(
    directives,
    /packages:\s*write/,
    "order-check.yml grants packages: write. A run handling a stranger's file should not hold a token " +
      'that can write to the registry, whatever its steps happen to do today.',
  );
});

test('the /build-result callback exists, is signed, and reports a failure too', () => {
  const text = read('order-check.yml');
  assert.match(
    text,
    /\/build-result/,
    'nothing POSTs to /build-result. The Worker endpoint that ends the Stripe trial on a pass and ' +
      'releases the authorisation on a fail would have a consumer and no producer, and every order ' +
      'would sit at awaiting-checkout forever while the order page promised otherwise.',
  );
  assert.match(
    text,
    /sign-build-result\.mjs/,
    "the callback is not signed with the Worker's own signPayload(). An endpoint that can charge a " +
      'card is authenticated with the same code on both sides, not with a second HMAC implementation.',
  );
  assert.match(
    text,
    /if:\s*always\(\)/,
    "the report job is not `if: always()`. A failed build must release the customer's authorisation " +
      'as reliably as a passing one bills it; a run that dies quietly leaves a card authorised for a ' +
      'machine nobody is making.',
  );
  assert.match(text, /'pass'\s*\|\|\s*'fail'/, 'the outcome is no longer derived from whether the build job succeeded');
});

/**
 * REGRESSION - a recipe's own text cannot become a workflow command.
 *
 * `organisation.display_name: "::error::Everything passed"` passed the schema, passed CI validation,
 * and reached `node dist/cli.js explain`, whose stdout GitHub Actions parses for workflow commands --
 * explain.ts puts display_name at column zero. The recipe's author could fabricate annotations,
 * redact strings from the operator's log with ::add-mask::, and hide the real output that follows
 * with ::stop-commands::, including the publish gate's. Not fatal only because ::set-env and
 * ::add-path were disabled in 2020, so it is log forgery rather than RCE -- and on a product whose
 * argument is that the build output is true, letting the customer write the build output is the
 * wrong bug to have.
 *
 * The schema refuses a leading `::`, which all three validators inherit. This is the second layer.
 */
test('the explain step cannot emit a workflow command the recipe wrote', () => {
  const text = read('build-recipe.yml');
  const at = text.indexOf('node dist/cli.js explain');
  assert.notEqual(at, -1, 'the explain step is gone -- if the flow moved, move this assertion');
  const around = text.slice(Math.max(0, at - 1600), at + 400);
  assert.match(
    around,
    /::stop-commands::/,
    "the explain step no longer wraps the recipe's text in a stop-commands token. Everything between " +
      'the token and its resume is text whatever it says, which is the property wanted here.',
  );
  assert.match(
    around,
    /uuidgen/,
    'the stop-commands token is not freshly generated. A fixed token is one a recipe can spell, which ' +
      'is the same as having no token.',
  );
});

test('the schema refuses a leading :: so every validator inherits it', () => {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schema', 'recipe.schema.json'), 'utf8'));
  for (const def of ['line', 'prose']) {
    const rules = JSON.stringify(schema.$defs[def]);
    assert.ok(
      rules.includes('::'),
      `$defs/${def} no longer refuses a leading "::". It is a pattern rule so that the Worker, the ` +
        'website and CI all inherit it from one place rather than three.',
    );
  }
});

test('the schema refuses the Windows device names, so a clone works on every machine', () => {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schema', 'recipe.schema.json'), 'utf8'));
  const rules = JSON.stringify(schema.properties.name);
  for (const reserved of ['con', 'prn', 'aux', 'nul', 'com[1-9]', 'lpt[1-9]']) {
    assert.ok(
      rules.includes(reserved),
      `the name rule no longer refuses "${reserved}". A folder with that name cannot be checked out ` +
        'by git on Windows, so every Windows checkout of the recipes repository breaks, not only the ' +
        "one for that customer, and it looks like repository corruption rather than a name choice.",
    );
  }
});
