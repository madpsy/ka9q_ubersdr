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
        
        # Refresh control
        self.refresh_job = None
        self.running = True
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("Rotator Status & Control")
        self.window.geometry("550x600")
        
        # Create UI
        self.create_widgets()
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.on_close)
        
        # Load saved password for this instance
        self.load_saved_password()
        
        # Start data refresh
        self.refresh_data()
    
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
        
        # Create status display grid
        status_grid = ttk.Frame(status_frame)
        status_grid.pack(fill=tk.BOTH, expand=True)
        
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
        
        # Status bar
        status_bar_frame = ttk.Frame(main_frame)
        status_bar_frame.pack(fill=tk.X)
        
        self.status_label = ttk.Label(status_bar_frame, text="Loading...", foreground='blue')
        self.status_label.pack(side=tk.LEFT)
        
        self.refresh_label = ttk.Label(status_bar_frame, text="Updates every 3s", foreground='gray')
        self.refresh_label.pack(side=tk.RIGHT)
        
        # Configure main frame to expand
        main_frame.rowconfigure(1, weight=1)
    
    def on_password_changed(self):
        """Handle password field changes - enable/disable control buttons and save password."""
        password = self.password_var.get().strip()
        has_password = bool(password)
        
        # Enable/disable all control buttons based on password presence
        state = 'normal' if has_password else 'disabled'
        for btn in self.control_buttons:
            btn.config(state=state)
        self.azimuth_entry.config(state=state)
        
        # Save password if it has a value
        if has_password:
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
        
        # Update position
        position = data.get('position', {})
        azimuth = position.get('azimuth', 0)
        elevation = position.get('elevation', 0)
        self.status_labels['azimuth'].config(text=f"{azimuth}°")
        self.status_labels['elevation'].config(text=f"{elevation}°")
        
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
    
    def refresh_data(self):
        """Refresh rotator status data from server."""
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
            
            print(f"Saved rotator password for instance {self.instance_uuid}")
        except Exception as e:
            print(f"Error saving rotator password: {e}")
    
    def delete_saved_password(self):
        """Delete saved password for this instance UUID."""
        if not self.instance_uuid:
            # Just clear the field if no UUID
            self.password_var.set("")
            return
        
        try:
            # Load existing data
            if not os.path.exists(self.config_file):
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
            
            # Clear the password field
            self.password_var.set("")
            
        except Exception as e:
            print(f"Error deleting rotator password: {e}")
            # Still clear the field even if file operation failed
            self.password_var.set("")
    
    def on_close(self):
        """Handle window close event."""
        self.running = False
        if self.refresh_job:
            self.window.after_cancel(self.refresh_job)
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
