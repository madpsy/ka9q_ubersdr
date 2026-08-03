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

### Adding a panel

Add one entry to `src/panels/registry.jsx`:

```jsx
{ id: 'myPanel', title: 'My panel', icon: <Icon.Waves />, dock: 'left', Component: MyPanel }
```

It then appears in its dock, in the layout manager, and in the mobile tab bar.
Saved layouts reconcile against the registry on load: unknown ids are dropped
and newly registered panels are appended to their declared dock, so shipping a
panel never disturbs an existing user's arrangement.

## Behaviour notes

* **Audio requires a gesture.** The AudioContext is created inside the *Listen*
  click; browsers block it otherwise.
* **Spectrum uses `binary8`.** ~75% less bandwidth than float32, and the 1 dB
  quantisation is finer than a waterfall can show.
* **FFT bins must be unwrapped.** radiod emits raw FFT order,
  `[DC..+Nyquist, -Nyquist..DC]`; the two halves are swapped in
  `spectrum-connection.js` to get ascending frequency. Skipping this shifts the
  whole display by half a span, so the spectrum silently disagrees with the
  audio. Delta frames index the *raw* order, so the delta accumulators stay raw
  and the swap happens on the way out. v1 does the same thing in
  `spectrum-display.js`, in the shared `case 'spectrum'` both its JSON and
  binary paths funnel into.
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
