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
| `-server` | A receiver name from the public directory, `host:port`, or a full `http(s)://` URL. Empty opens the picker. |
| `-tls` | Force TLS. Implied by an `https://` URL. |
| `-password` | Bypass password, if the receiver requires one. |
| `-freq` | Initial frequency in kHz (0 = the receiver's own default). |
| `-mode` | Initial demodulation mode (empty = the receiver's own default). |
| `-bw` | Filter edges in Hz as `low:high` (empty = the mode's own default). |
| `-squelch` | Squelch threshold in dB of SNR (0 = off). |
| `-headless` | No display: tune and stream the audio, for scripts and services. |
| `-span` | Initial span in kHz (0 = server default). |
| `-view` | `spectrum`, `waterfall` or `split` (default `split`). |
| `-bars` | Draw block bars instead of the higher-resolution braille spectrum. |
| `-no-audio` | Watch the spectrum without opening an audio channel. |
| `-stdout` | Write the demodulated audio to stdout as raw PCM. Needs a pipe or a redirect. |
| `-stdout-wav` | The same, with a WAV header, so a redirected file plays anywhere. |
| `-no-device` | Do not open a sound device; useful with `-stdout`. |
| `-device` | Output device: an index from `-device list`, or part of its name. |
| `-4` | IPv4 only: never dial a receiver or the directory over IPv6. LAN discovery is IPv4-only regardless. |
| `-version` | Print the version and exit. |

## Headless

`-headless` drops the display: it connects, tunes, and puts the audio wherever
it was told to. It opens **no spectrum socket at all** — a session nobody is
watching has no use for one, and not asking saves the receiver a channel.

```bash
# record 20 m for ten minutes
timeout 600 ubersdr-tui -headless -server m9psy -freq 14074 -mode usb \
    -stdout-wav -no-device > ft8.wav

# listen to a remote receiver through a named output, nothing on screen
ubersdr-tui -headless -server https://sdr.example.org -freq 7100 -mode lsb -device steinberg

# a narrow CW filter, piped into something else
ubersdr-tui -headless -server nb3a -freq 14050 -mode cwu -bw -250:250 \
    -stdout -no-device | my-decoder
```

Everything it says goes to **stderr**, since stdout may be carrying the audio:
one summary line on start, then whatever the connection reports.

```
m9psy.tunnel.ubersdr.org — 7.100000 MHz LSB, filter -2700/-300 Hz → stdout (wav)
audio connected
```

**Choosing the output device.** `-device list` prints what there is and exits —
to stderr, so it stays readable while stdout is being piped:

```
$ ubersdr-tui -device list
output devices:
   0  System default
 * 1  Steinberg UR24C Analogue Surround 4.0
   2  HDMI Output
   (* is the sound server's current default, which is what index 0 follows;
    -device takes an index or part of a name)
```

Then `-device 1`, or `-device steinberg` — any part of the name, case
insensitively, as long as it picks out one device. Both forms exist because they
fail differently: an index is quick to type from the listing, but the order
moves when something is plugged in or the sound server restarts, so **a service
that has to come back to the same speakers should name them**. A name matching
several devices is refused with the candidates rather than guessing. `-device`
works with the display too, where it sets the device the session starts on.

Enumeration is a Linux feature: it comes from PulseAudio, and on macOS and
Windows the backends expose no such API, so the list there is the system default
alone and the output is chosen in the OS sound settings.

`-freq` and `-mode` fall back to the receiver's own defaults, exactly as they do
with the display. `-bw` takes the filter as **`low:high` in Hz** — the same pair
of edges the rest of the client uses, so a lower-sideband filter is two negative
numbers (`-2700:-300`) and a CW filter straddles zero (`-250:250`). It is
clamped to what the mode can carry. `-squelch` takes a threshold in dB of SNR
and works in both modes.

`SIGINT` and `SIGTERM` shut it down properly rather than killing it, which is
what finishes a WAV capture's header — so `systemctl stop` and Ctrl-C both leave
a valid file.

## Choosing a receiver

**`-server` takes a receiver name as well as an address.** Anything with a
scheme, a port or a dot is used as given; a bare word is looked up in the public
directory by callsign or name, so `-server m9psy` finds
`m9psy.tunnel.ubersdr.org` on its own. An exact callsign wins; anything else has
to match one receiver, and a name that matches several is refused with the list.

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

**Or use the mouse.** The wheel scrolls the list, a click highlights the
receiver under the pointer, and a second click on the one already highlighted
connects to it. Two clicks rather than one for the same reason the keyboard asks
for `enter` after the arrows: connecting tears down the current session and
opens another, which is too much to hang on a single stray click.

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
| `d` | audio settings: outputs, volume, mode, exact filter edges |
| **Chat** | |
| `C` | open the chat, on receivers that run one |
| `@` | in the chat: start a mention, `tab` completes it |
| `/leave` | typed in the chat: leave it, keeping the display |
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

### Two outputs

There are two places the audio can go, and each is independent: **the sound
device**, **stdout**, both at once, or neither.

```bash
# play it through the system player instead of opening a sound device here
./ubersdr-tui -server localhost:8080 -stdout -no-device | aplay -f S16_LE -r 48000 -c 1

# record it
./ubersdr-tui -server localhost:8080 -stdout -no-device | sox -t raw -r 48000 -e signed -b 16 -c 1 - out.wav

# both at once: local speakers *and* a recording
./ubersdr-tui -server localhost:8080 -stdout | sox -t raw -r 48000 -e signed -b 16 -c 1 - out.wav

# straight to a playable file, no converter in the way
./ubersdr-tui -server localhost:8080 -stdout-wav -no-device > radio.wav
```

**Stdout has to be redirected before the stream can start** — see below — so
starting with one of the flags is the usual way in. Both outputs are then
switchable while running, from the `d` panel: the device list has **Off — no
local playback** at its head, so the speakers are switched off by the same
control that chooses them, and a **Stdout** row cycles through off, raw and WAV.
To leave the choice until later, redirect at launch and turn the stream on when
you want it:

```bash
./ubersdr-tui -server localhost:8080 > radio.wav     # then d, Stdout, → → for WAV
```

### Raw or WAV

`-stdout` writes **headerless PCM**. That is what a pipe wants, because the
reader is told the format on its own command line — but it makes a poor file:
nothing infers 48 kHz mono S16_LE from an extension, VLC included, so a bare
`> radio.raw` leaves you with something no player will open.

`-stdout-wav` puts a 44-byte WAV header in front of the same samples, which is
what makes a redirected file work everywhere. The length is not knowable while
the stream is live, so the header goes out open-ended; **when stdout is a
regular file the real sizes are patched in as the client exits**, leaving a
capture that is exactly right rather than merely playable. Quit with `q` rather
than killing the process, or that last step is missed — the file still plays,
but tools will report a nonsense duration.

If you already have a headerless capture, tell the tool what it is:

```bash
# convert it once
sox -t raw -r 48000 -e signed -b 16 -c 1 radio.raw radio.wav
ffmpeg -f s16le -ar 48000 -ac 1 -i radio.raw radio.wav

# or play it where it lies
aplay -f S16_LE -r 48000 -c 1 radio.raw
ffplay -f s16le -ar 48000 -ac 1 radio.raw
vlc --demux=rawaud --rawaud-channels=1 --rawaud-samplerate=48000 --rawaud-fourcc=s16l radio.raw
```

What goes down the pipe is the demodulated audio exactly as it arrives —
**48 kHz mono, signed 16-bit little-endian**, header or no header — and deliberately *not* what the
speakers get: volume, mute and channel routing belong to the sound device, and
applying them here would quietly ruin a recording, or halve a pipe whenever the
routing was set to one side. Server-side squelch and noise reduction do apply,
since those shape the audio before it is ever sent.

This works because tcell drives `/dev/tty` rather than stdout, so the display
and the audio never meet. **The one thing it cannot do is write to a terminal**,
which is what stdout still is unless you redirect it — so there has to be a pipe
before the stream will start, whether it is asked for by `-stdout` or from the
panel. `-stdout` refuses at startup rather than filling the terminal with binary
noise; in the panel the row reads `off — stdout is a terminal`, the note under
the rows gives the command that fixes it, and that note turns red if you try
anyway, since the status line is behind the panel and a refusal reported there
would be invisible.

A reader that stalls costs audio, never the display — the queue drops the oldest
packets rather than blocking the event loop, the same bargain the local mixer
makes.

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

**Where a session starts.** Receivers publish a starting point — the operator's
`default_frequency` and `default_mode`, in `/api/description` — and this client
uses it, tuning there and opening the view centred on it. The order is the same
as the Python client's: **what you asked for on the command line, then what the
receiver prefers, then the built-in fallback** of 14.175 MHz USB. Both values
are re-checked on arrival, since a receiver can name a frequency outside
0.01–30 MHz or a mode this client has no demodulator for.

A mode that was asked for — by `-mode` or by the receiver naming its own —
holds against the 10 MHz sideband convention until you tune somewhere yourself:
a receiver whose default is USB on 40 m means it, and `A` would otherwise undo
that before the first frame arrived. The first tune hands the convention back.

## Chat

Some receivers run a chat; many do not. `/api/description` says which
(`chat_enabled`), and this client follows it: on a receiver without one the key
does nothing but say so, and the header and status bar carry no chat at all.

Where there is one, the socket opens with the session — it is the DX cluster
socket, `/ws/dxcluster`, which is where the server hosts chat, sharing the
spectrum session's UUID so you still count as one user. Subscribing is enough to
see who is in the room, so **the header shows the number of people in the chat
before you join anything**, right beside the `● live` indicator:

```
 m9psy.tunnel.ubersdr.org ● live chat 3 +2@     VFO 7.1000 MHz │ span 205 kHz │ …
```

It sits there rather than in the right-hand block because that block is shed
field by field on a narrow terminal, which is exactly when an unread message
would be dropped. Once you are **in** the chat it grows a `+n` for messages that
arrived while the panel was closed, drawn in the alert colour; a listener who
never joined sees the count alone, since nobody can address them. A message
naming you — `@yourname` — adds an `@` to that count.

`C` opens the panel over the running display. Type a username and press enter to
join: 1–15 characters, letters and digits plus `-` `_` `/`, which is the
server's own rule and is checked here first so a bad name is refused instantly
rather than after a round trip. After that the same line sends messages. `Esc`
closes the panel and leaves the chat running behind it; `/leave` leaves the chat
itself.

**Mentions** work both ways, as they do in the Python client. Typing `@`
followed by part of a name offers the people in the room — sorted, yourself
excluded — on the line above the input: `↑` `↓` choose, `tab` completes with a
trailing space, `Esc` dismisses the list before it closes anything. In the other
direction, a message naming you highlights **the `@yourname` token itself**
rather than the whole line, so it is findable in a wall of chat, and if the
panel is shut when it arrives the status line names who it was from and the
terminal bell rings once. The header's `@` stays until you open the panel.

**Your frequency and mode are published while you are in the chat**, which is
what makes a receiver's chat about radio: the panel's right-hand column shows
where everyone else is listening. Updates are sent only when something actually
changes and at most once a second, because the server rate limits them and
answers a breach with an error.

Two details are worth knowing. The subscription is a real handshake — measured
against a live receiver, anything sent immediately after `subscribe_chat` comes
back as *"you must subscribe to chat first"* — so nothing is sent until the
server confirms it. And the server replays its message buffer to every new
subscriber: that replay is history, so it fills the transcript without counting
as unread, and it replaces the transcript rather than appending to it, which is
what stops a reconnect showing everything twice.

## Display notes

**Session clock.** Receivers cap how long one session may run, and say so in the
`/connection` reply that every session begins with — `max_session_time`, in
seconds, zero for no limit. The top right corner counts it down every second,
`1h24m12s`, turning red for the last five minutes; a receiver that sets no limit
shows `unlimited` instead of a clock that never moves. The clock is the one
header field that is never shed on a narrow terminal, because a session ending
without warning is indistinguishable from a crash. Headless mode reports the
same limit in its startup line.

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

Every request it makes — HTTP and WebSocket alike — identifies itself as
`UberSDR_TUI/1.0`. That is part of the handshake rather than decoration: the
server records the User-Agent a session presented to `/connection` and refuses
to open a socket for a UUID it has never seen one from.

Everything else it reads is a plain JSON GET: `/api/description` for the DSP
inserts a receiver offers and whether it runs a chat, and `/api/bands` and
`/api/bookmarks` for the marker strip. None of them is required — a receiver
serving none of them simply gets a display without those parts.

Chat, when there is one, is a third WebSocket: `/ws/dxcluster`, subscribed to
the chat stream only and sharing the same session UUID.

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
