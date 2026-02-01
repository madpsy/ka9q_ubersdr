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
  -b, --bind     Bind address for rotctld -T (default: 0.0.0.0)
  -p, --port     TCP port for rotctld -t (default: 4533)
  --bin          Path to rotctld binary (default: /usr/bin/rotctld)
  --extra        Extra args appended to rotctld (quoted string)
  --no-start     Don't start/enable (just write files)
  --list-devices List all available USB serial devices
  --list         List all configured rotator services
  --delete NAME  Delete a rotator service by name
  --interactive  Interactive setup wizard
  -h, --help     Show help

Examples:
  sudo ./rotctld-systemd-setup.sh --interactive
  sudo ./rotctld-systemd-setup.sh --list-devices
  sudo ./rotctld-systemd-setup.sh --list
  sudo ./rotctld-systemd-setup.sh --delete azel
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

list_rotators() {
  echo "=== Configured Rotator Services ==="
  echo ""
  
  local ENV_DIR="/etc/rotctld"
  local found=0
  
  if [[ ! -d "$ENV_DIR" ]]; then
    echo "No rotator services configured yet."
    echo ""
    echo "Use --interactive to set up your first rotator."
    exit 0
  fi
  
  for env_file in "$ENV_DIR"/rotctld-*.env; do
    if [[ ! -e "$env_file" ]]; then
      continue
    fi
    
    found=1
    local name=$(basename "$env_file" .env | sed 's/^rotctld-//')
    local service="rotctld@${name}.service"
    
    echo "Rotator: $name"
    echo "  Service: $service"
    
    # Get service status
    if systemctl is-active --quiet "$service"; then
      echo "  Status: ✓ Running"
    elif systemctl is-enabled --quiet "$service" 2>/dev/null; then
      echo "  Status: ✗ Stopped (enabled)"
    else
      echo "  Status: ✗ Stopped (disabled)"
    fi
    
    # Parse and display configuration
    if [[ -r "$env_file" ]]; then
      local device=$(grep '^ROTCTLD_DEVICE=' "$env_file" | cut -d= -f2-)
      local model=$(grep '^ROTCTLD_MODEL=' "$env_file" | cut -d= -f2-)
      local port=$(grep '^ROTCTLD_PORT=' "$env_file" | cut -d= -f2-)
      local bind=$(grep '^ROTCTLD_BIND=' "$env_file" | cut -d= -f2-)
      
      [[ -n "$device" ]] && echo "  Device: $device"
      [[ -n "$model" ]] && echo "  Model: $model"
      [[ -n "$port" ]] && echo "  Port: $port"
      [[ -n "$bind" ]] && echo "  Bind: $bind"
    fi
    
    echo ""
  done
  
  if [[ $found -eq 0 ]]; then
    echo "No rotator services configured yet."
    echo ""
    echo "Use --interactive to set up your first rotator."
  fi
  
  exit 0
}

