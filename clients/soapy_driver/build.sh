#!/usr/bin/env bash
# build.sh — package the SoapySDR driver source and publish it to the release.
#
# Unlike the other clients, what ships here is *source*. SoapySDR loads a module
# built against the exact SoapySDR ABI on the machine that will run it, so a
# binary built here would refuse to load almost everywhere else — the driver is
# therefore distributed as a zip the user unpacks and builds with cmake, exactly
# as README.md describes.
#
# That changes what "verified" has to mean. For a binary client the build itself
# is the check: it either compiled or it did not. Here the build happens on
# somebody else's machine, weeks later, and a zip of source that does not
# compile is indistinguishable from a good one until they try it. So this script
# compiles the driver before packaging it and refuses to publish a zip whose
# contents it could not build — the same rule as the `.gatekeeper-ok` marker in
# clients/tui/build.sh, for the same reason: only a verified artefact is
# published.
#
# Requirements, all of which CMakeLists.txt also checks:
#   sudo apt install cmake libsoapysdr-dev libwebsocketpp-dev libboost-system-dev \
#                    libssl-dev libcurl4-openssl-dev libzstd-dev
#
# Usage:
#   ./build.sh             package the source into soapy_driver.zip
#   ./build.sh --publish   ...then upload it to the `latest` release, replacing
#                          what is there. Asks first.
#   ./build.sh --yes       answer the publish prompt in advance, for a run with
#                          nobody at the terminal. Only meaningful with --publish.
#   ./build.sh --no-verify skip the compile check. For packaging a tree that
#                          cannot be built here — never with --publish, which
#                          refuses an unverified zip.
#   ./build.sh --test      run test/run.sh before packaging, as well.

set -euo pipefail

cd "$(dirname "$0")"

# The publish confirmation, given in advance — see publish_release.
ASSUME_YES=0
PUBLISH=0
VERIFY=1
RUN_TESTS=0

# The release the zip hangs off and every download link fetches from. The asset
# name is the filename built below, because the links point straight at it, so
# publishing replaces the asset rather than adding a new one. Same tag, repo and
# override variables as the other clients' build scripts: one release holds them
# all.
REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"

ZIP="soapy_driver.zip"

# What goes in the zip, named rather than swept up.
#
# `zip -r .` would be shorter and wrong: it would sweep in test/ (a developer
# harness that needs this repo's fixture server and is no use to somebody
# building the driver), any build/ directory left lying around, and the previous
# soapy_driver.zip itself — which is how an archive ends up containing a copy of
# its own last release. An explicit list also means a new file is a deliberate
# addition to the download rather than something that arrived because it
# happened to be in the directory.
#
# .gitignore is deliberately *not* here, though every zip before this one had
# it. It was never chosen: the April asset was made when this directory held
# exactly four files, and `zip -r` sweeps dotfiles, so it rode along. It does
# nothing for the documented unzip-and-cmake path — the build/ and *.o it
# ignores only matter to someone who runs git init in the unpacked directory.
CONTENTS=(
  CMakeLists.txt
  README.md
  SoapyUberSDR.cpp
)

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    --yes) ASSUME_YES=1 ;;
    --no-verify) VERIFY=0 ;;
    --test) RUN_TESTS=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) echo "unexpected argument: $arg" >&2; exit 2 ;;
  esac
done

# An unverified zip may be packaged, but never published — so say so now, before
# a compile the caller asked to skip is followed by an upload that will refuse
# it anyway.
if [[ "$PUBLISH" -eq 1 && "$VERIFY" -eq 0 ]]; then
  echo "--no-verify cannot be combined with --publish: what is published is the" >&2
  echo "zip this script compiled, and --no-verify is the one that did not." >&2
  exit 2
fi

# Compiles the exact files that are about to be packaged.
#
# In a scratch directory built from a *copy* of CONTENTS rather than from the
# working tree, so what is compiled is what the person who downloads the zip
# gets: a stale header sitting in this directory but missing from CONTENTS would
# compile fine in place and fail for them, which is precisely the failure this
# check exists to catch.
verify_build() {
  local work
  work="$(mktemp -d)"
  # shellcheck disable=SC2064  # $work is expanded now, deliberately.
  trap "rm -rf '$work'" RETURN

  mkdir -p "$work/src"
  cp -- "${CONTENTS[@]}" "$work/src/"

  echo -ne "${YELLOW}  compiling${NC} … "
  if ! cmake -S "$work/src" -B "$work/build" >"$work/log" 2>&1 \
     || ! cmake --build "$work/build" >>"$work/log" 2>&1; then
    echo "failed"
    echo
    sed 's/^/      /' "$work/log" | tail -30 >&2
    echo
    echo "  Not packaged: the source in $ZIP would not build." >&2
    return 1
  fi

  # The module's own name is the contract with SoapySDR — CMakeLists.txt installs
  # lib/SoapySDR/modules<abi>/libuberSDRSupport.so and SoapySDR loads it by that
  # path — so check the thing was actually produced rather than trusting a build
  # that exited 0 having made nothing.
  if [[ ! -f "$work/build/libuberSDRSupport.so" ]]; then
    echo "failed"
    echo "  Not packaged: the build produced no libuberSDRSupport.so." >&2
    return 1
  fi

  echo "ok"
}

