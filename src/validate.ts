/*
 * ── COORDINATION NOTE FOR AGENTS · 2026-09-20 ──────────────────────────────────────────────────────
 * Several agents edit this repository concurrently. On 2026-09-20 a WHOLESALE rewrite of
 * src/validate.ts silently reverted a real fix (the first_boot_message font-coverage check — a
 * finding that a first-boot message in a script the image has no font for renders as empty boxes to
 * the very first person who sees the machine). That fix now lives in src/scripts.ts.
 *
 *   - Edit this file SURGICALLY. Do not rewrite it wholesale. Re-read it immediately before writing.
 *   - Do not reintroduce the 11-range SCRIPT_RANGES table in validate.ts; scripts.ts supersedes it,
 *     for the reason given at the top of scripts.ts.
 *   - A green test run after a wholesale rewrite does not prove nothing was lost — the reverted fix
 *     had a test, and the rewrite removed both. Diff before you commit.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
/**
 * Validation: the schema, then the rules a schema cannot carry.
 *
 * recipe.schema.json already refuses the big four by name and by shape -- a FROM override, a kernel
 * pin, a version pin, and pruning the update path. This module exists for the cases that get past a
 * document grammar:
 *
 *   1. A key that is REFUSED for the right reason rather than as "unexpected property".
 *      `base_image`, `kernelArgs`, `pinnedVersions` and `postInstall` are all unknown keys, and a
 *      reader who is told only that gets no idea why the thing they wanted is not here. The schema
 *      names about eighty reserved keys; this recognises the FAMILY and prints the same sentence.
 *
 *   2. A rule that is about two fields at once, or about a field and a file somewhere else.
 *      Installing Konsole on a locked fleet defeats `can_reach_a_terminal: false` without
 *      contradicting any single field. Installing VLC while removing "media players" is a
 *      contradiction the grammar cannot see. A language with no font package produces a first-boot
 *      screen of empty boxes and a perfectly valid file.
 *
 *   3. A protected package reaching the removal set. planPrune asserts this; validate reports it.
 *
 * WHAT THIS MODULE IS NOT ALLOWED TO BE: a second, private set of rules. schema/README.md section 6
 * promises that everything deciding whether a recipe is acceptable is in this public repository, and
 * lists exactly which rules live in a validator rather than in the schema. If you add a rule here,
 * add it there, and add it to test/refusals.test.ts.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { compileSchema, reservedByName, schemaRefusals, type CompiledSchema } from './schema.ts';
import { loadCatalogue, type Catalogue } from './catalogue.ts';
import { planPrune, type PrunePlan } from './prune.ts';
import { kioskCandidates } from './compile.ts';
import { desktopSettings, type Recipe } from './recipe.ts';
import { nearest, pointer, refuse, sentenceList, type Refusal } from './refusal.ts';
import { auditScripts, SCRIPT_REFUSAL_WHY, scriptRefusalText } from './scripts.ts';

/**
 * The base's real update cadence, and U1's deadline, in one place and in the customer's words.
 *
 * Stated once because they are quoted in three places -- this file's disclosure note, explain's
 * output, and schema/README.md -- and three copies of a measured number is how one of them becomes
 * wrong. Read out of the artifact, never remembered.
 */
// auros-allow: measured, not estimated — these three numbers are the literal OnBootSec=3min, OnUnitInactiveSec=6h and RandomizedDelaySec=10min in auros-base/update-agent/systemd/bootc-fetch-apply-updates.timer.d/10-auros.conf.
export const UPDATE_CADENCE = 'checks for an update three minutes after boot and every six hours after that, with ten minutes of jitter';
// auros-allow: measured — twenty minutes is check U1's stated window in docs/SPEC.md §6A, not an estimate of anything.
export const U1_WINDOW = 'within twenty minutes';

export interface ValidationResult {
  readonly ok: boolean;
  readonly refusals: ReadonlyArray<Refusal>;
  /** Disclosed unknowns. Not failures. They are stamped on the build report so they stay known. */
  readonly notes: ReadonlyArray<string>;
  /** Present only when the recipe passed. */
  readonly recipe?: Recipe;
  readonly plan?: PrunePlan;
  readonly fonts?: ReadonlyArray<string>;
}

