# FT8/FT4 Audio Extension for UberSDR

Pure Go implementation of FT8 and FT4 digital mode decoder for UberSDR.

## Overview

This extension decodes FT8 and FT4 weak signal digital modes from audio input. It uses GPS-synchronized timing from UberSDR to align with 15-second (FT8) or 7.5-second (FT4) time slots.

## Features

- ✅ **Pure Go implementation** - No CGO dependencies
- ✅ **GPS time synchronization** - Uses UberSDR's GPS timestamps for precise slot alignment
- ✅ **FT8 and FT4 support** - Configurable protocol selection
- ✅ **12 kHz sample rate** - Optimized for UberSDR's audio bandwidth
- ✅ **Real-time decoding** - Processes audio in 15-second windows
- ✅ **JSON output** - Decoded messages sent via WebSocket

## Current Status

**Phase 1: Framework Complete** ✅
- Extension registration and integration
- Time slot synchronization using GPS timestamps
- Sample buffering and accumulation
- Basic decoder structure

**Phase 2: Decoder Implementation** 🚧 (In Progress)
- Waterfall generation (FFT-based spectral analysis)
- Costas array sync detection
- Candidate extraction
- LDPC forward error correction
- Message unpacking

## Architecture

```
Audio Input (12 kHz PCM)
    ↓
GPS Time Sync (align to 15s slots)
    ↓
Sample Buffer (accumulate 14.6s)
    ↓
[TODO] Waterfall Generation (FFT)
    ↓
[TODO] Costas Sync Detection
    ↓
[TODO] Candidate Decoding (LDPC)
    ↓
[TODO] Message Unpacking
    ↓
JSON Results → WebSocket
```

## Usage

### Client-side (JavaScript)

```javascript
// Connect to DX WebSocket
const dxWs = new WebSocket('ws://localhost:8080/ws/dxcluster?user_session_id=' + userSessionID);

// Attach FT8 extension
dxWs.send(JSON.stringify({
    type: 'audio_extension_attach',
    extension_name: 'ft8',
    params: {
        protocol: 'FT8',        // or 'FT4'
        min_score: 10,          // Minimum sync score (0-100)
        max_candidates: 100     // Max candidates per slot
    }
}));

// Receive decoded messages
dxWs.onmessage = (event) => {
    if (typeof event.data !== 'string') {
        const decode = JSON.parse(new TextDecoder().decode(event.data));
        console.log(`${decode.utc} ${decode.snr.toFixed(1)} dB ${decode.frequency.toFixed(1)} Hz: ${decode.message}`);
    }
};

// Detach when done
dxWs.send(JSON.stringify({
    type: 'audio_extension_detach'
}));
```

### Output Format

```json
{
    "timestamp": 1707936315,
    "utc": "15:45:15",
    "snr": -10.5,
    "delta_t": 0.3,
    "frequency": 1234.5,
    "message": "CQ DH1NAS JO50",
    "protocol": "FT8",
    "slot_number": 42,
    "score": 15
}
```

## Configuration

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `protocol` | string | `"FT8"` | Protocol: `"FT8"` or `"FT4"` |
| `min_score` | int | `10` | Minimum sync score (0 = accept all) |
| `max_candidates` | int | `100` | Maximum candidates to decode per slot |

### Protocol Specifications

#### FT8
- **Slot time**: 15 seconds
- **Symbol time**: 0.160 seconds
- **Symbols**: 79
- **Bandwidth**: 50 Hz
- **Frequency range**: 100-3100 Hz

#### FT4
- **Slot time**: 7.5 seconds
- **Symbol time**: 0.048 seconds
- **Symbols**: 105
- **Bandwidth**: 90 Hz
- **Frequency range**: 100-3100 Hz

## Implementation Notes

### Time Synchronization

The decoder uses UberSDR's GPS timestamps (`GPSTimeNs`) for precise time slot alignment:

```go
// FT8: Slots at :00, :15, :30, :45 seconds
// FT4: Slots at :00, :07.5, :15, :22.5, :30, :37.5, :45, :52.5 seconds
slotPeriod := 15.0  // or 7.5 for FT4
timeWithinSlot := math.Mod(timeSec - 0.8, slotPeriod)
```

The 0.8-second offset matches the WSJT-X convention.

### Sample Rate

UberSDR operates at **12 kHz** sample rate, which provides:
- Nyquist frequency: 6 kHz
- Usable bandwidth: ~5.5 kHz
- FT8/FT4 passband: 100-3100 Hz (3 kHz)

This is sufficient for FT8/FT4 decoding, which only requires 3 kHz bandwidth.

### Memory Usage

Per decoder instance:
- Sample buffer: ~180 KB (15 seconds × 12000 samples × 4 bytes)
- Waterfall data: TBD (depends on FFT implementation)
- Candidate list: ~14 KB (100 candidates × 140 bytes)

## TODO: Decoder Implementation

The following components need to be implemented in pure Go:

### 1. FFT and Waterfall Generation
- Implement FFT for spectral analysis
- Generate time-frequency waterfall
- Frequency oversampling (2x)
- Time oversampling (2x)

### 2. Costas Array Sync Detection
- Search for 7-symbol Costas arrays
- Calculate sync scores
- Extract candidate time/frequency offsets

### 3. Symbol Demodulation
- Extract symbol magnitudes from waterfall
- Apply frequency and time corrections

### 4. LDPC Decoding
- Implement LDPC forward error correction
- 25 iterations (configurable)
- CRC verification

### 5. Message Unpacking
- Decode message types (CQ, grid, report, etc.)
- Callsign hash resolution
- Grid square extraction

## References

- **WSJT-X**: https://physics.princeton.edu/pulsar/k1jt/wsjtx.html
- **FT8/FT4 Protocol**: https://physics.princeton.edu/pulsar/k1jt/FT4_FT8_QEX.pdf
- **ft8_lib** (C reference): https://github.com/kgoba/ft8_lib

## License

Copyright (c) 2026, UberSDR project

## Development Status

This is an initial framework implementation. The core decoding algorithms are not yet implemented. Contributions welcome!

### Phase 1: ✅ Complete
- [x] Extension framework integration
- [x] GPS time synchronization
- [x] Sample buffering
- [x] Configuration system
- [x] WebSocket output

### Phase 2: 🚧 In Progress
- [ ] FFT implementation
- [ ] Waterfall generation
- [ ] Costas sync detection
- [ ] LDPC decoder
- [ ] Message unpacking
- [ ] Callsign hashtable

### Phase 3: 📋 Planned
- [ ] Performance optimization
- [ ] Multi-decoder support
- [ ] Statistics and monitoring
- [ ] UI integration
