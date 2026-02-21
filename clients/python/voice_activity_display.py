#!/usr/bin/env python3
"""
Voice Activity Display Window for ka9q_ubersdr Python Client
Shows real-time voice activity detection for the current band
"""

import tkinter as tk
from tkinter import ttk, messagebox
import requests
from datetime import datetime
import threading
import time
from typing import Optional, Dict, List


class VoiceActivityDisplay:
    """Display window for voice activity monitoring."""
    
    def __init__(self, parent, server_url: str, initial_band: str = "40m", tune_callback=None):
        """
        Initialize voice activity display.
        
        Args:
            parent: Parent window
            server_url: Base URL of the server
            initial_band: Initial band to display
            tune_callback: Callback function to tune radio (freq_hz, mode)
        """
        self.parent = parent
        self.server_url = server_url.rstrip('/')
        self.current_band = initial_band
        self.tune_callback = tune_callback
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title(f"Voice Activity - {initial_band}")
        self.window.geometry("600x500")
        self.window.configure(bg='#1a1a1a')
        
        # Auto-refresh control
        self.auto_refresh = True
        self.refresh_interval = 10000  # milliseconds (10 seconds to avoid rate limiting)
        self.refresh_job = None
        
        # Scanning control
        self.scanning = False
        self.scan_interval = 5  # seconds
        self.scan_job = None
        self.scan_activities = []
        self.current_scan_index = 0
        
        # Create UI
        self._create_ui()
        
        # Initial data fetch
        self.fetch_data()
        
        # Start auto-refresh
        self._schedule_refresh()
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self._on_close)
    
    def _create_ui(self):
        """Create the user interface."""
        # Header frame
        header_frame = tk.Frame(self.window, bg='#2c3e50', padx=15, pady=12)
        header_frame.pack(fill=tk.X, padx=10, pady=(10, 5))
        
        self.title_label = tk.Label(
            header_frame,
            text=f"Voice Activity - {self.current_band}",
            font=('Segoe UI', 14, 'bold'),
            bg='#2c3e50',
            fg='#ecf0f1'
        )
        self.title_label.pack(side=tk.LEFT)
        
        refresh_btn = tk.Button(
            header_frame,
            text="↻ Refresh",
            command=self.fetch_data,
            bg='#3498db',
            fg='white',
            font=('Segoe UI', 10),
            relief=tk.FLAT,
            padx=12,
            pady=6,
            cursor='hand2'
        )
        refresh_btn.pack(side=tk.RIGHT)
        
        # Stats frame
        stats_frame = tk.Frame(self.window, bg='#1a1a1a')
        stats_frame.pack(fill=tk.X, padx=10, pady=5)
        
        # Create stat cards
        self.total_label = self._create_stat_card(stats_frame, "Total Activities", "0")
        self.noise_label = self._create_stat_card(stats_frame, "Noise Floor", "N/A")
        self.time_label = self._create_stat_card(stats_frame, "Last Update", "N/A")
        
        # Scan controls frame
        scan_frame = tk.Frame(self.window, bg='#2c3e50', padx=15, pady=12)
        scan_frame.pack(fill=tk.X, padx=10, pady=5)
        
        self.scan_btn = tk.Button(
            scan_frame,
            text="Scan",
            command=self.start_scan,
            bg='#27ae60',
            fg='white',
            font=('Segoe UI', 10, 'bold'),
            relief=tk.FLAT,
            padx=16,
            pady=8,
            cursor='hand2'
        )
        self.scan_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        self.stop_btn = tk.Button(
            scan_frame,
            text="Stop",
            command=self.stop_scan,
            bg='#e74c3c',
            fg='white',
            font=('Segoe UI', 10, 'bold'),
            relief=tk.FLAT,
            padx=16,
            pady=8,
            cursor='hand2',
            state=tk.DISABLED,
            disabledforeground='white'
        )
        self.stop_btn.pack(side=tk.LEFT, padx=5)
        
        prev_btn = tk.Button(
            scan_frame,
            text="◄",
            command=self.navigate_previous,
            bg='#3498db',
            fg='white',
            font=('Segoe UI', 12, 'bold'),
            relief=tk.FLAT,
            width=3,
            pady=6,
            cursor='hand2'
        )
        prev_btn.pack(side=tk.LEFT, padx=5)
        
        next_btn = tk.Button(
            scan_frame,
            text="►",
            command=self.navigate_next,
            bg='#3498db',
            fg='white',
            font=('Segoe UI', 12, 'bold'),
            relief=tk.FLAT,
            width=3,
            pady=6,
            cursor='hand2'
        )
        next_btn.pack(side=tk.LEFT, padx=5)
        
        # Interval control
        interval_frame = tk.Frame(scan_frame, bg='#2c3e50')
        interval_frame.pack(side=tk.LEFT, padx=10)
        
        tk.Label(
            interval_frame,
            text="Interval:",
            font=('Segoe UI', 9),
            bg='#2c3e50',
            fg='#95a5a6'
        ).pack(side=tk.LEFT, padx=(0, 5))
        
        self.interval_var = tk.StringVar(value="5")
        interval_entry = tk.Entry(
            interval_frame,
            textvariable=self.interval_var,
            width=5,
            font=('Segoe UI', 9),
            bg='#34495e',
            fg='#ecf0f1',
            relief=tk.FLAT
        )
        interval_entry.pack(side=tk.LEFT, padx=(0, 5))
        
        tk.Label(
            interval_frame,
            text="sec",
            font=('Segoe UI', 9),
            bg='#2c3e50',
            fg='#95a5a6'
        ).pack(side=tk.LEFT)
        
        # Scan status
        self.scan_status_label = tk.Label(
            scan_frame,
            text="",
            font=('Segoe UI', 9),
            bg='#2c3e50',
            fg='#95a5a6'
        )
        self.scan_status_label.pack(side=tk.RIGHT)
        
        # Activity list frame with Treeview (much faster than individual frames)
        list_frame = tk.Frame(self.window, bg='#2c3e50')
        list_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        
        # Header
        header = tk.Label(
            list_frame,
            text="Recent Voice Activity",
            font=('Segoe UI', 11, 'bold'),
            bg='#34495e',
            fg='#ecf0f1',
            anchor=tk.W,
            padx=15,
            pady=10
        )
        header.pack(fill=tk.X)
        
        # Create Treeview for fast rendering
        tree_frame = tk.Frame(list_frame, bg='#2c3e50')
        tree_frame.pack(fill=tk.BOTH, expand=True)
        
        # Scrollbar
        scrollbar = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # Configure Treeview style for dark theme
        style = ttk.Style()
        # Configure custom dark style
        style.configure('Dark.Treeview',
                       background='#2c3e50',
                       foreground='#ecf0f1',
                       fieldbackground='#2c3e50',
                       borderwidth=0,
                       relief='flat')
        style.configure('Dark.Treeview.Heading',
                       background='#34495e',
                       foreground='#ecf0f1',
                       borderwidth=1,
                       relief='flat')
        style.map('Dark.Treeview',
                 background=[('selected', '#3498db')],
                 foreground=[('selected', 'white')])

        # Also set the layout to ensure background fills properly
        style.layout('Dark.Treeview', [('Dark.Treeview.treearea', {'sticky': 'nswe'})])
        
        # Treeview (hide headings to avoid white header styling issues)
        self.activity_tree = ttk.Treeview(
            tree_frame,
            columns=('frequency', 'mode', 'bandwidth', 'snr'),
            show='tree',
            selectmode='browse',
            yscrollcommand=scrollbar.set,
            style='Dark.Treeview'
        )
        scrollbar.config(command=self.activity_tree.yview)
        
        # Configure columns (headings not shown but still configure for structure)
        self.activity_tree.column('#0', width=0, stretch=False)  # Hide tree column
        self.activity_tree.column('frequency', width=120, anchor=tk.W)
        self.activity_tree.column('mode', width=60, anchor=tk.CENTER)
        self.activity_tree.column('bandwidth', width=100, anchor=tk.CENTER)
        self.activity_tree.column('snr', width=80, anchor=tk.E)
        
        self.activity_tree.pack(fill=tk.BOTH, expand=True)
        
        # Bind single-click to tune
        self.activity_tree.bind('<Button-1>', self._on_activity_click)
        
        # Store activity data for tuning
        self.activity_data = {}
        
        # Last updated label
        self.last_updated_label = tk.Label(
            self.window,
            text="",
            font=('Segoe UI', 9),
            bg='#1a1a1a',
            fg='#7f8c8d'
        )
        self.last_updated_label.pack(pady=5)
    
    def _create_stat_card(self, parent, label_text, value_text):
        """Create a statistics card."""
        card = tk.Frame(parent, bg='#2c3e50', relief=tk.FLAT, bd=0)
        card.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=5)
        
        # Add left border
        border = tk.Frame(card, bg='#3498db', width=3)
        border.pack(side=tk.LEFT, fill=tk.Y)
        
        content = tk.Frame(card, bg='#2c3e50')
        content.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=12, pady=12)
        
        label = tk.Label(
            content,
            text=label_text,
            font=('Segoe UI', 9),
            bg='#2c3e50',
            fg='#95a5a6'
        )
        label.pack(anchor=tk.W)
        
        value = tk.Label(
            content,
            text=value_text,
            font=('Segoe UI', 16, 'bold'),
            bg='#2c3e50',
            fg='#ecf0f1'
        )
        value.pack(anchor=tk.W)
        
        return value
    
    def _on_activity_click(self, event):
        """Handle click on activity to tune."""
        # Get the item that was clicked
        item_id = self.activity_tree.identify_row(event.y)
        if item_id and item_id in self.activity_data:
            freq_hz, mode = self.activity_data[item_id]
            self.tune_to_frequency(freq_hz, mode)
    
    def fetch_data(self):
        """Fetch voice activity data from server."""
        def fetch_thread():
            try:
                url = f"{self.server_url}/api/noisefloor/voice-activity?band={self.current_band}"
                response = requests.get(url, timeout=5)

                # Handle rate limit silently - don't show error to user
                if response.status_code == 429:
                    print(f"Rate limit hit for {self.current_band}, will retry on next refresh")
                    return

                response.raise_for_status()

                # Handle empty response (204 No Content or empty body)
                if response.status_code == 204 or not response.text.strip():
                    # No data available - show empty results
                    empty_data = {
                        'band': self.current_band,
                        'timestamp': None,
                        'noise_floor_db': None,
                        'activities': [],
                        'total_activities': 0
                    }
                    self.window.after(0, lambda: self._display_data(empty_data))
                    return

                data = response.json()

                # Update UI in main thread
                self.window.after(0, lambda: self._display_data(data))
                
            except requests.exceptions.JSONDecodeError as e:
                # Handle JSON parsing errors (empty response, invalid JSON)
                error_msg = f"No data available for {self.current_band} (band may have no activity)"
                print(f"JSON decode error: {e}")
                # Show empty results instead of error
                empty_data = {
                    'band': self.current_band,
                    'timestamp': None,
                    'noise_floor_db': None,
                    'activities': [],
                    'total_activities': 0
                }
                self.window.after(0, lambda: self._display_data(empty_data))
            except requests.exceptions.HTTPError as e:
                # Handle HTTP errors (including 429 rate limit)
                if e.response.status_code == 429:
                    # Rate limit - silently ignore and try again on next refresh
                    print(f"Rate limit hit for {self.current_band}, will retry on next refresh")
                else:
                    error_msg = f"HTTP error {e.response.status_code}: {str(e)}"
                    self.window.after(0, lambda: self._show_error(error_msg))
            except Exception as e:
                error_msg = f"Error loading data: {str(e)}"
                self.window.after(0, lambda: self._show_error(error_msg))
        
        # Run in background thread
        thread = threading.Thread(target=fetch_thread, daemon=True)
        thread.start()
    
    def _display_data(self, data):
        """Display voice activity data using Treeview (fast)."""
        # Update stats
        total = data.get('total_activities', 0)
        self.total_label.config(text=str(total))
        
        noise_floor = data.get('noise_floor_db')
        if noise_floor is not None:
            self.noise_label.config(text=f"{noise_floor:.1f} dB")
        else:
            self.noise_label.config(text="N/A")
        
        timestamp = data.get('timestamp')
        if timestamp:
            try:
                dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                time_str = dt.strftime('%H:%M:%S')
                self.time_label.config(text=time_str)
            except:
                self.time_label.config(text="N/A")
        
        # Clear existing items
        for item in self.activity_tree.get_children():
            self.activity_tree.delete(item)
        
        self.activity_data.clear()
        
        # Add activities to tree
        activities = data.get('activities', [])
        for activity in activities:
            freq_hz = activity.get('estimated_dial_freq') or activity.get('start_freq', 0)
            mode = activity.get('mode', 'LSB')
            bandwidth = activity.get('bandwidth', 0)
            snr = activity.get('signal_above_noise', 0)
            
            # Format values
            freq_khz = freq_hz / 1000
            freq_text = f"{freq_khz:.1f} kHz"
            bw_text = f"{bandwidth} Hz"
            snr_text = f"{snr:.1f} dB"
            
            # Insert into tree
            item_id = self.activity_tree.insert('', 'end', values=(freq_text, mode, bw_text, snr_text))
            
            # Store data for tuning
            self.activity_data[item_id] = (freq_hz, mode.lower())
        
        # Update last updated time
        now = datetime.now()
        self.last_updated_label.config(text=f"Last updated: {now.strftime('%H:%M:%S')}")
    
    def _show_error(self, message):
        """Show error message."""
        messagebox.showerror("Error", message, parent=self.window)
    
    def tune_to_frequency(self, freq_hz, mode):
        """Tune radio to specified frequency and mode."""
        if self.tune_callback:
            try:
                self.tune_callback(freq_hz, mode)
                print(f"Tuned to {freq_hz} Hz, mode {mode}")
            except Exception as e:
                print(f"Error tuning: {e}")
    
    def start_scan(self):
        """Start scanning through activities."""
        # Load current activities
        self.scan_activities = self._load_activities_for_navigation()
        
        if not self.scan_activities:
            messagebox.showwarning("No Activities", "No activities to scan", parent=self.window)
            return
        
        # Get interval
        try:
            interval = int(self.interval_var.get())
            if interval < 2 or interval > 30:
                raise ValueError()
        except:
            messagebox.showerror("Invalid Interval", "Interval must be between 2 and 30 seconds", parent=self.window)
            return
        
        self.scan_interval = interval
        self.scanning = True
        self.current_scan_index = 0
        
        # Update UI
        self.scan_btn.config(state=tk.DISABLED)
        self.stop_btn.config(state=tk.NORMAL)
        
        # Stop auto-refresh during scan
        if self.refresh_job:
            self.window.after_cancel(self.refresh_job)
            self.refresh_job = None
        
        # Tune to first frequency
        self._tune_to_current_scan_frequency()
        
        # Schedule next scan
        self._schedule_scan()
    
    def stop_scan(self):
        """Stop scanning."""
        self.scanning = False
        
        if self.scan_job:
            self.window.after_cancel(self.scan_job)
            self.scan_job = None
        
        # Update UI
        self.scan_btn.config(state=tk.NORMAL)
        self.stop_btn.config(state=tk.DISABLED)
        self.scan_status_label.config(text="", fg='#95a5a6')
        
        # Resume auto-refresh
        self._schedule_refresh()
    
    def _schedule_scan(self):
        """Schedule next scan step."""
        if not self.scanning:
            return
        
        def scan_step():
            if not self.scanning:
                return
            
            self.current_scan_index = (self.current_scan_index + 1) % len(self.scan_activities)
            self._tune_to_current_scan_frequency()
            
            # Check if completed full cycle
            if self.current_scan_index == 0:
                self.stop_scan()
            else:
                self._schedule_scan()
        
        self.scan_job = self.window.after(self.scan_interval * 1000, scan_step)
    
    def _tune_to_current_scan_frequency(self):
        """Tune to current scan frequency."""
        if not self.scan_activities:
            return
        
        activity = self.scan_activities[self.current_scan_index]
        self.tune_to_frequency(activity['frequency'], activity['mode'])
        self._update_scan_status()
    
    def _update_scan_status(self):
        """Update scan status display."""
        if self.scanning and self.scan_activities:
            activity = self.scan_activities[self.current_scan_index]
            freq_khz = activity['frequency'] / 1000
            status_text = f"Scanning: {freq_khz:.0f} kHz ({self.current_scan_index + 1}/{len(self.scan_activities)})"
            self.scan_status_label.config(text=status_text, fg='#27ae60')
    
    def navigate_previous(self):
        """Navigate to previous activity."""
        # Reload activities if not scanning
        if not self.scanning:
            self.scan_activities = self._load_activities_for_navigation()
            if not self.scan_activities:
                messagebox.showwarning("No Activities", "No activities available", parent=self.window)
                return
        
        if not self.scan_activities:
            return
        
        self.current_scan_index = (self.current_scan_index - 1) % len(self.scan_activities)
        self._tune_to_current_scan_frequency()
    
    def navigate_next(self):
        """Navigate to next activity."""
        # Reload activities if not scanning
        if not self.scanning:
            self.scan_activities = self._load_activities_for_navigation()
            if not self.scan_activities:
                messagebox.showwarning("No Activities", "No activities available", parent=self.window)
                return
        
        if not self.scan_activities:
            return
        
        self.current_scan_index = (self.current_scan_index + 1) % len(self.scan_activities)
        self._tune_to_current_scan_frequency()
    
    def _load_activities_for_navigation(self):
        """Load current activities for navigation from Treeview."""
        activities = []
        
        # Get activities from tree
        for item_id in self.activity_tree.get_children():
            if item_id in self.activity_data:
                freq_hz, mode = self.activity_data[item_id]
                activities.append({'frequency': freq_hz, 'mode': mode})
        
        return activities
    
    def _schedule_refresh(self):
        """Schedule next auto-refresh."""
        if self.auto_refresh and not self.scanning:
            self.fetch_data()
            self.refresh_job = self.window.after(self.refresh_interval, self._schedule_refresh)
    
    def set_band(self, band: str):
        """Change the displayed band."""
        if band != self.current_band:
            self.current_band = band
            self.window.title(f"Voice Activity - {band}")
            self.title_label.config(text=f"Voice Activity - {band}")
            
            # Stop scanning if active
            if self.scanning:
                self.stop_scan()
            
            # Fetch new data
            self.fetch_data()
    
    def _on_close(self):
        """Handle window close."""
        # Stop scanning
        if self.scanning:
            self.stop_scan()
        
        # Cancel refresh
        if self.refresh_job:
            self.window.after_cancel(self.refresh_job)
        
        # Destroy window
        self.window.destroy()


def create_voice_activity_window(parent, server_url: str, initial_band: str = "40m", tune_callback=None):
    """
    Create and return a voice activity display window.
    
    Args:
        parent: Parent window
        server_url: Base URL of the server
        initial_band: Initial band to display
        tune_callback: Callback function to tune radio (freq_hz, mode)
    
    Returns:
        VoiceActivityDisplay instance
    """
    return VoiceActivityDisplay(parent, server_url, initial_band, tune_callback)


# Note: Auto-refresh interval is 5 seconds to reduce CPU usage
# UI updates are optimized to reuse existing widgets when possible


if __name__ == "__main__":
    # Test standalone
    root = tk.Tk()
    root.withdraw()
    
    def test_tune(freq_hz, mode):
        print(f"Tune to {freq_hz} Hz, mode {mode}")
    
    display = create_voice_activity_window(
        root,
        "http://localhost:8073",
        "40m",
        test_tune
    )
    
    root.mainloop()
