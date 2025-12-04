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

echo "=== Restarting Avahi daemon ==="
systemctl restart avahi-daemon

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
