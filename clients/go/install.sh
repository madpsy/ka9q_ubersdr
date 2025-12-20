#!/bin/bash
# Installation script for UberSDR Go Radio Client
# This script installs the radio client as a systemd service

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Error: This script must be run as root${NC}"
    echo "Please run: sudo ./install.sh"
    exit 1
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}UberSDR Go Radio Client Installer${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Configuration
SERVICE_NAME="ubersdr-radio-client"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="radio_client"

# Detect UID 1000 user (typically the main user on single-user systems)
SERVICE_USER=$(getent passwd 1000 | cut -d: -f1)
SERVICE_GROUP=$(getent passwd 1000 | cut -d: -f4 | xargs getent group | cut -d: -f1)
SERVICE_HOME=$(getent passwd 1000 | cut -d: -f6)

if [ -z "$SERVICE_USER" ]; then
    echo -e "${RED}Error: No user with UID 1000 found${NC}"
    echo "This script requires a user with UID 1000 (typically the main user)"
    exit 1
fi

CONFIG_DIR="${SERVICE_HOME}/.config/ubersdr"

echo -e "${YELLOW}Detected user: ${SERVICE_USER} (UID 1000)${NC}"
echo -e "${YELLOW}Config directory: ${CONFIG_DIR}${NC}"
echo ""

# Detect architecture and find binary
ARCH=$(uname -m)
case "$ARCH" in
    aarch64|arm64)
        BINARY_SOURCE="build/radio_client-linux-arm64"
        ;;
    armv7l|armhf)
        BINARY_SOURCE="build/radio_client-linux-arm32"
        ;;
    x86_64|amd64)
        BINARY_SOURCE="build/radio_client-linux-amd64"
        ;;
    *)
        BINARY_SOURCE="build/radio_client"
        ;;
esac

# Check if binary exists, if not build it or use installed one
if [ ! -f "$BINARY_SOURCE" ]; then
    echo -e "${YELLOW}Binary not found at $BINARY_SOURCE${NC}"

    # Check if already installed binary exists
    if [ -f "/usr/local/bin/radio_client" ]; then
        echo -e "${YELLOW}Using existing installed binary from /usr/local/bin${NC}"
        BINARY_SOURCE="/usr/local/bin/radio_client"
        echo ""
    elif [ -f "./build-native.sh" ]; then
        echo -e "${YELLOW}Building binary...${NC}"
        echo ""
        if ./build-native.sh; then
            echo ""
            echo -e "${GREEN}Build successful${NC}"
            echo ""
        else
            echo -e "${RED}Error: Build failed${NC}"
            exit 1
        fi
    else
        echo -e "${RED}Error: No binary found and build-native.sh not found${NC}"
        echo "Please build the binary manually:"
        echo "  ./build-native.sh"
        exit 1
    fi
else
    echo -e "${YELLOW}Found existing binary: $BINARY_SOURCE${NC}"
    echo -e "${YELLOW}To rebuild, run: ./build-native.sh${NC}"
    echo ""
fi

# Step 1: Install runtime dependencies
echo -e "${YELLOW}[1/7] Installing runtime dependencies...${NC}"
if apt-get update && apt-get install -y libsamplerate0 portaudio19-dev; then
    echo -e "${GREEN}  Installed runtime dependencies${NC}"
else
    echo -e "${RED}  Warning: Failed to install some dependencies${NC}"
fi
echo ""

# Step 2: Verify user and add to audio group
echo -e "${YELLOW}[2/7] Configuring user...${NC}"
echo -e "${GREEN}  Using existing user: ${SERVICE_USER}${NC}"

# Add user to audio group for audio device access if not already in it
if ! groups "$SERVICE_USER" | grep -q "\baudio\b"; then
    usermod -aG audio "$SERVICE_USER"
    echo -e "${GREEN}  Added '${SERVICE_USER}' to audio group${NC}"
else
    echo -e "${GREEN}  User '${SERVICE_USER}' already in audio group${NC}"
