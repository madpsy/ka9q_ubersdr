# UberSDR mobile client

The chooser and the v2 web UI in a Capacitor shell, on **Android and iOS**. The
UI is **bundled**: the v2 bundle ships inside the app and is served to the
receiver's WebView by a loopback proxy, so this is a client rather than a
wrapper around somebody's website.

The two platforms share far more than they differ. All of the JavaScript —
`src/api.js`, `store.js`, `discovery.js`, `deeplink.js`, `receiver.js`, the
staged chooser page — is the same file on both, and neither knows which
platform answered it. What differs is the platform half behind it: Java in
`android/`, Swift in `ios/UberSdrPlugin/`, method for method.

```sh
./build.sh --apk                     # build the UI, stage it, assemble a debug APK
./build.sh --install                 # ...and install it on the attached device
./build.sh --install=192.168.1.50    # ...on a phone over Wi-Fi
./build.sh --release                 # a release APK and .aab (signed — see below)

./build-mac.sh --check               # is the Mac able to build the iOS app at all?
./build-mac.sh --test                # prove the whole iOS chain on a throwaway app
./build-mac.sh --run --shot=x.png    # build, run in a simulator, screenshot it back
```

`build.sh` is Android and runs anywhere. `build-mac.sh` is iOS and runs *here*,
compiling over SSH on a Mac — see [The iOS half](#the-ios-half).

Two kinds of APK, and the difference matters more than "debug" usually implies:
a debug build is signed with the local debug key, is `debuggable`, and its
WebViews answer `chrome://inspect`; a release build is signed with your own key
and is none of those things. **Android will not install one over the other** —
it identifies an app by its signature — so switching kinds means uninstalling
first, which erases that install's saved receivers, shared settings and saved
passwords. `--install` says so rather than leaving you with adb's
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

`--install=<address>` takes an IP (port 5555 unless you give one) or a serial
from `adb devices`, and connects first if it is an address. Wi-Fi is worth
preferring: over USB the phone re-enumerates every time the screen locks, and
each new device node needs its udev permissions again. Enable it once over a
cable with `adb tcpip 5555`.

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
| `ReceiverActivity.java` | the receiver's WebView, its document-start script, and the middle of every conversation with the page |
| `PlaybackService.java` | the foreground service, the notification and the lock-screen session |
| `Notices.java` | the page's own notifications, in the shade |
| `SystemBars.java` | keeping the page out from under the status and navigation bars |

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

## Links: `ubersdr://connect?uuid=…`

A receiver, named in a link, from anywhere the phone can follow one — a QR code
beside a radio, a message, an instance's own page:

```
ubersdr://connect?uuid=4907ba0a-32e6-40bb-a4ca-47f823331728
```

The UUID is the public one: the `id` on the instance's `/api/instances` entry at
the directory, which is the `public_uuid` it reports itself under
(`instance_reporter.go`). An address is deliberately not what a link carries,
because an address is the part that changes — a tunnel hostname, a dynamic IP, a
move from 8080 to 443 — and a link printed on a card next to an antenna should
survive all of that. The UUID does not change.

The scheme alone is registered (`AndroidManifest.xml`), not scheme + host, so
what a link asks for is `src/deeplink.js`'s to read and to refuse: a mistyped
link gets a sentence rather than Android quietly offering the browser instead,
and a second kind of link later is a change to one file.

Following one:

1. **The saved list first**, by UUID — `store.ensure` records it for anything
   that came from the directory. A receiver already used opens with no directory
   round trip, which is also what makes a link work on a phone whose mobile data
   has dropped but whose Wi-Fi still reaches the receiver.
2. **Then the directory**, if there is no saved entry or the saved address has
   stopped answering. `/api/instances/<uuid>`, falling back to filtering the
   full list for a collector that does not have that route yet. A saved receiver
   that has moved heals here, which is the case the UUID exists for.
3. **Then the ordinary connect** — the same probe, the same store entry, the
   same Activity as a row tapped in the directory tab.

So nothing about a link is trusted beyond being a UUID to look up, and the worst
a hostile one can do is open a public receiver somebody else chose, which is
what the directory tab is a list of.

`UberSdrPlugin.handleOnNewIntent` is where a followed link enters. Cold start and
warm start are one path — Capacitor delivers the launching Intent through the
same call — and the event is raised with `retainUntilConsumed`, so a link that
started the app waits in the plugin until `src/deeplink.js` is listening rather
than being missed while the page is still being parsed. A relaunch from the
recents list is the one Intent deliberately ignored (`FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`):
Android re-delivers the original VIEW intent when a task is resumed after its
process has gone, and following it would mean a receiver disconnected from
yesterday reconnecting itself today.

The banner it draws is the only piece of UI in this client that the chooser page
does not — built in the DOM by `deeplink.js` and styled in `mobile.css`, because
the chooser is staged unmodified and a deep link is an Android idea the desktop
client has no equivalent of. It exists mostly for the failure: when the receiver
never appears, nothing else in the app can explain why.

The desktop client follows the same links, through the same ladder — see
`clients/electron/deeplink.js`, which this file's counterpart is a port of. What
differs is only how the platform hands one over and where a failure is shown.

Where the links come from: the **Open in App** button on v2's start overlay
(`static/v2/src/lib/appLinks.js` builds the URI, `StartExtras.jsx` draws the
dialog). On a phone it follows the link straight away rather than opening a
dialog, and that is this app's way in: a receiver open in the phone's browser
hands itself over in one tap. The desktop dialog is for the desktop client and
offers its download — there is no QR code in it.

Testing one without a link to tap:

```sh
adb shell am start -a android.intent.action.VIEW \
    -d 'ubersdr://connect?uuid=4907ba0a-32e6-40bb-a4ca-47f823331728'
```

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

## Playing with the screen off

A WebView stops when the phone sleeps: the Activity stops being visible, the
process becomes cacheable, and Android freezes it — audio, spectrum and session
with it. `PlaybackService` is a foreground service of type `mediaPlayback`,
which is what says otherwise, and `FLAG_KEEP_SCREEN_ON` while a receiver is
running keeps the display from timing out under a waterfall you are watching
(the power button still locks the phone; the service carries on from there).

### The lock screen is v2's, not this client's

None of what the notification says is composed here. v2 already builds a media
session — the receiver as the title, frequency/mode/callsign as the artist, the
bookmark or spot with its callsign lookup as the album, the operator's photo as
the artwork — and installs handlers mapping next/previous to a tuning step or a
bookmark hop, and play/pause to mute.

In Chrome all of that reaches the OS by itself. A WebView is where it stops:
Chromium's media-notification integration is part of the *browser*, not the
engine, so `navigator.mediaSession` and `MediaMetadata` are simply absent.
`src/receiver.js` provides them, forwards what the page assigns, and sends the
lock screen's buttons back into the page's own handlers. The only control this
client adds is **Stop**, which leaves the receiver — with the screen off, the
notification is the only handle on the app.

The artwork is v2's too, including the part that makes it fill the card. Both
pictures that go there arrive the wrong shape for it, from opposite directions:
a receiver's logo is a launcher tile with a transparent margin and rounded
corners, and an operator's photo is very often a portrait. A media card is a
black backing, so either one handed over as it comes appears with black down
both sides. `static/v2/src/lib/cardArt.js` is where that is dealt with — a
nearly-square picture is cropped to fill, and anything meaningfully off square
is fitted whole over a blurred, zoomed copy of itself, so a portrait keeps the
top of its head. It looks right here and in a plain browser alike.
`PlaybackService.opaque` carries the transparency half of the same algorithm for
anything that still reaches the notification with an alpha channel; running both
is a no-op.

Two answers v2 works out from the browser are wrong for this host, so the host
says so with `window.ubersdrDesktop.mediaSession` (see
`static/v2/src/radio/media/support.js`):

- **on by default**, as it is on Apple and for the same reason: it is a phone
  and the lock screen is the point.
- **the `none` anchor.** Detection sees Android and picks `stream`, which moves
  audio off the WebSocket to the server's HTTP path — silencing the scope, the
  recorder and the client-side filters — purely so Chrome will raise a widget.
  This app raises its own, so that trade buys nothing here.

A third default moves with the same flag, in `lib/operatorPhoto.js`: the
operator's photo is off by default everywhere else, because a lookup's photo is
its largest fetch for the least it says and the map is a better use of a dock
column. A lock screen has no column and no map — the artwork slot is there
whatever happens, and the choice is the operator's face or the same receiver
logo every time — so where that slot exists the photo earns its fetch. The
toggle in the Callsign panel still wins, in both directions, and switching it
off sticks.

Nothing changes for any other device: absent the flag, every platform reaches
exactly the answer it did before, which `test/mediasession.test.js` and
`test/operatorphoto.test.js` both pin.

### Notifications

v2 raises browser notifications for what is worth knowing while you are not
looking — your callsign in the chat, voice activity, the rotator finishing, the
recorder out of disk. Android's WebView has no Notification API, so v2's feature
check said no and every one of them fell back to an in-page toast: a
notification you can only see if you are already looking at the page, on the
device most likely to be in a pocket.

`src/receiver.js` provides `window.Notification` and `Notices.java` puts what
the page raises into the shade, on its own channel. Tapping one opens the
receiver and fires the page's `onclick`, the page's tag replaces rather than
stacks, and `requestPermission()` is Android's runtime prompt. This needed no
change to v2 at all — its check is a plain feature test, and it simply starts
answering yes.

`POST_NOTIFICATIONS` is asked for at the two moments it is needed: when audio
starts, and when the page asks. Never at launch.

## What the phone gets that the desktop does not

- **The layout.** `static/v2` already has a phone layout — `LayoutContext.jsx`
  has a `phone` machine class with per-panel `mobile` first-run presets — plus
  haptics and sheet gestures. None of that needed doing here.
- **Backgrounding that already works.** `VisibilityWatch.jsx` drops the spectrum
  socket when the page is hidden and deliberately leaves the audio socket alone.

`mobile.css` is the chooser's phone pass, loaded after `chooser.css` and saying
only what a 430 px screen needs said differently: there is no hover, there is no
room above the first row, and 24 px of icon is not a thumb target.

### No chat, and why

Both hosts declare `chat: false`, and v2 does not draw the panel
(`panels/registry.jsx`, the same `requires` idiom the Doppler and NAVTEX panels
use). Absent means yes, so the browser and the desktop client are unchanged.

The rule that prompted it is Apple's Guideline 1.2 — an app carrying
user-generated content has to offer moderation, reporting and blocking for it —
and it was the iOS client's one deliberate difference for a while. It is not a
difference any more. Google Play's user-generated content policy asks for the
same things, and the reason neither client can offer them was never really about
which store it was shipping to: the chat belongs to whichever receiver the
operator has chosen, and neither app has any standing to moderate somebody
else's channel.

Said with the flag on both rather than by adding `chat` to each client's
`hidePanels` list, which would hide the same panel. Two clients withdrawing the
same thing for the same reason should do it by the same means, or the next
person to change it finds one and not the other.

## The iOS half

Everything above describes both platforms unless it names Android. This section
is what is different, and why.

`ios/UberSdrPlugin/` is this client's platform half in Swift, answering the same
eight methods `src/native.js` documents, and doing the same jobs behind them:
shared settings between receivers, the lock screen, notifications, spoken
announcements, keeping the display awake. The mapping is close to one-to-one:

| Android | iOS |
|---|---|
| `Http.java` | `Http.swift` — `URLSession` + per-receiver certificate trust |
| `Secrets.java` | `Secrets.swift` — the Keychain |
| `Mdns.java` | `Mdns.swift` — `NWBrowser` |
| `LocalProxy.java` | `LocalProxy.swift` — `NWListener` |
| `ReceiverActivity.java` | `ReceiverViewController.swift` |
| `PlaybackService.java` | `PlaybackSession.swift` + `HostChannel.swift` |
| `Notices.java`, `Speech.java` | `HostChannel.swift` |

`Mdns` is the one rewrite rather than a port. The Android version sends its own
DNS-SD query from an ephemeral port, which buys it freedom from `MulticastLock`
and NsdManager; none of that transfers, because a raw multicast socket on iOS
needs the `com.apple.developer.networking.multicast` entitlement, granted by
written application to Apple. `NWBrowser` needs no entitlement at all — only
honesty in `Info.plist` — so it is shorter *and* does more, since mDNSResponder
resolves the addresses too.

### Why the Swift lives in a pod

Adding a `.swift` to an Xcode target means hand-editing `project.pbxproj`, three
cross-referenced sections of it, with invented 24-hex object IDs. A pod globs
its sources instead: a new file needs `pod install` and nothing else. That is
what makes this client's Swift writable on a machine with no Xcode, which is the
machine it is written on. `Main.storyboard` names `MainViewController` and its
module, which is a two-attribute edit to XML rather than an Xcode session.

### Three traps, none of which the compiler catches

- **`registerPluginType` is a silent no-op.** Its first line is
  `if autoRegisterPlugins { return }`, and auto-registration is on by default —
  it is what registers the npm plugins. So the plugin appears to load and every
  call answers *"UberSdr plugin is not implemented on ios"*.
  `registerPluginInstance` has no such guard and composes with the generated
  list instead of replacing it. See `MainViewController.swift`.
- **A default port in the URL breaks name-based virtual hosts.** `URLSession`
  derives the `Host` header from the URL, so an explicit `:443` sends
  `Host: example.org:443`, which the directory answers with a 404. curl and
  Java's `HttpURLConnection` both omit it, which is why the Android half never
  met this. See `Http.swift`.
- **`[weak self]` on a splice callback truncates the body.** Nothing holds a
  `StreamReader` once the closure that created it returns, so the reader is
  deallocated mid-transfer and the next receive callback finds nothing to
  resume — silently, with no error and no EOF, leaving the page waiting on a
  `Content-Length` that will never be satisfied. It scales with response size,
  so small JSON worked and an 87 kB script did not, which is a confusing way to
  be told. The strong capture *is* the intended lifetime: it breaks when the
  last callback returns without re-arming. See `LocalProxy.swift`.

The loopback origin is a secure context — verified on device rather than
assumed, `window.isSecureContext === true` — so the page keeps `AudioWorklet`,
`enumerateDevices` and the recorder exactly as it does on Android.

### App Transport Security

`NSAllowsArbitraryLoads`, with the justification written into `Info.plist`
beside it: this app connects to receivers at addresses its operator types in or
picks from a directory, many on home networks over plain HTTP or behind a
self-signed certificate, and none of them can be enumerated in advance. That is
the case App Review asks for. Certificate checking is not abandoned with it —
`Http.swift` evaluates every chain and accepts a bad one only where the operator
has said so for that one receiver, and the receiver's page is reached over
loopback rather than over any of this.

### Building from a machine that is not a Mac

`build-mac.sh` compiles on a Mac over SSH and brings the result back. It exists
because `cap add ios` and `cap sync ios` run perfectly well on Linux — an Xcode
project is text and PNGs — and only two steps need macOS. Its header documents
what the Mac needs; `--check` tests for all of it and says how to fix what is
missing. Two traps worth knowing before you meet them:

- **The iOS platform is a separate download from Xcode.**
  `xcodebuild -showsdks` will list "iOS 26.5" while every build fails with
  *"Supported platforms for the buildables in the current scheme is empty"*.
  `--check` therefore asks `simctl list runtimes` rather than trusting the SDK
  list. Fix: `xcodebuild -downloadPlatform iOS`.
- **Installing Homebrew moves the active developer directory** to the Command
  Line Tools, which breaks `xcodebuild` for everything on that machine. Every
  command here works around it with `DEVELOPER_DIR`; the real fix needs
  `sudo xcode-select -s /Applications/Xcode.app`.

`--test` builds, runs and screenshots a throwaway Capacitor app, so "is the Mac
still able to build?" is one command and never a guess.

### Driving it without a finger

`simctl` has no tap, and `simctl openurl` reaches the app only through
SpringBoard's "Open in …?" alert, which nothing can answer headlessly. So a
DEBUG-only launch environment variable takes the same URL a link would:

```sh
SIMCTL_CHILD_UBERSDR_OPEN='ubersdr://connect?uuid=…' \
    xcrun simctl launch booted org.ubersdr.mobile
```

It is the same path a real link takes — `deeplink.js` cannot tell the difference
— so what it exercises is the real one. A release build has no way to be told
where to connect at launch.

## Not done yet

Named rather than left to be discovered. Where a gap is on one platform only,
it says so.

- **iOS: everything that needs a device.** Background audio is the one real
  design risk left. iOS suspends a WKWebView's *content process* when the app
  backgrounds, and v2 decodes audio in JavaScript off a WebSocket, so an audio
  session alone may not be enough where Android's foreground service is. The way
  out is v2's own `/audio/stream` (`media/httpStream.js`, `audio_http_stream.go`)
  — a real media resource, which iOS keeps playing, and which the server routes
  to *instead of* the WebSocket rather than in addition. A simulator cannot
  answer this: it does not model process suspension. Bonjour discovery,
  notification delivery and the lock-screen transport want a device for the same
  reason.
- **iOS: signing.** Simulator builds need none. A device build or an App Store
  archive needs an Apple ID in Xcode, and Play-style key questions have an Apple
  equivalent — see the bundle section below for the Android one.
- **Menus.** No Links menu and no Layout menu, and neither is wanted: a phone
  has no menu bar, and the Layout menu's job is done by the phone layout.
- **A caution for anyone touching the WebView lifecycle.** Do not call
  `WebView.onPause()` or `pauseTimers()`. The audio gate runs on a 20 ms
  `setInterval` (`GATE_TICK_MS` in `static/v2/src/radio/audio-player.js`) and
  Chromium throttles hidden-page timers to about once a minute, which makes the
  squelch behave strangely in the background even while audio keeps flowing.
- **Popups.** The v1 windows (callsign lookup, map, CW graph) open with
  `window.open`. Android's WebView does not handle these yet; the iOS view loads
  them in place, which is the smallest thing that works rather than the right
  one.
- **Upstream connection pooling.** `LocalProxy` opens a connection per request
  and relays with `Connection: close`, on both platforms. The cost is a TLS
  handshake per request against a remote instance on first load; the benefit is
  that the response body needs no interpretation, so SSE and chunked encoding
  pass through as bytes. The iOS version takes this further and has one path for
  requests and websocket upgrades alike: after the head is rewritten, both are
  bytes nobody interprets.

## Packaging and publishing

This section is Android. iOS distribution is not set up: `build-mac.sh` builds
for the simulator, and an archive for TestFlight or the App Store needs an Apple
ID in Xcode and a signing identity, of which that Mac currently has none.

```sh
./build.sh --release    # dist/UberSDR.apk and dist/UberSDR.aab
./build.sh --publish    # ...and upload the APK to the `latest` GitHub release
```

Two artefacts, because the two places this goes take different ones. A release
builds both every time rather than putting the bundle behind a flag: they share
everything up to packaging, so the second costs a few seconds, and the day it
would have been forgotten is the day of a Play upload.

Only the APK is published. An `.aab` is not installable — it is a container
Play's servers split into per-device APKs — so a release page offering one is
offering a sideloader a file that cannot be opened.

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

Or nothing at all. With no `UBERSDR_KEYSTORE` set, `build.sh` looks for
`~/keys/ubersdr-release.jks` and, beside it, `~/keys/ubersdr-release.password` —
the whole file is the password, trailing newline ignored. Found, they are used;
not found, the build is unsigned exactly as before. So the release machine needs
no environment at all, and the environment still wins where it is set, which is
what CI does.

```
~/keys/
├── ubersdr-release.jks         # the keystore
└── ubersdr-release.password    # its password, and nothing else
```

`UBERSDR_KEYS_DIR` moves that directory if `~/keys` is not where yours lives.
The password is read from a file rather than exported into the shell because an
environment variable is readable from every child process's `/proc` entry and
ends up in a shell history sooner or later.

`build.sh` prints what it found before it starts — including which of the two
places the keystore came from — because discovering afterwards that there were
no credentials is discovering it too late.

**Keep the keystore.** Android identifies an app by its signature: an APK signed
with a different key cannot be installed over one already on a device — it has
to be uninstalled first, taking its saved receivers with it. Losing the file
means everybody in the field reinstalling by hand.

### The bundle, and the one decision it forces

Play has not accepted an APK for a new app since 2021. What it wants is the
`.aab`, which `--release` now produces; what it does with it is generate a
per-device APK and **sign that itself**.

That is the part worth deciding before the first upload rather than after. Under
Play App Signing the keystore above becomes the *upload* key, and a separate app
signing key signs what users actually install — so a Play install and the APK on
the GitHub release would carry different signatures, and neither could update
over the other. In this app that is not a cosmetic difference: replacing one
with the other means uninstalling, which erases that install's saved receivers,
shared settings and saved passwords.

Uploading `ubersdr-release.jks` as the app signing key when the listing is first
created is what keeps the two interchangeable. It is a one-time choice and
cannot be changed afterwards.

For this app the split delivery a bundle exists for buys close to nothing. There
is no `lib/` — it is Java and a WebView, no NDK — so there is no ABI to split
on, there are no translations, and the only per-density resources are the
launcher icons. The weight is `classes.dex` and the staged `www/`, both of which
every device gets either way. The bundle is a Play entry requirement here, not
an optimisation.

Sideloading remains the distribution route for everyone not coming through Play.

## Files

Everything under `src/` is shared: the same file runs on both platforms.

```
build.sh      Android: builds v2, stages it and the chooser, syncs, assembles,
              publishes
build-mac.sh  iOS: ships the tree to a Mac over SSH, pods, builds, runs in a
              simulator and brings screenshots back. --check and --test first.
capacitor.config.json
mobile.css    the chooser's phone pass, loaded after chooser.css
src/api.js    window.ubersdr — the surface clients/electron/preload.js defines
src/store.js  saved instances, over Preferences (port of electron's store.js)
src/discovery.js
              directory, LAN and manual addresses (port of electron's)
src/useragent.js
              how this client names itself; owns the token the WebView appends
src/native.js the plugin handle
src/deeplink.js
              ubersdr://connect?uuid=… — parsing, resolving and the banner
src/main.js   the entry point: assigns window.ubersdr before chooser.js runs
src/receiver.js
              what runs inside a receiver page, bundled with the v2 page API's
              client library — this client's answer to a preload, on both
              platforms. Also provides the media session, Notification and
              Web Speech APIs neither WebView has.
www/          staged: the chooser, Leaflet, app.js and the v2 bundle (generated)
android/      the Capacitor project, plus the Java plugin above
ios/          the Xcode project (generated by `cap add ios`), and:
ios/UberSdrPlugin/
              this client's platform half in Swift, as a local pod so that a new
              file is a `pod install` rather than a project.pbxproj edit:
                Http.swift            one GET, and certificate classification
                Secrets.swift         the bypass password, in the Keychain
                Mdns.swift            _ubersdr._tcp over NWBrowser
                LocalProxy.swift      the receiver's loopback proxy
                ReceiverViewController.swift
                                      the receiver's WebView and its preload
                HostChannel.swift     the lock screen, notifications, speech and
                                      the shared-settings snapshot
                PlaybackSession.swift the audio session that survives the lock
                MainViewController.swift
                                      where the plugin is registered
PRIVACY.html  the store privacy policy, written to serve both stores
ubersdr-play-icon-512.png, ubersdr-appstore-icon-1024.png
              the store listing icons: full-bleed and opaque, because both
              stores round the corners themselves and Apple rejects an alpha
              channel. Generated from clients/electron/assets/icon.png, which
              stays the one source for the launcher icon too.
screenshots/  tablet store screenshots, captured from emulators with
              `adb exec-out screencap`
```
