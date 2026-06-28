# Custom Widgets

This directory is where **your own** UberSDR widgets live. Anything you create
here is **git-ignored** (see `.gitignore`), so your local widgets are never
committed and are never clobbered when you pull upstream updates.

- `widgets/` (in the repo root) — the project's **bundled, version-controlled
  reference widgets**. Read them for examples; don't add new widgets there.
- `widgets-custom/` (this directory) — **your** widgets. Untracked by git.

Each widget is a single file named `<slug>.widget.html` — a self-contained HTML
*fragment* (a `<style>` block, the markup, and a `<script>` block), **not** a
full HTML document.

## Building a widget with Claude

Claude Code ships with a project skill called **`create-widget`** that knows the
full UberSDR widget contract — required close button, mobile hiding,
drag-to-reposition, the host globals exposed by `app.js`, the `/api/description`
fields, positioning conventions, and a ready-to-use template.

### How the skill gets loaded

The skill is defined in `.claude/skills/create-widget/SKILL.md`. Claude only
reads that file when the skill is invoked — it does **not** sit in context all
the time. The skill is triggered in two ways:

1. **Automatically** — when you ask Claude to build, add, or edit an UberSDR
   widget, it recognises the task from the skill's description and loads the
   `SKILL.md` instructions before doing any work.
2. **Explicitly** — type `/create-widget` (optionally followed by what you want)
   in the Claude Code prompt to invoke it directly.

Either way, Claude reads `SKILL.md` first, then writes the widget here in
`widgets-custom/`.

### How to use it

1. Ask Claude for the widget you want, e.g.:

   > Create a widget that shows the current solar flux index, top-right corner.

   or invoke it explicitly:

   > /create-widget a panel that lists the last 10 FT8 spots

2. Claude loads the `create-widget` skill, then creates
   `widgets-custom/<slug>.widget.html` following all the mandatory conventions
   (visible ✕ close button, hidden on mobile, draggable with position saved to
   `localStorage`, namespaced CSS IDs, etc.).

3. Iterate by describing changes — "make it wider", "move it to the left
   column", "poll every 2 seconds instead of 5" — and Claude edits the file in
   place.

### Using a widget in your instance

A widget file in this directory is just the source. To actually serve it,
register/enable it through the admin widget tooling (the
`/admin/widgets/*` endpoints handled by `widget_manager.go`) the same way the
bundled widgets are enabled.

## Doing it by hand

You don't have to use Claude — you can copy any file from `widgets/` as a
starting point and edit it. The non-negotiable rules every widget must follow
(close button, mobile hiding, drag-to-reposition, unique CSS namespace, and
reading `window.instanceDescription` instead of re-fetching `/api/description`)
are documented in `.claude/skills/create-widget/SKILL.md`, which doubles as the
canonical widget-authoring reference.
