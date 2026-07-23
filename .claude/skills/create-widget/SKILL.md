---
name: create-widget
description: Create, list, or edit widgets for the UberSDR web SDR interface — a widget is a self-contained HTML fragment (style + markup + script) injected into the host page, NOT a full HTML document. Use this whenever building, adding, listing, or editing UberSDR widgets, including requests like "list my widgets" or "edit my <X> widget". A user's existing widgets live on their instance and are managed through the admin API (GET /admin/widgets/mine), not as local files; the widgets/ directory only holds bundled reference implementations to read for examples.
---

# Skill: Create a UberSDR Widget

> **A widget is an HTML *fragment*, not a full HTML document.**
> Do **NOT** include `<!DOCTYPE>`, `<html>`, `<head>`, `<body>`, `<meta>`, or
> `<title>` tags. A widget consists only of a `<style>` block, the widget markup,
> and a `<script>` block — these are injected verbatim into the host page, which
> already provides the full document shell.

> **Four things every widget MUST have, no exceptions:**
> 1. A **visible ✕ close button** in the header — users must always be able to dismiss a widget
> 2. A **collapse/expand arrow** to the **left of the title** — collapses the widget to just its title bar; the collapsed/expanded state is persisted to `localStorage`
> 3. **Mobile hiding** — CSS `@media` + `html.is-mobile` + JS guard
> 4. **Drag-to-reposition** with `localStorage` persistence

> **ALWAYS start by reading the reference widgets in `widgets/`.**
> Before writing any new widget, **read at least one or two existing widgets in
> the `widgets/` directory** — they are the canonical, working reference
> implementations and the single best source of truth for the exact patterns,
> conventions, and host integrations used in this project. Pick the closest
> match to what you're building (see the table below) and copy its structure.
> Do not write a widget from memory or from this document alone when a concrete
> example exists.

> **The user's widgets live on the instance, NOT on local disk.**
> When asked *"what widgets do I have?"*, *"list my widgets"*, or *"edit my
> &lt;X&gt; widget"*, the source of truth is the admin API —
> `GET /admin/widgets/mine` (see *Submitting & editing widgets via the admin
> API*). **Never** answer from the local `widgets-custom/` folder: in the
> `widget-ai.sh` assistant that folder is empty scratch space, so an empty folder
> says **nothing** about what the user actually has. Always query the API before
> concluding anything about existing widgets, and match the user's wording
> fuzzily against `name`/`description`.

### Reference widgets to read (in `widgets/`)

| File | Good example of |
|---|---|
| `world_clocks.widget.html` | Self-contained `<canvas>` widget, `setInterval` redraw, extra `localStorage` prefs |
| `qrz_lookup.widget.html` | `callsign_lookup_complete` event bus, REST API call, `esc()` rendering |
| `audio.widget.html` | Web Audio analyser, RAF render loop capped to ~30 fps |
| `eq.widget.html` | Calling host DSP functions (`window.updateEqualizer`, presets) |
| `cw_spots.widget.html` | Reading host extension state (`window.cwSpotsExtensionInstance`), transient notifications |
| `marker.widget.html` | Wide layout, `1024px` mobile breakpoint, frequency tuning |
| `voice.widget.html` | Compact right-column status panel |
| `games.widget.html` | Vertically centred layout, self-contained interactivity |
| `frequency.widget.html` | Minimal badge, reading `#frequency` `data-hz-value` |
| `sstv.widget.html` | Tall image panel, addon proxy integration |

## What is a widget?

A widget is a **self-contained HTML fragment** (style + markup + script) that the
UberSDR server fetches from the collector (`instances.ubersdr.org`), caches in
memory, and injects verbatim into the main `index.html` page at render time via
Go's `template.HTML`. Because it is injected into an existing page, a widget is
**never a standalone HTML document** — it has no `<!DOCTYPE>`, `<html>`, `<head>`,
or `<body>` of its own. Every widget in `widgets/*.widget.html` is a canonical
reference implementation.

Widgets run in the **same browsing context** as the main SDR page — they share
`window`, the DOM, and all globals exposed by `app.js`. There is no iframe, no
shadow DOM, no module boundary.

---

## Example requests

Widgets can be purely self-contained (driven only by the browser, with no host
services) or deeply integrated with the SDR (reading `window.instanceDescription`,
tuning the radio, reacting to spots, etc.). A few representative things a user
might ask for:

- *"A widget showing analogue clocks for several world cities, with UTC/Zulu
  first, that I can click to switch between analogue and a 24-hour digital
  readout."* — self-contained; uses `Intl.DateTimeFormat` for timezones (and
  DST), a `setInterval` redraw loop on `<canvas>`, and a second `localStorage`
  key to remember the analogue/digital choice. See
  `widgets-custom/world_clocks.widget.html` for the worked implementation.
- *"A panel that shows the current band conditions / space weather."* —
  reads host state and/or polls a server API.
- *"A clickable list of my favourite frequencies that tunes the radio."* —
  tunes via the canonical recipe (`setFrequencyInputValue` → `updateBandButtons`
  → `setMode` → `updateURL` → `autoTune`, then pan the spectrum). See
  "Tuning the radio (canonical recipe)" below.
- *"A live readout of the callsign currently being looked up."* — listens on
  the `callsign_lookup_complete` event bus.

Whatever the request, every widget still obeys the four non-negotiables (close
button, collapse arrow, mobile hiding, drag-to-reposition) and any user
preference it exposes (display mode, units, selected items, collapsed state, …)
should be persisted to `localStorage` under its own `<slug>_widget_*` key so it
survives a reload.

---

## File naming & location

| Convention | Example |
|---|---|
| Filename | `<slug>.widget.html` |
| Location for **new** widgets | `widgets-custom/<slug>.widget.html` |
| Bundled reference widgets | `widgets/<slug>.widget.html` |
| CSS ID prefix | `#<slug>-widget` (all IDs must be unique across the whole page) |

> **Where to put a new widget:** create it in **`widgets-custom/`**. That
> directory is for user-created widgets and is **git-ignored**, so your local
> widgets won't be committed or clobbered by upstream updates. The `widgets/`
> directory holds the project's bundled, version-controlled reference
> implementations — read them for examples, but **do not add new widgets there**
> (and don't edit them unless you're intentionally changing a shipped widget).

Always prefix **every** CSS ID and class with a short, unique namespace (e.g.
`qrz-`, `aviz-`, `eqw-`, `csn-`) to avoid collisions with the host page or
other widgets.

---

## File structure

A widget file has exactly three sections in this order:

```html
<!-- Widget Name
     ============
     One-paragraph description of what the widget does.
     List any host services or globals it requires.
     Drag to reposition; position saved in localStorage.
-->

<style>
  /* All rules scoped under the widget's root ID */
</style>

<!-- Optional extra DOM elements appended to <body> (modals, toasts) -->

<div id="<slug>-widget" style="display:none;">
  <!-- widget markup -->
</div>

<script>
(function () {
  'use strict';
  /* all logic here */
})();
</script>
```

The opening comment block is mandatory — the collector displays it as the widget
description.

---

## Default positioning & avoiding overlap

Widgets are `position: fixed` and default to a hardcoded `top`/`left` (or
`top`/`right`) that is only used on first load — after the user drags the widget
the position is saved in `localStorage` and restored on every subsequent load.

### Existing widget layout map

Use this table when choosing a default position for a new widget so it does not
land on top of an existing one at first launch.

| Widget | Default anchor | Approx size | Notes |
|---|---|---|---|
| `cw_spots` | `top: 80px, left: 44px` | ~180 × 60 px | Transient notification, fades out |
| `qrz_lookup` | `top: 160px, left: 44px` | 160–220 × 120 px | Below cw_spots on left |
| `marker` | `top: 140px, left: 12px` | ~360 × 80 px | Wide; z-index 900 (behind others) |
| `sstv` | `top: 80px, left: 12px` | ~340 × 300 px | Tall image panel |
| `games` | `top: 50%, left: 12px` | ~340 × auto | Vertically centred |
| `voice` | `top: 80px, right: 44px` | ~260 × 80 px | Right column, top |
| `audio` | `top: 120px, right: 44px` | 300 × 220 px | Right column, below voice |
| `eq` | `top: 340px, right: 44px` | ~290 × 160 px | Right column, below audio |
| `frequency` | `top: 8px, left: 8px` | badge only | Absolute, not draggable |

### Choosing a default position

**Left column** (`left: 44px`) — already used from `top: 80px` down. Place new
left-column widgets at `top: 300px` or lower, or use a different `left` offset
(e.g. `left: 280px`) to start a second column.

**Right column** (`right: 44px`) — used from `top: 80px` to ~`top: 500px`.
Place new right-column widgets at `top: 520px` or lower.

