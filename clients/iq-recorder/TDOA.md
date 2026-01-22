# TDOA (Time Difference of Arrival) with IQ Recorder

## Overview

The IQ recorder's GPS timestamp alignment feature enables precise Time Difference of Arrival (TDOA) measurements for RF geolocation and direction finding applications. This document explains how the alignment works, its capabilities, limitations, and accuracy.

## How GPS Timestamp Alignment Works

### 1. Connection and Buffering Phase

When recording from multiple UberSDR instances:

```bash
./iq-recorder \
  -host sdr1.example.com -port 8080 \
  -host sdr2.example.com -port 8080 \
  -host sdr3.example.com -port 8080 \
  -frequency 14074000 -duration 300
```

Each recorder:
- Connects to its assigned instance
- Begins buffering incoming IQ packets
- Extracts GPS timestamps from each packet (nanosecond precision)
- Waits for all instances to receive their first GPS timestamp

### 2. Alignment Timestamp Calculation

Once all instances have received their first GPS timestamp:

1. **Find the latest first timestamp** across all instances
2. **Add 1 second** to ensure all instances have data at this point
3. **Set this as the alignment timestamp** (shared across all recorders)

Example:
```
Instance 1 first packet: 15:40:17.305 UTC
Instance 2 first packet: 15:40:17.316 UTC  ← Latest
Instance 3 first packet: 15:40:17.298 UTC

Alignment timestamp: 15:40:18.316 UTC (latest + 1 second)
```

### 3. Buffer Processing and Trimming

Each recorder processes its buffered packets:

- **Packets before alignment time**: Discarded
- **Packets at/after alignment time**: Written to file
- **First packet crossing boundary**: Trimmed to exact alignment point

The trimming calculation:
```
timeDiff = packetTimestamp - alignmentTimestamp (in nanoseconds)
samplesToSkip = (timeDiff × sampleRate) / 1,000,000,000
bytesToSkip = samplesToSkip × 4  (2 channels × 2 bytes per sample)
```

### 4. Synchronized Recording

After buffer processing:
- All recorders write a WAV header
- Continue recording live packets
- Only write packets with timestamps ≥ alignment time
- All files share the same timestamp in their filename

## Timing Precision

### Sample-Level Precision

IQ48 mode provides **48 kHz bandwidth** (±24 kHz from center frequency):
- **Complex sample rate**: 48,000 samples/second
- **Sample period**: 1/48000 = 20.833 microseconds
- **Alignment precision**: ±1 sample = ±20.833 μs
- **Distance equivalent**: 6.25 km (c × 20.833 μs)

This is the fundamental quantum of the system - you cannot align better than one sample period. The 48 kHz bandwidth means you're capturing 48 kHz of spectrum centered on your tuned frequency.

### GPS Timestamp Precision

- **GPS timestamps**: Nanosecond precision from SDR hardware
- **Absolute time reference**: All instances synchronized to GPS time
- **Trimming accuracy**: Calculated to nearest sample boundary

The GPS nanosecond precision ensures we know exactly where each sample sits in absolute time, but the alignment is quantized to sample boundaries.

## TDOA Measurement Capabilities

### Raw Timing Resolution

**Minimum detectable TDOA**: 20.833 microseconds (1 sample)
- Limited by 48 kHz sample rate
- Represents coarse timing resolution
- Distance equivalent: 6.25 km

### Sub-Sample Interpolation (Post-Processing)

Using cross-correlation with interpolation:
- **Typical improvement**: 10-100x
- **Achievable TDOA precision**: 0.2 - 2.0 microseconds
- **Distance equivalent**: 60 - 600 meters

Interpolation techniques:
- Parabolic interpolation of correlation peak
- Sinc interpolation
- Phase-based methods (for narrowband signals)

### Signal-Dependent Performance

| Signal Type | Bandwidth | TDOA Precision | Distance Precision |
|-------------|-----------|----------------|-------------------|
| **Wideband** | 2.5 kHz | ~0.5 μs | ~150 m |
| **Narrowband** | 500 Hz | ~2 μs | ~600 m |
| **Very Narrow** | 50 Hz (FT8) | ~5 μs | ~1.5 km |

Wider bandwidth signals provide sharper correlation peaks and better TDOA precision.

## Geolocation Accuracy

### Expected Performance

With 3+ receivers and good geometry:

| Scenario | TDOA Precision | Geolocation Accuracy |
|----------|----------------|---------------------|
| **Optimal** (wideband, high SNR, good geometry) | 0.5 μs | 150-500 m |
| **Good** (narrowband, good SNR) | 2 μs | 600m-2 km |
| **Fair** (very narrow, moderate SNR) | 5 μs | 1.5-5 km |

### Factors Affecting Accuracy

**Positive factors:**
- ✅ Higher signal-to-noise ratio (SNR)
- ✅ Wider signal bandwidth
- ✅ Longer baselines between receivers
- ✅ Good geometric dilution of precision (GDOP)
- ✅ More receivers (3 minimum, 4+ better)

**Negative factors:**
- ❌ Multipath propagation
- ❌ Ionospheric effects (HF frequencies)
- ❌ Poor receiver geometry (collinear baselines)
- ❌ Low SNR
- ❌ Narrow bandwidth signals

## Limitations

### 1. Bandwidth Limitation

**48 kHz bandwidth** (IQ48 mode):
- Raw timing resolution: ±20.833 μs
- For better resolution, use higher bandwidth modes:
  - IQ96 (96 kHz bandwidth): ±10.4 μs resolution
  - IQ192 (192 kHz bandwidth): ±5.2 μs resolution
  - IQ384 (384 kHz bandwidth): ±2.6 μs resolution

