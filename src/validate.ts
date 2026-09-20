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
}

export function loadToolchain(repoRoot: string): Toolchain {
  const schema = compileSchema(repoRoot);
  return {
    repoRoot,
    schema,
    catalogue: loadCatalogue(join(repoRoot, 'catalogue')),
    namedRefusals: reservedByName(schema.schema),
  };
}

// -------------------------------------------------------------------------------------------------
// 1. Reserved key families
// -------------------------------------------------------------------------------------------------

interface Family {
  readonly id: string;
  readonly title: string;
  readonly why: string;
  readonly exact: ReadonlyArray<string>;
  /** Substrings, matched against the normalised key. Only ever applied to keys the schema does not know. */
  readonly contains: ReadonlyArray<string>;
}

const FAMILIES: ReadonlyArray<Family> = [
  {
    id: 'base',
    title: 'A recipe cannot name what it is built on',
    why:
      'The FROM line is written by the compiler from auros.config.json, the one file that holds the ' +
      'namespace, and nothing in a recipe can influence it. Every fleet sits on the same foundation, ' +
      'and that is the only reason a security fix is one rebuild instead of a spreadsheet. A digest ' +
      'is refused for the same reason and it is the one worth sitting with: pinning an organisation ' +
      'to one exact image freezes them off the rebuild that carries the next security fix, which ' +
      'turns the machine we sold them into the abandoned machine we sold them a way out of. If a ' +
      'fleet genuinely needs a different base, that is a conversation with a person and possibly a ' +
      'customer we decline. It is never an edit to this file.',
    exact: ['from', 'base', 'image', 'registry', 'digest', 'containerfile', 'dockerfile', 'parent', 'upstream', 'tag', 'manifest'],
    contains: ['baseimage', 'fromimage', 'imageref', 'ociref', 'inheritfrom', 'basedigest', 'imagedigest', 'basetag', 'imagetag', 'rebase'],
  },
  {
    id: 'kernel',
    title: 'A recipe cannot choose a kernel, a driver or a boot argument',
    why:
      'The kernel, its modules, out-of-tree drivers and the boot command line belong to the base ' +
      'image, where one team patches them once for everybody. A per-recipe kernel is a fork wearing ' +
      'a smaller hat: the moment one organisation is on a different kernel, a security fix stops ' +
      'being one rebuild and becomes a spreadsheet. If what you want is a quieter or noisier boot, ' +
      'ask for that as a change to the base, where it becomes one audited setting for every fleet.',
    exact: ['kernel', 'kargs', 'cmdline', 'modules', 'dkms', 'drivers', 'firmware', 'grub', 'initramfs', 'microcode'],
    contains: ['kernelarg', 'kernelver', 'kernelpin', 'bootarg', 'kernelcmdline', 'kernelparam', 'moduleblacklist', 'initrd'],
  },
  {
    id: 'pins',
    title: 'Nothing can be held at a version',
    why:
      'There is no pin, no hold, no exclude and no minimum version, and the applications list has no ' +
      'shape that could carry one: an application name contains no digits at all, and every way of ' +
      'writing a version number needs one. That is the difference between a rule and a shape. A rule ' +
      'can be argued with at four in the afternoon on a deadline; a shape cannot. Holding a package ' +
      'back is how a machine ends up unpatched while still appearing maintained, which is the exact ' +
      'failure this product exists to fix. If a new version broke your fleet, that is a report we ' +
      'want and a fix in the base for everybody, not a line in one organisation\'s file that quietly ' +
      'keeps them behind.',
    exact: ['pin', 'pins', 'hold', 'holds', 'holdback', 'version', 'versions', 'exclude', 'excludes', 'freeze', 'lock', 'locks', 'constraint', 'constraints'],
    contains: ['pinned', 'pinning', 'versionlock', 'lockversion', 'minversion', 'maxversion', 'exactversion', 'packageversion', 'holdpackage', 'nover', 'downgrade'],
  },
  {
    id: 'scripts',
    title: 'A recipe cannot run code',
    why:
      'There is no script, no hook, no command and no environment variable. Every effect a recipe can ' +
      'have is a field with a name and a description, readable by somebody who does not write ' +
      'software. A shell line is the opposite of everything this file is for: unreadable to the ' +
      'person it is written for, unauditable in a pull request, and unbounded in what it can do ' +
      'inside a build that holds the key we sign images with. Orders arrive here as pull requests ' +
      'from strangers, and a format where a stranger can send us a command is a format we cannot ' +
      'accept. If the effect you need is not a field here, that is a conversation, not a command.',
    exact: ['run', 'script', 'scripts', 'hooks', 'hook', 'env', 'cmd', 'entrypoint', 'exec', 'shell', 'command', 'commands'],
    contains: ['postinstall', 'preinstall', 'firstbootscript', 'onboot', 'runscript', 'shellcmd', 'systemdexec', 'execstart', 'environment', 'bashline'],
  },
  {
    id: 'repos',
    title: 'A recipe cannot add a software source',
    why:
      'A new package source is a new set of people who can put code on these laptops, added by ' +
      'somebody filling in a form. The applications a recipe can name come from the catalogue inside ' +
      'the base image and from Flathub, both of which are reviewed once for everybody. Turning off a ' +
      'signature check is refused for the same reason and more strongly: it is the difference between ' +
      'installing what we published and installing whatever answered.',
    exact: ['repo', 'repos', 'repositories', 'copr', 'ppa', 'sources', 'mirror', 'mirrors', 'nogpgcheck', 'insecure', 'gpgcheck'],
    contains: ['extrarepo', 'addrepo', 'customrepo', 'thirdparty', 'packagesource', 'yumrepo', 'dnfrepo', 'flathubremote', 'remoteadd'],
  },
  {
    id: 'files',
    title: 'A recipe cannot drop arbitrary files into the image',
    why:
      'A file overlay is a script with extra steps: a unit file, a polkit rule or a sudoers drop-in ' +
      'placed by a recipe can undo every policy the image enforces, and nothing in a pull request ' +
      'would make that visible to a reviewer reading a list of application names. The things a recipe ' +
      'legitimately needs to place -- a logo, a first-boot sentence, a helpdesk number -- have their ' +
      'own named fields, and the compiler writes them as data rather than as instructions.',
    exact: ['files', 'file', 'overlay', 'overlays', 'patch', 'patches', 'config', 'configs', 'ostree', 'copy', 'add'],
    contains: ['systemdunit', 'unitfile', 'dropin', 'rpmostree', 'etcfiles', 'writefile', 'filecontent', 'sysctl', 'polkitrule', 'sudoers'],
  },
  {
    id: 'gates',
    title: 'There is no way to ask for less testing',
    why:
      'An unsigned or untested image can never reach a customer, and the strongest way to write that ' +
      'rule is a file that cannot express the request. Tests may only be added: look at the shape of ' +
      'hardware.also_test -- there is no also_skip and no exclude. A flag that skips a check is a ' +
      'flag somebody uses at the end of a long day, once, for a good reason, and then the check is ' +
      'advisory forever.',
    exact: ['skip', 'force', 'unsigned', 'signature', 'signing', 'bypass', 'override', 'overrides'],
    contains: ['skipcheck', 'skiptest', 'notest', 'nocheck', 'publishwithout', 'allowuntested', 'allowunsigned', 'nosign', 'ignorefailure', 'alsoskip', 'disablecheck'],
  },
  {
    id: 'secrets',
    title: 'No credential of any kind belongs in this file',
    why:
      'This repository is public by design -- it is how a customer keeps their exact operating system ' +
      'if we vanish -- so anything written here is published to the world, immediately and ' +
      'irrevocably. A wireless key in a git history is a wireless key in a git history forever. This ' +
      'is also a real gap rather than a complete answer: your laptops do need one wireless network ' +
      'and one printer on day one, and the intended answer is a sealed enrolment bundle handed over ' +
      'separately and referenced by approved_by.enrolment. That is designed and not built. See ' +
      'schema/README.md section 4.',
    exact: ['password', 'passphrase', 'secret', 'secrets', 'token', 'tokens', 'psk', 'credentials', 'credential', 'key', 'keys'],
    contains: ['apikey', 'wifipassword', 'wifikey', 'licencekey', 'licensekey', 'privatekey', 'sshkey', 'authtoken', 'clientsecret', 'accesskey'],
  },
  {
    id: 'rollback',
    title: 'The safety net is not optional',
    why:
      'greenboot is the thing that checks the machine reached a login screen after an update and puts ' +
      'the old image back if it did not. The fleet this product is built for is a nonprofit or a ' +
      'school with one overworked IT person, no out-of-band console and nobody who can be walked ' +
      'through a recovery. Switching off automatic updates or rollback converts a bad night into a ' +
      'person physically visiting a hundred and eighty laptops with a USB stick. updates.install_between ' +
      'moves the window; nothing closes it.',
    exact: ['rollback', 'greenboot', 'deployments', 'deployment'],
    contains: ['autoupdate', 'disableupdate', 'noupdate', 'updatesoff', 'pauseupdate', 'stopupdate', 'nogreenboot', 'norollback', 'staged', 'rollout'],
  },
  {
    id: 'claims',
    title: 'A recipe cannot make a general claim',
    why:
      'The website renders what is in these files, so a claim that cannot be written here cannot ' +
      'appear there. There is no field for a compatibility percentage, a savings figure, a device ' +
      'count or a testimonial, and that is prohibition 4.4 enforced by the format rather than by ' +
      'somebody remembering it. What you CAN write is evidence: under windows_apps.tested, a named ' +
      'program, the day a person ran it, and one of four results.',
    exact: ['compatibility', 'testimonial', 'testimonials', 'savings', 'casestudy', 'references', 'logos'],
    contains: ['customercount', 'devicecount', 'savingsfigure', 'successrate', 'compatpercent', 'casestudies', 'quotes'],
  },
];