delete_rotator() {
  local name="$1"
  local from_interactive="${2:-0}"
  
  if [[ -z "$name" ]]; then
    echo "ERROR: No rotator name specified for deletion." >&2
    if [[ "$from_interactive" -eq 0 ]]; then
      exit 1
    fi
    return 1
  fi
  
  sanitize_name "$name"
  
  local ENV_DIR="/etc/rotctld"
  local ENV_PATH="${ENV_DIR}/rotctld-${name}.env"
  local SERVICE="rotctld@${name}.service"
  
  if [[ ! -f "$ENV_PATH" ]]; then
    echo "ERROR: Rotator '$name' not found." >&2
    echo "Use --list to see configured rotators." >&2
    if [[ "$from_interactive" -eq 0 ]]; then
      exit 1
    fi
    return 1
  fi
  
  echo "Deleting rotator: $name"
  echo "  Service: $SERVICE"
  echo ""
  
  # Stop the service if running
  if systemctl is-active --quiet "$SERVICE"; then
    echo "Stopping service..."
    systemctl stop "$SERVICE"
  fi
  
  # Disable the service if enabled
  if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
    echo "Disabling service..."
    systemctl disable "$SERVICE" >/dev/null 2>&1
  fi
  
  # Remove the environment file
  echo "Removing configuration..."
  rm -f "$ENV_PATH"
  
  # Reload systemd
  echo "Reloading systemd..."
  systemctl daemon-reload
  
  echo ""
  echo "OK: Rotator '$name' has been deleted."

  # Only exit if not called from interactive mode
  if [[ "$from_interactive" -eq 0 ]]; then
    exit 0
  fi
  return 0
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
  # Allow: letters, numbers, underscore, dash (no dot for stricter validation)
  local n="$1"
  if [[ ! "$n" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "ERROR: Invalid name '$n'. Use only alphanumeric characters, hyphens, and underscores." >&2
    exit 1
  fi
}

interactive_setup() {
  echo "========================================="
  echo "  Rotctld Interactive Setup Wizard"
  echo "========================================="
  echo ""

  # Show existing rotators if any
  local ENV_DIR="/etc/rotctld"
  local existing_rotators=()

  if [[ -d "$ENV_DIR" ]]; then
    for env_file in "$ENV_DIR"/rotctld-*.env; do
      if [[ -e "$env_file" ]]; then
        local name=$(basename "$env_file" .env | sed 's/^rotctld-//')
        existing_rotators+=("$name")
      fi
    done
  fi

  if [[ ${#existing_rotators[@]} -gt 0 ]]; then
    echo "Existing Rotators:"
    echo "-----------------"
    for name in "${existing_rotators[@]}"; do
      local service="rotctld@${name}.service"
      local status="stopped"
      if systemctl is-active --quiet "$service"; then
        status="running"
      fi
      echo "  • $name ($status)"
    done
    echo ""

    while true; do
      read -p "Would you like to (c)reate new, (d)elete existing, or (q)uit? [c/d/q]: " action
      case "$action" in
        [Cc]*)
          echo ""
          break
          ;;
        [Dd]*)
          echo ""
          if [[ ${#existing_rotators[@]} -eq 1 ]]; then
            local to_delete="${existing_rotators[0]}"
            read -p "Delete rotator '$to_delete'? (y/n): " confirm
            if [[ "$confirm" =~ ^[Yy] ]]; then
              delete_rotator "$to_delete" 1
              echo ""
              echo "Continuing to create a new rotator..."
              echo ""
            fi
          else
            echo "Select rotator to delete:"
            for i in "${!existing_rotators[@]}"; do
              echo "  $((i+1)). ${existing_rotators[$i]}"
            done
            echo ""
            read -p "Enter number [1-${#existing_rotators[@]}]: " del_num
            if [[ "$del_num" =~ ^[0-9]+$ ]]; then
              local idx=$((del_num - 1))
              if [[ $idx -ge 0 && $idx -lt ${#existing_rotators[@]} ]]; then
                local to_delete="${existing_rotators[$idx]}"
                read -p "Delete rotator '$to_delete'? (y/n): " confirm
                if [[ "$confirm" =~ ^[Yy] ]]; then
                  delete_rotator "$to_delete" 1
                  echo ""
                  echo "Continuing to create a new rotator..."
                  echo ""
                fi
              else
                echo "Invalid selection."
              fi
            else
              echo "Invalid input."
            fi
          fi
          break
          ;;
        [Qq]*)
          echo "Setup cancelled."
          exit 0
          ;;
        *)
          echo "Invalid choice. Please enter 'c', 'd', or 'q'."
          ;;
      esac
    done
  fi

  # Step 1: Rotator name
  echo "Step 1: Rotator Name"
  echo "-------------------"
  echo "Enter a name for this rotator (alphanumeric, hyphens, and underscores only)."
  echo "Examples: azel, yagi, main-rotator, rotator_1"
  echo ""
  local NAME=""
  while true; do
    read -p "Rotator name: " NAME
    if [[ -z "$NAME" ]]; then
      echo "ERROR: Name cannot be empty." >&2
      continue
    fi
    if [[ ! "$NAME" =~ ^[A-Za-z0-9_-]+$ ]]; then
      echo "ERROR: Invalid name. Use only alphanumeric characters, hyphens, and underscores." >&2
      continue
    fi
    break
  done
  echo ""

  # Step 2: List and select serial device
  echo "Step 2: Serial Device"
  echo "--------------------"
  echo "Available USB serial devices:"
  echo ""

  local devices=()
  local device_display=()

  # Collect persistent device paths
  if [[ -d /dev/serial/by-id ]]; then
    for device in /dev/serial/by-id/*; do
      if [[ -e "$device" ]]; then
        local target=$(readlink -f "$device")
        devices+=("$device")
        device_display+=("$device -> $target")
      fi
    done
  fi

  # Collect direct device paths
  for device in /dev/ttyUSB* /dev/ttyACM*; do
    if [[ -e "$device" ]]; then
      devices+=("$device")
      device_display+=("$device")
    fi
  done

  if [[ ${#devices[@]} -eq 0 ]]; then
    echo "No USB serial devices found!"
    echo "Make sure your device is connected and you have the appropriate drivers installed."
    echo ""
    local DEVICE=""
    while true; do
      read -p "Enter device path manually (or press Ctrl+C to exit): " DEVICE
      if [[ -z "$DEVICE" ]]; then
        echo "ERROR: Device path cannot be empty." >&2
        continue
      fi
      if [[ ! -e "$DEVICE" ]]; then
        echo "ERROR: Device does not exist: $DEVICE" >&2
        echo "Please check the path and try again." >&2
        continue
      fi
      break
    done
  else
    # Display numbered list
    for i in "${!device_display[@]}"; do
      echo "  $((i+1)). ${device_display[$i]}"
    done
    echo ""
    echo "Tip: Persistent /dev/serial/by-id/ paths are recommended for reliability."
    echo ""

    local DEVICE=""
    while true; do
      read -p "Select device number [1-${#devices[@]}] (default: 1): " device_input

      # Default to 1 if empty
      if [[ -z "$device_input" ]]; then
        device_input="1"
      fi

      # Check if it's a number
      if [[ "$device_input" =~ ^[0-9]+$ ]]; then
        local idx=$((device_input - 1))
        if [[ $idx -ge 0 && $idx -lt ${#devices[@]} ]]; then
          DEVICE="${devices[$idx]}"
          break
        else
          echo "ERROR: Invalid selection. Choose 1-${#devices[@]}." >&2
        fi
      else
        # Custom path
        DEVICE="$device_input"
        if [[ ! -e "$DEVICE" ]]; then
          echo "WARNING: Device does not exist: $DEVICE"
          read -p "Use this path anyway? (y/n): " confirm
          if [[ "$confirm" =~ ^[Yy] ]]; then
            break
          fi
        else
          break
        fi
      fi
    done
  fi
  echo ""

  # Step 3: List and select rotator model
  echo "Step 3: Rotator Model"
  echo "--------------------"
  echo "Fetching available rotator models from rotctld..."
  echo ""

  # Get rotctld binary path
  local BIN="$(command -v rotctld 2>/dev/null || echo /usr/bin/rotctld)"

  if [[ ! -x "$BIN" ]]; then
    echo "ERROR: rotctld binary not found/executable at: $BIN" >&2
    exit 1
  fi

  # Run rotctld -l and display output
  "$BIN" -l 2>/dev/null || {
    echo "ERROR: Failed to list rotator models. Is rotctld installed correctly?" >&2
    exit 1
  }

  echo ""
  local MODEL=""
  while true; do
    read -p "Enter rotator model number: " MODEL
    if [[ -z "$MODEL" ]]; then
      echo ""
      echo "Listing rotator models again..."
      echo ""
      "$BIN" -l 2>/dev/null || {
        echo "ERROR: Failed to list rotator models. Is rotctld installed correctly?" >&2
        exit 1
      }
      echo ""
      continue
    fi
    if [[ ! "$MODEL" =~ ^[0-9]+$ ]]; then
      echo "ERROR: Model must be a number." >&2
      continue
    fi
    if [[ "$MODEL" -lt 1 || "$MODEL" -gt 9999 ]]; then
      echo "ERROR: Model number must be between 1 and 9999." >&2
      continue
    fi
    break
  done
  echo ""

  # Step 4: Optional settings
  echo "Step 4: Optional Settings"
  echo "------------------------"

  local SPEED="9600"
  read -p "Serial speed/baud rate (default: 9600): " speed_input
  if [[ -n "$speed_input" ]]; then
    SPEED="$speed_input"
  fi

  local BIND="0.0.0.0"
  read -p "Bind address (default: 0.0.0.0): " bind_input
  if [[ -n "$bind_input" ]]; then
    BIND="$bind_input"
  fi

  local PORT="4533"
  while true; do
    read -p "TCP port (default: 4533): " port_input
    if [[ -n "$port_input" ]]; then
      PORT="$port_input"
    fi
    
    # Check if port is already in use by another rotator
    local port_conflict=0
    if [[ -d "$ENV_DIR" ]]; then
      for env_file in "$ENV_DIR"/rotctld-*.env; do
        if [[ -e "$env_file" ]]; then
          local existing_name=$(basename "$env_file" .env | sed 's/^rotctld-//')
          # Skip if this is the same rotator we're configuring (in case of reconfiguration)
          if [[ "$existing_name" != "$NAME" ]]; then
            local existing_port=$(grep '^ROTCTLD_PORT=' "$env_file" | cut -d= -f2-)
            if [[ "$existing_port" == "$PORT" ]]; then
              echo "ERROR: Port $PORT is already in use by rotator '$existing_name'." >&2
              port_conflict=1
              break
            fi
          fi
        fi
      done
    fi
    
    if [[ $port_conflict -eq 0 ]]; then
      break
    fi
  done

  local EXTRA=""
  read -p "Extra rotctld arguments (optional, e.g., -vv for verbose): " EXTRA

  echo ""
  echo "========================================="
  echo "  Configuration Summary"
  echo "========================================="
  echo "Rotator name:    $NAME"
  echo "Serial device:   $DEVICE"
  echo "Model number:    $MODEL"
  echo "Serial speed:    $SPEED"
  echo "Bind address:    $BIND"
  echo "TCP port:        $PORT"
  if [[ -n "$EXTRA" ]]; then
    echo "Extra args:      $EXTRA"
  fi
  echo ""

  read -p "Proceed with this configuration? (y/n): " confirm
  if [[ ! "$confirm" =~ ^[Yy] ]]; then
    echo "Setup cancelled."
    exit 0
  fi

  # Export variables for main function
  export INTERACTIVE_NAME="$NAME"
  export INTERACTIVE_DEVICE="$DEVICE"
  export INTERACTIVE_MODEL="$MODEL"
  export INTERACTIVE_SPEED="$SPEED"
  export INTERACTIVE_BIND="$BIND"
  export INTERACTIVE_PORT="$PORT"
  export INTERACTIVE_EXTRA="$EXTRA"
  export INTERACTIVE_BIN="$BIN"
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
  local INTERACTIVE_MODE="0"

  # Check for --interactive, --list, or --list-devices before requiring root
  for arg in "$@"; do
    case "$arg" in
      --interactive)
        INTERACTIVE_MODE="1"
        ;;
      --list-devices)
        list_devices
        ;;
      --list)
        list_rotators
        ;;
      --delete)
        # Need to get the name argument
        shift
        require_root
        delete_rotator "$1"
        ;;
      -h|--help)
        usage
        exit 0
        ;;
    esac
  done

  require_root
  install_libhamlib_utils
  ensure_nobody_in_dialout

  local NAME="" DEVICE="" MODEL=""
  local SPEED="9600"
  local BIND="0.0.0.0"
  local PORT="4533"
  # Auto-detect rotctld binary location, fallback to /usr/bin/rotctld
  local BIN="$(command -v rotctld 2>/dev/null || echo /usr/bin/rotctld)"
  local EXTRA=""
  local NO_START="0"

  # Run interactive setup if requested
  if [[ "$INTERACTIVE_MODE" -eq 1 ]]; then
    interactive_setup
    # Use values from interactive setup
    NAME="$INTERACTIVE_NAME"
    DEVICE="$INTERACTIVE_DEVICE"
    MODEL="$INTERACTIVE_MODEL"
    SPEED="$INTERACTIVE_SPEED"
    BIND="$INTERACTIVE_BIND"
    PORT="$INTERACTIVE_PORT"
    EXTRA="$INTERACTIVE_EXTRA"
    BIN="$INTERACTIVE_BIN"
  else
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
        --list-devices)  ;; # Already handled above
        --list)          ;; # Already handled above
        --delete)        ;; # Already handled above
        --interactive)   ;; # Already handled above
        -h|--help)       ;; # Already handled above
        *) echo "ERROR: Unknown argument: $1" >&2; usage; exit 1;;
      esac
    done

    # Validate required
    if [[ -z "$NAME" || -z "$DEVICE" || -z "$MODEL" ]]; then
      echo "ERROR: Missing required args." >&2
      usage
      exit 1
    fi
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
  # We use regular EOF (not 'EOF') to allow $BIN to be expanded by bash
  cat > "$UNIT_PATH" <<EOF
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

# Start rotctld (binary path is hardcoded, arguments use environment variables)
ExecStart=$BIN -T \$ROTCTLD_BIND -t \$ROTCTLD_PORT -m \$ROTCTLD_MODEL -r \$ROTCTLD_DEVICE -s \$ROTCTLD_SPEED \$ROTCTLD_EXTRA

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

  echo ""
  echo ""
  echo "========================================="
  echo "  Next Steps: Configure in Admin UI"
  echo "========================================="
  echo ""
  echo "To complete the rotator setup:"
  echo ""
  echo "1. Set 'Enabled' to true in the Rotctl config section"
  echo "2. Verify the Port matches: $PORT"
  echo "3. Set Host to: 172.20.0.1"
  echo "   (This is the correct value for rotctld running on this instance)"
  echo "4. Set a secure password if you want to control the rotator"
  echo "5. Click 'Save & Restart'"
  echo ""
  echo "The rotator should now be active and controllable from the web interface."
  echo "You can view the status of the rotator connection in the Monitor tab, near the bottom."
  echo ""
}

main "$@"