Note: Higher bandwidth = more samples per second = better timing resolution

### 2. Network Latency

- Buffering compensates for network delays
- 1-second buffer ensures all instances have data at alignment point
- Longer buffering may be needed for high-latency networks

### 3. Ionospheric Propagation (HF)

At HF frequencies (3-30 MHz):
- Signals may take multiple paths (multipath)
- Ionospheric delays vary with time of day
- TDOA measures signal arrival time, not direct path
- Best for ground-wave or line-of-sight signals

### 4. Geometric Constraints

- Requires 3+ receivers for 2D position
- Requires 4+ receivers for 3D position
- Poor geometry (collinear receivers) degrades accuracy
- Hyperbolic position lines must intersect at good angles

## Practical Applications

### Excellent For:
- ✅ **HF direction finding** (sub-kilometer to few-km accuracy)
- ✅ **Interference localization** (identify transmitter locations)
- ✅ **Propagation studies** (measure signal paths)
- ✅ **Amateur radio fox hunting** (hidden transmitter hunts)
- ✅ **Signal intelligence** (SIGINT applications)

### Suitable For:
- ✅ **Regional geolocation** (within 1-5 km)
- ✅ **Bearing estimation** (combined with other techniques)
- ✅ **Time-domain beamforming**
- ✅ **Coherent signal processing**

### Not Ideal For:
- ❌ **Precision geolocation** (<100m) without higher sample rates
- ❌ **VHF/UHF TDOA** (wavelengths too short for 48 kHz)
- ❌ **Real-time tracking** (post-processing required)

## Example Workflow

### 1. Record Synchronized Data

```bash
./iq-recorder \
  -host receiver1.net -port 8080 -name rx1 \
  -host receiver2.net -port 8080 -name rx2 \
  -host receiver3.net -port 8080 -name rx3 \
  -frequency 14074000 -duration 300 \
  -output-dir /recordings
```

### 2. Verify Alignment

Check the logs:
```
All instances ready. Alignment timestamp: 2026-01-21 15:40:18.316 UTC
[rx1] Trimmed 207 samples from first live packet
[rx2] Trimmed 15 samples from first live packet
[rx3] Trimmed 89 samples from first live packet
```

All files will have the same timestamp:
```
rx1_14074000_2026-01-21T15:40:18.316Z.wav
rx2_14074000_2026-01-21T15:40:18.316Z.wav
rx3_14074000_2026-01-21T15:40:18.316Z.wav
```

### 3. Post-Processing (External Tools)

Use tools like:
- **GNU Radio** - Cross-correlation and TDOA estimation
- **MATLAB/Octave** - Signal processing and geolocation
- **Python (scipy)** - Cross-correlation with interpolation
- **KiwiSDR TDoA** - Web-based TDOA processing

Example Python workflow:
```python
import numpy as np
from scipy import signal
from scipy.io import wavfile

# Load synchronized recordings
fs1, iq1 = wavfile.read('rx1_14074000_2026-01-21T15:40:18.316Z.wav')
fs2, iq2 = wavfile.read('rx2_14074000_2026-01-21T15:40:18.316Z.wav')

# Convert to complex IQ
iq1_complex = iq1[:, 0] + 1j * iq1[:, 1]
iq2_complex = iq2[:, 0] + 1j * iq2[:, 1]

# Cross-correlate
correlation = signal.correlate(iq1_complex, iq2_complex, mode='full')

# Find peak with sub-sample interpolation
peak_idx = np.argmax(np.abs(correlation))
# ... interpolation and TDOA calculation ...
```

## Comparison to Other Systems

| System | Timing Precision | Bandwidth | Typical Accuracy |
|--------|-----------------|-----------|------------------|
| **This system (IQ48)** | ±20.833 μs | 48 kHz | 150m - 5 km |
| **IQ192 mode** | ±5.2 μs | 192 kHz | 50m - 1 km |
| **KiwiSDR TDoA** | ±83 μs | 12 kHz | 1-10 km |
| **Professional TDOA** | ±50-100 ns | GHz BW | <10 m |
| **GPS receivers** | ±10-20 ns | N/A | <1 m |

## Recommendations

### For Best TDOA Performance:

1. **Use wider bandwidth signals** when possible
2. **Deploy receivers with good geometry** (not collinear)
3. **Maximize baseline distances** (within propagation limits)
4. **Record during stable propagation** (avoid sunrise/sunset at HF)
5. **Use 4+ receivers** for better position accuracy
6. **Consider higher sample rates** (IQ96, IQ192) if available
7. **Apply post-processing interpolation** for sub-sample precision

### Baseline Recommendations:

For HF (3-30 MHz):
- **Minimum baseline**: 10 km
- **Optimal baseline**: 50-200 km
- **Maximum baseline**: Limited by propagation (500-1000 km for ground wave)

## Conclusion

The IQ recorder's GPS timestamp alignment provides **sample-accurate synchronization** suitable for TDOA-based geolocation at HF frequencies. With 48 kHz sampling, you can achieve:

- **Raw timing precision**: ±20.833 microseconds
- **With interpolation**: ±0.5-5 microseconds
- **Geolocation accuracy**: 150 meters to 5 kilometers

This makes it an excellent tool for HF direction finding, interference localization, and propagation studies. For applications requiring higher precision, consider using higher sample rate modes (IQ96, IQ192, IQ384) which proportionally improve the timing resolution.
