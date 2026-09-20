#!/usr/bin/env node
// THE REMOVAL-FLOOR RATCHET, as a property of HISTORY rather than of the working tree.
//
// `prune.must_remove_at_least` is the alarm that catches upstream quietly putting back something we
// took out: if a rebuild removes fewer packages than last time, somebody should look. src/validate.ts
// compares the recipe against removal-floor.lock — and both files sit in the same directory, so both
// are in the same pull request. The refusal it printed promised "a separate commit, which CODEOWNERS
// makes somebody else approve"; in fact the floor went from 1100 to 1 by adding three lines to the
// lockfile in the same diff, and CODEOWNERS is one line (`* @aarohkandy`) which cannot make a
// self-authored pull request require anybody.
//
// This is the half that can see a commit. The rule it enforces:
//
//   The floor may RISE freely.
//   The floor may FALL only when ALLOW_LOWER_TO and REASON were ALREADY ON THE BASE BRANCH before
//   this pull request — i.e. granted in an earlier, separately merged change — and ALLOW_LOWER_TO
//   names exactly the value being dropped to.
//
// So lowering the floor is two pull requests, and the first one is a diff that does nothing except
// ask for permission, with a reason in it. That is still not a second human — nothing in code can
// manufacture one — but it is a real, mechanical, reviewable separation, and it is what the refusal
// text now says instead of what it used to promise.
//
// Usage: node scripts/floor-ratchet.mjs <base-ref>     e.g. origin/main
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const base = process.argv[2]
if (!base) { console.error('floor-ratchet: no base ref given — refusing to report a pass'); process.exit(2) }

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

let mergeBase
try { mergeBase = git('merge-base', base, 'HEAD').trim() } catch (e) {
  console.error(`floor-ratchet: cannot resolve a merge base with ${base} (${e.message}). A check that cannot run has not passed.`)
  process.exit(2)
}

/** The lockfile as it stands on the base branch, or null if it is not there yet. */
function lockAtBase (path) {
  try { return git('show', `${mergeBase}:${path}`) } catch { return null }
}

export function readFloor (text) {
  if (text === null) return { published: null, allowLower: null, reason: '' }
  const num = (re) => { const m = re.exec(text); return m ? Number(m[1]) : null }
  return {
    published: num(/^MUST_REMOVE_AT_LEAST=(\d+)$/m),
    allowLower: num(/^ALLOW_LOWER_TO=(\d+)$/m),
    reason: (/^REASON=(.+)$/m.exec(text)?.[1] ?? '').trim(),
  }
}

const problems = []
const customers = join(ROOT, 'customers')
let checked = 0

for (const fleet of existsSync(customers) ? readdirSync(customers).sort() : []) {
  const recipePath = join(customers, fleet, 'recipe.yaml')
  if (!existsSync(recipePath)) continue
  let wanted
  try { wanted = parseYaml(readFileSync(recipePath, 'utf8'))?.prune?.must_remove_at_least } catch { continue }
  if (typeof wanted !== 'number') continue

  const rel = `customers/${fleet}/removal-floor.lock`
  const atBase = readFloor(lockAtBase(rel))
  const now = readFloor(existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : null)
  checked++

  if (atBase.published === null) continue          // no floor recorded yet: nothing to ratchet against
  if (wanted >= atBase.published) continue         // rising, or holding. Always fine.

  // Falling. The permission has to have existed BEFORE this pull request.
  if (atBase.allowLower === null || atBase.reason === '') {
    problems.push(
      `customers/${fleet}: this pull request lowers the removal floor from ${atBase.published} to ${wanted},\n` +
      '    and the permission to do so is not on the base branch.\n' +
      `    ${now.allowLower !== null ? `This diff ADDS ALLOW_LOWER_TO=${now.allowLower}, which is the same diff granting itself\n    permission. ` : ''}` +
      `Merge a change to ${rel} that adds ALLOW_LOWER_TO=${wanted} and a REASON= line\n` +
      '    on its own first, then lower the recipe in a later pull request.')
    continue
  }
  if (atBase.allowLower !== wanted) {
    problems.push(
      `customers/${fleet}: the base branch permits lowering the floor to ${atBase.allowLower}, and this\n` +
      `    pull request lowers it to ${wanted}. A permission slip is for one number, not for a direction.`)
  }
}

if (!checked) { console.error('floor-ratchet: no recipe carried a floor — refusing to report a pass'); process.exit(2) }
if (problems.length === 0) { console.log(`floor-ratchet: ${checked} fleet(s), the floor only turned one way.`); process.exit(0) }
console.error(`\nfloor-ratchet: ${problems.length} problem(s)\n`)
for (const p of problems) console.error(`  · ${p}\n`)
process.exit(1)