**Centre / other** — use `left: 50%; transform: translateX(-50%)` for a centred
widget, or pick a `left` value between 300–600 px to avoid both columns.

**General rules:**
- Leave at least **80 px vertical gap** between default positions in the same
  column so widgets don't visually collide on first load.
- Prefer `right: 44px` for audio/signal-processing widgets (matches `audio` and
  `eq`) and `left: 44px` for data/lookup widgets (matches `qrz_lookup`,
  `cw_spots`).
- The user can always drag to reposition — the default only matters for the very
  first impression. Err on the side of a lower `top` value (further down the
  page) rather than overlapping something important.

### localStorage key collision check

Every widget uses a unique `localStorage` key for its position. Before choosing
a key, verify it is not already taken:

| Widget | localStorage key |
|---|---|
| `cw_spots` | `cw_spot_widget_pos` |
| `qrz_lookup` | `qrz_widget_pos` |
| `marker` | `sdr-marker-widget-pos` |
| `audio` | `aviz_widget_pos` |
| `eq` | `eqw_widget_pos` |

Use the pattern `<slug>_widget_pos` for new widgets (e.g. `mywidget_widget_pos`).

---

## Visual design conventions

All existing widgets share a consistent glassmorphism aesthetic. Copy these
values exactly unless you have a strong reason to deviate.

### Container

```css
#mywidget {
  position: fixed;
  top: 160px;          /* adjust per widget */
  left: 44px;          /* or right: 44px */
  z-index: 9500;
  pointer-events: auto;

  /* Glass panel */
  background: rgba(52, 73, 94, 0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  color: #fff;
  border-radius: 6px;
  font-family: 'Courier New', Courier, monospace;
  font-size: 11px;
  font-weight: bold;
  line-height: 1.4;
  white-space: nowrap;
  box-shadow: 0 2px 10px rgba(0,0,0,0.6);

  /* Accent stripe — pick a colour that suits the widget's purpose */
  border-left: 3px solid rgba(255,255,255,0.3);  /* neutral */
  /* border-left: 3px solid rgba(0, 230, 118, 0.6); */ /* green — audio/EQ */
  /* border-left: 3px solid rgba(23, 162, 184, 0.35); */ /* cyan — spots */

  cursor: grab;
  user-select: none;
}

#mywidget.mywidget-dragging {
  cursor: grabbing;
  box-shadow: 0 4px 20px rgba(0,0,0,0.8);
}
```

### Header bar

```css
#mywidget-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 8px 4px 9px;
  border-bottom: 1px solid rgba(255,255,255,0.15);
}

#mywidget-title {
  font-size: 10px;
  font-weight: bold;
  letter-spacing: 0.5px;
  color: rgba(255,255,255,0.85);
  text-transform: uppercase;
}
```

### Close button

```css
#mywidget-close {
  width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; line-height: 1;
  color: rgba(255,255,255,0.7);
  cursor: pointer;
  border-radius: 3px;
  transition: color 0.15s, background 0.15s;
  flex-shrink: 0;
}
#mywidget-close:hover { color: #fff; background: rgba(0,0,0,0.3); }
```

```html
<span id="mywidget-close" title="Dismiss">&#x2715;</span>
```

### Mobile hiding (mandatory)

Every widget **must** hide itself on narrow screens and real mobile devices:

```css
@media (max-width: 768px) {
  #mywidget { display: none !important; }
}
/* Real mobile devices detected via UA + touch-points by app.js */
html.is-mobile #mywidget { display: none !important; }
```

For widgets that need even more horizontal space, use `1024px` instead of
`768px` (see `marker.widget.html`).

Also guard the script entry point:

```js
if (window._isMobile || window.innerWidth <= 768) return;
```

---

## Drag-to-reposition (standard pattern)

Copy this block verbatim and substitute your widget element and localStorage key.

```js
var LS_POS_KEY     = 'mywidget_pos';
var DRAG_THRESHOLD = 5;
var widget    = document.getElementById('mywidget');
var dragState = null;
var wasDragged = false;

// Restore saved position
(function restorePosition() {
  try {
    var saved = localStorage.getItem(LS_POS_KEY);
    if (saved) {
      var pos = JSON.parse(saved);
      if (typeof pos.top === 'number' && typeof pos.left === 'number') {
        widget.style.top  = pos.top  + 'px';
        widget.style.left = pos.left + 'px';
      }
    }
  } catch (e) { /* ignore */ }
})();

// Drag start — attach to the widget root (or header only for larger widgets)
widget.addEventListener('mousedown', function (e) {
  if (e.target === closeEl || closeEl.contains(e.target)) return;
  if (e.button !== 0) return;
  var rect = widget.getBoundingClientRect();
  dragState = { startX: e.clientX, startY: e.clientY,
                origTop: rect.top, origLeft: rect.left };
  wasDragged = false;
  e.preventDefault();
});

document.addEventListener('mousemove', function (e) {
  if (!dragState) return;
  var dx = e.clientX - dragState.startX;
  var dy = e.clientY - dragState.startY;
  if (!wasDragged && Math.sqrt(dx*dx + dy*dy) > DRAG_THRESHOLD) {
    wasDragged = true;
    widget.classList.add('mywidget-dragging');
  }
  if (wasDragged) {
    var newTop  = Math.max(0, Math.min(dragState.origTop  + dy,
                                       window.innerHeight - widget.offsetHeight));
    var newLeft = Math.max(0, Math.min(dragState.origLeft + dx,
                                       window.innerWidth  - widget.offsetWidth));
    widget.style.top  = newTop  + 'px';
    widget.style.left = newLeft + 'px';
  }
});

document.addEventListener('mouseup', function () {
  if (!dragState) return;
  widget.classList.remove('mywidget-dragging');
  if (wasDragged) {
    try {
      localStorage.setItem(LS_POS_KEY, JSON.stringify({
        top:  parseInt(widget.style.top,  10),
        left: parseInt(widget.style.left, 10)
      }));
    } catch (e) { /* ignore */ }
  }
  dragState = null;
  setTimeout(function () { wasDragged = false; }, 0);
});
```

For widgets with a dedicated drag handle (header only), attach `mousedown` to
the header element and skip interactive children:

```js
header.addEventListener('mousedown', function (e) {
  if (e.target === closeEl || closeEl.contains(e.target)) return;
  if (e.target.classList.contains('mywidget-tab')) return;
  // ... rest of drag start
});
```

---

## Close / dismiss pattern (mandatory)

**Every widget must have a visible ✕ close button.** Users must always be able
to dismiss a widget without reloading the page. The button goes in the header,
top-right corner, using the standard close button CSS (see "Header bar" above).

The `dismissed` flag prevents the widget from reappearing after the user closes
it — any event listener, poll, or service-availability callback that would
otherwise call `widget.style.display = ''` must check this flag first.

```html
<!-- In the header markup — always present, never optional -->
<span id="myw-close" title="Dismiss">&#x2715;</span>
```

```js
var dismissed = false;
var closeEl   = document.getElementById('myw-close');

closeEl.addEventListener('click', function (e) {
  e.stopPropagation();   // don't trigger widget drag
  dismissed = true;
  widget.style.display = 'none';
  // Cancel background work so it doesn't burn CPU while hidden:
  // if (rafId)  { cancelAnimationFrame(rafId); rafId = null; }
  // if (pollId) { clearInterval(pollId);       pollId = null; }
});
```

Check `dismissed` everywhere the widget could become visible again:

```js
// In event listeners, polls, service-availability callbacks, etc.:
if (dismissed) return;
widget.style.display = '';
```

---

## Collapse / expand arrow (mandatory)

**Every widget must have a collapse/expand arrow immediately to the LEFT of the
title.** Clicking it collapses the widget down to just its title bar (hiding the
body); clicking again restores it. This is separate from the ✕ close button:
collapse **hides the body but keeps the widget alive** (no disconnect, no
`dismissed` flag, background work keeps running), whereas close dismisses it.

The collapsed/expanded state is a **user preference and MUST be persisted** to
`localStorage` under the widget's own `<slug>_widget_collapsed` key, and
**restored on load** so the widget reopens in the state the user left it.

### Arrow glyphs

Use the two triangle glyphs, swapped by state (do **not** rotate one with CSS —
just change the character):

- Expanded → `&#x25BE;` (▾, pointing down)
- Collapsed → `&#x25B8;` (▸, pointing right)

### Markup — arrow is the FIRST child of the header, before the title

```html
<div id="myw-header">
  <span id="myw-collapse" title="Collapse">&#x25BE;</span>
  <span id="myw-title">My Widget</span>
  <span id="myw-close" title="Dismiss">&#x2715;</span>
</div>
```

### CSS — arrow style + collapsed-state rule

