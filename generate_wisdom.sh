#!/bin/bash

# generate_wisdom.sh - FFTW wisdom generator for UberSDR / radiod
#
# FFTW wisdom encodes the fastest FFT plan for a specific CPU microarchitecture.
# On ARM big.LITTLE / DynamIQ systems (e.g. Rock 5 / RK3588) the LITTLE cores
# (Cortex-A55) and big cores (Cortex-A76) have different pipeline widths, cache
# sizes, and SIMD throughput.  Wisdom generated on an A55 core is WRONG for
# radiod if radiod runs on A76 cores — FFTW will use a suboptimal plan.
#
# This script detects ARM big.LITTLE topology, reads the Docker cpuset for the
# ka9q-radio service, and runs fftwf-wisdom pinned to the same CPU(s) that
# radiod will use via taskset.  On x86 or homogeneous ARM the pinning is skipped.
#
# ── The sidecar ───────────────────────────────────────────────────────────────
#
# A wisdom file records no trace of which FFT transforms it was generated for, and
# there is no way to recover that afterwards.  So a JSON sidecar is written beside
# it — <wisdom>.json — naming the transforms, the FFTW version and thread count
# used, and the SHA-256 of the wisdom file itself so a sidecar left behind by a
# replaced or restored wisdom can be told apart from a current one.
#
# That declaration is what the community catalog stores alongside the upload, and
# what lets it serve a 129.6 MSPS receiver a file that actually covers rof3240000
# instead of one that installs cleanly and leaves radiod planning from scratch.
#
# Usage:
#   generate_wisdom.sh                    generate wisdom for this receiver's rate
#   generate_wisdom.sh --max-rate         generate for both supported rates
#   generate_wisdom.sh --upload-only      upload the existing wisdom file
#   generate_wisdom.sh --upload-only --fft-sizes=rof1620000,rof3240000
#                                         ...declaring what it contains, for a file
#                                         generated before sidecars existed
#   generate_wisdom.sh --transform-json   print what the installed wisdom covers as
#                                         JSON and exit; no prompts, no output but
#                                         the JSON, exit 0 even with no wisdom

# Exit on error
set -e

# ── ARM architecture detection & helpers ─────────────────────────────────────

IS_ARM=false
case "$(uname -m 2>/dev/null)" in
    aarch64|armv7l|armv8l) IS_ARM=true ;;
esac
if grep -q 'CPU implementer' /proc/cpuinfo 2>/dev/null; then IS_ARM=true; fi

# arm_cpu_part_name IMPLEMENTER PART → human name
arm_cpu_part_name() {
    local impl="${1:-}" part="${2:-}"
    case "${impl}:${part}" in
        0x41:0xd03) echo "Cortex-A53" ;;
        0x41:0xd04) echo "Cortex-A35" ;;
        0x41:0xd05) echo "Cortex-A55" ;;
        0x41:0xd06) echo "Cortex-A65" ;;
        0x41:0xd07) echo "Cortex-A57" ;;
        0x41:0xd08) echo "Cortex-A72" ;;
        0x41:0xd09) echo "Cortex-A73" ;;
        0x41:0xd0a) echo "Cortex-A75" ;;
        0x41:0xd0b) echo "Cortex-A76" ;;
        0x41:0xd0c) echo "Neoverse-N1" ;;
        0x41:0xd0d) echo "Cortex-A77" ;;
        0x41:0xd41) echo "Cortex-A78" ;;
        0x41:0xd44) echo "Cortex-X1" ;;
        0x41:0xd46) echo "Cortex-A510" ;;
        0x41:0xd47) echo "Cortex-A710" ;;
        0x41:0xd48) echo "Cortex-X2" ;;
        0x41:0xd4d) echo "Cortex-A715" ;;
        0x41:0xd4e) echo "Cortex-X3" ;;
        0x51:0x800) echo "Kryo 2xx Gold" ;;
        0x51:0x801) echo "Kryo 2xx Silver" ;;
        0x51:0x803) echo "Kryo 3xx Silver" ;;
        0x51:0x804) echo "Kryo 4xx Gold" ;;
        0x51:0x805) echo "Kryo 4xx Silver" ;;
        *) echo "Unknown (impl=${impl} part=${part})" ;;
    esac
}

# arm_cluster_role NAME → LITTLE | big | prime | ""
arm_cluster_role() {
    case "$1" in
        *A53*|*A55*|*A35*|*A510*|*"Kryo 2xx Silver"*|*"Kryo 3xx Silver"*|*"Kryo 4xx Silver"*) echo "LITTLE" ;;
        *A57*|*A72*|*A73*|*A75*|*A76*|*A77*|*A78*|*A710*|*A715*|*"Kryo 2xx Gold"*|*"Kryo 4xx Gold"*) echo "big" ;;
        *X1*|*X2*|*X3*|*Neoverse*) echo "prime" ;;
        *) echo "" ;;
    esac
}

