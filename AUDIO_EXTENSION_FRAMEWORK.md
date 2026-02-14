# Audio Extension Framework

## Overview

The Audio Extension Framework provides an extensible system for streaming audio processors that receive the same uncompressed PCM audio stream as the user hears. Extensions run in the background and return decoded/processed data back to the user via the DX WebSocket.

## Architecture

```
User Audio Stream (PCM from radiod)
         ↓
    AudioReceiver
         ↓
    ┌────┴────┐
    ↓         ↓
User Audio   Audio Extension Tap
(Opus/PCM)   (Always PCM int16)
    ↓              ↓
WebSocket    Extension Processor
              ↓
         Binary Results
              ↓
         DX WebSocket
```

## Key Features

- ✅ **One extension per user** - Users can attach one streaming extension at a time
- ✅ **Uncompressed PCM** - Extensions always receive raw PCM int16 samples (before Opus encoding)
- ✅ **Real-time streaming** - No buffering or record-then-forward
- ✅ **DX WebSocket integration** - Control and data flow over existing `/ws/dxcluster` connection
- ✅ **Extensible** - New extensions register via factory pattern
- ✅ **Auto-teardown** - Requesting new extension automatically stops current one

## Protocol

### Client → Server (Text Messages)

**Attach Extension:**
```javascript
dxWebSocket.send(JSON.stringify({
    type: 'audio_extension_attach',
    extension_name: 'example_rms',
    params: {
        frame_size: 480  // Extension-specific parameters
    }
}));
```

**Detach Extension:**
```javascript
dxWebSocket.send(JSON.stringify({
    type: 'audio_extension_detach'
}));
```

**Get Status:**
```javascript
dxWebSocket.send(JSON.stringify({
    type: 'audio_extension_status'
}));
```

**List Available:**
```javascript
dxWebSocket.send(JSON.stringify({
    type: 'audio_extension_list'
}));
```

### Server → Client (Text Messages)

**Attached Confirmation:**
```json
{
    "type": "audio_extension_attached",
    "extension_name": "example_rms",
    "started_at": "2026-02-08T16:00:00Z"
}
```

**Detached Confirmation:**
```json
{
    "type": "audio_extension_detached"
}
```

**Status Response:**
```json
{
    "type": "audio_extension_status",
    "active": true,
    "extension_name": "example_rms",
    "started_at": "2026-02-08T16:00:00Z",
    "uptime_sec": 120
}
```

**List Response:**
```json
{
    "type": "audio_extension_list",
    "extensions": [
        {
            "name": "example_rms",
            "description": "RMS power calculator",
            "version": "1.0"
        }
    ]
}
```

**Error:**
```json
{
    "type": "audio_extension_error",
    "error": "extension not found: invalid_name"
}
```

### Server → Client (Binary Messages)

Extension results are sent as binary WebSocket messages. The format is extension-specific.

**Client-side handling:**
```javascript
dxWebSocket.onmessage = (event) => {
    if (typeof event.data === 'string') {
        // Text: control messages, chat, DX spots
        const msg = JSON.Parse(event.data);
        // ... handle text messages
    } else {
        // Binary: audio extension results
        const uint8Array = new Uint8Array(event.data);
        handleExtensionResult(uint8Array);
    }
};
```

## Implementation Files

### Core Framework

1. **[`audio_extension.go`](audio_extension.go:1)** - Interface and registry definitions
2. **[`audio_extension_manager.go`](audio_extension_manager.go:1)** - Manager for user extensions
3. **[`session.go`](session.go:2052)** - Audio tap methods added to Session
4. **[`audio.go`](audio.go:233)** - PCM tap integration in audio routing
5. **[`dxcluster_websocket.go`](dxcluster_websocket.go:71)** - DX WebSocket integration

### Example Extension

6. **[`audio_extension_example.go`](audio_extension_example.go:1)** - Example RMS power calculator

## Creating Custom Extensions

### 1. Implement the AudioExtension Interface

```go
type MyExtension struct {
    sampleRate int
    running    bool
    // ... your fields
}

func NewMyExtension(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
    ext := &MyExtension{
        sampleRate: audioParams.SampleRate,
        running:    false,
    }
    
    // Parse extension-specific parameters
    if myParam, ok := extensionParams["my_param"].(float64); ok {
        ext.myParam = myParam
    }
    
    return ext, nil
}

func (e *MyExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
    e.running = true
    
    go func() {
        for audioSample := range audioChan {
            if !e.running {
                break
            }
            
            // Access PCM samples
            samples := audioSample.PCMData

            // Access timestamps (optional)
            rtpTimestamp := audioSample.RTPTimestamp  // RTP timestamp from radiod
            gpsTimeNs := audioSample.GPSTimeNs        // GPS-synchronized Unix time in nanoseconds

            // Process PCM samples (with optional timestamp awareness)
            result := e.process(samples, gpsTimeNs)
            
            // Send binary result
            select {
            case resultChan <- result:
            default:
            }
        }
    }()
    
    return nil
}

func (e *MyExtension) Stop() error {
    e.running = false
    return nil
}

func (e *MyExtension) GetName() string {
    return "my_extension"
}
```

