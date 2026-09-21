/**
 * The prune engine and the data it stands on.
 *
 * Two kinds of test here. The first kind asserts the catalogue is internally sound -- nothing on the
 * protected set hides inside a removable group, every application resolves, every language brings a
 * font. Those are the checks that stop a bad edit to a TSV from becoming a fleet-wide brick, and
 * PROTECTED.md says explicitly that a human maintaining a list is the failure mode being guarded
 * against.
 *
 * The second kind proves the refusal actually fires, by handing the engine a DELIBERATELY BROKEN
 * catalogue. Without that, "the plan never contains a protected package" is a claim that passes
 * because nothing has ever put one there, which is not the same as a check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalogue } from '../src/catalogue.ts';
import { planPrune, postConditions, removalReportShape, pruneScript } from '../src/prune.ts';
import type { Recipe } from '../src/recipe.ts';
import { ROOT, school, kiosk, workstation, toolchain } from './helpers.ts';
import { validateDocument } from '../src/validate.ts';

const catalogue = loadCatalogue(join(ROOT, 'catalogue'));

function planFor(doc: Record<string, unknown>, path: string) {
  const result = validateDocument(toolchain(), doc, path);
  assert.ok(result.ok, `fixture did not validate: ${result.refusals.map((r) => r.what).join('; ')}`);
  return result.plan!;
}

// -------------------------------------------------------------------------------------------------
// The catalogue has to be sound before anything built on it means anything
// -------------------------------------------------------------------------------------------------

test('no protected package hides inside a removable group', () => {
  const offenders: string[] = [];
  for (const [group, members] of catalogue.groups) {
    for (const member of members) {
      if (member.kind === 'rpm' && catalogue.protectedSet.has(member.ref)) {
        offenders.push(`${member.ref} is in "${group}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'A protected package inside a removable group is a fleet-wide brick that every recipe would then ' +
      'be permitted to ask for. See schema/PROTECTED.md, "for whoever maintains the removable list".',
  );
});

test('every member of the protected set named in PROTECTED.md is in the machine-readable copy', () => {
  // PROTECTED.md is the authority and this file is its rendering. Parsing prose is brittle, so the
  // assertion is on the six roles the document names rather than on its exact wording.
  const doc = readFileSync(join(ROOT, 'schema', 'PROTECTED.md'), 'utf8');
  const roles = new Set([...catalogue.protectedSet.values()].map((e) => e.role));
  for (const role of ['update', 'rollback', 'network', 'init', 'security', 'signature', 'accessibility']) {
    assert.ok(roles.has(role), `catalogue/protected.tsv has no entry with role '${role}'`);
  }
  for (const pkg of ['bootc', 'greenboot', 'NetworkManager', 'systemd']) {
    assert.ok(catalogue.protectedSet.has(pkg), `${pkg} is missing from catalogue/protected.tsv`);
    assert.match(doc, new RegExp(pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `PROTECTED.md never mentions ${pkg}`);
  }
  assert.match(doc, /accessibility/i);
});

test('every protected entry carries a sentence, not a shrug', () => {
  for (const entry of catalogue.protectedSet.values()) {
    assert.ok(entry.why.length > 40, `${entry.pkg} has no real explanation: "${entry.why}"`);
  }
});

test('every application in the catalogue has a resolvable reference and a known group', () => {
  const groups = new Set(catalogue.groups.keys());
  for (const app of catalogue.apps.values()) {
    assert.ok(app.ref.length > 1, `${app.name} has no reference`);
    if (app.group) assert.ok(groups.has(app.group), `${app.name} claims group "${app.group}", which groups.tsv does not have`);
    assert.doesNotMatch(app.name, /[0-9]/, `${app.name} contains a digit, which makes it unspellable in a recipe`);
  }
});

test('every language brings at least one font package', () => {
  for (const entry of catalogue.languages.values()) {
    assert.ok(entry.fonts.length > 0, `${entry.language} has no font package, so an image in it would draw empty boxes`);
    assert.ok(entry.scripts.length > 0, `${entry.language} declares no script`);
  }
});

// -------------------------------------------------------------------------------------------------
// The engine
// -------------------------------------------------------------------------------------------------

test('a keep-only plan removes what was not asked for and keeps what was', () => {
  const plan = planFor(school(), join(ROOT, 'customers', 'example-school', 'recipe.yaml'));
  const removed = new Set(plan.remove.map((r) => r.ref));
  assert.ok(plan.keepOnly);
  assert.ok(removed.has('kpat'), 'a solitaire game survived "keep only the applications above"');
  assert.ok(!removed.has('dolphin'), 'Files was named in apps and was still removed');
  assert.ok(!removed.has('cups'), 'printing was in also_keep and was still removed');
  assert.ok(plan.install.rpm.includes('google-noto-sans-devanagari-vf-fonts'), 'Marathi did not bring its fonts');
});

test('a plan that keeps the ordinary desktop only removes the groups it named', () => {
  const plan = planFor(workstation(), join(ROOT, 'customers', 'example-workstation', 'recipe.yaml'));
  assert.equal(plan.keepOnly, false);
  const groups = new Set(plan.remove.map((r) => r.group));
  assert.deepEqual([...groups].sort(), ['games', 'sample wallpapers and media']);
});

test('no plan from any example recipe touches the protected set', () => {
  for (const [doc, dir] of [
    [school(), 'example-school'],
    [kiosk(), 'example-kiosk'],
    [workstation(), 'example-workstation'],
  ] as const) {
    const plan = planFor(doc, join(ROOT, 'customers', dir, 'recipe.yaml'));
    assert.deepEqual(plan.violations, [], `${dir} produced a protected-set violation`);
    for (const item of plan.remove) {
      assert.ok(!catalogue.protectedSet.has(item.ref), `${dir} would remove protected package ${item.ref}`);
    }
  }
});

test('the protected set is printed on every plan whether or not anybody asked about it', () => {
  const plan = planFor(workstation(), join(ROOT, 'customers', 'example-workstation', 'recipe.yaml'));
  assert.equal(plan.protectedKept.length, catalogue.protectedSet.size);
});

// -------------------------------------------------------------------------------------------------
// The refusal, proved against a catalogue that is deliberately wrong
// -------------------------------------------------------------------------------------------------

function brokenCatalogueDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auros-cat-'));
  for (const name of ['apps.tsv', 'languages.tsv', 'keyboards.tsv', 'protected.tsv']) {
    writeFileSync(join(dir, name), readFileSync(join(ROOT, 'catalogue', name), 'utf8'));
  }
  // The realistic mistake: somebody tidying groups.tsv decides the init system is a developer tool.
  writeFileSync(
    join(dir, 'groups.tsv'),
    `group\tkind\tref\ndeveloper tools\trpm\tgcc\ndeveloper tools\trpm\tsystemd\ngames\trpm\tkpat\nprinting\trpm\tcups\n`,
  );
  return dir;
}

test('a protected package reaching the removal set is refused, not quietly filtered', () => {
  const broken = loadCatalogue(brokenCatalogueDir());
  // example-school asks for "developer tools" to come out, and the broken catalogue has put the
  // init system in that group. This is the exact shape of the accident PROTECTED.md warns about:
  // a recipe that is entirely reasonable, sitting on a list that somebody edited wrongly.
  const recipe = school() as unknown as Recipe;
  const plan = planPrune(recipe, broken, []);

  assert.ok(plan.violations.length > 0, 'the engine accepted a plan that would remove systemd');
  const text = plan.violations.map((v) => `${v.what} ${v.why}`).join('\n');
  assert.match(text, /systemd/);
  assert.match(text, /fault in catalogue\/groups\.tsv/);
  assert.ok(!plan.remove.some((r) => r.ref === 'systemd'), 'systemd was refused AND still left in the removal set');
});

test('a fleet whose recipe is fine is still refused when the catalogue under it is not', () => {
  // The refusal has to reach the caller, not stop at the engine. This is the path CI takes.
  const broken = loadCatalogue(brokenCatalogueDir());
  const plan = planPrune(school() as unknown as Recipe, broken, []);
  assert.ok(plan.violations.some((v) => /protected set/i.test(v.what)));
});

// -------------------------------------------------------------------------------------------------
// The report shape and the post-conditions
// -------------------------------------------------------------------------------------------------

test('the removal report leaves every measured number null', () => {
  const plan = planFor(school(), join(ROOT, 'customers', 'example-school', 'recipe.yaml'));
  const report = removalReportShape(plan, { base: 'example/base@sha256:0', generatedBy: 'test' });
  assert.equal(report.measured.removed_count, null);
  assert.equal(report.measured.bytes_reclaimed, null);
  assert.equal(report.measured.image_size_bytes, null);
  assert.equal(report.floor.met, null);
  for (const item of report.planned) {
    assert.equal(item.version, null, `${item.package} came with a version nobody measured`);
    assert.equal(item.bytes_reclaimed, null, `${item.package} came with a byte count nobody measured`);
  }
});

test('the report prints the protected set under the heading PROTECTED.md promises', () => {
  const plan = planFor(kiosk(), join(ROOT, 'customers', 'example-kiosk', 'recipe.yaml'));
  const report = removalReportShape(plan, { base: 'example/base@sha256:0', generatedBy: 'test' });
  assert.match(report.kept_although_nothing_asked_for_them.heading, /Kept although nothing asked for them/);
  assert.equal(report.kept_although_nothing_asked_for_them.packages.length, catalogue.protectedSet.size);
});

test('the post-conditions assert the floor against the measured count, never against the plan', () => {
  const plan = planFor(school(), join(ROOT, 'customers', 'example-school', 'recipe.yaml'));
  const floor = postConditions(plan).find((p) => p.id === 'P1-floor');
  assert.ok(floor);
  assert.match(floor.assert, /measured removal count is at least 240/);
  assert.match(floor.why, /checked against what the build measured, never against the plan/);
  // And the guard that makes that sentence load-bearing: the plan alone does NOT meet the floor, so
  // asserting the plan would be an alarm that can never go off.
  assert.ok(plan.remove.length < plan.floor);
});

test('a kiosk carries the no-shell post-condition and says what it does not claim', () => {
  const plan = planFor(kiosk(), join(ROOT, 'customers', 'example-kiosk', 'recipe.yaml'));
  const recipe = kiosk() as unknown as Recipe;
  const conditions = postConditions(plan, recipe);
  const shell = conditions.find((p) => p.id === 'P6-kiosk-no-shell');
  assert.ok(shell, 'a kiosk plan has no assertion that the desktop shell is gone');
  assert.match(shell.why, /larger than a purpose-built minimal one/);
});

test('a desktop fleet does not carry the kiosk post-condition', () => {
  const plan = planFor(school(), join(ROOT, 'customers', 'example-school', 'recipe.yaml'));
  assert.equal(postConditions(plan, school() as unknown as Recipe).find((p) => p.id === 'P6-kiosk-no-shell'), undefined);
});

// -------------------------------------------------------------------------------------------------
// The in-image runner
// -------------------------------------------------------------------------------------------------

test('the prune script is a constant with no recipe text in it', () => {
  const script = pruneScript();
  // If a customer string ever reached this function, the most likely way in is a template hole.
  assert.doesNotMatch(script, /example-school|Vidyalaya|नमस्कार/);
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /--assumeno/, 'the script removes without resolving the transaction first');
  assert.match(script, /rpm -q --quiet "\$pkg" \|\| MISSING/, 'the script never verifies the protected set afterwards');
});

test('two calls to the prune script produce identical bytes', () => {
  assert.equal(pruneScript(), pruneScript());
});

// -------------------------------------------------------------------------------------------------
// The shipped runner, EXECUTED
// -------------------------------------------------------------------------------------------------

/*
 * Everything above is about the PLAN. /usr/libexec/auros/auros-prune is the thing that runs inside
 * the image and actually removes packages, and until now the only test of it was a byte-for-byte
 * comparison of the Containerfile it is embedded in -- whose failure message tells the reader to
 * regenerate the Containerfile. A mutation run on 2026-09-20 found five changes to it that nothing
 * else noticed, and the first one is the SELinux bug verbatim:
 *
 *   P04  print(item["package"])  ->  print(item["package"], end=" ")
 *
 * `mapfile -t` then reads ONE element containing every package name. `rpm -q` fails on it, PRESENT
 * is empty, the removal is skipped entirely, and the script prints "removed 0 packages" and exits 0.
 * A build that removes nothing and reports success -- which is the product, not removed.
 *
 *   P05  the same collapse on the GUARDED list      the protected-package guarantee checks a string
 *   P06  `-gt 0` -> `-gt 1`                          losing exactly one protected package is tolerated
 *   P07  the closure abort's `exit 1` -> `exit 0`    a refusal that returns success
 *   P08  the resolve grep given a pattern that cannot match   PROTECTED.md layer 2 as decoration
 *
 * So the script is executed here, against a stub rpm and a stub dnf, and the assertions are about
 * what it ASKED FOR and what it wrote -- not about its text.
 */

