#!/usr/bin/env bash
# build-mac.sh — build, sign and notarise the macOS dmg on a Mac over SSH.
#
# The desktop client packages for Linux and Windows from here, but not for
# macOS: a dmg has to be signed by Apple's codesign and notarised by Apple's
# service, and neither exists off a Mac. So this ships the client to one, builds
# there, and brings the artefacts back.
#
# It is the same arrangement as clients/capacitor/build-mac.sh and deliberately
# so — same host, same ssh, same shape — but a much smaller problem. That one
# needs Xcode to compile Swift; this one needs a Mac only for the last two steps
# of a build that is otherwise plain JavaScript. There is no compiler here and
# no native module in the tree: `dependencies` is empty and electron-builder
# fetches the Electron binary for the target itself.
#
# Usage:
# The terminal client has its own version of all this, in
# clients/tui/notarise-mac.sh: the same ssh helper, the same keychain unlock and
# the same .gatekeeper-ok convention, applied to two bare Go binaries rather than
# to a dmg. Where the two differ is documented there — a ticket cannot be stapled
# to a loose executable, so it gates on notarytool's verdict rather than spctl's.
#
#   ./build-mac.sh --check   preflight only: can that Mac build, sign, notarise?
#   ./build-mac.sh           build both dmgs and bring them back to dist/
#   ./build-mac.sh --arch=arm64
#                            one architecture instead of both
#   ./build-mac.sh --unsigned
#                            build without signing at all. What every test build
#                            is: the dmg runs on the Mac that made it and is
#                            refused by Gatekeeper on any other, which is fine
#                            when the question is whether the app works.
#   ./build-mac.sh --publish
#                            ...and upload the dmgs to the `latest` release on
#                            GitHub, replacing what is there. No prompt: the
#                            gate is that every dmg has been verified notarised,
#                            which is a fact about the file rather than an
#                            opinion, and a build that got that far is a build
#                            worth publishing. Only the dmgs — the Linux and
#                            Windows artefacts are build.sh's to upload.
#   ./build-mac.sh --keep    leave the remote build tree behind afterwards
#
# Environment:
#   MAC_HOST                 ssh target (default: macbook)
#   MAC_DIR                  remote build directory (default: ~/ubersdr-electron)
#   APPLE_KEYCHAIN_PROFILE   the notarisation credentials to use, by the name
#                            they were stored under on the Mac. See below.
#   APPLE_ID                 the Apple ID those credentials belong to, used only
#                            to create the profile the first time.
#   APPLE_PASSWORD_FILE      a file *here* holding the app-specific password for
#                            that Apple ID, and nothing else. Default
#                            ~/keys/app.password. Used once, to store the
#                            profile on the Mac; after that the Mac has it and
#                            this file is never read again.
#   MAC_KEYCHAIN_PASSWORD_FILE
#                            a file *here* holding the Mac's login password, and
#                            nothing else. Default ~/keys/mac-keychain.password,
#                            beside the Android keystore password build.sh reads
#                            the same way and for the same reason: a password in
#                            an environment variable is readable from every child
#                            process's /proc entry and ends up in a shell
#                            history. It is sent to the Mac on stdin rather than
#                            in the command line, so it is not visible in `ps`
#                            there either.
#
# ---------------------------------------------------------------------------
# Signing and notarisation, which is the whole point of building on a Mac
# ---------------------------------------------------------------------------
#
# A signed-and-notarised dmg and an unsigned one are the same file to look at,
# and the difference only shows on somebody else's Mac: Gatekeeper refuses a
# *downloaded* app that is not notarised, while a dmg built on the machine it
# runs on carries no quarantine attribute and works perfectly for whoever built
# it. That is the trap — the build that looked fine and is refused as damaged by
# everybody who receives it. This reports what will happen before it starts.
#
# Two credentials are needed and they are different things:
#
#   * **A Developer ID Application certificate**, which signs the app. It lives
#     in the Mac's login keychain, where Xcode puts it, and electron-builder
#     finds it there with nothing configured. Already present on this host.
#
#   * **Notarisation credentials**, which upload the signed app to Apple to be
#     checked. Not the same as the certificate and not derivable from it.
#
# The notarisation credentials are deliberately *not* passed over ssh from here.
# Anything put in the command line of a remote command is visible in `ps` on
# that machine for as long as it runs, and an app-specific password is a
# password. Instead they are stored once, on the Mac, in its keychain:
#
#     ssh macbook
#     xcrun notarytool store-credentials ubersdr \
#         --apple-id you@example.com \
#         --team-id B7CM4Z8JW8 \
#         --password <app-specific-password>
#
# ...and from then on this only ever names the profile. Make the app-specific
# password at appleid.apple.com → Sign-In and Security → App-Specific Passwords;
# it is not your Apple ID password and can be revoked on its own.
#
# `--check` says which of the two are in place, and the build reports it again
# before it starts rather than after it has finished.

