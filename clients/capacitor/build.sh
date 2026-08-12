#!/usr/bin/env bash
# build.sh — build the v2 frontend, stage it and the chooser, and produce an APK.
#
# The Android client shares the main codebase the way the desktop one does: by
# consuming build artifacts, not by copying source. Two things are staged, and
# neither is modified on the way in.
#
#   the v2 frontend  static/v2/build.sh produces dist/, and index.html + dist/ +
#                    fonts/ + vendor/ are staged into www/v2/. `cap sync` copies
#                    www/ into the APK's assets, and LocalProxy.java serves
#                    /v2/* out of there — which is what makes this app bundled
#                    rather than a wrapper around somebody's website.
#
#   the chooser      clients/electron/chooser/ — the page itself, unmodified.
#                    Its one dependency on the host it runs in is
#                    `window.ubersdr`, which src/api.js provides here over
#                    Capacitor plugins and preload.js provides there over IPC.
#                    Staged rather than forked so that a change to the chooser
#                    is a change to both clients, which is the point of it being
#                    one page.
#
# Usage:
#   ./build.sh              build the UI, stage everything, sync the native project
#   ./build.sh --skip-ui    skip the v2 build (keep what is staged)
#   ./build.sh --apk        the above, then assemble a debug APK
#   ./build.sh --release    assemble a release APK instead (signed if the
#                           credentials are in the environment — see below)
#   ./build.sh --install    assemble the debug APK and adb-install it
#   ./build.sh --publish    release-build, then upload it to the `latest`
#                           release on GitHub with the gh CLI, replacing what is
#                           there. Asks first, and only from a terminal.
#                           Implies --release.
#   ./build.sh --clean      remove www/ and the Gradle outputs first

set -euo pipefail

cd "$(dirname "$0")"

# The release everything is uploaded to. A rolling tag: publishing moves it and
# the asset name is a constant, so the URL anybody has been given never changes.
#
# Named here rather than left to gh's guess from `origin`, so a clone with a
# fork as its remote cannot quietly publish this project's downloads somewhere
# else — or, worse, somewhere else's downloads here.
REPO=madpsy/ka9q_ubersdr
TAG=latest

# The one artefact, by the fixed name the download link uses. Versioned
# filenames would move the file on every bump and break every link already
# handed out; the version is inside the APK, where Android reads it.
ARTIFACT=dist/UberSDR.apk

V2=../../static/v2
STATIC=../../static
CHOOSER=../electron/chooser
# The desktop client's icon, which is the app's: the launcher icon and the mark
# in the chooser's header are both generated from it.
ICON_SRC=../electron/assets/icon.png

SKIP_UI=0
APK=0
RELEASE=0
INSTALL=0
CLEAN=0
PUBLISH=0

for arg in "$@"; do
    case "$arg" in
        --skip-ui) SKIP_UI=1 ;;
        --apk) APK=1 ;;
        --release) APK=1; RELEASE=1 ;;
        --install) APK=1; INSTALL=1 ;;
        --publish) APK=1; RELEASE=1; PUBLISH=1 ;;
        --clean) CLEAN=1 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

# What the APK about to be built will and will not be, said before it is built.
#
# The desktop client reports its macOS signing the same way and for the same
# reason, but the stakes differ: an unsigned dmg works perfectly for whoever
# built it and is refused on everybody else's Mac, whereas an unsigned release
# APK cannot be installed anywhere at all. So this reports, and publish_release
# refuses.
android_signing_report() {
    echo
    echo "  Release signing"
    if [[ -n "${UBERSDR_KEYSTORE:-}" ]]; then
        if [[ -f "${UBERSDR_KEYSTORE}" ]]; then
            echo "    keystore       ${UBERSDR_KEYSTORE}"
            echo "    alias          ${UBERSDR_KEY_ALIAS:-ubersdr}"
            if [[ -z "${UBERSDR_KEYSTORE_PASSWORD:-}" ]]; then
                echo "    password       UBERSDR_KEYSTORE_PASSWORD is not set — the build will fail"
            fi
        else
            echo "    keystore       ${UBERSDR_KEYSTORE} — not there"
        fi
    else
        echo "    keystore       none (UBERSDR_KEYSTORE is not set)"
        echo
        echo "    This APK will be unsigned, and Android will refuse to install"
        echo "    it. Fine for checking that it builds. See README.md."
    fi
    echo
}

