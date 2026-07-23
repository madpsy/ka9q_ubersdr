#!/usr/bin/env bash
#
# widget-ai.sh — AI-assisted UberSDR widget authoring.
#
# Spins up Claude Code in a throwaway working directory pre-loaded with the
# create-widget skill and the reference widgets, then hands you an interactive
# session to CREATE a new widget or EDIT one of your existing (custom/cloned)
# widgets. All persistence happens through the instance admin API — the working
# directory is ephemeral and deleted on exit.
#
# Intended to be launched from the UberSDR gotty web terminal.
#
#   Env overrides:
#     UBERSDR_DIR    installed instance dir holding get-password.sh + the
#                    pre-staged skill fallback   (default: $HOME/ubersdr)
#     BASE           admin API base URL          (default: http://localhost:8080)
#     BRANCH         git branch to pull the skill from   (default: main)

set -euo pipefail

REPO="madpsy/ka9q_ubersdr"
BRANCH="${BRANCH:-main}"
SKILL_SUBDIR=".claude/skills/create-widget"
UBERSDR_DIR="${UBERSDR_DIR:-$HOME/ubersdr}"
BASE="${BASE:-http://localhost:8080}"

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
# 2. Ephemeral working directory (cleaned up on exit).
# ---------------------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/widget-ai.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM
mkdir -p "$WORK/$SKILL_SUBDIR" "$WORK/widgets" "$WORK/widgets-custom" "$WORK/.claude"

# ---------------------------------------------------------------------------
# 3. Load the skill + reference widgets: latest from GitHub, else pre-staged.
# ---------------------------------------------------------------------------
if curl -fsSL --max-time 20 "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" \
     | tar -xz -C "$WORK" --strip-components=1 \
         "ka9q_ubersdr-$BRANCH/$SKILL_SUBDIR" \
         "ka9q_ubersdr-$BRANCH/widgets" 2>/dev/null; then
  say "Loaded latest widget skill from GitHub."
else
  say "GitHub unreachable — falling back to the pre-staged skill copy."
  cp -r "$UBERSDR_DIR/widget-skill/.claude/." "$WORK/.claude/" 2>/dev/null || true
  cp -r "$UBERSDR_DIR/widget-skill/widgets/." "$WORK/widgets/"   2>/dev/null || true
fi
[ -f "$WORK/$SKILL_SUBDIR/SKILL.md" ] || \
  die "Widget skill unavailable (no network and no pre-staged copy at $UBERSDR_DIR/widget-skill)."

# ---------------------------------------------------------------------------
# 4. Pre-fetch the admin password so Claude never has to shell out to sudo.
#    Best-effort: if it fails, the skill still knows how to run get-password.sh.
# ---------------------------------------------------------------------------
export BASE
if [ -x "$UBERSDR_DIR/get-password.sh" ]; then
  PW="$("$UBERSDR_DIR/get-password.sh" 2>/dev/null | awk -F': ' '/^Admin Password:/{print $2}')" || true
  if [ -n "${PW:-}" ]; then
    export UBERSDR_ADMIN_PASSWORD="$PW"
    say "Admin credentials loaded into the session."
  else
    echo "  (could not read the admin password automatically — Claude will run get-password.sh when needed)"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Permission allowlist so the API workflow doesn't prompt on every command.
# ---------------------------------------------------------------------------
cat > "$WORK/.claude/settings.json" <<'JSON'
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
  │    • "Edit my callsign lookup widget to add a copy button" │
  │                                                            │
  │  Changes are saved to your instance via the admin API.     │
  │  This folder is temporary and removed when you exit.       │
  └───────────────────────────────────────────────────────────┘

EOF

# Not exec'd, so the cleanup trap still fires when Claude exits.
claude "$@" || true
