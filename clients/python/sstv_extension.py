#!/usr/bin/env python3
"""
SSTV (Slow Scan Television) Extension Window for Python Radio Client
Replicates the JavaScript SSTV extension functionality
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import json
import time
from datetime import datetime
from typing import Optional, Dict, Callable, List
import struct
from PIL import Image, ImageTk
import numpy as np
import webbrowser


class SSTVExtension:
    """SSTV decoder extension window."""
    
    # Quick tune frequencies
    FREQUENCIES = {
        'HF - Most Active': [
            ('14.230 MHz USB (Primary SSTV)', 14230000, 'usb'),
            ('14.233 MHz USB (Alternative)', 14233000, 'usb'),
        ],
        '20m Band': [
            ('14.227 MHz USB', 14227000, 'usb'),
            ('14.230 MHz USB (Primary)', 14230000, 'usb'),
            ('14.233 MHz USB', 14233000, 'usb'),
            ('14.236 MHz USB', 14236000, 'usb'),
        ],
        '15m Band': [
            ('21.340 MHz USB', 21340000, 'usb'),
        ],
        '10m Band': [
            ('28.680 MHz USB', 28680000, 'usb'),
        ],
        '40m Band': [
            ('7.171 MHz USB', 7171000, 'usb'),
        ],
        '80m Band': [
            ('3.845 MHz USB (Evening)', 3845000, 'usb'),
        ]
    }
    
    # Binary message types
    MSG_IMAGE_LINE = 0x01
    MSG_MODE_DETECTED = 0x02
    MSG_STATUS = 0x03
    MSG_SYNC_DETECTED = 0x04
    MSG_COMPLETE = 0x05
    MSG_FSK_ID = 0x06
    MSG_IMAGE_START = 0x07
    MSG_REDRAW_START = 0x08
    MSG_TONE_FREQ = 0x09
    
    def __init__(self, parent: tk.Tk, dxcluster_ws, radio_control):
        """
        Initialize SSTV extension window.
        
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
        self.image_width = 320
        self.image_height = 256
        self.detected_mode = None
        self.fsk_callsign = None
        self.is_redrawing = False
        
        # Configuration
        self.config = {
            'auto_sync': True,      # Always enabled - automatic slant correction
            'decode_fsk_id': True,  # Always enabled - decode FSK callsigns
            'mmsstv_only': False,   # Always disabled - support all 47 modes
            'auto_save': False      # User configurable
        }
        
        # Image gallery
        self.images = []  # List of {array, canvas, photo, mode, callsign, timestamp, complete}
        self.current_image_index = None
        
        # Current image data
        self.current_canvas = None
        self.current_photo = None
        
        # Modal state
        self.modal_window = None
        self.modal_image_index = None
        self.modal_canvas = None
        self.modal_mode_label = None
        self.modal_callsign_label = None
        self.modal_time_label = None

        # Auto-save directory
        self.auto_save_directory = None
        
        # Tone frequency tracking
        self.tone_freq_history = []
        self.tone_freq_history_size = 5
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("📺 SSTV Decoder")
        self.window.geometry("1000x800")
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
        self.freq_var = tk.StringVar()
        self.freq_combo = ttk.Combobox(tune_frame, textvariable=self.freq_var, state='readonly', width=50)
        self.freq_combo.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.freq_combo.bind('<<ComboboxSelected>>', lambda e: self.tune_to_frequency())
        
        # Populate frequencies
        self.populate_frequencies()
        
        # Status bar
        status_frame = ttk.Frame(main_frame)
        status_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        # Left side - status
        left_frame = ttk.Frame(status_frame)
        left_frame.pack(side=tk.LEFT, fill=tk.X, expand=True)
        
        self.status_badge = ttk.Label(left_frame, text="Stopped", foreground='gray',
                                      font=('TkDefaultFont', 9, 'bold'))
        self.status_badge.pack(side=tk.LEFT, padx=(0, 20))
        
        self.mode_label = ttk.Label(left_frame, text="Waiting for signal...", foreground='blue')
        self.mode_label.pack(side=tk.LEFT, padx=(0, 20))
        
        self.callsign_label = ttk.Label(left_frame, text="", foreground='green',
                                        font=('TkDefaultFont', 9, 'bold'))
        self.callsign_label.pack(side=tk.LEFT)
        
        # Right side - buttons
        right_frame = ttk.Frame(status_frame)
        right_frame.pack(side=tk.RIGHT)
        
        self.start_btn = ttk.Button(right_frame, text="Start", command=self.start_decoder)
        self.start_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        self.stop_btn = ttk.Button(right_frame, text="Stop", command=self.stop_decoder, state='disabled')
        self.stop_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        ttk.Button(right_frame, text="Clear", command=self.clear_images).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(right_frame, text="Save Image", command=self.save_current_image).pack(side=tk.LEFT)
        
        # Info bar
        info_frame = ttk.Frame(main_frame)
        info_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        ttk.Label(info_frame, text="Status:").pack(side=tk.LEFT, padx=(0, 5))
        self.status_label = ttk.Label(info_frame, text="Ready", foreground='blue')
        self.status_label.pack(side=tk.LEFT, padx=(0, 20))
        
        ttk.Label(info_frame, text="Image:").pack(side=tk.LEFT, padx=(0, 5))
        self.image_size_label = ttk.Label(info_frame, text="--")
        self.image_size_label.pack(side=tk.LEFT, padx=(0, 20))
        
        ttk.Label(info_frame, text="Line:").pack(side=tk.LEFT, padx=(0, 5))
        self.line_count_label = ttk.Label(info_frame, text="--")
        self.line_count_label.pack(side=tk.LEFT, padx=(0, 20))
        
        # VIS Detector on the right
        self.tone_freq_label = ttk.Label(info_frame, text="--- Hz", foreground='gray')
        self.tone_freq_label.pack(side=tk.RIGHT)
        ttk.Label(info_frame, text="VIS Detector:").pack(side=tk.RIGHT, padx=(20, 5))
        
        # Controls panel
        controls_frame = ttk.Frame(main_frame)
        controls_frame.grid(row=3, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        self.auto_save_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(controls_frame, text="Auto-Save Images",
                       variable=self.auto_save_var,
                       command=self.on_auto_save_changed).pack(side=tk.LEFT, padx=(0, 5))

        # Label to show auto-save directory
        self.auto_save_path_label = ttk.Label(controls_frame, text="", foreground='gray')
        self.auto_save_path_label.pack(side=tk.LEFT, padx=(0, 15))

        self.auto_scroll_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(controls_frame, text="Auto-Scroll",
                       variable=self.auto_scroll_var).pack(side=tk.LEFT)
        
        # Image grid container with scrollbar
        grid_frame = ttk.LabelFrame(main_frame, text="Received Images", padding="5")
        grid_frame.grid(row=4, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        main_frame.rowconfigure(4, weight=1)
        
        # Create scrollable canvas for image grid
        self.grid_canvas = tk.Canvas(grid_frame, bg='#2c2c2c', highlightthickness=0)
        self.grid_scrollbar = ttk.Scrollbar(grid_frame, orient=tk.VERTICAL, 
                                           command=self.grid_canvas.yview)
        self.grid_canvas.configure(yscrollcommand=self.grid_scrollbar.set)
        
        self.grid_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.grid_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        # Frame inside canvas to hold image grid
        self.grid_frame = ttk.Frame(self.grid_canvas)
        self.grid_canvas_window = self.grid_canvas.create_window((0, 0), window=self.grid_frame, 
                                                                  anchor='nw')
        
        # Bind frame resize to update scroll region
        self.grid_frame.bind('<Configure>', lambda e: self.grid_canvas.configure(
            scrollregion=self.grid_canvas.bbox('all')))

        # Bind canvas resize to re-render grid with new column count
        self.grid_canvas.bind('<Configure>', self.on_grid_canvas_resize)
        self.last_grid_width = 0  # Track last width to avoid unnecessary re-renders

        # Bind mouse wheel scrolling
        self.grid_canvas.bind('<MouseWheel>', self.on_mousewheel)  # Windows/MacOS
        self.grid_canvas.bind('<Button-4>', self.on_mousewheel)    # Linux scroll up
        self.grid_canvas.bind('<Button-5>', self.on_mousewheel)    # Linux scroll down
        
        # Help text
        help_frame = ttk.Frame(main_frame)
        help_frame.grid(row=5, column=0, sticky=(tk.W, tk.E))
        
        help_text = ("SSTV Decoder - Receives Slow Scan Television images. "
                    "Common frequencies: 14.230 MHz (USB), 14.233 MHz (USB), 21.340 MHz (USB), 28.680 MHz (USB). "
                    "Supported Modes: 47 modes including Martin M1/M2, Scottie S1/S2, Robot 36, PD-120, and all MMSSTV modes. "
                    "The decoder automatically detects the VIS code, corrects image slant, and can decode FSK callsigns.")
        ttk.Label(help_frame, text=help_text, wraplength=950, foreground='gray').pack()
        
        main_frame.columnconfigure(0, weight=1)

    def on_mousewheel(self, event):
        """Handle mouse wheel scrolling."""
        if event.num == 5 or event.delta < 0:
            # Scroll down
            self.grid_canvas.yview_scroll(1, "units")
        elif event.num == 4 or event.delta > 0:
            # Scroll up
            self.grid_canvas.yview_scroll(-1, "units")

    def on_auto_save_changed(self):
        """Handle auto-save checkbox change."""
        if self.auto_save_var.get():
            # Checkbox was enabled - prompt for directory
            directory = filedialog.askdirectory(
                title="Select Directory for Auto-Saving SSTV Images",
                mustexist=True
            )
            if directory:
                self.auto_save_directory = directory
                self.config['auto_save'] = True
                # Show the directory path
                self.auto_save_path_label.config(text=f"→ {directory}")
                print(f"SSTV: Auto-save enabled, directory: {directory}")
            else:
                # User cancelled - uncheck the box
                self.auto_save_var.set(False)
                self.auto_save_directory = None
                self.config['auto_save'] = False
                self.auto_save_path_label.config(text="")
        else:
            # Checkbox was disabled
            self.auto_save_directory = None
            self.config['auto_save'] = False
            self.auto_save_path_label.config(text="")
            print("SSTV: Auto-save disabled")

    def open_qrz(self, callsign):
        """Open QRZ.com page for the given callsign."""
        url = f"https://qrz.com/db/{callsign}"
        webbrowser.open(url)
        print(f"SSTV: Opening QRZ.com for {callsign}")
        
    def populate_frequencies(self):
        """Populate frequency dropdown with grouped frequencies."""
        freqs = []
        for group_name, group_freqs in self.FREQUENCIES.items():
            for freq in group_freqs:
                freqs.append(freq[0])  # Just the name
        
        self.freq_combo['values'] = freqs
        
    def tune_to_frequency(self):
        """Tune to the selected frequency."""
        selection = self.freq_var.get()
        if not selection:
            return
        
        # Find the frequency data
        freq_data = None
        for group_freqs in self.FREQUENCIES.values():
            for freq in group_freqs:
                if freq[0] == selection:
                    freq_data = freq
                    break
            if freq_data:
                break
        
        if not freq_data:
            return
        
        name, frequency, mode = freq_data
        
        try:
            # Tune radio
            self.radio_control.set_frequency_hz(frequency)
            self.radio_control.select_mode(mode)
            
            # Apply frequency if connected
            if self.radio_control.connected:
                self.radio_control.apply_frequency()
            
            print(f"SSTV: Tuned to {name}")
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to tune: {e}")
            print(f"Error tuning to frequency: {e}")
    
    def update_config(self):
        """Update configuration from UI."""
        self.config['auto_save'] = self.auto_save_var.get()
        # auto_sync, decode_fsk_id, and mmsstv_only are always set to their default values
    
    def start_decoder(self):
        """Start the SSTV decoder."""
        if self.running:
            return
        
        # Update configuration
        self.update_config()
        
        # Clear previous images
        self.clear_images()
        
        # Attach to audio extension via WebSocket
        print(f"[SSTV] Checking WebSocket connection...")
        print(f"[SSTV] dxcluster_ws exists: {self.dxcluster_ws is not None}")
        if self.dxcluster_ws:
            print(f"[SSTV] dxcluster_ws.is_connected(): {self.dxcluster_ws.is_connected()}")
            print(f"[SSTV] dxcluster_ws.connected: {self.dxcluster_ws.connected}")
            print(f"[SSTV] dxcluster_ws.running: {self.dxcluster_ws.running}")
            print(f"[SSTV] dxcluster_ws.ws exists: {self.dxcluster_ws.ws is not None}")

        if not self.dxcluster_ws or not self.dxcluster_ws.is_connected():
            messagebox.showerror("Error", "WebSocket not connected")
            return
        
        try:
            # Send attach message
            attach_msg = {
                'type': 'audio_extension_attach',
                'extension_name': 'sstv',
                'params': self.config
            }
            
            self.dxcluster_ws.ws.send(json.dumps(attach_msg))
            
            # Setup binary message handler
            self.setup_binary_handler()
            
            # Update UI
            self.running = True
            self.start_btn.config(state='disabled')
            self.stop_btn.config(state='normal')
            self.status_badge.config(text="Running", foreground='green')
            
            print("SSTV decoder started - waiting for signal...")
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to start decoder: {e}")
            print(f"Error starting decoder: {e}")
    
    def stop_decoder(self):
        """Stop the SSTV decoder."""
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
            self.status_badge.config(text="Stopped", foreground='gray')
            
            print("SSTV decoder stopped")
            
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
        print("SSTV: Binary message handler installed")
    
    def restore_binary_handler(self):
        """Restore original WebSocket handler."""
        if self.original_ws_handler and self.dxcluster_ws and hasattr(self.dxcluster_ws, 'ws'):
            self.dxcluster_ws.ws.on_message = self.original_ws_handler
            self.original_ws_handler = None
            print("SSTV: Original message handler restored")
    
    def handle_binary_message(self, data: bytes):
        """Handle binary message from server."""
        if len(data) < 1:
            return
        
        msg_type = data[0]
        
        if msg_type == self.MSG_IMAGE_START:
            self.handle_image_start(data)
        elif msg_type == self.MSG_MODE_DETECTED:
            self.handle_mode_detected(data)
        elif msg_type == self.MSG_IMAGE_LINE:
            self.handle_image_line(data)
        elif msg_type == self.MSG_STATUS:
            self.handle_status(data)
        elif msg_type == self.MSG_SYNC_DETECTED:
            self.handle_sync_detected(data)
        elif msg_type == self.MSG_COMPLETE:
            self.handle_complete(data)
        elif msg_type == self.MSG_FSK_ID:
            self.handle_fsk_id(data)
        elif msg_type == self.MSG_REDRAW_START:
            self.handle_redraw_start()
        elif msg_type == self.MSG_TONE_FREQ:
            self.handle_tone_freq(data)
        else:
            print(f"SSTV: Unknown message type: {msg_type}")
    
    def handle_image_start(self, data: bytes):
        """Handle image start message: [type:1][width:4][height:4]"""
        if len(data) < 9:
            return
        
        width = struct.unpack('>I', data[1:5])[0]
        height = struct.unpack('>I', data[5:9])[0]
        
        print(f"SSTV: Image start: {width}x{height}")
        
        self.image_width = width
        self.image_height = height
        self.current_line = 0
        
        # Create new image
        self.create_new_image(width, height)

        # If modal is open and was showing the previous image, update to show new image
        if (self.modal_window and self.modal_window.winfo_exists() and
            self.modal_image_index == 0 and len(self.images) > 0):
            # New image is now at index 0, update modal to show it
            image_data = self.images[0]
            if self.modal_mode_label:
                self.modal_mode_label.config(text=f"Mode: {image_data['mode'] or 'Unknown'}")
            if self.modal_callsign_label:
                callsign_text = f"Callsign: {image_data['callsign']}" if image_data['callsign'] else "Callsign: None"
                self.modal_callsign_label.config(text=callsign_text)
            if self.modal_time_label:
                time_text = f"Time: {image_data['timestamp'].strftime('%Y-%m-%d %H:%M:%S')}"
                self.modal_time_label.config(text=time_text)

        # Update info display
        self.image_size_label.config(text=f"{width}x{height}")
        self.line_count_label.config(text=f"0/{height}")
        
        print(f"SSTV: New image {width}x{height}")
    
    def handle_mode_detected(self, data: bytes):
        """Handle mode detected message: [type:1][mode_idx:1][extended:1][name_len:1][name:len]"""
        if len(data) < 4:
            return
        
        mode_idx = data[1]
        is_extended = data[2] == 1
        name_len = data[3]
        
        if len(data) < 4 + name_len:
            return
        
        mode_name = data[4:4+name_len].decode('utf-8', errors='ignore')
        
        print(f"SSTV: Mode detected: {mode_name}" + (" (extended VIS)" if is_extended else ""))
        
        # Store mode for when image is created
        self.detected_mode = mode_name
        
        # Reset callsign when new VIS detected
        self.fsk_callsign = None
        
        # Update current image mode if not redrawing
        if (self.current_image_index is not None and
            self.current_image_index < len(self.images) and
            not self.is_redrawing):
            self.images[self.current_image_index]['mode'] = mode_name
            self.render_grid()

            # If modal is open and showing this image, update the modal mode display
            if (self.modal_window and self.modal_window.winfo_exists() and
                self.modal_image_index == self.current_image_index and
                self.modal_mode_label):
                self.modal_mode_label.config(text=f"Mode: {mode_name}")

        # Update mode display
        self.mode_label.config(text=mode_name)
        self.callsign_label.config(text="")

        # If modal is open, clear the callsign in modal too (new image starting)
        if (self.modal_window and self.modal_window.winfo_exists() and
            self.modal_image_index == self.current_image_index and
            self.modal_callsign_label):
            self.modal_callsign_label.config(text="Callsign: None")

        print(f"SSTV: Mode detected - {mode_name}")
    
    def handle_image_line(self, data: bytes):
        """Handle image line message: [type:1][line:4][width:4][rgb_data:width*3]"""
        if len(data) < 9:
            return
        
        line = struct.unpack('>I', data[1:5])[0]
        width = struct.unpack('>I', data[5:9])[0]
        rgb_data = data[9:]
        
        if len(rgb_data) != width * 3:
            print(f"SSTV: RGB data size mismatch: {len(rgb_data)} vs {width * 3}")
            return
        
        if self.current_image_index is None or self.current_image_index >= len(self.images):
            print("SSTV: No current image for line data")
            return
        
        if line >= self.image_height:
            print(f"SSTV: Line number exceeds image height: {line} >= {self.image_height}")
            return
        
        # Convert RGB data to PIL Image line
        line_array = np.frombuffer(rgb_data, dtype=np.uint8).reshape(1, width, 3)
        
        # Update the canvas array
        image_data = self.images[self.current_image_index]
        image_data['array'][line:line+1, :, :] = line_array
        
        self.current_line = line + 1
        
        # Update display every 10 lines or on last line
        if line % 10 == 0 or line == self.image_height - 1:
            self.update_current_image_display()
        
        # Update progress
        if not self.is_redrawing:
            progress = int((line / self.image_height) * 100)
            self.status_label.config(text=f"Decoding: {progress}%")
        
        # Update line count
        self.line_count_label.config(text=f"{line}/{self.image_height}")
    
    def handle_status(self, data: bytes):
        """Handle status message: [type:1][code:1][msg_len:2][message:len]"""
        if len(data) < 4:
            return
        
        status_code = data[1]
        msg_len = struct.unpack('>H', data[2:4])[0]
        
        if len(data) < 4 + msg_len:
            return
        
        message = data[4:4+msg_len].decode('utf-8', errors='ignore')
        
        print(f"SSTV: Status: {message}")
        self.status_label.config(text=message)
    
    def handle_sync_detected(self, data: bytes):
        """Handle sync detected message: [type:1][quality:1]"""
        if len(data) < 2:
            return
        
        quality = data[1]
        print(f"SSTV: Sync detected, quality: {quality}")
    
    def handle_complete(self, data: bytes):
        """Handle complete message: [type:1][total_lines:4]"""
        if len(data) < 5:
            return
        
        total_lines = struct.unpack('>I', data[1:5])[0]
        
        print(f"SSTV: Image complete, total lines: {total_lines}, isRedrawing: {self.is_redrawing}")
        
        # Mark current image as complete
        if self.current_image_index is not None and self.current_image_index < len(self.images):
            self.images[self.current_image_index]['complete'] = True
            self.render_grid()
        
        print(f"SSTV: Image complete ({total_lines} lines)")
        
        # Auto-save if enabled
        if self.config['auto_save'] and self.auto_save_directory:
            self.auto_save_current_image()
        
        # Update status
        self.status_label.config(text=f"Complete: {total_lines} lines decoded")
        
        # Reset to waiting after 2 seconds
        self.window.after(2000, self.reset_to_waiting)
        
        # Reset redraw flag
        self.is_redrawing = False
    
    def handle_fsk_id(self, data: bytes):
        """Handle FSK ID message: [type:1][len:1][callsign:len]"""
        if len(data) < 2:
            return

        callsign_len = data[1]

        if len(data) < 2 + callsign_len:
            return

        callsign = data[2:2+callsign_len].decode('utf-8', errors='ignore')

        print(f"SSTV: FSK callsign: {callsign}")

        self.fsk_callsign = callsign

        # Update current image callsign
        if self.current_image_index is not None and self.current_image_index < len(self.images):
            self.images[self.current_image_index]['callsign'] = callsign
            self.render_grid()

            # If modal is open and showing this image, update the modal callsign display
            if (self.modal_window and self.modal_window.winfo_exists() and
                self.modal_image_index == self.current_image_index and
                self.modal_callsign_label):
                self.modal_callsign_label.config(text=f"Callsign: {callsign}")

        # Update callsign display
        self.callsign_label.config(text=callsign)

        print(f"SSTV: Callsign decoded - {callsign}")
    
    def handle_redraw_start(self):
        """Handle redraw start message."""
        print("SSTV: Redraw start - corrected image incoming")
        self.is_redrawing = True
        self.current_line = 0
        self.status_label.config(text="Redrawing with slant correction...")
    
    def handle_tone_freq(self, data: bytes):
        """Handle tone frequency message: [type:1][freq:4] (freq in Hz * 10)"""
        if len(data) < 5:
            return
        
        freq_times_10 = struct.unpack('>I', data[1:5])[0]
        freq = freq_times_10 / 10.0
        
        # Add to history for smoothing
        self.tone_freq_history.append(freq)
        if len(self.tone_freq_history) > self.tone_freq_history_size:
            self.tone_freq_history.pop(0)
        
        # Calculate smoothed average
        avg_freq = sum(self.tone_freq_history) / len(self.tone_freq_history)
        
        # Update frequency display
        if avg_freq > 0:
            self.tone_freq_label.config(text=f"{int(avg_freq)} Hz")
            # Color code based on proximity to 1900 Hz
            diff = abs(avg_freq - 1900)
            if diff < 50:
                self.tone_freq_label.config(foreground='#4aff4a')  # Green - close to VIS leader
            elif diff < 200:
                self.tone_freq_label.config(foreground='#ffaa4a')  # Orange - nearby
            else:
                self.tone_freq_label.config(foreground='#4a9eff')  # Blue - far
        else:
            self.tone_freq_label.config(text="--- Hz", foreground='gray')
    
    def reset_to_waiting(self):
        """Reset status to waiting for next signal."""
        if self.running:
            self.status_label.config(text="Waiting for signal...")
            self.image_size_label.config(text="--")
            self.line_count_label.config(text="--")
    
    def create_new_image(self, width: int, height: int):
        """Create a new image in the gallery."""
        # Create numpy array for image data
        image_array = np.zeros((height, width, 3), dtype=np.uint8)
        
        image_data = {
            'array': image_array,
            'canvas': None,  # Will be created when rendering
            'photo': None,   # Will be created when rendering
            'canvas_image': None,  # Canvas image ID
            'mode': self.detected_mode or None,
            'callsign': self.fsk_callsign or None,
            'timestamp': datetime.now(),
            'complete': False
        }
        
        # Insert at beginning of array (top-left position)
        self.images.insert(0, image_data)
        self.current_image_index = 0
        self.current_canvas = None
        
        self.render_grid()
        
        print(f"SSTV: Created new image in grid: {width}x{height}, mode: {image_data['mode']}")
    
    def update_current_image_display(self):
        """Update only the current image's display without rebuilding the grid."""
        if self.current_image_index is None or self.current_image_index >= len(self.images):
            return
        
        image_data = self.images[self.current_image_index]
        
        # Convert numpy array to PIL Image
        pil_image = Image.fromarray(image_data['array'], 'RGB')
        
        # Resize for display (max 320 width)
        display_width = 320
        aspect_ratio = pil_image.height / pil_image.width
        display_height = int(display_width * aspect_ratio)
        pil_image = pil_image.resize((display_width, display_height), Image.NEAREST)
        
        # Convert to PhotoImage
        photo = ImageTk.PhotoImage(pil_image)
        image_data['photo'] = photo

        # Update canvas if it exists
        if image_data['canvas'] and image_data['canvas_image']:
            image_data['canvas'].itemconfig(image_data['canvas_image'], image=photo)

        # If modal is open and showing the current image, update it too
        if self.modal_window and self.modal_window.winfo_exists() and self.modal_image_index == self.current_image_index:
            self.update_modal_image()

    def update_modal_image(self):
        """Update the modal window with the current image data."""
        if not self.modal_canvas or not self.modal_window or not self.modal_window.winfo_exists():
            return

        if self.modal_image_index is None or self.modal_image_index >= len(self.images):
            return

        image_data = self.images[self.modal_image_index]

        # Get canvas size
        canvas_width = self.modal_canvas.winfo_width()
        canvas_height = self.modal_canvas.winfo_height()

        # Skip if canvas not yet rendered
        if canvas_width <= 1 or canvas_height <= 1:
            return

        # Convert numpy array to PIL Image
        pil_image = Image.fromarray(image_data['array'], 'RGB')

        # Calculate scaling to fit canvas while maintaining aspect ratio
        img_width = pil_image.width
        img_height = pil_image.height

        # Calculate scale factors for width and height
        scale_w = canvas_width / img_width
        scale_h = canvas_height / img_height

        # Use the smaller scale to ensure image fits entirely
        scale = min(scale_w, scale_h)

        # Calculate new dimensions
        new_width = int(img_width * scale)
        new_height = int(img_height * scale)

        # Resize image to fit canvas
        pil_image = pil_image.resize((new_width, new_height), Image.NEAREST)

        # Convert to PhotoImage
        photo = ImageTk.PhotoImage(pil_image)

        # Store reference to prevent garbage collection
        self.modal_canvas.image = photo

        # Update the canvas - center the image
        self.modal_canvas.delete('all')
        x_offset = (canvas_width - new_width) // 2
        y_offset = (canvas_height - new_height) // 2
        self.modal_canvas.create_image(x_offset, y_offset, anchor=tk.NW, image=photo)
    
    def render_grid(self):
        """Render the image grid."""
        # Clear grid
        for widget in self.grid_frame.winfo_children():
            widget.destroy()

        # Calculate columns based on available width
        # Each image is ~320px wide + 10px padding = 330px per image
        try:
            grid_width = self.grid_canvas.winfo_width()
            if grid_width <= 1:  # Not yet rendered
                grid_width = 1000  # Default width
            cols = max(1, grid_width // 330)
        except:
            cols = 3  # Fallback to 3 columns

        # Render all images in a grid
        for idx, image_data in enumerate(self.images):
            row = idx // cols
            col = idx % cols

            # Create frame for this image
            item_frame = ttk.Frame(self.grid_frame, relief=tk.RAISED, borderwidth=2)
            item_frame.grid(row=row, column=col, padx=5, pady=5, sticky=(tk.N, tk.S, tk.E, tk.W))
            
            # Add decoding indicator if current and not complete
            if idx == self.current_image_index and not image_data['complete']:
                item_frame.config(relief=tk.SUNKEN, borderwidth=3)
            
            # Convert numpy array to PIL Image
            pil_image = Image.fromarray(image_data['array'], 'RGB')
            
            # Resize for display (max 320 width)
            display_width = 320
            aspect_ratio = pil_image.height / pil_image.width
            display_height = int(display_width * aspect_ratio)
            pil_image = pil_image.resize((display_width, display_height), Image.NEAREST)
            
            # Convert to PhotoImage
            photo = ImageTk.PhotoImage(pil_image)
            image_data['photo'] = photo
            
            # Create canvas for image
            canvas = tk.Canvas(item_frame, width=display_width, height=display_height,
                             bg='black', highlightthickness=0)
            canvas.pack()
            
            # Draw image on canvas
            canvas_image = canvas.create_image(0, 0, anchor=tk.NW, image=photo)
            image_data['canvas'] = canvas
            image_data['canvas_image'] = canvas_image
            
            # Add info overlay - single horizontal line: time | callsign | mode
            info_frame = ttk.Frame(item_frame)
            info_frame.pack(fill=tk.X, padx=5, pady=5)
            
            # Left side - time
            time_str = image_data['timestamp'].strftime('%H:%M:%S')
            ttk.Label(info_frame, text=time_str, foreground='gray').pack(side=tk.LEFT)
            
            # Middle - callsign (if present) - clickable
            if image_data['callsign']:
                callsign_label = ttk.Label(info_frame, text=image_data['callsign'],
                                          font=('TkDefaultFont', 9, 'bold'),
                                          foreground='green', cursor='hand2')
                callsign_label.pack(side=tk.LEFT, padx=(10, 0))
                # Make clickable
                callsign = image_data['callsign']
                callsign_label.bind('<Button-1>', lambda e, cs=callsign: self.open_qrz(cs))
            
            # Right side - mode
            if image_data['mode']:
                ttk.Label(info_frame, text=image_data['mode'],
                         font=('TkDefaultFont', 9, 'bold'),
                         foreground='blue').pack(side=tk.RIGHT)
            
            # Click handler to show enlarged view
            canvas.bind('<Button-1>', lambda e, img=image_data, i=idx: self.show_enlarged_image(img, i))
        
        # Auto-scroll to top if enabled
        if self.auto_scroll_var.get():
            self.grid_canvas.yview_moveto(0)
    
    def on_grid_canvas_resize(self, event):
        """Handle grid canvas resize to re-render with appropriate column count."""
        new_width = event.width
        # Only re-render if width changed significantly (more than 50px to avoid flicker)
        if abs(new_width - self.last_grid_width) > 50:
            self.last_grid_width = new_width
            if len(self.images) > 0:
                self.render_grid()

    def show_enlarged_image(self, image_data: Dict, image_index: int):
        """Show enlarged view of an image in a modal window."""
        # Close existing modal if open
        if self.modal_window and self.modal_window.winfo_exists():
            self.modal_window.destroy()

        self.modal_image_index = image_index

        # Create modal window
        self.modal_window = tk.Toplevel(self.window)
        self.modal_window.title(f"SSTV Image - {image_data['mode'] or 'Unknown'}")
        self.modal_window.geometry("800x700")

        # Main frame
        modal_frame = ttk.Frame(self.modal_window, padding="10")
        modal_frame.pack(fill=tk.BOTH, expand=True)

        # Info bar
        info_bar = ttk.Frame(modal_frame)
        info_bar.pack(fill=tk.X, pady=(0, 10))

        mode_text = f"Mode: {image_data['mode'] or 'Unknown'}"
        self.modal_mode_label = ttk.Label(info_bar, text=mode_text, font=('TkDefaultFont', 10, 'bold'))
        self.modal_mode_label.pack(side=tk.LEFT, padx=(0, 20))

        callsign_text = f"Callsign: {image_data['callsign']}" if image_data['callsign'] else "Callsign: None"
        self.modal_callsign_label = ttk.Label(info_bar, text=callsign_text, font=('TkDefaultFont', 10, 'bold'),
                                              foreground='green', cursor='hand2' if image_data['callsign'] else '')
        self.modal_callsign_label.pack(side=tk.LEFT, padx=(0, 20))
        
        # Make clickable if callsign exists
        if image_data['callsign']:
            self.modal_callsign_label.bind('<Button-1>', lambda e, cs=image_data['callsign']: self.open_qrz(cs))

        time_text = f"Time: {image_data['timestamp'].strftime('%Y-%m-%d %H:%M:%S')}"
        self.modal_time_label = ttk.Label(info_bar, text=time_text)
        self.modal_time_label.pack(side=tk.LEFT)

        # Canvas for enlarged image
        self.modal_canvas = tk.Canvas(modal_frame, bg='black', highlightthickness=0)
        self.modal_canvas.pack(fill=tk.BOTH, expand=True, pady=(0, 10))

        # Wait for canvas to be rendered to get its size, then draw image
        self.modal_window.update_idletasks()
        self.update_modal_image()

        # Bind canvas resize to update image scaling
        self.modal_canvas.bind('<Configure>', lambda e: self.update_modal_image())
        
        # Buttons
        button_frame = ttk.Frame(modal_frame)
        button_frame.pack(fill=tk.X)
        
        ttk.Button(button_frame, text="Save Image",
                  command=lambda: self.save_specific_image(image_index)).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(button_frame, text="Close",
                  command=self.modal_window.destroy).pack(side=tk.LEFT)
    
    def clear_images(self):
        """Clear all images from the gallery."""
        print("SSTV: Clearing all images")
        
        self.images = []
        self.current_canvas = None
        self.current_image_index = None
        self.current_line = 0
        self.detected_mode = None
        self.fsk_callsign = None
        
        # Clear displays
        self.mode_label.config(text="Waiting for signal...")
        self.callsign_label.config(text="")
        self.status_label.config(text="Ready")
        
        # Re-render empty grid
        self.render_grid()
    
    def auto_save_current_image(self):
        """Automatically save the current image to the configured directory."""
        if len(self.images) == 0 or self.current_image_index is None:
            print("SSTV: No image to auto-save")
            return

        if not self.auto_save_directory:
            print("SSTV: No auto-save directory configured")
            return

        image_index = self.current_image_index
        if image_index < 0 or image_index >= len(self.images):
            print(f"SSTV: Invalid image index: {image_index}")
            return

        image_data = self.images[image_index]

        # Generate filename
        timestamp = image_data['timestamp'].strftime("%Y-%m-%d_%H-%M-%S")
        mode_name = image_data['mode'] or 'unknown'
        callsign = f"_{image_data['callsign']}" if image_data['callsign'] else ''
        filename = f"sstv_{mode_name}{callsign}_{timestamp}.png"

        # Build full path
        import os
        save_path = os.path.join(self.auto_save_directory, filename)

        try:
            # Convert numpy array to PIL Image
            pil_image = Image.fromarray(image_data['array'], 'RGB')
            pil_image.save(save_path)
            print(f"SSTV: Auto-saved image as {save_path}")
        except Exception as e:
            print(f"SSTV: Error auto-saving image: {e}")

    def save_current_image(self):
        """Save the current (most recent) image."""
        if len(self.images) == 0 or self.current_image_index is None:
            messagebox.showinfo("Info", "No image to save")
            return

        self.save_specific_image(self.current_image_index)
    
    def save_specific_image(self, image_index: int):
        """Save a specific image by index."""
        if image_index < 0 or image_index >= len(self.images):
            print(f"SSTV: Invalid image index: {image_index}")
            return
        
        image_data = self.images[image_index]
        
        # Generate filename
        timestamp = image_data['timestamp'].strftime("%Y-%m-%d_%H-%M-%S")
        mode_name = image_data['mode'] or 'unknown'
        callsign = f"_{image_data['callsign']}" if image_data['callsign'] else ''
        filename = f"sstv_{mode_name}{callsign}_{timestamp}.png"
        
        # Ask for save location
        save_path = filedialog.asksaveasfilename(
            defaultextension=".png",
            initialfile=filename,
            filetypes=[("PNG files", "*.png"), ("JPEG files", "*.jpg"), ("All files", "*.*")]
        )
        
        if save_path:
            try:
                # Convert numpy array to PIL Image
                pil_image = Image.fromarray(image_data['array'], 'RGB')
                pil_image.save(save_path)
                messagebox.showinfo("Success", f"Image saved to {save_path}")
                print(f"SSTV: Image saved as {save_path}")
            except Exception as e:
                messagebox.showerror("Error", f"Failed to save image: {e}")
                print(f"Error saving image: {e}")
    
    def on_closing(self):
        """Handle window closing."""
        if self.running:
            self.stop_decoder()

        # Close modal if open
        if self.modal_window and self.modal_window.winfo_exists():
            self.modal_window.destroy()

        # Clear modal references
        self.modal_window = None
        self.modal_image_index = None
        self.modal_canvas = None
        self.modal_mode_label = None
        self.modal_callsign_label = None
        self.modal_time_label = None

        self.window.destroy()


def create_sstv_window(parent: tk.Tk, dxcluster_ws, radio_control) -> SSTVExtension:
    """
    Create and return an SSTV extension window.
    
    Args:
        parent: Parent window
        dxcluster_ws: DX cluster WebSocket connection
        radio_control: Radio control object
        
    Returns:
        SSTVExtension instance
    """
    return SSTVExtension(parent, dxcluster_ws, radio_control)