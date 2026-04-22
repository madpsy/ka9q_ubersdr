#!/usr/bin/env bash
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
#   3. Select N cores from the largest L3 domain first (lowest CPU number
#      order), spilling into other domains only if more cores are needed.
#      Current idle% is not used — the system will be rebooted after applying
#      isolcpus, making runtime load irrelevant.
#
# Usage:
#   ./suggest-radiod-cpuset.sh [--cores N] [--quiet] [--apply [--compose-file <path>]]
#
# Options:
#   --cores N           Number of physical cores to assign (default: 1)
#   --quiet             Output only the cpuset string, e.g. "0,4"
#   --apply             Write the recommended cpuset into the docker-compose file
#   --compose-file PATH Path to docker-compose file (default: docker-compose.yml
#                       in the same directory as this script)
#
# Examples:
#   ./suggest-radiod-cpuset.sh
#   ./suggest-radiod-cpuset.sh --cores 2
#   ./suggest-radiod-cpuset.sh --cores 2 --apply --compose-file ~/ubersdr/docker-compose.yml
#   ./suggest-radiod-cpuset.sh --quiet --cores 1

set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────────────

QUIET=false
APPLY=false
NUM_CORES=1
NUM_CORES_SET=false   # true when --cores was explicitly passed
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
INTERACTIVE=false

# Detect interactive mode: no arguments passed and stdin is a terminal
if [[ $# -eq 0 ]] && [[ -t 0 ]]; then
    INTERACTIVE=true
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --quiet)    QUIET=true;  shift ;;
        --apply)    APPLY=true;  shift ;;
        --cores)
            [[ -n "${2:-}" ]] || { echo "ERROR: --cores requires a number argument" >&2; exit 1; }
            [[ "$2" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: --cores must be a positive integer" >&2; exit 1; }
            NUM_CORES="$2"; NUM_CORES_SET=true; shift 2 ;;
        --compose-file)
            [[ -n "${2:-}" ]] || { echo "ERROR: --compose-file requires a path argument" >&2; exit 1; }
            COMPOSE_FILE="$2"; shift 2 ;;
        --help|-h)
            sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \?//'
            exit 0 ;;
        *)
            echo "Usage: $0 [--cores N] [--quiet] [--apply [--compose-file <path>]]" >&2
            exit 1 ;;
    esac
done

if $INTERACTIVE; then
    echo ""
    echo "=== radiod CPU Pinning Helper ==="
    echo ""
    echo "This tool analyses your CPU topology and suggests which physical core(s)"
    echo "to dedicate to radiod for best performance."
    echo ""
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

# ── Compute L3-aware smart default and run interactive prompt ─────────────────
# The default is the size of the largest single L3 domain, capped at half the
# total physical cores and at 4.  This ensures the default never crosses an L3
# domain boundary.  We do this here (after the L3 mapping) so we know domain
# sizes; the interactive prompt is also deferred to here for the same reason.

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
    _half=$(( TOTAL_PHYSICAL / 2 ))
    (( _half < 1 )) && _half=1
    (( _half > 4 )) && _half=4
    # Cap at the largest single L3 domain so the default stays within one domain
    _default_cores=$(( _half < _largest_l3 ? _half : _largest_l3 ))
    (( _default_cores < 1 )) && _default_cores=1
    NUM_CORES=$_default_cores
fi

if $INTERACTIVE; then
    echo "Detected ${TOTAL_PHYSICAL} physical core(s) across ${#_pre_domain_count[@]} L3 cache domain(s)."
    echo "Largest single L3 domain: ${_largest_l3} physical core(s)."
    echo ""
    echo "  Recommendation: use at most ${_largest_l3} core(s) to stay within one L3 domain."
    echo "  Using more cores will span multiple L3 domains, adding memory latency."
    echo ""
    while true; do
        read -rp "How many physical cores do you want to assign to radiod? [1-${TOTAL_PHYSICAL}] (default: ${NUM_CORES}): " _input
        _input="${_input:-${NUM_CORES}}"
        if [[ "$_input" =~ ^[1-9][0-9]*$ ]] && (( _input >= 1 && _input <= TOTAL_PHYSICAL )); then
            NUM_CORES="$_input"
            NUM_CORES_SET=true
            break
        else
            echo "  Please enter a number between 1 and ${TOTAL_PHYSICAL}."
        fi
    done
    echo ""
