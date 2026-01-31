#!/usr/bin/env python3
"""
Users Display Window for ka9q_ubersdr
Shows active channels/users and allows tuning to their frequencies
"""

import tkinter as tk
from tkinter import ttk
import requests
import threading
import time
from typing import Optional, Dict, List
from datetime import datetime


class UsersDisplay:
    """Display window for active users/channels."""
    
    def __init__(self, parent, server_url: str, use_tls: bool = False, session_id_callback=None, tune_callback=None):
        """Initialize users display.
        
        Args:
            parent: Parent window
            server_url: Server URL (host:port format)
            use_tls: Whether to use TLS/SSL
            session_id_callback: Callback function that returns current session ID
            tune_callback: Callback function to tune radio (freq_hz, mode, bw_low, bw_high)
        """
        self.parent = parent
        self.server_url = server_url
        self.use_tls = use_tls
        self.session_id_callback = session_id_callback
        self.tune_callback = tune_callback
        
        # Build base URL
        if '://' in server_url:
            self.base_url = server_url
        else:
            protocol = 'https' if use_tls else 'http'
            self.base_url = f"{protocol}://{server_url}"
        
        # Data storage
        self.channels_data: List[Dict] = []
        
        # Refresh control
        self.refresh_job = None
        self.running = True
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("Active Users")
        self.window.geometry("950x400")
        
        # Create UI
        self.create_widgets()
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.on_close)
        
        # Start data refresh
        self.refresh_data()
    
    def create_widgets(self):
        """Create all UI widgets."""
        # Main container
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        
        # Info label
        info_frame = ttk.Frame(main_frame)
        info_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        ttk.Label(info_frame, text="Active channels on this receiver. Your channel is highlighted.",
                 font=('TkDefaultFont', 9)).pack(side=tk.LEFT)
        
        # Table frame with scrollbar
        table_frame = ttk.Frame(main_frame)
        table_frame.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        main_frame.rowconfigure(1, weight=1)
        
        # Create Treeview with action column
        columns = ('frequency', 'mode', 'bandwidth', 'country', 'active_time')
        self.tree = ttk.Treeview(table_frame, columns=columns, show='tree headings', height=15)
        
        # Define column headings
        self.tree.heading('#0', text='Action')
        self.tree.heading('frequency', text='Frequency')
        self.tree.heading('mode', text='Mode')
        self.tree.heading('bandwidth', text='Bandwidth')
        self.tree.heading('country', text='Country')
        self.tree.heading('active_time', text='Active Time')
        
        # Define column widths
        self.tree.column('#0', width=80, anchor='center')
        self.tree.column('frequency', width=150, anchor='center')
        self.tree.column('mode', width=80, anchor='center')
        self.tree.column('bandwidth', width=150, anchor='center')
        self.tree.column('country', width=120, anchor='center')
        self.tree.column('active_time', width=120, anchor='center')
        
        # Add scrollbar
        scrollbar = ttk.Scrollbar(table_frame, orient=tk.VERTICAL, command=self.tree.yview)
        self.tree.configure(yscrollcommand=scrollbar.set)
        
        # Grid layout
        self.tree.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))
        table_frame.columnconfigure(0, weight=1)
        table_frame.rowconfigure(0, weight=1)
        
        # Bind click to handle button clicks
        self.tree.bind('<Button-1>', self.on_tree_click)
        
        # Configure tag for current user (highlighted row)
        self.tree.tag_configure('current_user', background='#e3f2fd')
        
        # Status bar
        status_frame = ttk.Frame(main_frame)
        status_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(10, 0))
        
        self.status_label = ttk.Label(status_frame, text="Loading...", foreground='blue')
        self.status_label.pack(side=tk.LEFT)
        
        self.countdown_label = ttk.Label(status_frame, text="", foreground='gray')
        self.countdown_label.pack(side=tk.RIGHT)
        
        main_frame.columnconfigure(0, weight=1)
        
        # Store button widgets for each row
        self.tune_buttons = {}
    
    def format_frequency(self, freq_hz: int) -> str:
        """Format frequency for display.
        
        Args:
            freq_hz: Frequency in Hz
            
        Returns:
            Formatted frequency string
        """
        return f"{freq_hz / 1e6:.6f} MHz"
    
    def format_bandwidth(self, low: int, high: int) -> str:
        """Format bandwidth for display.
        
        Args:
            low: Low bandwidth in Hz
            high: High bandwidth in Hz
            
        Returns:
            Formatted bandwidth string
        """
        return f"{low} Hz to {high} Hz"
    
    def format_active_time(self, seconds: float) -> str:
        """Format active time for display.
        
        Args:
            seconds: Active time in seconds
            
        Returns:
            Formatted time string
        """
        if seconds < 60:
            return f"{int(seconds)}s"
        elif seconds < 3600:
            return f"{int(seconds / 60)}m {int(seconds % 60)}s"
        else:
            hours = int(seconds / 3600)
            minutes = int((seconds % 3600) / 60)
            return f"{hours}h {minutes}m"
    
    def update_table(self):
        """Update the table with current channels data."""
        # Clear existing items and buttons
        for item in self.tree.get_children():
            self.tree.delete(item)
        self.tune_buttons.clear()
        
        if not self.channels_data:
            # Show "no users" message
            self.tree.insert('', 'end', text='', values=('No active users', '', '', '', ''))
            return
        
        # Add channels to table
        for i, channel in enumerate(self.channels_data):
            freq_hz = channel.get('frequency', 0)
            mode = channel.get('mode', 'Unknown').upper()
            bw_low = channel.get('bandwidth_low', 0)
            bw_high = channel.get('bandwidth_high', 0)
            
            # Get country if available
            country = channel.get('country', '')
            if not country:
                country = ''
            
            # Calculate active time from created_at and last_active timestamps
            created_at = channel.get('created_at', '')
            last_active = channel.get('last_active', '')
            active_time = 0
            
            if created_at and last_active:
                try:
                    from datetime import datetime
                    # Handle nanosecond precision timestamps (Windows doesn't support them)
                    # Truncate nanoseconds to microseconds (6 digits after decimal)
                    def truncate_nanoseconds(timestamp_str):
                        timestamp_str = timestamp_str.replace('Z', '+00:00')
                        if '.' in timestamp_str:
                            parts = timestamp_str.split('.')
                            if len(parts) == 2:
                                # Keep only first 6 digits of fractional seconds
                                fractional = parts[1][:6]
                                # Find where timezone starts (+ or -)
                                tz_start = -1
                                for i, c in enumerate(parts[1]):
                                    if c in ['+', '-']:
                                        tz_start = i
                                        break
                                if tz_start > 0:
                                    timezone = parts[1][tz_start:]
                                    timestamp_str = f"{parts[0]}.{fractional}{timezone}"
                        return timestamp_str
                    
                    # Parse ISO 8601 timestamps with nanosecond truncation
                    created = datetime.fromisoformat(truncate_nanoseconds(created_at))
                    last = datetime.fromisoformat(truncate_nanoseconds(last_active))
                    active_time = (last - created).total_seconds()
                except Exception:
                    active_time = 0
            
            # Format values
            freq_str = self.format_frequency(freq_hz)
            bw_str = self.format_bandwidth(bw_low, bw_high)
            time_str = self.format_active_time(active_time)
            
            # Determine if this is the current user (index 0 when session_id is provided)
            # The server returns current user first when session_id parameter is used
            is_current = (i == 0)
            
            # Action text
            action_text = "You" if is_current else "Tune ▶"
            
            # Insert row with iid=index for easy retrieval
            tags = ('current_user',) if is_current else ()
            item_id = self.tree.insert('', 'end',
                                      iid=str(i),  # Use index as item ID
                                      text=action_text,
                                      values=(freq_str, mode, bw_str, country, time_str),
                                      tags=tags)
    
    def on_tree_click(self, event):
        """Handle click on tree to detect button clicks in action column."""
        # Identify the clicked region
        region = self.tree.identify_region(event.x, event.y)
        if region != "tree":
            return
        
        # Get the clicked item
        item = self.tree.identify_row(event.y)
        if not item:
            return
        
        # Get channel index from item ID
        try:
            index = int(item)
        except (ValueError, TypeError):
            return
        
        if index >= len(self.channels_data):
            return
        
        channel = self.channels_data[index]
        
        # Check if this is the current user (index 0 when session_id parameter is used)
        is_current = (index == 0)
        
        if is_current:
            # Don't tune to own channel
            return
        
        # Get channel parameters
        freq_hz = channel.get('frequency', 0)
        mode = channel.get('mode', 'USB').upper()
        bw_low = channel.get('bandwidth_low', 50)
        bw_high = channel.get('bandwidth_high', 2700)
        
        # Call tune callback if provided
        if self.tune_callback:
            self.tune_callback(freq_hz, mode, bw_low, bw_high)
            self.status_label.config(
                text=f"Tuned to {self.format_frequency(freq_hz)} ({mode})",
                foreground='green'
            )
            
            # Immediately refresh stats data after tuning
            # Cancel pending refresh and start a new one immediately
            if self.refresh_job:
                self.window.after_cancel(self.refresh_job)
            self.window.after(100, self.refresh_data)  # Small delay to let tune complete
    
    def refresh_data(self):
        """Refresh users data from server."""
        if not self.running:
            return
        
        # Update status
        self.status_label.config(text="Loading data...", foreground='blue')
        
        # Fetch data in background thread
        thread = threading.Thread(target=self._fetch_data_thread, daemon=True)
        thread.start()
        
        # Schedule next refresh in 10 seconds (matching web UI)
        self.refresh_job = self.window.after(10000, self.refresh_data)
        
        # Start countdown
        self.start_countdown()
    
    def _fetch_data_thread(self):
        """Fetch data from server (runs in background thread)."""
        try:
            # Get current session ID from callback (dynamically fetched each time)
            session_id = self.session_id_callback() if self.session_id_callback else None
            
            # Build stats URL with session_id if available
            stats_url = f"{self.base_url}/stats"
            if session_id:
                stats_url += f"?session_id={session_id}"
            
            # Fetch stats
            response = requests.get(stats_url, timeout=5)
            response.raise_for_status()
            data = response.json()
            
            # Extract channels
            channels = data.get('channels', [])
            
            # Update display on main thread
            self.window.after(0, lambda: self.update_display(channels))
            
        except requests.exceptions.RequestException as e:
            error_msg = f"Error fetching data: {e}"
            self.window.after(0, lambda: self.update_display_error(error_msg))
        except Exception as e:
            error_msg = f"Unexpected error: {e}"
            self.window.after(0, lambda: self.update_display_error(error_msg))
    
    def update_display_error(self, error_msg: str):
        """Update display with error message."""
        self.status_label.config(text=f"Error: {error_msg}", foreground='red')
    
    def update_display(self, channels: List[Dict]):
        """Update display with fetched data."""
        self.channels_data = channels
        
        # Update table
        self.update_table()
        
        # Update status
        user_count = len(channels)
        if user_count == 0:
            self.status_label.config(text="No active users", foreground='gray')
        elif user_count == 1:
            self.status_label.config(text="1 active user", foreground='green')
        else:
            self.status_label.config(text=f"{user_count} active users", foreground='green')
    
    def start_countdown(self):
        """Start countdown timer for next refresh."""
        self.next_refresh_time = time.time() + 10
        self.update_countdown()
    
    def update_countdown(self):
        """Update countdown display."""
        if not self.running:
            return
        
        remaining = int(self.next_refresh_time - time.time())
        if remaining > 0:
            self.countdown_label.config(text=f"(refreshing in {remaining}s)")
            self.window.after(1000, self.update_countdown)
        else:
            self.countdown_label.config(text="(refreshing...)")
    
    def on_close(self):
        """Handle window close event."""
        self.running = False
        if self.refresh_job:
            self.window.after_cancel(self.refresh_job)
        self.window.destroy()


def create_users_window(parent, server_url: str, use_tls: bool = False, session_id_callback=None, tune_callback=None):
    """Create and return a users display window.
    
    Args:
        parent: Parent window
        server_url: Server URL (host:port format)
        use_tls: Whether to use TLS/SSL
        session_id_callback: Callback function that returns current session ID
        tune_callback: Callback function to tune radio (freq_hz, mode, bw_low, bw_high)
        
    Returns:
        Tuple of (window, UsersDisplay instance)
    """
    display = UsersDisplay(parent, server_url, use_tls, session_id_callback, tune_callback)
    return display.window, display