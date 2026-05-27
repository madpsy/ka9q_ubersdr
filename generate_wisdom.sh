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
for arg in "$@"; do
    case $arg in
        --max-rate)
            MAX_RATE=1
            shift
            ;;
    esac
done

echo "=== UberSDR FFTW Wisdom Generator ==="
echo

# ── Script directory (used for sibling script references) ─────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

WISDOM_FILE="/var/lib/docker/volumes/ubersdr_radiod-data/_data/wisdom"
SESSION_NAME="generate-wisdom"

# If session already exists, re-attach to it (wisdom generation still running)
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "Tmux session '$SESSION_NAME' already exists — attaching to it..."
    echo "(Wisdom generation is already in progress)"
    echo
    sleep 1
    tmux attach -t "$SESSION_NAME"
    exit 0
fi

# Check if wisdom file already exists and ask user if they want to continue
if sudo test -f "$WISDOM_FILE"; then
    echo "WARNING: A wisdom file already exists at:"
    echo "  $WISDOM_FILE"
    echo
    read -p "Do you want to continue and regenerate it? (y/N): " -n 1 -r
    echo
    echo

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Wisdom generation cancelled."
        # Silently attempt to upload the existing wisdom to the community catalog.
        # All output and errors are suppressed — this is purely fire-and-forget.
        {
            _uuid=$("${SCRIPT_DIR}/get-uuid.sh" 2>/dev/null) || exit 0
            _meta_file=$(mktemp)
            _wisdom_tmp=$(mktemp)
            "${SCRIPT_DIR}/get-cpu.sh" --json 2>/dev/null > "$_meta_file" || { rm -f "$_meta_file" "$_wisdom_tmp"; exit 0; }
            sudo cp "${WISDOM_FILE}" "$_wisdom_tmp" 2>/dev/null && sudo chmod 644 "$_wisdom_tmp" 2>/dev/null || { rm -f "$_meta_file" "$_wisdom_tmp"; exit 0; }
            curl -sS -o /dev/null -X POST \
                -F "meta=<${_meta_file};type=application/json" \
                -F "wisdom=@${_wisdom_tmp};type=application/octet-stream" \
                "https://instances.ubersdr.org/api/fftw-wisdom/${_uuid}" 2>/dev/null
            rm -f "$_meta_file" "$_wisdom_tmp"
        } &>/dev/null &
        exit 0
    fi

    # Backup existing wisdom file
    BACKUP_FILE="${WISDOM_FILE}.backup"
    echo "Moving existing wisdom file to ${BACKUP_FILE}..."
    sudo mv "$WISDOM_FILE" "$BACKUP_FILE"
    echo "Backup created at ${BACKUP_FILE}"
    echo
fi

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

if [[ -n "$CPU_HASH" ]]; then
    WISDOM_URL="https://instances.ubersdr.org/api/fftw-wisdom/${CPU_HASH}"

    _wisdom_body=$(mktemp)
    _wisdom_headers=$(mktemp)
    _wisdom_err=$(mktemp)

    echo "  Checking for precomputed FFTW wisdom for your CPU..."
    if [[ -n "$CPU_NAME" ]]; then
        echo "    CPU:  ${CPU_NAME}"
    fi
    echo "    Hash: ${CPU_HASH}"
    echo

    HTTP_STATUS=$(curl -sS --max-time 15 \
        --write-out "%{http_code}" \
        --dump-header "$_wisdom_headers" \
        --output "$_wisdom_body" \
        "$WISDOM_URL" 2>"$_wisdom_err"); CURL_EXIT=$?; true

    _ask_generate_own() {
        # $1 = informational message to show before the prompt
        echo "$1"
        echo "     Local generation can take several hours."
        echo
        read -p "  Do you want to generate your own FFTW wisdom? (Y/n): " -n 1 -r
        echo
        echo
        if [[ $REPLY =~ ^[Nn]$ ]]; then
            echo "  Wisdom generation cancelled."
            rm -f "$_wisdom_body" "$_wisdom_headers" "$_wisdom_err"
            exit 0
        fi
    }

    if [[ $CURL_EXIT -ne 0 ]]; then
        _ask_generate_own "  ℹ  Could not reach the wisdom server (network error or timeout).
     You could try again later if you have connectivity issues."
    elif [[ "$HTTP_STATUS" == "404" ]]; then
        _ask_generate_own "  ℹ  No precomputed wisdom is available for your CPU (hash: ${CPU_HASH})."
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
                # Checksum OK — offer precomputed wisdom to user
                echo "  ✓  Precomputed FFTW wisdom found for your CPU!"
                if [[ -n "$CPU_NAME" ]]; then
                    echo "       CPU:    ${CPU_NAME}"
                fi
                echo "       Hash:   ${CPU_HASH}"
                echo "       Source: ${WISDOM_URL}"
                echo
                echo "  Using precomputed wisdom saves several hours of generation time."
                echo "  The wisdom was generated on an identical CPU microarchitecture."
                echo
                read -p "  [1] Use precomputed wisdom (recommended)  [2] Generate my own: " -r _choice
                echo
                if [[ "$_choice" == "2" ]]; then
                    echo "  Proceeding with local generation..."
                    echo
                else
                    USE_PRECOMPUTED=true
                fi
            fi
        else
            # No checksum header — accept without verification
            echo "  ✓  Precomputed FFTW wisdom found for your CPU!"
            if [[ -n "$CPU_NAME" ]]; then
                echo "       CPU:    ${CPU_NAME}"
            fi
            echo "       Hash:   ${CPU_HASH}"
            echo "       Source: ${WISDOM_URL}"
            echo
            echo "  Using precomputed wisdom saves several hours of generation time."
            echo "  The wisdom was generated on an identical CPU microarchitecture."
            echo
            read -p "  [1] Use precomputed wisdom (recommended)  [2] Generate my own: " -r _choice
            echo
            if [[ "$_choice" == "2" ]]; then
                echo "  Proceeding with local generation..."
                echo
            else
                USE_PRECOMPUTED=true
            fi
        fi
    else
        _ask_generate_own "  ℹ  Wisdom server returned an unexpected response (HTTP ${HTTP_STATUS})."
    fi

    if $USE_PRECOMPUTED; then
        echo "  Installing precomputed wisdom to ${WISDOM_FILE}..."
        sudo cp "$_wisdom_body" "$WISDOM_FILE"
        echo "  Done!"
        echo
        echo "  Please restart the application using the red \"Save & Restart Radiod\" button"
        echo "  at the bottom of the \"Radiod\" tab in the admin interface."
        rm -f "$_wisdom_body" "$_wisdom_headers" "$_wisdom_err"
        exit 0
    fi

    rm -f "$_wisdom_body" "$_wisdom_headers" "$_wisdom_err"
