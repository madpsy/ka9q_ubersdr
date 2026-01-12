# JS8Skim Enhancements

This document describes the enhancements made to js8skim to support PCM audio format and Unix domain socket connections.

## Overview

The js8skim client has been enhanced to support two connection modes:
1. **WebSocket connections** - Always use Opus compression (best for remote connections)
2. **Unix domain socket connections** - Always use PCM format (best for local, low-latency connections)

This design simplifies the implementation while optimizing for the most common use cases:
- **Opus over WebSocket**: Lower bandwidth for remote connections
- **PCM over Unix socket**: Lowest latency and CPU usage for local IPC

## Usage

### Command Line Format

**WebSocket connections (Opus):**
```bash
./js8skim "host:port,frequency"
```

**Unix domain socket connections (PCM):**
```bash
./js8skim "unix:/path/to/socket,frequency"
```

### Parameters

- `host:port` - WebSocket server address
- `unix:/path` - Unix domain socket path
- `frequency` - Center frequency in Hz

### Examples

**WebSocket with Opus:**
```bash
./js8skim "44.31.241.13:8080,14074000"
```

**Unix socket with PCM:**
```bash
./js8skim "unix:/tmp/ubersdr.sock,14074000"
```

## Technical Details

### Audio Formats

#### Opus (WebSocket)
- Compressed audio codec
- ~16-32 KB/s bandwidth
- Higher CPU usage for encoding/decoding
- Best for remote connections over network

#### PCM (Unix Socket)
- Uncompressed int16_t samples
- ~192 KB/s at 12kHz sample rate
- Minimal CPU overhead
- Best for local IPC connections

### Connection Types

#### WebSocket
- Standard TCP/IP-based protocol
- Works over network (local or remote)
- WebSocket framing overhead
- URL format: `ws://host:port/ws?frequency=X&mode=usb&user_session_id=UUID&format=opus&version=2`

#### Unix Domain Socket
- File system-based IPC
- Only works on same machine
- Simple length-prefixed framing: `[length:4][data:length]`
- Lower latency than TCP/IP
- File system permissions for security

### Binary Packet Format

Both connection types use the same binary packet format for audio data:

```
[timestamp:8][sampleRate:4][channels:1][basebandPower:4][noiseDensity:4][audioData...]
```

**Header fields (all little-endian):**
- `timestamp` (8 bytes) - Unix timestamp in nanoseconds
- `sampleRate` (4 bytes) - Sample rate in Hz (typically 12000)
- `channels` (1 byte) - Number of audio channels (typically 1)
- `basebandPower` (4 bytes) - Baseband power in dBFS (float32)
- `noiseDensity` (4 bytes) - Noise density in dBFS/Hz (float32)

**Audio data:**
- **Opus format**: Opus-encoded audio frames
- **PCM format**: int16_t samples (little-endian)

### Implementation Details

#### Modified Files

1. **ubersdr.h**
   - Added `AudioFormat` enum (FORMAT_OPUS, FORMAT_PCM)
   - Added `ConnectionType` enum (CONN_WEBSOCKET, CONN_UNIX_SOCKET)
   - Added member variables for connection type and Unix socket path
   - Added methods: `process_pcm_packet()`, `unix_socket_loop()`, `connect_unix_socket()`

2. **ubersdr.cc**
   - Enhanced constructor to parse connection string and set format based on connection type
   - Split `process_binary_packet()` into format-specific handlers
   - Implemented Unix socket connection and framing logic
   - Updated `start()` to choose appropriate connection loop

#### Key Design Decisions

1. **Format tied to connection type**: Simplifies usage and optimizes for common scenarios
2. **Automatic downsampling**: Both formats support 2:1 downsampling when needed
3. **Backward compatibility**: Existing WebSocket/Opus connections work unchanged
4. **Simple framing for Unix sockets**: Length-prefixed frames are simpler than WebSocket framing

## Server-Side Requirements

The UberSDR Go server needs to implement:

### WebSocket Handler
- Accept `format=opus` parameter (already implemented)
- Send Opus-encoded audio in binary packets
- Handle WebSocket framing

### Unix Domain Socket Listener
- Create Unix domain socket at configured path
- Accept connections and read JSON configuration messages
- Send PCM audio with length-prefixed framing: `[length:4][packet:length]`
- Handle tune commands and heartbeats

### Configuration Message Format

Both connection types use JSON for configuration:

```json
{
  "type": "tune",
  "frequency": 14074000,
  "mode": "usb",
  "bandwidthLow": 50,
  "bandwidthHigh": 2850,
  "format": "pcm"  // or "opus"
}
```

## Performance Comparison

| Metric | Opus/WebSocket | PCM/Unix Socket |
|--------|----------------|-----------------|
| Bandwidth | ~16-32 KB/s | ~192 KB/s |
| CPU Usage | Higher (codec) | Lower (no codec) |
| Latency | Higher (network + codec) | Lowest (IPC only) |
| Use Case | Remote connections | Local co-located processes |

## Building

No changes to build process. Existing dependencies (Opus, libcurl) are still required.

```bash
cd clients/js8skim
make
```

## Testing

**Test WebSocket connection:**
```bash
./js8skim "your-server:8080,14074000"
```

**Test Unix socket connection (requires server with Unix socket support):**
```bash
./js8skim "unix:/tmp/ubersdr.sock,14074000"
```

## Future Enhancements

Potential improvements:
1. Add configuration file support for connection parameters
2. Support multiple simultaneous connections
3. Add metrics/statistics output
4. Implement automatic reconnection with exponential backoff
