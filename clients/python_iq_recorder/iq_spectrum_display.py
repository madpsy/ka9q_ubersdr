#!/usr/bin/env python3
"""
IQ Spectrum Display
Real-time FFT spectrum display for IQ recording streams with audio preview
"""

import tkinter as tk
from tkinter import Canvas, ttk, messagebox
import numpy as np
import threading
import time
import json
import os
from pathlib import Path
from collections import deque
from typing import Optional, List, Dict, Any

# Import audio preview components
try:
    from iq_audio_preview import AudioPreviewController
    AUDIO_PREVIEW_AVAILABLE = True
except ImportError as e:
    AUDIO_PREVIEW_AVAILABLE = False
    print(f"Warning: Audio preview not available: {e}")

# Import multi-channel components
try:
    from iq_audio_channel import AudioChannel
    from iq_audio_mixer import AudioChannelMixer
    MULTI_CHANNEL_AVAILABLE = True
except ImportError as e:
    MULTI_CHANNEL_AVAILABLE = False
    print(f"Warning: Multi-channel support not available: {e}")

# Multi-channel constants
CHANNEL_COLORS = [
    '#00FFFF',  # Cyan
    '#FF8800',  # Orange
    '#00FF00',  # Green
    '#FF00FF',  # Magenta
    '#FFFF00',  # Yellow
    '#FF0088',  # Pink
]
MAX_CHANNELS = 6

# FT8 frequencies for HF ham bands (in Hz)
FT8_BANDS = [
    {'min': 1800000, 'max': 2000000, 'ft8': 1840000, 'name': '160m'},
    {'min': 3500000, 'max': 4000000, 'ft8': 3573000, 'name': '80m'},
    {'min': 5330000, 'max': 5405000, 'ft8': 5357000, 'name': '60m'},
    {'min': 7000000, 'max': 7300000, 'ft8': 7074000, 'name': '40m'},
    {'min': 10100000, 'max': 10150000, 'ft8': 10136000, 'name': '30m'},
    {'min': 14000000, 'max': 14350000, 'ft8': 14074000, 'name': '20m'},
    {'min': 18068000, 'max': 18168000, 'ft8': 18100000, 'name': '17m'},
    {'min': 21000000, 'max': 21450000, 'ft8': 21074000, 'name': '15m'},
    {'min': 24890000, 'max': 24990000, 'ft8': 24915000, 'name': '12m'},
    {'min': 28000000, 'max': 29700000, 'ft8': 28074000, 'name': '10m'},
    {'min': 50000000, 'max': 54000000, 'ft8': 50313000, 'name': '6m'},
]


