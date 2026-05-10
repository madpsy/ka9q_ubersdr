#!/usr/bin/env bash
# radiod-cpu-info.sh
#
# Comprehensive CPU and process analysis for the 'radiod' real-time SDR process.
#
# Reports:
#   - CPU model, physical/logical core counts, Hyper-Threading status
#   - CPU feature flags relevant to SDR (AVX2, AVX512, SSE4.2, FMA, etc.)
#   - Cache topology (L1d, L1i, L2, L3 sizes and sharing)
#   - NUMA topology and whether radiod's pinned cores span NUMA nodes
#   - CPU frequency governor and current frequencies
#   - radiod process: PID, threads, CPU affinity / cpuset pinning
#   - Per-thread CPU usage and which logical CPU each thread is running on
#   - Real-time scheduling policy and priority
#   - Memory / NUMA locality of the process
#   - IRQ affinity for USB/PCIe devices (SDR hardware)
#   - Kernel nohz_full / rcu_nocbs boot parameters
#   - Turbo Boost / P-state status
#
# Usage:
#   ./radiod-cpu-info.sh [--watch N] [--no-colour] [--help]
#
# Options:
#   --watch N     Refresh every N seconds (default: run once)
#   --no-colour   Disable ANSI colour output
#   --help        Show this help text
#
# No root required for most information; some IRQ/cpuset details need root.

set -euo pipefail

# ── Colour setup ──────────────────────────────────────────────────────────────

USE_COLOUR=true
if [[ ! -t 1 ]]; then USE_COLOUR=false; fi   # not a terminal → no colour

WATCH_INTERVAL=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-colour|--no-color) USE_COLOUR=false; shift ;;
        --watch)
            [[ -n "${2:-}" ]] || { echo "ERROR: --watch requires a number" >&2; exit 1; }
            WATCH_INTERVAL="$2"; shift 2 ;;
        --help|-h)
            sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \?//'
            exit 0 ;;
        *)
            echo "Usage: $0 [--watch N] [--no-colour] [--help]" >&2
            exit 1 ;;
    esac
done

if $USE_COLOUR; then
    RED=$'\033[0;31m'
    GREEN=$'\033[0;32m'
    YELLOW=$'\033[1;33m'
    CYAN=$'\033[0;36m'
    BLUE=$'\033[0;34m'
    MAGENTA=$'\033[0;35m'
    BOLD=$'\033[1m'
    DIM=$'\033[2m'
    RESET=$'\033[0m'
else
    RED='' GREEN='' YELLOW='' CYAN='' BLUE='' MAGENTA='' BOLD='' DIM='' RESET=''
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

header() {
    local title="$1"
    local width=62
    local line
    printf -v line '%*s' "$width" ''
    line="${line// /─}"
    echo -e "\n${BOLD}${CYAN}┌${line}┐${RESET}"
    printf "${BOLD}${CYAN}│  %-*s│${RESET}\n" $(( width - 2 )) "$title"
    echo -e "${BOLD}${CYAN}└${line}┘${RESET}"
}

kv() {
    local label="$1" value="$2" colour="${3:-}"
    printf "  ${BOLD}%-30s${RESET} %s%s%s\n" "${label}:" "${colour}" "${value}" "${RESET}"
}

warn_line() { echo -e "  ${YELLOW}⚠  $*${RESET}"; }
ok_line()   { echo -e "  ${GREEN}✓  $*${RESET}"; }
info_line() { echo -e "  ${CYAN}ℹ  $*${RESET}"; }
bad_line()  { echo -e "  ${RED}✗  $*${RESET}"; }

sysread() { cat "$1" 2>/dev/null || echo ""; }

# Global: set by section_radiod_process, used by later sections
RADIOD_PID=""
RADIOD_RUNNING=false
# Global: set by section_affinity, used by section_cpu_load and section_threads
RADIOD_PINNED_CPUS=""      # real cpuset string (Docker compose), e.g. "0,2,4,6"
RADIOD_PINNED_CPU_COUNT=0  # number of logical CPUs in the pinned set
# Global: set by section_threads, used by summary
RADIOD_TOTAL_CPU=""        # sum of all thread CPU% (multi-core total)
RADIOD_FFT_CPU=""          # CPU% of fft* threads (combined)
RADIOD_PROC_CPU=""         # CPU% of proc_* threads (combined)
RADIOD_SPECT_CPU=""        # CPU% of spect* threads (combined)
RADIOD_LIN_CPU=""          # CPU% of lin* threads (combined)
RADIOD_RADIOSTAT_CPU=""    # CPU% of "radio stat" threads (combined)
# Global: set by section_numa; used for NUMA topology display
NUMA_NODE_COUNT=1
# Global: set by section_cache; used to gate pinning/isolation advice.
# L3 cache domain is the real performance boundary — a single-socket AMD Ryzen
# with multiple CCDs has multiple L3 domains on one NUMA node, and a simple
# 4-core laptop has one L3 domain on one NUMA node.  Falls back to NUMA node
# count when L3 sysfs is unavailable (matching suggest-radiod-cpuset.sh logic).
L3_DOMAIN_COUNT=1

# ── 1. CPU Model & Basic Topology ─────────────────────────────────────────────

