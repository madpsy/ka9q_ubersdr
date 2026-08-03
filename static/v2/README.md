# UberSDR v2 frontend

A React rewrite of the receiver UI, served at **`/v2/`**. It runs alongside the
existing frontend at `/` — nothing here touches v1, and no Go changes were
needed: `static/` is served by `http.FileServer`, so `static/v2/index.html`
answers `/v2/` on its own.

## Build

```sh
./build.sh          # production bundle → dist/v2.js + dist/v2.css
./build.sh --dev    # unminified, inline sourcemap
./build.sh --watch  # rebuild on change
```

The repo's top-level `build-js.sh` calls this at the end, so the normal build
covers v2 too.

`dist/` is generated and git-ignored — run a build after cloning.

### Why no npm

`build.sh` needs **only esbuild**, the same tool the rest of the repo uses.
React comes from `vendor/` as UMD globals rather than `node_modules`, and
`src/react.js` is the single file that touches those globals — swapping to a
bundled React later is a one-file change. See `vendor/README.md`.

## Test

```sh
./test/run.sh
```

Covers the two binary wire formats, where an off-by-one produces plausible
garbage rather than an error: spectrum `SPEC` frames (float32 and uint8, full
and delta) and the v2 Opus audio header. Needs only esbuild and node.

## Layout

```
index.html          shell; loads vendor React, /opus-decoder.min.js, dist/
vendor/             React 18 UMD (fetched, do not edit)
src/
  react.js          the only file that reads window.React
  App.jsx           providers + desktop/mobile shell selection
  radio/            protocol and audio — no React
    session.js          UUID + POST /connection handshake
    audio-connection.js /ws client, Opus binary frames
    spectrum-connection.js /ws/user-spectrum client, SPEC frames + gzip JSON
    audio-player.js     Opus decode and jitter-buffered playback
    constants.js        modes, passband defaults, limits
    RadioContext.jsx    the one place that owns the radio
  display/          spectrum/waterfall appearance settings
  layout/           dock layout state and persistence
  components/       chrome: docks, sections, top bar, spectrum canvas
  panels/           panel bodies + registry.jsx
  lib/              formatting, palettes, throttle, media query
```

### Update rates are kept apart

Three different clocks run through this UI, and mixing them would make it
stutter:

* **Control state** (frequency, mode, filters) lives in React state — it
  changes when a human does something.
* **Meters** (signal power, SNR, buffer depth) live on a mutable object that
  components sample through `useMeters(hz)`, so 50 audio packets a second never
  become 50 renders a second.
* **Spectrum frames** never reach React at all. `SpectrumView` subscribes to the
  connection directly and paints the canvas.

### Floating panels

A panel's placement is one of four values — `left`, `right`, `bottom` or
`float` — so floating needed no change to the panels themselves: the same
component renders in a dock section, a mobile sheet, or a draggable window.
`movePanel(id, 'float')` detaches it; the × on the title bar (or a double-click)
returns it to its registry `dock`. Position and size persist per panel, windows
cascade so a second float does not land on the first, and clicking one raises it.

Floating is desktop-only — `MobileShell` ignores it and shows every panel in its
sheet list, since a draggable window on a phone is not useful.

### Resizing

Three levels, deliberately not four:

* **Dock size** — drag a dock's edge (all three docks).
* **Panels within the bottom dock** — drag the splitter between two neighbours
  to trade width, or a panel's own corner grip to set width *and* height at
  once. Width is always a trade with one neighbour, so the row's total never
  changes and the other panels do not shift. Height is the panel's own: the
  bottom dock lays panels out from the top, so each may be a different height
  and the dock scrolls if one is taller than it. Both snap to an 8 px grid —
  fine enough to feel free-form, coarse enough that neighbours line up.
  Double-click a splitter to even a pair out, or a grip to return that panel to
  automatic height.
* **Floating windows** — free position and size.

Side docks are deliberately *not* per-panel resizable. Panels there size to
their content and the dock scrolls; giving a panel a fixed height would
reintroduce the inner scrollers that "one scroller per dock" exists to avoid.
A general resizable grid was skipped for the same reason plus overlap: floating
already covers freeform arrangement, at a fraction of a tiling manager's
complexity.

### One scroller per dock

Panels never scroll internally — no `overflow` and no `max-height` on a panel
body, list or log. The dock is the only scroller, so a long band list makes the
dock scroll rather than trapping a small scroll area inside a section. The
bottom dock scrolls on both axes and sizes its sections to content rather than
stretching them. The one exception is the mobile sheet, which is a fixed-height
overlay and so has to scroll itself — but that is the container, not the panel.

Two consequences worth knowing when writing a panel:

* **A `fill` panel is the exception.** Chat and the event log are unbounded
  streams: in the bottom dock they stretch to the dock's height and scroll their
  own body. Without that they grow with every message and drag the dock with
  them. Same justification as the mobile sheet — a fixed-height container, where
  scrollback is the entire point. Everything else still follows the rule below.
* **Do not let a section shrink.** `.section` sets `flex: none` because the dock
  body is a flex column: without it, sections compress below their content once
  the dock overflows and clip each other instead of the dock scrolling.
