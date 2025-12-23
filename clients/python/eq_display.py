#!/usr/bin/env python3
"""
10-Band Equalizer Display for ka9q_ubersdr
Provides a graphical equalizer with 10 frequency bands
"""

import tkinter as tk
from tkinter import ttk
from typing import Optional, Callable, List, Tuple
import json
import os
import platform


class EQDisplay:
    """10-band equalizer display window."""
    
    # Standard 10-band EQ frequencies (Hz)
    EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    
    def __init__(self, parent: tk.Tk, on_change_callback: Optional[Callable] = None):
        """Initialize the EQ display.
        
        Args:
            parent: Parent Tkinter window
            on_change_callback: Callback function(band_gains: dict) called when EQ changes
        """
        self.parent = parent
        self.on_change_callback = on_change_callback
        
        # EQ state: dict of {frequency: gain_db}
        self.band_gains = {freq: 0.0 for freq in self.EQ_BANDS}
        
        # UI elements
        self.window: Optional[tk.Toplevel] = None
        self.sliders: List[Tuple[int, ttk.Scale, tk.Label]] = []
        self.enabled_var: Optional[tk.BooleanVar] = None
        
        # Config file path (use platform-appropriate config directory)
        if platform.system() == 'Windows':
            # Use AppData on Windows
            config_dir = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'ubersdr')
            os.makedirs(config_dir, exist_ok=True)
            self.config_file = os.path.join(config_dir, 'eq_settings.json')
        else:
            # Use home directory on Unix-like systems
            self.config_file = os.path.expanduser("~/.ubersdr_eq_settings.json")
        
        # Load saved settings
        self.load_settings()
        
        # Create window
        self.create_window()
    
    def create_window(self):
        """Create the EQ window."""
        self.window = tk.Toplevel(self.parent)
        self.window.title("10-Band Equalizer")
        self.window.geometry("700x450")
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.on_close)
        
        # Main frame
        main_frame = ttk.Frame(self.window, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        # Enable checkbox at top
        control_frame = ttk.Frame(main_frame)
        control_frame.pack(fill=tk.X, pady=(0, 10))
        
        self.enabled_var = tk.BooleanVar(value=False)
        enable_check = ttk.Checkbutton(control_frame, text="Enable Equalizer",
                                       variable=self.enabled_var,
                                       command=self.on_enable_changed)
        enable_check.pack(side=tk.LEFT)
        
        # Info label
        info_label = ttk.Label(control_frame, 
                              text="Adjust frequency bands (-12dB to +12dB)",
                              foreground='gray')
        info_label.pack(side=tk.LEFT, padx=(20, 0))
        
        # Sliders frame
        slider_frame = ttk.Frame(main_frame)
        slider_frame.pack(fill=tk.BOTH, expand=True)
        
        # Create sliders for each band
        for i, freq in enumerate(self.EQ_BANDS):
            # Column frame for each band
            col_frame = ttk.Frame(slider_frame)
            col_frame.grid(row=0, column=i, padx=5, sticky=(tk.N, tk.S))
            
            # Frequency label at top
            freq_text = f"{freq}Hz" if freq < 1000 else f"{freq//1000}kHz"
            freq_label = ttk.Label(col_frame, text=freq_text, font=('TkDefaultFont', 9, 'bold'))
            freq_label.pack(pady=(0, 5))
            
            # Slider (inverted: +12 at top, -12 at bottom)
            slider = ttk.Scale(col_frame, from_=12, to=-12, orient=tk.VERTICAL,
                             length=280, command=lambda v, f=freq: self.on_slider_changed(f, v))
            slider.set(self.band_gains[freq])
            slider.pack()
            
            # Value label at bottom
            value_label = tk.Label(col_frame, text=f"{self.band_gains[freq]:+.1f} dB",
                                  font=('TkDefaultFont', 8))
            value_label.pack(pady=(5, 0))
            
            self.sliders.append((freq, slider, value_label))
        
        # Configure grid weights for even spacing
        for i in range(len(self.EQ_BANDS)):
            slider_frame.columnconfigure(i, weight=1)
        
        # Button frame at bottom
        button_frame = ttk.Frame(main_frame)
        button_frame.pack(fill=tk.X, pady=(10, 0))
        
        # Reset button
        reset_btn = ttk.Button(button_frame, text="Reset All", command=self.reset_all)
        reset_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        # Preset buttons
        ttk.Label(button_frame, text="Presets:").pack(side=tk.LEFT, padx=(20, 5))
        
        presets = [
            ("Flat", self.preset_flat),
            ("Bass Boost", self.preset_bass_boost),
            ("Treble Boost", self.preset_treble_boost),
            ("Voice", self.preset_voice),
        ]
        
        for name, callback in presets:
            btn = ttk.Button(button_frame, text=name, command=callback, width=12)
            btn.pack(side=tk.LEFT, padx=2)
    
    def on_slider_changed(self, freq: int, value: str):
        """Handle slider value change.
        
        Args:
            freq: Frequency band (Hz)
            value: New gain value (dB) as string
        """
        try:
            gain_db = float(value)
            self.band_gains[freq] = gain_db
            
            # Update value label
            for f, slider, label in self.sliders:
                if f == freq:
                    label.config(text=f"{gain_db:+.1f} dB")
                    break
            
            # Notify callback if enabled
            if self.enabled_var.get() and self.on_change_callback:
                self.on_change_callback(self.band_gains.copy())
        except ValueError:
            pass
    
    def on_enable_changed(self):
        """Handle enable/disable checkbox change."""
        enabled = self.enabled_var.get()
        
        # Notify callback
        if self.on_change_callback:
            if enabled:
                self.on_change_callback(self.band_gains.copy())
            else:
                # Send None to indicate EQ is disabled
                self.on_change_callback(None)
    
    def reset_all(self):
        """Reset all bands to 0 dB."""
        for freq, slider, label in self.sliders:
            slider.set(0.0)
            self.band_gains[freq] = 0.0
            label.config(text="+0.0 dB")
        
        # Notify callback if enabled
        if self.enabled_var.get() and self.on_change_callback:
            self.on_change_callback(self.band_gains.copy())
    
    def preset_flat(self):
        """Apply flat preset (all 0 dB)."""
        self.reset_all()
    
    def preset_bass_boost(self):
        """Apply bass boost preset."""
        preset = {
            31: 6.0,
            62: 5.0,
            125: 4.0,
            250: 2.0,
            500: 0.0,
            1000: 0.0,
            2000: 0.0,
            4000: 0.0,
            8000: 0.0,
            16000: 0.0
        }
        self.apply_preset(preset)
    
    def preset_treble_boost(self):
        """Apply treble boost preset."""
        preset = {
            31: 0.0,
            62: 0.0,
            125: 0.0,
            250: 0.0,
            500: 0.0,
            1000: 0.0,
            2000: 2.0,
            4000: 4.0,
            8000: 5.0,
            16000: 6.0
        }
        self.apply_preset(preset)
    
    def preset_voice(self):
        """Apply voice preset (emphasize 300-3000 Hz)."""
        preset = {
            31: -3.0,
            62: -2.0,
            125: 0.0,
            250: 3.0,
            500: 4.0,
            1000: 4.0,
            2000: 3.0,
            4000: 0.0,
            8000: -2.0,
            16000: -3.0
        }
        self.apply_preset(preset)
    
    def apply_preset(self, preset: dict):
        """Apply a preset configuration.
        
        Args:
            preset: Dictionary of {frequency: gain_db}
        """
        for freq, gain_db in preset.items():
            if freq in self.band_gains:
                self.band_gains[freq] = gain_db
                
                # Update slider and label
                for f, slider, label in self.sliders:
                    if f == freq:
                        slider.set(gain_db)
                        label.config(text=f"{gain_db:+.1f} dB")
                        break
        
        # Notify callback if enabled
        if self.enabled_var.get() and self.on_change_callback:
            self.on_change_callback(self.band_gains.copy())
    
    def load_settings(self):
        """Load EQ settings from config file."""
        try:
            if os.path.exists(self.config_file):
                with open(self.config_file, 'r') as f:
                    data = json.load(f)
                    
                    # Load band gains
                    if 'band_gains' in data:
                        for freq_str, gain in data['band_gains'].items():
                            freq = int(freq_str)
                            if freq in self.band_gains:
                                self.band_gains[freq] = float(gain)
        except Exception as e:
            print(f"Error loading EQ settings: {e}")
    
    def save_settings(self):
        """Save EQ settings to config file."""
        try:
            data = {
                'band_gains': {str(freq): gain for freq, gain in self.band_gains.items()}
            }
            
            with open(self.config_file, 'w') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            print(f"Error saving EQ settings: {e}")
    
    def on_close(self):
        """Handle window close event."""
        # Save settings
        self.save_settings()
        
        # Hide window instead of destroying it
        self.window.withdraw()
    
    def show(self):
        """Show the EQ window."""
        if self.window:
            self.window.deiconify()
            self.window.lift()
    
    def is_enabled(self) -> bool:
        """Check if EQ is enabled.
        
        Returns:
            True if EQ is enabled, False otherwise
        """
        return self.enabled_var.get() if self.enabled_var else False
    
    def get_band_gains(self) -> dict:
        """Get current band gains.
        
        Returns:
            Dictionary of {frequency: gain_db}
        """
        return self.band_gains.copy()


def create_eq_window(parent: tk.Tk, on_change_callback: Optional[Callable] = None) -> EQDisplay:
    """Create and return an EQ display window.
    
    Args:
        parent: Parent Tkinter window
        on_change_callback: Callback function(band_gains: dict) called when EQ changes
    
    Returns:
        EQDisplay instance
    """
    return EQDisplay(parent, on_change_callback)