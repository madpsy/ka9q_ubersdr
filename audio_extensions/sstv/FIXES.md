# SSTV VIS Detection Fixes

## Summary

This document describes the critical fixes applied to the SSTV extension to match the KiwiSDR reference implementation and enable proper VIS code detection.

## Problems Identified

### 1. FFT Implementation Issues
**Problem:** The original implementation used `gonum.org/v1/gonum/dsp/fourier` which applies `PadRadix2()`, changing the FFT size and breaking frequency bin calculations.

**Fix:** Implemented a pure Go radix-2 Cooley-Tukey FFT that guarantees exact 2048-point FFT without padding.

**Files Changed:**
- `audio_extensions/sstv/fft.go` - Complete rewrite with in-place FFT

**Verification:**
- FFT size is exactly 2048 points (no padding)
- Power calculation matches KiwiSDR: `real(coeff)^2 + imag(coeff)^2`
- Bin-to-frequency mapping: `bin / FFTLen * sampleRate`

### 2. Missing Circular PCM Buffer
**Problem:** No proper circular buffer for streaming audio processing. The original implementation accumulated samples in a growing slice, breaking the timing assumptions of VIS detection.

**Fix:** Implemented `CircularPCMBuffer` matching KiwiSDR's PCM buffer management (4096 samples).

**Files Changed:**
- `audio_extensions/sstv/pcm_buffer.go` - New file with circular buffer implementation

