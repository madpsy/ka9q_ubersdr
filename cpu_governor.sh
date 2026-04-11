#!/usr/bin/env bash
# cpu_governor.sh - Interactive CPU governor manager for UberSDR
# Requires cpupower (linux-cpupower / cpupower package)

set -euo pipefail

# ─── Colours ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

# ─── Helpers ────────────────────────────────────────────────────────────────
info()   { echo -e "${CYAN}[INFO]${RESET}  $*"; }
ok()     { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()   { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()  { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
die()    { error "$*"; exit 1; }
header() {
    echo -e "\n${BOLD}${CYAN}══════════════════════════════════════════${RESET}"
    echo -e "${BOLD}${CYAN}  $*${RESET}"
    echo -e "${BOLD}${CYAN}══════════════════════════════════════════${RESET}\n"
}

# ─── Dependency checks ──────────────────────────────────────────────────────
check_deps() {
    if ! command -v cpupower &>/dev/null; then
        die "'cpupower' not found. Install with: sudo apt install linux-cpupower"
    fi
    if [[ $EUID -ne 0 ]]; then
        die "This script must be run as root (use: sudo $0)"
    fi
}

# ─── Read current state ─────────────────────────────────────────────────────
get_current_governor() {
    cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo "unknown"
}

get_available_governors() {
    cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors 2>/dev/null || echo ""
}

get_cpu_freq_mhz() {
    local freq
    freq=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null || echo "0")
    echo $(( freq / 1000 ))
}

get_all_cpu_freqs_mhz() {
    local i=0
    for freq_file in /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq; do
        local freq
        freq=$(cat "$freq_file" 2>/dev/null || echo "0")
        echo "cpu${i}:$(( freq / 1000 ))"
        (( i++ ))
    done
}

get_cpu_max_freq_mhz() {
    local freq
    freq=$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null || echo "0")
    echo $(( freq / 1000 ))
}

get_cpu_min_freq_mhz() {
    local freq
    freq=$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_min_freq 2>/dev/null || echo "0")
    echo $(( freq / 1000 ))
}

get_cpu_count() {
    nproc --all 2>/dev/null || echo "?"
}

