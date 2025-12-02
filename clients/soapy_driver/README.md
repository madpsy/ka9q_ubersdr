# SoapyUberSDR - SoapySDR Driver for KA9Q UberSDR

This is a SoapySDR driver that provides access to KA9Q UberSDR's wide IQ modes via WebSocket. It enables any SoapySDR-compatible application (GQRX, CubicSDR, GNU Radio, etc.) to connect to a KA9Q UberSDR server.

## Features

- **Wide IQ Mode Support**: Access to iq48, iq96, iq192, and iq384 modes (48-384 kHz bandwidth)
- **Network Transparent**: Connect to remote UberSDR servers via WebSocket
- **Full I/Q Streaming**: Native complex sample format for spectrum analysis and signal processing
- **Frequency Range**: 100 kHz to 30 MHz (HF bands)
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

## Wide IQ Modes

| Mode | Sample Rate | Bandwidth | Use Case |
|------|-------------|-----------|----------|
| iq48 | 48 kHz | 48 kHz | Single band monitoring |
| iq96 | 96 kHz | 96 kHz | Multi-signal decoding |
| iq192 | 192 kHz | 192 kHz | Wide spectrum analysis |
| iq384 | 384 kHz | 384 kHz | Full band coverage |

**Note**: Wide IQ modes require either a bypassed IP or a valid password on the UberSDR server. Check with your server administrator for access credentials.

## Frequency Tuning

The driver supports the full HF range:

- **Minimum**: 100 kHz (LF)
- **Maximum**: 30 MHz (10m band)

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
- Verify frequency is within 100 kHz - 30 MHz range
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
3. **WebSocket Connection**: If allowed, driver connects via WebSocket with UUID and optional password in query parameters
4. **Audio Streaming**: Server sends base64-encoded I/Q audio data
5. **Frequency Control**: Driver sends JSON tune commands for frequency changes

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