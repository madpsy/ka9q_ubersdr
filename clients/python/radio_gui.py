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

# Import audio spectrum display
try:
    from audio_spectrum_display import create_audio_spectrum_window
    AUDIO_SPECTRUM_AVAILABLE = True
except ImportError:
    AUDIO_SPECTRUM_AVAILABLE = False
    print("Warning: Audio spectrum display not available (missing dependencies)")

# Import digital spots display
try:
    from digital_spots_display import create_digital_spots_window
    DIGITAL_SPOTS_AVAILABLE = True
except ImportError:
    DIGITAL_SPOTS_AVAILABLE = False
    print("Warning: Digital spots display not available (missing dependencies)")

# Import CW spots display
try:
    from cw_spots_display import create_cw_spots_window
    CW_SPOTS_AVAILABLE = True
except ImportError:
    CW_SPOTS_AVAILABLE = False
    print("Warning: CW spots display not available (missing dependencies)")

# Import shared WebSocket manager
try:
    from dxcluster_websocket import DXClusterWebSocket
    DXCLUSTER_WS_AVAILABLE = True
except ImportError:
    DXCLUSTER_WS_AVAILABLE = False
    print("Warning: DX cluster WebSocket not available (missing dependencies)")

# Check if NR2 is available
try:
    from nr2 import create_nr2_processor
    NR2_AVAILABLE = True
except ImportError:
    NR2_AVAILABLE = False

# Check if scipy is available (for audio filter)
try:
    from scipy import signal as scipy_signal
    SCIPY_AVAILABLE = True
except ImportError:
    SCIPY_AVAILABLE = False


def find_next_fifo_path() -> str:
    """Find the next available FIFO path (/tmp/ubersdr.fifo, ubersdr1.fifo, etc.)."""
    import os

    # Try /tmp/ubersdr.fifo first
    base_path = "/tmp/ubersdr"
    if not os.path.exists(f"{base_path}.fifo"):
        return f"{base_path}.fifo"

    # Try numbered versions
    for i in range(1, 100):
        path = f"{base_path}{i}.fifo"
        if not os.path.exists(path):
            return path

    # Fallback if all are taken
    return f"{base_path}99.fifo"


