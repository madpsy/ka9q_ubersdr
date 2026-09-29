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
```

With no terminal (systemd, a pipe) or with `--headless`, it runs as the C bridge
did and logs to stdout with the same timestamps. `--help` lists every option.

### The setup screen

| Field | What it does |
|---|---|
| Receiver URL | `host:port`, `http(s)://…`. **Browse** lists the public directory and receivers found on the LAN by mDNS; type to filter, Enter picks. |
| Password | Sent to `/connection` and on the socket. **Check** says whether it was accepted (session bypassed), refused, or had no effect (the receiver has no bypass password). |
| Receivers | DDCs to emulate, 1-10. |
| Present as | Hermes Lite 2 (device 6) or Hermes (device 1). |
| IQ margin dB | Reduced-depth IQ, 15-60 dB below the band's noise floor, default 26; 0 takes the lossless stream. See the C bridge's README for the measurements. |
| Offer N kHz | The rates offered to clients. After **Check**, any rate the receiver doesn't allow this session is marked `[-] not allowed`. |
| Network interface | Auto answers clients on every network, like the C bridge. Choosing an interface answers only clients on that interface's subnet (plus loopback, for a client on the same machine) and uses its MAC. |

Settings are saved on Start to the platform's config directory
(`~/.config/ubersdr-hpsdr`, `~/Library/Application Support/ubersdr-hpsdr`,
`%AppData%\ubersdr-hpsdr`). The password is only saved if you tick "Remember
password", and the file is created owner-only.

The status screen shows the client, each DDC's socket state, rate, frequency,
throughput and packet count, and the log. `s` stops and goes back to setup; `q`
quits.

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
| `internal/hpsdr` | Protocol 1 and 2 codecs, the bridge, a WebSocket session per DDC. | Every byte offset both protocols use; the C `p1_framing` cases one-for-one; end to end against a fake UberSDR server that enforces `/connection` like the real one and encodes with the real encoder: discovery, tune, reconnect on rate change, phase words, two DDCs, refusals, disallowed rates, server rate changes, closes, legacy servers, watchdogs, protocol 1/2 exclusion. |
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
signal.
