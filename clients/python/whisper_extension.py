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
        self.show_only_incomplete = True  # Show only in-progress sentence
        self.last_rendered_transcript_len = 0  # Track number of completed segments rendered
        self.last_rendered_incomplete = None  # Track last incomplete segment text
        self.last_bionic_state = None  # Track bionic reading state to detect changes
        self.detected_language = None  # Detected language from server
        self.detected_language_prob = None  # Language detection probability

        # Font size control
        self.font_size = 10  # Default font size
        self.floating_font_size = 14  # Default floating window font size

        # Bionic reading
        self.bionic_reading = False  # Bionic reading mode
        
        # Floating window
        self.show_floating_window = False  # Show floating window with current text
        self.floating_window = None  # Reference to floating window
        self.floating_text = None  # Text widget in floating window (for bionic reading support)
        self.last_floating_text = None  # Track last floating window text to prevent flashing
        
        # Frequency change detection
        self.last_frequency = None  # Track last frequency
        self.frequency_check_timer = None  # Timer for checking frequency changes
        self.was_running_before_freq_change = False  # Track if decoder was running before frequency change
        self.frequency_restart_timer = None  # Timer for auto-restart after frequency stabilizes
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("🎤 Speech-to-Text")
        self.window.geometry("900x600")
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
        main_frame.columnconfigure(0, weight=1)
        
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
        controls_frame.columnconfigure(7, weight=1)
        
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

        # Show only incomplete checkbox
        self.show_only_incomplete_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(controls_frame, text="Only show in-progress",
                       variable=self.show_only_incomplete_var,
                       command=self.on_show_only_incomplete_changed).grid(row=0, column=2, padx=(0, 15))

        # Bionic reading checkbox
        self.bionic_reading_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(controls_frame, text="Bionic reading",
                       variable=self.bionic_reading_var,
                       command=self.on_bionic_reading_changed).grid(row=0, column=3, padx=(0, 15))

        # Show floating window checkbox
        self.show_floating_window_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(controls_frame, text="Show floating window",
                       variable=self.show_floating_window_var,
                       command=self.on_show_floating_window_changed).grid(row=0, column=4, padx=(0, 15))
        
        # Control buttons
        self.start_button = ttk.Button(controls_frame, text="Start", command=self.start_decoder)
        self.start_button.grid(row=0, column=5, padx=(0, 5))

        self.stop_button = ttk.Button(controls_frame, text="Stop", command=self.stop_decoder, state=tk.DISABLED)
        self.stop_button.grid(row=0, column=6, padx=(0, 15))
        
        # Last update time (right-aligned)
        self.last_update_label = ttk.Label(controls_frame, text="--", foreground="gray", font=("Courier", 9))
        self.last_update_label.grid(row=0, column=7, sticky=tk.E)
        
        # Transcription display frame with language label
        trans_header_frame = ttk.Frame(main_frame)
        trans_header_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(0, 0))
        
        trans_frame = ttk.LabelFrame(trans_header_frame, text="Transcription", padding="10")
        trans_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        self.language_label = ttk.Label(trans_header_frame, text="", foreground="gray", font=("Courier", 9, "italic"))
        self.language_label.pack(side=tk.LEFT, padx=(5, 0))
        
        main_frame.rowconfigure(2, weight=1)
        
        # Action buttons in header
        actions_frame = ttk.Frame(trans_frame)
        actions_frame.pack(side=tk.TOP, fill=tk.X, pady=(0, 5))
        
        # Font size controls on the left
        ttk.Button(actions_frame, text="−", width=3, command=self.decrease_font_size).pack(side=tk.LEFT, padx=(0, 2))
        ttk.Button(actions_frame, text="+", width=3, command=self.increase_font_size).pack(side=tk.LEFT, padx=(0, 10))

        ttk.Button(actions_frame, text="📋 Copy", command=self.copy_to_clipboard).pack(side=tk.RIGHT, padx=(5, 0))
        ttk.Button(actions_frame, text="💾 Save", command=self.save_transcription).pack(side=tk.RIGHT, padx=(5, 0))
        ttk.Button(actions_frame, text="🗑️ Clear", command=self.clear_transcription).pack(side=tk.RIGHT)
        
        # Transcription text area
        self.transcription_text = scrolledtext.ScrolledText(
            trans_frame,
            wrap=tk.WORD,
            width=70,
            height=20,
            font=("Consolas", self.font_size),
            bg="#2a2a2a",
            fg="#e0e0e0",
            insertbackground="white"
        )
        self.transcription_text.pack(fill=tk.BOTH, expand=True)
        self.transcription_text.config(state=tk.DISABLED)
        
        # Configure text tags for styling
        self.transcription_text.tag_config("completed", foreground="#e0e0e0")
        self.transcription_text.tag_config("incomplete", foreground="#ff9800", font=("Consolas", self.font_size, "italic"))
        self.transcription_text.tag_config("timestamp", foreground="#888888", font=("Consolas", max(self.font_size - 1, 8)))
        # Bionic reading tags
        self.transcription_text.tag_config("bionic_bold", font=("Consolas", self.font_size, "bold"))
        self.transcription_text.tag_config("bionic_bold_incomplete", foreground="#ff9800", font=("Consolas", self.font_size, "bold italic"))
        
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
        self.last_rendered_transcript_len = 0  # Reset cache to force full re-render
        self.render_transcription()

    def on_show_only_incomplete_changed(self):
        """Handle show only incomplete checkbox change."""
        self.show_only_incomplete = self.show_only_incomplete_var.get()
        self.last_rendered_transcript_len = 0  # Reset cache to force full re-render
        self.render_transcription()

    def on_bionic_reading_changed(self):
        """Handle bionic reading checkbox change."""
        self.bionic_reading = self.bionic_reading_var.get()
        self.last_rendered_transcript_len = 0  # Reset cache to force full re-render
        self.render_transcription()

    def on_show_floating_window_changed(self):
        """Handle show floating window checkbox change."""
        self.show_floating_window = self.show_floating_window_var.get()
        self.update_floating_window()

    def start_decoder(self):
        """Start the decoder."""
        print("[Whisper] Starting decoder")
        
        self.running = True
        self.session_start_time = time.time()
        self.last_update_time = None
        self.detected_language = None
        self.detected_language_prob = None
        self.update_language_display()
        self.update_button_states()
        self.update_status("Starting...", "orange")
        
        # Show waiting message
        self.render_transcription()
        
        # Start update timer
        self.start_update_timer()
        
        # Start frequency monitoring
        self.start_frequency_monitoring()
        
        # Attach to audio extension
        self.attach_audio_extension()
        
    def stop_decoder(self, skip_frequency_monitoring=False):
        """Stop the decoder."""
        print("[Whisper] Stopping decoder")
        
        self.running = False
        self.update_button_states()
        self.update_status("Stopped", "gray")
        
        # Stop update timer
        self.stop_update_timer()
        
        # Stop frequency monitoring (unless we're stopping due to frequency change)
        if not skip_frequency_monitoring:
            self.stop_frequency_monitoring()

        # Hide floating window
        self.update_floating_window()

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
        elif message_type == 0x03:  # Language detection
            self.handle_language_detection(data)
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
        
        # Process segments
        self.process_segments(segments)
        
        # Update last update time
        self.last_update_time = time.time()
        
        # Render updated transcription
        self.render_transcription()

        # Update floating window
        self.update_floating_window()

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
                    
    def calculate_bionic_split(self, word):
        """Calculate how many characters to bold for bionic reading.

        Args:
            word: The word to calculate split for

        Returns:
            Number of characters to bold
        """
        length = len(word)
        if length <= 3:
            return 1
        elif length <= 5:
            return 2
        elif length <= 7:
            return 3
        else:
            # For 8+ characters, bold approximately 40%
            return max(3, int(length * 0.4))

    def insert_bionic_text(self, text, tag_prefix=""):
        """Insert text with bionic reading formatting.

        Args:
            text: The text to insert
            tag_prefix: Prefix for tag names (e.g., "" for completed, "incomplete" for incomplete)
        """
        import re

        # Split text into words and non-word characters
        pattern = r'(\w+|\W+)'
        parts = re.findall(pattern, text)

        for part in parts:
            if re.match(r'\w+', part):  # It's a word
                split_pos = self.calculate_bionic_split(part)
                bold_part = part[:split_pos]
                normal_part = part[split_pos:]

                # Insert bold part
                if tag_prefix == "incomplete":
                    self.transcription_text.insert(tk.END, bold_part, "bionic_bold_incomplete")
                else:
                    self.transcription_text.insert(tk.END, bold_part, "bionic_bold")

                # Insert normal part
                if tag_prefix:
                    self.transcription_text.insert(tk.END, normal_part, tag_prefix)
                else:
                    self.transcription_text.insert(tk.END, normal_part, "completed")
            else:
                # It's whitespace or punctuation, insert as-is
                if tag_prefix:
                    self.transcription_text.insert(tk.END, part, tag_prefix)
                else:
                    self.transcription_text.insert(tk.END, part, "completed")

    def render_transcription(self):
        """Render the transcription to the text widget with minimal updates."""
        current_incomplete = self.last_segment.get('text', '') if self.last_segment else None
        transcript_len = len(self.transcript)

        # Check if bionic reading state changed
        bionic_state_changed = (self.bionic_reading != self.last_bionic_state)
        if bionic_state_changed:
            self.last_bionic_state = self.bionic_reading

        # In "show only incomplete" mode, always do a simple render
        if self.show_only_incomplete:
            self.transcription_text.config(state=tk.NORMAL)
            self.transcription_text.delete('1.0', tk.END)

            if self.last_segment:
                if self.show_timestamps and 'start' in self.last_segment and self.session_start_time:
                    segment_offset_s = float(self.last_segment['start'])
                    wall_clock_time = self.session_start_time + segment_offset_s
                    time_str = datetime.fromtimestamp(wall_clock_time).strftime('%H:%M:%S')
                    self.transcription_text.insert(tk.END, f"[{time_str}] ", "timestamp")

                text = self.last_segment.get('text', '')
                if self.bionic_reading:
                    self.insert_bionic_text(text, "incomplete")
                else:
                    self.transcription_text.insert(tk.END, text, "incomplete")
            elif self.running:
                self.transcription_text.insert(tk.END,
                    "Waiting for speech...",
                    "incomplete")
            else:
                self.transcription_text.insert(tk.END,
                    "No transcription yet. Start the decoder to begin.",
                    "completed")

            self.transcription_text.config(state=tk.DISABLED)
            self.last_rendered_transcript_len = transcript_len
            self.last_rendered_incomplete = current_incomplete
            return

        # Check if we need a full redraw (completed segments changed, timestamps toggled, or bionic state changed)
        need_full_redraw = (transcript_len != self.last_rendered_transcript_len) or bionic_state_changed

        # Check if only the incomplete segment changed
        incomplete_changed = (current_incomplete != self.last_rendered_incomplete)

        # Skip if nothing changed
        if not need_full_redraw and not incomplete_changed:
            return

        self.transcription_text.config(state=tk.NORMAL)

        if need_full_redraw:
            # Full redraw needed - completed segments changed
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
                self.last_rendered_transcript_len = 0
                self.last_rendered_incomplete = None
                return

            # Render all completed segments
            for seg in self.transcript:
                if self.show_timestamps and 'start' in seg and self.session_start_time:
                    segment_offset_s = float(seg['start'])
                    wall_clock_time = self.session_start_time + segment_offset_s
                    time_str = datetime.fromtimestamp(wall_clock_time).strftime('%H:%M:%S')
                    self.transcription_text.insert(tk.END, f"[{time_str}] ", "timestamp")

                text = seg.get('text', '')
                if self.bionic_reading:
                    self.insert_bionic_text(text, "")
                    self.transcription_text.insert(tk.END, "\n", "completed")
                else:
                    self.transcription_text.insert(tk.END, text + "\n", "completed")

            # Add incomplete segment if exists
            if self.last_segment:
                if self.show_timestamps and 'start' in self.last_segment and self.session_start_time:
                    segment_offset_s = float(self.last_segment['start'])
                    wall_clock_time = self.session_start_time + segment_offset_s
                    time_str = datetime.fromtimestamp(wall_clock_time).strftime('%H:%M:%S')
                    self.transcription_text.insert(tk.END, f"[{time_str}] ", "timestamp")

                text = self.last_segment.get('text', '')
                if self.bionic_reading:
                    self.insert_bionic_text(text, "incomplete")
                    self.transcription_text.insert(tk.END, "\n", "incomplete")
                else:
                    self.transcription_text.insert(tk.END, text + "\n", "incomplete")

            self.last_rendered_transcript_len = transcript_len
            self.last_rendered_incomplete = current_incomplete

        elif incomplete_changed:
            # Only incomplete segment changed - just update the last line
            # Check if there was a previous incomplete segment to delete
            if self.last_rendered_incomplete is not None:
                # Find and delete only the last line (incomplete segment)
                # Get the line number of the last line with content
                end_index = self.transcription_text.index("end-1c")
                last_line_num = int(end_index.split('.')[0]) - 1
                if last_line_num > 0:
                    last_line_start = f"{last_line_num}.0"
                    last_line_end = f"{last_line_num}.end"
                    self.transcription_text.delete(last_line_start, last_line_end)
                    # Also delete the newline if it exists
                    if self.transcription_text.get(last_line_start, f"{last_line_start}+1c") == "\n":
                        self.transcription_text.delete(last_line_start, f"{last_line_start}+1c")

            # Re-add the incomplete segment
            if self.last_segment:
                if self.show_timestamps and 'start' in self.last_segment and self.session_start_time:
                    segment_offset_s = float(self.last_segment['start'])
                    wall_clock_time = self.session_start_time + segment_offset_s
                    time_str = datetime.fromtimestamp(wall_clock_time).strftime('%H:%M:%S')
                    self.transcription_text.insert(tk.END, f"[{time_str}] ", "timestamp")

                text = self.last_segment.get('text', '')
                if self.bionic_reading:
                    self.insert_bionic_text(text, "incomplete")
                    self.transcription_text.insert(tk.END, "\n", "incomplete")
                else:
                    self.transcription_text.insert(tk.END, text + "\n", "incomplete")

            self.last_rendered_incomplete = current_incomplete

        self.transcription_text.config(state=tk.DISABLED)
        
    def clear_transcription(self):
        """Clear the transcription."""
        print("[Whisper] Clearing transcription")
        self.transcript = []
        self.last_segment = None
        self.last_rendered_transcript_len = 0  # Reset cache to force re-render
        self.last_rendered_incomplete = None
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

    def handle_language_detection(self, data: bytes):
        """Handle language detection message."""
        # Binary protocol: [type:1][timestamp:8][json_length:4][json:N]
        if len(data) < 13:
            return

        # Extract JSON length (bytes 9-12, big-endian)
        json_length = struct.unpack('>I', data[9:13])[0]

        # Extract JSON (bytes 13 onwards)
        if len(data) < 13 + json_length:
            return

        json_bytes = data[13:13+json_length]
        json_str = json_bytes.decode('utf-8')

        try:
            language_data = json.loads(json_str)
        except json.JSONDecodeError as e:
            print(f"[Whisper] Failed to parse language detection JSON: {e}")
            return

        self.detected_language = language_data.get('language')
        self.detected_language_prob = language_data.get('language_prob')

        if self.detected_language and self.detected_language_prob:
            print(f"[Whisper] Detected language: {self.detected_language} ({self.detected_language_prob*100:.1f}%)")

        # Update the display
        self.update_language_display()

    def update_language_display(self):
        """Update the language detection display."""
        if not self.language_label:
            return

        if self.detected_language and self.detected_language_prob:
            language_names = {
                'en': 'English',
                'es': 'Spanish',
                'fr': 'French',
                'de': 'German',
                'it': 'Italian',
                'pt': 'Portuguese',
                'ru': 'Russian',
                'zh': 'Chinese',
                'ja': 'Japanese',
                'ko': 'Korean',
                'ar': 'Arabic',
                'hi': 'Hindi',
                'nl': 'Dutch',
                'pl': 'Polish',
                'tr': 'Turkish',
                'sv': 'Swedish',
                'da': 'Danish',
                'no': 'Norwegian',
                'fi': 'Finnish'
            }

            language_name = language_names.get(self.detected_language, self.detected_language.upper())
            probability = int(self.detected_language_prob * 100)

            self.language_label.config(text=f"({language_name} {probability}%)")
        else:
            self.language_label.config(text="")

    def start_frequency_monitoring(self):
        """Start monitoring frequency changes."""
        # Get current frequency from radio control
        if self.radio_control and hasattr(self.radio_control, 'frequency'):
            self.last_frequency = self.radio_control.frequency

        # Check frequency every 100ms
        self.check_frequency_change()

    def check_frequency_change(self):
        """Check if frequency has changed."""
        if not self.running:
            return

        # Get current frequency
        current_frequency = None
        if self.radio_control and hasattr(self.radio_control, 'frequency'):
            current_frequency = self.radio_control.frequency

        # Check if frequency has changed
        if self.last_frequency is not None and current_frequency is not None:
            if current_frequency != self.last_frequency:
                print(f"[Whisper] Frequency changed from {self.last_frequency} to {current_frequency}")

                # Stop decoder if running
                if self.running:
                    print("[Whisper] Stopping decoder due to frequency change")
                    self.was_running_before_freq_change = True
                    self.stop_decoder(skip_frequency_monitoring=True)  # Skip stopping frequency monitoring
                    self.update_status("Paused (frequency change)", "orange")

                # Cancel any existing restart timer
                if self.frequency_restart_timer:
                    self.window.after_cancel(self.frequency_restart_timer)

                # Set timer to restart after 1 second of stability
                self.frequency_restart_timer = self.window.after(1000, self.restart_after_frequency_stable)

        self.last_frequency = current_frequency

        # Schedule next check
        if self.running or self.was_running_before_freq_change:
            self.frequency_check_timer = self.window.after(100, self.check_frequency_change)

    def restart_after_frequency_stable(self):
        """Restart decoder after frequency has been stable for 1 second."""
        if self.was_running_before_freq_change:
            print("[Whisper] Frequency stable for 1 second, restarting decoder")
            self.was_running_before_freq_change = False
            self.start_decoder()

    def stop_frequency_monitoring(self):
        """Stop monitoring frequency changes."""
        if self.frequency_check_timer:
            self.window.after_cancel(self.frequency_check_timer)
            self.frequency_check_timer = None

        if self.frequency_restart_timer:
            self.window.after_cancel(self.frequency_restart_timer)
            self.frequency_restart_timer = None

        self.was_running_before_freq_change = False

    def update_floating_window(self):
        """Update or hide the floating window based on state."""
        should_show = self.show_floating_window and self.running and self.last_segment and self.last_segment.get('text')

        if not should_show:
            if self.floating_window and self.floating_window.winfo_exists():
                self.floating_window.destroy()
                self.floating_window = None
                self.floating_text = None
            return

        # Create floating window if it doesn't exist
        if not self.floating_window or not self.floating_window.winfo_exists():
            self.floating_window = tk.Toplevel(self.window)
            self.floating_window.title("Speech-to-Text")
            self.floating_window.attributes('-topmost', True)  # Keep on top
            self.floating_window.geometry("400x150")

            # Make window semi-transparent (if supported)
            try:
                self.floating_window.attributes('-alpha', 0.9)
            except:
                pass  # Not supported on all platforms

            # Configure background
            self.floating_window.configure(bg='#1a1a1a')

            # Create Text widget for rich formatting support
            self.floating_text = tk.Text(
                self.floating_window,
                font=("Consolas", self.floating_font_size, "bold"),
                bg='#1a1a1a',
                fg='#ff9800',
                wrap=tk.WORD,
                padx=10,
                pady=10,
                relief=tk.FLAT,
                borderwidth=0,
                highlightthickness=0
            )
            self.floating_text.pack(fill=tk.BOTH, expand=True)

            # Configure text tags for bionic reading
            # Normal text should NOT be bold, only bionic_bold should be bold
            self.floating_text.tag_config("normal", foreground="#ff9800", font=("Consolas", self.floating_font_size))
            self.floating_text.tag_config("bionic_bold", foreground="#ff9800", font=("Consolas", self.floating_font_size, "bold"))

            # Prevent window from being closed directly (only via checkbox)
            self.floating_window.protocol("WM_DELETE_WINDOW", lambda: self.show_floating_window_var.set(False) or self.update_floating_window())

        # Update text only if it changed (prevent flashing)
        if self.floating_text:
            text = self.last_segment.get('text', '')
            
            # Only update if text actually changed
            if text != self.last_floating_text:
                self.last_floating_text = text
                self.floating_text.config(state=tk.NORMAL)
                self.floating_text.delete('1.0', tk.END)

                if self.bionic_reading:
                    # Apply bionic reading to floating window
                    import re
                    pattern = r'(\w+|\W+)'
                    parts = re.findall(pattern, text)

                    for part in parts:
                        if re.match(r'\w+', part):  # It's a word
                            split_pos = self.calculate_bionic_split(part)
                            bold_part = part[:split_pos]
                            normal_part = part[split_pos:]
                            self.floating_text.insert(tk.END, bold_part, "bionic_bold")
                            self.floating_text.insert(tk.END, normal_part, "normal")
                        else:
                            self.floating_text.insert(tk.END, part, "normal")
                else:
                    self.floating_text.insert(tk.END, text, "normal")

                self.floating_text.config(state=tk.DISABLED)

    def increase_font_size(self):
        """Increase the font size of the transcription text."""
        if self.font_size < 24:  # Maximum font size
            self.font_size += 1
            self.update_text_font()
            
            # Also increase floating window font size
            if self.floating_font_size < 28:
                self.floating_font_size += 2
                self.update_floating_window_font()

    def decrease_font_size(self):
        """Decrease the font size of the transcription text."""
        if self.font_size > 6:  # Minimum font size
            self.font_size -= 1
            self.update_text_font()
            
            # Also decrease floating window font size
            if self.floating_font_size > 10:
                self.floating_font_size -= 2
                self.update_floating_window_font()

    def update_text_font(self):
        """Update the font size of the transcription text widget."""
        # Update main text widget font
        self.transcription_text.config(font=("Consolas", self.font_size))

        # Update text tags with new font sizes
        self.transcription_text.tag_config("completed", foreground="#e0e0e0", font=("Consolas", self.font_size))
        self.transcription_text.tag_config("incomplete", foreground="#ff9800", font=("Consolas", self.font_size, "italic"))
        self.transcription_text.tag_config("timestamp", foreground="#888888", font=("Consolas", max(self.font_size - 1, 8)))
        # Update bionic reading tags
        self.transcription_text.tag_config("bionic_bold", font=("Consolas", self.font_size, "bold"))
        self.transcription_text.tag_config("bionic_bold_incomplete", foreground="#ff9800", font=("Consolas", self.font_size, "bold italic"))

        # Force re-render to apply new font
        self.last_rendered_transcript_len = 0
        self.last_rendered_incomplete = None
        self.render_transcription()

    def update_floating_window_font(self):
        """Update the font size of the floating window."""
        if self.floating_text and self.floating_window and self.floating_window.winfo_exists():
            # Update text tags with correct font weights
            self.floating_text.tag_config("normal", foreground="#ff9800", font=("Consolas", self.floating_font_size))
            self.floating_text.tag_config("bionic_bold", foreground="#ff9800", font=("Consolas", self.floating_font_size, "bold"))
            # Force re-render with new font
            self.last_floating_text = None
            self.update_floating_window()

    def on_closing(self):
        """Handle window closing."""
        if self.running:
            self.stop_decoder()

        # Close floating window if open
        if self.floating_window and self.floating_window.winfo_exists():
            self.floating_window.destroy()

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
