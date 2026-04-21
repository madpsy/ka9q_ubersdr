#!/usr/bin/env bash
# suggest-radiod-cpuset.sh
#
# Reads CPU topology from /sys and suggests the best physical core(s)
# to assign to radiod via cpuset in docker-compose.yml.
#
# Selection criteria:
#   1. Find all physical cores and their HT siblings by reading the kernel's
#      thread_siblings_list (the authoritative source of HT pairs)
#   2. Rank physical cores by average idle% (measured via /proc/stat delta)
#   3. Select the N idlest physical cores (default: 1) and build a cpuset
#      from all their logical CPUs (including HT siblings)
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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --quiet)    QUIET=true;  shift ;;
        --apply)    APPLY=true;  shift ;;
        --cores)
            [[ -n "${2:-}" ]] || { echo "ERROR: --cores requires a number argument" >&2; exit 1; }
            [[ "$2" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: --cores must be a positive integer" >&2; exit 1; }
            NUM_CORES="$2"; shift 2 ;;
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

# ── 2. Sample CPU idle time from /proc/stat ───────────────────────────────────

declare -A idle1 idle2 total1 total2

sample_stat() {
    local -n _idle=$1
    local -n _total=$2
    while read -r line; do
        [[ "$line" =~ ^cpu([0-9]+)[[:space:]]+(.*) ]] || continue
        cpu_n="${BASH_REMATCH[1]}"
        fields=(${BASH_REMATCH[2]})
        idle_val="${fields[3]}"
        total_val=0
        for f in "${fields[@]}"; do
            (( total_val += f )) || true
        done
        _idle["$cpu_n"]="$idle_val"
        _total["$cpu_n"]="$total_val"
    done < /proc/stat
}

sample_stat idle1 total1
sleep 0.5
sample_stat idle2 total2

# ── 3. Score each physical core by average idle% across all its logical CPUs ──

declare -A core_idle_pct    # key: canonical siblings string → avg idle%

for core_key in "${core_list[@]}"; do
    IFS=',' read -ra cpus <<< "$core_key"
    total_idle=0
    count=0
    for cpu_n in "${cpus[@]}"; do
        d_idle=$(( idle2["$cpu_n"] - idle1["$cpu_n"] ))
        d_total=$(( total2["$cpu_n"] - total1["$cpu_n"] ))
        if (( d_total > 0 )); then
            pct=$(( d_idle * 100 / d_total ))
        else
            pct=100
        fi
        (( total_idle += pct )) || true
        (( count += 1 ))
    done
    core_idle_pct["$core_key"]=$(( total_idle / count ))
done

# ── 4. Select the N idlest physical cores ─────────────────────────────────────

# Sort core_list by descending idle% and pick the top NUM_CORES
declare -a ranked_cores
for core_key in "${core_list[@]}"; do
    ranked_cores+=("${core_idle_pct[$core_key]} $core_key")
done

# Sort descending by idle%
IFS=$'\n' sorted_cores=($(printf '%s\n' "${ranked_cores[@]}" | sort -rn)); unset IFS

# Build the final cpuset from the top NUM_CORES physical cores
selected_cores=()
selected_cpus=()
for (( i=0; i<NUM_CORES; i++ )); do
    entry="${sorted_cores[$i]}"
    core_key="${entry#* }"   # strip the leading idle% score
    selected_cores+=("$core_key")
    IFS=',' read -ra cpus <<< "$core_key"
    selected_cpus+=("${cpus[@]}")
done

# Sort all selected logical CPUs numerically and join with commas
IFS=$'\n' sorted_cpus=($(printf '%s\n' "${selected_cpus[@]}" | sort -n)); unset IFS
best_cpuset=$(IFS=','; echo "${sorted_cpus[*]}")

# ── 5. Output ─────────────────────────────────────────────────────────────────

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

    # Show which physical cores were selected and their logical CPUs
    for core_key in "${selected_cores[@]}"; do
        idle="${core_idle_pct[$core_key]}"
        echo "  Physical core [${core_key}]  (avg idle: ${idle}%)  ← selected"
    done
    echo ""

    echo "  Add to docker-compose.yml under the ka9q-radio service:"
    echo ""
    echo "    ka9q-radio:"
    echo "      cpuset: \"${best_cpuset}\""
    echo ""

    echo "  All detected physical cores on this system:"
    for entry in "${sorted_cores[@]}"; do
        idle="${entry%% *}"
        core_key="${entry#* }"
        selected_marker=""
        for sel in "${selected_cores[@]}"; do
            [[ "$sel" == "$core_key" ]] && selected_marker=" ← selected" && break
        done
        IFS=',' read -ra cpus <<< "$core_key"
        cpu_display=$(IFS='+'; echo "CPU ${cpus[*]}" | sed 's/+/ + CPU /g')
        printf "    %-30s  (avg idle: %3d%%)%s\n" "$cpu_display" "$idle" "$selected_marker"
    done
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
