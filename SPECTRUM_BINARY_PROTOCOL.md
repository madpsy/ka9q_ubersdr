# Spectrum Binary Protocol

## Overview

The spectrum websocket now supports an efficient binary protocol with delta encoding to reduce bandwidth usage by approximately 60-80% compared to the JSON format.

## Usage

To use the binary protocol, add `mode=binary` to the websocket query parameters:

```javascript
// JSON mode (default, backwards compatible)
ws = new WebSocket('wss://example.com/ws/user-spectrum?user_session_id=UUID');

// Binary mode with delta encoding
ws = new WebSocket('wss://example.com/ws/user-spectrum?user_session_id=UUID&mode=binary');
```

## Binary Protocol Format

### Message Header (22 bytes)

All binary spectrum messages start with a 22-byte header:

| Offset | Size | Type | Description |
|--------|------|------|-------------|
| 0 | 4 | char[4] | Magic: `0x53 0x50 0x45 0x43` ("SPEC") |
| 4 | 1 | uint8 | Version: `0x01` |
| 5 | 1 | uint8 | Flags: `0x01`=full frame, `0x02`=delta frame |
| 6 | 8 | uint64 | Timestamp (milliseconds since Unix epoch, little-endian) |
| 14 | 8 | uint64 | Center frequency in Hz (little-endian) |

### Full Frame Format

When flags = `0x01`, the message contains all spectrum bins:

```
[Header: 22 bytes]
[Bin 0: float32, 4 bytes, little-endian]
[Bin 1: float32, 4 bytes, little-endian]
...
[Bin N-1: float32, 4 bytes, little-endian]
```

**Total size:** 22 + (binCount × 4) bytes

For 1024 bins: 22 + 4096 = **4118 bytes**

### Delta Frame Format

When flags = `0x02`, the message contains only changed bins:

```
[Header: 22 bytes]
[Change count: uint16, 2 bytes, little-endian]
[Change 0: index (uint16, 2 bytes) + value (float32, 4 bytes)]
[Change 1: index (uint16, 2 bytes) + value (float32, 4 bytes)]
...
[Change N-1: index (uint16, 2 bytes) + value (float32, 4 bytes)]
```

**Total size:** 22 + 2 + (changeCount × 6) bytes

For typical 10-30% change rate (100-300 bins): 22 + 2 + (200 × 6) = **1224 bytes**

## Delta Encoding Logic

- **Change threshold:** 0.5 dB - bins that change by less are not transmitted
- **Full frame trigger:** If >50% of bins change, send full frame instead
- **Automatic full frames:** Sent periodically to prevent drift (every 50 frames)
- **Bin count changes:** Trigger immediate full frame

## Bandwidth Comparison

At 10 Hz update rate (100ms poll period):

| Format | Typical Size | Bandwidth | Reduction |
|--------|--------------|-----------|-----------|
| JSON (gzipped) | ~4.5 KB | 360 Kbps | baseline |
| Binary Full | ~4.1 KB | 328 Kbps | 9% |
| Binary Delta | ~1.2 KB | 96 Kbps | **73%** |

## Client Implementation Example

```javascript
const ws = new WebSocket('wss://example.com/ws/user-spectrum?user_session_id=' + uuid + '&mode=binary');
ws.binaryType = 'arraybuffer';

// State for delta decoding
let spectrumData = null;
let binCount = 1024; // Get from config message

ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        
        // Check magic
        const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), 
                                          view.getUint8(2), view.getUint8(3));
        if (magic !== 'SPEC') {
            console.error('Invalid magic:', magic);
            return;
        }
        
        // Parse header
        const version = view.getUint8(4);
        const flags = view.getUint8(5);
        const timestamp = Number(view.getBigUint64(6, true)); // little-endian
        const frequency = Number(view.getBigUint64(14, true)); // little-endian
        
        if (flags === 0x01) {
            // Full frame
            const bins = (event.data.byteLength - 22) / 4;
            spectrumData = new Float32Array(bins);
            for (let i = 0; i < bins; i++) {
                spectrumData[i] = view.getFloat32(22 + i * 4, true); // little-endian
            }
        } else if (flags === 0x02) {
            // Delta frame
            if (!spectrumData) {
                console.error('Delta frame received before full frame');
                return;
            }
            
            const changeCount = view.getUint16(22, true); // little-endian
            let offset = 24;
            
            for (let i = 0; i < changeCount; i++) {
                const index = view.getUint16(offset, true); // little-endian
                const value = view.getFloat32(offset + 2, true); // little-endian
                spectrumData[index] = value;
                offset += 6;
            }
        }
        
        // Update display with spectrumData
        updateSpectrum(spectrumData, frequency, timestamp);
    } else {
        // JSON message (config, status, error, etc.)
        const msg = JSON.parse(event.data);
        handleJsonMessage(msg);
    }
};
```

## Control Messages

Control messages (zoom, pan, reset, ping, etc.) are still sent as JSON in both modes. Only spectrum data uses the binary format.

## Backwards Compatibility

- Default mode is `json` - existing clients continue to work without changes
- Binary mode must be explicitly requested via `mode=binary` query parameter
- Config and status messages remain JSON in both modes
- Clients can detect binary support and upgrade automatically

## Performance Characteristics

### Advantages
- **73% bandwidth reduction** for typical spectrum updates
- **Faster parsing** - no JSON decode overhead for spectrum data
- **Lower CPU usage** - binary operations vs string parsing
- **Better compression** - binary data compresses better than JSON

### Trade-offs
- Slightly more complex client implementation
- Requires client-side state management for delta decoding
- Full frames sent periodically (every 50 frames) to prevent drift

## Testing

Test the binary protocol:

```bash
# Connect with binary mode
wscat -c "wss://example.com/ws/user-spectrum?user_session_id=YOUR-UUID&mode=binary"

# Monitor bandwidth
# Binary mode should show ~96 Kbps vs ~360 Kbps for JSON mode
```

## Future Enhancements

Potential improvements for future versions:

1. **Adaptive thresholds** - Adjust delta threshold based on spectrum activity
2. **Run-length encoding** - For consecutive unchanged bins
3. **Huffman coding** - For common dB values
4. **Configurable full frame interval** - Let clients control drift prevention
5. **Multi-resolution** - Send lower resolution deltas, full resolution periodically
