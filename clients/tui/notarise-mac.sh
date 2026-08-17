#!/usr/bin/env bash
# notarise-mac.sh — sign and notarise the macOS terminal-client binaries.
#
# The same problem the dmgs have, on a smaller object. Gatekeeper refuses a
# *downloaded* binary that is not signed with a Developer ID certificate and
# notarised by Apple — and for a command-line tool the refusal is worse than a
# dialog: the shell reports `zsh: killed` or "cannot be opened because the
# developer cannot be verified", which reads as a broken download rather than as
# a policy anybody can act on. The alternative is telling every macOS user to
# run `xattr -d com.apple.quarantine`, which is asking them to disable the check
# rather than to pass it.
#
# So this does for the two darwin binaries what clients/electron/build-mac.sh
# does for the dmgs, and deliberately in the same shapes: the same ssh helper,
# the same keychain-unlock wrapper, the same preflight, the same
# `.gatekeeper-ok` marker convention, and the same rule that only a verified
# artefact may be published.
#
# What is different, and it matters:
#
#   * **A ticket cannot be stapled to a bare executable.** `xcrun stapler` takes
#     an .app, a .dmg or a .pkg — nothing else. A Mach-O on its own can be
#     signed and notarised, and Apple records the ticket, but there is nowhere in
#     the file to put it. Gatekeeper therefore looks the ticket up *online* the
#     first time the binary runs. That is fine for anybody with a network and is
#     the reason the binaries are still shipped as plain binaries: no renamed
#     assets, no installer, and every link on the website keeps working. A .pkg
#     would be stapled and work offline, and would need a Developer ID Installer
#     certificate this account does not have yet.
#   * **notarytool will not take a bare executable either.** It needs a
#     container, so each binary is zipped with `ditto` purely to be submitted;
#     the zip is thrown away and never published.
#   * **The publish gate is Apple's own verdict, not spctl's.** build-mac.sh
#     gates on `spctl` finding a stapled ticket, which is a local, offline fact
#     about a dmg. There is no ticket in these files to find, so `spctl` here is
#     an online lookup that can lag a fresh submission by a few minutes. The
#     authoritative fact is notarytool answering `status: Accepted`, so that —
#     with a passing `codesign --verify` — is what writes the marker. The spctl
#     verdict is recorded in the marker too, as confirmation rather than as the
#     gate.
#
# Usage:
#   ./notarise-mac.sh            sign, notarise and verify build/ubersdr-tui-darwin-*
#   ./notarise-mac.sh --check    preflight only: can that Mac sign and notarise?
#   ./notarise-mac.sh --build    run ./build.sh for the two darwin targets first.
#                                Off by default on purpose: the binaries in
#                                build/ are the ones the current release assets
#                                were cut from, and signing them leaves them
#                                byte-identical apart from the signature. A
#                                rebuild would stamp a different -X main.version
#                                into them — including `-dirty` from an
#                                uncommitted tree — and put macOS out of step
#                                with the six binaries it ships beside.
#   ./notarise-mac.sh --arch=arm64
#                                just the one — arm64 or amd64.
#   ./notarise-mac.sh --publish  ...then upload the verified binaries to the
#                                `latest` release, replacing the un-notarised
#                                ones. Only what this run verified, and only if
#                                Apple accepted it.
#   ./notarise-mac.sh --keep     leave the work directory on the Mac to look at.
#
# Credentials, all shared with build-mac.sh and documented at length in its
# header:
#
#   MAC_HOST                     the Mac to work on            (default macbook)
#   MAC_KEYCHAIN_PASSWORD_FILE   unlocks the login keychain so an ssh session can
#                                reach the signing key   (~/keys/mac-keychain.password)
#   APPLE_PASSWORD_FILE          app-specific password for notarisation
#                                                        (~/keys/app.password)
#   APPLE_ID, APPLE_TEAM_ID      who is notarising

set -euo pipefail

cd "$(dirname "$0")"

MAC_HOST="${MAC_HOST:-macbook}"
MAC_DIR="${MAC_DIR:-ubersdr-tui-notarise}"
KEYCHAIN_PASSWORD_FILE="${MAC_KEYCHAIN_PASSWORD_FILE:-$HOME/keys/mac-keychain.password}"
APPLE_PASSWORD_FILE="${APPLE_PASSWORD_FILE:-$HOME/keys/app.password}"
APPLE_ID_VALUE="${APPLE_ID:-nathan@nsamail.uk}"
TEAM_ID="${APPLE_TEAM_ID:-B7CM4Z8JW8}"
BREW_BIN=/opt/homebrew/bin

