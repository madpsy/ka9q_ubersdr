#!/usr/bin/env bash
# build.sh — build ubersdr-rtltcp-bridge for amd64 and arm64, and publish them.
#
# Go, and no C of its own — so this could cross-compile on the host in a second
# with GOARCH=arm64. It builds in containers anyway, the same way docker.sh
# builds the server image and clients/hpsdr/build.sh builds the bridge, and the
# reason is cgo rather than architecture:
#
#   CGO_ENABLED=0 produces a static binary that needs no glibc at all, which
#   looks strictly better until you notice what it does to name resolution. Go's
#   pure resolver reads /etc/hosts and talks DNS itself; it cannot call NSS
#   modules. UberSDR advertises itself over mDNS (see install-ubersdr-mdns.sh),
#   so `--url http://ubersdr.local:8080` resolves through nss-mdns via libc — and
#   under a static build it simply stops resolving, for a bridge whose whole job
#   is to reach a server the user names. cgo keeps libc doing the lookup, which
#   costs a glibc dependency and is the right trade here.
#
# With cgo on, the binary is dynamically linked and the build environment sets
# the oldest glibc it will run against. golang:1.24-bookworm is glibc 2.36, but
# what comes out asks only for GLIBC_2.34 — Go's runtime touches nothing newer,
# 2.34 being where libpthread merged into libc. That matches the binaries this
# replaces exactly, so anything running the current download runs this one.
#
# Which is worth knowing before changing the image: the floor to watch is the
# highest GLIBC_x.y in `objdump -T`, not the image's own glibc, and the build
# reports it for each binary so a change of image cannot quietly raise it.
#
# arm64 runs under qemu, registered with binfmt_misc. The registration does not
# survive a reboot, so --check reports it and the build offers to install it.
#
# --remote builds arm64 on a real arm64 machine over ssh instead, which is
# faster than qemu and needs no binfmt registration. It produces an equivalent
# binary rather than merely a similar one, and both halves of that are worth
# checking before trusting it:
#
#   * The toolchain matches. GOTOOLCHAIN is `auto` by default, so the go.mod
#     `toolchain` directive pulls the same Go the container uses even where the
#     builder's own go is older — measured go1.22.5 on the host building with
#     go1.24.3.
#   * The glibc floor matches, which is the one that looks like it should not.
#     The builder ran Debian 13 (glibc 2.41) against the image's Debian 12
#     (2.36), and the binary still asked only for GLIBC_2.34, because the floor
#     is set by what the program references rather than by what the host has.
#     Go's runtime touches nothing newer.
#
# Neither is assumed: the build reports the floor for every binary it makes, so
# a builder that did raise it would say so before anything was published.
#
# Usage:
#   ./build.sh                 both architectures into build/
#   ./build.sh amd64           just the one — amd64 or arm64
#   ./build.sh --check         report whether this machine can build both, and stop
#   ./build.sh --remote        build arm64 natively over ssh on $UBERSDR_ARM_HOST
#                              (default pi5) rather than under qemu
#   ./build.sh --remote=HOST   ...on HOST
#   ./build.sh --test          run the tests before building
#   ./build.sh --publish       ...then upload what this run built to the `latest`
#                              release, replacing what is there. Asks first.
#   ./build.sh --yes           answer the publish prompt in advance, for a run
#                              with nobody at the terminal.

set -euo pipefail

cd "$(dirname "$0")"

ASSUME_YES=0
PUBLISH=0
CHECK_ONLY=0
RUN_TESTS=0

# The machine --remote builds arm64 on. Empty means qemu, which is the default:
# a container is always there, and another machine is not.
REMOTE_HOST=""
REMOTE_DEFAULT="${UBERSDR_ARM_HOST:-pi5}"

# Where the toolchain lives on a builder that has one installed by hand rather
# than packaged. Prepended, not replaced, so a packaged go on PATH still wins.
REMOTE_GO_PATH=/usr/local/go/bin

# Set when preflight failed on the builder rather than on qemu, so the advice
# afterwards is about the thing that actually went wrong. Registering binfmt
# handlers does not make an unreachable host reachable.
PREFLIGHT_REMOTE_FAILED=0

