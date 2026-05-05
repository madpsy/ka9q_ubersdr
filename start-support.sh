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
#   docker stop tunnel-support-client
#
# The container is removed automatically when it stops (--rm).

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
echo "║  THE TUNNEL IS ACTIVE ONLY WHILE THIS SCRIPT IS RUNNING.             ║"
echo "║  Closing this terminal window or pressing Ctrl-C will                ║"
echo "║  IMMEDIATELY terminate the tunnel and revoke all remote access.      ║"
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
        echo "  ✅ Proceeding — remember to close this window when support is complete."
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

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------

if ! command -v docker &>/dev/null; then
    echo "❌ Docker is not installed or not in PATH." >&2
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
# Stop any existing support session
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
# Start support session
# ---------------------------------------------------------------------------

echo ""
echo "🚀 Starting support session..."
echo "   Image   : $IMAGE"
echo "   Network : $NETWORK"
echo "   Config  : volume $CONFIG_VOLUME → /app/config (read-only)"
echo ""
echo "   The support client will read your callsign and instance UUID"
echo "   from /app/config/config.yaml and connect automatically."
echo ""
echo "   To stop the session:  docker stop $CONTAINER_NAME"
echo ""

docker run \
    --rm \
    --name "$CONTAINER_NAME" \
    --network "$NETWORK" \
    --volume "${CONFIG_VOLUME}:/app/config:ro" \
    --env "TZ=${TZ:-UTC}" \
    --log-driver json-file \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    "$IMAGE"
