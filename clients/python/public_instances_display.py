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


def create_public_instances_window(parent, on_connect_callback):
    """Create a window showing public UberSDR instances.
    
    Args:
        parent: Parent tkinter window
        on_connect_callback: Callback function(host, port, tls, name) to call when connecting
    
    Returns:
        The created window
    """
    # Create new window
    window = tk.Toplevel(parent)
    window.title("Public UberSDR Instances")
    window.geometry("900x500")

    # Main frame with padding
    main_frame = ttk.Frame(window, padding="10")
    main_frame.pack(fill=tk.BOTH, expand=True)

    # Status label
    status_label = ttk.Label(main_frame, text="Fetching public instances...", foreground='blue')
    status_label.pack(pady=(0, 10))

    # Create Treeview for instances list
    columns = ('name', 'callsign', 'location', 'cw', 'digi', 'noise', 'version', 'url', 'map')
    tree = ttk.Treeview(main_frame, columns=columns, show='headings', height=15)

    # Define headings
    tree.heading('name', text='Name')
    tree.heading('callsign', text='Callsign')
    tree.heading('location', text='Location')
    tree.heading('cw', text='CW')
    tree.heading('digi', text='Digi')
    tree.heading('noise', text='Noise')
    tree.heading('version', text='Version')
    tree.heading('url', text='Public URL')
    tree.heading('map', text='Map')

    # Define column widths
    tree.column('name', width=180)
    tree.column('callsign', width=80)
    tree.column('location', width=180)
    tree.column('cw', width=40)
    tree.column('digi', width=40)
    tree.column('noise', width=50)
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

        if not host or not port:
            messagebox.showerror("Error", "Instance does not provide connection information")
            return

        # Close the window
        window.destroy()

        # Call the callback to connect
        on_connect_callback(host, port, tls, name)

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

            # Column #8 is Public URL
            if column == '#8':
                url = instance.get('public_url', '')
                if url:
                    webbrowser.open(url)

            # Column #9 is Map
            elif column == '#9':
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

    connect_btn = ttk.Button(button_frame, text="Connect", command=connect_to_instance)
    connect_btn.pack(side=tk.LEFT, padx=(0, 5))

    close_btn = ttk.Button(button_frame, text="Close", command=window.destroy)
    close_btn.pack(side=tk.LEFT)

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

                    # Capability checkboxes
                    cw_text = '✓' if instance.get('cw_skimmer', False) else '✗'
                    digi_text = '✓' if instance.get('digital_decodes', False) else '✗'
                    noise_text = '✓' if instance.get('noise_floor', False) else '✗'

                    # Public URL
                    public_url = instance.get('public_url', '')
                    url_text = '🔗 Open' if public_url else ''

                    # Check if coordinates are available for map link
                    lat = instance.get('latitude')
                    lon = instance.get('longitude')
                    map_text = '🗺️ Map' if (lat and lon) else ''

                    # Insert into tree
                    item_id = tree.insert('', tk.END, values=(name, callsign, location, cw_text, digi_text, noise_text, version, url_text, map_text), tags=('link',))

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

    # Start fetch in background thread
    fetch_thread = threading.Thread(target=fetch_instances, daemon=True)
    fetch_thread.start()

    return window