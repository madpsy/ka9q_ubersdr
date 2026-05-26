#!/usr/bin/env bash
# cpu_governor.sh - Interactive CPU governor manager for UberSDR
#
# On x86 systems: uses cpupower to set a single governor for all CPUs.
# On ARM big.LITTLE / DynamIQ systems: detects per-cluster cpufreq policies
# and lets the user set a different governor per cluster (e.g. performance
# on big/prime cores, powersave on LITTLE cores).
#
# Persistence is via a oneshot systemd service that writes the governor
# directly to /sys/devices/system/cpu/cpufreq/policyN/scaling_governor for
# each policy (no cpupower dependency on ARM).

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

sysread() { cat "$1" 2>/dev/null || echo ""; }

# ─── ARM architecture detection & helpers ───────────────────────────────────

IS_ARM=false
case "$(uname -m 2>/dev/null)" in
    aarch64|armv7l|armv8l) IS_ARM=true ;;
esac
if grep -q 'CPU implementer' /proc/cpuinfo 2>/dev/null; then IS_ARM=true; fi

# arm_cpu_part_name IMPLEMENTER PART → human name
arm_cpu_part_name() {
    local impl="${1:-}" part="${2:-}"
    case "${impl}:${part}" in
        0x41:0xd03) echo "Cortex-A53" ;;
        0x41:0xd04) echo "Cortex-A35" ;;
        0x41:0xd05) echo "Cortex-A55" ;;
        0x41:0xd06) echo "Cortex-A65" ;;
        0x41:0xd07) echo "Cortex-A57" ;;
        0x41:0xd08) echo "Cortex-A72" ;;
        0x41:0xd09) echo "Cortex-A73" ;;
        0x41:0xd0a) echo "Cortex-A75" ;;
        0x41:0xd0b) echo "Cortex-A76" ;;
        0x41:0xd0c) echo "Neoverse-N1" ;;
        0x41:0xd0d) echo "Cortex-A77" ;;
        0x41:0xd41) echo "Cortex-A78" ;;
        0x41:0xd44) echo "Cortex-X1" ;;
        0x41:0xd46) echo "Cortex-A510" ;;
        0x41:0xd47) echo "Cortex-A710" ;;
        0x41:0xd48) echo "Cortex-X2" ;;
        0x41:0xd4d) echo "Cortex-A715" ;;
        0x41:0xd4e) echo "Cortex-X3" ;;
        0x51:0x800) echo "Kryo 2xx Gold" ;;
        0x51:0x801) echo "Kryo 2xx Silver" ;;
        0x51:0x803) echo "Kryo 3xx Silver" ;;
        0x51:0x804) echo "Kryo 4xx Gold" ;;
        0x51:0x805) echo "Kryo 4xx Silver" ;;
        *) echo "Unknown (impl=${impl} part=${part})" ;;
    esac
}

# arm_cluster_role NAME → LITTLE | big | prime | ""
arm_cluster_role() {
    case "$1" in
        *A53*|*A55*|*A35*|*A510*|*"Kryo 2xx Silver"*|*"Kryo 3xx Silver"*|*"Kryo 4xx Silver"*) echo "LITTLE" ;;
        *A57*|*A72*|*A73*|*A75*|*A76*|*A77*|*A78*|*A710*|*A715*|*"Kryo 2xx Gold"*|*"Kryo 4xx Gold"*) echo "big" ;;
        *X1*|*X2*|*X3*|*Neoverse*) echo "prime" ;;
        *) echo "" ;;
    esac
}

# ─── Policy discovery ────────────────────────────────────────────────────────
# Populates parallel arrays indexed 0..N-1:
#   POLICY_DIRS[]    → /sys/devices/system/cpu/cpufreq/policyN
#   POLICY_NAMES[]   → "policy0", "policy4", …
#   POLICY_CPUS[]    → "0-3", "4-7", …
#   POLICY_GOVS[]    → current governor
#   POLICY_AVAIL[]   → space-separated available governors
#   POLICY_CUR_KHZ[] → current freq in kHz
#   POLICY_MIN_KHZ[] → min freq in kHz
#   POLICY_MAX_KHZ[] → max freq in kHz
#   POLICY_CNAME[]   → cluster CPU name (ARM only, else "")
#   POLICY_CROLE[]   → cluster role: LITTLE/big/prime/"" (ARM only)
#
# Also sets:
#   ARM_IS_HETEROGENEOUS → true when >1 distinct role found

