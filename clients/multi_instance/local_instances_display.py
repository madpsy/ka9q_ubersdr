#!/usr/bin/env python3
"""
Local UberSDR Instances Display
Discovers and displays UberSDR instances on the local network via mDNS/DNS-SD
"""

import tkinter as tk
from tkinter import ttk, messagebox
import threading
import requests
import webbrowser
from typing import Callable, Dict

try:
    from zeroconf import ServiceBrowser, ServiceListener, Zeroconf
    ZEROCONF_AVAILABLE = True
except ImportError:
    ZEROCONF_AVAILABLE = False


class LocalInstancesDisplay:
    """Display for local UberSDR instances discovered via mDNS."""
    
    def __init__(self, parent: tk.Tk, on_connect: Callable):
        """Initialize the local instances display.
        
        Args:
            parent: Parent Tkinter window
            on_connect: Callback function(host, port, tls, name, callsign) when user selects an instance
        """
        self.parent = parent
        self.on_connect = on_connect
        self.window = None
        self.instances: Dict[str, Dict] = {}  # service_name -> instance_info
        self.zeroconf = None
        self.browser = None
        self.listener = None
        
        # Create window
        self.create_window()
        
        # Start discovery if available
        if ZEROCONF_AVAILABLE:
            self.start_discovery()
        else:
            self.show_error("mDNS discovery not available. Install zeroconf:\npip install zeroconf")
    
    def create_window(self):
        """Create the local instances window."""
        self.window = tk.Toplevel(self.parent)
        self.window.title("Local UberSDR Instances")
        self.window.geometry("1100x250")
        
        # Main frame
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        
        # Title
        title_label = ttk.Label(main_frame, text="Discovered Local Instances", 
                               font=('TkDefaultFont', 12, 'bold'))
        title_label.grid(row=0, column=0, columnspan=2, pady=(0, 10))
        
        # Status label
        self.status_label = ttk.Label(main_frame, text="Searching for local instances...", 
                                     foreground='blue')
        self.status_label.grid(row=1, column=0, columnspan=2, pady=(0, 10))
        
        # Instances list
        list_frame = ttk.Frame(main_frame)
        list_frame.grid(row=2, column=0, columnspan=2, sticky=(tk.W, tk.E, tk.N, tk.S))
        main_frame.rowconfigure(2, weight=1)
        
        # Treeview for instances (matching public instances columns)
        columns = ('name', 'callsign', 'location', 'users', 'session', 'cw', 'digi', 'noise', 'iq', 'version', 'url', 'local_url')
        self.tree = ttk.Treeview(list_frame, columns=columns, show='headings', height=10)
        
        self.tree.heading('name', text='Name')
        self.tree.heading('callsign', text='Callsign')
        self.tree.heading('location', text='Location')
        self.tree.heading('users', text='Users')
        self.tree.heading('session', text='Session')
        self.tree.heading('cw', text='CW')
        self.tree.heading('digi', text='Digi')
        self.tree.heading('noise', text='Noise')
        self.tree.heading('iq', text='IQ (kHz)')
        self.tree.heading('version', text='Version')
        self.tree.heading('url', text='Public URL')
        self.tree.heading('local_url', text='Local URL')
        
        self.tree.column('name', width=180)
        self.tree.column('callsign', width=80)
        self.tree.column('location', width=180)
        self.tree.column('users', width=60)
        self.tree.column('session', width=60)
        self.tree.column('cw', width=40)
        self.tree.column('digi', width=40)
        self.tree.column('noise', width=50)
        self.tree.column('iq', width=80)
        self.tree.column('version', width=80)
        self.tree.column('url', width=100)
        self.tree.column('local_url', width=100)
        
        self.tree.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        list_frame.rowconfigure(0, weight=1)
        list_frame.columnconfigure(0, weight=1)
        
        # Scrollbar
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.tree.yview)
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))
        self.tree.configure(yscrollcommand=scrollbar.set)
        
        # Bind single-click for links
        self.tree.bind('<Button-1>', self.on_tree_click)
        
        # Bind double-click to connect
        self.tree.bind('<Double-Button-1>', self.on_instance_double_click)
        
        # Configure tags for link-like appearance
        self.tree.tag_configure('link', foreground='blue')
        
        # Buttons
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=3, column=0, columnspan=2, sticky=tk.W, pady=(10, 0))
        
        self.add_btn = ttk.Button(button_frame, text="Add", command=self.on_connect_clicked)
        self.add_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        self.refresh_btn = ttk.Button(button_frame, text="Refresh", command=self.refresh_discovery)
        self.refresh_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        close_btn = ttk.Button(button_frame, text="Close", command=self.window.destroy)
        close_btn.pack(side=tk.LEFT)
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.on_close)
        
        main_frame.columnconfigure(0, weight=1)
    
    def show_error(self, message: str):
        """Show error message in the window."""
        self.status_label.config(text=message, foreground='red')
        self.add_btn.config(state='disabled')
        self.refresh_btn.config(state='disabled')
    
    def start_discovery(self):
        """Start mDNS service discovery."""
        try:
            self.zeroconf = Zeroconf()
            self.listener = UberSDRServiceListener(self)
            self.browser = ServiceBrowser(self.zeroconf, "_ubersdr._tcp.local.", self.listener)
            
            # Update status after a short delay
            self.window.after(2000, self.update_status)
        except Exception as e:
            self.show_error(f"Discovery failed: {e}")
    
    def stop_discovery(self):
        """Stop mDNS service discovery."""
        if self.browser:
            self.browser.cancel()
            self.browser = None
        if self.zeroconf:
            self.zeroconf.close()
            self.zeroconf = None
    
    def refresh_discovery(self):
        """Refresh the discovery by restarting it."""
        self.status_label.config(text="Refreshing...", foreground='blue')
        self.instances.clear()
        self.tree.delete(*self.tree.get_children())
        
        # Stop and restart discovery
        self.stop_discovery()
        self.window.after(500, self.start_discovery)
    
    def update_status(self):
        """Update status label based on discovered instances."""
        count = len(self.instances)
        if count == 0:
            self.status_label.config(text="No local instances found", foreground='orange')
        elif count == 1:
            self.status_label.config(text="Found 1 local instance", foreground='green')
        else:
            self.status_label.config(text=f"Found {count} local instances", foreground='green')
    
    def add_instance(self, service_name: str, info: Dict):
        """Add or update an instance in the list.
        
        Args:
            service_name: Unique service name
            info: Dictionary with keys: name, host, port, version, txt_records
        """
        # Store instance with basic info
        self.instances[service_name] = info
        
        # Fetch detailed info from /api/description in background
        def fetch_description():
            try:
                protocol = 'https' if info.get('tls', False) else 'http'
                url = f"{protocol}://{info['host']}:{info['port']}/api/description"
                response = requests.get(url, timeout=5)
                response.raise_for_status()
                description = response.json()
                
                # Update instance with description data
                info['description'] = description
                
                # Update tree view (run in main thread)
                self.window.after(0, lambda: self._update_tree_view())
            except Exception:
                # If fetch fails, remove the instance
                if service_name in self.instances:
                    del self.instances[service_name]
                self.window.after(0, lambda: self._update_tree_view())
        
        # Start fetch in background
        threading.Thread(target=fetch_description, daemon=True).start()
        
        # Don't update tree view immediately - wait for description fetch
    
    def remove_instance(self, service_name: str):
        """Remove an instance from the list.
        
        Args:
            service_name: Unique service name
        """
        if service_name in self.instances:
            del self.instances[service_name]
            # Update tree view (run in main thread)
            self.window.after(0, lambda: self._update_tree_view())
    
    def _update_tree_view(self):
        """Update the tree view with current instances."""
        # Clear existing items
        self.tree.delete(*self.tree.get_children())
        
        # Add instances (only those with valid description)
        for service_name, info in sorted(self.instances.items(), key=lambda x: x[1]['name']):
            description = info.get('description')
            
            # Only show instances that have successfully fetched their description
            if not description:
                continue
            
            # Extract data from description
            receiver = description.get('receiver', {})
            name = receiver.get('name', info['name'])
            callsign = receiver.get('callsign', '')
            location = receiver.get('location', '')
            version = description.get('version', info.get('version', 'Unknown'))
            public_uuid = description.get('public_uuid', '')
            
            # Store public_uuid in info for later use
            info['public_uuid'] = public_uuid
            
            # Users available
            available_clients = description.get('available_clients', 0)
            max_clients = description.get('max_clients', 0)
            users_text = f"{available_clients}/{max_clients}"
            
            # Max session time in minutes
            max_session_time = description.get('max_session_time', 0)
            session_text = f"{max_session_time // 60}m" if max_session_time > 0 else ''
            
            # Capability checkboxes
            cw_text = '✓' if description.get('cw_skimmer', False) else '✗'
            digi_text = '✓' if description.get('digital_decodes', False) else '✗'
            noise_text = '✓' if description.get('noise_floor', False) else '✗'
            
            # IQ modes - extract numbers from mode names
            public_iq_modes = description.get('public_iq_modes', [])
            if public_iq_modes:
                iq_numbers = []
                for mode in public_iq_modes:
                    digits = ''.join(filter(str.isdigit, mode))
                    if digits:
                        iq_numbers.append(int(digits))
                iq_numbers.sort()
                iq_text = ', '.join(str(n) for n in iq_numbers) if iq_numbers else 'None'
            else:
                iq_text = 'None'
            
            # Public URL
            public_url = receiver.get('public_url', '')
            url_text = '🔗 Open' if public_url else ''
            
            # Local URL - always show Open link
            local_url_text = '🔗 Open'
            
            self.tree.insert('', tk.END, values=(
                name, callsign, location, users_text, session_text,
                cw_text, digi_text, noise_text, iq_text, version,
                url_text, local_url_text
            ), tags=(service_name, 'link'))
        
        # Update status
        self.update_status()
    
    def on_tree_click(self, event):
        """Handle single-click on tree items to open links."""
        region = self.tree.identify_region(event.x, event.y)
        if region == "cell":
            column = self.tree.identify_column(event.x)
            item = self.tree.identify_row(event.y)
            
            if not item:
                return
            
            # Get service name from tags
            tags = self.tree.item(item, 'tags')
            if not tags:
                return
            
            service_name = tags[0]
            info = self.instances.get(service_name)
            if not info:
                return
            
            # Column #11 is Public URL
            if column == '#11':
                description = info.get('description')
                if description:
                    receiver = description.get('receiver', {})
                    url = receiver.get('public_url', '')
                    if url:
                        webbrowser.open(url)
            
            # Column #12 is Local URL
            elif column == '#12':
                protocol = 'https' if info.get('tls', False) else 'http'
                url = f"{protocol}://{info['host']}:{info['port']}/"
                webbrowser.open(url)
    
    def on_instance_double_click(self, event):
        """Handle double-click on instance."""
        item = self.tree.identify_row(event.y)
        if item:
            # Select the item
            self.tree.selection_set(item)
            # Connect to it
            self.on_connect_clicked()
    
    def on_connect_clicked(self):
        """Handle connect button click."""
        selection = self.tree.selection()
        if not selection:
            messagebox.showinfo("Info", "Please select an instance to add")
            return
        
        # Get selected instance
        item = selection[0]
        
        # Get service name from tags
        tags = self.tree.item(item, 'tags')
        if not tags:
            return
        
        service_name = tags[0]
        info = self.instances.get(service_name)
        if not info:
            return
        
        # Get callsign from description
        description = info.get('description', {})
        receiver = description.get('receiver', {})
        callsign = receiver.get('callsign', '')
        
        # Ensure callsign is a string, not None
        if callsign is None:
            callsign = ''
        
        # Call connect callback (TLS is always False for local instances)
        self.on_connect(info['host'], info['port'], False, info['name'], callsign)
        
        # Close window after connecting
        self.window.destroy()
    
    def on_close(self):
        """Handle window close."""
        self.stop_discovery()
        self.window.destroy()