set -euo pipefail

cd "$(dirname "$0")"

MAC_HOST="${MAC_HOST:-macbook}"
MAC_DIR="${MAC_DIR:-ubersdr-electron}"
KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-ubersdr}"
KEYCHAIN_PASSWORD_FILE="${MAC_KEYCHAIN_PASSWORD_FILE:-$HOME/keys/mac-keychain.password}"
APPLE_PASSWORD_FILE="${APPLE_PASSWORD_FILE:-$HOME/keys/app.password}"
APPLE_ID_VALUE="${APPLE_ID:-nathan@nsamail.uk}"
TEAM_ID="${APPLE_TEAM_ID:-B7CM4Z8JW8}"
BREW_BIN=/opt/homebrew/bin

# The release the dmgs go to, and the repository they go to it on. The same two
# constants build.sh uses, and named here for the same reason: a clone with a
# fork as its remote must not be able to publish this project's downloads
# somewhere else, or somebody else's downloads here.
REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"

CHECK=0
KEEP=0
UNSIGNED=0
PUBLISH=0
ARCH=""

for arg in "$@"; do
    case "$arg" in
        --check) CHECK=1 ;;
        --keep) KEEP=1 ;;
        --unsigned) UNSIGNED=1 ;;
        --publish) PUBLISH=1 ;;
        --arch=*) ARCH="${arg#--arch=}" ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

# One remote command, with the PATH a non-interactive ssh session does not get.
# The X11 warning is dropped because it is not one — the Mac offers forwarding,
# this has no display, and the line is noise in front of every command.
mac() {
    ssh -o BatchMode=yes -o ConnectTimeout=15 "$MAC_HOST" \
        "export PATH=$BREW_BIN:\$PATH; $*" \
        2> >(grep -v "X11 forwarding request failed" >&2)
}

# Run a remote command with the signing key reachable.
#
# The unlock has to happen in the *same* ssh session as the thing that signs.
# An `security unlock-keychain` in a session of its own does not carry over:
# the next ssh login gets a fresh security context and codesign fails with
# `errSecInternalComponent`, which mentions no keychain and no lock. That is
# why this is a wrapper rather than a step.
#
# Two things are done, both needed and neither obvious from that error:
#
#   * **unlock-keychain**, because a keychain locks on its own and an ssh
#     session cannot answer the dialog that would otherwise ask.
#   * **set-key-partition-list**, because the key's ACL decides which programs
#     may use it without asking, and a key imported by Xcode does not list
#     codesign among them for a non-GUI session. Unlocking alone leaves signing
#     failing exactly as before, which is the trap inside the trap.
#
# The password goes over stdin, never in the command line — `ps` on the Mac
# shows every argument of a running command, and this one runs for a whole
# build. With no password file this is just `mac`, and signing works only if
# the keychain happens to be open already.
mac_signed() {
    if [[ ! -f "$KEYCHAIN_PASSWORD_FILE" ]]; then
        mac "$@"
        return
    fi
    # Exactly two lines, whatever the files end with. `cat file; echo` looks
    # equivalent and is not: a file that already ends in a newline then yields a
    # blank second line, so the app-specific password reads as empty and the
    # build fails at notarisation having already signed everything. $(...)
    # strips trailing newlines, and printf puts back exactly one each.
    printf '%s\n' "$(cat "$KEYCHAIN_PASSWORD_FILE")" \
                   "$(cat "$APPLE_PASSWORD_FILE" 2>/dev/null)" \
    | ssh -o BatchMode=yes "$MAC_HOST" "
        export PATH=$BREW_BIN:\$PATH
        IFS= read -r pw || true
        IFS= read -r apppw || true
        kc=\$HOME/Library/Keychains/login.keychain-db
        security unlock-keychain -p \"\$pw\" \$kc 2>/dev/null || true
        security set-key-partition-list -S apple-tool:,apple:,codesign: \
            -s -k \"\$pw\" \$kc >/dev/null 2>&1 || true
        unset pw
        $*
    " 2> >(grep -v "X11 forwarding request failed" >&2)
}

