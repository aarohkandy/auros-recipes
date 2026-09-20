/**
 * `explain` -- the recipe in plain English, for somebody who is not an engineer.
 *
 * This is not a debugging aid. It is the text that becomes the pull request body on an order, and
 * the thing the person who signs off on a fleet actually reads. They are an IT coordinator at a
 * school with a hundred and eighty laptops, not a container engineer, and in eighteen months they
 * are the only person who can say what these machines are.
 *
 * Three rules it has to keep, in order of how easy they are to break:
 *
 *   1. SAY WHAT GETS DELETED. Subtraction is the product. If this section is a summary line and the
 *      installation section is a list, the output is a brochure for the wrong half.
 *
 *   2. SAY WHAT IT WILL NOT DO, unprompted, before anyone asks. Prohibition 4.2: never claim an app
 *      migrates when it does not. The section headed "what this will NOT do" exists because the
 *      alternative is a customer discovering it in month two, which is where organisations are lost.
 *
 *   3. NEVER PRINT A NUMBER NOBODY MEASURED. Package counts here are what the recipe NAMED. The
 *      closure and the byte totals come from the build, and this text says so rather than quietly
 *      implying that a plan is a result.
 */

import type { Catalogue } from './catalogue.ts';
import type { AurosConfig } from './config.ts';
import { baseReference } from './config.ts';
import type { PrunePlan } from './prune.ts';
import { desktopSettings, type Recipe } from './recipe.ts';
import { sentenceList, wrap } from './refusal.ts';

export interface ExplainOptions {
  readonly recipe: Recipe;
  readonly plan: PrunePlan;
  readonly catalogue: Catalogue;
  readonly config: AurosConfig;
  readonly fonts: ReadonlyArray<string>;
  readonly baseDigest?: string | undefined;
  readonly notes?: ReadonlyArray<string>;
}

function heading(text: string): string[] {
  return ['', text.toUpperCase(), '-'.repeat(text.length)];
}

function para(text: string): string {
  return wrap(text, '');
}

/**
 * A labelled row, wrapped like everything else in this document.
 *
 * These lines used to be plain template strings, so a fleet with a second keyboard script or three
 * hardware models produced a line past a hundred characters while every paragraph around it wrapped
 * at ninety-six. This text is a pull request body somebody reads in a browser on a phone, not a log,
 * and a row that runs off the side is a row that is skipped.
 *
 * A value with no space in it -- a digest, a package reference -- is still emitted whole rather than
 * broken, because a digest cut in half is worse than a long line.
 */
const LABEL_WIDTH = 19;
export function field(label: string, value: string, width = LABEL_WIDTH): string {
  const indent = ' '.repeat(2 + width);
  const wrapped = wrap(value, indent);
  return `  ${label.padEnd(width)}${wrapped.slice(indent.length)}`;
}

