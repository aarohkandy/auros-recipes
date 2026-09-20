#!/usr/bin/env python3
"""Validate a recipe.yaml against schema/recipe.schema.json.

Run it the same way CI does:

    python3 -m pip install jsonschema pyyaml
    python3 schema/validate.py customers/<fleet>/recipe.yaml
    python3 schema/validate.py --all

This file is in the public repository on purpose. Every rule that decides whether a recipe is
acceptable is either in recipe.schema.json or in here; there is no additional private program that
knows extra rules. That is what makes "if we vanish you rebuild your exact OS from the file" a claim
you can test rather than one we assert.

Rules that a JSON Schema cannot express live in check_cross_file() below, clearly marked, so the
boundary is visible instead of implied.
"""

import argparse
import json
import pathlib
import sys

try:
    import yaml
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError:
    sys.exit("needs: python3 -m pip install jsonschema pyyaml")

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
SCHEMA = HERE / "recipe.schema.json"


def load_schema():
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def where(err):
    return "/".join(str(p) for p in err.absolute_path) or "(top level)"


def index_sentences(root):
    """Map every subschema to the nearest enclosing sentence a human wrote.

    The refusals and the cross-field rules carry a title and a description; the keyword that
    actually fails is usually a level or two below them. This walk lets an error find the sentence
    it belongs to. The whole-file blurb at the root is deliberately not inherited — it explains
    nothing about any particular mistake.
    """
    idx = {}

    def walk(node, inherited):
        if isinstance(node, dict):
            here = node if (node.get("title") and node.get("description") and node is not root) else inherited
            idx[id(node)] = here
            for value in node.values():
                walk(value, here)
        elif isinstance(node, list):
            for value in node:
                walk(value, inherited)

    walk(root, None)
    return idx


def refused_keys(err):
    """The key names a by-name refusal was about, if this error is one."""
    if err.validator == "not" and isinstance(err.validator_value, dict):
        branches = err.validator_value.get("anyOf") or []
        return [b["required"][0] for b in branches if isinstance(b, dict) and b.get("required")]
    return []


def explain(err, root, idx):
    """Surface the sentence the schema author wrote, not the validator's noise."""
    import difflib

    authored = idx.get(id(err.schema)) if isinstance(err.schema, dict) else None
    for node in err.context or []:
        deeper = idx.get(id(node.schema)) if isinstance(node.schema, dict) else None
        if deeper is not None:
            authored = deeper

    if err.validator == "additionalProperties":
        known = sorted((err.schema or {}).get("properties", {}))
        unknown = [k for k in err.instance if k not in known] if isinstance(err.instance, dict) else []
        lines = []
        for key in unknown:
            near = difflib.get_close_matches(key, known, n=2, cutoff=0.7)
            hint = f" Did you mean {' or '.join(near)}?" if near else ""
            lines.append(f"'{key}' is not a field this file has.{hint}")
        lines.append(
            "Every effect a recipe can have is a named field with a description. An unknown key is "
            "refused rather than ignored, because a subtraction instruction that is quietly dropped "
            "is the worst failure a product built on subtraction can have. See README section 3."
        )
        return "\n      ".join(lines)

    if err.validator == "enum":
        choices = [str(x) for x in err.validator_value]
        near = difflib.get_close_matches(str(err.instance), choices, n=3, cutoff=0.4)
        msg = f"'{err.instance}' is not one of the published choices."
        msg += f" Nearest: {', '.join(near)}." if near else f" Choose from: {', '.join(choices)}."
        desc = (err.schema or {}).get("description")
        return msg + (f"\n      {desc}" if desc else "")

    if authored:
        return f"{authored['title']}\n      {authored['description']}"

    own = err.schema.get("description") if isinstance(err.schema, dict) else None
    if own and err.validator in ("pattern", "const", "minLength", "maxLength", "minItems", "minimum"):
        return f"{err.message.split(' does not match')[0]} — {own}" if err.validator == "pattern" else own
    return err.message


