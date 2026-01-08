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
        on_connect_callback: Callback function(host, port, tls, name) to call when connecting
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
    window.geometry("1040x650")

    # Main frame with padding
    main_frame = ttk.Frame(window, padding="10")
    main_frame.pack(fill=tk.BOTH, expand=True)

    # Filter/Search frame at the top - with visible border for debugging
    filter_frame = ttk.LabelFrame(main_frame, text="Search/Filter", padding="5")
    filter_frame.pack(fill=tk.X, pady=(0, 10))

    filter_var = tk.StringVar()
    filter_entry = ttk.Entry(filter_frame, textvariable=filter_var, width=50, font=('TkDefaultFont', 10))
    filter_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(5, 5))

    # Add a clear button
    def clear_filter():
        filter_var.set('')
        filter_entry.focus()

    clear_btn = ttk.Button(filter_frame, text="Clear", command=clear_filter, width=8)
    clear_btn.pack(side=tk.LEFT, padx=(0, 5))

    # Add help text
    help_label = ttk.Label(filter_frame, text="(name, callsign, location)", foreground='gray', font=('TkDefaultFont', 9))
    help_label.pack(side=tk.LEFT)

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
    all_instances = []  # Store all fetched instances for filtering

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

        if not host or not port:
            messagebox.showerror("Error", "Instance does not provide connection information")
            return

        # Close the window
        window.destroy()

        # Call the callback to connect
        on_connect_callback(host, port, tls, name)

    def open_instance_conditions(uuid):
        """Open instance map page in browser."""
        url = f"https://instances.ubersdr.org/?uuid={uuid}"
        print(f"DEBUG: Opening URL: {url}")
        webbrowser.open(url)

    def on_tree_click(event):
        """Handle single-click on tree items to open links."""
        region = tree.identify_region(event.x, event.y)
        print(f"DEBUG on_tree_click: region={region}")
        if region == "cell":
            column = tree.identify_column(event.x)
            item = tree.identify_row(event.y)
            print(f"DEBUG on_tree_click: column={column}, item={item}")

            if not item:
                print(f"DEBUG on_tree_click: no item, returning")
                return

            instance = instances_data.get(item)
            if not instance:
                print(f"DEBUG on_tree_click: no instance data, returning")
                return

            print(f"DEBUG on_tree_click: instance keys={list(instance.keys())}")

            # Column #11 is Public URL
            if column == '#11':
                url = instance.get('public_url', '')
                print(f"DEBUG on_tree_click: Column #11 clicked, url={url}")
                if url:
                    webbrowser.open(url)

            # Column #12 is Map/Conditions
            elif column == '#12':
                uuid = instance.get('id', '')
                print(f"DEBUG on_tree_click: Column #12 clicked, uuid={uuid}")
                if uuid:
                    open_instance_conditions(uuid)
            else:
                print(f"DEBUG on_tree_click: Other column clicked: {column}")

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

    # Configure tags for link-like appearance and local instance highlighting
    tree.tag_configure('link', foreground='blue')
    tree.tag_configure('local', background='lightgreen')  # Highlight local instances
    tree.tag_configure('local_link', foreground='blue', background='lightgreen')  # Local with link

    def apply_filter(*args):
        """Apply the current filter to the instances list."""
        filter_text = filter_var.get().lower().strip()

        # Clear existing items
        for item in tree.get_children():
            tree.delete(item)
        instances_data.clear()

        # Filter instances
        filtered_instances = []
        for instance in all_instances:
            if not filter_text:
                # No filter, show all
                filtered_instances.append(instance)
            else:
                # Check if filter matches name, callsign, location, or UUID (id)
                name = instance.get('name', '').lower()
                callsign = instance.get('callsign', '').lower()
                location = instance.get('location', '').lower()
                uuid = instance.get('id', '').lower()

                if (filter_text in name or
                    filter_text in callsign or
                    filter_text in location or
                    filter_text in uuid):
                    filtered_instances.append(instance)

        # Update status
        if not all_instances:
            status_label.config(text="No public instances found", foreground='orange')
        elif not filtered_instances:
            status_label.config(text=f"No instances match filter (0/{len(all_instances)})", foreground='orange')
        else:
            status_label.config(text=f"Showing {len(filtered_instances)} of {len(all_instances)} instance(s)", foreground='green')

        # Add filtered instances to tree
        for instance in filtered_instances:
            name = instance.get('name', 'Unknown')
            callsign = instance.get('callsign', '')
            location = instance.get('location', '')
            version = instance.get('version', '')

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

            # Check if UUID is available for conditions link
            uuid = instance.get('id', '')
            map_text = '🗺️ Map' if uuid else ''

            # Determine tags based on whether this is a local instance
            is_local = uuid in local_uuids
            tags = ('local_link',) if is_local else ('link',)

            # Insert into tree
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
                # Store all instances and apply initial filter
                all_instances.clear()
                all_instances.extend(instances)
                apply_filter()

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

    # Bind filter entry to apply filter on text change
    filter_var.trace_add('write', apply_filter)

    # Create buttons
    connect_btn = ttk.Button(button_frame, text="Connect", command=connect_to_instance)
    connect_btn.pack(side=tk.LEFT, padx=(0, 5))

    close_btn = ttk.Button(button_frame, text="Close", command=window.destroy)
    close_btn.pack(side=tk.LEFT, padx=(0, 5))

    refresh_btn = ttk.Button(button_frame, text="Refresh", command=refresh_instances)
    refresh_btn.pack(side=tk.LEFT)

    # Start initial fetch in background thread
    fetch_thread = threading.Thread(target=fetch_instances, daemon=True)
    fetch_thread.start()

    return window