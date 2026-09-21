# auros-recipes

Every operating system we build is described by one file in this repository, and this repository is
public.

A recipe says who the machines are for, what language they speak, what is installed, what is
deleted, and what rules are in force. It is about forty lines. It is meant to be read by the person
who has to maintain the fleet, not by an engineer, and in eighteen months it is the only thing that
explains what those machines are.

Start with [`schema/README.md`](schema/README.md) — the field reference, with a fully annotated
example. [`schema/PROTECTED.md`](schema/PROTECTED.md) explains the handful of things a recipe may
never remove, and why refusing to delete them is the same decision as deleting everything else.

---

## What is in here

| | |
|---|---|
| `customers/<fleet>/recipe.yaml` | One fleet. The file a person writes. |
| `customers/<fleet>/Containerfile` | Generated from it, and committed, so a rebuild needs nothing of ours. |
| `schema/recipe.schema.json` | Every rule, as data. Both validators read this and nothing else. |
| `schema/validate.py` | The validator with no toolchain: `pip install jsonschema pyyaml` and go. |
| `catalogue/*.tsv` | How `Google Chrome` becomes a package and `Marathi` becomes a font. |
| `src/` | The toolchain: validate, compile, explain. |
| `test/` | Mostly the refusals. That ratio is deliberate. |

---

## The toolchain

```
pnpm install          # also builds; there is a prepare script
pnpm test
```

Node 22.18 or newer, because the tests are TypeScript run directly by `node --test`. Two runtime
dependencies — `ajv` and a YAML parser — and nothing else, on purpose.

```
node dist/cli.js validate customers/example-school/recipe.yaml
node dist/cli.js validate --all
node dist/cli.js compile  customers/example-school/recipe.yaml -o customers/example-school/Containerfile
node dist/cli.js explain  customers/example-school/recipe.yaml
```

`explain` prints, in plain English, what a recipe produces: what is installed, what is deleted, what
policy is in force, what stays no matter what anybody asks, and — a section of its own — what the
product **will not do**. That text becomes the pull request body on an order, and it is what the
person signing off actually reads.

Exit codes, because CI reads them:

| | |
|---|---|
| `0` | acceptable |
| `1` | refused |
| `2` | the tool could not run — a missing file, a broken catalogue |

The middle one is a verdict and the last one is not. Collapsing them would let a broken toolchain
look like a clean run, which is how a failing build once reported success and produced no image
(`DECISIONS.md` D19).

**There is no `--force`, no `--skip-checks` and no `--allow-untested`**, for the same reason
`recipe.schema.json` has no field for them. A flag that skips a check is a flag somebody uses once,
at the end of a long day, for a good reason, and then the check is advisory forever.

### `compile` needs the namespace file

`auros.config.json` holds the organisation, the registry and the base image. It is the single source
of truth for all three (`DECISIONS.md` D1), so nothing in `src/` writes any of them as a literal —
there is a test that greps for exactly that — and `compile` will stop rather than guess. It looks in

1. `$AUROS_CONFIG`,
2. `.auros-meta/auros.config.json` inside this repository,
3. every directory above this one, which is the ordinary local layout.

CI fetches the control repository into `.auros-meta`. Locally, keep the two checkouts side by side.

---

## If we stop, your machines do not

**Read `LICENSE` first. This repository is readable; it is not open source.** Everything here is
proprietary and all rights are reserved, and nothing on this page is permission to copy, fork,
redistribute or resell any of it (`DECISIONS.md` D30/D31).

What that leaves is still the thing that matters to a school with a hundred and eighty laptops, and
it is worth stating precisely rather than warmly:

- **The image is already yours.** It is installed on the machines and it keeps booting whatever
  happens to us. That was never the risk.
- **What would stop is the maintenance** — the nightly rebuild against upstream that keeps it
  patched. Spec §1.1: the maintained image is the product, not the OS.
- **So the commitment is a published term, not a sentiment:** if Auros ceases operating, each
  customer is given the build files for their own image — their recipe, the base Containerfile and
  the build scripts — so that they or anybody they hire can keep patching those machines. Not a
  licence to our tooling. Not redistribution rights. The specific artefacts needed to keep *their*
  fleet alive.

The `Containerfile` beside each recipe is committed and carries everything it installs inline, so it
needs no build context and no part of this toolchain. It is the centre of that handover: on one Linux
machine with `podman`, the rebuild is one command.

```
podman build -f customers/<your-fleet>/Containerfile -t my-os .
```

That file being committed (`DECISIONS.md` D28) is what makes the commitment above something that can
be executed rather than promised. **Nothing here has been executed end to end yet.**
`.github/workflows/replaceable.yml` is paused until there is a handover artefact to execute it
against — when there is, it gets run rather than asserted.

### The base, in a handover

The `Containerfile` starts from our published base image. The handover includes the base
Containerfile and build scripts, so if our registry is gone too, the base is built from those and the
recipe pointed at it:

```
podman build --build-arg BASE=localhost/my-auros-base:hardened \
             -f customers/<your-fleet>/Containerfile -t my-os .
```

`BASE` is the only override, it exists for exactly this case, and it is not reachable from a
`recipe.yaml` — the validator refuses a recipe that names a base at all, so no fleet can end up on a
different foundation from another by accident or by asking nicely.

### Changing a recipe

Edit `recipe.yaml`, then regenerate:

```
pnpm install
node dist/cli.js validate customers/<your-fleet>/recipe.yaml
node dist/cli.js compile  customers/<your-fleet>/recipe.yaml -o customers/<your-fleet>/Containerfile
```

You will need `auros.config.json` for that step, from the control repository checked out next to
this one.

If you would rather not install anything, check your file with the tools you probably already have:

