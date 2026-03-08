# Phase 6 Integration Guide - Step by Step

## Current Status

✅ **Imports Added**: Lines 12-16 already have `json`, `os`, `Path`, `Dict`, `Any`
✅ **Backend Complete**: AudioChannel and AudioChannelMixer classes exist and work
✅ **Code Written**: All Phase 6 code is in [`PHASE_6_CODE_SNIPPETS.py`](PHASE_6_CODE_SNIPPETS.py)

❌ **Not Yet Integrated**: The tabbed UI methods are not in [`iq_spectrum_display.py`](iq_spectrum_display.py)

## Integration Steps

### Step 1: Add Configuration Loading to `__init__()` Method

**Location**: After line 196 in [`iq_spectrum_display.py`](iq_spectrum_display.py)

**Add this code:**
```python
        # Load saved channel configuration
        if MULTI_CHANNEL_AVAILABLE and self.audio_mixer:
            self.load_channel_configuration()
            # If no channels loaded, ensure we have at least one
            if self.audio_mixer.get_channel_count() == 0:
                default_channel = self.audio_mixer.add_channel(name="Channel 1")
                if default_channel:
                    self.active_channel_id = default_channel.channel_id
```

### Step 2: Replace `create_audio_controls()` Method

**Location**: Lines 204-348 in [`iq_spectrum_display.py`](iq_spectrum_display.py)

**Replace entire method with:**
```python
    def create_audio_controls(self):
        """Create multi-channel tabbed audio control panel"""
        # Main control container
        self.control_container = ttk.Frame(self.parent)
        self.control_container.pack(side=tk.BOTTOM, fill=tk.X, padx=5, pady=5)
        
        # Check if multi-channel is available
        if not MULTI_CHANNEL_AVAILABLE or not self.audio_mixer:
            # Fallback to legacy single-channel UI
            self._create_legacy_audio_controls()
            return
        
        # Tab Bar for Channel Selection
        tab_bar_frame = ttk.Frame(self.control_container)
        tab_bar_frame.pack(side=tk.TOP, fill=tk.X, pady=(0, 5))
        
        # Container for channel tabs
        self.tab_buttons_frame = ttk.Frame(tab_bar_frame)
        self.tab_buttons_frame.pack(side=tk.LEFT, fill=tk.X, expand=True)
        
        # Dictionary to store tab button widgets
        self.channel_tab_buttons = {}
        
        # Add Channel button
        self.add_channel_button = ttk.Button(
            tab_bar_frame,
            text="+ Add Channel",
            command=self.on_add_channel_clicked,
            width=12
        )
        self.add_channel_button.pack(side=tk.RIGHT, padx=2)
        
        # Channel Control Panel
        self.channel_control_panel = ttk.Frame(self.control_container)
        self.channel_control_panel.pack(side=tk.TOP, fill=tk.X)
        
        # Create control widgets
        self._create_channel_control_widgets()
        
        # Initialize UI with existing channels
        self._refresh_channel_tabs()
        self._update_channel_controls()
```

### Step 3: Add All New Methods

**Location**: Append to end of IQSpectrumDisplay class (before the last line of the file)

**Copy all methods from [`PHASE_6_CODE_SNIPPETS.py`](PHASE_6_CODE_SNIPPETS.py):**

1. `_create_channel_control_widgets()` - ~100 lines
2. `_create_legacy_audio_controls()` - ~100 lines (copy existing create_audio_controls body)
3. `_refresh_channel_tabs()` - ~20 lines
4. `_create_channel_tab()` - ~30 lines
5. `_update_channel_controls()` - ~40 lines
6. `_enable_channel_controls()` - ~10 lines
7. `_disable_channel_controls()` - ~10 lines
8. `on_tab_clicked()` - ~10 lines
9. `on_tab_close_clicked()` - ~15 lines
10. `on_add_channel_clicked()` - ~15 lines
11. `on_channel_name_changed()` - ~10 lines
12. `on_channel_active_changed()` - ~5 lines
13. `on_channel_device_changed()` - ~10 lines
14. `on_channel_output_changed()` - ~10 lines
15. `on_channel_start_stop()` - ~20 lines
16. `on_channel_mode_changed()` - ~25 lines
17. `on_channel_bandwidth_changed()` - ~15 lines
18. `on_channel_volume_changed()` - ~15 lines
19. `on_channel_freq_changed()` - ~30 lines
20. `on_channel_lock_changed()` - ~10 lines
21. `on_channel_agc_changed()` - ~10 lines
22. `get_channel_config_path()` - ~5 lines
23. `save_channel_configuration()` - ~25 lines
24. `load_channel_configuration()` - ~50 lines
25. Update `get_selected_audio_device_index()` - ~15 lines

**Total new code**: ~650 lines

### Step 4: Update `on_mouse_motion()` Method

**Location**: Find the `on_mouse_motion()` method (around line 700-800)

**Add after calculating `freq_hz`:**
```python
        # Update active channel frequency if not locked (multi-channel mode)
        if self.audio_mixer:
            active_channel = self.get_active_channel()
            if active_channel and not active_channel.locked:
                active_channel.set_frequency(freq_hz)
                # Update frequency display if tabbed UI is active
                if hasattr(self, 'channel_freq_var'):
                    self.channel_freq_var.set(f"{freq_hz/1e6:.6f}")
```

## Verification Checklist

After integration, verify:

- [ ] File imports include: `json`, `os`, `Path`, `Dict`, `Any`
- [ ] `__init__()` calls `load_channel_configuration()`
- [ ] `create_audio_controls()` creates tabbed interface
- [ ] All 25 new methods are added to the class
- [ ] `on_mouse_motion()` updates active channel
- [ ] File syntax is valid (no indentation errors)
- [ ] No duplicate method definitions

## Testing After Integration

```bash
cd clients/python_iq_recorder
python3 iq_spectrum_display.py
```

Expected behavior:
1. Window opens with spectrum display
2. Bottom shows tabbed interface with one default channel
3. Can add channels (up to 6)
4. Can switch between channels by clicking tabs
5. Each channel has independent controls
6. Settings save to `~/.iq_recorder_channels.json`
7. Settings load on next startup

## Quick Integration Script

For automated integration, you could use:

```bash
# Backup original
cp iq_spectrum_display.py iq_spectrum_display.py.backup

# Manual integration required due to file size
# Follow steps 1-4 above
```

## File Size Impact

- **Current**: 1681 lines
- **After Phase 6**: ~2330 lines (+650 lines)
- **Estimated file size**: ~85 KB

## Alternative: Modular Approach

If the file becomes too large, consider splitting into modules:

```
iq_spectrum_display.py (main class)
iq_spectrum_display_ui.py (UI methods)
iq_spectrum_display_config.py (configuration methods)
```

But for now, keeping everything in one file maintains simplicity.

## Summary

Phase 6 is **DESIGNED AND CODED** but requires **MANUAL INTEGRATION** due to:
1. File size (1681 lines)
2. Complex method replacement
3. Need to preserve existing functionality

All code is ready in [`PHASE_6_CODE_SNIPPETS.py`](PHASE_6_CODE_SNIPPETS.py) - just needs to be copied into the appropriate locations in [`iq_spectrum_display.py`](iq_spectrum_display.py).

**Estimated integration time**: 30-60 minutes
**Estimated testing time**: 30-60 minutes
**Total**: 1-2 hours to complete Phase 6 integration
