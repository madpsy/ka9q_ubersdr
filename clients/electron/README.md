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
property of how the proxy works rather than something anybody asked for, so
settings are shared: one arrangement of the interface, on every receiver.

A snapshot of the `ubersdr.v2.*` keys is kept in userData
(`shared-prefs.json`), each receiver window is seeded from it before the page
boots (`receiver-preload.js`), and changes made in any window are written back.
The first receiver opened supplies the initial snapshot; windows already open
pick up later changes when reloaded.

This was a checkbox in the chooser, defaulting to on. It is not any more: how
the interface is arranged is a property of the client rather than of any one
receiver, so there was one sensible answer and a control offering the other.
What is *not* shared is where the real judgement lives, and that is unchanged:

Two things are deliberately never shared:

- `ubersdr.v2.radio` — frequency, mode, filter edges, spectrum view, squelch
  and volume. Carrying a frequency across would tune a receiver to a band it
  may not cover, and a squelch set against one receiver's noise floor can gate
  another's audio to silence.
- the news panel's article cache, which is bulk rather than settings.

The session password is in `sessionStorage`, not `localStorage`, so it is never
part of the snapshot.

## The chooser

Four tabs, because they answer different questions and only one of them is ever
the question at hand:

- **Saved** — receivers already connected to, ordered as below.
- **Local network** — an mDNS browse of `_ubersdr._tcp`, run the first time the
  tab is opened rather than at startup.
- **Public directory** — everything `instances.ubersdr.org` knows about, as a
  list beside a map.
- **Custom** — an address typed in by hand.

The address box was in the header, above all three lists, which said "type an
address" to everyone who opened the app and mostly meant "not this": the lists
answer the question far more often than the box does. It is a fourth place a
receiver can come from, so it is a fourth tab.

The page opens on Saved when there is anything in it and on the directory when
there is not; whichever tab was open last takes precedence over both.

### The directory map

The directory tab draws its receivers on OpenStreetMap tiles with the day/night
terminator over them, using the same Leaflet the web UI's own maps use —
`build.sh` copies `static/leaflet.js`, `static/leaflet.css`,
`static/L.Terminator.js` and `static/fonts/twemoji-flags.woff2` into
`chooser/vendor/` (generated, git-ignored). It is
loaded on demand when the tab is first opened, so a run that never opens it
never reads 150 KB off disk, and a checkout that has not been through
`build.sh` still lists every receiver — it just says it cannot draw them.

The directory *list* loads whichever tab the page opened on, so the map tab is
instant when it is reached; the map itself waits, and so does its fit. A Leaflet
map in a hidden panel measures its container as nothing, and fitting to nothing
is not a no-op — `getBoundsZoom` subtracts the padding from a zero size, divides
by a negative and takes its log, so the zoom comes back `NaN` and the map lands
somewhere arbitrary and stays there. The fit is therefore held until the panel
has a size and retried on the way in.

It is the web UI's map, not merely the same library: the tiles take the same
dark filter `StartMap` and `CallsignMap` take (copied verbatim from
`static/v2/src/styles.css`, which took it from v1), the pins are its ringed dots
with a glow, and selecting a receiver draws the dashed great circle the start
overlay draws between you and the receiver — which is what the distance in the
row looks like.

The colours are the list's rather than v2's, and deliberately. v2's maps colour
by identity — red is the station being looked at, green is you — because they
draw two pins that are never the same kind of thing. This one draws forty-five
of one kind, so the colour has to carry what varies between them: green for a
receiver that is answering and red for one that is not, matching the dot on
every row, with you in blue because the other two are spoken for. A pin that
read "online" beside a row that read "offline" would be worse than a map in the
wrong palette.

The view is fitted to every pin and to you, and refitted whenever that set
changes — a filter typed, a receiver appearing or dropping out — but not on the
idle refresh, so a view that has been panned or zoomed to stays put.

The list and the map are two views of one set, and hovering either half raises
the same card: over a pin, or over the row that names it. Clicking goes further —
a pin opens that card with Connect and the password key on it and selects the
row; a row centres the map and opens the pin. The hover card stops at the facts
because a tooltip goes as the pointer leaves it, which would make a button on it
unreachable, and hovering never moves the map: a pointer crossing the list on its
way somewhere else should not drag the view through half the world.

