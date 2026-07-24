#!/usr/bin/env bash
#
# widget-ai.sh — manage the UberSDR Widget AI assistant container.
#
# The AI widget assistant runs Claude Code inside the sandboxed
# `madpsy/ubersdr-claude` container (defined as the manually-started `widget-ai`
# service in docker-compose.yml). This script is the host-side manager: it
# starts / stops that container, reports its running state, and attaches you to
# an interactive session.
#
# The interactive session runs inside a detached tmux session named "Widget AI",
# so closing the terminal window only DETACHES — the assistant keeps running and
# you can reattach later (menu → Start / attach, or the Terminal ▾ dropdown).
#
# Intended to be launched from the UberSDR gotty web terminal
# (Admin → UI → ✨ AI Widget Assistant), but also usable directly:
#
#   ./widget-ai.sh                 # interactive menu
#   ./widget-ai.sh start           # start / attach
#   ./widget-ai.sh stop            # stop the container
#   ./widget-ai.sh status          # print state and exit
#   ./widget-ai.sh update          # pull the latest image
#
#   Env overrides:
#     UBERSDR_DIR        installed instance dir (holds docker-compose.yml,
#                        get-password.sh)                 (default: $HOME/ubersdr)
#     COMPOSE_FILE       path to the compose file         (default: $UBERSDR_DIR/docker-compose.yml)
#     WIDGET_AI_IMAGE    container image                  (default: madpsy/ubersdr-claude:latest)
#     ADMIN_PASSWORD     admin API password; if unset the script resolves it
#                        from the running instance (never printed)

set -euo pipefail

