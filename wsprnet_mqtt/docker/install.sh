#!/bin/bash
set -e

# WSPR MQTT Aggregator Installation Script

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   WSPR MQTT Aggregator - Installation         ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed.${NC}"
    echo "Please install Docker first: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if docker-compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo -e "${YELLOW}Warning: docker-compose not found. Trying docker compose...${NC}"
    if ! docker compose version &> /dev/null; then
        echo -e "${RED}Error: Neither docker-compose nor 'docker compose' is available.${NC}"
        exit 1
    fi
    COMPOSE_CMD="docker compose"
else
    COMPOSE_CMD="docker-compose"
fi

echo -e "${BLUE}Step 1: Checking Docker volume...${NC}"
# Check if volume already exists
if docker volume inspect wsprnet-data &> /dev/null; then
    echo -e "${YELLOW}Docker volume 'wsprnet-data' already exists${NC}"
    echo -e "${BLUE}Your existing configuration will be preserved${NC}"
else
    echo -e "${GREEN}✓ Docker volume will be created automatically${NC}"
fi
echo ""

echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}Configuration${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}Configure via Web Admin Interface${NC}"
echo "  - After starting, access: http://localhost:9009/admin/login"
echo "  - Configure receiver, MQTT broker, and instances via GUI"
echo ""
echo -e "${YELLOW}Admin Password:${NC}"
echo "  - A random password will be generated automatically on first start"
echo "  - Check the logs after starting to get your password"
echo ""
read -p "Press Enter to build and start the container..."
echo ""

echo -e "${BLUE}Step 2: Building Docker image (no cache to ensure latest)...${NC}"
docker build --no-cache -t wsprnet-mqtt -f Dockerfile .. || {
    echo -e "${RED}Error: Docker build failed${NC}"
    exit 1
}
echo -e "${GREEN}✓ Docker image built successfully${NC}"
echo ""

echo -e "${BLUE}Step 3: Starting container...${NC}"
# Stop and remove old containers to avoid ContainerConfig errors
if docker ps -a --format '{{.Names}}' | grep -q '^wsprnet-mqtt$'; then
    echo "Stopping and removing old container..."
    $COMPOSE_CMD down 2>/dev/null || true
fi

$COMPOSE_CMD up -d || {
    echo -e "${RED}Error: Failed to start container${NC}"
    echo ""
    echo -e "${YELLOW}Troubleshooting:${NC}"
    echo "  - Try: $COMPOSE_CMD down && $COMPOSE_CMD up -d"
    echo "  - Check logs: $COMPOSE_CMD logs"
    exit 1
}
echo -e "${GREEN}✓ Container started successfully${NC}"
echo ""

# Wait a moment for container to start
sleep 3

echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              Installation Complete! 🎉         ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Web Interface:${NC} http://localhost:9009"
echo -e "${BLUE}Admin Interface:${NC} http://localhost:9009/admin/login"
echo ""
echo -e "${YELLOW}⚠ IMPORTANT: Check the logs for your admin password!${NC}"
echo ""
echo -e "${YELLOW}Useful commands:${NC}"
echo "  View logs (including admin password):"
echo "    $COMPOSE_CMD logs"
echo ""
echo "  View live logs:"
echo "    $COMPOSE_CMD logs -f"
echo ""
echo "  Stop:"
echo "    $COMPOSE_CMD down"
echo ""
echo "  Restart:"
echo "    $COMPOSE_CMD restart"
echo ""
echo "  Status:"
echo "    $COMPOSE_CMD ps"
echo ""
echo -e "${GREEN}Showing container logs (look for admin password):${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
$COMPOSE_CMD logs --tail=30