**Key Features:**
- Fixed 4096-sample buffer (matches KiwiSDR's `PCM_BUFLEN`)
- Proper read/write pointer management
- Window extraction for FFT analysis
- Thread-safe operations

### 3. Broken Windowing Logic
**Problem:** The VIS detector used a forward-looking sliding window instead of KiwiSDR's backward-looking approach. The FFT was analyzing the wrong audio segment.

**Fix:** Rewrote `DetectVISStreaming()` to match KiwiSDR's exact windowing:
- Read 10ms of audio (advances read pointer)
- Apply FFT to 20ms window **looking backward** from current position
- This creates proper 10ms overlap between FFT windows

**Files Changed:**
- `audio_extensions/sstv/vis.go` - Complete rewrite of `DetectVIS()` method

**KiwiSDR Reference:**
```cpp
// Line 58-59: Apply Hann window to EXISTING buffer
for (i = 0; i < samps_20ms; i++)
    e->fft.in2k[i] = e->pcm.Buffer[e->pcm.WindowPtr + i - samps_10ms] / 32768.0 * Hann[i];
```

**Our Implementation:**
```go
// Get 20ms window LOOKING BACKWARD from current position
windowStart := v.windowPtr - samps10ms
window, err := pcmBuffer.GetWindowAbsolute(windowStart, samps20ms)
```

### 4. Buffer Accumulation vs Streaming
**Problem:** The decoder accumulated samples in a growing buffer and tried to detect VIS from the entire buffer. This broke the real-time streaming nature of VIS detection.

**Fix:** Refactored decoder to use streaming architecture:
- Circular buffer continuously fed by audio channel
- VIS detection processes audio in real-time (10ms chunks)
- Proper timing maintained throughout

**Files Changed:**
- `audio_extensions/sstv/decoder.go` - New `detectVISStreaming()`, `decodeVideoStreaming()`, `decodeFSKIDStreaming()` methods

### 5. Gaussian Interpolation Verification
**Problem:** Needed to verify the Gaussian interpolation formula matched KiwiSDR exactly.

**Fix:** Verified implementation matches KiwiSDR line-by-line:

**KiwiSDR (line 84):**
```cpp
HeaderBuf[HedrPtr] = MaxBin + (SSTV_MLOG(pwr_po / pwr_mo )) / (2 * SSTV_MLOG( SSTV_MPOW(pwr_mb, 2) / (pwr_po * pwr_mo)));
```

**Our Implementation:**
```go
delta := math.Log(numerator) / (2.0 * math.Log(denominator))
peakFreq = (float64(maxBin) + delta) / float64(v.fftSize) * v.sampleRate
```

✅ **Verified:** Formula matches exactly, including edge case handling.

## Comparison with KiwiSDR

### PCM Buffer Management
| Aspect | KiwiSDR | UberSDR (Fixed) | Status |
|--------|---------|-----------------|--------|
| Buffer Size | 4096 samples | 4096 samples | ✅ Match |
| Buffer Type | Circular | Circular | ✅ Match |
| Window Pointer | `WindowPtr` | `windowPtr` | ✅ Match |
| Read Size | 10ms chunks | 10ms chunks | ✅ Match |
| FFT Window | 20ms backward | 20ms backward | ✅ Match |

### FFT Processing
| Aspect | KiwiSDR | UberSDR (Fixed) | Status |
|--------|---------|-----------------|--------|
| FFT Size | 2048 | 2048 | ✅ Match |
| FFT Library | FFTW | Pure Go radix-2 | ✅ Equivalent |
| Power Calc | `coeff[0]^2 + coeff[1]^2` | `real^2 + imag^2` | ✅ Match |
| Bin Mapping | `freq/rate*FFTLen` | `freq/rate*FFTLen` | ✅ Match |

### VIS Detection
| Aspect | KiwiSDR | UberSDR (Fixed) | Status |
|--------|---------|-----------------|--------|
| Header Buffer | 100 samples (1s) | 100 samples (1s) | ✅ Match |
| Tone Buffer | 100 samples | 100 samples | ✅ Match |
| Leader Check | 4x 30ms @ 1900Hz | 4x 30ms @ 1900Hz | ✅ Match |
| Start Bit | 1200Hz (700Hz below) | 1200Hz (700Hz below) | ✅ Match |
| Data Bits | 1300Hz=0, 1100Hz=1 | 1300Hz=0, 1100Hz=1 | ✅ Match |
| Tolerance | ±25 Hz | ±25 Hz | ✅ Match |

## Testing Recommendations

### 1. Unit Tests
Create tests for:
- FFT with known sine wave (e.g., 1900 Hz)
- Circular buffer operations
- Window extraction

### 2. Integration Tests
Test with:
- Known SSTV audio files
- KiwiSDR test files (if available)
- Live SSTV signals

### 3. Validation
Compare output with KiwiSDR:
- VIS code detection timing
- Detected frequencies
- Mode identification

## Expected Behavior

With these fixes, the SSTV extension should now:

1. ✅ **Detect VIS codes** - The streaming architecture and proper windowing enable real-time VIS detection
2. ✅ **Report accurate frequencies** - FFT and Gaussian interpolation match KiwiSDR exactly
3. ✅ **Maintain proper timing** - 10ms read / 20ms FFT window with correct overlap
4. ✅ **Handle all VIS modes** - Both 8-bit and 16-bit VIS codes supported
5. ✅ **Process in real-time** - Circular buffer enables continuous streaming

## Files Modified

1. **audio_extensions/sstv/fft.go** - Pure Go FFT implementation
2. **audio_extensions/sstv/pcm_buffer.go** - Circular PCM buffer (NEW)
3. **audio_extensions/sstv/vis.go** - Streaming VIS detection
4. **audio_extensions/sstv/decoder.go** - Streaming decoder architecture

## Build and Test

```bash
# Build the project
go build

# Run with SSTV extension enabled
./ka9q_ubersdr

# Monitor logs for VIS detection
# Look for: "[SSTV VIS] Found leader..." messages
```

## Debugging

If VIS detection still fails:

1. **Check FFT output** - Add debug logging to verify frequencies are detected
2. **Verify buffer fill** - Ensure circular buffer fills before VIS detection starts
3. **Check timing** - Verify 10ms reads and 20ms FFT windows
4. **Compare with KiwiSDR** - Use same audio file on both systems

## References

- KiwiSDR SSTV implementation: `/home/nathan/repos/KiwiSDR/extensions/SSTV/`
- Original slowrx by Oona Räisänen (OH2EIQ)
- SSTV specification: VIS code structure and timing
