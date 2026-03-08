# SDR++ Complete SSB Signal Chain

## Overview
SDR++ uses a two-stage approach: VFO filtering/decimation, then SSB demodulation.

## Stage 1: RxVFO (core/src/dsp/channel/rx_vfo.h)

The VFO does filtering and decimation BEFORE the demodulator:

```cpp
// Line 89-100: process() function
xlator.process(count, in, out);           // 1. Shift by -offset
if (!filterNeeded) {
    return resamp.process(count, out, out);  // 2. Resample only
}
count = resamp.process(count, out, out);     // 2. Resample
filter.process(count, out, out);             // 3. Lowpass filter
return count;
```

### Key Points:
- **FrequencyXlator** (line 90): Shifts by `-offset` to center VFO at DC
- **RationalResampler** (line 92/94): Decimates (e.g., 96 kHz → 24 kHz)
- **Lowpass FIR Filter** (line 97): Filters COMPLEX IQ with cutoff at `bandwidth/2`
  - Line 119: `double filterWidth = _bandwidth / 2.0;`
  - Line 120: `ftaps = taps::lowPass(filterWidth, filterWidth * 0.1, _outSamplerate);`
  - This is a COMPLEX lowpass filter applied to IQ samples
  - Cutoff frequency: `bandwidth/2` (e.g., 1350 Hz for 2700 Hz bandwidth)
  - Sample rate: `_outSamplerate` (e.g., 24 kHz)

## Stage 2: SSB Demodulator (core/src/dsp/demod/ssb.h)

The demodulator is simple - NO filtering:

```cpp
// Line 77-92: process() function
xlator.process(count, in, xlator.out.writeBuf);  // 1. Shift by ±bandwidth/2
convert::ComplexToReal::process(count, xlator.out.writeBuf, out);  // 2. Take real part
agc.process(count, out, out);  // 3. AGC
```

### Key Points:
- **FrequencyXlator**: Shifts by `+bandwidth/2` (USB) or `-bandwidth/2` (LSB)
- **ComplexToReal**: Takes real part of complex signal
- **AGC**: Automatic gain control
- **NO lowpass filter** - filtering already done in RxVFO!

## Why This Works

1. **RxVFO filters the complex IQ** with a lowpass at `bandwidth/2`
   - This removes frequencies outside the desired passband
   - Filter is applied to COMPLEX signal, so it's a true bandpass around DC

2. **SSB demodulator shifts and extracts**
   - Shifts by ±bandwidth/2 to position sideband correctly
   - Takes real part to extract audio
   - No additional filtering needed

3. **Bandwidth changes**
   - RxVFO filter cutoff changes (bandwidth/2)
   - SSB demodulator shift changes (±bandwidth/2)
   - Both change proportionally, keeping signal tuned

## Implementation for Python IQ Recorder

We need to add a complex lowpass filter BEFORE the SSB demodulator:

1. **In audio preview (before demodulation):**
   - Shift center_offset to DC
   - Apply complex lowpass filter with cutoff at `bandwidth/2`
   - Pass filtered IQ to demodulator

2. **In SSB demodulator:**
   - Shift by ±bandwidth/2
   - Take real part
   - NO additional filtering

This matches SDR++ exactly.
