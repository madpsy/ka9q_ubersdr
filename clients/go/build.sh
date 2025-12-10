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

# Check for PortAudio (optional, just a warning)
echo -e "${YELLOW}Checking for PortAudio...${NC}"
if pkg-config --exists portaudio-2.0 2>/dev/null; then
    echo -e "${GREEN}✓ PortAudio found${NC}"
elif [ -f "/usr/local/lib/libportaudio.dylib" ] || [ -f "/usr/local/lib/libportaudio.so" ]; then
    echo -e "${GREEN}✓ PortAudio found${NC}"
else
    echo -e "${YELLOW}⚠ PortAudio not detected${NC}"
    echo "  Audio output may not work. Install PortAudio:"
    echo "  - Linux: sudo apt install portaudio19-dev"
    echo "  - macOS: brew install portaudio"
    echo "  - Windows: Usually bundled with Go bindings"
fi
echo ""

# Clean previous builds
echo -e "${YELLOW}Cleaning previous builds...${NC}"
rm -f radio_client radio_client.exe
echo ""

# Download dependencies
echo -e "${YELLOW}Downloading dependencies...${NC}"
go mod download
echo ""

# Tidy up go.mod and go.sum
echo -e "${YELLOW}Tidying dependencies...${NC}"
go mod tidy
echo ""

# Build the binary
echo -e "${YELLOW}Building binary...${NC}"
if go build -o radio_client; then
    echo -e "${GREEN}✓ Build successful!${NC}"
    echo ""
    
    # Make executable (Unix-like systems)
    if [ "$(uname)" != "Windows_NT" ]; then
        chmod +x radio_client
    fi
    
    # Display binary info
    echo -e "${GREEN}Binary created:${NC}"
    ls -lh radio_client 2>/dev/null || dir radio_client 2>/dev/null
    echo ""
    
    # Display usage
    echo -e "${GREEN}Usage:${NC}"
    echo "  API Mode (with web interface):"
    echo "    ./radio_client --api"
    echo ""
    echo "  CLI Mode:"
    echo "    ./radio_client -f 14074000 -m usb"
    echo ""
    echo "  Help:"
    echo "    ./radio_client -h"
    echo ""
    echo -e "${GREEN}Web interface will be available at:${NC} http://localhost:8090"
    
else
    echo -e "${RED}✗ Build failed${NC}"
    exit 1
fi