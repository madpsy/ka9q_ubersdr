#!/usr/bin/env bash
# suggest-radiod-cpuset.sh
#
# Reads CPU topology from /sys and suggests the best HT sibling pair
# to assign to radiod via cpuset in docker-compose.yml.
#
# Selection criteria:
#   1. Find all physical core HT sibling pairs by reading the kernel's
#      thread_siblings_list (the authoritative source of HT pairs)
#   2. Pick the pair whose physical core has the lowest recent CPU load
#      (measured via /proc/stat idle time delta over a short sample)
#
# Usage:
#   ./suggest-radiod-cpuset.sh
#   ./suggest-radiod-cpuset.sh --quiet
#       Output only the cpuset string, e.g. "0,12"
#
#   ./suggest-radiod-cpuset.sh --apply [--compose-file <path>]
#       Write the recommended cpuset into the ka9q-radio service in
#       the specified docker-compose file (default: docker-compose.yml
#       in the same directory as this script).
#
# Examples:
#   ./suggest-radiod-cpuset.sh --apply
#   ./suggest-radiod-cpuset.sh --apply --compose-file /opt/sdr/docker-compose.yml
#   ./suggest-radiod-cpuset.sh --quiet --apply --compose-file ../docker-compose.yml

set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────────────

QUIET=false
APPLY=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --quiet)    QUIET=true;  shift ;;
        --apply)    APPLY=true;  shift ;;
        --compose-file)
            [[ -n "${2:-}" ]] || { echo "ERROR: --compose-file requires a path argument" >&2; exit 1; }
            COMPOSE_FILE="$2"; shift 2 ;;
        *)
            echo "Usage: $0 [--quiet] [--apply [--compose-file <path>]]" >&2
            exit 1 ;;
    esac
done

# ── 1. Collect HT sibling pairs from thread_siblings_list ─────────────────────
# /sys/devices/system/cpu/cpuN/topology/thread_siblings_list contains the
# canonical comma/range list of ALL logical CPUs sharing the same physical core.
# e.g. for a 2-way HT system: "0,12" or "6,18"

