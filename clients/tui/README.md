# UberSDR Terminal Client

A spectrum, waterfall and audio receiver that runs entirely in a terminal, on
Linux, macOS and Windows.

It connects to the same `/ws/user-spectrum` endpoint as the web UI and the
other clients, so it needs no server-side changes.

```
 m9psy.tunnel.ubersdr.org ● live    span 205 kHz │ VFO 7.100000 MHz │ AUTO -119/-75 dB │ wheel zoom │ split │ 13 fps
    -75  █                                            │          ██                 █              █
    -86  █                     █▅                     │          ██                 ██             █
   -108  █ ▂▃▄▄▄▄▃▁           ▃██▁▂▂▂▁                │   ▁▃▅▆▇████▆▅▃▁         ▁▃▅▆██▆▅▄▂         █
   -119  ███████████████▇▆▆▇███████████████▇▅▄▄▅▆███████████████████████████████████████████████████
  -0.0s  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  -0.9s  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
         7.0000              7.0500                7.1000                7.1500               7.2000
 f tune · v view · a auto · w wheel · i receiver · ? help · q quit
```

## Why it is a separate module

This client is **pure Go**, audio included. That is what makes
`CGO_ENABLED=0` cross-compilation work, so binaries for ARM and every other
target build from any machine with no cross toolchain, sysroot or emulator. It
has its own `go.mod` to keep the CGO dependencies of the other clients out of
the graph.

Audio is the part where that took work, since the obvious libraries all need C:

- **Opus** decodes through `github.com/pion/opus`, a pure-Go implementation,
  rather than binding libopus as `clients/go` and `clients/ubersdr-audio` do.
  The server encodes with `AppVoIP` at 12 kHz, which selects SILK — the layer
  the pure-Go decoder implements. Opus always reconstructs at 48 kHz, so that
  is the playback rate regardless of the channel's own sample rate.
- **Playback on Linux** goes through `github.com/jfreymuth/pulse`, a pure-Go
  implementation of the PulseAudio wire protocol. ALSA and PortAudio bindings
  need a C toolchain per target; PipeWire speaks the same protocol, so this
  covers effectively every modern desktop Linux.
- **Playback on macOS and Windows** uses `oto`, which reaches CoreAudio and
  WASAPI through `purego`. oto needs CGO for ALSA on Linux, which is why Linux
  takes the PulseAudio path instead.

If the pure-Go Opus decoder ever meets a frame it cannot handle, the frame is
dropped rather than tearing down the stream; the server also offers `pcm-zstd`,
which needs no codec at all, as a fallback worth adding if that ever bites.

