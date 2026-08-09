# UberSDR desktop client

The v2 web UI in an Electron shell, with a chooser that connects to any
UberSDR instance: receivers discovered on the LAN, receivers from the public
directory, or manually entered addresses.

```sh
./build.sh    # builds static/v2, stages it, installs electron
npm start
```

## How it shares the main codebase

The v2 frontend is same-origin by construction — relative `fetch()` calls,
websocket URLs built from `location.host`, root-absolute assets served by the
instance. This client does not fork or patch any of it. Instead:

- `build.sh` runs the stock `static/v2/build.sh` and stages its artifacts
  (`index.html`, `dist/`, `fonts/`, `vendor/`) into `ui/v2/`, untouched.
- Each connected instance gets a reverse proxy on `127.0.0.1:<port>`
  (`proxy.js`) that serves those staged files for `/v2/*` and forwards
  everything else — `/api/*`, the audio/spectrum/dxcluster websockets, the SSE
  streams, shared root assets like `/opus-decoder.min.js` and the worklets,
  and the v1 pages the legacy popups open — to the instance, websocket
  upgrades included.

The receiver window loads `http://127.0.0.1:<port>/v2/` and the unmodified
bundle runs believing it is same-origin with the receiver. Because each
instance's local port is stable (stored with it), each receiver keeps its own
localStorage settings, exactly as if you had visited it in a browser.

### Built-in UI vs the instance's UI

Per saved receiver the chooser offers two modes:

- **built-in UI** (default): the bundle staged by `build.sh`. Consistent
  version everywhere, loads from disk.
- **instance's UI**: `/v2/*` is proxied like everything else, so you get
  exactly the frontend that instance serves — the right choice when the app's
  bundle and an instance's server have drifted apart, since the UI and its
  server evolve in lockstep in this repo.

Switching modes takes effect immediately (the window reloads).

### Shared settings

Because each instance's local port is its own origin, every receiver keeps its
own v2 settings — theme, layout, panels, shortcuts — in its own localStorage.
That is the default. The chooser's **"Share settings between receivers"**
toggle bridges them for whoever wants every receiver to look the same: with it
on, a snapshot of the `ubersdr.v2.*` keys is kept in userData
(`shared-prefs.json`), each receiver window is seeded from it before the page
boots (`receiver-preload.js`, which exposes nothing to the page), and changes
made in any window are written back to it. Turning sharing on makes the most
recently opened receiver the template; windows already open pick up later
changes when reloaded. Turning it off simply stops the bridging — every
receiver is independent again with whatever settings it had last.

## Discovery

Same three sources as the other clients (`clients/tui`,
`clients/ubersdr-audio`):

- **LAN**: mDNS browse for `_ubersdr._tcp.local` (see
  `install-ubersdr-mdns.sh`), IPv4 only, implemented dependency-free in
  `mdns.js` using a legacy-unicast query — no multicast group membership, no
  conflict with Avahi/Bonjour. Hits are verified via `/api/description`.
- **Directory**: `https://instances.ubersdr.org/api/instances`, sorted like
  the TUI picker — receivers with free slots first, then by SNR.
- **Manual**: a full URL, `host:port`, or bare host (tries https:443,
  http:80, http:8080). A self-signed certificate is refused by default and
  can be trusted per-receiver with an explicit click.

## Desktop integration

- **Web Serial** (FlexControl): Electron has no built-in port picker, so the
  main process answers `select-serial-port` with a native dialog.
- **Popups**: the legacy v1 windows (callsign lookup, map, CW graph) open as
  child windows; external links open in the system browser.
- **Media keys** work through the UI's existing `mediaSession` support;
  autoplay restrictions are disabled so reconnects never come up muted.
- The service worker is deliberately not served (`/sw.js` → 404): it exists
  to make the browser PWA installable, which a desktop app doesn't need.

## Files

```
main.js       app lifecycle, windows, IPC, serial/permission handlers
proxy.js      per-instance localhost reverse proxy (HTTP + websocket upgrade)
mdns.js       dependency-free mDNS-SD browser for _ubersdr._tcp
discovery.js  directory fetch, LAN enrichment, manual-address resolution
store.js      saved instances (JSON in userData), stable local ports
prefs.js      the shared-settings snapshot (JSON in userData)
preload.js    IPC surface for the chooser page
receiver-preload.js  seeds/reports shared settings in receiver windows
chooser/      the chooser window (plain HTML/CSS/JS, no framework)
ui/           staged v2 build artifacts (generated, git-ignored)
```

Runtime npm dependencies: none. `electron` is the only dev dependency; the UI
build needs only esbuild, same as the rest of the repo.

## Packaging

```sh
./build.sh --package
```

stages the UI and then runs `electron-builder`, leaving distributables in
`dist/`:

- on **Linux**: `UberSDR-<version>.AppImage` plus `UberSDR-<version>-win.zip`
  (unzip on Windows and run `UberSDR.exe`). A proper NSIS installer can only
  be cross-built with a wine that has 32-bit support; built on Windows itself
  (`./build.sh --package` there) it comes out as `UberSDR Setup <version>.exe`.
- on **macOS**: a dmg. Mac packages can only be built on a Mac — for all
  three platforms from one push, run `./build.sh --package` in a CI matrix
  (ubuntu / macos / windows runners).

None of the binaries are code-signed; macOS Gatekeeper and Windows SmartScreen
will warn accordingly until signing identities are configured in the
`build` section of `package.json`.
