#!/bin/bash
set -e

# Working directory is /app (CWD where ka9q_ubersdr expects config files)

# Function to initialize config files from examples if they don't exist
initialize_configs() {
    echo "Checking configuration files in /app..."
    
    # Copy example configs if they don't exist in CWD
    if [ ! -f "/app/config.yaml" ]; then
        echo "Initializing config.yaml from example..."
        cp /app/config.yaml.example /app/config.yaml
    fi
    
    if [ ! -f "/app/bands.yaml" ]; then
        echo "Initializing bands.yaml from example..."
        cp /app/bands.yaml.example /app/bands.yaml
    fi
    
    if [ ! -f "/app/bookmarks.yaml" ]; then
        echo "Initializing bookmarks.yaml from example..."
        cp /app/bookmarks.yaml.example /app/bookmarks.yaml
    fi
}

# Function to update admin password in config.yaml
update_admin_password() {
    if [ -n "$ADMIN_PASSWORD" ]; then
        echo "Updating admin password in config file..."
        sed -i "s/password:.*/password: \"$ADMIN_PASSWORD\"/" /app/config.yaml
        echo "Admin password updated successfully"
    fi
}

# Function to fix Docker networking settings in config.yaml
fix_docker_networking() {
    echo "Configuring for Docker networking..."
    
    # Fix interface to listen on all interfaces
    sed -i 's/interface: "lo"/interface: ""/' /app/config.yaml
    
    # Update multicast addresses to use container hostname
    sed -i 's|status_group: "hf-status.local:5006"|status_group: "ka9q_radiod:5006"|' /app/config.yaml
    sed -i 's|data_group: "pcm.local:5004"|data_group: "ka9q_radiod:5004"|' /app/config.yaml
    
    echo "Docker networking configuration applied"
}

# Initialize configuration files
initialize_configs

# Apply Docker networking fixes and admin password
if [ -f "/app/config.yaml" ]; then
    fix_docker_networking
    update_admin_password
else
    echo "Warning: Config file not found at /app/config.yaml"
fi

# Execute the main command
exec "$@"