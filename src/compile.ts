/**
 * recipe.yaml -> Containerfile.
 *
 * DETERMINISM. Same recipe plus same base digest must produce the same bytes, every time, on every
 * machine. That is not a nicety: spec section 6B's exit condition is verified by building twice in
 * one run and comparing content digests, and a compiler that reads the clock makes that check
 * impossible to pass for reasons that have nothing to do with the image. So:
 *
 *   - every list is sorted before it is emitted, by a fixed comparator;
 *   - no timestamp is ever read. SOURCE_DATE_EPOCH is honoured when the environment sets it, and
 *     otherwise defaults to midnight UTC on the recipe's own approved_by.date -- a value that comes
 *     out of the file being compiled rather than out of the machine compiling it;
 *   - nothing is looked up on the network, in a package database, or in the user's environment
 *     beyond that one variable and the base digest the caller passes in;
 *   - the generated file needs NO build context. Everything it installs it carries inline, so
 *     `podman build -f Containerfile` in an empty directory works, which is what makes the
 *     "rebuild your own operating system without us" claim testable rather than asserted.
 *
 * FREE TEXT NEVER REACHES A BUILD INSTRUCTION. Every string a human wrote -- the organisation name,
 * the helpdesk number, the first-boot sentence, the notes about which Windows programs work -- is
 * emitted as base64 and decoded into a file inside the image. Base64 is `[A-Za-z0-9+/=]`, so no byte
 * of it is ever a shell word, whatever it contains. The only recipe values written literally are
 * ones the schema constrains to a closed list or a strict pattern, and even those go through
 * `token()` below, which throws rather than emit a character it did not expect.
 *
 * Orders arrive in this repository as pull requests from strangers. That is the threat model.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AurosConfig } from './config.ts';
import { baseReference, imageNameFor } from './config.ts';
import type { Catalogue } from './catalogue.ts';
import { desktopSettings, type Recipe } from './recipe.ts';
import { pruneScript, removalReportShape, type PrunePlan } from './prune.ts';
import { wrap } from './refusal.ts';

export interface CompileOptions {
  readonly recipe: Recipe;
  readonly recipePath: string;
  readonly plan: PrunePlan;
  readonly fonts: ReadonlyArray<string>;
  readonly config: AurosConfig;
  readonly catalogue: Catalogue;
  /** The published base digest this build is pinned to for this one build. See below. */
  readonly baseDigest?: string | undefined;
  readonly sourceDateEpoch?: number | undefined;
  /** Disclosed unknowns from validation, stamped into the image so they stay known. */
  readonly notes?: ReadonlyArray<string>;
}

/**
 * Characters a compiler may put into a build instruction unquoted.
 *
 * Every value that reaches this function comes from a closed enum or a strict pattern in the schema.
 * The assertion is here anyway, because "the schema already checked it" is exactly the sentence that
 * precedes a schema being relaxed one afternoon by somebody who did not know this depended on it.
 */
const SAFE_TOKEN = /^[A-Za-z0-9._:@/+=-]+$/;

export class UnsafeToken extends Error {
  constructor(what: string, value: string) {
    super(
      `compile refuses to write ${what} into a build instruction: '${value}' contains a character ` +
        'this compiler does not emit unquoted. Every value that reaches here is supposed to come ' +
        'from a closed list or a strict pattern in recipe.schema.json, so this means the schema and ' +
        'the compiler have drifted apart, and the compiler is the one that stops.',
    );
    this.name = 'UnsafeToken';
  }
}

export function token(what: string, value: string): string {
  if (!SAFE_TOKEN.test(value)) throw new UnsafeToken(what, value);
  return value;
}

/**
 * A fixed total order over the Windows-programs evidence rows.
 *
 * Every field is part of the key, so two rows can only compare equal when they are the same row.
 * A partial key (app alone) would leave the order of two entries for one program up to whoever
 * wrote the file, which is the determinism hole this exists to close.
 */