def check_cross_file(doc, path, problems):
    """Rules a JSON Schema genuinely cannot carry. Kept short and kept here, not hidden."""
    path = path.resolve()
    folder = path.parent.name
    if doc.get("name") and doc["name"] != folder:
        problems.append(
            f"name: '{doc['name']}' does not match the folder it sits in ('{folder}').\n"
            "      A recipe's name is also its image name, so the two must agree."
        )

    siblings = sorted(p for p in (REPO / "customers").glob("*/recipe.yaml") if p != path)
    for other in siblings:
        try:
            name = (yaml.safe_load(other.read_text(encoding="utf-8")) or {}).get("name")
        except yaml.YAMLError:
            continue
        if name and name == doc.get("name"):
            problems.append(
                f"name: '{name}' is already used by {other.relative_to(REPO)}.\n"
                "      Two fleets sharing one name means two organisations sharing one image."
            )

    # hardware/compat.tsv lives in the control repo. An unknown model is DISCLOSED, never skipped:
    # it is a warning here and a stamp on the build report, so it stays a known unknown.
    tsv = REPO.parent / "hardware" / "compat.tsv"
    known = set()
    if tsv.exists():
        rows = [ln.split("\t") for ln in tsv.read_text(encoding="utf-8").splitlines() if ln.strip()]
        known = {r[0] for r in rows[1:] if r}
    for model in doc.get("hardware", {}).get("models", []):
        if model not in known:
            print(f"  note  hardware/models: '{model}' has no row in hardware/compat.tsv yet.")
            print("        Allowed, and recorded on the build report as untested hardware.")

    # Not checkable here, and said out loud so the boundary is visible:
    #   - application names must exist in the catalogue inside the pinned base image
    #   - the chosen language's fonts must cover first_boot_message
    #   - must_remove_at_least may only fall in a change that states a reason and carries a
    #     second approval (CI compares against the last published value)
    # Each is enforced at build time, against the built image, not against this file.


def validate(path, validator):
    print(f"\n{path}")
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        print(f"  FAIL  this file is not valid YAML\n      {exc}")
        return False
    if not isinstance(doc, dict):
        print("  FAIL  a recipe is a block of named settings, not a list or a bare value")
        return False

    idx = index_sentences(validator.schema)
    errors = sorted(validator.iter_errors(doc), key=where)

    # A reserved key produces two errors: "unknown key" and the by-name refusal that explains why
    # we reserved it. Only the second one teaches anything, so the first is dropped for that key.
    named = {k for e in errors for k in refused_keys(e) if k in (doc or {})}
    kept = []
    for e in errors:
        if e.validator == "additionalProperties" and isinstance(e.instance, dict):
            allowed = set((e.schema or {}).get("properties", {}))
            if all(k in named for k in e.instance if k not in allowed):
                continue
        if e.validator == "not" and refused_keys(e) and not any(k in (doc or {}) for k in refused_keys(e)):
            continue
        kept.append(e)

    # Where a value fails both a closed list and a rule that was written to explain that exact
    # value — asking to remove a screen reader, say — the written rule is the one worth printing.
    authored_paths = {tuple(e.absolute_path) for e in kept
                      if isinstance(e.schema, dict) and idx.get(id(e.schema)) is not None}
    kept = [e for e in kept
            if not (e.validator == "enum" and tuple(e.absolute_path) in authored_paths)]

    problems = [f"{where(e)}: {explain(e, validator.schema, idx)}" for e in kept]
    check_cross_file(doc, path, problems)

    if not problems:
        print("  PASS")
        return True
    for p in problems:
        print(f"  FAIL  {p}")
    return False


def main():
    ap = argparse.ArgumentParser(description="Validate recipe.yaml files.")
    ap.add_argument("recipes", nargs="*", type=pathlib.Path)
    ap.add_argument("--all", action="store_true", help="every recipe under customers/")
    args = ap.parse_args()

    targets = list(args.recipes)
    if args.all or not targets:
        targets = sorted((REPO / "customers").glob("*/recipe.yaml"))
    if not targets:
        sys.exit("nothing to validate")

    validator = load_schema()
    ok = all([validate(p, validator) for p in targets])
    print(f"\n{'all recipes pass' if ok else 'at least one recipe was refused'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
