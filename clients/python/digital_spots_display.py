#!/usr/bin/env python3
"""
Digital Spots Display Window for ka9q_ubersdr Python Client
Shows real-time FT8, FT4, and WSPR spots from the multi-decoder via DX cluster WebSocket
"""

import tkinter as tk
from tkinter import ttk
import asyncio
import websockets
import json
import threading
from datetime import datetime, timedelta
from typing import Optional, List, Dict
import queue


class DigitalSpotsDisplay:
    """Display window for digital mode spots (FT8, FT4, WSPR)."""
    
    def __init__(self, parent_window: tk.Toplevel):
        self.window = parent_window
        self.window.title("Digital Spots - ka9q_ubersdr")
        self.window.geometry("1400x700")
        
        # Data storage
        self.spots: List[Dict] = []
        self.max_spots = 5000
        self.filtered_spots: List[Dict] = []
        
        # WebSocket connection
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.ws_thread: Optional[threading.Thread] = None
        self.event_loop: Optional[asyncio.AbstractEventLoop] = None
        self.running = False
        self.connected = False
        
        # Update queue for thread-safe GUI updates
        self.update_queue = queue.Queue()
        
        # Filter state
        self.mode_filter = tk.StringVar(value="all")
        self.age_filter = tk.IntVar(value=10)  # minutes
        self.band_filter = tk.StringVar(value="all")
        self.snr_filter = tk.StringVar(value="none")
        self.callsign_filter = tk.StringVar(value="")
        
        # Create UI
        self.create_widgets()
        
        # Start update checker
        self.check_updates()
        
        # Start age update timer
        self.update_ages()
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.on_closing)
    
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
        
        # Clear button
        ttk.Button(filter_frame, text="Clear All", 
                  command=self.clear_spots).grid(row=0, column=11, sticky=tk.W)
        
        # Spots table with scrollbar
        table_frame = ttk.Frame(main_frame)
        table_frame.grid(row=2, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # Create Treeview for spots
        columns = ('time', 'age', 'mode', 'freq', 'band', 'callsign', 
                  'country', 'grid', 'distance', 'bearing', 'snr', 'message')
        self.tree = ttk.Treeview(table_frame, columns=columns, show='headings', height=25)
        
        # Define column headings
        self.tree.heading('time', text='Time (UTC)')
        self.tree.heading('age', text='Age')
        self.tree.heading('mode', text='Mode')
        self.tree.heading('freq', text='Freq (MHz)')
        self.tree.heading('band', text='Band')
        self.tree.heading('callsign', text='Callsign')
        self.tree.heading('country', text='Country')
        self.tree.heading('grid', text='Grid')
        self.tree.heading('distance', text='Distance')
        self.tree.heading('bearing', text='Bearing')
        self.tree.heading('snr', text='SNR')
        self.tree.heading('message', text='Message')
        
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
        
        # Configure main frame weights
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(2, weight=1)
    
    def connect(self, server: str, user_session_id: str, use_tls: bool = False):
        """Connect to DX cluster WebSocket for digital spots.
        
        Args:
            server: Server address (host:port or full URL)
            user_session_id: User session ID for authentication
            use_tls: Whether to use TLS/SSL
        """
        if self.running:
            return
        
        self.running = True
        
        # Parse server URL
        if '://' in server:
            # Full URL provided - convert to WebSocket URL
            ws_url = server.replace('http://', 'ws://').replace('https://', 'wss://')
            # Remove any existing path and add /ws/dxcluster
            if '/' in ws_url.split('://', 1)[1]:
                # Has a path, replace it
                base = ws_url.split('/', 3)[:3]  # protocol://host:port
                ws_url = '/'.join(base) + '/ws/dxcluster'
            else:
                # No path, add it
                ws_url = f"{ws_url}/ws/dxcluster"
        else:
            # Host:port format
            protocol = 'wss' if use_tls else 'ws'
            ws_url = f"{protocol}://{server}/ws/dxcluster"
        
        # Add user_session_id query parameter (required by server)
        ws_url = f"{ws_url}?user_session_id={user_session_id}"
        
        print(f"Digital Spots: Connecting to {ws_url}")
        
        # Start WebSocket thread
        self.ws_thread = threading.Thread(target=self.run_websocket, args=(ws_url,), daemon=True)
        self.ws_thread.start()
    
    def run_websocket(self, url: str):
        """Run WebSocket connection in separate thread."""
        self.event_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.event_loop)
        
        try:
            self.event_loop.run_until_complete(self.websocket_handler(url))
        except Exception as e:
            self.update_queue.put(('error', f"WebSocket error: {e}"))
        finally:
            self.event_loop.close()
    
    async def websocket_handler(self, url: str):
        """Handle WebSocket connection and messages."""
        try:
            print(f"Digital Spots: Attempting WebSocket connection to {url}")
            async with websockets.connect(url) as websocket:
                self.ws = websocket
                print("Digital Spots: WebSocket connected successfully")
                self.update_queue.put(('connected', None))
                
                # Receive messages (no subscription needed - DX cluster auto-sends)
                while self.running:
                    try:
                        message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                        data = json.loads(message)
                        
                        print(f"Digital Spots: Received message type: {data.get('type')}")
                        
                        # Handle digital spot messages
                        if data.get('type') == 'digital_spot':
                            self.update_queue.put(('spot', data.get('data', data)))
                    
                    except asyncio.TimeoutError:
                        continue
                    except websockets.exceptions.ConnectionClosed:
                        print("Digital Spots: WebSocket connection closed")
                        break
        
        except Exception as e:
            print(f"Digital Spots: WebSocket error: {e}")
            import traceback
            traceback.print_exc()
            self.update_queue.put(('error', f"Connection failed: {e}"))
        finally:
            self.update_queue.put(('disconnected', None))
    
    def add_spot(self, spot: Dict):
        """Add a new spot to the list."""
        self.spots.insert(0, spot)  # Add to beginning
        
        # Limit stored spots
        if len(self.spots) > self.max_spots:
            self.spots = self.spots[:self.max_spots]
        
        # Update last update time
        self.last_update_label.config(text=f"Last: {datetime.now().strftime('%H:%M:%S')}")
        
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
            
            self.filtered_spots.append(spot)
        
        # Update display
        self.update_display()
    
    def update_display(self):
        """Update the spots table display."""
        # Clear existing items
        for item in self.tree.get_children():
            self.tree.delete(item)
        
        # Add filtered spots (limit to 500 for performance)
        for spot in self.filtered_spots[:500]:
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
        """Update age column periodically."""
        if self.running:
            # Re-apply filters to update ages
            self.update_display()
            # Schedule next update in 1 second
            self.window.after(1000, self.update_ages)
    
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
                
                if msg_type == 'connected':
                    self.connected = True
                    self.status_label.config(text="Connected", foreground='green')
                elif msg_type == 'disconnected':
                    self.connected = False
                    self.status_label.config(text="Disconnected", foreground='red')
                elif msg_type == 'spot':
                    # Data might be wrapped in 'data' key or be the spot itself
                    spot_data = data.get('data', data) if isinstance(data, dict) else data
                    self.add_spot(spot_data)
                elif msg_type == 'error':
                    self.status_label.config(text=f"Error: {data}", foreground='red')
        
        except queue.Empty:
            pass
        
        # Schedule next check
        if self.running:
            self.window.after(100, self.check_updates)
    
    def disconnect(self):
        """Disconnect from WebSocket."""
        self.running = False
        if self.ws and self.event_loop:
            try:
                asyncio.run_coroutine_threadsafe(self.ws.close(), self.event_loop)
            except Exception:
                pass
    
    def on_closing(self):
        """Handle window close."""
        self.disconnect()
        self.window.destroy()


def create_digital_spots_window(parent_gui) -> tuple:
    """Create and return a digital spots display window.
    
    Args:
        parent_gui: The RadioGUI instance
        
    Returns:
        Tuple of (window, display) objects
    """
    window = tk.Toplevel(parent_gui.root)
    display = DigitalSpotsDisplay(window)
    
    # Connect to server with user session ID from the radio client
    server = parent_gui.server_var.get()
    use_tls = parent_gui.tls_var.get()
    
    # Get user_session_id from the radio client
    if parent_gui.client and hasattr(parent_gui.client, 'user_session_id'):
        user_session_id = parent_gui.client.user_session_id
        display.connect(server, user_session_id, use_tls)
    else:
        # If no client or no session ID, show error
        import tkinter.messagebox as messagebox
        messagebox.showerror("Error", "No active radio session. Please ensure you're connected to the server.")
        window.destroy()
        return None, None
    
    return window, display