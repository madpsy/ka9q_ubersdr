#!/usr/bin/env bash
# build.sh — build iq_recorder for Linux and Windows, and publish them.
#
# PyInstaller cannot cross-compile: it bundles the interpreter and the native
# extension modules of whatever it is running on, so a Linux run produces an ELF
# and only a Windows run produces an .exe. That is the whole reason this script
# is two different build paths rather than a loop over a target list.
#
# The Windows half therefore runs under wine in a container, the same way
# clients/electron/build.sh cross-builds its NSIS installer. The image carries a
# Windows Python with tkinter -- which this app needs, being a Tk GUI -- and the
# PyInstaller version requirements.txt pins. Nothing is installed on the host and
# no wine prefix of yours is touched.
#
# Usage:
#   ./build.sh                 both into dist/
#   ./build.sh linux           just the one -- linux or windows
#   ./build.sh --test          run the protocol decoder's conformance tests first
#   ./build.sh --publish       ...then upload what this run built to the `latest`
#                              release, replacing what is there. Asks first.
#   ./build.sh --yes           answer the publish prompt in advance, for a run
#                              with nobody at the terminal. Only with --publish.
#   ./build.sh --clean         remove dist/ and build/ first

set -euo pipefail

cd "$(dirname "$0")"

OUT="dist"
PYDIR="../python"

# The release assets, and the filenames PyInstaller already produces. They are
# NOT the Go recorder's `iq-recorder_amd64` and `iq-recorder_arm64`: that is a
# different program in clients/iq-recorder, and the underscore here is the only
# thing keeping the two sets of assets apart. Do not "tidy" either to match.
LINUX_ASSET="iq_recorder"
WIN_ASSET="iq_recorder.exe"

REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"

# The wine image. Pinned by name rather than digest because it is a build tool
# rather than something that ships, but it is worth knowing what it must supply:
# a Windows Python with tkinter, pip, and PyInstaller >= 6.17 to match
# requirements.txt.
WIN_IMAGE="${UBERSDR_WIN_IMAGE:-batonogov/pyinstaller-windows:latest}"

# What the Windows build installs before running PyInstaller. requirements.txt
# is the source of truth, but it is installed in two halves: the core cannot
# fail, while the audio and DSP extras are optional at runtime -- radio_client
# catches their ImportError and prints a warning -- and are not worth failing a
# release build over if a wheel is missing for the image's Python.
WIN_CORE_DEPS="aiohttp websockets requests numpy zstandard"
WIN_EXTRA_DEPS="scipy opuslib samplerate sounddevice PyAudio pyserial zeroconf urllib3"

RUN_TESTS=0
PUBLISH=0
ASSUME_YES=0
CLEAN=0

# What an interrupt has to take with it.
#
# The Windows build runs in a container against a staging directory, and neither
# is a child of this shell: killing the script leaves the container compiling
# stale source and the staging directory behind, root-owned so that even rm
# cannot clear it. A `trap ... RETURN` inside the function does not help, because
# an interrupt never returns from it. So the two live here and are torn down on
# any exit, ordinary or not.
BUILD_CONTAINER=""
BUILD_STAGE=""

cleanup() {
  local status=$?
  if [ -n "$BUILD_CONTAINER" ] && docker ps -q --filter "name=^${BUILD_CONTAINER}$" 2>/dev/null | grep -q .; then
    echo "  stopping build container $BUILD_CONTAINER" >&2
    docker kill "$BUILD_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "$BUILD_STAGE" ] && [ -d "$BUILD_STAGE" ]; then
    # The container wrote as root, so hand ownership back before removing --
    # otherwise this rm fails and the directory survives the cleanup meant to
    # remove it.
    if ! rm -rf "$BUILD_STAGE" 2>/dev/null; then
      docker run --rm --entrypoint /bin/sh -v "$BUILD_STAGE:/stage" "$WIN_IMAGE" \
        -c "chown -R $(id -u):$(id -g) /stage" >/dev/null 2>&1 || true
      rm -rf "$BUILD_STAGE" 2>/dev/null || true
    fi
  fi
  BUILD_CONTAINER=""
  BUILD_STAGE=""
  return $status
}
trap cleanup EXIT INT TERM

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

