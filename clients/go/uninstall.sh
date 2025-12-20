#!/bin/bash
# Uninstallation script for UberSDR Go Radio Client

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Error: This script must be run as root${NC}"
    echo "Please run: sudo ./uninstall.sh"
    exit 1
fi

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}UberSDR Go Radio Client Uninstaller${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""

# Configuration
SERVICE_NAME="ubersdr-radio-client"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="radio_client"

# Detect UID 1000 user
SERVICE_USER=$(getent passwd 1000 | cut -d: -f1)
SERVICE_HOME=$(getent passwd 1000 | cut -d: -f6)
CONFIG_DIR="${SERVICE_HOME}/.config/ubersdr"

if [ -z "$SERVICE_USER" ]; then
    SERVICE_USER="radio"  # Fallback for old installations
    CONFIG_DIR="/var/lib/ubersdr"
fi

# Confirm uninstallation
echo -e "${YELLOW}This will remove:${NC}"
echo "  - Service: ${SERVICE_NAME}"
echo "  - Binary: ${INSTALL_DIR}/${BINARY_NAME}"
echo "  - User: ${SERVICE_USER}"
echo ""
echo -e "${RED}Configuration directory ${CONFIG_DIR} will be preserved${NC}"
echo -e "${YELLOW}To remove it manually: sudo rm -rf ${CONFIG_DIR}${NC}"
echo ""
read -p "Continue with uninstallation? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Uninstallation cancelled"
    exit 0
fi
echo ""

# Step 1: Stop and disable service
echo -e "${YELLOW}[1/4] Stopping and disabling service...${NC}"
if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    systemctl stop "${SERVICE_NAME}.service"
    echo -e "${GREEN}  Stopped ${SERVICE_NAME}${NC}"
fi

if systemctl is-enabled --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
    systemctl disable "${SERVICE_NAME}.service"
    echo -e "${GREEN}  Disabled ${SERVICE_NAME}${NC}"
fi
echo ""

# Step 2: Remove systemd service file
echo -e "${YELLOW}[2/4] Removing systemd service file...${NC}"
if [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
    rm "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    echo -e "${GREEN}  Removed service file${NC}"
else
    echo -e "${YELLOW}  Service file not found${NC}"
fi
echo ""

# Step 3: Remove binary
echo -e "${YELLOW}[3/4] Removing binary...${NC}"
if [ -f "${INSTALL_DIR}/${BINARY_NAME}" ]; then
    rm "${INSTALL_DIR}/${BINARY_NAME}"
    echo -e "${GREEN}  Removed ${INSTALL_DIR}/${BINARY_NAME}${NC}"
else
    echo -e "${YELLOW}  Binary not found${NC}"
fi
echo ""

# Step 4: Note about user
echo -e "${YELLOW}[4/4] User configuration...${NC}"
echo -e "${GREEN}  Service was running as: ${SERVICE_USER}${NC}"
echo -e "${YELLOW}  User account preserved (not removed)${NC}"
echo ""

# Uninstallation complete
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Uninstallation Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}Configuration directory preserved at: ${CONFIG_DIR}${NC}"
echo -e "${YELLOW}To remove it: sudo rm -rf ${CONFIG_DIR}${NC}"
echo ""