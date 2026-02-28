# Whisper Speech-to-Text Extension

Real-time speech-to-text transcription using OpenAI's Whisper model via WhisperLive streaming server.

## Overview

The Whisper extension streams audio from UberSDR to a WhisperLive server via WebSocket and receives real-time transcriptions. This allows you to transcribe any audio channel you tune to, including:

- Voice communications (AM, SSB, FM)
- Broadcast stations
- Emergency services
- Amateur radio conversations
- Any other speech content

## Architecture

```
UberSDR (Go) → WebSocket → WhisperLive Server → Transcriptions → Client
```

- **UberSDR**: Captures PCM audio from radiod, converts to float32, streams via WebSocket
- **WhisperLive**: Runs Whisper model, performs real-time transcription
- **Client**: Receives transcribed text via DX WebSocket binary protocol

## Setup

### 1. Start WhisperLive Server

Using Docker (recommended):

```bash
docker run -d \
  --name ubersdr-whisper \
  -p 9090:9090 \
  -e WHISPER_MODEL=base \
  collabora/whisperlive-server:latest
```

Or with GPU support:

```bash
docker run -d \
  --name ubersdr-whisper \
  --gpus all \
  -p 9090:9090 \
  -e WHISPER_MODEL=base \
  -e DEVICE=cuda \
  collabora/whisperlive-server:latest
```

### 2. Add to docker-compose.yml

```yaml
services:
  whisper:
    image: collabora/whisperlive-server:latest
    container_name: ubersdr-whisper
    ports:
      - "9090:9090"
    environment:
      - WHISPER_MODEL=base
      - DEVICE=cpu  # or 'cuda' for GPU
    restart: unless-stopped
```

### 3. Build UberSDR

The extension is automatically registered when you build:

```bash
go build
```

## Usage

### Via Python Client

```python
# In radio_gui.py, Extensions menu → Whisper Speech-to-Text
# Or programmatically:
attach_msg = {
    'type': 'audio_extension_attach',
    'extension_name': 'whisper',
    'params': {
        'model': 'base',
        'language': 'en',
        'send_interval_ms': 100
    }
}
dxcluster_ws.send(json.dumps(attach_msg))
```

### Via WebSocket API

```javascript
// Connect to DX WebSocket
const ws = new WebSocket('ws://localhost:8080/ws/dxcluster?user_session_id=YOUR_ID');

// Attach Whisper extension
ws.send(JSON.stringify({
    type: 'audio_extension_attach',
    extension_name: 'whisper',
    params: {
        server_url: 'ws://localhost:9090',
        model: 'base',
        language: 'en',
        send_interval_ms: 100
    }
}));

// Receive transcriptions
ws.onmessage = (event) => {
    if (typeof event.data !== 'string') {
        // Binary message: transcription
        const view = new DataView(event.data);
        const type = view.getUint8(0);
        
        if (type === 0x01) {
            const timestamp = Number(view.getBigUint64(1, false));
            const textLen = view.getUint32(9, false);
            const text = new TextDecoder().decode(
                new Uint8Array(event.data, 13, textLen)
            );
            console.log(`[${new Date(timestamp/1e6)}] ${text}`);
        }
    }
};
```

## Configuration Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `server_url` | string | `ws://localhost:9090` | WhisperLive WebSocket URL |
| `model` | string | `base` | Whisper model: tiny, base, small, medium, large |
| `language` | string | `en` | Language code (en, es, fr, etc.) or "auto" |
| `send_interval_ms` | number | 100 | Audio send interval in milliseconds |

## Model Selection

| Model | Size | Speed | Accuracy | Use Case |
|-------|------|-------|----------|----------|
| **tiny** | 39 MB | Fastest | Good | Quick testing, low-resource systems |
| **base** | 74 MB | Fast | Better | **Recommended for most users** |
| **small** | 244 MB | Medium | Great | High accuracy needed |
| **medium** | 769 MB | Slow | Excellent | Professional transcription |
| **large** | 2.9 GB | Slowest | Best | Maximum accuracy (GPU required) |

## Binary Protocol

Transcriptions are sent as binary messages via DX WebSocket:

```
[type:1][timestamp:8][text_length:4][text:N]
```

- **type** (1 byte): Message type (0x01 for transcription)
- **timestamp** (8 bytes): Unix timestamp in nanoseconds (big-endian uint64)
- **text_length** (4 bytes): Text length in bytes (big-endian uint32)
- **text** (N bytes): UTF-8 encoded transcribed text

## Performance

### CPU Performance (base model)
- **Real-time factor**: ~16x (can transcribe 16 seconds in 1 second)
- **Latency**: ~100-200ms from speech to transcription
- **CPU usage**: ~10-20% on modern CPU

### GPU Performance (base model)
- **Real-time factor**: ~50x+
- **Latency**: ~50-100ms
- **GPU memory**: ~500MB

## Troubleshooting

### Connection Failed
```
Error: failed to connect to WhisperLive: dial tcp [::1]:9090: connect: connection refused
```

**Solution**: Ensure WhisperLive server is running:
```bash
docker ps | grep whisper
# If not running:
docker start ubersdr-whisper
```

### Slow Transcription
- Use smaller model (tiny or base)
- Enable GPU support
- Increase `send_interval_ms` to reduce overhead

### No Transcriptions
- Check audio is being received (tune to a voice channel)
- Verify language setting matches audio
- Check WhisperLive logs: `docker logs ubersdr-whisper`

## Dependencies

- **Go**: `github.com/gorilla/websocket`
- **Docker**: WhisperLive server container

Install Go dependency:
```bash
go get github.com/gorilla/websocket
```

## Example Use Cases

### 1. Monitor Emergency Services
```python
# Tune to local emergency frequency
radio_client.tune(154.280e6, mode='nfm')

# Start transcription
attach_whisper(language='en')
```

### 2. Transcribe Amateur Radio Nets
```python
# Tune to 40m SSB net
radio_client.tune(7.200e6, mode='usb')

# Start transcription with callsign detection
attach_whisper(language='en')
```

### 3. Decode International Broadcasts
```python
# Tune to shortwave broadcast
radio_client.tune(9.580e6, mode='am')

# Auto-detect language
attach_whisper(language='auto')
```

## License

Copyright (c) 2026, UberSDR project

## See Also

- [Audio Extension Framework](../../AUDIO_EXTENSION_FRAMEWORK.md)
- [WhisperLive Documentation](https://github.com/collabora/WhisperLive)
- [OpenAI Whisper](https://github.com/openai/whisper)
