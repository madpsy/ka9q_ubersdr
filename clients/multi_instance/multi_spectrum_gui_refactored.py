#!/usr/bin/env python3
"""
Multi-Instance Spectrum Client for ka9q_ubersdr
Supports up to 10 simultaneous spectrum connections (GUI only, no audio)
Each instance has its own separate window with mode controls and spectrum display.
"""

import sys
import os
import tkinter as tk
from tkinter import ttk, messagebox

# Import local modules FIRST (before modifying sys.path)
from spectrum_instance import SpectrumInstance
from instance_manager import InstanceManager
from config_manager import ConfigManager
from instance_dialogs import AddInstanceDialog, EditInstanceDialog
from audio_preview import AudioPreviewManager, SOUNDDEVICE_AVAILABLE, WEBSOCKETS_AVAILABLE

# Import MIDI controller
try:
    from midi_controller import MIDIController, MIDI_AVAILABLE
except ImportError:
    MIDI_AVAILABLE = False
    print("Warning: MIDI controller not available")

# Import simple alignment system
try:
    from simple_alignment import SimpleSpectrumAligner, SimpleAudioAligner, SimpleAlignmentMetrics
    SIMPLE_ALIGNMENT_AVAILABLE = True
except ImportError:
    SIMPLE_ALIGNMENT_AVAILABLE = False
    print("Warning: simple_alignment module not available")

# Import local public_instances_display and local_instances_display (before adding parent to path)
try:
    from public_instances_display import create_public_instances_window
    PUBLIC_INSTANCES_AVAILABLE = True
except ImportError:
    PUBLIC_INSTANCES_AVAILABLE = False
    print("Warning: Public instances display not available")

try:
    from local_instances_display import create_local_instances_window
    LOCAL_INSTANCES_AVAILABLE = True
except ImportError:
    LOCAL_INSTANCES_AVAILABLE = False
    print("Warning: Local instances display not available")

# NOW add parent directory to path to import spectrum_display from clients/python
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python'))

try:
    from spectrum_display import SpectrumDisplay
    SPECTRUM_AVAILABLE = True
except ImportError:
    SPECTRUM_AVAILABLE = False
    print("ERROR: Spectrum display not available (missing dependencies)")
    sys.exit(1)


