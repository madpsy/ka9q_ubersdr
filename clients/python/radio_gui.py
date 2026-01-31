#!/usr/bin/env python3
"""
GUI Radio Client for ka9q_ubersdr
Provides a graphical interface for the radio client with frequency, mode, and bandwidth controls.
"""

import asyncio
import sys
import threading
import tkinter as tk
from tkinter import ttk, messagebox, filedialog, simpledialog
from typing import Optional, List, Tuple, Dict
import queue
import socket
import requests
import time
import json
import os
import platform

# Import local bookmarks manager
from local_bookmarks import LocalBookmarkManager

# Import spectrum display
try:
    from spectrum_display import SpectrumDisplay
    SPECTRUM_AVAILABLE = True
except ImportError:
    SPECTRUM_AVAILABLE = False
    print("Warning: Spectrum display not available (missing dependencies)")

# Import waterfall display
try:
    from waterfall_display import create_waterfall_window
    WATERFALL_AVAILABLE = True
except ImportError:
    WATERFALL_AVAILABLE = False
    print("Warning: Waterfall display not available (missing dependencies)")

# Import audio spectrum display
try:
    from audio_spectrum_display import create_audio_spectrum_window
    AUDIO_SPECTRUM_AVAILABLE = True
except ImportError:
    AUDIO_SPECTRUM_AVAILABLE = False
    print("Warning: Audio spectrum display not available (missing dependencies)")

# Import digital spots display
try:
    from digital_spots_display import create_digital_spots_window
    DIGITAL_SPOTS_AVAILABLE = True
except ImportError:
    DIGITAL_SPOTS_AVAILABLE = False
    print("Warning: Digital spots display not available (missing dependencies)")

# Import CW spots display
try:
    from cw_spots_display import create_cw_spots_window
    CW_SPOTS_AVAILABLE = True
except ImportError:
    CW_SPOTS_AVAILABLE = False
    print("Warning: CW spots display not available (missing dependencies)")

# Import band conditions display
try:
    from band_conditions_display import create_band_conditions_window
    BAND_CONDITIONS_AVAILABLE = True
except ImportError:
    BAND_CONDITIONS_AVAILABLE = False
    print("Warning: Band conditions display not available (missing dependencies)")

# Import noise floor display
try:
    from noise_floor_display import create_noise_floor_window
    NOISE_FLOOR_AVAILABLE = True
except ImportError:
    NOISE_FLOOR_AVAILABLE = False
    print("Warning: Noise floor display not available (missing dependencies)")

# Import space weather display
try:
    from space_weather_display import create_space_weather_window
    SPACE_WEATHER_AVAILABLE = True
except ImportError:
    SPACE_WEATHER_AVAILABLE = False
    print("Warning: Space weather display not available (missing dependencies)")

# Import rotator status display
try:
    from rotator_status_display import create_rotator_status_window
    ROTATOR_STATUS_AVAILABLE = True
except ImportError:
    ROTATOR_STATUS_AVAILABLE = False
    print("Warning: Rotator status display not available (missing dependencies)")

# Import public instances display
try:
    from public_instances_display import create_public_instances_window
    PUBLIC_INSTANCES_AVAILABLE = True
except ImportError:
    PUBLIC_INSTANCES_AVAILABLE = False
    print("Warning: Public instances display not available (missing dependencies)")

# Import local instances display
try:
    from local_instances_display import create_local_instances_window
    LOCAL_INSTANCES_AVAILABLE = True
except ImportError:
    LOCAL_INSTANCES_AVAILABLE = False
    print("Warning: Local instances display not available (missing dependencies)")

# Import EQ display
try:
    from eq_display import create_eq_window
    EQ_AVAILABLE = True
except ImportError:
    EQ_AVAILABLE = False
    print("Warning: EQ display not available (missing dependencies)")

# Import users display
try:
    from users_display import create_users_window
    USERS_AVAILABLE = True
except ImportError:
    USERS_AVAILABLE = False
    print("Warning: Users display not available (missing dependencies)")

# Import chat display
try:
    from chat_display import create_chat_window, get_saved_username_for_instance
    CHAT_AVAILABLE = True
except ImportError:
    CHAT_AVAILABLE = False
    print("Warning: Chat display not available (missing dependencies)")

# Import shared WebSocket manager
try:
    from dxcluster_websocket import DXClusterWebSocket
    DXCLUSTER_WS_AVAILABLE = True
except ImportError:
    DXCLUSTER_WS_AVAILABLE = False
    print("Warning: DX cluster WebSocket not available (missing dependencies)")

# Check if NR2 is available
try:
    from nr2 import create_nr2_processor
    NR2_AVAILABLE = True
except ImportError:
    NR2_AVAILABLE = False

# Check if scipy is available (for audio filter)
try:
    from scipy import signal as scipy_signal
    SCIPY_AVAILABLE = True
except ImportError:
    SCIPY_AVAILABLE = False


def find_next_fifo_path() -> str:
    """Find the next available FIFO path (/tmp/ubersdr.fifo, ubersdr1.fifo, etc.).

    Returns empty string on Windows (FIFO not supported).
    """
    import os
    import platform

    # FIFO not supported on Windows
    if platform.system() == 'Windows':
        return ""

    # Try /tmp/ubersdr.fifo first
    base_path = "/tmp/ubersdr"
    if not os.path.exists(f"{base_path}.fifo"):
        return f"{base_path}.fifo"

    # Try numbered versions
    for i in range(1, 100):
        path = f"{base_path}{i}.fifo"
        if not os.path.exists(path):
            return path

    # Fallback if all are taken
    return f"{base_path}99.fifo"


# Import rigctl client
try:
    from rigctl import ThreadedRigctlClient
    RIGCTL_AVAILABLE = True
except ImportError:
    RIGCTL_AVAILABLE = False
    print("Warning: rigctl module not available")

# Import flrig client
try:
    from flrig_control import ThreadedFlrigClient
    FLRIG_AVAILABLE = True
except ImportError:
    FLRIG_AVAILABLE = False
    print("Warning: flrig module not available")

# Import OmniRig client (Windows only)
OMNIRIG_AVAILABLE = False
if platform.system() == 'Windows':
    try:
        from omnirig_process_client import OmniRigProcessClient as ThreadedOmniRigClient, OMNIRIG_AVAILABLE
        if not OMNIRIG_AVAILABLE:
            print("Warning: OmniRig module not available (install pywin32)")
    except ImportError as e:
        print(f"Warning: OmniRig module not available: {e}")
        OMNIRIG_AVAILABLE = False

# Import Serial CAT server
try:
    from serial_cat_server import SerialCATServer, list_serial_ports
    SERIAL_CAT_AVAILABLE = True
except ImportError:
    SERIAL_CAT_AVAILABLE = False
    print("Warning: Serial CAT module not available (install pyserial)")

# Import TCI server
try:
    from tci_server import TCIServer
    TCI_SERVER_AVAILABLE = True
except ImportError:
    TCI_SERVER_AVAILABLE = False
    print("Warning: TCI server module not available")

# Import TCI client
try:
    from tci_client import ThreadedTCIClient
    TCI_CLIENT_AVAILABLE = True
except ImportError:
    TCI_CLIENT_AVAILABLE = False
    print("Warning: TCI client module not available")