declare -a POLICY_DIRS=()
declare -a POLICY_NAMES=()
declare -a POLICY_CPUS=()
declare -a POLICY_GOVS=()
declare -a POLICY_AVAIL=()
declare -a POLICY_CUR_KHZ=()
declare -a POLICY_MIN_KHZ=()
declare -a POLICY_MAX_KHZ=()
declare -a POLICY_CNAME=()
declare -a POLICY_CROLE=()
ARM_IS_HETEROGENEOUS=false

discover_policies() {
    # Parse /proc/cpuinfo once for ARM part codes
    declare -A _proc_impl=() _proc_part=()
    if $IS_ARM; then
        local _cur_proc=""
        while IFS= read -r _line; do
            if [[ "$_line" =~ ^processor[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
                _cur_proc="${BASH_REMATCH[1]}"
            elif [[ "$_line" =~ ^CPU\ implementer[[:space:]]*:[[:space:]]*(0x[0-9a-fA-F]+) && -n "$_cur_proc" ]]; then
                _proc_impl["$_cur_proc"]="${BASH_REMATCH[1]}"
            elif [[ "$_line" =~ ^CPU\ part[[:space:]]*:[[:space:]]*(0x[0-9a-fA-F]+) && -n "$_cur_proc" ]]; then
                _proc_part["$_cur_proc"]="${BASH_REMATCH[1]}"
            fi
        done < /proc/cpuinfo
    fi

    local _idx=0
    declare -A _seen_roles=()

    for _pdir in /sys/devices/system/cpu/cpufreq/policy*/; do
        [[ -d "$_pdir" ]] || continue
        local _pname
        _pname=$(basename "$_pdir")
        local _cpus _gov _avail _cur _min _max
        _cpus=$(sysread "${_pdir}affected_cpus")
        # affected_cpus is space-separated; convert to comma-range for display
        _cpus=$(echo "$_cpus" | tr ' ' ',')
        _gov=$(sysread "${_pdir}scaling_governor")
        _avail=$(sysread "${_pdir}scaling_available_governors")
        _cur=$(sysread "${_pdir}scaling_cur_freq")
        _min=$(sysread "${_pdir}cpuinfo_min_freq")
        _max=$(sysread "${_pdir}cpuinfo_max_freq")

        POLICY_DIRS+=("$_pdir")
        POLICY_NAMES+=("$_pname")
        POLICY_CPUS+=("${_cpus:-?}")
        POLICY_GOVS+=("${_gov:-unknown}")
        POLICY_AVAIL+=("${_avail:-}")
        POLICY_CUR_KHZ+=("${_cur:-0}")
        POLICY_MIN_KHZ+=("${_min:-0}")
        POLICY_MAX_KHZ+=("${_max:-0}")

        # ARM cluster identification: use the first CPU of this policy
        local _cname="" _crole=""
        if $IS_ARM; then
            local _first_cpu
            _first_cpu=$(echo "$_cpus" | cut -d',' -f1)
            local _impl="${_proc_impl[$_first_cpu]:-}"
            local _part="${_proc_part[$_first_cpu]:-}"
            if [[ -n "$_impl" && -n "$_part" ]]; then
                _cname=$(arm_cpu_part_name "$_impl" "$_part")
                _crole=$(arm_cluster_role "$_cname")
            fi
            if [[ -n "$_crole" ]]; then
                _seen_roles["$_crole"]=1
            fi
        fi
        POLICY_CNAME+=("$_cname")
        POLICY_CROLE+=("$_crole")

        (( _idx++ )) || true
    done

    # Detect heterogeneous topology
    local _role_count=0
    for _r in "${!_seen_roles[@]}"; do (( _role_count++ )) || true; done
    (( _role_count > 1 )) && ARM_IS_HETEROGENEOUS=true || true
}

# ─── Dependency checks ──────────────────────────────────────────────────────
check_deps() {
    if [[ $EUID -ne 0 ]]; then
        die "This script must be run as root (use: sudo $0)"
    fi

    # On ARM we write directly to sysfs — no cpupower needed.
    # On x86 we still use cpupower for compatibility.
    if ! $IS_ARM; then
        if ! command -v cpupower &>/dev/null; then
            warn "'cpupower' not found — attempting to install linux-cpupower..."
            if apt-get install -y linux-cpupower &>/dev/null; then
                ok "linux-cpupower installed successfully."
            else
                die "Failed to install linux-cpupower. Please install it manually: sudo apt install linux-cpupower"
            fi
            if ! command -v cpupower &>/dev/null; then
                die "'cpupower' still not found after installation. Please check your system."
            fi
        fi
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

# ─── Display current status ─────────────────────────────────────────────────
show_status() {
    local cpus
    cpus=$(nproc --all 2>/dev/null || echo "?")
    echo -e "  CPUs detected   : ${BOLD}${cpus}${RESET}"

    if (( ${#POLICY_DIRS[@]} == 0 )); then
        warn "No cpufreq policies found in /sys/devices/system/cpu/cpufreq/"
        return
    fi

    if (( ${#POLICY_DIRS[@]} == 1 )) && ! $ARM_IS_HETEROGENEOUS; then
        # Single policy (x86 or homogeneous ARM) — compact display
        local gov="${POLICY_GOVS[0]}"
        local cur_mhz=$(( ${POLICY_CUR_KHZ[0]} / 1000 ))
        local min_mhz=$(( ${POLICY_MIN_KHZ[0]} / 1000 ))
        local max_mhz=$(( ${POLICY_MAX_KHZ[0]} / 1000 ))
        local gov_colour
        case "$gov" in
            performance) gov_colour="${GREEN}" ;;
            powersave)   gov_colour="${YELLOW}" ;;
            *)           gov_colour="${CYAN}" ;;
        esac
        echo -e "  Current governor: ${gov_colour}${BOLD}${gov}${RESET}"
        echo -e "  Min / Max freq  : ${min_mhz} MHz / ${max_mhz} MHz"
        echo -e "  Current freq    : ${BOLD}${cur_mhz} MHz${RESET}"
    else
        # Multiple policies (big.LITTLE or multi-socket x86) — table display
        echo ""
        if $ARM_IS_HETEROGENEOUS; then
            echo -e "  ${BOLD}ARM big.LITTLE / DynamIQ — per-cluster cpufreq policies:${RESET}"
        else
            echo -e "  ${BOLD}Per-policy cpufreq status:${RESET}"
        fi
        echo ""
        printf "  %-10s  %-8s  %-14s  %-8s  %-8s  %-8s  %s\n" \
            "Policy" "CPUs" "Governor" "Cur MHz" "Min MHz" "Max MHz" "Cluster"
        printf "  %-10s  %-8s  %-14s  %-8s  %-8s  %-8s  %s\n" \
            "──────────" "────────" "──────────────" "───────" "───────" "───────" "───────────────────────"
        local i
        for (( i=0; i<${#POLICY_DIRS[@]}; i++ )); do
            local gov="${POLICY_GOVS[$i]}"
            local cur_mhz=$(( ${POLICY_CUR_KHZ[$i]} / 1000 ))
            local min_mhz=$(( ${POLICY_MIN_KHZ[$i]} / 1000 ))
            local max_mhz=$(( ${POLICY_MAX_KHZ[$i]} / 1000 ))
            local cname="${POLICY_CNAME[$i]}"
            local crole="${POLICY_CROLE[$i]}"
            local cluster_str=""
            [[ -n "$crole" ]] && cluster_str="${crole}(${cname})"
            [[ -z "$cluster_str" && -n "$cname" ]] && cluster_str="$cname"
            local gov_colour
            case "$gov" in
                performance) gov_colour="${GREEN}" ;;
                powersave)   gov_colour="${YELLOW}" ;;
                *)           gov_colour="${CYAN}" ;;
            esac
            printf "  %-10s  %-8s  ${gov_colour}%-14s${RESET}  %-8s  %-8s  %-8s  %s\n" \
                "${POLICY_NAMES[$i]}" "${POLICY_CPUS[$i]}" "$gov" \
                "${cur_mhz}" "${min_mhz}" "${max_mhz}" "$cluster_str"
        done
        echo ""

        # Recommendation for big.LITTLE
        if $ARM_IS_HETEROGENEOUS; then
            local _big_ok=true
            for (( i=0; i<${#POLICY_DIRS[@]}; i++ )); do
                local _crole="${POLICY_CROLE[$i]}"
                local _gov="${POLICY_GOVS[$i]}"
                if [[ "$_crole" == "big" || "$_crole" == "prime" ]]; then
                    [[ "$_gov" == "performance" ]] || _big_ok=false
                fi
            done
            if $_big_ok; then
                ok "big/prime cluster(s) are on 'performance' governor — optimal for SDR."
            else
                warn "big/prime cluster(s) are NOT on 'performance' governor."
                info "For real-time SDR, set big/prime clusters to 'performance'."
            fi
        fi
    fi

    echo ""
    detect_persistence
}

# ─── Detect persistence ──────────────────────────────────────────────────────
ONESHOT_SERVICE_NAME="cpu-governor"
ONESHOT_SERVICE_PATH="/etc/systemd/system/${ONESHOT_SERVICE_NAME}.service"

detect_persistence() {
    if [[ -f "$ONESHOT_SERVICE_PATH" ]]; then
        local enabled_state
        enabled_state=$(systemctl is-enabled "${ONESHOT_SERVICE_NAME}.service" 2>/dev/null || echo "disabled")
        if [[ "$enabled_state" == "enabled" ]]; then
            info "Persistent governor service: ${BOLD}${ONESHOT_SERVICE_NAME}.service${RESET} (enabled)"
        else
            warn "Service ${ONESHOT_SERVICE_NAME}.service exists but is ${BOLD}not enabled${RESET} — governor won't persist on reboot."
        fi
        return
    fi

    # Fall back to /etc/default/cpupower
    local persisted=""
    if [[ -f /etc/default/cpupower ]]; then
        persisted=$(grep -E '^CPU_DEFAULT_GOVERNOR=' /etc/default/cpupower 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
    fi

    if [[ -n "$persisted" ]]; then
        info "Persistent governor (/etc/default/cpupower): ${BOLD}${persisted}${RESET}"
    else
        info "No persistence configured — governor resets to system default on reboot."
    fi
}

# ─── Apply governor to a single policy via sysfs ────────────────────────────
# apply_policy_governor POLICY_DIR GOVERNOR
apply_policy_governor() {
    local pdir="$1"
    local governor="$2"
    local gov_file="${pdir}scaling_governor"

    if [[ ! -w "$gov_file" ]]; then
        error "Cannot write to ${gov_file} — check permissions"
        return 1
    fi

    echo "$governor" > "$gov_file" || { error "Failed to write '$governor' to ${gov_file}"; return 1; }

    local actual
    actual=$(sysread "$gov_file")
    if [[ "$actual" == "$governor" ]]; then
        return 0
    else
        error "Verification failed for ${pdir}: reads '${actual}' instead of '${governor}'"
        return 1
    fi
}

# ─── Apply governor (x86 path via cpupower, ARM path via sysfs) ─────────────
# apply_governor GOVERNOR [POLICY_INDEX_OR_"all"]
apply_governor() {
    local governor="$1"
    local target="${2:-all}"   # "all" or a numeric policy index

    if $IS_ARM; then
        # ARM: write directly to sysfs per policy
        local i
        local ok_count=0
        local fail_count=0
        for (( i=0; i<${#POLICY_DIRS[@]}; i++ )); do
            if [[ "$target" == "all" || "$target" == "$i" ]]; then
                local pname="${POLICY_NAMES[$i]}"
                info "Setting ${pname} (CPUs ${POLICY_CPUS[$i]}) → '${BOLD}${governor}${RESET}'..."
                if apply_policy_governor "${POLICY_DIRS[$i]}" "$governor"; then
                    POLICY_GOVS[$i]="$governor"
                    local cur_mhz=$(( $(sysread "${POLICY_DIRS[$i]}scaling_cur_freq") / 1000 ))
                    ok "${pname}: governor='${BOLD}${governor}${RESET}'  current=${cur_mhz} MHz"
                    (( ok_count++ )) || true
                else
                    (( fail_count++ )) || true
                fi
            fi
        done
        (( fail_count > 0 )) && return 1 || return 0
    else
        # x86: use cpupower (applies to all CPUs)
        info "Applying governor '${BOLD}${governor}${RESET}' to all CPUs via cpupower..."
        if ! cpupower frequency-set -g "$governor" &>/dev/null; then
            die "cpupower failed to set governor '$governor'"
        fi
        local actual
        actual=$(sysread "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
        if [[ "$actual" == "$governor" ]]; then
            ok "Governor successfully set to '${BOLD}${governor}${RESET}'"
            local cur_mhz=$(( $(sysread "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq") / 1000 ))
            ok "Current CPU frequency: ${BOLD}${cur_mhz} MHz${RESET}"
        else
            error "Verification failed — governor reads '${actual}' instead of '${governor}'"
            return 1
        fi
    fi
}

# ─── Persist governor via oneshot systemd service ────────────────────────────
# Builds an ExecStart line per policy that was configured.
# policy_govs_arg: space-separated "policyN=governor" pairs, e.g. "policy0=powersave policy4=performance"
persist_governor() {
    local policy_govs_arg="$1"   # e.g. "policy0=powersave policy4=performance"

    info "Writing oneshot systemd service to ${ONESHOT_SERVICE_PATH} ..."

    # Build ExecStart commands
    local exec_lines=""
    for pair in $policy_govs_arg; do
        local pname="${pair%%=*}"
        local gov="${pair##*=}"
        local gov_file="/sys/devices/system/cpu/cpufreq/${pname}/scaling_governor"
        exec_lines+="ExecStart=/bin/sh -c 'echo ${gov} > ${gov_file}'\n"
    done

    # If x86 (single policy, cpupower available), use cpupower instead
    if ! $IS_ARM && command -v cpupower &>/dev/null; then
        local cpupower_bin
        cpupower_bin=$(command -v cpupower)
        # Extract the single governor from the first pair
        local single_gov="${policy_govs_arg%%=*}"
        single_gov="${policy_govs_arg#*=}"
        single_gov="${single_gov%% *}"
        exec_lines="ExecStart=${cpupower_bin} frequency-set -g ${single_gov}\n"
    fi

    printf '[Unit]\nDescription=Set CPU governor(s) for UberSDR\nAfter=multi-user.target\n\n[Service]\nType=oneshot\n%b\nRemainAfterExit=yes\n\n[Install]\nWantedBy=multi-user.target\n' \
        "$exec_lines" > "$ONESHOT_SERVICE_PATH"

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

    if [[ -f "$ONESHOT_SERVICE_PATH" ]]; then
        systemctl disable "${ONESHOT_SERVICE_NAME}.service" &>/dev/null || true
        systemctl stop "${ONESHOT_SERVICE_NAME}.service" &>/dev/null || true
        rm -f "$ONESHOT_SERVICE_PATH"
        systemctl daemon-reload
        ok "Removed ${ONESHOT_SERVICE_PATH} and disabled ${ONESHOT_SERVICE_NAME}.service"
        removed=1
    fi

    if [[ -f /etc/default/cpupower ]] && grep -q '^CPU_DEFAULT_GOVERNOR=' /etc/default/cpupower 2>/dev/null; then
        sed -i '/^CPU_DEFAULT_GOVERNOR=/d' /etc/default/cpupower
        ok "Removed CPU_DEFAULT_GOVERNOR line from /etc/default/cpupower"
        removed=1
    fi

    if [[ $removed -eq 0 ]]; then
        info "No persistence configuration found to remove."
    fi
}

# ─── Interactive governor selection for one policy ───────────────────────────
# Returns chosen governor in CHOSEN_GOV variable.
# select_governor_for_policy POLICY_INDEX PROMPT_PREFIX
select_governor_for_policy() {
    local pidx="$1"
    local prefix="${2:-}"
    local avail_str="${POLICY_AVAIL[$pidx]}"
    local current="${POLICY_GOVS[$pidx]}"

    if [[ -z "$avail_str" ]]; then
        warn "No available governors found for ${POLICY_NAMES[$pidx]}."
        CHOSEN_GOV="$current"
        return
    fi

    read -ra avail_governors <<< "$avail_str"

    echo -e "\n${BOLD}${prefix}Available governors:${RESET}\n"
    local i=1
    for gov in "${avail_governors[@]}"; do
        local marker="" rec=""
        [[ "$gov" == "$current" ]] && marker=" ${GREEN}← current${RESET}"
        [[ "$gov" == "performance" ]] && rec=" ${YELLOW}(recommended for SDR)${RESET}"
        echo -e "  ${BOLD}${i})${RESET} $(printf '%-14s' "$gov") $(governor_description "$gov")${marker}${rec}"
        (( i++ ))
    done
    echo ""
    echo -e "  ${BOLD}s)${RESET} Skip (keep current: ${current})"
    echo ""

    CHOSEN_GOV="$current"
    while true; do
        read -rp "$(echo -e "${BOLD}Select governor [1-${#avail_governors[@]}/s]:${RESET} ")" choice
        if [[ "$choice" == "s" || "$choice" == "S" ]]; then
            CHOSEN_GOV="$current"
            break
        fi
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#avail_governors[@]} )); then
            CHOSEN_GOV="${avail_governors[$((choice-1))]}"
            break
        fi
        warn "Invalid selection. Enter a number between 1 and ${#avail_governors[@]}, or 's' to skip."
    done
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
    check_deps
    discover_policies

    if (( ${#POLICY_DIRS[@]} == 0 )); then
        die "No cpufreq policies found. Is cpufreq support enabled in the kernel?"
    fi

    header "UberSDR CPU Governor Manager"
    show_status

    # ── Persistence removal shortcut ─────────────────────────────────────────
    echo -e "${BOLD}Options:${RESET}"
    echo -e "  ${BOLD}1)${RESET} Configure governor(s)"
    echo -e "  ${BOLD}2)${RESET} Remove persistence (revert to system default on reboot)"
    echo -e "  ${BOLD}q)${RESET} Quit without changes"
    echo ""
    read -rp "$(echo -e "${BOLD}Choose [1/2/q]:${RESET} ")" top_choice
    top_choice="${top_choice:-1}"

    case "$top_choice" in
        q|Q)
            info "No changes made. Exiting."
            exit 0 ;;
        2)
            remove_persistence
            echo ""
            header "Final Status"
            show_status
            exit 0 ;;
        1|"") : ;;   # fall through to governor selection
        *)
            warn "Invalid choice — proceeding to governor configuration."
            ;;
    esac

    # ── Governor selection ────────────────────────────────────────────────────
    # Track what was chosen per policy for persistence
    declare -a chosen_govs=()
    local any_change=false

    if $ARM_IS_HETEROGENEOUS; then
        # ── ARM big.LITTLE: per-cluster selection ────────────────────────────
        echo ""
        echo -e "${BOLD}This is an ARM big.LITTLE / DynamIQ system.${RESET}"
        echo -e "You can set a different governor for each cluster."
        echo ""
        echo -e "  ${YELLOW}Recommended:${RESET} ${BOLD}performance${RESET} on big/prime clusters (radiod cores)"
        echo -e "               ${BOLD}powersave${RESET} or ${BOLD}schedutil${RESET} on LITTLE cluster (background tasks)"
        echo ""

        local i
        for (( i=0; i<${#POLICY_DIRS[@]}; i++ )); do
            local pname="${POLICY_NAMES[$i]}"
            local cpus="${POLICY_CPUS[$i]}"
            local crole="${POLICY_CROLE[$i]}"
            local cname="${POLICY_CNAME[$i]}"
            local current="${POLICY_GOVS[$i]}"

            local cluster_label=""
            [[ -n "$crole" ]] && cluster_label=" [${crole}: ${cname}]"
            [[ -z "$cluster_label" && -n "$cname" ]] && cluster_label=" [${cname}]"

            echo -e "─────────────────────────────────────────────────────────"
            echo -e "${BOLD}${pname}${RESET}  CPUs=[${cpus}]${cluster_label}  current governor: ${BOLD}${current}${RESET}"

            select_governor_for_policy "$i" "${pname}: "
            chosen_govs+=("$CHOSEN_GOV")
            if [[ "$CHOSEN_GOV" != "$current" ]]; then
                any_change=true
            fi
        done

    else
        # ── x86 / homogeneous ARM: single governor selection ─────────────────
        echo ""
        select_governor_for_policy "0" ""
        chosen_govs+=("$CHOSEN_GOV")
        if [[ "$CHOSEN_GOV" != "${POLICY_GOVS[0]}" ]]; then
            any_change=true
        fi
    fi

    # ── Confirm and apply ─────────────────────────────────────────────────────
    if ! $any_change; then
        info "No governor changes selected."
    else
        echo ""
        echo -e "${BOLD}Summary of changes to apply:${RESET}"
        local i
        for (( i=0; i<${#POLICY_DIRS[@]}; i++ )); do
            local old="${POLICY_GOVS[$i]}"
            local new="${chosen_govs[$i]:-$old}"
            local pname="${POLICY_NAMES[$i]}"
            local cpus="${POLICY_CPUS[$i]}"
            local crole="${POLICY_CROLE[$i]}"
            local cname="${POLICY_CNAME[$i]}"
            local cluster_str=""
            [[ -n "$crole" ]] && cluster_str=" [${crole}: ${cname}]"
            if [[ "$new" != "$old" ]]; then
                echo -e "  ${pname} (CPUs ${cpus})${cluster_str}: ${YELLOW}${old}${RESET} → ${GREEN}${new}${RESET}"
            else
                echo -e "  ${pname} (CPUs ${cpus})${cluster_str}: ${old} (unchanged)"
            fi
        done
        echo ""
        read -rp "$(echo -e "${BOLD}Apply these changes now? [Y/n]:${RESET} ")" confirm
        confirm="${confirm:-Y}"
        if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
            info "Aborted. No changes made."
            exit 0
        fi

        # Apply each changed policy
        for (( i=0; i<${#POLICY_DIRS[@]}; i++ )); do
            local old="${POLICY_GOVS[$i]}"
            local new="${chosen_govs[$i]:-$old}"
            if [[ "$new" != "$old" ]]; then
                apply_governor "$new" "$i"
            fi
        done
    fi

    # ── Persistence prompt ────────────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}Persistence options:${RESET}"
    echo -e "  ${BOLD}1)${RESET} Apply for this session only (resets on reboot)"
    echo -e "  ${BOLD}2)${RESET} Make persistent across reboots (via systemd service)"
    echo -e "  ${BOLD}3)${RESET} Remove persistence (revert to system default on reboot)"
    echo ""
    read -rp "$(echo -e "${BOLD}Choose persistence option [1/2/3]:${RESET} ")" persist_choice
    persist_choice="${persist_choice:-1}"

    case "$persist_choice" in
        1)
            ok "Governor(s) set for this session only. Will revert to system default on reboot."
            ;;
        2)
            # Build "policyN=governor" pairs for all policies (including unchanged ones)
            local pairs=""
            for (( i=0; i<${#POLICY_DIRS[@]}; i++ )); do
                local pname="${POLICY_NAMES[$i]}"
                local gov="${chosen_govs[$i]:-${POLICY_GOVS[$i]}}"
                pairs+="${pname}=${gov} "
            done
            persist_governor "${pairs% }"
            ok "Governor(s) will be applied automatically on every boot."
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
    # Refresh policy data
    POLICY_DIRS=()
    POLICY_NAMES=()
    POLICY_CPUS=()
    POLICY_GOVS=()
    POLICY_AVAIL=()
    POLICY_CUR_KHZ=()
    POLICY_MIN_KHZ=()
    POLICY_MAX_KHZ=()
    POLICY_CNAME=()
    POLICY_CROLE=()
    discover_policies
    show_status
}

main "$@"
