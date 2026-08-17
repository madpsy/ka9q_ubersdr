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
#   ./build.sh --stage-ui   build and stage everything www/ serves, and stop
#   ./build.sh --apk        the above, then assemble a debug APK
#   ./build.sh --release    assemble a release APK instead (signed if the
#                           credentials are in the environment — see below), and
#                           the .aab beside it, which is what Play takes
#   ./build.sh --install    assemble the debug APK and adb-install it: the phone
#                           on USB if there is one, otherwise the usual one over
#                           Wi-Fi (UBERSDR_PHONE, default 192.168.9.93). An
#                           emulator is never chosen on its own — name it with
#                           --install=<serial> if that is what you want.
#   ./build.sh --install=192.168.1.50
#                           ...on a phone over Wi-Fi: connects to it first
#                           (port 5555 unless one is given) and installs there.
#                           A serial from `adb devices` works in the same place.
#                           Combine with --release to install that instead.
#   ./build.sh --yes        answer the publish prompt in advance, for a run with
#                           no terminal to ask on. Only meaningful with --publish.
#   ./build.sh --publish    release-build, then upload it to the `latest`
#                           release on GitHub with the gh CLI, replacing what is
#                           there. Asks first, and only from a terminal.
#                           Implies --release.
#   ./build.sh --screenshots
#                           build a debug APK, then capture the Play Store set
#                           into screenshots/: a 7-inch and a 10-inch tablet,
#                           each in both orientations, each showing the chooser
#                           and a running receiver. Four per device, over the
#                           same filenames every time. The iOS half has the
#                           same option — see build-mac.sh --screenshots.
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

# The app bundle, which every release also produces. Play has refused APK
# uploads for new apps since 2021 and takes only this, so it is built alongside
# rather than behind a flag somebody has to remember on the one day it matters.
#
# It is deliberately *not* published to GitHub. An .aab is not installable — it
# is a container Play's servers split into per-device APKs — so putting one on a
# release page is handing a sideloader a file that cannot be opened. Only
# $ARTIFACT is uploaded; see publish_release.
#
# Worth knowing before the first Play upload: Play re-signs what it delivers.
# The keystore below becomes the *upload* key and a separate app signing key
# signs the installed APK, which means a Play install and this .apk have
# different signatures and cannot replace one another — an in-place update
# becomes an uninstall, taking the saved receivers with it. Uploading this
# keystore as the app signing key when the listing is first created is what
# keeps the two interchangeable, and it cannot be changed afterwards.
BUNDLE=dist/UberSDR.aab

V2=../../static/v2
STATIC=../../static
CHOOSER=../electron/chooser
# The desktop client's icon, which is the app's: the launcher icon and the mark
# in the chooser's header are both generated from it.
ICON_SRC=../electron/assets/icon.png

SKIP_UI=0
# The publish confirmation, given in advance — see publish_release.
ASSUME_YES=0
# Build the web assets and stop. What build-mac.sh calls, so an iOS build ships
# the interface it was just built with rather than whatever an Android build
# staged last: www/ holds v2, the chooser and the receiver bridge, it is what
# both platforms serve, and only this script fills it. Without this the two
# apps can differ by however long it has been since anyone built the APK, which
# is a hard difference to explain from the outside.
STAGE_ONLY=0
SHOTS=0
APK=0
RELEASE=0
INSTALL=0
DEVICE=""
CLEAN=0
PUBLISH=0

for arg in "$@"; do
    case "$arg" in
        --skip-ui) SKIP_UI=1 ;;
        --stage-ui) STAGE_ONLY=1 ;;
        --apk) APK=1 ;;
        --release) APK=1; RELEASE=1 ;;
        --install) APK=1; INSTALL=1 ;;
        --install=*) APK=1; INSTALL=1; DEVICE="${arg#--install=}" ;;
        --publish) APK=1; RELEASE=1; PUBLISH=1 ;;
        --yes) ASSUME_YES=1 ;;
        --clean) CLEAN=1 ;;
        --screenshots) APK=1; SHOTS=1 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

