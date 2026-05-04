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

    echo ""
    read -rp "Restart UberSDR now to apply proxy changes? [y/N]: " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        api_restart_ubersdr
    else
        echo "Skipping restart. Remember to restart UberSDR manually to activate the addon proxy."
    fi
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

    while true; do
        read -rp "$prompt [1-${#ADDON_NAMES[@]}]: " choice
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#ADDON_NAMES[@]} )); then
            SELECTED_ADDON="${ADDON_NAMES[$((choice - 1))]}"
            return 0
        fi
        echo "Invalid selection. Please enter a number between 1 and ${#ADDON_NAMES[@]}."
    done
}

# Install all enabled addons
install_all_enabled() {
    local installed=0
    local skipped=0
    echo ""
    while IFS= read -r name; do
        local enabled
        enabled=$(get_field "$name" "enabled")
        if [[ "$enabled" == "true" ]]; then
            install_addon "$name"
            (( installed++ )) || true
        else
            echo "  Skipping '$name' (enabled: false)"
            (( skipped++ )) || true
        fi
    done < <(get_addon_names)
    echo ""
    echo "Done. Installed: $installed, Skipped (disabled): $skipped"
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

# Restart the UberSDR server to apply addon proxy changes.
api_restart_ubersdr() {
    echo "Restarting UberSDR server..."
    local response
    response=$(_api_curl POST "/admin/addon-proxies/restart")
    local status msg
    status=$(echo "$response" | jq -r '.status // "error"')
    msg=$(echo "$response" | jq -r '.message // .error // "Unknown error"')
    echo "  [$status] $msg"
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
    printf "  %-20s %-12s %-6s %-10s %-10s %-6s\n" "NAME" "HOST" "PORT" "ENABLED" "REQ_ADMIN" "PATH"
    printf "  %-20s %-12s %-6s %-10s %-10s %-6s\n" "----" "----" "----" "-------" "---------" "----"
    echo "$response" | jq -r '.[] | [.name, .host, (.port|tostring), (.enabled|tostring), (.require_admin|tostring), .path] | @tsv' \
        | while IFS=$'\t' read -r name host port enabled req_admin path; do
            printf "  %-20s %-12s %-6s %-10s %-10s %-6s\n" "$name" "$host" "$port" "$enabled" "$req_admin" "$path"
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

    # Build a names array from the live list
    ADDON_NAMES=()
    while IFS= read -r name; do
        ADDON_NAMES+=("$name")
    done < <(echo "$live_response" | jq -r '.[].name')

    echo ""
    printf "  %-4s  %-20s\n" "No." "NAME"
    printf "  %-4s  %-20s\n" "---" "----"
    local i=1
    for name in "${ADDON_NAMES[@]}"; do
        printf "  %-4s  %-20s\n" "$i." "$name"
        (( i++ )) || true
    done
    echo ""

    while true; do
        read -rp "Select addon to test [1-${#ADDON_NAMES[@]}]: " choice
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

# Main menu
main_menu() {
    while true; do
        echo ""
        echo "==============================="
        echo "   UberSDR Addon Manager"
        echo "==============================="
        echo "  1) List available addons"
        echo "  2) Install a specific addon"
        echo "  3) Install all enabled addons"
        echo "  4) Show addon details"
        echo "  5) Show live registered addons"
        echo "  6) Test addon connectivity"
        echo "  7) Exit"
        echo ""
        read -rp "Select an option [1-7]: " opt
        echo ""

        case "$opt" in
            1)
                list_addons
                ;;
            2)
                SELECTED_ADDON=""
                pick_addon "Select addon to install"
                install_addon "$SELECTED_ADDON"
                ;;
            3)
                echo "Installing all enabled addons..."
                install_all_enabled
                ;;
            4)
                SELECTED_ADDON=""
                pick_addon "Select addon to view details"
                show_addon_info "$SELECTED_ADDON"
                ;;
            5)
                show_live_addons
                ;;
            6)
                test_addon_connectivity
                ;;
            7)
                echo "Goodbye."
                exit 0
                ;;
            *)
                echo "Invalid option. Please choose 1-7."
                ;;
        esac
    done
}

main_menu