TARGETS=()
WANTED=()
for arg in "$@"; do
  case "$arg" in
    --test) RUN_TESTS=1 ;;
    --publish) PUBLISH=1 ;;
    --yes) ASSUME_YES=1 ;;
    --clean) CLEAN=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    linux|windows) WANTED+=("$arg") ;;
    *) echo "unknown target: $arg (expected linux or windows)" >&2; exit 2 ;;
  esac
done
if [ ${#WANTED[@]} -gt 0 ]; then TARGETS=("${WANTED[@]}"); else TARGETS=(linux windows); fi

want() { local t; for t in "${TARGETS[@]}"; do [ "$t" = "$1" ] && return 0; done; return 1; }

# --------------------------------------------------------------------------
# Preflight
# --------------------------------------------------------------------------

# radio_client.py and pcm_v4.py live in clients/python and are pulled in by the
# spec. Checked here rather than left to PyInstaller, whose failure for a
# missing data file is a stack trace three screens long.
for required in radio_client.py pcm_v4.py; do
  if [ ! -f "$PYDIR/$required" ]; then
    echo -e "${RED}$PYDIR/$required is missing -- the spec needs it.${NC}" >&2
    exit 1
  fi
done

if [ "$CLEAN" -eq 1 ]; then
  echo "Cleaning dist/ and build/"
  rm -rf dist build
fi

# The decoder's conformance test lives with the module it tests, in
# clients/python. Run before building, not after: a predictor that has drifted
# from the server returns plausible noise rather than an error, and shipping
# that is worse than shipping nothing.
if [ "$RUN_TESTS" -eq 1 ]; then
  echo -e "${GREEN}Testing${NC}"
  (cd "$PYDIR" && python3 -m unittest test_pcm_v4 -q)
  echo
fi

# --------------------------------------------------------------------------
# Linux
# --------------------------------------------------------------------------

build_linux() {
  echo -e "${GREEN}Building $LINUX_ASSET for Linux${NC}"

  # A venv rather than the system Python: PyInstaller freezes whatever is
  # importable, so building against system site-packages bundles whatever else
  # happens to be installed there.
  if [ ! -d venv ]; then
    echo "  creating venv"
    python3 -m venv venv
    ./venv/bin/pip install -q --upgrade pip
  fi
  echo "  installing requirements"
  ./venv/bin/pip install -q -r requirements.txt pyinstaller || {
    echo -e "${YELLOW}  some requirements failed; continuing with what installed${NC}" >&2
  }

  ./venv/bin/python -m PyInstaller --clean --noconfirm iq_recorder.spec

  if [ ! -f "$OUT/$LINUX_ASSET" ]; then
    echo -e "${RED}  build produced no $OUT/$LINUX_ASSET${NC}" >&2
    return 1
  fi
  echo "  $OUT/$LINUX_ASSET  $(du -h "$OUT/$LINUX_ASSET" | cut -f1)"
}

# --------------------------------------------------------------------------
# Windows, under wine in a container
# --------------------------------------------------------------------------

build_windows() {
  echo -e "${GREEN}Building $WIN_ASSET for Windows (wine, $WIN_IMAGE)${NC}"

  if ! command -v docker >/dev/null 2>&1; then
    echo -e "${RED}  docker is needed for the Windows build (PyInstaller cannot cross-compile).${NC}" >&2
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo -e "${RED}  docker is installed but not usable -- is the daemon running, and are you in the docker group?${NC}" >&2
    return 1
  fi

  # Staged rather than bind-mounting the source tree, for two reasons: the spec
  # reaches into ../python, so the container needs both directories under one
  # mount; and this directory accumulates a Linux venv/ and dist/ that must not
  # be copied into a Windows build or shipped inside it.
  local stage
  stage="$(mktemp -d)"
  BUILD_STAGE="$stage"
  # Named so the trap can find it. A container started with --rm still has to be
  # killed by name when the script dies: --rm removes it once it stops, and
  # nothing stops it otherwise.
  BUILD_CONTAINER="ubersdr-iqrec-build-$$"

  mkdir -p "$stage/src/python_iq_recorder" "$stage/src/python"
  tar -cf - --exclude=venv --exclude=build --exclude=dist --exclude=__pycache__ \
      --exclude='*.wav' --exclude='*.pyc' . | tar -xf - -C "$stage/src/python_iq_recorder"
  cp "$PYDIR/radio_client.py" "$PYDIR/pcm_v4.py" "$stage/src/python/"

  # One container run: the image is not committed, so a separate install run
  # would be thrown away before PyInstaller ever saw it.
  # Backgrounded and waited on rather than run in the foreground.
  #
  # Bash defers a trap until the current foreground command finishes, so with
  # `docker run` in front the cleanup handler would not execute until the build
  # it is supposed to cancel had finished on its own -- which is exactly the case
  # that leaves a container compiling stale source after Ctrl-C. `wait` is
  # interruptible, so the signal is serviced immediately and the trap kills the
  # container by name.
  docker run --rm --name "$BUILD_CONTAINER" --entrypoint /bin/sh -v "$stage:/w" "$WIN_IMAGE" -c "
    set -e
    cd /w/src/python_iq_recorder
    wine python -m pip install --no-input -q $WIN_CORE_DEPS
    for p in $WIN_EXTRA_DEPS; do
      wine python -m pip install --no-input -q \"\$p\" >/dev/null 2>&1 || echo \"  optional dep \$p unavailable for this Python\"
    done
    wine python -m PyInstaller --clean --noconfirm iq_recorder.spec
    # The container runs as root, so everything it wrote is root-owned and the
    # staging directory cannot be removed afterwards by whoever ran this script.
    # Handing ownership back here rather than in a second container keeps it to
    # one run, and keeps the trap below able to do its job.
    chown -R $(id -u):$(id -g) /w
  " > "$stage/build.log" 2>&1 &
  local docker_pid=$!
  wait "$docker_pid" || true
  grep -viE '^wine|err:|fixme|XDG_RUNTIME_DIR|winbth' "$stage/build.log" | tail -12

  if [ ! -f "$stage/src/python_iq_recorder/dist/$WIN_ASSET" ]; then
    echo -e "${RED}  build produced no $WIN_ASSET${NC}" >&2
    return 1
  fi

  mkdir -p "$OUT"
  cp "$stage/src/python_iq_recorder/dist/$WIN_ASSET" "$OUT/$WIN_ASSET"

  # A Linux ELF here would mean the wine python was not used and the build
  # silently fell back to the container's own interpreter -- which produces a
  # file with the right name that no Windows machine can run.
  if ! file "$OUT/$WIN_ASSET" | grep -q 'PE32+'; then
    echo -e "${RED}  $OUT/$WIN_ASSET is not a Windows executable:${NC}" >&2
    file "$OUT/$WIN_ASSET" >&2
    rm -f "$OUT/$WIN_ASSET"
    return 1
  fi
  echo "  $OUT/$WIN_ASSET  $(du -h "$OUT/$WIN_ASSET" | cut -f1)"
}

# --------------------------------------------------------------------------
# Publish
# --------------------------------------------------------------------------

# Uploads what this run built to the rolling release, replacing what is there.
#
# What this run built, and not simply what is in dist/: a partial build leaves
# the other binary there from whenever it was last made, and publishing that
# would put a stale binary on the release under a name that says nothing about
# its age. So `./build.sh linux --publish` uploads one file.
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

  local uploads=()
  want linux   && [ -f "$OUT/$LINUX_ASSET" ] && uploads+=("$OUT/$LINUX_ASSET")
  want windows && [ -f "$OUT/$WIN_ASSET" ]   && uploads+=("$OUT/$WIN_ASSET")

  if [ ${#uploads[@]} -eq 0 ]; then
    echo "not published: this run produced nothing to upload." >&2
    return
  fi

  echo "  Upload to https://github.com/$REPO/releases/tag/$TAG, replacing what is there:"
  local asset
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
  #
  # A flag rather than an environment variable on purpose: an exported variable
  # is inherited by everything a shell starts, so a `yes` meant for one release
  # would sit there quietly authorising the next.
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

# --------------------------------------------------------------------------

want linux   && { build_linux; echo; }
want windows && { build_windows; echo; }

echo -e "${GREEN}Done.${NC} Binaries are in $OUT/:"
ls -1 "$OUT" 2>/dev/null || true

if [ "$PUBLISH" -eq 1 ]; then
  echo
  publish_release
fi