section_cpu_model() {
    header "CPU Model & Topology"

    local model
    model=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//' || echo "unknown")
    kv "Model" "$model" "${BOLD}"

    local vendor
    vendor=$(grep -m1 'vendor_id' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//' || echo "unknown")
    kv "Vendor" "$vendor"

    local sockets
    sockets=$(grep 'physical id' /proc/cpuinfo 2>/dev/null | sort -u | wc -l 2>/dev/null)
    sockets=$(echo "$sockets" | tr -d '[:space:]')
    [[ "$sockets" =~ ^[0-9]+$ ]] || sockets=0
    (( sockets == 0 )) && sockets=1
    kv "Sockets" "$sockets"

    local cores_per_socket
    cores_per_socket=$(grep 'cpu cores' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2- | tr -d ' ' || echo "?")
    kv "Physical cores/socket" "$cores_per_socket"

    local logical_cpus
    logical_cpus=$(nproc --all 2>/dev/null || grep -c '^processor' /proc/cpuinfo)
    kv "Logical CPUs (total)" "$logical_cpus"

    # Count unique physical cores via thread_siblings_list
    declare -A _seen_phys_cores
    for cpu_dir in /sys/devices/system/cpu/cpu[0-9]*/; do
        local sib_file="${cpu_dir}topology/thread_siblings_list"
        [[ -f "$sib_file" ]] || continue
        local sib
        sib=$(cat "$sib_file")
        _seen_phys_cores["$sib"]=1
    done
    local total_phys="${#_seen_phys_cores[@]}"
    [[ $total_phys -eq 0 ]] && total_phys="$logical_cpus"
    kv "Physical cores (total)" "$total_phys"

    local ht_status ht_colour
    if (( logical_cpus > total_phys )); then
        ht_status="ENABLED  (${logical_cpus} logical / ${total_phys} physical)"

        # Warn only if radiod's pinned set has SPLIT HT pairs — i.e. one sibling
        # pinned but not the other.  Pinning both siblings of a physical core is
        # correct for a multi-threaded app like radiod (suggest-radiod-cpuset.sh
        # intentionally includes all siblings).  Splitting a pair is bad because
        # the OS can schedule unrelated tasks on the unpinned sibling, sharing the
        # physical execution units with radiod.
        local ht_split=false
        local pinned_cpus=""
        if command -v taskset &>/dev/null && [[ -n "$(pgrep -x radiod 2>/dev/null)" ]]; then
            pinned_cpus=$(taskset -cp "$(pgrep -x radiod | head -1)" 2>/dev/null \
                | grep -oP '(?<=affinity list: ).*' || echo "")
        fi

        if [[ -n "$pinned_cpus" ]]; then
            # Expand pinned CPU list
            local pinned_expanded=()
            IFS=',' read -ra _pp <<< "$pinned_cpus"
            for _p in "${_pp[@]}"; do
                if [[ "$_p" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                    for (( _n=${BASH_REMATCH[1]}; _n<=${BASH_REMATCH[2]}; _n++ )); do
                        pinned_expanded+=("$_n")
                    done
                else
                    pinned_expanded+=("$_p")
                fi
            done

            # For each pinned CPU, check that ALL its HT siblings are also pinned.
            # A split pair (one sibling pinned, others not) is the problem case.
            for _cpu in "${pinned_expanded[@]}"; do
                local _sib_file="/sys/devices/system/cpu/cpu${_cpu}/topology/thread_siblings_list"
                [[ -f "$_sib_file" ]] || continue
                local _sibs
                _sibs=$(cat "$_sib_file")
                if [[ "$_sibs" == *","* || "$_sibs" == *"-"* ]]; then
                    IFS=',' read -ra _sib_parts <<< "$_sibs"
                    for _s in "${_sib_parts[@]}"; do
                        [[ "$_s" == "$_cpu" ]] && continue
                        local _sib_found=false
                        for _q in "${pinned_expanded[@]}"; do
                            [[ "$_q" == "$_s" ]] && _sib_found=true && break
                        done
                        if ! $_sib_found; then
                            ht_split=true
                            break 2
                        fi
                    done
                fi
            done

            if $ht_split; then
                ht_colour="$YELLOW"
                echo ""
                warn_line "Hyper-Threading is ON and some HT sibling pairs are split (one sibling pinned, one not)."
                warn_line "Either pin all siblings of each physical core, or pin only one per core."
                warn_line "Run suggest-radiod-cpuset.sh to get a consistent cpuset recommendation."
            else
                ht_colour="$GREEN"
                ok_line "Hyper-Threading is ON — pinned CPUs form complete physical core(s), no split pairs"
            fi
        else
            # radiod not running or not pinned — advise pinning when multiple L3 domains exist
            # (e.g. AMD Ryzen with multiple CCDs, or multi-socket systems)
            if (( L3_DOMAIN_COUNT > 1 )); then
                ht_colour="$YELLOW"
                echo ""
                warn_line "Hyper-Threading is ON and ${L3_DOMAIN_COUNT} L3 cache domains detected."
                warn_line "Pin radiod to dedicated physical core(s) within one L3 domain for best RT performance."
            else
                ht_colour="$YELLOW"
            fi
        fi
    else
        ht_status="disabled (${logical_cpus} logical = ${total_phys} physical)"
        ht_colour="$GREEN"
    fi
    kv "Hyper-Threading" "$ht_status" "$ht_colour"

    local ucode
    ucode=$(grep -m1 'microcode' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | tr -d ' ' || echo "unknown")
    kv "Microcode revision" "$ucode"

    local min_mhz max_mhz
    min_mhz=$(sysread /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_min_freq)
    max_mhz=$(sysread /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq)
    if [[ -n "$min_mhz" && -n "$max_mhz" ]]; then
        kv "Freq range" "$(( min_mhz / 1000 )) MHz – $(( max_mhz / 1000 )) MHz"
    fi
}

# ── 2. CPU Feature Flags (SDR-relevant) ───────────────────────────────────────

section_cpu_flags() {
    header "CPU Feature Flags (SDR-relevant)"

    local flags
    flags=$(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null | cut -d: -f2- || echo "")

    # flag → description
    declare -A flag_desc
    flag_desc[avx512f]="AVX-512F (512-bit SIMD)"
    flag_desc[avx512bw]="AVX-512BW (byte/word ops)"
    flag_desc[avx512dq]="AVX-512DQ (dword/qword ops)"
    flag_desc[avx2]="AVX2 (256-bit SIMD)"
    flag_desc[avx]="AVX (128-bit SIMD)"
    flag_desc[fma]="FMA (fused multiply-add)"
    flag_desc[sse4_2]="SSE 4.2"
    flag_desc[sse4_1]="SSE 4.1"
    flag_desc[ssse3]="SSSE3"
    flag_desc[bmi2]="BMI2 (bit manipulation)"
    flag_desc[popcnt]="POPCNT"
    flag_desc[aes]="AES-NI (hardware AES)"
    flag_desc[nonstop_tsc]="Non-stop TSC (stable clock)"
    flag_desc[constant_tsc]="Constant TSC"
    flag_desc[tsc_deadline_timer]="TSC deadline timer"
    flag_desc[rdtscp]="RDTSCP (precise timing)"
    flag_desc[hypervisor]="Hypervisor (running in VM)"

    local ordered=(avx512f avx512bw avx512dq avx2 avx fma sse4_2 sse4_1 ssse3 bmi2 popcnt aes nonstop_tsc constant_tsc tsc_deadline_timer rdtscp hypervisor)

    local has_avx2=false has_fma=false
    for flag in "${ordered[@]}"; do
        local name="${flag_desc[$flag]}"
        if echo " $flags " | grep -qw "$flag"; then
            [[ "$flag" == "avx2" ]] && has_avx2=true
            [[ "$flag" == "fma"  ]] && has_fma=true
            if [[ "$flag" == "hypervisor" ]]; then
                printf "  ${YELLOW}✓${RESET}  %-40s ${YELLOW}← running inside VM/container!${RESET}\n" "$name"
            else
                printf "  ${GREEN}✓${RESET}  %s\n" "$name"
            fi
        else
            # Only call out absent flags that matter for SDR
            if [[ "$flag" == "avx2" || "$flag" == "fma" ]]; then
                printf "  ${YELLOW}✗${RESET}  %-40s ${YELLOW}← not present; may limit DSP throughput${RESET}\n" "$name"
            fi
        fi
    done

    echo ""
    if $has_avx2 && $has_fma; then
        ok_line "AVX2 + FMA present — optimal for ka9q-radio DSP kernels"
    elif $has_avx2; then
        ok_line "AVX2 present (no FMA) — good SIMD support"
    else
        warn_line "No AVX2 — ka9q-radio DSP will fall back to SSE2/scalar paths"
    fi

    # Check if radiod binary uses AVX2/FMA instructions
    local radiod_bin
    radiod_bin=$(command -v radiod 2>/dev/null \
        || find /usr/local/bin /usr/bin /opt -maxdepth 4 -name radiod -type f 2>/dev/null | head -1 \
        || echo "")
    if [[ -n "$radiod_bin" ]]; then
        echo ""
        if command -v objdump &>/dev/null && objdump -d "$radiod_bin" 2>/dev/null | grep -qiE '\bvfmadd|\bvperm|\bymm'; then
            ok_line "radiod binary (${radiod_bin}) contains AVX2/FMA instructions"
        else
            info_line "radiod binary (${radiod_bin}) — AVX2/FMA not detected (SSE-only or stripped binary)"
        fi
    else
        info_line "radiod binary not found in PATH or common locations"
    fi
}

# ── 3. Cache Topology ─────────────────────────────────────────────────────────

section_cache() {
    header "Cache Topology"

    local cache_dir="/sys/devices/system/cpu/cpu0/cache"
    if [[ ! -d "$cache_dir" ]]; then
        info_line "Cache sysfs not available"
        return
    fi

    declare -A _seen_cache_entries

    for idx_dir in "${cache_dir}"/index*/; do
        [[ -d "$idx_dir" ]] || continue
        local level type size shared_cpu_list line_size
        level=$(sysread "${idx_dir}level")
        type=$(sysread "${idx_dir}type")
        size=$(sysread "${idx_dir}size")
        shared_cpu_list=$(sysread "${idx_dir}shared_cpu_list")
        line_size=$(sysread "${idx_dir}coherency_line_size")

        local type_short
        case "$type" in
            Instruction) type_short="I" ;;
            Data)        type_short="D" ;;
            Unified)     type_short="U" ;;
            *)           type_short="?" ;;
        esac

        local label="L${level}${type_short}"
        local colour="$RESET"
        [[ "$level" == "3" ]] && colour="${CYAN}${BOLD}"
        [[ "$level" == "1" ]] && colour="$DIM"

        printf "  ${colour}%-8s${RESET}  size=%-8s  line=%3s B  shared_cpus=[%s]\n" \
            "$label" "$size" "$line_size" "$shared_cpu_list"
    done

    # Count unique L3 instances across all CPUs and export as L3_DOMAIN_COUNT.
    # This is the authoritative topology boundary for pinning/isolation advice —
    # more accurate than NUMA node count (e.g. AMD Ryzen with multiple CCDs has
    # multiple L3 domains on a single NUMA node).
    declare -A _seen_l3
    local l3_total_kb=0 l3_count=0
    for cpu_dir in /sys/devices/system/cpu/cpu[0-9]*/cache/; do
        for idx_dir in "${cpu_dir}"index*/; do
            [[ -d "$idx_dir" ]] || continue
            local lvl typ sz scl
            lvl=$(sysread "${idx_dir}level")
            typ=$(sysread "${idx_dir}type")
            [[ "$lvl" == "3" && "$typ" == "Unified" ]] || continue
            scl=$(sysread "${idx_dir}shared_cpu_list")
            [[ -n "${_seen_l3[$scl]:-}" ]] && continue
            _seen_l3["$scl"]=1
            sz=$(sysread "${idx_dir}size")
            local sz_kb="${sz//K/}"
            [[ "$sz_kb" =~ ^[0-9]+$ ]] && (( l3_total_kb += sz_kb )) || true
            (( l3_count++ )) || true
        done
    done 2>/dev/null || true

    echo ""
    if (( l3_count > 1 )); then
        kv "L3 domains (total)" "${l3_count} × (${l3_total_kb} KB total)" "$YELLOW"
        info_line "Multiple L3 cache domains detected — threads migrating between domains incur cache-miss latency"
        info_line "Pin radiod to cores within one L3 domain — see CPU Affinity section"
    elif (( l3_count == 1 )); then
        kv "L3 domains (total)" "1 × (${l3_total_kb} KB total)" "$GREEN"
        ok_line "Single L3 cache domain — all cores share one cache, no cross-domain latency"
    else
        kv "L3 domains (total)" "unknown (L3 sysfs not available)" "$DIM"
    fi

    # Export L3_DOMAIN_COUNT; fall back to NUMA node count when L3 sysfs is
    # unavailable (matches suggest-radiod-cpuset.sh fallback logic).
    # NOTE: section_cache runs before section_numa, so NUMA_NODE_COUNT is not
    # yet set here — count NUMA nodes inline rather than using the global.
    if (( l3_count > 0 )); then
        L3_DOMAIN_COUNT="$l3_count"
    else
        # L3 sysfs not available — count NUMA nodes directly as proxy
        local _numa_fallback=0
        for _nd in /sys/devices/system/node/node[0-9]*/; do
            [[ -d "$_nd" ]] && (( _numa_fallback++ )) || true
        done
        (( _numa_fallback < 1 )) && _numa_fallback=1
        L3_DOMAIN_COUNT="$_numa_fallback"
    fi
}

# ── 4. NUMA Topology ──────────────────────────────────────────────────────────

section_numa() {
    header "NUMA Topology"

    local numa_dir="/sys/devices/system/node"
    if [[ ! -d "$numa_dir" ]]; then
        info_line "NUMA sysfs not available"
        return
    fi

    local node_count=0
    declare -gA NUMA_NODE_CPUS   # exported for later use

    for node_dir in "${numa_dir}"/node[0-9]*/; do
        [[ -d "$node_dir" ]] || continue
        local node_id
        node_id=$(basename "$node_dir" | tr -d 'node')
        local cpulist
        cpulist=$(sysread "${node_dir}cpulist")
        local mem_total
        mem_total=$(grep 'MemTotal' "${node_dir}meminfo" 2>/dev/null | awk '{printf "%d MB", $4/1024}' || echo "? MB")

        NUMA_NODE_CPUS["$node_id"]="$cpulist"

        printf "  ${BOLD}${CYAN}Node %-2s${RESET}  CPUs=[%-20s]  RAM=%s\n" \
            "$node_id" "$cpulist" "$mem_total"
        (( node_count++ )) || true
    done

    NUMA_NODE_COUNT="$node_count"

    echo ""
    if (( node_count > 1 )); then
        warn_line "Multi-NUMA system (${node_count} nodes). Cross-NUMA memory access adds ~100 ns latency."
        info_line "Ideal: pin radiod threads AND its memory allocations to the same NUMA node."
        info_line "Use numactl --cpunodebind=N --membind=N radiod ... to enforce locality."
    else
        ok_line "Single NUMA node — no cross-NUMA latency concerns."
    fi
}

