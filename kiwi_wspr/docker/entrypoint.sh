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
        echo ""
        echo "=========================================="
        echo "IMPORTANT: Please configure your KiwiSDR instances!"
        echo "Edit /app/data/config.yaml with your settings:"
        echo "  - KiwiSDR host/port/credentials"
        echo "  - WSPR bands to monitor"
        echo "  - MQTT broker settings (if using)"
        echo "=========================================="
        echo ""
    else
        # Merge missing keys from example into existing config
        merge_config_keys "/app/data/config.yaml" "/app/config.yaml.example" "config.yaml"
    fi
}

# Function to update wsprd path in config if needed
update_wsprd_path() {
    local config_file="/app/data/config.yaml"
    
    if [ -f "$config_file" ]; then
        # Get the wsprd path from system
        local wsprd_path=$(which wsprd 2>/dev/null || echo "/usr/bin/wsprd")
        
        # Check if wsprd exists
        if [ -x "$wsprd_path" ]; then
            echo "Found wsprd at: $wsprd_path"
            
            # Update the config file with the correct wsprd path
            local current_path=$(yq eval '.decoder.wsprd_path' "$config_file" 2>/dev/null || echo "")
            
            if [ "$current_path" != "$wsprd_path" ]; then
                echo "Updating wsprd_path in config to: $wsprd_path"
                yq eval ".decoder.wsprd_path = \"$wsprd_path\"" -i "$config_file"
                echo "✓ wsprd_path updated"
            else
                echo "✓ wsprd_path already correct"
            fi
        else
            echo "⚠ Warning: wsprd not found in system PATH"
        fi
    fi
}

# Function to ensure work directory exists
ensure_work_dir() {
    local config_file="/app/data/config.yaml"
    
    if [ -f "$config_file" ]; then
        # Get work_dir from config
        local work_dir=$(yq eval '.decoder.work_dir' "$config_file" 2>/dev/null || echo "/dev/shm/kiwi_wspr")
        
        # Ensure work directory exists
        echo "Ensuring work directory exists: $work_dir"
        mkdir -p "$work_dir"
        echo "✓ work_dir ready: $work_dir"
    fi
}

# Function to ensure CTY database is accessible
ensure_cty_database() {
    # Create symlink to cty directory in data directory if it doesn't exist
    if [ ! -e "/app/data/cty" ]; then
        echo "Creating symlink to CTY database..."
        ln -s /app/cty /app/data/cty
        echo "✓ CTY database linked"
    fi
}

# Function to ensure static files are accessible
ensure_static_files() {
    # Create symlink to static directory in data directory if it doesn't exist
    if [ ! -e "/app/data/static" ]; then
        echo "Creating symlink to static files..."
        ln -s /app/static /app/data/static
        echo "✓ Static files linked"
    fi
}

# Initialize configuration file
initialize_config

# Ensure CTY database is accessible
ensure_cty_database

# Ensure static files are accessible
ensure_static_files

# Apply wsprd path and ensure work directory exists
if [ -f "/app/data/config.yaml" ]; then
    update_wsprd_path
    ensure_work_dir
else
    echo "Warning: Config file not found at /app/data/config.yaml"
fi

# Verify wsprd is accessible
echo "Verifying wsprd installation..."
if command -v wsprd &> /dev/null; then
    wsprd --help 2>&1 | head -n 1 || echo "wsprd is installed"
    echo "✓ wsprd is available"
else
    echo "⚠ Warning: wsprd command not found"
fi

# Change to data directory so relative paths in config work correctly
cd /app/data

# Execute the application with the config file (now using relative path since we're in /app/data)
exec /app/kiwi_wspr --config config.yaml --web-port 8080 "$@"
