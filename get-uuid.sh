#!/bin/bash

# Script to extract instance UUID from UberSDR config
CONFIG_PATH="/var/lib/docker/volumes/ubersdr_ubersdr-config/_data/config.yaml"

# Check if config file exists (using sudo since it's in a protected directory)
if ! sudo test -f "$CONFIG_PATH"; then
    echo "Error: Config file not found at $CONFIG_PATH" >&2
    exit 1
fi

# Extract instance_uuid by walking the full instance_reporting: block
UUID=$(sudo awk '
    /^instance_reporting:/  { in_block=1; next }
    in_block && /^[^ \t]/   { in_block=0 }
    in_block && /[ \t]instance_uuid:/ {
        val = $0
        sub(/.*instance_uuid: *"?/, "", val)
        sub(/".*/, "", val)
        sub(/#.*/, "", val)
        gsub(/[[:space:]]+$/, "", val)
        print val
        exit
    }
' "$CONFIG_PATH")

if [ -z "$UUID" ]; then
    echo "Error: Could not extract instance_uuid from config file" >&2
    exit 1
fi

echo "$UUID"
