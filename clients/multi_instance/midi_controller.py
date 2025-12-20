#!/usr/bin/env python3
"""
MIDI Controller Integration for Multi-Instance Spectrum Client
Allows mapping MIDI controls to radio functions across multiple instances.
"""

import tkinter as tk
from tkinter import ttk, messagebox
from typing import Optional, Dict, Any
import json
import os
import platform

try:
    import rtmidi
    MIDI_AVAILABLE = True
except ImportError:
    MIDI_AVAILABLE = False


class MIDIController:
    """MIDI controller for multi-instance spectrum GUI."""

    def __init__(self, parent_gui):
        """Initialize MIDI controller.

        Args:
            parent_gui: Parent MultiSpectrumGUI instance
        """
        self.parent_gui = parent_gui
        self.window = None
        self.learn_frame = None
        self.midi_in = None
        self.running = False
        self.learning = False
        self.learn_target = None

        # MIDI mappings: {(msg_type, channel, data1): (function_name, params)}
        self.mappings: Dict[tuple, tuple] = {}

        # Throttling: track last execution time and pending timers for each mapping
        self.last_execution: Dict[tuple, float] = {}
        self.pending_timers: Dict[tuple, Any] = {}

        # Last used device name
        self.last_device_name = None

        # Track if mappings have been modified since last save
        self.mappings_modified = False
        self.saved_mappings_hash = None

        # Load saved mappings and device
        if platform.system() == 'Windows':
            config_dir = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'ubersdr')
            os.makedirs(config_dir, exist_ok=True)
            self.config_file = os.path.join(config_dir, 'midi_mappings_multi.json')
        else:
            self.config_file = os.path.expanduser("~/.ubersdr_midi_mappings_multi.json")
        self.load_mappings()
        self._update_saved_hash()
        
        # Auto-connect to saved device if available
        if self.last_device_name:
            self._auto_connect()

    def create_window(self, root):
        """Create MIDI configuration window."""
        self.window = tk.Toplevel(root)
        self.window.title("MIDI Controller Configuration")
        self.window.geometry("800x600")

        # Main container
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)

        # Device selection frame
        device_frame = ttk.LabelFrame(main_frame, text="MIDI Device", padding="10")
        device_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))

        ttk.Label(device_frame, text="Device:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))

        self.device_var = tk.StringVar(value="(none)")
        self.device_combo = ttk.Combobox(device_frame, textvariable=self.device_var,
                                        state='readonly', width=40)
        self.device_combo.grid(row=0, column=1, sticky=(tk.W, tk.E), padx=(0, 5))
        self.device_combo.bind('<<ComboboxSelected>>', self.on_device_selected)

        self.refresh_btn = ttk.Button(device_frame, text="↻", width=3,
                                      command=self.refresh_devices)
        self.refresh_btn.grid(row=0, column=2, sticky=tk.W, padx=(0, 5))

        self.status_label = ttk.Label(device_frame, text="Not connected", foreground='red')
        self.status_label.grid(row=0, column=3, sticky=tk.W)

        device_frame.columnconfigure(1, weight=1)

        # Mappings frame
        mappings_frame = ttk.LabelFrame(main_frame, text="MIDI Mappings", padding="10")
        mappings_frame.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))

        # Mappings list
        list_frame = ttk.Frame(mappings_frame)
        list_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        # Treeview for mappings
        columns = ('MIDI Control', 'Function', 'Instance', 'Parameters')
        self.mappings_tree = ttk.Treeview(list_frame, columns=columns, show='headings', height=15)

        self.mappings_tree.heading('MIDI Control', text='MIDI Control')
        self.mappings_tree.heading('Function', text='Function')
        self.mappings_tree.heading('Instance', text='Instance')
        self.mappings_tree.heading('Parameters', text='Parameters')

        self.mappings_tree.column('MIDI Control', width=150)
        self.mappings_tree.column('Function', width=200)
        self.mappings_tree.column('Instance', width=100)
        self.mappings_tree.column('Parameters', width=150)

        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.mappings_tree.yview)
        self.mappings_tree.configure(yscrollcommand=scrollbar.set)

        self.mappings_tree.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))

        list_frame.columnconfigure(0, weight=1)
        list_frame.rowconfigure(0, weight=1)

        # Buttons frame
        buttons_frame = ttk.Frame(mappings_frame)
        buttons_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(10, 0))

        self.learn_btn = ttk.Button(buttons_frame, text="Learn New",
                                    command=self.start_learn_mode)
        self.learn_btn.grid(row=0, column=0, padx=(0, 5))

        self.edit_btn = ttk.Button(buttons_frame, text="Edit Mapping",
                                   command=self.edit_mapping)
        self.edit_btn.grid(row=0, column=1, padx=(0, 5))

        self.delete_btn = ttk.Button(buttons_frame, text="Delete Mapping",
                                     command=self.delete_mapping)
        self.delete_btn.grid(row=0, column=2, padx=(0, 5))

        self.clear_btn = ttk.Button(buttons_frame, text="Clear All",
                                    command=self.clear_all_mappings)
        self.clear_btn.grid(row=0, column=3, padx=(0, 5))

        self.save_btn = ttk.Button(buttons_frame, text="Save Mappings",
                                   command=self.save_mappings)
        self.save_btn.grid(row=0, column=4, padx=(0, 5))
        
        self.export_btn = ttk.Button(buttons_frame, text="Export...",
                                     command=self.export_mappings)
        self.export_btn.grid(row=0, column=5, padx=(0, 5))
        
        self.import_btn = ttk.Button(buttons_frame, text="Import...",
                                     command=self.import_mappings)
        self.import_btn.grid(row=0, column=6)

        mappings_frame.columnconfigure(0, weight=1)
        mappings_frame.rowconfigure(0, weight=1)

        # Learn mode frame (initially hidden)
        self.learn_frame = ttk.LabelFrame(main_frame, text="Learn Mode", padding="10")
        self.learn_frame.grid(row=2, column=0, sticky=(tk.W, tk.E))
        self.learn_frame.grid_remove()

        ttk.Label(self.learn_frame, text="1. Select function to map:").grid(row=0, column=0, sticky=tk.W, pady=(0, 5))

        self.function_var = tk.StringVar()
        self.function_combo = ttk.Combobox(self.learn_frame, textvariable=self.function_var,
                                          state='readonly', width=40)
        self.function_combo['values'] = self.get_available_functions()
        self.function_combo.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 10))

        # Instance target selection
        ttk.Label(self.learn_frame, text="2. Select instance target:").grid(row=2, column=0, sticky=tk.W, pady=(0, 5))
        
        self.instance_target_var = tk.StringVar(value="Both")
        self.instance_target_combo = ttk.Combobox(self.learn_frame, textvariable=self.instance_target_var,
                                                  state='readonly', width=40)
        self.instance_target_combo['values'] = ["Both", "Instance A", "Instance B"]
        self.instance_target_combo.grid(row=3, column=0, sticky=(tk.W, tk.E), pady=(0, 10))

        # Map both press and release checkbox
        self.map_both_var = tk.BooleanVar(value=False)
        self.map_both_check = ttk.Checkbutton(
            self.learn_frame,
            text="Map both press and release (for momentary control)",
            variable=self.map_both_var
        )
        self.map_both_check.grid(row=4, column=0, sticky=tk.W, pady=(0, 10))

        ttk.Label(self.learn_frame, text="3. Press and release MIDI control:").grid(row=5, column=0, sticky=tk.W, pady=(0, 5))

        self.learn_status_label = ttk.Label(self.learn_frame, text="Waiting for MIDI input...",
                                           foreground='blue', font=('TkDefaultFont', 10, 'bold'))
        self.learn_status_label.grid(row=6, column=0, sticky=tk.W, pady=(0, 10))

        learn_buttons_frame = ttk.Frame(self.learn_frame)
        learn_buttons_frame.grid(row=7, column=0, sticky=tk.W)

        self.cancel_learn_btn = ttk.Button(learn_buttons_frame, text="Cancel",
                                          command=self.cancel_learn_mode)
        self.cancel_learn_btn.grid(row=0, column=0)

        self.learn_frame.columnconfigure(0, weight=1)

        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(1, weight=1)

        # Refresh devices on startup
        self.refresh_devices()

        # Set device dropdown to saved device and update status if already connected
        if self.last_device_name:
            try:
                ports = self.device_combo['values']
                if self.last_device_name in ports:
                    self.device_var.set(self.last_device_name)
            except:
                pass

        # Update status label based on current connection state
        if self.midi_in and self.running:
            self.status_label.config(text="Connected", foreground='green')
        else:
            self.status_label.config(text="Not connected", foreground='red')

        # Update mappings display
        self.update_mappings_display()

        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.on_close)

        return self.window

    def refresh_devices(self):
        """Refresh list of available MIDI devices."""
        if not MIDI_AVAILABLE:
            self.device_combo['values'] = ["(MIDI not available)"]
            self.device_var.set("(MIDI not available)")
            return

        try:
            midi_in = rtmidi.MidiIn()
            ports = midi_in.get_ports()
            del midi_in

            if not ports:
                self.device_combo['values'] = ["(no MIDI devices found)"]
                self.device_var.set("(no MIDI devices found)")
            else:
                self.device_combo['values'] = ports
                if self.device_var.get() not in ports:
                    self.device_var.set(ports[0])

        except Exception as e:
            messagebox.showerror("Error", f"Failed to enumerate MIDI devices: {e}")

    def on_device_selected(self, event=None):
        """Handle MIDI device selection."""
        device_name = self.device_var.get()
        if device_name in ["(none)", "(no MIDI devices found)", "(MIDI not available)"]:
            return

        try:
            # Close existing connection
            if self.midi_in:
                try:
                    self.running = False
                    self.midi_in.close_port()
                    del self.midi_in
                except:
                    pass
                self.midi_in = None

            # Open new connection
            self.midi_in = rtmidi.MidiIn()
            ports = self.midi_in.get_ports()

            if device_name in ports:
                port_index = ports.index(device_name)
                self.midi_in.open_port(port_index)
                self.midi_in.set_callback(self.on_midi_message)
                self.running = True
                self.last_device_name = device_name
                self.status_label.config(text="Connected", foreground='green')
                print(f"MIDI device connected: {device_name}")
            else:
                raise Exception(f"Device not found: {device_name}")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to connect to MIDI device: {e}")
            self.status_label.config(text="Connection failed", foreground='red')

    def on_midi_message(self, message, data=None):
        """Handle incoming MIDI message."""
        try:
            if not message or len(message[0]) < 2:
                return

            msg_bytes = message[0]
            status = msg_bytes[0]
            msg_type = status & 0xF0
            channel = status & 0x0F
            data1 = msg_bytes[1] if len(msg_bytes) > 1 else 0
            data2 = msg_bytes[2] if len(msg_bytes) > 2 else 0

            # Note Off is 0x80, or Note On (0x90) with velocity 0
            is_note_off = (msg_type == 0x80) or (msg_type == 0x90 and data2 == 0)
            is_note_on = (msg_type == 0x90 and data2 > 0)

            # Create mapping key
            key = (msg_type, channel, data1)

            # Check if learn frame exists and is visible (learn mode active)
            if self.learn_frame and self.learn_frame.winfo_exists() and self.learn_frame.winfo_ismapped():
                if self.function_var.get():
                    map_both = self.map_both_var.get()

                    if map_both:
                        if is_note_on:
                            self.learn_press_key = key
                            if self.window and self.window.winfo_exists():
                                self.window.after(0, lambda: self.learn_status_label.config(
                                    text="Press captured! Now release the button...", foreground='orange'))
                        elif is_note_off and hasattr(self, 'learn_press_key'):
                            press_key = self.learn_press_key
                            release_key = key
                            if self.window and self.window.winfo_exists():
                                self.window.after(0, lambda: self.complete_learn_both(press_key, release_key, msg_type, channel, data1))
                            delattr(self, 'learn_press_key')
                    else:
                        if is_note_off:
                            return

                        self.learning = True
                        if self.window and self.window.winfo_exists():
                            self.window.after(0, lambda: self.complete_learn(key, msg_type, channel, data1))
                else:
                    if self.window and self.window.winfo_exists():
                        self.window.after(0, lambda: self.learn_status_label.config(
                            text="Please select a function first!", foreground='red'))
            elif key in self.mappings:
                function_name, params = self.mappings[key]

                # Check if throttling is configured
                throttle_ms = params.get('throttle_ms', 0) if isinstance(params, dict) else 0
                mode = params.get('mode', 'debounce') if isinstance(params, dict) else 'debounce'

                if throttle_ms > 0 and mode == 'rate_limit':
                    import time
                    current_time = time.time()
                    last_time = self.last_execution.get(key, 0)
                    time_since_last = (current_time - last_time) * 1000

                    if time_since_last >= throttle_ms:
                        self.last_execution[key] = current_time
                        if self.window and self.window.winfo_exists():
                            self.window.after(0, lambda: self.execute_function(function_name, params, data2))
                        else:
                            self.execute_function(function_name, params, data2)

                elif throttle_ms > 0 and mode == 'debounce':
                    if self.window and self.window.winfo_exists():
                        self.window.after(0, lambda: self.execute_throttled(key, function_name, params, data2, throttle_ms, mode))
                    else:
                        self.execute_throttled(key, function_name, params, data2, throttle_ms, mode)
                else:
                    if self.window and self.window.winfo_exists():
                        self.window.after(0, lambda: self.execute_function(function_name, params, data2))
                    else:
                        self.execute_function(function_name, params, data2)
        except Exception as e:
            print(f"MIDI message handling error: {e}")

    def start_learn_mode(self):
        """Start learn mode for mapping a new control."""
        if not self.midi_in or not self.running:
            messagebox.showwarning("Warning", "Please connect to a MIDI device first")
            return

        self.learn_frame.grid()
        self.learn_status_label.config(text="Select a function above, then move/press a MIDI control", foreground='blue')
        self.learn_btn.config(state='disabled')
        self.learning = False

    def complete_learn(self, key, msg_type, channel, data1):
        """Complete learn mode with captured MIDI control."""
        function_name = self.function_var.get()
        instance_target = self.instance_target_var.get()

        # Default parameters - add throttling for encoder and slider functions
        if function_name.startswith("Frequency: Encoder"):
            params = {
                'throttle_ms': 100,
                'mode': 'rate_limit',
                'instance_target': instance_target
            }
        elif function_name == "Bandwidth":
            # Bandwidth slider needs throttling to prevent overwhelming the system
            params = {
                'throttle_ms': 100,
                'mode': 'rate_limit',
                'instance_target': instance_target
            }
        elif function_name == "Zoom":
            # Zoom slider needs throttling to prevent overwhelming the system
            params = {
                'throttle_ms': 100,
                'mode': 'rate_limit',
                'instance_target': instance_target
            }
        else:
            params = {
                'instance_target': instance_target
            }

        self.mappings[key] = (function_name, params)
        self.mappings_modified = True

        self.update_mappings_display()

        control_name = self.format_midi_control(msg_type, channel, data1)
        self.learn_status_label.config(text=f"Mapped: {control_name}", foreground='green')

        self.window.after(1000, self.cancel_learn_mode)

        print(f"MIDI mapping created: {control_name} → {function_name}")

    def complete_learn_both(self, press_key, release_key, msg_type, channel, data1):
        """Complete learn mode with both press and release captured."""
        function_name = self.function_var.get()
        instance_target = self.instance_target_var.get()

        if function_name.startswith("Frequency: Encoder"):
            params = {
                'throttle_ms': 100,
                'mode': 'rate_limit',
                'instance_target': instance_target
            }
        elif function_name == "Bandwidth":
            # Bandwidth slider needs throttling to prevent overwhelming the system
            params = {
                'throttle_ms': 100,
                'mode': 'rate_limit',
                'instance_target': instance_target
            }
        elif function_name == "Zoom":
            # Zoom slider needs throttling to prevent overwhelming the system
            params = {
                'throttle_ms': 100,
                'mode': 'rate_limit',
                'instance_target': instance_target
            }
        else:
            params = {
                'instance_target': instance_target
            }

        self.mappings[press_key] = (function_name, params.copy())
        self.mappings[release_key] = (function_name, params.copy())
        self.mappings_modified = True

        self.update_mappings_display()

        press_name = self.format_midi_control(press_key[0], press_key[1], press_key[2])
        release_name = self.format_midi_control(release_key[0], release_key[1], release_key[2])
        self.learn_status_label.config(
            text=f"Mapped both: {press_name} and {release_name}",
            foreground='green'
        )

        self.window.after(1500, self.cancel_learn_mode)

        print(f"MIDI mappings created: {press_name} and {release_name} → {function_name}")

    def cancel_learn_mode(self):
        """Cancel learn mode."""
        self.learning = False
        self.learn_frame.grid_remove()
        self.learn_btn.config(state='normal')
        self.function_var.set('')
        self.instance_target_var.set('Both')
        self.map_both_var.set(False)
        if hasattr(self, 'learn_press_key'):
            delattr(self, 'learn_press_key')

    def format_midi_control(self, msg_type, channel, data1):
        """Format MIDI control for display."""
        if msg_type == 0x90:
            return f"Note {data1} (Ch {channel + 1})"
        elif msg_type == 0x80:
            return f"Note Off {data1} (Ch {channel + 1})"
        elif msg_type == 0xB0:
            return f"CC {data1} (Ch {channel + 1})"
        elif msg_type == 0xE0:
            return f"Pitch Bend (Ch {channel + 1})"
        else:
            return f"Type {msg_type:02X} Data {data1} (Ch {channel + 1})"

    def get_available_functions(self):
        """Get list of available functions to map."""
        return [
            "Frequency: Step Up",
            "Frequency: Step Down",
            "Frequency: Encoder (10 Hz)",
            "Frequency: Encoder (100 Hz)",
            "Frequency: Encoder (500 Hz)",
            "Frequency: Encoder (1 kHz)",
            "Frequency: Encoder (10 kHz)",
            "Mode: USB",
            "Mode: LSB",
            "Mode: AM",
            "Mode: FM",
            "Mode: CW",
            "Mode: Next",
            "Mode: Previous",
            "Band: 160m",
            "Band: 80m",
            "Band: 60m",
            "Band: 40m",
            "Band: 30m",
            "Band: 20m",
            "Band: 17m",
            "Band: 15m",
            "Band: 12m",
            "Band: 10m",
            "Bandwidth",
            "Bandwidth: Increase",
            "Bandwidth: Decrease",
            "Zoom",
            "Zoom: In",
            "Zoom: Out",
            "Step Size: 10 Hz",
            "Step Size: 100 Hz",
            "Step Size: 500 Hz",
            "Step Size: 1 kHz",
            "Step Size: 10 kHz",
            "Audio Left: Volume",
            "Audio Left: Mute Toggle",
            "Audio Left: Mono Toggle",
            "Audio Right: Volume",
            "Audio Right: Mute Toggle",
            "Audio Right: Mono Toggle",
            "Audio Master: Volume",
            "Copy Settings: A → B",
            "Copy Settings: B → A",
            "Connect Toggle",
            "Lock Toggle",
            "Sync: Toggle",
            "Throttle: Toggle",
            "Connect All",
            "Disconnect All",
        ]

    def execute_throttled(self, key, function_name, params, value, throttle_ms, mode):
        """Execute function with throttling."""
        import time

        current_time = time.time()

        if mode == 'debounce':
            if key in self.pending_timers:
                try:
                    if self.window and self.window.winfo_exists():
                        self.window.after_cancel(self.pending_timers[key])
                except:
                    pass
                del self.pending_timers[key]

            if self.window and self.window.winfo_exists():
                timer_id = self.window.after(throttle_ms,
                    lambda: self._execute_debounced(key, function_name, params, value))
                self.pending_timers[key] = timer_id

        elif mode == 'rate_limit':
            last_time = self.last_execution.get(key, 0)
            time_since_last = (current_time - last_time) * 1000

            if time_since_last >= throttle_ms:
                self.execute_function(function_name, params, value)
                self.last_execution[key] = current_time

    def _execute_debounced(self, key, function_name, params, value):
        """Internal helper for debounced execution."""
        if key in self.pending_timers:
            del self.pending_timers[key]

        self.execute_function(function_name, params, value)

        import time
        self.last_execution[key] = time.time()

    def execute_function(self, function_name, params, value):
        """Execute mapped function."""
        if not self.parent_gui:
            return

        gui = self.parent_gui
        
        # Get instance target from params (default to "Both" for backward compatibility)
        instance_target = params.get('instance_target', 'Both') if isinstance(params, dict) else 'Both'
        
        # Determine which instances to affect
        affect_instance_a = instance_target in ['Both', 'Instance A']
        affect_instance_b = instance_target in ['Both', 'Instance B']

        try:
            # Get target instances based on instance_target parameter
            target_instances = []
            if affect_instance_a:
                for inst in gui.instance_manager.instances:
                    if inst.id_label == 'A':
                        target_instances.append(inst)
                        break
            if affect_instance_b:
                for inst in gui.instance_manager.instances:
                    if inst.id_label == 'B':
                        target_instances.append(inst)
                        break

            # If no instances found, do nothing
            if not target_instances:
                return
            
            # For Lock Toggle, don't filter locked instances (we need to toggle them)
            # For all other functions, filter out locked instances
            if function_name != "Lock Toggle":
                target_instances = [inst for inst in target_instances if not (hasattr(inst, 'locked') and inst.locked)]
                
                # If all instances are locked, do nothing
                if not target_instances:
                    return
            
            # Frequency controls
            if function_name == "Frequency: Step Up":
                try:
                    step_hz = gui._get_step_size_hz()
                    for instance in target_instances:
                        new_freq = instance.frequency + step_hz
                        # Use the GUI's frequency change handler which updates both spectrum and radio
                        if instance.spectrum:
                            gui._on_frequency_change(new_freq, instance.spectrum)
                except:
                    pass

            elif function_name == "Frequency: Step Down":
                try:
                    step_hz = gui._get_step_size_hz()
                    for instance in target_instances:
                        new_freq = instance.frequency - step_hz
                        # Use the GUI's frequency change handler which updates both spectrum and radio
                        if instance.spectrum:
                            gui._on_frequency_change(new_freq, instance.spectrum)
                except:
                    pass

            elif function_name.startswith("Frequency: Encoder"):
                step_map = {
                    "Frequency: Encoder (10 Hz)": 10,
                    "Frequency: Encoder (100 Hz)": 100,
                    "Frequency: Encoder (500 Hz)": 500,
                    "Frequency: Encoder (1 kHz)": 1000,
                    "Frequency: Encoder (10 kHz)": 10000,
                }
                step_hz = step_map.get(function_name, 1000)

                try:
                    for instance in target_instances:
                        if value >= 64:
                            new_freq = instance.frequency - step_hz
                        else:
                            new_freq = instance.frequency + step_hz

                        # Use the GUI's frequency change handler which updates both spectrum and radio
                        if instance.spectrum:
                            gui._on_frequency_change(new_freq, instance.spectrum)
                except:
                    pass

            # Mode controls
            elif function_name == "Mode: USB":
                for instance in target_instances:
                    if hasattr(instance, 'instance_window') and instance.instance_window:
                        instance.instance_window.mode_var.set('USB')
                        gui._on_instance_mode_change(instance, instance.instance_window.mode_var)
            elif function_name == "Mode: LSB":
                for instance in target_instances:
                    if hasattr(instance, 'instance_window') and instance.instance_window:
                        instance.instance_window.mode_var.set('LSB')
                        gui._on_instance_mode_change(instance, instance.instance_window.mode_var)
            elif function_name == "Mode: AM":
                for instance in target_instances:
                    if hasattr(instance, 'instance_window') and instance.instance_window:
                        instance.instance_window.mode_var.set('AM')
                        gui._on_instance_mode_change(instance, instance.instance_window.mode_var)
            elif function_name == "Mode: FM":
                for instance in target_instances:
                    if hasattr(instance, 'instance_window') and instance.instance_window:
                        instance.instance_window.mode_var.set('FM')
                        gui._on_instance_mode_change(instance, instance.instance_window.mode_var)
            elif function_name == "Mode: CW":
                for instance in target_instances:
                    if hasattr(instance, 'instance_window') and instance.instance_window:
                        instance.instance_window.mode_var.set('CWU')
                        gui._on_instance_mode_change(instance, instance.instance_window.mode_var)
            elif function_name == "Mode: Next":
                modes = ['USB', 'LSB', 'CWU', 'CWL', 'AM', 'FM']
                for instance in target_instances:
                    if hasattr(instance, 'instance_window') and instance.instance_window:
                        try:
                            current_index = modes.index(instance.mode)
                            next_index = (current_index + 1) % len(modes)
                            instance.instance_window.mode_var.set(modes[next_index])
                            gui._on_instance_mode_change(instance, instance.instance_window.mode_var)
                        except:
                            instance.instance_window.mode_var.set('USB')
                            gui._on_instance_mode_change(instance, instance.instance_window.mode_var)
            elif function_name == "Mode: Previous":
                modes = ['USB', 'LSB', 'CWU', 'CWL', 'AM', 'FM']
                for instance in target_instances:
                    if hasattr(instance, 'instance_window') and instance.instance_window:
                        try:
                            current_index = modes.index(instance.mode)
                            prev_index = (current_index - 1) % len(modes)
                            instance.instance_window.mode_var.set(modes[prev_index])
                            gui._on_instance_mode_change(instance, instance.instance_window.mode_var)
                        except:
                            instance.instance_window.mode_var.set('USB')
                            gui._on_instance_mode_change(instance, instance.instance_window.mode_var)

            # Band controls
            elif function_name.startswith("Band: "):
                band_freqs = {
                    "Band: 160m": 1900000,
                    "Band: 80m": 3573000,
                    "Band: 60m": 5357000,
                    "Band: 40m": 7074000,
                    "Band: 30m": 10136000,
                    "Band: 20m": 14074000,
                    "Band: 17m": 18100000,
                    "Band: 15m": 21074000,
                    "Band: 12m": 24915000,
                    "Band: 10m": 28074000,
                }
                if function_name in band_freqs:
                    freq_hz = band_freqs[function_name]
                    for instance in target_instances:
                        # Use the GUI's frequency change handler which updates both spectrum and radio
                        if instance.spectrum:
                            gui._on_frequency_change(freq_hz, instance.spectrum)

            # Bandwidth control (single slider, not high/low)
            elif function_name == "Bandwidth":
                # Map MIDI value (0-127) to bandwidth range (100-10000 Hz)
                bandwidth = int(100 + (value / 127) * 9900)
                for instance in target_instances:
                    if hasattr(instance, 'instance_window') and instance.instance_window:
                        instance.instance_window.bandwidth_var.set(bandwidth)
                        gui._on_instance_bandwidth_change(
                            instance,
                            instance.instance_window.bandwidth_var,
                            instance.instance_window.bw_label
                        )
            
            # Bandwidth step controls (for buttons, 100 Hz steps)
            elif function_name == "Bandwidth: Increase" and value > 0:
                for instance in target_instances:
                    if hasattr(instance, 'instance_window') and instance.instance_window:
                        current_bw = instance.bandwidth
                        new_bw = min(10000, current_bw + 100)  # Max 10000 Hz
                        instance.instance_window.bandwidth_var.set(new_bw)
                        gui._on_instance_bandwidth_change(
                            instance,
                            instance.instance_window.bandwidth_var,
                            instance.instance_window.bw_label
                        )
            
            elif function_name == "Bandwidth: Decrease" and value > 0:
                for instance in target_instances:
                    if hasattr(instance, 'instance_window') and instance.instance_window:
                        current_bw = instance.bandwidth
                        new_bw = max(100, current_bw - 100)  # Min 100 Hz
                        instance.instance_window.bandwidth_var.set(new_bw)
                        gui._on_instance_bandwidth_change(
                            instance,
                            instance.instance_window.bandwidth_var,
                            instance.instance_window.bw_label
                        )
            
            # Zoom controls (spectrum display zoom)
            elif function_name == "Zoom":
                # Map MIDI value (0-127) to zoom level
                # Match the behavior of zoom_in/zoom_out which uses 2x steps
                # Lower values = zoomed out (wider bandwidth), higher values = zoomed in (narrower bandwidth)
                import asyncio
                import math
                
                for instance in target_instances:
                    if instance.spectrum and instance.spectrum.connected and instance.spectrum.event_loop:
                        # Get initial bandwidth (200 kHz default) and current bandwidth
                        initial_bw = instance.spectrum.initial_bin_bandwidth * instance.spectrum.bin_count if instance.spectrum.initial_bin_bandwidth > 0 else 200000
                        current_bw = instance.spectrum.total_bandwidth
                        
                        # Minimum zoom: 500 Hz (very zoomed in)
                        min_bw = 500
                        # Maximum zoom out: initial bandwidth (typically 200 kHz)
                        max_bw = initial_bw
                        
                        # Use logarithmic scale for natural zoom feel
                        # Invert so higher MIDI values = more zoom (narrower bandwidth)
                        log_min = math.log10(min_bw)
                        log_max = math.log10(max_bw)
                        # Map MIDI value inversely: 0 = max_bw, 127 = min_bw
                        log_target = log_max - (value / 127.0) * (log_max - log_min)
                        target_bw = 10 ** log_target
                        
                        # Get tuned frequency for zoom center
                        zoom_center = instance.spectrum.tuned_freq if instance.spectrum.tuned_freq != 0 else instance.spectrum.center_freq
                        
                        # Send zoom command
                        asyncio.run_coroutine_threadsafe(
                            instance.spectrum._send_zoom_command(zoom_center, target_bw),
                            instance.spectrum.event_loop
                        )
            
            elif function_name == "Zoom: In" and value > 0:
                # Zoom in by 20% (reduce bandwidth)
                import asyncio
                for instance in target_instances:
                    if instance.spectrum and instance.spectrum.connected and instance.spectrum.event_loop:
                        current_bw = instance.spectrum.total_bandwidth
                        new_bw = max(1000, current_bw * 0.8)  # Min 1 kHz
                        center_freq = instance.spectrum.center_freq
                        asyncio.run_coroutine_threadsafe(
                            instance.spectrum._send_zoom_command(center_freq, new_bw),
                            instance.spectrum.event_loop
                        )
            
            elif function_name == "Zoom: Out" and value > 0:
                # Zoom out by 25% (increase bandwidth)
                import asyncio
                for instance in target_instances:
                    if instance.spectrum and instance.spectrum.connected and instance.spectrum.event_loop:
                        current_bw = instance.spectrum.total_bandwidth
                        new_bw = min(100000, current_bw * 1.25)  # Max 100 kHz
                        center_freq = instance.spectrum.center_freq
                        asyncio.run_coroutine_threadsafe(
                            instance.spectrum._send_zoom_command(center_freq, new_bw),
                            instance.spectrum.event_loop
                        )

            # Step size controls (global, not per-instance)
            elif function_name.startswith("Step Size: "):
                step_map = {
                    "Step Size: 10 Hz": "10 Hz",
                    "Step Size: 100 Hz": "100 Hz",
                    "Step Size: 500 Hz": "500 Hz",
                    "Step Size: 1 kHz": "1 kHz",
                    "Step Size: 10 kHz": "10 kHz",
                }
                if function_name in step_map:
                    gui.step_size.set(step_map[function_name])
                    gui._on_step_size_changed()

            # Audio volume controls (use MIDI value directly)
            elif function_name == "Audio Left: Volume":
                # Map MIDI value (0-127) to volume range (0.0-1.0)
                volume = value / 127.0
                gui._on_left_volume_change(volume)
            
            elif function_name == "Audio Right: Volume":
                # Map MIDI value (0-127) to volume range (0.0-1.0)
                volume = value / 127.0
                gui._on_right_volume_change(volume)
            
            elif function_name == "Audio Master: Volume":
                # Master volume control - adjusts both channels proportionally
                # Map MIDI value (0-127) to target range (0.0-1.0)
                target_value = value / 127.0
                
                # Get current volumes
                current_left = gui.audio_left_volume.get()
                current_right = gui.audio_right_volume.get()
                
                # Calculate the change needed
                # We want to move both volumes toward the target proportionally
                # until one hits a limit (0.0 or 1.0)
                
                # Find which channel is furthest from the target
                left_distance = abs(target_value - current_left)
                right_distance = abs(target_value - current_right)
                
                # Calculate new volumes
                # Both channels move by the same absolute amount
                if target_value > max(current_left, current_right):
                    # Moving up - limited by whichever channel reaches 1.0 first
                    max_increase = min(1.0 - current_left, 1.0 - current_right)
                    change = min(target_value - max(current_left, current_right), max_increase)
                    new_left = min(1.0, current_left + change)
                    new_right = min(1.0, current_right + change)
                elif target_value < min(current_left, current_right):
                    # Moving down - limited by whichever channel reaches 0.0 first
                    max_decrease = min(current_left, current_right)
                    change = min(min(current_left, current_right) - target_value, max_decrease)
                    new_left = max(0.0, current_left - change)
                    new_right = max(0.0, current_right - change)
                else:
                    # Target is between the two channels - move both toward target
                    new_left = target_value
                    new_right = target_value
                
                # Apply new volumes
                gui._on_left_volume_change(new_left)
                gui._on_right_volume_change(new_right)
            
            # Audio toggle controls (trigger on button press, value > 0)
            elif value > 0:
                if function_name == "Audio Left: Mute Toggle":
                    gui.audio_left_mute.set(not gui.audio_left_mute.get())
                    gui._on_left_mute_change()
                elif function_name == "Audio Left: Mono Toggle":
                    gui.audio_left_mono.set(not gui.audio_left_mono.get())
                    gui._on_left_mono_change()
                elif function_name == "Audio Right: Mute Toggle":
                    gui.audio_right_mute.set(not gui.audio_right_mute.get())
                    gui._on_right_mute_change()
                elif function_name == "Audio Right: Mono Toggle":
                    gui.audio_right_mono.set(not gui.audio_right_mono.get())
                    gui._on_right_mono_change()
                # Copy settings between instances
                elif function_name == "Copy Settings: A → B":
                    gui._sync_a_to_b()
                elif function_name == "Copy Settings: B → A":
                    gui._sync_b_to_a()
                # Connect toggle for specific instance
                elif function_name == "Connect Toggle":
                    for instance in target_instances:
                        gui.toggle_connection(instance)
                # Lock toggle for specific instance
                elif function_name == "Lock Toggle":
                    for instance in target_instances:
                        # Toggle lock state
                        new_lock_state = not (hasattr(instance, 'locked') and instance.locked)
                        instance.locked = new_lock_state
                        
                        # Update UI if instance window exists
                        if hasattr(instance, 'instance_window') and instance.instance_window is not None:
                            instance.instance_window.locked_var.set(new_lock_state)
                            instance.instance_window._on_lock_changed()
                        
                        # Update spectrum if it exists
                        if instance.spectrum:
                            instance.spectrum.locked = new_lock_state
                        
                        print(f"MIDI: Toggled lock for {instance.get_id_display_name()} - {'locked' if new_lock_state else 'unlocked'}")
                # Other toggle controls
                elif function_name == "Sync: Toggle":
                    gui.sync_enabled.set(not gui.sync_enabled.get())
                elif function_name == "Throttle: Toggle":
                    gui.throttle_enabled.set(not gui.throttle_enabled.get())
                elif function_name == "Connect All":
                    gui.connect_all_enabled()
                elif function_name == "Disconnect All":
                    gui.disconnect_all()

        except Exception as e:
            print(f"Error executing MIDI function {function_name}: {e}")

    def update_mappings_display(self):
        """Update the mappings treeview."""
        for item in self.mappings_tree.get_children():
            self.mappings_tree.delete(item)

        for key, (function_name, params) in self.mappings.items():
            msg_type, channel, data1 = key
            control_name = self.format_midi_control(msg_type, channel, data1)

            # Extract instance target for dedicated column
            if isinstance(params, dict):
                instance_str = params.get('instance_target', 'Both')
                
                # Build parameters string (throttle settings only)
                parts = []
                if 'throttle_ms' in params:
                    parts.append(f"{params['throttle_ms']}ms")
                if 'mode' in params:
                    parts.append(params['mode'])
                params_str = ", ".join(parts) if parts else ""
            else:
                instance_str = "Both"
                params_str = ""

            self.mappings_tree.insert('', 'end', values=(control_name, function_name, instance_str, params_str))

    def edit_mapping(self):
        """Edit selected mapping parameters."""
        selection = self.mappings_tree.selection()
        if not selection:
            messagebox.showwarning("Warning", "Please select a mapping to edit")
            return

        # Get selected item
        item = selection[0]
        values = self.mappings_tree.item(item, 'values')
        control_name = values[0]
        function_name = values[1]

        # Find mapping key
        mapping_key = None
        for key in self.mappings.keys():
            msg_type, channel, data1 = key
            if self.format_midi_control(msg_type, channel, data1) == control_name:
                mapping_key = key
                break

        if not mapping_key:
            return

        # Get current parameters
        _, current_params = self.mappings[mapping_key]
        if not isinstance(current_params, dict):
            current_params = {}

        # Create edit dialog
        dialog = tk.Toplevel(self.window)
        dialog.title(f"Edit Mapping: {control_name}")
        dialog.geometry("400x350")
        dialog.transient(self.window)
        dialog.grab_set()

        # Main frame
        frame = ttk.Frame(dialog, padding="20")
        frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        # Function display
        ttk.Label(frame, text="Function:", font=('TkDefaultFont', 10, 'bold')).grid(
            row=0, column=0, sticky=tk.W, pady=(0, 5))
        ttk.Label(frame, text=function_name).grid(row=0, column=1, sticky=tk.W, pady=(0, 5))

        # Instance target selection
        ttk.Label(frame, text="Instance Target:", font=('TkDefaultFont', 10, 'bold')).grid(
            row=1, column=0, sticky=tk.W, pady=(10, 5))
        
        instance_target_var = tk.StringVar(value=current_params.get('instance_target', 'Both'))
        instance_target_combo = ttk.Combobox(frame, textvariable=instance_target_var,
                                             state='readonly', width=15)
        instance_target_combo['values'] = ['Both', 'Instance A', 'Instance B']
        instance_target_combo.grid(row=1, column=1, sticky=tk.W, pady=(10, 5))

        # Throttle enable
        ttk.Label(frame, text="Enable Throttling:", font=('TkDefaultFont', 10, 'bold')).grid(
            row=2, column=0, sticky=tk.W, pady=(10, 5))

        throttle_enabled_var = tk.BooleanVar(value=current_params.get('throttle_ms', 0) > 0)
        throttle_check = ttk.Checkbutton(frame, variable=throttle_enabled_var,
                                        command=lambda: self._toggle_throttle_fields(
                                            throttle_enabled_var.get(), throttle_entry, mode_combo))
        throttle_check.grid(row=2, column=1, sticky=tk.W, pady=(10, 5))

        # Throttle time
        ttk.Label(frame, text="Throttle Time (ms):").grid(row=3, column=0, sticky=tk.W, pady=(5, 5))
        throttle_var = tk.StringVar(value=str(current_params.get('throttle_ms', 100)))
        throttle_entry = ttk.Entry(frame, textvariable=throttle_var, width=10)
        throttle_entry.grid(row=3, column=1, sticky=tk.W, pady=(5, 5))

        # Throttle mode
        ttk.Label(frame, text="Throttle Mode:").grid(row=4, column=0, sticky=tk.W, pady=(5, 5))
        mode_var = tk.StringVar(value=current_params.get('mode', 'debounce'))
        mode_combo = ttk.Combobox(frame, textvariable=mode_var, state='readonly', width=15)
        mode_combo['values'] = ['debounce', 'rate_limit']
        mode_combo.grid(row=4, column=1, sticky=tk.W, pady=(5, 5))

        # Mode descriptions
        desc_frame = ttk.LabelFrame(frame, text="Mode Descriptions", padding="10")
        desc_frame.grid(row=5, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(10, 10))

        ttk.Label(desc_frame, text="• Debounce: Only last input within time window executes",
                 wraplength=350, justify=tk.LEFT).grid(row=0, column=0, sticky=tk.W)
        ttk.Label(desc_frame, text="• Rate Limit: Ignores inputs that come too quickly",
                 wraplength=350, justify=tk.LEFT).grid(row=1, column=0, sticky=tk.W)

        # Initial state
        self._toggle_throttle_fields(throttle_enabled_var.get(), throttle_entry, mode_combo)

        # Buttons
        button_frame = ttk.Frame(frame)
        button_frame.grid(row=6, column=0, columnspan=2, pady=(10, 0))

        def save_changes():
            try:
                # Always preserve instance_target
                new_params = {
                    'instance_target': instance_target_var.get()
                }
                
                if throttle_enabled_var.get():
                    throttle_ms = int(throttle_var.get())
                    if throttle_ms < 0:
                        raise ValueError("Throttle time must be positive")
                    new_params['throttle_ms'] = throttle_ms
                    new_params['mode'] = mode_var.get()

                # Update mapping
                self.mappings[mapping_key] = (function_name, new_params)
                self.mappings_modified = True
                self.update_mappings_display()
                dialog.destroy()
                print(f"MIDI mapping updated: {control_name}")

            except ValueError as e:
                messagebox.showerror("Error", f"Invalid throttle time: {e}")

        ttk.Button(button_frame, text="Save", command=save_changes).grid(row=0, column=0, padx=(0, 5))
        ttk.Button(button_frame, text="Cancel", command=dialog.destroy).grid(row=0, column=1)

        frame.columnconfigure(1, weight=1)

    def _toggle_throttle_fields(self, enabled, entry, combo):
        """Enable/disable throttle fields based on checkbox."""
        state = 'normal' if enabled else 'disabled'
        entry.config(state=state)
        combo.config(state='readonly' if enabled else 'disabled')

    def delete_mapping(self):
        """Delete selected mapping."""
        selection = self.mappings_tree.selection()
        if not selection:
            messagebox.showwarning("Warning", "Please select a mapping to delete")
            return

        # Get selected item
        item = selection[0]
        values = self.mappings_tree.item(item, 'values')
        control_name = values[0]

        # Find and remove mapping
        for key in list(self.mappings.keys()):
            msg_type, channel, data1 = key
            if self.format_midi_control(msg_type, channel, data1) == control_name:
                del self.mappings[key]
                self.mappings_modified = True
                break

        self.update_mappings_display()
        print(f"MIDI mapping deleted: {control_name}")

    def clear_all_mappings(self):
        """Clear all mappings."""
        if messagebox.askyesno("Confirm", "Delete all MIDI mappings?"):
            self.mappings.clear()
            self.mappings_modified = True
            self.update_mappings_display()
            print("All MIDI mappings cleared")

    def save_mappings(self):
        """Save mappings and device to file."""
        try:
            # Convert mappings to JSON-serializable format
            json_mappings = {}
            for key, value in self.mappings.items():
                key_str = f"{key[0]}:{key[1]}:{key[2]}"
                json_mappings[key_str] = value

            # Create config with mappings and device
            config = {
                'device': self.last_device_name,
                'mappings': json_mappings
            }

            with open(self.config_file, 'w') as f:
                json.dump(config, f, indent=2)

            self.mappings_modified = False
            self._update_saved_hash()
            messagebox.showinfo("Success", f"Mappings saved to {self.config_file}")
            print("MIDI mappings saved")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to save mappings: {e}")

    def load_mappings(self):
        """Load mappings and device from file."""
        if not os.path.exists(self.config_file):
            return

        try:
            with open(self.config_file, 'r') as f:
                data = json.load(f)

            # Handle both old format (just mappings) and new format (with device)
            if isinstance(data, dict) and 'mappings' in data:
                # New format with device
                self.last_device_name = data.get('device')
                json_mappings = data.get('mappings', {})
            else:
                # Old format - just mappings
                json_mappings = data
                self.last_device_name = None

            # Convert from JSON format back to tuple keys
            self.mappings.clear()
            for key_str, value in json_mappings.items():
                parts = key_str.split(':')
                key = (int(parts[0]), int(parts[1]), int(parts[2]))
                self.mappings[key] = tuple(value)

        except Exception as e:
            print(f"Failed to load MIDI mappings: {e}")

    def export_mappings(self):
        """Export mappings to a user-selected file."""
        from tkinter import filedialog

        # Ask user for export file location
        filename = filedialog.asksaveasfilename(
            parent=self.window,
            title="Export MIDI Mappings",
            defaultextension=".json",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")],
            initialfile="midi_mappings_export.json"
        )

        if not filename:
            return  # User cancelled

        try:
            # Convert mappings to JSON-serializable format
            json_mappings = {}
            for key, value in self.mappings.items():
                key_str = f"{key[0]}:{key[1]}:{key[2]}"
                json_mappings[key_str] = value

            # Create config with mappings and device
            config = {
                'device': self.last_device_name,
                'mappings': json_mappings
            }

            with open(filename, 'w') as f:
                json.dump(config, f, indent=2)

            messagebox.showinfo("Success", f"Mappings exported to:\n{filename}")
            print(f"MIDI mappings exported to {filename}")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to export mappings:\n{e}")

    def import_mappings(self):
        """Import mappings from a user-selected file."""
        from tkinter import filedialog

        # Ask user for import file location
        filename = filedialog.askopenfilename(
            parent=self.window,
            title="Import MIDI Mappings",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")]
        )

        if not filename:
            return  # User cancelled

        try:
            with open(filename, 'r') as f:
                data = json.load(f)

            # Handle both old format (just mappings) and new format (with device)
            if isinstance(data, dict) and 'mappings' in data:
                # New format with device
                imported_device = data.get('device')
                json_mappings = data.get('mappings', {})
            else:
                # Old format - just mappings
                imported_device = None
                json_mappings = data

            # Ask user if they want to replace or merge
            if len(self.mappings) > 0:
                response = messagebox.askyesnocancel(
                    "Import Mappings",
                    "You have existing mappings.\n\n"
                    "Yes = Replace all existing mappings\n"
                    "No = Merge with existing mappings\n"
                    "Cancel = Cancel import",
                    icon='question'
                )

                if response is None:  # Cancel
                    return
                elif response:  # Yes - replace
                    self.mappings.clear()

            # Convert from JSON format and add to mappings
            for key_str, value in json_mappings.items():
                parts = key_str.split(':')
                key = (int(parts[0]), int(parts[1]), int(parts[2]))
                self.mappings[key] = tuple(value)

            # Update device if imported
            if imported_device:
                self.last_device_name = imported_device

            # Mark as modified and update display
            self.mappings_modified = True
            self.update_mappings_display()

            messagebox.showinfo("Success",
                              f"Imported {len(json_mappings)} mapping(s) from:\n{filename}\n\n"
                              "Don't forget to save your mappings!")
            print(f"MIDI mappings imported from {filename}")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to import mappings:\n{e}")

    def _auto_connect(self):
        """Automatically connect to the last used MIDI device on startup."""
        if not MIDI_AVAILABLE or not self.last_device_name:
            return
        
        try:
            # Try to connect to the saved device
            midi_in = rtmidi.MidiIn()
            ports = midi_in.get_ports()
            
            if self.last_device_name in ports:
                port_index = ports.index(self.last_device_name)
                self.midi_in = midi_in
                self.midi_in.open_port(port_index)
                self.midi_in.set_callback(self.on_midi_message)
                self.running = True
                print(f"MIDI device auto-connected: {self.last_device_name}")
            else:
                # Device not found, clean up
                del midi_in
                print(f"MIDI device not found for auto-connect: {self.last_device_name}")
        except Exception as e:
            print(f"Failed to auto-connect MIDI device: {e}")

    def _update_saved_hash(self):
        """Update hash of saved mappings for change detection."""
        import hashlib
        mappings_str = json.dumps(sorted(self.mappings.items()), sort_keys=True)
        self.saved_mappings_hash = hashlib.md5(mappings_str.encode()).hexdigest()

    def _check_unsaved_changes(self):
        """Check if there are unsaved changes.

        Returns:
            bool: True if there are unsaved changes
        """
        if not self.mappings_modified:
            return False

        # Double-check by comparing hash
        import hashlib
        current_str = json.dumps(sorted(self.mappings.items()), sort_keys=True)
        current_hash = hashlib.md5(current_str.encode()).hexdigest()

        return current_hash != self.saved_mappings_hash

    def on_close(self):
        """Handle window close - keep MIDI active in background."""
        # Check for unsaved changes
        if self._check_unsaved_changes():
            response = messagebox.askyesnocancel(
                "Unsaved Changes",
                "You have unsaved MIDI mapping changes.\n\nDo you want to save them before closing?",
                icon='warning'
            )

            if response is None:  # Cancel
                return
            elif response:  # Yes - save
                self.save_mappings()

        # Hide window but keep MIDI connection active
        self.window.withdraw()
        print("MIDI window closed (controller still active)")

    def disconnect(self):
        """Disconnect MIDI and clean up (called when main GUI closes)."""
        # Stop MIDI input
        if self.midi_in:
            self.running = False
            self.midi_in.close_port()
            del self.midi_in
            self.midi_in = None

        # Destroy window if it exists
        if self.window:
            self.window.destroy()
            self.window = None


def create_midi_window(parent_gui):
    """Create MIDI controller configuration window.

    Args:
        parent_gui: Parent MultiSpectrumGUI instance

    Returns:
        MIDIController instance
    """
    controller = MIDIController(parent_gui)
    controller.create_window(parent_gui.root)
    return controller