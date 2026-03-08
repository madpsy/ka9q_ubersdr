# SDR++ SSB Demodulation Architecture

## Overview
This document explains exactly how SDR++ implements SSB (Single Sideband) demodulation, particularly how it handles VFO reference positioning and bandwidth changes without detuning.

## Key Components

### 1. VFO Reference Types
SDR++ defines three VFO reference types (from `waterfall.h`):
- `REF_CENTER`: VFO marker at center of passband
- `REF_LOWER`: VFO marker at lower edge of passband (used for USB)
- `REF_UPPER`: VFO marker at upper edge of passband (used for LSB)

### 2. Offset Calculations

#### From `waterfall.cpp` lines 1286-1307 (`setOffset` function):

When you set a VFO offset (tune to a frequency), SDR++ calculates three offsets:

**For REF_CENTER:**
```cpp
centerOffset = offset;
lowerOffset = offset - (bandwidth / 2.0);
upperOffset = offset + (bandwidth / 2.0);
```

**For REF_LOWER (USB):**
```cpp
lowerOffset = offset;
centerOffset = offset + (bandwidth / 2.0);
upperOffset = offset + bandwidth;
```

**For REF_UPPER (LSB):**
```cpp
upperOffset = offset;
centerOffset = offset - (bandwidth / 2.0);
lowerOffset = offset - bandwidth;
```

#### From `waterfall.cpp` lines 1328-1349 (`setBandwidth` function):

When bandwidth changes:

**For REF_LOWER (USB):**
```cpp
centerOffset = lowerOffset + (bandwidth / 2.0);
upperOffset = lowerOffset + bandwidth;
```
- `lowerOffset` stays FIXED
- `centerOffset` CHANGES with bandwidth

**For REF_UPPER (LSB):**
```cpp
centerOffset = upperOffset - (bandwidth / 2.0);
lowerOffset = upperOffset - bandwidth;
```
- `upperOffset` stays FIXED
- `centerOffset` CHANGES with bandwidth

### 3. SSB Demodulator

#### From `ssb.h` lines 106-116 (`getTranslation` function):

```cpp
double getTranslation() {
    if (_mode == Mode::USB) {
        return _bandwidth / 2.0;
    }
    else if (_mode == Mode::LSB) {
        return -_bandwidth / 2.0;
    }
    else {
        return 0.0;
    }
}
```

#### From `ssb.h` lines 47-54 (`setBandwidth` function):

```cpp
void setBandwidth(double bandwidth) {
    assert(base_type::_block_init);
    std::lock_guard<std::recursive_mutex> lck(base_type::ctrlMtx);
    base_type::tempStop();
    _bandwidth = bandwidth;
    xlator.setOffset(getTranslation(), _samplerate);  // Updates shift!
    base_type::tempStart();
}
```

When bandwidth changes, the xlator offset is updated to the new `±bandwidth/2`.

#### From `ssb.h` lines 77-92 (`process` function):

```cpp
int process(int count, const complex_t* in, T* out) {
    // Move back sideband
    xlator.process(count, in, xlator.out.writeBuf);

    if constexpr (std::is_same_v<T, float>) {
        convert::ComplexToReal::process(count, xlator.out.writeBuf, out);
        agc.process(count, out, out);
    }
    // ...
    return count;
}
```

## Signal Flow

### USB Mode (REF_LOWER)

**Initial Setup: User tunes to 14.074 MHz with 2700 Hz bandwidth**

1. **VFO System:**
   - `lowerOffset` = 14.074 MHz (the edge, stays fixed)
   - `centerOffset` = 14.074 + 0.00135 = 14.07535 MHz
   - Signal to demodulator is centered at `centerOffset` (14.07535 MHz)

2. **Demodulator:**
   - Input: IQ centered at 14.07535 MHz
   - Xlator shifts by `+bandwidth/2` = `+1350 Hz`
   - After shift: 14.07535 + 0.00135 = 14.0767 MHz
   - Take real part: Creates symmetric spectrum
   - Lowpass filter: Extracts audio

3. **Net Effect:**
   - The carrier at 14.074 MHz (lower edge) ends up at a specific position in the audio
   - The upper sideband (14.074 to 14.0767 MHz) is extracted