```
python3 -m pip install jsonschema pyyaml
python3 schema/validate.py customers/<your-fleet>/recipe.yaml
python3 schema/refusals.test.py
```

Those two programs — Python with `jsonschema`, and ours with `ajv` — read the same
`recipe.schema.json` and nothing else, and `test/parity.test.ts` asserts they return the same verdict
on every case in the refusal table. **If they ever disagreed it would mean one of them knows a rule
the file does not carry, and the file would no longer be the whole of what a recipe means.**

---

## What a recipe cannot do, and why that is the product

Most configuration formats are judged by what they let you express. This one is judged by what it
refuses. `schema/README.md` §3 has the full list with the reasoning; the short version:

- **It cannot name what it is built on.** No `from`, no `base`, no `registry`, no `digest` — not
  "those are validated", *there is no field*. Every fleet sits on the same foundation, which is the
  only reason a security fix is one rebuild instead of a spreadsheet. A digest is refused for the
  reason worth sitting with: pinning an organisation to one exact image freezes them off the rebuild
  that carries the next security fix.
- **It cannot pin, hold or exclude a version** — and not because a rule says so. An application name
  contains no digits, and every way of writing a version number needs one. `firefox-140.0`,
  `Firefox 140`, `kernel>=6.1` and `foo=1.2` are not rejected requests; they are not sentences this
  format can contain. A rule can be argued with on a deadline. A shape cannot.
- **It cannot run code, add a package source, or drop a file into the image.** Orders arrive here as
  pull requests from strangers. That is the design, and it is only safe in a format where a stranger
  cannot send us a command.
- **It cannot prune its own update path.** The removable list contains nothing the machine needs in
  order to start, update itself, verify what it installs, reach the network, or undo a bad update.
  Those things have no name here at all.
- **It cannot ask for less testing.** `hardware.also_test` adds a test machine. There is no
  `also_skip`.
- **It cannot make a claim we cannot evidence.** No compatibility percentage, no savings figure, no
  testimonial. What it can carry is evidence: a named program, the day somebody ran it, and one of
  four results.

Every one of those is a test in `test/refusals.test.ts`, and each test asserts not merely that the
recipe was refused but that the refusal **said why**. A rejection a reader does not understand gets
worked around, and every workaround for these particular rules ends in the same place.

---

## The toolchain in four modules

**`src/validate.ts`** runs the schema, then the rules a document grammar cannot carry: a key that is
refused for the right reason rather than as "unexpected property"; a terminal installed on a locked
fleet, which defeats `can_reach_a_terminal: false` without contradicting any single field; an
application installed while the group it belongs to is removed; a language with no font package,
which produces a first-boot screen of empty boxes and a perfectly valid file.

**`src/prune.ts`** resolves "keep only these eleven" into a concrete removal set and defines the
shape of `removal-report.json`. Every measured number in that shape is `null` here and filled in by
the build, because this module has not measured anything. `must_remove_at_least` is asserted against
the **measured** count including the dependency closure, never against the plan — checking the plan
would be an alarm that can never go off.

**`src/compile.ts`** writes the Containerfile. Deterministic: every list sorted, no clock read
(`SOURCE_DATE_EPOCH` is honoured, and with nothing set the fallback is the recipe's own approval
date, which is a property of the file rather than of the machine compiling it), no build context
required. Every string a human wrote is emitted as base64 and decoded into a file, so no byte a
customer wrote is ever a shell word; the only values written literally come from a closed list or a
strict pattern, and even those go through a function that throws rather than emit a character it did
not expect.

**`src/explain.ts`** is the one written for somebody who is not an engineer.

---

## Things that are honestly not here yet

Written down rather than discovered later. `schema/README.md` §4 has the longer version.

- **Wireless and printer credentials.** Your laptops need one network and one printer to be usable
  on day one, and this file cannot carry either, because the repository is public. The intended
  answer is a sealed enrolment bundle handed over separately — designed, not built. Until then
  somebody sets the network by hand on each machine, which is honest and is not good enough.
- **Staged rollout.** No way to say "these five staff-room laptops take the new image first". That
  is a real requirement and it is deliberately absent rather than present-and-ignored: a field the
  machine does not honour is a lie in a file whose whole claim is that it *is* the machine.
- **The theme block reaches the image as data and is applied by nothing.** `preset`, `accent`,
  `text_scale` and `cursor_size` are recorded and the desktop layer that reads them is not written
  yet. Validation says so on every recipe that sets one, `explain` says so to the customer, and the
  note is stamped into the generated Containerfile — a disclosed gap rather than a field quietly
  doing nothing.
- **The catalogue lives here rather than inside the base image**, which `schema/README.md` §6 says is
  where it belongs. See [`catalogue/README.md`](catalogue/README.md) for what that costs and what
  changes when the base grows one.
- **`hardware/compat.tsv` is empty.** An unknown model is therefore *disclosed* as untested on the
  build report and on the pull request, never silently accepted. A model a human has recorded as
  unsupported is refused, because that call is theirs to make.

---

## Licence

**Proprietary. All rights reserved.** See [`LICENSE`](LICENSE) and, for what the built *image*
carries that this notice cannot restrict, [`LICENSING.md`](../LICENSING.md) in the control
repository.

Readable is not the same as open. You may read every rule that decides whether a recipe is
acceptable — that is the whole reason this repository is public, and it is what lets a customer
check our working instead of trusting us. No licence to copy, modify, distribute, sublicense or
sell any part of it is granted, by this file or by the fact that you can see it.

The images this software builds are derivatives of Fedora and Universal Blue and carry those
components' licences, several of which are copyleft. Nothing here restricts any right a recipient
holds under those licences with respect to those components. Both things are true at once.
