# Software Frequency Shift Implementation

## Overview

The CW Skimmer DLL driver now implements **software-based frequency shifting** instead of retuning the radio. This allows Skimmer Server to receive frequency-corrected IQ data without sending tune messages to the ka9q_ubersdr server.

## Key Changes

### 1. ReceiverInfo Structure (UberSDR.h)

Added phase accumulator fields for software frequency shifting:

```cpp
struct ReceiverInfo {
    // ... existing fields ...
    
    // Software frequency shifting (applied in IQ processing, not at tune)
    double phaseAccumulator;  // Current phase for frequency shift
    double phaseIncrement;    // Phase increment per sample (2*PI*offset/sampleRate)
};
```

### 2. BuildWebSocketURL (UberSDR.cpp)

**Removed** frequency offset from WebSocket URL:
- Previously: `frequency + totalOffset`
- Now: `frequency` (no offset applied at tune time)

### 3. SetFrequency (UberSDR.cpp)

**Removed** frequency offset from tune messages:
- Previously: `{"type":"tune","frequency":(frequency + totalOffset)}`
- Now: `{"type":"tune","frequency":frequency}` (no offset)

### 4. ConsumeRingBuffers (UberSDRIntf.cpp)

**Implemented** software frequency shift using complex multiplication:

```cpp
// Complex multiply: (I + jQ) * e^(j*phase) = (I + jQ) * (cos + j*sin)
double cosPhase = cos(phase);
double sinPhase = sin(phase);

shifted_I = I_float * cosPhase - Q_float * sinPhase;
shifted_Q = I_float * sinPhase + Q_float * cosPhase;

// Increment phase
phase += phaseIncrement;
```

**Key points:**
- Shift is applied **after** reading from ring buffer
- Shift is applied **before** writing to Skimmer's processing buffer
- WAV recordings get **original (unshifted)** IQ data for debugging
- Monitor's circular buffer gets **original (unshifted)** IQ data
- **Only Skimmer Server receives shifted IQ data**

### 5. ProcessCommands (UberSDR.cpp)

**Updated** to calculate phase increment when offset changes:

```cpp
// Calculate phase increment for software frequency shift
// phaseIncrement = 2 * PI * offset / sampleRate
double phaseInc = 2.0 * 3.14159265358979323846 * (double)totalOffset / (double)sampleRate;

receivers[rxID].phaseIncrement = phaseInc;
receivers[rxID].phaseAccumulator = 0.0;  // Reset phase
```

**Important:** No longer calls `SetFrequency()` to retune - offset is purely software-based.

### 6. StartReceiver (UberSDRIntf.cpp)

**Added** initialization of phase increment using INI global offset:

```cpp
double totalOffset = (double)myUberSDR.frequencyOffset;
double phaseInc = 2.0 * 3.14159265358979323846 * totalOffset / (double)gSampleRate;

myUberSDR.receivers[i].phaseIncrement = phaseInc;
myUberSDR.receivers[i].phaseAccumulator = 0.0;
```

## How It Works

### Frequency Shift Algorithm

The software frequency shift is implemented as a **complex multiplication** in the time domain, which is equivalent to a frequency shift in the frequency domain:

1. **Phase Increment Calculation:**
   ```
   phaseIncrement = 2π × offset / sampleRate
   ```

2. **Per-Sample Processing:**
   ```
   For each IQ sample:
     cos_phase = cos(phaseAccumulator)
     sin_phase = sin(phaseAccumulator)
     
     shifted_I = I × cos_phase - Q × sin_phase
     shifted_Q = I × sin_phase + Q × cos_phase
     
     phaseAccumulator += phaseIncrement
     (wrap phase to ±2π to avoid precision loss)
   ```

3. **Result:**
   - Positive offset → shifts spectrum UP (higher frequencies)
   - Negative offset → shifts spectrum DOWN (lower frequencies)

### Data Flow

```
WebSocket → ProcessIQData() → Ring Buffer → ConsumeRingBuffers()
                                                    ↓
                                            [SOFTWARE SHIFT]
                                                    ↓
                                            Skimmer's pIQProc()
                                            (receives shifted IQ)

Monitor's circular buffer ← ProcessIQData() (receives original IQ)
WAV recording ← ConsumeRingBuffers() (receives original IQ)
```

## Performance Considerations

### CPU Cost
- **2 multiplications + 2 additions** per sample
- **1 sin() + 1 cos()** calculation per sample
- At 192 kHz: ~384,000 operations/second per receiver

### Optimization Opportunities (if needed)
1. Use `sinf()/cosf()` instead of `sin()/cos()` for faster float math
2. Implement lookup table for common phase values
3. Use SIMD (SSE/AVX) to process multiple samples at once
4. For very small offsets, use first-order approximation

## Advantages

1. **No radio retuning** - Server doesn't need to retune for small calibration offsets
2. **Skimmer Server gets corrected data** - Processes signals at corrected frequencies
3. **Monitor sees original data** - Can verify offset is working correctly
4. **Flexible** - Can change offset dynamically without reconnecting
5. **Suitable for small offsets** - Perfect for calibration (typically < 500 Hz)

## Limitations

1. **Bandwidth loss** - Shifting by N Hz loses N Hz on one edge of the spectrum
   - For 192 kHz bandwidth, losing 200 Hz is negligible (0.1%)
2. **CPU overhead** - Adds sin/cos calculations per sample
   - Minimal impact on modern CPUs
3. **Best for small offsets** - Designed for calibration, not large frequency changes

## Configuration

### INI File (UberSDRIntf.ini)

```ini
[Calibration]
FrequencyOffset=0  ; Global offset in Hz (applied to all receivers)
```

### Dynamic Offset (via Monitor)

Use the monitor application to set per-receiver offsets dynamically:
- Offsets are applied in software (no retuning)
- Total offset = INI global offset + per-receiver offset
- Changes take effect immediately

## Testing

To verify the implementation:

1. **Set a known offset** (e.g., +100 Hz) via monitor
2. **Tune to a known signal** (e.g., WWV at 10 MHz)
3. **Check Skimmer Server** - Should decode signal at corrected frequency
4. **Check monitor display** - Should show original (unshifted) spectrum
5. **Check WAV recording** - Should contain original (unshifted) IQ data

## Troubleshooting

### Signals appear at wrong frequencies
- Check that `phaseIncrement` is calculated correctly
- Verify `sampleRate` matches actual IQ mode (48/96/192 kHz)
- Check sign of offset (positive = shift up, negative = shift down)

### Performance issues
- Monitor CPU usage - should be minimal
- Consider optimizations if needed (see Performance section)

### Phase wrapping issues
- Phase accumulator wraps at ±2π to avoid precision loss
- Should not cause audible artifacts

## Future Enhancements

Possible improvements:
1. Add option to choose between software shift and radio retuning
2. Implement fast math optimizations (lookup tables, SIMD)
3. Add metrics to track shift performance
4. Support larger offsets with automatic mode switching
