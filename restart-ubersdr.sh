#!/bin/bash

# Script to restart UberSDR Docker containers

# Prevent running with sudo (breaks $HOME detection); native root is allowed
if [ -n "$SUDO_USER" ]; then
    echo "Error: Do not run this script with sudo. Run it directly as your user:" >&2
    echo "  bash restart-ubersdr.sh" >&2
    exit 1
fi

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