fi
echo ""

# Step 3: Create config directory
echo -e "${YELLOW}[3/7] Creating configuration directory...${NC}"
mkdir -p "$CONFIG_DIR"
chown "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG_DIR"
chmod 755 "$CONFIG_DIR"

# Ensure parent directories are accessible
chmod 755 "$SERVICE_HOME"
chmod 755 "$SERVICE_HOME/.config" 2>/dev/null || mkdir -p "$SERVICE_HOME/.config" && chmod 755 "$SERVICE_HOME/.config"

echo -e "${GREEN}  Created $CONFIG_DIR${NC}"

# Create ALSA configuration for direct hardware access
cat > "$CONFIG_DIR/.asoundrc" << 'EOF'
# Use ALSA hardware directly, bypass PulseAudio
pcm.!default {
    type plug
    slave.pcm "hw:0,0"
}

ctl.!default {
    type hw
    card 0
}
EOF

chown "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG_DIR/.asoundrc"
chmod 644 "$CONFIG_DIR/.asoundrc"
echo -e "${GREEN}  Created ALSA configuration for direct hardware access${NC}"

# Create initial config.json if it doesn't exist
if [ ! -f "$CONFIG_DIR/client_config.json" ]; then
    cat > "$CONFIG_DIR/client_config.json" << 'EOF'
{
  "host": "ubersdr.local",
  "port": 8080,
  "ssl": false,
  "frequency": 14100000,
  "mode": "usb",
  "bandwidthLow": 50,
  "bandwidthHigh": 2700,
  "outputMode": "portaudio",
  "audioDevice": -1,
  "nr2Enabled": false,
  "nr2Strength": 40.0,
  "nr2Floor": 10.0,
  "nr2AdaptRate": 1.0,
  "resampleEnabled": false,
  "resampleOutputRate": 44100,
  "outputChannels": 2,
  "audioPreviewEnabled": false,
  "audioPreviewMuted": true,
  "autoConnect": false,
  "connectOnDemand": true,
  "spectrumEnabled": false,
  "spectrumZoomScroll": true,
  "spectrumPanScroll": false,
  "spectrumClickTune": true,
  "spectrumCenterTune": false,
  "spectrumSnap": 500,
  "apiPort": 8090,
  "fifoPath": "",
  "fifoEnabled": false,
  "udpHost": "127.0.0.1",
  "udpPort": 8888,
  "udpEnabled": false,
  "portAudioEnabled": true,
  "portAudioDevice": -1,
  "volume": 0.7,
  "leftChannelEnabled": true,
  "rightChannelEnabled": true,
  "radioControlType": "none",
  "flrigEnabled": false,
  "flrigHost": "localhost",
  "flrigPort": 12345,
  "flrigVFO": "A",
  "flrigSyncToRig": true,
  "flrigSyncFromRig": true,
  "rigctlEnabled": false,
  "rigctlHost": "localhost",
  "rigctlPort": 4532,
  "rigctlVFO": "VFOA",
  "rigctlSyncToRig": true,
  "rigctlSyncFromRig": true,
  "serialEnabled": false,
  "serialPort": "",
  "serialBaudrate": 57600,
  "serialVFO": "A",
  "serialSyncToRig": true,
  "serialSyncFromRig": true,
  "midiEnabled": false,
  "midiDeviceName": "",
  "midiMappings": {},
  "frequencyLocked": false,
  "modeLocked": false
}
EOF
    chown "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG_DIR/client_config.json"
    chmod 644 "$CONFIG_DIR/client_config.json"
    echo -e "${GREEN}  Created initial configuration file${NC}"
else
    echo -e "${YELLOW}  Configuration file already exists, preserving it${NC}"
fi
echo ""

# Step 4: Stop service if running (to allow binary replacement)
echo -e "${YELLOW}[4/7] Stopping service if running...${NC}"
if systemctl is-active --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
    systemctl stop "${SERVICE_NAME}.service"
    echo -e "${GREEN}  Stopped ${SERVICE_NAME}${NC}"
    sleep 1
