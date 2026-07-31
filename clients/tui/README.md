# UberSDR Terminal Client

A spectrum and waterfall viewer that runs entirely in a terminal, on Linux,
macOS and Windows.

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

This client is **pure Go**. Unlike `clients/go/`, it links no C libraries —
no PortAudio, no Opus, no libsamplerate — because it never touches audio.
That is what makes `CGO_ENABLED=0` cross-compilation work, so binaries for
ARM and every other target build from any machine with no cross toolchain,
sysroot or emulator. It has its own `go.mod` to keep the CGO dependencies of
the audio client out of the graph.

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

| | |
| --- | --- |
| **Tuning** | |
| click | set the VFO marker |
| drag | pan the view |
| `f` | type a frequency |
| `c` | centre on the VFO |
| `←` `→` | pan (`,` `.` for fine steps) |
| **Zoom and wheel** | |
| wheel | zoom (in at the cursor, out from the centre), or tune |
| `w` | switch the wheel between zoom and tune |
| `s` / `S` | cycle the tuning step (10 Hz … 10 kHz) |
| `+` `-`, `↑` `↓` | zoom about the centre |
| `0` | reset to full span |
| **Display** | |
| `v` | cycle spectrum / waterfall / split |
| `<` `>` | resize the split |
| `b` | braille (2x resolution) or block bars |
| `p` | peak hold |
| **Scaling** | |
| `a` | auto / manual |
| `[` `]` | lower / raise the noise floor |
| `{` `}` | lower / raise the ceiling |
| **Other** | |
| `i` | pick another receiver |
| `?` | help overlay |
| `q` | quit |

Typing a frequency accepts kHz by default (`7100` → 7.100 MHz). Add a suffix to
override: `7.1M`, `7100k`, `7100000Hz`.

## Display notes

**Scaling.** In auto mode the dB window tracks the 1st and 99th percentiles of
the current frame — the 1st follows the true noise floor, the 99th stops a
single strong carrier from flattening everything else. The window is eased
between frames so the scale doesn't jitter. Any manual adjustment switches to
manual mode, since an explicit change would otherwise be overwritten
immediately.

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
  trace down to the baseline. This is the default; `b` switches to block bars,
  which give finer vertical steps (8 per row) but only one sample per cell
  horizontally. Braille needs a font with braille glyphs — near-universal in
  monospace fonts, but `b` is the escape hatch.
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
UBERSDR_TEST_DIRECTORY=1 go test -run TestLivePublicDirectory -v
UBERSDR_TEST_MDNS=1 go test -run TestLiveLocalDiscovery -v
```

## Limitations

- Spectrum only — there is no audio, and therefore no demodulator. The VFO is
  a marker for reading frequencies off the display.
- Mouse support depends on the terminal. Click, drag and wheel work in every
  common emulator; a few minimal ones report only clicks.
- The waterfall keeps 512 lines of history regardless of terminal height.
