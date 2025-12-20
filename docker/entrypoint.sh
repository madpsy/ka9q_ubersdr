#!/bin/bash
set -e

# Working directory is /app
# Config files are in /app/config (mounted as a volume)

# Function to merge missing keys from example config into user config
merge_config_keys() {
    local user_config="$1"
    local example_config="$2"
    local config_name="$3"

    if [ -f "$user_config" ] && [ -f "$example_config" ]; then
        echo "Checking $config_name for missing keys..."

        # Create backup with timestamp
        local backup_file="${user_config}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$user_config" "$backup_file"
        echo "Created backup: $backup_file"

        # Merge configs: example provides defaults, user config overrides
        # Using yq's merge operator where example is base and user overrides it
        local temp_file="${user_config}.tmp"
        if yq eval-all '. as $item ireduce ({}; . * $item)' "$example_config" "$user_config" > "$temp_file" 2>/dev/null; then
            # Verify the merged file is valid YAML
            if yq eval '.' "$temp_file" > /dev/null 2>&1; then
                # Check if there are actual differences
                if ! diff -q "$user_config" "$temp_file" > /dev/null 2>&1; then
                    mv "$temp_file" "$user_config"
                    echo "✓ $config_name updated with missing keys from example"
                else
                    rm -f "$temp_file"
                    echo "✓ $config_name is up to date"
                fi
            else
                echo "⚠ Warning: Merged config validation failed, keeping original"
                rm -f "$temp_file"
            fi
        else
            echo "⚠ Warning: Config merge failed for $config_name, keeping original"
            rm -f "$temp_file"
        fi
    fi
}

# Function to initialize config files from examples if they don't exist
initialize_configs() {
    echo "Checking configuration files in /app/config..."

    # Create config directory if it doesn't exist
    mkdir -p /app/config
    
    # Copy example configs from /etc/ka9q_ubersdr if they don't exist in /app/config
    if [ ! -f "/app/config/config.yaml" ]; then
        echo "Initializing config.yaml from example..."
        cp /etc/ka9q_ubersdr/config.yaml.example /app/config/config.yaml
    else
        # Merge missing keys from example into existing config
        merge_config_keys "/app/config/config.yaml" "/etc/ka9q_ubersdr/config.yaml.example" "config.yaml"
    fi
    
    # For array-based configs (bands, bookmarks, extensions), only initialize if missing
    # Don't merge these as they contain user-defined lists that shouldn't be auto-updated
    if [ ! -f "/app/config/bands.yaml" ]; then
        echo "Initializing bands.yaml from example..."
        cp /etc/ka9q_ubersdr/bands.yaml.example /app/config/bands.yaml
    else
        echo "✓ bands.yaml exists (user-managed, not auto-merged)"
    fi

    if [ ! -f "/app/config/bookmarks.yaml" ]; then
        echo "Initializing bookmarks.yaml from example..."
        cp /etc/ka9q_ubersdr/bookmarks.yaml.example /app/config/bookmarks.yaml
    else
        echo "✓ bookmarks.yaml exists (user-managed, not auto-merged)"
    fi

    if [ ! -f "/app/config/extensions.yaml" ]; then
        echo "Initializing extensions.yaml from example..."
        cp /etc/ka9q_ubersdr/extensions.yaml.example /app/config/extensions.yaml
    else
        echo "✓ extensions.yaml exists (user-managed, not auto-merged)"
    fi

    if [ ! -f "/app/config/decoder.yaml" ]; then
        echo "Initializing decoder.yaml from example..."
        cp /etc/ka9q_ubersdr/decoder.yaml.example /app/config/decoder.yaml
    else
        # Merge missing keys from example into existing config (like config.yaml)
        merge_config_keys "/app/config/decoder.yaml" "/etc/ka9q_ubersdr/decoder.yaml.example" "decoder.yaml"
    fi

    if [ ! -f "/app/config/cwskimmer.yaml" ]; then
        echo "Initializing cwskimmer.yaml from example..."
        cp /etc/ka9q_ubersdr/cwskimmer.yaml.example /app/config/cwskimmer.yaml
    else
        # Merge missing keys from example into existing config (like config.yaml)
        merge_config_keys "/app/config/cwskimmer.yaml" "/etc/ka9q_ubersdr/cwskimmer.yaml.example" "cwskimmer.yaml"
    fi

    # Initialize CTY.DAT directory if it doesn't exist
    if [ ! -d "/app/config/cty" ]; then
        echo "Initializing cty directory..."
        mkdir -p /app/config/cty
        if [ -f "/etc/ka9q_ubersdr/cty/cty.dat" ]; then
            cp /etc/ka9q_ubersdr/cty/cty.dat /app/config/cty/cty.dat
            echo "✓ cty.dat copied from image"
        fi
    else
        # Check if cty.dat exists, if not copy from image
        if [ ! -f "/app/config/cty/cty.dat" ] && [ -f "/etc/ka9q_ubersdr/cty/cty.dat" ]; then
            echo "Copying cty.dat from image..."
            cp /etc/ka9q_ubersdr/cty/cty.dat /app/config/cty/cty.dat
            echo "✓ cty.dat copied"
        else
            echo "✓ cty.dat exists"
        fi
    fi
}

