#!/usr/bin/env python3
"""
FSK/RTTY Extension Window for Python Radio Client
Replicates the JavaScript FSK extension functionality
"""

import tkinter as tk
from tkinter import ttk, scrolledtext, filedialog, messagebox
import json
import time
from datetime import datetime
from typing import Optional, Dict, Callable
import struct
import numpy as np
import queue
import math


class FSKExtension:
    """FSK/RTTY decoder extension window."""
    
    # Presets
    PRESETS = {
        'navtex': {
            'name': 'NAVTEX (500Hz/170/100)',
            'center_frequency': 500,
            'shift': 170,
            'baud_rate': 100,
            'framing': '4/7',
            'encoding': 'CCIR476',
            'inverted': False
        },
        'sitor-b': {
            'name': 'SITOR-B (1000Hz/170/100)',
            'center_frequency': 1000,
            'shift': 170,
            'baud_rate': 100,
            'framing': '4/7',
            'encoding': 'CCIR476',
            'inverted': False
        },
        'weather': {
            'name': 'Weather RTTY (1000Hz/450/50)',
            'center_frequency': 1000,
            'shift': 450,
            'baud_rate': 50,
            'framing': '5N1.5',
            'encoding': 'ITA2',
            'inverted': True
        },
        'ham': {
            'name': 'Ham RTTY (1000Hz/170/45.45)',
            'center_frequency': 1000,
            'shift': 170,
            'baud_rate': 45.45,
            'framing': '5N1.5',
            'encoding': 'ITA2',
            'inverted': False
        },
        'custom': {
            'name': 'Custom',
            'center_frequency': 1000,
            'shift': 170,
            'baud_rate': 45.45,
            'framing': '5N1.5',
            'encoding': 'ITA2',
            'inverted': False
        }
    }
    
    def __init__(self, parent: tk.Tk, dxcluster_ws, radio_control):
        """
        Initialize FSK extension window.
        
        Args:
            parent: Parent window
            dxcluster_ws: DX cluster WebSocket connection
            radio_control: Radio control object (for tuning)
        """
        self.parent = parent
        self.dxcluster_ws = dxcluster_ws
        self.radio_control = radio_control
        
        # State
        self.running = False
        self.text_buffer = ""
        self.char_count = 0
        self.auto_scroll = True
        self.show_timestamp = True
        self.needs_timestamp = True
        self.console_lines = 25
        self.baud_error = 0.0
        self.decoder_state = 0  # 0=NoSignal, 1=Sync1, 2=Sync2, 3=ReadData
        
        # Audio processing - read from audio spectrum display
        self.sample_rate = 12000  # Will be updated from audio spectrum display
        self.spectrum_data = None
        self.spectrum_history = []  # Read from audio spectrum display
        self.history_timestamps = []  # Read from audio spectrum display
        self.auto_level_window_seconds = 2.0  # Read from audio spectrum display
        
        # Configuration
        self.config = {
            'center_frequency': 500,
            'shift': 170,
            'baud_rate': 100,
            'framing': '4/7',
            'encoding': 'CCIR476',
            'inverted': False
        }
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("📟 FSK/RTTY Decoder")
        self.window.geometry("1000x800")
        self.window.protocol("WM_DELETE_WINDOW", self.on_closing)
        
        # Create UI
        self.create_widgets()
        
        # Setup WebSocket handler
        self.original_ws_handler = None
        
        # Apply default preset
        self.apply_preset('navtex')
        
        # Initialize baud error display
        self.update_baud_error(0.0)
        
        # Start audio processing loop
        self.start_audio_processing()
        
    def create_widgets(self):
        """Create UI widgets."""
        # Main frame
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        
        # Header with title and buttons
        header_frame = ttk.Frame(main_frame)
        header_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        ttk.Label(header_frame, text="FSK/RTTY Decoder", 
                 font=('TkDefaultFont', 12, 'bold')).pack(side=tk.LEFT)
        
        # Control buttons
        button_frame = ttk.Frame(header_frame)
        button_frame.pack(side=tk.RIGHT)
        
        self.start_btn = ttk.Button(button_frame, text="Start", command=self.toggle_decoding)
        self.start_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        ttk.Button(button_frame, text="Copy", command=self.copy_to_clipboard).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(button_frame, text="Save", command=self.save_text).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(button_frame, text="Clear", command=self.clear_output).pack(side=tk.LEFT)
        
        # Configuration panel
        config_frame = ttk.LabelFrame(main_frame, text="Configuration", padding="10")
        config_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        # Row 1
        row = 0
        col = 0
        
        ttk.Label(config_frame, text="Preset:").grid(row=row, column=col, sticky=tk.W, padx=(0, 5))
        self.preset_var = tk.StringVar(value='navtex')
        preset_combo = ttk.Combobox(config_frame, textvariable=self.preset_var,
                                    values=list(self.PRESETS.keys()), state='readonly', width=25)
        preset_combo.grid(row=row, column=col+1, sticky=tk.W, padx=(0, 15))
        preset_combo.bind('<<ComboboxSelected>>', lambda e: self.on_preset_changed())
        
        col += 2
        ttk.Label(config_frame, text="Shift (Hz):").grid(row=row, column=col, sticky=tk.W, padx=(0, 5))
        self.shift_var = tk.StringVar(value="170")
        shift_entry = ttk.Entry(config_frame, textvariable=self.shift_var, width=10)
        shift_entry.grid(row=row, column=col+1, sticky=tk.W, padx=(0, 15))
        
        col += 2
        ttk.Label(config_frame, text="Baud:").grid(row=row, column=col, sticky=tk.W, padx=(0, 5))
        self.baud_var = tk.StringVar(value="45.45")
        baud_entry = ttk.Entry(config_frame, textvariable=self.baud_var, width=10)
        baud_entry.grid(row=row, column=col+1, sticky=tk.W, padx=(0, 15))
        
        # Row 2
        row += 1
        col = 0
        
        ttk.Label(config_frame, text="Center (Hz):").grid(row=row, column=col, sticky=tk.W, padx=(0, 5))
        self.center_freq_var = tk.StringVar(value="1000")
        center_entry = ttk.Entry(config_frame, textvariable=self.center_freq_var, width=10)
        center_entry.grid(row=row, column=col+1, sticky=tk.W, padx=(0, 15))
        
        col += 2
        ttk.Label(config_frame, text="Framing:").grid(row=row, column=col, sticky=tk.W, padx=(0, 5))
        self.framing_var = tk.StringVar(value="5N1.5")
        framing_combo = ttk.Combobox(config_frame, textvariable=self.framing_var,
                                     values=["5N1", "5N1.5", "5N2", "7N1", "8N1", "4/7"],
                                     state='readonly', width=8)
        framing_combo.grid(row=row, column=col+1, sticky=tk.W, padx=(0, 15))
        
        col += 2
        ttk.Label(config_frame, text="Encoding:").grid(row=row, column=col, sticky=tk.W, padx=(0, 5))
        self.encoding_var = tk.StringVar(value="ITA2")
        encoding_combo = ttk.Combobox(config_frame, textvariable=self.encoding_var,
                                      values=["ITA2", "ASCII", "CCIR476"],
                                      state='readonly', width=10)
        encoding_combo.grid(row=row, column=col+1, sticky=tk.W, padx=(0, 15))
        
        col += 2
        self.inverted_var = tk.BooleanVar(value=False)
        inverted_check = ttk.Checkbutton(config_frame, text="Inverted", variable=self.inverted_var)
        inverted_check.grid(row=row, column=col, columnspan=2, sticky=tk.W)
        
        # Store config controls for enable/disable
        self.config_controls = [
            preset_combo, framing_combo, encoding_combo,
            shift_entry, baud_entry, center_entry, inverted_check
        ]
        
        # Console controls
        console_ctrl_frame = ttk.Frame(main_frame)
        console_ctrl_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        self.timestamp_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(console_ctrl_frame, text="Timestamp", variable=self.timestamp_var,
                       command=self.on_timestamp_changed).pack(side=tk.LEFT, padx=(0, 15))
        
        self.auto_scroll_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(console_ctrl_frame, text="Auto-Scroll", variable=self.auto_scroll_var,
                       command=self.on_auto_scroll_changed).pack(side=tk.LEFT, padx=(0, 15))
        
        ttk.Label(console_ctrl_frame, text="Console Lines:").pack(side=tk.LEFT, padx=(0, 5))
        self.console_lines_var = tk.StringVar(value="25")
        console_lines_combo = ttk.Combobox(console_ctrl_frame, textvariable=self.console_lines_var,
                                          values=["10", "25", "50", "100"], state='readonly', width=8)
        console_lines_combo.pack(side=tk.LEFT)
        console_lines_combo.bind('<<ComboboxSelected>>', lambda e: self.update_console_height())
        
        # Baud error indicator (on the right side)
        self.baud_error_label = ttk.Label(console_ctrl_frame, text="0.0", font=('TkDefaultFont', 10, 'bold'), width=5, anchor='e')
        self.baud_error_label.pack(side=tk.RIGHT)
        ttk.Label(console_ctrl_frame, text="Baud Error:").pack(side=tk.RIGHT, padx=(15, 5))
        
        # Spectrum display (canvas)
        spectrum_frame = ttk.LabelFrame(main_frame, text="Spectrum (0-3000 Hz)", padding="5")
        spectrum_frame.grid(row=3, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        self.spectrum_canvas = tk.Canvas(spectrum_frame, height=100, bg='#0a0a0a', highlightthickness=0)
        self.spectrum_canvas.pack(fill=tk.X, expand=True)
        self.spectrum_canvas.bind('<Button-1>', self.on_spectrum_click)
        self.spectrum_canvas.bind('<Configure>', self.on_spectrum_resize)
        
        # Text console
        console_frame = ttk.LabelFrame(main_frame, text="Decoded Text", padding="5")
        console_frame.grid(row=4, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        main_frame.rowconfigure(4, weight=1)
        
        self.console_text = scrolledtext.ScrolledText(console_frame, wrap=tk.WORD,
                                                     font=('Courier New', 10),
                                                     bg='black', fg='#00ff00',
                                                     height=25)
        self.console_text.pack(fill=tk.BOTH, expand=True)
        
        # Status bar
        status_frame = ttk.Frame(main_frame)
        status_frame.grid(row=5, column=0, sticky=(tk.W, tk.E))
        
        # Left side - status indicators
        left_frame = ttk.Frame(status_frame)
        left_frame.pack(side=tk.LEFT, fill=tk.X, expand=True)
        
        self.status_label = ttk.Label(left_frame, text="Ready", foreground='blue')
        self.status_label.pack(side=tk.LEFT, padx=(0, 20))
        
        # State indicators
        self.signal_indicator = ttk.Label(left_frame, text="● Signal", foreground='gray')
        self.signal_indicator.pack(side=tk.LEFT, padx=(0, 10))
        
        self.sync_indicator = ttk.Label(left_frame, text="● Sync", foreground='gray')
        self.sync_indicator.pack(side=tk.LEFT, padx=(0, 10))
        
        self.decode_indicator = ttk.Label(left_frame, text="● Decode", foreground='gray')
        self.decode_indicator.pack(side=tk.LEFT)
        
        # Right side - audio level
        right_frame = ttk.Frame(status_frame)
        right_frame.pack(side=tk.RIGHT)
        
        ttk.Label(right_frame, text="Audio:").pack(side=tk.LEFT, padx=(0, 5))
        self.audio_db_label = ttk.Label(right_frame, text="-∞ dB", width=8)
        self.audio_db_label.pack(side=tk.LEFT)
        
        main_frame.columnconfigure(0, weight=1)
        
    def on_preset_changed(self):
        """Handle preset selection change."""
        preset_name = self.preset_var.get()
        self.apply_preset(preset_name)
        
    def apply_preset(self, preset_name: str):
        """Apply a preset configuration."""
        if preset_name not in self.PRESETS:
            return
        
        preset = self.PRESETS[preset_name]
        
        # Update config
        self.config['center_frequency'] = preset['center_frequency']
        self.config['shift'] = preset['shift']
        self.config['baud_rate'] = preset['baud_rate']
        self.config['framing'] = preset['framing']
        self.config['encoding'] = preset['encoding']
        self.config['inverted'] = preset['inverted']
        
        # Update UI
        self.center_freq_var.set(str(preset['center_frequency']))
        self.shift_var.set(str(preset['shift']))
        self.baud_var.set(str(preset['baud_rate']))
        self.framing_var.set(preset['framing'])
        self.encoding_var.set(preset['encoding'])
        self.inverted_var.set(preset['inverted'])
        
        print(f"FSK: Applied preset '{preset_name}'")
        
    def update_config(self):
        """Update configuration from UI."""
        try:
            self.config['center_frequency'] = float(self.center_freq_var.get())
            self.config['shift'] = float(self.shift_var.get())
            self.config['baud_rate'] = float(self.baud_var.get())
            self.config['framing'] = self.framing_var.get()
            self.config['encoding'] = self.encoding_var.get()
            self.config['inverted'] = self.inverted_var.get()
        except ValueError as e:
            print(f"Error updating config: {e}")
    
    def toggle_decoding(self):
        """Toggle decoding on/off."""
        if self.running:
            self.stop_decoding()
        else:
            self.start_decoding()
    
    def start_decoding(self):
        """Start the FSK decoder."""
        if self.running:
            return
        
        # Update configuration
        self.update_config()
        
        # Attach to audio extension via WebSocket
        if not self.dxcluster_ws or not self.dxcluster_ws.is_connected():
            messagebox.showerror("Error", "WebSocket not connected")
            return
        
        try:
            # Send attach message
            attach_msg = {
                'type': 'audio_extension_attach',
                'extension_name': 'fsk',
                'params': self.config
            }
            
            self.dxcluster_ws.ws.send(json.dumps(attach_msg))
            
            # Setup binary message handler
            self.setup_binary_handler()
            
            # Update UI
            self.running = True
            self.start_btn.config(text="Stop")
            self.status_label.config(text="Running", foreground='green')
            
            # Disable config controls
            for ctrl in self.config_controls:
                ctrl.config(state='disabled')
            
            # Add startup message
            self.append_output("=== FSK Decoder Started ===\n")
            self.append_output(f"Mode: {self.config['encoding']}, Baud: {self.config['baud_rate']}, Shift: {self.config['shift']} Hz\n")
            
            print("FSK decoder started")
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to start decoder: {e}")
            print(f"Error starting decoder: {e}")
    
    def stop_decoding(self):
        """Stop the FSK decoder."""
        if not self.running:
            return
        
        try:
            # Send detach message
            detach_msg = {
                'type': 'audio_extension_detach'
            }
            
            if self.dxcluster_ws and hasattr(self.dxcluster_ws, 'ws'):
                self.dxcluster_ws.ws.send(json.dumps(detach_msg))
            
            # Restore original handler
            self.restore_binary_handler()
            
            # Update UI
            self.running = False
            self.start_btn.config(text="Start")
            self.status_label.config(text="Stopped", foreground='gray')
            
            # Clear state indicators
            self.signal_indicator.config(foreground='gray')
            self.sync_indicator.config(foreground='gray')
            self.decode_indicator.config(foreground='gray')
            
            # Enable config controls
            for ctrl in self.config_controls:
                # Comboboxes use 'readonly', Entry and Checkbutton use 'normal'
                if isinstance(ctrl, ttk.Combobox):
                    ctrl.config(state='readonly')
                else:
                    ctrl.config(state='normal')
            
            self.append_output("=== FSK Decoder Stopped ===\n")
            
            print("FSK decoder stopped")
            
        except Exception as e:
            print(f"Error stopping decoder: {e}")
    
    def setup_binary_handler(self):
        """Setup binary message handler for WebSocket."""
        if hasattr(self.dxcluster_ws, 'ws') and hasattr(self.dxcluster_ws.ws, 'on_message'):
            self.original_ws_handler = self.dxcluster_ws.ws.on_message
        
        def binary_handler(ws, message):
            if isinstance(message, bytes):
                self.handle_binary_message(message)
            else:
                if self.original_ws_handler:
                    self.original_ws_handler(ws, message)
        
        if hasattr(self.dxcluster_ws, 'ws'):
            self.dxcluster_ws.ws.on_message = binary_handler
    
    def restore_binary_handler(self):
        """Restore original WebSocket handler."""
        if self.original_ws_handler and hasattr(self.dxcluster_ws, 'ws'):
            self.dxcluster_ws.ws.on_message = self.original_ws_handler
            self.original_ws_handler = None
    
    def handle_binary_message(self, data: bytes):
        """Handle binary message from WebSocket."""
        if len(data) < 1:
            return
        
        msg_type = data[0]
        
        if msg_type == 0x01:
            # Text message: [type:1][timestamp:8][text_length:4][text:length]
            if len(data) < 13:
                return
            
            text_length = struct.unpack('>I', data[9:13])[0]
            text_data = data[13:13+text_length]
            text = text_data.decode('utf-8', errors='replace')
            
            self.append_output(text)
            
        elif msg_type == 0x02:
            # Baud error: [type:1][error:8]
            if len(data) < 9:
                return
            
            error = struct.unpack('>d', data[1:9])[0]
            self.update_baud_error(error)
            
        elif msg_type == 0x03:
            # State update: [type:1][state:1]
            if len(data) < 2:
                return
            
            state = data[1]
            self.update_decoder_state(state)
    
    def append_output(self, text: str):
        """Append text to console."""
        # Process text character by character to add timestamps
        processed_text = ""
        
        for char in text:
            # Add timestamp at start of new line (if enabled)
            if self.show_timestamp and self.needs_timestamp and char != '\r':
                timestamp = datetime.now().strftime("%H:%M:%S")
                processed_text += f"[{timestamp}] "
                self.needs_timestamp = False
            
            processed_text += char
            
            if char == '\n':
                self.needs_timestamp = True
        
        # Append to buffer and console
        self.text_buffer += processed_text
        self.char_count += len(text)
        
        self.console_text.insert(tk.END, processed_text)
        
        # Auto-scroll
        if self.auto_scroll:
            self.console_text.see(tk.END)
    
    def update_baud_error(self, error: float):
        """Update baud error display."""
        self.baud_error = error
        self.baud_error_label.config(text=f"{error:.1f}")
        
        # Color based on error magnitude
        if abs(error) < 2:
            color = 'green'
        elif abs(error) < 5:
            color = 'orange'
        else:
            color = 'red'
        self.baud_error_label.config(foreground=color)
    
    def update_decoder_state(self, state: int):
        """Update decoder state indicators."""
        self.decoder_state = state
        
        # Update indicators based on state
        # 0=NoSignal, 1=Sync1, 2=Sync2, 3=ReadData
        
        if state != 0:
            self.signal_indicator.config(foreground='green')
        else:
            self.signal_indicator.config(foreground='gray')
        
        if state == 2 or state == 3:
            self.sync_indicator.config(foreground='green')
        else:
            self.sync_indicator.config(foreground='gray')
        
        if state == 3:
            self.decode_indicator.config(foreground='green')
        else:
            self.decode_indicator.config(foreground='gray')
    
    def clear_output(self):
        """Clear the console."""
        self.console_text.delete('1.0', tk.END)
        self.text_buffer = ""
        self.char_count = 0
        self.needs_timestamp = True
    
    def copy_to_clipboard(self):
        """Copy text to clipboard."""
        text = self.text_buffer.replace('\r', '')
        if not text:
            messagebox.showinfo("Info", "No text to copy")
            return
        
        self.window.clipboard_clear()
        self.window.clipboard_append(text)
        messagebox.showinfo("Success", "Text copied to clipboard")
    
    def save_text(self):
        """Save decoded text to file."""
        text = self.text_buffer.replace('\r', '')
        if not text:
            messagebox.showinfo("Info", "No text to save")
            return
        
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        filename = filedialog.asksaveasfilename(
            defaultextension=".txt",
            initialfile=f"fsk_{timestamp}.txt",
            filetypes=[("Text files", "*.txt"), ("All files", "*.*")]
        )
        
        if filename:
            try:
                with open(filename, 'w', encoding='utf-8') as f:
                    f.write(text)
                messagebox.showinfo("Success", f"Text saved to {filename}")
            except Exception as e:
                messagebox.showerror("Error", f"Failed to save text: {e}")
    
    def on_timestamp_changed(self):
        """Handle timestamp checkbox change."""
        self.show_timestamp = self.timestamp_var.get()
    
    def on_auto_scroll_changed(self):
        """Handle auto-scroll checkbox change."""
        self.auto_scroll = self.auto_scroll_var.get()
    
    def update_console_height(self):
        """Update console height based on lines setting."""
        try:
            lines = int(self.console_lines_var.get())
            self.console_text.config(height=lines)
        except ValueError:
            pass
    
    def set_sample_rate(self, sample_rate: int):
        """Update sample rate (for compatibility, but we read from audio spectrum display)."""
        self.sample_rate = sample_rate
    
    def process_audio(self):
        """Read spectrum data from audio spectrum display and draw it."""
        try:
            # Read spectrum data from audio spectrum display
            if (self.radio_control and
                hasattr(self.radio_control, 'audio_spectrum_display') and
                self.radio_control.audio_spectrum_display and
                self.radio_control.audio_spectrum_display.spectrum_data is not None):
                
                # Use spectrum data from audio spectrum display
                self.spectrum_data = self.radio_control.audio_spectrum_display.spectrum_data
                self.spectrum_history = list(self.radio_control.audio_spectrum_display.history)
                self.history_timestamps = list(self.radio_control.audio_spectrum_display.history_timestamps)
                self.sample_rate = self.radio_control.audio_spectrum_display.sample_rate
                self.auto_level_window_seconds = self.radio_control.audio_spectrum_display.auto_level_window_seconds
                
                # Draw spectrum
                self.draw_spectrum()
            
        except Exception as e:
            pass  # Silently ignore processing errors
    
    
    def draw_spectrum(self):
        """Draw spectrum visualization with mark/space frequency markers (exact copy of audio spectrum style)."""
        if self.spectrum_data is None:
            return

        canvas = self.spectrum_canvas
        width = canvas.winfo_width()
        height = canvas.winfo_height()

        if width <= 1 or height <= 1:
            return

        # Clear canvas
        canvas.delete('all')

        # Frequency range to display (0-3000 Hz)
        display_freq_min = 0
        display_freq_max = 3000
        nyquist = self.sample_rate / 2

        # Calculate and update audio level (peak in the spectrum)
        valid_spectrum = self.spectrum_data[np.isfinite(self.spectrum_data)]
        if len(valid_spectrum) > 0:
            peak_db = np.max(valid_spectrum)
            if np.isfinite(peak_db):
                self.audio_db_label.config(text=f"{peak_db:.1f} dB")
            else:
                self.audio_db_label.config(text="-∞ dB")
        else:
            self.audio_db_label.config(text="-∞ dB")
        
        # Use percentile-based auto-ranging with history (exact copy from audio spectrum)
        current_time = time.time()
        cutoff_time = current_time - self.auto_level_window_seconds
        
        # Collect recent data from history
        recent_data = []
        for i, timestamp in enumerate(self.history_timestamps):
            if timestamp >= cutoff_time and i < len(self.spectrum_history):
                recent_data.append(self.spectrum_history[i])
        
        if len(recent_data) > 0:
            # Flatten all recent data
            all_data = np.concatenate(recent_data)
            valid_data = all_data[np.isfinite(all_data)]
            
            if len(valid_data) > 0:
                # Use percentiles to determine dynamic range
                p5 = np.percentile(valid_data, 5)   # Noise floor
                p99 = np.percentile(valid_data, 99)  # Signal peaks (use 99th to capture strong signals)

                # Set range with more headroom to prevent clipping
                min_db = p5 - 10  # 10 dB below noise floor
                max_db = p99 + 15  # 15 dB above typical peaks to prevent clipping

                # Ensure reasonable range (at least 40 dB, max 80 dB)
                db_range = max_db - min_db
                if db_range < 40:
                    # Expand range symmetrically
                    center = (max_db + min_db) / 2
                    min_db = center - 20
                    max_db = center + 20
                elif db_range > 80:
                    # Limit range to avoid too much compression
                    min_db = max_db - 80
            else:
                # Fallback if no valid data
                min_db = -80
                max_db = -20
        else:
            # Fallback if no history
            min_db = -80
            max_db = -20
        
        db_range = max_db - min_db
        
        # Draw dark background (exact copy from audio spectrum)
        canvas.create_rectangle(0, 0, width, height, fill='#1a1a1a', outline='white')
        
        # Draw dB scale on left side (exact copy from audio spectrum)
        for i in range(5):
            db = min_db + (i / 4) * db_range
            y = height - (i / 4) * height
            
            # Tick mark
            canvas.create_line(0, y, 5, y, fill='white')
            
            # Label
            label = f"{db:.0f}"
            canvas.create_text(8, y, text=label, fill='white', anchor=tk.W, font=('monospace', 8))
        
        # Draw spectrum line (exact copy from audio spectrum - only within display frequency range)
        if len(self.spectrum_data) > 0:
            points = []
            freq_range = display_freq_max - display_freq_min
            
            for i, db in enumerate(self.spectrum_data):
                if not np.isfinite(db):
                    continue
                
                # Calculate actual frequency for this bin
                bin_freq = (i / len(self.spectrum_data)) * nyquist
                
                # Only draw if within display range
                if display_freq_min <= bin_freq <= display_freq_max:
                    # Map to display coordinates
                    x_normalized = (bin_freq - display_freq_min) / freq_range
                    x = x_normalized * width
                    
                    # Calculate y with clamping to keep within box
                    normalized = (db - min_db) / db_range
                    # Clamp normalized value to 0-1 range
                    normalized = max(0.0, min(1.0, normalized))
                    y = height - (normalized * height)
                    points.extend([x, y])
            
            if len(points) >= 4:
                # Draw filled area (exact copy from audio spectrum)
                fill_points = [0, height] + points + [width, height]
                canvas.create_polygon(fill_points, fill='#1e90ff', outline='', stipple='gray50')
                
                # Draw line (exact copy from audio spectrum)
                canvas.create_line(points, fill='#00ff00', width=1)
        
        # Draw mark and space frequency markers
        center_freq = self.config['center_frequency']
        shift = self.config['shift']
        
        mark_freq = center_freq + (shift / 2)
        space_freq = center_freq - (shift / 2)
        
        # Draw mark frequency line (red)
        if mark_freq <= display_freq_max:
            mark_x = (mark_freq / display_freq_max) * width
            canvas.create_line(mark_x, 0, mark_x, height, fill='#ff0000', width=2, dash=(5, 5))
            canvas.create_text(mark_x + 5, 12, text='Mark', fill='#ff0000', anchor='w', font=('Courier', 8, 'bold'))
            canvas.create_text(mark_x + 5, 24, text=f'{int(mark_freq)} Hz', fill='#ff0000', anchor='w', font=('Courier', 8))
        
        # Draw space frequency line (blue)
        if space_freq >= 0 and space_freq <= display_freq_max:
            space_x = (space_freq / display_freq_max) * width
            canvas.create_line(space_x, 0, space_x, height, fill='#0000ff', width=2, dash=(5, 5))
            canvas.create_text(space_x + 5, 12, text='Space', fill='#0000ff', anchor='w', font=('Courier', 8, 'bold'))
            canvas.create_text(space_x + 5, 24, text=f'{int(space_freq)} Hz', fill='#0000ff', anchor='w', font=('Courier', 8))
        
        # Draw frequency scale at bottom
        for freq in range(0, display_freq_max + 1, 500):
            x = (freq / display_freq_max) * width
            canvas.create_text(x + 2, height - 5, text=f'{freq}Hz', fill='#ffffff', anchor='sw', font=('Courier', 8))
    
    def on_spectrum_click(self, event):
        """Handle click on spectrum to tune to frequency.

        Args:
            event: Tkinter event object
        """
        if not self.radio_control:
            return

        # Calculate clicked frequency
        width = self.spectrum_canvas.winfo_width()
        max_display_freq = 3000

        clicked_freq = (event.x / width) * max_display_freq

        # Get current radio frequency
        try:
            current_freq_hz = self.radio_control.get_frequency_hz()

            # Calculate new frequency to center the clicked audio frequency
            # The clicked frequency is what we're currently hearing in the audio passband.
            # To move it to the center frequency of the FSK decoder:
            # - If clicked_freq < center_freq: signal is too low, tune radio UP (add)
            # - If clicked_freq > center_freq: signal is too high, tune radio DOWN (subtract)
            center_freq = self.config['center_frequency']
            offset = clicked_freq - center_freq

            # Add the offset to radio frequency to move the signal to center
            # (opposite of what you might expect - we're moving the radio, not the signal)
            new_freq_hz = current_freq_hz + int(offset)

            # Tune to new frequency
            self.radio_control.set_frequency_hz(new_freq_hz)

            print(f"FSK: Tuned from {current_freq_hz} Hz to {new_freq_hz} Hz (moved audio {clicked_freq:.0f} Hz to center {center_freq} Hz)")

        except Exception as e:
            print(f"Error tuning from spectrum click: {e}")
    
    def on_spectrum_resize(self, event):
        """Handle spectrum canvas resize."""
        # Redraw spectrum with new dimensions
        if self.spectrum_data is not None:
            self.draw_spectrum()
    
    def start_audio_processing(self):
        """Start periodic audio processing for spectrum display."""
        self.process_audio()
        # Schedule next update (20 FPS)
        if hasattr(self, 'window') and self.window.winfo_exists():
            self.window.after(50, self.start_audio_processing)
    
    def on_closing(self):
        """Handle window closing."""
        if self.running:
            self.stop_decoding()
        self.window.destroy()


def create_fsk_window(parent: tk.Tk, dxcluster_ws, radio_control) -> FSKExtension:
    """
    Create and return an FSK extension window.
    
    Args:
        parent: Parent window
        dxcluster_ws: DX cluster WebSocket connection
        radio_control: Radio control object
        
    Returns:
        FSKExtension instance
    """
    return FSKExtension(parent, dxcluster_ws, radio_control)
