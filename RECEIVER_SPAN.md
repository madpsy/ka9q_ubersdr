# Receiver span: making 0–30 MHz a derived value

## Why

The receiver's frequency range is currently the literal `30000000`, repeated ~35 times
in Go and ~15 times in the v2 frontend. Running the RX888 at its full 129.6 Msps instead
of 64.8 Msps roughly doubles the usable range, and there is no single place to change.

This document defines one source of truth for the span, the arithmetic that derives every
dependent number from it, and every site that has to stop hardcoding.

**The change is a no-op until `samprate` in the radiod config changes.** Every default
below reproduces today's 0–30 MHz geometry exactly, including the same `29296.875 Hz`
per bin. That is the acceptance test.

---

## 1. Where the number comes from

### 1.1 radiod is the authority

`ka9q-radio` derives the usable RF range in `src/rx888.c`:

```c
static double const NYQUIST = 0.47;   // line 50

frontend->frequency = frontend->samprate * sdr->undersample / 2;   // line 349
if(sdr->undersample & 1){
  frontend->min_IF = 15000;                                        // line 352
  frontend->max_IF = NYQUIST * samprate;                           // line 353
} else {
  frontend->min_IF = -NYQUIST * samprate;
  frontend->max_IF = -15000;
}
```

At the current 64.8 Msps that gives `max_IF = 0.47 × 64,800,000 = 30,456,000` — which is
where our 30 MHz came from. At 129.6 Msps it becomes **60,912,000**, so the ceiling is
~60.9 MHz, not the 64 MHz the RX888 datasheet quotes.

### 1.2 radiod reports it directly — do not duplicate `NYQUIST`

`src/radio_status.c:737-738` encodes the front end's own limits into **every** status
packet:

```c
encode_float(&bp,FE_LOW_EDGE,frontend->min_IF);
encode_float(&bp,FE_HIGH_EDGE,frontend->max_IF);
...
encode_double(&bp,FIRST_LO_FREQUENCY,frontend->frequency);   // line 743
```

Tag numbers, computed from the `enum status_type` in `src/status.h` and cross-checked
against every tag `radiod_status.go` already decodes (`INPUT_SAMPRATE=10`,
`FE_ISREAL=102`, `AD_OVER=104`, `SAMPLES_SINCE_OVER=108`, `PLL_WRAPS=109`,
`RF_LEVEL_CAL=110` — all match):

| Tag | Number | Type | Meaning |
|---|---|---|---|
| `INPUT_SAMPRATE` | 10 | int | front end sample rate, Hz |
| `FIRST_LO_FREQUENCY` | 34 | double | `frontend->frequency` (LO / Nyquist-zone base) |
| `FE_LOW_EDGE` | **100** | float | `frontend->min_IF` |
| `FE_HIGH_EDGE` | **101** | float | `frontend->max_IF` |
| `FE_ISREAL` | 102 | bool | real vs complex sampling *(already decoded)* |

So the usable RF range is reported, not inferred:

```
lo = FIRST_LO_FREQUENCY + min(FE_LOW_EDGE, FE_HIGH_EDGE)
hi = FIRST_LO_FREQUENCY + max(FE_LOW_EDGE, FE_HIGH_EDGE)
```

`min`/`max` rather than the tags as named, because for even `undersample` (inverted
Nyquist zones) both edges are negative and the order flips.

### 1.3 But it is not available early enough

`FE_*` tags ride on per-channel status packets. Startup order in `main.go` is:

| Line | Step |
|---|---|
| 479 | `LoadConfig` — **the span must be known here** |
| 706 | `NewRadiodController` (status listener starts) |
| 765 | `NewSessionManager` |
| 863–868 | `NewNoiseFloorMonitor` + `Start()` — creates the first channel |

With no channel open there are no status packets, so the live values cannot be used to
size the geometry that creates the first channel. Hence the layered resolution below.

---

## 2. Resolution order

Resolved **once**, at config load, and then frozen. Two steps, because there is only one
input:

1. **The radiod `.conf`** — `[rx888] samprate`, read from `RadiodConfPath`. This is the
   file the admin monitor already reads and parses; `parseRadiodConf` in `admin.go` is
   reused verbatim. `[global] samprate` is the *audio output* rate and is deliberately not
   mistaken for it, even though the key has the same name.