# Detect whether this ARM system has heterogeneous clusters
arm_is_heterogeneous() {
    $IS_ARM || return 1
    local _seen_roles=""
    local _cur_proc="" _impl="" _part=""
    while IFS= read -r _line; do
        if [[ "$_line" =~ ^processor[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
            _cur_proc="${BASH_REMATCH[1]}"
        elif [[ "$_line" =~ ^CPU\ implementer[[:space:]]*:[[:space:]]*(0x[0-9a-fA-F]+) ]]; then
            _impl="${BASH_REMATCH[1]}"
        elif [[ "$_line" =~ ^CPU\ part[[:space:]]*:[[:space:]]*(0x[0-9a-fA-F]+) ]]; then
            _part="${BASH_REMATCH[1]}"
            if [[ -n "$_impl" && -n "$_part" ]]; then
                local _cname _crole
                _cname=$(arm_cpu_part_name "$_impl" "$_part")
                _crole=$(arm_cluster_role "$_cname")
                if [[ -n "$_crole" && "$_seen_roles" != *"$_crole"* ]]; then
                    _seen_roles+=" $_crole"
                fi
            fi
        fi
    done < /proc/cpuinfo
    # Heterogeneous if more than one distinct role found
    local _count
    _count=$(echo "$_seen_roles" | wc -w)
    (( _count > 1 ))
}

# Get the CPU name for a given logical CPU number
cpu_name_for() {
    local _cpu="$1"
    local _impl="" _part="" _cur_proc="" _found=false
    while IFS= read -r _line; do
        if [[ "$_line" =~ ^processor[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
            _cur_proc="${BASH_REMATCH[1]}"
        elif [[ "$_line" =~ ^CPU\ implementer[[:space:]]*:[[:space:]]*(0x[0-9a-fA-F]+) ]]; then
            _impl="${BASH_REMATCH[1]}"
        elif [[ "$_line" =~ ^CPU\ part[[:space:]]*:[[:space:]]*(0x[0-9a-fA-F]+) ]]; then
            _part="${BASH_REMATCH[1]}"
            if [[ "$_cur_proc" == "$_cpu" ]]; then
                _found=true
                break
            fi
        fi
    done < /proc/cpuinfo
    if $_found && [[ -n "$_impl" && -n "$_part" ]]; then
        arm_cpu_part_name "$_impl" "$_part"
    else
        echo "unknown"
    fi
}

# ── Parse command line arguments ─────────────────────────────────────────────

MAX_RATE=0
UPLOAD_ONLY=0
TRANSFORM_JSON=0
FFT_SIZES_OVERRIDE=""
for arg in "$@"; do
    case $arg in
        --max-rate)
            MAX_RATE=1
            shift
            ;;
        --upload-only)
            UPLOAD_ONLY=1
            shift
            ;;
        --transform-json)
            # A query, not a run: see the block below the argument loop.
            TRANSFORM_JSON=1
            shift
            ;;
        --fft-sizes=*)
            # Declare what an existing wisdom file contains, for --upload-only on a
            # file generated before the sidecar existed (see WISDOM_META_FILE below).
            # Nothing in a wisdom file records which transforms it holds, so if the
            # sidecar is missing this is the only way to say so truthfully.
            FFT_SIZES_OVERRIDE="${arg#*=}"
            shift
            ;;
    esac
done

# ── Script directory (used for sibling script references) ─────────────────────
#
# Set before the banner because --transform-json answers below it and must print
# nothing but its JSON.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Where the wisdom and its sidecar live, and the two supported rates ────────
#
# Declared up here rather than beside the generation code because --transform-json
# needs them before any of that runs — and because a second copy of the volume path
# is exactly the kind of thing that drifts.

# UBERSDR_WISDOM_FILE overrides the location, which is what the tests point at a
# temporary file — nothing in normal operation sets it.
WISDOM_FILE="${UBERSDR_WISDOM_FILE:-/var/lib/docker/volumes/ubersdr_radiod-data/_data/wisdom}"
WISDOM_META_FILE="${WISDOM_FILE}.json"

RATE_LOW=64800000       # 0-30 MHz
RATE_HIGH=129600000     # 0-60 MHz
FFT_LOW="rof1620000"    # 64.8 MSPS at the default blocktime/overlap
FFT_HIGH="rof3240000"   # 129.6 MSPS at the default blocktime/overlap

# ── --transform-json: what does the installed wisdom actually cover? ──────────
#
# Answers the question the admin interface asks before it lets someone flip the
# front end sample rate: is there wisdom for the transform the *other* rate makes
# radiod plan? Switching to a rate with no wisdom for it is not an error — radiod
# starts and plans from scratch — but on these transform sizes that is hours of a
# dead receiver, so it is worth saying before the restart rather than after.
#
# Everything it reports comes from the sidecar (see "The sidecar" above), which is
# written on generation, on catalog download, and on upload. It never probes: a
# probe costs seconds per transform and needs fftwf-wisdom, and this runs behind a
# web request. A wisdom file with no current sidecar is reported as unknown rather
# than guessed at — "known":false — and the caller can say so honestly.
#
# Prints one line of JSON and nothing else. Exit 0 whenever the question could be
# answered, including "there is no wisdom at all", which is an answer.
emit_transform_json() {
    # The wisdom lives in a root-owned Docker volume. Read it unprivileged when the
    # permissions allow, and only then reach for sudo -n — never plain sudo, which
    # would sit waiting for a password nobody can type behind an HTTP request.
    _wis_readable() { [ -r "$1" ] || sudo -n test -r "$1" 2>/dev/null; }
    _wis_cat() {
        if [ -r "$1" ]; then cat "$1" 2>/dev/null
        elif sudo -n test -r "$1" 2>/dev/null; then sudo -n cat "$1" 2>/dev/null
        else return 1
        fi
    }
    _wis_exists() { [ -e "$1" ] || sudo -n test -e "$1" 2>/dev/null; }

    # A JSON string value, with the two characters that would break the document
    # removed. These fields come off the wire in the catalog-download path, so this
    # is not a formality.
    _json_str() { printf '%s' "${1:-}" | tr -d '"\\' | tr -d '\n\r\t'; }

    local _present=false _sha="" _readable=false
    if _wis_exists "$WISDOM_FILE"; then
        _present=true
        if _wis_readable "$WISDOM_FILE"; then
            _readable=true
            _sha=$(_wis_cat "$WISDOM_FILE" | sha256sum 2>/dev/null | awk '{print $1}') || _sha=""
        fi
    fi

    # The sidecar counts only when it describes the file that is actually there —
    # the same rule read_sidecar_sizes applies before an upload. A sidecar left
    # behind by a hand-replaced or restored wisdom names transforms this file may
    # not hold, and acting on that is the failure the sha256 is there to prevent.
    local _meta="" _meta_present=false _meta_sha="" _current=false
    local _sizes="" _src="" _fftw="" _when=""
    if _wis_exists "$WISDOM_META_FILE" && _meta=$(_wis_cat "$WISDOM_META_FILE"); then
        _meta_present=true
        _meta_sha=$(printf '%s' "$_meta" | sed -n 's/.*"wisdom_sha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p')
        if [ -n "$_sha" ] && [ "$_meta_sha" = "$_sha" ]; then
            _current=true
            _sizes=$(printf '%s' "$_meta" | sed -n 's/.*"fft_sizes"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr -d '" ' | tr ',' ' ')
            _src=$(printf '%s' "$_meta" | sed -n 's/.*"fft_sizes_source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
            _fftw=$(printf '%s' "$_meta" | sed -n 's/.*"fftw_version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
            _when=$(printf '%s' "$_meta" | sed -n 's/.*"generated_at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
        fi
    fi

    # No wisdom is a definite answer — it covers nothing. Unknown is only for a file
    # whose contents cannot be established: present, but with no current sidecar.
    local _known=true
    if [ "$_present" = true ] && [ "$_current" != true ]; then
        _known=false
    fi

    # The transform name is not a property of the sample rate alone: radiod plans
    # N = samprate x blocktime x overlap/(overlap-1), so a receiver with a non-default
    # blocktime or overlap lands on names that are neither rof1620000 nor rof3240000.
    # Ask get-samprate.sh for this receiver's values and derive both names from them,
    # so the answer is about this machine rather than about the defaults.
    local _blocktime="" _overlap=""
    local _sr_info
    _sr_info=$("${SCRIPT_DIR}/get-samprate.sh" 2>/dev/null || true)
    if [ -n "$_sr_info" ]; then
        _blocktime=$(printf '%s' "$_sr_info" | sed -n 's/^blocktime=//p' | head -1)
        _overlap=$(printf '%s' "$_sr_info" | sed -n 's/^overlap=//p' | head -1)
    fi
    # ka9q-radio's defaults, and the ones get-samprate.sh falls back to.
    _blocktime="${_blocktime:-0.02}"
    _overlap="${_overlap:-5}"

    _fft_name_for() {
        awk -v s="$1" -v b="$_blocktime" -v o="$_overlap" \
            'BEGIN{ if (o <= 1) exit 1; printf "rof%.0f", (s * b) * o / (o - 1) }' 2>/dev/null
    }

    # covered: does the sidecar's list contain this rate's transform? Extra
    # transforms in the file are harmless; a missing one is the whole point.
    _covered_for() {
        [ "$_known" = true ] || { echo false; return; }
        case " $_sizes " in
            *" $1 "*) echo true ;;
            *)        echo false ;;
        esac
    }

    local _rates_json="" _rate _name
    for _rate in "$RATE_LOW" "$RATE_HIGH"; do
        _name=$(_fft_name_for "$_rate")
        [ -n "$_rates_json" ] && _rates_json="${_rates_json},"
        _rates_json="${_rates_json}{\"samprate\":${_rate},\"fft_name\":\"${_name}\",\"covered\":$(_covered_for "$_name")}"
    done

    local _sizes_json="" _sz
    for _sz in $_sizes; do
        [ -n "$_sizes_json" ] && _sizes_json="${_sizes_json},"
        _sizes_json="${_sizes_json}\"$(_json_str "$_sz")\""
    done

    printf '{"schema":1,"wisdom_file":"%s","wisdom_present":%s,"readable":%s,"wisdom_sha256":"%s",' \
        "$(_json_str "$WISDOM_FILE")" "$_present" "$_readable" "$(_json_str "$_sha")"
    printf '"sidecar_present":%s,"sidecar_current":%s,"known":%s,' \
        "$_meta_present" "$_current" "$_known"
    printf '"fft_sizes":[%s],"fft_sizes_source":"%s","fftw_version":"%s","generated_at":"%s",' \
        "$_sizes_json" "$(_json_str "$_src")" "$(_json_str "$_fftw")" "$(_json_str "$_when")"
    printf '"blocktime":"%s","overlap":"%s","rates":[%s]}\n' \
        "$(_json_str "$_blocktime")" "$(_json_str "$_overlap")" "$_rates_json"
}

if [ $TRANSFORM_JSON -eq 1 ]; then
    emit_transform_json
    exit 0
fi

echo "=== UberSDR FFTW Wisdom Generator ==="
echo

# ── Dependency checks ─────────────────────────────────────────────────────────

# Check if tmux is installed
if ! command -v tmux &> /dev/null; then
    echo "Error: tmux is not installed. Please install it first:"
    echo "  sudo apt install -y tmux"
    exit 1
fi

# Check if fftwf-wisdom is installed (check under sudo context)
if ! sudo which fftwf-wisdom &> /dev/null; then
    echo "Error: fftwf-wisdom is not installed. Please install it first:"
    echo "  sudo apt install -y libfftw3-bin"
    exit 1
fi

# ── Compute CPU hash for wisdom catalog lookup ────────────────────────────────

CPU_HASH=$("${SCRIPT_DIR}/get-cpu.sh" --hash-only 2>/dev/null || true)
CPU_NAME=$("${SCRIPT_DIR}/get-cpu.sh" 2>/dev/null | grep -i 'CPU Name' | sed 's/.*:[[:space:]]*//' | xargs || true)

# ── Which FFT sizes this receiver needs ───────────────────────────────────────
#
# Worked out here, before any prompt, rather than down in the generation section where
# it used to live. The operator is about to be asked whether to download precomputed
# wisdom or generate their own — a choice between minutes and several hours — and on a
# 129.6 MSPS receiver "generate my own" means two transforms, the larger of which is
# hours by itself. That is not something to disclose after the decision.

# FFT_LOW / FFT_HIGH are defined near the top, beside the wisdom paths, because
# --transform-json answers before this point is reached.

# `|| true` because set -e is on: without it a missing helper — or a receiver that
# cannot be reached — takes the whole script down instead of falling through to the
# warning below. Same guard the get-cpu.sh calls above use.
_SR_INFO=$("${SCRIPT_DIR}/get-samprate.sh" 2>/dev/null || true)
if [ -n "$_SR_INFO" ]; then
    eval "$_SR_INFO"
    echo
    echo "Front end is running at $(awk -v s="$samprate" 'BEGIN{printf "%.4g", s/1e6}') MSPS"
    echo "  (read from $([ "${source:-}" = "api" ] && echo "the running server" || echo "the radiod config"))"
    echo "  blocktime ${blocktime}s, overlap ${overlap} -> radiod plans ${fft_name}"

    if [ "$fft_name" = "$FFT_HIGH" ]; then
        # At the high rate, generate for both — deliberately, and not symmetrically with
        # the low rate.
        #
        # 129.6 MSPS is the rate an operator drops *back* from: it runs the RX888 MkII
        # hot enough to damage it without thermal work, and a receiver that cannot
        # sustain the USB throughput loses samples. Both of those end with someone
        # setting 64800000 and restarting — and finding radiod planning rof1620000 with
        # no wisdom for it, hours after the wisdom run they thought had finished the job.
        #
        # The extra size is also the cheap one here: whoever is at 129.6 has already
        # accepted the several-hour rof3240000 generation, and rof1620000 beside it is a
        # small fraction of that.
        FFT_SIZES="$FFT_HIGH $FFT_LOW"
        echo
        echo "Generating for BOTH sample rates (${FFT_SIZES})."
        echo "  At 129.6 MSPS the 64.8 wisdom is generated too, so dropping back to the"
        echo "  safe rate does not leave radiod planning a transform with no wisdom."
    else
        FFT_SIZES="$fft_name"

        # At the low rate, offer the other one — because this is the only moment at
        # which it is cheap to decide.
        #
        # The admin interface refuses to switch the front end to a rate whose transform
        # has no wisdom, so someone who runs this at 64.8 and later wants 0-60 MHz has
        # to come back and do the whole thing again. Asked rather than assumed: unlike
        # the 129.6 case above, where the extra size is a small fraction of what has
        # already been accepted, here it is the expensive one and the answer is a real
        # trade rather than an obvious yes.
        #
        # Only when a person is actually there to answer. --upload-only is documented as
        # non-interactive, and a piped stdin means the read would take EOF as the reply.
        if [ "$samprate" = "$RATE_LOW" ] && [ $MAX_RATE -eq 0 ] && [ $UPLOAD_ONLY -eq 0 ] && [ -t 0 ]; then
            # Doubling the sample rate doubles the transform exactly, so this is right
            # for a receiver with a non-default blocktime or overlap too — where neither
            # name is rof1620000 or rof3240000.
            _other_fft=$(awk -v n="$fft_size" 'BEGIN{printf "rof%.0f", n*2}')
            echo
            echo "The other supported rate, 129.6 MSPS (0-60 MHz), plans ${_other_fft}."
            echo "  The admin interface will not switch the front end to a rate it has no"
            echo "  wisdom for, so adding it now is what makes that switch possible later"
            echo "  without a second run of this script."
            echo "  If the catalog has a file covering both, this is free — same download,"
            echo "  same few seconds. If it does not, ${_other_fft} is generated here"
            echo "  instead and may take SEVERAL HOURS on its own."
            read -p "  Also generate wisdom for 129.6 MSPS (${_other_fft})? (y/N): " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                FFT_SIZES="$fft_name $_other_fft"
                echo "  Generating for BOTH sample rates (${FFT_SIZES})."
            else
                echo "  Generating for ${fft_name} only. Re-run with --max-rate to cover both."
            fi
        fi
    fi
else
    FFT_SIZES="$FFT_LOW"
    echo
    # Name the actual cause. A missing helper is a packaging fault and is fixed by
    # re-running the installer; a helper that ran and found nothing means the receiver
    # could not be reached. Saying "is UberSDR running?" for both sends people to look
    # in the wrong place.
    if [ ! -x "${SCRIPT_DIR}/get-samprate.sh" ]; then
        echo "WARNING: ${SCRIPT_DIR}/get-samprate.sh is missing, so the front end sample"
        echo "         rate could not be read. Re-run the installer to fetch it:"
        echo "           curl -fsSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/main/install-hub.sh | bash -s --"
    else
        echo "WARNING: could not read the front end sample rate — is UberSDR running?"
        echo "         Start it, or check ${UBERSDR_URL:-http://localhost:8080}/api/description."
    fi
    echo
    echo "         Assuming 64.8 MSPS (${FFT_SIZES}). If this receiver runs at 129.6 MSPS"
    echo "         this generates wisdom for a transform radiod never plans, and the one"
    echo "         it does plan gets none — hours of work for nothing."
    echo "         Re-run with --max-rate to cover both rates regardless."
fi

# --max-rate forces both even at the low rate: for a receiver about to be raised to
# 129.6, so the wisdom is ready before the change rather than hours after it. At the high
# rate both are already included and this changes nothing.
if [ $MAX_RATE -eq 1 ]; then
    _added=0
    for _both in "$FFT_HIGH" "$FFT_LOW"; do
        case " $FFT_SIZES " in
            *" $_both "*) ;;
            *) FFT_SIZES="$_both $FFT_SIZES"; _added=1 ;;
        esac
    done
    # Only say so if it actually changed something — at the high rate both are already
    # in, and repeating the same sentence reads as two different decisions.
    if [ $_added -eq 1 ]; then
        echo
        echo "--max-rate: generating for both sample rates (${FFT_SIZES})."
    fi
fi

# One sentence about what it costs, used by the prompts below and stated again just
# before generation actually starts.
case " $FFT_SIZES " in
    *" $FFT_HIGH "*) FFT_COST_NOTE="${FFT_HIGH} alone may take SEVERAL HOURS." ;;
    *)               FFT_COST_NOTE="Expect this to take a while, but not hours." ;;
