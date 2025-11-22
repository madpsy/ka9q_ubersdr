# UberSDRIntf

CW Skimmer Server plugin for ka9q_ubersdr WebSocket-based Software Defined Radio servers.

## Overview

UberSDRIntf.dll is a Windows DLL that bridges CW Skimmer Server with ka9q_ubersdr servers, enabling up to 8 simultaneous IQ streams for multi-receiver operation. It provides the same API as HermesIntf.dll, making it a drop-in replacement for WebSocket-based SDR servers.

## Features

- **Multi-Receiver Support**: Up to 8 simultaneous IQ streams
- **Adaptive Sample Rates**: Automatically selects iq48, iq96, or iq192 mode based on requested sample rate
- **WebSocket Communication**: Modern WebSocket protocol with JSON messaging
- **Flexible Configuration**: Configure server host and port via DLL filename
- **HermesIntf Compatible**: Drop-in replacement using the same API
- **Connection Validation**: Pre-connection checks for IP bans and session limits
- **Auto-Reconnect**: Automatic reconnection with exponential backoff
- **Comprehensive Logging**: Detailed logging to UberSDRIntf_log_file.txt

## Installation

1. Build the DLL or download the pre-built binary
2. Copy `UberSDRIntf.dll` to your CW Skimmer Server directory
   - Example: `C:\Program Files (x86)\Afreet\SkimSrv`
3. Optionally rename the DLL to configure server connection (see Configuration below)
4. Start CW Skimmer Server and select "UberSDR-IQ192" from the receiver dropdown

## Configuration

### Default Configuration
```
UberSDRIntf.dll
```
Connects to `localhost:8080` (default ka9q_ubersdr server)

### IP Address Configuration
```
UberSDRIntf_192.168.1.100.dll
```
Connects to `192.168.1.100:8080` (default port)

### IP Address + Port Configuration
```
UberSDRIntf_192.168.1.100_8073.dll
```
Connects to `192.168.1.100:8073`

### Hostname Configuration
```
UberSDRIntf_radio.example.com.dll
```
Connects to `radio.example.com:8080` (default port)

### Hostname + Port Configuration
```
UberSDRIntf_radio.example.com_8073.dll
```
Connects to `radio.example.com:8073`

### Multiple Servers
You can have multiple DLL copies for different servers:
```
UberSDRIntf_server1.local_8073.dll
UberSDRIntf_server2.local_8073.dll
UberSDRIntf_192.168.1.100_8080.dll
```
Each will appear as a separate entry in the CW Skimmer receiver dropdown.

## Sample Rate Mapping

The DLL automatically selects the appropriate IQ mode based on the requested sample rate:

| Skimmer Rate | IQ Mode | Actual Rate | Bandwidth |
|--------------|---------|-------------|-----------|
| 48 kHz       | iq48    | 48000 Hz    | ±24 kHz   |
| 96 kHz       | iq96    | 96000 Hz    | ±48 kHz   |
| 192 kHz      | iq192   | 192000 Hz   | ±96 kHz   |

## WebSocket Protocol

### Connection Flow

1. **HTTP POST to `/connection`**
   - Validates IP address and session limits
   - Returns permission status

2. **WebSocket Connection**
   - URL: `ws://host:port/ws?frequency=X&mode=iqNN&user_session_id=UUID`
   - Headers: `User-Agent: UberSDR Client 1.0 (dll)`

3. **Message Exchange**
   - Server → Client: Audio data (Base64-encoded IQ samples)
   - Client → Server: Ping (keepalive every 30s)
   - Server → Client: Pong (keepalive response)

### Message Format

**Audio Data (Server → Client)**:
```json
{
  "type": "audio",
  "data": "base64-encoded-iq-data",
  "sampleRate": 192000,
  "channels": 2
}
```

**Ping (Client → Server)**:
```json
{
  "type": "ping"
}
```

**Error (Server → Client)**:
```json
{
  "type": "error",
  "error": "Error description"
}
```

## Data Processing Pipeline

```
WebSocket → Base64 Decode → Big-Endian → Little-Endian → Float I/Q → Skimmer
```

