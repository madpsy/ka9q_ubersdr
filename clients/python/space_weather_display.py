#!/usr/bin/env python3
"""
Space Weather Display Window for ka9q_ubersdr
Shows space weather forecast and band conditions
"""

import tkinter as tk
from tkinter import ttk
import requests
from datetime import datetime
import threading
import time
from typing import Optional, Dict
try:
    from astral import LocationInfo
    from astral.sun import sun
    ASTRAL_AVAILABLE = True
except ImportError:
    ASTRAL_AVAILABLE = False
    print("Warning: astral not available for sunrise/sunset calculations. Install with: pip install astral")


class MinimalSpaceWeatherDisplay:
    """Minimal compact display window for space weather forecast."""

    # Band order
    BAND_ORDER = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m']

    # Condition colors (matching bandconditions.html)
    CONDITION_COLORS = {
        'Poor': '#ef4444',
        'Fair': '#ff9800',
        'Good': '#fbbf24',
        'Excellent': '#22c55e'
    }

    def __init__(self, parent, server_url: str, use_tls: bool = False, gps_coords: Optional[Dict] = None, location_name: Optional[str] = None):
        """Initialize minimal space weather display.

        Args:
            parent: Parent window
            server_url: Server URL (host:port format)
            use_tls: Whether to use TLS/SSL
            gps_coords: GPS coordinates dict with 'lat' and 'lon' keys
            location_name: Location name string
        """
        self.parent = parent
        self.server_url = server_url
        self.use_tls = use_tls
        self.gps_coords = gps_coords
        self.location_name = location_name

        # Build base URL
        if '://' in server_url:
            self.base_url = server_url
        else:
            protocol = 'https' if use_tls else 'http'
            self.base_url = f"{protocol}://{server_url}"

        # Data storage
        self.weather_data: Optional[Dict] = None

        # Widget references for updates
        self.metric_labels = {}
        self.condition_badges = {}

        # Refresh control
        self.refresh_job = None
        self.running = True

        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("Space Weather - Minimal")
        self.window.geometry("600x210")

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

        # Key metrics in compact horizontal text form
        metrics_frame = ttk.LabelFrame(main_frame, text="Key Metrics", padding="10")
        metrics_frame.pack(fill=tk.X, pady=(0, 10))

        metrics_text = ttk.Frame(metrics_frame)
        metrics_text.pack(fill=tk.X)

        # Create horizontal text labels for metrics (bold font)
        self.metrics_display = ttk.Label(metrics_text, text="Loading...", font=('TkDefaultFont', 10, 'bold'))
        self.metrics_display.pack(anchor=tk.W)

        # Conditions frame (will show day OR night, not both)
        self.conditions_frame = ttk.LabelFrame(main_frame, padding="10")
        self.conditions_frame.pack(fill=tk.X, pady=(0, 10))

        conditions_container = ttk.Frame(self.conditions_frame)
        conditions_container.pack(expand=True)

        condition_badges = ttk.Frame(conditions_container)
        condition_badges.pack()

        for band in self.BAND_ORDER:
            badge = tk.Label(condition_badges, text=band, bg='#9ca3af', fg='white',
                           font=('TkDefaultFont', 9, 'bold'), padx=8, pady=4,
                           relief=tk.RAISED, borderwidth=1)
            badge.pack(side=tk.LEFT, padx=3, pady=2)
            self.condition_badges[band] = badge

        # Full view button
        button_frame = ttk.Frame(main_frame)
        button_frame.pack(fill=tk.X)

        full_btn = ttk.Button(button_frame, text="Full View", command=self.open_full_window)
        full_btn.pack(side=tk.RIGHT)

        self.status_label = ttk.Label(button_frame, text="Loading...", foreground='blue')
        self.status_label.pack(side=tk.LEFT)

    def update_display(self, data: Dict):
        """Update display with space weather data."""
        self.weather_data = data

        # Determine if it's day or night
        is_daytime = True  # Default to day
        if self.gps_coords and ASTRAL_AVAILABLE:
            try:
                location = LocationInfo(
                    name=self.location_name or "Receiver",
                    region="",
                    timezone="UTC",
                    latitude=self.gps_coords['lat'],
                    longitude=self.gps_coords['lon']
                )
                s = sun(location.observer, date=datetime.utcnow())
                sunrise = s['sunrise']
                sunset = s['sunset']
                now = datetime.now(sunrise.tzinfo)

                is_daytime = sunrise <= now < sunset
            except Exception as e:
                print(f"Error calculating sunrise/sunset: {e}")

        # Update frame title based on day/night
        day_night_icon = '☀️' if is_daytime else '🌙'
        day_night_text = 'Day' if is_daytime else 'Night'
        location_text = f" ({self.location_name})" if self.location_name else ""
        self.conditions_frame.configure(text=f"{day_night_icon} {day_night_text} Conditions{location_text}")

        # Update key metrics as horizontal text
        solar_flux = data.get('solar_flux', 0)
        k_index = data.get('k_index', 0)
        k_status = data.get('k_index_status', '')
        a_index = data.get('a_index', 0)
        bz = data.get('solar_wind_bz', 0)
        bz_dir = 'Southward' if bz < 0 else 'Northward'
        quality = data.get('propagation_quality', 'Unknown')

        metrics_text = (f"SFI: {solar_flux:.0f}  •  "
                       f"K: {k_index} ({k_status})  •  "
                       f"A: {a_index}  •  "
                       f"Bz: {bz:.1f} nT ({bz_dir})  •  "
                       f"Propagation: {quality}")

        self.metrics_display.config(text=metrics_text)

        # Update band conditions (day OR night, not both)
        conditions_key = 'band_conditions_day' if is_daytime else 'band_conditions_night'
        if conditions_key in data:
            for band in self.BAND_ORDER:
                if band in data[conditions_key]:
                    condition = data[conditions_key][band]
                    color = self.CONDITION_COLORS.get(condition, '#9ca3af')
                    self.condition_badges[band].config(bg=color)
                    # Force widget update on Windows
                    self.condition_badges[band].update_idletasks()

        self.status_label.config(text="✓ Loaded", foreground='green')

    def refresh_data(self):
        """Refresh space weather data from server."""
        if not self.running:
            return

        self.status_label.config(text="Loading...", foreground='blue')

        # Fetch data in background thread
        thread = threading.Thread(target=self._fetch_data_thread, daemon=True)
        thread.start()

        # Schedule next refresh in 5 minutes (300 seconds)
        self.refresh_job = self.window.after(300000, self.refresh_data)

    def _fetch_data_thread(self):
        """Fetch data from server (runs in background thread)."""
        try:
            url = f"{self.base_url}/api/spaceweather"
            response = requests.get(url, timeout=10)

            if response.status_code == 204:
                self.window.after(0, lambda: self.status_label.config(text="No data", foreground='orange'))
                return

            response.raise_for_status()
            data = response.json()

            # Update display on main thread
            self.window.after(0, lambda: self.update_display(data))

        except requests.exceptions.RequestException as e:
            error_msg = f"Error: {e}"
            self.window.after(0, lambda: self.status_label.config(text=error_msg, foreground='red'))
        except Exception as e:
            error_msg = f"Error: {e}"
            self.window.after(0, lambda: self.status_label.config(text=error_msg, foreground='red'))

    def open_full_window(self):
        """Open full space weather window and close this one."""
        SpaceWeatherDisplay(self.parent, self.server_url, self.use_tls, self.gps_coords, self.location_name)
        self.on_close()

    def on_close(self):
        """Handle window close event."""
        self.running = False
        if self.refresh_job:
            self.window.after_cancel(self.refresh_job)
        self.window.destroy()


