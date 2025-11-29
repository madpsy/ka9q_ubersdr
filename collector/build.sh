#!/bin/bash
set -e

# UberSDR Instance Collector Build Script

echo "Building UberSDR Instance Collector..."

# Get version from main.go
VERSION=$(grep 'const Version' main.go | cut -d'"' -f2)
echo "Version: $VERSION"

# Download dependencies
echo "Downloading dependencies..."
go mod download

# Tidy go.mod and go.sum
echo "Tidying dependencies..."
go mod tidy

# Build for current platform
echo "Building for current platform..."
CGO_ENABLED=1 go build -ldflags "-s -w" -o collector

echo ""
echo "Build complete: ./collector"
echo ""
echo "To build for other platforms (requires appropriate C compiler):"
echo "  Linux AMD64:   CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -o collector-linux-amd64"
echo "  Linux ARM64:   CGO_ENABLED=1 GOOS=linux GOARCH=arm64 go build -o collector-linux-arm64"
echo "  macOS AMD64:   CGO_ENABLED=1 GOOS=darwin GOARCH=amd64 go build -o collector-darwin-amd64"
echo "  macOS ARM64:   CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 go build -o collector-darwin-arm64"
echo "  Windows AMD64: CGO_ENABLED=1 GOOS=windows GOARCH=amd64 CC=x86_64-w64-mingw32-gcc go build -o collector-windows-amd64.exe"
echo ""
echo "Note: Cross-compilation with CGO requires appropriate C cross-compilers installed."
echo "For easier cross-platform builds, consider using Docker multi-stage builds."