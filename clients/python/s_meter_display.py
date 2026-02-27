#!/usr/bin/env python3
"""
S-Meter Display - Analog-style signal strength meter with rotating needle
Matches the web UI implementation exactly
"""

import tkinter as tk
from tkinter import ttk
import math


class SMeterDisplay:
    """Analog S-meter display with rotating needle on semicircular arc."""
    
    def __init__(self, parent_gui):
        self.parent_gui = parent_gui
        self.window = None
        self.canvas = None
        
        # Initial canvas dimensions
        self.width = 500
        self.height = 250
        
        # Minimum window size
        self.min_width = 300
        self.min_height = 200
        
        # Calculate initial meter dimensions
        self._calculate_dimensions()
        
        # S-meter scale configuration (must be defined before using get_angle_for_value)
        self.min_db = -127
        self.max_db = -33
        
        # Semicircle angles
        self.start_angle = math.pi  # 180 degrees (left) - S1 position
        self.end_angle = 0  # 0 degrees (right) - S9+40 position
        self.angle_range = self.start_angle - self.end_angle
        
        # Signal values
        self.current_value = -120  # dBFS
        self.target_value = -120
        self.original_value = -120  # Store unclamped value for display
        self.needle_angle = self.get_angle_for_value(-120)
        
        # Peak hold values
        self.peak_value = -120  # dBFS
        self.original_peak_value = -120
        self.peak_angle = self.get_angle_for_value(-120)
        self.peak_decay_rate = 1.0  # dB per frame
        self.peak_hold_time = 15  # frames to hold peak
        self.peak_hold_counter = 0
        
        # Animation settings
        self.animation_speed = 0.6  # Faster response
        
        # Update timer
        self.update_timer = None
        self._resize_pending = False
        
    def _calculate_dimensions(self):
        """Calculate meter dimensions based on current canvas size."""
        # Calculate optimal radius to fill the canvas
        # Account for: top margin (10px), bottom labels (20px), and side margins
        max_radius_width = (self.width - 40) / 2  # Leave 20px margin on each side
        max_radius_height = self.height - 30  # Leave 10px top, 20px bottom
        self.radius = min(max_radius_width, max_radius_height)
        
        # Center point for the meter - positioned so semicircle fills canvas height
        self.center_x = self.width / 2
        self.center_y = self.radius + 10  # 10px from top
        
        # Needle length
        self.needle_length = self.radius - 18
        
    def _on_resize(self, event):
        """Handle canvas resize event."""
        # Only process if size actually changed
        if event.width != self.width or event.height != self.height:
            self.width = event.width
            self.height = event.height
            
            # Throttle redraws - cancel pending redraw and schedule new one
            if self._resize_pending:
                self.window.after_cancel(self._resize_pending)
            self._resize_pending = self.window.after(50, self._do_resize)
            
    def _do_resize(self):
        """Perform the actual resize and redraw."""
        self._resize_pending = False
        self._calculate_dimensions()
        self.draw()
        
    def open_window(self):
        """Open the S-meter display window."""
        if self.window is not None:
            self.window.lift()
            return
            
        self.window = tk.Toplevel(self.parent_gui.root)
        self.window.title("S-Meter")
        self.window.geometry(f"{self.width}x{self.height + 80}")
        self.window.minsize(self.min_width, self.min_height + 80)
        
        # Create canvas that fills the window
        self.canvas = tk.Canvas(self.window, bg='#2c3e50', highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True, pady=(10, 0))
        
        # Bind resize event
        self.canvas.bind('<Configure>', self._on_resize)
        
        # Create value display labels
        display_frame = ttk.Frame(self.window)
        display_frame.pack(pady=5)
        
        ttk.Label(display_frame, text="Current:").grid(row=0, column=0, padx=5)
        self.value_label = ttk.Label(display_frame, text="S0", font=('Arial', 14, 'bold'),
                                     foreground='#dc3545')
        self.value_label.grid(row=0, column=1, padx=5)
        
        ttk.Label(display_frame, text="Peak:").grid(row=0, column=2, padx=(20, 5))
        self.peak_label = ttk.Label(display_frame, text="S0", font=('Arial', 14, 'bold'),
                                    foreground='#00ffff')
        self.peak_label.grid(row=0, column=3, padx=5)
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.close_window)
        
        # Initial draw
        self.draw()
        
        # Start update loop
        self.start_update_loop()
        
    def close_window(self):
        """Close the S-meter window."""
        if self.update_timer:
            self.window.after_cancel(self.update_timer)
            self.update_timer = None
        if self.window:
            self.window.destroy()
            self.window = None
            self.canvas = None
            
    def dbfs_to_s_units(self, dbfs):
        """Convert dBFS to S-units for display."""
        if dbfs < -115:
            return 0
        if dbfs < -73:
            # S1 to S9: each S-unit is 6 dB, S1 starts at -115 dBFS
            return 1 + (dbfs + 115) / 6
        # Above S9: S9+10, S9+20, etc.
        return 9 + (dbfs + 73) / 10
        
    def format_s_units(self, dbfs):
        """Format S-units as string (e.g., 'S4', 'S9+7')."""
        s_units = self.dbfs_to_s_units(dbfs)
        
        if s_units < 1:
            return 'S0'
        elif s_units <= 9:
            return f'S{round(s_units)}'
        else:
            # Above S9, show as S9+dB
            over_s9 = round(dbfs + 73)
            return f'S9+{over_s9}'
            
    def get_angle_for_value(self, dbfs):
        """Convert dBFS value to angle for the needle."""
        # Clamp value to meter range
        clamped_db = max(self.min_db, min(self.max_db, dbfs))
        
        # Normalize to 0-1 range
        normalized = (clamped_db - self.min_db) / (self.max_db - self.min_db)
        
        # Needle points to scale labels: weak signals on left, strong on right
        return self.start_angle - (normalized * self.angle_range)
        
    def get_scale_label_angle(self, dbfs):
        """Convert dBFS value to angle for scale labels (not inverted)."""
        clamped_db = max(self.min_db, min(self.max_db, dbfs))
        normalized = (clamped_db - self.min_db) / (self.max_db - self.min_db)
        
        # Not inverted for labels: weak signals on left, strong on right
        return self.start_angle - (normalized * self.angle_range)
        
    def draw(self):
        """Draw the complete S-meter."""
        if not self.canvas:
            return
            
        # Clear canvas
        self.canvas.delete('all')
        
        # Draw meter background
        self.draw_background()
        
        # Draw scale markings and labels
        self.draw_scale()
        
        # Draw the peak needle (behind main needle)
        self.draw_peak_needle()
        
        # Draw the main needle
        self.draw_needle()
        
        # Draw center pivot
        self.draw_pivot()
        
        # Update the value display labels
        self.update_value_display()
        
    def draw_background(self):
        """Draw the meter background arc."""
        # Outer arc - simple semicircle
        x1 = self.center_x - self.radius
        y1 = self.center_y - self.radius
        x2 = self.center_x + self.radius
        y2 = self.center_y + self.radius
        
        self.canvas.create_arc(x1, y1, x2, y2, start=0, extent=180,
                              outline='#34495e', width=3, style='arc')
                              
    def draw_scale(self):
        """Draw scale markings and labels."""
        # S-unit markers (S1-S9)
        for s in range(1, 10):
            dbfs = -115 + (s - 1) * 6  # S1 = -115 dBFS, each S-unit is 6 dB
            angle = self.get_scale_label_angle(dbfs)
            
            # Major tick mark
            tick_start = self.radius - 15
            tick_end = self.radius - 5
            label_radius = self.radius - 25
            
            x1 = self.center_x + math.cos(angle) * tick_start
            y1 = self.center_y - math.sin(angle) * tick_start
            x2 = self.center_x + math.cos(angle) * tick_end
            y2 = self.center_y - math.sin(angle) * tick_end
            
            self.canvas.create_line(x1, y1, x2, y2, fill='#ecf0f1', width=2)
            
            # Label
            label_x = self.center_x + math.cos(angle) * label_radius
            label_y = self.center_y - math.sin(angle) * label_radius
            self.canvas.create_text(label_x, label_y, text=str(s),
                                   fill='#ecf0f1', font=('Arial', 13, 'bold'))
                                   
        # Over S9 markers (+10, +20, +30, +40)
        for db in [10, 20, 30, 40]:
            dbfs = -73 + db
            angle = self.get_scale_label_angle(dbfs)
            
            # Minor tick mark
            tick_start = self.radius - 12
            tick_end = self.radius - 5
            label_radius = self.radius - 25
            
            x1 = self.center_x + math.cos(angle) * tick_start
            y1 = self.center_y - math.sin(angle) * tick_start
            x2 = self.center_x + math.cos(angle) * tick_end
            y2 = self.center_y - math.sin(angle) * tick_end
            
            self.canvas.create_line(x1, y1, x2, y2, fill='#ecf0f1', width=1.5)
            
            # Label
            label_x = self.center_x + math.cos(angle) * label_radius
            label_y = self.center_y - math.sin(angle) * label_radius
            self.canvas.create_text(label_x, label_y, text=f'+{db}',
                                   fill='#ecf0f1', font=('Arial', 10, 'bold'))
                                   
        # "S" label at bottom left (just below the arc)
        label_y = self.center_y + 15
        self.canvas.create_text(10, label_y, text='S', anchor='w',
                               fill='#ecf0f1', font=('Arial', 12, 'bold'))
                               
        # "dB" label at bottom right (just below the arc)
        self.canvas.create_text(self.width - 10, label_y, text='dB', anchor='e',
                               fill='#ecf0f1', font=('Arial', 12, 'bold'))
                               
    def draw_peak_needle(self):
        """Draw the peak hold needle."""
        # Use angle directly (same as scale labels)
        angle = self.peak_angle
        
        # Calculate needle tip (same coordinate system as scale labels)
        tip_x = self.center_x + math.cos(angle) * self.needle_length
        tip_y = self.center_y - math.sin(angle) * self.needle_length
        
        # Calculate base points perpendicular to needle direction
        left_x = self.center_x + math.cos(angle + math.pi / 2) * 2
        left_y = self.center_y - math.sin(angle + math.pi / 2) * 2
        
        right_x = self.center_x + math.cos(angle - math.pi / 2) * 2
        right_y = self.center_y - math.sin(angle - math.pi / 2) * 2
        
        # Draw peak needle (semi-transparent cyan)
        self.canvas.create_polygon(tip_x, tip_y, left_x, left_y,
                                  self.center_x, self.center_y, right_x, right_y,
                                  fill='#00ffff', outline='#00cccc', width=1,
                                  stipple='gray50')
                                  
    def draw_needle(self):
        """Draw the main needle."""
        # Use angle directly (same as scale labels)
        angle = self.needle_angle
        
        # Calculate needle tip (same coordinate system as scale labels)
        tip_x = self.center_x + math.cos(angle) * self.needle_length
        tip_y = self.center_y - math.sin(angle) * self.needle_length
        
        # Calculate base points perpendicular to needle direction
        left_x = self.center_x + math.cos(angle + math.pi / 2) * 4
        left_y = self.center_y - math.sin(angle + math.pi / 2) * 4
        
        right_x = self.center_x + math.cos(angle - math.pi / 2) * 4
        right_y = self.center_y - math.sin(angle - math.pi / 2) * 4
        
        # Needle color based on dBFS value
        if self.current_value >= -70:
            color = '#28a745'  # Green - strong signal
        elif self.current_value >= -85:
            color = '#ffc107'  # Yellow - moderate signal
        else:
            color = '#dc3545'  # Red - weak signal
            
        # Draw needle
        self.canvas.create_polygon(tip_x, tip_y, left_x, left_y,
                                  self.center_x, self.center_y, right_x, right_y,
                                  fill=color, outline='#2c3e50', width=1)
                                  
    def draw_pivot(self):
        """Draw center pivot point."""
        # Outer circle
        self.canvas.create_oval(self.center_x - 8, self.center_y - 8,
                               self.center_x + 8, self.center_y + 8,
                               fill='#34495e', outline='#ecf0f1', width=2)
                               
        # Inner circle
        self.canvas.create_oval(self.center_x - 4, self.center_y - 4,
                               self.center_x + 4, self.center_y + 4,
                               fill='#2c3e50', outline='')
                               
    def update_value_display(self):
        """Update the value display labels."""
        if not self.value_label or not self.peak_label:
            return
            
        # Update current value
        s_unit_text = self.format_s_units(self.original_value)
        self.value_label.config(text=s_unit_text)
        
        # Check if signal exceeds S9+40
        exceeds_max = self.original_value > -33
        
        if exceeds_max:
            self.value_label.config(foreground='#dc3545')  # Red for overload
        else:
            # Color based on signal strength
            if self.current_value >= -70:
                self.value_label.config(foreground='#28a745')  # Green
            elif self.current_value >= -85:
                self.value_label.config(foreground='#ffc107')  # Yellow
            else:
                self.value_label.config(foreground='#dc3545')  # Red
                
        # Update peak value
        peak_text = self.format_s_units(self.original_peak_value)
        self.peak_label.config(text=peak_text)
        
        # Check if peak exceeds S9+40
        if self.original_peak_value > -33:
            self.peak_label.config(foreground='#dc3545')  # Red for overload
        else:
            self.peak_label.config(foreground='#00ffff')  # Cyan
            
    def update(self, dbfs_value):
        """Update the meter with a new signal value."""
        if not self.canvas:
            return
            
        # Store original (unclamped) value for display
        self.original_value = dbfs_value
        
        # Clamp input value to valid range for needle position
        self.target_value = max(self.min_db, min(self.max_db, dbfs_value))
        
        # Smooth interpolation for needle movement
        self.current_value += (self.target_value - self.current_value) * self.animation_speed
        
        # Update needle angle
        self.needle_angle = self.get_angle_for_value(self.current_value)
        
        # Update peak hold
        if self.current_value > self.peak_value:
            # New peak detected
            self.peak_value = self.current_value
            self.original_peak_value = dbfs_value
            self.peak_angle = self.get_angle_for_value(self.peak_value)
            self.peak_hold_counter = self.peak_hold_time
        else:
            # Decay peak
            if self.peak_hold_counter > 0:
                self.peak_hold_counter -= 1
            else:
                self.peak_value -= self.peak_decay_rate
                self.original_peak_value -= self.peak_decay_rate
                if self.peak_value < self.current_value:
                    self.peak_value = self.current_value
                    self.original_peak_value = self.original_value
                self.peak_angle = self.get_angle_for_value(self.peak_value)
                
        # Redraw
        self.draw()
        
    def reset(self):
        """Reset the meter."""
        self.current_value = -120
        self.target_value = -120
        self.original_value = -120
        self.needle_angle = self.get_angle_for_value(-120)
        self.peak_value = -120
        self.original_peak_value = -120
        self.peak_angle = self.get_angle_for_value(-120)
        self.peak_hold_counter = 0
        self.draw()
        
    def start_update_loop(self):
        """Start the update loop to refresh the meter."""
        if not self.window:
            return
            
        # Get current baseband power from client
        if self.parent_gui.client and self.parent_gui.connected:
            baseband_power = getattr(self.parent_gui.client, 'baseband_power', -999.0)
            if baseband_power > -999:
                self.update(baseband_power)
            else:
                self.update(-120)  # Default to minimum if no signal
        else:
            self.update(-120)
            
        # Schedule next update (30 fps)
        self.update_timer = self.window.after(33, self.start_update_loop)
