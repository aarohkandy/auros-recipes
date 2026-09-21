/**
 * scripts/compare-images.mjs, driven into every failure branch it has.
 *
 * That script is the only thing in this repository that will ever look at a real package database,
 * and it cannot run until the hardened base publishes and .github/workflows/examples.yml has built
 * three images. A check nobody can run is indistinguishable from one that passes (D35), and a check
 * nobody has watched fail is indistinguishable from one that cannot (D34) -- so it is exercised here
 * against synthetic facts of exactly the shape the workflow uploads, months before the real ones
 * exist.
 *
 * The fixtures are deliberately small and obviously fake. What is being tested is the script's
 * ARITHMETIC and its willingness to say no, not Fedora's package list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'compare-images.mjs');

interface Fleet {
  installed: string[];
  planned: string[];
  protectedKept?: string[];
  floor?: number;
  labels?: Record<string, string>;
}

/** A fleet's three uploaded files, in the shape examples.yml writes them. */
function writeFleet(dir: string, name: string, f: Fleet): void {
  writeFileSync(join(dir, `${name}.rpms`), f.installed.join('\n') + '\n');
  writeFileSync(
    join(dir, `${name}.plan.json`),
    JSON.stringify({
      planned: f.planned.map((p) => ({ package: p })),
      floor: { must_remove_at_least: f.floor ?? 10 },
      kept_although_nothing_asked_for_them: { packages: (f.protectedKept ?? ['bootc']).map((p) => ({ package: p })) },
    }),
  );
  writeFileSync(
    join(dir, `${name}.labels.json`),
    JSON.stringify({ 'auros.size-budget-gb': '9', 'auros.test-profiles': 'uefi-modern', ...(f.labels ?? {}) }),
  );
}

/** Enough packages that the script's "this is not a Fedora system" floor is cleared. */
function bulk(n: number, prefix = 'pkg'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`);
}

function run(fleets: Record<string, Fleet>): { status: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'auros-compare-'));
  try {
    for (const [name, f] of Object.entries(fleets)) writeFleet(dir, name, f);
    try {
      const out = execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const COMMON = bulk(300);

/** Two honest fleets: both removed what they planned, and they are not the same image. */
function green(): Record<string, Fleet> {
  return {
    'fleet-a': { installed: [...COMMON, 'firefox', 'bootc'], planned: ['kmines', 'gcc'], protectedKept: ['bootc'] },
    'fleet-b': { installed: [...COMMON, 'kmines', 'bootc'], planned: ['firefox', 'gcc'], protectedKept: ['bootc'] },
  };
}

test('two honest images compare clean', () => {
  const r = run(green());
  assert.equal(r.status, 0, `expected a clean comparison, got:\n${r.out}`);
  assert.match(r.out, /all assertions held/);
});

test('a package named for removal that is still in the image fails the comparison', () => {
  const f = green();
  f['fleet-a']!.installed.push('gcc');              // planned for removal, still present
  const r = run(f);
  assert.equal(r.status, 1, `the comparison passed with an unremoved package:\n${r.out}`);
  assert.match(r.out, /still in the image/i);
  assert.match(r.out, /gcc/);
});

test('a protected package missing from the image fails the comparison', () => {
  const f = green();
  f['fleet-b']!.installed = f['fleet-b']!.installed.filter((p) => p !== 'bootc');
  const r = run(f);
  assert.equal(r.status, 1, `the comparison passed with a protected package gone:\n${r.out}`);
  assert.match(r.out, /PROTECTED package/);
});

test('two identical images fail, because that is one recipe with two names', () => {
  const same = [...COMMON, 'bootc'];
  const r = run({
    'fleet-a': { installed: [...same], planned: [], protectedKept: ['bootc'] },
    'fleet-b': { installed: [...same], planned: [], protectedKept: ['bootc'] },
  });
  assert.equal(r.status, 1, `the comparison passed on two identical images:\n${r.out}`);
  assert.match(r.out, /exactly the same packages/);
});

test('an empty or truncated package list is refused rather than passing trivially', () => {
  // The failure that matters most: `rpm -qa` produced nothing, so every "is absent" check would
  // pass. An absent answer must never read as a good one.
  const r = run({
    'fleet-a': { installed: ['bootc'], planned: ['gcc'], protectedKept: ['bootc'] },
    'fleet-b': { installed: [...COMMON, 'bootc'], planned: ['gcc'], protectedKept: ['bootc'] },
  });
  assert.equal(r.status, 1, `the comparison passed on a one-package "image":\n${r.out}`);
  assert.match(r.out, /not a Fedora system/);
});

test('fewer than two images is a broken run, not a pass', () => {
  const r = run({ 'fleet-a': { installed: [...COMMON], planned: [], protectedKept: ['bootc'] } });
  assert.equal(r.status, 2, `one image compared to nothing did not exit 2:\n${r.out}`);
  assert.match(r.out, /needs at least two/);
});

test('an image with no auros.test-profiles label fails, because also_test reached nothing again', () => {
  const f = green();
  f['fleet-a']!.labels = { 'auros.test-profiles': '' };
  const r = run(f);
  assert.equal(r.status, 1, `the comparison passed on an image with no test-profiles label:\n${r.out}`);
  assert.match(r.out, /also_test reached the image as nothing/);
});

test('the script reports the untraced differences rather than hiding them', () => {
  // Dependency closure legitimately removes things nobody named, so this is printed and not failed.
  // What would be dishonest is not computing it at all.
  const f = green();
  f['fleet-a']!.installed.push('some-transitive-dep');
  const r = run(f);
  assert.equal(r.status, 0, `an untraced difference should be reported, not failed:\n${r.out}`);
  assert.match(r.out, /some-transitive-dep/);
  assert.match(r.out, /not traced to either recipe's removal plan/);
});
