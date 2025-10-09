# Opus Audio Compression Support

This document describes the Opus audio compression feature in ka9q_ubersdr.

## ⚠️ Current Status: Proof of Concept

**Note**: Opus support is currently a **proof of concept** and not production-ready. The server-side encoding works correctly, but the current implementation sends raw Opus packets which require a JavaScript decoder library.

**Better Approach Needed**: The implementation should be updated to wrap Opus packets in Ogg containers, which browsers can decode natively using `AudioContext.decodeAudioData()`. This would eliminate the need for external decoder libraries.

**Current Recommendation**: Keep `audio.opus.enabled: false` (default) and use PCM mode until the Ogg container wrapping is implemented.

### Why Ogg Container?

Browsers have native Opus support, but only when wrapped in a container format:
- **Ogg Opus**: Standard container, widely supported
- **WebM**: Alternative container, also supported
- **Raw Opus packets**: Not supported by browser APIs (requires external decoder)

The current implementation sends raw Opus packets, which is why it needs an external decoder library. Wrapping them in Ogg would allow using the browser's native decoder.

## Overview

ka9q_ubersdr includes Opus audio compression support for streaming audio to web clients. When fully functional, Opus provides significant bandwidth reduction (typically 4-8x compression) while maintaining excellent audio quality, making it ideal for remote SDR operation over limited bandwidth connections.

## Features

- **Configurable compression**: Enable/disable Opus compression via config.yaml
- **Adjustable bitrate**: Configure bitrate from 6 kbps to 510 kbps (default: 48 kbps)
- **Adjustable complexity**: Balance between CPU usage and quality (0-10, default: 5)
- **Automatic fallback**: Falls back to PCM if Opus is not available
- **Client-side detection**: Browser automatically detects and decodes Opus or PCM

## Configuration

Edit `config.yaml` to enable and configure Opus compression:

```yaml
audio:
  # ... other audio settings ...
  
  # Opus compression settings
  opus:
    # Enable Opus compression for audio streaming (reduces bandwidth significantly)
    enabled: false
    # Opus bitrate in bits per second (6000-510000, typical: 24000-64000)
    # Lower = more compression but lower quality, Higher = better quality but more bandwidth
    # 24000 = good for voice, 48000 = excellent for voice, 64000 = near-transparent
    bitrate: 48000
    # Opus complexity (0-10, higher = better quality but more CPU)
    # 0 = fastest/lowest quality, 10 = slowest/highest quality
    complexity: 5
```

## Building with Opus Support

### Prerequisites

Opus support requires the libopus development libraries to be installed on your system.

**Debian/Ubuntu:**
```bash
sudo apt install libopus-dev libopusfile-dev pkg-config
```

**RHEL/Fedora/CentOS:**
```bash
sudo dnf install opus-devel opusfile-devel
```

**macOS (Homebrew):**
```bash
brew install opus opusfile
```

### Building

Once the libraries are installed, build with Opus support using the `opus` build tag:

```bash
go build -tags opus
```

### Building without Opus Support

If you don't have libopus installed or don't need Opus compression, simply build normally:

```bash
go build
```

The application will compile successfully and use PCM audio only. If Opus is enabled in config.yaml but not compiled in, a warning will be logged and PCM will be used instead.

## Bandwidth Comparison

Typical bandwidth usage for mono audio at 12 kHz sample rate:

| Format | Bitrate | Bandwidth (approx) | Quality |
|--------|---------|-------------------|---------|
| PCM (uncompressed) | 192 kbps | 192 kbps | Perfect |
| Opus @ 24 kbps | 24 kbps | 24 kbps | Good for voice |
| Opus @ 48 kbps | 48 kbps | 48 kbps | Excellent for voice |
| Opus @ 64 kbps | 64 kbps | 64 kbps | Near-transparent |

**Compression ratio**: Opus at 48 kbps provides approximately **4x** bandwidth reduction compared to PCM.

## Client Support

All modern web browsers support Opus decoding natively, but they require Opus data to be wrapped in a container format (Ogg or WebM). For raw Opus packet streaming, we use the `opus-decoder` JavaScript library which provides efficient decoding of raw Opus packets.

Supported browsers:
- Chrome/Chromium
- Firefox
- Safari
- Edge

### How the Client Detects Audio Format

The server includes an `audioFormat` field in every audio WebSocket message:

```json
{
  "type": "audio",
  "data": "<base64-encoded-audio>",
  "sampleRate": 12000,
  "channels": 1,
  "audioFormat": "opus"  // or "pcm"
}
```

The client JavaScript checks this field and automatically routes to the appropriate decoder:
- `"opus"` → Uses opus-decoder library for raw Opus packet decoding
- `"pcm"` → Uses manual PCM decoding (original behavior)

This allows seamless switching between formats without client configuration. If the server falls back to PCM (e.g., Opus not available), the client automatically handles it.

### Why Not Use Browser's Native Opus Support?

Browsers can decode Opus natively through `AudioContext.decodeAudioData()`, but this requires Opus data to be wrapped in a container format (Ogg Opus or WebM). For real-time streaming of raw Opus packets, we use the `opus-decoder` library which:
- Decodes raw Opus packets directly (no container needed)
- Provides lower latency for real-time streaming
- Is automatically loaded from CDN (no installation needed)

## Troubleshooting

### "Opus encoding requested but not compiled in"

This warning appears when:
1. Opus is enabled in config.yaml (`opus.enabled: true`)
2. But the binary was built without the `opus` build tag

**Solution**: Install dependencies and rebuild:
```bash
sudo apt install libopus-dev libopusfile-dev pkg-config
go build -tags opus
```

### "Opus encoding requested but failed to initialize"

This error appears when:
1. The binary was built with Opus support
2. But libopus runtime libraries are not installed or not found

**Solution**: Install the runtime libraries:
- Debian/Ubuntu: `sudo apt-get install libopus0`
- RHEL/Fedora: `sudo dnf install opus`

### "Opus decoding failed, check browser support"

This error appears in the browser console when:
1. The browser doesn't support Opus (very rare with modern browsers)
2. The Opus data is corrupted

**Solution**: Try a different browser or check server logs for encoding errors

## Performance Considerations

### CPU Usage

Opus encoding adds CPU overhead on the server:
- Complexity 0-3: Minimal CPU impact
- Complexity 4-6: Moderate CPU impact (recommended)
- Complexity 7-10: Higher CPU impact, diminishing returns

For most use cases, complexity 5 provides an excellent balance.

### Latency

Opus encoding/decoding adds minimal latency (typically <20ms), which is negligible for SDR applications.

### Memory

Opus encoding requires minimal additional memory per connection (~100 KB per encoder instance).

## Recommended Settings

### For Voice/SSB (default)
```yaml
opus:
  enabled: true
  bitrate: 48000
  complexity: 5
```

### For Low Bandwidth
```yaml
opus:
  enabled: true
  bitrate: 24000
  complexity: 3
```

### For High Quality
```yaml
opus:
  enabled: true
  bitrate: 64000
  complexity: 7
```

### For CW
```yaml
opus:
  enabled: true
  bitrate: 24000
  complexity: 5
```

## Technical Details

- **Encoder**: libopus via gopkg.in/hraban/opus.v2
- **Decoder**: Browser's native Web Audio API
- **Frame size**: Variable (determined by PCM buffer size from radiod)
- **Channels**: Mono (1 channel)
- **Sample rates**: Supports all radiod sample rates (12 kHz, 24 kHz, etc.)
- **Application mode**: VoIP optimized (OPUS_APPLICATION_VOIP)

## License

Opus codec is licensed under the BSD license. See https://opus-codec.org/ for details.