esac
case " $FFT_SIZES " in
    *" $FFT_HIGH "*)
        echo
        echo "WARNING: ${FFT_COST_NOTE}" ;;
esac

# ── Is this a transform set the community catalog carries? ────────────────────
#
# The catalog stores wisdom for the two transforms the supported front end sample
# rates produce, and nothing else. A receiver with a non-default blocktime or
# overlap lands on a third name — the forward FFT length is
# N = samprate x blocktime x overlap/(overlap-1) — and for those, local generation
# works exactly as before but there is nothing to download and nothing to upload.
#
# Checked here, before any network call, so such a receiver is told once at the
# start rather than getting an HTTP 400 after several hours of generation.
CATALOG_FFT_SIZES="${FFT_LOW} ${FFT_HIGH}"
CATALOG_ELIGIBLE=1
for _sz in $FFT_SIZES; do
    case " $CATALOG_FFT_SIZES " in
        *" $_sz "*) ;;
        *) CATALOG_ELIGIBLE=0 ;;
    esac
done
if [ $CATALOG_ELIGIBLE -eq 0 ]; then
    echo
    echo "NOTE: ${FFT_SIZES} is not a transform the community catalog carries"
    echo "      (it holds ${FFT_LOW} and ${FFT_HIGH} only)."
    echo "      Wisdom will be generated locally as normal, but nothing will be"
    echo "      downloaded or uploaded."
