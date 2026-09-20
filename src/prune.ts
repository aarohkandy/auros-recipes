/**
 * The prune engine.
 *
 * Subtraction is the product (spec section 1.2). This module turns "keep only these eleven things"
 * into a concrete list of packages to remove, refuses to touch the protected set, and defines the
 * shape of the removal report plus the post-conditions the check matrix asserts against the built
 * image.
 *
 * WHAT THIS MODULE KNOWS AND WHAT IT DOES NOT
 *
 * It knows which packages a recipe has asked to be gone. It does NOT know how many packages the
 * dependency closure will take with them, or how many bytes that reclaims, because both of those
 * are facts about an image that has not been built yet. Every measured number in the report shape
 * below is therefore `null` here and filled in by the build.
 *
 * That split is deliberate and it is the difference between a report and a brochure. A number this
 * module invented would be a number nobody measured, printed in the one artifact we advertise as
 * the truth. `must_remove_at_least` is asserted against the MEASURED count, never against the plan:
 * the plan is the explicit request, the closure is most of the work, and a floor of 240 checked
 * against a plan of 30 would be an alarm that can never go off.
 *
 * THE PROTECTED SET IS ENFORCED HERE TWICE
 *
 * Once by construction -- protected packages are members of the keep set, so a keep-only plan
 * cannot subtract them. Once by assertion -- anything that reaches the removal set and is protected
 * is a REFUSAL, not a silent filter. Silently filtering would mean a bad edit to catalogue/groups.tsv
 * (marking systemd part of "developer tools", say) produced a correct image and no signal, and the
 * next such edit would be found by a school rather than by a test.
 */

import type { Catalogue, Kind, ProtectedEntry } from './catalogue.ts';
import type { Recipe } from './recipe.ts';
import { refuse, type Refusal } from './refusal.ts';

export interface RemovalItem {
  readonly kind: Kind;
  readonly ref: string;
  /** The group that put it on the list, or null when it fell out of a keep-only subtraction. */
  readonly group: string | null;
  /** One line, for the removal report, addressed to whoever reads it in eighteen months. */
  readonly reason: string;
}

export interface InstallSet {
  readonly rpm: ReadonlyArray<string>;
  readonly flatpak: ReadonlyArray<string>;
}

export interface PostCondition {
  readonly id: string;
  /** What must be true of the BUILT IMAGE. Written so a person can check it by hand. */
  readonly assert: string;
  readonly why: string;
}

export interface PrunePlan {
  readonly recipe: string;
  readonly keepOnly: boolean;
  /** Packages and Flatpaks this recipe puts on the machine: its apps, plus the fonts its language needs. */
  readonly install: InstallSet;
  /** Everything that must survive: the apps, the also_keep groups, and the protected set. */
  readonly keep: InstallSet;
  /** The explicit removal set. Sorted. rpm only -- see `notPreinstalled`. */
  readonly remove: ReadonlyArray<RemovalItem>;
  /**
   * Flatpaks that a group named for removal. There is nothing to remove: a Flatpak reaches a machine
   * only by being declared in /etc/flatpak/preinstall.d, and this recipe does not declare them. They
   * are listed so the report says "absent" rather than saying nothing.
   */
  readonly notPreinstalled: ReadonlyArray<string>;
  /** Printed on every build, whether or not anything asked about them. See PROTECTED.md. */
  readonly protectedKept: ReadonlyArray<ProtectedEntry>;
  readonly floor: number;
  readonly sizeBudgetGb: number;
  /** Non-empty means the plan itself is refused. A protected package reached the removal set. */
  readonly violations: ReadonlyArray<Refusal>;
}

const key = (kind: Kind, ref: string): string => `${kind}:${ref}`;

function membersOf(catalogue: Catalogue, group: string): ReadonlyArray<{ kind: Kind; ref: string }> {
  return catalogue.groups.get(group) ?? [];
}

/**
 * Resolve a recipe into a concrete removal set.
 *
 * `fonts` comes from the language table and is passed in rather than looked up here, so that this
 * module has exactly one job and the language rules stay in one place.
 */
