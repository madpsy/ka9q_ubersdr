#!/bin/bash

# suggest-radiod-cpuset.sh
#
# Reads CPU topology from /sys and suggests the best physical core(s)
# to assign to radiod via cpuset in docker-compose.yml.
#
# Selection criteria:
#   1. Find all physical cores and their HT siblings by reading the kernel's
#      thread_siblings_list (the authoritative source of HT pairs)
#   2. Map each core to its L3 cache domain via the cache sysfs hierarchy
#      (falls back to NUMA node when L3 sysfs is unavailable)
#   3. On ARM big.LITTLE systems, identify cluster type (LITTLE/big/prime) for
#      each core via CPU part codes in /proc/cpuinfo.  By default, big/prime
#      cores are preferred; use --cluster to override.
#   4. Select N cores from the preferred cluster/L3 domain (lowest CPU number
#      order), spilling into other domains only if more cores are needed.
#      Current idle% is not used.
#
# Usage:
#   ./suggest-radiod-cpuset.sh [--cores N] [--cluster auto|big|little|prime] [--quiet]
#                              [--apply [--compose-file <path>]] [--remove]
#
# Options:
#   --cores N               Number of physical cores to assign (default: 1)
#   --cluster TYPE          ARM big.LITTLE cluster preference: auto (default),
#                           big, little, or prime.  Ignored on x86.
#   --quiet                 Output only the cpuset string, e.g. "0,4"
#   --apply                 Write the recommended cpuset into the docker-compose file
#   --remove                Remove cpuset from docker-compose and nohz_full/rcu_nocbs from grub
#   --compose-file PATH     Path to docker-compose file (default: docker-compose.yml
#                           in the same directory as this script)
#
# Examples:
#   ./suggest-radiod-cpuset.sh
#   ./suggest-radiod-cpuset.sh --cores 2
#   ./suggest-radiod-cpuset.sh --cores 2 --cluster big
#   ./suggest-radiod-cpuset.sh --cores 2 --apply --compose-file ~/ubersdr/docker-compose.yml
#   ./suggest-radiod-cpuset.sh --quiet --cores 1
#   ./suggest-radiod-cpuset.sh --remove
#   ./suggest-radiod-cpuset.sh --remove --compose-file ~/ubersdr/docker-compose.yml

set -euo pipefail

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

# ── tmux session launcher (no-args / interactive mode) ───────────────────────
# When launched via GoTTY (?arg=) with no arguments the script runs
# interactively.  Matching generate_wisdom.sh: check tmux, create a named
# session that runs the actual work, then attach so the GoTTY window shows the
# tmux session.  The session persists if the browser window is closed and
# appears in the Terminal → sessions dropdown for re-attachment.

if [[ $# -eq 0 ]]; then
    echo "=== radiod CPU Pinning Helper ==="
    echo

    # Check if tmux is installed
    if ! command -v tmux &> /dev/null; then
        echo "Error: tmux is not installed. Please install it first:"
        echo "  sudo apt install -y tmux"
        exit 1
    fi

    SESSION_NAME="radiod-cpuset"

    # If session already exists, re-attach to it (e.g. browser tab was closed)
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        echo "Resuming existing tmux session '$SESSION_NAME'..."
        echo
        tmux attach -t "$SESSION_NAME"
        exit 0
    fi

    echo "Creating tmux session '$SESSION_NAME' and starting CPU pinning helper..."
    echo

    tmux new-session -d -s "$SESSION_NAME" -n 'CPU Pinning' "bash $0 --_interactive; echo; echo; echo 'Press Enter to close...'; read"

    echo "Attaching to session now..."
    sleep 1
    tmux attach -t "$SESSION_NAME"
    exit 0
fi

# ── Argument parsing ──────────────────────────────────────────────────────────

QUIET=false
APPLY=false
REMOVE=false
SKIP_GRUB=false   # true when user explicitly declines docker-compose apply
NUM_CORES=1
NUM_CORES_SET=false   # true when --cores was explicitly passed
CLUSTER_PREF="auto"   # auto | big | little | prime  (ARM big.LITTLE only)
CLUSTER_PREF_SET=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
INTERACTIVE=false

# Detect interactive mode: launched via the tmux session wrapper above
if [[ "${1:-}" == "--_interactive" ]]; then
    INTERACTIVE=true
    shift
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --quiet)    QUIET=true;   shift ;;
        --apply)    APPLY=true;   shift ;;
        --remove)   REMOVE=true;  shift ;;
        --cores)
            [[ -n "${2:-}" ]] || { echo "ERROR: --cores requires a number argument" >&2; exit 1; }
            [[ "$2" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: --cores must be a positive integer" >&2; exit 1; }
            NUM_CORES="$2"; NUM_CORES_SET=true; shift 2 ;;
        --cluster)
            [[ -n "${2:-}" ]] || { echo "ERROR: --cluster requires a value (auto|big|little|prime)" >&2; exit 1; }
            case "${2,,}" in
                auto|big|little|prime) CLUSTER_PREF="${2,,}"; CLUSTER_PREF_SET=true ;;
                *) echo "ERROR: --cluster must be one of: auto big little prime" >&2; exit 1 ;;
            esac
            shift 2 ;;
        --compose-file)
            [[ -n "${2:-}" ]] || { echo "ERROR: --compose-file requires a path argument" >&2; exit 1; }
            COMPOSE_FILE="$2"; shift 2 ;;
        --help|-h)
            sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \?//'
            exit 0 ;;
        *)
            echo "Usage: $0 [--cores N] [--cluster auto|big|little|prime] [--quiet] [--apply [--compose-file <path>]] [--remove]" >&2
            exit 1 ;;
    esac
done

# ── Warning banner ────────────────────────────────────────────────────────────
# Shown unless --quiet is passed.

if ! $QUIET; then
    echo ""
    echo -e "\033[1;33m╔══════════════════════════════════════════════════════════════════════╗\033[0m"
    echo -e "\033[1;33m║  ⚠  MOST USERS DO NOT NEED TO RUN THIS SCRIPT                       ║\033[0m"
    echo -e "\033[1;33m╠══════════════════════════════════════════════════════════════════════╣\033[0m"
    echo -e "\033[1;33m║  CPU pinning via cpuset is an advanced tuning measure intended to    ║\033[0m"
    echo -e "\033[1;33m║  solve specific real-time latency problems, such as:                 ║\033[0m"
    echo -e "\033[1;33m║    • persistent audio drop-outs or buffer underruns                  ║\033[0m"
    echo -e "\033[1;33m║    • measurable timing jitter on a heavily loaded system             ║\033[0m"
    echo -e "\033[1;33m║    • running radiod alongside other CPU-intensive workloads          ║\033[0m"
    echo -e "\033[1;33m║                                                                      ║\033[0m"
    echo -e "\033[1;33m║  If radiod is working fine for you, stop here — applying cpuset      ║\033[0m"
    echo -e "\033[1;33m║  will inflate your load average.  It is NOT required for a normal   ║\033[0m"
    echo -e "\033[1;33m║  UberSDR installation.                                               ║\033[0m"
    echo -e "\033[1;33m╚══════════════════════════════════════════════════════════════════════╝\033[0m"
    echo ""
fi

if $INTERACTIVE; then
    echo ""
    echo "This tool can either apply CPU pinning to radiod or remove it."
    echo ""
    read -rp "What would you like to do? [apply/remove] (default: apply): " _mode_input
    _mode_input="${_mode_input:-apply}"
    case "${_mode_input,,}" in
        remove|r)
            REMOVE=true ;;
        apply|a|"")
            REMOVE=false ;;
        *)
            echo "  Please enter 'apply' or 'remove'."
            REMOVE=false ;;
    esac
    echo ""
fi

