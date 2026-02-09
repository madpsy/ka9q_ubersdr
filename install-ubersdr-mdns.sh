#!/usr/bin/env bash

# --- UberSDR mDNS/Bonjour advertisement installer ---
# This script installs Avahi on the host running Docker and
# publishes a _ubersdr._tcp.local service pointing to port 8080
# with structured TXT records suitable for programmatic discovery.

SERVICE_FILE="/etc/avahi/services/ubersdr.service"
PORT="${UBERSDR_PORT:-8080}"

# Ensure script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "⚠ Please run as root: sudo bash $0"
  exit 1
fi

# Check if Avahi is already configured (service file exists)
if [ -f "$SERVICE_FILE" ]; then
  echo "=== Avahi already configured ==="
  echo "⚠ Avahi service file already exists at $SERVICE_FILE"
  echo "  Skipping Avahi setup to preserve existing configuration."
  echo "  If you want to reconfigure, delete the file and re-run this script."
else
  echo "=== Installing Avahi (mDNS/Bonjour) support ==="
  apt update && apt install -y avahi-daemon avahi-utils

  echo "=== Configuring Avahi daemon ==="
  # Configure hostname and domain in avahi-daemon.conf
  sed -i 's/^#*host-name=.*/host-name=ubersdr/' /etc/avahi/avahi-daemon.conf
  sed -i 's/^#*domain-name=.*/domain-name=local/' /etc/avahi/avahi-daemon.conf

  echo "=== Creating mDNS service advertisement ==="
  mkdir -p /etc/avahi/services
  
  cat > "$SERVICE_FILE" <<EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <!-- Human-friendly instance name; clients should NOT parse this -->
  <name replace-wildcards="yes">UberSDR on %h</name>

  <!-- Programmatically discoverable service -->
  <service>
    <!-- Dedicated service type for UberSDR -->
    <type>_ubersdr._tcp</type>
    <port>${PORT}</port>

    <!-- Structured TXT records for clients -->
    <txt-record>product=ubersdr</txt-record>
    <txt-record>version=1</txt-record>
    <txt-record>path=/</txt-record>
  </service>
</service-group>
EOF

fi

# Configure mDNS publishing for multicast groups using avahi-publish commands
# This matches how ka9q-radio's radiod publishes multicast groups
echo ""
echo "=== Configuring mDNS publishing for multicast groups ==="

# Remove old service file approach if it exists
if [ -f "/etc/avahi/services/ubersdr-multicast.service" ]; then
  echo "Removing old Avahi service file..."
  rm -f /etc/avahi/services/ubersdr-multicast.service
fi

# Create systemd service for hf-status address publication
cat > /etc/systemd/system/avahi-publish-hf-status-addr.service <<'EOF'
[Unit]
Description=Avahi mDNS publisher for hf-status.local multicast address
After=avahi-daemon.service
Requires=avahi-daemon.service

[Service]
Type=simple
ExecStart=/usr/bin/avahi-publish-address hf-status.local 239.185.143.241
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Create systemd service for hf-status control service publication
cat > /etc/systemd/system/avahi-publish-hf-status-ctl.service <<'EOF'
[Unit]
Description=Avahi mDNS publisher for hf-status _ka9q-ctl service
After=avahi-daemon.service avahi-publish-hf-status-addr.service
Requires=avahi-daemon.service

[Service]
Type=simple
ExecStart=/usr/bin/avahi-publish-service "hf-status" _ka9q-ctl._udp 5006 "group=hf-status" "address=239.185.143.241" "description=KA9Q radiod status/control multicast group"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Create systemd service for pcm address publication
cat > /etc/systemd/system/avahi-publish-pcm-addr.service <<'EOF'
[Unit]
Description=Avahi mDNS publisher for pcm.local multicast address
After=avahi-daemon.service
Requires=avahi-daemon.service

[Service]
Type=simple
ExecStart=/usr/bin/avahi-publish-address pcm.local 239.69.232.124
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Create systemd service for pcm RTP service publication
cat > /etc/systemd/system/avahi-publish-pcm-rtp.service <<'EOF'
[Unit]
Description=Avahi mDNS publisher for pcm _rtp service
After=avahi-daemon.service avahi-publish-pcm-addr.service
Requires=avahi-daemon.service

[Service]
Type=simple
ExecStart=/usr/bin/avahi-publish-service "pcm" _rtp._udp 5004 "group=pcm" "address=239.69.232.124" "description=KA9Q radiod PCM audio multicast group"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "=== Enabling and starting Avahi publish services ==="
systemctl daemon-reload
systemctl enable avahi-publish-hf-status-addr.service
systemctl enable avahi-publish-hf-status-ctl.service
systemctl enable avahi-publish-pcm-addr.service
systemctl enable avahi-publish-pcm-rtp.service
systemctl start avahi-publish-hf-status-addr.service
systemctl start avahi-publish-hf-status-ctl.service
systemctl start avahi-publish-pcm-addr.service
systemctl start avahi-publish-pcm-rtp.service

echo "✓ Multicast group mDNS configured via avahi-publish systemd services"
echo "  hf-status.local -> 239.185.143.241 (port 5006, _ka9q-ctl._udp)"
echo "  pcm.local -> 239.69.232.124 (port 5004, _rtp._udp)"

echo ""
echo "=== Restarting Avahi daemon to apply hostname configuration ==="
systemctl restart avahi-daemon
sleep 2

echo "✓ Avahi daemon restarted"
echo ""
echo "UberSDR is now being advertised on your LAN via mDNS/DNS-SD"
echo ""
echo "Service type (for clients):"
echo "    _ubersdr._tcp.local"
echo ""
echo "TXT records:"
echo "    product=ubersdr"
echo "    version=1"
echo "    path=/"
echo ""
echo "Default URL from another machine (if your host is resolvable as 'ubersdr.local'):"
echo "    http://ubersdr.local:${PORT}/"
echo ""
echo "You can verify discovery with:"
echo "    avahi-browse -rt _ubersdr._tcp"
echo "    ping ubersdr.local"
echo ""
echo "Done."