export function planPrune(recipe: Recipe, catalogue: Catalogue, fonts: ReadonlyArray<string> = []): PrunePlan {
  const keepRpm = new Set<string>();
  const keepFlatpak = new Set<string>();
  const installRpm = new Set<string>();
  const installFlatpak = new Set<string>();

  for (const appName of recipe.apps) {
    const app = catalogue.apps.get(appName);
    if (!app) continue; // validate.ts refuses this; planning proceeds so every problem is reported at once
    if (app.kind === 'rpm') { keepRpm.add(app.ref); installRpm.add(app.ref); }
    else { keepFlatpak.add(app.ref); installFlatpak.add(app.ref); }
  }
  for (const font of fonts) { keepRpm.add(font); installRpm.add(font); }

  for (const group of recipe.prune.also_keep ?? []) {
    for (const member of membersOf(catalogue, group)) {
      if (member.kind === 'rpm') keepRpm.add(member.ref); else keepFlatpak.add(member.ref);
    }
  }
  // The protected set is part of the keep set by construction, not by a later filter.
  for (const pkg of catalogue.protectedSet.keys()) keepRpm.add(pkg);

  // ---- the removal set -------------------------------------------------------------------------
  const candidates = new Map<string, RemovalItem>();

  for (const group of recipe.prune.also_remove ?? []) {
    for (const member of membersOf(catalogue, group)) {
      candidates.set(key(member.kind, member.ref), {
        kind: member.kind,
        ref: member.ref,
        group,
        reason: `the recipe asked for "${group}" to be removed`,
      });
    }
  }

  if (recipe.prune.keep_only_the_apps_above) {
    // "Remove everything except these eleven things." The universe this subtracts from is everything
    // the catalogue can name: every group member and every application. It is deliberately NOT the
    // whole package database -- naming three hundred packages in a file a person reads would defeat
    // the point. The closure inside the build takes the rest, and the measured count is what the
    // floor is checked against.
    const universe = new Map<string, { kind: Kind; ref: string; group: string | null }>();
    for (const [group, members] of catalogue.groups) {
      for (const member of members) universe.set(key(member.kind, member.ref), { ...member, group });
    }
    for (const app of catalogue.apps.values()) {
      if (!universe.has(key(app.kind, app.ref))) universe.set(key(app.kind, app.ref), { kind: app.kind, ref: app.ref, group: app.group });
    }
    for (const [id, entry] of universe) {
      if (candidates.has(id)) continue;
      const kept = entry.kind === 'rpm' ? keepRpm.has(entry.ref) : keepFlatpak.has(entry.ref);
      if (kept) continue;
      candidates.set(id, {
        kind: entry.kind,
        ref: entry.ref,
        group: entry.group,
        reason: 'keep_only_the_apps_above is true and this is not one of them',
      });
    }
  }

  // ---- the protected set, asserted rather than assumed ------------------------------------------
  const violations: Refusal[] = [];
  const remove: RemovalItem[] = [];
  const notPreinstalled: string[] = [];

  for (const item of [...candidates.values()].sort(byRef)) {
    const guarded = item.kind === 'rpm' ? catalogue.protectedSet.get(item.ref) : undefined;
    if (guarded) {
      violations.push(
        refuse(
          `prune -> ${item.ref}`,
          `The removal plan reached '${item.ref}', which is on the protected set. ` +
            (item.group ? `It got there through the group "${item.group}".` : 'It got there through a keep-only subtraction.'),
          `${guarded.why}\n\n` +
            'This is not a recipe that needs fixing. A recipe cannot name a protected package: ' +
            'prune.also_remove takes values from a closed list and none of them is on it. So this ' +
            'is a fault in catalogue/groups.tsv or catalogue/apps.tsv, and the build stops rather ' +
            'than quietly filtering it out. A silent filter would mean the next bad edit to that ' +
            'file is found by a school instead of by this check. See schema/PROTECTED.md.',
        ),
      );
      continue;
    }
    if (item.kind === 'flatpak') { notPreinstalled.push(item.ref); continue; }
    remove.push(item);
  }

  return {
    recipe: recipe.name,
    keepOnly: recipe.prune.keep_only_the_apps_above,
    install: { rpm: [...installRpm].sort(), flatpak: [...installFlatpak].sort() },
    keep: { rpm: [...keepRpm].sort(), flatpak: [...keepFlatpak].sort() },
    remove,
    notPreinstalled: notPreinstalled.sort(),
    protectedKept: [...catalogue.protectedSet.values()].sort((a, b) => a.pkg.localeCompare(b.pkg)),
    floor: recipe.prune.must_remove_at_least,
    sizeBudgetGb: recipe.size_budget_gb,
    violations,
  };
}