# Where the release key lives when nobody has said otherwise.
#
# The environment still wins, and CI still sets it — this is the fallback for
# the machine the releases actually come from, where exporting four variables
# before every build was a step to forget, and forgetting it produced an APK
# that looks built and cannot be installed by anyone.
#
# The password is read from a file beside the keystore rather than from the
# environment, because a value in the environment is in every child process's
# /proc entry and, sooner or later, in a shell history. A file read here and
# exported only for gradle is not much better, but it is not written down twice.
#
# Both are exported rather than passed along: gradle is a child process and
# android/app/build.gradle reads UBERSDR_* from the environment, which is the
# interface these have always had.
KEYS_DIR="${UBERSDR_KEYS_DIR:-$HOME/keys}"
DEFAULT_KEYSTORE="$KEYS_DIR/ubersdr-release.jks"

# Which of the two it was, for the report — "signed" is not the whole answer
# when the interesting question is "with which key".
KEYSTORE_FROM="UBERSDR_KEYSTORE"

# Every exit from this is an explicit `return 0`, and that is not style.
# The script runs under `set -e`, this is called bare, and a function whose last
# command is a failed test returns that failure — so `return` on its own after
# `[[ -f … ]]` would end the build, with no message, on every machine that does
# not have a keystore in $KEYS_DIR. Which is all of them but this one.
adopt_default_keystore() {
    [[ -n "${UBERSDR_KEYSTORE:-}" ]] && return 0
    [[ -f "$DEFAULT_KEYSTORE" ]] || return 0
    export UBERSDR_KEYSTORE="$DEFAULT_KEYSTORE"
    KEYSTORE_FROM="found in $KEYS_DIR"

    # `<keystore>.password`, one line, no name and no quoting: the file is the
    # value. $(<file) drops the trailing newline every editor adds, which would
    # otherwise be part of the password and fail the build with "keystore
    # password was incorrect" and nothing to see wrong.
    if [[ -z "${UBERSDR_KEYSTORE_PASSWORD:-}" ]]; then
        local pw_file="${DEFAULT_KEYSTORE%.jks}.password"
        if [[ -f "$pw_file" ]]; then
            export UBERSDR_KEYSTORE_PASSWORD="$(<"$pw_file")"
        fi
    fi
    return 0
}

# Run now, before anything reads the environment: the signing report, gradle and
# the publish check all have to see the same answer. A no-op when there is
# nothing in $KEYS_DIR, which is every machine but this one.
adopt_default_keystore

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
            echo "    keystore       ${UBERSDR_KEYSTORE} (${KEYSTORE_FROM})"
            echo "    alias          ${UBERSDR_KEY_ALIAS:-ubersdr}"
            if [[ -z "${UBERSDR_KEYSTORE_PASSWORD:-}" ]]; then
                echo "    password       not set — the build will fail"
                echo "                   set UBERSDR_KEYSTORE_PASSWORD, or put it in"
                echo "                   ${UBERSDR_KEYSTORE%.jks}.password"
            fi
        else
            echo "    keystore       ${UBERSDR_KEYSTORE} — not there"
        fi
    else
        echo "    keystore       none (UBERSDR_KEYSTORE is not set, and there is"
        echo "                   no $DEFAULT_KEYSTORE)"
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

    local reply=''
    # Asked for, one way or the other — the same rule the desktop client's
    # build.sh follows, and worth keeping identical between the two.
    #
    # The prompt is the default and stays that way: publishing moves the tag
    # every download link points at, and a run that reaches this point by
    # accident must not be able to complete it. `--yes` changes only *when* the
    # answer was given — on the command line rather than at the prompt, which is
    # the same person saying the same thing.
    if [[ "$ASSUME_YES" -eq 1 ]]; then
        echo "  --yes given; uploading."
        reply=yes
    elif [[ ! -t 0 ]]; then
        echo "not published: --publish asks before uploading and there is no terminal to ask on." >&2
        echo "  Pass --yes to answer it in advance." >&2
        return
    fi
    if [[ -z "$reply" ]]; then
        read -r -p "  type 'yes' to upload: " reply || true
    fi
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

# ---- the Play Store screenshot set ------------------------------------------
#
# Two tablet AVDs, two orientations, two screens each.
#
# Play asks for 7-inch and 10-inch tablet screenshots separately, and a phone
# screenshot upscaled will not do: a tablet does not match MOBILE_QUERY in
# LayoutContext.jsx, so it draws the docked layout rather than the phone one.
# These AVDs exist to produce exactly that, and are written here if they are
# missing so this works on a machine that has never run it.
#
# Every shot is a real run against a real receiver — the connected ones follow
# an `ubersdr://` link the way a tapped one is followed — so what is captured is
# the app working rather than a mock of it. The iOS half has the same option and
# is meant to produce the same pictures; see build-mac.sh --screenshots.
SHOT_DEVICES=(
    "7in:UberSDR_Tablet_7:1200:1920:320"
    "10in:UberSDR_Tablet_10:2560:1600:320"
)
SHOT_RECEIVER="${UBERSDR_SHOT_UUID:-4907ba0a-32e6-40bb-a4ca-47f823331728}"

