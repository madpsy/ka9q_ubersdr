# Multi-Channel Audio Preview Architecture

## Overview

This document describes the architecture for implementing multiple simultaneous audio preview channels in the IQ Spectrum Display, allowing users to monitor multiple frequencies with independent demodulation settings, each with a distinct color-coded visual marker.

## Current Architecture (Single Channel)

### Components

```
┌─────────────────────────────────────────────────────────────┐
│ IQSpectrumDisplay                                           │
│  ├─ Canvas (spectrum visualization)                         │
│  ├─ Audio Controls (single set)                             │
│  ├─ AudioPreviewController (single instance)                │
│  │   ├─ FrequencyShifter                                    │
│  │   ├─ Demodulators (USB/LSB/CWU/CWL)                      │
│  │   ├─ AGC                                                 │
│  │   └─ AudioOutputManager                                  │
│  └─ Mouse/Keyboard Handlers                                 │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
IQ Samples → FrequencyShifter → Demodulator → AGC → AudioOutput
                    ↑                                      ↓
              hover_freq                            Speakers/Headphones
```

### Limitations

- Only one frequency can be monitored at a time
- Single demodulation mode active
- One audio output stream
- Mouse hover controls single frequency

## Proposed Architecture (Multi-Channel)

### High-Level Component Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│ IQSpectrumDisplay                                                    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ Canvas (Spectrum Visualization)                            │    │
│  │  ├─ Spectrum Line (green)                                  │    │
│  │  ├─ Grid & Frequency Labels                               │    │
│  │  ├─ Channel 1 Marker (cyan)                               │    │
│  │  ├─ Channel 2 Marker (orange)                             │    │
│  │  ├─ Channel 3 Marker (green)                              │    │
│  │  └─ ... up to 6 channels                                  │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ Channel Manager UI                                         │    │
│  │  ├─ Active Channel Selector                               │    │
│  │  ├─ [+ Add Channel] [- Remove Channel]                    │    │
│  │  └─ Channel Control Panels (1-6)                          │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ AudioChannelMixer                                          │    │
│  │  ├─ Channel 1 (AudioChannel)                              │    │
│  │  ├─ Channel 2 (AudioChannel)                              │    │
│  │  ├─ Channel 3 (AudioChannel)                              │    │
│  │  ├─ ...                                                    │    │
│  │  └─ Shared AudioOutputManager                             │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  └─ Mouse/Keyboard Handlers → Active Channel Only                   │
└──────────────────────────────────────────────────────────────────────┘
```

### New Components

#### 1. AudioChannel Class

**File**: `iq_audio_channel.py`

**Purpose**: Encapsulates all state and behavior for a single audio preview channel.

**Properties**:
```python
class AudioChannel:
    channel_id: int              # Unique identifier (1-6)
    name: str                    # Custom channel name (e.g., "FT8", "Voice")
    color: str                   # Hex color code (#00FFFF, etc.)
    frequency: int               # Target frequency in Hz
    mode: str                    # Demodulation mode (USB/LSB/CWU/CWL)
    bandwidth: int               # Filter bandwidth in Hz
    volume: float                # Channel volume (0.0-1.0)
    left_enabled: bool           # Output to left speaker
    right_enabled: bool          # Output to right speaker
    locked: bool                 # Frequency locked (not following hover)
    enabled: bool                # Channel active/inactive
    device_index: Optional[int]  # Audio device (None = shared)
    
    # Internal components
    audio_preview: AudioPreviewController
    marker_ids: List[int]        # Canvas marker IDs
```

**Methods**:
```python
def __init__(self, channel_id, color, sample_rate, center_freq, name=None)
def start(self) -> bool
def stop()
def set_name(self, name: str)
def set_frequency(self, freq_hz: int)
def set_mode(self, mode: str)
def set_bandwidth(self, bandwidth_hz: int)
def set_volume(self, volume: float)
def set_output_routing(self, left: bool, right: bool)
def process_iq_samples(self, iq_samples: np.ndarray) -> np.ndarray
def to_dict(self) -> dict
@staticmethod
def from_dict(data: dict) -> AudioChannel
```

#### 2. AudioChannelMixer Class

**File**: `iq_audio_mixer.py`

**Purpose**: Manages multiple audio channels and mixes their outputs.

**Properties**:
```python
class AudioChannelMixer:
    channels: List[AudioChannel]
    shared_output: AudioOutputManager
    sample_rate: int
    center_freq: int
    max_channels: int = 6
    auto_gain: bool = True
    master_volume: float = 1.0
