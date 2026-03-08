# Phase 6: Multi-Channel Tabbed UI Implementation

## Status: READY FOR IMPLEMENTATION

This document describes Phase 6 of the multi-channel audio architecture: implementing the tabbed user interface for managing multiple audio channels.

## Overview

Phase 6 builds upon the completed foundation:
- ✅ **Phase 1-2**: Core classes implemented ([`iq_audio_channel.py`](iq_audio_channel.py), [`iq_audio_mixer.py`](iq_audio_mixer.py))
- ✅ **Phase 3-4**: Multi-channel marker drawing and keyboard shortcuts implemented
- ✅ **Phase 5**: Channel management methods implemented
- 🔨 **Phase 6**: **Tabbed UI Interface** (THIS PHASE)

## Current State

### What Exists
1. **Backend Infrastructure** ✅
   - [`AudioChannel`](iq_audio_channel.py) class - fully functional
   - [`AudioChannelMixer`](iq_audio_mixer.py) class - fully functional
   - Channel management methods in [`iq_spectrum_display.py`](iq_spectrum_display.py)
   - Multi-channel marker drawing
   - Keyboard shortcuts (1-6 to switch channels, Tab to cycle)

2. **UI Limitations** ❌
   - Still using single-channel control panel
   - No visual tabs for channels
   - No per-channel control interface
   - No configuration persistence

### What Needs Implementation

The tabbed UI interface as described in the architecture document (lines 292-388).

## Implementation Plan

### 1. Replace `create_audio_controls()` Method

**Location**: [`iq_spectrum_display.py`](iq_spectrum_display.py) line 204-348

**Current**: Single-channel controls in one horizontal row
**New**: Tabbed interface with:
- Tab bar showing all channels
- Per-channel control panel
- Add/Remove channel buttons

### 2. UI Structure

```
┌──────────────────────────────────────────────────────────────────────┐
│ Spectrum Canvas (960x400)                                            │
│ [Spectrum with multiple colored markers]                             │
├──────────────────────────────────────────────────────────────────────┤
│ Tab Bar                                                              │
│ ┌─────────────┬─────────────┬─────────────┬───────────────┐         │
│ │ ● FT8     ×│ ● Voice   ×│ ● CW      ×│ + Add Channel │         │
│ │  (Cyan)    │  (Orange)  │  (Green)   │               │         │
│ └─────────────┴─────────────┴─────────────┴───────────────┘         │
├──────────────────────────────────────────────────────────────────────┤
│ Active Channel Controls: "FT8"                                       │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Name: [FT8____________]  ☑ Active (responds to hover)           │ │
│ │                                                                  │ │
│ │ Device: [Default Audio Device ▼]  Output: [☑L ☑R]  [▶ Start]  │ │
│ │                                                                  │ │
│ │ Mode: [USB ▼]  BW: [2700 Hz ▬▬▬▬▬]  Vol: [50% ▬▬▬▬]           │ │
│ │                                                                  │ │
│ │ Freq: [14.074000 MHz]  [☐ Lock]  [☑ AGC]                       │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### 3. Key Components to Add

#### A. Tab Bar (`_create_tab_bar()`)
- Frame containing channel tabs
- Each tab shows:
  - Colored dot (● in channel color)
  - Channel name
  - Close button (×)
- "+" button to add new channel
- Active tab highlighted (sunken relief)

#### B. Channel Control Panel (`_create_channel_control_panel()`)
Two rows of controls:

**Row 1:**
- Name entry field
- "Active" checkbox (which channel responds to hover)
- Audio device selector
- L/R output checkboxes
- Start/Stop button

**Row 2:**
- Mode selector (USB/LSB/CWU/CWL)
- Bandwidth slider with label
- Volume slider with label
- Frequency entry field
- Lock checkbox (🔒)
- AGC checkbox

#### C. Tab Management Methods
```python
def _refresh_channel_tabs(self):
    """Rebuild all tab buttons"""

def _create_channel_tab(self, channel):
    """Create a single tab button"""

def _update_channel_controls(self):
    """Update control panel to show active channel settings"""

def on_tab_clicked(self, channel_id):
    """Handle tab selection"""

def on_tab_close_clicked(self, channel_id):
    """Handle tab close button"""

def on_add_channel_clicked(self):
    """Handle add channel button"""
```

#### D. Control Event Handlers
```python
def on_channel_name_changed(self, event=None):
def on_channel_device_changed(self, event=None):
def on_channel_output_changed(self):
def on_channel_start_stop(self):
def on_channel_mode_changed(self, event=None):
def on_channel_bandwidth_changed(self, value):
def on_channel_volume_changed(self, value):
def on_channel_freq_changed(self, event=None):
def on_channel_lock_changed(self):
def on_channel_agc_changed(self):
```

#### E. Configuration Persistence
```python
def save_channel_configuration(self):
    """Save to ~/.iq_recorder_channels.json"""

