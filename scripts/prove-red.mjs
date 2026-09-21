#!/usr/bin/env node
/*
 * PROVE-RED — the test suite, tested.
 *
 * DECISIONS.md D19: "a step that cannot fail is not a check." D34 turned that into a mechanism for
 * auros-base and said, in words, why: a test file that only demonstrates the happy path looks
 * identical to one that works. This is the same mechanism for the recipe toolchain, and it exists
 * because a mutation run on 2026-09-20 found THIRTY changes to src/ and scripts/ that a green
 * 433-test suite could not see — among them a line-collapse in the shipped prune runner that is
 * byte-for-byte the SELinux bug (`tr -d '[:space:]'` deleting the newlines that made a per-line
 * check possible), which removed nothing and reported success.
 *
 * Each entry below reintroduces one of those bugs into a scratch copy of this repository and names
 * the test that must go red for it. A mutation that makes some OTHER test fail is not scored as a
 * catch: the named test is the one that understands the bug, and the one a reader will be sent to.
 *
 *   node scripts/prove-red.mjs                 every mutation must be caught
 *   node scripts/prove-red.mjs V31 P04         just these
 *   node scripts/prove-red.mjs --list          the table, with the test that owns each row
 *   node scripts/prove-red.mjs --baseline ...  apply the mutation against the test suite as it
 *                                              stood at git HEAD, and report whether it survived.
 *                                              This is how each row was shown to be a real hole
 *                                              before the test that closes it was written.
 *
 * THE SCRATCH COPY MIRRORS THE REAL LAYOUT. src/config.ts walks upwards for auros.config.json and
 * src/validate.ts looks for ../hardware/compat.tsv, so the copy is <tmp>/auros/auros-recipes with
 * the control repo's two files beside it. A scratch tree of a different shape would exercise a
 * different code path and prove something about that instead.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const META = dirname(ROOT)

/**
 * id      — the identifier the mutation report used, so a row here can be traced to its finding.
 * file    — relative to this repository.
 * find    — an exact substring of that file. Must appear EXACTLY ONCE, which is checked; a mutation
 *           that silently matched nothing would be a prove-red harness that proves nothing, which
 *           is the failure mode this whole file is about.
 * to      — what it becomes.
 * tests   — the test file(s) run to catch it.
 * catcher — the name of the test that must fail. Matched against the failing test names.
 */