class SpaceWeatherDisplay:
    """Display window for space weather forecast."""
    
    # Band order
    BAND_ORDER = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m']
    
    # Condition colors (matching bandconditions.html)
    CONDITION_COLORS = {
        'Poor': '#ef4444',
        'Fair': '#ff9800',
        'Good': '#fbbf24',
        'Excellent': '#22c55e'
    }
    
    def __init__(self, parent, server_url: str, use_tls: bool = False, gps_coords: Optional[Dict] = None, location_name: Optional[str] = None):
        """Initialize space weather display.
        
        Args:
            parent: Parent window
            server_url: Server URL (host:port format)
            use_tls: Whether to use TLS/SSL
            gps_coords: GPS coordinates dict with 'lat' and 'lon' keys
            location_name: Location name string
        """
        self.parent = parent
        self.server_url = server_url
        self.use_tls = use_tls
        self.gps_coords = gps_coords
        self.location_name = location_name
        
        # Build base URL
        if '://' in server_url:
            self.base_url = server_url
        else:
            protocol = 'https' if use_tls else 'http'
            self.base_url = f"{protocol}://{server_url}"
        
        # Data storage
        self.weather_data: Optional[Dict] = None
        
        # Widget references for updates
        self.metric_labels = {}
        self.day_badges = {}
        self.night_badges = {}
        self.widgets_created = False
        
        # Refresh control
        self.refresh_job = None
        self.clock_job = None
        self.running = True
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("Space Weather Forecast")
        self.window.geometry("800x600")
        
        # Create UI
        self.create_widgets()
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.on_close)
        
        # Start data refresh and clock
        self.refresh_data()
        self.update_clock()
    
    def create_widgets(self):
        """Create all UI widgets."""
        # Main container
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        
        # Content area (no scrollbar, no title)
        self.content_frame = ttk.Frame(main_frame)
        self.content_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        main_frame.rowconfigure(0, weight=1)
        main_frame.columnconfigure(0, weight=1)
        
        # Loading message
        self.loading_label = ttk.Label(self.content_frame, text="Loading space weather data...",
                                      font=('TkDefaultFont', 11))
        self.loading_label.pack(pady=20)
        
        # Status bar
        status_frame = ttk.Frame(main_frame)
        status_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(10, 0))
        
        self.status_label = ttk.Label(status_frame, text="Loading...", foreground='blue')
        self.status_label.pack(side=tk.LEFT)
        
        self.countdown_label = ttk.Label(status_frame, text="", foreground='gray')
        self.countdown_label.pack(side=tk.RIGHT)
    
    def create_persistent_widgets(self):
        """Create persistent widgets that will be updated (not recreated)."""
        if self.widgets_created:
            return
        
        # Hide loading message
        self.loading_label.pack_forget()
        
        # Day/Night status frame
        if self.gps_coords and ASTRAL_AVAILABLE:
            self.dn_frame = ttk.LabelFrame(self.content_frame, padding="10")
            self.dn_frame.pack(fill=tk.X, pady=(0, 10))
            # Container for sunrise/sunset and minimal button
            top_row = ttk.Frame(self.dn_frame)
            top_row.pack(fill=tk.X)

            self.sunrise_sunset_label = ttk.Label(top_row, font=('TkDefaultFont', 10))
            self.sunrise_sunset_label.pack(side=tk.LEFT, anchor=tk.W)

            # Minimal button on the right
            minimal_btn = ttk.Button(top_row, text="Minimal", command=self.open_minimal_window)
            minimal_btn.pack(side=tk.RIGHT, padx=(10, 0))

            
            self.clock_label = ttk.Label(self.dn_frame, text="", font=('TkDefaultFont', 10, 'bold'))
            self.clock_label.pack(anchor=tk.W, pady=(5, 0))
        elif not ASTRAL_AVAILABLE:
            info_frame = ttk.Frame(self.content_frame, relief=tk.RIDGE, borderwidth=1, padding="10")
            info_frame.pack(fill=tk.X, pady=(0, 10))
            ttk.Label(info_frame,
                     text="ℹ Install 'astral' package for sunrise/sunset times: pip install astral",
                     font=('TkDefaultFont', 9), foreground='blue').pack()
        
        # Forecast frame (initially hidden)
        self.forecast_frame = ttk.Frame(self.content_frame, relief=tk.RIDGE, borderwidth=2)
        self.forecast_inner = ttk.Frame(self.forecast_frame, padding="10")
        self.forecast_inner.pack(fill=tk.X)
        
        self.forecast_title_label = ttk.Label(self.forecast_inner, font=('TkDefaultFont', 11, 'bold'), foreground='#ff9800')
        self.forecast_summary_label = ttk.Label(self.forecast_inner, font=('TkDefaultFont', 10), wraplength=750)
        
        # Last update label
        self.last_update_label = ttk.Label(self.content_frame, font=('TkDefaultFont', 9), foreground='gray')
        self.last_update_label.pack(pady=(0, 10))
        
        # Key metrics
        metrics_frame = ttk.LabelFrame(self.content_frame, text="Key Metrics", padding="10")
        metrics_frame.pack(fill=tk.X, pady=(0, 10))
        
        metrics_grid = ttk.Frame(metrics_frame)
        metrics_grid.pack(fill=tk.X)
        
        # Configure grid columns
        for i in range(5):
            metrics_grid.columnconfigure(i, weight=1)
        
        # Create metric boxes
        self.metric_labels['solar_flux'] = self.create_metric_box(metrics_grid, 0, 0, "Solar Flux", "0 SFU")
        self.metric_labels['k_index'] = self.create_metric_box(metrics_grid, 0, 1, "K-Index", "0")
        self.metric_labels['a_index'] = self.create_metric_box(metrics_grid, 0, 2, "A-Index", "0")
        self.metric_labels['solar_wind'] = self.create_metric_box(metrics_grid, 0, 3, "Solar Wind Bz", "0 nT")
        self.metric_labels['propagation'] = self.create_metric_box(metrics_grid, 0, 4, "Propagation", "Unknown")
        
        # Day conditions
        self.day_frame = ttk.LabelFrame(self.content_frame, text="☀️ Day Conditions", padding="10")
        self.day_frame.pack(fill=tk.X, pady=(0, 5))
        
        day_container = ttk.Frame(self.day_frame)
        day_container.pack(expand=True)
        
        day_badges = ttk.Frame(day_container)
        day_badges.pack()
        
        for band in self.BAND_ORDER:
            badge = tk.Label(day_badges, text=band, bg='#9ca3af', fg='white',
                           font=('TkDefaultFont', 9, 'bold'), padx=8, pady=4,
                           relief=tk.RAISED, borderwidth=1)
            badge.pack(side=tk.LEFT, padx=3, pady=2)
            self.day_badges[band] = badge
        
        # Night conditions
        self.night_frame = ttk.LabelFrame(self.content_frame, text="🌙 Night Conditions", padding="10")
        self.night_frame.pack(fill=tk.X, pady=(0, 10))
        
        night_container = ttk.Frame(self.night_frame)
        night_container.pack(expand=True)
        
        night_badges = ttk.Frame(night_container)
        night_badges.pack()
        
        for band in self.BAND_ORDER:
            badge = tk.Label(night_badges, text=band, bg='#9ca3af', fg='white',
                           font=('TkDefaultFont', 9, 'bold'), padx=8, pady=4,
                           relief=tk.RAISED, borderwidth=1)
            badge.pack(side=tk.LEFT, padx=3, pady=2)
            self.night_badges[band] = badge
        
        self.widgets_created = True
    
    def update_display(self, data: Dict):
        """Update display with space weather data."""
        self.weather_data = data
        
        # Create widgets on first update
        if not self.widgets_created:
            self.create_persistent_widgets()
        
        # Update Day/Night status
        if self.gps_coords and ASTRAL_AVAILABLE:
            try:
                location = LocationInfo(
                    name=self.location_name or "Receiver",
                    region="",
                    timezone="UTC",
                    latitude=self.gps_coords['lat'],
                    longitude=self.gps_coords['lon']
                )
                s = sun(location.observer, date=datetime.utcnow())
                sunrise = s['sunrise']
                sunset = s['sunset']
                now = datetime.now(sunrise.tzinfo)
                
                is_daytime = sunrise <= now < sunset
                day_night_icon = '☀️' if is_daytime else '🌙'
                day_night_text = 'Day' if is_daytime else 'Night'
                
                location_text = f" ({self.location_name})" if self.location_name else ""
                
                # Update frame title
                self.dn_frame.configure(text=f"{day_night_icon} Currently: {day_night_text}{location_text}")
                
                # Update sunrise/sunset label
                self.sunrise_sunset_label.config(
                    text=f"🌅 Sunrise: {sunrise.strftime('%H:%M')} UTC  •  🌇 Sunset: {sunset.strftime('%H:%M')} UTC"
                )
                
                # Update day/night frame highlighting
                if is_daytime:
                    self.day_frame.configure(relief=tk.SOLID, borderwidth=3)
                    self.night_frame.configure(relief=tk.GROOVE, borderwidth=1)
                else:
                    self.day_frame.configure(relief=tk.GROOVE, borderwidth=1)
                    self.night_frame.configure(relief=tk.SOLID, borderwidth=3)
                
            except Exception as e:
                print(f"Error calculating sunrise/sunset: {e}")
        
        # Update forecast (show/hide as needed)
        if 'forecast' in data and data['forecast'].get('summary'):
            if data['forecast']['summary'] != "Quiet conditions expected for the next 24 hours.":
                # Update forecast content
                if data['forecast'].get('geomagnetic_storm'):
                    self.forecast_title_label.config(text=f"⚠️ Forecast: {data['forecast']['geomagnetic_storm']}")
                    self.forecast_title_label.pack(anchor=tk.W)
                else:
                    self.forecast_title_label.pack_forget()
                
                self.forecast_summary_label.config(text=data['forecast']['summary'])
                self.forecast_summary_label.pack(anchor=tk.W, pady=(5, 0))
                
                self.forecast_frame.pack(fill=tk.X, pady=(0, 10), before=self.last_update_label)
            else:
                self.forecast_frame.pack_forget()
        else:
            self.forecast_frame.pack_forget()
        
        # Update last update time
        if 'last_update' in data:
            # Handle nanosecond precision timestamps (Windows doesn't support them)
            timestamp_str = data['last_update'].replace('Z', '+00:00')
            # Truncate nanoseconds to microseconds (6 digits after decimal)
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

            last_update = datetime.fromisoformat(timestamp_str)
            now = datetime.utcnow()
            minutes_ago = int((now - last_update.replace(tzinfo=None)).total_seconds() / 60)
            
            if minutes_ago < 1:
                time_ago = 'just now'
            elif minutes_ago == 1:
                time_ago = '1 minute ago'
            elif minutes_ago < 60:
                time_ago = f'{minutes_ago} minutes ago'
            else:
                time_ago = f'{minutes_ago // 60} hours ago'
            
            self.last_update_label.config(text=f"Last updated: {time_ago}")
        
        # Update key metrics
        self.metric_labels['solar_flux'].config(text=f"{data.get('solar_flux', 0):.0f} SFU")
        self.metric_labels['solar_flux'].update_idletasks()
        
        k_status = data.get('k_index_status', '')
        self.metric_labels['k_index'].config(text=f"{data.get('k_index', 0)} ({k_status})")
        self.metric_labels['k_index'].update_idletasks()
        
        self.metric_labels['a_index'].config(text=f"{data.get('a_index', 0)}")
        self.metric_labels['a_index'].update_idletasks()
        
        bz = data.get('solar_wind_bz', 0)
        bz_dir = 'Southward' if bz < 0 else 'Northward'
        self.metric_labels['solar_wind'].config(text=f"{bz:.1f} nT\n({bz_dir})")
        self.metric_labels['solar_wind'].update_idletasks()
        
        quality = data.get('propagation_quality', 'Unknown')
        quality_colors = {
            'Excellent': '#22c55e',
            'Good': '#fbbf24',
            'Fair': '#ff9800',
            'Poor': '#ef4444'
        }
        quality_color = quality_colors.get(quality, '#9ca3af')
        self.metric_labels['propagation'].config(text=quality, foreground=quality_color)
        self.metric_labels['propagation'].update_idletasks()
        
        # Update band conditions
        if 'band_conditions_day' in data:
            for band in self.BAND_ORDER:
                if band in data['band_conditions_day']:
                    condition = data['band_conditions_day'][band]
                    color = self.CONDITION_COLORS.get(condition, '#9ca3af')
                    self.day_badges[band].config(bg=color)
                    # Force widget update on Windows
                    self.day_badges[band].update_idletasks()
        
        if 'band_conditions_night' in data:
            for band in self.BAND_ORDER:
                if band in data['band_conditions_night']:
                    condition = data['band_conditions_night'][band]
                    color = self.CONDITION_COLORS.get(condition, '#9ca3af')
                    self.night_badges[band].config(bg=color)
                    # Force widget update on Windows
                    self.night_badges[band].update_idletasks()
        
        self.status_label.config(text="✓ Data loaded successfully", foreground='green')
    
    def create_metric_box(self, parent, row, col, title, initial_value, color=None):
        """Create a metric display box and return the value label."""
        frame = ttk.Frame(parent, relief=tk.RIDGE, borderwidth=1)
        frame.grid(row=row, column=col, padx=5, pady=5, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        ttk.Label(frame, text=title, font=('TkDefaultFont', 9)).pack(pady=(5, 0))
        
        value_label = ttk.Label(frame, text=initial_value, font=('TkDefaultFont', 11, 'bold'))
        if color:
            value_label.configure(foreground=color)
        value_label.pack(pady=(0, 5))
        
        return value_label
    
    def update_clock(self):
        """Update UTC clock display."""
        if not self.running:
            return
        
        if hasattr(self, 'clock_label') and self.clock_label.winfo_exists():
            now = datetime.utcnow()
            self.clock_label.config(text=f"🕐 UTC: {now.strftime('%H:%M:%S')}")
        
        self.clock_job = self.window.after(1000, self.update_clock)
    
    def refresh_data(self):
        """Refresh space weather data from server."""
        if not self.running:
            return
        
        self.status_label.config(text="Loading data...", foreground='blue')
        
        # Fetch data in background thread
        thread = threading.Thread(target=self._fetch_data_thread, daemon=True)
        thread.start()
        
        # Schedule next refresh in 5 minutes (300 seconds)
        self.refresh_job = self.window.after(300000, self.refresh_data)
        
        # Start countdown
        self.start_countdown()
    
    def _fetch_data_thread(self):
        """Fetch data from server (runs in background thread)."""
        try:
            url = f"{self.base_url}/api/spaceweather"
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
        self.status_label.config(text="No space weather data available", foreground='orange')
    
    def update_display_error(self, error_msg: str):
        """Update display with error message."""
        self.status_label.config(text=f"Error: {error_msg}", foreground='red')
    
    def start_countdown(self):
        """Start countdown timer for next refresh."""
        self.next_refresh_time = time.time() + 300  # 5 minutes
        self.update_countdown()
    
    def update_countdown(self):
        """Update countdown display."""
        if not self.running:
            return
        
        remaining = int(self.next_refresh_time - time.time())
        if remaining > 0:
            minutes = remaining // 60
            seconds = remaining % 60
            if minutes > 0:
                self.countdown_label.config(text=f"(refreshing in {minutes}m {seconds}s)")
            else:
                self.countdown_label.config(text=f"(refreshing in {seconds}s)")
            self.window.after(1000, self.update_countdown)
        else:
            self.countdown_label.config(text="(refreshing...)")
    
    def open_minimal_window(self):
        """Open minimal space weather window and close this one."""
        MinimalSpaceWeatherDisplay(self.parent, self.server_url, self.use_tls, self.gps_coords, self.location_name)
        self.on_close()

    def on_close(self):
        """Handle window close event."""
        self.running = False
        if self.refresh_job:
            self.window.after_cancel(self.refresh_job)
        if self.clock_job:
            self.window.after_cancel(self.clock_job)
        self.window.destroy()


def create_space_weather_window(parent, server_url: str, use_tls: bool = False, 
                                gps_coords: Optional[Dict] = None, location_name: Optional[str] = None):
    """Create and return a space weather display window.
    
    Args:
        parent: Parent window
        server_url: Server URL (host:port format)
        use_tls: Whether to use TLS/SSL
        gps_coords: GPS coordinates dict with 'lat' and 'lon' keys
        location_name: Location name string
        
    Returns:
        SpaceWeatherDisplay instance
    """
    return SpaceWeatherDisplay(parent, server_url, use_tls, gps_coords, location_name)