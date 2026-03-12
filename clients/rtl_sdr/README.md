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
4. On the first `SET_FREQ` command, the session connects to UberSDR via WebSocket (`/ws?frequency=N&mode=iq192&user_session_id=UUID`)
5. UberSDR streams IQ data as pcm-zstd binary WebSocket frames
6. The bridge decodes the pcm-zstd frames and converts int16 IQ → uint8 offset-binary IQ
7. The uint8 IQ stream is forwarded continuously to the TCP client
8. When the client sends commands (frequency, sample rate, gain, etc.):
   - **Frequency** (`0x01`): Sends `{"type":"tune","frequency":N,"mode":"iq192"}` to UberSDR
   - **Sample rate** (`0x02`): IQ is resampled from 192 kHz to the requested rate using Kaiser-windowed sinc interpolation
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
| 0x02 | SET_SAMPLE_RATE | Map to iq48/iq96/iq192 mode |
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

`rtl_tcp` clients typically request sample rates of 225 kHz to 3.2 MHz. The bridge always uses `iq192` (192 kHz) from UberSDR.

When the client requests a rate different from 192 kHz, the bridge resamples using a **Kaiser-windowed sinc interpolator** (β=8, 25-tap FIR, ~80 dB stopband attenuation). This is the mathematically correct approach:

- Frequencies within **±96 kHz** of centre contain the real signal from UberSDR
- Frequencies **outside ±96 kHz** are filled with zeros — no signal, no spectral images
- The output byte rate matches exactly what the client requested

**Recommended client setting: set your SDR software's bandwidth to 250 kHz.** This keeps the display within the valid ±96 kHz passband.

| Client Requested Rate | UberSDR Mode | Actual IQ Rate | Resampling |
|-----------------------|--------------|----------------|------------|
| 192 kHz | iq192 | 192 kHz | None (pass-through) |
| Any other rate | iq192 | 192 kHz | Kaiser-windowed sinc to requested rate |

## IQ Sample Conversion

UberSDR delivers int16 stereo PCM (little-endian, interleaved I/Q). The `rtl_tcp` protocol requires uint8 offset-binary IQ pairs:

```
uint8_val = (int16_val >> 8) + 128
```

This maps the top 8 bits of the int16 to the uint8 range, with 127 representing zero.

## Frequency Range

UberSDR is HF-only: **10 kHz to 30 MHz**. Frequencies outside this range will be forwarded to UberSDR but may not produce valid data. The bridge logs a warning for out-of-range frequencies.

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
- **HF only**: UberSDR covers 10 kHz–30 MHz. VHF/UHF frequencies are not supported.
- **Sample rate**: Always 192 kHz from UberSDR. Clients requesting any other rate receive Kaiser-windowed sinc resampled data — the inner ±96 kHz contains real signal, the outer bands are clean zeros. Set client bandwidth to 250 kHz for best results.
- **Gain control**: UberSDR manages gain automatically. Gain commands from the client are acknowledged but have no effect.
- **No wideband spectrum**: Spectrum/waterfall data is not provided (IQ stream only).

## Troubleshooting

### Client can't connect

- Verify the bridge is running: `./ubersdr-rtltcp-bridge --url http://localhost:8073`
- Check port 1234 is not blocked by firewall
- Ensure UberSDR server is accessible at the configured URL

### No audio / silent output

- Check bridge logs for UberSDR connection errors
- Verify the frequency is within UberSDR's coverage (10 kHz–30 MHz)
- Try connecting to UberSDR web UI directly to confirm it's working

### SDR# shows wrong sample rate

- SDR# may display the requested rate (e.g., 2.048 MHz) rather than the actual delivered rate (192 kHz)
- This is cosmetic — the actual IQ data is at 192 kHz

## License

This software is part of the ka9q_ubersdr project and follows the same license terms.

## References

- [rtl-sdr project](https://osmocom.org/projects/rtl-sdr/wiki)
- [rtl_tcp protocol source](https://github.com/osmocom/rtl-sdr/blob/master/src/rtl_tcp.c)
- [UberSDR Documentation](../../README.md)
- [HPSDR Bridge](../hpsdr/README.md) — similar bridge for HPSDR protocol
