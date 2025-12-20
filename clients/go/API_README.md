# UberSDR Go Client - REST API Documentation

## Overview

The UberSDR Go Client now includes a REST API and web interface for controlling the radio client. This allows you to:

- Connect/disconnect to SDR servers
- Change frequency, mode, and bandwidth on-the-fly (without reconnecting)
- Select audio output devices
- Configure NR2 noise reduction
- Monitor connection status in real-time via WebSocket

## Quick Start

### Running in API Mode

```bash
# Start the API server on default port (8090)
./radio_client --api

# Start on custom port
./radio_client --api --api-port 9000
```

Then open your browser to `http://localhost:8090` to access the web interface.

### Building

```bash
cd clients/go
go build
```

## REST API Endpoints

### Connection Management

#### POST /api/connect
Connect to an SDR server.

**Request Body:**
```json
{
  "host": "localhost",
  "port": 8080,
  "ssl": false,
  "frequency": 14074000,
  "mode": "usb",
  "bandwidthLow": 50,
  "bandwidthHigh": 2700,
  "password": "",
  "outputMode": "portaudio",
  "audioDevice": -1,
  "nr2Enabled": false,
  "nr2Strength": 40.0,
  "nr2Floor": 10.0,
  "nr2AdaptRate": 1.0
}
```

**Response:**
```json
{
  "success": true,
  "message": "Connected successfully"
}
```

#### POST /api/disconnect
Disconnect from the SDR server.

**Response:**
```json
{
  "success": true,
  "message": "Disconnected successfully"
}
```

#### GET /api/status
Get current connection status.

**Response:**
```json
{
  "connected": true,
  "frequency": 14074000,
  "mode": "usb",
  "bandwidthLow": 50,
  "bandwidthHigh": 2700,
  "sampleRate": 12000,
  "channels": 1,
  "sessionId": "abc123...",
  "userSessionId": "def456...",
  "audioDevice": "Default",
  "audioDeviceIndex": -1,
  "outputMode": "portaudio",
  "nr2Enabled": false,
  "nr2Strength": 40.0,
  "nr2Floor": 10.0,
  "nr2AdaptRate": 1.0,
  "host": "localhost",
  "port": 8080,
  "ssl": false,
  "connectedAt": "2024-01-01T12:00:00Z",
  "uptime": "5m30s"
}
```

### Tuning (On-the-Fly Changes)

#### POST /api/tune
Change frequency, mode, and/or bandwidth without reconnecting.

**Request Body:**
```json
{
  "frequency": 7074000,
  "mode": "usb",
  "bandwidthLow": 50,
  "bandwidthHigh": 2700
}
```

All fields are optional - only include the parameters you want to change.

**Response:**
```json
{
  "success": true,
  "message": "Tuned successfully"
}
```

#### POST /api/frequency
Change only the frequency.

**Request Body:**
```json
{
  "frequency": 14074000
}
```

#### POST /api/mode
Change only the mode.

**Request Body:**
```json
{
  "mode": "lsb"
}
```

**Supported Modes:**
- `usb` - Upper Sideband
- `lsb` - Lower Sideband
- `am` - Amplitude Modulation
- `sam` - Synchronous AM
- `fm` - Frequency Modulation
- `nfm` - Narrow FM
- `cwu` - CW Upper
- `cwl` - CW Lower
- `iq` - IQ (5 kHz)
- `iq48` - IQ 48 kHz
- `iq96` - IQ 96 kHz
- `iq192` - IQ 192 kHz
- `iq384` - IQ 384 kHz

#### POST /api/bandwidth
Change the bandwidth.

**Request Body:**
```json
{
  "bandwidthLow": -2700,
  "bandwidthHigh": -50
}
```

### Audio Configuration

#### GET /api/devices
List available audio output devices.

**Response:**
```json
{
  "devices": [
    {
      "index": 0,
      "name": "Built-in Audio",
      "maxChannels": 2,
      "sampleRate": 48000,
      "latency": 21.3,
      "isDefault": true
    },
    {
      "index": 1,
      "name": "USB Audio Device",
      "maxChannels": 2,
      "sampleRate": 48000,
      "latency": 10.5,
      "isDefault": false
    }
  ]
}
```

#### POST /api/device
Change audio output device (requires reconnection in current implementation).

**Request Body:**
```json
{
  "deviceIndex": 1
}
```

### Configuration

#### GET /api/config
Get current configuration.

