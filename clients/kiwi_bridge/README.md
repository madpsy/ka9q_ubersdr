# UberSDR KiwiSDR Protocol Bridge

This bridge allows KiwiSDR clients (like `kiwirecorder.py`) to connect to UberSDR by translating between the KiwiSDR WebSocket protocol and UberSDR's protocol.

## Features

- **Protocol Translation**: Converts KiwiSDR WebSocket messages to UberSDR JSON format
- **Multiple Sessions**: Supports multiple concurrent KiwiSDR client connections
- **Audio Streaming**: Translates UberSDR audio to KiwiSDR SND format with optional IMA ADPCM compression
- **Command Translation**: Handles KiwiSDR SET commands (frequency, mode, AGC, etc.)
- **Transparent Operation**: KiwiSDR clients see the bridge as a real KiwiSDR server

## Installation

### Requirements

- Python 3.7 or later
- UberSDR server running and accessible

### Install Dependencies

```bash
pip install -r requirements.txt
```

Or manually:

```bash
pip install websockets aiohttp numpy
```

## Usage

### Basic Usage

Start the bridge to connect to a local UberSDR instance:

```bash
python3 ubersdr_kiwi_bridge.py --ubersdr-host localhost --ubersdr-port 8080 --listen-port 8073
```

Then connect `kiwirecorder.py` to the bridge as if it were a KiwiSDR:

```bash
python3 kiwirecorder.py -s localhost -p 8073 -f 10000 -m am
```

### Command Line Options

```
--ubersdr-host HOST    UberSDR host (default: localhost)
--ubersdr-port PORT    UberSDR port (default: 8080)
--listen-port PORT     Port to listen on for KiwiSDR clients (default: 8073)
--debug                Enable debug logging
```

### Examples

#### Record from remote UberSDR

```bash
# Start bridge pointing to remote UberSDR
python3 ubersdr_kiwi_bridge.py --ubersdr-host sdr.example.com --ubersdr-port 8080 --listen-port 8073

# Record audio with kiwirecorder
python3 kiwirecorder.py -s localhost -p 8073 -f 7200 -m lsb --tlimit 60
```

#### Multiple concurrent recordings

The bridge supports multiple KiwiSDR clients simultaneously. Each client gets its own UberSDR session:

```bash
# Terminal 1: Start bridge
python3 ubersdr_kiwi_bridge.py

# Terminal 2: Record 40m
python3 kiwirecorder.py -s localhost -p 8073 -f 7100 -m lsb

# Terminal 3: Record 20m (simultaneously)
python3 kiwirecorder.py -s localhost -p 8073 -f 14200 -m usb
```

#### IQ mode recording

```bash
python3 kiwirecorder.py -s localhost -p 8073 -f 10000 -m iq --tlimit 60
```

## Architecture

### Protocol Translation

The bridge acts as a protocol translator between two different WebSocket APIs:

```
KiwiSDR Client          Bridge                 UberSDR Server
(kiwirecorder.py)       (Python)               (Go)
     |                     |                        |
     |-- Kiwi WS -------->|                        |
     |   (binary)          |                        |
     |                     |-- UberSDR WS -------->|
     |                     |   (JSON)               |
     |                     |<-- Audio (JSON) ------|
     |<-- SND packets -----|                        |
     |   (binary)          |                        |
```

### Message Flow

1. **Connection**: KiwiSDR client connects to bridge with path `/<timestamp>/SND`
2. **Handshake**: Bridge creates UberSDR session via `/connection` and `/ws` endpoints
3. **Configuration**: Bridge translates KiwiSDR `SET` commands to UberSDR JSON messages
4. **Streaming**: Bridge receives UberSDR audio and formats as KiwiSDR SND packets
5. **Cleanup**: Bridge closes UberSDR session when KiwiSDR client disconnects

### KiwiSDR Protocol Support

**Implemented:**
- ✅ Audio streaming (SND packets)
- ✅ Frequency tuning
- ✅ Mode selection (AM, LSB, USB, CW, etc.)
- ✅ Bandwidth control
- ✅ IMA ADPCM compression
- ✅ Keepalive messages
- ✅ Multiple concurrent sessions

**Not Yet Implemented:**
- ⏳ Waterfall streaming (W/F packets)
- ⏳ S-meter (RSSI) values from UberSDR
- ⏳ AGC control passthrough
- ⏳ Extension support (EXT)
- ⏳ GPS timestamps

## Limitations

1. **Audio Format**: Currently assumes UberSDR sends 16-bit PCM audio
2. **Sample Rate**: Fixed at 12 kHz (KiwiSDR default)
3. **S-meter**: Uses dummy value (-50 dBm) instead of real signal strength
4. **Waterfall**: Not yet implemented
5. **Authentication**: No password support (uses UberSDR's session management)

## Troubleshooting

### Connection Refused

```
Error: Connection check failed: Maximum unique users reached
```

**Solution**: UberSDR has reached its max_sessions limit. Wait for a slot or increase the limit in UberSDR's config.yaml.

### No Audio

```
Error receiving audio: ...
```

**Solution**: Check that UberSDR is properly configured and radiod is running. Enable debug mode:

```bash
python3 ubersdr_kiwi_bridge.py --debug
```

### Protocol Errors

```
Error handling Kiwi messages: ...
```

**Solution**: Ensure you're using a compatible version of kiwirecorder.py. The bridge is tested with kiwirecorder v1.8.

## Development

### Adding New Features

The bridge is structured in three main classes:

1. **`ImaAdpcmEncoder`**: Handles audio compression
2. **`UberSDRSession`**: Manages connection to UberSDR
3. **`KiwiProtocolHandler`**: Translates between protocols
4. **`KiwiSDRBridge`**: Main server that accepts connections

### Testing

```bash
# Start bridge with debug logging
python3 ubersdr_kiwi_bridge.py --debug

# In another terminal, test with kiwirecorder
python3 kiwirecorder.py -s localhost -p 8073 -f 10000 -m am --tlimit 10
```

## License

This bridge is part of the UberSDR project. See the main project LICENSE file.

## See Also

- [UberSDR Documentation](../README.md)
- [KiwiSDR Client Repository](https://github.com/jks-prv/kiwiclient)
- [KiwiSDR Protocol Documentation](http://kiwisdr.com/)
