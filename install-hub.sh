#!/bin/bash

# Exit on error
set -e

echo "=== UberSDR Docker Hub Installation Script ==="
echo

# Install dependencies
echo "Installing dependencies..."
sudo apt update
sudo apt install -y ntp libfftw3-bin

# Install Docker if not already installed
if command -v docker &> /dev/null; then
    echo "Docker is already installed, skipping installation..."
else
    echo "Installing Docker..."
    curl -sSL https://get.docker.com/ | sh
fi

# Fetch and run the mDNS installation script
echo "Running UberSDR mDNS installation script..."
curl -sSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/install-ubersdr-mdns.sh | sudo bash

# Create ubersdr directory in user's home and fetch the docker-compose file
echo "Creating ~/ubersdr directory..."
mkdir -p ~/ubersdr
echo "Fetching docker-compose configuration..."
curl -sSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/docker/docker-compose-dockerhub.yml -o ~/ubersdr/docker-compose.yml

# Generate a random 16-character alphanumeric password
password=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16)

# Start Docker containers with the generated password
echo
echo "Starting UberSDR containers..."
cd ~/ubersdr
ADMIN_PASSWORD="$password" docker compose -f docker-compose.yml up -d

echo
echo "=== Installation Complete ==="
echo
echo "Your admin password is: $password"
echo
echo "Access the web interface at: http://ubersdr.local:8080/admin.html"
echo

# Ask if user wants to create FFTW Wisdom
echo
read -p "Do you want to create FFTW Wisdom? (takes a while but improves performance) [y/N]: " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Creating FFTW Wisdom... This may take several minutes."
    sudo fftwf-wisdom -v -T 1 -o /var/lib/docker/volumes/docker_radiod-data/_data/wisdom rof500000 cof36480 cob1920 cob1200 cob960 cob800 cob600 cob480 cob320 cob300 cob200 cob160
    echo "FFTW Wisdom created successfully!"
else
    echo "Skipping FFTW Wisdom creation."
fi
echo