#!/usr/bin/env bash
set -euo pipefail

# rotctld-systemd-setup.sh
#
# Idempotently creates/updates a systemd *templated* service for hamlib rotctld
# and an instance-specific env file per rotator "name".
#
# It runs rotctld as user 'nobody' and ensures 'nobody' is in the 'dialout' group
# so it can access the serial device.
#
# Example:
#   sudo ./rotctld-systemd-setup.sh -n azel -d /dev/ttyUSB0 -m 603
#   sudo ./rotctld-systemd-setup.sh -n yagi -d /dev/serial/by-id/usb-FTDI_... -m 603 -p 4534
#
# Services created:
#   rotctld@azel.service
#   rotctld@yagi.service

usage() {
  cat <<'EOF'
Usage:
  sudo rotctld-systemd-setup.sh -n <name> -d <serial_device> -m <model> [options]

Required:
  -n, --name     Rotator name (used as systemd instance name)
  -d, --device   Serial device path (e.g. /dev/ttyUSB0 or /dev/serial/by-id/...)
  -m, --model    Hamlib rotator model number for rotctld -m

Options:
  -s, --speed    Serial speed/baud (default: 9600)
  -b, --bind     Bind address for rotctld -T (default: 127.0.0.1)
  -p, --port     TCP port for rotctld -t (default: 4533)
  --bin          Path to rotctld binary (default: /usr/bin/rotctld)
  --extra        Extra args appended to rotctld (quoted string)
  --no-start     Don't start/enable (just write files)
  --list-devices List all available USB serial devices
  -h, --help     Show help

Examples:
  sudo ./rotctld-systemd-setup.sh --list-devices
  sudo ./rotctld-systemd-setup.sh -n azel -d /dev/ttyUSB0 -m 603
  sudo ./rotctld-systemd-setup.sh -n yagi -d /dev/serial/by-id/usb-FTDI_... -m 603 -s 19200 -p 4534 --extra "-vv"

Resulting service:
  rotctld@<name>.service
EOF
}

