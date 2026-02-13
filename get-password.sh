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

# Check if password is still the default value
if [ "$PASSWORD" = "mypassword" ]; then
    echo "WARNING: The password is still set to the default 'mypassword'!" >&2
    echo "This indicates something went wrong during installation." >&2
    echo "" >&2
    echo "To fix this:" >&2
    echo "1. Edit the following file:" >&2
    echo "   $CONFIG_PATH" >&2
    echo "" >&2
    echo "2. Find the 'admin:' section and update the password field:" >&2
    echo "   admin:" >&2
    echo "     wizard: false" >&2
    echo "     password: \"your-new-password-here\"" >&2
    echo "" >&2
    echo "3. Run the install script again to apply the changes" >&2
    echo "" >&2
    exit 1
fi
