#!/bin/bash
# Build script for ka9q_ubersdr Go Radio Client Docker image
# Supports multi-architecture builds using Docker Buildx

set -e

# Configuration
IMAGE_NAME="${IMAGE_NAME:-ubersdr-go-client}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64,linux/arm/v7}"
PUSH="${PUSH:-false}"
STOP_BUILDER="${STOP_BUILDER:-true}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== ka9q_ubersdr Go Radio Client Docker Build ===${NC}"
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed${NC}"
    exit 1
fi

# Check if buildx is available
if ! docker buildx version &> /dev/null; then
    echo -e "${RED}Error: Docker Buildx is not available${NC}"
    echo "Please install Docker Buildx or use a newer version of Docker"
    exit 1
fi

# Get the script directory (docker/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Go client directory is parent of docker/
CLIENT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Build Configuration:"
echo "  Image Name: ${IMAGE_NAME}"
echo "  Image Tag: ${IMAGE_TAG}"
echo "  Platforms: ${PLATFORMS}"
echo "  Push to Registry: ${PUSH}"
echo "  Build Context: ${CLIENT_DIR}"
echo ""

# Create buildx builder if it doesn't exist
BUILDER_NAME="ubersdr-builder"
if ! docker buildx inspect "$BUILDER_NAME" &> /dev/null; then
    echo -e "${YELLOW}Creating buildx builder: ${BUILDER_NAME}${NC}"
    docker buildx create --name "$BUILDER_NAME" --use
    docker buildx inspect --bootstrap
else
    echo -e "${GREEN}Using existing buildx builder: ${BUILDER_NAME}${NC}"
    docker buildx use "$BUILDER_NAME"
fi

echo ""
echo -e "${GREEN}Starting multi-architecture build...${NC}"
echo ""

# Prune buildx cache if requested
if [ "$PRUNE_CACHE" = "true" ]; then
    echo -e "${YELLOW}Pruning buildx cache...${NC}"
    docker buildx prune -f
    echo ""
fi

# Build command
BUILD_CMD="docker buildx build"
BUILD_CMD="$BUILD_CMD --platform $PLATFORMS"
BUILD_CMD="$BUILD_CMD -t ${IMAGE_NAME}:${IMAGE_TAG}"
BUILD_CMD="$BUILD_CMD -f ${SCRIPT_DIR}/Dockerfile"

# Add push flag if requested
if [ "$PUSH" = "true" ]; then
    BUILD_CMD="$BUILD_CMD --push"
    echo -e "${YELLOW}Note: Images will be pushed to registry${NC}"
else
    BUILD_CMD="$BUILD_CMD --load"
    echo -e "${YELLOW}Note: Building for local use only (single platform)${NC}"
    # When using --load, we can only build for one platform
    # Detect native architecture
    NATIVE_ARCH=$(uname -m)
    case "$NATIVE_ARCH" in
        x86_64)
            PLATFORM="linux/amd64"
            ;;
        aarch64|arm64)
            PLATFORM="linux/arm64"
            ;;
        armv7l)
            PLATFORM="linux/arm/v7"
            ;;
        *)
            PLATFORM="linux/amd64"
            echo -e "${YELLOW}Warning: Unknown architecture $NATIVE_ARCH, defaulting to linux/amd64${NC}"
            ;;
    esac
    BUILD_CMD="docker buildx build --platform $PLATFORM -t ${IMAGE_NAME}:${IMAGE_TAG} -f ${SCRIPT_DIR}/Dockerfile --load"
fi

BUILD_CMD="$BUILD_CMD ${CLIENT_DIR}"

# Execute build
echo "Executing: $BUILD_CMD"
echo ""
eval $BUILD_CMD

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}=== Build completed successfully! ===${NC}"
    echo ""
    
    # Stop builder if requested
    if [ "$STOP_BUILDER" = "true" ]; then
        echo -e "${YELLOW}Stopping buildx builder...${NC}"
        docker buildx stop "$BUILDER_NAME"
        echo ""
    fi
    
    echo "To run the container:"
    echo "  docker run -d -p 8090:8090 --name ubersdr-client ${IMAGE_NAME}:${IMAGE_TAG}"
    echo ""
    echo "To run with custom port:"
    echo "  docker run -d -p 9000:9000 -e API_PORT=9000 --name ubersdr-client ${IMAGE_NAME}:${IMAGE_TAG}"
    echo ""
    echo "To run with persistent config:"
    echo "  docker run -d -p 8090:8090 -v \$(pwd)/config:/home/radio/.config/ubersdr --name ubersdr-client ${IMAGE_NAME}:${IMAGE_TAG}"
    echo ""
    echo "Buildx builder status:"
    echo "  To stop: docker buildx stop $BUILDER_NAME"
    echo "  To remove: docker buildx rm $BUILDER_NAME"
    echo "  Or use: STOP_BUILDER=true ./build.sh"
    echo ""
else
    echo -e "${RED}Build failed!${NC}"
    exit 1
fi