# The phone a bare --install lands on when there is none on USB. An address
# rather than a serial: over Wi-Fi the serial *is* the address, and this one
# does not change. Override with UBERSDR_PHONE for a different handset.
PHONE_DEFAULT="${UBERSDR_PHONE:-192.168.9.93}"
SHOT_DIR=screenshots

# An AVD with the given geometry, if there is not one already.
#
# Written by hand rather than with avdmanager, which lives in cmdline-tools and
# is not always installed: an AVD is two text files, and the emulator builds the
# data partition itself on first boot.
ensure_avd() {
    local name="$1" w="$2" h="$3" density="$4"
    local avd_home="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
    [[ -f "$avd_home/$name.ini" ]] && return 0

    local image
    image="$(ls -d "$ANDROID_HOME"/system-images/android-*/*/* 2>/dev/null | head -1)"
    if [[ -z "$image" ]]; then
        echo "no system image installed — cannot create $name." >&2
        echo "  Install one with the SDK manager, or open Android Studio once." >&2
        return 1
    fi
    local rel="${image#$ANDROID_HOME/}"
    local api_dir tag_dir abi
    abi="$(basename "$image")"
    tag_dir="$(basename "$(dirname "$image")")"
    api_dir="$(basename "$(dirname "$(dirname "$image")")")"

    echo "  creating AVD $name (${w}x${h} @ ${density}dpi)"
    mkdir -p "$avd_home/$name.avd"
    cat > "$avd_home/$name.ini" <<EOF
avd.ini.encoding=UTF-8
path=$avd_home/$name.avd
path.rel=avd/$name.avd
target=$api_dir
EOF
    cat > "$avd_home/$name.avd/config.ini" <<EOF
AvdId = $name
PlayStore.enabled = false
abi.type = $abi
avd.ini.displayname = $name
avd.ini.encoding = UTF-8
disk.dataPartition.size = 6442450944
hw.accelerometer = yes
hw.audioInput = yes
hw.battery = yes
hw.camera.back = none
hw.camera.front = none
hw.cpu.arch = x86_64
hw.cpu.ncore = 4
hw.gpu.enabled = yes
hw.gpu.mode = auto
hw.keyboard = yes
hw.lcd.density = $density
hw.lcd.height = $h
hw.lcd.width = $w
hw.mainKeys = no
hw.ramSize = 3072
hw.sdCard = no
image.sysdir.1 = $rel/
skin.name = ${w}x${h}
skin.path = ${w}x${h}
snapshot.present = no
tag.id = $tag_dir
vm.heapSize = 512
EOF
}

# A clean status bar: a fixed clock, a full battery, full wifi, nothing else.
# The alternative is a listing dated by whatever the clock said, with somebody's
# notification icons across the top of every picture.
demo_status_bar() {
    local serial="$1"
    "$ADB" -s "$serial" shell settings put global sysui_demo_allowed 1 >/dev/null
    local cmds=(
        "command enter"
        "command clock -e hhmm 1000"
        "command battery -e level 100 -e plugged false"
        "command network -e wifi show -e level 4"
        "command network -e mobile hide"
        "command notifications -e visible false"
    )
    local c
    for c in "${cmds[@]}"; do
        # shellcheck disable=SC2086
        "$ADB" -s "$serial" shell am broadcast -a com.android.systemui.demo -e $c >/dev/null
    done
}

