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
from collections import deque
from typing import Optional

# Import audio preview components
try:
    from iq_audio_preview import AudioPreviewController
    AUDIO_PREVIEW_AVAILABLE = True
except ImportError as e:
    AUDIO_PREVIEW_AVAILABLE = False
    print(f"Warning: Audio preview not available: {e}")

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
    
    def __init__(self, parent: tk.Widget, width: int = 800, height: int = 400,
                 sample_rate: int = 96000, center_freq: int = 14175000):
        """
        Initialize spectrum display
        
        Args:
            parent: Parent tkinter widget
            width: Canvas width in pixels
            height: Canvas height in pixels
            sample_rate: IQ sample rate in Hz
            center_freq: Center frequency in Hz
        """
        self.parent = parent
        self.width = width
        self.height = height
        self.sample_rate = sample_rate
        self.center_freq = center_freq
        
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
        
        # Audio preview
        self.audio_preview = None
        self.hover_freq = None  # Frequency at mouse position
        self.audio_marker_id = None  # Canvas ID for audio marker
        self.freq_locked = False  # Whether frequency is locked (fixed)
        self.locked_freq = None  # Locked frequency when fixed
        
        # Spectrum statistics
        self.baseline_db = -100.0  # Noise floor (25th percentile)
        self.min_db = -100.0
        self.max_db = -40.0
        self.signal_db = None  # Signal level at pointer (for SNR calculation)
        self.snr_db = None  # Signal-to-noise ratio
        
        # Create audio controls first (before canvas)
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
        self.canvas.focus_set()  # Allow keyboard input
        
        # Bind resize event
        self.canvas.bind("<Configure>", self.on_canvas_resize)
        
        # Initialize audio preview controller
        if AUDIO_PREVIEW_AVAILABLE:
            try:
                self.audio_preview = AudioPreviewController(
                    sample_rate=sample_rate,
                    center_freq=center_freq,
                    audio_sample_rate=48000
                )
            except Exception as e:
                print(f"Warning: Could not initialize audio preview: {e}")
                self.audio_preview = None
        
        # Draw initial grid
        self.draw_grid()
        
        # Start update loop
        self.update_display()
    
    def create_audio_controls(self):
        """Create audio preview control panel"""
        control_frame = ttk.Frame(self.parent)
        control_frame.pack(side=tk.BOTTOM, fill=tk.X, padx=5, pady=5)
        
        # Audio device selector
        ttk.Label(control_frame, text="Audio Device:").pack(side=tk.LEFT, padx=(5, 2))
        self.audio_device_var = tk.StringVar()
        self.audio_device_combo = ttk.Combobox(
            control_frame,
            textvariable=self.audio_device_var,
            state="readonly",
            width=25
        )
        self.audio_device_combo.pack(side=tk.LEFT, padx=2)
        
        # Populate audio devices
        self.populate_audio_devices()
        
        # Channel selection frame (vertically stacked checkboxes with minimal spacing)
        channel_frame = tk.Frame(control_frame, pady=0)
        channel_frame.pack(side=tk.LEFT, padx=(10, 2))
        
        self.left_channel_var = tk.BooleanVar(value=True)
        self.right_channel_var = tk.BooleanVar(value=True)
        
        left_check = tk.Checkbutton(
            channel_frame,
            text="Left",
            variable=self.left_channel_var,
            command=self.on_channel_changed,
            pady=0,
            highlightthickness=0,
            bd=0
        )
        left_check.pack(anchor=tk.W, pady=0)
        
        right_check = tk.Checkbutton(
            channel_frame,
            text="Right",
            variable=self.right_channel_var,
            command=self.on_channel_changed,
            pady=0,
            highlightthickness=0,
            bd=0
        )
        right_check.pack(anchor=tk.W, pady=0)
        
        # Start/Stop button
        self.audio_button_text = tk.StringVar(value="▶ Start Audio")
        self.audio_button = ttk.Button(
            control_frame,
            textvariable=self.audio_button_text,
            command=self.toggle_audio_preview,
            width=20
        )
        self.audio_button.pack(side=tk.LEFT, padx=5)
        
        # Mode selector - auto-select based on frequency
        ttk.Label(control_frame, text="Mode:").pack(side=tk.LEFT, padx=(10, 2))
        
        # Auto-select LSB for < 10 MHz, USB for >= 10 MHz
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
        
        # AGC checkbox
        self.agc_enabled_var = tk.BooleanVar(value=True)
        agc_check = ttk.Checkbutton(
            control_frame,
            text="AGC",
            variable=self.agc_enabled_var,
            command=self.on_agc_changed
        )
        agc_check.pack(side=tk.LEFT, padx=5)
        
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
        
        # Volume label
        self.volume_label = ttk.Label(control_frame, text="50%")
        self.volume_label.pack(side=tk.LEFT, padx=2)
        
        # Frequency display
        self.freq_label = ttk.Label(control_frame, text="Hover over spectrum to tune", foreground='#888888')
        self.freq_label.pack(side=tk.RIGHT, padx=5)
    
    def populate_audio_devices(self):
        """Populate audio device dropdown"""
        try:
            from iq_audio_output import get_audio_devices
            devices = get_audio_devices()
            
            if devices:
                device_names = [name for idx, name in devices]
                self.audio_device_combo['values'] = device_names
                self.audio_devices = devices  # Store for later lookup
                
                # Try to auto-select 'default' device if available
                default_index = 0
                for i, (idx, name) in enumerate(devices):
                    if 'default' in name.lower():
                        default_index = i
                        break
                
                self.audio_device_combo.current(default_index)
            else:
                self.audio_device_combo['values'] = ["No audio devices found"]
                self.audio_device_combo.current(0)
                self.audio_devices = []
        except Exception as e:
            print(f"Error enumerating audio devices: {e}")
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
            self.hover_freq = None
            self.freq_locked = False
            self.locked_freq = None
            if self.audio_marker_id:
                self.canvas.delete(self.audio_marker_id)
                self.audio_marker_id = None
            self.canvas.delete("audio_bandwidth")
            self.freq_label.config(text="Hover over spectrum to tune", foreground='#888888')
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
                    self.audio_button_text.set("⏹ Stop Audio")
                    self.freq_label.config(text="Hover over spectrum to tune", foreground='#000000')
                    
                    # Disable device selector while running
                    self.audio_device_combo.config(state="disabled")
                    
                    print(f"Audio preview started on: {self.audio_device_var.get()}")
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
        if self.audio_preview and self.audio_preview.is_enabled():
            self.audio_preview.set_mode(self.audio_mode_var.get())
    
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
            bandwidth_hz = 2700  # SSB bandwidth
        else:  # CWU, CWL
            bandwidth_hz = 500   # CW bandwidth
        
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
        if self.audio_preview and self.audio_preview.is_enabled():
            # If frequency is locked, don't update from mouse motion
            if self.freq_locked:
                # Still update hover_freq for display, but use locked_freq for audio
                mode = self.audio_mode_var.get()
                self.freq_label.config(text=f"🔒 {self.locked_freq/1e6:.6f} MHz ({mode}) [LOCKED]", foreground='#FF8800')
                # Redraw marker at locked position
                self.redraw_audio_marker_if_active()
            else:
                # Update audio preview target frequency from mouse
                self.audio_preview.set_target_frequency(self.hover_freq)
                
                # Update frequency display with mode
                mode = self.audio_mode_var.get()
                self.freq_label.config(text=f"{self.hover_freq/1e6:.6f} MHz ({mode})", foreground='#000000')
                
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
        # Only handle clicks when audio preview is enabled
        if not self.audio_preview or not self.audio_preview.is_enabled():
            return
        
        if self.freq_locked:
            # Unlock frequency - return to following mouse
            self.freq_locked = False
            self.locked_freq = None
            print("Frequency unlocked - following mouse")
            
            # Update display immediately with current mouse position
            self.on_mouse_motion(event)
        else:
            # Lock frequency at current hover position
            if self.hover_freq is not None:
                self.freq_locked = True
                self.locked_freq = self.hover_freq
                
                # Set audio preview to locked frequency
                self.audio_preview.set_target_frequency(self.locked_freq)
                
                # Update display
                mode = self.audio_mode_var.get()
                self.freq_label.config(text=f"🔒 {self.locked_freq/1e6:.6f} MHz ({mode}) [LOCKED]", foreground='#FF8800')
                
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
            bandwidth_hz = 2700  # SSB bandwidth
        else:  # CWU, CWL
            bandwidth_hz = 500   # CW bandwidth
        
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
        if self.audio_preview and self.audio_preview.is_enabled():
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
        
        # Stop audio preview
        if self.audio_preview:
            try:
                self.audio_preview.stop()
            except:
                pass
    
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
        self.redraw_audio_marker_if_active()
    
    def on_middle_click(self, event):
        """Reset zoom on middle click"""
        self.reset_zoom()
    
    def zoom_in(self):
        """Zoom in (increase zoom factor)"""
        self.zoom_factor = min(self.zoom_factor * 1.5, 10.0)  # Max 10x zoom
        self.draw_grid()
        self.redraw_audio_marker_if_active()
    
    def zoom_out(self):
        """Zoom out (decrease zoom factor)"""
        self.zoom_factor = max(self.zoom_factor / 1.5, 1.0)  # Min 1x (no zoom)
        if self.zoom_factor == 1.0:
            self.pan_offset = 0  # Reset pan when fully zoomed out
        self.draw_grid()
        self.redraw_audio_marker_if_active()
    
    def reset_zoom(self):
        """Reset zoom to 1:1"""
        self.zoom_factor = 1.0
        self.pan_offset = 0
        self.draw_grid()
        self.redraw_audio_marker_if_active()
