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
curl -sSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/docker/docker-compose-dockerhub.yml -o ~/ubersdr/docker-compose-dockerhub.yml

# Prompt for password with confirmation
echo
echo "Please enter a strong admin password for the UberSDR web interface:"
while true; do
    read -s -p "Password: " password
    echo
    read -s -p "Confirm password: " password_confirm
    echo
    
    if [ "$password" = "$password_confirm" ]; then
        if [ -z "$password" ]; then
            echo "Password cannot be empty. Please try again."
            echo
        else
            echo "Passwords match!"
            break
        fi
    else
        echo "Passwords do not match. Please try again."
        echo
    fi
done

# Start Docker containers with the provided password
echo
echo "Starting UberSDR containers..."
cd ~/ubersdr
ADMIN_PASSWORD="$password" docker compose -f docker-compose-dockerhub.yml up -d

echo
echo "=== Installation Complete ==="
echo "UberSDR is now running. Access the web interface with the password you set."