class UberSDRServiceListener(ServiceListener):
    """Listener for UberSDR mDNS services."""
    
    def __init__(self, display: LocalInstancesDisplay):
        self.display = display
    
    def add_service(self, zc: Zeroconf, type_: str, name: str) -> None:
        """Called when a service is discovered."""
        info = zc.get_service_info(type_, name)
        if info:
            # Parse service info
            host = info.parsed_addresses()[0] if info.parsed_addresses() else None
            port = info.port
            
            if host and port:
                # Parse TXT records
                txt_records = {}
                if info.properties:
                    for key, value in info.properties.items():
                        try:
                            txt_records[key.decode('utf-8')] = value.decode('utf-8')
                        except:
                            pass
                
                # Extract version from TXT records
                version = txt_records.get('version', 'Unknown')
                
                # Extract product name (should be 'ubersdr')
                product = txt_records.get('product', 'UberSDR')
                
                # Create display name from service name (remove service type suffix)
                display_name = name.replace('._ubersdr._tcp.local.', '')
                
                instance_info = {
                    'name': display_name,
                    'host': host,
                    'port': port,
                    'version': version,
                    'txt_records': txt_records
                }
                
                self.display.add_instance(name, instance_info)
    
    def remove_service(self, zc: Zeroconf, type_: str, name: str) -> None:
        """Called when a service is removed."""
        self.display.remove_instance(name)
    
    def update_service(self, zc: Zeroconf, type_: str, name: str) -> None:
        """Called when a service is updated."""
        # Treat as add
        self.add_service(zc, type_, name)


def create_local_instances_window(parent: tk.Tk, on_connect: Callable) -> tuple:
    """Create and return a local instances display window.
    
    Args:
        parent: Parent Tkinter window
        on_connect: Callback function(host, port, tls, name, callsign) when user selects an instance
    
    Returns:
        Tuple of (window, display) where display is the LocalInstancesDisplay object
    """
    display = LocalInstancesDisplay(parent, on_connect)
    return display.window, display