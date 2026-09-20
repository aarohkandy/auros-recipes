# The protected set — what a recipe may never remove

Subtraction is the product. A machine with eleven applications instead of three hundred is the whole
value proposition, and the prune list is the first-class part of the recipe, not an afterthought.

This document is about the handful of things that are not on the table, and why refusing to delete them
is the same decision as deleting everything else.

## The set

| Kept, always | What it is, in one line |
|---|---|
| **bootc** | The thing that swaps one whole operating system for the next one on restart. |
| **The update timer** | The thing that notices there is a next one. |
| **greenboot** | The thing that checks the machine reached a login screen after an update, and puts the old one back if it did not. |
| **The signature policy** | The public key, the registry configuration, and the rule that says an image that is not signed by us does not get installed. |
| **NetworkManager** | The thing that reaches the network. |
| **systemd** | The thing that starts everything above. |

Also permanently kept, for a different reason: **the kernel and its modules** (a recipe cannot name them
at all — they belong to the base), and **accessibility tools** — screen reader, magnifier, on-screen
keyboard, high-contrast themes. Asking to remove an accessibility tool is refused by name with a printed
sentence, not filtered out quietly. We do not sell an image a disabled pupil cannot use, and a silent
filter would teach nobody that rule.

## Why these six and not some longer list

Every one of them is on the path by which a machine receives its next repair.

Read the list again in order and it is a single sentence: *reach the network, notice a new image, install
it, verify we signed it, prove it boots, put the old one back if it does not.* Cut any link and the
chain does not degrade — it stops.

A laptop that cannot update is not a laptop with one fewer feature. It is a laptop frozen at the security
state of the day it was imaged, getting worse every week, with nobody able to fix it remotely and nobody
standing next to it. That is the orphaned 2014 Windows machine sitting in the school store cupboard. It
is the exact object we exist to replace.

**So a recipe that prunes its own update path converts the customer into an abandoned machine — which is
the thing we sell against.** Not a degraded customer. The specific bad outcome the entire company is an
argument against, delivered by us, on purpose, in a file the customer signed off.

The damage is also not recoverable at a distance. The fleet we are built for is a nonprofit or a school
with 25 to 200 machines and one overworked IT person. There is no out-of-band console, no remote
management card, nobody who can be walked through a recovery. Everything that fixes a broken fleet
arrives through the update path. Break it and the only repair is a person physically visiting a hundred
and eighty laptops with a USB stick.

And it is silent. A fleet that has stopped updating looks exactly like a fleet that is up to date. It
boots, it logs in, the browser works. Nothing on screen says anything is wrong. The difference shows up
months later as a compromised machine on a school network, and by then nobody connects it to a line
someone deleted from a YAML file in March.

## How it is enforced — three layers, because one is not enough

**1. You cannot say it.** `prune.also_remove` accepts values from a published list, and none of these
things is on it. There is no free-text field anywhere in a recipe that takes a package name. A recipe
asking to remove the update agent is not a request we deny — it is not a sentence the format can express.
This is the layer that matters most, because it protects against the ordinary case: somebody clearing
space in good faith who has no idea what they just typed.

**2. The compiler will not do it.** Even when nothing asked for them, these packages are excluded from
every removal closure, including the transitive one. That closure has historically tried to take out the
init system and the package manager on its own; it is not a well-behaved function and it does not get the
final word.

**3. The build checks the finished image.** A check on every build asserts that bootc, the update timer,
greenboot, the signature policy, NetworkManager and systemd are all present and enabled in the image that
is about to be published. It runs against the built artifact, not against the recipe, so it holds even if
somebody bypasses validation entirely. A build that fails it does not publish, and there is no flag that
overrides that.

Three layers because the first two depend on lists a human maintains, and a human maintaining a list is
the failure mode we are actually guarding against. The third layer does not care how the mistake got in.

## It is protected, not hidden

Every build writes `REMOVED.md` next to the recipe. It carries a section headed:

> **Kept although nothing asked for them, because the machine cannot start, update or roll back without
> these** — bootc, the update timer, greenboot, the signature policy, NetworkManager, systemd.

This is not decoration. The safety above comes from absence — from names that cannot be typed — and
absence is invisible, so nobody notices when the list of protected things drifts, or when somebody
editing the base quietly marks one of them removable. Printing the set on every build is what makes the
guarantee something a reviewer can see rather than something a reviewer has to trust.

It also answers the question the IT person actually has at nine on a Monday: *something is missing from
these laptops — did we remove it?* The report tells them what went, why it went, and what stayed no
matter what they asked for.

## If you need one of these gone

You do not, and that is not us being unhelpful — it is the honest answer.

The requests that arrive in this shape are usually something else underneath: a fleet that must not
update during exam fortnight (a timing question, and a real gap — see README §4), a machine on an
isolated network (which needs a different answer, not a broken one), or an image that is too large
(which is what `must_remove_at_least` and `size_budget_gb` are for, and there is a great deal of room
above this list).

If it is genuinely none of those, it is a conversation with a person. It may be a customer we decline.
It is never an edit to a recipe.

## For whoever maintains the removable list in the base image

The whole first layer rests on one hand-curated file: the list of things the base declares removable. A
single mistake there — marking the update agent or NetworkManager removable — is a fleet-wide brick that
every recipe would then be permitted to ask for.

That file therefore needs its own review bar, its own owner, and a check that fails if any member of the
protected set ever appears in it. Treat a change to it the way you would treat a change to the signing
key, not the way you would treat a change to a recipe.