* **You cannot scroll your own content into view** — that would drag the whole
  dock. The event log puts newest entries first for this reason rather than
  auto-scrolling to the bottom.

Long lists render a page at a time (`ShowMore` in `components/ui.jsx`) rather
than everything: this server publishes 202 bands and 2450 bookmarks, which would
otherwise make the dock scroll for thousands of pixels.

### Adding a panel

Add one entry to `src/panels/registry.jsx`:

```jsx
{ id: 'myPanel', title: 'My panel', icon: <Icon.Waves />, dock: 'left', Component: MyPanel }
```

It then appears in its dock, in the layout manager, and in the mobile tab bar.
An optional `requires: (serverInfo) => bool` keeps a panel out of all three when
it does not apply to the connected receiver — the Addons panel uses it, so a
server with no addons never shows an empty slot explaining that it has none.
Saved layouts reconcile against the registry on load: unknown ids are dropped
and newly registered panels are appended to their declared dock, so shipping a
panel never disturbs an existing user's arrangement.

## Behaviour notes

* **Audio requires a gesture.** The AudioContext is created inside the *Listen*
  click; browsers block it otherwise.
* **Spectrum uses `binary8`.** ~75% less bandwidth than float32, and the 1 dB
  quantisation is finer than a waterfall can show.
* **Noise reduction is entirely schema-driven.** `get_dsp_filters` returns each
  enabled filter and its parameters (`name, type, default, min, max,
  description, runtime_safe`), and `lib/dsp.js` turns a descriptor into a
  control — bool → switch, int enumerated in its description → labelled choices,
  anything with a range → slider, otherwise text. Nothing about nr2/rn2/nr4/dfnr
  is hardcoded, so a filter added to the DSP container appears on its own.
  Parameters travel as strings both ways. `runtime_safe: false` params are hidden
  (the server rejects mid-stream changes to them), `set_dsp_params` is only valid
  while the insert runs, and the server's `dsp_status` echo is authoritative.
* **AGC is USB/LSB only, and the server owns the values.** `agc_state` (from
  `get_agc`, and included in every `status`) returns the operator's `config.yaml`
  `ssb_agc` defaults for anything the session has not overridden — so the client
  must *read* them, never seed sliders from its own constants. `set_agc` pins a
  per-session override that cannot be cleared, which is why the panel stays
  disabled until the server answers, why AGC is not persisted to localStorage
  (a new session starts from the operator defaults again), and why "Defaults"
  replays the first server-reported values rather than 1.1 / 20 / −15. There is
  no enable switch: the server accepts `agcEnable` but never reports it back, so
  a toggle would show a state nothing else agrees with.
* **Chat rides on `/ws/dxcluster`, not its own endpoint.** That socket
  multiplexes DX / digital / CW spot streams and chat, each opted into
  separately, and nothing chat-related is accepted until `subscribe_chat` has
  been sent — the server answers "you must subscribe to chat first" otherwise.
  That subscription is also what replays the recent-message buffer, and the
  server's `subscription_status` reply is what everything else waits on:
  sending immediately after `subscribe_chat` races the server registering it.
  A username (1–15 chars, alphanumeric plus `- _ /`, not at the ends) is needed
  to send but not to read, and is re-sent on reconnect along with the published
  frequency/mode — otherwise a dropped socket silently demotes the user to an
  anonymous listener. A remembered name auto-joins once the subscription is
  confirmed, and a `username not set` error triggers a re-join (bounded, so a
  name the server will never accept cannot loop). Leaving forgets the name, or
  the next connection would silently rejoin whoever just chose to leave. The socket is opened only while the receiver is running
  *and* the chat panel is visible.
* **A new session UUID per session start.** Minted when the user starts
  listening, not persisted, and shared by both sockets — the server pairs audio
  and spectrum by UUID. It then stays fixed for that session, including across
  automatic reconnects, because the server keys real behaviour on it: it detects
  a reconnect and *replaces* the old session rather than stacking a second one,
  counts `max_sessions` by unique live UUID, limits unique UUIDs per IP, and
  rate-limits session creation per UUID to damp reconnect loops. Minting a new
  one mid-session would defeat all of that. Per-IP and per-session limits count
  live sessions only and are cleaned up on destroy, so a fresh UUID per start
  costs nothing.
* **Squelch is the audio gate, not `set_squelch`.** v1 ships with
  `FM_SQUELCH_ENABLED = false` and only ever sends `squelchOpen: -999`, so
  radiod's squelch is never engaged; the control users actually have is
  `set_audio_gate` with `min_snr`. The slider runs 24–80 dB SNR with the floor
  doubling as "off" (sends `-999`), matching v1. The gate substitutes silence
  rather than dropping packets, and signal-quality packets keep flowing, so SNR
  stays live on screen while muted. The open/closed badge mirrors the server's
  500 ms hang timer — without it the badge flickers closed between syllables.
  A new session starts with the gate disabled, so it is re-applied on every
  socket open, including reconnects.
