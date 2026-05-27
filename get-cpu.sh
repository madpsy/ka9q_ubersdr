#!/bin/bash

# get-cpu.sh - Identify the CPU microarchitecture and produce a stable hash ID
#
# Intended use: generate a catalog key for FFTW wisdom files, which are valid
# only for the specific CPU microarchitecture they were generated on.
#
# ── Output fields ─────────────────────────────────────────────────────────────
#
# Common fields (present on ALL architectures):
#   arch          - Architecture family: "arm" or "x86"
#   cpu_name      - Human-readable CPU name.
#                   ARM: looked up from (implementer, part) e.g. "Cortex-A76"
#                   x86: CPUID brand string from /proc/cpuinfo e.g.
#                        "AMD Ryzen 7 5700U with Radeon Graphics"
#                        (same source as lscpu — no lookup table needed)
#   cpu_key       - Stable unique key for this microarchitecture, suitable for
#                   use as a catalog key or filename component:
#                   ARM: "arm-{implementer}-{part}"  e.g. "arm-0x41-0xd0b"
#                   x86: "x86-{vendor_id}-{cpu_family}-{model}"
#                        e.g. "x86-AuthenticAMD-23-104"
#   cpu_hash      - First 8 hex chars of SHA-256(cpu_key). Short, uniform-length,
#                   filename-safe ID. Collision probability is negligible given
#                   the small population of distinct CPU microarchitectures.
#                   e.g. "834c3584"
#
# ARM-only fields:
#   implementer   - CPU implementer hex code from /proc/cpuinfo e.g. "0x41" (ARM Ltd)
#   part          - CPU part hex code from /proc/cpuinfo e.g. "0xd0b" (Cortex-A76)
#   variant       - CPU variant (major silicon revision) e.g. "0x4" (r4)
#   revision      - CPU revision (minor silicon revision) e.g. "0" (p0)
#   heterogeneous - true if this system has multiple core types (big.LITTLE/DynamIQ)
#   all_clusters  - Space-separated list of all unique "implementer:part" pairs on
#                   this system e.g. "0x41:0xd05 0x41:0xd0b" (A55 + A76)
#                   On heterogeneous systems the script auto-selects the highest-
#                   priority cluster (prime > big > LITTLE) for cpu_key/cpu_hash,
#                   since that is the core type radiod runs on. Use --cpu N to
#                   override and identify a specific logical CPU instead.
#
# x86-only fields:
#   vendor        - CPU vendor string from /proc/cpuinfo e.g. "AuthenticAMD"
#   family        - CPU family (decimal) from /proc/cpuinfo e.g. "23"
#   model         - CPU model (decimal) from /proc/cpuinfo e.g. "104"
#   stepping      - CPU stepping (decimal) from /proc/cpuinfo e.g. "1"
#                   Note: cpu_name already contains the full brand string so
#                   there is no separate "model_name" field.
#
# ── Usage ─────────────────────────────────────────────────────────────────────
#
#   ./get-cpu.sh                # human-readable output
#   ./get-cpu.sh --cpu <N>      # identify a specific logical CPU number
#                               # (useful on big.LITTLE to override auto-selection)
#   ./get-cpu.sh --json         # JSON output (no jq dependency)
#   ./get-cpu.sh --hash-only    # print only the 8-char hash, for use in scripts

set -euo pipefail

# ── ARM part name lookup ──────────────────────────────────────────────────────

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
        0x41:0xd80) echo "Cortex-A520" ;;
        0x41:0xd81) echo "Cortex-A720" ;;
        0x41:0xd82) echo "Cortex-X4" ;;
        0x51:0x800) echo "Kryo 2xx Gold" ;;
        0x51:0x801) echo "Kryo 2xx Silver" ;;
        0x51:0x803) echo "Kryo 3xx Silver" ;;
        0x51:0x804) echo "Kryo 4xx Gold" ;;
        0x51:0x805) echo "Kryo 4xx Silver" ;;
        0x53:0x001) echo "Exynos M1" ;;
        0x53:0x004) echo "Exynos M4" ;;
        0x53:0x005) echo "Exynos M5" ;;
        0xc0:0xac3) echo "Ampere-1" ;;
        *) echo "ARM-${impl}-${part}" ;;
    esac
}

