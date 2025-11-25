#!/usr/bin/env python3
"""
GUI Radio Client for ka9q_ubersdr
Provides a graphical interface for the radio client with frequency, mode, and bandwidth controls.
"""

import asyncio
import sys
import threading
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
from typing import Optional, List, Tuple
import queue

# Import spectrum display
try:
    from spectrum_display import SpectrumDisplay
    SPECTRUM_AVAILABLE = True
except ImportError:
    SPECTRUM_AVAILABLE = False
    print("Warning: Spectrum display not available (missing dependencies)")

# Import waterfall display
try:
    from waterfall_display import create_waterfall_window
    WATERFALL_AVAILABLE = True
except ImportError:
    WATERFALL_AVAILABLE = False
    print("Warning: Waterfall display not available (missing dependencies)")

# Check if NR2 is available
try:
    from nr2 import create_nr2_processor
    NR2_AVAILABLE = True
except ImportError:
    NR2_AVAILABLE = False


class RadioGUI:
    """Tkinter-based GUI for the radio client."""
    
    def __init__(self, root: tk.Tk, initial_config: dict):
        self.root = root
        self.root.title("ka9q_ubersdr Radio Client")
        self.root.geometry("800x1000")  # Increased height for spectrum display
        self.root.resizable(True, True)
        
        # Configuration
        self.config = initial_config
        
        # Client state
        self.client: Optional[RadioClient] = None
        self.client_thread: Optional[threading.Thread] = None
        self.event_loop: Optional[asyncio.AbstractEventLoop] = None
        self.connected = False
        self.connecting = False  # Track if connection attempt is in progress
        self.cancel_connection = False  # Flag to cancel connection attempt
        self.status_queue = queue.Queue()
        self.audio_level_queue = queue.Queue()
        self.pipewire_devices: List[Tuple[str, str]] = []
        
        # Recording state
        self.recording = False
        self.recording_start_time = None
        self.recording_data = []
        self.recording_max_duration = 300  # 300 seconds limit
        
        # Spectrum display (always enabled)
        self.spectrum: Optional[SpectrumDisplay] = None
        self.spectrum_frame = None

        # Waterfall display (separate window)
        self.waterfall_window = None
        self.waterfall_display = None
        
        # Create UI
        self.create_widgets()
        
        # Start status update checker
        self.check_status_updates()
        
        # Handle window close
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)
    
    def create_widgets(self):
        """Create all GUI widgets."""
        # Main container with padding
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        
        # Connection settings frame
        conn_frame = ttk.LabelFrame(main_frame, text="Connection", padding="10")
        conn_frame.grid(row=0, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))
        
        ttk.Label(conn_frame, text="Server:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        self.server_var = tk.StringVar(value=self.config.get('url') or f"{self.config.get('host', 'localhost')}:{self.config.get('port', 8080)}")
        server_entry = ttk.Entry(conn_frame, textvariable=self.server_var, width=40)
        server_entry.grid(row=0, column=1, sticky=(tk.W, tk.E), padx=(0, 10))
        
        # TLS checkbox - default from config or False
        self.tls_var = tk.BooleanVar(value=self.config.get('ssl', False))
        tls_check = ttk.Checkbutton(conn_frame, text="TLS", variable=self.tls_var)
        tls_check.grid(row=0, column=2, sticky=tk.W, padx=(0, 5))
        
        self.connect_btn = ttk.Button(conn_frame, text="Connect", command=self.toggle_connection)
        self.connect_btn.grid(row=0, column=3, padx=(0, 5))
        
        # Cancel button (hidden by default)
        self.cancel_btn = ttk.Button(conn_frame, text="Cancel", command=self.cancel_connection_attempt)
        self.cancel_btn.grid(row=0, column=4)
        self.cancel_btn.grid_remove()  # Hide initially
        
        conn_frame.columnconfigure(1, weight=1)
        
        # Frequency control frame
        freq_frame = ttk.LabelFrame(main_frame, text="Frequency", padding="10")
        freq_frame.grid(row=1, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))
        
        ttk.Label(freq_frame, text="Frequency:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        
        # Convert initial frequency from Hz to MHz for display
        initial_freq_hz = self.config.get('frequency', 14074000)
        initial_freq_mhz = initial_freq_hz / 1e6
        
        self.freq_var = tk.StringVar(value=f"{initial_freq_mhz:.6f}")
        freq_entry = ttk.Entry(freq_frame, textvariable=self.freq_var, width=12)
        freq_entry.grid(row=0, column=1, sticky=tk.W, padx=(0, 5))
        
        # Unit selector (Hz, kHz, MHz)
        self.freq_unit_var = tk.StringVar(value="MHz")
        unit_combo = ttk.Combobox(freq_frame, textvariable=self.freq_unit_var,
                                  values=["Hz", "kHz", "MHz"], state='readonly', width=6)
        unit_combo.grid(row=0, column=2, sticky=tk.W, padx=(0, 5))
        
        # Apply button (moved to top row)
        self.apply_freq_btn = ttk.Button(freq_frame, text="Apply", command=self.apply_frequency)
        self.apply_freq_btn.grid(row=0, column=3, sticky=tk.W, padx=(0, 10))
        self.apply_freq_btn.state(['disabled'])
        
        # Step size selector
        ttk.Label(freq_frame, text="Step:").grid(row=0, column=4, sticky=tk.W, padx=(10, 5))
        self.step_size_var = tk.StringVar(value="1 kHz")
        step_combo = ttk.Combobox(freq_frame, textvariable=self.step_size_var,
                                  values=["10 Hz", "100 Hz", "500 Hz", "1 kHz", "10 kHz"],
                                  state='readonly', width=8)
        step_combo.grid(row=0, column=5, sticky=tk.W, padx=(0, 5))
        step_combo.bind('<<ComboboxSelected>>', lambda e: self.on_step_size_changed())
        
        # Up/Down buttons
        ttk.Button(freq_frame, text="▲", width=3, command=self.step_frequency_up).grid(row=0, column=6, sticky=tk.W, padx=1)
        ttk.Button(freq_frame, text="▼", width=3, command=self.step_frequency_down).grid(row=0, column=7, sticky=tk.W, padx=1)
        
        # Quick frequency buttons - all amateur bands from 160m to 10m (2 rows)
        # Moved to second row
        quick_frame = ttk.Frame(freq_frame)
        quick_frame.grid(row=1, column=0, columnspan=8, sticky=tk.W, pady=(5, 0))
        
        # Band frequencies (center of digital/CW portions)
        quick_freqs = [
            ("160m", 1900000),   # 160m band - LSB
            ("80m", 3573000),    # 80m band - LSB
            ("60m", 5357000),    # 60m band (5 MHz) - LSB
            ("40m", 7074000),    # 40m band - LSB
            ("30m", 10136000),   # 30m band (WARC) - USB (above 10 MHz)
            ("20m", 14074000),   # 20m band - USB
            ("17m", 18100000),   # 17m band (WARC) - USB
            ("15m", 21074000),   # 15m band - USB
            ("12m", 24915000),   # 12m band (WARC) - USB
            ("10m", 28074000)    # 10m band - USB
        ]
        
        # Arrange in 2 rows of 5 buttons each
        for i, (label, freq_hz) in enumerate(quick_freqs):
            row = i // 5  # First 5 in row 0, next 5 in row 1
            col = i % 5   # Column position within the row
            btn = ttk.Button(quick_frame, text=label, width=5,
                           command=lambda f=freq_hz: self.set_frequency_and_mode(f))
            btn.grid(row=row, column=col, padx=1, pady=1)
        
        freq_frame.columnconfigure(8, weight=1)
        
        # Mode & Bandwidth control frame (combined)
        bw_frame = ttk.LabelFrame(main_frame, text="Mode", padding="10")
        bw_frame.grid(row=2, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))
        
        # Mode selection (first row)
        ttk.Label(bw_frame, text="Demodulation:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        
        modes = ['AM', 'SAM', 'USB', 'LSB', 'FM', 'NFM', 'CWU', 'CWL', 'IQ']
        self.mode_var = tk.StringVar(value=self.config.get('mode', 'USB').upper())
        mode_combo = ttk.Combobox(bw_frame, textvariable=self.mode_var, values=modes,
                                 state='readonly', width=10)
        mode_combo.grid(row=0, column=1, sticky=tk.W, padx=(0, 10))
        mode_combo.bind('<<ComboboxSelected>>', lambda e: self.on_mode_changed())
        
        # Mode lock checkbox
        self.mode_lock_var = tk.BooleanVar(value=False)
        mode_lock_check = ttk.Checkbutton(bw_frame, text="Lock", variable=self.mode_lock_var)
        mode_lock_check.grid(row=0, column=2, sticky=tk.W, padx=(0, 10))
        
        # Bandwidth controls (second row)
        ttk.Label(bw_frame, text="Low (Hz):").grid(row=1, column=0, sticky=tk.W, padx=(0, 5))
        self.bw_low_var = tk.StringVar(value=str(self.config.get('bandwidth_low', 50)))
        bw_low_entry = ttk.Entry(bw_frame, textvariable=self.bw_low_var, width=10)
        bw_low_entry.grid(row=1, column=1, sticky=tk.W, padx=(0, 20))
        
        ttk.Label(bw_frame, text="High (Hz):").grid(row=1, column=2, sticky=tk.W, padx=(0, 5))
        self.bw_high_var = tk.StringVar(value=str(self.config.get('bandwidth_high', 2700)))
        bw_high_entry = ttk.Entry(bw_frame, textvariable=self.bw_high_var, width=10)
        bw_high_entry.grid(row=1, column=3, sticky=tk.W, padx=(0, 10))
        
        self.apply_bw_btn = ttk.Button(bw_frame, text="Apply", command=self.apply_bandwidth)
        self.apply_bw_btn.grid(row=1, column=4, sticky=tk.W)
        self.apply_bw_btn.state(['disabled'])
        
        # Preset bandwidth buttons (will be updated based on mode)
        self.preset_frame = ttk.Frame(bw_frame)
        self.preset_frame.grid(row=2, column=0, columnspan=5, sticky=tk.W, pady=(5, 0))
        
        ttk.Label(self.preset_frame, text="Presets:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        
        # Store preset buttons for dynamic updates
        self.preset_buttons = []
        
        # Create initial preset buttons (will be updated when mode changes)
        self.update_preset_buttons()
        
        bw_frame.columnconfigure(5, weight=1)
        
        # Audio control frame (includes NR2)
        audio_frame = ttk.LabelFrame(main_frame, text="Audio", padding="10")
        audio_frame.grid(row=3, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))
        
        # Output device selector
        ttk.Label(audio_frame, text="Output Device:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        
        self.device_var = tk.StringVar(value="(default)")
        self.device_combo = ttk.Combobox(audio_frame, textvariable=self.device_var,
                                        state='readonly', width=30)
        self.device_combo.grid(row=0, column=1, columnspan=3, sticky=(tk.W, tk.E), padx=(0, 5))
        
        # Refresh devices button
        self.refresh_devices_btn = ttk.Button(audio_frame, text="↻", width=3,
                                             command=self.refresh_devices)
        self.refresh_devices_btn.grid(row=0, column=4, sticky=tk.W)
        
        # Load initial device list
        self.refresh_devices()
        
        # Volume control
        ttk.Label(audio_frame, text="Volume:").grid(row=1, column=0, sticky=tk.W, padx=(0, 5))
        self.volume_var = tk.IntVar(value=70)
        volume_scale = ttk.Scale(audio_frame, from_=0, to=100, orient=tk.HORIZONTAL,
                                variable=self.volume_var, command=self.update_volume)
        volume_scale.grid(row=1, column=1, sticky=(tk.W, tk.E), padx=(0, 10))
        
        self.volume_label = ttk.Label(audio_frame, text="70%", width=5)
        self.volume_label.grid(row=1, column=2, sticky=tk.W, padx=(0, 20))
        
        # Audio level meter
        ttk.Label(audio_frame, text="Level:").grid(row=1, column=3, sticky=tk.W, padx=(0, 5))
        
        # Create a frame for the level meter bar
        meter_frame = ttk.Frame(audio_frame, relief=tk.SUNKEN, borderwidth=1)
        meter_frame.grid(row=1, column=4, sticky=(tk.W, tk.E), padx=(0, 10))
        
        # Canvas for audio level meter
        self.level_canvas = tk.Canvas(meter_frame, width=150, height=20, bg='#2c3e50', highlightthickness=0)
        self.level_canvas.pack()
        
        # Audio level bar (will be updated dynamically)
        self.level_bar = self.level_canvas.create_rectangle(0, 0, 0, 20, fill='#28a745', outline='')
        
        self.level_label = ttk.Label(audio_frame, text="-∞ dB", width=8)
        self.level_label.grid(row=1, column=5, sticky=tk.W)
        
        # Channel selection (Left/Right)
        ttk.Label(audio_frame, text="Channels:").grid(row=2, column=0, sticky=tk.W, padx=(0, 5), pady=(5, 0))

        self.channel_left_var = tk.BooleanVar(value=True)
        self.channel_right_var = tk.BooleanVar(value=True)

        left_check = ttk.Checkbutton(audio_frame, text="Left", variable=self.channel_left_var,
                                     command=self.update_channels)
        left_check.grid(row=2, column=1, sticky=tk.W, pady=(5, 0))

        right_check = ttk.Checkbutton(audio_frame, text="Right", variable=self.channel_right_var,
                                      command=self.update_channels)
        right_check.grid(row=2, column=2, sticky=tk.W, pady=(5, 0))
        
        # NR2 Noise Reduction (row 3) - use a frame to avoid column weight issues
        nr2_container = ttk.Frame(audio_frame)
        nr2_container.grid(row=3, column=0, columnspan=7, sticky=tk.W, pady=(5, 0))
        
        self.nr2_enabled_var = tk.BooleanVar(value=False)
        nr2_check = ttk.Checkbutton(nr2_container, text="Enable NR2", variable=self.nr2_enabled_var,
                                    command=self.toggle_nr2)
        nr2_check.grid(row=0, column=0, sticky=tk.W, padx=(0, 20))
        
        ttk.Label(nr2_container, text="Strength:").grid(row=0, column=1, sticky=tk.W, padx=(0, 5))
        self.nr2_strength_var = tk.StringVar(value="40")
        nr2_strength_entry = ttk.Entry(nr2_container, textvariable=self.nr2_strength_var, width=8)
        nr2_strength_entry.grid(row=0, column=2, sticky=tk.W, padx=(0, 5))
        ttk.Label(nr2_container, text="%").grid(row=0, column=3, sticky=tk.W, padx=(0, 20))
        
        ttk.Label(nr2_container, text="Floor:").grid(row=0, column=4, sticky=tk.W, padx=(0, 5))
        self.nr2_floor_var = tk.StringVar(value="10")
        nr2_floor_entry = ttk.Entry(nr2_container, textvariable=self.nr2_floor_var, width=8)
        nr2_floor_entry.grid(row=0, column=5, sticky=tk.W, padx=(0, 5))
        ttk.Label(nr2_container, text="%").grid(row=0, column=6, sticky=tk.W, padx=(0, 20))
        
        # Recording controls (same row as NR2, to the right)
        self.rec_btn = ttk.Button(nr2_container, text="⏺ Record", width=10,
                                   command=self.toggle_recording)
        self.rec_btn.grid(row=0, column=7, sticky=tk.W, padx=(0, 10))
        self.rec_btn.state(['disabled'])  # Disabled until connected
        
        self.rec_status_label = ttk.Label(nr2_container, text="", foreground='red')
        self.rec_status_label.grid(row=0, column=8, sticky=tk.W)
        
        audio_frame.columnconfigure(1, weight=1)
        audio_frame.columnconfigure(4, weight=1)
        
        # Spectrum display (always visible if available)
        if SPECTRUM_AVAILABLE:
            spectrum_frame = ttk.LabelFrame(main_frame, text="Spectrum", padding="10")
            spectrum_frame.grid(row=4, column=0, columnspan=2, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))

            self.spectrum = SpectrumDisplay(spectrum_frame, width=800, height=200)
            self.spectrum.set_frequency_callback(self.on_spectrum_frequency_click)
            self.spectrum.set_frequency_step_callback(self.on_spectrum_frequency_step)

            # Initialize spectrum with current bandwidth values
            try:
                initial_low = int(self.bw_low_var.get())
                initial_high = int(self.bw_high_var.get())
                self.spectrum.update_bandwidth(initial_low, initial_high)
            except ValueError:
                pass  # Use defaults if values are invalid

            # Add waterfall button
            if WATERFALL_AVAILABLE:
                waterfall_btn = ttk.Button(spectrum_frame, text="Open Waterfall",
                                          command=self.open_waterfall_window)
                waterfall_btn.pack(side=tk.TOP, pady=(0, 5))

            spectrum_frame.columnconfigure(0, weight=1)
            spectrum_frame.rowconfigure(0, weight=1)
        
        # Status frame
        status_frame = ttk.LabelFrame(main_frame, text="Status", padding="10")
        status_frame.grid(row=5, column=0, columnspan=2, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        
        self.status_text = tk.Text(status_frame, height=8, width=50, state='disabled', 
                                   wrap=tk.WORD, bg='#f0f0f0')
        self.status_text.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        scrollbar = ttk.Scrollbar(status_frame, orient=tk.VERTICAL, command=self.status_text.yview)
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))
        self.status_text['yscrollcommand'] = scrollbar.set
        
        status_frame.columnconfigure(0, weight=1)
        status_frame.rowconfigure(0, weight=1)
        
        # Configure main frame weights
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(5, weight=1)
        
        # Initial status
        self.log_status("Ready to connect")
        
        # Start audio level meter updates
        self.update_audio_level()
    
    def log_status(self, message: str):
        """Add a status message to the log."""
        self.status_text.config(state='normal')
        # Get current content
        current_content = self.status_text.get('1.0', tk.END)
        # If there's existing content, add newline before the message
        if current_content.strip():
            self.status_text.insert(tk.END, f"\n{message}")
        else:
            self.status_text.insert(tk.END, message)
        self.status_text.see(tk.END)
        self.status_text.config(state='disabled')
    
    def set_frequency_hz(self, freq_hz: int):
        """Set frequency from quick button (input in Hz)."""
        # Convert to current unit
        unit = self.freq_unit_var.get()
        if unit == "MHz":
            freq_display = freq_hz / 1e6
            self.freq_var.set(f"{freq_display:.6f}")
        elif unit == "kHz":
            freq_display = freq_hz / 1e3
            self.freq_var.set(f"{freq_display:.3f}")
        else:  # Hz
            self.freq_var.set(str(freq_hz))
        
        if self.connected:
            self.apply_frequency()
    
    def set_frequency_and_mode(self, freq_hz: int):
        """Set frequency and appropriate mode from quick button (LSB < 10 MHz, USB >= 10 MHz)."""
        # Set frequency display
        unit = self.freq_unit_var.get()
        if unit == "MHz":
            freq_display = freq_hz / 1e6
            self.freq_var.set(f"{freq_display:.6f}")
        elif unit == "kHz":
            freq_display = freq_hz / 1e3
            self.freq_var.set(f"{freq_display:.3f}")
        else:  # Hz
            self.freq_var.set(str(freq_hz))
        
        # Set mode based on frequency (LSB below 10 MHz, USB at/above 10 MHz) only if not locked
        if not self.mode_lock_var.get():
            if freq_hz < 10000000:  # Below 10 MHz
                mode = 'LSB'
            else:  # 10 MHz and above
                mode = 'USB'
            
            self.mode_var.set(mode)
            # Trigger mode change handler to update bandwidth and presets
            self.on_mode_changed()
        
        # Apply changes if connected
        if self.connected:
            self.apply_frequency()
    
    def get_frequency_hz(self) -> int:
        """Convert frequency from current unit to Hz."""
        try:
            freq_value = float(self.freq_var.get())
            unit = self.freq_unit_var.get()
            
            if unit == "MHz":
                return int(freq_value * 1e6)
            elif unit == "kHz":
                return int(freq_value * 1e3)
            else:  # Hz
                return int(freq_value)
        except ValueError:
            raise ValueError("Invalid frequency value")
    
    def set_bandwidth(self, low: int, high: int):
        """Set bandwidth from preset button."""
        self.bw_low_var.set(str(low))
        self.bw_high_var.set(str(high))
        
        # Update spectrum display bandwidth visualization
        if self.spectrum:
            self.spectrum.update_bandwidth(low, high)
        
        # Update waterfall display bandwidth visualization
        if self.waterfall_display:
            self.waterfall_display.update_bandwidth(low, high)
        
        if self.connected:
            self.apply_bandwidth()
    
    def get_step_size_hz(self) -> int:
        """Get the current step size in Hz."""
        step_str = self.step_size_var.get()
        if "10 Hz" in step_str:
            return 10
        elif "100 Hz" in step_str:
            return 100
        elif "500 Hz" in step_str:
            return 500
        elif "1 kHz" in step_str:
            return 1000
        elif "10 kHz" in step_str:
            return 10000
        return 1000  # Default
    
    def on_step_size_changed(self):
        """Handle step size change - update spectrum display."""
        if self.spectrum:
            self.spectrum.set_step_size(self.get_step_size_hz())
    
    def step_frequency_up(self):
        """Step frequency up by the selected step size, rounding to step boundaries."""
        try:
            current_hz = self.get_frequency_hz()
            step_hz = self.get_step_size_hz()
            
            # Round up to next step boundary
            new_hz = ((current_hz // step_hz) + 1) * step_hz
            
            # Update display
            self.set_frequency_hz(new_hz)
            
            # Apply immediately if connected
            if self.connected:
                self.apply_frequency()
        except ValueError:
            pass
    
    def step_frequency_down(self):
        """Step frequency down by the selected step size, rounding to step boundaries."""
        try:
            current_hz = self.get_frequency_hz()
            step_hz = self.get_step_size_hz()
            
            # Round down to previous step boundary
            new_hz = ((current_hz - 1) // step_hz) * step_hz
            
            # Update display
            self.set_frequency_hz(new_hz)
            
            # Apply immediately if connected
            if self.connected:
                self.apply_frequency()
        except ValueError:
            pass
    
    def set_frequency_hz(self, freq_hz: int):
        """Set the frequency display to the given Hz value."""
        # Convert to current unit
        unit = self.freq_unit_var.get()
        if unit == "Hz":
            self.freq_var.set(f"{freq_hz}")
        elif unit == "kHz":
            self.freq_var.set(f"{freq_hz / 1000:.3f}")
        else:  # MHz
            self.freq_var.set(f"{freq_hz / 1e6:.6f}")
    
    def apply_frequency(self):
        """Apply frequency change by sending tune message."""
        if not self.connected or not self.client:
            return
        
        try:
            freq_hz = self.get_frequency_hz()
            self.client.frequency = freq_hz
            
            # Auto-select appropriate mode based on frequency (LSB < 10 MHz, USB >= 10 MHz)
            # Only auto-switch for SSB modes (USB/LSB) and if mode is not locked
            if not self.mode_lock_var.get():
                current_mode = self.mode_var.get().upper()
                if current_mode in ['USB', 'LSB']:
                    if freq_hz < 10000000 and current_mode != 'LSB':
                        # Below 10 MHz, use LSB
                        self.mode_var.set('LSB')
                        self.on_mode_changed()
                        self.log_status(f"Auto-switched to LSB (< 10 MHz)")
                    elif freq_hz >= 10000000 and current_mode != 'USB':
                        # 10 MHz and above, use USB
                        self.mode_var.set('USB')
                        self.on_mode_changed()
                        self.log_status(f"Auto-switched to USB (≥ 10 MHz)")
            
            # Update spectrum display center frequency (also sets tuned frequency)
            if self.spectrum:
                self.spectrum.update_center_frequency(freq_hz)

            # Update waterfall display if open
            if self.waterfall_display:
                self.waterfall_display.update_center_frequency(freq_hz)
            
            # Send tune message
            self.log_status(f"Tuning to {freq_hz/1e6:.6f} MHz...")
            self.send_tune_message()
        except ValueError as e:
            messagebox.showerror("Error", f"Invalid frequency: {e}")
    
    def on_mode_changed(self, skip_apply=False):
        """Handle mode change from dropdown - updates bandwidth and presets immediately."""
        mode = self.mode_var.get().lower()
        
        # Always update bandwidth defaults and presets when mode changes
        self.adjust_bandwidth_for_mode(mode)
        self.update_preset_buttons()
        
        # If connected, also apply the change to the client (unless skip_apply is True)
        if self.connected and self.client and not skip_apply:
            self.apply_mode()
    
    def apply_mode(self):
        """Apply mode change by sending tune message (called when connected)."""
        if not self.connected or not self.client:
            return
        
        mode = self.mode_var.get().lower()
        self.client.mode = mode
        
        self.log_status(f"Switching to {mode.upper()} mode...")
        self.send_tune_message()
    
    def apply_bandwidth(self):
        """Apply bandwidth change by sending tune message."""
        if not self.connected or not self.client:
            return
        
        try:
            low = int(self.bw_low_var.get())
            high = int(self.bw_high_var.get())
            self.client.bandwidth_low = low
            self.client.bandwidth_high = high
            
            # Update spectrum display bandwidth visualization
            if self.spectrum:
                self.spectrum.update_bandwidth(low, high)

            # Update waterfall display if open
            if self.waterfall_display:
                self.waterfall_display.update_bandwidth(low, high)
            
            self.log_status(f"Adjusting bandwidth to {low} to {high} Hz...")
            self.send_tune_message()
        except ValueError:
            messagebox.showerror("Error", "Invalid bandwidth values")
    
    def update_volume(self, value):
        """Update volume level."""
        volume = int(float(value))
        self.volume_label.config(text=f"{volume}%")
        
        # Apply volume to client if connected
        if self.client:
            # Convert percentage (0-100) to gain (0.0-2.0)
            # 100% = 1.0 gain, 200% = 2.0 gain
            self.client.volume = volume / 100.0
            self.log_status(f"Volume: {volume}%")
    
    def update_channels(self):
        """Update audio channel routing (Left/Right)."""
        left = self.channel_left_var.get()
        right = self.channel_right_var.get()
        
        # Apply channel selection to client if connected
        if self.client:
            self.client.channel_left = left
            self.client.channel_right = right
        
        # Log channel selection
        channels = []
        if left:
            channels.append("Left")
        if right:
            channels.append("Right")
        
        if channels:
            self.log_status(f"Audio output: {' + '.join(channels)}")
        else:
            self.log_status("Audio output: Muted (no channels selected)")
    
    def refresh_devices(self):
        """Refresh the list of available PipeWire output devices."""
        try:
            from radio_client import get_pipewire_sinks
            self.pipewire_devices = get_pipewire_sinks()
            
            # Build device list for combobox
            device_list = ["(default)"]
            for node_name, description in self.pipewire_devices:
                device_list.append(f"{description} ({node_name})")
            
            self.device_combo['values'] = device_list
            
            # Keep current selection if it's still valid
            current = self.device_var.get()
            if current not in device_list:
                self.device_var.set("(default)")
        except Exception as e:
            print(f"Error refreshing devices: {e}", file=sys.stderr)
            self.device_combo['values'] = ["(default)"]
            self.device_var.set("(default)")
    
    def get_selected_device(self) -> Optional[str]:
        """Get the selected PipeWire device node name, or None for default."""
        selection = self.device_var.get()
        if selection == "(default)":
            return None
        
        # Extract node name from "Description (node_name)" format
        for node_name, description in self.pipewire_devices:
            if f"{description} ({node_name})" == selection:
                return node_name
        
        return None
    
    def update_audio_level(self):
        """Update audio level meter from actual audio data."""
        try:
            if self.connected:
                # Try to get latest audio level from queue
                level_db = None
                try:
                    # Drain queue to get most recent value
                    while True:
                        level_db = self.audio_level_queue.get_nowait()
                except queue.Empty:
                    pass
                
                if level_db is not None:
                    # Convert dB to percentage for display (range: -60 dB to 0 dB)
                    level_percent = max(0, min(100, (level_db + 60) / 60 * 100))
                    
                    # Update meter bar
                    bar_width = int(150 * level_percent / 100)
                    self.level_canvas.coords(self.level_bar, 0, 0, bar_width, 20)
                    
                    # Color based on level (green -> yellow -> red)
                    if level_percent < 70:
                        color = '#28a745'  # Green
                    elif level_percent < 90:
                        color = '#ffc107'  # Yellow
                    else:
                        color = '#dc3545'  # Red
                    self.level_canvas.itemconfig(self.level_bar, fill=color)
                    
                    # Update label
                    self.level_label.config(text=f"{level_db:.1f} dB")
            else:
                # No audio when disconnected
                self.level_canvas.coords(self.level_bar, 0, 0, 0, 20)
                self.level_label.config(text="-∞ dB")
        except Exception:
            pass
        
        # Schedule next update (10 times per second)
        self.root.after(100, self.update_audio_level)
    
    def toggle_nr2(self):
        """Toggle NR2 noise reduction on/off."""
        if not self.connected or not self.client:
            return
        
        enabled = self.nr2_enabled_var.get()
        
        try:
            strength = float(self.nr2_strength_var.get())
            floor = float(self.nr2_floor_var.get())
            
            # Validate parameters
            if strength < 0 or strength > 100:
                messagebox.showerror("Error", "NR2 strength must be between 0 and 100")
                self.nr2_enabled_var.set(not enabled)
                return
            if floor < 0 or floor > 10:
                messagebox.showerror("Error", "NR2 floor must be between 0 and 10")
                self.nr2_enabled_var.set(not enabled)
                return
            
            if enabled:
                # Enable NR2
                if not NR2_AVAILABLE:
                    messagebox.showerror("Error", "NR2 requires scipy. Install with: pip install scipy")
                    self.nr2_enabled_var.set(False)
                    return
                
                from nr2 import create_nr2_processor
                self.client.nr2_enabled = True
                self.client.nr2_processor = create_nr2_processor(
                    sample_rate=self.client.sample_rate,
                    strength=strength,
                    floor=floor,
                    adapt_rate=1.0
                )
                self.log_status(f"NR2 enabled (strength={strength}%, floor={floor}%)")
            else:
                # Disable NR2
                self.client.nr2_enabled = False
                self.client.nr2_processor = None
                self.log_status("NR2 disabled")
                
        except ValueError:
            messagebox.showerror("Error", "Invalid NR2 parameter values")
            self.nr2_enabled_var.set(not enabled)
    
    def toggle_spectrum(self):
        """Toggle spectrum display visibility and connection."""
        enabled = self.spectrum_enabled_var.get()
        
        if enabled:
            # Show spectrum display
            if self.spectrum_frame:
                self.spectrum_frame.grid(row=6, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(5, 10))
                
                # Create spectrum display widget if not already created
                if not self.spectrum:
                    self.spectrum = SpectrumDisplay(self.spectrum_frame, width=780, height=200)
                    self.spectrum.set_frequency_callback(self.on_spectrum_frequency_click)
                    self.spectrum.set_frequency_step_callback(self.on_spectrum_frequency_step)
                    # Set initial step size
                    self.spectrum.set_step_size(self.get_step_size_hz())
                
                # Connect if radio is connected
                if self.connected and self.client:
                    try:
                        server = self.server_var.get()
                        frequency = self.get_frequency_hz()
                        # Pass the audio channel's user_session_id to spectrum
                        self.spectrum.connect(server, frequency, self.client.user_session_id)
                        self.log_status("Spectrum display connected")
                    except Exception as e:
                        self.log_status(f"Spectrum display error: {e}")
        else:
            # Hide spectrum display
            if self.spectrum_frame:
                self.spectrum_frame.grid_remove()
            
            # Disconnect spectrum
            if self.spectrum:
                self.spectrum.disconnect()
                self.log_status("Spectrum display disconnected")
    
    def on_spectrum_frequency_click(self, frequency: float):
        """Handle frequency click from spectrum display.
        
        Args:
            frequency: New frequency in Hz
        """
        # Update frequency display
        self.set_frequency_hz(int(frequency))
        
        # Apply frequency change if connected
        if self.connected:
            self.apply_frequency()
    
    def on_spectrum_frequency_step(self, direction: int):
        """Handle frequency step from spectrum mouse wheel.
        
        Args:
            direction: +1 for step up, -1 for step down
        """
        try:
            current_hz = self.get_frequency_hz()
            step_hz = self.get_step_size_hz()
            
            if direction > 0:
                # Step up
                new_hz = ((current_hz // step_hz) + 1) * step_hz
            else:
                # Step down
                new_hz = ((current_hz - 1) // step_hz) * step_hz
            
            # Update display
            self.set_frequency_hz(new_hz)
            
            # Apply immediately if connected
            if self.connected:
                self.apply_frequency()
        except ValueError:
            pass

    def open_waterfall_window(self):
        """Open a separate waterfall display window."""
        # Don't open multiple windows
        if self.waterfall_window and self.waterfall_window.winfo_exists():
            self.waterfall_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        if not self.spectrum:
            messagebox.showerror("Error", "Spectrum display not available")
            return

        try:
            from waterfall_display import create_waterfall_window

            # Create waterfall window (shares spectrum's data)
            self.waterfall_window, self.waterfall_display = create_waterfall_window(self)

            self.log_status("Waterfall window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open waterfall: {e}")
            self.log_status(f"ERROR: Failed to open waterfall - {e}")

    def adjust_bandwidth_for_mode(self, mode: str):
        """Set bandwidth defaults based on mode (matching web application behavior)."""
        # Default bandwidth values for each mode (from static/app.js setMode function lines 2556-2606)
        mode_defaults = {
            'usb': (50, 2700),
            'lsb': (-2700, -50),
            'am': (-5000, 5000),
            'sam': (-5000, 5000),
            'cwu': (-200, 200),
            'cwl': (-200, 200),
            'fm': (-8000, 8000),
            'nfm': (-5000, 5000)
        }

        # Get defaults for current mode
        if mode in mode_defaults:
            low, high = mode_defaults[mode]
            self.bw_low_var.set(str(low))
            self.bw_high_var.set(str(high))

            # Update spectrum display bandwidth visualization
            if self.spectrum:
                self.spectrum.update_bandwidth(low, high)

            # Update waterfall display bandwidth visualization
            if self.waterfall_display:
                self.waterfall_display.update_bandwidth(low, high)

            # Only update client if it exists (connected)
            if self.client:
                self.client.bandwidth_low = low
                self.client.bandwidth_high = high
            self.log_status(f"Bandwidth set for {mode.upper()}: {low} to {high} Hz")
        else:
            # Unknown mode - keep current bandwidth
            self.log_status(f"Unknown mode {mode.upper()} - keeping current bandwidth")
    
    def update_preset_buttons(self):
        """Update bandwidth preset buttons based on current mode."""
        # Clear existing preset buttons
        for btn in self.preset_buttons:
            btn.destroy()
        self.preset_buttons.clear()
        
        mode = self.mode_var.get().lower()
        
        # Define mode-specific presets
        mode_presets = {
            'usb': [
                ("Narrow", 200, 2400),
                ("Medium", 50, 2700),
                ("Wide", 50, 3500),
            ],
            'lsb': [
                ("Narrow", -2400, -200),
                ("Medium", -2700, -50),
                ("Wide", -3500, -50),
            ],
            'am': [
                ("Narrow", -3000, 3000),
                ("Medium", -5000, 5000),
                ("Wide", -6000, 6000),
            ],
            'sam': [
                ("Narrow", -3000, 3000),
                ("Medium", -5000, 5000),
                ("Wide", -6000, 6000),
            ],
            'cwu': [
                ("Narrow", -100, 100),
                ("Medium", -200, 200),
                ("Wide", -300, 300),
            ],
            'cwl': [
                ("Narrow", -100, 100),
                ("Medium", -200, 200),
                ("Wide", -300, 300),
            ],
            'fm': [
                ("Narrow", -6000, 6000),
                ("Medium", -8000, 8000),
                ("Wide", -10000, 10000),
            ],
            'nfm': [
                ("Narrow", -3000, 3000),
                ("Medium", -5000, 5000),
                ("Wide", -6000, 6000),
            ],
        }
        
        # Get presets for current mode (default to USB if unknown)
        presets = mode_presets.get(mode, mode_presets['usb'])
        
        # Create new preset buttons
        for i, (label, low, high) in enumerate(presets):
            btn = ttk.Button(self.preset_frame, text=label, width=8,
                           command=lambda l=low, h=high: self.set_bandwidth(l, h))
            btn.grid(row=0, column=i+1, padx=2)
            self.preset_buttons.append(btn)
    
    def send_tune_message(self):
        """Send tune message to change frequency/mode/bandwidth without reconnecting."""
        if not self.client or not self.client.ws:
            self.log_status("ERROR: Not connected - cannot send tune message")
            return
        
        try:
            import json
            tune_msg = {
                'type': 'tune',
                'frequency': self.client.frequency,
                'mode': self.client.mode,
                'bandwidthLow': self.client.bandwidth_low,
                'bandwidthHigh': self.client.bandwidth_high
            }
            
            # Send the tune message via WebSocket using the async event loop
            if self.event_loop and self.event_loop.is_running():
                # Schedule the coroutine in the client's event loop
                future = asyncio.run_coroutine_threadsafe(
                    self.client.ws.send(json.dumps(tune_msg)),
                    self.event_loop
                )
                # Wait for completion with timeout
                future.result(timeout=2.0)
                
                self.log_status(f"Sent tune: {self.client.frequency/1e6:.3f} MHz {self.client.mode.upper()} ({self.client.bandwidth_low} to {self.client.bandwidth_high} Hz)")
            else:
                self.log_status("ERROR: Event loop not running")
        except Exception as e:
            self.log_status(f"ERROR: Failed to send tune message: {e}")
    
    def reconnect_client(self):
        """Reconnect client with new settings (fallback method)."""
        if self.client:
            self.client.running = False
            # Client will reconnect automatically in the thread
    
    def toggle_connection(self):
        """Connect or disconnect the client."""
        if not self.connected:
            self.connect()
        else:
            self.disconnect()
    
    def connect(self):
        """Start the radio client connection."""
        try:
            # Import RadioClient here to avoid circular import issues
            from radio_client import RadioClient
            
            # Parse server input
            server = self.server_var.get()
            if '://' in server:
                url = server
                host = None
                port = None
            else:
                url = None
                if ':' in server:
                    host, port_str = server.split(':', 1)
                    port = int(port_str)
                else:
                    host = server
                    port = 8080
            
            # Get frequency and mode
            frequency = self.get_frequency_hz()
            mode = self.mode_var.get().lower()
            
            # Get bandwidth
            try:
                bandwidth_low = int(self.bw_low_var.get())
                bandwidth_high = int(self.bw_high_var.get())
            except ValueError:
                bandwidth_low = None
                bandwidth_high = None
            
            # Get volume and channel settings from GUI
            volume = self.volume_var.get() / 100.0  # Convert percentage to gain
            channel_left = self.channel_left_var.get()
            channel_right = self.channel_right_var.get()
            
            # Create client (disable auto_reconnect for GUI - we'll handle retries)
            self.client = RadioClient(
                url=url,
                host=host,
                port=port,
                frequency=frequency,
                mode=mode,
                bandwidth_low=bandwidth_low,
                bandwidth_high=bandwidth_high,
                output_mode='pipewire',
                auto_reconnect=False,  # GUI handles connection attempts
                status_callback=lambda msg_type, msg: self.status_queue.put((msg_type, msg)),
                volume=volume,
                channel_left=channel_left,
                channel_right=channel_right,
                audio_level_callback=lambda level_db: self.audio_level_queue.put(level_db),
                recording_callback=self.add_recording_frame,
                ssl=self.tls_var.get()  # Use TLS if checkbox is checked
            )
            
            # Set connection timeout and retry parameters
            self.connection_attempts = 0
            self.max_connection_attempts = 3
            self.connection_timeout = 30  # seconds per attempt (increased for slower connections)
            
            # Reset cancel flag
            self.cancel_connection = False
            self.connecting = True
            
            # Start client in separate thread
            self.client_thread = threading.Thread(target=self.run_client, daemon=True)
            self.client_thread.start()
            
            # Update UI to show "Connecting..." state with Cancel button
            self.connect_btn.config(text="Connecting...", state='disabled')
            self.cancel_btn.grid()  # Show cancel button
            
            # Disable device selection while connecting/connected
            self.device_combo.config(state='disabled')
            self.refresh_devices_btn.config(state='disabled')
            
            # Connect spectrum display after a delay to ensure audio connection is established
            if self.spectrum and SPECTRUM_AVAILABLE:
                def connect_spectrum_delayed():
                    try:
                        # Pass the audio channel's user_session_id and TLS setting to spectrum
                        use_tls = self.tls_var.get()
                        self.spectrum.connect(server, frequency, self.client.user_session_id, use_tls=use_tls)
                        # Set tuned frequency for bandwidth filter visualization
                        self.spectrum.tuned_freq = frequency
                        self.log_status("Spectrum display connected")
                    except Exception as e:
                        self.log_status(f"Spectrum display error: {e}")
                
                # Delay spectrum connection by 2000ms (2 seconds) to allow audio connection to establish
                # and avoid rate limiting (HTTP 429)
                self.root.after(2000, connect_spectrum_delayed)
            
            self.log_status(f"Connecting to {server}...")
            
        except ValueError as e:
            messagebox.showerror("Error", f"Invalid input: {e}")
            self.log_status(f"ERROR: Invalid input - {e}")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to connect: {e}")
            self.log_status(f"ERROR: Failed to connect - {e}")
    
    def cancel_connection_attempt(self):
        """Cancel an in-progress connection attempt."""
        self.cancel_connection = True
        self.connecting = False
        if self.client:
            self.client.running = False
        self.log_status("Connection cancelled by user")
        
        # Update UI
        self.connect_btn.config(text="Connect", state='normal')
        self.cancel_btn.grid_remove()  # Hide cancel button
        self.apply_freq_btn.state(['disabled'])
        self.apply_bw_btn.state(['disabled'])
    
    def disconnect(self):
        """Stop the radio client connection."""
        if self.client:
            self.client.running = False
            self.log_status("Disconnecting...")
        
        # Disconnect spectrum display
        if self.spectrum:
            self.spectrum.disconnect()
            self.log_status("Spectrum display disconnected")

        # Disconnect waterfall display
        if self.waterfall_display:
            self.waterfall_display.disconnect()
            self.log_status("Waterfall display disconnected")
        
        # Update UI
        self.connected = False
        self.connect_btn.config(text="Connect")
        self.apply_freq_btn.state(['disabled'])
        self.apply_bw_btn.state(['disabled'])
        self.rec_btn.state(['disabled'])
        
        # Stop recording if active
        if self.recording:
            self.stop_recording()
        
        # Re-enable device selection
        self.device_combo.config(state='readonly')
        self.refresh_devices_btn.config(state='normal')
    
    def run_client(self):
        """Run the client in a separate thread with its own event loop."""
        # Create new event loop for this thread
        self.event_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.event_loop)
        
        attempt = 0
        max_attempts = self.max_connection_attempts
        
        while attempt < max_attempts and not self.cancel_connection:
            attempt += 1
            
            if attempt > 1:
                self.status_queue.put(("info", f"Connection attempt {attempt}/{max_attempts}..."))
            
            try:
                # Run client without timeout - it will run until disconnected
                # The connection check has its own timeout
                self.event_loop.run_until_complete(self.client.run())
                # If we get here, connection was successful and then closed normally
                self.status_queue.put(("info", "Client stopped"))
                break
                    
            except ConnectionRefusedError:
                if self.cancel_connection:
                    break
                if attempt < max_attempts:
                    self.status_queue.put(("error", f"Connection refused (attempt {attempt}/{max_attempts})"))
                else:
                    self.status_queue.put(("error", f"Connection refused - server not reachable after {max_attempts} attempts"))
                    self.status_queue.put(("connection_failed", None))
                    
            except Exception as e:
                if self.cancel_connection:
                    break
                if attempt < max_attempts:
                    self.status_queue.put(("error", f"Connection error: {e} (attempt {attempt}/{max_attempts})"))
                else:
                    self.status_queue.put(("error", f"Connection failed: {e} (after {max_attempts} attempts)"))
                    self.status_queue.put(("connection_failed", None))
        
        self.event_loop.close()
        
        # If cancelled, send cancellation message
        if self.cancel_connection:
            self.status_queue.put(("connection_cancelled", None))
        else:
            self.status_queue.put(("disconnected", None))
    
    def check_status_updates(self):
        """Check for status updates from the client thread."""
        try:
            while True:
                msg_type, msg = self.status_queue.get_nowait()
                
                if msg_type == "info":
                    self.log_status(msg)
                    # Check if this is a successful connection message
                    # Look for WebSocket connection or audio stream start
                    if any(keyword in msg.lower() for keyword in ["connected", "websocket", "receiving audio", "stream"]):
                        # Update UI to show connected state
                        self.connected = True
                        self.connecting = False
                        self.connect_btn.config(text="Disconnect", state='normal')
                        self.cancel_btn.grid_remove()  # Hide cancel button
                        self.apply_freq_btn.state(['!disabled'])
                        self.apply_bw_btn.state(['!disabled'])
                        self.rec_btn.state(['!disabled'])
                        if "✓" not in msg:  # Don't duplicate success message
                            self.log_status("✓ Successfully connected!")
                elif msg_type == "error":
                    self.log_status(f"ERROR: {msg}")
                elif msg_type == "connection_failed":
                    # Connection attempt failed
                    self.connected = False
                    self.connecting = False
                    self.connect_btn.config(text="Connect", state='normal')
                    self.cancel_btn.grid_remove()  # Hide cancel button
                    self.apply_freq_btn.state(['disabled'])
                    self.apply_bw_btn.state(['disabled'])
                    self.log_status("✗ Connection failed")
                elif msg_type == "connection_cancelled":
                    # Connection cancelled by user
                    self.connected = False
                    self.connecting = False
                    self.connect_btn.config(text="Connect", state='normal')
                    self.cancel_btn.grid_remove()  # Hide cancel button
                    self.apply_freq_btn.state(['disabled'])
                    self.apply_bw_btn.state(['disabled'])
                elif msg_type == "disconnected":
                    if self.connected:
                        self.disconnect()
                
        except queue.Empty:
            pass
        
        # Schedule next check
        self.root.after(100, self.check_status_updates)
    
    def toggle_recording(self):
        """Toggle audio recording on/off."""
        if not self.recording:
            self.start_recording()
        else:
            self.stop_recording()

    def start_recording(self):
        """Start recording audio."""
        if not self.connected or not self.client:
            messagebox.showerror("Error", "Not connected to server")
            return

        import time
        self.recording = True
        self.recording_start_time = time.time()
        self.recording_data = []

        # Update UI
        self.rec_btn.config(text="⏹ Stop")
        self.rec_status_label.config(text="Recording...")
        self.log_status("Recording started (mono, max 300s)")

        # Start recording timer check
        self.check_recording_duration()

    def stop_recording(self):
        """Stop recording and prompt to save."""
        if not self.recording:
            return

        import time
        self.recording = False
        elapsed = time.time() - self.recording_start_time if self.recording_start_time else 0

        # Update UI
        self.rec_btn.config(text="⏺ Record")
        self.rec_status_label.config(text="")

        # Check if we have data
        if not self.recording_data:
            self.log_status("Recording stopped (no data)")
            return

        self.log_status(f"Recording stopped ({elapsed:.1f}s, {len(self.recording_data)} frames)")

        # Prompt for save location
        filename = filedialog.asksaveasfilename(
            defaultextension=".wav",
            filetypes=[("WAV files", "*.wav"), ("All files", "*.*")],
            title="Save Recording As"
        )

        if filename:
            self.save_recording(filename)
        else:
            self.log_status("Recording discarded")
            self.recording_data = []

    def save_recording(self, filename: str):
        """Save recorded audio to WAV file."""
        try:
            import wave
            import numpy as np

            # Concatenate all recorded frames
            audio_data = np.concatenate(self.recording_data)

            # Open WAV file
            with wave.open(filename, 'wb') as wav_file:
                wav_file.setnchannels(1)  # Mono
                wav_file.setsampwidth(2)  # 16-bit
                wav_file.setframerate(self.client.sample_rate)

                # Convert float32 to int16
                audio_int16 = np.clip(audio_data * 32768.0, -32768, 32767).astype(np.int16)
                wav_file.writeframes(audio_int16.tobytes())

            self.log_status(f"Recording saved: {filename}")
            self.recording_data = []

        except Exception as e:
            messagebox.showerror("Error", f"Failed to save recording: {e}")
            self.log_status(f"ERROR: Failed to save recording - {e}")

    def check_recording_duration(self):
        """Check if recording has reached the time limit."""
        if not self.recording:
            return

        import time
        elapsed = time.time() - self.recording_start_time
        remaining = self.recording_max_duration - elapsed

        if remaining <= 0:
            # Time limit reached
            self.log_status(f"Recording limit reached ({self.recording_max_duration}s)")
            self.stop_recording()
        else:
            # Update status with remaining time
            self.rec_status_label.config(text=f"Recording... ({int(remaining)}s remaining)")
            # Check again in 1 second
            self.root.after(1000, self.check_recording_duration)

    def add_recording_frame(self, audio_float):
        """Add audio frame to recording buffer (called from client).

        Args:
            audio_float: Mono audio data as float32 numpy array (normalized -1.0 to 1.0)
        """
        if self.recording:
            self.recording_data.append(audio_float.copy())
    
    def on_closing(self):
        """Handle window close event."""
        if self.connected:
            self.disconnect()

        # Close waterfall window if open
        if self.waterfall_window and self.waterfall_window.winfo_exists():
            self.waterfall_window.destroy()

        # Stop recording if active
        if self.recording:
            self.stop_recording()
        
        # Wait a bit for cleanup
        self.root.after(500, self.root.destroy)


def main(config=None):
    """Main entry point for GUI mode."""
    # Use provided config or defaults
    if config is None:
        config = {
            'url': None,
            'host': 'localhost',
            'port': 8080,
            'frequency': 14074000,
            'mode': 'usb',
            'bandwidth_low': 50,      # USB defaults (positive bandwidth)
            'bandwidth_high': 2700,
            'ssl': False
        }
    
    # Create and run GUI
    root = tk.Tk()
    app = RadioGUI(root, config)
    root.mainloop()


if __name__ == '__main__':
    main()