UBERSDR_DIR="${UBERSDR_DIR:-$HOME/ubersdr}"
COMPOSE_FILE="${COMPOSE_FILE:-$UBERSDR_DIR/docker-compose.yml}"
SERVICE="${WIDGET_AI_SERVICE:-widget-ai}"
PROFILE="${WIDGET_AI_PROFILE:-manual}"
CONTAINER="${WIDGET_AI_CONTAINER:-ubersdr-claude}"
MAIN_CONTAINER="${UBERSDR_CONTAINER:-ka9q_ubersdr}"
SESSION="${WIDGET_AI_SESSION:-Widget AI}"
IMAGE="${WIDGET_AI_IMAGE:-madpsy/ubersdr-claude:latest}"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_CYAN=; C_GREEN=; C_YELLOW=; C_RED=; C_DIM=; C_BOLD=; C_RST=
fi
say()  { printf '%s▸ %s%s\n' "$C_CYAN" "$*" "$C_RST"; }
ok()   { printf '%s✓ %s%s\n' "$C_GREEN" "$*" "$C_RST"; }
warn() { printf '%s! %s%s\n' "$C_YELLOW" "$*" "$C_RST" >&2; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_RST" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is required but not installed."
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is required but not available."
command -v tmux >/dev/null 2>&1 || die "tmux is required but not installed (sudo apt install -y tmux)."
[ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE (set COMPOSE_FILE or UBERSDR_DIR)."

compose() { docker compose --profile "$PROFILE" -f "$COMPOSE_FILE" "$@"; }

# ---------------------------------------------------------------------------
# State detection
# ---------------------------------------------------------------------------
session_running()   { tmux has-session -t "$SESSION" 2>/dev/null; }
container_running() { [ -n "$(docker ps -q -f "name=^/${CONTAINER}$" 2>/dev/null)" ]; }
image_present()     { docker image inspect "$IMAGE" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Admin password resolution.
#   Order: existing $ADMIN_PASSWORD → the running main container's env →
#   get-password.sh (sudo). The value is NEVER printed; on success we only say
#   that credentials were loaded. Callers get it via the exported var.
# ---------------------------------------------------------------------------
resolve_admin_password() {
  if [ -n "${ADMIN_PASSWORD:-}" ]; then return 0; fi
  local pw=""
  # The main UberSDR container already holds the password in its environment.
  pw="$(docker exec "$MAIN_CONTAINER" printenv ADMIN_PASSWORD 2>/dev/null || true)"
  # Fall back to the helper that reads it out of the config volume (uses sudo).
  if [ -z "$pw" ] && [ -x "$UBERSDR_DIR/get-password.sh" ]; then
    pw="$("$UBERSDR_DIR/get-password.sh" --short 2>/dev/null || true)"
  fi
  if [ -n "$pw" ]; then
    export ADMIN_PASSWORD="$pw"
    return 0
  fi
  return 1
}

# Write the resolved password to a private (0600) env-file for
# `docker compose --env-file`, so compose can substitute ${ADMIN_PASSWORD} into
# the service env WITHOUT the value ever appearing on a command line / in `ps`.
# Prints the env-file path on stdout. Empty ADMIN_PASSWORD is written as blank.
make_env_file() {
  local ef
  ef="$(mktemp "${TMPDIR:-/tmp}/widget-ai.XXXXXX.env")"
  chmod 600 "$ef"
  printf 'ADMIN_PASSWORD=%s\n' "${ADMIN_PASSWORD:-}" > "$ef"
  printf '%s' "$ef"
}

# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------
status_line() {
  if session_running || container_running; then
    printf '%s● running%s' "$C_GREEN" "$C_RST"
  else
    printf '%s○ stopped%s' "$C_DIM" "$C_RST"
  fi
}

do_status() {
  printf '\n%sWidget AI — status%s\n' "$C_BOLD" "$C_RST"
  printf '  image      %s  ' "$IMAGE"
  image_present && ok "present" || warn "not pulled (menu → Update image)"
  printf '  container  %s  ' "$CONTAINER"
  container_running && ok "running" || printf '%s○ not running%s\n' "$C_DIM" "$C_RST"
  printf '  session    %-12s  ' "\"$SESSION\""
  session_running && ok "attached/detached (alive)" || printf '%s○ none%s\n' "$C_DIM" "$C_RST"
  printf '\n'
}

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------
do_start() {
  # Already alive → just reattach.
  if session_running; then
    say "Reattaching to the running \"$SESSION\" session…"
    tmux attach -t "$SESSION"
    return 0
  fi

  # Ensure the image is available.
  if ! image_present; then
    say "Image $IMAGE is not present locally — pulling it…"
    compose pull "$SERVICE"
  fi

  # Resolve the admin password (never printed).
  if resolve_admin_password; then
    ok "Admin credentials loaded into the session."
  else
    warn "Could not resolve the admin password — the assistant's API calls may return 401."
    warn "Set ADMIN_PASSWORD in the environment, or ensure $MAIN_CONTAINER is running."
  fi

  local envfile; envfile="$(make_env_file)"

  # Launch the container inside a detached tmux session and attach. The compose
  # command reads ADMIN_PASSWORD from the private env-file (removed once the run
  # exits). Closing the window detaches; the session + container keep running.
  say "Starting the Widget AI container…"
  tmux new-session -d -s "$SESSION" -n "$SESSION" \
    "cd '$UBERSDR_DIR' && docker compose --env-file '$envfile' --profile '$PROFILE' -f '$COMPOSE_FILE' run --rm --name '$CONTAINER' '$SERVICE'; \
     rm -f '$envfile'; \
     echo; echo '=== Widget AI session ended — press Enter to close ==='; read -r _"

  say "Attaching (detach with Ctrl-b then d; closing the window also detaches)…"
  sleep 1
  tmux attach -t "$SESSION"
}

do_stop() {
  if ! session_running && ! container_running; then
    say "Widget AI is not running."
    return 0
  fi
  say "Stopping Widget AI…"
  # Kill the tmux session first so the attached `compose run` is torn down.
  if session_running; then tmux kill-session -t "$SESSION" 2>/dev/null || true; fi
  # Ensure the container is gone (run --rm normally removes it, but be sure).
  if container_running; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  ok "Stopped."
}

do_update() {
  say "Pulling the latest image ($IMAGE)…"
  compose pull "$SERVICE"
  ok "Image up to date."
  if container_running || session_running; then
    warn "A session is running — restart it (Stop, then Start) to use the new image."
  fi
}

# ---------------------------------------------------------------------------
# Interactive menu
# ---------------------------------------------------------------------------
menu() {
  while true; do
    printf '\n%s╔══════════════════════════════════════════════╗%s\n' "$C_CYAN" "$C_RST"
    printf   '%s║  UberSDR Widget AI                            ║%s\n' "$C_CYAN" "$C_RST"
    printf   '%s╚══════════════════════════════════════════════╝%s\n' "$C_CYAN" "$C_RST"
    printf   '  Status: %b\n\n' "$(status_line)"
    printf '%s' "$C_DIM"
    printf   '  Runs in the background as the "%s" session — if you close this\n' "$SESSION"
    printf   '  window it keeps running. Reattach any time from the UberSDR Admin\n'
    printf   '  page: click the ▾ arrow next to the Terminal button (top of the\n'
    printf   '  page) and choose "%s".\n' "$SESSION"
    printf '%s\n' "$C_RST"
    if session_running; then
      printf '    1) Attach to running session\n'
    else
      printf '    1) Start / attach\n'
    fi
    printf   '    2) Stop\n'
    printf   '    3) Status / details\n'
    printf   '    4) Update image\n'
    printf   '    q) Quit\n\n'
    printf   '  Choose: '; read -r choice
    case "$choice" in
      1) do_start ;;
      2) do_stop ;;
      3) do_status ;;
      4) do_update ;;
      q|Q) exit 0 ;;
      *) warn "Unknown option: $choice" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Main — subcommand or interactive
# ---------------------------------------------------------------------------
case "${1:-}" in
  start)  do_start ;;
  stop)   do_stop ;;
  status) do_status ;;
  update) do_update ;;
  ""|menu) menu ;;
  *) die "Unknown command: $1 (use: start | stop | status | update, or no argument for the menu)";;
esac