export interface Toolchain {
  readonly repoRoot: string;
  readonly schema: CompiledSchema;
  readonly catalogue: Catalogue;
  /** Keys the schema already refuses by name, with a better sentence than any family detector. */
  readonly namedRefusals: ReadonlySet<string>;
  /** The reserved key families, read from schema/reserved-families.json. */
  readonly families: ReadonlyArray<Family>;
}

export function loadToolchain(repoRoot: string): Toolchain {
  const schema = compileSchema(repoRoot);
  return {
    repoRoot,
    schema,
    catalogue: loadCatalogue(join(repoRoot, 'catalogue')),
    namedRefusals: reservedByName(schema.schema),
    families: loadFamilies(repoRoot),
  };
}

// -------------------------------------------------------------------------------------------------
// 1. Reserved key families
// -------------------------------------------------------------------------------------------------

export interface Family {
  readonly id: string;
  readonly title: string;
  readonly why: string;
  readonly exact: ReadonlyArray<string>;
  /** Substrings, matched against the normalised key. Only ever applied to keys the schema does not know. */
  readonly contains: ReadonlyArray<string>;
}

/**
 * The families are DATA, in schema/reserved-families.json, not a literal in this file.
 *
 * They used to be a literal here, and that is precisely why the Worker behind the website could
 * accept a recipe this validator refuses: `postInstall` is an unknown key to a JSON Schema and a
 * refused key to this module, and only one of the two ran on the server. The website tells a visitor
 * "this is the same schema auros-recipes validates with in CI" at the exact moment it refuses them,
 * so a rule that exists on only one side of that sentence makes the sentence false.
 *
 * Moving them next to the schema means the Worker vendors ONE MORE FILE rather than reimplementing
 * ONE MORE RULE. schema/README.md section 6 still applies: every rule that decides whether a recipe
 * is acceptable is in this public repository, and now more of it is in a file rather than in code.
 */
export function loadFamilies(repoRoot: string): ReadonlyArray<Family> {
  const path = join(repoRoot, 'schema', 'reserved-families.json');
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { families?: unknown };
  if (!Array.isArray(doc.families) || doc.families.length === 0) {
    throw new Error(`${path}: no reserved key families -- a validator that has forgotten its refusals is a validator that accepts a kernel pin`);
  }
  return doc.families as ReadonlyArray<Family>;
}

function normalise(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function familyFor(key: string, families: ReadonlyArray<Family>): Family | null {
  const n = normalise(key);
  for (const family of families) if (family.exact.includes(n)) return family;
  for (const family of families) for (const needle of family.contains) if (n.includes(needle)) return family;
  return null;
}

/** Walk every object in the document, reporting unknown keys that belong to a reserved family. */
function reservedKeyRefusals(doc: unknown, known: ReadonlySet<string>, alreadyNamed: ReadonlySet<string>, families: ReadonlyArray<Family>): Refusal[] {
  const out: Refusal[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, path: Array<string | number>): void => {
    if (Array.isArray(node)) { node.forEach((child, i) => walk(child, [...path, i])); return; }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!known.has(key) && !alreadyNamed.has(key)) {
        const family = familyFor(key, families);
        if (family) {
          const at = pointer([...path, key]);
          if (!seen.has(at)) {
            seen.add(at);
            out.push(refuse(at, `${family.title} -- there is no '${key}' field, and that is the point.`, family.why));
          }
        }
      }
      walk(value, [...path, key]);
    }
  };
  walk(doc, []);
  return out;
}

// -------------------------------------------------------------------------------------------------
// 2. Free text never reaches a build instruction
// -------------------------------------------------------------------------------------------------