const MUTATIONS = [
  // ---- the removal floor, in the working tree (src/validate.ts) ---------------------------------
  {
    id: 'V30',
    why: 'the floor may be lowered by exactly one, which is the alarm you turn down one point at a time',
    file: 'src/validate.ts',
    find: 'if (Number.isFinite(published) && recipe.prune.must_remove_at_least < published) {',
    to: 'if (Number.isFinite(published) && recipe.prune.must_remove_at_least < published - 1) {',
    tests: ['test/cli.test.ts'],
    catcher: /lowering the floor by ONE/,
  },
  {
    id: 'V31',
    why: 'a lock granting permission with no REASON= line grants permission anyway',
    file: 'src/validate.ts',
    find: "const permitted = Number.isFinite(allowLower) && allowLower === recipe.prune.must_remove_at_least && reason !== '';",
    to: 'const permitted = Number.isFinite(allowLower) && allowLower === recipe.prune.must_remove_at_least;',
    tests: ['test/cli.test.ts'],
    catcher: /states no reason/,
  },
  {
    id: 'V32',
    why: 'a permission slip for 235 authorises 238, 239 — a direction rather than a number',
    file: 'src/validate.ts',
    find: 'allowLower === recipe.prune.must_remove_at_least && reason',
    to: 'allowLower <= recipe.prune.must_remove_at_least && reason',
    tests: ['test/cli.test.ts'],
    catcher: /does not permit/,
  },

  // ---- the removal floor, as a property of history (scripts/floor-ratchet.mjs) ------------------
  {
    id: 'F01',
    why: 'every pull request may shave one package off the floor, and the floor walks to zero',
    file: 'scripts/floor-ratchet.mjs',
    find: 'if (wanted >= atBase.published) continue',
    to: 'if (wanted >= atBase.published - 1) continue',
    tests: ['test/adversarial.test.ts'],
    catcher: /lowers the floor by one/,
  },
  {
    id: 'F02',
    why: 'a base-branch lock with ALLOW_LOWER_TO and no REASON passes the gate that decides merges',
    file: 'scripts/floor-ratchet.mjs',
    find: "if (atBase.allowLower === null || atBase.reason === '') {",
    to: "if (atBase.allowLower === null && atBase.reason === '') {",
    tests: ['test/adversarial.test.ts'],
    catcher: /no REASON does not let CI pass/,
  },
  {
    id: 'F05',
    why: 'the gate reports a pass having examined zero fleets',
    file: 'scripts/floor-ratchet.mjs',
    find: "if (!checked) { console.error('floor-ratchet: no recipe carried a floor — refusing to report a pass'); process.exit(2) }",
    to: "if (false) { console.error('floor-ratchet: no recipe carried a floor — refusing to report a pass'); process.exit(2) }",
    tests: ['test/adversarial.test.ts'],
    catcher: /checked nothing/,
  },
  {
    id: 'F06',
    why: 'fail-open: a base ref it cannot resolve becomes a green CI run that verified nothing',
    file: 'scripts/floor-ratchet.mjs',
    find: '  process.exit(2)\n}\n\n/** The lockfile as it stands on the base branch',
    to: '  process.exit(0)\n}\n\n/** The lockfile as it stands on the base branch',
    tests: ['test/adversarial.test.ts'],
    catcher: /unresolvable base ref/,
  },

  // ---- hardware/compat.tsv (src/validate.ts) ----------------------------------------------------
  {
    id: 'V27',
    why: 'a model a human deliberately marked unsupported is accepted',
    file: 'src/validate.ts',
    find: "if (verdict === 'unsupported') {",
    to: "if (verdict === 'unsupported-which-this-column-never-says') {",
    tests: ['test/refusals.test.ts'],
    catcher: /recorded as unsupported/,
  },
  {
    id: 'V28',
    why: 'the verdict is read out of the webcam column, so the unsupported gate silently stops working',
    file: 'src/validate.ts',
    find: 'if (cells[0]) known.set(cells[0], cells[13] ?? ',
    to: 'if (cells[0]) known.set(cells[0], cells[12] ?? ',
    tests: ['test/refusals.test.ts'],
    catcher: /verdict column is column 13/,
  },

  // ---- font coverage (src/scripts.ts) -----------------------------------------------------------
  {
    id: 'S01',
    why: 'every ASCII letter becomes punctuation every font carries, so Latin stops being a script',
    file: 'src/scripts.ts',
    find: 'if (cp >= 0x20 && cp <= 0x40) return true;         // space ! " # ... 0-9 : ; < = > ? @',
    to: 'if (cp >= 0x20 && cp <= 0x7e) return true;         // space ! " # ... 0-9 : ; < = > ? @',
    tests: ['test/adversarial.test.ts'],
    catcher: /Latin is a script like any other/,
  },

  // ---- the catalogue, and the schema drifting away from it (src/validate.ts) --------------------
  {
    id: 'V13',
    why: 'a catalogue language with no font package is accepted, which is the empty-boxes first boot',
    file: 'src/validate.ts',
    find: 'if (entry.fonts.length === 0) {',
    to: 'if (entry.fonts.length < 0) {',
    tests: ['test/refusals.test.ts'],
    catcher: /no font package is refused/,
  },
  {
    id: 'V16',
    why: 'the schema/catalogue drift check for keyboard layouts is deleted',
    file: 'src/validate.ts',
    find: 'if (!catalogue.layouts.has(value)) {',
    to: 'if (false) {',
    tests: ['test/refusals.test.ts'],
    catcher: /the catalogue does not carry is refused/,
  },
  {
    id: 'V17',
    why: 'a script-switch toggle missing from the catalogue reaches compile, which omits it in silence',
    file: 'src/validate.ts',
    find: 'if (recipe.switch_scripts_with && !catalogue.toggles.has(recipe.switch_scripts_with)) {',
    to: 'if (false && recipe.switch_scripts_with && !catalogue.toggles.has(recipe.switch_scripts_with)) {',
    tests: ['test/refusals.test.ts'],
    catcher: /no xkb option in the catalogue is refused/,
  },

  // ---- the catalogue loader itself (src/catalogue.ts) -------------------------------------------
  {
    id: 'K01',
    why: 'two rows for one application name stop being an error and the last row silently wins',
    file: 'src/catalogue.ts',
    find: "if (apps.has(name)) throw new Error(`apps.tsv: '${name}' appears twice",
    to: "if (false) throw new Error(`apps.tsv: '${name}' appears twice",
    tests: ['test/catalogue.test.ts'],
    catcher: /duplicate app row/,
  },
  {
    id: 'K02',
    why: 'a capability this toolchain cannot enforce is accepted and enforces nothing',
    file: 'src/catalogue.ts',
    find: "if (capability !== '-' && capability !== 'terminal' && capability !== 'installs-software') {",
    to: 'if (false) {',
    tests: ['test/catalogue.test.ts'],
    catcher: /cannot enforce is refused at load time/,
  },
  {
    id: 'K03',
    why: 'an empty catalogue file loads as zero rows — an empty protected set removes systemd',
    file: 'src/catalogue.ts',
    find: 'if (rows.length === 0) throw new Error(',
    to: 'if (rows.length < 0) throw new Error(',
    tests: ['test/catalogue.test.ts'],
    catcher: /empty catalogue file/,
  },

  // ---- the validator's own refusals (src/validate.ts) -------------------------------------------
  {
    id: 'V24',
    why: 'an empty reserved-families.json gives a validator with no family refusals at all',
    file: 'src/validate.ts',
    find: 'if (!Array.isArray(doc.families) || doc.families.length === 0) {',
    to: 'if (!Array.isArray(doc.families)) {',
    tests: ['test/refusals.test.ts'],
    catcher: /empty list is refused at load/,
  },
  {
    id: 'V21',
    why: 'a reserved key nested under an unknown block is no longer recognised by family',
    file: 'src/validate.ts',
    find: '        }\n      }\n      walk(value, [...path, key]);',
    to: '        }\n      }',
    tests: ['test/refusals.test.ts'],
    catcher: /nested under an unknown block/,
  },

  // ---- the compiler (src/compile.ts) ------------------------------------------------------------
  {
    id: 'C02',
    why: 'a quote, backslash or $ in a LABEL value breaks out of the quotes it is written inside',
    file: 'src/compile.ts',
    find: "if (/[\"\\\\$`]/.test(value)) throw new UnsafeToken('a label value', value);",
    to: "if (false) throw new UnsafeToken('a label value', value);",
    tests: ['test/compile.test.ts'],
    catcher: /label value containing a quote/,
  },
  {
    id: 'C03',
    why: 'a wallpaper-sized logo is base64d into every Containerfile and every rebuild',
    file: 'src/compile.ts',
    find: 'if (bytes.length > 512 * 1024) {',
    to: 'if (bytes.length > 512 * 1024 * 1024) {',
    tests: ['test/compile.test.ts'],
    catcher: /over 512 KB stops the compiler/,
  },
  {
    id: 'C05',
    why: 'the compiler picks the alphabetically first Flatpak for an ambiguous kiosk',
    file: 'src/compile.ts',
    find: '  if (candidates.length > 1) {',
    to: '  if (candidates.length > 2) {',
    tests: ['test/compile.test.ts'],
    catcher: /ambiguous kiosk even when handed one directly/,
  },
  {
    id: 'C07',
    why: "SOURCE_DATE_EPOCH='today' becomes NaN, pinned into the label and the ARG",
    file: 'src/compile.ts',
    find: "if (declared !== undefined && /^[0-9]+$/.test(declared)) return Number(declared);",
    to: 'if (declared !== undefined) return Number(declared);',
    tests: ['test/determinism.test.ts'],
    catcher: /not a number is ignored/,
  },

  // ---- the namespace (src/config.ts) ------------------------------------------------------------
  {
    id: 'G01',
    why: "an empty org gives image names like 'registry//-school' with no error",
    file: 'src/config.ts',
    find: "if (typeof value !== 'string' || value.length === 0) {",
    to: "if (typeof value !== 'string') {",
    tests: ['test/cli.test.ts'],
    catcher: /empty org is refused/,
  },
  {
    id: 'G02',
    why: 'a typo in $AUROS_CONFIG silently resolves to some other config found above the repo',
    file: 'src/config.ts',
    find: '    if (!existsSync(fromEnv)) throw new ConfigNotFound(`$AUROS_CONFIG=${fromEnv} (which does not exist)`);\n    return resolve(fromEnv);',
    to: '    if (existsSync(fromEnv)) return resolve(fromEnv);',
    tests: ['test/cli.test.ts'],
    catcher: /never a fallback/,
  },

  // ---- the prune plan and the runner it ships (src/prune.ts) ------------------------------------
  {
    id: 'P02',
    why: "Flatpak ids reach the rpm removal list, so the image asks dnf to remove 'org.mozilla.firefox'",
    file: 'src/prune.ts',
    find: "    if (item.kind === 'flatpak') { notPreinstalled.push(item.ref); continue; }\n",
    to: '',
    tests: ['test/prune.test.ts'],
    catcher: /never handed to dnf/,
  },
  {
    id: 'P04',
    why: 'THE SELINUX BUG, in the shipped runner: the package list collapses to one element and nothing is removed',
    file: 'src/prune.ts',
    find: 'for item in plan["planned"]:\n    print(item["package"])',
    to: 'for item in plan["planned"]:\n    print(item["package"], end=" ")',
    tests: ['test/prune.test.ts'],
    catcher: /removes exactly the planned packages/,
  },
  {
    id: 'P05',
    why: 'the same line-collapse on the GUARDED list, so the protected-package guarantee checks a package that does not exist',
    file: 'src/prune.ts',
    find: 'for item in plan["kept_although_nothing_asked_for_them"]["packages"]:\n    print(item["package"])',
    to: 'for item in plan["kept_although_nothing_asked_for_them"]["packages"]:\n    print(item["package"], end=" ")',
    tests: ['test/prune.test.ts'],
    catcher: /one package per line/,
  },
  {
    id: 'P06',
    why: 'losing exactly one protected package is tolerated and the build succeeds',
    file: 'src/prune.ts',
    find: 'if [ "\\${#MISSING[@]}" -gt 0 ]; then',
    to: 'if [ "\\${#MISSING[@]}" -gt 1 ]; then',
    tests: ['test/prune.test.ts'],
    catcher: /exactly one guarded package/,
  },
  {
    id: 'P07',
    why: 'a refusal that returns success: it prints REFUSED and the build carries on',
    file: 'src/prune.ts',
    find: "            printf 'auros-prune: a fleet that loses it can never be repaired remotely again.\\\\n' >&2\n            exit 1",
    to: "            printf 'auros-prune: a fleet that loses it can never be repaired remotely again.\\\\n' >&2\n            exit 0",
    tests: ['test/prune.test.ts'],
    catcher: /would take a protected package/,
  },
  {
    id: 'P08',
    why: 'PROTECTED.md layer 2 becomes decoration — a grep that can never match',
    file: 'src/prune.ts',
    find: 'if grep -Eq "(^|[[:space:]])\\${pkg}[-[:space:]]" /tmp/auros-prune-resolve.txt; then',
    to: 'if grep -Eq "auros-no-such-string-\\${pkg}" /tmp/auros-prune-resolve.txt; then',
    tests: ['test/prune.test.ts'],
    catcher: /would take a protected package/,
  },

  // ---- the desktop defaults (src/recipe.ts) -----------------------------------------------------
  {
    id: 'R03',
    why: 'fail-open default: a recipe that says nothing about the desktop gets terminal access',
    file: 'src/recipe.ts',
    find: '  can_reach_a_terminal: false,',
    to: '  can_reach_a_terminal: true,',
    tests: ['test/recipe.test.ts'],
    catcher: /defaults are restrictive/,
  },
  {
    id: 'R05',
    why: 'an explicit false in the desktop block is discarded and the true default wins',
    file: 'src/recipe.ts',
    find: "if (typeof value === 'boolean') out[key] = value;",
    to: 'if (value) out[key] = value;',
    tests: ['test/recipe.test.ts'],
    catcher: /explicit false/,
  },
]

