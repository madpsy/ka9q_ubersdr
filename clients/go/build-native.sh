#!/bin/bash
# Native build script for the current platform
# Use this when building directly on the target platform (e.g., Raspberry Pi)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Building UberSDR Go Client natively...${NC}"
echo ""

# Detect architecture
ARCH=$(uname -m)
echo -e "${YELLOW}Detected architecture: ${ARCH}${NC}"

# Check if required dependencies are installed
echo -e "${YELLOW}Checking dependencies...${NC}"

MISSING_DEPS=()

if ! command -v go &> /dev/null; then
    MISSING_DEPS+=("golang")
fi

if ! pkg-config --exists portaudio-2.0; then
    MISSING_DEPS+=("portaudio19-dev")
fi

if ! pkg-config --exists samplerate; then
    MISSING_DEPS+=("libsamplerate0-dev")
fi

if ! command -v pkg-config &> /dev/null; then
    MISSING_DEPS+=("pkg-config")
fi

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    echo -e "${RED}Missing dependencies: ${MISSING_DEPS[*]}${NC}"
    echo ""
    echo "Install them with:"
    echo "  sudo apt-get update"
    echo "  sudo apt-get install -y ${MISSING_DEPS[*]}"
    exit 1
fi

echo -e "${GREEN}All dependencies found${NC}"
echo ""

# Create build directory
mkdir -p build

# Build version/timestamp info
BUILD_TIME=$(date -u '+%Y-%m-%d_%H:%M:%S')
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
LDFLAGS="-s -w -X main.BuildTime=${BUILD_TIME} -X main.GitCommit=${GIT_COMMIT}"

# Determine output filename based on architecture
case "$ARCH" in
    aarch64|arm64)
        OUTPUT="radio_client-linux-arm64"
        ;;
    armv7l|armhf)
        OUTPUT="radio_client-linux-arm32"
        ;;
    x86_64|amd64)
        OUTPUT="radio_client-linux-amd64"
        ;;
    *)
        OUTPUT="radio_client-linux-${ARCH}"
        ;;
esac

echo -e "${YELLOW}Building ${OUTPUT}...${NC}"
echo ""

# Download dependencies first
echo -e "${YELLOW}Downloading Go dependencies...${NC}"
if ! go mod download; then
    echo -e "${RED}Failed to download dependencies${NC}"
    exit 1
fi

# Tidy go.mod and go.sum
echo -e "${YELLOW}Tidying go.mod and go.sum...${NC}"
if ! go mod tidy; then
    echo -e "${RED}Failed to tidy dependencies${NC}"
    exit 1
fi

echo ""

# Build
if CGO_ENABLED=1 go build -v -ldflags="${LDFLAGS}" -o "build/${OUTPUT}" .; then
    echo ""
    echo -e "${GREEN}✓ Successfully built: build/${OUTPUT}${NC}"
    
    # Display file size
    if [ -f "build/${OUTPUT}" ]; then
        SIZE=$(ls -lh "build/${OUTPUT}" | awk '{print $5}')
        echo -e "${GREEN}  Size: ${SIZE}${NC}"
    fi
    
    # Create a symlink for convenience
    ln -sf "${OUTPUT}" "build/radio_client"
    echo -e "${GREEN}  Symlink: build/radio_client -> ${OUTPUT}${NC}"
    
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Build Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "${GREEN}Run the application:${NC}"
    echo "  ./build/radio_client --help"
    echo "  ./build/radio_client --api"
    echo ""
    echo -e "${YELLOW}Note:${NC} Built with PortAudio and libsamplerate support"
    
else
    echo ""
    echo -e "${RED}✗ Build failed${NC}"
    exit 1
fi