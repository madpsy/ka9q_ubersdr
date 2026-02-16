#!/usr/bin/env python3
"""
FT8/FT4 Extension Window for Python Radio Client
Replicates the JavaScript FT8 extension functionality
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import json
import time
from datetime import datetime
from typing import Optional, Dict, List, Callable
import webbrowser


class FT8Extension:
    """FT8/FT4 decoder extension window."""
    
    # Quick tune frequencies
    FREQUENCIES = {
        'FT8 - Most Active': [
            ('7.074 MHz USB (40m FT8)', 7074000, 'usb', 'FT8'),
            ('14.074 MHz USB (20m FT8 - Primary)', 14074000, 'usb', 'FT8'),
            ('21.074 MHz USB (15m FT8)', 21074000, 'usb', 'FT8'),
            ('28.074 MHz USB (10m FT8)', 28074000, 'usb', 'FT8'),
        ],
        'FT4 - Fast Mode': [
            ('7.047.5 MHz USB (40m FT4)', 7047500, 'usb', 'FT4'),
            ('14.080 MHz USB (20m FT4)', 14080000, 'usb', 'FT4'),
            ('21.140 MHz USB (15m FT4)', 21140000, 'usb', 'FT4'),
            ('28.180 MHz USB (10m FT4)', 28180000, 'usb', 'FT4'),
        ],
        'Other FT8 Bands': [
            ('3.573 MHz USB (80m FT8)', 3573000, 'usb', 'FT8'),
            ('10.136 MHz USB (30m FT8)', 10136000, 'usb', 'FT8'),
            ('18.100 MHz USB (17m FT8)', 18100000, 'usb', 'FT8'),
            ('24.915 MHz USB (12m FT8)', 24915000, 'usb', 'FT8'),
            ('50.313 MHz USB (6m FT8)', 50313000, 'usb', 'FT8'),
        ]
    }
    
    def __init__(self, parent: tk.Tk, dxcluster_ws, radio_control):
        """
        Initialize FT8 extension window.
        
        Args:
            parent: Parent window
            dxcluster_ws: DX cluster WebSocket connection
            radio_control: Radio control object (for tuning)
        """
        self.parent = parent
        self.dxcluster_ws = dxcluster_ws
        self.radio_control = radio_control
        
        # Configuration
        self.config = {
            'protocol': 'FT8',
            'min_score': 10,
            'max_candidates': 100,
            'auto_clear': False,
            'show_cq_only': False,
            'show_latest_only': True,
            'show_spectrum': True
        }
        
        # State
        self.running = False
        self.messages = []  # List of decoded messages
        self.total_decoded = 0
        self.current_slot = 0
        self.slot_decoded = 0
        self.candidate_count = 0
        self.ldpc_failures = 0
        self.crc_failures = 0
        self.auto_scroll = True
        self.message_filter = ''
        
        # Sort state
        self.sort_column = None
        self.sort_direction = 'asc'
        
        # Cycle progress tracking
        self.cycle_progress_job = None
        self.protocol_display_job = None
        
        # Spectrum data
        self.spectrum_data = None
        self.spectrum_history = []
        self.history_timestamps = []
        self.sample_rate = 12000
        self.auto_level_window_seconds = 2.0
        
        # Callsign markers cache
        self.cached_callsigns = []
        self.last_cached_slot = None
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("📡 FT8/FT4 Decoder")
        self.window.geometry("1400x900")
        self.window.protocol("WM_DELETE_WINDOW", self.on_closing)
        
        # Create UI
        self.create_widgets()
        
        # Setup WebSocket handler
        self.original_ws_handler = None
        
        # Start audio processing loop for spectrum
        self.start_audio_processing()
        
    def create_widgets(self):
        """Create UI widgets."""
        # Main frame
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        
        # Frequency selector
        freq_frame = ttk.Frame(main_frame)
        freq_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        ttk.Label(freq_frame, text="Quick Tune:").pack(side=tk.LEFT, padx=(0, 5))
        self.freq_var = tk.StringVar()
        self.freq_combo = ttk.Combobox(freq_frame, textvariable=self.freq_var, state='readonly', width=50)
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
        self.status_badge.pack(side=tk.LEFT, padx=(0, 15))
        
        self.protocol_display = ttk.Label(left_frame, text="FT8", foreground='blue')
        self.protocol_display.pack(side=tk.LEFT, padx=(0, 15))
        
        self.slot_display = ttk.Label(left_frame, text="Slot: --")
        self.slot_display.pack(side=tk.LEFT, padx=(0, 15))
        
        self.sync_display = ttk.Label(left_frame, text="Sync: Waiting...", foreground='gray')
        self.sync_display.pack(side=tk.LEFT, padx=(0, 15))
        
        self.totals_display = ttk.Label(left_frame, text="Total: 0 | Slot: 0")
        self.totals_display.pack(side=tk.LEFT)
        
        # Right side - buttons
        right_frame = ttk.Frame(status_frame)
        right_frame.pack(side=tk.RIGHT)
        
        self.start_btn = ttk.Button(right_frame, text="Start", command=self.start_decoder)
        self.start_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        self.stop_btn = ttk.Button(right_frame, text="Stop", command=self.stop_decoder, state='disabled')
        self.stop_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        ttk.Button(right_frame, text="Clear", command=self.clear_messages).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(right_frame, text="Export", command=self.export_messages).pack(side=tk.LEFT)
        
        # Controls panel
        controls_frame = ttk.Frame(main_frame)
        controls_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        # Protocol selector
        ttk.Label(controls_frame, text="Protocol:").pack(side=tk.LEFT, padx=(0, 5))
        self.protocol_var = tk.StringVar(value='FT8')
        protocol_combo = ttk.Combobox(controls_frame, textvariable=self.protocol_var,
                                      values=['FT8', 'FT4'], state='readonly', width=10)
        protocol_combo.pack(side=tk.LEFT, padx=(0, 15))
        protocol_combo.bind('<<ComboboxSelected>>', lambda e: self.on_protocol_changed())
        
        # Checkboxes
        self.show_cq_only_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(controls_frame, text="CQ Only", variable=self.show_cq_only_var,
                       command=self.on_cq_only_changed).pack(side=tk.LEFT, padx=(0, 15))
        
        self.auto_clear_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(controls_frame, text="Auto-Clear", variable=self.auto_clear_var,
                       command=self.on_auto_clear_changed).pack(side=tk.LEFT, padx=(0, 15))
        
        self.auto_scroll_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(controls_frame, text="Auto-Scroll", variable=self.auto_scroll_var,
                       command=self.on_auto_scroll_changed).pack(side=tk.LEFT, padx=(0, 15))
        
        self.show_latest_only_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(controls_frame, text="Latest Cycle Only", variable=self.show_latest_only_var,
                       command=self.on_latest_only_changed).pack(side=tk.LEFT, padx=(0, 15))
        
        self.show_spectrum_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(controls_frame, text="Show Spectrum", variable=self.show_spectrum_var,
                       command=self.on_show_spectrum_changed).pack(side=tk.LEFT, padx=(0, 15))
        
        # Message filter
        ttk.Label(controls_frame, text="Filter:").pack(side=tk.LEFT, padx=(0, 5))
        self.filter_entry = ttk.Entry(controls_frame, width=15)
        self.filter_entry.pack(side=tk.LEFT, padx=(0, 15))
        self.filter_entry.bind('<KeyRelease>', lambda e: self.on_filter_changed())
        
        # Cycle progress
        progress_container = ttk.Frame(controls_frame, relief=tk.SUNKEN, borderwidth=1)
        progress_container.pack(side=tk.LEFT, fill=tk.X, expand=True)
        
        self.progress_canvas = tk.Canvas(progress_container, height=20, bg='#2c2c2c', highlightthickness=0)
        self.progress_canvas.pack(fill=tk.BOTH, expand=True)
        
        self.progress_bar = self.progress_canvas.create_rectangle(0, 0, 0, 20, fill='#4caf50', outline='')
        self.progress_text = self.progress_canvas.create_text(5, 10, text='0.0s', anchor=tk.W, fill='white',
                                                              font=('TkDefaultFont', 9))
        
        # Spectrum display
        self.spectrum_frame = ttk.LabelFrame(main_frame, text="Spectrum (0-3000 Hz)", padding="5")
        self.spectrum_frame.grid(row=3, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        self.spectrum_canvas = tk.Canvas(self.spectrum_frame, height=100, bg='#0a0a0a', highlightthickness=0)
        self.spectrum_canvas.pack(fill=tk.X, expand=True)
        
        # Message table with scrollbar
        table_frame = ttk.LabelFrame(main_frame, text="Decoded Messages", padding="5")
        table_frame.grid(row=4, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        main_frame.rowconfigure(4, weight=1)
        
        # Create Treeview for table
        columns = ('UTC', 'SNR', 'ΔT', 'Freq', 'Dist', 'Brg', 'Country', 'Cont', 'TX Call', 'Message', 'Slot')
        self.tree = ttk.Treeview(table_frame, columns=columns, show='headings', height=20)
        
        # Define column headings and widths
        col_widths = {'UTC': 80, 'SNR': 50, 'ΔT': 50, 'Freq': 60, 'Dist': 60, 'Brg': 50,
                     'Country': 100, 'Cont': 50, 'TX Call': 100, 'Message': 300, 'Slot': 50}
        
        for col in columns:
            self.tree.heading(col, text=col, command=lambda c=col: self.sort_by_column(c))
            self.tree.column(col, width=col_widths.get(col, 100), anchor=tk.W if col in ['Message', 'Country', 'TX Call'] else tk.CENTER)
        
        # Scrollbar
        scrollbar = ttk.Scrollbar(table_frame, orient=tk.VERTICAL, command=self.tree.yview)
        self.tree.configure(yscrollcommand=scrollbar.set)
        
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        # Bind double-click to open QRZ
        self.tree.bind('<Double-Button-1>', self.on_tree_double_click)
        
        # Help text
        help_frame = ttk.Frame(main_frame)
        help_frame.grid(row=5, column=0, sticky=(tk.W, tk.E))
        
        help_text = ("FT8/FT4 Decoder - Decodes weak signal digital modes. "
                    "FT8 uses 15-second time slots, FT4 uses 7.5-second slots. "
                    "Tune to FT8/FT4 frequencies in USB mode with 3000 Hz bandwidth. "
                    "Primary frequency: 14.074 MHz (20m FT8).")
        ttk.Label(help_frame, text=help_text, wraplength=1350, foreground='gray').pack()
        
        main_frame.columnconfigure(0, weight=1)
        
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
        
        name, frequency, mode, protocol = freq_data
        
        try:
            # Update protocol
            self.protocol_var.set(protocol)
            self.config['protocol'] = protocol
            self.update_protocol_display()
            
            # Tune radio
            self.radio_control.set_frequency_hz(frequency)
            self.radio_control.select_mode(mode)
            
            # Set bandwidth for FT8/FT4 (0 Hz low, 3200 Hz high)
            if hasattr(self.radio_control, 'set_bandwidth'):
                self.radio_control.set_bandwidth(0, 3200)
            
            # Apply frequency if connected (skip auto mode to preserve USB setting)
            if self.radio_control.connected:
                self.radio_control.apply_frequency(skip_auto_mode=True)
            
            print(f"FT8: Tuned to {name}")
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to tune: {e}")
            print(f"Error tuning to frequency: {e}")
    
    def on_protocol_changed(self):
        """Handle protocol selection change."""
        self.config['protocol'] = self.protocol_var.get()
        self.update_protocol_display()
        
        if self.running:
            # Restart with new protocol
            self.stop_decoder()
            self.window.after(100, self.start_decoder)
    
    def on_auto_clear_changed(self):
        """Handle auto-clear checkbox change."""
        self.config['auto_clear'] = self.auto_clear_var.get()
    
    def on_cq_only_changed(self):
        """Handle CQ only checkbox change."""
        self.config['show_cq_only'] = self.show_cq_only_var.get()
        self.filter_messages()
    
    def on_latest_only_changed(self):
        """Handle latest cycle only checkbox change."""
        self.config['show_latest_only'] = self.show_latest_only_var.get()
        self.filter_messages()
    
    def on_auto_scroll_changed(self):
        """Handle auto-scroll checkbox change."""
        self.auto_scroll = self.auto_scroll_var.get()
    
    def on_show_spectrum_changed(self):
        """Handle show spectrum checkbox change."""
        self.config['show_spectrum'] = self.show_spectrum_var.get()
        
        # Hide/show the spectrum frame
        if self.config['show_spectrum']:
            self.spectrum_frame.grid()
        else:
            self.spectrum_frame.grid_remove()
    
    def on_filter_changed(self):
        """Handle filter text change."""
        self.message_filter = self.filter_entry.get().lower()
        self.filter_messages()
    
    def start_decoder(self):
        """Start the FT8/FT4 decoder."""
        if self.running:
            return
        
        # Clear previous messages if auto-clear enabled
        if self.config['auto_clear']:
            self.clear_messages()
        
        # Attach to audio extension via WebSocket
        if not self.dxcluster_ws or not self.dxcluster_ws.is_connected():
            messagebox.showerror("Error", "WebSocket not connected")
            return
        
        try:
            # Send attach message
            attach_msg = {
                'type': 'audio_extension_attach',
                'extension_name': 'ft8',
                'params': {
                    'protocol': self.config['protocol'],
                    'min_score': self.config['min_score'],
                    'max_candidates': self.config['max_candidates']
                }
            }
            
            self.dxcluster_ws.ws.send(json.dumps(attach_msg))
            
            # Setup binary message handler
            self.setup_binary_handler()
            
            # Update UI
            self.running = True
            self.start_btn.config(state='disabled')
            self.stop_btn.config(state='normal')
            self.status_badge.config(text="Running", foreground='green')
            
            # Start cycle progress updates
            self.start_cycle_progress()
            self.start_protocol_display_updates()
            
            print(f"FT8: Decoder started ({self.config['protocol']})")
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to start decoder: {e}")
            print(f"Error starting decoder: {e}")
    
    def stop_decoder(self):
        """Stop the FT8/FT4 decoder."""
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
            
            # Stop cycle progress updates
            self.stop_cycle_progress()
            self.stop_protocol_display_updates()
            
            print("FT8: Decoder stopped")
            
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
        print("FT8: Binary message handler installed")
    
    def restore_binary_handler(self):
        """Restore original WebSocket handler."""
        if self.original_ws_handler and self.dxcluster_ws and hasattr(self.dxcluster_ws, 'ws'):
            self.dxcluster_ws.ws.on_message = self.original_ws_handler
            self.original_ws_handler = None
            print("FT8: Original message handler restored")
    
    def handle_binary_message(self, data: bytes):
        """Handle binary message from server (JSON-encoded decode results)."""
        try:
            # Parse JSON message from decoder
            message = json.loads(data.decode('utf-8'))
            
            # Add to messages array
            self.messages.insert(0, message)  # Insert at beginning
            self.total_decoded += 1
            self.slot_decoded += 1
            
            # Hard limit: Keep only the latest 1000 messages
            if len(self.messages) > 1000:
                self.messages = self.messages[:1000]
            
            # Update decode statistics from message
            if 'candidate_count' in message:
                self.candidate_count = message['candidate_count']
            if 'ldpc_failures' in message:
                self.ldpc_failures = message['ldpc_failures']
            if 'crc_failures' in message:
                self.crc_failures = message['crc_failures']
            # Track if we need to add message manually to table
            should_add_to_table = True

            
            # Update slot if changed
            if message.get('slot_number', 0) != self.current_slot:
                self.current_slot = message.get('slot_number', 0)
                self.slot_decoded = 1
                
                # Auto-clear old messages if enabled
                if self.config['auto_clear'] and len(self.messages) > 100:
                    self.messages = self.messages[:100]
                
                # If showing latest only, re-filter (which adds all messages including this one)
                if self.config['show_latest_only']:
                    self.filter_messages()
                    should_add_to_table = False  # Already added by filter_messages()
            
            # Update displays
            self.update_slot_display(message.get('slot_number', 0))
            self.update_sync_display(True)
            
            # Add to table only if not already added by filter_messages()
            if should_add_to_table:
                self.add_message_to_table(message)
            
            # Update counters
            self.update_counters()
            
        except Exception as error:
            print(f"FT8: Error parsing message: {error}")
    
    def add_message_to_table(self, message: Dict):
        """Add a decoded message to the table."""
        # Check filters
        should_show = True
        
        # Filter by latest cycle only
        if self.config['show_latest_only'] and self.current_slot > 0:
            if message.get('slot_number', 0) != self.current_slot:
                should_show = False
        
        # Filter by CQ only
        if should_show and self.config['show_cq_only']:
            if not message.get('message', '').startswith('CQ'):
                should_show = False
        
        # Filter by message text or country
        if should_show and self.message_filter:
            msg_text = message.get('message', '').lower()
            country = message.get('country', '').lower()
            if self.message_filter not in msg_text and self.message_filter not in country:
                should_show = False
        
        if not should_show:
            return
        
        # Format values
        utc = message.get('utc', '')
        snr = f"{message.get('snr', 0):.1f}"
        delta_t = f"{message.get('delta_t', 0):.1f}"
        freq = f"{message.get('frequency', 0):.0f}"
        
        dist = '-'
        if message.get('distance_km') is not None:
            dist = f"{message['distance_km']:.0f}"
        
        brg = '-'
        if message.get('bearing_deg') is not None:
            brg = f"{message['bearing_deg']:.0f}°"
        
        country = message.get('country', '-')
        continent = message.get('continent', '-')
        tx_call = message.get('tx_callsign', '-')
        msg_text = message.get('message', '')
        slot = str(message.get('slot_number', 0))
        
        # Insert at top of tree
        values = (utc, snr, delta_t, freq, dist, brg, country, continent, tx_call, msg_text, slot)
        item_id = self.tree.insert('', 0, values=values)
        
        # Color code SNR
        snr_val = message.get('snr', 0)
        if snr_val >= 0:
            self.tree.item(item_id, tags=('snr_positive',))
        elif snr_val >= -10:
            self.tree.item(item_id, tags=('snr_medium',))
        else:
            self.tree.item(item_id, tags=('snr_negative',))
        
        # Configure tags
        self.tree.tag_configure('snr_positive', foreground='#4caf50')
        self.tree.tag_configure('snr_medium', foreground='#ff9800')
        self.tree.tag_configure('snr_negative', foreground='#f44336')
        
        # Auto-scroll to top if enabled
        if self.auto_scroll:
            self.tree.see(item_id)
    
    def clear_messages(self):
        """Clear all messages."""
        self.messages = []
        self.total_decoded = 0
        self.slot_decoded = 0
        
        # Clear tree
        for item in self.tree.get_children():
            self.tree.delete(item)
        
        # Clear cached callsigns and markers in spectrum
        self.cached_callsigns = []
        self.last_cached_slot = None

        self.update_counters()
        print("FT8: Messages cleared")
    
    def filter_messages(self):
        """Filter messages based on current filter settings."""
        # Clear tree
        for item in self.tree.get_children():
            self.tree.delete(item)
        
        # Re-add filtered messages
        for message in reversed(self.messages):  # Reverse to maintain order
            should_show = True
            
            # Filter by latest cycle only
            if self.config['show_latest_only'] and self.current_slot > 0:
                if message.get('slot_number', 0) != self.current_slot:
                    should_show = False
            
            # Filter by CQ only
            if should_show and self.config['show_cq_only']:
                if not message.get('message', '').startswith('CQ'):
                    should_show = False
            
            # Filter by message text or country
            if should_show and self.message_filter:
                msg_text = message.get('message', '').lower()
                country = message.get('country', '').lower()
                if self.message_filter not in msg_text and self.message_filter not in country:
                    should_show = False
            
            if should_show:
                # Format and add to tree
                utc = message.get('utc', '')
                snr = f"{message.get('snr', 0):.1f}"
                delta_t = f"{message.get('delta_t', 0):.1f}"
                freq = f"{message.get('frequency', 0):.0f}"
                
                dist = '-'
                if message.get('distance_km') is not None:
                    dist = f"{message['distance_km']:.0f}"
                
                brg = '-'
                if message.get('bearing_deg') is not None:
                    brg = f"{message['bearing_deg']:.0f}°"
                
                country = message.get('country', '-')
                continent = message.get('continent', '-')
                tx_call = message.get('tx_callsign', '-')
                msg_text = message.get('message', '')
                slot = str(message.get('slot_number', 0))
                
                values = (utc, snr, delta_t, freq, dist, brg, country, continent, tx_call, msg_text, slot)
                item_id = self.tree.insert('', 'end', values=values)
                
                # Apply tags
                snr_val = message.get('snr', 0)
                if snr_val >= 0:
                    self.tree.item(item_id, tags=('snr_positive',))
                elif snr_val >= -10:
                    self.tree.item(item_id, tags=('snr_medium',))
                else:
                    self.tree.item(item_id, tags=('snr_negative',))
    
    def export_messages(self):
        """Export messages to CSV file."""
        if len(self.messages) == 0:
            messagebox.showinfo("Info", "No messages to export")
            return
        
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        filename = filedialog.asksaveasfilename(
            defaultextension=".csv",
            initialfile=f"ft8_log_{timestamp}.csv",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
        )
        
        if filename:
            try:
                with open(filename, 'w', encoding='utf-8') as f:
                    # Write header
                    f.write('UTC,SNR,DeltaT,Frequency,Distance_km,Bearing_deg,Country,Continent,TX_Callsign,Callsign,Locator,Message,Protocol,Slot\n')
                    
                    # Write data
                    for msg in self.messages:
                        dist = f"{msg['distance_km']:.1f}" if msg.get('distance_km') is not None else ''
                        brg = f"{msg['bearing_deg']:.1f}" if msg.get('bearing_deg') is not None else ''
                        country = msg.get('country', '')
                        continent = msg.get('continent', '')
                        tx_callsign = msg.get('tx_callsign', '')
                        callsign = msg.get('callsign', '')
                        locator = msg.get('locator', '')
                        
                        f.write(f"{msg.get('utc', '')},{msg.get('snr', 0)},{msg.get('delta_t', 0)},{msg.get('frequency', 0)},{dist},{brg},\"{country}\",\"{continent}\",\"{tx_callsign}\",\"{callsign}\",\"{locator}\",\"{msg.get('message', '')}\",{msg.get('protocol', '')},{msg.get('slot_number', 0)}\n")
                
                messagebox.showinfo("Success", f"Exported {len(self.messages)} messages to {filename}")
                print(f"FT8: Exported {len(self.messages)} messages to {filename}")
            except Exception as e:
                messagebox.showerror("Error", f"Failed to export: {e}")
                print(f"Error exporting messages: {e}")
    
    def sort_by_column(self, col):
        """Sort table by column."""
        # Toggle sort direction if clicking the same column
        if self.sort_column == col:
            self.sort_direction = 'desc' if self.sort_direction == 'asc' else 'asc'
        else:
            self.sort_column = col
            self.sort_direction = 'asc'
        
        # Get all items
        items = [(self.tree.set(item, col), item) for item in self.tree.get_children('')]
        
        # Sort items
        try:
            # Try numeric sort first
            items.sort(key=lambda x: float(x[0].replace('°', '').replace('-', '0') if x[0] != '-' else '0'),
                      reverse=(self.sort_direction == 'desc'))
        except ValueError:
            # Fall back to string sort
            items.sort(key=lambda x: x[0].lower(), reverse=(self.sort_direction == 'desc'))
        
        # Rearrange items in sorted order
        for index, (val, item) in enumerate(items):
            self.tree.move(item, '', index)
    
    def on_tree_double_click(self, event):
        """Handle double-click on tree item to open QRZ."""
        item = self.tree.selection()
        if not item:
            return
        
        # Get TX Call column value
        tx_call = self.tree.item(item[0], 'values')[8]  # TX Call is column 8
        
        if tx_call and tx_call != '-':
            url = f"https://www.qrz.com/db/{tx_call}"
            webbrowser.open(url)
            print(f"FT8: Opening QRZ for {tx_call}")
    
    def update_counters(self):
        """Update counter displays."""
        self.totals_display.config(text=f"Total: {len(self.messages)} | Slot: {self.slot_decoded}")
    
    def update_slot_display(self, slot_number: int):
        """Update slot display."""
        self.slot_display.config(text=f"Slot: {slot_number}")
    
    def update_sync_display(self, synced: bool):
        """Update sync display."""
        if synced:
            self.sync_display.config(text="Sync: OK", foreground='green')
        else:
            self.sync_display.config(text="Sync: Waiting...", foreground='gray')
    
    def update_protocol_display(self):
        """Update protocol display."""
        # Get current frequency and mode from radio
        try:
            freq_hz = self.radio_control.get_frequency_hz() if self.radio_control else 0
            freq_mhz = freq_hz / 1000000
            mode = self.radio_control.get_mode().upper() if self.radio_control else 'USB'
            
            self.protocol_display.config(text=f"{self.config['protocol']} | {freq_mhz:.3f} MHz {mode}")
        except:
            self.protocol_display.config(text=self.config['protocol'])
    
    def start_cycle_progress(self):
        """Start cycle progress updates."""
        self.stop_cycle_progress()
        self.update_cycle_progress()
    
    def stop_cycle_progress(self):
        """Stop cycle progress updates."""
        if self.cycle_progress_job:
            self.window.after_cancel(self.cycle_progress_job)
            self.cycle_progress_job = None
        
        # Reset progress bar
        canvas_width = self.progress_canvas.winfo_width()
        if canvas_width > 1:
            self.progress_canvas.coords(self.progress_bar, 0, 0, 0, 20)
            self.progress_canvas.itemconfig(self.progress_text, text='0.0s')
    
    def update_cycle_progress(self):
        """Update cycle progress bar."""
        if not self.running:
            return
        
        # Get cycle duration based on protocol
        cycle_duration = 7.5 if self.config['protocol'] == 'FT4' else 15.0
        
        # Get current time
        now = datetime.now()
        seconds = now.second + (now.microsecond / 1000000)
        
        # Calculate position within current cycle
        cycle_position = seconds % cycle_duration
        
        # Calculate percentage (0-100)
        percentage = (cycle_position / cycle_duration) * 100
        
        # Update progress bar
        canvas_width = self.progress_canvas.winfo_width()
        if canvas_width > 1:
            bar_width = (percentage / 100) * canvas_width
            self.progress_canvas.coords(self.progress_bar, 0, 0, bar_width, 20)
            self.progress_canvas.itemconfig(self.progress_text, text=f'{cycle_position:.1f}s')
        
        # Schedule next update (100ms)
        self.cycle_progress_job = self.window.after(100, self.update_cycle_progress)
    
    def start_protocol_display_updates(self):
        """Start protocol display updates."""
        self.stop_protocol_display_updates()
        self.update_protocol_display_periodic()
    
    def stop_protocol_display_updates(self):
        """Stop protocol display updates."""
        if self.protocol_display_job:
            self.window.after_cancel(self.protocol_display_job)
            self.protocol_display_job = None
    
    def update_protocol_display_periodic(self):
        """Update protocol display periodically."""
        if not self.running:
            return
        
        self.update_protocol_display()
        
        # Schedule next update (1 second)
        self.protocol_display_job = self.window.after(1000, self.update_protocol_display_periodic)
    
    def start_audio_processing(self):
        """Start periodic audio processing for spectrum display."""
        self.process_audio()
        # Schedule next update (20 FPS)
        if hasattr(self, 'window') and self.window.winfo_exists():
            self.window.after(50, self.start_audio_processing)
    
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
        """Draw spectrum visualization (0-3000 Hz)."""
        if self.spectrum_data is None:
            return
        
        import numpy as np
        
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
        
        # Use percentile-based auto-ranging with history
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
                p99 = np.percentile(valid_data, 99)  # Signal peaks
                
                # Set range with more headroom
                min_db = p5 - 10
                max_db = p99 + 15
                
                # Ensure reasonable range (at least 40 dB, max 80 dB)
                db_range = max_db - min_db
                if db_range < 40:
                    center = (max_db + min_db) / 2
                    min_db = center - 20
                    max_db = center + 20
                elif db_range > 80:
                    min_db = max_db - 80
            else:
                min_db = -80
                max_db = -20
        else:
            min_db = -80
            max_db = -20
        
        db_range = max_db - min_db
        
        # Draw dark background
        canvas.create_rectangle(0, 0, width, height, fill='#1a1a1a', outline='white')
        
        # Draw dB scale on left side
        for i in range(5):
            db = min_db + (i / 4) * db_range
            y = height - (i / 4) * height
            
            # Tick mark
            canvas.create_line(0, y, 5, y, fill='white')
            
            # Label
            label = f"{db:.0f}"
            canvas.create_text(8, y, text=label, fill='white', anchor=tk.W, font=('monospace', 8))
        
        # Draw spectrum line (only within display frequency range)
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
                    
                    # Calculate y with clamping
                    normalized = (db - min_db) / db_range
                    normalized = max(0.0, min(1.0, normalized))
                    y = height - (normalized * height)
                    points.extend([x, y])
            
            if len(points) >= 4:
                # Draw filled area
                fill_points = [0, height] + points + [width, height]
                canvas.create_polygon(fill_points, fill='#1e90ff', outline='', stipple='gray50')
                
                # Draw line
                canvas.create_line(points, fill='#00ff00', width=1)
        
        # Draw callsigns from latest matching odd/even cycle
        # FT8/FT4 stations alternate between odd and even slots
        if self.current_slot > 0:
            # Only recalculate callsign positions if the slot has changed
            if self.last_cached_slot != self.current_slot:
                current_parity = self.current_slot % 2  # 0 for even, 1 for odd
                
                # Find the most recent slot number with matching parity (excluding current slot)
                previous_matching_slot = None
                for msg in reversed(self.messages):
                    if msg.get('slot_number', 0) < self.current_slot and msg.get('slot_number', 0) % 2 == current_parity:
                        previous_matching_slot = msg.get('slot_number', 0)
                        break
                
                # Get messages only from that specific slot
                matching_slot_messages = []
                if previous_matching_slot is not None:
                    for msg in self.messages:
                        if (msg.get('slot_number', 0) == previous_matching_slot and
                            msg.get('tx_callsign') and
                            msg.get('tx_callsign') != '-' and
                            msg.get('frequency')):
                            matching_slot_messages.append(msg)
                    
                    # Sort by frequency
                    matching_slot_messages.sort(key=lambda m: m.get('frequency', 0))
                
                # Calculate positions for all callsigns
                used_positions = []
                min_horizontal_spacing = 50  # Minimum pixels between labels horizontally
                vertical_spacing = 14  # Vertical spacing between stacked labels
                
                self.cached_callsigns = []
                
                for msg in matching_slot_messages:
                    freq = msg.get('frequency', 0)
                    x = (freq / display_freq_max) * width
                    callsign = msg.get('tx_callsign', '')
                    
                    # Calculate text width
                    # Approximate width for monospace font
                    text_width = len(callsign) * 7
                    
                    # Find appropriate vertical position to avoid overlaps
                    y_offset = 15
                    found_position = False
                    
                    # Try different vertical positions until we find one that doesn't overlap
                    while not found_position and y_offset < height - 20:
                        overlaps = False
                        
                        # Check if this position overlaps with any existing label
                        for used_pos in used_positions:
                            horizontal_distance = abs(used_pos['x'] - x)
                            vertical_distance = abs(used_pos['y'] - y_offset)
                            
                            # Check for overlap
                            if horizontal_distance < min_horizontal_spacing and vertical_distance < vertical_spacing:
                                overlaps = True
                                break
                        
                        if not overlaps:
                            found_position = True
                        else:
                            y_offset += vertical_spacing
                    
                    # If we ran out of vertical space, wrap back to the top
                    if y_offset >= height - 20:
                        y_offset = 15
                    
                    # Cache this callsign's position
                    self.cached_callsigns.append({
                        'callsign': callsign,
                        'x': x,
                        'y': y_offset,
                        'text_width': text_width
                    })
                    
                    # Track this position
                    used_positions.append({'x': x, 'y': y_offset, 'width': text_width})
                
                self.last_cached_slot = self.current_slot
            
            # Draw the cached callsigns
            for cached in self.cached_callsigns:
                # Draw vertical line from bottom to label
                canvas.create_line(cached['x'], height - 15, cached['x'], cached['y'] + 10,
                                 fill='#4caf50', width=1)
                
                # Draw background rectangle
                canvas.create_rectangle(
                    cached['x'] - cached['text_width'] / 2 - 2,
                    cached['y'] - 10,
                    cached['x'] + cached['text_width'] / 2 + 2,
                    cached['y'] + 2,
                    fill='black', outline=''
                )
                
                # Draw callsign text
                canvas.create_text(cached['x'], cached['y'], text=cached['callsign'],
                                 fill='#4caf50', font=('monospace', 9))
        
        # Draw frequency scale at bottom
        for freq in range(0, display_freq_max + 1, 500):
            x = (freq / display_freq_max) * width
            canvas.create_text(x + 2, height - 5, text=f'{freq}Hz', fill='#ffffff', anchor='sw', font=('Courier', 8))
    
    def on_closing(self):
        """Handle window closing."""
        if self.running:
            self.stop_decoder()
        
        self.window.destroy()


def create_ft8_window(parent: tk.Tk, dxcluster_ws, radio_control) -> FT8Extension:
    """
    Create and return an FT8 extension window.
    
    Args:
        parent: Parent window
        dxcluster_ws: DX cluster WebSocket connection
        radio_control: Radio control object
        
    Returns:
        FT8Extension instance
    """
    return FT8Extension(parent, dxcluster_ws, radio_control)