```css
#myw-collapse {
  width: 14px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; line-height: 1;
  color: rgba(255,255,255,0.7);
  cursor: pointer;
  flex-shrink: 0;
  margin-right: 6px;
  transition: color 0.15s;
  user-select: none;
}
#myw-collapse:hover { color: #fff; }

/* Collapse to the title bar: hide every direct child of the root except the
   header. This keeps the header (and the ✕ inside it) visible. */
#myw-widget.myw-collapsed > :not(#myw-header) { display: none !important; }
#myw-widget.myw-collapsed #myw-header { border-bottom: none; }
```

> **Keeping the arrow next to the title.** If the header uses
> `justify-content: space-between`, adding the arrow as a third flex item pushes
> the title to the centre. Give the **title** `margin-right: auto` so the
> arrow + title hug the left and the close/controls stay on the right. If the
> header already has a `gap`, don't add a big `margin-right` on the arrow too or
> you get a double gap (see `marker.widget.html`, which uses a negative margin
> to compensate).
>
> **Close button outside the header?** A few widgets (e.g. `cw_spots`) put the
> ✕ as a sibling of the header, not inside it. Then exempt it as well:
> `#root.collapsed > :not(#header):not(#close) { display:none !important; }`.
>
> **Body isn't a direct child?** The `> :not(#header)` rule only hides direct
> children of the root. That's the normal case (header + body sections are
> siblings). If a control lives *inside* the header and should hide when
> collapsed (e.g. a space-filling slider), hide it with its own rule.

### JS — toggle, persist, restore, and skip in the drag handler

```js
var LS_COLLAPSED_KEY = 'myw_widget_collapsed';
var collapseEl = document.getElementById('myw-collapse');

function setCollapsed(state, save) {
  widget.classList.toggle('myw-collapsed', state);
  collapseEl.innerHTML = state ? '&#x25B8;' : '&#x25BE;'; // ▸ collapsed, ▾ expanded
  collapseEl.title = state ? 'Expand' : 'Collapse';
  if (save) {
    try { localStorage.setItem(LS_COLLAPSED_KEY, state ? '1' : '0'); } catch (e) { /* ignore */ }
  }
}

// Restore saved state on load (default: expanded). Do this even while the
// widget is display:none — the class is applied and takes effect on reveal.
(function restoreCollapsed() {
  var state = false;
  try { state = localStorage.getItem(LS_COLLAPSED_KEY) === '1'; } catch (e) { /* ignore */ }
  setCollapsed(state, false);
})();

collapseEl.addEventListener('click', function (e) {
  e.stopPropagation();               // don't start a drag
  setCollapsed(!widget.classList.contains('myw-collapsed'), true);
});
```

Add the arrow to the drag-start guard exactly like the close button, so clicking
it never begins a drag:

```js
// mousedown-based drag:
if (e.target === collapseEl || collapseEl.contains(e.target)) return;

// pointerdown + closest()-based drag (marker/sstv/games):
if (e.target.closest('#myw-collapse, button, select, …')) return;
```

If the widget scrolls its body (e.g. a log/output pane), **jump to the bottom on
expand** so the latest content is visible — remove the class first so the body is
laid out and measurable:

```js
collapseEl.addEventListener('click', function (e) {
  e.stopPropagation();
  var nowCollapsed = !widget.classList.contains('myw-collapsed');
  setCollapsed(nowCollapsed, true);
  if (!nowCollapsed) outputEl.scrollTop = outputEl.scrollHeight;
});
```

---

## `window.instanceDescription` — the server description object

`app.js` fetches `/api/description` once at page load and stores the result in
`window.instanceDescription`. It also exposes `window.descriptionPromise` (a
`Promise` that resolves to the same object) for async/await code.

> ⚠️ **Widgets must NEVER call `fetch('/api/description')` themselves.**
> The data is already available — use `window.instanceDescription` (sync, may
> be `undefined` briefly at startup) or `await window.descriptionPromise`
> (async, always resolves). Fetching the endpoint again wastes a round-trip and
> duplicates work already done by the host page.

### Two access patterns

**Pattern A — async/await** (simplest; use when the widget can wait):

```js
(async function () {
  'use strict';
  if (window._isMobile || window.innerWidth <= 768) return;

  let desc;
  try {
    desc = await window.descriptionPromise;
  } catch (e) { return; }

  if (!desc) return;
  // Use desc.receiver.callsign, desc.lookup_service, etc.
})();
```

**Pattern B — polling** (use when the widget needs to react to the value but
also has other setup to do synchronously, e.g. drag/close wiring):

```js
(function waitForDescription() {
  var attempts = 0;
  var timer = setInterval(function () {
    attempts++;
    var desc = window.instanceDescription;
    if (desc) {
      clearInterval(timer);
      onDescriptionReady(desc);
      return;
    }
    if (attempts >= 20) {          // give up after ~10 s
      clearInterval(timer);
      onDescriptionUnavailable();
    }
  }, 500);
})();
```

### Full field reference

All fields come from the server's `/api/description` response. Fields marked
*(optional)* are omitted when the feature is disabled or unavailable.

| Field | Type | Description |
|---|---|---|
| `description` | `string` | Human-readable station description |
| `default_frequency` | `number` | Default dial frequency in Hz |
| `default_mode` | `string` | Default demodulator mode (`'usb'`, `'lsb'`, `'cwu'`, …) |
| `version` | `string` | Server software version string |
| `server_time` | `string` | Server UTC time (RFC3339Nano) |
| `server_time_sync` | `boolean` | Whether server clock is NTP-synced |
| `max_clients` | `number` | Maximum simultaneous sessions |
| `available_clients` | `number` | Currently available session slots |
| `max_session_time` | `number` | Max session duration in seconds (0 = unlimited) |
| `bypassed_users_only` | `boolean` | True when only bypass-auth users are allowed |
| `public_uuid` | `string` | Instance public UUID (from collector) |
| `cors_enabled` | `boolean` | Whether CORS is enabled |
| `spectrum_poll_period` | `number` | Spectrum WebSocket poll period in ms |
| `lookup_service` | `boolean` | Whether callsign lookup (QRZ/HamQTH) is enabled |
| `space_weather` | `boolean` | Whether space weather monitoring is enabled |
| `noise_floor` | `boolean` | Whether noise floor monitoring is enabled |
| `spectrogram` | `boolean` | Whether spectrogram recording is enabled |
| `digital_decodes` | `boolean` | Whether digital decoder (FT8/WSPR/…) is enabled |
| `digital_modes` | `string[]` | List of enabled digital modes e.g. `["FT8","WSPR"]` |
| `cw_skimmer` | `boolean` | Whether CW skimmer is enabled |
| `cw_skimmer_rbn_spots` | `boolean` | Whether CW skimmer RBN spot forwarding is enabled |
| `cw_skimmer_callsign` | `string` | CW skimmer operator callsign |
| `chat_enabled` | `boolean` | Whether the chat/DX cluster is enabled |
| `chat_users` | `number` | Current number of chat users |
| `speech_to_text` | `boolean` | Whether Whisper speech-to-text is enabled |
| `public_iq_modes` | `string[]` | IQ modes accessible without auth e.g. `["iq48"]` |
| `addons` | `string[]` | Names of enabled public addon proxies e.g. `["sstv","rmnoise"]` |
| `enabled_widgets` | `{widget_id, name, is_public}[]` | Widgets currently enabled on this instance |

**`receiver` object** — station hardware/location info:

| Field | Type | Description |
|---|---|---|
| `receiver.name` | `string` | Station name |
| `receiver.callsign` | `string` | Operator callsign |
| `receiver.public_url` | `string` | Public URL of this instance |
| `receiver.location` | `string` | Human-readable location string |
| `receiver.antenna` | `string` | Antenna description |
| `receiver.asl` | `number` | Altitude above sea level (metres) |
| `receiver.snr_0_30_mhz` | `number` | Wideband SNR 0–30 MHz (dB, -1 = unavailable) |
| `receiver.snr_1_8_30_mhz` | `number` | HF SNR 1.8–30 MHz (dB, -1 = unavailable) |
| `receiver.gps.lat` | `number` | Latitude (decimal degrees) |
| `receiver.gps.lon` | `number` | Longitude (decimal degrees) |
| `receiver.gps.maidenhead` | `string` | Maidenhead grid locator e.g. `"IO91wm"` |
| `receiver.gps.gps_enabled` | `boolean` | Whether GPS position is enabled |
| `receiver.gps.tdoa_enabled` | `boolean` | Whether TDoA is enabled |

**`rotator` object** — always present:

| Field | Type | Description |
|---|---|---|
| `rotator.enabled` | `boolean` | Whether rotator control is configured |
| `rotator.connected` | `boolean` | Whether rotctld is currently connected |
| `rotator.azimuth` | `number` | Current azimuth in degrees (-1 = unknown) |

**`frequency_reference` object** — always present:

