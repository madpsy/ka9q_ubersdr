# Wide Bin Mode Fix for Real Inputs (RX888)

## Problem Description

The wide bin mode in `spectrum.c` had a bug that prevented it from correctly handling real inputs (like the RX888) when trying to cover the full DC-to-Nyquist bandwidth (e.g., 0-30 MHz).

### Original Issues

1. **Incorrect bin indexing**: When `chan->filter.bin_shift - input_bins/2` went negative (covering from DC), the code would pad with zeros instead of reading actual FFT data
2. **Wrong spectrum layout assumption**: The merging logic assumed a symmetric spectrum with negative and positive frequencies, but real inputs only have positive frequencies (0 to Nyquist)

## Solution

The fix adds special handling for real inputs covering the full bandwidth while preserving the original behavior for:
- Complex inputs (which have both positive and negative frequencies)
- Real inputs covering only partial bandwidth
- Inverted spectrum real inputs

### Changes Made

#### 1. Bin Reading Logic (lines 296-360)

Added detection for full-bandwidth coverage:
```c
int requested_start = chan->filter.bin_shift - input_bins/2;
int requested_end = chan->filter.bin_shift + input_bins/2;

if(requested_start <= 0 && requested_end >= master->bins - 1){
    // Full bandwidth - use linear mapping
    for(int i = 0; i < input_bins; i++){
        double bin_ratio = (double)master->bins / input_bins;
        int binp = (int)(i * bin_ratio);
        if(binp >= 0 && binp < master->bins)
            power_buffer[i] = cnrmf(fdomain[binp]);
        else
            power_buffer[i] = 0;
    }
}
```

This maps the available FFT bins linearly to the requested output bins without zero-padding at the edges.

#### 2. Bin Merging Logic (lines 323-380)

Added detection for real inputs covering full bandwidth:
```c
bool is_real_full_bw = (master->in_type == REAL) && 
                       (abs(chan->filter.bin_shift) - input_bins/2 <= 0) &&
                       (abs(chan->filter.bin_shift) + input_bins/2 >= master->bins - 1);
```

When detected, uses simple linear mapping instead of the complex negative/positive frequency split:
```c
if(is_real_full_bw){
    // Linear mapping for real inputs covering DC to Nyquist
    double ratio = (double)input_bins / bin_count;
    for(int out = 0; out < bin_count; out++){
        // Map and average input bins to output bins
        ...
    }
}
```

## Safety Features

The fix is designed to be **completely safe** and **backward compatible**:

1. **Conditional activation**: Only activates when specific conditions are met (real input + full bandwidth coverage)
2. **Preserves original logic**: All other cases use the original, tested code paths
3. **No changes to complex inputs**: Complex input handling remains unchanged
4. **No changes to partial coverage**: Real inputs covering partial bandwidth use original logic

## Testing

To test the fix with an RX888:

1. Configure radiod with a spectrum channel covering 0-30 MHz:
```ini
[spectrum-30mhz]
mode = spectrum
freq = 15e6
bin-count = 256
bin-bw = 30000
```

2. Start radiod and verify:
   - No zero-padding at spectrum edges
   - Correct frequency mapping across the full 0-30 MHz range
   - Smooth power distribution without gaps

3. Also test that existing functionality still works:
   - Complex input receivers (should see no change)
   - Narrower bandwidth spectrum channels (should see no change)
   - Partial bandwidth coverage (should see no change)

## Technical Details

### RX888 Specifications
- Sample rate: 64.8 MHz
- Input type: REAL
- Usable spectrum: 0 to 32.4 MHz (Nyquist)
- Typical use case: 0-30 MHz HF coverage

### Detection Criteria

Full bandwidth coverage is detected when:
```c
requested_start = bin_shift - input_bins/2 <= 0
requested_end = bin_shift + input_bins/2 >= master->bins - 1
```

This means the requested spectrum extends from (or near) DC to (or near) Nyquist.

### Bin Mapping

For full bandwidth real inputs:
- Input bins: `[0 ... master->bins-1]` (e.g., 0-32.4 MHz)
- Output bins: `[0 ... bin_count-1]` (e.g., 256 bins)
- Mapping: Linear interpolation from input to output

## Future Improvements

Possible enhancements (not critical):
1. Add weighted averaging for fractional bin boundaries
2. Optimize for specific common bin ratios
3. Add debug logging for bin mapping verification

## References

- Original bug report: Wide bin mode fails for RX888 covering 0-30 MHz
- Related file: `ka9q-radio/src/spectrum.c`
- Function: `spectrum_poll()` (lines 235-390)