fi

# ── 3. Select N physical cores, preferring a single L3 domain ────────────────
#
# Strategy (topology-only — idle% is not used because the system will be
# rebooted after applying isolcpus, making current load irrelevant):
#   1. Count how many cores each L3 domain contains.
#   2. Pick the domain with the most cores (ties broken by lowest first-CPU
#      number, i.e. the "first" domain in physical order).
#   3. Fill the selection from that domain (lowest CPU number first),
#      then spill into other domains only if more cores are needed.

# Tally cores per L3 domain
declare -A _domain_count _domain_first_cpu
for core_key in "${core_list[@]}"; do
    dom="${core_l3_domain[$core_key]}"
    _domain_count["$dom"]=$(( ${_domain_count[$dom]:-0} + 1 ))
    first_cpu="${core_key%%,*}"
    # Track the lowest first-CPU number seen in this domain (for tiebreaking)
    if [[ -z "${_domain_first_cpu[$dom]:-}" ]] || (( first_cpu < _domain_first_cpu[$dom] )); then
        _domain_first_cpu["$dom"]="$first_cpu"
    fi
done

# Pick the preferred L3 domain: most cores; tiebreak by lowest first-CPU number
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

# Sort core_list by lowest first-CPU number (stable, deterministic order)
declare -a sorted_cores
for core_key in "${core_list[@]}"; do
    first_cpu="${core_key%%,*}"
    sorted_cores+=("${first_cpu} ${core_key}")
done
IFS=$'\n' sorted_cores=($(printf '%s\n' "${sorted_cores[@]}" | sort -n)); unset IFS

# Build the final cpuset: preferred domain first, then others
selected_cores=()
selected_cpus=()
declare -a _deferred_cores   # cores from non-preferred domains

