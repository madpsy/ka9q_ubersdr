# Audio Preview Feature

## Overview

The multi-instance client now supports audio preview from up to 2 instances simultaneously, with independent left/right channel routing.

## Features

- **Dual-channel audio**: Preview audio from 1 or 2 instances at once
- **Left/Right routing**: Route instance 1 to left speaker, instance 2 to right speaker
- **On-demand**: Audio channels are created/torn down only when preview is active
- **Independent connections**: Each audio preview uses its own WebSocket connection
- **No processing**: Raw audio output (no NR2, EQ, or filters)

## Requirements

- `sounddevice` library for audio output
- `websockets` library for WebSocket connections
- `numpy` for audio processing

Install with:
```bash
pip install sounddevice websockets numpy
```

## Usage

### Starting Audio Preview

1. **Connect instances**: Make sure the instances you want to preview are connected (showing spectrum)
2. **Select channels**: 
   - Choose an instance for "Left Channel" dropdown (optional)
   - Choose an instance for "Right Channel" dropdown (optional)
   - You can select the same instance for both channels, or different instances
3. **Click "Start Preview"**: Audio will begin streaming

### Stopping Audio Preview

- Click "Stop Preview" button
- Audio connections will be closed and resources freed

### Notes

- Audio preview uses the current frequency and mode settings
- Each channel connects independently to its instance's `/ws` endpoint
- Audio is output at 12 kHz sample rate (native from server)
- Stereo output: left channel → left speaker, right channel → right speaker

## Architecture

### Components

1. **AudioPreviewManager** (`audio_preview.py`):
   - Manages sounddevice output stream
   - Handles WebSocket connections for each channel
   - Decodes and buffers audio data
   - Mixes left/right channels in audio callback

2. **AudioChannel**:
   - Represents a single audio channel (left or right)
   - Maintains WebSocket connection
   - Buffers incoming audio samples

### Audio Flow

```
Server → WebSocket → Base64 Decode → PCM int16 → Buffer → sounddevice → Speakers
         (/ws)                                            (stereo mix)
```

### Threading

- Main GUI thread: Tkinter event loop
- Audio event loop thread: Handles WebSocket connections
- Audio callback thread: sounddevice callback (real-time)

## Troubleshooting

### "Audio preview not available"
- Install required libraries: `pip install sounddevice websockets numpy`

### "Failed to start audio preview"
- Check that the instance is connected
- Verify server is accessible
- Check firewall/network settings

### No audio output
- Check system audio settings
- Verify sounddevice can access audio hardware
- Try: `python -m sounddevice` to test audio devices

### Audio dropouts/clicks
- Network latency or packet loss
- Try connecting to a closer server
- Check CPU usage

## Technical Details

### Sample Rate
- Input: 12 kHz (from server)
- Output: 12 kHz (no resampling)

### Audio Format
- Input: Big-endian int16 PCM (from server)
- Processing: Little-endian int16 PCM
- Output: Stereo int16 (2 channels)

### Buffer Management
- Each channel maintains a sample buffer
- Buffer limited to 2 seconds to prevent memory issues
- Zero-padding when buffer underruns

### WebSocket Protocol
- Endpoint: `/ws`
- Parameters: `frequency`, `mode`, `bandwidthLow`, `bandwidthHigh`
- Message format: JSON with base64-encoded audio data

## Future Enhancements

Possible improvements:
- Volume control per channel
- Frequency/mode sync with spectrum display
- Audio recording to file
- Resampling to 48 kHz for better hardware compatibility
- Audio level meters
- Mono/stereo mode selection