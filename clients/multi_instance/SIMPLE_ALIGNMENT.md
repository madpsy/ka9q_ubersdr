# Simple Offset-Based Alignment System

## Overview

This document describes the simplified alignment system that replaced the complex buffering/interpolation approach in `timestamp_sync.py`. The new system uses pre-calculated averaged timestamp offsets to align spectrum and audio data from multiple instances.

## Architecture

### Key Components

1. **`simple_alignment.py`** - Core alignment module with three main classes:
   - `SimpleAlignmentMetrics` - Tracks alignment statistics
   - `SimpleSpectrumAligner` - Handles spectrum data alignment
   - `SimpleAudioAligner` - Handles audio stream alignment

2. **`multi_spectrum_gui.py`** - GUI integration:
   - Calculates 5-second averaged timestamp differences between instances
   - Feeds these offsets to the alignment system
   - Displays alignment metrics

3. **`audio_preview.py`** - Audio integration:
   - Applies sample-level alignment based on offsets
   - Supports both simple alignment and legacy modes

## How It Works

### Timestamp Offset Calculation

The GUI (`multi_spectrum_gui.py`) already calculates stable timestamp differences:

```python
# Lines 2236-2311 in multi_spectrum_gui.py
# Calculates averaged timestamp difference over 5 second window
# Stores as: comparison_timestamp_history[f"{a_id}:{b_id}"] = [(time, diff_ms), ...]
```

These averaged offsets are much more stable than instantaneous measurements because:
- They smooth out network jitter
- They average over 5 seconds of data
- They only update the display every 1 second

### Spectrum Alignment

**Old Complex Approach (DISABLED):**
- Buffered spectrum frames with timestamps
- Used binary search to find matching timestamps
- Interpolated between frames
- Required complex clock drift compensation
- Caused performance issues

**New Simple Approach:**
```python
# Just track the offset for each instance
spectrum_aligner.update_offset(instance_id, offset_ms)

# When displaying, use offset to determine data freshness
aligned_timestamp = raw_timestamp - offset
```

The spectrum aligner doesn't buffer or interpolate. It simply:
1. Accepts offset updates from the GUI
2. Stores the offset for each instance
3. Can adjust timestamps when needed (though currently spectrum display doesn't use this)

### Audio Alignment

**Old Complex Approach (DISABLED):**
- Buffered audio with timestamps
- Searched for matching timestamps within tolerance
- Interpolated missing samples
- Required complex synchronization logic
- Caused audio glitches

**New Simple Approach:**
```python
# Convert offset to sample count
sample_offset = int((offset_ms / 1000.0) * sample_rate)

# Apply alignment by padding or dropping samples
if sample_offset > 0:
    # Instance is ahead, delay by padding zeros at start
    aligned = np.concatenate([zeros(sample_offset), audio_samples])
elif sample_offset < 0:
    # Instance is behind, advance by dropping samples from start
    aligned = audio_samples[abs(sample_offset):]
```

The audio aligner:
1. Accepts offset updates from the GUI
2. Converts millisecond offsets to sample counts
3. Applies simple padding (for ahead) or trimming (for behind)
4. No interpolation, no complex buffering

## Integration Flow

```
1. GUI calculates averaged timestamp differences (5s window)
   ↓
2. GUI calls _update_alignment_offsets() with the averaged offset
   ↓
3. Alignment system stores the offset
   ↓
4. Audio preview applies offset when receiving samples
   ↓
5. Aligned audio is added to playback buffer
```

## Benefits Over Complex System

1. **Simplicity**: ~270 lines vs ~700 lines of complex code
2. **Performance**: No lock contention, no interpolation overhead
3. **Stability**: Uses pre-averaged offsets instead of raw timestamps
4. **Maintainability**: Easy to understand and debug
5. **Reliability**: Fewer edge cases and failure modes

## Usage

### Enabling Simple Alignment

The system is enabled by default in `multi_spectrum_gui.py`:

```python
# Spectrum alignment (automatic)
if SIMPLE_ALIGNMENT_AVAILABLE:
    self.spectrum_aligner = SimpleSpectrumAligner()

# Audio alignment (automatic)
self.audio_preview = AudioPreviewManager(use_simple_alignment=True)
```

### Feeding Offsets

Offsets are automatically fed when comparing two instances:

```python
# In multi_spectrum_gui.py, _update_comparison_differences()
# After calculating averaged timestamp difference:
self._update_alignment_offsets(instance_a_id, instance_b_id)
```

### Monitoring

Alignment metrics are displayed in the Signal Levels window:
- Active offsets count
- Average offset magnitude
- Last update time

## Limitations

1. **Two-Instance Comparison**: Currently only aligns when comparing two instances (A vs B)
2. **Reference-Based**: Uses one instance as reference (offset = 0), aligns others relative to it
3. **No Interpolation**: Doesn't interpolate between samples (uses simple padding/trimming)
4. **Requires Comparison**: Alignment only active when instances are being compared in GUI

## Future Enhancements

Possible improvements:
1. Support alignment of 3+ instances simultaneously
2. Automatic reference selection (choose most stable instance)
3. Adaptive offset updates based on drift detection
4. Per-channel offset tracking for stereo audio

## Comparison with Old System

| Feature | Old Complex System | New Simple System |
|---------|-------------------|-------------------|
| Lines of code | ~700 | ~270 |
| Buffering | Yes (complex) | No (uses existing buffers) |
| Interpolation | Yes | No |
| Clock drift compensation | Yes (complex) | No (uses averaged offsets) |
| Performance impact | High (locks, interpolation) | Low (simple arithmetic) |
| Stability | Moderate (jitter sensitive) | High (uses 5s averages) |
| Maintenance | Difficult | Easy |
| Status | Disabled (performance issues) | Active |

## Testing

To test the alignment system:

1. Connect two instances to the same frequency
2. Enable comparison in Signal Levels window (select A and B)
3. Wait 5 seconds for averaged offsets to stabilize
4. Start audio preview on both channels
5. Observe alignment metrics and listen for synchronization

Expected behavior:
- Timestamp differences should stabilize after 5 seconds
- Audio should be aligned within ~50ms
- No audio glitches or dropouts
- Metrics should show active offsets

## Troubleshooting

**No alignment happening:**
- Check that two instances are selected for comparison
- Verify simple_alignment module is imported successfully
- Check Signal Levels window for offset values

**Audio still not aligned:**
- Ensure audio preview is using simple alignment (check startup messages)
- Verify offsets are being updated (check metrics)
- Try increasing comparison window if offsets are unstable

**Performance issues:**
- Simple alignment should have minimal overhead
- If issues persist, check for other bottlenecks
- Consider disabling alignment: `AudioPreviewManager(use_simple_alignment=False)`