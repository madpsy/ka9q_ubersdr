#!/bin/bash

# merge-compose.sh - Additively merge new services/volumes from the upstream
# docker-compose template into the user's existing docker-compose.yml.
#
# Only adds services and volumes that are MISSING from the user's file.
# Existing services are NEVER modified, regardless of what changed upstream.
#
# Safety guarantees:
#   - A timestamped backup is created only if there is something to merge,
#     immediately before the first write to the live file
#   - Each write goes to a .tmp file first; the live file is only replaced
#     after the result is validated as parseable YAML
#   - On any error the original file is restored from backup
#   - The script never exits non-zero without having restored the original
#   - A merge log is written alongside the compose file recording what changed
#
# Usage:
#   merge-compose.sh <compose-file> [template-url]
#
# Arguments:
#   compose-file   Path to the user's docker-compose.yml (required)
#   template-url   URL to fetch the upstream template from (optional,
#                  defaults to the canonical GitHub location)
#
# Exit codes:
#   0  Success (including "nothing to do")
#   1  Error - original file has been restored from backup

# Do NOT use set -e; we handle all errors explicitly to ensure cleanup runs.

TEMPLATE_URL="${2:-https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/docker/docker-compose-dockerhub.yml}"
COMPOSE_FILE="${1:-}"
YQ_BIN="/usr/local/bin/yq"
BACKUP_FILE=""
TEMPLATE_FILE=""
TMP_FILE=""
ADDED_ITEMS=()   # Accumulates names of successfully added services/volumes

# --- Cleanup handler ---
# Called on EXIT (normal or error). Removes temp files.
# Does NOT restore backup here - restoration is done explicitly on error paths
# so the exit message is accurate.
cleanup() {
    rm -f "$TEMPLATE_FILE" "$TMP_FILE"
}
trap cleanup EXIT

# --- Create backup on first write (lazy) ---
# Called immediately before the first modification to the live file.
# Subsequent calls are no-ops since BACKUP_FILE is already set.
ensure_backup() {
    if [ -n "$BACKUP_FILE" ]; then
        return 0  # already created
    fi
    BACKUP_FILE="${COMPOSE_FILE}.bak.$(date +%Y%m%d_%H%M%S)"
    if ! cp "$COMPOSE_FILE" "$BACKUP_FILE"; then
        echo "Error: Failed to create backup at $BACKUP_FILE - aborting"
        rm -f "$TMP_FILE"
        exit 1
    fi
    echo "  Backup created: $BACKUP_FILE"
}

# --- Restore backup and exit with error ---
restore_and_fail() {
    local reason="$1"
    echo "Error: $reason"
    if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then
        echo "Restoring original docker-compose.yml from backup..."
        cp "$BACKUP_FILE" "$COMPOSE_FILE"
        rm -f "$BACKUP_FILE"
        echo "Restored successfully. Your docker-compose.yml is unchanged."
    fi
    exit 1
}

# --- Validate arguments ---
if [ -z "$COMPOSE_FILE" ]; then
    echo "Usage: $0 <compose-file> [template-url]"
    exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "Error: compose file not found: $COMPOSE_FILE"
    exit 1
fi

# --- Check yq v4 is available ---
if [ ! -x "$YQ_BIN" ]; then
    echo "Error: yq not found at $YQ_BIN"
    exit 1
fi

if ! "$YQ_BIN" --version 2>&1 | grep -q "version v4"; then
    echo "Error: yq v4 required (found: $("$YQ_BIN" --version 2>&1 | head -1))"
    exit 1
fi

# --- Validate the user's compose file is parseable before touching it ---
if ! "$YQ_BIN" '.' "$COMPOSE_FILE" > /dev/null 2>&1; then
    echo "Error: $COMPOSE_FILE is not valid YAML - aborting merge to avoid corruption"
    exit 1
fi

if ! "$YQ_BIN" '.services | keys' "$COMPOSE_FILE" > /dev/null 2>&1; then
    echo "Error: $COMPOSE_FILE does not appear to be a valid compose file (no 'services' key)"
    exit 1
fi

# --- Download template ---
TEMPLATE_FILE="$(mktemp /tmp/docker-compose-template.XXXXXX.yml)"
TMP_FILE="${COMPOSE_FILE}.tmp"

echo "Downloading template from $TEMPLATE_URL..."
if ! curl -fsSL "$TEMPLATE_URL" -o "$TEMPLATE_FILE" 2>/dev/null; then
    restore_and_fail "Failed to download template from $TEMPLATE_URL"
fi

# Validate the downloaded template is parseable YAML with a services key
if ! "$YQ_BIN" '.' "$TEMPLATE_FILE" > /dev/null 2>&1; then
    restore_and_fail "Downloaded template is not valid YAML"
fi

if ! "$YQ_BIN" '.services | keys' "$TEMPLATE_FILE" > /dev/null 2>&1; then
    restore_and_fail "Downloaded template does not appear to be a valid compose file (no 'services' key)"
fi

echo "Checking for new containers to add..."
ADDED=0
MERGE_ERROR=0

