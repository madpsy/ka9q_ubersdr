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
import re
import matplotlib
matplotlib.use('TkAgg')
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure
import numpy as np


def parse_timestamp(timestamp_str: str) -> datetime:
    """Parse timestamp string, handling nanosecond precision.
    
    Python's fromisoformat() doesn't handle nanoseconds well on Windows,
    so we truncate to microseconds before parsing.
    
    Args:
        timestamp_str: ISO format timestamp string
        
    Returns:
        datetime object
    """
    # Remove 'Z' and replace with '+00:00' for UTC
    timestamp_str = timestamp_str.replace('Z', '+00:00')
    
    # Handle nanosecond precision by truncating to microseconds
    # Match pattern like: 2024-01-01T12:00:00.123456789+00:00
    match = re.match(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d+)([\+\-]\d{2}:\d{2})', timestamp_str)
    if match:
        base, fractional, tz = match.groups()
        # Truncate fractional seconds to 6 digits (microseconds)
        fractional = fractional[:6].ljust(6, '0')
        timestamp_str = f"{base}.{fractional}{tz}"
    
    return datetime.fromisoformat(timestamp_str)


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
        self.window.geometry("1475x800")

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

        # Bind mouse wheel scrolling
        def _on_mousewheel(event):
            self.canvas.yview_scroll(int(-1*(event.delta/120)), "units")

        def _on_mousewheel_linux(event):
            if event.num == 4:
                self.canvas.yview_scroll(-1, "units")
            elif event.num == 5:
                self.canvas.yview_scroll(1, "units")

        # Bind for different platforms
        self.canvas.bind_all("<MouseWheel>", _on_mousewheel)  # Windows/Mac
        self.canvas.bind_all("<Button-4>", _on_mousewheel_linux)  # Linux scroll up
        self.canvas.bind_all("<Button-5>", _on_mousewheel_linux)  # Linux scroll down

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

        # Graph toggle checkboxes in bottom right
        graph_controls_frame = ttk.Frame(legend_frame)
        graph_controls_frame.grid(row=3, column=1, sticky=tk.E, padx=10, pady=5)

        ttk.Label(graph_controls_frame, text="Graphs:", font=('TkDefaultFont', 9, 'bold')).pack(side=tk.LEFT, padx=(0, 10))

        trend_check = ttk.Checkbutton(graph_controls_frame, text="Last Hour",
                                     variable=self.show_trend_var,
                                     command=self.toggle_graphs)
        trend_check.pack(side=tk.LEFT, padx=5)

        spectrum_check = ttk.Checkbutton(graph_controls_frame, text="Spectrum",
                                        variable=self.show_spectrum_var,
                                        command=self.toggle_graphs)
        spectrum_check.pack(side=tk.LEFT, padx=5)

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
                dt = parse_timestamp(timestamp)
                time_str = dt.strftime('%H:%M:%S UTC')
            except Exception as e:
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

        # Graph container (will be populated if graphs are enabled)
        graph_frame = ttk.Frame(card)
        graph_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=(5, 10))

        # Return both card and graph_frame
        return card, graph_frame

    def update_band_cards(self):
        """Update or create band cards with current data."""
        if not self.latest_data:
            return

        # Hide loading message
        self.loading_label.pack_forget()

        # Get current bands
        current_bands = [band for band in self.BAND_ORDER if band in self.latest_data]
        existing_bands = list(self.band_cards.keys())

        # Check if we need to recreate (band list changed)
        if set(current_bands) != set(existing_bands):
            # Band list changed, need to recreate
            for band_data in self.band_cards.values():
                if isinstance(band_data, dict) and 'card' in band_data:
                    band_data['card'].destroy()
                elif hasattr(band_data, 'destroy'):
                    band_data.destroy()
            self.band_cards.clear()
            self.trend_canvases.clear()
            self.spectrum_canvases.clear()

            # Create cards for bands with data in 5 columns
            card_index = 0
            for band in current_bands:
                row = card_index // 5
                col = card_index % 5
                card, graph_frame = self.create_band_card(band, self.latest_data[band], row, col)
                self.band_cards[band] = {
                    'card': card,
                    'graph_frame': graph_frame,
                    'band': band
                }
                card_index += 1

            # Update graphs if enabled
            self.update_all_graphs()
        else:
            # Just update the existing card data without recreating
            for band in current_bands:
                if band in self.band_cards:
                    self.update_band_card_data(band, self.latest_data[band])

            # Update graphs with new data
            self.update_all_graphs()

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

    def update_band_card_data(self, band: str, data: Dict):
        """Update data in an existing band card without recreating it.

        Args:
            band: Band name
            data: Updated band data
        """
        band_info = self.band_cards.get(band)
        if not band_info or not isinstance(band_info, dict):
            return

        card = band_info['card']

        # Find and update the timestamp in the header
        for widget in card.winfo_children():
            if isinstance(widget, tk.Frame) and widget.cget('bg') == '#2563eb':
                # This is the header frame
                for label in widget.winfo_children():
                    if isinstance(label, tk.Label) and 'Updated:' in label.cget('text'):
                        timestamp = data.get('timestamp', '')
                        if timestamp:
                            try:
                                dt = parse_timestamp(timestamp)
                                time_str = dt.strftime('%H:%M:%S UTC')
                                label.config(text=f"Updated: {time_str}")
                            except Exception as e:
                                pass
                        break
                break

        # Find and update metrics in the metrics frame
        for widget in card.winfo_children():
            if isinstance(widget, ttk.Frame):
                # Look for metric frames
                for metric_frame in widget.winfo_children():
                    if isinstance(metric_frame, ttk.Frame):
                        labels = [w for w in metric_frame.winfo_children() if isinstance(w, ttk.Label)]
                        if len(labels) >= 2:
                            label_text = labels[0].cget('text')
                            value_label = labels[-1]

                            # Update based on label
                            if 'Noise Floor (P5)' in label_text:
                                value_label.config(text=f"{data.get('p5_db', 0):.1f} dB")
                            elif 'Signal Peak (Max)' in label_text:
                                value_label.config(text=f"{data.get('max_db', 0):.1f} dB")
                            elif 'P95' in label_text:
                                value_label.config(text=f"{data.get('p95_db', 0):.1f} dB")
                            elif 'Median' in label_text:
                                value_label.config(text=f"{data.get('median_db', 0):.1f} dB")
                            elif 'Dynamic Range' in label_text:
                                value_label.config(text=f"{data.get('dynamic_range', 0):.1f} dB")
                            elif 'Band Occupancy' in label_text:
                                value_label.config(text=f"{data.get('occupancy_pct', 0):.1f}%")
                            elif 'FT8 SNR' in label_text and data.get('ft8_snr'):
                                value_label.config(text=f"{data.get('ft8_snr', 0):.1f} dB")

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

    def toggle_graphs(self):
        """Toggle graph visibility based on checkbox state."""
        self.update_all_graphs()

    def update_all_graphs(self):
        """Update graphs for all bands based on current settings."""
        for band, band_data in self.band_cards.items():
            if isinstance(band_data, dict) and 'graph_frame' in band_data:
                graph_frame = band_data['graph_frame']

                # Clear existing graphs
                for widget in graph_frame.winfo_children():
                    widget.destroy()

                # Create separate containers for each graph type to ensure consistent ordering
                trend_container = ttk.Frame(graph_frame)
                trend_container.pack(side=tk.TOP, fill=tk.BOTH, expand=True)

                spectrum_container = ttk.Frame(graph_frame)
                spectrum_container.pack(side=tk.TOP, fill=tk.BOTH, expand=True)

                # Add graphs if enabled (trend always first, spectrum always second)
                if self.show_trend_var.get():
                    self.add_trend_graph(band, trend_container)

                if self.show_spectrum_var.get():
                    self.add_spectrum_graph(band, spectrum_container)

    def add_trend_graph(self, band: str, parent_frame: tk.Frame):
        """Add last hour trend graph for a band.

        Args:
            band: Band name (e.g., '40m')
            parent_frame: Parent frame to add graph to
        """
        # Fetch trend data in background
        thread = threading.Thread(
            target=self._fetch_and_render_trend,
            args=(band, parent_frame),
            daemon=True
        )
        thread.start()

    def _fetch_and_render_trend(self, band: str, parent_frame: tk.Frame):
        """Fetch and render trend graph (runs in background thread).

        Args:
            band: Band name
            parent_frame: Parent frame to add graph to
        """
        try:
            url = f"{self.base_url}/api/noisefloor/recent?band={band}"
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            data = response.json()

            if not data:
                return

            # Extract timestamps and P5 values
            timestamps = []
            p5_values = []

            for entry in data:
                if 'timestamp' in entry and 'p5_db' in entry:
                    try:
                        dt = parse_timestamp(entry['timestamp'])
                        timestamps.append(dt)
                        p5_values.append(entry['p5_db'])
                    except Exception as e:
                        continue

            if not timestamps or not p5_values:
                return

            # Render on main thread
            self.window.after(0, lambda: self._render_trend_graph(
                band, parent_frame, timestamps, p5_values
            ))

        except Exception as e:
            print(f"Error fetching trend data for {band}: {e}")

    def _render_trend_graph(self, band: str, parent_frame: tk.Frame,
                           timestamps: list, p5_values: list):
        """Render trend graph on main thread.

        Args:
            band: Band name
            parent_frame: Parent frame to add graph to
            timestamps: List of datetime objects
            p5_values: List of P5 dB values
        """
        try:
            # Get system background color and convert to RGB for cross-platform compatibility
            try:
                bg_color = self.window.cget('bg')
                # Convert system color name to RGB (handles Windows system colors like 'SystemButtonFace')
                rgb = self.window.winfo_rgb(bg_color)
                # Convert from 16-bit RGB (0-65535) to 8-bit (0-255) and format as hex
                bg_color = '#{:02x}{:02x}{:02x}'.format(
                    rgb[0] >> 8, rgb[1] >> 8, rgb[2] >> 8
                )
            except:
                # Fallback to a neutral gray if conversion fails
                bg_color = '#f0f0f0'

            # Create figure without axes or labels (smaller height for trend - 2/3 of original)
            fig = Figure(figsize=(3, 0.67), dpi=80, facecolor=bg_color)
            ax = fig.add_subplot(111, facecolor=bg_color)

            # Plot data
            ax.plot(timestamps, p5_values, color=self.METRIC_COLORS['noise_floor'], linewidth=1.5)

            # Add title at top center
            ax.text(0.5, 0.95, 'Noisefloor (1h)', transform=ax.transAxes,
                   ha='center', va='top', fontsize=9, fontweight='bold')

            # Remove all axes, labels, and ticks
            ax.set_xticks([])
            ax.set_yticks([])
            ax.spines['top'].set_visible(False)
            ax.spines['right'].set_visible(False)
            ax.spines['bottom'].set_visible(False)
            ax.spines['left'].set_visible(False)

            # Tight layout
            fig.tight_layout(pad=0.1)

            # Create canvas
            canvas = FigureCanvasTkAgg(fig, master=parent_frame)
            canvas.draw()
            canvas.get_tk_widget().pack(side=tk.TOP, fill=tk.BOTH, expand=True, padx=5, pady=5)

            # Store reference
            self.trend_canvases[band] = canvas

        except Exception as e:
            print(f"Error rendering trend graph for {band}: {e}")

    def add_spectrum_graph(self, band: str, parent_frame: tk.Frame):
        """Add real-time spectrum graph for a band.

        Args:
            band: Band name (e.g., '40m')
            parent_frame: Parent frame to add graph to
        """
        # Fetch spectrum data in background
        thread = threading.Thread(
            target=self._fetch_and_render_spectrum,
            args=(band, parent_frame),
            daemon=True
        )
        thread.start()

    def _fetch_and_render_spectrum(self, band: str, parent_frame: tk.Frame):
        """Fetch and render spectrum graph (runs in background thread).

        Args:
            band: Band name
            parent_frame: Parent frame to add graph to
        """
        try:
            url = f"{self.base_url}/api/noisefloor/fft?band={band}"
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            spectrum_data = response.json()

            if not spectrum_data or 'data' not in spectrum_data:
                return

            fft_data = spectrum_data['data']
            if not fft_data:
                return

            # Render on main thread - pass the full spectrum_data dict
            self.window.after(0, lambda: self._render_spectrum_graph(
                band, parent_frame, spectrum_data
            ))

        except Exception as e:
            print(f"Error fetching spectrum data for {band}: {e}")

    def _render_spectrum_graph(self, band: str, parent_frame: tk.Frame, spectrum_data: dict):
        """Render spectrum graph on main thread.

        Args:
            band: Band name
            parent_frame: Parent frame to add graph to
            spectrum_data: Dictionary containing FFT data and frequency info
        """
        try:
            # Get system background color and convert to RGB for cross-platform compatibility
            try:
                bg_color = self.window.cget('bg')
                # Convert system color name to RGB (handles Windows system colors like 'SystemButtonFace')
                rgb = self.window.winfo_rgb(bg_color)
                # Convert from 16-bit RGB (0-65535) to 8-bit (0-255) and format as hex
                bg_color = '#{:02x}{:02x}{:02x}'.format(
                    rgb[0] >> 8, rgb[1] >> 8, rgb[2] >> 8
                )
            except:
                # Fallback to a neutral gray if conversion fails
                bg_color = '#f0f0f0'

            # Extract data and frequency information
            fft_data = spectrum_data['data']
            start_freq = spectrum_data.get('start_freq', 0) / 1e6  # Convert Hz to MHz
            bin_width = spectrum_data.get('bin_width', 1) / 1e6  # Convert Hz to MHz

            # Calculate frequency for each bin
            num_bins = len(fft_data)
            frequencies = [start_freq + (i * bin_width) for i in range(num_bins)]

            # Create figure without axes or labels (larger height for spectrum)
            fig = Figure(figsize=(3, 2.0), dpi=80, facecolor=bg_color)
            ax = fig.add_subplot(111, facecolor=bg_color)

            # Plot spectrum with proper frequency scale
            ax.plot(frequencies, fft_data, color=self.METRIC_COLORS['signal_peak'], linewidth=1)
            ax.fill_between(frequencies, fft_data, alpha=0.3, color=self.METRIC_COLORS['signal_peak'])

            # Set Y-axis limits to data range with minimal padding
            data_min = min(fft_data)
            data_max = max(fft_data)
            data_range = data_max - data_min
            padding = data_range * 0.05  # 5% padding
            ax.set_ylim(data_min - padding, data_max + padding)

            # Add title at top center
            ax.text(0.5, 0.95, 'Spectrum (10s)', transform=ax.transAxes,
                   ha='center', va='top', fontsize=9, fontweight='bold')

            # Remove all axes, labels, and ticks
            ax.set_xticks([])
            ax.set_yticks([])
            ax.spines['top'].set_visible(False)
            ax.spines['right'].set_visible(False)
            ax.spines['bottom'].set_visible(False)
            ax.spines['left'].set_visible(False)

            # Tight layout
            fig.tight_layout(pad=0.1)

            # Create canvas
            canvas = FigureCanvasTkAgg(fig, master=parent_frame)
            canvas.draw()
            canvas.get_tk_widget().pack(side=tk.TOP, fill=tk.BOTH, expand=True, padx=5, pady=5)

            # Store reference
            self.spectrum_canvases[band] = canvas

        except Exception as e:
            print(f"Error rendering spectrum graph for {band}: {e}")

    def on_close(self):
        """Handle window close event."""
        self.running = False
        if self.refresh_job:
            self.window.after_cancel(self.refresh_job)

        # Unbind mouse wheel events
        self.canvas.unbind_all("<MouseWheel>")
        self.canvas.unbind_all("<Button-4>")
        self.canvas.unbind_all("<Button-5>")

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