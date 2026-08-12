# UberSDR Android client

The chooser and the v2 web UI in a Capacitor shell. The UI is **bundled**: the
v2 bundle ships inside the APK and is served to the receiver's WebView by a
loopback proxy, so the app is a client rather than a wrapper around somebody's
website.

```sh
./build.sh --apk       # build the UI, stage it, assemble a debug APK
./build.sh --install   # ...and adb-install it
```

Needs a **JDK 21** (Capacitor's Android module compiles at 21 — a JRE 21 is not
enough), the Android SDK, and `esbuild`. Android Studio is not required;
`build.sh` says what is missing if something is.

## How it shares the main codebase

Two things are staged, and neither is modified on the way in.

- **The v2 frontend.** `build.sh` runs the stock `static/v2/build.sh` and stages
  its artifacts (`index.html`, `dist/`, `fonts/`, `vendor/`) into `www/v2/`,
  untouched. `cap sync` copies `www/` into the APK's assets and
  `LocalProxy.java` serves `/v2/*` out of there.
- **The chooser.** `clients/electron/chooser/` — the page itself, staged as it
  stands. Its one dependency on the host it runs in is `const api =
  window.ubersdr` (`chooser.js`), which `src/api.js` provides here over
  Capacitor plugins and `preload.js` provides there over Electron IPC. It is
  staged rather than forked so that a change to the chooser is a change to both
  clients.

`src/store.js` and `src/discovery.js` are ports of the desktop client's files of
those names, and deliberately close ones: the two clients stage the same page,
so what it may read and write has to mean the same thing in both.

## The two halves

```
MainActivity (Capacitor)      the chooser, from the app's own origin, with the
                              bridge and the plugins
ReceiverActivity (plain WebView)
                              one receiver, loaded from its loopback proxy, with
                              a document-start script where the desktop client
                              has a preload
LocalProxy.java               per-instance reverse proxy: the bundled /v2/* out
                              of assets, everything else to the instance
```

The receiver is deliberately not a Capacitor screen. It is served from
`http://127.0.0.1:<port>`, which is not the app's origin, so the Capacitor
bridge is not injected there and would be no use if it were: what the page needs
from its host is a preload, and the Android equivalent of a preload is
`WebViewCompat.addDocumentStartJavaScript`.

### Why the proxy

The v2 frontend is same-origin by construction — relative `fetch()` calls,
websocket URLs built from `location.host`, root-absolute assets served by the
instance. The desktop client solves that with a loopback reverse proxy
(`clients/electron/proxy.js`) and this one is a port of it, because on Android
the alternatives are not merely worse but blocked:

- serving the bundle from the app's origin and calling the instance across it
  needs **CORS**, which is an operator setting that defaults off
  (`main.go`, `config.Server.EnableCORS`) — most receivers would refuse;
- three panels use **EventSource**, which nothing can route natively for a page
  the way `CapacitorHttp` routes `fetch`;
- an `https://localhost` app origin cannot open a **cleartext websocket** to a
  LAN receiver: mixed content.

Same-origin has none of those problems, because none of them are problems the
desktop client has either. `http://127.0.0.1` is also a secure context, so the
page keeps `AudioWorklet`, `enumerateDevices` and everything else that needs
one.

The local port is stable per instance (assigned by the store) for the reason it
is there: settings live in `localStorage` keyed by origin, so a receiver coming
up on a different port each launch would come up with its settings reset.

### No choice of UI

The desktop client offers, per receiver, its own bundle or the one the instance
serves — both are equally reachable from a desktop, and an instance whose server
has drifted ahead of the app is a real situation. Here there is one answer: the
bundle in the APK, updated when the app is. A picker whose other option is
"fetch 1.5 MB over the air every time you connect" is not a choice worth
offering on a phone.

The chooser draws that picker per saved row, so it now asks whether there is a
choice to offer: `appInfo().uiChoice === false` and the control is not drawn.
Absent means yes, so the desktop client is unchanged.

## The plugin

