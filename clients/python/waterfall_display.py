#!/usr/bin/env python3
"""
Waterfall Display Widget for ka9q_ubersdr Python GUI
Displays RF spectrum as a waterfall with frequency along the top.
"""

import asyncio
import gzip
import json
import tkinter as tk
from tkinter import Canvas, Toplevel
import websockets
import numpy as np
from typing import Optional, Callable
import threading
import queue
from urllib.parse import urlencode
from collections import deque
from PIL import Image, ImageTk


class WaterfallDisplay:
    """Waterfall display widget showing RF spectrum as a scrolling waterfall.
    
    This display shares data with the spectrum display instead of creating
    its own WebSocket connection.
    """
    
    def __init__(self, parent: tk.Widget, spectrum_display, width: int = 800, height: int = 400, spectrum_height: int = 200, click_tune_var=None, bookmarks: list = None):
        """Initialize waterfall display widget.
        
        Args:
            parent: Parent tkinter widget (can be Toplevel window or Frame)
            spectrum_display: SpectrumDisplay instance to share data with
            width: Canvas width in pixels
            height: Canvas height in pixels (for waterfall only)
            spectrum_height: Height of spectrum display on top (unused, kept for compatibility)
            click_tune_var: BooleanVar to control click-to-tune behavior
            bookmarks: List of bookmark dictionaries with 'name', 'frequency', 'mode' keys
        """
        self.parent = parent
        self.width = width
        self.height = height
        self.spectrum_height = spectrum_height
        self.spectrum_display = spectrum_display
        self.click_tune_var = click_tune_var
        self.bookmarks = bookmarks or []

        # Share cursor tracking with spectrum display
        self.shared_cursor_x = -1

        # Drag state for click-and-drag panning
        self.dragging = False
        self.drag_start_x = 0
        self.drag_start_freq = 0
        self.drag_threshold = 5  # Pixels - movement less than this is considered a click
        
        # Create canvas for waterfall display (no container needed - parent handles layout)
        self.canvas = Canvas(parent, width=width, height=height, bg='#000000', highlightthickness=0)
        self.canvas.pack(side=tk.TOP, fill=tk.BOTH, expand=True, pady=0)
        
        # Spectrum data (shared from spectrum display)
        self.spectrum_data: Optional[np.ndarray] = None
        
        # Current tuned frequency and bandwidth (for filter visualization)
        self.tuned_freq: float = 0
        self.bandwidth_low: int = 0
        self.bandwidth_high: int = 0
        
        # Frequency step size for click-to-tune snapping (in Hz)
        self.step_size_hz: int = 1000  # Default 1 kHz
        
        # Scroll mode (zoom or pan) - delegates to spectrum display
        self.scroll_mode: str = 'zoom'  # 'zoom' or 'pan'
        
        # Frequency change callback
        self.frequency_callback: Optional[Callable[[float], None]] = None
        self.frequency_step_callback: Optional[Callable[[int], None]] = None
        
        # Drawing parameters - no top margin since frequency scale is in spectrum
        self.margin_top = 0  # No top margin - connects directly to spectrum
        self.margin_bottom = 10
        self.margin_left = 50  # Match spectrum's left margin for dB scale alignment
        self.margin_right = 20
        self.waterfall_height = height - self.margin_top - self.margin_bottom
        self.waterfall_width = width - self.margin_left - self.margin_right
        
        # Waterfall history (store recent spectrum lines)
        self.max_history = self.waterfall_height  # One line per pixel
        self.history = deque(maxlen=self.max_history)
        
        # Track timestamps for auto-leveling based on time window
        self.history_timestamps = deque(maxlen=self.max_history)
        self.auto_level_window_seconds = 2.0  # Use last 2 seconds for auto-leveling
        
        # Color mapping for dB values
        self.min_db = -100
        self.max_db = 0
        
        # Waterfall image (PIL Image for efficient pixel manipulation)
        self.waterfall_array = np.zeros((self.waterfall_height, self.waterfall_width, 3), dtype=np.uint8)
        self.waterfall_image = None
        self.waterfall_photo = None
        self.waterfall_canvas_image = None
        
        # Mouse interaction - support click-and-drag panning
        self.canvas.bind('<ButtonPress-1>', self.on_mouse_down)
        self.canvas.bind('<ButtonRelease-1>', self.on_mouse_up)
        self.canvas.bind('<B1-Motion>', self.on_drag)
        self.canvas.bind('<Motion>', self.on_motion)
        # Mouse wheel for frequency stepping
        self.canvas.bind('<Button-4>', self.on_scroll_up)  # Linux scroll up
        self.canvas.bind('<Button-5>', self.on_scroll_down)  # Linux scroll down
        self.canvas.bind('<MouseWheel>', self.on_mousewheel)  # Windows/Mac
        # Window resize handling
        self.canvas.bind('<Configure>', self.on_resize)
        
        # Tooltip and cursor
        self.tooltip_id = None
        self.tooltip_bg_id = None  # Track background rectangle
        self.cursor_line_id = None
        self.cursor_x = -1
        self.last_mouse_x = -1
        self.last_mouse_y = -1
        
        # Start update loop
        self.update_display()
    
    def disconnect(self):
        """Disconnect waterfall (no-op since we share spectrum's connection)."""
        pass
    
    def update_center_frequency(self, frequency: float):
        """Update waterfall center frequency."""
        self.tuned_freq = frequency
    
    def update_bandwidth(self, low: int, high: int, mode: str = ''):
        """Update filter bandwidth for visualization.

        Args:
            low: Low frequency offset in Hz
            high: High frequency offset in Hz
            mode: Current mode (e.g., 'usb', 'iq96', etc.)
        """
        self.bandwidth_low = low
        self.bandwidth_high = high
        self.current_mode = mode.lower() if mode else 'usb'
    
    def update_display(self):
        """Update waterfall display (called periodically)."""
        # Get spectrum data from shared spectrum display
        if self.spectrum_display and self.spectrum_display.spectrum_data is not None:
            # Check if we have new data
            new_data = self.spectrum_display.spectrum_data
            if self.spectrum_data is None or not np.array_equal(new_data, self.spectrum_data):
                self.spectrum_data = new_data.copy()
                # Add to history with timestamp
                import time
                current_time = time.time()
                self.history.append(self.spectrum_data.copy())
                self.history_timestamps.append(current_time)
                self._draw_waterfall()
        
        # Check for new data frequently
        try:
            self.parent.after(10, self.update_display)
        except (tk.TclError, AttributeError):
            # Parent widget was destroyed, stop the update loop
            pass
    
    def _db_to_rgb(self, db: float) -> tuple:
        """Convert dB value to RGB color tuple.
        
        Args:
            db: dB value
            
        Returns:
            Tuple of (r, g, b) values (0-255)
        """
        # Normalize dB to 0-1 range
        db_range = self.max_db - self.min_db
        if db_range == 0:
            normalized = 0.5  # Default to middle color if no range
        else:
            normalized = (db - self.min_db) / db_range
            normalized = max(0, min(1, normalized))
        
        # Color gradient: blue (low) -> cyan -> green -> yellow -> red (high)
        if normalized < 0.25:
            # Blue to cyan
            t = normalized / 0.25
            r = 0
            g = int(t * 255)
            b = 255
        elif normalized < 0.5:
            # Cyan to green
            t = (normalized - 0.25) / 0.25
            r = 0
            g = 255
            b = int((1 - t) * 255)
        elif normalized < 0.75:
            # Green to yellow
            t = (normalized - 0.5) / 0.25
            r = int(t * 255)
            g = 255
            b = 0
        else:
            # Yellow to red
            t = (normalized - 0.75) / 0.25
            r = 255
            g = int((1 - t) * 255)
            b = 0
        
        return (r, g, b)
    
    def _draw_waterfall(self):
        """Draw waterfall on canvas using PIL Image for efficiency."""
        if len(self.history) == 0 or self.spectrum_display is None:
            return
        
        # Check if canvas still exists before attempting to draw
        try:
            if not self.canvas.winfo_exists():
                return
        except (tk.TclError, AttributeError):
            return
        
        # Use auto-ranging based on last 2 seconds of data for better contrast
        # Use percentiles to focus on signal range and ignore extreme noise
        import time
        current_time = time.time()
        cutoff_time = current_time - self.auto_level_window_seconds
        
        # Collect data from last 2 seconds only
        recent_data = []
        for i, timestamp in enumerate(self.history_timestamps):
            if timestamp >= cutoff_time:
                recent_data.append(self.history[i])
        
        if len(recent_data) > 0:
            all_data = np.concatenate(recent_data)
            valid_data = all_data[np.isfinite(all_data)]
            if len(valid_data) > 0:
                # Use 1st percentile as true noise floor (captures actual noise floor)
                # This captures the actual noise floor, not the signal floor
                p1 = np.percentile(valid_data, 1)   # True noise floor
                p99 = np.percentile(valid_data, 99)  # Signal peaks
                
                # Set min_db to noise floor minus minimal margin (2 dB)
                # This ensures noise appears in the blue range properly
                self.min_db = p1 - 2
                self.max_db = p99 + 5
                
                # Ensure minimum range for visibility (at least 30 dB total range)
                if self.max_db - self.min_db < 30:
                    self.max_db = self.min_db + 30
            else:
                # Fallback to spectrum's range
                self.min_db = self.spectrum_display.min_db
                self.max_db = self.spectrum_display.max_db
        else:
            # Fallback to spectrum's range if no recent data
            self.min_db = self.spectrum_display.min_db
            self.max_db = self.spectrum_display.max_db
        
        # Scroll waterfall down by one line
        self.waterfall_array[1:] = self.waterfall_array[:-1]
        
        # Add newest spectrum line at top
        if len(self.history) > 0:
            spectrum = self.history[-1]  # Most recent
            
            # Convert spectrum to RGB colors
            for x_idx in range(self.waterfall_width):
                # Map x position to bin index
                bin_idx = int((x_idx / self.waterfall_width) * len(spectrum))
                if bin_idx >= len(spectrum):
                    bin_idx = len(spectrum) - 1
                
                db = spectrum[bin_idx]
                if np.isfinite(db):
                    r, g, b = self._db_to_rgb(db)
                    self.waterfall_array[0, x_idx] = [r, g, b]
        
        # Convert numpy array to PIL Image
        self.waterfall_image = Image.fromarray(self.waterfall_array, mode='RGB')
        self.waterfall_photo = ImageTk.PhotoImage(self.waterfall_image)
        
        # Clear canvas and redraw
        self.canvas.delete('all')
        self.tooltip_id = None
        self.tooltip_bg_id = None
        self.cursor_line_id = None
        
        # Draw waterfall image
        self.waterfall_canvas_image = self.canvas.create_image(
            self.margin_left, self.margin_top,
            image=self.waterfall_photo, anchor=tk.NW
        )
        
        # Draw frequency scale at top
        self._draw_frequency_scale()
        
        # Draw bandwidth filter visualization
        self._draw_bandwidth_filter()
        
        # Redraw cursor line if visible
        if self.cursor_x >= 0:
            self._draw_cursor_line(self.cursor_x)
        
        # Update tooltip if mouse is over canvas
        if self.last_mouse_x >= 0 and self.last_mouse_y >= 0:
            self._update_tooltip_at_position(self.last_mouse_x, self.last_mouse_y)
    
    def _draw_frequency_scale(self):
        """Draw frequency scale - now handled by spectrum display above."""
        # Frequency scale is now drawn by the spectrum display above
        # No need to draw it here anymore
        pass
    
    def _draw_bandwidth_filter(self):
        """Draw bandwidth filter visualization with yellow overlay."""
        if not self.spectrum_display or self.spectrum_display.total_bandwidth == 0 or self.tuned_freq == 0:
            return
        
        center_freq = self.spectrum_display.center_freq
        total_bandwidth = self.spectrum_display.total_bandwidth
        start_freq = center_freq - total_bandwidth / 2
        end_freq = center_freq + total_bandwidth / 2
        
        # Check if this is an IQ mode - if so, use full IQ bandwidth instead of slider values
        if hasattr(self, 'current_mode') and self.current_mode in ['iq', 'iq48', 'iq96', 'iq192', 'iq384']:
            # IQ mode: bandwidth is ±(sample_rate/2) from tuned frequency
            # Extract sample rate from mode name
            if self.current_mode == 'iq' or self.current_mode == 'iq48':
                sample_rate = 48000
            elif self.current_mode == 'iq96':
                sample_rate = 96000
            elif self.current_mode == 'iq192':
                sample_rate = 192000
            elif self.current_mode == 'iq384':
                sample_rate = 384000
            else:
                sample_rate = 48000

            # IQ bandwidth is ±(sample_rate/2)
            bw_low = -sample_rate // 2
            bw_high = sample_rate // 2
        else:
            # Non-IQ mode: use slider values
            bw_low = self.bandwidth_low
            bw_high = self.bandwidth_high

        # Calculate filter edge frequencies
        filter_low_freq = self.tuned_freq + bw_low
        filter_high_freq = self.tuned_freq + bw_high
        
        # Check if filter edges are visible
        if filter_low_freq < start_freq or filter_high_freq > end_freq:
            return
        
        # Calculate x positions
        low_x = self.margin_left + ((filter_low_freq - start_freq) / total_bandwidth) * self.waterfall_width
        high_x = self.margin_left + ((filter_high_freq - start_freq) / total_bandwidth) * self.waterfall_width
        
        # Draw semi-transparent yellow overlay
        self.canvas.create_rectangle(
            low_x, self.margin_top,
            high_x, self.margin_top + self.waterfall_height,
            fill='yellow', stipple='gray25', outline=''
        )
        
        # Draw solid yellow lines at filter edges
        self.canvas.create_line(
            low_x, self.margin_top,
            low_x, self.margin_top + self.waterfall_height,
            fill='yellow', width=2
        )
        self.canvas.create_line(
            high_x, self.margin_top,
            high_x, self.margin_top + self.waterfall_height,
            fill='yellow', width=2
        )
    
    def on_mouse_down(self, event):
        """Handle mouse button press - start drag operation.

        Args:
            event: Mouse event
        """
        if not self.spectrum_display:
            return

        self.dragging = True
        self.drag_start_x = event.x
        self.drag_start_freq = self.spectrum_display.center_freq

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
        """Handle drag motion - pan spectrum (delegates to spectrum display).

        Args:
            event: Mouse event
        """
        if not self.dragging or not self.spectrum_display or self.spectrum_display.total_bandwidth == 0:
            return

        # Calculate frequency change based on pixel movement
        dx = event.x - self.drag_start_x
        freq_per_pixel = self.spectrum_display.total_bandwidth / self.waterfall_width
        freq_change = -dx * freq_per_pixel  # Negative for natural drag direction

        new_center = self.drag_start_freq + freq_change

        # Constrain to valid range (keep view within 10 kHz - 30 MHz)
        half_bw = self.spectrum_display.total_bandwidth / 2
        min_center = 10000 + half_bw
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

        # Send pan command via spectrum display
        if self.spectrum_display.connected and self.spectrum_display.event_loop and self.spectrum_display.event_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self.spectrum_display._send_pan_command(new_center),
                self.spectrum_display.event_loop
            )

    def on_click(self, event):
        """Handle mouse click on waterfall."""
        # Check if click-to-tune is enabled
        if self.click_tune_var and not self.click_tune_var.get():
            return

        if not self.spectrum_display or self.spectrum_display.total_bandwidth == 0:
            return

        # Calculate clicked frequency
        x = event.x - self.margin_left
        if x < 0 or x > self.waterfall_width:
            return

        center_freq = self.spectrum_display.center_freq
        total_bandwidth = self.spectrum_display.total_bandwidth
        freq_offset = (x / self.waterfall_width - 0.5) * total_bandwidth
        clicked_freq = center_freq + freq_offset

        # Snap to nearest step boundary
        new_freq = round(clicked_freq / self.step_size_hz) * self.step_size_hz

        # Call frequency callback
        if self.frequency_callback:
            self.frequency_callback(new_freq)
    
    def on_scroll_up(self, event):
        """Handle mouse scroll up (Linux)."""
        if self.scroll_mode == 'zoom' and self.spectrum_display:
            self.spectrum_display.zoom_in()
        elif self.frequency_step_callback:
            self.frequency_step_callback(1)
    
    def on_scroll_down(self, event):
        """Handle mouse scroll down (Linux)."""
        if self.scroll_mode == 'zoom' and self.spectrum_display:
            self.spectrum_display.zoom_out()
        elif self.frequency_step_callback:
            self.frequency_step_callback(-1)
    
    def on_mousewheel(self, event):
        """Handle mouse wheel (Windows/Mac)."""
        if self.scroll_mode == 'zoom' and self.spectrum_display:
            if event.delta > 0:
                self.spectrum_display.zoom_in()
            else:
                self.spectrum_display.zoom_out()
        elif self.frequency_step_callback:
            direction = 1 if event.delta > 0 else -1
            self.frequency_step_callback(direction)

    def on_resize(self, event):
        """Handle canvas resize event.

        Args:
            event: Configure event with new width and height
        """
        old_width = self.waterfall_width
        old_height = self.waterfall_height

        # Update dimensions
        self.width = event.width
        self.height = event.height
        self.waterfall_height = self.height - self.margin_top - self.margin_bottom
        self.waterfall_width = self.width - self.margin_left - self.margin_right

        # Resize waterfall array if dimensions changed
        if old_width != self.waterfall_width or old_height != self.waterfall_height:
            # Create new array with new dimensions
            new_array = np.zeros((self.waterfall_height, self.waterfall_width, 3), dtype=np.uint8)

            # If we have existing data, scale it to fit new dimensions
            if self.waterfall_array.size > 0:
                try:
                    from scipy.ndimage import zoom
                    scale_y = self.waterfall_height / old_height if old_height > 0 else 1
                    scale_x = self.waterfall_width / old_width if old_width > 0 else 1
                    new_array = zoom(self.waterfall_array, (scale_y, scale_x, 1), order=1).astype(np.uint8)
                except ImportError:
                    # If scipy is not available, use simple numpy resize
                    # This is less smooth but works without scipy
                    if old_height > 0 and old_width > 0:
                        # Simple nearest-neighbor resize
                        for y in range(self.waterfall_height):
                            old_y = int(y * old_height / self.waterfall_height)
                            for x in range(self.waterfall_width):
                                old_x = int(x * old_width / self.waterfall_width)
                                if old_y < old_height and old_x < old_width:
                                    new_array[y, x] = self.waterfall_array[old_y, old_x]

            self.waterfall_array = new_array

            # Update history size
            self.max_history = self.waterfall_height

        # Redraw waterfall with new dimensions
        self._draw_waterfall()
    
    def on_motion(self, event):
        """Handle mouse motion for tooltip - shares cursor with spectrum."""
        if not self.spectrum_display or self.spectrum_display.total_bandwidth == 0:
            return
        
        self.last_mouse_x = event.x
        self.last_mouse_y = event.y
        
        x = event.x - self.margin_left
        if x < 0 or x > self.waterfall_width:
            # Clear tooltip and cursor
            self.cursor_x = -1
            self.last_mouse_x = -1
            self.last_mouse_y = -1
            self.shared_cursor_x = -1
            if self.tooltip_id:
                self.canvas.delete(self.tooltip_id)
                self.tooltip_id = None
            if self.tooltip_bg_id:
                self.canvas.delete(self.tooltip_bg_id)
                self.tooltip_bg_id = None
            if self.cursor_line_id:
                self.canvas.delete(self.cursor_line_id)
                self.cursor_line_id = None
            # Also clear spectrum's cursor
            if self.spectrum_display:
                self.spectrum_display.cursor_x = -1
                if self.spectrum_display.cursor_line_id:
                    self.spectrum_display.canvas.delete(self.spectrum_display.cursor_line_id)
                    self.spectrum_display.cursor_line_id = None
            return
        
        self.cursor_x = event.x
        self.shared_cursor_x = event.x
        
        # Update spectrum's cursor too
        if self.spectrum_display:
            self.spectrum_display.cursor_x = event.x
            self.spectrum_display._draw_cursor_line(event.x)
        
        self._update_tooltip_at_position(event.x, event.y)
    
    def _update_tooltip_at_position(self, x: int, y: int):
        """Update tooltip at position."""
        if not self.spectrum_display or self.spectrum_display.total_bandwidth == 0:
            return
        
        graph_x = x - self.margin_left
        if graph_x < 0 or graph_x > self.waterfall_width:
            return
        
        # Calculate frequency at cursor
        center_freq = self.spectrum_display.center_freq
        total_bandwidth = self.spectrum_display.total_bandwidth
        freq_offset = (graph_x / self.waterfall_width - 0.5) * total_bandwidth
        freq = center_freq + freq_offset
        
        # Get dB value from spectrum if available
        if self.spectrum_display.spectrum_data is not None and len(self.spectrum_display.spectrum_data) > 0:
            bin_index = int((graph_x / self.waterfall_width) * len(self.spectrum_display.spectrum_data))
            if 0 <= bin_index < len(self.spectrum_display.spectrum_data):
                db = self.spectrum_display.spectrum_data[bin_index]
                tooltip_text = f"{freq/1e6:.6f} MHz\n{db:.1f} dB"
            else:
                tooltip_text = f"{freq/1e6:.6f} MHz"
        else:
            tooltip_text = f"{freq/1e6:.6f} MHz"
        
        # Draw cursor line in both spectrum and waterfall
        self._draw_cursor_line(x)
        
        # Draw tooltip on waterfall canvas
        # If mouse is over spectrum, adjust y to be relative to waterfall canvas
        if y < self.spectrum_display.height:
            # Mouse is over spectrum - use y position relative to waterfall
            tooltip_y = y + 10  # Small offset below cursor
        else:
            # Mouse is over waterfall - adjust for spectrum height
            tooltip_y = y - self.spectrum_display.height
        
        self._draw_tooltip(x, tooltip_y, tooltip_text)
    
    def _draw_tooltip(self, x: int, y: int, text: str):
        """Draw tooltip at position with white background and black text on waterfall canvas."""
        # Delete previous tooltip
        if self.tooltip_bg_id:
            self.canvas.delete(self.tooltip_bg_id)
            self.tooltip_bg_id = None
        if self.tooltip_id:
            self.canvas.delete(self.tooltip_id)
            self.tooltip_id = None
        
        # Position tooltip
        if x > self.width / 2:
            tooltip_x = x - 10
            anchor = tk.E
        else:
            tooltip_x = x + 10
            anchor = tk.W
        
        # Create white background rectangle for tooltip
        # Estimate text size for multi-line text
        lines = text.split('\n')
        text_width = max(len(line) for line in lines) * 7
        text_height = len(lines) * 14
        
        if anchor == tk.E:
            # Text anchored to right
            bg_x1 = tooltip_x - text_width - 4
            bg_x2 = tooltip_x + 2
        else:
            # Text anchored to left
            bg_x1 = tooltip_x - 2
            bg_x2 = tooltip_x + text_width + 4
        
        bg_y1 = y - 10 - text_height // 2 - 2
        bg_y2 = y - 10 + text_height // 2 + 2
        
        # Draw background and track its ID
        self.tooltip_bg_id = self.canvas.create_rectangle(
            bg_x1, bg_y1, bg_x2, bg_y2,
            fill='white', outline='black', width=1
        )
        
        # Draw text
        self.tooltip_id = self.canvas.create_text(
            tooltip_x, y - 10,
            text=text,
            fill='black',
            font=('monospace', 9, 'bold'),
            anchor=anchor
        )
    
    def _draw_cursor_line(self, x: int):
        """Draw vertical cursor line."""
        if self.cursor_line_id:
            self.canvas.delete(self.cursor_line_id)
        
        self.cursor_line_id = self.canvas.create_line(
            x, self.margin_top,
            x, self.margin_top + self.waterfall_height,
            fill='white', width=1, dash=(3, 3)
        )
    
    def set_frequency_callback(self, callback: Callable[[float], None]):
        """Set callback for frequency changes from clicks."""
        self.frequency_callback = callback
    
    def set_frequency_step_callback(self, callback: Callable[[int], None]):
        """Set callback for frequency stepping from mouse wheel."""
        self.frequency_step_callback = callback
    
    def set_step_size(self, step_hz: int):
        """Set frequency step size for click-to-tune snapping."""
        self.step_size_hz = step_hz
    
    def set_scroll_mode(self, mode: str):
        """Set scroll mode to 'zoom' or 'pan'.
        
        Args:
            mode: Either 'zoom' or 'pan'
        """
        if mode in ['zoom', 'pan']:
            self.scroll_mode = mode
            print(f"Waterfall scroll mode set to: {mode}")