```

**Methods**:
```python
def __init__(self, sample_rate, center_freq, audio_sample_rate=48000)
def add_channel(self, color: str) -> AudioChannel
def remove_channel(self, channel_id: int) -> bool
def get_channel(self, channel_id: int) -> Optional[AudioChannel]
def process_iq_samples(self, iq_samples: np.ndarray)
def mix_and_output(self)
def normalize_gain(self, mixed_audio: np.ndarray) -> np.ndarray
def start() -> bool
def stop()
def get_active_channels(self) -> List[AudioChannel]
```

**Mixing Algorithm**:
```python
def mix_and_output(self):
    """Mix all channel outputs to stereo"""
    left_sum = np.zeros(buffer_size)
    right_sum = np.zeros(buffer_size)
    
    for channel in self.channels:
        if not channel.enabled:
            continue
            
        # Get demodulated audio from channel
        audio = channel.get_audio_buffer()
        
        # Apply channel volume
        audio *= channel.volume
        
        # Route to L/R based on channel settings
        if channel.left_enabled:
            left_sum += audio
        if channel.right_enabled:
            right_sum += audio
    
    # Create stereo array
    stereo = np.column_stack([left_sum, right_sum])
    
    # Normalize to prevent clipping
    if self.auto_gain:
        stereo = self.normalize_gain(stereo)
    
    # Apply master volume
    stereo *= self.master_volume
    
    # Output to shared device
    self.shared_output.write(stereo)
```

#### 3. Modified IQSpectrumDisplay Class

**File**: `iq_spectrum_display.py` (modified)

**Key Changes**:

**Replace**:
```python
# OLD (single channel)
self.audio_preview = AudioPreviewController(...)
self.hover_freq = center_freq
self.freq_locked = False
self.locked_freq = None
```

**With**:
```python
# NEW (multi-channel)
self.audio_mixer = AudioChannelMixer(sample_rate, center_freq)
self.active_channel_id = None  # Which channel responds to hover
```

**New Methods**:
```python
def create_channel_manager_ui(self)
def create_channel_controls(self, channel: AudioChannel)
def add_channel(self) -> AudioChannel
def remove_channel(self, channel_id: int)
def set_active_channel(self, channel_id: int)
def get_active_channel(self) -> Optional[AudioChannel]
def draw_all_channel_markers(self)
def draw_channel_marker(self, channel: AudioChannel, is_active: bool)
def update_channel_controls_ui(self)
```

### Data Flow Diagram

```
                    ┌─────────────────────────────────────┐
                    │   IQ Samples from Radio Stream      │
                    └──────────────┬──────────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────────────┐
                    │   IQSpectrumDisplay.add_iq_samples() │
                    └──────────────┬───────────────────────┘
                                   │
                    ┌──────────────┴───────────────┐
                    │                              │
                    ▼                              ▼
        ┌───────────────────────┐    ┌────────────────────────┐
        │  Spectrum FFT         │    │  AudioChannelMixer     │
        │  (visualization)      │    │  .process_iq_samples() │
        └───────────────────────┘    └────────┬───────────────┘
                                              │
                        ┌─────────────────────┼─────────────────────┐
                        │                     │                     │
                        ▼                     ▼                     ▼
              ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
              │ Channel 1       │   │ Channel 2       │   │ Channel 3       │
              │ ┌─────────────┐ │   │ ┌─────────────┐ │   │ ┌─────────────┐ │
              │ │Freq Shifter │ │   │ │Freq Shifter │ │   │ │Freq Shifter │ │
              │ └──────┬──────┘ │   │ └──────┬──────┘ │   │ └──────┬──────┘ │
              │        ▼        │   │        ▼        │   │        ▼        │
              │ ┌─────────────┐ │   │ ┌─────────────┐ │   │ ┌─────────────┐ │
              │ │Demodulator  │ │   │ │Demodulator  │ │   │ │Demodulator  │ │
              │ │   (USB)     │ │   │ │   (CWU)     │ │   │ │   (LSB)     │ │
              │ └──────┬──────┘ │   │ └──────┬──────┘ │   │ └──────┬──────┘ │
              │        ▼        │   │        ▼        │   │        ▼        │
              │ ┌─────────────┐ │   │ ┌─────────────┐ │   │ ┌─────────────┐ │
              │ │    AGC      │ │   │ │    AGC      │ │   │ │    AGC      │ │
              │ └──────┬──────┘ │   │ └──────┬──────┘ │   │ └──────┬──────┘ │
              └────────┼────────┘   └────────┼────────┘   └────────┼────────┘
                       │                     │                     │
                       └─────────────────────┼─────────────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │  AudioChannelMixer           │
                              │  .mix_and_output()           │
                              │                              │
                              │  Left  = Ch1*V1 + Ch2*V2 ... │
                              │  Right = Ch1*V1 + Ch3*V3 ... │
                              │                              │
                              │  Normalize if > 0.9          │
                              └──────────────┬───────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │  AudioOutputManager          │
                              │  (Shared Stereo Device)      │
                              └──────────────┬───────────────┘
                                             ▼
                                    ┌────────────────┐
                                    │  Speakers /    │
                                    │  Headphones    │
                                    └────────────────┘