take_screenshots() {
    ADB="$ANDROID_HOME/platform-tools/adb"
    command -v adb >/dev/null 2>&1 && ADB=adb
    local emulator="$ANDROID_HOME/emulator/emulator"
    mkdir -p "$SHOT_DIR"

    local entry
    for entry in "${SHOT_DEVICES[@]}"; do
        local label avd w h density
        IFS=: read -r label avd w h density <<< "$entry"
        ensure_avd "$avd" "$w" "$h" "$density" || continue

        echo
        echo "  $avd"
        # A fresh boot with -wipe-data: the chooser opens on the Saved tab the
        # moment anything is saved, and these are meant to show the directory
        # the app exists to offer.
        nohup "$emulator" -avd "$avd" -no-snapshot -wipe-data -no-boot-anim \
            > "/tmp/ubersdr-emu-$label.log" 2>&1 &

        # Which serial it came up on, asked rather than assumed: a phone on
        # Wi-Fi debugging is very often attached too, and installing a debug
        # build over somebody's actual phone would be a rude surprise.
        local serial=""
        local _i
        for _i in $(seq 1 90); do
            serial="$("$ADB" devices | awk '/^emulator-/ {print $1}' | tail -1)"
            [[ -n "$serial" ]] && break
            sleep 2
        done
        if [[ -z "$serial" ]]; then
            echo "  $avd never appeared in adb — see /tmp/ubersdr-emu-$label.log" >&2
            continue
        fi
        until [[ "$("$ADB" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do
            sleep 3
        done

        demo_status_bar "$serial"
        "$ADB" -s "$serial" install -r "$ARTIFACT" >/dev/null
        # The tidy hook: hides the stats readout, which prints the operator's
        # public IP over the waterfall, and collapses the Multipad in landscape.
        # See ReceiverActivity.tidyForScreenshot.
        "$ADB" -s "$serial" shell settings put global ubersdr_shot 1 >/dev/null
        "$ADB" -s "$serial" shell settings put system accelerometer_rotation 0 >/dev/null
        # Granted rather than prompted for. ReceiverActivity asks for
        # POST_NOTIFICATIONS when audio starts, and the system dialog lands over
        # the waterfall in every connected screenshot otherwise.
        "$ADB" -s "$serial" shell pm grant org.ubersdr.mobile \
            android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true

        local orientation screen
        for orientation in portrait landscape; do
            # Rotation 0 is the AVD's natural orientation, which is portrait on
            # the 7-inch and landscape on the 10-inch — so it is worked out from
            # the geometry rather than assumed.
            local rotation=0
            if [[ "$w" -lt "$h" && "$orientation" == "landscape" ]] \
               || [[ "$w" -gt "$h" && "$orientation" == "portrait" ]]; then
                rotation=1
            fi
            # Both spellings, because neither is reliable alone on a current
            # Android: `settings put user_rotation` is the old one and is
            # ignored by newer window managers unless rotation is locked, and
            # `cmd window set-user-rotation` is the one that actually turns the
            # display. Setting only the first produced four portrait pictures
            # and no error.
            "$ADB" -s "$serial" shell settings put system user_rotation "$rotation" >/dev/null
            "$ADB" -s "$serial" shell cmd window set-user-rotation lock "$rotation" >/dev/null 2>&1 || true
            sleep 3

            for screen in chooser connected; do
                "$ADB" -s "$serial" shell am force-stop org.ubersdr.mobile >/dev/null
                if [[ "$screen" == "chooser" ]]; then
                    # Forget everything: a saved receiver opens the Saved tab.
                    "$ADB" -s "$serial" shell pm clear org.ubersdr.mobile >/dev/null
                    "$ADB" -s "$serial" shell settings put global ubersdr_shot 1 >/dev/null
                    # pm clear revokes runtime permissions with everything else.
                    "$ADB" -s "$serial" shell pm grant org.ubersdr.mobile \
                        android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
                    "$ADB" -s "$serial" shell monkey -p org.ubersdr.mobile \
                        -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
                    sleep 12
                else
                    "$ADB" -s "$serial" shell am start -a android.intent.action.VIEW \
                        -d "ubersdr://connect?uuid=$SHOT_RECEIVER" >/dev/null
                    # Two minutes, which is what it takes for the waterfall to
                    # fill top to bottom. It is a long time to wait for a
                    # picture and it is the picture: a half-drawn waterfall with
                    # a band of empty black under it is what the screenshot is
                    # not meant to show.
                    sleep 120
                fi

                local file="$SHOT_DIR/android-$label-$orientation-$screen.png"
                "$ADB" -s "$serial" exec-out screencap -p > "$file"
                echo "    $file  ($(identify -format '%wx%h' "$file" 2>/dev/null || echo '?'))"
            done
        done

        # Stopped rather than left running: an emulator left playing is a
        # receiver still holding a slot on somebody's radio.
        "$ADB" -s "$serial" shell am force-stop org.ubersdr.mobile >/dev/null
        "$ADB" -s "$serial" emu kill >/dev/null 2>&1 || true
        sleep 3
    done
}

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

# Everything the app serves out of www/ now exists, which is where --stage-ui
# stops. It has to be here and not after the v2 staging above: the bridge is
# half of any change that spans the page and its host, and stopping before it
# would ship the two halves from different days.
[[ "$STAGE_ONLY" -eq 1 ]] && exit 0

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

AAB_OUT=""
if [[ "$RELEASE" -eq 1 ]]; then
    android_signing_report
    # One invocation for both. The two tasks share everything up to packaging,
    # so asking for them together costs a fraction of what a second gradle run
    # would, and there is no release worth building only half of.
    (cd android && ./gradlew --console=plain assembleRelease bundleRelease)
    # Gradle names it for what it is, and what it is depends on the signing
    # config being there.
    OUT=android/app/build/outputs/apk/release/app-release.apk
    [[ -f "$OUT" ]] || OUT=android/app/build/outputs/apk/release/app-release-unsigned.apk
    # The bundle has no unsigned spelling of its name: signed or not, it is
    # app-release.aab. Whether it is signed is the signing report's business.
    AAB_OUT=android/app/build/outputs/bundle/release/app-release.aab
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

# The bundle, beside it and under the same fixed name. A missing one is reported
# rather than fatal: the APK is built by then and is the artefact everything
# else in this script acts on, so a Play format that did not appear should not
# take an install or a publish down with it.
if [[ -n "$AAB_OUT" ]]; then
    if [[ -f "$AAB_OUT" ]]; then
        cp "$AAB_OUT" "$BUNDLE"
        echo "built $BUNDLE ($(du -h "$BUNDLE" | cut -f1)) — upload this one to Play, not the APK"
    else
        echo "warning: gradle reported success but no bundle is in $(dirname "$AAB_OUT")." >&2
        echo "         The APK is fine; only the Play upload format is missing." >&2
    fi
fi

if [[ "$SHOTS" -eq 1 ]]; then
    take_screenshots
    exit 0
fi

if [[ "$INSTALL" -eq 1 ]]; then
    ADB="$ANDROID_HOME/platform-tools/adb"
    command -v adb >/dev/null 2>&1 && ADB=adb

    # The wireless debugging port, asked of the phone rather than assumed.
    #
    # There are two wireless modes and they are not the same thing. `adb tcpip
    # 5555` opens a fixed port and is what PHONE_DEFAULT assumes; Android 11's
    # Wireless debugging panel allocates a *random* one instead, changes it
    # every time the toggle is turned off and on, and never uses 5555. On a
    # phone using the panel, a fixed default is wrong the first time and stays
    # wrong — which is how this was found.
    #
    # Both modes advertise over mDNS, so the port is discoverable: the device
    # publishes `_adb-tls-connect._tcp`, and adb has known how to list what it
    # has seen since platform-tools 30. `_adb-tls-pairing._tcp` is the other
    # service and is deliberately not matched — that one is the six-digit
    # pairing code's port, which is useless without the code and is not where a
    # paired host connects.
    #
    # An argument selects among several: the address to prefer when more than
    # one device is advertising, which is the case whenever a screenshot
    # emulator is up. Empty takes the first, since with one phone there is one.
    # Never fails, deliberately. This script runs under `set -euo pipefail`, so a
    # pipeline whose adb cannot reach its server would take the whole build down
    # — and "mDNS told us nothing" is an ordinary answer here, not an error: it
    # is what a phone that is simply switched off looks like. Empty output is
    # the way it says so.
    mdns_endpoint() {
        local want="${1%%:*}"
        "$ADB" mdns services 2>/dev/null | awk -v want="$want" '
            $2 == "_adb-tls-connect._tcp" && $3 ~ /:[0-9]+$/ {
                split($3, a, ":")
                if (want == "" || a[1] == want) { print $3; exit }
            }' || true
        return 0
    }

    # Where to install, when nothing was named.
    #
    # adb's own rule is "the one device attached", which stops working the
    # moment a screenshot emulator is booted — and this repo boots them. So a
    # bare --install picks the *physical* device: an emulator is where the store
    # screenshots are taken, a phone is where a build is tried.
    #
    # With no phone on USB it falls back to the one on Wi-Fi, which is how this
    # phone is usually reached. A cable re-enumerates the device every time the
    # screen locks and each re-enumeration needs its permissions again, so
    # wireless is the normal way in rather than the exception. Override the
    # address with UBERSDR_PHONE, or name anything else with --install=.
    #
    # Asked before assumed: mDNS knows the port a phone is actually listening
    # on, and PHONE_DEFAULT is only a guess at it — right for `adb tcpip 5555`
    # and never right for Android 11's Wireless debugging. The guess is still
    # the fallback, for a phone that is switched on but not advertising.
    if [[ -z "$DEVICE" ]]; then
        physical="$("$ADB" devices | awk '$2 == "device" && $1 !~ /^emulator-/ { print $1 }')"
        if [[ "$(wc -l <<< "$physical")" -eq 1 && -n "$physical" ]]; then
            DEVICE="$physical"
            echo "  installing to $DEVICE"
        else
            found="$(mdns_endpoint "$PHONE_DEFAULT")"
            # Nothing at that address, but something is out there: take it. The
            # phone's address changes on a DHCP lease as readily as its port
            # changes on a toggle, and both are the same question — where is it.
            [[ -n "$found" ]] || found="$(mdns_endpoint "")"
            if [[ -n "$found" ]]; then
                DEVICE="$found"
                echo "  no phone on USB — found $DEVICE over mDNS"
            else
                DEVICE="$PHONE_DEFAULT"
                echo "  no phone on USB and none advertising — trying $DEVICE over Wi-Fi"
            fi
        fi
    fi

    TARGET=()
    if [[ -n "$DEVICE" ]]; then
        # An address is something to connect to first; anything else is taken as
        # a serial adb already knows. Wi-Fi is worth the special case because it
        # is how a phone is usually reached here — a USB cable re-enumerates the
        # device every time the screen locks, and each re-enumeration is a new
        # node that needs its permissions again.
        if [[ "$DEVICE" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(:[0-9]+)?$ ]]; then
            # An address with no port is a question rather than an answer: ask
            # mDNS what this phone is listening on before falling back to the
            # `adb tcpip` port. A port that was given is used as given — somebody
            # naming one knows something this does not.
            if [[ "$DEVICE" != *:* ]]; then
                found="$(mdns_endpoint "$DEVICE")"
                DEVICE="${found:-$DEVICE:5555}"
            fi
            echo "connecting to $DEVICE…"
            if ! "$ADB" connect "$DEVICE" | grep -qE "connected to"; then
                echo "not installed: could not reach $DEVICE." >&2
                echo >&2
                echo "  Wireless debugging has two modes and only one uses a fixed port:" >&2
                echo "    adb tcpip 5555        opens 5555, and needs one USB connection first." >&2
                echo "    Wireless debugging    Android 11's panel: a random port, re-rolled" >&2
                echo "                          every time the toggle is turned off and on, and" >&2
                echo "                          a pairing code the first time. Once paired, this" >&2
                echo "                          script finds the port itself over mDNS." >&2
                echo >&2
                echo "  What is advertising now:" >&2
                "$ADB" mdns services 2>/dev/null | sed 's/^/    /' >&2
                exit 1
            fi
        fi
        TARGET=(-s "$DEVICE")
    fi

    if ! "$ADB" "${TARGET[@]}" get-state >/dev/null 2>&1; then
        echo "not installed: no device is attached, or more than one is and none was named." >&2
        echo >&2
        "$ADB" devices | sed 's/^/  /' >&2
        echo "  Name one with --install=<ip> or --install=<serial>." >&2
        exit 1
    fi

    # Not `install -r` alone, because the failure it hides is the one that
    # actually happens: a release APK will not replace a debug one, or vice
    # versa, since Android identifies an app by its signature. There is no way
    # round it but to uninstall, which takes the saved receivers, the shared
    # settings and any saved passwords with it — so this says so rather than
    # doing it.
    if ! "$ADB" "${TARGET[@]}" install -r "$ARTIFACT" 2>&1 | tee /dev/stderr | grep -q "^Success"; then
        echo >&2
        echo "  If that says INSTALL_FAILED_UPDATE_INCOMPATIBLE, the APK on the" >&2
        echo "  device was signed with a different key — a debug build where this" >&2
        echo "  is a release one, most likely. Installing this one means:" >&2
        echo >&2
        echo "      adb ${TARGET[*]} uninstall org.ubersdr.mobile" >&2
        echo >&2
        echo "  which erases that app's saved receivers, shared settings and" >&2
        echo "  saved passwords. Build the other kind instead to keep them." >&2
        exit 1
    fi
    echo "installed on $("$ADB" "${TARGET[@]}" shell getprop ro.product.model | tr -d '\r')"
fi

if [[ "$PUBLISH" -eq 1 ]]; then
    publish_release
fi
