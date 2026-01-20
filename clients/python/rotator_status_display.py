#!/usr/bin/env python3
"""
Rotator Status Display Window for ka9q_ubersdr
Shows rotator status information from /api/rotctl/status
Allows control of rotator azimuth via /api/rotctl/position
"""

import tkinter as tk
from tkinter import ttk, messagebox
import requests
from typing import Optional, Dict
import threading
from datetime import datetime
import json
import os
import platform
import subprocess


class RotatorStatusDisplay:
    """Display window for rotator status with control capabilities."""
    
    def __init__(self, parent, server_url: str, use_tls: bool = False, instance_uuid: Optional[str] = None):
        """Initialize rotator status display.
        
        Args:
            parent: Parent window
            server_url: Server URL (host:port format)
            use_tls: Whether to use TLS/SSL
            instance_uuid: UUID of the instance (for saving password per instance)
        """
        self.parent = parent
        self.server_url = server_url
        self.use_tls = use_tls
        self.instance_uuid = instance_uuid
        
        # Update interval for periodic refresh
        self.update_interval = 3000  # 3 seconds
        
        # Config file path for storing rotator passwords per instance
        if platform.system() == 'Windows':
            config_dir = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'ubersdr')
            os.makedirs(config_dir, exist_ok=True)
            self.config_file = os.path.join(config_dir, 'rotator_passwords.json')
        else:
            self.config_file = os.path.expanduser("~/.ubersdr_rotator_passwords.json")
        
        # Build base URL
        if '://' in server_url:
            self.base_url = server_url
        else:
            protocol = 'https' if use_tls else 'http'
            self.base_url = f"{protocol}://{server_url}"
        
        # Data storage
        self.status_data: Optional[Dict] = None
        
        # Widget references for updates
        self.status_labels = {}
        self.control_buttons = []
        
        # Track last saved password to prevent duplicate saves
        self.last_saved_password = None
        
        # Refresh control
        self.refresh_job = None
        self.running = True
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("Rotator Status & Control")
        self.window.geometry("550x680")
        
        # Create UI
        self.create_widgets()
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.on_close)
        
        # Load saved password for this instance
        self.load_saved_password()
        
        # Fetch initial status immediately to check read_only status
        # This will enable/disable controls appropriately
        self.fetch_initial_status()
        
        # Start periodic data refresh (after initial fetch)
        self.window.after(self.update_interval, self.refresh_data)
    
    def create_widgets(self):
        """Create all UI widgets."""
        # Main container
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        
        # Status frame
        status_frame = ttk.LabelFrame(main_frame, text="Current Status", padding="10")
        status_frame.pack(fill=tk.X, pady=(0, 10))
        
        # Create container for status grid and compass
        status_container = ttk.Frame(status_frame)
        status_container.pack(fill=tk.BOTH, expand=True)
        
        # Left side - status display grid
        status_grid = ttk.Frame(status_container)
        status_grid.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        # Configure grid
        status_grid.columnconfigure(0, weight=0)
        status_grid.columnconfigure(1, weight=1)
        
        # Connection status
        row = 0
        ttk.Label(status_grid, text="Connection:", font=('TkDefaultFont', 10, 'bold')).grid(
            row=row, column=0, sticky=tk.W, padx=(0, 10), pady=5)
        self.status_labels['connection'] = ttk.Label(status_grid, text="--", font=('TkDefaultFont', 10))
        self.status_labels['connection'].grid(row=row, column=1, sticky=tk.W, pady=5)
        
        # Enabled status
        row += 1
        ttk.Label(status_grid, text="Enabled:", font=('TkDefaultFont', 10, 'bold')).grid(
            row=row, column=0, sticky=tk.W, padx=(0, 10), pady=5)
        self.status_labels['enabled'] = ttk.Label(status_grid, text="--", font=('TkDefaultFont', 10))
        self.status_labels['enabled'].grid(row=row, column=1, sticky=tk.W, pady=5)
        
        # Azimuth (larger font, blue)
        row += 1
        ttk.Label(status_grid, text="Azimuth:", font=('TkDefaultFont', 10, 'bold')).grid(
            row=row, column=0, sticky=tk.W, padx=(0, 10), pady=5)
        self.status_labels['azimuth'] = ttk.Label(status_grid, text="--", 
                                                   font=('TkDefaultFont', 14, 'bold'), foreground='blue')
        self.status_labels['azimuth'].grid(row=row, column=1, sticky=tk.W, pady=5)
        
        # Elevation (larger font, blue)
        row += 1
        ttk.Label(status_grid, text="Elevation:", font=('TkDefaultFont', 10, 'bold')).grid(
            row=row, column=0, sticky=tk.W, padx=(0, 10), pady=5)
        self.status_labels['elevation'] = ttk.Label(status_grid, text="--", 
                                                     font=('TkDefaultFont', 14, 'bold'), foreground='blue')
        self.status_labels['elevation'].grid(row=row, column=1, sticky=tk.W, pady=5)
        
        # Moving status
        row += 1
        ttk.Label(status_grid, text="Moving:", font=('TkDefaultFont', 10, 'bold')).grid(
            row=row, column=0, sticky=tk.W, padx=(0, 10), pady=5)
        self.status_labels['moving'] = ttk.Label(status_grid, text="--", font=('TkDefaultFont', 10))
        self.status_labels['moving'].grid(row=row, column=1, sticky=tk.W, pady=5)
        
        # Read-only status
        row += 1
        ttk.Label(status_grid, text="Read Only:", font=('TkDefaultFont', 10, 'bold')).grid(
            row=row, column=0, sticky=tk.W, padx=(0, 10), pady=5)
        self.status_labels['readonly'] = ttk.Label(status_grid, text="--", font=('TkDefaultFont', 10))
        self.status_labels['readonly'].grid(row=row, column=1, sticky=tk.W, pady=5)
        
        # Connected duration
        row += 1
        ttk.Label(status_grid, text="Connected For:", font=('TkDefaultFont', 10, 'bold')).grid(
            row=row, column=0, sticky=tk.W, padx=(0, 10), pady=5)
        self.status_labels['duration'] = ttk.Label(status_grid, text="--", font=('TkDefaultFont', 10))
        self.status_labels['duration'].grid(row=row, column=1, sticky=tk.W, pady=5)
        
        # Right side - compass display
        compass_frame = ttk.Frame(status_container)
        compass_frame.pack(side=tk.RIGHT, padx=(20, 0))
        
        # Create compass canvas
        self.compass_size = 180
        self.compass_canvas = tk.Canvas(compass_frame, width=self.compass_size, height=self.compass_size,
                                        bg='white', highlightthickness=1, highlightbackground='gray',
                                        cursor='crosshair')
        self.compass_canvas.pack()
        
        # Bind mouse events for compass interaction
        self.compass_canvas.bind('<Button-1>', self.on_compass_click)
        self.compass_canvas.bind('<Motion>', self.on_compass_hover)
        self.compass_canvas.bind('<Leave>', self.on_compass_leave)
        
        # Tooltip for compass
        self.compass_tooltip = None
        self.compass_tooltip_after_id = None
        
        # Draw static compass elements
        self.draw_compass_background()
        
        # Needle will be drawn dynamically
        self.compass_needle = None
        
        # Control frame
        control_frame = ttk.LabelFrame(main_frame, text="Azimuth Control", padding="10")
        control_frame.pack(fill=tk.X, pady=(0, 10))
        
        # Password field
        password_row = ttk.Frame(control_frame)
        password_row.pack(fill=tk.X, pady=(0, 10))
        
        ttk.Label(password_row, text="Password:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT, padx=(0, 5))
        self.password_var = tk.StringVar()
        self.password_entry = ttk.Entry(password_row, textvariable=self.password_var, show='*', width=20)
        self.password_entry.pack(side=tk.LEFT, padx=(0, 5))
        # Trace password changes to enable/disable buttons AND save password
        self.password_var.trace_add('write', lambda *args: self.on_password_changed())
        
        # Delete button to clear saved password
        self.delete_password_btn = ttk.Button(password_row, text="Clear", width=6, command=self.delete_saved_password)
        self.delete_password_btn.pack(side=tk.LEFT, padx=2)
        
        # Increment/Decrement buttons
        button_row1 = ttk.Frame(control_frame)
        button_row1.pack(fill=tk.X, pady=(0, 5))
        
        ttk.Label(button_row1, text="Adjust:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT, padx=(0, 10))
        
        # -30 button
        btn = ttk.Button(button_row1, text="-30°", width=6, command=lambda: self.adjust_azimuth(-30))
        btn.pack(side=tk.LEFT, padx=2)
        self.control_buttons.append(btn)
        
        # -10 button
        btn = ttk.Button(button_row1, text="-10°", width=6, command=lambda: self.adjust_azimuth(-10))
        btn.pack(side=tk.LEFT, padx=2)
        self.control_buttons.append(btn)
        
        # -5 button
        btn = ttk.Button(button_row1, text="-5°", width=6, command=lambda: self.adjust_azimuth(-5))
        btn.pack(side=tk.LEFT, padx=2)
        self.control_buttons.append(btn)
        
        # +5 button
        btn = ttk.Button(button_row1, text="+5°", width=6, command=lambda: self.adjust_azimuth(5))
        btn.pack(side=tk.LEFT, padx=2)
        self.control_buttons.append(btn)
        
        # +10 button
        btn = ttk.Button(button_row1, text="+10°", width=6, command=lambda: self.adjust_azimuth(10))
        btn.pack(side=tk.LEFT, padx=2)
        self.control_buttons.append(btn)
        
        # +30 button
        btn = ttk.Button(button_row1, text="+30°", width=6, command=lambda: self.adjust_azimuth(30))
        btn.pack(side=tk.LEFT, padx=2)
        self.control_buttons.append(btn)
        
        # Cardinal direction buttons
        button_row2 = ttk.Frame(control_frame)
        button_row2.pack(fill=tk.X, pady=(5, 0))
        
        ttk.Label(button_row2, text="Set:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT, padx=(0, 10))
        
        # North button (0°)
        btn = ttk.Button(button_row2, text="North (0°)", width=13, command=lambda: self.set_azimuth_direct(0))
        btn.pack(side=tk.LEFT, padx=2)
        self.control_buttons.append(btn)
        
        # East button (90°)
        btn = ttk.Button(button_row2, text="East (90°)", width=13, command=lambda: self.set_azimuth_direct(90))
        btn.pack(side=tk.LEFT, padx=2)
        self.control_buttons.append(btn)
        
        # South button (180°)
        btn = ttk.Button(button_row2, text="South (180°)", width=13, command=lambda: self.set_azimuth_direct(180))
        btn.pack(side=tk.LEFT, padx=2)
        self.control_buttons.append(btn)
        
        # West button (270°)
        btn = ttk.Button(button_row2, text="West (270°)", width=13, command=lambda: self.set_azimuth_direct(270))
        btn.pack(side=tk.LEFT, padx=2)
        self.control_buttons.append(btn)
        
        # Manual azimuth input
        manual_row = ttk.Frame(control_frame)
        manual_row.pack(fill=tk.X, pady=(5, 0))
        
        ttk.Label(manual_row, text="Set Azimuth:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT, padx=(0, 5))
        
        self.azimuth_input_var = tk.StringVar()
        self.azimuth_entry = ttk.Entry(manual_row, textvariable=self.azimuth_input_var, width=10)
        self.azimuth_entry.pack(side=tk.LEFT, padx=(0, 5))
        self.azimuth_entry.bind('<Return>', lambda e: self.set_azimuth())
        
        self.go_button = ttk.Button(manual_row, text="Go", width=6, command=self.set_azimuth)
        self.go_button.pack(side=tk.LEFT, padx=2)
        self.control_buttons.append(self.go_button)
        
        ttk.Label(manual_row, text="(0-359°)", foreground='gray').pack(side=tk.LEFT, padx=(5, 0))
        
        # Command buttons (Stop and Park)
        command_row = ttk.Frame(control_frame)
        command_row.pack(fill=tk.X, pady=(10, 0))
        
        ttk.Label(command_row, text="Commands:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT, padx=(0, 10))
        
        # Stop button (red background using tk.Button for color support)
        self.stop_button = tk.Button(command_row, text="STOP", width=8,
                                     command=lambda: self.send_command("stop"),
                                     bg='#ef4444', fg='white', font=('TkDefaultFont', 10, 'bold'),
                                     relief=tk.RAISED, borderwidth=2)
        self.stop_button.pack(side=tk.LEFT, padx=5)
        self.control_buttons.append(self.stop_button)
        
        # Park button (blue background using tk.Button for color support)
        self.park_button = tk.Button(command_row, text="Park", width=8,
                                     command=lambda: self.send_command("park"),
                                     bg='#3b82f6', fg='white', font=('TkDefaultFont', 10, 'bold'),
                                     relief=tk.RAISED, borderwidth=2)
        self.park_button.pack(side=tk.LEFT, padx=5)
        self.control_buttons.append(self.park_button)
        
        # Initially disable all control buttons (enabled when password is entered)
        for btn in self.control_buttons:
            btn.config(state='disabled')
        self.azimuth_entry.config(state='disabled')
        
        # Rotctl section
        rotctl_frame = ttk.LabelFrame(main_frame, text="Rotctl Server", padding="10")
        rotctl_frame.pack(fill=tk.X, pady=(0, 10))
        
        # Port input and Start/Stop button
        rotctl_row = ttk.Frame(rotctl_frame)
        rotctl_row.pack(fill=tk.X)
        
        ttk.Label(rotctl_row, text="Port:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT, padx=(0, 5))
        
        self.rotctl_port_var = tk.StringVar(value="4533")
        self.rotctl_port_entry = ttk.Entry(rotctl_row, textvariable=self.rotctl_port_var, width=10)
        self.rotctl_port_entry.pack(side=tk.LEFT, padx=(0, 10))
        
        # Validate port on change
        self.rotctl_port_var.trace_add('write', lambda *args: self.validate_rotctl_port())
        
        self.rotctl_start_stop_btn = ttk.Button(rotctl_row, text="Start", width=10, command=self.toggle_rotctl_server)
        self.rotctl_start_stop_btn.pack(side=tk.LEFT, padx=(0, 10))
        
        self.rotctl_status_label = ttk.Label(rotctl_row, text="Stopped", foreground='gray')
        self.rotctl_status_label.pack(side=tk.LEFT)
        
        # Connected clients display
        rotctl_clients_row = ttk.Frame(rotctl_frame)
        rotctl_clients_row.pack(fill=tk.X, pady=(5, 0))
        
        ttk.Label(rotctl_clients_row, text="Clients:", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT, padx=(0, 5))
        self.rotctl_clients_label = ttk.Label(rotctl_clients_row, text="None", foreground='gray')
        self.rotctl_clients_label.pack(side=tk.LEFT)
        
        # Track rotctl server state
        self.rotctl_server_running = False
        self.rotctl_server_instance = None
        self.rotctl_server_thread = None
        self.rotctl_connected_clients = []
        self.rotctl_monitor_job = None
        
        # Status bar
        status_bar_frame = ttk.Frame(main_frame)
        status_bar_frame.pack(fill=tk.X)
        
        self.status_label = ttk.Label(status_bar_frame, text="Loading...", foreground='blue')
        self.status_label.pack(side=tk.LEFT)
        
        self.refresh_label = ttk.Label(status_bar_frame, text="Updates every 3s", foreground='gray')
        self.refresh_label.pack(side=tk.RIGHT)
        
        # Configure main frame to expand
        main_frame.rowconfigure(1, weight=1)
    
    def draw_compass_background(self):
        """Draw the static compass background (circle, cardinal points, degree marks)."""
        import math
        
        center = self.compass_size / 2
        radius = center - 20  # Leave margin
        
        # Draw outer circle
        self.compass_canvas.create_oval(
            center - radius, center - radius,
            center + radius, center + radius,
            outline='black', width=2
        )
        
        # Draw cardinal points and degree marks
        for angle in range(0, 360, 10):
            # Convert to radians (0° is North, clockwise)
            rad = math.radians(angle - 90)  # -90 to start at top (North)
            
            # Determine if this is a cardinal point or major mark
            is_cardinal = angle % 90 == 0
            is_major = angle % 30 == 0
            
            if is_cardinal:
                # Cardinal points - longer marks and labels
                inner_radius = radius - 15
                outer_radius = radius
                
                # Draw mark
                x1 = center + inner_radius * math.cos(rad)
                y1 = center + inner_radius * math.sin(rad)
                x2 = center + outer_radius * math.cos(rad)
                y2 = center + outer_radius * math.sin(rad)
                self.compass_canvas.create_line(x1, y1, x2, y2, fill='black', width=3)
                
                # Draw cardinal letter
                label_radius = radius + 12
                label_x = center + label_radius * math.cos(rad)
                label_y = center + label_radius * math.sin(rad)
                
                if angle == 0:
                    label = 'N'
                elif angle == 90:
                    label = 'E'
                elif angle == 180:
                    label = 'S'
                else:  # 270
                    label = 'W'
                
                self.compass_canvas.create_text(label_x, label_y, text=label,
                                               font=('TkDefaultFont', 12, 'bold'))
            elif is_major:
                # Major marks (every 30°) - medium marks with degree labels
                inner_radius = radius - 10
                outer_radius = radius
                
                # Draw mark
                x1 = center + inner_radius * math.cos(rad)
                y1 = center + inner_radius * math.sin(rad)
                x2 = center + outer_radius * math.cos(rad)
                y2 = center + outer_radius * math.sin(rad)
                self.compass_canvas.create_line(x1, y1, x2, y2, fill='black', width=2)
                
                # Draw degree label
                label_radius = radius + 12
                label_x = center + label_radius * math.cos(rad)
                label_y = center + label_radius * math.sin(rad)
                self.compass_canvas.create_text(label_x, label_y, text=str(angle),
                                               font=('TkDefaultFont', 8))
            else:
                # Minor marks (every 10°) - short marks
                inner_radius = radius - 5
                outer_radius = radius
                
                # Draw mark
                x1 = center + inner_radius * math.cos(rad)
                y1 = center + inner_radius * math.sin(rad)
                x2 = center + outer_radius * math.cos(rad)
                y2 = center + outer_radius * math.sin(rad)
                self.compass_canvas.create_line(x1, y1, x2, y2, fill='gray', width=1)
        
        # Draw center dot
        self.compass_canvas.create_oval(center - 3, center - 3, center + 3, center + 3,
                                       fill='black', outline='black')
    
    def update_compass_needle(self, azimuth: float):
        """Update the compass needle to point to the given azimuth.
        
        Args:
            azimuth: Azimuth in degrees (0-359, 0=North, clockwise)
        """
        import math
        
        # Delete all old needle elements (both line and arrow)
        self.compass_canvas.delete('needle')
        
        center = self.compass_size / 2
        needle_length = center - 25  # Slightly shorter than radius
        
        # Convert azimuth to radians (0° is North at top, clockwise)
        rad = math.radians(azimuth - 90)  # -90 to start at top
        
        # Calculate needle endpoint (pointing direction)
        end_x = center + needle_length * math.cos(rad)
        end_y = center + needle_length * math.sin(rad)
        
        # Calculate back of needle (opposite direction, shorter)
        back_length = 15
        back_rad = rad + math.pi  # Opposite direction
        back_x = center + back_length * math.cos(back_rad)
        back_y = center + back_length * math.sin(back_rad)
        
        # Draw needle as a polygon (arrow shape)
        # Create arrow head at the pointing end
        arrow_size = 12
        arrow_angle = math.radians(20)  # 20° angle for arrow head
        
        # Left arrow point
        left_rad = rad + math.pi - arrow_angle
        left_x = end_x + arrow_size * math.cos(left_rad)
        left_y = end_y + arrow_size * math.sin(left_rad)
        
        # Right arrow point
        right_rad = rad + math.pi + arrow_angle
        right_x = end_x + arrow_size * math.cos(right_rad)
        right_y = end_y + arrow_size * math.sin(right_rad)
        
        # Draw needle body (line from back to tip)
        self.compass_canvas.create_line(back_x, back_y, end_x, end_y,
                                       fill='black', width=3, tags='needle')
        
        # Draw arrow head (red triangle)
        self.compass_needle = self.compass_canvas.create_polygon(
            end_x, end_y,  # Tip
            left_x, left_y,  # Left point
            right_x, right_y,  # Right point
            fill='red', outline='darkred', width=2, tags='needle'
        )
    
    def on_compass_click(self, event):
        """Handle click on compass to set azimuth.
        
        Args:
            event: Mouse click event
        """
        # Only allow clicks if password is set
        if not self.password_var.get().strip():
            return
        
        # Calculate azimuth from click position
        azimuth = self.calculate_azimuth_from_position(event.x, event.y)
        if azimuth is not None:
            # Send position command
            self.send_position_command(azimuth)
    
    def on_compass_hover(self, event):
        """Handle mouse hover over compass to show azimuth tooltip.
        
        Args:
            event: Mouse motion event
        """
        # Calculate azimuth from mouse position
        azimuth = self.calculate_azimuth_from_position(event.x, event.y)
        
        if azimuth is not None:
            # Cancel any pending tooltip
            if self.compass_tooltip_after_id:
                self.window.after_cancel(self.compass_tooltip_after_id)
                self.compass_tooltip_after_id = None
            
            # Show tooltip immediately (no delay for compass)
            self.show_compass_tooltip(event, azimuth)
    
    def on_compass_leave(self, event):
        """Handle mouse leaving compass area.
        
        Args:
            event: Mouse leave event
        """
        self.hide_compass_tooltip()
    
    def calculate_azimuth_from_position(self, x: int, y: int) -> Optional[int]:
        """Calculate azimuth from canvas coordinates.
        
        Args:
            x: Canvas x coordinate
            y: Canvas y coordinate
            
        Returns:
            Azimuth in degrees (0-359), or None if outside compass circle
        """
        import math
        
        center = self.compass_size / 2
        
        # Calculate distance from center
        dx = x - center
        dy = y - center
        distance = math.sqrt(dx * dx + dy * dy)
        
        # Only respond to clicks within the compass circle
        radius = center - 20
        if distance > radius:
            return None
        
        # Calculate angle from center (0° is East, counter-clockwise in standard math)
        angle_rad = math.atan2(dy, dx)
        angle_deg = math.degrees(angle_rad)
        
        # Convert to azimuth (0° is North, clockwise)
        azimuth = (angle_deg + 90) % 360
        
        return int(azimuth)
    
    def show_compass_tooltip(self, event, azimuth: int):
        """Show tooltip with azimuth value.
        
        Args:
            event: Mouse event
            azimuth: Azimuth in degrees
        """
        # Destroy existing tooltip
        if self.compass_tooltip:
            self.compass_tooltip.destroy()
        
        # Create tooltip
        self.compass_tooltip = tk.Toplevel(self.window)
        self.compass_tooltip.wm_overrideredirect(True)
        self.compass_tooltip.wm_geometry(f"+{event.x_root + 10}+{event.y_root + 10}")
        
        # Determine cardinal direction
        if azimuth < 23 or azimuth >= 338:
            direction = "N"
        elif azimuth < 68:
            direction = "NE"
        elif azimuth < 113:
            direction = "E"
        elif azimuth < 158:
            direction = "SE"
        elif azimuth < 203:
            direction = "S"
        elif azimuth < 248:
            direction = "SW"
        elif azimuth < 293:
            direction = "W"
        else:
            direction = "NW"
        
        tooltip_text = f"{azimuth}° ({direction})"
        if self.password_var.get().strip():
            tooltip_text += "\nClick to set"
        
        label = tk.Label(
            self.compass_tooltip,
            text=tooltip_text,
            background='#2a2a2a',
            foreground='#ddd',
            relief=tk.SOLID,
            borderwidth=1,
            font=('TkDefaultFont', 9),
            padx=8,
            pady=6
        )
        label.pack()
    
    def hide_compass_tooltip(self):
        """Hide compass tooltip."""
        # Cancel any pending tooltip
        if self.compass_tooltip_after_id:
            self.window.after_cancel(self.compass_tooltip_after_id)
            self.compass_tooltip_after_id = None
        
        # Destroy existing tooltip
        if self.compass_tooltip:
            self.compass_tooltip.destroy()
            self.compass_tooltip = None
    
    def on_password_changed(self):
        """Handle password field changes - enable/disable control buttons and save password."""
        password = self.password_var.get().strip()
        has_password = bool(password)
        
        # Enable/disable all control buttons based on password presence
        state = 'normal' if has_password else 'disabled'
        for btn in self.control_buttons:
            btn.config(state=state)
        self.azimuth_entry.config(state=state)
        
        # Save password only if it has changed
        if has_password and password != self.last_saved_password:
            self.save_password(password)
    
    def adjust_azimuth(self, delta: int):
        """Adjust azimuth by delta degrees.
        
        Args:
            delta: Degrees to add to current azimuth (can be negative)
        """
        if not self.status_data:
            messagebox.showerror("Error", "No current position data available")
            return
        
        # Get current azimuth
        position = self.status_data.get('position', {})
        current_azimuth = position.get('azimuth', 0)
        
        # Calculate new azimuth (wrap around 0-359)
        new_azimuth = (current_azimuth + delta) % 360
        
        # Send position command
        self.send_position_command(new_azimuth)
    
    def set_azimuth_direct(self, azimuth: int):
        """Set azimuth to a specific value (for cardinal direction buttons).
        
        Args:
            azimuth: Target azimuth in degrees (0-359)
        """
        # Send position command directly
        self.send_position_command(azimuth)
    
    def set_azimuth(self):
        """Set azimuth to the value in the manual input field."""
        try:
            azimuth_str = self.azimuth_input_var.get().strip()
            if not azimuth_str:
                return
            
            azimuth = int(azimuth_str)
            
            # Validate range
            if azimuth < 0 or azimuth > 359:
                messagebox.showerror("Invalid Azimuth", "Azimuth must be between 0 and 359 degrees")
                return
            
            # Send position command
            self.send_position_command(azimuth)
            
        except ValueError:
            messagebox.showerror("Invalid Input", "Please enter a valid number (0-359)")
    
    def send_position_command(self, azimuth: int):
        """Send position command to rotator.
        
        Args:
            azimuth: Target azimuth in degrees (0-359)
        """
        password = self.password_var.get().strip()
        if not password:
            messagebox.showerror("Error", "Password required for rotator control")
            return
        
        # Send command in background thread
        def send_in_thread():
            try:
                url = f"{self.base_url}/api/rotctl/position"
                payload = {
                    "password": password,
                    "azimuth": azimuth
                }
                
                response = requests.post(url, json=payload, timeout=5)
                response.raise_for_status()
                
                # Success - update status on main thread
                self.window.after(0, lambda: self.on_position_success(azimuth))
                
            except requests.exceptions.HTTPError as e:
                if e.response.status_code == 401:
                    error_msg = "Invalid password"
                elif e.response.status_code == 403:
                    error_msg = "Rotator is read-only"
                else:
                    error_msg = f"HTTP error: {e}"
                self.window.after(0, lambda: self.on_command_error(error_msg))
            except requests.exceptions.RequestException as e:
                error_msg = f"Network error: {e}"
                self.window.after(0, lambda: self.on_command_error(error_msg))
            except Exception as e:
                error_msg = f"Error: {e}"
                self.window.after(0, lambda: self.on_command_error(error_msg))
        
        # Run in background thread
        thread = threading.Thread(target=send_in_thread, daemon=True)
        thread.start()
        
        # Show sending status
        self.status_label.config(text=f"Sending command: Az={azimuth}°...", foreground='blue')
    
    def send_command(self, command: str):
        """Send a command to the rotator (stop or park).
        
        Args:
            command: Command to send ('stop' or 'park')
        """
        password = self.password_var.get().strip()
        if not password:
            messagebox.showerror("Error", "Password required for rotator control")
            return
        
        # Send command in background thread
        def send_in_thread():
            try:
                url = f"{self.base_url}/api/rotctl/command"
                payload = {
                    "password": password,
                    "command": command
                }
                
                response = requests.post(url, json=payload, timeout=5)
                response.raise_for_status()
                
                # Success - update status on main thread
                self.window.after(0, lambda: self.on_command_success(command))
                
            except requests.exceptions.HTTPError as e:
                if e.response.status_code == 401:
                    error_msg = "Invalid password"
                elif e.response.status_code == 403:
                    error_msg = "Rotator is read-only"
                else:
                    error_msg = f"HTTP error: {e}"
                self.window.after(0, lambda: self.on_command_error(error_msg))
            except requests.exceptions.RequestException as e:
                error_msg = f"Network error: {e}"
                self.window.after(0, lambda: self.on_command_error(error_msg))
            except Exception as e:
                error_msg = f"Error: {e}"
                self.window.after(0, lambda: self.on_command_error(error_msg))
        
        # Run in background thread
        thread = threading.Thread(target=send_in_thread, daemon=True)
        thread.start()
        
        # Show sending status
        self.status_label.config(text=f"Sending {command.upper()} command...", foreground='blue')
    
    def on_position_success(self, azimuth: int):
        """Handle successful position command.
        
        Args:
            azimuth: Azimuth that was set
        """
        self.status_label.config(text=f"✓ Position command sent: Az={azimuth}°", foreground='green')
        # Clear manual input field
        self.azimuth_input_var.set("")
        # Trigger immediate refresh to show new position
        self.refresh_data()
    
    def on_command_success(self, command: str):
        """Handle successful command (stop or park).
        
        Args:
            command: Command that was executed
        """
        self.status_label.config(text=f"✓ {command.upper()} command sent", foreground='green')
        # Trigger immediate refresh to show new status
        self.refresh_data()
    
    def on_command_error(self, error_msg: str):
        """Handle command error.
        
        Args:
            error_msg: Error message to display
        """
        self.status_label.config(text=f"✗ {error_msg}", foreground='red')
        messagebox.showerror("Rotator Control Error", error_msg)
    
    def update_display(self, data: Dict):
        """Update display with rotator status data.
        
        Args:
            data: Dictionary from /api/rotctl/status endpoint
        """
        self.status_data = data
        
        # Update connection status
        connected = data.get('connected', False)
        if connected:
            self.status_labels['connection'].config(text="Connected", foreground='green')
        else:
            self.status_labels['connection'].config(text="Disconnected", foreground='red')
        
        # Update enabled status
        enabled = data.get('enabled', False)
        if enabled:
            self.status_labels['enabled'].config(text="Yes", foreground='green')
        else:
            self.status_labels['enabled'].config(text="No", foreground='red')
        
        # Check read_only status and disable controls if true
        readonly = data.get('read_only', False)
        if readonly:
            # Disable password field and all control buttons
            self.password_entry.config(state='disabled')
            self.delete_password_btn.config(state='disabled')
            for btn in self.control_buttons:
                btn.config(state='disabled')
            self.azimuth_entry.config(state='disabled')
            # Show warning in status
            if not self.status_label.cget('text').startswith('✓') and not self.status_label.cget('text').startswith('✗'):
                self.status_label.config(text="⚠ Rotator is read-only", foreground='orange')
        else:
            # Enable password field
            self.password_entry.config(state='normal')
            self.delete_password_btn.config(state='normal')
            # Control buttons will be enabled/disabled based on password presence
            self.on_password_changed()
        
        # Update position
        position = data.get('position', {})
        azimuth = position.get('azimuth', 0)
        elevation = position.get('elevation', 0)
        self.status_labels['azimuth'].config(text=f"{azimuth}°")
        self.status_labels['elevation'].config(text=f"{elevation}°")
        
        # Update compass needle
        self.update_compass_needle(azimuth)
        
        # Update moving status
        moving = data.get('moving', False)
        if moving:
            self.status_labels['moving'].config(text="Yes", foreground='orange')
        else:
            self.status_labels['moving'].config(text="No", foreground='green')
        
        # Update read-only status
        readonly = data.get('read_only', False)
        if readonly:
            self.status_labels['readonly'].config(text="Yes", foreground='orange')
        else:
            self.status_labels['readonly'].config(text="No", foreground='green')
        
        # Update connected duration
        duration_seconds = data.get('connected_duration_seconds', 0)
        if duration_seconds > 0:
            hours = duration_seconds // 3600
            minutes = (duration_seconds % 3600) // 60
            seconds = duration_seconds % 60
            if hours > 0:
                self.status_labels['duration'].config(text=f"{hours}h {minutes}m {seconds}s")
            elif minutes > 0:
                self.status_labels['duration'].config(text=f"{minutes}m {seconds}s")
            else:
                self.status_labels['duration'].config(text=f"{seconds}s")
        else:
            self.status_labels['duration'].config(text="--")
        
        # Update status bar (only if not showing a command result)
        current_status = self.status_label.cget('text')
        if not current_status.startswith('✓') and not current_status.startswith('✗') and not current_status.startswith('Sending'):
            now = datetime.now()
            self.status_label.config(text=f"✓ Updated at {now.strftime('%H:%M:%S')}", foreground='green')
    
    def fetch_initial_status(self):
        """Fetch initial status immediately when window opens (synchronous)."""
        self.status_label.config(text="Loading...", foreground='blue')
        
        # Fetch data in background thread
        thread = threading.Thread(target=self._fetch_data_thread, daemon=True)
        thread.start()
    
    def refresh_data(self):
        """Refresh rotator status data from server (periodic updates)."""
        if not self.running:
            return
        
        # Only show "Loading..." if not showing a command result
        current_status = self.status_label.cget('text')
        if not current_status.startswith('✓') and not current_status.startswith('✗') and not current_status.startswith('Sending'):
            self.status_label.config(text="Loading...", foreground='blue')
        
        # Fetch data in background thread
        thread = threading.Thread(target=self._fetch_data_thread, daemon=True)
        thread.start()
        
        # Schedule next refresh in 3 seconds
        if self.running:
            self.refresh_job = self.window.after(3000, self.refresh_data)
    
    def _fetch_data_thread(self):
        """Fetch data from server (runs in background thread)."""
        try:
            url = f"{self.base_url}/api/rotctl/status"
            response = requests.get(url, timeout=5)
            
            if response.status_code == 204:
                self.window.after(0, lambda: self.status_label.config(
                    text="No data available", foreground='orange'))
                return
            
            response.raise_for_status()
            data = response.json()
            
            # Update display on main thread
            self.window.after(0, lambda: self.update_display(data))
            
        except requests.exceptions.RequestException as e:
            error_msg = f"Network error: {e}"
            self.window.after(0, lambda: self.display_error(error_msg))
        except Exception as e:
            error_msg = f"Error: {e}"
            self.window.after(0, lambda: self.display_error(error_msg))
    
    def display_error(self, error_msg: str):
        """Display error message in UI.
        
        Args:
            error_msg: Error message to display
        """
        # Only update status if not showing a command result
        current_status = self.status_label.cget('text')
        if not current_status.startswith('✓') and not current_status.startswith('✗') and not current_status.startswith('Sending'):
            self.status_label.config(text=error_msg, foreground='red')
    
    def load_saved_password(self):
        """Load saved password for this instance UUID."""
        if not self.instance_uuid:
            return
        
        try:
            if os.path.exists(self.config_file):
                with open(self.config_file, 'r') as f:
                    data = json.load(f)
                    password = data.get(self.instance_uuid)
                    if password:
                        # Set password without triggering save
                        self.last_saved_password = password
                        self.password_var.set(password)
                        print(f"Loaded saved rotator password for instance {self.instance_uuid}")
        except Exception as e:
            print(f"Error loading saved rotator password: {e}")
    
    def save_password(self, password: str):
        """Save password for this instance UUID.
        
        Args:
            password: Password to save
        """
        if not self.instance_uuid:
            return
        
        try:
            # Load existing data
            data = {}
            if os.path.exists(self.config_file):
                with open(self.config_file, 'r') as f:
                    data = json.load(f)
            
            # Update password for this instance
            data[self.instance_uuid] = password
            
            # Save back to file
            with open(self.config_file, 'w') as f:
                json.dump(data, f, indent=2)
            
            # Update last saved password to prevent duplicate saves
            self.last_saved_password = password
            print(f"Saved rotator password for instance {self.instance_uuid}")
        except Exception as e:
            print(f"Error saving rotator password: {e}")
    
    def delete_saved_password(self):
        """Delete saved password for this instance UUID."""
        if not self.instance_uuid:
            # Just clear the field if no UUID
            self.last_saved_password = None
            self.password_var.set("")
            return
        
        try:
            # Load existing data
            if not os.path.exists(self.config_file):
                self.last_saved_password = None
                self.password_var.set("")
                return
            
            with open(self.config_file, 'r') as f:
                data = json.load(f)
            
            # Remove this instance's password if it exists
            if self.instance_uuid in data:
                del data[self.instance_uuid]
                print(f"Deleted saved rotator password for instance {self.instance_uuid}")
                
                # Save back to file
                with open(self.config_file, 'w') as f:
                    json.dump(data, f, indent=2)
            
            # Clear the password field and tracking variable
            self.last_saved_password = None
            self.password_var.set("")
            
        except Exception as e:
            print(f"Error deleting rotator password: {e}")
            # Still clear the field even if file operation failed
            self.last_saved_password = None
            self.password_var.set("")
    
    def validate_rotctl_port(self):
        """Validate the rotctl port input."""
        port_str = self.rotctl_port_var.get().strip()
        if not port_str:
            return

        try:
            port = int(port_str)
            if port < 1 or port > 65535:
                self.rotctl_port_entry.config(foreground='red')
            else:
                self.rotctl_port_entry.config(foreground='black')
        except ValueError:
            self.rotctl_port_entry.config(foreground='red')

    def toggle_rotctl_server(self):
        """Start or stop the rotctl server."""
        if self.rotctl_server_running:
            self.stop_rotctl_server()
        else:
            self.start_rotctl_server()

    def start_rotctl_server(self):
        """Start the rotctl server in a background thread."""
        port_str = self.rotctl_port_var.get().strip()
        if not port_str:
            messagebox.showerror("Error", "Please enter a port number")
            return

        try:
            port = int(port_str)
            if port < 1 or port > 65535:
                messagebox.showerror("Error", "Port must be between 1 and 65535")
                return
        except ValueError:
            messagebox.showerror("Error", "Invalid port number")
            return

        # Import rotctld module
        try:
            import sys
            sys.path.insert(0, os.path.dirname(__file__))
            from rotctld import RotatorAPI, RotctldServer

            # Get password from UI (use the same password as for direct control)
            password = self.password_var.get().strip() if self.password_var.get().strip() else None

            # Create rotator API interface with password
            rotator_api = RotatorAPI(self.base_url, password)

            # Create server
            self.rotctl_server_instance = RotctldServer('127.0.0.1', port, rotator_api)

            # Start server in background thread
            self.rotctl_server_thread = threading.Thread(
                target=self._run_rotctl_server,
                daemon=True
            )
            self.rotctl_server_thread.start()

            # Wait a moment to see if it starts successfully
            import time
            time.sleep(0.3)

            if not self.rotctl_server_running:
                messagebox.showerror("Error", f"Port {port} is already in use.\nPlease choose a different port.")
                return

            self.rotctl_start_stop_btn.config(text="Stop")
            self.rotctl_status_label.config(text=f"Running on port {port}", foreground='green')
            self.rotctl_port_entry.config(state='disabled')

            # Start monitoring for client connections
            self.monitor_rotctl_clients()

        except Exception as e:
            messagebox.showerror("Error", f"Failed to start rotctl server: {e}")
            self.rotctl_server_instance = None

    def _run_rotctl_server(self):
        """Run the rotctl server (called in background thread)."""
        try:
            self.rotctl_server_running = True
            self.rotctl_connected_clients = []
            self.rotctl_server_instance.start()
        except OSError as e:
            # Port in use or other socket error
            self.rotctl_server_running = False
            print(f"Rotctl server error: {e}")
        except Exception as e:
            self.rotctl_server_running = False
            print(f"Rotctl server error: {e}")

    def monitor_rotctl_clients(self):
        """Monitor rotctl server for client connections."""
        if not self.rotctl_server_running:
            return

        try:
            # Get connected clients from server instance
            if self.rotctl_server_instance and hasattr(self.rotctl_server_instance, 'get_connected_clients'):
                active_clients = self.rotctl_server_instance.get_connected_clients()
            else:
                active_clients = []

            # Update display
            if active_clients:
                # Show last 3 clients
                display_clients = active_clients[-3:]
                client_text = ", ".join(display_clients)
                if len(active_clients) > 3:
                    client_text += f" (+{len(active_clients) - 3} more)"
                self.rotctl_clients_label.config(text=client_text, foreground='blue')
            else:
                self.rotctl_clients_label.config(text="None", foreground='gray')

        except Exception as e:
            print(f"Error monitoring rotctl clients: {e}")

        # Schedule next check
        if self.rotctl_server_running:
            self.rotctl_monitor_job = self.window.after(1000, self.monitor_rotctl_clients)

    def stop_rotctl_server(self):
        """Stop the rotctl server."""
        # Cancel monitoring
        if self.rotctl_monitor_job:
            self.window.after_cancel(self.rotctl_monitor_job)
            self.rotctl_monitor_job = None

        # Stop server
        if self.rotctl_server_instance:
            self.rotctl_server_instance.stop()
            self.rotctl_server_instance = None

        # Wait for thread to finish
        if self.rotctl_server_thread and self.rotctl_server_thread.is_alive():
            self.rotctl_server_thread.join(timeout=2.0)
            self.rotctl_server_thread = None

        self.rotctl_server_running = False
        self.rotctl_connected_clients = []
        self.rotctl_start_stop_btn.config(text="Start")
        self.rotctl_status_label.config(text="Stopped", foreground='gray')
        self.rotctl_clients_label.config(text="None", foreground='gray')
        self.rotctl_port_entry.config(state='normal')

    def on_close(self):
        """Handle window close event."""
        self.running = False
        if self.refresh_job:
            self.window.after_cancel(self.refresh_job)

        # Stop rotctl server if running
        if self.rotctl_server_running:
            self.stop_rotctl_server()

        self.window.destroy()


def create_rotator_status_window(parent, server_url: str, use_tls: bool = False, instance_uuid: Optional[str] = None):
    """Create and return a rotator status display window.
    
    Args:
        parent: Parent window
        server_url: Server URL (host:port format)
        use_tls: Whether to use TLS/SSL
        instance_uuid: UUID of the instance (for saving password per instance)
        
    Returns:
        RotatorStatusDisplay instance
    """
    return RotatorStatusDisplay(parent, server_url, use_tls, instance_uuid)
