# HPSDR Protocol 2 Support in UberSDR

UberSDR now includes full support for HPSDR Protocol 2, allowing HPSDR-compatible clients to connect and use UberSDR as if it were a Hermes or Hermes Lite SDR device.

## Overview

HPSDR Protocol 2 is the OpenHPSDR Ethernet Protocol v4.3, used by many popular SDR applications. UberSDR emulates this protocol, translating between HPSDR's UDP-based protocol and UberSDR's internal radiod/session architecture.

## Supported Clients

The following HPSDR-compatible clients have been tested or are expected to work:

- **SparkSDR** (https://www.sparksdr.com) - Modern SDR application
- **Thetis** (https://github.com/ramdor/Thetis) - OpenHPSDR console
- **linHPSDR** (https://github.com/g0orx/linhpsdr) - Linux HPSDR client
- **piHPSDR** (https://github.com/dl1ycf/pihpsdr) - Raspberry Pi HPSDR client
- **SkimServer** (https://www.dxatlas.com/SkimServer) - CW skimming server
- **RttySkimServ** (https://www.dxatlas.com/RttySkimServ) - RTTY skimming server

## Configuration

Add the following to your `config.yaml`:

```yaml
server:
  # ... other server settings ...
  
  # HPSDR Protocol 2 compatibility
  enable_hpsdr: true                    # Enable HPSDR Protocol 2 (default: false)
  hpsdr_interface: ""                   # Network interface (empty = all interfaces)
  hpsdr_mac_address: ""                 # MAC address (auto-detected if empty)
  hpsdr_num_receivers: 8                # Number of receivers (1-8, default: 8)
  hpsdr_device_type: "hermes"           # Device type: "hermes" or "hermes_lite"
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enable_hpsdr` | bool | `false` | Enable/disable HPSDR Protocol 2 support |
| `hpsdr_interface` | string | `""` | Network interface to bind to (empty = all) |
| `hpsdr_mac_address` | string | `""` | MAC address to report (auto-detected if empty) |
| `hpsdr_num_receivers` | int | `8` | Number of receivers to emulate (1-8) |
| `hpsdr_device_type` | string | `"hermes"` | Device type: `"hermes"` or `"hermes_lite"` |

## How It Works

### Architecture

```
HPSDR Client (SparkSDR, Thetis, etc.)
    ↓ UDP Protocol 2 (ports 1024-1042)
Protocol2Handler
    ↓ Creates UberSDR sessions with IQ modes
SessionManager
    ↓ Requests IQ streams from radiod
RadiodController
    ↓ RTP multicast
radiod (ka9q-radio)
    ↓ IQ samples
AudioReceiver
    ↓ Delivers to session
Protocol2Handler
    ↓ Converts PCM stereo to complex64
Protocol2Server
    ↓ Encodes as 24-bit IQ
HPSDR Client receives IQ data
```

### Protocol Details

**UDP Ports Used:**
- **1024** - Discovery and general packets (bidirectional)
- **1025** - DDC-specific configuration (receive)
- **1026** - Microphone audio (send, silence)
- **1027** - High priority control (receive)
- **1035-1042** - IQ data streams (send, one per receiver)

**Sample Rates:**
- 48 kHz → UberSDR `iq48` mode
- 96 kHz → UberSDR `iq96` mode
- 192 kHz → UberSDR `iq192` mode (maximum supported)
- 384/768/1536 kHz → Clamped to `iq192` (192 kHz maximum)

**IQ Data Format:**
- 24-bit signed integers (big-endian)
- 238 samples per packet
- 1444 bytes total per packet
- Format: [I_high, I_mid, I_low, Q_high, Q_mid, Q_low] × 238

## Multi-Receiver Support

HPSDR Protocol 2 supports up to 8 independent receivers, each with:
- Independent frequency tuning
- Independent sample rate (48-384 kHz)
- Independent enable/disable state
- Separate UDP port (1035-1042)

Each receiver creates a separate UberSDR session with its own IQ stream from radiod.

## Data Flow

### 1. Discovery
```
Client → UDP 1024: Discovery request (60 bytes, 00 00 00 00 02)
Server → UDP 1024: Discovery response (MAC, device type, firmware version)
```

### 2. Start Radio
```
Client → UDP 1024: General packet (60 bytes, 00 00 00 00 00)
Server: Starts receiver threads
```

### 3. Configure Receivers
```
Client → UDP 1025: DDC enable bits + sample rates
Client → UDP 1027: Frequencies for each receiver
Server: Creates UberSDR sessions with appropriate IQ modes
```

### 4. Stream IQ Data
```
Server → UDP 1035-1042: IQ packets (1444 bytes, 238 samples each)
  - Reads from session.AudioChan (stereo PCM: I=left, Q=right)
  - Converts to complex64
  - Encodes as 24-bit IQ
  - Sends to client
```

## Implementation Files

- **[`protocol2.go`](protocol2.go)** - Core HPSDR Protocol 2 server (UDP listeners, packet encoding)
- **[`protocol2_handler.go`](protocol2_handler.go)** - UberSDR integration (session management, IQ data flow)
- **[`config.go`](config.go)** - Configuration structure
- **[`main.go`](main.go)** - Initialization and lifecycle management

## Comparison with KiwiSDR Emulation

| Feature | KiwiSDR | HPSDR Protocol 2 |
|---------|---------|------------------|
| Transport | WebSocket over HTTP | Raw UDP |
| Ports | Single HTTP port | Multiple UDP ports (1024-1042) |
| Audio Format | PCM/ADPCM | 24-bit IQ |
| Sample Rates | 12 kHz (audio) | 48-384 kHz (IQ) |
| Receivers | 1 per connection | Up to 8 simultaneous |
| Discovery | HTTP /status | UDP discovery protocol |
| Integration | WebSocket handler | UDP server + handler |

## Limitations

1. **Wideband Spectrum** - Not yet implemented (would require raw ADC samples)
2. **High Sample Rates** - Maximum sample rate is 192 kHz. Requests for 384 kHz, 768 kHz, or 1536 kHz are automatically clamped to 192 kHz
3. **Transmit** - Not supported (receive-only)

## Testing

### 1. Enable in Configuration
```yaml
server:
  enable_hpsdr: true
  hpsdr_num_receivers: 8
```

### 2. Start UberSDR
```bash
./ka9q_ubersdr -config config.yaml
```

Look for log message:
```
HPSDR Protocol 2 server started on UDP ports 1024-1042 (8 receivers)
HPSDR clients (SparkSDR, Thetis, linHPSDR, SkimServer, etc.) can now connect
```

### 3. Connect HPSDR Client

**SparkSDR:**
1. Launch SparkSDR
2. Click "Discover"
3. Should see "UberSDR" device
4. Click "Start"

**Thetis:**
1. Launch Thetis
2. Setup → Radio → Discover
3. Select UberSDR device
4. Click "Start"

**SkimServer (CW Skimming):**
1. Configure SkimServer for HPSDR device
2. Set IP address to UberSDR host
3. Start skimming
4. Can run multiple receivers for multi-band skimming

## Troubleshooting

### Discovery Not Working

**Problem:** HPSDR client can't find UberSDR device

**Solutions:**
1. Check firewall allows UDP ports 1024-1042
2. Ensure client and server on same network (or routed properly)
3. Check `hpsdr_interface` setting if using multiple interfaces
4. Verify MAC address is being reported correctly

### No IQ Data

**Problem:** Client connects but receives no IQ data

**Solutions:**
1. Check radiod is running and accessible
2. Verify IQ modes are working (test with WebSocket client first)
3. Check logs for session creation errors
4. Ensure sample rate is supported (48/96/192/384 kHz)

### Sample Rate Issues

**Problem:** Client requests sample rates above 192 kHz (384/768/1536 kHz)

**Solution:** Sample rates above 192 kHz are automatically clamped to 192 kHz. This is logged:
```
Protocol2: DDC0 requested 384 kHz, clamping to 192 kHz maximum
Bridge: Sample rate 384 kHz exceeds maximum, clamping to 192 kHz
```

This ensures compatibility with UberSDR's IQ mode limitations while maintaining stable operation.

## Performance

Each HPSDR receiver creates:
- 1 UberSDR session
- 1 radiod channel
- 1 IQ stream (RTP multicast)
- 1 UDP sender thread

With 8 receivers at 384 kHz:
- Network: ~8 × 384 kHz × 2 channels × 2 bytes = ~12 Mbps
- CPU: Minimal (mostly data copying and format conversion)

## Advanced Usage

### Multi-Instance Support

Run multiple UberSDR instances with HPSDR Protocol 2:

1. Use different network interfaces or virtual interfaces
2. Configure `hpsdr_interface` for each instance
3. Each instance gets unique MAC address
4. Clients can discover and use both instances

### CW Skimming with SkimServer

Configure SkimServer to use multiple receivers:
1. Set up 8 receivers in SkimServer
2. Each receiver tunes to different band
3. UberSDR creates 8 separate IQ streams
4. SkimServer processes all bands simultaneously

Example bands for 8-receiver skimming:
- RX0: 160m (1.830 MHz CW)
- RX1: 80m (3.530 MHz CW)
- RX2: 40m (7.030 MHz CW)
- RX3: 30m (10.120 MHz CW)
- RX4: 20m (14.030 MHz CW)
- RX5: 17m (18.090 MHz CW)
- RX6: 15m (21.030 MHz CW)
- RX7: 10m (28.030 MHz CW)

## Protocol Compliance

UberSDR's HPSDR Protocol 2 implementation is **fully compliant** with:
- OpenHPSDR Ethernet Protocol v4.3 specification
- All packet formats and timing requirements
- Discovery, control, and data protocols
- Multi-receiver operation (up to 8)

## References

- [OpenHPSDR Protocol Specification](https://github.com/TAPR/OpenHPSDR-Firmware/blob/master/Protocol%202/Documentation/openHPSDR%20Ethernet%20Protocol%20v4.3.pdf)
- [ka9q_hpsdr Reference Implementation](https://github.com/n1gp/ka9q_hpsdr) by N1GP
- [PROTOCOL2_COMPARISON.md](PROTOCOL2_COMPARISON.md) - Detailed comparison with reference implementation

## Credits

HPSDR Protocol 2 implementation based on ka9q_hpsdr by Rick Koch, N1GP, with adaptations for UberSDR's architecture.
