#!/usr/bin/env python3
"""
Band Conditions Display Window for ka9q_ubersdr
Shows real-time band conditions based on FT8 SNR data
"""

import tkinter as tk
from tkinter import ttk
import requests
from datetime import datetime, timedelta
import threading
import time
from typing import Optional, Dict, List, Tuple
import matplotlib
matplotlib.use('TkAgg')
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure
import matplotlib.dates as mdates
import numpy as np


class BandConditionsDisplay:
    """Display window for band conditions monitoring."""
    
    # SNR thresholds (matching bandconditions.js lines 424-432)
    SNR_THRESHOLDS = {
        'POOR': 6,
        'FAIR': 20,
        'GOOD': 30,
        'EXCELLENT': 30
    }
    
    # Colors for band status (matching bandconditions.js lines 521-525)
    STATE_COLORS = {
        0: '#ef4444',  # POOR - red
        1: '#ff9800',  # FAIR - orange
        2: '#fbbf24',  # GOOD - bright yellow
        3: '#22c55e',  # EXCELLENT - green
    }
    
    # Badge colors (matching bandconditions.html lines 162-180)
    BADGE_COLORS = {
        'POOR': '#ef4444',
        'FAIR': '#ff9800',
        'GOOD': '#fbbf24',
        'EXCELLENT': '#22c55e',
        'UNKNOWN': '#9ca3af'
    }
    
    # Band order
    BAND_ORDER = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m']
    
    def __init__(self, parent, server_url: str, use_tls: bool = False):
        """Initialize band conditions display.
        
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
        self.trend_data: Dict[str, List[Dict]] = {}
        self.latest_data: Dict[str, Dict] = {}
        self.band_states: Dict[str, str] = {}
        
        # Chart state
        self.chart_initialized = False
        self.scatter_collection = None
        self.now_line = None
        self.now_text = None
        
        # Badge references
        self.band_badges = {}
        
        # Refresh control
        self.refresh_job = None
        self.running = True
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("Band Conditions")
        self.window.geometry("1200x620")
        
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
        
        # Info box
        info_frame = ttk.Frame(main_frame, relief=tk.RIDGE, borderwidth=2)
        info_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        info_label = ttk.Label(info_frame,
                              text="This chart shows a rolling 24-hour window. Data to the left of the \"Now\" marker is from today, data to the right is from yesterday.",
                              wraplength=1100, padding="10")
        info_label.pack()
        
        # Real-Time Data section
        data_frame = ttk.LabelFrame(main_frame, text="📡 Real-Time Data from SDR", padding="10")
        data_frame.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        main_frame.rowconfigure(1, weight=1)
        
        # Loading message
        self.loading_label = ttk.Label(data_frame, text="⏳ Waiting for initial data from SDR... This may take a few minutes.",
                                      font=('TkDefaultFont', 11))
        self.loading_label.pack(pady=20)
        
        # Chart frame (hidden initially)
        self.chart_frame = ttk.Frame(data_frame)
        
        # Create matplotlib figure
        self.fig = Figure(figsize=(11, 4), dpi=100, facecolor='#2a5298')
        self.ax = self.fig.add_subplot(111)
        self.ax.set_facecolor('#1e3c72')
        
        # Create canvas
        self.canvas = FigureCanvasTkAgg(self.fig, master=self.chart_frame)
        self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)
        
        # Band status badges frame
        self.badges_frame = ttk.Frame(data_frame)
        
        # Create badge container (will hold persistent badges)
        self.badge_container = tk.Frame(self.badges_frame)
        
        # Legend
        legend_frame = ttk.Frame(data_frame)
        
        ttk.Label(legend_frame, text="Legend:", font=('TkDefaultFont', 9, 'bold')).pack(side=tk.LEFT, padx=(0, 10))
        
        for status, color in [('POOR', self.BADGE_COLORS['POOR']),
                             ('FAIR', self.BADGE_COLORS['FAIR']),
                             ('GOOD', self.BADGE_COLORS['GOOD']),
                             ('EXCELLENT', self.BADGE_COLORS['EXCELLENT'])]:
            frame = ttk.Frame(legend_frame)
            frame.pack(side=tk.LEFT, padx=5)
            
            color_box = tk.Canvas(frame, width=20, height=20, bg=color, highlightthickness=1)
            color_box.pack(side=tk.LEFT, padx=(0, 5))
            
            if status == 'POOR':
                label_text = f"{status} (SNR < 6 dB)"
            elif status == 'FAIR':
                label_text = f"{status} (6-20 dB)"
            elif status == 'GOOD':
                label_text = f"{status} (20-30 dB)"
            else:
                label_text = f"{status} (SNR > 30 dB)"
            
            ttk.Label(frame, text=label_text, font=('TkDefaultFont', 9)).pack(side=tk.LEFT)
        
        # Status bar
        status_frame = ttk.Frame(main_frame)
        status_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(10, 0))
        
        self.status_label = ttk.Label(status_frame, text="Loading...", foreground='blue')
        self.status_label.pack(side=tk.LEFT)
        
        self.countdown_label = ttk.Label(status_frame, text="", foreground='gray')
        self.countdown_label.pack(side=tk.RIGHT)
        
        main_frame.columnconfigure(0, weight=1)
    
    def initialize_chart(self, bands_with_data):
        """Initialize chart with static elements (called once)."""
        if self.chart_initialized:
            return
        
        # Configure axes (static setup)
        self.ax.set_yticks(range(len(bands_with_data)))
        self.ax.set_yticklabels(bands_with_data)
        self.ax.set_ylabel('Band', color='white', fontweight='bold')
        self.ax.set_xlabel('Time (UTC)', color='white', fontweight='bold')
        
        # Set x-axis to show full 24-hour day
        today = datetime.utcnow().date()
        start_of_day = datetime.combine(today, datetime.min.time())
        end_of_day = datetime.combine(today, datetime.max.time())
        self.ax.set_xlim(start_of_day, end_of_day)
        
        # Format x-axis
        self.ax.xaxis.set_major_formatter(mdates.DateFormatter('%H:%M'))
        self.ax.xaxis.set_major_locator(mdates.HourLocator(interval=2))
        self.fig.autofmt_xdate()
        
        # Style (static)
        self.ax.tick_params(colors='white')
        self.ax.spines['bottom'].set_color('white')
        self.ax.spines['left'].set_color('white')
        self.ax.spines['top'].set_visible(False)
        self.ax.spines['right'].set_visible(False)
        self.ax.grid(True, alpha=0.1, color='white')
        
        # Create "Now" line (will be updated, not recreated)
        now = datetime.utcnow()
        self.now_line = self.ax.axvline(now, color='white', linestyle='--', linewidth=2, alpha=0.8)
        
        # Create "Now" text label (will be updated, not recreated)
        y_min, y_max = self.ax.get_ylim()
        self.now_text = self.ax.text(now, y_max + 0.5, f'Now\n{now.strftime("%H:%M")} UTC',
                    color='black', fontsize=9, fontweight='bold',
                    bbox=dict(boxstyle='round,pad=0.3', facecolor='white', alpha=0.9, edgecolor='none'),
                    verticalalignment='bottom', horizontalalignment='center')
        
        self.chart_initialized = True
    
    def update_chart(self):
        """Update the band state chart with current data (optimized for speed)."""
        if not self.trend_data:
            return
        
        # Prepare data points for scatter plot
        all_points = []
        bands_with_data = []
        
        for band in self.BAND_ORDER:
            if band not in self.trend_data or not self.trend_data[band]:
                continue
            
            band_data = self.trend_data[band]
            
            # Filter valid FT8 data
            valid_points = [p for p in band_data if p.get('ft8_snr') and p['ft8_snr'] > 0]
            if not valid_points:
                continue
            
            bands_with_data.append(band)
            
            for point in valid_points:
                snr = point['ft8_snr']
                original_time = datetime.fromisoformat(point['timestamp'].replace('Z', '+00:00'))
                
                # Normalize timestamp to today's date
                today = datetime.utcnow().date()
                normalized_time = datetime.combine(today, original_time.time())
                
                # Determine state based on SNR
                if snr < 6:
                    state = 0  # POOR
                elif snr < 20:
                    state = 1  # FAIR
                elif snr < 30:
                    state = 2  # GOOD
                else:
                    state = 3  # EXCELLENT
                
                all_points.append({
                    'time': normalized_time,
                    'band': band,
                    'state': state,
                    'snr': snr
                })
        
        if not all_points:
            # Clear chart and show message
            if self.scatter_collection:
                self.scatter_collection.remove()
                self.scatter_collection = None
            self.ax.text(0.5, 0.5, 'No FT8 data available',
                        ha='center', va='center', transform=self.ax.transAxes,
                        color='white', fontsize=12)
            self.canvas.draw_idle()
            return
        
        # Initialize chart on first data
        if not self.chart_initialized:
            self.initialize_chart(bands_with_data)
        
        # Prepare arrays for batch scatter plot (much faster than individual calls)
        times = []
        band_indices = []
        colors = []
        
        for point in all_points:
            times.append(point['time'])
            band_indices.append(bands_with_data.index(point['band']))
            colors.append(self.STATE_COLORS[point['state']])
        
        # Update or create scatter collection
        if self.scatter_collection:
            # Update existing collection (fast)
            offsets = np.column_stack([mdates.date2num(times), band_indices])
            self.scatter_collection.set_offsets(offsets)
            self.scatter_collection.set_facecolors(colors)
        else:
            # Create new collection (first time only)
            self.scatter_collection = self.ax.scatter(times, band_indices, c=colors, s=200, marker='s',
                           edgecolors=(1, 1, 1, 0.3), linewidths=0.5, alpha=0.9)
        
        # Update "Now" line position
        now = datetime.utcnow()
        self.now_line.set_xdata([now, now])
        
        # Update "Now" text
        self.now_text.set_position((now, self.ax.get_ylim()[1] + 0.5))
        self.now_text.set_text(f'Now\n{now.strftime("%H:%M")} UTC')
        
        # Fast redraw (only changed elements)
        self.canvas.draw_idle()
    
    def create_band_badges(self):
        """Create persistent band badges (called once)."""
        if self.band_badges:
            return  # Already created
        
        self.badge_container.pack(expand=True)
        
        # Create badges for all bands
        for band in self.BAND_ORDER:
            badge = tk.Label(self.badge_container, text=band, bg=self.BADGE_COLORS['UNKNOWN'], fg='white',
                           font=('TkDefaultFont', 10, 'bold'), padx=16, pady=8,
                           relief=tk.RAISED, borderwidth=2)
            badge.pack(side=tk.LEFT, padx=5)
            self.band_badges[band] = badge
            
            # Add tooltip bindings
            badge.bind('<Enter>', lambda e, b=band: self.show_badge_tooltip(e, b))
            badge.bind('<Leave>', lambda e: self.hide_tooltip())
    
    def update_band_badges(self):
        """Update band status badges (only colors, not recreation)."""
        if not self.latest_data:
            return
        
        # Create badges on first update
        if not self.band_badges:
            self.create_band_badges()
        
        # Update badge colors and visibility
        for band in self.BAND_ORDER:
            badge = self.band_badges[band]
            
            if band not in self.latest_data or not self.latest_data[band].get('ft8_snr'):
                # Hide badge if no data
                badge.pack_forget()
                continue
            
            # Show badge and update color
            if not badge.winfo_ismapped():
                badge.pack(side=tk.LEFT, padx=5)
            
            status = self.band_states.get(band, 'UNKNOWN')
            color = self.BADGE_COLORS[status]
            badge.config(bg=color)
    
    def show_badge_tooltip(self, event, band):
        """Show tooltip for badge on hover."""
        if band in self.latest_data and self.latest_data[band].get('ft8_snr'):
            snr = self.latest_data[band]['ft8_snr']
            status = self.band_states.get(band, 'UNKNOWN')
            self.status_label.config(text=f"{band}: {status} ({snr:.1f} dB)", foreground='blue')
    
    def show_tooltip(self, event, text):
        """Show tooltip on hover."""
        self.status_label.config(text=text, foreground='blue')
    
    def hide_tooltip(self):
        """Hide tooltip."""
        if self.latest_data:
            self.status_label.config(text="✓ Data loaded successfully", foreground='green')
    
    def refresh_data(self):
        """Refresh band conditions data from server."""
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
            # Fetch latest data
            latest_url = f"{self.base_url}/api/noisefloor/latest"
            latest_response = requests.get(latest_url, timeout=10)
            
            if latest_response.status_code == 204:
                self.window.after(0, lambda: self.update_display_no_data())
                return
            
            latest_response.raise_for_status()
            latest_data = latest_response.json()
            
            # Fetch trend data
            trend_url = f"{self.base_url}/api/noisefloor/trends"
            trend_response = requests.get(trend_url, timeout=10)
            
            if trend_response.status_code == 204:
                trend_data = {}
            else:
                trend_response.raise_for_status()
                trend_data = trend_response.json()
            
            # Update display on main thread
            self.window.after(0, lambda: self.update_display(latest_data, trend_data))
            
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
        self.loading_label.pack(pady=20)
        self.chart_frame.pack_forget()
        self.badges_frame.pack_forget()
    
    def update_display_error(self, error_msg: str):
        """Update display with error message."""
        self.status_label.config(text=f"Error: {error_msg}", foreground='red')
    
    def update_display(self, latest_data: Dict, trend_data: Dict):
        """Update display with fetched data."""
        self.latest_data = latest_data
        self.trend_data = trend_data
        
        # Process band states from latest data
        for band in self.BAND_ORDER:
            if band not in latest_data or not latest_data[band].get('ft8_snr'):
                self.band_states[band] = 'UNKNOWN'
                continue
            
            snr = latest_data[band]['ft8_snr']
            
            if snr < self.SNR_THRESHOLDS['POOR']:
                status = 'POOR'
            elif snr < self.SNR_THRESHOLDS['FAIR']:
                status = 'FAIR'
            elif snr < self.SNR_THRESHOLDS['GOOD']:
                status = 'GOOD'
            else:
                status = 'EXCELLENT'
            
            self.band_states[band] = status
        
        # Hide loading, show chart
        self.loading_label.pack_forget()
        self.chart_frame.pack(fill=tk.BOTH, expand=True, pady=(0, 10))
        self.badges_frame.pack(fill=tk.X, pady=(0, 10))
        
        # Update chart and badges (optimized - no recreation)
        self.update_chart()
        self.update_band_badges()
        
        # Update status
        self.status_label.config(text="✓ Data loaded successfully", foreground='green')
    
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


def create_band_conditions_window(parent, server_url: str, use_tls: bool = False):
    """Create and return a band conditions display window.
    
    Args:
        parent: Parent window
        server_url: Server URL (host:port format)
        use_tls: Whether to use TLS/SSL
        
    Returns:
        BandConditionsDisplay instance
    """
    return BandConditionsDisplay(parent, server_url, use_tls)