#!/bin/bash
# Build script for KiwiSDR WSPR Decoder Docker image

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Building KiwiSDR WSPR Decoder Docker image...${NC}"

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Change to project directory
cd "$PROJECT_DIR"

# Build the image
echo -e "${YELLOW}Building image from: $PROJECT_DIR${NC}"
docker build -f docker/Dockerfile -t kiwi-wspr:latest .

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Build successful!${NC}"
    echo ""
    echo "Image: kiwi-wspr:latest"
    echo ""
    echo "To run the container:"
    echo "  cd docker && docker-compose up -d"
    echo ""
    echo "Or run directly:"
    echo "  docker run -d -p 8080:8080 -v kiwi-wspr-data:/app/data kiwi-wspr:latest"
else
    echo -e "${RED}✗ Build failed${NC}"
    exit 1
fi