`android/app/src/main/java/org/ubersdr/mobile/`, registered by `MainActivity`
rather than published as a package — it is this client's platform half, not a
library.

| | |
|---|---|
| `Http.java` | one GET, one JSON document, and the certificate-error classification the chooser's "trust this receiver anyway" is built on |
| `Mdns.java` | `_ubersdr._tcp` on the local network |
| `Secrets.java` | the bypass password, sealed with a key in the Android keystore |
| `LocalProxy.java` | the receiver's loopback proxy |
| `ReceiverActivity.java` | the receiver's WebView and its document-start script |

Everything else stayed in JavaScript. The store, the row shapes, the sort, the
candidate ladder a bare hostname expands to — none of that needs the platform,
and each piece that stays in JS is a piece the two clients still share.

### Why all the HTTP is native

Not only for the self-signed case. Every one of these calls is cross-origin from
the app's page, against servers whose CORS defaults off — so a chooser that
fetched `/api/description` itself would fail against most of the receivers it
exists to find. One native path also means one User-Agent (`src/useragent.js`),
which is what a receiver logs.

### The password

Stricter here than on the desktop. There the sealed string sits on the
instance's entry in `instances.json` and the store can read it back; here the
value lives only in `Secrets.java`, keyed by instance id, and the JavaScript
half has no call that returns one — it can set one, clear one, and ask whether
one is set. `ReceiverActivity` reads it directly when it opens a page and seeds
`sessionStorage` under the key v2 already reads (`ubersdr.v2.password`, see
`static/v2/src/radio/session.js`).

## Leaving a receiver

On a desktop each receiver is a window, and closing the window is how you leave
one. A phone shows one thing at a time, and the thing before this was the
chooser — so v2's own power button is the way back: stop the receiver and the
Activity finishes.

No control was added to the interface to do that, and nothing in v2 was changed.
`src/receiver.js` is a client of the documented page API
(`static/v2/BRIDGE_API.md`), subscribed to the `session` topic, and `running`
going false is what it acts on. It is bundled with that API's own client library
(`static/v2/src/bridge/client.js`) exactly as the desktop client bundles it into
its receiver preload, because a document-start script cannot import anything at
run time.

It waits for a `true` before acting on a `false`: subscribing delivers the
current snapshot at once, and at that moment the receiver has not started, so
without the latch opening a receiver would immediately close it.

## Starting without the overlay

v2's start overlay exists for one browser rule — an AudioContext not created
from a user gesture is suspended — and a page cannot waive that for itself,
because in an ordinary browser it would start into silence. So the host says
whether the rule applies, through `window.ubersdrDesktop.autoStart`, which
`StartOverlay.jsx` reads.

It applies here for the same reason it does on the desktop: the rule is switched
off. `ReceiverActivity` sets `setMediaPlaybackRequiresUserGesture(false)`, which
is this platform's version of the desktop client's
`autoplay-policy=no-user-gesture-required`. Somebody who picked a receiver in
the chooser has already said what the button asks.

v2 starts on the answer from `/connection` rather than on mount, so a full or
barred receiver still shows its reason and its password box — and by then the
saved password has been seeded, which is what makes "with or without a password"
one path rather than two.

## What the phone gets that the desktop does not

- **The layout.** `static/v2` already has a phone layout — `LayoutContext.jsx`
  has a `phone` machine class with per-panel `mobile` first-run presets — plus
  haptics and sheet gestures. None of that needed doing here.
- **Backgrounding that already works.** `VisibilityWatch.jsx` drops the spectrum
  socket when the page is hidden and deliberately leaves the audio socket alone.

`mobile.css` is the chooser's phone pass, loaded after `chooser.css` and saying
only what a 430 px screen needs said differently: there is no hover, there is no
room above the first row, and 24 px of icon is not a thumb target.

## Not done yet

Named rather than left to be discovered:

