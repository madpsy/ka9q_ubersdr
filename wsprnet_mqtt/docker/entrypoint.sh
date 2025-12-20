#!/bin/bash
set -e

# Working directory is /app
# Config files are in /app/data (mounted as a volume)

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

# Function to initialize config file from example if it doesn't exist
initialize_config() {
    echo "Checking configuration file in /app/data..."

    # Create data directory if it doesn't exist
    mkdir -p /app/data
    
    # Copy example config if it doesn't exist in /app/data
    if [ ! -f "/app/data/config.yaml" ]; then
        echo "Initializing config.yaml from example..."
        cp /app/config.yaml.example /app/data/config.yaml
        echo "✓ config.yaml created from example"
    else
        # Merge missing keys from example into existing config
        merge_config_keys "/app/data/config.yaml" "/app/config.yaml.example" "config.yaml"
    fi
}

# Function to update admin password in config.yaml
update_admin_password() {
    # Read current password from config
    CURRENT_PASSWORD=$(yq eval '.admin_password' /app/data/config.yaml 2>/dev/null || echo "")

    if [ -n "$ADMIN_PASSWORD" ]; then
        # Always use env var if provided
        echo "ADMIN_PASSWORD environment variable detected"
        echo "Updating admin password in config file..."
        yq eval ".admin_password = \"$ADMIN_PASSWORD\"" -i /app/data/config.yaml
        echo "✓ Admin password updated from environment variable"
    elif [ -z "$CURRENT_PASSWORD" ] || [ "$CURRENT_PASSWORD" = "null" ]; then
        # Generate random password if it's empty or null
        echo "No admin password set, generating random password for security..."
        RANDOM_PASSWORD=$(head /dev/urandom | tr -dc A-Za-z0-9\!\@\#\$\%\^\&\* | head -c 16)
        yq eval ".admin_password = \"$RANDOM_PASSWORD\"" -i /app/data/config.yaml
        echo "=========================================="
        echo "Generated random admin password:"
        echo "$RANDOM_PASSWORD"
        echo "=========================================="
        echo "Save this password! You'll need it to access the admin interface."
        echo "(Set ADMIN_PASSWORD env var to use a custom password)"
    else
        # Password has been set, leave it alone
        echo "✓ Admin password already configured"
    fi
}

# Initialize configuration file
initialize_config

# Apply admin password logic
if [ -f "/app/data/config.yaml" ]; then
    update_admin_password
else
    echo "Warning: Config file not found at /app/data/config.yaml"
fi

# Change to data directory so relative paths in config work correctly
cd /app/data

# Execute the application with the config file (now using relative path since we're in /app/data)
exec /app/wsprnet_mqtt -config config.yaml "$@"