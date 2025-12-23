#!/usr/bin/env python3
"""
Multi-Instance Spectrum Client for ka9q_ubersdr
Supports up to 2 simultaneous spectrum connections (GUI only, no audio)
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

        # Restore saved geometry or use default
        window_key = f'instance_{instance.instance_id}'
        if window_key in parent_gui.window_geometries:
            try:
                self.window.geometry(parent_gui.window_geometries[window_key])
            except:
                self.window.geometry("1100x400")  # Fallback to default
        else:
            self.window.geometry("1100x400")

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

        # Lock control at the end of controls
        ttk.Separator(controls_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, padx=10, fill=tk.Y)

        # Lock checkbox and label in a vertical arrangement
        lock_container = ttk.Frame(controls_frame)
        lock_container.pack(side=tk.LEFT, padx=(0, 5))

        self.locked_var = tk.BooleanVar(value=False)
        self.instance.locked = False  # Store lock state in instance
        lock_check = ttk.Checkbutton(lock_container, variable=self.locked_var,
                                     command=self._on_lock_changed)
        lock_check.pack()

        ttk.Label(lock_container, text="Lock", font=('TkDefaultFont', 9)).pack()

        # Spectrum display area
        spectrum_frame = ttk.LabelFrame(main_frame, text="Spectrum", padding="5")
        spectrum_frame.pack(fill=tk.BOTH, expand=True)

        # Store reference for later use
        self.spectrum_frame = spectrum_frame
        self.freq_entry = freq_entry
        self.unit_combo = unit_combo
        self.mode_combo = mode_combo
        self.bandwidth_slider = bandwidth_slider

    def _on_lock_changed(self):
        """Handle lock checkbox change."""
        locked = self.locked_var.get()
        self.instance.locked = locked

        # Enable/disable all controls
        state = 'disabled' if locked else 'normal'
        readonly_state = 'disabled' if locked else 'readonly'

        self.freq_entry.config(state=state)
        self.unit_combo.config(state=readonly_state)
        self.mode_combo.config(state=readonly_state)
        self.bandwidth_slider.config(state=state)

        # Disable spectrum interactions if locked
        if self.instance.spectrum:
            self.instance.spectrum.locked = locked

        print(f"{self.instance.get_id_display_name()} {'locked' if locked else 'unlocked'}")

    def _apply_frequency(self):
        """Apply frequency change."""
        if self.instance.locked:
            return
        self.parent_gui._apply_instance_frequency(self.instance, self.freq_var, self.freq_unit_var)

    def _on_frequency_unit_changed(self):
        """Handle frequency unit change."""
        if self.instance.locked:
            return
        self.parent_gui._on_instance_frequency_unit_changed(self.instance, self.freq_var, self.freq_unit_var)

    def _on_mode_change(self):
        """Handle mode change."""
        if self.instance.locked:
            return
        self.parent_gui._on_instance_mode_change(self.instance, self.mode_var)

    def _on_bandwidth_change(self):
        """Handle bandwidth change."""
        if self.instance.locked:
            return
        self.parent_gui._on_instance_bandwidth_change(self.instance, self.bandwidth_var, self.bw_label)

    def _set_bandwidth(self, bandwidth: int):
        """Set bandwidth to specific value."""
        if self.instance.locked:
            return
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
        self.root.geometry("950x500")

        # Managers
        self.instance_manager = InstanceManager(self.MAX_INSTANCES)
        self.config_manager = ConfigManager()

        # Window geometries storage
        self.window_geometries = {}

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
        if self.audio_preview:
            # Set error callback to handle connection failures
            self.audio_preview.set_error_callback(self._on_audio_connection_error)
        self.audio_left_instance = tk.StringVar(value="None")
        self.audio_right_instance = tk.StringVar(value="None")
        self.audio_left_volume = tk.DoubleVar(value=1.0)  # 0.0 to 1.0
        self.audio_right_volume = tk.DoubleVar(value=1.0)  # 0.0 to 1.0
        self.audio_left_mono = tk.BooleanVar(value=False)  # Mono mode for left channel
        self.audio_left_mute = tk.BooleanVar(value=False)  # Mute left channel
        self.audio_right_mute = tk.BooleanVar(value=False)  # Mute right channel
        self.audio_right_mono = tk.BooleanVar(value=False)  # Mono mode for right channel
        self.audio_left_opus = tk.BooleanVar(value=True)  # Use Opus for left channel (default: enabled)
        self.audio_right_opus = tk.BooleanVar(value=True)  # Use Opus for right channel (default: enabled)
        self.audio_preview_active = False
        # Cache audio instance lookups for performance
        self._audio_left_instance_cache = None
        self._audio_right_instance_cache = None
        # Audio level meter update
        self._level_meter_update_id = None

        # MIDI controller
        self.midi_controller = MIDIController(self) if MIDI_AVAILABLE else None
        self.midi_window = None

        # Create UI
        self.create_widgets()

        # Load saved configuration
        self.load_config()

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
        ttk.Checkbutton(row2_frame, text="Synchronise",
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

        # Instance list (left side) - fixed height for 2 instances max
        list_frame = ttk.LabelFrame(main_frame, text="Instances", padding="10")
        list_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 10))

        # Simple frame for instance list (no scrolling needed for 2 instances)
        self.instance_list_frame = ttk.Frame(list_frame)
        self.instance_list_frame.pack(fill=tk.X)

        # Controls section
        sync_control_frame = ttk.LabelFrame(main_frame, text="Controls", padding="10")
        sync_control_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(0, 10))

        ttk.Label(sync_control_frame, text="Copy settings:").pack(side=tk.LEFT, padx=(0, 10))

        ttk.Button(sync_control_frame, text="A → B", width=10,
                  command=self._sync_a_to_b).pack(side=tk.LEFT, padx=5)

        ttk.Button(sync_control_frame, text="B → A", width=10,
                  command=self._sync_b_to_a).pack(side=tk.LEFT, padx=5)

        ttk.Label(sync_control_frame, text="(Copies frequency, mode, and bandwidth)",
                 font=('TkDefaultFont', 9, 'italic')).pack(side=tk.LEFT, padx=(10, 0))

        # Audio section
        if self.audio_preview:
            audio_frame = ttk.LabelFrame(main_frame, text="Audio", padding="10")
            audio_frame.grid(row=3, column=0, sticky=(tk.W, tk.E), pady=(0, 10))

            # First row: Left channel controls
            row1_frame = ttk.Frame(audio_frame)
            row1_frame.pack(fill=tk.X, pady=(0, 5))

            ttk.Label(row1_frame, text="Left:", width=6).pack(side=tk.LEFT, padx=(0, 5))
            self.audio_left_combo = ttk.Combobox(row1_frame, textvariable=self.audio_left_instance,
                                                 values=["None"], state='readonly', width=25)
            self.audio_left_combo.pack(side=tk.LEFT, padx=(0, 5))

            ttk.Checkbutton(row1_frame, text="Mute", variable=self.audio_left_mute,
                           command=self._on_left_mute_change).pack(side=tk.LEFT, padx=(0, 5))

            ttk.Checkbutton(row1_frame, text="Mono", variable=self.audio_left_mono,
                           command=self._on_left_mono_change).pack(side=tk.LEFT, padx=(0, 5))

            ttk.Checkbutton(row1_frame, text="Opus", variable=self.audio_left_opus).pack(side=tk.LEFT, padx=(0, 5))

            ttk.Label(row1_frame, text="Vol:").pack(side=tk.LEFT, padx=(0, 5))
            self.left_volume_label = ttk.Label(row1_frame, text="100%", width=5)
            self.left_volume_label.pack(side=tk.LEFT, padx=(0, 5))
            left_volume_slider = ttk.Scale(row1_frame, from_=0, to=1.0,
                                          variable=self.audio_left_volume,
                                          orient=tk.HORIZONTAL, length=100,
                                          command=self._on_left_volume_change)
            left_volume_slider.pack(side=tk.LEFT, padx=(0, 5))

            # Left channel level meter (canvas-based for color control)
            self.left_level_canvas = tk.Canvas(row1_frame, width=150, height=20, bg='black', highlightthickness=1)
            self.left_level_canvas.pack(side=tk.LEFT, padx=(5, 0))
            self.left_level_bar = self.left_level_canvas.create_rectangle(0, 0, 0, 20, fill='green', outline='')
            self.left_level_value = 0

            # Left channel buffer size label
            self.left_buffer_label = ttk.Label(row1_frame, text="--ms", foreground='blue', font=('TkDefaultFont', 9))
            self.left_buffer_label.pack(side=tk.LEFT, padx=(5, 0))

            # Second row: Right channel controls
            row2_frame = ttk.Frame(audio_frame)
            row2_frame.pack(fill=tk.X, pady=(0, 5))

            ttk.Label(row2_frame, text="Right:", width=6).pack(side=tk.LEFT, padx=(0, 5))
            self.audio_right_combo = ttk.Combobox(row2_frame, textvariable=self.audio_right_instance,
                                                  values=["None"], state='readonly', width=25)
            self.audio_right_combo.pack(side=tk.LEFT, padx=(0, 5))

            ttk.Checkbutton(row2_frame, text="Mute", variable=self.audio_right_mute,
                           command=self._on_right_mute_change).pack(side=tk.LEFT, padx=(0, 5))

            ttk.Checkbutton(row2_frame, text="Mono", variable=self.audio_right_mono,
                           command=self._on_right_mono_change).pack(side=tk.LEFT, padx=(0, 5))

            ttk.Checkbutton(row2_frame, text="Opus", variable=self.audio_right_opus).pack(side=tk.LEFT, padx=(0, 5))

            ttk.Label(row2_frame, text="Vol:").pack(side=tk.LEFT, padx=(0, 5))
            self.right_volume_label = ttk.Label(row2_frame, text="100%", width=5)
            self.right_volume_label.pack(side=tk.LEFT, padx=(0, 5))
            right_volume_slider = ttk.Scale(row2_frame, from_=0, to=1.0,
                                           variable=self.audio_right_volume,
                                           orient=tk.HORIZONTAL, length=100,
                                           command=self._on_right_volume_change)
            right_volume_slider.pack(side=tk.LEFT, padx=(0, 5))

            # Right channel level meter (canvas-based for color control)
            self.right_level_canvas = tk.Canvas(row2_frame, width=150, height=20, bg='black', highlightthickness=1)
            self.right_level_canvas.pack(side=tk.LEFT, padx=(5, 0))
            self.right_level_bar = self.right_level_canvas.create_rectangle(0, 0, 0, 20, fill='green', outline='')
            self.right_level_value = 0

            # Right channel buffer size label
            self.right_buffer_label = ttk.Label(row2_frame, text="--ms", foreground='blue', font=('TkDefaultFont', 9))
            self.right_buffer_label.pack(side=tk.LEFT, padx=(5, 0))

            # Third row: Manual offset, start button, and info
            row3_frame = ttk.Frame(audio_frame)
            row3_frame.pack(fill=tk.X)

            # Manual offset control
            ttk.Label(row3_frame, text="Right Delay:").pack(side=tk.LEFT, padx=(0, 5))
            self.manual_offset_var = tk.IntVar(value=0)
            self.manual_offset_label = ttk.Label(row3_frame, text="0 ms", width=8)
            self.manual_offset_label.pack(side=tk.LEFT, padx=(0, 5))
            manual_offset_slider = ttk.Scale(row3_frame, from_=-500, to=500,
                                            variable=self.manual_offset_var,
                                            orient=tk.HORIZONTAL, length=150,
                                            command=self._on_manual_offset_change)
            manual_offset_slider.pack(side=tk.LEFT, padx=(0, 15))

            # Start/Stop button
            self.audio_start_btn = ttk.Button(row3_frame, text="Start", width=12,
                                             command=self._toggle_audio_preview)
            self.audio_start_btn.pack(side=tk.LEFT, padx=5)

            ttk.Label(row3_frame, text="(Mono: output to both speakers)",
                     font=('TkDefaultFont', 9, 'italic')).pack(side=tk.LEFT, padx=(10, 0))

        # Configure weights for resizing
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(1, weight=1)  # Instance list expands
        if self.audio_preview:
            main_frame.rowconfigure(4, weight=0)  # Audio preview section fixed height

    def add_instance(self):
        """Add a new instance manually."""
        if not self.instance_manager.can_add_instance():
            messagebox.showwarning("Limit Reached",
                                  f"Maximum {self.MAX_INSTANCES} instances allowed")
            return

        def on_ok(instance: SpectrumInstance):
            self.instance_manager.add_instance(instance)
            self.create_instance_ui(instance)
            self._add_instance_to_signal_levels(instance)
            self._update_comparison_dropdowns()
            self._update_audio_preview_dropdowns()
            self.save_config()

        AddInstanceDialog(self.root, len(self.instance_manager.instances), on_ok)

    def add_from_public(self):
        """Add instance from public instances list."""
        if not PUBLIC_INSTANCES_AVAILABLE:
            messagebox.showerror("Error", "Public instances feature not available")
            return

        if not self.instance_manager.can_add_instance():
            messagebox.showwarning("Limit Reached",
                                  f"Maximum {self.MAX_INSTANCES} instances allowed")
            return

        # Check if window is already open
        if hasattr(self, 'public_instances_window') and self.public_instances_window is not None:
            try:
                if self.public_instances_window.winfo_exists():
                    self.public_instances_window.lift()
                    return
            except:
                pass

        def on_select(host, port, tls, name, callsign=None):
            """Callback when user selects a public instance."""
            instance = SpectrumInstance(len(self.instance_manager.instances))
            instance.name = name
            # Handle None, empty string, or the string 'None'
            instance.callsign = callsign if (callsign and callsign != 'None') else ""
            instance.host = host
            instance.port = port
            instance.tls = tls
            instance.frequency = 14100000  # Default frequency

            self.instance_manager.add_instance(instance)
            self.create_instance_ui(instance)
            self._add_instance_to_signal_levels(instance)
            self._update_comparison_dropdowns()
            self._update_audio_preview_dropdowns()
            self.save_config()

        # Collect UUIDs from local instances if available
        local_uuids = self._get_local_uuids()

        self.public_instances_window = create_public_instances_window(self.root, on_select, local_uuids)

    def _get_local_uuids(self) -> set:
        """Get UUIDs from discovered local instances.

        Returns:
            Set of public UUIDs from local instances
        """
        local_uuids = set()

        # If we already have a local instances display, use it
        if self.local_instances_display:
            for service_name, info in self.local_instances_display.instances.items():
                public_uuid = info.get('public_uuid', '')
                if public_uuid:
                    local_uuids.add(public_uuid)
        # Otherwise, try to discover local instances quickly
        elif LOCAL_INSTANCES_AVAILABLE:
            try:
                from zeroconf import Zeroconf, ServiceBrowser
                import threading
                import time

                discovered_uuids = []

                class QuickUUIDListener:
                    def __init__(self):
                        self.zc = None

                    def add_service(self, zc, type_, name):
                        self.zc = zc
                        info = zc.get_service_info(type_, name)
                        if info:
                            host = info.parsed_addresses()[0] if info.parsed_addresses() else None
                            port = info.port
                            if host and port:
                                # Fetch description to get public_uuid
                                try:
                                    import requests
                                    url = f"http://{host}:{port}/api/description"
                                    response = requests.get(url, timeout=2)
                                    response.raise_for_status()
                                    description = response.json()
                                    public_uuid = description.get('public_uuid', '')
                                    if public_uuid:
                                        discovered_uuids.append(public_uuid)
                                except:
                                    pass

                    def remove_service(self, zc, type_, name):
                        pass

                    def update_service(self, zc, type_, name):
                        pass

                # Quick discovery (2 second timeout)
                zc = Zeroconf()
                listener = QuickUUIDListener()
                browser = ServiceBrowser(zc, "_ubersdr._tcp.local.", listener)

                # Wait up to 2 seconds for discovery
                time.sleep(2.0)

                # Cleanup
                browser.cancel()
                zc.close()

                # Add discovered UUIDs
                local_uuids.update(discovered_uuids)
            except Exception as e:
                pass  # Silently fail if discovery doesn't work

        return local_uuids

    def add_from_local(self):
        """Add instance from local instances discovered via mDNS."""
        if not LOCAL_INSTANCES_AVAILABLE:
            messagebox.showerror("Error", "Local instances feature not available")
            return

        if not self.instance_manager.can_add_instance():
            messagebox.showwarning("Limit Reached",
                                  f"Maximum {self.MAX_INSTANCES} instances allowed")
            return

        # Check if window is already open
        if hasattr(self, 'local_instances_window') and self.local_instances_window is not None:
            try:
                if self.local_instances_window.winfo_exists():
                    self.local_instances_window.lift()
                    return
            except:
                pass

        def on_select(host, port, tls, name, callsign=None):
            """Callback when user selects a local instance."""
            instance = SpectrumInstance(len(self.instance_manager.instances))
            instance.name = name
            # Handle None, empty string, or the string 'None'
            instance.callsign = callsign if (callsign and callsign != 'None') else ""
            instance.host = host
            instance.port = port
            instance.tls = tls
            instance.frequency = 14100000  # Default frequency

            self.instance_manager.add_instance(instance)
            self.create_instance_ui(instance)
            self._add_instance_to_signal_levels(instance)
            self._update_comparison_dropdowns()
            self._update_audio_preview_dropdowns()
            self.save_config()

        self.local_instances_window, self.local_instances_display = create_local_instances_window(self.root, on_select)

    def create_instance_ui(self, instance: SpectrumInstance):
        """Create UI elements for an instance."""
        # Instance control row
        row_frame = ttk.Frame(self.instance_list_frame)
        row_frame.pack(fill=tk.X, pady=2)

        # Enable checkbox - store the variable in the instance for later access
        enabled_var = tk.BooleanVar(value=instance.enabled)
        instance.enabled_var = enabled_var  # Store reference for syncing
        enabled_check = ttk.Checkbutton(row_frame, variable=enabled_var,
                                       command=lambda: self.toggle_instance(instance, enabled_var.get()))
        enabled_check.pack(side=tk.LEFT, padx=(5, 0))

        # Instance info
        protocol = "https" if instance.tls else "http"
        info_text = f"{instance.get_id_display_name()} - {protocol}://{instance.host}:{instance.port}"
        info_label = ttk.Label(row_frame, text=info_text, width=60)
        info_label.pack(side=tk.LEFT, padx=(0, 5))

        # Status - set initial value based on instance state
        initial_status = "Enabled" if instance.enabled else "Disabled"
        status_var = tk.StringVar(value=initial_status)
        instance.status_var = status_var
        status_label = ttk.Label(row_frame, textvariable=status_var, width=10)
        status_label.pack(side=tk.LEFT, padx=5)

        # Session time label (shown when connected) - no left padding to reduce gap
        session_time_var = tk.StringVar(value="")
        instance.session_time_var = session_time_var
        session_time_label = ttk.Label(row_frame, textvariable=session_time_var,
                                       foreground='blue', font=('TkDefaultFont', 9))
        session_time_label.pack(side=tk.LEFT, padx=(0, 5))

        # Connect/Disconnect button
        button_text = "Disconnect" if instance.connected else "Connect"
        connect_btn = ttk.Button(row_frame, text=button_text, width=10,
                                command=lambda: self.toggle_connection(instance))
        connect_btn.pack(side=tk.LEFT, padx=5)

        # Store button reference for updating text
        instance.connect_btn = connect_btn

        # Edit button
        ttk.Button(row_frame, text="Edit", width=6,
                  command=lambda: self.edit_instance(instance)).pack(side=tk.LEFT, padx=2)

        # Remove button
        ttk.Button(row_frame, text="Remove", width=8,
                  command=lambda: self.remove_instance(instance)).pack(side=tk.LEFT, padx=2)

        # Store references
        instance.frame = row_frame
        self.instance_frames[instance.instance_id] = row_frame


    def toggle_instance(self, instance: SpectrumInstance, enabled: bool):
        """Enable or disable an instance."""
        instance.enabled = enabled
        # Sync the checkbox state with the instance state
        if hasattr(instance, 'enabled_var'):
            instance.enabled_var.set(enabled)

        if enabled:
            instance.status_var.set("Enabled")
        else:
            if instance.connected:
                self.disconnect_instance(instance)
            instance.status_var.set("Disabled")
        self.save_config()

    def toggle_connection(self, instance: SpectrumInstance):
        """Connect or disconnect an instance."""
        if instance.connected:
            self.disconnect_instance(instance)
        else:
            self.connect_instance(instance)

    def connect_instance(self, instance: SpectrumInstance):
        """Connect a single instance."""
        # Update button text
        if hasattr(instance, 'connect_btn'):
            instance.connect_btn.config(text="Disconnect")

        # Create instance window and spectrum display if not exists
        if instance.spectrum is None:
            # Create the instance window (which creates the spectrum display internally)
            instance_window = InstanceWindow(self, instance)

            # Restore lock state if it was saved
            if hasattr(instance, 'locked') and instance.locked:
                instance_window.locked_var.set(True)
                instance_window._on_lock_changed()

            # Get the spectrum display from the instance window
            # Create click-to-tune variable (always enabled for multi-instance)
            click_tune_var = tk.BooleanVar(value=True)

            # SpectrumDisplay creates and packs its own canvas internally
            instance.spectrum = SpectrumDisplay(instance_window.spectrum_frame, width=975, height=200,
                                               click_tune_var=click_tune_var,
                                               center_tune_var=self.center_tune)

            # Set up frequency callback for click-to-tune synchronization
            instance.spectrum.set_frequency_callback(
                lambda freq, src=instance.spectrum: self._on_frequency_change(freq, src)
            )

            # Set up frequency step callback for pan mode
            instance.spectrum.set_frequency_step_callback(
                lambda direction, src=instance.spectrum: self._on_frequency_step(direction, src)
            )

            # Set initial scroll mode and step size
            instance.spectrum.set_scroll_mode(self.scroll_mode.get())
            instance.spectrum.set_step_size(self._get_step_size_hz())

            # Set up synchronization callbacks
            self._setup_sync_callbacks(instance.spectrum, instance.instance_id)

            # Set up mouse motion callback for cursor synchronization
            self._setup_cursor_sync(instance.spectrum, instance.instance_id)

            # Initialize update tracking for this instance
            self.update_times[instance.instance_id] = []

            # Calculate target throttle rate from all connected instances
            self._update_target_rate()

            # Set instance_id on spectrum display for timestamp sync (disabled)
            # if self.use_timestamp_sync and self.spectrum_aligner:
            #     instance.spectrum.instance_id = instance.instance_id

            self.spectrum_displays[instance.instance_id] = instance.spectrum

        # Connect using manager
        if self.instance_manager.connect_instance(instance, instance.spectrum):
            instance.status_var.set("Connected")

            # Start session timer
            self._start_session_timer(instance)

            # Apply instance's saved frequency, mode, and bandwidth to newly connected instance
            # Wait longer (1500ms) to ensure spectrum has received initial config from server
            self.root.after(1500, lambda: self._apply_instance_settings_after_connect(instance))

            # Apply saved spectrum zoom settings (if this is the first instance or sync is disabled)
            if not self.sync_enabled.get() or len(self.instance_manager.active_instances) == 1:
                self.root.after(1000, lambda: self._apply_saved_spectrum_zoom(instance))

            # Sync zoom level and frequency with existing instances if sync is enabled
            if self.sync_enabled.get() and len(self.instance_manager.active_instances) > 1:
                self.root.after(1000, lambda: self._sync_new_instance_zoom(instance))
                self.root.after(1200, lambda: self._sync_new_instance_frequency(instance))
            # Recalculate target throttle rate after connection (give it time to get server rate)
            self.root.after(1000, self._update_target_rate)

            # Check if this instance was being used for audio and restart it
            if self.audio_preview:
                instance_name = instance.get_id_display_name()
                left_name = self.audio_left_instance.get()
                right_name = self.audio_right_instance.get()

                # If this instance is selected for audio but audio is not active, start it
                if (instance_name == left_name or instance_name == right_name):
                    if not self.audio_preview_active:
                        # Wait for connection to stabilize before starting audio
                        self.root.after(2000, self._start_audio_preview)
                        print(f"Will auto-start audio for reconnected instance: {instance_name}")
                    else:
                        # Audio is already active, need to restart the specific channel
                        if instance_name == left_name and not self.audio_preview.left_channel.is_active():
                            self.root.after(2000, lambda: self._restart_audio_channel('left', instance))
                            print(f"Will restart left audio channel for reconnected instance: {instance_name}")
                        elif instance_name == right_name and not self.audio_preview.right_channel.is_active():
                            self.root.after(2000, lambda: self._restart_audio_channel('right', instance))
                            print(f"Will restart right audio channel for reconnected instance: {instance_name}")
        else:
            instance.status_var.set("Error")

    def disconnect_instance(self, instance: SpectrumInstance):
        """Disconnect a single instance."""
        # Close instance window if it exists
        if hasattr(instance, 'instance_window') and instance.instance_window is not None:
            try:
                instance.instance_window.window.destroy()
            except:
                pass  # Window may already be destroyed
            instance.instance_window = None

        # Clean up spectrum display reference so it can be recreated on reconnect
        if instance.spectrum:
            if instance.instance_id in self.spectrum_displays:
                del self.spectrum_displays[instance.instance_id]
            instance.spectrum = None

        # Check if this instance is being used for audio preview
        if self.audio_preview and self.audio_preview_active:
            instance_name = instance.get_id_display_name()
            left_name = self.audio_left_instance.get()
            right_name = self.audio_right_instance.get()

            # Stop audio channels using this instance
            if instance_name == left_name:
                self.audio_preview.stop_preview('left')
                print(f"Stopped left audio channel (instance disconnected)")
            if instance_name == right_name:
                self.audio_preview.stop_preview('right')
                print(f"Stopped right audio channel (instance disconnected)")

            # If both channels stopped, update UI state
            if not self.audio_preview.left_channel.is_active() and not self.audio_preview.right_channel.is_active():
                self.audio_preview_active = False
                self.audio_start_btn.config(text="Start")
                self.audio_left_combo.config(state='readonly')
                self.audio_right_combo.config(state='readonly')
                self._update_spectrum_labels()

        if self.instance_manager.disconnect_instance(instance):
            instance.status_var.set("Enabled" if instance.enabled else "Disabled")
            # Stop session timer
            self._stop_session_timer(instance)
            # Update button text
            if hasattr(instance, 'connect_btn'):
                instance.connect_btn.config(text="Connect")
            # Recalculate target throttle rate after disconnection
            self._update_target_rate()

    def connect_all_enabled(self):
        """Connect all enabled instances."""
        count = 0
        for instance in self.instance_manager.instances:
            if instance.enabled and not instance.connected:
                self.connect_instance(instance)
                if instance.connected:
                    count += 1

        if count > 0:
            print(f"Connected {count} instance(s)")

            # Auto-start audio if we have audio preview and instances are connected
            if self.audio_preview and not self.audio_preview_active:
                # Check if we have at least one connected instance
                if len(self.instance_manager.active_instances) > 0:
                    # Set default audio routing if not already set
                    if self.audio_left_instance.get() == "None" and len(self.instance_manager.active_instances) >= 1:
                        # Set first instance to left channel
                        first_instance = self.instance_manager.active_instances[0]
                        self.audio_left_instance.set(first_instance.get_id_display_name())

                    if self.audio_right_instance.get() == "None" and len(self.instance_manager.active_instances) >= 2:
                        # Set second instance to right channel if available
                        second_instance = self.instance_manager.active_instances[1]
                        self.audio_right_instance.set(second_instance.get_id_display_name())

                    # Start audio preview
                    self.root.after(1000, self._start_audio_preview)


    def disconnect_all(self):
        """Disconnect all instances."""
        count = 0
        for instance in list(self.instance_manager.active_instances):
            self.disconnect_instance(instance)
            count += 1

        if count > 0:
            print(f"Disconnected {count} instance(s)")

    def edit_instance(self, instance: SpectrumInstance):
        """Edit an instance's configuration."""
        # Disconnect if connected
        was_connected = instance.connected
        if was_connected:
            self.disconnect_instance(instance)

        def on_ok(edited_instance: SpectrumInstance):
            # Update UI
            self.refresh_instance_list()
            self.save_config()

            # Reconnect if was connected
            if was_connected and edited_instance.enabled:
                self.connect_instance(edited_instance)

        EditInstanceDialog(self.root, instance, on_ok)

    def remove_instance(self, instance: SpectrumInstance):
        """Remove an instance."""
        if not messagebox.askyesno("Confirm Remove",
                                   f"Remove {instance.name}?"):
            return

        # Check if this instance is selected in audio dropdowns and reset if so
        if self.audio_preview:
            instance_name = instance.get_id_display_name()
            if self.audio_left_instance.get() == instance_name:
                self.audio_left_instance.set("None")
            if self.audio_right_instance.get() == instance_name:
                self.audio_right_instance.set("None")

        # Disconnect if connected
        if instance.connected:
            self.disconnect_instance(instance)

        # Remove from manager
        self.instance_manager.remove_instance(instance)

        # Remove UI
        if instance.instance_id in self.instance_frames:
            self.instance_frames[instance.instance_id].destroy()
            del self.instance_frames[instance.instance_id]

        # Close instance window if it exists
        if hasattr(instance, 'instance_window') and instance.instance_window is not None:
            try:
                instance.instance_window.window.destroy()
            except:
                pass  # Window may already be destroyed
            instance.instance_window = None

        # Remove spectrum display
        if instance.spectrum:
            if instance.instance_id in self.spectrum_displays:
                del self.spectrum_displays[instance.instance_id]
            instance.spectrum = None

        # Remove from signal levels window
        self._remove_instance_from_signal_levels(instance)
        self._update_comparison_dropdowns()
        self._update_audio_preview_dropdowns()

        self.save_config()

    def refresh_instance_list(self):
        """Refresh the instance list UI."""
        # Clear existing UI
        for widget in self.instance_list_frame.winfo_children():
            widget.destroy()
        self.instance_frames.clear()

        # Recreate UI for all instances
        for instance in self.instance_manager.instances:
            self.create_instance_ui(instance)

    def save_config(self, throttled=False):
        """Save configuration to file.

        Args:
            throttled: If True, use throttled saving (waits 1 second after last change)
        """
        if throttled:
            # Cancel any pending save
            if self._save_config_pending:
                self.root.after_cancel(self._save_config_pending)

            # Schedule a new save after delay
            self._save_config_pending = self.root.after(self._config_save_delay, self._do_save_config)
        else:
            # Immediate save
            self._do_save_config()

    def _do_save_config(self):
        """Actually perform the config save."""
        import time
        self._last_config_save = time.time()
        self._save_config_pending = False

        # Note: Per-instance frequency, mode, and bandwidth are now stored in each
        # SpectrumInstance object and saved via inst.to_dict(). The global frequency/mode/bandwidth
        # parameters are kept for backward compatibility but are no longer the primary source.

        # Get representative settings from first active instance for global settings
        freq_hz = 14100000  # Default
        mode = "USB"
        bandwidth = 2700

        for instance in self.instance_manager.active_instances:
            if instance.spectrum and instance.connected:
                freq_hz = int(instance.frequency)
                mode = instance.mode
                bandwidth = instance.bandwidth
                print(f"[CONFIG SAVE] Using settings from {instance.get_id_display_name()}: {freq_hz} Hz, {mode}, {bandwidth} Hz")
                break

        # Get spectrum display zoom settings from first connected instance
        spectrum_center_freq = None
        spectrum_bandwidth = None
        for instance in self.instance_manager.active_instances:
            if instance.spectrum and instance.connected:
                spectrum_center_freq = instance.spectrum.center_freq
                spectrum_bandwidth = instance.spectrum.total_bandwidth
                break

        # Capture current window geometries
        self._capture_window_geometries()

        self.config_manager.save_config(
            self.instance_manager.instances,
            self.sync_enabled.get(),
            self.throttle_enabled.get(),
            freq_hz,
            mode,
            bandwidth,
            self.audio_left_instance.get(),
            self.audio_right_instance.get(),
            self.audio_left_volume.get(),
            self.audio_right_volume.get(),
            self.audio_left_mono.get(),
            self.audio_right_mono.get(),
            self.compare_instance_a.get(),
            self.compare_instance_b.get(),
            spectrum_center_freq,
            spectrum_bandwidth,
            self.manual_offset_var.get() if hasattr(self, 'manual_offset_var') else 0,
            self.window_geometries
        )

    def load_config(self):
        """Load configuration from file."""
        instances, settings = self.config_manager.load_config(self.MAX_INSTANCES)

        # Load window geometries
        self.window_geometries = settings.get('window_geometries', {})

        # Restore main window geometry if saved
        if 'main' in self.window_geometries:
            try:
                self.root.geometry(self.window_geometries['main'])
            except:
                pass  # If geometry is invalid, use default

        # Load synchronization settings
        self.sync_enabled.set(settings.get('sync_enabled', True))
        self.throttle_enabled.set(settings.get('throttle_enabled', True))

        # Load frequency, mode, and bandwidth settings (kept for backward compatibility)
        freq_hz = settings.get('frequency', 14100000)
        mode = settings.get('mode', 'USB')
        bandwidth = settings.get('bandwidth', 2700)

        # Store as defaults for new instances
        self.default_frequency = freq_hz
        self.default_mode = mode
        self.default_bandwidth = bandwidth

        # Load audio preview settings
        audio_preview = settings.get('audio_preview', {})
        # Don't set audio instances yet - wait until after instances are loaded
        saved_left_instance = audio_preview.get('left_instance', 'None')
        saved_right_instance = audio_preview.get('right_instance', 'None')
        self.audio_left_volume.set(audio_preview.get('left_volume', 1.0))
        self.audio_right_volume.set(audio_preview.get('right_volume', 1.0))
        self.audio_left_mono.set(audio_preview.get('left_mono', False))
        self.audio_right_mono.set(audio_preview.get('right_mono', False))

        # Load manual offset if available
        manual_offset = audio_preview.get('manual_offset', 0)
        if hasattr(self, 'manual_offset_var'):
            self.manual_offset_var.set(manual_offset)
            self.manual_offset_label.config(text=f"{manual_offset:+d} ms")

        # Update volume labels
        self.left_volume_label.config(text=f"{int(self.audio_left_volume.get() * 100)}%")
        self.right_volume_label.config(text=f"{int(self.audio_right_volume.get() * 100)}%")

        # Load comparison settings
        comparison = settings.get('comparison', {})
        # Don't set comparison instances yet - wait until after instances are loaded
        saved_compare_a = comparison.get('instance_a', 'None')
        saved_compare_b = comparison.get('instance_b', 'None')

        # Load spectrum display zoom settings
        spectrum_display = settings.get('spectrum_display', {})
        self._saved_spectrum_center_freq = spectrum_display.get('center_freq')
        self._saved_spectrum_bandwidth = spectrum_display.get('bandwidth')

        for instance in instances:
            self.instance_manager.add_instance(instance)
            self.create_instance_ui(instance)

        # Update audio preview dropdowns after loading all instances
        self._update_audio_preview_dropdowns()

        # Now validate and set saved audio/comparison instances
        # Get list of valid instance names
        valid_instance_names = [inst.get_id_display_name() for inst in self.instance_manager.instances]

        # Set audio instances only if they exist
        if saved_left_instance in valid_instance_names:
            self.audio_left_instance.set(saved_left_instance)
        else:
            self.audio_left_instance.set('None')

        if saved_right_instance in valid_instance_names:
            self.audio_right_instance.set(saved_right_instance)
        else:
            self.audio_right_instance.set('None')

        # Set comparison instances only if they exist
        if saved_compare_a in valid_instance_names:
            self.compare_instance_a.set(saved_compare_a)
        else:
            self.compare_instance_a.set('None')

        if saved_compare_b in valid_instance_names:
            self.compare_instance_b.set(saved_compare_b)
        else:
            self.compare_instance_b.set('None')

    def _apply_saved_spectrum_zoom(self, instance: SpectrumInstance):
        """Apply saved spectrum display zoom settings to a newly connected instance.

        Args:
            instance: The instance to apply saved zoom settings to
        """
        import asyncio

        # Only apply if we have saved settings and the instance is connected
        if (not hasattr(self, '_saved_spectrum_center_freq') or
            not hasattr(self, '_saved_spectrum_bandwidth') or
            self._saved_spectrum_center_freq is None or
            self._saved_spectrum_bandwidth is None):
            return

        if not instance.spectrum or not instance.spectrum.connected or not instance.spectrum.event_loop:
            return

        # Apply the saved zoom settings
        asyncio.run_coroutine_threadsafe(
            instance.spectrum._send_zoom_command(
                self._saved_spectrum_center_freq,
                self._saved_spectrum_bandwidth
            ),
            instance.spectrum.event_loop
        )
        print(f"Applied saved spectrum zoom to {instance.name}: "
              f"{self._saved_spectrum_center_freq/1e6:.6f} MHz, "
              f"{self._saved_spectrum_bandwidth/1e3:.1f} kHz")

    def _capture_window_geometries(self):
        """Capture current window positions and sizes."""
        try:
            # Save main window geometry
            self.window_geometries['main'] = self.root.geometry()

            # Save signal levels window geometry if open
            if self.signal_levels_window and tk.Toplevel.winfo_exists(self.signal_levels_window):
                self.window_geometries['signal_levels'] = self.signal_levels_window.geometry()

            # Save MIDI window geometry if open
            if hasattr(self, 'midi_window') and self.midi_window and tk.Toplevel.winfo_exists(self.midi_window):
                self.window_geometries['midi'] = self.midi_window.geometry()

            # Save instance window geometries
            for instance in self.instance_manager.instances:
                if hasattr(instance, 'instance_window') and instance.instance_window is not None:
                    try:
                        if instance.instance_window.window.winfo_exists():
                            window_key = f'instance_{instance.instance_id}'
                            self.window_geometries[window_key] = instance.instance_window.window.geometry()
                    except:
                        pass
        except Exception as e:
            print(f"Error capturing window geometries: {e}")

    def on_closing(self):
        """Handle window close event."""
        # Stop audio preview
        if self.audio_preview and self.audio_preview_active:
            self.audio_preview.stop_all()

        # Disconnect MIDI controller
        if self.midi_controller:
            self.midi_controller.disconnect()

        # Cancel any pending throttled save and do immediate save BEFORE disconnecting
        if self._save_config_pending:
            self.root.after_cancel(self._save_config_pending)
            self._save_config_pending = False

        # Save configuration immediately (while instances are still connected)
        self.save_config()

        # Disconnect all instances
        self.disconnect_all()

        # Close window
        self.root.destroy()

    def _setup_sync_callbacks(self, spectrum: SpectrumDisplay, instance_id: int):
        """Set up synchronization callbacks for a spectrum display.

        Args:
            spectrum: SpectrumDisplay instance to set up callbacks for
            instance_id: ID of the instance this spectrum belongs to
        """
        import asyncio
        import time

        # Store original methods
        original_zoom_in = spectrum.zoom_in
        original_zoom_out = spectrum.zoom_out
        original_on_drag = spectrum.on_drag
        original_on_scroll_up = spectrum.on_scroll_up
        original_on_scroll_down = spectrum.on_scroll_down
        original_on_mousewheel = spectrum.on_mousewheel
        original_draw_spectrum = spectrum._draw_spectrum

        # Wrap zoom_in to sync all displays
        def synced_zoom_in():
            original_zoom_in()
            if self.sync_enabled.get() and not self._syncing:
                self._syncing = True
                self.root.after(100, lambda: self._sync_zoom_from_source(spectrum))

        # Wrap zoom_out to sync all displays
        def synced_zoom_out():
            original_zoom_out()
            if self.sync_enabled.get() and not self._syncing:
                self._syncing = True
                self.root.after(100, lambda: self._sync_zoom_from_source(spectrum))

        # Wrap on_drag to sync all displays
        def synced_on_drag(event):
            original_on_drag(event)
            if self.sync_enabled.get() and not self._syncing:
                self._syncing = True
                self.root.after(100, lambda: self._sync_pan_from_source(spectrum))

        # Wrap scroll handlers to sync zoom
        def synced_on_scroll_up(event):
            original_on_scroll_up(event)
            if spectrum.scroll_mode == 'zoom' and self.sync_enabled.get() and not self._syncing:
                self._syncing = True
                self.root.after(100, lambda: self._sync_zoom_from_source(spectrum))

        def synced_on_scroll_down(event):
            original_on_scroll_down(event)
            if spectrum.scroll_mode == 'zoom' and self.sync_enabled.get() and not self._syncing:
                self._syncing = True
                self.root.after(100, lambda: self._sync_zoom_from_source(spectrum))

        def synced_on_mousewheel(event):
            original_on_mousewheel(event)
            if spectrum.scroll_mode == 'zoom' and self.sync_enabled.get() and not self._syncing:
                self._syncing = True
                self.root.after(100, lambda: self._sync_zoom_from_source(spectrum))

        # Wrap _draw_spectrum to throttle based on server-reported rates and feed to spectrum aligner
        def throttled_draw_spectrum():
            current_time = time.time()

            # Check if throttling is enabled and we should skip this frame
            should_draw = True
            if self.throttle_enabled.get() and self.target_update_rate:
                # Get this instance's server-reported rate
                instance = self.instance_manager.get_instance_by_id(instance_id)
                if instance:
                    instance_rate = instance.update_rate_hz

                    # Only throttle if this instance is faster than target
                    # Add 10% margin to avoid throttling the slowest instance
                    if instance_rate > self.target_update_rate * 1.1:
                        if len(self.update_times[instance_id]) >= 1:
                            # Calculate time since last SUCCESSFUL draw
                            time_since_last = current_time - self.update_times[instance_id][-1]
                            min_interval = 1.0 / self.target_update_rate

                            # If updating too fast, skip this frame (with 90% threshold for tolerance)
                            if time_since_last < min_interval * 0.9:
                                should_draw = False

            # Draw the spectrum if not throttled
            if should_draw:
                # Spectrum sync disabled due to performance issues
                # Original code kept for reference:
                # if self.use_timestamp_sync and self.spectrum_aligner and spectrum.last_spectrum_timestamp:
                #     if spectrum.spectrum_data is not None and len(spectrum.spectrum_data) > 0:
                #         try:
                #             self.spectrum_aligner.add_data(
                #                 instance_id,
                #                 spectrum.last_spectrum_timestamp,
                #                 spectrum.spectrum_data.copy()
                #             )
                #         except Exception as e:
                #             pass

                original_draw_spectrum()

                # Track this SUCCESSFUL draw for frame skipping
                self.update_times[instance_id].append(current_time)

                # Keep only last 5 updates for frame skipping
                self.update_times[instance_id] = self.update_times[instance_id][-5:]

        # Replace methods with wrapped versions
        spectrum._draw_spectrum = throttled_draw_spectrum
        spectrum.zoom_in = synced_zoom_in
        spectrum.zoom_out = synced_zoom_out
        spectrum.on_drag = synced_on_drag
        spectrum.on_scroll_up = synced_on_scroll_up
        spectrum.on_scroll_down = synced_on_scroll_down
        spectrum.on_mousewheel = synced_on_mousewheel

        # Rebind canvas events to use wrapped methods
        spectrum.canvas.bind('<B1-Motion>', synced_on_drag)
        spectrum.canvas.bind('<Button-4>', synced_on_scroll_up)
        spectrum.canvas.bind('<Button-5>', synced_on_scroll_down)
        spectrum.canvas.bind('<MouseWheel>', synced_on_mousewheel)

        print(f"Sync callbacks set up for spectrum display (instance {instance_id})")

    def _sync_zoom_from_source(self, source_spectrum: SpectrumDisplay):
        """Synchronize zoom state from source to all other displays.

        Args:
            source_spectrum: The spectrum display that initiated the zoom
        """
        import asyncio

        # Get current state from source
        if not source_spectrum.connected or source_spectrum.bin_count == 0:
            self._syncing = False
            return

        frequency = source_spectrum.center_freq
        bandwidth = source_spectrum.total_bandwidth

        # Sync to all other connected displays
        for instance in self.instance_manager.active_instances:
            if instance.spectrum and instance.spectrum != source_spectrum:
                if instance.spectrum.connected and instance.spectrum.event_loop:
                    # Send zoom command asynchronously
                    asyncio.run_coroutine_threadsafe(
                        instance.spectrum._send_zoom_command(frequency, bandwidth),
                        instance.spectrum.event_loop
                    )

        self._syncing = False

        # Save config after zoom change (immediate, not throttled)
        self.save_config(throttled=False)

    def _on_frequency_change(self, frequency: float, source_spectrum: SpectrumDisplay):
        """Handle frequency change from click-to-tune.

        Args:
            frequency: New frequency in Hz
            source_spectrum: The spectrum display that initiated the change
        """
        if self._syncing:
            return

        # Check if source instance is locked
        for instance in self.instance_manager.active_instances:
            if instance.spectrum == source_spectrum and hasattr(instance, 'locked') and instance.locked:
                print(f"Ignoring frequency change - {instance.get_id_display_name()} is locked")
                return

        self._syncing = True

        if self.sync_enabled.get():
            # Sync mode: Update frequency for all connected instances (except locked ones)
            for instance in self.instance_manager.active_instances:
                if instance.spectrum and instance.spectrum.connected:
                    # Skip locked instances
                    if hasattr(instance, 'locked') and instance.locked:
                        continue

                    instance.spectrum.update_center_frequency(frequency)
                    instance.frequency = int(frequency)

                    # Update per-instance UI in instance window
                    if hasattr(instance, 'instance_window') and instance.instance_window is not None:
                        instance.instance_window.update_frequency_display(frequency)

            print(f"Synchronized frequency to {frequency/1e6:.6f} MHz across all instances")
        else:
            # Independent mode: Only update the source spectrum's instance
            for instance in self.instance_manager.active_instances:
                if instance.spectrum == source_spectrum:
                    instance.frequency = int(frequency)

                    # Actually tune the spectrum (this sends the pan command to the server)
                    if instance.spectrum and instance.spectrum.connected:
                        instance.spectrum.update_center_frequency(frequency)

                    # Update per-instance UI in instance window
                    if hasattr(instance, 'instance_window') and instance.instance_window is not None:
                        instance.instance_window.update_frequency_display(frequency)

                    print(f"Updated frequency to {frequency/1e6:.6f} MHz for {instance.get_id_display_name()}")
                    break

        self._syncing = False

        # Update the frequency input box (global state for backward compatibility)
        self._update_frequency_display(frequency)

        # Update audio preview if active
        self._update_audio_preview_frequency(int(frequency))

        # Save config after frequency change (immediate, not throttled)
        print(f"[FREQ CHANGE] Frequency changed to {frequency/1e6:.6f} MHz, saving config...")
        self.save_config(throttled=False)

    def _on_frequency_step(self, direction: int, source_spectrum: SpectrumDisplay):
        """Handle frequency step from mouse wheel in pan mode.

        Args:
            direction: +1 for up, -1 for down
            source_spectrum: The spectrum display that initiated the step
        """
        # Don't block if syncing is in progress
        if self._syncing:
            return

        # Check if source instance is locked
        for instance in self.instance_manager.active_instances:
            if instance.spectrum == source_spectrum and hasattr(instance, 'locked') and instance.locked:
                print(f"Ignoring frequency step - {instance.get_id_display_name()} is locked")
                return

        self._syncing = True

        # Get step size from dropdown
        step_size = self._get_step_size_hz()
        frequency_change = direction * step_size

        # Update frequency for all connected instances (or just source if sync disabled)
        new_freq = None
        if self.sync_enabled.get():
            # Sync to all instances (except locked ones)
            for instance in self.instance_manager.active_instances:
                if instance.spectrum and instance.spectrum.connected:
                    # Skip locked instances
                    if hasattr(instance, 'locked') and instance.locked:
                        continue

                    new_freq = instance.spectrum.tuned_freq + frequency_change
                    # Constrain to valid range
                    new_freq = max(100000, min(30000000, new_freq))
                    instance.spectrum.update_center_frequency(new_freq)
                    # Update instance's stored frequency
                    instance.frequency = int(new_freq)

                    # Update per-instance UI in instance window
                    if hasattr(instance, 'instance_window') and instance.instance_window is not None:
                        instance.instance_window.update_frequency_display(new_freq)
        else:
            # Only update the source spectrum and its instance
            for instance in self.instance_manager.active_instances:
                if instance.spectrum == source_spectrum:
                    new_freq = source_spectrum.tuned_freq + frequency_change
                    # Constrain to valid range
                    new_freq = max(100000, min(30000000, new_freq))
                    source_spectrum.update_center_frequency(new_freq)
                    # Update instance's stored frequency
                    instance.frequency = int(new_freq)

                    # Update per-instance UI in instance window
                    if hasattr(instance, 'instance_window') and instance.instance_window is not None:
                        instance.instance_window.update_frequency_display(new_freq)
                    break

        self._syncing = False

        # Update the frequency input box if we have a new frequency
        if new_freq is not None:
            self._update_frequency_display(new_freq)

        # Update audio preview if active
        self._update_audio_preview_frequency()

        # Save config after frequency step
        if new_freq is not None:
            print(f"[FREQ STEP] Saving config after stepping to {new_freq/1e6:.6f} MHz...")
            self.save_config(throttled=False)

    def _sync_pan_from_source(self, source_spectrum: SpectrumDisplay):
        """Synchronize pan state from source to all other displays.

        Args:
            source_spectrum: The spectrum display that initiated the pan
        """
        import asyncio

        # Get current state from source
        if not source_spectrum.connected:
            self._syncing = False
            return

        frequency = source_spectrum.center_freq

        # Sync to all other connected displays
        for instance in self.instance_manager.active_instances:
            if instance.spectrum and instance.spectrum != source_spectrum:
                if instance.spectrum.connected and instance.spectrum.event_loop:
                    # Send pan command asynchronously
                    asyncio.run_coroutine_threadsafe(
                        instance.spectrum._send_pan_command(frequency),
                        instance.spectrum.event_loop
                    )

        self._syncing = False

        # Save config after pan change (immediate, not throttled)
        self.save_config(throttled=False)

    def _sync_new_instance_zoom(self, new_instance: SpectrumInstance):
        """Synchronize a newly connected instance to match existing instances' zoom level."""
        import asyncio

        # Find a connected instance to copy zoom from
        source_spectrum = None
        for instance in self.instance_manager.active_instances:
            if instance != new_instance and instance.spectrum and instance.spectrum.connected:
                source_spectrum = instance.spectrum
                break

        if not source_spectrum or not new_instance.spectrum or not new_instance.spectrum.connected:
            return

        # Get zoom state from source
        if source_spectrum.bin_count == 0:
            return

        frequency = source_spectrum.center_freq
        bandwidth = source_spectrum.total_bandwidth

        # Apply to new instance
        if new_instance.spectrum.event_loop:
            asyncio.run_coroutine_threadsafe(
                new_instance.spectrum._send_zoom_command(frequency, bandwidth),
                new_instance.spectrum.event_loop
            )
            print(f"Synced new instance to existing zoom: {frequency/1e6:.6f} MHz, {bandwidth/1e3:.1f} kHz")

    def _sync_new_instance_frequency(self, new_instance: SpectrumInstance):
        """Synchronize a newly connected instance's tuned frequency to match existing instances."""
        # Find a connected instance to copy frequency from
        source_spectrum = None
        for instance in self.instance_manager.active_instances:
            if instance != new_instance and instance.spectrum and instance.spectrum.connected:
                source_spectrum = instance.spectrum
                break

        if not source_spectrum or not new_instance.spectrum or not new_instance.spectrum.connected:
            return

        # Get tuned frequency from source
        tuned_freq = source_spectrum.tuned_freq

        # Apply to new instance
        new_instance.spectrum.update_center_frequency(tuned_freq)
        print(f"Synced new instance to existing frequency: {tuned_freq/1e6:.6f} MHz")

    def _update_target_rate(self):
        """Update target throttle rate based on server-reported rates from all connected instances."""
        rates = []
        for instance in self.instance_manager.active_instances:
            if instance.spectrum and instance.connected:
                rates.append(instance.update_rate_hz)

        if rates:
            self.target_update_rate = min(rates)

            # Log server-reported rates
            print(f"\nServer-reported update rates:")
            for instance in self.instance_manager.active_instances:
                if instance.spectrum and instance.connected:
                    print(f"  {instance.name}: {instance.update_rate_hz:.1f} Hz ({instance.spectrum_poll_period}ms)")
            print(f"Throttling to: {self.target_update_rate:.1f} Hz (slowest instance)")
        else:
            self.target_update_rate = None

    def _on_mode_change(self, event=None):
        """Handle mode selection change."""
        mode = self.current_mode.get()

        # Set default bandwidth for mode
        mode_bandwidths = {
            "USB": 2700,
            "LSB": 2700,
            "CWU": 500,
            "CWL": 500,
            "AM": 6000,
            "FM": 10000
        }

        if mode in mode_bandwidths:
            self._set_bandwidth(mode_bandwidths[mode])

        # Update audio preview if active
        self._update_audio_preview_mode()

        # Save config after mode change
        self.save_config(throttled=True)

    def _on_bandwidth_change(self, value):
        """Handle bandwidth slider change (legacy - kept for compatibility)."""
        bandwidth = int(float(value))
        self.current_bandwidth.set(bandwidth)
        self._update_all_bandwidths()
        # Update audio preview bandwidth
        self._update_audio_preview_bandwidth()
        # Save config after bandwidth change
        self.save_config(throttled=True)

    def _set_bandwidth(self, bandwidth: int):
        """Set bandwidth to a specific value (legacy - kept for compatibility)."""
        self.current_bandwidth.set(bandwidth)
        self._update_all_bandwidths()

    def _on_scroll_mode_change(self):
        """Handle scroll mode change."""
        mode = self.scroll_mode.get()
        # Update all connected spectrum displays
        for instance in self.instance_manager.active_instances:
            if instance.spectrum and instance.connected:
                instance.spectrum.set_scroll_mode(mode)
        print(f"Scroll mode changed to: {mode}")

    def _get_step_size_hz(self) -> int:
        """Get the current step size in Hz."""
        step_str = self.step_size.get()
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

    def _on_step_size_changed(self):
        """Handle step size change - update all spectrum displays."""
        step_hz = self._get_step_size_hz()
        # Update all connected spectrum displays
        for instance in self.instance_manager.active_instances:
            if instance.spectrum and instance.connected:
                instance.spectrum.set_step_size(step_hz)

    def _on_center_tune_changed(self):
        """Handle center tune checkbox change."""
        # The center_tune_var is already shared with all spectrum displays
        # so they will automatically use the new setting
        enabled = self.center_tune.get()
        print(f"Center tune {'enabled' if enabled else 'disabled'}")

    def _apply_instance_frequency(self, instance: SpectrumInstance, freq_var: tk.StringVar, freq_unit_var: tk.StringVar):
        """Apply frequency to a specific instance."""
        if hasattr(instance, 'locked') and instance.locked:
            return
        try:
            freq_value = float(freq_var.get())
            unit = freq_unit_var.get()

            # Convert to Hz
            if unit == "MHz":
                freq_hz = int(freq_value * 1e6)
            elif unit == "kHz":
                freq_hz = int(freq_value * 1e3)
            else:  # Hz
                freq_hz = int(freq_value)

            # Validate frequency range
            if freq_hz < 100000 or freq_hz > 30000000:
                messagebox.showerror("Invalid Frequency",
                                   f"Frequency must be between 100 kHz and 30 MHz")
                return

            # Update instance
            instance.frequency = freq_hz

            # Apply to spectrum if connected
            if instance.spectrum and instance.connected:
                instance.spectrum.update_center_frequency(freq_hz)

            # If sync is enabled, update all other instances
            if self.sync_enabled.get():
                self._sync_frequency_to_all(freq_hz, instance)

            # Update audio preview if active
            self._update_audio_preview_frequency()

            print(f"Applied frequency {freq_hz/1e6:.6f} MHz to {instance.get_id_display_name()}")
            self.save_config(throttled=True)
        except ValueError as e:
            messagebox.showerror("Invalid Frequency", str(e))

    def _on_instance_frequency_unit_changed(self, instance: SpectrumInstance, freq_var: tk.StringVar, freq_unit_var: tk.StringVar):
        """Handle frequency unit change for a specific instance."""
        try:
            freq_value = float(freq_var.get())

            # Convert from old unit to Hz (assume MHz for now)
            freq_hz = int(freq_value * 1e6)

            # Convert to new unit
            new_unit = freq_unit_var.get()
            if new_unit == "MHz":
                new_value = freq_hz / 1e6
                freq_var.set(f"{new_value:.6f}")
            elif new_unit == "kHz":
                new_value = freq_hz / 1e3
                freq_var.set(f"{new_value:.3f}")
            else:  # Hz
                freq_var.set(str(freq_hz))
        except ValueError:
            pass

    def _on_instance_mode_change(self, instance: SpectrumInstance, mode_var: tk.StringVar):
        """Handle mode change for a specific instance."""
        if hasattr(instance, 'locked') and instance.locked:
            return
        mode = mode_var.get()
        instance.mode = mode

        # Set default bandwidth for mode
        mode_bandwidths = {
            "USB": 2700,
            "LSB": 2700,
            "CWU": 500,
            "CWL": 500,
            "AM": 6000,
            "FM": 10000
        }

        if mode in mode_bandwidths:
            bandwidth = mode_bandwidths[mode]
            instance.bandwidth = bandwidth

            # Update UI in instance window if it exists
            if hasattr(instance, 'instance_window') and instance.instance_window is not None:
                instance.instance_window.bandwidth_var.set(bandwidth)
                instance.instance_window.bw_label.config(text=f"{bandwidth/1000:.1f} kHz")

            # Apply to spectrum if connected
            if instance.spectrum and instance.connected:
                self._apply_instance_bandwidth_to_spectrum(instance)

        # If sync is enabled, update all other instances
        if self.sync_enabled.get():
            self._sync_mode_to_all(mode, instance)

        # Update audio preview if this instance is being used for audio
        self._update_audio_preview_mode()
        self._update_audio_preview_bandwidth()

        print(f"Mode changed to {mode} for {instance.get_id_display_name()}")
        self.save_config(throttled=True)

    def _on_instance_bandwidth_change(self, instance: SpectrumInstance, bandwidth_var: tk.IntVar, bw_label: ttk.Label):
        """Handle bandwidth change for a specific instance."""
        if hasattr(instance, 'locked') and instance.locked:
            return
        bandwidth = int(bandwidth_var.get())
        instance.bandwidth = bandwidth
        bw_label.config(text=f"{bandwidth/1000:.1f} kHz")

        # Apply to spectrum if connected
        if instance.spectrum and instance.connected:
            self._apply_instance_bandwidth_to_spectrum(instance)

        # If sync is enabled, update all other instances
        if self.sync_enabled.get():
            self._sync_bandwidth_to_all(bandwidth, instance)

        # Update audio preview if this instance is being used for audio
        self._update_audio_preview_bandwidth()

        self.save_config(throttled=True)

    def _set_instance_bandwidth(self, instance: SpectrumInstance, bandwidth: int, bandwidth_var: tk.IntVar, bw_label: ttk.Label):
        """Set bandwidth to a specific value for an instance."""
        if hasattr(instance, 'locked') and instance.locked:
            return
        instance.bandwidth = bandwidth
        bandwidth_var.set(bandwidth)
        bw_label.config(text=f"{bandwidth/1000:.1f} kHz")

        # Apply to spectrum if connected
        if instance.spectrum and instance.connected:
            self._apply_instance_bandwidth_to_spectrum(instance)

        # If sync is enabled, update all other instances
        if self.sync_enabled.get():
            self._sync_bandwidth_to_all(bandwidth, instance)

        # Update audio preview if this instance is being used for audio
        self._update_audio_preview_bandwidth()

        self.save_config(throttled=True)

    def _apply_instance_settings_after_connect(self, instance: SpectrumInstance):
        """Apply instance's saved settings after connection is established.

        This ensures the spectrum is tuned to the saved frequency, mode, and bandwidth.
        """
        if not instance.spectrum or not instance.spectrum.connected:
            return

        # Apply frequency
        print(f"Applying saved frequency {instance.frequency/1e6:.6f} MHz to {instance.get_id_display_name()}")
        instance.spectrum.update_center_frequency(instance.frequency)

        # Apply bandwidth
        self._apply_instance_bandwidth_to_spectrum(instance)

    def _apply_instance_bandwidth_to_spectrum(self, instance: SpectrumInstance):
        """Apply instance's bandwidth settings to its spectrum display."""
        bandwidth = instance.bandwidth
        mode = instance.mode

        # Calculate filter edges based on mode
        if mode == "USB":
            low = 0
            high = bandwidth
        elif mode == "LSB":
            low = -bandwidth
            high = 0
        elif mode == "CWU":
            low = 0
            high = bandwidth
        elif mode == "CWL":
            low = -bandwidth
            high = 0
        elif mode == "AM":
            low = -bandwidth // 2
            high = bandwidth // 2
        elif mode == "FM":
            low = -bandwidth // 2
            high = bandwidth // 2
        else:
            low = -bandwidth // 2
            high = bandwidth // 2

        instance.spectrum.update_bandwidth(low, high)

    def _sync_frequency_to_all(self, freq_hz: int, source_instance: SpectrumInstance):
        """Sync frequency to all other instances when sync is enabled."""
        for instance in self.instance_manager.instances:
            if instance.instance_id != source_instance.instance_id:
                # Skip locked instances
                if hasattr(instance, 'locked') and instance.locked:
                    continue

                instance.frequency = freq_hz

                # Update UI in instance window
                if hasattr(instance, 'instance_window') and instance.instance_window is not None:
                    instance.instance_window.update_frequency_display(freq_hz)

                # Apply to spectrum if connected
                if instance.spectrum and instance.connected:
                    instance.spectrum.update_center_frequency(freq_hz)

    def _sync_mode_to_all(self, mode: str, source_instance: SpectrumInstance):
        """Sync mode to all other instances when sync is enabled."""
        for instance in self.instance_manager.instances:
            if instance.instance_id != source_instance.instance_id:
                # Skip locked instances
                if hasattr(instance, 'locked') and instance.locked:
                    continue

                instance.mode = mode

                # Update UI in instance window
                if hasattr(instance, 'instance_window') and instance.instance_window is not None:
                    instance.instance_window.mode_var.set(mode)

    def _sync_bandwidth_to_all(self, bandwidth: int, source_instance: SpectrumInstance):
        """Sync bandwidth to all other instances when sync is enabled."""
        for instance in self.instance_manager.instances:
            if instance.instance_id != source_instance.instance_id:
                # Skip locked instances
                if hasattr(instance, 'locked') and instance.locked:
                    continue

                instance.bandwidth = bandwidth

                # Update UI in instance window
                if hasattr(instance, 'instance_window') and instance.instance_window is not None:
                    instance.instance_window.bandwidth_var.set(bandwidth)
                    instance.instance_window.bw_label.config(text=f"{bandwidth/1000:.1f} kHz")

                # Apply to spectrum if connected
                if instance.spectrum and instance.connected:
                    self._apply_instance_bandwidth_to_spectrum(instance)

    def _sync_a_to_b(self):
        """Sync all settings from instance A to instance B."""
        # Find instances A and B
        instance_a = None
        instance_b = None

        for instance in self.instance_manager.instances:
            if instance.id_label == 'A':
                instance_a = instance
            elif instance.id_label == 'B':
                instance_b = instance

        if not instance_a:
            messagebox.showwarning("Instance Not Found", "Instance A not found")
            return

        if not instance_b:
            messagebox.showwarning("Instance Not Found", "Instance B not found")
            return

        # Copy all settings from A to B
        instance_b.frequency = instance_a.frequency
        instance_b.mode = instance_a.mode
        instance_b.bandwidth = instance_a.bandwidth

        # Update B's UI in instance window
        if hasattr(instance_b, 'instance_window') and instance_b.instance_window is not None:
            instance_b.instance_window.update_frequency_display(instance_a.frequency)
            instance_b.instance_window.mode_var.set(instance_a.mode)
            instance_b.instance_window.bandwidth_var.set(instance_a.bandwidth)
            instance_b.instance_window.bw_label.config(text=f"{instance_a.bandwidth/1000:.1f} kHz")

        # Apply to B's spectrum if connected
        if instance_b.spectrum and instance_b.connected:
            instance_b.spectrum.update_center_frequency(instance_a.frequency)
            self._apply_instance_bandwidth_to_spectrum(instance_b)

        # Update audio preview if B is being used
        self._update_audio_preview_frequency()
        self._update_audio_preview_mode()
        self._update_audio_preview_bandwidth()

        print(f"Synced settings from A to B: {instance_a.frequency/1e6:.6f} MHz, {instance_a.mode}, {instance_a.bandwidth} Hz")
        self.save_config(throttled=True)

    def _sync_b_to_a(self):
        """Sync all settings from instance B to instance A."""
        # Find instances A and B
        instance_a = None
        instance_b = None

        for instance in self.instance_manager.instances:
            if instance.id_label == 'A':
                instance_a = instance
            elif instance.id_label == 'B':
                instance_b = instance

        if not instance_a:
            messagebox.showwarning("Instance Not Found", "Instance A not found")
            return

        if not instance_b:
            messagebox.showwarning("Instance Not Found", "Instance B not found")
            return

        # Copy all settings from B to A
        instance_a.frequency = instance_b.frequency
        instance_a.mode = instance_b.mode
        instance_a.bandwidth = instance_b.bandwidth

        # Update A's UI in instance window
        if hasattr(instance_a, 'instance_window') and instance_a.instance_window is not None:
            instance_a.instance_window.update_frequency_display(instance_b.frequency)
            instance_a.instance_window.mode_var.set(instance_b.mode)
            instance_a.instance_window.bandwidth_var.set(instance_b.bandwidth)
            instance_a.instance_window.bw_label.config(text=f"{instance_b.bandwidth/1000:.1f} kHz")

        # Apply to A's spectrum if connected
        if instance_a.spectrum and instance_a.connected:
            instance_a.spectrum.update_center_frequency(instance_b.frequency)
            self._apply_instance_bandwidth_to_spectrum(instance_a)

        # Update audio preview if A is being used
        self._update_audio_preview_frequency()
        self._update_audio_preview_mode()
        self._update_audio_preview_bandwidth()

        print(f"Synced settings from B to A: {instance_b.frequency/1e6:.6f} MHz, {instance_b.mode}, {instance_b.bandwidth} Hz")
        self.save_config(throttled=True)

    def _get_frequency_hz(self) -> int:
        """Convert frequency from current unit to Hz."""
        try:
            freq_value = float(self.frequency_input.get())
            unit = self.frequency_unit.get()

            if unit == "MHz":
                return int(freq_value * 1e6)
            elif unit == "kHz":
                return int(freq_value * 1e3)
            else:  # Hz
                return int(freq_value)
        except ValueError:
            raise ValueError("Invalid frequency value")

    def _on_frequency_unit_changed(self):
        """Handle frequency unit change - convert current value to new unit."""
        try:
            # Get current value and convert from previous unit to Hz
            freq_value = float(self.frequency_input.get())
            old_unit = self.prev_frequency_unit

            # Convert from old unit to Hz
            if old_unit == "MHz":
                freq_hz = int(freq_value * 1e6)
            elif old_unit == "kHz":
                freq_hz = int(freq_value * 1e3)
            else:  # Hz
                freq_hz = int(freq_value)

            # Convert from Hz to new unit
            new_unit = self.frequency_unit.get()
            if new_unit == "MHz":
                new_value = freq_hz / 1e6
                self.frequency_input.set(f"{new_value:.6f}")
            elif new_unit == "kHz":
                new_value = freq_hz / 1e3
                self.frequency_input.set(f"{new_value:.3f}")
            else:  # Hz
                self.frequency_input.set(str(freq_hz))

            # Update previous unit for next conversion
            self.prev_frequency_unit = new_unit
        except ValueError:
            # If conversion fails, just update the previous unit
            self.prev_frequency_unit = self.frequency_unit.get()

    def _update_frequency_display(self, freq_hz: float):
        """Update the frequency input box to show the current frequency.

        Args:
            freq_hz: Frequency in Hz
        """
        # Convert to the current unit
        unit = self.frequency_unit.get()

        if unit == "MHz":
            freq_value = freq_hz / 1e6
            self.frequency_input.set(f"{freq_value:.6f}")
        elif unit == "kHz":
            freq_value = freq_hz / 1e3
            self.frequency_input.set(f"{freq_value:.3f}")
        else:  # Hz
            self.frequency_input.set(str(int(freq_hz)))

    def _apply_frequency(self):
        """Apply the frequency from the input field to all connected instances."""
        try:
            freq_hz = self._get_frequency_hz()

            # Validate frequency range (100 kHz - 30 MHz)
            if freq_hz < 100000:
                messagebox.showerror("Invalid Frequency",
                                   f"Frequency must be at least 100 kHz\n(You entered: {freq_hz/1e3:.3f} kHz)")
                return
            elif freq_hz > 30000000:
                messagebox.showerror("Invalid Frequency",
                                   f"Frequency must be at most 30 MHz\n(You entered: {freq_hz/1e6:.6f} MHz)")
                return

            # Update all connected instances
            for instance in self.instance_manager.active_instances:
                if instance.spectrum and instance.spectrum.connected:
                    instance.spectrum.update_center_frequency(freq_hz)

            print(f"Applied frequency: {freq_hz/1e6:.6f} MHz to all instances")

            # Update audio preview if active
            self._update_audio_preview_frequency(freq_hz)

            # Save config after applying frequency
            print(f"[APPLY FREQ] Saving config after applying {freq_hz/1e6:.6f} MHz...")
            self.save_config(throttled=False)
        except ValueError as e:
            messagebox.showerror("Invalid Frequency", str(e))

    def _update_all_bandwidths(self):
        """Update bandwidth filter on all connected spectrum displays."""
        bandwidth = self.current_bandwidth.get()
        mode = self.current_mode.get()

        # Calculate filter edges based on mode
        if mode == "USB":
            # Upper sideband: 0 to +bandwidth
            low = 0
            high = bandwidth
        elif mode == "LSB":
            # Lower sideband: -bandwidth to 0
            low = -bandwidth
            high = 0
        elif mode == "CWU":
            # CW upper: 0 to +bandwidth
            low = 0
            high = bandwidth
        elif mode == "CWL":
            # CW lower: -bandwidth to 0
            low = -bandwidth
            high = 0
        elif mode == "AM":
            # AM: symmetric around carrier
            low = -bandwidth // 2
            high = bandwidth // 2
        elif mode == "FM":
            # FM: symmetric around carrier
            low = -bandwidth // 2
            high = bandwidth // 2
        else:
            # Default: symmetric
            low = -bandwidth // 2
            high = bandwidth // 2

        # Update all connected spectrum displays
        for instance in self.instance_manager.active_instances:
            if instance.spectrum and instance.connected:
                instance.spectrum.update_bandwidth(low, high)

    def show_signal_levels_window(self):
        """Show or raise the signal levels window."""
        if self.signal_levels_window is None or not tk.Toplevel.winfo_exists(self.signal_levels_window):
            self._create_signal_levels_window()
        else:
            self.signal_levels_window.lift()

    def _create_signal_levels_window(self):
        """Create the signal levels window."""
        self.signal_levels_window = tk.Toplevel(self.root)
        self.signal_levels_window.title("Signal Levels")

        # Restore saved geometry or use default
        if 'signal_levels' in self.window_geometries:
            try:
                self.signal_levels_window.geometry(self.window_geometries['signal_levels'])
            except:
                self.signal_levels_window.geometry("700x400")  # Fallback to default
        else:
            self.signal_levels_window.geometry("700x400")

        # Header with hover frequency
        header_frame = ttk.Frame(self.signal_levels_window, padding="10")
        header_frame.pack(fill=tk.X)
        ttk.Label(header_frame, text="Hover Frequency:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT)
        self.freq_label = ttk.Label(header_frame, text="---.------ MHz", font=('TkDefaultFont', 10))
        self.freq_label.pack(side=tk.LEFT, padx=(5, 20))

        # Tuned frequency
        ttk.Label(header_frame, text="Tuned Frequency:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT)
        self.tuned_freq_label = ttk.Label(header_frame, text="---.------ MHz", font=('TkDefaultFont', 10))
        self.tuned_freq_label.pack(side=tk.LEFT, padx=(5, 0))

        # Bandwidth info
        bw_frame = ttk.Frame(self.signal_levels_window, padding="10")
        bw_frame.pack(fill=tk.X)
        ttk.Label(bw_frame, text="Filter Bandwidth:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT)
        self.bw_label = ttk.Label(bw_frame, text="--- Hz", font=('TkDefaultFont', 10))
        self.bw_label.pack(side=tk.LEFT, padx=(5, 0))

        # Comparison controls
        compare_frame = ttk.Frame(self.signal_levels_window, padding="10")
        compare_frame.pack(fill=tk.X)
        ttk.Label(compare_frame, text="Compare:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT, padx=(0, 5))

        # Get instance names for dropdown
        instance_names = ["None"] + [inst.get_id_display_name() for inst in self.instance_manager.instances]

        ttk.Label(compare_frame, text="A:").pack(side=tk.LEFT, padx=(5, 2))
        compare_a_combo = ttk.Combobox(compare_frame, textvariable=self.compare_instance_a,
                                       values=instance_names, state='readonly', width=20)
        compare_a_combo.pack(side=tk.LEFT, padx=(0, 10))
        compare_a_combo.bind('<<ComboboxSelected>>', lambda e: self._on_comparison_changed())

        ttk.Label(compare_frame, text="B:").pack(side=tk.LEFT, padx=(5, 2))
        compare_b_combo = ttk.Combobox(compare_frame, textvariable=self.compare_instance_b,
                                       values=instance_names, state='readonly', width=20)
        compare_b_combo.pack(side=tk.LEFT, padx=(0, 5))
        compare_b_combo.bind('<<ComboboxSelected>>', lambda e: self._on_comparison_changed())

        ttk.Label(compare_frame, text="(A - B, 500ms avg; Time Δ: 5s avg)", font=('TkDefaultFont', 9, 'italic')).pack(side=tk.LEFT, padx=(10, 0))

        # Sync metrics display (if simple alignment is available)
        if self.use_simple_alignment and (self.audio_preview or self.spectrum_aligner):
            sync_frame = ttk.Frame(self.signal_levels_window, padding="10")
            sync_frame.pack(fill=tk.X)

            # Audio sync metrics
            if self.audio_preview:
                audio_sync_frame = ttk.Frame(sync_frame)
                audio_sync_frame.pack(fill=tk.X, pady=2)
                ttk.Label(audio_sync_frame, text="Audio Sync:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT, padx=(0, 5))
                self.audio_sync_metrics_label = ttk.Label(audio_sync_frame, text="Waiting for data...", font=('TkDefaultFont', 9))
                self.audio_sync_metrics_label.pack(side=tk.LEFT, padx=(5, 0))
            else:
                self.audio_sync_metrics_label = None

            # Spectrum sync metrics
            if self.spectrum_aligner:
                spectrum_sync_frame = ttk.Frame(sync_frame)
                spectrum_sync_frame.pack(fill=tk.X, pady=2)
                ttk.Label(spectrum_sync_frame, text="Spectrum Sync:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT, padx=(0, 5))
                self.spectrum_sync_metrics_label = ttk.Label(spectrum_sync_frame, text="Waiting for data...", font=('TkDefaultFont', 9))
                self.spectrum_sync_metrics_label.pack(side=tk.LEFT, padx=(5, 0))
            else:
                self.spectrum_sync_metrics_label = None

            # Start periodic metrics update
            self._update_sync_metrics()

        # Separator
        ttk.Separator(self.signal_levels_window, orient=tk.HORIZONTAL).pack(fill=tk.X, padx=10)

        # Scrollable frame for signal levels
        canvas = tk.Canvas(self.signal_levels_window)
        scrollbar = ttk.Scrollbar(self.signal_levels_window, orient="vertical", command=canvas.yview)
        scrollable_frame = ttk.Frame(canvas)

        scrollable_frame.bind(
            "<Configure>",
            lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
        )

        canvas.create_window((0, 0), window=scrollable_frame, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)

        canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=10, pady=10)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # Create labels for each instance with two columns
        self.signal_level_labels = {}
        for instance in self.instance_manager.instances:
            frame = ttk.LabelFrame(scrollable_frame, text=instance.get_id_display_name(), padding="5")
            frame.pack(fill=tk.X, pady=5)

            # Create a grid for two columns of metrics
            metrics_frame = ttk.Frame(frame)
            metrics_frame.pack(fill=tk.X)

            # Column headers
            ttk.Label(metrics_frame, text="At Hover Freq", font=('TkDefaultFont', 9, 'bold'),
                     anchor=tk.CENTER).grid(row=0, column=0, columnspan=2, pady=(0, 5))
            ttk.Label(metrics_frame, text="In Bandwidth", font=('TkDefaultFont', 9, 'bold'),
                     anchor=tk.CENTER).grid(row=0, column=2, columnspan=2, pady=(0, 5))
            ttk.Label(metrics_frame, text="Difference (A-B)", font=('TkDefaultFont', 9, 'bold'),
                     anchor=tk.CENTER).grid(row=0, column=4, columnspan=2, pady=(0, 5))

            # Left column - Hover frequency (just level)
            ttk.Label(metrics_frame, text="Level:", width=10, anchor=tk.W).grid(row=1, column=0, sticky=tk.W, padx=2)
            hover_level_label = ttk.Label(metrics_frame, text="--- dB", width=10, anchor=tk.E,
                                         font=('TkDefaultFont', 9, 'bold'))
            hover_level_label.grid(row=1, column=1, sticky=tk.E, padx=2)

            # Middle column - Bandwidth metrics
            ttk.Label(metrics_frame, text="Peak:", width=10, anchor=tk.W).grid(row=1, column=2, sticky=tk.W, padx=(10, 2))
            bw_peak_label = ttk.Label(metrics_frame, text="--- dB", width=10, anchor=tk.E,
                                     font=('TkDefaultFont', 9))
            bw_peak_label.grid(row=1, column=3, sticky=tk.E, padx=2)

            ttk.Label(metrics_frame, text="Floor:", width=10, anchor=tk.W).grid(row=2, column=2, sticky=tk.W, padx=(10, 2))
            bw_floor_label = ttk.Label(metrics_frame, text="--- dB", width=10, anchor=tk.E,
                                      font=('TkDefaultFont', 9))
            bw_floor_label.grid(row=2, column=3, sticky=tk.E, padx=2)

            ttk.Label(metrics_frame, text="SNR:", width=10, anchor=tk.W).grid(row=3, column=2, sticky=tk.W, padx=(10, 2))
            bw_snr_label = ttk.Label(metrics_frame, text="--- dB", width=10, anchor=tk.E,
                                    font=('TkDefaultFont', 9, 'bold'))
            bw_snr_label.grid(row=3, column=3, sticky=tk.E, padx=2)

            # Right column - Comparison differences
            ttk.Label(metrics_frame, text="Peak:", width=10, anchor=tk.W).grid(row=1, column=4, sticky=tk.W, padx=(10, 2))
            diff_peak_label = ttk.Label(metrics_frame, text="---", width=10, anchor=tk.E,
                                       font=('TkDefaultFont', 9))
            diff_peak_label.grid(row=1, column=5, sticky=tk.E, padx=2)

            ttk.Label(metrics_frame, text="Floor:", width=10, anchor=tk.W).grid(row=2, column=4, sticky=tk.W, padx=(10, 2))
            diff_floor_label = ttk.Label(metrics_frame, text="---", width=10, anchor=tk.E,
                                        font=('TkDefaultFont', 9))
            diff_floor_label.grid(row=2, column=5, sticky=tk.E, padx=2)

            ttk.Label(metrics_frame, text="SNR:", width=10, anchor=tk.W).grid(row=3, column=4, sticky=tk.W, padx=(10, 2))
            diff_snr_label = ttk.Label(metrics_frame, text="---", width=10, anchor=tk.E,
                                      font=('TkDefaultFont', 9, 'bold'))
            diff_snr_label.grid(row=3, column=5, sticky=tk.E, padx=2)

            # Timestamp difference (only shown when comparing)
            ttk.Label(metrics_frame, text="Time Δ:", width=10, anchor=tk.W).grid(row=4, column=4, sticky=tk.W, padx=(10, 2))
            diff_timestamp_label = ttk.Label(metrics_frame, text="---", width=10, anchor=tk.E,
                                            font=('TkDefaultFont', 9))
            diff_timestamp_label.grid(row=4, column=5, sticky=tk.E, padx=2)

            # Store all labels for this instance
            self.signal_level_labels[instance.instance_id] = {
                'frame': frame,
                'hover_level': hover_level_label,
                'bw_peak': bw_peak_label,
                'bw_floor': bw_floor_label,
                'bw_snr': bw_snr_label,
                'diff_peak': diff_peak_label,
                'diff_floor': diff_floor_label,
                'diff_snr': diff_snr_label,
                'diff_timestamp': diff_timestamp_label
            }

        # Store the scrollable frame for dynamic updates
        self.signal_levels_scrollable_frame = scrollable_frame

        # Handle window close
        self.signal_levels_window.protocol("WM_DELETE_WINDOW", self._on_signal_levels_close)

    def _on_signal_levels_close(self):
        """Handle signal levels window close."""
        self.signal_levels_window.destroy()
        self.signal_levels_window = None
        self.signal_level_labels = {}
        self.signal_levels_scrollable_frame = None

    def _add_instance_to_signal_levels(self, instance: SpectrumInstance):
        """Add an instance to the signal levels window if it's open."""
        if not self.signal_levels_window or not tk.Toplevel.winfo_exists(self.signal_levels_window):
            return

        if instance.instance_id in self.signal_level_labels:
            return  # Already exists

        # Create frame for this instance
        frame = ttk.LabelFrame(self.signal_levels_scrollable_frame, text=instance.get_id_display_name(), padding="5")
        frame.pack(fill=tk.X, pady=5)

        # Create a grid for two columns of metrics
        metrics_frame = ttk.Frame(frame)
        metrics_frame.pack(fill=tk.X)

        # Column headers
        ttk.Label(metrics_frame, text="At Hover Freq", font=('TkDefaultFont', 9, 'bold'),
                 anchor=tk.CENTER).grid(row=0, column=0, columnspan=2, pady=(0, 5))
        ttk.Label(metrics_frame, text="In Bandwidth", font=('TkDefaultFont', 9, 'bold'),
                 anchor=tk.CENTER).grid(row=0, column=2, columnspan=2, pady=(0, 5))
        ttk.Label(metrics_frame, text="Difference (A-B)", font=('TkDefaultFont', 9, 'bold'),
                 anchor=tk.CENTER).grid(row=0, column=4, columnspan=2, pady=(0, 5))

        # Left column - Hover frequency (just level)
        ttk.Label(metrics_frame, text="Level:", width=10, anchor=tk.W).grid(row=1, column=0, sticky=tk.W, padx=2)
        hover_level_label = ttk.Label(metrics_frame, text="--- dB", width=10, anchor=tk.E,
                                     font=('TkDefaultFont', 9, 'bold'))
        hover_level_label.grid(row=1, column=1, sticky=tk.E, padx=2)

        # Middle column - Bandwidth metrics
        ttk.Label(metrics_frame, text="Peak:", width=10, anchor=tk.W).grid(row=1, column=2, sticky=tk.W, padx=(10, 2))
        bw_peak_label = ttk.Label(metrics_frame, text="--- dB", width=10, anchor=tk.E,
                                 font=('TkDefaultFont', 9))
        bw_peak_label.grid(row=1, column=3, sticky=tk.E, padx=2)

        ttk.Label(metrics_frame, text="Floor:", width=10, anchor=tk.W).grid(row=2, column=2, sticky=tk.W, padx=(10, 2))
        bw_floor_label = ttk.Label(metrics_frame, text="--- dB", width=10, anchor=tk.E,
                                  font=('TkDefaultFont', 9))
        bw_floor_label.grid(row=2, column=3, sticky=tk.E, padx=2)

        ttk.Label(metrics_frame, text="SNR:", width=10, anchor=tk.W).grid(row=3, column=2, sticky=tk.W, padx=(10, 2))
        bw_snr_label = ttk.Label(metrics_frame, text="--- dB", width=10, anchor=tk.E,
                                font=('TkDefaultFont', 9, 'bold'))
        bw_snr_label.grid(row=3, column=3, sticky=tk.E, padx=2)

        # Right column - Comparison differences
        ttk.Label(metrics_frame, text="Peak:", width=10, anchor=tk.W).grid(row=1, column=4, sticky=tk.W, padx=(10, 2))
        diff_peak_label = ttk.Label(metrics_frame, text="---", width=10, anchor=tk.E,
                                   font=('TkDefaultFont', 9))
        diff_peak_label.grid(row=1, column=5, sticky=tk.E, padx=2)

        ttk.Label(metrics_frame, text="Floor:", width=10, anchor=tk.W).grid(row=2, column=4, sticky=tk.W, padx=(10, 2))
        diff_floor_label = ttk.Label(metrics_frame, text="---", width=10, anchor=tk.E,
                                    font=('TkDefaultFont', 9))
        diff_floor_label.grid(row=2, column=5, sticky=tk.E, padx=2)

        ttk.Label(metrics_frame, text="SNR:", width=10, anchor=tk.W).grid(row=3, column=4, sticky=tk.W, padx=(10, 2))
        diff_snr_label = ttk.Label(metrics_frame, text="---", width=10, anchor=tk.E,
                                  font=('TkDefaultFont', 9, 'bold'))
        diff_snr_label.grid(row=3, column=5, sticky=tk.E, padx=2)

        # Timestamp difference (only shown when comparing)
        ttk.Label(metrics_frame, text="Time Δ:", width=10, anchor=tk.W).grid(row=4, column=4, sticky=tk.W, padx=(10, 2))
        diff_timestamp_label = ttk.Label(metrics_frame, text="---", width=10, anchor=tk.E,
                                        font=('TkDefaultFont', 9))
        diff_timestamp_label.grid(row=4, column=5, sticky=tk.E, padx=2)

        # Store all labels for this instance
        self.signal_level_labels[instance.instance_id] = {
            'frame': frame,
            'hover_level': hover_level_label,
            'bw_peak': bw_peak_label,
            'bw_floor': bw_floor_label,
            'bw_snr': bw_snr_label,
            'diff_peak': diff_peak_label,
            'diff_floor': diff_floor_label,
            'diff_snr': diff_snr_label,
            'diff_timestamp': diff_timestamp_label
        }

    def _remove_instance_from_signal_levels(self, instance: SpectrumInstance):
        """Remove an instance from the signal levels window if it's open."""
        if not self.signal_levels_window or not tk.Toplevel.winfo_exists(self.signal_levels_window):
            return

        if instance.instance_id in self.signal_level_labels:
            # Destroy the frame
            self.signal_level_labels[instance.instance_id]['frame'].destroy()
            # Remove from dictionary
            del self.signal_level_labels[instance.instance_id]

    def _update_comparison_dropdowns(self):
        """Update the comparison dropdown values if signal levels window is open."""
        if not self.signal_levels_window or not tk.Toplevel.winfo_exists(self.signal_levels_window):
            return

        # Get updated instance names
        instance_names = ["None"] + [inst.get_id_display_name() for inst in self.instance_manager.instances]

        # Find the comparison comboboxes and update their values
        # We need to search through the window's children to find them
        for child in self.signal_levels_window.winfo_children():
            if isinstance(child, ttk.Frame):
                for subchild in child.winfo_children():
                    if isinstance(subchild, ttk.Combobox):
                        subchild['values'] = instance_names

    def _setup_cursor_sync(self, spectrum, instance_id: int):
        """Set up cursor synchronization for a spectrum display."""
        original_draw_spectrum = spectrum._draw_spectrum

        def synced_on_motion(event):
            # Only process if THIS spectrum is the one being hovered
            if spectrum.total_bandwidth == 0 or spectrum.spectrum_data is None:
                return

            # Clear all other spectrums' cursors and tooltips when we enter this one
            if self.currently_hovered_spectrum != spectrum:
                # Clear all spectrums first
                for inst in self.instance_manager.active_instances:
                    if inst.spectrum and inst.spectrum.connected:
                        if inst.spectrum.tooltip_id:
                            inst.spectrum.canvas.delete(inst.spectrum.tooltip_id)
                            inst.spectrum.tooltip_id = None
                        if inst.spectrum.cursor_line_id:
                            inst.spectrum.canvas.delete(inst.spectrum.cursor_line_id)
                            inst.spectrum.cursor_line_id = None
                        inst.spectrum.cursor_x = -1
                        inst.spectrum.last_mouse_x = -1
                        inst.spectrum.last_mouse_y = -1

                # Mark this spectrum as currently hovered
                self.currently_hovered_spectrum = spectrum

            # Store mouse position
            spectrum.last_mouse_x = event.x
            spectrum.last_mouse_y = event.y

            x = event.x - spectrum.margin_left
            if x < 0 or x > spectrum.graph_width:
                # Clear everything when outside graph area
                spectrum.cursor_x = -1
                spectrum.last_mouse_x = -1
                spectrum.last_mouse_y = -1
                if spectrum.tooltip_id:
                    spectrum.canvas.delete(spectrum.tooltip_id)
                    spectrum.tooltip_id = None
                if spectrum.cursor_line_id:
                    spectrum.canvas.delete(spectrum.cursor_line_id)
                    spectrum.cursor_line_id = None
                self.currently_hovered_spectrum = None
                return

            # Store cursor position
            spectrum.cursor_x = event.x

            # Calculate frequency at cursor
            freq = spectrum.center_freq - spectrum.total_bandwidth/2 + (x / spectrum.graph_width) * spectrum.total_bandwidth
            self.current_frequency = freq

            # Get dB value at cursor position
            bin_index = int((x / spectrum.graph_width) * len(spectrum.spectrum_data))
            if 0 <= bin_index < len(spectrum.spectrum_data):
                db = spectrum.spectrum_data[bin_index]

                # Draw cursor line ONLY on THIS spectrum
                if spectrum.cursor_line_id:
                    spectrum.canvas.delete(spectrum.cursor_line_id)
                spectrum.cursor_line_id = spectrum.canvas.create_line(
                    event.x, spectrum.margin_top,
                    event.x, spectrum.margin_top + spectrum.graph_height,
                    fill='white', width=1, dash=(3, 3)
                )

                # Draw tooltip ONLY on THIS spectrum
                if spectrum.tooltip_id:
                    spectrum.canvas.delete(spectrum.tooltip_id)

                tooltip_text = f"{freq/1e6:.6f} MHz\n{db:.1f} dB"
                tooltip_x = event.x + 10 if event.x < spectrum.width / 2 else event.x - 10
                anchor = tk.W if event.x < spectrum.width / 2 else tk.E

                spectrum.tooltip_id = spectrum.canvas.create_text(
                    tooltip_x, event.y - 10,
                    text=tooltip_text,
                    fill='yellow',
                    font=('monospace', 9),
                    anchor=anchor
                )

                # Update frequency display in signal levels window
                if self.signal_levels_window and tk.Toplevel.winfo_exists(self.signal_levels_window):
                    self.freq_label.config(text=f"{freq/1e6:.6f} MHz")

                # Update signal levels for all instances (but don't draw cursors on them)
                self._update_signal_levels(freq)

        def on_leave(event):
            """Handle mouse leaving the canvas."""
            # Clear cursor and tooltip on this spectrum
            spectrum.cursor_x = -1
            spectrum.last_mouse_x = -1
            spectrum.last_mouse_y = -1
            if spectrum.tooltip_id:
                spectrum.canvas.delete(spectrum.tooltip_id)
                spectrum.tooltip_id = None
            if spectrum.cursor_line_id:
                spectrum.canvas.delete(spectrum.cursor_line_id)
                spectrum.cursor_line_id = None

            # Clear currently hovered if this was it
            if self.currently_hovered_spectrum == spectrum:
                self.currently_hovered_spectrum = None

        def synced_draw_spectrum():
            # Call original draw
            original_draw_spectrum()

            # Update signal levels if we have a current frequency
            if self.current_frequency is not None:
                self._update_signal_levels(self.current_frequency)

        # Replace the handlers
        spectrum.on_motion = synced_on_motion
        spectrum._draw_spectrum = synced_draw_spectrum
        spectrum.canvas.bind('<Motion>', synced_on_motion)
        spectrum.canvas.bind('<Leave>', on_leave)


    def _update_signal_levels(self, frequency: float):
        """Update signal level display for all instances at given frequency."""
        if not self.signal_levels_window or not tk.Toplevel.winfo_exists(self.signal_levels_window):
            return

        import time

        # Update bandwidth display
        bandwidth = self.current_bandwidth.get()
        self.bw_label.config(text=f"{bandwidth} Hz")

        # Update tuned frequency display (get from first connected instance)
        tuned_freq = None
        for instance in self.instance_manager.active_instances:
            if instance.spectrum and instance.connected:
                tuned_freq = instance.spectrum.tuned_freq
                break

        if tuned_freq:
            self.tuned_freq_label.config(text=f"{tuned_freq/1e6:.6f} MHz")
        else:
            self.tuned_freq_label.config(text="---.------ MHz")

        current_time = time.time()

        for instance in self.instance_manager.instances:
            if instance.instance_id in self.signal_level_labels:
                labels = self.signal_level_labels[instance.instance_id]

                if instance.spectrum and instance.connected and instance.spectrum.spectrum_data is not None and len(instance.spectrum.spectrum_data) > 0:
                    spectrum = instance.spectrum

                    # Throttle updates if enabled and we have a target rate
                    should_update = True
                    if self.throttle_enabled.get() and self.target_update_rate:
                        instance_rate = instance.update_rate_hz

                        # Only throttle if this instance is faster than target
                        if instance_rate > self.target_update_rate * 1.1:
                            # Check if enough time has passed since last update
                            if instance.instance_id in self.signal_levels_last_update:
                                time_since_last = current_time - self.signal_levels_last_update[instance.instance_id]
                                min_interval = 1.0 / self.target_update_rate

                                # If updating too fast, skip this update
                                if time_since_last < min_interval * 0.9:
                                    should_update = False

                    if not should_update:
                        continue

                    # Record this update time
                    self.signal_levels_last_update[instance.instance_id] = current_time

                    # LEFT COLUMN: Get level at hover frequency (cursor position)
                    if spectrum.total_bandwidth > 0:
                        start_freq = spectrum.center_freq - spectrum.total_bandwidth / 2
                        bin_index = int((frequency - start_freq) / spectrum.total_bandwidth * len(spectrum.spectrum_data))

                        if 0 <= bin_index < len(spectrum.spectrum_data):
                            level_db = spectrum.spectrum_data[bin_index]
                            labels['hover_level'].config(text=f"{level_db:.1f} dB", foreground='green')
                        else:
                            labels['hover_level'].config(text="--- dB", foreground='gray')
                    else:
                        labels['hover_level'].config(text="--- dB", foreground='gray')

                    # RIGHT COLUMN: Get bandwidth signal metrics at tuned frequency
                    # Calculate filter edges based on current mode
                    mode = self.current_mode.get()
                    if mode == "USB":
                        low = 0
                        high = bandwidth
                    elif mode == "LSB":
                        low = -bandwidth
                        high = 0
                    else:  # CW, AM, FM - symmetric
                        low = -bandwidth // 2
                        high = bandwidth // 2

                    # Use SpectrumDisplay's get_bandwidth_signal method
                    # This calculates metrics within the bandwidth at the tuned frequency
                    peak_db, floor_db, snr_db = spectrum.get_bandwidth_signal(low, high)

                    if peak_db is not None:
                        labels['bw_peak'].config(text=f"{peak_db:.1f} dB", foreground='blue')
                        labels['bw_floor'].config(text=f"{floor_db:.1f} dB", foreground='orange')
                        labels['bw_snr'].config(text=f"{snr_db:.1f} dB", foreground='green')

                        # Store in history for comparison averaging
                        if instance.instance_id not in self.comparison_history:
                            self.comparison_history[instance.instance_id] = []

                        history = self.comparison_history[instance.instance_id]
                        history.append((current_time, peak_db, floor_db, snr_db))

                        # Remove old entries outside the 500ms window
                        cutoff_time = current_time - self.comparison_window
                        self.comparison_history[instance.instance_id] = [
                            entry for entry in history if entry[0] >= cutoff_time
                        ]
                    else:
                        labels['bw_peak'].config(text="--- dB", foreground='gray')
                        labels['bw_floor'].config(text="--- dB", foreground='gray')
                        labels['bw_snr'].config(text="--- dB", foreground='gray')
                else:
                    # Not connected or no data
                    labels['hover_level'].config(text="--- dB", foreground='gray')
                    labels['bw_peak'].config(text="--- dB", foreground='gray')
                    labels['bw_floor'].config(text="--- dB", foreground='gray')
                    labels['bw_snr'].config(text="--- dB", foreground='gray')

        # Update comparison differences
        self._update_comparison_differences()

    def _on_comparison_changed(self):
        """Handle comparison instance selection change."""
        # Clear comparison history when selection changes
        self.comparison_history.clear()
        self.comparison_diff_history.clear()
        self.comparison_timestamp_history.clear()
        self.comparison_last_valid_values.clear()
        self.comparison_last_valid_timestamp_diff.clear()
        self.comparison_last_update = 0
        # Update will happen on next _update_signal_levels cycle

    def _update_comparison_differences(self):
        """Update the comparison difference displays."""
        import time

        current_time = time.time()

        # Throttle display updates to every 200ms
        if current_time - self.comparison_last_update < self.comparison_update_interval:
            return

        self.comparison_last_update = current_time

        instance_a_name = self.compare_instance_a.get()
        instance_b_name = self.compare_instance_b.get()

        if instance_a_name == "None" or instance_b_name == "None":
            # Clear all comparison displays
            for labels in self.signal_level_labels.values():
                labels['diff_peak'].config(text="---", foreground='black')
                labels['diff_floor'].config(text="---", foreground='black')
                labels['diff_snr'].config(text="---", foreground='black')
            return

        # Find the instance IDs
        instance_a_id = None
        instance_b_id = None
        for instance in self.instance_manager.instances:
            if instance.get_id_display_name() == instance_a_name:
                instance_a_id = instance.instance_id
            if instance.get_id_display_name() == instance_b_name:
                instance_b_id = instance.instance_id

        if instance_a_id is None or instance_b_id is None:
            return

        # Calculate averaged values for both instances
        def get_averaged_metrics(instance_id):
            history = self.comparison_history.get(instance_id, [])
            if not history:
                return None

            # Average over the history window
            peak_sum = sum(entry[1] for entry in history)
            floor_sum = sum(entry[2] for entry in history)
            snr_sum = sum(entry[3] for entry in history)
            count = len(history)

            return {
                'peak': peak_sum / count,
                'floor': floor_sum / count,
                'snr': snr_sum / count
            }

        metrics_a = get_averaged_metrics(instance_a_id)
        metrics_b = get_averaged_metrics(instance_b_id)

        if metrics_a is None or metrics_b is None:
            # Not enough data yet
            for labels in self.signal_level_labels.values():
                labels['diff_peak'].config(text="---", foreground='black')
                labels['diff_floor'].config(text="---", foreground='black')
                labels['diff_snr'].config(text="---", foreground='black')
            return

        # Calculate instantaneous differences (A - B)
        diff_peak = metrics_a['peak'] - metrics_b['peak']
        diff_floor = metrics_a['floor'] - metrics_b['floor']
        diff_snr = metrics_a['snr'] - metrics_b['snr']

        # Store difference in history for smoothing
        diff_key = f"{instance_a_id}:{instance_b_id}"

        if diff_key not in self.comparison_diff_history:
            self.comparison_diff_history[diff_key] = []

        diff_history = self.comparison_diff_history[diff_key]
        diff_history.append((current_time, diff_peak, diff_floor, diff_snr))

        # Remove old entries outside the 500ms window
        cutoff_time = current_time - self.comparison_window
        self.comparison_diff_history[diff_key] = [
            entry for entry in diff_history if entry[0] >= cutoff_time
        ]

        # Calculate smoothed differences by averaging over the window
        smoothed_history = self.comparison_diff_history[diff_key]

        # Calculate averaged differences if we have samples
        if len(smoothed_history) >= 1:
            # Average the differences over the window
            diff_peak = sum(entry[1] for entry in smoothed_history) / len(smoothed_history)
            diff_floor = sum(entry[2] for entry in smoothed_history) / len(smoothed_history)
            diff_snr = sum(entry[3] for entry in smoothed_history) / len(smoothed_history)

            # Store as last valid values
            self.comparison_last_valid_values[diff_key] = (diff_peak, diff_floor, diff_snr)
        elif diff_key in self.comparison_last_valid_values:
            # Use last valid values if we don't have enough samples
            diff_peak, diff_floor, diff_snr = self.comparison_last_valid_values[diff_key]
        else:
            # No data at all yet
            for labels in self.signal_level_labels.values():
                labels['diff_peak'].config(text="---", foreground='black')
                labels['diff_floor'].config(text="---", foreground='black')
                labels['diff_snr'].config(text="---", foreground='black')
            return

        # Update displays for both instances
        for instance_id, labels in self.signal_level_labels.items():
            if instance_id == instance_a_id:
                # Show positive differences for instance A
                # Peak: higher is better (green if positive)
                # Floor: lower is better (green if negative, meaning A has lower/better floor)
                # SNR: higher is better (green if positive)
                color_peak = 'green' if diff_peak >= 0 else 'red'
                color_floor = 'red' if diff_floor >= 0 else 'green'  # Inverted: lower floor is better
                color_snr = 'green' if diff_snr >= 0 else 'red'

                labels['diff_peak'].config(
                    text=f"{diff_peak:+.1f} dB",
                    foreground=color_peak
                )
                labels['diff_floor'].config(
                    text=f"{diff_floor:+.1f} dB",
                    foreground=color_floor
                )
                labels['diff_snr'].config(
                    text=f"{diff_snr:+.1f} dB",
                    foreground=color_snr
                )
            elif instance_id == instance_b_id:
                # Show negative differences for instance B (B - A = -(A - B))
                # Peak: higher is better (green if A-B is negative, meaning B is higher)
                # Floor: lower is better (green if A-B is positive, meaning B is lower/better)
                # SNR: higher is better (green if A-B is negative, meaning B is higher)
                color_peak = 'red' if diff_peak >= 0 else 'green'
                color_floor = 'green' if diff_floor >= 0 else 'red'  # Inverted: lower floor is better
                color_snr = 'red' if diff_snr >= 0 else 'green'

                labels['diff_peak'].config(
                    text=f"{-diff_peak:+.1f} dB",
                    foreground=color_peak
                )
                labels['diff_floor'].config(
                    text=f"{-diff_floor:+.1f} dB",
                    foreground=color_floor
                )
                labels['diff_snr'].config(
                    text=f"{-diff_snr:+.1f} dB",
                    foreground=color_snr
                )
            else:
                # Clear for other instances
                labels['diff_peak'].config(text="---", foreground='black')
                labels['diff_floor'].config(text="---", foreground='black')
                labels['diff_snr'].config(text="---", foreground='black')
                labels['diff_timestamp'].config(text="---", foreground='black')

        # Update alignment system with averaged offsets
        self._update_alignment_offsets(instance_a_id, instance_b_id)

        # Update timestamp difference for compared instances with averaging
        instance_a = self.instance_manager.get_instance_by_id(instance_a_id)
        instance_b = self.instance_manager.get_instance_by_id(instance_b_id)

        if instance_a and instance_b and instance_a.spectrum and instance_b.spectrum:
            ts_a = instance_a.spectrum.last_spectrum_timestamp
            ts_b = instance_b.spectrum.last_spectrum_timestamp

            if ts_a is not None and ts_b is not None:
                # Calculate instantaneous time difference in milliseconds (signed: A - B)
                time_diff_ms = ts_a - ts_b

                # Store in history for averaging (always collect data)
                ts_diff_key = f"{instance_a_id}:{instance_b_id}"

                if ts_diff_key not in self.comparison_timestamp_history:
                    self.comparison_timestamp_history[ts_diff_key] = []

                ts_history = self.comparison_timestamp_history[ts_diff_key]
                ts_history.append((current_time, time_diff_ms))

                # Remove old entries outside the 5 second window
                cutoff_time = current_time - self.comparison_timestamp_window
                self.comparison_timestamp_history[ts_diff_key] = [
                    entry for entry in ts_history if entry[0] >= cutoff_time
                ]

                # Only update display every 1 second (throttle display updates)
                if current_time - self.comparison_timestamp_last_update < self.comparison_timestamp_update_interval:
                    # Don't update display yet, but keep collecting data
                    return

                self.comparison_timestamp_last_update = current_time

                # Calculate averaged timestamp difference over the 5 second window
                smoothed_ts_history = self.comparison_timestamp_history[ts_diff_key]

                if len(smoothed_ts_history) >= 3:  # Require at least 3 samples for stability
                    # Average the timestamp differences over the window
                    avg_time_diff_ms = sum(entry[1] for entry in smoothed_ts_history) / len(smoothed_ts_history)

                    # Store as last valid value
                    self.comparison_last_valid_timestamp_diff[ts_diff_key] = avg_time_diff_ms
                elif ts_diff_key in self.comparison_last_valid_timestamp_diff:
                    # Use last valid value if we don't have enough samples yet
                    avg_time_diff_ms = self.comparison_last_valid_timestamp_diff[ts_diff_key]
                else:
                    # Not enough data yet
                    self.signal_level_labels[instance_a_id]['diff_timestamp'].config(text="---", foreground='gray')
                    self.signal_level_labels[instance_b_id]['diff_timestamp'].config(text="---", foreground='gray')
                    return

                # Display the averaged timestamp difference (only updates once per second)
                abs_diff = abs(avg_time_diff_ms)

                # Determine which is ahead based on averaged value
                if avg_time_diff_ms > 0:
                    # A is ahead (newer) on average
                    self.signal_level_labels[instance_a_id]['diff_timestamp'].config(
                        text=f"+{abs_diff:.1f} ms",
                        foreground='blue'
                    )
                    self.signal_level_labels[instance_b_id]['diff_timestamp'].config(
                        text=f"-{abs_diff:.1f} ms",
                        foreground='orange'
                    )
                else:
                    # B is ahead (newer) on average
                    self.signal_level_labels[instance_a_id]['diff_timestamp'].config(
                        text=f"-{abs_diff:.1f} ms",
                        foreground='orange'
                    )
                    self.signal_level_labels[instance_b_id]['diff_timestamp'].config(
                        text=f"+{abs_diff:.1f} ms",
                        foreground='blue'
                    )
            else:
                # No timestamp data
                self.signal_level_labels[instance_a_id]['diff_timestamp'].config(text="---", foreground='gray')
                self.signal_level_labels[instance_b_id]['diff_timestamp'].config(text="---", foreground='gray')

    def _update_alignment_offsets(self, instance_a_id: int, instance_b_id: int):
        """Update the simple alignment system with averaged timestamp offsets.

        Args:
            instance_a_id: First instance ID
            instance_b_id: Second instance ID
        """
        if not self.use_simple_alignment:
            return

        import time
        current_time = time.time()

        # Get the averaged timestamp difference from history
        ts_diff_key = f"{instance_a_id}:{instance_b_id}"

        if ts_diff_key not in self.comparison_timestamp_history:
            return

        ts_history = self.comparison_timestamp_history[ts_diff_key]

        if len(ts_history) < 3:  # Need at least 3 samples for stability
            return

        # Calculate averaged timestamp difference over the 5 second window
        avg_time_diff_ms = sum(entry[1] for entry in ts_history) / len(ts_history)

        # Update spectrum aligner if available
        if self.spectrum_aligner:
            # Use instance B as reference (offset = 0)
            # Instance A's offset is the difference
            self.spectrum_aligner.update_offset(instance_a_id, avg_time_diff_ms)
            self.spectrum_aligner.update_offset(instance_b_id, 0.0)

        # Update audio aligner if available
        # NOTE: Disabled - audio system calculates its own offsets from audio stream timestamps
        # which are more accurate than spectrum timestamps. Let the audio system handle alignment.
        # if self.audio_preview and hasattr(self.audio_preview, 'simple_aligner'):
        #     self.audio_preview.simple_aligner.update_offset(instance_a_id, avg_time_diff_ms)
        #     self.audio_preview.simple_aligner.update_offset(instance_b_id, 0.0)

    def _update_audio_preview_dropdowns(self):
        """Update the audio preview dropdown values."""
        if not self.audio_preview:
            return

        # Get instance names for dropdown
        instance_names = ["None"] + [inst.get_id_display_name() for inst in self.instance_manager.instances]

        # Update dropdown values
        self.audio_left_combo['values'] = instance_names
        self.audio_right_combo['values'] = instance_names

        # Preselect A for left and B for right if both are currently "None"
        if self.audio_left_instance.get() == "None" and self.audio_right_instance.get() == "None":
            # Find instances A and B
            instance_a = None
            instance_b = None

            for instance in self.instance_manager.instances:
                if instance.id_label == 'A':
                    instance_a = instance
                elif instance.id_label == 'B':
                    instance_b = instance

            # Set defaults if instances exist
            if instance_a:
                self.audio_left_instance.set(instance_a.get_id_display_name())
            if instance_b:
                self.audio_right_instance.set(instance_b.get_id_display_name())

    def _toggle_audio_preview(self):
        """Toggle audio preview on/off."""
        if not self.audio_preview:
            messagebox.showerror("Error", "Audio preview not available (missing sounddevice or websockets)")
            return

        if self.audio_preview_active:
            # Stop preview
            self._stop_audio_preview()
        else:
            # Start preview
            self._start_audio_preview()

    def _start_audio_preview(self):
        """Start audio preview."""
        left_name = self.audio_left_instance.get()
        right_name = self.audio_right_instance.get()

        if left_name == "None" and right_name == "None":
            messagebox.showwarning("No Selection", "Please select at least one instance for audio preview")
            return

        # Find selected instances and cache them
        left_instance = None
        right_instance = None

        for instance in self.instance_manager.instances:
            if instance.get_id_display_name() == left_name:
                left_instance = instance
                self._audio_left_instance_cache = instance
            if instance.get_id_display_name() == right_name:
                right_instance = instance
                self._audio_right_instance_cache = instance

        # Start left channel if selected
        if left_instance:
            if not left_instance.connected:
                messagebox.showwarning("Not Connected",
                                     f"{left_instance.get_id_display_name()} is not connected.\nPlease connect it first.")
                return

            # Get the user_session_id from the spectrum instance
            if not left_instance.user_session_id:
                messagebox.showerror("Error", f"No session ID available for {left_instance.get_id_display_name()}")
                return

            # Use per-instance settings for left channel
            left_freq_hz = left_instance.frequency
            left_mode = left_instance.mode.lower()
            left_bandwidth = left_instance.bandwidth

            success = self.audio_preview.start_preview(
                'left',
                left_instance.instance_id,
                left_instance.host,
                left_instance.port,
                left_instance.tls,
                left_freq_hz,
                left_mode,
                left_instance.user_session_id,
                left_bandwidth,
                use_opus=self.audio_left_opus.get()
            )

            if not success:
                messagebox.showerror("Error", f"Failed to start audio preview for left channel")
                return

        # Start right channel if selected
        if right_instance:
            if not right_instance.connected:
                messagebox.showwarning("Not Connected",
                                     f"{right_instance.get_id_display_name()} is not connected.\nPlease connect it first.")
                if left_instance:
                    self.audio_preview.stop_preview('left')
                return

            # Get the user_session_id from the spectrum instance
            if not right_instance.user_session_id:
                messagebox.showerror("Error", f"No session ID available for {right_instance.get_id_display_name()}")
                if left_instance:
                    self.audio_preview.stop_preview('left')
                return

            # Use per-instance settings for right channel
            right_freq_hz = right_instance.frequency
            right_mode = right_instance.mode.lower()
            right_bandwidth = right_instance.bandwidth

            success = self.audio_preview.start_preview(
                'right',
                right_instance.instance_id,
                right_instance.host,
                right_instance.port,
                right_instance.tls,
                right_freq_hz,
                right_mode,
                right_instance.user_session_id,
                right_bandwidth,
                use_opus=self.audio_right_opus.get()
            )

            if not success:
                messagebox.showerror("Error", f"Failed to start audio preview for right channel")
                if left_instance:
                    self.audio_preview.stop_preview('left')
                return

        # Update state
        self.audio_preview_active = True
        self.audio_start_btn.config(text="Stop")

        # Disable dropdowns while active
        self.audio_left_combo.config(state='disabled')
        self.audio_right_combo.config(state='disabled')

        # Update spectrum frame labels to show audio channel assignments
        self._update_spectrum_labels()

        # Start level meter updates
        self._update_audio_level_meters()

        # Log what we started
        left_info = f"Left={left_name} ({left_instance.frequency/1e6:.6f} MHz, {left_instance.mode}, {left_instance.bandwidth} Hz)" if left_instance else "Left=None"
        right_info = f"Right={right_name} ({right_instance.frequency/1e6:.6f} MHz, {right_instance.mode}, {right_instance.bandwidth} Hz)" if right_instance else "Right=None"
        print(f"Audio preview started: {left_info}, {right_info}")

    def _on_audio_connection_error(self, channel: str, error_message: str):
        """Handle audio connection errors from the audio preview manager.

        Args:
            channel: 'left' or 'right'
            error_message: Error description
        """
        # Find the instance name for this channel
        instance_name = None
        if channel == 'left':
            instance_name = self.audio_left_instance.get()
        elif channel == 'right':
            instance_name = self.audio_right_instance.get()

        # Show error message to user
        error_title = f"Audio Connection Error ({channel.capitalize()} Channel)"
        error_text = f"Failed to connect audio for {instance_name}:\n\n{error_message}"

        # Schedule messagebox on main thread
        self.root.after(0, lambda: messagebox.showerror(error_title, error_text))

        # Check if both channels are now inactive
        def check_and_update_ui():
            if not self.audio_preview.left_channel.is_active() and not self.audio_preview.right_channel.is_active():
                # Both channels failed/stopped, update UI state
                self.audio_preview_active = False
                self.audio_start_btn.config(text="Start")
                self.audio_left_combo.config(state='readonly')
                self.audio_right_combo.config(state='readonly')
                self._update_spectrum_labels()
                print(f"Audio preview stopped due to connection errors")

        # Schedule UI update on main thread
        self.root.after(100, check_and_update_ui)

    def _stop_audio_preview(self):
        """Stop audio preview."""
        if self.audio_preview:
            self.audio_preview.stop_all()

        # Update state
        self.audio_preview_active = False
        self.audio_start_btn.config(text="Start")

        # Re-enable dropdowns
        self.audio_left_combo.config(state='readonly')
        self.audio_right_combo.config(state='readonly')

        # Update spectrum frame labels to remove audio channel assignments
        self._update_spectrum_labels()

        print("Audio preview stopped")

    def _restart_audio_channel(self, channel: str, instance):
        """Restart audio for a specific channel after reconnection.

        Args:
            channel: 'left' or 'right'
            instance: The instance to restart audio for
        """
        if not self.audio_preview or not instance.connected:
            return

        # Get the user_session_id from the spectrum instance
        if not instance.user_session_id:
            print(f"No session ID available for {instance.get_id_display_name()}, cannot restart audio")
            return

        # Use per-instance settings
        freq_hz = instance.frequency
        mode = instance.mode.lower()
        bandwidth = instance.bandwidth

        success = self.audio_preview.start_preview(
            channel,
            instance.instance_id,
            instance.host,
            instance.port,
            instance.tls,
            freq_hz,
            mode,
            instance.user_session_id,
            bandwidth,
            use_opus=self.audio_left_opus.get() if channel == 'left' else self.audio_right_opus.get()
        )

        if success:
            # Update cache
            if channel == 'left':
                self._audio_left_instance_cache = instance
            else:
                self._audio_right_instance_cache = instance

            # Ensure audio preview is marked as active
            if not self.audio_preview_active:
                self.audio_preview_active = True
                self.audio_start_btn.config(text="Stop")
                self.audio_left_combo.config(state='disabled')
                self.audio_right_combo.config(state='disabled')
                self._update_spectrum_labels()

                # Start level meter updates if not already running
                if self._level_meter_update_id is None:
                    self._update_audio_level_meters()

            print(f"Restarted {channel} audio channel for {instance.get_id_display_name()}")
        else:
            print(f"Failed to restart {channel} audio channel for {instance.get_id_display_name()}")

    def _update_audio_preview_frequency(self, freq_hz: int = None):
        """Update audio preview frequency when user changes it.

        Note: This is called when frequency changes via click-to-tune or frequency step.
        Each channel always uses its own instance's current frequency for immediate updates.
        Uses cached instance references for performance.

        Args:
            freq_hz: Ignored - kept for API compatibility. Each channel uses its instance's frequency.
        """
        if not self.audio_preview or not self.audio_preview_active:
            print(f"[AUDIO] Skipping frequency update - preview not active")
            return

        # Use cached instances for performance (avoids lookup on every frequency change)
        left_instance = self._audio_left_instance_cache
        right_instance = self._audio_right_instance_cache

        print(f"[AUDIO] Updating frequency - left_instance: {left_instance.get_id_display_name() if left_instance else 'None'}, right_instance: {right_instance.get_id_display_name() if right_instance else 'None'}")

        # Update left channel if active - always use its instance's current frequency
        if self.audio_preview.left_channel.is_active() and left_instance:
            print(f"[AUDIO] Updating left channel to {left_instance.frequency/1e6:.6f} MHz")
            self.audio_preview.update_frequency('left', left_instance.frequency)

        # Update right channel if active - always use its instance's current frequency
        if self.audio_preview.right_channel.is_active() and right_instance:
            print(f"[AUDIO] Updating right channel to {right_instance.frequency/1e6:.6f} MHz")
            self.audio_preview.update_frequency('right', right_instance.frequency)

    def _update_audio_preview_mode(self):
        """Update audio preview mode when user changes it.

        Note: This is called when mode changes via per-instance controls.
        Uses cached instance references for performance.
        """
        if not self.audio_preview or not self.audio_preview_active:
            return

        # Use cached instances for performance
        left_instance = self._audio_left_instance_cache
        right_instance = self._audio_right_instance_cache

        # Update left channel if active - use its instance's mode
        if self.audio_preview.left_channel.is_active() and left_instance:
            self.audio_preview.update_mode('left', left_instance.mode.lower())

        # Update right channel if active - use its instance's mode
        if self.audio_preview.right_channel.is_active() and right_instance:
            self.audio_preview.update_mode('right', right_instance.mode.lower())

    def _update_audio_preview_bandwidth(self):
        """Update audio preview bandwidth when user changes it.

        Note: This is called when bandwidth changes via per-instance controls.
        Uses cached instance references for performance.
        """
        if not self.audio_preview or not self.audio_preview_active:
            return

        # Use cached instances for performance
        left_instance = self._audio_left_instance_cache
        right_instance = self._audio_right_instance_cache

        # Update left channel if active - use its instance's bandwidth
        if self.audio_preview.left_channel.is_active() and left_instance:
            self.audio_preview.update_bandwidth('left', left_instance.bandwidth)

        # Update right channel if active - use its instance's bandwidth
        if self.audio_preview.right_channel.is_active() and right_instance:
            self.audio_preview.update_bandwidth('right', right_instance.bandwidth)

    def _update_spectrum_labels(self):
        """Update instance window titles to show audio channel assignments."""
        if not self.audio_preview:
            return

        # Get current audio assignments
        left_name = self.audio_left_instance.get()
        right_name = self.audio_right_instance.get()

        # Update each instance's window title
        for instance in self.instance_manager.instances:
            if hasattr(instance, 'instance_window') and instance.instance_window is not None:
                # Build the title text
                base_text = instance.get_id_display_name()
                audio_text = ""

                if self.audio_preview_active:
                    if instance.get_id_display_name() == left_name:
                        audio_text = " [Audio: LEFT Channel]"
                    elif instance.get_id_display_name() == right_name:
                        audio_text = " [Audio: RIGHT Channel]"

                # Update the window title
                if audio_text:
                    instance.instance_window.window.title(base_text + audio_text)
                else:
                    instance.instance_window.window.title(base_text)

    def _on_left_volume_change(self, value):
        """Handle left channel volume change."""
        volume = float(value)
        self.audio_left_volume.set(volume)
        self.left_volume_label.config(text=f"{int(volume * 100)}%")

        # Update audio preview if active (only if not muted)
        if self.audio_preview and self.audio_preview_active:
            if not self.audio_left_mute.get():
                self.audio_preview.set_volume('left', volume)

        # Save config after volume change
        self.save_config(throttled=True)

    def _on_right_volume_change(self, value):
        """Handle right channel volume change."""
        volume = float(value)
        self.audio_right_volume.set(volume)
        self.right_volume_label.config(text=f"{int(volume * 100)}%")

        # Update audio preview if active (only if not muted)
        if self.audio_preview and self.audio_preview_active:
            if not self.audio_right_mute.get():
                self.audio_preview.set_volume('right', volume)

        # Save config after volume change
        self.save_config(throttled=True)

    def _on_left_mute_change(self):
        """Handle left channel mute toggle."""
        muted = self.audio_left_mute.get()

        # Update audio preview if active
        if self.audio_preview and self.audio_preview_active:
            if muted:
                # Set volume to 0 when muted
                self.audio_preview.set_volume('left', 0.0)
            else:
                # Restore volume when unmuted
                self.audio_preview.set_volume('left', self.audio_left_volume.get())

        # Save config after mute change
        self.save_config(throttled=True)

    def _on_right_mute_change(self):
        """Handle right channel mute toggle."""
        muted = self.audio_right_mute.get()

        # Update audio preview if active
        if self.audio_preview and self.audio_preview_active:
            if muted:
                # Set volume to 0 when muted
                self.audio_preview.set_volume('right', 0.0)
            else:
                # Restore volume when unmuted
                self.audio_preview.set_volume('right', self.audio_right_volume.get())

        # Save config after mute change
        self.save_config(throttled=True)

    def _on_left_mono_change(self):
        """Handle left channel mono toggle."""
        mono = self.audio_left_mono.get()

        # Update audio preview if active
        if self.audio_preview and self.audio_preview_active:
            self.audio_preview.set_mono('left', mono)

        # Save config after mono change
        self.save_config(throttled=True)

    def _on_right_mono_change(self):
        """Handle right channel mono toggle."""
        mono = self.audio_right_mono.get()

        # Update audio preview if active
        if self.audio_preview and self.audio_preview_active:
            self.audio_preview.set_mono('right', mono)

        # Save config after mono change
        self.save_config(throttled=True)

    def _on_manual_offset_change(self, value):
        """Handle manual offset slider change."""
        offset_ms = int(float(value))
        self.manual_offset_var.set(offset_ms)
        self.manual_offset_label.config(text=f"{offset_ms:+d} ms")

        # Update audio preview if active
        if self.audio_preview and self.audio_preview_active:
            self.audio_preview.set_manual_offset(offset_ms)
            print(f"Manual offset set to {offset_ms:+d} ms")

        # Save config after offset change
        self.save_config(throttled=True)

    def _update_level_meter(self, channel: str, level: float):
        """Update audio level meter with color coding.

        Args:
            channel: 'left' or 'right'
            level: Level value from 0.0 to 1.0
        """
        if not self.audio_preview:
            return

        # Clamp level to 0-1 range
        level = max(0.0, min(1.0, level))

        # Determine color based on level
        if level < 0.7:
            color = 'green'
        elif level < 0.85:
            color = 'yellow'
        else:
            color = 'red'

        # Update the appropriate meter
        if channel == 'left':
            self.left_level_value = level
            width = int(150 * level)
            self.left_level_canvas.coords(self.left_level_bar, 0, 0, width, 20)
            self.left_level_canvas.itemconfig(self.left_level_bar, fill=color)
        elif channel == 'right':
            self.right_level_value = level
            width = int(150 * level)
            self.right_level_canvas.coords(self.right_level_bar, 0, 0, width, 20)
            self.right_level_canvas.itemconfig(self.right_level_bar, fill=color)

    def _update_audio_level_meters(self):
        """Periodically update audio level meters from audio preview."""
        if not self.audio_preview or not self.audio_preview_active:
            return

        try:
            # Get current audio levels
            left_level, right_level = self.audio_preview.get_audio_levels()

            # Debug: print levels occasionally
            import time
            if not hasattr(self, '_last_level_debug'):
                self._last_level_debug = 0
            # Debug logging disabled - uncomment if needed for troubleshooting
            # if time.time() - self._last_level_debug > 2.0:
            #     print(f"[LEVEL METERS] Left: {left_level:.3f}, Right: {right_level:.3f}")
            #     self._last_level_debug = time.time()

            # Update meters
            self._update_level_meter('left', left_level)
            self._update_level_meter('right', right_level)

            # Update buffer size labels
            if hasattr(self, 'left_buffer_label'):
                left_buffer_ms = self.audio_preview.left_channel.target_buffer_ms
                self.left_buffer_label.config(text=f"{left_buffer_ms:.0f}ms")

            if hasattr(self, 'right_buffer_label'):
                right_buffer_ms = self.audio_preview.right_channel.target_buffer_ms
                self.right_buffer_label.config(text=f"{right_buffer_ms:.0f}ms")
        except Exception as e:
            print(f"Error updating level meters: {e}")
            import traceback
            traceback.print_exc()

        # Schedule next update (50ms = 20 updates per second)
        self._level_meter_update_id = self.root.after(50, self._update_audio_level_meters)

    def _update_sync_metrics(self):
        """Update timestamp synchronization metrics display."""
        if not self.signal_levels_window or not tk.Toplevel.winfo_exists(self.signal_levels_window):
            return

        import time
        current_time = time.time()

        # Only update every second
        if current_time - self.last_metrics_update < self.metrics_update_interval:
            self.root.after(100, self._update_sync_metrics)
            return

        self.last_metrics_update = current_time

        # Update audio sync metrics
        if self.audio_sync_metrics_label:
            audio_metrics = None
            if self.audio_preview and self.audio_preview_active:
                audio_metrics = self.audio_preview.get_sync_metrics()

            if audio_metrics and isinstance(audio_metrics, dict):
                # Check if we have meaningful data
                success_rate = audio_metrics.get('success_rate', 0)
                if success_rate > 0:
                    jitter = audio_metrics.get('jitter_ms', 0)
                    drift = audio_metrics.get('drift_rate', {})
                    drift_val = list(drift.values())[0] if drift else 0

                    # Determine health status
                    is_healthy = (jitter < 100 and success_rate > 0.90)
                    status = "✓" if is_healthy else "⚠"

                    # Build text with available metrics
                    text_parts = [f"{status} jitter={jitter:.1f}ms", f"success={success_rate:.0%}"]
                    if drift_val != 0:
                        text_parts.append(f"drift={drift_val:.2f}ms/s")

                    # Add real-time specific metrics if available
                    if 'buffer_util' in audio_metrics:
                        text_parts.append(f"buf={audio_metrics['buffer_util']:.0%}")
                    if 'alignment_fps' in audio_metrics:
                        text_parts.append(f"fps={audio_metrics['alignment_fps']:.1f}")

                    text = ", ".join(text_parts)
                    color = 'green' if is_healthy else 'orange'
                    self.audio_sync_metrics_label.config(text=text, foreground=color)
                else:
                    self.audio_sync_metrics_label.config(text="Waiting for data...", foreground='gray')
            else:
                self.audio_sync_metrics_label.config(text="Waiting for data...", foreground='gray')

        # Update spectrum sync metrics (simple alignment)
        if self.spectrum_sync_metrics_label:
            if self.spectrum_aligner:
                try:
                    spectrum_metrics = self.spectrum_aligner.get_metrics()
                    if spectrum_metrics.offset_updates > 0:
                        text = str(spectrum_metrics)
                        color = 'green'
                        self.spectrum_sync_metrics_label.config(text=text, foreground=color)
                    else:
                        self.spectrum_sync_metrics_label.config(text="Waiting for data...", foreground='gray')
                except Exception as e:
                    print(f"Spectrum sync error: {e}")
                    self.spectrum_sync_metrics_label.config(text="Error", foreground='red')
            else:
                self.spectrum_sync_metrics_label.config(text="Not available", foreground='gray')

        # Schedule next update
        self.root.after(100, self._update_sync_metrics)

    def _start_session_timer(self, instance):
        """Start the session countdown timer for an instance."""
        if not hasattr(instance, 'max_session_time') or not hasattr(instance, 'connection_start_time'):
            return

        # Store timer job reference in instance
        if not hasattr(instance, 'session_timer_job'):
            instance.session_timer_job = None

        if instance.max_session_time <= 0:
            # No time limit - show "Unlimited" in blue
            instance.session_time_var.set("Unlimited")
        else:
            # Has time limit - start countdown
            self._update_session_timer(instance)

    def _update_session_timer(self, instance):
        """Update the session timer display for an instance."""
        import time

        if not instance.connected or not hasattr(instance, 'max_session_time'):
            return

        if instance.max_session_time <= 0:
            # No time limit - blue
            instance.session_time_var.set("Unlimited")
            return

        if not hasattr(instance, 'connection_start_time') or instance.connection_start_time is None:
            instance.session_time_var.set("")
            return

        # Calculate remaining time
        elapsed = time.time() - instance.connection_start_time
        remaining = max(0, instance.max_session_time - int(elapsed))

        # Format time as MM:SS
        minutes = remaining // 60
        seconds = remaining % 60
        time_str = f"{minutes:02d}:{seconds:02d}"

        # Update display
        instance.session_time_var.set(time_str)

        # Schedule next update if still connected and time remaining
        if instance.connected and remaining > 0:
            instance.session_timer_job = self.root.after(1000, lambda: self._update_session_timer(instance))
        elif remaining == 0:
            instance.session_time_var.set("00:00")

    def _stop_session_timer(self, instance):
        """Stop the session countdown timer for an instance."""
        if hasattr(instance, 'session_timer_job') and instance.session_timer_job:
            self.root.after_cancel(instance.session_timer_job)
            instance.session_timer_job = None

        # Clear the timer display
        if hasattr(instance, 'session_time_var'):
            instance.session_time_var.set("")

    def show_midi_window(self):
        """Show or create the MIDI controller window."""
        if not MIDI_AVAILABLE:
            messagebox.showerror("MIDI Not Available",
                               "MIDI support is not available. Please install python-rtmidi:\n\n"
                               "pip install python-rtmidi")
            return

        # Check if window exists and is visible
        window_exists = False
        if self.midi_window is not None:
            try:
                # Check if window exists and is not withdrawn
                if self.midi_window.winfo_exists():
                    # Check if window is withdrawn (hidden)
                    if self.midi_window.state() == 'withdrawn':
                        # Window exists but is hidden, show it
                        self.midi_window.deiconify()
                        self.midi_window.lift()
                        window_exists = True
                    else:
                        # Window exists and is visible, just raise it
                        window_exists = True
                        self.midi_window.lift()
            except:
                window_exists = False

        if not window_exists:
            # Create new MIDI window
            if self.midi_controller:
                self.midi_window = self.midi_controller.create_window(self.root)

                # Restore saved geometry if available
                if 'midi' in self.window_geometries:
                    try:
                        self.midi_window.geometry(self.window_geometries['midi'])
                    except:
                        pass  # Use default geometry from MIDI controller


def main():
    """Main entry point."""
    if not SPECTRUM_AVAILABLE:
        print("ERROR: Spectrum display module not available")
        print("Make sure spectrum_display.py is in clients/python/")
        sys.exit(1)

    root = tk.Tk()
    app = MultiSpectrumGUI(root)
    root.mainloop()


if __name__ == '__main__':
    main()