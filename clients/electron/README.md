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
  (`index.html`, `dist/`, `fonts/`, `vendor/`) into `ui/v2/`, untouched. It
  also bundles one shared source module, `src/lib/pagesMenu.js`, to
  `ui/pagesMenu.cjs` — the main process needs the same pages-menu pruning the
  UI does to build its native Links menu, and a second copy of that logic
  would be free to drift. The same step bundles `src/bridge/client.js` into
  `receiver-preload.js` (as `ui/receiver-preload.js`): the Layout menu talks to
  the page over the documented page API rather than a private channel, and a
  sandboxed preload cannot `require` a file at run time, so the client has to
  be bundled in rather than loaded beside it.
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

Because each instance's local port is its own origin, every receiver would
otherwise keep its own v2 settings in its own localStorage. That isolation is a
property of how the proxy works rather than something anybody asked for, so the
chooser's **"Share settings between receivers"** option is **on by default**:
one arrangement of the interface, on every receiver.

With it on, a snapshot of the `ubersdr.v2.*` keys is kept in userData
(`shared-prefs.json`), each receiver window is seeded from it before the page
boots (`receiver-preload.js`, which exposes nothing to the page), and changes
made in any window are written back. The first receiver opened supplies the
initial snapshot; windows already open pick up later changes when reloaded.

Two things are deliberately never shared:

- `ubersdr.v2.radio` — frequency, mode, filter edges, spectrum view, squelch
  and volume. Carrying a frequency across would tune a receiver to a band it
  may not cover, and a squelch set against one receiver's noise floor can gate
  another's audio to silence.
- the news panel's article cache, which is bulk rather than settings.

The session password is in `sessionStorage`, not `localStorage`, so it is never
part of the snapshot.

Turning sharing off stops the bridging and nothing else: the per-origin stores
are never emptied, so every receiver is independent again with whatever it had
last — which makes the toggle safe to try both ways.

### Ordering the saved list

Saved receivers are ordered by how often they have been opened, most visited
first, with the most recent breaking ties. A connection counts only once a
window has actually opened, so a receiver that refused the probe is not counted
as visited. Entries saved before counting existed start at zero and therefore
keep their old recency order until they are used again. The picker beside the
heading switches the list back to plain most-recent-first, and the choice is
remembered.

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
  main process answers `select-serial-port` with its own modal window
  (`serial/`) — a scrollable list showing each port's name, device path and
  USB IDs, which stays live as devices are plugged and unplugged. It was a
  native message box with one button per port, but a message box lays its
  buttons out in a single horizontal row that cannot scroll, so every extra
  port made the dialog wider. Every port is offered, including when only one
  is attached: auto-selecting it saved a click at the cost of handing a serial
  device to remote page content without anyone naming it.
- **Web MIDI** (MIDI control surfaces): granted through the permission
  handler. Note that the permission to allow is `midiSysex`, not `midi` —
  Chromium requests the sysex permission even for
  `requestMIDIAccess({ sysex: false })`, which is how the UI asks. Allowing
  only `midi` leaves MIDI silently dead: the promise rejects with
  `NotAllowedError` and no controller ever appears.
- **Links menu**: each receiver window carries a native **Links** menu with
  that receiver's published pages — the same tree the UI hangs off its logo,
  from `/api/pages-menu` pruned by `depends_on` against `/api/description`.
  The pruning is not reimplemented here: `static/v2/src/lib/pagesMenu.js` is
  the one copy, and `build.sh` bundles it to `ui/pagesMenu.cjs` for the main
  process, so the two menus cannot list different pages for the same
  receiver. Per window, because two connected instances publish different
  pages; on macOS, where there is one menu bar for the application, it follows
  the focused window instead. Choosing an entry asks the receiver's own page
  to open it, so the v1 pages that talk to `window.opener` still get one.
- **Layout menu**: each receiver window also carries a native **Layout** menu —
  every registered panel, shown or hidden, with its position (left, right,
  bottom, floating). The state belongs to the page, so nothing is mirrored
  here: the menu is a client of the v2 page API (`layout` topic, `panel`
  command, added in API 1.1), which means a panel dragged about in the UI moves
  its menu entry with it and the two cannot disagree. The Layout panel itself
  is greyed out for hiding, because it is what brings the others back.
