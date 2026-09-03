#!/usr/bin/env bash
# build.sh — build ubersdr-hpsdr-bridge for amd64 and arm64, and publish them.
#
# This one is C, and it links libwebsockets, uuid and bsd — so unlike the
# pure-Go clients it cannot simply be told to emit another architecture. It needs
# the target's headers and shared libraries, which means a target-architecture
# root filesystem.
#
# Docker is that root filesystem, the same way the rest of this repo cross-builds
# (docker.sh builds the server image --platform linux/amd64,linux/arm64). Both
# architectures build in ubuntu:24.04 containers here rather than one of them on
# the host, for two reasons:
#
#   * The result stops depending on whichever libraries this particular machine
#     happens to have. The host's libwebsockets is an Ubuntu Pro ESM build
#     (4.3.3-1.1ubuntu0.1~esm1); a plain 24.04 container has the ordinary one.
#     Same soname, same ABI, but only one of the two is reproducible by anybody
#     who does not have that subscription.
#   * The two binaries then match each other, having been built from the same
#     image against the same library versions — which is what the pair of them
#     being one release implies.
#
# ubuntu:24.04 specifically, and it is a compatibility decision rather than a
# default. A dynamically linked binary demands the glibc it was built against or
# newer, and links a library by soname, so the base image chooses which machines
# the download runs on:
#
#     ubuntu:24.04   glibc 2.39, libwebsockets.so.19   ← what the release has always been
#     debian:12      glibc 2.36, libwebsockets.so.19
#     ubuntu:22.04   glibc 2.35, libwebsockets.so.16   ← different soname, would not load
#
# The published binaries require GLIBC_2.38 and libwebsockets.so.19, so 24.04 is
# what they were built on and moving off it would silently change who can run
# them. Going *older* would widen that audience — a debian:12 build runs on a
# Raspberry Pi OS bookworm that a 24.04 build refuses — and is worth considering
# on purpose one day, but it is not a change to make by editing a default.
#
# arm64 runs under qemu, registered with binfmt_misc. The registration does not
# survive a reboot, so --check reports it and the build offers to install it.
#
# Usage:
#   ./build.sh                 both architectures into build/
#   ./build.sh amd64           just the one — amd64 or arm64
#   ./build.sh --check         report whether this machine can build both, and stop
#   ./build.sh --publish       ...then upload what this run built to the `latest`
#                              release, replacing what is there. Asks first.
#   ./build.sh --yes           answer the publish prompt in advance, for a run
#                              with nobody at the terminal.

set -euo pipefail

cd "$(dirname "$0")"

ASSUME_YES=0
PUBLISH=0
CHECK_ONLY=0

# Same tag, repo and override variables as the other clients' build scripts: one
# release holds them all. The asset names are the filenames built below, because
# the download links point straight at them, so publishing replaces an asset
# rather than adding one.
REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"

# The build environment, and with it the glibc and libwebsockets the binaries
# demand of the machines that run them. See the header before changing it.
IMAGE="${UBERSDR_BUILD_IMAGE:-ubuntu:24.04}"

OUT="build"
BINARY="ubersdr-hpsdr-bridge"

# What the Makefile needs, copied into the container. Named rather than mounting
# the directory writable, so a container-built .o never lands in the working tree
# — an aarch64 ka9q_hpsdr.o left behind here would be picked up by the next
# native `make` and fail the link in a thoroughly confusing way.
SOURCES=(ka9q_hpsdr.c ka9q_hpsdr.h pcm_v4.c pcm_v4.h hpsdr_p1.c hpsdr_p1.h Makefile)

# platform:docker-platform
TARGETS=(
  "amd64:linux/amd64"
  "arm64:linux/arm64"
)

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

WANTED=()
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    --yes) ASSUME_YES=1 ;;
    --check) CHECK_ONLY=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) WANTED+=("$arg") ;;
  esac
done