# Uploads the APK to the rolling release, replacing what is there.
#
# Everything that could stop it is checked and reported rather than left to gh's
# own error: this runs at the end of a build somebody has waited several minutes
# for, and "gh: command not found" scrolling past is a release that quietly did
# not happen.
#
# Never without being asked. The tag is what every download link points at,
# --clobber replaces the file behind it, and there is no undo — so a terminal
# and a typed yes are the price, and a run with neither declines rather than
# assuming.
publish_release() {
    if ! command -v gh >/dev/null 2>&1; then
        echo "not published: gh not found — install the GitHub CLI, or upload $ARTIFACT by hand." >&2
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
    if [[ ! -f "$ARTIFACT" ]]; then
        echo "not published: $ARTIFACT was not built." >&2
        return
    fi
    # An unsigned APK is not a download, it is a file that fails to install.
    # Refused rather than reported, which is where this parts company with the
    # desktop client's unsigned dmg.
    if [[ -z "${UBERSDR_KEYSTORE:-}" ]]; then
        echo "not published: this APK is unsigned and nobody could install it." >&2
        echo "  Set UBERSDR_KEYSTORE and friends — see README.md, 'Signing'." >&2
        return
    fi

    echo
    echo "  Upload to https://github.com/$REPO/releases/tag/$TAG, replacing what is there:"
    echo "      $(basename "$ARTIFACT")   $(du -h "$ARTIFACT" | cut -f1)   version $(node -p "require('./package.json').version")"
    echo

    # A terminal, or nothing happens. An unattended run publishing to the tag
    # every download link points at is precisely what should not be possible by
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

    # --clobber because the name never changes: without it the second release is
    # refused for an asset that already exists.
    if gh release upload "$TAG" "$ARTIFACT" --clobber --repo "$REPO"; then
        echo "  uploaded to https://github.com/$REPO/releases/tag/$TAG"
    else
        echo "not published: the upload failed — $ARTIFACT is intact, try again." >&2
    fi
}

# The SDK. Android Studio is not required to build this — the wrapper, the
# platform and the build tools are, and Gradle finds them through one of these.
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"

if [[ "$CLEAN" -eq 1 ]]; then
    rm -rf www
    rm -rf android/app/build
fi

if [[ ! -d node_modules ]]; then
    echo "installing node dependencies…"
    npm install
fi

mkdir -p www

# ---- the v2 frontend --------------------------------------------------------

if [[ "$SKIP_UI" -eq 0 ]]; then
    "$V2/build.sh"

    rm -rf www/v2
    mkdir -p www/v2

    # static/v2/index.html is a Go template on the server: handleV2IndexPage
    # fills in the page metadata and the operator's custom head/body HTML. The
    # proxy serves this file straight out of the APK's assets, so nothing
    # renders it here — copied verbatim, the {{...}} actions would reach the
    # page as literal text.
    #
    # Resolved to app values instead: a plain title, and the rest dropped.
    # Search metadata describes a public URL this window does not have, and an
    # operator's injected HTML is the instance's business.
    sed -e 's|<title>{{\.Meta\.Title}}</title>|<title>UberSDR</title>|' \
        -e '/{{/d' \
        "$V2/index.html" > www/v2/index.html

    # Fail loudly rather than shipping a page with {{.Meta.Title}} in its title:
    # a new action added inline (not on its own line) would survive the delete
    # above, and a reworded <title> would be dropped by it.
    if grep -q '{{' www/v2/index.html; then
        echo "error: unresolved Go template action left in staged index.html:" >&2
        grep -n '{{' www/v2/index.html >&2
        exit 1
    fi
    if ! grep -q '<title>' www/v2/index.html; then
        echo "error: staged index.html has no <title> — did the title line change shape?" >&2
        exit 1
    fi

    cp -r "$V2/dist" "$V2/fonts" "$V2/vendor" www/v2/

    printf '%s (%s)\n' \
        "$(git -C "$V2" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
        "$(date -u +%Y-%m-%d)" > www/BUILD_INFO

    echo "staged v2 UI into www/v2/ ($(cat www/BUILD_INFO))"
