#!/bin/bash

# Script to stop UberSDR Docker containers
UBERSDR_DIR="$HOME/ubersdr"

echo "Stopping UberSDR..."

# Check if directory exists
if [ ! -d "$UBERSDR_DIR" ]; then
    echo "Error: UberSDR directory not found at $UBERSDR_DIR" >&2
    exit 1
fi

# Change to ubersdr directory and stop containers
cd "$UBERSDR_DIR" || exit 1

echo "Stopping containers..."
docker compose down

echo "UberSDR stopped successfully!"