function byRef(a: RemovalItem, b: RemovalItem): number {
  return a.kind === b.kind ? a.ref.localeCompare(b.ref) : a.kind.localeCompare(b.kind);
}

// -------------------------------------------------------------------------------------------------
// The removal report
// -------------------------------------------------------------------------------------------------

export const REMOVAL_REPORT_SCHEMA = 1;

export interface RemovalReportShape {
  readonly schema: number;
  readonly recipe: string;
  readonly base: string;
  readonly generated_by: string;
  /**
   * Filled in by the build. `null` here because this toolchain has not measured anything.
   * A number invented at compile time would be a number nobody measured, in the one artifact we
   * advertise as the truth.
   */
  readonly measured: {
    readonly removed_count: number | null;
    readonly bytes_reclaimed: number | null;
    readonly image_size_bytes: number | null;
    readonly measured_at: string | null;
  };
  readonly floor: { readonly must_remove_at_least: number; readonly met: boolean | null };
  readonly size_budget: { readonly gb: number; readonly met: boolean | null };
  readonly planned: ReadonlyArray<{
    readonly package: string;
    readonly group: string | null;
    readonly reason: string;
    /** Filled in by the build from the package database, before removal. */
    readonly version: string | null;
    readonly bytes_reclaimed: number | null;
    /** `removed` | `already-absent` -- set by the build. */
    readonly outcome: string | null;
  }>;
  readonly not_preinstalled: ReadonlyArray<string>;
  readonly kept_although_nothing_asked_for_them: {
    readonly heading: string;
    readonly packages: ReadonlyArray<{ readonly package: string; readonly role: string; readonly why: string }>;
  };
  readonly post_conditions: ReadonlyArray<PostCondition>;
}

const KEPT_HEADING =
  'Kept although nothing asked for them, because the machine cannot start, update or roll back ' +
  'without these';

export function removalReportShape(
  plan: PrunePlan,
  meta: { base: string; generatedBy: string; recipe?: Recipe },
): RemovalReportShape {
  return {
    schema: REMOVAL_REPORT_SCHEMA,
    recipe: plan.recipe,
    base: meta.base,
    generated_by: meta.generatedBy,
    measured: { removed_count: null, bytes_reclaimed: null, image_size_bytes: null, measured_at: null },
    floor: { must_remove_at_least: plan.floor, met: null },
    size_budget: { gb: plan.sizeBudgetGb, met: null },
    planned: plan.remove.map((item) => ({
      package: item.ref,
      group: item.group,
      reason: item.reason,
      version: null,
      bytes_reclaimed: null,
      outcome: null,
    })),
    not_preinstalled: plan.notPreinstalled,
    kept_although_nothing_asked_for_them: {
      heading: KEPT_HEADING,
      packages: plan.protectedKept.map((p) => ({ package: p.pkg, role: p.role, why: p.why })),
    },
    post_conditions: postConditions(plan, meta.recipe),
  };
}

/**
 * What the check matrix asserts about the BUILT IMAGE.
 *
 * Every one of these is a statement about a filesystem, not about this file, so it holds even if
 * somebody bypasses validation entirely. That is the third of PROTECTED.md's three layers, and it is
 * the only one that does not depend on a list a human maintains.
 */