The list itself follows the web directory's minimal view: online dot, flag,
callsign, average FT8 SNR, free slots, name with a sun or moon, place and
distance, and a badge for every band currently at fair or better. Conditions
older than half an hour are not drawn at all — an instance that stopped
reporting an hour ago is not a receiver hearing 40 dB on 20 m, it is a receiver
nobody has heard from. Offline receivers are listed but sort last in every
order.

### Flags

Every directory row carries its country's flag, built from a pair of regional
indicators — which every platform but Windows renders as a flag, and Windows
renders as two letters in boxes, because Segoe UI Emoji ships no national flags.
So the chooser declares the same flags-only Twemoji subset v2 does, from the same
file, with the same `unicode-range` (the 500 KB is only read when a flag is
actually on screen) and the same metric overrides (the font's own ascent is
13.6 em, which applied to `line-height: normal` lays out rows hundreds of pixels
tall).

This is also why `loadAsset` *prepends* Leaflet's stylesheet rather than
appending it. `chooser.css` overrides `leaflet.css` at equal specificity — the
popup colours, the zoom buttons, and the `font-family` on `.leaflet-container`
that everything drawn inside the map inherits, the flag face included — and equal
specificity is settled by document order. A sheet appended after the page's own
silently wins all of it.

### Where you are

The map's second pin, and what the distance column measures from. Electron has
no usable `navigator.geolocation` — Chromium's provider wants a Google API key
a self-built app does not have — so the automatic answer is GeoIP on the address
the directory was fetched from (`instances.ubersdr.org/api/myip`), and
**Set my location…** takes a Maidenhead locator or a latitude and longitude for
when that is wrong or missing. It is missing more often than it sounds: behind a
VPN, a tunnel or any proxy that presents a private address, the lookup answers
with an IP it cannot place and the chooser says so rather than guessing. A typed
position is kept in `instances.json`,
is used on this machine only, and is never sent anywhere: distances are computed
here from the coordinates the directory already publishes, rather than by
telling the directory where to measure from.

### Ordering the saved list

Saved receivers are ordered by how often they have been opened, most visited
first, with the most recent breaking ties. A connection counts only once a
window has actually opened, so a receiver that refused the probe is not counted
as visited. Entries saved before counting existed start at zero and therefore
keep their old recency order until they are used again. The picker beside the
heading switches the list back to plain most-recent-first, and the choice is
remembered.

### The password key

Some receivers have a bypass password — one the operator hands out to get past
a full house or a ban. In a browser it is typed into v2's start overlay and
forgotten when the tab closes; here the saved list exists so that things are not
typed twice, so the key icon on every row in the chooser saves one per receiver.
It is offered in all three places a receiver can come from — the address box,
the LAN scan and the directory — and lights up where one is set.

Set one against a receiver that has not been saved yet and it is kept until the
connect that creates the entry. Change or clear one for a receiver that is open
and its window reloads, which is also how a wrong one gets a second try.

Where the platform has a keychain the password is encrypted with it
(`safeStorage`: DPAPI, Keychain, libsecret/kwallet) and `instances.json` holds
only ciphertext; where there is none — a headless Linux box without libsecret —
it is stored plainly in the same userData directory as everything else, because
the alternative is a feature that silently does not work there. A file written
on a machine with a keychain and opened on one without reads as no password
rather than as garbage.

The value never crosses into the chooser page: the renderer is told only whether
one is set. Receiver windows get it at preload, which puts it in `sessionStorage`
under the key v2 already reads (`ubersdr.v2.password`, see
`static/v2/src/radio/session.js`) rather than handing it to the page.

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

## Links: `ubersdr://connect?uuid=…`

A receiver, named in a link, from anywhere the desktop can follow one — a
message, a web page, a QR code read on the phone next to you:

```
ubersdr://connect?uuid=4907ba0a-32e6-40bb-a4ca-47f823331728
```

The same scheme and the same behaviour as the Android client, deliberately:
`deeplink.js` here and `clients/capacitor/src/deeplink.js` there are ports of
each other, the way `discovery.js` and `store.js` are. A link that works on the
phone works on the desktop, or it is not a link, it is a phone feature.

The UUID is the public one: the `id` on the instance's `/api/instances` entry at
the directory, which is the `public_uuid` it reports itself under
(`instance_reporter.go`). An address is deliberately not what a link carries,
because an address is the part that changes — a tunnel hostname, a dynamic IP, a
move from 8080 to 443 — and a link should survive all of that.

