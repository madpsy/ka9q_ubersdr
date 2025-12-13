#!/bin/sh
# Create restart trigger directory
mkdir -p /var/run/restart-trigger

# Start background watcher for restart trigger file
# When trigger file is detected, kill PID 1 (caddy) to trigger container restart
(
    while true; do
        if [ -f /var/run/restart-trigger/restart-caddy ]; then
            echo "Restart trigger detected, killing PID 1 to restart container..."
            rm -f /var/run/restart-trigger/restart-caddy
            kill -TERM 1
            exit 0
        fi
        sleep 0.5
    done
) &

# Start caddy as PID 1
exec "$@"
