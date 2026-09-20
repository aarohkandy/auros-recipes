/**
 * The licence, asserted against the files rather than against anybody's memory of a decision.
 *
 * DECISIONS.md D30 is a human decision with a verbatim quote attached: *"i don't want apache, i
 * wanna own our thing, i don't want them to distribute, cuz this is going to be a product later,
 * make sure you don't screw us by making anyone able to spread it"*. D31 settles the shape: the
 * repositories stay readable so that a customer can check our working, everything in them is
 * proprietary and all rights are reserved, and the trust story is a wind-down handover of the build
 * files for the customer's own image rather than a licence to our tooling.
 *
 * WHY THIS IS A TEST AND NOT A NOTE. Spec section 1.3 tells everything in this repository to
 * advertise replaceability, and a licence is the mechanism that makes such a claim real, so every
 * sentence written before D30 leans that way and reads perfectly naturally while doing it. When the
 * decision reversed, three files still granted rights we had not granted: package.json declared
 * Apache-2.0 in a machine-readable field, README.md's licence section said "Apache 2.0. Fork it.
 * That is the point", and -- the one that mattered -- src/explain.ts told the customer, in the
 * pull request body they sign a fleet off against, to fork the repository and rebuild.
 *
 * That last one is prohibition 4.4 in the place it would do the most damage, and none of the 141
 * tests that existed at the time noticed, because no test was looking. This file looks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './helpers.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.github']);

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) filesUnder(path, out);
    else if (/\.(ts|md|json|py|yml|yaml)$/.test(entry)) out.push(path);
  }
  return out;
}

/**
 * Phrases that GRANT a right. Not the words themselves: the honest replacement text has to be able
 * to say "this is not permission to redistribute it" and "readable; it is not open source", so a
 * pattern matching the bare word would go red on the fix and green on the bug.
 */
const GRANTS: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /\bApache[- ]?2(\.0)?\b/i, what: 'an Apache licence grant' },
  { re: /\bMIT licen[cs]e\b/i, what: 'an MIT licence grant' },
  { re: /\bGPL-3|\bBSD-3-Clause\b/, what: 'an open-source licence identifier' },
  { re: /licen[cs]ed under/i, what: 'a licence grant' },
  { re: /\bfork it\b/i, what: 'an invitation to fork' },
  { re: /fork (?:this|the|our) repositor/i, what: 'an invitation to fork this repository' },
  { re: /you (?:may|can|are free to) (?:fork|copy|redistribute|distribute|share|resell)/i, what: 'a grant in words' },
  { re: /free to (?:copy|share|distribute|redistribute|modify)/i, what: 'a grant in words' },
  { re: /\bis open[- ]source\b/i, what: 'a claim that this is open source' },
  { re: /permission (?:is|are) (?:hereby )?granted/i, what: 'a permissive licence preamble' },
];

/** Where a licence name is a statement of fact about somebody else's software, not our grant. */
const THIRD_PARTY_CONTEXT = /ublue|bootc|osbuild|podman|skopeo|cosign|Fedora|Universal Blue|third-party|THIRD-PARTY|not affected|continue to govern|those components|copyleft|derivative of/i;

/**
 * Where the phrase is a record of what a file USED to say. Deleting that history would make the
 * next person to read these files wonder why the licence section is worded so carefully, and a rule
 * whose reason has been deleted is a rule somebody undoes.
 */
const HISTORICAL_CONTEXT = /used to |D30|D31|withdrew|no longer|before the decision|reversed|this morning|the bug|the old promise|the old claim/i;

