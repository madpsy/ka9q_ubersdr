#!/usr/bin/env python3
"""
OmniRig v1 COM interface for radio control (Windows only).
Provides bidirectional frequency and mode synchronization with physical radios.
"""

import platform
import threading
import time
from typing import Optional, Callable

# Check if we're on Windows and pywin32 is available
OMNIRIG_AVAILABLE = False
if platform.system() == 'Windows':
    try:
        import win32com.client
        import pythoncom
        OMNIRIG_AVAILABLE = True
    except ImportError:
        pass


class OmniRigController:
    """OmniRig v1 COM interface for radio control (Windows only)."""
    
    # OmniRig status constants
    ST_NOTCONFIGURED = 0
    ST_DISABLED = 1
    ST_PORTBUSY = 2
    ST_NOTRESPONDING = 3
    ST_ONLINE = 4
    
    # OmniRig mode constants (will be set from COM object)
    PM_CW_U = None
    PM_CW_L = None
    PM_SSB_U = None
    PM_SSB_L = None
    PM_DIG_U = None
    PM_DIG_L = None
    PM_AM = None
    PM_FM = None
    
    def __init__(self, rig_number: int = 1):
        """Initialize OmniRig controller.
        
        Args:
            rig_number: Rig number (1 or 2) in OmniRig
        """
        if not OMNIRIG_AVAILABLE:
            raise ImportError("OmniRig requires pywin32 on Windows. Install with: pip install pywin32")
        
        self.rig_number = rig_number
        self.omnirig = None
        self.rig = None
        self.connected = False
        self.running = False
        
        # Callbacks
        self.frequency_callback: Optional[Callable[[int], None]] = None
        self.mode_callback: Optional[Callable[[str], None]] = None
        self.ptt_callback: Optional[Callable[[bool], None]] = None
        self.error_callback: Optional[Callable[[str], None]] = None
        
        # Polling thread
        self.poll_thread: Optional[threading.Thread] = None
        self.poll_interval = 0.02  # 20ms polling interval (50 Hz, matching rigctl)
        
        # Cache for change detection
        self._last_freq: Optional[int] = None
        self._last_mode: Optional[str] = None
        self._last_ptt: Optional[bool] = None
        
        # Command queue for thread-safe operations
        self._command_queue = []
        self._command_lock = threading.Lock()
    
    def set_callbacks(self, frequency_callback: Optional[Callable[[int], None]] = None,
                     mode_callback: Optional[Callable[[str], None]] = None,
                     ptt_callback: Optional[Callable[[bool], None]] = None,
                     error_callback: Optional[Callable[[str], None]] = None):
        """Set callbacks for value changes.
        
        Args:
            frequency_callback: Called when frequency changes (freq_hz)
            mode_callback: Called when mode changes (mode_str)
            ptt_callback: Called when PTT state changes (ptt_state)
            error_callback: Called on errors (error_str)
        """
        self.frequency_callback = frequency_callback
        self.mode_callback = mode_callback
        self.ptt_callback = ptt_callback
        self.error_callback = error_callback
    
    def connect(self) -> bool:
        """Connect to OmniRig COM server.
        
        Returns:
            True if connection successful, False otherwise
        """
        try:
            # Initialize COM for this thread
            pythoncom.CoInitialize()
            
            # Create OmniRig COM object
            self.omnirig = win32com.client.Dispatch("OmniRig.OmniRigX")
            
            # Store mode constants from COM object
            self.PM_CW_U = self.omnirig.PM_CW_U
            self.PM_CW_L = self.omnirig.PM_CW_L
            self.PM_SSB_U = self.omnirig.PM_SSB_U
            self.PM_SSB_L = self.omnirig.PM_SSB_L
            self.PM_DIG_U = self.omnirig.PM_DIG_U
            self.PM_DIG_L = self.omnirig.PM_DIG_L
            self.PM_AM = self.omnirig.PM_AM
            self.PM_FM = self.omnirig.PM_FM
            
            # Get the specified rig
            if self.rig_number == 1:
                self.rig = self.omnirig.Rig1
            else:
                self.rig = self.omnirig.Rig2
            
            # Check if rig is online
            if self.rig.Status == self.ST_NOTCONFIGURED:
                if self.error_callback:
                    self.error_callback("Rig not configured in OmniRig")
                return False
            
            if self.rig.Status != self.ST_ONLINE:
                if self.error_callback:
                    self.error_callback(f"Rig not online (status: {self.rig.Status})")
                return False
            
            self.connected = True
            self.running = True
            
            # Initialize cache
            self._last_freq = self._get_frequency_internal()
            self._last_mode = self._get_mode_internal()
            self._last_ptt = self._get_ptt_internal()
            
            # Start polling thread
            self.poll_thread = threading.Thread(target=self._poll_loop, daemon=True)
            self.poll_thread.start()
            
            return True
            
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Failed to connect to OmniRig: {e}")
            return False
    
    def disconnect(self):
        """Disconnect from OmniRig."""
        self.running = False
        self.connected = False
        
        # Wait for poll thread to finish
        if self.poll_thread and self.poll_thread.is_alive():
            self.poll_thread.join(timeout=1.0)
        
        self.rig = None
        self.omnirig = None
        
        try:
            pythoncom.CoUninitialize()
        except:
            pass
    
    def _poll_loop(self):
        """Polling loop that runs in separate thread."""
        # Initialize COM for this thread
        pythoncom.CoInitialize()
        
        try:
            while self.running and self.connected:
                try:
                    # Process any queued commands
                    self._process_command_queue()
                    
                    # Check for changes
                    current_freq = self._get_frequency_internal()
                    current_mode = self._get_mode_internal()
                    current_ptt = self._get_ptt_internal()
                    
                    # Detect frequency changes
                    if current_freq is not None and current_freq != self._last_freq:
                        self._last_freq = current_freq
                        if self.frequency_callback:
                            self.frequency_callback(current_freq)
                    
                    # Detect mode changes
                    if current_mode is not None and current_mode != self._last_mode:
                        self._last_mode = current_mode
                        if self.mode_callback:
                            self.mode_callback(current_mode)
                    
                    # Detect PTT changes
                    if current_ptt is not None and current_ptt != self._last_ptt:
                        self._last_ptt = current_ptt
                        if self.ptt_callback:
                            self.ptt_callback(current_ptt)
                    
                    # Sleep before next poll
                    time.sleep(self.poll_interval)
                    
                except Exception as e:
                    if self.error_callback:
                        self.error_callback(f"Poll error: {e}")
                    time.sleep(1.0)  # Back off on error
        finally:
            pythoncom.CoUninitialize()
    
    def _process_command_queue(self):
        """Process queued commands (runs in poll thread)."""
        with self._command_lock:
            while self._command_queue:
                cmd_type, cmd_value = self._command_queue.pop(0)
                
                try:
                    if cmd_type == 'freq':
                        self._set_frequency_internal(cmd_value)
                    elif cmd_type == 'mode':
                        self._set_mode_internal(cmd_value)
                except Exception as e:
                    if self.error_callback:
                        self.error_callback(f"Command error: {e}")
    
    def _get_frequency_internal(self) -> Optional[int]:
        """Get frequency from rig (internal, runs in poll thread)."""
        try:
            if self.rig and self.connected:
                return int(self.rig.Freq)
        except Exception:
            pass
        return None
    
    def _get_mode_internal(self) -> Optional[str]:
        """Get mode from rig (internal, runs in poll thread)."""
        try:
            if self.rig and self.connected:
                mode_value = self.rig.Mode
                return self._omnirig_mode_to_string(mode_value)
        except Exception:
            pass
        return None
    
    def _set_frequency_internal(self, freq_hz: int):
        """Set frequency on rig (internal, runs in poll thread)."""
        if self.rig and self.connected:
            self.rig.Freq = int(freq_hz)
            self._last_freq = freq_hz  # Update cache immediately
    
    def _set_mode_internal(self, mode: str):
        """Set mode on rig (internal, runs in poll thread)."""
        if self.rig and self.connected:
            omnirig_mode = self._string_to_omnirig_mode(mode)
            if omnirig_mode is not None:
                self.rig.Mode = omnirig_mode
                self._last_mode = mode  # Update cache immediately
    
    def get_frequency(self) -> Optional[int]:
        """Get cached frequency (thread-safe, non-blocking).
        
        Returns:
            Frequency in Hz, or None if not available
        """
        return self._last_freq
    
    def get_mode(self) -> Optional[str]:
        """Get cached mode (thread-safe, non-blocking).
        
        Returns:
            Mode string, or None if not available
        """
        return self._last_mode
    
    def get_ptt(self) -> Optional[bool]:
        """Get cached PTT state (thread-safe, non-blocking).
        
        Returns:
            PTT state (True=transmitting, False=receiving), or None if not available
        """
        return self._last_ptt
    
    def _get_ptt_internal(self) -> Optional[bool]:
        """Get PTT state from rig (internal, runs in poll thread)."""
        try:
            if self.rig and self.connected:
                # OmniRig Tx property: 0=RX, non-zero=TX
                return bool(self.rig.Tx)
        except Exception:
            pass
        return None
    
    def set_frequency(self, freq_hz: int):
        """Queue frequency change (thread-safe, non-blocking).
        
        Args:
            freq_hz: Frequency in Hz
        """
        with self._command_lock:
            self._command_queue.append(('freq', freq_hz))
    
    def set_mode(self, mode: str):
        """Queue mode change (thread-safe, non-blocking).
        
        Args:
            mode: Mode string (USB, LSB, CW, AM, FM)
        """
        with self._command_lock:
            self._command_queue.append(('mode', mode))
    
    def poll(self):
        """Trigger a poll cycle (for compatibility with rigctl interface)."""
        # Polling happens automatically in background thread
        pass
    
    def _omnirig_mode_to_string(self, mode_value) -> str:
        """Convert OmniRig mode constant to string.
        
        Args:
            mode_value: OmniRig mode constant
            
        Returns:
            Mode string (USB, LSB, CW, AM, FM)
        """
        if mode_value == self.PM_SSB_U or mode_value == self.PM_DIG_U:
            return 'USB'
        elif mode_value == self.PM_SSB_L or mode_value == self.PM_DIG_L:
            return 'LSB'
        elif mode_value == self.PM_CW_U or mode_value == self.PM_CW_L:
            return 'CW'
        elif mode_value == self.PM_AM:
            return 'AM'
        elif mode_value == self.PM_FM:
            return 'FM'
        else:
            return 'USB'  # Default
    
    def _string_to_omnirig_mode(self, mode: str) -> Optional[int]:
        """Convert mode string to OmniRig mode constant.
        
        Args:
            mode: Mode string (USB, LSB, CW, AM, FM)
            
        Returns:
            OmniRig mode constant, or None if invalid
        """
        mode_upper = mode.upper()
        
        if mode_upper == 'USB':
            return self.PM_SSB_U
        elif mode_upper == 'LSB':
            return self.PM_SSB_L
        elif mode_upper == 'CW':
            return self.PM_CW_U
        elif mode_upper == 'AM':
            return self.PM_AM
        elif mode_upper == 'FM':
            return self.PM_FM
        else:
            return None


# Alias for compatibility with rigctl interface
ThreadedOmniRigClient = OmniRigController