#!/bin/sh
# Create restart trigger directory
mkdir -p /var/run/restart-trigger

# Start background watcher for restart trigger file
# When trigger file is detected, kill PID 1 (caddy) to trigger container restart
(
    while true; do
        if [ -f /var/run/restart-trigger/restart-caddy ]; then
            echo "Restart trigger detected at $(date), killing PID 1 to restart container..."
            rm -f /var/run/restart-trigger/restart-caddy
            # Try graceful shutdown first, then force kill if needed
            kill -TERM 1 || kill -9 1 || echo "Warning: Failed to kill PID 1"
            # Don't exit - let the loop continue in case restart is needed again
            sleep 1
        fi
        sleep 0.5
    done
) &

# Start caddy as PID 1
exec "$@"
