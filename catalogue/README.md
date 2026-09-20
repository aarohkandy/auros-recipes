# `catalogue/` — the data the compiler joins a recipe to

A recipe is written in human names: `Google Chrome`, `Marathi`, `printing`. Something has to say
which package or Flatpak that is. These four files are that something, and they are data, not code,
so a change to them is a diff a person can read.

| File | Answers |
|---|---|
| `apps.tsv` | What is `Google Chrome`? Which removable group does it belong to? Does it put a terminal or a software installer on the machine? |
| `groups.tsv` | What is inside `media players`? |
| `languages.tsv` | What locale is `Marathi`, what script does it write in, and which font packages draw it? |
| `keyboards.tsv` | What xkb layout is `English (India)`, and what key combination is `Alt + Shift`? |
| `protected.tsv` | What may never be removed, and the sentence explaining why. |

## The honest situation about where this lives

`schema/README.md` §6 says application names are checked against "the catalogue inside the base
image". That is where this belongs: the base image knows what it actually contains, and a catalogue
that disagrees with the image is a catalogue that will one day approve an application that is not
there.

The base image does not carry one yet. So the catalogue is here, in the repository, and there are two
consequences worth stating rather than discovering:

1. **A name that passes validation can still fail the build.** If `apps.tsv` names a package upstream
   has renamed, the build fails at `dnf install`, which is late but is not silent, and is the
   behaviour we want over the alternative of installing something else.
2. **When the base grows a catalogue, this directory is generated from it, not maintained beside
   it.** Two hand-maintained lists of the same thing drift, and the drift is invisible until a
   customer's laptop is missing an application their file says they have.

`protected.tsv` has the same relationship with `schema/PROTECTED.md` — that document is the
authority, this file is its machine-readable rendering, and `test/prune.test.ts` fails if a member of
the set named there is missing here.

## Format

Tab-separated. `#` begins a comment line. Blank lines ignored. A `-` in a column means "none".
Every file has a header row naming its columns.