### 2. Register in main.go

```go
// Initialize audio extension registry
audioExtensionRegistry := NewAudioExtensionRegistry()

// Register extensions
audioExtensionRegistry.Register("example_rms", NewExampleAudioExtension, AudioExtensionInfo{
    Name:        "example_rms",
    Description: "RMS power calculator",
    Version:     "1.0",
})

audioExtensionRegistry.Register("my_extension", NewMyExtension, AudioExtensionInfo{
    Name:        "my_extension",
    Description: "My custom extension",
    Version:     "1.0",
})

// Create manager
audioExtensionManager := NewAudioExtensionManager(dxClusterWsHandler, sessions, audioExtensionRegistry)

// Set in DX cluster handler
dxClusterWsHandler.audioExtensionManager = audioExtensionManager
```

## Audio Data Flow

1. **Radiod** sends PCM audio via multicast (big-endian int16)
2. **AudioReceiver** receives RTP packets and routes by SSRC
3. **Audio tap** converts bytes to int16 samples and sends to extension
4. **Extension** processes samples and generates binary results
5. **Results** flow back to user via DX WebSocket (binary messages)

## Important Notes

### PCM Data Format

- **Source**: Radiod multicast stream (uncompressed PCM)
- **Format**: Big-endian int16 samples
- **Tap location**: [`audio.go:233`](audio.go:233) - **before** Opus encoding
- **Conversion**: [`audio.go:241`](audio.go:241) - `bytesToInt16Samples()` converts to int16 array
- **Guarantee**: Extensions always receive uncompressed PCM, even if user receives Opus

### Timestamp Data

Extensions now receive timing information with each audio sample via the `AudioSample` struct:

- **`PCMData []int16`**: The actual PCM audio samples (mono, int16)
- **`RTPTimestamp uint32`**: RTP timestamp from radiod's stream (useful for detecting packet loss or jitter)
- **`GPSTimeNs int64`**: GPS-synchronized Unix time in nanoseconds, captured when the packet arrived at ubersdr

The `GPSTimeNs` field provides accurate wall-clock timing that can be used to:
- Timestamp decoded images (SSTV, WEFAX)
- Timestamp decoded messages (FSK, NAVTEX)
- Correlate audio events with other system events
- Measure decoding latency

Extensions can choose to use or ignore the timestamp data based on their needs.

### Session Management

- Extensions attach to **UserSessionID**, not individual sessions
- One extension per user (not per audio session)
- Auto-cleanup when user disconnects from DX WebSocket
- Auto-replacement when user requests different extension

### WebSocket Multiplexing

The DX WebSocket (`/ws/dxcluster`) now carries:
- **Text messages**: DX spots, chat, extension control
- **Binary messages**: Audio extension results

This is safe because WebSocket protocol distinguishes text vs binary at the frame level.

## Testing

### Client-side Example

```javascript
// Connect to DX WebSocket
const dxWs = new WebSocket('ws://localhost:8080/ws/dxcluster?user_session_id=' + userSessionID);

// Attach extension
dxWs.send(JSON.stringify({
    type: 'audio_extension_attach',
    extension_name: 'example_rms',
    params: { frame_size: 480 }
}));

// Handle messages
dxWs.onmessage = (event) => {
    if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        console.log('Text message:', msg);
    } else {
        // Binary result from extension
        const view = new DataView(event.data);
        const dbfs = view.getFloat64(0, true); // Little-endian
        console.log('RMS Power:', dbfs, 'dBFS');
    }
};

// Detach when done
dxWs.send(JSON.stringify({
    type: 'audio_extension_detach'
}));
```

## Future Extensions

Potential audio extensions:
- **RTTY decoder** - Decode radioteletype
- **PSK31 decoder** - Decode PSK31 digital mode
- **SSTV decoder** - Decode slow-scan TV
- **CW decoder** - Decode Morse code
- **Spectrum analyzer** - Real-time FFT
- **Voice activity detector** - Detect speech/silence
- **Audio recorder** - Record to WAV/FLAC
- **Custom DSP** - User-defined signal processing

Each extension receives the same uncompressed PCM audio the user hears and can return any binary data format back to the user.
