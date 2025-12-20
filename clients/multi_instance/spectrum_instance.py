"""
Spectrum Instance Model
Represents a single spectrum connection instance
"""

from typing import Optional, List
import tkinter as tk


class SpectrumInstance:
    """Represents a single spectrum connection instance."""
    
    # ID labels for instances (A, B, C, etc.)
    ID_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
    
    def __init__(self, instance_id: int):
        self.instance_id = instance_id
        self.id_label = self.ID_LABELS[instance_id] if instance_id < len(self.ID_LABELS) else str(instance_id)
        self.name = f"Instance {instance_id}"
        self.callsign = ""  # Operator callsign
        self.host = ""
        self.port = 8080
        self.tls = False
        self.frequency = 14100000  # Default 14.1 MHz
        self.mode = "USB"  # Default mode
        self.bandwidth = 2700  # Default bandwidth in Hz
        self.enabled = False
        self.connected = False
        self.locked = False  # Lock state to prevent changes
        
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
            'mode': self.mode,
            'bandwidth': self.bandwidth,
            'enabled': self.enabled,
            'locked': self.locked
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
        instance.mode = data.get('mode', 'USB')
        instance.bandwidth = data.get('bandwidth', 2700)
        instance.enabled = data.get('enabled', False)
        instance.locked = data.get('locked', False)
        return instance
    
    def get_display_name(self) -> str:
        """Get the display name with callsign prefix if available."""
        if self.callsign:
            return f"({self.callsign}) {self.name}"
        return self.name
    
    def get_id_display_name(self) -> str:
        """Get the display name with ID label prefix.
        
        Format: [A] (Callsign) Name or [A] Name
        This allows the same server to be added multiple times with different IDs.
        """
        base_name = self.get_display_name()
        return f"[{self.id_label}] {base_name}"