type Tested = NonNullable<NonNullable<Recipe['windows_apps']>['tested']>;
export function sortTested(rows: Tested): Tested {
  return [...rows].sort(
    (a, b) =>
      a.app.localeCompare(b.app) ||
      a.date.localeCompare(b.date) ||
      a.result.localeCompare(b.result) ||
      (a.note ?? '').localeCompare(b.note ?? ''),
  );
}

/** Human text, on its way into the image as data rather than as an instruction. */
function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** A JSON document with sorted keys, so two equal documents are equal byte for byte. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The build clock, resolved without reading one.
 *
 * $SOURCE_DATE_EPOCH wins when it is set, because that is the contract every reproducible-build tool
 * already speaks. With nothing set the fallback is the recipe's own approval date, which is a
 * property of the file rather than of the machine: recompiling an unchanged recipe next March still
 * produces the same bytes. Using `now` here would make the determinism check in spec section 6B
 * impossible to pass, and using 0 would put a 1970 mtime on system files, which confuses enough
 * tooling to become its own problem (the base image made the same call -- see its Containerfile).
 */
export function resolveSourceDateEpoch(recipe: Recipe, env: NodeJS.ProcessEnv = process.env): number {
  const declared = env['SOURCE_DATE_EPOCH'];
  if (declared !== undefined && /^[0-9]+$/.test(declared)) return Number(declared);
  const approved = Date.parse(`${recipe.approved_by.date}T00:00:00Z`);
  if (Number.isFinite(approved)) return Math.floor(approved / 1000);
  return 0;
}

/** Where the base pin lives: committed, written only by propagate.yml, refused in a pull request. */
export const BASE_PIN = '.locks/base.digest';

/**
 * The base digest every fleet is pinned to, read from the COMMITTED file `.locks/base.digest`.
 *
 * A recipe cannot pin a base -- there is no field for it, and a recipe-level pin would freeze that
 * customer off the rebuild that carries the next security fix. There is one pin for the whole
 * repository. propagate.yml writes it when the base publishes and, in the same commit, regenerates
 * every Containerfile against it; the next poll rebuilds each fleet from those committed files.
 *
 * WHY A COMMITTED FILE AND NOT THE ENVIRONMENT (SYSTEM-REVIEW §2.11). This used to read
 * $AUROS_BASE_DIGEST, a per-build value. A Containerfile compiled with it differed from the committed
 * one, so the D28 drift check failed every pinned build -- the per-build pin and the committed
 * Containerfile could not both hold. Reading only committed files makes compile a pure function of
 * the repository, so the drift check stays meaningful and the committed file carries the digest a
 * customer rebuilding without us actually needs.
 *
 * WHY NOT customers/. That directory is the inside of a pull request from a stranger: a lockfile there
 * used to pin a fleet to a digest of the author's choosing. .locks/ is refused in any pull request
 * (scripts/ci-owned-files.mjs), and src/validate.ts refuses stray files in a recipe folder.
 *
 * No file: no pin, and the header says so. A file that is not exactly one digest is an error, never a
 * quiet fall back to the tag -- an unpinned build that looked pinned is how a rebuild stops moving.
 */
export function resolveBaseDigest(root: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, BASE_PIN), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const digest = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${BASE_PIN} does not hold exactly one sha256 digest, so no build may claim to be pinned by it: ${JSON.stringify(text.slice(0, 80))}`);
  }
  return digest;
}

const RULE = '# ' + '-'.repeat(97);

function commentBlock(text: string): string[] {
  return text.split('\n').map((line) => (line.trim() === '' ? '#' : `# ${line}`));
}

