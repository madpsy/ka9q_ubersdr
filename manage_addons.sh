#!/usr/bin/env bash
set -euo pipefail

ADDONS_FILE="$(dirname "$(realpath "$0")")/addons.json"

# Dependency check
for cmd in curl jq; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: '$cmd' is required but not installed." >&2
        exit 1
    fi
done

# Get all addon names
get_addon_names() {
    jq -r '.addons[].name' "$ADDONS_FILE"
}

# Get a scalar field value for a named addon
get_field() {
    local name="$1"
    local field="$2"
    jq -r --arg name "$name" --arg field "$field" \
        '.addons[] | select(.name == $name) | .[$field]' "$ADDONS_FILE"
}

# Install a single addon by name
install_addon() {
    local name="$1"
    local url
    url=$(get_field "$name" "install_script_url")
    if [[ -z "$url" || "$url" == "null" ]]; then
        echo "Error: no install_script_url defined for addon '$name'" >&2
        return 1
    fi
    echo ""
    echo "Installing addon '$name' from:"
    echo "  $url"
    echo ""
    curl -fsSL "$url" | bash
    echo ""
    echo "Addon '$name' installation complete."

    # Register or update the addon proxy in UberSDR via the admin API
    echo "Configuring addon proxy '$name' in UberSDR..."
    local live_response
    live_response=$(_api_curl GET "/admin/addon-proxies") || {
        echo "Warning: Could not reach UberSDR API — skipping proxy registration." >&2
        return 0
    }

    local exists
    exists=$(echo "$live_response" | jq -r --arg name "$name" '.[] | select(.name == $name) | .name')

    if [[ -n "$exists" && "$exists" != "null" ]]; then
        echo "Addon proxy '$name' already exists — updating..."
        api_update_addon_proxy "$name"
    else
        echo "Addon proxy '$name' not found — adding..."
        api_add_addon_proxy "$name"
    fi

    # Test backend connectivity immediately (no restart required)
    echo "Testing backend connectivity for '$name'..."
    local test_response
    test_response=$(_api_curl GET "/admin/addon-proxies/test?name=$(jq -rn --arg n "$name" '$n | @uri')")
    local test_success status_code test_error
    test_success=$(echo "$test_response" | jq -r '.success')
    status_code=$(echo "$test_response" | jq -r '.status_code')
    test_error=$(echo "$test_response" | jq -r '.error')
    if [[ "$test_success" == "true" ]]; then
        echo "  ✓ Backend reachable (HTTP $status_code)"
    else
        echo "  ✗ Backend not reachable: $test_error" >&2
        echo "  Ensure the addon container is running and try again." >&2
    fi

    # Show the addon URL and UI password (if one was set during install)
    local addon_url="http://ubersdr.local/addon/${name}/"
    local pass_file="$HOME/ubersdr/${name}/.config_pass"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ADDON: $name"
    echo ""
    echo "  URL:  ${addon_url}"
    if [[ -f "$pass_file" ]]; then
        local pass
        pass="$(cat "$pass_file")"
        echo ""
        echo "  UI PASSWORD:  ${pass}"
        echo "  (protects write actions in the web UI)"
        echo "  Stored at: ${pass_file}"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
}

# Show full info for one addon
show_addon_info() {
    local name="$1"
    echo ""
    echo "=== Addon: $name ==="
    local addon
    addon=$(jq -r --arg name "$name" '.addons[] | select(.name == $name)' "$ADDONS_FILE")
    printf "  %-22s %s\n" "name:"               "$(echo "$addon" | jq -r '.name')"
    printf "  %-22s %s\n" "description:"        "$(echo "$addon" | jq -r '.description // ""')"
    printf "  %-22s %s\n" "host:"               "$(echo "$addon" | jq -r '.host')"
    printf "  %-22s %s\n" "port:"               "$(echo "$addon" | jq -r '.port')"
    printf "  %-22s %s\n" "enabled:"            "$(echo "$addon" | jq -r '.enabled')"
    printf "  %-22s %s\n" "require_admin:"      "$(echo "$addon" | jq -r '.require_admin')"
    printf "  %-22s %s\n" "strip_prefix:"       "$(echo "$addon" | jq -r '.strip_prefix')"
    printf "  %-22s %s\n" "rewrite_origin:"     "$(echo "$addon" | jq -r '.rewrite_origin')"
    printf "  %-22s %s\n" "rate_limit:"         "$(echo "$addon" | jq -r '.rate_limit')"
    printf "  %-22s %s\n" "install_script_url:" "$(echo "$addon" | jq -r '.install_script_url')"
    printf "  %-22s %s\n" "allowed_ips:"        "$(echo "$addon" | jq -r '.allowed_ips | join(", ")')"
    echo ""
}