1. **Receive**: WebSocket message with Base64-encoded IQ data
2. **Decode**: Base64 string to binary bytes
3. **Convert**: Big-endian int16 I/Q to little-endian
4. **Transform**: int16 to float32 I/Q samples
5. **Buffer**: Accumulate samples to match BLOCKS_PER_SEC (93.75)
6. **Callback**: Invoke Skimmer's IQProc callback with buffered data

## Building from Source

### Prerequisites

- Visual Studio 2019 or later
- Windows SDK
- WinSock2 library (included with Windows SDK)

### Build Steps

1. Open `UberSDRIntf.sln` in Visual Studio
2. Select Release configuration
3. Build Solution (Ctrl+Shift+B)
4. Output: `Release/UberSDRIntf.dll`

### Dependencies

- **WinSock2**: For network communication
- **Windows API**: For DLL operations and threading

## Logging

All operations are logged to `UberSDRIntf_log_file.txt` in the same directory as the DLL.

Log entries include:
- DLL initialization and configuration
- Server connection attempts and results
- WebSocket connection status
- Frequency changes
- Error conditions
- Data flow statistics

Example log:
```
2025-01-19 13:54:00.123: DLL filename: UberSDRIntf_192.168.1.100_8073
2025-01-19 13:54:00.124: Configuration from filename: 192.168.1.100:8073
2025-01-19 13:54:00.125: UberSDR initialized with server: 192.168.1.100:8073
2025-01-19 13:54:01.234: Connected to UberSDR server at 192.168.1.100:8073
2025-01-19 13:54:02.345: StartRx: 8 receivers at 192 kHz (iq192 mode)
2025-01-19 13:54:02.456: Receiver 0: Connected to ws://192.168.1.100:8073/ws
2025-01-19 13:54:03.567: SetRxFrequency Rx#0 Frequency: 14074000
```

## Troubleshooting

### Connection Refused
- Verify ka9q_ubersdr server is running
- Check hostname/IP address in DLL filename
- Verify port number (default: 8080)
- Check firewall settings

### No Audio/IQ Data
- Check log file for connection errors
- Verify server is sending data (check server logs)
- Ensure correct sample rate is selected in Skimmer
- Try restarting both server and Skimmer

### Multiple Receivers Not Working
- Verify server supports multiple simultaneous connections
- Check server session limits
- Review server logs for connection rejections
- Ensure sufficient bandwidth

### DLL Not Loading
- Verify DLL is in correct directory
- Check Windows Event Viewer for load errors
- Ensure all dependencies are available
- Try running Skimmer as Administrator

## API Compatibility

UberSDRIntf implements the same API as HermesIntf:

| Function | Purpose | Status |
|----------|---------|--------|
| `GetSdrInfo()` | Returns device capabilities | ✅ Implemented |
| `StartRx()` | Starts receivers | ✅ Implemented |
| `StopRx()` | Stops receivers | ✅ Implemented |
| `SetRxFrequency()` | Sets receiver frequency | ✅ Implemented |
| `SetCtrlBits()` | Control bits (no-op) | ✅ Stub |
| `ReadPort()` | Read port (no-op) | ✅ Stub |

## Performance

- **Latency**: ~100ms (WebSocket + buffering)
- **CPU Usage**: Low (async I/O, minimal processing)
- **Memory**: ~10MB per receiver
- **Network**: ~3 Mbps per receiver at 192 kHz

## Known Limitations

- SSL/TLS (wss://) not yet implemented
- No automatic server discovery
- Requires manual DLL renaming for configuration
- Windows only (uses WinSock2 and Windows API)

## Future Enhancements

- [ ] SSL/TLS support for secure WebSocket (wss://)
- [ ] Configuration file support (alternative to filename)
- [ ] Server discovery via mDNS/Bonjour
- [ ] Performance metrics and statistics
- [ ] GUI configuration tool
- [ ] Linux/macOS support (via Wine or native port)

## License

This project follows the same license as HermesIntf.

## Author

Based on HermesIntf by K3IT, adapted for ka9q_ubersdr WebSocket protocol.

## Support

For issues, questions, or contributions, please check the log file first, then contact the maintainer.

## Version History

### v1.0.0 (2025-01-19)
- Initial release
- Support for up to 8 IQ streams
- Automatic iq48/iq96/iq192 mode selection
- Filename-based configuration
- WebSocket communication with ka9q_ubersdr
- HermesIntf API compatibility