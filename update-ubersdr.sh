#!/bin/bash

# Script to update UberSDR by running the latest install-hub.sh from GitHub

# Prevent running with sudo (breaks $HOME detection); native root is allowed
if [ -n "$SUDO_USER" ]; then
    echo "Error: Do not run this script with sudo. Run it directly as your user:" >&2
    echo "  bash update-ubersdr.sh" >&2
    exit 1
fi

echo "Updating UberSDR..."

# Run the install script from GitHub
curl -fsSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/main/install-hub.sh | bash -s --

echo "UberSDR update completed!"