if ! $REMOVE && $INTERACTIVE; then
    echo "This tool analyses your CPU topology and suggests which physical core(s)"
    echo "to dedicate to radiod for best performance."
    echo ""
fi

# ── Remove mode ───────────────────────────────────────────────────────────────
# Removes cpuset from docker-compose and nohz_full/rcu_nocbs from grub.
# Runs early and exits — no CPU topology analysis needed.

_do_remove() {
    local compose_file="$1"
    local interactive="$2"   # "true" or "false"
    local _do_reboot=false
    local _compose_modified=false

    echo ""
    echo "  ── Removing CPU pinning ─────────────────────────────────────────────"
    echo ""

    # ── docker-compose: remove cpuset lines from ka9q-radio and ubersdr ──────
    if [[ -n "$compose_file" ]]; then
        if [[ ! -f "$compose_file" ]]; then
            echo "  ERROR: docker-compose file not found: ${compose_file}" >&2
        elif ! grep -q 'ka9q-radio:' "$compose_file"; then
            echo "  ERROR: No 'ka9q-radio:' service found in ${compose_file}" >&2
        else
            if grep -qE '^[[:space:]]+cpuset:' "$compose_file"; then
                local _bak="${compose_file}.bak.$(date +%Y%m%d%H%M%S)"
                cp "$compose_file" "$_bak"
                # Remove cpuset lines from both ka9q-radio and ubersdr service blocks
                awk '
                    /^  ka9q-radio:[[:space:]]*(#.*)?$/ { in_radiod=1; in_ubersdr=0; print; next }
                    /^  ubersdr:[[:space:]]*(#.*)?$/ { in_ubersdr=1; in_radiod=0; print; next }
                    in_radiod && /^  [^[:space:]#]/ { in_radiod=0 }
                    in_ubersdr && /^  [^[:space:]#]/ { in_ubersdr=0 }
                    (in_radiod || in_ubersdr) && /^[[:space:]]+cpuset:/ { next }
                    { print }
                ' "$compose_file" > "${compose_file}.tmp" && mv "${compose_file}.tmp" "$compose_file"
                _compose_modified=true
                echo "  ✓ Removed cpuset from ka9q-radio and ubersdr in ${compose_file}"
                echo "  Backup saved to: ${_bak}"
            else
                echo "  ✓ No cpuset lines found in ${compose_file} — nothing to remove."
            fi
            echo ""
        fi
    fi

    # ── grub: remove nohz_full / rcu_nocbs (and isolcpus if present) ─────────
    local _grub_file="/etc/default/grub"
    if [[ ! -f "$_grub_file" ]]; then
        echo "  ⚠  ${_grub_file} not found — skipping kernel parameter removal."
        echo ""
    elif ! grep -qE 'isolcpus=|nohz_full=|rcu_nocbs=' "$_grub_file" 2>/dev/null; then
        echo "  ✓ No nohz_full/rcu_nocbs/isolcpus found in ${_grub_file} — nothing to remove."
        echo ""
    else
        echo "  Found kernel parameters in ${_grub_file}:"
        grep 'GRUB_CMDLINE_LINUX' "$_grub_file"
        echo ""

        local _proceed=true
        if [[ "$interactive" == "true" ]]; then
            read -rp "  Remove nohz_full/rcu_nocbs/isolcpus from ${_grub_file}? [y/N]: " _grub_rm_ans
            [[ "${_grub_rm_ans,,}" =~ ^y ]] || _proceed=false
        fi

        if $_proceed; then
            local _grub_backup="${_grub_file}.bak.$(date +%Y%m%d%H%M%S)"
            if ! sudo cp "$_grub_file" "$_grub_backup" 2>/dev/null; then
                echo "  ERROR: could not back up ${_grub_file} (sudo cp failed)" >&2
            else
                echo "  Backup saved to: ${_grub_backup}"
                # Strip all three params (and any leading space left behind)
                sudo sed -i \
                    -e 's/ isolcpus=[^ "]*//g' \
                    -e 's/ nohz_full=[^ "]*//g' \
                    -e 's/ rcu_nocbs=[^ "]*//g' \
                    -e 's/isolcpus=[^ "]*//g' \
                    -e 's/nohz_full=[^ "]*//g' \
                    -e 's/rcu_nocbs=[^ "]*//g' \
                    "$_grub_file"
                echo "  ✓ Removed kernel parameters from ${_grub_file}"
                echo ""

                # Regenerate grub
                local _grub_cmd=""
                for _candidate in \
                    /usr/sbin/update-grub \
                    /sbin/update-grub \
                    /usr/sbin/grub2-mkconfig \
                    /usr/sbin/grub-mkconfig; do
                    [[ -x "$_candidate" ]] && _grub_cmd="$_candidate" && break
                done

                if [[ -n "$_grub_cmd" ]]; then
                    echo "  Running sudo ${_grub_cmd}..."
                    case "$_grub_cmd" in
                        *update-grub)
                            sudo "$_grub_cmd" 2>&1 | tail -3 ;;
                        *grub2-mkconfig)
                            sudo "$_grub_cmd" -o /boot/grub2/grub.cfg 2>&1 | tail -3 ;;
                        *grub-mkconfig)
                            sudo "$_grub_cmd" -o /boot/grub/grub.cfg 2>&1 | tail -3 ;;
                    esac
                    echo ""
                    echo "  ✓ Grub updated."
                else
                    echo "  ⚠  No grub update command found. Run manually: sudo update-grub"
                fi
                echo ""

                echo "  A reboot is required to deactivate these kernel parameters."
                echo ""
                if [[ "$interactive" == "true" ]]; then
                    read -rp "  Reboot now? [y/N]: " _reboot_ans
                    [[ "${_reboot_ans,,}" =~ ^y ]] && _do_reboot=true || echo "  Skipping reboot. Run 'sudo reboot' when ready."
                    echo ""
                fi
            fi
        else
            echo "  Skipping grub changes."
            echo ""
        fi
    fi

    # ── Restart UberSDR to drop the old cpuset ────────────────────────────────
    # Only needed when docker-compose was actually modified.
    if $_compose_modified; then
        local _restart_script="$HOME/ubersdr/restart-ubersdr.sh"
        echo ""
        echo -e "\033[1;33m╔══════════════════════════════════════════════════════════════════════╗\033[0m"
        echo -e "\033[1;33m║  ⚠  YOU WILL LOSE CONNECTION BRIEFLY — THIS IS EXPECTED              ║\033[0m"
        echo -e "\033[1;33m╠══════════════════════════════════════════════════════════════════════╣\033[0m"
        echo -e "\033[1;33m║  UberSDR is about to restart to remove the cpuset.                   ║\033[0m"
        echo -e "\033[1;33m║  Your browser connection to the SDR will drop for ~30 seconds        ║\033[0m"
        echo -e "\033[1;33m║  while Docker restarts the container.                                ║\033[0m"
        echo -e "\033[1;33m║                                                                      ║\033[0m"
        echo -e "\033[1;33m║  Simply refresh the page once UberSDR is back online.                ║\033[0m"
        echo -e "\033[1;33m╚══════════════════════════════════════════════════════════════════════╝\033[0m"
        echo ""
        echo "  Restarting UberSDR to remove the cpuset..."
        echo ""
        if [[ -x "$_restart_script" ]]; then
            "$_restart_script"
            echo ""
            echo "  ✓ UberSDR restarted without cpuset."
        else
            echo "  ⚠  restart-ubersdr.sh not found at ${_restart_script}"
            echo "     Run manually: cd ~/ubersdr && docker compose down && docker compose up -d"
        fi
        echo ""
    fi

    # ── Deferred reboot ───────────────────────────────────────────────────────
    if $_do_reboot; then
        echo "  Rebooting in 5 seconds — press Ctrl+C to cancel..."
        sleep 5
        sudo reboot
    fi
}

if $REMOVE; then
    # In interactive mode, ask for the compose file path
    if $INTERACTIVE; then
        _default_compose="$HOME/ubersdr/docker-compose.yml"
        [[ ! -f "$_default_compose" ]] && _default_compose="${SCRIPT_DIR}/docker-compose.yml"
        read -rp "Path to docker-compose.yml [${_default_compose}]: " _compose_input
        _compose_input="${_compose_input:-${_default_compose}}"
        _compose_input="${_compose_input/#\~/$HOME}"
        COMPOSE_FILE="$_compose_input"
    fi
    _do_remove "$COMPOSE_FILE" "$INTERACTIVE"
    exit 0
fi

# ── 1. Collect physical cores and their logical CPU siblings ──────────────────
# /sys/devices/system/cpu/cpuN/topology/thread_siblings_list contains the
# canonical comma/range list of ALL logical CPUs sharing the same physical core.
# We group by this list to identify each unique physical core.

declare -A seen_cores       # key: canonical siblings string → 1 (dedup)
declare -a core_list        # ordered list of canonical sibling strings, e.g. "0,4"

for cpu_dir in /sys/devices/system/cpu/cpu[0-9]*/; do
    siblings_file="${cpu_dir}topology/thread_siblings_list"
    [[ -f "$siblings_file" ]] || continue

    siblings=$(cat "$siblings_file")

    # Expand any ranges (e.g. "0-3") into individual numbers
    expanded=()
    IFS=',' read -ra parts <<< "$siblings"
    for part in "${parts[@]}"; do
        if [[ "$part" =~ ^([0-9]+)-([0-9]+)$ ]]; then
            for (( n=${BASH_REMATCH[1]}; n<=${BASH_REMATCH[2]}; n++ )); do
                expanded+=("$n")
            done
        else
            expanded+=("$part")
        fi
    done

    # Sort the logical CPU numbers and build a canonical key
    IFS=$'\n' sorted=($(printf '%s\n' "${expanded[@]}" | sort -n)); unset IFS
    key=$(IFS=','; echo "${sorted[*]}")

    if [[ -v seen_cores["$key"] ]]; then
        continue
    fi
    seen_cores["$key"]=1
    core_list+=("$key")
done

TOTAL_PHYSICAL=${#core_list[@]}

if (( TOTAL_PHYSICAL == 0 )); then
    echo "ERROR: No CPU topology information found." >&2
    exit 1
fi

if (( NUM_CORES > TOTAL_PHYSICAL )); then
    echo "ERROR: --cores ${NUM_CORES} requested but only ${TOTAL_PHYSICAL} physical core(s) detected." >&2
    exit 1
fi

# Enforce the half-core cap for non-interactive --cores usage.
# (Interactive mode enforces this cap inside the prompt loop below.)
if $NUM_CORES_SET && ! $INTERACTIVE; then
    _total_logical_early=$(nproc --all 2>/dev/null || echo "$TOTAL_PHYSICAL")
    _half_logical_early=$(( _total_logical_early / 2 ))
    (( _half_logical_early < 1 )) && _half_logical_early=1
    _first_core_key_early="${core_list[0]}"
    _lcpus_per_core_early=1
    IFS=',' read -ra _fc_early <<< "$_first_core_key_early"
    _lcpus_per_core_early="${#_fc_early[@]}"
    (( _lcpus_per_core_early < 1 )) && _lcpus_per_core_early=1
    _max_cores_early=$(( _half_logical_early / _lcpus_per_core_early ))
    (( _max_cores_early < 1 )) && _max_cores_early=1
    if (( NUM_CORES > _max_cores_early )); then
        echo "ERROR: --cores ${NUM_CORES} exceeds the maximum of ${_max_cores_early} physical core(s)" >&2
        echo "       (half of ${_total_logical_early} logical CPUs on this system)." >&2
        exit 1
    fi
fi

# ── 2. Map each physical core to its L3 cache domain ─────────────────────────
# Read /sys/devices/system/cpu/cpuN/cache/index*/shared_cpu_list for the L3
# (level=3, type=Unified).  Cores sharing the same shared_cpu_list belong to
# the same L3 domain.  We use the first logical CPU of each physical core as
# the representative for the sysfs lookup.

declare -A core_l3_domain   # key: core_key → L3 shared_cpu_list string

for core_key in "${core_list[@]}"; do
    # Use the first logical CPU in the core group
    first_cpu="${core_key%%,*}"
    cache_base="/sys/devices/system/cpu/cpu${first_cpu}/cache"
    l3_domain=""
    if [[ -d "$cache_base" ]]; then
        for idx_dir in "${cache_base}"/index*/; do
            [[ -d "$idx_dir" ]] || continue
            lvl=$(cat "${idx_dir}level" 2>/dev/null || echo "")
            typ=$(cat "${idx_dir}type"  2>/dev/null || echo "")
            if [[ "$lvl" == "3" && "$typ" == "Unified" ]]; then
                l3_domain=$(cat "${idx_dir}shared_cpu_list" 2>/dev/null || echo "")
                break
            fi
        done
    fi
    # Fall back to NUMA node as proxy when L3 sysfs is unavailable
    if [[ -z "$l3_domain" ]]; then
        for node_dir in /sys/devices/system/cpu/cpu${first_cpu}/node[0-9]*/; do
            [[ -d "$node_dir" ]] && l3_domain="numa:$(basename "$node_dir")" && break
        done
    fi
    [[ -z "$l3_domain" ]] && l3_domain="unknown"
    core_l3_domain["$core_key"]="$l3_domain"
done

# ── 2b. ARM cluster metadata ──────────────────────────────────────────────────
# On ARM big.LITTLE, identify the microarchitecture type of each physical core
# by reading CPU implementer + CPU part from /proc/cpuinfo.
# Populates:
#   core_cluster_name[core_key] → e.g. "Cortex-A55"
#   core_cluster_role[core_key] → "LITTLE" | "big" | "prime" | ""
# Also builds:
#   arm_roles_present            → space-separated unique roles found
#   arm_cluster_cores[role]      → space-separated core_keys for each role

declare -A core_cluster_name core_cluster_role arm_cluster_cores
arm_roles_present=""
ARM_IS_HETEROGENEOUS=false

if $IS_ARM; then
    # Parse /proc/cpuinfo once into per-processor arrays
    declare -A _proc_impl _proc_part
    _cur_proc=""
    while IFS= read -r _line; do
        if [[ "$_line" =~ ^processor[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
            _cur_proc="${BASH_REMATCH[1]}"
        elif [[ "$_line" =~ ^CPU\ implementer[[:space:]]*:[[:space:]]*(0x[0-9a-fA-F]+) && -n "$_cur_proc" ]]; then
            _proc_impl["$_cur_proc"]="${BASH_REMATCH[1]}"
        elif [[ "$_line" =~ ^CPU\ part[[:space:]]*:[[:space:]]*(0x[0-9a-fA-F]+) && -n "$_cur_proc" ]]; then
            _proc_part["$_cur_proc"]="${BASH_REMATCH[1]}"
        fi
    done < /proc/cpuinfo

    declare -A _seen_roles
    for core_key in "${core_list[@]}"; do
        first_cpu="${core_key%%,*}"
        _impl="${_proc_impl[$first_cpu]:-}"
        _part="${_proc_part[$first_cpu]:-}"
        _cname=$(arm_cpu_part_name "$_impl" "$_part")
        _crole=$(arm_cluster_role "$_cname")
        core_cluster_name["$core_key"]="$_cname"
        core_cluster_role["$core_key"]="$_crole"
        arm_cluster_cores["${_crole:-unknown}"]+="${core_key} "
        if [[ -n "$_crole" && -z "${_seen_roles[$_crole]:-}" ]]; then
            _seen_roles["$_crole"]=1
            arm_roles_present+="${_crole} "
        fi
    done

    # Detect heterogeneous topology: more than one distinct role
    _role_count=0
    for _r in "${!_seen_roles[@]}"; do (( _role_count++ )) || true; done
    (( _role_count > 1 )) && ARM_IS_HETEROGENEOUS=true || true
fi

# ── Compute default core count and run interactive prompt ─────────────────────
# Default is always 1 physical core.  On a Hyper-Threaded system that means
# 1 physical core + its HT sibling (both logical CPUs), which is the minimum
# useful unit for radiod.  The interactive prompt still allows the user to
# choose more cores if needed.
# We tally L3 domain sizes here so the interactive prompt can show the
# "stay within one L3 domain" recommendation.

# Find the largest L3 domain (by physical core count)
declare -A _pre_domain_count
for core_key in "${core_list[@]}"; do
    dom="${core_l3_domain[$core_key]}"
    _pre_domain_count["$dom"]=$(( ${_pre_domain_count[$dom]:-0} + 1 ))
done
_largest_l3=0
for dom in "${!_pre_domain_count[@]}"; do
    cnt="${_pre_domain_count[$dom]}"
    (( cnt > _largest_l3 )) && _largest_l3=$cnt
done

if ! $NUM_CORES_SET; then
    # Default to 1 physical core.
    # On a Hyper-Threaded system this means 1 physical core + its HT sibling
    # (both logical CPUs of that core), which is the minimum useful unit.
    NUM_CORES=1
fi

if $INTERACTIVE; then
    # Detect whether Hyper-Threading is present: any core_key with a comma means
    # that physical core has more than one logical CPU (i.e. HT siblings).
    _ht_present=false
    _ht_example=""
    for _ck in "${core_list[@]}"; do
        if [[ "$_ck" == *","* ]]; then
            _ht_present=true
            _ht_example="$_ck"   # e.g. "0,4"
            break
        fi
    done

    echo "Detected ${TOTAL_PHYSICAL} physical core(s) across ${#_pre_domain_count[@]} L3 cache domain(s)."
    echo ""

    # ── ARM big.LITTLE: show cluster topology and ask which type to use ───────
    if $IS_ARM && $ARM_IS_HETEROGENEOUS && ! $CLUSTER_PREF_SET; then
        echo "  This is an ARM big.LITTLE / DynamIQ system with heterogeneous core types:"
        echo ""
        for _role in LITTLE big prime; do
            _ck_list="${arm_cluster_cores[$_role]:-}"
            [[ -z "$_ck_list" ]] && continue
            _role_cpus=()
            for _rck in $_ck_list; do
                IFS=',' read -ra _rck_cpus <<< "$_rck"
                _role_cpus+=("${_rck_cpus[@]}")
            done
            IFS=$'\n' _role_cpus_sorted=($(printf '%s\n' "${_role_cpus[@]}" | sort -n)); unset IFS
            _role_cpu_str=$(IFS=','; echo "${_role_cpus_sorted[*]}")
            _first_rck=$(echo "$_ck_list" | awk '{print $1}')
            _rname="${core_cluster_name[$_first_rck]:-unknown}"
            _rcore_count=$(echo "$_ck_list" | wc -w)
            printf "    %-8s  %-20s  %d core(s)  CPUs=[%s]\n" \
                "$_role" "$_rname" "$_rcore_count" "$_role_cpu_str"
        done
        echo ""
        echo "  For real-time SDR (radiod), the 'big' or 'prime' cores are strongly recommended."
        echo "  They have higher IPC, larger caches, and higher clock speeds than LITTLE cores."
        echo ""

        _avail_roles=()
        for _role in LITTLE big prime; do
            [[ -n "${arm_cluster_cores[$_role]:-}" ]] && _avail_roles+=("${_role,,}")
        done
        _roles_str=$(IFS='/'; echo "${_avail_roles[*]}")

        _default_cluster="big"
        [[ -z "${arm_cluster_cores[big]:-}" && -n "${arm_cluster_cores[prime]:-}" ]] && _default_cluster="prime"
        [[ -z "${arm_cluster_cores[big]:-}" && -z "${arm_cluster_cores[prime]:-}" ]] && _default_cluster="little"

        while true; do
            read -rp "Which cluster type do you want to assign to radiod? [${_roles_str}] (default: ${_default_cluster}): " _cluster_input
            _cluster_input="${_cluster_input:-${_default_cluster}}"
            case "${_cluster_input,,}" in
                little|big|prime|auto)
                    CLUSTER_PREF="${_cluster_input,,}"
                    CLUSTER_PREF_SET=true
                    break ;;
                *)
                    echo "  Please enter one of: ${_roles_str}" ;;
            esac
        done
        echo ""
    fi

    # Explain what "1 core" means on this specific system
    if $_ht_present; then
        echo "  Note: this system has Hyper-Threading enabled."
        echo "  Each physical core has 2 logical CPUs (e.g. core [${_ht_example}] = 2 logical CPUs)."
        echo "  Choosing 1 core will assign both logical CPUs of that core to radiod."
    else
        echo "  Note: Hyper-Threading is not detected — each physical core = 1 logical CPU."
    fi
    echo ""

    # Ask about expected concurrent users to inform the recommendation
    _expected_users=1
    while true; do
        read -rp "How many concurrent users do you expect at peak? (default: 1): " _users_input
        _users_input="${_users_input:-1}"
        if [[ "$_users_input" =~ ^[1-9][0-9]*$ ]]; then
            _expected_users="$_users_input"
            break
        else
            echo "  Please enter a positive number."
        fi
    done
    echo ""

    # ── Recommend physical cores based on expected concurrent users ───────────
    # Tiers:
    #   1 – 50  users  → 2 cores
    #   51 – 100 users → 4 cores
    #   each additional 100 users over 100 → +2 cores (101-200=6, 201-300=8, …)
    # Hard cap: no more than half the total logical CPUs on this machine.
    _total_logical=$(nproc --all 2>/dev/null || echo "$TOTAL_PHYSICAL")
    _half_logical=$(( _total_logical / 2 ))
    (( _half_logical < 1 )) && _half_logical=1

    if (( _expected_users <= 50 )); then
        _recommended_cores=2
    elif (( _expected_users <= 100 )); then
        _recommended_cores=4
    else
        # 4 base cores for the first 100, then +2 per additional 100 users
        _extra_hundreds=$(( (_expected_users - 100 + 99) / 100 ))
        _recommended_cores=$(( 4 + _extra_hundreds * 2 ))
    fi

    # Cap at half the total logical CPUs (convert to physical cores)
    # Each logical CPU maps to one physical core slot for the cpuset purpose;
    # we cap the physical-core count so the logical CPU count stays ≤ half.
    # Determine logical CPUs per physical core from the first core entry.
    _first_core_key="${core_list[0]}"
    _lcpus_per_core=1
    IFS=',' read -ra _fc_cpus <<< "$_first_core_key"
    _lcpus_per_core="${#_fc_cpus[@]}"
    (( _lcpus_per_core < 1 )) && _lcpus_per_core=1

    # Max physical cores such that (cores × logical_per_core) ≤ half_logical
    _max_cores_by_half=$(( _half_logical / _lcpus_per_core ))
    (( _max_cores_by_half < 1 )) && _max_cores_by_half=1

    # On ARM big.LITTLE, also cap by the number of cores in the chosen cluster
    if $IS_ARM && $ARM_IS_HETEROGENEOUS && [[ "$CLUSTER_PREF" != "auto" ]]; then
        case "$CLUSTER_PREF" in
            little) _cluster_role_key="LITTLE" ;;
            big)    _cluster_role_key="big" ;;
            prime)  _cluster_role_key="prime" ;;
            *)      _cluster_role_key="" ;;
        esac
        if [[ -n "$_cluster_role_key" ]]; then
            _cluster_core_list="${arm_cluster_cores[$_cluster_role_key]:-}"
            _cluster_core_count=$(echo "$_cluster_core_list" | wc -w)
            if (( _cluster_core_count > 0 && _recommended_cores > _cluster_core_count )); then
                _recommended_cores=$_cluster_core_count
            fi
            if (( _cluster_core_count > 0 && _max_cores_by_half > _cluster_core_count )); then
                _max_cores_by_half=$_cluster_core_count
            fi
        fi
    fi

    _capped=false
    if (( _recommended_cores > _max_cores_by_half )); then
        _recommended_cores=$_max_cores_by_half
        _capped=true
    fi

    # On ARM, enforce a minimum of 2 physical cores regardless of user count.
    # ARM cores have lower single-thread IPC than x86 cores, so radiod needs
    # at least 2 cores to keep up with the DSP workload on ARM hardware.
    # The tier calculation already gives 2 for ≤50 users, but we set the flag
    # unconditionally on ARM so the user always sees the explanation.
    _arm_min_applied=false
    if $IS_ARM && (( _max_cores_by_half >= 2 )); then
        if (( _recommended_cores < 2 )); then
            _recommended_cores=2
        fi
        _arm_min_applied=true
    fi

    # Build a human-readable explanation of the recommendation
    if (( _expected_users <= 50 )); then
        echo "  With ${_expected_users} concurrent user(s) (≤ 50), we recommend ${_recommended_cores} physical core(s)."
    elif (( _expected_users <= 100 )); then
        echo "  With ${_expected_users} concurrent users (51–100), we recommend ${_recommended_cores} physical core(s)."
    else
        echo "  With ${_expected_users} concurrent users (>100), we recommend ${_recommended_cores} physical core(s)"
        echo "  (4 cores for the first 100 users, +2 cores per additional 100 users)."
    fi
    if $_ht_present; then
        _logical_for_rec=$(( _recommended_cores * _lcpus_per_core ))
        echo "  (${_recommended_cores} physical core(s) = ${_logical_for_rec} logical CPU(s) on this HT system)"
    fi
    if $_arm_min_applied; then
        echo ""
        echo -e "\033[0;36m  ℹ  ARM note: minimum 2 physical core(s) recommended — ARM cores have lower\033[0m"
        echo -e "\033[0;36m     single-thread IPC than x86, so radiod needs at least 2 cores to keep up\033[0m"
        echo -e "\033[0;36m     with its DSP workload on ARM hardware.\033[0m"
    fi
    if $_capped; then
        echo ""
        echo -e "\033[1;33m  ⚠  Recommendation capped at ${_recommended_cores} physical core(s) — the maximum allowed\033[0m"
        echo -e "\033[1;33m     (≤ half of ${_total_logical} logical CPUs on this system).\033[0m"
    fi

    # Warn if the recommendation crosses L3 domain boundaries, but let the user decide.
    # Do NOT silently cap — the user may be happy to span domains for the extra capacity.
    echo ""
    if (( _recommended_cores > _largest_l3 )); then
        echo -e "\033[1;33m  ⚠  The recommended ${_recommended_cores} core(s) span multiple L3 cache domains.\033[0m"
        echo -e "\033[1;33m     (largest single L3 domain has ${_largest_l3} core(s))\033[0m"
        echo -e "\033[1;33m     Cross-domain buffer handoffs add memory latency — acceptable for high user counts,\033[0m"
        echo -e "\033[1;33m     but you can reduce the core count to ${_largest_l3} to stay within one L3 domain.\033[0m"
    else
        echo "  You can assign up to ${_largest_l3} core(s) and stay within one L3 cache domain."
    fi
    echo "  Using more than ${_largest_l3} core(s) will span multiple L3 domains, adding memory latency."
    # Update default if not already set by --cores
    NUM_CORES=$_recommended_cores
    echo ""
    echo -e "\033[1;33m╔══════════════════════════════════════════════════════════════════════╗\033[0m"
    echo -e "\033[1;33m║  ⚠  WHAT DOCKER CPUSET DOES                                          ║\033[0m"
    echo -e "\033[1;33m╠══════════════════════════════════════════════════════════════════════╣\033[0m"
    echo -e "\033[1;33m║  Assigning cores via cpuset restricts radiod to those cores:         ║\033[0m"
    echo -e "\033[1;33m║                                                                      ║\033[0m"
    echo -e "\033[1;33m║  ✓  radiod is kept on the chosen cores — ensuring it always runs     ║\033[0m"
    echo -e "\033[1;33m║     within the same L3 cache domain for best memory locality.        ║\033[0m"
    echo -e "\033[1;33m║  ✓  The scheduler freely load-balances radiod's threads across all   ║\033[0m"
    echo -e "\033[1;33m║     pinned cores — all cores will be used.                           ║\033[0m"
    echo -e "\033[1;33m║                                                                      ║\033[0m"
    echo -e "\033[1;33m║  ✗  radiod cannot use any other cores, even if they are idle.        ║\033[0m"
    echo -e "\033[1;33m║     Other processes can still run on the pinned cores freely.        ║\033[0m"
    echo -e "\033[1;33m║                                                                      ║\033[0m"
    echo -e "\033[1;33m║  Choose enough cores that radiod is never starved of CPU time.       ║\033[0m"
    echo -e "\033[1;33m╚══════════════════════════════════════════════════════════════════════╝\033[0m"
    echo ""
    while true; do
        read -rp "How many physical cores do you want to assign to radiod? [1-${_max_cores_by_half}] (default: ${NUM_CORES}): " _input
        _input="${_input:-${NUM_CORES}}"
        if [[ "$_input" =~ ^[1-9][0-9]*$ ]] && (( _input >= 1 && _input <= _max_cores_by_half )); then
            NUM_CORES="$_input"
            NUM_CORES_SET=true
            break
        else
            echo "  Please enter a number between 1 and ${_max_cores_by_half} (half of ${_total_logical} logical CPUs)."
        fi
    done
    echo ""
