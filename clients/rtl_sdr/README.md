# UberSDR to rtl_tcp Bridge

This bridge emulates an `rtl_tcp` server, allowing software that speaks the `rtl_tcp` protocol to use UberSDR as a backend. It connects to a UberSDR server via WebSocket and serves raw 8-bit unsigned IQ samples over TCP on port 1234.

## Compatible Software

Any software that supports `rtl_tcp` as an IQ source:

- **SDR#** (SDRSharp) — set source to `RTL-SDR (TCP)`, host `127.0.0.1`, port `1234`
- **GQRX** — set device string to `rtl_tcp=127.0.0.1:1234`
- **CubicSDR** — add RTL-SDR TCP source
- **GNU Radio** — use `RTL-SDR Source` block with TCP mode
- **SDR Console** — add RTL-SDR TCP device
- **Linrad** — configure RTL-SDR TCP input
- Any other software using the `rtl_tcp` protocol

## Building

```bash
cd clients/rtl_sdr
go build -o ubersdr-rtltcp-bridge .
```

Or using make:

```bash
make
```

## Usage

### Basic Usage

Connect to a local UberSDR server:

```bash
./ubersdr-rtltcp-bridge --url http://localhost:8073
```

Then configure your SDR software to connect to `rtl_tcp=127.0.0.1:1234`.

### Remote UberSDR with Password

```bash
./ubersdr-rtltcp-bridge --url https://sdr.example.com --password mypass
```

### Custom Listen Address and Port

```bash
./ubersdr-rtltcp-bridge --url http://localhost:8073 --listen 0.0.0.0:1234
```

### With Frequency Routing Config

```bash
./ubersdr-rtltcp-bridge --url http://localhost:8073 --config routing.yaml
```

### Multiple Simultaneous Clients

By default up to 4 rtl_tcp clients can connect at the same time, each with an independent UberSDR session:

```bash
# Default: 4 simultaneous clients
./ubersdr-rtltcp-bridge --url http://localhost:8073

# Allow up to 8 simultaneous clients
./ubersdr-rtltcp-bridge --url http://localhost:8073 --max-clients 8

# Unlimited clients (limited only by UberSDR server capacity)
./ubersdr-rtltcp-bridge --url http://localhost:8073 --max-clients 0
```

When the limit is reached, new connections are rejected immediately with a log message and the existing sessions are unaffected.

## Command-Line Options

| Option | Default | Description |
|--------|---------|-------------|
| `-url` | `http://127.0.0.1:8080` | UberSDR server URL (http/https/ws/wss) |
| `-password` | _(none)_ | UberSDR server password |
| `-listen` | `0.0.0.0:1234` | TCP address and port to listen on |
| `-freq` | `14200000` | Initial frequency in Hz (14.2 MHz) |
| `-config` | _(none)_ | Frequency routing config file (YAML) |
| `-max-clients` | `4` | Maximum simultaneous rtl_tcp clients (0 = unlimited) |

## How It Works

1. The bridge listens on TCP port 1234 for `rtl_tcp` client connections
2. Each client gets its own **independent session** with a unique UberSDR WebSocket connection — multiple clients can be active simultaneously, each tuned to a different frequency
3. When a client connects:
   - If the client limit (`-max-clients`) is reached, the connection is rejected immediately and logged
   - The bridge checks connection permission via UberSDR's `/connection` HTTP endpoint
   - Sends the 12-byte `RTL0` dongle info header (emulating an R820T tuner with 29 gain steps)
4. On the first `SET_FREQ` command, the session connects to UberSDR via WebSocket (`/ws?frequency=N&mode=iq384&format=pcm-zstd&version=4&user_session_id=UUID`)
5. UberSDR streams IQ as binary lossless packets — see Wire Format below
6. The bridge decodes them and converts int16 IQ → uint8 offset-binary IQ
7. The uint8 IQ stream is forwarded continuously to the TCP client
8. When the client sends commands (frequency, sample rate, gain, etc.):
   - **Frequency** (`0x01`): Sends `{"type":"tune","frequency":N,"mode":"iq384"}` to UberSDR
   - **Sample rate** (`0x02`): IQ is resampled from 384 kHz to the requested rate using a Kaiser-windowed sinc
   - **Gain/AGC/other** (`0x03`–`0x0e`): Acknowledged silently (UberSDR manages gain)

## rtl_tcp Protocol

### Dongle Info Header (Server → Client, on connect)

```
Offset  Size  Content
0       4     "RTL0" magic
4       4     Tuner type (big-endian uint32): 5 = R820T
8       4     Tuner gain count (big-endian uint32): 29
```

### Command Packets (Client → Server, 5 bytes each)