# One identifier for both architectures: they are the same tool built twice, and
# a code-signing identifier is a name for the program rather than for the file.
# Named explicitly because the default is derived from the file name, which would
# make the two binaries claim to be different programs.
IDENTIFIER=org.ubersdr.tui

# Where the binaries are and go. The same two constants build.sh uses, for the
# same reason it names them: a clone with a fork as its remote must not be able
# to publish this project's downloads somewhere else.
OUT=build
REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"

CHECK=0
BUILD=0
KEEP=0
PUBLISH=0
ARCH=""

for arg in "$@"; do
    case "$arg" in
        --check) CHECK=1 ;;
        --build) BUILD=1 ;;
        --keep) KEEP=1 ;;
        --publish) PUBLISH=1 ;;
        --arch=*) ARCH="${arg#--arch=}" ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

case "$ARCH" in
    ''|arm64|amd64) ;;
    *) echo "--arch takes arm64 or amd64 (got '$ARCH')" >&2; exit 2 ;;
esac

TARGETS=()
for a in arm64 amd64; do
    [[ -z "$ARCH" || "$ARCH" == "$a" ]] && TARGETS+=("ubersdr-tui-darwin-$a")
done

# Verified this run, and the only thing --publish will upload.
VERIFIED=()

# One remote command, with the PATH a non-interactive ssh session does not get.
# The X11 warning is dropped because it is not one — the Mac offers forwarding,
# this has no display, and the line is noise in front of every command.
mac() {
    ssh -o BatchMode=yes -o ConnectTimeout=15 "$MAC_HOST" \
        "export PATH=$BREW_BIN:\$PATH; $*" \
        2> >(grep -v "X11 forwarding request failed" >&2)
}