fi

# ── Local generation ──────────────────────────────────────────────────────────

#FFT_SIZES="rof1620000 rof810000 cob162000 cob81000 cob40500 cob32400 \
#    cob16200 cob9600 cob8100 cob6930 cob4860 cob4800 cob3240 cob3200 cob1920 cob1620 cob1600 \
#    cob1200 cob960 cob810 cob800 cob600 cob480 cob405 cob400 cob320 cob300 cob205 cob200 cob160 cob85 cob45 cob15"

FFT_SIZES="rof1620000"

# Ask user about RX888 MKII @ 129.6 MSPS support only if --max-rate is specified
if [ $MAX_RATE -eq 1 ]; then
    echo
    echo "Do you want to generate wisdom for RX888 MKII @ 129.6 MSPS?"
    echo
    echo "WARNING: This adds rof3240000 to the generation and may take SEVERAL HOURS."
    echo "         129.6 MSPS is NOT required for most users."
    echo
    read -p "Generate for 129.6 MSPS? (y/N): " -n 1 -r
    echo
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Including 129.6 MSPS support (rof3240000)..."
        FFT_SIZES="rof3240000 $FFT_SIZES"
    else
        echo "Skipping 129.6 MSPS support..."
    fi
fi

echo
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

# Build the fftwf-wisdom command, optionally prefixed with taskset
FFTWF_CMD="sudo ${TASKSET_PREFIX:+${TASKSET_PREFIX} }fftwf-wisdom -v -T 1 -o '${WISDOM_FILE}' ${FFT_SIZES}"

# Build the post-generation upload snippet.
# SCRIPT_DIR and WISDOM_FILE are expanded now (before tmux starts) so they
# resolve correctly inside the tmux session shell.
# Errors are fully ignored — the upload is best-effort / fire-and-forget.
#
# Notes:
#   • The wisdom file is in a root-owned Docker volume, so it must be copied
#     to a user-readable temp file via sudo before curl can read it.
#   • meta uses curl's '<file' syntax (reads file content as field value,
#     no filename in Content-Disposition) so the server sees a plain JSON field.
UPLOAD_CMD="_uuid=\$(bash '${SCRIPT_DIR}/get-uuid.sh' 2>/dev/null) && \
    _meta_file=\$(mktemp) && \
    _wisdom_tmp=\$(mktemp) && \
    bash '${SCRIPT_DIR}/get-cpu.sh' --json 2>/dev/null > \"\${_meta_file}\" && \
    sudo cp '${WISDOM_FILE}' \"\${_wisdom_tmp}\" 2>/dev/null && \
    sudo chmod 644 \"\${_wisdom_tmp}\" 2>/dev/null && \
    _up=\$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
        -F \"meta=<\${_meta_file};type=application/json\" \
        -F \"wisdom=@\${_wisdom_tmp};type=application/octet-stream\" \
        \"https://instances.ubersdr.org/api/fftw-wisdom/\${_uuid}\" 2>/dev/null); \
    rm -f \"\${_meta_file}\" \"\${_wisdom_tmp}\"; \
    case \"\${_up}\" in \
        201) echo '  ✓ Wisdom uploaded to the community catalog' ;; \
        409) echo '  ℹ Wisdom already exists for this CPU in the catalog' ;; \
        401) echo '  ℹ Could not upload wisdom (instance not yet registered)' ;; \
    esac"

# Create tmux session and run the wisdom generation command
tmux new-session -d -s "$SESSION_NAME" -n 'Generate Wisdom' "${FFTWF_CMD} && \
    echo && \
    echo && \
    echo && \
    echo '=== FFTW Wisdom generation completed successfully! ===' && \
    echo && \
    eval \"${UPLOAD_CMD}\" ; \
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