fi

# Validate --fft-sizes now, for the same reason: an unusable value should stop the
# script here, not after the upload has been prepared.
if [ -n "$FFT_SIZES_OVERRIDE" ]; then
    for _sz in $(echo "$FFT_SIZES_OVERRIDE" | tr ',' ' '); do
        case " $CATALOG_FFT_SIZES " in
            *" $_sz "*) ;;
            *)
                echo "Error: --fft-sizes value '${_sz}' is not one the catalog accepts." >&2
                echo "       Accepted: ${CATALOG_FFT_SIZES}" >&2
                exit 1 ;;
        esac
    done
fi

# The FFTW version the local tools are built against. Wisdom from a different
# version is silently ignored on import rather than rejected, which shows up as
# "wisdom installed, radiod still slow" — so it is recorded with every upload and
# compared against on every download.
FFTW_VERSION=$(fftwf-wisdom --version 2>&1 | sed -n 's/.*FFTW version \([0-9][0-9.]*[0-9]\).*/\1/p' | head -1)

echo

# ── ARM big.LITTLE: determine which CPUs to pin wisdom generation to ──────────
#
# FFTW wisdom is CPU-microarchitecture-specific.  On big.LITTLE systems,
# wisdom generated on LITTLE cores (e.g. Cortex-A55) will produce a suboptimal
# FFT plan when radiod runs on big cores (e.g. Cortex-A76), because the two
# core types have different pipeline widths, SIMD throughput, and cache sizes.
#
# We read the Docker cpuset for ka9q-radio from docker-compose.yml and pin
# fftwf-wisdom to those same CPUs via taskset.

TASKSET_PREFIX=""
WISDOM_CPU_DESC=""