```
Offset  Size  Content
0       1     Command byte
1       4     Parameter (big-endian uint32)
```

| Cmd  | Name | Bridge Action |
|------|------|---------------|
| 0x01 | SET_FREQ | Tune UberSDR to frequency |
| 0x02 | SET_SAMPLE_RATE | Resample from iq384 to the requested rate |
| 0x03 | SET_GAIN_MODE | No-op |
| 0x04 | SET_GAIN | No-op |
| 0x05 | SET_FREQ_CORRECTION | No-op |
| 0x06 | SET_IF_TUNER_GAIN | No-op |
| 0x07 | SET_TEST_MODE | No-op |
| 0x08 | SET_AGC_MODE | No-op |
| 0x09 | SET_DIRECT_SAMPLING | No-op |
| 0x0a | SET_OFFSET_TUNING | No-op |
| 0x0b | SET_RTL_XTAL | No-op |
| 0x0c | SET_TUNER_XTAL | No-op |
| 0x0d | SET_GAIN_BY_INDEX | No-op |
| 0x0e | SET_BIAS_TEE | No-op |

## Sample Rate

`rtl_tcp` clients typically request sample rates of 225 kHz to 3.2 MHz. The bridge always uses `iq384` (384 kHz) from UberSDR, so the real signal spans **±192 kHz** of the tuned frequency — wide enough to cover the usual requests outright.

**This requires a bypassed session.** The server offers the wide IQ modes only to a password- or IP-bypassed user, and the bridge refuses to connect when `iq384` is absent from `allowed_iq_modes`. It is a tool for receiver owners, not for pointing at somebody else's public instance. It also doubles the wire against `iq192` — measured 1129 kB/s against 563 on protocol version 4 — which the receiver's operator pays for.

When the client asks for a different rate, the bridge resamples with a **Kaiser-windowed sinc** (β=8, ~80 dB stopband), and which way it is going matters:

| Client Requested Rate | Direction | Filter | Result |
|---|---|---|---|
| 384 kHz | — | none | pass-through |
| Below 384 kHz (225, 250, 300 kHz …) | decimation | 65-tap, cutoff pulled to 0.85 of the new Nyquist | anti-aliased: measured ≥83 dB rejection at the fold |
| Above 384 kHz (1.024, 2.4 MHz …) | interpolation | 25-tap | the extra span carries no signal |

Decimation is the case that needs the long kernel. A windowed-sinc is 6 dB down *at* its cutoff, so putting the cutoff on the output Nyquist folds half the transition band back into the passband however many taps are used — and the transition width is set by the window length in **input** samples, so it does not shrink with the ratio. At 250 kHz out the result is flat to 97.9 kHz, −3 dB at 103.3 kHz and 83 dB down at the 125 kHz fold: slightly more usable span than the ±96 kHz `iq192` gave, and properly filtered where that was not. `resampler_test.go` measures this by pushing tones through the real filter rather than trusting the design.

Interpolation keeps the short kernel deliberately: there is nothing to alias, and 65 taps at 2.4 Msps would be real CPU for nothing.

The rejection figures above are measured at 225–300 kHz, which is the range `rtl_tcp` clients actually ask for. Because the transition width is fixed in input samples, a request far below that — 48 kHz, say, decimating 8:1 — has a transition band comparable to its whole output bandwidth and is not well filtered. It was not well filtered from `iq192` either; it is simply outside what the protocol is for.

## Wire Format

The bridge requests `format=pcm-zstd&version=4` — the lossless path, which is
the only one IQ is ever served on, at the only protocol version it reads.
`pcm-zstd` is still the server's name for that format, but from version 4 what
it carries is not zstd:

- **Packet**: a `PCM4` magic, a flags byte, then only the fields that changed
  since the last packet. Sample rate, channel count, sample count and the two
  signal levels are each re-sent when they move and every five seconds
  regardless. About 9 bytes against the 29 version 1 spent on every one.
- **Body**: each sample is predicted from those before it by an adaptive complex
  filter and only the prediction error is sent, Rice coded. The filter is
  *backward* adaptive — its taps come from samples already decoded — so no
  coefficients travel and the decoder recomputes them independently.
- **Bandwidth**: 384 kHz IQ falls from 1590 kB/s to 1116 — measured 1129 kB/s
  live against 1525 raw, a ratio of 1.35x. zstd achieved nothing here: it is an LZ77 matcher over bytes, and a
  band-limited RF signal has no repeated byte strings, so every IQ mode measured
  at 0.99x — the compressed stream *larger* than the samples it carried.
