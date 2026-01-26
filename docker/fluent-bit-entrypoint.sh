#!/bin/sh
set -e

CONFIG_FILE="/app/config/config.yaml"
FLUENT_BIT_CONF="/fluent-bit/etc/fluent-bit.conf"
FLUENT_BIT_PID=""

# Function to check if remote_logging is enabled
check_remote_logging() {
    if [ -f "$CONFIG_FILE" ]; then
        REMOTE_LOGGING=$(grep -A 10 "instance_reporting:" "$CONFIG_FILE" | \
                         grep "remote_logging:" | \
                         sed 's/.*remote_logging: *\(.*\)/\1/')
        
        if [ "$REMOTE_LOGGING" = "false" ]; then
            echo "false"
        else
            echo "true"
        fi
    else
        echo "true"  # Default to enabled if config not found
    fi
}

# Function to extract UUID
get_uuid() {
    if [ -f "$CONFIG_FILE" ]; then
        grep -A 1 "instance_reporting:" "$CONFIG_FILE" | \
        grep "instance_uuid:" | \
        sed 's/.*instance_uuid: *"\(.*\)".*/\1/'
    fi
}

# Function to extract hostname
get_hostname() {
    if [ -f "$CONFIG_FILE" ]; then
        grep -A 1 "instance_reporting:" "$CONFIG_FILE" | \
        grep "hostname:" | \
        sed 's/.*hostname: *"\(.*\)".*/\1/'
    fi
}

# Function to extract port
get_port() {
    if [ -f "$CONFIG_FILE" ]; then
        PORT=$(grep -A 10 "instance_reporting:" "$CONFIG_FILE" | \
              grep "port:" | \
              head -1 | \
              sed 's/.*port: *\([0-9]*\).*/\1/')
        if [ -z "$PORT" ]; then
            echo "443"
        else
            echo "$PORT"
        fi
    else
        echo "443"
    fi
}

# Function to extract use_https
get_use_https() {
    if [ -f "$CONFIG_FILE" ]; then
        USE_HTTPS=$(grep -A 10 "instance_reporting:" "$CONFIG_FILE" | \
                   grep "use_https:" | \
                   sed 's/.*use_https: *\(.*\)/\1/')
        
        if [ "$USE_HTTPS" = "false" ]; then
            echo "Off"
        else
            echo "On"
        fi
    else
        echo "On"
    fi
}

# Function to start Fluent Bit
start_fluent_bit() {
    # Wait for UUID to be generated (max 60 seconds)
    echo "Waiting for instance UUID to be generated..."
    for i in $(seq 1 60); do
        INSTANCE_UUID=$(get_uuid)
        
        if [ -n "$INSTANCE_UUID" ] && [ "$INSTANCE_UUID" != '""' ] && [ "$INSTANCE_UUID" != "" ]; then
            echo "Found instance UUID: $INSTANCE_UUID"
            export INSTANCE_SECRET_UUID="$INSTANCE_UUID"
            break
        fi
        
        echo "UUID not ready yet, waiting... ($i/60)"
        sleep 1
    done

    if [ -z "$INSTANCE_SECRET_UUID" ]; then
        echo "ERROR: Failed to get instance UUID after 60 seconds"
        return 1
    fi

    # Extract hostname from config
    HOSTNAME=$(get_hostname)
    if [ -z "$HOSTNAME" ]; then
        echo "ERROR: Failed to get hostname from config"
        return 1
    fi
    export COLLECTOR_HOSTNAME="$HOSTNAME"
    echo "Using collector hostname: $COLLECTOR_HOSTNAME"

    # Extract port from config
    PORT=$(get_port)
    export COLLECTOR_PORT="$PORT"
    echo "Using collector port: $COLLECTOR_PORT"

    # Extract use_https from config
    TLS=$(get_use_https)
    export TLS_ENABLED="$TLS"
    echo "TLS: $TLS_ENABLED"

    echo "Starting Fluent Bit with configuration:"
    echo "  Host: $COLLECTOR_HOSTNAME"
    echo "  Port: $COLLECTOR_PORT"
    echo "  TLS: $TLS_ENABLED"
    echo "  UUID: ${INSTANCE_SECRET_UUID:0:8}..."

    # Start Fluent Bit in background
    /fluent-bit/bin/fluent-bit -c "$FLUENT_BIT_CONF" &
    FLUENT_BIT_PID=$!
    echo "Fluent Bit started with PID: $FLUENT_BIT_PID"
}