2. **Built-in fallback** — `64_800_000`, reproducing today's behaviour byte-for-byte when
   the file cannot be read (Docker, non-standard layout, dev machines). There is no error
   path: a receiver that boots at 30 MHz beats one that does not boot.

Once the wideband channel exists, the live status is used to **verify, not to
re-derive**. `sessions.WidebandSSRC()` in `session.go` already yields the SSRC and
`GetFrontendStatus` the payload.

> **Frozen on purpose.** The span sizes the noise-floor FFT buffers, the spectrogram
> archives, and every connected client's view. Silently re-geometrying all of that
> mid-flight because a status packet disagreed would be far worse than a loud warning.
> A mismatch logs and raises an admin health issue; it does not mutate anything.

---

## 3. The arithmetic

Given `Fs` (front end sample rate, Hz):

```
usableTopHz = 0.47 × Fs                       // NYQUIST, only for paths 1 & 2 above
spanHz      = floor(usableTopHz / 1e6) × 1e6  // largest whole MHz that fits
centerHz    = spanHz / 2
```

| `Fs` | `usableTopHz` | `spanHz` | `centerHz` |
|---|---|---|---|
| 64,800,000 *(today)* | 30,456,000 | **30,000,000** | 15,000,000 |
| 129,600,000 | 60,912,000 | **60,000,000** | 30,000,000 |

Rounding down to a whole MHz is what makes the rule reproduce today's value exactly, and
it leaves 456 kHz / 912 kHz of headroom below the anti-alias rolloff rather than riding
its edge.

### 3.1 Spectrum bin geometry

```
binCount     = snap(round(1024 × spanHz / 30e6), {512, 1024, 2048})
binBandwidth = spanHz / binCount
```

| `spanHz` | `binCount` | `binBandwidth` |
|---|---|---|
| 30,000,000 | 1024 | **29296.875** |
| 60,000,000 | 2048 | **29296.875** |

Doubling the span and the bin count cancel exactly, so **full-zoom-out resolution is
unchanged**. This matters more than it looks:

- `zoomLadder()` (`zoomLadder` in `static/v2/src/lib/zoom.js`) keeps precisely the same rung values
  and merely gains one at the wide end, so `spectrumBinBandwidth` values already in
  visitors' `localStorage` still land on real rungs.
- The `BIN_BW_PASSTHROUGH = 7500` branch in `user_spectrum_websocket.go` still
  catches the full-span value without a new case.
- `binCount` stays inside the `{512, 1024, 2048}` set `LoadConfig` snaps to.

`spanHz / binCount` is exact in float64 for any integer span, because `binCount` is a
power of two.

### 3.2 Noise-floor wideband channel

Hold the resolution rather than the bin count:

```
nfBins = nextPow2(ceil(spanHz / 7324.21875))
nfBinBandwidth = spanHz / nfBins
```

| `spanHz` | `nfBins` | `nfBinBandwidth` |
|---|---|---|
| 30,000,000 | 4096 | **7324.21875** |
| 60,000,000 | 8192 | **7324.21875** |

### 3.3 Tuning limits

```
minFrequency = 10000       // unchanged
maxFrequency = spanHz
```

> **Known discrepancy, deliberately not changed.** radiod reports `min_IF = 15000`, so
> the bottom 5 kHz of our advertised range is already outside what the front end claims.
> That is true today and is not part of this change. Tightening it would break existing
> VLF users for no gain here.

---

## 4. Config surface: none

**`samprate` in the radiod config is the only knob, and there is no `config.yaml` key for
any of this.** Not for the span, not for the limits, not for the bin geometry, and not for
where the radiod config lives — that path is the constant `RadiodConfPath`, shared with the
three places in `admin.go` that already read the same file for the admin monitor.

The reason is the one that motivated the whole exercise: the span is a property of the
hardware, and a second place to state it is a second place for it to be wrong. An operator
who wants 0–60 MHz edits `samprate` and restarts radiod; nothing else.

```ini
# /etc/ka9q-radio/radiod@ubersdr.conf — the only place this is set
[rx888]
samprate = 129600000
```