list_devices() {
  echo "=== Available USB Serial Devices ==="
  echo ""
  
  local found=0
  
  # Check /dev/serial/by-id/ for persistent device paths
  if [[ -d /dev/serial/by-id ]]; then
    echo "Persistent device paths (recommended):"
    for device in /dev/serial/by-id/*; do
      if [[ -e "$device" ]]; then
        local target=$(readlink -f "$device")
        echo "  $device -> $target"
        found=1
      fi
    done
    echo ""
  fi
  
  # Also list /dev/ttyUSB* and /dev/ttyACM* devices
  echo "Direct device paths:"
  for device in /dev/ttyUSB* /dev/ttyACM*; do
    if [[ -e "$device" ]]; then
      # Try to get additional info from udevadm
      if command -v udevadm &>/dev/null; then
        local info=$(udevadm info --name="$device" 2>/dev/null | grep -E "ID_VENDOR=|ID_MODEL=|ID_SERIAL=" | sed 's/^E: /  /')
        if [[ -n "$info" ]]; then
          echo "  $device"
          echo "$info"
        else
          echo "  $device"
        fi
      else
        echo "  $device"
      fi
      found=1
    fi
  done
  
  if [[ $found -eq 0 ]]; then
    echo "No USB serial devices found."
    echo ""
    echo "Make sure your device is connected and you have the appropriate drivers installed."
  fi
  
  echo ""
  echo "Tip: Use the persistent /dev/serial/by-id/ paths for reliable device identification."
  exit 0
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "ERROR: This script must be run as root (use sudo)." >&2
    exit 1
  fi
}

install_libhamlib_utils() {
  # Check if libhamlib-utils is installed
  if ! command -v rotctld &>/dev/null; then
    echo "rotctld not found. Installing libhamlib-utils..."
    
    # Detect package manager and install
    if command -v apt-get &>/dev/null; then
      apt-get update
      apt-get install -y libhamlib-utils
    elif command -v dnf &>/dev/null; then
      dnf install -y hamlib
    elif command -v yum &>/dev/null; then
      yum install -y hamlib
    elif command -v pacman &>/dev/null; then
      pacman -S --noconfirm hamlib
    else
      echo "ERROR: Could not detect package manager. Please install libhamlib-utils manually." >&2
      exit 1
    fi
    
    echo "libhamlib-utils installed successfully."
  else
    echo "rotctld is already installed at: $(command -v rotctld)"
  fi
}

sanitize_name() {
  # systemd instance names can't contain '/' and should be simple.
  # Allow: letters, numbers, underscore, dash, dot.
  local n="$1"
  if [[ ! "$n" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "ERROR: Invalid name '$n'. Use only letters, numbers, underscore, dash, dot." >&2
    exit 1
  fi
}

ensure_nobody_in_dialout() {
  # Ensure nobody exists
  if ! id nobody &>/dev/null; then
    echo "ERROR: user 'nobody' does not exist on this system." >&2
    exit 1
  fi

  # Ensure dialout group exists
  if ! getent group dialout >/dev/null; then
    echo "Creating group 'dialout'..."
    groupadd dialout
  fi

  # Ensure nobody is in dialout (idempotent)
  if ! id -nG nobody | tr ' ' '\n' | grep -qx dialout; then
    echo "Adding 'nobody' to 'dialout' group..."
    usermod -aG dialout nobody
  fi
}

main() {
  require_root
  install_libhamlib_utils
  ensure_nobody_in_dialout

  local NAME="" DEVICE="" MODEL=""
  local SPEED="9600"
  local BIND="127.0.0.1"
  local PORT="4533"
  local BIN="/usr/bin/rotctld"
  local EXTRA=""
  local NO_START="0"

  # Parse args
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -n|--name)       NAME="${2:-}"; shift 2;;
      -d|--device)     DEVICE="${2:-}"; shift 2;;
      -m|--model)      MODEL="${2:-}"; shift 2;;
      -s|--speed)      SPEED="${2:-}"; shift 2;;
      -b|--bind)       BIND="${2:-}"; shift 2;;
      -p|--port)       PORT="${2:-}"; shift 2;;
      --bin)           BIN="${2:-}"; shift 2;;
      --extra)         EXTRA="${2:-}"; shift 2;;
      --no-start)      NO_START="1"; shift 1;;
      --list-devices)  list_devices;;
      -h|--help)       usage; exit 0;;
      *) echo "ERROR: Unknown argument: $1" >&2; usage; exit 1;;
    esac
  done

  # Validate required
  if [[ -z "$NAME" || -z "$DEVICE" || -z "$MODEL" ]]; then
    echo "ERROR: Missing required args." >&2
    usage
    exit 1
  fi
  sanitize_name "$NAME"

  if [[ ! -x "$BIN" ]]; then
    echo "ERROR: rotctld binary not found/executable at: $BIN" >&2
    echo "       Use --bin /path/to/rotctld" >&2
    exit 1
  fi

  if [[ ! -e "$DEVICE" ]]; then
    echo "WARNING: Device does not exist right now: $DEVICE" >&2
    echo "         Service will still be created; it may fail to start until device appears." >&2
  fi

  # Paths
  local UNIT_PATH="/etc/systemd/system/rotctld@.service"
  local ENV_DIR="/etc/rotctld"
  local ENV_PATH="${ENV_DIR}/rotctld-${NAME}.env"

  mkdir -p "$ENV_DIR"
  chmod 0755 "$ENV_DIR"

  # Create/update environment file (idempotent)
  # Quote values that may contain spaces.
  cat > "$ENV_PATH" <<EOF
# Managed by rotctld-systemd-setup.sh
ROTCTLD_BIN=${BIN}
ROTCTLD_MODEL=${MODEL}
ROTCTLD_DEVICE=${DEVICE}
ROTCTLD_SPEED=${SPEED}
ROTCTLD_BIND=${BIND}
ROTCTLD_PORT=${PORT}
ROTCTLD_EXTRA=${EXTRA}
EOF
  chmod 0644 "$ENV_PATH"

  # Create/update templated unit (idempotent)
  # NOTE: EnvironmentFile uses %i (instance name).
  cat > "$UNIT_PATH" <<'EOF'
[Unit]
Description=Hamlib rotctld for %i
After=network.target
Wants=network.target

[Service]
Type=simple

# Load instance-specific configuration
EnvironmentFile=/etc/rotctld/rotctld-%i.env

# Run unprivileged; allow access to serial via dialout group membership
User=nobody
Group=dialout
SupplementaryGroups=dialout

# Start rotctld
ExecStart=${ROTCTLD_BIN} -T ${ROTCTLD_BIND} -t ${ROTCTLD_PORT} -m ${ROTCTLD_MODEL} -r ${ROTCTLD_DEVICE} -s ${ROTCTLD_SPEED} ${ROTCTLD_EXTRA}

Restart=always
RestartSec=3

# Slightly tighter defaults (safe)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

  # Reload systemd
  systemctl daemon-reexec >/dev/null 2>&1 || true
  systemctl daemon-reload

  local SERVICE="rotctld@${NAME}.service"

  if [[ "$NO_START" -eq 0 ]]; then
    systemctl enable "$SERVICE" >/dev/null
    systemctl restart "$SERVICE"
  fi

  echo "OK: Wrote $UNIT_PATH"
  echo "OK: Wrote $ENV_PATH"
  echo "Instance: $SERVICE"
  if [[ "$NO_START" -eq 0 ]]; then
    echo "OK: Enabled + restarted $SERVICE"
    echo "Status: systemctl status $SERVICE"
    echo "Logs:   journalctl -u $SERVICE -f"
  else
    echo "NOTE: --no-start set; not enabling/starting."
    echo "To enable+start: systemctl enable --now $SERVICE"
  fi
}

main "$@"

