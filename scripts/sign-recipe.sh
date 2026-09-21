#!/usr/bin/env bash
# Sign a published recipe image with the key the image itself trusts. Called by build-recipe.yml.
#
#   scripts/sign-recipe.sh preflight   BEFORE the push: refuse a development-key image, a missing key,
#                                      or a private key that does not match the public key the image
#                                      carries. Nothing reaches the registry if any of these fail.
#   scripts/sign-recipe.sh sign        AFTER the push: sign IMAGE@DIGEST, then assert it verifies
#                                      against the image's own public key AND that the legacy .sig tag
#                                      is discoverable (the half that represents a customer's laptop).
#
# WHY THIS EXISTS. A recipe image is FROM auros-base, so it inherits signing/policy.json: a
# sigstoreSigned rule over the whole ghcr.io/<org> namespace, keyPath /usr/lib/pki/containers/auros.pub.
# This workflow used to push recipe images unsigned into that namespace, so every machine would have
# refused every recipe update forever, silently (docs/SYSTEM-REVIEW.md §2.1). Every step below is
# copied from auros-base/.github/workflows/build.yml — the sign job, S8, and the publish job's
# key-kind refusal — rather than reinvented.
#
# Environment:
#   CANDIDATE           local image ref that was tested (the key kind and public key are read off it)
#   IMAGE, DIGEST       what was pushed (sign only)
#   COSIGN_PRIVATE_KEY  secret; COSIGN_PASSWORD is read by cosign itself
#   BUNDLE_FLAG         COSIGN_BUNDLE_FORMAT_FLAG from auros-base/signing/cosign.lock (may be empty)
#   PUBKEY_IN_IMAGE     COSIGN_PUBKEY_IN_IMAGE from the same lock
#   SIGN_WORK           scratch directory shared by both phases (default $RUNNER_TEMP/auros-sign)
set -euo pipefail

WORK="${SIGN_WORK:-${RUNNER_TEMP:-/tmp}/auros-sign}"
mkdir -p "$WORK"
: "${CANDIDATE:?}" "${PUBKEY_IN_IMAGE:?auros-base/signing/cosign.lock has no COSIGN_PUBKEY_IN_IMAGE}"

write_key() {
  if [ -z "${COSIGN_PRIVATE_KEY:-}" ]; then
    echo "::error::COSIGN_PRIVATE_KEY is not set in this repository (aarohkandy/auros-recipes). A recipe image must be signed with the SAME key as auros-base, because it inherits the base's policy.json and public key. Set COSIGN_PRIVATE_KEY and COSIGN_PASSWORD here exactly as auros-base/signing/keys/README.md describes for auros-base. That is a human action (BLOCKED.md B10); nothing publishes until it exists."
    exit 1
  fi
  printf '%s' "$COSIGN_PRIVATE_KEY" > "$WORK/auros.key"
  chmod 600 "$WORK/auros.key"
}
drop_key() { shred -u "$WORK/auros.key" 2>/dev/null || rm -f "$WORK/auros.key"; }