# Function to stop Fluent Bit
stop_fluent_bit() {
    if [ -n "$FLUENT_BIT_PID" ]; then
        echo "Stopping Fluent Bit (PID: $FLUENT_BIT_PID)..."
        kill $FLUENT_BIT_PID 2>/dev/null || true
        wait $FLUENT_BIT_PID 2>/dev/null || true
        FLUENT_BIT_PID=""
    fi
}

# Initial check
REMOTE_LOGGING_ENABLED=$(check_remote_logging)
echo "Initial remote_logging setting: $REMOTE_LOGGING_ENABLED"

if [ "$REMOTE_LOGGING_ENABLED" = "true" ]; then
    start_fluent_bit
    LAST_STATE="running"
else
    echo "Remote logging is disabled. Waiting for configuration change..."
    LAST_STATE="stopped"
fi

# Store last known configuration
LAST_UUID=$(get_uuid)
LAST_HOSTNAME=$(get_hostname)
LAST_PORT=$(get_port)
LAST_TLS=$(get_use_https)

# Monitor for configuration changes every 30 seconds
while true; do
    sleep 30
    
    # Check current state
    CURRENT_REMOTE_LOGGING=$(check_remote_logging)
    CURRENT_UUID=$(get_uuid)
    CURRENT_HOSTNAME=$(get_hostname)
    CURRENT_PORT=$(get_port)
    CURRENT_TLS=$(get_use_https)
    
    # Check if remote_logging was toggled
    if [ "$CURRENT_REMOTE_LOGGING" != "$REMOTE_LOGGING_ENABLED" ]; then
        echo "Remote logging setting changed: $REMOTE_LOGGING_ENABLED -> $CURRENT_REMOTE_LOGGING"
        REMOTE_LOGGING_ENABLED="$CURRENT_REMOTE_LOGGING"
        
        if [ "$REMOTE_LOGGING_ENABLED" = "true" ]; then
            echo "Enabling remote logging..."
            start_fluent_bit
            LAST_STATE="running"
        else
            echo "Disabling remote logging..."
            stop_fluent_bit
            LAST_STATE="stopped"
        fi
        
        # Update last known config
        LAST_UUID="$CURRENT_UUID"
        LAST_HOSTNAME="$CURRENT_HOSTNAME"
        LAST_PORT="$CURRENT_PORT"
        LAST_TLS="$CURRENT_TLS"
        continue
    fi
    
    # If logging is enabled, check for configuration changes
    if [ "$REMOTE_LOGGING_ENABLED" = "true" ]; then
        CONFIG_CHANGED=false
        
        if [ "$CURRENT_UUID" != "$LAST_UUID" ]; then
            echo "UUID changed: $LAST_UUID -> $CURRENT_UUID"
            CONFIG_CHANGED=true
        fi
        
        if [ "$CURRENT_HOSTNAME" != "$LAST_HOSTNAME" ]; then
            echo "Hostname changed: $LAST_HOSTNAME -> $CURRENT_HOSTNAME"
            CONFIG_CHANGED=true
        fi
        
        if [ "$CURRENT_PORT" != "$LAST_PORT" ]; then
            echo "Port changed: $LAST_PORT -> $CURRENT_PORT"
            CONFIG_CHANGED=true
        fi
        
        if [ "$CURRENT_TLS" != "$LAST_TLS" ]; then
            echo "TLS setting changed: $LAST_TLS -> $CURRENT_TLS"
            CONFIG_CHANGED=true
        fi
        
        if [ "$CONFIG_CHANGED" = "true" ]; then
            echo "Configuration changed, restarting Fluent Bit..."
            stop_fluent_bit
            start_fluent_bit
            
            # Update last known config
            LAST_UUID="$CURRENT_UUID"
            LAST_HOSTNAME="$CURRENT_HOSTNAME"
            LAST_PORT="$CURRENT_PORT"
            LAST_TLS="$CURRENT_TLS"
        fi
    fi
    
    # Check if Fluent Bit process is still running when it should be
    if [ "$REMOTE_LOGGING_ENABLED" = "true" ] && [ -n "$FLUENT_BIT_PID" ]; then
        if ! kill -0 $FLUENT_BIT_PID 2>/dev/null; then
            echo "WARNING: Fluent Bit process died unexpectedly, restarting..."
            start_fluent_bit
        fi
    fi
done
