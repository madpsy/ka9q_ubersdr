#!/bin/sh
set -e

CONFIG_FILE="/app/config/config.yaml"
FLUENT_BIT_CONF="/tmp/fluent-bit.conf"
FLUENT_BIT_PID=""

# Function to generate Fluent Bit configuration
# Parameters: $1 = include_http_output (true/false)
generate_fluent_bit_config() {
    local include_http="$1"

    cat > "$FLUENT_BIT_CONF" <<EOF
[SERVICE]
    Flush        5
    Daemon       Off
    Log_Level    error
    Parsers_File parsers.conf

[INPUT]
    Name                forward
    Listen              0.0.0.0
    Port                24224
    Mem_Buf_Limit       5MB

[FILTER]
    Name                modify
    Match               *
    Remove              container_id

[OUTPUT]
    Name                tcp
    Match               *
    Host                ka9q_ubersdr
    Port                6925
    Format              json_lines
    Retry_Limit         5
EOF

    # Only add HTTP output if remote logging is enabled
    if [ "$include_http" = "true" ]; then
        cat >> "$FLUENT_BIT_CONF" <<'EOF'

[OUTPUT]
    Name                http
    Match               *
    Host                ${COLLECTOR_HOSTNAME}
    Port                ${COLLECTOR_PORT}
    URI                 /ingest/logs
    Format              json
    Header              Authorization Bearer ${INSTANCE_SECRET_UUID}
    tls                 ${TLS_ENABLED}
    tls.verify          On
    Retry_Limit         3
EOF
        echo "Generated Fluent Bit configuration with HTTP output at $FLUENT_BIT_CONF"
    else
        echo "Generated Fluent Bit configuration without HTTP output at $FLUENT_BIT_CONF"
    fi
}

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
        # Match both quoted and unquoted UUIDs
        UUID=$(grep "instance_uuid:" "$CONFIG_FILE" | sed 's/.*instance_uuid: *//; s/"//g; s/ *$//')
        echo "$UUID"
    fi
}

# Function to extract hostname
get_hostname() {
    if [ -f "$CONFIG_FILE" ]; then
        # Match both quoted and unquoted hostnames
        HOSTNAME=$(grep "hostname:" "$CONFIG_FILE" | grep -v "tunnel_server_host" | head -1 | sed 's/.*hostname: *//; s/"//g; s/ *$//')
        echo "$HOSTNAME"
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
# Parameters: $1 = remote_logging_enabled (true/false)
start_fluent_bit() {
    local remote_logging="$1"
    
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

    # If remote logging is enabled, extract collector settings
    if [ "$remote_logging" = "true" ]; then
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

        echo "Starting Fluent Bit with remote logging enabled:"
        echo "  Host: $COLLECTOR_HOSTNAME"
        echo "  Port: $COLLECTOR_PORT"
        echo "  TLS: $TLS_ENABLED"
        echo "  UUID: $(echo "$INSTANCE_SECRET_UUID" | cut -c1-8)..."
    else
        echo "Starting Fluent Bit with local TCP forwarding only"
        echo "  UUID: $(echo "$INSTANCE_SECRET_UUID" | cut -c1-8)..."
    fi

    # Generate Fluent Bit configuration file
    generate_fluent_bit_config "$remote_logging"

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

# Always start Fluent Bit (it will run with or without HTTP output based on remote_logging)
start_fluent_bit "$REMOTE_LOGGING_ENABLED"
LAST_STATE="running"

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
        
        # Restart Fluent Bit with new configuration (with or without HTTP output)
        echo "Restarting Fluent Bit with updated configuration..."
        stop_fluent_bit
        start_fluent_bit "$REMOTE_LOGGING_ENABLED"
        
        # Update last known config
        LAST_UUID="$CURRENT_UUID"
        LAST_HOSTNAME="$CURRENT_HOSTNAME"
        LAST_PORT="$CURRENT_PORT"
        LAST_TLS="$CURRENT_TLS"
        continue
    fi
    
    # If remote logging is enabled, check for collector configuration changes
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
            echo "Collector configuration changed, restarting Fluent Bit..."
            stop_fluent_bit
            start_fluent_bit "$REMOTE_LOGGING_ENABLED"
            
            # Update last known config
            LAST_UUID="$CURRENT_UUID"
            LAST_HOSTNAME="$CURRENT_HOSTNAME"
            LAST_PORT="$CURRENT_PORT"
            LAST_TLS="$CURRENT_TLS"
        fi
    fi
    
    # Check if Fluent Bit process is still running (should always be running now)
    if [ -n "$FLUENT_BIT_PID" ]; then
        if ! kill -0 $FLUENT_BIT_PID 2>/dev/null; then
            echo "WARNING: Fluent Bit process died unexpectedly, restarting..."
            start_fluent_bit "$REMOTE_LOGGING_ENABLED"
        fi
    fi
done