def load_channel_configuration(self):
    """Load from ~/.iq_recorder_channels.json"""

def get_channel_config_path(self):
    """Return Path to config file"""
```

### 4. Configuration File Format

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
    }
  ],
  "active_channel_id": 1,
  "master_volume": 1.0,
  "auto_gain": true
}
```

### 5. Integration Points

#### Modify `__init__()` method:
```python
# After initializing audio_mixer, load saved configuration
if MULTI_CHANNEL_AVAILABLE and self.audio_mixer:
    self.load_channel_configuration()
    # If no channels loaded, create default
    if self.audio_mixer.get_channel_count() == 0:
        default_channel = self.audio_mixer.add_channel(name="Channel 1")
        if default_channel:
            self.active_channel_id = default_channel.channel_id
```

#### Update mouse motion handler:
```python
def on_mouse_motion(self, event):
    # ... existing code ...
    
    # Update active channel frequency if not locked
    if self.audio_mixer:
        active_channel = self.get_active_channel()
        if active_channel and not active_channel.locked:
            active_channel.set_frequency(freq_hz)
            # Update frequency display
            if hasattr(self, 'channel_freq_var'):
                self.channel_freq_var.set(f"{freq_hz/1e6:.6f}")
```

### 6. Backward Compatibility

Keep legacy single-channel mode as fallback:

```python
def create_audio_controls(self):
    """Create audio preview control panel"""
    if not MULTI_CHANNEL_AVAILABLE or not self.audio_mixer:
        # Fallback to legacy single-channel UI
        self._create_legacy_audio_controls()
        return
    
    # New multi-channel tabbed UI
    self._create_tabbed_multi_channel_ui()
```

### 7. Testing Checklist

- [ ] Tab creation and deletion
- [ ] Tab switching updates control panel
- [ ] Control changes update active channel
- [ ] Multiple channels can play simultaneously
- [ ] Each channel has independent settings
- [ ] Configuration saves on changes
- [ ] Configuration loads on startup
- [ ] Keyboard shortcuts still work (1-6, Tab)
- [ ] Mouse hover updates active channel frequency
- [ ] Locked channels don't follow mouse
- [ ] Channel markers draw correctly
- [ ] Maximum 6 channels enforced
- [ ] Removing active channel switches to another
- [ ] Legacy mode works when multi-channel unavailable

### 8. Implementation Steps

1. **Backup current file**
   ```bash
   cp iq_spectrum_display.py iq_spectrum_display.py.backup
   ```

2. **Add imports** (already done)
   ```python
   import json
   import os
   from pathlib import Path
   ```

3. **Replace `create_audio_controls()` method**
   - Lines 204-348 in current file
   - Replace with new tabbed implementation

4. **Add new methods** (append to file)
   - Tab management methods
   - Control event handlers
   - Configuration persistence methods

5. **Update `__init__()` method**
   - Add configuration loading after mixer initialization

6. **Update mouse handlers**
   - Modify `on_mouse_motion()` to update active channel

7. **Test thoroughly**
   - Create multiple channels
   - Switch between channels
   - Modify settings
   - Restart application
   - Verify configuration persistence

### 9. Code Size Estimate

- New `create_audio_controls()`: ~200 lines
- Tab management methods: ~150 lines
- Event handlers: ~200 lines
- Configuration methods: ~100 lines
- **Total new/modified code**: ~650 lines

### 10. Benefits

✅ **Professional multi-channel interface**
✅ **Intuitive tab-based navigation**
✅ **Per-channel independent controls**
✅ **Configuration persistence**
✅ **Backward compatible**
✅ **Matches architecture specification**

## Next Steps

1. Review this implementation plan
2. Implement the tabbed UI
3. Test with multiple channels
4. Update user documentation
5. Create demo video/screenshots

## References

- [Multi-Channel Audio Architecture](MULTI_CHANNEL_AUDIO_ARCHITECTURE.md)
- [AudioChannel Class](iq_audio_channel.py)
- [AudioChannelMixer Class](iq_audio_mixer.py)
- [IQSpectrumDisplay Class](iq_spectrum_display.py)

## Notes

- The implementation preserves all existing functionality
- Legacy single-channel mode remains available as fallback
- All channel management methods already exist
- Only UI layer needs to be implemented
- Configuration format matches architecture specification

---

**Status**: Ready for implementation
**Estimated Time**: 4-6 hours
**Complexity**: Medium (UI refactoring)
**Risk**: Low (backward compatible, well-defined spec)