# ─── Display current status ─────────────────────────────────────────────────
show_status() {
    local current gov_colour
    current=$(get_current_governor)
    local cur_mhz max_mhz min_mhz cpus
    cur_mhz=$(get_cpu_freq_mhz)
    max_mhz=$(get_cpu_max_freq_mhz)
    min_mhz=$(get_cpu_min_freq_mhz)
    cpus=$(get_cpu_count)

    case "$current" in
        performance) gov_colour="${GREEN}" ;;
        powersave)   gov_colour="${YELLOW}" ;;
        ondemand)    gov_colour="${YELLOW}" ;;
        *)           gov_colour="${CYAN}" ;;
    esac

    echo -e "  CPUs detected   : ${BOLD}${cpus}${RESET}"
    echo -e "  Current governor: ${gov_colour}${BOLD}${current}${RESET}"
    echo -e "  Min / Max freq  : ${min_mhz} MHz / ${max_mhz} MHz"

    # Per-core frequencies
    local all_freqs
    mapfile -t all_freqs < <(get_all_cpu_freqs_mhz)
    if [[ ${#all_freqs[@]} -gt 0 ]]; then
        # Check if all cores are at the same frequency
        local unique_freqs
        unique_freqs=$(printf '%s\n' "${all_freqs[@]}" | cut -d: -f2 | sort -u)
        local unique_count
        unique_count=$(echo "$unique_freqs" | wc -l)
        if [[ $unique_count -eq 1 ]]; then
            echo -e "  Current freq    : ${BOLD}${unique_freqs} MHz${RESET} (all cores)"
        else
            echo -e "  Per-core freq   :"
            local cols=4
            local col=0
            local line=""
            for entry in "${all_freqs[@]}"; do
                local cpu_id freq_val
                cpu_id="${entry%%:*}"
                freq_val="${entry##*:}"
                line+="    $(printf '%-6s' "${cpu_id}:")"
                line+="$(printf '%4s MHz' "${freq_val}")  "
                (( col++ ))
                if (( col >= cols )); then
                    echo -e "$line"
                    line=""
                    col=0
                fi
            done
            [[ -n "$line" ]] && echo -e "$line"
        fi
    else
        echo -e "  Current freq    : ${BOLD}${cur_mhz} MHz${RESET}"
    fi

    # Show per-CPU governors if they differ
    local governors=()
    for gov_file in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        governors+=("$(cat "$gov_file" 2>/dev/null)")
    done
    local unique
    unique=$(printf '%s\n' "${governors[@]}" | sort -u | tr '\n' ' ')
    if [[ $(echo "$unique" | wc -w) -gt 1 ]]; then
        warn "CPUs have mixed governors: $unique"
    fi

    echo ""
    detect_persistence
}

# ─── Detect persistence ──────────────────────────────────────────────────────
ONESHOT_SERVICE_NAME="cpu-governor"
ONESHOT_SERVICE_PATH="/etc/systemd/system/${ONESHOT_SERVICE_NAME}.service"

detect_persistence() {
    local persisted=""

    # Check our oneshot service first
    if [[ -f "$ONESHOT_SERVICE_PATH" ]]; then
        persisted=$(grep -oP '(?<=-g )\S+' "$ONESHOT_SERVICE_PATH" 2>/dev/null || true)
        if [[ -n "$persisted" ]]; then
            local enabled_state
            enabled_state=$(systemctl is-enabled "${ONESHOT_SERVICE_NAME}.service" 2>/dev/null || echo "disabled")
            if [[ "$enabled_state" == "enabled" ]]; then
                info "Persistent governor (systemd ${ONESHOT_SERVICE_NAME}.service): ${BOLD}${persisted}${RESET}"
            else
                warn "Service ${ONESHOT_SERVICE_NAME}.service exists but is ${BOLD}not enabled${RESET} — governor won't persist on reboot."
            fi
            return
        fi
    fi

    # Fall back to /etc/default/cpupower
    if [[ -f /etc/default/cpupower ]]; then
        persisted=$(grep -E '^CPU_DEFAULT_GOVERNOR=' /etc/default/cpupower 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
    fi

    if [[ -n "$persisted" ]]; then
        info "Persistent governor (/etc/default/cpupower): ${BOLD}${persisted}${RESET}"
    else
        info "No persistence configured — governor resets to system default on reboot."
    fi
}

# ─── Apply governor ──────────────────────────────────────────────────────────
apply_governor() {
    local governor="$1"
    info "Applying governor '${BOLD}${governor}${RESET}' to all CPUs..."

    if ! cpupower frequency-set -g "$governor" &>/dev/null; then
        die "cpupower failed to set governor '$governor'"
    fi

    local actual
    actual=$(get_current_governor)
    if [[ "$actual" == "$governor" ]]; then
        ok "Governor successfully set to '${BOLD}${governor}${RESET}'"
        local cur_mhz
        cur_mhz=$(get_cpu_freq_mhz)
        ok "Current CPU frequency: ${BOLD}${cur_mhz} MHz${RESET}"
    else
        error "Verification failed — governor reads '${actual}' instead of '${governor}'"
        return 1
    fi
}

# ─── Persist governor via oneshot systemd service ────────────────────────────
persist_governor() {
    local governor="$1"
    local cpupower_bin
    cpupower_bin=$(command -v cpupower)

    info "Writing oneshot systemd service to ${ONESHOT_SERVICE_PATH} ..."

    cat > "$ONESHOT_SERVICE_PATH" <<EOF
[Unit]
Description=Set CPU governor to ${governor}
After=multi-user.target

[Service]
Type=oneshot
ExecStart=${cpupower_bin} frequency-set -g ${governor}
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

    ok "Service unit written to ${ONESHOT_SERVICE_PATH}"

    systemctl daemon-reload && ok "systemd daemon reloaded"

    if systemctl enable "${ONESHOT_SERVICE_NAME}.service" &>/dev/null; then
        ok "${ONESHOT_SERVICE_NAME}.service enabled (will run on every boot)"
    else
        warn "Failed to enable ${ONESHOT_SERVICE_NAME}.service — persistence may not work"
    fi

    if systemctl restart "${ONESHOT_SERVICE_NAME}.service" &>/dev/null; then
        ok "${ONESHOT_SERVICE_NAME}.service started"
    else
        warn "Failed to start ${ONESHOT_SERVICE_NAME}.service (governor was already applied directly)"
    fi
}

# ─── Remove persistence ───────────────────────────────────────────────────────
remove_persistence() {
    local removed=0

    # Remove our oneshot service
    if [[ -f "$ONESHOT_SERVICE_PATH" ]]; then
        systemctl disable "${ONESHOT_SERVICE_NAME}.service" &>/dev/null || true
        systemctl stop "${ONESHOT_SERVICE_NAME}.service" &>/dev/null || true
        rm -f "$ONESHOT_SERVICE_PATH"
        systemctl daemon-reload
        ok "Removed ${ONESHOT_SERVICE_PATH} and disabled ${ONESHOT_SERVICE_NAME}.service"
        removed=1
    fi

    # Also clean up legacy /etc/default/cpupower entry if present
    if [[ -f /etc/default/cpupower ]] && grep -q '^CPU_DEFAULT_GOVERNOR=' /etc/default/cpupower 2>/dev/null; then
        sed -i '/^CPU_DEFAULT_GOVERNOR=/d' /etc/default/cpupower
        ok "Removed CPU_DEFAULT_GOVERNOR line from /etc/default/cpupower"
        removed=1
    fi

    if [[ $removed -eq 0 ]]; then
        info "No persistence configuration found to remove."
    fi
}

# ─── Governor description ────────────────────────────────────────────────────
governor_description() {
    case "$1" in
        performance)  echo "Always runs at maximum frequency. Best for real-time SDR. Uses more power." ;;
        powersave)    echo "Always runs at minimum frequency. Saves power but may hurt real-time performance." ;;
        ondemand)     echo "Scales up on load, but has ramp-up latency. May cause audio stuttering." ;;
        conservative) echo "Like ondemand but scales more gradually. Not ideal for SDR." ;;
        schedutil)    echo "Kernel scheduler-driven scaling. Better than ondemand, still has latency." ;;
        userspace)    echo "Manual frequency control. Advanced use only." ;;
        *)            echo "No description available." ;;
    esac
}