if $IS_ARM && arm_is_heterogeneous; then
    echo "  Detected ARM big.LITTLE / DynamIQ system."
    echo

    # Find docker-compose.yml
    COMPOSE_FILE=""
    for _candidate in \
        "${SCRIPT_DIR}/docker-compose.yml" \
        "$HOME/ubersdr/docker-compose.yml" \
        "/opt/ubersdr/docker-compose.yml"; do
        if [[ -f "$_candidate" ]]; then
            COMPOSE_FILE="$_candidate"
            break
        fi
    done

    RADIOD_CPUSET=""
    if [[ -n "$COMPOSE_FILE" ]]; then
        # Extract cpuset from ka9q-radio service block.
        # Uses sed-based extraction for portability (mawk doesn't support
        # match() with a capture-group array argument).
        RADIOD_CPUSET=$(awk '
            /^  ka9q-radio:[[:space:]]*(#.*)?$/ { in_block=1; next }
            in_block && /^  [^[:space:]#]/ { in_block=0 }
            in_block && /^[[:space:]]+cpuset:/ { print; exit }
        ' "$COMPOSE_FILE" 2>/dev/null \
        | sed 's/.*cpuset:[[:space:]]*"\?\([^"#[:space:]]*\)"\?.*/\1/' \
        | tr -d '[:space:]' \
        || echo "")
    fi

    if [[ -n "$RADIOD_CPUSET" ]]; then
        # Identify the cluster type of the first CPU in the cpuset
        _first_cpu="${RADIOD_CPUSET%%,*}"
        _first_cpu="${_first_cpu%%-*}"   # handle range like "4-7"
        _cname=$(cpu_name_for "$_first_cpu")
        _crole=$(arm_cluster_role "$_cname")

        echo "  ┌─────────────────────────────────────────────────────────────────┐"
        echo "  │  ⚠  FFTW WISDOM MUST MATCH THE CPU TYPE RADIOD RUNS ON          │"
        echo "  ├─────────────────────────────────────────────────────────────────┤"
        echo "  │  FFTW wisdom encodes the fastest FFT plan for a specific CPU.   │"
        echo "  │  On big.LITTLE systems, wisdom from LITTLE cores is WRONG for   │"
        echo "  │  radiod if it runs on big cores (different SIMD/cache/pipeline).│"
        echo "  └─────────────────────────────────────────────────────────────────┘"
        echo
        echo "  Docker cpuset for ka9q-radio: ${RADIOD_CPUSET}"
        if [[ -n "$_crole" ]]; then
            echo "  Cluster type: ${_crole} (${_cname})"
        fi
        echo
        echo "  fftwf-wisdom will be pinned to CPU(s) ${RADIOD_CPUSET} via taskset"
        echo "  to ensure the wisdom matches the microarchitecture radiod uses."
        echo

        TASKSET_PREFIX="taskset -c ${RADIOD_CPUSET}"
        WISDOM_CPU_DESC=" [pinned to CPUs ${RADIOD_CPUSET} / ${_crole}(${_cname})]"

    else
        # No cpuset found — build cluster map and ask user which type to use
        echo "  ┌─────────────────────────────────────────────────────────────────┐"
        echo "  │  ⚠  No CPU pinning configured for radiod                        │"
        echo "  ├─────────────────────────────────────────────────────────────────┤"
        echo "  │  FFTW wisdom is CPU-microarchitecture-specific.                 │"
        echo "  │  On big.LITTLE systems, wisdom from LITTLE cores is WRONG for   │"
        echo "  │  radiod if it runs on big cores (different SIMD/cache/pipeline).│"
        echo "  │                                                                  │"
        echo "  │  Please choose which cluster type to generate wisdom for.       │"
        echo "  └─────────────────────────────────────────────────────────────────┘"
        echo

        # Build cluster → CPU list map from /proc/cpuinfo
        declare -A _wis_cluster_cpus=()
        declare -A _wis_cluster_name=()
        _wis_cur_proc="" _wis_impl="" _wis_part=""
        while IFS= read -r _wis_line; do
            if [[ "$_wis_line" =~ ^processor[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
                _wis_cur_proc="${BASH_REMATCH[1]}"
                _wis_impl=""
                _wis_part=""
            elif [[ "$_wis_line" =~ ^CPU\ implementer[[:space:]]*:[[:space:]]*(0x[0-9a-fA-F]+) ]]; then
                _wis_impl="${BASH_REMATCH[1]}"
            elif [[ "$_wis_line" =~ ^CPU\ part[[:space:]]*:[[:space:]]*(0x[0-9a-fA-F]+) ]]; then
                _wis_part="${BASH_REMATCH[1]}"
                if [[ -n "$_wis_cur_proc" && -n "$_wis_impl" && -n "$_wis_part" ]]; then
                    _wn=$(arm_cpu_part_name "$_wis_impl" "$_wis_part")
                    _wr=$(arm_cluster_role "$_wn")
                    if [[ -n "$_wr" ]]; then
                        _wis_cluster_cpus["$_wr"]+="${_wis_cur_proc} "
                        _wis_cluster_name["$_wr"]="$_wn"
                    fi
                fi
            fi
        done < /proc/cpuinfo

        # Show available clusters
        echo "  Available CPU clusters on this system:"
        echo ""
        _wis_avail_roles=()
        for _wr in LITTLE big prime; do
            [[ -z "${_wis_cluster_cpus[$_wr]:-}" ]] && continue
            _wis_cpu_csv=$(echo "${_wis_cluster_cpus[$_wr]}" | tr ' ' ',' | sed 's/,$//')
            _wis_cname="${_wis_cluster_name[$_wr]}"
            _rec=""
            [[ "$_wr" == "big" || "$_wr" == "prime" ]] && _rec="  ← recommended for radiod"
            printf "    %-8s  %-20s  CPUs=[%s]%s\n" "$_wr" "$_wis_cname" "$_wis_cpu_csv" "$_rec"
            _wis_avail_roles+=("${_wr,,}")
        done
        echo ""

        # Default: big, then prime, then LITTLE
        _wis_default="little"
        [[ -n "${_wis_cluster_cpus[big]:-}" ]]   && _wis_default="big"
        [[ -z "${_wis_cluster_cpus[big]:-}" && -n "${_wis_cluster_cpus[prime]:-}" ]] && _wis_default="prime"

        _wis_roles_str=$(IFS='/'; echo "${_wis_avail_roles[*]}")

        _chosen_role=""
        while true; do
            read -p "  Which cluster type should wisdom be generated for? [${_wis_roles_str}] (default: ${_wis_default}): " -r _wis_input
            _wis_input="${_wis_input:-${_wis_default}}"
            case "${_wis_input,,}" in
                little) _chosen_role="LITTLE"; break ;;
                big)    _chosen_role="big";    break ;;
                prime)  _chosen_role="prime";  break ;;
                *) echo "  Please enter one of: ${_wis_roles_str}" ;;
            esac
        done
        echo

        # Pick the first CPU of the chosen cluster for taskset
        _chosen_first=$(echo "${_wis_cluster_cpus[$_chosen_role]}" | awk '{print $1}')
        _chosen_cname="${_wis_cluster_name[$_chosen_role]:-}"

        echo "  Wisdom will be generated on CPU ${_chosen_first} (${_chosen_role}: ${_chosen_cname})"
        echo "  (using taskset -c ${_chosen_first} to pin fftwf-wisdom to this core type)"
        echo

        TASKSET_PREFIX="taskset -c ${_chosen_first}"
        WISDOM_CPU_DESC=" [pinned to CPU ${_chosen_first} / ${_chosen_role}(${_chosen_cname})]"
    fi
fi

# ── Wisdom file and session setup ─────────────────────────────────────────────

# WISDOM_FILE / WISDOM_META_FILE are defined near the top; see --transform-json.
SESSION_NAME="generate-wisdom"

# ── The sidecar, and why it exists ────────────────────────────────────────────
#
# An FFTW wisdom file is a list of codelet-level solutions keyed by internal
# problem hashes. Nothing in it names the transforms it was generated for, and
# there is no way to work that out afterwards. So the file is useless to anyone
# else unless it is accompanied by a record of how it was built — which is what
# ${WISDOM_META_FILE} is.
#
# It carries the wisdom file's SHA-256 so it can be told apart from a stale
# sidecar left behind when the wisdom is replaced by hand or restored from
# ${WISDOM_FILE}.backup. A sidecar that names a different file is ignored rather
# than believed: a wrong declaration sends someone else's receiver wisdom that
# does not cover the transform it plans.
#
# The upload logic is emitted as a standalone script rather than written inline
# three times. Post-generation it has to run inside the tmux session, where a
# shell function from this script is not available and an inline command string
# would need several layers of quote escaping to survive.
write_upload_helper() {
    local _path="$1"
    # Values fixed at emit time. Single-quoted so nothing in them is re-expanded
    # when the helper runs, possibly hours later inside tmux.
    cat > "$_path" <<HELPER_VARS
#!/bin/bash
# Emitted by generate_wisdom.sh — writes the wisdom sidecar and uploads to the
# community catalog. Usage: $(basename "$_path") declared|existing
WISDOM_FILE='${WISDOM_FILE}'
WISDOM_META_FILE='${WISDOM_META_FILE}'
SCRIPT_DIR='${SCRIPT_DIR}'
FFT_SIZES='${FFT_SIZES}'
FFT_SIZES_OVERRIDE='${FFT_SIZES_OVERRIDE}'
FFTW_VERSION='${FFTW_VERSION}'
PLANNER_FLAGS='-v -T 1'
NTHREADS=1
PROBE_SIZES='${CATALOG_FFT_SIZES}'
PROBE_TIMEOUT=\${UBERSDR_WISDOM_PROBE_TIMEOUT:-5}
CATALOG_ELIGIBLE=${CATALOG_ELIGIBLE}
CATALOG_URL='https://instances.ubersdr.org/api/fftw-wisdom'
HELPER_VARS

    cat >> "$_path" <<'HELPER_BODY'

MODE="${1:-existing}"

sudo test -f "$WISDOM_FILE" || { echo "  No wisdom file at ${WISDOM_FILE}." >&2; exit 1; }

# The wisdom lives in a root-owned Docker volume, so everything below works on a
# user-readable copy that curl and sha256sum can actually open.
_wisdom_tmp=$(mktemp)
sudo cp "$WISDOM_FILE" "$_wisdom_tmp" 2>/dev/null || { echo "  Could not read the wisdom file." >&2; rm -f "$_wisdom_tmp"; exit 1; }
sudo chmod 644 "$_wisdom_tmp" 2>/dev/null
_sha256=$(sha256sum "$_wisdom_tmp" | awk '{print $1}')

# write_sidecar <space-separated sizes> — one line, so it can be read back with a
# single sed rather than a JSON parser.
write_sidecar() {
    local _sizes="$1" _src="${2:-declared}" _json_sizes="" _sz
    for _sz in $_sizes; do
        [ -n "$_json_sizes" ] && _json_sizes="${_json_sizes},"
        _json_sizes="${_json_sizes}\"${_sz}\""
    done
    printf '{"schema":1,"fft_sizes":[%s],"fft_sizes_source":"%s","wisdom_sha256":"%s","fftw_version":"%s","nthreads":%s,"planner_flags":"%s","generated_at":"%s","generator":"generate_wisdom.sh"}\n' \
        "$_json_sizes" "$_src" "$_sha256" "$FFTW_VERSION" "$NTHREADS" "$PLANNER_FLAGS" \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | sudo tee "$WISDOM_META_FILE" >/dev/null
    sudo chmod 644 "$WISDOM_META_FILE" 2>/dev/null
}

# read_sidecar_sizes — echoes the declared sizes, but only if the sidecar
# describes the file we are actually holding.
read_sidecar_sizes() {
    sudo test -f "$WISDOM_META_FILE" || return 1
    local _meta _meta_sha
    _meta=$(sudo cat "$WISDOM_META_FILE" 2>/dev/null) || return 1
    _meta_sha=$(printf '%s' "$_meta" | sed -n 's/.*"wisdom_sha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p')
    [ "$_meta_sha" = "$_sha256" ] || return 1
    printf '%s' "$_meta" | sed -n 's/.*"fft_sizes"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr -d '" ' | tr ',' ' '
}

# probe_wisdom_sizes — work out what a wisdom file contains without a sidecar.
#
# Nothing in a wisdom file names its transforms and no parser will recover them.
# But membership can be *tested*: ask fftwf-wisdom to plan the transform with only
# this file imported, and see whether planning returns immediately. A plan already
# in the file comes back in well under a second; one that is not there is planned
# from scratch, which for these sizes runs for hours and is cut off by the timeout.
#
# -n is essential — without it a plan sitting in /etc/fftw/wisdomf would be found
# and the file would be credited with a transform it does not have. The planner
# flags must also match the ones the file was generated with (PLANNER_FLAGS above,
# i.e. -T 1 and the default PATIENT mode).
#
# The failure is one-sided by construction. With no other wisdom source a fast
# result must have come from this file, so a false positive is not possible; a
# false negative — a file written by a different FFTW version, whose entries this
# binary ignores — simply lands back on the conservative declaration that applies
# when nothing is known. So this can add information but never wrong information.
#
# Runs on the readable copy rather than the original, and niced, since this is
# CPU-bound work on a machine that is probably receiving.
#
# On the timeout: a hit is startup plus a hash lookup, measured at 42-60 ms for
# rof1620000 on an RK3588 with a load average of 9.5, niced, pinned to a LITTLE
# core — i.e. the slowest placement on the slowest machine in the fleet, busy. The
# floor (startup and wisdom import alone) is 12 ms. Five seconds is therefore
# roughly eighty times the worst measured hit, while costing a machine that lacks
# the larger transform five seconds rather than the half-minute an arbitrarily
# large timeout would. Raise it with UBERSDR_WISDOM_PROBE_TIMEOUT if a machine
# ever turns out to be slower than that by two orders of magnitude.
probe_wisdom_sizes() {
    local _found="" _sz _rc
    echo "  Checking which transforms this wisdom contains (up to ${PROBE_TIMEOUT}s per transform)..." >&2
    for _sz in $PROBE_SIZES; do
        nice -n 19 timeout "$PROBE_TIMEOUT" \
            fftwf-wisdom -n -T "$NTHREADS" -w "$_wisdom_tmp" -o /dev/null "$_sz" >/dev/null 2>&1
        _rc=$?
        if [ $_rc -eq 0 ]; then
            _found="${_found}${_found:+ }${_sz}"
            echo "    ${_sz}: present" >&2
        else
            echo "    ${_sz}: not present" >&2
        fi
    done
    printf '%s' "$_found"
}

_build_file=""
case "$MODE" in
    declared)
        # Straight after a generation run: we know exactly what was planned.
        write_sidecar "$FFT_SIZES" "declared"
        _build_file="$WISDOM_META_FILE"
        ;;
    *)
        # An existing file. Trust the sidecar if it matches, otherwise fall back to
        # what the operator declared with --fft-sizes. With neither, send no build
        # field at all rather than a guess — the catalog then records the file as
        # 64.8 MSPS only, which is all a release predating the sidecar could build.
        _sizes=$(read_sidecar_sizes) || _sizes=""
        _source="declared"
        if [ -z "$_sizes" ] && [ -n "$FFT_SIZES_OVERRIDE" ]; then
            # An explicit declaration outranks measurement: the operator may know
            # the file came from a machine whose FFTW this one cannot read.
            _sizes=$(echo "$FFT_SIZES_OVERRIDE" | tr ',' ' ')
            write_sidecar "$_sizes" "declared"
        fi
        if [ -z "$_sizes" ]; then
            # No sidecar and no declaration — the case every wisdom file generated
            # before sidecars existed falls into. Measure it.
            _sizes=$(probe_wisdom_sizes)
            [ -n "$_sizes" ] && write_sidecar "$_sizes" "probed"
        fi
        if [ -n "$_sizes" ]; then
            _build_file="$WISDOM_META_FILE"
        else
            # Probing found none of them. That is a measurement, not a gap in the
            # records, and it contradicts the assumption a sidecar-less file would
            # otherwise get. Most likely this wisdom was written by a different FFTW
            # version, whose entries this binary ignores — in which case the file may
            # be perfectly good for someone else, but nothing here can say what is in
            # it. Uploading it under a transform it may not hold is the exact failure
            # this catalog exists to prevent, so skip it and say why.
            echo "  ℹ Skipping upload: could not establish what this wisdom contains."
            echo "    There is no sidecar, and probing found none of ${PROBE_SIZES} in it."
            echo "    That usually means it was built by a different FFTW version than"
            echo "    the ${FFTW_VERSION:-local} one, so its entries cannot be read here."
            echo "    If you know what it holds, declare it explicitly:"
            echo "      generate_wisdom.sh --upload-only --fft-sizes=rof1620000,rof3240000"
            rm -f "$_wisdom_tmp"
            exit 0
        fi
        ;;