# ── 5. CPU Frequency Governor & Turbo ─────────────────────────────────────────

section_governor() {
    header "CPU Frequency Governor & Turbo"

    declare -A gov_cpus=()
    for gov_file in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        [[ -f "$gov_file" ]] || continue
        local cpu_n gov
        cpu_n=$(basename "$(dirname "$(dirname "$gov_file")")")
        gov=$(cat "$gov_file" 2>/dev/null || echo "unknown")
        gov_cpus["$gov"]+="${cpu_n} "
    done

    if [[ ${#gov_cpus[@]} -eq 0 ]]; then
        info_line "cpufreq sysfs not available (container or no cpufreq driver)"
    else
        for gov in "${!gov_cpus[@]}"; do
            local colour note
            case "$gov" in
                performance) colour="$GREEN";  note=" ← ideal for real-time SDR" ;;
                powersave)   colour="$YELLOW"; note=" ← may throttle under load" ;;
                ondemand)    colour="$YELLOW"; note=" ← ramp-up latency can cause sample drops" ;;
                schedutil)   colour="$YELLOW"; note=" ← better than ondemand, still has latency" ;;
                *)           colour="$RESET";  note="" ;;
            esac
            printf "  ${BOLD}${colour}%-14s${RESET}  CPUs: %s${colour}%s${RESET}\n" \
                "$gov" "${gov_cpus[$gov]}" "$note"
        done
        echo ""
        if [[ -n "${gov_cpus[performance]:-}" ]]; then
            ok_line "performance governor active"
        else
            warn_line "CPU governor is not 'performance' — use 'Manage CPU Governor' in UberSDR Admin to fix"
            info_line "Note: 'performance' keeps the CPU at max frequency, reducing frequency-scaling latency."
            info_line "      Trade-off: higher idle power consumption and increased heat output."
        fi
    fi

    # Turbo / boost
    echo ""
    local intel_no_turbo="/sys/devices/system/cpu/intel_pstate/no_turbo"
    local boost_file="/sys/devices/system/cpu/cpufreq/boost"
    if [[ -f "$intel_no_turbo" ]]; then
        local no_turbo
        no_turbo=$(cat "$intel_no_turbo")
        if [[ "$no_turbo" == "0" ]]; then
            ok_line "Intel Turbo Boost: ENABLED"
        else
            warn_line "Intel Turbo Boost: DISABLED (no_turbo=1) — limits peak single-core frequency"
        fi
    elif [[ -f "$boost_file" ]]; then
        local boost
        boost=$(cat "$boost_file")
        [[ "$boost" == "1" ]] && ok_line "CPU Boost: ENABLED" || warn_line "CPU Boost: DISABLED"
    else
        info_line "Turbo/boost status: not detectable via sysfs"
    fi

    # Current per-core frequencies
    echo ""
    local freqs=()
    for freq_file in /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq; do
        [[ -f "$freq_file" ]] || continue
        local f
        f=$(cat "$freq_file" 2>/dev/null || echo "0")
        freqs+=("$(( f / 1000 ))")
    done
    if [[ ${#freqs[@]} -gt 0 ]]; then
        local min_f max_f sum_f=0
        min_f="${freqs[0]}"; max_f="${freqs[0]}"
        for f in "${freqs[@]}"; do
            (( f < min_f )) && min_f=$f || true
            (( f > max_f )) && max_f=$f || true
            (( sum_f += f )) || true
        done
        local avg_f=$(( sum_f / ${#freqs[@]} ))
        kv "Current freq (min/avg/max)" "${min_f} / ${avg_f} / ${max_f} MHz"
    fi
}

# ── 6. Kernel Boot Parameters (isolation) ─────────────────────────────────────

section_kernel_params() {
    header "Kernel CPU Isolation Parameters"

    local cmdline
    cmdline=$(cat /proc/cmdline 2>/dev/null || echo "")

    local found_any=false

    local nohz_full
    nohz_full=$(echo "$cmdline" | grep -oP 'nohz_full=\S+' || echo "")
    if [[ -n "$nohz_full" ]]; then
        ok_line "${nohz_full}  ← tick-less CPUs (reduces timer interrupt jitter)"
        found_any=true
    else
        info_line "nohz_full: not set  (timer ticks fire on all CPUs)"
    fi

    local rcu_nocbs
    rcu_nocbs=$(echo "$cmdline" | grep -oP 'rcu_nocbs=\S+' || echo "")
    if [[ -n "$rcu_nocbs" ]]; then
        ok_line "${rcu_nocbs}  ← RCU callbacks offloaded (reduces latency spikes)"
        found_any=true
    else
        info_line "rcu_nocbs: not set"
    fi

    local irqaffinity
    irqaffinity=$(echo "$cmdline" | grep -oP 'irqaffinity=\S+' || echo "")
    if [[ -n "$irqaffinity" ]]; then
        ok_line "${irqaffinity}  ← IRQs restricted to these CPUs"
        found_any=true
    fi

    if echo "$cmdline" | grep -qw 'threadirqs'; then
        ok_line "threadirqs: set  ← IRQ threads can be given RT priority"
        found_any=true
    fi

    local mitigations
    mitigations=$(echo "$cmdline" | grep -oP 'mitigations=\S+' || echo "")
    if [[ -n "$mitigations" ]]; then
        local val="${mitigations#*=}"
        if [[ "$val" == "off" ]]; then
            warn_line "mitigations=off  ← Spectre/Meltdown mitigations disabled (faster, less secure)"
        else
            info_line "mitigations=${val}"
        fi
    fi

    if ! $found_any && (( L3_DOMAIN_COUNT > 1 )); then
        echo ""
        info_line "No optional RT kernel parameters detected (${L3_DOMAIN_COUNT} L3 cache domains found)."
        info_line "Consider nohz_full= and rcu_nocbs= for lower jitter on dedicated RT cores."
        info_line "For CPU pinning, use 'Manage CPU Pinning' in UberSDR Admin or: ./suggest-radiod-cpuset.sh --apply"
    fi
}

# ── 7. radiod Process Information ─────────────────────────────────────────────

section_radiod_process() {
    header "radiod Process"

    local pids
    pids=$(pgrep -x radiod 2>/dev/null || pgrep -f '/radiod' 2>/dev/null | head -5 || echo "")

    if [[ -z "$pids" ]]; then
        bad_line "radiod is NOT running"
        RADIOD_RUNNING=false
        return 0
    fi

    RADIOD_RUNNING=true

    local pid_count
    pid_count=$(echo "$pids" | wc -w)
    if (( pid_count > 1 )); then
        warn_line "Multiple radiod processes found (PIDs: ${pids}) — using first"
    fi

    local pid
    pid=$(echo "$pids" | awk '{print $1}')
    RADIOD_PID="$pid"

    kv "PID" "$pid" "$GREEN"

    local cmdline_str
    cmdline_str=$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null | sed 's/ $//' || echo "unknown")
    kv "Command" "$cmdline_str"

    local state
    state=$(awk '/^State:/{print $2, $3}' "/proc/${pid}/status" 2>/dev/null || echo "?")
    kv "State" "$state"

    local start_time
    start_time=$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//' || echo "unknown")
    kv "Started" "$start_time"

    local threads
    threads=$(awk '/^Threads:/{print $2}' "/proc/${pid}/status" 2>/dev/null || echo "?")
    kv "Threads" "$threads"

    local cpu_pct mem_pct
    cpu_pct=$(ps -p "$pid" -o %cpu= 2>/dev/null | tr -d ' ' || echo "?")
    mem_pct=$(ps -p "$pid" -o %mem= 2>/dev/null | tr -d ' ' || echo "?")
    # ps %cpu is a kernel rolling average (lifetime since process start),
    # expressed as % of one logical CPU.  Section 9 shows a live 5s measurement.
    kv "CPU usage (ps lifetime avg)" "${cpu_pct}%" "$CYAN"
    kv "Memory usage" "${mem_pct}%"

    local vsz rss
    vsz=$(ps -p "$pid" -o vsz= 2>/dev/null | tr -d ' ' || echo "0")
    rss=$(ps -p "$pid" -o rss= 2>/dev/null | tr -d ' ' || echo "0")
    if [[ "$vsz" =~ ^[0-9]+$ && $vsz -gt 0 ]]; then
        kv "Virtual memory" "$(( vsz / 1024 )) MB"
        kv "Resident memory (RSS)" "$(( rss / 1024 )) MB"
    fi

    # Scheduling policy & priority
    # radiod sets SCHED_FIFO per worker thread, not on the main process.
    # We must check thread-level scheduling, not just the main PID.
    echo ""
    kv "── Scheduling ──" ""

    # Prefer inspecting inside the container (all threads visible, correct PID ns)
    local rt_thread_count=0 max_rt_prio=0 main_policy="?"
    if docker exec ka9q-radio ps -eLo tid,cls,rtprio,comm 2>/dev/null | grep -q '^'; then
        local ps_out
        ps_out=$(docker exec ka9q-radio ps -eLo tid,cls,rtprio,comm 2>/dev/null || echo "")
        rt_thread_count=$(echo "$ps_out" | awk '$2=="FF"{count++} END{print count+0}')
        max_rt_prio=$(echo "$ps_out" | awk '$2=="FF" && $3>max{max=$3} END{print max+0}')
        main_policy=$(echo "$ps_out" | awk 'NR>1 && $1==1{print $2; exit}')
    elif command -v chrt &>/dev/null; then
        # Fallback: check host-visible threads via /proc
        local task_dir="/proc/${pid}/task"
        if [[ -d "$task_dir" ]]; then
            for tid_dir in "${task_dir}"/*/; do
                local tid
                tid=$(basename "$tid_dir")
                local pol
                pol=$(chrt -p "$tid" 2>/dev/null | grep -oP '(?<=policy: )\S+' || echo "")
                [[ "$pol" =~ FIFO|RR ]] && (( rt_thread_count++ )) || true
                local prio
                prio=$(chrt -p "$tid" 2>/dev/null | grep -oP '(?<=priority: )\S+' || echo "0")
                [[ "$prio" =~ ^[0-9]+$ ]] && (( prio > max_rt_prio )) && max_rt_prio=$prio || true
            done
        fi
        main_policy=$(chrt -p "$pid" 2>/dev/null | grep -oP '(?<=policy: )\S+' || echo "?")
    fi

    kv "Main thread policy" "$main_policy" "$DIM"
    if (( rt_thread_count > 0 )); then
        kv "RT worker threads (SCHED_FIFO)" "$rt_thread_count  (max priority: ${max_rt_prio})" "$GREEN"
        ok_line "Real-time scheduling active on ${rt_thread_count} worker thread(s)"
    else
        kv "RT worker threads (SCHED_FIFO)" "0" "$YELLOW"
        warn_line "No SCHED_FIFO threads found — check ulimits (rtprio) and capabilities (SYS_NICE)"
    fi

    local nice_val
    nice_val=$(ps -p "$pid" -o ni= 2>/dev/null | tr -d ' ' || echo "?")
    kv "Nice value" "$nice_val"

    local oom_score
    oom_score=$(cat "/proc/${pid}/oom_score" 2>/dev/null || echo "?")
    kv "OOM score" "$oom_score"

    # Memory locking (mlockall)
    # Note: radiod sets SCHED_FIFO per-thread; mlockall() would need to be called
    # explicitly. VmLck=0 is normal for ka9q-radio — the kernel won't page out
    # active RT threads under normal memory pressure.
    local vm_lock
    vm_lock=$(awk '/^VmLck:/{print $2, $3}' "/proc/${pid}/status" 2>/dev/null || echo "")
    if [[ -n "$vm_lock" ]]; then
        kv "Locked memory (mlockall)" "$vm_lock"
        local lock_kb="${vm_lock%% *}"
        if [[ "$lock_kb" =~ ^[0-9]+$ ]] && (( lock_kb > 0 )); then
            ok_line "Memory is locked (mlockall active)"
        elif (( rt_thread_count > 0 )); then
            info_line "mlockall not active — normal for ka9q-radio (RT threads are not paged out under normal pressure)"
        else
            warn_line "No locked memory and no RT threads — page faults may cause latency spikes"
        fi
    fi
}

# ── 8. CPU Affinity & cpuset Pinning ──────────────────────────────────────────

section_affinity() {
    header "CPU Affinity & cpuset Pinning"

    if ! $RADIOD_RUNNING; then
        info_line "radiod not running — skipping"
        return
    fi

    local pid="$RADIOD_PID"

    # taskset affinity
    local affinity_cpus=""
    if command -v taskset &>/dev/null; then
        affinity_cpus=$(taskset -cp "$pid" 2>/dev/null | grep -oP '(?<=affinity list: ).*' || echo "")
        if [[ -n "$affinity_cpus" ]]; then
            kv "CPU affinity (taskset)" "$affinity_cpus" "$CYAN"
        else
            info_line "Could not read affinity via taskset (permission denied?)"
        fi
    else
        info_line "taskset not available — install util-linux"
    fi

    # cpuset from cgroup v1
    local cgroup_file="/proc/${pid}/cgroup"
    if [[ -f "$cgroup_file" ]]; then
        local cpuset_cgroup
        cpuset_cgroup=$(grep ':cpuset:' "$cgroup_file" 2>/dev/null | cut -d: -f3 || echo "")
        if [[ -n "$cpuset_cgroup" && "$cpuset_cgroup" != "/" ]]; then
            local cpuset_path="/sys/fs/cgroup/cpuset${cpuset_cgroup}/cpuset.cpus"
            if [[ -f "$cpuset_path" ]]; then
                local cpuset_v1
                cpuset_v1=$(cat "$cpuset_path" 2>/dev/null || echo "")
                kv "cpuset (cgroup v1)" "$cpuset_v1" "$CYAN"
            fi
        fi
    fi

    # cpuset from cgroup v2
    local cg2_unified
    cg2_unified=$(grep '0::' "$cgroup_file" 2>/dev/null | cut -d: -f3 || echo "")
    if [[ -n "$cg2_unified" ]]; then
        local cg2_cpuset="/sys/fs/cgroup${cg2_unified}/cpuset.cpus"
        if [[ -f "$cg2_cpuset" ]]; then
            local cpuset_v2
            cpuset_v2=$(cat "$cg2_cpuset" 2>/dev/null || echo "")
            [[ -n "$cpuset_v2" ]] && kv "cpuset (cgroup v2)" "$cpuset_v2" "$CYAN"
        fi
    fi

    # Docker cpuset — check docker inspect, compose file, and effective cgroup
    if command -v docker &>/dev/null; then
        local container_id
        container_id=$(docker ps --format '{{.ID}} {{.Names}}' 2>/dev/null \
            | grep -i 'ka9q-radio' | awk '{print $1}' | head -1 || echo "")
        if [[ -n "$container_id" ]]; then
            # 1. Try docker inspect (works with --cpuset-cpus / API; may be empty with cgroup v2 + Compose)
            local docker_cpuset
            docker_cpuset=$(docker inspect --format '{{.HostConfig.CpusetCpus}}' "$container_id" 2>/dev/null || echo "")

            # 2. Fallback: read cpuset from docker-compose.yml
            local compose_cpuset=""
            local compose_candidates=(
                "$HOME/ubersdr/docker-compose.yml"
                "$(dirname "$(realpath "$0" 2>/dev/null || echo "$0")")/docker-compose.yml"
                "./docker-compose.yml"
            )
            for cf in "${compose_candidates[@]}"; do
                if [[ -f "$cf" ]]; then
                    # Extract cpuset value from the ka9q-radio service block
                    compose_cpuset=$(awk '
                        /^  ka9q-radio:/ { in_svc=1; next }
                        in_svc && /^  [^[:space:]]/ { in_svc=0 }
                        in_svc && /cpuset:/ { gsub(/[[:space:]"cpuset:]/, ""); print; exit }
                    ' "$cf" 2>/dev/null || echo "")
                    [[ -n "$compose_cpuset" ]] && break
                fi
            done

            # 3. Effective value: prefer inspect → compose → cgroup (already shown above)
            local effective="${docker_cpuset:-${compose_cpuset}}"
            if [[ -n "$effective" ]]; then
                kv "Docker cpuset (compose)" "$effective" "$CYAN"
            elif [[ -n "$affinity_cpus" ]]; then
                # OS-level pinning is active even without a Docker cpuset directive
                info_line "Docker cpuset not set in compose, but OS affinity is active (${affinity_cpus})"
            else
                warn_line "Docker container found but no cpuset configured in compose or docker inspect"
            fi
        fi
    fi

    # NUMA analysis of pinned CPUs
    echo ""
    local pinned_cpus="${affinity_cpus}"
    if [[ -n "$pinned_cpus" && "$pinned_cpus" != "0-$(( $(nproc --all) - 1 ))" ]]; then
        # Expand the CPU list (handles ranges like 0-3,8)
        local expanded_pinned=()
        IFS=',' read -ra parts <<< "$pinned_cpus"
        for part in "${parts[@]}"; do
            if [[ "$part" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                for (( n=${BASH_REMATCH[1]}; n<=${BASH_REMATCH[2]}; n++ )); do
                    expanded_pinned+=("$n")
                done
            else
                expanded_pinned+=("$part")
            fi
        done

        # Export pinned CPU set and count.
        # Prefer the Docker compose cpuset (real CPU numbers) over the host-visible
        # taskset affinity, which may be cgroup-namespace-shifted (e.g. 1-3,5-7
        # instead of the real 0,2,4,6).
        # _real_pinned is the authoritative expanded list used for all topology checks.
        local _real_pinned=()
        if [[ -n "${effective:-}" ]]; then
            RADIOD_PINNED_CPUS="$effective"
            IFS=',' read -ra _eff_parts <<< "$effective"
            for _ep in "${_eff_parts[@]}"; do
                if [[ "$_ep" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                    for (( _en=${BASH_REMATCH[1]}; _en<=${BASH_REMATCH[2]}; _en++ )); do
                        _real_pinned+=("$_en")
                    done
                else
                    _real_pinned+=("$_ep")
                fi
            done
            RADIOD_PINNED_CPU_COUNT="${#_real_pinned[@]}"
        else
            RADIOD_PINNED_CPUS="${pinned_cpus}"
            _real_pinned=("${expanded_pinned[@]}")
            RADIOD_PINNED_CPU_COUNT="${#expanded_pinned[@]}"
        fi

        # Check which NUMA nodes these CPUs belong to
        declare -A pinned_numa_nodes
        for cpu_n in "${_real_pinned[@]}"; do
            local node_file="/sys/devices/system/cpu/cpu${cpu_n}/node"
            # node symlink or node0..nodeN dirs
            for node_dir in /sys/devices/system/cpu/cpu${cpu_n}/node[0-9]*/; do
                if [[ -d "$node_dir" ]]; then
                    local nid
                    nid=$(basename "$node_dir" | tr -d 'node')
                    pinned_numa_nodes["$nid"]=1
                fi
            done
        done

        local numa_count="${#pinned_numa_nodes[@]}"
        if (( numa_count > 1 )); then
            warn_line "Pinned CPUs span ${numa_count} NUMA nodes: ${!pinned_numa_nodes[*]}"
            warn_line "Cross-NUMA pinning adds memory latency — pin to a single node if possible"
        elif (( numa_count == 1 )); then
            ok_line "Pinned CPUs are all on NUMA node ${!pinned_numa_nodes[*]}"
        fi

        # Check whether pinned CPUs span multiple L3 cache domains
        declare -A _pinned_l3_domains
        for cpu_n in "${_real_pinned[@]}"; do
            local _cache_base="/sys/devices/system/cpu/cpu${cpu_n}/cache"
            [[ -d "$_cache_base" ]] || continue
            for _idx_dir in "${_cache_base}"/index*/; do
                [[ -d "$_idx_dir" ]] || continue
                local _lvl _typ _scl
                _lvl=$(sysread "${_idx_dir}level")
                _typ=$(sysread "${_idx_dir}type")
                [[ "$_lvl" == "3" && "$_typ" == "Unified" ]] || continue
                _scl=$(sysread "${_idx_dir}shared_cpu_list")
                _pinned_l3_domains["$_scl"]=1
                break
            done
        done
        local _l3_domain_count="${#_pinned_l3_domains[@]}"
        if (( _l3_domain_count > 1 )); then
            warn_line "Pinned CPUs span ${_l3_domain_count} L3 cache domains — cross-L3 buffer handoffs add latency"
            info_line "Use 'Manage CPU Pinning' in UberSDR Admin, or run: ./suggest-radiod-cpuset.sh --apply"
        elif (( _l3_domain_count == 1 )); then
            ok_line "Pinned CPUs share a single L3 cache domain — optimal for buffer locality"
        fi

        # Check if pinned CPUs include HT siblings (warn)
        declare -A _ht_check
        local ht_mixed=false
        for cpu_n in "${_real_pinned[@]}"; do
            local sib_file="/sys/devices/system/cpu/cpu${cpu_n}/topology/thread_siblings_list"
            [[ -f "$sib_file" ]] || continue
            local sibs
            sibs=$(cat "$sib_file")
            # If sibling list has more than one CPU, HT is present on this core
            if [[ "$sibs" == *","* || "$sibs" == *"-"* ]]; then
                # Check if ALL siblings are in the pinned set
                local all_sibs_pinned=true
                IFS=',' read -ra sib_parts <<< "$sibs"
                for sp in "${sib_parts[@]}"; do
                    local found_sib=false
                    for ep in "${_real_pinned[@]}"; do
                        [[ "$ep" == "$sp" ]] && found_sib=true && break
                    done
                    $found_sib || all_sibs_pinned=false
                done
                if ! $all_sibs_pinned; then
                    ht_mixed=true
                fi
            fi
        done
        if $ht_mixed; then
            warn_line "Some HT sibling pairs are split across pinned/unpinned CPUs"
            warn_line "Either pin both siblings of each physical core, or pin only one per core"
        else
            ok_line "HT sibling pairing looks consistent with pinned set"
        fi
    else
        info_line "No CPU pinning detected — radiod can run on any CPU"
        if (( L3_DOMAIN_COUNT > 1 )); then
            warn_line "Consider pinning radiod to dedicated cores — ${L3_DOMAIN_COUNT} L3 cache domains detected"
            info_line "Without pinning, threads may migrate between L3 domains, adding cache-miss latency"
            info_line "Use 'Manage CPU Pinning' in UberSDR Admin, or run: ./suggest-radiod-cpuset.sh --apply"
        fi
    fi
}

# ── 9. Per-Thread CPU Usage ────────────────────────────────────────────────────

section_threads() {
    header "radiod Threads (per-thread CPU usage)"

    if ! $RADIOD_RUNNING; then
        info_line "radiod not running — skipping"
        return
    fi

    local pid="$RADIOD_PID"
    local task_dir="/proc/${pid}/task"

    if [[ ! -d "$task_dir" ]]; then
        info_line "Thread task directory not accessible"
        return
    fi

    # Collect thread info: TID, name, CPU%, last-run CPU, scheduling policy
    printf "  ${BOLD}%-8s %-20s %6s %5s  %-12s  %s${RESET}\n" \
        "TID" "Name" "CPU%" "CPU#" "SchedPolicy" "State"
    printf "  %s\n" "$(printf '%.0s─' {1..70})"

    local thread_count=0
    local total_cpu=0
    local fft_cpu=0
    local proc_cpu=0
    local spect_cpu=0
    local lin_cpu=0
    local radiostat_cpu=0

    # Track threads found running outside pinned set (for end-of-section warning)
    local threads_off_core=()   # "TID:name:cpu#" entries

    # We need two samples to get accurate CPU% per thread
    declare -A t1_utime t1_stime t1_total
    local sys_hz
    sys_hz=$(getconf CLK_TCK 2>/dev/null || echo "100")

    # First sample
    for tid_dir in "${task_dir}"/*/; do
        local tid
        tid=$(basename "$tid_dir")
        local stat_file="${tid_dir}stat"
        [[ -f "$stat_file" ]] || continue
        local stat_line stat_after_comm
        stat_line=$(cat "$stat_file" 2>/dev/null || echo "")
        # Strip "PID (comm) " prefix — comm may contain spaces.
        # After stripping: $1=state $12=utime $13=stime $37=processor
        stat_after_comm=$(echo "$stat_line" | sed 's/^[0-9]* (.*) //')
        local utime stime
        utime=$(echo "$stat_after_comm" | awk '{print $12}')
        stime=$(echo "$stat_after_comm" | awk '{print $13}')
        t1_utime["$tid"]="${utime:-0}"
        t1_stime["$tid"]="${stime:-0}"
    done

    # Read system uptime ticks for elapsed calculation
    local uptime1
    uptime1=$(awk '{print $1}' /proc/uptime 2>/dev/null || echo "0")
sleep 5


    local uptime2
    uptime2=$(awk '{print $1}' /proc/uptime 2>/dev/null || echo "0")
    # elapsed in ticks
    local elapsed_ticks
    elapsed_ticks=$(echo "$uptime2 $uptime1 $sys_hz" | awk '{printf "%d", ($1-$2)*$3}')
    (( elapsed_ticks < 1 )) && elapsed_ticks=1

    # Second sample + display
    for tid_dir in "${task_dir}"/*/; do
        local tid
        tid=$(basename "$tid_dir")
        local stat_file="${tid_dir}stat"
        local comm_file="${tid_dir}comm"
        [[ -f "$stat_file" ]] || continue

        local tname
        tname=$(cat "$comm_file" 2>/dev/null | tr -d '\n' || echo "?")

        local stat_line
        stat_line=$(cat "$stat_file" 2>/dev/null || echo "")

        # Strip "PID (comm) " prefix — comm may contain spaces, which shifts all
        # subsequent field numbers.  After stripping, the layout is:
        #   $1=state  $12=utime  $13=stime  $37=processor
        local stat_after_comm
        stat_after_comm=$(echo "$stat_line" | sed 's/^[0-9]* (.*) //')

        local utime2 stime2 state_char last_cpu
        state_char=$(echo "$stat_after_comm" | awk '{print $1}')
        utime2=$(echo "$stat_after_comm"     | awk '{print $12}')
        stime2=$(echo "$stat_after_comm"     | awk '{print $13}')
        last_cpu=$(echo "$stat_after_comm"   | awk '{print $37}')

        local du ds
        du=$(( ${utime2:-0} - ${t1_utime[$tid]:-0} ))
        ds=$(( ${stime2:-0} - ${t1_stime[$tid]:-0} ))
        local cpu_ticks=$(( du + ds ))
        local cpu_pct_t
        cpu_pct_t=$(echo "$cpu_ticks $elapsed_ticks" | awk '{printf "%.1f", $1*100/$2}')

        # Scheduling policy for this thread
        local sched_str="normal"
        if command -v chrt &>/dev/null; then
            local chrt_t
            chrt_t=$(chrt -p "$tid" 2>/dev/null | grep policy | grep -oP '(?<=policy: )\S+' || echo "")
            [[ -n "$chrt_t" ]] && sched_str="$chrt_t"
        fi

        local cpu_colour="$RESET"
        local cpu_f
        cpu_f=$(echo "$cpu_pct_t" | awk '{printf "%d", $1}')
        (( cpu_f >= 50 )) && cpu_colour="$YELLOW"
        (( cpu_f >= 80 )) && cpu_colour="$RED"

        printf "  %-8s %-20s ${cpu_colour}%5s%%${RESET} %5s  %-12s  %s\n" \
            "$tid" "$tname" "$cpu_pct_t" "${last_cpu:-?}" "$sched_str" "$state_char"

        # Check if this thread is running on an unexpected CPU (outside pinned set)
        if [[ -n "$RADIOD_PINNED_CPUS" && "${last_cpu:-}" =~ ^[0-9]+$ ]]; then
            local _in_pinned=false
            local _pin_parts=()
            IFS=',' read -ra _pin_parts <<< "$RADIOD_PINNED_CPUS"
            for _pp in "${_pin_parts[@]}"; do
                if [[ "$_pp" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                    (( last_cpu >= BASH_REMATCH[1] && last_cpu <= BASH_REMATCH[2] )) && _in_pinned=true && break
                else
                    [[ "$_pp" == "$last_cpu" ]] && _in_pinned=true && break
                fi
            done
            if ! $_in_pinned; then
                threads_off_core+=("${tid}:${tname}:${last_cpu}")
            fi
        fi

        (( thread_count++ )) || true
        total_cpu=$(echo "$total_cpu $cpu_pct_t" | awk '{printf "%.1f", $1+$2}')

        # Accumulate CPU% for key thread groups
        if [[ "$tname" == fft* ]]; then
            fft_cpu=$(echo "$fft_cpu $cpu_pct_t"           | awk '{printf "%.1f", $1+$2}')
        elif [[ "$tname" == proc_* ]]; then
            proc_cpu=$(echo "$proc_cpu $cpu_pct_t"         | awk '{printf "%.1f", $1+$2}')
        elif [[ "$tname" == spect* ]]; then
            spect_cpu=$(echo "$spect_cpu $cpu_pct_t"       | awk '{printf "%.1f", $1+$2}')
        elif [[ "$tname" == lin* ]]; then
            lin_cpu=$(echo "$lin_cpu $cpu_pct_t"           | awk '{printf "%.1f", $1+$2}')
        elif [[ "$tname" == "radio stat"* ]]; then
            radiostat_cpu=$(echo "$radiostat_cpu $cpu_pct_t" | awk '{printf "%.1f", $1+$2}')
        fi
    done

    echo ""
    kv "Total threads shown" "$thread_count"

    # Linux reports CPU% per logical CPU (100% = one full logical CPU).
    # For a multi-threaded process, the sum can exceed 100%.
    # Dividing by the number of pinned CPUs gives the average load per core,
    # which is the most useful figure for capacity planning.
    local pinned_count="$RADIOD_PINNED_CPU_COUNT"
    if (( pinned_count < 1 )); then
        pinned_count=$(nproc --all 2>/dev/null || echo "1")
    fi
    local per_core_pct
    per_core_pct=$(echo "$total_cpu $pinned_count" | awk '{printf "%.1f", $1/$2}')
    local total_logical
    total_logical=$(nproc --all 2>/dev/null || echo "1")
    local normalised_pct
    normalised_pct=$(echo "$total_cpu $total_logical" | awk '{printf "%.1f", $1/$2}')

    kv "Total CPU% (sum of all threads)" "${total_cpu}%"
    kv "Avg load per pinned core (÷${pinned_count} CPUs)" "${per_core_pct}%" "$CYAN"
    kv "Avg load per system core (÷${total_logical} CPUs)" "${normalised_pct}%" "$CYAN"

    # ── CPU pinning verification ───────────────────────────────────────────────
    # If CPU pinning is active, warn if any thread was observed running outside
    # the pinned set.  This can happen if:
    #   • the cpuset was applied to the container but a thread escaped (kernel bug)
    #   • the taskset/cpuset was changed after radiod started
    #   • the cgroup namespace shifts CPU numbers (host vs container view mismatch)
    if [[ -n "$RADIOD_PINNED_CPUS" ]]; then
        echo ""
        if (( ${#threads_off_core[@]} == 0 )); then
            ok_line "CPU pinning verified — all threads observed on pinned CPUs (${RADIOD_PINNED_CPUS})"
        else
            warn_line "CPU pinning is ACTIVE (${RADIOD_PINNED_CPUS}) but ${#threads_off_core[@]} thread(s) were observed on unexpected cores!"
            warn_line "This may indicate a cpuset misconfiguration or a cgroup namespace CPU-number mismatch."
            echo ""
            printf "  ${BOLD}%-8s %-20s %s${RESET}\n" "TID" "Thread name" "Observed CPU#"
            printf "  %s\n" "$(printf '%.0s─' {1..45})"
            for _entry in "${threads_off_core[@]}"; do
                local _t_tid _t_name _t_cpu
                IFS=':' read -r _t_tid _t_name _t_cpu <<< "$_entry"
                printf "  ${RED}%-8s %-20s %s${RESET}\n" "$_t_tid" "$_t_name" "$_t_cpu"
            done
            echo ""
            info_line "Possible causes:"
            info_line "  1. Docker cpuset (${RADIOD_PINNED_CPUS}) uses host CPU numbers; /proc shows container-namespace numbers"
            info_line "  2. The cpuset was not applied before radiod started"
            info_line "  3. A kernel or cgroup bug allowed threads to escape the cpuset"
            info_line "Check: docker exec ka9q-radio taskset -cp 1  (should show pinned CPUs)"
        fi
    fi

    # Export for summary section
    RADIOD_TOTAL_CPU="$total_cpu"
    RADIOD_FFT_CPU="$fft_cpu"
    RADIOD_PROC_CPU="$proc_cpu"
    RADIOD_SPECT_CPU="$spect_cpu"
    RADIOD_LIN_CPU="$lin_cpu"
    RADIOD_RADIOSTAT_CPU="$radiostat_cpu"
}

# ── 10. IRQ Affinity for SDR Hardware ─────────────────────────────────────────

section_irq_affinity() {
    header "IRQ Affinity (SDR / USB / PCIe)"

    if [[ ! -d /proc/irq ]]; then
        info_line "/proc/irq not available"
        return
    fi

    # ── Detect RX888 USB device ───────────────────────────────────────────────
    # Vendor 04b4 (Cypress), products 00f1 (MkI) / 00f3 (MkII)
    local rx888_busnum="" rx888_devnum="" rx888_pci_slot=""
    for d in /sys/bus/usb/devices/*/; do
        local vf="${d}idVendor" pf="${d}idProduct"
        [[ -f "$vf" && -f "$pf" ]] || continue
        local vid pid
        vid=$(cat "$vf" 2>/dev/null || echo "")
        pid=$(cat "$pf" 2>/dev/null || echo "")
        if [[ "$vid" == "04b4" && ( "$pid" == "00f1" || "$pid" == "00f3" ) ]]; then
            rx888_busnum=$(cat "${d}busnum" 2>/dev/null || echo "")
            rx888_devnum=$(cat "${d}devnum" 2>/dev/null || echo "")
            # Walk up to find the PCI slot of the host controller
            # The USB device dir is e.g. /sys/bus/usb/devices/1-2; its parent
            # chain leads to the xhci_hcd PCI device.
            local real_d
            real_d=$(readlink -f "$d" 2>/dev/null || echo "$d")
            # Go up until we find a PCI device (has a 'vendor' file that's a PCI vendor)
            local p="$real_d"
            while [[ "$p" != "/" ]]; do
                p=$(dirname "$p")
                if [[ -f "${p}/vendor" && -f "${p}/class" ]]; then
                    local pci_class
                    pci_class=$(cat "${p}/class" 2>/dev/null || echo "")
                    # PCI class 0x0c03xx = USB controller
                    if [[ "$pci_class" == 0x0c03* ]]; then
                        rx888_pci_slot=$(basename "$p")
                        break
                    fi
                fi
            done
            break
        fi
    done

    if [[ -n "$rx888_busnum" ]]; then
        local rx888_pid_str
        rx888_pid_str=$(cat "/sys/bus/usb/devices/$(printf '%d' "$rx888_busnum")-0/idProduct" 2>/dev/null || echo "")
        ok_line "RX888 detected on USB bus ${rx888_busnum}, device ${rx888_devnum}${rx888_pci_slot:+ (PCI: ${rx888_pci_slot})}"
    else
        info_line "RX888 not detected on USB (vendor 04b4 / product 00f1 or 00f3)"
    fi
    echo ""

    local found_any=false

    # ── Show IRQs for USB controllers and SDR devices ─────────────────────────
    for irq_dir in /proc/irq/[0-9]*/; do
        [[ -d "$irq_dir" ]] || continue
        local irq_num
        irq_num=$(basename "$irq_dir")

        local irq_desc
        irq_desc=$(awk -v irq="$irq_num" '$1 == irq":" {$1=$2=""; sub(/^[[:space:]]+/,""); print}' \
            /proc/interrupts 2>/dev/null | sed 's/  */ /g' | sed 's/^ //' || echo "")

        # Filter for USB, xhci, ehci, PCIe, RTL, airspy, hackrf, lime, etc.
        if echo "$irq_desc" | grep -qiE 'xhci|ehci|uhci|ohci|usb|pcie|rtl|airspy|hackrf|lime|sdr|rx888|funcube'; then
            local affinity_file="${irq_dir}smp_affinity_list"
            local affinity=""
            affinity=$(cat "$affinity_file" 2>/dev/null || echo "?")

            # Check if this IRQ's PCI slot matches the RX888's host controller
            local rx888_marker=""
            if [[ -n "$rx888_pci_slot" ]] && echo "$irq_desc" | grep -q "$rx888_pci_slot"; then
                rx888_marker=" ${CYAN}← RX888 USB controller${RESET}"
            fi

            # IRQ affinity is GOOD when it does NOT overlap with radiod's pinned CPUs.
            # The interrupt should be handled by a non-radiod CPU so radiod's RT threads
            # are never preempted by USB DMA completions.
            # It is BAD when the affinity is all CPUs (0-7) or includes radiod's cores.
            #
            # NOTE: isolcpus= prevents the scheduler from placing tasks on those CPUs,
            # but it does NOT prevent hardware IRQs from being delivered to them.
            # smp_affinity_list is a separate kernel mechanism and must be set explicitly.
            local irq_overlaps_radiod=false
            local irq_covers_all=false
            local total_logical_cpus
            total_logical_cpus=$(nproc --all 2>/dev/null || echo "8")

            if [[ -n "$RADIOD_PINNED_CPUS" && "$affinity" != "?" ]]; then
                # Check if affinity covers all CPUs (e.g. 0-7)
                local _irq_cpus=()
                IFS=',' read -ra _ap <<< "$affinity"
                for _a in "${_ap[@]}"; do
                    if [[ "$_a" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                        for (( _n=${BASH_REMATCH[1]}; _n<=${BASH_REMATCH[2]}; _n++ )); do
                            _irq_cpus+=("$_n")
                        done
                    else
                        _irq_cpus+=("$_a")
                    fi
                done
                (( ${#_irq_cpus[@]} >= total_logical_cpus )) && irq_covers_all=true

                # Check for overlap with radiod's pinned CPUs
                local _pin_cpus=()
                IFS=',' read -ra _pp <<< "$RADIOD_PINNED_CPUS"
                for _p in "${_pp[@]}"; do
                    if [[ "$_p" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                        for (( _n=${BASH_REMATCH[1]}; _n<=${BASH_REMATCH[2]}; _n++ )); do
                            _pin_cpus+=("$_n")
                        done
                    else
                        _pin_cpus+=("$_p")
                    fi
                done
                for _ic in "${_irq_cpus[@]}"; do
                    for _pc in "${_pin_cpus[@]}"; do
                        [[ "$_ic" == "$_pc" ]] && irq_overlaps_radiod=true && break 2
                    done
                done
            fi

            # Find a non-radiod CPU to suggest for the fix
            local _suggest_cpu=""
            if [[ -n "$RADIOD_PINNED_CPUS" ]]; then
                for (( _c=0; _c<total_logical_cpus; _c++ )); do
                    local _in_pin=false
                    for _pc in "${_pin_cpus[@]}"; do
                        [[ "$_pc" == "$_c" ]] && _in_pin=true && break
                    done
                    if ! $_in_pin; then _suggest_cpu="$_c"; break; fi
                done
            fi

            local affinity_colour="$RESET"
            local affinity_note=""
            if [[ -n "$RADIOD_PINNED_CPUS" ]]; then
                if $irq_covers_all || $irq_overlaps_radiod; then
                    affinity_colour="$YELLOW"
                    affinity_note=" ⚠ includes radiod's CPUs — IRQ may interrupt RT threads"
                else
                    affinity_colour="$GREEN"
                    affinity_note=" ✓ on non-radiod CPU"
                fi
            fi

            printf "  IRQ %-5s  affinity=[${affinity_colour}%-10s${RESET}]  %s%b%s\n" \
                "$irq_num" "$affinity" "$(echo "$irq_desc" | cut -c1-40)" \
                "$rx888_marker" "$affinity_note"
            found_any=true
        fi
    done

    if ! $found_any; then
        info_line "No USB/PCIe SDR-related IRQs found (may need root, or device not connected)"
    fi

    echo ""
    if [[ -n "$RADIOD_PINNED_CPUS" && -n "$_suggest_cpu" ]]; then
        info_line "Ideal: USB controller IRQ should be handled by a non-radiod CPU"
        info_line "       so radiod's RT threads (${RADIOD_PINNED_CPUS}) are never interrupted by USB DMA completions"
    fi
}

# ── 11. System-wide CPU Load Snapshot ─────────────────────────────────────────

section_cpu_load() {
    header "System CPU Load (0.5 s sample)"

    # Sample /proc/stat twice
    declare -A idle1 total1 idle2 total2

    while IFS= read -r line; do
        [[ "$line" =~ ^cpu([0-9]+)[[:space:]]+(.*) ]] || continue
        local cpu_n="${BASH_REMATCH[1]}"
        local fields=(${BASH_REMATCH[2]})
        idle1["$cpu_n"]="${fields[3]}"
        local tot=0
        for f in "${fields[@]}"; do (( tot += f )) || true; done
        total1["$cpu_n"]=$tot
    done < /proc/stat
sleep 5


    while IFS= read -r line; do
        [[ "$line" =~ ^cpu([0-9]+)[[:space:]]+(.*) ]] || continue
        local cpu_n="${BASH_REMATCH[1]}"
        local fields=(${BASH_REMATCH[2]})
        idle2["$cpu_n"]="${fields[3]}"
        local tot=0
        for f in "${fields[@]}"; do (( tot += f )) || true; done
        total2["$cpu_n"]=$tot
    done < /proc/stat

    # Display per-CPU bar chart
    local cols=0
    local line_buf=""
    local cpu_ids=()
    for k in "${!idle1[@]}"; do cpu_ids+=("$k"); done
    IFS=$'\n' cpu_ids=($(printf '%s\n' "${cpu_ids[@]}" | sort -n)); unset IFS

    for cpu_n in "${cpu_ids[@]}"; do
        local d_idle=$(( idle2["$cpu_n"] - idle1["$cpu_n"] ))
        local d_total=$(( total2["$cpu_n"] - total1["$cpu_n"] ))
        local busy_pct=0
        (( d_total > 0 )) && busy_pct=$(( (d_total - d_idle) * 100 / d_total )) || true

        # Bar (20 chars wide)
        local bar_len=$(( busy_pct / 5 ))
        (( bar_len > 20 )) && bar_len=20
        local bar
        printf -v bar '%*s' "$bar_len" ''
        bar="${bar// /█}"
        printf -v bar '%-20s' "$bar"

        local colour="$GREEN"
        (( busy_pct >= 50 )) && colour="$YELLOW"
        (( busy_pct >= 80 )) && colour="$RED"

        # Mark if radiod is pinned to this CPU.
        # Use RADIOD_PINNED_CPUS (real Docker cpuset) when available, so the stars
        # reflect the actual cpuset (0,2,4,6) rather than the cgroup-shifted view.
        local pin_marker="  "
        if $RADIOD_RUNNING && [[ -n "$RADIOD_PINNED_CPUS" ]]; then
            local in_aff=false
            IFS=',' read -ra aff_parts <<< "$RADIOD_PINNED_CPUS"
            for ap in "${aff_parts[@]}"; do
                if [[ "$ap" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                    (( cpu_n >= BASH_REMATCH[1] && cpu_n <= BASH_REMATCH[2] )) && in_aff=true
                else
                    [[ "$ap" == "$cpu_n" ]] && in_aff=true
                fi
            done
            $in_aff && pin_marker="${CYAN}★${RESET} "
        elif $RADIOD_RUNNING && command -v taskset &>/dev/null; then
            local aff
            aff=$(taskset -cp "$RADIOD_PID" 2>/dev/null | grep -oP '(?<=affinity list: ).*' || echo "")
            if [[ -n "$aff" ]]; then
                local in_aff=false
                IFS=',' read -ra aff_parts <<< "$aff"
                for ap in "${aff_parts[@]}"; do
                    if [[ "$ap" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                        (( cpu_n >= BASH_REMATCH[1] && cpu_n <= BASH_REMATCH[2] )) && in_aff=true
                    else
                        [[ "$ap" == "$cpu_n" ]] && in_aff=true
                    fi
                done
                $in_aff && pin_marker="${CYAN}★${RESET} "
            fi
        fi

        printf "  %scpu%-3s ${colour}[%s]${RESET} %3d%%\n" \
            "$pin_marker" "$cpu_n" "$bar" "$busy_pct"
    done

    echo ""
    info_line "★ = CPU in radiod's cpuset"

    # Load averages
    local loadavg
    loadavg=$(cat /proc/loadavg 2>/dev/null || echo "? ? ?")
    local la1 la5 la15
    la1=$(echo "$loadavg" | awk '{print $1}')
    la5=$(echo "$loadavg" | awk '{print $2}')
    la15=$(echo "$loadavg" | awk '{print $3}')
    echo ""
    kv "Load average (1/5/15 min)" "${la1} / ${la5} / ${la15}"
}

# ── 12. FFTW Wisdom Status ────────────────────────────────────────────────────

section_fftw_wisdom() {
    header "FFTW Wisdom"

    # FFTW wisdom pre-computes optimal FFT plans for the exact hardware.
    # Without it, radiod recomputes plans on every start (slow) and may use
    # sub-optimal FFT algorithms.  With it, startup is fast and FFT throughput
    # is maximised for this specific CPU.

    local wisdom_ok=false

    # ── Check inside the container via docker logs ─────────────────────────
    # Filter out system wisdom lines (fftwf_import_system_wisdom / wisdomf) —
    # those always fail and are not relevant.  Only show per-file wisdom lines.
    local logs=""
    if command -v docker &>/dev/null; then
        logs=$(docker logs ka9q-radio 2>&1 \
            | grep -i wisdom \
            | grep -iv 'system_wisdom\|wisdomf' \
            | sort -u \
            || echo "")
    fi

    if [[ -n "$logs" ]]; then
        if echo "$logs" | grep -qi 'succeeded'; then
            ok_line "FFTW wisdom loaded successfully"
            wisdom_ok=true
        else
            bad_line "FFTW wisdom NOT loaded"
        fi

        # Show deduplicated relevant log lines
        echo ""
        echo "$logs" | while IFS= read -r line; do
            if echo "$line" | grep -qi 'succeeded'; then
                printf "  ${GREEN}%s${RESET}\n" "$line"
            else
                printf "  ${YELLOW}%s${RESET}\n" "$line"
            fi
        done
    else
        info_line "No wisdom log lines found in docker logs (container may not be running or logs rotated)"
    fi

    # ── Check wisdom file inside the container directly ────────────────────
    echo ""
    if command -v docker &>/dev/null; then
        local wf_info
        wf_info=$(docker exec ka9q-radio ls -lh /var/lib/ka9q-radio/wisdom 2>/dev/null || echo "")
        if [[ -n "$wf_info" ]]; then
            local wf_size wf_date
            wf_size=$(echo "$wf_info" | awk '{print $5}')
            wf_date=$(echo "$wf_info" | awk '{print $6, $7, $8}')
            kv "Wisdom file (container)" "/var/lib/ka9q-radio/wisdom" "$GREEN"
            kv "  Size" "$wf_size"
            kv "  Last modified" "$wf_date"
        else
            info_line "Wisdom file not found inside container at /var/lib/ka9q-radio/wisdom"
        fi
    fi

    if ! $wisdom_ok; then
        echo ""
        warn_line "FFTW wisdom not loaded — FFT plans recomputed on each start (slower startup)"
        info_line "Generate: docker exec ka9q-radio fft-gen /var/lib/ka9q-radio/wisdom"
        info_line "(Takes several minutes; only needed once per hardware change)"
    fi

    # ── Check fft-threads in radiod config ────────────────────────────────────
    echo ""
    if command -v docker &>/dev/null; then
        local fft_threads_val=""
        # Read from the primary radiod config file.
        # Try the known UberSDR config name first, then fall back to any .conf in the dir.
        local _conf_file=""
        _conf_file=$(docker exec ka9q-radio sh -c \
            'ls /etc/ka9q-radio/radiod@ubersdr.conf /etc/ka9q-radio/radiod*.conf 2>/dev/null | head -1' \
            || echo "")
        if [[ -n "$_conf_file" ]]; then
            fft_threads_val=$(docker exec ka9q-radio \
                grep -m1 'fft-threads' "$_conf_file" 2>/dev/null \
                | grep -oP 'fft-threads\s*=\s*\K[0-9]+' || echo "")
            kv "Config file checked" "$_conf_file" "$DIM"
        fi

        if [[ -n "$fft_threads_val" ]]; then
            RADIOD_FFT_THREADS="$fft_threads_val"
            if (( fft_threads_val == 1 )); then
                ok_line "fft-threads = ${fft_threads_val}  (optimal)"
            elif (( fft_threads_val == 2 )); then
                kv "fft-threads" "$fft_threads_val"
                info_line "fft-threads=2 is acceptable; try fft-threads=1 for lower latency"
            else
                kv "fft-threads" "$fft_threads_val" "$YELLOW"
                warn_line "fft-threads=${fft_threads_val} is high — recommend setting to 1 or 2"
                echo "    Fix: UberSDR Admin → radiod tab → set fft-threads = 1"
            fi
        else
            info_line "fft-threads not set in radiod config (default will be used)"
        fi
    fi

    # Export for summary
    FFTW_WISDOM_OK="$wisdom_ok"
}

# Global for summary
FFTW_WISDOM_OK=false
RADIOD_FFT_THREADS=""   # value of fft-threads from radiod config (empty = not found)

# ── 13. Summary & Recommendations ─────────────────────────────────────────────

section_summary() {
    header "Summary & Recommendations"

    local issues=0

    # Governor check
    local bad_gov=false
    for gov_file in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        [[ -f "$gov_file" ]] || continue
        local g
        g=$(cat "$gov_file" 2>/dev/null || echo "")
        [[ "$g" != "performance" ]] && bad_gov=true && break
    done
    if $bad_gov; then
        warn_line "CPU governor is not 'performance'"
        echo "    Fix: use 'Manage CPU Governor' in UberSDR Admin"
        info_line "Note: 'performance' eliminates frequency-scaling latency at the cost of higher power use and heat."
        info_line "      Consider the trade-off if running on low-power or fanless hardware."
        (( issues++ )) || true
    else
        ok_line "CPU governor: performance"
    fi

    # radiod running
    if ! $RADIOD_RUNNING; then
        bad_line "radiod is not running"
        (( issues++ )) || true
    else
        ok_line "radiod is running (PID ${RADIOD_PID})"
    fi

    # CPU usage summary (populated by section_threads)
    if $RADIOD_RUNNING && [[ -n "$RADIOD_TOTAL_CPU" ]]; then
        local _pinned="${RADIOD_PINNED_CPU_COUNT:-0}"
        (( _pinned < 1 )) && _pinned=$(nproc --all 2>/dev/null || echo "1")
        local _total_log
        _total_log=$(nproc --all 2>/dev/null || echo "1")
        local _per_core _normalised
        _per_core=$(echo "$RADIOD_TOTAL_CPU $_pinned"    | awk '{printf "%.1f", $1/$2}')
        _normalised=$(echo "$RADIOD_TOTAL_CPU $_total_log" | awk '{printf "%.1f", $1/$2}')
        ok_line "radiod CPU: ${RADIOD_TOTAL_CPU}% total  |  ${_per_core}% avg per pinned core (${_pinned} CPUs)  |  ${_normalised}% avg per system core"
        _nonzero() { [[ -n "$1" && "$1" != "0" && "$1" != "0.0" ]]; }
        _nonzero "$RADIOD_FFT_CPU"       && info_line "  └─ fft* threads:        ${RADIOD_FFT_CPU}%"
        _nonzero "$RADIOD_PROC_CPU"      && info_line "  └─ proc_* threads:      ${RADIOD_PROC_CPU}%"
        _nonzero "$RADIOD_SPECT_CPU"     && info_line "  └─ spect* threads:      ${RADIOD_SPECT_CPU}%"
        _nonzero "$RADIOD_LIN_CPU"       && info_line "  └─ lin* threads:        ${RADIOD_LIN_CPU}%"
        _nonzero "$RADIOD_RADIOSTAT_CPU" && info_line "  └─ radio stat threads:  ${RADIOD_RADIOSTAT_CPU}%"
    fi

    # RT scheduling — check worker threads, not the main process
    if $RADIOD_RUNNING; then
        local rt_count=0
        if docker exec ka9q-radio ps -eLo cls 2>/dev/null | grep -qw 'FF'; then
            rt_count=$(docker exec ka9q-radio ps -eLo cls 2>/dev/null | grep -c 'FF' || echo "0")
        else
            local task_dir="/proc/${RADIOD_PID}/task"
            if [[ -d "$task_dir" ]] && command -v chrt &>/dev/null; then
                for tid_dir in "${task_dir}"/*/; do
                    local tid pol
                    tid=$(basename "$tid_dir")
                    pol=$(chrt -p "$tid" 2>/dev/null | grep -oP '(?<=policy: )\S+' || echo "")
                    [[ "$pol" =~ FIFO|RR ]] && (( rt_count++ )) || true
                done
            fi
        fi
        if (( rt_count > 0 )); then
            ok_line "radiod RT scheduling: ${rt_count} SCHED_FIFO worker thread(s) active"
        else
            warn_line "No SCHED_FIFO threads found in radiod"
            echo "    Check: docker exec ka9q-radio ps -eLo tid,cls,rtprio,comm"
            echo "    Ensure ulimits rtprio=99 and cap_add: SYS_NICE are set"
            (( issues++ )) || true
        fi
    fi

    # CPU pinning — prefer the real compose cpuset over the cgroup-shifted taskset view
    if $RADIOD_RUNNING; then
        local total_logical
        total_logical=$(nproc --all 2>/dev/null || echo "1")
        if [[ -n "$RADIOD_PINNED_CPUS" && "$RADIOD_PINNED_CPUS" != "0-$(( total_logical - 1 ))" ]]; then
            ok_line "radiod pinned to CPUs: ${RADIOD_PINNED_CPUS}"

            # L3 domain check on the real pinned set
            declare -A _sum_l3_domains
            IFS=',' read -ra _sum_parts <<< "$RADIOD_PINNED_CPUS"
            for _sp in "${_sum_parts[@]}"; do
                local _sum_cpus=()
                if [[ "$_sp" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                    for (( _sn=${BASH_REMATCH[1]}; _sn<=${BASH_REMATCH[2]}; _sn++ )); do
                        _sum_cpus+=("$_sn")
                    done
                else
                    _sum_cpus+=("$_sp")
                fi
                for _sc in "${_sum_cpus[@]}"; do
                    local _sum_cache_base="/sys/devices/system/cpu/cpu${_sc}/cache"
                    [[ -d "$_sum_cache_base" ]] || continue
                    for _sum_idx in "${_sum_cache_base}"/index*/; do
                        [[ -d "$_sum_idx" ]] || continue
                        local _sl _st _ss
                        _sl=$(cat "${_sum_idx}level" 2>/dev/null || echo "")
                        _st=$(cat "${_sum_idx}type"  2>/dev/null || echo "")
                        [[ "$_sl" == "3" && "$_st" == "Unified" ]] || continue
                        _ss=$(cat "${_sum_idx}shared_cpu_list" 2>/dev/null || echo "")
                        _sum_l3_domains["$_ss"]=1
                        break
                    done
                done
            done
            local _sum_l3_count="${#_sum_l3_domains[@]}"
            if (( _sum_l3_count > 1 )); then
                warn_line "Pinned CPUs span ${_sum_l3_count} L3 cache domains — cross-L3 buffer handoffs add latency"
                info_line "Use 'Manage CPU Pinning' in UberSDR Admin, or run: ./suggest-radiod-cpuset.sh --apply"
                (( issues++ )) || true
            fi
        elif command -v taskset &>/dev/null; then
            local aff
            aff=$(taskset -cp "$RADIOD_PID" 2>/dev/null | grep -oP '(?<=affinity list: ).*' || echo "")
            if [[ "$aff" == "0-$(( total_logical - 1 ))" || -z "$aff" ]]; then
                if (( L3_DOMAIN_COUNT > 1 )); then
                    warn_line "radiod is not pinned to specific CPUs (${L3_DOMAIN_COUNT} L3 cache domains detected)"
                    echo "    Without pinning, threads may migrate between L3 domains, adding cache-miss latency."
                    info_line "Use 'Manage CPU Pinning' in UberSDR Admin, or run: ./suggest-radiod-cpuset.sh --apply"
                    (( issues++ )) || true
                fi
            else
                ok_line "radiod pinned to CPUs: ${aff}"
            fi
        fi
    fi

    # AVX2
    if grep -m1 '^flags' /proc/cpuinfo 2>/dev/null | grep -qw 'avx2'; then
        ok_line "AVX2 SIMD instructions available"
    else
        warn_line "No AVX2 — DSP performance may be limited"
        (( issues++ )) || true
    fi

    # Turbo
    local intel_no_turbo="/sys/devices/system/cpu/intel_pstate/no_turbo"
    if [[ -f "$intel_no_turbo" ]]; then
        local nt
        nt=$(cat "$intel_no_turbo")
        [[ "$nt" == "1" ]] && warn_line "Intel Turbo Boost is disabled" && (( issues++ )) || true
    fi

    # FFTW wisdom
    if [[ "$FFTW_WISDOM_OK" == "true" ]]; then
        ok_line "FFTW wisdom loaded"
    else
        warn_line "FFTW wisdom not loaded — FFT plans recomputed on each start (slower startup, possibly sub-optimal)"
        echo "    Fix: docker exec ka9q-radio fft-gen /var/lib/ka9q-radio/wisdom"
        (( issues++ )) || true
    fi

    # fft-threads
    if [[ -n "$RADIOD_FFT_THREADS" ]]; then
        if (( RADIOD_FFT_THREADS == 1 )); then
            ok_line "fft-threads = 1 (optimal)"
        elif (( RADIOD_FFT_THREADS == 2 )); then
            info_line "fft-threads = 2 (acceptable; try 1 for lower latency)"
        else
            warn_line "fft-threads = ${RADIOD_FFT_THREADS} — recommend setting to 1 or 2"
            echo "    Fix: UberSDR Admin → radiod tab → set fft-threads = 1"
            (( issues++ )) || true
        fi
    fi

    echo ""
    if (( issues == 0 )); then
        ok_line "All checks passed — UberSDR is well-configured for real-time SDR"
    else
        warn_line "${issues} issue(s) found — see recommendations above"
    fi
}

# ── Main ──────────────────────────────────────────────────────────────────────

run_all() {
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S %Z')

    echo ""
    echo -e "${BOLD}${MAGENTA}╔══════════════════════════════════════════════════════════════╗${RESET}"
    echo -e "${BOLD}${MAGENTA}║      UberSDR — radiod CPU & Performance Analysis             ║${RESET}"
    echo -e "${BOLD}${MAGENTA}║  ${timestamp}$(printf '%*s' $(( 60 - ${#timestamp} )) '')║${RESET}"
    echo -e "${BOLD}${MAGENTA}╚══════════════════════════════════════════════════════════════╝${RESET}"

    section_cpu_model
    section_cpu_flags
    section_cache
    section_numa
    section_governor
    section_kernel_params
    section_radiod_process
    section_affinity
    section_threads
    section_irq_affinity
    section_cpu_load
    section_fftw_wisdom
    section_summary

    echo ""
}

if (( WATCH_INTERVAL > 0 )); then
    while true; do
        clear 2>/dev/null || printf '\033[2J\033[H'
        run_all
        echo -e "  ${DIM}Refreshing every ${WATCH_INTERVAL}s — Ctrl+C to stop${RESET}"
        sleep "$WATCH_INTERVAL"
    done
else
    run_all
fi