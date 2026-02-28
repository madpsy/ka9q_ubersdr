#!/usr/bin/env python3
"""
Whisper Speech-to-Text Extension Window for Python Radio Client
Replicates the JavaScript Whisper extension functionality
"""

import tkinter as tk
from tkinter import ttk, scrolledtext, filedialog, messagebox
import json
import time
from datetime import datetime
from typing import Optional, Dict, Callable
import struct


class WhisperExtension:
    """Whisper speech-to-text decoder extension window."""
    
    def __init__(self, parent: tk.Tk, dxcluster_ws, radio_control):
        """
        Initialize Whisper extension window.
        
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
        self.transcript = []  # Completed segments only
        self.last_segment = None  # Current incomplete segment being refined
        self.session_start_time = None
        self.last_update_time = None
        self.auto_scroll = True
        self.show_timestamps = False
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("🎤 Speech-to-Text")
        self.window.geometry("700x600")
        self.window.protocol("WM_DELETE_WINDOW", self.on_closing)
        
        # Create UI
        self.create_widgets()
        
        # Setup WebSocket handler
        self.original_ws_handler = None
        
        # Start update timer
        self.update_timer_id = None
        
    def create_widgets(self):
        """Create UI widgets."""
        # Main frame
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        
        # Status bar
        status_frame = ttk.Frame(main_frame)
        status_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        status_frame.columnconfigure(1, weight=1)
        
        ttk.Label(status_frame, text="Status:").grid(row=0, column=0, padx=(0, 5))
        self.status_label = ttk.Label(status_frame, text="Idle", foreground="gray")
        self.status_label.grid(row=0, column=1, sticky=tk.W)
        
        ttk.Label(status_frame, text="Server:").grid(row=0, column=2, padx=(20, 5))
        self.server_status_label = ttk.Label(status_frame, text="Not connected", foreground="gray")
        self.server_status_label.grid(row=0, column=3, sticky=tk.W)
        
        # Controls frame
        controls_frame = ttk.Frame(main_frame)
        controls_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        controls_frame.columnconfigure(5, weight=1)
        
        # Auto-scroll checkbox
        self.auto_scroll_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(controls_frame, text="Auto-scroll", 
                       variable=self.auto_scroll_var,
                       command=self.on_auto_scroll_changed).grid(row=0, column=0, padx=(0, 15))
        
        # Show timestamps checkbox
        self.show_timestamps_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(controls_frame, text="Show timestamps", 
                       variable=self.show_timestamps_var,
                       command=self.on_show_timestamps_changed).grid(row=0, column=1, padx=(0, 15))
        
        # Control buttons
        self.start_button = ttk.Button(controls_frame, text="Start", command=self.start_decoder)
        self.start_button.grid(row=0, column=2, padx=(0, 5))
        
        self.stop_button = ttk.Button(controls_frame, text="Stop", command=self.stop_decoder, state=tk.DISABLED)
        self.stop_button.grid(row=0, column=3, padx=(0, 5))
        
        ttk.Button(controls_frame, text="Clear", command=self.clear_transcription).grid(row=0, column=4, padx=(0, 15))
        
        # Last update time (right-aligned)
        self.last_update_label = ttk.Label(controls_frame, text="--", foreground="gray", font=("Courier", 9))
        self.last_update_label.grid(row=0, column=5, sticky=tk.E)
        
        # Transcription display frame
        trans_frame = ttk.LabelFrame(main_frame, text="Transcription", padding="10")
        trans_frame.grid(row=2, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        main_frame.rowconfigure(2, weight=1)
        
        # Action buttons in header
        actions_frame = ttk.Frame(trans_frame)
        actions_frame.pack(side=tk.TOP, fill=tk.X, pady=(0, 5))
        
        ttk.Button(actions_frame, text="📋 Copy", command=self.copy_to_clipboard).pack(side=tk.RIGHT, padx=(5, 0))
        ttk.Button(actions_frame, text="💾 Save", command=self.save_transcription).pack(side=tk.RIGHT)
        
        # Transcription text area
        self.transcription_text = scrolledtext.ScrolledText(
            trans_frame,
            wrap=tk.WORD,
            width=70,
            height=20,
            font=("Consolas", 10),
            bg="#2a2a2a",
            fg="#e0e0e0",
            insertbackground="white"
        )
        self.transcription_text.pack(fill=tk.BOTH, expand=True)
        self.transcription_text.config(state=tk.DISABLED)
        
        # Configure text tags for styling
        self.transcription_text.tag_config("completed", foreground="#e0e0e0")
        self.transcription_text.tag_config("incomplete", foreground="#ff9800", font=("Consolas", 10, "italic"))
        self.transcription_text.tag_config("timestamp", foreground="#888888", font=("Consolas", 9))
        
        # Help section
        help_frame = ttk.LabelFrame(main_frame, text="Help", padding="10")
        help_frame.grid(row=3, column=0, sticky=(tk.W, tk.E))
        
        help_text = ("Speech-to-Text Decoder\n"
                    "Real-time transcription. Tune to a voice frequency, click Start, and watch the transcription appear.\n"
                    "Model and language are configured server-side.")
        ttk.Label(help_frame, text=help_text, wraplength=650, justify=tk.LEFT).pack()
        
    def on_auto_scroll_changed(self):
        """Handle auto-scroll checkbox change."""
        self.auto_scroll = self.auto_scroll_var.get()
        
    def on_show_timestamps_changed(self):
        """Handle show timestamps checkbox change."""
        self.show_timestamps = self.show_timestamps_var.get()
        self.render_transcription()
        
    def start_decoder(self):
        """Start the decoder."""
        print("[Whisper] Starting decoder")
        
        self.running = True
        self.session_start_time = time.time()
        self.last_update_time = None
        self.update_button_states()
        self.update_status("Starting...", "orange")
        
        # Show waiting message
        self.render_transcription()
        
        # Start update timer
        self.start_update_timer()
        
        # Attach to audio extension
        self.attach_audio_extension()
        
    def stop_decoder(self):
        """Stop the decoder."""
        print("[Whisper] Stopping decoder")
        
        self.running = False
        self.update_button_states()
        self.update_status("Stopped", "gray")
        
        # Stop update timer
        self.stop_update_timer()
        
        # Detach from audio extension
        self.detach_audio_extension()
        
    def attach_audio_extension(self):
        """Attach to the Whisper audio extension via WebSocket."""
        if not self.dxcluster_ws or not self.dxcluster_ws.is_connected():
            print("[Whisper] ERROR: DX WebSocket not connected")
            self.update_status("Error: No connection", "red")
            self.update_server_status("Not connected", "red")
            return
        
        try:
            # Setup binary message handler before attaching
            self.setup_binary_message_handler()
            
            attach_msg = {
                'type': 'audio_extension_attach',
                'extension_name': 'whisper',
                'params': {}  # No user-configurable parameters
            }
            
            print(f"[Whisper] Sending attach message: {attach_msg}")
            self.dxcluster_ws.ws.send(json.dumps(attach_msg))
            
            self.update_status("Running", "green")
            self.update_server_status("Connected", "green")
            
        except Exception as e:
            print(f"[Whisper] Error attaching: {e}")
            self.update_status(f"Error: {e}", "red")
            self.update_server_status("Error", "red")
        
    def detach_audio_extension(self):
        """Detach from the audio extension."""
        if not self.dxcluster_ws or not self.dxcluster_ws.is_connected():
            print("[Whisper] ERROR: DX WebSocket not connected")
            return
        
        try:
            # Remove binary message handler before detaching
            self.remove_binary_message_handler()
            
            detach_msg = {
                'type': 'audio_extension_detach'
            }
            
            print("[Whisper] Sending detach message")
            if hasattr(self.dxcluster_ws, 'ws'):
                self.dxcluster_ws.ws.send(json.dumps(detach_msg))
            
            self.update_server_status("Disconnected", "gray")
            
        except Exception as e:
            print(f"[Whisper] Error detaching: {e}")
        
    def setup_binary_message_handler(self):
        """Setup handler for binary messages from WebSocket."""
        # Store original handler
        if hasattr(self.dxcluster_ws, 'ws') and hasattr(self.dxcluster_ws.ws, 'on_message'):
            self.original_ws_handler = self.dxcluster_ws.ws.on_message
        
        # Create new handler that intercepts binary messages
        def binary_handler(ws, message):
            if isinstance(message, bytes):
                # Binary message - process as Whisper data
                self.handle_binary_message(message)
            else:
                # Text message - pass to original handler
                if self.original_ws_handler:
                    self.original_ws_handler(ws, message)
        
        if hasattr(self.dxcluster_ws, 'ws'):
            self.dxcluster_ws.ws.on_message = binary_handler
            print("[Whisper] Binary message handler installed")
        
    def remove_binary_message_handler(self):
        """Remove binary message handler."""
        if self.original_ws_handler and hasattr(self.dxcluster_ws, 'ws'):
            self.dxcluster_ws.ws.on_message = self.original_ws_handler
            self.original_ws_handler = None
            print("[Whisper] Original message handler restored")
            
    def handle_binary_message(self, data: bytes):
        """Handle binary message from WebSocket."""
        if len(data) < 1:
            return
        
        message_type = data[0]
        
        if message_type == 0x02:  # Segments JSON
            self.handle_segments(data)
        else:
            print(f"[Whisper] Unknown message type: 0x{message_type:02x}")
            
    def handle_segments(self, data: bytes):
        """Handle segments message."""
        # Binary protocol: [type:1][timestamp:8][json_length:4][json:N]
        if len(data) < 13:
            return
        
        # Extract timestamp (bytes 1-8, big-endian)
        timestamp_nano = struct.unpack('>Q', data[1:9])[0]
        
        # Extract JSON length (bytes 9-12, big-endian)
        json_length = struct.unpack('>I', data[9:13])[0]
        
        # Extract JSON (bytes 13 onwards)
        if len(data) < 13 + json_length:
            return
        
        json_bytes = data[13:13+json_length]
        json_str = json_bytes.decode('utf-8')
        
        try:
            segments = json.loads(json_str)
        except json.JSONDecodeError as e:
            print(f"[Whisper] Failed to parse segments JSON: {e}")
            return
        
        if not isinstance(segments, list) or len(segments) == 0:
            return
        
        print(f"[Whisper] Received {len(segments)} segments")
        
        # Process segments
        self.process_segments(segments)
        
        # Update last update time
        self.last_update_time = time.time()
        
        # Render updated transcription
        self.render_transcription()
        
        # Auto-scroll if enabled
        if self.auto_scroll:
            self.transcription_text.see(tk.END)
            
    def process_segments(self, segments: list):
        """Process segments following WhisperLive client.py pattern."""
        for i, seg in enumerate(segments):
            # Last segment that's not completed becomes last_segment
            if i == len(segments) - 1 and not seg.get('completed', False):
                self.last_segment = seg
            # Completed segments are added to transcript if not already there
            elif seg.get('completed', False):
                # Check if this segment should be added (not overlapping with existing)
                should_add = (len(self.transcript) == 0 or
                            float(seg.get('start', 0)) >= float(self.transcript[-1].get('end', 0)))
                
                if should_add:
                    self.transcript.append(seg)
                    
    def render_transcription(self):
        """Render the transcription to the text widget."""
        self.transcription_text.config(state=tk.NORMAL)
        self.transcription_text.delete('1.0', tk.END)
        
        # Handle empty state
        if len(self.transcript) == 0 and not self.last_segment:
            if self.running:
                self.transcription_text.insert(tk.END, 
                    "Transcription started, please wait for the first chunk of text...",
                    "incomplete")
            else:
                self.transcription_text.insert(tk.END,
                    "No transcription yet. Start the decoder to begin.",
                    "completed")
            self.transcription_text.config(state=tk.DISABLED)
            return
        
        # Build display for all segments (completed + incomplete)
        segments_to_display = self.transcript.copy()
        if self.last_segment:
            segments_to_display.append(self.last_segment)
        
        for i, seg in enumerate(segments_to_display):
            is_incomplete = (i == len(segments_to_display) - 1 and 
                           self.last_segment and seg == self.last_segment)
            
            # Add timestamp if enabled
            if self.show_timestamps and 'start' in seg and self.session_start_time:
                segment_offset_s = float(seg['start'])
                wall_clock_time = self.session_start_time + segment_offset_s
                time_str = datetime.fromtimestamp(wall_clock_time).strftime('%H:%M:%S')
                self.transcription_text.insert(tk.END, f"[{time_str}] ", "timestamp")
            
            # Add text
            text = seg.get('text', '')
            tag = "incomplete" if is_incomplete else "completed"
            self.transcription_text.insert(tk.END, text + "\n", tag)
        
        self.transcription_text.config(state=tk.DISABLED)
        
    def clear_transcription(self):
        """Clear the transcription."""
        print("[Whisper] Clearing transcription")
        self.transcript = []
        self.last_segment = None
        self.render_transcription()
        
    def copy_to_clipboard(self):
        """Copy transcription to clipboard."""
        # Get all completed segments plus the current incomplete one
        all_segments = self.transcript.copy()
        if self.last_segment:
            all_segments.append(self.last_segment)
        
        text = ' '.join(seg.get('text', '') for seg in all_segments)
        
        self.window.clipboard_clear()
        self.window.clipboard_append(text)
        self.window.update()  # Required for clipboard to work
        
        print("[Whisper] Copied to clipboard")
        self.show_temporary_message("Copied to clipboard!")
        
    def save_transcription(self):
        """Save transcription to file."""
        # Get all completed segments plus the current incomplete one
        all_segments = self.transcript.copy()
        if self.last_segment:
            all_segments.append(self.last_segment)
        
        if self.show_timestamps and self.session_start_time:
            lines = []
            for seg in all_segments:
                if 'start' in seg and 'end' in seg:
                    start_time = float(seg['start'])
                    end_time = float(seg['end'])
                    lines.append(f"[{start_time:.2f}s - {end_time:.2f}s] {seg.get('text', '')}")
                else:
                    lines.append(seg.get('text', ''))
            text = '\n'.join(lines)
        else:
            text = '\n'.join(seg.get('text', '') for seg in all_segments)
        
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = filedialog.asksaveasfilename(
            defaultextension=".txt",
            initialfile=f"whisper_transcription_{timestamp}.txt",
            filetypes=[("Text files", "*.txt"), ("All files", "*.*")]
        )
        
        if filename:
            try:
                with open(filename, 'w', encoding='utf-8') as f:
                    f.write(text)
                print(f"[Whisper] Saved transcription to {filename}")
                self.show_temporary_message("Saved transcription!")
            except Exception as e:
                print(f"[Whisper] Error saving file: {e}")
                messagebox.showerror("Error", f"Failed to save file: {e}")
                
    def show_temporary_message(self, message: str):
        """Show a temporary message in the status label."""
        original_text = self.status_label.cget("text")
        original_color = self.status_label.cget("foreground")
        
        self.status_label.config(text=message, foreground="green")
        self.window.after(2000, lambda: self.status_label.config(text=original_text, foreground=original_color))
        
    def update_button_states(self):
        """Update button states based on running state."""
        if self.running:
            self.start_button.config(state=tk.DISABLED)
            self.stop_button.config(state=tk.NORMAL)
        else:
            self.start_button.config(state=tk.NORMAL)
            self.stop_button.config(state=tk.DISABLED)
            
    def update_status(self, text: str, color: str):
        """Update status label."""
        self.status_label.config(text=text, foreground=color)
        
    def update_server_status(self, text: str, color: str):
        """Update server status label."""
        self.server_status_label.config(text=text, foreground=color)
        
    def start_update_timer(self):
        """Start the update timer."""
        self.stop_update_timer()
        self.update_last_update_display()
        self.update_timer_id = self.window.after(1000, self.update_timer_tick)
        
    def stop_update_timer(self):
        """Stop the update timer."""
        if self.update_timer_id:
            self.window.after_cancel(self.update_timer_id)
            self.update_timer_id = None
        self.last_update_label.config(text="--")
        
    def update_timer_tick(self):
        """Timer tick to update the last update display."""
        self.update_last_update_display()
        if self.running:
            self.update_timer_id = self.window.after(1000, self.update_timer_tick)
            
    def update_last_update_display(self):
        """Update the 'time since last update' display."""
        if not self.last_update_time:
            self.last_update_label.config(text="--")
            return
        
        elapsed_s = int(time.time() - self.last_update_time)
        
        if elapsed_s < 60:
            self.last_update_label.config(text=f"{elapsed_s}s")
        else:
            minutes = elapsed_s // 60
            seconds = elapsed_s % 60
            self.last_update_label.config(text=f"{minutes}m{seconds}s")
            
    def on_closing(self):
        """Handle window closing."""
        if self.running:
            self.stop_decoder()
        
        self.window.destroy()


def create_whisper_window(parent: tk.Tk, dxcluster_ws, radio_control) -> WhisperExtension:
    """
    Create and return a Whisper extension window.
    
    Args:
        parent: Parent window
        dxcluster_ws: DX cluster WebSocket connection
        radio_control: Radio control object
        
    Returns:
        WhisperExtension instance
    """
    return WhisperExtension(parent, dxcluster_ws, radio_control)