esac

if [ "$CATALOG_ELIGIBLE" != "1" ]; then
    rm -f "$_wisdom_tmp"
    exit 0
fi

_uuid=$(bash "${SCRIPT_DIR}/get-uuid.sh" 2>/dev/null) || { rm -f "$_wisdom_tmp"; exit 0; }
_meta_tmp=$(mktemp)
if ! bash "${SCRIPT_DIR}/get-cpu.sh" --json 2>/dev/null > "$_meta_tmp"; then
    echo "  Could not identify the CPU — skipping upload." >&2
    rm -f "$_wisdom_tmp" "$_meta_tmp"
    exit 1
fi

# The build field is optional; -F is only added when there is something truthful
# to put in it.
_build_tmp=""
_build_args=()
if [ -n "$_build_file" ]; then
    _build_tmp=$(mktemp)
    sudo cat "$_build_file" > "$_build_tmp" 2>/dev/null && _build_args=(-F "build=<${_build_tmp};type=application/json")
fi

# Keep the response body: a 400 can mean an unsupported transform, a stale
# sidecar, or malformed CPU metadata, and guessing which wastes the operator's
# time. The catalog puts the reason in an "error" field.
_resp=$(mktemp)
_up=$(curl -sS -o "$_resp" -w '%{http_code}' -X POST \
    -F "meta=<${_meta_tmp};type=application/json" \
    -F "wisdom=@${_wisdom_tmp};type=application/octet-stream" \
    -F "sha256=${_sha256}" \
    "${_build_args[@]}" \
    "${CATALOG_URL}/${_uuid}" 2>/dev/null)

_reason=$(sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_resp" 2>/dev/null)
_stored=$(sed -n 's/.*"fft_sizes"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_resp" 2>/dev/null)

rm -f "$_wisdom_tmp" "$_meta_tmp" "$_resp"
[ -n "$_build_tmp" ] && rm -f "$_build_tmp"

case "$_up" in
    201) echo "  ✓ Wisdom uploaded to the community catalog${_stored:+ (${_stored//,/ })}" ;;
    409) echo "  ℹ The catalog already covers these transforms for this CPU" ;;
    401) echo "  ℹ Could not upload wisdom (instance not yet registered)" ;;
    400) echo "  ℹ The catalog rejected the upload${_reason:+: ${_reason}}" ;;
    *)   echo "  ℹ Wisdom upload skipped (HTTP ${_up})${_reason:+: ${_reason}}" ;;
esac
exit 0
HELPER_BODY
    chmod 755 "$_path"
}

# ── --upload-only: upload existing wisdom and exit, no interactivity ──────────

if [ $UPLOAD_ONLY -eq 1 ]; then
    if ! sudo test -f "$WISDOM_FILE"; then
        echo "No wisdom file found at ${WISDOM_FILE} — nothing to upload." >&2
        exit 1
    fi
    if [ $CATALOG_ELIGIBLE -eq 0 ]; then
        echo "This receiver plans ${FFT_SIZES}, which the catalog does not carry — nothing to upload." >&2
        exit 1
    fi
    _helper=$(mktemp)
    write_upload_helper "$_helper"
    # set -e is on, so the failure has to be caught here for the temp file to be
    # cleaned up and the helper's exit status passed through.
    _rc=0
    bash "$_helper" existing || _rc=$?
    rm -f "$_helper"
    exit $_rc
fi

# If session already exists, re-attach to it (wisdom generation still running)
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "Tmux session '$SESSION_NAME' already exists — attaching to it..."
    echo "(Wisdom generation is already in progress)"
    echo
    sleep 1
    tmux attach -t "$SESSION_NAME"
    exit 0
fi

# ── Existing wisdom: noted here, decided later ────────────────────────────────
#
# This used to ask "a wisdom file already exists, regenerate it? (y/N)" right here,
# defaulting to no and exiting — before the catalog had been consulted. That made
# the answer to "should I take the better wisdom that now exists for my CPU?"
# unreachable behind a question about spending hours regenerating, and the default
# answer was the one that skipped it. A receiver holding 64.8 MSPS wisdom could
# never discover that a file covering both rates had appeared for its CPU.
#
# So the file's presence is only recorded here. The catalog runs first, and
# whichever choice the operator is then offered is one they can actually make
# knowing what is on the table.
HAVE_LOCAL_WISDOM=0
if sudo test -f "$WISDOM_FILE"; then
    HAVE_LOCAL_WISDOM=1
    echo "Note: a wisdom file already exists at ${WISDOM_FILE}"
    echo "      (it will be backed up before anything replaces it)"
    echo
fi

# Set once the operator has knowingly chosen local generation, so the fallback
# prompt further down does not ask a second time.
GENERATION_CONFIRMED=0

# Copy the current wisdom aside before anything overwrites it. The sidecar travels
# with the file it describes: restoring a backup without it would leave a wisdom
# file nobody can say anything about, which is the situation the sidecar exists to
# avoid.
backup_existing_wisdom() {
    [ $HAVE_LOCAL_WISDOM -eq 1 ] || return 0
    BACKUP_FILE="${WISDOM_FILE}.backup"
    echo "Copying existing wisdom file to ${BACKUP_FILE}..."
    sudo cp "$WISDOM_FILE" "$BACKUP_FILE"
    if sudo test -f "$WISDOM_META_FILE"; then
        sudo cp "$WISDOM_META_FILE" "${WISDOM_META_FILE}.backup"
    fi
    echo "Backup created at ${BACKUP_FILE}"
    echo
}

