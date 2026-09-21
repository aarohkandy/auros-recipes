/**
 * scripts/resolve-base.mjs against a stub skopeo, in every branch it has.
 *
 * The error strings below are skopeo's own, captured 2026-09-21 from skopeo 1.13.3 against ghcr.io
 * (see the script's header). Only "manifest unknown" may come back green; everything else must go
 * red, because a green schedule is what hid SYSTEM-REVIEW §2.5 in the first place.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'resolve-base.mjs');
const DIGEST = `sha256:${'a'.repeat(64)}`;
const TOKEN = 'ghs_stubtoken';

const STUBS: Record<string, string> = {
  published: `echo '{"Name":"x","Digest":"${DIGEST}"}'`,
  'not-published': `echo 'time="t" level=fatal msg="Error parsing image name \\"docker://ghcr.io/acme/widget-base:tough\\": reading manifest tough in ghcr.io/acme/widget-base: manifest unknown"' >&2; exit 1`,
  auth: `echo 'time="t" level=fatal msg="Error parsing image name \\"docker://ghcr.io/acme/widget-base:tough\\": Requesting bearer token: invalid status code from registry 403 (Forbidden)"' >&2; exit 1`,
  network: `echo 'time="t" level=fatal msg="Error parsing image name \\"docker://ghcr.io/acme/widget-base:tough\\": pinging container registry ghcr.io: Get \\"https://ghcr.io/v2/\\": dial tcp: lookup ghcr.io: no such host"' >&2; exit 1`,
  'no-digest': `echo '{"Name":"x"}'`,
};

function run(stub: string | null, env: Record<string, string> = { GITHUB_TOKEN: TOKEN }) {
  const dir = mkdtempSync(join(tmpdir(), 'auros-resolve-base-'));
  try {
    const config = join(dir, 'auros.config.json');
    writeFileSync(config, JSON.stringify({
      org: 'acme', product: 'widget', registry: 'ghcr.io', baseImage: 'ghcr.io/acme/widget-base',
      baseTag: 'tough', arch: 'x86_64',
    }));
    const argsLog = join(dir, 'args');
    if (stub !== null) {
      const body = `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsLog}'\nauthfile=$(printf '%s\\n' "$@" | /usr/bin/sed -n '/^--authfile$/{n;p;}')\n/bin/cat "$authfile" >> '${argsLog}'\n${STUBS[stub]}\n`;
      writeFileSync(join(dir, 'skopeo'), body);
      chmodSync(join(dir, 'skopeo'), 0o755);
    }
    // PATH is the stub dir alone: with no stub, there is no skopeo, which is the "missing" case.
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { PATH: dir, AUROS_CONFIG: config, ...env },
    });
    let args = '';
    try { args = readFileSync(argsLog, 'utf8'); } catch { /* stub never ran */ }
    return { status: r.status, out: r.stdout, err: r.stderr, args };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('green: published base yields its digest, inspected by derived ref, authenticated, token off argv', () => {
  const r = run('published');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, `status=published\ndigest=${DIGEST}\n`);
  assert.match(r.args, /^docker:\/\/ghcr\.io\/acme\/widget-base:tough$/m);
  assert.match(r.args, /^--authfile$/m);
  const argv = r.args.split('{')[0]!;
  assert.ok(!argv.includes(TOKEN), 'token must not be on skopeo argv');
  assert.match(r.args, new RegExp(Buffer.from(`github-actions:${TOKEN}`).toString('base64')));
});

test('green: "manifest unknown" is the one benign failure', () => {
  const r = run('not-published');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, 'status=not-published\n');
});

for (const [name, stub] of [['auth error (403 on bearer token)', 'auth'], ['network error', 'network'], ['success without a digest', 'no-digest']] as const) {
  test(`red: ${name}`, () => {
    const r = run(stub);
    assert.equal(r.status, 1, `went green:\n${r.out}${r.err}`);
    assert.equal(r.out, '');
  });
}

test('red: skopeo missing', () => {
  const r = run(null);
  assert.equal(r.status, 1, `went green:\n${r.out}${r.err}`);
  assert.match(r.err, /could not run skopeo/);
});

test('red: no GITHUB_TOKEN, even if the registry would say manifest unknown', () => {
  const r = run('not-published', {});
  assert.equal(r.status, 1, `went green:\n${r.out}${r.err}`);
  assert.equal(r.args, '', 'skopeo should not have run anonymously');
});