Following one: **the saved list first**, by UUID (`store.ensure` records it for
anything that came from the directory, so a receiver already used opens with no
directory round trip), **then the directory** (`/api/instances/<uuid>`, falling
back to filtering the full list for a collector without that route), **then the
ordinary connect** — the same probe, the same store entry, the same window as a
row clicked in the directory tab. A saved receiver that has moved heals at the
second step, which is the case the UUID exists for. Nothing about a link is
trusted beyond being a UUID to look up.

Three platforms deliver a followed link three ways, and `main.js` handles all
three:

| | |
|---|---|
| macOS | `app.on('open-url')`, which can fire before the app is ready — buffered and flushed by `whenReady` |
| Windows, Linux | in the command line: `process.argv` when the link started the app, and the `second-instance` argv when one was already running |

Registration is likewise split. `app.setAsDefaultProtocolClient('ubersdr')` at
startup claims the scheme — on Windows that is the whole of it, since
electron-builder's NSIS target writes no protocol keys — and the `protocols`
entry in `package.json` is what makes the association exist on the other two:
electron-builder writes `CFBundleURLTypes` into the macOS `Info.plist` and
`MimeType=x-scheme-handler/ubersdr` into the Linux `.desktop` file, whose `Exec`
already ends in `%U` so the URL reaches argv. In a working tree
(`npm start`) the registration carries the app path explicitly, or following a
link would start a bare Electron with no app in it.

Where the links come from: the **Open in App** button on v2's start overlay
(`static/v2/src/lib/appLinks.js` builds the URI, `StartExtras.jsx` draws the
dialog). Its two buttons are "open" and "download for this platform", and the
second is there because the first cannot be checked: a browser cannot ask the
operating system whether a scheme is claimed, and following an unclaimed one is
silent — so an installed client and a missing one look identical until nothing
happens. The download links are this client's own release artefacts, which is
why their file names are pinned (see the `artifactName` note in `package.json`).
The button is left out entirely when the page is already running inside either
client.

A failure is a native dialog rather than something drawn in the chooser: the
chooser page is shared with the Android client and a link is followed by the app
rather than by anything on that page. The case that actually needs saying is the
one where no receiver window ever appears.

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
- **TCI server**: the SDR Control panel gains a **TCI** surface — the other
  direction from the transports above. Instead of this client following a
  radio, it *becomes* one: a TCI server on port 60001 (not TCI's usual 40001,
  so the client and the server can both be in use at once) that JTDX, WSJT-X or
  a logger connects to. It answers the handshake, reports and accepts the dial
  and the mode, and streams the receiver's audio as TCI float32 frames,
  resampled to the 48 kHz those clients expect. `wsserver.js` is a WebSocket
  server in about as little as RFC 6455 allows, because Node has none and this
  client has no runtime dependencies; `tciserver.js` is the protocol on top.

  It listens on 127.0.0.1 unless told otherwise, since it hands out audio and
  lets whoever connects retune the receiver.

  The audio never passes through the volume and mute controls: it is tapped
  ahead of them (the `audio` command, API 1.4), so muting the speakers does not
  silence a decoder. The page opens a `MessageChannel` and the preload passes
  that port straight to the main process, so the samples reach the socket
  without this window relaying them.
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
discovery.js  directory fetch, by-UUID lookup, GeoIP, LAN enrichment,
              manual-address resolution
deeplink.js   ubersdr://connect?uuid=… — parsing and resolving, with the
              Electron-shaped half (registration, delivery) in main.js
store.js      saved instances (JSON in userData), stable local ports, the
              optional per-instance password (keychain-sealed where there is a
              keychain), and the chooser's own state (open tab, directory sort,
              typed-in location)
prefs.js      the shared-settings snapshot (JSON in userData)
flrig.js      flrig over XML-RPC, for the Radio Control panel's FLRig option
rigctl.js     rigctld over its TCP protocol, likewise
tci.js        the TCI protocol over a WebSocket — browser code, bundled into
              receiver-preload.js and run in the window
wsserver.js   a WebSocket server, RFC 6455, for the TCI server to listen on
tciserver.js  this receiver offered *as* a TCI radio: handshake, commands,
              audio frames, and the 48 kHz resampling they arrive at
test/         node tests for the protocol handling, the store and the
              chooser page (./test/run.sh)
preload.js    IPC surface for the chooser page
receiver-preload.js  seeds/reports shared settings, seeds the saved password,
                     and tells the page the receiver's real address
serial-preload.js    IPC surface for the serial picker page
chooser/      the chooser window (plain HTML/CSS/JS, no framework);
              chooser/vendor/ holds the staged Leaflet (generated, git-ignored)
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

