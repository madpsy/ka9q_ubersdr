#!/usr/bin/env bash
# real-load-daemon.sh
#
# Background daemon that samples overall CPU usage every INTERVAL seconds
# and maintains exponential moving averages (EMA) equivalent to the
# standard 1-minute, 5-minute, and 15-minute load averages.
#
# Unlike /proc/loadavg, this is based on actual CPU% × nproc, so it is
# not inflated by the cpuset run-queue accounting artefact.
#
# Usage:
#   Start:  ./real-load-daemon.sh &
#   Stop:   kill $(cat /var/run/real-load-daemon.pid)
#   Read:   ./real-load.sh
#
# State file: /var/run/real-load-avg  (or $HOME/.real-load-avg if no /var/run write access)

set -euo pipefail

INTERVAL=5   # seconds between samples

# ── State file location ───────────────────────────────────────────────────────
# When run as a systemd service (root), /run is always writable.
# When run manually as a non-root user, fall back to $HOME.
if [[ -w /run ]]; then
    STATE_FILE="/run/real-load-avg"
    PID_FILE="/run/real-load-daemon.pid"
else
    STATE_FILE="${HOME}/.real-load-avg"
    PID_FILE="${HOME}/.real-load-daemon.pid"
fi

# ── PID file (only needed when not managed by systemd) ───────────────────────
if [[ "${INVOCATION_ID:-}" == "" ]]; then
    # Not running under systemd — guard against duplicate instances manually
    if [[ -f "$PID_FILE" ]]; then
        OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
        if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
            echo "real-load-daemon already running (PID ${OLD_PID})" >&2
            exit 1
        fi
    fi
    echo $$ > "$PID_FILE"
    trap 'rm -f "$PID_FILE"' EXIT
fi

# ── EMA decay constants ───────────────────────────────────────────────────────
# Standard Linux load average uses:
#   α₁  = 1 - e^(-INTERVAL/60)    for 1-min EMA
#   α₅  = 1 - e^(-INTERVAL/300)   for 5-min EMA
#   α₁₅ = 1 - e^(-INTERVAL/900)   for 15-min EMA
#
# With INTERVAL=5:
#   α₁  ≈ 0.08111
#   α₅  ≈ 0.01653
#   α₁₅ ≈ 0.00554
#
# We compute these in awk using exp().

NPROC=$(nproc --all)

# ── Initial CPU sample ────────────────────────────────────────────────────────
read_cpu_idle() {
    awk '/^cpu / {idle=$5; total=0; for(i=2;i<=NF;i++) total+=$i; print idle, total}' /proc/stat
}

prev=$(read_cpu_idle)
prev_idle=$(echo "$prev" | awk '{print $1}')
prev_total=$(echo "$prev" | awk '{print $2}')

# Initialise EMAs to current CPU% on first sample
sleep "$INTERVAL"
curr=$(read_cpu_idle)
curr_idle=$(echo "$curr" | awk '{print $1}')
curr_total=$(echo "$curr" | awk '{print $2}')

init_load=$(awk -v pi="$prev_idle" -v pt="$prev_total" \
                -v ci="$curr_idle" -v ct="$curr_total" \
                -v nproc="$NPROC" \
    'BEGIN {
        d_idle  = ci - pi
        d_total = ct - pt
        if (d_total > 0)
            cpu_pct = (1 - d_idle/d_total) * 100
        else
            cpu_pct = 0
        printf "%.4f", cpu_pct * nproc / 100
    }')

ema1="$init_load"
ema5="$init_load"
ema15="$init_load"

prev_idle="$curr_idle"
prev_total="$curr_total"

# ── Main loop ─────────────────────────────────────────────────────────────────
while true; do
    sleep "$INTERVAL"

    curr=$(read_cpu_idle)
    curr_idle=$(echo "$curr"  | awk '{print $1}')
    curr_total=$(echo "$curr" | awk '{print $2}')

    # Compute instantaneous load equivalent and update EMAs
    result=$(awk \
        -v pi="$prev_idle"  -v pt="$prev_total" \
        -v ci="$curr_idle"  -v ct="$curr_total" \
        -v nproc="$NPROC"   -v interval="$INTERVAL" \
        -v e1="$ema1" -v e5="$ema5" -v e15="$ema15" \
    'BEGIN {
        d_idle  = ci - pi
        d_total = ct - pt
        if (d_total > 0)
            cpu_pct = (1 - d_idle/d_total) * 100
        else
            cpu_pct = 0

        # Instantaneous load equivalent
        inst = cpu_pct * nproc / 100

        # EMA decay factors (same formula as Linux kernel)
        a1  = 1 - exp(-interval / 60)
        a5  = 1 - exp(-interval / 300)
        a15 = 1 - exp(-interval / 900)

        # Update EMAs:  new_ema = old_ema + α × (inst - old_ema)
        new1  = e1  + a1  * (inst - e1)
        new5  = e5  + a5  * (inst - e5)
        new15 = e15 + a15 * (inst - e15)

        printf "%.4f %.4f %.4f %.1f\n", new1, new5, new15, cpu_pct
    }')

    ema1=$(echo  "$result" | awk '{print $1}')
    ema5=$(echo  "$result" | awk '{print $2}')
    ema15=$(echo "$result" | awk '{print $3}')
    cpu_pct=$(echo "$result" | awk '{print $4}')

    prev_idle="$curr_idle"
    prev_total="$curr_total"

    # Write atomically
    tmp="${STATE_FILE}.tmp.$$"
    printf '%s %s %s %s %d\n' \
        "$ema1" "$ema5" "$ema15" "$cpu_pct" "$(date +%s)" > "$tmp"
    mv "$tmp" "$STATE_FILE"
done
