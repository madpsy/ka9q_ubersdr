#!/bin/bash

# Script to update UberSDR by running the latest install-hub.sh from GitHub
echo "Updating UberSDR..."

# Run the install script from GitHub
curl -fsSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/main/install-hub.sh | bash -s --

echo "UberSDR update completed!"
