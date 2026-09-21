/**
 * The base pin is a COMMITTED input (SYSTEM-REVIEW §2.11).
 *
 * compile.ts used to read the digest from $AUROS_BASE_DIGEST, a per-build value. That made two
 * promises mutually exclusive: supply the digest and the regenerated Containerfile differs from the
 * committed one, so the D28 drift check fails every build; withhold it and every fleet builds on a
 * tag. Both held "by accident" only because the workflow exported the wrong variable name.
 *
 * Now the pin lives in .locks/base.digest -- committed, CI-owned, refused in a pull request -- and
 * compile is a pure function of committed files. These tests drive the real CLI against a scratch copy
 * of the repository, and the real workflow steps with git stubbed out.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { ROOT } from './helpers.ts';

const config = loadConfig(ROOT);
const PIN = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;

/** A scratch copy of the repository the CLI will treat as its root. */
function scratchRepo(pin?: string): { dir: string; compile: (env?: NodeJS.ProcessEnv) => string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'auros-basepin-'))); // realpath: the CLI resolves its root through symlinks (macOS /var)
  for (const p of ['src', 'schema', 'catalogue', 'package.json', join('customers', 'example-school')]) {
    cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  mkdirSync(join(dir, '.auros-meta'));
  cpSync(config.configPath, join(dir, '.auros-meta', 'auros.config.json'));
  if (pin !== undefined) {
    mkdirSync(join(dir, '.locks'));
    writeFileSync(join(dir, '.locks', 'base.digest'), `${pin}\n`);
  }
  const recipe = join(dir, 'customers', 'example-school', 'recipe.yaml');
  const compile = (env: NodeJS.ProcessEnv = {}): string => {
    const clean = { ...process.env, ...env };
    delete clean['AUROS_CONFIG'];
    if (!('AUROS_BASE_DIGEST' in env)) delete clean['AUROS_BASE_DIGEST'];
    const r = spawnSync(process.execPath, [join(dir, 'src', 'cli.ts'), 'compile', recipe], { encoding: 'utf8', cwd: dir, env: clean });
    assert.equal(r.status, 0, `compile failed:\n${r.stderr}`);
    return r.stdout;
  };
  return { dir, compile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The `run: |` body of a named step in a workflow, dedented, with `${{ }}` replaced by a fixed word. */
function stepScript(workflow: string, name: string): string {
  const lines = readFileSync(join(ROOT, '.github', 'workflows', workflow), 'utf8').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s+name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(l));
  assert.ok(start >= 0, `${workflow} has no step named "${name}"`);
  const runAt = lines.findIndex((l, i) => i > start && /^\s*run:\s*\|\s*$/.test(l));
  const indent = lines[runAt + 1]!.length - lines[runAt + 1]!.trimStart().length;
  const body: string[] = [];
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() !== '' && l.length - l.trimStart().length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n').replace(/\$\{\{[^}]*\}\}/g, 'x');
}

/** Run a workflow step under bash -euo pipefail, the workflow's own shell, with git stubbed. */
function runStep(script: string, cwd: string, env: Record<string, string>) {
  const bin = join(cwd, '.stub-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'git'), 0o755);
  return spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env, PATH: `${bin}:${process.env['PATH']}`, GITHUB_OUTPUT: join(cwd, '.gh-output') },
  });
}

test('a committed .locks/base.digest pins the FROM by digest, and the header names where it came from', () => {
  const repo = scratchRepo(PIN);
  try {
    const text = repo.compile();
    assert.match(text, new RegExp(`^ARG BASE=${config.baseImage.replace(/[.]/g, '\\.')}@${PIN}$`, 'm'));
    assert.match(text, /base pinned by\s+\.locks\/base\.digest/);
    assert.doesNotMatch(text, /tag only/);
  } finally {
    repo.cleanup();
  }
});