`RadiodConfig` is unchanged (`status_group`, `data_group`, `interface`), and
`TestReceiverHasNoConfigYAMLInfluence` asserts its field count so that adding a span key
later has to be a deliberate act that breaks a test, rather than quiet drift back to two
sources of truth.

Everything else — span, centre, bin count, bin bandwidth, tuning limits, the noise-floor
wideband geometry, what `/api/description` publishes, what the v2 shell inlines — is
computed from that one number.

## 5. Server changes

### 5.1 New file: `receiver_span.go`

Holds `NYQUIST`, `resolveReceiver(config) ReceiverConfig`, the whole-MHz rounding, the bin
arithmetic from §3, and `verifyReceiverAgainstFrontend(rc, status)` for the live
cross-check. Unit-tested against the two rows of every table above.

`ReceiverConfig` is read through accessors — `MinFreq()`, `MaxFreq()`, `Span()`,
`Centre()`, `Samprate()` — never through the fields. They are the Go half of the same
fallback contract §8 states for the frontend: a zero-valued `ReceiverConfig` means
10 kHz–30 MHz. That is not only defensiveness. Tests and tools build `Config` literals
directly instead of going through `LoadConfig`, and a zero struct read straight off the
field would clamp every frequency to nothing.

It is wired into the admin health panel: `admin_monitor_health.go` adds a
"Receiver span" entry when the check disagrees, alongside the existing
"Frontend (SDR)" one, using the wideband channel's SSRC. A healthy receiver shows nothing.

`verifyReceiverAgainstFrontend` checks only the **top** of the range. The bottom is
policy, not derivation: the RX888 reports `min_IF = 15000` and we advertise 10 kHz
deliberately (§3.3), so flagging it would put a standing warning on every healthy
receiver.

### 5.2 Derived defaults — `config.go`

All inside `LoadConfig`, which calls `resolveReceiver` before anything that depends on it:

| Was | Is |
|---|---|
| `CenterFrequency = 15000000` | `= config.Receiver.Centre()` |
| `BinBandwidth = 30000000.0 / binCount` | `= float64(Receiver.Span()) / float64(binCount)` |
| bin-count snap, fixed default 1024 | `defaultSpectrumBinCount(Receiver.Span())`, per §3.1 |
| `maxHFFreq = 30000000` gain-range check | `validateFrequencyGainRanges(config.Receiver.MaxFreq())` |

### 5.3 Tuning and centre clamps

Every local `const maxFreq uint64 = 30000000` is replaced by `Receiver.MaxFreq()`, and
every `const minFreq = 10000` by `Receiver.MinFreq()`.

| File | Where |
|---|---|
| `websocket.go` | connect-time frequency validation; the `tune` message handler |
| `user_spectrum_websocket.go` | `zoom`/`pan` centre validation |
| `session.go` | `CreateSpectrumSession` centre fallback; `UpdateSpectrumSession` validation and its `clampCenter`; the two audio-session frequency floors |
| `admin.go` | bookmark add / bulk import / update; `validateAndClampBandFrequencies`; SDR# band import |
| `chat_websocket.go` | `UpdateUserStatus` frequency validation |
| `main.go` | bookmark `?center=/?width=` filter; operator `default_frequency`; the `sdrs` status profile |
| `cwskimmer.go` | `processLine` spot filter |
| `dxcluster.go` | `processLine` spot filter |
| `audio_extensions/freedv/extension.go` | `maxFreqHz()` |

`session.go`'s `clampCenter` matters more than it looks: it has to agree with the client's
`clampCenter` in `lib/zoom.js`, or a client that corrects an out-of-band view and a server
that permits one push it back and forth between them.

Both spot filters previously *dropped* spots above 30 MHz silently; they now compare
against a `maxFrequency` passed in at construction.

`validateAndClampBandFrequencies` gained a `ReceiverConfig` parameter rather than reading
a global, so its three callers pass `ah.config.Receiver`.

### 5.4 Wideband spectrum channel

`noise_floor.go` repeated `4096` / `7324.21875` / `15000000` three times — the FFT buffer,
the radiod channel, and the `BandSpectrum` record. All three now come from one
`widebandGeometry(config.Receiver.Span())` call plus `Receiver.Centre()`.

