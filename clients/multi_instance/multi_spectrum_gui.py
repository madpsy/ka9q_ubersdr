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
        self.throttle_enabled = tk.BooleanVar(value=False)  # Throttle to slowest by default off
        self._syncing = False  # Flag to prevent sync loops
        
        # Update rate tracking for throttling (using server-reported rates)
        self.update_times = {}  # instance_id -> list of recent update timestamps (for frame skipping)
        self.target_update_rate = None  # Slowest rate to throttle to (from server-reported rates)
        
        # Create UI
        self.create_widgets()
        
        # Load saved configuration
        self.load_config()
        
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
        
        # Synchronization control
        ttk.Separator(control_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, padx=10, fill=tk.Y)
        ttk.Checkbutton(control_frame, text="Synchronize Pan/Zoom",
                       variable=self.sync_enabled).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Checkbutton(control_frame, text="Throttle to Slowest",
                       variable=self.throttle_enabled).pack(side=tk.LEFT, padx=(0, 5))
        
        # Instance list (left side)
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
        
        # Spectrum display area (bottom)
        spectrum_frame = ttk.LabelFrame(main_frame, text="Spectrum Displays", padding="10")
        spectrum_frame.grid(row=2, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
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
        main_frame.rowconfigure(2, weight=1)  # Spectrum area expands
    
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
        
        def on_select(host, port, tls, name):
            """Callback when user selects a public instance."""
            instance = SpectrumInstance(len(self.instance_manager.instances))
            instance.name = name
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
        
        # Enable checkbox
        enabled_var = tk.BooleanVar(value=instance.enabled)
        enabled_check = ttk.Checkbutton(row_frame, variable=enabled_var,
                                       command=lambda: self.toggle_instance(instance, enabled_var.get()))
        enabled_check.pack(side=tk.LEFT, padx=5)
        
        # Instance info
        protocol = "https" if instance.tls else "http"
        info_text = f"{instance.name} - {protocol}://{instance.host}:{instance.port} @ {instance.frequency/1e6:.3f} MHz"
        info_label = ttk.Label(row_frame, text=info_text, width=60)
        info_label.pack(side=tk.LEFT, padx=5)
        
        # Status
        status_var = tk.StringVar(value="Disabled")
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
                                               click_tune_var=click_tune_var)
            
            # Set up frequency callback for click-to-tune synchronization
            instance.spectrum.set_frequency_callback(
                lambda freq, src=instance.spectrum: self._on_frequency_change(freq, src)
            )
            
            # Set up synchronization callbacks
            self._setup_sync_callbacks(instance.spectrum, instance.instance_id)
            
            # Initialize update tracking for this instance
            self.update_times[instance.instance_id] = []
            
            # Calculate target throttle rate from all connected instances
            self._update_target_rate()
            
            self.spectrum_displays[instance.instance_id] = instance.spectrum
        
        # Connect using manager
        if self.instance_manager.connect_instance(instance, instance.spectrum):
            instance.status_var.set("Connected")
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
        self.config_manager.save_instances(self.instance_manager.instances)
    
    def load_config(self):
        """Load configuration from file."""
        instances = self.config_manager.load_instances(self.MAX_INSTANCES)
        
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
        import asyncio
        
        if not self.sync_enabled.get() or self._syncing:
            return
        
        self._syncing = True
        
        # Update frequency for all connected instances
        for instance in self.instance_manager.active_instances:
            if instance.spectrum and instance.spectrum.connected:
                # Update tuned frequency
                instance.spectrum.tuned_freq = frequency
                
                # Send pan command to center on new frequency if connected
                if instance.spectrum.event_loop:
                    asyncio.run_coroutine_threadsafe(
                        instance.spectrum._send_pan_command(frequency),
                        instance.spectrum.event_loop
                    )
        
        self._syncing = False
        print(f"Synchronized frequency to {frequency/1e6:.6f} MHz across all instances")
    
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