def create_waterfall_window(parent_gui):
    """Create a standalone waterfall window with spectrum on top and waterfall below.
    
    Args:
        parent_gui: Parent RadioGUI instance
        
    Returns:
        Tuple of (window, waterfall_display)
    """
    from spectrum_display import SpectrumDisplay
    
    # Create toplevel window (taller to accommodate title, spectrum and waterfall)
    window = Toplevel(parent_gui.root)
    window.title("Spectrum & Waterfall Display")
    window.geometry("800x650")
    
    # Create container frame
    container = tk.Frame(window, bg='#000000')
    container.pack(fill=tk.BOTH, expand=True)
    
    # Create title and info frame at top
    info_frame = tk.Frame(container, bg='#000000', height=60)
    info_frame.pack(side=tk.TOP, fill=tk.X)
    info_frame.pack_propagate(False)  # Prevent frame from shrinking
    
    # Signal meter (left side, top line) - clickable
    signal_meter_label = tk.Label(info_frame, text="SNR: -- dB",
                                  bg='#000000', fg='#666666',
                                  font=('monospace', 10, 'bold'),
                                  cursor='hand2')
    signal_meter_label.place(x=5, y=15, anchor=tk.W)
    
    # Zoom buttons (left side, below signal meter)
    zoom_out_btn = tk.Button(info_frame, text="−",
                             bg='#333333', fg='white',
                             font=('monospace', 9, 'bold'),
                             width=2,
                             relief=tk.RAISED, bd=1,
                             cursor='hand2',
                             padx=0, pady=0)
    zoom_out_btn.place(x=5, y=35, anchor=tk.W)

    zoom_in_btn = tk.Button(info_frame, text="+",
                            bg='#333333', fg='white',
                            font=('monospace', 9, 'bold'),
                            width=2,
                            relief=tk.RAISED, bd=1,
                            cursor='hand2',
                            padx=0, pady=0)
    zoom_in_btn.place(x=30, y=35, anchor=tk.W)
    
    # Scroll mode selector (between signal meter and title) - stacked vertically
    # Create frame for radio buttons to stack them vertically
    scroll_frame = tk.Frame(info_frame, bg='#000000')
    scroll_frame.place(x=120, y=25, anchor=tk.W)

    from tkinter import ttk
    # Create custom style for radio buttons with black background
    style = ttk.Style()
    style.configure('Black.TRadiobutton', background='#000000', foreground='white')
    # Keep black background on hover/active states
    style.map('Black.TRadiobutton',
              background=[('active', '#000000'), ('!active', '#000000')],
              foreground=[('active', 'white'), ('!active', 'white')])

    zoom_radio = ttk.Radiobutton(scroll_frame, text="Zoom Scroll", variable=parent_gui.scroll_mode_var,
                                value="zoom", command=parent_gui.on_scroll_mode_changed,
                                style='Black.TRadiobutton')
    zoom_radio.pack(side=tk.TOP, anchor=tk.W)

    pan_radio = ttk.Radiobutton(scroll_frame, text="Pan Scroll", variable=parent_gui.scroll_mode_var,
                               value="pan", command=parent_gui.on_scroll_mode_changed,
                               style='Black.TRadiobutton')
    pan_radio.pack(side=tk.TOP, anchor=tk.W)

    # Segmented frequency display (centered) - replaces title and bandwidth labels
    freq_display_frame = tk.Frame(info_frame, bg='#000000')
    freq_display_frame.place(relx=0.5, y=10, anchor=tk.N)
    
    # Create 8 digit labels with separators (format: XX.XXX.XXX MHz)
    freq_digit_labels = []
    freq_digit_steps = [10000000, 1000000, 100000, 10000, 1000, 100, 10, 1]  # Step sizes in Hz
    
    # Create both rows together to ensure perfect alignment
    # Row 1: Digits
    digit_row = tk.Frame(freq_display_frame, bg='#000000')
    digit_row.pack(side=tk.TOP)

    for i in range(8):
        # Create digit label in row 1
        digit_label = tk.Label(digit_row, text="0", bg='#222222', fg='#00ff00',
                              font=('monospace', 16, 'bold'),
                              width=2, relief=tk.RAISED, bd=1,
                              cursor='sb_v_double_arrow')
        digit_label.pack(side=tk.LEFT, padx=1)
        freq_digit_labels.append(digit_label)

        # Store step size as attribute
        digit_label.step_size = freq_digit_steps[i]
        digit_label.digit_index = i

        # Add decimal point separators AFTER digits at positions 1 and 4 (after 2nd and 5th digit)
        if i == 1 or i == 4:
            # Separator in digit row
            sep_digit = tk.Label(digit_row, text=".", bg='#000000', fg='white',
                                font=('monospace', 16, 'bold'))
            sep_digit.pack(side=tk.LEFT)

    # Add MHz label to digit row only
    mhz_label = tk.Label(digit_row, text=" MHz", bg='#000000', fg='white',
                        font=('monospace', 12, 'bold'))
    mhz_label.pack(side=tk.LEFT, padx=5)
    
    # Function to update frequency display
    def update_freq_display():
        """Update all digit labels from current frequency."""
        try:
            freq_hz = parent_gui.get_frequency_hz()
            # Format as 8 digits: XXYYYZZZZ where XX=MHz, YYY=kHz, ZZZ=Hz
            # Example: 7074000 Hz = 07.074.000 MHz
            freq_str = f"{freq_hz:08d}"  # Format as 8-digit Hz value with leading zeros
            
            # Update each digit label
            for i, digit_label in enumerate(freq_digit_labels):
                if i < len(freq_str):
                    digit_label.config(text=freq_str[i])
        except (ValueError, AttributeError):
            pass
    
    # Function to change frequency by step
    def change_frequency_by_step(step_hz, increment):
        """Change frequency by specified step size."""
        try:
            current_freq = parent_gui.get_frequency_hz()
            if increment:
                new_freq = current_freq + step_hz
            else:
                new_freq = current_freq - step_hz
            
            # Clamp to valid range (10 kHz to 30 MHz)
            new_freq = max(10000, min(30000000, new_freq))
            
            # Update frequency
            parent_gui.on_spectrum_frequency_click(float(new_freq))
            update_freq_display()
        except (ValueError, AttributeError) as e:
            print(f"Error changing frequency: {e}")
    
    # Bind mouse events to each digit
    for digit_label in freq_digit_labels:
        # Mouse wheel scroll (Linux)
        digit_label.bind('<Button-4>', lambda e, lbl=digit_label: change_frequency_by_step(lbl.step_size, True))
        digit_label.bind('<Button-5>', lambda e, lbl=digit_label: change_frequency_by_step(lbl.step_size, False))
        
        # Mouse wheel scroll (Windows/Mac)
        digit_label.bind('<MouseWheel>', lambda e, lbl=digit_label: change_frequency_by_step(
            lbl.step_size, e.delta > 0))
        
        # Click to increment/decrement (upper half = increment, lower half = decrement)
        def on_digit_click(event, lbl=digit_label):
            # Get click position relative to label
            label_height = lbl.winfo_height()
            click_y = event.y
            increment = click_y < label_height / 2
            change_frequency_by_step(lbl.step_size, increment)
        
        digit_label.bind('<Button-1>', lambda e, lbl=digit_label: on_digit_click(e, lbl))
        
        # Hover effect
        def on_enter(e, lbl=digit_label):
            lbl.config(bg='#333333')
        
        def on_leave(e, lbl=digit_label):
            lbl.config(bg='#222222')
        
        digit_label.bind('<Enter>', lambda e, lbl=digit_label: on_enter(e, lbl))
        digit_label.bind('<Leave>', lambda e, lbl=digit_label: on_leave(e, lbl))
    
    # Initial update
    update_freq_display()
    
    # Click Tune checkbox (between title and peak freq, top)
    click_tune_var = tk.BooleanVar(value=True)

    # Center Tune checkbox (below Click Tune) - enabled by default
    center_tune_var = tk.BooleanVar(value=True)

    # Create custom style for checkbox with black background
    style.configure('Black.TCheckbutton', background='#000000', foreground='white')
    style.map('Black.TCheckbutton',
              background=[('active', '#000000'), ('!active', '#000000')],
              foreground=[('active', 'white'), ('!active', 'white')])

    click_tune_check = ttk.Checkbutton(info_frame, text="Click Tune",
                                       variable=click_tune_var,
                                       style='Black.TCheckbutton')
    click_tune_check.place(relx=0.66, y=15, anchor=tk.W)

    center_tune_check = ttk.Checkbutton(info_frame, text="Center Tune",
                                        variable=center_tune_var,
                                        style='Black.TCheckbutton')
    center_tune_check.place(relx=0.66, y=35, anchor=tk.W)
    
    # Peak frequency info (right side, top line)
    peak_freq_label = tk.Label(info_frame, text="",
                               bg='#000000', fg='yellow',
                               font=('monospace', 10, 'bold'))
    peak_freq_label.place(relx=1.0, y=15, anchor=tk.E, x=-5)
    
    # Peak level info (right side, bottom line)
    peak_level_label = tk.Label(info_frame, text="",
                                bg='#000000', fg='yellow',
                                font=('monospace', 10, 'bold'))
    peak_level_label.place(relx=1.0, y=35, anchor=tk.E, x=-5)
    
    # Signal meter state
    signal_meter_mode = ['snr']  # Use list to allow modification in nested function
    last_signal_update = [0]
    signal_update_interval = 250  # ms
    
    # Signal meter click handler
    def toggle_signal_meter_mode(event):
        signal_meter_mode[0] = 'dbfs' if signal_meter_mode[0] == 'snr' else 'snr'
        mode_text = signal_meter_mode[0].upper()
        print(f"Signal meter mode: {mode_text}")
    
    signal_meter_label.bind('<Button-1>', toggle_signal_meter_mode)

    # Wire up zoom button callbacks - call zoom methods directly
    def zoom_in_click():
        """Zoom in."""
        spectrum.zoom_in()

    def zoom_out_click():
        """Zoom out."""
        spectrum.zoom_out()

    zoom_in_btn.config(command=zoom_in_click)
    zoom_out_btn.config(command=zoom_out_click)
    
    # Use the main GUI's spectrum display directly (shares WebSocket connection and data)
    # No new WebSocket connection is created - waterfall reads from main spectrum
    spectrum = parent_gui.spectrum
    
    # Unbind main spectrum's motion handler - waterfall will handle cursor for both
    # (This is safe because the main spectrum is hidden in the main GUI)
    try:
        spectrum.canvas.unbind('<Motion>')
    except (tk.TclError, AttributeError):
        pass  # Canvas might not exist or already unbound
    
    # Reparent the spectrum canvas to this window's container
    try:
        spectrum.canvas.pack_forget()  # Remove from main GUI
    except (tk.TclError, AttributeError):
        pass  # Canvas might already be removed or destroyed
    
    # Destroy old canvas if it exists
    try:
        if spectrum.canvas and spectrum.canvas.winfo_exists():
            spectrum.canvas.destroy()
    except (tk.TclError, AttributeError):
        pass  # Canvas already destroyed
    
    spectrum.canvas = Canvas(container, width=800, height=200, bg='#000000', highlightthickness=0)
    spectrum.canvas.pack(side=tk.TOP, fill=tk.BOTH, expand=False)
    spectrum.width = 800
    spectrum.height = 200
    
    # Rebind all spectrum canvas events
    spectrum.canvas.bind('<ButtonPress-1>', spectrum.on_mouse_down)
    spectrum.canvas.bind('<ButtonRelease-1>', spectrum.on_mouse_up)
    spectrum.canvas.bind('<B1-Motion>', spectrum.on_drag)
    spectrum.canvas.bind('<Button-4>', spectrum.on_scroll_up)
    spectrum.canvas.bind('<Button-5>', spectrum.on_scroll_down)
    spectrum.canvas.bind('<MouseWheel>', spectrum.on_mousewheel)
    spectrum.canvas.bind('<Configure>', spectrum.on_resize)
    
    # Update spectrum with current settings
    spectrum.click_tune_var = click_tune_var
    spectrum.center_tune_var = center_tune_var
    # Use merged bookmarks (server + local) instead of server-only bookmarks
    spectrum.bookmarks = parent_gui.all_bookmarks if hasattr(parent_gui, 'all_bookmarks') else parent_gui.bookmarks
    spectrum.bands = parent_gui.bands
    spectrum.set_frequency_callback(parent_gui.on_spectrum_frequency_click)
    spectrum.set_frequency_step_callback(parent_gui.on_spectrum_frequency_step)
    spectrum.set_mode_callback(parent_gui.on_spectrum_mode_change)
    spectrum.set_step_size(parent_gui.get_step_size_hz())
    
    # Set scroll mode from parent GUI
    if hasattr(parent_gui, 'scroll_mode_var'):
        spectrum.set_scroll_mode(parent_gui.scroll_mode_var.get())
    
    # CRITICAL: Restart the spectrum update loop
    # The loop may have stopped when the window was previously closed
    # We need to restart it for the new window
    spectrum.update_display()
    
    # Initialize with current settings
    try:
        freq_hz = parent_gui.get_frequency_hz()
        spectrum.tuned_freq = freq_hz
        spectrum.update_center_frequency(freq_hz)
        spectrum.update_bandwidth(
            int(parent_gui.bw_low_var.get()),
            int(parent_gui.bw_high_var.get()),
            parent_gui.mode_var.get().lower()
        )
    except ValueError:
        pass
    
    # Create waterfall display below spectrum (shares spectrum's data) with merged bookmarks
    waterfall = WaterfallDisplay(container, spectrum, width=800, height=400, spectrum_height=200, click_tune_var=click_tune_var, bookmarks=parent_gui.all_bookmarks if hasattr(parent_gui, 'all_bookmarks') else parent_gui.bookmarks)
    
    # Set scroll mode on waterfall too
    if hasattr(parent_gui, 'scroll_mode_var'):
        waterfall.set_scroll_mode(parent_gui.scroll_mode_var.get())
    
    # Bind spectrum canvas motion to waterfall's handler for unified cursor
    def unified_motion_handler(event):
        # Convert spectrum canvas coordinates to waterfall coordinates
        # Both have the same width and margins, so x coordinate is the same
        waterfall.on_motion(event)
    
    spectrum.canvas.bind('<Motion>', unified_motion_handler)
    
    # Function to update info labels periodically
    def update_info_labels():
        if not window.winfo_exists():
            return
        
        try:
            # Update signal meter (throttled to 250ms)
            import time
            now = time.time() * 1000
            if now - last_signal_update[0] >= signal_update_interval:
                last_signal_update[0] = now
                
                # Get signal metrics from spectrum
                try:
                    bw_low = int(parent_gui.bw_low_var.get())
                    bw_high = int(parent_gui.bw_high_var.get())
                    peak_db, floor_db, snr_db = spectrum.get_bandwidth_signal(bw_low, bw_high)
                    
                    if peak_db is not None and floor_db is not None and snr_db is not None:
                        if signal_meter_mode[0] == 'snr':
                            text = f"SNR: {snr_db:.1f} dB"
                            # Color based on SNR quality
                            if snr_db >= 20:
                                color = '#00ff00'  # Green - excellent
                            elif snr_db >= 10:
                                color = '#ffff00'  # Yellow - good
                            else:
                                color = '#ff6600'  # Orange - poor
                        else:  # dbfs mode
                            text = f"Peak: {peak_db:.1f} dBFS"
                            # Color based on peak level
                            if peak_db >= -20:
                                color = '#00ff00'  # Green - strong
                            elif peak_db >= -40:
                                color = '#ffff00'  # Yellow - moderate
                            else:
                                color = '#ff6600'  # Orange - weak
                    else:
                        text = f"{signal_meter_mode[0].upper()}: -- dB"
                        color = '#666666'
                    
                    signal_meter_label.config(text=text, fg=color)
                except (ValueError, AttributeError):
                    signal_meter_label.config(text=f"{signal_meter_mode[0].upper()}: -- dB", fg='#666666')
            
            # Update frequency display
            update_freq_display()
            
            # Find peak in spectrum data
            if spectrum.spectrum_data is not None and len(spectrum.spectrum_data) > 0:
                import numpy as np
                valid_data = spectrum.spectrum_data[np.isfinite(spectrum.spectrum_data)]
                if len(valid_data) > 0:
                    peak_idx = np.argmax(spectrum.spectrum_data)
                    peak_db = spectrum.spectrum_data[peak_idx]
                    
                    # Calculate peak frequency
                    if spectrum.total_bandwidth > 0:
                        freq_offset = (peak_idx / len(spectrum.spectrum_data) - 0.5) * spectrum.total_bandwidth
                        peak_freq = spectrum.center_freq + freq_offset
                        peak_freq_label.config(text=f"Peak: {peak_freq/1e6:.6f} MHz")
                        peak_level_label.config(text=f"{peak_db:.1f} dB")
                    else:
                        peak_freq_label.config(text="")
                        peak_level_label.config(text="")
                else:
                    peak_freq_label.config(text="")
                    peak_level_label.config(text="")
            else:
                peak_freq_label.config(text="")
                peak_level_label.config(text="")
        except Exception as e:
            pass
        
        # Schedule next update
        window.after(100, update_info_labels)
    
    # Start info label updates
    update_info_labels()
    
    # Set callbacks to parent GUI's methods
    waterfall.set_frequency_callback(parent_gui.on_spectrum_frequency_click)
    waterfall.set_frequency_step_callback(parent_gui.on_spectrum_frequency_step)
    waterfall.set_step_size(parent_gui.get_step_size_hz())
    
    # Update waterfall with current settings
    waterfall.update_center_frequency(parent_gui.get_frequency_hz())
    waterfall.update_bandwidth(
        int(parent_gui.bw_low_var.get()),
        int(parent_gui.bw_high_var.get()),
        parent_gui.mode_var.get().lower()
    )
    
    # Store references to spectrum and waterfall in parent GUI for scroll mode updates
    parent_gui.waterfall_spectrum = spectrum
    parent_gui.waterfall_waterfall = waterfall
    
    # Handle window close
    def on_close():
        waterfall.disconnect()
        spectrum.disconnect()
        # Clear references
        if hasattr(parent_gui, 'waterfall_spectrum'):
            parent_gui.waterfall_spectrum = None
        if hasattr(parent_gui, 'waterfall_waterfall'):
            parent_gui.waterfall_waterfall = None
        window.destroy()
    
    window.protocol("WM_DELETE_WINDOW", on_close)
    
    return window, waterfall