class RadioGUI:
    """Tkinter-based GUI for the radio client."""
    
    # Band frequency ranges (in Hz) - UK RSGB allocations (from static/app.js)
    BAND_RANGES = {
        '160m': {'min': 1810000, 'max': 2000000},
        '80m': {'min': 3500000, 'max': 3800000},
        '60m': {'min': 5258500, 'max': 5406500},
        '40m': {'min': 7000000, 'max': 7200000},
        '30m': {'min': 10100000, 'max': 10150000},
        '20m': {'min': 14000000, 'max': 14350000},
        '17m': {'min': 18068000, 'max': 18168000},
        '15m': {'min': 21000000, 'max': 21450000},
        '12m': {'min': 24890000, 'max': 24990000},
        '10m': {'min': 28000000, 'max': 29700000}
    }
    
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
        
        # Band buttons dictionary for highlighting
        self.band_buttons = {}
        
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
        
        # Audio spectrum display (separate window)
        self.audio_spectrum_window = None
        self.audio_spectrum_display = None

        # Shared DX cluster WebSocket manager
        self.dxcluster_ws = None
        
        # Digital spots display (separate window)
        self.digital_spots_window = None
        self.digital_spots_display = None
        
        # CW spots display (separate window)
        self.cw_spots_window = None
        self.cw_spots_display = None
        
        # Create UI
        self.create_widgets()
        
        # Start status update checker
        self.check_status_updates()
        
        # Handle window close
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)

        # Auto-connect if requested (after UI is ready)
        if self.config.get('auto_connect', False):
            self.root.after(100, self.connect)  # Delay slightly to ensure UI is fully initialized
    
    def create_widgets(self):
        """Create all GUI widgets."""
        # Configure custom style for active band buttons
        style = ttk.Style()
        style.configure('Active.TButton', background='green', foreground='white')
        
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
        
        # Receiver name label (second row, initially hidden)
        ttk.Label(conn_frame, text="Receiver:").grid(row=1, column=0, sticky=tk.W, padx=(0, 5))
        self.receiver_name_var = tk.StringVar(value="")
        self.receiver_name_label = ttk.Label(conn_frame, textvariable=self.receiver_name_var, foreground='blue')
        self.receiver_name_label.grid(row=1, column=1, columnspan=4, sticky=tk.W)
        self.receiver_name_label.grid_remove()  # Hide initially until connected
        
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
            # Store button reference for highlighting
            self.band_buttons[label] = btn
        
        # Initialize band button highlighting with current frequency
        try:
            initial_freq_hz = self.get_frequency_hz()
            self.update_band_buttons(initial_freq_hz)
        except ValueError:
            pass  # Ignore if frequency is invalid
        
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

        # FIFO path (to the right of device selector)
        ttk.Label(audio_frame, text="FIFO:").grid(row=0, column=5, sticky=tk.W, padx=(20, 5))

        self.fifo_var = tk.StringVar(value=find_next_fifo_path())
        self.fifo_entry = ttk.Entry(audio_frame, textvariable=self.fifo_var, width=25)
        self.fifo_entry.grid(row=0, column=6, sticky=(tk.W, tk.E), padx=(0, 5))

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

        # Audio bandpass filter (row 4) - use a frame to avoid column weight issues
        filter_container = ttk.Frame(audio_frame)
        filter_container.grid(row=4, column=0, columnspan=7, sticky=(tk.W, tk.E), pady=(5, 0))

        self.audio_filter_enabled_var = tk.BooleanVar(value=False)
        filter_check = ttk.Checkbutton(filter_container, text="Enable Audio Filter", variable=self.audio_filter_enabled_var,
                                       command=self.toggle_audio_filter)
        filter_check.grid(row=0, column=0, sticky=tk.W, padx=(0, 20))

        # Low frequency slider (will be updated based on mode)
        ttk.Label(filter_container, text="Low:").grid(row=0, column=1, sticky=tk.W, padx=(0, 5))
        self.audio_filter_low_var = tk.IntVar(value=300)
        self.filter_low_scale = ttk.Scale(filter_container, from_=50, to=3000, orient=tk.HORIZONTAL,
                                          variable=self.audio_filter_low_var, command=self.update_audio_filter_display,
                                          length=150)
        self.filter_low_scale.grid(row=0, column=2, sticky=(tk.W, tk.E), padx=(0, 5))

        self.audio_filter_low_label = ttk.Label(filter_container, text="300 Hz", width=8)
        self.audio_filter_low_label.grid(row=0, column=3, sticky=tk.W, padx=(0, 20))

        # High frequency slider (will be updated based on mode)
        ttk.Label(filter_container, text="High:").grid(row=0, column=4, sticky=tk.W, padx=(0, 5))
        self.audio_filter_high_var = tk.IntVar(value=2700)
        self.filter_high_scale = ttk.Scale(filter_container, from_=100, to=6000, orient=tk.HORIZONTAL,
                                           variable=self.audio_filter_high_var, command=self.update_audio_filter_display,
                                           length=150)
        self.filter_high_scale.grid(row=0, column=5, sticky=(tk.W, tk.E), padx=(0, 5))

        self.audio_filter_high_label = ttk.Label(filter_container, text="2700 Hz", width=8)
        self.audio_filter_high_label.grid(row=0, column=6, sticky=tk.W)

        filter_container.columnconfigure(2, weight=1)
        filter_container.columnconfigure(5, weight=1)

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

            # Add waterfall and audio spectrum buttons, plus scroll mode selector
            button_frame = ttk.Frame(spectrum_frame)
            button_frame.pack(side=tk.TOP, pady=(0, 5))
            
            if WATERFALL_AVAILABLE:
                waterfall_btn = ttk.Button(button_frame, text="Open Waterfall",
                                          command=self.open_waterfall_window)
                waterfall_btn.pack(side=tk.LEFT, padx=(0, 5))
            
            if AUDIO_SPECTRUM_AVAILABLE:
                audio_btn = ttk.Button(button_frame, text="Open Audio",
                                      command=self.open_audio_spectrum_window)
                audio_btn.pack(side=tk.LEFT, padx=(0, 5))

            # Digital spots button (conditionally shown based on server capability)
            if DIGITAL_SPOTS_AVAILABLE:
                self.digital_spots_btn = ttk.Button(button_frame, text="Open Digital Spots",
                                      command=self.open_digital_spots_window)
                # Don't pack yet - will be shown after connection if server supports it
            else:
                self.digital_spots_btn = None
            
            # CW spots button (conditionally shown based on server capability)
            if CW_SPOTS_AVAILABLE:
                self.cw_spots_btn = ttk.Button(button_frame, text="Open CW Spots",
                                         command=self.open_cw_spots_window)
                # Don't pack yet - will be shown after connection if server supports it
            else:
                self.cw_spots_btn = None
            
            # Scroll mode selector (zoom vs pan) - always at the end
            ttk.Label(button_frame, text="Scroll:").pack(side=tk.LEFT, padx=(15, 5))
            
            self.scroll_mode_var = tk.StringVar(value="zoom")
            zoom_radio = ttk.Radiobutton(button_frame, text="Zoom", variable=self.scroll_mode_var,
                                        value="zoom", command=self.on_scroll_mode_changed)
            zoom_radio.pack(side=tk.LEFT, padx=(0, 5))
            
            pan_radio = ttk.Radiobutton(button_frame, text="Pan", variable=self.scroll_mode_var,
                                       value="pan", command=self.on_scroll_mode_changed)
            pan_radio.pack(side=tk.LEFT)

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
        
        # Update band button highlighting
        self.update_band_buttons(freq_hz)
        
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

        # Update audio spectrum display bandwidth
        if self.audio_spectrum_display:
            self.audio_spectrum_display.update_bandwidth(low, high)
        
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
        
        # Update band button highlighting
        self.update_band_buttons(freq_hz)
    
    def update_band_buttons(self, freq_hz: int):
        """Update band button highlighting based on current frequency.
        
        Args:
            freq_hz: Current frequency in Hz
        """
        current_band = None
        
        for band_name, button in self.band_buttons.items():
            if band_name in self.BAND_RANGES:
                band_range = self.BAND_RANGES[band_name]
                if band_range['min'] <= freq_hz <= band_range['max']:
                    # Frequency is within this band - highlight with green background and white text
                    button.configure(style='Active.TButton')
                    current_band = band_name
                else:
                    # Frequency is outside this band - use default style
                    button.configure(style='TButton')
        
        # Update band filter in digital spots window if open
        if self.digital_spots_display and current_band:
            self.digital_spots_display.band_filter.set(current_band)
            self.digital_spots_display.apply_filters()
        
        # Update band filter in CW spots window if open
        if self.cw_spots_display and current_band:
            self.cw_spots_display.band_var.set(current_band)
            self.cw_spots_display.apply_filters()
    
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

        # Update audio filter slider ranges based on mode bandwidth
        self.update_audio_filter_ranges()

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

            # Update audio spectrum display if open
            if self.audio_spectrum_display:
                self.audio_spectrum_display.update_bandwidth(low, high)
            
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

    def update_audio_filter_ranges(self):
        """Update audio filter slider ranges based on current mode bandwidth."""
        try:
            # Get current bandwidth
            low = int(self.bw_low_var.get())
            high = int(self.bw_high_var.get())

            # Check if this is CW mode (narrow symmetric bandwidth)
            abs_low = abs(low)
            abs_high = abs(high)
            is_cw_mode = (low < 0 and high > 0 and abs_low < 500 and abs_high < 500)

            if is_cw_mode:
                # CW mode: audio is centered at 500 Hz due to pitch offset
                # Bandwidth -200 to +200 means audio is at 300-700 Hz
                cw_offset = 500
                margin = 0.1

                # Calculate actual audio frequency range
                audio_low = cw_offset - abs_low
                audio_high = cw_offset + abs_high

                # Both sliders should have the same full range to allow narrow filters
                range_min = max(0, int(audio_low * (1 - margin)))
                range_max = int(audio_high * (1 + margin))
            else:
                # Non-CW modes: use absolute bandwidth values
                margin = 0.1
                range_min = max(0, int(abs_low * (1 - margin)))
                range_max = int(abs_high * (1 + margin))

            # Update both slider ranges to the same full range
            self.filter_low_scale.config(from_=range_min, to=range_max)
            self.filter_high_scale.config(from_=range_min, to=range_max)

            # Adjust current values if they're outside the new range
            current_low = self.audio_filter_low_var.get()
            current_high = self.audio_filter_high_var.get()

            if current_low < range_min:
                self.audio_filter_low_var.set(range_min)
            elif current_low > range_max:
                self.audio_filter_low_var.set(range_max)

            if current_high < range_min:
                self.audio_filter_high_var.set(range_min)
            elif current_high > range_max:
                self.audio_filter_high_var.set(range_max)

        except ValueError:
            # If bandwidth values are invalid, use defaults
            pass

    def update_audio_filter_display(self, value=None):
        """Update audio filter frequency labels and apply filter dynamically."""
        low = int(self.audio_filter_low_var.get())
        high = int(self.audio_filter_high_var.get())

        # Update labels
        self.audio_filter_low_label.config(text=f"{low} Hz")
        self.audio_filter_high_label.config(text=f"{high} Hz")

        # Update audio spectrum display if open
        if self.audio_spectrum_display:
            enabled = self.audio_filter_enabled_var.get()
            self.audio_spectrum_display.update_audio_filter(enabled, low, high)

        # Apply filter dynamically if enabled and connected
        if self.connected and self.client and self.audio_filter_enabled_var.get():
            # Validate before applying
            if low < high:
                self.client.update_audio_filter(float(low), float(high))

    def toggle_audio_filter(self):
        """Toggle audio bandpass filter on/off."""
        if not self.connected or not self.client:
            return

        enabled = self.audio_filter_enabled_var.get()

        try:
            # If enabling, first ensure values are within current mode's bandwidth range
            if enabled:
                # Get current bandwidth
                bw_low = int(self.bw_low_var.get())
                bw_high = int(self.bw_high_var.get())
                abs_low = abs(bw_low)
                abs_high = abs(bw_high)
                
                # Check if this is CW mode
                is_cw_mode = (bw_low < 0 and bw_high > 0 and abs_low < 500 and abs_high < 500)
                
                if is_cw_mode:
                    # CW mode: audio is centered at 500 Hz
                    # Set filter to 80% of the audio bandwidth around 500 Hz
                    cw_offset = 500
                    audio_low = cw_offset - abs_low
                    audio_high = cw_offset + abs_high
                    
                    # Use 80% of the range
                    range_span = audio_high - audio_low
                    margin = range_span * 0.1
                    default_low = int(audio_low + margin)
                    default_high = int(audio_high - margin)
                else:
                    # Non-CW modes: use absolute bandwidth values
                    # Use 80% of the bandwidth range
                    margin = 0.1
                    default_low = int(abs_low * (1 + margin))
                    default_high = int(abs_high * (1 - margin))
                    
                    # Ensure low < high
                    if default_low >= default_high:
                        default_low = int(abs_low)
                        default_high = int(abs_high)
                
                # Update slider values to reasonable defaults
                self.audio_filter_low_var.set(default_low)
                self.audio_filter_high_var.set(default_high)
                
                # Update display
                self.update_audio_filter_display()
            
            low = float(self.audio_filter_low_var.get())
            high = float(self.audio_filter_high_var.get())

            # Validate parameters
            if low <= 0 or high <= 0:
                messagebox.showerror("Error", "Filter frequencies must be positive")
                self.audio_filter_enabled_var.set(not enabled)
                return
            if low >= high:
                messagebox.showerror("Error", "Low frequency must be less than high frequency")
                self.audio_filter_enabled_var.set(not enabled)
                return

            if enabled:
                # Enable audio filter
                if not SCIPY_AVAILABLE:
                    messagebox.showerror("Error", "Audio filter requires scipy. Install with: pip install scipy")
                    self.audio_filter_enabled_var.set(False)
                    return

                self.client.audio_filter_enabled = True
                self.client.audio_filter_low = low
                self.client.audio_filter_high = high
                self.client._init_audio_filter()
                self.log_status(f"Audio filter enabled ({low:.0f}-{high:.0f} Hz)")
            else:
                # Disable audio filter
                self.client.audio_filter_enabled = False
                self.log_status("Audio filter disabled")

            # Update audio spectrum display
            if self.audio_spectrum_display:
                self.audio_spectrum_display.update_audio_filter(enabled, low, high)

        except ValueError:
            messagebox.showerror("Error", "Invalid audio filter parameter values")
            self.audio_filter_enabled_var.set(not enabled)

    def apply_audio_filter(self):
        """Apply audio filter parameter changes."""
        if not self.connected or not self.client:
            return

        if not self.audio_filter_enabled_var.get():
            messagebox.showinfo("Info", "Audio filter is not enabled")
            return

        try:
            low = float(self.audio_filter_low_var.get())
            high = float(self.audio_filter_high_var.get())

            # Validate parameters
            if low <= 0 or high <= 0:
                messagebox.showerror("Error", "Filter frequencies must be positive")
                return
            if low >= high:
                messagebox.showerror("Error", "Low frequency must be less than high frequency")
                return

            # Update filter
            self.client.update_audio_filter(low, high)
            self.log_status(f"Audio filter updated ({low:.0f}-{high:.0f} Hz)")

        except ValueError:
            messagebox.showerror("Error", "Invalid audio filter parameter values")

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
    
    def on_scroll_mode_changed(self):
        """Handle scroll mode change (zoom vs pan)."""
        mode = self.scroll_mode_var.get()
        
        # Update spectrum display scroll mode
        if self.spectrum:
            self.spectrum.set_scroll_mode(mode)
        
        # Update waterfall display scroll mode
        if self.waterfall_display:
            self.waterfall_display.set_scroll_mode(mode)
        
        self.log_status(f"Scroll mode: {mode}")

    def auto_open_waterfall(self):
        """Automatically open waterfall window on connection (no error dialogs)."""
        # Don't open multiple windows
        if self.waterfall_window and self.waterfall_window.winfo_exists():
            return

        if not self.connected or not self.spectrum:
            return

        try:
            from waterfall_display import create_waterfall_window

            # Create waterfall window (shares spectrum's data)
            self.waterfall_window, self.waterfall_display = create_waterfall_window(self)

            self.log_status("Waterfall window opened automatically")

        except Exception as e:
            # Silent failure for auto-open (user can manually open if needed)
            self.log_status(f"Note: Waterfall auto-open failed - {e}")

    def auto_open_audio_spectrum(self):
        """Automatically open audio spectrum window on connection (no error dialogs)."""
        # Don't open multiple windows
        if self.audio_spectrum_window and self.audio_spectrum_window.winfo_exists():
            return

        if not self.connected:
            return

        try:
            from audio_spectrum_display import create_audio_spectrum_window

            # Create audio spectrum window
            self.audio_spectrum_window, self.audio_spectrum_display = create_audio_spectrum_window(self)

            self.log_status("Audio spectrum window opened automatically")

        except Exception as e:
            # Silent failure for auto-open (user can manually open if needed)
            self.log_status(f"Note: Audio spectrum auto-open failed - {e}")

    def auto_open_digital_spots(self):
        """Automatically open digital spots window on connection (no error dialogs)."""
        # Don't open multiple windows
        if self.digital_spots_window and self.digital_spots_window.winfo_exists():
            return

        if not self.connected:
            return

        try:
            # Ensure shared WebSocket is connected
            ws_manager = self._ensure_dxcluster_ws()

            from digital_spots_display import create_digital_spots_window

            # Get countries list from client
            countries = self.client.countries if self.client and hasattr(self.client, 'countries') else []

            # Create digital spots window with shared WebSocket and countries
            self.digital_spots_display = create_digital_spots_window(
                ws_manager,
                on_close=self._on_digital_spots_closed,
                countries=countries
            )
            self.digital_spots_window = self.digital_spots_display.window
            
            # Set initial band filter to current band if one is active
            try:
                current_freq = self.get_frequency_hz()
                for band_name, band_range in self.BAND_RANGES.items():
                    if band_range['min'] <= current_freq <= band_range['max']:
                        self.digital_spots_display.band_filter.set(band_name)
                        self.digital_spots_display.apply_filters()
                        break
            except (ValueError, AttributeError):
                pass

            self.log_status("Digital spots window opened automatically")

        except Exception as e:
            # Silent failure for auto-open (user can manually open if needed)
            self.log_status(f"Note: Digital spots auto-open failed - {e}")

    def auto_open_cw_spots(self):
        """Automatically open CW spots window on connection (no error dialogs)."""
        # Don't open multiple windows
        if self.cw_spots_window and self.cw_spots_window.winfo_exists():
            return

        if not self.connected:
            return

        try:
            # Ensure shared WebSocket is connected
            ws_manager = self._ensure_dxcluster_ws()

            from cw_spots_display import create_cw_spots_window

            # Get countries list from client
            countries = self.client.countries if self.client and hasattr(self.client, 'countries') else []

            # Create CW spots window with shared WebSocket and countries
            self.cw_spots_display = create_cw_spots_window(
                ws_manager,
                on_close=self._on_cw_spots_closed,
                radio_gui=self,
                countries=countries
            )
            self.cw_spots_window = self.cw_spots_display.window
            
            # Set initial band filter to current band if one is active
            try:
                current_freq = self.get_frequency_hz()
                for band_name, band_range in self.BAND_RANGES.items():
                    if band_range['min'] <= current_freq <= band_range['max']:
                        self.cw_spots_display.band_var.set(band_name)
                        self.cw_spots_display.apply_filters()
                        break
            except (ValueError, AttributeError):
                pass

            self.log_status("CW spots window opened automatically")

        except Exception as e:
            # Silent failure for auto-open (user can manually open if needed)
            self.log_status(f"Note: CW spots auto-open failed - {e}")

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

    def open_audio_spectrum_window(self):
        """Open a separate audio spectrum display window."""
        # Don't open multiple windows
        if self.audio_spectrum_window and self.audio_spectrum_window.winfo_exists():
            self.audio_spectrum_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            from audio_spectrum_display import create_audio_spectrum_window

            # Create audio spectrum window
            self.audio_spectrum_window, self.audio_spectrum_display = create_audio_spectrum_window(self)

            self.log_status("Audio spectrum window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open audio spectrum: {e}")
            self.log_status(f"ERROR: Failed to open audio spectrum - {e}")

    def _ensure_dxcluster_ws(self):
        """Ensure shared DX cluster WebSocket is connected."""
        if not self.dxcluster_ws and DXCLUSTER_WS_AVAILABLE:
            # Create shared WebSocket manager
            server = self.server_var.get()
            use_tls = self.tls_var.get()
            
            # Parse server URL
            if '://' in server:
                # Full URL provided - convert to WebSocket URL
                ws_url = server.replace('http://', 'ws://').replace('https://', 'wss://')
                # Remove any existing path
                if '/' in ws_url.split('://', 1)[1]:
                    base = ws_url.split('/', 3)[:3]
                    ws_url = '/'.join(base)
            else:
                # Host:port format
                protocol = 'wss' if use_tls else 'ws'
                ws_url = f"{protocol}://{server}"
            
            # Get user_session_id from the radio client
            if self.client and hasattr(self.client, 'user_session_id'):
                user_session_id = self.client.user_session_id
                self.dxcluster_ws = DXClusterWebSocket(ws_url, user_session_id)
                self.dxcluster_ws.connect()
                self.log_status("DX cluster WebSocket connected")
            else:
                raise Exception("No active radio session")
        
        return self.dxcluster_ws

    def open_digital_spots_window(self):
        """Open a separate digital spots display window."""
        # Don't open multiple windows
        if self.digital_spots_window and self.digital_spots_window.winfo_exists():
            self.digital_spots_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            # Ensure shared WebSocket is connected
            ws_manager = self._ensure_dxcluster_ws()
            
            from digital_spots_display import create_digital_spots_window

            # Get countries list from client
            countries = self.client.countries if self.client and hasattr(self.client, 'countries') else []

            # Create digital spots window with shared WebSocket and countries
            self.digital_spots_display = create_digital_spots_window(
                ws_manager,
                on_close=self._on_digital_spots_closed,
                countries=countries
            )
            self.digital_spots_window = self.digital_spots_display.window
            
            # Set initial band filter to current band if one is active
            try:
                current_freq = self.get_frequency_hz()
                for band_name, band_range in self.BAND_RANGES.items():
                    if band_range['min'] <= current_freq <= band_range['max']:
                        self.digital_spots_display.band_filter.set(band_name)
                        self.digital_spots_display.apply_filters()
                        break
            except (ValueError, AttributeError):
                pass

            self.log_status("Digital spots window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open digital spots: {e}")
            self.log_status(f"ERROR: Failed to open digital spots - {e}")
    
    def _on_digital_spots_closed(self):
        """Handle digital spots window close."""
        self.digital_spots_window = None
        self.digital_spots_display = None
        self.log_status("Digital spots window closed")
    
    def open_cw_spots_window(self):
        """Open a separate CW spots display window."""
        # Don't open multiple windows
        if self.cw_spots_window and self.cw_spots_window.winfo_exists():
            self.cw_spots_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            # Ensure shared WebSocket is connected
            ws_manager = self._ensure_dxcluster_ws()
            
            from cw_spots_display import create_cw_spots_window

            # Get countries list from client
            countries = self.client.countries if self.client and hasattr(self.client, 'countries') else []

            # Create CW spots window with shared WebSocket and countries
            self.cw_spots_display = create_cw_spots_window(
                ws_manager,
                on_close=self._on_cw_spots_closed,
                radio_gui=self,
                countries=countries
            )
            self.cw_spots_window = self.cw_spots_display.window
            
            # Set initial band filter to current band if one is active
            try:
                current_freq = self.get_frequency_hz()
                for band_name, band_range in self.BAND_RANGES.items():
                    if band_range['min'] <= current_freq <= band_range['max']:
                        self.cw_spots_display.band_var.set(band_name)
                        self.cw_spots_display.apply_filters()
                        break
            except (ValueError, AttributeError):
                pass

            self.log_status("CW spots window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open CW spots: {e}")
            self.log_status(f"ERROR: Failed to open CW spots - {e}")
    
    def _on_cw_spots_closed(self):
        """Handle CW spots window close."""
        self.cw_spots_window = None
        self.cw_spots_display = None
        self.log_status("CW spots window closed")

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

            # Update audio spectrum display bandwidth
            if self.audio_spectrum_display:
                self.audio_spectrum_display.update_bandwidth(low, high)

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
            
            # Get FIFO path from GUI
            fifo_path = self.fifo_var.get().strip()
            if not fifo_path:
                fifo_path = None

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
                ssl=self.tls_var.get(),  # Use TLS if checkbox is checked
                fifo_path=fifo_path  # Pass FIFO path to client
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
            
            # Disable device selection and FIFO path while connecting/connected
            self.device_combo.config(state='disabled')
            self.refresh_devices_btn.config(state='disabled')
            self.fifo_entry.config(state='disabled')
            
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
        self.apply_filter_btn.state(['disabled'])
        
        # Hide receiver name
        self.receiver_name_label.grid_remove()
        self.receiver_name_var.set("")
        
        # Hide spots buttons
        if self.digital_spots_btn:
            self.digital_spots_btn.pack_forget()
        if self.cw_spots_btn:
            self.cw_spots_btn.pack_forget()
        
        # Stop recording if active
        if self.recording:
            self.stop_recording()
        
        # Re-enable device selection and FIFO path
        self.device_combo.config(state='readonly')
        self.refresh_devices_btn.config(state='normal')
        self.fifo_entry.config(state='normal')
    
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

                        # Update receiver name and spots buttons based on server description
                        if self.client and hasattr(self.client, 'server_description'):
                            desc = self.client.server_description
                            receiver_name = desc.get('receiver', {}).get('name', '')
                            if receiver_name:
                                self.receiver_name_var.set(receiver_name)
                                self.receiver_name_label.grid()  # Show receiver name
                            
                            # Show spots buttons based on server capabilities
                            # Pack them before the Scroll label by using pack with before parameter
                            # Find the Scroll label widget to insert before it
                            button_frame = self.digital_spots_btn.master if self.digital_spots_btn else (self.cw_spots_btn.master if self.cw_spots_btn else None)
                            if button_frame:
                                # Find the "Scroll:" label widget
                                scroll_label = None
                                for widget in button_frame.winfo_children():
                                    if isinstance(widget, ttk.Label) and widget.cget('text') == 'Scroll:':
                                        scroll_label = widget
                                        break
                                
                                # Pack digital spots button if enabled
                                if self.digital_spots_btn and desc.get('digital_decodes', False):
                                    if scroll_label:
                                        self.digital_spots_btn.pack(side=tk.LEFT, padx=(0, 5), before=scroll_label)
                                    else:
                                        self.digital_spots_btn.pack(side=tk.LEFT, padx=(0, 5))
                                elif self.digital_spots_btn:
                                    self.digital_spots_btn.pack_forget()
                                
                                # Pack CW spots button if enabled
                                if self.cw_spots_btn and desc.get('cw_skimmer', False):
                                    if scroll_label:
                                        self.cw_spots_btn.pack(side=tk.LEFT, padx=(0, 5), before=scroll_label)
                                    else:
                                        self.cw_spots_btn.pack(side=tk.LEFT, padx=(0, 5))
                                elif self.cw_spots_btn:
                                    self.cw_spots_btn.pack_forget()

                        # Auto-open waterfall window on successful connection
                        if WATERFALL_AVAILABLE and self.spectrum:
                            # Delay waterfall opening slightly to ensure spectrum is connected
                            self.root.after(500, self.auto_open_waterfall)
                        
                        # Auto-open audio spectrum window on successful connection
                        if AUDIO_SPECTRUM_AVAILABLE:
                            # Delay audio spectrum opening slightly
                            self.root.after(600, self.auto_open_audio_spectrum)
                        
                        # Auto-open digital spots window if enabled
                        # Add 2000ms delay (same as spectrum) before connecting DX cluster WebSocket
                        if self.client and hasattr(self.client, 'server_description'):
                            desc = self.client.server_description
                            if DIGITAL_SPOTS_AVAILABLE and desc.get('digital_decodes', False):
                                self.root.after(2700, self.auto_open_digital_spots)
                            
                            # Auto-open CW spots window if enabled
                            # Add 2000ms delay (same as spectrum) before connecting DX cluster WebSocket
                            if CW_SPOTS_AVAILABLE and desc.get('cw_skimmer', False):
                                self.root.after(2800, self.auto_open_cw_spots)
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

        # Also send to audio spectrum display if open
        if self.audio_spectrum_display:
            self.audio_spectrum_display.add_audio_data(audio_float)
    
    def on_closing(self):
        """Handle window close event."""
        if self.connected:
            self.disconnect()

        # Close waterfall window if open
        if self.waterfall_window and self.waterfall_window.winfo_exists():
            self.waterfall_window.destroy()

        # Close audio spectrum window if open
        if self.audio_spectrum_window and self.audio_spectrum_window.winfo_exists():
            self.audio_spectrum_window.destroy()

        # Close digital spots window if open
        if self.digital_spots_window and self.digital_spots_window.winfo_exists():
            self.digital_spots_window.destroy()
        
        # Close CW spots window if open
        if self.cw_spots_window and self.cw_spots_window.winfo_exists():
            self.cw_spots_window.destroy()
        
        # Disconnect shared DX cluster WebSocket
        if self.dxcluster_ws:
            self.dxcluster_ws.disconnect()
            self.dxcluster_ws = None

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