class IQSpectrumDisplay:
    """Real-time spectrum display for IQ data with audio preview"""
    
    def __init__(self, parent: tk.Widget, width: int = 960, height: int = 400,
                 sample_rate: int = 96000, center_freq: int = 14175000,
                 stream_id: int = None, config_manager=None):
        """
        Initialize spectrum display
        
        Args:
            parent: Parent tkinter widget
            width: Canvas width in pixels
            height: Canvas height in pixels
            sample_rate: IQ sample rate in Hz
            center_freq: Center frequency in Hz
            stream_id: Stream ID for channel configuration (optional)
            config_manager: ConfigManager instance for storing channels (optional)
        """
        self.parent = parent
        self.width = width
        self.height = height
        self.sample_rate = sample_rate
        self.center_freq = center_freq
        self.stream_id = stream_id
        self.config_manager = config_manager

        # Bandwidth settings (adjustable)
        self.ssb_bandwidth = 2700  # Default SSB bandwidth (Hz)
        self.cw_bandwidth = 500    # Default CW bandwidth (Hz)
        self.bandwidth_update_timer = None  # Timer for debouncing bandwidth updates

        # FFT parameters
        self.fft_size = 2048
        self.overlap = 0.5
        self.window = np.hanning(self.fft_size)
        
        # Spectrum data buffer
        self.iq_buffer = deque(maxlen=self.fft_size * 10)
        self.spectrum_data = np.zeros(self.fft_size)
        self.spectrum_lock = threading.Lock()
        
        # Averaging
        self.avg_count = 5
        self.spectrum_history = deque(maxlen=self.avg_count)
        
        # Auto-scaling parameters (like CW Skimmer Monitor)
        self.smoothed_min_db = -100.0
        self.smoothed_max_db = -40.0
        self.smoothing_factor = 0.1  # Smoothing for auto-scale
        self.running = True
        
        # Zoom parameters
        self.zoom_factor = 1.0  # 1.0 = no zoom, >1.0 = zoomed in
        self.zoom_center_freq = self.center_freq  # Frequency to center zoom on
        self.pan_offset = 0  # Pan offset in Hz when zoomed
        
        # Multi-channel audio (replaces single audio_preview)
        self.audio_mixer = None
        self.active_channel_id = None  # Which channel responds to hover

        # Legacy single-channel support (for backward compatibility)
        self.audio_preview = None  # Deprecated - use audio_mixer instead
        self.hover_freq = center_freq  # Frequency at mouse position (default to center)
        self.audio_marker_id = None  # Canvas ID for audio marker
        self.freq_locked = False  # Whether frequency is locked (fixed)
        self.locked_freq = None  # Locked frequency when fixed
        
        # Spectrum statistics
        self.baseline_db = -100.0  # Noise floor (25th percentile)
        self.min_db = -100.0
        self.max_db = -40.0
        self.signal_db = None  # Signal level at pointer (for SNR calculation)
        self.snr_db = None  # Signal-to-noise ratio
        
        # Initialize multi-channel audio mixer BEFORE creating controls
        if MULTI_CHANNEL_AVAILABLE:
            try:
                print("DEBUG: Attempting to initialize AudioChannelMixer...")
                self.audio_mixer = AudioChannelMixer(
                    sample_rate=sample_rate,
                    center_freq=center_freq,
                    audio_sample_rate=48000
                )
                print(f"DEBUG: AudioChannelMixer created: {self.audio_mixer}")
                # Don't create default channel here - let load_channel_configuration handle it
                # This prevents overwriting saved channel configurations
                print(f"✅ Multi-channel audio initialized (channels will be loaded from config)")
            except Exception as e:
                print(f"❌ ERROR: Could not initialize multi-channel audio: {e}")
                import traceback
                traceback.print_exc()
                self.audio_mixer = None
        else:
            print("⚠️  MULTI_CHANNEL_AVAILABLE is False")
            self.audio_mixer = None
        
        if AUDIO_PREVIEW_AVAILABLE and not self.audio_mixer:
            # Fallback to legacy single-channel mode
            try:
                self.audio_preview = AudioPreviewController(
                    sample_rate=sample_rate,
                    center_freq=center_freq,
                    audio_sample_rate=48000
                )
                # Set initial mode based on frequency (LSB for < 10 MHz, USB otherwise)
                initial_mode = "LSB" if center_freq < 10_000_000 else "USB"
                self.audio_preview.set_mode(initial_mode)
                print(f"✅ AudioPreviewController initialized with mode: {initial_mode} (center_freq={center_freq/1e6:.3f} MHz)")
            except Exception as e:
                print(f"Warning: Could not initialize audio preview: {e}")
                self.audio_preview = None
        
        # Create audio controls (after audio_mixer is initialized)
        self.create_audio_controls()
        
        # Create canvas
        self.canvas = Canvas(parent, width=width, height=height, bg='#000000')
        self.canvas.pack(fill=tk.BOTH, expand=True)
        
        # Bind mouse events for zoom and pan
        self.canvas.bind("<MouseWheel>", self.on_mouse_wheel)
        self.canvas.bind("<Button-4>", self.on_mouse_wheel)  # Linux scroll up
        self.canvas.bind("<Button-5>", self.on_mouse_wheel)  # Linux scroll down
        self.canvas.bind("<ButtonPress-2>", self.on_middle_click)  # Middle click to reset
        
        # Bind mouse motion for audio preview
        self.canvas.bind("<Motion>", self.on_mouse_motion)
        self.canvas.bind("<Leave>", self.on_mouse_leave)
        self.canvas.bind("<Button-1>", self.on_left_click)  # Left click to lock/unlock frequency
        
        # Bind keyboard events
        self.canvas.bind("<plus>", lambda e: self.zoom_in())
        self.canvas.bind("<equal>", lambda e: self.zoom_in())  # + without shift
        self.canvas.bind("<minus>", lambda e: self.zoom_out())
        self.canvas.bind("<Key-0>", lambda e: self.reset_zoom())

        # Multi-channel keyboard shortcuts
        self.canvas.bind("<Key-1>", lambda e: self.switch_to_channel(1))
        self.canvas.bind("<Key-2>", lambda e: self.switch_to_channel(2))
        self.canvas.bind("<Key-3>", lambda e: self.switch_to_channel(3))
        self.canvas.bind("<Key-4>", lambda e: self.switch_to_channel(4))
        self.canvas.bind("<Key-5>", lambda e: self.switch_to_channel(5))
        self.canvas.bind("<Key-6>", lambda e: self.switch_to_channel(6))
        self.canvas.bind("<Tab>", lambda e: self.cycle_active_channel())

        self.canvas.focus_set()  # Allow keyboard input
        
        # Bind resize event
        self.canvas.bind("<Configure>", self.on_canvas_resize)
        
        # Load saved channel configuration
        if MULTI_CHANNEL_AVAILABLE and self.audio_mixer:
            self.load_channel_configuration()
            # Don't auto-create a channel - let user add channels explicitly
            # This prevents confusion when clicking "Add Channel" on an empty spectrum
        
        # Draw initial grid
        self.draw_grid()
        
        # Start update loop
        self.update_display()
    
    def create_audio_controls(self):
        """Create multi-channel tabbed audio control panel"""
        print(f"DEBUG: create_audio_controls() called")
        print(f"DEBUG: MULTI_CHANNEL_AVAILABLE = {MULTI_CHANNEL_AVAILABLE}")
        print(f"DEBUG: self.audio_mixer = {self.audio_mixer}")
        
        # Main control container
        self.control_container = ttk.Frame(self.parent)
        self.control_container.pack(side=tk.BOTTOM, fill=tk.X, padx=5, pady=5)

        # Check if multi-channel is available
        if not MULTI_CHANNEL_AVAILABLE or not self.audio_mixer:
            # Fallback to legacy single-channel UI
            print(f"⚠️  Falling back to legacy single-channel UI")
            print(f"   Reason: MULTI_CHANNEL_AVAILABLE={MULTI_CHANNEL_AVAILABLE}, audio_mixer={self.audio_mixer}")
            self._create_legacy_audio_controls()
            return
        
        print(f"✅ Creating multi-channel tabbed UI")

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

        # Stop All button
        self.stop_all_button = ttk.Button(
            tab_bar_frame,
            text="⏹ Stop All",
            command=self.on_stop_all_clicked,
            width=10
        )
        self.stop_all_button.pack(side=tk.RIGHT, padx=2)

        # Start All button
        self.start_all_button = ttk.Button(
            tab_bar_frame,
            text="▶ Start All",
            command=self.on_start_all_clicked,
            width=10
        )
        self.start_all_button.pack(side=tk.RIGHT, padx=2)

        # Channel Control Panel
        self.channel_control_panel = ttk.Frame(self.control_container)
        self.channel_control_panel.pack(side=tk.TOP, fill=tk.X)

        # Create control widgets
        self._create_channel_control_widgets()

        # Initialize UI with existing channels
        self._refresh_channel_tabs()
        self._update_channel_controls()
    
    def on_freq_entry_submit(self, event=None):
        """Handle frequency entry submission (Enter key or focus out)"""
        try:
            # Parse frequency in MHz
            freq_mhz = float(self.freq_entry_var.get())
            freq_hz = int(freq_mhz * 1e6)

            # Validate frequency is within receiver range
            freq_min = self.center_freq - self.sample_rate / 2
            freq_max = self.center_freq + self.sample_rate / 2

            if freq_hz < freq_min or freq_hz > freq_max:
                # Out of range - show error and revert
                messagebox.showwarning(
                    "Frequency Out of Range",
                    f"Frequency must be between {freq_min/1e6:.6f} and {freq_max/1e6:.6f} MHz"
                )
                # Revert to current frequency
                if self.freq_locked and self.locked_freq is not None:
                    self.freq_entry_var.set(f"{self.locked_freq/1e6:.6f}")
                elif self.hover_freq is not None:
                    self.freq_entry_var.set(f"{self.hover_freq/1e6:.6f}")
                return

            # Valid frequency - set hover frequency (don't lock automatically)
            self.hover_freq = freq_hz

            # If audio preview is running, update it
            if self.audio_preview and self.audio_preview.is_enabled():
                self.audio_preview.set_target_frequency(freq_hz)
                # Redraw marker
                self.redraw_audio_marker_if_active()

        except ValueError:
            # Invalid input - show error
            messagebox.showwarning(
                "Invalid Frequency",
                "Please enter a valid frequency in MHz (e.g., 14.074)"
            )
            # Revert to current frequency
            if self.freq_locked and self.locked_freq is not None:
                self.freq_entry_var.set(f"{self.locked_freq/1e6:.6f}")
            elif self.hover_freq is not None:
                self.freq_entry_var.set(f"{self.hover_freq/1e6:.6f}")

    def on_freq_lock_changed(self):
        """Handle frequency lock checkbox change"""
        is_locked = self.freq_lock_var.get()

        if is_locked:
            # Lock to current hover frequency
            if self.hover_freq is not None:
                self.freq_locked = True
                self.locked_freq = self.hover_freq

                # Set audio preview to locked frequency
                if self.audio_preview and self.audio_preview.is_enabled():
                    self.audio_preview.set_target_frequency(self.locked_freq)

                print(f"Frequency locked at {self.locked_freq/1e6:.6f} MHz")

                # Redraw marker in locked color
                self.redraw_audio_marker_if_active()
        else:
            # Unlock frequency
            self.freq_locked = False
            self.locked_freq = None
            print("Frequency unlocked - following mouse")

            # Redraw marker
            self.redraw_audio_marker_if_active()

    def populate_audio_devices(self):
        """Populate audio device dropdown"""
        try:
            from iq_audio_output import get_audio_devices
            devices = get_audio_devices()
            
            # Determine which combo box to populate
            if hasattr(self, 'channel_device_combo'):
                combo = self.channel_device_combo
            elif hasattr(self, 'audio_device_combo'):
                combo = self.audio_device_combo
            else:
                print("No audio device combo box found")
                return
            
            if devices:
                device_names = [name for idx, name in devices]
                combo['values'] = device_names
                self.audio_devices = devices  # Store for later lookup
                
                # Try to auto-select 'default' device if available
                default_index = 0
                for i, (idx, name) in enumerate(devices):
                    if 'default' in name.lower():
                        default_index = i
                        break
                
                combo.current(default_index)
            else:
                combo['values'] = ["No audio devices found"]
                combo.current(0)
                self.audio_devices = []
        except Exception as e:
            print(f"Error enumerating audio devices: {e}")
            import traceback
            traceback.print_exc()
            if hasattr(self, 'channel_device_combo'):
                self.channel_device_combo['values'] = ["Error loading devices"]
                self.channel_device_combo.current(0)
            elif hasattr(self, 'audio_device_combo'):
                self.audio_device_combo['values'] = ["Error loading devices"]
                self.audio_device_combo.current(0)
            self.audio_devices = []
    
    def get_selected_audio_device_index(self):
        """Get the device index for the selected audio device"""
        if not hasattr(self, 'audio_devices') or not self.audio_devices:
            return None
        
        selected_name = self.audio_device_var.get()
        for idx, name in self.audio_devices:
            if name == selected_name:
                return idx
        
        return None
    
    def toggle_audio_preview(self):
        """Toggle audio preview on/off"""
        if not AUDIO_PREVIEW_AVAILABLE:
            messagebox.showerror(
                "Audio Preview Error",
                "Audio preview not available - missing dependencies.\n\n"
                "Please install required packages:\n"
                "pip install pyaudio samplerate"
            )
            return
        
        # Check if currently running
        if self.audio_preview and self.audio_preview.is_enabled():
            # Stop audio preview
            self.audio_preview.stop()
            # Keep hover_freq so user can restart at same frequency
            # self.hover_freq = None  # Don't clear this
            self.freq_locked = False
            self.locked_freq = None
            self.freq_lock_var.set(False)  # Uncheck lock checkbox
            if self.audio_marker_id:
                self.canvas.delete(self.audio_marker_id)
                self.audio_marker_id = None
            self.canvas.delete("audio_bandwidth")
            # Don't clear frequency entry - keep it so user can restart
            # self.freq_entry_var.set("")
            self.audio_button_text.set("▶ Start Audio")
            
            # Re-enable device selector when stopped
            self.audio_device_combo.config(state="readonly")
            
            print("Audio preview stopped")
        else:
            # Get selected audio device
            device_index = self.get_selected_audio_device_index()
            
            # Create new audio preview controller with selected device
            try:
                self.audio_preview = AudioPreviewController(
                    sample_rate=self.sample_rate,
                    center_freq=self.center_freq,
                    audio_sample_rate=48000
                )
                
                # Set device index if available
                if device_index is not None and self.audio_preview.audio_output:
                    self.audio_preview.audio_output.device_index = device_index
                
                # Start audio preview
                if self.audio_preview.start():
                    self.audio_preview.set_mode(self.audio_mode_var.get())
                    self.audio_preview.set_volume(self.volume_var.get())

                    # If user entered a frequency before starting, use it
                    if self.hover_freq is not None:
                        self.audio_preview.set_target_frequency(self.hover_freq)
                        # Draw the bandwidth marker immediately
                        self.redraw_audio_marker_if_active()

                    self.audio_button_text.set("⏹ Stop Audio")

                    # Disable device selector while running
                    self.audio_device_combo.config(state="disabled")

                    print(f"Audio preview started on: {self.audio_device_var.get()}")
                    if self.hover_freq is not None:
                        print(f"Tuned to {self.hover_freq/1e6:.6f} MHz - hover over spectrum to change")
                    else:
                        print("Hover over spectrum to listen")
                else:
                    messagebox.showerror(
                        "Audio Preview Error",
                        f"Failed to start audio preview on device:\n{self.audio_device_var.get()}\n\n"
                        "The device may not support the 48 kHz sample rate.\n"
                        "Try selecting a different audio device."
                    )
                    self.audio_preview = None
            except Exception as e:
                error_msg = str(e)
                print(f"Error starting audio preview: {e}")
                import traceback
                traceback.print_exc()
                
                # Show user-friendly error dialog
                if "Invalid sample rate" in error_msg or "-9997" in error_msg:
                    messagebox.showerror(
                        "Audio Sample Rate Error",
                        f"The selected audio device does not support 48 kHz sample rate.\n\n"
                        f"Device: {self.audio_device_var.get()}\n"
                        f"Error: {error_msg}\n\n"
                        "Please try selecting a different audio device."
                    )
                else:
                    messagebox.showerror(
                        "Audio Preview Error",
                        f"Failed to start audio preview:\n\n{error_msg}\n\n"
                        f"Device: {self.audio_device_var.get()}"
                    )
                self.audio_preview = None
    
    def on_mode_changed(self, event=None):
        """Handle mode change"""
        mode = self.audio_mode_var.get()

        # Update bandwidth slider range and value based on mode
        if mode in ['USB', 'LSB']:
            # SSB mode: 1000 to 6000 Hz, default 2700 Hz
            self.bandwidth_scale.config(from_=1000, to=6000)
            self.bandwidth_var.set(self.ssb_bandwidth)
        else:  # CWU, CWL
            # CW mode: 200 to 1000 Hz, default 500 Hz
            self.bandwidth_scale.config(from_=200, to=1000)
            self.bandwidth_var.set(self.cw_bandwidth)

        # Update bandwidth label
        self.bandwidth_label.config(text=f"{self.bandwidth_var.get()} Hz")

        # Update audio preview mode
        if self.audio_preview and self.audio_preview.is_enabled():
            self.audio_preview.set_mode(mode)

        # Redraw audio marker with new bandwidth
        self.redraw_audio_marker_if_active()

    def on_bandwidth_changed(self, value):
        """Handle bandwidth slider change with debouncing"""
        bandwidth = int(float(value))
        self.bandwidth_label.config(text=f"{bandwidth} Hz")

        # Store the bandwidth for the current mode
        mode = self.audio_mode_var.get()
        if mode in ['USB', 'LSB']:
            self.ssb_bandwidth = bandwidth
        else:  # CWU, CWL
            self.cw_bandwidth = bandwidth

        # Redraw audio marker with new bandwidth immediately (visual feedback)
        self.redraw_audio_marker_if_active()

        # Cancel any pending bandwidth update
        if self.bandwidth_update_timer is not None:
            self.parent.after_cancel(self.bandwidth_update_timer)

        # Schedule bandwidth update after 300ms of no slider movement (debounce)
        self.bandwidth_update_timer = self.parent.after(300, lambda: self._apply_bandwidth_update(bandwidth))

    def _apply_bandwidth_update(self, bandwidth):
        """Apply bandwidth update to audio preview (called after debounce delay)"""
        if self.audio_preview:
            self.audio_preview.set_bandwidth(bandwidth)
        self.bandwidth_update_timer = None
    
    def on_agc_changed(self):
        """Handle AGC checkbox change"""
        if self.audio_preview:
            self.audio_preview.set_agc_enabled(self.agc_enabled_var.get())
    
    def on_volume_changed(self, value):
        """Handle volume change"""
        volume = float(value)
        self.volume_label.config(text=f"{int(volume * 100)}%")
        if self.audio_preview:
            self.audio_preview.set_volume(volume)
    
    def on_channel_changed(self):
        """Handle channel selection change"""
        if self.audio_preview:
            left_enabled = self.left_channel_var.get()
            right_enabled = self.right_channel_var.get()
            self.audio_preview.set_channels(left_enabled, right_enabled)
    
    def calculate_snr_at_frequency(self, freq_hz):
        """Calculate SNR at a specific frequency within demodulation bandwidth"""
        if len(self.spectrum_data) == 0 or not self.audio_preview or not self.audio_preview.is_enabled():
            return

        # Get current mode to determine bandwidth
        mode = self.audio_mode_var.get()
        if mode in ['USB', 'LSB']:
            bandwidth_hz = self.ssb_bandwidth
        else:  # CWU, CWL
            bandwidth_hz = self.cw_bandwidth
        
        # Calculate frequency range for the passband
        full_freq_min = self.center_freq - self.sample_rate / 2
        
        if mode == 'USB':
            # USB: carrier to carrier + bandwidth
            passband_start = freq_hz
            passband_end = freq_hz + bandwidth_hz
        elif mode == 'LSB':
            # LSB: carrier - bandwidth to carrier
            passband_start = freq_hz - bandwidth_hz
            passband_end = freq_hz
        else:  # CWU, CWL
            # CW: centered on carrier
            passband_start = freq_hz - bandwidth_hz / 2
            passband_end = freq_hz + bandwidth_hz / 2
        
        # Convert frequency range to FFT bin indices
        start_bin = int(((passband_start - full_freq_min) / self.sample_rate) * len(self.spectrum_data))
        end_bin = int(((passband_end - full_freq_min) / self.sample_rate) * len(self.spectrum_data))
        
        # Clamp to valid range
        start_bin = max(0, min(len(self.spectrum_data) - 1, start_bin))
        end_bin = max(0, min(len(self.spectrum_data) - 1, end_bin))
        
        # Find peak signal within the passband
        if start_bin < end_bin:
            passband_data = self.spectrum_data[start_bin:end_bin+1]
            self.signal_db = np.max(passband_data)
        else:
            # Fallback to single bin if range is invalid
            bin_index = int(((freq_hz - full_freq_min) / self.sample_rate) * len(self.spectrum_data))
            bin_index = max(0, min(len(self.spectrum_data) - 1, bin_index))
            self.signal_db = self.spectrum_data[bin_index]
        
        # Calculate SNR if we have baseline
        if self.baseline_db is not None:
            self.snr_db = self.signal_db - self.baseline_db
    
    def on_mouse_motion(self, event):
        """Handle mouse motion over spectrum"""
        # Always update hover frequency for statistics display
        if self.zoom_factor > 1.0:
            visible_span = self.sample_rate / self.zoom_factor
            freq_min = self.center_freq + self.pan_offset - visible_span / 2
            freq_max = self.center_freq + self.pan_offset + visible_span / 2
        else:
            freq_min = self.center_freq - self.sample_rate / 2
            freq_max = self.center_freq + self.sample_rate / 2
        
        # Calculate frequency from mouse X position
        mouse_fraction = event.x / self.width if self.width > 0 else 0.5
        freq_at_mouse = freq_min + mouse_fraction * (freq_max - freq_min)
        
        # Update hover frequency
        self.hover_freq = int(freq_at_mouse)
        
        # Calculate SNR at hover frequency
        self.calculate_snr_at_frequency(self.hover_freq)
        
        # Handle audio preview if enabled
        if self.audio_mixer:
            # Multi-channel mode - update active channel only
            active_channel = self.get_active_channel()
            if active_channel and active_channel.is_active():
                # If channel is locked, don't update from mouse motion
                if not active_channel.locked:
                    # Update active channel's frequency from mouse
                    active_channel.set_frequency(self.hover_freq)
                    # Update frequency display in UI
                    if hasattr(self, 'channel_freq_var'):
                        self.channel_freq_var.set(f"{self.hover_freq/1e6:.6f}")
                    # Redraw all markers
                    self.draw_all_channel_markers()

        elif self.audio_preview and self.audio_preview.is_enabled():
            # Legacy single-channel mode
            # If frequency is locked, don't update from mouse motion
            if self.freq_locked:
                # Still update hover_freq for display, but use locked_freq for audio
                self.freq_entry_var.set(f"{self.locked_freq/1e6:.6f}")
                # Don't redraw marker - it's already at the locked position
                # self.redraw_audio_marker_if_active()
            else:
                # Update audio preview target frequency from mouse
                self.audio_preview.set_target_frequency(self.hover_freq)

                # Update frequency display
                self.freq_entry_var.set(f"{self.hover_freq/1e6:.6f}")

                # Draw audio marker on spectrum
                self.draw_audio_marker(event.x, freq_at_mouse)
    
    def redraw_audio_marker_if_active(self):
        """Redraw audio marker at current hover frequency if audio preview is active"""
        if self.audio_preview and self.audio_preview.is_enabled():
            # Use locked frequency if locked, otherwise use hover frequency
            target_freq = self.locked_freq if self.freq_locked else self.hover_freq
            
            if target_freq is not None:
                # Calculate X position for target frequency
                if self.zoom_factor > 1.0:
                    visible_span = self.sample_rate / self.zoom_factor
                    freq_min = self.center_freq + self.pan_offset - visible_span / 2
                    freq_max = self.center_freq + self.pan_offset + visible_span / 2
                else:
                    freq_min = self.center_freq - self.sample_rate / 2
                    freq_max = self.center_freq + self.sample_rate / 2
                
                # Calculate X position from frequency
                freq_range = freq_max - freq_min
                if freq_range > 0 and target_freq >= freq_min and target_freq <= freq_max:
                    # Frequency is in visible range - draw marker
                    x_pos = ((target_freq - freq_min) / freq_range) * self.width
                    self.draw_audio_marker(x_pos, target_freq)
                else:
                    # Frequency is out of visible range - clear marker
                    if self.audio_marker_id:
                        self.canvas.delete(self.audio_marker_id)
                        self.audio_marker_id = None
                    self.canvas.delete("audio_bandwidth")
        else:
            # Audio preview not active - clear marker
            if self.audio_marker_id:
                self.canvas.delete(self.audio_marker_id)
                self.audio_marker_id = None
            self.canvas.delete("audio_bandwidth")
    
    def on_canvas_resize(self, event):
        """Handle canvas resize event"""
        # Update width and height
        self.width = event.width
        self.height = event.height
        
        # Redraw everything with new dimensions
        self.draw_grid()
        self.draw_spectrum()
        self.redraw_audio_marker_if_active()
    
    def on_left_click(self, event):
        """Handle left click to lock/unlock frequency"""
        if self.audio_mixer:
            # Multi-channel mode - lock/unlock active channel
            active_channel = self.get_active_channel()
            if not active_channel or not active_channel.is_active():
                return

            if active_channel.locked:
                # Unlock channel frequency
                active_channel.set_locked(False)
                print(f"Channel {active_channel.channel_id} '{active_channel.name}' unlocked - following mouse")
            else:
                # Lock channel at current frequency
                active_channel.set_locked(True)
                print(f"Channel {active_channel.channel_id} '{active_channel.name}' locked at {active_channel.frequency/1e6:.6f} MHz")

            # Sync the lock checkbox with the channel's lock state
            if hasattr(self, 'channel_lock_var'):
                self.channel_lock_var.set(active_channel.locked)

            # Redraw markers to show lock state
            self.draw_all_channel_markers()

        elif self.audio_preview and self.audio_preview.is_enabled():
            # Legacy single-channel mode
            if self.freq_locked:
                # Unlock frequency - return to following mouse
                self.freq_locked = False
                self.locked_freq = None
                self.freq_lock_var.set(False)  # Sync checkbox
                print("Frequency unlocked - following mouse")

                # Update display immediately with current mouse position
                self.on_mouse_motion(event)
            else:
                # Lock frequency at current hover position
                if self.hover_freq is not None:
                    self.freq_locked = True
                    self.locked_freq = self.hover_freq
                    self.freq_lock_var.set(True)  # Sync checkbox

                    # Set audio preview to locked frequency
                    self.audio_preview.set_target_frequency(self.locked_freq)

                    # Update display
                    self.freq_entry_var.set(f"{self.locked_freq/1e6:.6f}")

                    print(f"Frequency locked at {self.locked_freq/1e6:.6f} MHz")

                    # Redraw marker in locked color
                    self.redraw_audio_marker_if_active()
    
    def on_mouse_leave(self, event):
        """Handle mouse leaving spectrum"""
        # Keep audio playing at last frequency when mouse leaves
        # User can disable by unchecking the audio preview checkbox
        pass
    
    def draw_audio_marker(self, x_pos, freq_hz):
        """Draw vertical marker and bandwidth indicator showing audio preview"""
        # Delete old markers
        if self.audio_marker_id:
            self.canvas.delete(self.audio_marker_id)
        self.canvas.delete("audio_bandwidth")

        # Get current mode to determine bandwidth
        mode = self.audio_mode_var.get()
        if mode in ['USB', 'LSB']:
            bandwidth_hz = self.ssb_bandwidth
        else:  # CWU, CWL
            bandwidth_hz = self.cw_bandwidth
        
        # Calculate bandwidth in pixels
        if self.zoom_factor > 1.0:
            visible_span = self.sample_rate / self.zoom_factor
            freq_min = self.center_freq + self.pan_offset - visible_span / 2
            freq_max = self.center_freq + self.pan_offset + visible_span / 2
        else:
            freq_min = self.center_freq - self.sample_rate / 2
            freq_max = self.center_freq + self.sample_rate / 2
        
        freq_range = freq_max - freq_min
        pixels_per_hz = self.width / freq_range if freq_range > 0 else 0
        
        # Calculate bandwidth rectangle
        # For USB: bandwidth extends to the right (higher frequencies)
        # For LSB: bandwidth extends to the left (lower frequencies)
        # For CW: bandwidth is centered
        
        if mode == 'USB':
            # USB: 0 to +2700 Hz from carrier
            x1 = x_pos
            x2 = x_pos + (bandwidth_hz * pixels_per_hz)
        elif mode == 'LSB':
            # LSB: -2700 to 0 Hz from carrier
            x1 = x_pos - (bandwidth_hz * pixels_per_hz)
            x2 = x_pos
        else:  # CWU, CWL
            # CW: ±250 Hz from carrier (500 Hz total)
            half_bw = (bandwidth_hz / 2) * pixels_per_hz
            x1 = x_pos - half_bw
            x2 = x_pos + half_bw
        
        # Choose color based on lock state
        marker_color = '#FF8800' if self.freq_locked else '#00FFFF'  # Orange if locked, cyan if not
        
        # Draw semi-transparent bandwidth indicator (like FT8 highlighting)
        self.canvas.create_rectangle(
            x1, 0, x2, self.height,
            fill=marker_color,
            stipple='gray50',  # Semi-transparent
            outline='',
            tags="audio_bandwidth"
        )
        
        # Draw center frequency marker
        self.audio_marker_id = self.canvas.create_line(
            x_pos, 0, x_pos, self.height,
            fill=marker_color,
            width=2,
            dash=(4, 4),
            tags="audio_marker"
        )
        
        # Draw bandwidth label at top
        label_x = (x1 + x2) / 2
        lock_indicator = " 🔒" if self.freq_locked else ""
        label_text = f"{mode} ({bandwidth_hz} Hz){lock_indicator}"
        self.canvas.create_text(
            label_x, 15,
            text=label_text,
            fill=marker_color,
            font=('Arial', 9, 'bold'),
            tags="audio_bandwidth"
        )
        
        # Draw frequency label at bottom
        freq_mhz = freq_hz / 1e6
        freq_text = f"{freq_mhz:.6f} MHz"
        self.canvas.create_text(
            x_pos, self.height - 15,
            text=freq_text,
            fill=marker_color,
            font=('Arial', 10, 'bold'),
            tags="audio_bandwidth"
        )
        
        # Raise markers above grid but below spectrum
        self.canvas.tag_lower("audio_bandwidth", "spectrum")
        self.canvas.tag_lower("audio_marker", "spectrum")

    def draw_channel_marker(self, channel: AudioChannel, is_active: bool = False):
        """
        Draw marker for a single channel

        Args:
            channel: AudioChannel to draw marker for
            is_active: True if this is the active channel
        """
        if not channel.is_active():
            return

        # Calculate frequency position
        if self.zoom_factor > 1.0:
            visible_span = self.sample_rate / self.zoom_factor
            freq_min = self.center_freq + self.pan_offset - visible_span / 2
            freq_max = self.center_freq + self.pan_offset + visible_span / 2
        else:
            freq_min = self.center_freq - self.sample_rate / 2
            freq_max = self.center_freq + self.sample_rate / 2

        # Check if channel frequency is in visible range
        if channel.frequency < freq_min or channel.frequency > freq_max:
            return

        # Calculate X position
        freq_range = freq_max - freq_min
        if freq_range <= 0:
            return

        x_pos = ((channel.frequency - freq_min) / freq_range) * self.width
        pixels_per_hz = self.width / freq_range

        # Calculate bandwidth rectangle based on mode
        bandwidth_hz = channel.bandwidth

        if channel.mode == 'USB':
            x1 = x_pos
            x2 = x_pos + (bandwidth_hz * pixels_per_hz)
        elif channel.mode == 'LSB':
            x1 = x_pos - (bandwidth_hz * pixels_per_hz)
            x2 = x_pos
        else:  # CWU, CWL
            half_bw = (bandwidth_hz / 2) * pixels_per_hz
            x1 = x_pos - half_bw
            x2 = x_pos + half_bw

        # Use channel color, brighter if active
        marker_color = channel.color
        line_width = 3 if is_active else 2
        opacity = 'gray50' if not is_active else 'gray25'  # More opaque if active

        # Canvas tags for this channel
        bw_tag = f"channel_{channel.channel_id}_bandwidth"
        marker_tag = f"channel_{channel.channel_id}_marker"
        label_tag = f"channel_{channel.channel_id}_label"

        # Draw semi-transparent bandwidth indicator
        self.canvas.create_rectangle(
            x1, 0, x2, self.height,
            fill=marker_color,
            stipple=opacity,
            outline='',
            tags=bw_tag
        )

        # Draw center frequency marker
        dash_pattern = (4, 4) if not is_active else (6, 2)  # Solid-ish if active
        self.canvas.create_line(
            x_pos, 0, x_pos, self.height,
            fill=marker_color,
            width=line_width,
            dash=dash_pattern,
            tags=marker_tag
        )

        # Draw channel name and info at top
        label_x = (x1 + x2) / 2
        lock_indicator = " 🔒" if channel.locked else ""
        active_indicator = " ●" if is_active else ""
        label_text = f"{channel.name}{active_indicator} ({channel.mode} {bandwidth_hz}Hz){lock_indicator}"

        self.canvas.create_text(
            label_x, 15 + (channel.channel_id - 1) * 15,  # Stack labels vertically
            text=label_text,
            fill=marker_color,
            font=('Arial', 9, 'bold' if is_active else 'normal'),
            tags=label_tag
        )

        # Draw frequency label at bottom
        freq_mhz = channel.frequency / 1e6
        freq_text = f"{freq_mhz:.6f}"
        self.canvas.create_text(
            x_pos, self.height - 15 - (channel.channel_id - 1) * 15,  # Stack from bottom
            text=freq_text,
            fill=marker_color,
            font=('Arial', 9, 'bold' if is_active else 'normal'),
            tags=label_tag
        )

        # Raise markers above grid but below spectrum
        self.canvas.tag_lower(bw_tag, "spectrum")
        self.canvas.tag_lower(marker_tag, "spectrum")
        self.canvas.tag_raise(label_tag, "spectrum")  # Labels on top

    def draw_all_channel_markers(self):
        """Draw markers for all active channels"""
        if not self.audio_mixer:
            return

        # Clear all channel markers
        for channel in self.audio_mixer.channels:
            self.canvas.delete(f"channel_{channel.channel_id}_bandwidth")
            self.canvas.delete(f"channel_{channel.channel_id}_marker")
            self.canvas.delete(f"channel_{channel.channel_id}_label")

        # Draw all channels (inactive first, then active on top)
        active_channel = self.get_active_channel()

        # Draw inactive channels first
        for channel in self.audio_mixer.channels:
            if channel.is_active() and channel != active_channel:
                self.draw_channel_marker(channel, is_active=False)

        # Draw active channel last (on top)
        if active_channel and active_channel.is_active():
            self.draw_channel_marker(active_channel, is_active=True)

    def redraw_all_markers(self):
        """Redraw all channel markers (called after zoom/pan/frequency changes)"""
        if self.audio_mixer:
            # Multi-channel mode
            self.draw_all_channel_markers()
        elif self.audio_preview and self.audio_preview.is_enabled():
            # Legacy single-channel mode - use redraw_audio_marker_if_active which handles locked freq correctly
            self.redraw_audio_marker_if_active()

    def add_iq_samples(self, i_samples: np.ndarray, q_samples: np.ndarray):
        """
        Add IQ samples to the buffer
        
        Args:
            i_samples: I (in-phase) samples
            q_samples: Q (quadrature) samples
        """
        # Combine I and Q into complex samples
        complex_samples = i_samples + 1j * q_samples
        
        with self.spectrum_lock:
            self.iq_buffer.extend(complex_samples)
        
        # Process for audio preview if enabled
        if self.audio_mixer:
            # Multi-channel mode - process through mixer
            try:
                self.audio_mixer.process_iq_samples(complex_samples)
            except Exception as e:
                print(f"Multi-channel audio error: {e}")
        elif self.audio_preview and self.audio_preview.is_enabled():
            # Legacy single-channel mode
            try:
                self.audio_preview.process_iq_samples(complex_samples)
            except Exception as e:
                print(f"Audio preview error: {e}")
    
    def compute_spectrum(self):
        """Compute FFT spectrum from IQ buffer"""
        with self.spectrum_lock:
            if len(self.iq_buffer) < self.fft_size:
                return
            
            # Get samples for FFT
            samples = np.array(list(self.iq_buffer)[-self.fft_size:])
        
        # Apply window
        windowed = samples * self.window
        
        # Compute FFT
        fft_result = np.fft.fft(windowed)
        fft_shifted = np.fft.fftshift(fft_result)
        
        # Convert to dB
        magnitude = np.abs(fft_shifted)
        magnitude = np.where(magnitude > 0, magnitude, 1e-10)  # Avoid log(0)
        db_spectrum = 20 * np.log10(magnitude)
        
        # Average with history
        self.spectrum_history.append(db_spectrum)
        if len(self.spectrum_history) > 0:
            self.spectrum_data = np.mean(self.spectrum_history, axis=0)
        
        # Calculate spectrum statistics
        if len(self.spectrum_data) > 0:
            current_min = np.min(self.spectrum_data)
            current_max = np.max(self.spectrum_data)
            
            # Calculate baseline (noise floor) using 25th percentile
            # This is more robust than minimum as it ignores outliers
            current_baseline = np.percentile(self.spectrum_data, 25)
            
            # Smooth the statistics
            self.smoothed_min_db = (self.smoothing_factor * current_min +
                                   (1 - self.smoothing_factor) * self.smoothed_min_db)
            self.smoothed_max_db = (self.smoothing_factor * current_max +
                                   (1 - self.smoothing_factor) * self.smoothed_max_db)
            
            # Update statistics for display
            self.min_db = self.smoothed_min_db
            self.max_db = self.smoothed_max_db
            self.baseline_db = current_baseline
            
            # Update SNR if we have a hover frequency
            if self.hover_freq is not None:
                self.calculate_snr_at_frequency(self.hover_freq)
    
    def draw_grid(self):
        """Draw frequency and amplitude grid with auto-scaling"""
        # Clear canvas
        self.canvas.delete("grid")
        
        # Get auto-scaled dB range
        min_db = np.floor(self.smoothed_min_db / 10.0) * 10.0
        max_db = np.ceil(self.smoothed_max_db / 10.0) * 10.0
        
        # For IQ data, we can have positive dB values (unlike RF spectrum)
        # Just ensure a reasonable range
        if max_db - min_db < 20.0:
            # Expand range to at least 20 dB
            center = (max_db + min_db) / 2.0
            min_db = center - 10.0
            max_db = center + 10.0
        
        self.db_min = min_db
        self.db_max = max_db
        db_range = max_db - min_db
        
        # Determine step size based on range
        if db_range <= 20:
            db_step = 5
        elif db_range <= 40:
            db_step = 10
        else:
            db_step = 20
        
        # Draw horizontal lines (amplitude)
        start_db = int(min_db / db_step) * db_step
        
        for db in range(start_db, int(max_db) + 1, db_step):
            if db < min_db or db > max_db:
                continue
            
            y = self.height - ((db - min_db) / db_range) * self.height
            self.canvas.create_line(0, y, self.width, y, fill='#333333', tags="grid")
            
            # Label
            label = f"{db} dB"
            self.canvas.create_text(5, y - 2, text=label, fill='#666666',
                                  anchor=tk.SW, tags="grid", font=('Arial', 8))
        
        # Draw vertical lines (frequency) - adjust for zoom
        if self.zoom_factor > 1.0:
            # Zoomed view
            visible_span = self.sample_rate / self.zoom_factor
            freq_min = self.center_freq + self.pan_offset - visible_span / 2
            freq_max = self.center_freq + self.pan_offset + visible_span / 2
        else:
            # Normal view
            freq_min = self.center_freq - self.sample_rate / 2
            freq_max = self.center_freq + self.sample_rate / 2
        
        freq_range = freq_max - freq_min
        freq_step = freq_range / 10
        
        for i in range(11):
            x = (i / 10) * self.width
            self.canvas.create_line(x, 0, x, self.height, fill='#333333', tags="grid")
            
            # Calculate frequency
            freq = freq_min + (i / 10) * freq_range
            freq_mhz = freq / 1e6
            
            # Label
            label = f"{freq_mhz:.3f}"
            self.canvas.create_text(x, self.height - 5, text=label, fill='#666666',
                                  anchor=tk.S, tags="grid", font=('Arial', 8))
        
        # Center frequency marker - only draw if center freq is visible
        if self.center_freq >= freq_min and self.center_freq <= freq_max:
            # Calculate X position of center frequency in zoomed view
            center_x = ((self.center_freq - freq_min) / freq_range) * self.width
            self.canvas.create_line(center_x, 0, center_x, self.height,
                                  fill='#FF0000', width=2, tags="grid")
            
            # Label at center marker position
            self.canvas.create_text(center_x, 10,
                                  text=f"{self.center_freq/1e6:.3f} MHz",
                                  fill='#FF0000', font=('Arial', 10, 'bold'), tags="grid")
        
        # Show zoom level in top left if zoomed
        if self.zoom_factor > 1.0:
            zoom_text = f"Zoom: {self.zoom_factor:.1f}x"
            self.canvas.create_text(10, 10,
                                  text=zoom_text,
                                  fill='#FFFFFF', font=('Arial', 10, 'bold'),
                                  anchor=tk.W, tags="grid")
        
        # Show spectrum statistics in top right
        self.draw_spectrum_stats()
        
        # Draw FT8 frequency highlights
        self.draw_ft8_highlights()
    
    def draw_ft8_highlights(self):
        """Draw FT8 frequency highlights (like CW Skimmer Monitor)"""
        # Calculate visible frequency range (accounting for zoom)
        if self.zoom_factor > 1.0:
            visible_span = self.sample_rate / self.zoom_factor
            freq_min = self.center_freq + self.pan_offset - visible_span / 2
            freq_max = self.center_freq + self.pan_offset + visible_span / 2
        else:
            freq_min = self.center_freq - self.sample_rate / 2
            freq_max = self.center_freq + self.sample_rate / 2
        
        # Full spectrum range (for checking if FT8 is within receiver range)
        full_freq_min = self.center_freq - self.sample_rate / 2
        full_freq_max = self.center_freq + self.sample_rate / 2
        
        # Check each FT8 band
        for band in FT8_BANDS:
            ft8_freq = band['ft8']
            ft8_width = 3000  # FT8 bandwidth is ~3 kHz
            ft8_start = ft8_freq
            ft8_end = ft8_freq + ft8_width
            
            # Check if FT8 frequency is within the receiver's actual spectrum range
            if ft8_freq >= full_freq_min and ft8_freq <= full_freq_max:
                # Check if FT8 frequency is visible in current zoomed display
                if ft8_end >= freq_min and ft8_start <= freq_max:
                    # Calculate pixel positions for FT8 range
                    freq_range = freq_max - freq_min

                    x1 = ((ft8_start - freq_min) / freq_range) * self.width
                    x2 = ((ft8_end - freq_min) / freq_range) * self.width
                    
                    # Clamp to canvas
                    if x1 < 0:
                        x1 = 0
                    if x2 > self.width:
                        x2 = self.width
                    
                    # Draw semi-transparent yellow highlight
                    self.canvas.create_rectangle(x1, 0, x2, self.height,
                                                fill='#FFFF00', stipple='gray50',
                                                outline='', tags="grid")
                    
                    # Draw FT8 label
                    label_x = (x1 + x2) / 2
                    self.canvas.create_text(label_x, 15,
                                          text=f"FT8 {band['name']}",
                                          fill='#FFFF00', font=('Arial', 9, 'bold'),
                                          tags="grid")
                    break  # Only one band matches
    
    def draw_spectrum_stats(self):
        """Draw spectrum statistics in top right corner"""
        stats_lines = []
        
        # Pointer frequency (always show if we have hover position)
        if self.hover_freq is not None:
            stats_lines.append(f"Freq: {self.hover_freq/1e6:.6f} MHz")
        
        # Spectrum statistics
        stats_lines.append(f"Baseline: {self.baseline_db:.1f} dB")
        stats_lines.append(f"Min: {self.min_db:.1f} dB")
        stats_lines.append(f"Max: {self.max_db:.1f} dB")
        
        # Signal level and SNR at pointer (only when audio preview is active)
        if self.audio_preview and self.audio_preview.is_enabled() and self.signal_db is not None:
            stats_lines.append(f"Signal: {self.signal_db:.1f} dB")
            if self.snr_db is not None:
                # Color code SNR: green if good (>10dB), yellow if moderate (0-10dB), red if poor (<0dB)
                if self.snr_db > 10:
                    snr_color = '#00FF00'  # Green
                elif self.snr_db > 0:
                    snr_color = '#FFFF00'  # Yellow
                else:
                    snr_color = '#FF0000'  # Red
                
                # Draw SNR with color coding
                y_offset = 10
                for i, line in enumerate(stats_lines[:-1]):  # Draw all but SNR
                    self.canvas.create_text(
                        self.width - 10, y_offset + i * 15,
                        text=line,
                        fill='#AAAAAA',
                        font=('Arial', 9),
                        anchor=tk.NE,
                        tags="grid"
                    )
                
                # Draw SNR with color
                self.canvas.create_text(
                    self.width - 10, y_offset + len(stats_lines[:-1]) * 15,
                    text=f"SNR: {self.snr_db:.1f} dB",
                    fill=snr_color,
                    font=('Arial', 9, 'bold'),
                    anchor=tk.NE,
                    tags="grid"
                )
                return  # Already drew everything
        
        # Draw all stats in gray (no SNR or SNR not available)
        y_offset = 10
        for i, line in enumerate(stats_lines):
            self.canvas.create_text(
                self.width - 10, y_offset + i * 15,
                text=line,
                fill='#AAAAAA',
                font=('Arial', 9),
                anchor=tk.NE,
                tags="grid"
            )
    
    def draw_spectrum(self):
        """Draw the spectrum on canvas"""
        # Delete old spectrum
        self.canvas.delete("spectrum")
        
        if len(self.spectrum_data) == 0:
            return
        
        # Calculate visible frequency range (with zoom)
        if self.zoom_factor > 1.0:
            visible_span = self.sample_rate / self.zoom_factor
            freq_min = self.center_freq + self.pan_offset - visible_span / 2
            freq_max = self.center_freq + self.pan_offset + visible_span / 2
        else:
            freq_min = self.center_freq - self.sample_rate / 2
            freq_max = self.center_freq + self.sample_rate / 2
        
        # Full spectrum range
        full_freq_min = self.center_freq - self.sample_rate / 2
        full_freq_max = self.center_freq + self.sample_rate / 2
        
        # Create points for line
        points = []
        db_range = self.db_max - self.db_min
        
        if db_range <= 0:
            return
        
        # Map FFT bins to screen coordinates based on zoom
        for i, db_value in enumerate(self.spectrum_data):
            # Calculate frequency for this FFT bin
            bin_freq = full_freq_min + (i / len(self.spectrum_data)) * self.sample_rate
            
            # Check if this bin is in the visible range
            if bin_freq < freq_min or bin_freq > freq_max:
                continue
            
            # Map frequency to screen X coordinate
            x = ((bin_freq - freq_min) / (freq_max - freq_min)) * self.width
            
            # Clamp to display range
            db_clamped = np.clip(db_value, self.db_min, self.db_max)
            y = self.height - ((db_clamped - self.db_min) / db_range) * self.height
            
            points.append(x)
            points.append(y)
        
        # Draw as a line (like CW Skimmer Monitor)
        if len(points) >= 4:
            self.canvas.create_line(points, fill='#00FF00', width=1, tags="spectrum", smooth=False)
    
    def update_display(self):
        """Update display loop"""
        if not self.running:
            return
        
        # Compute and draw spectrum
        self.compute_spectrum()
        self.draw_grid()  # Redraw grid with auto-scaled range
        self.draw_spectrum()
        
        # Schedule next update (30 FPS)
        self.parent.after(33, self.update_display)
    
    def stop(self):
        """Stop the display"""
        self.running = False
        
        # Stop multi-channel audio
        if self.audio_mixer:
            try:
                self.audio_mixer.stop_all_channels()
            except:
                pass
        
        # Stop legacy single-channel audio preview
        if self.audio_preview:
            try:
                self.audio_preview.stop()
            except:
                pass
    
    # ========================================================================
    # Multi-Channel Management Methods
    # ========================================================================
    
    def add_channel(self, name: Optional[str] = None) -> Optional[AudioChannel]:
        """
        Add a new audio channel
        
        Args:
            name: Custom channel name (auto-generated if None)
            
        Returns:
            AudioChannel instance or None if failed
        """
        if not self.audio_mixer:
            print("Multi-channel audio not available")
            return None
        
        channel = self.audio_mixer.add_channel(name=name)
        if channel:
            # Set as active channel if it's the first one
            if self.active_channel_id is None:
                self.active_channel_id = channel.channel_id
            print(f"Added channel {channel.channel_id}: '{channel.name}'")
        
        return channel
    
    def remove_channel(self, channel_id: int) -> bool:
        """
        Remove a channel
        
        Args:
            channel_id: ID of channel to remove
            
        Returns:
            True if channel was removed
        """
        if not self.audio_mixer:
            return False
        
        # If removing active channel, switch to another
        if channel_id == self.active_channel_id:
            # Find another channel to make active
            for ch in self.audio_mixer.channels:
                if ch.channel_id != channel_id:
                    self.active_channel_id = ch.channel_id
                    break
            else:
                self.active_channel_id = None
        
        return self.audio_mixer.remove_channel(channel_id)
    
    def get_channel(self, channel_id: int) -> Optional[AudioChannel]:
        """
        Get channel by ID
        
        Args:
            channel_id: Channel ID
            
        Returns:
            AudioChannel or None if not found
        """
        if not self.audio_mixer:
            return None
        return self.audio_mixer.get_channel(channel_id)
    
    def get_active_channel(self) -> Optional[AudioChannel]:
        """
        Get the currently active channel
        
        Returns:
            Active AudioChannel or None
        """
        if not self.audio_mixer or self.active_channel_id is None:
            return None
        return self.audio_mixer.get_channel(self.active_channel_id)
    
    def set_active_channel(self, channel_id: int):
        """
        Set the active channel (responds to mouse hover)
        
        Args:
            channel_id: ID of channel to make active
        """
        if self.audio_mixer and self.audio_mixer.get_channel(channel_id):
            self.active_channel_id = channel_id
            print(f"Active channel set to {channel_id}")
    
    def get_all_channels(self) -> List[AudioChannel]:
        """
        Get list of all channels
        
        Returns:
            List of AudioChannel instances
        """
        if not self.audio_mixer:
            return []
        return self.audio_mixer.channels
    
    def get_channel_count(self) -> int:
        """Get total number of channels"""
        if not self.audio_mixer:
            return 0
        return self.audio_mixer.get_channel_count()
    
    # ========================================================================
    # End Multi-Channel Management Methods
    # ========================================================================

    # ========================================================================
    # Keyboard Shortcuts for Multi-Channel
    # ========================================================================

    def switch_to_channel(self, channel_number: int):
        """
        Switch to channel by number (1-6)

        Args:
            channel_number: Channel number (1-6)
        """
        if not self.audio_mixer:
            return

        # Find channel by number (channels are 1-indexed for user)
        if 0 < channel_number <= len(self.audio_mixer.channels):
            channel = self.audio_mixer.channels[channel_number - 1]
            self.set_active_channel(channel.channel_id)
            self.draw_all_channel_markers()
            print(f"Switched to channel {channel_number}: '{channel.name}'")

    def cycle_active_channel(self):
        """Cycle to next channel (Tab key)"""
        if not self.audio_mixer or not self.audio_mixer.channels:
            return

        # Find current active channel index
        current_index = -1
        for i, channel in enumerate(self.audio_mixer.channels):
            if channel.channel_id == self.active_channel_id:
                current_index = i
                break

        # Cycle to next channel
        next_index = (current_index + 1) % len(self.audio_mixer.channels)
        next_channel = self.audio_mixer.channels[next_index]

        self.set_active_channel(next_channel.channel_id)
        self.draw_all_channel_markers()
        print(f"Cycled to channel {next_index + 1}: '{next_channel.name}'")

    # ========================================================================
    # End Keyboard Shortcuts
    # ========================================================================

    def set_db_range(self, db_min: float, db_max: float):
        """Set the dB display range (for manual override)"""
        self.smoothed_min_db = db_min
        self.smoothed_max_db = db_max
        self.draw_grid()
    
    def on_mouse_wheel(self, event):
        """Handle mouse wheel for zooming at mouse position"""
        # Calculate frequency at mouse position before zoom
        if self.zoom_factor > 1.0:
            visible_span = self.sample_rate / self.zoom_factor
            freq_min = self.center_freq + self.pan_offset - visible_span / 2
            freq_max = self.center_freq + self.pan_offset + visible_span / 2
        else:
            freq_min = self.center_freq - self.sample_rate / 2
            freq_max = self.center_freq + self.sample_rate / 2
        
        # Mouse position as fraction of width
        mouse_fraction = event.x / self.width if self.width > 0 else 0.5
        freq_at_mouse = freq_min + mouse_fraction * (freq_max - freq_min)
        
        # Determine scroll direction and adjust zoom
        if event.num == 4 or event.delta > 0:
            # Scroll up - zoom in
            new_zoom = min(self.zoom_factor * 1.5, 10.0)
        elif event.num == 5 or event.delta < 0:
            # Scroll down - zoom out
            new_zoom = max(self.zoom_factor / 1.5, 1.0)
        else:
            return
        
        # If zooming out to 1.0, reset everything
        if new_zoom == 1.0:
            self.zoom_factor = 1.0
            self.pan_offset = 0
            self.draw_grid()
            self.redraw_all_markers()
            return
        
        # Update zoom factor
        self.zoom_factor = new_zoom
        
        # Adjust pan offset to keep frequency at mouse position
        if self.zoom_factor > 1.0:
            # Calculate new visible span
            new_visible_span = self.sample_rate / self.zoom_factor
            
            # We want freq_at_mouse to remain at mouse_fraction position
            # freq_at_mouse = (center_freq + pan_offset - new_visible_span/2) + mouse_fraction * new_visible_span
            # Solve for pan_offset:
            self.pan_offset = freq_at_mouse - self.center_freq - (mouse_fraction - 0.5) * new_visible_span
            
            # Clamp pan offset to keep view within spectrum bounds
            max_offset = (self.sample_rate - new_visible_span) / 2
            self.pan_offset = max(-max_offset, min(max_offset, self.pan_offset))
        
        self.draw_grid()
        self.redraw_all_markers()
    
    def on_middle_click(self, event):
        """Reset zoom on middle click"""
        self.reset_zoom()
    
    def zoom_in(self):
        """Zoom in (increase zoom factor)"""
        self.zoom_factor = min(self.zoom_factor * 1.5, 10.0)  # Max 10x zoom
        self.draw_grid()
        self.redraw_all_markers()
    
    def zoom_out(self):
        """Zoom out (decrease zoom factor)"""
        self.zoom_factor = max(self.zoom_factor / 1.5, 1.0)  # Min 1x (no zoom)
        if self.zoom_factor == 1.0:
            self.pan_offset = 0  # Reset pan when fully zoomed out
        self.draw_grid()
        self.redraw_all_markers()
    
    def reset_zoom(self):
        """Reset zoom to 1:1"""
        self.zoom_factor = 1.0
        self.pan_offset = 0
        self.draw_grid()
        self.redraw_all_markers()

    # ========================================================================
    # Phase 6: Multi-Channel Tabbed UI Methods
    # ========================================================================

    def _create_channel_control_widgets(self):
        """Create the control widgets for the active channel panel"""
        panel = self.channel_control_panel

        # Row 1: Name, Active checkbox, Device selector, Output routing, Start/Stop
        row1 = ttk.Frame(panel)
        row1.pack(side=tk.TOP, fill=tk.X, pady=2)

        # Channel name
        ttk.Label(row1, text="Name:").pack(side=tk.LEFT, padx=(5, 2))
        self.channel_name_var = tk.StringVar()
        self.channel_name_var.trace_add('write', lambda *args: self.on_channel_name_changed())
        self.channel_name_entry = ttk.Entry(row1, textvariable=self.channel_name_var, width=15)
        self.channel_name_entry.pack(side=tk.LEFT, padx=2)
        self.channel_name_entry.bind('<Return>', self.on_channel_name_changed)
        self.channel_name_entry.bind('<FocusOut>', self.on_channel_name_changed)

        # Audio device
        ttk.Label(row1, text="Device:").pack(side=tk.LEFT, padx=(10, 2))
        self.channel_device_var = tk.StringVar()
        self.channel_device_combo = ttk.Combobox(
            row1, textvariable=self.channel_device_var,
            state="readonly", width=25
        )
        self.channel_device_combo.pack(side=tk.LEFT, padx=2)
        self.channel_device_combo.bind('<<ComboboxSelected>>', self.on_channel_device_changed)
        self.populate_audio_devices()

        # L/R output
        output_frame = ttk.Frame(row1)
        output_frame.pack(side=tk.LEFT, padx=10)
        self.channel_left_var = tk.BooleanVar(value=True)
        self.channel_right_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(output_frame, text="L", variable=self.channel_left_var,
                        command=self.on_channel_output_changed).pack(side=tk.LEFT)
        ttk.Checkbutton(output_frame, text="R", variable=self.channel_right_var,
                        command=self.on_channel_output_changed).pack(side=tk.LEFT)

        # Start/Stop button
        self.channel_audio_button_text = tk.StringVar(value="▶ Start")
        self.channel_audio_button = ttk.Button(
            row1, textvariable=self.channel_audio_button_text,
            command=self.on_channel_start_stop, width=10
        )
        self.channel_audio_button.pack(side=tk.LEFT, padx=5)

        # Row 2: Mode, Bandwidth, Volume, Frequency, Lock, AGC
        row2 = ttk.Frame(panel)
        row2.pack(side=tk.TOP, fill=tk.X, pady=2)

        # Mode
        ttk.Label(row2, text="Mode:").pack(side=tk.LEFT, padx=(5, 2))
        default_mode = "LSB" if self.center_freq < 10_000_000 else "USB"
        self.channel_mode_var = tk.StringVar(value=default_mode)
        self.channel_mode_combo = ttk.Combobox(
            row2, textvariable=self.channel_mode_var,
            values=["USB", "LSB", "CWU", "CWL"],
            state="readonly", width=6
        )
        self.channel_mode_combo.pack(side=tk.LEFT, padx=2)
        self.channel_mode_combo.bind('<<ComboboxSelected>>', self.on_channel_mode_changed)

        # Bandwidth
        ttk.Label(row2, text="BW:").pack(side=tk.LEFT, padx=(10, 2))
        self.channel_bandwidth_var = tk.IntVar(value=2700)
        self.channel_bandwidth_scale = ttk.Scale(
            row2, from_=1000, to=6000, orient=tk.HORIZONTAL,
            variable=self.channel_bandwidth_var,
            command=self.on_channel_bandwidth_changed, length=120
        )
        self.channel_bandwidth_scale.pack(side=tk.LEFT, padx=2)
        self.channel_bandwidth_label = ttk.Label(row2, text="2700 Hz")
        self.channel_bandwidth_label.pack(side=tk.LEFT, padx=2)

        # Volume
        ttk.Label(row2, text="Vol:").pack(side=tk.LEFT, padx=(10, 2))
        self.channel_volume_var = tk.DoubleVar(value=0.5)
        self.channel_volume_scale = ttk.Scale(
            row2, from_=0.0, to=1.0, orient=tk.HORIZONTAL,
            variable=self.channel_volume_var,
            command=self.on_channel_volume_changed, length=100
        )
        self.channel_volume_scale.pack(side=tk.LEFT, padx=2)
        self.channel_volume_label = ttk.Label(row2, text="50%")
        self.channel_volume_label.pack(side=tk.LEFT, padx=2)

        # Frequency
        ttk.Label(row2, text="Freq (MHz):").pack(side=tk.LEFT, padx=(10, 2))
        self.channel_freq_var = tk.StringVar(value=f"{self.center_freq/1e6:.6f}")
        self.channel_freq_entry = ttk.Entry(
            row2, textvariable=self.channel_freq_var,
            width=12, justify=tk.RIGHT
        )
        self.channel_freq_entry.pack(side=tk.LEFT, padx=2)
        self.channel_freq_entry.bind('<Return>', self.on_channel_freq_changed)
        self.channel_freq_entry.bind('<FocusOut>', self.on_channel_freq_changed)

        # Lock
        self.channel_lock_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(row2, text="🔒", variable=self.channel_lock_var,
                        command=self.on_channel_lock_changed, width=3).pack(side=tk.LEFT, padx=2)

        # AGC
        self.channel_agc_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(row2, text="AGC", variable=self.channel_agc_var,
                        command=self.on_channel_agc_changed).pack(side=tk.LEFT, padx=5)

    def _create_legacy_audio_controls(self):
        """Create legacy single-channel audio controls (fallback)"""
        # This preserves the original single-channel UI for backward compatibility
        control_frame = ttk.Frame(self.control_container)
        control_frame.pack(side=tk.TOP, fill=tk.X)

        # Audio device selector
        ttk.Label(control_frame, text="Audio Device:").pack(side=tk.LEFT, padx=(5, 2))
        self.audio_device_var = tk.StringVar()
        self.audio_device_combo = ttk.Combobox(
            control_frame,
            textvariable=self.audio_device_var,
            state="readonly",
            width=33
        )
        self.audio_device_combo.pack(side=tk.LEFT, padx=2)
        self.populate_audio_devices()

        # Channel selection frame
        channel_frame = tk.Frame(control_frame, pady=0)
        channel_frame.pack(side=tk.LEFT, padx=(10, 2))

        self.left_channel_var = tk.BooleanVar(value=True)
        self.right_channel_var = tk.BooleanVar(value=True)

        tk.Checkbutton(
            channel_frame,
            text="Left",
            variable=self.left_channel_var,
            command=self.on_channel_changed,
            pady=0
        ).pack(anchor=tk.W, pady=0)

        tk.Checkbutton(
            channel_frame,
            text="Right",
            variable=self.right_channel_var,
            command=self.on_channel_changed,
            pady=0
        ).pack(anchor=tk.W, pady=0)

        # Start/Stop button
        self.audio_button_text = tk.StringVar(value="▶ Start Audio")
        self.audio_button = ttk.Button(
            control_frame,
            textvariable=self.audio_button_text,
            command=self.toggle_audio_preview,
            width=14
        )
        self.audio_button.pack(side=tk.LEFT, padx=5)

        # Mode selector
        default_mode = "LSB" if self.center_freq < 10_000_000 else "USB"
        self.audio_mode_var = tk.StringVar(value=default_mode)

        mode_combo = ttk.Combobox(
            control_frame,
            textvariable=self.audio_mode_var,
            values=["USB", "LSB", "CWU", "CWL"],
            state="readonly",
            width=6
        )
        mode_combo.pack(side=tk.LEFT, padx=2)
        mode_combo.bind('<<ComboboxSelected>>', self.on_mode_changed)

        # Bandwidth slider
        ttk.Label(control_frame, text="BW:").pack(side=tk.LEFT, padx=(10, 2))
        self.bandwidth_var = tk.IntVar(value=2700)
        self.bandwidth_scale = ttk.Scale(
            control_frame,
            from_=200,
            to=6000,
            orient=tk.HORIZONTAL,
            variable=self.bandwidth_var,
            command=self.on_bandwidth_changed,
            length=120
        )
        self.bandwidth_scale.pack(side=tk.LEFT, padx=2)

        self.bandwidth_label = ttk.Label(control_frame, text="2700 Hz")
        self.bandwidth_label.pack(side=tk.LEFT, padx=2)

        # AGC checkbox
        self.agc_enabled_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            control_frame,
            text="AGC",
            variable=self.agc_enabled_var,
            command=self.on_agc_changed
        ).pack(side=tk.LEFT, padx=5)

        # Volume control
        ttk.Label(control_frame, text="Volume:").pack(side=tk.LEFT, padx=(10, 2))
        self.volume_var = tk.DoubleVar(value=0.5)
        volume_scale = ttk.Scale(
            control_frame,
            from_=0.0,
            to=1.0,
            orient=tk.HORIZONTAL,
            variable=self.volume_var,
            command=self.on_volume_changed,
            length=100
        )
        volume_scale.pack(side=tk.LEFT, padx=2)

        self.volume_label = ttk.Label(control_frame, text="50%")
        self.volume_label.pack(side=tk.LEFT, padx=2)

        # Frequency input/display
        freq_frame = ttk.Frame(control_frame)
        freq_frame.pack(side=tk.RIGHT, padx=5)

        ttk.Label(freq_frame, text="Freq (MHz):").pack(side=tk.LEFT, padx=(0, 2))

        self.freq_entry_var = tk.StringVar(value=f"{self.center_freq/1e6:.6f}")
        self.freq_entry = ttk.Entry(
            freq_frame,
            textvariable=self.freq_entry_var,
            width=12,
            justify=tk.RIGHT
        )
        self.freq_entry.pack(side=tk.LEFT, padx=2)
        self.freq_entry.bind('<Return>', self.on_freq_entry_submit)
        self.freq_entry.bind('<FocusOut>', self.on_freq_entry_submit)

        # Lock checkbox
        self.freq_lock_var = tk.BooleanVar(value=False)
        self.freq_lock_check = ttk.Checkbutton(
            freq_frame,
            variable=self.freq_lock_var,
            command=self.on_freq_lock_changed
        )
        self.freq_lock_check.pack(side=tk.LEFT, padx=(2, 0))

    def _refresh_channel_tabs(self):
        """Refresh the channel tab buttons"""
        for widget in self.tab_buttons_frame.winfo_children():
            widget.destroy()
        self.channel_tab_buttons.clear()

        if not self.audio_mixer:
            return

        for channel in self.audio_mixer.channels:
            self._create_channel_tab(channel)

        # Update add button state
        if self.audio_mixer.get_channel_count() >= MAX_CHANNELS:
            self.add_channel_button.config(state='disabled')
        else:
            self.add_channel_button.config(state='normal')

    def _create_channel_tab(self, channel):
        """Create a tab button for a channel"""
        tab_frame = ttk.Frame(self.tab_buttons_frame)
        tab_frame.pack(side=tk.LEFT, padx=1)

        is_active = (channel.channel_id == self.active_channel_id)
        btn_text = f"● {channel.name}"

        tab_button = tk.Button(
            tab_frame, text=btn_text,
            bg=channel.color,           # Color as background
            fg='black',                 # Black text for contrast
            activebackground=channel.color,
            activeforeground='black',
            relief=tk.SUNKEN if is_active else tk.RAISED,
            bd=2 if is_active else 1, padx=8, pady=4,
            command=lambda cid=channel.channel_id: self.on_tab_clicked(cid)
        )
        tab_button.pack(side=tk.LEFT)

        close_button = tk.Button(
            tab_frame, text="×", fg="red", relief=tk.FLAT,
            padx=4, pady=4,
            command=lambda cid=channel.channel_id: self.on_tab_close_clicked(cid)
        )
        close_button.pack(side=tk.LEFT)

        self.channel_tab_buttons[channel.channel_id] = {
            'frame': tab_frame, 'button': tab_button, 'close': close_button
        }

    def _update_channel_controls(self):
        """Update the channel control panel to show active channel settings"""
        active_channel = self.get_active_channel()

        if not active_channel:
            self._disable_channel_controls()
            return

        self._enable_channel_controls()

        # Update all control values
        self.channel_name_var.set(active_channel.name)
        self.channel_left_var.set(active_channel.left_enabled)
        self.channel_right_var.set(active_channel.right_enabled)
        self.channel_mode_var.set(active_channel.mode)

        # Adjust bandwidth slider range based on mode
        if active_channel.mode in ['CWU', 'CWL']:
            self.channel_bandwidth_scale.config(from_=200, to=1000)
        else:
            self.channel_bandwidth_scale.config(from_=1000, to=6000)

        self.channel_bandwidth_var.set(active_channel.bandwidth)
        self.channel_bandwidth_label.config(text=f"{active_channel.bandwidth} Hz")
        self.channel_volume_var.set(active_channel.volume)
        self.channel_volume_label.config(text=f"{int(active_channel.volume * 100)}%")
        self.channel_freq_var.set(f"{active_channel.frequency/1e6:.6f}")
        self.channel_lock_var.set(active_channel.locked)
        self.channel_agc_var.set(active_channel.agc_enabled)

        # Update button text
        if active_channel.is_active():
            self.channel_audio_button_text.set("⏹ Stop")
        else:
            self.channel_audio_button_text.set("▶ Start")

    def _enable_channel_controls(self):
        """Enable all channel control widgets"""
        if hasattr(self, 'channel_name_entry'):
            self.channel_name_entry.config(state='normal')
            self.channel_device_combo.config(state='readonly')
            self.channel_audio_button.config(state='normal')
            self.channel_mode_combo.config(state='readonly')
            self.channel_bandwidth_scale.config(state='normal')
            self.channel_volume_scale.config(state='normal')
            self.channel_freq_entry.config(state='normal')

    def _disable_channel_controls(self):
        """Disable all channel control widgets"""
        if hasattr(self, 'channel_name_entry'):
            self.channel_name_entry.config(state='disabled')
            self.channel_device_combo.config(state='disabled')
            self.channel_audio_button.config(state='disabled')
            self.channel_mode_combo.config(state='disabled')
            self.channel_bandwidth_scale.config(state='disabled')
            self.channel_volume_scale.config(state='disabled')
            self.channel_freq_entry.config(state='disabled')

    def on_tab_clicked(self, channel_id: int):
        """Handle tab button click"""
        self.set_active_channel(channel_id)
        self._refresh_channel_tabs()
        self._update_channel_controls()
        self.redraw_all_markers()

    def on_tab_close_clicked(self, channel_id: int):
        """Handle tab close button click"""
        channel = self.get_channel(channel_id)
        if not channel:
            return

        # Remove channel without confirmation
        self.remove_channel(channel_id)
        self._refresh_channel_tabs()
        self._update_channel_controls()
        self.redraw_all_markers()
        self.save_channel_configuration()

    def on_add_channel_clicked(self):
        """Handle add channel button click"""
        if not self.audio_mixer:
            return

        if self.audio_mixer.get_channel_count() >= MAX_CHANNELS:
            messagebox.showwarning("Maximum Channels", f"Maximum of {MAX_CHANNELS} channels reached.")
            return

        new_channel = self.add_channel()
        if new_channel:
            self.set_active_channel(new_channel.channel_id)
            self._refresh_channel_tabs()
            self._update_channel_controls()

    def on_start_all_clicked(self):
        """Handle start all button click - starts all channels"""
        if not self.audio_mixer:
            return

        started_count = 0
        failed_channels = []

        for channel in self.audio_mixer.channels:
            if not channel.is_active():
                if channel.start():
                    started_count += 1
                    print(f"Started channel '{channel.name}'")
                else:
                    failed_channels.append(channel.name)
                    print(f"Failed to start channel '{channel.name}'")

        # Update UI for active channel
        self._update_channel_controls()
        self.redraw_all_markers()

        # Show result message
        if started_count > 0:
            if failed_channels:
                messagebox.showwarning(
                    "Start All Channels",
                    f"Started {started_count} channel(s).\n\nFailed to start: {', '.join(failed_channels)}"
                )
            else:
                print(f"✅ Started all {started_count} channel(s)")
        elif failed_channels:
            messagebox.showerror(
                "Start All Channels",
                f"Failed to start channels: {', '.join(failed_channels)}"
            )

    def on_stop_all_clicked(self):
        """Handle stop all button click - stops all channels"""
        if not self.audio_mixer:
            return

        stopped_count = 0

        for channel in self.audio_mixer.channels:
            if channel.is_active():
                channel.stop()
                stopped_count += 1
                print(f"Stopped channel '{channel.name}'")

        # Update UI for active channel
        self._update_channel_controls()
        self.redraw_all_markers()

        if stopped_count > 0:
            print(f"⏹ Stopped all {stopped_count} channel(s)")
            self.save_channel_configuration()

    def on_channel_name_changed(self, event=None):
        """Handle channel name change"""
        active_channel = self.get_active_channel()
        if active_channel:
            new_name = self.channel_name_var.get().strip()
            if new_name:
                active_channel.set_name(new_name)
                self._refresh_channel_tabs()
                self.save_channel_configuration()

    def on_channel_device_changed(self, event=None):
        """Handle audio device change"""
        active_channel = self.get_active_channel()
        if active_channel:
            device_index = self.get_selected_audio_device_index()
            active_channel.device_index = device_index
            if active_channel.is_active():
                active_channel.stop()
                active_channel.start()
            self.save_channel_configuration()

    def on_channel_output_changed(self):
        """Handle L/R output routing change"""
        active_channel = self.get_active_channel()
        if active_channel:
            left = self.channel_left_var.get()
            right = self.channel_right_var.get()
            active_channel.set_output_routing(left, right)
            self.save_channel_configuration()

    def on_channel_start_stop(self):
        """Handle start/stop button click"""
        active_channel = self.get_active_channel()
        if not active_channel:
            return

        if active_channel.is_active():
            active_channel.stop()
            self.channel_audio_button_text.set("▶ Start")
        else:
            if active_channel.start():
                self.channel_audio_button_text.set("⏹ Stop")
            else:
                messagebox.showerror("Audio Error", f"Failed to start audio for channel '{active_channel.name}'")

        self.redraw_all_markers()
        self.save_channel_configuration()

    def on_channel_mode_changed(self, event=None):
        """Handle mode change"""
        active_channel = self.get_active_channel()
        if active_channel:
            mode = self.channel_mode_var.get()
            active_channel.set_mode(mode)

            # Adjust bandwidth range for CW modes
            if mode in ['CWU', 'CWL']:
                self.channel_bandwidth_scale.config(from_=200, to=1000)
                if active_channel.bandwidth > 1000:
                    active_channel.set_bandwidth(500)
                    self.channel_bandwidth_var.set(500)
                    self.channel_bandwidth_label.config(text="500 Hz")
            else:
                self.channel_bandwidth_scale.config(from_=1000, to=6000)
                if active_channel.bandwidth < 1000:
                    active_channel.set_bandwidth(2700)
                    self.channel_bandwidth_var.set(2700)
                    self.channel_bandwidth_label.config(text="2700 Hz")
            
            # Update the bandwidth label to show current value
            self.channel_bandwidth_label.config(text=f"{active_channel.bandwidth} Hz")

            self.redraw_all_markers()
            self.save_channel_configuration()

    def on_channel_bandwidth_changed(self, value):
        """Handle bandwidth slider change with debouncing"""
        active_channel = self.get_active_channel()
        if active_channel:
            bandwidth = int(float(value))
            # Only update the label immediately for visual feedback
            self.channel_bandwidth_label.config(text=f"{bandwidth} Hz")
            
            # Cancel any pending update timers
            if hasattr(self, '_bandwidth_update_timer') and self._bandwidth_update_timer is not None:
                self.parent.after_cancel(self._bandwidth_update_timer)
            
            # Schedule bandwidth update, redraw and save after 300ms of no slider movement (debounce)
            self._bandwidth_update_timer = self.parent.after(300, lambda bw=bandwidth: self._apply_channel_bandwidth_update(bw))
    
    def _apply_channel_bandwidth_update(self, bandwidth):
        """Apply bandwidth update (called after debounce delay)"""
        active_channel = self.get_active_channel()
        if active_channel:
            # Now actually update the bandwidth (which affects audio)
            active_channel.set_bandwidth(bandwidth)
            self.redraw_all_markers()
            self.save_channel_configuration()
        self._bandwidth_update_timer = None

    def on_channel_volume_changed(self, value):
        """Handle volume slider change"""
        active_channel = self.get_active_channel()
        if active_channel:
            volume = float(value)
            active_channel.set_volume(volume)
            self.channel_volume_label.config(text=f"{int(volume * 100)}%")
            if hasattr(self, '_volume_save_timer'):
                self.parent.after_cancel(self._volume_save_timer)
            self._volume_save_timer = self.parent.after(1000, self.save_channel_configuration)

    def on_channel_freq_changed(self, event=None):
        """Handle frequency entry change"""
        active_channel = self.get_active_channel()
        if not active_channel:
            return

        try:
            freq_mhz = float(self.channel_freq_var.get())
            freq_hz = int(freq_mhz * 1e6)

            freq_min = self.center_freq - self.sample_rate / 2
            freq_max = self.center_freq + self.sample_rate / 2

            if freq_hz < freq_min or freq_hz > freq_max:
                messagebox.showwarning(
                    "Frequency Out of Range",
                    f"Frequency must be between {freq_min/1e6:.6f} and {freq_max/1e6:.6f} MHz"
                )
                self.channel_freq_var.set(f"{active_channel.frequency/1e6:.6f}")
                return

            active_channel.set_frequency(freq_hz)
            self.redraw_all_markers()
            self.save_channel_configuration()

        except ValueError:
            messagebox.showwarning("Invalid Frequency", "Please enter a valid frequency in MHz")
            self.channel_freq_var.set(f"{active_channel.frequency/1e6:.6f}")

    def on_channel_lock_changed(self):
        """Handle lock checkbox change"""
        active_channel = self.get_active_channel()
        if active_channel:
            locked = self.channel_lock_var.get()
            active_channel.set_locked(locked)
            self.redraw_all_markers()
            self.save_channel_configuration()

    def on_channel_agc_changed(self):
        """Handle AGC checkbox change"""
        active_channel = self.get_active_channel()
        if active_channel:
            agc_enabled = self.channel_agc_var.get()
            active_channel.set_agc_enabled(agc_enabled)
            self.save_channel_configuration()

    def get_channel_config_path(self):
        """Get path to channel configuration file (DEPRECATED - now uses ConfigManager)"""
        return Path.home() / '.iq_recorder_channels.json'

    def save_channel_configuration(self):
        """Save channel configuration to ConfigManager"""
        if not self.audio_mixer:
            return

        # Use ConfigManager if available and stream_id is set
        if self.config_manager and self.stream_id is not None:
            try:
                channels_data = [ch.to_dict() for ch in self.audio_mixer.channels]
                config = {
                    'version': '1.0',
                    'channels': channels_data,
                    'active_channel_id': self.active_channel_id,
                    'master_volume': self.audio_mixer.master_volume,
                    'auto_gain': self.audio_mixer.auto_gain
                }

                # Debug: show what we're saving
                for ch_data in channels_data:
                    print(f"💾 Saving channel: {ch_data.get('name')} at {ch_data.get('frequency')/1e6:.6f} MHz, mode={ch_data.get('mode')}")

                self.config_manager.set_stream_channels(self.stream_id, config)
                print(f"Saved {len(self.audio_mixer.channels)} channels for stream {self.stream_id} to config")

            except Exception as e:
                print(f"Error saving channel configuration: {e}")
        else:
            # Fallback to old file-based method if ConfigManager not available
            try:
                config = {
                    'version': '1.0',
                    'channels': [ch.to_dict() for ch in self.audio_mixer.channels],
                    'active_channel_id': self.active_channel_id,
                    'master_volume': self.audio_mixer.master_volume,
                    'auto_gain': self.audio_mixer.auto_gain
                }

                config_path = self.get_channel_config_path()
                with open(config_path, 'w') as f:
                    json.dump(config, f, indent=2)

                print(f"Saved channel configuration to {config_path} (legacy mode)")

            except Exception as e:
                print(f"Error saving channel configuration: {e}")

    def load_channel_configuration(self):
        """Load channel configuration from ConfigManager"""
        if not self.audio_mixer:
            return

        # Use ConfigManager if available and stream_id is set
        if self.config_manager and self.stream_id is not None:
            try:
                print(f"🔍 Loading channels for stream {self.stream_id} from ConfigManager")
                config = self.config_manager.get_stream_channels(self.stream_id)

                if not config:
                    print(f"⚠️  No saved channel configuration found for stream {self.stream_id}")
                    return

                if config.get('version') != '1.0':
                    print(f"Unsupported configuration version: {config.get('version')}")
                    return

                # Clear existing channels
                self.audio_mixer.clear_all_channels()

                # Restore channels
                for ch_data in config.get('channels', []):
                    print(f"   📝 Loading channel data: freq={ch_data.get('frequency', 'N/A')/1e6:.6f} MHz, mode={ch_data.get('mode', 'N/A')}")
                    channel = AudioChannel.from_dict(
                        ch_data, self.sample_rate, self.center_freq, 48000
                    )
                    print(f"   ✅ Loaded channel: {channel.name} at {channel.frequency/1e6:.6f} MHz, mode={channel.mode}")
                    self.audio_mixer.channels.append(channel)

                    if channel.channel_id >= self.audio_mixer.next_channel_id:
                        self.audio_mixer.next_channel_id = channel.channel_id + 1

                # Restore active channel
                self.active_channel_id = config.get('active_channel_id')

                # Restore mixer settings
                self.audio_mixer.master_volume = config.get('master_volume', 1.0)
                self.audio_mixer.auto_gain = config.get('auto_gain', True)

                print(f"Loaded {len(self.audio_mixer.channels)} channels for stream {self.stream_id} from config")

                # Refresh UI
                if hasattr(self, '_refresh_channel_tabs'):
                    self._refresh_channel_tabs()
                    self._update_channel_controls()

            except Exception as e:
                print(f"Error loading channel configuration: {e}")
        else:
            # Fallback to old file-based method if ConfigManager not available
            config_path = self.get_channel_config_path()

            if not config_path.exists():
                print("No saved channel configuration found (legacy mode)")
                return

            try:
                with open(config_path, 'r') as f:
                    config = json.load(f)

                if config.get('version') != '1.0':
                    print(f"Unsupported configuration version: {config.get('version')}")
                    return

                # Clear existing channels
                self.audio_mixer.clear_all_channels()

                # Restore channels
                for ch_data in config.get('channels', []):
                    channel = AudioChannel.from_dict(
                        ch_data, self.sample_rate, self.center_freq, 48000
                    )
                    self.audio_mixer.channels.append(channel)

                    if channel.channel_id >= self.audio_mixer.next_channel_id:
                        self.audio_mixer.next_channel_id = channel.channel_id + 1

                # Restore active channel
                self.active_channel_id = config.get('active_channel_id')

                # Restore mixer settings
                self.audio_mixer.master_volume = config.get('master_volume', 1.0)
                self.audio_mixer.auto_gain = config.get('auto_gain', True)

                print(f"Loaded {len(self.audio_mixer.channels)} channels from {config_path} (legacy mode)")

                # Refresh UI
                if hasattr(self, '_refresh_channel_tabs'):
                    self._refresh_channel_tabs()
                    self._update_channel_controls()

            except Exception as e:
                print(f"Error loading channel configuration: {e}")

    def get_selected_audio_device_index(self):
        """Get the device index for the selected audio device"""
        if not hasattr(self, 'audio_devices') or not self.audio_devices:
            return None

        # Try channel-specific device combo first
        if hasattr(self, 'channel_device_combo'):
            selected_name = self.channel_device_var.get()
        elif hasattr(self, 'audio_device_combo'):
            selected_name = self.audio_device_var.get()
        else:
            return None

        for idx, name in self.audio_devices:
            if name == selected_name:
                return idx

        return None
