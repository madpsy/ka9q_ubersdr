# SoapyUberSDR - SoapySDR Driver for KA9Q UberSDR

This is a SoapySDR driver that provides access to KA9Q UberSDR's wide IQ modes via WebSocket. It enables any SoapySDR-compatible application (GQRX, CubicSDR, GNU Radio, etc.) to connect to a KA9Q UberSDR server.

## Features

- **Wide IQ Mode Support**: Access to iq48, iq96, iq192, and iq384 modes (48-384 kHz bandwidth)
- **Network Transparent**: Connect to remote UberSDR servers via WebSocket
- **Full I/Q Streaming**: Native complex sample format for spectrum analysis and signal processing
- **Frequency Range**: read from the receiver at load time; 10 kHz to 30 MHz when it does not say
- **Sample Rates**: 48, 96, 192, or 384 kHz

## Requirements

### Build Dependencies

- CMake >= 3.1
- C++11 compiler (g++, clang++)
- SoapySDR development files
- websocketpp (header-only library)
- Boost (system library)
- OpenSSL (for WSS support)
- libcurl (for HTTP connection check)

### Ubuntu/Debian Installation

```bash
sudo apt-get install \
    cmake \
    g++ \
    libsoapysdr-dev \
    libwebsocketpp-dev \
    libboost-system-dev \
    libssl-dev \
    libcurl4-openssl-dev
```

### Fedora/RHEL Installation

```bash
sudo dnf install \
    cmake \
    gcc-c++ \
    SoapySDR-devel \
    websocketpp-devel \
    boost-devel \
    openssl-devel \
    libcurl-devel
```

## Building

```bash
cd soapy_driver
mkdir build
cd build
cmake ..
make
sudo make install
```

The driver will be installed to `/usr/local/lib/SoapySDR/modules<version>/libuberSDRSupport.so`

## Usage

### Discovery

List available UberSDR devices:

```bash
# Discover all modes from default server
SoapySDRUtil --find="driver=ubersdr"

# Discover from specific server
SoapySDRUtil --find="driver=ubersdr,server=ws://radio.example.com:8080/ws"

# Discover specific mode only
SoapySDRUtil --find="driver=ubersdr,server=ws://localhost:8080/ws,mode=iq192"
```

### Testing

Test device creation:

```bash
SoapySDRUtil --make="driver=ubersdr,server=ws://localhost:8080/ws,mode=iq96"

# Test with password authentication
SoapySDRUtil --make="driver=ubersdr,server=ws://localhost:8080/ws,mode=iq96,password=your-secret-password"
```

### GQRX

1. Start GQRX
2. Configure I/O devices
3. Device string: `ubersdr,server=ws://your-server:8080/ws,mode=iq192`
4. For password-protected servers: `ubersdr,server=ws://your-server:8080/ws,mode=iq192,password=your-secret-password`
5. Select sample rate: 192000
6. Click OK and start

**Example device string from discovery:**
```
callsign=M9PSY,driver=ubersdr,location='Dalgety Bay, Scotland, UK',mode=iq96,serial=wss://ubersdr.madpsy.uk:443/ws:iq96,server=wss://ubersdr.madpsy.uk:443/ws,soapy=5,password=xxxxxxxxxxxxxxxxx
```

### CubicSDR

1. Start CubicSDR
2. Select "SoapySDR" as device type
3. Choose "KA9Q UberSDR" from the list
4. Select desired mode (iq48/iq96/iq192/iq384)
5. Start SDR

### GNU Radio

Python example:

```python
import SoapySDR
from gnuradio import gr, blocks

# Create UberSDR source
sdr = SoapySDR.Device(dict(
    driver="ubersdr",
    server="ws://localhost:8080/ws",
    mode="iq384",  # 384 kHz bandwidth
    password="your-secret-password"  # Optional: for bypass authentication
))

# Configure
sdr.setSampleRate(SOAPY_SDR_RX, 0, 384000)
sdr.setFrequency(SOAPY_SDR_RX, 0, 14.074e6)  # 20m FT8

# Setup stream
stream = sdr.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
sdr.activateStream(stream)

# Read samples
buff = numpy.array([0]*2048, numpy.complex64)
sr = sdr.readStream(stream, [buff], len(buff))
```

### Command Line Testing

Using `rx_sdr` from librtlsdr:

```bash
# Receive 10 seconds of IQ data at 192 kHz
rx_sdr -d driver=ubersdr,server=ws://localhost:8080/ws,mode=iq192 \
       -f 14074000 -s 192000 -n 1920000 output.cf32
```

## Device Arguments