`wideBandSSECenterHz` in `noise_floor_spectrum_sse.go` is deleted outright — the centre is
`config.Receiver.Centre()` — and the `/api` wideband payload in `main.go` reads the same
geometry.

Every other consumer of the wideband FFT is already safe, because `BandFFT` carries its
own `StartFreq` / `EndFreq` / `BinWidth`: `noise_analysis.go`, the `/api` and MCP handlers
and the MQTT publisher all compute bin indices from `BinWidth` rather than assuming 4096
bins of 7324.21875 Hz. Only their comments said 30 MHz, and those are corrected.

### 5.5 Spectrogram

`NewSpectrogramRecorder` takes the span and bin count from the noise-floor monitor's own
wideband geometry, so the recorder always matches the channel it reads.

### 5.5b Data-source filters

`GetActiveEntries` in `eibi.go` dropped every schedule entry above 30 MHz before turning
the rest into bookmarks. It now takes `maxFreqHz` (`config.Receiver.MaxFreq()`), so a
wider receiver sees the entries it can actually tune. `0` still means the old shortwave
range, for a caller that does not know the receiver.

The `cwskimmer.go` and `dxcluster.go` spot filters are the same shape and are covered in
§5.3.

### 5.6 Two metrics that must NOT follow the span

`snr_0_30_mhz` and `snr_1_8_30_mhz` are pinned to fixed 0–30 MHz and 1.8–30 MHz ranges by
`widebandSNRBands`, on every receiver.

They used to be computed as `calculateDynamicRangeFromFFT(widebandFFT.Data)` and
`...Data[startBin:]` — the whole buffer, and everything above 1.8 MHz. Both would have
silently widened with the receiver. They are:

- SQLite columns, charted as a time series
- Home Assistant sensors named literally `"SNR 0-30 MHz"` and `"SNR 1.8-30 MHz"`
- the KiwiSDR emulation's `sa` / `sh` stats, which a Kiwi client reads as HF figures

Letting them widen would redefine a metric mid-series: every history would show a step
change on the day the sample rate was raised, with the column name, the JSON field and the
sensor label all still saying 30. A receiver that reaches further gets more spectrum; it
does not get a different meaning for these two.

The wideband **spectrogram** is the opposite case and is left to follow the receiver: its
`wideband-hf` crop exists to exclude the AM broadcast band at the *bottom*, and its caption
is drawn from the server's `band_ranges`, so it re-labels itself correctly.

---

## 6. API contract

### 6.1 One builder, five publishers

`ReceiverConfig.TuningRange()` produces the object, and **every** publisher of the
receiver's range goes through it:

| Publisher | Where |
|---|---|
| `/api/description` | `handleDescription` in `main.go` |
| the v2 shell's inlined `window.__UBERSDR__` | `v2TuningRangeJSON` in `v2_meta.go` |
| instance reporter — periodic | `sendReport` |
| instance reporter — test | `sendReportWithParams` |
| instance reporter — startup | `SendStartupReport` |

These are the same facts, and five hand-rolled copies of the same map is how a field ends
up present in one, stale in another and missing from the third.
`TestTuningRangeIsOneShape` asserts the field set and count across them, so adding a sixth
by hand fails a test rather than silently drifting.

The builder reads through the accessors, so a `ReceiverConfig` that never went through
`resolveReceiver` publishes today's numbers rather than a row of zeroes a consumer would
read as "no range". `Source()` reports `"fallback"` rather than an empty string in that
case, for the same reason.

### 6.2 `/api/description`

The `tuning_range` object is named that way because `receiver` is already the station
identity block (name, callsign, GPS) in the same payload:

```json
"tuning_range": {
  "min_frequency": 10000,
  "max_frequency": 30000000,
  "spectrum_span_hz": 30000000,
  "spectrum_center_hz": 15000000,
  "input_samprate": 64800000,
  "samprate_source": "radiod-conf"
}
```

This is what the bridge API, the admin UI, and third-party tooling read.

### 6.3 The v2 shell — why `/api/description` alone is not enough

