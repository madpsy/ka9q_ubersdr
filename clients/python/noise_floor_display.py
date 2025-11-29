#!/usr/bin/env python3
"""
Noise Floor Display Window for ka9q_ubersdr
Shows real-time per-band noise floor conditions
"""

import tkinter as tk
from tkinter import ttk
import requests
from datetime import datetime
import threading
import time
from typing import Optional, Dict
import matplotlib
matplotlib.use('TkAgg')
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure
import numpy as np


class NoiseFloorDisplay:
    """Display window for noise floor monitoring."""
    
    # Band order
    BAND_ORDER = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '2m']
    
    # Color scheme for metrics
    METRIC_COLORS = {
        'noise_floor': '#ef4444',  # red
        'signal_peak': '#22c55e',  # green
        'dynamic_range': '#3b82f6',  # blue
        'occupancy': '#f59e0b',  # amber
        'ft8_snr': '#8b5cf6',  # purple
    }
    
    def __init__(self, parent, server_url: str, use_tls: bool = False):
        """Initialize noise floor display.
        
        Args:
            parent: Parent window
            server_url: Server URL (host:port format)
            use_tls: Whether to use TLS/SSL
        """
        self.parent = parent
        self.server_url = server_url
        self.use_tls = use_tls
        
        # Build base URL
        if '://' in server_url:
            self.base_url = server_url
        else:
            protocol = 'https' if use_tls else 'http'
            self.base_url = f"{protocol}://{server_url}"
        
        # Data storage
        self.latest_data: Dict[str, Dict] = {}
        
        # Band card references
        self.band_cards = {}
        
        # Refresh control
        self.refresh_job = None
        self.running = True
        
        # Graph visibility flags
        self.show_trend_var = tk.BooleanVar(value=True)  # Last hour enabled by default
        self.show_spectrum_var = tk.BooleanVar(value=False)  # Spectrum disabled by default
        
        # Graph canvases storage
        self.trend_canvases = {}
        self.spectrum_canvases = {}
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("Noise Floor - Current Conditions")
        self.window.geometry("1180x800")
        
        # Create UI
        self.create_widgets()
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.on_close)
        
        # Start data refresh
        self.refresh_data()
    
    def create_widgets(self):
        """Create all UI widgets."""
        # Main container with scrollbar
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        
        # Title
        title_label = ttk.Label(main_frame, text="📊 Current Noise Floor Conditions",
                               font=('TkDefaultFont', 14, 'bold'))
        title_label.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        # Info box
        info_frame = ttk.Frame(main_frame, relief=tk.RIDGE, borderwidth=2)
        info_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        info_label = ttk.Label(info_frame,
                              text="Real-time noise floor measurements from the SDR. Updates every minute.",
                              wraplength=950, padding="10")
        info_label.pack()
        
        # Create canvas with scrollbar for band cards
        canvas_frame = ttk.Frame(main_frame)
        canvas_frame.grid(row=2, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        main_frame.rowconfigure(2, weight=1)
        
        # Canvas and scrollbar (use system background color)
        self.canvas = tk.Canvas(canvas_frame, bg=self.window.cget('bg'), highlightthickness=0)
        scrollbar = ttk.Scrollbar(canvas_frame, orient="vertical", command=self.canvas.yview)
        self.scrollable_frame = ttk.Frame(self.canvas)
        
        self.scrollable_frame.bind(
            "<Configure>",
            lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all"))
        )
        
        self.canvas.create_window((0, 0), window=self.scrollable_frame, anchor="nw")
        self.canvas.configure(yscrollcommand=scrollbar.set)
        
        self.canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        
        # Create 5-column grid container for band cards
        self.cards_container = ttk.Frame(self.scrollable_frame)
        self.cards_container.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        
        # Configure columns to have equal weight
        for col in range(5):
            self.cards_container.columnconfigure(col, weight=1, uniform="column")
        
        # Loading message
        self.loading_label = ttk.Label(self.scrollable_frame,
                                      text="⏳ Loading noise floor data...",
                                      font=('TkDefaultFont', 11))
        self.loading_label.pack(pady=40)
        
        # Legend
        legend_frame = ttk.LabelFrame(main_frame, text="Legend", padding="10")
        legend_frame.grid(row=3, column=0, sticky=(tk.W, tk.E), pady=(10, 0))
        
        legend_items = [
            ("Noise Floor (P5)", "5th percentile - typical noise floor", self.METRIC_COLORS['noise_floor']),
            ("Signal Peak (Max)", "Maximum signal detected", self.METRIC_COLORS['signal_peak']),
            ("P95", "95th percentile signal level", self.METRIC_COLORS['dynamic_range']),
            ("Dynamic Range", "Difference between max and noise floor", self.METRIC_COLORS['dynamic_range']),
            ("Occupancy", "Percentage of time band is active", self.METRIC_COLORS['occupancy']),
            ("FT8 SNR", "FT8 signal-to-noise ratio (if available)", self.METRIC_COLORS['ft8_snr']),
        ]
        
        for i, (label, desc, color) in enumerate(legend_items):
            frame = ttk.Frame(legend_frame)
            frame.grid(row=i // 2, column=i % 2, sticky=tk.W, padx=10, pady=2)
            
            color_box = tk.Canvas(frame, width=16, height=16, bg=color, highlightthickness=1)
            color_box.pack(side=tk.LEFT, padx=(0, 5))
            
            ttk.Label(frame, text=f"{label}:", font=('TkDefaultFont', 9, 'bold')).pack(side=tk.LEFT)
            ttk.Label(frame, text=desc, font=('TkDefaultFont', 9)).pack(side=tk.LEFT, padx=(5, 0))
        
        # Status bar
        status_frame = ttk.Frame(main_frame)
        status_frame.grid(row=4, column=0, sticky=(tk.W, tk.E), pady=(10, 0))
        
        self.status_label = ttk.Label(status_frame, text="Loading...", foreground='blue')
        self.status_label.pack(side=tk.LEFT)
        
        self.countdown_label = ttk.Label(status_frame, text="", foreground='gray')
        self.countdown_label.pack(side=tk.RIGHT)
        
        main_frame.columnconfigure(0, weight=1)
    
    def create_band_card(self, band: str, data: Dict, row: int, col: int) -> tk.Frame:
        """Create a card widget for a band's noise floor data.
        
        Args:
            band: Band name (e.g., '40m')
            data: Band data dictionary
            row: Grid row position
            col: Grid column position
            
        Returns:
            Frame containing the band card
        """
        card = ttk.Frame(self.cards_container, relief=tk.RAISED, borderwidth=2)
        card.grid(row=row, column=col, sticky=(tk.W, tk.E, tk.N, tk.S), padx=5, pady=5)
        
        # Header with band name
        header = tk.Frame(card, bg='#2563eb', height=40)
        header.pack(fill=tk.X)
        header.pack_propagate(False)
        
        band_label = tk.Label(header, text=band, bg='#2563eb', fg='white',
                             font=('TkDefaultFont', 12, 'bold'))
        band_label.pack(side=tk.LEFT, padx=10, pady=8)
        
        # Timestamp
        timestamp = data.get('timestamp', '')
        if timestamp:
            try:
                dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                time_str = dt.strftime('%H:%M:%S UTC')
            except:
                time_str = 'Unknown'
        else:
            time_str = 'Unknown'
        
        time_label = tk.Label(header, text=f"Updated: {time_str}", bg='#2563eb', fg='white',
                             font=('TkDefaultFont', 9))
        time_label.pack(side=tk.RIGHT, padx=10, pady=8)
        
        # Metrics grid
        metrics_frame = ttk.Frame(card, padding="10")
        metrics_frame.pack(fill=tk.BOTH, expand=True)
        
        # Define metrics to display
        metrics = [
            ('Noise Floor (P5)', 'p5_db', 'dB', self.METRIC_COLORS['noise_floor']),
            ('Signal Peak (Max)', 'max_db', 'dB', self.METRIC_COLORS['signal_peak']),
            ('P95', 'p95_db', 'dB', self.METRIC_COLORS['dynamic_range']),
            ('Median', 'median_db', 'dB', self.METRIC_COLORS['dynamic_range']),
            ('Dynamic Range', 'dynamic_range', 'dB', self.METRIC_COLORS['dynamic_range']),
            ('Band Occupancy', 'occupancy_pct', '%', self.METRIC_COLORS['occupancy']),
        ]
        
        # Add FT8 SNR if available
        if data.get('ft8_snr') is not None:
            metrics.append(('FT8 SNR', 'ft8_snr', 'dB', self.METRIC_COLORS['ft8_snr']))
        
        # Create metric displays in a single column (stacked vertically)
        for i, (label, key, unit, color) in enumerate(metrics):
            metric_frame = ttk.Frame(metrics_frame)
            metric_frame.grid(row=i, column=0, padx=5, pady=3, sticky=tk.W)
            
            # Color indicator
            color_box = tk.Canvas(metric_frame, width=12, height=12, bg=color, highlightthickness=0)
            color_box.pack(side=tk.LEFT, padx=(0, 5))
            
            # Label
            ttk.Label(metric_frame, text=f"{label}:", font=('TkDefaultFont', 9)).pack(side=tk.LEFT)
            
            # Value
            value = data.get(key)
            if value is not None:
                if isinstance(value, float):
                    value_str = f"{value:.1f} {unit}"
                else:
                    value_str = f"{value} {unit}"
            else:
                value_str = "N/A"
            
            ttk.Label(metric_frame, text=value_str,
                     font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT, padx=(5, 0))
        
        return card
    
    def update_band_cards(self):
        """Update or create band cards with current data."""
        if not self.latest_data:
            return
        
        # Hide loading message
        self.loading_label.pack_forget()
        
        # Clear existing cards
        for card in self.band_cards.values():
            card.destroy()
        self.band_cards.clear()
        
        # Create cards for bands with data in 5 columns
        card_index = 0
        for band in self.BAND_ORDER:
            if band in self.latest_data:
                row = card_index // 5
                col = card_index % 5
                card = self.create_band_card(band, self.latest_data[band], row, col)
                self.band_cards[band] = card
                card_index += 1
    
    def refresh_data(self):
        """Refresh noise floor data from server."""
        if not self.running:
            return
        
        # Update status
        self.status_label.config(text="Loading data...", foreground='blue')
        
        # Fetch data in background thread
        thread = threading.Thread(target=self._fetch_data_thread, daemon=True)
        thread.start()
        
        # Schedule next refresh in 60 seconds
        self.refresh_job = self.window.after(60000, self.refresh_data)
        
        # Start countdown
        self.start_countdown()
    
    def _fetch_data_thread(self):
        """Fetch data from server (runs in background thread)."""
        try:
            # Fetch latest noise floor data
            url = f"{self.base_url}/api/noisefloor/latest"
            response = requests.get(url, timeout=10)
            
            if response.status_code == 204:
                self.window.after(0, lambda: self.update_display_no_data())
                return
            
            response.raise_for_status()
            data = response.json()
            
            # Update display on main thread
            self.window.after(0, lambda: self.update_display(data))
            
        except requests.exceptions.RequestException as e:
            error_msg = f"Error fetching data: {e}"
            self.window.after(0, lambda: self.update_display_error(error_msg))
        except Exception as e:
            error_msg = f"Unexpected error: {e}"
            self.window.after(0, lambda: self.update_display_error(error_msg))
    
    def update_display_no_data(self):
        """Update display when no data is available."""
        self.status_label.config(text="No data available yet. Waiting for measurements...",
                                foreground='orange')
        self.loading_label.config(text="⏳ Waiting for noise floor data from SDR...")
        self.loading_label.pack(pady=40)
    
    def update_display_error(self, error_msg: str):
        """Update display with error message."""
        self.status_label.config(text=f"Error: {error_msg}", foreground='red')
    
    def update_display(self, data: Dict):
        """Update display with fetched data."""
        self.latest_data = data
        
        # Update band cards
        self.update_band_cards()
        
        # Update status
        band_count = len(data)
        self.status_label.config(text=f"✓ Data loaded successfully ({band_count} bands)",
                                foreground='green')
    
    def start_countdown(self):
        """Start countdown timer for next refresh."""
        self.next_refresh_time = time.time() + 60
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


def create_noise_floor_window(parent, server_url: str, use_tls: bool = False):
    """Create and return a noise floor display window.
    
    Args:
        parent: Parent window
        server_url: Server URL (host:port format)
        use_tls: Whether to use TLS/SSL
        
    Returns:
        NoiseFloorDisplay instance
    """
    return NoiseFloorDisplay(parent, server_url, use_tls)