# Offer the wisdom already on this machine to the catalog, then leave. Used by the
# paths where the operator decides to keep what they have.
keep_existing_and_exit() {
    echo "  Keeping the existing wisdom file."
    _helper=$(mktemp)
    write_upload_helper "$_helper"
    bash "$_helper" existing || true
    rm -f "$_helper"
    exit 0
}

# ── Try to download precomputed wisdom from the catalog ───────────────────────
#
# The catalog is keyed by CPU hash (8-char SHA-256 prefix of the cpu_key).
# If a precomputed wisdom is available, the user is offered the choice to use
# it (saving several hours of local generation) or generate their own.
#
# Error handling:
#   • curl errors (network/timeout) → inform user, ask if they want to generate
#   • HTTP 404                      → no wisdom for this CPU, ask to generate
#   • HTTP 200 + checksum mismatch  → integrity failure, ask to generate
#   • HTTP 200 + checksum OK        → offer precomputed wisdom to user

USE_PRECOMPUTED=false

# The catalog is asked for the transforms this receiver actually plans. A file
# only has to *contain* them — extra transforms are harmless — but one missing the
# transform radiod plans is worse than nothing, because it installs cleanly and
# then leaves radiod measuring at startup as if no wisdom existed at all.
WISDOM_WANT=$(echo "$FFT_SIZES" | tr ' ' ',')

if [[ -n "$CPU_HASH" && $CATALOG_ELIGIBLE -eq 1 ]]; then
    WISDOM_URL="https://instances.ubersdr.org/api/fftw-wisdom/${CPU_HASH}?fft=${WISDOM_WANT}"

    _wisdom_body=$(mktemp)
    _wisdom_headers=$(mktemp)
    _wisdom_err=$(mktemp)

    echo "  Checking for precomputed FFTW wisdom for your CPU..."
    if [[ -n "$CPU_NAME" ]]; then
        echo "    CPU:  ${CPU_NAME}"
    fi
    echo "    Hash: ${CPU_HASH}"
    echo "    Needs: ${FFT_SIZES}"
    echo

    HTTP_STATUS=$(curl -sS --max-time 15 \
        --write-out "%{http_code}" \
        --dump-header "$_wisdom_headers" \
        --output "$_wisdom_body" \
        "$WISDOM_URL" 2>"$_wisdom_err"); CURL_EXIT=$?; true

    # _header <name> → the value of a response header, or empty
    _header() {
        grep -i "^${1}:" "$_wisdom_headers" | tail -1 | tr -d '\r' | sed "s/^[^:]*:[[:space:]]*//"
    }

    _ask_generate_own() {
        # $1 = informational message to show before the prompt
        echo "$1"
        echo "     Local generation can take several hours."
        echo
        read -p "  Do you want to generate your own FFTW wisdom? (Y/n): " -n 1 -r
        echo
        echo
        if [[ $REPLY =~ ^[Nn]$ ]]; then
            rm -f "$_wisdom_body" "$_wisdom_headers" "$_wisdom_err"
            if [ $HAVE_LOCAL_WISDOM -eq 1 ]; then
                keep_existing_and_exit
            fi
            echo "  Wisdom generation cancelled."
            exit 0
        fi
        GENERATION_CONFIRMED=1
    }

    # Shown once the file has been accepted, whether or not it could be checksummed.
    _offer_precomputed() {
        local _covers _source _remote_fftw _remote_threads
        _covers=$(_header 'x-wisdom-fft-sizes')
        _source=$(_header 'x-wisdom-fft-source')
        _remote_fftw=$(_header 'x-wisdom-fftw-version')
        _remote_threads=$(_header 'x-wisdom-nthreads')

        echo "  ✓  Precomputed FFTW wisdom found for your CPU!"
        if [[ -n "$CPU_NAME" ]]; then
            echo "       CPU:    ${CPU_NAME}"
        fi
        echo "       Hash:   ${CPU_HASH}"
        if [[ -n "$_covers" ]]; then
            case "$_source" in
                declared|"") echo "       Covers: ${_covers//,/ }" ;;
                # 'inferred'/'backfilled' mean nobody declared this file's contents;
                # the catalog recorded it as 64.8 MSPS because that is all the release
                # which uploaded it could build. Accurate, but worth saying out loud.
                *)           echo "       Covers: ${_covers//,/ }  (${_source}, not declared by the generator)" ;;
            esac
        fi
        if [[ -n "$_remote_fftw" ]]; then
            echo "       Built:  FFTW ${_remote_fftw}${_remote_threads:+, ${_remote_threads} thread(s)}"
        fi
        echo "       Source: https://instances.ubersdr.org/api/fftw-wisdom/${CPU_HASH}"
        echo
        echo "  Using precomputed wisdom saves several hours of generation time."
        echo "  The wisdom was generated on an identical CPU microarchitecture."

        # FFTW ignores wisdom entries written by a different version instead of
        # rejecting them, so a mismatch installs cleanly and simply does nothing.
        # That is worth a warning, not a refusal — the operator may well have a
        # different FFTW build than the uploader and still benefit from trying.
        if [[ -n "$_remote_fftw" && -n "$FFTW_VERSION" && "$_remote_fftw" != "$FFTW_VERSION" ]]; then
            echo
            echo "  ⚠  It was built with FFTW ${_remote_fftw}, but this machine has ${FFTW_VERSION}."
            echo "     FFTW silently ignores wisdom from another version, so this may install"
            echo "     but leave radiod planning from scratch anyway."
        fi

        # A file covering only the current rate is still worth having, but the
        # operator should know a rate change means doing this again.
        if [[ -n "$_covers" && "$_covers" != *"${FFT_LOW}"* ]]; then
            echo
            echo "  ⚠  It does not cover ${FFT_LOW} (64.8 MSPS). If you later drop back to"
            echo "     the lower sample rate you will need to generate wisdom again."
        elif [[ -n "$_covers" && "$_covers" != *"${FFT_HIGH}"* ]]; then
            echo
            echo "  Note: it covers 64.8 MSPS only. Raising this receiver to 129.6 MSPS"
            echo "        later would mean generating wisdom again."
        fi

        echo
        echo "  Generating your own would build: ${FFT_SIZES}"
        echo "  ${FFT_COST_NOTE}"
        echo
        if [ $HAVE_LOCAL_WISDOM -eq 1 ]; then
            echo "  This machine already has a wisdom file. Installing the catalog one"
            echo "  backs the current file up to ${WISDOM_FILE}.backup first."
            echo
            read -p "  [1] Use precomputed (recommended)  [2] Generate my own  [3] Keep what I have: " -r _choice
        else
            read -p "  [1] Use precomputed wisdom (recommended)  [2] Generate my own: " -r _choice
        fi
        echo
        case "$_choice" in
            2)
                echo "  Proceeding with local generation..."
                echo
                GENERATION_CONFIRMED=1
                ;;
            3)
                if [ $HAVE_LOCAL_WISDOM -eq 1 ]; then
                    rm -f "$_wisdom_body" "$_wisdom_headers" "$_wisdom_err"
                    keep_existing_and_exit
                fi
                USE_PRECOMPUTED=true
                ;;
            *)
                USE_PRECOMPUTED=true
                ;;
        esac
    }

    if [[ $CURL_EXIT -ne 0 ]]; then
        _ask_generate_own "  ℹ  Could not reach the wisdom server (network error or timeout).
     You could try again later if you have connectivity issues."
    elif [[ "$HTTP_STATUS" == "404" ]]; then
        # "nothing at all for this CPU" and "nothing covering the rate you run at"
        # are different situations and send the operator to different places, so
        # they get different messages. X-Wisdom-Available lists what is held.
        _available=$(_header 'x-wisdom-available')
        if [[ -n "$_available" ]]; then
            _ask_generate_own "  ℹ  The catalog has wisdom for your CPU, but none of it covers ${FFT_SIZES}.
     Available for this CPU: ${_available}
     (that is wisdom for a different front end sample rate — it would install
      cleanly and leave radiod planning from scratch, so it is not offered)."
        else
            _ask_generate_own "  ℹ  No precomputed wisdom is available for your CPU (hash: ${CPU_HASH})."
        fi
    elif [[ "$HTTP_STATUS" == "200" ]]; then
        # Verify integrity using X-Wisdom-SHA256 header, falling back to ETag
        EXPECTED_SHA=$(grep -i '^x-wisdom-sha256:' "$_wisdom_headers" | tr -d '\r' | awk '{print $2}')
        if [[ -z "$EXPECTED_SHA" ]]; then
            EXPECTED_SHA=$(grep -i '^etag:' "$_wisdom_headers" | tr -d '\r' | awk '{print $2}' | tr -d '"')
        fi

        if [[ -n "$EXPECTED_SHA" ]]; then
            ACTUAL_SHA=$(sha256sum "$_wisdom_body" | awk '{print $1}')
            if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
                _ask_generate_own "  ⚠  Downloaded wisdom failed integrity check (checksum mismatch).
     The file may be corrupt or tampered with."
            else
                _offer_precomputed
            fi
        else
            # No checksum header — accept without verification
            _offer_precomputed
        fi
    else
        _ask_generate_own "  ℹ  Wisdom server returned an unexpected response (HTTP ${HTTP_STATUS})."
    fi

    if $USE_PRECOMPUTED; then
        backup_existing_wisdom
        # Install atomically: cp to a temp file on the same filesystem, then mv
        _precomp_tmp="${WISDOM_FILE}.tmp"
        echo "  Installing precomputed wisdom to ${WISDOM_FILE}..."
        if sudo cp "$_wisdom_body" "$_precomp_tmp" && sudo mv -f "$_precomp_tmp" "$WISDOM_FILE"; then
            # Record what was installed, so this machine is as self-describing as one
            # that generated its own — and so a later --upload-only does not have to
            # fall back to assuming 64.8 MSPS.
            _dl_covers=$(_header 'x-wisdom-fft-sizes')
            # Both of these are interpolated into the JSON below, so keep them to
            # the shapes they are supposed to have rather than trusting the wire.
            _dl_fftw=$(_header 'x-wisdom-fftw-version' | tr -cd '0-9A-Za-z._+-')
            _dl_threads=$(_header 'x-wisdom-nthreads' | tr -cd '0-9')
            [[ -z "$_dl_covers" ]] && _dl_covers="$WISDOM_WANT"
            _dl_json_sizes=$(echo "$_dl_covers" | tr ',' '\n' | sed 's/.*/"&"/' | paste -sd, -)
            printf '{"schema":1,"fft_sizes":[%s],"fft_sizes_source":"catalog","wisdom_sha256":"%s","fftw_version":"%s","nthreads":%s,"planner_flags":"","generated_at":"%s","generator":"catalog:%s"}\n' \
                "$_dl_json_sizes" \
                "$(sha256sum "$_wisdom_body" | awk '{print $1}')" \
                "${_dl_fftw}" "${_dl_threads:-1}" \
                "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${CPU_HASH}" \
                | sudo tee "$WISDOM_META_FILE" >/dev/null
            sudo chmod 644 "$WISDOM_META_FILE" 2>/dev/null

            echo "  Done!  Installed wisdom covers: ${_dl_covers//,/ }"
            echo
            echo "  Please restart the application using the red \"Save & Restart Radiod\" button"
            echo "  at the bottom of the \"Radiod\" tab in the admin interface."
            rm -f "$_wisdom_body" "$_wisdom_headers" "$_wisdom_err"
            exit 0
        else
            sudo rm -f "$_precomp_tmp"
            echo "  ERROR: Failed to install precomputed wisdom." >&2
            rm -f "$_wisdom_body" "$_wisdom_headers" "$_wisdom_err"
            exit 1
        fi
    fi

    rm -f "$_wisdom_body" "$_wisdom_headers" "$_wisdom_err"
