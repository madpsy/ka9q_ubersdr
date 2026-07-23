#!/usr/bin/env bash
#
# widget-ai.sh — AI-assisted UberSDR widget authoring.
#
# Installs Claude Code (first run), refreshes the create-widget skill from the
# repo into your personal skills dir, then drops you into an interactive Claude
# session to CREATE a new widget or EDIT one of your existing (custom/cloned)
# widgets. All persistence happens through the instance admin API.
#
#   • The skill lives at ~/.claude/skills/create-widget/SKILL.md — persistent and
#     refreshed on every launch, so you can inspect it and plain `claude` sees it.
#   • Reference widgets + scratch files live in a throwaway temp dir (removed on
#     exit) — the real widgets live on your instance behind the admin API.
#
# Intended to be launched from the UberSDR gotty web terminal.
#
#   Env overrides:
#     UBERSDR_DIR    installed instance dir holding get-password.sh  (default: $HOME/ubersdr)
#     BASE           admin API base URL          (default: http://localhost:8080)
#     BRANCH         git branch to pull from     (default: main)

set -euo pipefail

REPO="madpsy/ka9q_ubersdr"
BRANCH="${BRANCH:-main}"
RAW="https://raw.githubusercontent.com/$REPO/refs/heads/$BRANCH"
UBERSDR_DIR="${UBERSDR_DIR:-$HOME/ubersdr}"
BASE="${BASE:-http://localhost:8080}"
SKILL_DIR="$HOME/.claude/skills/create-widget"

# The widget workflow is almost entirely piped curl/jq commands, which the
# per-command permission matcher can't allowlist cleanly — so by default we run
# Claude in a no-prompt mode. This is an owner-operated tool in a throwaway dir
# talking to your own admin API. Set WIDGET_AI_PERMISSION_MODE=default (or
# acceptEdits) to restore normal prompting.
PERM_MODE="${WIDGET_AI_PERMISSION_MODE:-bypassPermissions}"

say() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Prerequisites: claude, plus curl/tar/jq used by the skill's API recipes.
# ---------------------------------------------------------------------------
command -v curl >/dev/null 2>&1 || die "curl is required but not installed."
command -v tar  >/dev/null 2>&1 || die "tar is required but not installed."

if ! command -v jq >/dev/null 2>&1; then
  say "jq not found — attempting install (needed for the widget API workflow)…"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y jq || true
  fi
  command -v jq >/dev/null 2>&1 || \
    echo "  (warning: jq still missing — the API recipes in the skill won't run cleanly)"
fi

# Claude Code — install on first use via the official native installer.
export PATH="$HOME/.local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  say "Installing Claude Code…"
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
command -v claude >/dev/null 2>&1 || die "Claude Code install failed — is $HOME/.local/bin on PATH?"

# ---------------------------------------------------------------------------
# 2. Refresh the create-widget skill into the personal skills dir.
#    Persistent (survives exit, inspectable, visible to plain `claude`); the
#    previous copy is used if the network is down.
# ---------------------------------------------------------------------------
mkdir -p "$SKILL_DIR"
if curl -fsSL --max-time 20 "$RAW/.claude/skills/create-widget/SKILL.md" -o "$SKILL_DIR/SKILL.md.tmp"; then
  mv "$SKILL_DIR/SKILL.md.tmp" "$SKILL_DIR/SKILL.md"
  say "Widget skill up to date:  $SKILL_DIR/SKILL.md"
else
  rm -f "$SKILL_DIR/SKILL.md.tmp"
  [ -f "$SKILL_DIR/SKILL.md" ] \
    && say "Offline — using previously fetched skill: $SKILL_DIR/SKILL.md" \
    || die "Could not fetch the widget skill from the repo and no local copy exists."
fi

# ---------------------------------------------------------------------------
# 3. Ephemeral working dir: reference widgets + scratch + session permissions.
# ---------------------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/widget-ai.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM
mkdir -p "$WORK/widgets" "$WORK/widgets-custom" "$WORK/.claude"

# Reference widgets are helpful for CREATE; editing via the API works without
# them, so this is best-effort.
if curl -fsSL --max-time 20 "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" \
     | tar -xz -C "$WORK" --strip-components=1 "ka9q_ubersdr-$BRANCH/widgets" 2>/dev/null; then
  say "Reference widgets loaded ($(ls "$WORK/widgets" | wc -l) files)."
else
  echo "  (reference widgets unavailable — creating from scratch still works)"
fi

# ---------------------------------------------------------------------------
# 4. Pre-fetch the admin password HERE (in the TTY, where sudo can prompt) and
#    export it, so Claude authenticates via $UBERSDR_ADMIN_PASSWORD and never
#    has to run sudo from its non-interactive shell. The path is absolute, so
#    cwd (the temp dir) is irrelevant.
# ---------------------------------------------------------------------------
export BASE
if [ -x "$UBERSDR_DIR/get-password.sh" ]; then
  PW="$("$UBERSDR_DIR/get-password.sh" 2>/dev/null | awk -F': ' '/^Admin Password:/{print $2}')" || true
  if [ -n "${PW:-}" ]; then
    export UBERSDR_ADMIN_PASSWORD="$PW"
    say "Admin credentials loaded into the session."
  else
    echo "  (could not read the admin password automatically — Claude will run $UBERSDR_DIR/get-password.sh when needed)"
  fi
else
  echo "  (note: $UBERSDR_DIR/get-password.sh not found — set UBERSDR_ADMIN_PASSWORD manually if the API returns 401)"
fi

# ---------------------------------------------------------------------------
# 5. Permission allowlist so the API workflow doesn't prompt on every command.
# ---------------------------------------------------------------------------
cat > "$WORK/.claude/settings.json" <<JSON
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": [
      "Bash(curl:*)",
      "Bash(jq:*)",
      "Bash(awk:*)",
      "Bash(cat:*)",
      "Bash(ls:*)",
      "Bash(echo:*)",
      "Bash($UBERSDR_DIR/get-password.sh)",
      "Read",
      "Write",
      "Edit"
    ]
  }
}
JSON

# ---------------------------------------------------------------------------
# 6. Hand over to an interactive Claude session in the working dir.
# ---------------------------------------------------------------------------
cd "$WORK"
cat <<EOF

  ┌───────────────────────────────────────────────────────────┐
  │  UberSDR Widget Assistant                                  │
  ├───────────────────────────────────────────────────────────┤
  │  Just tell Claude what you want, e.g.                      │
  │    • "Create a widget that shows the current UTC sunrise"  │
  │    • "List my widgets" / "Edit my callsign lookup widget"  │
  │                                                            │
  │  Your widgets live on your instance (admin API), not here. │
  │  This scratch folder is removed when you exit.             │
  └───────────────────────────────────────────────────────────┘

EOF

# Not exec'd, so the cleanup trap still fires when Claude exits.
# --permission-mode avoids a prompt on every piped curl/jq command (see PERM_MODE).
claude --permission-mode "$PERM_MODE" "$@" || true