fi

# ── 3. Select N physical cores ────────────────────────────────────────────────
#
# Strategy (topology-only — current idle% is not used):
#   On ARM big.LITTLE with --cluster (or auto-detected preference):
#     1. Filter core_list to only cores matching the requested cluster role.
#     2. If not enough cores in that cluster, spill into other clusters
#        (big → prime → LITTLE order for auto; reverse for little preference).
#   On x86 / homogeneous ARM:
#     1. Count how many cores each L3 domain contains.
#     2. Pick the domain with the most cores (ties broken by lowest first-CPU).
#     3. Fill from that domain, spilling into others only if needed.
#   In all cases, within a cluster/domain, cores are selected lowest-CPU first.

# Resolve effective cluster preference for ARM
# "auto" on a heterogeneous ARM system → prefer big, then prime, then LITTLE
_effective_cluster_role=""
if $IS_ARM && $ARM_IS_HETEROGENEOUS; then
    case "$CLUSTER_PREF" in
        little) _effective_cluster_role="LITTLE" ;;
        big)    _effective_cluster_role="big" ;;
        prime)  _effective_cluster_role="prime" ;;
        auto)
            # Prefer big, then prime, then LITTLE
            if [[ -n "${arm_cluster_cores[big]:-}" ]]; then
                _effective_cluster_role="big"
            elif [[ -n "${arm_cluster_cores[prime]:-}" ]]; then
                _effective_cluster_role="prime"
            else
                _effective_cluster_role="LITTLE"
            fi
            ;;
    esac