preflight() {
  # auros-base build.yml, "A development-key image may never reach a customer-facing tag". The kind is
  # read back OUT OF THE BUILT IMAGE (inherited from the base, written by build/30-update-agent.sh),
  # not from a workflow variable, because a file inside the artifact travels with the thing judged.
  KIND=$(sudo podman run --rm --entrypoint= "$CANDIDATE" cat /usr/lib/auros/signing-key-kind 2>/dev/null | tr -d '[:space:]' || true)
  case "$KIND" in
    production) echo "signing key kind: production — publish permitted" ;;
    development)
      echo "::error::REFUSING TO PUBLISH. This recipe image is built on a base that carries the DEVELOPMENT signing key. It built and passed the check matrix — that is what the development key is for — but its private half is a throwaway nobody is accountable for. Publish a base built with a production key first: auros-base/signing/keys/DEVELOPMENT-KEY.md and signing/RISKS.md R3."
      exit 1 ;;
    "") echo "::error::the image carries no /usr/lib/auros/signing-key-kind. Either its base was not built by auros-base build/30-update-agent.sh, or that step was skipped. An image that cannot say which key signed it is not one to publish."; exit 1 ;;
    *) echo "::error::unrecognised signing key kind '$KIND'. Failing closed."; exit 1 ;;
  esac

  # The public key the image will verify against is the only one that matters, so it comes off the
  # image — not off an auros-base checkout, which may be a newer commit than the base this was built on.
  sudo podman run --rm --entrypoint= "$CANDIDATE" cat "$PUBKEY_IN_IMAGE" > "$WORK/image.pub" 2>/dev/null || true
  [ -s "$WORK/image.pub" ] || { echo "::error::the image carries no ${PUBKEY_IN_IMAGE}. D8: without it the policy refuses every update. Refusing to publish."; exit 1; }

  # auros-base build.yml sign job: prove the private key matches BEFORE signing. The wrong key makes a
  # valid signature every customer machine rejects.
  write_key
  rc=0; cosign public-key --key "$WORK/auros.key" > "$WORK/derived.pub" || rc=$?
  drop_key
  [ "$rc" = 0 ] || { echo "::error::cosign could not read COSIGN_PRIVATE_KEY (wrong COSIGN_PASSWORD?)."; exit 1; }
  if ! diff -q <(tr -d ' \n' < "$WORK/derived.pub") <(tr -d ' \n' < "$WORK/image.pub") >/dev/null; then
    echo "::error::COSIGN_PRIVATE_KEY does not match ${PUBKEY_IN_IMAGE} inside the image. Every image signed with it would be refused by every machine in the field."
    exit 1
  fi
  echo "private key matches the public key the image ships"
}

sign() {
  : "${IMAGE:?}" "${DIGEST:?}"
  [ -s "$WORK/image.pub" ] || { echo "::error::no $WORK/image.pub — run 'preflight' before 'sign'."; exit 1; }
  write_key
  # D17 belt and braces, verbatim from auros-base build.yml.
  FLAG="${BUNDLE_FLAG:-}"
  if [ -n "$FLAG" ] && ! cosign sign --help 2>&1 | grep -q -- "${FLAG%%=*}"; then
    echo "::warning::this cosign has no ${FLAG%%=*} flag; relying on the .sig tag check to prove the signature is still discoverable"
    FLAG=""
  fi
  rc=0; COSIGN_YES=true cosign sign $FLAG --key "$WORK/auros.key" "${IMAGE}@${DIGEST}" || rc=$?
  drop_key
  [ "$rc" = 0 ] || { echo "::error::cosign sign failed for ${IMAGE}@${DIGEST}. The image is published UNSIGNED; every machine will refuse it until a signed build replaces it."; exit 1; }

  # auros-base S8, both halves. cosign verify alone passed straight through the cosign 3.x regression
  # while no consumer could see a signature, so the .sig tag is checked the way bootc will look for it.
  ok=1
  if ! cosign verify --key "$WORK/image.pub" "${IMAGE}@${DIGEST}" > "$WORK/verify.txt" 2>&1; then
    ok=0; echo "::error::cosign verify FAILED for ${IMAGE}@${DIGEST} against the image's own ${PUBKEY_IN_IMAGE}"
    cat "$WORK/verify.txt"
  fi
  SIGTAG="${DIGEST/:/-}.sig"
  if ! skopeo inspect --raw "docker://${IMAGE}:${SIGTAG}" > "$WORK/sigtag.json" 2> "$WORK/sigtag.err"; then
    ok=0; echo "::error::.sig tag ${SIGTAG} NOT discoverable by skopeo — a customer machine cannot verify this image"
    cat "$WORK/sigtag.err"
  fi
  [ "$ok" = 1 ] || exit 1
  echo "signed and verified ${IMAGE}@${DIGEST}; ${SIGTAG} is discoverable"
}

case "${1:-}" in
  preflight) preflight ;;
  sign) sign ;;
  *) echo "usage: $0 preflight|sign" >&2; exit 2 ;;
esac