const COMMAND_SUBSTITUTION = /`|\$\(|\$\{/;

const FREE_TEXT_WHY =
  'The compiler writes every human string into the image as base64-encoded data, so no byte a ' +
  'customer wrote is ever seen by a shell. This refusal is the second half of that: a string ' +
  'containing command substitution is either an attack or a paste accident, and a school login ' +
  'screen is not where we find out which. Orders arrive here as pull requests from strangers.';

function freeTextRefusals(doc: unknown): Refusal[] {
  const out: Refusal[] = [];
  const walk = (node: unknown, path: Array<string | number>): void => {
    if (typeof node === 'string') {
      if (COMMAND_SUBSTITUTION.test(node)) {
        out.push(refuse(pointer(path), `This text contains shell command substitution (a backtick, $( or \${ ).`, FREE_TEXT_WHY));
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach((child, i) => walk(child, [...path, i])); return; }
    if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) walk(value, [...path, key]);
    }
  };
  walk(doc, []);
  return out;
}

// -------------------------------------------------------------------------------------------------
// 3. Cross-field rules that need the catalogue
// -------------------------------------------------------------------------------------------------

// The script table and the inverted coverage rule live in ./scripts.ts -- see its header for why
// the first version of this check failed open on every script it had no name for.
export { scriptsUsedIn, auditScripts } from './scripts.ts';

function languageRefusals(recipe: Recipe, catalogue: Catalogue, out: Refusal[]): string[] {
  const fonts = new Set<string>();
  const covered = new Set<string>();
  const wanted = [recipe.language, ...(recipe.other_languages ?? [])];

  // uniqueItems constrains other_languages against ITSELF and knows nothing about `language`, so a
  // recipe could name its primary language a second time in the switchable list. That is not a
  // second language, it is the same one twice, and it made the refusal pointer below wrong: the
  // index used to be computed with indexOf, which returns the FIRST match, so a duplicate printed
  // other_languages[-1] or pointed at somebody else's entry.
  (recipe.other_languages ?? []).forEach((name, i) => {
    if (name !== recipe.language) return;
    out.push(
      refuse(
        `other_languages[${i}]`,
        `'${name}' is already this fleet's primary language.`,
        'other_languages is the list a user can SWITCH TO from the settings screen. The primary ' +
          'language is always available, so naming it here adds nothing and makes the settings ' +
          'screen show the same entry twice. Remove it, or set `language` to the one you meant to ' +
          'be primary.',
      ),
    );
  });

  for (const [index, name] of wanted.entries()) {
    const entry = catalogue.languages.get(name);
    if (!entry) {
      const near = nearest(name, catalogue.languages.keys(), 3);
      out.push(
        refuse(
          index === 0 ? 'language' : `other_languages[${index - 1}]`,
          `'${name}' is not a language this image knows how to draw.${near.length ? ` Nearest: ${sentenceList(near)}.` : ''}`,
          'Choosing a language is also choosing its font packages, which is why there is no font list ' +
            'in a recipe for you to get wrong. A language we have no row for is refused rather than ' +
            'guessed at: installing nothing and hoping produces a first-boot screen of empty boxes, ' +
            'which is a perfectly valid file, an invisible failure in review, and the worst possible ' +
            'first impression for somebody meeting this machine.',
        ),
      );
      continue;
    }
    if (entry.fonts.length === 0) {
      out.push(
        refuse(
          index === 0 ? 'language' : `other_languages[${index - 1}]`,
          `'${name}' is in the catalogue but has no font package, so this image would have nothing to draw it with.`,
          'This is a gap to fill rather than a typo to correct: the language is known and the fonts ' +
            'are missing. Adding them is a change to catalogue/languages.tsv that a person reviews. ' +
            'Until then the honest answer is that we cannot build this fleet, not that we can build ' +
            'it and hope the boxes render.',
        ),
      );
      continue;
    }
    for (const font of entry.fonts) fonts.add(font);
    for (const script of entry.scripts) covered.add(script);
  }

  if (recipe.first_boot_message) {
    const what = scriptRefusalText(auditScripts(recipe.first_boot_message, covered), sentenceList);
    if (what) out.push(refuse('first_boot_message', what, SCRIPT_REFUSAL_WHY));
  }
  return [...fonts].sort();
}

