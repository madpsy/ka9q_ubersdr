#!/bin/bash

# Exit on error
set -e

# Determine the actual user (works in both interactive and cron contexts)
if [ -n "$SUDO_USER" ]; then
    # Script was called with sudo
    ACTUAL_USER="$SUDO_USER"
elif [ -n "$USER" ] && [ "$USER" != "root" ]; then
    # USER is set and not root
    ACTUAL_USER="$USER"
else
    # Fallback: get the user who owns the script's parent process
    ACTUAL_USER=$(ps -o user= -p $PPID)
fi

# Get the actual home directory for this user
ACTUAL_HOME=$(getent passwd "$ACTUAL_USER" | cut -d: -f6)
ACTUAL_HOSTNAME="$(hostname)"

# Export for use throughout the script
export ACTUAL_USER
export ACTUAL_HOME
export ACTUAL_HOSTNAME

# Print detected user context
echo "=== Detected User Context ==="
echo "User: $ACTUAL_USER"
echo "Home: $ACTUAL_HOME"
echo "Hostname: $ACTUAL_HOSTNAME"
echo

# Parse command line arguments
IGNORE_RX888=0
IGNORE_PORTS=0
FORCE_COMPOSE=1
GENERATE_WISDOM=0
for arg in "$@"; do
    case $arg in
        --ignore-rx888)
            IGNORE_RX888=1
            shift
            ;;
        --ignore-ports)
            IGNORE_PORTS=1
            shift
            ;;
        --force-compose)
            FORCE_COMPOSE=1
            shift
            ;;
        --generate-wisdom)
            GENERATE_WISDOM=1
            shift
            ;;
    esac
done

# Extract port mappings from docker-compose.yml
extract_ubersdr_ports() {
    local compose_file="$1"

    # Return defaults if file doesn't exist
    if [ ! -f "$compose_file" ]; then
        echo "8080 8073"
        return
    fi

    # Extract both ports from the ubersdr service section
    local ubersdr_port=$(grep -A 20 "^  ubersdr:" "$compose_file" | \
        grep -E "^\s*-\s*[0-9]+:8080" | \
        sed -E 's/.*- ([0-9]+):8080.*/\1/' | head -1)

    local kiwi_port=$(grep -A 20 "^  ubersdr:" "$compose_file" | \
        grep -E "^\s*-\s*[0-9]+:8073" | \
        sed -E 's/.*- ([0-9]+):8073.*/\1/' | head -1)

    # Use defaults if extraction failed
    echo "${ubersdr_port:-8080} ${kiwi_port:-8073}"
}

# Restore custom port mappings in docker-compose.yml
restore_ubersdr_ports() {
    local compose_file="$1"
    local ubersdr_port="$2"
    local kiwi_port="$3"

    # Only modify if ports differ from defaults
    if [ "$ubersdr_port" != "8080" ]; then
        sed -i "s/- 8080:8080/- ${ubersdr_port}:8080/" "$compose_file"
        echo "  Restored UberSDR port: $ubersdr_port"
    fi

    if [ "$kiwi_port" != "8073" ]; then
        sed -i "s/- 8073:8073/- ${kiwi_port}:8073/" "$compose_file"
        echo "  Restored KiwiSDR port: $kiwi_port"
    fi
}

echo "=== UberSDR Docker Hub Installation Script ==="
echo

INSTALLED_MARKER="$ACTUAL_HOME/ubersdr/installed"
FRESH_INSTALL=0