fi

# Sort core_list by lowest first-CPU number (stable, deterministic order)
declare -a sorted_cores
for core_key in "${core_list[@]}"; do
    first_cpu="${core_key%%,*}"
    sorted_cores+=("${first_cpu} ${core_key}")
done
IFS=$'\n' sorted_cores=($(printf '%s\n' "${sorted_cores[@]}" | sort -n)); unset IFS

# Build candidate lists: preferred cluster first, then others
declare -a _preferred_cores _other_cores

if [[ -n "$_effective_cluster_role" ]]; then
    # ARM big.LITTLE: split by cluster role
    # "other" order: for big preference → prime then LITTLE; for LITTLE → big then prime
    for entry in "${sorted_cores[@]}"; do
        core_key="${entry#* }"
        _crole="${core_cluster_role[$core_key]:-}"
        if [[ "$_crole" == "$_effective_cluster_role" ]]; then
            _preferred_cores+=("$core_key")
        else
            _other_cores+=("$core_key")
        fi
    done
else
    # x86 / homogeneous ARM: split by L3 domain
    declare -A _domain_count _domain_first_cpu
    for core_key in "${core_list[@]}"; do
        dom="${core_l3_domain[$core_key]}"
        _domain_count["$dom"]=$(( ${_domain_count[$dom]:-0} + 1 ))
        first_cpu="${core_key%%,*}"
        if [[ -z "${_domain_first_cpu[$dom]:-}" ]] || (( first_cpu < _domain_first_cpu[$dom] )); then
            _domain_first_cpu["$dom"]="$first_cpu"
        fi
    done

    preferred_domain=""
    best_cnt=0
    best_first_cpu=999999
    for dom in "${!_domain_count[@]}"; do
        cnt="${_domain_count[$dom]}"
        fc="${_domain_first_cpu[$dom]}"
        if (( cnt > best_cnt )) || { (( cnt == best_cnt )) && (( fc < best_first_cpu )); }; then
            preferred_domain="$dom"
            best_cnt="$cnt"
            best_first_cpu="$fc"
        fi
    done

    for entry in "${sorted_cores[@]}"; do
        core_key="${entry#* }"
        dom="${core_l3_domain[$core_key]}"
        if [[ "$dom" == "$preferred_domain" ]]; then
            _preferred_cores+=("$core_key")
        else
            _other_cores+=("$core_key")
        fi
    done
