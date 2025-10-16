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

# Detect if running on Debian Bookworm and handle Docker installation
if [ -f /etc/os-release ]; then
    . /etc/os-release
    if [ "$VERSION_CODENAME" = "bookworm" ]; then
        echo "Detected Debian Bookworm"
        # Install Docker if not already installed
        if ! command -v docker &> /dev/null; then
            echo "Installing Docker for Bookworm..."
            # Download and run the Bookworm installer
            curl -fsSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/main/install-docker-bookworm.sh | bash
        else
            echo "Docker is already installed"
        fi
    else
        # Install Docker if not already installed (non-Bookworm)
        if ! command -v docker &> /dev/null; then
            echo "Installing Docker..."
            sudo apt update
            sudo apt install -y docker.io
            echo "Docker installed successfully"
        else
            echo "Docker is already installed"
        fi
    fi
else
    # Fallback if os-release not found
    if ! command -v docker &> /dev/null; then
        echo "Installing Docker..."
        sudo apt update
        sudo apt install -y docker.io
        echo "Docker installed successfully"
    else
        echo "Docker is already installed"
    fi
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

# Ensure git is installed
if ! command -v git &> /dev/null; then
    echo "Installing git..."
    sudo apt update
    sudo apt install -y git
    echo "Git installed successfully"
fi

# Create working directory if running from curl
INSTALL_DIR="$HOME/ubersdr"
if [ ! -f "docker/docker-compose.yml" ]; then
    echo "Setting up installation directory at $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"

    # Clone repositories
    echo "Cloning ka9q-radio repository..."
    if [ ! -d "ka9q-radio" ]; then
        git clone https://github.com/madpsy/ka9q-radio.git
    else
        echo "ka9q-radio already exists, skipping clone"
    fi

    echo "Cloning ka9q_ubersdr repository..."
    if [ ! -d "ka9q_ubersdr" ]; then
        git clone https://github.com/madpsy/ka9q_ubersdr.git
    else
        echo "ka9q_ubersdr already exists, skipping clone"
    fi

    cd ka9q_ubersdr
fi

# Verify we're now in the correct directory
if [ ! -f "docker/docker-compose.yml" ]; then
    echo "Error: docker/docker-compose.yml not found"
    echo "Installation failed - please check the repository structure"
    exit 1
fi

# Check if ka9q-radio repository exists
if [ ! -d "../ka9q-radio" ]; then
    echo "Error: ka9q-radio repository not found at ../ka9q-radio"
    echo "Please ensure both repositories are cloned in the same parent directory"
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