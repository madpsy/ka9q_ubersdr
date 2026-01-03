# UberSDR to HPSDR Protocol 2 Bridge

This bridge connects to a UberSDR server via WebSocket and emulates an HPSDR (High Performance Software Defined Radio) device using Protocol 2. This allows HPSDR-compatible software (like PowerSDR, Thetis, CW Skimmer, etc.) to use UberSDR as a backend.

## Features

- Emulates HPSDR Protocol 2 (compatible with Hermes, HermesLite, and other HPSDR devices)
- Supports up to 8 independent receivers
- Automatic sample rate detection and conversion
- IQ mode support (48, 96, 192, 384 kHz)
- Discovery protocol support
- Dynamic frequency tuning
- Password-protected UberSDR connections
- SSL/TLS support for secure connections

## Building

```bash
cd clients/hpsdr
go build -o ubersdr-hpsdr-bridge
```

## Usage

### Basic Usage

Connect to a local UberSDR server:

```bash
./ubersdr-hpsdr-bridge --url http://localhost:8073
```

### Remote Server with Password

Connect to a remote UberSDR server with TLS and password:

```bash
./ubersdr-hpsdr-bridge --url https://sdr.example.com --password mypass
```

### Custom HPSDR Configuration

Emulate a Hermes device with 4 receivers:

```bash
./ubersdr-hpsdr-bridge --url http://localhost:8073 --device 1 --receivers 4
```

Bind to a specific IP address:

```bash
./ubersdr-hpsdr-bridge --url http://localhost:8073 --ip 192.168.1.100
```

## Command-Line Options

### UberSDR Connection Options

- `--url` - UberSDR server URL (default: "http://localhost:8073")
  - Accepts http://, https://, ws://, or wss://
  - http/https will be automatically converted to ws/wss for WebSocket connection
- `--password` - UberSDR server password (optional)

### HPSDR Emulation Options

- `--ip` - IP address for HPSDR server (default: "0.0.0.0")
- `--interface` - Network interface to bind to (optional)
- `--receivers` - Number of receivers 1-8 (default: 8)
- `--device` - Device type: 1=Hermes, 6=HermesLite (default: 6)

## How It Works

1. The bridge starts an HPSDR Protocol 2 server that listens for discovery and control packets
2. When an HPSDR client (like PowerSDR) connects and enables a receiver, the bridge:
   - Connects to the UberSDR server via WebSocket
   - Requests IQ data at the appropriate sample rate
   - Converts the received IQ data to HPSDR Protocol 2 format
   - Sends the data to the HPSDR client
3. When the HPSDR client changes frequency, the bridge sends a tune message to UberSDR
4. Multiple receivers can be active simultaneously (up to 8)

## HPSDR Protocol 2 Ports

The bridge uses the following UDP ports for HPSDR Protocol 2:

- **1024** - Discovery and general control
- **1025** - DDC-specific configuration
- **1026** - Microphone audio (silence)
- **1027** - High priority control
- **1035-1042** - Receiver IQ data (one port per receiver)

Make sure these ports are not blocked by your firewall.

## Compatible Software

This bridge should work with any HPSDR Protocol 2 compatible software, including:

- **PowerSDR** / **Thetis** - Popular SDR control software
- **CW Skimmer** - CW decoding and skimming
- **HDSDR** - General purpose SDR software
- **Quisk** - Python-based SDR software
- **SparkSDR** - Modern SDR application

## Limitations

- Wideband spectrum data is not currently supported
- Transmit functionality is not implemented (receive only)
- Only IQ modes are supported (not audio modes like USB/LSB)
- Sample rate is determined by the HPSDR client request (48, 96, 192, or 384 kHz)

## Troubleshooting

### Bridge doesn't connect to UberSDR

- Check that the UberSDR server is running and accessible
- Verify the hostname, port, and password are correct
- Try without SSL first to rule out certificate issues

### HPSDR client can't find the device

- Make sure the bridge is running before starting the HPSDR client
- Check that UDP ports 1024-1042 are not blocked by firewall
- Try binding to a specific IP address with `--ip`
- Some clients may need to be configured to look for the device on the correct network interface

### No audio/IQ data

- Check that the receiver is enabled in the HPSDR client
- Verify the frequency is within the UberSDR server's coverage
- Look at the bridge logs for connection and data flow information

### Performance issues

- Reduce the number of active receivers
- Use a lower sample rate (48 or 96 kHz instead of 192 or 384 kHz)
- Ensure good network connectivity between bridge and UberSDR server

## Development

The bridge consists of two main components:

1. **protocol2.go** - HPSDR Protocol 2 server implementation
2. **main.go** - Bridge logic connecting UberSDR to HPSDR

To modify or extend the bridge:

- See `HPSDR_PROTOCOL2.md` in the root directory for protocol details
- The `Protocol2Server` handles all HPSDR protocol operations
- The `UberSDRBridge` manages the WebSocket connection and data conversion

## License

This software is part of the ka9q_ubersdr project and follows the same license terms.

## References

- [OpenHPSDR Protocol 2 Documentation](https://github.com/TAPR/OpenHPSDR-Firmware/tree/master/Protocol%202/Documentation)
- [UberSDR Documentation](../../README.md)
- [HPSDR Protocol 2 Comparison](../../PROTOCOL2_COMPARISON.md)
