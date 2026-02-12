#!/usr/bin/env python3
"""
WEFAX (Weather Fax) Extension Window for Python Radio Client
Replicates the JavaScript WEFAX extension functionality
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import json
import time
from datetime import datetime
from typing import Optional, Dict, Callable
import struct
from PIL import Image, ImageTk
import numpy as np


class WEFAXExtension:
    """WEFAX decoder extension window."""
    
    # Quick tune stations
    STATIONS = {
        'North America': [
            ('NMG New Orleans - 4.318 MHz (120 LPM)', 4317900, 'usb', 120),
            ('NMG New Orleans - 8.504 MHz (120 LPM)', 8503900, 'usb', 120),
            ('NMG New Orleans - 12.790 MHz (120 LPM)', 12789900, 'usb', 120),
            ('NMG New Orleans - 17.146 MHz (120 LPM)', 17146400, 'usb', 120),
            ('NMF Boston - 4.235 MHz (120 LPM)', 4235000, 'usb', 120),
            ('NMF Boston - 6.341 MHz (120 LPM)', 6340500, 'usb', 120),
            ('NMF Boston - 9.110 MHz (120 LPM)', 9110000, 'usb', 120),
            ('NMF Boston - 12.750 MHz (120 LPM)', 12750000, 'usb', 120),
        ],
        'Europe': [
            ('DDH47 Germany - 3.855 MHz (120 LPM)', 3855000, 'usb', 120),
            ('DDH47 Germany - 7.880 MHz (120 LPM)', 7880000, 'usb', 120),
            ('DDH47 Germany - 13.883 MHz (120 LPM)', 13882500, 'usb', 120),
            ('GYA UK - 2.619 MHz (120 LPM)', 2618500, 'usb', 120),
            ('GYA UK - 4.610 MHz (120 LPM)', 4610000, 'usb', 120),
            ('GYA UK - 8.040 MHz (120 LPM)', 8040000, 'usb', 120),
            ('GYA UK - 11.087 MHz (120 LPM)', 11086500, 'usb', 120),
        ],
        'Asia/Pacific': [
            ('JMH Japan - 3.623 MHz (120 LPM)', 3622500, 'usb', 120),
            ('JMH Japan - 7.795 MHz (120 LPM)', 7795000, 'usb', 120),
            ('JMH Japan - 9.970 MHz (120 LPM)', 9970000, 'usb', 120),
            ('JMH Japan - 13.598 MHz (120 LPM)', 13597500, 'usb', 120),
            ('NMO Hawaii - 10.865 MHz (120 LPM)', 10865000, 'usb', 120),
            ('NMO Hawaii - 13.862 MHz (120 LPM)', 13861500, 'usb', 120),
        ]
    }
    
    def __init__(self, parent: tk.Tk, dxcluster_ws, radio_control):
        """
        Initialize WEFAX extension window.
        
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
        self.current_line = 0
        self.image_width = 1809
        self.image_height = 0
        self.max_height = 4000
        self.auto_scroll = True
        self.auto_download = True
        
        # Configuration
        self.config = {
            'lpm': 120,
            'carrier': 1900,
            'deviation': 400,
            'image_width': 1809,
            'bandwidth': 1,
            'use_phasing': True,
            'auto_stop': True,
            'auto_start': True
        }
        
        # Image data
        self.image_array = None
        self.photo_image = None
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("📠 WEFAX Decoder")
        self.window.geometry("900x800")
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
        
        # Quick tune selector
        tune_frame = ttk.Frame(main_frame)
        tune_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        ttk.Label(tune_frame, text="Quick Tune:").pack(side=tk.LEFT, padx=(0, 5))
        self.station_var = tk.StringVar()
        self.station_combo = ttk.Combobox(tune_frame, textvariable=self.station_var, state='readonly', width=50)
        self.station_combo.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.station_combo.bind('<<ComboboxSelected>>', lambda e: self.tune_to_station())
        
        # Populate stations
        self.populate_stations()
        
        # Status bar
        status_frame = ttk.Frame(main_frame)
        status_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        # Left side - status
        left_frame = ttk.Frame(status_frame)
        left_frame.pack(side=tk.LEFT, fill=tk.X, expand=True)
        
        self.status_label = ttk.Label(left_frame, text="Stopped", foreground='gray')
        self.status_label.pack(side=tk.LEFT, padx=(0, 20))
        
        self.led_label = ttk.Label(left_frame, text="● Waiting", foreground='gray')
        self.led_label.pack(side=tk.LEFT, padx=(0, 20))
        
        self.line_count_label = ttk.Label(left_frame, text="Lines: 0")
        self.line_count_label.pack(side=tk.LEFT, padx=(0, 10))
        
        self.image_size_label = ttk.Label(left_frame, text="Size: 0x0")
        self.image_size_label.pack(side=tk.LEFT)
        
        # Right side - buttons
        right_frame = ttk.Frame(status_frame)
        right_frame.pack(side=tk.RIGHT)
        
        self.start_btn = ttk.Button(right_frame, text="Start", command=self.start_decoder)
        self.start_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        self.stop_btn = ttk.Button(right_frame, text="Stop", command=self.stop_decoder, state='disabled')
        self.stop_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        ttk.Button(right_frame, text="Clear", command=self.clear_image).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(right_frame, text="Save Image", command=self.save_image).pack(side=tk.LEFT)
        
        # Controls panel
        controls_frame = ttk.LabelFrame(main_frame, text="Configuration", padding="10")
        controls_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        # Row 1
        row1 = ttk.Frame(controls_frame)
        row1.pack(fill=tk.X, pady=(0, 5))
        
        ttk.Label(row1, text="LPM:").pack(side=tk.LEFT, padx=(0, 5))
        self.lpm_var = tk.StringVar(value="120")
        lpm_combo = ttk.Combobox(row1, textvariable=self.lpm_var, values=["60", "90", "120", "240"],
                                 state='readonly', width=8)
        lpm_combo.pack(side=tk.LEFT, padx=(0, 15))
        
        ttk.Label(row1, text="Carrier (Hz):").pack(side=tk.LEFT, padx=(0, 5))
        self.carrier_var = tk.StringVar(value="1900")
        carrier_entry = ttk.Entry(row1, textvariable=self.carrier_var, width=10)
        carrier_entry.pack(side=tk.LEFT, padx=(0, 15))
        
        ttk.Label(row1, text="Deviation (Hz):").pack(side=tk.LEFT, padx=(0, 5))
        self.deviation_var = tk.StringVar(value="400")
        deviation_entry = ttk.Entry(row1, textvariable=self.deviation_var, width=10)
        deviation_entry.pack(side=tk.LEFT, padx=(0, 15))
        
        ttk.Label(row1, text="Width (px):").pack(side=tk.LEFT, padx=(0, 5))
        self.width_var = tk.StringVar(value="1809")
        width_entry = ttk.Entry(row1, textvariable=self.width_var, width=10)
        width_entry.pack(side=tk.LEFT, padx=(0, 15))
        
        ttk.Label(row1, text="Bandwidth:").pack(side=tk.LEFT, padx=(0, 5))
        self.bandwidth_var = tk.StringVar(value="1 (Middle)")
        bandwidth_combo = ttk.Combobox(row1, textvariable=self.bandwidth_var,
                                       values=["0 (Narrow)", "1 (Middle)", "2 (Wide)"],
                                       state='readonly', width=12)
        bandwidth_combo.pack(side=tk.LEFT)
        
        # Row 2 - checkboxes
        row2 = ttk.Frame(controls_frame)
        row2.pack(fill=tk.X)
        
        self.use_phasing_var = tk.BooleanVar(value=True)
        use_phasing_check = ttk.Checkbutton(row2, text="Use Phasing", variable=self.use_phasing_var)
        use_phasing_check.pack(side=tk.LEFT, padx=(0, 15))
        
        self.auto_stop_var = tk.BooleanVar(value=True)
        auto_stop_check = ttk.Checkbutton(row2, text="Auto-Stop", variable=self.auto_stop_var)
        auto_stop_check.pack(side=tk.LEFT, padx=(0, 15))
        
        self.auto_start_var = tk.BooleanVar(value=True)
        auto_start_check = ttk.Checkbutton(row2, text="Auto-Start", variable=self.auto_start_var)
        auto_start_check.pack(side=tk.LEFT, padx=(0, 15))
        
        self.auto_download_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(row2, text="Auto-Download", variable=self.auto_download_var,
                       command=self.on_auto_download_changed).pack(side=tk.LEFT, padx=(0, 15))
        
        self.auto_scroll_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(row2, text="Auto-Scroll", variable=self.auto_scroll_var,
                       command=self.on_auto_scroll_changed).pack(side=tk.LEFT)
        
        # Store config controls for enable/disable when running
        self.config_controls = [
            lpm_combo, bandwidth_combo, carrier_entry, deviation_entry, width_entry,
            use_phasing_check, auto_stop_check, auto_start_check
        ]
        
        # Canvas container with scrollbar
        canvas_frame = ttk.LabelFrame(main_frame, text="Received Image", padding="5")
        canvas_frame.grid(row=3, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        main_frame.rowconfigure(3, weight=1)
        
        # Create scrollable canvas
        self.canvas_container = tk.Frame(canvas_frame, bg='black')
        self.canvas_container.pack(fill=tk.BOTH, expand=True)
        
        self.scrollbar = ttk.Scrollbar(self.canvas_container, orient=tk.VERTICAL)
        self.scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        self.canvas = tk.Canvas(self.canvas_container, bg='black', highlightthickness=0,
                               yscrollcommand=self.scrollbar.set)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        self.scrollbar.config(command=self.canvas.yview)
        
        # Help text
        help_frame = ttk.Frame(main_frame)
        help_frame.grid(row=4, column=0, sticky=(tk.W, tk.E))
        
        help_text = ("WEFAX Decoder - Receives weather fax transmissions. "
                    "Tune to a WEFAX frequency in USB mode. "
                    "Adjust carrier and deviation to match the signal. "
                    "Common settings: 1900 Hz carrier, 400 Hz deviation.")
        ttk.Label(help_frame, text=help_text, wraplength=850, foreground='gray').pack()
        
        main_frame.columnconfigure(0, weight=1)
        
        # Initialize image
        self.init_image()
        
    def populate_stations(self):
        """Populate station dropdown with grouped stations."""
        stations = []
        for group_name, group_stations in self.STATIONS.items():
            for station in group_stations:
                stations.append(station[0])  # Just the name
        
        self.station_combo['values'] = stations
        
    def tune_to_station(self):
        """Tune to the selected station."""
        selection = self.station_var.get()
        if not selection:
            return
        
        # Find the station data
        station_data = None
        for group_stations in self.STATIONS.values():
            for station in group_stations:
                if station[0] == selection:
                    station_data = station
                    break
            if station_data:
                break
        
        if not station_data:
            return
        
        name, frequency, mode, lpm = station_data
        
        try:
            # Get carrier frequency
            carrier_hz = float(self.carrier_var.get())
            
            # For USB mode, tune down by the carrier frequency
            dial_frequency = frequency - int(carrier_hz) if mode.lower() == 'usb' else frequency
            
            # Tune radio
            self.radio_control.set_frequency_hz(dial_frequency)
            self.radio_control.select_mode(mode)
            
            # Apply frequency if connected (skip auto mode to preserve USB setting)
            if self.radio_control.connected:
                self.radio_control.apply_frequency(skip_auto_mode=True)
            
            # Update LPM setting
            self.lpm_var.set(str(lpm))
            
            print(f"WEFAX: Tuned to {name}")
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to tune: {e}")
            print(f"Error tuning to station: {e}")
    
    def update_config(self):
        """Update configuration from UI."""
        try:
            self.config['lpm'] = int(self.lpm_var.get())
            self.config['carrier'] = float(self.carrier_var.get())
            self.config['deviation'] = float(self.deviation_var.get())
            self.config['image_width'] = int(self.width_var.get())
            # Extract just the number from bandwidth string (handles both "1" and "1 (Middle)")
            bw_str = self.bandwidth_var.get()
            if bw_str:
                # Split on space and take first part to get the number
                self.config['bandwidth'] = int(bw_str.split()[0])
            else:
                self.config['bandwidth'] = 1
            self.config['use_phasing'] = self.use_phasing_var.get()
            self.config['auto_stop'] = self.auto_stop_var.get()
            self.config['auto_start'] = self.auto_start_var.get()
        except ValueError as e:
            print(f"Error updating config: {e}")
    
    def start_decoder(self):
        """Start the WEFAX decoder."""
        if self.running:
            return
        
        # Update configuration
        self.update_config()
        
        # Reset canvas if width changed
        new_width = self.config['image_width']
        if new_width != self.image_width:
            self.image_width = new_width
            self.init_image()
        
        # Attach to audio extension via WebSocket
        if not self.dxcluster_ws or not self.dxcluster_ws.is_connected():
            messagebox.showerror("Error", "WebSocket not connected")
            return
        
        try:
            # Send attach message
            attach_msg = {
                'type': 'audio_extension_attach',
                'extension_name': 'wefax',
                'params': self.config
            }
            
            self.dxcluster_ws.ws.send(json.dumps(attach_msg))
            
            # Setup binary message handler
            self.setup_binary_handler()
            
            # Update UI
            self.running = True
            self.start_btn.config(state='disabled')
            self.stop_btn.config(state='normal')
            self.status_label.config(text="Running", foreground='green')
            
            # Show waiting message if auto-start enabled
            if self.config['auto_start']:
                self.led_label.config(text="● Waiting for START", foreground='orange')
            else:
                self.led_label.config(text="● Receiving", foreground='green')
            
            # Disable config controls
            for ctrl in self.config_controls:
                ctrl.config(state='disabled')
            
            print("WEFAX decoder started")
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to start decoder: {e}")
            print(f"Error starting decoder: {e}")
    
    def stop_decoder(self):
        """Stop the WEFAX decoder."""
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
            self.start_btn.config(state='normal')
            self.stop_btn.config(state='disabled')
            self.status_label.config(text="Stopped", foreground='gray')
            self.led_label.config(text="● Stopped", foreground='gray')
            
            # Enable config controls
            for ctrl in self.config_controls:
                # Comboboxes use 'readonly', Entry and Checkbutton use 'normal'
                if isinstance(ctrl, ttk.Combobox):
                    ctrl.config(state='readonly')
                else:
                    ctrl.config(state='normal')
            
            print("WEFAX decoder stopped")
            
        except Exception as e:
            print(f"Error stopping decoder: {e}")
    
    def setup_binary_handler(self):
        """Setup binary message handler for WebSocket."""
        if not self.dxcluster_ws or not hasattr(self.dxcluster_ws, 'ws'):
            return
        
        # Store original handler
        self.original_ws_handler = self.dxcluster_ws.ws.on_message
        
        # Create new handler
        def binary_handler(ws, message):
            if isinstance(message, bytes):
                # Binary message - handle it
                self.handle_binary_message(message)
            else:
                # Text message - pass to original handler
                if self.original_ws_handler:
                    self.original_ws_handler(ws, message)
        
        self.dxcluster_ws.ws.on_message = binary_handler
        print("WEFAX: Binary message handler installed")
    
    def restore_binary_handler(self):
        """Restore original WebSocket handler."""
        if self.original_ws_handler and self.dxcluster_ws and hasattr(self.dxcluster_ws, 'ws'):
            self.dxcluster_ws.ws.on_message = self.original_ws_handler
            self.original_ws_handler = None
            print("WEFAX: Original message handler restored")
    
    def handle_binary_message(self, data: bytes):
        """Handle binary message from server.
        
        Binary protocol:
        - type 0x01: image line [type:1][line_number:4][width:4][pixel_data:width]
        - type 0x02: START signal [type:1]
        - type 0x03: STOP signal [type:1]
        """
        if len(data) < 1:
            return
        
        msg_type = data[0]
        
        if msg_type == 0x01:
            # Image line
            if len(data) < 9:
                return
            
            # Parse line number (big-endian uint32)
            line_number = struct.unpack('>I', data[1:5])[0]
            
            # Parse width (big-endian uint32)
            width = struct.unpack('>I', data[5:9])[0]
            
            # Extract pixel data
            pixel_data = data[9:]
            
            if len(pixel_data) != width:
                print(f"WEFAX: Width mismatch: {len(pixel_data)} vs {width}")
                return
            
            # Render the line
            self.render_image_line(line_number, pixel_data)
            
        elif msg_type == 0x02:
            # START signal
            print("WEFAX: START signal received")
            self.led_label.config(text="● Receiving", foreground='green')
            
        elif msg_type == 0x03:
            # STOP signal
            print("WEFAX: STOP signal received")
            self.led_label.config(text="● Stopped", foreground='orange')
            
            # Auto-download if enabled and we have enough lines
            if self.auto_download and self.current_line > 50:
                print("WEFAX: Auto-downloading completed transmission")
                self.save_image()
            
            # Show waiting message if auto-start enabled
            if self.config['auto_start']:
                self.led_label.config(text="● Waiting for START", foreground='orange')
    
    def init_image(self):
        """Initialize image array and canvas."""
        self.image_height = 100  # Start with small height
        self.current_line = 0
        self.image_array = np.zeros((self.image_height, self.image_width, 3), dtype=np.uint8)
        self.update_canvas()
        
    def render_image_line(self, line_number: int, pixel_data: bytes):
        """Render a line of image data.
        
        Args:
            line_number: Line number (0-based)
            pixel_data: Grayscale pixel data (one byte per pixel)
        """
        # Detect new transmission (line reset)
        if line_number < self.current_line - 10:
            print(f"WEFAX: New transmission detected (line reset from {self.current_line} to {line_number})")
            self.clear_image()
        
        # Grow array if needed
        if line_number >= self.image_height:
            new_height = min(line_number + 100, self.max_height)
            self.grow_image(new_height)
        
        # Convert pixel data to numpy array
        pixels = np.frombuffer(pixel_data, dtype=np.uint8)
        
        # Ensure we don't exceed image width
        pixels = pixels[:self.image_width]
        
        # Fill line with grayscale data (RGB all same value)
        self.image_array[line_number, :len(pixels), 0] = pixels
        self.image_array[line_number, :len(pixels), 1] = pixels
        self.image_array[line_number, :len(pixels), 2] = pixels
        
        # Update current line
        self.current_line = max(self.current_line, line_number + 1)
        
        # Update display every 10 lines for performance
        if line_number % 10 == 0:
            self.update_canvas()
            self.update_status()
    
    def grow_image(self, new_height: int):
        """Grow image array to new height."""
        if new_height <= self.image_height:
            return
        
        new_array = np.zeros((new_height, self.image_width, 3), dtype=np.uint8)
        new_array[:self.image_height] = self.image_array
        self.image_array = new_array
        self.image_height = new_height
        print(f"WEFAX: Grew image to {self.image_width}x{self.image_height}")
    
    def update_canvas(self):
        """Update canvas with current image."""
        if self.image_array is None:
            return
        
        # Create PIL image from array (only up to current line)
        display_height = max(self.current_line, 1)
        img_data = self.image_array[:display_height]
        
        pil_image = Image.fromarray(img_data, mode='RGB')
        self.photo_image = ImageTk.PhotoImage(pil_image)
        
        # Update canvas
        self.canvas.delete('all')
        self.canvas.create_image(0, 0, anchor=tk.NW, image=self.photo_image)
        self.canvas.config(scrollregion=(0, 0, self.image_width, display_height))
        
        # Auto-scroll to bottom
        if self.auto_scroll:
            self.canvas.yview_moveto(1.0)
    
    def update_status(self):
        """Update status labels."""
        self.line_count_label.config(text=f"Lines: {self.current_line}")
        self.image_size_label.config(text=f"Size: {self.image_width}x{self.current_line}")
    
    def clear_image(self):
        """Clear the image."""
        self.init_image()
        self.update_status()
        print("WEFAX: Image cleared")
    
    def save_image(self):
        """Save the current image to file."""
        if self.current_line == 0:
            messagebox.showinfo("Info", "No image data to save")
            return
        
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        filename = filedialog.asksaveasfilename(
            defaultextension=".png",
            initialfile=f"wefax_{timestamp}.png",
            filetypes=[("PNG files", "*.png"), ("JPEG files", "*.jpg"), ("All files", "*.*")]
        )
        
        if filename:
            try:
                # Create image from array (only up to current line)
                img_data = self.image_array[:self.current_line]
                pil_image = Image.fromarray(img_data, mode='RGB')
                pil_image.save(filename)
                messagebox.showinfo("Success", f"Image saved to {filename}")
                print(f"WEFAX: Image saved to {filename}")
            except Exception as e:
                messagebox.showerror("Error", f"Failed to save image: {e}")
    
    def on_auto_download_changed(self):
        """Handle auto-download checkbox change."""
        self.auto_download = self.auto_download_var.get()
    
    def on_auto_scroll_changed(self):
        """Handle auto-scroll checkbox change."""
        self.auto_scroll = self.auto_scroll_var.get()
    
    def on_closing(self):
        """Handle window closing."""
        if self.running:
            self.stop_decoder()
        self.window.destroy()


def create_wefax_window(parent: tk.Tk, dxcluster_ws, radio_control) -> WEFAXExtension:
    """
    Create and return a WEFAX extension window.
    
    Args:
        parent: Parent window
        dxcluster_ws: DX cluster WebSocket connection
        radio_control: Radio control object
        
    Returns:
        WEFAXExtension instance
    """
    return WEFAXExtension(parent, dxcluster_ws, radio_control)