declare -A seen_pairs   # key: canonical sorted pair string → 1 (dedup)
declare -a pair_list    # ordered list of "first,sibling" strings

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

    # Only handle pairs (2-way HT); skip if solo or >2 siblings
    (( ${#expanded[@]} == 2 )) || continue

    a="${expanded[0]}"
    b="${expanded[1]}"

    # Canonical key: lower number first
    if (( a < b )); then
        key="${a},${b}"
    else
        key="${b},${a}"
    fi

    if [[ -v seen_pairs["$key"] ]]; then
        continue
    fi
    seen_pairs["$key"]=1
    pair_list+=("$key")
done

if (( ${#pair_list[@]} == 0 )); then
    echo "ERROR: No HT sibling pairs found. Is Hyperthreading enabled?" >&2
    exit 1
fi

# ── 2. Sample CPU idle time from /proc/stat ───────────────────────────────────
# Format: cpu<N> user nice system idle iowait irq softirq steal guest guest_nice

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
            (( total_val += f ))
        done
        _idle["$cpu_n"]="$idle_val"
        _total["$cpu_n"]="$total_val"
    done < /proc/stat
}

sample_stat idle1 total1
sleep 0.5
sample_stat idle2 total2

# ── 3. Score each HT pair by average idle% of its two logical CPUs ────────────

best_pair=""
best_idle=-1

for pair in "${pair_list[@]}"; do
    IFS=',' read -r first sibling <<< "$pair"

    idle_pct=0
    for cpu_n in "$first" "$sibling"; do
        d_idle=$(( idle2["$cpu_n"] - idle1["$cpu_n"] ))
        d_total=$(( total2["$cpu_n"] - total1["$cpu_n"] ))
        if (( d_total > 0 )); then
            pct=$(( d_idle * 100 / d_total ))
        else
            pct=100
        fi
        (( idle_pct += pct ))
    done
    avg_idle=$(( idle_pct / 2 ))

    if (( avg_idle > best_idle )); then
        best_idle=$avg_idle
        best_pair="$pair"
    fi
done

# ── 4. Output ─────────────────────────────────────────────────────────────────

if $QUIET; then
    echo "$best_pair"
else
    IFS=',' read -r bp_first bp_sibling <<< "$best_pair"
    echo ""
    echo "  Suggested cpuset for radiod: ${best_pair}"
    echo ""
    echo "  CPUs ${bp_first} and ${bp_sibling} are confirmed HT siblings on the same physical core"
    echo "  (shared L1/L2 cache) and had the highest average idle% (~${best_idle}%) at sample time."
    echo ""
    echo "  Add to docker-compose.yml under the ka9q-radio service:"
    echo ""
    echo "    ka9q-radio:"
    echo "      cpuset: \"${best_pair}\""
    echo ""
    echo "  All detected HT pairs on this system:"
    for pair in "${pair_list[@]}"; do
        IFS=',' read -r a b <<< "$pair"
        d_idle_a=$(( idle2["$a"] - idle1["$a"] ))
        d_total_a=$(( total2["$a"] - total1["$a"] ))
        d_idle_b=$(( idle2["$b"] - idle1["$b"] ))
        d_total_b=$(( total2["$b"] - total1["$b"] ))
        pct_a=$(( d_total_a > 0 ? d_idle_a * 100 / d_total_a : 100 ))
        pct_b=$(( d_total_b > 0 ? d_idle_b * 100 / d_total_b : 100 ))
        avg=$(( (pct_a + pct_b) / 2 ))
        marker=""
        [[ "$pair" == "$best_pair" ]] && marker=" ← recommended"
        printf "    CPU %-2s + CPU %-2s  (avg idle: %3d%%)%s\n" "$a" "$b" "$avg" "$marker"
    done
    echo ""
fi

# ── 5. Apply to docker-compose file ──────────────────────────────────────────

if $APPLY; then
    if [[ ! -f "$COMPOSE_FILE" ]]; then
        echo "ERROR: docker-compose file not found: ${COMPOSE_FILE}" >&2
        exit 1
    fi

    # Check if ka9q-radio service exists in the file
    if ! grep -q 'ka9q-radio:' "$COMPOSE_FILE"; then
        echo "ERROR: No 'ka9q-radio:' service found in ${COMPOSE_FILE}" >&2
        exit 1
    fi

    # Back up the original file
    BACKUP="${COMPOSE_FILE}.bak"
    cp "$COMPOSE_FILE" "$BACKUP"

    # Single awk pass: handles both insert and replace correctly.
    #
    # Service blocks in docker-compose use exactly 2-space indentation for the
    # service name key (e.g. "  ka9q-radio:") and 4-space for their properties.
    # We enter the ka9q-radio block on that header line and exit as soon as we
    # see another 2-space non-blank, non-comment line (the next sibling service).
    #
    # Within the block:
    #   - If a cpuset: line exists, replace it and set replaced=1
    #   - After the block ends (or at EOF), if no cpuset was replaced, insert one
    #     after the ka9q-radio header line (tracked via insert_after)
    awk -v new_cpuset="$best_pair" '
        # Entering the ka9q-radio service block
        /^  ka9q-radio:[[:space:]]*(#.*)?$/ {
            in_service = 1
            replaced = 0
            inserted = 0
            print
            next
        }

        # Exiting the block: next sibling service (2-space indent, not blank/comment)
        in_service && /^  [^[:space:]#]/ {
            in_service = 0
            # If we never found a cpuset line to replace or insert, something is wrong
            # (should not happen since we insert on first real key below)
        }

        # Within the block: replace an existing cpuset: line
        # Match "    cpuset:" with anything after the colon (value, comment, or nothing)
        in_service && /^[[:space:]]+cpuset:/ {
            match($0, /^[[:space:]]+/)
            indent = substr($0, 1, RLENGTH)
            print indent "cpuset: \"" new_cpuset "\""
            replaced = 1
            inserted = 1
            action = "updated"
            next
        }

        # Within the block: before printing the first real 4-space key, insert cpuset
        # immediately before it if we have not yet inserted or replaced
        in_service && !inserted && /^    [^[:space:]#]/ {
            print "    cpuset: \"" new_cpuset "\""
            inserted = 1
            action = "added"
            # fall through to print the current line normally
        }

        { print }

        END {
            # Edge case: ka9q-radio is the last service block and had no keys at all
            if (in_service && !inserted) {
                print "    cpuset: \"" new_cpuset "\""
                action = "added"
            }
        }
    ' "$COMPOSE_FILE" > "${COMPOSE_FILE}.tmp" && mv "${COMPOSE_FILE}.tmp" "$COMPOSE_FILE"
    ACTION="${action:-added}"

    if ! $QUIET; then
        echo "  ✓ ${ACTION^} cpuset: \"${best_pair}\" in ${COMPOSE_FILE}"
        echo "  Backup saved to: ${BACKUP}"
        echo ""
    fi
fi