```

### UI Layout Design

#### Tabbed Interface (Selected Design)

The tabbed interface provides a clean, familiar UI pattern where each channel has its own tab with custom name and color. Tabs are positioned directly below the spectrum canvas, replacing the current single-channel controls.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Spectrum Canvas (960x400)                                            │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │                                                                  │ │
│ │  [Spectrum with multiple colored markers - Cyan, Orange, Green] │ │
│ │                                                                  │ │
│ └──────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────┤
│ Tab Bar                                                              │
│ ┌─────────────┬─────────────┬─────────────┬───┐                     │
│ │ FT8 (Cyan)×│ Voice (Org)×│ CW (Green)×│ + │                     │
│ └─────────────┴─────────────┴─────────────┴───┘                     │
├──────────────────────────────────────────────────────────────────────┤
│ Active Tab Content: "FT8" Channel                                    │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Name: [FT8____________]  Active: [☑] This tab responds to hover │ │
│ │                                                                  │ │
│ │ Device: [Default Audio Device ▼]  Output: [☑L ☑R]  [▶ Start]  │ │
│ │                                                                  │ │
│ │ Mode: [USB ▼]  BW: [2700 Hz ▬▬▬▬▬▬▬]  Vol: [50% ▬▬▬▬▬░░░░]   │ │
│ │                                                                  │ │
│ │ Freq: [14.074000 MHz]  [☐ Lock]  AGC: [☑]                      │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

#### Tab Design Details

**Tab Structure**:
```
┌─────────────────┐
│ Name (Color) × │  ← Tab with custom name, color indicator, close button
└─────────────────┘
     ↑       ↑   ↑
     │       │   └─ Close button (×)
     │       └───── Color indicator (background or dot)
     └─────────── Custom editable name
```

**Tab States**:
- **Active Tab**: Highlighted background, bold text, shows controls below
- **Inactive Tab**: Dimmed, normal text, click to activate
- **Hover State**: Slight highlight to indicate clickable
- **Color Coding**: Each tab shows its channel color (background tint or colored dot)

**Tab Bar Features**:
1. **Custom Names**: Double-click tab to rename (e.g., "FT8", "Voice", "CW", "WSPR")
2. **Close Button**: × button on each tab to delete that channel
3. **Add Button**: + tab at the end to create new channel
4. **Drag to Reorder**: Optional - drag tabs to change order
5. **Color Indicator**: Visual cue matching spectrum marker color
6. **Max Tabs**: Limit to 6 tabs (MAX_CHANNELS)

**Tab Controls Panel**:
Each tab shows the same control layout (replacing current single-channel controls):
- Name field (editable)
- Active checkbox (which channel responds to mouse hover)
- Audio device selector
- L/R output checkboxes
- Start/Stop button
- Mode selector
- Bandwidth slider
- Volume slider
- Frequency display/entry
- Lock checkbox
- AGC checkbox

#### Alternative Tab Layouts

**Compact Tabs** (if space is limited):
```
┌───────┬───────┬───────┬─┐
│ FT8 ×│ Vce ×│ CW  ×│+│
└───────┴───────┴───────┴─┘
```

**Tabs with Color Dots**:
```
┌──────────────┬──────────────┬──────────────┬───┐
│ ● FT8      ×│ ● Voice    ×│ ● CW       ×│ + │
│ (cyan)      │ (orange)    │ (green)     │   │
└──────────────┴──────────────┴──────────────┴───┘
```

**Tabs with Status Icons**:
```
┌─────────────────┬─────────────────┬─────────────────┬───┐
│ 🔊 FT8 (Cyan) ×│ 🔇 Voice (Org)×│ 🔒 CW (Green) ×│ + │
└─────────────────┴─────────────────┴─────────────────┴───┘
   ↑                ↑                ↑
   Playing          Muted            Locked