fi

# Build the final cpuset: preferred first, then others
selected_cores=()
selected_cpus=()

for core_key in "${_preferred_cores[@]}"; do
    (( ${#selected_cores[@]} >= NUM_CORES )) && break
    selected_cores+=("$core_key")
    IFS=',' read -ra cpus <<< "$core_key"
    selected_cpus+=("${cpus[@]}")
done

for core_key in "${_other_cores[@]}"; do
    (( ${#selected_cores[@]} >= NUM_CORES )) && break
    selected_cores+=("$core_key")
    IFS=',' read -ra cpus <<< "$core_key"
    selected_cpus+=("${cpus[@]}")
done

# Sort all selected logical CPUs numerically and join with commas
IFS=$'\n' sorted_cpus=($(printf '%s\n' "${selected_cpus[@]}" | sort -n)); unset IFS
best_cpuset=$(IFS=','; echo "${sorted_cpus[*]}")

# ── Compute the complement cpuset for ubersdr ────────────────────────────────
# ubersdr gets all logical CPUs that are NOT assigned to radiod.
# This keeps the two containers on separate cores so radiod's real-time
# workload is never preempted by the web-interface process.

declare -A _radiod_cpu_set
for _cpu in "${sorted_cpus[@]}"; do
    _radiod_cpu_set["$_cpu"]=1
done

_ubersdr_cpus=()
for entry in "${sorted_cores[@]}"; do
    core_key="${entry#* }"
    IFS=',' read -ra _core_cpus <<< "$core_key"
    for _cpu in "${_core_cpus[@]}"; do
        if [[ -z "${_radiod_cpu_set[$_cpu]:-}" ]]; then
            _ubersdr_cpus+=("$_cpu")
        fi
    done
done

IFS=$'\n' _ubersdr_cpus_sorted=($(printf '%s\n' "${_ubersdr_cpus[@]}" | sort -n)); unset IFS
ubersdr_cpuset=$(IFS=','; echo "${_ubersdr_cpus_sorted[*]:-}")

# ── 4. Output ─────────────────────────────────────────────────────────────────

# Count how many distinct L3 domains the selection spans
declare -A _sel_domains
for core_key in "${selected_cores[@]}"; do
    _sel_domains["${core_l3_domain[$core_key]}"]=1
done
_sel_domain_count="${#_sel_domains[@]}"

if $QUIET; then
    echo "$best_cpuset"
else
    echo ""
    if (( NUM_CORES == 1 )); then
        core_desc="1 physical core"
    else
        core_desc="${NUM_CORES} physical cores"
    fi

    # Build a cluster label for the suggestion line (ARM only)
    _sel_cluster_label=""
    if $IS_ARM && $ARM_IS_HETEROGENEOUS && [[ -n "$_effective_cluster_role" ]]; then
        # Get the name of the first selected core's cluster
        _first_sel="${selected_cores[0]:-}"
        if [[ -n "$_first_sel" ]]; then
            _sel_cname="${core_cluster_name[$_first_sel]:-}"
            _sel_cluster_label=" [${_effective_cluster_role} cluster: ${_sel_cname}]"
        fi
    fi

    echo "  Suggested cpuset for radiod (${core_desc})${_sel_cluster_label}: ${best_cpuset}"
    echo ""

    # Show which physical cores were selected and their logical CPUs + L3 domain + cluster
    for core_key in "${selected_cores[@]}"; do
        dom="${core_l3_domain[$core_key]}"
        _cname="${core_cluster_name[$core_key]:-}"
        _crole="${core_cluster_role[$core_key]:-}"
        _cluster_str=""
        [[ -n "$_cname" ]] && _cluster_str="  cluster=${_crole}(${_cname})"
        echo "  Physical core [${core_key}]  L3=[${dom}]${_cluster_str}  ← selected"
    done
    echo ""

    # Warn if the selection crosses L3 domains
    if (( _sel_domain_count > 1 )); then
        echo "  ⚠  Selection spans ${_sel_domain_count} L3 cache domains — not enough cores in one domain."
        echo "     Cross-domain buffer handoffs add latency. Consider reducing --cores or accepting the trade-off."
    else
        echo "  ✓  All selected cores share one L3 cache domain — optimal for buffer locality."
    fi
    echo ""

    echo "  Add to docker-compose.yml under the ka9q-radio service:"
    echo ""
    echo "    ka9q-radio:"
    echo "      cpuset: \"${best_cpuset}\""
    echo ""
    if [[ -n "$ubersdr_cpuset" ]]; then
        echo "  ubersdr (web interface) will be pinned to the remaining cores:"
        echo ""
        echo "    ubersdr:"
        echo "      cpuset: \"${ubersdr_cpuset}\""
        echo ""
    else
        echo "  ⚠  No remaining cores for ubersdr — all cores assigned to radiod."
        echo "     Consider reducing --cores so ubersdr has at least one core."
        echo ""
    fi
    echo "  All detected physical cores on this system:"
    for entry in "${sorted_cores[@]}"; do
        core_key="${entry#* }"
        selected_marker=""
        for sel in "${selected_cores[@]}"; do
            [[ "$sel" == "$core_key" ]] && selected_marker=" ← selected" && break
        done
        IFS=',' read -ra cpus <<< "$core_key"
        cpu_display=$(IFS='+'; echo "CPU ${cpus[*]}" | sed 's/+/ + CPU /g')
        dom="${core_l3_domain[$core_key]}"
        _cname="${core_cluster_name[$core_key]:-}"
        _crole="${core_cluster_role[$core_key]:-}"
        _cluster_col=""
        [[ -n "$_cname" ]] && _cluster_col="  ${_crole}(${_cname})"
        printf "    %-30s  L3=[%-12s]%s%s\n" "$cpu_display" "$dom" "$_cluster_col" "$selected_marker"
    done
    echo ""
fi

# ── 5. Interactive: ask whether to apply ─────────────────────────────────────

if $INTERACTIVE; then
    echo ""
    read -rp "Do you want to apply this cpuset to your docker-compose.yml? [y/N]: " _apply_ans
    if [[ "${_apply_ans,,}" =~ ^y ]]; then
        APPLY=true

        # Suggest the default compose file location
        _default_compose="$HOME/ubersdr/docker-compose.yml"
        if [[ ! -f "$_default_compose" ]]; then
            _default_compose="${SCRIPT_DIR}/docker-compose.yml"
        fi

        read -rp "Path to docker-compose.yml [${_default_compose}]: " _compose_input
        _compose_input="${_compose_input:-${_default_compose}}"
        # Expand ~ manually since read doesn't expand it
        _compose_input="${_compose_input/#\~/$HOME}"
        COMPOSE_FILE="$_compose_input"
    else
        echo "Skipping apply."
        SKIP_GRUB=true
    fi
    echo ""
fi

# ── 6. Apply to docker-compose file ──────────────────────────────────────────

if $APPLY; then
    if [[ ! -f "$COMPOSE_FILE" ]]; then
        echo "ERROR: docker-compose file not found: ${COMPOSE_FILE}" >&2
        exit 1
    fi

    if ! grep -q 'ka9q-radio:' "$COMPOSE_FILE"; then
        echo "ERROR: No 'ka9q-radio:' service found in ${COMPOSE_FILE}" >&2
        exit 1
    fi

    BACKUP="${COMPOSE_FILE}.bak"
    cp "$COMPOSE_FILE" "$BACKUP"

    # Single awk pass: handles both insert and replace correctly for both
    # ka9q-radio (radiod cpuset) and ubersdr (complement cpuset).
    # Service blocks in docker-compose use 2-space indent for service name,
    # 4-space for properties. We track which service block we are in and
    # exit the block when we see the next 2-space non-blank, non-comment line.
    awk -v radiod_cpuset="$best_cpuset" -v ubersdr_cpuset="$ubersdr_cpuset" '
        /^  ka9q-radio:[[:space:]]*(#.*)?$/ {
            in_radiod = 1; in_ubersdr = 0
            radiod_inserted = 0
            print; next
        }

        /^  ubersdr:[[:space:]]*(#.*)?$/ {
            in_ubersdr = 1; in_radiod = 0
            ubersdr_inserted = 0
            print; next
        }

        # Leaving a service block
        in_radiod && /^  [^[:space:]#]/ { in_radiod = 0 }
        in_ubersdr && /^  [^[:space:]#]/ { in_ubersdr = 0 }

        # Replace existing cpuset in ka9q-radio block
        in_radiod && /^[[:space:]]+cpuset:/ {
            match($0, /^[[:space:]]+/)
            indent = substr($0, 1, RLENGTH)
            print indent "cpuset: \"" radiod_cpuset "\""
            radiod_inserted = 1
            radiod_action = "updated"
            next
        }

        # Insert cpuset into ka9q-radio block before first property
        in_radiod && !radiod_inserted && /^    [^[:space:]#]/ {
            print "    cpuset: \"" radiod_cpuset "\""
            radiod_inserted = 1
            radiod_action = "added"
        }

        # Replace existing cpuset in ubersdr block (only if we have a cpuset to set)
        in_ubersdr && ubersdr_cpuset != "" && /^[[:space:]]+cpuset:/ {
            match($0, /^[[:space:]]+/)
            indent = substr($0, 1, RLENGTH)
            print indent "cpuset: \"" ubersdr_cpuset "\""
            ubersdr_inserted = 1
            ubersdr_action = "updated"
            next
        }

        # Insert cpuset into ubersdr block before first property (only if we have one)
        in_ubersdr && ubersdr_cpuset != "" && !ubersdr_inserted && /^    [^[:space:]#]/ {
            print "    cpuset: \"" ubersdr_cpuset "\""
            ubersdr_inserted = 1
            ubersdr_action = "added"
        }

        { print }

        END {
            if (in_radiod && !radiod_inserted) {
                print "    cpuset: \"" radiod_cpuset "\""
                radiod_action = "added"
            }
            if (in_ubersdr && ubersdr_cpuset != "" && !ubersdr_inserted) {
                print "    cpuset: \"" ubersdr_cpuset "\""
                ubersdr_action = "added"
            }
        }
    ' "$COMPOSE_FILE" > "${COMPOSE_FILE}.tmp" && mv "${COMPOSE_FILE}.tmp" "$COMPOSE_FILE"

    if ! $QUIET; then
        _radiod_verb="${radiod_action:-added}"
        echo "  ✓ ${_radiod_verb^} cpuset: \"${best_cpuset}\" for ka9q-radio in ${COMPOSE_FILE}"
        if [[ -n "$ubersdr_cpuset" ]]; then
            _ubersdr_verb="${ubersdr_action:-added}"
            echo "  ✓ ${_ubersdr_verb^} cpuset: \"${ubersdr_cpuset}\" for ubersdr in ${COMPOSE_FILE}"
        fi
        echo "  Backup saved to: ${BACKUP}"
        echo ""
    fi
fi

# ── 7. nohz_full / rcu_nocbs suggestion ──────────────────────────────────────
# These reduce timer interrupt and RCU callback noise on the SDR cores,
# minimising latency jitter.  Unlike isolcpus they do NOT affect load-balancing,
# so radiod's threads will still spread across all pinned CPUs.

_suggest_nohz() {
    local cpuset="$1"

    local cmdline
    cmdline=$(cat /proc/cmdline 2>/dev/null || echo "")

    local current_nohz=""
    current_nohz=$(echo "$cmdline" | grep -oP 'nohz_full=\S+' | cut -d= -f2 || echo "")
    local current_rcu=""
    current_rcu=$(echo "$cmdline" | grep -oP 'rcu_nocbs=\S+' | cut -d= -f2 || echo "")

    echo ""
    echo "  ── Optional: kernel timer / RCU noise reduction ─────────────────"
    echo ""
    echo "  These kernel parameters reduce interrupt jitter on the SDR cores"
    echo "  without affecting load-balancing (radiod will still use all pinned CPUs):"
    echo ""
    echo "    nohz_full=${cpuset}   ← suppress periodic timer ticks on SDR cores"
    echo "    rcu_nocbs=${cpuset}   ← offload RCU callbacks off SDR cores"
    echo ""

    if [[ -n "$current_nohz" && -n "$current_rcu" ]]; then
        if [[ "$current_nohz" == "$cpuset" && "$current_rcu" == "$cpuset" ]]; then
            echo "  ✓ nohz_full and rcu_nocbs already set correctly — no change needed."
        else
            echo "  ⚠  Current values differ from the cpuset:"
            echo "     nohz_full=${current_nohz}  rcu_nocbs=${current_rcu}"
            echo "     Consider updating them to match: nohz_full=${cpuset} rcu_nocbs=${cpuset}"
        fi
    else
        echo "  These are optional — add to GRUB_CMDLINE_LINUX in /etc/default/grub"
        echo "  then run: sudo update-grub && sudo reboot"
    fi
    echo ""
}

# Show nohz/rcu suggestion unless --quiet was passed.
if ! $QUIET && { ! $INTERACTIVE || ! $SKIP_GRUB; }; then
    _suggest_nohz "$best_cpuset"
fi

# Interactive: offer to apply nohz_full/rcu_nocbs to grub
if $INTERACTIVE && ! $SKIP_GRUB; then
    _current_nohz=$(cat /proc/cmdline 2>/dev/null | grep -oP 'nohz_full=\S+' | cut -d= -f2 || echo "")
    _current_rcu=$(cat /proc/cmdline 2>/dev/null | grep -oP 'rcu_nocbs=\S+' | cut -d= -f2 || echo "")

    if [[ "$_current_nohz" != "$best_cpuset" || "$_current_rcu" != "$best_cpuset" ]]; then
        read -rp "Do you want to add nohz_full/rcu_nocbs=${best_cpuset} to your kernel boot parameters? [y/N]: " _nohz_ans
        if [[ "${_nohz_ans,,}" =~ ^y ]]; then
            _grub_file="/etc/default/grub"

            if [[ ! -f "$_grub_file" ]]; then
                echo "  ERROR: ${_grub_file} not found — cannot apply automatically." >&2

            elif grep -qE 'nohz_full=|rcu_nocbs=' "$_grub_file" 2>/dev/null; then
                echo ""
                _grub_nohz=$(grep -oP 'nohz_full=\S+' "$_grub_file" | cut -d= -f2 | tr -d '"' || echo "")
                _grub_rcu=$(grep -oP 'rcu_nocbs=\S+' "$_grub_file" | cut -d= -f2 | tr -d '"' || echo "")

                if [[ "$_grub_nohz" == "$best_cpuset" && "$_grub_rcu" == "$best_cpuset" ]]; then
                    echo "  ✓ ${_grub_file} already has the correct values:"
                    echo "      nohz_full=${_grub_nohz} rcu_nocbs=${_grub_rcu}"
                    echo ""
                    echo "  Grub just needs to be regenerated and the system rebooted."
                    echo ""
                    _do_grub_update=true
                else
                    echo "  ⚠  Existing nohz_full/rcu_nocbs found in ${_grub_file} with different values."
                    echo "  Current:"
                    grep 'GRUB_CMDLINE_LINUX' "$_grub_file"
                    echo ""
                    echo "  Desired: nohz_full=${best_cpuset} rcu_nocbs=${best_cpuset}"
                    echo ""
                    read -rp "  Update these values automatically? [y/N]: " _update_ans
                    if [[ "${_update_ans,,}" =~ ^y ]]; then
                        _grub_backup="${_grub_file}.bak.$(date +%Y%m%d%H%M%S)"
                        sudo cp "$_grub_file" "$_grub_backup" && echo "  Backup: ${_grub_backup}"
                        sudo sed -i \
                            -e "s/nohz_full=[^ \"]*/nohz_full=${best_cpuset}/g" \
                            -e "s/rcu_nocbs=[^ \"]*/rcu_nocbs=${best_cpuset}/g" \
                            "$_grub_file"
                        echo "  ✓ Values updated in ${_grub_file}"
                        echo ""
                        _do_grub_update=true
                    else
                        echo "  Skipping — edit ${_grub_file} manually."
                        echo ""
                        _do_grub_update=false
                    fi
                fi

            else
                # No existing params — append them fresh
                _grub_backup="${_grub_file}.bak.$(date +%Y%m%d%H%M%S)"
                echo ""
                if ! sudo cp "$_grub_file" "$_grub_backup" 2>/dev/null; then
                    echo "  ERROR: could not back up ${_grub_file} (sudo cp failed)" >&2
                    _do_grub_update=false
                else
                    echo "  Backup saved to: ${_grub_backup}"
                    if sudo sed -i "s/\(GRUB_CMDLINE_LINUX=\"[^\"]*\)\"/\1 nohz_full=${best_cpuset} rcu_nocbs=${best_cpuset}\"/" "$_grub_file"; then
                        echo "  ✓ Updated ${_grub_file}"
                        echo ""
                        _do_grub_update=true
                    else
                        echo "  ERROR: sudo sed failed — check sudo permissions." >&2
                        _do_grub_update=false
                    fi
                fi
            fi

            # ── Shared: run update-grub and offer reboot ──────────────────────
            if [[ "${_do_grub_update:-false}" == "true" ]]; then
                _grub_cmd=""
                for _candidate in \
                    /usr/sbin/update-grub \
                    /sbin/update-grub \
                    /usr/sbin/grub2-mkconfig \
                    /usr/sbin/grub-mkconfig; do
                    [[ -x "$_candidate" ]] && _grub_cmd="$_candidate" && break
                done

                if [[ -n "$_grub_cmd" ]]; then
                    echo "  Running sudo ${_grub_cmd}..."
                    case "$_grub_cmd" in
                        *update-grub)
                            sudo "$_grub_cmd" 2>&1 | tail -3 ;;
                        *grub2-mkconfig)
                            sudo "$_grub_cmd" -o /boot/grub2/grub.cfg 2>&1 | tail -3 ;;
                        *grub-mkconfig)
                            sudo "$_grub_cmd" -o /boot/grub/grub.cfg 2>&1 | tail -3 ;;
                    esac
                    echo ""
                    echo "  ✓ Grub updated."
                else
                    echo "  ⚠  No grub update command found in /usr/sbin or /sbin."
                    echo "  Run manually before rebooting: sudo update-grub"
                fi

                echo ""
                echo "  A reboot is required to activate nohz_full/rcu_nocbs=${best_cpuset}"
                echo ""

                read -rp "  Reboot now? [y/N]: " _reboot_ans
                if [[ "${_reboot_ans,,}" =~ ^y ]]; then
                    _do_reboot=true
                else
                    echo "  Skipping reboot. Run 'sudo reboot' when ready."
                fi
                echo ""
            fi
        else
            echo "  Skipping kernel parameter configuration."
            echo ""
        fi
    fi
fi

# ── 8. Interactive: restart UberSDR to activate the new cpuset ───────────────
# Always runs when APPLY=true so Docker picks up the new cpuset.
# Runs before the deferred reboot (section 9) so the container is already
# using the new cpuset when the system comes back up.

if $INTERACTIVE && $APPLY; then
    _restart_script="$HOME/ubersdr/restart-ubersdr.sh"
    echo ""
    echo -e "\033[1;33m╔══════════════════════════════════════════════════════════════════════╗\033[0m"
    echo -e "\033[1;33m║  ⚠  YOU WILL LOSE CONNECTION BRIEFLY — THIS IS EXPECTED              ║\033[0m"
    echo -e "\033[1;33m╠══════════════════════════════════════════════════════════════════════╣\033[0m"
    echo -e "\033[1;33m║  UberSDR is about to restart to apply the new cpuset.                ║\033[0m"
    echo -e "\033[1;33m║  Your browser connection to the SDR will drop for ~30 seconds        ║\033[0m"
    echo -e "\033[1;33m║  while Docker restarts the container.                                ║\033[0m"
    echo -e "\033[1;33m║                                                                      ║\033[0m"
    echo -e "\033[1;33m║  Simply refresh the page once UberSDR is back online.                ║\033[0m"
    echo -e "\033[1;33m╚══════════════════════════════════════════════════════════════════════╝\033[0m"
    echo ""
    echo "  ✓ cpuset applied. Restarting UberSDR to activate the change..."
    echo ""
    if [[ -x "$_restart_script" ]]; then
        "$_restart_script"
        echo ""
        echo "  ✓ UberSDR restarted with cpuset: ${best_cpuset}"
    else
        echo "  ⚠  restart-ubersdr.sh not found at ${_restart_script}"
        echo "     Run manually: cd ~/ubersdr && docker compose down && docker compose up -d"
    fi
    echo ""
fi

# ── 9. Deferred reboot ───────────────────────────────────────────────────────
# Executed last so UberSDR is always restarted (picking up the new cpuset)
# before the system reboots to activate nohz_full/rcu_nocbs.
if [[ "${_do_reboot:-false}" == "true" ]]; then
    echo "  Rebooting in 5 seconds — press Ctrl+C to cancel..."
    sleep 5
    sudo reboot
fi
