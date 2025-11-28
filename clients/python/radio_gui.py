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
from typing import Optional, List, Tuple, Dict
import queue
import socket
import requests
import time

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

# Import band conditions display
try:
    from band_conditions_display import create_band_conditions_window
    BAND_CONDITIONS_AVAILABLE = True
except ImportError:
    BAND_CONDITIONS_AVAILABLE = False
    print("Warning: Band conditions display not available (missing dependencies)")

# Import space weather display
try:
    from space_weather_display import create_space_weather_window
    SPACE_WEATHER_AVAILABLE = True
except ImportError:
    SPACE_WEATHER_AVAILABLE = False
    print("Warning: Space weather display not available (missing dependencies)")

# Import EQ display
try:
    from eq_display import create_eq_window
    EQ_AVAILABLE = True
except ImportError:
    EQ_AVAILABLE = False
    print("Warning: EQ display not available (missing dependencies)")

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


# Import rigctl client
try:
    from rigctl import RigctlClient
    RIGCTL_AVAILABLE = True
except ImportError:
    RIGCTL_AVAILABLE = False
    print("Warning: rigctl module not available")


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

    # SNR thresholds for band status (matching static/bands_state.js)
    SNR_THRESHOLDS = {
        'POOR': 6,      # SNR < 6 dB
        'FAIR': 20,     # 6 <= SNR < 20 dB
        'GOOD': 30,     # 20 <= SNR < 30 dB
        'EXCELLENT': 30 # SNR >= 30 dB
    }

    # Colors for band status (matching static/style.css)
    BAND_COLORS = {
        'POOR': '#ef4444',      # Red
        'FAIR': '#ff9800',      # Orange
        'GOOD': '#fbbf24',      # Yellow/Amber
        'EXCELLENT': '#22c55e', # Green
        'UNKNOWN': '#22c55e'    # Green (default when no data, same as EXCELLENT)
    }

    def __init__(self, root: tk.Tk, initial_config: dict):
        self.root = root
        self.root.title("Radio Client")
        self.root.geometry("800x920")  # Increased height for mode buttons and band buttons
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
        self.bypassed = False  # Track if connection is bypassed (allows higher IQ bandwidths)
        self.max_session_time = 0  # Maximum session time in seconds (0 = unlimited)
        self.connection_start_time = None  # Time when connection was established
        self.session_timer_job = None  # Timer job for updating session countdown
        self.bandwidth_update_job = None  # Debounce timer for bandwidth updates
        self.last_mode = None  # Track last mode to detect actual mode changes

        # Rigctl client
        self.rigctl: Optional[RigctlClient] = None
        self.rigctl_connected = False
        self.rigctl_sync_enabled = False
        self.rigctl_poll_job = None  # For Rig→SDR polling
        self.rigctl_last_freq = None  # Track last known rig frequency
        self.rigctl_last_mode = None  # Track last known rig mode

        # Band buttons dictionary for highlighting
        self.band_buttons = {}

        # Band state monitoring
        self.band_states: Dict[str, str] = {}  # band_name -> status
        self.band_state_poll_job = None
        self.last_band_state_update = 0

        # Bookmarks
        self.bookmarks: List[Dict] = []  # List of bookmark dictionaries

        # Bands (fetched from server)
        self.bands: List[Dict] = []  # List of band dictionaries from /api/bands

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

        # Band conditions display (separate window)
        self.band_conditions_window = None
        self.band_conditions_display = None

        # Space weather display (separate window)
        self.space_weather_window = None
        self.space_weather_display = None

        # EQ display (separate window)
        self.eq_window = None
        self.eq_display = None

        # MIDI controller (separate window)
        self.midi_window = None
        self.midi_controller = None

        # Create UI
        self.create_widgets()

        # Start status update checker
        self.check_status_updates()

        # Handle window close
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)

        # Auto-initialize MIDI controller if mappings exist (after UI is ready)
        self.root.after(100, self.auto_init_midi)

        # Fetch bookmarks on startup (after UI is ready)
        self.root.after(200, self.fetch_bookmarks)

        # Fetch bands on startup (after UI is ready)
        self.root.after(250, self.fetch_bands)

        # Auto-connect if requested (after UI is ready)
        if self.config.get('auto_connect', False):
            self.root.after(100, self.connect)  # Delay slightly to ensure UI is fully initialized

    def create_widgets(self):
        """Create all GUI widgets."""
        # Configure custom styles for band buttons
        style = ttk.Style()

        # Status-based styles (background colors based on SNR, white bold text)
        style.configure('Poor.TButton', background=self.BAND_COLORS['POOR'], foreground='white', font=('TkDefaultFont', 9, 'bold'))
        style.configure('Fair.TButton', background=self.BAND_COLORS['FAIR'], foreground='white', font=('TkDefaultFont', 9, 'bold'))
        style.configure('Good.TButton', background=self.BAND_COLORS['GOOD'], foreground='white', font=('TkDefaultFont', 9, 'bold'))
        style.configure('Excellent.TButton', background=self.BAND_COLORS['EXCELLENT'], foreground='white', font=('TkDefaultFont', 9, 'bold'))
        style.configure('Unknown.TButton', background=self.BAND_COLORS['UNKNOWN'], foreground='white', font=('TkDefaultFont', 9, 'bold'))

        # Hover styles (raised relief to "pop out")
        style.map('Poor.TButton', background=[('active', self.BAND_COLORS['POOR'])], relief=[('active', 'raised')])
        style.map('Fair.TButton', background=[('active', self.BAND_COLORS['FAIR'])], relief=[('active', 'raised')])
        style.map('Good.TButton', background=[('active', self.BAND_COLORS['GOOD'])], relief=[('active', 'raised')])
        style.map('Excellent.TButton', background=[('active', self.BAND_COLORS['EXCELLENT'])], relief=[('active', 'raised')])
        style.map('Unknown.TButton', background=[('active', self.BAND_COLORS['UNKNOWN'])], relief=[('active', 'raised')])

        # Active styles (with border for active band, white bold text)
        style.configure('Poor.Active.TButton', background=self.BAND_COLORS['POOR'], foreground='white', font=('TkDefaultFont', 9, 'bold'), relief='solid', borderwidth=3)
        style.configure('Fair.Active.TButton', background=self.BAND_COLORS['FAIR'], foreground='white', font=('TkDefaultFont', 9, 'bold'), relief='solid', borderwidth=3)
        style.configure('Good.Active.TButton', background=self.BAND_COLORS['GOOD'], foreground='white', font=('TkDefaultFont', 9, 'bold'), relief='solid', borderwidth=3)
        style.configure('Excellent.Active.TButton', background=self.BAND_COLORS['EXCELLENT'], foreground='white', font=('TkDefaultFont', 9, 'bold'), relief='solid', borderwidth=3)
        style.configure('Unknown.Active.TButton', background=self.BAND_COLORS['UNKNOWN'], foreground='white', font=('TkDefaultFont', 9, 'bold'), relief='solid', borderwidth=3)

        # Hover styles for active buttons (keep border, add raised relief)
        style.map('Poor.Active.TButton', background=[('active', self.BAND_COLORS['POOR'])], relief=[('active', 'raised')])
        style.map('Fair.Active.TButton', background=[('active', self.BAND_COLORS['FAIR'])], relief=[('active', 'raised')])
        style.map('Good.Active.TButton', background=[('active', self.BAND_COLORS['GOOD'])], relief=[('active', 'raised')])
        style.map('Excellent.Active.TButton', background=[('active', self.BAND_COLORS['EXCELLENT'])], relief=[('active', 'raised')])
        style.map('Unknown.Active.TButton', background=[('active', self.BAND_COLORS['UNKNOWN'])], relief=[('active', 'raised')])

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
        server_entry.bind('<Return>', lambda e: self.toggle_connection())

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

        # Receiver info label (second row, initially hidden) - shows name, version, and map link
        ttk.Label(conn_frame, text="Receiver:").grid(row=1, column=0, sticky=tk.W, padx=(0, 5))
        
        # Create a frame to hold all receiver info on one line
        receiver_info_frame = ttk.Frame(conn_frame)
        receiver_info_frame.grid(row=1, column=1, columnspan=3, sticky=tk.W)
        
        # Receiver name (truncated to 50 chars)
        self.receiver_name_var = tk.StringVar(value="")
        self.receiver_name_label = ttk.Label(receiver_info_frame, textvariable=self.receiver_name_var, foreground='blue')
        self.receiver_name_label.pack(side=tk.LEFT)
        
        # Delimiter
        self.receiver_delimiter1 = ttk.Label(receiver_info_frame, text=" | ", foreground='gray')
        self.receiver_delimiter1.pack(side=tk.LEFT)
        
        # Version
        self.receiver_version_var = tk.StringVar(value="")
        self.receiver_version_label = ttk.Label(receiver_info_frame, textvariable=self.receiver_version_var, foreground='blue')
        self.receiver_version_label.pack(side=tk.LEFT)
        
        # Delimiter
        self.receiver_delimiter2 = ttk.Label(receiver_info_frame, text=" | ", foreground='gray')
        self.receiver_delimiter2.pack(side=tk.LEFT)
        
        # Map link (clickable)
        self.receiver_map_link = ttk.Label(receiver_info_frame, text="Open Map", foreground='blue', cursor='hand2')
        self.receiver_map_link.pack(side=tk.LEFT)
        self.receiver_map_link.bind('<Button-1>', self.open_receiver_map)
        
        # Hide entire frame initially until connected
        receiver_info_frame.grid_remove()
        self.receiver_info_frame = receiver_info_frame

        # Session timer label (same row as receiver, right side)
        self.session_timer_var = tk.StringVar(value="")
        self.session_timer_label = ttk.Label(conn_frame, textvariable=self.session_timer_var, foreground='blue', font=('TkDefaultFont', 9, 'bold'))
        self.session_timer_label.grid(row=1, column=3, columnspan=2, sticky=tk.E)
        self.session_timer_label.grid_remove()  # Hide initially until connected

        # Rigctl connection (third row, optional)
        ttk.Label(conn_frame, text="Rigctl:").grid(row=2, column=0, sticky=tk.W, padx=(0, 5))

        # Create a frame to hold rigctl controls so they stay together
        rigctl_controls = ttk.Frame(conn_frame)
        rigctl_controls.grid(row=2, column=1, columnspan=4, sticky=tk.W)

        self.rigctl_host_var = tk.StringVar(value=self.config.get('rigctl_host', 'localhost'))
        rigctl_host_entry = ttk.Entry(rigctl_controls, textvariable=self.rigctl_host_var, width=15)
        rigctl_host_entry.pack(side=tk.LEFT, padx=(0, 5))
        rigctl_host_entry.bind('<Return>', lambda e: self.toggle_rigctl_connection())

        ttk.Label(rigctl_controls, text="Port:").pack(side=tk.LEFT, padx=(0, 5))
        self.rigctl_port_var = tk.StringVar(value=str(self.config.get('rigctl_port', 4532)))
        rigctl_port_entry = ttk.Entry(rigctl_controls, textvariable=self.rigctl_port_var, width=6)
        rigctl_port_entry.pack(side=tk.LEFT, padx=(0, 5))
        rigctl_port_entry.bind('<Return>', lambda e: self.toggle_rigctl_connection())

        self.rigctl_connect_btn = ttk.Button(rigctl_controls, text="Connect Rig", command=self.toggle_rigctl_connection)
        self.rigctl_connect_btn.pack(side=tk.LEFT, padx=(0, 5))

        # Sync direction radio buttons (SDR->Rig or Rig->SDR) - always visible
        ttk.Label(rigctl_controls, text="Sync:").pack(side=tk.LEFT, padx=(10, 5))
        
        self.rigctl_sync_direction_var = tk.StringVar(value="SDR→Rig")

        self.rigctl_sdr_to_rig_radio = ttk.Radiobutton(rigctl_controls, text="SDR→Rig",
                                                       variable=self.rigctl_sync_direction_var,
                                                       value="SDR→Rig",
                                                       command=self.on_rigctl_sync_direction_changed)
        self.rigctl_sdr_to_rig_radio.pack(side=tk.LEFT, padx=(0, 5))

        self.rigctl_rig_to_sdr_radio = ttk.Radiobutton(rigctl_controls, text="Rig→SDR",
                                                       variable=self.rigctl_sync_direction_var,
                                                       value="Rig→SDR",
                                                       command=self.on_rigctl_sync_direction_changed)
        self.rigctl_rig_to_sdr_radio.pack(side=tk.LEFT)

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
        freq_entry.bind('<Return>', lambda e: self.apply_frequency())

        # Unit selector (Hz, kHz, MHz)
        self.freq_unit_var = tk.StringVar(value="MHz")
        self.prev_freq_unit = "MHz"  # Track previous unit for conversion
        unit_combo = ttk.Combobox(freq_frame, textvariable=self.freq_unit_var,
                                  values=["Hz", "kHz", "MHz"], state='readonly', width=6)
        unit_combo.grid(row=0, column=2, sticky=tk.W, padx=(0, 5))
        unit_combo.bind('<<ComboboxSelected>>', lambda e: self.on_freq_unit_changed())

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

        # Quick frequency buttons - all amateur bands from 160m to 10m (single row)
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

        # Arrange in single row
        for i, (label, freq_hz) in enumerate(quick_freqs):
            btn = ttk.Button(quick_frame, text=label, width=5,
                           command=lambda f=freq_hz: self.set_frequency_and_mode(f))
            btn.grid(row=0, column=i, padx=1, pady=1)
            # Store button reference for highlighting
            self.band_buttons[label] = btn


        # Initialize band button highlighting with current frequency
        try:
            initial_freq_hz = self.get_frequency_hz()
            self.update_band_buttons(initial_freq_hz)
        except ValueError:
            pass  # Ignore if frequency is invalid

        # Bookmarks dropdown (third row, below band buttons)
        bookmark_frame = ttk.Frame(freq_frame)
        bookmark_frame.grid(row=2, column=0, columnspan=8, sticky=tk.W, pady=(5, 0))

        ttk.Label(bookmark_frame, text="Bookmarks:").pack(side=tk.LEFT, padx=(0, 5))

        self.bookmark_var = tk.StringVar(value="")
        self.bookmark_combo = ttk.Combobox(bookmark_frame, textvariable=self.bookmark_var,
                                          state='readonly', width=15)
        self.bookmark_combo.pack(side=tk.LEFT, padx=(0, 5))
        self.bookmark_combo.bind('<<ComboboxSelected>>', lambda e: self.on_bookmark_selected())

        # Initially disabled until bookmarks are loaded
        self.bookmark_combo.config(state='disabled')

        # Band selector dropdown (to the right of bookmarks)
        ttk.Label(bookmark_frame, text="Band:").pack(side=tk.LEFT, padx=(20, 5))

        self.band_selector_var = tk.StringVar(value="")
        self.band_selector_combo = ttk.Combobox(bookmark_frame, textvariable=self.band_selector_var,
                                               state='readonly', width=25)
        self.band_selector_combo.pack(side=tk.LEFT, padx=(0, 5))
        self.band_selector_combo.bind('<<ComboboxSelected>>', lambda e: self.on_band_selected())

        # Band selector will be populated after fetching bands from server
        self.band_selector_combo['values'] = [""]  # Empty initially

        freq_frame.columnconfigure(8, weight=1)

        # Mode & Bandwidth control frame (combined)
        bw_frame = ttk.LabelFrame(main_frame, text="Mode", padding="10")
        bw_frame.grid(row=2, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))

        # Mode selection (first row) - now using buttons instead of dropdown
        # Create mode button styles
        style.configure('Mode.TButton', background='#22c55e', foreground='white', font=('TkDefaultFont', 9, 'bold'))
        style.configure('ModeActive.TButton', background='#16a34a', foreground='white', font=('TkDefaultFont', 9, 'bold'))
        style.map('Mode.TButton', background=[('active', '#22c55e')], relief=[('active', 'raised')])
        style.map('ModeActive.TButton', background=[('active', '#16a34a')], relief=[('active', 'raised')])

        # Mode buttons frame
        mode_buttons_frame = ttk.Frame(bw_frame)
        mode_buttons_frame.grid(row=0, column=0, columnspan=10, sticky=tk.W)

        # Define modes with their display names
        # First row: AM, SAM, USB, LSB, FM, NFM, CWU, CWL, IQ (9 buttons)
        # Second row: IQ48, IQ96, IQ192, IQ384 (only shown if bypassed=true)
        modes_row1 = [
            ('AM', 'AM'), ('SAM', 'SAM'), ('USB', 'USB'), ('LSB', 'LSB'),
            ('FM', 'FM'), ('NFM', 'NFM'), ('CWU', 'CWU'), ('CWL', 'CWL'),
            ('IQ', 'IQ')
        ]
        modes_row2 = [
            ('IQ48', 'IQ (48)'), ('IQ96', 'IQ (96)'),
            ('IQ192', 'IQ (192)'), ('IQ384', 'IQ (384)')
        ]

        self.mode_var = tk.StringVar(value=self.config.get('mode', 'USB').upper())
        self.mode_buttons = {}
        self.mode_buttons_row2 = []  # Track second row buttons for show/hide

        # Create first row mode buttons
        for i, (mode_value, mode_display) in enumerate(modes_row1):
            btn = ttk.Button(mode_buttons_frame, text=mode_display, width=10,
                           command=lambda m=mode_value: self.select_mode(m))
            btn.grid(row=0, column=i, padx=1, pady=1)
            self.mode_buttons[mode_value] = btn

        # Create second row mode buttons (initially hidden)
        for i, (mode_value, mode_display) in enumerate(modes_row2):
            btn = ttk.Button(mode_buttons_frame, text=mode_display, width=10,
                           command=lambda m=mode_value: self.select_mode(m))
            btn.grid(row=1, column=i, padx=1, pady=1)
            btn.grid_remove()  # Hide initially
            self.mode_buttons[mode_value] = btn
            self.mode_buttons_row2.append(btn)

        # Update initial button states
        self.update_mode_buttons()

        # Mode lock checkbox (moved to next row)
        self.mode_lock_var = tk.BooleanVar(value=False)
        mode_lock_check = ttk.Checkbutton(bw_frame, text="Lock", variable=self.mode_lock_var)
        mode_lock_check.grid(row=1, column=0, sticky=tk.W, padx=(0, 10), pady=(5, 0))

        # Bandwidth controls (third row) - using sliders
        ttk.Label(bw_frame, text="Low (Hz):").grid(row=2, column=0, sticky=tk.W, padx=(0, 5))
        self.bw_low_var = tk.IntVar(value=self.config.get('bandwidth_low', 50))
        self.bw_low_scale = ttk.Scale(bw_frame, from_=-10000, to=10000, orient=tk.HORIZONTAL,
                                      variable=self.bw_low_var, command=self.update_bandwidth_display,
                                      length=150)
        self.bw_low_scale.grid(row=2, column=1, sticky=(tk.W, tk.E), padx=(0, 5))

        self.bw_low_label = ttk.Label(bw_frame, text=f"{self.config.get('bandwidth_low', 50)} Hz", width=10)
        self.bw_low_label.grid(row=2, column=2, sticky=tk.W, padx=(0, 20))

        ttk.Label(bw_frame, text="High (Hz):").grid(row=2, column=3, sticky=tk.W, padx=(0, 5))
        self.bw_high_var = tk.IntVar(value=self.config.get('bandwidth_high', 2700))
        self.bw_high_scale = ttk.Scale(bw_frame, from_=-10000, to=10000, orient=tk.HORIZONTAL,
                                       variable=self.bw_high_var, command=self.update_bandwidth_display,
                                       length=150)
        self.bw_high_scale.grid(row=2, column=4, sticky=(tk.W, tk.E), padx=(0, 5))

        self.bw_high_label = ttk.Label(bw_frame, text=f"{self.config.get('bandwidth_high', 2700)} Hz", width=10)
        self.bw_high_label.grid(row=2, column=5, sticky=tk.W)

        # Set initial bandwidth slider bounds based on initial mode (must be done after sliders are created)
        initial_mode = self.config.get('mode', 'USB').lower()
        self.update_bandwidth_slider_bounds(initial_mode)

        # Preset bandwidth buttons (will be updated based on mode)
        self.preset_frame = ttk.Frame(bw_frame)
        self.preset_frame.grid(row=3, column=0, columnspan=5, sticky=tk.W, pady=(5, 0))

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
        self.volume_scale = ttk.Scale(audio_frame, from_=0, to=100, orient=tk.HORIZONTAL,
                                variable=self.volume_var, command=self.update_volume)
        self.volume_scale.grid(row=1, column=1, sticky=(tk.W, tk.E), padx=(0, 10))

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

        self.left_check = ttk.Checkbutton(audio_frame, text="Left", variable=self.channel_left_var,
                                     command=self.update_channels)
        self.left_check.grid(row=2, column=1, sticky=tk.W, pady=(5, 0))

        self.right_check = ttk.Checkbutton(audio_frame, text="Right", variable=self.channel_right_var,
                                      command=self.update_channels)
        self.right_check.grid(row=2, column=2, sticky=tk.W, pady=(5, 0))

        # EQ button (same row as channels)
        if EQ_AVAILABLE:
            self.eq_btn = ttk.Button(audio_frame, text="EQ", width=8,
                                     command=self.open_eq_window)
            self.eq_btn.grid(row=2, column=3, sticky=tk.W, padx=(20, 0), pady=(5, 0))
        else:
            self.eq_btn = None

        # NR2 Noise Reduction (row 3) - use a frame to avoid column weight issues
        nr2_container = ttk.Frame(audio_frame)
        nr2_container.grid(row=3, column=0, columnspan=7, sticky=tk.W, pady=(5, 0))

        self.nr2_enabled_var = tk.BooleanVar(value=False)
        self.nr2_check = ttk.Checkbutton(nr2_container, text="Enable NR2", variable=self.nr2_enabled_var,
                                    command=self.toggle_nr2)
        self.nr2_check.grid(row=0, column=0, sticky=tk.W, padx=(0, 20))

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
        self.filter_check = ttk.Checkbutton(filter_container, text="Enable Audio Filter", variable=self.audio_filter_enabled_var,
                                       command=self.toggle_audio_filter)
        self.filter_check.grid(row=0, column=0, sticky=tk.W, padx=(0, 20))

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

        # Controls frame (buttons for opening windows)
        if SPECTRUM_AVAILABLE:
            controls_frame = ttk.LabelFrame(main_frame, text="Controls", padding="10")
            controls_frame.grid(row=4, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))

            # Create a hidden frame for spectrum display (will be moved to waterfall window)
            spectrum_container = tk.Frame(controls_frame)
            # Don't pack spectrum_container - it stays hidden

            # Create spectrum display in hidden container
            self.spectrum = SpectrumDisplay(spectrum_container, width=800, height=200, bookmarks=self.bookmarks)
            self.spectrum.set_frequency_callback(self.on_spectrum_frequency_click)
            self.spectrum.set_frequency_step_callback(self.on_spectrum_frequency_step)
            self.spectrum.set_mode_callback(self.on_spectrum_mode_change)

            # Initialize spectrum with current bandwidth values
            try:
                initial_low = int(self.bw_low_var.get())
                initial_high = int(self.bw_high_var.get())
                self.spectrum.update_bandwidth(initial_low, initial_high)
            except ValueError:
                pass  # Use defaults if values are invalid

            # Add buttons for opening windows
            button_frame = ttk.Frame(controls_frame)
            button_frame.pack(side=tk.TOP, pady=(5, 5))

            if WATERFALL_AVAILABLE:
                waterfall_btn = ttk.Button(button_frame, text="RF Spectrum",
                                          command=self.open_waterfall_window)
                waterfall_btn.pack(side=tk.LEFT, padx=(0, 5))

            if AUDIO_SPECTRUM_AVAILABLE:
                self.audio_spectrum_btn = ttk.Button(button_frame, text="Audio Spectrum",
                                      command=self.open_audio_spectrum_window)
                self.audio_spectrum_btn.pack(side=tk.LEFT, padx=(0, 5))
            else:
                self.audio_spectrum_btn = None

            # Digital spots button (conditionally shown based on server capability)
            if DIGITAL_SPOTS_AVAILABLE:
                self.digital_spots_btn = ttk.Button(button_frame, text="Digital Spots",
                                      command=self.open_digital_spots_window)
                # Don't pack yet - will be shown after connection if server supports it
            else:
                self.digital_spots_btn = None

            # CW spots button (conditionally shown based on server capability)
            if CW_SPOTS_AVAILABLE:
                self.cw_spots_btn = ttk.Button(button_frame, text="CW Spots",
                                         command=self.open_cw_spots_window)
                # Don't pack yet - will be shown after connection if server supports it
            else:
                self.cw_spots_btn = None

            # Band conditions button (always available)
            if BAND_CONDITIONS_AVAILABLE:
                self.band_conditions_btn = ttk.Button(button_frame, text="Conditions",
                                                     command=self.open_band_conditions_window)
                self.band_conditions_btn.pack(side=tk.LEFT, padx=(0, 5))
            else:
                self.band_conditions_btn = None

            # Space weather button (always available)
            if SPACE_WEATHER_AVAILABLE:
                self.space_weather_btn = ttk.Button(button_frame, text="Weather",
                                                   command=self.open_space_weather_window)
                self.space_weather_btn.pack(side=tk.LEFT, padx=(0, 5))
            else:
                self.space_weather_btn = None

            # MIDI controller button
            self.midi_btn = ttk.Button(button_frame, text="MIDI",
                                       command=self.open_midi_window)
            self.midi_btn.pack(side=tk.LEFT, padx=(0, 5))

            # Scroll mode selector removed from here - now in waterfall window title section
            self.scroll_mode_var = tk.StringVar(value="pan")

            controls_frame.columnconfigure(0, weight=1)

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

    def on_freq_unit_changed(self):
        """Handle frequency unit change - convert current value to new unit."""
        try:
            # Get current value and convert from previous unit to Hz
            freq_value = float(self.freq_var.get())
            old_unit = self.prev_freq_unit

            # Convert from old unit to Hz
            if old_unit == "MHz":
                freq_hz = int(freq_value * 1e6)
            elif old_unit == "kHz":
                freq_hz = int(freq_value * 1e3)
            else:  # Hz
                freq_hz = int(freq_value)

            # Convert from Hz to new unit
            new_unit = self.freq_unit_var.get()
            if new_unit == "MHz":
                new_value = freq_hz / 1e6
                self.freq_var.set(f"{new_value:.6f}")
            elif new_unit == "kHz":
                new_value = freq_hz / 1e3
                self.freq_var.set(f"{new_value:.3f}")
            else:  # Hz
                self.freq_var.set(str(freq_hz))

            # Update previous unit for next conversion
            self.prev_freq_unit = new_unit
        except ValueError:
            # If conversion fails, just update the previous unit
            self.prev_freq_unit = self.freq_unit_var.get()

    def update_bandwidth_display(self, value=None):
        """Update bandwidth labels when sliders change."""
        low = int(self.bw_low_var.get())
        high = int(self.bw_high_var.get())

        # Update labels
        self.bw_low_label.config(text=f"{low} Hz")
        self.bw_high_label.config(text=f"{high} Hz")

        # Disable audio filter when bandwidth changes (silently, without validation)
        if self.audio_filter_enabled_var.get():
            self.audio_filter_enabled_var.set(False)
            # Disable directly in client without calling toggle_audio_filter
            if self.client:
                self.client.audio_filter_enabled = False
            # Update audio spectrum display
            if self.audio_spectrum_display:
                self.audio_spectrum_display.update_audio_filter(False,
                    int(self.audio_filter_low_var.get()),
                    int(self.audio_filter_high_var.get()))
            self.log_status("Audio filter disabled (bandwidth changed)")

        # Update audio filter ranges when bandwidth changes
        self.update_audio_filter_ranges()

        # Update spectrum display bandwidth visualization
        if self.spectrum:
            self.spectrum.update_bandwidth(low, high)

        # Update waterfall display bandwidth visualization
        if self.waterfall_display:
            self.waterfall_display.update_bandwidth(low, high)

        # Update audio spectrum display bandwidth
        if self.audio_spectrum_display:
            self.audio_spectrum_display.update_bandwidth(low, high)

        # Update waterfall window's spectrum and waterfall if open
        if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
            self.waterfall_spectrum.update_bandwidth(low, high)
        if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
            self.waterfall_waterfall.update_bandwidth(low, high)

        # Apply bandwidth dynamically if connected (with debouncing)
        if self.connected and self.client:
            # Cancel any pending bandwidth update
            if self.bandwidth_update_job:
                self.root.after_cancel(self.bandwidth_update_job)

            # Schedule new bandwidth update after 100ms
            self.bandwidth_update_job = self.root.after(100, lambda: self._apply_bandwidth_update(low, high))

    def _apply_bandwidth_update(self, low: int, high: int):
        """Apply bandwidth update to server (called after debounce delay)."""
        if self.connected and self.client:
            self.client.bandwidth_low = low
            self.client.bandwidth_high = high

            # Reset NR2 learning when bandwidth changes (noise profile will be different)
            if self.client.nr2_enabled and self.client.nr2_processor:
                self.client.nr2_processor.reset_learning()
                self.log_status("NR2 relearning noise profile (bandwidth changed)")

            self.send_tune_message()
        self.bandwidth_update_job = None

    def set_bandwidth(self, low: int, high: int):
        """Set bandwidth from preset button."""
        self.bw_low_var.set(low)
        self.bw_high_var.set(high)

        # Update labels
        self.bw_low_label.config(text=f"{low} Hz")
        self.bw_high_label.config(text=f"{high} Hz")

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
        """Handle step size change - update spectrum and waterfall displays."""
        step_hz = self.get_step_size_hz()

        if self.spectrum:
            self.spectrum.set_step_size(step_hz)

        # Update waterfall display if open
        if self.waterfall_display:
            self.waterfall_display.set_step_size(step_hz)

        # Update waterfall window's spectrum and waterfall if open
        if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
            self.waterfall_spectrum.set_step_size(step_hz)
        if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
            self.waterfall_waterfall.set_step_size(step_hz)

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

        # Update band dropdown selection
        self.update_band_selector(freq_hz)

        # Update bookmark dropdown selection
        self.update_bookmark_selector(freq_hz)

    def update_band_buttons(self, freq_hz: int):
        """Update band button highlighting based on current frequency.

        Args:
            freq_hz: Current frequency in Hz
        """
        current_band = None

        for band_name, button in self.band_buttons.items():
            # Use hardcoded BAND_RANGES for button highlighting
            # (server bands are for other purposes like the dropdown)
            band_range = self.BAND_RANGES.get(band_name)

            if band_range:
                is_active = band_range['min'] <= freq_hz <= band_range['max']

                if is_active:
                    current_band = band_name

                # Get band status (SNR-based color)
                status = self.band_states.get(band_name, 'UNKNOWN')

                # Apply style based on status and active state
                if is_active:
                    # Active band: use status color with border
                    style_name = f'{status.capitalize()}.Active.TButton'
                    button.configure(style=style_name)
                else:
                    # Inactive band: use status color without border
                    style_name = f'{status.capitalize()}.TButton'
                    button.configure(style=style_name)

        # Update band filter in digital spots window if open - only if band actually changed
        if self.digital_spots_display and current_band:
            if self.digital_spots_display.band_filter.get() != current_band:
                self.digital_spots_display.band_filter.set(current_band)
                self.digital_spots_display.apply_filters()

        # Update band filter in CW spots window if open - only if band actually changed
        if self.cw_spots_display and current_band:
            if self.cw_spots_display.band_var.get() != current_band:
                self.cw_spots_display.band_var.set(current_band)
                self.cw_spots_display.apply_filters()

    def fetch_band_states(self):
        """Fetch band states from the noise floor aggregate API and update button colors."""
        if not self.connected:
            self.log_status("DEBUG: fetch_band_states called but not connected")
            return

        try:
            from datetime import datetime, timedelta
            
            # Get server URL
            server = self.server_var.get()
            use_tls = self.tls_var.get()

            # Build API URL
            if '://' in server:
                # Full URL provided
                base_url = server
            else:
                # Host:port format
                protocol = 'https' if use_tls else 'http'
                base_url = f"{protocol}://{server}"

            # Use /api/noisefloor/aggregate endpoint (matching bands_state.js)
            api_url = f"{base_url}/api/noisefloor/aggregate"

            # Get the previous 10 minutes time range in UTC (matching bands_state.js)
            now = datetime.utcnow()
            to_time = now.isoformat() + 'Z'
            from_time = (now - timedelta(minutes=10)).isoformat() + 'Z'
            
            # Build request body (matching bands_state.js format)
            # Always use hardcoded BAND_RANGES for band button updates
            request_body = {
                'primary': {
                    'from': from_time,
                    'to': to_time
                },
                'bands': list(self.BAND_RANGES.keys()),
                'fields': ['ft8_snr'],
                'interval': 'minute'
            }

            self.log_status(f"Fetching band states from {api_url}")

            # POST request with JSON body
            response = requests.post(
                api_url,
                json=request_body,
                headers={'Content-Type': 'application/json'},
                timeout=5
            )

            response.raise_for_status()
            data = response.json()

            if not data or 'primary' not in data:
                self.log_status("No band data available")
                return

            self.log_status(f"Band state data received")

            # Process band data (aggregate format)
            self.process_band_data_aggregate(data)

            # Update last update time
            self.last_band_state_update = time.time()

        except requests.exceptions.RequestException as e:
            # Log connection errors for debugging
            self.log_status(f"Band state fetch error: {e}")
        except Exception as e:
            # Log unexpected errors
            self.log_status(f"Band state update error: {e}")

    def process_band_data(self, data: dict):
        """Process noise floor data and determine band status.

        Args:
            data: Noise floor latest data from API (format: {band_name: {ft8_snr: value, ...}})
        """
        # Always use hardcoded BAND_RANGES for band button updates
        band_names = list(self.BAND_RANGES.keys())

        # Process each band
        for band_name in band_names:
            # Get band data from API response
            band_data = data.get(band_name, {})

            if not band_data or 'ft8_snr' not in band_data:
                # No data for this band - treat as UNKNOWN (green)
                self.band_states[band_name] = 'UNKNOWN'
                continue

            # Get the FT8 SNR value directly (latest endpoint returns single value per band)
            snr = band_data.get('ft8_snr')

            if snr is None or snr <= 0:
                # No valid SNR data - treat as UNKNOWN (green)
                self.band_states[band_name] = 'UNKNOWN'
                continue

            # Determine status based on SNR thresholds (matching bandconditions.js logic)
            if snr < self.SNR_THRESHOLDS['POOR']:
                status = 'POOR'
            elif snr < self.SNR_THRESHOLDS['FAIR']:
                status = 'FAIR'
            elif snr < self.SNR_THRESHOLDS['GOOD']:
                status = 'GOOD'
            else:
                status = 'EXCELLENT'

            self.band_states[band_name] = status
            self.log_status(f"{band_name}: {status} ({snr:.1f} dB)")

        # Update button colors
        try:
            current_freq = self.get_frequency_hz()
            self.update_band_buttons(current_freq)
        except ValueError:
            # If frequency is invalid, just update all buttons without active state
            for band_name, button in self.band_buttons.items():
                status = self.band_states.get(band_name, 'UNKNOWN')
                button.configure(style=f'{status.capitalize()}.TButton')

    def process_band_data_aggregate(self, data: dict):
        """Process aggregate noise floor data and determine band status.

        Args:
            data: Aggregate API response with format: {primary: {band_name: [{timestamp, values: {ft8_snr: ...}}]}}
        """
        primary_data = data.get('primary', {})

        # Always use hardcoded BAND_RANGES for band button updates
        band_names = list(self.BAND_RANGES.keys())

        # Process each band
        for band_name in band_names:
            band_data = primary_data.get(band_name, [])

            if not band_data or len(band_data) == 0:
                # No data for this band - treat as UNKNOWN (green)
                self.band_states[band_name] = 'UNKNOWN'
                continue

            # Calculate average SNR across all data points in the 10-minute window
            # (matching bands_state.js processBandData logic)
            total_snr = 0
            total_samples = 0

            for data_point in band_data:
                values = data_point.get('values', {})
                snr = values.get('ft8_snr')

                if snr is not None and snr > 0:
                    total_snr += snr
                    total_samples += 1

            if total_samples == 0:
                # No valid SNR data - treat as UNKNOWN (green)
                self.band_states[band_name] = 'UNKNOWN'
                continue

            # Calculate average SNR
            avg_snr = total_snr / total_samples

            # Determine status based on SNR thresholds (matching bands_state.js logic)
            if avg_snr < self.SNR_THRESHOLDS['POOR']:
                status = 'POOR'
            elif avg_snr < self.SNR_THRESHOLDS['FAIR']:
                status = 'FAIR'
            elif avg_snr < self.SNR_THRESHOLDS['GOOD']:
                status = 'GOOD'
            else:
                status = 'EXCELLENT'

            self.band_states[band_name] = status
            self.log_status(f"{band_name}: {status} ({avg_snr:.1f} dB)")

        # Update button colors
        try:
            current_freq = self.get_frequency_hz()
            self.update_band_buttons(current_freq)
        except ValueError:
            # If frequency is invalid, just update all buttons without active state
            for band_name, button in self.band_buttons.items():
                status = self.band_states.get(band_name, 'UNKNOWN')
                button.configure(style=f'{status.capitalize()}.TButton')

    def start_band_state_polling(self):
        """Start periodic polling of band states (every 60 seconds)."""
        self.log_status(f"start_band_state_polling called, connected={self.connected}")

        if not self.connected:
            self.log_status("Band state polling skipped - not connected")
            return

        self.log_status("Starting band state polling...")

        # Fetch immediately on start
        self.fetch_band_states()

        # Schedule next poll in 60 seconds
        self.band_state_poll_job = self.root.after(60000, self.poll_band_states)

    def poll_band_states(self):
        """Poll band states periodically."""
        if not self.connected:
            return

        # Fetch band states
        self.fetch_band_states()

        # Schedule next poll in 60 seconds
        self.band_state_poll_job = self.root.after(60000, self.poll_band_states)

    def stop_band_state_polling(self):
        """Stop periodic polling of band states."""
        if self.band_state_poll_job:
            self.root.after_cancel(self.band_state_poll_job)
            self.band_state_poll_job = None

        # Always use hardcoded BAND_RANGES for band button updates
        band_names = list(self.BAND_RANGES.keys())

        # Reset band states to UNKNOWN
        for band_name in band_names:
            self.band_states[band_name] = 'UNKNOWN'

        # Update button colors
        try:
            current_freq = self.get_frequency_hz()
            self.update_band_buttons(current_freq)
        except ValueError:
            # If frequency is invalid, just update all buttons
            for band_name, button in self.band_buttons.items():
                button.configure(style='Unknown.TButton')

    def fetch_bookmarks(self):
        """Fetch bookmarks from the server API."""
        try:
            # Get server URL
            server = self.server_var.get()
            use_tls = self.tls_var.get()

            # Build API URL
            if '://' in server:
                # Full URL provided
                base_url = server
            else:
                # Host:port format
                protocol = 'https' if use_tls else 'http'
                base_url = f"{protocol}://{server}"

            api_url = f"{base_url}/api/bookmarks"

            # Fetch bookmarks
            response = requests.get(api_url, timeout=5)
            response.raise_for_status()
            data = response.json()

            if isinstance(data, list):
                self.bookmarks = data
                self.populate_bookmark_dropdown()
                # Update spectrum and waterfall displays with bookmarks
                if self.spectrum:
                    self.spectrum.bookmarks = self.bookmarks
                if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
                    self.waterfall_spectrum.bookmarks = self.bookmarks
                if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
                    self.waterfall_waterfall.bookmarks = self.bookmarks
                self.log_status(f"Loaded {len(self.bookmarks)} bookmark(s)")
            else:
                self.log_status("No bookmarks available")

        except requests.exceptions.RequestException as e:
            # Silently fail if bookmarks not available (server might not support it)
            self.log_status(f"Bookmarks not available: {e}")
            self.bookmarks = []
        except Exception as e:
            self.log_status(f"Error loading bookmarks: {e}")
            self.bookmarks = []

    def fetch_bands(self):
        """Fetch bands from the server API."""
        try:
            # Get server URL
            server = self.server_var.get()
            use_tls = self.tls_var.get()

            # Build API URL
            if '://' in server:
                # Full URL provided
                base_url = server
            else:
                # Host:port format
                protocol = 'https' if use_tls else 'http'
                base_url = f"{protocol}://{server}"

            api_url = f"{base_url}/api/bands"

            # Fetch bands
            response = requests.get(api_url, timeout=5)
            response.raise_for_status()
            data = response.json()

            if isinstance(data, list):
                self.bands = data
                self.assign_band_colors()
                self.populate_band_selector()
                self.update_spectrum_bands()
                self.log_status(f"Loaded {len(self.bands)} band(s) from server")
            else:
                self.log_status("No bands available from server")
                # Fall back to hardcoded bands
                self.use_hardcoded_bands()

        except requests.exceptions.RequestException as e:
            # Silently fall back to hardcoded bands if server doesn't support it
            self.log_status(f"Bands API not available, using defaults: {e}")
            self.use_hardcoded_bands()
        except Exception as e:
            self.log_status(f"Error loading bands: {e}")
            self.use_hardcoded_bands()

    def assign_band_colors(self):
        """Assign pastel colors to bands (matching web UI color palette)."""
        # Color palette for bands (rainbow gradient with transparency)
        band_colors = [
            '#ffcccc',  # Light red
            '#ffd9cc',  # Light orange-red
            '#ffe6cc',  # Light orange
            '#ffffcc',  # Light yellow
            '#e6ffcc',  # Light yellow-green
            '#ccffcc',  # Light green
            '#ccffe6',  # Light cyan-green
            '#cce6ff',  # Light cyan
            '#ccccff',  # Light blue
            '#d9ccff'   # Light purple
        ]

        # Assign colors to bands
        for i, band in enumerate(self.bands):
            band['color'] = band_colors[i % len(band_colors)]

    def update_spectrum_bands(self):
        """Update spectrum displays with band data."""
        # Update main spectrum display if it exists
        if self.spectrum:
            self.spectrum.bands = self.bands

        # Update waterfall window's spectrum if it exists
        if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
            self.waterfall_spectrum.bands = self.bands

    def use_hardcoded_bands(self):
        """Use hardcoded BAND_RANGES as fallback."""
        # Convert BAND_RANGES to bands format
        self.bands = []
        for label, range_dict in self.BAND_RANGES.items():
            self.bands.append({
                'label': label,
                'start': range_dict['min'],
                'end': range_dict['max']
            })
        self.assign_band_colors()
        self.populate_band_selector()
        self.update_spectrum_bands()

    def populate_band_selector(self):
        """Populate the band selector dropdown with band labels."""
        if not self.bands:
            self.band_selector_combo['values'] = [""]
            return

        # Extract band labels
        band_labels = [""] + [band.get('label', 'Unknown') for band in self.bands]

        # Update dropdown
        self.band_selector_combo['values'] = band_labels

        # Update initial selection based on current frequency
        try:
            freq_hz = self.get_frequency_hz()
            self.update_band_selector(freq_hz)
        except ValueError:
            pass  # Ignore if frequency is invalid

    def populate_bookmark_dropdown(self):
        """Populate the bookmark dropdown with bookmark names."""
        if not self.bookmarks:
            self.bookmark_combo.config(state='disabled')
            self.bookmark_combo['values'] = []
            return

        # Extract bookmark names
        bookmark_names = [bookmark.get('name', 'Unnamed') for bookmark in self.bookmarks]

        # Update dropdown
        self.bookmark_combo['values'] = bookmark_names
        self.bookmark_combo.config(state='readonly')

        # Update initial selection based on current frequency and mode
        try:
            freq_hz = self.get_frequency_hz()
            self.update_bookmark_selector(freq_hz)
        except ValueError:
            pass  # Ignore if frequency is invalid

    def on_bookmark_selected(self):
        """Handle bookmark selection from dropdown."""
        selected_name = self.bookmark_var.get()
        if not selected_name:
            return

        # Find the selected bookmark
        selected_bookmark = None
        for bookmark in self.bookmarks:
            if bookmark.get('name') == selected_name:
                selected_bookmark = bookmark
                break

        if not selected_bookmark:
            return

        # Get frequency and mode from bookmark
        frequency = selected_bookmark.get('frequency')
        mode = selected_bookmark.get('mode', 'USB').upper()

        if frequency:
            # Set frequency
            self.set_frequency_hz(int(frequency))

            # Set mode if not locked
            if not self.mode_lock_var.get():
                # Map mode names (bookmark might use different case)
                mode_map = {
                    'USB': 'USB', 'LSB': 'LSB', 'AM': 'AM', 'SAM': 'SAM',
                    'CWU': 'CWU', 'CWL': 'CWL', 'FM': 'FM', 'NFM': 'NFM',
                    'IQ': 'IQ', 'IQ48': 'IQ48', 'IQ96': 'IQ96',
                    'IQ192': 'IQ192', 'IQ384': 'IQ384'
                }
                mapped_mode = mode_map.get(mode, 'USB')
                self.mode_var.set(mapped_mode)
                self.on_mode_changed()

            # Apply changes if connected (skip auto mode switching for bookmarks)
            if self.connected:
                self.apply_frequency(skip_auto_mode=True)

            self.log_status(f"Tuned to bookmark: {selected_name} ({frequency/1e6:.6f} MHz, {mode})")

    def on_band_selected(self):
        """Handle band selection from dropdown."""
        selected_band = self.band_selector_var.get()
        if not selected_band:
            return

        # Find the selected band in fetched bands
        band_data = None
        for band in self.bands:
            if band.get('label') == selected_band:
                band_data = band
                break

        if not band_data:
            return

        # Calculate center frequency
        center_freq = (band_data['start'] + band_data['end']) // 2

        # Set frequency
        self.set_frequency_hz(center_freq)

        # Determine mode based on frequency (LSB < 10 MHz, USB >= 10 MHz) only if not locked
        if not self.mode_lock_var.get():
            if center_freq < 10000000:  # Below 10 MHz
                mode = 'LSB'
            else:  # 10 MHz and above
                mode = 'USB'

            self.mode_var.set(mode)
            # Trigger mode change handler to update bandwidth and presets
            self.on_mode_changed()

        # Apply changes if connected
        if self.connected:
            self.apply_frequency()

        self.log_status(f"Tuned to {selected_band} band: {center_freq/1e6:.6f} MHz")

        # Reset dropdown to empty after selection
        self.band_selector_var.set("")

    def update_band_selector(self, freq_hz: int):
        """Update band selector dropdown to show the current band without triggering action.

        Args:
            freq_hz: Current frequency in Hz
        """
        if not self.bands:
            return

        # Find matching band
        for band in self.bands:
            if band['start'] <= freq_hz <= band['end']:
                # Set dropdown value without triggering the callback
                current_value = self.band_selector_var.get()
                band_label = band.get('label', 'Unknown')

                # Only update if different to avoid unnecessary updates
                if current_value != band_label:
                    self.band_selector_var.set(band_label)
                return

        # No matching band - clear selection
        if self.band_selector_var.get() != "":
            self.band_selector_var.set("")

    def update_bookmark_selector(self, freq_hz: int):
        """Update bookmark selector dropdown to show matching bookmark without triggering action.

        Args:
            freq_hz: Current frequency in Hz
        """
        if not self.bookmarks:
            return

        # Get current mode
        try:
            current_mode = self.mode_var.get().upper()
        except:
            current_mode = None

        # Find matching bookmark (must match both frequency and mode)
        for bookmark in self.bookmarks:
            bookmark_freq = bookmark.get('frequency')
            bookmark_mode = bookmark.get('mode', 'USB').upper()

            # Check if frequency matches (within 1 kHz tolerance)
            if bookmark_freq and abs(freq_hz - bookmark_freq) < 1000:
                # Check if mode matches
                if current_mode and bookmark_mode == current_mode:
                    # Set dropdown value without triggering the callback
                    current_value = self.bookmark_var.get()
                    bookmark_name = bookmark.get('name', 'Unnamed')

                    # Only update if different to avoid unnecessary updates
                    if current_value != bookmark_name:
                        self.bookmark_var.set(bookmark_name)
                    return

        # No matching bookmark - clear selection
        if self.bookmark_var.get() != "":
            self.bookmark_var.set("")

    def apply_frequency(self, skip_auto_mode=False):
        """Apply frequency change by sending tune message.

        Args:
            skip_auto_mode: If True, skip automatic mode switching based on frequency
        """
        if not self.connected or not self.client:
            return

        try:
            freq_hz = self.get_frequency_hz()

            # Validate frequency range: 100 kHz to 30 MHz
            if freq_hz < 100000:  # 100 kHz
                messagebox.showerror("Invalid Frequency", "Frequency must be at least 100 kHz")
                return
            if freq_hz > 30000000:  # 30 MHz
                messagebox.showerror("Invalid Frequency", "Frequency must not exceed 30 MHz")
                return

            self.client.frequency = freq_hz

            # Update band button highlighting
            self.update_band_buttons(freq_hz)

            # Reset NR2 learning when frequency changes (noise profile will be different)
            if self.client.nr2_enabled and self.client.nr2_processor:
                self.client.nr2_processor.reset_learning()
                self.log_status("NR2 relearning noise profile (frequency changed)")

            # Auto-select appropriate mode based on frequency (LSB < 10 MHz, USB >= 10 MHz)
            # Only auto-switch for SSB modes (USB/LSB) and if mode is not locked
            # Skip auto-switching when tuning from bookmarks (they have their own mode)
            if not skip_auto_mode and not self.mode_lock_var.get():
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

            # Update waterfall window's spectrum if open
            if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
                self.waterfall_spectrum.update_center_frequency(freq_hz)
            if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
                self.waterfall_waterfall.update_center_frequency(freq_hz)

            # Send tune message
            # self.log_status(f"Tuning to {freq_hz/1e6:.6f} MHz...")  # Removed: too verbose during rapid frequency changes
            self.send_tune_message()

            # Sync to rigctl if enabled
            if self.rigctl_sync_enabled:
                self.sync_frequency_to_rigctl()
        except ValueError as e:
            messagebox.showerror("Error", f"Invalid frequency: {e}")

    def _parse_mode_name(self, mode_display: str) -> str:
        """Parse mode display name to actual mode name.

        Args:
            mode_display: Display name from dropdown (e.g., "IQ (48 kHz)" or "USB")

        Returns:
            Actual mode name for server (e.g., "iq48" or "usb")
        """
        # Extract actual mode name (handle both "IQ48" and "IQ (48 kHz)" formats)
        if '(' in mode_display:
            mode = mode_display.split()[0].lower()  # "IQ (48 kHz)" -> "iq"
            # Map display format to actual mode
            if '48' in mode_display:
                mode = 'iq48'
            elif '96' in mode_display:
                mode = 'iq96'
            elif '192' in mode_display:
                mode = 'iq192'
            elif '384' in mode_display:
                mode = 'iq384'
        else:
            mode = mode_display.lower()
        return mode

    def select_mode(self, mode_value: str):
        """Handle mode button click."""
        # Update mode variable
        self.mode_var.set(mode_value)
        
        # Update button states
        self.update_mode_buttons()
        
        # Trigger mode change handler
        self.on_mode_changed()

    def update_mode_buttons(self):
        """Update mode button styles based on current selection."""
        current_mode = self.mode_var.get().upper()
        
        for mode_value, button in self.mode_buttons.items():
            if mode_value.upper() == current_mode:
                button.configure(style='ModeActive.TButton')
            else:
                button.configure(style='Mode.TButton')

    def on_mode_changed(self, skip_apply=False):
        """Handle mode change - updates bandwidth and presets immediately."""
        mode_display = self.mode_var.get()
        mode = self._parse_mode_name(mode_display)

        # Update mode button styles
        self.update_mode_buttons()

        # Update bookmark selector when mode changes (bookmarks match freq + mode)
        try:
            freq_hz = self.get_frequency_hz()
            self.update_bookmark_selector(freq_hz)
        except ValueError:
            pass  # Ignore if frequency is invalid

        # Disable audio filter only if mode actually changed (silently, without validation)
        # because bandwidth ranges change and filter settings may become invalid
        if self.last_mode is not None and self.last_mode != mode:
            if self.audio_filter_enabled_var.get():
                self.audio_filter_enabled_var.set(False)
                # Disable directly in client without calling toggle_audio_filter
                if self.client:
                    self.client.audio_filter_enabled = False
                # Update audio spectrum display
                if self.audio_spectrum_display:
                    self.audio_spectrum_display.update_audio_filter(False,
                        int(self.audio_filter_low_var.get()),
                        int(self.audio_filter_high_var.get()))
                self.log_status("Audio filter disabled (mode changed)")
        
        # Update last mode
        self.last_mode = mode

        # Check if this is an IQ mode
        is_iq_mode = mode in ['iq', 'iq48', 'iq96', 'iq192', 'iq384']

        if is_iq_mode:
            # IQ mode: mute audio and disable audio controls
            self.volume_var.set(0)
            self.volume_scale.config(state='disabled')
            self.volume_label.config(text="Muted")

            # Disable channel checkboxes
            self.left_check.config(state='disabled')
            self.right_check.config(state='disabled')

            # Disable EQ
            if self.eq_display and self.eq_display.is_enabled():
                self.eq_display.enabled_var.set(False)
                self.eq_display.on_enable_changed()
            if self.eq_btn:
                self.eq_btn.config(state='disabled')

            # Disable NR2
            if self.nr2_enabled_var.get():
                self.nr2_enabled_var.set(False)
                self.toggle_nr2()
            self.nr2_check.config(state='disabled')

            # Disable audio filter (silently, without validation)
            if self.audio_filter_enabled_var.get():
                self.audio_filter_enabled_var.set(False)
                # Disable directly in client without calling toggle_audio_filter
                if self.client:
                    self.client.audio_filter_enabled = False
                # Update audio spectrum display
                if self.audio_spectrum_display:
                    self.audio_spectrum_display.update_audio_filter(False,
                        int(self.audio_filter_low_var.get()),
                        int(self.audio_filter_high_var.get()))
                self.log_status("Audio filter disabled (IQ mode)")
            self.filter_check.config(state='disabled')

            # Disable recording
            if self.recording:
                self.stop_recording()
            self.rec_btn.config(state='disabled')

            # Close audio spectrum window if open and disable button
            if self.audio_spectrum_window and self.audio_spectrum_window.winfo_exists():
                self.audio_spectrum_window.destroy()
                self.audio_spectrum_window = None
                self.audio_spectrum_display = None
                self.log_status("Audio spectrum window closed (IQ mode)")

            # Disable audio spectrum button
            if self.audio_spectrum_btn:
                self.audio_spectrum_btn.config(state='disabled')

            self.log_status(f"IQ mode selected - audio output disabled (data still sent to FIFO)")
        else:
            # Non-IQ mode: re-enable audio controls
            self.volume_scale.config(state='normal')
            if self.volume_var.get() == 0:
                self.volume_var.set(70)
            self.volume_label.config(text=f"{self.volume_var.get()}%")

            # Re-enable channel checkboxes
            self.left_check.config(state='normal')
            self.right_check.config(state='normal')

            # Re-enable EQ button
            if self.eq_btn:
                self.eq_btn.config(state='normal')

            # Re-enable NR2 checkbox
            self.nr2_check.config(state='normal')

            # Re-enable audio filter checkbox
            self.filter_check.config(state='normal')

            # Re-enable recording if connected
            if self.connected:
                self.rec_btn.config(state='normal')

            # Re-enable audio spectrum button
            if self.audio_spectrum_btn:
                self.audio_spectrum_btn.config(state='normal')

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

        mode_display = self.mode_var.get()
        mode = self._parse_mode_name(mode_display)
        self.client.mode = mode

        # Reset NR2 learning when mode changes (noise profile will be different)
        if self.client.nr2_enabled and self.client.nr2_processor:
            self.client.nr2_processor.reset_learning()
            self.log_status("NR2 relearning noise profile (mode changed)")

        self.log_status(f"Switching to {mode.upper()} mode...")
        self.send_tune_message()

        # Sync mode to rigctl if enabled and direction is SDR→Rig
        if self.rigctl_sync_enabled and self.rigctl_sync_direction_var.get() == "SDR→Rig":
            self.sync_mode_to_rigctl()

    def apply_bandwidth(self):
        """Apply bandwidth change by sending tune message."""
        if not self.connected or not self.client:
            return

        low = self.bw_low_var.get()
        high = self.bw_high_var.get()
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

        # Update waterfall window's spectrum and waterfall if open
        if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
            self.waterfall_spectrum.update_bandwidth(low, high)
        if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
            self.waterfall_waterfall.update_bandwidth(low, high)

        self.log_status(f"Adjusting bandwidth to {low} to {high} Hz...")
        self.send_tune_message()

    def update_volume(self, value):
        """Update volume level."""
        volume = int(float(value))
        self.volume_label.config(text=f"{volume}%")

        # Apply volume to client if connected
        if self.client:
            # Convert percentage (0-100) to gain (0.0-2.0)
            # 100% = 1.0 gain, 200% = 2.0 gain
            self.client.volume = volume / 100.0

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
                # For LSB/CWL modes, bandwidth is negative (e.g., -2700 to -50)
                # but audio filter works with positive frequencies (50 to 2700)
                margin = 0.1

                # Check if both values are negative (LSB or CWL mode)
                if low < 0 and high < 0:
                    # Swap abs values since bandwidth is backwards for LSB/CWL
                    range_min = max(0, int(abs_high * (1 - margin)))
                    range_max = int(abs_low * (1 + margin))
                else:
                    # USB and other modes - use normal order
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
            if enabled:
                # Only validate and set up filter when enabling
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

                    # Check if both values are negative (LSB or CWL mode)
                    if bw_low < 0 and bw_high < 0:
                        # LSB/CWL: bandwidth is backwards (e.g., -2700 to -50)
                        # Audio filter needs normal order (50 to 2700)
                        default_low = int(abs_high * (1 + margin))
                        default_high = int(abs_low * (1 - margin))
                    else:
                        # USB and other modes - use normal order
                        default_low = int(abs_low * (1 + margin))
                        default_high = int(abs_high * (1 - margin))

                    # Ensure low < high
                    if default_low >= default_high:
                        if bw_low < 0 and bw_high < 0:
                            default_low = int(abs_high)
                            default_high = int(abs_low)
                        else:
                            default_low = int(abs_low)
                            default_high = int(abs_high)

                # Update slider values to reasonable defaults
                self.audio_filter_low_var.set(default_low)
                self.audio_filter_high_var.set(default_high)

                # Update display
                self.update_audio_filter_display()

                # Use the default values we just calculated (not read from sliders)
                low = float(default_low)
                high = float(default_high)

                # Validate parameters only when enabling
                if low <= 0 or high <= 0:
                    messagebox.showerror("Error", "Filter frequencies must be positive")
                    self.audio_filter_enabled_var.set(False)
                    return
                if low >= high:
                    messagebox.showerror("Error", "Low frequency must be less than high frequency")
                    self.audio_filter_enabled_var.set(False)
                    return

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
                # Get current filter values for display update
                low = int(self.audio_filter_low_var.get())
                high = int(self.audio_filter_high_var.get())
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

    def on_spectrum_mode_change(self, mode: str):
        """Handle mode change from spectrum bookmark click.
        
        Args:
            mode: Mode string from bookmark (e.g., 'USB', 'LSB', 'CW')
        """
        # Only change mode if not locked
        if self.mode_lock_var.get():
            return
        
        # Map mode names (bookmark might use different case)
        mode_map = {
            'USB': 'USB', 'LSB': 'LSB', 'AM': 'AM', 'SAM': 'SAM',
            'CWU': 'CWU', 'CWL': 'CWL', 'FM': 'FM', 'NFM': 'NFM',
            'IQ': 'IQ', 'IQ48': 'IQ48', 'IQ96': 'IQ96',
            'IQ192': 'IQ192', 'IQ384': 'IQ384'
        }
        mapped_mode = mode_map.get(mode.upper(), 'USB')
        self.mode_var.set(mapped_mode)
        self.on_mode_changed()
        
        # Apply mode change if connected
        if self.connected:
            self.apply_mode()

    def on_scroll_mode_changed(self):
        """Handle scroll mode change (zoom vs pan)."""
        mode = self.scroll_mode_var.get()

        # Update spectrum display scroll mode
        if self.spectrum:
            self.spectrum.set_scroll_mode(mode)

        # Update waterfall display scroll mode
        if self.waterfall_display:
            self.waterfall_display.set_scroll_mode(mode)

        # Update waterfall window's spectrum and waterfall if open
        if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
            self.waterfall_spectrum.set_scroll_mode(mode)
        if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
            self.waterfall_waterfall.set_scroll_mode(mode)

        self.log_status(f"Scroll mode: {mode}")

    def unmute_audio(self):
        """Unmute audio after main window opens."""
        if self.client and hasattr(self.client, '_desired_volume'):
            desired_volume = self.client._desired_volume
            self.client.volume = desired_volume
            self.log_status("Audio enabled")

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
                        # Only set if different from current value
                        if self.digital_spots_display.band_filter.get() != band_name:
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
                        # Only set if different from current value
                        if self.cw_spots_display.band_var.get() != band_name:
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
        """Ensure shared DX cluster WebSocket manager exists (connection is automatic)."""
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
                # Note: Connection happens automatically when first callback is registered
                self.log_status("DX cluster WebSocket manager created")
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
                        # Only set if different from current value
                        if self.digital_spots_display.band_filter.get() != band_name:
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
                        # Only set if different from current value
                        if self.cw_spots_display.band_var.get() != band_name:
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

    def open_band_conditions_window(self):
        """Open a separate band conditions display window."""
        # Don't open multiple windows
        if self.band_conditions_window and self.band_conditions_window.winfo_exists():
            self.band_conditions_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            from band_conditions_display import create_band_conditions_window

            # Get server URL and TLS setting
            server = self.server_var.get()
            use_tls = self.tls_var.get()

            # Create band conditions window
            self.band_conditions_display = create_band_conditions_window(self.root, server, use_tls)
            self.band_conditions_window = self.band_conditions_display.window

            self.log_status("Band conditions window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open band conditions: {e}")
            self.log_status(f"ERROR: Failed to open band conditions - {e}")

    def open_space_weather_window(self):
        """Open a separate space weather display window."""
        # Don't open multiple windows
        if self.space_weather_window and self.space_weather_window.winfo_exists():
            self.space_weather_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            from space_weather_display import create_space_weather_window

            # Get server URL and TLS setting
            server = self.server_var.get()
            use_tls = self.tls_var.get()

            # Get GPS coordinates and location from client
            gps_coords = None
            location_name = None
            if self.client and hasattr(self.client, 'server_description'):
                desc = self.client.server_description
                if desc.get('receiver', {}).get('gps'):
                    gps = desc['receiver']['gps']
                    if gps.get('lat') and gps.get('lon'):
                        gps_coords = {'lat': gps['lat'], 'lon': gps['lon']}
                if desc.get('receiver', {}).get('location'):
                    location_name = desc['receiver']['location']

            # Create space weather window
            self.space_weather_display = create_space_weather_window(
                self.root, server, use_tls, gps_coords, location_name
            )
            self.space_weather_window = self.space_weather_display.window

            self.log_status("Space weather window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open space weather: {e}")
            self.log_status(f"ERROR: Failed to open space weather - {e}")

    def open_eq_window(self):
        """Open the 10-band equalizer window."""
        # Check if window exists and is visible
        if self.eq_display and self.eq_display.window and self.eq_display.window.winfo_exists():
            self.eq_display.show()  # Bring to front
            return

        try:
            from eq_display import create_eq_window

            # Create EQ window with callback
            self.eq_display = create_eq_window(self.root, self.on_eq_changed)
            self.eq_window = self.eq_display.window

            self.log_status("EQ window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open EQ: {e}")
            self.log_status(f"ERROR: Failed to open EQ - {e}")

    def on_eq_changed(self, band_gains: dict):
        """Handle EQ changes from the EQ window.

        Args:
            band_gains: Dictionary of {frequency: gain_db} or None if disabled
        """
        if not self.client:
            return

        if band_gains is None:
            # EQ disabled
            self.client.eq_enabled = False
            self.log_status("EQ disabled")
        else:
            # EQ enabled with new gains
            self.client.eq_enabled = True
            self.client.update_eq(band_gains)
            self.log_status(f"EQ enabled: {len(band_gains)} bands")

    def open_midi_window(self):
        """Open MIDI controller configuration window."""
        # Check if controller exists but window is hidden
        if self.midi_controller and self.midi_controller.window:
            # Window exists but is hidden - show it
            self.midi_controller.window.deiconify()
            self.midi_controller.window.lift()
            self.midi_window = self.midi_controller.window

            # Update status label when reopening
            if self.midi_controller.midi_in and self.midi_controller.running:
                self.midi_controller.status_label.config(text="Connected", foreground='green')
            else:
                self.midi_controller.status_label.config(text="Not connected", foreground='red')

            self.log_status("MIDI controller window reopened")
            return

        # Check if window is already open
        if self.midi_window and self.midi_window.winfo_exists():
            self.midi_window.lift()  # Bring to front
            return

        try:
            # Check if controller already exists (from auto-init)
            if self.midi_controller:
                # Controller exists, just create window for it
                self.midi_controller.create_window(self.root)
                self.midi_window = self.midi_controller.window
                self.log_status("MIDI controller window opened")
            else:
                # No controller yet, create new one with window
                from midi_controller import create_midi_window
                self.midi_controller = create_midi_window(self)
                self.midi_window = self.midi_controller.window
                self.log_status("MIDI controller window opened")

        except ImportError as e:
            messagebox.showerror("Error", "MIDI support not available. Install python-rtmidi:\npip install python-rtmidi")
            self.log_status(f"ERROR: MIDI not available - {e}")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to open MIDI window: {e}")
            self.log_status(f"ERROR: Failed to open MIDI window - {e}")

    def auto_init_midi(self):
        """Auto-initialize MIDI controller on startup if config exists."""
        try:
            import os
            config_file = os.path.expanduser("~/.ubersdr_midi_mappings.json")

            # Only auto-init if config file exists
            if os.path.exists(config_file):
                from midi_controller import MIDIController

                # Create controller without window
                self.midi_controller = MIDIController(self)

                # Log what was loaded
                if self.midi_controller.mappings:
                    self.log_status(f"MIDI: Loaded {len(self.midi_controller.mappings)} mapping(s)")

                # Try to auto-connect to saved device (even if no mappings yet)
                if self.midi_controller.last_device_name or self.midi_controller.mappings:
                    try:
                        import rtmidi
                        midi_in = rtmidi.MidiIn()
                        ports = midi_in.get_ports()

                        if ports:
                            # Try to find saved device first
                            port_index = 0
                            if self.midi_controller.last_device_name:
                                try:
                                    port_index = ports.index(self.midi_controller.last_device_name)
                                    self.log_status(f"MIDI: Found saved device: {self.midi_controller.last_device_name}")
                                except ValueError:
                                    # Saved device not found, use first available
                                    self.log_status(f"MIDI: Saved device '{self.midi_controller.last_device_name}' not found, using: {ports[0]}")
                            else:
                                self.log_status(f"MIDI: No saved device, using: {ports[0]}")

                            # Connect to device
                            self.midi_controller.midi_in = midi_in
                            midi_in.open_port(port_index)
                            midi_in.set_callback(self.midi_controller.on_midi_message)
                            self.midi_controller.running = True
                            self.log_status(f"MIDI: Auto-connected to {ports[port_index]}")
                        else:
                            del midi_in
                            self.log_status("MIDI: No devices available")
                    except Exception as e:
                        self.log_status(f"MIDI: Auto-connect failed - {e}")

        except ImportError:
            # MIDI not available, skip silently
            pass
        except Exception as e:
            # Other errors, log but don't show error dialog
            print(f"MIDI auto-init error: {e}")

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
            'nfm': (-5000, 5000),
            'iq': (-5000, 5000),
            'iq48': (-5000, 5000),
            'iq96': (-5000, 5000),
            'iq192': (-5000, 5000),
            'iq384': (-5000, 5000)
        }

        # Get defaults for current mode
        if mode in mode_defaults:
            low, high = mode_defaults[mode]
            self.bw_low_var.set(low)
            self.bw_high_var.set(high)

            # Update labels
            self.bw_low_label.config(text=f"{low} Hz")
            self.bw_high_label.config(text=f"{high} Hz")

            # Update slider bounds for the mode
            self.update_bandwidth_slider_bounds(mode)

            # Update spectrum display bandwidth visualization
            if self.spectrum:
                self.spectrum.update_bandwidth(low, high)

            # Update waterfall display bandwidth visualization
            if self.waterfall_display:
                self.waterfall_display.update_bandwidth(low, high)

            # Update audio spectrum display bandwidth
            if self.audio_spectrum_display:
                self.audio_spectrum_display.update_bandwidth(low, high)

            # Update waterfall window's spectrum and waterfall if open
            if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
                self.waterfall_spectrum.update_bandwidth(low, high)
            if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
                self.waterfall_waterfall.update_bandwidth(low, high)

            # Only update client if it exists (connected)
            if self.client:
                self.client.bandwidth_low = low
                self.client.bandwidth_high = high
            self.log_status(f"Bandwidth set for {mode.upper()}: {low} to {high} Hz")
        else:
            # Unknown mode - keep current bandwidth
            self.log_status(f"Unknown mode {mode.upper()} - keeping current bandwidth")

    def update_bandwidth_slider_bounds(self, mode: str):
        """Update bandwidth slider bounds based on mode.

        Args:
            mode: Current mode (e.g., 'usb', 'lsb', 'am', etc.)
        """
        # Mode-specific slider bounds (low_min, low_max, high_min, high_max)
        mode_bounds = {
            'am': (-10000, -200, 200, 10000),
            'sam': (-10000, -200, 200, 10000),
            'usb': (0, 200, 400, 4000),
            'lsb': (-400, -4000, 0, -200),
            'fm': (-10000, -200, 200, 10000),
            'nfm': (-5000, -200, 200, 5000),
            'cwu': (-100, -500, 100, 500),
            'cwl': (-100, -500, 100, 500),
        }

        # Check if this is an IQ mode
        is_iq_mode = mode in ['iq', 'iq48', 'iq96', 'iq192', 'iq384']

        if is_iq_mode:
            # Disable sliders for IQ modes
            self.bw_low_scale.config(state='disabled')
            self.bw_high_scale.config(state='disabled')
            # Only log if status_text exists (after full initialization)
            if hasattr(self, 'status_text'):
                self.log_status(f"Bandwidth sliders disabled for {mode.upper()} mode")
        else:
            # Enable sliders for non-IQ modes
            self.bw_low_scale.config(state='normal')
            self.bw_high_scale.config(state='normal')

            # Get bounds for current mode
            if mode in mode_bounds:
                low_min, low_max, high_min, high_max = mode_bounds[mode]

                # Update slider ranges
                self.bw_low_scale.config(from_=low_min, to=low_max)
                self.bw_high_scale.config(from_=high_min, to=high_max)

                # Only log if status_text exists (after full initialization)
                if hasattr(self, 'status_text'):
                    self.log_status(f"Bandwidth bounds for {mode.upper()}: Low [{low_min} to {low_max}], High [{high_min} to {high_max}]")
            else:
                # Unknown mode - use default wide range
                self.bw_low_scale.config(from_=-10000, to=10000)
                self.bw_high_scale.config(from_=-10000, to=10000)

    def update_preset_buttons(self):
        """Update bandwidth preset buttons based on current mode."""
        mode_display = self.mode_var.get()
        mode = self._parse_mode_name(mode_display)

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

        # Create buttons on first call, otherwise just update their commands
        if not self.preset_buttons:
            # Create preset buttons for the first time
            for i, (label, low, high) in enumerate(presets):
                btn = ttk.Button(self.preset_frame, text=label, width=8,
                               command=lambda l=low, h=high: self.set_bandwidth(l, h))
                btn.grid(row=0, column=i+1, padx=2)
                self.preset_buttons.append(btn)
        else:
            # Update existing button commands with new preset values
            for i, (label, low, high) in enumerate(presets):
                if i < len(self.preset_buttons):
                    self.preset_buttons[i].config(command=lambda l=low, h=high: self.set_bandwidth(l, h))

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

                # self.log_status(f"Sent tune: {self.client.frequency/1e6:.3f} MHz {self.client.mode.upper()} ({self.client.bandwidth_low} to {self.client.bandwidth_high} Hz)")  # Removed: too verbose during rapid frequency changes
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
            mode_display = self.mode_var.get()
            mode = self._parse_mode_name(mode_display)

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

            # Get output mode from config (defaults to pipewire if not specified)
            output_mode = self.config.get('output_mode', 'pipewire')

            # Create client (disable auto_reconnect for GUI - we'll handle retries)
            # Start with audio muted (volume=0) - will be enabled after window opens
            self.client = RadioClient(
                url=url,
                host=host,
                port=port,
                frequency=frequency,
                mode=mode,
                bandwidth_low=bandwidth_low,
                bandwidth_high=bandwidth_high,
                output_mode=output_mode,
                auto_reconnect=False,  # GUI handles connection attempts
                status_callback=lambda msg_type, msg: self.status_queue.put((msg_type, msg)),
                volume=0,  # Start muted, will unmute after window opens
                channel_left=channel_left,
                channel_right=channel_right,
                audio_level_callback=lambda level_db: self.audio_level_queue.put(level_db),
                recording_callback=self.add_recording_frame,
                ssl=self.tls_var.get(),  # Use TLS if checkbox is checked
                fifo_path=fifo_path  # Pass FIFO path to client
            )
            
            # Log the output mode being used
            self.log_status(f"Audio output mode: {output_mode}")

            # Store the desired volume to restore after window opens
            self.client._desired_volume = volume

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

    def disconnect(self):
        """Stop the radio client connection."""
        if self.client:
            self.client.running = False
            self.log_status("Disconnecting...")

        # Stop band state polling
        self.stop_band_state_polling()

        # Close waterfall window (which will disconnect its spectrum and waterfall)
        if self.waterfall_window and self.waterfall_window.winfo_exists():
            self.waterfall_window.destroy()
            self.waterfall_window = None
            self.waterfall_display = None
            self.log_status("Waterfall window closed")

        # Close audio spectrum window
        if self.audio_spectrum_window and self.audio_spectrum_window.winfo_exists():
            self.audio_spectrum_window.destroy()
            self.audio_spectrum_window = None
            self.audio_spectrum_display = None
            self.log_status("Audio spectrum window closed")

        # Close digital spots window
        if self.digital_spots_window and self.digital_spots_window.winfo_exists():
            self.digital_spots_window.destroy()
            self.digital_spots_window = None
            self.digital_spots_display = None
            self.log_status("Digital spots window closed")

        # Close CW spots window
        if self.cw_spots_window and self.cw_spots_window.winfo_exists():
            self.cw_spots_window.destroy()
            self.cw_spots_window = None
            self.cw_spots_display = None
            self.log_status("CW spots window closed")

        # Close band conditions window
        if self.band_conditions_window and self.band_conditions_window.winfo_exists():
            self.band_conditions_window.destroy()
            self.band_conditions_window = None
            self.band_conditions_display = None
            self.log_status("Band conditions window closed")

        # Close space weather window
        if self.space_weather_window and self.space_weather_window.winfo_exists():
            self.space_weather_window.destroy()
            self.space_weather_window = None
            self.space_weather_display = None
            self.log_status("Space weather window closed")

        # Close EQ window
        if self.eq_window and self.eq_window.winfo_exists():
            self.eq_window.destroy()
            self.eq_window = None
            self.eq_display = None
            self.log_status("EQ window closed")

        # Clean up shared DX cluster WebSocket manager
        # Note: Actual disconnection happens automatically when last callback is removed
        if self.dxcluster_ws:
            # Force disconnect in case there are lingering connections
            if self.dxcluster_ws.running:
                self.dxcluster_ws.disconnect()
            self.dxcluster_ws = None
            self.log_status("DX cluster WebSocket manager cleaned up")

        # Disconnect main spectrum display (in main window)
        if self.spectrum:
            self.spectrum.disconnect()
            self.log_status("Spectrum display disconnected")

        # Clear waterfall spectrum/waterfall references
        if hasattr(self, 'waterfall_spectrum'):
            self.waterfall_spectrum = None
        if hasattr(self, 'waterfall_waterfall'):
            self.waterfall_waterfall = None

        # Update UI
        self.connected = False
        self.connect_btn.config(text="Connect")
        self.apply_freq_btn.state(['disabled'])
        self.rec_btn.state(['disabled'])

        # Hide receiver info and session timer
        self.receiver_info_frame.grid_remove()
        self.receiver_name_var.set("")
        self.receiver_version_var.set("")
        self.stop_session_timer()

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
                        self.rec_btn.state(['!disabled'])
                        if "✓" not in msg:  # Don't duplicate success message
                            self.log_status("✓ Successfully connected!")

                        # Update receiver info (name, version, map link) and session timer
                        if self.client and hasattr(self.client, 'server_description'):
                            desc = self.client.server_description
                            
                            # Get receiver name and truncate to 50 chars
                            receiver_name = desc.get('receiver', {}).get('name', '')
                            if receiver_name and len(receiver_name) > 50:
                                receiver_name = receiver_name[:47] + '...'
                            
                            # Get version from root of JSON
                            version = desc.get('version', '')
                            
                            # Get public_url from receiver object in JSON
                            public_url = desc.get('receiver', {}).get('public_url', '')
                            
                            # Get GPS coordinates
                            gps = desc.get('receiver', {}).get('gps', {})
                            has_gps = gps.get('lat') is not None and gps.get('lon') is not None
                            
                            # Update display if we have any info
                            if receiver_name or version or has_gps:
                                if receiver_name:
                                    self.receiver_name_var.set(receiver_name)
                                    
                                    # Make receiver name clickable if public_url is not default
                                    if public_url and public_url != 'https://example.com':
                                        self.receiver_name_label.config(foreground='blue', cursor='hand2')
                                        self.receiver_name_label.bind('<Button-1>', self.open_receiver_url)
                                    else:
                                        self.receiver_name_label.config(foreground='black', cursor='')
                                        self.receiver_name_label.unbind('<Button-1>')
                                
                                if version:
                                    self.receiver_version_var.set(f"v{version}")
                                
                                # Show/hide map link based on GPS availability
                                if has_gps:
                                    self.receiver_map_link.pack(side=tk.LEFT)
                                    self.receiver_delimiter2.pack(side=tk.LEFT, before=self.receiver_map_link)
                                else:
                                    self.receiver_map_link.pack_forget()
                                    self.receiver_delimiter2.pack_forget()
                                
                                # Show the receiver info frame
                                self.receiver_info_frame.grid()

                        # Check bypassed status and show/hide second row of mode buttons
                        if self.client and hasattr(self.client, 'bypassed'):
                            self.bypassed = self.client.bypassed
                            if self.bypassed:
                                # Show second row of IQ bandwidth buttons
                                for btn in self.mode_buttons_row2:
                                    btn.grid()
                                self.log_status("High bandwidth IQ modes enabled (bypassed connection)")
                            else:
                                # Hide second row of IQ bandwidth buttons
                                for btn in self.mode_buttons_row2:
                                    btn.grid_remove()

                        # Start session timer (always show, displays "Unlimited" if max_session_time=0)
                        if self.client and hasattr(self.client, 'max_session_time'):
                            self.max_session_time = self.client.max_session_time
                            if hasattr(self.client, 'connection_start_time'):
                                self.connection_start_time = self.client.connection_start_time
                            self.log_status(f"DEBUG: max_session_time={self.max_session_time}, connection_start_time={self.connection_start_time}")
                            self.start_session_timer()

                        # Show spots buttons based on server capabilities
                        if self.client and hasattr(self.client, 'server_description'):
                            desc = self.client.server_description

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

                            # Print loading message before opening GUI windows
                            print("Loading GUI (may take a moment)...", file=sys.stderr)

                            # Auto-open waterfall window first (main display window)
                            if WATERFALL_AVAILABLE:
                                # Open waterfall after GUI is fully ready (5000ms delay)
                                # This ensures all Tkinter widgets are properly initialized
                                def open_waterfall_and_unmute():
                                    try:
                                        # Force GUI update before opening waterfall
                                        self.root.update_idletasks()
                                        self.auto_open_waterfall()
                                        # Unmute audio after waterfall window opens (500ms delay)
                                        self.root.after(500, self.unmute_audio)
                                    except Exception as e:
                                        # If waterfall fails to open, still unmute audio
                                        self.log_status(f"Waterfall auto-open failed: {e}")
                                        self.unmute_audio()
                                self.root.after(5000, open_waterfall_and_unmute)

                            # Auto-open audio spectrum window on successful connection
                            if AUDIO_SPECTRUM_AVAILABLE:
                                # Delay audio spectrum opening slightly
                                self.root.after(600, self.auto_open_audio_spectrum)

                            # Auto-open CW spots window if enabled (disabled by default)
                            # Add 2000ms delay (same as spectrum) before connecting DX cluster WebSocket
                            # if self.client and hasattr(self.client, 'server_description'):
                            #     desc = self.client.server_description
                            #     if CW_SPOTS_AVAILABLE and desc.get('cw_skimmer', False):
                            #         self.root.after(2800, self.auto_open_cw_spots)

                            # Start band state polling after connection is established
                            # Add delay to allow other connections to establish first
                            self.root.after(3000, self.start_band_state_polling)

                elif msg_type == "error":
                    self.log_status(f"ERROR: {msg}")
                elif msg_type == "server_error":
                    # Server error - show alert box AND log to status
                    self.log_status(f"SERVER ERROR: {msg}")
                    messagebox.showerror("Server Error", msg)
                elif msg_type == "connection_failed":
                    # Connection attempt failed
                    self.connected = False
                    self.connecting = False
                    self.connect_btn.config(text="Connect", state='normal')
                    self.cancel_btn.grid_remove()  # Hide cancel button
                    self.apply_freq_btn.state(['disabled'])
                    self.log_status("✗ Connection failed")
                elif msg_type == "connection_cancelled":
                    # Connection cancelled by user
                    self.connected = False
                    self.connecting = False
                    self.connect_btn.config(text="Connect", state='normal')
                    self.cancel_btn.grid_remove()  # Hide cancel button
                    self.apply_freq_btn.state(['disabled'])
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

    def toggle_rigctl_connection(self):
        """Connect or disconnect from rigctld."""
        if not self.rigctl_connected:
            self.connect_rigctl()
        else:
            self.disconnect_rigctl()

    def connect_rigctl(self):
        """Connect to rigctld server."""
        try:
            host = self.rigctl_host_var.get().strip()
            port_str = self.rigctl_port_var.get().strip()

            if not host or not port_str:
                messagebox.showerror("Error", "Please enter rigctl host and port")
                return

            try:
                port = int(port_str)
            except ValueError:
                messagebox.showerror("Error", "Invalid port number")
                return

            # Create and connect rigctl client
            self.rigctl = RigctlClient(host, port)
            self.rigctl.connect()

            self.rigctl_connected = True
            self.rigctl_connect_btn.config(text="Disconnect Rig")
            self.log_status(f"✓ Connected to rigctld at {host}:{port}")

            # Start syncing immediately with selected direction
            self.start_rigctl_sync()

        except Exception as e:
            messagebox.showerror("Error", f"Failed to connect to rigctld: {e}")
            self.log_status(f"ERROR: Failed to connect to rigctld - {e}")
            if self.rigctl:
                self.rigctl.disconnect()
                self.rigctl = None

    def disconnect_rigctl(self):
        """Disconnect from rigctld server."""
        if self.rigctl:
            self.rigctl.disconnect()
            self.rigctl = None

        self.rigctl_connected = False
        self.rigctl_sync_enabled = False

        # Stop polling if active
        if self.rigctl_poll_job:
            self.root.after_cancel(self.rigctl_poll_job)
            self.rigctl_poll_job = None

        self.rigctl_connect_btn.config(text="Connect Rig")
        self.log_status("Disconnected from rigctld")

    def on_rigctl_sync_direction_changed(self):
        """Handle sync direction change - restart sync if active."""
        if self.rigctl_sync_enabled:
            # Stop current sync mode
            self.stop_rigctl_sync()
            # Re-enable sync flag (stop_rigctl_sync sets it to False)
            self.rigctl_sync_enabled = True
            # Start sync with new direction
            direction = self.rigctl_sync_direction_var.get()
            if direction == "SDR→Rig":
                self.log_status("Rigctl sync direction changed - radio will follow SDR frequency")
                self.sync_frequency_to_rigctl()
            else:  # Rig→SDR
                self.log_status("Rigctl sync direction changed - SDR will follow radio frequency")
                # Initialize last known values
                try:
                    self.rigctl_last_freq = self.rigctl.get_frequency()
                    self.rigctl_last_mode = self.rigctl.get_mode()
                except:
                    self.rigctl_last_freq = None
                    self.rigctl_last_mode = None
                # Start polling immediately
                self.poll_rigctl_frequency()

    def start_rigctl_sync(self):
        """Start syncing frequency with rigctld."""
        if not self.rigctl_connected or not self.rigctl:
            return

        self.rigctl_sync_enabled = True
        direction = self.rigctl_sync_direction_var.get()

        if direction == "SDR→Rig":
            self.log_status("Rigctl sync enabled - radio will follow SDR frequency")
            # Immediately sync current SDR frequency to rig
            self.sync_frequency_to_rigctl()
        else:  # Rig→SDR
            self.log_status("Rigctl sync enabled - SDR will follow radio frequency")
            # Initialize last known values
            try:
                self.rigctl_last_freq = self.rigctl.get_frequency()
                self.rigctl_last_mode = self.rigctl.get_mode()
            except:
                self.rigctl_last_freq = None
                self.rigctl_last_mode = None
            # Start polling immediately
            self.poll_rigctl_frequency()

    def stop_rigctl_sync(self):
        """Stop syncing frequency with rigctld."""
        self.rigctl_sync_enabled = False

        # Stop polling if active
        if self.rigctl_poll_job:
            self.root.after_cancel(self.rigctl_poll_job)
            self.rigctl_poll_job = None

        self.log_status("Rigctl sync disabled")

    def sync_frequency_to_rigctl(self):
        """Sync current SDR frequency to rigctld (called after frequency changes)."""
        if not self.rigctl_sync_enabled or not self.rigctl_connected or not self.rigctl:
            return

        # Only sync if direction is SDR→Rig
        if self.rigctl_sync_direction_var.get() != "SDR→Rig":
            return

        try:
            # Get current SDR frequency
            freq_hz = self.get_frequency_hz()

            # Set rigctl frequency
            self.rigctl.set_frequency(freq_hz)

            # Get current mode and sync it too
            mode_display = self.mode_var.get()
            mode = self._parse_mode_name(mode_display)

            # Map SDR modes to rigctl modes
            mode_map = {
                'usb': 'USB',
                'lsb': 'LSB',
                'am': 'AM',
                'sam': 'AM',
                'cwu': 'CW',
                'cwl': 'CW',
                'fm': 'FM',
                'nfm': 'FM'
            }

            rigctl_mode = mode_map.get(mode, 'USB')
            self.rigctl.set_mode(rigctl_mode)

        except Exception as e:
            self.log_status(f"Rigctl sync error: {e}")
            # Don't disable sync on error - might be temporary

    def sync_mode_to_rigctl(self):
        """Sync current SDR mode to rigctld (called after mode changes)."""
        if not self.rigctl_sync_enabled or not self.rigctl_connected or not self.rigctl:
            return

        # Only sync if direction is SDR→Rig
        if self.rigctl_sync_direction_var.get() != "SDR→Rig":
            return

        try:
            # Get current mode
            mode_display = self.mode_var.get()
            mode = self._parse_mode_name(mode_display)

            # Map SDR modes to rigctl modes
            mode_map = {
                'usb': 'USB',
                'lsb': 'LSB',
                'am': 'AM',
                'sam': 'AM',
                'cwu': 'CW',
                'cwl': 'CW',
                'fm': 'FM',
                'nfm': 'FM'
            }

            rigctl_mode = mode_map.get(mode, 'USB')
            self.rigctl.set_mode(rigctl_mode)

        except Exception as e:
            self.log_status(f"Rigctl mode sync error: {e}")
            # Don't disable sync on error - might be temporary

    def poll_rigctl_frequency(self):
        """Poll rigctl for frequency/mode changes (for Rig→SDR sync)."""
        if not self.rigctl_sync_enabled or not self.rigctl_connected or not self.rigctl:
            self.rigctl_poll_job = None
            return

        # Only poll if direction is Rig→SDR
        if self.rigctl_sync_direction_var.get() != "Rig→SDR":
            self.rigctl_poll_job = None
            return

        try:
            # Get current rig frequency and mode
            rig_freq = self.rigctl.get_frequency()
            rig_mode = self.rigctl.get_mode()

            # Check if frequency changed
            if self.rigctl_last_freq is not None and rig_freq != self.rigctl_last_freq:
                # Update SDR frequency
                self.set_frequency_hz(rig_freq)
                if self.connected:
                    self.apply_frequency()
                self.log_status(f"Synced from rig: {rig_freq/1e6:.6f} MHz")

            # Check if mode changed
            if self.rigctl_last_mode is not None and rig_mode != self.rigctl_last_mode:
                # Map rigctl mode to SDR mode
                mode_map = {
                    'USB': 'USB',
                    'LSB': 'LSB',
                    'AM': 'AM',
                    'CW': 'CWU',  # Default to CWU
                    'CWR': 'CWL',
                    'FM': 'FM'
                }
                sdr_mode = mode_map.get(rig_mode, 'USB')

                # Only update if mode lock is not enabled
                if not self.mode_lock_var.get():
                    self.mode_var.set(sdr_mode)
                    self.on_mode_changed(skip_apply=True)
                    if self.connected:
                        self.apply_mode()
                    self.log_status(f"Synced mode from rig: {rig_mode}")

            # Update last known values
            self.rigctl_last_freq = rig_freq
            self.rigctl_last_mode = rig_mode

        except Exception as e:
            # Log error but don't disable sync - might be temporary
            pass

        # Schedule next poll (100ms)
        self.rigctl_poll_job = self.root.after(100, self.poll_rigctl_frequency)

    def format_time(self, seconds: int) -> str:
        """Format seconds as MM:SS."""
        minutes = seconds // 60
        secs = seconds % 60
        return f"{minutes:02d}:{secs:02d}"

    def start_session_timer(self):
        """Start the session countdown timer."""
        self.log_status(f"DEBUG: start_session_timer called - max_session_time={self.max_session_time}, connection_start_time={self.connection_start_time}")

        # Always show the timer label when connected
        self.session_timer_label.grid()

        if self.max_session_time <= 0:
            # No time limit - show "Unlimited" in blue
            self.session_timer_var.set("Session: Unlimited")
            self.session_timer_label.config(foreground='blue')
            self.log_status("Session timer: Unlimited")
        else:
            # Has time limit - start countdown
            self.log_status(f"Session timer: {self.max_session_time} seconds")
            self.update_session_timer()

    def update_session_timer(self):
        """Update the session timer display."""
        if not self.connected:
            return

        if self.max_session_time <= 0:
            # No time limit - blue
            self.session_timer_var.set("Session: Unlimited")
            self.session_timer_label.config(foreground='blue')
            return

        if self.connection_start_time is None:
            self.log_status("DEBUG: connection_start_time is None, cannot update timer")
            return

        # Calculate elapsed time
        import time
        elapsed = time.time() - self.connection_start_time
        remaining = max(0, self.max_session_time - int(elapsed))

        # Update display
        self.session_timer_var.set(f"Session: {self.format_time(remaining)}")

        # Change color based on remaining time
        # Blue when > 5 minutes (300 seconds), red when ≤ 5 minutes
        if remaining > 300:
            self.session_timer_label.config(foreground='blue')
        else:
            self.session_timer_label.config(foreground='red')

        # Schedule next update if still connected
        if self.connected and remaining > 0:
            self.session_timer_job = self.root.after(1000, self.update_session_timer)
        elif remaining == 0:
            self.session_timer_var.set("Session: 00:00")
            self.session_timer_label.config(foreground='red')

    def stop_session_timer(self):
        """Stop the session countdown timer."""
        if self.session_timer_job:
            self.root.after_cancel(self.session_timer_job)
            self.session_timer_job = None

        # Hide the timer label
        self.session_timer_label.grid_remove()
        self.session_timer_var.set("")

    def open_receiver_url(self, event=None):
        """Open the receiver's public URL in default browser."""
        if not self.client or not hasattr(self.client, 'server_description'):
            return

        desc = self.client.server_description
        public_url = desc.get('receiver', {}).get('public_url', '')

        if not public_url or public_url == 'https://example.com':
            return

        # Open URL in default browser
        import webbrowser
        try:
            webbrowser.open(public_url)
            self.log_status(f"Opened receiver URL: {public_url}")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to open URL: {e}")
            self.log_status(f"ERROR: Failed to open URL - {e}")

    def open_receiver_map(self, event=None):
        """Open Google Maps with receiver GPS coordinates."""
        if not self.client or not hasattr(self.client, 'server_description'):
            return

        desc = self.client.server_description
        gps = desc.get('receiver', {}).get('gps', {})
        lat = gps.get('lat')
        lon = gps.get('lon')

        if lat is None or lon is None:
            messagebox.showinfo("No GPS Data", "GPS coordinates not available for this receiver")
            return

        # Open Google Maps in default browser
        import webbrowser
        maps_url = f"https://www.google.com/maps?q={lat},{lon}"
        try:
            webbrowser.open(maps_url)
            self.log_status(f"Opened map at {lat}, {lon}")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to open map: {e}")
            self.log_status(f"ERROR: Failed to open map - {e}")

    def on_closing(self):
        """Handle window close event."""
        if self.connected:
            self.disconnect()

        # Stop session timer
        self.stop_session_timer()

        # Disconnect rigctl if connected
        if self.rigctl_connected:
            self.disconnect_rigctl()

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

        # Close band conditions window if open
        if self.band_conditions_window and self.band_conditions_window.winfo_exists():
            self.band_conditions_window.destroy()

        # Close space weather window if open
        if self.space_weather_window and self.space_weather_window.winfo_exists():
            self.space_weather_window.destroy()

        # Close EQ window if open
        if self.eq_window and self.eq_window.winfo_exists():
            self.eq_window.destroy()

        # Disconnect MIDI controller if active
        if self.midi_controller:
            self.midi_controller.disconnect()
            self.midi_controller = None
        self.midi_window = None

        # Clean up shared DX cluster WebSocket manager
        if self.dxcluster_ws:
            # Force disconnect in case there are lingering connections
            if self.dxcluster_ws.running:
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

    # Auto-connect to rigctl if specified in config
    if config.get('rigctl_host') and config.get('rigctl_port'):
        # Schedule rigctl connection after GUI is ready
        def auto_connect_rigctl():
            try:
                app.connect_rigctl()
                # Sync starts automatically on connect
            except Exception as e:
                app.log_status(f"Auto-connect to rigctl failed: {e}")

        root.after(500, auto_connect_rigctl)

    root.mainloop()


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description='ka9q_ubersdr Radio GUI Client')
    parser.add_argument('--host', type=str, help='Server host')
    parser.add_argument('--port', type=int, help='Server port')
    parser.add_argument('--url', type=str, help='Server URL (alternative to host:port)')
    parser.add_argument('--frequency', type=float, help='Initial frequency in MHz')
    parser.add_argument('--mode', type=str, help='Initial mode (USB, LSB, etc.)')
    parser.add_argument('--ssl', action='store_true', help='Use TLS/SSL')
    parser.add_argument('--auto-connect', action='store_true', help='Auto-connect on startup')
    parser.add_argument('--rigctl-host', type=str, help='Rigctl host (e.g., localhost)')
    parser.add_argument('--rigctl-port', type=int, help='Rigctl port (default: 4532)')
    parser.add_argument('--rigctl-sync', action='store_true', help='Enable rigctl sync on connect')

    args = parser.parse_args()

    # Build config from arguments
    # Note: bandwidth defaults should already be set correctly by radio_client.py
    # based on the mode, so we don't override them here
    config = {
        'url': args.url,
        'host': args.host or 'localhost',
        'port': args.port or 8080,
        'frequency': int(args.frequency * 1e6) if args.frequency else 14074000,
        'mode': args.mode or 'usb',
        'bandwidth_low': 50,  # Default for USB, will be overridden by radio_client.py
        'bandwidth_high': 2700,  # Default for USB, will be overridden by radio_client.py
        'ssl': args.ssl,
        'auto_connect': args.auto_connect
    }

    # Add rigctl config if specified
    if args.rigctl_host:
        config['rigctl_host'] = args.rigctl_host
        config['rigctl_port'] = args.rigctl_port or 4532
        config['rigctl_sync'] = args.rigctl_sync

    main(config)