**Bandwidth Changes to 3000 Hz:**

1. **VFO System:**
   - `lowerOffset` = 14.074 MHz (UNCHANGED - edge stays fixed!)
   - `centerOffset` = 14.074 + 0.0015 = 14.0755 MHz (CHANGED!)
   - Signal to demodulator is now centered at 14.0755 MHz

2. **Demodulator:**
   - Input: IQ centered at 14.0755 MHz
   - Xlator shifts by `+bandwidth/2` = `+1500 Hz` (CHANGED!)
   - After shift: 14.0755 + 0.0015 = 14.077 MHz
   - Take real part and filter

3. **Net Effect:**
   - The carrier at 14.074 MHz is still at the same position in the audio
   - The passband is wider (14.074 to 14.077 MHz) but the edge hasn't moved
   - NO DETUNING because the edge (carrier) position is preserved

### LSB Mode (REF_UPPER)

**Initial Setup: User tunes to 7.103 MHz with 2700 Hz bandwidth**

1. **VFO System:**
   - `upperOffset` = 7.103 MHz (the edge, stays fixed)
   - `centerOffset` = 7.103 - 0.00135 = 7.10165 MHz
   - Signal to demodulator is centered at `centerOffset` (7.10165 MHz)

2. **Demodulator:**
   - Input: IQ centered at 7.10165 MHz
   - Xlator shifts by `-bandwidth/2` = `-1350 Hz`
   - After shift: 7.10165 - 0.00135 = 7.1003 MHz
   - Take real part and filter

3. **Net Effect:**
   - The carrier at 7.103 MHz (upper edge) ends up at a specific position
   - The lower sideband (7.1003 to 7.103 MHz) is extracted

**Bandwidth Changes to 3000 Hz:**

1. **VFO System:**
   - `upperOffset` = 7.103 MHz (UNCHANGED - edge stays fixed!)
   - `centerOffset` = 7.103 - 0.0015 = 7.1015 MHz (CHANGED!)
   - Signal to demodulator is now centered at 7.1015 MHz

2. **Demodulator:**
   - Input: IQ centered at 7.1015 MHz
   - Xlator shifts by `-bandwidth/2` = `-1500 Hz` (CHANGED!)
   - After shift: 7.1015 - 0.0015 = 7.100 MHz
   - Take real part and filter

3. **Net Effect:**
   - The carrier at 7.103 MHz is still at the same position in the audio
   - The passband is wider (7.100 to 7.103 MHz) but the edge hasn't moved
   - NO DETUNING because the edge (carrier) position is preserved

## Key Insight

The magic is in the **two-stage offset calculation**:

1. **VFO System Stage:** Converts edge offset to center offset
   - USB: `center = edge + bandwidth/2`
   - LSB: `center = edge - bandwidth/2`
   - When bandwidth changes, center changes but edge stays fixed

2. **Demodulator Stage:** Shifts by ±bandwidth/2
   - USB: shifts by `+bandwidth/2`
   - LSB: shifts by `-bandwidth/2`
   - When bandwidth changes, shift amount changes

3. **Combined Effect:**
   - USB: `(edge + bw/2) + bw/2 = edge + bw` (edge position preserved)
   - LSB: `(edge - bw/2) - bw/2 = edge - bw` (edge position preserved)
   - The two bandwidth-dependent terms cancel out in terms of edge positioning

## Implementation Requirements

To replicate this in our Python IQ recorder:

1. **Treat `target_freq` as the EDGE (not center)**
   - USB: edge is lower edge (like REF_LOWER)
   - LSB: edge is upper edge (like REF_UPPER)

2. **Calculate center from edge:**
   - USB: `center = target_freq + bandwidth/2`
   - LSB: `center = target_freq - bandwidth/2`

3. **Shift center to DC in audio preview:**
   - `shift_hz = center_freq - center`

4. **Demodulator shifts by ±bandwidth/2:**
   - USB: shift by `+bandwidth/2`
   - LSB: shift by `-bandwidth/2`

5. **Result:**
   - Edge stays at DC regardless of bandwidth changes
   - No detuning occurs