test('no file in this repository grants a right D30 and D31 did not grant', () => {
  const offences: string[] = [];
  for (const path of filesUnder(ROOT)) {
    const name = relative(ROOT, path);
    // LICENSE is asserted separately: its job is to name third-party licences, so it contains the
    // words on purpose. This file quotes the exact sentences that were removed, which is how the
    // last test here proves the patterns would have caught them.
    if (name === 'LICENSE' || name === 'test/licence.test.ts') continue;
    const text = readFileSync(path, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (THIRD_PARTY_CONTEXT.test(line) || HISTORICAL_CONTEXT.test(line)) return;
      for (const grant of GRANTS) {
        if (grant.re.test(line)) offences.push(`${name}:${i + 1}  ${grant.what}\n      ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offences,
    [],
    'A file in this repository offers a right that DECISIONS.md D30 and D31 withdrew:\n\n' +
      offences.join('\n') +
      '\n\nIf the licence really has changed, change DECISIONS.md first and this test second. If it ' +
      'has not, the sentence above is a claim we cannot evidence, which is prohibition 4.4.',
  );
});

test('the LICENSE file reserves all rights and names what it cannot reserve', () => {
  const text = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
  assert.match(text, /All rights reserved/i);
  assert.match(text, /NO LICENCE IS GRANTED|no licence is granted/i);
  assert.match(text, /may not copy, modify, merge, publish, distribute/i);
  // The half that is not ours to decide. An image built from this carries GPL and LGPL components
  // and the recipient holds rights in them directly; a notice that pretended otherwise would be
  // both false and the kind of overreach that gets a vendor a reputation.
  assert.match(text, /GPL|copyleft/i);
  assert.match(text.replace(/\s+/g, ' '), /Nothing in this notice restricts any right a recipient holds/i);
});

test('package.json does not declare a licence that grants redistribution', () => {
  // A machine-readable field. This is the one a package registry, a licence scanner or a customer's
  // procurement checklist reads, and it said Apache-2.0 for the whole of the time the prose did.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { license?: string; private?: boolean };
  assert.ok(pkg.license, 'package.json declares no licence at all, which is its own kind of unclear');
  assert.doesNotMatch(pkg.license!, /Apache|MIT|BSD|GPL|ISC|Unlicense|CC0/i, `package.json declares '${pkg.license}'`);
  assert.equal(pkg.private, true, 'a package that is not marked private can be published by an accident');
});

test('the README says readable is not the same as open', () => {
  const text = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(text, /All rights reserved/i);
  assert.match(text, /Readable is not the same as open|readable; it is not open source/i);
  // And the replacement promise, because deleting the claim and putting nothing in its place leaves
  // a school with no answer to the question that decides a first pilot.
  assert.match(text, /build files for their own image/i);
  assert.match(text, /Not redistribution rights/i);
});

test('the weekly job that executed the old promise is not running', () => {
  // BLOCKED.md B8 and D31: `replaceable.yml` ran the clone-and-build instructions every week to
  // prove the claim was not decoration. The claim is gone; a job that still proved it would be
  // proving something we no longer say.
  const path = join(ROOT, '.github', 'workflows', 'replaceable.yml');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  const triggers = /^on:\s*$[\s\S]*?^\S/m.exec(text)?.[0] ?? '';
  assert.doesNotMatch(triggers, /^\s{2}schedule:/m, 'the replaceability job is still on a schedule');
  assert.doesNotMatch(triggers, /^\s{2}push:/m, 'the replaceability job still runs on push');
  assert.match(text, /paused/i, 'nothing in the file says why it is not running');
});

test('the guard above can actually fire, so it is not green because it never looks at anything', () => {
  // The check on the check. Every assertion in this file is a search that finds nothing, and a
  // search that finds nothing passes identically whether the rule holds or the search is broken --
  // which is precisely the failure the SELinux kernel-argument check had for an hour.
  const files = filesUnder(ROOT);
  assert.ok(files.length > 20, `the walk found only ${files.length} files, so it is not reading the repository`);
  assert.ok(files.some((f) => f.endsWith('src/explain.ts')), 'the walk never reaches src/, which is where the bad sentence was');
  assert.ok(files.some((f) => f.endsWith('README.md')), 'the walk never reaches README.md');
  assert.ok(files.some((f) => f.endsWith('package.json')), 'the walk never reaches package.json');

  // And the patterns match the exact sentences that were really in these files this morning.
  const wasInReadme = 'Apache 2.0. Fork it. That is the point.';
  const wasInExplain = 'disappear tomorrow, you fork this repository and rebuild this exact operating system';
  const wasInPackageJson = '"license": "Apache-2.0",';
  for (const [sample, label] of [[wasInReadme, 'README.md'], [wasInExplain, 'src/explain.ts'], [wasInPackageJson, 'package.json']] as const) {
    assert.ok(
      GRANTS.some((g) => g.re.test(sample)),
      `none of the patterns in this file would have caught the sentence that was in ${label}: ${sample}`,
    );
  }

  // ...and do NOT match the honest replacement, which is the other way this test could be useless.
  const honest =
    'This repository is readable; it is not open source. It is not permission to redistribute it, ' +
    'and it is not a licence to our tooling. Nothing in this notice restricts any right a recipient ' +
    'holds under those licences with respect to those components.';
  for (const grant of GRANTS) {
    assert.doesNotMatch(honest, grant.re, `the pattern for ${grant.what} matches the honest replacement text`);
  }
});
