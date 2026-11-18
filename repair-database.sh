#!/bin/bash
#
# Checks the UberSDR database and repairs it if it is damaged.
#
# Stops the ka9q_ubersdr container, runs the image's repair-database tool in a
# one-off container from the same image with the same config volume, then
# starts ka9q_ubersdr again. The receiver is offline while it runs.
#
#   ~/ubersdr/repair-database.sh [--yes] [--force] [--no-backup]
#
#   --yes        do not ask for confirmation
#   --force      rebuild the database even if the check finds no problems
#   --no-backup  delete the damaged original after a successful repair
#                (by default it is kept next to the database)

# Prevent running with sudo (breaks $HOME detection); native root is allowed
if [ -n "$SUDO_USER" ]; then
    echo "Error: Do not run this script with sudo. Run it directly as your user:" >&2
    echo "  bash repair-database.sh" >&2
    exit 1
fi

UBERSDR_DIR="$HOME/ubersdr"
SERVICE="ubersdr"
CONTAINER="${UBERSDR_CONTAINER:-ka9q_ubersdr}" # override for tests only
RUN_NAME="ubersdr-db-repair"

ASSUME_YES=0
REPAIR_ARGS=()
for arg in "$@"; do
    case "$arg" in
        -y|--yes) ASSUME_YES=1 ;;
        --force|--no-backup) REPAIR_ARGS+=("$arg") ;;
        -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $arg (see --help)" >&2; exit 1 ;;
    esac
done

if [ ! -d "$UBERSDR_DIR" ]; then
    echo "Error: UberSDR directory not found at $UBERSDR_DIR" >&2
    exit 1
fi
cd "$UBERSDR_DIR" || exit 1

if ! docker compose ps >/dev/null 2>&1; then
    echo "Error: cannot run 'docker compose' in $UBERSDR_DIR" >&2
    exit 1
fi

# The repair runs from the receiver's own image; check it has the tool before
# stopping anything.
echo "Checking the UberSDR image..."
db_bytes=$(docker compose run --rm --no-deps -T --entrypoint sh "$SERVICE" -c \
    'command -v repair-database >/dev/null || exit 3; stat -c %s /app/config/db/ubersdr.db 2>/dev/null || echo 0' \
    2>/dev/null </dev/null)
case $? in
    0) ;;
    3)
        echo "Error: this UberSDR image does not include the database repair tool." >&2
        echo "Update first with ~/ubersdr/update-ubersdr.sh, then run this again." >&2
        exit 1
        ;;
    *)
        echo "Error: could not start a container from the UberSDR image." >&2
        exit 1
        ;;
esac
db_gb=$(awk -v b="${db_bytes:-0}" 'BEGIN { printf "%.1f", b / 1e9 }')

was_running=0
if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]; then
    was_running=1
fi

echo
echo "This will:"
echo "  1. Stop the $CONTAINER container. The receiver will be OFFLINE until this finishes."
echo "  2. Check the database (${db_gb} GB) and, if it is damaged, rebuild it."
echo "     A rebuild needs free disk space about the size of the database."
if [ "$was_running" -eq 1 ]; then
    echo "  3. Start $CONTAINER again, whether or not the repair succeeds."
else
    echo "  3. Leave $CONTAINER stopped, as it is now."
fi
echo
echo "On a large database this can take a while: roughly 1-2 minutes per GB to check,"
echo "and as long again to rebuild if needed. The original database is not changed"
echo "unless the rebuilt copy passes verification, and is kept as a backup."
echo

if [ "$ASSUME_YES" -ne 1 ]; then
    if [ ! -t 0 ] && [ ! -e /dev/tty ]; then
        echo "Error: no terminal to confirm on; run with --yes to proceed." >&2
        exit 1
    fi
    read -r -p "Stop $CONTAINER and continue? [y/N] " answer < /dev/tty
    case "$answer" in
        y|Y|yes|YES) ;;
        *) echo "Cancelled. Nothing was changed."; exit 0 ;;
    esac
fi

# Whatever happens from here (success, failure, Ctrl-C), make sure the
# one-off container is gone and the receiver is started again.
restore() {
    status=$?
    trap - EXIT INT TERM
    if docker inspect "$RUN_NAME" >/dev/null 2>&1; then
        echo "Stopping the repair container..."
        # Let it clean up its partial work before it is removed.
        docker stop -t 60 "$RUN_NAME" >/dev/null 2>&1
        docker rm -f "$RUN_NAME" >/dev/null 2>&1
    fi
    if [ "$was_running" -eq 1 ]; then
        echo
        echo "Starting $CONTAINER..."
        if ! docker compose start "$SERVICE" >/dev/null 2>&1; then
            docker compose up -d --no-deps "$SERVICE"
        fi
        if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]; then
            echo "$CONTAINER started."
        else
            echo "Warning: $CONTAINER did not start. Try ~/ubersdr/start-ubersdr.sh" >&2
            status=1
        fi
    fi
    exit "$status"
}
trap restore EXIT
trap 'exit 130' INT TERM

if [ "$was_running" -eq 1 ]; then
    echo "Stopping $CONTAINER..."
    if ! docker compose stop -t 60 "$SERVICE"; then
        echo "Error: could not stop $CONTAINER" >&2
        exit 1
    fi
fi

echo "Running the database check and repair..."
echo
docker compose run --rm --no-deps --name "$RUN_NAME" --entrypoint repair-database "$SERVICE" "${REPAIR_ARGS[@]}"
result=$?
echo
if [ "$result" -eq 0 ]; then
    echo "Database check and repair finished."
else
    echo "The database repair did not complete (exit $result). The original database was left as it was." >&2
fi
exit "$result"