| Argument | Required | Description | Example |
|----------|----------|-------------|---------|
| `driver` | Yes | Must be "ubersdr" | `driver=ubersdr` |
| `server` | Yes | WebSocket URL | `server=ws://localhost:8080/ws` |
| `mode` | No | Wide IQ mode (default: iq96) | `mode=iq192` |
| `password` | No | Bypass password for wide IQ modes | `password=your-secret-password` |
| `min_margin` | No | Reduced-depth IQ, in dB of margin under the noise floor (15-60; omit for lossless) | `min_margin=20` |

## Reduced-depth IQ: `min_margin`

Optional, and off unless asked for. It trades a defined amount of quantisation
noise on the link between the driver and the receiver for bandwidth, and the
request is a *margin*, not a bit depth: the value is how far below the band's own
noise floor the quantisation floor must stay, and the server works out per packet
how many bits that needs.

That is what makes one number mean the same thing on every band. A fixed depth
does not: ten bits leaves 50 dB of headroom on a dead 6 m band and 9 dB on medium
wave, so a depth that is safe on the second wastes most of the saving on the
first.

```bash
SoapySDRUtil --make="driver=ubersdr,server=wss://sdr.example.com/ws,mode=iq192,min_margin=20"
```

Measured live at 192 kHz: **4482 kbps lossless against 1781 kbps at
`min_margin=20`** — the same samples at the same rate for 60% less traffic. A
busy band or a lower margin saves less, which is the point: medium wave spends
the bytes because its carriers genuinely need the depth.

Nothing the host sees changes. The same complex samples arrive at the same rate,
and `getHardwareInfo()` reports which mode the device is in.

- **15 to 60 dB**, and a value outside that fails the `make` with a reason rather
  than being quietly clamped to something else for the life of the device. 15 dB
  is where the added noise (0.14 dB on the floor) stops being resolvable by a
  receiver's own readings; past 60 dB the request buys nothing. `0` means the
  same as leaving the argument off.
- **Needs UberSDR 0.1.64 or later.** A server that has never heard of
  `min_margin` ignores it and sends the lossless stream, so nothing breaks.
- Packets coded this way declare their own profile, and a decoder that does not
  implement it refuses them rather than playing noise — which is why the mode is
  reachable only by asking for it. `test/run.sh` decodes a scaled stream the
  server's own encoder produced and compares the samples, as it does for the
  lossless one.

## Wide IQ Modes

| Mode | Sample Rate | Bandwidth | Use Case |
|------|-------------|-----------|----------|
| iq48 | 48 kHz | 48 kHz | Single band monitoring |
| iq96 | 96 kHz | 96 kHz | Multi-signal decoding |
| iq192 | 192 kHz | 192 kHz | Wide spectrum analysis |
| iq384 | 384 kHz | 384 kHz | Full band coverage |

**Note**: Wide IQ modes require either a bypassed IP or a valid password on the UberSDR server. Check with your server administrator for access credentials.

## Frequency Tuning

The driver advertises whatever the receiver covers, which it reads from
`/api/description` when the device is created. The range is not fixed: it follows the
radiod front end sample rate, so a 64.8 Msps RX888 reaches 30 MHz and a 129.6 Msps one
reaches 60 MHz, with 6 m inside it.

- **Minimum**: 10 kHz, or whatever `tuning_range.min_frequency` says
- **Maximum**: `tuning_range.max_frequency`; 30 MHz on a stock receiver

When the receiver cannot be reached, or is running a server too old to publish the
object, the driver advertises 10 kHz - 30 MHz — exactly what it always did. Hosts such as
GQRX, CubicSDR and GNU Radio clamp their own tuning UI to what `getFrequencyRange()`
returns, so this is the number that decides what you can tune to.

Tuning is performed by sending WebSocket commands to the server, allowing fast frequency changes within the wide bandwidth.

## Troubleshooting

### Driver Not Found

```bash
# Check if driver is installed
SoapySDRUtil --info

# Should show "ubersdr" in the list of modules
```

### Connection Failed

