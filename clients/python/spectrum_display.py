#!/usr/bin/env python3
"""
Spectrum Display Widget for ka9q_ubersdr Python GUI
Displays RF spectrum as a line chart with 200 KHz bandwidth centered on current frequency.
"""

import asyncio
import gzip
import json
import struct
import time
import tkinter as tk
from tkinter import Canvas
import websockets
import numpy as np
from typing import Optional, Callable
import threading
import queue
from urllib.parse import urlencode

# Import timestamp synchronization (optional)
try:
    import sys
    import os
    # Add multi_instance directory to path if needed
    multi_instance_path = os.path.join(os.path.dirname(__file__), '..', 'multi_instance')
    if os.path.exists(multi_instance_path) and multi_instance_path not in sys.path:
        sys.path.insert(0, multi_instance_path)
    
    from timestamp_sync import SpectrumAligner, SyncQualityMetrics
    TIMESTAMP_SYNC_AVAILABLE = True
except ImportError:
    TIMESTAMP_SYNC_AVAILABLE = False


class SpectrumDisplay:
    """Spectrum display widget showing RF spectrum as a line chart."""
    
    def __init__(self, parent: tk.Widget, width: int = 800, height: int = 200, click_tune_var=None, center_tune_var=None, bookmarks: list = None):
        """Initialize spectrum display widget.

        Args:
            parent: Parent tkinter widget
            width: Canvas width in pixels
            height: Canvas height in pixels
            click_tune_var: BooleanVar to control click-to-tune behavior
            center_tune_var: BooleanVar to control whether tuning centers the spectrum (default True)
            bookmarks: List of bookmark dictionaries with 'name', 'frequency', 'mode' keys
        """
        self.parent = parent
        self.width = width
        self.height = height
        self.click_tune_var = click_tune_var
        self.center_tune_var = center_tune_var
        self.bookmarks = bookmarks or []
        self.bands = []  # List of band dictionaries with 'label', 'start', 'end', 'color'

        # Drag state for click-and-drag panning
        self.dragging = False
        self.drag_start_x = 0
        self.drag_start_freq = 0
        self.drag_threshold = 5  # Pixels - movement less than this is considered a click
        
        # Create canvas for spectrum display
        self.canvas = Canvas(parent, width=width, height=height, bg='#000000', highlightthickness=1)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        
        # Signal meter state
        self.signal_meter_mode = 'snr'  # 'snr' or 'dbfs'
        self.last_signal_update = 0
        self.signal_update_interval = 250  # Update every 250ms
        
        # Spectrum data
        self.spectrum_data: Optional[np.ndarray] = None
        self.center_freq: float = 0
        self.bin_count: int = 0
        self.bin_bandwidth: float = 0
        self.total_bandwidth: float = 0
        self.initial_bin_bandwidth: float = 0  # Store initial for zoom calculations
        self.last_spectrum_timestamp: Optional[float] = None  # Track last timestamp
        self.instance_id: Optional[int] = None  # Instance ID for multi-instance sync

        # Binary protocol support
        self.using_binary_protocol: bool = False
        self.binary_spectrum_data: Optional[np.ndarray] = None  # State for delta decoding (float32)
        self.binary_spectrum_data8: Optional[np.ndarray] = None  # State for delta decoding (uint8)
        self.binary8_logged: bool = False  # Track if we've logged binary8 activation
        
        # Current tuned frequency and bandwidth (for filter visualization)
        self.tuned_freq: float = 0
        self.bandwidth_low: int = 0
        self.bandwidth_high: int = 0
        self.current_mode: str = ''  # Track current mode for IQ bandwidth calculation
        
        # Frequency step size for click-to-tune snapping (in Hz)
        self.step_size_hz: int = 1000  # Default 1 kHz
        
        # Zoom state
        self.zoom_level: float = 1.0  # 1.0 = no zoom, 2.0 = 2x zoom, etc.
        self.scroll_mode: str = 'zoom'  # 'zoom' or 'pan'
        
        # WebSocket connection
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.ws_url: Optional[str] = None
        self.connected: bool = False
        self.running: bool = False
        
        # Event loop for WebSocket
        self.event_loop: Optional[asyncio.AbstractEventLoop] = None
        self.ws_thread: Optional[threading.Thread] = None
        
        # Data queue for thread-safe updates
        self.data_queue = queue.Queue()
        
        # Frequency change callback
        self.frequency_callback: Optional[Callable[[float], None]] = None
        self.frequency_step_callback: Optional[Callable[[int], None]] = None  # Callback for stepping frequency
        self.mode_callback: Optional[Callable[[str], None]] = None  # Callback for mode changes
        self.bandwidth_callback: Optional[Callable[[int, int], None]] = None  # Callback for bandwidth changes
        
        # Drawing parameters - increased top margin for bookmark section
        self.bookmark_section_height = 20  # Height for bookmark markers
        self.margin_top = 30 + self.bookmark_section_height  # Add space for bookmarks
        self.margin_bottom = 30
        self.margin_left = 50
        self.margin_right = 20
        self.graph_height = height - self.margin_top - self.margin_bottom
        self.graph_width = width - self.margin_left - self.margin_right
        
        # Auto-ranging for dB scale
        self.min_db = -100
        self.max_db = 0
        
        # Mouse interaction - support click-and-drag panning
        self.canvas.bind('<ButtonPress-1>', self.on_mouse_down)
        self.canvas.bind('<ButtonRelease-1>', self.on_mouse_up)
        self.canvas.bind('<B1-Motion>', self.on_drag)
        self.canvas.bind('<Motion>', self.on_motion)
        # Mouse wheel for zoom/pan (Linux/Windows)
        self.canvas.bind('<Button-4>', self.on_scroll_up)  # Linux scroll up
        self.canvas.bind('<Button-5>', self.on_scroll_down)  # Linux scroll down
        self.canvas.bind('<MouseWheel>', self.on_mousewheel)  # Windows/Mac
        # Window resize handling
        self.canvas.bind('<Configure>', self.on_resize)
        
        # Tooltip and cursor
        self.tooltip_id = None
        self.tooltip_text = ""
        self.tooltip_x = 0
        self.tooltip_y = 0
        self.cursor_line_id = None
        self.cursor_x = -1  # -1 means no cursor visible
        self.last_mouse_x = -1  # Track last mouse position for dynamic tooltip updates
        self.last_mouse_y = -1
        
        # Start update loop
        self.update_display()
    
    def connect(self, server_url: str, frequency: float, user_session_id: str = None, use_tls: bool = False, password: str = None):
        """Connect to spectrum WebSocket.
        
        Args:
            server_url: Server URL (e.g., 'localhost:8080' or 'http://server:8080')
            frequency: Initial tuned frequency in Hz (where we're listening)
            user_session_id: User session ID (same as audio channel UUID)
            use_tls: Whether to use WSS (WebSocket Secure) instead of WS
            password: Optional password for bypass authentication
        """
        # Parse server URL
        if '://' in server_url:
            # Full URL provided
            if server_url.startswith('https://'):
                ws_url = server_url.replace('https://', 'wss://')
            elif server_url.startswith('http://'):
                ws_url = server_url.replace('http://', 'ws://')
            else:
                ws_url = server_url
            
            # Add path if not present
            if '/ws/user-spectrum' not in ws_url:
                ws_url = ws_url.rstrip('/') + '/ws/user-spectrum'
        else:
            # Host:port format - use TLS setting
            protocol = 'wss' if use_tls else 'ws'
            ws_url = f'{protocol}://{server_url}/ws/user-spectrum'
        
        # Build query parameters
        params = {}
        if user_session_id:
            params['user_session_id'] = user_session_id
        if password:
            params['password'] = password
        # Request binary8 mode for maximum bandwidth reduction (8-bit encoding)
        params['mode'] = 'binary8'

        # Add query parameters if any
        if params:
            ws_url = f'{ws_url}?{urlencode(params)}'
        
        self.ws_url = ws_url
        # Store the tuned frequency (where we're listening)
        # center_freq will be updated from server's config messages
        self.tuned_freq = frequency
        self.running = True
        
        # Start WebSocket thread
        self.ws_thread = threading.Thread(target=self._run_websocket, daemon=True)
        self.ws_thread.start()
    
    def disconnect(self):
        """Disconnect from spectrum WebSocket."""
        self.running = False
        if self.ws:
            # Close WebSocket in its event loop
            if self.event_loop and self.event_loop.is_running():
                asyncio.run_coroutine_threadsafe(self.ws.close(), self.event_loop)
    
    def _run_websocket(self):
        """Run WebSocket connection in separate thread."""
        self.event_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.event_loop)
        
        try:
            self.event_loop.run_until_complete(self._websocket_handler())
        except Exception as e:
            print(f"Spectrum WebSocket error: {e}")
        finally:
            self.event_loop.close()
    
    async def _websocket_handler(self):
        """Handle WebSocket connection and messages."""
        try:
            async with websockets.connect(self.ws_url) as ws:
                self.ws = ws
                self.connected = True
                print(f"Spectrum connected to {self.ws_url}")

                # Check if server negotiated WebSocket compression
                # Check the response headers for Sec-WebSocket-Extensions
                if hasattr(ws, 'response_headers'):
                    extensions = ws.response_headers.get('Sec-WebSocket-Extensions', '')
                    if 'permessage-deflate' in extensions.lower():
                        print("Server using native WebSocket compression (permessage-deflate)")
                    else:
                        print("Server NOT using native WebSocket compression (manual gzip for JSON messages)")
                else:
                    # Fallback: check if compression was negotiated
                    compression_enabled = getattr(ws, 'compression', None) is not None
                    if compression_enabled:
                        print("Server using native WebSocket compression")
                    else:
                        print("Server NOT using native WebSocket compression (manual gzip for JSON messages)")

                # Don't send zoom command immediately - wait for server's default config first
                # Then we'll send zoom command after receiving the first config message
                
                # Receive messages
                while self.running:
                    try:
                        message = await asyncio.wait_for(ws.recv(), timeout=1.0)
                        await self._handle_message(message)
                    except asyncio.TimeoutError:
                        continue
                    except websockets.exceptions.ConnectionClosed:
                        break
                
        except Exception as e:
            print(f"Spectrum connection error: {e}")
        finally:
            self.connected = False
            self.ws = None
    
    async def _handle_message(self, message):
        """Handle incoming WebSocket message.

        Args:
            message: JSON message string, binary (gzip compressed), or binary spectrum protocol
        """
        try:
            # Check if message is binary protocol or JSON
            if isinstance(message, bytes):
                # Check for binary spectrum protocol magic header "SPEC"
                if len(message) >= 4 and message[0:4] == b'SPEC':
                    # Binary spectrum protocol detected
                    if not self.using_binary_protocol:
                        self.using_binary_protocol = True
                        print('🚀 Binary spectrum protocol detected - bandwidth optimized!')

                    # Parse binary spectrum message
                    data = self._parse_binary_spectrum(message)
                    if data is None:
                        return  # Parse error, skip this message
                else:
                    # Legacy binary (gzip compressed JSON)
                    decompressed = gzip.decompress(message)
                    data = json.loads(decompressed.decode('utf-8'))
            else:
                # Text message - parse directly
                data = json.loads(message)
            msg_type = data.get('type')
            
            if msg_type == 'config':
                # Configuration update
                old_bin_count = self.bin_count
                server_center_freq = data.get('centerFreq', 0)
                self.bin_count = data.get('binCount', 0)
                self.bin_bandwidth = data.get('binBandwidth', 0)
                self.total_bandwidth = data.get('totalBandwidth', 0)
                
                # CRITICAL: Update center_freq from server's config
                # The server tells us where the spectrum is actually centered
                self.center_freq = server_center_freq
                
                # Store initial bin bandwidth for zoom calculations
                if self.initial_bin_bandwidth == 0:
                    self.initial_bin_bandwidth = self.bin_bandwidth
                
                # Update zoom level based on current vs initial bandwidth
                if self.initial_bin_bandwidth > 0:
                    self.zoom_level = self.initial_bin_bandwidth / self.bin_bandwidth
                
                # Debug: Print what we received (commented out - too verbose during rapid frequency changes)
                # print(f"Spectrum config received: {self.bin_count} bins @ {self.bin_bandwidth:.2f} Hz/bin = {self.total_bandwidth/1000:.1f} KHz total (zoom {self.zoom_level:.2f}x)")
                # print(f"Server center freq: {server_center_freq/1e6:.6f} MHz, Client center freq: {self.center_freq/1e6:.6f} MHz")
                
                # If this is the first config (bin_count was 0), send zoom command for 200 KHz
                # Use the tuned frequency (where we're listening), not the server's default center
                if old_bin_count == 0 and self.bin_count > 0:
                    # Calculate binBandwidth for 200 KHz total bandwidth
                    desired_bandwidth = 200000  # 200 KHz
                    bin_bandwidth = desired_bandwidth / self.bin_count
                    # Use tuned_freq if set, otherwise fall back to center_freq
                    zoom_freq = self.tuned_freq if self.tuned_freq != 0 else self.center_freq
                    print(f"Sending initial zoom: {desired_bandwidth/1000:.1f} KHz ({bin_bandwidth:.2f} Hz/bin with {self.bin_count} bins) at {zoom_freq/1e6:.6f} MHz")
                    await self._send_zoom_command(zoom_freq, desired_bandwidth)
                
            elif msg_type == 'spectrum':
                # Spectrum data update
                raw_data = data.get('data', [])
                timestamp = data.get('timestamp')  # Extract timestamp
                
                if raw_data:
                    # Unwrap FFT bin ordering (same as JavaScript implementation)
                    N = len(raw_data)
                    half_bins = N // 2
                    
                    # Rearrange: [negative freqs, positive freqs]
                    unwrapped = np.array(raw_data[half_bins:] + raw_data[:half_bins])
                    
                    # Store timestamp
                    if timestamp:
                        self.last_spectrum_timestamp = timestamp
                    
                    # Queue data for display update (with timestamp if available)
                    if timestamp:
                        self.data_queue.put((timestamp, unwrapped))
                    else:
                        self.data_queue.put(unwrapped)
                    
        except json.JSONDecodeError as e:
            print(f"Failed to parse spectrum message: {e}")

    def _parse_binary_spectrum(self, message: bytes) -> Optional[dict]:
        """Parse binary spectrum protocol message.

        Binary format:
        - Header (22 bytes):
          - Magic: 0x53 0x50 0x45 0x43 (4 bytes) "SPEC"
          - Version: 0x01 (1 byte)
          - Flags: 0x01=full (float32), 0x02=delta (float32), 0x03=full (uint8), 0x04=delta (uint8) (1 byte)
          - Timestamp: uint64 milliseconds (8 bytes, little-endian)
          - Frequency: uint64 Hz (8 bytes, little-endian)
        - For full frame (float32): all bins as float32 (binCount * 4 bytes, little-endian)
        - For delta frame (float32):
          - ChangeCount: uint16 (2 bytes, little-endian)
          - Changes: array of [index: uint16, value: float32] (6 bytes each, little-endian)
        - For full frame (uint8): all bins as uint8 (binCount * 1 byte)
        - For delta frame (uint8):
          - ChangeCount: uint16 (2 bytes, little-endian)
          - Changes: array of [index: uint16, value: uint8] (3 bytes each, little-endian)

        Args:
            message: Binary message bytes

        Returns:
            Dictionary with 'type', 'data', 'frequency', 'timestamp' or None on error
        """
        try:
            if len(message) < 22:
                print(f"Binary message too short: {len(message)} bytes")
                return None

            # Parse header
            magic = message[0:4]
            if magic != b'SPEC':
                print(f"Invalid magic: {magic}")
                return None

            version = message[4]
            if version != 0x01:
                print(f"Unsupported version: {version}")
                return None

            flags = message[5]
            timestamp = struct.unpack('<Q', message[6:14])[0]  # little-endian uint64
            frequency = struct.unpack('<Q', message[14:22])[0]  # little-endian uint64

            if flags == 0x01:
                # Full frame (float32)
                bin_count = (len(message) - 22) // 4
                spectrum_data = np.zeros(bin_count, dtype=np.float32)

                for i in range(bin_count):
                    offset = 22 + i * 4
                    spectrum_data[i] = struct.unpack('<f', message[offset:offset+4])[0]  # little-endian float32

                # Store for delta decoding
                self.binary_spectrum_data = spectrum_data.copy()

            elif flags == 0x02:
                # Delta frame (float32)
                if self.binary_spectrum_data is None:
                    print("Delta frame received before full frame")
                    return None

                change_count = struct.unpack('<H', message[22:24])[0]  # little-endian uint16
                offset = 24

                # Apply changes to previous data
                for i in range(change_count):
                    index = struct.unpack('<H', message[offset:offset+2])[0]  # little-endian uint16
                    value = struct.unpack('<f', message[offset+2:offset+6])[0]  # little-endian float32
                    self.binary_spectrum_data[index] = value
                    offset += 6

                spectrum_data = self.binary_spectrum_data

            elif flags == 0x03:
                # Full frame (uint8) - binary8 format
                bin_count = len(message) - 22
                spectrum_data = np.zeros(bin_count, dtype=np.float32)

                # Read uint8 values and convert to dBFS
                for i in range(bin_count):
                    uint8_value = message[22 + i]
                    # Convert: 0 = -256 dB, 255 = -1 dB
                    spectrum_data[i] = float(uint8_value) - 256.0

                # Store uint8 data for delta decoding
                self.binary_spectrum_data8 = np.frombuffer(message[22:], dtype=np.uint8).copy()

                # Log first binary8 frame
                if not self.binary8_logged:
                    self.binary8_logged = True
                    print('🚀 Binary8 protocol active - 75% bandwidth reduction vs float32!')

            elif flags == 0x04:
                # Delta frame (uint8) - binary8 format
                if self.binary_spectrum_data8 is None:
                    print("Binary8 delta frame received before full frame")
                    return None

                change_count = struct.unpack('<H', message[22:24])[0]  # little-endian uint16
                offset = 24

                # Apply changes to previous uint8 data
                for i in range(change_count):
                    index = struct.unpack('<H', message[offset:offset+2])[0]  # little-endian uint16
                    value = message[offset + 2]  # uint8 value
                    self.binary_spectrum_data8[index] = value
                    offset += 3  # 2 bytes index + 1 byte value

                # Convert uint8 array to float32 for display
                spectrum_data = self.binary_spectrum_data8.astype(np.float32) - 256.0

            else:
                print(f"Unknown flags: {flags}")
                return None

            # Return in same format as JSON messages
            return {
                'type': 'spectrum',
                'data': spectrum_data.tolist(),
                'frequency': frequency,
                'timestamp': timestamp
            }

        except Exception as e:
            print(f"Error parsing binary spectrum: {e}")
            return None

    async def _send_zoom_command(self, frequency: float, bandwidth: float):
        """Send zoom command to set bandwidth.
        
        Args:
            frequency: Center frequency in Hz
            bandwidth: Total bandwidth in Hz (e.g., 200000 for 200 KHz)
        """
        if not self.ws:
            return
        
        # Calculate binBandwidth using the ACTUAL bin count from the server
        # The server told us how many bins it's using in the config message
        if self.bin_count == 0:
            print("ERROR: Cannot send zoom - bin_count not yet received from server")
            return
            
        bin_bandwidth = bandwidth / self.bin_count
        
        command = {
            'type': 'zoom',
            'frequency': int(frequency),
            'binBandwidth': bin_bandwidth
        }
        
        print(f"Sending zoom command: {bandwidth/1000:.1f} KHz / {self.bin_count} bins = {bin_bandwidth:.2f} Hz/bin")
        print(f"  Command: {json.dumps(command)}")
        await self.ws.send(json.dumps(command))
    
    async def _send_pan_command(self, frequency: float):
        """Send pan command to change center frequency.
        
        Args:
            frequency: New center frequency in Hz
        """
        if not self.ws:
            return
        
        command = {
            'type': 'pan',
            'frequency': int(frequency)
        }
        
        await self.ws.send(json.dumps(command))
    
    def update_center_frequency(self, frequency: float):
        """Update tuned frequency and pan spectrum based on center_tune setting.

        Args:
            frequency: New tuned frequency in Hz
        """
        # Constrain frequency to valid range (100 kHz - 30 MHz)
        frequency = max(100000, min(30000000, frequency))

        # Update tuned frequency (this is what we're listening to)
        self.tuned_freq = frequency

        # Check if center tune is enabled (default to True if not set)
        center_tune_enabled = True
        if self.center_tune_var is not None:
            center_tune_enabled = self.center_tune_var.get()

        if self.connected and self.event_loop and self.event_loop.is_running():
            if self.total_bandwidth > 0:
                half_bandwidth = self.total_bandwidth / 2

                if center_tune_enabled:
                    # Center tune enabled - always center on tuned frequency
                    pan_center = frequency

                    # Constrain to keep view within 100 kHz - 30 MHz
                    min_center = 100000 + half_bandwidth
                    max_center = 30000000 - half_bandwidth
                    pan_center = max(min_center, min(max_center, pan_center))

                    asyncio.run_coroutine_threadsafe(
                        self._send_pan_command(pan_center),
                        self.event_loop
                    )
                else:
                    # Center tune disabled - only pan if tuned frequency would be off-screen
                    start_freq = self.center_freq - half_bandwidth
                    end_freq = self.center_freq + half_bandwidth

                    # Only pan if tuned frequency is outside visible range
                    if frequency < start_freq or frequency > end_freq:
                        # Pan to bring tuned frequency into view (10% from edge)
                        if frequency < start_freq:
                            # Tuned freq is off the left - pan to show it at 10% from left edge
                            pan_center = frequency + (half_bandwidth * 0.9)
                        else:
                            # Tuned freq is off the right - pan to show it at 10% from right edge
                            pan_center = frequency - (half_bandwidth * 0.9)

                        # Constrain to keep view within 100 kHz - 30 MHz
                        min_center = 100000 + half_bandwidth
                        max_center = 30000000 - half_bandwidth
                        pan_center = max(min_center, min(max_center, pan_center))

                        asyncio.run_coroutine_threadsafe(
                            self._send_pan_command(pan_center),
                            self.event_loop
                        )
    
    def update_bandwidth(self, low: int, high: int, mode: str = ''):
        """Update filter bandwidth for visualization.

        Args:
            low: Low bandwidth edge in Hz (can be negative)
            high: High bandwidth edge in Hz (can be negative)
            mode: Current demodulation mode (e.g., 'usb', 'iq96')
        """
        self.bandwidth_low = low
        self.bandwidth_high = high
        if mode:
            self.current_mode = mode.lower()
    
    def update_display(self):
        """Update spectrum display (called periodically)."""
        # Process queued spectrum data - draw immediately when data arrives
        try:
            while True:
                queued_item = self.data_queue.get_nowait()
                
                # Handle both old format (just data) and new format (timestamp, data)
                if isinstance(queued_item, tuple) and len(queued_item) == 2:
                    timestamp, spectrum_data = queued_item
                    self.last_spectrum_timestamp = timestamp
                    self.spectrum_data = spectrum_data
                else:
                    self.spectrum_data = queued_item
                
                self._draw_spectrum()
        except queue.Empty:
            pass
        
        # Check for new data frequently (every 10ms) to be responsive
        # Protect against destroyed parent widget
        try:
            self.parent.after(10, self.update_display)
        except (tk.TclError, AttributeError):
            # Parent widget was destroyed, stop the update loop
            pass
    
    def _draw_spectrum(self):
        """Draw spectrum on canvas."""
        if self.spectrum_data is None or len(self.spectrum_data) == 0:
            return
        
        # Check if canvas still exists before attempting to draw
        try:
            if not self.canvas.winfo_exists():
                return
        except (tk.TclError, AttributeError):
            return
        
        # Clear canvas (except tooltip and cursor which we'll redraw)
        self.canvas.delete('all')
        self.tooltip_id = None  # Will be recreated if needed
        self.cursor_line_id = None  # Will be recreated if needed
        
        # Update tooltip with new spectrum data if mouse is over canvas
        should_update_tooltip = (self.last_mouse_x >= 0 and self.last_mouse_y >= 0 and
                                self.last_mouse_x >= self.margin_left and
                                self.last_mouse_x <= self.margin_left + self.graph_width)
        
        # Auto-range dB scale using percentiles for better noise floor detection
        # This matches the approach in the main application (spectrum-display.js)
        valid_data = self.spectrum_data[np.isfinite(self.spectrum_data)]
        if len(valid_data) > 0:
            # Use 1st percentile as true noise floor (captures actual noise floor)
            # Use 99th percentile for signal peaks (ignore extreme outliers)
            p1 = np.percentile(valid_data, 1)   # True noise floor
            p99 = np.percentile(valid_data, 99)  # Signal peaks

            self.min_db = p1 - 2   # Noise floor with minimal margin
            self.max_db = p99 + 5  # Peak with small margin
        
        db_range = self.max_db - self.min_db
        if db_range == 0:
            db_range = 1
        
        # Draw frequency scale
        self._draw_frequency_scale()
        
        # Draw dB scale
        self._draw_db_scale()
        
        # Draw spectrum line
        points = []
        for i, db in enumerate(self.spectrum_data):
            if not np.isfinite(db):
                continue
            
            x = self.margin_left + (i / len(self.spectrum_data)) * self.graph_width
            normalized = (db - self.min_db) / db_range
            y = self.margin_top + self.graph_height - (normalized * self.graph_height)
            points.extend([x, y])
        
        if len(points) >= 4:
            # Draw filled area
            fill_points = [self.margin_left, self.margin_top + self.graph_height] + points + \
                         [self.margin_left + self.graph_width, self.margin_top + self.graph_height]
            self.canvas.create_polygon(fill_points, fill='#1e90ff', outline='', stipple='gray50')
            
            # Draw line
            self.canvas.create_line(points, fill='#00ff00', width=1)
        
        # Draw band backgrounds (behind bookmarks)
        self._draw_band_backgrounds()
        
        # Draw bookmark markers (above spectrum and band backgrounds)
        self._draw_bookmarks()
        
        # Draw bandwidth filter visualization
        self._draw_bandwidth_filter()
        
        # Draw center frequency marker
        self._draw_center_marker()
        
        # Redraw cursor line if visible
        if self.cursor_x >= 0:
            self._draw_cursor_line(self.cursor_x)
        
        # Update and redraw tooltip with current spectrum data if mouse is over canvas
        if should_update_tooltip:
            self._update_tooltip_at_position(self.last_mouse_x, self.last_mouse_y)
    
    def _draw_frequency_scale(self):
        """Draw frequency scale at bottom."""
        if self.total_bandwidth == 0:
            return
        
        start_freq = self.center_freq - self.total_bandwidth / 2
        end_freq = self.center_freq + self.total_bandwidth / 2
        
        # Draw 5 frequency markers
        for i in range(5):
            freq = start_freq + (i / 4) * self.total_bandwidth
            x = self.margin_left + (i / 4) * self.graph_width
            
            # Draw tick
            self.canvas.create_line(x, self.margin_top + self.graph_height,
                                   x, self.margin_top + self.graph_height + 5,
                                   fill='white')
            
            # Draw label
            freq_mhz = freq / 1e6
            label = f"{freq_mhz:.3f}"
            self.canvas.create_text(x, self.margin_top + self.graph_height + 15,
                                   text=label, fill='white', font=('monospace', 9))
    
    def _draw_db_scale(self):
        """Draw dB scale on left side."""
        # Draw 5 dB markers
        for i in range(5):
            db = self.min_db + (i / 4) * (self.max_db - self.min_db)
            y = self.margin_top + self.graph_height - (i / 4) * self.graph_height
            
            # Draw tick
            self.canvas.create_line(self.margin_left - 5, y,
                                   self.margin_left, y,
                                   fill='white')
            
            # Draw label
            label = f"{db:.0f}"
            self.canvas.create_text(self.margin_left - 10, y,
                                   text=label, fill='white', anchor=tk.E,
                                   font=('monospace', 9))
        
        # Draw "dB" label
        self.canvas.create_text(self.margin_left - 25, self.margin_top - 10,
                               text="dB", fill='white', font=('monospace', 9, 'bold'))
    
    def _draw_center_marker(self):
        """Draw marker at tuned frequency."""
        if self.tuned_freq == 0 or self.total_bandwidth == 0:
            return
        
        # Calculate position of tuned frequency in current view
        start_freq = self.center_freq - self.total_bandwidth / 2
        end_freq = self.center_freq + self.total_bandwidth / 2
        
        # Check if tuned frequency is visible in current view
        if self.tuned_freq < start_freq or self.tuned_freq > end_freq:
            return  # Tuned frequency is outside visible range
        
        # Calculate x position for tuned frequency
        freq_offset = self.tuned_freq - start_freq
        x = self.margin_left + (freq_offset / self.total_bandwidth) * self.graph_width
        
        # Draw vertical line
        self.canvas.create_line(x, self.margin_top,
                               x, self.margin_top + self.graph_height,
                               fill='orange', width=2, dash=(5, 5))
        
        # Draw frequency label (centered)
        freq_mhz = self.tuned_freq / 1e6
        self.canvas.create_text(x, self.margin_top - 10,
                               text=f"{freq_mhz:.6f} MHz",
                               fill='orange', font=('monospace', 10, 'bold'))

    def _draw_band_backgrounds(self):
        """Draw colored band backgrounds in the bookmark section."""
        if not self.bands or self.total_bandwidth == 0:
            return

        start_freq = self.center_freq - self.total_bandwidth / 2
        end_freq = self.center_freq + self.total_bandwidth / 2

        # Y position for band backgrounds (same as bookmark section)
        band_y = 5
        band_height = 18  # Height of the colored band area

        # Fill entire bookmark section with light grey to show gaps between bands
        # Only drawn when bands exist (not when self.bands is empty)
        self.canvas.create_rectangle(
            self.margin_left, band_y,
            self.margin_left + self.graph_width, band_y + band_height,
            fill='#d3d3d3',  # Light grey
            outline='',
            stipple='gray50'  # Semi-transparent
        )

        # Sort bands by width (widest first) so narrower bands are drawn on top
        sorted_bands = sorted(self.bands, key=lambda b: b['end'] - b['start'], reverse=True)

        for band in sorted_bands:
            # Check if band overlaps with visible spectrum
            if band['end'] >= start_freq and band['start'] <= end_freq:
                # Calculate pixel positions
                band_start_x = max(self.margin_left,
                                  self.margin_left + ((band['start'] - start_freq) / self.total_bandwidth) * self.graph_width)
                band_end_x = min(self.margin_left + self.graph_width,
                                self.margin_left + ((band['end'] - start_freq) / self.total_bandwidth) * self.graph_width)
                band_width = band_end_x - band_start_x

                if band_width > 0:
                    # Draw semi-transparent colored rectangle
                    color = band.get('color', '#cccccc')
                    self.canvas.create_rectangle(
                        band_start_x, band_y,
                        band_end_x, band_y + band_height,
                        fill=color, outline='', stipple='gray50'
                    )

                    # Draw band label if there's enough space
                    label_text = band.get('label', '')
                    if label_text and band_width > 30:
                        # Prepare label styling
                        label_y = band_y + 2

                        # Calculate label width
                        # Approximate: 7 pixels per character
                        text_width = len(label_text) * 7
                        padding = 2
                        label_width = text_width + padding * 2

                        # Determine label positions based on band width
                        min_width_for_label = 30
                        min_width_for_multiple = 180

                        if band_width < min_width_for_label:
                            # Too narrow for any labels
                            continue
                        elif band_width < min_width_for_multiple:
                            # Single label in center
                            if label_width <= band_width:
                                label_x = band_start_x + band_width / 2
                                # Draw label background
                                self.canvas.create_rectangle(
                                    label_x - label_width / 2, label_y,
                                    label_x + label_width / 2, label_y + 10,
                                    fill='white', outline=''
                                )
                                # Draw label text
                                self.canvas.create_text(
                                    label_x, label_y + 5,
                                    text=label_text, fill='black',
                                    font=('monospace', 9, 'bold')
                                )
                        else:
                            # Multiple labels at regular intervals
                            intelligent_spacing = max(180, label_width + 20)
                            num_labels = max(2, int(band_width / intelligent_spacing) + 1)
                            actual_spacing = band_width / (num_labels - 1)

                            for i in range(num_labels):
                                label_x = band_start_x + (i * actual_spacing)
                                # Clamp to band boundaries
                                label_x = max(band_start_x + label_width / 2,
                                            min(band_end_x - label_width / 2, label_x))

                                # Draw label background
                                self.canvas.create_rectangle(
                                    label_x - label_width / 2, label_y,
                                    label_x + label_width / 2, label_y + 10,
                                    fill='white', outline=''
                                )
                                # Draw label text
                                self.canvas.create_text(
                                    label_x, label_y + 5,
                                    text=label_text, fill='black',
                                    font=('monospace', 9, 'bold')
                                )

    def _draw_bookmarks(self):
        """Draw bookmark markers in the bookmark section above spectrum."""
        if not self.bookmarks or self.total_bandwidth == 0:
            return
        
        start_freq = self.center_freq - self.total_bandwidth / 2
        end_freq = self.center_freq + self.total_bandwidth / 2
        
        # Y position for bookmarks (in the bookmark section above spectrum, above the orange frequency readout)
        # Orange frequency is at margin_top - 10
        # To position bookmarks HIGHER (closer to top of canvas), we subtract MORE from margin_top
        bookmark_y = 5  # Position 5px from absolute top of canvas
        
        for bookmark in self.bookmarks:
            freq = bookmark.get('frequency', 0)
            name = bookmark.get('name', 'Unknown')
            is_local = bookmark.get('is_local', False)
            
            # Only draw if bookmark is within visible range
            if freq < start_freq or freq > end_freq:
                continue

            # Calculate x position
            freq_offset = freq - start_freq
            x = self.margin_left + (freq_offset / self.total_bandwidth) * self.graph_width

            # Draw bookmark label with color based on type
            label_width = len(name) * 7 + 8
            label_height = 12

            # Choose color: cyan for local bookmarks, gold for server bookmarks
            bg_color = '#00CED1' if is_local else '#FFD700'  # DarkTurquoise for local, Gold for server

            # Background rectangle
            self.canvas.create_rectangle(
                x - label_width / 2, bookmark_y,
                x + label_width / 2, bookmark_y + label_height,
                fill=bg_color, outline='white', width=1
            )

            # Black text on colored background
            self.canvas.create_text(
                x, bookmark_y + 6,
                text=name, fill='black',
                font=('monospace', 9, 'bold')
            )

            # Draw downward arrow below label
            arrow_y = bookmark_y + label_height
            arrow_length = 6

            # Arrow triangle (same color as background with white border)
            arrow_points = [
                x, arrow_y + arrow_length,  # Tip
                x - 4, arrow_y,              # Left
                x + 4, arrow_y               # Right
            ]
            self.canvas.create_polygon(
                arrow_points,
                fill=bg_color, outline='white', width=1
            )
   
    def _on_bookmark_click(self, bookmark):
        """Handle bookmark marker click - tune to bookmark frequency, mode, and bandwidth."""
        freq = bookmark.get('frequency', 0)
        mode = bookmark.get('mode', 'USB').upper()

        if freq and self.frequency_callback:
            # Call the frequency callback with the bookmark frequency
            self.frequency_callback(float(freq))

        # Call the mode callback with the bookmark mode
        if mode and self.mode_callback:
            self.mode_callback(mode)

        # Call the bandwidth callback with the bookmark bandwidth if available
        bandwidth_low = bookmark.get('bandwidth_low')
        bandwidth_high = bookmark.get('bandwidth_high')
        if bandwidth_low is not None and bandwidth_high is not None:
            if self.bandwidth_callback:
                self.bandwidth_callback(bandwidth_low, bandwidth_high)

    def _draw_bandwidth_filter(self):
        """Draw bandwidth filter visualization with yellow lines and fill.

        For IQ modes, the bandwidth is determined by the sample rate:
        - iq48: ±24 kHz (48 kHz sample rate)
        - iq96: ±48 kHz (96 kHz sample rate)
        - iq192: ±96 kHz (192 kHz sample rate)
        - iq384: ±192 kHz (384 kHz sample rate)
        """
        if self.total_bandwidth == 0 or self.tuned_freq == 0:
            return

        start_freq = self.center_freq - self.total_bandwidth / 2
        end_freq = self.center_freq + self.total_bandwidth / 2

        # Determine bandwidth based on mode
        # For IQ modes, bandwidth is ±(sample_rate/2) from tuned frequency
        if self.current_mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384'):
            # Extract sample rate from mode name (e.g., 'iq96' -> 96 kHz)
            if self.current_mode == 'iq' or self.current_mode == 'iq48':
                sample_rate = 48000  # 48 kHz
            elif self.current_mode == 'iq96':
                sample_rate = 96000  # 96 kHz
            elif self.current_mode == 'iq192':
                sample_rate = 192000  # 192 kHz
            elif self.current_mode == 'iq384':
                sample_rate = 384000  # 384 kHz
            else:
                sample_rate = 48000  # Default fallback

            # IQ bandwidth is ±(sample_rate/2)
            half_bandwidth = sample_rate / 2
            filter_low_freq = self.tuned_freq - half_bandwidth
            filter_high_freq = self.tuned_freq + half_bandwidth
        else:
            # Audio modes: use bandwidth_low and bandwidth_high
            filter_low_freq = self.tuned_freq + self.bandwidth_low
            filter_high_freq = self.tuned_freq + self.bandwidth_high
        
        # Check if any part of the filter is visible in current view
        # Don't return early - clip to visible range instead
        if filter_high_freq < start_freq or filter_low_freq > end_freq:
            return  # Filter is completely outside visible range
        
        # Clip filter edges to visible range
        filter_low_freq = max(filter_low_freq, start_freq)
        filter_high_freq = min(filter_high_freq, end_freq)
        
        # Calculate x positions for filter edges
        low_x = self.margin_left + ((filter_low_freq - start_freq) / self.total_bandwidth) * self.graph_width
        high_x = self.margin_left + ((filter_high_freq - start_freq) / self.total_bandwidth) * self.graph_width
        
        # Draw semi-transparent yellow fill for filter bandwidth
        self.canvas.create_rectangle(
            low_x, self.margin_top,
            high_x, self.margin_top + self.graph_height,
            fill='yellow', stipple='gray50', outline=''
        )
        
        # Draw solid yellow lines at filter edges (only if they're within visible range)
        # For IQ modes, the edges might extend beyond the visible spectrum
        if low_x > self.margin_left:
            self.canvas.create_line(
                low_x, self.margin_top,
                low_x, self.margin_top + self.graph_height,
                fill='yellow', width=2
            )
        if high_x < self.margin_left + self.graph_width:
            self.canvas.create_line(
                high_x, self.margin_top,
                high_x, self.margin_top + self.graph_height,
                fill='yellow', width=2
            )
    
    def on_mouse_down(self, event):
        """Handle mouse button press - start drag operation.

        Args:
            event: Mouse event
        """
        self.dragging = True
        self.drag_start_x = event.x
        self.drag_start_freq = self.center_freq

    def on_mouse_up(self, event):
        """Handle mouse button release - end drag or process click.

        Args:
            event: Mouse event
        """
        if self.dragging:
            # Check if this was a drag or a click
            drag_distance = abs(event.x - self.drag_start_x)
            if drag_distance < self.drag_threshold:
                # Small movement - treat as click
                self.on_click(event)

        self.dragging = False

    def on_drag(self, event):
        """Handle drag motion - pan spectrum.

        Args:
            event: Mouse event
        """
        if not self.dragging or self.total_bandwidth == 0:
            return

        # Calculate frequency change based on pixel movement
        dx = event.x - self.drag_start_x
        freq_per_pixel = self.total_bandwidth / self.graph_width
        freq_change = -dx * freq_per_pixel  # Negative for natural drag direction

        new_center = self.drag_start_freq + freq_change

        # Constrain to valid range (keep view within 100 kHz - 30 MHz)
        half_bw = self.total_bandwidth / 2
        min_center = 100000 + half_bw
        max_center = 30000000 - half_bw
        new_center = max(min_center, min(max_center, new_center))

        # Check if tuned frequency will be off-screen after pan
        if self.tuned_freq != 0:
            start_freq = new_center - half_bw
            end_freq = new_center + half_bw

            # If tuned frequency is outside the new view, retune to keep it visible
            if self.tuned_freq < start_freq or self.tuned_freq > end_freq:
                # Retune to the edge that's closest to current tuned frequency
                if self.tuned_freq < start_freq:
                    # Tuned freq is off the left edge - retune to left edge
                    new_tuned_freq = start_freq + (half_bw * 0.1)  # 10% from edge
                else:
                    # Tuned freq is off the right edge - retune to right edge
                    new_tuned_freq = end_freq - (half_bw * 0.1)  # 10% from edge

                # Snap to step boundary
                new_tuned_freq = round(new_tuned_freq / self.step_size_hz) * self.step_size_hz

                # Call frequency callback to update tuned frequency
                if self.frequency_callback:
                    self.frequency_callback(new_tuned_freq)

        # Send pan command
        if self.connected and self.event_loop and self.event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._send_pan_command(new_center),
                self.event_loop
            )

    def on_click(self, event):
        """Handle mouse click on spectrum.

        Args:
            event: Mouse event
        """
        # Check if click-to-tune is enabled
        if self.click_tune_var and not self.click_tune_var.get():
            return

        if self.total_bandwidth == 0:
            return

        # Check if click is in bookmark section (above the spectrum graph)
        bookmark_section_bottom = self.margin_top - 10  # Just above orange frequency label
        if event.y < bookmark_section_bottom and self.bookmarks:
            # Click is in bookmark area - check which bookmark was clicked
            start_freq = self.center_freq - self.total_bandwidth / 2
            end_freq = self.center_freq + self.total_bandwidth / 2

            for bookmark in self.bookmarks:
                freq = bookmark.get('frequency', 0)
                # Skip bookmarks outside visible range
                if freq < start_freq or freq > end_freq:
                    continue

                # Calculate bookmark x position
                freq_offset = freq - start_freq
                x = self.margin_left + (freq_offset / self.total_bandwidth) * self.graph_width

                # Check if click is within bookmark bounds (±label_width/2)
                name = bookmark.get('name', 'Unknown')
                label_width = len(name) * 7 + 8
                if abs(event.x - x) < label_width / 2:
                    # Clicked on this bookmark - tune to it
                    self._on_bookmark_click(bookmark)
                    return

        # Calculate clicked frequency (normal frequency tuning)
        x = event.x - self.margin_left
        if x < 0 or x > self.graph_width:
            return

        freq_offset = (x / self.graph_width - 0.5) * self.total_bandwidth
        clicked_freq = self.center_freq + freq_offset

        # Snap to nearest step boundary
        new_freq = round(clicked_freq / self.step_size_hz) * self.step_size_hz

        # Call frequency callback
        if self.frequency_callback:
            self.frequency_callback(new_freq)
    
    def on_scroll_up(self, event):
        """Handle mouse scroll up (Linux).
        
        Args:
            event: Mouse event
        """
        if self.scroll_mode == 'zoom':
            self.zoom_in()
        elif self.frequency_step_callback:
            self.frequency_step_callback(1)  # Step up
    
    def on_scroll_down(self, event):
        """Handle mouse scroll down (Linux).
        
        Args:
            event: Mouse event
        """
        if self.scroll_mode == 'zoom':
            self.zoom_out()
        elif self.frequency_step_callback:
            self.frequency_step_callback(-1)  # Step down
    
    def on_mousewheel(self, event):
        """Handle mouse wheel (Windows/Mac).
        
        Args:
            event: Mouse event
        """
        if self.scroll_mode == 'zoom':
            if event.delta > 0:
                self.zoom_in()
            else:
                self.zoom_out()
        elif self.frequency_step_callback:
            # event.delta is positive for scroll up, negative for scroll down
            direction = 1 if event.delta > 0 else -1
            self.frequency_step_callback(direction)

    def on_resize(self, event):
        """Handle canvas resize event.

        Args:
            event: Configure event with new width and height
        """
        # Update dimensions
        self.width = event.width
        self.height = event.height
        self.graph_height = self.height - self.margin_top - self.margin_bottom
        self.graph_width = self.width - self.margin_left - self.margin_right

        # Redraw spectrum with new dimensions if we have data
        if self.spectrum_data is not None:
            self._draw_spectrum()
    
    def on_motion(self, event):
        """Handle mouse motion for tooltip.
        
        Args:
            event: Mouse event
        """
        if self.total_bandwidth == 0 or self.spectrum_data is None:
            return
        
        # Store mouse position for dynamic tooltip updates
        self.last_mouse_x = event.x
        self.last_mouse_y = event.y
        
        x = event.x - self.margin_left
        if x < 0 or x > self.graph_width:
            # Clear tooltip and cursor when outside graph area
            self.tooltip_text = ""
            self.cursor_x = -1
            self.last_mouse_x = -1
            self.last_mouse_y = -1
            if self.tooltip_id:
                self.canvas.delete(self.tooltip_id)
                self.tooltip_id = None
            if self.cursor_line_id:
                self.canvas.delete(self.cursor_line_id)
                self.cursor_line_id = None
            return
        
        # Store cursor position for redrawing
        self.cursor_x = event.x
        
        # Update tooltip at current position
        self._update_tooltip_at_position(event.x, event.y)
    
    def _update_tooltip_at_position(self, x: int, y: int):
        """Update tooltip content and position based on current spectrum data.
        
        Args:
            x: X coordinate
            y: Y coordinate
        """
        if self.total_bandwidth == 0 or self.spectrum_data is None:
            return
        
        graph_x = x - self.margin_left
        if graph_x < 0 or graph_x > self.graph_width:
            return
        
        # Calculate frequency and dB at cursor
        freq_offset = (graph_x / self.graph_width - 0.5) * self.total_bandwidth
        freq = self.center_freq + freq_offset
        
        # Get dB value at cursor position
        bin_index = int((graph_x / self.graph_width) * len(self.spectrum_data))
        if 0 <= bin_index < len(self.spectrum_data):
            db = self.spectrum_data[bin_index]
            
            # Store tooltip info for redrawing (multi-line format)
            self.tooltip_text = f"{freq/1e6:.6f} MHz\n{db:.1f} dB"
            self.tooltip_x = x
            self.tooltip_y = y
            
            # Draw cursor line
            self._draw_cursor_line(x)
            
            # Draw tooltip
            self._draw_tooltip(x, y, self.tooltip_text)
    
    def _draw_tooltip(self, x: int, y: int, text: str):
        """Draw tooltip at specified position.
        
        Args:
            x: X coordinate
            y: Y coordinate
            text: Tooltip text
        """
        if self.tooltip_id:
            self.canvas.delete(self.tooltip_id)
        
        # Estimate tooltip width (rough approximation: 7 pixels per character)
        tooltip_width = len(text) * 7
        
        # Determine if tooltip should be on left or right of cursor
        # If cursor is in right half of canvas, show tooltip on left
        if x > self.width / 2:
            # Show on left side of cursor
            tooltip_x = x - 10
            anchor = tk.E
        else:
            # Show on right side of cursor
            tooltip_x = x + 10
            anchor = tk.W
        
        self.tooltip_id = self.canvas.create_text(
            tooltip_x, y - 10,
            text=text,
            fill='yellow',
            font=('monospace', 9),
            anchor=anchor
        )
    
    def _draw_cursor_line(self, x: int):
        """Draw vertical cursor line at mouse position.
        
        Args:
            x: X coordinate
        """
        if self.cursor_line_id:
            self.canvas.delete(self.cursor_line_id)
        
        self.cursor_line_id = self.canvas.create_line(
            x, self.margin_top,
            x, self.margin_top + self.graph_height,
            fill='white', width=1, dash=(3, 3)
        )
    
    def set_frequency_callback(self, callback: Callable[[float], None]):
        """Set callback for frequency changes from spectrum clicks.
        
        Args:
            callback: Function to call with new frequency in Hz
        """
        self.frequency_callback = callback
    
    def set_frequency_step_callback(self, callback: Callable[[int], None]):
        """Set callback for frequency stepping from mouse wheel.
        
        Args:
            callback: Function to call with step direction (+1 for up, -1 for down)
        """
        self.frequency_step_callback = callback
    
    def set_mode_callback(self, callback: Callable[[str], None]):
        """Set callback for mode changes from bookmark clicks.
        
        Args:
            callback: Function to call with new mode (e.g., 'USB', 'LSB', 'CW')
        """
        self.mode_callback = callback

    def set_bandwidth_callback(self, callback: Callable[[int, int], None]):
        """Set callback for bandwidth changes from bookmark clicks.

        Args:
            callback: Function to call with bandwidth_low and bandwidth_high in Hz
        """
        self.bandwidth_callback = callback

    def set_step_size(self, step_hz: int):
        """Set frequency step size for click-to-tune snapping.
        
        Args:
            step_hz: Step size in Hz
        """
        self.step_size_hz = step_hz
    
    def set_scroll_mode(self, mode: str):
        """Set scroll mode to 'zoom' or 'pan'.
        
        Args:
            mode: Either 'zoom' or 'pan'
        """
        if mode in ['zoom', 'pan']:
            self.scroll_mode = mode
            print(f"Spectrum scroll mode set to: {mode}")
    
    def zoom_in(self):
        """Zoom in by 2x (halve the bandwidth)."""
        if not self.connected or not self.ws or self.bin_count == 0:
            return
        
        # Halve the bin bandwidth = half the total bandwidth = 2x zoom
        new_bin_bandwidth = self.bin_bandwidth / 2
        
        # Minimum practical limit - let server enforce its own limits
        # Server will adjust bin_count or bandwidth as needed
        if new_bin_bandwidth < 1:
            print(f"Maximum zoom reached (1 Hz/bin minimum)")
            return
        
        # Calculate new total bandwidth
        new_total_bandwidth = new_bin_bandwidth * self.bin_count
        
        # Always center on current tuned frequency (this is where we're listening)
        # If tuned_freq is not set, use center_freq as fallback
        zoom_center = self.tuned_freq if self.tuned_freq != 0 else self.center_freq
        
        # Debug: Show what we're zooming to
        print(f"Zooming to {zoom_center/1e6:.6f} MHz (tuned_freq: {self.tuned_freq/1e6:.6f} MHz)")
        
        # Constrain center frequency to keep view within 100 kHz - 30 MHz
        half_bandwidth = new_total_bandwidth / 2
        min_center = 100000 + half_bandwidth  # 100 kHz + half bandwidth
        max_center = 30000000 - half_bandwidth  # 30 MHz - half bandwidth
        zoom_center = max(min_center, min(max_center, zoom_center))
        
        print(f"Zoom in: {self.total_bandwidth/1000:.1f} KHz -> {new_total_bandwidth/1000:.1f} KHz ({new_bin_bandwidth:.2f} Hz/bin)")
        
        if self.event_loop and self.event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._send_zoom_command(zoom_center, new_total_bandwidth),
                self.event_loop
            )
    
    def zoom_out(self):
        """Zoom out by 2x (double the bandwidth)."""
        if not self.connected or not self.ws or self.bin_count == 0:
            return
        
        # Minimum 1x zoom (can't zoom out past initial bandwidth)
        if self.initial_bin_bandwidth > 0 and self.bin_bandwidth >= self.initial_bin_bandwidth:
            print("Already at full bandwidth")
            return
        
        # Double the bin bandwidth = double the total bandwidth = 0.5x zoom
        new_bin_bandwidth = self.bin_bandwidth * 2
        
        # Don't zoom out past initial bandwidth
        if self.initial_bin_bandwidth > 0 and new_bin_bandwidth > self.initial_bin_bandwidth:
            new_bin_bandwidth = self.initial_bin_bandwidth
        
        # Calculate new total bandwidth
        new_total_bandwidth = new_bin_bandwidth * self.bin_count
        
        # Always center on current tuned frequency (this is where we're listening)
        # If tuned_freq is not set, use center_freq as fallback
        zoom_center = self.tuned_freq if self.tuned_freq != 0 else self.center_freq
        
        # Debug: Show what we're zooming to
        print(f"Zooming to {zoom_center/1e6:.6f} MHz (tuned_freq: {self.tuned_freq/1e6:.6f} MHz)")
        
        # Constrain center frequency to keep view within 100 kHz - 30 MHz
        half_bandwidth = new_total_bandwidth / 2
        min_center = 100000 + half_bandwidth  # 100 kHz + half bandwidth
        max_center = 30000000 - half_bandwidth  # 30 MHz - half bandwidth
        zoom_center = max(min_center, min(max_center, zoom_center))
        
        print(f"Zoom out: {self.total_bandwidth/1000:.1f} KHz -> {new_total_bandwidth/1000:.1f} KHz ({new_bin_bandwidth:.2f} Hz/bin)")
        
        if self.event_loop and self.event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._send_zoom_command(zoom_center, new_total_bandwidth),
                self.event_loop
            )
    
    def reset_zoom(self):
        """Reset zoom to initial bandwidth (200 KHz default)."""
        if not self.connected or not self.ws or self.bin_count == 0:
            return
        
        # Reset to 200 KHz
        desired_bandwidth = 200000  # 200 KHz
        
        # Center on current tuned frequency or spectrum center
        zoom_center = self.tuned_freq if self.tuned_freq != 0 else self.center_freq
        
        # Constrain center frequency to keep view within 100 kHz - 30 MHz
        half_bandwidth = desired_bandwidth / 2
        min_center = 100000 + half_bandwidth  # 100 kHz + half bandwidth
        max_center = 30000000 - half_bandwidth  # 30 MHz - half bandwidth
        zoom_center = max(min_center, min(max_center, zoom_center))
        
        print(f"Reset zoom to {desired_bandwidth/1000:.1f} KHz")
        
        if self.event_loop and self.event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._send_zoom_command(zoom_center, desired_bandwidth),
                self.event_loop
            )
    
    def get_bandwidth_signal(self, bandwidth_low: int, bandwidth_high: int) -> tuple:
        """Calculate signal metrics within the specified bandwidth.
        
        This matches the main application's signal meter calculation in static/signal-meter.js
        lines 106-112, which finds the peak (maximum) dB value within the bandwidth.
        
        Args:
            bandwidth_low: Low edge of bandwidth in Hz (relative to tuned frequency)
            bandwidth_high: High edge of bandwidth in Hz (relative to tuned frequency)
        
        Returns:
            Tuple of (peak_db, floor_db, snr_db) or (None, None, None) if no data
        """
        if self.spectrum_data is None or len(self.spectrum_data) == 0:
            return (None, None, None)
        
        if self.total_bandwidth == 0 or self.tuned_freq == 0:
            return (None, None, None)
        
        # Calculate absolute frequencies for bandwidth edges
        filter_low_freq = self.tuned_freq + bandwidth_low
        filter_high_freq = self.tuned_freq + bandwidth_high
        
        # Calculate spectrum view range
        start_freq = self.center_freq - self.total_bandwidth / 2
        end_freq = self.center_freq + self.total_bandwidth / 2
        
        # Check if bandwidth is within visible spectrum
        if filter_low_freq < start_freq or filter_high_freq > end_freq:
            return (None, None, None)
        
        # Map frequencies to bin indices
        # Bin index = (freq - start_freq) / total_bandwidth * num_bins
        low_bin = int((filter_low_freq - start_freq) / self.total_bandwidth * len(self.spectrum_data))
        high_bin = int((filter_high_freq - start_freq) / self.total_bandwidth * len(self.spectrum_data))
        
        # Clamp to valid range
        low_bin = max(0, min(len(self.spectrum_data) - 1, low_bin))
        high_bin = max(0, min(len(self.spectrum_data) - 1, high_bin))
        
        # Ensure low < high
        if low_bin >= high_bin:
            return (None, None, None)
        
        # Extract bandwidth data
        bandwidth_data = self.spectrum_data[low_bin:high_bin+1]
        
        # Filter out invalid values
        valid_data = bandwidth_data[np.isfinite(bandwidth_data)]
        
        if len(valid_data) == 0:
            return (None, None, None)
        
        # Find peak (maximum) dB across the bandwidth
        # This matches signal-meter.js lines 106-112
        peak_db = np.max(valid_data)
        
        # For noise floor, use the minimum value in the full spectrum
        # This matches signal-meter.js updateNoiseFloor() method (lines 55-73)
        full_spectrum_valid = self.spectrum_data[np.isfinite(self.spectrum_data)]
        if len(full_spectrum_valid) > 0:
            floor_db = np.min(full_spectrum_valid)
        else:
            floor_db = -120  # Default fallback
        
        # Calculate SNR
        snr_db = peak_db - floor_db
        
        return (peak_db, floor_db, snr_db)
    