export function explain(options: ExplainOptions): string {
  const { recipe, plan, catalogue, config, fonts } = options;
  const desktop = desktopSettings(recipe);
  const out: string[] = [];

  out.push(`${recipe.organisation.display_name} -- ${recipe.hardware.machines} machine${recipe.hardware.machines === 1 ? '' : 's'}`);
  out.push('='.repeat(72));
  out.push('');
  out.push(para(recipe.for.trim().replace(/\s+/g, ' ')));

  // ---- what these machines are -----------------------------------------------------------------
  out.push(...heading('What these machines are'));
  out.push('');
  out.push(field('Speaks', `${recipe.language}${recipe.other_languages?.length ? `, and a user can switch to ${sentenceList(recipe.other_languages)} without a rebuild` : ''}`));
  out.push(field('Keyboard', `${recipe.keyboard}${recipe.second_script ? `, with ${recipe.second_script} added -- press ${recipe.switch_scripts_with} to switch` : ''}`));
  out.push(field('Clock', recipe.timezone));
  out.push(field('Hardware', sentenceList(recipe.hardware.models)));
  out.push(field('Help is', `${recipe.organisation.helpdesk.label}, ${recipe.organisation.helpdesk.phone}, printed on the machine's own help screen`));
  out.push(field('Built on', baseReference(config, options.baseDigest)));
  out.push('');
  out.push(
    para(
      'That last line is the same for every organisation we build for, and it is the reason a ' +
        'security fix reaches these laptops as one rebuild rather than as a project. Nothing in this ' +
        'order could change it.',
    ),
  );

  // ---- what gets installed ---------------------------------------------------------------------
  out.push(...heading(`What is on them: ${recipe.apps.length} application${recipe.apps.length === 1 ? '' : 's'}`));
  out.push('');
  for (const name of [...recipe.apps].sort()) {
    const app = catalogue.apps.get(name);
    out.push(`  - ${name}${app ? ` (${app.kind === 'flatpak' ? 'from Flathub, updates itself' : 'part of the image'})` : ''}`);
  }
  out.push('');
  out.push(
    para(
      (recipe.apps.length === 1
        ? 'That is the whole list. One application is what will be on the machine, not one application and three hundred other things.'
        : `That is the whole list. ${recipe.apps.length} applications is what will be on the machine, not ${recipe.apps.length} plus whatever came with it.`) +
        (fonts.length
          ? ` The fonts ${recipe.language} needs (${sentenceList([...fonts])}) come with the language; you did not have to ask for them and could not have got them wrong.`
          : ''),
    ),
  );

  // ---- what gets deleted -----------------------------------------------------------------------
  out.push(...heading('What gets deleted'));
  out.push('');
  if (plan.keepOnly) {
    out.push(para('Everything else. The recipe says "keep only the applications above", so the list you just read is also the keep list -- one list, which is why the two cannot drift apart.'));
  } else {
    out.push(para('The ordinary desktop stays, and these groups come out of it.'));
  }
  out.push('');
  const byGroup = new Map<string, string[]>();
  for (const item of plan.remove) {
    const key = item.group ?? 'not one of the applications above';
    const members = byGroup.get(key) ?? [];
    members.push(item.ref);
    byGroup.set(key, members);
  }
  for (const [group, members] of [...byGroup].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`  ${group} -- ${members.length} package${members.length === 1 ? '' : 's'}`);
    out.push(wrap(members.sort().join(', '), '      '));
  }
  out.push('');
  out.push(
    para(
      `Those are the ${plan.remove.length} packages this recipe names by hand. The real number will be ` +
        'larger, because removing a package releases the things only it needed, and that is most of ' +
        `the work. The build measures the real number and this fleet's floor is ${plan.floor}: if the ` +
        'build removes fewer than that, it fails and nothing is published. The floor exists to catch ' +
        'the quiet case -- upstream putting something back that we took out, with no error anywhere.',
    ),
  );
  out.push('');
  out.push(para(`Every build writes a report next to the recipe listing each package that went, its version and the bytes it reclaimed. Those are measured on the built image, not estimated here.`));
  if (plan.notPreinstalled.length > 0) {
    out.push('');
    out.push(para(`${sentenceList([...plan.notPreinstalled])} ${plan.notPreinstalled.length === 1 ? 'is' : 'are'} not installed in the first place -- Flathub applications only reach a machine if the recipe asks for them, so there is nothing to remove.`));
  }

  // ---- what is kept no matter what -------------------------------------------------------------
  out.push(...heading('What stays, whatever anybody asks'));
  out.push('');
  out.push(
    para(
      `${plan.protectedKept.length} packages cannot be removed by any recipe, and they are printed here on every build so ` +
        'that the guarantee is something you can see rather than something you have to trust. Read ' +
        'their jobs in order and it is one sentence: reach the network, notice a new image, install ' +
        'it, check we signed it, prove it boots, put the old one back if it does not.',
    ),
  );
  out.push('');
  const roles = new Map<string, string[]>();
  for (const entry of plan.protectedKept) {
    const members = roles.get(entry.role) ?? [];
    members.push(entry.pkg);
    roles.set(entry.role, members);
  }
  for (const [role, members] of [...roles].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`  ${role}`);
    out.push(wrap(members.sort().join(', '), '      '));
  }
  out.push('');
  out.push(
    para(
      'A laptop that cannot update is not a laptop with one fewer feature. It is a laptop frozen at ' +
        'the security state of the day it was imaged, getting worse every week, that still boots and ' +
        'logs in and looks completely fine. That is the orphaned machine in the store cupboard, which ' +
        'is the exact object this product exists to replace.',
    ),
  );

  // ---- policy ----------------------------------------------------------------------------------
  out.push(...heading(`The rules in force: ${recipe.policy}`));
  out.push('');
  out.push(para(POLICY_PROSE[recipe.policy]));
  out.push('');
  if (recipe.policy === 'kiosk' && recipe.kiosk) {
    out.push(field('Opens', `${recipe.kiosk.opens}`, 25));
    out.push(field('May reach', `${sentenceList([...recipe.kiosk.allowed_sites].sort())}`, 25));
    out.push(field('Session wiped after', `${recipe.kiosk.forget_session_after_minutes} minutes`, 25));
    out.push(field('Printing', `${recipe.kiosk.printing ? 'yes' : 'no'}`, 25));
    out.push(field('USB storage', `${recipe.kiosk.usb_storage ? 'yes' : 'no'}`, 25));
    if (recipe.kiosk.restart_daily_at) out.push(field('Restarts daily at', `${recipe.kiosk.restart_daily_at}`, 25));
    out.push('');
    out.push(
      para(
        'Two things about that list, both of which we would rather you heard from us. The allow-list ' +
          'bounds which addresses the window may reach; it does not bound what somebody can do once ' +
          'they are on one of them, because a large site brings outbound links, embedded frames and ' +
          'file viewers with it. Do not describe this as "locked to four sites". And "no desktop" ' +
          'means the desktop shell and the login manager are not in the image at all, which a check ' +
          'proves against the filesystem on every build -- but shared libraries that the dependency ' +
          'untangling will not release stay, so this image is bigger than a purpose-built minimal one ' +
          'would be. We report the size we actually measured.',
      ),
    );
  } else {
    out.push(field('Install applications', `${desktop.can_install_apps ? 'yes' : 'no'}`, 25));
    out.push(field('Reach a command line', `${desktop.can_reach_a_terminal ? 'yes' : 'no'}`, 25));
    out.push(field('Taskbar and start menu', `${desktop.taskbar_and_start_menu ? 'yes' : 'no'}`, 25));
    out.push(field('Familiar folder names', `${desktop.familiar_folder_names ? 'yes' : 'no'}`, 25));
    out.push(field('Guided first boot', `${desktop.guided_first_boot ? 'yes' : 'no'}`, 25));
  }
  out.push('');
  out.push(field('Updates install between', `${recipe.updates?.install_between ?? '04:00-06:00 (the default)'}`, 25));
  out.push('');
  out.push(
    para(
      'There is no setting for switching updates off, and that is deliberate. If one arrives badly, ' +
        'the machine checks it reached a login screen and puts the previous image back by itself. One ' +
        'previous image is kept, not several -- that is the real guarantee and we will not describe it ' +
        'as more than it is.',
    ),
  );

  if (recipe.theme && Object.keys(recipe.theme).length > 0) {
    out.push(...heading('How it looks'));
    out.push('');
    if (recipe.theme.preset) out.push(field('Theme', `${recipe.theme.preset}`, 19));
    if (recipe.theme.accent) out.push(field('Accent colour', `${recipe.theme.accent}`, 19));
    if (recipe.theme.text_scale) out.push(field('Text size', `${recipe.theme.text_scale}x`, 19));
    if (recipe.theme.cursor_size) out.push(field('Pointer', `${recipe.theme.cursor_size}`, 19));
    out.push('');
    out.push(
      para(
        'Read this one carefully, because it is the part we are not finished with. Those settings are ' +
          'written into the image as data and the layer that applies them is not built yet, so today ' +
          'they do not change how the machines look. We would rather say that here than let you find ' +
          'it on the first laptop. It is on the build report too.',
      ),
    );
  }

  // ---- windows programs ------------------------------------------------------------------------
  out.push(...heading('Windows programs'));
  out.push('');
  if (recipe.windows_apps?.enabled) {
    out.push(para('This image includes a Windows-compatibility layer. It is offered as a capability and not as a promise, so here is exactly what somebody sat down and tested on one of these machines:'));
    out.push('');
    for (const entry of [...(recipe.windows_apps.tested ?? [])].sort((a, b) => a.app.localeCompare(b.app))) {
      out.push(`  ${entry.app}`);
      out.push(`      ${entry.result}, tested ${entry.date}`);
      if (entry.note) out.push(wrap(entry.note, '      '));
    }
    if (!recipe.windows_apps.tested?.length) {
      out.push('  Nothing has been tested yet. Until something is on this list, the honest position is');
      out.push('  that we do not know whether your programs run.');
    }
    out.push('');
    out.push(para('That list is the whole claim. Anything not on it is untested, and untested means unknown rather than fine.'));
  } else {
    out.push(para('Not enabled on this fleet. Windows programs will not run on these machines.'));
  }

  // ---- what it will NOT do ---------------------------------------------------------------------
  out.push(...heading('What this will NOT do'));
  out.push('');
  out.push(para('Said here, in the order itself, rather than discovered in month two.'));
  out.push('');
  for (const line of willNotDo(recipe)) {
    out.push(`  - ${line.split('\n')[0]!}`);
    for (const rest of line.split('\n').slice(1)) out.push(wrap(rest, '    '));
  }

  // ---- honesty ---------------------------------------------------------------------------------
  out.push(...heading('Things that are honestly not here yet'));
  out.push('');
  for (const line of NOT_YET) out.push(wrap(`  - ${line}`, '    ').replace(/^ {4}-/, '  -'));

  if (options.notes && options.notes.length > 0) {
    out.push(...heading('Disclosed on this order'));
    out.push('');
    for (const note of options.notes) out.push(wrap(`  - ${note}`, '    ').replace(/^ {4}-/, '  -'));
  }

  // ---- sign-off ---------------------------------------------------------------------------------
  out.push(...heading('Sign-off'));
  out.push('');
  out.push(field('Approved by', `${recipe.approved_by.name}, ${recipe.approved_by.role}, on ${recipe.approved_by.date}`, 19));
  out.push(field('Enrolment record', `${recipe.approved_by.enrolment}`, 19));
  out.push(field('Size budget', `${recipe.size_budget_gb} GB -- a build larger than this fails and nothing is published`, 19));
  out.push('');
  if (recipe.approved_by.enrolment === 'pending') {
    out.push(
      para(
        'The enrolment record is still pending, which means this recipe will test-build but will not ' +
          'reach a machine. The approval record lives outside this file on purpose: an approval ' +
          'asserted inside the very file being changed proves nothing.',
      ),
    );
    out.push('');
  }
  // DECISIONS.md D30/D31. This paragraph used to say "fork this repository and rebuild this exact
  // operating system", which is a licence grant we have not made -- everything here is proprietary
  // and all rights are reserved. Printing it in the pull request body a customer signs off on would
  // be exactly the unevidenced claim prohibition 4.4 forbids, in the one document they actually read.
  // What replaced it is narrower and true: the file is readable, the rules are readable, the image is
  // theirs, and if we cease operating the build files for THEIR image are handed over.
  out.push(
    para(
      'This file is public. If we disappear tomorrow, you fork this repository and rebuild this exact operating system with tools you already have. ' +
        'above is decided by a program we keep to ourselves, so you can check our working rather ' +
        'than take our word for it. The machines are yours and they keep booting whatever happens ' +
        'to us; what would stop is the nightly rebuild that keeps them patched, and if we ever cease ' +
        'operating you are given the build files for your own image so that you or anybody you hire ' +
        'can carry on patching it.',
    ),
  );
  out.push('');
  out.push(
    para(
      'To be exact about what that is and is not: it is the recipe, the base Containerfile and the ' +
        'build scripts for these machines. It is not a licence to our tooling, and it is not ' +
        'permission to redistribute it. This repository is readable; it is not open source.',
    ),
  );
  out.push('');
  return out.join('\n');
}

