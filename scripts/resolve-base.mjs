/**
 * What is the published base digest, and is "there isn't one" actually what the registry said?
 *
 * propagate.yml used to run an anonymous `skopeo inspect` and treat ANY failure as "base not
 * published yet — nothing to propagate", exit 0. A private package, a registry outage, a rate limit
 * and a runner image without skopeo all landed in that branch, and the schedule stayed green while
 * propagating nothing (docs/SYSTEM-REVIEW.md §2.5 in the control repo).
 *
 * Exactly one failure is benign: the registry answered, authenticated, and said the tag has no
 * manifest. skopeo reports that as
 *
 *     reading manifest <tag> in <repo>: manifest unknown
 *
 * — probed 2026-09-21 against ghcr.io with skopeo 1.13.3 (Ubuntu 24.04's package) and 1.22.3; the
 * text is identical, the exit code is not (1 vs 2), so the text is what is matched. Every other
 * failure — 403 on the bearer token, DNS, timeouts, skopeo absent, unparseable output — exits 1.
 *
 * Output on stdout, for $GITHUB_OUTPUT:  status=published + digest=sha256:…  |  status=not-published
 * Needs GITHUB_TOKEN (and GITHUB_ACTOR); an anonymous inspect cannot see a private package.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, baseReference } from '../src/config.ts';

const NOT_PUBLISHED = /reading manifest \S+ in \S+: manifest unknown/;

function fail(msg) {
  process.stderr.write(`resolve-base: ${msg}\n`);
  process.exit(1);
}

const config = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '..'));
const ref = baseReference(config);
const token = process.env.GITHUB_TOKEN;
if (!token) fail('GITHUB_TOKEN is not set. An anonymous inspect cannot tell "not published" from "private".');

// The token goes in an authfile, not on argv where any process on the runner can read it.
const dir = mkdtempSync(join(tmpdir(), 'resolve-base-'));
const authfile = join(dir, 'auth.json');
const user = process.env.GITHUB_ACTOR || 'github-actions';
writeFileSync(authfile, JSON.stringify({ auths: { [config.registry]: { auth: Buffer.from(`${user}:${token}`).toString('base64') } } }), { mode: 0o600 });

let r;
try {
  r = spawnSync('skopeo', ['inspect', '--no-tags', '--authfile', authfile, `docker://${ref}`], { encoding: 'utf8' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (r.error) fail(`could not run skopeo: ${r.error.message}`);
if (r.status !== 0) {
  if (NOT_PUBLISHED.test(r.stderr)) {
    process.stderr.write(`${ref}: registry says manifest unknown — base not published yet\n`);
    process.stdout.write('status=not-published\n');
    process.exit(0);
  }
  fail(`skopeo inspect ${ref} failed (exit ${r.status}), and not with "manifest unknown":\n${r.stderr}`);
}

let digest;
try { digest = JSON.parse(r.stdout).Digest; } catch { /* handled below */ }
if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
  fail(`skopeo inspect ${ref} succeeded but printed no sha256 Digest:\n${r.stdout.slice(0, 500)}`);
}
process.stdout.write(`status=published\ndigest=${digest}\n`);
