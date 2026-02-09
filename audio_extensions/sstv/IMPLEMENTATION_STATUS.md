# SSTV Extension Implementation Status

## Overview

This document tracks the progress of porting the KiwiSDR SSTV decoder to the UberSDR audio extension framework.

## Completed Components

### ✅ 1. Mode Specifications (`modes.go`)
- **Status**: Complete
- **Lines of Code**: ~570
- **Features**:
  - All 47 SSTV modes defined (Martin, Scottie, Robot, PD, Pasokon, MMSSTV, etc.)
  - VIS code mapping tables (128 standard + 128 extended codes)
  - Color encoding support (RGB, GBR, YUV, YUVY, BW)
  - Scanline format definitions (FMT_111, FMT_420, FMT_422, FMT_242, FMT_111_REV, FMT_BW)
  - Helper functions for mode lookup by VIS code
  - Mode initialization with LineHeight adjustments

### ✅ 2. VIS Code Detection (`vis.go`)
- **Status**: Complete
- **Lines of Code**: ~280
- **Features**:
  - 1900 Hz calibration tone detection
  - FSK demodulation (1100 Hz = 1, 1300 Hz = 0)
  - 8-bit and 16-bit VIS code support
  - Parity checking
  - Frequency shift detection (±25 Hz tolerance)
  - Gaussian interpolation for peak frequency detection
  - Extended VIS (MMSSTV) support

### ✅ 3. Directory Structure
- Created `audio_extensions/sstv/` directory
- Organized for modular development

## Remaining Components

### ⏳ 4. Video Demodulation (`video.go`)
- **Status**: Not started
- **Estimated LOC**: ~800-1000
- **Complexity**: Very High
- **Key Features Needed**:
  - FFT-based FM demodulation (1024-point FFT)
  - Multiple Hann window sizes (48, 64, 96, 128, 256, 512, 1024 samples)
  - Adaptive window selection based on SNR
  - Pixel grid generation for all scanline formats
  - Channel timing calculations (sync, porch, separator, pixel data)
  - Frequency-to-luminance conversion (1500-2300 Hz → 0-255)
  - Sync band detection (1200 Hz)
  - SNR estimation
  - Color space conversions (YUV→RGB, YUVY→RGB)
  - Real-time pixel extraction and buffering

### ⏳ 5. Sync Detection & Slant Correction (`sync.go`)
- **Status**: Not started
- **Estimated LOC**: ~400-500
- **Complexity**: High
- **Key Features Needed**:
  - Sync pulse detection (1200 Hz)
  - Slant angle calculation
  - Sample rate adjustment for slant correction
  - Line alignment optimization
  - Skip calculation for phase adjustment

### ⏳ 6. FSK ID Decoder (`fsk_id.go`)
- **Status**: Not started
- **Estimated LOC**: ~200-300
- **Complexity**: Medium
- **Key Features Needed**:
  - FSK demodulation (1900/2100 Hz)
  - Callsign extraction
  - Optional feature (transmitted after image)

### ⏳ 7. Main Decoder (`decoder.go`)
- **Status**: Not started
- **Estimated LOC**: ~600-800
- **Complexity**: Very High
- **Key Features Needed**:
  - Orchestration of all components
  - State machine (INIT → VIS → VIDEO → SYNC → DONE)
  - PCM buffer management
  - Image buffer allocation and management
  - Binary protocol encoding for frontend
  - Error handling and recovery
  - Real-time streaming to frontend

### ⏳ 8. Extension Wrapper (`extension.go`)
- **Status**: Not started
- **Estimated LOC**: ~150-200
- **Complexity**: Low
- **Key Features Needed**:
  - AudioExtension interface implementation
  - Parameter parsing and validation
  - Start/Stop methods
  - Integration with audio extension manager

### ⏳ 9. Registration & Metadata (`register.go`)
- **Status**: Not started
- **Estimated LOC**: ~150-200
- **Complexity**: Low
- **Key Features Needed**:
  - Extension factory function
  - Metadata (name, description, version)
  - Parameter specifications
  - Output format documentation