const POLICY_PROSE: Record<Recipe['policy'], string> = {
  open:
    'Open. The person using the machine is in charge of it: they can install applications, change ' +
    'settings and reach a command line. This is the right mode for one machine belonging to somebody ' +
    'who knows what they are doing, and the wrong one for a shared fleet.',
  managed:
    'Managed. The desktop works normally and the settings that would break a shared machine are held ' +
    'by the image rather than by a policy somebody has to remember to apply. Nobody needs a command ' +
    'line for anything this fleet promises to do.',
  locked:
    'Locked. Applications cannot be installed and there is no route to a command line. The desktop is ' +
    'otherwise familiar. This is a promise about what a person at the machine can do, and it is ' +
    'proven on a booted laptop rather than merely configured.',
  kiosk:
    'Kiosk. There is no desktop in this image at all -- not hidden, not disabled, not present. The ' +
    'machine starts one window showing one page and nothing else, and the session is wiped behind ' +
    'whoever used it.',
};

/**
 * The same six disclosures for everybody, with the rollout one sized to this fleet.
 *
 * A 40-kiosk customer reading an example about "the other 175" learns that this page was written
 * for somebody else, which is the moment a disclosure stops being read.
 */
function willNotDo(recipe: Recipe): ReadonlyArray<string> {
  const first = Math.min(5, Math.max(1, Math.floor(recipe.hardware.machines / 8)));
  const rest = recipe.hardware.machines - first;
  const rollout =
    recipe.hardware.machines === 1
      ? 'Roll out to some machines before others.\nThere is only one machine on this order, so this changes nothing today. It is listed ' +
        'because it changes everything on the day you have thirty.'
      : 'Roll out to some machines before others.\n' +
        `Every machine in this fleet takes the same image. There is no way to say "these ${first} go ` +
        `first and the other ${rest} follow next week", and that is a real gap rather than an ` +
        'oversight -- see below.';
  return [...WILL_NOT_DO_FIXED.slice(0, 3), rollout, ...WILL_NOT_DO_FIXED.slice(3)];
}