function keyboardRefusals(recipe: Recipe, catalogue: Catalogue, out: Refusal[]): void {
  for (const [field, value] of [['keyboard', recipe.keyboard], ['second_script', recipe.second_script]] as const) {
    if (!value) continue;
    if (!catalogue.layouts.has(value)) {
      out.push(
        refuse(field, `'${value}' has no keyboard layout in the catalogue, so the compiler would have nothing to write into the image.`,
          'The schema knows the list of names this field accepts; this file knows what each of them ' +
            'actually is. A name that passes one and not the other means the two have drifted, which ' +
            'is a fault in catalogue/keyboards.tsv rather than in your recipe.'),
      );
    }
  }
  if (recipe.switch_scripts_with && !catalogue.toggles.has(recipe.switch_scripts_with)) {
    out.push(refuse('switch_scripts_with', `'${recipe.switch_scripts_with}' has no xkb option in the catalogue.`, ''));
  }
}

function appRefusals(recipe: Recipe, catalogue: Catalogue, out: Refusal[]): void {
  const desktop = desktopSettings(recipe);
  const removing = new Set(recipe.prune.also_remove ?? []);

  recipe.apps.forEach((name, index) => {
    const app = catalogue.apps.get(name);
    if (!app) {
      const near = nearest(name, catalogue.apps.keys(), 3);
      out.push(
        refuse(
          `apps[${index}]`,
          `'${name}' is not in the catalogue of applications this base image can install.${near.length ? ` Nearest: ${sentenceList(near)}.` : ''}`,
          'An application reaches a machine only by being named here, and a name that resolves to ' +
            'nothing would produce a file that promises an application and a laptop that does not ' +
            'have it. There is deliberately no free-text package field to fall back on: three ' +
            'different spellings of the same product are three different security surfaces, and the ' +
            'person reading the file cannot tell which one they got.',
        ),
      );
      return;
    }

    if (app.group && removing.has(app.group)) {
      out.push(
        refuse(
          `apps[${index}]`,
          `This recipe installs '${name}' and also removes the group "${app.group}", which '${name}' is part of.`,
          'One of those two instructions is going to lose, and a build that silently picks a winner ' +
            'is a build that has quietly changed what the customer asked for. Decide which you meant: ' +
            `drop "${app.group}" from prune.also_remove, or drop '${name}' from apps.`,
        ),
      );
    }

    if (app.capability === 'terminal' && !(recipe.policy === 'open' && desktop.can_reach_a_terminal)) {
      out.push(
        refuse(
          `apps[${index}]`,
          `'${name}' is a terminal, and this fleet is ${recipe.policy}${recipe.policy === 'open' ? ' with can_reach_a_terminal left false' : ''}.`,
          'A policy mode is a promise about what a person at the machine can do, and it has to be ' +
            'provable on a booted laptop or it is not worth selling. Installing a terminal defeats ' +
            'can_reach_a_terminal: false without contradicting any single field, which is exactly the ' +
            'kind of hole a schema cannot see. If this fleet needs a command line, it is policy: open ' +
            'with desktop.can_reach_a_terminal: true, stated out loud in the file.',
        ),
      );
    }

    if (app.capability === 'installs-software' && !desktop.can_install_apps) {
      out.push(
        refuse(
          `apps[${index}]`,
          `'${name}' installs software, and this fleet has desktop.can_install_apps false.`,
          'Same reason as a terminal: the restriction is a promise about the machine, and shipping ' +
            'the software installer is how the promise becomes decoration. Either set ' +
            'desktop.can_install_apps: true and mean it, or leave the application out.',
        ),
      );
    }
  });
}