- **TCI**: an **TCI** connection for Expert Electronics radios (SunSDR and
  friends), on port 40001. Unlike the other two this one runs in the receiver
  window rather than the main process — TCI is carried over a WebSocket, which
  a renderer has and Node 20 does not, and hand-rolling RFC 6455 to reach it
  would risk the transport rather than the protocol. `tci.js` is browser code,
  bundled into the preload. It follows `vfo` rather than `dds` (the latter is
  the panorama's centre, not where the radio is listening) and will not send a
  modulation the radio left out of its `modulations_list`, since TCI has no way
  to refuse one. Tested against a real SunSDR2DX (ExpertSDR3 2.0), which sends
  `dds:0,14254500` and `if:0,0,91500` alongside `vfo:0,0,14346000` — the first
  two summing to the third, which is why the `vfo` is the one to follow.
- **rigctld**: the Radio Control panel gains a **rigctld** connection beside
  Serial, with a host and port (4532 by default). Hamlib's own daemon, so it
  drives every rig Hamlib supports — without the page's 14 MB of WebAssembly,
  and without the cable having to be on this machine. Its protocol is a raw
  TCP socket (`rigctl.js`), which no page can open at all, so like flrig it
  lives in the main process.
- **flrig**: the Radio Control panel gains an **FLRig** connection beside
  Serial, with its own host and port. flrig speaks XML-RPC and sends no CORS
  headers, so no page can reach it — the requests are made from the main
  process (`flrig.js`), and the preload registers the transport with the panel
  over the page API (`radio` command, `radiocontrol` topic, API 1.2) and runs
  the sync in whichever direction the panel is set to. Transmit muting uses
  `duck`, so it never touches the mute the operator set themselves.

  The panel is what makes this general: anything hosting a v2 page can register
  a transport and have its fields appear there. Serial remains the one the page
  hosts by itself.

  **Auto-connect** (off by default) sits beside the Connect button and decides
  whether the link is opened when the page opens. Off, a reload leaves the radio
  alone — the connect request is what is being asked for now, not a preference,
  so it is not resumed. A refused connection keeps trying and the address stays
  editable while it does, so correcting a wrong port is picked up in place
  rather than needing the transport switched away and back.
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
flrig.js      flrig over XML-RPC, for the Radio Control panel's FLRig option
rigctl.js     rigctld over its TCP protocol, likewise
tci.js        the TCI protocol over a WebSocket — browser code, bundled into
              receiver-preload.js and run in the window
test/         node tests for the protocol handling (./test/run.sh)
preload.js    IPC surface for the chooser page
receiver-preload.js  seeds/reports shared settings in receiver windows
serial-preload.js    IPC surface for the serial picker page
chooser/      the chooser window (plain HTML/CSS/JS, no framework)
serial/       the Web Serial port picker window
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

- on **Linux**: `UberSDR-<version>.AppImage`, `UberSDR-<version>-win.zip`
  (unzip on Windows and run `UberSDR.exe`) and `UberSDR Setup <version>.exe`
  (see below — built in Docker, and skipped with a note where Docker is
  absent).
- on **macOS**: a dmg. Mac packages can only be built on a Mac — for all
  three platforms from one push, run `./build.sh --package` in a CI matrix
  (ubuntu / macos / windows runners).

### The Windows installer

`./build.sh --package` builds it on Linux along with everything else — the zip
and the installer are both Windows artefacts, so there is no separate step to
know about. `./build.sh --win-installer` asks for it specifically, and differs
in one way: it fails when Docker is missing, where `--package` says so and
carries on with the rest.

Either way it produces `UberSDR Setup <version>.exe` — Start-menu entry,
uninstaller, the lot. It runs electron-builder inside its own
`electronuserland/builder:wine` image, because NSIS is a Windows toolchain and
cross-building it needs a wine with 32-bit support.

Running it against a wine without that is worse than it failing: it writes a
~300 KB stub beside the ~78 MB payload it could not embed, and **exits 0**. The
script therefore checks the size of what came out rather than the exit code, and
fails loudly if the installer is too small to contain the app.

The container runs as the invoking user, so `dist/` stays yours — as root it
would leave artefacts you could not delete, and the next build would fail trying
to overwrite them. The Electron and electron-builder caches are mounted from
`~/.cache`, so only the first run downloads the Windows binaries.

The image is fetched on first use — 4.7 GB, once — and the script says so
before it starts, since a silent download that size looks like a hung build.

On Windows itself no container is involved: `./build.sh --package` builds NSIS
natively.

### Unsigned builds

None of the binaries are code-signed; macOS Gatekeeper and Windows SmartScreen
will warn accordingly until signing identities are configured in the `build`
section of `package.json`.

On macOS that warning is fatal rather than advisory, and it applies to a dmg
**downloaded from the internet** — from a GitHub release, say. The browser marks
the download with the quarantine attribute, and for an unsigned app Gatekeeper
then refuses it as damaged rather than offering to open it anyway. Clearing the
attribute after dragging the app to Applications is what lets it start:

```sh
xattr -cr "/Applications/UberSDR.app"
```

Once per install. A dmg built on the machine it runs on was never downloaded, so
it carries no quarantine attribute and needs none of this — which is why the
problem only shows up for the people you send a release to. It goes away
entirely once the app is signed and notarised.
