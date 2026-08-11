#!/usr/bin/env bash
# build.sh — build the v2 frontend and stage it for the desktop client.
#
# The desktop client shares the web UI by consuming its build artifacts, not
# by copying its source: static/v2/build.sh produces dist/, and this script
# stages index.html + dist/ + fonts/ + vendor/ into ui/v2/, which the
# per-instance proxy serves for /v2/* when an instance is set to the built-in
# UI. Nothing under static/v2/ is modified.
#
# Usage:
#   ./build.sh             build v2, stage it, npm-install if needed
#   ./build.sh --skip-ui   skip the v2 build (keep the currently staged UI)
#   ./build.sh --package   all of the above, then produce distributables in dist/:
#                            on Linux   → AppImage + Windows zip + Windows installer
#                            on macOS   → dmg
#                            on Windows → NSIS installer
#                          (macOS packages can only be built on a Mac)
#   ./build.sh --linux     package the AppImage and nothing else. The Windows
#                          half of a Linux --package is most of its wall clock —
#                          a second Electron download the first time, then the
#                          zip, then a 4.7 GB container for the installer — and
#                          none of it is wanted when the thing being tested is
#                          the Linux build.
#   ./build.sh --win-installer
#                          the Windows installer on its own terms: builds it
#                          wherever it can, and fails rather than skipping if it
#                          cannot. `--package` on Linux does it too, but skips
#                          it with a note when Docker is absent.
#   ./build.sh --publish   package, then upload the artefacts to the `latest`
#                          release on GitHub with the gh CLI, replacing the ones
#                          already there. Asks first, and only from a terminal:
#                          this is the download every client in the field is
#                          pointed at. Implies --package.

set -euo pipefail

cd "$(dirname "$0")"
STATIC=../../static
V2="$STATIC/v2"

SKIP_UI=0
PACKAGE=0
WIN_INSTALLER=0
LINUX_ONLY=0
PUBLISH=0

# The release everything is uploaded to and every client downloads from. A
# rolling tag: publishing moves it, and the asset names are constants (see the
# artifactName settings in package.json), so the URLs in updates.js never change.
#
# Named here rather than left to gh's guess from `origin`, so a clone with a
# fork as its remote cannot quietly publish this project's downloads somewhere
# else — or, worse, somewhere else's downloads here.
REPO=madpsy/ka9q_ubersdr
TAG=latest

for arg in "$@"; do
    case "$arg" in
        --skip-ui) SKIP_UI=1 ;;
        --package) PACKAGE=1 ;;
        --publish) PUBLISH=1; PACKAGE=1 ;;
        --linux) LINUX_ONLY=1; PACKAGE=1 ;;
        # 2 rather than 1: asked for outright, so a missing Docker is an
        # error here and merely a skipped step when --package implies it.
        --win-installer) WIN_INSTALLER=2; PACKAGE=1 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

# Said now rather than after the minute the UI takes: one of these asks for
# nothing but Linux and the other for a Windows installer above all, and
# silently honouring whichever was written last is how somebody waits out a
# build for an artefact they did not get.
if [[ "$LINUX_ONLY" -eq 1 ]] && [[ "$WIN_INSTALLER" -ne 0 ]]; then
    echo "--linux and --win-installer ask for opposite things" >&2
    exit 2
fi

# The Windows installer is built in electron-builder's own image.
#
# NSIS is a Windows toolchain, and cross-building it needs a wine with 32-bit
# support. A wine without one does not fail: it writes a 300 KB stub beside the
# 78 MB payload it failed to embed, and exits 0. An installer that is the wrong
# size by two orders of magnitude and reports success is worse than no
# installer, so this does not attempt it on the host.
#
# The image is electron-builder's own, so the wine in it is the one the tool is
# tested against. The caches are mounted because without them every run
# re-downloads the Windows Electron binaries.
WIN_IMAGE=electronuserland/builder:wine

# The artefacts a client actually downloads, by the fixed names package.json
# pins them to. The Windows zip is deliberately not here: nothing links to it,
# and its name carries the version, so uploading it would leave a new copy on
# the release every time rather than replacing the last.
#
# Not every one of these exists after any given build — a dmg needs a Mac, and
# --linux skips the Windows half — so publishing uploads what is there and says
# what is not.
RELEASE_ASSETS=(
    dist/UberSDR.AppImage
    dist/UberSDR.Setup.exe
    dist/UberSDR-arm64.dmg
    dist/UberSDR-x64.dmg
)

