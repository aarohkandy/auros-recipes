# `recipe.yaml` — the field reference

You are holding the whole computer. If something is not written in your `recipe.yaml`, it is not on the
laptops. Change one line, open a pull request, and every machine in the fleet has that change after its
next restart.

This file is written for the person who has to maintain a fleet and has never written YAML. You do not
need to understand containers, package managers or Linux to fill it in. You do need to read it, because
in eighteen months it is the only thing that explains what these machines are.

Everything below is enforced by `schema/recipe.schema.json`, a strict JSON Schema. It is in this public
repository on purpose: if we disappear, you validate and rebuild your own operating system with tools you
already have, and you get the same answers we would have given you. That is the point of the whole
company and it is only true if the rules live in a file you can run, not in a program only we ship.

---

## 1. A complete example, annotated

This is `customers/example-school/recipe.yaml` with the reasoning written in. Forty lines describe a
hundred and eighty laptops.

```yaml
schema: 1                          # which version of this form. Never guessed at — an unfamiliar
                                   # number makes the build stop rather than reinterpret your file.

name: example-school               # the folder this file sits in, and the fleet's name everywhere else.
                                   # lowercase, hyphens, nothing else. No two fleets may share one.

for: >                             # WHO THESE MACHINES ARE FOR, in your own words. Required, twenty
  The 180 shared classroom         # words minimum. This is the paragraph that makes the file legible
  laptops at a Marathi-medium      # to whoever inherits it, and the first thing that distinguishes
  secondary school. Pupils sign    # two fleets when you compare them. Do not skip it. Everything
  in to Google Workspace in the    # below is a consequence of what you write here.
  browser and do all their work
  there. Nobody installs anything
  by hand on these machines.

organisation:
  display_name: Example Vidyalaya  # shown on the login screen, the help screen and at first boot.
  helpdesk:                        # printed under Start > Help, so a pupil knows who to tell.
    label: School IT helpdesk      # a role and a desk line. Never someone's personal mobile —
    phone: "+91 20 2555 0143"      # this repository is public, which is a feature, not an oversight.

hardware:
  machines: 180                    # how many.
  models:                          # short names that join to hardware/compat.tsv. A model recorded
    - dell-latitude-e6440          # there as unsupported is refused. A model with no row yet is NOT
    - hp-probook-650-g1            # silently accepted — the build stamps "untested hardware" onto
    - lenovo-thinkpad-t440         # the report and onto your pull request, so it is a disclosed
  also_test: [bios-legacy]         # unknown rather than a skipped check.
                                   # also_test ADDS a test machine. Look at the shape of that field:
                                   # there is no also_skip and no exclude. You may only add tests.

language: Marathi                  # the way a person says it, not mr_IN.UTF-8. Choosing a language
other_languages:                   # also brings in the fonts it needs, so there is no font list here
  - English (India)                # for you to get wrong.
  - Hindi                          # extra languages a user can switch to without a rebuild.

keyboard: English (US)             # what is printed on the keys. Only Latin layouts are allowed here,
                                   # and that is a safety rule: the login screen and the disk-unlock
                                   # prompt appear before any input method starts, so a fleet whose
                                   # main layout cannot type a password is a fleet nobody can log in to.
second_script: Marathi (InScript)  # the script the user toggles TO. Added, never substituted.
switch_scripts_with: Windows key + Spacebar   # required whenever there is a second script.

timezone: Asia/Kolkata             # the one place a code beats a name. No "+05:30" (wrong twice a
                                   # year) and no "auto" (a machine that reads its own surroundings
                                   # makes two builds of this file into two different computers).

apps:                              # EVERY application on these machines, by the name people say.
  - Calculator                     # There are ten here. There will be ten on the laptop.
  - Document Viewer                #
  - Files                          # A name here contains no digits at all. That single rule is why
  - Firefox                        # "firefox-140.0", "Firefox 140" and "foo=1.2" are not rejected
  - GCompris                       # requests — they are not sentences this file can contain.
  - Google Chrome
  - Image Viewer
  - Scratch
  - Text Editor
  - VLC Media Player

prune:                             # ---- THIS BLOCK IS THE PRODUCT ----
  keep_only_the_apps_above: true   # "remove everything except those ten things", in one line,
                                   # pointing at the list directly above it. The keep list and the
                                   # install list are the same list, so they cannot drift apart.
  also_keep: [printing]            # capabilities that are not applications but are still needed.
  also_remove:                     # named groups that survive the untangling but are unwanted.
    - developer tools              # You may only choose from a published list, and that list does
    - games                        # not contain anything the machine needs to start, update itself
    - remote desktop               # or undo a bad update. Those things have no name here at all.
    - sample wallpapers and media
    - virtualisation
  must_remove_at_least: 240        # if a build removes fewer than this, it FAILS. This is the alarm
                                   # that catches upstream quietly putting back something we took
                                   # out. Raise it freely. Lowering it needs a written reason and a
                                   # second person's approval — an alarm you can turn down one point
                                   # at a time is not an alarm.

policy: managed                    # open | managed | locked | kiosk. Four words with published
                                   # meanings and no fifth value. See §3.

windows_apps:                      # the honest .exe capability.
  enabled: true                    # installs a Windows-compatibility app from Flathub.
  we_promise_nothing_else: true    # required, and only ever true. It puts the honest sentence into
  tested:                          # the file you actually read instead of into a sales call.
    - app: Vidyalaya School ERP desktop client
      date: "2026-09-11"           # someone sat down and ran it, on that day, on one of these.
      result: works with caveats   # works | works with caveats | fails | untested. Nothing in between.
      note: Prints report cards. The fingerprint attendance module cannot see the reader.
    - app: Tally.ERP
      date: "2026-09-11"
      result: fails
      note: Crashes during licence activation. The office PC stays on Windows for Tally.

theme:
  preset: light                    # light | dark | high contrast | follow the system | user chooses
  accent: "#1f5c3d"                # lowercase hex, so two files differing only in capitals cannot
  text_scale: 1.1                  # become two different images. 1.1 because these are small screens.

updates:
  install_between: "21:00-05:00"   # when a waiting patch lands. Note what is missing: there is no
                                   # way to switch updating off. See §3.

first_boot_message: नमस्कार! काही अडचण असल्यास शिक्षकांना सांगा.
                                   # the first sentence a stranger reads, in their language. It is
                                   # written into the image as text and displayed. It is never placed
                                   # into a build instruction or a command, so there is nothing in it
                                   # that could run.

size_budget_gb: 9                  # how big the finished image may be. The build fails if it exceeds
                                   # this, and fails if it grows more than 10% over the last one.
                                   # Subtraction is the product, so quiet growth is the product
                                   # quietly failing.

approved_by:                       # a named human signed off on this fleet.
  enrolment: pending               # the approval RECORD lives outside this file. An approval
  name: A. Deshmukh                # asserted inside the very file being changed proves nothing.
  role: IT Coordinator             # "pending" still test-builds — it just never reaches a machine.
  date: "2026-09-18"
```

