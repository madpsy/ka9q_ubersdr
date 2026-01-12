# UberSDR to HPSDR Bridge (Protocol 1 & 2)

This bridge connects to a UberSDR server via WebSocket and emulates an HPSDR (High Performance Software Defined Radio) device. It supports both **Protocol 1** (Metis/Hermes) and **Protocol 2** (Hermes-Lite2), allowing a wide range of HPSDR-compatible software to use UberSDR as a backend.

## Features

- **Dual Protocol Support**: Choose between Protocol 1 or Protocol 2
  - **Protocol 1** (Metis/Hermes): Compatible with SDR Console and older HPSDR software
  - **Protocol 2** (Hermes-Lite2): Compatible with Thetis, PowerSDR, Spark SDR, and modern software
- Supports up to 10 independent receivers (Protocol 2) or 4 receivers (Protocol 1)
- Automatic sample rate detection and conversion
- IQ mode support (48, 96, 192 kHz)
- Discovery protocol support for both protocols
- Dynamic frequency tuning
- Password-protected UberSDR connections
- SSL/TLS support for secure connections

## Building

```bash
cd clients/hpsdr
go build -o ubersdr-hpsdr-bridge
```

## Usage

### Basic Usage (Auto-Detect - Default)

Connect to a local UberSDR server with automatic protocol detection:

```bash
./ubersdr-hpsdr-bridge --url http://localhost:8073
```

The bridge will automatically detect whether your client is using Protocol 1 or Protocol 2 based on the discovery packet format, and respond accordingly. This means **SDR Console, Thetis, PowerSDR, and other HPSDR software will all work without any configuration changes**.

### Force Specific Protocol (Optional)

If you want to force a specific protocol only:

```bash
# Force Protocol 1 only (for SDR Console)
./ubersdr-hpsdr-bridge --url http://localhost:8073 --protocol 1

# Force Protocol 2 only (for Thetis/PowerSDR)
./ubersdr-hpsdr-bridge --url http://localhost:8073 --protocol 2
```

### Remote Server with Password

Connect to a remote UberSDR server with TLS and password:

```bash
./ubersdr-hpsdr-bridge --url https://sdr.example.com --password mypass
```

### Custom HPSDR Configuration

Emulate a Hermes device with 4 receivers using Protocol 1:

```bash
./ubersdr-hpsdr-bridge --url http://localhost:8073 --protocol 1 --device 1 --receivers 4
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

- `--protocol` - HPSDR protocol version: 0, 1, or 2 (default: 0=auto-detect)
  - **0 (auto-detect)**: Automatically responds to both Protocol 1 and Protocol 2 clients
  - **1 (Protocol 1 only)**: Metis/Hermes format only (for SDR Console, older software)
  - **2 (Protocol 2 only)**: Hermes-Lite2 format only (for Thetis, PowerSDR, Spark SDR)
- `--ip` - IP address for HPSDR server (default: "0.0.0.0")
- `--interface` - Network interface to bind to (optional)
- `--receivers` - Number of receivers (default: 10)
  - Protocol 2: 1-10 receivers
  - Protocol 1: 1-4 receivers
- `--device` - Device type: 1=Hermes, 6=HermesLite (default: 6)

### Debug Options

- `--debug-discovery` - Enable detailed logging of port 1024 discovery packets
  - Shows hex dumps of all packets received and sent on the discovery port
  - Useful for troubleshooting connection issues with specific HPSDR clients (e.g., SDR Console)

## How It Works

1. The bridge starts an HPSDR server (Protocol 1 or 2) that listens for discovery and control packets
2. When an HPSDR client connects and enables a receiver, the bridge:
   - Connects to the UberSDR server via WebSocket
   - Requests IQ data at the appropriate sample rate
   - Converts the received IQ data to the selected HPSDR protocol format
   - Sends the data to the HPSDR client
3. When the HPSDR client changes frequency, the bridge sends a tune message to UberSDR
4. Multiple receivers can be active simultaneously (up to 10 for Protocol 2, up to 4 for Protocol 1)

## HPSDR Protocol Ports

### Protocol 1 (Metis/Hermes)
- **1024** - Discovery, control, and IQ data (all on same port)

### Protocol 2 (Hermes-Lite2)
- **1024** - Discovery and general control
- **1025** - DDC-specific configuration
- **1026** - Microphone audio (silence)
- **1027** - High priority control
- **1035-1044** - Receiver IQ data (one port per receiver)

Make sure these ports are not blocked by your firewall.

## Compatible Software

### Protocol 1 Compatible
- **SDR Console** - Professional SDR software (use `--protocol 1`)
- Older HPSDR software expecting Metis/Hermes protocol

### Protocol 2 Compatible
- **PowerSDR** / **Thetis** - Popular SDR control software (default)
- **CW Skimmer** - CW decoding and skimming
- **HDSDR** - General purpose SDR software
- **Quisk** - Python-based SDR software
- **SparkSDR** - Modern SDR application

## Limitations

- Wideband spectrum data is not currently supported
- Transmit functionality is not implemented (receive only)
- Only IQ modes are supported (not audio modes like USB/LSB)
- Sample rate is clamped to maximum of 192 kHz
- **Protocol 1 specific limitations:**
  - 16-bit samples (vs 24-bit in Protocol 2) - lower dynamic range
  - Maximum 4 receivers (vs 10 in Protocol 2)
  - Control packet parsing is basic (frequency tuning works, advanced features may not)

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

### SDR Console doesn't connect

With the default auto-detect mode, SDR Console should work automatically. If you're having issues, enable debug logging:

```bash
./ubersdr-hpsdr-bridge --url http://localhost:8080 --debug-discovery
```

The `--debug-discovery` flag will show detailed hex dumps of all discovery packets on port 1024, including:
- What SDR Console is sending (Protocol 1: `ef fe 02`)
- What the bridge is responding with
- Any packet format differences

Common issues:
- SDR Console may be looking on a specific network interface
- Firewall may be blocking UDP broadcast packets on port 1024
- Multiple HPSDR devices on the network may cause conflicts

If auto-detect isn't working, you can force Protocol 1 only mode:
```bash
./ubersdr-hpsdr-bridge --url http://localhost:8080 --protocol 1
```

### No audio/IQ data

- Check that the receiver is enabled in the HPSDR client
- Verify the frequency is within the UberSDR server's coverage
- Look at the bridge logs for connection and data flow information

### Performance issues

- Reduce the number of active receivers
- Use a lower sample rate (48 or 96 kHz instead of 192 or 384 kHz)
- Ensure good network connectivity between bridge and UberSDR server

## Development

The bridge consists of three main components:

1. **protocol1.go** - HPSDR Protocol 1 (Metis/Hermes) server implementation
2. **protocol2.go** - HPSDR Protocol 2 (Hermes-Lite2) server implementation
3. **main.go** - Bridge logic connecting UberSDR to HPSDR

To modify or extend the bridge:

- See `plans/hpsdr_protocol1_implementation.md` for Protocol 1 details
- The `Protocol1Server` handles Protocol 1 operations (16-bit samples, single port)
- The `Protocol2Server` handles Protocol 2 operations (24-bit samples, multiple ports)
- The `UberSDRBridge` manages the WebSocket connection and data conversion for both protocols

## License

This software is part of the ka9q_ubersdr project and follows the same license terms.

## References

- [OpenHPSDR Protocol 2 Documentation](https://github.com/TAPR/OpenHPSDR-Firmware/tree/master/Protocol%202/Documentation)
- [UberSDR Documentation](../../README.md)
- [HPSDR Protocol 2 Comparison](../../PROTOCOL2_COMPARISON.md)