// -------------------------------------------------------------------------------------------------

/*
 * Everything except these. Copying a hand-written LIST of directories is what the first version did,
 * and it left out LICENSE, README.md and .github/ -- so licence.test.ts and workflows.test.ts failed
 * in every scratch tree, for reasons that had nothing to do with the mutation, and every mutation
 * scored as "caught". A harness that reports a catch it did not make is worse than no harness.
 */
const SKIP = new Set(['node_modules', '.git', 'dist'])

/** A scratch tree shaped like the real one: <tmp>/auros/auros-recipes, with the control repo beside it. */
function scratch (baselineTests) {
  const top = mkdtempSync(join(tmpdir(), 'auros-prove-red-'))
  const meta = join(top, 'auros')
  const repo = join(meta, 'auros-recipes')
  mkdirSync(repo, { recursive: true })
  for (const entry of readdirSync(ROOT)) {
    if (SKIP.has(entry)) continue
    cpSync(join(ROOT, entry), join(repo, entry), { recursive: true })
  }
  symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'))
  if (existsSync(join(META, 'auros.config.json'))) cpSync(join(META, 'auros.config.json'), join(meta, 'auros.config.json'))
  if (existsSync(join(META, 'hardware'))) cpSync(join(META, 'hardware'), join(meta, 'hardware'), { recursive: true })
  if (baselineTests) {
    // `git archive | tar -x`, never `git checkout --work-tree`: the latter writes the real
    // repository's index as a side effect, and a harness that dirties the tree it is measuring is
    // not a harness.
    rmSync(join(repo, 'test'), { recursive: true, force: true })
    const archive = execFileSync('git', ['archive', 'HEAD', 'test'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    const tar = spawnSync('tar', ['-x', '-C', repo], { input: archive })
    if (tar.status !== 0) throw new Error(`could not restore the test suite at HEAD: ${tar.stderr}`)
  }
  return { top, repo }
}

function applyMutation (repo, m) {
  const path = join(repo, m.file)
  const text = readFileSync(path, 'utf8')
  const first = text.indexOf(m.find)
  if (first === -1) throw new Error(`${m.id}: its 'find' text is not in ${m.file} any more. The mutation table has drifted from the source; fix the row rather than deleting it.`)
  if (text.indexOf(m.find, first + 1) !== -1) throw new Error(`${m.id}: its 'find' text appears more than once in ${m.file}, so the mutation is ambiguous.`)
  writeFileSync(path, text.slice(0, first) + m.to + text.slice(first + m.find.length))
}

/** Run node --test and return the names of the tests that failed. */
function runTests (repo, files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: repo, encoding: 'utf8', timeout: 600_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const failed = []
  for (const line of out.split('\n')) {
    const m = /^\s*not ok \d+ - (.+?)\s*$/.exec(line)
    if (m) failed.push(m[1])
  }
  return { status: r.status, failed, out }
}

const args = process.argv.slice(2)
if (args.includes('--list')) {
  for (const m of MUTATIONS) console.log(`${m.id.padEnd(4)} ${m.file.padEnd(24)} ${String(m.catcher).padEnd(48)} ${m.why}`)
  process.exit(0)
}
const baseline = args.includes('--baseline')
const wanted = args.filter((a) => !a.startsWith('--'))
const selected = wanted.length ? MUTATIONS.filter((m) => wanted.includes(m.id)) : MUTATIONS
if (selected.length === 0) { console.error(`prove-red: no mutation matched ${wanted.join(', ')}`); process.exit(2) }

/*
 * THE CONTROL, and it is not optional.
 *
 * "The named test failed" only means the mutation did it if that test PASSES in an unmutated scratch
 * tree. The first version of this script had no control and scored every mutation as caught because
 * the scratch copy was missing LICENSE and .github/, so two unrelated suites were red in every run.
 * A green control per test file, before any mutation, is the difference between measuring the
 * assertions and measuring the copy.
 */
const controls = new Map()
function controlIsGreen (files) {
  const k = files.join(' ')
  if (controls.has(k)) return controls.get(k)
  const { top, repo } = scratch(false)
  try {
    const { failed } = runTests(repo, files)
    if (failed.length > 0) {
      console.error(`CONTROL RED  ${k}\n             ${failed.length} test(s) fail in an UNMUTATED scratch copy: ${failed.slice(0, 4).join('; ')}`)
      console.error('             Until that is green, a failure under mutation proves nothing about the mutation.')
    }
    controls.set(k, failed.length === 0)
    return failed.length === 0
  } finally { rmSync(top, { recursive: true, force: true }) }
}

let bad = 0
for (const m of selected) {
  if (!baseline && !controlIsGreen(m.tests)) { bad++; console.error(`SKIPPED     ${m.id}  its control is red`); continue }
  const { top, repo } = scratch(baseline)
  try {
    applyMutation(repo, m)
    const files = baseline
      ? readdirSync(join(repo, 'test')).filter((f) => f.endsWith('.test.ts')).sort().map((f) => join('test', f))
      : m.tests
    const { failed } = runTests(repo, files)
    if (baseline) {
      const survived = failed.length === 0
      console.log(`${survived ? 'SURVIVED' : 'caught   '} ${m.id}  ${survived ? 'the suite at HEAD did not notice' : `caught at HEAD by: ${failed.slice(0, 3).join('; ')}`}`)
      continue
    }
    const caught = failed.filter((name) => m.catcher.test(name))
    if (caught.length === 0) {
      bad++
      console.error(`NOT CAUGHT  ${m.id}  ${m.why}`)
      console.error(`            no test matching ${m.catcher} failed. ${failed.length} other test(s) did: ${failed.slice(0, 4).join('; ') || '(none at all)'}`)
    } else {
      console.log(`caught      ${m.id}  ${caught[0]}`)
    }
  } catch (e) {
    bad++
    console.error(`ERROR       ${m.id}  ${e.message}`)
  } finally {
    rmSync(top, { recursive: true, force: true })
  }
}

if (baseline) process.exit(0)
if (bad > 0) {
  console.error(`\nprove-red: ${bad} of ${selected.length} mutation(s) were not caught by the test that owns them.`)
  console.error('A mutation nothing catches is a bug this suite would let through, which is the only thing this script measures.')
  process.exit(1)
}
console.log(`\nprove-red: ${selected.length}/${selected.length} mutations caught, each by the test that owns it.`)
