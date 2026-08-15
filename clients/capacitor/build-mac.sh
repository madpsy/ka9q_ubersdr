#!/usr/bin/env bash
# build-mac.sh — build the iOS client on a Mac over SSH, from a Linux box.
#
# The iOS half of this client is developed here and compiled there. That split
# is not a compromise: `npx cap add ios` and `cap sync ios` run perfectly well
# on Linux, because an Xcode project is text and PNGs — project.pbxproj,
# Info.plist, AppDelegate.swift, the Podfile, the asset catalogs. The CLI skips
# `pod install` and `xcodebuild` with warnings rather than failing. So
# everything except the compiler can be authored on this machine, and the Mac
# does the two things only it can do.
#
# What this makes possible, proven end to end before it was written: build,
# install on a simulator, launch, and screenshot — without touching the Mac.
# The App Store screenshots come back the same way the Play ones do from an
# emulator (see the Android half's own capture recipe).
#
# Usage:
#   ./build-mac.sh --check     preflight only: is the Mac able to build at all?
#   ./build-mac.sh --test      preflight, then build a throwaway Capacitor app
#                              on the Mac, run it in a simulator and screenshot
#                              it. Proves the whole chain without needing this
#                              client's ios/ platform to exist yet.
#   ./build-mac.sh             ship ios/ and build it (once ios/ exists)
#   ./build-mac.sh --run       ...and install and launch it on a simulator
#   ./build-mac.sh --bgtest    ...and exercise the native background audio path
#   ./build-mac.sh --shot=FILE ...and bring a screenshot back here
#   ./build-mac.sh --release   build for a device rather than the simulator
#                              (needs signing — see Requirements)
#   ./build-mac.sh --device    build for a connected iPhone or iPad, sign it and
#                              install it. Everything the App Store needs is a
#                              step beyond this; everything a *test* needs is
#                              this. Add --launch to start it afterwards.
#   ./build-mac.sh --upload    ...and send it to App Store Connect, for
#                              TestFlight or a review submission. Uses the same
#                              Apple ID and app-specific password the desktop
#                              client notarises with ($APPLE_PASSWORD_FILE).
#   ./build-mac.sh --archive   archive and export dist/UberSDR.ipa, signed for
#                              the App Store. Needs a device registered to the
#                              team once — see Requirements.
#   ./build-mac.sh --screenshots
#                              build, then capture the App Store set into
#                              screenshots/: an iPhone and an iPad, each in both
#                              orientations, each showing the chooser and a
#                              running receiver. Four per device.
#   ./build-mac.sh --keep      leave the remote directory behind afterwards
#
# Environment:
#   MAC_HOST     ssh target                (default: macbook)
#   MAC_DIR      remote build directory    (default: ~/ubersdr-ios)
#   SIM_DEVICE   simulator to run in       (default: iPhone 17 Pro)
#
# ---------------------------------------------------------------------------
# Requirements, and which of them you have to satisfy by hand
# ---------------------------------------------------------------------------
#
# On this machine:
#   * node and npm, for the Capacitor CLI. The Mac needs neither — see below.
#   * ssh access to the Mac with key authentication and no passphrase prompt.
#     Everything here runs with BatchMode=yes, so a password prompt is a
#     failure rather than a question.
#
# On the Mac, and all of it is already in place:
#   * Xcode, full install, not just the Command Line Tools.
#   * The iOS platform *components*, which are a separate download from Xcode
#     itself and the single most confusing thing about this setup:
#     `xcodebuild -showsdks` will happily list "iOS 26.5" while every build
#     fails with "Supported platforms for the buildables in the current scheme
#     is empty". The fix is `xcodebuild -downloadPlatform iOS` — 8.5 GB, no
#     sudo needed. --check tests for this properly, by asking simctl whether
#     any runtime exists rather than trusting the SDK list.
#   * CocoaPods, installed with `brew install cocoapods` so that it brings its
#     own Ruby. Apple's system Ruby is 2.6 and too old for a current CocoaPods.
#     Capacitor 7's @capacitor/ios ships no Package.swift, so there is no Swift
#     Package Manager route around this.
#   * No node, npm or Capacitor CLI. Deliberately: `cap sync` runs here, and
#     what crosses is the finished tree. node_modules crosses with it, because
#     the Podfile references ../../node_modules/@capacitor/ios by path.
#
# What needs your password, and so cannot be done from here:
#   * `sudo xcode-select -s /Applications/Xcode.app`. Installing Homebrew left
#     the active developer directory pointing at the Command Line Tools, which
#     breaks xcodebuild for everything and everyone on that machine. Every
#     command below works around it by exporting DEVELOPER_DIR, but the
#     underlying setting is still wrong and worth fixing once.
#   * Signing in to Xcode with an Apple ID. Simulator builds need no signing at
#     all, which is why --test works with zero identities installed; a device
#     build or an App Store archive needs one.

set -euo pipefail

cd "$(dirname "$0")"

