#!/bin/sh
# Create restart trigger directory
mkdir -p /var/run/restart-trigger

# Report the PIDs of any running caddy process. PID 1 is the init process
# (docker-compose sets init: true), so caddy is a child of it, not PID 1 itself.
caddy_pids() {
    pidof caddy 2>/dev/null || pgrep -x caddy 2>/dev/null || true
}

# Start background watcher for restart trigger file
# When the trigger file is detected, signal caddy so the container restarts
(
    while true; do
        if [ -f /var/run/restart-trigger/restart-caddy ]; then
            echo "Restart trigger detected at $(date), stopping caddy to restart container..."
            rm -f /var/run/restart-trigger/restart-caddy

            # Graceful shutdown first: init forwards SIGTERM on to caddy.
            kill -TERM 1 2>/dev/null || echo "Warning: failed to signal PID 1"

            # Caddy only exits once in-flight requests have drained. UberSDR keeps
            # long-lived connections open (/audio/stream, the spectrum SSE streams,
            # /ws/dxcluster, /api/decoder/stream), so if the Caddyfile has no
            # grace_period those never drain: caddy closes its listeners, refuses
            # every new connection and never exits, and the container never
            # restarts. Force-kill it if the graceful path has not finished in time.
            #
            # SIGKILL cannot be delivered to PID 1 from inside its own PID
            # namespace, so target the caddy process rather than PID 1.
            i=0
            while [ "$i" -lt 20 ] && [ -n "$(caddy_pids)" ]; do
                sleep 1
                i=$((i + 1))
            done
            remaining=$(caddy_pids)
            if [ -n "$remaining" ]; then
                echo "Caddy still running ${i}s after SIGTERM, sending SIGKILL to PID(s) $remaining"
                # shellcheck disable=SC2086 # word splitting is intended: may be several PIDs
                kill -9 $remaining 2>/dev/null || echo "Warning: failed to kill caddy"
            fi
            # Don't exit - let the loop continue in case restart is needed again
            sleep 1
        fi
        sleep 0.5
    done
) &

# Start caddy
exec "$@"