const WILL_NOT_DO_FIXED: ReadonlyArray<string> = [
  'Move your Windows programs across.\n' +
    'Programs do not migrate. Files, browser bookmarks and history, printers and account names do. ' +
    'Office and Adobe specifically do not, and we put them on this list rather than in a footnote.',
  'Bring across saved passwords, cookies or payment details from Chrome or Edge.\n' +
    'Those are locked to the machine that stored them by the browser itself. Bookmarks and history ' +
    'come across; the rest has to go through the browser\'s own sync or an export you do before the ' +
    'changeover, and we will walk you through it.',
  'Touch a machine\'s system disk before your files are copied off it and verified.\n' +
    'There is a moment where your data exists in two places and the original disk is untouched. Any ' +
    'mismatch in the file count or a single hash aborts and changes nothing.',
  'Hold a package back, pin a version, or stay on an older image.\n' +
    'If a new version breaks something for you, that is a report we want and a fix for everybody. It ' +
    'is never a line in your file that quietly keeps you behind.',
  'Run anything a stranger wrote in your build.\n' +
    'A recipe cannot contain a script, a command, an extra package source or a file to drop into the ' +
    'image. Orders arrive here as pull requests, and a format where a stranger can send us a command ' +
    'is a format we cannot accept.',
];

const NOT_YET: ReadonlyArray<string> = [
  'Your wireless network and your printer are not in this file, because it cannot carry a password ' +
    'and this repository is public. Somebody sets them by hand on each machine for now. That is ' +
    'honest and it is not good enough; the sealed enrolment bundle that fixes it is designed and not ' +
    'built.',
  'Staged rollout, as above. It arrives with the fleet console.',
  'One recipe describes one uniform fleet. A computer lab and a set of classroom carts that genuinely ' +
    'need different software are, today, two recipes.',
];