- Verify server URL is correct (ws:// or wss://)
- Check firewall allows WebSocket connections
- Ensure server is running and accessible
- Verify your IP is authorized for wide IQ modes, or provide a valid password
- If using password authentication, ensure the password is correct

### No Audio/Samples

- Check server logs for connection
- Verify the frequency is within the range the driver logged at startup ("Receiver tunes ...")
- Ensure selected mode is supported by server
- Check network connectivity

### Build Errors

If websocketpp is not found:

```bash
# Ubuntu/Debian
sudo apt-get install libwebsocketpp-dev

# Or download manually
git clone https://github.com/zaphoyd/websocketpp.git
sudo cp -r websocketpp/websocketpp /usr/local/include/
```

## Architecture

```
┌─────────────────────┐
│  SDR Application    │
│  (GQRX, GNU Radio)  │
└──────────┬──────────┘
           │ SoapySDR API
┌──────────▼──────────┐
│  SoapyUberSDR       │
│  Driver Module      │
└──────────┬──────────┘
           │ WebSocket
┌──────────▼──────────┐
│  KA9Q UberSDR       │
│  Server             │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│  radiod/KA9Q Radio  │
│  (SDR Hardware)     │
└─────────────────────┘
```

## Performance

- **Latency**: ~500ms (network + buffering)
- **Bandwidth**: ~1-4 Mbps depending on mode
- **CPU Usage**: Minimal (WebSocket client only)

## Limitations

- RX only (no transmit support)
- No gain control (server-side only)
- Requires network connectivity
- Wide IQ modes require server authorisation

## Development

### Debug Logging

Enable SoapySDR debug output:

```bash
export SOAPY_SDR_LOG_LEVEL=DEBUG
SoapySDRUtil --find="driver=ubersdr,server=ws://localhost:8080/ws"
```

### Code Structure

- `SoapyUberSDR.cpp`: Main driver implementation
- `CMakeLists.txt`: Build configuration
- Registration API: Device discovery and factory
- Stream API: I/Q sample streaming
- WebSocket client: Server communication

## License

BSL-1.0 (Boost Software License 1.0)

## Contributing

Contributions welcome! Please submit pull requests to the main ka9q_ubersdr repository.

## Connection Flow

1. **HTTP Connection Check**: Before connecting, the driver sends a POST request to `/connection` with the UUID and optional password
2. **Server Authorization**: Server responds with `{"allowed":true}` or `{"allowed":false,"reason":"..."}`
3. **WebSocket Connection**: If allowed, driver connects via WebSocket with UUID, mode, `format=pcm-zstd&version=4`, and optional password in query parameters
4. **I/Q Streaming**: Server sends binary lossless packets, decoded by `pcm_v4.hpp`
5. **Frequency Control**: Driver sends JSON tune commands for frequency changes

## Wire Format

The driver requests `format=pcm-zstd&version=4` — the lossless path, which is
the only one that makes sense for I/Q, at the only protocol version it reads.
`pcm-zstd` is still the server's name for that format, but from version 4 what
it carries is not zstd:

- **Packet**: a `PCM4` magic, a flags byte, then only the fields that changed
  since the last packet — sample rate, channel count, sample count and the two
  signal levels are each re-sent when they move and every five seconds
  regardless. About 9 bytes against the 37 versions 2 and 3 spent on every one.
- **Body**: each sample is predicted from those before it by an adaptive complex
  filter and only the prediction error is sent, Rice coded. The filter is
  *backward* adaptive — its taps come from samples already decoded — so no
  coefficients travel and the decoder recomputes them independently.
- **Bandwidth**: 384 kHz I/Q falls from 1590 kB/s to 1116, and 48 kHz from 199.6
  to 140.4 — about 30%. zstd achieved nothing at all here: it is an LZ77 matcher
  over bytes, and a band-limited RF signal has no repeated byte strings, so
  every IQ mode measured at 0.99x, the compressed stream *larger* than the
  samples it carried.
- **Lossless**: bit-exact, and checked as such. All state is integer with
  shifts, never floating point, so the C++ decoder and the Go encoder agree on
  every platform. `test/run.sh` decodes a stream the server's own encoder
  produced and compares the samples that come back.
- **Requires UberSDR 0.1.63 or later.** Older servers clamp the requested
  version to 1-3 and answer with version 1 rather than refusing; the driver
  recognises those frames and says so.

## Password Authentication

The driver supports password-based bypass authentication for accessing wide IQ modes without requiring IP whitelisting:

```bash
# Using password with SoapySDRUtil
SoapySDRUtil --find="driver=ubersdr,server=ws://localhost:8080/ws,password=your-secret-password"

# Using password with GQRX
# Device string: ubersdr,server=ws://your-server:8080/ws,mode=iq192,password=your-secret-password

# Using password with GNU Radio
sdr = SoapySDR.Device(dict(
    driver="ubersdr",
    server="ws://localhost:8080/ws",
    mode="iq384",
    password="your-secret-password"
))
```

The password is sent securely in:
- The `/connection` HTTP POST request body
- The WebSocket connection URL query parameters

**Security Note**: Use WSS (WebSocket Secure) when transmitting passwords over untrusted networks.

## See Also

- [KA9Q UberSDR](https://github.com/madpsy/ka9q_ubersdr)
- [SoapySDR](https://github.com/pothosware/SoapySDR)
- [GQRX](https://gqrx.dk/)
- [CubicSDR](https://cubicsdr.com/)
- [GNU Radio](https://www.gnuradio.org/)