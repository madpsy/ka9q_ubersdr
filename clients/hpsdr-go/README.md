# UberSDR HPSDR bridge (Go)

An openHPSDR radio whose receivers are an UberSDR instance. Point Thetis,
SparkSDR, piHPSDR, deskHPSDR, AetherSDR or anything written for a Hermes Lite 2
at it, and it opens UberSDR IQ sessions on the client's behalf: one per DDC, at
the rate and frequency the client asks for.

It is the Go port of [`clients/hpsdr`](../hpsdr) (the C `ubersdr-hpsdr-bridge`).
The protocol behaviour is the same, and so are the command-line options. The
differences:

- **Windows, macOS and Linux**, from one pure-Go codebase with CGO off. Every
  target cross-compiles from any machine. The C bridge links libwebsockets and
  only builds for Linux.
- **A setup screen in the terminal.** You enter a receiver or browse the public
  directory and the LAN, give a password, and see which IQ rates the receiver
  allows before you start. While it runs, a status screen shows every DDC.
- **Offers only the rates your session may use.** The `/connection` precheck
  reports `allowed_iq_modes`, and the protocol 2 discovery reply advertises
  exactly those. A client that asks for a rate anyway is refused with a reason,
  rather than connecting in a loop.

## Running

```sh
./ubersdr-hpsdr                        # setup screen
./ubersdr-hpsdr --url https://rx.example.org --password secret   # pre-filled
./ubersdr-hpsdr --headless --callsign M9PSY                       # as a service
./ubersdr-hpsdr --headless --url https://rx1 --route 40m,20m=https://rx2   # two receivers
```

With no terminal (systemd, a pipe) or with `--headless`, it runs as the C bridge
did and logs to stdout with the same timestamps. `--help` lists every option.

Headless starts from the settings the setup screen saved, as the screen does,
and any option on the command line overrides just that setting: set things up
on the screen, then `./ubersdr-hpsdr --headless` runs them. It logs which
settings file it read, or that there is none. The bundled systemd unit runs as
`nobody`, which has no settings file, so it goes by its command line; run it as
your own user to use what you saved.

The log says what changes -- clients, connections, band moves, refusals -- and
not what repeats: a client's repeated discovery is logged once per address
(then at most every 10 minutes), lost or malformed packets at most once a
minute with a count, and a receiver that keeps failing logs its first three
attempts, then retries quietly until it has streamed for 10 s, and says how
many lines it held back. The status screen shows every attempt either way.
`--debug` adds the IQ throughput every 5 s and every DDC frequency request.

### The setup screen

