---
name: create-widget
description: Create a widget for the UberSDR web SDR interface — a self-contained HTML fragment (style + markup + script) injected into the host page, NOT a full HTML document. Use this whenever building, adding, or editing an UberSDR widget in widgets/*.widget.html.
---

# Skill: Create a UberSDR Widget

> **A widget is an HTML *fragment*, not a full HTML document.**
> Do **NOT** include `<!DOCTYPE>`, `<html>`, `<head>`, `<body>`, `<meta>`, or
> `<title>` tags. A widget consists only of a `<style>` block, the widget markup,
> and a `<script>` block — these are injected verbatim into the host page, which
> already provides the full document shell.

> **Three things every widget MUST have, no exceptions:**
> 1. A **visible ✕ close button** in the header — users must always be able to dismiss a widget
> 2. **Mobile hiding** — CSS `@media` + `html.is-mobile` + JS guard
> 3. **Drag-to-reposition** with `localStorage` persistence

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

## File naming & location

| Convention | Example |
|---|---|
| Filename | `<slug>.widget.html` |
| Canonical location | `widgets/<slug>.widget.html` |
| CSS ID prefix | `#<slug>-widget` (all IDs must be unique across the whole page) |

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
| `window._callsignLookupCache` | `Map` | Callsign lookup cache: `Map<string, {data, imageUrl}>` |
| `window.cwSpotsExtensionInstance` | `object` | CW spots extension: `.spots[]` |
| `window.dxClusterExtensionInstance` | `object` | DX cluster extension: `.spots[]` |
| `window.dxClusterClient` | `object` | DX cluster WebSocket client |
| `window.markerNavTypes` | `string[]|null` | Host marker type filter preference |

### Functions (call with existence check)

| Function | Signature | Description |
|---|---|---|
| `window.setFrequency` | `(hz: number)` | Tune to frequency |
| `window.setMode` | `(mode: string, save: boolean)` | Change demodulator mode |
| `window.setFrequencyInputValue` | `(hz: number)` | Update frequency input without tuning |
| `window.autoTune` | `()` | Apply current frequency input |
| `window.updateBandButtons` | `(hz: number)` | Sync band button highlights |
| `window.updateURL` | `()` | Push current state to URL |
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
| `window._fetchCallsignForMediaSession` | `(cs: string) → Promise` | Fetch + cache callsign data |
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
- [ ] **Mobile hiding** — `@media (max-width: 768px)` + `html.is-mobile` CSS + JS guard
- [ ] **Drag-to-reposition** — `mousedown`/`mousemove`/`mouseup` + `localStorage` persistence

**Structure & safety:**
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
  }

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

  @media (max-width: 768px) {
    #myw-widget { display: none !important; }
  }
  html.is-mobile #myw-widget { display: none !important; }
</style>

<div id="myw-widget" style="display:none;">
  <div id="myw-header">
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

  var LS_POS_KEY     = 'myw_widget_pos';
  var DRAG_THRESHOLD = 5;

  var widget   = document.getElementById('myw-widget');
  var closeEl  = document.getElementById('myw-close');
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

  // ── Show widget ─────────────────────────────────────────────────────
  widget.style.display = '';

})();
</script>
```