# Uploads the zip to the rolling release, replacing what is there.
#
# Everything that could stop it is checked and reported rather than left to gh's
# own error: "gh: command not found" scrolling past is a release that quietly
# did not happen.
publish_release() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "not published: gh not found — install the GitHub CLI, or upload $ZIP by hand." >&2
    return
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "not published: gh is not logged in — run 'gh auth login'." >&2
    return
  fi
  if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "not published: there is no '$TAG' release on $REPO to upload to." >&2
    echo "  create it once with: gh release create $TAG --repo $REPO --title latest --notes ''" >&2
    return
  fi

  echo "  Upload to https://github.com/$REPO/releases/tag/$TAG, replacing what is there:"
  echo "      $ZIP   $(du -h "$ZIP" | cut -f1)"
  echo

  # Asked for, one way or the other.
  #
  # The prompt is the default and stays that way: publishing replaces what every
  # download link serves, and a run that reaches this point by accident must not
  # be able to complete it. `--yes` changes only *when* the answer was given — on
  # the command line rather than at the prompt, which is the same person saying
  # the same thing and is what makes an unattended release possible.
  #
  # A flag rather than an environment variable on purpose: an exported variable
  # is inherited by everything a shell starts, so a `yes` meant for one release
  # would sit there quietly authorising the next.
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    echo "  --yes given; uploading."
  elif [[ ! -t 0 ]]; then
    echo "not published: --publish asks before uploading and there is no terminal to ask on." >&2
    echo "  Pass --yes to answer it in advance." >&2
    return
  else
    local reply=''
    read -r -p "  type 'yes' to upload: " reply || true
    if [[ "$reply" != "yes" ]]; then
      echo "  not published."
      return
    fi
  fi

  # --clobber because the asset name is a constant: without it the second release
  # is refused, the name already being taken.
  if gh release upload "$TAG" "$ZIP" --clobber --repo "$REPO"; then
    echo "  uploaded to https://github.com/$REPO/releases/tag/$TAG"
  else
    echo "not published: the upload failed — $ZIP is intact, try again." >&2
  fi
}

echo -e "${GREEN}Packaging SoapyUberSDR${NC}"

# Missing before packaging rather than absent from the download: zip is happy to
# make an archive out of whatever of the list exists, so a renamed or deleted
# file would otherwise ship as a zip that is simply missing it.
missing=()
for file in "${CONTENTS[@]}"; do
  [[ -f "$file" ]] || missing+=("$file")
done
if [[ "${#missing[@]}" -gt 0 ]]; then
  echo "  not packaged: these are in CONTENTS but not in this directory:" >&2
  for file in "${missing[@]}"; do echo "      $file" >&2; done
  exit 1
fi

if [[ "$RUN_TESTS" -eq 1 ]]; then
  echo -e "${YELLOW}  tests${NC} …"
  ./test/run.sh || { echo "  not packaged: the tests failed." >&2; exit 1; }
  echo
fi

if [[ "$VERIFY" -eq 1 ]]; then
  verify_build || exit 1
else
  echo "  compile check skipped (--no-verify); this zip may not be published."
fi

# Rebuilt from nothing rather than added to. zip updates an existing archive in
# place, so without this a file dropped from CONTENTS would stay in the zip
# forever, invisibly, because nothing ever removes it.
rm -f "$ZIP"

# Plain, keeping the extended timestamp field, so each entry carries the real
# UTC mtime of the file it came from and unzip can render it correctly anywhere.
#
# Do not expect the listing to match the asset this replaces entry for entry.
# That zip was written elsewhere — Info-ZIP 6.3 against 3.0 here — on a host an
# hour ahead, and its stamps disagree with the working tree's by a second as
# well as by an hour. The mtimes are cosmetic; the four names, their order and
# their contents are what has to match, and those do.
zip -q "$ZIP" "${CONTENTS[@]}"

echo -e "${GREEN}  $ZIP${NC}   $(du -h "$ZIP" | cut -f1)"
unzip -l "$ZIP" | sed -n '4,$p' | sed 's/^/    /'

if [[ "$PUBLISH" -eq 1 ]]; then
  echo
  publish_release
fi