| Field | Type | Description |
|---|---|---|
| `frequency_reference.enabled` | `boolean` | Whether frequency reference monitoring is on |
| `frequency_reference.frequency_offset` | `number` | Measured offset in Hz *(optional — only when data available)* |
| `frequency_reference.expected_frequency` | `number` | Reference signal expected frequency *(optional)* |
| `frequency_reference.detected_frequency` | `number` | Detected frequency *(optional)* |
| `frequency_reference.signal_strength` | `number` | Signal strength *(optional)* |
| `frequency_reference.snr` | `number` | SNR of reference signal *(optional)* |

**`ant_switch` object** *(optional — omitted when disabled)*:
Present when antenna switching is enabled; contains `enabled`, selected port
numbers, and active port labels. Check `desc.ant_switch` for existence.

**`dsp` object** *(optional)*:

| Field | Type | Description |
|---|---|---|
| `dsp.enabled` | `boolean` | Whether server-side DSP/NR is available |
| `dsp.filters` | `string[]` | Available DSP filter names *(only when enabled)* |

**`gpsdo` object** *(optional — omitted when device absent or unhealthy)*:
Present when a Leo Bodnar LBE-1420 GPSDO is connected and fully operational.
Check `if (desc.gpsdo)` for presence.

**`pskreporter_rank` object** *(optional)*:
Present when digital decoding + PSKReporter are enabled and rank data is
available. Contains `reporter_callsign`, `reports`, `countries`, `last_updated`.

### Common access patterns

```js
// Station callsign (lazy read — safe to call any time after page load)
function getCallsign() {
  return (window.instanceDescription &&
          window.instanceDescription.receiver &&
          window.instanceDescription.receiver.callsign) || '';
}

// Feature gate — is the lookup service available?
var lookupEnabled = window.instanceDescription &&
                    window.instanceDescription.lookup_service === true;

// Is a specific addon enabled?
var hasSstv = Array.isArray(window.instanceDescription &&
                            window.instanceDescription.addons) &&
              window.instanceDescription.addons.some(function (n) {
                return n.toLowerCase() === 'sstv';
              });

// Grid locator
var grid = window.instanceDescription &&
           window.instanceDescription.receiver &&
           window.instanceDescription.receiver.gps &&
           window.instanceDescription.receiver.gps.maidenhead;
```

---

## Host globals reference

These are the key globals exposed by `app.js` that widgets can read or call.
All are optional — guard with `typeof` or existence checks before use.

### State (read-only)

| Global | Type | Description |
|---|---|---|
| `window.instanceDescription` | `object` | Full `/api/description` response (see section above) |
| `window.descriptionPromise` | `Promise` | Resolves to `instanceDescription` — use with `await` |
| `window.currentMode` | `string` | Current demodulator mode: `'usb'`, `'cwu'`, `'am'`, … |
| `window.currentBandwidthLow` | `number` | Audio passband low edge (Hz, may be negative) |
| `window.currentBandwidthHigh` | `number` | Audio passband high edge (Hz) |
| `window.userSessionID` | `string` | Session UUID for API calls |
| `window._isMobile` | `boolean` | True when UA + touch-points indicate a real mobile device |
| `window.bookmarks` | `array` | Current bookmark list `[{frequency, mode, name, source}]` |
| `window.notchFilters` | `array` | Active notch filter objects |
| `window.notchEnabled` | `boolean` | Whether notch filtering is globally on |
| `window.spectrumDisplay` | `object` | Spectrum display state: `centerFreq`, `totalBandwidth`, `ws` |
| `window.vuAnalyser` | `AnalyserNode` | Web Audio analyser node (post-processing) |
| `window.analyser` | `AnalyserNode` | Fallback analyser node |
| `window.audioContext` | `AudioContext` | Web Audio context |
| `window._callsignLookupCache` | `Map` | **Shared** callsign lookup cache: `Map<string, {data, imageUrl}|null>` — writing to it (via `_fetchCallsignForMediaSession`) is visible to every lookup surface |
| `window._lookupServiceEnabled` | `boolean` | Mirror of `instanceDescription.lookup_service` |
| `window.cwSpotsExtensionInstance` | `object` | CW spots extension: `.spots[]` (each `{frequency, dx_call, country_code}`) |
| `window.dxClusterExtensionInstance` | `object` | DX cluster extension: `.spots[]` (each `{frequency, dx_call, country_code}`) |
| `window.dxClusterClient` | `object` | DX cluster WebSocket client |
| `window.VoiceActivityService` | `object` | Voice activity service — `.getLatest()` (`{enabled, band}`), `.getAllActivities()` |
| `window.markerNavTypes` | `string[]|null` | Host marker type filter preference |
| `window.wsManager` | `object` | Audio WebSocket manager — `.ws.readyState === WebSocket.OPEN` ⇒ an audio session is active |

### Functions (call with existence check)

| Function | Signature | Description |
|---|---|---|
| `window.setFrequencyInputValue` | `(hz: number)` | Write the dial input **without** tuning — step 1 of the tune recipe |
| `window.updateBandButtons` | `(hz: number)` | Sync band-button highlight to a frequency |
| `window.setMode` | `(mode: string, save: boolean)` | Change demodulator mode (`save=false` from widgets) |
| `window.updateURL` | `()` | Push current freq/mode state to the URL |
| `window.autoTune` | `()` | **Apply** the dial input — this is what actually tunes |
| `window.setFrequency` | `(hz: number)` | Dial-wheel/edge-arrow tune. **Not** the jump-to-saved-frequency path — see "Tuning the radio" below |
| `window.lookupCallsign` | `(callsign: string)` | Trigger QRZ lookup widget |
| `window.findMarkers` | `(hz, mode, navTypes)` | Find current/prev/next markers |
| `window.toggleEqualizer` | `()` | Toggle EQ on/off |
| `window.updateEqualizer` | `()` | Apply EQ slider values |
| `window.resetEqualizer` | `()` | Reset EQ to flat |
| `window.applyEQPreset` | `(preset: string)` | Apply named EQ preset |
| `window.addNotchFilter` | `(hz: number)` | Add a notch filter |
| `window.removeNotchFilter` | `(idx: number)` | Remove a notch filter by index |
| `window.toggleNotchFilter` | `()` | Toggle notch filtering on/off |
| `window.updateBandpassFilter` | `()` | Apply bandpass slider values |
| `window.toggleBandpassFilter` | `()` | Toggle bandpass on/off |
| `window.updateFFTSize` | `()` | Apply FFT size change |
| `window._normaliseCallsign` | `(raw: string) → string` | Strip /suffix, keep longest segment |
| `window._fetchCallsignForMediaSession` | `(cs: string) → Promise` | Fetch + cache callsign data — **also broadcasts** to all lookup surfaces (see "Markers, spots & callsign lookups"); for a non-leaking lookup, fetch `/api/lookup` directly |
| `window._refreshCallsignDisplays` | `()` | Refresh all callsign display elements |
| `window._notifyLookupWidgetIfCached` | `(marker)` | Fire lookup event from cache |

### DOM elements (read/write with care)

| ID | Description |
|---|---|
| `#frequency` | Frequency input; `data-hz-value` attribute = current Hz |
| `#fft-size` | FFT size select |
| `#equalizer-enable` | EQ enable checkbox |
| `#eq-<hz>` | EQ band slider (e.g. `#eq-1000`) |
| `#equalizer-makeup-gain` | EQ makeup gain slider |
| `#bandpass-enable` | Bandpass enable checkbox |
| `#bandpass-center` | Bandpass centre frequency slider |
| `#bandpass-width` | Bandpass width slider |
| `#notch-enable` | Notch enable checkbox |
| `#stereo-virtualizer-enable` | Stereo virtualiser checkbox |

---

## Markers, spots & callsign lookups

Widgets that work with on-air activity (spot lists, "guess the callsign" games,
marker navigation, flag/country display) draw on three host subsystems: the
**marker sources**, the **callsign lookup service**, and the **country list
API**. `marker.widget.html` is the canonical reference for all of this —
read its `collectMarkers()` / `fallbackFindMarkers()` and `updateInfoPanel()`.

### Marker sources & types

There is no single "all markers" global — markers are assembled on demand from
several live arrays. Each carries a callsign only for some types:

| Source global | Marker type | Per-item fields | Callsign field |
|---|---|---|---|
| `window.cwSpotsExtensionInstance.spots` | `cw` | `{frequency, dx_call, country_code}` | `dx_call` (always a callsign) |
| `window.dxClusterExtensionInstance.spots` | `dx` | `{frequency, dx_call, country_code}` | `dx_call` (always a callsign) |
| `window.VoiceActivityService.getAllActivities()` | `voice` | `{estimated_dial_freq\|start_freq, mode, band, dx_callsign, dx_country_code}` | `dx_callsign` (may be absent → placeholder name like `Voice 60m`) |
| `window.bookmarks` | `bookmark-local` / `bookmark-server` | `{frequency, mode, name, source}` | **none** — `name` is a label, *not* reliably a callsign |

