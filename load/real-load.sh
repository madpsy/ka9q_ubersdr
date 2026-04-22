#!/usr/bin/env bash
# real-load.sh
#
# Reads the real CPU-based load averages computed by real-load-daemon.sh
# and prints them in the same format as 'uptime', but corrected for the
# cpuset run-queue inflation artefact.
#
# Usage:
#   ./real-load.sh              # print current 1/5/15 min averages
#   ./real-load.sh --watch      # refresh every 2 seconds (Ctrl+C to stop)
#   ./real-load.sh --raw        # print raw numbers only (for scripting)

set -euo pipefail

# ── State file location (must match real-load-daemon.sh) ─────────────────────
if [[ -f /run/real-load-avg ]]; then
    STATE_FILE="/run/real-load-avg"
elif [[ -f "${HOME}/.real-load-avg" ]]; then
    STATE_FILE="${HOME}/.real-load-avg"
else
    STATE_FILE=""
fi

WATCH=false
RAW=false
CSV=false
CSV_HEADER=true   # print header row on first CSV output

while [[ $# -gt 0 ]]; do
    case "$1" in
        --watch)      WATCH=true;       shift ;;
        --raw)        RAW=true;         shift ;;
        --csv)        CSV=true;         shift ;;
        --csv-nohead) CSV=true; CSV_HEADER=false; shift ;;
        --help|-h)
            echo "Usage: $0 [--watch] [--raw] [--csv] [--csv-nohead]"
            echo "  --watch       Refresh every 2 seconds"
            echo "  --raw         Print '1min 5min 15min cpu% nproc' numbers only"
            echo "  --csv         Print CSV with header: timestamp,load1,load5,load15,cpu_pct,nproc,age_s"
            echo "  --csv-nohead  Same as --csv but omit the header row (for appending)"
            exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

NPROC=$(nproc --all)

print_load() {
    if [[ -z "$STATE_FILE" || ! -f "$STATE_FILE" ]]; then
        echo "real-load-daemon is not running. Start it with:" >&2
        echo "  ./real-load-daemon.sh &" >&2
        echo "" >&2
        echo "Falling back to a single live sample (no EMA)..." >&2

        # One-shot fallback: sample /proc/stat directly
        prev=$(awk '/^cpu / {idle=$5; total=0; for(i=2;i<=NF;i++) total+=$i; print idle, total}' /proc/stat)
        sleep 2
        curr=$(awk '/^cpu / {idle=$5; total=0; for(i=2;i<=NF;i++) total+=$i; print idle, total}' /proc/stat)

        awk -v pi="$(echo "$prev" | awk '{print $1}')" \
            -v pt="$(echo "$prev" | awk '{print $2}')" \
            -v ci="$(echo "$curr" | awk '{print $1}')" \
            -v ct="$(echo "$curr" | awk '{print $2}')" \
            -v nproc="$NPROC" \
        'BEGIN {
            d_idle  = ci - pi
            d_total = ct - pt
            cpu_pct = (d_total > 0) ? (1 - d_idle/d_total) * 100 : 0
            load    = cpu_pct * nproc / 100
            printf " real load (2s sample): %.2f  (%.1f%% of %d CPUs)\n", load, cpu_pct, nproc
            printf " /proc/loadavg (for comparison): "
        }'
        cat /proc/loadavg
        return
    fi

    read -r ema1 ema5 ema15 cpu_pct ts < "$STATE_FILE"

    local age=$(( $(date +%s) - ts ))

    if $RAW; then
        echo "$ema1 $ema5 $ema15 $cpu_pct $NPROC"
        return
    fi

    if $CSV; then
        if $CSV_HEADER; then
            echo "timestamp,load1,load5,load15,cpu_pct,nproc,age_s"
            CSV_HEADER=false   # only print header once per run
        fi
        printf '%s,%.2f,%.2f,%.2f,%.1f,%d,%d\n' \
            "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
            "$ema1" "$ema5" "$ema15" "$cpu_pct" "$NPROC" "$age"
        return
    fi

    # Format like uptime output
    local time_str
    time_str=$(date '+%H:%M:%S')

    local stale_warn=""
    if (( age > 30 )); then
        stale_warn="  ⚠ data is ${age}s old — is real-load-daemon still running?"
    fi

    printf " %s  real load average: %.2f, %.2f, %.2f" \
        "$time_str" "$ema1" "$ema5" "$ema15"
    printf "  (%.1f%% of %d CPUs)" "$cpu_pct" "$NPROC"
    printf "%s\n" "$stale_warn"

    # Show comparison with /proc/loadavg
    local sys_la
    sys_la=$(awk '{print $1, $2, $3}' /proc/loadavg)
    printf " %s  /proc/loadavg:      %s  ← may be inflated by cpuset artefact\n" \
        "$time_str" "$sys_la"
}

if $WATCH; then
    while true; do
        # Don't clear screen in CSV/raw mode — output is a continuous stream
        if ! $CSV && ! $RAW; then
            clear 2>/dev/null || printf '\033[2J\033[H'
        fi
        print_load
        sleep 2
    done
else
    print_load
fi
