"""
CW Spots Display Window for ka9q UberSDR Python Client.
Shows real-time CW spots from CW Skimmer via WebSocket connection.
"""

import tkinter as tk
from tkinter import ttk
import queue
from datetime import datetime
from typing import Optional, Callable
from cw_spots_graph import create_cw_spots_graph_window


class CWSpotsDisplay:
    """Display window for CW spots."""

    def __init__(self, websocket_manager, on_close: Optional[Callable] = None, radio_gui=None, countries=None):
        """
        Initialize the CW spots display.

        Args:
            websocket_manager: Shared DXClusterWebSocket instance
            on_close: Optional callback when window is closed
            radio_gui: Optional reference to RadioGUI for frequency tuning
            countries: Optional list of countries from /api/cty/countries
        """
        self.websocket_manager = websocket_manager
        self.on_close_callback = on_close
        self.radio_gui = radio_gui
        self.countries = countries or []
        self.spots = []
        self.max_spots = 1000
        self.last_spot_time = None  # Track last filtered spot time

        # Graph window reference
        self.graph_window = None

        # Dictionary to map tree item IDs to frequency values
        self.item_frequencies = {}

        # Queue for thread-safe updates
        self.update_queue = queue.Queue()

        # Batched update control
        self._update_pending = False
        self._batch_timer = None

        # Filters
        self.age_filter = 10  # minutes
        self.band_filter = "all"
        self.snr_filter = None
        self.wpm_filter = None
        self.callsign_filter = ""
        self.country_filter = "all"
        self.source_filter = "All"  # Filter by spot source: All, Server, TCI
        self.auto_band = True  # Auto-update band filter when frequency changes

        # Sorting state
        self.sort_column = "time"
        self.sort_reverse = True  # Most recent first by default

        # Create window
        self.window = tk.Toplevel()
        self.window.title("CW Spots")
        self.window.geometry("1200x600")

        # Setup UI
        self._setup_ui()

        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self._on_closing)

        # Start update checking
        self.window.after(100, self.check_updates)

        # Register callbacks AFTER starting update checker
        # This ensures the initial status notification is properly queued and processed
        self.websocket_manager.on_cw_spot(self._handle_spot)
        self.websocket_manager.on_status(self._handle_status)

        # Auto-open graph window
        self.window.after(500, self.open_graph_window)

    def _setup_ui(self):
        """Setup the user interface."""
        # Top frame for status and controls
        top_frame = ttk.Frame(self.window)
        top_frame.pack(fill=tk.X, padx=5, pady=5)

        # Status indicator
        self.status_label = ttk.Label(top_frame, text="Disconnected",
                                     foreground="red", font=("Arial", 10, "bold"))
        self.status_label.pack(side=tk.LEFT, padx=5)

        # Spot count
        self.count_label = ttk.Label(top_frame, text="0 spots")
        self.count_label.pack(side=tk.LEFT, padx=10)

        # Last spot time indicator (top right)
        self.last_spot_label = ttk.Label(top_frame, text="", foreground="gray")
        self.last_spot_label.pack(side=tk.RIGHT, padx=10)

        # Filters frame
        filter_frame = ttk.LabelFrame(self.window, text="Filters", padding=5)
        filter_frame.pack(fill=tk.X, padx=5, pady=5)

        # Age filter
        ttk.Label(filter_frame, text="Age:").grid(row=0, column=0, padx=5, sticky=tk.W)
        self.age_var = tk.StringVar(value="10")
        age_combo = ttk.Combobox(filter_frame, textvariable=self.age_var, width=10,
                                 values=["1", "5", "10", "15", "30", "60", "none"])
        age_combo.grid(row=0, column=1, padx=5)
        age_combo.bind("<<ComboboxSelected>>", lambda e: self.apply_filters())

        # Band filter
        ttk.Label(filter_frame, text="Band:").grid(row=0, column=2, padx=5, sticky=tk.W)
        self.band_var = tk.StringVar(value="all")
        band_combo = ttk.Combobox(filter_frame, textvariable=self.band_var, width=10,
                                  values=["all", "160m", "80m", "60m", "40m", "30m",
                                         "20m", "17m", "15m", "12m", "10m"])
        band_combo.grid(row=0, column=3, padx=5)
        band_combo.bind("<<ComboboxSelected>>", lambda e: self.apply_filters())

        # SNR filter
        ttk.Label(filter_frame, text="Min SNR:").grid(row=0, column=4, padx=5, sticky=tk.W)
        self.snr_var = tk.StringVar(value="none")
        snr_combo = ttk.Combobox(filter_frame, textvariable=self.snr_var, width=10,
                                values=["none", "-10", "0", "5", "10", "15", "20"])
        snr_combo.grid(row=0, column=5, padx=5)
        snr_combo.bind("<<ComboboxSelected>>", lambda e: self.apply_filters())

        # WPM filter
        ttk.Label(filter_frame, text="Min WPM:").grid(row=0, column=6, padx=5, sticky=tk.W)
        self.wpm_var = tk.StringVar(value="none")
        wpm_combo = ttk.Combobox(filter_frame, textvariable=self.wpm_var, width=10,
                                values=["none", "10", "15", "20", "25", "30"])
        wpm_combo.grid(row=0, column=7, padx=5)
        wpm_combo.bind("<<ComboboxSelected>>", lambda e: self.apply_filters())

        # Callsign filter
        ttk.Label(filter_frame, text="Callsign:").grid(row=1, column=0, padx=5, sticky=tk.W)
        self.callsign_var = tk.StringVar()
        callsign_entry = ttk.Entry(filter_frame, textvariable=self.callsign_var, width=15)
        callsign_entry.grid(row=1, column=1, padx=5, pady=5)
        callsign_entry.bind("<KeyRelease>", lambda e: self.apply_filters())

        # Country filter
        ttk.Label(filter_frame, text="Country:").grid(row=1, column=2, padx=5, sticky=tk.W)
        self.country_var = tk.StringVar(value="all")
        country_values = ["all"] + [c['name'] for c in self.countries]
        country_combo = ttk.Combobox(filter_frame, textvariable=self.country_var, width=15,
                                    values=country_values)
        country_combo.grid(row=1, column=3, padx=5, pady=5)
        country_combo.bind("<<ComboboxSelected>>", lambda e: self.apply_filters())

        # Source filter
        ttk.Label(filter_frame, text="Source:").grid(row=1, column=4, padx=5, sticky=tk.W)
        self.source_var = tk.StringVar(value="All")
        source_combo = ttk.Combobox(filter_frame, textvariable=self.source_var, width=10,
                                    values=["All", "Server", "TCI"])
        source_combo.grid(row=1, column=5, padx=5, pady=5)
        source_combo.bind("<<ComboboxSelected>>", lambda e: self.apply_filters())

        # Graph button
        graph_btn = ttk.Button(filter_frame, text="Graph", command=self.open_graph_window)
        graph_btn.grid(row=1, column=7, padx=5, pady=5)

        # Reset Filters button
        reset_btn = ttk.Button(filter_frame, text="Reset Filters", command=self.reset_filters)
        reset_btn.grid(row=1, column=8, padx=5, pady=5)

        # Clear button
        clear_btn = ttk.Button(filter_frame, text="Clear Spots", command=self.clear_spots)
        clear_btn.grid(row=1, column=9, padx=5, pady=5)

        # Auto Band checkbox
        self.auto_band_var = tk.BooleanVar(value=True)
        auto_band_check = ttk.Checkbutton(filter_frame, text="Auto Band", variable=self.auto_band_var)
        auto_band_check.grid(row=1, column=10, padx=5, pady=5)

        # Live Map button (pinned to far right)
        live_map_btn = ttk.Button(filter_frame, text="Live Map", command=self.open_live_map)
        live_map_btn.grid(row=1, column=11, padx=5, pady=5, sticky=tk.E)

        # Table frame
        table_frame = ttk.Frame(self.window)
        table_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        # Scrollbars
        vsb = ttk.Scrollbar(table_frame, orient="vertical")
        hsb = ttk.Scrollbar(table_frame, orient="horizontal")

        # Treeview for spots
        columns = ("time", "age", "frequency", "band", "callsign", "country",
                  "distance", "bearing", "snr", "wpm", "comment")
        self.tree = ttk.Treeview(table_frame, columns=columns, show="headings",
                                yscrollcommand=vsb.set, xscrollcommand=hsb.set)

        vsb.config(command=self.tree.yview)
        hsb.config(command=self.tree.xview)

        # Column headings with sort commands
        for col in columns:
            self.tree.heading(col, text=self._get_column_title(col),
                            command=lambda c=col: self._sort_by_column(c))

        # Column widths
        self.tree.column("time", width=80)
        self.tree.column("age", width=60)
        self.tree.column("frequency", width=100)
        self.tree.column("band", width=60)
        self.tree.column("callsign", width=100)
        self.tree.column("country", width=120)
        self.tree.column("distance", width=80)
        self.tree.column("bearing", width=70)
        self.tree.column("snr", width=60)
        self.tree.column("wpm", width=60)
        self.tree.column("comment", width=200)

        # Configure tags for SNR coloring
        self.tree.tag_configure("snr_high", foreground="#28a745")  # Green
        self.tree.tag_configure("snr_good", foreground="#ffc107")  # Yellow
        self.tree.tag_configure("snr_weak", foreground="#ff8c00")  # Orange
        self.tree.tag_configure("snr_poor", foreground="#dc3545")  # Red

        # Grid layout
        self.tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        hsb.grid(row=1, column=0, sticky="ew")

        table_frame.grid_rowconfigure(0, weight=1)
        table_frame.grid_columnconfigure(0, weight=1)

        # Bind double-click event to tune to frequency
        self.tree.bind("<Double-Button-1>", self._on_row_double_click)

        # Bind single-click event to set filters
        self.tree.bind("<Button-1>", self._on_row_click)

    def _handle_spot(self, spot_data):
        """Handle incoming CW spot from WebSocket."""
        self.update_queue.put(("spot", spot_data))

    def _handle_status(self, connected):
        """Handle connection status change."""
        self.update_queue.put(("status", connected))

    def check_updates(self):
        """Check for updates from the queue and process them."""
        try:
            while True:
                msg_type, data = self.update_queue.get_nowait()

                if msg_type == "spot":
                    self._add_spot(data)
                elif msg_type == "status":
                    self._update_status(data)

        except queue.Empty:
            pass

        # Update last spot time display
        self._update_last_spot_time()

        # Schedule next check
        self.window.after(100, self.check_updates)

    def _add_spot(self, spot_data):
        """Add a spot to the display."""
        # Add to spots list
        self.spots.insert(0, spot_data)

        # Limit spots
        if len(self.spots) > self.max_spots:
            self.spots = self.spots[:self.max_spots]

        # If receiving spots, we must be connected - update status if currently disconnected
        if self.status_label.cget('text') == 'Disconnected':
            self.status_label.config(text="Connected", foreground="green")

        # Schedule batched update instead of immediate update
        # This prevents UI stalls when many spots arrive quickly
        if not self._update_pending:
            self._update_pending = True
            # Batch updates every 500ms during high activity
            self._batch_timer = self.window.after(500, self._do_batched_update)

    def _do_batched_update(self):
        """Execute batched display update."""
        self._update_pending = False
        self._batch_timer = None
        # Apply filters and update display
        self.apply_filters()

    def _update_status(self, connected):
        """Update connection status display."""
        if connected:
            self.status_label.config(text="Connected", foreground="green")
        else:
            self.status_label.config(text="Disconnected", foreground="red")

    def open_graph_window(self):
        """Open the graph window."""
        if self.graph_window is None or not self.graph_window.window.winfo_exists():
            self.graph_window = create_cw_spots_graph_window(
                self,
                on_close=self._on_graph_window_closed
            )
        else:
            # Window already exists, just raise it
            self.graph_window.window.lift()
            self.graph_window.window.focus_force()

    def _on_graph_window_closed(self):
        """Handle graph window close."""
        self.graph_window = None

    def apply_filters(self):
        """Apply filters and update the display."""
        # Get filter values
        age_str = self.age_var.get()
        self.age_filter = None if age_str == "none" else int(age_str)
        self.band_filter = self.band_var.get()

        snr_str = self.snr_var.get()
        self.snr_filter = None if snr_str == "none" else int(snr_str)

        wpm_str = self.wpm_var.get()
        self.wpm_filter = None if wpm_str == "none" else int(wpm_str)

        self.callsign_filter = self.callsign_var.get().upper()
        self.country_filter = self.country_var.get()
        self.source_filter = self.source_var.get()

        # Refresh graph window if open (it will use our filters)
        if self.graph_window and self.graph_window.window.winfo_exists():
            self.graph_window.refresh()

        # Filter spots
        filtered_spots = []
        now = datetime.utcnow()

        for spot in self.spots:
            # Age filter
            if self.age_filter is not None:
                try:
                    # Handle nanosecond precision timestamps (Windows doesn't support them)
                    timestamp_str = spot['time'].replace('Z', '+00:00')
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

                    spot_time = datetime.fromisoformat(timestamp_str)
                    # Remove timezone info to compare with naive datetime
                    spot_time = spot_time.replace(tzinfo=None)
                    age_minutes = (now - spot_time).total_seconds() / 60
                    if age_minutes > self.age_filter:
                        continue
                except Exception:
                    continue

            # Band filter
            if self.band_filter != "all" and spot.get('band') != self.band_filter:
                continue

            # SNR filter
            if self.snr_filter is not None and spot.get('snr', -999) < self.snr_filter:
                continue

            # WPM filter
            if self.wpm_filter is not None and spot.get('wpm', 0) < self.wpm_filter:
                continue

            # Callsign filter
            if self.callsign_filter:
                callsign = spot.get('dx_call', '').upper()
                country = spot.get('country', '').upper()
                if self.callsign_filter not in callsign and self.callsign_filter not in country:
                    continue

            # Country filter
            if self.country_filter != "all" and spot.get('country', '') != self.country_filter:
                continue

            # Source filter
            if self.source_filter != "All":
                comment = spot.get('comment', '')
                is_tci = comment.startswith('TCI')
                if self.source_filter == "TCI" and not is_tci:
                    continue
                elif self.source_filter == "Server" and is_tci:
                    continue

            filtered_spots.append(spot)

        # Update last spot time from filtered spots
        if filtered_spots:
            # Get the most recent spot time from filtered spots
            try:
                latest_spot = max(filtered_spots, key=lambda s: s.get('time', ''))
                # Handle nanosecond precision timestamps (Windows doesn't support them)
                timestamp_str = latest_spot['time'].replace('Z', '+00:00')
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

                self.last_spot_time = datetime.fromisoformat(timestamp_str).replace(tzinfo=None)
            except Exception:
                pass

        # Update display
        self._update_display(filtered_spots)

    def _get_column_title(self, column):
        """Get display title for column."""
        titles = {
            "time": "Time (UTC)",
            "age": "Age",
            "frequency": "Frequency",
            "band": "Band",
            "callsign": "Callsign",
            "country": "Country",
            "distance": "Distance",
            "bearing": "Bearing",
            "snr": "SNR",
            "wpm": "WPM",
            "comment": "Comment"
        }
        title = titles.get(column, column)
        # Add sort indicator
        if column == self.sort_column:
            title += " ▼" if self.sort_reverse else " ▲"
        return title

    def _sort_by_column(self, column):
        """Sort spots by the specified column."""
        # Toggle sort direction if clicking same column
        if column == self.sort_column:
            self.sort_reverse = not self.sort_reverse
        else:
            self.sort_column = column
            # Default sort direction based on column type
            self.sort_reverse = column in ["time", "snr", "wpm", "distance"]

        # Update column headings to show sort indicator
        for col in ("time", "age", "frequency", "band", "callsign", "country",
                   "distance", "bearing", "snr", "wpm", "comment"):
            self.tree.heading(col, text=self._get_column_title(col))

        # Re-apply filters (which will trigger display update with new sort)
        self.apply_filters()

    def _get_sort_key(self, spot, column):
        """Get sort key for a spot based on column."""
        if column == "time":
            return spot.get('time', '')
        elif column == "age":
            # Sort by timestamp (inverse of age)
            return spot.get('time', '')
        elif column == "frequency":
            return spot.get('frequency', 0)
        elif column == "band":
            # Sort bands numerically (160m, 80m, etc.)
            band = spot.get('band', '')
            try:
                return int(band.replace('m', ''))
            except:
                return 999
        elif column == "callsign":
            return spot.get('dx_call', '').upper()
        elif column == "country":
            return spot.get('country', '').upper()
        elif column == "distance":
            return spot.get('distance_km', 0) or 0
        elif column == "bearing":
            return spot.get('bearing_deg', 0) or 0
        elif column == "snr":
            return spot.get('snr', -999)
        elif column == "wpm":
            return spot.get('wpm', 0) or 0
        elif column == "comment":
            return spot.get('comment', '').upper()
        return ''

    def _update_display(self, spots):
        """Update the treeview with filtered spots."""
        # Clear existing items and frequency mapping
        for item in self.tree.get_children():
            if item in self.item_frequencies:
                del self.item_frequencies[item]
            self.tree.delete(item)

        # Sort spots by current sort column
        sorted_spots = sorted(spots,
                            key=lambda s: self._get_sort_key(s, self.sort_column),
                            reverse=self.sort_reverse)

        # Add filtered spots
        for spot in sorted_spots:
            self._add_spot_to_tree(spot)

        # Update count
        total = len(self.spots)
        filtered = len(spots)
        if filtered != total:
            self.count_label.config(text=f"{filtered} spots of {total} total")
        else:
            self.count_label.config(text=f"{filtered} spots")

    def _update_last_spot_time(self):
        """Update the last spot time display."""
        if self.last_spot_time is None:
            self.last_spot_label.config(text="")
            return

        try:
            now = datetime.utcnow()
            age_seconds = (now - self.last_spot_time).total_seconds()

            if age_seconds < 60:
                time_ago = f"{int(age_seconds)}s"
            elif age_seconds < 3600:
                minutes = int(age_seconds / 60)
                seconds = int(age_seconds % 60)
                time_ago = f"{minutes}m {seconds}s"
            else:
                hours = int(age_seconds / 3600)
                minutes = int((age_seconds % 3600) / 60)
                time_ago = f"{hours}h {minutes}m"

            self.last_spot_label.config(text=f"Last: {time_ago}")
        except Exception:
            self.last_spot_label.config(text="")

    def _add_spot_to_tree(self, spot):
        """Add a single spot to the treeview."""
        # Format time
        try:
            # Handle nanosecond precision timestamps (Windows doesn't support them)
            timestamp_str = spot['time'].replace('Z', '+00:00')
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

            spot_time = datetime.fromisoformat(timestamp_str)
            # Convert to UTC and remove timezone info for consistent formatting on Windows
            spot_time_utc = spot_time.replace(tzinfo=None)
            time_str = spot_time_utc.strftime("%H:%M:%S")

            # Calculate age
            now = datetime.utcnow()
            # Remove timezone info to compare with naive datetime
            spot_time_naive = spot_time.replace(tzinfo=None)
            age_seconds = (now - spot_time_naive).total_seconds()
            if age_seconds < 60:
                age_str = f"{int(age_seconds)}s"
            elif age_seconds < 3600:
                age_str = f"{int(age_seconds/60)}m"
            else:
                age_str = f"{int(age_seconds/3600)}h"
        except:
            time_str = spot.get('time', '')
            age_str = ""

        # Format frequency
        freq_hz = spot.get('frequency', 0)
        freq_str = f"{freq_hz/1000000:.5f} MHz"

        # Format distance
        distance_km = spot.get('distance_km')
        distance_str = f"{int(distance_km)} km" if distance_km is not None else ""

        # Format bearing
        bearing_deg = spot.get('bearing_deg')
        bearing_str = f"{int(bearing_deg)}°" if bearing_deg is not None else ""

        # Format SNR
        snr = spot.get('snr', 0)
        snr_str = f"+{snr}" if snr >= 0 else str(snr)

        # Determine SNR tag (matching graph color scheme)
        if snr > 26:
            snr_tag = "snr_high"  # Green - excellent
        elif snr >= 13:
            snr_tag = "snr_good"  # Yellow - good
        elif snr >= 6:
            snr_tag = "snr_weak"  # Orange - fair
        else:
            snr_tag = "snr_poor"  # Red - weak (0-5)

        values = (
            time_str,
            age_str,
            freq_str,
            spot.get('band', ''),
            spot.get('dx_call', ''),
            spot.get('country', ''),
            distance_str,
            bearing_str,
            snr_str,
            spot.get('wpm', ''),
            spot.get('comment', '')
        )

        # Store frequency in item for retrieval on double-click
        item_id = self.tree.insert("", "end", values=values, tags=(snr_tag,))
        # Store the actual frequency value in our dictionary
        self.item_frequencies[item_id] = freq_hz

    def reset_filters(self):
        """Reset all filters to their default values."""
        self.age_var.set("10")
        self.band_var.set("all")
        self.snr_var.set("none")
        self.wpm_var.set("none")
        self.callsign_var.set("")
        self.country_var.set("all")
        self.source_var.set("All")
        self.apply_filters()

    def clear_spots(self):
        """Clear all spots."""
        self.spots = []
        self.apply_filters()

    def _on_closing(self):
        """Handle window close event."""
        # Cancel any pending batch update
        if self._batch_timer is not None:
            self.window.after_cancel(self._batch_timer)
            self._batch_timer = None

        # Close graph window if open
        if self.graph_window and self.graph_window.window.winfo_exists():
            self.graph_window.window.destroy()
            self.graph_window = None

        # Remove callbacks
        self.websocket_manager.remove_cw_spot_callback(self._handle_spot)
        self.websocket_manager.remove_status_callback(self._handle_status)

        # Call close callback if provided
        if self.on_close_callback:
            self.on_close_callback()

        # Destroy window
        self.window.destroy()

    def _on_row_double_click(self, event):
        """Handle double-click on a row to tune to that frequency."""
        # Get the clicked item
        item = self.tree.identify_row(event.y)
        if not item:
            return

        # Get the frequency from our dictionary
        try:
            freq_hz = self.item_frequencies.get(item)
            if freq_hz is None:
                print("No frequency data for this item")
                return

            # If we have a radio GUI reference, check if mode is IQ
            if self.radio_gui:
                # Check if current mode is IQ - if so, don't allow tuning
                current_mode = self.radio_gui.mode_var.get().upper()
                if current_mode.startswith('IQ'):
                    print(f"Cannot tune from CW spots in IQ mode ({current_mode})")
                    return

            # Determine mode based on frequency (CWU >= 10 MHz, CWL < 10 MHz)
            if freq_hz < 10000000:
                mode = 'CWL'
            else:
                mode = 'CWU'

            # If we have a radio GUI reference, tune to the frequency
            if self.radio_gui:
                # Set frequency display
                self.radio_gui.set_frequency_hz(freq_hz)

                # Set mode if not locked
                if not self.radio_gui.mode_lock_var.get():
                    self.radio_gui.mode_var.set(mode)
                    self.radio_gui.on_mode_changed()

                # Apply changes if connected
                if self.radio_gui.connected:
                    self.radio_gui.apply_frequency()

                print(f"Tuned to {freq_hz/1e6:.6f} MHz ({mode})")
            else:
                print(f"No radio GUI reference - would tune to {freq_hz/1e6:.6f} MHz ({mode})")

        except (ValueError, KeyError) as e:
            print(f"Error tuning to frequency: {e}")

    def _on_row_click(self, event):
        """Handle single-click on a row to set filters based on column."""
        # Identify which column was clicked
        column = self.tree.identify_column(event.x)
        item = self.tree.identify_row(event.y)

        if not item:
            return

        # Get column index (format is '#N' where N is 1-based)
        try:
            col_index = int(column.replace('#', '')) - 1
        except (ValueError, AttributeError):
            return

        # Get column names
        columns = ("time", "age", "frequency", "band", "callsign", "country",
                   "distance", "bearing", "snr", "wpm", "comment")

        if col_index < 0 or col_index >= len(columns):
            return

        col_name = columns[col_index]

        # Get the value from the clicked cell
        values = self.tree.item(item, 'values')
        if col_index >= len(values):
            return

        clicked_value = values[col_index]

        # Set filter based on column
        if col_name == "band" and clicked_value:
            # Extract band value (e.g., "40m" from the cell)
            self.band_var.set(clicked_value)
            self.apply_filters()
        elif col_name == "country" and clicked_value:
            # Set country filter
            self.country_var.set(clicked_value)
            self.apply_filters()

    def open_live_map(self):
        """Open the CW Skimmer live map in the default browser."""
        import webbrowser
        
        # Get public_url from radio_gui if available
        if self.radio_gui and hasattr(self.radio_gui, 'client') and self.radio_gui.client:
            if hasattr(self.radio_gui.client, 'server_description'):
                desc = self.radio_gui.client.server_description
                public_url = desc.get('receiver', {}).get('public_url', '')
                
                if public_url and public_url != 'https://example.com':
                    # Build the map URL
                    map_url = f"{public_url}/cwskimmer_map.html"
                    try:
                        webbrowser.open(map_url)
                        print(f"Opened CW Skimmer map: {map_url}")
                    except Exception as e:
                        print(f"Failed to open map: {e}")
                    return
        
        # Fallback: show error message
        from tkinter import messagebox
        messagebox.showinfo("Map Not Available", "Public URL not available for this receiver")


def create_cw_spots_window(websocket_manager, on_close=None, radio_gui=None, countries=None):
    """
    Create and return a CW spots display window.

    Args:
        websocket_manager: Shared DXClusterWebSocket instance
        on_close: Optional callback when window is closed
        radio_gui: Optional reference to RadioGUI for frequency tuning
        countries: Optional list of countries from /api/cty/countries

    Returns:
        CWSpotsDisplay instance
    """
    return CWSpotsDisplay(websocket_manager, on_close, radio_gui, countries)