function pruneRefusals(recipe: Recipe, out: Refusal[]): void {
  const keep = new Set(recipe.prune.also_keep ?? []);

  // also_keep ONLY means something under keep_only_the_apps_above: true.
  //
  // With keep_only false, nothing is swept, so there is nothing for a keep list to rescue: the
  // groups named here are exactly as installed with the field as without it. Proven by compiling
  // example-workstation (keep_only: false) with also_keep: [printing] and with also_keep:
  // [scanning] and with the field absent -- three byte-identical Containerfiles.
  //
  // Refused rather than noted, because unlike theme and updates.install_between this one is not a
  // feature waiting on an unbuilt layer. It is a request that has no meaning in the file it was
  // written in, and the person who wrote it believes they have protected their printers. The
  // schema's own principle: absent rather than present-and-ignored.
  if (recipe.prune.keep_only_the_apps_above === false && keep.size > 0) {
    out.push(
      refuse(
        'prune.also_keep',
        `also_keep names ${sentenceList([...keep])}, and keep_only_the_apps_above is false.`,
        'also_keep rescues capabilities from the sweep that "keep only the applications above" ' +
          'performs. With keep_only_the_apps_above false there is no sweep, so this line protects ' +
          'nothing and changes nothing about the image -- which is worse than leaving it out, ' +
          'because it reads like protection. Either set keep_only_the_apps_above: true, and the ' +
          'keep list starts doing what it says, or delete this line: those groups are already ' +
          'installed and nothing is coming for them.',
      ),
    );
  }

  for (const group of recipe.prune.also_remove ?? []) {
    if (keep.has(group)) {
      out.push(
        refuse(
          'prune',
          `"${group}" is in both also_keep and also_remove.`,
          'This is not a preference the build can resolve. Keeping one file out of a printing stack ' +
            'gives you a printer that prints nothing, and removing half of one gives you the same ' +
            'thing with a different report. Pick one.',
        ),
      );
    }
  }
}

function kioskRefusals(recipe: Recipe, catalogue: Catalogue, out: Refusal[]): void {
  if (recipe.policy !== 'kiosk' || !recipe.kiosk) return;

  // A kiosk opens exactly one window and there is no field saying which application it is. When a
  // recipe names more than one the compiler used to take whichever came first in the list, so
  // alphabetising the apps list silently changed what forty machines in six buildings opened. A
  // build that silently picks a winner is a build that has quietly changed what the customer asked
  // for -- the same sentence as the install-and-remove contradiction, and the same answer.
  const openable = kioskCandidates(recipe, catalogue);
  if (openable.length > 1) {
    out.push(
      refuse(
        'apps',
        `This kiosk names ${openable.length} applications the machine could open ` +
          `(${sentenceList(openable.map((a) => a.name))}), and nothing here says which one it opens.`,
        'A kiosk is one window showing one page. There is deliberately no field for choosing between ' +
          'two of them, so the honest answer is to name one application rather than to let the build ' +
          'pick. A machine that opens the wrong program still boots, still looks right, and is wrong ' +
          'in every building it is in.',
      ),
    );
  }
  if (openable.length === 0) {
    out.push(
      refuse(
        'apps',
        'This kiosk names no application the machine can open as its one window.',
        'A kiosk image that boots to a black screen is not a degraded product, it is a brick, and it ' +
          'would pass every check that only looks at what was removed. Name the application the ' +
          'machine opens.',
      ),
    );
  }

  let host: string;
  try {
    host = new URL(recipe.kiosk.opens).hostname;
  } catch {
    return; // the schema's pattern already refused it
  }
  if (!recipe.kiosk.allowed_sites.includes(host)) {
    out.push(
      refuse(
        'kiosk.allowed_sites',
        `The page this kiosk opens is on ${host}, which is not in allowed_sites.`,
        'A kiosk whose first request is blocked shows an error page to a member of the public and ' +
          'nothing else, forty times, in six buildings. Add the host it opens, or open a page on a ' +
          'host you allowed.',
      ),
    );
  }
}

// -------------------------------------------------------------------------------------------------
// 4. Rules about files outside the recipe
// -------------------------------------------------------------------------------------------------