v2 reads `MAX_FREQ` **synchronously at module scope**, and `/api/description` is fetched
asynchronously at `RadioContext.jsx:691`. Four sites lose that race:

- **`RadioContext.jsx:76`** — `initialTuning()` runs in a `useMemo` on first render and
  clamps both the `?freq=` share link and the restored `localStorage` frequency to
  `MAX_FREQ`. It is *lossy*: a 50.313 MHz link becomes 30 MHz and the real value is gone
  before the fetch answers.
- **`FreqEntry.jsx:24`** — `const RANGE_HINT = ...` is evaluated at import time. An async
  value never reaches it at all.
- **`bridge/commands.js:138`** — validates incoming bridge commands; `BridgeHost.jsx:501`
  already documents that commands can arrive before `/api/description` lands.
- **`RadioContext.jsx:699`** — the guard on the operator's `default_frequency` sits
  *inside* the `/api/description` handler, so it would be validating against a limit
  carried by the very reply it is reading.

So the limits are also inlined into the shell, which `handleV2IndexPage` in `main.go`
already renders as a Go template from the live config pointer — hot-update via the admin
config tab keeps working:

```go
data := struct {
	Meta           V2PageMeta
	CustomHeadHTML template.HTML
	CustomBodyHTML template.HTML
	Receiver       template.JS   // new
}{ ... }
```

```html
<script>window.__UBERSDR__ = {{.Receiver}};</script>
```

placed above `<script src="dist/v2.js"></script>` in `static/v2/index.html`. No CSP
concern: the only `Content-Security-Policy` in the tree is on the panels sandbox
(`panels_api.go`), and the shell already injects raw `CustomHeadHTML`.

---

## 7. v2 changes

### 7.1 `radio/constants.js` — the whole point

```js
const L = (typeof window !== 'undefined' && window.__UBERSDR__) || {};

export const MIN_FREQ = L.min_frequency > 0 ? L.min_frequency : 10000;
export const MAX_FREQ = L.max_frequency > 0 ? L.max_frequency : 30000000;
```

`MAX_FREQ` stays a plain module constant — **only its value changes, not its shape**. All
~15 consumers (`RadioContext.jsx` ×5, `SpectrumView.jsx`, `MultipadPanel.jsx`,
`bridge/commands.js` ×3, `zoom.js`, `format.js`, `FrequencyDial.jsx`, `FreqEntry.jsx`,
`IFSpectrumPanel.jsx`, `RadioControlPanel.jsx`) are untouched. The async alternative
would have forced `MAX_FREQ` into React context and rewritten every one of them.

### 7.2 The three deliberate duplicates

`lib/ifSpectrum.js` (`FULL_SPAN_HZ`), `lib/chatFollow.js` (`MAX_HZ`), and
`radio/spectrum-connection.js` (`fullSpanBinBandwidth`) each hold their own copy. `chatFollow.js` says why:

> repeated rather than imported because this module is pure arithmetic and is tested on
> its own

**They must not start reading `window`.** That is exactly the testability those comments
are defending. Take the span as a parameter, keeping the literal as the documented
default:

```js
export function followView(user, binCount, maxHz = 30e6) { ... }
```

`fullSpanBinBandwidth` already prefers `defaultBinBandwidth` from the server; its last-line
fallback now uses the inlined span instead of a literal 30 MHz.

### 7.2b The one that only bit at the call site

`extensions/freedv/reporter.js` has `isTunable(user, minHz = 10000, maxHz = 30000000)` —
correct as a pure function, but `FreeDVExtension.jsx` called it as `isTunable(user)` in two
places, so every default applied. On a 60 MHz receiver a 6 m FreeDV spot would have been
greyed out as "outside the SDR range" and refused a click. Both call sites now pass
`MIN_FREQ, MAX_FREQ`.

Worth stating as a rule: **a defaulted parameter is only safe if the callers pass it.**
Parameterising the pure modules is the right shape, but it moves the obligation to the
call site rather than removing it.

### 7.3 Copy