class RadioGUI:
    """Tkinter-based GUI for the radio client."""

    # Band frequency ranges (in Hz) - UK RSGB allocations (from static/app.js)
    BAND_RANGES = {
        '160m': {'min': 1810000, 'max': 2000000},
        '80m': {'min': 3500000, 'max': 3800000},
        '60m': {'min': 5258500, 'max': 5406500},
        '40m': {'min': 7000000, 'max': 7200000},
        '30m': {'min': 10100000, 'max': 10150000},
        '20m': {'min': 14000000, 'max': 14350000},
        '17m': {'min': 18068000, 'max': 18168000},
        '15m': {'min': 21000000, 'max': 21450000},
        '12m': {'min': 24890000, 'max': 24990000},
        '10m': {'min': 28000000, 'max': 29700000}
    }

    # SNR thresholds for band status (matching static/bands_state.js)
    SNR_THRESHOLDS = {
        'POOR': 6,      # SNR < 6 dB
        'FAIR': 20,     # 6 <= SNR < 20 dB
        'GOOD': 30,     # 20 <= SNR < 30 dB
        'EXCELLENT': 30 # SNR >= 30 dB
    }

    # Colors for band status (matching static/style.css)
    BAND_COLORS = {
        'POOR': '#ef4444',      # Red
        'FAIR': '#ff9800',      # Orange
        'GOOD': '#fbbf24',      # Yellow/Amber
        'EXCELLENT': '#22c55e', # Green
        'UNKNOWN': '#22c55e'    # Green (default when no data, same as EXCELLENT)
    }

    def __init__(self, root: tk.Tk, initial_config: dict):
        self.root = root
        self.root.title("Radio Client")
        self.root.geometry("900x920")  # Increased width for radio control VFO dropdown
        self.root.resizable(True, True)

        # Configuration
        self.config = initial_config

        # Server configurations storage
        self.servers = []  # List of saved server configurations
        self.config_file = self._get_config_file_path()
        self.load_servers()

        # Client state
        self.client: Optional[RadioClient] = None
        self.client_thread: Optional[threading.Thread] = None
        self.event_loop: Optional[asyncio.AbstractEventLoop] = None
        self.connected = False
        self.connecting = False  # Track if connection attempt is in progress
        self.cancel_connection = False  # Flag to cancel connection attempt
        self.status_queue = queue.Queue()
        self.audio_level_queue = queue.Queue()
        self.pipewire_devices: List[Tuple[str, str]] = []
        self.bypassed = False  # Track if connection is bypassed (allows higher IQ bandwidths)
        self.max_session_time = 0  # Maximum session time in seconds (0 = unlimited)
        self.connection_start_time = None  # Time when connection was established
        self.session_timer_job = None  # Timer job for updating session countdown
        self.bandwidth_update_job = None  # Debounce timer for bandwidth updates
        self.last_mode = None  # Track last mode to detect actual mode changes

        # Radio control (rigctl or OmniRig)
        self.radio_control_type = 'none'  # 'none', 'rigctl', or 'omnirig'
        self.radio_control = None  # Will be ThreadedRigctlClient or ThreadedOmniRigClient
        self.radio_control_connected = False
        self.radio_control_sync_enabled = False
        self.radio_control_poll_job = None  # For Rig→SDR polling
        self.radio_control_last_freq = None  # Track last known rig frequency
        self.radio_control_last_mode = None  # Track last known rig mode
        self.radio_control_last_ptt = False  # Track last known PTT state
        self.radio_control_saved_channels = None  # Store channel states before muting
        self.tci_client_spot_callback_registered = False  # Track if CW spot callback is registered

        # Legacy aliases for backward compatibility
        self.rigctl = None
        self.rigctl_connected = False
        self.rigctl_sync_enabled = False
        self.rigctl_poll_job = None
        self.rigctl_last_freq = None
        self.rigctl_last_mode = None
        self.rigctl_last_ptt = False
        self.rigctl_saved_channels = None

        # Band buttons dictionary for highlighting
        self.band_buttons = {}

        # Band state monitoring
        self.band_states: Dict[str, str] = {}  # band_name -> status
        self.band_state_poll_job = None
        self.last_band_state_update = 0

        # Bookmarks
        self.bookmarks: List[Dict] = []  # List of bookmark dictionaries (server bookmarks)
        self.local_bookmark_manager = LocalBookmarkManager()  # Local bookmarks manager
        self.local_bookmarks: List[Dict] = []  # List of local bookmark dictionaries

        # Bands (fetched from server)
        self.bands: List[Dict] = []  # List of band dictionaries from /api/bands

        # Recording state
        self.recording = False
        self.recording_start_time = None
        self.recording_data = []
        self.recording_max_duration = 300  # 300 seconds limit

        # Spectrum display (always enabled)
        self.spectrum: Optional[SpectrumDisplay] = None
        self.spectrum_frame = None

        # Waterfall display (separate window)
        self.waterfall_window = None
        self.waterfall_display = None

        # Audio spectrum display (separate window)
        self.audio_spectrum_window = None
        self.audio_spectrum_display = None

        # Shared DX cluster WebSocket manager
        self.dxcluster_ws = None

        # Digital spots display (separate window)
        self.digital_spots_window = None
        self.digital_spots_display = None

        # CW spots display (separate window)
        self.cw_spots_window = None
        self.cw_spots_display = None

        # Band conditions display (separate window)
        self.band_conditions_window = None
        self.band_conditions_display = None

        # Noise floor display (separate window)
        self.noise_floor_window = None
        self.noise_floor_display = None

        # Space weather display (separate window)
        self.space_weather_window = None
        self.space_weather_display = None

        # Rotator status display (separate window)
        self.rotator_status_window = None
        self.rotator_status_display = None

        # Public instances display (separate window)
        self.public_instances_window = None

        # Local instances display (separate window)
        self.local_instances_window = None
        self.local_instances_display = None

        # EQ display (separate window)
        self.eq_window = None
        self.eq_display = None

        # MIDI controller (separate window)
        self.midi_window = None
        self.midi_controller = None

        # Users display (separate window)
        self.users_window = None
        self.users_display = None

        # Chat display (separate window)
        self.chat_window = None
        self.chat_display = None

        # Create UI
        self.create_widgets()

        # Start status update checker
        self.check_status_updates()

        # Handle window close
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)

        # Auto-initialize MIDI controller if mappings exist (after UI is ready)
        self.root.after(100, self.auto_init_midi)

        # Don't fetch bookmarks/bands on startup - they will be fetched after connection
        # (removed lines 290-294)

        # Apply saved audio settings after UI is ready
        self.root.after(50, self.apply_saved_audio_settings)

        # Apply saved radio control settings after UI is ready
        self.root.after(60, self.apply_saved_radio_control_settings)

        # Auto-connect if requested (after UI is ready)
        if self.config.get('auto_connect', False):
            self.root.after(100, self.connect)  # Delay slightly to ensure UI is fully initialized
        # If using default localhost and not auto-connecting, check for local instances first
        elif self.config.get('host') == 'localhost' and not self.config.get('url') and not self.config.get('auto_connect'):
            self.root.after(200, self.check_and_open_instances_window)  # Delay to ensure UI is ready

    def _get_config_file_path(self) -> str:
        """Get platform-appropriate config file path for server configurations."""
        if platform.system() == 'Windows':
            # Use AppData on Windows
            config_dir = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'ubersdr')
            os.makedirs(config_dir, exist_ok=True)
            return os.path.join(config_dir, 'servers.json')
        else:
            # Use home directory on Unix-like systems
            return os.path.expanduser("~/.ubersdr_servers.json")

    def load_servers(self):
        """Load saved server configurations, audio settings, and radio control settings from file."""
        if not os.path.exists(self.config_file):
            return

        try:
            with open(self.config_file, 'r') as f:
                data = json.load(f)
                self.servers = data.get('servers', [])

                # Load audio settings if they exist
                audio_settings = data.get('audio_settings', {})
                if audio_settings:
                    # Store for later use (after UI is created)
                    self._saved_audio_settings = audio_settings

                # Load radio control settings if they exist
                radio_control_settings = data.get('radio_control_settings', {})
                if radio_control_settings:
                    # Store for later use (after UI is created)
                    self._saved_radio_control_settings = radio_control_settings

                # Only log if status_text exists (after UI is created)
                if hasattr(self, 'status_text'):
                    self.log_status(f"Loaded {len(self.servers)} saved server(s)")
        except Exception as e:
            print(f"Failed to load server configurations: {e}")
            self.servers = []
            self._saved_audio_settings = {}
            self._saved_radio_control_settings = {}

    def save_servers(self):
        """Save server configurations, audio settings, and radio control settings to file."""
        try:
            # Get current audio settings
            audio_settings = {
                'device': self.device_var.get(),
                'volume': self.volume_var.get(),
                'channel_left': self.channel_left_var.get(),
                'channel_right': self.channel_right_var.get(),
                'udp_enabled': self.udp_enabled_var.get(),
                'udp_host': self.udp_host_var.get(),
                'udp_port': self.udp_port_var.get(),
                'udp_stereo': self.udp_stereo_var.get(),
                'opus_enabled': self.opus_var.get()
            }

            # Get current radio control settings
            radio_control_settings = {
                'type': self.radio_control_type_var.get(),
                'host': self.radio_host_var.get(),
                'port': self.radio_port_var.get(),
                'vfo': self.radio_vfo_var.get(),
                'omnirig_rig': self.omnirig_rig_var.get(),
                'serial_port': self.serial_port_var.get(),
                'tci_server_port': self.tci_server_port_var.get(),
                'tci_client_host': self.tci_client_host_var.get(),
                'tci_client_port': self.tci_client_port_var.get(),
                'sync_direction': self.radio_sync_direction_var.get(),
                'mute_tx': self.radio_mute_tx_var.get()
            }

            data = {
                'servers': self.servers,
                'audio_settings': audio_settings,
                'radio_control_settings': radio_control_settings
            }

            with open(self.config_file, 'w') as f:
                json.dump(data, f, indent=2)
            # Only log when explicitly saving servers (not during auto-save)
            if hasattr(self, '_explicit_server_save') and self._explicit_server_save:
                self.log_status(f"Saved {len(self.servers)} server configuration(s)")
                self._explicit_server_save = False
        except Exception as e:
            messagebox.showerror("Error", f"Failed to save configurations: {e}")
            self.log_status(f"ERROR: Failed to save configurations - {e}")

    def apply_saved_audio_settings(self):
        """Apply saved audio settings to UI after it's created."""
        if not hasattr(self, '_saved_audio_settings'):
            return

        settings = self._saved_audio_settings

        # Apply device selection (silently)
        if 'device' in settings:
            device = settings['device']
            # Check if device exists in current device list
            if device in self.device_combo['values']:
                self.device_var.set(device)

        # Apply volume (silently)
        if 'volume' in settings:
            volume = settings['volume']
            self.volume_var.set(volume)
            self.volume_label.config(text=f"{volume}%")

        # Apply channel selection (silently)
        if 'channel_left' in settings:
            self.channel_left_var.set(settings['channel_left'])
        if 'channel_right' in settings:
            self.channel_right_var.set(settings['channel_right'])

        # Apply UDP settings (silently)
        if 'udp_enabled' in settings:
            self.udp_enabled_var.set(settings['udp_enabled'])
        if 'udp_host' in settings:
            self.udp_host_var.set(settings['udp_host'])
        if 'udp_port' in settings:
            self.udp_port_var.set(settings['udp_port'])
        if 'udp_stereo' in settings:
            self.udp_stereo_var.set(settings['udp_stereo'])

        # Apply Opus settings (silently)
        if 'opus_enabled' in settings:
            self.opus_var.set(settings['opus_enabled'])

    def apply_saved_radio_control_settings(self):
        """Apply saved radio control settings to UI after it's created."""
        if not hasattr(self, '_saved_radio_control_settings'):
            return

        settings = self._saved_radio_control_settings

        # Apply radio control type (silently)
        if 'type' in settings:
            control_type = settings['type']
            # Check if type is valid
            if control_type in self.radio_type_combo['values']:
                self.radio_control_type_var.set(control_type)
                # Update UI to show/hide appropriate controls
                self.on_radio_control_type_changed()

        # Apply host/port (silently)
        if 'host' in settings:
            self.radio_host_var.set(settings['host'])
        if 'port' in settings:
            self.radio_port_var.set(settings['port'])

        # Apply VFO selection (silently)
        if 'vfo' in settings:
            self.radio_vfo_var.set(settings['vfo'])

        # Apply OmniRig rig number (silently)
        if 'omnirig_rig' in settings:
            self.omnirig_rig_var.set(settings['omnirig_rig'])

        # Apply serial port (silently)
        if 'serial_port' in settings:
            self.serial_port_var.set(settings['serial_port'])

        # Apply TCI Server port (silently)
        if 'tci_server_port' in settings:
            self.tci_server_port_var.set(settings['tci_server_port'])

        # Apply TCI Client host/port (silently)
        if 'tci_client_host' in settings:
            self.tci_client_host_var.set(settings['tci_client_host'])
        if 'tci_client_port' in settings:
            self.tci_client_port_var.set(settings['tci_client_port'])

        # Apply sync direction (silently)
        if 'sync_direction' in settings:
            self.radio_sync_direction_var.set(settings['sync_direction'])

        # Apply mute TX setting (silently)
        if 'mute_tx' in settings:
            self.radio_mute_tx_var.set(settings['mute_tx'])

    def save_audio_settings(self):
        """Save audio settings automatically (called when settings change)."""
        # Use the existing save_servers method which now includes audio settings
        self.save_servers()

    def add_current_server(self):
        """Add current server configuration to saved servers."""
        # Get current server details from separate fields
        hostname = self.server_var.get().strip()
        if not hostname:
            messagebox.showerror("Error", "Please enter a server hostname")
            return

        # Get port from port field
        port_str = self.port_var.get().strip()
        if not port_str:
            messagebox.showerror("Error", "Please enter a port number")
            return

        try:
            port = int(port_str)
        except ValueError:
            messagebox.showerror("Error", "Invalid port number")
            return

        tls_enabled = self.tls_var.get()

        # Ask for a name for this server
        name = tk.simpledialog.askstring("Save Server",
                                         "Enter a name for this server:",
                                         initialvalue=hostname)
        if not name:
            return  # User cancelled

        # Check if server with this name already exists
        for i, server in enumerate(self.servers):
            if server['name'] == name:
                if messagebox.askyesno("Overwrite?",
                                      f"A server named '{name}' already exists. Overwrite it?"):
                    self.servers[i] = {
                        'name': name,
                        'hostname': hostname,
                        'port': port,
                        'tls': tls_enabled
                    }
                    self._explicit_server_save = True
                    self.save_servers()
                    self.populate_server_dropdown()
                    messagebox.showinfo("Success", f"Server '{name}' updated")
                return

        # Add new server
        self.servers.append({
            'name': name,
            'hostname': hostname,
            'port': port,
            'tls': tls_enabled
        })
        self._explicit_server_save = True
        self.save_servers()
        self.populate_server_dropdown()
        messagebox.showinfo("Success", f"Server '{name}' saved")

    def load_selected_server(self):
        """Load the selected server from dropdown."""
        selected = self.server_dropdown_var.get()
        if not selected or selected == "Select saved server...":
            return

        # Find the server
        for server in self.servers:
            if server['name'] == selected:
                # Update UI - populate hostname and port separately
                self.server_var.set(server['hostname'])
                self.port_var.set(str(server['port']))
                self.tls_var.set(server['tls'])
                self.log_status(f"Loaded server: {server['name']}")
                break

    def delete_selected_server(self):
        """Delete the selected server from saved servers."""
        selected = self.server_dropdown_var.get()
        if not selected or selected == "Select saved server...":
            messagebox.showinfo("Info", "Please select a server to delete")
            return

        if not messagebox.askyesno("Confirm Delete",
                                   f"Are you sure you want to delete server '{selected}'?"):
            return

        # Remove the server
        self.servers = [s for s in self.servers if s['name'] != selected]
        self.save_servers()
        self.populate_server_dropdown()
        self.server_dropdown_var.set("Select saved server...")
        messagebox.showinfo("Success", f"Server '{selected}' deleted")
    def open_public_instances_window(self):
        """Open a window showing public UberSDR instances."""
        # Don't open multiple windows
        if hasattr(self, 'public_instances_window') and self.public_instances_window and self.public_instances_window.winfo_exists():
            self.public_instances_window.lift()  # Bring to front
            return

        if not PUBLIC_INSTANCES_AVAILABLE:
            messagebox.showerror("Error", "Public instances display not available")
            return

        def on_connect(host, port, tls, name, callsign=None):
            """Callback when user selects an instance to connect to."""
            # Disconnect from current server if connected
            if self.connected:
                self.log_status(f"Disconnecting from current server...")
                self.disconnect()

            # Populate connection fields
            self.server_var.set(host)
            self.port_var.set(str(port))
            self.tls_var.set(tls)

            # Close both public and local instances windows
            if self.public_instances_window and self.public_instances_window.winfo_exists():
                self.public_instances_window.destroy()
                self.public_instances_window = None
            if self.local_instances_window and self.local_instances_window.winfo_exists():
                self.local_instances_window.destroy()
                self.local_instances_window = None
                self.local_instances_display = None

            # Connect automatically
            self.log_status(f"Connecting to public instance: {name}")
            self.connect()

        # Collect UUIDs from local instances
        local_uuids = self._get_local_uuids()

        self.public_instances_window = create_public_instances_window(self.root, on_connect, local_uuids)

    def _get_local_uuids(self):
        """Get UUIDs from discovered local instances.

        Returns:
            Set of public UUIDs from local instances
        """
        local_uuids = set()

        # If we already have a local instances display, use it
        if self.local_instances_display:
            for service_name, info in self.local_instances_display.instances.items():
                public_uuid = info.get('public_uuid', '')
                if public_uuid:
                    local_uuids.add(public_uuid)
        # Otherwise, try to discover local instances quickly
        elif LOCAL_INSTANCES_AVAILABLE:
            try:
                from zeroconf import Zeroconf, ServiceBrowser
                import threading
                import time

                discovered_uuids = []

                class QuickUUIDListener:
                    def __init__(self):
                        self.zc = None

                    def add_service(self, zc, type_, name):
                        self.zc = zc
                        info = zc.get_service_info(type_, name)
                        if info:
                            host = info.parsed_addresses()[0] if info.parsed_addresses() else None
                            port = info.port
                            if host and port:
                                # Fetch description to get public_uuid
                                try:
                                    import requests
                                    url = f"http://{host}:{port}/api/description"
                                    response = requests.get(url, timeout=2)
                                    response.raise_for_status()
                                    description = response.json()
                                    public_uuid = description.get('public_uuid', '')
                                    if public_uuid:
                                        discovered_uuids.append(public_uuid)
                                except:
                                    pass

                    def remove_service(self, zc, type_, name):
                        pass

                    def update_service(self, zc, type_, name):
                        pass

                # Quick discovery (2 second timeout)
                zc = Zeroconf()
                listener = QuickUUIDListener()
                browser = ServiceBrowser(zc, "_ubersdr._tcp.local.", listener)

                # Wait up to 2 seconds for discovery
                time.sleep(2.0)

                # Cleanup
                browser.cancel()
                zc.close()

                # Add discovered UUIDs
                local_uuids.update(discovered_uuids)
            except Exception as e:
                pass  # Silently fail if discovery doesn't work

        return local_uuids

    def open_local_instances_window(self):
        """Open a window showing local UberSDR instances discovered via mDNS."""
        # Don't open multiple windows
        if hasattr(self, 'local_instances_window') and self.local_instances_window and self.local_instances_window.winfo_exists():
            self.local_instances_window.lift()  # Bring to front
            return

        if not LOCAL_INSTANCES_AVAILABLE:
            messagebox.showerror("Error", "Local instances discovery not available. Install zeroconf:\npip install zeroconf")
            return

        def on_connect(host, port, tls, name, callsign=None):
            """Callback when user selects an instance to connect to."""
            # Disconnect from current server if connected
            if self.connected:
                self.log_status(f"Disconnecting from current server...")
                self.disconnect()

            # Populate connection fields
            self.server_var.set(host)
            self.port_var.set(str(port))
            self.tls_var.set(tls)

            # Close both public and local instances windows
            if self.public_instances_window and self.public_instances_window.winfo_exists():
                self.public_instances_window.destroy()
                self.public_instances_window = None
            if self.local_instances_window and self.local_instances_window.winfo_exists():
                self.local_instances_window.destroy()
                self.local_instances_window = None
                self.local_instances_display = None

            # Connect automatically
            self.log_status(f"Connecting to local instance: {name}")
            self.connect()

        self.local_instances_window, self.local_instances_display = create_local_instances_window(self.root, on_connect)

    def check_and_open_instances_window(self):
        """Check for local instances and open appropriate windows."""
        # Always open public instances window
        self.open_public_instances_window()

        # Also check for local instances if available
        if LOCAL_INSTANCES_AVAILABLE:
            try:
                from zeroconf import Zeroconf, ServiceBrowser
                import threading

                # Quick check for local instances (2 second timeout)
                found_local = threading.Event()

                class QuickListener:
                    def add_service(self, zc, type_, name):
                        found_local.set()
                    def remove_service(self, zc, type_, name):
                        pass
                    def update_service(self, zc, type_, name):
                        pass

                zc = Zeroconf()
                listener = QuickListener()
                browser = ServiceBrowser(zc, "_ubersdr._tcp.local.", listener)

                # Wait up to 2 seconds for discovery
                found_local.wait(timeout=2.0)

                # Cleanup
                browser.cancel()
                zc.close()

                # Open local instances window if any found
                if found_local.is_set():
                    self.log_status("Local instances found - opening Local Instances window")
                    self.open_local_instances_window()
                else:
                    self.log_status("No local instances found")

            except Exception as e:
                # If discovery fails, just log it (public window already open)
                self.log_status(f"Local discovery failed: {e}")

    def populate_server_dropdown(self):
        """Populate the server dropdown with saved servers."""
        server_names = ["Select saved server..."] + [s['name'] for s in self.servers]
        self.server_dropdown['values'] = server_names
        if not self.server_dropdown_var.get() or self.server_dropdown_var.get() not in server_names:
            self.server_dropdown_var.set("Select saved server...")

    def create_widgets(self):
        """Create all GUI widgets."""
        # Configure custom styles for band buttons and Mute TX checkbox
        style = ttk.Style()

        # Mute TX checkbox styles (green when not TX, red when TX)
        style.configure('MuteTX.Green.TCheckbutton', background='#22c55e', foreground='white')
        style.configure('MuteTX.Red.TCheckbutton', background='#ef4444', foreground='white')
        # Keep background color on hover (don't turn grey)
        style.map('MuteTX.Green.TCheckbutton', background=[('active', '#22c55e'), ('!active', '#22c55e')])
        style.map('MuteTX.Red.TCheckbutton', background=[('active', '#ef4444'), ('!active', '#ef4444')])

        # Opus checkbox styles (default and active/blue)
        style.configure('Opus.TCheckbutton', foreground='black')
        style.configure('OpusActive.TCheckbutton', foreground='blue')

        # Status-based styles (background colors based on SNR, white bold text)
        style.configure('Poor.TButton', background=self.BAND_COLORS['POOR'], foreground='white', font=('TkDefaultFont', 9, 'bold'))
        style.configure('Fair.TButton', background=self.BAND_COLORS['FAIR'], foreground='white', font=('TkDefaultFont', 9, 'bold'))
        style.configure('Good.TButton', background=self.BAND_COLORS['GOOD'], foreground='white', font=('TkDefaultFont', 9, 'bold'))
        style.configure('Excellent.TButton', background=self.BAND_COLORS['EXCELLENT'], foreground='white', font=('TkDefaultFont', 9, 'bold'))
        style.configure('Unknown.TButton', background=self.BAND_COLORS['UNKNOWN'], foreground='white', font=('TkDefaultFont', 9, 'bold'))

        # Hover styles (raised relief to "pop out")
        style.map('Poor.TButton', background=[('active', self.BAND_COLORS['POOR'])], relief=[('active', 'raised')])
        style.map('Fair.TButton', background=[('active', self.BAND_COLORS['FAIR'])], relief=[('active', 'raised')])
        style.map('Good.TButton', background=[('active', self.BAND_COLORS['GOOD'])], relief=[('active', 'raised')])
        style.map('Excellent.TButton', background=[('active', self.BAND_COLORS['EXCELLENT'])], relief=[('active', 'raised')])
        style.map('Unknown.TButton', background=[('active', self.BAND_COLORS['UNKNOWN'])], relief=[('active', 'raised')])

        # Active styles (with border for active band, white bold text)
        style.configure('Poor.Active.TButton', background=self.BAND_COLORS['POOR'], foreground='white', font=('TkDefaultFont', 9, 'bold'), relief='solid', borderwidth=3)
        style.configure('Fair.Active.TButton', background=self.BAND_COLORS['FAIR'], foreground='white', font=('TkDefaultFont', 9, 'bold'), relief='solid', borderwidth=3)
        style.configure('Good.Active.TButton', background=self.BAND_COLORS['GOOD'], foreground='white', font=('TkDefaultFont', 9, 'bold'), relief='solid', borderwidth=3)
        style.configure('Excellent.Active.TButton', background=self.BAND_COLORS['EXCELLENT'], foreground='white', font=('TkDefaultFont', 9, 'bold'), relief='solid', borderwidth=3)
        style.configure('Unknown.Active.TButton', background=self.BAND_COLORS['UNKNOWN'], foreground='white', font=('TkDefaultFont', 9, 'bold'), relief='solid', borderwidth=3)

        # Hover styles for active buttons (keep border, add raised relief)
        style.map('Poor.Active.TButton', background=[('active', self.BAND_COLORS['POOR'])], relief=[('active', 'raised')])
        style.map('Fair.Active.TButton', background=[('active', self.BAND_COLORS['FAIR'])], relief=[('active', 'raised')])
        style.map('Good.Active.TButton', background=[('active', self.BAND_COLORS['GOOD'])], relief=[('active', 'raised')])
        style.map('Excellent.Active.TButton', background=[('active', self.BAND_COLORS['EXCELLENT'])], relief=[('active', 'raised')])
        style.map('Unknown.Active.TButton', background=[('active', self.BAND_COLORS['UNKNOWN'])], relief=[('active', 'raised')])

        # Main container with padding
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)

        # Connection settings frame
        conn_frame = ttk.LabelFrame(main_frame, text="Connection", padding="10")
        conn_frame.grid(row=0, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))

        ttk.Label(conn_frame, text="Server:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))

        # Initialize server field - handle both URL and host:port formats
        initial_server = self.config.get('url')
        if not initial_server:
            # Use just the hostname, not host:port
            initial_server = self.config.get('host', 'localhost')

        self.server_var = tk.StringVar(value=initial_server)
        server_entry = ttk.Entry(conn_frame, textvariable=self.server_var, width=30)
        server_entry.grid(row=0, column=1, sticky=(tk.W, tk.E), padx=(0, 5))
        server_entry.bind('<Return>', lambda e: self.toggle_connection())

        # Port field (separate from hostname)
        ttk.Label(conn_frame, text="Port:").grid(row=0, column=2, sticky=tk.W, padx=(5, 5))
        self.port_var = tk.StringVar(value=str(self.config.get('port', 8080)))
        port_entry = ttk.Entry(conn_frame, textvariable=self.port_var, width=6)
        port_entry.grid(row=0, column=3, sticky=tk.W, padx=(0, 5))
        port_entry.bind('<Return>', lambda e: self.toggle_connection())

        # TLS checkbox - default from config or False
        self.tls_var = tk.BooleanVar(value=self.config.get('ssl', False))
        tls_check = ttk.Checkbutton(conn_frame, text="TLS", variable=self.tls_var)
        tls_check.grid(row=0, column=4, sticky=tk.W, padx=(0, 5))

        self.connect_btn = ttk.Button(conn_frame, text="Connect", command=self.toggle_connection)
        self.connect_btn.grid(row=0, column=5, padx=(0, 5))

        # Cancel button (hidden by default)
        self.cancel_btn = ttk.Button(conn_frame, text="Cancel", command=self.cancel_connection_attempt)
        self.cancel_btn.grid(row=0, column=6)
        self.cancel_btn.grid_remove()  # Hide initially

        # Server dropdown and management buttons (second row)
        ttk.Label(conn_frame, text="Saved:").grid(row=1, column=0, sticky=tk.W, padx=(0, 5), pady=(5, 0))

        self.server_dropdown_var = tk.StringVar(value="Select saved server...")
        self.server_dropdown = ttk.Combobox(conn_frame, textvariable=self.server_dropdown_var,
                                           state='readonly', width=28)
        self.server_dropdown.grid(row=1, column=1, sticky=(tk.W, tk.E), padx=(0, 5), pady=(5, 0))
        self.server_dropdown.bind('<<ComboboxSelected>>', lambda e: self.load_selected_server())

        # Populate dropdown with saved servers
        self.populate_server_dropdown()

        # Save button
        save_btn = ttk.Button(conn_frame, text="Save", width=6, command=self.add_current_server)
        save_btn.grid(row=1, column=2, sticky=tk.W, padx=(0, 5), pady=(5, 0))

        # Delete button
        delete_btn = ttk.Button(conn_frame, text="Delete", width=6, command=self.delete_selected_server)
        delete_btn.grid(row=1, column=3, sticky=tk.W, padx=(0, 5), pady=(5, 0))

        # Local button
        local_btn = ttk.Button(conn_frame, text="Local", width=6, command=self.open_local_instances_window)
        local_btn.grid(row=1, column=4, sticky=tk.W, padx=(0, 5), pady=(5, 0))

        # Public button
        public_btn = ttk.Button(conn_frame, text="Public", width=6, command=self.open_public_instances_window)
        public_btn.grid(row=1, column=5, sticky=tk.W, padx=(0, 5), pady=(5, 0))

        # Receiver info label (third row, initially hidden) - shows name, version, and map link
        ttk.Label(conn_frame, text="Receiver:").grid(row=2, column=0, sticky=tk.W, padx=(0, 5))

        # Create a frame to hold all receiver info on one line
        receiver_info_frame = ttk.Frame(conn_frame)
        receiver_info_frame.grid(row=2, column=1, columnspan=5, sticky=tk.W)

        # Receiver name (truncated to 50 chars)
        self.receiver_name_var = tk.StringVar(value="")
        self.receiver_name_label = ttk.Label(receiver_info_frame, textvariable=self.receiver_name_var, foreground='blue')
        self.receiver_name_label.pack(side=tk.LEFT)

        # Delimiter
        self.receiver_delimiter1 = ttk.Label(receiver_info_frame, text=" | ", foreground='gray')
        self.receiver_delimiter1.pack(side=tk.LEFT)

        # Version
        self.receiver_version_var = tk.StringVar(value="")
        self.receiver_version_label = ttk.Label(receiver_info_frame, textvariable=self.receiver_version_var, foreground='blue')
        self.receiver_version_label.pack(side=tk.LEFT)

        # Delimiter
        self.receiver_delimiter2 = ttk.Label(receiver_info_frame, text=" | ", foreground='gray')
        self.receiver_delimiter2.pack(side=tk.LEFT)

        # Map link (clickable)
        self.receiver_map_link = ttk.Label(receiver_info_frame, text="Open Map", foreground='blue', cursor='hand2')
        self.receiver_map_link.pack(side=tk.LEFT)
        self.receiver_map_link.bind('<Button-1>', self.open_receiver_map)

        # Hide entire frame initially until connected
        receiver_info_frame.grid_remove()
        self.receiver_info_frame = receiver_info_frame

        # Session timer label (same row as receiver, right side)
        self.session_timer_var = tk.StringVar(value="")
        self.session_timer_label = ttk.Label(conn_frame, textvariable=self.session_timer_var, foreground='blue', font=('TkDefaultFont', 9, 'bold'))
        self.session_timer_label.grid(row=2, column=5, columnspan=2, sticky=tk.E)
        self.session_timer_label.grid_remove()  # Hide initially until connected

        # Radio control connection (fourth row, optional)
        ttk.Label(conn_frame, text="Radio:").grid(row=3, column=0, sticky=tk.W, padx=(0, 5))

        # Create a frame to hold radio control controls so they stay together
        radio_controls = ttk.Frame(conn_frame)
        radio_controls.grid(row=3, column=1, columnspan=6, sticky=tk.W)

        # Radio control type selector (rigctl, flrig, OmniRig, Serial, TCI Server, or TCI Client)
        available_types = ['None']
        if RIGCTL_AVAILABLE:
            available_types.append('rigctl')
        if FLRIG_AVAILABLE:
            available_types.append('flrig')
        if OMNIRIG_AVAILABLE:
            available_types.append('OmniRig')
        if SERIAL_CAT_AVAILABLE:
            available_types.append('Serial')
        if TCI_SERVER_AVAILABLE:
            available_types.append('TCI Server')
        if TCI_CLIENT_AVAILABLE:
            available_types.append('TCI Client')

        # Set default based on platform
        default_type = 'None'
        if platform.system() == 'Windows' and OMNIRIG_AVAILABLE:
            default_type = 'OmniRig'
        elif FLRIG_AVAILABLE:
            default_type = 'flrig'
        elif RIGCTL_AVAILABLE:
            default_type = 'rigctl'

        self.radio_control_type_var = tk.StringVar(value=default_type)
        radio_type_combo = ttk.Combobox(radio_controls, textvariable=self.radio_control_type_var,
                                       values=available_types, state='readonly', width=8)
        radio_type_combo.pack(side=tk.LEFT, padx=(0, 5))
        radio_type_combo.bind('<<ComboboxSelected>>', lambda e: self.on_radio_control_type_changed())

        # Store reference for later use
        self.radio_type_combo = radio_type_combo

        # Host/Port fields (for rigctl and flrig)
        self.radio_host_label = ttk.Label(radio_controls, text="Host:")
        self.radio_host_label.pack(side=tk.LEFT, padx=(5, 5))

        # Default to rigctl port, but will be updated when type changes
        default_host = self.config.get('rigctl_host', self.config.get('flrig_host', '127.0.0.1'))
        self.radio_host_var = tk.StringVar(value=default_host)
        self.radio_host_entry = ttk.Entry(radio_controls, textvariable=self.radio_host_var, width=15)
        self.radio_host_entry.pack(side=tk.LEFT, padx=(0, 5))
        self.radio_host_entry.bind('<Return>', lambda e: self.toggle_radio_control_connection())
        # Auto-save when host changes
        self.radio_host_var.trace_add('write', lambda *args: self.save_servers())

        self.radio_port_label = ttk.Label(radio_controls, text="Port:")
        self.radio_port_label.pack(side=tk.LEFT, padx=(0, 5))

        # Default to rigctl port, but will be updated when type changes
        default_port = self.config.get('rigctl_port', self.config.get('flrig_port', 4532))
        self.radio_port_var = tk.StringVar(value=str(default_port))
        self.radio_port_entry = ttk.Entry(radio_controls, textvariable=self.radio_port_var, width=6)
        self.radio_port_entry.pack(side=tk.LEFT, padx=(0, 5))
        self.radio_port_entry.bind('<Return>', lambda e: self.toggle_radio_control_connection())
        # Auto-save when port changes
        self.radio_port_var.trace_add('write', lambda *args: self.save_servers())

        # VFO selector (for flrig and OmniRig)
        self.radio_vfo_label = ttk.Label(radio_controls, text="VFO:")
        self.radio_vfo_var = tk.StringVar(value='A')
        self.radio_vfo_combo = ttk.Combobox(radio_controls, textvariable=self.radio_vfo_var,
                                           values=['A', 'B'], state='readonly', width=5)
        self.radio_vfo_combo.bind('<<ComboboxSelected>>', lambda e: self.on_radio_vfo_changed())

        # Rig number selector (for OmniRig only)
        self.omnirig_rig_label = ttk.Label(radio_controls, text="Rig:")
        self.omnirig_rig_var = tk.StringVar(value='1')
        self.omnirig_rig_combo = ttk.Combobox(radio_controls, textvariable=self.omnirig_rig_var,
                                             values=['1', '2'], state='readonly', width=5)

        # Serial port selector (for Serial only)
        self.serial_port_label = ttk.Label(radio_controls, text="Port:")
        self.serial_port_var = tk.StringVar(value='')
        self.serial_port_combo = ttk.Combobox(radio_controls, textvariable=self.serial_port_var,
                                             width=15)
        # Auto-save when serial port changes
        self.serial_port_var.trace_add('write', lambda *args: self.save_servers())
        # Refresh button for serial ports
        self.serial_refresh_btn = ttk.Button(radio_controls, text="↻", width=3,
                                            command=self.refresh_serial_ports)

        # TCI server port (for TCI Server only)
        self.tci_server_port_label = ttk.Label(radio_controls, text="Port:")
        self.tci_server_port_var = tk.StringVar(value='40001')
        self.tci_server_port_entry = ttk.Entry(radio_controls, textvariable=self.tci_server_port_var, width=6)
        # Auto-save when TCI server port changes
        self.tci_server_port_var.trace_add('write', lambda *args: self.save_servers())

        # TCI connected client IP label (shown when TCI server has a client connected)
        self.tci_client_ip_var = tk.StringVar(value='')
        self.tci_client_ip_label = ttk.Label(radio_controls, textvariable=self.tci_client_ip_var, foreground='blue')

        # TCI client host/port (for TCI Client only)
        self.tci_client_host_label = ttk.Label(radio_controls, text="Host:")
        self.tci_client_host_var = tk.StringVar(value='127.0.0.1')
        self.tci_client_host_entry = ttk.Entry(radio_controls, textvariable=self.tci_client_host_var, width=15)
        # Auto-save when TCI client host changes
        self.tci_client_host_var.trace_add('write', lambda *args: self.save_servers())

        self.tci_client_port_label = ttk.Label(radio_controls, text="Port:")
        self.tci_client_port_var = tk.StringVar(value='40001')
        self.tci_client_port_entry = ttk.Entry(radio_controls, textvariable=self.tci_client_port_var, width=6)
        # Auto-save when TCI client port changes
        self.tci_client_port_var.trace_add('write', lambda *args: self.save_servers())

        # Hide VFO, OmniRig, and Serial controls initially
        # (will be shown when appropriate type is selected)

        self.radio_connect_btn = ttk.Button(radio_controls, text="Connect", command=self.toggle_radio_control_connection)
        self.radio_connect_btn.pack(side=tk.LEFT, padx=(0, 5))

        # Legacy aliases for backward compatibility
        self.rigctl_host_var = self.radio_host_var
        self.rigctl_port_var = self.radio_port_var
        self.rigctl_connect_btn = self.radio_connect_btn

        # Sync direction radio buttons (SDR->Rig or Rig->SDR) - always visible
        self.radio_sync_direction_var = tk.StringVar(value="SDR→Rig")

        self.radio_sdr_to_rig_radio = ttk.Radiobutton(radio_controls, text="SDR→Rig",
                                                       variable=self.radio_sync_direction_var,
                                                       value="SDR→Rig",
                                                       command=self.on_radio_sync_direction_changed)
        self.radio_sdr_to_rig_radio.pack(side=tk.LEFT, padx=(0, 5))

        self.radio_rig_to_sdr_radio = ttk.Radiobutton(radio_controls, text="Rig→SDR",
                                                       variable=self.radio_sync_direction_var,
                                                       value="Rig→SDR",
                                                       command=self.on_radio_sync_direction_changed)
        self.radio_rig_to_sdr_radio.pack(side=tk.LEFT, padx=(0, 10))

        # Mute TX checkbox (enabled by default)
        self.radio_mute_tx_var = tk.BooleanVar(value=True)
        self.radio_mute_tx_check = ttk.Checkbutton(radio_controls, text="Mute TX",
                                                     variable=self.radio_mute_tx_var)
        self.radio_mute_tx_check.pack(side=tk.LEFT)

        # TCI Client Spots checkbox (for forwarding CW spots to TCI server)
        self.tci_client_spots_var = tk.BooleanVar(value=True)
        self.tci_client_spots_check = ttk.Checkbutton(radio_controls, text="Spots",
                                                        variable=self.tci_client_spots_var)
        # Initially hidden - will be shown when TCI Client is selected

        # Legacy aliases for backward compatibility
        self.rigctl_sync_direction_var = self.radio_sync_direction_var
        self.rigctl_sdr_to_rig_radio = self.radio_sdr_to_rig_radio
        self.rigctl_rig_to_sdr_radio = self.radio_rig_to_sdr_radio
        self.rigctl_mute_tx_var = self.radio_mute_tx_var
        self.rigctl_mute_tx_check = self.radio_mute_tx_check

        conn_frame.columnconfigure(1, weight=1)

        # Frequency control frame
        freq_frame = ttk.LabelFrame(main_frame, text="Frequency", padding="10")
        freq_frame.grid(row=1, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))

        ttk.Label(freq_frame, text="Frequency:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))

        # Convert initial frequency from Hz to MHz for display
        initial_freq_hz = self.config.get('frequency', 14100000)
        initial_freq_mhz = initial_freq_hz / 1e6

        self.freq_var = tk.StringVar(value=f"{initial_freq_mhz:.6f}")
        freq_entry = ttk.Entry(freq_frame, textvariable=self.freq_var, width=12)
        freq_entry.grid(row=0, column=1, sticky=tk.W, padx=(0, 5))
        freq_entry.bind('<Return>', lambda e: self.apply_frequency())

        # Unit selector (Hz, kHz, MHz)
        self.freq_unit_var = tk.StringVar(value="MHz")
        self.prev_freq_unit = "MHz"  # Track previous unit for conversion
        unit_combo = ttk.Combobox(freq_frame, textvariable=self.freq_unit_var,
                                  values=["Hz", "kHz", "MHz"], state='readonly', width=6)
        unit_combo.grid(row=0, column=2, sticky=tk.W, padx=(0, 5))
        unit_combo.bind('<<ComboboxSelected>>', lambda e: self.on_freq_unit_changed())

        # Apply button (moved to top row)
        self.apply_freq_btn = ttk.Button(freq_frame, text="Apply", command=self.apply_frequency)
        self.apply_freq_btn.grid(row=0, column=3, sticky=tk.W, padx=(0, 5))
        self.apply_freq_btn.state(['disabled'])

        # Frequency lock checkbox (next to Apply button)
        self.freq_lock_var = tk.BooleanVar(value=False)
        freq_lock_check = ttk.Checkbutton(freq_frame, text="Lock", variable=self.freq_lock_var)
        freq_lock_check.grid(row=0, column=4, sticky=tk.W, padx=(0, 10))

        # Step size selector
        ttk.Label(freq_frame, text="Step:").grid(row=0, column=5, sticky=tk.W, padx=(10, 5))
        self.step_size_var = tk.StringVar(value="500 Hz")
        step_combo = ttk.Combobox(freq_frame, textvariable=self.step_size_var,
                                  values=["10 Hz", "100 Hz", "500 Hz", "1 kHz", "10 kHz"],
                                  state='readonly', width=8)
        step_combo.grid(row=0, column=6, sticky=tk.W, padx=(0, 5))
        step_combo.bind('<<ComboboxSelected>>', lambda e: self.on_step_size_changed())

        # Up/Down buttons
        ttk.Button(freq_frame, text="▲", width=3, command=self.step_frequency_up).grid(row=0, column=7, sticky=tk.W, padx=1)
        ttk.Button(freq_frame, text="▼", width=3, command=self.step_frequency_down).grid(row=0, column=8, sticky=tk.W, padx=1)

        # Save bookmark button (next to up/down arrows)
        ttk.Button(freq_frame, text="💾", width=3, command=self.save_current_bookmark).grid(row=0, column=9, sticky=tk.W, padx=(5, 0))

        # Quick frequency buttons - all amateur bands from 160m to 10m (single row)
        # Moved to second row
        quick_frame = ttk.Frame(freq_frame)
        quick_frame.grid(row=1, column=0, columnspan=8, sticky=tk.W, pady=(5, 0))

        # Band frequencies (center of digital/CW portions)
        quick_freqs = [
            ("160m", 1900000),   # 160m band - LSB
            ("80m", 3573000),    # 80m band - LSB
            ("60m", 5357000),    # 60m band (5 MHz) - LSB
            ("40m", 7074000),    # 40m band - LSB
            ("30m", 10136000),   # 30m band (WARC) - USB (above 10 MHz)
            ("20m", 14100000),   # 20m band - USB
            ("17m", 18100000),   # 17m band (WARC) - USB
            ("15m", 21074000),   # 15m band - USB
            ("12m", 24915000),   # 12m band (WARC) - USB
            ("10m", 28074000)    # 10m band - USB
        ]

        # Arrange in single row
        for i, (label, freq_hz) in enumerate(quick_freqs):
            # Use tk.Button on Windows for color support, ttk.Button on Linux for native theme
            if platform.system() == 'Windows':
                btn = tk.Button(quick_frame, text=label, width=5,
                              command=lambda f=freq_hz: self.set_frequency_and_mode(f),
                              relief=tk.RAISED, borderwidth=2)
            else:
                btn = ttk.Button(quick_frame, text=label, width=5,
                               command=lambda f=freq_hz: self.set_frequency_and_mode(f))
            btn.grid(row=0, column=i, padx=1, pady=1)
            # Store button reference for highlighting
            self.band_buttons[label] = btn


        # Initialize band button highlighting with current frequency
        try:
            initial_freq_hz = self.get_frequency_hz()
            self.update_band_buttons(initial_freq_hz)
        except ValueError:
            pass  # Ignore if frequency is invalid

        # Bookmarks dropdown (third row, below band buttons)
        bookmark_frame = ttk.Frame(freq_frame)
        bookmark_frame.grid(row=2, column=0, columnspan=8, sticky=tk.W, pady=(5, 0))

        ttk.Label(bookmark_frame, text="Bookmarks:").pack(side=tk.LEFT, padx=(0, 5))

        self.bookmark_var = tk.StringVar(value="")
        self.bookmark_combo = ttk.Combobox(bookmark_frame, textvariable=self.bookmark_var,
                                          state='readonly', width=15)
        self.bookmark_combo.pack(side=tk.LEFT, padx=(0, 5))
        self.bookmark_combo.bind('<<ComboboxSelected>>', lambda e: self.on_bookmark_selected())

        # Initially disabled until bookmarks are loaded
        self.bookmark_combo.config(state='disabled')

        # Local Bookmarks button
        ttk.Button(bookmark_frame, text="Local Bookmarks", command=self.open_local_bookmarks_window).pack(side=tk.LEFT, padx=(5, 0))

        # Band selector dropdown (to the right of bookmarks)
        ttk.Label(bookmark_frame, text="Band:").pack(side=tk.LEFT, padx=(20, 5))

        self.band_selector_var = tk.StringVar(value="")
        self.band_selector_combo = ttk.Combobox(bookmark_frame, textvariable=self.band_selector_var,
                                               state='readonly', width=25)
        self.band_selector_combo.pack(side=tk.LEFT, padx=(0, 5))
        self.band_selector_combo.bind('<<ComboboxSelected>>', lambda e: self.on_band_selected())

        # Band selector will be populated after fetching bands from server
        self.band_selector_combo['values'] = [""]  # Empty initially

        freq_frame.columnconfigure(8, weight=1)

        # Mode & Bandwidth control frame (combined)
        bw_frame = ttk.LabelFrame(main_frame, text="Mode", padding="10")
        bw_frame.grid(row=2, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))

        # Mode selection (first row) - now using buttons instead of dropdown
        # Create mode button styles
        style.configure('Mode.TButton', background='#22c55e', foreground='white', font=('TkDefaultFont', 9, 'bold'))
        style.configure('ModeActive.TButton', background='#16a34a', foreground='white', font=('TkDefaultFont', 9, 'bold'))
        style.map('Mode.TButton', background=[('active', '#22c55e')], relief=[('active', 'raised')])
        style.map('ModeActive.TButton', background=[('active', '#16a34a')], relief=[('active', 'raised')])

        # Mode buttons frame
        mode_buttons_frame = ttk.Frame(bw_frame)
        mode_buttons_frame.grid(row=0, column=0, columnspan=10, sticky=tk.W)

        # Define modes with their display names
        # First row: AM, SAM, USB, LSB, FM, NFM, CWU, CWL, IQ (9 buttons)
        # Second row: IQ48, IQ96, IQ192, IQ384 (only shown if bypassed=true)
        modes_row1 = [
            ('AM', 'AM'), ('SAM', 'SAM'), ('USB', 'USB'), ('LSB', 'LSB'),
            ('FM', 'FM'), ('NFM', 'NFM'), ('CWU', 'CWU'), ('CWL', 'CWL'),
            ('IQ', 'IQ')
        ]
        modes_row2 = [
            ('IQ48', 'IQ (48)'), ('IQ96', 'IQ (96)'),
            ('IQ192', 'IQ (192)'), ('IQ384', 'IQ (384)')
        ]

        self.mode_var = tk.StringVar(value=self.config.get('mode', 'USB').upper())
        self.mode_buttons = {}
        self.mode_buttons_row2 = []  # Track second row buttons for show/hide

        # Create first row mode buttons
        for i, (mode_value, mode_display) in enumerate(modes_row1):
            # Use tk.Button on Windows for color support, ttk.Button on Linux for native theme
            if platform.system() == 'Windows':
                btn = tk.Button(mode_buttons_frame, text=mode_display, width=10,
                              command=lambda m=mode_value: self.select_mode(m),
                              relief=tk.RAISED, borderwidth=2)
            else:
                btn = ttk.Button(mode_buttons_frame, text=mode_display, width=10,
                               command=lambda m=mode_value: self.select_mode(m))
            btn.grid(row=0, column=i, padx=1, pady=1)
            self.mode_buttons[mode_value] = btn

        # Create second row mode buttons (initially hidden)
        for i, (mode_value, mode_display) in enumerate(modes_row2):
            # Use tk.Button on Windows for color support, ttk.Button on Linux for native theme
            if platform.system() == 'Windows':
                btn = tk.Button(mode_buttons_frame, text=mode_display, width=10,
                              command=lambda m=mode_value: self.select_mode(m),
                              relief=tk.RAISED, borderwidth=2)
            else:
                btn = ttk.Button(mode_buttons_frame, text=mode_display, width=10,
                               command=lambda m=mode_value: self.select_mode(m))
            btn.grid(row=1, column=i, padx=1, pady=1)
            btn.grid_remove()  # Hide initially
            self.mode_buttons[mode_value] = btn
            self.mode_buttons_row2.append(btn)

        # Update initial button states
        self.update_mode_buttons()

        # Mode lock checkbox (moved to next row)
        self.mode_lock_var = tk.BooleanVar(value=False)
        mode_lock_check = ttk.Checkbutton(bw_frame, text="Lock", variable=self.mode_lock_var)
        mode_lock_check.grid(row=1, column=0, sticky=tk.W, padx=(0, 10), pady=(5, 0))

        # Bandwidth controls (third row) - using sliders
        ttk.Label(bw_frame, text="Low (Hz):").grid(row=2, column=0, sticky=tk.W, padx=(0, 5))
        self.bw_low_var = tk.IntVar(value=self.config.get('bandwidth_low', 50))
        self.bw_low_scale = ttk.Scale(bw_frame, from_=-10000, to=10000, orient=tk.HORIZONTAL,
                                      variable=self.bw_low_var, command=self.update_bandwidth_display,
                                      length=150)
        self.bw_low_scale.grid(row=2, column=1, sticky=(tk.W, tk.E), padx=(0, 5))

        self.bw_low_label = ttk.Label(bw_frame, text=f"{self.config.get('bandwidth_low', 50)} Hz", width=10)
        self.bw_low_label.grid(row=2, column=2, sticky=tk.W, padx=(0, 20))

        ttk.Label(bw_frame, text="High (Hz):").grid(row=2, column=3, sticky=tk.W, padx=(0, 5))
        self.bw_high_var = tk.IntVar(value=self.config.get('bandwidth_high', 2700))
        self.bw_high_scale = ttk.Scale(bw_frame, from_=-10000, to=10000, orient=tk.HORIZONTAL,
                                       variable=self.bw_high_var, command=self.update_bandwidth_display,
                                       length=150)
        self.bw_high_scale.grid(row=2, column=4, sticky=(tk.W, tk.E), padx=(0, 5))

        self.bw_high_label = ttk.Label(bw_frame, text=f"{self.config.get('bandwidth_high', 2700)} Hz", width=10)
        self.bw_high_label.grid(row=2, column=5, sticky=tk.W)

        # Set initial bandwidth slider bounds based on initial mode (must be done after sliders are created)
        initial_mode = self.config.get('mode', 'USB').lower()
        self.update_bandwidth_slider_bounds(initial_mode)

        # Preset bandwidth buttons (will be updated based on mode)
        self.preset_frame = ttk.Frame(bw_frame)
        self.preset_frame.grid(row=3, column=0, columnspan=5, sticky=tk.W, pady=(5, 0))

        ttk.Label(self.preset_frame, text="Presets:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))

        # Store preset buttons for dynamic updates
        self.preset_buttons = []

        # Create initial preset buttons (will be updated when mode changes)
        self.update_preset_buttons()

        bw_frame.columnconfigure(5, weight=1)

        # Audio control frame (includes NR2)
        audio_frame = ttk.LabelFrame(main_frame, text="Audio", padding="10")
        audio_frame.grid(row=3, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))

        # Output device selector (row 0)
        ttk.Label(audio_frame, text="Output Device:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))

        self.device_var = tk.StringVar(value="(default)")
        self.device_combo = ttk.Combobox(audio_frame, textvariable=self.device_var,
                                        state='readonly', width=30)
        self.device_combo.grid(row=0, column=1, columnspan=2, sticky=(tk.W, tk.E), padx=(0, 5))
        self.device_combo.bind('<<ComboboxSelected>>', lambda e: self.on_device_changed())

        # Create a frame to hold refresh button and "All" checkbox together
        refresh_frame = ttk.Frame(audio_frame)
        refresh_frame.grid(row=0, column=3, sticky=tk.W)

        # Refresh devices button
        self.refresh_devices_btn = ttk.Button(refresh_frame, text="↻", width=3,
                                             command=self.refresh_devices)
        self.refresh_devices_btn.pack(side=tk.LEFT)

        # "All" checkbox (Windows only - shows all APIs when enabled, WASAPI only when disabled)
        if platform.system() == 'Windows':
            self.show_all_devices_var = tk.BooleanVar(value=False)
            self.show_all_devices_check = ttk.Checkbutton(refresh_frame, text="All",
                                                          variable=self.show_all_devices_var,
                                                          command=self.refresh_devices)
            self.show_all_devices_check.pack(side=tk.LEFT, padx=(2, 0))
        else:
            self.show_all_devices_var = None

        # Load initial device list
        self.refresh_devices()

        # FIFO path (row 1) - only show on non-Windows platforms
        if platform.system() != 'Windows':
            ttk.Label(audio_frame, text="FIFO:").grid(row=1, column=0, sticky=tk.W, padx=(0, 5), pady=(5, 0))

            self.fifo_var = tk.StringVar(value=find_next_fifo_path())
            self.fifo_entry = ttk.Entry(audio_frame, textvariable=self.fifo_var, width=20)
            self.fifo_entry.grid(row=1, column=1, sticky=tk.W, padx=(0, 5), pady=(5, 0))
        else:
            # On Windows, FIFO is not supported - don't show the UI elements
            self.fifo_var = tk.StringVar(value="")
            self.fifo_entry = None

        # UDP output (additional output option) - row 1 (or same row as FIFO on non-Windows)
        # Use a frame to keep controls together without gaps
        if platform.system() != 'Windows':
            # On non-Windows, UDP is on same row as FIFO, to the right
            udp_row = 1
            udp_col_start = 2
            udp_pady = (5, 0)
            udp_padx = (10, 5)
        else:
            # On Windows, UDP is on row 1 by itself
            udp_row = 1
            udp_col_start = 0
            udp_pady = (5, 0)
            udp_padx = (0, 5)

        # Create a frame to hold UDP controls together
        udp_frame = ttk.Frame(audio_frame)
        udp_frame.grid(row=udp_row, column=udp_col_start, columnspan=4, sticky=tk.W, padx=udp_padx, pady=udp_pady)

        ttk.Label(udp_frame, text="UDP:").pack(side=tk.LEFT, padx=(0, 5))

        self.udp_enabled_var = tk.BooleanVar(value=False)
        self.udp_check = ttk.Checkbutton(udp_frame, text="Enable", variable=self.udp_enabled_var,
                                         command=self.toggle_udp_output)
        self.udp_check.pack(side=tk.LEFT, padx=(0, 5))

        ttk.Label(udp_frame, text="Host:").pack(side=tk.LEFT, padx=(5, 5))
        self.udp_host_var = tk.StringVar(value="127.0.0.1")
        self.udp_host_entry = ttk.Entry(udp_frame, textvariable=self.udp_host_var, width=12)
        self.udp_host_entry.pack(side=tk.LEFT, padx=(0, 5))
        # Auto-save when UDP host changes
        self.udp_host_var.trace_add('write', lambda *args: self.save_audio_settings())

        ttk.Label(udp_frame, text="Port:").pack(side=tk.LEFT, padx=(5, 5))
        self.udp_port_var = tk.StringVar(value="8888")
        self.udp_port_entry = ttk.Entry(udp_frame, textvariable=self.udp_port_var, width=6)
        self.udp_port_entry.pack(side=tk.LEFT, padx=(0, 5))
        # Auto-save when UDP port changes
        self.udp_port_var.trace_add('write', lambda *args: self.save_audio_settings())

        # UDP stereo checkbox
        self.udp_stereo_var = tk.BooleanVar(value=False)
        self.udp_stereo_check = ttk.Checkbutton(udp_frame, text="Stereo", variable=self.udp_stereo_var,
                                                command=self.on_udp_stereo_changed)
        self.udp_stereo_check.pack(side=tk.LEFT, padx=(5, 0))

        # Volume control (row 2)
        ttk.Label(audio_frame, text="Volume:").grid(row=2, column=0, sticky=tk.W, padx=(0, 5), pady=(5, 0))
        self.volume_var = tk.IntVar(value=70)
        self.volume_scale = ttk.Scale(audio_frame, from_=0, to=100, orient=tk.HORIZONTAL,
                                variable=self.volume_var, command=self.update_volume,
                                length=200)
        self.volume_scale.grid(row=2, column=1, sticky=(tk.W, tk.E), padx=(0, 10), pady=(5, 0))

        self.volume_label = ttk.Label(audio_frame, text="70%", width=5)
        self.volume_label.grid(row=2, column=2, sticky=tk.W, padx=(0, 10), pady=(5, 0))

        # Audio level meter - put label and meter in a container frame to eliminate gap
        level_container = ttk.Frame(audio_frame)
        level_container.grid(row=2, column=3, columnspan=2, sticky=(tk.W, tk.E), padx=(0, 5), pady=(5, 0))

        ttk.Label(level_container, text="Level:").pack(side=tk.LEFT, padx=(0, 5))

        # Create a frame for the level meter bar
        meter_frame = ttk.Frame(level_container, relief=tk.SUNKEN, borderwidth=1)
        meter_frame.pack(side=tk.LEFT, padx=(0, 5))

        # Canvas for audio level meter
        self.level_canvas = tk.Canvas(meter_frame, width=150, height=20, bg='#2c3e50', highlightthickness=0)
        self.level_canvas.pack()

        # Audio level bar (will be updated dynamically)
        self.level_bar = self.level_canvas.create_rectangle(0, 0, 0, 20, fill='#28a745', outline='')

        self.level_label = ttk.Label(level_container, text="-∞ dB", width=8)
        self.level_label.pack(side=tk.LEFT)

        # Channel selection (Left/Right) (row 3) - use a frame to keep them together
        ttk.Label(audio_frame, text="Channels:").grid(row=3, column=0, sticky=tk.W, padx=(0, 5), pady=(5, 0))

        channels_frame = ttk.Frame(audio_frame)
        channels_frame.grid(row=3, column=1, columnspan=2, sticky=tk.W, pady=(5, 0))

        self.channel_left_var = tk.BooleanVar(value=True)
        self.channel_right_var = tk.BooleanVar(value=True)

        self.left_check = ttk.Checkbutton(channels_frame, text="Left", variable=self.channel_left_var,
                                     command=self.update_channels)
        self.left_check.pack(side=tk.LEFT, padx=(0, 5))

        self.right_check = ttk.Checkbutton(channels_frame, text="Right", variable=self.channel_right_var,
                                      command=self.update_channels)
        self.right_check.pack(side=tk.LEFT)

        # EQ button (same row as channels)
        if EQ_AVAILABLE:
            self.eq_btn = ttk.Button(audio_frame, text="EQ", width=8,
                                     command=self.open_eq_window)
            self.eq_btn.grid(row=3, column=3, sticky=tk.W, padx=(20, 0), pady=(5, 0))
        else:
            self.eq_btn = None

        # Opus compression checkbox (same row, after EQ button)
        self.opus_var = tk.BooleanVar(value=True)  # Enabled by default
        self.opus_check = ttk.Checkbutton(audio_frame, text="Opus",
                                         variable=self.opus_var,
                                         command=self.on_opus_changed,
                                         style='Opus.TCheckbutton')
        self.opus_check.grid(row=3, column=4, columnspan=2, sticky=tk.W, padx=(20, 0), pady=(5, 0))

        # Store reference to checkbox label for color changes
        # We'll update the text color when Opus packets are received
        self.opus_active = False

        # NR2 Noise Reduction (row 4) - use a frame to avoid column weight issues
        nr2_container = ttk.Frame(audio_frame)
        nr2_container.grid(row=4, column=0, columnspan=7, sticky=tk.W, pady=(5, 0))

        self.nr2_enabled_var = tk.BooleanVar(value=False)
        self.nr2_check = ttk.Checkbutton(nr2_container, text="Enable NR2", variable=self.nr2_enabled_var,
                                    command=self.toggle_nr2)
        self.nr2_check.grid(row=0, column=0, sticky=tk.W, padx=(0, 20))

        ttk.Label(nr2_container, text="Strength:").grid(row=0, column=1, sticky=tk.W, padx=(0, 5))
        self.nr2_strength_var = tk.StringVar(value="40")
        nr2_strength_entry = ttk.Entry(nr2_container, textvariable=self.nr2_strength_var, width=8)
        nr2_strength_entry.grid(row=0, column=2, sticky=tk.W, padx=(0, 5))
        ttk.Label(nr2_container, text="%").grid(row=0, column=3, sticky=tk.W, padx=(0, 20))

        ttk.Label(nr2_container, text="Floor:").grid(row=0, column=4, sticky=tk.W, padx=(0, 5))
        self.nr2_floor_var = tk.StringVar(value="10")
        nr2_floor_entry = ttk.Entry(nr2_container, textvariable=self.nr2_floor_var, width=8)
        nr2_floor_entry.grid(row=0, column=5, sticky=tk.W, padx=(0, 5))
        ttk.Label(nr2_container, text="%").grid(row=0, column=6, sticky=tk.W, padx=(0, 20))

        # Recording controls (same row as NR2, to the right)
        self.rec_btn = ttk.Button(nr2_container, text="⏺ Record", width=10,
                                   command=self.toggle_recording)
        self.rec_btn.grid(row=0, column=7, sticky=tk.W, padx=(0, 10))
        self.rec_btn.state(['disabled'])  # Disabled until connected

        self.rec_status_label = ttk.Label(nr2_container, text="", foreground='red')
        self.rec_status_label.grid(row=0, column=8, sticky=tk.W)

        # Audio bandpass filter (row 5) - use a frame to avoid column weight issues
        filter_container = ttk.Frame(audio_frame)
        filter_container.grid(row=5, column=0, columnspan=7, sticky=(tk.W, tk.E), pady=(5, 0))

        self.audio_filter_enabled_var = tk.BooleanVar(value=False)
        self.filter_check = ttk.Checkbutton(filter_container, text="Enable Audio Filter", variable=self.audio_filter_enabled_var,
                                       command=self.toggle_audio_filter)
        self.filter_check.grid(row=0, column=0, sticky=tk.W, padx=(0, 20))

        # Low frequency slider (will be updated based on mode)
        ttk.Label(filter_container, text="Low:").grid(row=0, column=1, sticky=tk.W, padx=(0, 5))
        self.audio_filter_low_var = tk.IntVar(value=300)
        self.filter_low_scale = ttk.Scale(filter_container, from_=50, to=3000, orient=tk.HORIZONTAL,
                                          variable=self.audio_filter_low_var, command=self.update_audio_filter_display,
                                          length=150)
        self.filter_low_scale.grid(row=0, column=2, sticky=(tk.W, tk.E), padx=(0, 5))

        self.audio_filter_low_label = ttk.Label(filter_container, text="300 Hz", width=8)
        self.audio_filter_low_label.grid(row=0, column=3, sticky=tk.W, padx=(0, 20))

        # High frequency slider (will be updated based on mode)
        ttk.Label(filter_container, text="High:").grid(row=0, column=4, sticky=tk.W, padx=(0, 5))
        self.audio_filter_high_var = tk.IntVar(value=2700)
        self.filter_high_scale = ttk.Scale(filter_container, from_=100, to=6000, orient=tk.HORIZONTAL,
                                           variable=self.audio_filter_high_var, command=self.update_audio_filter_display,
                                           length=150)
        self.filter_high_scale.grid(row=0, column=5, sticky=(tk.W, tk.E), padx=(0, 5))

        self.audio_filter_high_label = ttk.Label(filter_container, text="2700 Hz", width=8)
        self.audio_filter_high_label.grid(row=0, column=6, sticky=tk.W)

        filter_container.columnconfigure(2, weight=1)
        filter_container.columnconfigure(5, weight=1)

        audio_frame.columnconfigure(1, weight=1)
        audio_frame.columnconfigure(4, weight=1)

        # Controls frame (buttons for opening windows)
        if SPECTRUM_AVAILABLE:
            controls_frame = ttk.LabelFrame(main_frame, text="Controls", padding="10")
            controls_frame.grid(row=4, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))

            # Create a hidden frame for spectrum display (will be moved to waterfall window)
            spectrum_container = tk.Frame(controls_frame)
            # Don't pack spectrum_container - it stays hidden

            # Create spectrum display in hidden container (bookmarks will be set after loading)
            self.spectrum = SpectrumDisplay(spectrum_container, width=800, height=200, bookmarks=[])
            self.spectrum.set_frequency_callback(self.on_spectrum_frequency_click)
            self.spectrum.set_frequency_step_callback(self.on_spectrum_frequency_step)
            self.spectrum.set_mode_callback(self.on_spectrum_mode_change)
            self.spectrum.set_bandwidth_callback(self.on_spectrum_bandwidth_change)
            self.spectrum.set_zoom_callback(self.on_spectrum_zoom_change)

            # Initialize spectrum with current bandwidth values
            try:
                initial_low = int(self.bw_low_var.get())
                initial_high = int(self.bw_high_var.get())
                self.spectrum.update_bandwidth(initial_low, initial_high, self.mode_var.get().lower())
            except ValueError:
                pass  # Use defaults if values are invalid

            # Add buttons for opening windows
            button_frame = ttk.Frame(controls_frame)
            button_frame.pack(side=tk.TOP, pady=(5, 5))

            if WATERFALL_AVAILABLE:
                waterfall_btn = ttk.Button(button_frame, text="RF Spec",
                                          command=self.open_waterfall_window)
                waterfall_btn.pack(side=tk.LEFT, padx=(0, 5))

            if AUDIO_SPECTRUM_AVAILABLE:
                self.audio_spectrum_btn = ttk.Button(button_frame, text="Audio Spec",
                                      command=self.open_audio_spectrum_window)
                self.audio_spectrum_btn.pack(side=tk.LEFT, padx=(0, 5))
            else:
                self.audio_spectrum_btn = None

            # Digital spots button (conditionally shown based on server capability)
            if DIGITAL_SPOTS_AVAILABLE:
                self.digital_spots_btn = ttk.Button(button_frame, text="Digital Spots",
                                      command=self.open_digital_spots_window)
                # Don't pack yet - will be shown after connection if server supports it
            else:
                self.digital_spots_btn = None

            # CW spots button (conditionally shown based on server capability)
            if CW_SPOTS_AVAILABLE:
                self.cw_spots_btn = ttk.Button(button_frame, text="CW Spots",
                                         command=self.open_cw_spots_window)
                # Don't pack yet - will be shown after connection if server supports it
            else:
                self.cw_spots_btn = None

            # Band conditions button (always available)
            if BAND_CONDITIONS_AVAILABLE:
                self.band_conditions_btn = ttk.Button(button_frame, text="Conditions",
                                                     command=self.open_band_conditions_window)
                self.band_conditions_btn.pack(side=tk.LEFT, padx=(0, 5))
            else:
                self.band_conditions_btn = None

            # Noise floor button (always available)
            if NOISE_FLOOR_AVAILABLE:
                self.noise_floor_btn = ttk.Button(button_frame, text="Noise", width=6,
                                                 command=self.open_noise_floor_window)
                self.noise_floor_btn.pack(side=tk.LEFT, padx=(0, 5))
            else:
                self.noise_floor_btn = None

            # Space weather button (always available)
            if SPACE_WEATHER_AVAILABLE:
                self.space_weather_btn = ttk.Button(button_frame, text="Weather",
                                                   command=self.open_space_weather_window)
                self.space_weather_btn.pack(side=tk.LEFT, padx=(0, 5))
            else:
                self.space_weather_btn = None

            # Rotator button (conditionally shown based on server capability)
            if ROTATOR_STATUS_AVAILABLE:
                self.rotator_btn = ttk.Button(button_frame, text="Rotator",
                                              command=self.open_rotator_status_window)
                # Don't pack yet - will be shown after connection if server supports it
            else:
                self.rotator_btn = None

            # MIDI controller button
            self.midi_btn = ttk.Button(button_frame, text="MIDI", width=6,
                                       command=self.open_midi_window)
            self.midi_btn.pack(side=tk.LEFT, padx=(0, 5))

            # Users button (always available)
            if USERS_AVAILABLE:
                self.users_btn = ttk.Button(button_frame, text="Users", width=6,
                                           command=self.open_users_window)
                self.users_btn.pack(side=tk.LEFT, padx=(0, 5))
            else:
                self.users_btn = None

            # Chat button (conditionally shown based on server capability)
            if CHAT_AVAILABLE:
                self.chat_btn = ttk.Button(button_frame, text="Chat", width=6,
                                          command=self.open_chat_window)
                # Don't pack yet - will be shown after connection if server supports it
            else:
                self.chat_btn = None

            # Scroll mode selector removed from here - now in waterfall window title section
            self.scroll_mode_var = tk.StringVar(value="zoom")

            controls_frame.columnconfigure(0, weight=1)

        # Status frame
        status_frame = ttk.LabelFrame(main_frame, text="Status", padding="10")
        status_frame.grid(row=5, column=0, columnspan=2, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))

        self.status_text = tk.Text(status_frame, height=8, width=50, state='disabled',
                                   wrap=tk.WORD, bg='#f0f0f0')
        self.status_text.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        scrollbar = ttk.Scrollbar(status_frame, orient=tk.VERTICAL, command=self.status_text.yview)
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))
        self.status_text['yscrollcommand'] = scrollbar.set

        status_frame.columnconfigure(0, weight=1)
        status_frame.rowconfigure(0, weight=1)

        # Configure main frame weights
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(5, weight=1)

        # Initial status
        self.log_status("Ready to connect")

        # Start audio level meter updates
        self.update_audio_level()

        # Update radio control UI based on default selection
        self.on_radio_control_type_changed()

    def log_status(self, message: str):
        """Add a status message to the log."""
        self.status_text.config(state='normal')
        # Get current content
        current_content = self.status_text.get('1.0', tk.END)
        # If there's existing content, add newline before the message
        if current_content.strip():
            self.status_text.insert(tk.END, f"\n{message}")
        else:
            self.status_text.insert(tk.END, message)
        self.status_text.see(tk.END)
        self.status_text.config(state='disabled')

    def set_frequency_hz(self, freq_hz: int):
        """Set frequency from quick button (input in Hz)."""
        # Check if frequency is locked FIRST, before any UI updates
        if self.freq_lock_var.get():
            self.log_status("Frequency is locked - change blocked")
            return

        # Convert to current unit
        unit = self.freq_unit_var.get()
        if unit == "MHz":
            freq_display = freq_hz / 1e6
            self.freq_var.set(f"{freq_display:.6f}")
        elif unit == "kHz":
            freq_display = freq_hz / 1e3
            self.freq_var.set(f"{freq_display:.3f}")
        else:  # Hz
            self.freq_var.set(str(freq_hz))

        if self.connected:
            self.apply_frequency()

    def set_frequency_and_mode(self, freq_hz: int):
        """Set frequency and appropriate mode from quick button (LSB < 10 MHz, USB >= 10 MHz)."""
        # Check if frequency is locked
        if self.freq_lock_var.get():
            self.log_status("Frequency is locked - change blocked")
            return

        # Set frequency display
        unit = self.freq_unit_var.get()
        if unit == "MHz":
            freq_display = freq_hz / 1e6
            self.freq_var.set(f"{freq_display:.6f}")
        elif unit == "kHz":
            freq_display = freq_hz / 1e3
            self.freq_var.set(f"{freq_display:.3f}")
        else:  # Hz
            self.freq_var.set(str(freq_hz))

        # Update band button highlighting
        self.update_band_buttons(freq_hz)

        # Set mode based on frequency (LSB below 10 MHz, USB at/above 10 MHz) only if:
        # 1. Mode is not locked, AND
        # 2. Rig control is not active with Rig→SDR direction (external software controls mode)
        rig_controls_mode = (self.radio_control_connected and
                            self.radio_sync_direction_var.get() == "Rig→SDR")

        if not self.mode_lock_var.get() and not rig_controls_mode:
            if freq_hz < 10000000:  # Below 10 MHz
                mode = 'LSB'
            else:  # 10 MHz and above
                mode = 'USB'

            self.mode_var.set(mode)
            # Trigger mode change handler to update bandwidth and presets
            self.on_mode_changed()

        # Apply changes if connected
        if self.connected:
            self.apply_frequency()


    def on_freq_unit_changed(self):
        """Handle frequency unit change - convert current value to new unit."""
        try:
            # Get current value and convert from previous unit to Hz
            freq_value = float(self.freq_var.get())
            old_unit = self.prev_freq_unit

            # Convert from old unit to Hz
            if old_unit == "MHz":
                freq_hz = int(freq_value * 1e6)
            elif old_unit == "kHz":
                freq_hz = int(freq_value * 1e3)
            else:  # Hz
                freq_hz = int(freq_value)

            # Convert from Hz to new unit
            new_unit = self.freq_unit_var.get()
            if new_unit == "MHz":
                new_value = freq_hz / 1e6
                self.freq_var.set(f"{new_value:.6f}")
            elif new_unit == "kHz":
                new_value = freq_hz / 1e3
                self.freq_var.set(f"{new_value:.3f}")
            else:  # Hz
                self.freq_var.set(str(freq_hz))

            # Update previous unit for next conversion
            self.prev_freq_unit = new_unit
        except ValueError:
            # If conversion fails, just update the previous unit
            self.prev_freq_unit = self.freq_unit_var.get()

    def update_bandwidth_display(self, value=None):
        """Update bandwidth labels when sliders change."""
        low = int(self.bw_low_var.get())
        high = int(self.bw_high_var.get())

        # Update labels
        self.bw_low_label.config(text=f"{low} Hz")
        self.bw_high_label.config(text=f"{high} Hz")

        # Disable audio filter when bandwidth changes (silently, without validation)
        if self.audio_filter_enabled_var.get():
            self.audio_filter_enabled_var.set(False)
            # Disable directly in client without calling toggle_audio_filter
            if self.client:
                self.client.audio_filter_enabled = False
            # Update audio spectrum display
            if self.audio_spectrum_display:
                self.audio_spectrum_display.update_audio_filter(False,
                    int(self.audio_filter_low_var.get()),
                    int(self.audio_filter_high_var.get()))
            self.log_status("Audio filter disabled (bandwidth changed)")

        # Update audio filter ranges when bandwidth changes
        self.update_audio_filter_ranges()

        # Update spectrum display bandwidth visualization
        if self.spectrum:
            self.spectrum.update_bandwidth(low, high, self.mode_var.get().lower())

        # Update waterfall display bandwidth visualization
        if self.waterfall_display:
            self.waterfall_display.update_bandwidth(low, high, self.mode_var.get().lower())

        # Update audio spectrum display bandwidth
        if self.audio_spectrum_display:
            self.audio_spectrum_display.update_bandwidth(low, high, self.mode_var.get().lower())

        # Update waterfall window's spectrum and waterfall if open
        if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
            self.waterfall_spectrum.update_bandwidth(low, high, self.mode_var.get().lower())
        if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
            self.waterfall_waterfall.update_bandwidth(low, high, self.mode_var.get().lower())

        # Apply bandwidth dynamically if connected (with debouncing)
        if self.connected and self.client:
            # Cancel any pending bandwidth update
            if self.bandwidth_update_job:
                self.root.after_cancel(self.bandwidth_update_job)

            # Schedule new bandwidth update after 100ms
            self.bandwidth_update_job = self.root.after(100, lambda: self._apply_bandwidth_update(low, high))

    def _apply_bandwidth_update(self, low: int, high: int):
        """Apply bandwidth update to server (called after debounce delay)."""
        if self.connected and self.client:
            self.client.bandwidth_low = low
            self.client.bandwidth_high = high

            # Reset NR2 learning when bandwidth changes (noise profile will be different)
            if self.client.nr2_enabled and self.client.nr2_processor:
                self.client.nr2_processor.reset_learning()
                self.log_status("NR2 relearning noise profile (bandwidth changed)")

            self.send_tune_message()

            # Notify chat of bandwidth change
            self.notify_chat_radio_changed()
        self.bandwidth_update_job = None

    def set_bandwidth(self, low: int, high: int):
        """Set bandwidth from preset button."""
        self.bw_low_var.set(low)
        self.bw_high_var.set(high)

        # Update labels
        self.bw_low_label.config(text=f"{low} Hz")
        self.bw_high_label.config(text=f"{high} Hz")

        # Update spectrum display bandwidth visualization
        if self.spectrum:
            self.spectrum.update_bandwidth(low, high)

        # Update waterfall display bandwidth visualization
        if self.waterfall_display:
            self.waterfall_display.update_bandwidth(low, high)

        # Update audio spectrum display bandwidth
        if self.audio_spectrum_display:
            self.audio_spectrum_display.update_bandwidth(low, high)

        if self.connected:
            self.apply_bandwidth()

    def get_step_size_hz(self) -> int:
        """Get the current step size in Hz."""
        step_str = self.step_size_var.get()
        if "10 Hz" in step_str:
            return 10
        elif "100 Hz" in step_str:
            return 100
        elif "500 Hz" in step_str:
            return 500
        elif "1 kHz" in step_str:
            return 1000
        elif "10 kHz" in step_str:
            return 10000
        return 1000  # Default

    def on_step_size_changed(self):
        """Handle step size change - update spectrum and waterfall displays."""
        step_hz = self.get_step_size_hz()

        if self.spectrum:
            self.spectrum.set_step_size(step_hz)

        # Update waterfall display if open
        if self.waterfall_display:
            self.waterfall_display.set_step_size(step_hz)

        # Update waterfall window's spectrum and waterfall if open
        if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
            self.waterfall_spectrum.set_step_size(step_hz)
        if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
            self.waterfall_waterfall.set_step_size(step_hz)

    def step_frequency_up(self):
        """Step frequency up by the selected step size, rounding to step boundaries."""
        # Check if frequency is locked
        if self.freq_lock_var.get():
            self.log_status("Frequency is locked - change blocked")
            return

        try:
            current_hz = self.get_frequency_hz()
            step_hz = self.get_step_size_hz()

            # Round up to next step boundary
            new_hz = ((current_hz // step_hz) + 1) * step_hz

            # Update display
            self.set_frequency_hz(new_hz)

            # Apply immediately if connected
            if self.connected:
                self.apply_frequency()
        except ValueError:
            pass

    def step_frequency_down(self):
        """Step frequency down by the selected step size, rounding to step boundaries."""
        # Check if frequency is locked
        if self.freq_lock_var.get():
            self.log_status("Frequency is locked - change blocked")
            return

        try:
            current_hz = self.get_frequency_hz()
            step_hz = self.get_step_size_hz()

            # Round down to previous step boundary
            new_hz = ((current_hz - 1) // step_hz) * step_hz

            # Update display
            self.set_frequency_hz(new_hz)

            # Apply immediately if connected
            if self.connected:
                self.apply_frequency()
        except ValueError:
            pass

    def set_frequency_hz(self, freq_hz: int):
        """Set the frequency display to the given Hz value."""
        # Check if frequency is locked FIRST, before any UI updates
        if self.freq_lock_var.get():
            self.log_status("Frequency is locked - change blocked")
            return

        # Convert to current unit
        unit = self.freq_unit_var.get()
        if unit == "Hz":
            self.freq_var.set(f"{freq_hz}")
        elif unit == "kHz":
            self.freq_var.set(f"{freq_hz / 1000:.3f}")
        else:  # MHz
            self.freq_var.set(f"{freq_hz / 1e6:.6f}")

        # Update band button highlighting
        self.update_band_buttons(freq_hz)

        # Update band dropdown selection
        self.update_band_selector(freq_hz)

        # Update bookmark dropdown selection
        self.update_bookmark_selector(freq_hz)

    def get_frequency_hz(self) -> int:
        """Convert frequency from current unit to Hz."""
        try:
            freq_value = float(self.freq_var.get())
            unit = self.freq_unit_var.get()

            if unit == "MHz":
                return int(freq_value * 1e6)
            elif unit == "kHz":
                return int(freq_value * 1e3)
            else:  # Hz
                return int(freq_value)
        except ValueError:
            raise ValueError("Invalid frequency value")

    def update_band_buttons(self, freq_hz: int):
        """Update band button highlighting based on current frequency.

        Args:
            freq_hz: Current frequency in Hz
        """
        current_band = None

        for band_name, button in self.band_buttons.items():
            # Use hardcoded BAND_RANGES for button highlighting
            # (server bands are for other purposes like the dropdown)
            band_range = self.BAND_RANGES.get(band_name)

            if band_range:
                is_active = band_range['min'] <= freq_hz <= band_range['max']

                if is_active:
                    current_band = band_name

                # Get band status (SNR-based color)
                status = self.band_states.get(band_name, 'UNKNOWN')
                color = self.BAND_COLORS[status]

                # Apply style based on button type (tk.Button on Windows, ttk.Button on Linux)
                if platform.system() == 'Windows':
                    # tk.Button: use bg, fg, relief, borderwidth
                    if is_active:
                        button.configure(bg=color, fg='white', relief=tk.SOLID, borderwidth=3)
                    else:
                        button.configure(bg=color, fg='white', relief=tk.RAISED, borderwidth=2)
                else:
                    # ttk.Button: use style
                    if is_active:
                        style_name = f'{status.capitalize()}.Active.TButton'
                        button.configure(style=style_name)
                    else:
                        style_name = f'{status.capitalize()}.TButton'
                        button.configure(style=style_name)

                # Force widget update on Windows
                if platform.system() == 'Windows':
                    button.update_idletasks()

        # Update band filter in digital spots window if open - only if band actually changed and auto_band is enabled
        if self.digital_spots_display and current_band:
            if self.digital_spots_display.auto_band_var.get() and self.digital_spots_display.band_filter.get() != current_band:
                self.digital_spots_display.band_filter.set(current_band)
                self.digital_spots_display.apply_filters()

        # Update band filter in CW spots window if open - only if band actually changed and auto_band is enabled
        if self.cw_spots_display and current_band:
            if self.cw_spots_display.auto_band_var.get() and self.cw_spots_display.band_var.get() != current_band:
                self.cw_spots_display.band_var.set(current_band)
                self.cw_spots_display.apply_filters()

    def fetch_band_states(self):
        """Fetch band states from the noise floor aggregate API and update button colors."""
        if not self.connected:
            self.log_status("DEBUG: fetch_band_states called but not connected")
            return

        try:
            from datetime import datetime, timedelta

            # Get server URL
            hostname = self.server_var.get().strip()
            port = self.port_var.get().strip()
            server = f"{hostname}:{port}" if ':' not in hostname else hostname
            use_tls = self.tls_var.get()

            # Build API URL
            if '://' in server:
                # Full URL provided
                base_url = server
            else:
                # Host:port format
                protocol = 'https' if use_tls else 'http'
                base_url = f"{protocol}://{server}"

            # Use /api/noisefloor/aggregate endpoint (matching bands_state.js)
            api_url = f"{base_url}/api/noisefloor/aggregate"

            # Get the previous 10 minutes time range in UTC (matching bands_state.js)
            now = datetime.utcnow()
            to_time = now.isoformat() + 'Z'
            from_time = (now - timedelta(minutes=10)).isoformat() + 'Z'

            # Build request body (matching bands_state.js format)
            # Always use hardcoded BAND_RANGES for band button updates
            request_body = {
                'primary': {
                    'from': from_time,
                    'to': to_time
                },
                'bands': list(self.BAND_RANGES.keys()),
                'fields': ['ft8_snr'],
                'interval': 'minute'
            }

            self.log_status(f"Fetching band states from {api_url}")

            # POST request with JSON body
            response = requests.post(
                api_url,
                json=request_body,
                headers={'Content-Type': 'application/json'},
                timeout=5
            )

            response.raise_for_status()
            data = response.json()

            if not data or 'primary' not in data:
                self.log_status("No band data available")
                return

            self.log_status(f"Band state data received")

            # Process band data (aggregate format)
            self.process_band_data_aggregate(data)

            # Update last update time
            self.last_band_state_update = time.time()

        except requests.exceptions.RequestException as e:
            # Log connection errors for debugging
            self.log_status(f"Band state fetch error: {e}")
        except Exception as e:
            # Log unexpected errors
            self.log_status(f"Band state update error: {e}")

    def process_band_data(self, data: dict):
        """Process noise floor data and determine band status.

        Args:
            data: Noise floor latest data from API (format: {band_name: {ft8_snr: value, ...}})
        """
        # Always use hardcoded BAND_RANGES for band button updates
        band_names = list(self.BAND_RANGES.keys())

        # Process each band
        for band_name in band_names:
            # Get band data from API response
            band_data = data.get(band_name, {})

            if not band_data or 'ft8_snr' not in band_data:
                # No data for this band - treat as UNKNOWN (green)
                self.band_states[band_name] = 'UNKNOWN'
                continue

            # Get the FT8 SNR value directly (latest endpoint returns single value per band)
            snr = band_data.get('ft8_snr')

            if snr is None or snr <= 0:
                # No valid SNR data - treat as UNKNOWN (green)
                self.band_states[band_name] = 'UNKNOWN'
                continue

            # Determine status based on SNR thresholds (matching bandconditions.js logic)
            if snr < self.SNR_THRESHOLDS['POOR']:
                status = 'POOR'
            elif snr < self.SNR_THRESHOLDS['FAIR']:
                status = 'FAIR'
            elif snr < self.SNR_THRESHOLDS['GOOD']:
                status = 'GOOD'
            else:
                status = 'EXCELLENT'

            self.band_states[band_name] = status
            self.log_status(f"{band_name}: {status} ({snr:.1f} dB)")

        # Update button colors
        try:
            current_freq = self.get_frequency_hz()
            self.update_band_buttons(current_freq)
        except ValueError:
            # If frequency is invalid, just update all buttons without active state
            for band_name, button in self.band_buttons.items():
                status = self.band_states.get(band_name, 'UNKNOWN')
                button.configure(style=f'{status.capitalize()}.TButton')

    def process_band_data_aggregate(self, data: dict):
        """Process aggregate noise floor data and determine band status.

        Args:
            data: Aggregate API response with format: {primary: {band_name: [{timestamp, values: {ft8_snr: ...}}]}}
        """
        primary_data = data.get('primary', {})

        # Always use hardcoded BAND_RANGES for band button updates
        band_names = list(self.BAND_RANGES.keys())

        # Process each band
        for band_name in band_names:
            band_data = primary_data.get(band_name, [])

            if not band_data or len(band_data) == 0:
                # No data for this band - treat as UNKNOWN (green)
                self.band_states[band_name] = 'UNKNOWN'
                continue

            # Calculate average SNR across all data points in the 10-minute window
            # (matching bands_state.js processBandData logic)
            total_snr = 0
            total_samples = 0

            for data_point in band_data:
                values = data_point.get('values', {})
                snr = values.get('ft8_snr')

                if snr is not None and snr > 0:
                    total_snr += snr
                    total_samples += 1

            if total_samples == 0:
                # No valid SNR data - treat as UNKNOWN (green)
                self.band_states[band_name] = 'UNKNOWN'
                continue

            # Calculate average SNR
            avg_snr = total_snr / total_samples

            # Determine status based on SNR thresholds (matching bands_state.js logic)
            if avg_snr < self.SNR_THRESHOLDS['POOR']:
                status = 'POOR'
            elif avg_snr < self.SNR_THRESHOLDS['FAIR']:
                status = 'FAIR'
            elif avg_snr < self.SNR_THRESHOLDS['GOOD']:
                status = 'GOOD'
            else:
                status = 'EXCELLENT'

            self.band_states[band_name] = status
            self.log_status(f"{band_name}: {status} ({avg_snr:.1f} dB)")

        # Update button colors
        try:
            current_freq = self.get_frequency_hz()
            self.update_band_buttons(current_freq)
        except ValueError:
            # If frequency is invalid, just update all buttons without active state
            for band_name, button in self.band_buttons.items():
                status = self.band_states.get(band_name, 'UNKNOWN')
                button.configure(style=f'{status.capitalize()}.TButton')
                # Force widget update on Windows
                button.update_idletasks()

    def start_band_state_polling(self):
        """Start periodic polling of band states (every 60 seconds)."""
        self.log_status(f"start_band_state_polling called, connected={self.connected}")

        if not self.connected:
            self.log_status("Band state polling skipped - not connected")
            return

        self.log_status("Starting band state polling...")

        # Fetch immediately on start
        self.fetch_band_states()

        # Schedule next poll in 60 seconds
        self.band_state_poll_job = self.root.after(60000, self.poll_band_states)

    def poll_band_states(self):
        """Poll band states periodically."""
        if not self.connected:
            return

        # Fetch band states
        self.fetch_band_states()

        # Schedule next poll in 60 seconds
        self.band_state_poll_job = self.root.after(60000, self.poll_band_states)

    def stop_band_state_polling(self):
        """Stop periodic polling of band states."""
        if self.band_state_poll_job:
            self.root.after_cancel(self.band_state_poll_job)
            self.band_state_poll_job = None

        # Always use hardcoded BAND_RANGES for band button updates
        band_names = list(self.BAND_RANGES.keys())

        # Reset band states to UNKNOWN
        for band_name in band_names:
            self.band_states[band_name] = 'UNKNOWN'

        # Update button colors
        try:
            current_freq = self.get_frequency_hz()
            self.update_band_buttons(current_freq)
        except ValueError:
            # If frequency is invalid, just update all buttons
            for band_name, button in self.band_buttons.items():
                button.configure(style='Unknown.TButton')
                # Force widget update on Windows
                button.update_idletasks()

    def fetch_bookmarks(self):
        """Fetch bookmarks from the server API."""
        try:
            # Get server URL
            hostname = self.server_var.get().strip()
            port = self.port_var.get().strip()
            server = f"{hostname}:{port}" if ':' not in hostname else hostname
            use_tls = self.tls_var.get()

            # Build API URL
            if '://' in server:
                # Full URL provided
                base_url = server
            else:
                # Host:port format
                protocol = 'https' if use_tls else 'http'
                base_url = f"{protocol}://{server}"

            api_url = f"{base_url}/api/bookmarks"

            # Fetch bookmarks
            response = requests.get(api_url, timeout=5)
            response.raise_for_status()
            data = response.json()

            if isinstance(data, list):
                self.bookmarks = data
                self.populate_bookmark_dropdown()
                # Update spectrum displays with merged bookmarks (server + local)
                self.update_spectrum_bookmarks()
                self.log_status(f"Loaded {len(self.bookmarks)} bookmark(s)")
            else:
                self.log_status("No bookmarks available")

        except requests.exceptions.RequestException as e:
            # Silently fail if bookmarks not available (server might not support it)
            self.log_status(f"Bookmarks not available: {e}")
            self.bookmarks = []
        except Exception as e:
            self.log_status(f"Error loading bookmarks: {e}")
            self.bookmarks = []

    def fetch_bands(self):
        """Fetch bands from the server API."""
        try:
            # Get server URL
            hostname = self.server_var.get().strip()
            port = self.port_var.get().strip()
            server = f"{hostname}:{port}" if ':' not in hostname else hostname
            use_tls = self.tls_var.get()

            # Build API URL
            if '://' in server:
                # Full URL provided
                base_url = server
            else:
                # Host:port format
                protocol = 'https' if use_tls else 'http'
                base_url = f"{protocol}://{server}"

            api_url = f"{base_url}/api/bands"

            # Fetch bands
            response = requests.get(api_url, timeout=5)
            response.raise_for_status()
            data = response.json()

            if isinstance(data, list):
                self.bands = data
                print(f"[BANDS] Fetched {len(self.bands)} bands from API")
                self.assign_band_colors()
                self.populate_band_selector()
                self.update_spectrum_bands()
                self.log_status(f"Loaded {len(self.bands)} band(s) from server")
            else:
                print(f"[BANDS] API returned non-list data: {type(data)}")
                self.log_status("No bands available from server")
                # Fall back to hardcoded bands
                self.use_hardcoded_bands()

        except requests.exceptions.RequestException as e:
            # Silently fall back to hardcoded bands if server doesn't support it
            print(f"[BANDS] Request error: {e}")
            self.log_status(f"Bands API not available, using defaults: {e}")
            self.use_hardcoded_bands()
        except Exception as e:
            print(f"[BANDS] Unexpected error: {e}")
            self.log_status(f"Error loading bands: {e}")
            self.use_hardcoded_bands()

    def assign_band_colors(self):
        """Assign pastel colors to bands (matching web UI color palette)."""
        # Color palette for bands (rainbow gradient with transparency)
        band_colors = [
            '#ffcccc',  # Light red
            '#ffd9cc',  # Light orange-red
            '#ffe6cc',  # Light orange
            '#ffffcc',  # Light yellow
            '#e6ffcc',  # Light yellow-green
            '#ccffcc',  # Light green
            '#ccffe6',  # Light cyan-green
            '#cce6ff',  # Light cyan
            '#ccccff',  # Light blue
            '#d9ccff'   # Light purple
        ]

        # Assign colors to bands
        for i, band in enumerate(self.bands):
            band['color'] = band_colors[i % len(band_colors)]

    def update_spectrum_bands(self):
        """Update spectrum displays with band data."""
        # Update main spectrum display if it exists
        if self.spectrum:
            self.spectrum.bands = self.bands

        # Update waterfall window's spectrum if it exists
        if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
            self.waterfall_spectrum.bands = self.bands

    def use_hardcoded_bands(self):
        """Use hardcoded BAND_RANGES as fallback."""
        # Convert BAND_RANGES to bands format
        self.bands = []
        for label, range_dict in self.BAND_RANGES.items():
            self.bands.append({
                'label': label,
                'start': range_dict['min'],
                'end': range_dict['max']
            })
        self.assign_band_colors()
        self.populate_band_selector()
        self.update_spectrum_bands()

    def populate_band_selector(self):
        """Populate the band selector dropdown with band labels."""
        if not self.bands:
            print(f"[BANDS] populate_band_selector: No bands to populate")
            self.band_selector_combo['values'] = [""]
            return

        # Extract band labels
        band_labels = [""] + [band.get('label', 'Unknown') for band in self.bands]
        print(f"[BANDS] populate_band_selector: Populating {len(band_labels)-1} bands into dropdown")

        # Update dropdown
        self.band_selector_combo['values'] = band_labels
        print(f"[BANDS] populate_band_selector: Dropdown values set")

        # Update initial selection based on current frequency
        try:
            freq_hz = self.get_frequency_hz()
            self.update_band_selector(freq_hz)
        except ValueError:
            pass  # Ignore if frequency is invalid

    def populate_bookmark_dropdown(self):
        """Populate the bookmark dropdown with bookmark names (merged server + local)."""
        # Load local bookmarks
        self.local_bookmarks = self.local_bookmark_manager.get_bookmarks()

        # Merge server and local bookmarks
        # Local bookmarks are prefixed with "📌 " to distinguish them
        all_bookmarks = []

        # Add server bookmarks first
        for bookmark in self.bookmarks:
            all_bookmarks.append({
                'name': bookmark.get('name', 'Unnamed'),
                'frequency': bookmark.get('frequency'),
                'mode': bookmark.get('mode', 'USB'),
                'bandwidth_low': bookmark.get('bandwidth_low'),
                'bandwidth_high': bookmark.get('bandwidth_high'),
                'is_local': False
            })

        # Add local bookmarks (keep original name, add is_local flag)
        for bookmark in self.local_bookmarks:
            all_bookmarks.append({
                'name': bookmark.get('name', 'Unnamed'),  # Keep original name for spectrum display
                'frequency': bookmark.get('frequency'),
                'mode': bookmark.get('mode', 'USB'),
                'bandwidth_low': bookmark.get('bandwidth_low'),
                'bandwidth_high': bookmark.get('bandwidth_high'),
                'is_local': True
            })

        if not all_bookmarks:
            self.bookmark_combo.config(state='disabled')
            self.bookmark_combo['values'] = []
            return

        # Extract bookmark names for dropdown (add pin prefix for local bookmarks in dropdown only)
        bookmark_names = []
        for b in all_bookmarks:
            if b.get('is_local', False):
                bookmark_names.append(f"📌 {b['name']}")  # Pin prefix for dropdown display only
            else:
                bookmark_names.append(b['name'])

        # Store merged bookmarks for later use
        self.all_bookmarks = all_bookmarks

        # Update dropdown
        self.bookmark_combo['values'] = bookmark_names
        self.bookmark_combo.config(state='readonly')

        # Update initial selection based on current frequency and mode
        try:
            freq_hz = self.get_frequency_hz()
            self.update_bookmark_selector(freq_hz)
        except ValueError:
            pass  # Ignore if frequency is invalid

    def on_bookmark_selected(self):
        """Handle bookmark selection from dropdown (supports both server and local bookmarks)."""
        selected_name = self.bookmark_var.get()
        if not selected_name:
            return

        # Strip pin prefix if present (local bookmarks have "📌 " prefix in dropdown)
        search_name = selected_name.replace("📌 ", "")

        # Find the selected bookmark in merged list
        selected_bookmark = None
        if hasattr(self, 'all_bookmarks'):
            for bookmark in self.all_bookmarks:
                if bookmark.get('name') == search_name:
                    selected_bookmark = bookmark
                    break

        if not selected_bookmark:
            return

        # Get frequency, mode, and bandwidth from bookmark
        frequency = selected_bookmark.get('frequency')
        mode = selected_bookmark.get('mode', 'USB').upper()
        bandwidth_low = selected_bookmark.get('bandwidth_low')
        bandwidth_high = selected_bookmark.get('bandwidth_high')

        if frequency:
            # Set frequency
            self.set_frequency_hz(int(frequency))

            # Set mode if not locked
            if not self.mode_lock_var.get():
                # Map mode names (bookmark might use different case)
                mode_map = {
                    'USB': 'USB', 'LSB': 'LSB', 'AM': 'AM', 'SAM': 'SAM',
                    'CWU': 'CWU', 'CWL': 'CWL', 'FM': 'FM', 'NFM': 'NFM',
                    'IQ': 'IQ', 'IQ48': 'IQ48', 'IQ96': 'IQ96',
                    'IQ192': 'IQ192', 'IQ384': 'IQ384'
                }
                mapped_mode = mode_map.get(mode, 'USB')
                self.mode_var.set(mapped_mode)
                self.on_mode_changed()

            # Set bandwidth if available
            if bandwidth_low is not None and bandwidth_high is not None:
                self.bw_low_var.set(bandwidth_low)
                self.bw_high_var.set(bandwidth_high)
                self.bw_low_label.config(text=f"{bandwidth_low} Hz")
                self.bw_high_label.config(text=f"{bandwidth_high} Hz")

                # Update client bandwidth values
                if self.client:
                    self.client.bandwidth_low = bandwidth_low
                    self.client.bandwidth_high = bandwidth_high

                # Update spectrum displays
                if self.spectrum:
                    self.spectrum.update_bandwidth(bandwidth_low, bandwidth_high, self.mode_var.get().lower())
                if self.waterfall_display:
                    self.waterfall_display.update_bandwidth(bandwidth_low, bandwidth_high, self.mode_var.get().lower())
                if self.audio_spectrum_display:
                    self.audio_spectrum_display.update_bandwidth(bandwidth_low, bandwidth_high, self.mode_var.get().lower())

            # Apply changes if connected (skip auto mode switching for bookmarks)
            if self.connected:
                self.apply_frequency(skip_auto_mode=True)

            bookmark_type = "local" if selected_bookmark.get('is_local') else "server"
            bw_info = f", {bandwidth_low}-{bandwidth_high} Hz" if bandwidth_low is not None and bandwidth_high is not None else ""
            self.log_status(f"Tuned to {bookmark_type} bookmark: {selected_name} ({frequency/1e6:.6f} MHz, {mode}{bw_info})")

    def on_band_selected(self):
        """Handle band selection from dropdown."""
        selected_band = self.band_selector_var.get()
        if not selected_band:
            return

        # Find the selected band in fetched bands
        band_data = None
        for band in self.bands:
            if band.get('label') == selected_band:
                band_data = band
                break

        if not band_data:
            return

        # Calculate center frequency
        center_freq = (band_data['start'] + band_data['end']) // 2

        # Set frequency
        self.set_frequency_hz(center_freq)

        # Determine mode based on frequency (LSB < 10 MHz, USB >= 10 MHz) only if not locked
        if not self.mode_lock_var.get():
            if center_freq < 10000000:  # Below 10 MHz
                mode = 'LSB'
            else:  # 10 MHz and above
                mode = 'USB'

            self.mode_var.set(mode)
            # Trigger mode change handler to update bandwidth and presets
            self.on_mode_changed()

        # Apply changes if connected
        if self.connected:
            self.apply_frequency()

        self.log_status(f"Tuned to {selected_band} band: {center_freq/1e6:.6f} MHz")

        # Reset dropdown to empty after selection
        self.band_selector_var.set("")

    def update_band_selector(self, freq_hz: int):
        """Update band selector dropdown to show the current band without triggering action.

        Args:
            freq_hz: Current frequency in Hz
        """
        if not self.bands:
            return

        # Find matching band
        for band in self.bands:
            if band['start'] <= freq_hz <= band['end']:
                # Set dropdown value without triggering the callback
                current_value = self.band_selector_var.get()
                band_label = band.get('label', 'Unknown')

                # Only update if different to avoid unnecessary updates
                if current_value != band_label:
                    self.band_selector_var.set(band_label)
                return

        # No matching band - clear selection
        if self.band_selector_var.get() != "":
            self.band_selector_var.set("")

    def update_bookmark_selector(self, freq_hz: int):
        """Update bookmark selector dropdown to show matching bookmark without triggering action.

        Args:
            freq_hz: Current frequency in Hz
        """
        if not hasattr(self, 'all_bookmarks') or not self.all_bookmarks:
            return

        # Get current mode
        try:
            current_mode = self.mode_var.get().upper()
        except:
            current_mode = None

        # Find matching bookmark (must match both frequency and mode)
        for bookmark in self.all_bookmarks:
            bookmark_freq = bookmark.get('frequency')
            bookmark_mode = bookmark.get('mode', 'USB').upper()

            # Check if frequency matches (within 1 kHz tolerance)
            if bookmark_freq and abs(freq_hz - bookmark_freq) < 1000:
                # Check if mode matches
                if current_mode and bookmark_mode == current_mode:
                    # Set dropdown value without triggering the callback
                    current_value = self.bookmark_var.get()
                    bookmark_name = bookmark.get('name', 'Unnamed')

                    # Only update if different to avoid unnecessary updates
                    if current_value != bookmark_name:
                        self.bookmark_var.set(bookmark_name)
                    return

        # No matching bookmark - clear selection
        if self.bookmark_var.get() != "":
            self.bookmark_var.set("")

    def save_current_bookmark(self):
        """Save current frequency, mode, and bandwidth as a local bookmark."""
        try:
            # Get current settings
            freq_hz = self.get_frequency_hz()
            mode = self.mode_var.get().upper()
            bandwidth_low = int(self.bw_low_var.get())
            bandwidth_high = int(self.bw_high_var.get())

            # Ask user for bookmark name
            name = simpledialog.askstring(
                "Save Bookmark",
                "Enter a name for this bookmark:",
                initialvalue=f"{freq_hz/1e6:.3f} MHz {mode}"
            )

            if not name:
                return  # User cancelled

            # Check if bookmark with this name already exists
            existing_bookmarks = self.local_bookmark_manager.get_bookmarks()
            existing_names = [b.get('name') for b in existing_bookmarks]

            overwrite_confirmed = False
            if name in existing_names:
                # Ask user if they want to overwrite
                overwrite_confirmed = messagebox.askyesno(
                    "Bookmark Exists",
                    f"A bookmark named '{name}' already exists.\nDo you want to overwrite it?",
                    icon='warning'
                )
                if not overwrite_confirmed:
                    return  # User chose not to overwrite

            # Save bookmark (with overwrite flag if user confirmed)
            success = self.local_bookmark_manager.save_bookmark(
                name=name,
                frequency=freq_hz,
                mode=mode.lower(),
                bandwidth_low=bandwidth_low,
                bandwidth_high=bandwidth_high,
                overwrite=overwrite_confirmed
            )

            if success:
                self.log_status(f"Saved local bookmark: {name}")
                # Refresh bookmark dropdown to include new bookmark
                self.populate_bookmark_dropdown()
                # Update spectrum displays with new bookmarks
                self.update_spectrum_bookmarks()
            else:
                messagebox.showerror("Error", f"Failed to save bookmark '{name}'")

        except ValueError as e:
            messagebox.showerror("Error", f"Invalid frequency: {e}")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to save bookmark: {e}")
            self.log_status(f"ERROR: Failed to save bookmark - {e}")

    def update_spectrum_bookmarks(self):
        """Update spectrum displays with merged bookmarks (server + local)."""
        # Use the already-merged bookmarks list from populate_bookmark_dropdown()
        # This ensures dropdown and spectrum use the exact same bookmark data
        if not hasattr(self, 'all_bookmarks'):
            return

        # Use the merged bookmarks list (already has is_local flags set correctly)
        merged_bookmarks = self.all_bookmarks

        # Update spectrum displays
        if self.spectrum:
            self.spectrum.bookmarks = merged_bookmarks
            # Force redraw to show updated bookmarks (only for SpectrumDisplay objects)
            if self.spectrum.spectrum_data is not None:
                self.spectrum._draw_spectrum()

        if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
            self.waterfall_spectrum.bookmarks = merged_bookmarks
            # Force redraw only for SpectrumDisplay objects (waterfall_spectrum is a SpectrumDisplay)
            if hasattr(self.waterfall_spectrum, '_draw_spectrum') and self.waterfall_spectrum.spectrum_data is not None:
                self.waterfall_spectrum._draw_spectrum()
        if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
            self.waterfall_waterfall.bookmarks = merged_bookmarks
            # WaterfallDisplay doesn't have _draw_spectrum method, bookmarks will appear on next update

    def open_local_bookmarks_window(self):
        """Open the local bookmarks management window."""
        # Don't open multiple windows
        if hasattr(self, 'local_bookmarks_window') and self.local_bookmarks_window and self.local_bookmarks_window.winfo_exists():
            self.local_bookmarks_window.lift()  # Bring to front
            return

        # Create new window
        self.local_bookmarks_window = tk.Toplevel(self.root)
        self.local_bookmarks_window.title("Local Bookmarks")
        self.local_bookmarks_window.geometry("600x400")

        # Main frame
        main_frame = ttk.Frame(self.local_bookmarks_window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.local_bookmarks_window.columnconfigure(0, weight=1)
        self.local_bookmarks_window.rowconfigure(0, weight=1)

        # Listbox with scrollbar
        list_frame = ttk.Frame(main_frame)
        list_frame.grid(row=0, column=0, columnspan=2, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))

        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL)
        self.bookmarks_listbox = tk.Listbox(list_frame, yscrollcommand=scrollbar.set, height=15)
        scrollbar.config(command=self.bookmarks_listbox.yview)

        self.bookmarks_listbox.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))

        list_frame.columnconfigure(0, weight=1)
        list_frame.rowconfigure(0, weight=1)

        # Populate listbox
        self.refresh_bookmarks_listbox()

        # Buttons frame
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=1, column=0, columnspan=2, sticky=tk.W)

        ttk.Button(button_frame, text="Tune", command=self.tune_to_selected_bookmark).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(button_frame, text="Rename", command=self.rename_selected_bookmark).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(button_frame, text="Delete", command=self.delete_selected_bookmark).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(button_frame, text="Close", command=self.local_bookmarks_window.destroy).pack(side=tk.LEFT, padx=(0, 5))

        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(0, weight=1)

    def refresh_bookmarks_listbox(self):
        """Refresh the bookmarks listbox with current local bookmarks."""
        if not hasattr(self, 'bookmarks_listbox'):
            return

        self.bookmarks_listbox.delete(0, tk.END)
        self.local_bookmarks = self.local_bookmark_manager.get_bookmarks()

        for bookmark in self.local_bookmarks:
            name = bookmark.get('name', 'Unnamed')
            freq = bookmark.get('frequency', 0)
            mode = bookmark.get('mode', 'USB').upper()
            display_text = f"{name} - {freq/1e6:.6f} MHz {mode}"
            self.bookmarks_listbox.insert(tk.END, display_text)

    def tune_to_selected_bookmark(self):
        """Tune to the selected bookmark in the listbox."""
        selection = self.bookmarks_listbox.curselection()
        if not selection:
            messagebox.showinfo("Info", "Please select a bookmark")
            return

        index = selection[0]
        bookmark = self.local_bookmarks[index]

        # Set frequency and mode
        freq_hz = bookmark.get('frequency')
        mode = bookmark.get('mode', 'USB').upper()

        if freq_hz:
            self.set_frequency_hz(int(freq_hz))

            # Set mode if not locked
            if not self.mode_lock_var.get():
                self.mode_var.set(mode)
                self.on_mode_changed()

            # Apply changes if connected
            if self.connected:
                self.apply_frequency(skip_auto_mode=True)

            self.log_status(f"Tuned to local bookmark: {bookmark.get('name')} ({freq_hz/1e6:.6f} MHz, {mode})")

    def rename_selected_bookmark(self):
        """Rename the selected bookmark."""
        selection = self.bookmarks_listbox.curselection()
        if not selection:
            messagebox.showinfo("Info", "Please select a bookmark to rename")
            return

        index = selection[0]
        old_name = self.local_bookmarks[index].get('name', 'Unnamed')

        # Ask for new name
        new_name = simpledialog.askstring(
            "Rename Bookmark",
            "Enter new name:",
            initialvalue=old_name
        )

        if not new_name or new_name == old_name:
            return  # User cancelled or no change

        # Rename bookmark
        success = self.local_bookmark_manager.rename_bookmark(index, new_name)

        if success:
            self.log_status(f"Renamed bookmark: {old_name} → {new_name}")
            self.refresh_bookmarks_listbox()
            self.populate_bookmark_dropdown()
            self.update_spectrum_bookmarks()
        else:
            messagebox.showerror("Error", f"A bookmark named '{new_name}' already exists")

    def delete_selected_bookmark(self):
        """Delete the selected bookmark."""
        selection = self.bookmarks_listbox.curselection()
        if not selection:
            messagebox.showinfo("Info", "Please select a bookmark to delete")
            return

        index = selection[0]
        name = self.local_bookmarks[index].get('name', 'Unnamed')

        # Confirm deletion
        if not messagebox.askyesno("Confirm Delete", f"Delete bookmark '{name}'?"):
            return

        # Delete bookmark
        success = self.local_bookmark_manager.delete_bookmark(index)

        if success:
            self.log_status(f"Deleted local bookmark: {name}")
            self.refresh_bookmarks_listbox()
            self.populate_bookmark_dropdown()
            self.update_spectrum_bookmarks()
        else:
            messagebox.showerror("Error", "Failed to delete bookmark")

    def apply_frequency(self, skip_auto_mode=False):
        """Apply frequency change by sending tune message.

        Args:
            skip_auto_mode: If True, skip automatic mode switching based on frequency
        """
        if not self.connected or not self.client:
            return

        # Check if frequency is locked
        if self.freq_lock_var.get():
            self.log_status("Frequency is locked - change blocked")
            return

        try:
            freq_hz = self.get_frequency_hz()

            # Validate frequency range: 100 kHz to 30 MHz
            if freq_hz < 100000:  # 100 kHz
                messagebox.showerror("Invalid Frequency", "Frequency must be at least 100 kHz")
                return
            if freq_hz > 30000000:  # 30 MHz
                messagebox.showerror("Invalid Frequency", "Frequency must not exceed 30 MHz")
                return

            self.client.frequency = freq_hz

            # Update band button highlighting
            self.update_band_buttons(freq_hz)

            # Reset NR2 learning when frequency changes (noise profile will be different)
            if self.client.nr2_enabled and self.client.nr2_processor:
                self.client.nr2_processor.reset_learning()
                self.log_status("NR2 relearning noise profile (frequency changed)")

            # Auto-select appropriate mode based on frequency (LSB < 10 MHz, USB >= 10 MHz)
            # Only auto-switch for SSB modes (USB/LSB) and if mode is not locked
            # Skip auto-switching when tuning from bookmarks (they have their own mode)
            # Also skip if rig control is active with Rig→SDR direction (external software controls mode)
            rig_controls_mode = (self.radio_control_connected and
                                self.radio_sync_direction_var.get() == "Rig→SDR")

            if not skip_auto_mode and not self.mode_lock_var.get() and not rig_controls_mode:
                current_mode = self.mode_var.get().upper()
                if current_mode in ['USB', 'LSB']:
                    if freq_hz < 10000000 and current_mode != 'LSB':
                        # Below 10 MHz, use LSB
                        self.mode_var.set('LSB')
                        self.on_mode_changed()
                        self.log_status(f"Auto-switched to LSB (< 10 MHz)")
                    elif freq_hz >= 10000000 and current_mode != 'USB':
                        # 10 MHz and above, use USB
                        self.mode_var.set('USB')
                        self.on_mode_changed()
                        self.log_status(f"Auto-switched to USB (≥ 10 MHz)")

            # Update spectrum display center frequency (also sets tuned frequency)
            if self.spectrum:
                self.spectrum.update_center_frequency(freq_hz)

            # Update waterfall display if open
            if self.waterfall_display:
                self.waterfall_display.update_center_frequency(freq_hz)

            # Update waterfall window's spectrum if open
            if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
                self.waterfall_spectrum.update_center_frequency(freq_hz)
            if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
                self.waterfall_waterfall.update_center_frequency(freq_hz)

            # Send tune message
            # self.log_status(f"Tuning to {freq_hz/1e6:.6f} MHz...")  # Removed: too verbose during rapid frequency changes
            self.send_tune_message()

            # Notify chat of frequency change
            self.notify_chat_radio_changed()

            # Sync to radio control if enabled
            if self.radio_control_sync_enabled:
                self.sync_frequency_to_radio_control()

            # Sync to TCI Server if active (but don't create feedback loop)
            if self.radio_control_type == 'tci_server' and self.radio_control:
                # Pass skip_callback=True to prevent feedback loop
                self.radio_control.update_frequency(freq_hz, skip_callback=True)
        except ValueError as e:
            messagebox.showerror("Error", f"Invalid frequency: {e}")

    def _parse_mode_name(self, mode_display: str) -> str:
        """Parse mode display name to actual mode name.

        Args:
            mode_display: Display name from dropdown (e.g., "IQ (48 kHz)" or "USB")

        Returns:
            Actual mode name for server (e.g., "iq48" or "usb")
        """
        # Extract actual mode name (handle both "IQ48" and "IQ (48 kHz)" formats)
        if '(' in mode_display:
            mode = mode_display.split()[0].lower()  # "IQ (48 kHz)" -> "iq"
            # Map display format to actual mode
            if '48' in mode_display:
                mode = 'iq48'
            elif '96' in mode_display:
                mode = 'iq96'
            elif '192' in mode_display:
                mode = 'iq192'
            elif '384' in mode_display:
                mode = 'iq384'
        else:
            mode = mode_display.lower()
        return mode

    def select_mode(self, mode_value: str):
        """Handle mode button click."""
        # Update mode variable
        self.mode_var.set(mode_value)

        # Update button states
        self.update_mode_buttons()

        # Trigger mode change handler
        self.on_mode_changed()

    def update_mode_buttons(self):
        """Update mode button styles based on current selection."""
        current_mode = self.mode_var.get().upper()

        for mode_value, button in self.mode_buttons.items():
            is_active = mode_value.upper() == current_mode

            # Apply style based on button type (tk.Button on Windows, ttk.Button on Linux)
            if platform.system() == 'Windows':
                # tk.Button: use bg, fg
                if is_active:
                    button.configure(bg='#16a34a', fg='white')  # Darker green for active
                else:
                    button.configure(bg='#22c55e', fg='white')  # Normal green
            else:
                # ttk.Button: use style
                if is_active:
                    button.configure(style='ModeActive.TButton')
                else:
                    button.configure(style='Mode.TButton')

            # Force widget update on Windows
            if platform.system() == 'Windows':
                button.update_idletasks()

    def on_mode_changed(self, skip_apply=False):
        """Handle mode change - updates bandwidth and presets immediately."""
        mode_display = self.mode_var.get()
        mode = self._parse_mode_name(mode_display)

        # Update mode button styles
        self.update_mode_buttons()

        # Update bookmark selector when mode changes (bookmarks match freq + mode)
        try:
            freq_hz = self.get_frequency_hz()
            self.update_bookmark_selector(freq_hz)
        except ValueError:
            pass  # Ignore if frequency is invalid

        # Disable audio filter only if mode actually changed (silently, without validation)
        # because bandwidth ranges change and filter settings may become invalid
        if self.last_mode is not None and self.last_mode != mode:
            if self.audio_filter_enabled_var.get():
                self.audio_filter_enabled_var.set(False)
                # Disable directly in client without calling toggle_audio_filter
                if self.client:
                    self.client.audio_filter_enabled = False
                # Update audio spectrum display
                if self.audio_spectrum_display:
                    self.audio_spectrum_display.update_audio_filter(False,
                        int(self.audio_filter_low_var.get()),
                        int(self.audio_filter_high_var.get()))
                self.log_status("Audio filter disabled (mode changed)")

        # Check if this is an IQ mode
        is_iq_mode = mode in ['iq', 'iq48', 'iq96', 'iq192', 'iq384']

        # Update last mode
        self.last_mode = mode

        if is_iq_mode:
            # IQ mode: mute audio and disable audio controls
            self.volume_var.set(0)
            self.volume_scale.config(state='disabled')
            self.volume_label.config(text="Muted")

            # Disable channel checkboxes
            self.left_check.config(state='disabled')
            self.right_check.config(state='disabled')

            # Disable EQ
            if self.eq_display and self.eq_display.is_enabled():
                self.eq_display.enabled_var.set(False)
                self.eq_display.on_enable_changed()
            if self.eq_btn:
                self.eq_btn.config(state='disabled')

            # Disable NR2
            if self.nr2_enabled_var.get():
                self.nr2_enabled_var.set(False)
                self.toggle_nr2()
            self.nr2_check.config(state='disabled')

            # Disable audio filter (silently, without validation)
            if self.audio_filter_enabled_var.get():
                self.audio_filter_enabled_var.set(False)
                # Disable directly in client without calling toggle_audio_filter
                if self.client:
                    self.client.audio_filter_enabled = False
                # Update audio spectrum display
                if self.audio_spectrum_display:
                    self.audio_spectrum_display.update_audio_filter(False,
                        int(self.audio_filter_low_var.get()),
                        int(self.audio_filter_high_var.get()))
                self.log_status("Audio filter disabled (IQ mode)")
            self.filter_check.config(state='disabled')

            # Disable recording
            if self.recording:
                self.stop_recording()
            self.rec_btn.config(state='disabled')

            # Close audio spectrum window if open and disable button
            if self.audio_spectrum_window and self.audio_spectrum_window.winfo_exists():
                self.audio_spectrum_window.destroy()
                self.audio_spectrum_window = None
                self.audio_spectrum_display = None
                self.log_status("Audio spectrum window closed (IQ mode)")

            # Disable audio spectrum button
            if self.audio_spectrum_btn:
                self.audio_spectrum_btn.config(state='disabled')

            # Disable Opus (not supported for IQ modes)
            # Save current state before disabling
            if not hasattr(self, '_opus_saved_state'):
                self._opus_saved_state = self.opus_var.get()
            if self.opus_var.get():
                self.opus_var.set(False)
                # Warn if connected with Opus - IQ won't work
                if self.connected and self.client and self.client.use_opus:
                    self.log_status("⚠ IQ mode requires pcm-zstd format - please disconnect and reconnect")
                    messagebox.showwarning("Reconnection Required",
                                         "IQ modes require lossless pcm-zstd format.\n\n"
                                         "You are currently connected with Opus compression.\n\n"
                                         "Please disconnect and reconnect to use IQ modes properly.")
            self.opus_check.config(state='disabled')

            self.log_status(f"IQ mode selected - audio output disabled (data still sent to FIFO)")
        else:
            # Non-IQ mode: re-enable audio controls
            self.volume_scale.config(state='normal')

            # Re-enable audio controls for non-IQ modes
            if self.volume_var.get() == 0:
                self.volume_var.set(70)
            self.volume_label.config(text=f"{self.volume_var.get()}%")

            # Re-enable channel checkboxes
            self.left_check.config(state='normal')
            self.right_check.config(state='normal')

            # Re-enable EQ button
            if self.eq_btn:
                self.eq_btn.config(state='normal')

            # Re-enable NR2 checkbox
            self.nr2_check.config(state='normal')

            # Re-enable audio filter checkbox
            self.filter_check.config(state='normal')

            # Re-enable recording if connected
            if self.connected:
                self.rec_btn.config(state='normal')

            # Re-enable audio spectrum button
            if self.audio_spectrum_btn:
                self.audio_spectrum_btn.config(state='normal')

            # Re-enable Opus checkbox and restore previous state
            self.opus_check.config(state='normal')
            # Restore saved Opus state if it was saved
            if hasattr(self, '_opus_saved_state'):
                saved_state = self._opus_saved_state
                self.opus_var.set(saved_state)
                delattr(self, '_opus_saved_state')
                if saved_state and self.connected and self.client and not self.client.use_opus:
                    self.log_status("⚠ Opus enabled - please disconnect and reconnect to activate")

        # Always update bandwidth defaults and presets when mode changes
        self.adjust_bandwidth_for_mode(mode)
        self.update_preset_buttons()

        # Update audio filter slider ranges based on mode bandwidth
        self.update_audio_filter_ranges()

        # Update spectrum display with new mode (critical for IQ mode bandwidth display)
        if self.spectrum:
            low = int(self.bw_low_var.get())
            high = int(self.bw_high_var.get())
            self.spectrum.update_bandwidth(low, high, mode)

        # Update waterfall display with new mode
        if self.waterfall_display:
            low = int(self.bw_low_var.get())
            high = int(self.bw_high_var.get())
            self.waterfall_display.update_bandwidth(low, high, mode)

        # Update audio spectrum display with new mode
        if self.audio_spectrum_display:
            low = int(self.bw_low_var.get())
            high = int(self.bw_high_var.get())
            self.audio_spectrum_display.update_bandwidth(low, high, mode)

        # Update waterfall window's spectrum and waterfall with new mode
        if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
            low = int(self.bw_low_var.get())
            high = int(self.bw_high_var.get())
            self.waterfall_spectrum.update_bandwidth(low, high, mode)
        if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
            low = int(self.bw_low_var.get())
            high = int(self.bw_high_var.get())
            self.waterfall_waterfall.update_bandwidth(low, high, mode)

        # If connected, also apply the change to the client (unless skip_apply is True)
        if self.connected and self.client and not skip_apply:
            self.apply_mode()

        # Sync mode to radio control if enabled and direction is SDR→Rig
        if self.radio_control_sync_enabled and self.radio_sync_direction_var.get() == "SDR→Rig":
            self.sync_mode_to_radio_control()

    def on_radio_control_type_changed(self):
        """Handle radio control type change - show/hide appropriate controls."""
        control_type = self.radio_control_type_var.get()

        # First, hide ALL controls
        self.radio_host_label.pack_forget()
        self.radio_host_entry.pack_forget()
        self.radio_port_label.pack_forget()
        self.radio_port_entry.pack_forget()
        self.radio_vfo_label.pack_forget()
        self.radio_vfo_combo.pack_forget()
        self.omnirig_rig_label.pack_forget()
        self.omnirig_rig_combo.pack_forget()
        self.serial_port_label.pack_forget()
        self.serial_port_combo.pack_forget()
        self.serial_refresh_btn.pack_forget()
        self.tci_server_port_label.pack_forget()
        self.tci_server_port_entry.pack_forget()
        self.tci_client_ip_label.pack_forget()
        self.tci_client_host_label.pack_forget()
        self.tci_client_host_entry.pack_forget()
        self.tci_client_port_label.pack_forget()
        self.tci_client_port_entry.pack_forget()
        self.radio_sdr_to_rig_radio.pack_forget()
        self.radio_rig_to_sdr_radio.pack_forget()
        self.radio_mute_tx_check.pack_forget()

        # Update button text based on control type
        if control_type in ('Serial', 'TCI Server'):
            # Serial and TCI Server are servers, so use "Start" instead of "Connect"
            if not self.radio_control_connected:
                self.radio_connect_btn.config(text="Start")
        else:
            # Other types are clients, so use "Connect"
            if not self.radio_control_connected:
                self.radio_connect_btn.config(text="Connect")

        # Now show only the controls needed for the selected type
        if control_type == 'rigctl':
            # Show rigctl controls (host, port)
            self.radio_host_label.pack(side=tk.LEFT, padx=(5, 5))
            self.radio_host_entry.pack(side=tk.LEFT, padx=(0, 5))
            self.radio_port_label.pack(side=tk.LEFT, padx=(0, 5))
            self.radio_port_entry.pack(side=tk.LEFT, padx=(0, 5))
            # Update default port for rigctl
            if not self.radio_port_var.get() or self.radio_port_var.get() == '12345':
                self.radio_port_var.set('4532')
            # Show sync direction and Mute TX
            self.radio_sdr_to_rig_radio.pack(side=tk.LEFT, padx=(0, 5))
            self.radio_rig_to_sdr_radio.pack(side=tk.LEFT, padx=(0, 10))
            self.radio_mute_tx_check.pack(side=tk.LEFT)
        elif control_type == 'flrig':
            # Show flrig controls (host, port, VFO)
            self.radio_host_label.pack(side=tk.LEFT, padx=(5, 5))
            self.radio_host_entry.pack(side=tk.LEFT, padx=(0, 5))
            self.radio_port_label.pack(side=tk.LEFT, padx=(0, 5))
            self.radio_port_entry.pack(side=tk.LEFT, padx=(0, 5))
            self.radio_vfo_label.pack(side=tk.LEFT, padx=(5, 5))
            self.radio_vfo_combo.pack(side=tk.LEFT, padx=(0, 5))
            # Update default port for flrig
            if not self.radio_port_var.get() or self.radio_port_var.get() == '4532':
                self.radio_port_var.set('12345')
            # Show sync direction and Mute TX
            self.radio_sdr_to_rig_radio.pack(side=tk.LEFT, padx=(0, 5))
            self.radio_rig_to_sdr_radio.pack(side=tk.LEFT, padx=(0, 10))
            self.radio_mute_tx_check.pack(side=tk.LEFT)
        elif control_type == 'OmniRig':
            # Show OmniRig controls (rig number, VFO)
            self.omnirig_rig_label.pack(side=tk.LEFT, padx=(5, 5))
            self.omnirig_rig_combo.pack(side=tk.LEFT, padx=(0, 5))
            self.radio_vfo_label.pack(side=tk.LEFT, padx=(5, 5))
            self.radio_vfo_combo.pack(side=tk.LEFT, padx=(0, 5))
            # Show sync direction and Mute TX
            self.radio_sdr_to_rig_radio.pack(side=tk.LEFT, padx=(0, 5))
            self.radio_rig_to_sdr_radio.pack(side=tk.LEFT, padx=(0, 10))
            self.radio_mute_tx_check.pack(side=tk.LEFT)
        elif control_type == 'Serial':
            # Show Serial controls (port selector only)
            self.serial_port_label.pack(side=tk.LEFT, padx=(5, 5))
            self.serial_port_combo.pack(side=tk.LEFT, padx=(0, 5))
            self.serial_refresh_btn.pack(side=tk.LEFT, padx=(0, 5))
            # Set sync direction to Rig→SDR for Serial mode (no UI controls shown)
            self.radio_sync_direction_var.set("Rig→SDR")
            # Refresh serial ports list
            self.refresh_serial_ports()
        elif control_type == 'TCI Server':
            # Show TCI Server controls (port only)
            self.tci_server_port_label.pack(side=tk.LEFT, padx=(5, 5))
            self.tci_server_port_entry.pack(side=tk.LEFT, padx=(0, 5))
            # Show the client IP label (will be empty until client connects)
            self.tci_client_ip_label.pack(side=tk.LEFT, padx=(5, 5))
            # Set sync direction to Rig→SDR for TCI Server mode (no UI controls shown)
            self.radio_sync_direction_var.set("Rig→SDR")
        elif control_type == 'TCI Client':
            # Show TCI Client controls (host and port)
            self.tci_client_host_label.pack(side=tk.LEFT, padx=(5, 5))
            self.tci_client_host_entry.pack(side=tk.LEFT, padx=(0, 5))
            self.tci_client_port_label.pack(side=tk.LEFT, padx=(0, 5))
            self.tci_client_port_entry.pack(side=tk.LEFT, padx=(0, 5))
            # Show sync direction, Mute TX, and Spots checkbox
            self.radio_sdr_to_rig_radio.pack(side=tk.LEFT, padx=(0, 5))
            self.radio_rig_to_sdr_radio.pack(side=tk.LEFT, padx=(0, 10))
            self.radio_mute_tx_check.pack(side=tk.LEFT, padx=(0, 5))
            self.tci_client_spots_check.pack(side=tk.LEFT)
        # else: None - all controls already hidden above

    def on_radio_vfo_changed(self):
        """Handle VFO selection change for flrig, OmniRig, or Serial."""
        if self.radio_control_connected and self.radio_control:
            vfo = self.radio_vfo_var.get()
            if hasattr(self.radio_control, 'set_vfo'):
                self.radio_control.set_vfo(vfo)
                self.log_status(f"Switched to VFO-{vfo}")

    def on_omnirig_vfo_changed(self):
        """Handle VFO selection change for OmniRig (legacy wrapper)."""
        self.on_radio_vfo_changed()

    def refresh_serial_ports(self):
        """Refresh the list of available serial ports."""
        if not SERIAL_CAT_AVAILABLE:
            self.serial_port_combo['values'] = []
            return

        try:
            ports = list_serial_ports()
            self.serial_port_combo['values'] = ports

            # Keep current selection if it's still valid
            current = self.serial_port_var.get()
            if current not in ports and ports:
                self.serial_port_var.set(ports[0])
            elif not ports:
                self.serial_port_var.set('')

            self.log_status(f"Found {len(ports)} serial port(s)")
        except Exception as e:
            self.log_status(f"Error refreshing serial ports: {e}")
            self.serial_port_combo['values'] = []

    def toggle_radio_control_connection(self):
        """Connect or disconnect from radio control (rigctl or OmniRig)."""
        if not self.radio_control_connected:
            self.connect_radio_control()
        else:
            self.disconnect_radio_control()

    def connect_radio_control(self):
        """Connect to radio control (rigctl or OmniRig)."""
        control_type = self.radio_control_type_var.get()

        self.log_status(f"DEBUG: connect_radio_control called, type={control_type}")

        if control_type == 'None':
            messagebox.showinfo("Info", "Please select a radio control type")
            return

        try:
            if control_type == 'rigctl':
                # Connect to rigctl
                host = self.radio_host_var.get().strip()
                port_str = self.radio_port_var.get().strip()

                if not host or not port_str:
                    messagebox.showerror("Error", "Please enter rigctl host and port")
                    return

                try:
                    port = int(port_str)
                except ValueError:
                    messagebox.showerror("Error", "Invalid port number")
                    return

                # Create and connect threaded rigctl client
                self.radio_control = ThreadedRigctlClient(host, port)
                self.radio_control_type = 'rigctl'

                # Set up callbacks
                self.radio_control.set_callbacks(
                    frequency_callback=self.on_radio_control_frequency_changed,
                    mode_callback=self.on_radio_control_mode_changed,
                    ptt_callback=self.on_radio_control_ptt_changed,
                    error_callback=lambda err: self.log_status(f"Radio control error: {err}")
                )

                self.radio_control.connect()
                self.log_status(f"✓ Connected to rigctld at {host}:{port}")

            elif control_type == 'flrig':
                # Connect to flrig
                host = self.radio_host_var.get().strip()
                port_str = self.radio_port_var.get().strip()
                vfo = self.radio_vfo_var.get()

                if not host or not port_str:
                    messagebox.showerror("Error", "Please enter flrig host and port")
                    return

                try:
                    port = int(port_str)
                except ValueError:
                    messagebox.showerror("Error", "Invalid port number")
                    return

                # Create and connect threaded flrig client
                self.radio_control = ThreadedFlrigClient(host, port, vfo)
                self.radio_control_type = 'flrig'

                # Set up callbacks
                self.radio_control.set_callbacks(
                    frequency_callback=self.on_radio_control_frequency_changed,
                    mode_callback=self.on_radio_control_mode_changed,
                    ptt_callback=self.on_radio_control_ptt_changed,
                    error_callback=lambda err: self.log_status(f"flrig: {err}")
                )

                self.radio_control.connect()
                self.log_status(f"✓ Connected to flrig at {host}:{port} VFO-{vfo}")

            elif control_type == 'OmniRig':
                # Connect to OmniRig
                rig_num = int(self.omnirig_rig_var.get())
                vfo = self.radio_vfo_var.get()

                self.log_status(f"DEBUG: Creating OmniRig client Rig{rig_num} VFO-{vfo}")

                # Create and connect OmniRig client with VFO selection
                self.radio_control = ThreadedOmniRigClient(rig_num, vfo)
                self.radio_control_type = 'omnirig'

                self.log_status(f"DEBUG: Setting up callbacks")

                # Set up callbacks
                self.radio_control.set_callbacks(
                    frequency_callback=self.on_radio_control_frequency_changed,
                    mode_callback=self.on_radio_control_mode_changed,
                    ptt_callback=self.on_radio_control_ptt_changed,
                    error_callback=lambda err: self.log_status(f"OmniRig: {err}")
                )

                self.log_status(f"DEBUG: Calling connect()")
                success = self.radio_control.connect()
                self.log_status(f"DEBUG: connect() returned {success}")

                if not success:
                    self.log_status("ERROR: OmniRig connection failed")
                    return

                self.log_status(f"✓ Connected to OmniRig Rig{rig_num} VFO-{vfo}")

            elif control_type == 'Serial':
                # Start Serial CAT Server
                port = self.serial_port_var.get().strip()

                if not port:
                    messagebox.showerror("Error", "Please select a serial port")
                    return

                # Create and start Serial CAT server
                self.radio_control = SerialCATServer(port, self)
                self.radio_control_type = 'serial_cat'

                try:
                    self.radio_control.start()
                    self.log_status(f"✓ Serial CAT server started on {port} (emulating Kenwood TS-480)")
                    # Show success dialog
                    messagebox.showinfo("Serial CAT Server Started",
                                      f"UberSDR is now acting as a Kenwood TS-480 on {port}\n\n"
                                      f"Configure your external software (e.g., WSJT-X) to use:\n"
                                      f"• Rig: Kenwood TS-480\n"
                                      f"• Serial Port: {port}\n"
                                      f"• Baud Rate: 57600")
                except ConnectionError as e:
                    messagebox.showerror("Error", str(e))
                    self.log_status(f"ERROR: Failed to start Serial CAT server - {e}")
                    self.radio_control = None
                    return

            elif control_type == 'TCI Server':
                # Start TCI Server
                if not self.client:
                    messagebox.showerror("Error", "Please connect to SDR first before starting TCI server")
                    return

                port_str = self.tci_server_port_var.get().strip()
                if not port_str:
                    messagebox.showerror("Error", "Please enter a TCI server port")
                    return

                try:
                    port = int(port_str)
                except ValueError:
                    messagebox.showerror("Error", "Invalid port number")
                    return

                # Create GUI callback for TCI server
                def tci_gui_callback(param_type, value):
                    """Handle TCI server callbacks to update GUI."""
                    if param_type == 'frequency':
                        # Update frequency from TCI client
                        self.root.after(0, lambda: self._apply_tci_frequency(value))
                    elif param_type == 'mode':
                        # Update mode from TCI client
                        self.root.after(0, lambda: self._apply_tci_mode(value))

                # Ensure DXCluster WebSocket manager exists for spot injection
                try:
                    websocket_manager = self._ensure_dxcluster_ws()
                except Exception as e:
                    self.log_status(f"Warning: Could not create WebSocket manager for TCI spots: {e}")
                    websocket_manager = None

                # Create and start TCI server with GUI callback and WebSocket manager for spot injection
                self.radio_control = TCIServer(self.client, port=port, gui_callback=tci_gui_callback, websocket_manager=websocket_manager)
                self.radio_control_type = 'tci_server'

                # Attach TCI server to client for audio forwarding
                self.client.tci_server = self.radio_control

                # Link spectrum display for S-meter updates
                if self.spectrum:
                    self.radio_control.set_spectrum_display(self.spectrum)
                    self.log_status("✓ TCI server linked to RF spectrum display")

                # Try to start TCI server
                if not self.radio_control.start():
                    # Server failed to start (port in use or other error)
                    error_msg = "Failed to start TCI server"
                    if self.radio_control.start_error:
                        import errno
                        if isinstance(self.radio_control.start_error, OSError) and self.radio_control.start_error.errno == errno.EADDRINUSE:
                            error_msg = f"Port {port} is already in use"
                        else:
                            error_msg = f"Failed to start TCI server: {self.radio_control.start_error}"

                    messagebox.showerror("TCI Server Error", error_msg)
                    self.log_status(f"✗ {error_msg}")
                    self.radio_control = None
                    return

                # Server started successfully
                self.log_status(f"✓ TCI server started successfully")
                self.log_status(f"✓ TCI server listening on ws://0.0.0.0:{port}")
                self.log_status(f"✓ TCI clients can now connect to this server")
                # Show success dialog
                messagebox.showinfo("TCI Server Started",
                                  f"UberSDR is now acting as a TCI-compatible radio\n\n"
                                  f"Configure your application to use:\n"
                                  f"• Radio: TCI\n"
                                  f"• Server: 127.0.0.1\n"
                                  f"• Port: {port}\n\n"
                                  f"The TCI server will forward frequency/mode changes\n"
                                  f"and stream demodulated audio.")

            elif control_type == 'TCI Client':
                # Connect to TCI Client
                host = self.tci_client_host_var.get().strip()
                port_str = self.tci_client_port_var.get().strip()

                if not host or not port_str:
                    messagebox.showerror("Error", "Please enter TCI server host and port")
                    return

                try:
                    port = int(port_str)
                except ValueError:
                    messagebox.showerror("Error", "Invalid port number")
                    return

                # Create and connect threaded TCI client
                self.radio_control = ThreadedTCIClient(host, port)
                self.radio_control_type = 'tci_client'

                # Set up callbacks
                self.radio_control.set_callbacks(
                    frequency_callback=self.on_radio_control_frequency_changed,
                    mode_callback=self.on_radio_control_mode_changed,
                    ptt_callback=self.on_radio_control_ptt_changed,
                    error_callback=lambda err: self.log_status(f"TCI client: {err}")
                )

                self.radio_control.connect()
                self.log_status(f"✓ Connected to TCI server at {host}:{port}")

                # Register CW spot callback if Spots checkbox is enabled
                if self.tci_client_spots_var.get():
                    self._register_tci_client_spot_callback()

            # Update state BEFORE starting periodic updates
            self.radio_control_connected = True
            # Use "Stop" for servers (Serial, TCI Server), "Disconnect" for clients
            if control_type in ('Serial', 'TCI Server'):
                self.radio_connect_btn.config(text="Stop")
            else:
                self.radio_connect_btn.config(text="Disconnect")

            # Notify chat of CAT status change (icon will appear)
            self.notify_chat_radio_changed()

            # Start periodic updates AFTER setting connected state
            if self.radio_control_type == 'tci_server':
                # Start periodic S-meter updates (250ms interval)
                self.update_tci_smeter()

                # Start periodic client IP display updates (1 second interval)
                self.update_tci_client_ip()

                # Show CW Spots button when TCI connects (if not already shown)
                if self.cw_spots_btn and self.connected:
                    # Find the button frame and scroll label
                    button_frame = self.cw_spots_btn.master
                    if button_frame:
                        scroll_label = None
                        for widget in button_frame.winfo_children():
                            if isinstance(widget, ttk.Label) and widget.cget('text') == 'Scroll:':
                                scroll_label = widget
                                break

                        # Pack CW spots button if not already packed
                        if scroll_label:
                            self.cw_spots_btn.pack(side=tk.LEFT, padx=(0, 5), before=scroll_label)
                        else:
                            self.cw_spots_btn.pack(side=tk.LEFT, padx=(0, 5))
                        self.log_status("CW Spots button enabled (TCI can report spots)")

            # Disable serial port dropdown and refresh button when connected (for Serial type)
            if control_type == 'Serial':
                self.serial_port_combo.config(state='disabled')
                self.serial_refresh_btn.config(state='disabled')

            # Disable TCI Server port entry when connected
            if control_type == 'TCI Server':
                self.tci_server_port_entry.config(state='disabled')

            # Disable TCI Client host/port entries when connected
            if control_type == 'TCI Client':
                self.tci_client_host_entry.config(state='disabled')
                self.tci_client_port_entry.config(state='disabled')

            # Update legacy aliases
            self.rigctl = self.radio_control
            self.rigctl_connected = self.radio_control_connected

            # Serial CAT server and TCI Server are passive - they don't need polling or sync
            # External software polls the servers, which read current state from radio_gui
            # TCI Client needs polling like other clients
            if control_type not in ('Serial', 'TCI Server'):
                # Initialize PTT state for non-Serial modes
                self.radio_control_last_ptt = False
                self.radio_mute_tx_check.configure(style='MuteTX.Green.TCheckbutton')

                # CRITICAL: Start polling FIRST (required for OmniRig to process events)
                if not self.radio_control_poll_job:
                    self.log_status("DEBUG: Starting radio control polling...")
                    self.poll_radio_control_frequency()

                # Then enable sync with selected direction
                self.log_status("DEBUG: Enabling radio control sync...")
                self.start_radio_control_sync()

        except Exception as e:
            messagebox.showerror("Error", f"Failed to connect to radio control: {e}")
            self.log_status(f"ERROR: Failed to connect to radio control - {e}")
            if self.radio_control:
                # Serial CAT server uses stop() instead of disconnect()
                if self.radio_control_type == 'serial_cat':
                    self.radio_control.stop()
                else:
                    self.radio_control.disconnect()

    def disconnect_radio_control(self):
        """Disconnect from radio control."""
        if self.radio_control:
            # Serial CAT server and TCI Server use stop() instead of disconnect()
            if self.radio_control_type == 'serial_cat':
                self.radio_control.stop()
                # Re-enable serial port dropdown and refresh button
                self.serial_port_combo.config(state='readonly')
                self.serial_refresh_btn.config(state='normal')
            elif self.radio_control_type == 'tci_server':
                self.radio_control.stop()
                # Re-enable TCI Server port entry
                self.tci_server_port_entry.config(state='normal')
                # Clear client IP display
                self.tci_client_ip_var.set("")

                # Hide CW Spots button when TCI Server disconnects (unless server has CW Skimmer)
                if self.cw_spots_btn and self.connected and self.client:
                    if hasattr(self.client, 'server_description'):
                        desc = self.client.server_description
                        # Only hide if server doesn't have CW Skimmer
                        if not desc.get('cw_skimmer', False):
                            self.cw_spots_btn.pack_forget()
                            self.log_status("CW Spots button disabled (TCI Server disconnected)")
            elif self.radio_control_type == 'tci_client':
                # Unregister CW spot callback if it was registered
                if self.tci_client_spot_callback_registered:
                    self._unregister_tci_client_spot_callback()

                self.radio_control.disconnect()
                # Re-enable TCI Client host/port entries
                self.tci_client_host_entry.config(state='normal')
                self.tci_client_port_entry.config(state='normal')
            else:
                self.radio_control.disconnect()
            self.radio_control = None

        self.radio_control_connected = False
        self.radio_control_sync_enabled = False
        self.radio_control_type = 'none'

        # Notify chat of CAT status change (icon will be removed)
        self.notify_chat_radio_changed()

        # Update legacy aliases
        self.rigctl = None
        self.rigctl_connected = False
        self.rigctl_sync_enabled = False

        # Stop polling if active
        if self.radio_control_poll_job:
            self.root.after_cancel(self.radio_control_poll_job)
            self.radio_control_poll_job = None

        # Use "Start" for servers (Serial, TCI Server), "Connect" for clients
        control_type = self.radio_control_type_var.get()
        if control_type in ('Serial', 'TCI Server'):
            self.radio_connect_btn.config(text="Start")
        else:
            self.radio_connect_btn.config(text="Connect")
        self.log_status("Disconnected from radio control")

    def on_radio_control_frequency_changed(self, freq_hz: int):
        """Callback when radio control frequency changes (called from worker thread)."""
        # Check if frequency actually changed
        if self.radio_control_last_freq is not None and freq_hz != self.radio_control_last_freq:
            # Only sync if direction is Rig→SDR and sync is enabled
            if self.radio_control_sync_enabled and self.radio_sync_direction_var.get() == "Rig→SDR":
                # Schedule GUI update in main thread
                self.root.after(0, lambda: self._apply_radio_control_frequency(freq_hz))

        self.radio_control_last_freq = freq_hz
        # Update legacy alias
        self.rigctl_last_freq = freq_hz

    def on_radio_control_mode_changed(self, mode: str):
        """Callback when radio control mode changes (called from worker thread)."""
        # Check if mode actually changed
        if self.radio_control_last_mode is not None and mode != self.radio_control_last_mode:
            # Only sync if direction is Rig→SDR and sync is enabled
            if self.radio_control_sync_enabled and self.radio_sync_direction_var.get() == "Rig→SDR":
                # Schedule GUI update in main thread
                self.root.after(0, lambda: self._apply_radio_control_mode(mode))

        self.radio_control_last_mode = mode
        # Update legacy alias
        self.rigctl_last_mode = mode

    def on_radio_control_ptt_changed(self, ptt_state: bool):
        """Callback when radio control PTT changes (called from worker thread).

        PTT detection works in both sync directions for audio muting.
        """
        # Check if PTT state actually changed
        if ptt_state != self.radio_control_last_ptt:
            # Schedule GUI update in main thread (always, regardless of sync direction)
            self.root.after(0, lambda: self._apply_radio_control_ptt(ptt_state))

        self.radio_control_last_ptt = ptt_state
        # Update legacy alias
        self.rigctl_last_ptt = ptt_state

    def _apply_radio_control_frequency(self, freq_hz: int):
        """Apply frequency change from radio (runs in main thread)."""
        # Check if frequency is locked
        if self.freq_lock_var.get():
            self.log_status("Frequency is locked - radio control change blocked")
            return

        self.set_frequency_hz(freq_hz)
        if self.connected:
            self.apply_frequency()
        self.log_status(f"Synced from radio: {freq_hz/1e6:.6f} MHz")

    def _apply_radio_control_mode(self, rig_mode: str):
        """Apply mode change from radio (runs in main thread)."""
        # Map radio mode to SDR mode
        mode_map = {
            'USB': 'USB',
            'LSB': 'LSB',
            'AM': 'AM',
            'CW': 'CWU',  # Default to CWU
            'CWR': 'CWL',
            'FM': 'FM'
        }
        sdr_mode = mode_map.get(rig_mode, 'USB')

        # Only update if mode lock is not enabled
        if not self.mode_lock_var.get():
            self.mode_var.set(sdr_mode)
            self.on_mode_changed(skip_apply=True)
            if self.connected:
                self.apply_mode()
            self.log_status(f"Synced mode from radio: {rig_mode}")

    def _apply_radio_control_ptt(self, ptt_state: bool):
        """Apply PTT state change (runs in main thread)."""
        if ptt_state:
            # PTT activated
            self.radio_mute_tx_check.configure(style='MuteTX.Red.TCheckbutton')
            # Mute audio only if checkbox is enabled
            if self.radio_mute_tx_var.get() and self.client:
                # Save current channel states
                self.radio_control_saved_channels = (
                    self.channel_left_var.get(),
                    self.channel_right_var.get()
                )
                # Mute audio instantly
                self.channel_left_var.set(False)
                self.channel_right_var.set(False)
                self.client.channel_left = False
                self.client.channel_right = False
        else:
            # PTT deactivated
            self.radio_mute_tx_check.configure(style='MuteTX.Green.TCheckbutton')
            # Restore audio only if checkbox is enabled and we saved channel states
            if self.radio_mute_tx_var.get() and self.client and self.radio_control_saved_channels is not None:
                # Restore saved channel states
                left_state, right_state = self.radio_control_saved_channels
                self.channel_left_var.set(left_state)
                self.channel_right_var.set(right_state)
                self.client.channel_left = left_state
                self.client.channel_right = right_state
                self.radio_control_saved_channels = None

        # Notify chat of PTT state change (updates TX status in chat)
        self.notify_chat_radio_changed()

    def on_radio_sync_direction_changed(self):
        """Handle sync direction change - restart sync if active."""
        # Auto-save radio control settings when sync direction changes
        self.save_servers()

        if self.radio_control_sync_enabled:
            # Don't stop polling - just change direction
            direction = self.radio_sync_direction_var.get()
            if direction == "SDR→Rig":
                self.log_status("Radio sync direction changed - radio will follow SDR frequency")
                # Sync current SDR state to radio immediately
                self.sync_frequency_to_radio_control()
            else:  # Rig→SDR
                self.log_status("Radio sync direction changed - SDR will follow radio frequency")
                # Initialize last known values from cache
                self.radio_control_last_freq = self.radio_control.get_frequency()
                self.radio_control_last_mode = self.radio_control.get_mode()

    def start_radio_control_sync(self):
        """Start syncing frequency with radio control."""
        if not self.radio_control_connected or not self.radio_control:
            return

        self.radio_control_sync_enabled = True
        # Update legacy alias
        self.rigctl_sync_enabled = True

        direction = self.radio_sync_direction_var.get()

        if direction == "SDR→Rig":
            self.log_status("Radio sync enabled - radio will follow SDR frequency")
            # Immediately sync current SDR frequency to radio
            self.sync_frequency_to_radio_control()
        else:  # Rig→SDR
            self.log_status("Radio sync enabled - SDR will follow radio frequency")
            # Initialize last known values from cache
            self.radio_control_last_freq = self.radio_control.get_frequency()
            self.radio_control_last_mode = self.radio_control.get_mode()

        # Note: Polling is already running from connect_radio_control()
        # No need to start it here

    def stop_radio_control_sync(self):
        """Stop syncing frequency with radio control."""
        self.radio_control_sync_enabled = False
        # Update legacy alias
        self.rigctl_sync_enabled = False

        # Don't stop polling - we still need it for PTT detection
        # Polling continues but frequency/mode sync is disabled

        self.log_status("Radio sync disabled")

    def sync_frequency_to_radio_control(self):
        """Sync current SDR frequency to radio control."""
        if not self.radio_control_sync_enabled or not self.radio_control_connected or not self.radio_control:
            return

        # Only sync if direction is SDR→Rig
        if self.radio_sync_direction_var.get() != "SDR→Rig":
            return

        try:
            # Get current SDR frequency
            freq_hz = self.get_frequency_hz()

            # Queue frequency change (non-blocking)
            self.radio_control.set_frequency(freq_hz)

            # Get current mode and sync it too
            mode_display = self.mode_var.get()
            mode = self._parse_mode_name(mode_display)

            # Map SDR modes to radio control modes
            mode_map = {
                'usb': 'USB',
                'lsb': 'LSB',
                'am': 'AM',
                'sam': 'AM',
                'cwu': 'CW',
                'cwl': 'CW',
                'fm': 'FM',
                'nfm': 'FM'
            }

            radio_mode = mode_map.get(mode, 'USB')
            # Queue mode change (non-blocking)
            self.radio_control.set_mode(radio_mode)

        except Exception as e:
            self.log_status(f"Radio sync error: {e}")

    def sync_mode_to_radio_control(self):
        """Sync current SDR mode to radio control."""
        if not self.radio_control_sync_enabled or not self.radio_control_connected or not self.radio_control:
            return

        # Only sync if direction is SDR→Rig
        if self.radio_sync_direction_var.get() != "SDR→Rig":
            return

        try:
            # Get current mode
            mode_display = self.mode_var.get()
            mode = self._parse_mode_name(mode_display)

            # Map SDR modes to radio control modes
            mode_map = {
                'usb': 'USB',
                'lsb': 'LSB',
                'am': 'AM',
                'sam': 'AM',
                'cwu': 'CW',
                'cwl': 'CW',
                'fm': 'FM',
                'nfm': 'FM'
            }

            radio_mode = mode_map.get(mode, 'USB')
            # Queue mode change (non-blocking)
            self.radio_control.set_mode(radio_mode)

        except Exception as e:
            self.log_status(f"Radio mode sync error: {e}")

    def poll_radio_control_frequency(self):
        """Poll radio control for frequency/mode/PTT changes."""
        if not self.radio_control_connected or not self.radio_control:
            self.radio_control_poll_job = None
            # Update legacy alias
            self.rigctl_poll_job = None
            return

        # For OmniRig, poll() processes COM events and command queue
        # For rigctl, poll() just queues a poll command
        self.radio_control.poll()

        # Schedule next poll (20ms = 50 Hz for fast TX detection and COM event processing)
        self.radio_control_poll_job = self.root.after(20, self.poll_radio_control_frequency)
        # Update legacy alias
        self.rigctl_poll_job = self.radio_control_poll_job

    # Legacy method names for backward compatibility
    def toggle_rigctl_connection(self):
        """Connect or disconnect from rigctld (legacy wrapper)."""
        self.toggle_radio_control_connection()

    def connect_rigctl(self):
        """Connect to rigctld server (legacy wrapper)."""
        self.connect_radio_control()

    def disconnect_rigctl(self):
        """Disconnect from rigctld server (legacy wrapper)."""
        self.disconnect_radio_control()

    def on_rigctl_sync_direction_changed(self):
        """Handle sync direction change (legacy wrapper)."""
        self.on_radio_sync_direction_changed()

    def start_rigctl_sync(self):
        """Start syncing frequency with rigctld (legacy wrapper)."""
        self.start_radio_control_sync()

    def stop_rigctl_sync(self):
        """Stop syncing frequency with rigctld (legacy wrapper)."""
        self.stop_radio_control_sync()

    def sync_frequency_to_rigctl(self):
        """Sync current SDR frequency to rigctld (legacy wrapper)."""
        self.sync_frequency_to_radio_control()

    def sync_mode_to_rigctl(self):
        """Sync current SDR mode to rigctld (legacy wrapper)."""
        self.sync_mode_to_radio_control()

    def poll_rigctl_frequency(self):
        """Poll rigctl for frequency/mode/PTT changes (legacy wrapper)."""
        self.poll_radio_control_frequency()


    def apply_mode(self):
        """Apply mode change by sending tune message (called when connected)."""
        if not self.connected or not self.client:
            return

        mode_display = self.mode_var.get()
        mode = self._parse_mode_name(mode_display)

        # Check if switching from IQ mode to audio mode and re-enable Opus
        if self.client:
            old_mode = self.client.mode
            was_iq_mode = old_mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')
            is_iq_mode = mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')

            # Import OPUS_AVAILABLE from radio_client
            try:
                from radio_client import OPUS_AVAILABLE
                if was_iq_mode and not is_iq_mode and OPUS_AVAILABLE and not self.client.use_opus:
                    self.client.use_opus = True
                    self.log_status("⚠ Opus will be enabled on next connection")
                    messagebox.showinfo("Reconnection Required",
                                      "Opus compression will be enabled on your next connection.\n\n"
                                      "Please disconnect and reconnect to use Opus compression.")
            except ImportError:
                pass

        self.client.mode = mode

        # Reset NR2 learning when mode changes (noise profile will be different)
        if self.client.nr2_enabled and self.client.nr2_processor:
            self.client.nr2_processor.reset_learning()
            self.log_status("NR2 relearning noise profile (mode changed)")

        self.log_status(f"Switching to {mode.upper()} mode...")
        self.send_tune_message()

        # Notify chat of mode change
        self.notify_chat_radio_changed()

        # Sync mode to rigctl if enabled and direction is SDR→Rig
        if self.rigctl_sync_enabled and self.rigctl_sync_direction_var.get() == "SDR→Rig":
            self.sync_mode_to_rigctl()

        # Sync to TCI server if active (but don't create feedback loop)
        if self.radio_control_type == 'tci_server' and self.radio_control:
            # Set flag to prevent callback loop
            self._tci_updating = True
            self.radio_control.update_mode(mode)
            self._tci_updating = False

    def apply_bandwidth(self):
        """Apply bandwidth change by sending tune message."""
        if not self.connected or not self.client:
            return

        low = self.bw_low_var.get()
        high = self.bw_high_var.get()
        self.client.bandwidth_low = low
        self.client.bandwidth_high = high

        # Update spectrum display bandwidth visualization
        if self.spectrum:
            self.spectrum.update_bandwidth(low, high)

        # Update waterfall display if open
        if self.waterfall_display:
            self.waterfall_display.update_bandwidth(low, high)

        # Update audio spectrum display if open
        if self.audio_spectrum_display:
            self.audio_spectrum_display.update_bandwidth(low, high)

        # Update waterfall window's spectrum and waterfall if open
        if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
            self.waterfall_spectrum.update_bandwidth(low, high)
        if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
            self.waterfall_waterfall.update_bandwidth(low, high)

        self.log_status(f"Adjusting bandwidth to {low} to {high} Hz...")
        self.send_tune_message()

    def update_volume(self, value):
        """Update volume level."""
        volume = int(float(value))
        self.volume_label.config(text=f"{volume}%")

        # Apply volume to client if connected
        if self.client:
            # Convert percentage (0-100) to gain (0.0-2.0)
            # 100% = 1.0 gain, 200% = 2.0 gain
            self.client.volume = volume / 100.0

        # Auto-save volume setting
        self.save_audio_settings()

    def update_channels(self):
        """Update audio channel routing (Left/Right)."""
        left = self.channel_left_var.get()
        right = self.channel_right_var.get()

        # Apply channel selection to client if connected
        if self.client:
            self.client.channel_left = left
            self.client.channel_right = right

        # Log channel selection
        channels = []
        if left:
            channels.append("Left")
        if right:
            channels.append("Right")

        if channels:
            self.log_status(f"Audio output: {' + '.join(channels)}")
        else:
            self.log_status("Audio output: Muted (no channels selected)")

        # Auto-save channel settings
        self.save_audio_settings()

    def on_device_changed(self):
        """Handle audio device selection change."""
        # Auto-save device setting (silently)
        self.save_audio_settings()

    def refresh_devices(self):
        """Refresh the list of available audio output devices (PyAudio, PipeWire, or sounddevice)."""
        try:
            # Get output mode from config
            output_mode = self.config.get('output_mode', 'sounddevice')

            # Determine default device label with API info
            default_label = "(default)"
            if output_mode == 'sounddevice':
                try:
                    import sounddevice as sd
                    default_device_idx = sd.default.device[1]  # Output device
                    if default_device_idx is not None:
                        default_info = sd.query_devices(default_device_idx)
                        default_api = sd.query_hostapis(default_info['hostapi'])['name']
                        default_label = f"(default) [{default_api}]"
                except:
                    pass  # Fall back to simple "(default)" on error

            # Always include default as first option
            device_list = [default_label]

            if output_mode == 'pyaudio':
                # Use PyAudio device listing
                from radio_client import get_pyaudio_devices
                self.pyaudio_devices = get_pyaudio_devices()

                for device_index, device_name in self.pyaudio_devices:
                    device_list.append(f"{device_name}")
            elif output_mode == 'sounddevice':
                # Use sounddevice device listing
                from radio_client import get_sounddevice_devices
                # On Windows, filter to WASAPI only unless "All" checkbox is enabled
                wasapi_only = False
                if platform.system() == 'Windows' and self.show_all_devices_var is not None:
                    wasapi_only = not self.show_all_devices_var.get()
                self.sounddevice_devices = get_sounddevice_devices(wasapi_only=wasapi_only)

                for device_index, device_name in self.sounddevice_devices:
                    device_list.append(f"{device_name}")
            else:
                # Use PipeWire device listing
                from radio_client import get_pipewire_sinks
                self.pipewire_devices = get_pipewire_sinks()

                for node_name, description in self.pipewire_devices:
                    device_list.append(f"{description} ({node_name})")

            self.device_combo['values'] = device_list

            # Keep current selection if it's still valid
            current = self.device_var.get()
            if current not in device_list:
                self.device_var.set("(default)")
        except Exception as e:
            print(f"Error refreshing devices: {e}", file=sys.stderr)
            self.device_combo['values'] = ["(default)"]
            self.device_var.set("(default)")

    def get_selected_device(self) -> Optional[int]:
        """Get the selected device index, or None for default.

        Returns:
            Device index for PyAudio/sounddevice, or node name for PipeWire, or None for default device
        """
        selection = self.device_var.get()
        if selection == "(default)":
            return None

        # Get output mode from config
        output_mode = self.config.get('output_mode', 'sounddevice')

        if output_mode == 'pyaudio':
            # Extract device index from PyAudio device list
            if hasattr(self, 'pyaudio_devices'):
                for device_index, device_name in self.pyaudio_devices:
                    if device_name == selection:
                        return device_index
        elif output_mode == 'sounddevice':
            # Extract device index from sounddevice device list
            if hasattr(self, 'sounddevice_devices'):
                for device_index, device_name in self.sounddevice_devices:
                    if device_name == selection:
                        return device_index
        else:
            # For PipeWire, return node name (not used currently, but kept for compatibility)
            if hasattr(self, 'pipewire_devices'):
                for node_name, description in self.pipewire_devices:
                    if f"{description} ({node_name})" == selection:
                        # Return as string for PipeWire (would need different handling)
                        return node_name

        return None

    def update_audio_level(self):
        """Update audio level meter from actual audio data."""
        try:
            if self.connected:
                # Try to get latest audio level from queue
                level_db = None
                try:
                    # Drain queue to get most recent value
                    while True:
                        level_db = self.audio_level_queue.get_nowait()
                except queue.Empty:
                    pass

                if level_db is not None:
                    # Convert dB to percentage for display (range: -60 dB to 0 dB)
                    level_percent = max(0, min(100, (level_db + 60) / 60 * 100))

                    # Update meter bar
                    bar_width = int(150 * level_percent / 100)
                    self.level_canvas.coords(self.level_bar, 0, 0, bar_width, 20)

                    # Color based on level (green -> yellow -> red)
                    if level_percent < 70:
                        color = '#28a745'  # Green
                    elif level_percent < 90:
                        color = '#ffc107'  # Yellow
                    else:
                        color = '#dc3545'  # Red
                    self.level_canvas.itemconfig(self.level_bar, fill=color)

                    # Update label
                    self.level_label.config(text=f"{level_db:.1f} dB")
            else:
                # No audio when disconnected
                self.level_canvas.coords(self.level_bar, 0, 0, 0, 20)
                self.level_label.config(text="-∞ dB")
        except Exception:
            pass

        # Schedule next update (10 times per second)
        self.root.after(100, self.update_audio_level)

    def update_tci_smeter(self):
        """Update TCI S-meter from RF spectrum data (periodic callback)."""
        try:
            if self.radio_control_type == 'tci_server' and self.radio_control and self.connected:
                # Get current bandwidth for signal level calculation
                low = int(self.bw_low_var.get())
                high = int(self.bw_high_var.get())

                # Update signal level from spectrum
                self.radio_control.update_signal_level_from_spectrum(low, high)
        except Exception as e:
            # Silently ignore errors to avoid spamming logs
            pass

        # Schedule next update (250ms = 4 times per second)
        if self.radio_control_type == 'tci_server' and self.radio_control:
            self.root.after(250, self.update_tci_smeter)

    def update_tci_client_ip(self):
        """Update TCI client IP display (periodic callback)."""

        # Schedule next update FIRST so loop continues even when no client is connected yet
        if self.radio_control_type == 'tci_server' and self.radio_control_connected:
            self.root.after(1000, self.update_tci_client_ip)

        try:
            if self.radio_control_type == 'tci_server' and self.radio_control and self.radio_control_connected:
                # Get connected client IP from TCI server
                if hasattr(self.radio_control, 'connected_client_ip'):
                    client_ip = self.radio_control.connected_client_ip
                    if client_ip:
                        ip_text = f"Client: {client_ip}"
                        self.tci_client_ip_var.set(ip_text)
                    else:
                        self.tci_client_ip_var.set("")
                else:
                    self.tci_client_ip_var.set("")
        except Exception as e:
            # Log errors silently (don't spam console)
            import traceback
            traceback.print_exc()

    def _apply_tci_frequency(self, freq_hz: int):
        """Apply frequency change from TCI server (runs in main thread)."""
        # Check if frequency is locked
        if self.freq_lock_var.get():
            self.log_status("Frequency is locked - TCI change blocked")
            return

        self.log_status(f"TCI: Frequency change: {freq_hz/1e6:.6f} MHz")
        self.set_frequency_hz(freq_hz)
        if self.connected:
            self.apply_frequency()

    def _apply_tci_mode(self, mode: str):
        """Apply mode change from TCI server (runs in main thread)."""
        # Only update if mode lock is not enabled
        if not self.mode_lock_var.get():
            self.log_status(f"TCI: Mode change: {mode}")
            self.mode_var.set(mode)
            self.on_mode_changed(skip_apply=True)
            if self.connected:
                self.apply_mode()

    def _register_tci_client_spot_callback(self):
        """Register callback to forward CW spots to TCI Client."""
        if not self.dxcluster_ws:
            # Ensure DXCluster WebSocket manager exists
            try:
                self._ensure_dxcluster_ws()
            except Exception as e:
                self.log_status(f"Warning: Could not create WebSocket manager for TCI spot forwarding: {e}")
                return

        # Register CW spot callback
        self.dxcluster_ws.on_cw_spot(self._forward_cw_spot_to_tci)
        self.tci_client_spot_callback_registered = True
        self.log_status("✓ CW spot forwarding to TCI Client enabled")

    def _unregister_tci_client_spot_callback(self):
        """Unregister CW spot callback for TCI Client."""
        if self.dxcluster_ws and self.tci_client_spot_callback_registered:
            self.dxcluster_ws.remove_cw_spot_callback(self._forward_cw_spot_to_tci)
            self.tci_client_spot_callback_registered = False
            self.log_status("CW spot forwarding to TCI Client disabled")

    def _forward_cw_spot_to_tci(self, spot_data: dict):
        """Forward a CW spot to the TCI Client.

        Args:
            spot_data: Spot data dictionary from WebSocket
        """
        if not self.radio_control or self.radio_control_type != 'tci_client':
            return

        if not self.tci_client_spots_var.get():
            return

        try:
            # Extract spot data
            callsign = spot_data.get('dx_call', '')
            frequency = spot_data.get('frequency', 0)
            mode = 'cw'  # CW spots are always CW mode
            color = ''  # No color from UberSDR spots
            # Use comment if available, otherwise use SNR and WPM info
            comment = spot_data.get('comment', '')
            snr = spot_data.get('snr', 0)
            wpm = spot_data.get('wpm', 0)

            # Build text field with useful info
            text_parts = []
            if comment:
                text_parts.append(comment)
            if snr > 0:
                text_parts.append(f"{snr}dB")
            if wpm > 0:
                text_parts.append(f"{wpm}WPM")

            text = ' '.join(text_parts) if text_parts else 'UberSDR'

            # Send to TCI server
            if callsign and frequency:
                self.radio_control.send_spot(callsign, mode, frequency, color, text)

        except Exception as e:
            self.log_status(f"Error forwarding CW spot to TCI: {e}")

    def toggle_nr2(self):
        """Toggle NR2 noise reduction on/off."""
        if not self.connected or not self.client:
            return

        enabled = self.nr2_enabled_var.get()

        try:
            strength = float(self.nr2_strength_var.get())
            floor = float(self.nr2_floor_var.get())

            # Validate parameters
            if strength < 0 or strength > 100:
                messagebox.showerror("Error", "NR2 strength must be between 0 and 100")
                self.nr2_enabled_var.set(not enabled)
                return
            if floor < 0 or floor > 10:
                messagebox.showerror("Error", "NR2 floor must be between 0 and 10")
                self.nr2_enabled_var.set(not enabled)
                return

            if enabled:
                # Enable NR2
                if not NR2_AVAILABLE:
                    messagebox.showerror("Error", "NR2 requires scipy. Install with: pip install scipy")
                    self.nr2_enabled_var.set(False)
                    return

                from nr2 import create_nr2_processor
                self.client.nr2_enabled = True
                self.client.nr2_processor = create_nr2_processor(
                    sample_rate=self.client.sample_rate,
                    strength=strength,
                    floor=floor,
                    adapt_rate=1.0
                )
                self.log_status(f"NR2 enabled (strength={strength}%, floor={floor}%)")
            else:
                # Disable NR2
                self.client.nr2_enabled = False
                self.client.nr2_processor = None
                self.log_status("NR2 disabled")

        except ValueError:
            messagebox.showerror("Error", "Invalid NR2 parameter values")
            self.nr2_enabled_var.set(not enabled)

    def update_audio_filter_ranges(self):
        """Update audio filter slider ranges based on current mode bandwidth."""
        try:
            # Get current bandwidth
            low = int(self.bw_low_var.get())
            high = int(self.bw_high_var.get())

            # Check if this is CW mode (narrow symmetric bandwidth)
            abs_low = abs(low)
            abs_high = abs(high)
            is_cw_mode = (low < 0 and high > 0 and abs_low < 500 and abs_high < 500)

            if is_cw_mode:
                # CW mode: audio is centered at 500 Hz due to pitch offset
                # Bandwidth -200 to +200 means audio is at 300-700 Hz
                cw_offset = 500
                margin = 0.1

                # Calculate actual audio frequency range
                audio_low = cw_offset - abs_low
                audio_high = cw_offset + abs_high

                # Both sliders should have the same full range to allow narrow filters
                range_min = max(0, int(audio_low * (1 - margin)))
                range_max = int(audio_high * (1 + margin))
            else:
                # Non-CW modes: use absolute bandwidth values
                # For LSB/CWL modes, bandwidth is negative (e.g., -2700 to -50)
                # but audio filter works with positive frequencies (50 to 2700)
                margin = 0.1

                # Check if both values are negative (LSB or CWL mode)
                if low < 0 and high < 0:
                    # Swap abs values since bandwidth is backwards for LSB/CWL
                    range_min = max(0, int(abs_high * (1 - margin)))
                    range_max = int(abs_low * (1 + margin))
                else:
                    # USB and other modes - use normal order
                    range_min = max(0, int(abs_low * (1 - margin)))
                    range_max = int(abs_high * (1 + margin))

            # Update both slider ranges to the same full range
            self.filter_low_scale.config(from_=range_min, to=range_max)
            self.filter_high_scale.config(from_=range_min, to=range_max)

            # Adjust current values if they're outside the new range
            current_low = self.audio_filter_low_var.get()
            current_high = self.audio_filter_high_var.get()

            if current_low < range_min:
                self.audio_filter_low_var.set(range_min)
            elif current_low > range_max:
                self.audio_filter_low_var.set(range_max)

            if current_high < range_min:
                self.audio_filter_high_var.set(range_min)
            elif current_high > range_max:
                self.audio_filter_high_var.set(range_max)

        except ValueError:
            # If bandwidth values are invalid, use defaults
            pass

    def update_audio_filter_display(self, value=None):
        """Update audio filter frequency labels and apply filter dynamically."""
        low = int(self.audio_filter_low_var.get())
        high = int(self.audio_filter_high_var.get())

        # Update labels
        self.audio_filter_low_label.config(text=f"{low} Hz")
        self.audio_filter_high_label.config(text=f"{high} Hz")

        # Update audio spectrum display if open
        if self.audio_spectrum_display:
            enabled = self.audio_filter_enabled_var.get()
            self.audio_spectrum_display.update_audio_filter(enabled, low, high)

        # Apply filter dynamically if enabled and connected
        if self.connected and self.client and self.audio_filter_enabled_var.get():
            # Validate before applying
            if low < high:
                self.client.update_audio_filter(float(low), float(high))

    def toggle_audio_filter(self):
        """Toggle audio bandpass filter on/off."""
        if not self.connected or not self.client:
            return

        enabled = self.audio_filter_enabled_var.get()

        try:
            if enabled:
                # Only validate and set up filter when enabling
                # Get current bandwidth
                bw_low = int(self.bw_low_var.get())
                bw_high = int(self.bw_high_var.get())
                abs_low = abs(bw_low)
                abs_high = abs(bw_high)

                # Check if this is CW mode
                is_cw_mode = (bw_low < 0 and bw_high > 0 and abs_low < 500 and abs_high < 500)

                if is_cw_mode:
                    # CW mode: audio is centered at 500 Hz
                    # Set filter to 80% of the audio bandwidth around 500 Hz
                    cw_offset = 500
                    audio_low = cw_offset - abs_low
                    audio_high = cw_offset + abs_high

                    # Use 80% of the range
                    range_span = audio_high - audio_low
                    margin = range_span * 0.1
                    default_low = int(audio_low + margin)
                    default_high = int(audio_high - margin)
                else:
                    # Non-CW modes: use absolute bandwidth values
                    # Use 80% of the bandwidth range
                    margin = 0.1

                    # Check if both values are negative (LSB or CWL mode)
                    if bw_low < 0 and bw_high < 0:
                        # LSB/CWL: bandwidth is backwards (e.g., -2700 to -50)
                        # Audio filter needs normal order (50 to 2700)
                        default_low = int(abs_high * (1 + margin))
                        default_high = int(abs_low * (1 - margin))
                    else:
                        # USB and other modes - use normal order
                        default_low = int(abs_low * (1 + margin))
                        default_high = int(abs_high * (1 - margin))

                    # Ensure low < high
                    if default_low >= default_high:
                        if bw_low < 0 and bw_high < 0:
                            default_low = int(abs_high)
                            default_high = int(abs_low)
                        else:
                            default_low = int(abs_low)
                            default_high = int(abs_high)

                # Update slider values to reasonable defaults
                self.audio_filter_low_var.set(default_low)
                self.audio_filter_high_var.set(default_high)

                # Update display
                self.update_audio_filter_display()

                # Use the default values we just calculated (not read from sliders)
                low = float(default_low)
                high = float(default_high)

                # Validate parameters only when enabling
                if low <= 0 or high <= 0:
                    messagebox.showerror("Error", "Filter frequencies must be positive")
                    self.audio_filter_enabled_var.set(False)
                    return
                if low >= high:
                    messagebox.showerror("Error", "Low frequency must be less than high frequency")
                    self.audio_filter_enabled_var.set(False)
                    return

                # Enable audio filter
                if not SCIPY_AVAILABLE:
                    messagebox.showerror("Error", "Audio filter requires scipy. Install with: pip install scipy")
                    self.audio_filter_enabled_var.set(False)
                    return

                self.client.audio_filter_enabled = True
                self.client.audio_filter_low = low
                self.client.audio_filter_high = high
                self.client._init_audio_filter()
                self.log_status(f"Audio filter enabled ({low:.0f}-{high:.0f} Hz)")
            else:
                # Disable audio filter
                self.client.audio_filter_enabled = False
                self.log_status("Audio filter disabled")

            # Update audio spectrum display
            if self.audio_spectrum_display:
                # Get current filter values for display update
                low = int(self.audio_filter_low_var.get())
                high = int(self.audio_filter_high_var.get())
                self.audio_spectrum_display.update_audio_filter(enabled, low, high)

        except ValueError:
            messagebox.showerror("Error", "Invalid audio filter parameter values")
            self.audio_filter_enabled_var.set(not enabled)

    def apply_audio_filter(self):
        """Apply audio filter parameter changes."""
        if not self.connected or not self.client:
            return

        if not self.audio_filter_enabled_var.get():
            messagebox.showinfo("Info", "Audio filter is not enabled")
            return

        try:
            low = float(self.audio_filter_low_var.get())
            high = float(self.audio_filter_high_var.get())

            # Validate parameters
            if low <= 0 or high <= 0:
                messagebox.showerror("Error", "Filter frequencies must be positive")
                return
            if low >= high:
                messagebox.showerror("Error", "Low frequency must be less than high frequency")
                return

            # Update filter
            self.client.update_audio_filter(low, high)
            self.log_status(f"Audio filter updated ({low:.0f}-{high:.0f} Hz)")

        except ValueError:
            messagebox.showerror("Error", "Invalid audio filter parameter values")

    def on_udp_stereo_changed(self):
        """Handle UDP stereo checkbox change."""
        if self.client:
            self.client.udp_stereo = self.udp_stereo_var.get()
            stereo_str = "stereo" if self.udp_stereo_var.get() else "mono"
            self.log_status(f"UDP output: {stereo_str}")
        # Auto-save setting
        self.save_audio_settings()

    def on_opus_active(self, active: bool):
        """Callback when Opus packets are received (called from client thread)."""
        # Schedule GUI update in main thread
        self.root.after(0, lambda: self._update_opus_indicator(active))

    def _update_opus_indicator(self, active: bool):
        """Update Opus checkbox color to indicate active status (runs in main thread)."""
        if active and not self.opus_active:
            # Opus is now active - change text color to blue using style
            self.opus_check.configure(style='OpusActive.TCheckbutton')
            self.opus_active = True
        elif not active and self.opus_active:
            # Opus is no longer active - reset to default style
            self.opus_check.configure(style='Opus.TCheckbutton')
            self.opus_active = False

    def on_opus_changed(self):
        """Handle Opus checkbox change."""
        enabled = self.opus_var.get()

        # Check if current mode is IQ
        mode_display = self.mode_var.get()
        mode = self._parse_mode_name(mode_display)
        is_iq_mode = mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')

        if enabled and is_iq_mode:
            # Opus not supported for IQ modes
            messagebox.showwarning("Opus Not Supported",
                                  "Opus compression is not supported for IQ modes (lossless data required).\n\n"
                                  "Please switch to a non-IQ mode to use Opus.")
            self.opus_var.set(False)
            return

        if enabled:
            # Check if opuslib is available
            try:
                import opuslib
                if self.connected:
                    self.log_status("⚠ Opus will be enabled on next connection")
                    messagebox.showinfo("Reconnection Required",
                                      "Opus compression will be enabled on your next connection.\n\n"
                                      "This will reduce bandwidth usage by approximately 90%.\n\n"
                                      "Please disconnect and reconnect for this change to take effect.")
                else:
                    self.log_status("Opus compression enabled (90% bandwidth savings)")
            except ImportError:
                messagebox.showerror("Opus Not Available",
                                   "Opus compression requires the opuslib library.\n\n"
                                   "Install it with: pip install opuslib")
                self.opus_var.set(False)
                return
        else:
            if self.connected:
                self.log_status("⚠ Opus will be disabled on next connection")
                messagebox.showinfo("Reconnection Required",
                                  "Opus compression will be disabled on your next connection.\n\n"
                                  "Please disconnect and reconnect for this change to take effect.")
            else:
                self.log_status("Opus compression disabled")

        # Auto-save setting
        self.save_audio_settings()

    def toggle_udp_output(self):
        """Toggle UDP output on/off."""
        # Always save settings when checkbox is toggled (even if not connected)
        # This ensures settings persist for next connection
        enabled = self.udp_enabled_var.get()

        if not self.connected or not self.client:
            # If not connected, just save the settings and return
            self.save_audio_settings()
            return

        if enabled:
            # Validate and enable UDP
            try:
                host = self.udp_host_var.get().strip()
                port = self.udp_port_var.get().strip()

                if not host:
                    messagebox.showerror("Error", "Please enter UDP host")
                    self.udp_enabled_var.set(False)
                    return

                if not port:
                    messagebox.showerror("Error", "Please enter UDP port")
                    self.udp_enabled_var.set(False)
                    return

                try:
                    port_int = int(port)
                except ValueError:
                    messagebox.showerror("Error", "Invalid port number")
                    self.udp_enabled_var.set(False)
                    return

                # Create UDP socket
                import socket
                self.client.udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                self.client.udp_host = host
                self.client.udp_port = port_int
                self.client.udp_enabled = True
                self.client.udp_stereo = self.udp_stereo_var.get()

                stereo_str = "stereo" if self.udp_stereo_var.get() else "mono"
                self.log_status(f"UDP output enabled: {host}:{port_int} ({stereo_str})")
            except Exception as e:
                messagebox.showerror("Error", f"Failed to enable UDP: {e}")
                self.udp_enabled_var.set(False)
                self.log_status(f"ERROR: Failed to enable UDP - {e}")
        else:
            # Disable UDP
            if self.client.udp_socket:
                try:
                    self.client.udp_socket.close()
                except:
                    pass
                self.client.udp_socket = None
            self.client.udp_enabled = False
            self.log_status("UDP output disabled")

        # Auto-save UDP settings
        self.save_audio_settings()

    def toggle_spectrum(self):
        """Toggle spectrum display visibility and connection."""
        enabled = self.spectrum_enabled_var.get()

        if enabled:
            # Show spectrum display
            if self.spectrum_frame:
                self.spectrum_frame.grid(row=6, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(5, 10))

                # Create spectrum display widget if not already created
                if not self.spectrum:
                    self.spectrum = SpectrumDisplay(self.spectrum_frame, width=780, height=200)
                    self.spectrum.set_frequency_callback(self.on_spectrum_frequency_click)
                    self.spectrum.set_frequency_step_callback(self.on_spectrum_frequency_step)
                    self.spectrum.set_bandwidth_callback(self.on_spectrum_bandwidth_change)
                    self.spectrum.set_zoom_callback(self.on_spectrum_zoom_change)
                    # Set initial step size
                    self.spectrum.set_step_size(self.get_step_size_hz())

                # Connect if radio is connected
                if self.connected and self.client:
                    try:
                        hostname = self.server_var.get().strip()
                        port = self.port_var.get().strip()
                        server = f"{hostname}:{port}" if ':' not in hostname else hostname
                        frequency = self.get_frequency_hz()
                        # Pass the audio channel's user_session_id and password to spectrum
                        password = self.config.get('password')
                        self.spectrum.connect(server, frequency, self.client.user_session_id, password=password)
                        self.log_status("Spectrum display connected")
                    except Exception as e:
                        self.log_status(f"Spectrum display error: {e}")
        else:
            # Hide spectrum display
            if self.spectrum_frame:
                self.spectrum_frame.grid_remove()

            # Disconnect spectrum
            if self.spectrum:
                self.spectrum.disconnect()
                self.log_status("Spectrum display disconnected")

    def on_spectrum_frequency_click(self, frequency: float):
        """Handle frequency click from spectrum display.

        Args:
            frequency: New frequency in Hz
        """
        # Check if frequency is locked
        if self.freq_lock_var.get():
            self.log_status("Frequency is locked - change blocked")
            return

        # Update frequency display
        self.set_frequency_hz(int(frequency))

        # Apply frequency change if connected
        if self.connected:
            self.apply_frequency()

    def on_spectrum_frequency_step(self, direction: int):
        """Handle frequency step from spectrum mouse wheel.

        Args:
            direction: +1 for step up, -1 for step down
        """
        # Check if frequency is locked
        if self.freq_lock_var.get():
            self.log_status("Frequency is locked - change blocked")
            return

        try:
            current_hz = self.get_frequency_hz()
            step_hz = self.get_step_size_hz()

            if direction > 0:
                # Step up
                new_hz = ((current_hz // step_hz) + 1) * step_hz
            else:
                # Step down
                new_hz = ((current_hz - 1) // step_hz) * step_hz

            # Update display
            self.set_frequency_hz(new_hz)

            # Apply immediately if connected
            if self.connected:
                self.apply_frequency()
        except ValueError:
            pass

    def on_spectrum_mode_change(self, mode: str):
        """Handle mode change from spectrum bookmark click.

        Args:
            mode: Mode string from bookmark (e.g., 'USB', 'LSB', 'CW')
        """
        # Only change mode if not locked
        if self.mode_lock_var.get():
            return

        # Map mode names (bookmark might use different case)
        mode_map = {
            'USB': 'USB', 'LSB': 'LSB', 'AM': 'AM', 'SAM': 'SAM',
            'CWU': 'CWU', 'CWL': 'CWL', 'FM': 'FM', 'NFM': 'NFM',
            'IQ': 'IQ', 'IQ48': 'IQ48', 'IQ96': 'IQ96',
            'IQ192': 'IQ192', 'IQ384': 'IQ384'
        }
        mapped_mode = mode_map.get(mode.upper(), 'USB')
        self.mode_var.set(mapped_mode)
        self.on_mode_changed()

        # Apply mode change if connected
        if self.connected:
            self.apply_mode()

    def on_spectrum_bandwidth_change(self, bandwidth_low: int, bandwidth_high: int):
        """Handle bandwidth change from spectrum bookmark click.

        Args:
            bandwidth_low: Low bandwidth edge in Hz
            bandwidth_high: High bandwidth edge in Hz
        """
        # Set bandwidth sliders
        self.bw_low_var.set(bandwidth_low)
        self.bw_high_var.set(bandwidth_high)
        self.bw_low_label.config(text=f"{bandwidth_low} Hz")
        self.bw_high_label.config(text=f"{bandwidth_high} Hz")

        # Update client bandwidth values
        if self.client:
            self.client.bandwidth_low = bandwidth_low
            self.client.bandwidth_high = bandwidth_high

        # Update spectrum displays
        if self.spectrum:
            self.spectrum.update_bandwidth(bandwidth_low, bandwidth_high, self.mode_var.get().lower())
        if self.waterfall_display:
            self.waterfall_display.update_bandwidth(bandwidth_low, bandwidth_high, self.mode_var.get().lower())
        if self.audio_spectrum_display:
            self.audio_spectrum_display.update_bandwidth(bandwidth_low, bandwidth_high, self.mode_var.get().lower())

        # Apply bandwidth change if connected
        if self.connected:
            self.send_tune_message()

    def on_spectrum_zoom_change(self):
        """Handle zoom change from spectrum display (zoom in/out/reset).

        Notifies chat users of the zoom change so they can see the updated view.
        """
        # Notify chat of zoom change
        self.notify_chat_radio_changed()

    def on_scroll_mode_changed(self):
        """Handle scroll mode change (zoom vs pan)."""
        mode = self.scroll_mode_var.get()

        # Update spectrum display scroll mode
        if self.spectrum:
            self.spectrum.set_scroll_mode(mode)

        # Update waterfall display scroll mode
        if self.waterfall_display:
            self.waterfall_display.set_scroll_mode(mode)

        # Update waterfall window's spectrum and waterfall if open
        if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
            self.waterfall_spectrum.set_scroll_mode(mode)
        if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
            self.waterfall_waterfall.set_scroll_mode(mode)

        self.log_status(f"Scroll mode: {mode}")

    def unmute_audio(self):
        """Unmute audio after main window opens."""
        if self.client and hasattr(self.client, '_desired_volume'):
            desired_volume = self.client._desired_volume
            self.client.volume = desired_volume
            self.log_status("Audio enabled")

    def auto_open_waterfall(self):
        """Automatically open waterfall window on connection (no error dialogs)."""
        # Don't open multiple windows
        if self.waterfall_window and self.waterfall_window.winfo_exists():
            return

        if not self.connected or not self.spectrum:
            return

        try:
            from waterfall_display import create_waterfall_window

            # Create waterfall window (shares spectrum's data)
            self.waterfall_window, self.waterfall_display = create_waterfall_window(self)

            self.log_status("Waterfall window opened automatically")

        except Exception as e:
            # Silent failure for auto-open (user can manually open if needed)
            self.log_status(f"Note: Waterfall auto-open failed - {e}")

    def auto_open_audio_spectrum(self):
        """Automatically open audio spectrum window on connection (no error dialogs)."""
        # Don't open multiple windows
        if self.audio_spectrum_window and self.audio_spectrum_window.winfo_exists():
            return

        if not self.connected:
            return

        try:
            from audio_spectrum_display import create_audio_spectrum_window

            # Create audio spectrum window
            self.audio_spectrum_window, self.audio_spectrum_display = create_audio_spectrum_window(self)

            self.log_status("Audio spectrum window opened automatically")

        except Exception as e:
            # Silent failure for auto-open (user can manually open if needed)
            self.log_status(f"Note: Audio spectrum auto-open failed - {e}")

    def auto_open_digital_spots(self):
        """Automatically open digital spots window on connection (no error dialogs)."""
        # Don't open multiple windows
        if self.digital_spots_window and self.digital_spots_window.winfo_exists():
            return

        if not self.connected:
            return

        try:
            # Ensure shared WebSocket is connected
            ws_manager = self._ensure_dxcluster_ws()

            from digital_spots_display import create_digital_spots_window

            # Get countries list from client
            countries = self.client.countries if self.client and hasattr(self.client, 'countries') else []

            # Create digital spots window with shared WebSocket and countries
            self.digital_spots_display = create_digital_spots_window(
                ws_manager,
                on_close=self._on_digital_spots_closed,
                countries=countries,
                radio_gui=self
            )
            self.digital_spots_window = self.digital_spots_display.window

            # Set initial band filter to current band if one is active
            try:
                current_freq = self.get_frequency_hz()
                for band_name, band_range in self.BAND_RANGES.items():
                    if band_range['min'] <= current_freq <= band_range['max']:
                        # Only set if different from current value
                        if self.digital_spots_display.band_filter.get() != band_name:
                            self.digital_spots_display.band_filter.set(band_name)
                            self.digital_spots_display.apply_filters()
                        break
            except (ValueError, AttributeError):
                pass

            self.log_status("Digital spots window opened automatically")

        except Exception as e:
            # Silent failure for auto-open (user can manually open if needed)
            self.log_status(f"Note: Digital spots auto-open failed - {e}")

    def auto_open_cw_spots(self):
        """Automatically open CW spots window on connection (no error dialogs)."""
        # Don't open multiple windows
        if self.cw_spots_window and self.cw_spots_window.winfo_exists():
            return

        if not self.connected:
            return

        try:
            # Ensure shared WebSocket is connected
            ws_manager = self._ensure_dxcluster_ws()

            from cw_spots_display import create_cw_spots_window

            # Get countries list from client
            countries = self.client.countries if self.client and hasattr(self.client, 'countries') else []

            # Create CW spots window with shared WebSocket and countries
            self.cw_spots_display = create_cw_spots_window(
                ws_manager,
                on_close=self._on_cw_spots_closed,
                radio_gui=self,
                countries=countries
            )
            self.cw_spots_window = self.cw_spots_display.window

            # Set initial band filter to current band if one is active
            try:
                current_freq = self.get_frequency_hz()
                for band_name, band_range in self.BAND_RANGES.items():
                    if band_range['min'] <= current_freq <= band_range['max']:
                        # Only set if different from current value
                        if self.cw_spots_display.band_var.get() != band_name:
                            self.cw_spots_display.band_var.set(band_name)
                            self.cw_spots_display.apply_filters()
                        break
            except (ValueError, AttributeError):
                pass

            self.log_status("CW spots window opened automatically")

        except Exception as e:
            # Silent failure for auto-open (user can manually open if needed)
            self.log_status(f"Note: CW spots auto-open failed - {e}")

    def open_waterfall_window(self):
        """Open a separate waterfall display window."""
        # Don't open multiple windows
        if self.waterfall_window and self.waterfall_window.winfo_exists():
            self.waterfall_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        if not self.spectrum:
            messagebox.showerror("Error", "Spectrum display not available")
            return

        try:
            from waterfall_display import create_waterfall_window

            # Create waterfall window (shares spectrum's data)
            self.waterfall_window, self.waterfall_display = create_waterfall_window(self)

            self.log_status("Waterfall window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open waterfall: {e}")
            self.log_status(f"ERROR: Failed to open waterfall - {e}")

    def open_audio_spectrum_window(self):
        """Open a separate audio spectrum display window."""
        # Don't open multiple windows
        if self.audio_spectrum_window and self.audio_spectrum_window.winfo_exists():
            self.audio_spectrum_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            from audio_spectrum_display import create_audio_spectrum_window

            # Create audio spectrum window
            self.audio_spectrum_window, self.audio_spectrum_display = create_audio_spectrum_window(self)

            self.log_status("Audio spectrum window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open audio spectrum: {e}")
            self.log_status(f"ERROR: Failed to open audio spectrum - {e}")

    def _ensure_dxcluster_ws(self):
        """Ensure shared DX cluster WebSocket manager exists (connection is automatic)."""
        if not self.dxcluster_ws and DXCLUSTER_WS_AVAILABLE:
            # Create shared WebSocket manager
            hostname = self.server_var.get().strip()
            port = self.port_var.get().strip()
            server = f"{hostname}:{port}" if ':' not in hostname else hostname
            use_tls = self.tls_var.get()

            # Parse server URL
            if '://' in server:
                # Full URL provided - convert to WebSocket URL
                ws_url = server.replace('http://', 'ws://').replace('https://', 'wss://')
                # Remove any existing path
                if '/' in ws_url.split('://', 1)[1]:
                    base = ws_url.split('/', 3)[:3]
                    ws_url = '/'.join(base)
            else:
                # Host:port format
                protocol = 'wss' if use_tls else 'ws'
                ws_url = f"{protocol}://{server}"

            # Get user_session_id from the radio client
            if self.client and hasattr(self.client, 'user_session_id'):
                user_session_id = self.client.user_session_id
                self.dxcluster_ws = DXClusterWebSocket(ws_url, user_session_id)
                # Note: Connection happens automatically when first callback is registered
                self.log_status("DX cluster WebSocket manager created")
            else:
                raise Exception("No active radio session")

        return self.dxcluster_ws

    def open_digital_spots_window(self):
        """Open a separate digital spots display window."""
        # Don't open multiple windows
        if self.digital_spots_window and self.digital_spots_window.winfo_exists():
            self.digital_spots_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            # Ensure shared WebSocket is connected
            ws_manager = self._ensure_dxcluster_ws()

            from digital_spots_display import create_digital_spots_window

            # Get countries list from client
            countries = self.client.countries if self.client and hasattr(self.client, 'countries') else []

            # Create digital spots window with shared WebSocket and countries
            self.digital_spots_display = create_digital_spots_window(
                ws_manager,
                on_close=self._on_digital_spots_closed,
                countries=countries,
                radio_gui=self
            )
            self.digital_spots_window = self.digital_spots_display.window

            # Set initial band filter to current band if one is active
            try:
                current_freq = self.get_frequency_hz()
                for band_name, band_range in self.BAND_RANGES.items():
                    if band_range['min'] <= current_freq <= band_range['max']:
                        # Only set if different from current value
                        if self.digital_spots_display.band_filter.get() != band_name:
                            self.digital_spots_display.band_filter.set(band_name)
                            self.digital_spots_display.apply_filters()
                        break
            except (ValueError, AttributeError):
                pass

            self.log_status("Digital spots window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open digital spots: {e}")
            self.log_status(f"ERROR: Failed to open digital spots - {e}")

    def _on_digital_spots_closed(self):
        """Handle digital spots window close."""
        self.digital_spots_window = None
        self.digital_spots_display = None
        self.log_status("Digital spots window closed")

    def open_cw_spots_window(self):
        """Open a separate CW spots display window."""
        # Don't open multiple windows
        if self.cw_spots_window and self.cw_spots_window.winfo_exists():
            self.cw_spots_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            # Ensure shared WebSocket is connected
            ws_manager = self._ensure_dxcluster_ws()

            from cw_spots_display import create_cw_spots_window

            # Get countries list from client
            countries = self.client.countries if self.client and hasattr(self.client, 'countries') else []

            # Create CW spots window with shared WebSocket and countries
            self.cw_spots_display = create_cw_spots_window(
                ws_manager,
                on_close=self._on_cw_spots_closed,
                radio_gui=self,
                countries=countries
            )
            self.cw_spots_window = self.cw_spots_display.window

            # Set initial band filter to current band if one is active
            try:
                current_freq = self.get_frequency_hz()
                for band_name, band_range in self.BAND_RANGES.items():
                    if band_range['min'] <= current_freq <= band_range['max']:
                        # Only set if different from current value
                        if self.cw_spots_display.band_var.get() != band_name:
                            self.cw_spots_display.band_var.set(band_name)
                            self.cw_spots_display.apply_filters()
                        break
            except (ValueError, AttributeError):
                pass

            self.log_status("CW spots window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open CW spots: {e}")
            self.log_status(f"ERROR: Failed to open CW spots - {e}")

    def _on_cw_spots_closed(self):
        """Handle CW spots window close."""
        self.cw_spots_window = None
        self.cw_spots_display = None
        self.log_status("CW spots window closed")

    def open_band_conditions_window(self):
        """Open a separate band conditions display window."""
        # Don't open multiple windows
        if self.band_conditions_window and self.band_conditions_window.winfo_exists():
            self.band_conditions_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            from band_conditions_display import create_band_conditions_window

            # Get server URL and TLS setting
            hostname = self.server_var.get().strip()
            port = self.port_var.get().strip()
            server = f"{hostname}:{port}" if ':' not in hostname else hostname
            use_tls = self.tls_var.get()

            # Create band conditions window
            self.band_conditions_display = create_band_conditions_window(self.root, server, use_tls)
            self.band_conditions_window = self.band_conditions_display.window

            self.log_status("Band conditions window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open band conditions: {e}")
            self.log_status(f"ERROR: Failed to open band conditions - {e}")

    def open_noise_floor_window(self):
        """Open a separate noise floor display window."""
        # Don't open multiple windows
        if self.noise_floor_window and self.noise_floor_window.winfo_exists():
            self.noise_floor_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            from noise_floor_display import create_noise_floor_window

            # Get server URL and TLS setting
            hostname = self.server_var.get().strip()
            port = self.port_var.get().strip()
            server = f"{hostname}:{port}" if ':' not in hostname else hostname
            use_tls = self.tls_var.get()

            # Create noise floor window
            self.noise_floor_display = create_noise_floor_window(self.root, server, use_tls)
            self.noise_floor_window = self.noise_floor_display.window

            self.log_status("Noise floor window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open noise floor: {e}")
            self.log_status(f"ERROR: Failed to open noise floor - {e}")

    def open_space_weather_window(self):
        """Open a separate space weather display window."""
        # Don't open multiple windows
        if self.space_weather_window and self.space_weather_window.winfo_exists():
            self.space_weather_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            from space_weather_display import create_space_weather_window

            # Get server URL and TLS setting
            hostname = self.server_var.get().strip()
            port = self.port_var.get().strip()
            server = f"{hostname}:{port}" if ':' not in hostname else hostname
            use_tls = self.tls_var.get()

            # Get GPS coordinates and location from client
            gps_coords = None
            location_name = None
            if self.client and hasattr(self.client, 'server_description'):
                desc = self.client.server_description
                if desc.get('receiver', {}).get('gps'):
                    gps = desc['receiver']['gps']
                    if gps.get('lat') and gps.get('lon'):
                        gps_coords = {'lat': gps['lat'], 'lon': gps['lon']}
                if desc.get('receiver', {}).get('location'):
                    location_name = desc['receiver']['location']

            # Create space weather window
            self.space_weather_display = create_space_weather_window(
                self.root, server, use_tls, gps_coords, location_name
            )
            self.space_weather_window = self.space_weather_display.window

            self.log_status("Space weather window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open space weather: {e}")
            self.log_status(f"ERROR: Failed to open space weather - {e}")

    def open_rotator_status_window(self):
        """Open a separate rotator status display window."""
        # Don't open multiple windows
        if self.rotator_status_window and self.rotator_status_window.winfo_exists():
            self.rotator_status_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            from rotator_status_display import create_rotator_status_window

            # Get server URL and TLS setting
            hostname = self.server_var.get().strip()
            port = self.port_var.get().strip()
            server = f"{hostname}:{port}" if ':' not in hostname else hostname
            use_tls = self.tls_var.get()

            # Get instance UUID from server description
            instance_uuid = None
            if self.client and hasattr(self.client, 'server_description'):
                instance_uuid = self.client.server_description.get('public_uuid', '')

            # Create rotator status window with instance UUID for password saving
            self.rotator_status_display = create_rotator_status_window(
                self.root, server, use_tls, instance_uuid
            )
            self.rotator_status_window = self.rotator_status_display.window

            self.log_status("Rotator status window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open rotator status: {e}")
            self.log_status(f"ERROR: Failed to open rotator status - {e}")

    def open_eq_window(self):
        """Open the 10-band equalizer window."""
        # Check if window exists and is visible
        if self.eq_display and self.eq_display.window and self.eq_display.window.winfo_exists():
            self.eq_display.show()  # Bring to front
            return

        try:
            from eq_display import create_eq_window

            # Create EQ window with callback
            self.eq_display = create_eq_window(self.root, self.on_eq_changed)
            self.eq_window = self.eq_display.window

            self.log_status("EQ window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open EQ: {e}")
            self.log_status(f"ERROR: Failed to open EQ - {e}")

    def on_eq_changed(self, band_gains: dict):
        """Handle EQ changes from the EQ window.

        Args:
            band_gains: Dictionary of {frequency: gain_db} or None if disabled
        """
        if not self.client:
            return

        if band_gains is None:
            # EQ disabled
            self.client.eq_enabled = False
            self.log_status("EQ disabled")
        else:
            # EQ enabled with new gains
            self.client.eq_enabled = True
            self.client.update_eq(band_gains)
            self.log_status(f"EQ enabled: {len(band_gains)} bands")

    def open_users_window(self):
        """Open a separate users display window."""
        # Don't open multiple windows
        if self.users_window and self.users_window.winfo_exists():
            self.users_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            # Get server URL and TLS setting
            hostname = self.server_var.get().strip()
            port = self.port_var.get().strip()
            server = f"{hostname}:{port}" if ':' not in hostname else hostname
            use_tls = self.tls_var.get()

            # Create session ID callback (dynamically fetches current session ID)
            def get_session_id():
                """Get current server-assigned session ID."""
                return self.client.server_session_id if self.client else None

            # Create tune callback
            def tune_to_channel(freq_hz, mode, bw_low, bw_high):
                """Tune to another user's channel."""
                # Set frequency
                self.set_frequency_hz(int(freq_hz))

                # Set mode if not locked
                if not self.mode_lock_var.get():
                    # Map mode names
                    mode_map = {
                        'USB': 'USB', 'LSB': 'LSB', 'AM': 'AM', 'SAM': 'SAM',
                        'CWU': 'CWU', 'CWL': 'CWL', 'FM': 'FM', 'NFM': 'NFM',
                        'IQ': 'IQ', 'IQ48': 'IQ48', 'IQ96': 'IQ96',
                        'IQ192': 'IQ192', 'IQ384': 'IQ384'
                    }
                    mapped_mode = mode_map.get(mode.upper(), 'USB')
                    self.mode_var.set(mapped_mode)
                    self.on_mode_changed()

                # Set bandwidth
                self.bw_low_var.set(bw_low)
                self.bw_high_var.set(bw_high)
                self.bw_low_label.config(text=f"{bw_low} Hz")
                self.bw_high_label.config(text=f"{bw_high} Hz")

                # Update client bandwidth values
                if self.client:
                    self.client.bandwidth_low = bw_low
                    self.client.bandwidth_high = bw_high

                # Update spectrum displays
                if self.spectrum:
                    self.spectrum.update_bandwidth(bw_low, bw_high, self.mode_var.get().lower())
                if self.waterfall_display:
                    self.waterfall_display.update_bandwidth(bw_low, bw_high, self.mode_var.get().lower())
                if self.audio_spectrum_display:
                    self.audio_spectrum_display.update_bandwidth(bw_low, bw_high, self.mode_var.get().lower())

                # Apply changes if connected (this will send tune message with new bandwidth)
                if self.connected:
                    self.apply_frequency()

                self.log_status(f"Tuned to user channel: {freq_hz/1e6:.6f} MHz, {mode}, {bw_low}-{bw_high} Hz")

            # Create users window
            self.users_window, self.users_display = create_users_window(
                self.root, server, use_tls, get_session_id, tune_to_channel
            )

            self.log_status("Users window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open users window: {e}")
            self.log_status(f"ERROR: Failed to open users window - {e}")

    def open_chat_window(self):
        """Open a separate chat window."""
        # Don't open multiple windows
        if self.chat_window and self.chat_window.winfo_exists():
            self.chat_window.lift()  # Bring to front
            return

        if not self.connected:
            messagebox.showinfo("Not Connected", "Please connect to the server first.")
            return

        try:
            # Get instance UUID from server description
            instance_uuid = None
            if self.client and hasattr(self.client, 'server_description'):
                instance_uuid = self.client.server_description.get('public_uuid', '')

            # Ensure shared WebSocket is connected
            ws_manager = self._ensure_dxcluster_ws()

            # Create chat window with shared WebSocket, radio_gui reference, and instance UUID
            self.chat_display = create_chat_window(
                self.root,
                ws_manager,
                self,  # Pass radio_gui reference
                on_close=self._on_chat_closed,
                instance_uuid=instance_uuid
            )
            self.chat_window = self.chat_display.window

            # Check for saved username and auto-join if found
            if instance_uuid:
                saved_username = get_saved_username_for_instance(instance_uuid)
                if saved_username:
                    # Auto-populate username field
                    self.chat_display.username_var.set(saved_username)
                    # Automatically join chat with saved username
                    self.root.after(100, lambda: self.chat_display.join_chat())
                    self.log_status(f"Chat window opened - auto-joining as '{saved_username}'")
                else:
                    self.log_status("Chat window opened")
            else:
                self.log_status("Chat window opened")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to open chat: {e}")
            self.log_status(f"ERROR: Failed to open chat - {e}")

    def _on_chat_closed(self):
        """Handle chat window close."""
        self.chat_window = None
        self.chat_display = None
        self.log_status("Chat window closed")

    def notify_chat_radio_changed(self):
        """Notify chat window that radio settings have changed"""
        if self.chat_display:
            self.chat_display.on_radio_changed()

    def open_midi_window(self):
        """Open MIDI controller configuration window."""
        # Check if controller exists but window is hidden
        if self.midi_controller and self.midi_controller.window:
            # Window exists but is hidden - show it
            self.midi_controller.window.deiconify()
            self.midi_controller.window.lift()
            self.midi_window = self.midi_controller.window

            # Update status label when reopening
            if self.midi_controller.midi_in and self.midi_controller.running:
                self.midi_controller.status_label.config(text="Connected", foreground='green')
            else:
                self.midi_controller.status_label.config(text="Not connected", foreground='red')

            self.log_status("MIDI controller window reopened")
            return

        # Check if window is already open
        if self.midi_window and self.midi_window.winfo_exists():
            self.midi_window.lift()  # Bring to front
            return

        try:
            # Check if controller already exists (from auto-init)
            if self.midi_controller:
                # Controller exists, just create window for it
                self.midi_controller.create_window(self.root)
                self.midi_window = self.midi_controller.window
                self.log_status("MIDI controller window opened")
            else:
                # No controller yet, create new one with window
                from midi_controller import create_midi_window
                self.midi_controller = create_midi_window(self)
                self.midi_window = self.midi_controller.window
                self.log_status("MIDI controller window opened")

        except ImportError as e:
            messagebox.showerror("Error", "MIDI support not available. Install python-rtmidi:\npip install python-rtmidi")
            self.log_status(f"ERROR: MIDI not available - {e}")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to open MIDI window: {e}")
            self.log_status(f"ERROR: Failed to open MIDI window - {e}")

    def auto_init_midi(self):
        """Auto-initialize MIDI controller on startup if config exists."""
        try:
            import os
            # Use platform-appropriate config path (same as MIDIController)
            if platform.system() == 'Windows':
                config_dir = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'ubersdr')
                config_file = os.path.join(config_dir, 'midi_mappings.json')
            else:
                config_file = os.path.expanduser("~/.ubersdr_midi_mappings.json")

            # Only auto-init if config file exists
            if os.path.exists(config_file):
                from midi_controller import MIDIController

                # Create controller without window
                self.midi_controller = MIDIController(self)

                # Log what was loaded
                if self.midi_controller.mappings:
                    self.log_status(f"MIDI: Loaded {len(self.midi_controller.mappings)} mapping(s)")

                # Try to auto-connect to saved device (even if no mappings yet)
                if self.midi_controller.last_device_name or self.midi_controller.mappings:
                    try:
                        import rtmidi
                        midi_in = rtmidi.MidiIn()
                        ports = midi_in.get_ports()

                        if ports:
                            # Try to find saved device first
                            port_index = 0
                            if self.midi_controller.last_device_name:
                                try:
                                    port_index = ports.index(self.midi_controller.last_device_name)
                                    self.log_status(f"MIDI: Found saved device: {self.midi_controller.last_device_name}")
                                except ValueError:
                                    # Saved device not found, use first available
                                    self.log_status(f"MIDI: Saved device '{self.midi_controller.last_device_name}' not found, using: {ports[0]}")
                            else:
                                self.log_status(f"MIDI: No saved device, using: {ports[0]}")

                            # Connect to device
                            self.midi_controller.midi_in = midi_in
                            midi_in.open_port(port_index)
                            midi_in.set_callback(self.midi_controller.on_midi_message)
                            self.midi_controller.running = True
                            self.log_status(f"MIDI: Auto-connected to {ports[port_index]}")
                        else:
                            del midi_in
                            self.log_status("MIDI: No devices available")
                    except Exception as e:
                        self.log_status(f"MIDI: Auto-connect failed - {e}")

        except ImportError:
            # MIDI not available, skip silently
            pass
        except Exception as e:
            # Other errors, log but don't show error dialog
            print(f"MIDI auto-init error: {e}")

    def adjust_bandwidth_for_mode(self, mode: str):
        """Set bandwidth defaults based on mode (matching web application behavior)."""
        # Default bandwidth values for each mode (from static/app.js setMode function lines 2556-2606)
        mode_defaults = {
            'usb': (50, 2700),
            'lsb': (-2700, -50),
            'am': (-5000, 5000),
            'sam': (-5000, 5000),
            'cwu': (-200, 200),
            'cwl': (-200, 200),
            'fm': (-8000, 8000),
            'nfm': (-5000, 5000),
            'iq': (-5000, 5000),
            'iq48': (-5000, 5000),
            'iq96': (-5000, 5000),
            'iq192': (-5000, 5000),
            'iq384': (-5000, 5000)
        }

        # Get defaults for current mode
        if mode in mode_defaults:
            low, high = mode_defaults[mode]
            self.bw_low_var.set(low)
            self.bw_high_var.set(high)

            # Update labels
            self.bw_low_label.config(text=f"{low} Hz")
            self.bw_high_label.config(text=f"{high} Hz")

            # Update slider bounds for the mode
            self.update_bandwidth_slider_bounds(mode)

            # Update spectrum display bandwidth visualization
            if self.spectrum:
                self.spectrum.update_bandwidth(low, high)

            # Update waterfall display bandwidth visualization
            if self.waterfall_display:
                self.waterfall_display.update_bandwidth(low, high)

            # Update audio spectrum display bandwidth
            if self.audio_spectrum_display:
                self.audio_spectrum_display.update_bandwidth(low, high)

            # Update waterfall window's spectrum and waterfall if open
            if hasattr(self, 'waterfall_spectrum') and self.waterfall_spectrum:
                self.waterfall_spectrum.update_bandwidth(low, high)
            if hasattr(self, 'waterfall_waterfall') and self.waterfall_waterfall:
                self.waterfall_waterfall.update_bandwidth(low, high)

            # Only update client if it exists (connected)
            if self.client:
                self.client.bandwidth_low = low
                self.client.bandwidth_high = high
            self.log_status(f"Bandwidth set for {mode.upper()}: {low} to {high} Hz")
        else:
            # Unknown mode - keep current bandwidth
            self.log_status(f"Unknown mode {mode.upper()} - keeping current bandwidth")

    def update_bandwidth_slider_bounds(self, mode: str):
        """Update bandwidth slider bounds based on mode.

        Args:
            mode: Current mode (e.g., 'usb', 'lsb', 'am', etc.)
        """
        # Mode-specific slider bounds (low_min, low_max, high_min, high_max)
        mode_bounds = {
            'am': (-10000, -200, 200, 10000),
            'sam': (-10000, -200, 200, 10000),
            'usb': (0, 200, 400, 4000),
            'lsb': (-400, -4000, 0, -200),
            'fm': (-10000, -200, 200, 10000),
            'nfm': (-5000, -200, 200, 5000),
            'cwu': (-100, -500, 100, 500),
            'cwl': (-100, -500, 100, 500),
        }

        # Check if this is an IQ mode
        is_iq_mode = mode in ['iq', 'iq48', 'iq96', 'iq192', 'iq384']

        if is_iq_mode:
            # Disable sliders for IQ modes
            self.bw_low_scale.config(state='disabled')
            self.bw_high_scale.config(state='disabled')
            # Only log if status_text exists (after full initialization)
            if hasattr(self, 'status_text'):
                self.log_status(f"Bandwidth sliders disabled for {mode.upper()} mode")
        else:
            # Enable sliders for non-IQ modes
            self.bw_low_scale.config(state='normal')
            self.bw_high_scale.config(state='normal')

            # Get bounds for current mode
            if mode in mode_bounds:
                low_min, low_max, high_min, high_max = mode_bounds[mode]

                # Update slider ranges
                self.bw_low_scale.config(from_=low_min, to=low_max)
                self.bw_high_scale.config(from_=high_min, to=high_max)

                # Only log if status_text exists (after full initialization)
                if hasattr(self, 'status_text'):
                    self.log_status(f"Bandwidth bounds for {mode.upper()}: Low [{low_min} to {low_max}], High [{high_min} to {high_max}]")
            else:
                # Unknown mode - use default wide range
                self.bw_low_scale.config(from_=-10000, to=10000)
                self.bw_high_scale.config(from_=-10000, to=10000)

    def update_preset_buttons(self):
        """Update bandwidth preset buttons based on current mode."""
        mode_display = self.mode_var.get()
        mode = self._parse_mode_name(mode_display)

        # Define mode-specific presets
        mode_presets = {
            'usb': [
                ("Narrow", 200, 2400),
                ("Medium", 50, 2700),
                ("Wide", 50, 3500),
            ],
            'lsb': [
                ("Narrow", -2400, -200),
                ("Medium", -2700, -50),
                ("Wide", -3500, -50),
            ],
            'am': [
                ("Narrow", -3000, 3000),
                ("Medium", -5000, 5000),
                ("Wide", -6000, 6000),
            ],
            'sam': [
                ("Narrow", -3000, 3000),
                ("Medium", -5000, 5000),
                ("Wide", -6000, 6000),
            ],
            'cwu': [
                ("Narrow", -100, 100),
                ("Medium", -200, 200),
                ("Wide", -300, 300),
            ],
            'cwl': [
                ("Narrow", -100, 100),
                ("Medium", -200, 200),
                ("Wide", -300, 300),
            ],
            'fm': [
                ("Narrow", -6000, 6000),
                ("Medium", -8000, 8000),
                ("Wide", -10000, 10000),
            ],
            'nfm': [
                ("Narrow", -3000, 3000),
                ("Medium", -5000, 5000),
                ("Wide", -6000, 6000),
            ],
        }

        # Get presets for current mode (default to USB if unknown)
        presets = mode_presets.get(mode, mode_presets['usb'])

        # Create buttons on first call, otherwise just update their commands
        if not self.preset_buttons:
            # Create preset buttons for the first time
            for i, (label, low, high) in enumerate(presets):
                btn = ttk.Button(self.preset_frame, text=label, width=8,
                               command=lambda l=low, h=high: self.set_bandwidth(l, h))
                btn.grid(row=0, column=i+1, padx=2)
                self.preset_buttons.append(btn)
        else:
            # Update existing button commands with new preset values
            for i, (label, low, high) in enumerate(presets):
                if i < len(self.preset_buttons):
                    self.preset_buttons[i].config(command=lambda l=low, h=high: self.set_bandwidth(l, h))

    def send_tune_message(self):
        """Send tune message to change frequency/mode/bandwidth without reconnecting."""
        if not self.client or not self.client.ws:
            self.log_status("ERROR: Not connected - cannot send tune message")
            return

        try:
            import json
            # Check if this is an IQ mode (bandwidth should not be sent for IQ modes)
            is_iq_mode = self.client.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')

            tune_msg = {
                'type': 'tune',
                'frequency': self.client.frequency,
                'mode': self.client.mode
            }

            # Only include bandwidth for non-IQ modes
            if not is_iq_mode:
                tune_msg['bandwidthLow'] = self.client.bandwidth_low
                tune_msg['bandwidthHigh'] = self.client.bandwidth_high

            # Send the tune message via WebSocket using the async event loop
            if self.event_loop and self.event_loop.is_running():
                # Schedule the coroutine in the client's event loop (fire-and-forget)
                asyncio.run_coroutine_threadsafe(
                    self.client.ws.send(json.dumps(tune_msg)),
                    self.event_loop
                )
                # Don't wait for completion - this prevents GUI freezing
                # self.log_status(f"Sent tune: {self.client.frequency/1e6:.3f} MHz {self.client.mode.upper()} ({self.client.bandwidth_low} to {self.client.bandwidth_high} Hz)")  # Removed: too verbose during rapid frequency changes
            else:
                self.log_status("ERROR: Event loop not running")
        except Exception as e:
            self.log_status(f"ERROR: Failed to send tune message: {e}")

    def reconnect_client(self):
        """Reconnect client with new settings (fallback method)."""
        if self.client:
            self.client.running = False
            # Client will reconnect automatically in the thread

    def toggle_connection(self):
        """Connect or disconnect the client."""
        if not self.connected:
            self.connect()
        else:
            self.disconnect()

    def connect(self):
        """Start the radio client connection."""
        try:
            # Import RadioClient here to avoid circular import issues
            from radio_client import RadioClient

            # Parse server input - now using separate hostname and port fields
            hostname = self.server_var.get().strip()
            if not hostname:
                messagebox.showerror("Error", "Please enter a server hostname")
                return

            try:
                port = int(self.port_var.get().strip())
            except ValueError:
                messagebox.showerror("Error", "Invalid port number")
                return

            # Check if full URL was provided in hostname field
            if '://' in hostname:
                url = hostname
                host = None
                port = None
            else:
                url = None
                host = hostname

            # Get frequency and mode
            frequency = self.get_frequency_hz()
            mode_display = self.mode_var.get()
            mode = self._parse_mode_name(mode_display)

            # Get bandwidth
            try:
                bandwidth_low = int(self.bw_low_var.get())
                bandwidth_high = int(self.bw_high_var.get())
            except ValueError:
                bandwidth_low = None
                bandwidth_high = None

            # Get volume and channel settings from GUI
            volume = self.volume_var.get() / 100.0  # Convert percentage to gain
            channel_left = self.channel_left_var.get()
            channel_right = self.channel_right_var.get()

            # Get FIFO path from GUI
            fifo_path = self.fifo_var.get().strip()
            if not fifo_path:
                fifo_path = None

            # Get output mode from config (defaults to sounddevice if not specified)
            output_mode = self.config.get('output_mode', 'sounddevice')

            # Get selected device (device index or None for default)
            device_index = self.get_selected_device()

            # Get UDP settings
            udp_enabled = self.udp_enabled_var.get()
            udp_host = self.udp_host_var.get().strip() if udp_enabled else None
            udp_port = None
            udp_stereo = self.udp_stereo_var.get()
            if udp_enabled:
                try:
                    udp_port = int(self.udp_port_var.get().strip())
                except ValueError:
                    udp_enabled = False
                    udp_host = None

            # Create client (disable auto_reconnect for GUI - we'll handle retries)
            # Start with audio muted (volume=0) - will be enabled after window opens
            client_kwargs = {
                'url': url,
                'host': host,
                'port': port,
                'frequency': frequency,
                'mode': mode,
                'bandwidth_low': bandwidth_low,
                'bandwidth_high': bandwidth_high,
                'output_mode': output_mode,
                'auto_reconnect': False,  # GUI handles connection attempts
                'status_callback': lambda msg_type, msg: self.status_queue.put((msg_type, msg)),
                'volume': 0,  # Start muted, will unmute after window opens
                'channel_left': channel_left,
                'channel_right': channel_right,
                'audio_level_callback': lambda level_db: self.audio_level_queue.put(level_db),
                'recording_callback': self.add_recording_frame,
                'ssl': self.tls_var.get(),  # Use TLS if checkbox is checked
                'fifo_path': fifo_path,  # Pass FIFO path to client
                'password': self.config.get('password'),  # Pass password from config
                'udp_enabled': udp_enabled,
                'udp_host': udp_host,
                'udp_port': udp_port,
                'udp_stereo': udp_stereo,
                'use_opus': self.opus_var.get(),  # Pass Opus setting to client
                'opus_active_callback': self.on_opus_active,  # Callback when Opus packets received
            }

            # Add device index parameter based on output mode
            if output_mode == 'sounddevice':
                client_kwargs['sounddevice_device_index'] = device_index
            else:
                client_kwargs['pyaudio_device_index'] = device_index

            self.client = RadioClient(**client_kwargs)

            # Log the output mode being used
            self.log_status(f"Audio output mode: {output_mode}")

            # Store the desired volume to restore after window opens
            self.client._desired_volume = volume

            # Set connection timeout and retry parameters
            self.connection_attempts = 0
            self.max_connection_attempts = 3
            self.connection_timeout = 30  # seconds per attempt (increased for slower connections)

            # Reset cancel flag
            self.cancel_connection = False
            self.connecting = True

            # Start client in separate thread
            self.client_thread = threading.Thread(target=self.run_client, daemon=True)
            self.client_thread.start()

            # Update UI to show "Connecting..." state with Cancel button
            self.connect_btn.config(text="Connecting...", state='disabled')
            self.cancel_btn.grid()  # Show cancel button

            # Disable device selection, FIFO path, and UDP host/port while connecting/connected
            self.device_combo.config(state='disabled')
            self.refresh_devices_btn.config(state='disabled')
            if self.fifo_entry:
                self.fifo_entry.config(state='disabled')
            # Disable UDP host/port fields (checkbox remains enabled for on/off toggle)
            self.udp_host_entry.config(state='disabled')
            self.udp_port_entry.config(state='disabled')

            # Note: Spectrum connection is now handled in check_status_updates()
            # after connection is confirmed to be allowed

            # Construct server string for logging
            hostname = self.server_var.get().strip()
            port = self.port_var.get().strip()
            server_display = f"{hostname}:{port}" if ':' not in hostname else hostname
            self.log_status(f"Connecting to {server_display}...")

        except ValueError as e:
            messagebox.showerror("Error", f"Invalid input: {e}")
            self.log_status(f"ERROR: Invalid input - {e}")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to connect: {e}")
            self.log_status(f"ERROR: Failed to connect - {e}")

    def cancel_connection_attempt(self):
        """Cancel an in-progress connection attempt."""
        self.cancel_connection = True
        self.connecting = False
        if self.client:
            self.client.running = False
        self.log_status("Connection cancelled by user")

        # Update UI
        self.connect_btn.config(text="Connect", state='normal')
        self.cancel_btn.grid_remove()  # Hide cancel button
        self.apply_freq_btn.state(['disabled'])

    def disconnect(self):
        """Stop the radio client connection."""
        if self.client:
            self.client.running = False
            self.log_status("Disconnecting...")

        # Clear password from config so it's not reused on next connection
        if 'password' in self.config:
            del self.config['password']

        # Stop band state polling
        self.stop_band_state_polling()

        # Close waterfall window (which will disconnect its spectrum and waterfall)
        if self.waterfall_window and self.waterfall_window.winfo_exists():
            self.waterfall_window.destroy()
            self.waterfall_window = None
            self.waterfall_display = None
            self.log_status("Waterfall window closed")

        # Close audio spectrum window
        if self.audio_spectrum_window and self.audio_spectrum_window.winfo_exists():
            self.audio_spectrum_window.destroy()
            self.audio_spectrum_window = None
            self.audio_spectrum_display = None
            self.log_status("Audio spectrum window closed")

        # Close digital spots window
        if self.digital_spots_window and self.digital_spots_window.winfo_exists():
            self.digital_spots_window.destroy()
            self.digital_spots_window = None
            self.digital_spots_display = None
            self.log_status("Digital spots window closed")

        # Close CW spots window
        if self.cw_spots_window and self.cw_spots_window.winfo_exists():
            # Close graph window first if it exists
            if self.cw_spots_display and self.cw_spots_display.graph_window:
                if self.cw_spots_display.graph_window.window.winfo_exists():
                    self.cw_spots_display.graph_window.window.destroy()
                self.cw_spots_display.graph_window = None
            self.cw_spots_window.destroy()
            self.cw_spots_window = None
            self.cw_spots_display = None
            self.log_status("CW spots window closed")

        # Close band conditions window
        if self.band_conditions_window and self.band_conditions_window.winfo_exists():
            self.band_conditions_window.destroy()
            self.band_conditions_window = None
            self.band_conditions_display = None
            self.log_status("Band conditions window closed")

        # Close noise floor window
        if self.noise_floor_window and self.noise_floor_window.winfo_exists():
            self.noise_floor_window.destroy()
            self.noise_floor_window = None
            self.noise_floor_display = None
            self.log_status("Noise floor window closed")

        # Close space weather window
        if self.space_weather_window and self.space_weather_window.winfo_exists():
            self.space_weather_window.destroy()
            self.space_weather_window = None
            self.space_weather_display = None
            self.log_status("Space weather window closed")

        # Close rotator status window
        if self.rotator_status_window and self.rotator_status_window.winfo_exists():
            # Call on_close() to properly cleanup rotctl server before destroying
            if self.rotator_status_display:
                self.rotator_status_display.on_close()
            else:
                self.rotator_status_window.destroy()
            self.rotator_status_window = None
            self.rotator_status_display = None
            self.log_status("Rotator status window closed")

        # Close public instances window
        if self.public_instances_window and self.public_instances_window.winfo_exists():
            self.public_instances_window.destroy()
            self.public_instances_window = None
            self.log_status("Public instances window closed")

        # Close local instances window
        if self.local_instances_window and self.local_instances_window.winfo_exists():
            self.local_instances_window.destroy()
            self.local_instances_window = None
            self.local_instances_display = None
            self.log_status("Local instances window closed")

        # Close users window
        if self.users_window and self.users_window.winfo_exists():
            self.users_window.destroy()
            self.users_window = None
            self.users_display = None
            self.log_status("Users window closed")

        # Close chat window
        if self.chat_window and self.chat_window.winfo_exists():
            self.chat_window.destroy()
            self.chat_window = None
            self.chat_display = None
            self.log_status("Chat window closed")

        # Close EQ window
        if self.eq_window and self.eq_window.winfo_exists():
            self.eq_window.destroy()
            self.eq_window = None
            self.eq_display = None
            self.log_status("EQ window closed")

        # Clean up shared DX cluster WebSocket manager
        # Note: Actual disconnection happens automatically when last callback is removed
        if self.dxcluster_ws:
            # Force disconnect in case there are lingering connections
            if self.dxcluster_ws.running:
                self.dxcluster_ws.disconnect()
            self.dxcluster_ws = None
            self.log_status("DX cluster WebSocket manager cleaned up")

        # Disconnect main spectrum display (in main window)
        if self.spectrum:
            self.spectrum.disconnect()
            self.log_status("Spectrum display disconnected")

        # Clear waterfall spectrum/waterfall references
        if hasattr(self, 'waterfall_spectrum'):
            self.waterfall_spectrum = None
        if hasattr(self, 'waterfall_waterfall'):
            self.waterfall_waterfall = None

        # Update UI
        self.connected = False
        self.connect_btn.config(text="Connect")
        self.apply_freq_btn.state(['disabled'])
        self.rec_btn.state(['disabled'])

        # Reset Opus indicator
        if self.opus_active:
            self.opus_check.configure(style='Opus.TCheckbutton')
            self.opus_active = False

        # Hide receiver info and session timer
        self.receiver_info_frame.grid_remove()
        self.receiver_name_var.set("")
        self.receiver_version_var.set("")
        self.stop_session_timer()

        # Hide spots buttons
        if self.digital_spots_btn:
            self.digital_spots_btn.pack_forget()
        if self.cw_spots_btn:
            self.cw_spots_btn.pack_forget()

        # Stop recording if active
        if self.recording:
            self.stop_recording()

        # Re-enable device selection, FIFO path, and UDP host/port
        self.device_combo.config(state='readonly')
        self.refresh_devices_btn.config(state='normal')
        if self.fifo_entry:
            self.fifo_entry.config(state='normal')
        # Re-enable UDP host/port fields
        self.udp_host_entry.config(state='normal')
        self.udp_port_entry.config(state='normal')

    def run_client(self):
        """Run the client in a separate thread with its own event loop."""
        # Create new event loop for this thread
        self.event_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.event_loop)

        attempt = 0
        max_attempts = self.max_connection_attempts

        while attempt < max_attempts and not self.cancel_connection:
            attempt += 1

            if attempt > 1:
                self.status_queue.put(("info", f"Connection attempt {attempt}/{max_attempts}..."))

            try:
                # Run client without timeout - it will run until disconnected
                # The connection check has its own timeout
                self.event_loop.run_until_complete(self.client.run())
                # If we get here, connection was successful and then closed normally
                self.status_queue.put(("info", "Client stopped"))
                break

            except ConnectionRefusedError:
                if self.cancel_connection:
                    break
                if attempt < max_attempts:
                    self.status_queue.put(("error", f"Connection refused (attempt {attempt}/{max_attempts})"))
                else:
                    self.status_queue.put(("error", f"Connection refused - server not reachable after {max_attempts} attempts"))
                    self.status_queue.put(("connection_failed", None))

            except Exception as e:
                if self.cancel_connection:
                    break
                if attempt < max_attempts:
                    self.status_queue.put(("error", f"Connection error: {e} (attempt {attempt}/{max_attempts})"))
                else:
                    self.status_queue.put(("error", f"Connection failed: {e} (after {max_attempts} attempts)"))
                    self.status_queue.put(("connection_failed", None))

        self.event_loop.close()

        # If cancelled, send cancellation message
        if self.cancel_connection:
            self.status_queue.put(("connection_cancelled", None))
        else:
            self.status_queue.put(("disconnected", None))

    def check_status_updates(self):
        """Check for status updates from the client thread."""
        try:
            # Check if connection was rejected and needs password
            if self.client and hasattr(self.client, 'connection_rejected') and self.client.connection_rejected:
                self.client.connection_rejected = False  # Reset flag
                reason = getattr(self.client, 'rejection_reason', 'Connection not allowed')

                # Prompt user for bypass password
                password = simpledialog.askstring(
                    "Connection Rejected",
                    f"{reason}\n\nEnter bypass password (or Cancel to abort):",
                    show='*'
                )

                if password:
                    # User provided password - retry connection
                    self.log_status("Retrying connection with bypass password...")
                    self.client.password = password
                    self.config['password'] = password  # Store for future use

                    # Reset client state and retry
                    self.client.running = True
                    self.client.connection_rejected = False

                    # Restart client thread
                    self.client_thread = threading.Thread(target=self.run_client, daemon=True)
                    self.client_thread.start()
                else:
                    # User cancelled - stop connection attempt
                    self.log_status("Connection cancelled by user")
                    self.connected = False
                    self.connecting = False
                    self.connect_btn.config(text="Connect", state='normal')
                    self.cancel_btn.grid_remove()
                    self.apply_freq_btn.state(['disabled'])

            while True:
                msg_type, msg = self.status_queue.get_nowait()

                if msg_type == "info":
                    self.log_status(msg)
                    # Check if this is a successful connection message
                    # Look for WebSocket connection or audio stream start
                    if any(keyword in msg.lower() for keyword in ["connected", "websocket", "receiving audio", "stream"]):
                        # Update UI to show connected state
                        self.connected = True
                        self.connecting = False
                        self.connect_btn.config(text="Disconnect", state='normal')
                        self.cancel_btn.grid_remove()  # Hide cancel button
                        self.apply_freq_btn.state(['!disabled'])
                        self.rec_btn.state(['!disabled'])
                        if "✓" not in msg:  # Don't duplicate success message
                            self.log_status("✓ Successfully connected!")

                        # Update receiver info (name, version, map link) and session timer
                        if self.client and hasattr(self.client, 'server_description'):
                            desc = self.client.server_description

                            # Get receiver callsign, name, and location
                            callsign = desc.get('receiver', {}).get('callsign', '')
                            receiver_name = desc.get('receiver', {}).get('name', '')
                            location = desc.get('receiver', {}).get('location', '')

                            # Build display string: callsign - name - location
                            display_parts = []
                            if callsign:
                                display_parts.append(callsign)
                            if receiver_name:
                                display_parts.append(receiver_name)
                            if location:
                                display_parts.append(location)

                            receiver_display = ' - '.join(display_parts)

                            # Truncate to 80 chars if needed
                            if receiver_display and len(receiver_display) > 80:
                                receiver_display = receiver_display[:77] + '...'

                            # Get version from root of JSON
                            version = desc.get('version', '')

                            # Get public_url from receiver object in JSON
                            public_url = desc.get('receiver', {}).get('public_url', '')

                            # Get GPS coordinates
                            gps = desc.get('receiver', {}).get('gps', {})
                            has_gps = gps.get('lat') is not None and gps.get('lon') is not None

                            # Update display if we have any info
                            if receiver_display or version or has_gps:
                                if receiver_display:
                                    self.receiver_name_var.set(receiver_display)

                                    # Make receiver name clickable if public_url is not default
                                    if public_url and public_url != 'https://example.com':
                                        self.receiver_name_label.config(foreground='blue', cursor='hand2')
                                        self.receiver_name_label.bind('<Button-1>', self.open_receiver_url)
                                    else:
                                        self.receiver_name_label.config(foreground='black', cursor='')
                                        self.receiver_name_label.unbind('<Button-1>')

                                if version:
                                    self.receiver_version_var.set(f"v{version}")

                                # Show/hide map link based on GPS availability
                                if has_gps:
                                    self.receiver_map_link.pack(side=tk.LEFT)
                                    self.receiver_delimiter2.pack(side=tk.LEFT, before=self.receiver_map_link)
                                else:
                                    self.receiver_map_link.pack_forget()
                                    self.receiver_delimiter2.pack_forget()

                                # Show the receiver info frame
                                self.receiver_info_frame.grid()

                        # Check allowed IQ modes and show/hide second row of mode buttons
                        if self.client and hasattr(self.client, 'allowed_iq_modes'):
                            allowed_iq_modes = self.client.allowed_iq_modes

                            # Show/hide each IQ mode button based on allowed list
                            for mode_value, btn in self.mode_buttons.items():
                                if mode_value in ['IQ48', 'IQ96', 'IQ192', 'IQ384']:
                                    # Check if this mode is in the allowed list (case-insensitive)
                                    mode_lower = mode_value.lower()
                                    if mode_lower in allowed_iq_modes:
                                        btn.grid()
                                    else:
                                        btn.grid_remove()

                            # Log which modes are available
                            if allowed_iq_modes:
                                modes_str = ', '.join([m.upper() for m in allowed_iq_modes])
                                self.log_status(f"High bandwidth IQ modes enabled: {modes_str}")

                        # Connect spectrum display after connection is confirmed allowed
                        if self.spectrum and SPECTRUM_AVAILABLE:
                            def connect_spectrum_delayed():
                                try:
                                    # Build server string from hostname and port
                                    hostname = self.server_var.get().strip()
                                    port = self.port_var.get().strip()
                                    server = f"{hostname}:{port}" if ':' not in hostname else hostname
                                    # Get current frequency
                                    frequency = self.get_frequency_hz()
                                    # Pass the audio channel's user_session_id, TLS setting, and password to spectrum
                                    use_tls = self.tls_var.get()
                                    password = self.config.get('password')
                                    self.spectrum.connect(server, frequency, self.client.user_session_id, use_tls=use_tls, password=password)
                                    # Set tuned frequency for bandwidth filter visualization
                                    self.spectrum.tuned_freq = frequency
                                    self.log_status("Spectrum display connected")
                                except Exception as e:
                                    self.log_status(f"Spectrum display error: {e}")

                            # Delay spectrum connection by 2000ms (2 seconds) to allow audio connection to establish
                            # and avoid rate limiting (HTTP 429)
                            self.root.after(2000, connect_spectrum_delayed)

                        # Start session timer (always show, displays "Unlimited" if max_session_time=0)
                        if self.client and hasattr(self.client, 'max_session_time'):
                            self.max_session_time = self.client.max_session_time
                            if hasattr(self.client, 'connection_start_time'):
                                self.connection_start_time = self.client.connection_start_time
                            self.log_status(f"DEBUG: max_session_time={self.max_session_time}, connection_start_time={self.connection_start_time}")
                            self.start_session_timer()

                        # Show spots buttons based on server capabilities
                        if self.client and hasattr(self.client, 'server_description'):
                            desc = self.client.server_description

                            # Pack them before the Scroll label by using pack with before parameter
                            # Find the Scroll label widget to insert before it
                            button_frame = self.digital_spots_btn.master if self.digital_spots_btn else (self.cw_spots_btn.master if self.cw_spots_btn else None)
                            if button_frame:
                                # Find the "Scroll:" label widget
                                scroll_label = None
                                for widget in button_frame.winfo_children():
                                    if isinstance(widget, ttk.Label) and widget.cget('text') == 'Scroll:':
                                        scroll_label = widget
                                        break

                                # Pack digital spots button if enabled
                                if self.digital_spots_btn and desc.get('digital_decodes', False):
                                    if scroll_label:
                                        self.digital_spots_btn.pack(side=tk.LEFT, padx=(0, 5), before=scroll_label)
                                    else:
                                        self.digital_spots_btn.pack(side=tk.LEFT, padx=(0, 5))
                                elif self.digital_spots_btn:
                                    self.digital_spots_btn.pack_forget()

                                # Pack CW spots button if enabled (either server has CW Skimmer OR TCI is active)
                                # TCI can report spots too, so enable button when TCI is connected
                                tci_active = (self.radio_control_type == 'tci_server' and self.radio_control_connected)
                                if self.cw_spots_btn and (desc.get('cw_skimmer', False) or tci_active):
                                    if scroll_label:
                                        self.cw_spots_btn.pack(side=tk.LEFT, padx=(0, 5), before=scroll_label)
                                    else:
                                        self.cw_spots_btn.pack(side=tk.LEFT, padx=(0, 5))
                                elif self.cw_spots_btn:
                                    self.cw_spots_btn.pack_forget()

                                # Pack noise floor button if enabled
                                if self.noise_floor_btn and desc.get('noise_floor', False):
                                    if scroll_label:
                                        self.noise_floor_btn.pack(side=tk.LEFT, padx=(0, 5), before=scroll_label)
                                    else:
                                        self.noise_floor_btn.pack(side=tk.LEFT, padx=(0, 5))
                                elif self.noise_floor_btn:
                                    self.noise_floor_btn.pack_forget()

                                # Pack chat button if enabled
                                if self.chat_btn and desc.get('chat_enabled', False):
                                    if scroll_label:
                                        self.chat_btn.pack(side=tk.LEFT, padx=(0, 5), before=scroll_label)
                                    else:
                                        self.chat_btn.pack(side=tk.LEFT, padx=(0, 5))
                                    self.log_status("Chat enabled on this server")

                                    # Auto-open chat window if there's a saved username for this instance
                                    instance_uuid = desc.get('public_uuid', '')
                                    if instance_uuid and CHAT_AVAILABLE:
                                        saved_username = get_saved_username_for_instance(instance_uuid)
                                        if saved_username:
                                            # Delay opening chat window to allow UI to fully initialize
                                            self.root.after(500, self.open_chat_window)
                                            self.log_status(f"Auto-opening chat (saved username: '{saved_username}')")
                                elif self.chat_btn:
                                    self.chat_btn.pack_forget()

                                # Pack rotator button if enabled and connected
                                rotator_enabled = desc.get('rotator', {}).get('enabled', False)
                                rotator_connected = desc.get('rotator', {}).get('connected', False)
                                if self.rotator_btn and rotator_enabled and rotator_connected:
                                    if scroll_label:
                                        self.rotator_btn.pack(side=tk.LEFT, padx=(0, 5), before=scroll_label)
                                    else:
                                        self.rotator_btn.pack(side=tk.LEFT, padx=(0, 5))
                                    self.log_status("Rotator control available on this server")
                                elif self.rotator_btn:
                                    self.rotator_btn.pack_forget()

                            # Print loading message before opening GUI windows
                            print("Loading GUI (may take a moment)...", file=sys.stderr)

                            # Auto-open waterfall window first (main display window)
                            if WATERFALL_AVAILABLE:
                                # Open waterfall after GUI is fully ready (5000ms delay)
                                # This ensures all Tkinter widgets are properly initialized
                                def open_waterfall_and_unmute():
                                    try:
                                        # Force GUI update before opening waterfall
                                        self.root.update_idletasks()
                                        self.auto_open_waterfall()
                                        # Unmute audio after waterfall window opens (500ms delay)
                                        self.root.after(500, self.unmute_audio)
                                    except Exception as e:
                                        # If waterfall fails to open, still unmute audio
                                        self.log_status(f"Waterfall auto-open failed: {e}")
                                        self.unmute_audio()
                                self.root.after(5000, open_waterfall_and_unmute)

                            # Auto-open audio spectrum window on successful connection (but not for IQ modes)
                            if AUDIO_SPECTRUM_AVAILABLE:
                                # Check if current mode is IQ before opening
                                mode_display = self.mode_var.get()
                                mode = self._parse_mode_name(mode_display)
                                is_iq_mode = mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')
                                if not is_iq_mode:
                                    # Delay audio spectrum opening slightly
                                    self.root.after(600, self.auto_open_audio_spectrum)

                            # Auto-open CW spots window if enabled (disabled by default)
                            # Add 2000ms delay (same as spectrum) before connecting DX cluster WebSocket
                            # if self.client and hasattr(self.client, 'server_description'):
                            #     desc = self.client.server_description
                            #     if CW_SPOTS_AVAILABLE and desc.get('cw_skimmer', False):
                            #         self.root.after(2800, self.auto_open_cw_spots)

                            # Auto-open users window on successful connection
                            if USERS_AVAILABLE:
                                self.root.after(700, self.open_users_window)

                            # Fetch bookmarks and bands after connection is established
                            self.root.after(500, self.fetch_bookmarks)
                            self.root.after(600, self.fetch_bands)

                            # Start band state polling after connection is established
                            # Add delay to allow other connections to establish first
                            self.root.after(3000, self.start_band_state_polling)

                elif msg_type == "error":
                    self.log_status(f"ERROR: {msg}")
                elif msg_type == "wasapi_warning":
                    # WASAPI warning - show popup and log to status
                    self.log_status(f"WARNING: {msg}")
                    messagebox.showwarning("Audio Device Warning", msg)
                elif msg_type == "server_error":
                    # Server error - show alert box AND log to status
                    self.log_status(f"SERVER ERROR: {msg}")
                    messagebox.showerror("Server Error", msg)
                elif msg_type == "connection_failed":
                    # Connection attempt failed
                    self.connected = False
                    self.connecting = False
                    self.connect_btn.config(text="Connect", state='normal')
                    self.cancel_btn.grid_remove()  # Hide cancel button
                    self.apply_freq_btn.state(['disabled'])
                    self.log_status("✗ Connection failed")
                elif msg_type == "connection_cancelled":
                    # Connection cancelled by user
                    self.connected = False
                    self.connecting = False
                    self.connect_btn.config(text="Connect", state='normal')
                    self.cancel_btn.grid_remove()  # Hide cancel button
                    self.apply_freq_btn.state(['disabled'])
                elif msg_type == "disconnected":
                    if self.connected:
                        self.disconnect()

        except queue.Empty:
            pass

        # Schedule next check
        self.root.after(100, self.check_status_updates)

    def toggle_recording(self):
        """Toggle audio recording on/off."""
        if not self.recording:
            self.start_recording()
        else:
            self.stop_recording()

    def start_recording(self):
        """Start recording audio."""
        if not self.connected or not self.client:
            messagebox.showerror("Error", "Not connected to server")
            return

        import time
        self.recording = True
        self.recording_start_time = time.time()
        self.recording_data = []

        # Update UI
        self.rec_btn.config(text="⏹ Stop")
        self.rec_status_label.config(text="Recording...")
        self.log_status("Recording started (mono, max 300s)")

        # Start recording timer check
        self.check_recording_duration()

    def stop_recording(self):
        """Stop recording and prompt to save."""
        if not self.recording:
            return

        import time
        self.recording = False
        elapsed = time.time() - self.recording_start_time if self.recording_start_time else 0

        # Update UI
        self.rec_btn.config(text="⏺ Record")
        self.rec_status_label.config(text="")

        # Check if we have data
        if not self.recording_data:
            self.log_status("Recording stopped (no data)")
            return

        self.log_status(f"Recording stopped ({elapsed:.1f}s, {len(self.recording_data)} frames)")

        # Prompt for save location
        filename = filedialog.asksaveasfilename(
            defaultextension=".wav",
            filetypes=[("WAV files", "*.wav"), ("All files", "*.*")],
            title="Save Recording As"
        )

        if filename:
            self.save_recording(filename)
        else:
            self.log_status("Recording discarded")
            self.recording_data = []

    def save_recording(self, filename: str):
        """Save recorded audio to WAV file."""
        try:
            import wave
            import numpy as np

            # Concatenate all recorded frames
            audio_data = np.concatenate(self.recording_data)

            # Open WAV file
            with wave.open(filename, 'wb') as wav_file:
                wav_file.setnchannels(1)  # Mono
                wav_file.setsampwidth(2)  # 16-bit
                wav_file.setframerate(self.client.sample_rate)

                # Convert float32 to int16
                audio_int16 = np.clip(audio_data * 32768.0, -32768, 32767).astype(np.int16)
                wav_file.writeframes(audio_int16.tobytes())

            self.log_status(f"Recording saved: {filename}")
            self.recording_data = []

        except Exception as e:
            messagebox.showerror("Error", f"Failed to save recording: {e}")
            self.log_status(f"ERROR: Failed to save recording - {e}")

    def check_recording_duration(self):
        """Check if recording has reached the time limit."""
        if not self.recording:
            return

        import time
        elapsed = time.time() - self.recording_start_time
        remaining = self.recording_max_duration - elapsed

        if remaining <= 0:
            # Time limit reached
            self.log_status(f"Recording limit reached ({self.recording_max_duration}s)")
            self.stop_recording()
        else:
            # Update status with remaining time
            self.rec_status_label.config(text=f"Recording... ({int(remaining)}s remaining)")
            # Check again in 1 second
            self.root.after(1000, self.check_recording_duration)

    def add_recording_frame(self, audio_float):
        """Add audio frame to recording buffer (called from client).

        Args:
            audio_float: Mono audio data as float32 numpy array (normalized -1.0 to 1.0)
        """
        if self.recording:
            self.recording_data.append(audio_float.copy())

        # Also send to audio spectrum display if open
        if self.audio_spectrum_display:
            self.audio_spectrum_display.add_audio_data(audio_float)

    def format_time(self, seconds: int) -> str:
        """Format seconds as MM:SS."""
        minutes = seconds // 60
        secs = seconds % 60
        return f"{minutes:02d}:{secs:02d}"

    def start_session_timer(self):
        """Start the session countdown timer."""
        self.log_status(f"DEBUG: start_session_timer called - max_session_time={self.max_session_time}, connection_start_time={self.connection_start_time}")

        # Always show the timer label when connected
        self.session_timer_label.grid()

        if self.max_session_time <= 0:
            # No time limit - show "Unlimited" in blue
            self.session_timer_var.set("Session: Unlimited")
            self.session_timer_label.config(foreground='blue')
            self.log_status("Session timer: Unlimited")
        else:
            # Has time limit - start countdown
            self.log_status(f"Session timer: {self.max_session_time} seconds")
            self.update_session_timer()

    def update_session_timer(self):
        """Update the session timer display."""
        if not self.connected:
            return

        if self.max_session_time <= 0:
            # No time limit - blue
            self.session_timer_var.set("Session: Unlimited")
            self.session_timer_label.config(foreground='blue')
            return

        if self.connection_start_time is None:
            self.log_status("DEBUG: connection_start_time is None, cannot update timer")
            return

        # Calculate elapsed time
        import time
        elapsed = time.time() - self.connection_start_time
        remaining = max(0, self.max_session_time - int(elapsed))

        # Update display
        self.session_timer_var.set(f"Session: {self.format_time(remaining)}")

        # Change color based on remaining time
        # Blue when > 5 minutes (300 seconds), red when ≤ 5 minutes
        if remaining > 300:
            self.session_timer_label.config(foreground='blue')
        else:
            self.session_timer_label.config(foreground='red')

        # Schedule next update if still connected
        if self.connected and remaining > 0:
            self.session_timer_job = self.root.after(1000, self.update_session_timer)
        elif remaining == 0:
            self.session_timer_var.set("Session: 00:00")
            self.session_timer_label.config(foreground='red')

    def stop_session_timer(self):
        """Stop the session countdown timer."""
        if self.session_timer_job:
            self.root.after_cancel(self.session_timer_job)
            self.session_timer_job = None

        # Hide the timer label
        self.session_timer_label.grid_remove()
        self.session_timer_var.set("")

    def open_receiver_url(self, event=None):
        """Open the receiver's public URL in default browser."""
        if not self.client or not hasattr(self.client, 'server_description'):
            return

        desc = self.client.server_description
        public_url = desc.get('receiver', {}).get('public_url', '')

        if not public_url or public_url == 'https://example.com':
            return

        # Open URL in default browser
        import webbrowser
        try:
            webbrowser.open(public_url)
            self.log_status(f"Opened receiver URL: {public_url}")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to open URL: {e}")
            self.log_status(f"ERROR: Failed to open URL - {e}")

    def open_receiver_map(self, event=None):
        """Open UberSDR instances map with receiver UUID."""
        if not self.client or not hasattr(self.client, 'server_description'):
            return

        desc = self.client.server_description
        public_uuid = desc.get('public_uuid', '')

        if not public_uuid:
            messagebox.showinfo("No UUID", "Public UUID not available for this receiver")
            return

        # Open UberSDR instances map in default browser
        import webbrowser
        map_url = f"https://instances.ubersdr.org/?uuid={public_uuid}"
        try:
            webbrowser.open(map_url)
            self.log_status(f"Opened instance map: {public_uuid}")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to open map: {e}")
            self.log_status(f"ERROR: Failed to open map - {e}")

    def on_closing(self):
        """Handle window close event."""
        if self.connected:
            self.disconnect()

        # Stop session timer
        self.stop_session_timer()

        # Disconnect rigctl if connected
        if self.rigctl_connected:
            self.disconnect_rigctl()

        # Close waterfall window if open
        if self.waterfall_window and self.waterfall_window.winfo_exists():
            self.waterfall_window.destroy()

        # Close audio spectrum window if open
        if self.audio_spectrum_window and self.audio_spectrum_window.winfo_exists():
            self.audio_spectrum_window.destroy()

        # Close digital spots window if open
        if self.digital_spots_window and self.digital_spots_window.winfo_exists():
            self.digital_spots_window.destroy()

        # Close CW spots window if open
        if self.cw_spots_window and self.cw_spots_window.winfo_exists():
            self.cw_spots_window.destroy()

        # Close band conditions window if open
        if self.band_conditions_window and self.band_conditions_window.winfo_exists():
            self.band_conditions_window.destroy()

        # Close noise floor window if open
        if self.noise_floor_window and self.noise_floor_window.winfo_exists():
            self.noise_floor_window.destroy()

        # Close space weather window if open
        if self.space_weather_window and self.space_weather_window.winfo_exists():
            self.space_weather_window.destroy()

        # Close rotator status window if open
        if self.rotator_status_window and self.rotator_status_window.winfo_exists():
            self.rotator_status_window.destroy()

        # Close public instances window if open
        if self.public_instances_window and self.public_instances_window.winfo_exists():
            self.public_instances_window.destroy()

        # Close local instances window if open
        if self.local_instances_window and self.local_instances_window.winfo_exists():
            self.local_instances_window.destroy()
            self.local_instances_display = None

        # Close users window if open
        if self.users_window and self.users_window.winfo_exists():
            self.users_window.destroy()

        # Close chat window if open
        if self.chat_window and self.chat_window.winfo_exists():
            self.chat_window.destroy()

        # Close EQ window if open
        if self.eq_window and self.eq_window.winfo_exists():
            self.eq_window.destroy()

        # Disconnect MIDI controller if active
        if self.midi_controller:
            self.midi_controller.disconnect()
            self.midi_controller = None
        self.midi_window = None

        # Clean up shared DX cluster WebSocket manager
        if self.dxcluster_ws:
            # Force disconnect in case there are lingering connections
            if self.dxcluster_ws.running:
                self.dxcluster_ws.disconnect()
            self.dxcluster_ws = None

        # Stop recording if active
        if self.recording:
            self.stop_recording()

        # Wait a bit for cleanup
        self.root.after(500, self.root.destroy)


def main(config=None):
    """Main entry point for GUI mode."""
    # Use provided config or defaults
    if config is None:
        config = {
            'url': None,
            'host': 'localhost',
            'port': 8080,
            'frequency': 14100000,
            'mode': 'usb',
            'bandwidth_low': 50,      # USB defaults (positive bandwidth)
            'bandwidth_high': 2700,
            'ssl': False
        }

    # Create and run GUI
    root = tk.Tk()
    app = RadioGUI(root, config)

    # Auto-connect to rigctl if specified in config
    if config.get('rigctl_host') and config.get('rigctl_port'):
        # Schedule rigctl connection after GUI is ready
        def auto_connect_rigctl():
            try:
                app.connect_rigctl()
                # Sync starts automatically on connect
            except Exception as e:
                app.log_status(f"Auto-connect to rigctl failed: {e}")

        root.after(500, auto_connect_rigctl)

    root.mainloop()


if __name__ == '__main__':
    # CRITICAL: freeze_support() must be the FIRST thing called in __main__
    # It detects if this is a spawned child process in a frozen executable and exits
    import multiprocessing
    multiprocessing.freeze_support()

    import argparse

    parser = argparse.ArgumentParser(description='ka9q_ubersdr Radio GUI Client')
    parser.add_argument('--host', type=str, help='Server host')
    parser.add_argument('--port', type=int, help='Server port')
    parser.add_argument('--url', type=str, help='Server URL (alternative to host:port)')
    parser.add_argument('--frequency', type=float, help='Initial frequency in MHz')
    parser.add_argument('--mode', type=str, help='Initial mode (USB, LSB, etc.)')
    parser.add_argument('--ssl', action='store_true', help='Use TLS/SSL')
    parser.add_argument('--auto-connect', action='store_true', help='Auto-connect on startup')
    parser.add_argument('--rigctl-host', type=str, help='Rigctl host (e.g., localhost)')
    parser.add_argument('--rigctl-port', type=int, help='Rigctl port (default: 4532)')
    parser.add_argument('--rigctl-sync', action='store_true', help='Enable rigctl sync on connect')

    args = parser.parse_args()

    # Build config from arguments
    # Note: bandwidth defaults should already be set correctly by radio_client.py
    # based on the mode, so we don't override them here
    config = {
        'url': args.url,
        'host': args.host or 'localhost',
        'port': args.port or 8080,
        'frequency': int(args.frequency * 1e6) if args.frequency else 14100000,
        'mode': args.mode or 'usb',
        'bandwidth_low': 50,  # Default for USB, will be overridden by radio_client.py
        'bandwidth_high': 2700,  # Default for USB, will be overridden by radio_client.py
        'ssl': args.ssl,
        'auto_connect': args.auto_connect
    }

    # Add rigctl config if specified
    if args.rigctl_host:
        config['rigctl_host'] = args.rigctl_host
        config['rigctl_port'] = args.rigctl_port or 4532
        config['rigctl_sync'] = args.rigctl_sync

    # Call main() inside the guard to prevent execution during module import
    main(config)