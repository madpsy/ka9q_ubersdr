#!/bin/bash

# Script to extract admin password from UberSDR config
#
# Usage:
#   get-password.sh            Human-readable output (password, admin URL, warnings)
#   get-password.sh --short    Print only the raw password to stdout (for scripting,
#                              e.g. curl -H "X-Admin-Password: $(get-password.sh --short)")
CONFIG_PATH="/var/lib/docker/volumes/ubersdr_ubersdr-config/_data/config.yaml"

SHORT=0
case "${1:-}" in
    --short|-s) SHORT=1 ;;
    "")         ;;
    *) echo "Unknown option: $1" >&2; echo "Usage: $0 [--short]" >&2; exit 2 ;;
esac

# Check if config file exists (using sudo since it's in a protected directory)
if ! sudo test -f "$CONFIG_PATH"; then
    echo "Error: Config file not found at $CONFIG_PATH" >&2
    exit 1
fi

# Extract password by walking the full admin: block (password may appear at any line within it)
PASSWORD=$(sudo awk '
    /^admin:/              { in_admin=1; next }
    in_admin && /^[^ \t]/ { in_admin=0 }
    in_admin && /[ \t]password:/ {
        val = $0
        sub(/^[^:]*:[[:space:]]*/, "", val)
        gsub(/^"|"$/, "", val)
        gsub(/[[:space:]#].*$/, "", val)
        print val
        exit
    }
' "$CONFIG_PATH")

if [ -z "$PASSWORD" ]; then
    echo "Error: Could not extract password from config file" >&2
    exit 1
fi

# Short mode: emit only the raw password (no banner). The default-value check
# is still surfaced on stderr, but we exit 0 so callers always capture the value.
if [ "$SHORT" -eq 1 ]; then
    printf '%s\n' "$PASSWORD"
    if [ "$PASSWORD" = "mypassword" ]; then
        echo "WARNING: admin password is still the default 'mypassword'." >&2
    fi
    exit 0
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
    echo "3. Run ~/ubersdr/restart-ubersdr.sh to apply the changes" >&2
    echo "" >&2
    exit 1
fi