`lib/spectrogram.js:76-77`, `panels/SpectrogramPanel.jsx:7`, `BandSpectrumPanel.jsx:10`,
`BandStatsPanel.jsx:4,47`, `BandsPanel.jsx:2`, `styles.css:645,10654`,
`components/FreqEntry.jsx:12`, `lib/mentions.js:71` all say "30 MHz" in prose. Derive
where rendered, reword where it is a comment.

`extensions/qrss/dsp.js:426` notes the 6 m entry was removed *because* of the 30 MHz
limit — it comes back once the span allows it.

---

## 8. Fallback behaviour — the hard requirement

**If `window.__UBERSDR__` is absent, or `/api/description` has no `tuning_range` object, the
UI must behave exactly as it does today: 10 kHz – 30 MHz.**

This is not defensive padding; it is the compatibility contract. A v2 bundle is cached in
visitors' browsers and served from CDNs, so a new bundle *will* run against an old server
and vice versa. Both directions must degrade to today's numbers rather than to `NaN`,
`0`, or `Infinity`.

Rules:

- Every read is `x > 0 ? x : <today's literal>` — never `??` or `||` alone, so that `0`,
  `null`, `""` and `undefined` all fall through to the literal.
- Never derive `MAX_FREQ` from a span that could be missing. `spectrum_span_hz` absent
  means 30 MHz, not "unbounded".
- The pure modules in §7.2 keep their literals as default parameter values.
- Server-side, `resolveReceiver` returns the 64.8 Msps fallback rather than an error when
  the radiod conf is unreadable — a receiver that boots at 30 MHz beats one that does not
  boot.

Tests to add:

| Test | Asserts |
|---|---|
| `constants.js` with `window.__UBERSDR__` undefined | `MIN_FREQ === 10000 && MAX_FREQ === 30000000` |
| ...with `{}` | same |
| ...with `{max_frequency: 0}` | same |
| ...with `{min_frequency: 10000, max_frequency: 60000000}` | 60 MHz |
| `resolveReceiver` with missing conf path | span 30 MHz, source `"fallback"` |
| `resolveReceiver` at 129.6 Msps | span 60 MHz, binCount 2048, binBW 29296.875 |
| `resolveReceiver` at 64.8 Msps | **identical to today's constants** |

---

## 9. Data migration

`persistToDisk` in `spectrogram_recorder.go` writes a header of magic / version / rowCount /
lastRowUnix / binCount only. **The frequency axis is implied by the recorder's current
`startFreqHz`/`endFreqHz`.** A bin-count change triggers "starting fresh"
(the version check in `loadFromDisk`), but a *span* change at the same bin count does not — so
every archived wideband row would be silently redrawn against the new axis.

Done: the header is version 2 and 40 bytes, carrying `startFreqHz`/`endFreqHz` after
`binCount`. A v1 file is discarded on load rather than reinterpreted — it has no axis to
check, so there is no way to know whether it describes the span now in force. A v2 file
whose range disagrees is discarded with the reason logged.

The cost is one day of wideband spectrogram history on first upgrade, which is the right
trade against a year of it plotted convincingly at the wrong frequencies.

---

## 10. The two emulations

### The KiwiSDR emulation stays pinned

`kiwiFullSpanHz` in `kiwi_waterfall.go` is fixed at 30 MHz, and must stay that way. Its
own comment explains why: the Kiwi client derives its entire frequency axis from the zoom
level, assuming exactly `30 MHz / 2^zoom`, and **there is no protocol field to tell it
otherwise**. Widen it and every signal appears at the wrong frequency, silently. A real
KiwiSDR is a 30 MHz device, so on a wider receiver this emulation serves its bottom
30 MHz and the rest lives in v2. Its 15 MHz spectrum centre needs no change either — a
30 MHz window centred there still fits inside a 60 MHz receiver.

### The WebSDR emulation does NOT — it follows the receiver

This one is the opposite case, and the difference is worth stating because the two look
alike from the server side. A WebSDR client builds its axis from `bandinfo[]`, which this
server generates: `websdr-base.js` computes `khzperpixel = bandinfo[band].samplerate/1024`
and reads `centerfreq` and `maxzoom` from the same place, with no ceiling of its own
(`1024 << a.maxzoom`, clamped to `a.maxzoom`). Telling it a wider band is all that is
needed, and the scale tiles are server-rendered PNGs that follow whatever we draw.