### ⏳ 10. Documentation (`README.md`)
- **Status**: Not started
- **Estimated LOC**: ~300-400 (markdown)
- **Complexity**: Low
- **Content Needed**:
  - Usage instructions
  - Mode descriptions
  - Parameter documentation
  - Binary protocol specification
  - Troubleshooting guide

## Technical Challenges

### 1. FFT Library Selection
**Issue**: Go doesn't have a built-in FFT library like FFTW3 in C++.

**Options**:
- **gonum/fft**: Pure Go, good performance
- **mjibson/go-dsp/fft**: Pure Go, simpler API
- **CGO + FFTW3**: Best performance, but adds C dependency

**Recommendation**: Use `gonum/fft` for pure Go solution with good performance.

### 2. Real-time Performance
**Issue**: SSTV requires real-time FFT processing (1024-point FFT every ~10ms).

**Considerations**:
- Go's garbage collector may introduce latency
- Need efficient buffer management
- Consider using sync.Pool for buffer reuse

### 3. Color Space Conversion
**Issue**: Multiple color encodings (RGB, GBR, YUV, YUVY) need conversion.

**Solution**: Implement standard YUV→RGB conversion formulas:
```
R = Y + 1.140 * V
G = Y - 0.395 * U - 0.581 * V
B = Y + 2.032 * U
```

### 4. Binary Protocol Design
**Issue**: Need efficient binary protocol for streaming image data to frontend.

**Proposed Protocol**:
```
Message Type 0x01: Image Line (RGB)
[type:1][line:4][width:4][r_data:width][g_data:width][b_data:width]

Message Type 0x02: Mode Detected
[type:1][vis_code:1][mode_name_len:1][mode_name:len]

Message Type 0x03: Status Update
[type:1][status_code:1][message_len:2][message:len]

Message Type 0x04: Sync Detected
[type:1][sync_quality:1]

Message Type 0x05: Image Complete
[type:1][total_lines:4]
```

## Estimated Remaining Effort

| Component | LOC | Complexity | Est. Hours |
|-----------|-----|------------|------------|
| Video Demodulation | 900 | Very High | 20-25 |
| Sync Detection | 450 | High | 12-15 |
| FSK ID Decoder | 250 | Medium | 6-8 |
| Main Decoder | 700 | Very High | 18-22 |
| Extension Wrapper | 175 | Low | 4-5 |
| Registration | 175 | Low | 3-4 |
| Documentation | 350 | Low | 4-5 |
| **Total** | **~3000** | - | **67-84 hours** |

## Dependencies Needed

Add to `go.mod`:
```go
require (
    gonum.org/v1/gonum v0.14.0  // For FFT
)
```

## Next Steps

### Immediate (Phase 1):
1. Add gonum/fft dependency
2. Implement video demodulation core
3. Implement basic decoder orchestration
4. Create extension wrapper

### Short-term (Phase 2):
5. Implement sync detection
6. Add slant correction
7. Implement FSK ID decoder
8. Complete binary protocol

### Final (Phase 3):
9. Frontend implementation (JavaScript)
10. Integration testing
11. Documentation
12. Performance optimization

## Frontend Requirements (Not Yet Started)

The frontend will need:
- Canvas for 320x256 or 640x496 image display
- Real-time line-by-line rendering
- Mode detection display
- Manual slant correction controls
- Image save functionality
- Status indicators
- Binary WebSocket message handling

**Estimated Frontend Effort**: 15-20 hours

## Total Project Estimate

- **Backend**: 67-84 hours
- **Frontend**: 15-20 hours
- **Testing & Integration**: 10-15 hours
- **Documentation**: 5-8 hours
- **Total**: **97-127 hours**

## References

- Original KiwiSDR implementation: `/home/nathan/repos/KiwiSDR/extensions/SSTV/`
- WEFAX reference: `audio_extensions/wefax/`
- Audio Extension Framework: `AUDIO_EXTENSION_FRAMEWORK.md`

## Notes

This is a significantly more complex extension than WEFAX due to:
- 47 modes vs 1 mode
- Complex color encoding
- FFT-based demodulation vs simple FM
- Sync detection and slant correction
- VIS code detection

The implementation requires careful attention to real-time performance and accurate signal processing.
