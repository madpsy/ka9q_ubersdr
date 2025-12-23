#!/usr/bin/env python3
"""
MIDI Controller Integration for ka9q_ubersdr Python GUI
Allows mapping MIDI controls to radio functions.
"""

import tkinter as tk
from tkinter import ttk, messagebox
from typing import Optional, Callable, Dict, Any
import threading
import json
import os
import platform

try:
    import rtmidi
    MIDI_AVAILABLE = True
except ImportError:
    MIDI_AVAILABLE = False


class MIDIController:
    """MIDI controller for radio GUI."""

    def __init__(self, parent_gui):
        """Initialize MIDI controller.

        Args:
            parent_gui: Parent RadioGUI instance
        """
        self.parent_gui = parent_gui
        self.window = None
        self.learn_frame = None  # Initialize to None (created when window opens)
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

        # Load saved mappings and device (use platform-appropriate config directory)
        if platform.system() == 'Windows':
            # Use AppData on Windows
            config_dir = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'ubersdr')
            os.makedirs(config_dir, exist_ok=True)
            self.config_file = os.path.join(config_dir, 'midi_mappings.json')
        else:
            # Use home directory on Unix-like systems
            self.config_file = os.path.expanduser("~/.ubersdr_midi_mappings.json")
        self.load_mappings()
        self._update_saved_hash()

    def create_window(self, root):
        """Create MIDI configuration window."""
        self.window = tk.Toplevel(root)
        self.window.title("MIDI Controller Configuration")
        self.window.geometry("700x600")

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
        columns = ('MIDI Control', 'Function', 'Parameters')
        self.mappings_tree = ttk.Treeview(list_frame, columns=columns, show='headings', height=15)

        self.mappings_tree.heading('MIDI Control', text='MIDI Control')
        self.mappings_tree.heading('Function', text='Function')
        self.mappings_tree.heading('Parameters', text='Parameters')

        self.mappings_tree.column('MIDI Control', width=150)
        self.mappings_tree.column('Function', width=200)
        self.mappings_tree.column('Parameters', width=200)

        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.mappings_tree.yview)
        self.mappings_tree.configure(yscrollcommand=scrollbar.set)

        self.mappings_tree.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))

        list_frame.columnconfigure(0, weight=1)
        list_frame.rowconfigure(0, weight=1)

        # Buttons frame
        buttons_frame = ttk.Frame(mappings_frame)
        buttons_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(10, 0))

        self.learn_btn = ttk.Button(buttons_frame, text="Learn New Mapping",
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
        self.save_btn.grid(row=0, column=4)

        mappings_frame.columnconfigure(0, weight=1)
        mappings_frame.rowconfigure(0, weight=1)

        # Learn mode frame (initially hidden)
        self.learn_frame = ttk.LabelFrame(main_frame, text="Learn Mode", padding="10")
        self.learn_frame.grid(row=2, column=0, sticky=(tk.W, tk.E))
        self.learn_frame.grid_remove()  # Hide initially

        ttk.Label(self.learn_frame, text="1. Select function to map:").grid(row=0, column=0, sticky=tk.W, pady=(0, 5))

        self.function_var = tk.StringVar()
        self.function_combo = ttk.Combobox(self.learn_frame, textvariable=self.function_var,
                                          state='readonly', width=40)
        self.function_combo['values'] = self.get_available_functions()
        self.function_combo.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 10))

        # Map both press and release checkbox
        self.map_both_var = tk.BooleanVar(value=False)
        self.map_both_check = ttk.Checkbutton(
            self.learn_frame,
            text="Map both press and release (for momentary control)",
            variable=self.map_both_var
        )
        self.map_both_check.grid(row=2, column=0, sticky=tk.W, pady=(0, 10))

        ttk.Label(self.learn_frame, text="2. Press and release MIDI control:").grid(row=3, column=0, sticky=tk.W, pady=(0, 5))

        self.learn_status_label = ttk.Label(self.learn_frame, text="Waiting for MIDI input...",
                                           foreground='blue', font=('TkDefaultFont', 10, 'bold'))
        self.learn_status_label.grid(row=4, column=0, sticky=tk.W, pady=(0, 10))

        learn_buttons_frame = ttk.Frame(self.learn_frame)
        learn_buttons_frame.grid(row=5, column=0, sticky=tk.W)

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
        # (status_label was created earlier in device_frame)
        if self.midi_in and self.running:
            self.status_label.config(text="Connected", foreground='green')
            print(f"DEBUG: MIDI window opened - showing Connected (midi_in={self.midi_in is not None}, running={self.running})")
        else:
            self.status_label.config(text="Not connected", foreground='red')
            print(f"DEBUG: MIDI window opened - showing Not connected (midi_in={self.midi_in is not None}, running={self.running})")

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
                    pass  # Ignore errors when closing
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
                self.parent_gui.log_status(f"MIDI device connected: {device_name}")
            else:
                raise Exception(f"Device not found: {device_name}")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to connect to MIDI device: {e}")
            self.status_label.config(text="Connection failed", foreground='red')
            self.parent_gui.log_status(f"MIDI connection error: {e}")

    def on_midi_message(self, message, data=None):
        """Handle incoming MIDI message.

        Args:
            message: MIDI message tuple (status, data1, data2, timestamp)
            data: Optional user data
        """
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
                # Check if function is selected
                if self.function_var.get():
                    map_both = self.map_both_var.get()

                    if map_both:
                        # Map both press and release mode
                        if is_note_on:
                            # Got press - store it and wait for release
                            self.learn_press_key = key
                            if self.window and self.window.winfo_exists():
                                self.window.after(0, lambda: self.learn_status_label.config(
                                    text="Press captured! Now release the button...", foreground='orange'))
                        elif is_note_off and hasattr(self, 'learn_press_key'):
                            # Got release - create both mappings
                            press_key = self.learn_press_key
                            release_key = key
                            if self.window and self.window.winfo_exists():
                                self.window.after(0, lambda: self.complete_learn_both(press_key, release_key, msg_type, channel, data1))
                            delattr(self, 'learn_press_key')
                    else:
                        # Single mapping mode - ignore Note Off messages (only capture press/CC/encoder)
                        if is_note_off:
                            return

                        self.learning = True
                        if self.window and self.window.winfo_exists():
                            self.window.after(0, lambda: self.complete_learn(key, msg_type, channel, data1))
                else:
                    # No function selected yet - show reminder
                    if self.window and self.window.winfo_exists():
                        self.window.after(0, lambda: self.learn_status_label.config(
                            text="Please select a function first!", foreground='red'))
            elif key in self.mappings:
                # Execute mapped function - both press and release can have separate mappings
                function_name, params = self.mappings[key]

                # Check if throttling is configured for this mapping
                throttle_ms = params.get('throttle_ms', 0) if isinstance(params, dict) else 0
                mode = params.get('mode', 'debounce') if isinstance(params, dict) else 'debounce'

                if throttle_ms > 0 and mode == 'rate_limit':
                    # Rate limit: Check immediately in MIDI thread to prevent queuing excess messages
                    import time
                    current_time = time.time()
                    last_time = self.last_execution.get(key, 0)
                    time_since_last = (current_time - last_time) * 1000  # Convert to ms

                    if time_since_last >= throttle_ms:
                        # Enough time has passed, execute now
                        self.last_execution[key] = current_time
                        if self.window and self.window.winfo_exists():
                            self.window.after(0, lambda: self.execute_function(function_name, params, data2))
                        else:
                            self.execute_function(function_name, params, data2)
                    # else: ignore this message (too soon)

                elif throttle_ms > 0 and mode == 'debounce':
                    # Debounce: Queue the throttled execution (needs GUI thread for timer management)
                    if self.window and self.window.winfo_exists():
                        self.window.after(0, lambda: self.execute_throttled(key, function_name, params, data2, throttle_ms, mode))
                    else:
                        self.execute_throttled(key, function_name, params, data2, throttle_ms, mode)
                else:
                    # Execute immediately without throttling
                    if self.window and self.window.winfo_exists():
                        self.window.after(0, lambda: self.execute_function(function_name, params, data2))
                    else:
                        self.execute_function(function_name, params, data2)
        except Exception as e:
            # Handle any errors gracefully - don't crash on MIDI errors
            print(f"MIDI message handling error: {e}")
            # Try to log to GUI if available
            try:
                self.parent_gui.log_status(f"MIDI error: {e}")
            except:
                pass

    def start_learn_mode(self):
        """Start learn mode for mapping a new control."""
        if not self.midi_in or not self.running:
            messagebox.showwarning("Warning", "Please connect to a MIDI device first")
            return

        # Show learn frame first so user can select a function
        self.learn_frame.grid()
        self.learn_status_label.config(text="Select a function above, then move/press a MIDI control", foreground='blue')
        self.learn_btn.config(state='disabled')

        # Don't start learning until function is selected
        # Learning will start when MIDI input is received and function is set
        self.learning = False

    def complete_learn(self, key, msg_type, channel, data1):
        """Complete learn mode with captured MIDI control."""
        function_name = self.function_var.get()

        # Default parameters - automatically add 100ms rate_limit for encoder functions
        if function_name.startswith("Frequency: Encoder"):
            params = {
                'throttle_ms': 100,
                'mode': 'rate_limit'
            }
        else:
            params = {}

        # Store mapping (can map both Note On and Note Off separately)
        self.mappings[key] = (function_name, params)
        self.mappings_modified = True

        # Update display
        self.update_mappings_display()

        # Show success
        control_name = self.format_midi_control(msg_type, channel, data1)
        self.learn_status_label.config(text=f"Mapped: {control_name}", foreground='green')

        # Exit learn mode after short delay
        self.window.after(1000, self.cancel_learn_mode)

        self.parent_gui.log_status(f"MIDI mapping created: {control_name} → {function_name}")

    def complete_learn_both(self, press_key, release_key, msg_type, channel, data1):
        """Complete learn mode with both press and release captured."""
        function_name = self.function_var.get()

        # Default parameters - automatically add 100ms rate_limit for encoder functions
        if function_name.startswith("Frequency: Encoder"):
            params = {
                'throttle_ms': 100,
                'mode': 'rate_limit'
            }
        else:
            params = {}

        # Store both mappings
        self.mappings[press_key] = (function_name, params.copy())
        self.mappings[release_key] = (function_name, params.copy())
        self.mappings_modified = True

        # Update display
        self.update_mappings_display()

        # Show success
        press_name = self.format_midi_control(press_key[0], press_key[1], press_key[2])
        release_name = self.format_midi_control(release_key[0], release_key[1], release_key[2])
        self.learn_status_label.config(
            text=f"Mapped both: {press_name} and {release_name}",
            foreground='green'
        )

        # Exit learn mode after short delay
        self.window.after(1500, self.cancel_learn_mode)

        self.parent_gui.log_status(f"MIDI mappings created: {press_name} and {release_name} → {function_name}")

    def cancel_learn_mode(self):
        """Cancel learn mode."""
        self.learning = False
        self.learn_frame.grid_remove()
        self.learn_btn.config(state='normal')
        self.function_var.set('')
        self.map_both_var.set(False)
        # Clean up any pending press capture
        if hasattr(self, 'learn_press_key'):
            delattr(self, 'learn_press_key')

    def format_midi_control(self, msg_type, channel, data1):
        """Format MIDI control for display."""
        if msg_type == 0x90:  # Note On
            return f"Note {data1} (Ch {channel + 1})"
        elif msg_type == 0x80:  # Note Off
            return f"Note Off {data1} (Ch {channel + 1})"
        elif msg_type == 0xB0:  # Control Change
            return f"CC {data1} (Ch {channel + 1})"
        elif msg_type == 0xE0:  # Pitch Bend
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
            "Volume: Set",
            "Bandwidth: Low",
            "Bandwidth: High",
            "Audio Filter: Low",
            "Audio Filter: High",
            "Step Size: 10 Hz",
            "Step Size: 100 Hz",
            "Step Size: 1 kHz",
            "Step Size: 10 kHz",
            "Spectrum: Zoom In",
            "Spectrum: Zoom Out",
            "Spectrum: Zoom Reset",
            "NR2: Toggle",
            "Audio Filter: Toggle",
            "Mute: Toggle",
        ]

    def execute_throttled(self, key, function_name, params, value, throttle_ms, mode):
        """Execute function with throttling (debounce or rate limit).

        Args:
            key: Mapping key tuple
            function_name: Name of function to execute
            params: Function parameters
            value: MIDI value (0-127)
            throttle_ms: Throttle time in milliseconds
            mode: 'debounce' or 'rate_limit'
        """
        import time

        current_time = time.time()

        if mode == 'debounce':
            # Debounce: Cancel pending execution and schedule new one
            # Only the last call within the throttle window will execute

            # Cancel any pending timer for this mapping
            if key in self.pending_timers:
                try:
                    if self.window and self.window.winfo_exists():
                        self.window.after_cancel(self.pending_timers[key])
                except:
                    pass
                del self.pending_timers[key]

            # Schedule new execution
            if self.window and self.window.winfo_exists():
                timer_id = self.window.after(throttle_ms,
                    lambda: self._execute_debounced(key, function_name, params, value))
                self.pending_timers[key] = timer_id
            else:
                # No window, execute after delay using threading
                def delayed_exec():
                    time.sleep(throttle_ms / 1000.0)
                    if key in self.pending_timers:
                        self.execute_function(function_name, params, value)
                        del self.pending_timers[key]

                timer = threading.Timer(throttle_ms / 1000.0, delayed_exec)
                timer.daemon = True
                timer.start()
                self.pending_timers[key] = timer

        elif mode == 'rate_limit':
            # Rate limit: Execute immediately if enough time has passed
            # Ignore calls that come too quickly

            last_time = self.last_execution.get(key, 0)
            time_since_last = (current_time - last_time) * 1000  # Convert to ms

            if time_since_last >= throttle_ms:
                # Enough time has passed, execute now
                self.execute_function(function_name, params, value)
                self.last_execution[key] = current_time
            # else: ignore this call (too soon)

    def _execute_debounced(self, key, function_name, params, value):
        """Internal helper for debounced execution."""
        # Clean up timer reference
        if key in self.pending_timers:
            del self.pending_timers[key]

        # Execute the function
        self.execute_function(function_name, params, value)

        # Update last execution time
        import time
        self.last_execution[key] = time.time()

    def execute_function(self, function_name, params, value):
        """Execute mapped function.

        Args:
            function_name: Name of function to execute
            params: Function parameters
            value: MIDI value (0-127)
        """
        if not self.parent_gui:
            return

        gui = self.parent_gui

        try:
            # Frequency controls
            if function_name == "Frequency: Step Up":
                gui.step_frequency_up()
            elif function_name == "Frequency: Step Down":
                gui.step_frequency_down()
            elif function_name.startswith("Frequency: Encoder"):
                # Encoder with specific step size
                step_map = {
                    "Frequency: Encoder (10 Hz)": 10,
                    "Frequency: Encoder (100 Hz)": 100,
                    "Frequency: Encoder (500 Hz)": 500,
                    "Frequency: Encoder (1 kHz)": 1000,
                    "Frequency: Encoder (10 kHz)": 10000,
                }
                step_hz = step_map.get(function_name, 1000)

                # Most MIDI encoders send:
                # - Value 1 (or 1-63) for clockwise rotation
                # - Value 127 (or 65-127) for counter-clockwise rotation
                # Each message = one detent/step
                try:
                    current_hz = gui.get_frequency_hz()
                    if value >= 64:
                        # Counter-clockwise - decrease frequency by one step
                        new_hz = current_hz - step_hz
                    else:
                        # Clockwise - increase frequency by one step
                        new_hz = current_hz + step_hz

                    # Update frequency
                    gui.set_frequency_hz(new_hz)
                    if gui.connected:
                        gui.apply_frequency()
                except ValueError:
                    pass

            # Mode controls
            elif function_name == "Mode: USB":
                gui.select_mode('USB')
            elif function_name == "Mode: LSB":
                gui.select_mode('LSB')
            elif function_name == "Mode: AM":
                gui.select_mode('AM')
            elif function_name == "Mode: FM":
                gui.select_mode('FM')
            elif function_name == "Mode: CW":
                gui.select_mode('CWU')
            elif function_name == "Mode: Next":
                # Cycle to next mode
                modes = ['USB', 'LSB', 'CWU', 'CWL', 'AM', 'FM']
                try:
                    current_mode = gui.mode_var.get()
                    current_index = modes.index(current_mode)
                    next_index = (current_index + 1) % len(modes)
                    gui.select_mode(modes[next_index])
                except (ValueError, AttributeError):
                    # If current mode not found or error, default to USB
                    gui.select_mode('USB')
            elif function_name == "Mode: Previous":
                # Cycle to previous mode
                modes = ['USB', 'LSB', 'CWU', 'CWL', 'AM', 'FM']
                try:
                    current_mode = gui.mode_var.get()
                    current_index = modes.index(current_mode)
                    prev_index = (current_index - 1) % len(modes)
                    gui.select_mode(modes[prev_index])
                except (ValueError, AttributeError):
                    # If current mode not found or error, default to USB
                    gui.select_mode('USB')

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
                    gui.set_frequency_and_mode(band_freqs[function_name])

            # Volume control
            elif function_name == "Volume: Set":
                # Map MIDI 0-127 to volume 0-100
                volume = int((value / 127) * 100)
                gui.volume_var.set(volume)
                gui.update_volume(volume)

            # Bandwidth controls
            elif function_name == "Bandwidth: Low":
                # Map MIDI 0-127 to current bandwidth low slider range
                try:
                    # Get current slider range
                    slider_min = gui.bw_low_scale.cget('from')
                    slider_max = gui.bw_low_scale.cget('to')

                    # Map MIDI value to slider range
                    bw_low = int(slider_min + (value / 127) * (slider_max - slider_min))
                    gui.bw_low_var.set(bw_low)
                    gui.update_bandwidth_display()
                except (ValueError, AttributeError):
                    pass

            elif function_name == "Bandwidth: High":
                # Map MIDI 0-127 to current bandwidth high slider range
                try:
                    # Get current slider range
                    slider_min = gui.bw_high_scale.cget('from')
                    slider_max = gui.bw_high_scale.cget('to')

                    # Map MIDI value to slider range
                    bw_high = int(slider_min + (value / 127) * (slider_max - slider_min))
                    gui.bw_high_var.set(bw_high)
                    gui.update_bandwidth_display()
                except (ValueError, AttributeError):
                    pass

            # Audio filter controls
            elif function_name == "Audio Filter: Low":
                # Map MIDI 0-127 to current audio filter low slider range
                try:
                    # Get current slider range
                    slider_min = gui.filter_low_scale.cget('from')
                    slider_max = gui.filter_low_scale.cget('to')

                    # Map MIDI value to slider range
                    filter_low = int(slider_min + (value / 127) * (slider_max - slider_min))
                    gui.audio_filter_low_var.set(filter_low)
                    gui.update_audio_filter_display()
                except (ValueError, AttributeError):
                    pass

            elif function_name == "Audio Filter: High":
                # Map MIDI 0-127 to current audio filter high slider range
                try:
                    # Get current slider range
                    slider_min = gui.filter_high_scale.cget('from')
                    slider_max = gui.filter_high_scale.cget('to')

                    # Map MIDI value to slider range
                    filter_high = int(slider_min + (value / 127) * (slider_max - slider_min))
                    gui.audio_filter_high_var.set(filter_high)
                    gui.update_audio_filter_display()
                except (ValueError, AttributeError):
                    pass

            # Step size controls
            elif function_name.startswith("Step Size: "):
                step_map = {
                    "Step Size: 10 Hz": "10 Hz",
                    "Step Size: 100 Hz": "100 Hz",
                    "Step Size: 1 kHz": "1 kHz",
                    "Step Size: 10 kHz": "10 kHz",
                }
                if function_name in step_map:
                    gui.step_size_var.set(step_map[function_name])
                    gui.on_step_size_changed()

            # Spectrum zoom controls (only work if spectrum/waterfall window is open)
            elif function_name == "Spectrum: Zoom In" and value > 0:
                # Check if waterfall window is open and has spectrum display
                if hasattr(gui, 'waterfall_spectrum') and gui.waterfall_spectrum:
                    try:
                        gui.waterfall_spectrum.zoom_in()
                    except AttributeError:
                        pass
                # Also zoom main spectrum if available
                if gui.spectrum:
                    try:
                        gui.spectrum.zoom_in()
                    except AttributeError:
                        pass
                # Also zoom waterfall display if available
                if hasattr(gui, 'waterfall_waterfall') and gui.waterfall_waterfall:
                    try:
                        gui.waterfall_waterfall.zoom_in()
                    except AttributeError:
                        pass

            elif function_name == "Spectrum: Zoom Out" and value > 0:
                # Check if waterfall window is open and has spectrum display
                if hasattr(gui, 'waterfall_spectrum') and gui.waterfall_spectrum:
                    try:
                        gui.waterfall_spectrum.zoom_out()
                    except AttributeError:
                        pass
                # Also zoom main spectrum if available
                if gui.spectrum:
                    try:
                        gui.spectrum.zoom_out()
                    except AttributeError:
                        pass
                # Also zoom waterfall display if available
                if hasattr(gui, 'waterfall_waterfall') and gui.waterfall_waterfall:
                    try:
                        gui.waterfall_waterfall.zoom_out()
                    except AttributeError:
                        pass

            elif function_name == "Spectrum: Zoom Reset" and value > 0:
                # Check if waterfall window is open and has spectrum display
                if hasattr(gui, 'waterfall_spectrum') and gui.waterfall_spectrum:
                    try:
                        gui.waterfall_spectrum.reset_zoom()
                    except AttributeError:
                        pass
                # Also reset main spectrum if available
                if gui.spectrum:
                    try:
                        gui.spectrum.reset_zoom()
                    except AttributeError:
                        pass
                # Also reset waterfall display if available
                if hasattr(gui, 'waterfall_waterfall') and gui.waterfall_waterfall:
                    try:
                        gui.waterfall_waterfall.reset_zoom()
                    except AttributeError:
                        pass

            # Toggle controls (trigger on button press, value > 0)
            elif value > 0:
                if function_name == "NR2: Toggle":
                    gui.nr2_enabled_var.set(not gui.nr2_enabled_var.get())
                    gui.toggle_nr2()
                elif function_name == "Audio Filter: Toggle":
                    gui.audio_filter_enabled_var.set(not gui.audio_filter_enabled_var.get())
                    gui.toggle_audio_filter()
                elif function_name == "Mute: Toggle":
                    # Toggle both channels
                    current_muted = not (gui.channel_left_var.get() or gui.channel_right_var.get())
                    new_muted = not current_muted
                    gui.channel_left_var.set(not new_muted)
                    gui.channel_right_var.set(not new_muted)
                    gui.update_channels()

        except Exception as e:
            print(f"Error executing MIDI function {function_name}: {e}")
            # Try to log to GUI if available
            try:
                gui.log_status(f"MIDI function error: {function_name} - {e}")
            except:
                pass

    def update_mappings_display(self):
        """Update the mappings treeview."""
        # Clear existing items
        for item in self.mappings_tree.get_children():
            self.mappings_tree.delete(item)

        # Add current mappings
        for key, (function_name, params) in self.mappings.items():
            msg_type, channel, data1 = key
            control_name = self.format_midi_control(msg_type, channel, data1)

            # Format parameters for display
            if isinstance(params, dict) and params:
                parts = []
                if 'throttle_ms' in params:
                    parts.append(f"{params['throttle_ms']}ms")
                if 'mode' in params:
                    parts.append(params['mode'])
                params_str = ", ".join(parts) if parts else ""
            else:
                params_str = ""

            self.mappings_tree.insert('', 'end', values=(control_name, function_name, params_str))

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
        dialog.geometry("400x300")
        dialog.transient(self.window)
        dialog.grab_set()

        # Main frame
        frame = ttk.Frame(dialog, padding="20")
        frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        # Function display
        ttk.Label(frame, text="Function:", font=('TkDefaultFont', 10, 'bold')).grid(
            row=0, column=0, sticky=tk.W, pady=(0, 5))
        ttk.Label(frame, text=function_name).grid(row=0, column=1, sticky=tk.W, pady=(0, 5))

        # Throttle enable
        ttk.Label(frame, text="Enable Throttling:", font=('TkDefaultFont', 10, 'bold')).grid(
            row=1, column=0, sticky=tk.W, pady=(10, 5))

        throttle_enabled_var = tk.BooleanVar(value=current_params.get('throttle_ms', 0) > 0)
        throttle_check = ttk.Checkbutton(frame, variable=throttle_enabled_var,
                                        command=lambda: self._toggle_throttle_fields(
                                            throttle_enabled_var.get(), throttle_entry, mode_combo))
        throttle_check.grid(row=1, column=1, sticky=tk.W, pady=(10, 5))

        # Throttle time
        ttk.Label(frame, text="Throttle Time (ms):").grid(row=2, column=0, sticky=tk.W, pady=(5, 5))
        throttle_var = tk.StringVar(value=str(current_params.get('throttle_ms', 100)))
        throttle_entry = ttk.Entry(frame, textvariable=throttle_var, width=10)
        throttle_entry.grid(row=2, column=1, sticky=tk.W, pady=(5, 5))

        # Throttle mode
        ttk.Label(frame, text="Throttle Mode:").grid(row=3, column=0, sticky=tk.W, pady=(5, 5))
        mode_var = tk.StringVar(value=current_params.get('mode', 'debounce'))
        mode_combo = ttk.Combobox(frame, textvariable=mode_var, state='readonly', width=15)
        mode_combo['values'] = ['debounce', 'rate_limit']
        mode_combo.grid(row=3, column=1, sticky=tk.W, pady=(5, 5))

        # Mode descriptions
        desc_frame = ttk.LabelFrame(frame, text="Mode Descriptions", padding="10")
        desc_frame.grid(row=4, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(10, 10))

        ttk.Label(desc_frame, text="• Debounce: Only last input within time window executes",
                 wraplength=350, justify=tk.LEFT).grid(row=0, column=0, sticky=tk.W)
        ttk.Label(desc_frame, text="• Rate Limit: Ignores inputs that come too quickly",
                 wraplength=350, justify=tk.LEFT).grid(row=1, column=0, sticky=tk.W)

        # Initial state
        self._toggle_throttle_fields(throttle_enabled_var.get(), throttle_entry, mode_combo)

        # Buttons
        button_frame = ttk.Frame(frame)
        button_frame.grid(row=5, column=0, columnspan=2, pady=(10, 0))

        def save_changes():
            try:
                if throttle_enabled_var.get():
                    throttle_ms = int(throttle_var.get())
                    if throttle_ms < 0:
                        raise ValueError("Throttle time must be positive")
                    new_params = {
                        'throttle_ms': throttle_ms,
                        'mode': mode_var.get()
                    }
                else:
                    new_params = {}

                # Update mapping
                self.mappings[mapping_key] = (function_name, new_params)
                self.mappings_modified = True
                self.update_mappings_display()
                dialog.destroy()
                self.parent_gui.log_status(f"MIDI mapping updated: {control_name}")

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
        self.parent_gui.log_status(f"MIDI mapping deleted: {control_name}")

    def clear_all_mappings(self):
        """Clear all mappings."""
        if messagebox.askyesno("Confirm", "Delete all MIDI mappings?"):
            self.mappings.clear()
            self.mappings_modified = True
            self.update_mappings_display()
            self.parent_gui.log_status("All MIDI mappings cleared")

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
            self.parent_gui.log_status("MIDI mappings saved")

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
        self.parent_gui.midi_window = None
        self.parent_gui.log_status("MIDI window closed (controller still active)")

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
        parent_gui: Parent RadioGUI instance

    Returns:
        MIDIController instance
    """
    controller = MIDIController(parent_gui)
    controller.create_window(parent_gui.root)
    return controller