So it is derived. `websdrBandFor(rx)` in `websdr_scale.go` is the single description, used
by all six places that used to hold their own copy:

| Site | Was |
|---|---|
| `handleBandInfoJS` | `10000`–`30000000`, `centerKHz = 15005.0`, `maxZoom = 8` |
| `applyWaterparamCommand` | `bandStartHz`/`bandEndHz`/`maxZoom`/`maxZoomPixels` consts |
| `handleScalePNG` | `scaleBandStartKHz`/`scaleBandBWKHz`/`maxZoom` consts |
| `applyParamCommand` tune clamp | `10.0`–`30000.0` kHz |
| `websdrNormalizeFreq` | `bandStartKHz`/`bandBWKHz` consts |
| `/~~orgstatus` + `Description:` | `Band: 0 15005.000000 29990.000000`, `"0-30 MHz SDR"` |

`websdrNormalizeFreq` was a real bug in waiting: it places every user's marker on the band
display, so a fixed 29990 kHz denominator would have put them all at the wrong pixel.
`/~~orgstatus` and the description string are what websdr.org lists the receiver under, so
they now advertise its true coverage.

### The 500 Hz floor was a misreading, and it cost sharpness

The waterfall path held `minBinBWHz = 500`, commented as "radiod minimum bin bandwidth
(Hz)" with the note "empirically: 114 Hz fails". radiod's real floor is **0.5 Hz per bin**
— `radiodBinBandwidthLadder`, which the v2 spectrum path relies on daily.

What actually failed was asking for an *arbitrary* bandwidth. `bandBW / 2^z / 1024` is
never a round number, and `setup_narrowband` searches for an FFT length satisfying
`goodchoice(fft_n) && (fft_n*rbw) % samprate_base == 0` — a search that runs a very long
way up, or out, for a value like 114.44. This is the same trap the KiwiSDR waterfall
documents and already solved.

To stay under the floor the code halved `binCount` at each zoom beyond 5, so at full zoom
it drew **128 bins stretched across 1024 pixels** — eight times blockier than the display,
and zooming further stopped adding detail.

But the halving was not simply wrong, and removing it outright would have been a CPU
regression. radiod picks its algorithm from the requested bandwidth:

	rbw >  crossover (200 Hz)  ->  wideband,   fft_n = samprate / rbw
	rbw <= crossover           ->  narrowband, fft_n ~ bin_count + 400/rbw

`setup_wideband` takes `fft_n = lrint(samprate/rbw)` with **no ceiling** — its own comment
says *"should limit to a sane value"* and then doesn't. Above the crossover, halving the
bandwidth doubles the transform, and the bin count is the only lever, because
`bin_count × bin_bw` has to equal the span the client draws. Serving zoom 6 and 7 at full
width would have taken `fft_n` from 71k to 142k and 283k points.

So `websdrSpectrumParams` picks per regime rather than against a floor:

- **at or below the crossover** — full display width, bandwidth rounded up onto
  `radiodBinBandwidthLadder`, resampled onto the client's grid. This is what the old code
  could not reach.
- **above it** — halve the bin count until the wideband FFT fits `websdrMaxWidebandFFT`
  (2^17, exactly what a full-width zoom 5 already costs). The same trade as before, now
  made against radiod's real cost.

The result on a 30 MHz receiver:

| zoom | before | after |
|---|---|---|
| 0–5 | 1024 bins, fft_n ≤ 71k | **unchanged** |
| 6–7 | 512/256 bins @ 915 Hz, fft_n 71k | **unchanged** |
| 8 | 128 bins @ 915 Hz, fft_n 70 802 | **1024 bins @ 200 Hz, fft_n 1026** |
| 9–10 | did not exist | 1024 bins @ 100/50 Hz, fft_n ~1030 |

Zoom 8 gets eight times the sharpness for a sixty-ninth of radiod's work, and nothing
shallower costs a cycle more than it did.

The helpers are now shared rather than Kiwi-private —
`radiodBinBandwidthLadder`/`radiodRoundUpBinBW` and `resampleSpectrumOntoGrid` — because
they describe radiod, not an emulation.

