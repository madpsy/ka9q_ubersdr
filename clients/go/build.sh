#!/bin/bash
# Build script for UberSDR Go Client

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Building UberSDR Go Client...${NC}"
echo ""

# Check if Go is installed
if ! command -v go &> /dev/null; then
    echo -e "${RED}Error: Go is not installed${NC}"
    echo "Please install Go from https://golang.org/dl/"
    exit 1
fi

# Display Go version
echo -e "${YELLOW}Go version:${NC}"
go version
echo ""

# Check for required dependencies
echo -e "${YELLOW}Checking for required dependencies...${NC}"

# Check for PortAudio (required)
if ! pkg-config --exists portaudio-2.0 2>/dev/null; then
    if [ ! -f "/usr/local/lib/libportaudio.dylib" ] && [ ! -f "/usr/local/lib/libportaudio.so" ]; then
        echo -e "${RED}✗ PortAudio not found (required)${NC}"
        echo "  Install PortAudio:"
        echo "  - Linux: sudo apt install portaudio19-dev"
        echo "  - macOS: brew install portaudio"
        echo "  - Windows: Usually bundled with Go bindings"
        exit 1
    fi
fi
echo -e "${GREEN}✓ PortAudio found${NC}"

# Check for libsamplerate (required)
if ! pkg-config --exists samplerate 2>/dev/null; then
    echo -e "${RED}✗ libsamplerate not found (required)${NC}"
    echo "  Install libsamplerate:"
    echo "  - Linux: sudo apt install libsamplerate0-dev"
    echo "  - macOS: brew install libsamplerate"
    echo "  - Windows: pacman -S mingw-w64-x86_64-libsamplerate (MSYS2)"
    exit 1
fi
echo -e "${GREEN}✓ libsamplerate found${NC}"
echo ""

# Clean previous builds
echo -e "${YELLOW}Cleaning previous builds...${NC}"
rm -f radio_client radio_client.exe
rm -rf build/*
echo ""

# Download dependencies
echo -e "${YELLOW}Downloading dependencies...${NC}"
go mod download
echo ""

# Tidy up go.mod and go.sum
echo -e "${YELLOW}Tidying dependencies...${NC}"
go mod tidy
echo ""

# Build the binaries for multiple platforms
echo -e "${YELLOW}Building binaries for multiple platforms...${NC}"
echo ""

# Note about CGo requirement
echo "  Note: This application requires CGo for PortAudio and libsamplerate"
echo "  Cross-compilation will require appropriate C toolchains for each target platform"
echo ""

# Enable CGo (required for PortAudio and libsamplerate)
export CGO_ENABLED=1

# Build with libsamplerate support
BUILD_TAGS="-tags cgo"

# Build version/timestamp info
BUILD_TIME=$(date -u '+%Y-%m-%d_%H:%M:%S')
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
LDFLAGS="-s -w -X main.BuildTime=${BUILD_TIME} -X main.GitCommit=${GIT_COMMIT}"

# Array of platforms to build for
declare -a platforms=(
    "linux/amd64/radio_client-linux-amd64"
    "linux/arm/radio_client-linux-arm32"
    "linux/arm64/radio_client-linux-arm64"
    "windows/amd64/radio_client-windows-amd64.exe"
    "darwin/amd64/radio_client-macos-amd64"
    "darwin/arm64/radio_client-macos-arm64"
)

echo "  Attempting to build for all platforms..."
echo "  Note: Some builds may fail if cross-compilation toolchains are not available"
echo ""

# Build counter
SUCCESS_COUNT=0
FAIL_COUNT=0

# Build for each platform
for platform in "${platforms[@]}"; do
    IFS='/' read -r GOOS GOARCH OUTPUT <<< "$platform"

    echo -e "${YELLOW}Building for ${GOOS}/${GOARCH}...${NC}"

    # Set environment variables for cross-compilation
    export GOOS=$GOOS
    export GOARCH=$GOARCH

    # Special handling for ARM32
    if [ "$GOARCH" = "arm" ]; then
        export GOARM=7  # ARMv7 (Raspberry Pi 2+)
    fi

    # Build the binary
    if go build ${BUILD_TAGS} -ldflags="${LDFLAGS}" -o "build/${OUTPUT}"; then
        echo -e "${GREEN}  ✓ Successfully built: build/${OUTPUT}${NC}"

        # Display file size
        if [ -f "build/${OUTPUT}" ]; then
            SIZE=$(ls -lh "build/${OUTPUT}" | awk '{print $5}')
            echo -e "${GREEN}    Size: ${SIZE}${NC}"
        fi

        ((SUCCESS_COUNT++))
    else
        echo -e "${RED}  ✗ Failed to build for ${GOOS}/${GOARCH}${NC}"
        ((FAIL_COUNT++))
    fi
    echo ""
done

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
    ls -lh build/ 2>/dev/null
    echo ""

    echo -e "${GREEN}Usage examples:${NC}"
    echo "  Linux (x86_64):   ./build/radio_client-linux-amd64 --api"
    echo "  Linux (ARM32):    ./build/radio_client-linux-arm32 --api"
    echo "  Linux (ARM64):    ./build/radio_client-linux-arm64 --api"
    echo "  Windows:          build\\radio_client-windows-amd64.exe --api"
    echo "  macOS (Intel):    ./build/radio_client-macos-amd64 --api"
    echo "  macOS (Apple Silicon): ./build/radio_client-macos-arm64 --api"
    echo ""
    echo -e "${GREEN}CLI Mode example:${NC}"
    echo "  ./build/radio_client-linux-amd64 -f 14074000 -m usb"
    echo ""
    echo -e "${GREEN}Web interface will be available at:${NC} http://localhost:8090"
    echo ""
    echo -e "${YELLOW}Note:${NC} Binaries are built with PortAudio and libsamplerate support"
else
    echo -e "${RED}✗ All builds failed${NC}"
    exit 1
fi