# Same tag, repo and override variables as the other clients' build scripts: one
# release holds them all. The asset names are the filenames built below, because
# the download links point straight at them, so publishing replaces an asset
# rather than adding one.
REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"

# The build environment, and with it the oldest glibc these binaries run against.
# See the header before changing it.
IMAGE="${UBERSDR_BUILD_IMAGE:-golang:1.24-bookworm}"

OUT="build"
BINARY="ubersdr-rtltcp-bridge"

# Downloaded modules, kept between runs and between architectures. Without it
# every build re-fetches the whole module graph, and the arm64 one does it
# through qemu.
CACHE_VOLUME="${UBERSDR_GOCACHE_VOLUME:-ubersdr-rtltcp-gomod}"

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
    --test) RUN_TESTS=1 ;;
    --remote) REMOTE_HOST="$REMOTE_DEFAULT" ;;
    --remote=*) REMOTE_HOST="${arg#--remote=}" ;;
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

# One remote command, with the toolchain on PATH that a non-interactive ssh
# session does not get, and without the X11 line the builder prints in front of
# everything when it offers forwarding this host cannot use.
remote() {
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE_HOST" \
    "export PATH=$REMOTE_GO_PATH:\$PATH; $*" \
    2> >(grep -v "X11 forwarding request failed" >&2)
}