# Notarisation credentials, and why they are not a keychain profile.
#
# `xcrun notarytool store-credentials` is the tidy way to hold these: the
# password lives in the Mac's keychain and no build ever sees it. It cannot be
# set up from here, though — over ssh it validates the credentials, prints
# "Success", and stores nothing that any later session can read, because
# writing a keychain item needs a session able to authorise the write. The
# failure then arrives minutes into a build as "No Keychain password item
# found", naming a profile that appeared to be created twice.
#
# So the credentials are passed to the build instead. They reach the Mac on
# stdin and are exported inside the remote shell, never in an ssh command line.
# `notarytool` itself does put the password in its own argv — @electron/notarize
# spawns it that way whichever route is used — so this is no worse than the
# alternative, and it is the only one that works unattended.
#
# If you would rather have the keychain profile, run this once in Terminal *on*
# the Mac, where it does persist:
#
#     xcrun notarytool store-credentials ubersdr \
#         --apple-id <apple-id> --team-id <team> --password <app-specific>
#
# ---------------------------------------------------------------------------

preflight() {
    local ok=0

    echo
    echo "  Build environment on $MAC_HOST"
    echo

    if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$MAC_HOST" true 2>/dev/null; then
        echo "    ssh            cannot reach $MAC_HOST without a password."
        echo "                   Set up key auth, or point MAC_HOST elsewhere."
        return 1
    fi
    echo "    ssh            $(mac 'sw_vers -productName; sw_vers -productVersion; uname -m' | tr '\n' ' ')"

    local node_version
    node_version="$(mac 'node -v 2>/dev/null' || true)"
    if [[ -z "$node_version" ]]; then
        echo "    node           not installed"
        echo "                   Fix:  ssh $MAC_HOST 'brew install node'"
        ok=1
    else
        echo "    node           $node_version"
    fi

    # The certificate that signs the app. Named in full rather than reported as
    # present: "Developer ID Application" and "Apple Development" are both
    # certificates and only the first one produces something other people can
    # run.
    local cert
    cert="$(mac "security find-identity -v -p codesigning 2>/dev/null \
        | grep -m1 'Developer ID Application' | sed 's/.*\"\(.*\)\".*/\1/'" || true)"
    if [[ -z "$cert" ]]; then
        echo "    certificate    none — the app will be unsigned"
        echo "                   Needs a Developer ID Application certificate in"
        echo "                   the login keychain. Xcode → Settings → Accounts"
        echo "                   → Manage Certificates → +"
        ok=1
    else
        echo "    certificate    $cert"

        # Having the certificate and being able to *use* it are different
        # questions over ssh, and the difference is invisible until the build
        # is most of the way through. A session that did not log in
        # graphically cannot reach the private key in the login keychain, and
        # codesign fails with `errSecInternalComponent` — which says nothing
        # about keychains at all. So this signs a scratch file and looks.
        local signcheck
        signcheck="$(mac_signed "f=\$(mktemp /tmp/ubersdr-signcheck.XXXXXX); printf x > \$f; \
            codesign --sign '$cert' --force \$f 2>&1; rm -f \$f" || true)"
        if [[ -n "$signcheck" ]]; then
            echo "    signing        cannot use that certificate over ssh:"
            echo "                   ${signcheck##*: }"
            echo
            echo "                   The key is in the login keychain and an ssh"
            echo "                   session is not allowed at it. Fix it once,"
            echo "                   on the Mac, with your *login* password:"
            echo "                     security unlock-keychain ~/Library/Keychains/login.keychain-db"
            echo "                     security set-key-partition-list \\"
            echo "                       -S apple-tool:,apple:,codesign: -s \\"
            echo "                       ~/Library/Keychains/login.keychain-db"
            echo
            echo "                   Or leave a password file for this script to"
            echo "                   unlock with — see MAC_KEYCHAIN_PASSWORD_FILE"
            echo "                   in the header."
            [[ "$UNSIGNED" -eq 1 ]] || ok=1
        else
            echo "    signing        works over ssh"
        fi
    fi

    # The notarisation credentials. Reported, and validated against Apple —
    # a wrong app-specific password should cost five seconds here rather than
    # ten minutes and a signed dmg that cannot be shipped.
    if [[ -f "$APPLE_PASSWORD_FILE" && -n "$APPLE_ID_VALUE" ]]; then
        local notarycheck
        notarycheck="$(printf '%s\n' "$(cat "$KEYCHAIN_PASSWORD_FILE" 2>/dev/null)" \
                              "$(cat "$APPLE_PASSWORD_FILE")" \
            | ssh -o BatchMode=yes "$MAC_HOST" "
                export PATH=$BREW_BIN:\$PATH
                IFS= read -r _pw || true
                IFS= read -r apppw || true
                xcrun notarytool history --apple-id '$APPLE_ID_VALUE' \
                    --team-id '$TEAM_ID' --password \"\$apppw\" 2>&1 \
                    | grep -m1 '^Error:'
              " 2>/dev/null || true)"
        if [[ -z "$notarycheck" ]]; then
            echo "    notarisation   $APPLE_ID_VALUE (team $TEAM_ID), validated"
        else
            echo "    notarisation   ${notarycheck#Error: }"
            echo "                   Check APPLE_ID and $APPLE_PASSWORD_FILE."
            ok=1
        fi
    else
        echo "    notarisation   no credentials — the dmg will not be notarised"
        echo "                   Gatekeeper refuses an un-notarised download on"
        echo "                   anybody else's Mac. Put an app-specific password"
        echo "                   from appleid.apple.com in:"
        echo "                     $APPLE_PASSWORD_FILE"
        echo "                   and set APPLE_ID if it is not $APPLE_ID_VALUE."
    fi

    echo "    disk           $(mac 'df -h / | tail -1' | awk '{print $4" free"}')"
    echo

    return $ok
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

# The staged UI has to exist before anything is shipped: ui/v2 is what the
# per-instance proxy serves, and it is built by ./build.sh here rather than on
# the Mac, which has no esbuild and no business having one.
if [[ ! -d ui/v2 ]]; then
    echo "ui/v2 is not staged — run ./build.sh first." >&2
    exit 1
fi

echo "  shipping to $MAC_HOST:~/$MAC_DIR"
# node_modules is left behind deliberately. There is no native module in this
# tree, but node_modules/electron holds a Linux Electron binary and its
# postinstall is what puts the right one there — `npm ci` on the Mac is both
# smaller over the wire and correct by construction.
tar czf - \
    --exclude=./node_modules \
    --exclude=./dist \
    --exclude=./.git \
    . \
| ssh -o BatchMode=yes "$MAC_HOST" \
    "rm -rf ~/$MAC_DIR && mkdir -p ~/$MAC_DIR && cd ~/$MAC_DIR && tar xzf -" \
    2> >(grep -v "X11 forwarding request failed" >&2)

echo "  npm ci"
mac "cd ~/$MAC_DIR && npm ci --no-audit --no-fund 2>&1 | tail -3"

# Both architectures unless told otherwise. An Apple Silicon Mac builds the x64
# dmg perfectly well — electron-builder fetches that Electron itself — and the
# two together are what the download page offers.
# Both architectures unless one was named.
#
# `--mac` on its own builds for the host architecture only — on an Apple
# Silicon Mac that is arm64, and the x64 dmg every Intel Mac downloads simply
# never appears. electron-builder wants them named.
target="--mac --arm64 --x64"
[[ -n "$ARCH" ]] && target="--mac --$ARCH"

# The signing switches, and the label for them.
#
# `signing_env` must be set even when it is empty: `set -u` is on, and an unset
# variable expanded in the build command is a build that dies after npm ci with
# "unbound variable". And the label cannot be `${UNSIGNED:+…}` — that expands
# whenever the variable is non-empty, and "0" is non-empty, so every signed
# build announced itself as unsigned.
signing_env=""
label=""
if [[ "$UNSIGNED" -eq 1 ]]; then
    # CSC_IDENTITY_AUTO_DISCOVERY is electron-builder's own switch for "do not
    # go looking for a certificate". Without it an unsigned build is not
    # unsigned — it finds the Developer ID in the keychain and fails on the
    # first file it cannot reach the key for.
    signing_env="CSC_IDENTITY_AUTO_DISCOVERY=false"
    label=" (unsigned)"
fi

echo "  electron-builder $target$label"
[[ "$UNSIGNED" -eq 1 ]] || echo "  (notarisation uploads to Apple and waits for a verdict — minutes, not seconds)"

# Streamed, not collected.
#
# The output used to be piped through `tail -40` *on the Mac*, which had two
# faults. Nothing appeared until the whole build finished, so a ten-minute
# notarisation looked like a hang; and a pipeline's exit status in the remote
# shell is `tail`'s, not electron-builder's, so a failed build reported success
# and this script carried on to look for a dmg that was never made. Piping here
# instead keeps the status — `set -o pipefail` is on — and PIPESTATUS names the
# one that matters regardless.
set +e
# The notarisation credentials are exported inside the remote shell, from the
# app-specific password mac_signed has already read into $apppw. Dropping this
# prefix does not fail the build — electron-builder logs "skipped macOS
# notarization, `notarize` options were unable to be generated" among a hundred
# other lines and produces a signed-but-unnotarised dmg, which Gatekeeper
# refuses on anybody else's Mac.
mac_signed "export APPLE_ID='$APPLE_ID_VALUE' APPLE_TEAM_ID='$TEAM_ID' \
        APPLE_APP_SPECIFIC_PASSWORD=\$apppw; \
    cd ~/$MAC_DIR && $signing_env \
    ./node_modules/.bin/electron-builder $target 2>&1" \
    | tee /tmp/ubersdr-electron-mac.log
build_status=${PIPESTATUS[0]}
set -e

if [[ "$build_status" -ne 0 ]]; then
    echo >&2
    echo "build failed — the full log is in /tmp/ubersdr-electron-mac.log" >&2
    exit 1
fi

mkdir -p dist
# What this run built, as opposed to what happens to be lying in dist/.
#
# --publish uploads from this list and no other. Without it a
# `--arch=arm64 --publish` would cheerfully re-upload an x64 dmg left over from
# an older version, marker and all — the marker says "Gatekeeper accepts this",
# not "this is the build you just made".
BUILT_DMGS=()
echo
# `ls *.dmg` is asked of a remote zsh, which errors on a glob that matches
# nothing instead of passing it through. Listing the directory and filtering
# here means "no dmgs" is an empty loop rather than an error message.
for dmg in $(mac "ls ~/$MAC_DIR/dist 2>/dev/null | grep '[.]dmg$'" || true); do
    ssh -o BatchMode=yes "$MAC_HOST" "cat ~/$MAC_DIR/dist/$dmg" > "dist/$dmg" \
        2> >(grep -v "X11 forwarding request failed" >&2)
    echo "  built dist/$dmg ($(du -h "dist/$dmg" | cut -f1))"

    # Whether Gatekeeper will accept it, asked of the Mac and asked about the
    # right object.
    #
    # electron-builder signs and notarises the *app*, staples the ticket to it,
    # and then wraps it in a dmg it does not sign. So `spctl` against the dmg
    # reports "no usable signature" on a build that is perfectly fine — the
    # container is unsigned, the app inside is notarised, and what a downloader
    # runs is the app. Mounting it and assessing the app is the question that
    # matches what actually happens: quarantine on the download, Gatekeeper
    # reading the stapled ticket when the app is opened.
    verdict="$(mac "
        set -e
        mnt=\$(mktemp -d)
        hdiutil attach -nobrowse -readonly -mountpoint \$mnt \
            ~/$MAC_DIR/dist/$dmg >/dev/null
        app=\$(ls -d \$mnt/*.app 2>/dev/null | head -1)
        if [ -n \"\$app\" ]; then
            spctl -a -t exec -vv \"\$app\" 2>&1 | tail -2
            xcrun stapler validate \"\$app\" 2>&1 | tail -1
        else
            echo 'no app inside the dmg'
        fi
        hdiutil detach \$mnt >/dev/null 2>&1 || true
    " || true)"
    echo "    $(echo "$verdict" | tr '\n' ' ')"

    # The verdict, written down beside the dmg.
    #
    # Only a Mac can answer "will Gatekeeper accept this", and publishing
    # happens from Linux — so the answer travels with the file. build.sh
    # refuses to upload a dmg without this marker, which is the same rule the
    # Android half applies to an unsigned APK, and for a worse failure: an
    # un-notarised dmg does not warn anybody, it is reported as damaged.
    marker="dist/$dmg.gatekeeper-ok"
    rm -f "$marker"
    if [[ "$verdict" == *"source=Notarized Developer ID"* ]]; then
        echo "$verdict" > "$marker"
        BUILT_DMGS+=("dist/$dmg")
    else
        echo "    (not publishable — see build.sh --publish)"
    fi
done

[[ "$KEEP" -eq 1 ]] || mac "rm -rf ~/$MAC_DIR" || true

# ---------------------------------------------------------------------------

# Upload the dmgs, and nothing else.
#
# No typed confirmation, deliberately, and the reason is worth stating: the
# thing being guarded against is not haste but shipping a dmg that Gatekeeper
# refuses, and that is already guarded by something better than a keystroke —
# every file uploaded here has been mounted, assessed with spctl and found to
# carry a stapled notarisation ticket. A build that got that far is a build
# worth publishing.
#
# What it will not do: upload an unsigned build, upload a dmg whose marker is
# missing, or touch the Linux and Windows artefacts. Those are build.sh's, and
# re-uploading this morning's copies of them is not what "publish the dmg"
# means.
publish_dmgs() {
    if [[ "$UNSIGNED" -eq 1 ]]; then
        echo "not published: this was an unsigned build." >&2
        exit 1
    fi
    if ! command -v gh >/dev/null 2>&1; then
        echo "not published: gh not found — install the GitHub CLI." >&2
        exit 1
    fi
    if ! gh auth status >/dev/null 2>&1; then
        echo "not published: gh is not logged in — run 'gh auth login'." >&2
        exit 1
    fi
    if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
        echo "not published: there is no '$TAG' release on $REPO." >&2
        exit 1
    fi

    # Only what this run built and verified. A dmg that failed verification
    # never entered the list, so there is nothing here to re-check — but the
    # marker is confirmed again anyway, because the file on disk is what gets
    # uploaded and the two could have diverged.
    local uploads=()
    local dmg
    for dmg in ${BUILT_DMGS[@]+"${BUILT_DMGS[@]}"}; do
        [[ -f "$dmg" && -f "$dmg.gatekeeper-ok" ]] || continue
        uploads+=("$dmg")
    done
    if [[ "${#uploads[@]}" -eq 0 ]]; then
        echo "not published: this build produced no verified dmg." >&2
        exit 1
    fi

    echo
    echo "  uploading to https://github.com/$REPO/releases/tag/$TAG"
    for dmg in "${uploads[@]}"; do
        echo "      $(basename "$dmg")   $(du -h "$dmg" | cut -f1)"
    done
    # --clobber because the asset names are constants: updates.js points at
    # these URLs and they must not move.
    gh release upload "$TAG" "${uploads[@]}" --clobber --repo "$REPO"
    echo "  published."
}

if [[ "$PUBLISH" -eq 1 ]]; then
    publish_dmgs
fi
exit 0
