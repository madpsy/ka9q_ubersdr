#!/usr/bin/env python3
"""
NAVTEX Extension Window for Python Radio Client
Replicates the JavaScript NAVTEX extension functionality
"""

import tkinter as tk
from tkinter import ttk, scrolledtext, filedialog, messagebox
import json
import time
from datetime import datetime
from typing import Optional, Dict, Callable
import struct


class NAVTEXExtension:
    """NAVTEX decoder extension window."""
    
    # NAVTEX station presets
    STATIONS = [
        ("-- Select Station --", ""),
        ("NAVTEX - MF", [
            ("518 kHz - International (100 Bd, 170 Hz)", "518000,usb,100,170"),
            ("490 kHz - National (100 Bd, 170 Hz)", "490000,usb,100,170"),
            ("4.210 MHz - Tropical (100 Bd, 170 Hz)", "4209500,usb,100,170"),
        ]),
        ("NAVTEX - HF", [
            ("4.210 MHz - HF NAVTEX (100 Bd, 170 Hz)", "4210000,usb,100,170"),
            ("6.314 MHz - HF NAVTEX (100 Bd, 170 Hz)", "6314000,usb,100,170"),
            ("8.417 MHz - HF NAVTEX (100 Bd, 170 Hz)", "8416500,usb,100,170"),
            ("12.579 MHz - HF NAVTEX (100 Bd, 170 Hz)", "12579000,usb,100,170"),
            ("16.807 MHz - HF NAVTEX (100 Bd, 170 Hz)", "16806500,usb,100,170"),
            ("19.681 MHz - HF NAVTEX (100 Bd, 170 Hz)", "19680500,usb,100,170"),
            ("22.376 MHz - HF NAVTEX (100 Bd, 170 Hz)", "22376000,usb,100,170"),
            ("26.101 MHz - HF NAVTEX (100 Bd, 170 Hz)", "26100500,usb,100,170"),
        ]),
        ("DSC - MF/HF", [
            ("2.188 MHz - DSC MF (100 Bd, 170 Hz)", "2187500,usb,100,170"),
            ("4.208 MHz - DSC 4 MHz (100 Bd, 170 Hz)", "4207500,usb,100,170"),
            ("6.312 MHz - DSC 6 MHz (100 Bd, 170 Hz)", "6312000,usb,100,170"),
            ("8.415 MHz - DSC 8 MHz (100 Bd, 170 Hz)", "8414500,usb,100,170"),
            ("12.577 MHz - DSC 12 MHz (100 Bd, 170 Hz)", "12577000,usb,100,170"),
            ("16.805 MHz - DSC 16 MHz (100 Bd, 170 Hz)", "16804500,usb,100,170"),
        ]),
    ]
    
    def __init__(self, parent: tk.Tk, dxcluster_ws, radio_control):
        """
        Initialize NAVTEX extension window.
        
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
        self.needs_timestamp = True
        self.console_lines = 25
        self.baud_error = 0.0
        
        # Configuration
        self.config = {
            'center_frequency': 500,
            'shift': 170,
            'baud_rate': 100,
            'inverted': False,
            'framing': '4/7',
            'encoding': 'CCIR476'
        }
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("📡 NAVTEX Decoder")
        self.window.geometry("900x700")
        self.window.protocol("WM_DELETE_WINDOW", self.on_closing)
        
        # Create UI
        self.create_widgets()
        
        # Setup WebSocket handler
        self.original_ws_handler = None
        
    def create_widgets(self):
        """Create UI widgets."""
        # Main frame
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        
        # Quick Tune section
        tune_frame = ttk.LabelFrame(main_frame, text="Quick Tune", padding="10")
        tune_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        ttk.Label(tune_frame, text="Station:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        
        self.station_var = tk.StringVar(value="")
        self.station_combo = ttk.Combobox(tune_frame, textvariable=self.station_var,
                                         state='readonly', width=50)
        self.station_combo.grid(row=0, column=1, sticky=(tk.W, tk.E))
        self.station_combo.bind('<<ComboboxSelected>>', lambda e: self.tune_to_station())
        
        # Populate stations dropdown
        self.populate_stations()
        
        tune_frame.columnconfigure(1, weight=1)
        
        # Status bar
        status_frame = ttk.Frame(main_frame)
        status_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        # Left side - status indicators
        left_frame = ttk.Frame(status_frame)
        left_frame.pack(side=tk.LEFT, fill=tk.X, expand=True)
        
        self.status_label = ttk.Label(left_frame, text="Stopped", 
                                     background='gray', foreground='white',
                                     padding=(5, 2), relief=tk.RAISED)
        self.status_label.pack(side=tk.LEFT, padx=(0, 10))
        
        ttk.Label(left_frame, text="Baud Error:").pack(side=tk.LEFT, padx=(0, 5))
        
        # Baud error bar (simplified - just show value)
        self.baud_error_label = ttk.Label(left_frame, text="0.0", width=6)
        self.baud_error_label.pack(side=tk.LEFT, padx=(0, 10))
        
        self.char_count_label = ttk.Label(left_frame, text="Chars: 0")
        self.char_count_label.pack(side=tk.LEFT)
        
        # Right side - control buttons
        right_frame = ttk.Frame(status_frame)
        right_frame.pack(side=tk.RIGHT)
        
        self.start_btn = ttk.Button(right_frame, text="Start", command=self.start_decoder)
        self.start_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        self.stop_btn = ttk.Button(right_frame, text="Stop", command=self.stop_decoder,
                                   state='disabled')
        self.stop_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        ttk.Button(right_frame, text="Clear", command=self.clear_console).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(right_frame, text="Save Text", command=self.save_text).pack(side=tk.LEFT)
        
        # Controls panel
        controls_frame = ttk.LabelFrame(main_frame, text="Configuration", padding="10")
        controls_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        # Create control fields in a grid
        row = 0
        col = 0
        
        # Center frequency
        ttk.Label(controls_frame, text="Center (Hz):").grid(row=row, column=col, sticky=tk.W, padx=(0, 5))
        self.center_freq_var = tk.StringVar(value="500")
        center_entry = ttk.Entry(controls_frame, textvariable=self.center_freq_var, width=10)
        center_entry.grid(row=row, column=col+1, sticky=tk.W, padx=(0, 15))
        
        # Shift
        col += 2
        ttk.Label(controls_frame, text="Shift (Hz):").grid(row=row, column=col, sticky=tk.W, padx=(0, 5))
        self.shift_var = tk.StringVar(value="170")
        shift_entry = ttk.Entry(controls_frame, textvariable=self.shift_var, width=10)
        shift_entry.grid(row=row, column=col+1, sticky=tk.W, padx=(0, 15))
        
        # Baud rate
        col += 2
        ttk.Label(controls_frame, text="Baud:").grid(row=row, column=col, sticky=tk.W, padx=(0, 5))
        self.baud_var = tk.StringVar(value="100")
        baud_entry = ttk.Entry(controls_frame, textvariable=self.baud_var, width=10)
        baud_entry.grid(row=row, column=col+1, sticky=tk.W, padx=(0, 15))
        
        # Encoding
        col += 2
        ttk.Label(controls_frame, text="Encoding:").grid(row=row, column=col, sticky=tk.W, padx=(0, 5))
        self.encoding_var = tk.StringVar(value="CCIR476")
        encoding_combo = ttk.Combobox(controls_frame, textvariable=self.encoding_var,
                                     values=["CCIR476"], state='readonly', width=12)
        encoding_combo.grid(row=row, column=col+1, sticky=tk.W, padx=(0, 15))
        
        # Second row
        row += 1
        col = 0
        
        # Inverted checkbox
        self.inverted_var = tk.BooleanVar(value=False)
        inverted_check = ttk.Checkbutton(controls_frame, text="Inverted", variable=self.inverted_var)
        inverted_check.grid(row=row, column=col, columnspan=2, sticky=tk.W, padx=(0, 15))
        
        # Auto-scroll checkbox
        col += 2
        self.auto_scroll_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(controls_frame, text="Auto-Scroll", variable=self.auto_scroll_var,
                       command=self.on_auto_scroll_changed).grid(row=row, column=col, columnspan=2, sticky=tk.W, padx=(0, 15))
        
        # Console lines
        col += 2
        ttk.Label(controls_frame, text="Console Lines:").grid(row=row, column=col, sticky=tk.W, padx=(0, 5))
        self.console_lines_var = tk.StringVar(value="25")
        console_lines_combo = ttk.Combobox(controls_frame, textvariable=self.console_lines_var,
                                          values=["10", "25", "50", "100"], state='readonly', width=8)
        console_lines_combo.grid(row=row, column=col+1, sticky=tk.W)
        console_lines_combo.bind('<<ComboboxSelected>>', lambda e: self.update_console_height())
        
        # Store config controls for enable/disable when running
        self.config_controls = [
            center_entry, shift_entry, baud_entry, encoding_combo, inverted_check
        ]
        
        # Text console
        console_frame = ttk.LabelFrame(main_frame, text="Decoded Text", padding="5")
        console_frame.grid(row=3, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        main_frame.rowconfigure(3, weight=1)
        
        # Scrolled text widget
        self.console_text = scrolledtext.ScrolledText(console_frame, wrap=tk.WORD,
                                                     font=('Courier New', 10),
                                                     bg='black', fg='#00ff00',
                                                     height=25)
        self.console_text.pack(fill=tk.BOTH, expand=True)
        
        # Help text
        help_frame = ttk.LabelFrame(main_frame, text="Help", padding="10")
        help_frame.grid(row=4, column=0, sticky=(tk.W, tk.E))
        
        help_text = ("NAVTEX Decoder - Decodes maritime safety information broadcasts\n"
                    "NAVTEX: Tune to 518 kHz (international) or 490 kHz (national) in USB mode. "
                    "Use 500 Hz center, 170 Hz shift, 100 baud.\n"
                    "The decoder uses CCIR476 forward error correction to recover text even with weak signals.")
        ttk.Label(help_frame, text=help_text, wraplength=850, justify=tk.LEFT).pack()
        
        main_frame.columnconfigure(0, weight=1)
        
    def populate_stations(self):
        """Populate the stations dropdown."""
        values = []
        self.station_map = {}
        
        for item in self.STATIONS:
            if len(item) == 2 and isinstance(item[1], str):
                # Simple entry
                values.append(item[0])
                self.station_map[item[0]] = item[1]
            elif len(item) == 2 and isinstance(item[1], list):
                # Group header
                values.append(f"--- {item[0]} ---")
                self.station_map[f"--- {item[0]} ---"] = ""
                # Group items
                for subitem in item[1]:
                    values.append(f"  {subitem[0]}")
                    self.station_map[f"  {subitem[0]}"] = subitem[1]
        
        self.station_combo['values'] = values
        if values:
            self.station_combo.current(0)
    
    def tune_to_station(self):
        """Tune to the selected station."""
        selected = self.station_var.get()
        if not selected or selected not in self.station_map:
            return
        
        value = self.station_map[selected]
        if not value:
            return
        
        # Parse: "frequency,mode,baud,shift"
        parts = value.split(',')
        if len(parts) != 4:
            return
        
        try:
            frequency = int(parts[0])
            mode = parts[1].upper()
            baud = int(parts[2])
            shift = int(parts[3])
            
            # Get center frequency
            center_hz = float(self.center_freq_var.get())
            
            # For USB mode, tune down by the center frequency
            dial_frequency = frequency - center_hz if mode.lower() == 'usb' else frequency
            
            # Update settings
            self.baud_var.set(str(baud))
            self.shift_var.set(str(shift))
            
            # Tune radio via the radio_control (which is the RadioGUI instance)
            if self.radio_control:
                # Set frequency in Hz using set_frequency_hz method
                self.radio_control.set_frequency_hz(dial_frequency)
                
                # Set mode using select_mode which properly updates everything
                self.radio_control.select_mode(mode)
                
                # Apply frequency if connected (skip auto mode to preserve our USB setting)
                if self.radio_control.connected:
                    self.radio_control.apply_frequency(skip_auto_mode=True)
                
            print(f"Tuned to: {selected} ({dial_frequency} Hz, {mode})")
            
        except Exception as e:
            print(f"Error tuning to station: {e}")
            import traceback
            traceback.print_exc()
    
    def update_config(self):
        """Update configuration from UI."""
        try:
            self.config['center_frequency'] = float(self.center_freq_var.get())
            self.config['shift'] = float(self.shift_var.get())
            self.config['baud_rate'] = float(self.baud_var.get())
            self.config['inverted'] = self.inverted_var.get()
            self.config['encoding'] = self.encoding_var.get()
            self.config['framing'] = '4/7'
        except ValueError as e:
            print(f"Error updating config: {e}")
    
    def start_decoder(self):
        """Start the NAVTEX decoder."""
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
                'extension_name': 'navtex',
                'params': self.config
            }
            
            self.dxcluster_ws.ws.send(json.dumps(attach_msg))
            
            # Setup binary message handler
            self.setup_binary_handler()
            
            # Update UI
            self.running = True
            self.status_label.config(text="Running", background='green')
            self.start_btn.config(state='disabled')
            self.stop_btn.config(state='normal')
            
            # Disable config controls
            for ctrl in self.config_controls:
                ctrl.config(state='disabled')
            
            print("NAVTEX decoder started")
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to start decoder: {e}")
            print(f"Error starting decoder: {e}")
    
    def stop_decoder(self):
        """Stop the NAVTEX decoder."""
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
            self.status_label.config(text="Stopped", background='gray')
            self.start_btn.config(state='normal')
            self.stop_btn.config(state='disabled')
            
            # Enable config controls
            for ctrl in self.config_controls:
                # Comboboxes use 'readonly', Entry and Checkbutton use 'normal'
                if isinstance(ctrl, ttk.Combobox):
                    ctrl.config(state='readonly')
                else:
                    ctrl.config(state='normal')
            
            print("NAVTEX decoder stopped")
            
        except Exception as e:
            print(f"Error stopping decoder: {e}")
    
    def setup_binary_handler(self):
        """Setup binary message handler for WebSocket."""
        # Store original handler
        if hasattr(self.dxcluster_ws, 'ws') and hasattr(self.dxcluster_ws.ws, 'on_message'):
            self.original_ws_handler = self.dxcluster_ws.ws.on_message
        
        # Create new handler that intercepts binary messages
        def binary_handler(ws, message):
            if isinstance(message, bytes):
                # Binary message - process as NAVTEX data
                self.handle_binary_message(message)
            else:
                # Text message - pass to original handler
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
            
            # Parse text length (big-endian uint32)
            text_length = struct.unpack('>I', data[9:13])[0]
            
            # Extract text
            text_data = data[13:13+text_length]
            text = text_data.decode('utf-8', errors='replace')
            
            # Display text
            self.display_text(text)
            
        elif msg_type == 0x02:
            # Baud error: [type:1][error:8]
            if len(data) < 9:
                return
            
            # Parse error (float64, big-endian)
            error = struct.unpack('>d', data[1:9])[0]
            
            # Update baud error display
            self.update_baud_error(error)
    
    def display_text(self, text: str):
        """Display decoded text in console."""
        # Process text character by character to add timestamps
        processed_text = ""
        
        for char in text:
            # Skip carriage returns entirely - they cause display issues
            if char == '\r':
                continue
            
            # Add timestamp at start of new line
            if self.needs_timestamp:
                timestamp = datetime.now().strftime("%H:%M:%S")
                processed_text += f"[{timestamp}] "
                self.needs_timestamp = False
            
            # Add the character
            processed_text += char
            
            # Mark that we need timestamp after line feed
            if char == '\n':
                self.needs_timestamp = True
        
        # Append to buffer and console
        self.text_buffer += processed_text
        self.char_count += len(text)
        
        # Update console
        self.console_text.insert(tk.END, processed_text)
        
        # Update character count
        self.char_count_label.config(text=f"Chars: {self.char_count}")
        
        # Auto-scroll
        if self.auto_scroll_var.get():
            self.console_text.see(tk.END)
    
    def update_baud_error(self, error: float):
        """Update baud error display."""
        self.baud_error = error
        self.baud_error_label.config(text=f"{error:.1f}")
    
    def clear_console(self):
        """Clear the console."""
        self.console_text.delete('1.0', tk.END)
        self.text_buffer = ""
        self.char_count = 0
        self.needs_timestamp = True
        self.char_count_label.config(text="Chars: 0")
    
    def save_text(self):
        """Save decoded text to file."""
        if not self.text_buffer:
            messagebox.showinfo("Info", "No text to save")
            return
        
        # Generate filename with timestamp
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        filename = filedialog.asksaveasfilename(
            defaultextension=".txt",
            initialfile=f"navtex_{timestamp}.txt",
            filetypes=[("Text files", "*.txt"), ("All files", "*.*")]
        )
        
        if filename:
            try:
                with open(filename, 'w', encoding='utf-8') as f:
                    f.write(self.text_buffer)
                messagebox.showinfo("Success", f"Text saved to {filename}")
            except Exception as e:
                messagebox.showerror("Error", f"Failed to save text: {e}")
    
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
    
    def on_closing(self):
        """Handle window closing."""
        if self.running:
            self.stop_decoder()
        self.window.destroy()


def create_navtex_window(parent: tk.Tk, dxcluster_ws, radio_control) -> NAVTEXExtension:
    """
    Create and return a NAVTEX extension window.
    
    Args:
        parent: Parent window
        dxcluster_ws: DX cluster WebSocket connection
        radio_control: Radio control object
        
    Returns:
        NAVTEXExtension instance
    """
    return NAVTEXExtension(parent, dxcluster_ws, radio_control)