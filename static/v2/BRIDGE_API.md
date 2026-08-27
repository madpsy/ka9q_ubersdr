# UberSDR v2 page API

How a browser extension, a userscript, or anything else running in an UberSDR v2
page reads the receiver and drives it.

Implementation: `src/bridge/` — `protocol.js` (wire format), `host.js` (serving),
`commands.js` (the command set), `snapshots.js` (topic shapes), `client.js` (the
client library), `BridgeHost.jsx` (the wiring). Tests: `test/bridge.test.js`,
`test/bridgecommands.test.js`, `test/bridgeclient.test.js`. Those tests are the
specification — if one has to change, the change is a breaking one.

- Protocol (envelope) version: **1**
- API version: **1.7**

---

## 1. Transport

Two `CustomEvent`s on `window`, one per direction, with the message as a **JSON
string** in `detail`:

| Event | Direction |
|---|---|
| `ubersdr.to-page` | client → page |
| `ubersdr.from-page` | page → client |

A string rather than an object, deliberately: page→content `detail` is
structured-cloned in Chrome and Xray-wrapped in Firefox and the two differ in
what survives. A string is identical on both, so one content script serves both
browsers **and needs no MAIN-world injection**.

`window.postMessage` is not used: it is forgeable by any frame and does not
reliably cross MV3's world boundary.

There is no authentication, by design. Anything already running in the page is
same-origin and could drive the receiver directly. The boundary is the origin,
and CustomEvents do not cross it. No password is ever exposed.

## 2. Envelope

```jsonc
{
  "v": 1,                 // protocol version — ignore messages whose v you don't know
  "from": "client",       // or "page"
  "client": "abc123",     // client-chosen id; echoed on anything addressed to it
  "id": 7,                // client-assigned; correlates a result to a request
  "type": "command"
}
```

**Every client message carries an `id`, including `hello`**, so every message has
exactly one reply and nothing waits on something that was never coming.

A message that fails envelope validation (wrong `v`, no `client`, no `id`, not
`from: "client"`) is dropped silently — it is not ours. An *unknown type* is
answered with an `unknown_type` error, because the sender is addressable and
waiting.

## 3. Handshake

Either side may start first:

- The page broadcasts `announce` when it mounts and whenever the descriptor
  changes.
- A client sends `hello` whenever it likes; the page replies with an `announce`
  addressed to it.

A content script sends one `hello` at `document_idle` and then listens. On a
page that is not UberSDR nothing ever arrives — no polling, no timers, one idle
listener. Register the tab on `announce`, not on `hello`.

Treat **every** `announce` as *reset and re-subscribe*: it means the page has
(re)started and anything you knew about its state is from a previous life. The
client library clears its cache for you.

`closing` is broadcast on `pagehide`.

## 4. Messages

### Client → page

| Type | Fields | Reply |
|---|---|---|
| `hello` | — | `announce` (addressed) |
| `bye` | — | `result` `{attached}` |
| `subscribe` | `topics[]`, `minIntervalMs?` | `result` — a full snapshot of each topic |
| `unsubscribe` | `topics[]` | `result` `{subscribed[]}` |
| `get` | `topic?` (`"*"` or omitted = all live topics) | `result` — the topic, or a map of them |
| `command` | `name`, `args` | `result` — see §6 |
| `run` | `fn`, `event?` (default `{kind:"trigger"}`) | `result` `{dispatched: fn}` |

### Page → client

| Type | Fields |
|---|---|
| `announce` | the descriptor, flattened into the envelope (§5) |
| `state` | `client`, `topic`, `patch` — **addressed**, and only the changed fields |
| `result` | `id`, `client`, `ok`, and `value` or `error {code, message}` |
| `closing` | `client?` — broadcast when the page goes away or the bridge is switched off; addressed when that one client has been let go |

`state` is addressed rather than broadcast because patches are computed per
subscriber, against what *that* client was last sent and at the rate *it* asked
for. Merging one client's delta into another's picture would invent a state
neither of them has.

## 5. The descriptor

