#!/bin/bash

# Script to set UberSDR admin password
UBERSDR_DIR="$HOME/ubersdr"

# Get new password from argument or prompt
if [ -n "$1" ]; then
    NEW_PASSWORD="$1"
else
    read -rsp "Enter new admin password: " NEW_PASSWORD
    echo
    read -rsp "Confirm new admin password: " CONFIRM_PASSWORD
    echo
    if [ "$NEW_PASSWORD" != "$CONFIRM_PASSWORD" ]; then
        echo "Error: Passwords do not match" >&2
        exit 1
    fi
fi

# Validate
if [ -z "$NEW_PASSWORD" ]; then
    echo "Error: Password cannot be empty" >&2
    exit 1
fi
if [ "$NEW_PASSWORD" = "mypassword" ]; then
    echo "Error: Cannot use the default password" >&2
    exit 1
fi
if [ "${#NEW_PASSWORD}" -lt 16 ]; then
    echo "Error: Password must be at least 16 characters long" >&2
    exit 1
fi
if ! [[ "$NEW_PASSWORD" =~ [A-Za-z] ]]; then
    echo "Error: Password must contain at least one letter" >&2
    exit 1
fi
if ! [[ "$NEW_PASSWORD" =~ [0-9] ]]; then
    echo "Error: Password must contain at least one number" >&2
    exit 1
fi

# Check directory exists
if [ ! -d "$UBERSDR_DIR" ]; then
    echo "Error: UberSDR directory not found at $UBERSDR_DIR" >&2
    exit 1
fi

# Warn and confirm restart
echo ""
echo "WARNING: This will restart UberSDR to apply the new password."
echo "All active user sessions will be disconnected."
echo ""
read -rp "Are you sure you want to continue? [y/N] " CONFIRM
echo ""
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

echo "Setting admin password and restarting UberSDR..."
cd "$UBERSDR_DIR"

docker compose down
ADMIN_PASSWORD="$NEW_PASSWORD" docker compose up -d

echo ""
echo "Password set successfully."
echo "Access the web interface at: http://ubersdr.local:8080/admin.html"
echo ""
