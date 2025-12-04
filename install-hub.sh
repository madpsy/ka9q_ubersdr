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