# ── Parse arguments ───────────────────────────────────────────────────────────

TARGET_CPU=""
OUTPUT_JSON=false
HASH_ONLY=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --cpu)
            TARGET_CPU="$2"
            shift 2
            ;;
        --json)
            OUTPUT_JSON=true
            shift
            ;;
        --hash-only)
            HASH_ONLY=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [--cpu N] [--json] [--hash-only]"
            echo ""
            echo "  --cpu N       Identify a specific logical CPU number (useful for big.LITTLE)"
            echo "  --json        Output as JSON"
            echo "  --hash-only   Output only the 8-char hash"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

# ── Detect architecture ───────────────────────────────────────────────────────

ARCH="$(uname -m 2>/dev/null)"
IS_ARM=false
case "$ARCH" in
    aarch64|armv7l|armv8l) IS_ARM=true ;;
esac
if grep -q 'CPU implementer' /proc/cpuinfo 2>/dev/null; then IS_ARM=true; fi

# ── Build CPU key and name ────────────────────────────────────────────────────

CPU_KEY=""
CPU_NAME=""
CPU_ARCH=""
ALL_CLUSTERS=""

if $IS_ARM; then
    CPU_ARCH="arm"

    # Build cluster map: role → "first_cpu impl part"
    # Roles: LITTLE < big < prime (priority order for auto-selection)
    declare -A _cluster_first_cpu=()
    declare -A _cluster_impl=()
    declare -A _cluster_part=()
    _cur_proc="" _cur_impl="" _cur_part=""
    while IFS= read -r _line; do
        if [[ "$_line" =~ ^processor[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
            _cur_proc="${BASH_REMATCH[1]}"
            _cur_impl="" _cur_part=""
        elif [[ "$_line" =~ ^CPU\ implementer[[:space:]]*:[[:space:]]*(0x[0-9a-fA-F]+) ]]; then
            _cur_impl="${BASH_REMATCH[1]}"
        elif [[ "$_line" =~ ^CPU\ part[[:space:]]*:[[:space:]]*(0x[0-9a-fA-F]+) ]]; then
            _cur_part="${BASH_REMATCH[1]}"
            if [[ -n "$_cur_impl" && -n "$_cur_part" ]]; then
                _cname=$(arm_cpu_part_name "$_cur_impl" "$_cur_part")
                case "$_cname" in
                    *A53*|*A55*|*A35*|*A510*|*"Kryo 2xx Silver"*|*"Kryo 3xx Silver"*|*"Kryo 4xx Silver"*)
                        _role="LITTLE" ;;
                    *A57*|*A72*|*A73*|*A75*|*A76*|*A77*|*A78*|*A710*|*A715*|*"Kryo 2xx Gold"*|*"Kryo 4xx Gold"*)
                        _role="big" ;;
                    *X1*|*X2*|*X3*|*Neoverse*)
                        _role="prime" ;;
                    *) _role="" ;;
                esac
                if [[ -n "$_role" && -z "${_cluster_first_cpu[$_role]:-}" ]]; then
                    _cluster_first_cpu["$_role"]="$_cur_proc"
                    _cluster_impl["$_role"]="$_cur_impl"
                    _cluster_part["$_role"]="$_cur_part"
                fi
            fi
        fi
    done < /proc/cpuinfo

    # Determine which CPU to identify
    IS_HETEROGENEOUS=false
    HETEROGENEOUS_WARNING=""
    _unique_roles="${#_cluster_first_cpu[@]}"
    (( _unique_roles > 1 )) && IS_HETEROGENEOUS=true

    if [[ -n "$TARGET_CPU" ]]; then
        # User explicitly specified a CPU — use it
        IMPL=$(awk -v cpu="$TARGET_CPU" '
            /^processor[[:space:]]*:/ { cur=$NF }
            cur==cpu && /^CPU implementer[[:space:]]*:/ { print $NF; exit }
        ' /proc/cpuinfo)
        PART=$(awk -v cpu="$TARGET_CPU" '
            /^processor[[:space:]]*:/ { cur=$NF }
            cur==cpu && /^CPU part[[:space:]]*:/ { print $NF; exit }
        ' /proc/cpuinfo)
        VARIANT=$(awk -v cpu="$TARGET_CPU" '
            /^processor[[:space:]]*:/ { cur=$NF }
            cur==cpu && /^CPU variant[[:space:]]*:/ { print $NF; exit }
        ' /proc/cpuinfo)
        REVISION=$(awk -v cpu="$TARGET_CPU" '
            /^processor[[:space:]]*:/ { cur=$NF }
            cur==cpu && /^CPU revision[[:space:]]*:/ { print $NF; exit }
        ' /proc/cpuinfo)
    elif $IS_HETEROGENEOUS; then
        # big.LITTLE system — auto-select the highest-priority cluster (prime > big > LITTLE)
        # This is the core type radiod should run on
        _best_role=""
        for _r in prime big LITTLE; do
            if [[ -n "${_cluster_first_cpu[$_r]:-}" ]]; then
                _best_role="$_r"
                break
            fi
        done
        TARGET_CPU="${_cluster_first_cpu[$_best_role]}"
        IMPL="${_cluster_impl[$_best_role]}"
        PART="${_cluster_part[$_best_role]}"
        VARIANT=$(awk -v cpu="$TARGET_CPU" '
            /^processor[[:space:]]*:/ { cur=$NF }
            cur==cpu && /^CPU variant[[:space:]]*:/ { print $NF; exit }
        ' /proc/cpuinfo)
        REVISION=$(awk -v cpu="$TARGET_CPU" '
            /^processor[[:space:]]*:/ { cur=$NF }
            cur==cpu && /^CPU revision[[:space:]]*:/ { print $NF; exit }
        ' /proc/cpuinfo)
        HETEROGENEOUS_WARNING="  ⚠  big.LITTLE system detected — auto-selected ${_best_role} core (CPU ${TARGET_CPU}) for wisdom ID"
    else
        # Homogeneous ARM — use CPU 0
        IMPL=$(grep -m1 'CPU implementer' /proc/cpuinfo | awk '{print $NF}')
        PART=$(grep -m1 'CPU part'        /proc/cpuinfo | awk '{print $NF}')
        VARIANT=$(grep -m1 'CPU variant'  /proc/cpuinfo | awk '{print $NF}')
        REVISION=$(grep -m1 'CPU revision' /proc/cpuinfo | awk '{print $NF}')
    fi

    if [[ -z "$IMPL" || -z "$PART" ]]; then
        echo "Error: Could not read CPU implementer/part from /proc/cpuinfo" >&2
        exit 1
    fi

    CPU_NAME=$(arm_cpu_part_name "$IMPL" "$PART")
    CPU_KEY="arm-${IMPL}-${PART}"

    # Build cluster summary (all unique core types on this system)
    ALL_CLUSTERS=$(awk '
        /^CPU implementer[[:space:]]*:/ { impl=$NF }
        /^CPU part[[:space:]]*:/ { part=$NF; print impl ":" part }
    ' /proc/cpuinfo | sort -u | tr '\n' ' ' | sed 's/ $//')

else
    CPU_ARCH="x86"

    VENDOR=$(grep -m1 'vendor_id'  /proc/cpuinfo | awk '{print $NF}')
    FAMILY=$(grep -m1 'cpu family' /proc/cpuinfo | awk '{print $NF}')
    # 'model' line appears twice (model and model name) — match only bare 'model'
    MODEL=$(grep -m1 '^model[[:space:]]*:' /proc/cpuinfo | awk '{print $NF}')
    STEPPING=$(grep -m1 'stepping' /proc/cpuinfo | awk '{print $NF}')
    MODEL_NAME=$(grep -m1 'model name' /proc/cpuinfo | sed 's/.*: //' | xargs)

    if [[ -z "$VENDOR" || -z "$FAMILY" || -z "$MODEL" ]]; then
        echo "Error: Could not read vendor_id/cpu family/model from /proc/cpuinfo" >&2
        exit 1
    fi

    # x86 CPUs expose their brand string via CPUID — no lookup table needed.
    # 'model name' in /proc/cpuinfo is that brand string, same source lscpu uses.
    CPU_NAME="${MODEL_NAME:-${VENDOR} family ${FAMILY} model ${MODEL}}"
    CPU_KEY="x86-${VENDOR}-${FAMILY}-${MODEL}"
fi

# ── Generate hash ─────────────────────────────────────────────────────────────
# SHA256 of the stable key string, truncated to 8 hex chars

CPU_HASH=$(echo -n "$CPU_KEY" | sha256sum | awk '{print $1}' | cut -c1-8)

# ── Output ────────────────────────────────────────────────────────────────────

if $HASH_ONLY; then
    echo "$CPU_HASH"
    exit 0
fi

if $OUTPUT_JSON; then
    # JSON output — no jq dependency required.
    # Common fields (arch, cpu_name, cpu_key, cpu_hash) are present on every CPU.
    # Architecture-specific fields follow.
    if $IS_ARM; then
        printf '{\n'
        printf '  "arch": "%s",\n'             "$CPU_ARCH"          # "arm"
        printf '  "cpu_name": "%s",\n'          "$CPU_NAME"          # e.g. "Cortex-A76"
        printf '  "cpu_key": "%s",\n'           "$CPU_KEY"           # e.g. "arm-0x41-0xd0b"
        printf '  "cpu_hash": "%s",\n'          "$CPU_HASH"          # e.g. "a1b2c3d4"
        printf '  "implementer": "%s",\n'       "$IMPL"              # e.g. "0x41"
        printf '  "part": "%s",\n'              "$PART"              # e.g. "0xd0b"
        printf '  "variant": "%s",\n'           "${VARIANT:-}"       # e.g. "0x4" (r4)
        printf '  "revision": "%s",\n'          "${REVISION:-}"      # e.g. "0" (p0)
        printf '  "heterogeneous": %s,\n'       "$($IS_HETEROGENEOUS && echo true || echo false)"  # big.LITTLE?
        printf '  "all_clusters": "%s"\n'       "$ALL_CLUSTERS"      # e.g. "0x41:0xd05 0x41:0xd0b"
        printf '}\n'
    else
        # x86: cpu_name is the CPUID brand string (same as lscpu "Model name").
        # No separate model_name field — cpu_name already contains it.
        printf '{\n'
        printf '  "arch": "%s",\n'       "$CPU_ARCH"    # "x86"
        printf '  "cpu_name": "%s",\n'   "$CPU_NAME"    # CPUID brand string e.g. "AMD Ryzen 7 5700U..."
        printf '  "cpu_key": "%s",\n'    "$CPU_KEY"     # e.g. "x86-AuthenticAMD-23-104"
        printf '  "cpu_hash": "%s",\n'   "$CPU_HASH"    # e.g. "834c3584"
        printf '  "vendor": "%s",\n'     "$VENDOR"      # e.g. "AuthenticAMD" or "GenuineIntel"
        printf '  "family": "%s",\n'     "$FAMILY"      # cpu family (decimal) e.g. "23"
        printf '  "model": "%s",\n'      "$MODEL"       # cpu model (decimal) e.g. "104"
        printf '  "stepping": "%s"\n'    "${STEPPING:-}" # stepping (decimal) e.g. "1"
        printf '}\n'
    fi
    exit 0
fi

# Default: human-readable output
echo "=== CPU Identification ==="
echo ""
if $IS_ARM; then
    [[ -n "$HETEROGENEOUS_WARNING" ]] && echo "$HETEROGENEOUS_WARNING" && echo ""
    echo "  Architecture : ARM (${ARCH})"
    echo "  CPU Name     : ${CPU_NAME}"
    echo "  Implementer  : ${IMPL}"
    echo "  Part         : ${PART}"
    [[ -n "${VARIANT:-}" ]]  && echo "  Variant      : ${VARIANT}"
    [[ -n "${REVISION:-}" ]] && echo "  Revision     : ${REVISION}"
    [[ -n "$ALL_CLUSTERS" ]] && echo "  All clusters : ${ALL_CLUSTERS}"
else
    echo "  Architecture : x86 (${ARCH})"
    echo "  CPU Name     : ${CPU_NAME}"
    echo "  Vendor       : ${VENDOR}"
    echo "  Family       : ${FAMILY}"
    echo "  Model        : ${MODEL}"
    [[ -n "${STEPPING:-}" ]] && echo "  Stepping     : ${STEPPING}"
fi
echo ""
echo "  CPU Key      : ${CPU_KEY}"
echo "  CPU Hash     : ${CPU_HASH}"
echo ""
echo "  Wisdom file  : wisdom-${CPU_HASH}"
