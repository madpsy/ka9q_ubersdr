#!/bin/bash
# start-support.sh — Start an UberSDR remote support session.
#
# This script pulls the support client image and runs it as a one-shot
# Docker container attached to the same network as the main UberSDR stack.
# It mounts the ubersdr-config volume read-only so the support client can
# read callsign and instance UUID from config.yaml automatically.
#
# Usage:
#   chmod +x start-support.sh
#   ./start-support.sh
#
# To stop the session:
#   Press Ctrl-C inside the tmux session, or reattach via
#   Admin → Terminal → Support Session and press Ctrl-C there.

set -euo pipefail

# ---------------------------------------------------------------------------
# ⚠️  SECURITY WARNING — READ BEFORE CONTINUING
# ---------------------------------------------------------------------------

echo ""
echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║          ⚠️   REMOTE SUPPORT ACCESS WARNING  ⚠️                      ║"
echo "╠══════════════════════════════════════════════════════════════════════╣"
echo "║                                                                      ║"
echo "║  This script opens a TEMPORARY REMOTE SUPPORT TUNNEL to your         ║"
echo "║  UberSDR instance.  While the tunnel is active, the support team     ║"
echo "║  will have access to:                                                ║"
echo "║                                                                      ║"
echo "║    • Your UberSDR web interface (all pages and settings)             ║"
echo "║    • The admin panel (full administrative control)                   ║"
echo "║    • A terminal / shell on this machine                              ║"
echo "║    • All data visible within the UberSDR stack                       ║"
echo "║                                                                      ║"
echo "║  THE TUNNEL RUNS IN A TMUX SESSION NAMED 'Support Session'.          ║"
echo "║  Press Ctrl-C inside the session to stop the tunnel.                 ║"
echo "║  Closing this window DETACHES but does NOT stop the tunnel.          ║"
echo "║  To stop it later: reattach via Admin → Terminal → Support Session   ║"
echo "║  and press Ctrl-C there.                                             ║"
echo "║                                                                      ║"
echo "║  Only proceed if you have requested support and trust the            ║"
echo "║  recipient of the tunnel credentials.                                ║"
echo "║                                                                      ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""

read -r -p "  Do you want to continue and open the support tunnel? [y/N]: " CONFIRM
echo ""

case "$CONFIRM" in
    [yY][eE][sS]|[yY])
        echo "  ✅ Proceeding — press Ctrl-C inside the session when support is complete."
        echo ""
        ;;
    *)
        echo "  ❌ Aborted. No tunnel has been started."
        echo ""
        exit 0
        ;;
esac

IMAGE="madpsy/tunnel-support-client:latest"
CONTAINER_NAME="tunnel-support-client"
CONFIG_VOLUME="ubersdr_ubersdr-config"
NETWORK="ubersdr_sdr-network"
SESSION_NAME="Support Session"

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------

if ! command -v docker &>/dev/null; then
    echo "❌ Docker is not installed or not in PATH." >&2
    exit 1
fi

if ! command -v tmux &>/dev/null; then
    echo "❌ tmux is not installed. Please install it first:" >&2
    echo "   sudo apt install -y tmux" >&2
    exit 1
fi

if ! docker volume inspect "$CONFIG_VOLUME" &>/dev/null; then
    echo "❌ Docker volume '$CONFIG_VOLUME' not found." >&2
    echo "   Make sure the main UberSDR stack has been started at least once." >&2
    exit 1
fi

if ! docker network inspect "$NETWORK" &>/dev/null; then
    echo "❌ Docker network '$NETWORK' not found." >&2
    echo "   Make sure the main UberSDR stack is running." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Guard against a duplicate tmux session
# ---------------------------------------------------------------------------

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "⚠️  A 'Support Session' tmux session is already running."
    echo "   Attach to it with: tmux attach -t 'Support Session'"
    echo "   Or kill it first:  tmux kill-session -t 'Support Session'"
    exit 1
fi

# ---------------------------------------------------------------------------
# Stop any existing support container
# ---------------------------------------------------------------------------

if docker inspect "$CONTAINER_NAME" &>/dev/null; then
    echo "⚠️  A support session container already exists. Stopping it first..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    sleep 1
fi

# ---------------------------------------------------------------------------
# Pull latest image
# ---------------------------------------------------------------------------

echo "🔄 Pulling latest support client image..."
docker pull "$IMAGE"

# ---------------------------------------------------------------------------
# Start support session inside tmux
# ---------------------------------------------------------------------------

echo ""
echo "🚀 Starting support session in tmux session 'Support Session'..."
echo "   Image   : $IMAGE"
echo "   Network : $NETWORK"
echo "   Config  : volume $CONFIG_VOLUME → /app/config (read-only)"
echo ""
echo "   The support client will read your callsign and instance UUID"
echo "   from /app/config/config.yaml and connect automatically."
echo ""
echo "   Press Ctrl-C inside the session to stop the tunnel."
echo "   Closing this window detaches but does NOT stop the tunnel."
echo "   To stop it later: reattach via Admin → Terminal → Support Session"
echo "   and press Ctrl-C there."
echo ""

tmux new-session -d -s "$SESSION_NAME" -n 'Support Session' \
    "docker run \
        --rm \
        --name '$CONTAINER_NAME' \
        --network '$NETWORK' \
        --volume '${CONFIG_VOLUME}:/app/config:ro' \
        --env 'TZ=${TZ:-UTC}' \
        --log-driver json-file \
        --log-opt max-size=10m \
        --log-opt max-file=3 \
        '$IMAGE'; \
     echo; \
     echo; \
     echo '=== Support tunnel has ended ==='; \
     echo; \
     echo 'Press Enter to close this session...'; \
     read"

echo "✅ Tmux session 'Support Session' created and tunnel started!"
echo ""
echo "Attaching to session now..."
sleep 1
tmux attach -t "$SESSION_NAME"