The bin count only ever *decreases* from `wfWidth`, which starts at 1024 and is what the
channel was created with, so radiod's bin_count-change heap bug (see `kiwiSpectrumBins`)
cannot be triggered.

### Depth

With resolution no longer the constraint, the bound is `bandinfo.js`, which carries
`2^(MaxZoom+1)-1` scale-tile URLs and is served no-cache — so every level doubles what is
re-fetched per page load:

| MaxZoom | deepest span | tiles | bandinfo.js |
|---|---|---|---|
| 8 (was) | ~117 kHz | 511 | ~18 KB |
| **10 (now)** | **~29 kHz** | **2047** | **~72 KB** |
| 12 (cap) | ~7 kHz | 8191 | ~288 KB |

`websdrBaseMaxZoom` is 10 — four times the old depth for a page-weight cost that is still
small. Going deeper is a page-weight decision, not a signal-processing one.

`MaxZoom` still scales with the span (one more level per doubling, capped at
`websdrMaxZoomCap`) so a wider receiver does not quietly lose half its depth.

`TestWebSDRBandFollowsTheReceiver` pins today's band geometry (29 990 kHz wide, 15 005 kHz
centre) and the deepest-zoom width; `TestWebSDRWaterfallKeepsFullWidthAtEveryZoom` checks
the served bandwidth never under-covers the display at any zoom on either receiver; and
`TestWebSDRResampleCropsToTheDisplaySpan` checks a carrier stays at the centre through the
crop.

Also unchanged, and therefore stale above 30 MHz: v1 (`static/app.js`,
`spectrum-display.js`, `chat.js`, `channels-map.html`, `spectrogram.html`,
`noisefloor.js`) and `clients/{go,python,tui,rtl_sdr,electron,ubersdr-audio,
multi_instance,chrome-bridge,firefox-bridge}` — ~44 sites.

---

## 11. Rollout

1. ✅ **Done.** Everything above is landed with `samprate` still at 64.8 Msps, and the
   geometry is verified bit-identical by `TestReceiverGeometryUnchangedAt64_8Msps`:
   `binBandwidth == 29296.875`, `centerHz == 15000000`, wideband `4096 × 7324.21875`.
   Full Go suite (`-short`) and all 3211 v2 tests pass.
2. **Next, and before anything else.** Confirm the live cross-check agrees on the real
   receiver: the admin health panel now shows a "Receiver span" entry if radiod's
   `INPUT_SAMPRATE` or `FE_HIGH_EDGE` disagree with what was resolved from the `.conf`.
   A healthy receiver shows nothing there. **Do not trust the maths until it has been seen
   silent on real hardware**; `rx888.c:349` computes `frontend->frequency` as
   `samprate * undersample / 2`, which for the default `undersample = 1` gives
   32.4 MHz rather than the 0 its own comment claims. Whatever the live receiver actually
   reports is what the verification should be written against.
3. Only then: `samprate = 129600000` in `radiod@ubersdr.conf`, and raise `fft-threads`
   from 1 — the forward FFT goes from 1.62 M to 3.24 M points per 20 ms block and the USB
   stream to ~2.07 Gbps. Watch RX888 temperature; upstream defaults to half rate
   specifically because of thermal reports.

   Doing it through the admin config editor is fine, but **restart the server, not just
   radiod**. The span is resolved once at startup and frozen, so a radiod-only restart
   leaves the geometry describing the old receiver. The editor now detects a changed
   `samprate` and says so; the "Receiver span" health entry catches it if the message is
   missed.

   Budget for the doubled bin counts on a small box:

   | | 30 MHz | 60 MHz |
   |---|---|---|
   | spectrogram row buffer (resident) | 23.6 MB | 47.2 MB |
   | daily PNG render buffer (transient) | 23.6 MB | 47.2 MB |
   | daily PNG dimensions | 4096 × 1440 | 8192 × 1440 |
   | user spectrum bins | 1024 | 2048 |
   | noise-floor wideband bins | 4096 | 8192 |
4. Add 6 m to `config/bands.yaml.example` and the noise-floor defaults in `config.go`. 4 m at 70 MHz stays out of range even at 129.6 Msps.