# Check if this is a fresh installation
if [ ! -f "$INSTALLED_MARKER" ]; then
    FRESH_INSTALL=1
    echo "Running pre-flight checks..."
    echo

    ports=(80 443 8080 8073)
    VENDOR=04b4
    VALID_PRODUCTS=(00f1 00f3)

    ports_in_use=0
    rx_found=0
    vendor_found=0

    # --- Port checks (show output regardless) ---
    if (( IGNORE_PORTS )); then
        echo "Port checks skipped (--ignore-ports)"
    else
        for p in "${ports[@]}"; do
            if ss -ltnH "( sport = :$p )" | grep -q .; then
                echo "Port $p in use"
                ((ports_in_use++)) || true
            else
                echo "Port $p free"
            fi
        done
    fi

    # --- RX888 check (sysfs, no lsusb) ---
    if (( IGNORE_RX888 )); then
        echo "RX888 device check skipped (--ignore-rx888)"
        rx_found=1  # Pretend it was found
        vendor_found=1
    else
        # Temporarily disable exit on error for the USB device check
        set +e
        for d in /sys/bus/usb/devices/*; do
            # Skip if glob didn't match or files don't exist
            [[ -e "$d" ]] || continue
            [[ -f "$d/idVendor" && -f "$d/idProduct" ]] || continue

            device_vendor=$(<"$d/idVendor")
            device_product=$(<"$d/idProduct")

            if [[ "$device_vendor" == "$VENDOR" ]]; then
                vendor_found=1
                # Check if product ID matches any valid product
                product_match=0
                for valid_product in "${VALID_PRODUCTS[@]}"; do
                    if [[ "$device_product" == "$valid_product" ]]; then
                        product_match=1
                        break
                    fi
                done

                if (( product_match )); then
                    rx_found=1
                    echo "RX888 device found (vendor: $device_vendor, product: $device_product)"
                else
                    echo "Warning: Device with correct vendor ID ($device_vendor) found, but product ID ($device_product) doesn't match expected values (${VALID_PRODUCTS[*]})"
                    rx_found=1  # Still consider it found since vendor matches
                fi
                break
            fi
        done
        # Re-enable exit on error
        set -e

        if (( rx_found )); then
            if (( vendor_found == 0 )); then
                echo "RX888 device not found (vendor ID mismatch)"
            fi
        else
            echo "RX888 device not found"
        fi
    fi

    # --- Decide exit code ---
    # Exit 1 if any ports are in use OR RX888 missing
    if (( ports_in_use > 0 || rx_found == 0 )); then
        echo
        echo "Pre-flight checks failed. Installation cannot continue."
        if (( ports_in_use > 0 )); then
            echo "Error: One or more required ports are in use."
            echo "Hint: Use --ignore-ports to skip this check."
        fi
        if (( rx_found == 0 )); then
            echo "Error: RX888 MKII not detected."
            echo "Hint: Use --ignore-rx888 to skip this check."
        fi
        echo
        # Ensure output is flushed before exit when piped
        sleep 0.1
        exit 1
    fi

    echo
    echo "Pre-flight checks passed!"
    echo
fi

# Install dependencies
echo "Installing dependencies..."
sudo apt update
sudo apt -y upgrade
sudo apt install -y ntpsec libfftw3-bin ssh tmux btop htop

# Install Docker if not already installed
if command -v docker &> /dev/null; then
    echo "Docker is already installed, skipping installation..."
else
    echo "Installing Docker..."
    curl -sSL https://get.docker.com/ | sh
fi

# Add current user to docker and sudo groups
if groups $ACTUAL_USER | grep -q '\bdocker\b'; then
    echo "User $ACTUAL_USER is already in the docker group."
else
    echo "Adding user $ACTUAL_USER to the docker group..."
    sudo usermod -aG docker $ACTUAL_USER
    echo "User added to docker group."
fi

if groups $ACTUAL_USER | grep -q '\bsudo\b'; then
    echo "User $ACTUAL_USER is already in the sudo group."
else
    echo "Adding user $ACTUAL_USER to the sudo group..."
    sudo usermod -aG sudo $ACTUAL_USER
    echo "User added to sudo group."
fi

# Configure passwordless sudo for sudo group
echo "Configuring passwordless sudo..."
if sudo grep -q "^%sudo.*NOPASSWD:ALL" /etc/sudoers; then
    echo "Passwordless sudo already configured for sudo group."
else
    # Replace existing %sudo line with NOPASSWD version
    # Use sed to safely modify the sudoers file via visudo
    sudo sed -i 's/^%sudo\s\+ALL=(ALL:ALL)\s\+ALL$/%sudo\tALL=(ALL:ALL) NOPASSWD:ALL/' /etc/sudoers
    echo "Passwordless sudo configured for sudo group."
fi

# Fetch and run the mDNS installation script
echo "Running UberSDR mDNS installation script..."
curl -sSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/install-ubersdr-mdns.sh | sudo bash

# Install HPSDR bridge binary
echo "Installing UberSDR HPSDR bridge..."
if curl -fsSL https://github.com/madpsy/ka9q_ubersdr/releases/download/latest/ubersdr-hpsdr-bridge -o /tmp/ubersdr-hpsdr-bridge 2>/dev/null; then
    sudo mv /tmp/ubersdr-hpsdr-bridge /usr/local/bin/ubersdr-hpsdr-bridge
    sudo chmod +x /usr/local/bin/ubersdr-hpsdr-bridge
    echo "HPSDR bridge binary installed successfully."

    # Install systemd service
    if [ -f /etc/systemd/system/ubersdr-hpsdr-bridge.service ]; then
        echo "HPSDR bridge service file already exists, skipping."
        sudo systemctl restart ubersdr-hpsdr-bridge.service
    else
        if curl -fsSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/clients/hpsdr/ubersdr-hpsdr-bridge.service -o /tmp/ubersdr-hpsdr-bridge.service 2>/dev/null; then
            sudo mv /tmp/ubersdr-hpsdr-bridge.service /etc/systemd/system/ubersdr-hpsdr-bridge.service
            sudo systemctl daemon-reload
            sudo systemctl enable ubersdr-hpsdr-bridge.service
            sudo systemctl start ubersdr-hpsdr-bridge.service
            echo "HPSDR bridge service installed, enabled, and started."
        else
            echo "Warning: Failed to download HPSDR bridge service file. Skipping service installation."
        fi
    fi
else
    echo "Warning: Failed to download HPSDR bridge binary. Skipping HPSDR bridge installation."
fi

# Create ubersdr directory in user's home
echo "Creating ~/ubersdr directory..."
sudo -u "$ACTUAL_USER" mkdir -p "$ACTUAL_HOME/ubersdr"

# Generate SSH key for GoTTY container if it doesn't exist
SSH_KEY_PATH="$ACTUAL_HOME/.ssh/ubersdr_gotty_key"
if [ ! -f "$SSH_KEY_PATH" ]; then
    echo "Generating SSH key for GoTTY container..."
    sudo -u "$ACTUAL_USER" mkdir -p "$ACTUAL_HOME/.ssh"
    sudo -u "$ACTUAL_USER" chmod 700 "$ACTUAL_HOME/.ssh"

    # Generate SSH key without passphrase (fully automatic)
    sudo -u "$ACTUAL_USER" ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "ubersdr-gotty@$(hostname)"
    sudo -u "$ACTUAL_USER" chmod 600 "$SSH_KEY_PATH"
    sudo -u "$ACTUAL_USER" chmod 644 "$SSH_KEY_PATH.pub"

    echo "SSH key generated successfully."
else
    echo "SSH key for GoTTY already exists, skipping generation."
fi

# Add public key to authorized_keys if not already present
AUTHORIZED_KEYS="$ACTUAL_HOME/.ssh/authorized_keys"
PUBLIC_KEY=$(cat "$SSH_KEY_PATH.pub")

if [ -f "$AUTHORIZED_KEYS" ]; then
    # authorized_keys exists - check if key is already present
    # grep -F treats the pattern as a fixed string (literal match of the entire public key)
    if grep -qF "$PUBLIC_KEY" "$AUTHORIZED_KEYS"; then
        echo "GoTTY public key already in authorized_keys."
    else
        echo "Adding GoTTY public key to authorized_keys..."
        # Ensure file ends with newline, then append key with newline
        [ -n "$(tail -c1 "$AUTHORIZED_KEYS")" ] && sudo -u "$ACTUAL_USER" bash -c "echo '' >> '$AUTHORIZED_KEYS'"
        sudo -u "$ACTUAL_USER" bash -c "printf '%s\n' '$PUBLIC_KEY' >> '$AUTHORIZED_KEYS'"
        sudo -u "$ACTUAL_USER" chmod 600 "$AUTHORIZED_KEYS"
        echo "Public key added successfully."
    fi
else
    # authorized_keys doesn't exist - create it
    echo "Creating authorized_keys and adding GoTTY public key..."
    sudo -u "$ACTUAL_USER" bash -c "printf '%s\n' '$PUBLIC_KEY' > '$AUTHORIZED_KEYS'"
    sudo -u "$ACTUAL_USER" chmod 600 "$AUTHORIZED_KEYS"
    echo "authorized_keys created and public key added successfully."
fi

# Check if this is a fresh installation
if [ -f "$INSTALLED_MARKER" ] && [ $FORCE_COMPOSE -eq 0 ]; then
    echo "Existing installation detected. Preserving docker-compose.yml file."
    echo "Hint: Use --force-compose to overwrite docker-compose.yml."
else
    # Capture existing port configuration before overwriting
    if [ -f "$ACTUAL_HOME/ubersdr/docker-compose.yml" ]; then
        read OLD_UBERSDR_PORT OLD_KIWI_PORT < <(extract_ubersdr_ports "$ACTUAL_HOME/ubersdr/docker-compose.yml")

        if [ $FORCE_COMPOSE -eq 1 ]; then
            echo "Forcing docker-compose.yml overwrite (--force-compose)..."
            if [ "$OLD_UBERSDR_PORT" != "8080" ] || [ "$OLD_KIWI_PORT" != "8073" ]; then
                echo "Detected custom port mappings - will preserve them:"
                echo "  UberSDR port: $OLD_UBERSDR_PORT"
                echo "  KiwiSDR port: $OLD_KIWI_PORT"
            else
                echo "No custom port mappings detected (using defaults: 8080, 8073)"
            fi
        else
            echo "Fetching docker-compose configuration..."
        fi
    else
        # No existing file - use defaults
        OLD_UBERSDR_PORT=8080
        OLD_KIWI_PORT=8073
        echo "Fetching docker-compose configuration..."
    fi

    # Download new docker-compose.yml
    curl -sSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/docker/docker-compose-dockerhub.yml -o "$ACTUAL_HOME/ubersdr/docker-compose.yml"

    # Restore custom ports if they existed
    if [ "$OLD_UBERSDR_PORT" != "8080" ] || [ "$OLD_KIWI_PORT" != "8073" ]; then
        echo "Restoring custom port mappings..."
        restore_ubersdr_ports "$ACTUAL_HOME/ubersdr/docker-compose.yml" "$OLD_UBERSDR_PORT" "$OLD_KIWI_PORT"
    fi
fi

echo "Fetching caddy-entrypoint.sh script..."
curl -sSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/docker/caddy-entrypoint.sh -o "$ACTUAL_HOME/ubersdr/caddy-entrypoint.sh"
chmod +x "$ACTUAL_HOME/ubersdr/caddy-entrypoint.sh"

echo "Fetching generate_wisdom.sh script..."
curl -sSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/generate_wisdom.sh -o "$ACTUAL_HOME/ubersdr/generate_wisdom.sh"
chmod +x "$ACTUAL_HOME/ubersdr/generate_wisdom.sh"

echo "Fetching rotctld.sh script..."
curl -sSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/rotctld.sh -o "$ACTUAL_HOME/ubersdr/rotctld.sh"
chmod +x "$ACTUAL_HOME/ubersdr/rotctld.sh"

# Migrate FFTW Wisdom file if it exists in the wrong location (before starting containers)
#OLD_WISDOM_FILE="/var/lib/docker/volumes/ubersdr_radiod-config/_data/wisdom"
#WISDOM_FILE="/var/lib/docker/volumes/ubersdr_radiod-data/_data/wisdom"

#if sudo test -f "$OLD_WISDOM_FILE" && ! sudo test -f "$WISDOM_FILE"; then
#    echo
#    echo "Found FFTW Wisdom file in old location, migrating to correct location..."
#    sudo mv "$OLD_WISDOM_FILE" "$WISDOM_FILE"
#    echo "FFTW Wisdom file migrated successfully."
#fi

if [ -f "$INSTALLED_MARKER" ]; then
    # Re-installation - don't set new password
    echo
    echo "Existing installation detected. Preserving current admin password."

    # Pull latest images first (while old containers still run)
    echo
    echo "Pulling latest Docker images..."
    cd "$ACTUAL_HOME/ubersdr"
    if sudo -E USER="$ACTUAL_USER" HOME="$ACTUAL_HOME" HOSTNAME="$ACTUAL_HOSTNAME" docker compose -f docker-compose.yml pull; then
        # Pull succeeded - proceed with restart
        echo "Pull successful. Restarting containers with new images..."

        # Clean up any existing containers and network (allow failures)
        echo "Stopping existing containers..."
        sudo -E USER="$ACTUAL_USER" HOME="$ACTUAL_HOME" HOSTNAME="$ACTUAL_HOSTNAME" docker compose -f docker-compose.yml down 2>/dev/null || true

        # Start Docker containers without setting password
        echo "Starting UberSDR containers..."
        sudo -E USER="$ACTUAL_USER" HOME="$ACTUAL_HOME" HOSTNAME="$ACTUAL_HOSTNAME" docker compose -f docker-compose.yml up -d
    else
        # Pull failed - keep existing containers running
        echo "Warning: Failed to pull new images. Keeping existing containers running."
        echo "Your installation will continue to use the current image versions."
    fi
else
    # Fresh installation - generate and set password
    password=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16)
    
    # Pull latest images first
    echo
    echo "Pulling latest Docker images..."
    cd "$ACTUAL_HOME/ubersdr"
    sudo -E USER="$ACTUAL_USER" HOME="$ACTUAL_HOME" HOSTNAME="$ACTUAL_HOSTNAME" docker compose -f docker-compose.yml pull

    # Clean up any existing containers and network (allow failures)
    echo "Stopping any existing containers..."
    sudo -E USER="$ACTUAL_USER" HOME="$ACTUAL_HOME" HOSTNAME="$ACTUAL_HOSTNAME" docker compose -f docker-compose.yml down 2>/dev/null || true
    
    # Start Docker containers with the generated password
    echo "Starting UberSDR containers..."
    export ADMIN_PASSWORD="$password"
    sudo -E USER="$ACTUAL_USER" HOME="$ACTUAL_HOME" HOSTNAME="$ACTUAL_HOSTNAME" ADMIN_PASSWORD="$password" docker compose -f docker-compose.yml up -d
    
    # Verify containers started successfully before creating marker
    echo "Verifying container startup..."
    sleep 5  # Give containers time to initialize
    
    # Check if all required containers are running
    if sudo -E USER="$ACTUAL_USER" HOME="$ACTUAL_HOME" HOSTNAME="$ACTUAL_HOSTNAME" docker compose -f docker-compose.yml ps --status running | grep -q "ka9q-radio" && \
       sudo -E USER="$ACTUAL_USER" HOME="$ACTUAL_HOME" HOSTNAME="$ACTUAL_HOSTNAME" docker compose -f docker-compose.yml ps --status running | grep -q "ka9q_ubersdr"; then
        echo "Containers started successfully."
        
        # Wait for ubersdr to become healthy (up to 60 seconds)
        echo "Waiting for UberSDR to become healthy..."
        for i in {1..12}; do
            if sudo docker inspect --format='{{.State.Health.Status}}' ka9q_ubersdr 2>/dev/null | grep -q "healthy"; then
                echo "UberSDR is healthy!"
                # Create installed marker file only after successful verification
                sudo -u "$ACTUAL_USER" touch "$ACTUAL_HOME/ubersdr/installed"
                break
            fi
            if [ $i -eq 12 ]; then
                echo "Warning: UberSDR did not become healthy within 60 seconds."
                echo "Installation may have issues. Marker file NOT created."
                echo "You can re-run this script to try again with a new password."
                exit 1
            fi
            sleep 5
        done
    else
        echo "Error: Required containers failed to start."
        echo "Marker file NOT created. You can re-run this script to try again."
        exit 1
    fi
fi

# Create FFTW Wisdom only when --generate-wisdom is specified
if [ $GENERATE_WISDOM -eq 1 ]; then
    WISDOM_FILE="/var/lib/docker/volumes/ubersdr_radiod-data/_data/wisdom"
    echo
    echo "Generating FFTW Wisdom (--generate-wisdom)..."
    if sudo test -f "$WISDOM_FILE"; then
        echo "Moving existing wisdom file to /tmp/..."
        sudo mv "$WISDOM_FILE" /tmp/
    fi
    echo "Creating FFTW Wisdom... This will take several minutes, if not hours. Grab a beer and be patient. DO NOT CLOSE YOUR SSH SESSION/TERMINAL!"
    # rof3240000: RX888 MkII at 129.6 MHz
    if sudo fftwf-wisdom -v -T 1 -o "$WISDOM_FILE" \
        rof1620000 rof810000 cob162000 cob81000 cob40500 cob32400 \
        cob16200 cob9600 cob8100 cob6930 cob4860 cob4800 cob3240 cob3200 cob1920 cob1620 cob1600 \
        cob1200 cob960 cob810 cob800 cob600 cob480 cob405 cob400 cob320 cob300 cob205 cob200 cob160 cob85 cob45 cob15; then
        echo "FFTW Wisdom created successfully!"
    else
        echo "Warning: FFTW Wisdom creation failed, but installation will continue."
    fi
else
    echo
    echo "Skipping FFTW Wisdom generation."
    echo "Hint: Use --generate-wisdom to generate FFTW wisdom file."
fi

# Setup auto-update cron job
echo
echo "Setting up auto-update cron job..."
CRON_JOB="* * * * * [ -f \$HOME/ubersdr/updater/latest ] && [ -s \$HOME/ubersdr/updater/latest ] && sudo rm -f \$HOME/ubersdr/updater/latest && curl -fsSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/main/install-hub.sh | bash -s -- --force-compose >> \$HOME/ubersdr/update.log 2>&1"

# Check if cron job already exists
if sudo -u "$ACTUAL_USER" crontab -l 2>/dev/null | grep -q "ubersdr/updater/latest"; then
    echo "Auto-update cron job already exists."
else
    # Add cron job to existing crontab (or create new one if none exists)
    (sudo -u "$ACTUAL_USER" crontab -l 2>/dev/null || true; echo "$CRON_JOB") | sudo -u "$ACTUAL_USER" crontab -
    echo "Auto-update cron job installed. Updates will be checked every minute."
fi

echo
echo "=== Installation Complete ==="
echo
if [ -n "$password" ]; then
    echo "Your admin password is: $password"
    echo
fi

# Get the actual port from the running container or compose file
FINAL_PORT=$(docker port ka9q_ubersdr 8080 2>/dev/null | cut -d':' -f2)
if [ -z "$FINAL_PORT" ]; then
    # Fallback to reading from docker-compose.yml
    read FINAL_PORT _ < <(extract_ubersdr_ports "$ACTUAL_HOME/ubersdr/docker-compose.yml")
fi

echo "Access the web interface at: http://ubersdr.local:${FINAL_PORT}/admin.html"
echo