fi

if [[ ! -f www/v2/dist/v2.js ]]; then
    echo "error: no v2 bundle staged in www/v2/ — run without --skip-ui." >&2
    echo "  This app has no remote-UI mode: the bundle is the UI." >&2
    exit 1
fi

# ---- the chooser ------------------------------------------------------------

cp "$CHOOSER/chooser.js" "$CHOOSER/chooser.css" www/

# The page, with three changes and no others.
#
#   * a viewport meta. The chooser has none, because a desktop window does not
#     need one; without it there are no safe-area insets to read, and Android
#     draws this app edge to edge (targetSdk 35 and up), so the header would sit
#     under the status bar. `viewport-fit=cover` is what makes env() answer, and
#     mobile.css is what reads it. Same line static/v2/index.html carries.
#   * app.js before chooser.js. chooser.js reads window.ubersdr while it is
#     being parsed, so the object has to be there first.
#   * mobile.css after chooser.css. The chooser was drawn for a desktop window;
#     what a phone needs on top of it lives in one sheet rather than in a fork
#     of the original.
#
# The CSP is left exactly as it is. It holds here for the same reason it holds
# there — the page fetches nothing itself, the plugin does — and it is doing its
# job: an inline script in this page is refused.
sed -e 's|<meta charset="UTF-8">|<meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">|' \
    -e 's|<link rel="stylesheet" href="chooser.css">|<link rel="stylesheet" href="chooser.css">\n    <link rel="stylesheet" href="mobile.css">|' \
    -e 's|<script src="chooser.js"></script>|<script src="app.js"></script>\n    <script src="chooser.js"></script>|' \
    "$CHOOSER/index.html" > www/index.html

for needle in 'name="viewport"' 'src="app.js"' 'href="mobile.css"' 'src="chooser.js"'; do
    if ! grep -q "$needle" www/index.html; then
        echo "error: staging the chooser page did not produce $needle." >&2
        echo "  clients/electron/chooser/index.html has changed shape; fix the sed above." >&2
        exit 1
    fi
done

cp mobile.css www/mobile.css

# The chooser's map, and its flags. Leaflet, the day/night terminator and the
# flags-only Twemoji subset, copied from the files the server already serves for
# v1 rather than vendored a second time — the web UI loads exactly these, so the
# directory here draws what a browser draws.
#
# The font is not decoration: a directory row's country is a pair of regional
# indicators, and the @font-face in chooser.css points at this file.
mkdir -p www/vendor
cp "$STATIC/leaflet.js" "$STATIC/leaflet.css" "$STATIC/L.Terminator.js" \
   "$STATIC/fonts/twemoji-flags.woff2" www/vendor/ \
    || echo "warning: could not stage leaflet/flags — the chooser's map will be unavailable" >&2

# The mark in the chooser's header, beside the page that asks for it. Same
# source as the launcher icon below, and downscaled for the same reason: the
# slot is 26 px and the file is 1024 square.
if command -v convert >/dev/null 2>&1; then
    convert "$ICON_SRC" -resize 64x64 www/icon.png || cp "$ICON_SRC" www/icon.png
else
    cp "$ICON_SRC" www/icon.png
fi

# ---- the launcher icon ------------------------------------------------------

