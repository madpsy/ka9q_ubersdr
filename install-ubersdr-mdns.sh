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

# Configure mDNS publishing for multicast groups
echo ""
echo "=== Configuring mDNS publishing for multicast groups ==="

# Create Avahi service file for multicast groups
cat > /etc/avahi/services/ubersdr-multicast.service <<'EOF'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">UberSDR Multicast Groups on %h</name>
  
  <!-- Publish hf-status.local -> 239.185.143.241 -->
  <service>
    <type>_ubersdr-multicast._udp</type>
    <port>5006</port>
    <host-name>hf-status.local</host-name>
    <txt-record>group=hf-status</txt-record>
    <txt-record>address=239.185.143.241</txt-record>
  </service>
  
  <!-- Publish pcm.local -> 239.69.232.124 -->
  <service>
    <type>_ubersdr-multicast._udp</type>
    <port>5004</port>
    <host-name>pcm.local</host-name>
    <txt-record>group=pcm</txt-record>
    <txt-record>address=239.69.232.124</txt-record>
  </service>
</service-group>
EOF

echo "=== Restarting Avahi daemon to apply multicast group configuration ==="
systemctl restart avahi-daemon

echo "✓ Multicast group mDNS names configured"
echo "  hf-status.local -> 239.185.143.241"
echo "  pcm.local -> 239.69.232.124"

sleep 1

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
echo ""
echo "Done."
