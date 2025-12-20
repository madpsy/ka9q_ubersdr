#!/bin/bash
set -e

# WSPR MQTT Aggregator Docker Build Script

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
IMAGE_NAME="wsprnet-mqtt"
VERSION=${VERSION:-"latest"}
PLATFORMS=${PLATFORMS:-"linux/amd64,linux/arm64"}
AUTO_START=${1:-""}

echo -e "${GREEN}Building WSPR MQTT Aggregator Docker Image${NC}"
echo "Image: ${IMAGE_NAME}:${VERSION}"
echo "Platforms: ${PLATFORMS}"
echo ""

# Detect current platform
CURRENT_PLATFORM=$(uname -m)
if [ "$CURRENT_PLATFORM" = "x86_64" ]; then
    BUILD_PLATFORM="linux/amd64"
elif [ "$CURRENT_PLATFORM" = "aarch64" ] || [ "$CURRENT_PLATFORM" = "arm64" ]; then
    BUILD_PLATFORM="linux/arm64"
else
    BUILD_PLATFORM="linux/amd64"
fi

echo -e "${GREEN}Building for current platform: ${BUILD_PLATFORM}${NC}"

# Stop and remove existing container if running
echo -e "${YELLOW}Step 1: Stopping and removing existing container...${NC}"
docker-compose down 2>/dev/null || true

# Remove existing image to force rebuild
echo -e "${YELLOW}Step 2: Removing existing image to prevent cache...${NC}"
docker rmi ${IMAGE_NAME}:${VERSION} 2>/dev/null || true
docker rmi $(docker images -q ${IMAGE_NAME}) 2>/dev/null || true

# Also prune build cache to be absolutely sure
echo -e "${YELLOW}Step 3: Pruning Docker build cache...${NC}"
docker builder prune -f 2>/dev/null || true

# Build using docker-compose to ensure consistency
echo -e "${GREEN}Step 4: Building fresh image with docker-compose...${NC}"
DOCKER_BUILDKIT=1 docker-compose build --no-cache --pull

echo ""
echo -e "${GREEN}Build complete!${NC}"
echo ""

# Auto-start if requested
if [ "$AUTO_START" = "start" ] || [ "$AUTO_START" = "-s" ] || [ "$AUTO_START" = "--start" ]; then
    echo -e "${GREEN}Starting container...${NC}"
    docker-compose up -d
    echo ""
    echo -e "${GREEN}Container started!${NC}"
    echo "View logs: docker-compose logs -f"
else
    echo "To run the container:"
    echo "  docker-compose up -d"
    echo ""
    echo "Or rebuild and start in one command:"
    echo "  ./build.sh start"
fi