# The desktop client's icon, at the sizes Android wants, generated rather than
# committed: it is the same mark, and a second copy of it in this directory is a
# second thing to keep current. clients/electron/assets/icon.png is 1024 square,
# which is above every size below.
#
# Three sets, because Android asks for the icon three ways:
#
#   ic_launcher            the legacy square, for API 23-25 (this app's minSdk
#                          is 23, and adaptive icons arrived in 26)
#   ic_launcher_round      the same, circle-masked, for launchers that ask for
#                          the round variant
#   ic_launcher_foreground the adaptive icon's foreground layer, which is 108 dp
#                          of canvas with only the middle 72 dp guaranteed
#                          visible — the rest is what the launcher crops into
#                          whatever shape it likes. So the mark is drawn at two
#                          thirds and centred, and the background is the app's
#                          own dark (values/ic_launcher_background.xml) rather
#                          than the white Capacitor generates.
if [[ -f "$ICON_SRC" ]] && command -v convert >/dev/null 2>&1; then
    # density:launcher px:adaptive canvas px
    for spec in mdpi:48:108 hdpi:72:162 xhdpi:96:216 xxhdpi:144:324 xxxhdpi:192:432; do
        density="${spec%%:*}"
        rest="${spec#*:}"
        square="${rest%%:*}"
        canvas="${rest##*:}"
        dir="android/app/src/main/res/mipmap-${density}"
        mkdir -p "$dir"

        convert "$ICON_SRC" -resize "${square}x${square}" "$dir/ic_launcher.png"
        # The round variant, masked rather than merely named: a launcher that
        # asks for it and gets a square draws a square.
        convert "$ICON_SRC" -resize "${square}x${square}" \
            \( +clone -alpha extract -fill black -colorize 100 \
               -fill white -draw "circle $((square/2)),$((square/2)) $((square/2)),0" -alpha off \) \
            -compose CopyOpacity -composite "$dir/ic_launcher_round.png"
        # Two thirds of the canvas, centred, transparent around it.
        inner=$(( canvas * 2 / 3 ))
        convert "$ICON_SRC" -resize "${inner}x${inner}" \
            -background none -gravity center -extent "${canvas}x${canvas}" \
            "$dir/ic_launcher_foreground.png"
    done

    # The background layer, and the one thing about this that is not obvious.
    #
    # It is the *artwork's own tile colour*, not the app's dark background. The
    # foreground above is the whole mark — a blue rounded tile with a black mast
    # on it — so if the layer behind it is a different colour, the launcher's
    # mask cuts a circle out of that colour and the blue tile sits inside it as a
    # square with its corners clipped: the icon comes out as a polygon in a
    # ring, and reads as a hexagon among a screen of circles.
    #
    # Matched, the tile's edge disappears into the background and what is left is
    # the mast on a full circle of blue — which then survives any mask the
    # launcher applies, round, squircle or otherwise.
    #
    # Re-sample it if the artwork changes:
    #   convert assets/icon.png -format '%[pixel:p{120,512}]' info:
    cat > android/app/src/main/res/values/ic_launcher_background.xml <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0097F5</color>
</resources>
XML

    # Capacitor's placeholder foreground, which would otherwise win over the
    # PNGs on API 24 and up by being the more specific resource.
    rm -f android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml
    echo "staged the launcher icon from $ICON_SRC"
else
    echo "warning: no icon staged (need $ICON_SRC and ImageMagick) — the app will" >&2
    echo "         carry Capacitor's default launcher icon" >&2
fi

# ---- window.ubersdr ---------------------------------------------------------

if ! command -v esbuild >/dev/null 2>&1; then
    echo "esbuild not found — apt-get install esbuild, or npm i -g esbuild" >&2
    exit 1
fi

BUILD_INFO="$(cat www/BUILD_INFO 2>/dev/null | tr -d '\n' || true)"
esbuild src/main.js \
    --bundle \
    --format=iife \
    --target=es2020 \
    --define:__BUILD_INFO__="\"${BUILD_INFO}\"" \
    --log-level=warning \
    --outfile=www/app.js

echo "bundled window.ubersdr into www/app.js"

# The receiver page's end of things, bundled with the v2 page API's own client
# library (static/v2/src/bridge/client.js) exactly as the desktop client bundles
# it into its receiver preload. A document-start script cannot import anything
# at run time, so the client has to travel with it — and using the shared client
# rather than hand-rolling the protocol is what keeps this a client of a
# versioned contract instead of a private arrangement with one build of the UI.
esbuild src/receiver.js \
    --bundle \
    --format=iife \
    --target=es2020 \
    --log-level=warning \
    --outfile=www/receiver-bridge.js

