#!/usr/bin/env python3
"""
Digital Spots Display Window for ka9q_ubersdr Python Client
Shows real-time FT8, FT4, and WSPR spots from the multi-decoder via DX cluster WebSocket
"""

import tkinter as tk
from tkinter import ttk
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Callable
import queue


class DigitalSpotsDisplay:
    """Display window for digital mode spots (FT8, FT4, WSPR)."""
    
    def __init__(self, websocket_manager, on_close: Optional[Callable] = None, countries: Optional[List[Dict]] = None, radio_gui=None):
        """
        Initialize the digital spots display.
        
        Args:
            websocket_manager: Shared DXClusterWebSocket instance
            on_close: Optional callback when window is closed
            countries: Optional list of countries from /api/cty/countries
            radio_gui: Optional reference to RadioGUI for accessing server info
        """
        self.websocket_manager = websocket_manager
        self.on_close_callback = on_close
        self.countries = countries or []
        self.radio_gui = radio_gui
        
        # Create window
        self.window = tk.Toplevel()
        self.window.title("Digital Spots")
        self.window.geometry("1400x700")
        
        # Data storage
        self.spots: List[Dict] = []
        self.max_spots = 5000
        self.filtered_spots: List[Dict] = []
        
        # Update queue for thread-safe GUI updates
        self.update_queue = queue.Queue()
        
        self.running = True
        
        # Filter state
        self.mode_filter = tk.StringVar(value="all")
        self.age_filter = tk.IntVar(value=10)  # minutes
        self.band_filter = tk.StringVar(value="all")
        self.snr_filter = tk.StringVar(value="none")
        self.callsign_filter = tk.StringVar(value="")
        self.country_filter = tk.StringVar(value="all")
        self.auto_band = True  # Auto-update band filter when frequency changes
        
        # Sorting state
        self.sort_column = "time"
        self.sort_reverse = True  # Most recent first by default
        
        # Create UI
        self.create_widgets()
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.on_closing)

        # Start update checker and age updater AFTER window is fully initialized
        # Use after() to ensure the window event loop is running
        self.window.after(100, self.check_updates)
        self.window.after(1000, self.update_ages)

        # Register callbacks with shared WebSocket manager AFTER starting update checker
        # This ensures the initial status notification is properly queued and processed
        self.websocket_manager.on_digital_spot(self._handle_spot)
        self.websocket_manager.on_status(self._handle_status)
    
    def _handle_spot(self, spot_data: Dict):
        """Handle incoming digital spot from WebSocket."""
        self.update_queue.put(('spot', spot_data))
    
    def _handle_status(self, connected: bool):
        """Handle connection status change."""
        self.update_queue.put(('status', connected))
    
    def create_widgets(self):
        """Create all GUI widgets."""
        # Main container
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        
        # Header with status
        header_frame = ttk.Frame(main_frame)
        header_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        ttk.Label(header_frame, text="Digital Spots", 
                 font=('TkDefaultFont', 12, 'bold')).pack(side=tk.LEFT)
        
        self.status_label = ttk.Label(header_frame, text="Disconnected", 
                                     foreground='red')
        self.status_label.pack(side=tk.LEFT, padx=(10, 0))
        
        self.count_label = ttk.Label(header_frame, text="0 spots")
        self.count_label.pack(side=tk.RIGHT)
        
        self.last_update_label = ttk.Label(header_frame, text="")
        self.last_update_label.pack(side=tk.RIGHT, padx=(0, 20))
        
        # Filter controls
        filter_frame = ttk.LabelFrame(main_frame, text="Filters", padding="5")
        filter_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        
        # Mode filter
        ttk.Label(filter_frame, text="Mode:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        mode_combo = ttk.Combobox(filter_frame, textvariable=self.mode_filter,
                                 values=["all", "FT8", "FT4", "WSPR"],
                                 state='readonly', width=10)
        mode_combo.grid(row=0, column=1, sticky=tk.W, padx=(0, 15))
        mode_combo.bind('<<ComboboxSelected>>', lambda e: self.apply_filters())
        
        # Age filter
        ttk.Label(filter_frame, text="Age:").grid(row=0, column=2, sticky=tk.W, padx=(0, 5))
        age_combo = ttk.Combobox(filter_frame, textvariable=self.age_filter,
                                values=[5, 10, 15, 30, 60],
                                state='readonly', width=8)
        age_combo.grid(row=0, column=3, sticky=tk.W, padx=(0, 5))
        age_combo.bind('<<ComboboxSelected>>', lambda e: self.apply_filters())
        ttk.Label(filter_frame, text="min").grid(row=0, column=4, sticky=tk.W, padx=(0, 15))
        
        # Band filter
        ttk.Label(filter_frame, text="Band:").grid(row=0, column=5, sticky=tk.W, padx=(0, 5))
        band_combo = ttk.Combobox(filter_frame, textvariable=self.band_filter,
                                 values=["all", "160m", "80m", "60m", "40m", "30m", 
                                        "20m", "17m", "15m", "12m", "10m"],
                                 state='readonly', width=8)
        band_combo.grid(row=0, column=6, sticky=tk.W, padx=(0, 15))
        band_combo.bind('<<ComboboxSelected>>', lambda e: self.apply_filters())
        
        # SNR filter
        ttk.Label(filter_frame, text="Min SNR:").grid(row=0, column=7, sticky=tk.W, padx=(0, 5))
        snr_combo = ttk.Combobox(filter_frame, textvariable=self.snr_filter,
                                values=["none", "20", "15", "10", "5", "0", "-5", "-10", "-15", "-20"],
                                state='readonly', width=8)
        snr_combo.grid(row=0, column=8, sticky=tk.W, padx=(0, 15))
        snr_combo.bind('<<ComboboxSelected>>', lambda e: self.apply_filters())
        
        # Callsign filter
        ttk.Label(filter_frame, text="Callsign:").grid(row=0, column=9, sticky=tk.W, padx=(0, 5))
        callsign_entry = ttk.Entry(filter_frame, textvariable=self.callsign_filter, width=12)
        callsign_entry.grid(row=0, column=10, sticky=tk.W, padx=(0, 15))
        callsign_entry.bind('<KeyRelease>', lambda e: self.window.after(300, self.apply_filters))
        
        # Country filter
        ttk.Label(filter_frame, text="Country:").grid(row=0, column=11, sticky=tk.W, padx=(0, 5))
        country_values = ["all"] + [c['name'] for c in self.countries]
        country_combo = ttk.Combobox(filter_frame, textvariable=self.country_filter,
                                    values=country_values,
                                    state='readonly', width=15)
        country_combo.grid(row=0, column=12, sticky=tk.W, padx=(0, 15))
        country_combo.bind('<<ComboboxSelected>>', lambda e: self.apply_filters())

        # Reset Filters button
        ttk.Button(filter_frame, text="Reset Filters",
                  command=self.reset_filters).grid(row=0, column=13, sticky=tk.W, padx=(0, 5))

        # Clear button
        ttk.Button(filter_frame, text="Clear All",
                  command=self.clear_spots).grid(row=0, column=14, sticky=tk.W)

        # Auto Band checkbox
        self.auto_band_var = tk.BooleanVar(value=True)
        auto_band_check = ttk.Checkbutton(filter_frame, text="Auto Band", variable=self.auto_band_var)
        auto_band_check.grid(row=0, column=15, sticky=tk.W, padx=(5, 0))

        # Live Map button (pinned to far right)
        live_map_btn = ttk.Button(filter_frame, text="Live Map", command=self.open_live_map)
        live_map_btn.grid(row=0, column=16, sticky=tk.E, padx=(5, 0))
        
        # Spots table with scrollbar
        table_frame = ttk.Frame(main_frame)
        table_frame.grid(row=2, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # Create Treeview for spots
        columns = ('time', 'age', 'mode', 'freq', 'band', 'callsign', 
                  'country', 'grid', 'distance', 'bearing', 'snr', 'message')
        self.tree = ttk.Treeview(table_frame, columns=columns, show='headings', height=25)
        
        # Define column headings with sort commands
        for col in columns:
            self.tree.heading(col, text=self._get_column_title(col),
                            command=lambda c=col: self._sort_by_column(c))
        
        # Define column widths
        self.tree.column('time', width=80)
        self.tree.column('age', width=60)
        self.tree.column('mode', width=60)
        self.tree.column('freq', width=90)
        self.tree.column('band', width=60)
        self.tree.column('callsign', width=100)
        self.tree.column('country', width=120)
        self.tree.column('grid', width=70)
        self.tree.column('distance', width=80)
        self.tree.column('bearing', width=70)
        self.tree.column('snr', width=60)
        self.tree.column('message', width=200)
        
        # Add scrollbars
        vsb = ttk.Scrollbar(table_frame, orient="vertical", command=self.tree.yview)
        hsb = ttk.Scrollbar(table_frame, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)
        
        # Grid layout
        self.tree.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        vsb.grid(row=0, column=1, sticky=(tk.N, tk.S))
        hsb.grid(row=1, column=0, sticky=(tk.W, tk.E))
        
        table_frame.columnconfigure(0, weight=1)
        table_frame.rowconfigure(0, weight=1)

        # Bind single-click event to set filters
        self.tree.bind("<Button-1>", self._on_row_click)
        
        # Configure main frame weights
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(2, weight=1)
    
    def add_spot(self, spot: Dict):
        """Add a new spot to the list."""
        self.spots.insert(0, spot)  # Add to beginning

        # Limit stored spots
        if len(self.spots) > self.max_spots:
            self.spots = self.spots[:self.max_spots]

        # Update last update time
        self.last_update_label.config(text=f"Last: {datetime.now().strftime('%H:%M:%S')}")

        # If receiving spots, we must be connected - update status if currently disconnected
        if self.status_label.cget('text') == 'Disconnected':
            self.status_label.config(text="Connected", foreground='green')

        # Apply filters and update display
        self.apply_filters()
    
    def apply_filters(self):
        """Apply current filters to spots list."""
        now = datetime.utcnow()
        max_age = timedelta(minutes=self.age_filter.get())
        mode = self.mode_filter.get()
        band = self.band_filter.get()
        snr_str = self.snr_filter.get()
        min_snr = None if snr_str == "none" else int(snr_str)
        callsign = self.callsign_filter.get().upper()
        country = self.country_filter.get()
        
        self.filtered_spots = []
        
        for spot in self.spots:
            # Age filter
            try:
                spot_time = datetime.fromisoformat(spot['timestamp'].replace('Z', '+00:00'))
                if (now - spot_time.replace(tzinfo=None)) > max_age:
                    continue
            except (KeyError, ValueError):
                continue
            
            # Mode filter
            if mode != "all" and spot.get('mode') != mode:
                continue
            
            # Band filter
            if band != "all" and spot.get('band') != band:
                continue
            
            # SNR filter
            if min_snr is not None and spot.get('snr', -999) < min_snr:
                continue
            
            # Callsign filter
            if callsign:
                spot_callsign = spot.get('callsign', '').upper()
                spot_grid = spot.get('locator', '').upper()
                spot_msg = spot.get('message', '').upper()
                if callsign not in spot_callsign and callsign not in spot_grid and callsign not in spot_msg:
                    continue
            
            # Country filter
            if country != "all" and spot.get('country', '') != country:
                continue
            
            self.filtered_spots.append(spot)
        
        # Update display
        self.update_display()
    
    def _get_column_title(self, column):
        """Get display title for column."""
        titles = {
            "time": "Time (UTC)",
            "age": "Age",
            "mode": "Mode",
            "freq": "Freq (MHz)",
            "band": "Band",
            "callsign": "Callsign",
            "country": "Country",
            "grid": "Grid",
            "distance": "Distance",
            "bearing": "Bearing",
            "snr": "SNR",
            "message": "Message"
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
            self.sort_reverse = column in ["time", "snr", "distance"]
        
        # Update column headings to show sort indicator
        for col in ('time', 'age', 'mode', 'freq', 'band', 'callsign',
                   'country', 'grid', 'distance', 'bearing', 'snr', 'message'):
            self.tree.heading(col, text=self._get_column_title(col))
        
        # Re-apply filters (which will trigger display update with new sort)
        self.apply_filters()
    
    def _get_sort_key(self, spot, column):
        """Get sort key for a spot based on column."""
        if column == "time":
            return spot.get('timestamp', '')
        elif column == "age":
            # Sort by timestamp (inverse of age)
            return spot.get('timestamp', '')
        elif column == "mode":
            return spot.get('mode', '').upper()
        elif column == "freq":
            return spot.get('frequency', 0)
        elif column == "band":
            # Sort bands numerically (160m, 80m, etc.)
            band = spot.get('band', '')
            try:
                return int(band.replace('m', ''))
            except:
                return 999
        elif column == "callsign":
            return spot.get('callsign', '').upper()
        elif column == "country":
            return spot.get('country', '').upper()
        elif column == "grid":
            return spot.get('locator', '').upper()
        elif column == "distance":
            return spot.get('distance_km', 0) or 0
        elif column == "bearing":
            return spot.get('bearing_deg', 0) or 0
        elif column == "snr":
            return spot.get('snr', -999)
        elif column == "message":
            return spot.get('message', '').upper()
        return ''
    
    def update_display(self):
        """Update the spots table display."""
        # Clear existing items
        for item in self.tree.get_children():
            self.tree.delete(item)
        
        # Sort filtered spots by current sort column
        sorted_spots = sorted(self.filtered_spots[:500],
                            key=lambda s: self._get_sort_key(s, self.sort_column),
                            reverse=self.sort_reverse)
        
        # Add sorted spots
        for spot in sorted_spots:
            # Format time
            try:
                spot_time = datetime.fromisoformat(spot['timestamp'].replace('Z', '+00:00'))
                time_str = spot_time.strftime('%H:%M:%S')
            except (KeyError, ValueError):
                time_str = ""
            
            # Calculate age
            try:
                spot_time = datetime.fromisoformat(spot['timestamp'].replace('Z', '+00:00'))
                age = datetime.utcnow() - spot_time.replace(tzinfo=None)
                if age.seconds < 60:
                    age_str = f"{age.seconds}s"
                elif age.seconds < 3600:
                    age_str = f"{age.seconds // 60}m{age.seconds % 60}s"
                else:
                    age_str = f"{age.seconds // 3600}h{(age.seconds % 3600) // 60}m"
            except (KeyError, ValueError):
                age_str = ""
            
            # Format frequency
            freq_mhz = spot.get('frequency', 0) / 1e6
            
            # Format SNR
            snr = spot.get('snr', 0)
            snr_str = f"+{snr}" if snr >= 0 else str(snr)
            
            # Format distance
            distance = spot.get('distance_km')
            dist_str = f"{int(distance)} km" if distance else ""
            
            # Format bearing
            bearing = spot.get('bearing_deg')
            bearing_str = f"{int(bearing)}°" if bearing is not None else ""
            
            values = (
                time_str,
                age_str,
                spot.get('mode', ''),
                f"{freq_mhz:.5f}",
                spot.get('band', ''),
                spot.get('callsign', ''),
                spot.get('country', ''),
                spot.get('locator', ''),
                dist_str,
                bearing_str,
                snr_str,
                spot.get('message', '')
            )
            
            # Add color tags based on SNR
            tags = []
            if snr >= 10:
                tags.append('high_snr')
            elif snr >= 0:
                tags.append('good_snr')
            elif snr >= -10:
                tags.append('low_snr')
            else:
                tags.append('very_low_snr')
            
            self.tree.insert('', 'end', values=values, tags=tags)
        
        # Configure tag colors
        self.tree.tag_configure('high_snr', foreground='#28a745')  # Green
        self.tree.tag_configure('good_snr', foreground='#007bff')  # Blue
        self.tree.tag_configure('low_snr', foreground='#ffc107')   # Yellow
        self.tree.tag_configure('very_low_snr', foreground='#dc3545')  # Red
        
        # Update count
        total = len(self.spots)
        filtered = len(self.filtered_spots)
        if filtered != total:
            self.count_label.config(text=f"{filtered} spots of {total} total")
        else:
            self.count_label.config(text=f"{filtered} spots")
    
    def update_ages(self):
        """Update age column periodically without full table rebuild."""
        if self.running:
            # Update ages in-place without rebuilding the entire table
            now = datetime.utcnow()
            for item in self.tree.get_children():
                values = list(self.tree.item(item, 'values'))
                if len(values) >= 2:
                    # Get timestamp from the first column (time)
                    time_str = values[0]
                    try:
                        # Parse time and calculate new age
                        # Reconstruct full timestamp from time string (assumes today's date)
                        spot_time = datetime.strptime(time_str, '%H:%M:%S')
                        # Use current date with parsed time
                        spot_time = now.replace(hour=spot_time.hour, minute=spot_time.minute, second=spot_time.second)

                        # Handle day rollover (if spot time is in future, it was yesterday)
                        if spot_time > now:
                            spot_time = spot_time - timedelta(days=1)

                        age = now - spot_time
                        if age.seconds < 60:
                            age_str = f"{age.seconds}s"
                        elif age.seconds < 3600:
                            age_str = f"{age.seconds // 60}m{age.seconds % 60}s"
                        else:
                            age_str = f"{age.seconds // 3600}h{(age.seconds % 3600) // 60}m"

                        # Update only the age column (index 1)
                        values[1] = age_str
                        self.tree.item(item, values=values)
                    except (ValueError, AttributeError):
                        pass

            # Schedule next update in 1 second
            self.window.after(1000, self.update_ages)
    
    def reset_filters(self):
        """Reset all filters to their default values."""
        self.mode_filter.set("all")
        self.age_filter.set(10)
        self.band_filter.set("all")
        self.snr_filter.set("none")
        self.callsign_filter.set("")
        self.country_filter.set("all")
        self.apply_filters()

    def clear_spots(self):
        """Clear all spots."""
        self.spots = []
        self.filtered_spots = []
        self.update_display()
    
    def check_updates(self):
        """Check for updates from WebSocket thread."""
        try:
            while True:
                msg_type, data = self.update_queue.get_nowait()

                if msg_type == 'status':
                    # data is boolean connected status
                    if data:
                        self.status_label.config(text="Connected", foreground='green')
                    else:
                        self.status_label.config(text="Disconnected", foreground='red')
                elif msg_type == 'spot':
                    self.add_spot(data)

        except queue.Empty:
            pass

        # Schedule next check
        if self.running:
            self.window.after(100, self.check_updates)
    
    def on_closing(self):
        """Handle window close."""
        self.running = False
        
        # Remove callbacks from shared WebSocket manager
        self.websocket_manager.remove_digital_spot_callback(self._handle_spot)
        self.websocket_manager.remove_status_callback(self._handle_status)
        
        # Call close callback if provided
        if self.on_close_callback:
            self.on_close_callback()
        
        self.window.destroy()

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
        columns = ('time', 'age', 'mode', 'freq', 'band', 'callsign',
                   'country', 'grid', 'distance', 'bearing', 'snr', 'message')

        if col_index < 0 or col_index >= len(columns):
            return

        col_name = columns[col_index]

        # Get the value from the clicked cell
        values = self.tree.item(item, 'values')
        if col_index >= len(values):
            return

        clicked_value = values[col_index]

        # Set filter based on column
        if col_name == "mode" and clicked_value:
            # Set mode filter (e.g., "FT8", "FT4", "WSPR")
            self.mode_filter.set(clicked_value)
            self.apply_filters()
        elif col_name == "band" and clicked_value:
            # Extract band value (e.g., "40m" from the cell)
            self.band_filter.set(clicked_value)
            self.apply_filters()
        elif col_name == "country" and clicked_value:
            # Set country filter
            self.country_filter.set(clicked_value)
            self.apply_filters()

    def open_live_map(self):
        """Open the Digital Spots live map in the default browser."""
        import webbrowser
        
        # Get public_url from radio_gui if available
        if self.radio_gui and hasattr(self.radio_gui, 'client') and self.radio_gui.client:
            if hasattr(self.radio_gui.client, 'server_description'):
                desc = self.radio_gui.client.server_description
                public_url = desc.get('receiver', {}).get('public_url', '')
                
                if public_url and public_url != 'https://example.com':
                    # Build the map URL
                    map_url = f"{public_url}/digitalspots_map.html"
                    try:
                        webbrowser.open(map_url)
                        print(f"Opened Digital Spots map: {map_url}")
                    except Exception as e:
                        print(f"Failed to open map: {e}")
                    return
        
        # Fallback: show error message
        from tkinter import messagebox
        messagebox.showinfo("Map Not Available", "Public URL not available for this receiver")


def create_digital_spots_window(websocket_manager, on_close=None, countries=None, radio_gui=None):
    """Create and return a digital spots display window.
    
    Args:
        websocket_manager: Shared DXClusterWebSocket instance
        on_close: Optional callback when window is closed
        countries: Optional list of countries from /api/cty/countries
        
        radio_gui: Optional reference to RadioGUI for accessing server info
        
    Returns:
        DigitalSpotsDisplay instance
    """
    return DigitalSpotsDisplay(websocket_manager, on_close, countries, radio_gui)