* **Zoom steps must halve or double `binBandwidth`.** The server snaps
  `binBandwidth` onto a fixed ladder (0.5, 1, 2, 5, 10, 20, 50 … 5000 Hz/bin,
  then pass-through) before applying it. Any gentler step rounds back to the
  rung it started from, so the view silently stops changing — a 1.25× step
  strands you at 5000 Hz/bin in both directions. Zooming out past the full-span
  value sends `reset` rather than a `zoom`, which also returns the session to
  the shared radiod channel. The zoom-in floor is a *span* (10240 Hz), matching
  v1, so depth does not vary with `spectrum.bin_count`.
* **FFT bins must be unwrapped.** radiod emits raw FFT order,
  `[DC..+Nyquist, -Nyquist..DC]`; the two halves are swapped in
  `spectrum-connection.js` to get ascending frequency. Skipping this shifts the
  whole display by half a span, so the spectrum silently disagrees with the
  audio. Delta frames index the *raw* order, so the delta accumulators stay raw
  and the swap happens on the way out. v1 does the same thing in
  `spectrum-display.js`, in the shared `case 'spectrum'` both its JSON and
  binary paths funnel into.
* **Operator settings come from `/api/ui-config`.** `display/uiConfig.js` keeps
  the reply verbatim under `display.server.config`, so every key the operator
  sets stays reachable — palette, contrast, theme colours, meter styles, station
  ID overlay and the rest — even though only the spectrum backdrop is consumed
  so far. Values that drive rendering are also parsed and validated onto the top
  level so the draw path never re-parses a string. None of it is persisted
  locally: the server owns it and the admin page can change it at any time.
* **The spectrum backdrop is split-view only.** `spectrum_bg_image` is drawn
  behind the trace at `spectrum_bg_opacity`, stretched to the spectrum pane,
  with the same cache-busting query v1 uses so a freshly uploaded image is
  picked up. It is not even fetched outside split view — the image can be
  several hundred kilobytes and there is no point pulling it for someone who
  only looks at the waterfall. While a backdrop is showing, the dB grid and its
  labels switch to solid white with a dark text shadow: the usual 6%-white
  gridlines read fine on black but vanish on most images.
* **The marker bar is built for thousands of entries.** This server publishes
  202 band allocations and 2450 bookmarks, so at full span everything is
  "visible". `lib/markers.js` therefore: binary-searches the sorted bookmark list
  for the visible window rather than scanning it; caps the draw list at 100,
  sampled evenly across the x axis so survivors stay spread over the full width
  instead of bunching at one end; then stacks onto two rows and **drops whatever
  fits neither**. That last part is the one place this deliberately departs from
  v1, which keeps a colliding marker and draws it on row 0 anyway — its cap
  bounds how many markers are drawn but nothing bounds how many are drawn on top
  of each other, so at wide spans the bar becomes an illegible pile. Dropping is
  stable: placement is greedy left-to-right over an x-sorted list, so panning
  slides markers rather than reshuffling which ones survive. Row assignment only
  compares against the last marker placed in each row (the list is x-sorted), so
  it is O(n) rather than v1's O(n²). Label widths are measured once per name. The bar redraws on
  view/data/toggle changes only, never per spectrum frame. Bands are drawn
  widest-first so narrow allocations land on top, and their labels repeat at a
  spacing derived from the label width — laid out across the range the label
  *centres* can occupy, which is where v1 goes wrong: it spreads them over the
  whole band then clamps strays back inside, squeezing the end pair together so
  long names overlap anyway.
* **Peak hold decays in dB per second, not per frame.** The draw rate follows
  the server's frame rate, so a per-frame decay made the hold time depend on how
  fast the spectrum happened to be arriving — slow on a busy server, fast on an
  idle one. `peakDecay` is dB/s and 0 holds indefinitely. The peak line is drawn
  *above* the trace fill; underneath it the fill washed it out.
* **One colour mapping for both panes.** The Display panel's View control picks
  split / spectrum-only / waterfall-only. The palette drives both: the spectrum's
  trace and fill are painted with a vertical gradient built from the same LUT and
  the same `contrast` gamma the waterfall uses, so a given amplitude is the same
  colour in either pane. The trace uses a compressed slice of the palette
  (0.35–1.0) because most palettes start at near-black, which would make weak
  signals invisible against the dark background; the fill uses the full range
  with an alpha ramp. Controls that affect only one pane are hidden when that
  pane is off.
* **The waterfall is a ring buffer.** Rows are written into an offscreen canvas
  at a decrementing index and the visible canvas is painted from two slices —
  O(row) per frame, and unlike blitting the canvas onto itself it never
  accumulates resampling artefacts.
* **IQ modes are absent.** The server switches them to a lossless pcm-zstd
  stream, which would pull a zstd decoder into the bundle for a mode intended
  to feed external tools rather than browser speakers.
* **State persists in `localStorage`** under `ubersdr.v2.*` (tuning, display,
  layout). The session UUID is in `sessionStorage`, so each tab is its own
  receiver session.
* **Deep links**: `/v2/?freq=7100000&mode=lsb`.
