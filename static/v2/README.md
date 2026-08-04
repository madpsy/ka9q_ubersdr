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

Covers the wire formats and the pure logic where a mistake is silent rather than
loud: spectrum `SPEC` frames (float32 and uint8, full and delta), the v2 Opus
audio header, the audio-extension protocol, and the parts of a panel that sort,
filter or export — an attach with the wrong field name is answered with a
generic error, and a numeric column compared as text still looks sorted. Needs
only esbuild and node.

## Layout

```
index.html          shell; loads vendor React, /opus-decoder.min.js, dist/
vendor/             React 18 UMD (fetched, do not edit)
fonts/              Inter + JetBrains Mono, self-hosted — see fonts/README.md
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
  extensions/       decoders that open in their own window — see "Extensions"
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
An optional `requires: (serverInfo, env) => bool` keeps a panel out of all three
when it does not apply to the connected receiver — the Addons panel uses it, so a
server with no addons never shows an empty slot explaining that it has none. The
first argument is the `/api/description` reply, which is what nearly every gate
asks about; `env` carries the rest (`env.extensions` for the Extensions panel,
whose answer comes from a different endpoint). All three call sites go through
`usePanelApplies()` so they cannot disagree about whether a panel exists.
Saved layouts reconcile against the registry on load: unknown ids are dropped,
and a newly registered panel is inserted at the position the registry declares
for it — after the nearest sibling already in that dock, or before the nearest
one that follows. Appending instead would drop every new panel at the bottom of
an existing user's dock, so a panel declared "directly under Receiver" would
appear under everything else for anyone who had used the app before.

## Extensions

Extensions are the decoders and tools v1 ships in `static/extensions/`. They are
*not* panels: an extension opens in a window of its own, floats and only floats,
and closing it stops it. Exactly one is open at a time, because the server allows
one audio extension per session and tears the previous one down when a second
attaches — two windows would show one live decoder and one that had silently
stopped.

The Extensions panel (bottom dock) is the launcher, and it is **absent unless at
least one extension is both written for v2 and enabled on this receiver** — the
same rule the Addons, Spots and rotator panels follow, for the same reason: a
panel that can only say "nothing here" is worse than no panel. It lists what
this build can render, crossed with what the operator has enabled:

* **what v2 can render** — `src/extensions/registry.jsx`, a static list, because
  v2 extensions are React components compiled into the bundle rather than
  templates the server inlines and evals;
* **what the receiver has on** — `/api/extensions`, which reads `extensions.yaml`
  and answers `{ available: [{slug, displayName}], default }`.

Something we support but the operator has not enabled is listed and disabled with
the reason, rather than left out — the answer to "why is FT8 not here?" lives in
`extensions.yaml`, and a missing row cannot say that. What the receiver enables
and v2 has no component for is simply not shown: this is a launcher, not an
inventory of the v1 extension set.

### The shared decoder client

Every server-side decoder rides `/ws/dxcluster` and speaks the same four
messages, so that lives in one place:

```
extensions/protocol.js        attach/detach/control message shapes, result decoding
extensions/useAudioExtension.js   attach, read results, detach — the whole lifecycle
```

A panel says what it wants and gets a state back:

```jsx
const { state, error } = useAudioExtension({
    name: 'ft8', params: { max_candidates: 100 }, active: decoding && running,
    onResult: (msg) => …,
});
```

`active` is the only control. The hook holds the socket open (`dxcluster.hold()`
— a reference count with no stream subscription, since a decoder has nothing to
subscribe to), waits for it to be ready, re-attaches after a reconnect (the new
server-side session has no extension in it), and detaches on unmount so closing
a window really does stop the decoder. Results arrive as binary frames holding
UTF-8 JSON; a malformed one is dropped rather than thrown on.

The server adds the tuned frequency, mode, passband, receiver locator and CTY
database to the attach itself — none of those belong in `params`.

**Attaching needs a live *audio* session, and the identity of that session is the
socket's URL.** The server finds it by the UUID `/ws/dxcluster` was opened with,
so `active` should be "the audio connection is up" (`audioState === 'open'`), not
just "the receiver is on" — `running` flips before the audio socket connects.
Three things can still put the two out of step, and all three are handled rather
than surfaced as an error to clear by hand:

* the audio socket **reconnects**, replacing the session server-side — using the
  audio state as the gate re-attaches on its own;
* the attach lands in the gap — `no active audio session found` is the one
  refusal that is retried (`isTransientAttachError`), because it clears within a
  second or two; everything else is permanent and shown;
* the control socket **outlives the session id it carries**. Starting the
  receiver mints a new UUID, so a socket that survives a power cycle is
  registered to a session that no longer exists and *every* attach on it fails
  while everything looks connected. `dxcluster.stale` says so and
  `dxcluster.refresh()` reopens it; the ref counts survive, so the
  subscriptions come back with it.

### Adding an extension

Add one entry to `src/extensions/registry.jsx` with the slug the server uses:

```jsx
{ id: 'sstv', title: 'SSTV Decoder', icon: <Icon.Image />, summary: '…',
  requiresAudio: true, float: { w: 720, h: 560 }, Component: SSTVExtension }