for entry in "${sorted_cores[@]}"; do
    core_key="${entry#* }"
    dom="${core_l3_domain[$core_key]}"
    if [[ "$dom" == "$preferred_domain" ]]; then
        if (( ${#selected_cores[@]} < NUM_CORES )); then
            selected_cores+=("$core_key")
            IFS=',' read -ra cpus <<< "$core_key"
            selected_cpus+=("${cpus[@]}")
        fi
    else
        _deferred_cores+=("$core_key")
    fi
done

# Fill remaining slots from deferred (non-preferred-domain) cores if needed
for core_key in "${_deferred_cores[@]}"; do
    (( ${#selected_cores[@]} >= NUM_CORES )) && break
    selected_cores+=("$core_key")
    IFS=',' read -ra cpus <<< "$core_key"
    selected_cpus+=("${cpus[@]}")
done

# Sort all selected logical CPUs numerically and join with commas
IFS=$'\n' sorted_cpus=($(printf '%s\n' "${selected_cpus[@]}" | sort -n)); unset IFS
best_cpuset=$(IFS=','; echo "${sorted_cpus[*]}")

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
    echo "  Suggested cpuset for radiod (${core_desc}): ${best_cpuset}"
    echo ""

    # Show which physical cores were selected and their logical CPUs + L3 domain
    for core_key in "${selected_cores[@]}"; do
        dom="${core_l3_domain[$core_key]}"
        echo "  Physical core [${core_key}]  L3=[${dom}]  ← selected"
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
        printf "    %-30s  L3=[%s]%s\n" "$cpu_display" "$dom" "$selected_marker"
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

    # Single awk pass: handles both insert and replace correctly.
    # Service blocks in docker-compose use 2-space indent for service name,
    # 4-space for properties. We enter the ka9q-radio block on its header
    # and exit when we see the next 2-space non-blank, non-comment line.
    awk -v new_cpuset="$best_cpuset" '
        /^  ka9q-radio:[[:space:]]*(#.*)?$/ {
            in_service = 1
            replaced = 0
            inserted = 0
            print
            next
        }

        in_service && /^  [^[:space:]#]/ {
            in_service = 0
        }

        in_service && /^[[:space:]]+cpuset:/ {
            match($0, /^[[:space:]]+/)
            indent = substr($0, 1, RLENGTH)
            print indent "cpuset: \"" new_cpuset "\""
            replaced = 1
            inserted = 1
            action = "updated"
            next
        }

        in_service && !inserted && /^    [^[:space:]#]/ {
            print "    cpuset: \"" new_cpuset "\""
            inserted = 1
            action = "added"
        }

        { print }

        END {
            if (in_service && !inserted) {
                print "    cpuset: \"" new_cpuset "\""
                action = "added"
            }
        }
    ' "$COMPOSE_FILE" > "${COMPOSE_FILE}.tmp" && mv "${COMPOSE_FILE}.tmp" "$COMPOSE_FILE"
    ACTION="${action:-added}"

    if ! $QUIET; then
        echo "  ✓ ${ACTION^} cpuset: \"${best_cpuset}\" in ${COMPOSE_FILE}"
        echo "  Backup saved to: ${BACKUP}"
        echo ""
    fi
fi

# ── 7. isolcpus suggestion ────────────────────────────────────────────────────
# cpuset keeps radiod ON the chosen cores; isolcpus keeps everything else OFF.
# Together they give near-exclusive access to those cores.

_suggest_isolcpus() {
    local cpuset="$1"

    # Check current kernel cmdline
    local cmdline
    cmdline=$(cat /proc/cmdline 2>/dev/null || echo "")

    local current_isolcpus=""
    current_isolcpus=$(echo "$cmdline" | grep -oP 'isolcpus=\S+' | cut -d= -f2 || echo "")
    local current_nohz=""
    current_nohz=$(echo "$cmdline" | grep -oP 'nohz_full=\S+' | cut -d= -f2 || echo "")
    local current_rcu=""
    current_rcu=$(echo "$cmdline" | grep -oP 'rcu_nocbs=\S+' | cut -d= -f2 || echo "")

    echo ""
    echo "  ── Kernel CPU Isolation (isolcpus) ──────────────────────────────"
    echo ""
    echo "  cpuset keeps radiod ON cores ${cpuset}."
    echo "  isolcpus keeps all other tasks OFF those cores."
    echo "  Together they give radiod near-exclusive access."
    echo ""

    if [[ -n "$current_isolcpus" ]]; then
        if [[ "$current_isolcpus" == "$cpuset" ]]; then
            echo "  ✓ isolcpus=${current_isolcpus} already matches — no change needed."
            [[ -n "$current_nohz" ]] && echo "  ✓ nohz_full=${current_nohz}" || true
            [[ -n "$current_rcu"  ]] && echo "  ✓ rcu_nocbs=${current_rcu}"  || true
            echo ""
            return
        else
            echo "  ⚠  Current isolcpus=${current_isolcpus} does NOT match cpuset=${cpuset}"
            echo "     Consider updating it to match."
            echo ""
        fi
    else
        echo "  isolcpus is not currently set."
        echo ""
    fi

    echo "  Recommended kernel parameters to add:"
    echo ""
    echo "    isolcpus=${cpuset} nohz_full=${cpuset} rcu_nocbs=${cpuset}"
    echo ""
    echo "  These reduce timer interrupts and RCU callbacks on the SDR cores,"
    echo "  minimising latency jitter for real-time sample processing."
    echo ""
}

if ! $QUIET; then
    _suggest_isolcpus "$best_cpuset"
fi

# Interactive: offer to apply isolcpus to grub
if $INTERACTIVE; then
    # Only offer if isolcpus isn't already correctly set
    _current_iso=$(cat /proc/cmdline 2>/dev/null | grep -oP 'isolcpus=\S+' | cut -d= -f2 || echo "")
    if [[ "$_current_iso" != "$best_cpuset" ]]; then
        read -rp "Do you want to add isolcpus=${best_cpuset} to your kernel boot parameters? [y/N]: " _iso_ans
        if [[ "${_iso_ans,,}" =~ ^y ]]; then
            _grub_file="/etc/default/grub"

            if [[ ! -f "$_grub_file" ]]; then
                echo "  ERROR: ${_grub_file} not found — cannot apply automatically." >&2

            # Check if any of these params already exist in grub (read is fine without sudo)
            elif grep -qE 'isolcpus=|nohz_full=|rcu_nocbs=' "$_grub_file" 2>/dev/null; then
                echo ""
                # Check if the existing values already match what we want
                _grub_iso=$(grep -oP 'isolcpus=\S+' "$_grub_file" | cut -d= -f2 | tr -d '"' || echo "")
                _grub_nohz=$(grep -oP 'nohz_full=\S+' "$_grub_file" | cut -d= -f2 | tr -d '"' || echo "")
                _grub_rcu=$(grep -oP 'rcu_nocbs=\S+' "$_grub_file" | cut -d= -f2 | tr -d '"' || echo "")

                if [[ "$_grub_iso" == "$best_cpuset" && "$_grub_nohz" == "$best_cpuset" && "$_grub_rcu" == "$best_cpuset" ]]; then
                    echo "  ✓ ${_grub_file} already has the correct values:"
                    echo "      isolcpus=${_grub_iso} nohz_full=${_grub_nohz} rcu_nocbs=${_grub_rcu}"
                    echo ""
                    echo "  Grub just needs to be regenerated and the system rebooted."
                    echo ""
                    # Fall through to update-grub + reboot prompt by jumping to shared block
                    _do_grub_update=true
                else
                    echo "  ⚠  Existing isolcpus/nohz_full/rcu_nocbs found in ${_grub_file} with different values."
                    echo "  Current:"
                    grep 'GRUB_CMDLINE_LINUX' "$_grub_file"
                    echo ""
                    echo "  Desired: isolcpus=${best_cpuset} nohz_full=${best_cpuset} rcu_nocbs=${best_cpuset}"
                    echo ""
                    read -rp "  Update these values automatically? [y/N]: " _update_ans
                    if [[ "${_update_ans,,}" =~ ^y ]]; then
                        _grub_backup="${_grub_file}.bak.$(date +%Y%m%d%H%M%S)"
                        sudo cp "$_grub_file" "$_grub_backup" && echo "  Backup: ${_grub_backup}"
                        # Replace existing isolcpus/nohz_full/rcu_nocbs values in-place
                        sudo sed -i \
                            -e "s/isolcpus=[^ \"]*/isolcpus=${best_cpuset}/g" \
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
                # No existing isolcpus params — append them fresh
                _grub_backup="${_grub_file}.bak.$(date +%Y%m%d%H%M%S)"
                echo ""
                if ! sudo cp "$_grub_file" "$_grub_backup" 2>/dev/null; then
                    echo "  ERROR: could not back up ${_grub_file} (sudo cp failed)" >&2
                    _do_grub_update=false
                else
                    echo "  Backup saved to: ${_grub_backup}"
                    if sudo sed -i "s/\(GRUB_CMDLINE_LINUX=\"[^\"]*\)\"/\1 isolcpus=${best_cpuset} nohz_full=${best_cpuset} rcu_nocbs=${best_cpuset}\"/" "$_grub_file"; then
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
                # Find grub regeneration command — use full paths as /usr/sbin
                # may not be in PATH in all sudo environments.
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
                echo "  A reboot is required to activate isolcpus=${best_cpuset}"
                echo ""
                read -rp "  Reboot now? [y/N]: " _reboot_ans
                if [[ "${_reboot_ans,,}" =~ ^y ]]; then
                    echo ""
                    echo "  Rebooting in 5 seconds — press Ctrl+C to cancel..."
                    sleep 5
                    sudo reboot
                else
                    echo "  Skipping reboot. Run 'sudo reboot' when ready."
                fi
                echo ""
            fi
        else
            echo "  Skipping isolcpus configuration."
            echo ""
        fi
    fi
fi

# ── 8. Interactive: remind user to restart UberSDR ───────────────────────────

if $INTERACTIVE && $APPLY; then
    echo "  ✓ cpuset applied. To activate the change, restart UberSDR:"
    echo ""
    echo "    ~/ubersdr/restart-ubersdr.sh"
    echo ""
fi
