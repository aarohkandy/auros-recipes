#!/usr/bin/env bash
# Reintroduce each bug, run the suite, confirm the right tests go red, restore.
# A test that stays green under its own mutation is a test that cannot fail.
set -uo pipefail
R=/Users/aaroh/auros/auros-recipes
B=$(mktemp -d)
cp -R "$R/src" "$B/src"; cp -R "$R/customers" "$B/customers"; cp "$R/package.json" "$B/"; cp "$R/README.md" "$B/"; cp "$R/schema/recipe.schema.json" "$B/"
restore() { rm -rf "$R/src" "$R/customers"; cp -R "$B/src" "$R/src"; cp -R "$B/customers" "$R/customers"; cp "$B/package.json" "$R/"; cp "$B/README.md" "$R/"; cp "$B/recipe.schema.json" "$R/schema/"; }
trap restore EXIT

run() { # run(label, expected-substring-of-a-failing-test-name)
  local label="$1"; shift
  local out; out=$(cd "$R" && node --experimental-strip-types --test test/*.test.ts 2>&1)
  local failed; failed=$(printf '%s' "$out" | grep -E "^(not ok|    not ok)" | sed -E 's/^ *not ok [0-9]+ - //' | sort -u)
  local n; n=$(printf '%s' "$out" | grep -cE "^(not ok|    not ok)")
  if [ "$n" -eq 0 ]; then
    printf '  NOT DETECTED  %s\n' "$label"
  else
    printf '  RED (%s tests)  %s\n' "$n" "$label"
    printf '%s\n' "$failed" | head -4 | sed 's/^/      -> /'
  fi
  restore
}

echo "=== M1: kiosk picks the first flatpak in list order again (the determinism + silent-winner bug) ==="
perl -0pi -e "s/const candidates = kioskCandidates\(recipe, catalogue\);/const candidates = recipe.apps.map((n) => catalogue.apps.get(n)).filter((a): a is NonNullable<typeof a> => a !== undefined \&\& a.kind === 'flatpak').map((a) => ({ name: a.name, ref: a.ref }));/" "$R/src/compile.ts"
perl -0pi -e "s/  if \(candidates\.length > 1\) \{/  if (false) {/" "$R/src/compile.ts"
perl -0pi -e "s/  const openable = kioskCandidates\(recipe, catalogue\);/  const openable = [{ name: 'x', ref: 'x' }];/" "$R/src/validate.ts"
run "kiosk browser chosen by list order, ambiguity not refused"

echo "=== M2: windows_apps.tested emitted in recipe order again (the S7 determinism bug) ==="
perl -0pi -e "s/\Q? { ...recipe.windows_apps, ...(recipe.windows_apps.tested ? { tested: sortTested(recipe.windows_apps.tested) } : {}) }\E/? recipe.windows_apps/" "$R/src/compile.ts"
run "windows_apps.tested unsorted"

echo "=== M3: the sign-off offers a fork again (the D30/D31 bug, in the PR body) ==="
perl -0pi -e "s/'This file is readable, and so is every rule that decides whether it is acceptable\. Nothing '/'This file is public. If we disappear tomorrow, you fork this repository and rebuild this exact operating system with tools you already have. '/" "$R/src/explain.ts"
run "explain tells the customer to fork the repository"

echo "=== M4: package.json declares Apache-2.0 again ==="
perl -0pi -e 's/"license": "SEE LICENSE IN LICENSE"/"license": "Apache-2.0"/' "$R/package.json"
run "package.json declares Apache-2.0"

echo "=== M5: README says Fork it again ==="
printf '\n\n## Licence\n\nApache 2.0. Fork it. That is the point.\n' >> "$R/README.md"
run "README invites a fork"

echo "=== M6: a committed Containerfile edited by hand (golden-file drift) ==="
perl -0pi -e 's/RUN bootc container lint/RUN bootc container lint || true/' "$R/customers/example-school/Containerfile"
run "golden file drifts from its recipe"

echo "=== M7: the prune step quietly dropped from the compiler ==="
perl -0pi -e "s|out\.push\('RUN /usr/libexec/auros/auros-prune'\);|out.push('# prune skipped');|" "$R/src/compile.ts"
run "the build no longer prunes"

echo "=== M8: the version-pin shape relaxed to allow digits ==="
perl -0pi -e 's/\Q^[A-Za-z][A-Za-z+#]*(?: [A-Za-z][A-Za-z+#]*)*$\E/^[A-Za-z0-9][A-Za-z0-9+#.>=<:*_-]*(?: [A-Za-z0-9+#.>=<:*_-]+)*$/' "$R/../auros-recipes/schema/recipe.schema.json" 2>/dev/null || true
run "appName pattern accepts digits and operators"

echo "=== M9: explain rounds the removal count instead of computing it ==="
perl -0pi -e 's/\QThose are the ${plan.remove.length} packages this recipe names by hand\E/Those are the 50 packages this recipe names by hand/' "$R/src/explain.ts"
run "explain prints a count it did not compute"

echo "=== M10: the labelled rows stop wrapping ==="
perl -0pi -e 's/  const wrapped = wrap\(value, indent\);/  const wrapped = indent + value;/' "$R/src/explain.ts"
run "explain lines run off the side"

echo "=== M11: refusals leak the raw regex to a human again ==="
perl -0pi -e "s/    if \(error\.keyword === 'pattern'\) \{/    if (false) {/" "$R/src/schema.ts"
run "a refusal prints a regular expression"

echo "=== M12: compile stops refusing a recipe validate rejected ==="
perl -0pi -e 's/if \(!result\.ok \|\| !result\.recipe \|\| !result\.plan\) \{/if (false \&\& (!result.ok || !result.recipe || !result.plan)) {/' "$R/src/cli.ts"
run "compile runs on a refused recipe"

echo "=== M13: the protected set is silently filtered instead of refused ==="
perl -0pi -e 's/      violations\.push\(/      if (false) violations.push(/' "$R/src/prune.ts"
run "a protected package is filtered rather than refused"

echo
echo "=== CONTROL: no mutation at all ==="
run "unmutated tree (must show NOT DETECTED)"