# Function to update admin password in config.yaml
update_admin_password() {
    # Read current password from config
    CURRENT_PASSWORD=$(grep "password:" /app/config/config.yaml | sed 's/.*password: *"\?\([^"]*\)"\?.*/\1/')

    if [ -n "$ADMIN_PASSWORD" ]; then
        # Always use env var if provided
        echo "ADMIN_PASSWORD environment variable detected"
        echo "Updating admin password in config file..."
        sed -i "s/password:.*/password: \"$ADMIN_PASSWORD\"/" /app/config/config.yaml
        echo "Admin password updated successfully"
    elif [ "$CURRENT_PASSWORD" = "mypassword" ] || [ -z "$CURRENT_PASSWORD" ]; then
        # Only generate random password if it's still the default or empty
        echo "Default password detected, generating random password for security"
        RANDOM_PASSWORD=$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 16)
        sed -i "s/password:.*/password: \"$RANDOM_PASSWORD\"/" /app/config/config.yaml
        echo "Generated random admin password: $RANDOM_PASSWORD"
        echo "(Set ADMIN_PASSWORD env var to use a custom password)"
    else
        # Password has been manually changed, leave it alone
        echo "Custom password detected in config, leaving unchanged"
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
        sed -i "s/interface: \".*\"/interface: \"$bridge_iface\"/" /app/config/config.yaml
        
        # Enable allmulticast on the interface
        echo "Enabling allmulticast on $bridge_iface..."
        ip link set $bridge_iface allmulticast on 2>/dev/null || echo "Warning: Could not enable allmulticast (may already be enabled)"
        
        # Add multicast route for 239.0.0.0/8 (administratively scoped multicast)
        echo "Adding multicast route..."
        ip route add 239.0.0.0/8 dev $bridge_iface 2>/dev/null || echo "Multicast route already exists"
    else
        echo "Using all interfaces for multicast"
        # Fix interface to listen on all interfaces
        sed -i 's/interface: ".*"/interface: ""/' /app/config/config.yaml
    fi
    
    echo "Docker bridge networking configuration applied"
}

# Initialize configuration files
initialize_configs

# Apply Docker networking fixes and admin password
if [ -f "/app/config/config.yaml" ]; then
    fix_docker_networking
    update_admin_password
else
    echo "Warning: Config file not found at /app/config/config.yaml"
fi

# Trigger radiod restart on ubersdr startup
if [ "$1" = "ka9q_ubersdr" ]; then
    echo "Triggering radiod restart..."
    mkdir -p /var/run/restart-trigger
    touch /var/run/restart-trigger/restart
    echo "Waiting 5 seconds for radiod to restart..."
    sleep 5
fi

# If the command is ka9q_ubersdr, add the -config-dir flag
if [ "$1" = "ka9q_ubersdr" ]; then
    shift
    exec ka9q_ubersdr -config-dir /app/config "$@"
else
    # Execute the command as-is
    exec "$@"
fi