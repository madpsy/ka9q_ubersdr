#!/usr/bin/env python3
"""
Multi-Instance Spectrum Client for ka9q_ubersdr
Supports up to 10 simultaneous spectrum connections (GUI only, no audio)
"""

import sys
import os
import tkinter as tk
from tkinter import ttk, messagebox

# Add parent directory to path to import from clients/python
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python'))

try:
    from spectrum_display import SpectrumDisplay
    SPECTRUM_AVAILABLE = True
except ImportError:
    SPECTRUM_AVAILABLE = False
    print("ERROR: Spectrum display not available (missing dependencies)")
    sys.exit(1)

try:
    from public_instances_display import create_public_instances_window
    PUBLIC_INSTANCES_AVAILABLE = True
except ImportError:
    PUBLIC_INSTANCES_AVAILABLE = False
    print("Warning: Public instances display not available")

# Import local modules
from spectrum_instance import SpectrumInstance
from instance_manager import InstanceManager
from config_manager import ConfigManager
from instance_dialogs import AddInstanceDialog, EditInstanceDialog


class MultiSpectrumGUI:
    """Main GUI for multi-instance spectrum client."""
    
    MAX_INSTANCES = 10
    
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Multi-Instance Spectrum Client")
        self.root.geometry("1400x900")
        
        # Managers
        self.instance_manager = InstanceManager(self.MAX_INSTANCES)
        self.config_manager = ConfigManager()
        
        # UI components
        self.instance_frames = {}
        self.spectrum_displays = {}
        self.spectrum_container = None
        self.instance_list_frame = None
        
        # Synchronization state
        self.sync_enabled = tk.BooleanVar(value=True)
        self.throttle_enabled = tk.BooleanVar(value=True)  # Throttle to slowest by default on
        self._syncing = False  # Flag to prevent sync loops

        # Scroll mode state
        self.scroll_mode = tk.StringVar(value="pan")  # Default to pan mode
        self.step_size = tk.StringVar(value="1 kHz")  # Default step size
        self.center_tune = tk.BooleanVar(value=True)  # Center tune enabled by default

        # Frequency input state
        self.frequency_input = tk.StringVar(value="14.100000")  # Default 14.1 MHz
        self.frequency_unit = tk.StringVar(value="MHz")  # Default unit
        self.prev_frequency_unit = "MHz"  # Track previous unit for conversion

        # Mode and bandwidth state
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
        self.comparison_window = 0.5  # 500ms averaging window
        self.comparison_last_update = 0  # Last time we updated the comparison display
        self.comparison_update_interval = 0.2  # Update comparison display every 200ms
        
        # Update rate tracking for throttling (using server-reported rates)
        self.update_times = {}  # instance_id -> list of recent update timestamps (for frame skipping)
        self.target_update_rate = None  # Slowest rate to throttle to (from server-reported rates)
        
        # Create UI
        self.create_widgets()
        
        # Load saved configuration
        self.load_config()

        # Open Signal Levels window on startup (after a short delay)
        self.root.after(500, self.show_signal_levels_window)
        
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
        
        ttk.Button(control_frame, text="Add Instance",
                  command=self.add_instance).pack(side=tk.LEFT, padx=(0, 5))
        
        if PUBLIC_INSTANCES_AVAILABLE:
            ttk.Button(control_frame, text="Add from Public",
                      command=self.add_from_public).pack(side=tk.LEFT, padx=(0, 5))
        
        ttk.Button(control_frame, text="Connect All Enabled",
                  command=self.connect_all_enabled).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(control_frame, text="Disconnect All",
                  command=self.disconnect_all).pack(side=tk.LEFT, padx=(0, 5))

        ttk.Separator(control_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, padx=10, fill=tk.Y)
        ttk.Button(control_frame, text="Signal Levels",
                  command=self.show_signal_levels_window).pack(side=tk.LEFT, padx=(0, 5))

        # Synchronization control
        ttk.Separator(control_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, padx=10, fill=tk.Y)
        ttk.Checkbutton(control_frame, text="Synchronize Pan/Zoom",
                       variable=self.sync_enabled).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Checkbutton(control_frame, text="Throttle to Slowest",
                       variable=self.throttle_enabled).pack(side=tk.LEFT, padx=(0, 5))

        # Scroll mode control
        ttk.Separator(control_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, padx=10, fill=tk.Y)
        ttk.Label(control_frame, text="Scroll:").pack(side=tk.LEFT, padx=(0, 5))
        ttk.Radiobutton(control_frame, text="Zoom", variable=self.scroll_mode,
                       value="zoom", command=self._on_scroll_mode_change).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Radiobutton(control_frame, text="Pan", variable=self.scroll_mode,
                       value="pan", command=self._on_scroll_mode_change).pack(side=tk.LEFT, padx=(0, 5))

        # Step size selector (for pan mode)
        ttk.Label(control_frame, text="Step:").pack(side=tk.LEFT, padx=(10, 5))
        step_combo = ttk.Combobox(control_frame, textvariable=self.step_size,
                                  values=["10 Hz", "100 Hz", "500 Hz", "1 kHz", "10 kHz"],
                                  state='readonly', width=8)
        step_combo.pack(side=tk.LEFT, padx=(0, 5))
        step_combo.bind('<<ComboboxSelected>>', lambda e: self._on_step_size_changed())

        # Center tune checkbox
        ttk.Checkbutton(control_frame, text="Center Tune",
                       variable=self.center_tune,
                       command=self._on_center_tune_changed).pack(side=tk.LEFT, padx=(10, 5))
        
        # Instance list (left side)
        list_frame = ttk.LabelFrame(main_frame, text="Instances", padding="10")
        list_frame.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        
        # Scrollable instance list
        list_canvas = tk.Canvas(list_frame, height=100)
        list_scrollbar = ttk.Scrollbar(list_frame, orient="vertical", command=list_canvas.yview)
        self.instance_list_frame = ttk.Frame(list_canvas)
        
        list_canvas.create_window((0, 0), window=self.instance_list_frame, anchor="nw")
        list_canvas.configure(yscrollcommand=list_scrollbar.set)
        
        list_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        list_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # Update scroll region when frame changes
        self.instance_list_frame.bind("<Configure>",
                                     lambda e: list_canvas.configure(scrollregion=list_canvas.bbox("all")))

        # Modes section (between instance list and spectrum displays)
        modes_frame = ttk.LabelFrame(main_frame, text="Modes", padding="10")
        modes_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(0, 10))

        # Frequency input
        ttk.Label(modes_frame, text="Frequency:").pack(side=tk.LEFT, padx=(0, 5))
        freq_entry = ttk.Entry(modes_frame, textvariable=self.frequency_input, width=12)
        freq_entry.pack(side=tk.LEFT, padx=(0, 5))
        freq_entry.bind('<Return>', lambda e: self._apply_frequency())

        # Unit selector
        unit_combo = ttk.Combobox(modes_frame, textvariable=self.frequency_unit,
                                  values=["Hz", "kHz", "MHz"], state='readonly', width=6)
        unit_combo.pack(side=tk.LEFT, padx=(0, 5))
        unit_combo.bind('<<ComboboxSelected>>', lambda e: self._on_frequency_unit_changed())

        # Apply button
        ttk.Button(modes_frame, text="Apply", width=8,
                  command=self._apply_frequency).pack(side=tk.LEFT, padx=(0, 20))

        # Mode selection
        ttk.Label(modes_frame, text="Mode:").pack(side=tk.LEFT, padx=(0, 5))
        modes = ["USB", "LSB", "CW", "AM", "FM"]
        mode_combo = ttk.Combobox(modes_frame, textvariable=self.current_mode,
                                  values=modes, state="readonly", width=8)
        mode_combo.pack(side=tk.LEFT, padx=(0, 20))
        mode_combo.bind('<<ComboboxSelected>>', self._on_mode_change)

        # Bandwidth control
        ttk.Label(modes_frame, text="Bandwidth:").pack(side=tk.LEFT, padx=(0, 5))
        self.bandwidth_label = ttk.Label(modes_frame, text="2.7 kHz", width=10)
        self.bandwidth_label.pack(side=tk.LEFT, padx=(0, 5))

        bandwidth_slider = ttk.Scale(modes_frame, from_=100, to=10000,
                                    variable=self.current_bandwidth,
                                    orient=tk.HORIZONTAL, length=300,
                                    command=self._on_bandwidth_change)
        bandwidth_slider.pack(side=tk.LEFT, padx=(0, 10))

        # Preset bandwidth buttons
        ttk.Button(modes_frame, text="Narrow (500Hz)", width=15,
                  command=lambda: self._set_bandwidth(500)).pack(side=tk.LEFT, padx=2)
        ttk.Button(modes_frame, text="SSB (2.7kHz)", width=15,
                  command=lambda: self._set_bandwidth(2700)).pack(side=tk.LEFT, padx=2)
        ttk.Button(modes_frame, text="Wide (6kHz)", width=15,
                  command=lambda: self._set_bandwidth(6000)).pack(side=tk.LEFT, padx=2)

        # Spectrum display area (bottom)
        spectrum_frame = ttk.LabelFrame(main_frame, text="Spectrum Displays", padding="10")
        spectrum_frame.grid(row=3, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # Scrollable spectrum container
        spectrum_canvas = tk.Canvas(spectrum_frame)
        spectrum_scrollbar = ttk.Scrollbar(spectrum_frame, orient="vertical", 
                                          command=spectrum_canvas.yview)
        self.spectrum_container = ttk.Frame(spectrum_canvas)
        
        spectrum_canvas.create_window((0, 0), window=self.spectrum_container, anchor="nw")
        spectrum_canvas.configure(yscrollcommand=spectrum_scrollbar.set)
        
        spectrum_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        spectrum_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # Update scroll region when frame changes
        self.spectrum_container.bind("<Configure>", 
                                    lambda e: spectrum_canvas.configure(scrollregion=spectrum_canvas.bbox("all")))
        
        # Configure weights for resizing
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(1, weight=0)  # Instance list fixed height
        main_frame.rowconfigure(2, weight=0)  # Modes section fixed height
        main_frame.rowconfigure(3, weight=1)  # Spectrum area expands
    
    def add_instance(self):
        """Add a new instance manually."""
        if not self.instance_manager.can_add_instance():
            messagebox.showwarning("Limit Reached", 
                                  f"Maximum {self.MAX_INSTANCES} instances allowed")
            return
        
        def on_ok(instance: SpectrumInstance):
            self.instance_manager.add_instance(instance)
            self.create_instance_ui(instance)
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
        
        def on_select(host, port, tls, name, callsign=None):
            """Callback when user selects a public instance."""
            instance = SpectrumInstance(len(self.instance_manager.instances))
            instance.name = name
            instance.callsign = callsign if callsign else ""
            instance.host = host
            instance.port = port
            instance.tls = tls
            instance.frequency = 14100000  # Default frequency
            
            self.instance_manager.add_instance(instance)
            self.create_instance_ui(instance)
            self.save_config()
        
        create_public_instances_window(self.root, on_select)
    
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
        enabled_check.pack(side=tk.LEFT, padx=5)
        
        # Instance info
        protocol = "https" if instance.tls else "http"
        info_text = f"{instance.name} - {protocol}://{instance.host}:{instance.port}"
        info_label = ttk.Label(row_frame, text=info_text, width=60)
        info_label.pack(side=tk.LEFT, padx=5)
        
        # Status - set initial value based on instance state
        initial_status = "Enabled" if instance.enabled else "Disabled"
        status_var = tk.StringVar(value=initial_status)
        instance.status_var = status_var
        status_label = ttk.Label(row_frame, textvariable=status_var, width=15)
        status_label.pack(side=tk.LEFT, padx=5)
        
        # Connect/Disconnect button
        connect_btn = ttk.Button(row_frame, text="Connect", width=10,
                                command=lambda: self.toggle_connection(instance))
        connect_btn.pack(side=tk.LEFT, padx=5)
        
        # Edit button
        ttk.Button(row_frame, text="Edit", width=8,
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
        # Create spectrum display if not exists
        if instance.spectrum is None:
            spectrum_frame = ttk.LabelFrame(self.spectrum_container,
                                           text=instance.name, padding="5")
            spectrum_frame.pack(fill=tk.BOTH, expand=True, pady=5)
            
            # Create click-to-tune variable (always enabled for multi-instance)
            click_tune_var = tk.BooleanVar(value=True)

            # SpectrumDisplay creates and packs its own canvas internally
            instance.spectrum = SpectrumDisplay(spectrum_frame, width=1300, height=200,
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
            
            self.spectrum_displays[instance.instance_id] = instance.spectrum
        
        # Connect using manager
        if self.instance_manager.connect_instance(instance, instance.spectrum):
            instance.status_var.set("Connected")
            # Initialize bandwidth filter on newly connected spectrum
            self.root.after(500, self._update_all_bandwidths)
        else:
            instance.status_var.set("Error")
    
    def disconnect_instance(self, instance: SpectrumInstance):
        """Disconnect a single instance."""
        if self.instance_manager.disconnect_instance(instance):
            instance.status_var.set("Enabled" if instance.enabled else "Disabled")
    
    def connect_all_enabled(self):
        """Connect all enabled instances."""
        count = 0
        for instance in self.instance_manager.instances:
            if instance.enabled and not instance.connected:
                self.connect_instance(instance)
                if instance.connected:
                    count += 1
        
        if count > 0:
            messagebox.showinfo("Connected", f"Connected {count} instance(s)")
    
    def disconnect_all(self):
        """Disconnect all instances."""
        count = 0
        for instance in list(self.instance_manager.active_instances):
            self.disconnect_instance(instance)
            count += 1
        
        if count > 0:
            messagebox.showinfo("Disconnected", f"Disconnected {count} instance(s)")
    
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
        
        # Disconnect if connected
        if instance.connected:
            self.disconnect_instance(instance)
        
        # Remove from manager
        self.instance_manager.remove_instance(instance)
        
        # Remove UI
        if instance.instance_id in self.instance_frames:
            self.instance_frames[instance.instance_id].destroy()
            del self.instance_frames[instance.instance_id]
        
        # Remove spectrum display
        if instance.spectrum:
            instance.spectrum.master.destroy()
            if instance.instance_id in self.spectrum_displays:
                del self.spectrum_displays[instance.instance_id]
        
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
    
    def save_config(self):
        """Save configuration to file."""
        self.config_manager.save_config(
            self.instance_manager.instances,
            self.sync_enabled.get(),
            self.throttle_enabled.get()
        )
    
    def load_config(self):
        """Load configuration from file."""
        instances, settings = self.config_manager.load_config(self.MAX_INSTANCES)

        # Load synchronization settings
        self.sync_enabled.set(settings.get('sync_enabled', True))
        self.throttle_enabled.set(settings.get('throttle_enabled', True))

        for instance in instances:
            self.instance_manager.add_instance(instance)
            self.create_instance_ui(instance)
    
    def on_closing(self):
        """Handle window close event."""
        # Disconnect all instances
        self.disconnect_all()
        
        # Save configuration
        self.save_config()
        
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
        
        # Wrap _draw_spectrum to throttle based on server-reported rates
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
    
    def _on_frequency_change(self, frequency: float, source_spectrum: SpectrumDisplay):
        """Handle frequency change from click-to-tune.
        
        Args:
            frequency: New frequency in Hz
            source_spectrum: The spectrum display that initiated the change
        """
        if not self.sync_enabled.get() or self._syncing:
            return

        self._syncing = True

        # Update frequency for all connected instances using update_center_frequency
        # which respects the center_tune setting
        for instance in self.instance_manager.active_instances:
            if instance.spectrum and instance.spectrum.connected:
                instance.spectrum.update_center_frequency(frequency)

        self._syncing = False
        print(f"Synchronized frequency to {frequency/1e6:.6f} MHz across all instances")
    
    def _on_frequency_step(self, direction: int, source_spectrum: SpectrumDisplay):
        """Handle frequency step from mouse wheel in pan mode.
        
        Args:
            direction: +1 for up, -1 for down
            source_spectrum: The spectrum display that initiated the step
        """
        # Don't block if syncing is in progress
        if self._syncing:
            return
        
        self._syncing = True

        # Get step size from dropdown
        step_size = self._get_step_size_hz()
        frequency_change = direction * step_size
        
        # Update frequency for all connected instances (or just source if sync disabled)
        if self.sync_enabled.get():
            # Sync to all instances
            for instance in self.instance_manager.active_instances:
                if instance.spectrum and instance.spectrum.connected:
                    new_freq = instance.spectrum.tuned_freq + frequency_change
                    # Constrain to valid range
                    new_freq = max(100000, min(30000000, new_freq))
                    instance.spectrum.update_center_frequency(new_freq)
        else:
            # Only update the source spectrum
            if source_spectrum and source_spectrum.connected:
                new_freq = source_spectrum.tuned_freq + frequency_change
                # Constrain to valid range
                new_freq = max(100000, min(30000000, new_freq))
                source_spectrum.update_center_frequency(new_freq)
        
        self._syncing = False
    
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
            "CW": 500,
            "AM": 6000,
            "FM": 10000
        }

        if mode in mode_bandwidths:
            self._set_bandwidth(mode_bandwidths[mode])

    def _on_bandwidth_change(self, value):
        """Handle bandwidth slider change."""
        bandwidth = int(float(value))
        self.current_bandwidth.set(bandwidth)
        self.bandwidth_label.config(text=f"{bandwidth/1000:.1f} kHz")
        self._update_all_bandwidths()

    def _set_bandwidth(self, bandwidth: int):
        """Set bandwidth to a specific value."""
        self.current_bandwidth.set(bandwidth)
        self.bandwidth_label.config(text=f"{bandwidth/1000:.1f} kHz")
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

    def _apply_frequency(self):
        """Apply the frequency from the input field to all connected instances."""
        try:
            freq_hz = self._get_frequency_hz()

            # Constrain to valid range (100 kHz - 30 MHz)
            freq_hz = max(100000, min(30000000, freq_hz))

            # Update all connected instances
            for instance in self.instance_manager.active_instances:
                if instance.spectrum and instance.spectrum.connected:
                    instance.spectrum.update_center_frequency(freq_hz)

            print(f"Applied frequency: {freq_hz/1e6:.6f} MHz to all instances")
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
        elif mode == "CW":
            # CW: centered around tuned frequency
            low = -bandwidth // 2
            high = bandwidth // 2
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
        instance_names = ["None"] + [inst.name for inst in self.instance_manager.instances]

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

        ttk.Label(compare_frame, text="(A - B, 500ms avg)", font=('TkDefaultFont', 9, 'italic')).pack(side=tk.LEFT, padx=(10, 0))

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
            frame = ttk.LabelFrame(scrollable_frame, text=instance.name, padding="5")
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

            # Store all labels for this instance
            self.signal_level_labels[instance.instance_id] = {
                'hover_level': hover_level_label,
                'bw_peak': bw_peak_label,
                'bw_floor': bw_floor_label,
                'bw_snr': bw_snr_label,
                'diff_peak': diff_peak_label,
                'diff_floor': diff_floor_label,
                'diff_snr': diff_snr_label
            }

        # Handle window close
        self.signal_levels_window.protocol("WM_DELETE_WINDOW", self._on_signal_levels_close)

    def _on_signal_levels_close(self):
        """Handle signal levels window close."""
        self.signal_levels_window.destroy()
        self.signal_levels_window = None
        self.signal_level_labels = {}

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
            if instance.get_display_name() == instance_a_name:
                instance_a_id = instance.instance_id
            if instance.get_display_name() == instance_b_name:
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
        
        # Require at least 3 samples before displaying (ensures we have some averaging)
        if len(smoothed_history) < 3:
            # Not enough data yet
            for labels in self.signal_level_labels.values():
                labels['diff_peak'].config(text="---", foreground='black')
                labels['diff_floor'].config(text="---", foreground='black')
                labels['diff_snr'].config(text="---", foreground='black')
            return
        
        # Average the differences over the window
        diff_peak = sum(entry[1] for entry in smoothed_history) / len(smoothed_history)
        diff_floor = sum(entry[2] for entry in smoothed_history) / len(smoothed_history)
        diff_snr = sum(entry[3] for entry in smoothed_history) / len(smoothed_history)
        
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