if [ ${#WANTED[@]} -gt 0 ]; then
  SELECTED=()
  for want in "${WANTED[@]}"; do
    for target in "${TARGETS[@]}"; do
      [ "${target%%:*}" = "$want" ] && SELECTED+=("$target")
    done
  done
  if [ ${#SELECTED[@]} -eq 0 ]; then
    echo "No target matched: ${WANTED[*]}" >&2
    echo "Available: $(printf '%s ' "${TARGETS[@]%%:*}")" >&2
    exit 1
  fi
  TARGETS=("${SELECTED[@]}")
fi

# True when this machine can actually execute the given docker platform.
#
# Asked by running something, rather than by reading the binfmt_misc directory:
# a handler can be registered and still not work — the qemu binary it points at
# can be missing, and `F` (fix-binary) registrations behave differently inside
# containers. The only answer worth having is whether a foreign binary runs.
can_run_platform() {
  docker run --rm --platform "$1" "$IMAGE" true >/dev/null 2>&1
}

# Registers the qemu handlers, which is what makes an arm64 container runnable on
# an amd64 host.
#
# --privileged is unavoidable: writing to /proc/sys/fs/binfmt_misc is a host-wide
# change and the kernel does not offer a smaller permission for it. It is also
# why this is offered rather than done silently. The registration is not
# persistent — it is gone after a reboot, and this is how it comes back.
install_binfmt() {
  echo -e "${YELLOW}  registering qemu handlers (docker run --privileged tonistiigi/binfmt)${NC}"
  docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null 2>&1
}

# Everything needed to build, reported together rather than one failure at a time.
preflight() {
  local ok=0
  echo -e "${GREEN}  Build environment${NC}"

  if ! command -v docker >/dev/null 2>&1; then
    echo -e "    docker         ${RED}not found${NC} — install it; every architecture builds in a container."
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo -e "    docker         ${RED}not usable${NC} — the daemon is not running, or this user cannot reach it."
    return 1
  fi
  echo    "    docker         ok"
  echo    "    image          $IMAGE"

  local target name platform
  for target in "${TARGETS[@]}"; do
    name="${target%%:*}"
    platform="${target#*:}"
    if can_run_platform "$platform"; then
      echo    "    $name          can run $platform"
    else
      # amd64 failing is a different problem from arm64 failing, and only one of
      # them has an answer worth printing.
      if [ "$platform" = "linux/amd64" ]; then
        echo -e "    $name          ${RED}cannot run $platform${NC} — that is this machine's own architecture; something is wrong with docker."
      else
        echo -e "    $name          ${YELLOW}cannot run $platform${NC} — qemu is not registered (it does not survive a reboot)."
      fi
      ok=1
    fi
  done

  return $ok
}

# Uploads what this run built to the rolling release, replacing what is there.
#
# What this run built, and not simply what is in build/: a partial build leaves
# the other binary there from whenever it was last made, and publishing that
# would put a stale binary on the release under a name that says nothing about
# its age. So `./build.sh amd64 --publish` uploads one file.
publish_release() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "not published: gh not found — install the GitHub CLI, or upload $OUT/ by hand." >&2
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

  local uploads=() target name asset
  for target in "${TARGETS[@]}"; do
    name="${target%%:*}"
    asset="$OUT/${BINARY}_$name"
    [ -f "$asset" ] && uploads+=("$asset")
  done

  if [ ${#uploads[@]} -eq 0 ]; then
    echo "not published: this run produced nothing to upload." >&2
    return
  fi

  echo "  Upload to https://github.com/$REPO/releases/tag/$TAG, replacing what is there:"
  for asset in "${uploads[@]}"; do
    echo "      $(basename "$asset")   $(du -h --apparent-size "$asset" | cut -f1)"
  done
  echo

  # Asked for, one way or the other.
  #
  # The prompt is the default and stays that way: publishing replaces what every
  # download link serves, and a run that reaches this point by accident must not
  # be able to complete it. `--yes` changes only *when* the answer was given — on
  # the command line rather than at the prompt, which is the same person saying
  # the same thing and is what makes an unattended release possible.
  if [ "$ASSUME_YES" -eq 1 ]; then
    echo "  --yes given; uploading."
  elif [ ! -t 0 ]; then
    echo "not published: --publish asks before uploading and there is no terminal to ask on." >&2
    echo "  Pass --yes to answer it in advance." >&2
    return
  else
    local reply=''
    read -r -p "  type 'yes' to upload: " reply || true
    if [ "$reply" != "yes" ]; then
      echo "  not published."
      return
    fi
  fi

  # --clobber because the asset names are constants: without it the second
  # release is refused for every name that already exists.
  if gh release upload "$TAG" "${uploads[@]}" --clobber --repo "$REPO"; then
    echo "  uploaded to https://github.com/$REPO/releases/tag/$TAG"
  else
    echo "not published: the upload failed — $OUT/ is intact, try again." >&2
  fi
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  preflight && echo -e "\n  ${GREEN}ready.${NC}" || {
    echo
    echo "  ./build.sh registers the qemu handlers itself, or:"
    echo "      docker run --privileged --rm tonistiigi/binfmt --install arm64"
    exit 1
  }
  exit 0
fi

if ! preflight; then
  # The one failure with an answer this script can apply. Offered rather than
  # assumed: it is a host-wide, privileged change.
  echo
  if [ "$ASSUME_YES" -eq 1 ] || [ -t 0 ]; then
    reply='yes'
    if [ "$ASSUME_YES" -eq 0 ]; then
      read -r -p "  register them now? [Y/n]: " reply || true
      reply="${reply:-yes}"
    fi
    case "$reply" in
      [Yy]*) install_binfmt ;;
      *) echo "  not registered; nothing built." >&2; exit 1 ;;
    esac
    preflight || { echo "  still cannot run every target; nothing built." >&2; exit 1; }
  else
    echo "  Register the qemu handlers and try again:" >&2
    echo "      docker run --privileged --rm tonistiigi/binfmt --install arm64" >&2
    exit 1
  fi
fi

echo
echo -e "${GREEN}Building $BINARY${NC}"
mkdir -p "$OUT"

# What runs inside the container, kept in a variable fed by a quoted heredoc
# rather than written inline as a single-quoted argument to `bash -c`.
#
# That is not a style preference. Inline, the whole script is one '…' string, so
# the first apostrophe in it ends the script — and a comment is exactly where an
# apostrophe goes unnoticed. This build spent a while doing that: a comment
# reading "the container's uname" closed the quote after `make`, so the copy-out
# below was never part of the script at all. It became an argument *to* it. The
# container built the binary, dropped it on exit and returned 0, and every run
# published whatever stale binaries happened to be sitting in build/.
#
# <<'SCRIPT' has no such trap: nothing inside is interpreted by this shell, so
# apostrophes, quotes and $ are all just text. The variables the script does use
# come in through -e, as before.
read -r -d '' CONTAINER_SCRIPT <<'SCRIPT' || true
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  build-essential libwebsockets-dev uuid-dev libbsd-dev
mkdir -p /work && cd /work
for f in $SOURCES; do cp "/src/$f" .; done
make

# The Makefile names its output after the architecture, and under qemu the
# container's uname is the target's, so what it produced already carries the
# release asset name.
built=$(echo build/${BINARY}_*)
[ -f "$built" ] || { echo "the container build produced no build/${BINARY}_*" >&2; exit 1; }

# Copied to a temporary name and renamed over the target, rather than written
# straight onto it.
#
# Writing onto it fails with ETXTBSY the moment the previous binary is running —
# which is the normal state of affairs on the machine where somebody is testing
# the bridge, and which used to abort the copy. rename(2) does not care: the
# running process keeps the inode it already has and the new file takes the
# name. chown before the rename, so the file is never briefly root-owned under
# the name the host is watching.
cp "$built" "/out/.tmp_${BINARY}_$$"
chown "$HOST_UID:$HOST_GID" "/out/.tmp_${BINARY}_$$"
mv -f "/out/.tmp_${BINARY}_$$" "/out/$(basename "$built")"
SCRIPT

for target in "${TARGETS[@]}"; do
  name="${target%%:*}"
  platform="${target#*:}"
  asset="$OUT/${BINARY}_$name"

  echo -ne "${YELLOW}  $name${NC} … "

  # A mark to compare the asset against afterwards. `-nt` is what decides whether
  # this run actually produced the file, so the stamp has to exist before the
  # build and after any previous one; sleeping is not needed because the copy is
  # minutes later, not milliseconds.
  stamp="$OUT/.$name.stamp"
  rm -f "$stamp"; : >"$stamp"

  # The source is mounted read-only and copied to a scratch directory inside the
  # container, so the Makefile's in-place .o and binary are the container's
  # problem and never appear in the working tree. Only build/ is writable.
  if ! docker run --rm --platform "$platform" \
      -v "$PWD:/src:ro" -v "$PWD/$OUT:/out" \
      -e "SOURCES=${SOURCES[*]}" -e "BINARY=$BINARY" \
      -e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)" \
      "$IMAGE" bash -c "$CONTAINER_SCRIPT" >"$OUT/.$name.log" 2>&1; then
    echo -e "${RED}failed${NC}"
    echo
    tail -25 "$OUT/.$name.log" | sed 's/^/      /' >&2
    echo
    echo "  full log: $OUT/.$name.log" >&2
    rm -f "$stamp"
    exit 1
  fi

  # The container's make already named it: build.sh and the Makefile agree on
  # ${BINARY}_<arch>, so there is nothing to rename here.
  #
  # Checked for freshness and not merely for existence. A previous run's binary
  # sits at this path, so `-f` is satisfied by a file this build had nothing to
  # do with — which is how a container that quietly failed to copy anything out
  # still looked like a success, and how stale binaries reached the release. The
  # question worth asking is whether *this* run wrote it.
  if [ ! -f "$asset" ] || [ ! "$asset" -nt "$stamp" ]; then
    echo -e "${RED}failed${NC}"
    if [ -f "$asset" ]; then
      echo "  the container exited 0 but did not write $asset — what is there is from $(date -r "$asset" '+%Y-%m-%d %H:%M')." >&2
      echo "  full log: $OUT/.$name.log" >&2
    else
      echo "  the build produced no $asset" >&2
    fi
    rm -f "$stamp"
    exit 1
  fi
  rm -f "$OUT/.$name.log" "$stamp"

  echo "$(du -h --apparent-size "$asset" | cut -f1)"
done

echo
echo -e "${GREEN}Done.${NC} Binaries are in $OUT/:"
for target in "${TARGETS[@]}"; do
  asset="$OUT/${BINARY}_${target%%:*}"
  [ -f "$asset" ] || continue
  # The architecture and the libraries it wants, because that is the thing most
  # worth checking about a dynamically linked release binary and the thing least
  # visible from a filename.
  printf '    %-32s %s\n' "$(basename "$asset")" \
    "$(readelf -h "$asset" | awk -F: '/Machine/{gsub(/^ +/,"",$2); print $2}')"
done

if [ "$PUBLISH" -eq 1 ]; then
  echo
  publish_release
fi
