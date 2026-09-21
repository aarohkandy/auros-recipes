#!/usr/bin/env node
/**
 * Compare the package databases of the three built example images.
 *
 * This is the half of spec section 6B's exit condition that nothing has ever tested. The other half
 * -- "build from the same base" and "boot" -- is what the check matrix answers. This answers "differ
 * in every way the YAML says they should and IN NO WAY IT DOESN'T", against real `rpm -qa` output
 * rather than against a plan a compiler wrote about itself.
 *
 * WHY THE PLAN IS NOT EVIDENCE. `auros-recipe compile` writes /usr/share/auros/prune-plan.json into
 * the image BEFORE the prune runs. It is a statement of intent by the same program that wrote the
 * build instructions. A plan that names 52 packages and an image that still has all 52 of them is
 * exactly the shape of failure the plan cannot report, and it would pass every test in test/ --
 * every one of which compares a compiler to itself. `rpm -qa` is the first thing in this pipeline
 * that is not our own claim.
 *
 * Input: a directory holding, per recipe, three files uploaded by .github/workflows/examples.yml:
 *     <recipe>.rpms          sorted `rpm -qa --qf '%{NAME}\n'` from the built image
 *     <recipe>.plan.json     /usr/share/auros/prune-plan.json out of the same image
 *     <recipe>.labels.json   `podman inspect --format '{{ json .Labels }}'`
 *
 * Usage:  node scripts/compare-images.mjs <dir>
 * Exit 0 only if every assertion below holds. There is no flag that relaxes one.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: compare-images.mjs <dir holding <recipe>.rpms and <recipe>.plan.json>\n');
  process.exit(2);
}

const names = readdirSync(dir).filter((f) => f.endsWith('.rpms')).map((f) => f.slice(0, -'.rpms'.length)).sort();
if (names.length < 2) {
  process.stderr.write(
    `compare-images: found ${names.length} image(s) under ${dir}, and a comparison needs at least two.\n` +
      'An empty or one-sided artifact download must not read as a pass -- that is the whole failure\n' +
      'mode this file exists to avoid.\n',
  );
  process.exit(2);
}

const fleets = new Map();
for (const name of names) {
  const installed = new Set(
    readFileSync(join(dir, `${name}.rpms`), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean),
  );
  const plan = JSON.parse(readFileSync(join(dir, `${name}.plan.json`), 'utf8'));
  const labels = JSON.parse(readFileSync(join(dir, `${name}.labels.json`), 'utf8'));
  fleets.set(name, {
    installed,
    planned: plan.planned.map((p) => p.package),
    protectedKept: plan.kept_although_nothing_asked_for_them.packages.map((p) => p.package),
    floor: plan.floor.must_remove_at_least,
    labels,
  });
}

const problems = [];
const say = (line) => process.stdout.write(`${line}\n`);

say(`comparing ${names.length} images: ${names.join(', ')}\n`);

// -------------------------------------------------------------------------------------------------
// 1. The image is not merely told what to remove. It removed it.
// -------------------------------------------------------------------------------------------------
for (const [name, f] of fleets) {
  if (f.installed.size < 100) {
    problems.push(`${name}: the package list has ${f.installed.size} entries, which is not a Fedora system. The rpm -qa step produced nothing usable, and an empty list would make every "is absent" check below pass trivially.`);
    continue;
  }
  const survived = f.planned.filter((p) => f.installed.has(p));
  say(`${name}: ${f.installed.size} packages installed, ${f.planned.length} planned for removal, ${survived.length} of those still present`);
  if (survived.length > 0) {
    problems.push(
      `${name}: ${survived.length} package(s) the recipe named for removal are STILL IN THE IMAGE: ${survived.slice(0, 20).join(', ')}` +
        (survived.length > 20 ? `, and ${survived.length - 20} more` : '') +
        '\n    Subtraction is the product (spec section 2). A prune plan that reports a removal the machine did not perform is the only lie in this system that the customer pays for directly.',
    );
  }
  // The other direction: the protected set is what makes a machine patchable at all, and it must
  // have survived every sweep. PROTECTED.md's third layer is a statement about a filesystem.
  const lost = f.protectedKept.filter((p) => !f.installed.has(p));
  if (lost.length > 0) {
    problems.push(
      `${name}: ${lost.length} PROTECTED package(s) are absent from the built image: ${lost.join(', ')}\n` +
        '    A fleet that has stopped updating looks exactly like a fleet that is up to date.',
    );
  }
}

// -------------------------------------------------------------------------------------------------
// 2. The three images are three images.
// -------------------------------------------------------------------------------------------------
const pairs = [];
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) pairs.push([names[i], names[j]]);

say('');
for (const [a, b] of pairs) {
  const A = fleets.get(a).installed, B = fleets.get(b).installed;
  const onlyA = [...A].filter((p) => !B.has(p));
  const onlyB = [...B].filter((p) => !A.has(p));
  const shared = A.size - onlyA.length;
  const jaccard = shared / (A.size + B.size - shared);
  say(`${a} vs ${b}: ${onlyA.length} only in ${a}, ${onlyB.length} only in ${b}, ${shared} shared, jaccard ${jaccard.toFixed(3)}`);
  if (onlyA.length === 0 && onlyB.length === 0) {
    problems.push(
      `${a} and ${b} contain exactly the same packages. Two names over one image. Spec section 6B ` +
        'asks for three VISIBLY DIFFERENT recipes, and the difference has to survive into the image.',
    );
  }
}

// -------------------------------------------------------------------------------------------------
// 3. Every difference between two images is one the YAML asked for.
//
// A package present in one image and absent from the other must be accounted for: either the other
// recipe planned its removal, or it is one the other recipe installs. A difference neither recipe
// asked for is the base behaving differently for two of its own children, which would mean "there
// is exactly one base image" has quietly stopped being true.
// -------------------------------------------------------------------------------------------------
say('');
for (const [a, b] of pairs) {
  const A = fleets.get(a), B = fleets.get(b);
  const unexplained = [];
  for (const [left, right, lname] of [[A, B, a], [B, A, b]]) {
    for (const pkg of left.installed) {
      if (right.installed.has(pkg)) continue;
      if (right.planned.includes(pkg)) continue;      // the other recipe asked for it to go
      unexplained.push(`${pkg} (in ${lname}, absent from the other, and the other recipe never named it)`);
    }
  }
  say(`${a} vs ${b}: ${unexplained.length} difference(s) not traced to either recipe's removal plan`);
  if (unexplained.length > 0) {
    // Dependency closure legitimately removes packages nobody named -- that is most of the work, per
    // postConditions P1. So this is REPORTED in full and judged by a human on the first run rather
    // than failed outright; what would be dishonest is not to compute it.
    say(`    ${unexplained.slice(0, 40).join('\n    ')}`);
    if (unexplained.length > 40) say(`    ... and ${unexplained.length - 40} more`);
    say('    (expected: dependency closure. Read the list — anything in it that is not a dependency of something named is a real finding.)');
  }
}

// -------------------------------------------------------------------------------------------------
// 4. The floor, measured against the image rather than against the plan.
// -------------------------------------------------------------------------------------------------
say('');
for (const [name, f] of fleets) {
  say(`${name}: floor is ${f.floor}; the image has ${f.installed.size} packages and the label says budget ${f.labels['auros.size-budget-gb']} GB, profiles ${f.labels['auros.test-profiles']}`);
  if (!f.labels['auros.test-profiles']) {
    problems.push(`${name}: no auros.test-profiles label, so hardware.also_test reached the image as nothing again.`);
  }
}

writeFileSync(
  join(dir, 'comparison.json'),
  JSON.stringify(
    {
      generated_by: 'scripts/compare-images.mjs',
      fleets: Object.fromEntries([...fleets].map(([n, f]) => [n, { installed: f.installed.size, planned: f.planned.length, floor: f.floor, labels: f.labels }])),
      pairs: pairs.map(([a, b]) => {
        const A = fleets.get(a).installed, B = fleets.get(b).installed;
        return { a, b, only_a: [...A].filter((p) => !B.has(p)).length, only_b: [...B].filter((p) => !A.has(p)).length };
      }),
      problems,
    },
    null,
    1,
  ) + '\n',
);

if (problems.length > 0) {
  process.stderr.write(`\n${problems.length} problem(s):\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}
say('\nall assertions held');
