#!/bin/bash

# UberSDR Health Check Script
# Checks: RX888 USB device, Docker containers, port bindings

PASS=0
FAIL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ok()   { echo -e "  ${GREEN}[OK]${NC}   $1"; ((PASS++)); }
fail() { echo -e "  ${RED}[FAIL]${NC} $1"; ((FAIL++)); }
info() { echo -e "  ${YELLOW}[INFO]${NC} $1"; }

echo "=== UberSDR Health Check ==="
echo

# -------------------------------------------------------
# 1. RX888 USB device check (vendor 04b4, product 00f1)
# -------------------------------------------------------
echo "--- RX888 Device ---"

RX888_VENDOR="04b4"
RX888_PRODUCT="00f1"
rx888_found=0

for d in /sys/bus/usb/devices/*; do
    [[ -e "$d" ]] || continue
    [[ -f "$d/idVendor" && -f "$d/idProduct" ]] || continue
    v=$(<"$d/idVendor")
    p=$(<"$d/idProduct")
    if [[ "$v" == "$RX888_VENDOR" && "$p" == "$RX888_PRODUCT" ]]; then
        rx888_found=1
        break
    fi
done

if (( rx888_found )); then
    ok "RX888 found (vendor: $RX888_VENDOR, product: $RX888_PRODUCT)"
else
    fail "RX888 not found (expected vendor: $RX888_VENDOR, product: $RX888_PRODUCT)"
fi

echo

# -------------------------------------------------------
# 2. Docker container checks
# -------------------------------------------------------
echo "--- Docker Containers ---"

# Get list of running container names
if ! command -v docker &>/dev/null; then
    fail "Docker is not installed or not in PATH"
else
    RUNNING_CONTAINERS=$(docker ps --format '{{.Names}}' 2>/dev/null)

    # Expected containers (adjust names to match docker-compose service names)
    EXPECTED_CONTAINERS=(
        "ka9q_ubersdr"
        "ka9q-radio"
        "caddy"
        "ubersdr-gotty"
    )

    for container in "${EXPECTED_CONTAINERS[@]}"; do
        if echo "$RUNNING_CONTAINERS" | grep -q "^${container}$"; then
            ok "Container '$container' is running"
        else
            fail "Container '$container' is NOT running"
        fi
    done
fi

echo

# -------------------------------------------------------
# 3. Port checks
# -------------------------------------------------------
echo "--- Port Bindings ---"

check_port() {
    local port="$1"
    local description="$2"
    if ss -ltnH "( sport = :$port )" 2>/dev/null | grep -q .; then
        ok "$description is listening on port $port"
    else
        fail "$description is NOT listening on port $port"
    fi
}

check_port 8080 "UberSDR"
check_port 80   "Caddy (HTTP)"
check_port 443  "Caddy (HTTPS)"

echo

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
echo "--- Summary ---"
TOTAL=$(( PASS + FAIL ))
echo -e "  Passed: ${GREEN}${PASS}${NC} / ${TOTAL}"
if (( FAIL > 0 )); then
    echo -e "  Failed: ${RED}${FAIL}${NC} / ${TOTAL}"
    echo
    exit 1
else
    echo -e "  ${GREEN}All checks passed.${NC}"
    echo
    exit 0
fi
