"""
Spectrum Instance Model
Represents a single spectrum connection instance
"""

from typing import Optional, List
import tkinter as tk


class SpectrumInstance:
    """Represents a single spectrum connection instance."""
    
    def __init__(self, instance_id: int):
        self.instance_id = instance_id
        self.name = f"Instance {instance_id}"
        self.callsign = ""  # Operator callsign
        self.host = ""
        self.port = 8080
        self.tls = False
        self.frequency = 14100000  # Default 14.1 MHz
        self.enabled = False
        self.connected = False
        
        # Spectrum display components
        self.spectrum = None  # SpectrumDisplay instance
        self.frame: Optional[tk.Frame] = None
        self.status_var: Optional[tk.StringVar] = None
        
        # WebSocket session
        self.user_session_id: Optional[str] = None
        self.password: Optional[str] = None
        
        # Connection metadata from /connection endpoint
        self.bypassed = False  # Connection bypassed status
        self.allowed_iq_modes: List[str] = []  # List of allowed IQ modes
        self.max_session_time = 0  # Maximum session time in seconds (0 = unlimited)
        self.connection_start_time: Optional[float] = None  # Time when connection was established
        
        # Server spectrum configuration from /api/description endpoint
        self.spectrum_poll_period = 100  # Server's spectrum update period in ms (default 100ms = 10Hz)
    
    @property
    def update_rate_hz(self) -> float:
        """Get the spectrum update rate in Hz based on server's poll period."""
        return 1000.0 / self.spectrum_poll_period if self.spectrum_poll_period > 0 else 10.0
    
    def to_dict(self) -> dict:
        """Convert instance to dictionary for saving."""
        return {
            'name': self.name,
            'callsign': self.callsign,
            'host': self.host,
            'port': self.port,
            'tls': self.tls,
            'frequency': self.frequency,
            'enabled': self.enabled
        }
    
    @classmethod
    def from_dict(cls, instance_id: int, data: dict) -> 'SpectrumInstance':
        """Create instance from dictionary."""
        instance = cls(instance_id)
        instance.name = data.get('name', f"Instance {instance_id}")
        instance.callsign = data.get('callsign', '')
        instance.host = data.get('host', 'localhost')
        instance.port = data.get('port', 8080)
        instance.tls = data.get('tls', False)
        instance.frequency = data.get('frequency', 14100000)
        instance.enabled = data.get('enabled', False)
        return instance
    
    def get_display_name(self) -> str:
        """Get the display name with callsign prefix if available."""
        if self.callsign:
            return f"({self.callsign}) {self.name}"
        return self.name