# List all addons in a summary table
list_addons() {
    echo ""
    printf "  %-4s  %-20s %-12s %-6s %-10s %-13s\n" "No." "NAME" "HOST" "PORT" "ENABLED" "REQUIRE_ADMIN"
    printf "  %-4s  %-20s %-12s %-6s %-10s %-13s\n" "---" "----" "----" "----" "-------" "-------------"
    local i=1
    while IFS= read -r name; do
        local host port enabled require_admin
        host=$(get_field "$name" "host")
        port=$(get_field "$name" "port")
        enabled=$(get_field "$name" "enabled")
        require_admin=$(get_field "$name" "require_admin")
        printf "  %-4s  %-20s %-12s %-6s %-10s %-13s\n" "$i." "$name" "$host" "$port" "$enabled" "$require_admin"
        (( i++ )) || true
    done < <(get_addon_names)
    echo ""
}

# Build addon names array into a global variable
load_addon_names() {
    ADDON_NAMES=()
    while IFS= read -r name; do
        ADDON_NAMES+=("$name")
    done < <(get_addon_names)
    [[ ${#ADDON_NAMES[@]} -gt 0 ]]
}

# Prompt user to pick an addon by number; sets SELECTED_ADDON
pick_addon() {
    local prompt="$1"

    if ! load_addon_names; then
        echo "No addons found in $ADDONS_FILE" >&2
        return 1
    fi

    list_addons
    echo "  0.    Back"
    echo ""

    while true; do
        read -rp "$prompt [0-${#ADDON_NAMES[@]}]: " choice
        [[ "$choice" == "0" ]] && return 1
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#ADDON_NAMES[@]} )); then
            SELECTED_ADDON="${ADDON_NAMES[$((choice - 1))]}"
            return 0
        fi
        echo "Invalid selection. Please enter a number between 0 and ${#ADDON_NAMES[@]}."
    done
}

# Check if an addon name is known in addons.json
# Usage: is_known_addon <name>  → returns 0 if known, 1 if not
is_known_addon() {
    local name="$1"
    local result
    result=$(jq -r --arg name "$name" '.addons[] | select(.name == $name) | .name' "$ADDONS_FILE")
    [[ -n "$result" && "$result" != "null" ]]
}

# Check if an addon is installed by looking for its docker-compose.yml
# Usage: is_addon_installed <name>  → returns 0 if installed, 1 if not
is_addon_installed() {
    local name="$1"
    [[ -f "$HOME/ubersdr/${name}/docker-compose.yml" ]]
}

# Control a specific addon: start / stop / restart via its ~/ubersdr/<name>/{start,stop,restart}.sh
control_addon_menu() {
    echo ""
    echo "Fetching live addon proxies from UberSDR..."
    local live_response
    live_response=$(_api_curl GET "/admin/addon-proxies") || {
        echo "Error: Could not reach UberSDR API." >&2
        return 1
    }

    local count
    count=$(echo "$live_response" | jq 'length')
    if [[ "$count" -eq 0 ]]; then
        echo "No addon proxies are currently registered in UberSDR."
        echo ""
        return 0
    fi

    # Only show addons that are actually installed (have docker-compose.yml)
    ADDON_NAMES=()
    while IFS= read -r name; do
        if is_known_addon "$name" && is_addon_installed "$name"; then
            ADDON_NAMES+=("$name")
        fi
    done < <(echo "$live_response" | jq -r '.[].name')

    if [[ ${#ADDON_NAMES[@]} -eq 0 ]]; then
        echo "No known installed addons found."
        echo ""
        return 0
    fi

    echo ""
    printf "  %-4s  %-20s\n" "No." "NAME"
    printf "  %-4s  %-20s\n" "---" "----"
    local i=1
    for name in "${ADDON_NAMES[@]}"; do
        printf "  %-4s  %-20s\n" "$i." "$name"
        (( i++ )) || true
    done
    printf "  %-4s  %-20s\n" "0." "Back"
    echo ""

    while true; do
        read -rp "Select addon to control [0-${#ADDON_NAMES[@]}]: " choice
        [[ "$choice" == "0" ]] && return 0
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#ADDON_NAMES[@]} )); then
            SELECTED_ADDON="${ADDON_NAMES[$((choice - 1))]}"
            break
        fi
        echo "Invalid selection."
    done

    local addon_dir="$HOME/ubersdr/${SELECTED_ADDON}"

    echo ""
    echo "--- Control addon: $SELECTED_ADDON ---"
    echo "  1) Start"
    echo "  2) Stop"
    echo "  3) Restart"
    echo "  0) Back"
    echo ""

    local action_script
    while true; do
        read -rp "Select action [0-3]: " action
        case "$action" in
            1) action_script="start.sh";   break ;;
            2) action_script="stop.sh";    break ;;
            3) action_script="restart.sh"; break ;;
            0) return 0 ;;
            *) echo "Invalid selection." ;;
        esac
    done

    local script_path="$addon_dir/$action_script"
    if [[ ! -f "$script_path" ]]; then
        echo "Error: $action_script not found at $script_path" >&2
        echo ""
        return 1
    fi

    echo ""
    echo "Running $action_script for '$SELECTED_ADDON'..."
    bash "$script_path"
    echo "Done."
    echo ""
}

# ---------------------------------------------------------------------------
# UberSDR Addon Proxy API (curl wrappers for /admin/addon-proxies)
# ---------------------------------------------------------------------------

UBERSDR_BASE_URL="${UBERSDR_BASE_URL:-http://localhost:8080}"

# Internal helper: run a curl call against the admin API using X-Admin-Password header.
# Usage: _api_curl <method> <path> [extra curl args...]
_api_curl() {
    local method="$1"
    local path="$2"
    shift 2
    local password
    password=$(get_admin_password) || return 1
    curl -s -X "$method" \
        -H "X-Admin-Password: ${password}" \
        -H "Content-Type: application/json" \
        "${UBERSDR_BASE_URL}${path}" \
        "$@"
}

# List all addon proxies currently registered in UberSDR.
# Outputs pretty-printed JSON.
api_list_addon_proxies() {
    _api_curl GET "/admin/addon-proxies" | jq .
}

# Add a new addon proxy from addons.json by name.
# Usage: api_add_addon_proxy <name>
api_add_addon_proxy() {
    local name="$1"
    local addon
    addon=$(jq -r --arg name "$name" '.addons[] | select(.name == $name)' "$ADDONS_FILE")
    if [[ -z "$addon" || "$addon" == "null" ]]; then
        echo "Error: addon '$name' not found in $ADDONS_FILE" >&2
        return 1
    fi

    # Build the JSON payload matching the addonProxyJSON struct
    local payload
    payload=$(echo "$addon" | jq '{
        name:           .name,
        enabled:        .enabled,
        host:           .host,
        port:           .port,
        strip_prefix:   .strip_prefix,
        require_admin:  .require_admin,
        rewrite_origin: .rewrite_origin,
        rate_limit:     .rate_limit,
        allowed_ips:    .allowed_ips
    }')

    echo "Registering addon proxy '$name' with UberSDR..."
    local response
    response=$(_api_curl POST "/admin/addon-proxies" -d "$payload")
    local status msg
    status=$(echo "$response" | jq -r '.status // "error"')
    msg=$(echo "$response" | jq -r '.message // .error // "Unknown error"')
    echo "  [$status] $msg"
}

# Update an existing addon proxy in UberSDR from addons.json by name.
# Usage: api_update_addon_proxy <name>
api_update_addon_proxy() {
    local name="$1"
    local addon
    addon=$(jq -r --arg name "$name" '.addons[] | select(.name == $name)' "$ADDONS_FILE")
    if [[ -z "$addon" || "$addon" == "null" ]]; then
        echo "Error: addon '$name' not found in $ADDONS_FILE" >&2
        return 1
    fi

    local payload
    payload=$(echo "$addon" | jq '{
        name:           .name,
        enabled:        .enabled,
        host:           .host,
        port:           .port,
        strip_prefix:   .strip_prefix,
        require_admin:  .require_admin,
        rewrite_origin: .rewrite_origin,
        rate_limit:     .rate_limit,
        allowed_ips:    .allowed_ips
    }')

    echo "Updating addon proxy '$name' in UberSDR..."
    local response
    response=$(_api_curl PUT "/admin/addon-proxies?name=$(jq -rn --arg n "$name" '$n | @uri')" -d "$payload")
    local status msg
    status=$(echo "$response" | jq -r '.status // "error"')
    msg=$(echo "$response" | jq -r '.message // .error // "Unknown error"')
    echo "  [$status] $msg"
}

# Delete an addon proxy from UberSDR by name.
# Usage: api_delete_addon_proxy <name>
api_delete_addon_proxy() {
    local name="$1"
    echo "Deleting addon proxy '$name' from UberSDR..."
    local response
    response=$(_api_curl DELETE "/admin/addon-proxies?name=$(jq -rn --arg n "$name" '$n | @uri')")
    local status msg
    status=$(echo "$response" | jq -r '.status // "error"')
    msg=$(echo "$response" | jq -r '.message // .error // "Unknown error"')
    echo "  [$status] $msg"
}

# Test connectivity to an addon proxy backend.
# Usage: api_test_addon_proxy <name>
api_test_addon_proxy() {
    local name="$1"
    echo "Testing connectivity for addon proxy '$name'..."
    _api_curl GET "/admin/addon-proxies/test?name=$(jq -rn --arg n "$name" '$n | @uri')" | jq .
}

# Toggle a live addon proxy enabled/disabled via PUT.
# Usage: api_toggle_addon_proxy <name> <true|false>
api_toggle_addon_proxy() {
    local name="$1"
    local new_state="$2"  # "true" or "false"
    local live_response
    live_response=$(_api_curl GET "/admin/addon-proxies") || return 1
    local current
    current=$(echo "$live_response" | jq --arg name "$name" '.[] | select(.name == $name)')
    if [[ -z "$current" || "$current" == "null" ]]; then
        echo "Error: addon proxy '$name' not found in UberSDR." >&2
        return 1
    fi
    local payload
    payload=$(echo "$current" | jq --argjson state "$new_state" 'del(.path) | .enabled = $state')
    local response
    response=$(_api_curl PUT "/admin/addon-proxies?name=$(jq -rn --arg n "$name" '$n | @uri')" -d "$payload")
    local status msg
    status=$(echo "$response" | jq -r '.status // "error"')
    msg=$(echo "$response" | jq -r '.message // .error // "Unknown error"')
    echo "  [$status] $msg"
}

# Interactive: pick a live addon and toggle its enabled state
toggle_addon_menu() {
    echo ""
    echo "Fetching live addon proxies from UberSDR..."
    local live_response
    live_response=$(_api_curl GET "/admin/addon-proxies") || {
        echo "Error: Could not reach UberSDR API." >&2
        return 1
    }

    local count
    count=$(echo "$live_response" | jq 'length')
    if [[ "$count" -eq 0 ]]; then
        echo "No addon proxies are currently registered in UberSDR."
        echo ""
        return 0
    fi

    # Only show installed addons
    ADDON_NAMES=()
    while IFS= read -r name; do
        if is_known_addon "$name" && is_addon_installed "$name"; then
            ADDON_NAMES+=("$name")
        fi
    done < <(echo "$live_response" | jq -r '.[].name')

    if [[ ${#ADDON_NAMES[@]} -eq 0 ]]; then
        echo "No known installed addons found."
        echo ""
        return 0
    fi

    echo ""
    printf "  %-4s  %-20s %-10s\n" "No." "NAME" "ENABLED"
    printf "  %-4s  %-20s %-10s\n" "---" "----" "-------"
    local i=1
    for name in "${ADDON_NAMES[@]}"; do
        local enabled
        enabled=$(echo "$live_response" | jq -r --arg n "$name" '.[] | select(.name == $n) | .enabled | tostring')
        printf "  %-4s  %-20s %-10s\n" "$i." "$name" "$enabled"
        (( i++ )) || true
    done
    printf "  %-4s  %-20s\n" "0." "Back"
    echo ""

    while true; do
        read -rp "Select addon to enable/disable [0-${#ADDON_NAMES[@]}]: " choice
        [[ "$choice" == "0" ]] && return 0
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#ADDON_NAMES[@]} )); then
            SELECTED_ADDON="${ADDON_NAMES[$((choice - 1))]}"
            break
        fi
        echo "Invalid selection."
    done

    local current_state
    current_state=$(echo "$live_response" | jq -r --arg n "$SELECTED_ADDON" '.[] | select(.name == $n) | .enabled | tostring')

    echo ""
    if [[ "$current_state" == "true" ]]; then
        read -rp "Addon '$SELECTED_ADDON' is currently ENABLED. Disable it? [y/N]: " confirm
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
            echo "Disabling '$SELECTED_ADDON'..."
            api_toggle_addon_proxy "$SELECTED_ADDON" false
        else
            echo "Cancelled."
        fi
    else
        read -rp "Addon '$SELECTED_ADDON' is currently DISABLED. Enable it? [y/N]: " confirm
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
            echo "Enabling '$SELECTED_ADDON'..."
            api_toggle_addon_proxy "$SELECTED_ADDON" true
        else
            echo "Cancelled."
        fi
    fi
    echo ""
}

# ---------------------------------------------------------------------------

# Get the UberSDR admin password from the Docker volume config
get_admin_password() {
    local config_path="/var/lib/docker/volumes/ubersdr_ubersdr-config/_data/config.yaml"
    if ! sudo test -f "$config_path"; then
        echo "Error: Config file not found at $config_path" >&2
        return 1
    fi
    local password
    password=$(sudo grep -A 2 "^admin:" "$config_path" | grep "password:" | sed 's/.*password: *"\(.*\)".*/\1/')
    if [[ -z "$password" ]]; then
        echo "Error: Could not extract password from config file" >&2
        return 1
    fi
    echo "$password"
}

# Show addon proxies currently registered and enabled in the live UberSDR instance.
show_live_addons() {
    echo ""
    echo "Fetching live addon proxies from UberSDR..."
    local response
    response=$(_api_curl GET "/admin/addon-proxies") || return 1

    local count
    count=$(echo "$response" | jq 'length')
    if [[ "$count" -eq 0 ]]; then
        echo "No addon proxies are currently registered."
        echo ""
        return 0
    fi

    echo ""
    printf "  %-20s %-12s %-6s %-10s %-10s %-10s %-6s\n" "NAME" "HOST" "PORT" "ENABLED" "REQ_ADMIN" "INSTALLED" "PATH"
    printf "  %-20s %-12s %-6s %-10s %-10s %-10s %-6s\n" "----" "----" "----" "-------" "---------" "---------" "----"
    echo "$response" | jq -r '.[] | [.name, .host, (.port|tostring), (.enabled|tostring), (.require_admin|tostring), .path] | @tsv' \
        | while IFS=$'\t' read -r name host port enabled req_admin path; do
            # Skip proxies not known in addons.json
            is_known_addon "$name" || continue
            local installed_flag
            if is_addon_installed "$name"; then
                installed_flag="yes"
            else
                installed_flag="no"
            fi
            printf "  %-20s %-12s %-6s %-10s %-10s %-10s %-6s\n" "$name" "$host" "$port" "$enabled" "$req_admin" "$installed_flag" "$path"
        done
    echo ""
}

# Test connectivity to a live addon proxy backend.
test_addon_connectivity() {
    echo ""
    echo "Fetching live addon proxies from UberSDR..."
    local live_response
    live_response=$(_api_curl GET "/admin/addon-proxies") || {
        echo "Error: Could not reach UberSDR API." >&2
        return 1
    }

    local count
    count=$(echo "$live_response" | jq 'length')
    if [[ "$count" -eq 0 ]]; then
        echo "No addon proxies are currently registered in UberSDR."
        echo ""
        return 0
    fi

    # Build a names array — all registered proxies (test doesn't require local install)
    ADDON_NAMES=()
    while IFS= read -r name; do
        if is_known_addon "$name"; then
            ADDON_NAMES+=("$name")
        fi
    done < <(echo "$live_response" | jq -r '.[].name')

    if [[ ${#ADDON_NAMES[@]} -eq 0 ]]; then
        echo "No known addon proxies are currently registered in UberSDR."
        echo ""
        return 0
    fi

    echo ""
    printf "  %-4s  %-20s %-10s\n" "No." "NAME" "INSTALLED"
    printf "  %-4s  %-20s %-10s\n" "---" "----" "---------"
    local i=1
    for name in "${ADDON_NAMES[@]}"; do
        local installed_flag
        if is_addon_installed "$name"; then installed_flag="yes"; else installed_flag="no"; fi
        printf "  %-4s  %-20s %-10s\n" "$i." "$name" "$installed_flag"
        (( i++ )) || true
    done
    printf "  %-4s  %-20s\n" "0." "Back"
    echo ""

    while true; do
        read -rp "Select addon to test [0-${#ADDON_NAMES[@]}]: " choice
        [[ "$choice" == "0" ]] && return 0
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#ADDON_NAMES[@]} )); then
            SELECTED_ADDON="${ADDON_NAMES[$((choice - 1))]}"
            break
        fi
        echo "Invalid selection."
    done

    echo ""
    echo "Testing connectivity for '$SELECTED_ADDON'..."
    local test_response
    test_response=$(_api_curl GET "/admin/addon-proxies/test?name=$(jq -rn --arg n "$SELECTED_ADDON" '$n | @uri')")
    local success status_code error_msg url
    success=$(echo "$test_response" | jq -r '.success')
    status_code=$(echo "$test_response" | jq -r '.status_code')
    error_msg=$(echo "$test_response" | jq -r '.error')
    url=$(echo "$test_response" | jq -r '.url')

    echo "  URL:     $url"
    if [[ "$success" == "true" ]]; then
        echo "  Result:  ✓ Reachable (HTTP $status_code)"
    else
        echo "  Result:  ✗ Not reachable"
        echo "  Error:   $error_msg"
    fi
    echo ""
}

# Show the UI password for an installed addon (reads ~/ubersdr/<name>/.config_pass)
show_ui_password_menu() {
    # Build list of installed known addons
    ADDON_NAMES=()
    while IFS= read -r name; do
        if is_known_addon "$name" && is_addon_installed "$name"; then
            ADDON_NAMES+=("$name")
        fi
    done < <(get_addon_names)

    if [[ ${#ADDON_NAMES[@]} -eq 0 ]]; then
        echo ""
        echo "No known installed addons found."
        echo ""
        return 0
    fi

    echo ""
    printf "  %-4s  %-20s\n" "No." "NAME"
    printf "  %-4s  %-20s\n" "---" "----"
    local i=1
    for name in "${ADDON_NAMES[@]}"; do
        printf "  %-4s  %-20s\n" "$i." "$name"
        (( i++ )) || true
    done
    printf "  %-4s  %-20s\n" "0." "Back"
    echo ""

    while true; do
        read -rp "Select addon to show UI password [0-${#ADDON_NAMES[@]}]: " choice
        [[ "$choice" == "0" ]] && return 0
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#ADDON_NAMES[@]} )); then
            SELECTED_ADDON="${ADDON_NAMES[$((choice - 1))]}"
            break
        fi
        echo "Invalid selection."
    done

    local pass_file="$HOME/ubersdr/${SELECTED_ADDON}/.config_pass"
    if [[ ! -f "$pass_file" ]]; then
        echo ""
        echo "Error: password file not found at $pass_file" >&2
        echo "       Has install.sh been run yet?" >&2
        echo ""
        return 1
    fi

    local pass
    pass="$(cat "$pass_file")"
    local addon_url="http://ubersdr.local/addon/${SELECTED_ADDON}/"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ADDON: $SELECTED_ADDON"
    echo ""
    echo "  URL:  ${addon_url}"
    echo ""
    echo "  UI PASSWORD:  ${pass}"
    echo "  (protects write actions in the web UI)"
    echo "  Stored at: ${pass_file}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
}

# Delete and destroy an addon: stop it, then remove its directory entirely.
delete_addon_menu() {
    echo ""
    echo "Fetching live addon proxies from UberSDR..."
    local live_response
    live_response=$(_api_curl GET "/admin/addon-proxies") || {
        echo "Error: Could not reach UberSDR API." >&2
        return 1
    }

    # Only show addons that are actually installed (have docker-compose.yml)
    ADDON_NAMES=()
    while IFS= read -r name; do
        if is_known_addon "$name" && is_addon_installed "$name"; then
            ADDON_NAMES+=("$name")
        fi
    done < <(echo "$live_response" | jq -r '.[].name')

    if [[ ${#ADDON_NAMES[@]} -eq 0 ]]; then
        echo "No known installed addons found."
        echo ""
        return 0
    fi

    echo ""
    printf "  %-4s  %-20s\n" "No." "NAME"
    printf "  %-4s  %-20s\n" "---" "----"
    local i=1
    for name in "${ADDON_NAMES[@]}"; do
        printf "  %-4s  %-20s\n" "$i." "$name"
        (( i++ )) || true
    done
    printf "  %-4s  %-20s\n" "0." "Back"
    echo ""

    while true; do
        read -rp "Select addon to delete [0-${#ADDON_NAMES[@]}]: " choice
        [[ "$choice" == "0" ]] && return 0
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#ADDON_NAMES[@]} )); then
            SELECTED_ADDON="${ADDON_NAMES[$((choice - 1))]}"
            break
        fi
        echo "Invalid selection."
    done

    local addon_dir="$HOME/ubersdr/${SELECTED_ADDON}"

    # Stop the addon first (best-effort — don't abort if stop.sh is missing)
    local stop_script="$addon_dir/stop.sh"
    if [[ -f "$stop_script" ]]; then
        echo ""
        echo "Stopping addon '$SELECTED_ADDON'..."
        bash "$stop_script" || true
    else
        echo "Warning: stop.sh not found at $stop_script — skipping stop step." >&2
    fi

    # Confirm before deleting
    echo ""
    echo "WARNING: This will permanently delete the following directory:"
    echo "  $addon_dir"
    echo ""
    read -rp "Are you sure you want to delete '$SELECTED_ADDON'? Type 'yes' to confirm: " confirm
    if [[ "$confirm" != "yes" ]]; then
        echo "Cancelled — directory was NOT deleted."
        echo ""
        return 0
    fi

    echo "Deleting $addon_dir ..."
    rm -rf "$addon_dir"
    echo "  Directory removed."

    # Remove the addon proxy from UberSDR
    echo "Removing addon proxy '$SELECTED_ADDON' from UberSDR..."
    api_delete_addon_proxy "$SELECTED_ADDON"

    echo "Done. '$SELECTED_ADDON' has been fully removed."
    echo ""
}

# Main menu
main_menu() {
    while true; do
        echo ""
        echo "==============================="
        echo "   UberSDR Addon Manager"
        echo "==============================="
        echo "  1) List available addons"
        echo "  2) Install/update a specific addon"
        echo "  3) Show addon details"
        echo "  4) Show live registered addons"
        echo "  5) Test addon connectivity"
        echo "  6) Enable/disable an addon"
        echo "  7) Control an addon"
        echo "  8) Show UI password"
        echo "  9) Delete and destroy an addon"
        echo " 10) Exit"
        echo ""
        read -rp "Select an option [1-10]: " opt
        echo ""

        case "$opt" in
            1)
                list_addons
                ;;
            2)
                SELECTED_ADDON=""
                if pick_addon "Select addon to install"; then
                    install_addon "$SELECTED_ADDON"
                fi
                ;;
            3)
                SELECTED_ADDON=""
                if pick_addon "Select addon to view details"; then
                    show_addon_info "$SELECTED_ADDON"
                fi
                ;;
            4)
                show_live_addons
                ;;
            5)
                test_addon_connectivity
                ;;
            6)
                toggle_addon_menu
                ;;
            7)
                control_addon_menu
                ;;
            8)
                show_ui_password_menu
                ;;
            9)
                delete_addon_menu
                ;;
            10)
                echo "Goodbye."
                exit 0
                ;;
            *)
                echo "Invalid option. Please choose 1-10."
                ;;
        esac
    done
}

main_menu
