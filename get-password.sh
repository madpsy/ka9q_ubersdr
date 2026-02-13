#!/bin/bash

# Script to extract admin password from UberSDR config
CONFIG_PATH="/var/lib/docker/volumes/ubersdr_ubersdr-config/_data/config.yaml"

# Check if config file exists (using sudo since it's in a protected directory)
if ! sudo test -f "$CONFIG_PATH"; then
    echo "Error: Config file not found at $CONFIG_PATH" >&2
    exit 1
fi

# Extract password using grep and sed
# This looks for the password line under the admin section and extracts the value
PASSWORD=$(sudo grep -A 2 "^admin:" "$CONFIG_PATH" | grep "password:" | sed 's/.*password: *"\(.*\)".*/\1/')

if [ -z "$PASSWORD" ]; then
    echo "Error: Could not extract password from config file" >&2
    exit 1
fi

echo ""
echo "Admin Password: $PASSWORD"
echo "Admin URL: http://ubersdr.local:8080/admin.html"
echo ""
