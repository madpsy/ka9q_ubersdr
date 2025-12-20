#!/usr/bin/env python3
"""
Audio Spectrum Display Widget for ka9q_ubersdr Python GUI
Displays audio spectrum/waterfall from the demodulated audio output (mono, before stereo split).
Performs FFT on the audio bandwidth to show what you're hearing.
"""

import tkinter as tk
from tkinter import Canvas, Toplevel
import numpy as np
from typing import Optional, Callable
from collections import deque
from PIL import Image, ImageTk
import queue
import threading


class AudioSpectrumDisplay:
    """Audio spectrum display showing FFT of demodulated audio output.
    
    This display performs FFT on the mono audio signal (before stereo conversion)
    to show the spectrum of what you're actually hearing.
    """
    
    def __init__(self, parent: tk.Widget, width: int = 800, height: int = 400, toggle_filter_callback: Optional[Callable] = None, mute_var=None, nr2_var=None, toggle_mute_callback: Optional[Callable] = None, toggle_nr2_callback: Optional[Callable] = None):
        """Initialize audio spectrum display widget.

        Args:
            parent: Parent tkinter widget (can be Toplevel window)
            width: Canvas width in pixels
            height: Canvas height in pixels
            toggle_filter_callback: Optional callback to toggle audio filter in main GUI
            mute_var: BooleanVar for mute checkbox state
            nr2_var: BooleanVar for NR2 checkbox state
            toggle_mute_callback: Optional callback to toggle mute in main GUI
            toggle_nr2_callback: Optional callback to toggle NR2 in main GUI
        """
        self.parent = parent
        self.width = width
        self.height = height
        self.toggle_filter_callback = toggle_filter_callback
        self.mute_var = mute_var
        self.nr2_var = nr2_var
        self.toggle_mute_callback = toggle_mute_callback
        self.toggle_nr2_callback = toggle_nr2_callback
        
        # Create canvas for display
        self.canvas = Canvas(parent, width=width, height=height, bg='#000000', highlightthickness=1)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        
        # Audio parameters
        self.sample_rate = 12000  # Will be updated from client
        self.base_fft_size = 2048
        self.fft_size = 2048  # Will be dynamically adjusted based on bandwidth
        self.audio_queue = queue.Queue(maxsize=100)
        
        # Spectrum data
        self.spectrum_data: Optional[np.ndarray] = None
        self.bandwidth_low: int = 50
        self.bandwidth_high: int = 2700
        
        # Audio filter parameters (for displaying filter bandwidth)
        self.audio_filter_enabled: bool = False
        self.audio_filter_low: int = 300
        self.audio_filter_high: int = 2700
        
        # Frequency range for display (dynamically adjusted based on bandwidth)
        self.display_freq_min = 0
        self.display_freq_max = 3000
        
        # Drawing parameters
        self.margin_top = 60
        self.margin_bottom = 30
        self.margin_left = 50
        self.margin_right = 20
        self.spectrum_height = 150
        self.waterfall_height = height - self.margin_top - self.margin_bottom - self.spectrum_height - 10
        self.graph_width = width - self.margin_left - self.margin_right
        
        # Waterfall history
        self.max_history = self.waterfall_height
        self.history = deque(maxlen=self.max_history)
        self.history_timestamps = deque(maxlen=self.max_history)
        self.auto_level_window_seconds = 2.0
        
        # Peak tracking with averaging
        self.peak_history = deque(maxlen=10)  # Store last 10 peaks (500ms at 50ms update rate)
        self.peak_timestamps = deque(maxlen=10)
        self.peak_average_window = 0.5  # 500ms averaging window
        
        # Color mapping for dB values
        self.min_db = -80
        self.max_db = -20
        
        # Waterfall image
        self.waterfall_array = np.zeros((self.waterfall_height, self.graph_width, 3), dtype=np.uint8)
        self.waterfall_image = None
        self.waterfall_photo = None
        
        # Mouse interaction
        self.canvas.bind('<Motion>', self.on_motion)
        self.canvas.bind('<Button-1>', self.on_click)  # Left click to toggle filter
        # Window resize handling
        self.canvas.bind('<Configure>', self.on_resize)
        self.tooltip_id = None
        self.tooltip_bg_id = None  # Track background rectangle
        self.cursor_line_id = None
        self.last_mouse_x = -1
        self.last_mouse_y = -1
        
        # Processing thread
        self.running = True
        self.process_thread = threading.Thread(target=self._process_audio_loop, daemon=True)
        self.process_thread.start()
        
        # Start update loop
        self.update_display()
    
    def set_sample_rate(self, sample_rate: int):
        """Update sample rate."""
        self.sample_rate = sample_rate
    
    def update_bandwidth(self, low: int, high: int, mode: str = ''):
        """Update filter bandwidth and adjust display range and FFT size.
        
        Args:
            low: Low frequency offset in Hz
            high: High frequency offset in Hz
            mode: Current mode (e.g., 'usb', 'iq96', etc.) - unused in audio spectrum
        """
        self.bandwidth_low = low
        self.bandwidth_high = high

        # Calculate display range based on bandwidth
        # CW modes have a 500 Hz pitch offset in the audio from radiod
        abs_low = abs(low)
        abs_high = abs(high)

        # Check if this is CW mode (narrow symmetric bandwidth)
        is_cw_mode = (low < 0 and high > 0 and abs_low < 500 and abs_high < 500)

        # Calculate bandwidth span for FFT size adjustment
        if is_cw_mode or (low < 0 and high > 0):
            bandwidth_span = abs_low + abs_high
        else:
            bandwidth_span = max(abs_low, abs_high)

        # Dynamically adjust FFT size based on bandwidth for better frequency resolution
        # For narrow bandwidths (< 1000 Hz), use larger FFT for better resolution
        # FFT bin resolution = sample_rate / fft_size
        # Balance between resolution and update rate
        if bandwidth_span < 1000:
            # Narrow mode (CW): aim for ~3 Hz per bin
            # At 12 kHz sample rate: 12000 / 4096 = 2.93 Hz per bin
            # 4096 samples = 341ms at 12kHz, fast enough for responsive display
            self.fft_size = 4096
        elif bandwidth_span < 2000:
            # Medium narrow: aim for ~6 Hz per bin
            # At 12 kHz: 12000 / 2048 = 5.86 Hz per bin
            self.fft_size = 2048
        else:
            # Wide mode: standard resolution
            self.fft_size = self.base_fft_size

        if is_cw_mode:
            # CW mode: audio is centered at 500 Hz (pitch offset)
            # Display range should show 500 Hz ± bandwidth
            cw_offset = 500
            self.display_freq_min = max(0, cw_offset - bandwidth_span // 2 - 100)
            self.display_freq_max = cw_offset + bandwidth_span // 2 + 100
        elif (low < 0 and high > 0):
            # Symmetric bandwidth (e.g., AM: -5000 to +5000, FM: -8000 to +8000)
            max_freq = bandwidth_span / 2
            margin = max_freq * 0.3
            self.display_freq_min = 0
            self.display_freq_max = max_freq + margin
        else:
            # Asymmetric bandwidth (e.g., USB: 50 to 2700, LSB: -2700 to -50)
            max_freq = max(abs_low, abs_high)
            margin = max_freq * 0.3
            self.display_freq_min = 0
            self.display_freq_max = max_freq + margin

        # Ensure minimum display range
        if self.display_freq_max < 500:
            self.display_freq_max = 500

    def update_audio_filter(self, enabled: bool, low: int, high: int):
        """Update audio filter parameters for display.

        Args:
            enabled: Whether audio filter is enabled
            low: Low cutoff frequency in Hz
            high: High cutoff frequency in Hz
        """
        self.audio_filter_enabled = enabled
        self.audio_filter_low = low
        self.audio_filter_high = high
    
    def add_audio_data(self, audio_float: np.ndarray):
        """Add audio data for FFT processing.
        
        Args:
            audio_float: Mono audio data as float32 numpy array (normalized -1.0 to 1.0)
        """
        try:
            self.audio_queue.put_nowait(audio_float.copy())
        except queue.Full:
            # Drop oldest data if queue is full
            try:
                self.audio_queue.get_nowait()
                self.audio_queue.put_nowait(audio_float.copy())
            except:
                pass
    
    def _process_audio_loop(self):
        """Process audio data in background thread."""
        audio_buffer = np.array([], dtype=np.float32)
        
        while self.running:
            try:
                # Get audio data from queue
                audio_data = self.audio_queue.get(timeout=0.1)
                
                # Append to buffer
                audio_buffer = np.concatenate([audio_buffer, audio_data])
                
                # Process when we have enough data
                while len(audio_buffer) >= self.fft_size:
                    # Take FFT-sized chunk
                    chunk = audio_buffer[:self.fft_size]
                    # Use 50% overlap for smooth updates
                    audio_buffer = audio_buffer[self.fft_size // 2:]
                    
                    # Apply window function
                    window = np.hanning(self.fft_size)
                    windowed = chunk * window
                    
                    # Perform FFT
                    fft_result = np.fft.rfft(windowed)
                    
                    # Convert to magnitude in dB with proper scaling
                    magnitude = np.abs(fft_result)
                    # Normalize by FFT size for proper amplitude scaling
                    magnitude = magnitude / self.fft_size
                    # Avoid log of zero
                    magnitude = np.maximum(magnitude, 1e-10)
                    # Convert to dB relative to full scale (0 dBFS)
                    db = 20 * np.log10(magnitude)
                    
                    # Store spectrum data
                    self.spectrum_data = db
                    
                    # Add to history with timestamp
                    import time
                    current_time = time.time()
                    self.history.append(db.copy())
                    self.history_timestamps.append(current_time)
                    
            except queue.Empty:
                continue
            except Exception as e:
                print(f"Audio processing error: {e}")
    
    def disconnect(self):
        """Stop processing."""
        self.running = False
    
    def update_display(self):
        """Update display (called periodically)."""
        if self.spectrum_data is not None:
            self._draw_display()
        
        # Check for updates frequently
        self.parent.after(50, self.update_display)
    
    def _db_to_rgb(self, db: float) -> tuple:
        """Convert dB value to RGB color tuple."""
        db_range = self.max_db - self.min_db
        if db_range == 0:
            normalized = 0.5
        else:
            normalized = (db - self.min_db) / db_range
            normalized = max(0, min(1, normalized))
        
        # Color gradient: blue (low) -> cyan -> green -> yellow -> red (high)
        if normalized < 0.25:
            t = normalized / 0.25
            r = 0
            g = int(t * 255)
            b = 255
        elif normalized < 0.5:
            t = (normalized - 0.25) / 0.25
            r = 0
            g = 255
            b = int((1 - t) * 255)
        elif normalized < 0.75:
            t = (normalized - 0.5) / 0.25
            r = int(t * 255)
            g = 255
            b = 0
        else:
            t = (normalized - 0.75) / 0.25
            r = 255
            g = int((1 - t) * 255)
            b = 0
        
        return (r, g, b)
    
    def _draw_display(self):
        """Draw spectrum and waterfall on canvas."""
        if self.spectrum_data is None or len(self.spectrum_data) == 0:
            return
        
        # Find peak frequency and level within filter bandwidth
        peak_freq, peak_db = self._find_peak_in_bandwidth()
        
        # Auto-range dB scale using recent data ONLY within filter bandwidth
        import time
        current_time = time.time()
        cutoff_time = current_time - self.auto_level_window_seconds
        
        recent_data = []
        for i, timestamp in enumerate(self.history_timestamps):
            if timestamp >= cutoff_time:
                recent_data.append(self.history[i])
        
        if len(recent_data) > 0:
            # Only analyze FFT bins within the filter bandwidth
            nyquist = self.sample_rate / 2
            abs_low = abs(self.bandwidth_low)
            abs_high = abs(self.bandwidth_high)

            # Check if this is CW mode
            is_cw_mode = (self.bandwidth_low < 0 and self.bandwidth_high > 0 and
                          abs_low < 500 and abs_high < 500)

            if is_cw_mode:
                # CW mode: analyze around 500 Hz ± bandwidth
                cw_offset = 500
                search_low = cw_offset - abs_low
                search_high = cw_offset + abs_high
                low_bin = int((search_low / nyquist) * len(recent_data[0]))
                high_bin = int((search_high / nyquist) * len(recent_data[0]))
            elif (self.bandwidth_low < 0 and self.bandwidth_high > 0):
                # Other symmetric modes: bandwidth spans from 0 to (abs(low) + abs(high))
                bandwidth_span = abs_low + abs_high
                low_bin = 0
                high_bin = int((bandwidth_span / nyquist) * len(recent_data[0]))
            else:
                # Asymmetric mode: use absolute values
                # For LSB/CWL (both negative), swap the values since -2700 to -50 means audio 50 to 2700
                if self.bandwidth_low < 0 and self.bandwidth_high < 0:
                    # LSB mode: swap abs values
                    low_bin = int((abs_high / nyquist) * len(recent_data[0]))
                    high_bin = int((abs_low / nyquist) * len(recent_data[0]))
                else:
                    # USB mode: use normal order
                    low_bin = int((abs_low / nyquist) * len(recent_data[0]))
                    high_bin = int((abs_high / nyquist) * len(recent_data[0]))

            # Ensure valid range
            low_bin = max(0, min(low_bin, len(recent_data[0]) - 1))
            high_bin = max(low_bin + 1, min(high_bin, len(recent_data[0])))
            
            # Extract only the data within filter bandwidth
            filtered_data = []
            for spectrum in recent_data:
                filtered_data.append(spectrum[low_bin:high_bin])
            
            all_data = np.concatenate(filtered_data)
            valid_data = all_data[np.isfinite(all_data)]
            
            if len(valid_data) > 0:
                # Use more aggressive percentiles to separate noise from signals
                # 5th percentile captures noise floor better than 1st
                p5 = np.percentile(valid_data, 5)   # Noise floor
                p95 = np.percentile(valid_data, 95)  # Signal peaks (ignore extreme outliers)
                
                # Set min_db well below noise floor to show it properly
                self.min_db = p5 - 10  # 10 dB below noise floor
                self.max_db = p95 + 10  # 10 dB above typical peaks
                
                # Ensure reasonable range (at least 40 dB, max 80 dB)
                db_range = self.max_db - self.min_db
                if db_range < 40:
                    # Expand range symmetrically
                    center = (self.max_db + self.min_db) / 2
                    self.min_db = center - 20
                    self.max_db = center + 20
                elif db_range > 80:
                    # Limit range to avoid too much compression
                    self.min_db = self.max_db - 80
        
        # Clear canvas
        self.canvas.delete('all')
        self.tooltip_id = None
        self.tooltip_bg_id = None
        self.cursor_line_id = None
        
        # Draw Mute and NR2 checkbox labels on canvas (left side)
        if self.mute_var is not None:
            mute_text = "☑ Mute" if self.mute_var.get() else "☐ Mute"
            self.canvas.create_text(
                35, 15,
                text=mute_text,
                fill='white', font=('sans-serif', 10),
                anchor=tk.W,
                tags='mute_checkbox'
            )

        if self.nr2_var is not None:
            nr2_text = "☑ NR2" if self.nr2_var.get() else "☐ NR2"
            self.canvas.create_text(
                35, 35,
                text=nr2_text,
                fill='white', font=('sans-serif', 10),
                anchor=tk.W,
                tags='nr2_checkbox'
            )

        # Draw title (centered)
        self.canvas.create_text(
            self.width // 2, 15,
            text="Audio Spectrum",
            fill='white', font=('sans-serif', 12, 'bold')
        )

        # Draw info text (bandwidth)
        bw_text = f"Audio BW: {self.bandwidth_low} to {self.bandwidth_high} Hz"
        self.canvas.create_text(
            self.width // 2, 35,
            text=bw_text,
            fill='yellow', font=('monospace', 9)
        )
        
        # Draw peak info (top right, yellow text)
        if peak_freq is not None and peak_db is not None:
            peak_text = f"Peak: {peak_freq:.0f} Hz"
            self.canvas.create_text(
                self.width - self.margin_right - 5, 15,
                text=peak_text,
                fill='yellow', font=('monospace', 10, 'bold'),
                anchor=tk.E
            )
            level_text = f"{peak_db:.1f} dB"
            self.canvas.create_text(
                self.width - self.margin_right - 5, 35,
                text=level_text,
                fill='yellow', font=('monospace', 10, 'bold'),
                anchor=tk.E
            )
        
        # Draw spectrum line chart
        self._draw_spectrum()
        
        # Draw waterfall
        self._draw_waterfall()
        
        # Draw frequency scale
        self._draw_frequency_scale()
        
        # Redraw cursor if visible
        if self.last_mouse_x >= 0:
            self._update_tooltip_at_position(self.last_mouse_x, self.last_mouse_y)
    
    def _draw_spectrum(self):
        """Draw spectrum line chart."""
        spectrum_top = self.margin_top
        spectrum_bottom = spectrum_top + self.spectrum_height
        
        # Draw background
        self.canvas.create_rectangle(
            self.margin_left, spectrum_top,
            self.margin_left + self.graph_width, spectrum_bottom,
            fill='#1a1a1a', outline='white'
        )
        
        # Draw dB scale
        db_range = self.max_db - self.min_db
        for i in range(5):
            db = self.min_db + (i / 4) * db_range
            y = spectrum_bottom - (i / 4) * self.spectrum_height
            
            self.canvas.create_line(
                self.margin_left - 5, y,
                self.margin_left, y,
                fill='white'
            )
            
            label = f"{db:.0f}"
            self.canvas.create_text(
                self.margin_left - 10, y,
                text=label, fill='white', anchor=tk.E,
                font=('monospace', 8)
            )
        
        # Draw spectrum line (only within display frequency range)
        if len(self.spectrum_data) > 0:
            points = []
            nyquist = self.sample_rate / 2
            freq_range = self.display_freq_max - self.display_freq_min
            
            for i, db in enumerate(self.spectrum_data):
                if not np.isfinite(db):
                    continue
                
                # Calculate actual frequency for this bin
                bin_freq = (i / len(self.spectrum_data)) * nyquist
                
                # Only draw if within display range
                if self.display_freq_min <= bin_freq <= self.display_freq_max:
                    # Map to display coordinates
                    x_normalized = (bin_freq - self.display_freq_min) / freq_range
                    x = self.margin_left + x_normalized * self.graph_width
                    
                    # Calculate y with clamping to keep within box
                    normalized = (db - self.min_db) / db_range
                    # Clamp normalized value to 0-1 range
                    normalized = max(0.0, min(1.0, normalized))
                    y = spectrum_bottom - (normalized * self.spectrum_height)
                    points.extend([x, y])
            
            if len(points) >= 4:
                # Draw filled area
                fill_points = [self.margin_left, spectrum_bottom] + points + \
                             [self.margin_left + self.graph_width, spectrum_bottom]
                self.canvas.create_polygon(fill_points, fill='#1e90ff', outline='', stipple='gray50')
                
                # Draw line
                self.canvas.create_line(points, fill='#00ff00', width=1)
    
    def _draw_waterfall(self):
        """Draw waterfall display."""
        waterfall_top = self.margin_top + self.spectrum_height + 10
        
        if len(self.history) == 0:
            return
        
        # Scroll waterfall down
        self.waterfall_array[1:] = self.waterfall_array[:-1]
        
        # Add newest spectrum line at top (mapped to display frequency range)
        spectrum = self.history[-1]
        nyquist = self.sample_rate / 2
        freq_range = self.display_freq_max - self.display_freq_min
        
        for x_idx in range(self.graph_width):
            # Calculate frequency for this x position
            x_normalized = x_idx / self.graph_width
            display_freq = self.display_freq_min + x_normalized * freq_range
            
            # Map to FFT bin
            bin_idx = int((display_freq / nyquist) * len(spectrum))
            if bin_idx >= len(spectrum):
                bin_idx = len(spectrum) - 1
            
            db = spectrum[bin_idx]
            if np.isfinite(db):
                r, g, b = self._db_to_rgb(db)
                self.waterfall_array[0, x_idx] = [r, g, b]
        
        # Convert to PIL Image
        self.waterfall_image = Image.fromarray(self.waterfall_array, mode='RGB')
        self.waterfall_photo = ImageTk.PhotoImage(self.waterfall_image)
        
        # Draw waterfall image
        self.canvas.create_image(
            self.margin_left, waterfall_top,
            image=self.waterfall_photo, anchor=tk.NW
        )
    
    def _draw_frequency_scale(self):
        """Draw frequency scale at bottom (dynamically adjusted to bandwidth)."""
        scale_y = self.height - self.margin_bottom + 10
        
        # Use display range based on bandwidth
        freq_range = self.display_freq_max - self.display_freq_min
        
        # Draw 5 frequency markers
        for i in range(5):
            freq = self.display_freq_min + (i / 4) * freq_range
            x = self.margin_left + (i / 4) * self.graph_width
            
            # Draw tick
            self.canvas.create_line(
                x, scale_y - 5,
                x, scale_y,
                fill='white'
            )
            
            # Draw label
            if freq >= 1000:
                label = f"{freq/1000:.1f}k"
            else:
                label = f"{freq:.0f}"
            self.canvas.create_text(
                x, scale_y + 10,
                text=label, fill='white', font=('monospace', 9)
            )
        
        # Draw "Hz" label
        self.canvas.create_text(
            self.margin_left + self.graph_width + 10, scale_y + 10,
            text="Hz", fill='white', font=('monospace', 9)
        )
        
        # Draw bandwidth markers (demodulator bandwidth - yellow dashed)
        self._draw_bandwidth_markers(scale_y)
        
        # Draw audio filter markers (red solid lines - only when enabled)
        self._draw_audio_filter_markers(scale_y)
    
    def _draw_bandwidth_markers(self, scale_y: int):
        """Draw vertical lines showing the actual bandwidth edges."""
        if self.bandwidth_low == 0 and self.bandwidth_high == 0:
            return

        freq_range = self.display_freq_max - self.display_freq_min
        abs_low = abs(self.bandwidth_low)
        abs_high = abs(self.bandwidth_high)

        # Check if this is CW mode
        is_cw_mode = (self.bandwidth_low < 0 and self.bandwidth_high > 0 and
                      abs_low < 500 and abs_high < 500)

        if is_cw_mode:
            # CW mode: show markers at 500 Hz ± bandwidth edges
            cw_offset = 500
            low_marker = cw_offset - abs_low
            high_marker = cw_offset + abs_high

            # Draw low edge marker
            if self.display_freq_min <= low_marker <= self.display_freq_max:
                low_x = self.margin_left + ((low_marker - self.display_freq_min) / freq_range) * self.graph_width
                if self.margin_left <= low_x <= self.margin_left + self.graph_width:
                    self.canvas.create_line(
                        low_x, self.margin_top,
                        low_x, scale_y - 5,
                        fill='yellow', width=2, dash=(5, 3)
                    )

            # Draw high edge marker
            if self.display_freq_min <= high_marker <= self.display_freq_max:
                high_x = self.margin_left + ((high_marker - self.display_freq_min) / freq_range) * self.graph_width
                if self.margin_left <= high_x <= self.margin_left + self.graph_width:
                    self.canvas.create_line(
                        high_x, self.margin_top,
                        high_x, scale_y - 5,
                        fill='yellow', width=2, dash=(5, 3)
                    )
        elif (self.bandwidth_low < 0 and self.bandwidth_high > 0):
            # Other symmetric modes (AM, FM): show the full span
            bandwidth_span = abs_low + abs_high

            # Draw marker at the full bandwidth edge
            if bandwidth_span <= self.display_freq_max:
                marker_x = self.margin_left + ((bandwidth_span - self.display_freq_min) / freq_range) * self.graph_width
                if self.margin_left <= marker_x <= self.margin_left + self.graph_width:
                    self.canvas.create_line(
                        marker_x, self.margin_top,
                        marker_x, scale_y - 5,
                        fill='yellow', width=2, dash=(5, 3)
                    )
        else:
            # Asymmetric mode (USB, LSB): show individual edges
            low_freq = abs_low
            high_freq = abs_high

            # Only draw if within display range
            if low_freq <= self.display_freq_max:
                low_x = self.margin_left + ((low_freq - self.display_freq_min) / freq_range) * self.graph_width
                if self.margin_left <= low_x <= self.margin_left + self.graph_width:
                    self.canvas.create_line(
                        low_x, self.margin_top,
                        low_x, scale_y - 5,
                        fill='yellow', width=2, dash=(5, 3)
                    )

            if high_freq <= self.display_freq_max:
                high_x = self.margin_left + ((high_freq - self.display_freq_min) / freq_range) * self.graph_width
                if self.margin_left <= high_x <= self.margin_left + self.graph_width:
                    self.canvas.create_line(
                        high_x, self.margin_top,
                        high_x, scale_y - 5,
                        fill='yellow', width=2, dash=(5, 3)
                    )

    def _draw_audio_filter_markers(self, scale_y: int):
        """Draw vertical lines showing the audio filter bandwidth (red solid lines)."""
        if not self.audio_filter_enabled:
            return

        freq_range = self.display_freq_max - self.display_freq_min
        abs_low = abs(self.audio_filter_low)
        abs_high = abs(self.audio_filter_high)

        # Check if this is CW mode (same logic as bandwidth markers)
        is_cw_mode = (self.bandwidth_low < 0 and self.bandwidth_high > 0 and
                      abs(self.bandwidth_low) < 500 and abs(self.bandwidth_high) < 500)

        if is_cw_mode:
            # CW mode: audio filter frequencies are relative to 500 Hz offset
            # The audio filter values are absolute frequencies in the audio spectrum
            # which is already centered at 500 Hz for CW
            low_marker = abs_low
            high_marker = abs_high
        else:
            # Non-CW modes: use absolute values directly
            low_marker = abs_low
            high_marker = abs_high

        # Draw low edge marker (red solid)
        if self.display_freq_min <= low_marker <= self.display_freq_max:
            low_x = self.margin_left + ((low_marker - self.display_freq_min) / freq_range) * self.graph_width
            if self.margin_left <= low_x <= self.margin_left + self.graph_width:
                self.canvas.create_line(
                    low_x, self.margin_top,
                    low_x, scale_y - 5,
                    fill='red', width=2
                )

        # Draw high edge marker (red solid)
        if self.display_freq_min <= high_marker <= self.display_freq_max:
            high_x = self.margin_left + ((high_marker - self.display_freq_min) / freq_range) * self.graph_width
            if self.margin_left <= high_x <= self.margin_left + self.graph_width:
                self.canvas.create_line(
                    high_x, self.margin_top,
                    high_x, scale_y - 5,
                    fill='red', width=2
                )

    def on_motion(self, event):
        """Handle mouse motion for tooltip."""
        self.last_mouse_x = event.x
        self.last_mouse_y = event.y
        
        x = event.x - self.margin_left
        if x < 0 or x > self.graph_width:
            self.last_mouse_x = -1
            self.last_mouse_y = -1
            if self.tooltip_id:
                self.canvas.delete(self.tooltip_id)
                self.tooltip_id = None
            if self.cursor_line_id:
                self.canvas.delete(self.cursor_line_id)
                self.cursor_line_id = None
            return
    def on_resize(self, event):
        """Handle canvas resize event.

        Args:
            event: Configure event with new width and height
        """
        old_width = self.graph_width
        old_height = self.waterfall_height

        # Update dimensions
        self.width = event.width
        self.height = event.height
        self.spectrum_height = 150  # Keep spectrum height constant
        self.waterfall_height = self.height - self.margin_top - self.margin_bottom - self.spectrum_height - 10
        self.graph_width = self.width - self.margin_left - self.margin_right

        # Resize waterfall array if dimensions changed
        if old_width != self.graph_width or old_height != self.waterfall_height:
            # Create new array with new dimensions
            new_array = np.zeros((self.waterfall_height, self.graph_width, 3), dtype=np.uint8)

            # If we have existing data, scale it to fit new dimensions
            if self.waterfall_array.size > 0:
                try:
                    from scipy.ndimage import zoom
                    scale_y = self.waterfall_height / old_height if old_height > 0 else 1
                    scale_x = self.graph_width / old_width if old_width > 0 else 1
                    new_array = zoom(self.waterfall_array, (scale_y, scale_x, 1), order=1).astype(np.uint8)
                except ImportError:
                    # If scipy is not available, use simple numpy resize
                    # This is less smooth but works without scipy
                    if old_height > 0 and old_width > 0:
                        # Simple nearest-neighbor resize
                        for y in range(self.waterfall_height):
                            old_y = int(y * old_height / self.waterfall_height)
                            for x in range(self.graph_width):
                                old_x = int(x * old_width / self.graph_width)
                                if old_y < old_height and old_x < old_width:
                                    new_array[y, x] = self.waterfall_array[old_y, old_x]

            self.waterfall_array = new_array

            # Update history size
            self.max_history = self.waterfall_height

        # Redraw display with new dimensions
        if self.spectrum_data is not None:
            self._draw_display()

        
        self._update_tooltip_at_position(event.x, event.y)
    
    def on_click(self, event):
        """Handle mouse click to toggle audio filter or checkboxes."""
        # Check if click is on Mute checkbox (left side, top)
        if self.mute_var is not None and 35 <= event.x <= 105 and 5 <= event.y <= 25:
            # Toggle mute by calling the callback which updates main GUI
            if self.toggle_mute_callback:
                self.toggle_mute_callback()
            return

        # Check if click is on NR2 checkbox (left side, below Mute)
        if self.nr2_var is not None and 35 <= event.x <= 105 and 25 <= event.y <= 45:
            # Toggle NR2 by calling the callback which updates main GUI
            if self.toggle_nr2_callback:
                self.toggle_nr2_callback()
            return

        # Only toggle audio filter if click is within the graph area
        x = event.x - self.margin_left
        if 0 <= x <= self.graph_width:
            if self.toggle_filter_callback:
                self.toggle_filter_callback()
    
    def _update_tooltip_at_position(self, x: int, y: int):
        """Update tooltip at position."""
        if self.spectrum_data is None:
            return
        
        graph_x = x - self.margin_left
        if graph_x < 0 or graph_x > self.graph_width:
            return
        
        # Calculate frequency at cursor (using display range)
        freq_range = self.display_freq_max - self.display_freq_min
        freq = self.display_freq_min + (graph_x / self.graph_width) * freq_range
        
        # Map to FFT bin
        nyquist = self.sample_rate / 2
        bin_index = int((freq / nyquist) * len(self.spectrum_data))
        if 0 <= bin_index < len(self.spectrum_data):
            db = self.spectrum_data[bin_index]
            
            # Draw cursor line
            self._draw_cursor_line(x)
            
            # Draw tooltip
            tooltip_text = f"{freq:.0f} Hz\n{db:.1f} dB"
            self._draw_tooltip(x, y, tooltip_text)
    
    def _draw_cursor_line(self, x: int):
        """Draw vertical cursor line."""
        if self.cursor_line_id:
            self.canvas.delete(self.cursor_line_id)
        
        self.cursor_line_id = self.canvas.create_line(
            x, self.margin_top,
            x, self.height - self.margin_bottom,
            fill='white', width=1, dash=(3, 3)
        )
    
    def _draw_tooltip(self, x: int, y: int, text: str):
        """Draw tooltip at position with white background and black text."""
        # Delete previous tooltip (both background and text)
        if self.tooltip_bg_id:
            self.canvas.delete(self.tooltip_bg_id)
        if self.tooltip_id:
            self.canvas.delete(self.tooltip_id)
        
        # Position tooltip
        if x > self.width / 2:
            tooltip_x = x - 10
            anchor = tk.E
        else:
            tooltip_x = x + 10
            anchor = tk.W
        
        # Estimate text size (rough approximation for multi-line text)
        lines = text.split('\n')
        text_width = max(len(line) for line in lines) * 7
        text_height = len(lines) * 14

        if anchor == tk.E:
            # Text anchored to right
            bg_x1 = tooltip_x - text_width - 4
            bg_x2 = tooltip_x + 2
        else:
            # Text anchored to left
            bg_x1 = tooltip_x - 2
            bg_x2 = tooltip_x + text_width + 4

        bg_y1 = y - 10 - text_height // 2 - 2
        bg_y2 = y - 10 + text_height // 2 + 2

        # Draw background and track its ID
        self.tooltip_bg_id = self.canvas.create_rectangle(
            bg_x1, bg_y1, bg_x2, bg_y2,
            fill='white', outline='black', width=1
        )

        # Draw text
        self.tooltip_id = self.canvas.create_text(
            tooltip_x, y - 10,
            text=text,
            fill='black',
            font=('monospace', 9, 'bold'),
            anchor=anchor
        )
    
    def _find_peak_in_bandwidth(self):
        """Find the peak frequency and level within the filter bandwidth with 500ms averaging.

        Returns:
            Tuple of (peak_frequency_hz, peak_db) or (None, None) if no valid data
        """
        if self.spectrum_data is None or len(self.spectrum_data) == 0:
            return None, None

        # Calculate bin range for filter bandwidth
        nyquist = self.sample_rate / 2
        abs_low = abs(self.bandwidth_low)
        abs_high = abs(self.bandwidth_high)

        # Check if this is CW mode
        is_cw_mode = (self.bandwidth_low < 0 and self.bandwidth_high > 0 and
                      abs_low < 500 and abs_high < 500)

        if is_cw_mode:
            # CW mode: search around 500 Hz ± bandwidth
            cw_offset = 500
            search_low = cw_offset - abs_low
            search_high = cw_offset + abs_high
            low_bin = int((search_low / nyquist) * len(self.spectrum_data))
            high_bin = int((search_high / nyquist) * len(self.spectrum_data))
        elif (self.bandwidth_low < 0 and self.bandwidth_high > 0):
            # Other symmetric modes: bandwidth spans from 0 to (abs(low) + abs(high))
            bandwidth_span = abs_low + abs_high
            low_bin = 0
            high_bin = int((bandwidth_span / nyquist) * len(self.spectrum_data))
        else:
            # Asymmetric mode: use absolute values
            # For LSB/CWL (both negative), swap the values since -2700 to -50 means audio 50 to 2700
            if self.bandwidth_low < 0 and self.bandwidth_high < 0:
                # LSB mode: swap abs values
                low_bin = int((abs_high / nyquist) * len(self.spectrum_data))
                high_bin = int((abs_low / nyquist) * len(self.spectrum_data))
            else:
                # USB mode: use normal order
                low_bin = int((abs_low / nyquist) * len(self.spectrum_data))
                high_bin = int((abs_high / nyquist) * len(self.spectrum_data))

        # Ensure valid range
        low_bin = max(0, min(low_bin, len(self.spectrum_data) - 1))
        high_bin = max(low_bin + 1, min(high_bin, len(self.spectrum_data)))

        # Find peak within bandwidth
        bandwidth_data = self.spectrum_data[low_bin:high_bin]
        valid_data = bandwidth_data[np.isfinite(bandwidth_data)]

        if len(valid_data) == 0:
            return None, None

        # Find instantaneous peak
        peak_idx = np.argmax(bandwidth_data)
        peak_db = bandwidth_data[peak_idx]

        # Convert bin index to frequency
        actual_bin = low_bin + peak_idx
        peak_freq = (actual_bin / len(self.spectrum_data)) * nyquist
        
        # Add to history with timestamp
        import time
        current_time = time.time()
        self.peak_history.append((peak_freq, peak_db))
        self.peak_timestamps.append(current_time)
        
        # Average peaks over last 500ms
        cutoff_time = current_time - self.peak_average_window
        recent_peaks = []
        for i, timestamp in enumerate(self.peak_timestamps):
            if timestamp >= cutoff_time:
                recent_peaks.append(self.peak_history[i])
        
        if len(recent_peaks) == 0:
            return peak_freq, peak_db
        
        # Calculate weighted average (more recent = higher weight)
        total_weight = 0
        weighted_freq = 0
        weighted_db = 0
        
        for i, (freq, db) in enumerate(recent_peaks):
            # Linear weight: newer samples get higher weight
            weight = i + 1
            weighted_freq += freq * weight
            weighted_db += db * weight
            total_weight += weight
        
        avg_freq = weighted_freq / total_weight
        avg_db = weighted_db / total_weight
        
        return avg_freq, avg_db


def create_audio_spectrum_window(parent_gui):
    """Create a standalone audio spectrum window.

    Args:
        parent_gui: Parent RadioGUI instance

    Returns:
        Tuple of (window, audio_spectrum_display)
    """
    import tkinter.ttk as ttk

    # Create toplevel window
    window = Toplevel(parent_gui.root)
    window.title("Audio Spectrum Display")
    window.geometry("800x500")

    # Mute and NR2 variables
    mute_var = tk.BooleanVar(value=not (parent_gui.channel_left_var.get() or parent_gui.channel_right_var.get()))
    nr2_var = tk.BooleanVar(value=parent_gui.nr2_enabled_var.get())

    def toggle_mute():
        """Toggle mute in the main GUI."""
        # Toggle the current state
        current_muted = not (parent_gui.channel_left_var.get() or parent_gui.channel_right_var.get())
        new_muted = not current_muted

        if new_muted:
            # Mute: disable both channels
            parent_gui.channel_left_var.set(False)
            parent_gui.channel_right_var.set(False)
        else:
            # Unmute: enable both channels
            parent_gui.channel_left_var.set(True)
            parent_gui.channel_right_var.set(True)
        parent_gui.update_channels()

        # Update local var to match
        mute_var.set(new_muted)

    def toggle_nr2():
        """Toggle NR2 in the main GUI."""
        # Toggle the current state
        new_state = not parent_gui.nr2_enabled_var.get()
        parent_gui.nr2_enabled_var.set(new_state)
        parent_gui.toggle_nr2()

        # Update local var to match
        nr2_var.set(new_state)

    # Create audio spectrum display with toggle callbacks
    def toggle_audio_filter():
        """Toggle the audio filter in the main GUI."""
        parent_gui.audio_filter_enabled_var.set(not parent_gui.audio_filter_enabled_var.get())
        parent_gui.toggle_audio_filter()

    def sync_mute_from_main():
        """Sync mute checkbox from main GUI channel states."""
        is_muted = not (parent_gui.channel_left_var.get() or parent_gui.channel_right_var.get())
        mute_var.set(is_muted)

    def sync_nr2_from_main():
        """Sync NR2 checkbox from main GUI."""
        nr2_var.set(parent_gui.nr2_enabled_var.get())

    audio_spectrum = AudioSpectrumDisplay(window, width=800, height=500,
                                         toggle_filter_callback=toggle_audio_filter,
                                         mute_var=mute_var,
                                         nr2_var=nr2_var,
                                         toggle_mute_callback=toggle_mute,
                                         toggle_nr2_callback=toggle_nr2)

    # Periodic sync to keep checkboxes in sync with main GUI (every 500ms)
    def periodic_sync():
        if window.winfo_exists():
            sync_mute_from_main()
            sync_nr2_from_main()
            window.after(500, periodic_sync)

    window.after(500, periodic_sync)

    # Set sample rate from client
    if parent_gui.client:
        audio_spectrum.set_sample_rate(parent_gui.client.sample_rate)

    # Update bandwidth
    try:
        audio_spectrum.update_bandwidth(
            int(parent_gui.bw_low_var.get()),
            int(parent_gui.bw_high_var.get()),
            parent_gui.mode_var.get().lower()
        )
    except:
        pass

    # Handle window close
    def on_close():
        audio_spectrum.disconnect()
        window.destroy()
        parent_gui.audio_spectrum_window = None
        parent_gui.audio_spectrum_display = None

    window.protocol("WM_DELETE_WINDOW", on_close)

    return window, audio_spectrum