MAC_HOST="${MAC_HOST:-macbook}"
MAC_DIR="${MAC_DIR:-ubersdr-ios}"
SIM_DEVICE="${SIM_DEVICE:-iPhone 17 Pro}"
# The Apple Developer team that signs a distribution build. Kept here rather
# than only in project.pbxproj so that a fork with its own account changes one
# line and does not have to hunt through an Xcode project to find the other.
TEAM_ID="${UBERSDR_TEAM_ID:-B7CM4Z8JW8}"
# For --upload. The same pair the desktop client's build-mac.sh notarises with,
# deliberately: one Apple ID, one password file, two things that need it.
APPLE_PASSWORD_FILE="${APPLE_PASSWORD_FILE:-$HOME/keys/app.password}"
APPLE_ID_VALUE="${APPLE_ID:-nathan@nsamail.uk}"
# The Mac's login password, read here and sent over stdin, used to unlock its
# keychain before anything signs. Same file and same reasoning as the desktop
# client's build-mac.sh; see mac_signed.
KEYCHAIN_PASSWORD_FILE="${MAC_KEYCHAIN_PASSWORD_FILE:-$HOME/keys/mac-keychain.password}"
# Which device to build for. Empty means "the one that is connected".
DEVICE_ID="${UBERSDR_DEVICE_ID:-}"

# The devices the store set is captured on, as "label:simulator name".
#
# An iPhone and an iPad because App Store Connect asks for both, and these two
# sizes because their screenshots are the ones it accepts for every smaller
# class of device.
SHOT_DEVICES=(
    "iphone:iPhone 17 Pro Max"
    "ipad:iPad Pro 13-inch (M5)"
)
# Which receiver the "connected" screenshots show. A public UUID, followed
# exactly as a link would be — see the DEBUG hook in UberSdrPlugin.
SHOT_RECEIVER="${UBERSDR_SHOT_UUID:-4907ba0a-32e6-40bb-a4ca-47f823331728}"

# The app, as capacitor.config.json names it. Read rather than repeated so that
# a rename cannot leave this script launching something that is not there.
APP_ID="$(node -p "require('./capacitor.config.json').appId" 2>/dev/null || echo org.ubersdr.mobile)"

# Where Xcode really is. Exported into every remote command rather than fixed
# once on the Mac, because fixing it once needs sudo and this does not. See
# Requirements above.
DEVELOPER_DIR_REMOTE=/Applications/Xcode.app/Contents/Developer
# Homebrew's bin, for pod. Not on the PATH of a non-interactive ssh session.
BREW_BIN=/opt/homebrew/bin

CHECK=0
TEST=0
RUN=0
RELEASE=0
ARCHIVE=0
UPLOAD=0
SHOTS=0
DEVICE=0
LAUNCH=0
KEEP=0
SHOT=""
BGTEST=0

for arg in "$@"; do
    case "$arg" in
        --check) CHECK=1 ;;
        --test) TEST=1 ;;
        --run) RUN=1 ;;
        --bgtest) BGTEST=1 ;;
        --release) RELEASE=1 ;;
        --archive) ARCHIVE=1 ;;
        --upload) ARCHIVE=1; UPLOAD=1 ;;
        --screenshots) SHOTS=1 ;;
        --device) DEVICE=1 ;;
        --launch) LAUNCH=1 ;;
        --keep) KEEP=1 ;;
        --shot=*) SHOT="${arg#--shot=}" ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

# ---------------------------------------------------------------------------
# Talking to the Mac
# ---------------------------------------------------------------------------

# One remote command, with the environment every remote command needs.
#
# BatchMode is what turns "ssh is not set up" from a hung prompt into an error,
# which matters because this runs unattended as often as not. The X11 warning is
# dropped because it is not one: the Mac offers forwarding, this has no display,
# and the resulting line on stderr is noise in front of every single command.
mac() {
    ssh -o BatchMode=yes -o ConnectTimeout=15 "$MAC_HOST" \
        "export PATH=$BREW_BIN:\$PATH; export DEVELOPER_DIR=$DEVELOPER_DIR_REMOTE; $*" \
        2> >(grep -v "X11 forwarding request failed" >&2)
}

# Copy a directory tree there, replacing what was there before.
#
# tar over ssh rather than rsync: macOS 26 ships openrsync, whose flags differ
# from the rsync on this box in ways that are not worth discovering at a
# distance. node_modules goes too — the Podfile points into it — but the caches
# and the Android half do not, and neither does anything Gradle built.
ship() {
    local src="$1" dest="$2"
    echo "  shipping $src → $MAC_HOST:~/$dest"
    tar czf - \
        --exclude=./android \
        --exclude=./dist \
        --exclude=./screenshots \
        --exclude=./.git \
        --exclude=./node_modules/.cache \
        -C "$src" . \
    | ssh -o BatchMode=yes "$MAC_HOST" \
        "rm -rf ~/$dest && mkdir -p ~/$dest && cd ~/$dest && tar xzf -" \
        2> >(grep -v "X11 forwarding request failed" >&2)
}

