#!/bin/bash
set -e

# Working directory is /app (CWD where ka9q_ubersdr expects config files)

# Function to initialize config files from examples if they don't exist
initialize_configs() {
    echo "Checking configuration files in /app..."
    
    # Copy example configs from /etc/ka9q_ubersdr if they don't exist in /app
    if [ ! -f "/app/config.yaml" ]; then
        echo "Initializing config.yaml from example..."
        cp /etc/ka9q_ubersdr/config.yaml.example /app/config.yaml
    fi
    
    if [ ! -f "/app/bands.yaml" ]; then
        echo "Initializing bands.yaml from example..."
        cp /etc/ka9q_ubersdr/bands.yaml.example /app/bands.yaml
    fi
    
    if [ ! -f "/app/bookmarks.yaml" ]; then
        echo "Initializing bookmarks.yaml from example..."
        cp /etc/ka9q_ubersdr/bookmarks.yaml.example /app/bookmarks.yaml
    fi
    
    if [ ! -f "/app/extensions.yaml" ]; then
        echo "Initializing extensions.yaml from example..."
        cp /etc/ka9q_ubersdr/extensions.yaml.example /app/extensions.yaml
    fi
}

# Function to update admin password in config.yaml
update_admin_password() {
    if [ -n "$ADMIN_PASSWORD" ]; then
        echo "ADMIN_PASSWORD environment variable detected"
        echo "Updating admin password in config file..."
        sed -i "s/password:.*/password: \"$ADMIN_PASSWORD\"/" /app/config.yaml
        echo "Admin password updated successfully"
    else
        echo "No ADMIN_PASSWORD environment variable set, generating random password"
        # Generate a random password to avoid security error
        RANDOM_PASSWORD=$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 16)
        sed -i "s/password:.*/password: \"$RANDOM_PASSWORD\"/" /app/config.yaml
        echo "Generated random admin password (set ADMIN_PASSWORD env var to use custom password)"
    fi
}

# Function to detect the appropriate network interface for multicast
detect_bridge_interface() {
    # With bridge networking, container has eth0 as the primary interface
    # This is the Docker bridge network interface
    local iface="eth0"
    
    if ip addr show eth0 2>/dev/null | grep -q "inet "; then
        echo "Detected bridge interface: $iface" >&2
    else
        # Fallback: find first non-loopback interface with an IP address
        iface=$(ip -o addr show | grep -v "lo:" | grep "inet " | head -1 | awk '{print $2}')
        if [ -n "$iface" ]; then
            echo "Detected interface with IP: $iface" >&2
        else
            # Last resort: use empty (all interfaces)
            iface=""
            echo "Warning: Could not detect specific interface, will use all interfaces" >&2
        fi
    fi
    
    echo "$iface"
}

# Function to fix Docker networking settings in config.yaml
fix_docker_networking() {
    echo "Configuring for Docker bridge networking..."
    
    # Detect the bridge interface (should be eth0 in bridge mode)
    local bridge_iface=$(detect_bridge_interface)
    
    if [ -n "$bridge_iface" ]; then
        echo "Using bridge interface: $bridge_iface"
        # Set the interface in config - match any existing interface value
        sed -i "s/interface: \".*\"/interface: \"$bridge_iface\"/" /app/config.yaml
        
        # Enable allmulticast on the interface
        echo "Enabling allmulticast on $bridge_iface..."
        ip link set $bridge_iface allmulticast on 2>/dev/null || echo "Warning: Could not enable allmulticast (may already be enabled)"
        
        # Add multicast route for 239.0.0.0/8 (administratively scoped multicast)
        echo "Adding multicast route..."
        ip route add 239.0.0.0/8 dev $bridge_iface 2>/dev/null || echo "Multicast route already exists"
    else
        echo "Using all interfaces for multicast"
        # Fix interface to listen on all interfaces
        sed -i 's/interface: ".*"/interface: ""/' /app/config.yaml
    fi
    
    echo "Docker bridge networking configuration applied"
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