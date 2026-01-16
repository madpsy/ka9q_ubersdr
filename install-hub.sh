#!/bin/bash

# Exit on error
set -e

# Parse command line arguments
IGNORE_RX888=0
IGNORE_PORTS=0
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
    esac
done

echo "=== UberSDR Docker Hub Installation Script ==="
echo

INSTALLED_MARKER="$HOME/ubersdr/installed"

# Pre-flight checks (only if not already installed)
if [ ! -f "$INSTALLED_MARKER" ]; then
    echo "Running pre-flight checks..."
    echo

    ports=(80 443 8080 8073)
    VENDOR=04b4
    PRODUCT=00f1

    ports_in_use=0
    rx_found=0

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
    else
        # Temporarily disable exit on error for the USB device check
        set +e
        for d in /sys/bus/usb/devices/*; do
            # Skip if glob didn't match or files don't exist
            [[ -e "$d" ]] || continue
            [[ -f "$d/idVendor" && -f "$d/idProduct" ]] || continue
            if [[ $(<"$d/idVendor") == "$VENDOR" && $(<"$d/idProduct") == "$PRODUCT" ]]; then
                rx_found=1
                break
            fi
        done
        # Re-enable exit on error
        set -e

        if (( rx_found )); then
            echo "RX888 device found"
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
sudo apt install -y ntpsec libfftw3-bin

# Install Docker if not already installed
if command -v docker &> /dev/null; then
    echo "Docker is already installed, skipping installation..."
else
    echo "Installing Docker..."
    curl -sSL https://get.docker.com/ | sh
fi

# Add current user to docker and sudo groups
if groups $USER | grep -q '\bdocker\b'; then
    echo "User $USER is already in the docker group."
else
    echo "Adding user $USER to the docker group..."
    sudo usermod -aG docker $USER
    echo "User added to docker group."
fi

if groups $USER | grep -q '\bsudo\b'; then
    echo "User $USER is already in the sudo group."
else
    echo "Adding user $USER to the sudo group..."
    sudo usermod -aG sudo $USER
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
mkdir -p ~/ubersdr

# Check if this is a fresh installation
if [ -f "$INSTALLED_MARKER" ]; then
    echo "Existing installation detected. Preserving docker-compose.yml file."
else
    echo "Fetching docker-compose configuration..."
    curl -sSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/docker/docker-compose-dockerhub.yml -o ~/ubersdr/docker-compose.yml
fi

echo "Fetching caddy-entrypoint.sh script..."
curl -sSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/docker/caddy-entrypoint.sh -o ~/ubersdr/caddy-entrypoint.sh
chmod +x ~/ubersdr/caddy-entrypoint.sh

if [ -f "$INSTALLED_MARKER" ]; then
    # Re-installation - don't set new password
    echo
    echo "Existing installation detected. Preserving current admin password."

    # Pull latest images first (while old containers still run)
    echo
    echo "Pulling latest Docker images..."
    cd ~/ubersdr
    if sudo docker compose -f docker-compose.yml pull; then
        # Pull succeeded - proceed with restart
        echo "Pull successful. Restarting containers with new images..."

        # Clean up any existing containers and network (allow failures)
        echo "Stopping existing containers..."
        sudo docker compose -f docker-compose.yml down 2>/dev/null || true

        # Start Docker containers without setting password
        echo "Starting UberSDR containers..."
        sudo docker compose -f docker-compose.yml up -d
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
    cd ~/ubersdr
    sudo docker compose -f docker-compose.yml pull

    # Clean up any existing containers and network (allow failures)
    echo "Stopping any existing containers..."
    sudo docker compose -f docker-compose.yml down 2>/dev/null || true
    
    # Start Docker containers with the generated password
    echo "Starting UberSDR containers..."
    export ADMIN_PASSWORD="$password"
    sudo -E docker compose -f docker-compose.yml up -d
fi

# Create installed marker file
touch ~/ubersdr/installed

# Create FFTW Wisdom if it doesn't exist
WISDOM_FILE="/var/lib/docker/volumes/ubersdr_radiod-config/_data/wisdom"
if sudo test -f "$WISDOM_FILE"; then
    echo
    echo "FFTW Wisdom file already exists, skipping creation."
else
    echo
    echo "Creating FFTW Wisdom... This will take several minutes. Grab a beer and be patient."
    if sudo fftwf-wisdom -v -T 1 -o "$WISDOM_FILE" rof500000 cof36480 cob1920 cob1200 cob960 cob800 cob600 cob480 cob320 cob300 cob200 cob160; then
        echo "FFTW Wisdom created successfully!"
    else
        echo "Warning: FFTW Wisdom creation failed, but installation will continue."
    fi
fi

# Setup auto-update cron job
echo
echo "Setting up auto-update cron job..."
CRON_JOB="* * * * * [ -f \$HOME/ubersdr/updater/latest ] && [ -s \$HOME/ubersdr/updater/latest ] && sudo rm -f \$HOME/ubersdr/updater/latest && curl -fsSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/main/install-hub.sh | bash >> \$HOME/ubersdr/update.log 2>&1"

# Check if cron job already exists
if crontab -l 2>/dev/null | grep -q "ubersdr/updater/latest"; then
    echo "Auto-update cron job already exists."
else
    # Add cron job to existing crontab (or create new one if none exists)
    (crontab -l 2>/dev/null || true; echo "$CRON_JOB") | crontab -
    echo "Auto-update cron job installed. Updates will be checked every minute."
fi

echo
echo "=== Installation Complete ==="
echo
if [ -n "$password" ]; then
    echo "Your admin password is: $password"
    echo
fi
echo "Access the web interface at: http://ubersdr.local:8080/admin.html"
echo
