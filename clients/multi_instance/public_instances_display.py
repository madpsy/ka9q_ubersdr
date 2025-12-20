#!/usr/bin/env python3
"""
Public Instances Display for UberSDR
Shows a list of public UberSDR instances and allows connecting to them.
"""

import tkinter as tk
from tkinter import ttk, messagebox
import requests
import threading
import webbrowser


def create_public_instances_window(parent, on_connect_callback, local_uuids=None):
    """Create a window showing public UberSDR instances.
    
    Args:
        parent: Parent tkinter window
        on_connect_callback: Callback function(host, port, tls, name, callsign) to call when connecting
        local_uuids: Optional set of UUIDs from local instances to highlight
    
    Returns:
        The created window
    """
    # Convert to set if provided as list, or use empty set
    if local_uuids is None:
        local_uuids = set()
    elif not isinstance(local_uuids, set):
        local_uuids = set(local_uuids)
    # Create new window
    window = tk.Toplevel(parent)
    window.title("Public UberSDR Instances")
    window.geometry("1040x500")

    # Main frame with padding
    main_frame = ttk.Frame(window, padding="10")
    main_frame.pack(fill=tk.BOTH, expand=True)

    # Status label
    status_label = ttk.Label(main_frame, text="Fetching public instances...", foreground='blue')
    status_label.pack(pady=(0, 10))

    # Create Treeview for instances list
    columns = ('name', 'callsign', 'location', 'users', 'session', 'cw', 'digi', 'noise', 'iq', 'version', 'url', 'map')
    tree = ttk.Treeview(main_frame, columns=columns, show='headings', height=15)

    # Track sort state for each column (column_name: reverse_bool)
    sort_state = {col: False for col in columns}

    def sort_column(col):
        """Sort tree contents when a column header is clicked."""
        # Get all items with their values
        items = [(tree.set(item, col), item) for item in tree.get_children('')]

        # Determine sort key based on column type
        def get_sort_key(value_item_tuple):
            value, item = value_item_tuple

            # Handle empty values
            if not value or value in ('', 'None'):
                return (1, '')  # Sort empty values to end

            # Users column: extract numbers from "X/Y" format
            if col == 'users':
                try:
                    available = int(value.split('/')[0])
                    return (0, available)
                except (ValueError, IndexError):
                    return (1, value)

            # Session column: extract minutes from "Xm" format
            elif col == 'session':
                try:
                    minutes = int(value.rstrip('m'))
                    return (0, minutes)
                except (ValueError, AttributeError):
                    return (1, value)

            # Checkmark columns (CW, Digi, Noise): sort ✓ before ✗
            elif col in ('cw', 'digi', 'noise'):
                return (0, 0 if value == '✓' else 1)

            # IQ column: parse comma-separated numbers
            elif col == 'iq':
                if value == 'None':
                    return (1, [])
                try:
                    # Parse all numbers from comma-separated list
                    numbers = [int(n.strip()) for n in value.split(',')]
                    # Sort by the list of numbers (compares element by element)
                    return (0, numbers)
                except (ValueError, AttributeError):
                    return (1, value)

            # Version column: try to parse as version number
            elif col == 'version':
                try:
                    # Split version into parts and convert to tuple of ints
                    parts = value.split('.')
                    version_tuple = tuple(int(p) for p in parts if p.isdigit())
                    return (0, version_tuple)
                except (ValueError, AttributeError):
                    return (1, value)

            # Text columns: case-insensitive sort
            else:
                return (0, value.lower())

        # Sort items
        items.sort(key=get_sort_key, reverse=sort_state[col])

        # Rearrange items in sorted order
        for index, (val, item) in enumerate(items):
            tree.move(item, '', index)

        # Toggle sort direction for next click
        sort_state[col] = not sort_state[col]

        # Update heading to show sort direction
        direction = '▼' if sort_state[col] else '▲'
        tree.heading(col, text=f"{tree.heading(col)['text'].split()[0]} {direction}")

        # Remove direction indicators from other columns
        for other_col in columns:
            if other_col != col:
                heading_text = tree.heading(other_col)['text']
                # Remove any existing direction indicators
                clean_text = heading_text.replace(' ▲', '').replace(' ▼', '')
                tree.heading(other_col, text=clean_text)

    # Define headings with sort command (except for action columns)
    tree.heading('name', text='Name', command=lambda: sort_column('name'))
    tree.heading('callsign', text='Callsign', command=lambda: sort_column('callsign'))
    tree.heading('location', text='Location', command=lambda: sort_column('location'))
    tree.heading('users', text='Users', command=lambda: sort_column('users'))
    tree.heading('session', text='Session', command=lambda: sort_column('session'))
    tree.heading('cw', text='CW', command=lambda: sort_column('cw'))
    tree.heading('digi', text='Digi', command=lambda: sort_column('digi'))
    tree.heading('noise', text='Noise', command=lambda: sort_column('noise'))
    tree.heading('iq', text='IQ (kHz)', command=lambda: sort_column('iq'))
    tree.heading('version', text='Version', command=lambda: sort_column('version'))
    tree.heading('url', text='Public URL')  # No sorting for action column
    tree.heading('map', text='Map')  # No sorting for action column

    # Define column widths
    tree.column('name', width=180)
    tree.column('callsign', width=80)
    tree.column('location', width=180)
    tree.column('users', width=60)
    tree.column('session', width=60)
    tree.column('cw', width=40)
    tree.column('digi', width=40)
    tree.column('noise', width=50)
    tree.column('iq', width=80)
    tree.column('version', width=80)
    tree.column('url', width=100)
    tree.column('map', width=80)

    # Add scrollbar
    scrollbar = ttk.Scrollbar(main_frame, orient=tk.VERTICAL, command=tree.yview)
    tree.configure(yscrollcommand=scrollbar.set)

    tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
    scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

    # Button frame
    button_frame = ttk.Frame(window, padding="10")
    button_frame.pack(fill=tk.X)

    # Store instance data for later use
    instances_data = {}

    def connect_to_instance():
        """Connect to the selected public instance."""
        selection = tree.selection()
        if not selection:
            messagebox.showinfo("Info", "Please select an instance to connect to")
            return

        item_id = selection[0]
        instance = instances_data.get(item_id)

        if not instance:
            messagebox.showerror("Error", "Instance data not found")
            return

        # Get connection info
        host = instance.get('instance', {}).get('host', '')
        port = instance.get('instance', {}).get('port', 0)
        tls = instance.get('instance', {}).get('tls', False)
        name = instance.get('name', 'Unknown')
        callsign = instance.get('callsign', '')
        
        # Ensure callsign is a string, not None
        if callsign is None:
            callsign = ''

        if not host or not port:
            messagebox.showerror("Error", "Instance does not provide connection information")
            return

        # Close the window
        window.destroy()

        # Call the callback to connect
        on_connect_callback(host, port, tls, name, callsign)

    def open_google_maps(lat, lon):
        """Open Google Maps in browser with the given coordinates."""
        url = f"https://www.google.com/maps?q={lat},{lon}"
        webbrowser.open(url)

    def on_tree_click(event):
        """Handle single-click on tree items to open links."""
        region = tree.identify_region(event.x, event.y)
        if region == "cell":
            column = tree.identify_column(event.x)
            item = tree.identify_row(event.y)

            if not item:
                return

            instance = instances_data.get(item)
            if not instance:
                return

            # Column #11 is Public URL
            if column == '#11':
                url = instance.get('public_url', '')
                if url:
                    webbrowser.open(url)

            # Column #12 is Map
            elif column == '#12':
                lat = instance.get('latitude')
                lon = instance.get('longitude')
                if lat and lon:
                    open_google_maps(lat, lon)

    def on_tree_double_click(event):
        """Handle double-click on tree items to connect."""
        item = tree.identify_row(event.y)
        if item:
            # Select the item
            tree.selection_set(item)
            # Connect to it
            connect_to_instance()

    # Use single-click for links (more intuitive)
    tree.bind('<Button-1>', on_tree_click)

    # Use double-click to connect
    tree.bind('<Double-Button-1>', on_tree_double_click)

    # Configure tags for link-like appearance
    tree.tag_configure('link', foreground='blue')
    tree.tag_configure('local_link', foreground='blue', background='lightgreen')

    # Fetch instances in background
    def fetch_instances():
        try:
            response = requests.get('https://instances.ubersdr.org/api/instances', timeout=10)
            response.raise_for_status()
            data = response.json()

            # Extract instances array from response
            instances = data.get('instances', []) if isinstance(data, dict) else data

            # Update UI in main thread
            def update_ui():
                if not instances:
                    status_label.config(text="No public instances found", foreground='orange')
                    return

                status_label.config(text=f"Found {len(instances)} public instance(s)", foreground='green')

                # Clear existing items
                for item in tree.get_children():
                    tree.delete(item)

                # Add instances to tree
                for instance in instances:
                    name = instance.get('name', 'Unknown')
                    callsign = instance.get('callsign', '')
                    location = instance.get('location', '')
                    version = instance.get('version', '')
                    uuid = instance.get('id', '')  # Get UUID from 'id' field

                    # Users available
                    available_clients = instance.get('available_clients', 0)
                    max_clients = instance.get('max_clients', 0)
                    users_text = f"{available_clients}/{max_clients}"

                    # Max session time in minutes
                    max_session_time = instance.get('max_session_time', 0)
                    session_text = f"{max_session_time // 60}m" if max_session_time > 0 else ''

                    # Capability checkboxes
                    cw_text = '✓' if instance.get('cw_skimmer', False) else '✗'
                    digi_text = '✓' if instance.get('digital_decodes', False) else '✗'
                    noise_text = '✓' if instance.get('noise_floor', False) else '✗'

                    # IQ modes - extract numbers from mode names (e.g., "iq48" -> "48")
                    public_iq_modes = instance.get('public_iq_modes', [])
                    if public_iq_modes:
                        # Extract numbers from mode names and sort them
                        iq_numbers = []
                        for mode in public_iq_modes:
                            # Extract digits from mode name (e.g., "iq48" -> "48")
                            digits = ''.join(filter(str.isdigit, mode))
                            if digits:
                                iq_numbers.append(int(digits))
                        iq_numbers.sort()
                        iq_text = ', '.join(str(n) for n in iq_numbers) if iq_numbers else 'None'
                    else:
                        iq_text = 'None'

                    # Public URL
                    public_url = instance.get('public_url', '')
                    url_text = '🔗 Open' if public_url else ''

                    # Check if coordinates are available for map link
                    lat = instance.get('latitude')
                    lon = instance.get('longitude')
                    map_text = '🗺️ Map' if (lat and lon) else ''

                    # Determine tags based on whether this is a local instance
                    is_local = uuid in local_uuids
                    tags = ('local_link',) if is_local else ('link',)

                    # Insert into tree with appropriate tags
                    item_id = tree.insert('', tk.END, values=(name, callsign, location, users_text, session_text, cw_text, digi_text, noise_text, iq_text, version, url_text, map_text), tags=tags)

                    # Store full instance data with connection info
                    # The API returns host, port, tls at the top level
                    instances_data[item_id] = {
                        **instance,
                        'instance': {
                            'host': instance.get('host', ''),
                            'port': instance.get('port', 0),
                            'tls': instance.get('tls', False)
                        }
                    }

            window.after(0, update_ui)

        except requests.exceptions.RequestException as e:
            def show_error():
                status_label.config(text=f"Error fetching instances: {e}", foreground='red')
            window.after(0, show_error)
        except Exception as e:
            def show_error():
                status_label.config(text=f"Unexpected error: {e}", foreground='red')
            window.after(0, show_error)

    def refresh_instances():
        """Refresh the instances list."""
        status_label.config(text="Refreshing instances...", foreground='blue')
        fetch_thread = threading.Thread(target=fetch_instances, daemon=True)
        fetch_thread.start()

    # Create buttons
    add_btn = ttk.Button(button_frame, text="Add", command=connect_to_instance)
    add_btn.pack(side=tk.LEFT, padx=(0, 5))

    close_btn = ttk.Button(button_frame, text="Close", command=window.destroy)
    close_btn.pack(side=tk.LEFT, padx=(0, 5))

    refresh_btn = ttk.Button(button_frame, text="Refresh", command=refresh_instances)
    refresh_btn.pack(side=tk.LEFT)

    # Start initial fetch in background thread
    fetch_thread = threading.Thread(target=fetch_instances, daemon=True)
    fetch_thread.start()

    return window