```

### Visual Marker System

#### Marker Rendering

Each channel draws:

1. **Bandwidth Rectangle**: Semi-transparent colored box showing filter passband
2. **Center Line**: Dashed vertical line at carrier frequency
3. **Mode Label**: Text showing mode and bandwidth at top
4. **Frequency Label**: Text showing frequency at bottom
5. **Channel Number**: Small badge with channel number
6. **Lock Indicator**: 🔒 icon if frequency locked

**Active Channel Highlighting**:
- Thicker lines (3px vs 2px)
- Brighter color (100% opacity vs 70%)
- Pulsing animation (optional)

**Canvas Tag Structure**:
```python
# Per-channel tags
f"channel_{channel_id}_bandwidth"  # Rectangle
f"channel_{channel_id}_marker"     # Center line
f"channel_{channel_id}_label"      # Text labels
f"channel_{channel_id}_badge"      # Channel number

# Layer ordering (bottom to top)
"grid" → "channel_*_bandwidth" → "channel_*_marker" → "spectrum" → "channel_*_label"
```

### Mouse Interaction State Machine

```
┌─────────────────────────────────────────────────────────────┐
│                    Mouse Hover State                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  No Active       │
                    │  Channel         │
                    └────────┬─────────┘
                             │
                User selects │ channel
                             ▼
                    ┌──────────────────┐
                    │  Channel N       │◄──────────┐
                    │  Active          │           │
                    └────────┬─────────┘           │
                             │                     │
          Mouse moves        │                     │
                             ▼                     │
                    ┌──────────────────┐           │
                    │  Update Channel  │           │
                    │  N Frequency     │           │
                    └────────┬─────────┘           │
                             │                     │
          Left click         │                     │
                             ▼                     │
                    ┌──────────────────┐           │
                    │  Lock Channel N  │           │
                    │  Frequency       │           │
                    └────────┬─────────┘           │
                             │                     │
          Left click again   │                     │
                             ▼                     │
                    ┌──────────────────┐           │
                    │  Unlock Channel  │───────────┘
                    │  N Frequency     │
                    └──────────────────┘
```

### Configuration & Persistence

#### Configuration File Format

**File**: `~/.iq_recorder_channels.json`

```json
{
  "version": "1.0",
  "channels": [
    {
      "id": 1,
      "name": "FT8",
      "color": "#00FFFF",
      "frequency": 14074000,
      "mode": "USB",
      "bandwidth": 2700,
      "volume": 0.5,
      "left_enabled": true,
      "right_enabled": true,
      "locked": false,
      "enabled": true,
      "device_index": null,
      "agc_enabled": true
    },
    {
      "id": 2,
      "name": "Voice",
      "color": "#FF8800",
      "frequency": 14200000,
      "mode": "USB",
      "bandwidth": 2700,
      "volume": 0.6,
      "left_enabled": true,
      "right_enabled": true,
      "locked": false,
      "enabled": true,
      "device_index": null,
      "agc_enabled": true
    },
    {
      "id": 3,
      "name": "CW",
      "color": "#00FF00",
      "frequency": 14040000,
      "mode": "CWU",
      "bandwidth": 500,
      "volume": 0.75,
      "left_enabled": true,
      "right_enabled": false,
      "locked": true,
      "enabled": true,
      "device_index": null,
      "agc_enabled": true
    }
  ],
  "active_channel_id": 1,
  "active_tab_id": 1,
  "master_volume": 1.0,
  "auto_gain": true
}
```

#### Auto-Save Triggers

- Channel added/removed (tab added/closed)
- Channel renamed
- Channel settings changed (debounced 1 second)
- Tab switched
- Window closed
- Manual save button clicked

#### Default Channel Names

When creating new channels, auto-generate names based on:
1. **Frequency-based**: "14.074 MHz", "7.040 MHz"
2. **Mode-based**: "USB Channel 1", "CW Channel 2"
3. **Sequential**: "Channel 1", "Channel 2", "Channel 3"
4. **Smart Detection**: If frequency matches known band/mode:
   - 14.074 MHz → "FT8 20m"
   - 7.040 MHz → "CW 40m"
   - 14.200 MHz → "Voice 20m"

User can immediately rename by double-clicking the tab.

### Performance Considerations

#### CPU Usage

**Single Channel**: ~5-10% CPU (baseline)

**Per Additional Channel**:
- Frequency shifting: ~1-2% CPU
- Demodulation: ~2-3% CPU
- AGC: ~0.5% CPU
- **Total per channel**: ~3-5% CPU

**6 Channels Total**: ~20-35% CPU (acceptable on modern hardware)

#### Optimization Strategies

1. **Shared FFT**: Use same FFT for all channels (already done for spectrum)
2. **Vectorization**: Use NumPy operations for mixing
3. **Buffer Pooling**: Reuse audio buffers to reduce allocations
4. **Lazy Updates**: Only process enabled channels
5. **Thread Pooling**: Consider parallel demodulation for 4+ channels

#### Memory Usage

**Per Channel**:
- AudioPreviewController: ~2 MB
- Audio buffers: ~1 MB
- UI controls: ~0.5 MB
- **Total**: ~3.5 MB per channel

**6 Channels**: ~21 MB additional (negligible)

### Error Handling

#### Audio Device Errors

```python
try:
    channel.start()