# ─── Main menu ───────────────────────────────────────────────────────────────
main() {
    check_deps

    header "UberSDR CPU Governor Manager"
    show_status

    local avail_str
    avail_str=$(get_available_governors)
    if [[ -z "$avail_str" ]]; then
        die "No available governors found. Is cpufreq support enabled in the kernel?"
    fi

    read -ra avail_governors <<< "$avail_str"
    local current
    current=$(get_current_governor)

    echo -e "\n${BOLD}Available governors:${RESET}\n"
    local i=1
    for gov in "${avail_governors[@]}"; do
        local marker="" rec=""
        [[ "$gov" == "$current" ]] && marker=" ${GREEN}← current${RESET}"
        [[ "$gov" == "performance" ]] && rec=" ${YELLOW}(recommended for UberSDR)${RESET}"
        echo -e "  ${BOLD}${i})${RESET} $(printf '%-14s' "$gov") $(governor_description "$gov")${marker}${rec}"
        (( i++ ))
    done

    echo ""
    echo -e "  ${BOLD}q)${RESET} Quit without changes"
    echo ""

    # Governor selection
    local chosen_gov=""
    while true; do
        read -rp "$(echo -e "${BOLD}Select governor [1-${#avail_governors[@]}/q]:${RESET} ")" choice
        if [[ "$choice" == "q" || "$choice" == "Q" ]]; then
            info "No changes made. Exiting."
            exit 0
        fi
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#avail_governors[@]} )); then
            chosen_gov="${avail_governors[$((choice-1))]}"
            break
        fi
        warn "Invalid selection. Enter a number between 1 and ${#avail_governors[@]}, or 'q' to quit."
    done

    if [[ "$chosen_gov" == "$current" ]]; then
        info "Governor is already set to '${BOLD}${chosen_gov}${RESET}'. No change needed."
    else
        echo ""
        echo -e "  You selected: ${BOLD}${chosen_gov}${RESET}"
        echo -e "  $(governor_description "$chosen_gov")"
        echo ""
        read -rp "$(echo -e "${BOLD}Apply this governor now? [Y/n]:${RESET} ")" confirm
        confirm="${confirm:-Y}"
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
            apply_governor "$chosen_gov"
        else
            info "Aborted. No changes made."
            exit 0
        fi
    fi

    # Persistence prompt
    echo ""
    echo -e "${BOLD}Persistence options:${RESET}"
    echo -e "  ${BOLD}1)${RESET} Apply for this session only (resets on reboot)"
    echo -e "  ${BOLD}2)${RESET} Make persistent across reboots (via /etc/default/cpupower)"
    echo -e "  ${BOLD}3)${RESET} Remove persistence (revert to system default on reboot)"
    echo ""
    read -rp "$(echo -e "${BOLD}Choose persistence option [1/2/3]:${RESET} ")" persist_choice
    persist_choice="${persist_choice:-1}"

    case "$persist_choice" in
        1)
            ok "Governor set for this session only. Will revert to system default on reboot."
            ;;
        2)
            persist_governor "$chosen_gov"
            ok "Governor '${BOLD}${chosen_gov}${RESET}' will be applied automatically on every boot."
            ;;
        3)
            remove_persistence
            ok "Persistence removed. On next reboot, the system default governor will be used."
            ;;
        *)
            warn "Invalid choice — treating as session-only (option 1)."
            ;;
    esac

    echo ""
    header "Final Status"
    show_status
}

main "$@"
