#!/bin/bash

# Script to restart UberSDR Docker containers
UBERSDR_DIR="$HOME/ubersdr"

echo "Restarting UberSDR..."

# Check if directory exists
if [ ! -d "$UBERSDR_DIR" ]; then
    echo "Error: UberSDR directory not found at $UBERSDR_DIR" >&2
    exit 1
fi

# Change to ubersdr directory and restart containers
cd "$UBERSDR_DIR" || exit 1

echo "Stopping containers..."
docker compose down

echo "Starting containers..."
docker compose up -d

echo "UberSDR restarted successfully!"