# Builds one architecture on a real machine of that architecture.
#
# The source goes over as named files rather than as the directory: build/ holds
# binaries from previous runs, and shipping those to the builder and back would
# be a slow way of achieving nothing. The remote copy is removed afterwards; the
# module cache under ~/go is not, so a second build fetches nothing.
build_remote() {
  local asset="$1"
  local dir=".cache/ubersdr-rtltcp-build"

  tar czf - go.mod go.sum ./*.go testdata \
    | remote "rm -rf $dir && mkdir -p $dir && tar xzf - -C $dir" || return 1

  # The same flags the container uses, for the reason in the header: cgo stays
  # on so libc resolves names, which is what makes an mDNS --url work.
  remote "cd $dir && CGO_ENABLED=1 go build -ldflags='-s -w' -o '$BINARY' ." || return 1

  remote "cat $dir/$BINARY" > "$asset" || return 1
  chmod +x "$asset"
  remote "rm -rf $dir" || true
}

preflight() {
  local ok=0
  echo -e "${GREEN}  Build environment${NC}"

  if [ -n "$REMOTE_HOST" ]; then
    # Reported before docker, because with --remote the arm64 half does not
    # need docker at all and a failure here is the one that stops the build.
    if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" true 2>/dev/null; then
      echo -e "    remote         ${RED}cannot reach $REMOTE_HOST${NC} without a password — set up key auth, or drop --remote."
      PREFLIGHT_REMOTE_FAILED=1
      return 1
    fi
    local rgo
    rgo="$(remote 'command -v go >/dev/null 2>&1 && go version' 2>/dev/null || true)"
    if [ -z "$rgo" ]; then
      echo -e "    remote         ${RED}$REMOTE_HOST has no go${NC} on PATH or in $REMOTE_GO_PATH."
      PREFLIGHT_REMOTE_FAILED=1
      return 1
    fi
    echo    "    remote         $REMOTE_HOST — $(remote 'uname -m') — $rgo"
  fi

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
    if [ "$name" = "arm64" ] && [ -n "$REMOTE_HOST" ]; then
      echo  "    $name          built on $REMOTE_HOST, not under qemu"
      continue
    fi
    if can_run_platform "$platform"; then
      echo    "    $name          can run $platform"
    else
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
    if [ "$PREFLIGHT_REMOTE_FAILED" -eq 1 ]; then
      echo "  Fix the builder above, or drop --remote to build arm64 under qemu."
    else
      echo "  ./build.sh registers the qemu handlers itself, or:"
      echo "      docker run --privileged --rm tonistiigi/binfmt --install arm64"
    fi
    exit 1
  }
  exit 0
fi

if ! preflight; then
  echo
  # Only qemu is offered to be fixed here, because only qemu can be: a builder
  # that cannot be reached is not something this script should try to repair.
  if [ "$PREFLIGHT_REMOTE_FAILED" -eq 1 ]; then
    echo "  Fix the builder above, or drop --remote to build arm64 under qemu." >&2
    exit 1
  fi
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

# Native, and only native. The tests are the same tests whatever the target, and
# running them again under qemu costs minutes to learn nothing new.
if [ "$RUN_TESTS" -eq 1 ]; then
  echo
  echo -e "${YELLOW}  tests${NC} …"
  if ! docker run --rm --platform linux/amd64 \
      -v "$PWD:/src:ro" -v "$CACHE_VOLUME:/go/pkg/mod" \
      "$IMAGE" bash -c 'cp -r /src /work && cd /work && go test -short ./...'; then
    echo "  not built: the tests failed." >&2
    exit 1
  fi
fi

echo
echo -e "${GREEN}Building $BINARY${NC}"
mkdir -p "$OUT"

for target in "${TARGETS[@]}"; do
  name="${target%%:*}"
  platform="${target#*:}"
  asset="$OUT/${BINARY}_$name"

  echo -ne "${YELLOW}  $name${NC} … "

  if [ "$name" = "arm64" ] && [ -n "$REMOTE_HOST" ]; then
    if ! build_remote "$asset" >"$OUT/.$name.log" 2>&1; then
      echo -e "${RED}failed${NC}"
      echo
      tail -25 "$OUT/.$name.log" | sed 's/^/      /' >&2
      echo
      echo "  full log: $OUT/.$name.log" >&2
      exit 1
    fi
    rm -f "$OUT/.$name.log"
    echo "$(du -h --apparent-size "$asset" | cut -f1)  (built on $REMOTE_HOST)"
    continue
  fi

  # The source is mounted read-only and copied inside, so nothing the build does
  # — a rewritten go.sum, a stray binary — reaches the working tree. Only build/
  # is writable, and the module cache is a named volume rather than a bind mount
  # so its root-owned contents stay out of the way entirely.
  if ! docker run --rm --platform "$platform" \
      -v "$PWD:/src:ro" -v "$PWD/$OUT:/out" -v "$CACHE_VOLUME:/go/pkg/mod" \
      -e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)" -e "BINARY=$BINARY" \
      "$IMAGE" bash -c '
        set -e
        cp -r /src /work && cd /work
        # -s -w drop the symbol table and DWARF data, as the Makefile does.
        CGO_ENABLED=1 go build -ldflags="-s -w" -o "/out/$BINARY" .
        # Handed back to the user who started the build. The container is root
        # and the bind mount carries its ownership straight out to the host, so
        # without this the binary lands root-owned in the working tree and the
        # next run cannot overwrite it. Done in here because in here is root.
        chown "$HOST_UID:$HOST_GID" "/out/$BINARY"
      ' >"$OUT/.$name.log" 2>&1; then
    echo -e "${RED}failed${NC}"
    echo
    tail -25 "$OUT/.$name.log" | sed 's/^/      /' >&2
    echo
    echo "  full log: $OUT/.$name.log" >&2
    exit 1
  fi

  mv "$OUT/$BINARY" "$asset"
  rm -f "$OUT/.$name.log"

  echo "$(du -h --apparent-size "$asset" | cut -f1)"
done

echo
echo -e "${GREEN}Done.${NC} Binaries are in $OUT/:"
for target in "${TARGETS[@]}"; do
  asset="$OUT/${BINARY}_${target%%:*}"
  [ -f "$asset" ] || continue
  # The glibc floor, reported because it is the number that decides which
  # machines the download runs on and the one a change of base image moves
  # without otherwise showing up anywhere.
  printf '    %-34s %-14s needs %s or newer\n' \
    "$(basename "$asset")" \
    "$(readelf -h "$asset" | awk -F: '/Machine/{gsub(/^ +/,"",$2); print $2}')" \
    "$(objdump -T "$asset" | grep -oP 'GLIBC_\d+\.\d+' | sort -uV | tail -1)"
done

if [ "$PUBLISH" -eq 1 ]; then
  echo
  publish_release
fi
