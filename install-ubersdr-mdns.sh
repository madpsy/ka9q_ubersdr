#!/usr/bin/env bash

# --- Ubersdr mDNS/Bonjour advertisement installer ---
# This script installs Avahi on the host running Docker and
# publishes a _http._tcp.local service pointing to port 8080.

SERVICE_FILE="/etc/avahi/services/ubersdr.service"

# Ensure script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "⚠ Please run as root: sudo bash $0"
  exit 1
fi

echo "=== Installing Avahi (mDNS/Bonjour) support ==="
apt update && apt install -y avahi-daemon avahi-utils

echo "=== Creating mDNS service advertisement ==="
mkdir -p /etc/avahi/services

cat > "$SERVICE_FILE" <<EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">Ubersdr on %h</name>
  <service>
    <type>_http._tcp</type>
    <port>8080</port>
    <txt-record>path=/</txt-record>
  </service>
</service-group>
EOF

echo "=== Restarting Avahi daemon ==="
systemctl restart avahi-daemon

sleep 1

echo ""
echo "🎉 Ubersdr is now being advertised on your LAN via mDNS!"
echo ""
echo "Try accessing it from another computer using:"
echo "    http://ubersdr.local:8080"
echo ""
echo "You can verify discovery with:"
echo "    avahi-browse -a | grep -i ubersdr"
echo ""
echo "Done."