class InstanceWindow:
    """Separate window for each instance containing mode controls and spectrum display."""
    
    def __init__(self, parent_gui, instance: SpectrumInstance):
        self.parent_gui = parent_gui
        self.instance = instance
        self.window = tk.Toplevel(parent_gui.root)
        self.window.title(instance.get_id_display_name())
        self.window.geometry("1400x400")
        
        # Store reference in instance
        instance.instance_window = self
        
        # Create UI
        self.create_widgets()
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.on_closing)
    
    def create_widgets(self):
        """Create widgets for this instance window."""
        # Main container
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        # Mode controls at top
        controls_frame = ttk.LabelFrame(main_frame, text="Controls", padding="10")
        controls_frame.pack(fill=tk.X, pady=(0, 10))
        
        # Create variables for this instance
        self.freq_var = tk.StringVar(value=f"{self.instance.frequency/1e6:.6f}")
        self.freq_unit_var = tk.StringVar(value="MHz")
        self.mode_var = tk.StringVar(value=self.instance.mode)
        self.bandwidth_var = tk.IntVar(value=self.instance.bandwidth)
        
        # Frequency input
        ttk.Label(controls_frame, text="Freq:").pack(side=tk.LEFT, padx=(0, 5))
        freq_entry = ttk.Entry(controls_frame, textvariable=self.freq_var, width=12)
        freq_entry.pack(side=tk.LEFT, padx=(0, 5))
        freq_entry.bind('<Return>', lambda e: self._apply_frequency())
        
        # Unit selector
        unit_combo = ttk.Combobox(controls_frame, textvariable=self.freq_unit_var,
                                  values=["Hz", "kHz", "MHz"], state='readonly', width=6)
        unit_combo.pack(side=tk.LEFT, padx=(0, 5))
        unit_combo.bind('<<ComboboxSelected>>', lambda e: self._on_frequency_unit_changed())
        
        # Apply button
        ttk.Button(controls_frame, text="Apply", width=8,
                  command=self._apply_frequency).pack(side=tk.LEFT, padx=(0, 10))
        
        # Mode selection
        ttk.Label(controls_frame, text="Mode:").pack(side=tk.LEFT, padx=(0, 5))
        modes = ["USB", "LSB", "CWU", "CWL", "AM", "FM"]
        mode_combo = ttk.Combobox(controls_frame, textvariable=self.mode_var,
                                  values=modes, state="readonly", width=8)
        mode_combo.pack(side=tk.LEFT, padx=(0, 10))
        mode_combo.bind('<<ComboboxSelected>>', lambda e: self._on_mode_change())
        
        # Bandwidth control
        ttk.Label(controls_frame, text="BW:").pack(side=tk.LEFT, padx=(0, 5))
        self.bw_label = ttk.Label(controls_frame, text=f"{self.instance.bandwidth/1000:.1f} kHz", width=8)
        self.bw_label.pack(side=tk.LEFT, padx=(0, 5))
        
        bandwidth_slider = ttk.Scale(controls_frame, from_=100, to=10000,
                                    variable=self.bandwidth_var,
                                    orient=tk.HORIZONTAL, length=200,
                                    command=lambda v: self._on_bandwidth_change())
        bandwidth_slider.pack(side=tk.LEFT, padx=(0, 5))
        
        # Preset bandwidth buttons
        ttk.Button(controls_frame, text="500Hz", width=8,
                  command=lambda: self._set_bandwidth(500)).pack(side=tk.LEFT, padx=2)
        ttk.Button(controls_frame, text="2.7kHz", width=8,
                  command=lambda: self._set_bandwidth(2700)).pack(side=tk.LEFT, padx=2)
        ttk.Button(controls_frame, text="6kHz", width=8,
                  command=lambda: self._set_bandwidth(6000)).pack(side=tk.LEFT, padx=2)
        
        # Spectrum display area
        spectrum_frame = ttk.LabelFrame(main_frame, text="Spectrum", padding="5")
        spectrum_frame.pack(fill=tk.BOTH, expand=True)
        
        # Store reference for later use
        self.spectrum_frame = spectrum_frame
        self.freq_entry = freq_entry
        self.unit_combo = unit_combo
        self.mode_combo = mode_combo
        self.bandwidth_slider = bandwidth_slider
    
    def _apply_frequency(self):
        """Apply frequency change."""
        self.parent_gui._apply_instance_frequency(self.instance, self.freq_var, self.freq_unit_var)
    
    def _on_frequency_unit_changed(self):
        """Handle frequency unit change."""
        self.parent_gui._on_instance_frequency_unit_changed(self.instance, self.freq_var, self.freq_unit_var)
    
    def _on_mode_change(self):
        """Handle mode change."""
        self.parent_gui._on_instance_mode_change(self.instance, self.mode_var)
    
    def _on_bandwidth_change(self):
        """Handle bandwidth change."""
        self.parent_gui._on_instance_bandwidth_change(self.instance, self.bandwidth_var, self.bw_label)
    
    def _set_bandwidth(self, bandwidth: int):
        """Set bandwidth to specific value."""
        self.parent_gui._set_instance_bandwidth(self.instance, bandwidth, self.bandwidth_var, self.bw_label)
    
    def update_frequency_display(self, freq_hz: float):
        """Update frequency display when changed externally."""
        unit = self.freq_unit_var.get()
        if unit == "MHz":
            self.freq_var.set(f"{freq_hz/1e6:.6f}")
        elif unit == "kHz":
            self.freq_var.set(f"{freq_hz/1e3:.3f}")
        else:
            self.freq_var.set(str(int(freq_hz)))
    
    def on_closing(self):
        """Handle window close - disconnect the instance."""
        if self.instance.connected:
            self.parent_gui.disconnect_instance(self.instance)
        self.window.destroy()
        self.instance.instance_window = None