Two more worked examples sit beside it: `customers/example-kiosk` (forty walk-up kiosks, one
application, no desktop at all) and `customers/example-workstation` (one developer machine that keeps
the ordinary desktop and takes a few things out of it). They are illustrations, not customers. No
organisation named in this repository exists.

---

## 2. Every field, in order

The order above is the canonical order. Keep it. Two fleets whose files are ordered the same way produce
a comparison that shows meaning; two ordered differently produce a wall of reshuffling. Non-canonical
files are **rejected, never silently tidied** — a tool that rewrites your file is a second, weaker set of
rules running ahead of the real ones.

| Field | Required | What it does | What it refuses |
|---|---|---|---|
| `schema` | yes | Pins this file to one set of rules. | Any number these rules do not know. Refusing beats guessing what a field used to mean. |
| `name` | yes | Folder name, image name, what the console calls this fleet. | Capitals, dots, colons, slashes, `@`. A dot or colon would let this name be read as an image tag somewhere downstream. Also a name already used by another fleet. |
| `for` | yes | The paragraph that makes the file legible in a year. | Under twenty words. A blank one is a file nobody can inherit. |
| `organisation.display_name` | yes | The name shown on the machine. | Control characters and text-direction overrides. A direction override makes this file read one way in a review and mean another to the compiler. |
| `organisation.helpdesk` | yes | Who a confused user is told to contact, on the machine's own help screen. | A missing phone. "Contact your administrator" is not help. |
| `organisation.logo` | no | A PNG in this folder. | A URL (unreproducible, and a supply-chain dependency in a school's wallpaper), an absolute path, `..`, a symlink, anything that is not `.png`. The build decodes and re-encodes it, so the bytes that ship are ones we produced from your picture. |
| `hardware.machines` | yes | Fleet size. | — |
| `hardware.models` | yes | Joins to `hardware/compat.tsv`. | A model a human has declared unsupported. An unknown model is allowed and **disclosed** as untested. |
| `hardware.also_test` | no | Adds a virtual test machine. | There is no `also_skip`, no `exclude`, no way to mark a test optional. You may only add. |
| `language` | yes | What the machine speaks. Pulls its fonts automatically. | A locale code. Someone who typed `mr_IN.UTF-8` cannot check it; someone who typed `Marathi` can. |
| `other_languages` | no | Switchable without a rebuild. | — |
| `keyboard` | yes | The layout matching the keycaps. | Any non-Latin layout. See the note in §1 — this one prevents a fleet nobody can log into. |
| `second_script` | no | A second layout to toggle to. | Being set without naming the toggle. |
| `switch_scripts_with` | with `second_script` | The key combination, said out loud. | Being set with nothing to switch to. |
| `timezone` | yes | The clock. | Offsets, `auto`, `local`, `geoip`. |
| `apps` | yes | Everything installed, in human names. Doubles as the keep list. | Any digit; any raw package or Flatpak identifier; any name not in the catalogue, answered with the nearest matches. |
| `prune.keep_only_the_apps_above` | yes | The entire "and nothing else" instruction. | — |
| `prune.also_keep` | no | Capabilities, not packages. Keeping one file out of a printing stack gives you a printer that prints nothing. | Package names. |
| `prune.also_remove` | with `keep_only:false` | Named groups from a published list. | Anything outside that list. Accessibility tools are refused **by name, with a sentence**, not quietly ignored. |
| `prune.must_remove_at_least` | yes | A floor. Fewer removed ⇒ the build fails. | Zero. A recipe that removes nothing is not a recipe we build. |
| `policy` | yes | `open` / `managed` / `locked` / `kiosk`. | A fifth value. A mode we cannot prove is in force on a booted machine is a mode we cannot sell. |
| `desktop` | no | The Windows-shaped layer, one readable line per behaviour. All default to the familiar answer. | Being present at all under `kiosk`. A terminal on anything but `open`. Contradicting `locked`. |
| `kiosk` | with `policy: kiosk` | What the one window shows, where it may go, how long before the session is wiped. | Being present under any other policy. `http://`, `file://`, `data:`, a username in the address, a query string. An empty allow-list — a kiosk that can reach nothing is broken, not secure. |
| `windows_apps` | no | The honest `.exe` capability. | Being present under `kiosk` (the compatibility layer is a desktop application and there is no desktop). A result of `works` with no note. Any list of tested programs while the layer is off. |
| `theme` | no | Preset, accent, text size, pointer size. | Capital letters in hex. A stylesheet or theme archive — that is arbitrary content; a preset plus a colour is not. |
| `updates` | no | The nightly window. | There is no field to switch updating off, and no field to stay on an older image. |
| `first_boot_message` | no | The first sentence a stranger reads. | Control characters, direction overrides, and text in a script the chosen language's fonts cannot draw. A first-boot screen of empty boxes is the worst possible first impression. |
| `size_budget_gb` | yes | The size you are buying. | — |
| `approved_by` | yes | A named human, plus a reference to the approval record kept elsewhere. | `enrolment: pending` blocks publishing but still test-builds — which is exactly what "charged only once the test build passes" needs. |

### Two YAML notes, because they have bitten people

Write `true` and `false`, never `yes` and `no`. Different YAML tools disagree about whether `no` is a
boolean or the word "no" — the classic version of this reads a country code as `false`. The schema only
accepts `true`/`false`, so the disagreement cannot reach a build.

Quote dates and times: `date: "2026-09-18"`, `restart_daily_at: "03:30"`. Unquoted, some tools turn them
into their own date objects and the value stops being the text you wrote.

---

## 3. What this file will refuse to do, and why that's the point

Most configuration formats are judged by what they let you express. This one is judged by what it does
not. Below is not a list of restrictions we are apologising for. It is the product.

### It cannot name what it is built on

There is no `from`, no `base`, no `image`, no `registry` and no `digest`. Not "those are validated" —
**there is no field.** The `FROM` line is written by the compiler from `auros.config.json`, the one file
that holds the namespace, and nothing you write can influence it.

Every fleet sits on the same foundation, and that is the only reason a security fix is one rebuild
instead of a spreadsheet. The moment one organisation is on a different base, patching everybody means
touching every file, and "still patched in four years" becomes a hope.

A digest is refused for a reason worth sitting with: **pinning you to one exact image would freeze you
off the rebuild that carries the next security fix.** It looks like caution and it is the mechanism that
turns the machine we sold you into the abandoned machine we sold you a way out of.

If a machine genuinely needs a different base, that is a conversation with a person. It is a customer we
may decline. It is never an edit to this file.

### It cannot pin, hold back, or exclude a version

No `pin`, no `hold`, no `version`, no `exclude`, and — more importantly — the `apps` list has no shape
that could carry one. An application name has no digits in it, and every way of writing a version number
needs one. `firefox-140.0` fails on the dot and the hyphen. `Firefox 140` fails because a word may not
start with a digit. `kernel>=6.1` and `foo=1.2` fail on characters this format does not have.

That is the difference between a rule and a shape. A rule can be argued with at four in the afternoon on
a deadline. A shape cannot.

Holding a package back is how a machine ends up unpatched while still looking maintained. If a new
version broke your fleet, we want that report, and the fix goes into the base for everybody — not into
one organisation's file where it quietly keeps them behind.

### It cannot choose a kernel, patch a driver, or add a boot argument

The kernel, its modules, out-of-tree drivers and the boot command line belong to the base, where one team
patches them once for everybody. A per-fleet kernel is a fork wearing a smaller hat.

### It cannot run code

No `run`, no `script`, no `post_install`, no `hooks`, no environment variables. Every effect a recipe can
have is a field with a name and a description, readable by someone who does not write software.

A shell line is the opposite of everything this file is for: unreadable to the person it is written for,
unauditable in a pull request, and unbounded in what it can do inside a build that holds the key we sign
images with. Orders arrive here as pull requests from strangers. A format where a stranger can send us a
command is a format we cannot accept.

If the effect you need is not a field here, that is a conversation, not a command.

### It cannot ask for less testing

No `skip_checks`, no `force`, no `publish_without_test`, no `unsigned`. An unsigned or untested image can
never reach a customer, and the strongest way to write that rule is a file that cannot express the
request. Tests may only be added.

### It cannot prune the update path

The list of removable things does not contain the update agent, the rollback machinery, the signature
policy, networking or the init system. They have **no names here**, so the sentence that would brick a
fleet cannot be written. `PROTECTED.md`, next to this file, explains why that specific list and not
another.

### It cannot remove accessibility tools

A screen reader, a magnifier, an on-screen keyboard and high-contrast themes stay in every image, in
every policy mode. Asking for them by name gets a printed refusal and a sentence, not silence: we do not
sell an image a disabled pupil cannot use. A silent filter teaches nothing; a named refusal teaches the
rule.

### It cannot carry a secret

No password, no network key, no token. This repository is public by design — it is how you keep your
exact operating system if we vanish — so anything written here is published to the world. See §4: this
is a real gap and we are not dressing it up.

### It cannot make a general claim

There is no field for a compatibility percentage, a savings figure, a device count or a testimonial. The
website renders what is in these files, so a claim that cannot be written here cannot appear there. What
you can write is evidence: a named program, the day someone ran it, and one of four results.

### And any key it does not recognise is a rejection

`additionalProperties: false` is set on **every object in the schema**, not just the top one. A
misspelled `also_remvoe:` is an error, not a silently ignored line. This matters more here than in most
formats: a subtraction instruction that is quietly dropped means the prune list shrinks and the build
still passes, which is the worst possible failure in a product whose whole thesis is subtraction.

---

## 4. Three things that are honestly not here yet

Written down rather than discovered later.

**No network or printer configuration.** Your laptops need one wireless network and one printer to be
usable on day one, and this file cannot say which, because it cannot carry the credential and this
repository is public. The intended answer is a sealed enrolment bundle handed over separately and
referenced by `approved_by.enrolment` — designed, not built. Until then someone sets the wireless network
by hand on each machine, which is honest and is not good enough.

**No staged rollout.** There is no way to say "these five staff-room laptops take the new image first and
the other 175 follow next week". That is not a version pin — every machine takes the same image, just not
in the same hour — and it is a real requirement for a school in week three of term. It is deliberately
absent rather than present-and-ignored, because a field the machine does not honour is a lie in a file
whose whole claim is that it is the machine. It arrives with the fleet console.

**One recipe describes one uniform fleet.** A computer lab and a set of classroom carts that genuinely
need different software are, today, two recipes. We have not decided whether that stays the answer.

---

## 5. What `kiosk` actually removes — read this before you quote it

`policy: kiosk` removes the **desktop shell and the display manager** — the things a person at the
machine could reach a desktop through. A check on every build asserts that no shell and no display
manager binary exists in the image, and that is a statement about the filesystem, so it is proven rather
than configured.

It does **not** mean everything else is gone. Shared libraries that the dependency untangling will not
release stay in the image, and our kiosk image is therefore meaningfully larger than a purpose-built
minimal one would be. We trade that size for the property that a security fix is still one rebuild for
every fleet we have, including this one.

The build reports the **real measured size**, never a smaller number we did not achieve. If your file or
your sales conversation says "the whole desktop is gone", that sentence is wrong and it is wrong in the
one artifact we advertise as the truth.

**The kiosk allow-list is not a security boundary.** It bounds which hostnames the window may reach. It
does not bound what a person can do once they are on one of them: a large third-party site brings
outbound links, embedded frames and viewers with it. Do not sell "locked to four sites" as containment.

---

## 6. Check your file before you send it

```
python3 -m pip install jsonschema pyyaml
python3 schema/validate.py customers/<your-fleet>/recipe.yaml
```

Every refusal this README promises is also written down as a test, so a rule cannot quietly stop
holding:

```
python3 schema/refusals.test.py
```

The same validator runs on every pull request, from the same pinned version, against the same schema
file in this repository. There is no additional private program that knows extra rules. That is what
makes the promise in §1 — rebuild your own operating system without us — something you can test rather
than something we assert.

Some rules cannot be expressed in a schema and live in the validator: your `name` matching its folder and
being unique, your models joining to `hardware/compat.tsv`, your application names existing in the
catalogue inside the base image, and whether the fonts for your language cover your first-boot message.
Four more were added after an audit found the gaps they close:

- **Your recipe folder holds four kinds of file and nothing else**: `recipe.yaml`, the `Containerfile`
  generated from it, `removal-floor.lock`, and the logo your recipe names. A stray `base.lock` beside a
  recipe used to pin that fleet to a base image of the author's choosing and then tell the propagation
  job the fleet was already up to date, so it stopped getting security rebuilds. The digest a build is
  pinned to now comes only from CI, and the lockfile CI writes lives in `.locks/`, which a pull request
  may not touch.
- **Every character of your first-boot message has to be drawable.** Each character must be punctuation
  every font carries, or belong to a script one of your languages brings fonts for. That includes emoji.
  A character the validator has no name for is refused by its code point, not ignored. The first version
  of this rule knew eleven scripts and let everything else through, including Chinese, Korean, Japanese,
  Armenian, Georgian and Khmer. The rule is in `src/scripts.ts`.
- **`other_languages` may not repeat your primary `language`.**
- **`schema:` must be written as the plain number `1`.** `1.0`, `0x1` and `+1` all load as 1, so the
  schema file alone cannot tell them apart. Both validators check how the field is written.

One rule is about **history rather than about your file**, so neither validator can see it. It runs on
every pull request as `scripts/floor-ratchet.mjs`. `prune.must_remove_at_least` may rise freely. It may
fall only if `ALLOW_LOWER_TO` and a `REASON=` line were already on the main branch before your pull
request, meaning they were merged on their own, earlier. A pull request that lowers the floor and grants
itself permission in the same diff is refused. This is a separation of steps, not a second person.
Nothing in code can require a second person.

These are listed here so you know the boundary, and the validator is in this repository so you can read
them.

---

## 7. If you are changing this schema

- Every property needs a `description` written for a person, not a parser. If you cannot explain a field
  to a school IT coordinator in two sentences, the field is wrong, not the coordinator.
- `additionalProperties: false` on every object that declares a shape, always. A new one without it is
  a hole. The `if` blocks of cross-field rules are the exception and must NOT have it: an `if` is a
  question asked about a document, not a declaration of what a document may contain, and closing it
  would stop the rule ever matching. Those blocks carry their sentence on the rule instead.
- Adding a refusal is cheap. Removing one needs an entry in `DECISIONS.md` naming who decided and why.
- Before you add a field, ask what would make it go red. A field nothing checks is decoration, and
  decoration in this file is worse than absence, because the next reader will believe it.