# Run a remote command with the signing key reachable and the notarisation
# password in `$apppw`.
#
# Lifted from build-mac.sh, including why it is a wrapper rather than a step: the
# unlock has to happen in the *same* ssh session as the thing that signs, because
# each login gets a fresh security context. A separate `security unlock-keychain`
# leaves codesign failing with `errSecInternalComponent`, an error that mentions
# neither keychains nor locks. `set-key-partition-list` is needed as well —
# unlocking alone leaves a key whose ACL does not admit codesign in a non-GUI
# session, which is the trap inside the trap.
#
# Both passwords go over stdin, never in the command line: `ps` on the Mac shows
# every argument of a running command, and notarisation runs for minutes.
mac_signed() {
    if [[ ! -f "$KEYCHAIN_PASSWORD_FILE" ]]; then
        mac "$@"
        return
    fi
    # Exactly two lines, whatever the files end with. `cat file; echo` looks
    # equivalent and is not: a file already ending in a newline then yields a
    # blank second line, the app-specific password reads as empty, and the run
    # fails at notarisation having already signed everything.
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

# ---------------------------------------------------------------------------

CERT=""

preflight() {
    local ok=0

    echo
    echo "  Signing environment on $MAC_HOST"
    echo

    if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$MAC_HOST" true 2>/dev/null; then
        echo "    ssh            cannot reach $MAC_HOST without a password."
        echo "                   Set up key auth, or point MAC_HOST elsewhere."
        return 1
    fi
    echo "    ssh            $(mac 'sw_vers -productName; sw_vers -productVersion; uname -m' | tr '\n' ' ')"

    # Named in full rather than reported as present: "Developer ID Application"
    # and "Apple Development" are both certificates, and only the first produces
    # something other people can run.
    CERT="$(mac "security find-identity -v -p codesigning 2>/dev/null \
        | grep -m1 'Developer ID Application' | sed 's/.*\"\(.*\)\".*/\1/'" || true)"
    if [[ -z "$CERT" ]]; then
        echo "    certificate    none — nothing here can be notarised"
        echo "                   Needs a Developer ID Application certificate in"
        echo "                   the login keychain. Xcode → Settings → Accounts"
        echo "                   → Manage Certificates → +"
        ok=1
    else
        echo "    certificate    $CERT"

        # Having the certificate and being able to *use* it are different
        # questions over ssh, and the difference is otherwise invisible until
        # minutes in. So this signs a scratch file and looks.
        local signcheck
        signcheck="$(mac_signed "f=\$(mktemp /tmp/ubersdr-signcheck.XXXXXX); printf x > \$f; \
            codesign --sign '$CERT' --force \$f 2>&1; rm -f \$f" || true)"
        if [[ -n "$signcheck" ]]; then
            echo "    signing        cannot use that certificate over ssh:"
            echo "                   ${signcheck##*: }"
            echo
            echo "                   The key is in the login keychain and an ssh"
            echo "                   session is not allowed at it. Either leave a"
            echo "                   password file for this script to unlock with"
            echo "                   (MAC_KEYCHAIN_PASSWORD_FILE), or fix it once"
            echo "                   on the Mac with your *login* password:"
            echo "                     security unlock-keychain ~/Library/Keychains/login.keychain-db"
            echo "                     security set-key-partition-list \\"
            echo "                       -S apple-tool:,apple:,codesign: -s \\"
            echo "                       ~/Library/Keychains/login.keychain-db"
            ok=1
        else
            echo "    signing        works over ssh"
        fi
    fi

    # Validated against Apple rather than merely reported: a wrong app-specific
    # password should cost five seconds here rather than a signed binary that
    # cannot be shipped.
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
        echo "    notarisation   no credentials — signing alone is not enough."
        echo "                   Gatekeeper refuses an un-notarised download on"
        echo "                   anybody else's Mac. Put an app-specific password"
        echo "                   from appleid.apple.com in:"
        echo "                     $APPLE_PASSWORD_FILE"
        ok=1
    fi

    echo
    return $ok
}

# ---------------------------------------------------------------------------

if ! preflight; then
    echo "the Mac cannot notarise yet — see above." >&2
    exit 1
fi

if [[ "$CHECK" -eq 1 ]]; then
    echo "  ready."
    exit 0
fi

if [[ "$BUILD" -eq 1 ]]; then
    echo "  building the darwin targets"
    ./build.sh darwin-arm64 darwin-amd64 >/dev/null
fi

for t in "${TARGETS[@]}"; do
    if [[ ! -f "$OUT/$t" ]]; then
        echo "$OUT/$t is missing — run ./build.sh darwin-arm64 darwin-amd64, or pass --build." >&2
        exit 1
    fi
done

echo "  shipping to $MAC_HOST:~/$MAC_DIR"
mac "rm -rf ~/$MAC_DIR && mkdir -p ~/$MAC_DIR"
for t in "${TARGETS[@]}"; do
    ssh -o BatchMode=yes "$MAC_HOST" "cat > ~/$MAC_DIR/$t && chmod +x ~/$MAC_DIR/$t" \
        < "$OUT/$t" 2> >(grep -v "X11 forwarding request failed" >&2)
done

for t in "${TARGETS[@]}"; do
    echo
    echo "  $t"

    # Sign, submit, wait, verify — all in one ssh session, because the keychain
    # unlock only holds for the session that did it.
    #
    # --options runtime is not optional: the hardened runtime is a precondition
    # of notarisation, and Apple rejects a submission without it. Go asks nothing
    # of it in return — there is no JIT here, so unlike the Electron app this
    # needs no entitlements file at all.
    #
    # --timestamp is likewise required: a signature without a trusted timestamp
    # stops validating the day the certificate expires.
    #
    # ditto rather than zip, and --keepParent so the archive holds the file
    # rather than its contents. The zip exists only to give notarytool something
    # it will accept, and is deleted below.
    result="$(mac_signed "
        set -e
        cd ~/$MAC_DIR
        codesign --sign '$CERT' --force --timestamp --options runtime \
            --identifier '$IDENTIFIER' '$t' 2>&1 | sed 's/^/  codesign: /'
        /usr/bin/ditto -c -k --keepParent '$t' '$t.zip'
        out=\$(xcrun notarytool submit '$t.zip' \
            --apple-id '$APPLE_ID_VALUE' --team-id '$TEAM_ID' \
            --password \"\$apppw\" --wait 2>&1) || true
        rm -f '$t.zip'
        echo \"\$out\" | grep -E '^ *(id|status|message):' | tail -4
        echo \"NOTARY_STATUS=\$(echo \"\$out\" | grep -E '^ *status:' | tail -1 | sed 's/.*status: *//')\"
        codesign --verify --strict '$t' 2>&1 && echo 'CODESIGN_VERIFY=ok' || echo 'CODESIGN_VERIFY=failed'
        codesign -d --verbose=2 '$t' 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Timestamp)=' | head -4
        echo \"SPCTL=\$(spctl -a -t exec -vv '$t' 2>&1 | tr '\n' ' ')\"
    " || true)"

    echo "$result" | sed 's/^/    /'

    notary="$(sed -n 's/^NOTARY_STATUS=//p' <<<"$result" | tail -1)"
    verify="$(sed -n 's/^CODESIGN_VERIFY=//p' <<<"$result" | tail -1)"

    # Bring it back signed, whatever the verdict: a signed-but-unaccepted binary
    # is still the thing to look at when working out why.
    ssh -o BatchMode=yes "$MAC_HOST" "cat ~/$MAC_DIR/$t" > "$OUT/$t.signed" \
        2> >(grep -v "X11 forwarding request failed" >&2)
    mv "$OUT/$t.signed" "$OUT/$t"
    # The signature travels inside the Mach-O, so a byte copy carries it. The
    # executable bit does not — it is a property of the file on the Mac, and cat
    # writes a fresh one here.
    chmod +x "$OUT/$t"

    # The verdict, written down beside the binary.
    #
    # Only a Mac can answer "will Gatekeeper accept this", and publishing happens
    # from Linux — so the answer travels with the file, exactly as it does for the
    # dmgs. Unlike the dmgs the gate is Apple's verdict rather than spctl's, for
    # the reason in the header: there is no stapled ticket in a bare binary for
    # spctl to read offline, so its answer is an online lookup that can lag a
    # submission Apple has already accepted.
    marker="$OUT/$t.gatekeeper-ok"
    rm -f "$marker"
    if [[ "$notary" == "Accepted" && "$verify" == "ok" ]]; then
        echo "$result" > "$marker"
        VERIFIED+=("$OUT/$t")
        echo "    notarised and verified"
    else
        echo "    not publishable — notarytool said '${notary:-nothing}', codesign --verify said '${verify:-nothing}'"
    fi
done

[[ "$KEEP" -eq 1 ]] || mac "rm -rf ~/$MAC_DIR" || true

# ---------------------------------------------------------------------------

# Upload the darwin binaries, and nothing else.
#
# No typed confirmation, for the same reason build-mac.sh's dmg upload has none:
# what is being guarded against is not haste but shipping something Gatekeeper
# refuses, and that is already guarded by something better than a keystroke —
# every file here was signed with a Developer ID certificate and accepted by
# Apple's notary service in this run.
#
# The six other targets are not touched. They are build.sh's, they need no
# signing, and re-uploading them is not what "notarise the mac binary" means.
publish_binaries() {
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

    local uploads=()
    local f
    for f in ${VERIFIED[@]+"${VERIFIED[@]}"}; do
        [[ -f "$f" && -f "$f.gatekeeper-ok" ]] || continue
        uploads+=("$f")
    done
    if [[ "${#uploads[@]}" -eq 0 ]]; then
        echo "not published: this run produced no notarised binary." >&2
        exit 1
    fi

    echo
    echo "  uploading to https://github.com/$REPO/releases/tag/$TAG"
    for f in "${uploads[@]}"; do
        echo "      $(basename "$f")   $(du -h "$f" | cut -f1)"
    done
    # --clobber because the asset names are constants: the website links at
    # ubersdr.org point straight at them and must not move.
    gh release upload "$TAG" "${uploads[@]}" --clobber --repo "$REPO"
    echo "  published."
}

if [[ "$PUBLISH" -eq 1 ]]; then
    publish_binaries
fi

echo
if [[ "${#VERIFIED[@]}" -eq "${#TARGETS[@]}" ]]; then
    echo "done — ${#VERIFIED[@]} of ${#TARGETS[@]} notarised."
    [[ "$PUBLISH" -eq 1 ]] || echo "  ./notarise-mac.sh --publish uploads them."
else
    echo "done — ${#VERIFIED[@]} of ${#TARGETS[@]} notarised. See above." >&2
    exit 1
fi
