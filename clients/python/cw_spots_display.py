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

        # Graph window reference
        self.graph_window = None

        # Dictionary to map tree item IDs to frequency values
        self.item_frequencies = {}
        
        # Queue for thread-safe updates
        self.update_queue = queue.Queue()
        
        # Filters
        self.age_filter = 10  # minutes
        self.band_filter = "all"
        self.snr_filter = None
        self.wpm_filter = None
        self.callsign_filter = ""
        self.country_filter = "all"
        
        # Sorting state
        self.sort_column = "time"
        self.sort_reverse = True  # Most recent first by default
        
        # Create window
        self.window = tk.Toplevel()
        self.window.title("CW Spots")
        self.window.geometry("1200x600")
        
        # Setup UI
        self._setup_ui()
        
        # Register callbacks
        self.websocket_manager.on_cw_spot(self._handle_spot)
        self.websocket_manager.on_status(self._handle_status)
        
        # Start update checking
        self.window.after(100, self.check_updates)
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self._on_closing)
        
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
        
        # Graph button
        graph_btn = ttk.Button(filter_frame, text="Graph", command=self.open_graph_window)
        graph_btn.grid(row=1, column=6, padx=5, pady=5)

        # Clear button
        clear_btn = ttk.Button(filter_frame, text="Clear Spots", command=self.clear_spots)
        clear_btn.grid(row=1, column=7, padx=5, pady=5)
        
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
        
        # Schedule next check
        self.window.after(100, self.check_updates)
        
    def _add_spot(self, spot_data):
        """Add a spot to the display."""
        # Add to spots list
        self.spots.insert(0, spot_data)
        
        # Limit spots
        if len(self.spots) > self.max_spots:
            self.spots = self.spots[:self.max_spots]
        
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
                    spot_time = datetime.fromisoformat(spot['time'].replace('Z', '+00:00'))
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
            
            filtered_spots.append(spot)
        
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
            
    def _add_spot_to_tree(self, spot):
        """Add a single spot to the treeview."""
        # Format time
        try:
            spot_time = datetime.fromisoformat(spot['time'].replace('Z', '+00:00'))
            time_str = spot_time.strftime("%H:%M:%S")
            
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
        
    def clear_spots(self):
        """Clear all spots."""
        self.spots = []
        self.apply_filters()
        
    def _on_closing(self):
        """Handle window close event."""
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