#!/bin/bash
set -e

# Working directory is /app
# Config file is in /app/config.json (mounted as a volume or created from example)
# Database is in /app/data (mounted as a volume)

# Function to initialize config file from example if it doesn't exist
initialize_config() {
    echo "Checking configuration file..."
    
    if [ ! -f "/app/config.json" ]; then
        echo "Initializing config.json from example..."
        cp /etc/collector/config.json.example /app/config.json
        echo "✓ config.json created"
    else
        echo "✓ config.json exists"
    fi
}

# Initialize configuration
initialize_config

# Ensure data directory exists
mkdir -p /app/data

# If the command is collector, add the appropriate flags
if [ "$1" = "collector" ]; then
    shift
    exec collector -config /app/config.json -db /app/data/instances.db "$@"
else
    # Execute the command as-is
    exec "$@"
fi