**Response:**
```json
{
  "host": "localhost",
  "port": 8080,
  "ssl": false,
  "frequency": 14074000,
  "mode": "usb",
  "bandwidthLow": 50,
  "bandwidthHigh": 2700,
  "outputMode": "portaudio",
  "audioDevice": -1,
  "nr2Enabled": false,
  "nr2Strength": 40.0,
  "nr2Floor": 10.0,
  "nr2AdaptRate": 1.0
}
```

#### POST /api/config
Update configuration (NR2 settings).

**Request Body:**
```json
{
  "nr2Enabled": true,
  "nr2Strength": 50.0,
  "nr2Floor": 8.0,
  "nr2AdaptRate": 1.5
}
```

All fields are optional.

## WebSocket API

### Connection
Connect to `ws://localhost:8090/ws` for real-time updates.

### Message Types

#### Status Update
```json
{
  "type": "status",
  "connected": true,
  "frequency": 14074000,
  "mode": "usb",
  "sampleRate": 12000,
  "channels": 1,
  "timestamp": "2024-01-01T12:00:00Z"
}
```

#### Connection Update
```json
{
  "type": "connection",
  "connected": true,
  "reason": "Connected successfully",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

#### Error Update
```json
{
  "type": "error",
  "error": "Connection failed",
  "message": "Server unreachable",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

## Web Interface

The web interface is automatically served at the root URL (`http://localhost:8090/`) and provides:

- **Connection Panel**: Configure and connect to SDR servers
- **Frequency Control**: Adjust frequency with buttons and band presets
- **Mode & Bandwidth**: Select demodulation mode and filter bandwidth
- **Audio Settings**: Choose output device and mode
- **NR2 Configuration**: Enable and configure noise reduction
- **Status Display**: Real-time connection and audio information

## Architecture

The implementation is modular with separate files:

- `api_types.go` - Request/response type definitions
- `api_server.go` - HTTP/WebSocket server setup
- `api_handlers.go` - Helper functions for API endpoints
- `websocket_manager.go` - Thread-safe WebSocket connection management
- `radio_client.go` - Core radio client and main entry point
- `frontend/` - Static web interface files

## Examples

### Using curl

```bash
# Connect to SDR server
curl -X POST http://localhost:8090/api/connect \
  -H "Content-Type: application/json" \
  -d '{
    "host": "localhost",
    "port": 8080,
    "frequency": 14074000,
    "mode": "usb"
  }'

# Change frequency
curl -X POST http://localhost:8090/api/frequency \
  -H "Content-Type: application/json" \
  -d '{"frequency": 7074000}'

# Change mode
curl -X POST http://localhost:8090/api/mode \
  -H "Content-Type: application/json" \
  -d '{"mode": "lsb"}'

# Get status
curl http://localhost:8090/api/status

# Disconnect
curl -X POST http://localhost:8090/api/disconnect
```

### Using JavaScript

```javascript
// Connect
fetch('http://localhost:8090/api/connect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    host: 'localhost',
    port: 8080,
    frequency: 14074000,
    mode: 'usb'
  })
});

// Tune (change frequency/mode without reconnecting)
fetch('http://localhost:8090/api/tune', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    frequency: 7074000,
    mode: 'usb'
  })
});

// WebSocket for real-time updates
const ws = new WebSocket('ws://localhost:8090/ws');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Update:', data);
};
```

## Error Handling

All endpoints return appropriate HTTP status codes:

- `200 OK` - Success
- `400 Bad Request` - Invalid request body or parameters
- `409 Conflict` - Operation not allowed in current state (e.g., already connected)
- `500 Internal Server Error` - Server-side error

Error responses include details:

```json
{
  "error": "Connection failed",
  "message": "Server unreachable at localhost:8080"
}
```

## Security Considerations

- The API currently allows all origins (CORS: `*`) for development
- No authentication is implemented
- For production use, consider:
  - Adding authentication/authorization
  - Restricting CORS origins
  - Using HTTPS/WSS
  - Rate limiting

## Comparison with Python Client

The Go client's tune functionality matches the Python client's implementation:

**Python:**
```python
await client.ws.send(json.dumps({
    'type': 'tune',
    'frequency': freq_hz,
    'mode': mode,
    'bandwidthLow': bandwidth_low,
    'bandwidthHigh': bandwidth_high
}))
```

**Go API:**
```bash
curl -X POST http://localhost:8090/api/tune \
  -d '{"frequency": 14074000, "mode": "usb", "bandwidthLow": 50, "bandwidthHigh": 2700}'
```

Both allow changing parameters without reconnecting to the SDR server.