# What the dmg about to be built will and will not be, said before it is built.
#
# A signed-and-notarised dmg and an unsigned one are the same file to look at,
# and the difference only shows on somebody else's Mac: Gatekeeper refuses a
# *downloaded* app that is not notarised, and a dmg built on the machine it runs
# on was never downloaded, so it carries no quarantine attribute and works
# perfectly for the person who built it. That is the trap this exists for — the
# build that looked fine and is refused as damaged by everybody who gets it.
#
# Reported, never enforced. Building without a certificate is a legitimate thing
# to do — it is what every test build is — so this says what will happen rather
# than refusing to do it.
mac_signing_report() {
    local identity='' notary=''

    # The certificate. Either handed over as a file, named outright, or already
    # in the keychain, which is where it lands after Xcode imports a .p12 and is
    # how electron-builder finds it with nothing set at all.
    if [[ -n "${CSC_LINK:-}" ]]; then
        identity="CSC_LINK"
    elif [[ -n "${CSC_NAME:-}" ]]; then
        identity="CSC_NAME=${CSC_NAME}"
    elif security find-identity -v -p codesigning 2>/dev/null | grep -q 'Developer ID Application'; then
        identity="keychain: $(security find-identity -v -p codesigning 2>/dev/null \
            | grep -m1 'Developer ID Application' | sed 's/.*"\(.*\)".*/\1/')"
    fi

    # The three credential sets @electron/notarize accepts, in the order its own
    # documentation recommends them.
    if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
        notary="App Store Connect API key"
    elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
        notary="Apple ID and app-specific password"
    elif [[ -n "${APPLE_KEYCHAIN:-}" && -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
        notary="keychain profile ${APPLE_KEYCHAIN_PROFILE}"
    fi

    echo
    echo "  macOS signing"
    echo "    certificate    ${identity:-none found — the app will be unsigned}"
    echo "    notarisation   ${notary:-no credentials — the dmg will not be notarised}"
    if [[ -z "$identity" || -z "$notary" ]]; then
        echo
        echo "    This dmg will work on this Mac and be refused on anyone else's:"
        echo "    Gatekeeper rejects a downloaded app that is not signed AND"
        echo "    notarised. Fine for a test build. See README.md, 'Signing'."
    fi
    echo
}

# Uploads the artefacts to the rolling release, replacing what is there.
#
# Everything that could stop it is checked and reported rather than left to gh's
# own error: this runs at the end of a build somebody has waited several minutes
# for, and "gh: command not found" scrolling past among electron-builder's
# output is a release that quietly did not happen.
#
# Never without being asked. The tag is what every installed client downloads
# from, --clobber replaces the files behind it, and there is no undo — so a
# terminal and a typed yes are the price, and a run with neither declines rather
# than assuming.
publish_release() {
    if ! command -v gh >/dev/null 2>&1; then
        echo "not published: gh not found — install the GitHub CLI, or upload dist/ by hand." >&2
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

    local found=() missing=()
    local asset
    for asset in "${RELEASE_ASSETS[@]}"; do
        if [[ -f "$asset" ]]; then found+=("$asset"); else missing+=("$asset"); fi
    done
    if [[ "${#found[@]}" -eq 0 ]]; then
        echo "not published: none of the release artefacts are in dist/." >&2
        return
    fi

    echo
    echo "  Upload to https://github.com/$REPO/releases/tag/$TAG, replacing what is there:"
    for asset in "${found[@]}"; do
        echo "      $(basename "$asset")   $(du -h "$asset" | cut -f1)"
    done
    if [[ "${#missing[@]}" -gt 0 ]]; then
        echo
        echo "  Not built here, so left alone on the release:"
        for asset in "${missing[@]}"; do echo "      $(basename "$asset")"; done
    fi
    echo

    # A terminal, or nothing happens. An unattended run publishing to the tag
    # every client downloads from is precisely what should not be possible by
    # accident.
    if [[ ! -t 0 ]]; then
        echo "not published: --publish asks before uploading and there is no terminal to ask on." >&2
        return
    fi
    local reply=''
    read -r -p "  type 'yes' to upload: " reply || true
    if [[ "$reply" != "yes" ]]; then
        echo "  not published."
        return
    fi

    # --clobber because the names never change: without it the second release
    # is refused for every asset that already exists.
    if gh release upload "$TAG" "${found[@]}" --clobber --repo "$REPO"; then
        echo "  uploaded to https://github.com/$REPO/releases/tag/$TAG"
    else
        echo "not published: the upload failed — dist/ is intact, try again." >&2
    fi
}

if [[ "$SKIP_UI" -eq 0 ]]; then
    "$V2/build.sh"

    rm -rf ui
    mkdir -p ui/v2
    cp "$V2/index.html" ui/v2/
    cp -r "$V2/dist" "$V2/fonts" "$V2/vendor" ui/v2/

    # Shown in the chooser footer, so a stale bundle is visible at a glance.
    {
        printf '%s' "$(git -C "$V2" rev-parse --short HEAD 2>/dev/null || echo unknown)"
        printf ' (%s)\n' "$(date -u +%Y-%m-%d)"
    } > ui/BUILD_INFO

    echo "staged v2 UI into ui/v2/ ($(cat ui/BUILD_INFO))"
fi

# The chooser's map, and its flags.
#
# Leaflet, the day/night terminator and the flags-only Twemoji subset, copied
# from the files the server already serves for v1 rather than vendored a second
# time — the web UI loads exactly these, so the desktop directory draws what a
# browser draws. Staged rather than committed for the same reason ui/ is: they
# are somebody else's libraries and they live in static/.
#
# The font is not decoration. A directory row's country is a pair of regional
# indicators, which every platform but Windows renders as a flag and Windows
# renders as two letters in boxes: Segoe UI Emoji ships no national flags, so
# Chromium there has nothing to draw. See the @font-face in chooser.css.
#
# Outside --skip-ui, because it is a copy of four files and a checkout that
# skipped the UI build still deserves a map. Their absence is not fatal — the
# chooser lists every receiver and says why there is no map — so this does not
# fail the build if static/ has moved.
mkdir -p chooser/vendor
cp "$STATIC/leaflet.js" "$STATIC/leaflet.css" "$STATIC/L.Terminator.js" \
   "$STATIC/fonts/twemoji-flags.woff2" chooser/vendor/ \
    || echo "warning: could not stage leaflet/flags — the chooser's map will be unavailable" >&2

# The main process's and the preload's own bundles.
#
# Outside --skip-ui on purpose. These are seconds rather than the minute the v2
# bundle takes, and they are this client's own source rather than the staged
# UI — so skipping them means running yesterday's preload against today's edit,
# which looks exactly like a change that did not work. It has cost three
# debugging sessions; the seconds are cheaper.
mkdir -p ui

# The pages-menu pruning, as CommonJS for the main process: the native Links
# menu and the UI's own logo menu list the same receiver's pages, so they share
# the one implementation rather than each keeping a copy that can drift. Same
# trick the v2 test harness uses to run src modules under plain node.
esbuild "$V2/src/lib/pagesMenu.js" --bundle --format=cjs --platform=node \
    --log-level=warning --outfile=ui/pagesMenu.cjs

# The page API's own client library, for the receiver preload: the Layout menu
# is a bridge client like any browser extension, and hand-rolling the protocol
# in the preload would be a second implementation of a wire format whose tests
# are its specification.
esbuild "$V2/src/bridge/client.js" --bundle --format=cjs --platform=node \
    --log-level=warning --outfile=ui/bridgeClient.cjs

# ...and then the receiver preload with that client bundled into it.
#
# A preload is sandboxed (Electron's default, and worth keeping for a window
# showing an instance's own pages), and a sandboxed preload's `require` only
# answers for `electron` — a path to a file of ours fails with "module not
# found" at runtime. Bundling resolves it at build time instead, which keeps the
# sandbox rather than trading it for a require.
esbuild receiver-preload.js --bundle --format=cjs --platform=node \
    --external:electron --log-level=warning --outfile=ui/receiver-preload.js

if [[ ! -d node_modules ]]; then
    command -v npm >/dev/null 2>&1 || { echo "npm not found — install Node.js to run the desktop client" >&2; exit 1; }
    npm install
fi

if [[ "$PACKAGE" -eq 1 ]]; then
    if [[ "$LINUX_ONLY" -eq 1 ]]; then
        # An AppImage is a Linux binary with a Linux runtime concatenated onto
        # it, and electron-builder assembles it with the host's own tools. Asked
        # for anywhere else this fails somewhere deep in a toolchain that is not
        # there, so it is refused here where the reason still fits on a line.
        if [[ "$(uname -s)" != Linux ]]; then
            echo "--linux builds the AppImage, which needs a Linux host (this is $(uname -s))" >&2
            exit 1
        fi
        ./node_modules/.bin/electron-builder --linux AppImage --x64
        # WIN_INSTALLER stays 0, so the Windows half below is skipped entirely.
    else
        case "$(uname -s)" in
            # This branch already cross-builds for Windows — the zip is a
            # Windows artefact — so the installer belongs with it rather than
            # behind a flag somebody has to know about.
            # An `[[ ]] && x` here would be the last command of the branch, and
            # under `set -e` a false test would end the script.
            Linux)  ./node_modules/.bin/electron-builder --linux AppImage --win zip --x64
                    if [[ "$WIN_INSTALLER" -eq 0 ]]; then WIN_INSTALLER=1; fi ;;
            # Said before the build rather than after: notarisation adds
            # several minutes of uploading and waiting to it, and finding out
            # then that there were no credentials to notarise with is finding
            # out too late to do anything but start again.
            Darwin) mac_signing_report
                    ./node_modules/.bin/electron-builder --mac ;;
            # Already on Windows: NSIS builds natively, and Docker would be a
            # detour through a Linux VM to reach the toolchain already present.
            *)      ./node_modules/.bin/electron-builder --win nsis
                    WIN_INSTALLER=0 ;;
        esac
    fi

    if [[ "$WIN_INSTALLER" -ne 0 ]] && ! command -v docker >/dev/null 2>&1; then
        if [[ "$WIN_INSTALLER" -eq 2 ]]; then
            echo "--win-installer needs docker (the NSIS toolchain runs in $WIN_IMAGE)" >&2
            exit 1
        fi
        # Asked for as part of everything, rather than on its own: the rest of
        # the build is good and the zip is still a usable Windows download, so
        # say what is missing and carry on.
        echo "no docker — skipping the Windows installer (the zip is still built)." >&2
        echo "  install docker, or run ./build.sh --package on Windows itself." >&2
        WIN_INSTALLER=0
    fi

    if [[ "$WIN_INSTALLER" -ne 0 ]]; then
        # `docker run` fetches a missing image on its own, but this one is
        # 4.7 GB and the download would otherwise look like the build hanging.
        if ! docker image inspect "$WIN_IMAGE" >/dev/null 2>&1; then
            echo "fetching $WIN_IMAGE (~4.7 GB, once) …"
            docker pull "$WIN_IMAGE"
        fi
        echo "building the Windows installer in $WIN_IMAGE …"
        mkdir -p "$HOME/.cache/electron" "$HOME/.cache/electron-builder"
        # As you, not as root. The container writes straight into dist/, and
        # root-owned artefacts are ones you cannot delete or overwrite without
        # sudo — including on the next run, which then fails.
        #
        # HOME comes with that: the image's is /root, which is not writable
        # once the user changes, and electron-builder wants somewhere to put a
        # config. /tmp is writable by anyone inside the container, and the two
        # caches worth keeping are mounted from the host explicitly.
        docker run --rm \
            --user "$(id -u):$(id -g)" \
            --env HOME=/tmp/electron-builder-home \
            --env ELECTRON_CACHE="$HOME/.cache/electron" \
            --env ELECTRON_BUILDER_CACHE="$HOME/.cache/electron-builder" \
            -v "$PWD":/project \
            -v "$HOME/.cache/electron":"$HOME/.cache/electron" \
            -v "$HOME/.cache/electron-builder":"$HOME/.cache/electron-builder" \
            -w /project \
            "$WIN_IMAGE" \
            ./node_modules/.bin/electron-builder --win nsis --x64

        # Trust the artefact, not the exit code — see WIN_IMAGE above. The app
        # is over 100 MB, so an installer smaller than 50 MB has not got it.
        #
        # The exact name rather than a *Setup*.exe glob: the installer is pinned
        # to one filename now (package.json's nsis.artifactName), and a glob
        # picks up an older versioned build left in dist/ — checking the size of
        # last month's installer and passing.
        setup=dist/UberSDR.Setup.exe
        if [[ ! -f "$setup" ]] || [[ $(stat -c%s "$setup") -lt 50000000 ]]; then
            echo "the Windows installer did not build properly — $setup" >&2
            exit 1
        fi
        # The payload is embedded in the .exe by now; leaving it beside the
        # installer only invites somebody to ship the wrong file.
        rm -f dist/*.nsis.7z
    fi
    echo "distributables in dist/:"
    ls -1sh dist/ | grep -v -- '-unpacked\|builder-\|^total'

    # Where this build sits in a release, said at the end because that is where
    # it is acted on. Said at all because nothing else will — the build is happy
    # to produce a fourth identical v0.1.0, and the first sign that the version
    # never moved is nobody being told there was a release.
    #
    # Two files carry it. package.json's is what an installed client reports
    # itself as; latest.json's is what a running client compares that against
    # (see updates.js). They move at different times on purpose:
    #
    #   bump package.json → build → upload → bump latest.json
    #
    # in that order, because latest.json is the announcement. Bumped early it
    # points everybody at a build that is not uploaded yet; bumped late it
    # merely means nobody has heard about a release that is sitting there
    # ready — which is a wait, not a broken download.
    version=$(node -p "require('./package.json').version" 2>/dev/null || echo '?')
    published=$(node -p "require('./latest.json').version" 2>/dev/null || echo '?')

    # Through updates.js's own comparator rather than bash's `>`, which collates
    # rather than counts: `[[ 0.10.0 > 0.9.0 ]]` is false, and the release that
    # discovers it is the one after 0.9. Reusing the client's function also
    # means this and the client can never disagree about which is newer.
    newer() {
        node -e "process.stdout.write(require('./updates.js').isNewer(process.argv[1], process.argv[2]) ? '1' : '0')" \
            "$1" "$2" 2>/dev/null || echo 0
    }
    build_ahead=$(newer "$version" "$published")
    advertised_ahead=$(newer "$published" "$version")

    echo
    echo "  this build is v$version, and latest.json advertises v$published"
    echo
    if [[ "$version" == "$published" ]]; then
        # Nothing to announce: an upload now replaces the files behind a version
        # everybody already believes they have.
        echo "  Already advertised. For a new release, bump the version in"
        echo "      clients/electron/package.json"
        echo "  and build again — then upload, and set latest.json to match."
    elif [[ "$build_ahead" == 1 ]]; then
        echo "  Ready to publish. Upload the files above to the '$TAG' release,"
        echo "  then announce them by setting"
        echo "      clients/electron/latest.json    version: \"$version\""
        echo "  Clients check it on start and offer the download."
    elif [[ "$advertised_ahead" == 1 ]]; then
        # latest.json ahead of the build: everybody is being pointed at a
        # version that does not exist here. Worth saying loudly.
        echo "  latest.json is AHEAD of this build — clients are being offered a"
        echo "  v$published that this tree does not produce. Fix one or the other"
        echo "  before uploading anything."
    else
        # Neither is newer and they are not equal, so at least one is not a
        # version at all — a hand-edit, or a file that failed to parse.
        echo "  Cannot compare v$version with v$published. Check that both are"
        echo "  plain version numbers before publishing."
    fi
    echo

    if [[ "$PUBLISH" -eq 1 ]]; then
        publish_release
    else
        echo "  ./build.sh --publish does the upload for you (asks first)."
        echo
        # Only with a terminal to press a key on. A CI or container run has none
        # and would wait here for ever, which is a build that looks like it hung.
        # `|| true` because EOF makes read exit non-zero, and set -e would take
        # that for a failed build.
        if [[ -t 0 ]]; then
            read -n 1 -s -r -p "  press any key to continue … " || true
            echo
        fi
    fi
fi

if [[ "$PACKAGE" -eq 1 ]]; then
    echo "done — start with: npm start"
else
    # Said plainly, because the run that stops here looks exactly like the run
    # that builds installers: both end in a wall of esbuild output and a "done".
    # Nothing names the flag, so the way to find out you wanted it is to go
    # looking in dist/ for something that was never built.
    echo
    echo "done — the UI is built and staged, and nothing was packaged."
    echo
    echo "  ./build.sh --package    installable builds in dist/ — the AppImage,"
    echo "                          the Windows zip and the Windows installer."
    echo "                          This is usually the one you want."
    echo
    echo "  ./build.sh --linux      just the AppImage, skipping the Windows half."
    echo
    echo "  npm start               run it from here without packaging."
fi