- **Lossless**: bit-exact, and checked as such. `TestPCMv4DecodesServerStream`
  decodes a packet stream in `testdata/` that the server's own encoder produced
  and compares the samples that come back; the predictor fails silently
  otherwise, and an rtl_tcp client would only report a receiver that suddenly
  hears nothing.
- **Requires UberSDR 0.1.63 or later.** Older servers clamp the requested
  version to 1-3 and answer with version 1 rather than refusing; the bridge
  recognises those frames and logs why instead of decoding noise.

## IQ Sample Conversion

The decoder produces int16 stereo PCM (little-endian, interleaved I/Q). The `rtl_tcp` protocol requires uint8 offset-binary IQ pairs:

```
uint8_val = (int16_val >> 8) + 128
```

This maps the top 8 bits of the int16 to the uint8 range, with 127 representing zero.

## Frequency Range

The bridge reads the receiver's range from `/api/description` at startup and logs it. It is not fixed at 30 MHz: the span follows the radiod front end sample rate, so a 64.8 Msps RX888 covers 10 kHz–30 MHz and a 129.6 Msps one reaches 60 MHz. A receiver that does not publish a range is assumed to be 10 kHz–30 MHz.

Frequencies outside the range are still forwarded to UberSDR but may not produce valid data; the bridge logs a warning for them.

Note that the range is **not** advertised to your SDR client. The rtl_tcp protocol has no field for it — the dongle header carries only a tuner type, and this bridge reports an R820T, which makes clients believe 24–1766 MHz is tunable. Your client's tuning limits therefore come from its own idea of an R820T, not from the receiver.

## Frequency Routing Configuration

If you have multiple UberSDR instances covering different frequency ranges, you can use a routing config file:

```yaml
# routing.yaml
default_url: http://localhost:8073
default_password: ""

frequency_ranges:
  - name: "LF/MF"
    min_freq: 10000
    max_freq: 1800000
    url: http://lf-sdr.example.com:8073
    password: ""

  - name: "HF Low"
    min_freq: 1800000
    max_freq: 15000000
    url: http://hf-low.example.com:8073
    password: ""

  - name: "HF High"
    min_freq: 15000000
    max_freq: 30000000
    url: http://hf-high.example.com:8073
    password: ""
```

## Installing as a systemd Service

```bash
# Build and install binary
make install

# Install and configure service
sudo cp ubersdr-rtltcp-bridge.service /etc/systemd/system/
sudo nano /etc/systemd/system/ubersdr-rtltcp-bridge.service  # edit URL/options
sudo systemctl daemon-reload
sudo systemctl enable --now ubersdr-rtltcp-bridge

# Check status
sudo systemctl status ubersdr-rtltcp-bridge
sudo journalctl -u ubersdr-rtltcp-bridge -f
```

Or use the Makefile:

```bash
sudo make install-service
```

## Limitations

- **Client limit**: Up to `-max-clients` (default 4) simultaneous `rtl_tcp` clients. Set to 0 for unlimited. Each client consumes one UberSDR WebSocket session.
- **Coverage**: whatever the receiver covers — 10 kHz–30 MHz on a stock RX888, up to 60 MHz at 129.6 Msps. Anything above that is not supported.
- **Sample rate**: Always 384 kHz from UberSDR, so the inner ±192 kHz carries real signal. Clients requesting any other rate receive Kaiser-windowed sinc resampled data; below 384 kHz it is anti-aliased, above it the extra span is empty.
- **Gain control**: UberSDR manages gain automatically. Gain commands from the client are acknowledged but have no effect.
- **No wideband spectrum**: Spectrum/waterfall data is not provided (IQ stream only).

## Troubleshooting

### Client can't connect

- Verify the bridge is running: `./ubersdr-rtltcp-bridge --url http://localhost:8073`
- Check port 1234 is not blocked by firewall
- Ensure UberSDR server is accessible at the configured URL

### No audio / silent output

- Check bridge logs for UberSDR connection errors
- Verify the frequency is within the range the bridge logged at startup ("Tuning range: ...")
- Try connecting to UberSDR web UI directly to confirm it's working

### SDR# shows wrong sample rate

- SDR# may display the requested rate (e.g., 2.048 MHz) rather than the actual delivered rate (384 kHz)
- This is cosmetic — the actual IQ data is at 384 kHz

## License

This software is part of the ka9q_ubersdr project and follows the same license terms.

## References

- [rtl-sdr project](https://osmocom.org/projects/rtl-sdr/wiki)
- [rtl_tcp protocol source](https://github.com/osmocom/rtl-sdr/blob/master/src/rtl_tcp.c)
- [UberSDR Documentation](../../README.md)
- [HPSDR Bridge](../hpsdr/README.md) — similar bridge for HPSDR protocol
