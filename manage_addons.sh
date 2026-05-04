#!/usr/bin/env bash
set -euo pipefail

ADDONS_FILE="$(dirname "$(realpath "$0")")/addons.yaml"

# Dependency check
for cmd in curl yq; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: '$cmd' is required but not installed." >&2
        exit 1
    fi
done

# Get all addon names
get_addon_names() {
    yq e '.addons[].name' "$ADDONS_FILE"
}

# Get a field value for a named addon
get_field() {
    local name="$1"
    local field="$2"
    yq e ".addons[] | select(.name == \"$name\") | .$field" "$ADDONS_FILE"
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
}

# Show full info for one addon
show_addon_info() {
    local name="$1"
    echo ""
    echo "=== Addon: $name ==="
    local fields=(host port enabled require_admin strip_prefix rewrite_ws_prefix rate_limit install_script_url)
    for field in "${fields[@]}"; do
        local val
        val=$(get_field "$name" "$field")
        printf "  %-22s %s\n" "$field:" "$val"
    done
    # allowed_ips is a list
    echo "  allowed_ips:"
    yq e ".addons[] | select(.name == \"$name\") | .allowed_ips[]" "$ADDONS_FILE" | while IFS= read -r ip; do
        echo "    - $ip"
    done
    echo ""
}

# List all addons in a summary table
list_addons() {
    echo ""
    printf "  %-4s  %-20s %-12s %-6s %-10s %-10s\n" "No." "NAME" "HOST" "PORT" "ENABLED" "REQUIRE_ADMIN"
    printf "  %-4s  %-20s %-12s %-6s %-10s %-10s\n" "---" "----" "----" "----" "-------" "-------------"
    local i=1
    while IFS= read -r name; do
        local host port enabled require_admin
        host=$(get_field "$name" "host")
        port=$(get_field "$name" "port")
        enabled=$(get_field "$name" "enabled")
        require_admin=$(get_field "$name" "require_admin")
        printf "  %-4s  %-20s %-12s %-6s %-10s %-10s\n" "$i." "$name" "$host" "$port" "$enabled" "$require_admin"
        (( i++ )) || true
    done < <(get_addon_names)
    echo ""
}

# Prompt user to pick an addon by number
pick_addon() {
    local prompt="$1"
    local names=()
    while IFS= read -r name; do
        names+=("$name")
    done < <(get_addon_names)

    if [[ ${#names[@]} -eq 0 ]]; then
        echo "No addons found in $ADDONS_FILE" >&2
        return 1
    fi

    list_addons

    while true; do
        read -rp "$prompt [1-${#names[@]}]: " choice
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#names[@]} )); then
            echo "${names[$((choice - 1))]}"
            return 0
        fi
        echo "Invalid selection. Please enter a number between 1 and ${#names[@]}."
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

# Main menu
main_menu() {
    while true; do
        echo ""
        echo "==============================="
        echo "   UberSDR Addon Manager"
        echo "==============================="
        echo "  1) List all addons"
        echo "  2) Install a specific addon"
        echo "  3) Install all enabled addons"
        echo "  4) Show addon details"
        echo "  5) Exit"
        echo ""
        read -rp "Select an option [1-5]: " opt
        echo ""

        case "$opt" in
            1)
                list_addons
                ;;
            2)
                selected=$(pick_addon "Select addon to install")
                install_addon "$selected"
                ;;
            3)
                echo "Installing all enabled addons..."
                install_all_enabled
                ;;
            4)
                selected=$(pick_addon "Select addon to view details")
                show_addon_info "$selected"
                ;;
            5)
                echo "Goodbye."
                exit 0
                ;;
            *)
                echo "Invalid option. Please choose 1-5."
                ;;
        esac
    done
}

main_menu