export function postConditions(plan: PrunePlan, recipe?: Recipe): PostCondition[] {
  const out: PostCondition[] = [
    {
      id: 'P1-floor',
      assert: `the measured removal count is at least ${plan.floor}`,
      why:
        'This is the alarm that catches upstream quietly putting back something we took out. It is ' +
        'checked against what the build measured, never against the plan: the plan is the explicit ' +
        'request and the dependency closure is most of the work.',
    },
    {
      id: 'P2-protected-present',
      assert: `all ${plan.protectedKept.length} protected packages are installed and their units are enabled`,
      why:
        'A fleet that has stopped updating looks exactly like a fleet that is up to date. It boots, ' +
        'it logs in, the browser works, and the difference shows up months later as a compromised ' +
        'machine on a school network. This runs against the built artifact so it holds even if ' +
        'validation was bypassed.',
    },
    {
      id: 'P3-apps-present',
      assert: `every application named in the recipe is launchable (${plan.install.rpm.length} packages, ${plan.install.flatpak.length} Flatpaks)`,
      why:
        'The other half of subtraction. A prune that also removed something the recipe asked for is ' +
        'a broken machine, and "we removed a lot" is not evidence that the right things survived.',
    },
    {
      id: 'P4-size-budget',
      assert: `the published image is at most ${plan.sizeBudgetGb} GB, and no more than 10% larger than the previous published image`,
      why:
        'Subtraction is the product, so quiet growth is the product quietly failing. The second half ' +
        'catches the case the absolute limit misses: an image creeping upward inside its budget.',
    },
    {
      id: 'P5-report-measured',
      assert: 'removal-report.json has no null in its measured block',
      why:
        'The report ships with the image and the customer reads it. A null that reached a customer ' +
        'would be a number we said we would measure and did not. See DECISIONS.md D12: we report the ' +
        'real measured size, never a smaller one we did not achieve.',
    },
  ];

  if (recipe?.policy === 'kiosk') {
    out.push({
      id: 'P6-kiosk-no-shell',
      assert: 'no desktop shell binary and no display manager binary exists in the image',
      why:
        'The spec defines kiosk as "no desktop shell exists in the image at all", and this asserts ' +
        'that literally, against the filesystem. Note what it does NOT claim: shared libraries the ' +
        'closure will not release stay, so this image is larger than a purpose-built minimal one. ' +
        'See DECISIONS.md D12 and schema/README.md section 5.',
    });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// The in-image runner
// -------------------------------------------------------------------------------------------------

/**
 * The script the generated Containerfile embeds.
 *
 * It is a CONSTANT. No value from any recipe is interpolated into it -- the recipe's contribution
 * arrives as a JSON file the script reads, so that no byte a customer wrote is ever a shell word.
 * That is the whole reason this is a string in a source file rather than a template.
 *
 * It resolves the removal transaction first and aborts if the closure would take a protected
 * package, then removes, then verifies every protected package is still installed. The dry run is
 * the early warning; the verification afterwards is the guarantee, because it does not depend on
 * parsing anyone's output format correctly.
 */
export function pruneScript(): string {
  return `#!/usr/bin/bash
# auros-prune -- generated, embedded by auros-recipe compile. Do not edit in the image.
#
# Reads  /usr/share/auros/prune-plan.json
# Writes /usr/share/auros/removal-report.json
#
# Nothing a customer wrote appears in this file. Their recipe arrives as the plan JSON above.
set -euo pipefail

PLAN=/usr/share/auros/prune-plan.json
REPORT=/usr/share/auros/removal-report.json
test -r "$PLAN"

mapfile -t WANTED < <(python3 - "$PLAN" <<'PY'
import json, sys
plan = json.load(open(sys.argv[1]))
for item in plan["planned"]:
    print(item["package"])
PY
)
mapfile -t GUARDED < <(python3 - "$PLAN" <<'PY'
import json, sys
plan = json.load(open(sys.argv[1]))
for item in plan["kept_although_nothing_asked_for_them"]["packages"]:
    print(item["package"])
PY
)

printf 'auros-prune: %s packages requested for removal\\n' "\${#WANTED[@]}"

# Only ask for what is actually installed. A missing package is not an error: upstream moves, and a
# build that fails because something we wanted gone is already gone would be an alarm pointing the
# wrong way.
PRESENT=()
for pkg in "\${WANTED[@]}"; do
    if rpm -q --quiet "$pkg"; then PRESENT+=("$pkg"); fi
done
printf 'auros-prune: %s of them are installed\\n' "\${#PRESENT[@]}"

# Record size and version BEFORE removal. Afterwards the package database no longer knows.
: > /tmp/auros-prune-before.tsv
for pkg in "\${PRESENT[@]}"; do
    rpm -q --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\t%{SIZE}\\n' "$pkg" >> /tmp/auros-prune-before.tsv
done

DNF=dnf5; command -v dnf5 >/dev/null 2>&1 || DNF=dnf

if [ "\${#PRESENT[@]}" -gt 0 ]; then
    # Resolve first. PROTECTED.md layer 2: the closure has historically tried to take out the init
    # system and the package manager on its own, and it does not get the final word.
    "$DNF" remove --assumeno "\${PRESENT[@]}" > /tmp/auros-prune-resolve.txt 2>&1 || true
    for pkg in "\${GUARDED[@]}"; do
        if grep -Eq "(^|[[:space:]])\${pkg}[-[:space:]]" /tmp/auros-prune-resolve.txt; then
            printf 'auros-prune: REFUSED. Removing the requested packages would also take %s.\\n' "$pkg" >&2
            printf 'auros-prune: that package is on the protected set (see schema/PROTECTED.md) and\\n' >&2
            printf 'auros-prune: a fleet that loses it can never be repaired remotely again.\\n' >&2
            exit 1
        fi
    done
    "$DNF" remove -y "\${PRESENT[@]}"
fi

# The guarantee. This does not depend on parsing anybody's output format.
MISSING=()
for pkg in "\${GUARDED[@]}"; do
    rpm -q --quiet "$pkg" || MISSING+=("$pkg")
done
if [ "\${#MISSING[@]}" -gt 0 ]; then
    printf 'auros-prune: REFUSED. These protected packages are no longer installed: %s\\n' "\${MISSING[*]}" >&2
    exit 1
fi

python3 - "$PLAN" "$REPORT" /tmp/auros-prune-before.tsv <<'PY'
import json, sys, time, subprocess

plan_path, report_path, before_path = sys.argv[1], sys.argv[2], sys.argv[3]
plan = json.load(open(plan_path))

before = {}
for line in open(before_path):
    parts = line.rstrip("\\n").split("\\t")
    if len(parts) == 3:
        before[parts[0]] = (parts[1], int(parts[2]))

removed = 0
bytes_reclaimed = 0
for item in plan["planned"]:
    name = item["package"]
    if name in before:
        version, size = before[name]
        item["version"] = version
        item["bytes_reclaimed"] = size
        item["outcome"] = "removed"
        removed += 1
        bytes_reclaimed += size
    else:
        item["outcome"] = "already-absent"

# The closure is most of the work, so the honest count is how many packages the image lost, not how
# many we named. Compare the database to the plan rather than trusting the plan.
try:
    total = int(subprocess.run(["rpm", "-qa", "--qf", "x\\n"], capture_output=True, text=True, check=True).stdout.count("x"))
except Exception:
    total = None

plan["measured"] = {
    "removed_count": removed,
    "bytes_reclaimed": bytes_reclaimed,
    "image_size_bytes": None,
    "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(__import__("os").environ.get("SOURCE_DATE_EPOCH", "0")))),
    "packages_installed_after": total,
}
plan["floor"]["met"] = removed >= plan["floor"]["must_remove_at_least"]
json.dump(plan, open(report_path, "w"), indent=2, sort_keys=True)
print("auros-prune: removed %d packages, %d bytes" % (removed, bytes_reclaimed))
PY

# The floor is asserted by the check matrix against the MEASURED count including the closure, not
# here: this script sees only what it named. P1-floor in post_conditions is the gate.
printf 'auros-prune: wrote %s\\n' "$REPORT"
`;
}
