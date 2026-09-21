/**
 * REGRESSION - recipe images were published unsigned into a namespace whose policy requires a
 * signature (docs/SYSTEM-REVIEW.md §2.1), so every machine would refuse every recipe update forever.
 *
 * scripts/sign-recipe.sh is run here against stub sudo/podman/cosign/skopeo, so each refusal is shown
 * going red on the input it exists for, and the whole path green on good input. The last test pins the
 * wiring: a correct script that build-recipe.yml never calls, or calls after the push, proves nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'sign-recipe.sh');
const PUB = '-----BEGIN PUBLIC KEY-----\nGOOD\n-----END PUBLIC KEY-----\n';

const STUBS: Record<string, string> = {
  sudo: 'exec "$@"',
  podman: `
case "$*" in
  *signing-key-kind*) [ -n "$STUB_KIND" ] && echo "$STUB_KIND" || exit 1 ;;
  *auros.pub*) [ -n "$STUB_IMAGE_PUB" ] && printf '%s' "$STUB_IMAGE_PUB" || exit 1 ;;
  *) exit 99 ;;
esac`,
  cosign: `
echo "cosign $*" >> "$STUB_LOG"
case "$1" in
  public-key) printf '%s' "$STUB_DERIVED_PUB" ;;
  sign) [ "$2" = --help ] && { echo "  --new-bundle-format"; exit 0; }; exit "\${STUB_SIGN_RC:-0}" ;;
  verify) cmp -s "$3" "$STUB_EXPECT_PUB" || exit 7; exit "\${STUB_VERIFY_RC:-0}" ;;
esac`,
  skopeo: 'echo "skopeo $*" >> "$STUB_LOG"; exit "${STUB_SKOPEO_RC:-0}"',
};

function run(phase: string, over: Record<string, string> = {}, work?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sign-recipe-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const w = work ?? join(dir, 'work');
  const expect = join(dir, 'expect.pub');
  writeFileSync(expect, PUB);
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    SIGN_WORK: w,
    STUB_LOG: join(dir, 'log'),
    STUB_EXPECT_PUB: expect,
    CANDIDATE: 'localhost/x:candidate',
    IMAGE: 'ghcr.io/org/auros-x',
    DIGEST: 'sha256:abc',
    PUBKEY_IN_IMAGE: '/usr/lib/pki/containers/auros.pub',
    BUNDLE_FLAG: '--new-bundle-format=false',
    COSIGN_PRIVATE_KEY: 'PRIVATE',
    STUB_KIND: 'production',
    STUB_IMAGE_PUB: PUB,
    STUB_DERIVED_PUB: PUB,
    ...over,
  };
  const r = spawnSync('bash', [SCRIPT, phase], { env, encoding: 'utf8' });
  const log = existsSync(env.STUB_LOG!) ? readFileSync(env.STUB_LOG!, 'utf8') : '';
  return { code: r.status, out: r.stdout + r.stderr, log, work: w };
}

test('green: a production-key image with a matching key is signed and verified at the pushed digest', () => {
  const pre = run('preflight');
  assert.equal(pre.code, 0, pre.out);
  const s = run('sign', {}, pre.work);
  assert.equal(s.code, 0, s.out);
  assert.match(s.log, /cosign sign --new-bundle-format=false --key \S+ ghcr\.io\/org\/auros-x@sha256:abc/);
  assert.match(s.log, /cosign verify --key \S+image\.pub ghcr\.io\/org\/auros-x@sha256:abc/);
  assert.match(s.log, /skopeo inspect --raw docker:\/\/ghcr\.io\/org\/auros-x:sha256-abc\.sig/);
  assert.ok(!existsSync(join(pre.work, 'auros.key')), 'the private key was left on disk');
});

const REFUSALS: Array<[string, Record<string, string>, RegExp]> = [
  ['a development-key image', { STUB_KIND: 'development' }, /REFUSING TO PUBLISH.*DEVELOPMENT/],
  ['an image with no key kind', { STUB_KIND: '' }, /carries no \/usr\/lib\/auros\/signing-key-kind/],
  ['an unknown key kind', { STUB_KIND: 'staging' }, /unrecognised signing key kind/],
  ['an image with no public key', { STUB_IMAGE_PUB: '' }, /carries no \/usr\/lib\/pki\/containers\/auros\.pub/],
  ['a missing secret, named with where it is documented', { COSIGN_PRIVATE_KEY: '' }, /COSIGN_PRIVATE_KEY is not set.*signing\/keys\/README\.md/],
  ['a private key that is not the image\'s key', { STUB_DERIVED_PUB: 'OTHER' }, /does not match/],
];
for (const [what, over, msg] of REFUSALS) {
  test(`preflight refuses ${what}`, () => {
    const r = run('preflight', over);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, msg);
  });
}

const SIGN_FAILURES: Array<[string, Record<string, string>, RegExp]> = [
  ['cosign sign fails', { STUB_SIGN_RC: '1' }, /cosign sign failed/],
  ['cosign verify fails', { STUB_VERIFY_RC: '1' }, /cosign verify FAILED/],
  ['the .sig tag is not discoverable', { STUB_SKOPEO_RC: '1' }, /NOT discoverable/],
];
for (const [what, over, msg] of SIGN_FAILURES) {
  test(`sign goes red when ${what}`, () => {
    const pre = run('preflight');
    assert.equal(pre.code, 0, pre.out);
    const r = run('sign', over, pre.work);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, msg);
  });
}

test('build-recipe.yml runs preflight before the push and sign after it, in the gated publish step', () => {
  const text = readFileSync(join(ROOT, '.github', 'workflows', 'build-recipe.yml'), 'utf8');
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const pre = code.indexOf('scripts/sign-recipe.sh preflight');
  const push = code.indexOf('podman push');
  const sign = code.indexOf('scripts/sign-recipe.sh sign');
  assert.ok(pre > 0 && push > pre && sign > push, 'expected preflight < podman push < sign in build-recipe.yml');
});
