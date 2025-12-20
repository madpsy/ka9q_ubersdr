#!/bin/bash

# Exit on error
set -e

echo "=== UberSDR Docker Hub Installation Script ==="
echo

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
    echo "User added to docker group. You may need to log out and back in for this to take effect."
    echo "Alternatively, you can run: newgrp docker"
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

# Create ubersdr directory in user's home and fetch the docker-compose file
echo "Creating ~/ubersdr directory..."
mkdir -p ~/ubersdr
echo "Fetching docker-compose configuration..."
curl -sSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/docker/docker-compose-dockerhub.yml -o ~/ubersdr/docker-compose.yml
echo "Fetching caddy-entrypoint.sh script..."
curl -sSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/docker/caddy-entrypoint.sh -o ~/ubersdr/caddy-entrypoint.sh
chmod +x ~/ubersdr/caddy-entrypoint.sh

# Check if this is a fresh installation
INSTALLED_MARKER="$HOME/ubersdr/installed"
if [ -f "$INSTALLED_MARKER" ]; then
    # Re-installation - don't set new password
    echo
    echo "Existing installation detected. Preserving current admin password."
    
    # Clean up any existing containers and network (allow failures)
    echo
    echo "Cleaning up any existing containers..."
    cd ~/ubersdr
    sudo docker compose -f docker-compose.yml down 2>/dev/null || true
    
    # Pull latest images
    echo "Pulling latest Docker images..."
    sudo docker compose -f docker-compose.yml pull
    
    # Start Docker containers without setting password
    echo "Starting UberSDR containers..."
    sudo docker compose -f docker-compose.yml up -d
else
    # Fresh installation - generate and set password
    password=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16)
    
    # Clean up any existing containers and network (allow failures)
    echo
    echo "Cleaning up any existing containers..."
    cd ~/ubersdr
    sudo docker compose -f docker-compose.yml down 2>/dev/null || true
    
    # Pull latest images
    echo "Pulling latest Docker images..."
    sudo docker compose -f docker-compose.yml pull
    
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
