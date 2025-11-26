#!/usr/bin/env python3
"""
Spectrum Display Widget for ka9q_ubersdr Python GUI
Displays RF spectrum as a line chart with 200 KHz bandwidth centered on current frequency.
"""

import asyncio
import gzip
import json
import tkinter as tk
from tkinter import Canvas
import websockets
import numpy as np
from typing import Optional, Callable
import threading
import queue
from urllib.parse import urlencode


class SpectrumDisplay:
    """Spectrum display widget showing RF spectrum as a line chart."""
    
    def __init__(self, parent: tk.Widget, width: int = 800, height: int = 200, click_tune_var=None):
        """Initialize spectrum display widget.
        
        Args:
            parent: Parent tkinter widget
            width: Canvas width in pixels
            height: Canvas height in pixels
            click_tune_var: BooleanVar to control click-to-tune behavior
        """
        self.parent = parent
        self.width = width
        self.height = height
        self.click_tune_var = click_tune_var
        
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
        
        # Current tuned frequency and bandwidth (for filter visualization)
        self.tuned_freq: float = 0
        self.bandwidth_low: int = 0
        self.bandwidth_high: int = 0
        
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
        
        # Drawing parameters
        self.margin_top = 30
        self.margin_bottom = 30
        self.margin_left = 50
        self.margin_right = 20
        self.graph_height = height - self.margin_top - self.margin_bottom
        self.graph_width = width - self.margin_left - self.margin_right
        
        # Auto-ranging for dB scale
        self.min_db = -100
        self.max_db = 0
        
        # Mouse interaction
        self.canvas.bind('<Button-1>', self.on_click)
        self.canvas.bind('<Motion>', self.on_motion)
        # Mouse wheel for zoom/pan (Linux/Windows)
        self.canvas.bind('<Button-4>', self.on_scroll_up)  # Linux scroll up
        self.canvas.bind('<Button-5>', self.on_scroll_down)  # Linux scroll down
        self.canvas.bind('<MouseWheel>', self.on_mousewheel)  # Windows/Mac
        
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
    
    def connect(self, server_url: str, frequency: float, user_session_id: str = None, use_tls: bool = False):
        """Connect to spectrum WebSocket.
        
        Args:
            server_url: Server URL (e.g., 'localhost:8080' or 'http://server:8080')
            frequency: Initial tuned frequency in Hz (where we're listening)
            user_session_id: User session ID (same as audio channel UUID)
            use_tls: Whether to use WSS (WebSocket Secure) instead of WS
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
        
        # Add user_session_id query parameter if provided
        if user_session_id:
            params = urlencode({'user_session_id': user_session_id})
            ws_url = f'{ws_url}?{params}'
        
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
            message: JSON message string or binary (gzip compressed)
        """
        try:
            # Check if message is binary (gzip compressed) or text
            if isinstance(message, bytes):
                # Binary message - decompress with gzip
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
                
                # Debug: Print what we received
                print(f"Spectrum config received: {self.bin_count} bins @ {self.bin_bandwidth:.2f} Hz/bin = {self.total_bandwidth/1000:.1f} KHz total (zoom {self.zoom_level:.2f}x)")
                print(f"Server center freq: {server_center_freq/1e6:.6f} MHz, Client center freq: {self.center_freq/1e6:.6f} MHz")
                
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
                if raw_data:
                    # Unwrap FFT bin ordering (same as JavaScript implementation)
                    N = len(raw_data)
                    half_bins = N // 2
                    
                    # Rearrange: [negative freqs, positive freqs]
                    unwrapped = np.array(raw_data[half_bins:] + raw_data[:half_bins])
                    
                    # Queue data for display update
                    self.data_queue.put(unwrapped)
                    
        except json.JSONDecodeError as e:
            print(f"Failed to parse spectrum message: {e}")
    
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
        """Update tuned frequency and pan spectrum if zoomed in.
        
        Args:
            frequency: New tuned frequency in Hz
        """
        # Constrain frequency to valid range (100 kHz - 30 MHz)
        frequency = max(100000, min(30000000, frequency))
        
        # Update tuned frequency (this is what we're listening to)
        self.tuned_freq = frequency
        
        # If zoomed in (not at full bandwidth), pan to follow the tuned frequency
        # This keeps the tuned frequency visible when zoomed in
        if self.connected and self.event_loop and self.event_loop.is_running():
            if self.initial_bin_bandwidth > 0 and self.bin_bandwidth < self.initial_bin_bandwidth:
                # We're zoomed in - pan to follow tuned frequency
                # Constrain to keep view within 100 kHz - 30 MHz
                if self.total_bandwidth > 0:
                    half_bandwidth = self.total_bandwidth / 2
                    min_center = 100000 + half_bandwidth
                    max_center = 30000000 - half_bandwidth
                    pan_center = max(min_center, min(max_center, frequency))
                    
                    asyncio.run_coroutine_threadsafe(
                        self._send_pan_command(pan_center),
                        self.event_loop
                    )
    
    def update_bandwidth(self, low: int, high: int):
        """Update filter bandwidth for visualization.
        
        Args:
            low: Low bandwidth edge in Hz (can be negative)
            high: High bandwidth edge in Hz (can be negative)
        """
        self.bandwidth_low = low
        self.bandwidth_high = high
    
    def update_display(self):
        """Update spectrum display (called periodically)."""
        # Process queued spectrum data - draw immediately when data arrives
        try:
            while True:
                self.spectrum_data = self.data_queue.get_nowait()
                self._draw_spectrum()
        except queue.Empty:
            pass
        
        # Check for new data frequently (every 10ms) to be responsive
        self.parent.after(10, self.update_display)
    
    def _draw_spectrum(self):
        """Draw spectrum on canvas."""
        if self.spectrum_data is None or len(self.spectrum_data) == 0:
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
   
    def _draw_bandwidth_filter(self):
        """Draw bandwidth filter visualization with yellow lines and fill."""
        if self.total_bandwidth == 0 or self.tuned_freq == 0:
            return
        
        start_freq = self.center_freq - self.total_bandwidth / 2
        end_freq = self.center_freq + self.total_bandwidth / 2
        
        # Calculate filter edge frequencies
        filter_low_freq = self.tuned_freq + self.bandwidth_low
        filter_high_freq = self.tuned_freq + self.bandwidth_high
        
        # Check if filter edges are visible in current view
        if filter_low_freq < start_freq or filter_high_freq > end_freq:
            return  # Filter is outside visible range
        
        # Calculate x positions for filter edges
        low_x = self.margin_left + ((filter_low_freq - start_freq) / self.total_bandwidth) * self.graph_width
        high_x = self.margin_left + ((filter_high_freq - start_freq) / self.total_bandwidth) * self.graph_width
        
        # Draw semi-transparent yellow fill for filter bandwidth
        self.canvas.create_rectangle(
            low_x, self.margin_top,
            high_x, self.margin_top + self.graph_height,
            fill='yellow', stipple='gray50', outline=''
        )
        
        # Draw solid yellow lines at filter edges
        self.canvas.create_line(
            low_x, self.margin_top,
            low_x, self.margin_top + self.graph_height,
            fill='yellow', width=2
        )
        self.canvas.create_line(
            high_x, self.margin_top,
            high_x, self.margin_top + self.graph_height,
            fill='yellow', width=2
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
        
        # Calculate clicked frequency
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
    