- **The foreground service and the media session.** Android's WebView does not
  surface the page's `navigator.mediaSession` as a notification the way Chrome
  does, so a receiver playing in the background needs a foreground service, a
  `MediaSessionCompat` fed from the page API, and audio focus. Note for whoever
  does it: do not call `WebView.onPause()`/`pauseTimers()` — the audio gate runs
  on a 20 ms `setInterval` (`GATE_TICK_MS` in `static/v2/src/radio/audio-player.js`)
  and Chromium throttles hidden-page timers to about once a minute.
- **Shared settings.** The chooser's toggle is stored and honoured by nothing:
  the desktop client bridges `ubersdr.v2.*` between receiver origins from its
  preload (`receiver-preload.js`), and the document-start script here does not
  yet.
- **More of the page API.** The bridge is there and subscribed to `session`
  (see "Leaving a receiver"); what it does not do yet is feed the media session
  above. There is no Links menu and no Layout menu, and neither is wanted: a
  phone has no menu bar, and the Layout menu's job is done by the phone layout.
- **Popups.** The v1 windows (callsign lookup, map, CW graph) open with
  `window.open`, which this WebView does not handle yet.
- **Upstream connection pooling.** `LocalProxy` opens a connection per request
  and relays with `Connection: close`. The cost is a TLS handshake per request
  against a remote instance on first load; the benefit is that the response body
  needs no interpretation, so SSE and chunked encoding pass through as bytes.

## Packaging and publishing

```sh
./build.sh --release    # dist/UberSDR.apk
./build.sh --publish    # ...and upload it to the `latest` GitHub release
```

`--publish` follows the desktop client's: the rolling `latest` tag on
`madpsy/ka9q_ubersdr`, one artefact under a fixed name (`UberSDR.apk`, so the
download link never moves — the version is inside the APK, where Android reads
it), `--clobber` to replace what is there, and a typed `yes` from a terminal
before anything is uploaded.

The version comes from `package.json`, as it does for the desktop client:
`app/build.gradle` reads it for `versionName` and derives `versionCode` from it
(0.1.0 → 100), so a release is a version bump in one file.

### Signing

An unsigned release APK is not a build with a warning on it — Android refuses to
install it at all. So `--publish` refuses to upload one, where the desktop
client only reports an unsigned dmg.

```sh
keytool -genkeypair -v -keystore ubersdr-release.jks -alias ubersdr \
        -keyalg RSA -keysize 4096 -validity 10000

export UBERSDR_KEYSTORE=~/keys/ubersdr-release.jks
export UBERSDR_KEYSTORE_PASSWORD='…'
export UBERSDR_KEY_ALIAS=ubersdr          # optional, defaults to ubersdr
export UBERSDR_KEY_PASSWORD='…'           # optional, defaults to the above

./build.sh --publish
```

`build.sh` prints what it found before it starts, because discovering afterwards
that there were no credentials is discovering it too late.

**Keep the keystore.** Android identifies an app by its signature: an APK signed
with a different key cannot be installed over one already on a device — it has
to be uninstalled first, taking its saved receivers with it. Losing the file
means everybody in the field reinstalling by hand.

Sideloading is the distribution route for now. Play Store publishing would want
an app bundle (`bundleRelease`) and Play App Signing instead, which is a
different arrangement and not set up here.

## Files

```
build.sh      builds v2, stages it and the chooser, syncs, assembles, publishes
capacitor.config.json
mobile.css    the chooser's phone pass, loaded after chooser.css
src/api.js    window.ubersdr — the surface clients/electron/preload.js defines
src/store.js  saved instances, over Preferences (port of electron's store.js)
src/discovery.js
              directory, LAN and manual addresses (port of electron's)
src/useragent.js
              how this client names itself; owns the token the WebView appends
src/native.js the plugin handle
src/main.js   the entry point: assigns window.ubersdr before chooser.js runs
src/receiver.js
              what runs inside a receiver page, bundled with the v2 page API's
              client library — the Android answer to a preload
www/          staged: the chooser, Leaflet, app.js and the v2 bundle (generated)
android/      the Capacitor project, plus the plugin above
```
