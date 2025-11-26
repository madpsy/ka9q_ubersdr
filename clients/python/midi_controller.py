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

        # Last used device name
        self.last_device_name = None

        # Load saved mappings and device
        self.config_file = os.path.expanduser("~/.ubersdr_midi_mappings.json")
        self.load_mappings()

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

        self.delete_btn = ttk.Button(buttons_frame, text="Delete Mapping",
                                     command=self.delete_mapping)
        self.delete_btn.grid(row=0, column=1, padx=(0, 5))

        self.clear_btn = ttk.Button(buttons_frame, text="Clear All",
                                    command=self.clear_all_mappings)
        self.clear_btn.grid(row=0, column=2, padx=(0, 5))

        self.save_btn = ttk.Button(buttons_frame, text="Save Mappings",
                                   command=self.save_mappings)
        self.save_btn.grid(row=0, column=3)

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

        ttk.Label(self.learn_frame, text="2. Move/press MIDI control:").grid(row=2, column=0, sticky=tk.W, pady=(0, 5))

        self.learn_status_label = ttk.Label(self.learn_frame, text="Waiting for MIDI input...",
                                           foreground='blue', font=('TkDefaultFont', 10, 'bold'))
        self.learn_status_label.grid(row=3, column=0, sticky=tk.W, pady=(0, 10))

        learn_buttons_frame = ttk.Frame(self.learn_frame)
        learn_buttons_frame.grid(row=4, column=0, sticky=tk.W)

        self.cancel_learn_btn = ttk.Button(learn_buttons_frame, text="Cancel",
                                          command=self.cancel_learn_mode)
        self.cancel_learn_btn.grid(row=0, column=0)

        self.learn_frame.columnconfigure(0, weight=1)

        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(1, weight=1)

        # Refresh devices on startup
        self.refresh_devices()

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

            # Ignore Note Off messages in learn mode (only capture Note On for buttons)
            # Note Off is 0x80, or Note On (0x90) with velocity 0
            is_note_off = (msg_type == 0x80) or (msg_type == 0x90 and data2 == 0)

            # Create mapping key
            key = (msg_type, channel, data1)

            # Check if learn frame exists and is visible (learn mode active)
            if self.learn_frame and self.learn_frame.winfo_exists() and self.learn_frame.winfo_ismapped():
                # In learn mode - ignore Note Off messages
                if is_note_off:
                    return
                
                # Check if function is selected
                if self.function_var.get():
                    # Function selected - capture this control
                    self.learning = True
                    if self.window and self.window.winfo_exists():
                        self.window.after(0, lambda: self.complete_learn(key, msg_type, channel, data1))
                else:
                    # No function selected yet - show reminder
                    if self.window and self.window.winfo_exists():
                        self.window.after(0, lambda: self.learn_status_label.config(
                            text="Please select a function first!", foreground='red'))
            elif key in self.mappings:
                # Execute mapped function (also ignore Note Off for execution)
                if is_note_off:
                    return
                    
                function_name, params = self.mappings[key]
                if self.window and self.window.winfo_exists():
                    self.window.after(0, lambda: self.execute_function(function_name, params, data2))
                else:
                    # Window doesn't exist, execute directly
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

        # Store mapping
        self.mappings[key] = (function_name, {})

        # Update display
        self.update_mappings_display()

        # Show success
        control_name = self.format_midi_control(msg_type, channel, data1)
        self.learn_status_label.config(text=f"Mapped: {control_name}", foreground='green')

        # Exit learn mode after short delay
        self.window.after(1000, self.cancel_learn_mode)

        self.parent_gui.log_status(f"MIDI mapping created: {control_name} → {function_name}")

    def cancel_learn_mode(self):
        """Cancel learn mode."""
        self.learning = False
        self.learn_frame.grid_remove()
        self.learn_btn.config(state='normal')
        self.function_var.set('')

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
            "Step Size: 10 Hz",
            "Step Size: 100 Hz",
            "Step Size: 1 kHz",
            "Step Size: 10 kHz",
            "NR2: Toggle",
            "Audio Filter: Toggle",
            "Mute: Toggle",
        ]

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
                # Map MIDI value to bandwidth range
                current_low = gui.bw_low_var.get()
                # Adjust based on current mode
                gui.bw_low_var.set(current_low)
                gui.update_bandwidth_display()

            elif function_name == "Bandwidth: High":
                current_high = gui.bw_high_var.get()
                gui.bw_high_var.set(current_high)
                gui.update_bandwidth_display()

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
            params_str = str(params) if params else ""
            self.mappings_tree.insert('', 'end', values=(control_name, function_name, params_str))

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
                break

        self.update_mappings_display()
        self.parent_gui.log_status(f"MIDI mapping deleted: {control_name}")

    def clear_all_mappings(self):
        """Clear all mappings."""
        if messagebox.askyesno("Confirm", "Delete all MIDI mappings?"):
            self.mappings.clear()
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

    def on_close(self):
        """Handle window close - keep MIDI active in background."""
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