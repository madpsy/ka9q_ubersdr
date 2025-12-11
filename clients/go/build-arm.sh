#!/bin/bash
# Build script for ARM platforms using Docker
# This script builds ARM binaries using Docker containers with proper ARM toolchains

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Building UberSDR Go Client for ARM platforms using Docker...${NC}"
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed${NC}"
    echo "Please install Docker from https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if Docker daemon is running
if ! docker info &> /dev/null; then
    echo -e "${RED}Error: Docker daemon is not running${NC}"
    echo "Please start Docker and try again"
    exit 1
fi

echo -e "${YELLOW}Docker is available${NC}"
echo ""

# Create build directory if it doesn't exist
mkdir -p build

# Build version/timestamp info
BUILD_TIME=$(date -u '+%Y-%m-%d_%H:%M:%S')
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
LDFLAGS="-s -w -X main.BuildTime=${BUILD_TIME} -X main.GitCommit=${GIT_COMMIT}"

# Function to build for a specific ARM platform using cross-compilation
build_arm() {
    local PLATFORM=$1
    local GOARCH=$2
    local GOARM=$3
    local OUTPUT=$4
    local DEBIAN_ARCH=$5
    local CC=$6
    
    echo -e "${YELLOW}Building for ${PLATFORM}...${NC}"
    echo "  Using Debian multiarch approach with ${CC}"
    
    # Use a Debian-based container with cross-compilation tools
    if docker run --rm \
        --platform linux/amd64 \
        -v "$(pwd):/workspace" \
        -w /workspace \
        golang:1.21-bookworm \
        bash -c "
            set -ex
            # Add ARM architecture
            dpkg --add-architecture ${DEBIAN_ARCH}
            
            # Update and install cross-compilation tools
            apt-get update
            apt-get install -y \
                crossbuild-essential-${DEBIAN_ARCH} \
                portaudio19-dev:${DEBIAN_ARCH} \
                libsamplerate0-dev:${DEBIAN_ARCH} \
                pkg-config
            
            # Set up pkg-config for cross-compilation
            export PKG_CONFIG_PATH=/usr/lib/${CC%-gcc}/pkgconfig
            export PKG_CONFIG_LIBDIR=/usr/lib/${CC%-gcc}/pkgconfig
            
            # Set C++ compiler as well
            CXX=\${CC/gcc/g++}
            
            # Build with cross-compilation
            CGO_ENABLED=1 \
            GOOS=linux \
            GOARCH=${GOARCH} \
            ${GOARM:+GOARM=${GOARM}} \
            CC=${CC} \
            CXX=\${CXX} \
            CGO_CXXFLAGS=\"-std=c++11\" \
            go build -tags cgo -ldflags='${LDFLAGS}' -o build/${OUTPUT}
        " 2>&1; then
        
        echo -e "${GREEN}  ✓ Successfully built: build/${OUTPUT}${NC}"
        
        # Display file size
        if [ -f "build/${OUTPUT}" ]; then
            SIZE=$(ls -lh "build/${OUTPUT}" | awk '{print $5}')
            echo -e "${GREEN}    Size: ${SIZE}${NC}"
        fi
        echo ""
        return 0
    else
        echo -e "${RED}  ✗ Failed to build for ${PLATFORM}${NC}"
        echo ""
        return 1
    fi
}

# Build counters
SUCCESS_COUNT=0
FAIL_COUNT=0

# Build for ARM32 (ARMv7 - Raspberry Pi 2+)
if build_arm "ARM32 (ARMv7)" "arm" "7" "radio_client-linux-arm32" "armhf" "arm-linux-gnueabihf-gcc"; then
    ((SUCCESS_COUNT++))
else
    ((FAIL_COUNT++))
fi

# Build for ARM64
if build_arm "ARM64" "arm64" "" "radio_client-linux-arm64" "arm64" "aarch64-linux-gnu-gcc"; then
    ((SUCCESS_COUNT++))
else
    ((FAIL_COUNT++))
fi

# Summary
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Build Summary${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Successful builds: ${SUCCESS_COUNT}${NC}"
if [ $FAIL_COUNT -gt 0 ]; then
    echo -e "${RED}Failed builds: ${FAIL_COUNT}${NC}"
fi
echo ""

if [ $SUCCESS_COUNT -gt 0 ]; then
    echo -e "${GREEN}Built binaries are in the 'build/' directory:${NC}"
    ls -lh build/radio_client-linux-arm* 2>/dev/null || echo "No ARM binaries found"
    echo ""
    
    echo -e "${GREEN}Usage examples:${NC}"
    echo "  Raspberry Pi (ARM32): ./build/radio_client-linux-arm32 --api"
    echo "  Raspberry Pi (ARM64): ./build/radio_client-linux-arm64 --api"
    echo ""
    echo -e "${GREEN}Transfer to Raspberry Pi:${NC}"
    echo "  scp build/radio_client-linux-arm32 pi@raspberrypi.local:~/"
    echo "  scp build/radio_client-linux-arm64 pi@raspberrypi.local:~/"
    echo ""
    echo -e "${YELLOW}Note:${NC} Binaries are built with PortAudio and libsamplerate support"
    echo "      Make sure these libraries are installed on the target Raspberry Pi:"
    echo "      sudo apt install portaudio19-dev libsamplerate0-dev"
else
    echo -e "${RED}✗ All builds failed${NC}"
    exit 1
fi