echo "bundled the receiver bridge into www/receiver-bridge.js"

# ---- the native project -----------------------------------------------------

# Where the SDK is, for Gradle. Written rather than assumed: the file is
# machine-local and git-ignored, and a checkout without it fails inside a
# toolchain rather than here.
if [[ ! -f android/local.properties ]]; then
    printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties
fi

npx cap sync android

if [[ "$APK" -eq 0 ]]; then
    echo
    echo "staged. To build an APK:  ./build.sh --apk"
    exit 0
fi

# A JDK 21, with a compiler in it.
#
# Capacitor's own Android module is built at source and target 21
# (node_modules/@capacitor/android/capacitor/build.gradle), so Gradle needs a
# toolchain that can compile it — and Gradle's default toolchain is whatever JVM
# it is itself running on. Checked here because the failure otherwise arrives
# several minutes in, from inside Gradle, as a message about "required
# capabilities: [JAVA_COMPILER]" that does not obviously mean "you have a JRE".
#
# A JRE 21 is a common thing to have and is not enough. Android Studio ships a
# JDK 21 of its own (jbr/) and setting JAVA_HOME to it works as well as a
# system one.
find_jdk21() {
    local candidate
    for candidate in "${JAVA_HOME:-}" /usr/lib/jvm/java-21-openjdk-* /usr/lib/jvm/jdk-21* \
                     "$HOME/android-studio/jbr" /opt/android-studio/jbr; do
        [[ -n "$candidate" && -x "$candidate/bin/javac" ]] || continue
        if "$candidate/bin/javac" -version 2>&1 | grep -q ' 21\.'; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

if ! JDK21="$(find_jdk21)"; then
    echo "error: no JDK 21 found — Capacitor's Android module compiles at Java 21." >&2
    echo >&2
    if command -v javac >/dev/null 2>&1; then
        echo "  Found a compiler, but not a 21 one: $(javac -version 2>&1)" >&2
    else
        echo "  There is a java on PATH but no javac, which means a JRE rather than a JDK." >&2
    fi
    echo >&2
    echo "  On Debian/Ubuntu:  sudo apt install openjdk-21-jdk" >&2
    echo "  Or point JAVA_HOME at one you already have (Android Studio ships one in jbr/)." >&2
    exit 1
fi
export JAVA_HOME="$JDK21"

if [[ "$RELEASE" -eq 1 ]]; then
    android_signing_report
    (cd android && ./gradlew --console=plain assembleRelease)
    # Gradle names it for what it is, and what it is depends on the signing
    # config being there.
    OUT=android/app/build/outputs/apk/release/app-release.apk
    [[ -f "$OUT" ]] || OUT=android/app/build/outputs/apk/release/app-release-unsigned.apk
else
    (cd android && ./gradlew --console=plain assembleDebug)
    OUT=android/app/build/outputs/apk/debug/app-debug.apk
fi

if [[ ! -f "$OUT" ]]; then
    echo "error: gradle reported success but no APK is in $(dirname "$OUT")." >&2
    exit 1
fi

# Copied to the name the download link uses, beside the desktop client's dist/.
# The Gradle output keeps its own name; this is the one that gets published.
mkdir -p dist
cp "$OUT" "$ARTIFACT"

echo
echo "built $ARTIFACT ($(du -h "$ARTIFACT" | cut -f1)) from $OUT"

if [[ "$INSTALL" -eq 1 ]]; then
    ADB="$ANDROID_HOME/platform-tools/adb"
    command -v adb >/dev/null 2>&1 && ADB=adb
    if ! "$ADB" get-state >/dev/null 2>&1; then
        echo "not installed: no device or emulator is attached (adb devices)." >&2
        exit 1
    fi
    "$ADB" install -r "$ARTIFACT"
    echo "installed on $("$ADB" shell getprop ro.product.model | tr -d '\r')"
fi

if [[ "$PUBLISH" -eq 1 ]]; then
    publish_release
fi