# Run a remote command with the signing key reachable.
#
# Simulator builds need no signing, which is why most of this script uses plain
# `mac`. A *device* build signs the app and every framework inside it, and over
# ssh that fails with `errSecInternalComponent` — a message that mentions
# neither keychains nor locks — unless two things happen first, in the same ssh
# session as the signing:
#
#   * `unlock-keychain`, because a keychain locks on its own and an ssh session
#     cannot answer the dialog that would otherwise ask;
#   * `set-key-partition-list`, because a certificate imported by Xcode does not
#     list codesign in its key's ACL for a non-GUI session. Unlocking alone
#     leaves signing failing exactly as it did before.
#
# A separate unlock does not carry over: each ssh login gets a fresh security
# context. Hence a wrapper rather than a setup step. The password goes over
# stdin, never in a command line that `ps` on the Mac would show.
mac_signed() {
    if [[ ! -f "$KEYCHAIN_PASSWORD_FILE" ]]; then
        mac "$@"
        return
    fi
    printf '%s\n' "$(cat "$KEYCHAIN_PASSWORD_FILE")" \
    | ssh -o BatchMode=yes "$MAC_HOST" "
        export PATH=$BREW_BIN:\$PATH
        export DEVELOPER_DIR=$DEVELOPER_DIR_REMOTE
        IFS= read -r pw || true
        kc=\$HOME/Library/Keychains/login.keychain-db
        security unlock-keychain -p \"\$pw\" \$kc 2>/dev/null || true
        security set-key-partition-list -S apple-tool:,apple:,codesign: \
            -s -k \"\$pw\" \$kc >/dev/null 2>&1 || true
        unset pw
        $*
    " 2> >(grep -v "X11 forwarding request failed" >&2)
}

# The connected device, if one is and nobody named it.
find_device() {
    [[ -n "$DEVICE_ID" ]] && { echo "$DEVICE_ID"; return 0; }
    mac "xcrun devicectl list devices --json-output /tmp/ubersdr-devices.json >/dev/null 2>&1;
         python3 -c \"
import json
try:
    d = json.load(open('/tmp/ubersdr-devices.json'))
except Exception:
    raise SystemExit
for x in d.get('result', {}).get('devices', []):
    if x.get('connectionProperties', {}).get('tunnelState') != 'unavailable':
        print(x['hardwareProperties']['udid'])
        break
\"" 2>/dev/null | head -1
}