```

Keep the pure parts (payload normalisation, filtering, sorting, export) in their
own module beside the component, as `ft8/messages.js` does — that is what the
tests exercise, and it is where a silent mistake actually lives.

## Behaviour notes

* **Audio requires a gesture.** The AudioContext is created inside the *Listen*
  click; browsers block it otherwise.
* **Spectrum uses `binary8`.** ~75% less bandwidth than float32, and the 1 dB
  quantisation is finer than a waterfall can show.
* **The waterfall scrolls on the compositor, not in JavaScript.** How often the
  receiver sends a frame depends on the span — a wide one arrives at half the
  rate of a narrow one — and a row that lands in a single frame at 5 Hz reads as
  a series of jerks. So the canvas is `RING_PAD` device px taller than the box
  that clips it: a committed row is painted above the top edge and a `translateY`
  animation slides it down over the gap until the next one is due
  (`smoothInterval` predicts that from the last few). Nothing about this costs
  per-frame work — the canvas is still painted exactly once per row, and the
  slide is a composited transform, so the browser moves a texture it already has
  without calling back into the app. Two consequences: the tuning marks live on
  a second, *un*translated canvas (a marker that slid would stop pointing at its
  frequency — and it now redraws only when it moves, which it did not before),
  and the picture is resampled while in flight, which is very slightly soft on a
  non-HiDPI screen. That last one is why *Smooth scrolling* is a switch in the
  Display panel rather than unconditional. Resizing the pane vertically keeps
  the history; only a width change discards it, since every ring column is a
  frequency. See `lib/waterfallRing.js`.
* **Smoothing is per second, not per frame.** The spectrum's own rate depends on
  the span — a wide one arrives about half as often — so a factor applied once
  per redraw would silently change meaning as you zoom: the same trace-smoothing
  setting lagged several times longer, and the auto-levels took several times as
  long to settle. `lib/timeConstant.js` raises the factor to the power of
  elapsed-time-over-reference, which makes applying it twice over half an
  interval identical to applying it once over the whole. The reference is 20 Hz,
  so existing settings keep the behaviour they had on a narrow span and only the
  slower ones change. Peak hold was already time-based (dB per *second*) and is
  the model the other two now follow. Note that this cannot make the trace
  *move* more smoothly — a shape can only be smoothed by drawing it more often,
  unlike the waterfall's scroll, which is rigid motion and so composites for
  free.
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
* **`/ws/dxcluster` is one shared, reference-counted socket.** Despite the name
  it is a multiplexer: DX spots, digital-mode spots, CW skimmer spots and chat,
  each opted into separately, plus the audio-extension decoders' control
  messages and their binary results. So `radio/dxcluster-connection.js` is a
  singleton with a ref count per stream: consumers call `acquire(stream)` and
  get a release function, the socket opens on the first acquire and closes on
  the last release. A decoder has nothing to subscribe to, so it calls `hold()`
  instead — the same reference count without a `subscribe_*` — which is what
  stops an extension being cut off when the last spot panel closes, or keeping
  the socket alive after it detaches. Ref counting is not tidiness — a plain unsubscribe would let
  the first panel to close cut off every other consumer of that stream, and a
  socket per panel would mean three connections each carrying the whole
  channel's chat traffic. Demand is the *only* thing that opens it; there is
  deliberately no separate connect for a caller to get out of step with.
* **Spots are one panel with a tab per feed the instance actually has.** v1
  ships DX, digital and CW spots as three extensions the operator enables by
  hand, only one of which can be open at a time. Here `/api/description` decides:
  `dx_cluster`, `digital_decodes` and `cw_skimmer` each add a tab, and the panel
  is absent entirely when none apply. `dx_cluster` was added to that endpoint for
  this — `dxcluster.enabled` gates only the *upstream* cluster connection, while
  `POST /api/dxcluster/inject` feeds the identical pipeline and is what the
  `dxcluster` addon uses, so the flag is true for either. Only the visible tab is
  subscribed: every subscribe replays that stream's server-side buffer, so
  switching tabs restores the history rather than losing it, and nobody carries a
  busy digital feed for a tab they are not reading. Columns, filters and their
  defaults are v1's, and so are the tuning rules in `lib/spots.js` — CW and voice
  cross sidebands at 10 MHz, digital is always USB, and a DX spot (which carries
  no mode) takes FT8/FT4 or CW from the spotter's comment before falling back to
  the band. **Digital rows do not tune**, and are plain rows rather than
  buttons: every station in a decoder band transmits on the same dial frequency
  and only the audio offset differs, so the frequency on the row is where the
  station sat in the passband, not somewhere to point the receiver — clicking it
  would leave you listening to one corner of an FT8 slot. Same reason digital
  spots get no spectrum markers. Frequencies are Hz in every feed; the server
  converts the cluster's kHz on the way in. Spots are keyed by feed, callsign,
  frequency and timestamp so a replayed buffer does not duplicate rows already on
  screen. Column tracks are declared once on the *list*, not per row: a grid per
  row sizes its tracks from its own content, so no two rows agree on where a
  column starts — which v1 gets for free by using a real `<table>`. The panel is
  the scroller, not the list: scrolling only inside the list pinned the filters
  to the top forever, and on a short dock they took most of the height with no
  way to push them aside. The column heading strip is `sticky`, so it stays put
  as the filters scroll away above it.
* **DX and CW spots also appear as markers; digital spots do not.** Green for DX
  and cyan for CW, v1's colours, with a switch each in the Display panel beside
  the other marker toggles — and each switch present only where that feed is.
  Digital spots are left out on purpose: a decoder band puts every station on one
  frequency, so a marker per spot would be a stack of pills on a single pixel
  rather than somewhere to tune. The DX and CW streams are held open for the
  whole session by `SpotStreams` in `App.jsx` rather than by whichever panel
  happens to be showing — both are low-rate, and subscribing once means a marker
  toggle decides only what is *drawn*, so turning one on shows the spots already
  collected instead of an empty bar until the next spot arrives. Digital is the
  exception and is subscribed only while its tab is on screen. Markers are laid
  out last, seeded with where the bookmarks and voice detections landed, so a
  spot never covers one; they use a fixed age window (v1's default filter values,
  30 min DX / 10 min CW) rather than following the panel's live filter, since the
  markers are on when the panel may well be closed. One marker per 100 Hz bucket,
  newest wins — the skimmer re-spots the same station every few minutes and those
  would otherwise pile up on one pixel.
* **Chat is one stream on that socket.** Nothing chat-related is accepted until
  `subscribe_chat` has been sent — the server answers "you must subscribe to
  chat first" otherwise.
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
* **Hardware control is native, not a hosted extension.** v1 ships FlexControl,
  MIDI Control and Radio Sync as three separate extensions; the first two are
  near-identical 900-line files that each carry their own copy of the mapping
  engine and discover control ranges by reading v1's sliders out of the DOM
  (`document.getElementById('bandwidth-low').min`). Here they are the SDR
  control panel, with one function catalogue in `controls/functions.js`, and
  everything goes through
  `actions`, so a mapped control takes the same path as a click. Hardware is
  normalised to three event kinds — `relative` (encoder detents), `absolute`
  (a fader's position, 0..1) and `trigger` (a button) — and each function
  declares which it accepts, because a fader read as an encoder slews the
  receiver across the band rather than setting a level. A MIDI CC cannot be told
  apart from one message, so the mapping carries an encoder/fader switch instead
  of guessing. Mapping records and the export envelope are v1's byte for byte,
  and v1's `localStorage` mappings are adopted on first run. `nb_toggle` and
  `vfo_ab_toggle` have no v2 equivalent and are listed in `RETIRED` so an
  imported file shows them struck through rather than dropping them silently;
  `mode_cw` aliases to `mode_cwu` since v2 splits the sidebands. Noise reduction
  entries are generated from the server's DSP schema — nothing hardcodes nr2.
* **Two panels: mapped surfaces, and CAT.** SDR control holds FlexControl and
  MIDI — a control moves, a mapped function runs — and Radio control holds Radio
  Sync, where nothing is mapped and the rig and the receiver simply follow each
  other. They are independent: a knob box and a synced rig are two ways of
  moving the same dial, not a conflict. Only the two mapped surfaces exclude
  each other, since both mapped to frequency would fight, so choosing one
  releases the other (`controls/sources.js`). Both panels read and write one
  settings blob through the small store in `controls/mappings.js` — with a copy
  each, whichever saved last would write back a stale version of the other's
  half — and share the radio facade and the message log via `controls/panel.jsx`.
* **A source outlives its panel.** The sources are module singletons rather than
  component state for a reason specific to this UI: a panel unmounts every time
  it is dragged to another dock, floated or opened on mobile, and that must not
  close a serial port, drop a CAT link, or throw away Hamlib. Hardware is
  released on a surface change or an explicit Disconnect, never on unmount.
* **Hamlib is fetched only when the Radio control panel is opened.** `hamlib.wasm` is 14 MB,
  so `ensureLoaded()` is the one place it is pulled, it caches its promise on the
  singleton, and it deliberately does *not* cache a rejection — a transient
  failure on a 14 MB download must not leave the panel dead until a reload. The
  module is built with plain `-sASYNCIFY`, which permits one in-flight call, so
  every `cwrap` goes through a serialising queue: the 10 Hz poll loop overlapping
  a `set_freq` on a slow serial link corrupts Asyncify's stack and Hamlib's
  shared buffers, which surfaces as PTT flipping at random. A rig sitting in a
  data mode (PKTUSB, RTTY) is displayed but pushed in neither direction — the
  receiver has no equivalent, and recording it would make the next comparison
  drag the rig back out of data mode.
* **Deep links**: `/v2/?freq=7100000&mode=lsb`.
