#!/bin/bash

# Script to start UberSDR Docker containers
UBERSDR_DIR="$HOME/ubersdr"

echo "Starting UberSDR..."

# Check if directory exists
if [ ! -d "$UBERSDR_DIR" ]; then
    echo "Error: UberSDR directory not found at $UBERSDR_DIR" >&2
    exit 1
fi

# Change to ubersdr directory and start containers
cd "$UBERSDR_DIR" || exit 1

echo "Starting containers..."
docker compose up -d

echo "UberSDR started successfully!"