| Field | What it does |
|---|---|
| Receiver URL | `host:port`, `http(s)://…`. **Browse** lists the public directory and receivers found on the LAN by mDNS; type to filter, Enter picks. |
| Password | Sent to `/connection` and on the socket. **Check** says whether it was accepted (session bypassed), refused, or had no effect (the receiver has no bypass password). |
| Band receivers | Off by default. See [Band receivers](#band-receivers). |
| Receivers | DDCs to emulate, 1-10. |
| Present as | Hermes Lite 2 (device 6) or Hermes (device 1). |
| IQ margin dB | Reduced-depth IQ, 10-60 dB below the band's noise floor, default 26; 0 takes the lossless stream. See the C bridge's README for the measurements. |
| Offer N kHz | The rates offered to clients. After **Check**, any rate the receiver doesn't allow this session is marked `[-] not allowed`. |
| Network interface | Auto answers clients on every network, like the C bridge. Choosing an interface answers only clients on that interface's subnet (plus loopback, for a client on the same machine) and uses its MAC. |

Settings are saved on Start to the platform's config directory
(`~/.config/ubersdr-hpsdr`, `~/Library/Application Support/ubersdr-hpsdr`,
`%AppData%\ubersdr-hpsdr`). The password is only saved if you tick "Remember
password", and the file is created owner-only.

The status screen shows the client, and for each DDC its socket state, rate,
frequency, the callsign of the receiver it is on with a one-letter reason (see
below), throughput and packet count, then the log. The mouse wheel scrolls the
log, the receiver list and the band tables. `s` stops and goes back to setup;
`q` quits.

### Band receivers

By default one receiver takes every DDC. Band receivers send the DDCs tuned to
some bands to other UberSDR instances instead, say 40m and 20m to one with a
better antenna for them, while the receiver on the setup screen takes
everything else. Choose **Band receivers** on the setup screen to add them;
each gets a URL, a password and a set of bands. Only bands the receiver's
tuning range reaches can be ticked, and a band belongs to one receiver at a
time. Each receiver's range is what its `/api/description` publishes.

The bands are 2200m to 6m, each at the widest allocation any country has (80m
is 3.5-4.0 MHz, as in the Americas). A DDC goes to:

| Key | Receiver |
|---|---|
| B | the one its band is assigned to |
| A | otherwise the main receiver, which takes all other frequencies |
| R | otherwise the only receiver whose range reaches it (general coverage above the main receiver's range, say) |
| O | no receiver tunes it: nothing is opened, the DDC shows `out of range` and stays silent until the client tunes back |

The DDC table shows the letter and the receiver's callsign, and under it the
keys and which callsign has which bands.

It follows the dial. A DDC is routed by its **centre frequency**: a client that
moves its VFO inside a wide panadapter without retuning the DDC stays where it
is until the centre moves. Retuned into another receiver's band, the DDC has to
stay there 300 ms (a sweep across the dial opens nothing on the way), then its
socket closes and one opens on the other receiver. Until then it follows the
dial on the receiver it is on; after it, the client sees a short gap in that
DDC's stream, never a restart. Within 500 Hz of a band edge a DDC creeping
across keeps its receiver, so tuning back and forth over 7.000 MHz does not
reconnect every step.

**Rates.** An HPSDR client picks a rate before it tunes and cannot be told a
band has other limits, so only rates every receiver allows are offered; the
setup screen says which receiver rules each one out.

**Rate limits.** Each band change is a new session, and UberSDR lets an address
open about ten a minute unless the session is bypassed by a password. When a
receiver says "too many", every DDC headed there waits together: 6 s, doubling
to 60 s, with one trying first when it lifts. The DDC shows `rate limited` and
a countdown, the header counts the DDCs held on that receiver, and the log says
once that a password lifts the limit. Nothing is held open to avoid it.

`--route BANDS=URL` does the same headless, repeatable, with a password as the
URL's userinfo: `--route 40m,20m=https://:secret@rx2.example.org`.

### Platform notes

- **Firewall.** Windows and macOS will ask whether to allow incoming UDP the
  first time it runs; allow it on private networks. The client talks to UDP
  1024-1029 and gets IQ from 1035 upwards.
- **Port 1024 in use.** A second bridge, or real radio software holding the
  port, is reported at start and the bridge doesn't run. On Windows, Hyper-V
  can reserve port ranges; `netsh int ipv4 show excludedportrange protocol=udp`
  shows them.
- **macOS.** Published darwin binaries are signed and notarised
  (`notarise-mac.sh`). A binary you built yourself isn't, and Gatekeeper will
  kill it after download unless you clear the quarantine flag.
- **Wine can't test it.** Wine 9.0 refuses the socket options Go (1.23 and
  later) sets on every UDP socket on Windows, so the Windows build has to be
  tested on real Windows.
- **Wideband** (`--wideband`) reads `/dev/shm/rx888wb.bin` as the C bridge did,
  so it only does anything on the machine running a local RX888 setup.

### Not ported

- Two bridges on one machine, each bound to a different interface. The C
  bridge did this with Linux's `SO_BINDTODEVICE` and `/proc` scanning, which
  have no portable equivalent. One bridge per machine, restricted to an
  interface if you like, covers the use.

## Building

```sh
./build.sh --test        # tests, then all seven targets into build/
./build.sh linux_arm64   # just one
./notarise-mac.sh        # sign and notarise the darwin pair on the Mac (MAC_HOST)
./build.sh --publish     # upload to the `latest` release (darwin only once notarised)
```

Targets: `linux_amd64`, `linux_arm64`, `linux_arm` (ARMv7, 32-bit Raspberry Pi
OS), `windows_amd64`, `windows_arm64`, `darwin_amd64`, `darwin_arm64`, named
`ubersdr-hpsdr_<target>[.exe]`.

## Layout and tests

| Package | What | Tested by |
|---|---|---|
| `internal/pcmv4` | Version 4 decoder (from `clients/rtl_sdr`), plus a bound on the sample count a packet may claim. | The three server-produced fixtures and hashes the C bridge's `test/run.sh` uses, truncation, a missing shift byte, fuzzed garbage, and round trips through `v4enc`. |
| `internal/pcmv4/v4enc` | The **server's** encoder, copied verbatim, for tests only. | — |
| `internal/hpsdr` | Protocol 1 and 2 codecs, the bridge, a WebSocket session per DDC, band routing. | Every byte offset both protocols use; the C `p1_framing` cases one-for-one; end to end against a fake UberSDR server that enforces `/connection` like the real one and encodes with the real encoder: discovery, tune, reconnect on rate change, phase words, two DDCs, refusals, disallowed rates, server rate changes, closes, legacy servers, watchdogs, protocol 1/2 exclusion; with two fake servers, moving between receivers as the dial moves, a sweep opening nothing, shared rate-limit waits. |
| `internal/ubersdr` | `/connection`, `/api/description`, the directory, mDNS, the IQ socket. | URL normalisation, password escaping into JSON and the query string, mode filtering, tuning-range fallbacks, directory parsing and sorting, the min-margin parser. |
| `internal/app` | Settings, probe, offered-rate logic, building a bridge. | Save/load (password handling, file mode), validation, rate intersection, probe summaries. |
| `internal/ui` | tview setup, picker and status screens. | Driven on a simulated 80x25 screen with real key events: checking a receiver, greying out rates, masking, stale checks, focus, start/stop, the picker. |

```sh
go test -short -race ./...      # everything, about 10 s
go test ./...                   # plus the 3 s protocol 1 watchdog wait
UBERSDR_LIVE_URL=https://m9psy-1.instance.ubersdr.org go test -run Live -v ./internal/hpsdr/
```

The live test runs a protocol 2 client with DDCs at 384 and 48 kHz against a
real receiver and checks each DDC's delivered rate, sequence continuity and
signal. `UBERSDR_LIVE_BAND_URL` as well runs `TestLiveRouted`, which tunes
one DDC 20m, 40m, 20m with 40m on the second receiver.