# Build for a real device, sign it, and put it on there.
#
# Three things gate this and each hides the next, so all three are named here
# rather than discovered one failed build at a time:
#
#   1. **Developer Mode**, on the device: Settings → Privacy & Security →
#      Developer Mode, then a restart. Absent, xcodebuild reports the
#      destination as unavailable rather than as unconfigured.
#   2. **Device registration** with the team. `-allowProvisioningUpdates` is not
#      enough — registering a *device* is a separate permission and needs
#      `-allowProvisioningDeviceRegistration` as well, without which the error
#      is "Device isn't registered in your developer account" and no amount of
#      re-running helps.
#   3. **A concrete destination.** `generic/platform=iOS` tells Xcode nothing
#      about the device in front of it, so it cannot register what it cannot
#      see: the destination has to name the udid.
#
# Registering one device also unblocks --archive, which fails with "your team
# has no devices" until at least one exists.
device_build() {
    local dir="$1"
    local udid
    udid="$(find_device)"
    if [[ -z "$udid" ]]; then
        echo "no device found." >&2
        echo "  Connect an iPhone or iPad, unlock it, and trust the Mac." >&2
        echo "  Then: Settings → Privacy & Security → Developer Mode → on," >&2
        echo "  which needs a restart." >&2
        exit 1
    fi
    echo "  device $udid"

    echo "  pod install"
    mac "cd ~/$dir/ios/App && pod install 2>&1 | tail -3"

    echo "  xcodebuild (device, signed)"
    if ! mac_signed "cd ~/$dir/ios/App && xcodebuild -workspace App.xcworkspace \
            -scheme App -configuration Debug \
            -destination 'platform=iOS,id=$udid' -derivedDataPath /tmp/dd-device \
            DEVELOPMENT_TEAM=$TEAM_ID \
            -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
            build 2>&1 | tail -40" \
         | tee /tmp/ubersdr-device.log | grep -q "BUILD SUCCEEDED"; then
        echo >&2
        echo "device build failed — see /tmp/ubersdr-device.log" >&2
        exit 1
    fi
    echo "  BUILD SUCCEEDED"

    echo "  installing"
    mac "xcrun devicectl device install app --device $udid \
        /tmp/dd-device/Build/Products/Debug-iphoneos/App.app 2>&1 | tail -3"

    if [[ "$LAUNCH" -eq 1 ]]; then
        mac "xcrun devicectl device process launch --device $udid $APP_ID 2>&1 | tail -2"
    fi
    echo "  installed on the device."
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

# Everything that has to be true before a build can work, each reported with
# what to do about it. Written after a session spent discovering these one
# compiler error at a time: the failures are all perfectly clear once you know
# what they mean, and completely opaque before that.
preflight() {
    local ok=0

    echo
    echo "  Build environment on $MAC_HOST"
    echo

    if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$MAC_HOST" true 2>/dev/null; then
        echo "    ssh            cannot reach $MAC_HOST without a password."
        echo "                   Set up key auth, or point MAC_HOST somewhere else."
        return 1
    fi
    echo "    ssh            $(mac 'sw_vers -productName; sw_vers -productVersion; uname -m' | tr '\n' ' ')"

    # Xcode itself. The Command Line Tools are not enough and say so in a way
    # that sounds like Xcode is missing entirely.
    local xcode
    xcode="$(mac 'xcodebuild -version 2>&1 | head -1' || true)"
    if [[ "$xcode" != Xcode* ]]; then
        echo "    xcode          not usable: $xcode"
        echo "                   Install Xcode from the App Store."
        ok=1
    else
        echo "    xcode          $xcode"
    fi

    # The active developer directory, reported because it is the trap: this
    # script works around it, everything else on that Mac does not.
    local devdir
    devdir="$(mac 'xcode-select -p' 2>/dev/null || true)"
    if [[ "$devdir" != "$DEVELOPER_DIR_REMOTE" ]]; then
        echo "    xcode-select   $devdir"
        echo "                   Worked around here with DEVELOPER_DIR, but your own"
        echo "                   Terminal will fail. Fix it with:"
        echo "                     sudo xcode-select -s /Applications/Xcode.app"
    fi

    # The platform, asked about properly. -showsdks lies: it lists an SDK that
    # cannot be built against until the components are downloaded.
    local runtimes
    runtimes="$(mac 'xcrun simctl list runtimes 2>/dev/null | grep -c "^iOS"' || echo 0)"
    if [[ "${runtimes:-0}" -lt 1 ]]; then
        echo "    ios platform   not installed — no simulator runtime"
        echo "                   Every build fails with 'Supported platforms ... is empty'."
        echo "                   Fix (8.5 GB, no sudo):  xcodebuild -downloadPlatform iOS"
        ok=1
    else
        echo "    ios platform   $(mac 'xcrun simctl list runtimes 2>/dev/null | grep "^iOS" | head -1')"
    fi

    local pod
    pod="$(mac 'pod --version 2>/dev/null' || true)"
    if [[ -z "$pod" ]]; then
        echo "    cocoapods      not installed"
        echo "                   Fix:  brew install cocoapods"
        echo "                   (brew's, not a gem — Apple's system Ruby is too old)"
        ok=1
    else
        echo "    cocoapods      $pod"
    fi

    local sims
    sims="$(mac "xcrun simctl list devices available 2>/dev/null | grep -c '$SIM_DEVICE'" || echo 0)"
    if [[ "${sims:-0}" -lt 1 ]]; then
        echo "    simulator      '$SIM_DEVICE' not available"
        echo "                   Pick another with SIM_DEVICE=, or see: xcrun simctl list devices"
        [[ "$RUN" -eq 1 || "$TEST" -eq 1 ]] && ok=1
    else
        echo "    simulator      $SIM_DEVICE"
    fi

    # Signing is reported, never required. A simulator build needs none, and
    # saying "0 identities" without saying that is alarming for no reason.
    local ids
    ids="$(mac 'security find-identity -v -p codesigning 2>/dev/null | tail -1' || true)"
    if [[ "$ids" == *"0 valid identities"* ]]; then
        echo "    signing        none — simulator builds are fine, device builds are not"
        echo "                   Sign in: Xcode → Settings → Accounts"
        [[ "$RELEASE" -eq 1 ]] && ok=1
    else
        echo "    signing        ${ids# }"
    fi

    # A connected device, which --device and --archive both want. Reported
    # rather than required: everything else here works on a simulator.
    local udid
    udid="$(find_device || true)"
    if [[ -n "$udid" ]]; then
        echo "    device         $udid"
    else
        echo "    device         none connected (only --device and --archive need one)"
    fi

    echo "    disk           $(mac 'df -h / | tail -1' | awk '{print $4" free"}')"
    echo

    return $ok
}

# ---------------------------------------------------------------------------
# The environment test
# ---------------------------------------------------------------------------

# A throwaway Capacitor app, built and run on the Mac exactly as the real one
# will be. It exists so that "does the Mac work?" can be answered without this
# client's ios/ platform existing, and so that when the real build breaks later
# there is a known-good comparison one command away.
#
# The page it ships says one word. That word appearing in a screenshot taken on
# a simulator is the whole chain — CLI, transfer, pods, compiler, runtime,
# WKWebView, capture — reporting success at once.
run_test() {
    local tmp; tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN

    # Pinned to whatever major this client already uses, so the test cannot
    # quietly pass against a Capacitor the real app does not have.
    local major
    major="$(node -p "require('./package.json').dependencies['@capacitor/core'].replace(/[^0-9.]/g,'').split('.')[0]")"

    echo "  building a throwaway Capacitor $major app"
    (
        cd "$tmp"
        cat > package.json <<EOF
{ "name": "ubersdr-mac-selftest", "version": "0.0.0", "private": true }
EOF
        cp "$OLDPWD/capacitor.config.json" .
        mkdir -p www
        # viewport-fit and the safe-area inset are not decoration here: without
        # them the one line this page exists to show sits under the Dynamic
        # Island in the screenshot that is supposed to prove it rendered.
        cat > www/index.html <<'HTML'
<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<body style="font:600 40px/1.3 -apple-system,system-ui;margin:0;
             padding:calc(env(safe-area-inset-top) + 3rem) 2rem 2rem">
UberSDR<br>build OK
</body>
HTML
        npm install --silent --no-audit --no-fund \
            "@capacitor/cli@^$major" "@capacitor/core@^$major" "@capacitor/ios@^$major" >/dev/null
        npx cap add ios >/dev/null 2>&1
    )

    ship "$tmp" "${MAC_DIR}-test"
    build_remote "${MAC_DIR}-test" 1

    if [[ -n "$SHOT" ]]; then
        capture "${MAC_DIR}-test" "$SHOT"
    else
        capture "${MAC_DIR}-test" "/tmp/ubersdr-mac-selftest.png"
    fi

    [[ "$KEEP" -eq 1 ]] || mac "rm -rf ~/${MAC_DIR}-test" || true

    echo
    echo "  the build environment works: compiled, installed, launched and captured."
}

# ---------------------------------------------------------------------------
# Build, run, capture
# ---------------------------------------------------------------------------

# pod install then xcodebuild, in the remote directory.
#
# CODE_SIGNING_ALLOWED=NO for the simulator because there is nothing to sign
# for and asking would fail on a Mac with no identities — which is the state
# this was written on.
build_remote() {
    local dir="$1" simulator="$2"
    local dest sign cfg
    if [[ "$simulator" -eq 1 ]]; then
        # Debug, and deliberately: the simulator build is the one --run,
        # --screenshots and --bgtest drive, and all three need code that a
        # release build leaves out.
        dest="generic/platform=iOS Simulator"
        sign="CODE_SIGNING_ALLOWED=NO"
        cfg=Debug
    else
        # Release for a device — the configuration is the whole point of the
        # flag. Built as Debug it would carry the console bridge and the
        # --bgtest hook into something meant to be shippable, which is a poor
        # thing to discover from a build that said "release" and passed.
        dest="generic/platform=iOS"
        sign=""
        cfg=Release
    fi

    echo "  pod install"
    mac "cd ~/$dir/ios/App && pod install 2>&1 | tail -3"

    echo "  xcodebuild ($dest, $cfg)"
    # Signed builds need the keychain unlocked in the same ssh session — see
    # mac_signed. A simulator build signs nothing and does not want it.
    local run=mac
    [[ "$simulator" -eq 1 ]] || run=mac_signed
    if ! $run "cd ~/$dir/ios/App && xcodebuild -workspace App.xcworkspace -scheme App \
                -configuration $cfg -destination '$dest' \
                -derivedDataPath /tmp/dd-$dir build $sign 2>&1 | tail -40" \
         | tee /tmp/ubersdr-xcodebuild.log | grep -q "BUILD SUCCEEDED"; then
        echo >&2
        echo "build failed. The last 40 lines are above and in /tmp/ubersdr-xcodebuild.log." >&2
        exit 1
    fi
    echo "  BUILD SUCCEEDED"
}

# Archive and export an .ipa, which is what TestFlight and the App Store take.
#
# Signed with Apple Distribution and automatic provisioning, which is why this
# needs no device: an App Store profile covers any device, where a *development*
# profile can only be generated once the team has at least one registered — the
# error for which reads "Your team has no devices", and is confusing precisely
# when you do have certificates and expect it to work.
archive_remote() {
    local dir="$1"
    local plist="/tmp/ubersdr-export.plist"

    echo "  pod install"
    mac "cd ~/$dir/ios/App && pod install 2>&1 | tail -3"

    echo "  archiving (Apple Distribution, team $TEAM_ID)"
    if ! mac_signed "cd ~/$dir/ios/App && xcodebuild -workspace App.xcworkspace -scheme App \
                -configuration Release -destination 'generic/platform=iOS' \
                -archivePath /tmp/UberSDR.xcarchive archive \
                DEVELOPMENT_TEAM=$TEAM_ID -allowProvisioningUpdates \
                -allowProvisioningDeviceRegistration 2>&1 | tail -30" \
         | tee /tmp/ubersdr-archive.log | grep -q "ARCHIVE SUCCEEDED"; then
        echo >&2
        echo "archive failed — see /tmp/ubersdr-archive.log" >&2
        exit 1
    fi
    echo "  ARCHIVE SUCCEEDED"

    # The export options, written on the Mac rather than committed: the team is
    # the one thing in here that is not the same for everybody.
    mac "cat > $plist <<'PLIST'
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
    <key>method</key><string>app-store-connect</string>
    <key>teamID</key><string>$TEAM_ID</string>
    <key>uploadSymbols</key><true/>
    <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
PLIST"

    echo "  exporting the .ipa"
    if ! mac "xcodebuild -exportArchive -archivePath /tmp/UberSDR.xcarchive \
                -exportOptionsPlist $plist -exportPath /tmp/ubersdr-ipa \
                -allowProvisioningUpdates 2>&1 | tail -20" \
         | tee -a /tmp/ubersdr-archive.log | grep -q "EXPORT SUCCEEDED"; then
        echo >&2
        echo "export failed — see /tmp/ubersdr-archive.log" >&2
        exit 1
    fi

    mkdir -p dist
    ssh -o BatchMode=yes "$MAC_HOST" 'cat /tmp/ubersdr-ipa/App.ipa' > dist/UberSDR.ipa \
        2> >(grep -v "X11 forwarding request failed" >&2)
    echo "  built dist/UberSDR.ipa ($(du -h dist/UberSDR.ipa | cut -f1))"

    if [[ "$UPLOAD" -eq 1 ]]; then
        upload_remote
        return
    fi
    echo
    echo "  Not uploaded. Add --upload to send it to App Store Connect, or open"
    echo "  $MAC_HOST:/tmp/UberSDR.xcarchive in Xcode's Organizer."
}

# Send the exported .ipa to App Store Connect, where TestFlight and the review
# queue pick it up.
#
# The same credentials the desktop client notarises with — an Apple ID and an
# app-specific password, read from $APPLE_PASSWORD_FILE here and passed to the
# Mac on stdin so it is never in an argv anybody can see in `ps`. An App Store
# Connect API key would work too and is the better answer for a shared CI
# machine; for one person's Mac this is one fewer secret to manage, and the
# password is already there for the dmgs.
#
# `altool` rather than `notarytool`: they are different services. Notarisation
# is a Gatekeeper check on a Mac binary; this is a submission to the store, and
# only altool speaks it.
#
# What comes back is a build in App Store Connect, *not* a submission: it still
# has to be given to TestFlight or attached to a version and sent for review.
# Apple also takes a few minutes to process it, during which it shows as
# "Processing" and cannot be selected — which looks like a failed upload and is
# not.
upload_remote() {
    if [[ ! -f "$APPLE_PASSWORD_FILE" ]]; then
        echo >&2
        echo "not uploaded: no app-specific password at $APPLE_PASSWORD_FILE." >&2
        echo "  Make one at appleid.apple.com and save it there — the desktop" >&2
        echo "  client's notarisation uses the same file." >&2
        exit 1
    fi

    echo "  uploading to App Store Connect as $APPLE_ID_VALUE"
    if ! printf '%s\n' "$(cat "$APPLE_PASSWORD_FILE")" \
        | ssh -o BatchMode=yes "$MAC_HOST" "
            IFS= read -r apppw || true
            export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
            xcrun altool --upload-app -f /tmp/ubersdr-ipa/App.ipa -t ios \
                --apple-id '$APPLE_ID_VALUE' --team-id '$TEAM_ID' \
                --password \"\$apppw\" 2>&1 | tail -20" \
            2> >(grep -v "X11 forwarding request failed" >&2) \
        | tee /tmp/ubersdr-upload.log | grep -qiE "No errors uploading|UPLOAD SUCCEEDED"; then
        echo >&2
        echo "upload failed — see /tmp/ubersdr-upload.log" >&2
        echo >&2
        echo "  A build number already used is the usual cause: App Store" >&2
        echo "  Connect refuses a repeat, and the number comes from the version" >&2
        echo "  in package.json (0.2.0 gives 200). Bump it and archive again." >&2
        exit 1
    fi
    echo "  uploaded — it will show in App Store Connect once Apple has"
    echo "  processed it, which takes a few minutes. Nothing is submitted for"
    echo "  review by this; it is a build waiting to be used."
}

# The App Store set: two devices, two orientations, two screens each.
#
# Every shot is a real run of the real app against a real receiver — the
# "connected" ones follow an `ubersdr://` link through the same path a tapped
# one takes, so what is photographed is the app working rather than a mock of
# it. The orientation comes from the launch environment because a simulator
# cannot be rotated from a script; see DebugOrientation.swift.
screenshots() {
    local dir="$1"
    local out="screenshots"
    mkdir -p "$out"

    local app="/tmp/dd-$dir/Build/Products/Debug-iphonesimulator/App.app"

    for entry in "${SHOT_DEVICES[@]}"; do
        local label="${entry%%:*}"
        local device="${entry#*:}"

        echo
        echo "  $device"
        # bootstatus boots it if it is not booted and returns when it is ready,
        # which a fixed sleep can only guess at.
        mac "xcrun simctl bootstatus '$device' -b >/dev/null 2>&1 || true"

        for orientation in portrait landscape; do
            for screen in chooser connected; do
                local env_open=""
                [[ "$screen" == "connected" ]] && \
                    env_open="SIMCTL_CHILD_UBERSDR_OPEN='ubersdr://connect?uuid=$SHOT_RECEIVER'"

                mac "xcrun simctl terminate '$device' $APP_ID >/dev/null 2>&1 || true"

                # The chooser is photographed on a *fresh* install.
                #
                # Connecting saves the receiver, and a chooser with anything
                # saved opens on the Saved tab — so without this every run
                # after the first shows one row rather than the directory the
                # app exists to offer. Uninstalling is how a simulator forgets:
                # it takes the saved list, the location and the Keychain entry
                # with it, which is exactly the state a new operator sees.
                if [[ "$screen" == "chooser" ]]; then
                    mac "xcrun simctl uninstall '$device' $APP_ID >/dev/null 2>&1 || true"
                fi
                mac "xcrun simctl install '$device' '$app'"
                mac "$env_open SIMCTL_CHILD_UBERSDR_SHOT_MODE=1 \
                     SIMCTL_CHILD_UBERSDR_ORIENTATION=$orientation \
                     xcrun simctl launch '$device' $APP_ID >/dev/null"

                # Two minutes for a receiver, which is what it takes for the
                # waterfall to fill top to bottom. It is a long time to wait for
                # a picture and it is the picture: a half-drawn waterfall with a
                # band of empty black under it is what the screenshot is not
                # meant to show.
                sleep "$([[ "$screen" == "connected" ]] && echo 120 || echo 12)"

                local file="$out/ios-$label-$orientation-$screen.png"
                mac "xcrun simctl io '$device' screenshot /tmp/shot.png >/dev/null 2>&1"
                ssh -o BatchMode=yes "$MAC_HOST" 'cat /tmp/shot.png' > "$file" \
                    2> >(grep -v "X11 forwarding request failed" >&2)

                # simctl photographs the device, not the interface. The app
                # rotates (see DebugOrientation) but the framebuffer does not,
                # so a landscape run comes back portrait-shaped with the whole
                # UI on its side. The pixels are a real landscape layout — only
                # the canvas is turned — so turning it back is a correction,
                # not a fake.
                if [[ "$orientation" == "landscape" ]]; then
                    convert "$file" -rotate -90 "$file"
                fi
                echo "    $file  ($(identify -format '%wx%h' "$file" 2>/dev/null || echo '?'))"
            done
        done

        # Left shut down rather than running: these boot one at a time, and a
        # simulator left playing audio is a receiver still holding a slot.
        mac "xcrun simctl terminate '$device' $APP_ID >/dev/null 2>&1 || true"
        mac "xcrun simctl shutdown '$device' >/dev/null 2>&1 || true"
    done
}

# Boot the simulator, install, launch, screenshot, and bring the PNG back.
#
# bootstatus rather than a sleep: it boots the device if it is not booted and
# returns when it is actually ready, which a fixed sleep can only guess at.
capture() {
    local dir="$1" out="$2"
    local app="/tmp/dd-$dir/Build/Products/Debug-iphonesimulator/App.app"

    echo "  simulator: $SIM_DEVICE"
    mac "xcrun simctl bootstatus '$SIM_DEVICE' -b >/dev/null 2>&1 || true"
    mac "xcrun simctl install booted '$app'"
    mac "xcrun simctl launch booted '$APP_ID'" >/dev/null
    sleep 5
    mac "xcrun simctl io booted screenshot /tmp/ubersdr-shot.png" >/dev/null 2>&1

    mkdir -p "$(dirname "$out")"
    ssh -o BatchMode=yes "$MAC_HOST" 'cat /tmp/ubersdr-shot.png' > "$out" \
        2> >(grep -v "X11 forwarding request failed" >&2)
    echo "  screenshot → $out ($(identify -format '%wx%h' "$out" 2>/dev/null || echo '?'))"
}

# Exercise the native background audio path, and bring the log back.
#
# The path BackgroundAudio takes over — connect to /audio/stream, parse the
# WebM, decode Opus, play it — is the same one whether the app is in front or
# behind. What differs in the background is only whether the app is *allowed* to
# keep doing it, and a simulator does not model that. So this runs it in the
# foreground (UBERSDR_BGTEST, see ReceiverViewController) where every other way
# it can fail still fails: no session id captured, a refused stream, a container
# that will not parse, a packet the system decoder rejects.
#
# A device is still the only place background itself can be tested. This is for
# everything that would waste a device round trip.
bgtest() {
    local dir="$1"
    local app="/tmp/dd-$dir/Build/Products/Debug-iphonesimulator/App.app"

    echo "  simulator: $SIM_DEVICE"
    mac "xcrun simctl bootstatus '$SIM_DEVICE' -b >/dev/null 2>&1 || true"
    mac "xcrun simctl terminate booted $APP_ID >/dev/null 2>&1 || true"
    mac "xcrun simctl install booted '$app'"

    # Started before the app, or the first lines are missed — the session id and
    # the stream's first answer both happen within a second of the handover.
    mac "nohup xcrun simctl spawn booted log stream --style compact \
           --predicate 'eventMessage CONTAINS \"UberSDR audio\"' \
           > /tmp/ubersdr-bg.log 2>&1 & echo \$! > /tmp/ubersdr-bg.pid"

    mac "SIMCTL_CHILD_UBERSDR_OPEN='ubersdr://connect?uuid=$SHOT_RECEIVER' \
         SIMCTL_CHILD_UBERSDR_BGTEST=1 \
         xcrun simctl launch booted $APP_ID >/dev/null"

    # 20 s for the receiver to be playing, then the handover, then half a minute
    # of it — long enough for the frame count to be obviously moving or
    # obviously not.
    echo "  playing, handing over at 20s"
    sleep 60
    mac "kill \$(cat /tmp/ubersdr-bg.pid) 2>/dev/null || true"
    mac "xcrun simctl terminate booted $APP_ID >/dev/null 2>&1 || true"

    echo
    ssh -o BatchMode=yes "$MAC_HOST" 'cat /tmp/ubersdr-bg.log' \
        2> >(grep -v "X11 forwarding request failed" >&2) \
        | sed 's/^/  /'
}

# ---------------------------------------------------------------------------

if ! preflight; then
    echo "the Mac cannot build yet — see above." >&2
    exit 1
fi

if [[ "$CHECK" -eq 1 ]]; then
    echo "  ready."
    exit 0
fi

if [[ "$TEST" -eq 1 ]]; then
    run_test
    exit 0
fi

# The real build, which needs the platform this client does not have yet. Said
# plainly rather than left to a confusing failure inside cap sync.
if [[ ! -d ios ]]; then
    echo "there is no ios/ platform here yet." >&2
    echo >&2
    echo "  Check the Mac instead with:  ./build-mac.sh --test" >&2
    echo "  Create the platform with:    npx cap add ios" >&2
    exit 1
fi

# The interface itself, before anything is copied anywhere.
#
# www/ is the interface on both platforms — the proxy serves /v2/* out of the
# bundle rather than from the receiver, which is what lets this app open a v1
# instance and still show v2, and www/receiver-bridge.js is the host half that
# goes with it. Only build.sh fills either, so without this an iOS build ships
# whatever the last *Android* build happened to stage.
echo "  building the web assets"
./build.sh --stage-ui

echo "  staging the web assets"
npx cap sync ios

# The version, from package.json, exactly as app/build.gradle takes it for
# Android: one place names this app's version, and a release is a bump in one
# file. Xcode's template hard-codes 1.0 (1), which would otherwise ship a
# TestFlight build claiming to be version 1.0 forever.
#
# CFBundleShortVersionString is the human one (0.2.0). CFBundleVersion must only
# ever increase within it, and Apple compares it per version string rather than
# globally — the same integer scheme Android uses (0.2.0 → 200) satisfies that
# and keeps the two platforms saying the same number.
VERSION="$(node -p "require('./package.json').version")"
BUILD_NUMBER="$(node -p "
  const [a,b,c] = require('./package.json').version.split('.').map(Number);
  a * 10000 + b * 100 + c;
")"
PBX=ios/App/App.xcodeproj/project.pbxproj
sed -i "s/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = $VERSION;/g; \
        s/CURRENT_PROJECT_VERSION = [^;]*;/CURRENT_PROJECT_VERSION = $BUILD_NUMBER;/g" "$PBX"
echo "  version $VERSION ($BUILD_NUMBER)"

ship . "$MAC_DIR"

if [[ "$ARCHIVE" -eq 1 ]]; then
    archive_remote "$MAC_DIR"
    exit 0
fi

if [[ "$DEVICE" -eq 1 ]]; then
    device_build "$MAC_DIR"
    exit 0
fi

build_remote "$MAC_DIR" "$([[ "$RELEASE" -eq 1 ]] && echo 0 || echo 1)"

if [[ "$SHOTS" -eq 1 ]]; then
    screenshots "$MAC_DIR"
    exit 0
fi

if [[ "$BGTEST" -eq 1 ]]; then
    bgtest "$MAC_DIR"
    exit 0
fi

if [[ "$RUN" -eq 1 || -n "$SHOT" ]]; then
    capture "$MAC_DIR" "${SHOT:-/tmp/ubersdr-ios.png}"
fi

[[ "$KEEP" -eq 1 ]] || echo "  (remote tree left at $MAC_HOST:~/$MAC_DIR)"