test('with no pin committed the FROM is the tag and the file says so -- the control for the test above', () => {
  const repo = scratchRepo();
  try {
    const text = repo.compile();
    assert.match(text, new RegExp(`^ARG BASE=.*:${config.baseTag}$`, 'm'));
    assert.match(text, /base pinned by\s+tag only/);
  } finally {
    repo.cleanup();
  }
});

test('a malformed committed pin stops the compiler rather than quietly building on the tag', () => {
  const repo = scratchRepo('stable');
  try {
    const r = spawnSync(process.execPath, [join(repo.dir, 'src', 'cli.ts'), 'compile', join(repo.dir, 'customers', 'example-school', 'recipe.yaml')], {
      encoding: 'utf8', cwd: repo.dir, env: { ...process.env, AUROS_CONFIG: '' },
    });
    assert.equal(r.status, 2, `a pin that is not a digest compiled:\n${r.stdout.slice(0, 400)}`);
    assert.match(r.stderr, /\.locks\/base\.digest/);
  } finally {
    repo.cleanup();
  }
});

test('the D28 drift check holds with a pin: nothing in the environment moves a byte, and a hand edit is caught', () => {
  const repo = scratchRepo(PIN);
  try {
    const committed = join(repo.dir, 'customers', 'example-school', 'Containerfile');
    writeFileSync(committed, repo.compile());
    const fresh = join(repo.dir, 'fresh');
    const drift = () => spawnSync('diff', ['-u', committed, fresh], { encoding: 'utf8' }).status;

    // The review's execution of the bug: a digest arriving from the caller changed the compiled
    // bytes, so the drift check failed on every pinned build.
    writeFileSync(fresh, repo.compile({ AUROS_BASE_DIGEST: OTHER, BASE_DIGEST: OTHER }));
    assert.equal(drift(), 0, 'a digest in the environment changed the compiled Containerfile, so CI drift-fails every pinned build');

    // ...and the check still means something.
    writeFileSync(committed, readFileSync(committed, 'utf8').replace(`@${PIN}`, `@${OTHER}`));
    assert.equal(drift(), 1, 'a hand-edited FROM line was not caught by the drift check');
  } finally {
    repo.cleanup();
  }
});

test('the lockfile records the digest the built Containerfile used, not the one the caller claimed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auros-lockstep-'));
  try {
    mkdirSync(join(dir, 'customers', 'x'), { recursive: true });
    writeFileSync(join(dir, 'customers', 'x', 'Containerfile'), `# header\nARG BASE=${config.baseImage}@${PIN}\nFROM \${BASE}\n`);
    const r = runStep(stepScript('build-recipe.yml', 'Record the base digest this recipe was built against'), dir, { RECIPE: 'x', BASE_DIGEST: OTHER });
    assert.equal(r.status, 0, r.stderr);
    const lock = readFileSync(join(dir, '.locks', 'x.lock'), 'utf8');
    assert.match(lock, new RegExp(`^BASE_DIGEST=${PIN}$`, 'm'), `the lockfile does not name the digest the build used:\n${lock}`);
    assert.ok(!lock.includes(OTHER), 'the lockfile names a digest the build did not use');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a caller digest that is not the committed pin is refused before anything is built', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auros-pinstep-'));
  try {
    mkdirSync(join(dir, '.locks'));
    writeFileSync(join(dir, '.locks', 'base.digest'), `${PIN}\n`);
    const script = stepScript('build-recipe.yml', 'The caller\'s base digest is the committed pin');
    const mismatch = runStep(script, dir, { BASE_DIGEST: OTHER });
    assert.equal(mismatch.status, 1, 'a build proceeded on a checkout that does not carry the pin its caller resolved');
    assert.match(mismatch.stdout + mismatch.stderr, /\.locks\/base\.digest/);
    // Controls: the matching digest, and no digest at all (order-check.yml and a bare dispatch).
    assert.equal(runStep(script, dir, { BASE_DIGEST: PIN }).status, 0);
    assert.equal(runStep(script, dir, { BASE_DIGEST: '' }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
