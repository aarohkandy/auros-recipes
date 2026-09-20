#!/usr/bin/env node
// WHAT A PULL REQUEST IS ALLOWED TO CONTAIN.
//
// Two separate rules, both learned the same way.
//
// 1. A RECIPE FOLDER holds recipe.yaml, the Containerfile generated from it, removal-floor.lock, and
//    the logo the recipe names. Nothing else — because everything else in that folder is read by
//    something. compile.ts used to resolve the base digest from `base.lock` in the recipe's own
//    directory, which is the inside of a pull request from a stranger, so two lines beside
//    recipe.yaml pinned a whole fleet to an image of the author's choosing.
//
// 2. .locks/ IS CI's. build-recipe.yml writes .locks/<name>.lock after a build; propagate.yml decides
//    a recipe is up to date by finding the published base digest in it. A pull request that writes
//    that file declares its own fleet current and stops receiving the rebuild that carries the next
//    security fix — the machine keeps booting and stops being patched, which is the failure this
//    whole product exists to prevent.
//
// src/validate.ts enforces rule 1 against the working tree as well, so `validate` refuses a stray
// file locally. This is the half that can see a DIFF, which is the only place rule 2 is visible.
//
// Usage: node scripts/ci-owned-files.mjs <base-ref>     e.g. origin/main
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const base = process.argv[2]
if (!base) { console.error('ci-owned-files: no base ref given — refusing to report a pass'); process.exit(2) }

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

let changed
try {
  const mergeBase = git('merge-base', base, 'HEAD').trim()
  changed = git('diff', '--name-only', `${mergeBase}..HEAD`).split('\n').map(s => s.trim()).filter(Boolean)
} catch (e) {
  console.error(`ci-owned-files: cannot diff against ${base} (${e.message}). A check that cannot run has not passed.`)
  process.exit(2)
}

const problems = []

// Rule 2: .locks/ is CI's, in a diff.
for (const path of changed) {
  if (path === '.locks' || path.startsWith('.locks/')) {
    problems.push(
      `${path} is changed by this pull request.\n` +
      '    .locks/ records which base digest each fleet was last BUILT against, and it is written\n' +
      '    only by .github/workflows/build-recipe.yml after a full check-matrix pass. propagate.yml\n' +
      '    reads it to decide which fleets are stale, so a lockfile naming the currently published\n' +
      '    digest marks that fleet permanently up to date: never rebuilt, never patched, still\n' +
      '    booting. Remove this file from the pull request.')
  }
}

// Rule 1: the contents of every recipe folder, working tree, whether or not the PR touched it.
const ALLOWED = new Set(['recipe.yaml', 'Containerfile', 'removal-floor.lock'])
const customers = join(ROOT, 'customers')
if (existsSync(customers)) {
  for (const fleet of readdirSync(customers).sort()) {
    const dir = join(customers, fleet)
    let entries
    try { entries = readdirSync(dir) } catch { continue }
    const allowed = new Set(ALLOWED)
    const recipe = join(dir, 'recipe.yaml')
    if (existsSync(recipe)) {
      try {
        const logo = parseYaml(readFileSync(recipe, 'utf8'))?.organisation?.logo
        if (typeof logo === 'string') allowed.add(logo)
      } catch { /* an unparseable recipe is the validator's verdict to give, not this script's */ }
    }
    for (const entry of entries.sort()) {
      if (allowed.has(entry)) continue
      problems.push(
        `customers/${fleet}/${entry} is not a file a recipe folder may contain.\n` +
        '    A recipe folder holds recipe.yaml, the Containerfile generated from it,\n' +
        '    removal-floor.lock, and the logo the recipe names. Everything else in that folder is\n' +
        '    read by something: a stray base.lock used to choose the base image for this fleet.')
    }
  }
}

if (problems.length === 0) {
  console.log(`ci-owned-files: ${changed.length} changed file(s), nothing a pull request may not contain.`)
  process.exit(0)
}
console.error(`\nci-owned-files: ${problems.length} problem(s)\n`)
for (const p of problems) console.error(`  · ${p}\n`)
process.exit(1)