/** A bash with `mapfile`, which is bash 4. macOS ships 3.2, so this is a real possibility. */
function bashWithMapfile(): string | null {
  for (const candidate of ['/usr/bin/bash', '/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash', 'bash']) {
    const probe = spawnSync(candidate, ['-c', 'type -t mapfile'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === 'builtin') return candidate;
  }
  return null;
}

const BASH = bashWithMapfile();

test('a bash that can run the shipped prune runner exists here, or CI is misconfigured', () => {
  /*
   * A SKIP THAT CANNOT BE SILENT. The tests below need bash 4 for `mapfile`; the operator's macOS
   * laptop has 3.2 and the image this runs in has 5.2. Skipping on a laptop is reasonable. Skipping
   * in CI is not -- that would be the whole class of test quietly not running, which is the exact
   * shape of every bug this file was written for. So on CI the absence of a usable bash is a
   * FAILURE, and on a laptop it is a documented skip that names itself in the output.
   */
  if (BASH) { assert.ok(true); return; }
  assert.equal(
    process.env['CI'],
    undefined,
    'CI has no bash with mapfile, so every executed-runner test below silently did not run. ' +
      'The runner ships into a Fedora image with bash 5; a runner image without it must be fixed, ' +
      'not tolerated.',
  );
  console.log('# SKIPPED (local): no bash with mapfile here, so the executed-runner tests did not run.');
});

interface Scenario {
  /** What the stub rpm reports as installed at the start. */
  readonly installed: ReadonlyArray<string>;
  /** What `dnf remove --assumeno` prints, which is the text the protected-closure grep reads. */
  readonly resolve: string;
  /** Packages `dnf remove -y` ALSO takes, beyond the ones it was asked for: a bad closure. */
  readonly collateral?: ReadonlyArray<string>;
}

interface RunnerResult {
  readonly status: number | null;
  readonly out: string;
  /** Every argument list the stub rpm was called with, in order. */
  readonly rpmCalls: ReadonlyArray<string>;
  /** Every argument list the stub dnf was called with, in order. */
  readonly dnfCalls: ReadonlyArray<string>;
  readonly report: Record<string, unknown> | null;
  readonly installedAfter: ReadonlyArray<string>;
}

const STUB_RPM = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$AUROS_RPM_LOG"
if [ "$1" = "-qa" ]; then
  while IFS= read -r _; do printf 'x\\n'; done < "$AUROS_INSTALLED"
  exit 0
fi
pkg=""
for a in "$@"; do pkg="$a"; done
if grep -qxF -- "$pkg" "$AUROS_INSTALLED"; then
  if [ "$2" = "--qf" ]; then printf '%s\\t1.0-1\\t4096\\n' "$pkg"; fi
  exit 0
fi
exit 1
`;

const STUB_DNF = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$AUROS_DNF_LOG"
drop () {
  grep -vxF -- "$1" "$AUROS_INSTALLED" > "$AUROS_INSTALLED.tmp" || true
  mv "$AUROS_INSTALLED.tmp" "$AUROS_INSTALLED"
}
if [ "$1" = "remove" ] && [ "$2" = "--assumeno" ]; then
  cat "$AUROS_RESOLVE"
  exit 1
fi
if [ "$1" = "remove" ] && [ "$2" = "-y" ]; then
  shift 2
  for pkg in "$@"; do drop "$pkg"; done
  while IFS= read -r c; do [ -n "$c" ] && drop "$c"; done < "$AUROS_COLLATERAL"
  exit 0
fi
exit 0
`;

/**
 * Run the real pruneScript() against stub tools.
 *
 * THE ONE THING THIS CHANGES about the script, stated plainly: it relocates two absolute path
 * PREFIXES, because /usr/share/auros is not writable on a developer's machine and the script is a
 * constant with no seam in it (deliberately -- see its header: no value from any recipe is
 * interpolated into it). Both substitutions are asserted to have fired, so renaming either path in
 * src/prune.ts breaks this test loudly instead of leaving it testing a path that no longer exists.
 * Nothing else about the script is touched.
 */
function runPruneRunner(planJson: unknown, scenario: Scenario): RunnerResult {
  const root = mkdtempSync(join(tmpdir(), 'auros-runner-'));
  try {
    mkdirSync(join(root, 'bin'), { recursive: true });
    mkdirSync(join(root, 'usr', 'share', 'auros'), { recursive: true });

    for (const [name, body] of [['rpm', STUB_RPM], ['dnf', STUB_DNF]] as const) {
      writeFileSync(join(root, 'bin', name), body, { mode: 0o755 });
    }

    const installed = join(root, 'installed.txt');
    const rpmLog = join(root, 'rpm.log');
    const dnfLog = join(root, 'dnf.log');
    const resolve = join(root, 'resolve.txt');
    const collateral = join(root, 'collateral.txt');
    writeFileSync(installed, `${[...scenario.installed].join('\n')}\n`);
    writeFileSync(rpmLog, '');
    writeFileSync(dnfLog, '');
    writeFileSync(resolve, scenario.resolve);
    writeFileSync(collateral, `${(scenario.collateral ?? []).join('\n')}\n`);
    writeFileSync(join(root, 'usr', 'share', 'auros', 'prune-plan.json'), JSON.stringify(planJson, null, 2));

    let script = pruneScript();
    for (const [from, to] of [
      ['/usr/share/auros/', `${root}/usr/share/auros/`],
      ['/tmp/auros-prune-', `${root}/auros-prune-`],
    ] as const) {
      assert.ok(script.includes(from), `src/prune.ts no longer writes ${from}, so this test is relocating a path that does not exist`);
      script = script.split(from).join(to);
    }
    const scriptPath = join(root, 'auros-prune');
    writeFileSync(scriptPath, script, { mode: 0o755 });

    const r = spawnSync(BASH!, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env['PATH'] ?? ''}`,
        AUROS_RPM_LOG: rpmLog,
        AUROS_DNF_LOG: dnfLog,
        AUROS_INSTALLED: installed,
        AUROS_RESOLVE: resolve,
        AUROS_COLLATERAL: collateral,
        SOURCE_DATE_EPOCH: '1700000000',
      },
    });

    const lines = (p: string): string[] => readFileSync(p, 'utf8').split('\n').filter((l) => l !== '');
    const reportPath = join(root, 'usr', 'share', 'auros', 'removal-report.json');
    return {
      status: r.status,
      out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
      rpmCalls: lines(rpmLog),
      dnfCalls: lines(dnfLog),
      report: existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>) : null,
      installedAfter: lines(installed),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The school's real plan, in the exact shape the runner reads. */
function schoolReport(): {
  json: ReturnType<typeof removalReportShape>;
  planned: string[];
  guarded: string[];
} {
  const plan = planFor(school(), join(ROOT, 'customers', 'example-school', 'recipe.yaml'));
  const json = removalReportShape(plan, { base: 'ghcr.io/example/base@sha256:abc', generatedBy: 'test' });
  return {
    json,
    planned: json.planned.map((p) => p.package),
    guarded: json.kept_although_nothing_asked_for_them.packages.map((p) => p.package),
  };
}

/** A resolve transcript that names nothing protected. The NEGATIVE control for the grep in layer 2. */
const BENIGN_RESOLVE = [
  'Dependencies resolved.',
  '================================================================================',
  ' Package             Arch     Version          Repository             Size',
  '================================================================================',
  'Removing:',
  ' kcalc               x86_64   24.05.2-1.fc41   @fedora               2.1 M',
  ' kmines              x86_64   24.05.2-1.fc41   @fedora               1.4 M',
  'Removing dependent packages:',
  ' kdegames-common     noarch   24.05.2-1.fc41   @fedora               110 k',
  '',
  'Operation aborted.',
  '',
].join('\n');

test('the prune runner, executed against stub rpm and dnf, removes exactly the planned packages', { skip: BASH ? false : 'no bash with mapfile here' }, () => {
  const { json, planned, guarded } = schoolReport();
  assert.ok(planned.length > 5, `the fixture plan names only ${planned.length} packages, so this test proves little`);

  const r = runPruneRunner(json, { installed: [...planned, ...guarded, 'something-else'], resolve: BENIGN_RESOLVE });

  assert.equal(r.status, 0, `the runner failed on an ordinary plan:\n${r.out}`);

  // THE ASSERTION THE SELINUX BUG TEACHES: rpm is asked about ONE package at a time. A collapsed
  // list arrives here as a single query containing spaces, and everything downstream still "works".
  const quiet = r.rpmCalls.filter((c) => c.startsWith('-q --quiet ')).map((c) => c.slice('-q --quiet '.length));
  for (const query of quiet) {
    assert.ok(!query.includes(' '), `rpm was asked about a whole line of packages at once: '${query.slice(0, 80)}...'`);
  }
  for (const pkg of planned) {
    assert.ok(quiet.includes(pkg), `the runner never asked whether '${pkg}' was installed`);
  }

  // It asked dnf to remove them, in one transaction, and asked for every one of them.
  const removeY = r.dnfCalls.filter((c) => c.startsWith('remove -y '));
  assert.equal(removeY.length, 1, `dnf remove -y was called ${removeY.length} times:\n${r.dnfCalls.join('\n')}`);
  const asked = removeY[0]!.slice('remove -y '.length).split(' ').sort();
  assert.deepEqual(asked, [...planned].sort(), 'dnf was asked to remove a different set from the one that was planned');

  // And the report says what happened, measured rather than assumed.
  assert.ok(r.report, 'no removal-report.json was written');
  const measured = r.report!['measured'] as Record<string, unknown>;
  assert.equal(measured['removed_count'], planned.length);
  assert.ok((measured['bytes_reclaimed'] as number) > 0);
  assert.equal(measured['packages_installed_after'], guarded.length + 1, 'the after-count did not come from the package database');
  for (const item of r.report!['planned'] as Array<Record<string, unknown>>) {
    assert.equal(item['outcome'], 'removed', `${String(item['package'])} was not reported as removed`);
  }
  assert.match(r.out, new RegExp(`removed ${planned.length} packages`));

  // The negative control for PROTECTED.md layer 2: a resolve transcript naming nothing protected
  // must NOT abort. Without this half, the grep can be made unfalsifiable again and this file would
  // still be green.
  assert.ok(r.installedAfter.includes(guarded[0]!), 'a protected package was removed');
});

test('a package that is already gone is not an error, and is reported as already-absent', { skip: BASH ? false : 'no bash with mapfile here' }, () => {
  // Upstream moves. A build that failed because something we wanted gone is already gone would be an
  // alarm pointing the wrong way -- and the report still has to say which it was.
  const { json, planned, guarded } = schoolReport();
  const missingOne = planned[0]!;
  const r = runPruneRunner(json, {
    installed: [...planned.filter((p) => p !== missingOne), ...guarded],
    resolve: BENIGN_RESOLVE,
  });
  assert.equal(r.status, 0, r.out);
  const rows = r.report!['planned'] as Array<Record<string, unknown>>;
  assert.equal(rows.find((x) => x['package'] === missingOne)!['outcome'], 'already-absent');
  assert.equal((r.report!['measured'] as Record<string, unknown>)['removed_count'], planned.length - 1);
});

test('the guarded list is read one package per line, not as one long string', { skip: BASH ? false : 'no bash with mapfile here' }, () => {
  /*
   * The same collapse, on the list that carries the guarantee. Collapsed, the verification loop asks
   * rpm about one bogus string, finds it "missing", and the build fails for the wrong reason -- or,
   * combined with the grep in layer 2, silently stops checking anything at all. Either way the
   * sentence "every protected package is still installed" has stopped being verified.
   */
  const { json, planned, guarded } = schoolReport();
  assert.ok(guarded.length > 3, `only ${guarded.length} protected packages, so this test proves little`);

  const r = runPruneRunner(json, { installed: [...planned, ...guarded], resolve: BENIGN_RESOLVE });
  assert.equal(r.status, 0, r.out);

  const quiet = r.rpmCalls.filter((c) => c.startsWith('-q --quiet ')).map((c) => c.slice('-q --quiet '.length));
  for (const pkg of guarded) {
    assert.ok(quiet.includes(pkg), `the runner never verified that the protected package '${pkg}' survived`);
  }
});

test('losing exactly one guarded package is one too many, and the message names only that one', { skip: BASH ? false : 'no bash with mapfile here' }, () => {
  /*
   * The boundary, written from both sides. `-gt 0` -> `-gt 1` tolerates losing one package, and one
   * is all it takes: bootc, rpm-ostree or ostree going means the fleet can never be repaired
   * remotely again. The zero case is asserted in the happy-path test above; this is the one case.
   *
   * "names only that one" is the second half, and it is what separates this from P05's collapse:
   * a collapsed guarded list also produces a non-empty MISSING, and would satisfy a test that only
   * checked the exit code.
   */
  const { json, planned, guarded } = schoolReport();
  const lost = guarded.find((g) => g === 'bootc') ?? guarded[0]!;
  const survivor = guarded.find((g) => g !== lost)!;

  const r = runPruneRunner(json, {
    installed: [...planned, ...guarded],
    resolve: BENIGN_RESOLVE,
    collateral: [lost],            // dnf takes it as part of the closure, having said it would not
  });

  assert.notEqual(r.status, 0, `losing the protected package '${lost}' did not fail the build:\n${r.out}`);
  assert.match(r.out, new RegExp(`no longer installed: ${lost}\\b`));
  assert.doesNotMatch(
    r.out,
    new RegExp(survivor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `the failure named '${survivor}' as well, which means it was reading the guarded list as one string`,
  );
  assert.equal(r.report, null, 'a removal report was written for a build that refused');
});

test('a closure that would take a protected package aborts, and dnf remove is never reached', { skip: BASH ? false : 'no bash with mapfile here' }, () => {
  /*
   * PROTECTED.md layer 2. dnf's own dry run says what the transaction would take; if a protected
   * package is in that list the script stops BEFORE removing anything. Two things have to be true
   * and only one of them is about the exit code:
   *
   *   - it exits non-zero. `exit 1` -> `exit 0` is a refusal that prints REFUSED and returns success.
   *   - `dnf remove -y` is never invoked. That is the difference between an abort and a warning.
   */
  const { json, planned, guarded } = schoolReport();
  const threatened = guarded.find((g) => g === 'bootc') ?? guarded[0]!;
  const resolve = BENIGN_RESOLVE.replace(
    ' kdegames-common     noarch   24.05.2-1.fc41   @fedora               110 k',
    ` ${threatened}     x86_64   1.1.6-1.fc41   @fedora               9.9 M`,
  );
  assert.notEqual(resolve, BENIGN_RESOLVE, 'the fixture resolve transcript was not modified');

  const r = runPruneRunner(json, { installed: [...planned, ...guarded], resolve });

  assert.notEqual(r.status, 0, `the runner continued after the closure threatened '${threatened}':\n${r.out}`);
  assert.match(r.out, new RegExp(`would also take ${threatened}`));
  assert.match(r.out, /can never be repaired remotely again/);
  assert.deepEqual(
    r.dnfCalls.filter((c) => c.startsWith('remove -y ')),
    [],
    'the script printed REFUSED and then removed the packages anyway',
  );
  assert.deepEqual([...planned].filter((p) => !r.installedAfter.includes(p)), [], 'packages were removed after a refusal');
});

test('and the control: a resolve transcript naming nothing protected proceeds to remove', { skip: BASH ? false : 'no bash with mapfile here' }, () => {
  // The other half of the grep. Without it, a pattern that can never match satisfies the test above
  // -- permanently green, which is precisely the SELinux kernel-argument check's failure mode.
  const { json, planned, guarded } = schoolReport();
  const r = runPruneRunner(json, { installed: [...planned, ...guarded], resolve: BENIGN_RESOLVE });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.dnfCalls.filter((c) => c.startsWith('remove -y ')).length, 1, 'a benign resolve transcript stopped the removal');
});

test('a substring of a protected package name does not trigger the abort', { skip: BASH ? false : 'no bash with mapfile here' }, () => {
  // The grep is anchored on a word boundary at the front. A package whose name merely CONTAINS a
  // protected name must not stop the build, or the abort becomes unusable noise and somebody
  // loosens it.
  const { json, planned, guarded } = schoolReport();
  const threatened = guarded.find((g) => g === 'bootc') ?? guarded[0]!;
  const resolve = BENIGN_RESOLVE.replace('kdegames-common', `not-${threatened}-really`);
  const r = runPruneRunner(json, { installed: [...planned, ...guarded], resolve });
  assert.equal(r.status, 0, `'not-${threatened}-really' was read as '${threatened}':\n${r.out}`);
});

test('a Flatpak in the removal set is reported as not-preinstalled, never handed to dnf', () => {
  /*
   * A Flatpak reaches a machine only by being declared in /etc/flatpak/preinstall.d, and a recipe
   * that does not declare one has nothing to remove. Letting the id fall into the rpm list means the
   * image asks dnf to remove 'org.gnome.Rhythmbox' -- which fails, or worse succeeds at nothing --
   * and the removal report, the artifact we advertise as the truth, names it as removed.
   *
   * The only thing that caught this was the byte-for-byte Containerfile comparison.
   */
  const plan = planFor(school(), join(ROOT, 'customers', 'example-school', 'recipe.yaml'));
  assert.ok(plan.notPreinstalled.length > 0, 'this fixture removes no Flatpak groups, so the test is vacuous');

  assert.deepEqual(
    plan.remove.filter((item) => item.kind === 'flatpak'),
    [],
    'a Flatpak reached the rpm removal list, which is what dnf is handed',
  );
  for (const ref of plan.notPreinstalled) {
    assert.ok(ref.includes('.'), `'${ref}' does not look like a Flatpak application id`);
  }

  const report = removalReportShape(plan, { base: 'x', generatedBy: 'test' });
  const named = report.planned.map((p) => p.package);
  for (const ref of plan.notPreinstalled) {
    assert.ok(!named.includes(ref), `'${ref}' is a Flatpak and the report lists it as a package to remove`);
    assert.ok(report.not_preinstalled.includes(ref), `'${ref}' is missing from the report's not_preinstalled list`);
  }
});
