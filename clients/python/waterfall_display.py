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
    
    def __init__(self, parent: tk.Widget, spectrum_display, width: int = 800, height: int = 400):
        """Initialize waterfall display widget.
        
        Args:
            parent: Parent tkinter widget (can be Toplevel window)
            spectrum_display: SpectrumDisplay instance to share data with
            width: Canvas width in pixels
            height: Canvas height in pixels
        """
        self.parent = parent
        self.width = width
        self.height = height
        self.spectrum_display = spectrum_display
        
        # Create canvas for waterfall display
        self.canvas = Canvas(parent, width=width, height=height, bg='#000000', highlightthickness=1)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        
        # Spectrum data (shared from spectrum display)
        self.spectrum_data: Optional[np.ndarray] = None
        
        # Current tuned frequency and bandwidth (for filter visualization)
        self.tuned_freq: float = 0
        self.bandwidth_low: int = 0
        self.bandwidth_high: int = 0
        
        # Frequency step size for click-to-tune snapping (in Hz)
        self.step_size_hz: int = 1000  # Default 1 kHz
        
        # Frequency change callback
        self.frequency_callback: Optional[Callable[[float], None]] = None
        self.frequency_step_callback: Optional[Callable[[int], None]] = None
        
        # Drawing parameters
        self.margin_top = 30
        self.margin_bottom = 10
        self.margin_left = 50
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
        
        # Mouse interaction
        self.canvas.bind('<Button-1>', self.on_click)
        self.canvas.bind('<Motion>', self.on_motion)
        # Mouse wheel for frequency stepping
        self.canvas.bind('<Button-4>', self.on_scroll_up)  # Linux scroll up
        self.canvas.bind('<Button-5>', self.on_scroll_down)  # Linux scroll down
        self.canvas.bind('<MouseWheel>', self.on_mousewheel)  # Windows/Mac
        
        # Tooltip and cursor
        self.tooltip_id = None
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
    
    def update_bandwidth(self, low: int, high: int):
        """Update filter bandwidth for visualization."""
        self.bandwidth_low = low
        self.bandwidth_high = high
    
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
        self.parent.after(10, self.update_display)
    
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
        """Draw frequency scale at top."""
        if not self.spectrum_display or self.spectrum_display.total_bandwidth == 0:
            return
        
        center_freq = self.spectrum_display.center_freq
        total_bandwidth = self.spectrum_display.total_bandwidth
        start_freq = center_freq - total_bandwidth / 2
        end_freq = center_freq + total_bandwidth / 2
        
        # Draw background for frequency scale
        self.canvas.create_rectangle(
            self.margin_left, 0,
            self.margin_left + self.waterfall_width, self.margin_top,
            fill='#1a1a1a', outline=''
        )
        
        # Draw 5 frequency markers
        for i in range(5):
            freq = start_freq + (i / 4) * total_bandwidth
            x = self.margin_left + (i / 4) * self.waterfall_width
            
            # Draw tick
            self.canvas.create_line(x, self.margin_top - 5,
                                   x, self.margin_top,
                                   fill='white', width=1)
            
            # Draw label
            freq_mhz = freq / 1e6
            label = f"{freq_mhz:.3f}"
            self.canvas.create_text(x, self.margin_top - 15,
                                   text=label, fill='white', font=('monospace', 9))
        
        # Draw center frequency marker
        x = self.margin_left + self.waterfall_width / 2
        freq_mhz = center_freq / 1e6
        self.canvas.create_text(x, 5,
                               text=f"{freq_mhz:.6f} MHz",
                               fill='orange', font=('monospace', 10, 'bold'))
    
    def _draw_bandwidth_filter(self):
        """Draw bandwidth filter visualization with yellow overlay."""
        if not self.spectrum_display or self.spectrum_display.total_bandwidth == 0 or self.tuned_freq == 0:
            return
        
        center_freq = self.spectrum_display.center_freq
        total_bandwidth = self.spectrum_display.total_bandwidth
        start_freq = center_freq - total_bandwidth / 2
        end_freq = center_freq + total_bandwidth / 2
        
        # Calculate filter edge frequencies
        filter_low_freq = self.tuned_freq + self.bandwidth_low
        filter_high_freq = self.tuned_freq + self.bandwidth_high
        
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
    
    def on_click(self, event):
        """Handle mouse click on waterfall."""
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
        if self.frequency_step_callback:
            self.frequency_step_callback(1)
    
    def on_scroll_down(self, event):
        """Handle mouse scroll down (Linux)."""
        if self.frequency_step_callback:
            self.frequency_step_callback(-1)
    
    def on_mousewheel(self, event):
        """Handle mouse wheel (Windows/Mac)."""
        if self.frequency_step_callback:
            direction = 1 if event.delta > 0 else -1
            self.frequency_step_callback(direction)
    
    def on_motion(self, event):
        """Handle mouse motion for tooltip."""
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
            if self.tooltip_id:
                self.canvas.delete(self.tooltip_id)
                self.tooltip_id = None
            if self.cursor_line_id:
                self.canvas.delete(self.cursor_line_id)
                self.cursor_line_id = None
            return
        
        self.cursor_x = event.x
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
        
        # Draw cursor line
        self._draw_cursor_line(x)
        
        # Draw tooltip
        tooltip_text = f"{freq/1e6:.6f} MHz"
        self._draw_tooltip(x, y, tooltip_text)
    
    def _draw_tooltip(self, x: int, y: int, text: str):
        """Draw tooltip at position with white background and black text."""
        if self.tooltip_id:
            self.canvas.delete(self.tooltip_id)
        
        # Position tooltip
        if x > self.width / 2:
            tooltip_x = x - 10
            anchor = tk.E
        else:
            tooltip_x = x + 10
            anchor = tk.W
        
        # Create white background rectangle for tooltip
        # Estimate text size (rough approximation)
        text_width = len(text) * 7
        text_height = 14
        
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
        
        # Draw background
        self.canvas.create_rectangle(
            bg_x1, bg_y1, bg_x2, bg_y2,
            fill='white', outline='black', width=1,
            tags='tooltip_bg'
        )
        
        # Draw text
        self.tooltip_id = self.canvas.create_text(
            tooltip_x, y - 10,
            text=text,
            fill='black',
            font=('monospace', 9, 'bold'),
            anchor=anchor,
            tags='tooltip_text'
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


def create_waterfall_window(parent_gui):
    """Create a standalone waterfall window that shares data with spectrum display.
    
    Args:
        parent_gui: Parent RadioGUI instance
        
    Returns:
        Tuple of (window, waterfall_display)
    """
    # Create toplevel window
    window = Toplevel(parent_gui.root)
    window.title("Waterfall Display")
    window.geometry("800x400")
    
    # Create waterfall display sharing spectrum's data
    waterfall = WaterfallDisplay(window, parent_gui.spectrum, width=800, height=400)
    
    # Set callbacks to parent GUI's methods
    waterfall.set_frequency_callback(parent_gui.on_spectrum_frequency_click)
    waterfall.set_frequency_step_callback(parent_gui.on_spectrum_frequency_step)
    waterfall.set_step_size(parent_gui.get_step_size_hz())
    
    # Update waterfall with current settings
    waterfall.update_center_frequency(parent_gui.get_frequency_hz())
    waterfall.update_bandwidth(
        int(parent_gui.bw_low_var.get()),
        int(parent_gui.bw_high_var.get())
    )
    
    # Handle window close
    def on_close():
        waterfall.disconnect()
        window.destroy()
    
    window.protocol("WM_DELETE_WINDOW", on_close)
    
    return window, waterfall