except AudioDeviceError as e:
    # Show error dialog
    # Fallback to default device
    # Disable channel if persistent failure
```

#### Clipping Detection

```python
def normalize_gain(self, mixed_audio):
    max_val = np.max(np.abs(mixed_audio))
    if max_val > 0.95:
        # Log clipping event
        self.clipping_events += 1
        # Show warning if persistent
        if self.clipping_events > 10:
            show_clipping_warning()
        # Reduce gain
        return mixed_audio * (0.9 / max_val)
    return mixed_audio
```

#### Frequency Overlap Warning

```python
def check_frequency_overlap(self):
    """Detect overlapping channel bandwidths"""
    for i, ch1 in enumerate(self.channels):
        for ch2 in self.channels[i+1:]:
            if channels_overlap(ch1, ch2):
                # Show visual warning on spectrum
                # Don't block - user may want this
                mark_overlap_region(ch1, ch2)
```

### Testing Strategy

#### Unit Tests

```python
# test_audio_channel.py
def test_channel_creation()
def test_frequency_setting()
def test_mode_switching()
def test_serialization()

# test_audio_mixer.py
def test_add_remove_channels()
def test_mixing_algorithm()
def test_gain_normalization()
def test_stereo_routing()

# test_spectrum_display.py
def test_marker_drawing()
def test_mouse_interaction()
def test_channel_selection()
```

#### Integration Tests

```python
def test_single_channel_backward_compatibility()
def test_two_channel_stereo_separation()
def test_six_channel_maximum_load()
def test_channel_add_remove_during_playback()
def test_device_switching()
def test_configuration_persistence()
```

#### Performance Tests

```python
def test_cpu_usage_with_six_channels()
def test_audio_latency()
def test_no_dropouts_under_load()
def test_memory_usage()
```

### Migration Path

#### Backward Compatibility

Existing single-channel code should work without changes:

```python
# OLD CODE (still works)
display = IQSpectrumDisplay(parent, ...)
# Automatically creates one default channel

# NEW CODE (multi-channel)
display = IQSpectrumDisplay(parent, ...)
display.add_channel()  # Add second channel
display.add_channel()  # Add third channel
```

#### Migration Steps

1. **Phase 1**: Implement new classes without breaking existing code
2. **Phase 2**: Add multi-channel UI (hidden behind feature flag)
3. **Phase 3**: Test with beta users
4. **Phase 4**: Enable by default, keep single-channel as fallback
5. **Phase 5**: Remove old single-channel code after stable release

### Future Enhancements

#### Possible Extensions

1. **Channel Presets**: Save/load favorite channel configurations
2. **Frequency Scanning**: Auto-scan and populate channels
3. **Signal Detection**: Auto-tune to strongest signals
4. **Per-Channel Waterfall**: Mini waterfall display per channel
5. **Audio Recording**: Record each channel to separate file
6. **Network Streaming**: Stream channels to remote listeners
7. **Plugin System**: Custom demodulators per channel
8. **AI Features**: Auto-classify signals, suggest modes

## Summary

This architecture provides:

✅ **Scalability**: Support 1-6 simultaneous channels  
✅ **Flexibility**: Independent settings per channel  
✅ **Usability**: Color-coded visual feedback  
✅ **Performance**: Efficient mixing and processing  
✅ **Reliability**: Robust error handling  
✅ **Maintainability**: Clean separation of concerns  
✅ **Extensibility**: Easy to add new features  

The design leverages existing components (AudioPreviewController, AudioOutputManager) while adding new abstractions (AudioChannel, AudioChannelMixer) to manage complexity. The result is a professional multi-channel SDR monitoring experience.