### Just the AppImage

```sh
./build.sh --linux
```

The Linux artefact and nothing else. On Linux, `--package` also builds the
Windows zip — a second Electron download the first time — and then a Windows
installer in a 4.7 GB container, none of which is wanted when what is being
tested is the Linux build. It refuses to run on a non-Linux host rather than
failing deep in a toolchain that is not there, and it cannot be combined with
`--win-installer`, which asks for the opposite. `--skip-ui` composes with it as
usual.

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

The Windows installer is not signed; SmartScreen warns accordingly until an
Authenticode certificate is configured. That warning is advisory — it can be
clicked through.

On macOS it is fatal rather than advisory, and it applies to a dmg **downloaded
from the internet** — from a GitHub release, say. The browser marks the download
with the quarantine attribute, and for an unsigned app Gatekeeper refuses it as
damaged rather than offering to open it anyway. A dmg built on the machine it
runs on was never downloaded, so it carries no quarantine attribute and works
perfectly — which is why the problem only ever shows up for the people you send
a release to, and never during testing.

Clearing the attribute after dragging the app to Applications is what lets an
unsigned build start, once per install:

```sh
xattr -cr "/Applications/UberSDR.app"
```

Asking that of everybody who downloads it is not a plan, so:

### Signing the macOS build

Everything is configured; what is missing is the credentials, which are
deliberately not in the repository. Signing runs only on a Mac — `codesign` is
macOS-only — so this is `./build.sh --package` on a Mac, with an Apple Developer
account.

Two separate things have to happen, and **signing alone is not enough**: since
Catalina, Gatekeeper rejects a downloaded app that is not also *notarised* by
Apple. electron-builder does both, plus stapling the ticket into the dmg, as
soon as it finds the credentials in the environment.

You need a **Developer ID Application** certificate — not "Mac App
Distribution", which is App Store only and will not satisfy Gatekeeper for a
direct download — and an **App Store Connect API key** (Users and Access →
Integrations → Keys) for notarisation.

```sh
# The certificate. Or import the .p12 into the keychain and set neither:
# electron-builder finds a Developer ID identity there on its own.
export CSC_LINK=~/certs/developer-id.p12
export CSC_KEY_PASSWORD='…'

# Notarisation. An Apple ID with APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID
# also works, but @electron/notarize recommends the API key.
export APPLE_API_KEY=~/private_keys/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

./build.sh --package
```

`build.sh` prints what it found before it starts, because notarisation adds
several minutes of uploading and waiting and discovering afterwards that there
were no credentials is discovering it too late:

```
  macOS signing
    certificate    CSC_LINK
    notarisation   App Store Connect API key
```

Nothing is enforced — an unsigned build is what every test build is, and the
report says plainly that the dmg will be refused on anyone else's Mac.

Then check it on a Mac that has never seen the file, downloading it from the
release rather than copying it across, since quarantine is what triggers any of
this:

```sh
spctl -a -vvv -t install "/Volumes/UberSDR/UberSDR.app"   # → source=Notarized Developer ID
xcrun stapler validate dist/UberSDR-arm64.dmg
```

#### What is already set up

`hardenedRuntime` and `notarize` are electron-builder's defaults for mac, so
there is nothing to switch on. The parts that needed doing:

- **`assets/entitlements.mac.plist`** and its `.inherit.` sibling. The hardened
  runtime forbids exactly what V8 does — compiling code at run time — so without
  `allow-jit` and friends the app does not start at all. They live in `assets/`
  because that is this project's `directories.buildResources`; the `build/` that
  every tutorial names is simply a different project's setting, and a file in
  the wrong place is not an error, just a build that fails much later.
- **The microphone entitlement**, in both files, plus
  `NSMicrophoneUsageDescription` in `mac.extendInfo`. The app asks for the
  microphone — not to record, but because a browser will not reveal the *names*
  of audio output devices until an input device has been granted once (see
  `static/v2/src/lib/audioSinks.js`). Under the hardened runtime that needs the
  entitlement, and macOS needs a reason to show the operator. Missing either and
  the request is denied rather than prompted. It is in the inherit file too
  because Chromium captures audio from a helper process, not the main one.

The dmg is arm64 only, and signing does not change that — an Intel Mac still
cannot run it, which is why the update check sends `darwin/x64` to the releases
page instead of a direct download. `electron-builder --mac --universal` builds
one file for both, at roughly double the size.