export function compile(options: CompileOptions): string {
  const { recipe, plan, config, catalogue, fonts } = options;
  const epochGiven =
    options.sourceDateEpoch !== undefined || /^[0-9]+$/.test(process.env['SOURCE_DATE_EPOCH'] ?? '');
  const epoch = options.sourceDateEpoch ?? resolveSourceDateEpoch(recipe);
  const base = token('the base image reference', baseReference(config, options.baseDigest));
  const image = imageNameFor(config, recipe.name);
  const out: string[] = [];

  // ---- header ----------------------------------------------------------------------------------
  out.push('# ' + '='.repeat(97));
  out.push(
    ...commentBlock(
      [
        'GENERATED FILE. DO NOT EDIT.',
        '',
        `Written by \`auros-recipe compile\` from customers/${recipe.name}/recipe.yaml.`,
        'Edit that file and recompile. An edit here is lost on the next rebuild, and the next rebuild',
        'is tonight.',
        '',
        `  recipe            ${recipe.name}`,
        `  base image        ${base}`,
        `  base pinned by    ${options.baseDigest ? `${BASE_PIN}, committed, written by propagate.yml when the base publishes` : `tag only -- ${BASE_PIN} is not committed, so no digest is claimed here`}`,
        `  namespace from    ${basename(config.configPath)} (the one file that holds it)`,
        `  SOURCE_DATE_EPOCH ${epoch}${epochGiven ? ' (given to the compiler)' : ` (midnight UTC on ${recipe.approved_by.date}, the recipe's approval date)`}`,
        `  architecture      ${config.arch}`,
        '',
        'THE BASE IS NOT CHOSEN HERE. The default of ARG BASE below comes from auros.config.json, the',
        'one file that holds the namespace. Nothing in a recipe can influence it -- not a registry, not',
        'a tag, not a digest. Every fleet sits on the same foundation, and that is the only reason a',
        'security fix is one rebuild instead of a spreadsheet.',
        '',
        'THE ONE OVERRIDE, AND WHY IT EXISTS. `--build-arg BASE=...` swaps the foundation for one local',
        'build. It is not reachable from recipe.yaml -- the validator refuses a recipe that names a base',
        'at all -- so it cannot put one fleet on a different foundation from another. It exists for the',
        'single case of a wind-down handover (DECISIONS.md D31): our registry is gone, the base has been',
        'built from the handed-over base build files, and this file has to point at that copy. Without',
        'it the handover would contain a command that cannot work, which is worse than no instruction.',
        '',
        'The digest pin is one committed file shared by every fleet. When the base moves, propagation',
        'rewrites it, regenerates this file in the same commit, and rebuilds. A pin that lived in the',
        'recipe would freeze this organisation off the rebuild that carries the next security fix.',
        '',
        'NO BUILD CONTEXT IS REQUIRED. Everything this file installs it carries inline. `podman build`',
        'against an empty directory produces the image. If Auros ceases operating, the customer receives',
        'this file with the base build files, and it can be executed rather than taken on trust. That',
        'is a handover term, not a licence to build or redistribute it.',
        '',
        'WHO THESE MACHINES ARE FOR, in the words of the person who ordered them:',
        '',
        ...wrap(recipe.for.trim().replace(/\s+/g, ' '), '    ').split('\n'),
      ].join('\n'),
    ),
  );
  if (options.notes && options.notes.length > 0) {
    out.push('#');
    // Sorted, because a customer who alphabetises their own hardware list must not produce a
    // different Containerfile. Every list this file emits is sorted for the same reason.
    out.push(
      ...commentBlock(
        ['DISCLOSED AT VALIDATION TIME:', ...[...options.notes].sort().map((n) => wrap(`  - ${n}`, '    ').replace(/^ {4}-/, '  -'))].join('\n'),
      ),
    );
  }
  out.push('# ' + '='.repeat(97));
  out.push('');
  // ARG-before-FROM is global scope: BASE is usable in the FROM line and nowhere else, which is
  // exactly the blast radius we want. The default IS the pin, so an ordinary `podman build` with no
  // arguments produces the same image it always did.
  out.push(`ARG BASE=${base}`);
  out.push('FROM ${BASE}');
  out.push('');
  out.push(`ARG SOURCE_DATE_EPOCH=${epoch}`);
  out.push('');
  out.push(
    ...commentBlock(
      '-euo pipefail for every RUN below rather than repeated at the top of each. A build step that\n' +
        'fails quietly in the middle of a pipeline is how an image ships half-configured, and\n' +
        'DECISIONS.md D19 is what that cost us the first time.',
    ),
  );
  out.push('SHELL ["/usr/bin/bash", "-euo", "pipefail", "-c"]');
  out.push('');

  // ---- data blobs ------------------------------------------------------------------------------
  const branding = canonicalJson({
    recipe: recipe.name,
    organisation: recipe.organisation.display_name,
    helpdesk: recipe.organisation.helpdesk,
    first_boot_message: recipe.first_boot_message ?? null,
    policy: recipe.policy,
    // The tested list is SORTED before it is emitted, like every other list this file writes.
    // canonicalJson sorts object KEYS; it does not touch array order, so without this a customer who
    // reorders two rows of their own test evidence produces a different Containerfile for the same
    // fleet, and "same recipe in, same image out" quietly stops being true. explain already sorts the
    // same list for display, which is how the two came to disagree.
    windows_apps: recipe.windows_apps
      ? { ...recipe.windows_apps, ...(recipe.windows_apps.tested ? { tested: sortTested(recipe.windows_apps.tested) } : {}) }
      : { enabled: false },
    theme: recipe.theme ?? {},
    machines: recipe.hardware.machines,
    approved_by: recipe.approved_by,
  });
  const report = canonicalJson(removalReportShape(plan, { base, generatedBy: 'auros-recipe compile', recipe }));

  out.push(RULE);
  out.push(
    ...commentBlock(
      'EVERY HUMAN STRING IN THIS RECIPE, AS DATA.\n' +
        '\n' +
        'base64 is [A-Za-z0-9+/=]. No byte of what a customer wrote is ever a shell word, whatever\n' +
        'they wrote, which is the whole reason this is one encoded blob rather than ten echo lines.\n' +
        'Decode it to read it:  base64 -d <<< \'<the string below>\'\n' +
        '\n' +
        'HONEST GAP: branding.json also carries the theme block, and the desktop layer that reads it\n' +
        'is not built yet. Today those fields reach the image as data and are applied by nothing.\n' +
        'Validation says so on every recipe that sets a theme, so it is a disclosed gap rather than a\n' +
        'field quietly doing nothing.',
    ),
  );
  out.push(RULE);
  const files: Array<[string, string, string]> = [
    ['/usr/share/auros/branding/branding.json', branding, '0644'],
    ['/usr/share/auros/prune-plan.json', report, '0644'],
    ['/usr/libexec/auros/auros-prune', pruneScript(), '0755'],
  ];
  if (recipe.policy === 'kiosk' && recipe.kiosk) files.push(['/etc/auros/kiosk.conf', kioskConf(recipe, catalogue), '0644']);
  if (recipe.organisation.logo) {
    const bytes = readFileSync(join(dirname(options.recipePath), recipe.organisation.logo));
    if (bytes.length > 512 * 1024) {
      throw new Error(
        `${recipe.organisation.logo} is ${Math.round(bytes.length / 1024)} KB. The limit is 512 KB: this file ` +
          'is carried inline in every build, and a wallpaper-sized logo makes every rebuild slower for ' +
          'everybody. Scale it down.',
      );
    }
    out.push(`RUN install -d -m 0755 /usr/share/auros/branding && \\`);
    out.push(`    printf '%s' '${bytes.toString('base64')}' | base64 -d > /usr/share/auros/branding/logo.png && \\`);
    out.push(`    chmod 0644 /usr/share/auros/branding/logo.png`);
    out.push('');
  }
  for (const [path, content, mode] of files) {
    out.push(`RUN install -d -m 0755 ${token('a directory path', dirname(path))} && \\`);
    out.push(`    printf '%s' '${b64(content)}' | base64 -d > ${token('a file path', path)} && \\`);
    out.push(`    chmod ${token('a file mode', mode)} ${token('a file path', path)}`);
    out.push('');
  }

  // ---- language, keyboard, clock ---------------------------------------------------------------
  const language = catalogue.languages.get(recipe.language);
  const primary = catalogue.layouts.get(recipe.keyboard);
  const second = recipe.second_script ? catalogue.layouts.get(recipe.second_script) : undefined;
  const toggle = recipe.switch_scripts_with ? catalogue.toggles.get(recipe.switch_scripts_with) : undefined;
  if (!language || !primary) throw new Error('compile was handed a recipe that validation should have refused (unknown language or keyboard)');

  const layouts = second ? `${primary.xkb},${second.xkb}` : primary.xkb;
  out.push(RULE);
  out.push(
    ...commentBlock(
      `LANGUAGE, KEYBOARD AND CLOCK\n` +
        `\n` +
        `  language   ${recipe.language} -> ${language.locale}\n` +
        `  keyboard   ${recipe.keyboard} -> ${layouts}\n` +
        (second ? `  second     ${recipe.second_script} -- ADDED to the Latin layout, never substituted for it.\n` +
                  `             The login screen and the disk-unlock prompt come up before any input method\n` +
                  `             is running, so a fleet whose primary layout cannot type a password is a fleet\n` +
                  `             nobody can log into.\n` : '') +
        `  timezone   ${recipe.timezone} -- a name, not an offset. An offset is wrong twice a year.`,
    ),
  );
  out.push(RULE);
  out.push(`RUN printf 'LANG=%s\\n' ${token('a locale', language.locale)} > /etc/locale.conf && \\`);
  out.push(`    printf 'KEYMAP=%s\\n' ${token('an xkb layout', primary.xkb.split(':')[0]!)} > /etc/vconsole.conf && \\`);
  out.push(`    install -d -m 0755 /etc/X11/xorg.conf.d && \\`);
  out.push(`    printf '%s' '${b64(xkbConf(layouts, toggle))}' | base64 -d > /etc/X11/xorg.conf.d/00-auros-keyboard.conf && \\`);
  out.push(`    ln -snf ../usr/share/zoneinfo/${token('a timezone', recipe.timezone)} /etc/localtime`);
  out.push('');

  // ---- what goes on ----------------------------------------------------------------------------
  const rpms = [...new Set([...fonts, ...plan.install.rpm])].sort();
  const flatpaks = [...plan.install.flatpak].sort();
  out.push(RULE);
  out.push(
    ...commentBlock(
      `WHAT GOES ON: ${recipe.apps.length} applications, plus the fonts ${recipe.language} needs.\n` +
        '\n' +
        'The fonts are not in the recipe. Choosing a language chooses them, so there is no font list\n' +
        'for anybody to get wrong, and no first-boot screen of empty boxes.',
    ),
  );
  out.push(RULE);
  if (rpms.length > 0) {
    out.push(`RUN dnf -y install \\`);
    rpms.forEach((pkg, i) => out.push(`        ${token('a package name', pkg)}${i === rpms.length - 1 ? ' && \\' : ' \\'}`));
    out.push(`    dnf -y clean all`);
    out.push('');
  }
  if (flatpaks.length > 0) {
    out.push(
      ...commentBlock(
        'Flathub applications are declared, not installed: flatpak-preinstall(1) materialises them on\n' +
          'the machine. Spec section 3 -- userspace apps update themselves and are explicitly not our\n' +
          'security surface. The image owns everything that can root the machine; Flatpaks own the rest.',
      ),
    );
    out.push('RUN install -d -m 0755 /etc/flatpak/preinstall.d && \\');
    flatpaks.forEach((id, i) => {
      const safe = token('a Flatpak application id', id);
      const slug = safe.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      out.push(`    printf '[Flatpak Preinstall %s]\\n' ${safe} > /etc/flatpak/preinstall.d/${slug}.preinstall${i === flatpaks.length - 1 ? '' : ' && \\'}`);
    });
    out.push('');
  }

  if (recipe.windows_apps?.enabled) {
    out.push(RULE);
    out.push(
      ...commentBlock(
        'WINDOWS PROGRAMS -- the honest capability (spec section 11.3, prohibition 4.2).\n' +
          '\n' +
          'This installs a compatibility layer. It does not promise that any particular program runs.\n' +
          'What this fleet has actually tested is in branding.json above, as a named program, the day\n' +
          'somebody ran it, and one of four results. Office and Adobe are on the "does not come across"\n' +
          'list and no amount of configuration here changes that -- see DECISIONS.md D16.',
      ),
    );
    out.push(RULE);
    out.push("RUN printf '[Flatpak Preinstall com.usebottles.bottles]\\n' > /etc/flatpak/preinstall.d/com-usebottles-bottles.preinstall");
    out.push('');
  }

  // ---- policy ----------------------------------------------------------------------------------
  const desktop = desktopSettings(recipe);
  out.push(RULE);
  out.push(
    ...commentBlock(
      `POLICY: ${recipe.policy}\n` +
        '\n' +
        'There is exactly one base image and four policy modes. The mode is chosen in this derived\n' +
        'layer, which is the only place it can be chosen without turning four modes into four bases.\n' +
        (recipe.policy === 'kiosk'
          ? '\nkiosk removes the desktop shell and the display manager -- the binaries a person at the\n' +
            'machine could reach a desktop through -- and a check on every build asserts they are absent\n' +
            'from the filesystem. It does NOT mean everything else is gone: shared libraries the closure\n' +
            'will not release stay, and this image is therefore meaningfully larger than a purpose-built\n' +
            'minimal one. We trade that size for the property that a security fix is still one rebuild.\n' +
            'See DECISIONS.md D12. The build reports the real measured size.'
          : `\n  install applications   ${desktop.can_install_apps ? 'yes' : 'no'}\n` +
            `  reach a terminal       ${desktop.can_reach_a_terminal ? 'yes' : 'no'}\n` +
            `  guided first boot      ${desktop.guided_first_boot ? 'yes' : 'no'}`),
    ),
  );
  out.push(RULE);
  out.push(`RUN /usr/libexec/auros/apply-policy ${token('a policy mode', recipe.policy)}`);
  out.push('');

  // ---- the prune -------------------------------------------------------------------------------
  out.push(RULE);
  out.push(
    ...commentBlock(
      'THE PRUNE. This is the product.\n' +
        '\n' +
        `  ${plan.remove.length} packages named for removal` +
        (plan.keepOnly ? ', from "keep only the applications above"' : ', from the groups this recipe listed') +
        '\n' +
        `  the floor is ${plan.floor}: a build that removes fewer FAILS\n` +
        `  ${plan.protectedKept.length} packages are kept whatever anybody asked, because the machine cannot start,\n` +
        '  update or roll back without them\n' +
        '\n' +
        'auros-prune resolves the removal transaction before executing it and aborts if the closure\n' +
        'would take a protected package with it, then removes, then verifies every protected package\n' +
        'is still installed. That last step does not depend on parsing anybody\'s output format, which\n' +
        'is why it is the one that counts.',
    ),
  );
  out.push(RULE);
  out.push('RUN /usr/libexec/auros/auros-prune');
  out.push('');

  // ---- labels ----------------------------------------------------------------------------------
  out.push(RULE);
  out.push(...commentBlock('Labels last, so editing one does not invalidate the cache for every step above it.'));
  out.push(RULE);
  const labels: Array<[string, string]> = [
    ['org.opencontainers.image.title', image],
    ['org.opencontainers.image.base.name', base],
    ['org.opencontainers.image.source', `https://github.com/${config.repos['recipes'] ?? `${config.org}/${config.product}-recipes`}`],
    ['org.opencontainers.image.vendor', config.org],
    [`${config.product}.recipe`, recipe.name],
    [`${config.product}.policy`, recipe.policy],
    [`${config.product}.machines`, String(recipe.hardware.machines)],
    [`${config.product}.prune.floor`, String(plan.floor)],
    [`${config.product}.prune.named`, String(plan.remove.length)],
    [`${config.product}.size-budget-gb`, String(recipe.size_budget_gb)],
    // The three below exist so the CHECK MATRIX can be driven from the built artifact rather than
    // from a workflow's memory of what the recipe said. run-matrix.sh wants --profiles, run-boot.sh
    // wants --locale and --keymap for B4, and reading them off the image means the thing under test
    // supplies the parameters of its own test. Before this, build-recipe.yml passed none of them.
    [`${config.product}.test-profiles`, testProfiles(recipe).join(',')],
    [`${config.product}.locale`, language.locale],
    [`${config.product}.keymap`, primary.xkb.split(':')[0]!],
    [`${config.product}.source-date-epoch`, String(epoch)],
  ];
  labels.sort((a, b) => a[0].localeCompare(b[0]));
  out.push('LABEL \\');
  labels.forEach(([key, value], i) => {
    out.push(`    ${token('a label name', key)}="${quotedValue(value)}"${i === labels.length - 1 ? '' : ' \\'}`);
  });
  out.push('');

  out.push(RULE);
  out.push(
    ...commentBlock(
      'The structural check, run here as well as in CI. Here it fails the build at the point of damage;\n' +
        'in CI it is the gate. It is deliberately not tolerated with `|| true` -- an image that cannot be\n' +
        'a bootable host is worth nothing, and finding that out at build time beats finding it out in QEMU.',
    ),
  );
  out.push(RULE);
  out.push('RUN bootc container lint');
  out.push('');

  return out.join('\n');
}

/** Label values are quoted, so they may hold more than a bare token -- but not a quote or a backslash. */
function quotedValue(value: string): string {
  if (/["\\$`]/.test(value)) throw new UnsafeToken('a label value', value);
  return value;
}

function xkbConf(layouts: string, toggle: string | undefined): string {
  return [
    '# Generated by auros-recipe compile. Do not edit in the image.',
    'Section "InputClass"',
    '    Identifier "auros-keyboard"',
    '    MatchIsKeyboard "on"',
    `    Option "XkbLayout" "${layouts}"`,
    ...(toggle ? [`    Option "XkbOptions" "${toggle}"`] : []),
    'EndSection',
    '',
  ].join('\n');
}

/**
 * Every application on a kiosk recipe that this compiler could start as the one window, in a fixed
 * order. Exported because validate.ts refuses ambiguity using the same list, and two copies of
 * "which apps count" is how the validator and the compiler come to disagree about a fleet.
 */
/**
 * The QEMU profiles this fleet's image must be booted on, as the check matrix names them.
 *
 * WHY THIS IS IN THE COMPILER AND NOT ONLY IN A WORKFLOW. `hardware.also_test` was, until this
 * function existed, a field that reached NOTHING. schema/README.md sells it as "adds a virtual test
 * machine", README.md sells it as the reason "it cannot ask for less testing", and three example
 * recipes set three different values -- and every one of them compiled to a byte-identical image
 * definition. A recipe could say `also_test: [uefi-secureboot]` or say nothing at all and get the
 * same build and the same tests. That is precisely the lie schema/README.md section 4 names: "a
 * field the machine does not honour is a lie in a file whose whole claim is that it is the machine."
 *
 * So the profile list is stamped on the image as a label. CI reads it back off the built artifact
 * with `podman inspect` and hands it to matrix/run/run-matrix.sh --profiles, which REQUIRES a recipe
 * to name its profiles and dies otherwise ("a recipe must name its profiles"). The image therefore
 * carries the statement of what it must survive, and the statement travels with the bytes rather
 * than living in a workflow file that a different workflow can forget to copy.
 *
 * uefi-modern is ALWAYS in the list, whatever the recipe said. It is the profile the update group
 * runs on, and a fleet that never boots the modern-firmware profile has not been tested on the
 * machine the update path is proven on. The recipe may only ADD to this; the schema has no
 * also_skip, and neither does this function.
 */
export const ALWAYS_TESTED_PROFILE = 'uefi-modern';

export function testProfiles(recipe: Recipe): string[] {
  const asked = recipe.hardware.also_test ?? [];
  return [...new Set([ALWAYS_TESTED_PROFILE, ...asked])].sort().map((p) => token('a test profile id', p));
}

export function kioskCandidates(recipe: Recipe, catalogue: Catalogue): Array<{ name: string; ref: string }> {
  return recipe.apps
    .map((name) => catalogue.apps.get(name))
    .filter((app): app is NonNullable<typeof app> => app !== undefined && app.kind === 'flatpak')
    .map((app) => ({ name: app.name, ref: app.ref }))
    .sort((a, b) => a.ref.localeCompare(b.ref) || a.name.localeCompare(b.name));
}

/**
 * The one application a kiosk machine runs.
 *
 * The URL does end up on a command line, because it is a browser argument and there is nowhere else
 * for it to be. What makes that safe is its shape rather than its handling: the schema's pattern for
 * `kiosk.opens` admits https, a lowercase hostname and a restricted path, and nothing else -- no
 * space, no quote, no dollar, no semicolon. `token()` re-checks it here, and throws rather than
 * write a character it did not expect, so a future relaxation of that pattern breaks the compiler
 * loudly instead of producing a kiosk that runs whatever the order form said.
 */
function kioskConf(recipe: Recipe, catalogue: Catalogue): string {
  const kiosk = recipe.kiosk!;
  // Sorted, not "the first one in the list". Selecting by the order a person happened to type their
  // apps in meant that alphabetising the apps list changed which program the kiosks in six buildings
  // actually opened, with no diff anywhere a reviewer would look, and it made the Containerfile
  // depend on an ordering the rest of this compiler deliberately throws away.
  const candidates = kioskCandidates(recipe, catalogue);
  const browser = candidates[0];
  if (!browser) {
    throw new Error(
      `customers/${recipe.name}: a kiosk needs an application to run, and none of this recipe's apps is ` +
        'one this compiler knows how to start in kiosk mode. A kiosk image that boots to a black screen ' +
        'is not a degraded product, it is a brick, and it would pass every check that only looks at what ' +
        'was removed.',
    );
  }
  if (candidates.length > 1) {
    // Defence in depth: validate.ts refuses this first, with a sentence. Reaching here means a
    // caller skipped validation, and the rule that the compiler never picks a winner on its own
    // still holds -- see appRefusals, which says exactly that about installing and removing.
    throw new Error(
      `customers/${recipe.name}: this kiosk names ${candidates.length} applications the machine could ` +
        `open (${candidates.map((a) => a.name).join(', ')}) and there is no field saying which one it ` +
        'opens. The compiler will not choose for you: a kiosk that opens a different program from the ' +
        'one the customer had in mind boots, looks right, and is wrong in forty buildings.',
    );
  }
  const url = token('the kiosk address', kiosk.opens);
  const exec = `flatpak run ${token('a Flatpak application id', browser.ref)} --kiosk ${url}`;
  return [
    '# /etc/auros/kiosk.conf -- generated by auros-recipe compile. Do not edit in the image.',
    `# One window, ${kiosk.allowed_sites.length} permitted hosts, session wiped after ${kiosk.forget_session_after_minutes} minutes.`,
    '#',
    '# THE ALLOW-LIST IS NOT A SECURITY BOUNDARY. It bounds which hostnames this window may reach. It',
    '# does not bound what a person can do once they are on one of them: a large third-party site',
    '# brings outbound links, embedded frames and viewers with it. Do not sell this as containment.',
    `KIOSK_EXEC="${exec}"`,
    `KIOSK_ALLOWED_SITES="${[...kiosk.allowed_sites].sort().map((h) => token('an allowed host', h)).join(' ')}"`,
    `KIOSK_FORGET_AFTER_MINUTES=${kiosk.forget_session_after_minutes}`,
    `KIOSK_PRINTING=${kiosk.printing ? 'yes' : 'no'}`,
    `KIOSK_USB_STORAGE=${kiosk.usb_storage ? 'yes' : 'no'}`,
    ...(kiosk.restart_daily_at ? [`KIOSK_RESTART_DAILY_AT=${token('a time of day', kiosk.restart_daily_at)}`] : []),
    '',
  ].join('\n');
}