Notes:
- `country_code` / `dx_country_code` are **ISO 3166-1 alpha-2** codes (for flag
  emoji), *not* country names. They may be empty.
- Voice activities only exist when the service is enabled — guard with
  `var st = window.VoiceActivityService && window.VoiceActivityService.getLatest(); if (st && st.enabled) { … }`.
- To collect **distinct callsigns** for something like a quiz, pull `dx_call`
  from CW + DX spots and `dx_callsign` from voice activities, into a `Set`.
  Skip bookmarks (their names aren't callsigns).

### Flag emoji rendering

Convert an ISO 3166-1 alpha-2 country code to a flag emoji using regional
indicator symbols. Every widget that shows flags uses this same helper:

```js
function iso2ToFlag(code) {
  if (!code || code.length !== 2) return '';
  var c = code.toUpperCase();
  var base = 0x1F1E6 - 0x41;
  try { return String.fromCodePoint(base + c.charCodeAt(0), base + c.charCodeAt(1)); }
  catch (e) { return ''; }
}
```

**Rendering rules — follow these exactly to avoid Safari layout bugs:**

1. **Use the standard widget font stack** (`'Courier New', Courier, monospace`) —
   do **not** add `'Twemoji Flags'`, `'Apple Color Emoji'`, or other emoji fonts
   to the widget's `font-family`. Safari and all modern browsers resolve regional
   indicator pairs to the system emoji font automatically; adding explicit emoji
   fonts before the monospace fallback causes Safari to misrender or produce
   large gaps.

2. **Do NOT wrap the flag in a `<span>` with a different `font-family`** — switching
   font families mid-inline-element causes "massive gap" layout bugs in Safari.
   Emit the flag as plain inline text.

3. **Separate flag from text with `\u00A0`** (non-breaking space), not a regular
   space, so the flag and callsign don't wrap independently.

4. **Place the flag before the callsign** (e.g. `🇬🇧\u00A0G3XYZ`) — this is the
   established convention across all widgets.

5. **Pass the combined string through `esc()` before `innerHTML`** — `esc()` only
   escapes `&`, `<`, `>`, `"`, so flag emoji (plain Unicode) pass through unchanged.

```js
// Correct — plain inline text, flag before callsign, esc() applied to whole string
var display = flag ? flag + '\u00A0' + callsign : callsign;
el.innerHTML = esc(display);

// Wrong — wrapper span causes Safari layout gaps
el.innerHTML = '<span style="font-family:emoji">' + flag + '</span>' + esc(callsign);

// Wrong — emoji font in widget font-family causes Safari misrender
// font-family: 'Twemoji Flags', 'Apple Color Emoji', 'Courier New', monospace;
```

Reference implementations: `qrz_lookup.widget.html` (line ~554),
`voice.widget.html` (line ~839), `cw_spots.widget.html`.

```js
function collectCallsigns() {
  var set = new Set();
  var cw = (window.cwSpotsExtensionInstance && window.cwSpotsExtensionInstance.spots) || [];
  var dx = (window.dxClusterExtensionInstance && window.dxClusterExtensionInstance.spots) || [];
  cw.forEach(function (s) { if (s && s.dx_call) set.add(s.dx_call); });
  dx.forEach(function (s) { if (s && s.dx_call) set.add(s.dx_call); });
  var va = window.VoiceActivityService;
  var st = va && va.getLatest && va.getLatest();
  if (va && st && st.enabled && typeof va.getAllActivities === 'function') {
    va.getAllActivities().forEach(function (a) { if (a && a.dx_callsign) set.add(a.dx_callsign); });
  }
  return Array.from(set);
}
```

### Current / prev / next marker for the dial

For "what's near the dial right now" use `window.findMarkers(dialHz, mode, navTypes)`
→ `{ current, prev, next }`, each `{ freq, mode, name, type, callsign, countryCode }`
or `null`. `navTypes` is an array of allowed types (`['cw','dx',…]`) or `null`
for all; honour `window.markerNavTypes` (the host's Audio-Settings preference)
when you want to match the dial wheel.

### Is the callsign lookup service usable?

Two independent conditions — check **both** before relying on lookups:

```js
// 1. Service enabled on this instance
var lookupOn = (window.instanceDescription &&
                window.instanceDescription.lookup_service === true) ||
               window._lookupServiceEnabled === true;

// 2. An audio session exists — /api/lookup returns 401 without one.
var audioOn = !!(window.wsManager && window.wsManager.ws &&
                 window.wsManager.ws.readyState === WebSocket.OPEN);
```

`/api/lookup` status codes: **401** no audio session, **404** not found,
**429** rate-limited (don't cache — retry later), **503** service disabled.
The result object exposes the country as **`data.country`** (fall back to
`data.land`); other fields include `name`, `name_fmt`, `fname`, `nickname`,
`grid`, and `image`.

### Two ways to look up a callsign — pick deliberately

**A. Shared path — `window._fetchCallsignForMediaSession(cs)` → `Promise`.**
On success it writes `window._callsignLookupCache` **and broadcasts the result
to every lookup surface**: it dispatches the `callsign_lookup_complete` event
and calls `_refreshCallsignDisplays()`, so the QRZ lookup widget, the marker
widget, and the media session all update. Use this when you *want* the shared
UI to reflect the lookup (the normal case). Read the result from the cache
after it resolves:

```js
window._fetchCallsignForMediaSession(cs).then(function () {
  var e = window._callsignLookupCache.get(cs);          // {data, imageUrl} | null
  var country = (e && e.data && e.data.country) ? e.data.country.trim() : '';
});
```

**B. Private path — fetch `/api/lookup` yourself.** Use this when the result
**must not leak** to other widgets — e.g. a "guess the country" game where the
QRZ widget showing the answer would spoil it. Hitting the endpoint directly
neither broadcasts nor touches the shared cache, so keep your own private
`Map` if you want to dedupe/cache:

```js
function lookupCountryPrivate(cs) {
  var uuid = window.userSessionID || '';
  if (!uuid) return Promise.resolve(null);
  return fetch('/api/lookup?callsign=' + encodeURIComponent(cs) + '&uuid=' + encodeURIComponent(uuid))
    .then(function (r) {
      if (r.status === 429) return null;          // rate-limited → retry later, don't cache
      if (!r.ok) return null;                     // 401/404/503
      return r.json().then(function (d) {
        return (d && d.country) ? String(d.country).trim() : null;
      });
    })
    .catch(function () { return null; });
}
```

`games.widget.html` (the "Callsign Quiz") is the worked example of the private
path plus the dual enabled/audio gating above.

### Country list — `/api/cty/countries`

Returns the full DXCC country list. Fetch it **once** and cache it in the
widget (don't refetch per use):

```js
fetch('/api/cty/countries')
  .then(function (r) { return r.ok ? r.json() : null; })
  .then(function (j) {
    if (j && j.success && j.data && j.data.countries) {
      // j.data.countries = [{ name, country_code, continent }, …]
    }
  });
```

`country_code` here is ISO2 (use it for flag emoji); `name` is the display
name. Sibling endpoint `/api/cty/continents` returns the continent list.

---

## Tuning the radio (canonical recipe)

When a widget tunes the receiver to a **saved / chosen frequency + mode** (a
favourites list, a spot click, a "jump to" button, etc.) it must use the full
sequence below — the same path `voice.widget.html`, `cw_spots.widget.html`, and
the bookmark dropdown use. Do **not** just call `window.setFrequency(hz)`: that
is the dial-wheel/edge-arrow path and skips `autoTune()`, the band-button sync,
and the URL update, so the radio often won't actually retune.

Every call is optional host glue — guard each with `typeof` and keep the
fallback that writes `#frequency` directly, so the widget degrades gracefully.

```js
// Tune to a saved { hz, mode }. Mirrors voice.widget.html / the bookmark dropdown.
function tuneTo(hz, mode) {
  if (typeof hz !== 'number' || isNaN(hz)) return;

  // 1. Write the dial input (rounded to whole Hz) — does NOT tune by itself.
  if (typeof window.setFrequencyInputValue === 'function') {
    window.setFrequencyInputValue(Math.round(hz));
  } else {
    var fi = document.getElementById('frequency');
    if (fi) fi.value = Math.round(hz);
  }

  // 2. Sync the band-button highlight.
  if (typeof window.updateBandButtons === 'function') window.updateBandButtons(hz);

  // 3. Set the demodulator mode (save=false — don't overwrite the user's default).
  if (mode && typeof window.setMode === 'function') window.setMode(mode, false);

  // 4. Push the new freq/mode to the URL.
  if (typeof window.updateURL === 'function') window.updateURL();

  // 5. APPLY the input — this is the call that actually retunes the receiver.
  if (typeof window.autoTune === 'function') window.autoTune();

  // 6. Re-centre the spectrum to follow, and suppress edge-detection for 2 s
  //    so it doesn't fight the pan (same as the bookmark dropdown).
  var spectrum = window.spectrumDisplay;
  if (spectrum && spectrum.connected && spectrum.ws) {
    spectrum.skipEdgeDetectionTemporary = true;
    setTimeout(function () { if (spectrum) spectrum.skipEdgeDetectionTemporary = false; }, 2000);
    try { spectrum.ws.send(JSON.stringify({ type: 'pan', frequency: hz })); } catch (e) { /* ignore */ }
  }
}
```

**Order matters:** input value → band buttons → mode → URL → `autoTune()` →
spectrum pan. `autoTune()` reads the value written in step 1, so step 1 must run
first; `setMode()` runs before `autoTune()` so the tune applies with the right
mode.

> **`window.setFrequency(hz)` vs this recipe.** `setFrequency` is the
> dial-wheel/edge-arrow handler — fine for stepping the current dial, but it is
> **not** how you jump to an arbitrary saved frequency. For favourites,
> bookmarks, spot clicks, and "tune to this" buttons, always use the 6-step
> recipe above.

> **`window.radio` path (extensions).** Some builds expose `window.radio`
> (a `RadioAPI`). If present, `window.radio.setFrequency(hz, centerSpectrum)`
> + `window.radio.setMode(mode, false)` is equivalent and may be preferred
> inside extension code. `cw_spots.widget.html` shows the `window.radio`-first
> pattern with a fallback to the globals above. For most widgets the global
> recipe is simpler and sufficient.

---

## Event bus

### Listening for callsign lookups

```js
window.addEventListener('callsign_lookup_complete', function (e) {
  var cs       = e.detail && e.detail.callsign;   // string
  var data     = e.detail && e.detail.data;        // QRZ data object
  var imageUrl = e.detail && e.detail.imageUrl;    // string|undefined
  if (!cs || !data) return;
  // render result...
});
```

### Observing frequency changes (instant, no polling lag)

```js
var freqInput = document.getElementById('frequency');
if (freqInput && 'MutationObserver' in window) {
  new MutationObserver(function () {
    var hz = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value, 10);
    if (!isNaN(hz)) onFrequencyChange(hz);
  }).observe(freqInput, {
    attributes: true,
    attributeFilter: ['data-hz-value', 'value']
  });
}
```

### Polling for slow-changing state

Use `setInterval` at 250–500 ms for things with no DOM hook (mode changes,
spot list updates, etc.):

```js
setInterval(function () {
  var mode = window.currentMode;
  // ...
}, 250);
```

### Waiting for a host service to become available

```js
(function waitForService() {
  var attempts = 0;
  var timer = setInterval(function () {
    attempts++;
    if (window.someService) {
      clearInterval(timer);
      init();
      return;
    }
    if (attempts >= 20) { clearInterval(timer); } // give up after ~10 s
  }, 500);
})();
```

---

## API calls

Widgets can call the server's REST API directly. Always include the session UUID.

```js
var uuid = window.userSessionID || '';
fetch('/api/lookup?callsign=' + encodeURIComponent(callsign) + '&uuid=' + encodeURIComponent(uuid))
  .then(function (r) {
    if (r.status === 429) throw new Error('Rate limited');
    if (r.status === 503) throw new Error('Service disabled');
    if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'HTTP ' + r.status); });
    return r.json();
  })
  .then(function (data) { /* render */ })
  .catch(function (err) { /* show error */ });
```

---

## HTML escaping helper (always use for user/server data)

```js
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
```

---

## Render-loop pattern (canvas widgets)

Cap to ~30 fps to limit CPU use. Skip drawing when the widget is hidden.

```js
var FRAME_INTERVAL = 1000 / 30;
var lastFrameTs = 0;
var rafId = null;
var dismissed = false;

function frame(ts) {
  rafId = requestAnimationFrame(frame);
  if (dismissed) return;
  if (ts - lastFrameTs < FRAME_INTERVAL) return;
  lastFrameTs = ts;

  var analyser = window.vuAnalyser || window.analyser;
  if (!analyser) return;

  // draw...
}

rafId = requestAnimationFrame(frame);
```

Cancel the loop on close:

```js
closeEl.addEventListener('click', function (e) {
  e.stopPropagation();
  dismissed = true;
  widget.style.display = 'none';
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
});
```

---

## Checking host service availability

Before showing interactive controls, check `window.instanceDescription`:

```js
(function waitForInstanceDescription() {
  var attempts = 0;
  var timer = setInterval(function () {
    attempts++;
    var desc = window.instanceDescription;
    if (desc) {
      clearInterval(timer);
      if (desc.some_service === true) {
        showWidget();
      } else {
        showServiceUnavailableMessage();
      }
      return;
    }
    if (attempts >= 20) {
      clearInterval(timer);
      showServiceUnavailableMessage();
    }
  }, 500);
})();
```

---

## Checklist before publishing

**Non-negotiable (widget will be rejected without these):**
- [ ] **✕ Close button** in the header — `dismissed` flag checked everywhere the widget could reappear
- [ ] **Collapse/expand arrow** left of the title — collapses to the title bar; state persisted to `<slug>_widget_collapsed` and restored on load; excluded from the drag-start guard
- [ ] **Mobile hiding** — `@media (max-width: 768px)` + `html.is-mobile` CSS + JS guard
- [ ] **Drag-to-reposition** — `mousedown`/`mousemove`/`mouseup` + `localStorage` persistence

**Structure & safety:**
- [ ] **Read a reference widget in `widgets/`** that's closest to this one and followed its patterns
- [ ] Saved in `widgets-custom/<slug>.widget.html` (NOT in the bundled `widgets/` directory)
- [ ] Unique CSS ID/class namespace — no collisions with host page or other widgets
- [ ] Opening HTML comment with name and description
- [ ] IIFE wrapper `(function () { 'use strict'; ... })();`
- [ ] `display:none` on the root element (shown programmatically)
- [ ] All user/server strings passed through `esc()` before `innerHTML`
- [ ] No `console.log` left in production code
- [ ] CSS specificity: scope all rules under the widget root ID to avoid leaking
- [ ] **Never calls `fetch('/api/description')`** — reads `window.instanceDescription` or `await window.descriptionPromise` instead

**Positioning:**
- [ ] Default `top`/`left` (or `top`/`right`) does not overlap existing widgets (see layout map)
- [ ] `localStorage` key is unique — not already used by another widget (see key table)
- [ ] Widget stays within viewport after drag (clamped to `window.innerWidth/Height`)

**Behaviour:**
- [ ] RAF/interval loops cancelled on close
- [ ] Tested at 768 px viewport width (should be hidden)
- [ ] Tested with no host services available (graceful degradation)
- [ ] `dismissed` flag prevents widget reappearing after close

---

## Installing the widget on your instance

Once the widget HTML is ready, add it to a running UberSDR instance through the
admin UI:

1. Log in to the admin panel at **`http://ubersdr.local:8080/admin.html`**
   (substitute your instance's host/port).
2. Open the **UI** tab.
3. Scroll down to the **Widgets** section.
4. Click the **My Widgets** tab.
5. Click **+ New Widget**.
6. Fill out a **Name** and a short **Description**, then paste the generated
   widget code into the **HTML content** field.
7. **Save** the widget, then **enable** it on your instance.
8. *(Optional)* Tick **Make public** to share the widget — public widgets are
   published to the collector and become available to other instances.

> The HTML content field expects the same fragment you'd save to
> `widgets-custom/<slug>.widget.html` — `<style>` + markup + `<script>`, with no
> `<!DOCTYPE>`/`<html>`/`<head>`/`<body>` wrapper.

---

## Submitting & editing widgets via the admin API

Everything the admin UI does is also available as a small REST API on the same
host, so you can create, update, enable, and version widgets from a shell
(e.g. the built-in gotty web terminal) without touching a browser. The
`html_content` field carries exactly the fragment you'd save to
`widgets-custom/<slug>.widget.html`.

> **Scope: this applies to *custom* and *cloned* widgets only** — widgets the
> instance **owns** and that appear in `GET /admin/widgets/mine`:
> - **Custom** — ones you authored here (`create`).
> - **Cloned** — a community widget you copied into your own instance; the clone
>   is a new widget you own, so it becomes editable.
>
> It does **not** cover the **built-in bundled widgets** (the reference
> implementations shipped in `widgets/`) or **community widgets authored by
> someone else** — you don't own those, they aren't in `mine`, and `update` will
> not touch them. To change one, create a new widget or clone it first.

### Authentication — `X-Admin-Password` header

Non-browser clients authenticate with an **`X-Admin-Password: <password>`**
request header (no session cookie, no login round-trip). The password is the
`admin.password` value from the instance config.

**First check the environment** — when launched via `widget-ai.sh` the password
and base URL are already exported, so prefer them and skip `sudo` entirely:

```bash
PW="${UBERSDR_ADMIN_PASSWORD:-}"          # set by widget-ai.sh
BASE="${BASE:-http://localhost:8080}"     # admin listener (server.listen port)
```

If `$UBERSDR_ADMIN_PASSWORD` is empty, fall back to the helper script, which
reads the password out of the running instance's `config.yaml` (inside the
Docker config volume) and prints an `Admin Password: <value>` line. It uses
`sudo` internally to read the protected volume, so the host must allow sudo:

```bash
# Installed location on a hub host (repo path: ./get-password.sh)
[ -n "$PW" ] || PW="$(~/ubersdr/get-password.sh | awk -F': ' '/^Admin Password:/{print $2}')"
```

The base URL is the admin listener (the `server.listen` port, `8080` by default
— the same host/port as `admin.html`).

> **Requests are IP-gated.** The admin endpoints also enforce
> `admin.allowed_ips`. Calls from the local host / gotty terminal are normally
> fine; a remote IP that isn't allow-listed gets `403 Forbidden` before the
> password is even checked.

> **Collector registration required.** Create/update/delete/versions proxy to
> the collector and need instance reporting enabled and registered. If it isn't,
> you'll get `400` with
> `{"error":"Widget features require instance reporting to be enabled and registered with the collector"}`.

### Endpoints

All paths are under `$BASE`. Send `Content-Type: application/json` and the
`X-Admin-Password` header on every call.

| Action | Method | Path | Body / query |
|---|---|---|---|
| List **my** widgets | `GET` | `/admin/widgets/mine` | — → `{"widgets":[{widget_id,name,description,is_public,version,…}]}` |
| List **public** widgets | `GET` | `/admin/widgets/public` | optional `?callsign=` / `?instance_id=` |
| **Create** | `POST` | `/admin/widgets/create` | `{name, description, html_content, is_public}` → `{widget_id,…}` |
| **Update** | `POST` | `/admin/widgets/update` | `{widget_id, name, description, html_content, is_public}` |
| **Delete** | `POST` | `/admin/widgets/delete` | `{widget_id}` |
| List **versions** | `GET` | `/admin/widgets/versions` | `?widget_id=<id>` → `{"versions":[…]}` |
| Get a **version's content** | `GET` | `/admin/widgets/version` | `?widget_id=<id>&version=<n>` |
| Get **enabled** list | `GET` | `/admin/widgets/enabled` | — → `{enabled:[…],count,max_allowed}` |
| Set **enabled** list | `POST` | `/admin/widgets/enabled` | `{"enabled":["id1","id2",…]}` (full replace, max 10) |

### Two independent things: *enabled* vs *public*

These are orthogonal — don't conflate them:

- **Enabled** controls whether the widget renders **on your own SDR page**. You
  toggle it with `/admin/widgets/enabled`. A **private** widget you own can be
  enabled on your instance perfectly well — **you do NOT need to make a widget
  public to use it yourself.**
- **Public** (`is_public: true`) publishes the widget to the collector's
  **community catalog** (the shared registry), where **other** instance owners
  can discover it in their admin **Community Widgets** list and enable (or clone)
  it. `is_public: false` keeps it owned by your instance only — it never appears
  in anyone else's catalog. Either way the widget is stored on the collector
  (that's what powers versioning); public only controls **discoverability by
  others**.

So the normal "just for me" flow is: **create (private) → enable**. Making it
public is an extra, optional step for sharing with the community.

> ⚠️ **Editing a public widget is a community-visible action.** Once a widget is
> public, every `update` you push becomes a new version that is **live to the
> whole community immediately**. For experimenting, keep it private (or clone)
> and only flip it public once you're happy.

### Create a new widget

```bash
PW="$(~/ubersdr/get-password.sh | awk -F': ' '/^Admin Password:/{print $2}')"
BASE="http://localhost:8080"

# html_content is the widget fragment; use --rawfile to load it from a file
WID="$(jq -n --rawfile html widgets-custom/my_thing.widget.html \
        '{name:"My Thing", description:"Does a thing", html_content:$html, is_public:false}' \
      | curl -s -X POST "$BASE/admin/widgets/create" \
          -H "X-Admin-Password: $PW" -H 'Content-Type: application/json' \
          --data-binary @- \
      | jq -r .widget_id)"
echo "Created $WID"
```

### Edit an existing widget ("edit my widget xyz")

When the user says *"edit my widget &lt;name&gt;"*, you must first **pull the
current live source down** — the `/admin/widgets/mine` list carries only metadata
(`widget_id`, `name`, `description`, `is_public`, `version`), **not**
`html_content`. The HTML lives in the widget's versions. The full round-trip is:

#### Resolving *which* widget they mean

The user will describe the widget loosely (*"my callsign lookup widget"*), not by
its exact stored `name`. Resolve it, don't guess:

- **Scope:** *"my widget"* = something in `GET /admin/widgets/mine` (a widget
  **this instance created**). It is **not** the bundled reference implementations
  in `widgets/` (those are read-only examples, not on the instance), and **not**
  a community widget authored by someone else (to change one of those you'd clone
  it first). If `mine` has nothing matching, say so — don't edit an unrelated
  widget or start from a `widgets/` reference and pretend it's theirs.
- **Match fuzzily:** compare the user's words as a **case-insensitive substring**
  against each entry's `name` **and** `description`, not by exact equality.
- **Disambiguate:** **exactly one** match → proceed. **Zero** → tell them and
  list what `mine` does contain. **Several** → show the candidates (name +
  description) and ask which one before touching anything.

1. **Resolve the request → `widget_id`** via `GET /admin/widgets/mine` (fuzzy
   match as above).
2. **Find the latest version** via `GET /admin/widgets/versions?widget_id=…`
   (the list is newest-first, so element `[0]` is current).
3. **Fetch that version's `html_content`** via
   `GET /admin/widgets/version?widget_id=…&version=…`.
4. **Edit the HTML** (locally, e.g. save it to `widgets-custom/<slug>.widget.html`
   so you can apply the normal widget conventions and re-read it).
5. **Push** with `POST /admin/widgets/update`, re-sending the **full** field set
   (`update` overwrites name/description/html/visibility together — omit a field
   and it's blanked). Each push creates a new version, so rollback is always
   possible.

```bash
PW="$(~/ubersdr/get-password.sh | awk -F': ' '/^Admin Password:/{print $2}')"
BASE="http://localhost:8080"
Q="callsign lookup"                   # the user's loose description

hdr=(-H "X-Admin-Password: $PW")

# 1. fuzzy-resolve the request → the matching widget's metadata.
#    Case-insensitive substring over name + description.
MINE=$(curl -s "${hdr[@]}" "$BASE/admin/widgets/mine")
MATCHES=$(jq -c --arg q "$Q" '
  [ .widgets[]
    | select(((.name + " " + (.description // "")) | ascii_downcase)
             | contains($q | ascii_downcase)) ]' <<<"$MINE")
N=$(jq 'length' <<<"$MATCHES")
if   [ "$N" -eq 0 ]; then
  echo "No widget of yours matches \"$Q\". You have:"; jq -r '.widgets[].name' <<<"$MINE"; exit 1
elif [ "$N" -gt 1 ]; then
  echo "Multiple matches — pick one:"; jq -r '.[] | "  - \(.name): \(.description // "")"' <<<"$MATCHES"; exit 1
fi
META=$(jq -c '.[0]' <<<"$MATCHES")
WID=$(jq -r .widget_id <<<"$META")

# 2 + 3. latest version → current html_content, saved to a local file
VER=$(curl -s "${hdr[@]}" "$BASE/admin/widgets/versions?widget_id=$WID" \
      | jq -r '.versions[0].version')
curl -s "${hdr[@]}" "$BASE/admin/widgets/version?widget_id=$WID&version=$VER" \
  | jq -r '.html_content' > widgets-custom/editing.widget.html

# 4. --- edit widgets-custom/editing.widget.html here ---

# 5. push the edited HTML back, preserving name/description/is_public
jq -n --arg id "$WID" \
      --arg name "$(jq -r .name <<<"$META")" \
      --arg desc "$(jq -r '.description // ""' <<<"$META")" \
      --argjson pub "$(jq -r '.is_public // false' <<<"$META")" \
      --rawfile html widgets-custom/editing.widget.html \
   '{widget_id:$id, name:$name, description:$desc, html_content:$html, is_public:$pub}' \
| curl -s -X POST "$BASE/admin/widgets/update" \
    "${hdr[@]}" -H 'Content-Type: application/json' --data-binary @-
```

If the widget is already enabled on the instance, the update refreshes its
cached copy automatically — reload the SDR page to see the change. If it's public,
re-read the community caveat below before pushing.

### Enable it on this instance

A widget must be **enabled** to appear on the SDR page. The enabled list is
**replaced wholesale** by `POST /admin/widgets/enabled` (max 10), so read the
current list, append your id, and post the union:

```bash
NEW=$(curl -s "$BASE/admin/widgets/enabled" -H "X-Admin-Password: $PW" \
      | jq -c --arg id "$WID" '[.enabled[].widget_id] + [$id] | unique')
curl -s -X POST "$BASE/admin/widgets/enabled" \
     -H "X-Admin-Password: $PW" -H 'Content-Type: application/json' \
     -d "{\"enabled\": $NEW}"
```

Reload the SDR page and the widget renders. Enabling a **private** widget you
own works exactly the same — no need to publish it first.

### Make it public — or private again

Publishing to the community catalog is just `is_public: true` on an `update`
(there's no separate endpoint). Send the **full** field set — `update` replaces
name/description/html/visibility together, so re-send `html_content` too, or you'll
blank it:

```bash
# Publish to the community catalog (discoverable + enable-able by other instances)
jq -n --arg id "$WID" --rawfile html widgets-custom/my_thing.widget.html \
   '{widget_id:$id, name:"My Thing", description:"Does a thing",
     html_content:$html, is_public:true}' \
| curl -s -X POST "$BASE/admin/widgets/update" \
    -H "X-Admin-Password: $PW" -H 'Content-Type: application/json' --data-binary @-
```

Flip `is_public` back to `false` the same way to **unpublish** — it disappears
from other instances' community list (instances that already enabled it keep
their cached copy until they refresh). To confirm what's currently public and
who's using it, `GET /admin/widgets/public-with-instances` returns each catalog
widget with an `enabled_by` array of instances.

Remember the caveat above: while a widget is public, **every** `update` is
immediately live to everyone who has it enabled. Iterate privately, publish when
ready.

To roll back a bad change, inspect `/admin/widgets/versions?widget_id=$WID`,
fetch an old version's `html_content` from `/admin/widgets/version?...`, and
`update` with it.

---

## Minimal widget template

Use this as a starting point for a new widget:

```html
<!--
  My Widget
  =========
  One-line description of what this widget does.
  Requires: <list any window globals or server services needed>.
  Drag to reposition; position saved in localStorage.
-->

<style>
  #myw-widget {
    position: fixed;
    top: 160px;
    left: 44px;
    z-index: 9500;
    pointer-events: auto;
    background: rgba(52, 73, 94, 0.55);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    color: #fff;
    border-radius: 6px;
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px;
    font-weight: bold;
    line-height: 1.4;
    white-space: nowrap;
    box-shadow: 0 2px 10px rgba(0,0,0,0.6);
    border-left: 3px solid rgba(255,255,255,0.3);
    cursor: grab;
    user-select: none;
    min-width: 160px;
  }

  #myw-widget.myw-dragging {
    cursor: grabbing;
    box-shadow: 0 4px 20px rgba(0,0,0,0.8);
  }

  #myw-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 8px 4px 9px;
    border-bottom: 1px solid rgba(255,255,255,0.15);
  }

  #myw-title {
    font-size: 10px;
    font-weight: bold;
    letter-spacing: 0.5px;
    color: rgba(255,255,255,0.85);
    text-transform: uppercase;
    margin-right: auto;   /* keeps the collapse arrow + title on the left */
  }

  #myw-collapse {
    width: 14px; height: 16px;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; line-height: 1;
    color: rgba(255,255,255,0.7);
    cursor: pointer;
    flex-shrink: 0;
    margin-right: 6px;
    transition: color 0.15s;
    user-select: none;
  }
  #myw-collapse:hover { color: #fff; }

  #myw-close {
    width: 16px; height: 16px;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; line-height: 1;
    color: rgba(255,255,255,0.7);
    cursor: pointer;
    border-radius: 3px;
    transition: color 0.15s, background 0.15s;
    flex-shrink: 0;
  }
  #myw-close:hover { color: #fff; background: rgba(0,0,0,0.3); }

  #myw-body {
    padding: 6px 9px 7px;
  }

  /* Collapsed: title bar only. */
  #myw-widget.myw-collapsed > :not(#myw-header) { display: none !important; }
  #myw-widget.myw-collapsed #myw-header { border-bottom: none; }

  @media (max-width: 768px) {
    #myw-widget { display: none !important; }
  }
  html.is-mobile #myw-widget { display: none !important; }
</style>

<div id="myw-widget" style="display:none;">
  <div id="myw-header">
    <span id="myw-collapse" title="Collapse">&#x25BE;</span>
    <span id="myw-title">My Widget</span>
    <span id="myw-close" title="Dismiss">&#x2715;</span>
  </div>
  <div id="myw-body">
    <!-- content here -->
  </div>
</div>

<script>
(function () {
  'use strict';

  if (window._isMobile || window.innerWidth <= 768) return;

  var LS_POS_KEY       = 'myw_widget_pos';
  var LS_COLLAPSED_KEY = 'myw_widget_collapsed';
  var DRAG_THRESHOLD   = 5;

  var widget     = document.getElementById('myw-widget');
  var collapseEl = document.getElementById('myw-collapse');
  var closeEl    = document.getElementById('myw-close');
  var dragState  = null;
  var wasDragged = false;
  var dismissed  = false;

  // ── Position restore ────────────────────────────────────────────────
  (function restorePosition() {
    try {
      var saved = localStorage.getItem(LS_POS_KEY);
      if (saved) {
        var pos = JSON.parse(saved);
        if (typeof pos.top === 'number' && typeof pos.left === 'number') {
          widget.style.top  = pos.top  + 'px';
          widget.style.left = pos.left + 'px';
        }
      }
    } catch (e) { /* ignore */ }
  })();

  // ── Drag ────────────────────────────────────────────────────────────
  widget.addEventListener('mousedown', function (e) {
    if (e.target === collapseEl || collapseEl.contains(e.target)) return;
    if (e.target === closeEl || closeEl.contains(e.target)) return;
    if (e.button !== 0) return;
    var rect = widget.getBoundingClientRect();
    dragState = { startX: e.clientX, startY: e.clientY,
                  origTop: rect.top, origLeft: rect.left };
    wasDragged = false;
    e.preventDefault();
  });

  document.addEventListener('mousemove', function (e) {
    if (!dragState) return;
    var dx = e.clientX - dragState.startX;
    var dy = e.clientY - dragState.startY;
    if (!wasDragged && Math.sqrt(dx*dx + dy*dy) > DRAG_THRESHOLD) {
      wasDragged = true;
      widget.classList.add('myw-dragging');
    }
    if (wasDragged) {
      var newTop  = Math.max(0, Math.min(dragState.origTop  + dy,
                                         window.innerHeight - widget.offsetHeight));
      var newLeft = Math.max(0, Math.min(dragState.origLeft + dx,
                                         window.innerWidth  - widget.offsetWidth));
      widget.style.top  = newTop  + 'px';
      widget.style.left = newLeft + 'px';
    }
  });

  document.addEventListener('mouseup', function () {
    if (!dragState) return;
    widget.classList.remove('myw-dragging');
    if (wasDragged) {
      try {
        localStorage.setItem(LS_POS_KEY, JSON.stringify({
          top:  parseInt(widget.style.top,  10),
          left: parseInt(widget.style.left, 10)
        }));
      } catch (e) { /* ignore */ }
    }
    dragState = null;
    setTimeout(function () { wasDragged = false; }, 0);
  });

  // ── Close ───────────────────────────────────────────────────────────
  closeEl.addEventListener('click', function (e) {
    e.stopPropagation();
    dismissed = true;
    widget.style.display = 'none';
  });

  // ── Collapse / expand (state persisted + restored) ──────────────────
  function setCollapsed(state, save) {
    widget.classList.toggle('myw-collapsed', state);
    collapseEl.innerHTML = state ? '&#x25B8;' : '&#x25BE;'; // ▸ collapsed, ▾ expanded
    collapseEl.title = state ? 'Expand' : 'Collapse';
    if (save) {
      try { localStorage.setItem(LS_COLLAPSED_KEY, state ? '1' : '0'); } catch (e) { /* ignore */ }
    }
  }
  (function restoreCollapsed() {
    var state = false;
    try { state = localStorage.getItem(LS_COLLAPSED_KEY) === '1'; } catch (e) { /* ignore */ }
    setCollapsed(state, false);
  })();
  collapseEl.addEventListener('click', function (e) {
    e.stopPropagation();
    setCollapsed(!widget.classList.contains('myw-collapsed'), true);
  });

  // ── Show widget ─────────────────────────────────────────────────────
  widget.style.display = '';

})();
</script>
```
