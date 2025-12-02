"""
Instance Configuration Dialogs
UI dialogs for adding and editing instances
"""

import tkinter as tk
from tkinter import ttk, messagebox
from typing import Callable, Optional

from spectrum_instance import SpectrumInstance


class AddInstanceDialog:
    """Dialog for adding a new instance."""
    
    def __init__(self, parent, instance_count: int, on_ok: Callable[[SpectrumInstance], None]):
        self.parent = parent
        self.instance_count = instance_count
        self.on_ok_callback = on_ok
        self.result: Optional[SpectrumInstance] = None
        
        self.dialog = tk.Toplevel(parent)
        self.dialog.title("Add Instance")
        self.dialog.geometry("400x300")
        self.dialog.transient(parent)
        self.dialog.grab_set()
        
        self._create_widgets()
    
    def _create_widgets(self):
        """Create dialog widgets."""
        # Callsign
        ttk.Label(self.dialog, text="Callsign:").grid(row=0, column=0, sticky=tk.W, padx=10, pady=5)
        self.callsign_var = tk.StringVar(value="")
        ttk.Entry(self.dialog, textvariable=self.callsign_var, width=30).grid(row=0, column=1, padx=10, pady=5)
        
        # Name
        ttk.Label(self.dialog, text="Name:").grid(row=1, column=0, sticky=tk.W, padx=10, pady=5)
        self.name_var = tk.StringVar(value=f"Instance {self.instance_count + 1}")
        ttk.Entry(self.dialog, textvariable=self.name_var, width=30).grid(row=1, column=1, padx=10, pady=5)
        
        # Host
        ttk.Label(self.dialog, text="Host:").grid(row=2, column=0, sticky=tk.W, padx=10, pady=5)
        self.host_var = tk.StringVar(value="localhost")
        ttk.Entry(self.dialog, textvariable=self.host_var, width=30).grid(row=2, column=1, padx=10, pady=5)
        
        # Port
        ttk.Label(self.dialog, text="Port:").grid(row=3, column=0, sticky=tk.W, padx=10, pady=5)
        self.port_var = tk.StringVar(value="8080")
        ttk.Entry(self.dialog, textvariable=self.port_var, width=30).grid(row=3, column=1, padx=10, pady=5)
        
        # TLS
        self.tls_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(self.dialog, text="Use TLS", variable=self.tls_var).grid(row=4, column=1,
                                                                                 sticky=tk.W, padx=10, pady=5)
        
        # Frequency
        ttk.Label(self.dialog, text="Frequency (MHz):").grid(row=5, column=0, sticky=tk.W, padx=10, pady=5)
        self.freq_var = tk.StringVar(value="14.100")
        ttk.Entry(self.dialog, textvariable=self.freq_var, width=30).grid(row=5, column=1, padx=10, pady=5)
        
        # Buttons
        btn_frame = ttk.Frame(self.dialog)
        btn_frame.grid(row=6, column=0, columnspan=2, pady=20)
        ttk.Button(btn_frame, text="OK", command=self._on_ok).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="Cancel", command=self.dialog.destroy).pack(side=tk.LEFT, padx=5)
    
    def _on_ok(self):
        """Handle OK button click."""
        try:
            port = int(self.port_var.get())
            freq_mhz = float(self.freq_var.get())
            freq_hz = int(freq_mhz * 1e6)
            
            instance = SpectrumInstance(self.instance_count)
            instance.callsign = self.callsign_var.get().strip().upper()
            instance.name = self.name_var.get()
            instance.host = self.host_var.get()
            instance.port = port
            instance.tls = self.tls_var.get()
            instance.frequency = freq_hz
            
            self.result = instance
            self.on_ok_callback(instance)
            self.dialog.destroy()
            
        except ValueError as e:
            messagebox.showerror("Invalid Input", f"Please check your input: {e}")


class EditInstanceDialog:
    """Dialog for editing an existing instance."""
    
    def __init__(self, parent, instance: SpectrumInstance, on_ok: Callable[[SpectrumInstance], None]):
        self.parent = parent
        self.instance = instance
        self.on_ok_callback = on_ok
        
        self.dialog = tk.Toplevel(parent)
        self.dialog.title(f"Edit {instance.get_display_name()}")
        self.dialog.geometry("400x300")
        self.dialog.transient(parent)
        self.dialog.grab_set()
        
        self._create_widgets()
    
    def _create_widgets(self):
        """Create dialog widgets."""
        # Callsign
        ttk.Label(self.dialog, text="Callsign:").grid(row=0, column=0, sticky=tk.W, padx=10, pady=5)
        self.callsign_var = tk.StringVar(value=self.instance.callsign)
        ttk.Entry(self.dialog, textvariable=self.callsign_var, width=30).grid(row=0, column=1, padx=10, pady=5)
        
        # Name
        ttk.Label(self.dialog, text="Name:").grid(row=1, column=0, sticky=tk.W, padx=10, pady=5)
        self.name_var = tk.StringVar(value=self.instance.name)
        ttk.Entry(self.dialog, textvariable=self.name_var, width=30).grid(row=1, column=1, padx=10, pady=5)
        
        # Host
        ttk.Label(self.dialog, text="Host:").grid(row=2, column=0, sticky=tk.W, padx=10, pady=5)
        self.host_var = tk.StringVar(value=self.instance.host)
        ttk.Entry(self.dialog, textvariable=self.host_var, width=30).grid(row=2, column=1, padx=10, pady=5)
        
        # Port
        ttk.Label(self.dialog, text="Port:").grid(row=3, column=0, sticky=tk.W, padx=10, pady=5)
        self.port_var = tk.StringVar(value=str(self.instance.port))
        ttk.Entry(self.dialog, textvariable=self.port_var, width=30).grid(row=3, column=1, padx=10, pady=5)
        
        # TLS
        self.tls_var = tk.BooleanVar(value=self.instance.tls)
        ttk.Checkbutton(self.dialog, text="Use TLS", variable=self.tls_var).grid(row=4, column=1,
                                                                                 sticky=tk.W, padx=10, pady=5)
        
        # Frequency
        ttk.Label(self.dialog, text="Frequency (MHz):").grid(row=5, column=0, sticky=tk.W, padx=10, pady=5)
        self.freq_var = tk.StringVar(value=f"{self.instance.frequency/1e6:.6f}")
        ttk.Entry(self.dialog, textvariable=self.freq_var, width=30).grid(row=5, column=1, padx=10, pady=5)
        
        # Buttons
        btn_frame = ttk.Frame(self.dialog)
        btn_frame.grid(row=6, column=0, columnspan=2, pady=20)
        ttk.Button(btn_frame, text="OK", command=self._on_ok).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="Cancel", command=self.dialog.destroy).pack(side=tk.LEFT, padx=5)
    
    def _on_ok(self):
        """Handle OK button click."""
        try:
            port = int(self.port_var.get())
            freq_mhz = float(self.freq_var.get())
            freq_hz = int(freq_mhz * 1e6)
            
            self.instance.callsign = self.callsign_var.get().strip().upper()
            self.instance.name = self.name_var.get()
            self.instance.host = self.host_var.get()
            self.instance.port = port
            self.instance.tls = self.tls_var.get()
            self.instance.frequency = freq_hz
            
            self.on_ok_callback(self.instance)
            self.dialog.destroy()
            
        except ValueError as e:
            messagebox.showerror("Invalid Input", f"Please check your input: {e}")