```jsonc
{
  "v": 1, "from": "page", "type": "announce",
  "app": "ubersdr",
  "ui": "v2",
  "api": { "major": 1, "minor": 0 },
  "receiver": {
    "id": "<public_uuid>",      // stable across sessions and reloads
    "name": "…", "callsign": "…", "location": "…",
    "url": "https://…",         // the operator's public URL
    "serverVersion": "…"
  },
  "session": { … },             // the `session` topic (§6)
  "page": { "url": "…", "title": "…" },
  "capabilities": ["tune","mode",…,"functions","rotator","antenna"],
  "topics": ["tuning","audio","signal","spectrum","session","page","vfos","modes","bands","functions"],
  "commands": ["tune","mode","passband","volume","mute","duck","squelch","vfo","spectrum","power","lock"]
}
```

**Identify a receiver by `receiver.id`** (the server's `public_uuid`) — it
survives reloads and new sessions. `session.id` identifies one sitting. They
answer different questions; a tab list wants the first.

**Feature-detect on `capabilities`, never on version numbers.** Check `v` and
`api.major` for compatibility and nothing else. `api.minor` rises when something
is added; `capabilities` says what.

## 6. Topics

Live topics can be subscribed to and are pushed as patches. Static topics are
reference data — `get` only, since they change only when the page reloads.

Every topic has a **fixed shape**: the same keys every time, `null` for a
missing value, never an absent key. That is what makes patch merging safe.

### `tuning`
```jsonc
{ "frequency": 14074000, "mode": "usb", "bandwidthLow": 50, "bandwidthHigh": 2700,
  "vfo": "A", "band": "20m", "locked": false,
  "minFrequency": 10000, "maxFrequency": 30000000 }
```

`locked` *(since 1.7)* is the tuning lock — the padlock above the waterfall. With
it on, the first four fields stop responding, to this bridge as much as to the
page: `tune`, `mode` and `passband` still succeed as messages and move nothing.
Watch it, or a client whose commands are being quietly ignored has no way to say
why. Everything else — volume, squelch, DSP, the spectrum view — is unaffected.

### `audio`
```jsonc
{ "volume": 0.7, "muted": false, "ducked": false, "channel": "both", "bufferSec": 0.2,
  "squelch": { "value": 6, "enabled": true, "threshold": 6, "open": true } }
```
`muted` is the operator's setting; `ducked` is transient silence applied by
something else (a transmitting rig, an extension speaking over the audio).
They are separate so a client showing a mute button shows the *mute*.
`squelch.open` is live — whether the gate is passing audio right now.

`squelch.value` is a threshold in **dB of SNR**, running from −10 (the floor,
which means off) to 46. It used to run 24–80 against the pre-version-3 S/N0
figure in dB·Hz; a client with a hard-coded threshold from then is roughly 34 dB
too high and will hold the gate shut. `threshold` is the same number, or absent
when the squelch is off.

### `signal`
```jsonc
{ "dbfs": -73, "noise": -83.4, "snr": 10.4, "s": 9, "level": 0.432, "clipping": false }
```
`s` is the S-meter reading **the page itself is showing**, so a client's meter
agrees with the one on screen instead of re-deriving it from dBFS with a
different curve. Values are rounded at the source (0.1 dB); a reading that does
not exist is `null`, never a very negative number.

`dbfs` and `noise` are both powers over the demodulator passband, so `snr` is
their difference in dB: below 0 the channel is empty, 3–10 dB is weak but
readable speech, 20 dB and up is armchair copy. Before protocol version 3
`noise` carried radiod's noise *density* N0 in dBFS/Hz, which made `snr` about
34 dB higher on a 2.65 kHz filter and different again on every other filter
width — a client with thresholds set against the old numbers needs them redone.

This topic changes continuously. It is rate limited to **10 messages a second
per client** by default; ask for less with `minIntervalMs`. A patch held back by
the limit is *held, not dropped* — the true final value always arrives.

### `spectrum`
```jsonc
{ "centerFreq": 14100000, "span": 204800, "binBandwidth": 100, "binCount": 2048, "follow": true }
```

### `vfos` *(since 1.5)*
```jsonc
{ "active": "B",
  "slots": [{ "id": "A", "active": false, "frequency": 7100000, "mode": "lsb",
              "bandwidthLow": -2700, "bandwidthHigh": -50 }] }
```
All four, always, in order, so a client can lay out four rows without counting.
A slot never used is present with `null` values rather than absent.

`tuning` carries the *active* VFO, which is what nearly everything wants. This
carries the other three as well, and exists because there was previously no way
to see them: switching to a VFO to read it really retunes the receiver, which is
audible and rude on a receiver other people are listening to.

The active slot is reported from live tuning, not from its stored copy — the
page deliberately leaves that copy stale while a VFO is selected, writing it only
when you switch away, so reading it would give wherever the dial was when that
VFO was last left.

### `markers` *(since 1.6)*
```jsonc
{ "at":   { "frequency": 14074000, "mode": "usb", "name": "FT8", "callsign": "",
            "type": "bookmark", "countryCode": "" },
  "prev": { … }, "next": { … },
  "count": 412 }
```
What is on the dial and what is nearest either side, merged from the operator's
server bookmarks, their *local* bookmarks and the spot feeds — the same merge and
the same search the marker bar and the Markers panel use, so a client sees what
the operator sees rather than a second opinion assembled from the same parts.
Any of the three is `null` when nothing matches.

The local bookmarks are the reason this exists: they live only in the page, so no
amount of calling the API could reconstruct this.

### `spots` *(since 1.6)*
```jsonc
{ "dx": [{ "frequency": 14025000, "mode": "cw", "callsign": "VK9XX",
           "spotter": "G4ABC", "comment": "up 2", "countryCode": "XR",
           "grid": "", "snr": null, "at": 1750000000000 }],
  "cw": [ … ], "digital": [ … ] }
```
Capped at the most recent 100 per feed. `grid` is the spotted station's Maidenhead
locator, `""` when it is not known — a cluster spot never carries one, a digital
spot usually does, and a CW spot does only where the skimmer runs with QRZ lookup on.

**Acquired only while something is subscribed.** The receiver sends nothing until
a stream is asked for, so the page holds these feeds only while a client is
subscribed to `spots` or `markers`, and drops them when the last one goes. A bare
`get` returns whatever happens to be held, which may be nothing — subscribe if
you want them.

### `session`
```jsonc
{ "id": "…", "receiverId": "…", "running": true, "maxSec": 0, "idleSec": 300, "startedAt": 0 }
```
`running` is v2's "audio is playing" — what the old extension read off an
overlay's CSS class as `audioStarted`.

### `page`
```jsonc
{ "url": "https://…/v2/", "title": "M9PSY UberSDR - 14.074 MHz USB" }
```
The title is derived from the tuning, so do not watch the document title —
subscribe to `tuning` and compose your own label from `receiver` + `tuning`.

### `layout` *(since 1.1)*
```jsonc
{ "panels": [{ "id": "spaceweather", "title": "Space weather",
               "placement": "right", "hidden": false, "unhideable": false }],
  "docks":  [{ "id": "left", "collapsed": false }] }
```
Every registered panel, not only the ones on screen — a client offering to bring
a panel back has to be able to name one that is currently hidden. `placement` is
one of `left`, `right`, `bottom`, `float`. `title` is there because the ids are
internal: show the title, address the id.

`unhideable` marks the Layout panel, which is what unhides the others; the
`panel` command refuses to hide it, so do not offer it.

### `radiocontrol` *(since 1.2)*
```jsonc
{ "transport": "flrig", "connect": true,
  "direction": "sdr-to-radio", "syncFrequency": true, "syncMode": true,
  "muteOnTx": true, "config": { "host": "127.0.0.1", "port": 12345 } }
```
What the Radio Control panel is asking a transport to do. `transport` is
`serial` (the page's own Web Serial + Hamlib link) or the id of a provider you
registered; `config` carries the values typed into **that** transport's fields
and nothing else. Watch this topic, act when `transport` is yours and `connect`
is true, and stop when it is not.

### `modes` (static)
```jsonc
[{ "id": "usb", "label": "USB", "group": "voice",
   "default": { "low": 50, "high": 2700 },
   "limits": { "min": 0, "max": 6000, "sideband": "upper" } }]
```
Build mode lists from this, not from a hardcoded copy. Note `cwu`/`cwl` are
`sideband: "both"` — CW is symmetric about the carrier despite the name.

### `bands` (static)
```jsonc
[{ "name": "20m", "min": 14000000, "max": 14350000 }]
```

### `functions` (static)
```jsonc
[{ "id": "freq_step_up", "label": "Step up", "group": "Frequency",
   "encoder": false, "repeat": true, "needs": null }]
```

## 7. Commands

Precise, typed, and stable. Each returns the state it just set, so you do not
need a follow-up `get`.

One rule governs bad input:

- **Absolute values are refused** (`bad_args`) when they are impossible — a
  frequency outside the receiver's range, a volume above 1, a passband wider than
  the mode allows. The caller asked for somewhere that does not exist, and clamping
  would report success for a state the receiver is not in.

  The range is the receiver's own, not a fixed 10 kHz–30 MHz: it is derived from
  the front end sample rate, so a receiver running its RX888 at full speed reaches
  past 30 MHz. Read the real figures from `tuning_range` in `/api/description`
  (`min_frequency` / `max_frequency`) rather than assuming; a server that predates
  that field is 10 kHz–30 MHz. See `RECEIVER_SPAN.md`.
- **Relative movements stop at the edge** — `tune {delta}`, `volume {delta}` —
  because that is what turning the dial or the volume knob does, and what the
  receiver does with them anyway.

| Command | Arguments | Returns |
|---|---|---|
| `tune` | `{frequency}` \| `{delta}` \| `{step?, dir}`, plus optional `mode`, `bandwidthLow`+`bandwidthHigh`, `ensureVisible` | tuning |
| `mode` | `{mode}` — passband becomes the mode default | tuning |
| `passband` | `{low, high}` — checked against the mode in force | tuning |
| `panel` *(1.1)* | `{id, hidden?}` and/or `{id, placement?}` | layout |
| `surface` *(1.4)* | `{action: 'register', surface}` \| `{action: 'unregister', id}` \| `{action: 'status', id, …}` | the surface, or its status |
| `audio` *(1.4)* | `{action: 'start', id}` \| `{action: 'stop'}` | `{streaming}` — and a MessagePort, see below |
| `radio` *(1.2)* | `{action: 'register', provider}` \| `{action: 'unregister', id}` \| `{action: 'status', id, …}` \| `{action: 'configure', id, …}` *(1.3)* | the provider, its status, or the settings |
| `volume` | `{volume}` \| `{delta}` — 0..1 | `{volume, muted}` |
| `mute` | `{muted}` (absolute) \| `{toggle:true}` | `{muted}` |
| `duck` | `{ducked}` — silence that is **not** the user's mute | `{ducked}` |
| `squelch` | `{value}` \| `{enabled:false}` \| `{auto:true}` | `{value, enabled, threshold?}` |
| `vfo` | `{id:"A"…"D"}` \| `{step:±1}` | `{vfo, …tuning}` |
| `spectrum` | `{center}`, `{span}`, `{center,span}`, `{zoom:±n, about?}`, `{centerOnTuned:true}`, `{reset:true}` | spectrum |
| `power` | `{on:false}` | `{running:false}` |
| `lock` *(1.7)* | `{locked}` (absolute) \| `{toggle:true}` | `{locked}` |

Notes that matter:

- **`mute` is absolute.** PTT is driven by "the rig is transmitting:
  true/false"; a toggle desynchronises permanently the first time a message is
  missed, and un-mutes on every transmit thereafter. `toggle` exists for a
  button that genuinely means "the other one".
- **Use `duck`, not `mute`, for anything transient.** `mute` is the operator's
  own setting — it is what the page's mute button shows and what this browser
  remembers. `duck` silences the audio without touching it, so a transmission
  that ended badly cannot leave the receiver muted for good, and a client
  showing a mute button is never made to lie. Both are reported in the `audio`
  topic, separately.
- **`tune` carries mode and passband in one call.** Sending them separately
  walks the receiver through intermediate mode/passband pairs, which is audible.
- **`spectrum` with `center` and `span` together** is one call for the same
  reason: separately, the span closes around wherever the view had got to.
- **`power {on:true}` is refused** with `unsupported`: browsers require a user
  gesture to start audio. Watch `session.running` instead.
- **`lock` is absolute**, for the reason `mute` is: a controller with a lock
  switch on it is reporting a position, and a toggle desynchronises permanently
  the first time a message is missed. `toggle` exists for a button that means
  "the other one". Either way the operator is told on screen — a receiver that
  stopped tuning because something out of sight locked it is indistinguishable
  from a broken one. Read the current state from `tuning.locked`.

### `run` — the rest of the receiver

`run` dispatches into the *mappable function catalogue* — the same list MIDI,
FlexControl and the keyboard shortcuts are mapped to — by id:

```jsonc
{ "type": "run", "fn": "freq_step_up", "event": { "kind": "trigger" } }
{ "type": "run", "fn": "volume",       "event": { "kind": "absolute", "value": 0.5 } }
{ "type": "run", "fn": "freq_enc_1k",  "event": { "kind": "relative", "delta": -3 } }
```

Get the list from `get {topic:"functions"}`. Anything added to that catalogue
later — including the rotator and antenna functions, which keep the operator's
password on the page side — becomes reachable with **no protocol change**. The
curated commands are the contract; this is the extension point.

### Providing a radio-control transport *(since 1.2)*

A page can drive a transceiver over Web Serial, and that is all it can do: it
cannot open a socket to flrig or rigctld, and their servers send no CORS headers
even if it could. An extension or a desktop shell has neither limit, so it can
offer one — the Radio Control panel lists it beside **Serial**.

Register a description, not code. The panel renders the fields, remembers what
was typed against your id, and publishes the result on `radiocontrol`:

```js
await client.command('radio', { action: 'register', provider: {
    id: 'flrig',
    label: 'FLRig',
    fields: [
        { key: 'host', label: 'Host', type: 'text',   default: '127.0.0.1' },
        { key: 'port', label: 'Port', type: 'number', default: 12345 },
    ],
    capabilities: ['frequency', 'mode', 'ptt'],
} });
```

`type` is `text`, `number` or `password`; anything else renders as text. Up to
eight fields. `capabilities` says what you can keep in step — leave `ptt` out and
the panel stops offering "mute while the radio transmits", rather than showing a
switch that does nothing.

Then report what the rig is doing, as often as you learn it:

```js
client.command('radio', { action: 'status', id: 'flrig',
    connected: true, frequency: 14074000, mode: 'USB', tx: false, error: null });
```

Status merges, so a poll that only learned a frequency need only send that. Set
`error` to say why a connection failed; the panel shows it and clears it when
you send `null`.

If your transport is also configurable somewhere else — an extension popup, a
desktop preferences window — write the settings back when they change there, so
the panel and your own UI do not disagree about the address they are using:

```js
client.command('radio', { action: 'configure', id: 'flrig',
    config: { host: '10.0.0.9', port: 12399 },   // only fields you declared
    direction: 'radio-to-sdr', connect: true,
    select: true });                             // also make it the chosen transport
```

`config` accepts only the field keys you registered; anything else is dropped,
since the panel cannot show a field it was never told about. `connect`,
`direction`, `syncFrequency`, `syncMode` and `muteOnTx` are the shared settings
you may set. `select` is separate and explicit on purpose: telling the panel an
address answers a question the operator asked, while switching the panel to your
transport takes the choice off them — so it only happens when you say so.

Do **not** send this in response to a `radiocontrol` patch. That would be
telling the page what it just told you; the page drops an identical write, but a
loop that terminates only by luck is not one worth having.

**Re-register on every `announce`.** A reload empties the page's registry, and a
transport that registered once would silently vanish. Unregister on the way out
(`{action: 'unregister', id}`) so a stale option does not linger.

Doing the actual syncing is yours: subscribe to `tuning` and push the dial to
the rig, or read the rig and `tune` the receiver — and use `duck`, not `mute`,
for transmit muting, so the operator's own mute is left alone.

### Being a control surface *(since 1.4)*

`radio` is a transport this page drives a rig through. `surface` is the other
direction: a way something else drives *this* receiver — a desktop client
standing up a TCI server so JTDX connects to it and retunes you. Both are things
a page cannot be on its own, and both are registered as a description rather
than as code:

```js
await client.command('surface', { action: 'register', surface: {
    id: 'tci',
    label: 'TCI',
    description: 'Be a TCI radio for JTDX and friends.',
    audio: true,                                   // it needs the sound too
    fields: [{ key: 'port', label: 'Port', type: 'number', default: 40001 }],
} });
```

It then appears in the SDR Control panel beside FlexControl and MIDI, and what
the operator chooses arrives on the `sdrcontrol` topic. Report what yours is
doing with `{action: 'status', id, running, clients, error}`.

Surfaces are **mutually exclusive**, as the built-in two already are: more than
one thing mapped to frequency fight each other.

### Audio *(since 1.4)*

Everything else here is control — a few bytes, rarely, as JSON on a CustomEvent.
Audio is 48 kHz of float32, which through that channel would be half a megabyte
a second of base64 through `JSON.parse`. So `audio` does not carry audio. It
asks the page to open a `MessageChannel` and hand one end over:

```js
window.addEventListener('message', (e) => {
    if (!e.data || !e.data['ubersdr.audio-port']) return;
    const port = e.ports[0];
    port.onmessage = ({ data }) => {
        // data.pcm    ArrayBuffer, float32 interleaved L,R,L,R
        // data.frames sample pairs
        // data.sampleRate
    };
    port.start();
});
await client.command('audio', { action: 'start', id: 'tci' });
```

`{action: 'stop'}` ends it, as does asking for a new one — there is a single
stream.

Buffers are cloned rather than transferred, deliberately: the far end of the
port may be in another process. Electron's main process, for one, deserialises a
*transferred* `ArrayBuffer` as `null` while an ordinary cloned one arrives
intact — so the port works wherever it is passed on to, at the cost of a copy of
a few kilobytes every 37 ms.

Two things to know about what comes out of it:

**It is taken ahead of volume, mute and ducking.** A client feeding a decoder is
not listening to this room, and must keep receiving while the operator has the
speakers silenced or a transmitting rig has ducked them. Muting the receiver
does not mute this.

**The sample rate is the receiver's, not 48 kHz.** It follows the mode — 12000
for SSB, for instance — and is on every message, so read it rather than assume.
A client that needs a fixed rate has to resample.

### `spectrumdata` — the frames themselves *(since 1.6)*

The `spectrum` topic says where the view is pointed. It has never carried a
single bin, so nothing outside the page could draw a scope, a waterfall or a
picture of a band. This hands over a copy of the frames the page is already
receiving, the same way `audio` does:

```js
window.addEventListener('message', (e) => {
    if (!e.data || !e.data['ubersdr.spectrum-port']) return;
    const port = e.ports[0];
    port.onmessage = ({ data }) => {
        // data.bins        ArrayBuffer of float32, one per bin
        // data.binCount    how many
        // data.centerFreq  the middle of the span, in Hz
        // data.timestamp   the receiver's own
    };
    port.start();
});
await client.command('spectrumdata', { action: 'start', id: 'scope', everyNth: 4 });
```

**The bins are in ascending frequency order** — the halves are already swapped,
so this is not the raw FFT order the receiver sends. Span and bin width come from
the `spectrum` topic; each frame carries its own `centerFreq` because the
operator can pan between frames.

**`everyNth` drops frames at the source.** The receiver sends far faster than a
chart wants, and a client that needs one frame in twenty should say so rather
than receive twenty and discard nineteen.

One stream, as with audio: asking again replaces it, `{action:'stop'}` ends it.

### `notice` — say something the operator will see *(since 1.6)*

A client can put anything it likes in its own window, and a custom panel in its
own frame, but neither reaches an operator who is looking at something else.

```js
await client.command('notice', {
    title: 'FT8 opening', body: '20m to VK', severity: 'good', key: 'band-open-20m',
});
```

`severity` is `info` (default), `good`, `warn` or `bad`. `key` collapses repeats:
the same key arriving again is counted on the existing notice rather than
stacking another one up.

It goes through the operator's own notification settings — where notices appear,
how long they stay, and whether they are switched off at all are theirs, under
"Panels and extensions". So it may legitimately show nothing and answer
`{ shown: false }`. That is not an error and must not be retried.

## 8. Errors

```jsonc
{ "type": "result", "id": 7, "client": "abc", "ok": false,
  "error": { "code": "bad_args", "message": "frequency 70000000 is outside 10000–60000000" } }
```

| Code | Meaning |
|---|---|
| `unknown_type` | no such message type |
| `unsupported` | known, not available here (or no such command) |
| `bad_args` | malformed or out of range |
| `disabled` | the operator has switched the bridge off |
| `failed` | it threw; `message` says what |

These are the codes the page actually sends — the enum carries nothing it does
not emit. Treat an unrecognised code as a failure anyway: adding one is an
additive change and costs only a minor version.

A **command** never silently does nothing: anything that escapes becomes
`failed` with its message rather than being swallowed.

**`run` is different, and deliberately so.** It reports `{dispatched: fn}` — the
function was invoked, not that it achieved anything. The catalogue's functions
are fire-and-forget because a knob has no reply path, so (for example) a rotator
function on a receiver with no stored password logs to the SDR Control panel and
returns like any other. If you need a real answer, use a command.

At most **8 clients** may attach at once. A ninth does not get refused — the
stalest registration is dropped and told (an addressed `closing`), because
client ids are per-injection: an extension reloaded a few times during
development leaves dead registrations behind, and refusing the newcomer would
lock out the live client. A client that said hello and never subscribed is
dropped before one that is subscribed.

## 9. When the bridge is off

The operator can switch it off (SDR Control panel → *Browser bridge*). A
disabled page answers every message with `disabled` rather than going silent, so
a client can say "switched off on this receiver" instead of looking broken. No
announce is broadcast and no state is pushed while it is off.

While anything is attached, an **API** badge appears above the spectrum.

## 10. Using it

### In the page (userscript, console)

`window.UberSDR` is a client of the same channel — not a shortcut past it — so
it behaves identically to an extension.

```js
await UberSDR.hello();                          // → descriptor
await UberSDR.subscribe(['tuning', 'signal'], { minIntervalMs: 250 });
UberSDR.on('signal', (s) => console.log(s.s, s.snr));
await UberSDR.command('tune', { frequency: 14074000, mode: 'usb' });
await UberSDR.run('freq_step_up');
UberSDR.state('tuning');                        // merged from patches
```

### From an extension content script

`src/bridge/client.js` is the reference implementation and can be copied
verbatim into an extension — it depends only on `protocol.js`. A content script
is then that client plus the plumbing to its own background page:

```js
const client = createClient(window);
client.on('announce', (d) => chrome.runtime.sendMessage({ type: 'ubersdr:register', d }));
client.on('tuning',   (s) => chrome.runtime.sendMessage({ type: 'ubersdr:state', s }));
client.hello().catch(() => { /* not an UberSDR page — stop here */ });
```

No MAIN-world script, no `window.radioAPI`, no polling probe, and the same file
works in Chrome and Firefox.

**If your client starts before the page does** — a content script at
`document_start`, or an Electron preload — do not gate on the reply to `hello`.
At that point there is nothing mounted to answer, so `hello` times out against a
page that is merely still loading, and a client that subscribes only in its
`.then()` never subscribes at all. Subscribe from `announce` instead, which the
host sends when it mounts and whenever the descriptor changes:

```js
client.on('announce', () => client.subscribe(['tuning']));
client.hello().catch(() => { /* may simply not be up yet; the announce will come */ });
```

That is the same handler that already has to exist for a reload — an announce
means *reset and re-subscribe* — so this costs nothing and removes the race.

## 11. Versioning rules

| Change | What moves |
|---|---|
| New command, topic, capability or catalogue function | `api.minor`, and `capabilities` grows |
| Changed meaning, removed capability | `api.major` |
| Changed envelope or event names | `v` |

Clients: check `v` and `api.major`; feature-detect everything else on
`capabilities`. Never branch on `api.minor`.