else
    echo -e "${YELLOW}  Service not running${NC}"
fi
echo ""

# Step 5: Install binary
echo -e "${YELLOW}[5/7] Installing binary...${NC}"
if [ "$BINARY_SOURCE" = "$INSTALL_DIR/$BINARY_NAME" ]; then
    echo -e "${GREEN}  Binary already in place at $INSTALL_DIR/$BINARY_NAME${NC}"
else
    cp "$BINARY_SOURCE" "$INSTALL_DIR/$BINARY_NAME"
    chmod 755 "$INSTALL_DIR/$BINARY_NAME"
    echo -e "${GREEN}  Installed to $INSTALL_DIR/$BINARY_NAME${NC}"
fi
echo ""

# Step 6: Create systemd service file
echo -e "${YELLOW}[6/7] Creating systemd service...${NC}"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=UberSDR Go Radio Client
After=network.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$CONFIG_DIR

# Environment
Environment="API_PORT=8090"
Environment="CONFIG_FILE=$CONFIG_DIR/client_config.json"
Environment="HOME=$SERVICE_HOME"
Environment="XDG_RUNTIME_DIR=/run/user/1000"
Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"
Environment="PULSE_SERVER=unix:/run/user/1000/pulse/native"
Environment="ALSA_CARD=0"
Environment="AUDIODEV=hw:0,0"
Environment="JACK_NO_START_SERVER=1"

# Audio device access
SupplementaryGroups=audio

# Start the service
ExecStart=$INSTALL_DIR/$BINARY_NAME

# Restart policy
Restart=on-failure
RestartSec=5s

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=$CONFIG_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}  Created /etc/systemd/system/${SERVICE_NAME}.service${NC}"
echo ""

# Step 7: Reload systemd and enable service
echo -e "${YELLOW}[7/7] Configuring systemd...${NC}"
systemctl daemon-reload
echo -e "${GREEN}  Reloaded systemd daemon${NC}"

systemctl enable "${SERVICE_NAME}.service"
echo -e "${GREEN}  Enabled ${SERVICE_NAME} service${NC}"
echo ""

# Step 8: Start service
echo -e "${YELLOW}[8/8] Starting service...${NC}"
if systemctl start "${SERVICE_NAME}.service"; then
    echo -e "${GREEN}  Service started successfully${NC}"
else
    echo -e "${RED}  Failed to start service${NC}"
    echo -e "${YELLOW}  Check logs with: journalctl -u ${SERVICE_NAME} -f${NC}"
fi
echo ""

# Installation complete
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Installation Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${GREEN}Service Information:${NC}"
echo "  Name: ${SERVICE_NAME}"
echo "  User: ${SERVICE_USER}"
echo "  Binary: ${INSTALL_DIR}/${BINARY_NAME}"
echo "  Config: ${CONFIG_DIR}"
echo "  Running as: ${SERVICE_USER} (UID 1000)"
echo "  API Port: 8090"
echo ""
echo -e "${GREEN}Useful Commands:${NC}"
echo "  Status:  sudo systemctl status ${SERVICE_NAME}"
echo "  Start:   sudo systemctl start ${SERVICE_NAME}"
echo "  Stop:    sudo systemctl stop ${SERVICE_NAME}"
echo "  Restart: sudo systemctl restart ${SERVICE_NAME}"
echo "  Logs:    sudo journalctl -u ${SERVICE_NAME} -f"
echo "  Disable: sudo systemctl disable ${SERVICE_NAME}"
echo ""
echo -e "${GREEN}Configuration:${NC}"
echo "  Config file will be created at: ${CONFIG_DIR}/client_config.json"
echo "  Edit and restart service to apply changes"
echo ""
echo -e "${GREEN}Access the Web Interface/API:${NC}"
echo "  http://$(hostname -I | awk '{print $1}'):8090"
echo ""