# --- Add services present in template but missing from user file ---
while IFS= read -r svc; do
    # Skip empty lines
    [ -z "$svc" ] && continue

    # Check if service already exists in user file
    exists=$("$YQ_BIN" ".services | has(\"$svc\")" "$COMPOSE_FILE" 2>/dev/null)
    if [ "$exists" != "true" ]; then
        echo "  Adding new service: $svc"

        # Use load() to read the service definition from the template file.
        # This avoids the eval-all/select(fi==N) pattern where the RHS
        # select() evaluates in the wrong file context and returns null.
        if ! "$YQ_BIN" ".services.\"$svc\" = load(\"$TEMPLATE_FILE\").services.\"$svc\"" \
            "$COMPOSE_FILE" > "$TMP_FILE" 2>/dev/null; then
            echo "  Warning: yq failed to merge service '$svc' - skipping"
            rm -f "$TMP_FILE"
            MERGE_ERROR=1
            continue
        fi

        # Validate the merged result is non-empty and parseable
        if ! "$YQ_BIN" '.' "$TMP_FILE" > /dev/null 2>&1; then
            echo "  Warning: merged result for service '$svc' is not valid YAML - skipping"
            rm -f "$TMP_FILE"
            MERGE_ERROR=1
            continue
        fi

        # Verify the service was actually written as a mapping (not null)
        svc_type=$("$YQ_BIN" ".services.\"$svc\" | type" "$TMP_FILE" 2>/dev/null)
        if [ "$svc_type" != "!!map" ]; then
            echo "  Warning: merged service '$svc' is not a mapping (got: $svc_type) - skipping"
            rm -f "$TMP_FILE"
            MERGE_ERROR=1
            continue
        fi

        # Create backup on first write, then atomically replace the live file
        ensure_backup
        if ! mv "$TMP_FILE" "$COMPOSE_FILE"; then
            restore_and_fail "Failed to write updated compose file after merging service '$svc'"
        fi

        ADDED=$((ADDED + 1))
        ADDED_ITEMS+=("service: $svc")
    fi
done < <("$YQ_BIN" '.services | keys | .[]' "$TEMPLATE_FILE" 2>/dev/null)

# --- Add volumes present in template but missing from user file ---
while IFS= read -r vol; do
    # Skip empty lines
    [ -z "$vol" ] && continue

    # Check if volume already exists in user file
    exists=$("$YQ_BIN" ".volumes | has(\"$vol\")" "$COMPOSE_FILE" 2>/dev/null)
    if [ "$exists" != "true" ]; then
        echo "  Adding new volume: $vol"

        # Use load() to read the volume definition from the template file.
        if ! "$YQ_BIN" ".volumes.\"$vol\" = load(\"$TEMPLATE_FILE\").volumes.\"$vol\"" \
            "$COMPOSE_FILE" > "$TMP_FILE" 2>/dev/null; then
            echo "  Warning: yq failed to merge volume '$vol' - skipping"
            rm -f "$TMP_FILE"
            MERGE_ERROR=1
            continue
        fi

        # Validate the merged result is parseable
        if ! "$YQ_BIN" '.' "$TMP_FILE" > /dev/null 2>&1; then
            echo "  Warning: merged result for volume '$vol' is not valid YAML - skipping"
            rm -f "$TMP_FILE"
            MERGE_ERROR=1
            continue
        fi

        # Create backup on first write, then atomically replace the live file
        ensure_backup
        if ! mv "$TMP_FILE" "$COMPOSE_FILE"; then
            restore_and_fail "Failed to write updated compose file after merging volume '$vol'"
        fi

        ADDED=$((ADDED + 1))
        ADDED_ITEMS+=("volume: $vol")
    fi
done < <("$YQ_BIN" '.volumes | keys | .[]' "$TEMPLATE_FILE" 2>/dev/null)

# --- Final validation of the resulting file ---
if [ $ADDED -gt 0 ]; then
    if ! "$YQ_BIN" '.' "$COMPOSE_FILE" > /dev/null 2>&1; then
        restore_and_fail "Final compose file failed YAML validation after merge"
    fi
    if ! "$YQ_BIN" '.services | keys' "$COMPOSE_FILE" > /dev/null 2>&1; then
        restore_and_fail "Final compose file has no 'services' key after merge"
    fi
fi

# --- Summary and log ---
LOG_FILE="$(dirname "$COMPOSE_FILE")/merge-compose.log"

if [ $ADDED -eq 0 ] && [ $MERGE_ERROR -eq 0 ]; then
    # Nothing changed - no backup was created, nothing to clean up
    echo "  No new containers or volumes to add."
else
    if [ $ADDED -gt 0 ]; then
        echo "  $ADDED new item(s) added to $(basename "$COMPOSE_FILE")."
        if [ -n "$BACKUP_FILE" ]; then
            echo "  Backup retained at: $BACKUP_FILE"
        fi
    fi

    if [ $MERGE_ERROR -ne 0 ]; then
        echo "  Warning: Some items could not be merged (see above). Partial merge applied."
    fi

    # Write a persistent log so the user can review what changed
    {
        echo "=== merge-compose run: $(date '+%Y-%m-%d %H:%M:%S') ==="
        if [ ${#ADDED_ITEMS[@]} -gt 0 ]; then
            echo "Added:"
            for item in "${ADDED_ITEMS[@]}"; do
                echo "  + $item"
            done
        fi
        if [ $MERGE_ERROR -ne 0 ]; then
            echo "Warnings: some items could not be merged (check install output for details)"
        fi
        if [ -n "$BACKUP_FILE" ]; then
            echo "Backup: $BACKUP_FILE"
        fi
        echo ""
    } >> "$LOG_FILE"

    echo "  Full merge history: $LOG_FILE"
fi