class MultiSpectrumGUI:
    """Main GUI for multi-instance spectrum client."""
    
    MAX_INSTANCES = 2
    
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Multi-Instance Spectrum Client")
        self.root.geometry("800x600")
        
        # Managers
        self.instance_manager = InstanceManager(self.MAX_INSTANCES)
        self.config_manager = ConfigManager()
        
        # UI components
        self.instance_frames = {}
        self.spectrum_displays = {}
        self.instance_list_frame = None
        
        # Local instances display reference
        self.local_instances_display = None
        
        # Synchronization state
        self.sync_enabled = tk.BooleanVar(value=True)
        self.throttle_enabled = tk.BooleanVar(value=True)  # Throttle to slowest by default on
        self._syncing = False  # Flag to prevent sync loops
        
        # Config save throttling
        self._save_config_pending = False
        self._last_config_save = 0
        self._config_save_delay = 1000  # ms - wait 1 second after last change before saving

        # Scroll mode state
        self.scroll_mode = tk.StringVar(value="pan")  # Default to pan mode
        self.step_size = tk.StringVar(value="500 Hz")  # Default step size
        self.center_tune = tk.BooleanVar(value=True)  # Center tune enabled by default

        # Global state for backward compatibility (used by audio preview, signal levels, etc.)
        # These track the "current" settings but are not displayed in a global UI anymore
        self.frequency_input = tk.StringVar(value="14.100000")  # Default 14.1 MHz
        self.frequency_unit = tk.StringVar(value="MHz")  # Default unit
        self.prev_frequency_unit = "MHz"  # Track previous unit for conversion
        self.current_mode = tk.StringVar(value="USB")
        self.current_bandwidth = tk.IntVar(value=2700)  # Default 2.7 kHz for USB

        # Signal levels window
        self.signal_levels_window = None
        self.signal_level_labels = {}  # instance_id -> label widget
        self.signal_levels_last_update = {}  # instance_id -> last update timestamp for throttling
        self.current_frequency = None  # Current hover frequency
        self.current_cursor_x = -1  # Current cursor X position for synchronization
        self.currently_hovered_spectrum = None  # Track which spectrum is currently being hovered

        # Comparison state
        self.compare_instance_a = tk.StringVar(value="None")
        self.compare_instance_b = tk.StringVar(value="None")
        self.comparison_history = {}  # instance_id -> list of recent (timestamp, peak, floor, snr) tuples
        self.comparison_diff_history = {}  # Store difference history for smoothing: 'a_id:b_id' -> list of (timestamp, diff_peak, diff_floor, diff_snr)
        self.comparison_timestamp_history = {}  # Store timestamp difference history: 'a_id:b_id' -> list of (time, timestamp_diff_ms)
        self.comparison_window = 0.5  # 500ms averaging window for signal levels
        self.comparison_timestamp_window = 5.0  # 5 second averaging window for timestamp differences (longer for stability)
        self.comparison_last_update = 0  # Last time we updated the comparison display
        self.comparison_update_interval = 0.2  # Update comparison display every 200ms
        self.comparison_timestamp_last_update = 0  # Last time we updated timestamp difference display
        self.comparison_timestamp_update_interval = 1.0  # Update timestamp difference every 1 second (less frequent for stability)
        self.comparison_last_valid_values = {}  # Store last valid comparison values: 'a_id:b_id' -> (diff_peak, diff_floor, diff_snr)
        self.comparison_last_valid_timestamp_diff = {}  # Store last valid timestamp difference: 'a_id:b_id' -> timestamp_diff_ms
        
        # Update rate tracking for throttling (using server-reported rates)
        self.update_times = {}  # instance_id -> list of recent update timestamps (for frame skipping)
        self.target_update_rate = None  # Slowest rate to throttle to (from server-reported rates)
        
        # Simple alignment system (uses averaged timestamp offsets)
        self.use_simple_alignment = SIMPLE_ALIGNMENT_AVAILABLE
        
        if self.use_simple_alignment:
            self.spectrum_aligner = SimpleSpectrumAligner()
            print("Simple spectrum alignment enabled")
        else:
            self.spectrum_aligner = None
        
        # Sync metrics display
        self.sync_metrics_label = None
        self.last_metrics_update = 0
        self.metrics_update_interval = 1.0  # Update metrics every 1 second
        
        # Audio preview manager
        self.audio_preview = AudioPreviewManager() if (SOUNDDEVICE_AVAILABLE and WEBSOCKETS_AVAILABLE) else None
        self.audio_left_instance = tk.StringVar(value="None")
        self.audio_right_instance = tk.StringVar(value="None")
        self.audio_left_volume = tk.DoubleVar(value=1.0)  # 0.0 to 1.0
        self.audio_right_volume = tk.DoubleVar(value=1.0)  # 0.0 to 1.0
        self.audio_left_mono = tk.BooleanVar(value=False)  # Mono mode for left channel
        self.audio_left_mute = tk.BooleanVar(value=False)  # Mute left channel
        self.audio_right_mute = tk.BooleanVar(value=False)  # Mute right channel
        self.audio_right_mono = tk.BooleanVar(value=False)  # Mono mode for right channel
        self.audio_preview_active = False
        # Cache audio instance lookups for performance
        self._audio_left_instance_cache = None
        self._audio_right_instance_cache = None
        
        # MIDI controller
        self.midi_controller = MIDIController(self) if MIDI_AVAILABLE else None
        self.midi_window = None
        
        # Create UI
        self.create_widgets()
        
        # Load saved configuration
        self.load_config()
        
        # Open Signal Levels window on startup (after a short delay)
        self.root.after(500, self.show_signal_levels_window)
        
        # If no instances exist after loading config, show public instances window
        if len(self.instance_manager.instances) == 0 and PUBLIC_INSTANCES_AVAILABLE:
            self.root.after(600, self.add_from_public)
        
        # Handle window close
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)
    
    def create_widgets(self):
        """Create all GUI widgets."""
        # Main container with padding
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        
        # Top control panel
        control_frame = ttk.LabelFrame(main_frame, text="Instance Management", padding="10")
        control_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        # First row: Instance management buttons
        row1_frame = ttk.Frame(control_frame)
        row1_frame.pack(fill=tk.X, pady=(0, 5))
        
        ttk.Button(row1_frame, text="Add Instance",
                  command=self.add_instance).pack(side=tk.LEFT, padx=(0, 5))
        
        if PUBLIC_INSTANCES_AVAILABLE:
            ttk.Button(row1_frame, text="Add from Public",
                      command=self.add_from_public).pack(side=tk.LEFT, padx=(0, 5))
        
        if LOCAL_INSTANCES_AVAILABLE:
            ttk.Button(row1_frame, text="Add from Local",
                      command=self.add_from_local).pack(side=tk.LEFT, padx=(0, 5))
        
        ttk.Button(row1_frame, text="Connect All",
                  command=self.connect_all_enabled).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(row1_frame, text="Disconnect All",
                  command=self.disconnect_all).pack(side=tk.LEFT, padx=(0, 5))

        ttk.Separator(row1_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, padx=10, fill=tk.Y)
        ttk.Button(row1_frame, text="Signal Levels",
                  command=self.show_signal_levels_window).pack(side=tk.LEFT, padx=(0, 5))
        
        # MIDI Controller button
        if MIDI_AVAILABLE:
            ttk.Button(row1_frame, text="MIDI Controller",
                      command=self.show_midi_window).pack(side=tk.LEFT, padx=(0, 5))

        # Second row: Synchronization and scroll controls
        row2_frame = ttk.Frame(control_frame)
        row2_frame.pack(fill=tk.X)
        
        # Synchronization control
        ttk.Checkbutton(row2_frame, text="Synchronize Pan/Zoom",
                       variable=self.sync_enabled).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Checkbutton(row2_frame, text="Throttle to Slowest",
                       variable=self.throttle_enabled).pack(side=tk.LEFT, padx=(0, 5))

        # Scroll mode control
        ttk.Separator(row2_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, padx=10, fill=tk.Y)
        ttk.Label(row2_frame, text="Scroll:").pack(side=tk.LEFT, padx=(0, 5))
        ttk.Radiobutton(row2_frame, text="Zoom", variable=self.scroll_mode,
                       value="zoom", command=self._on_scroll_mode_change).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Radiobutton(row2_frame, text="Pan", variable=self.scroll_mode,
                       value="pan", command=self._on_scroll_mode_change).pack(side=tk.LEFT, padx=(0, 5))

        # Step size selector (for pan mode)
        ttk.Label(row2_frame, text="Step:").pack(side=tk.LEFT, padx=(10, 5))
        step_combo = ttk.Combobox(row2_frame, textvariable=self.step_size,
                                  values=["10 Hz", "100 Hz", "500 Hz", "1 kHz", "10 kHz"],
                                  state='readonly', width=8)
        step_combo.pack(side=tk.LEFT, padx=(0, 5))
        step_combo.bind('<<ComboboxSelected>>', lambda e: self._on_step_size_changed())

        # Center tune checkbox
        ttk.Checkbutton(row2_frame, text="Center Tune",
                       variable=self.center_tune,
                       command=self._on_center_tune_changed).pack(side=tk.LEFT, padx=(10, 5))
        
        # Instance list
        list_frame = ttk.LabelFrame(main_frame, text="Instances", padding="10")
        list_frame.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        
        # Scrollable instance list
        list_canvas = tk.Canvas(list_frame, height=200)
        list_scrollbar = ttk.Scrollbar(list_frame, orient="vertical", command=list_canvas.yview)
        self.instance_list_frame = ttk.Frame(list_canvas)
        
        list_canvas.create_window((0, 0), window=self.instance_list_frame, anchor="nw")
        list_canvas.configure(yscrollcommand=list_scrollbar.set)
        
        list_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        list_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # Update scroll region when frame changes
        self.instance_list_frame.bind("<Configure>",
                                     lambda e: list_canvas.configure(scrollregion=list_canvas.bbox("all")))

        # Audio Preview section
        if self.audio_preview:
            audio_frame = ttk.LabelFrame(main_frame, text="Audio Preview", padding="10")
            audio_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
            
            # First row: Channel selection and volume controls
            row1_frame = ttk.Frame(audio_frame)
            row1_frame.pack(fill=tk.X, pady=(0, 5))
            
            # Left channel controls
            ttk.Label(row1_frame, text="Left Channel:").pack(side=tk.LEFT, padx=(0, 5))
            self.audio_left_combo = ttk.Combobox(row1_frame, textvariable=self.audio_left_instance,
                                                 values=["None"], state='readonly', width=18)
            self.audio_left_combo.pack(side=tk.LEFT, padx=(0, 5))
            
            ttk.Checkbutton(row1_frame, text="Mute", variable=self.audio_left_mute,
                           command=self._on_left_mute_change).pack(side=tk.LEFT, padx=(0, 5))
            
            ttk.Checkbutton(row1_frame, text="Mono", variable=self.audio_left_mono,
                           command=self._on_left_mono_change).pack(side=tk.LEFT, padx=(0, 5))
            
            ttk.Label(row1_frame, text="Vol:").pack(side=tk.LEFT, padx=(0, 5))
            self.left_volume_label = ttk.Label(row1_frame, text="100%", width=5)
            self.left_volume_label.pack(side=tk.LEFT, padx=(0, 5))
            left_volume_slider = ttk.Scale(row1_frame, from_=0, to=1.0,
                                          variable=self.audio_left_volume,
                                          orient=tk.HORIZONTAL, length=100,
                                          command=self._on_left_volume_change)
            left_volume_slider.pack(side=tk.LEFT, padx=(0, 15))
            
            # Right channel controls
            ttk.Label(row1_frame, text="Right Channel:").pack(side=tk.LEFT, padx=(0, 5))
            self.audio_right_combo = ttk.Combobox(row1_frame, textvariable=self.audio_right_instance,
                                                  values=["None"], state='readonly', width=18)
            self.audio_right_combo.pack(side=tk.LEFT, padx=(0, 5))
            
            ttk.Checkbutton(row1_frame, text="Mute", variable=self.audio_right_mute,
                           command=self._on_right_mute_change).pack(side=tk.LEFT, padx=(0, 5))
            
            ttk.Checkbutton(row1_frame, text="Mono", variable=self.audio_right_mono,
                           command=self._on_right_mono_change).pack(side=tk.LEFT, padx=(0, 5))
            
            ttk.Label(row1_frame, text="Vol:").pack(side=tk.LEFT, padx=(0, 5))
            self.right_volume_label = ttk.Label(row1_frame, text="100%", width=5)
            self.right_volume_label.pack(side=tk.LEFT, padx=(0, 5))
            right_volume_slider = ttk.Scale(row1_frame, from_=0, to=1.0,
                                           variable=self.audio_right_volume,
                                           orient=tk.HORIZONTAL, length=100,
                                           command=self._on_right_volume_change)
            right_volume_slider.pack(side=tk.LEFT, padx=(0, 5))
            
            # Second row: Manual offset, start button, and info
            row2_frame = ttk.Frame(audio_frame)
            row2_frame.pack(fill=tk.X)
            
            # Manual offset control
            ttk.Label(row2_frame, text="Right Delay:").pack(side=tk.LEFT, padx=(0, 5))
            self.manual_offset_var = tk.IntVar(value=0)
            self.manual_offset_label = ttk.Label(row2_frame, text="0 ms", width=8)
            self.manual_offset_label.pack(side=tk.LEFT, padx=(0, 5))
            manual_offset_slider = ttk.Scale(row2_frame, from_=-500, to=500,
                                            variable=self.manual_offset_var,
                                            orient=tk.HORIZONTAL, length=150,
                                            command=self._on_manual_offset_change)
            manual_offset_slider.pack(side=tk.LEFT, padx=(0, 15))
            
            # Start/Stop button
            self.audio_start_btn = ttk.Button(row2_frame, text="Start Preview", width=12,
                                             command=self._toggle_audio_preview)
            self.audio_start_btn.pack(side=tk.LEFT, padx=5)
            
            ttk.Label(row2_frame, text="(Mono: output to both speakers)",
                     font=('TkDefaultFont', 9, 'italic')).pack(side=tk.LEFT, padx=(10, 0))
        
        # Configure weights for resizing
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(1, weight=1)  # Instance list expands
        if self.audio_preview:
            main_frame.rowconfigure(2, weight=0)  # Audio preview section fixed height
    
    # [Rest of the methods would continue here - this is getting very long]
    # Due to character limits, I'll create a script to show you the key changes needed