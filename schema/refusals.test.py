#!/usr/bin/env python3
"""Every refusal the README claims, written as a test that would go red if it stopped being true.

    python3 schema/refusals.test.py

A rule nobody tests is a rule that quietly stops holding. The list below is the same list the README
section "what this file will refuse to do, and why that's the point" makes promises about; if you add
a promise there, add a case here.
"""
import copy, json, pathlib, sys
import yaml
from jsonschema import Draft202012Validator, FormatChecker

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
V = Draft202012Validator(json.loads((HERE / "recipe.schema.json").read_text()), format_checker=FormatChecker())
school = yaml.safe_load((REPO / "customers/example-school/recipe.yaml").read_text(encoding="utf-8"))
kiosk = yaml.safe_load((REPO / "customers/example-kiosk/recipe.yaml").read_text(encoding="utf-8"))


def m(src, fn):
    d = copy.deepcopy(src)
    fn(d)
    return d


MUST_REFUSE = [
    # the FROM line, in each of its disguises
    ("a FROM override", m(school, lambda d: d.update(**{"from": "ghcr.io/somebody/else:latest"}))),
    ("a different base", m(school, lambda d: d.update(base="docker.io/library/fedora:41"))),
    ("a pinned digest", m(school, lambda d: d.update(digest="sha256:aaaa"))),
    ("a registry", m(school, lambda d: d.update(registry="quay.io"))),
    ("a Containerfile", m(school, lambda d: d.update(containerfile="FROM scratch"))),
    # kernels and drivers
    ("a kernel pin", m(school, lambda d: d.update(kernel="6.1.0-lts"))),
    ("kernel arguments", m(school, lambda d: d.update(kargs=["quiet"]))),
    ("an out-of-tree driver", m(school, lambda d: d.update(dkms=["broadcom-wl"]))),
    # version pins, by field and by shape
    ("a version hold", m(school, lambda d: d.update(hold=["firefox"]))),
    ("an exclude list", m(school, lambda d: d.update(exclude=["kernel"]))),
    ("a pin spelled as an app: firefox-140.0", m(school, lambda d: d["apps"].append("firefox-140.0"))),
    ("a pin spelled as an app: Firefox 140", m(school, lambda d: d["apps"].append("Firefox 140"))),
    ("a pin spelled as an app: kernel>=6.1", m(school, lambda d: d["apps"].append("kernel>=6.1"))),
    ("a pin spelled as an app: foo=1.2", m(school, lambda d: d["apps"].append("foo=1.2"))),
    ("a raw Flatpak ref", m(school, lambda d: d["apps"].append("org.mozilla.firefox"))),
    ("a raw RPM name", m(school, lambda d: d["apps"].append("firefox-1:115-3.fc41.x86_64"))),
    # code, sources, files
    ("a post-install script", m(school, lambda d: d.update(post_install="curl x | sh"))),
    ("a build hook", m(school, lambda d: d.update(hooks={"pre": "x"}))),
    ("an extra package source", m(school, lambda d: d.update(copr=["somebody/thing"]))),
    ("signature checking turned off", m(school, lambda d: d.update(nogpgcheck=True))),
    ("an arbitrary file overlay", m(school, lambda d: d.update(files={"/etc/x": "y"}))),
    # the gates
    ("skipping the checks", m(school, lambda d: d.update(skip_checks=True))),
    ("publishing without a test", m(school, lambda d: d.update(publish_without_test=True))),
    ("shipping unsigned", m(school, lambda d: d.update(unsigned=True))),
    ("switching off rollback", m(school, lambda d: d.update(rollback=False))),
    ("switching off updates", m(school, lambda d: d.update(disable_updates=True))),
    # the protected set
    ("pruning NetworkManager", m(school, lambda d: d["prune"]["also_remove"].append("NetworkManager"))),
    ("pruning systemd", m(school, lambda d: d["prune"]["also_remove"].append("systemd"))),
    ("pruning bootc", m(school, lambda d: d["prune"]["also_remove"].append("bootc"))),
    ("pruning a screen reader", m(school, lambda d: d["prune"]["also_remove"].append("screen reader"))),
    ("pruning an on-screen keyboard", m(school, lambda d: d["prune"]["also_remove"].append("on-screen keyboard"))),
    # subtraction is not optional
    ("no prune block at all", m(school, lambda d: d.pop("prune"))),
    ("a removal floor of zero", m(school, lambda d: d["prune"].update(must_remove_at_least=0))),
    ("keeping the desktop without saying what goes", m(school, lambda d: (d["prune"].update(keep_only_the_apps_above=False), d["prune"].pop("also_remove")))),
    ("a typo in a subtraction key", m(school, lambda d: d["prune"].update(also_remvoe=["games"]))),
    # secrets in a public repo
    ("a wireless password", m(school, lambda d: d.update(wifi_password="hunter2"))),
    ("an API token", m(school, lambda d: d.update(token="abc"))),
    # honesty
    ("a blanket compatibility claim", m(school, lambda d: d.update(compatibility="most apps work"))),
    ("a testimonial", m(school, lambda d: d.update(testimonial="best OS ever"))),
    ("'works' with no caveats written down", m(school, lambda d: d["windows_apps"]["tested"][0].pop("note"))),
    ("compat claims while the layer is off", m(school, lambda d: d["windows_apps"].update(enabled=False))),
    ("an empty 'for' paragraph", m(school, lambda d: d.update(**{"for": "a small school"}))),
    ("no size budget", m(school, lambda d: d.pop("size_budget_gb"))),
    # things that would strand a fleet
    ("a non-Latin primary keyboard", m(school, lambda d: d.update(keyboard="Marathi (InScript)"))),
    ("a second script with no way to reach it", m(school, lambda d: d.pop("switch_scripts_with"))),
    ("a timezone as an offset", m(school, lambda d: d.update(timezone="UTC+05:30"))),
    ("a timezone read from the surroundings", m(school, lambda d: d.update(timezone="auto"))),
    ("a locale code instead of a language", m(school, lambda d: d.update(language="mr_IN.UTF-8"))),
    # assets and text reaching the image
    ("a logo fetched from the internet", m(school, lambda d: d["organisation"].update(logo="https://x.example/l.png"))),
    ("a logo reached by path traversal", m(school, lambda d: d["organisation"].update(logo="../../etc/l.png"))),
    ("a direction override hidden in a name", m(school, lambda d: d["organisation"].update(display_name="Example‮Vidyalaya"))),
    ("a control character in the welcome text", m(school, lambda d: d.update(first_boot_message="Hi\x00there"))),
    # tests may only be added
    ("skipping a test machine", m(school, lambda d: d["hardware"].update(also_skip=["bios-legacy"]))),
    # policy modes mean what they say
    ("a terminal on a managed fleet", m(school, lambda d: d.update(desktop={"can_reach_a_terminal": True}))),
    ("a locked fleet that can install apps", m(school, lambda d: (d.update(policy="locked"), d.update(desktop={"can_install_apps": True})))),
    ("a kiosk with a desktop block", m(kiosk, lambda d: d.update(desktop={"taskbar_and_start_menu": True}))),
    ("a kiosk running Windows programs", m(kiosk, lambda d: d.update(windows_apps={"enabled": True, "we_promise_nothing_else": True}))),
    ("a kiosk keeping a full desktop", m(kiosk, lambda d: d["prune"].update(keep_only_the_apps_above=False, also_remove=["games"]))),
    ("a kiosk block on a desktop fleet", m(school, lambda d: d.update(kiosk={"opens": "https://a.example.org/", "allowed_sites": ["a.example.org"], "forget_session_after_minutes": 5}))),
    ("a kiosk served over plain http", m(kiosk, lambda d: d["kiosk"].update(opens="http://start.example.org/kiosk"))),
    ("a kiosk opening a local file", m(kiosk, lambda d: d["kiosk"].update(opens="file:///usr/share/index.html"))),
    ("a kiosk allowed to reach nothing", m(kiosk, lambda d: d["kiosk"].update(allowed_sites=[]))),
    # the closed world itself
    ("an unknown schema version", m(school, lambda d: d.update(schema=2))),
    ("any key the schema does not know", m(school, lambda d: d.update(notes="anything at all"))),
    ("a name that could be read as an image tag", m(school, lambda d: d.update(name="example-school:v2"))),
]

MUST_ACCEPT = sorted((REPO / "customers").glob("*/recipe.yaml"))


def main():
    failures = []
    for label, doc in MUST_REFUSE:
        if not list(V.iter_errors(doc)):
            failures.append(f"ACCEPTED but must refuse: {label}")
    for path in MUST_ACCEPT:
        errs = list(V.iter_errors(yaml.safe_load(path.read_text(encoding="utf-8"))))
        if errs:
            failures.append(f"REFUSED but must accept: {path.name} — {errs[0].message[:120]}")

    print(f"{len(MUST_REFUSE)} refusals asserted, {len(MUST_ACCEPT)} recipes asserted valid")
    for f in failures:
        print("  " + f)
    print("OK" if not failures else f"{len(failures)} FAILURES")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