The terminal layer is [tcell](https://github.com/gdamore/tcell), a from-scratch
Go implementation of what ncurses does (including terminfo handling), so there
is no ncurses library to link either.

## Build

```bash
go build -o ubersdr-tui .
```

For release binaries across all platforms:

```bash
./build.sh                 # everything
./build.sh linux-arm64     # or just one target
```

That produces static, dependency-free binaries in `build/`:

| Target | Notes |
| --- | --- |
| `linux-amd64` | |
| `linux-arm64` | Raspberry Pi 4/5 (64-bit OS), Apple silicon Linux VMs |
| `linux-armv7` | Raspberry Pi 2/3, 32-bit OS |
| `linux-armv6` | Raspberry Pi 1 / Zero |
| `darwin-amd64`, `darwin-arm64` | |
| `windows-amd64`, `windows-arm64` | Windows Terminal recommended |

## Run

With no arguments it opens the receiver picker:

```bash
./ubersdr-tui
```

Or connect directly:

```bash
./ubersdr-tui -server localhost:8080
./ubersdr-tui -server https://m9psy.tunnel.ubersdr.org
./ubersdr-tui -server 192.168.1.50:8080 -freq 7100 -span 200 -view waterfall
```

### Flags

| Flag | Meaning |
| --- | --- |
| `-server` | `host:port` or a full `http(s)://` URL. Empty opens the picker. |
| `-tls` | Force TLS. Implied by an `https://` URL. |
| `-password` | Bypass password, if the receiver requires one. |
| `-freq` | Initial centre frequency in kHz (0 = server default). |
| `-span` | Initial span in kHz (0 = server default). |
| `-view` | `spectrum`, `waterfall` or `split` (default `split`). |
| `-bars` | Draw block bars instead of the higher-resolution braille spectrum. |
| `-no-audio` | Watch the spectrum without opening an audio channel. |
| `-version` | Print the version and exit. |

## Choosing a receiver

Press `i` at any time to open the picker and switch receivers without
restarting. It has three sources:

- **Public** — the directory at `instances.ubersdr.org`, sorted so receivers
  with free slots come first, then by best SNR.
- **Local** — receivers on your network, discovered via mDNS
  (`_ubersdr._tcp`), the same mechanism the Python and Go clients use.
- **Manual** — type a `host:port` or URL. A bare hostname assumes port 8080.

**Just start typing to search.** The list narrows on every keystroke, matching
callsign, name, location or address — no key needed to enter a search mode.
Because every printable key is search text, navigation is on the arrows and
paging keys: `↑` `↓`, `PgUp` `PgDn`, `Home` `End`. `Backspace` edits the search,
`Esc` clears it (and closes the picker when the search is already empty), and
`^U` clears it outright. `Tab` switches source.

## Keys

Two things move independently: the **VFO**, which is what the radio is tuned to,
and the **view**, which is what the display shows. They have separate keys.

| | |
| --- | --- |
| **Tuning — moves the radio** | |
| click | set the VFO |
| click a bookmark | tune to it, taking its mode and filter |
| `b` | browse and search the receiver's bookmarks |
| `f` | type a frequency |
| `c` | centre the view on the VFO |
| `↑` `↓` | tune up / down one step |
| `PgUp` `PgDn` | tune ten steps |
| `s` / `S` | cycle the tuning step (10 Hz … 10 kHz, default 500 Hz) |
| wheel | tune, when the wheel is in tune mode (`w`) |
| **View — moves the display** | |
| drag | pan |
| `←` `→` | pan, `shift`+`←` `→` for a fine step |
| **Zoom** | |
| wheel | zoom, in at the cursor and out from the centre |
| `w` | switch the wheel between zoom and tune |
| `+` `-` | zoom about the centre |
| `0` | reset to full span |
| **Display** | |
| `v` | cycle spectrum / waterfall / split |
| `<` `>` | resize the split |
| `B` | braille (2x resolution) or block bars |
| `p` | peak hold — marks the highest level each position has reached, decaying slowly |
| **Scaling — the dB window, not the audio filter** | |
| `a` | auto / manual |
| `[` `]` | lower / raise the noise floor |
| `{` `}` | lower / raise the ceiling |
| **Audio** | |
| `m` | mute / unmute |
| `M` | cycle demodulation mode |
| `A` | auto sideband either side of 10 MHz |
| `,` `.` | narrow / widen the audio filter |
| `x` | output channel: both / left / right |
| `g` | signal meter: dBFS or SNR |
| `n` | cycle server-side noise reduction |
| `t` / `T` | raise / lower the squelch threshold (SNR) |
| `d` | audio settings: device, volume, mode, exact filter edges |
| **Other** | |
| `i` | pick another receiver |
| `?` | help overlay |
| `q` | quit |

## Audio

Audio starts automatically and unmuted as soon as there is a frequency to tune
to — this is a receiver. `m` mutes and unmutes. If you only want the spectrum,
`-no-audio` skips opening an audio channel entirely, which also saves the server
a demodulator.

The audio stream is a **separate WebSocket sharing the spectrum session's
UUID**, so the server counts you as one user rather than two. It negotiates
Opus, the most compact format on offer, and the decoded passband is shaded
across both the spectrum and the waterfall so it is obvious what is being
demodulated — the shading is offset to one side of the marker for sideband
modes, and dims when muted.

Every change of mode, frequency or filter retunes in place — the server reuses
the same radiod channel, which is far cheaper than reconnecting. That includes
moving between a narrow mode (`usb`, `lsb`, `cwu`, `cwl`, 12 kHz channel) and a
wide one (`am`, `sam`, `fm`, `nfm`, 24 kHz): the server rebuilds its Opus
encoder when the channel's rate changes.

That last part needed a server fix. An encoder left configured for the old rate
reads 20 ms of 24 kHz audio as 40 ms and emits a 40 ms frame, which decodes to
twice as many samples and plays at half speed an octave low. No client can
recover from it, because an Opus frame's duration is carried in the bitstream —
decoding at a different rate changes the sample count but not the duration. If
you point this client at a receiver predating that fix, expect AM and FM to play
at half speed after switching from a sideband mode.

The packet header carries the channel's sample rate and channel count. Neither
affects the playback rate — Opus always reconstructs at 48 kHz — but the channel
count decides whether a frame is folded to mono, and both are shown in the `d`
panel.

**Modes and default filters**, matching the web UI so a frequency sounds the
same in both:

| Mode | Filter | Limit |
| --- | --- | --- |
| `usb` | +50 … +2700 Hz | ±6 kHz |
| `lsb` | −2700 … −50 Hz | ±6 kHz |
| `cwu`, `cwl` | ±200 Hz | ±6 kHz |
| `am`, `sam` | ±5000 Hz | ±12 kHz |
| `nfm` | ±5000 Hz | ±12 kHz |
| `fm` | ±8000 Hz | ±12 kHz |

The limit is each mode's Nyquist frequency: the narrow modes run on a 12 kHz
channel and the wide ones on 24 kHz, so asking USB for ±12 kHz would be
imaginary bandwidth. With auto sideband on (the default), tuning across
10 MHz flips between LSB and USB following amateur convention, carrying your
filter width across rather than resetting it. Picking AM or CW is treated as
deliberate and is never overridden.

**Filter**: `,` and `.` move the outer edge — the one that carries the audio
bandwidth in every mode — in 100 Hz steps. `d` opens a panel for setting each
edge exactly, in 50 Hz steps.

**Signal meter**: a coloured bar at the right-hand end of the status row, red
through green. **Click it, or press `g`,** to switch between absolute level and
signal-to-noise.
Both come straight from the audio packet header — baseband power and noise
density — and the scales match `signal-meter.js` so a reading means the same
here as in a browser: dBFS runs −127 … −33 (the S-meter's own span, S1 at −115
with 6 dB per S-unit), and SNR runs 30 … 60, which is where this measurement
actually sits on a live channel.

**Server-side DSP**: `n` cycles the noise-reduction inserts the receiver
offers, starting from off, which is the default. The status bar always carries
`n NR:` with the current state — the active filter in uppercase (`NR2`, `DFNR`),
`off` when the receiver offers DSP but none is selected, or `n/a` when it offers
none at all. Those are
three different things. It is the first hint kept when the bar runs short of
width, since nothing else shows what the DSP is doing. The available filters come
from the `dsp` block of `/api/description` — a receiver that offers none says
so rather than showing a dead control. The `d` panel has the same control on
its own row, listing what is on offer.

The server is authoritative here: it may refuse an insert when the DSP is at
its user limit, so the display follows the `dsp_status` message it sends back
rather than assuming the request succeeded. The chosen insert is re-applied
after a reconnect, since each new session starts with none.

Parameters for each filter are not exposed; the web UI is the place for that.

**Squelch** gates the audio on signal-to-noise. `t` and `T` move the threshold
a decibel at a time, as does the `d` panel. It defaults to off.

The range is 20–80 dB, and stepping below 20 turns the gate off rather than
leaving a threshold that could never fire: this SNR — baseband power over noise
density — does not approach zero on a live channel, and the meter's own scale
starts at 30. Off is sent as the server's `-999` sentinel rather than as `0`,
since 0 dB is itself a valid threshold.

The status bar shows `t SQ:` with the threshold and a **▼** while the gate is
actually closed, so it is obvious when silence is the squelch rather than a dead
band. That indicator reads the audio itself: the server substitutes silence
rather than dropping packets when gated, which is more reliable than
reimplementing its hang timer and hysteresis client-side. A frame counts as
silent below a small amplitude threshold, not at exactly zero — the PCM is
zeroed *before* Opus encoding and the codec is lossy, so a gated frame decodes
to near-silence.

**Output**: `d` lists output devices and lets you pick one, set volume, and
route audio to both channels, left only, or right only (`x` cycles that
directly). Left/right routing is handy when running two receivers side by side.

Device enumeration works on Linux. On macOS and Windows the client plays to
whatever the system default is — those backends expose no enumeration API, so
choose the output in the OS sound settings.

Typing a frequency accepts kHz by default (`7100` → 7.100 MHz). Add a suffix to
override: `7.1M`, `7100k`, `7100000Hz`.

## Display notes

**Marker strip.** Two rows sit between the header and the panes: bookmarks on
top, the band plan directly above the spectrum where it reads as a ruler over
it. Both come from the receiver's HTTP API — `/api/bands` and `/api/bookmarks`,
the same endpoints the web and Python clients use — refreshed every five
minutes, because the bookmark list includes the EiBi broadcasts that are on air
*at that moment* and those turn over with the schedules. Bands are coloured by
their position in the receiver's list, so a band is the same colour here as in a
browser, and the widest are drawn first so a narrow segment nested inside one
stays visible.

A bookmark's `▾` sits on its exact column, with the name running whichever way
there is room for it, so a label near the right-hand edge is shifted without the
marker ever misreporting the frequency. A wide view holds far more bookmarks
than columns — a receiver carrying the EiBi schedule serves well over a thousand
— so labels are placed in order of usefulness and the rest fall away: the
receiver's own bookmarks before the EiBi ones, and within each, those nearest
the VFO. The strip gives up its rows on a terminal too short to spare them.

**Browsing bookmarks.** `b` opens the full list — everything the receiver
serves, in frequency order, over the running display. **Just start typing to
search**, as in the receiver picker: the list narrows on every keystroke and
matches the name, group, mode and frequency, the last in both the units it gets
quoted in, so `7074` and `7.074` both find FT8 on 40 m. Terms are matched
independently and all must hit, so `cw 20` finds `CW 20m` whichever field each
word lands in. Because every printable key is search text, navigation is on the
arrows and paging keys; `Esc` clears the search and closes the panel once the
search is already empty, and `^U` clears it outright.

`Enter` tunes to the highlighted entry with its mode and its filter, and brings
the view along when it is off-screen. Clicking a label on the strip does the
same thing without the panel. In both cases the mode is applied *after* the VFO
moves and without the automatic sideband switch: a bookmark that names LSB above
10 MHz means it, and the 10 MHz convention must not overrule it — the web and
Python clients skip the automatic switch for bookmarks for the same reason.

**Scaling.** In auto mode the dB window is anchored on the 10th percentile —
a representative noise floor, not its lowest outlier — and on the strongest
signal in the frame, with a **minimum range of 60 dB**. The minimum is what
stops the window collapsing onto the noise when a span has nothing strong in
it: without it the top follows the noise down and the floor appears to climb
the pane even though nothing has got louder. In practice the noise sits around
13–15% of the pane height and stays there as you tune across bands.

The top is capped 15 dB above the 99.9th percentile so a one- or two-bin spur
cannot squash the display. That reference has to be that high — at the 99th
percentile, a carrier narrower than 1% of the span does not move it and would
be clipped as though it were a spur. The window is eased between frames so the
scale doesn't jitter, and any manual adjustment switches to manual mode, since
an explicit change would otherwise be overwritten immediately.

**Waterfall.** Each history line records the frequency range it was captured
over, so **panning** keeps old lines aligned under the frequency axis instead of
smearing them sideways. That range comes from the frame itself — the server
stamps every frame with the centre frequency it was captured at — not from the
client's current config. Frames and config messages arrive on separate channels,
so pairing a frame with "the latest config" mis-stamps everything in flight
while the view is moving.

**Zooming restarts the history**, because a change of span makes stored lines
incomparable. Anchoring is what makes panning work, but after a zoom it squeezes
old rows into whatever sliver of screen their original span now occupies —
200 kHz of history lands in about two columns of a 30 MHz view, drawing a bright
vertical stripe through the whole history that reads as a signal which was never
there.

Each line also records the dB window it was captured under, and keeps it. Auto
ranging moves that window continuously; colouring stored lines with the *current*
window repaints the entire history every time it moves, so a carrier sitting
just under the visibility threshold suddenly appears as a stripe running all the
way back through time. Setting the scale by hand does re-colour history, which
is the point of setting it by hand.

Colour tracks the dB window, and the palette maps roughly 1 dB to a visible
step, so a noise floor that varies a few dB bin to bin genuinely looks mottled.
That is real data, not a rendering artifact.

**Resolution.** A receiver sends far more bins than a terminal has columns —
2048 bins into roughly 190 columns is about 11 bins per character cell. Both
panes therefore sample at *sub-cell* resolution to halve that:

- The spectrum uses braille, which packs 2×4 dots into a cell, filled from the
  trace down to the baseline. This is the default; `B` switches to block bars,
  which give finer vertical steps (8 per row) but only one sample per cell
  horizontally. Braille needs a font with braille glyphs — near-universal in
  monospace fonts, but `B` is the escape hatch.
- The waterfall packs two horizontally adjacent samples into each cell with the
  half-block glyph `▌`, the left sub-column in the foreground colour and the
  right in the background. Two pixels is the most a cell can hold *exactly*,
  since a cell has only those two colours.

  An earlier version packed 2×2 pixels using the quadrant glyphs, approximating
  four samples with two colours by splitting them into the two lowest-error
  groups. That is fine on smooth images and wrong for a noise floor: among four
  noisy samples there is always some largest gap, so it drew a hard two-colour
  edge in essentially every cell — measured at ~100%, at every realistic noise
  level — and re-rolled that pattern each frame as the display scrolled,
  inventing blocky structure that was never in the data. Pairing horizontally
  keeps the doubled frequency resolution and cannot invent anything, at one
  time step per row instead of two.

**Decimation.** Both panes aggregate: each sub-column shows the *maximum* of
every bin it covers, so narrow signals survive rather than being averaged into
the noise, and the two panes agree with each other.

This matters more than it sounds. Point-sampling one bin per screen position —
the obvious implementation — drops the other four or five, and *which* signals
survive depends on where the sample happens to land on the bin grid. That
mapping shifts whenever the view pans or zooms, so isolated cells light up and
go dark essentially at random: the waterfall sparkles, and disagrees with the
spectrum drawn directly above it. Sub-column ranges tile the bin array exactly,
each bin covered once and none twice, so a single strong bin lights exactly one
sub-column.

**Zoom.** The server snaps every requested bin bandwidth to a fixed ladder
(`0.5, 1, 2, 5, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 5000`, then
unrounded above that). Zooming therefore steps rung to rung rather than scaling
the span by a factor — a multiplicative step can ask for a value the server
rounds straight back to the rung it came from, which pins the span while the
centre keeps moving, so the view appears to slide sideways instead of zooming.
2000 Hz/bin is the trap: a ×1.5 step asks for 3000 and the server's `< 3500`
rule returns 2000.

Zooming *in* holds the frequency under the cursor at the same screen position,
so you can point at a signal and dive into it. Zooming *out* holds the centre
instead, so the view widens symmetrically and converges on the full 0–30 MHz
span; anchoring zoom-out to an off-centre cursor would slide the view sideways
rather than reveal more spectrum.

## Protocol

The client negotiates `mode=binary8`, the most compact encoding the server
offers: 8-bit bins with delta frames, roughly a quarter the bandwidth of
float32. It also decodes the float32 binary framing and gzip-compressed JSON,
so it works against older servers.

Before opening the WebSocket it performs the `/connection` precheck the server
requires, which is what surfaces a clear reason when a receiver is full or the
client is rate limited.

Everything else it reads is a plain JSON GET: `/api/description` for the DSP
inserts a receiver offers, and `/api/bands` and `/api/bookmarks` for the marker
strip. None of them is required — a receiver serving none of them simply gets a
display without those parts.

## Tests

```bash
go test ./...
```

The suite covers the binary protocol decoders, layout arithmetic across a wide
range of terminal sizes, the picker's key handling, and renders every view mode
to a simulated screen to catch panics.

Three tests reach the network and are skipped unless enabled:

```bash
UBERSDR_TEST_SERVER=https://example.org go test -run TestLiveServer -v
UBERSDR_TEST_SERVER=https://example.org go test -run TestLiveModeSwitchSpeed -v
UBERSDR_TEST_DIRECTORY=1 go test -run TestLivePublicDirectory -v
UBERSDR_TEST_MDNS=1 go test -run TestLiveLocalDiscovery -v
```

## Limitations

- Spectrum only — there is no audio, and therefore no demodulator. The VFO is
  a marker for reading frequencies off the display.
- Mouse support depends on the terminal. Click, drag and wheel work in every
  common emulator; a few minimal ones report only clicks.
- The waterfall keeps 512 lines of history regardless of terminal height.
