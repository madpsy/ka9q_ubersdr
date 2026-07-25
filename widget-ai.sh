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
#   ./widget-ai.sh update          # pull the latest image (restarts a running
#                                  # session onto it, and reattaches)
#
#   No admin password is needed: the container name is listed in the instance's
#   admin->widget_trusted_hosts config, so UberSDR accepts its /admin/widgets/*
#   calls on the strength of its container IP alone.
#
#   Env overrides:
#     UBERSDR_DIR        installed instance dir (holds docker-compose.yml)
#                                                         (default: $HOME/ubersdr)
#     COMPOSE_FILE       path to the compose file         (default: $UBERSDR_DIR/docker-compose.yml)
#     WIDGET_AI_IMAGE    container image                  (default: madpsy/ubersdr-claude:latest)

set -euo pipefail

UBERSDR_DIR="${UBERSDR_DIR:-$HOME/ubersdr}"
COMPOSE_FILE="${COMPOSE_FILE:-$UBERSDR_DIR/docker-compose.yml}"
SERVICE="${WIDGET_AI_SERVICE:-widget-ai}"
PROFILE="${WIDGET_AI_PROFILE:-manual}"
CONTAINER="${WIDGET_AI_CONTAINER:-ubersdr-claude}"
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

  # Launch the container inside a detached tmux session and attach. Closing the
  # window detaches; the session + container keep running.
  #
  # --name pins the container name to $CONTAINER, which must stay in the
  # instance's admin->widget_trusted_hosts list — that name is what authorises
  # the assistant's /admin/widgets/* calls, so no password is passed in.
  say "Starting the Widget AI container…"
  tmux new-session -d -s "$SESSION" -n "$SESSION" \
    "cd '$UBERSDR_DIR' && docker compose --profile '$PROFILE' -f '$COMPOSE_FILE' run --rm --name '$CONTAINER' '$SERVICE'; \
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
  # Note whether a session is live BEFORE pulling, so we can put it back
  # afterwards. The pull runs first: if it fails, set -e aborts here and the
  # running session is left untouched.
  local was_running=0
  if container_running || session_running; then was_running=1; fi

  say "Pulling the latest image ($IMAGE)…"
  compose pull "$SERVICE"
  ok "Image up to date."

  if [ "$was_running" -eq 0 ]; then
    return 0
  fi

  # A session was running on the old image — cycle it so the new one takes
  # effect. do_start reattaches, so this lands you back in the assistant.
  say "Restarting the running session on the new image…"
  do_stop
  do_start
}

# ---------------------------------------------------------------------------
# Interactive menu
# ---------------------------------------------------------------------------
menu() {
  while true; do
    printf '\n%s╔══════════════════════════════════════════════╗%s\n' "$C_CYAN" "$C_RST"
    printf   '%s║  UberSDR Widget AI                           ║%s\n' "$C_CYAN" "$C_RST"
    printf   '%s╚══════════════════════════════════════════════╝%s\n' "$C_CYAN" "$C_RST"
    printf   '  Status: %b\n\n' "$(status_line)"
    printf   '%s%s⚠ A paid Claude subscription is required.%s\n' "$C_BOLD" "$C_YELLOW" "$C_RST"
    printf   '%s  Anthropic does not permit Free-tier access to the\n' "$C_YELLOW"
    printf   '  Claude Code CLI that powers this assistant.%s\n\n' "$C_RST"
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
