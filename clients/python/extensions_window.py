#!/usr/bin/env python3
"""
Extensions Window for Python Radio Client
Shows available extensions and allows opening them
"""

import tkinter as tk
from tkinter import ttk
import requests
from typing import Callable, Optional, Dict, List


class ExtensionsWindow:
    """Window showing available extensions."""
    
    # Extensions that are implemented in the Python client
    SUPPORTED_EXTENSIONS = {'navtex', 'fsk', 'wefax', 'sstv', 'ft8'}
    
    def __init__(self, parent: tk.Tk, base_url: str, on_extension_open: Callable):
        """
        Initialize extensions window.
        
        Args:
            parent: Parent window
            base_url: Base URL of the server (e.g., "http://localhost:8080")
            on_extension_open: Callback when extension is opened: on_extension_open(extension_name)
        """
        self.parent = parent
        self.base_url = base_url
        self.on_extension_open = on_extension_open
        
        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("Extensions")
        self.window.geometry("500x400")
        
        # Available extensions
        self.extensions: List[Dict] = []
        
        # Create UI
        self.create_widgets()
        
        # Load extensions
        self.load_extensions()
        
    def create_widgets(self):
        """Create UI widgets."""
        # Main frame
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        
        # Title
        title_label = ttk.Label(main_frame, text="Available Extensions", 
                               font=('TkDefaultFont', 12, 'bold'))
        title_label.grid(row=0, column=0, sticky=tk.W, pady=(0, 10))
        
        # Extensions list frame
        list_frame = ttk.Frame(main_frame)
        list_frame.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(1, weight=1)
        
        # Scrollbar
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL)
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))
        
        # Listbox for extensions
        self.extensions_listbox = tk.Listbox(list_frame, height=15, 
                                            yscrollcommand=scrollbar.set,
                                            font=('TkDefaultFont', 10))
        self.extensions_listbox.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        scrollbar.config(command=self.extensions_listbox.yview)
        
        list_frame.columnconfigure(0, weight=1)
        list_frame.rowconfigure(0, weight=1)
        
        # Bind double-click to open extension
        self.extensions_listbox.bind('<Double-Button-1>', lambda e: self.open_selected_extension())
        
        # Buttons frame
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=2, column=0, sticky=tk.E)
        
        # Open button
        self.open_btn = ttk.Button(button_frame, text="Open", command=self.open_selected_extension)
        self.open_btn.grid(row=0, column=0, padx=(0, 5))
        
        # Refresh button
        refresh_btn = ttk.Button(button_frame, text="Refresh", command=self.load_extensions)
        refresh_btn.grid(row=0, column=1, padx=(0, 5))
        
        # Close button
        close_btn = ttk.Button(button_frame, text="Close", command=self.window.destroy)
        close_btn.grid(row=0, column=2)
        
        # Status label
        self.status_label = ttk.Label(main_frame, text="Loading extensions...", 
                                     foreground='blue')
        self.status_label.grid(row=3, column=0, sticky=tk.W, pady=(10, 0))
        
    def load_extensions(self):
        """Load available extensions from server."""
        self.status_label.config(text="Loading extensions...", foreground='blue')
        self.extensions_listbox.delete(0, tk.END)
        self.extensions = []
        
        try:
            # Fetch extensions from API
            response = requests.get(f"{self.base_url}/api/extensions", timeout=5)
            response.raise_for_status()
            data = response.json()
            
            # Handle new API format with 'available' key
            extensions_list = data.get('available', data if isinstance(data, list) else [])
            
            if not extensions_list:
                self.status_label.config(text="No extensions available", foreground='orange')
                return
            
            # Load each extension's manifest
            for ext in extensions_list:
                ext_name = ext.get('slug', ext.get('name', ''))
                if not ext_name:
                    continue
                    
                try:
                    # Skip extensions not supported in Python client
                    if ext_name not in self.SUPPORTED_EXTENSIONS:
                        print(f"Skipping {ext_name} - not implemented in Python client")
                        continue
                    
                    # Fetch manifest
                    manifest_url = f"{self.base_url}/extensions/{ext_name}/manifest.json"
                    manifest_response = requests.get(manifest_url, timeout=3)
                    manifest_response.raise_for_status()
                    manifest = manifest_response.json()
                    
                    # Store extension info
                    ext_info = {
                        'name': ext_name,
                        'displayName': manifest.get('displayName', ext_name),
                        'description': manifest.get('description', ''),
                        'icon': manifest.get('icon', '📦'),
                        'type': manifest.get('type', 'unknown'),
                        'manifest': manifest
                    }
                    self.extensions.append(ext_info)
                    
                    # Add to listbox
                    display_text = f"{ext_info['icon']} {ext_info['displayName']}"
                    if ext_info['description']:
                        display_text += f" - {ext_info['description']}"
                    self.extensions_listbox.insert(tk.END, display_text)
                    
                except Exception as e:
                    print(f"Failed to load manifest for {ext_name}: {e}")
                    continue
            
            if self.extensions:
                self.status_label.config(text=f"Loaded {len(self.extensions)} extension(s)", 
                                       foreground='green')
            else:
                self.status_label.config(text="No extensions could be loaded", 
                                       foreground='orange')
                
        except Exception as e:
            self.status_label.config(text=f"Error loading extensions: {e}", 
                                   foreground='red')
            print(f"Error loading extensions: {e}")
    
    def open_selected_extension(self):
        """Open the selected extension."""
        selection = self.extensions_listbox.curselection()
        if not selection:
            return
        
        index = selection[0]
        if index >= len(self.extensions):
            return
        
        ext_info = self.extensions[index]
        ext_name = ext_info['name']
        
        # Call callback
        self.on_extension_open(ext_name, ext_info)


def create_extensions_window(parent: tk.Tk, base_url: str, 
                            on_extension_open: Callable) -> ExtensionsWindow:
    """
    Create and return an extensions window.
    
    Args:
        parent: Parent window
        base_url: Base URL of the server
        on_extension_open: Callback when extension is opened
        
    Returns:
        ExtensionsWindow instance
    """
    return ExtensionsWindow(parent, base_url, on_extension_open)
