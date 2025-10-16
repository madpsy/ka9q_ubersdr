#!/bin/bash
set -e

echo "=========================================="
echo "ka9q_ubersdr Installation Script"
echo "=========================================="
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo "Error: Please do not run this script as root or with sudo."
    echo "The script will prompt for sudo when needed."
    exit 1
fi

# Detect if running on Debian Bookworm
if [ -f /etc/os-release ]; then
    . /etc/os-release
    if [ "$VERSION_CODENAME" = "bookworm" ]; then
        echo "Detected Debian Bookworm"
        if [ -f "./install-docker-bookworm.sh" ]; then
            echo "Running Bookworm-specific Docker installer..."
            ./install-docker-bookworm.sh
        else
            echo "Warning: install-docker-bookworm.sh not found in current directory"
            echo "Continuing with standard Docker installation..."
        fi
    fi
fi

# Install Docker if not already installed
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    sudo apt update
    sudo apt install -y docker.io
    echo "Docker installed successfully"
else
    echo "Docker is already installed"
fi

# Verify docker compose is available
if ! docker compose version &> /dev/null; then
    echo "Error: docker compose plugin not available"
    echo "Please ensure Docker is properly installed with Compose plugin"
    exit 1
fi

echo ""
echo "Docker installation complete!"
echo ""

# Check if we're in the ka9q_ubersdr directory
if [ ! -f "docker/docker-compose.yml" ]; then
    echo "Error: docker/docker-compose.yml not found"
    echo "Please run this script from the ka9q_ubersdr repository root"
    exit 1
fi

# Check if ka9q-radio repository exists
if [ ! -d "../ka9q-radio" ]; then
    echo "Error: ka9q-radio repository not found at ../ka9q-radio"
    echo "Please ensure both repositories are cloned in the same parent directory:"
    echo "  parent-dir/"
    echo "    ├── ka9q-radio/"
    echo "    └── ka9q_ubersdr/"
    exit 1
fi

echo "Building Docker images..."
cd docker
sudo docker compose build

echo ""
echo "Starting services..."
# Prompt for admin password if not set
if [ -z "$ADMIN_PASSWORD" ]; then
    read -sp "Enter admin password (or press Enter for no password): " ADMIN_PASSWORD
    echo ""
fi

sudo ADMIN_PASSWORD="$ADMIN_PASSWORD" docker compose up -d

echo ""
echo "Waiting for services to be healthy..."
sleep 5

echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""
echo "Services are now running!"
echo ""
echo "Web interface available at:"
echo "  http://localhost:8080"
echo ""
echo "Useful commands:"
echo "  View logs:        cd docker && sudo docker compose logs -f"
echo "  Stop services:    cd docker && sudo docker compose down"
echo "  Restart services: cd docker && sudo docker compose restart"
echo ""