#!/bin/bash

# WSPR MQTT Aggregator Build Script

set -e

echo "Building WSPR MQTT Aggregator..."

# Get version from main.go or use default
VERSION="1.0.0"

# Download dependencies
echo "Downloading dependencies..."
go mod download

# Tidy up go.mod and go.sum
echo "Tidying dependencies..."
go mod tidy

# Build for current platform
echo "Building for current platform..."
go build -ldflags "-X main.Version=${VERSION}" -o wsprnet_mqtt

echo ""
echo "Build complete: wsprnet_mqtt"
echo ""
echo "To run:"
echo "  ./wsprnet_mqtt -config config.yaml"
echo ""
echo "To build for other platforms:"
echo "  Linux:   GOOS=linux GOARCH=amd64 go build -o wsprnet_mqtt-linux-amd64"
echo "  Windows: GOOS=windows GOARCH=amd64 go build -o wsprnet_mqtt-windows-amd64.exe"
echo "  macOS:   GOOS=darwin GOARCH=amd64 go build -o wsprnet_mqtt-darwin-amd64"