function normalise(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function familyFor(key: string): Family | null {
  const n = normalise(key);
  for (const family of FAMILIES) if (family.exact.includes(n)) return family;
  for (const family of FAMILIES) for (const needle of family.contains) if (n.includes(needle)) return family;
  return null;
}

/** Walk every object in the document, reporting unknown keys that belong to a reserved family. */
function reservedKeyRefusals(doc: unknown, known: ReadonlySet<string>, alreadyNamed: ReadonlySet<string>): Refusal[] {
  const out: Refusal[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, path: Array<string | number>): void => {
    if (Array.isArray(node)) { node.forEach((child, i) => walk(child, [...path, i])); return; }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!known.has(key) && !alreadyNamed.has(key)) {
        const family = familyFor(key);
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

const SCRIPT_RANGES: ReadonlyArray<{ script: string; re: RegExp }> = [
  { script: 'Latin', re: /[A-Za-zÀ-ɏ]/ },
  { script: 'Devanagari', re: /[ऀ-ॿ]/ },
  { script: 'Bengali', re: /[ঀ-৿]/ },
  { script: 'Tamil', re: /[஀-௿]/ },
  { script: 'Telugu', re: /[ఀ-౿]/ },
  { script: 'Arabic', re: /[؀-ۿ]/ },
  { script: 'Greek', re: /[Ͱ-Ͽ]/ },
  { script: 'Hebrew', re: /[֐-׿]/ },
  { script: 'Cyrillic', re: /[Ѐ-ӿ]/ },
  { script: 'Thai', re: /[฀-๿]/ },
  { script: 'Ethiopic', re: /[ሀ-፿]/ },
];

export function scriptsUsedIn(text: string): string[] {
  return SCRIPT_RANGES.filter((s) => s.re.test(text)).map((s) => s.script);
}

function languageRefusals(recipe: Recipe, catalogue: Catalogue, out: Refusal[]): string[] {
  const fonts = new Set<string>();
  const covered = new Set<string>();
  const wanted = [recipe.language, ...(recipe.other_languages ?? [])];

  for (const name of wanted) {
    const entry = catalogue.languages.get(name);
    if (!entry) {
      const near = nearest(name, catalogue.languages.keys(), 3);
      out.push(
        refuse(
          name === recipe.language ? 'language' : `other_languages[${wanted.indexOf(name) - 1}]`,
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
          'language',
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
    const used = scriptsUsedIn(recipe.first_boot_message);
    const missing = used.filter((s) => !covered.has(s));
    if (missing.length > 0) {
      out.push(
        refuse(
          'first_boot_message',
          `This sentence is written in ${sentenceList(missing)}, and none of the languages on this fleet brings the fonts for that.`,
          'The first sentence a stranger reads is the one place a missing font is guaranteed to be ' +
            'seen, and it is the one place nobody is watching. Either add the language to ' +
            'other_languages, which brings its fonts, or write the message in a script this fleet ' +
            'can already draw.',
        ),
      );
    }
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
            'The floor may rise freely and may only fall with a stated reason and a second approval. ' +
              'An alarm you can turn down one point at a time is not an alarm, and this particular ' +
              'alarm is what catches upstream quietly putting back something we took out. To lower ' +
              `it, add ALLOW_LOWER_TO=${recipe.prune.must_remove_at_least} and a REASON= line to ` +
              'removal-floor.lock in a separate commit, which CODEOWNERS makes somebody else approve.',
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

  refusals.push(...reservedKeyRefusals(doc, tool.schema.knownKeys, tool.namedRefusals));
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

  const plan = planPrune(recipe, tool.catalogue, fonts);
  refusals.push(...plan.violations);

  if (refusals.length > 0) return { ok: false, refusals, notes };
  return { ok: true, refusals, notes, recipe, plan, fonts };
}