fi

# ── Confirm, if nobody has been asked yet ─────────────────────────────────────
#
# Every route through the catalog block above ends with the operator having chosen
# local generation explicitly. The block is skipped entirely, though, when there is
# no CPU hash or the receiver plans a transform the catalog does not carry — and in
# that case nothing has yet stood between an existing wisdom file and being
# replaced. Only asked when there is something to lose; with no wisdom on the
# machine, running this script is itself the request to generate some.
if [ $GENERATION_CONFIRMED -eq 0 ] && [ $HAVE_LOCAL_WISDOM -eq 1 ]; then
    read -p "Regenerate the existing wisdom file? (y/N): " -n 1 -r
    echo
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        keep_existing_and_exit
    fi
fi

backup_existing_wisdom

# ── Local generation ──────────────────────────────────────────────────────────

# Clean up any stale temp file left by a previous interrupted run
WISDOM_TMP="${WISDOM_FILE}.tmp"
sudo rm -f "$WISDOM_TMP" 2>/dev/null || true

#FFT_SIZES="rof1620000 rof810000 cob162000 cob81000 cob40500 cob32400 \
#    cob16200 cob9600 cob8100 cob6930 cob4860 cob4800 cob3240 cob3200 cob1920 cob1620 cob1600 \
#    cob1200 cob960 cob810 cob800 cob600 cob480 cob405 cob400 cob320 cob300 cob205 cob200 cob160 cob85 cob45 cob15"

# Which transform to generate for.
#
# Asked of the receiver rather than assumed: the forward FFT length follows from the
# front end sample rate (N = samprate x blocktime x overlap/(overlap-1)), so a box
# running at 129.6 MSPS plans rof3240000 and one at 64.8 plans rof1620000. This used to
# hardcode the 64.8 size and offer the other behind a flag and a prompt, which meant the
# usual invocation on a 129.6 receiver spent hours generating wisdom for a transform
# radiod would never plan, while the one it does plan got none.
#
# get-samprate.sh reads it from the running server's /api/description and falls back to
# the radiod .conf when the server is not up. See there for why the API is preferred.
echo "Creating tmux session '$SESSION_NAME' and starting FFTW Wisdom generation..."
if [[ -n "$WISDOM_CPU_DESC" ]]; then
    echo "CPU pinning${WISDOM_CPU_DESC}"
fi
echo "This will take some time. Be patient!"
echo
echo "To attach to the session and monitor progress:"
echo "  tmux attach -t $SESSION_NAME"
echo
echo "To detach from the session (without stopping it):"
echo "  Press Ctrl+B, then D"
echo

# Build the fftwf-wisdom command, optionally prefixed with taskset.
# Write to a temp file first; only mv into place atomically on success.
# If fftwf-wisdom fails, the temp file is removed and the original wisdom
# file (or its backup) is left untouched.
FFTWF_CMD="sudo ${TASKSET_PREFIX:+${TASKSET_PREFIX} }fftwf-wisdom -v -T 1 -o '${WISDOM_TMP}' ${FFT_SIZES} \
    && sudo mv -f '${WISDOM_TMP}' '${WISDOM_FILE}' \
    || { sudo rm -f '${WISDOM_TMP}'; echo 'ERROR: Wisdom generation failed — temp file removed, original wisdom untouched.'; exit 1; }"

# Build the post-generation step: record what was built, then upload.
#
# This runs inside the tmux session, possibly hours later, so it is emitted as a
# standalone script rather than an inline command string — the alternative is
# several layers of quote escaping around the same logic that --upload-only uses.
POST_SCRIPT=$(mktemp /tmp/ubersdr-wisdom-post.XXXXXX)
write_upload_helper "$POST_SCRIPT"
UPLOAD_CMD="bash '${POST_SCRIPT}' declared"

# Create tmux session and run the wisdom generation command
tmux new-session -d -s "$SESSION_NAME" -n 'Generate Wisdom' "${FFTWF_CMD} && \
    echo && \
    echo && \
    echo && \
    echo '=== FFTW Wisdom generation completed successfully! ===' && \
    echo && \
    ${UPLOAD_CMD} ; \
    rm -f '${POST_SCRIPT}' ; \
    echo && \
    echo 'Please restart the application using the red \"Save & Restart Radiod\" button' && \
    echo 'at the bottom of the \"Radiod\" tab in the admin interface.' && \
    echo && \
    echo 'Press Enter to close this session...' && \
    read"

echo "Tmux session '$SESSION_NAME' created and wisdom generation started!"
echo
echo "Attaching to session now..."
sleep 1
tmux attach -t "$SESSION_NAME"