function compatPath(repoRoot: string): string | null {
  for (const candidate of [
    join(repoRoot, '.auros-meta', 'hardware', 'compat.tsv'),
    join(dirname(repoRoot), 'hardware', 'compat.tsv'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function crossFileRefusals(
  recipe: Recipe,
  recipePath: string,
  repoRoot: string,
  out: Refusal[],
  notes: string[],
): void {
  const folder = basename(dirname(recipePath));
  if (recipe.name !== folder) {
    out.push(
      refuse('name', `'${recipe.name}' does not match the folder it sits in ('${folder}').`,
        "A recipe's name is also its image name and what the fleet console calls it, so the two have " +
          'to agree or a change to one fleet gets published as another.'),
    );
  }

  const customers = join(repoRoot, 'customers');
  if (existsSync(customers)) {
    for (const entry of readdirSync(customers).sort()) {
      const other = join(customers, entry, 'recipe.yaml');
      if (!existsSync(other) || resolve(other) === resolve(recipePath)) continue;
      let otherName: unknown;
      try {
        otherName = (parseYaml(readFileSync(other, 'utf8')) as Record<string, unknown> | null)?.['name'];
      } catch { continue; }
      if (otherName === recipe.name) {
        out.push(
          refuse('name', `'${recipe.name}' is already used by customers/${entry}/recipe.yaml.`,
            'Two fleets sharing one name means two organisations sharing one image, and the first ' +
              'time anybody notices is when one of them gets the other one\'s policy.'),
        );
      }
    }
  }

  // hardware/compat.tsv lives in the control repo. An unknown model is DISCLOSED, never skipped:
  // it is a note here and a stamp on the build report, so it stays a known unknown. A model a human
  // has declared unsupported is refused -- that call is theirs to make (spec section 9).
  const tsv = compatPath(repoRoot);
  const known = new Map<string, string>();
  if (tsv) {
    const lines = readFileSync(tsv, 'utf8').split('\n').filter((l) => l.trim() !== '');
    for (const line of lines.slice(1)) {
      const cells = line.split('\t');
      if (cells[0]) known.set(cells[0], cells[13] ?? '');
    }
  }
  recipe.hardware.models.forEach((model, index) => {
    const verdict = known.get(model);
    if (verdict === undefined) {
      // Named rather than indexed on purpose: this note is copied into the generated Containerfile,
      // and an index would make a customer who reordered their own hardware list produce a different
      // file for the same fleet.
      notes.push(
        `hardware.models: '${model}' has no row in hardware/compat.tsv yet. Allowed, and ` +
          'stamped on the build report and on the pull request as untested hardware, so it is a ' +
          'disclosed unknown rather than a skipped check.',
      );
      return;
    }
    if (verdict === 'unsupported') {
      out.push(
        refuse(`hardware.models[${index}]`, `'${model}' is recorded in hardware/compat.tsv as unsupported.`,
          'Declaring a model unsupported is a decision a human made deliberately and wrote down. ' +
            'Overriding it from a recipe would make that decision advisory, and the customer would ' +
            'find out on the day the laptops arrive.'),
      );
    }
  });

  // NOTHING ELSE MAY LIVE IN A RECIPE FOLDER.
  //
  // This was a hole with a fatal at the end of it. compile.ts used to resolve the base digest from
  // `base.lock` in this same directory -- the inside of a pull request from a stranger -- so two
  // lines added beside recipe.yaml pinned a whole fleet to a digest of the author's choosing, and
  // propagate.yml's staleness test (does the lockfile name the published digest?) then marked that
  // fleet permanently up to date. Never rebuilt, never patched, never noticed.
  //
  // The digest now comes only from the committed .locks/base.digest, and .locks/ is a directory a
  // pull request may not touch. This check is the other half: a recipe folder contains the recipe,
  // the generated Containerfile, the removal-floor ledger, and the logo the recipe names. A file
  // that is none of those is refused by name rather than ignored, because "the file IS the machine"
  // stops being true the moment part of the machine is an attachment nobody reads in a diff.
  const folderPath = dirname(recipePath);
  const allowed = new Set(['recipe.yaml', 'Containerfile', 'removal-floor.lock']);
  if (typeof recipe.organisation.logo === 'string') allowed.add(recipe.organisation.logo);
  let entries: string[] = [];
  try { entries = readdirSync(folderPath); } catch { entries = []; }
  for (const entry of entries.sort()) {
    if (allowed.has(entry)) continue;
    out.push(
      refuse(
        '(recipe folder)',
        `customers/${folder}/${entry} is not a file a recipe folder may contain.`,
        'A recipe folder holds recipe.yaml, the Containerfile generated from it, ' +
          'removal-floor.lock, and the logo the recipe names. Nothing else, because everything ' +
          'else here is read by something: a stray base.lock used to pin this fleet to a base ' +
          'image of the author\'s choosing and then convince the propagation job that the fleet ' +
          'was already up to date. Delete the file, or add it to the repository somewhere a ' +
          'reviewer will see it as a change rather than as furniture.',
      ),
    );
  }

  // The ratchet on must_remove_at_least. Monotonicity cannot be expressed in a schema; the lock file
  // beside the recipe records the last published floor and CI compares against it.
  const lock = join(dirname(recipePath), 'removal-floor.lock');
  if (existsSync(lock)) {
    const text = readFileSync(lock, 'utf8');
    const published = Number(/^MUST_REMOVE_AT_LEAST=(\d+)$/m.exec(text)?.[1] ?? NaN);
    const allowLower = Number(/^ALLOW_LOWER_TO=(\d+)$/m.exec(text)?.[1] ?? NaN);
    const reason = /^REASON=(.+)$/m.exec(text)?.[1]?.trim() ?? '';
    if (Number.isFinite(published) && recipe.prune.must_remove_at_least < published) {
      const permitted = Number.isFinite(allowLower) && allowLower === recipe.prune.must_remove_at_least && reason !== '';
      if (!permitted) {
        out.push(
          refuse(
            'prune.must_remove_at_least',
            `This lowers the removal floor from ${published} to ${recipe.prune.must_remove_at_least}.`,
            'The floor may rise freely and may only fall with a stated reason, recorded before the ' +
              'change that lowers it. An alarm you can turn down one point at a time is not an ' +
              'alarm, and this particular alarm is what catches upstream quietly putting back ' +
              'something we took out. To lower it, add ' +
              `ALLOW_LOWER_TO=${recipe.prune.must_remove_at_least} and a REASON= line to ` +
              'removal-floor.lock, MERGE THAT ON ITS OWN, and lower the recipe in a later change. ' +
              'This message is the working-tree half of the rule and cannot see a commit: the half ' +
              'that can is scripts/floor-ratchet.mjs, which CI runs on every pull request and ' +
              'which refuses a pull request that lowers the floor and grants itself permission to ' +
              'do so in the same diff.',
          ),
        );
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------
// The entry point
// -------------------------------------------------------------------------------------------------

export function validateDocument(tool: Toolchain, doc: unknown, recipePath: string): ValidationResult {
  const refusals: Refusal[] = [];
  const notes: string[] = [];

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return {
      ok: false,
      notes,
      refusals: [refuse('(top level)', 'A recipe is a block of named settings, not a list or a bare value.', '')],
    };
  }

  refusals.push(...reservedKeyRefusals(doc, tool.schema.knownKeys, tool.namedRefusals, tool.families));
  refusals.push(...freeTextRefusals(doc));
  refusals.push(...schemaRefusals(tool.schema, doc));

  // Everything below needs a document that is at least the right shape. Running the cross-field
  // rules on a document the schema already refused produces noise that buries the real problem.
  if (refusals.length > 0) return { ok: false, refusals, notes };

  const recipe = doc as unknown as Recipe;
  const fonts = languageRefusals(recipe, tool.catalogue, refusals);
  keyboardRefusals(recipe, tool.catalogue, refusals);
  appRefusals(recipe, tool.catalogue, refusals);
  pruneRefusals(recipe, refusals);
  kioskRefusals(recipe, tool.catalogue, refusals);
  crossFileRefusals(recipe, recipePath, tool.repoRoot, refusals, notes);

  // A field the machine ignores is a lie in a file whose claim is that it IS the machine. The theme
  // block is in the schema and the desktop layer that applies it is not written yet, so every recipe
  // that sets one carries the gap onto its build report and its pull request. Disclosure is the
  // honest interim; the alternative -- letting an accent colour and a text scale look applied -- is
  // the thing schema/README.md section 4 says not to do.
  if (recipe.theme && Object.keys(recipe.theme).length > 0) {
    notes.push(
      'theme: recorded in the image as data. The desktop layer that reads it is not built yet, so ' +
        'the preset, accent, text scale and cursor size do not change how these machines look today. ' +
        'This is stamped on the build report rather than left for the customer to notice.',
    );
  }

  // The SECOND field that reaches the image as nothing, found the same way as the theme one: by
  // compiling all three example recipes and asserting that every YAML difference between them shows
  // up somewhere in the generated Containerfile. Three recipes declare three different update
  // windows -- 21:00-05:00, 03:00-05:00, 04:00-06:00 -- and all three compile to an image definition
  // that is byte-identical in that respect, because nothing in the compiler reads the field. Only
  // `explain` prints it, which means the customer is TOLD a window that the machine does not keep.
  //
  // MEASURED, not assumed, in auros-base/update-agent/systemd/bootc-fetch-apply-updates.timer.d/
  // 10-auros.conf: the base resets every trigger list the vendor unit carries (OnCalendar= among
  // them) and then sets OnBootSec=3min, OnUnitInactiveSec=6h, RandomizedDelaySec=10min. There is no
  // calendar window on an Auros machine at all, and that is deliberate -- check U1 requires a fleet
  // to pull, stage and reboot within twenty minutes of the base moving, at whatever hour the base
  // moves. So this is not merely an unbuilt feature: a recipe layer that wrote the customer's window
  // into an OnCalendar= would break the propagation guarantee the whole architecture rests on.
  //
  // Which of those two wins is a design decision for a human, not something a validator settles at
  // eleven at night. What a validator CAN do is stop the file from claiming it.
  if (recipe.updates?.install_between) {
    notes.push(
      `updates.install_between: '${recipe.updates.install_between}' is recorded on the order and is ` +
        `NOT applied to these machines. The base ${UPDATE_CADENCE}, and carries no calendar window at ` +
        `all -- a fleet must be able to take a security rebuild ${U1_WINDOW} of it being ` +
        'published, whatever the hour. Honouring a quiet window and honouring that are different ' +
        'products. This is stamped on the build report rather than left for the customer to discover ' +
        'when a laptop restarts during a lesson.',
    );
  }

  const plan = planPrune(recipe, tool.catalogue, fonts);
  refusals.push(...plan.violations);

  // THE THIRD ONE, AND THE ONE THAT MATTERS MOST, BECAUSE IT HIDES BEHIND A REAL DIFFERENCE.
  //
  // Under keep_only_the_apps_above: true, `also_remove` cannot remove a single package that the
  // sweep would not already have taken. That is a property of planPrune, not a coincidence of these
  // three recipes: the keep-only universe is every group member plus every catalogue application,
  // `also_remove` draws from membersOf(catalogue, group), and a group member is by construction in
  // that universe. The only way a named group could add something is if the package were in the keep
  // set -- and a recipe that installs an application and removes its group is already refused, by
  // name, in appRefusals.
  //
  // MEASURED: emptying also_remove on example-school takes the removal plan from 52 packages to 52,
  // and on example-kiosk from 57 to 57. Zero difference. The kiosk recipe names ten groups. Five of
  // them are the only thing distinguishing its prune block from the school's.
  //
  // This is subtler than theme and updates.install_between, and it evaded the pairwise differ test
  // that found those two: naming a group DOES change the compiled Containerfile, because every
  // removal carries a `reason` string into prune-plan.json and the reason for a named group differs
  // from the reason for a keep-only sweep. So the bytes differ, the image is identical, and the
  // customer reads a build report that credits their decision for something the "and nothing else"
  // line had already done. Spec section 2: subtraction is the product. A field that appears to
  // subtract and does not is the worst place in this file for a lie to sit.
  //
  // Disclosed rather than refused: the list is not meaningless, it is the customer's statement of
  // intent, and it becomes load-bearing the moment keep_only is turned off. What must not stand is
  // the impression that it is doing the removing.
  if (recipe.prune.keep_only_the_apps_above && (recipe.prune.also_remove ?? []).length > 0) {
    const named = [...(recipe.prune.also_remove ?? [])].sort();
    notes.push(
      `prune.also_remove: ${sentenceList(named)} ${named.length === 1 ? 'is' : 'are'} already removed by ` +
        '"keep only the applications above", which takes everything this catalogue can name that is ' +
        'not in the apps list. Naming them changes the wording of the build report and removes no ' +
        'further package. The list is kept because it is the record of what was asked for, and it ' +
        'starts doing the removing the moment keep_only_the_apps_above is false.',
    );
  }

  if (refusals.length > 0) return { ok: false, refusals, notes };
  return { ok: true, refusals, notes, recipe, plan, fonts };
}
