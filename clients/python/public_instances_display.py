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
    window.geometry("1040x500")

    # Main frame with padding
    main_frame = ttk.Frame(window, padding="10")
    main_frame.pack(fill=tk.BOTH, expand=True)

    # Filter frame
    filter_frame = ttk.Frame(main_frame)
    filter_frame.pack(fill=tk.X, pady=(0, 10))

    ttk.Label(filter_frame, text="Filter:").pack(side=tk.LEFT, padx=(0, 5))
    filter_var = tk.StringVar()
    filter_entry = ttk.Entry(filter_frame, textvariable=filter_var, width=40)
    filter_entry.pack(side=tk.LEFT, padx=(0, 5))

    # Status label
    status_label = ttk.Label(main_frame, text="Fetching public instances...", foreground='blue')
    status_label.pack(pady=(0, 10))

    # Create Treeview for instances list
    columns = ('name', 'callsign', 'location', 'users', 'session', 'cw', 'digi', 'noise', 'iq', 'version', 'url', 'map')
    tree = ttk.Treeview(main_frame, columns=columns, show='headings', height=15)

    # Define headings
    tree.heading('name', text='Name')
    tree.heading('callsign', text='Callsign')
    tree.heading('location', text='Location')
    tree.heading('users', text='Users')
    tree.heading('session', text='Session')
    tree.heading('cw', text='CW')
    tree.heading('digi', text='Digi')
    tree.heading('noise', text='Noise')
    tree.heading('iq', text='IQ (kHz)')
    tree.heading('version', text='Version')
    tree.heading('url', text='Public URL')
    tree.heading('map', text='Map')

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
        """Open instance conditions page in browser."""
        url = f"https://instances.ubersdr.org/?uuid={uuid}&conditions=true"
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

            # Column #12 is Map/Conditions
            elif column == '#12':
                uuid = instance.get('id', '')
                if uuid:
                    open_instance_conditions(uuid)

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
                # Check if filter matches name, callsign, or UUID (id)
                name = instance.get('name', '').lower()
                callsign = instance.get('callsign', '').lower()
                uuid = instance.get('id', '').lower()

                if (filter_text in name or
                    filter_text in callsign or
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