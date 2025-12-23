#!/usr/bin/env python3
"""
OmniRig v1 COM interface for radio control (Windows only).
Provides bidirectional frequency and mode synchronization with physical radios.
Uses event-driven architecture matching the official OmniRig Pascal client.
"""

import platform
import threading
import time
from typing import Optional, Callable
import ctypes

# Check if we're on Windows and pywin32 is available
OMNIRIG_AVAILABLE = False
if platform.system() == 'Windows':
    try:
        import win32com.client
        import win32com.client.gencache
        import pythoncom
        OMNIRIG_AVAILABLE = True
    except ImportError:
        pass


# Global flag for event handlers (C-level integer, safe without GIL)
# Using ctypes.c_int for true thread-safety without GIL
_event_pending = ctypes.c_int(0)
_controller_instance = None

class OmniRigEvents:
    """Event handler class for OmniRig COM events.
    
    CRITICAL: These methods are called by COM without the GIL held.
    They must do MINIMAL work - just set a C-level flag. All actual processing
    happens in poll() which runs with the GIL held.
    """
    
    def OnVisibleChange(self):
        """Called when OmniRig dialog visibility changes."""
        pass  # Not used
    
    def OnRigTypeChange(self, RigNumber):
        """Called when rig type changes."""
        global _event_pending
        _event_pending.value = 1  # C-level assignment, safe without GIL
    
    def OnStatusChange(self, RigNumber):
        """Called when rig status changes."""
        global _event_pending
        _event_pending.value = 1  # C-level assignment, safe without GIL
    
    def OnParamsChange(self, RigNumber, Params):
        """Called when rig parameters change."""
        global _event_pending
        _event_pending.value = 1  # C-level assignment, safe without GIL
    
    def OnCustomReply(self, RigNumber, Command, Reply):
        """Called when custom command receives reply."""
        pass  # Not used


class OmniRigController:
    """OmniRig v1 COM interface for radio control (Windows only)."""
    
    # OmniRig status constants
    ST_NOTCONFIGURED = 0
    ST_DISABLED = 1
    ST_PORTBUSY = 2
    ST_NOTRESPONDING = 3
    ST_ONLINE = 4
    
    # OmniRig parameter constants (will be set from COM object)
    PM_UNKNOWN = None
    PM_FREQ = None
    PM_FREQA = None
    PM_FREQB = None
    PM_PITCH = None
    PM_RITOFFSET = None
    PM_RIT0 = None
    PM_VFOAA = None
    PM_VFOAB = None
    PM_VFOBA = None
    PM_VFOBB = None
    PM_VFOA = None
    PM_VFOB = None
    PM_VFOEQUAL = None
    PM_VFOSWAP = None
    PM_SPLITON = None
    PM_SPLITOFF = None
    PM_RITON = None
    PM_RITOFF = None
    PM_XITON = None
    PM_XITOFF = None
    PM_RX = None
    PM_TX = None
    PM_CW_U = None
    PM_CW_L = None
    PM_SSB_U = None
    PM_SSB_L = None
    PM_DIG_U = None
    PM_DIG_L = None
    PM_AM = None
    PM_FM = None
    
    def __init__(self, rig_number: int = 1, vfo: str = 'A'):
        """Initialize OmniRig controller.
        
        Args:
            rig_number: Rig number (1 or 2) in OmniRig
            vfo: VFO to use ('A' or 'B')
        """
        if not OMNIRIG_AVAILABLE:
            raise ImportError("OmniRig requires pywin32 on Windows. Install with: pip install pywin32")
        
        self.rig_number = rig_number
        self.vfo = vfo.upper()  # 'A' or 'B'
        self.omnirig = None
        self.rig = None
        self.connected = False
        self.running = False
        
        # Callbacks
        self.frequency_callback: Optional[Callable[[int], None]] = None
        self.mode_callback: Optional[Callable[[str], None]] = None
        self.ptt_callback: Optional[Callable[[bool], None]] = None
        self.error_callback: Optional[Callable[[str], None]] = None
        
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
        global _controller_instance
        
        try:
            # Don't call CoInitialize() - we're in the Tkinter main thread
            # which already handles Windows messages properly.
            # Calling CoInitialize() here can interfere with other threads' GIL management.
            
            # Set global controller reference for event handlers
            _controller_instance = self
            
            # Create OmniRig COM object with event support
            # Events will fire in this thread when we pump messages
            self.omnirig = win32com.client.DispatchWithEvents("OmniRig.OmniRigX", OmniRigEvents)
            
            # Import the generated constants module
            # The constants are module-level, not on the object
            try:
                omnirig_module = win32com.client.gencache.EnsureModule('{4FE359C5-A58F-459D-BE95-CA559FB4F270}', 0, 1, 0)
                
                # Store parameter constants from module
                self.PM_UNKNOWN = omnirig_module.constants.PM_UNKNOWN
                self.PM_FREQ = omnirig_module.constants.PM_FREQ
                self.PM_FREQA = omnirig_module.constants.PM_FREQA
                self.PM_FREQB = omnirig_module.constants.PM_FREQB
                self.PM_PITCH = omnirig_module.constants.PM_PITCH
                self.PM_RITOFFSET = omnirig_module.constants.PM_RITOFFSET
                self.PM_RIT0 = omnirig_module.constants.PM_RIT0
                self.PM_VFOAA = omnirig_module.constants.PM_VFOAA
                self.PM_VFOAB = omnirig_module.constants.PM_VFOAB
                self.PM_VFOBA = omnirig_module.constants.PM_VFOBA
                self.PM_VFOBB = omnirig_module.constants.PM_VFOBB
                self.PM_VFOA = omnirig_module.constants.PM_VFOA
                self.PM_VFOB = omnirig_module.constants.PM_VFOB
                self.PM_VFOEQUAL = omnirig_module.constants.PM_VFOEQUAL
                self.PM_VFOSWAP = omnirig_module.constants.PM_VFOSWAP
                self.PM_SPLITON = omnirig_module.constants.PM_SPLITON
                self.PM_SPLITOFF = omnirig_module.constants.PM_SPLITOFF
                self.PM_RITON = omnirig_module.constants.PM_RITON
                self.PM_RITOFF = omnirig_module.constants.PM_RITOFF
                self.PM_XITON = omnirig_module.constants.PM_XITON
                self.PM_XITOFF = omnirig_module.constants.PM_XITOFF
                self.PM_RX = omnirig_module.constants.PM_RX
                self.PM_TX = omnirig_module.constants.PM_TX
                self.PM_CW_U = omnirig_module.constants.PM_CW_U
                self.PM_CW_L = omnirig_module.constants.PM_CW_L
                self.PM_SSB_U = omnirig_module.constants.PM_SSB_U
                self.PM_SSB_L = omnirig_module.constants.PM_SSB_L
                self.PM_DIG_U = omnirig_module.constants.PM_DIG_U
                self.PM_DIG_L = omnirig_module.constants.PM_DIG_L
                self.PM_AM = omnirig_module.constants.PM_AM
                self.PM_FM = omnirig_module.constants.PM_FM
            except Exception as e:
                if self.error_callback:
                    self.error_callback(f"Failed to load OmniRig constants: {e}")
                raise
            
            # Get the specified rig
            if self.rig_number == 1:
                self.rig = self.omnirig.Rig1
            else:
                self.rig = self.omnirig.Rig2
            
            # Check if rig is configured
            if self.rig.Status == self.ST_NOTCONFIGURED:
                if self.error_callback:
                    self.error_callback("Rig not configured in OmniRig")
                return False
            
            # Check if rig is online
            if self.rig.Status != self.ST_ONLINE:
                if self.error_callback:
                    self.error_callback(f"Rig not online (status: {self.rig.Status})")
                return False
            
            self.connected = True
            self.running = True
            
            # Initialize cache with current values
            self._last_freq = self._get_frequency_internal()
            self._last_mode = self._get_mode_internal()
            self._last_ptt = self._get_ptt_internal()
            
            return True
            
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Failed to connect to OmniRig: {e}")
            return False
    
    def disconnect(self):
        """Disconnect from OmniRig."""
        global _controller_instance
        
        self.running = False
        self.connected = False
        _controller_instance = None
        
        self.rig = None
        self.omnirig = None
        
        # Don't call CoUninitialize() since we didn't call CoInitialize()
    
    def poll(self):
        """Poll for COM events and process queued commands.
        
        This must be called regularly (e.g., every 20ms) from the main thread
        to process COM events and execute queued commands.
        """
        global _event_pending
        
        if not self.connected:
            return
        
        try:
            # Pump COM messages to process events
            pythoncom.PumpWaitingMessages()
            
            # Check if any events occurred (C-level flag set by COM callbacks)
            if _event_pending.value:
                _event_pending.value = 0  # Clear flag
                # Read current state and check for changes
                self._check_for_changes()
            
            # Process any queued commands
            self._process_command_queue()
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Poll error: {e}")
    
    def _check_for_changes(self):
        """Check for parameter changes by polling current state.
        
        This runs with the GIL held, called from poll() after COM events fire.
        """
        try:
            # Check frequency
            freq = self._get_frequency_internal()
            if freq is not None and freq != self._last_freq:
                self._last_freq = freq
                if self.frequency_callback:
                    self.frequency_callback(freq)
            
            # Check mode
            mode = self._get_mode_internal()
            if mode is not None and mode != self._last_mode:
                self._last_mode = mode
                if self.mode_callback:
                    self.mode_callback(mode)
            
            # Check PTT
            ptt = self._get_ptt_internal()
            if ptt is not None and ptt != self._last_ptt:
                self._last_ptt = ptt
                if self.ptt_callback:
                    self.ptt_callback(ptt)
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Change detection error: {e}")
    
    def _process_command_queue(self):
        """Process queued commands (runs with GIL held)."""
        commands_to_process = []
        
        # Get all pending commands
        with self._command_lock:
            while self._command_queue:
                commands_to_process.append(self._command_queue.pop(0))
        
        # Process commands outside the lock
        for item in commands_to_process:
            try:
                cmd_type = item[0]
                
                if cmd_type == 'freq':
                    self._set_frequency_internal(item[1])
                elif cmd_type == 'mode':
                    self._set_mode_internal(item[1])
            except Exception as e:
                if self.error_callback:
                    self.error_callback(f"Command error ({cmd_type}): {e}")
    
    def _get_frequency_internal(self) -> Optional[int]:
        """Get frequency from rig (internal)."""
        try:
            if self.rig and self.connected:
                readable = self.rig.ReadableParams
                
                # Use VFO-specific frequency if available, otherwise fall back to Freq
                if self.vfo == 'A' and (readable & self.PM_FREQA):
                    return int(self.rig.FreqA)
                elif self.vfo == 'B' and (readable & self.PM_FREQB):
                    return int(self.rig.FreqB)
                elif readable & self.PM_FREQ:
                    return int(self.rig.Freq)
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Error reading frequency: {e}")
        return None
    
    def _get_mode_internal(self) -> Optional[str]:
        """Get mode from rig (internal)."""
        try:
            if self.rig and self.connected:
                mode_value = self.rig.Mode
                return self._omnirig_mode_to_string(mode_value)
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Error reading mode: {e}")
        return None
    
    def _set_frequency_internal(self, freq_hz: int):
        """Set frequency on rig (internal)."""
        try:
            if self.rig and self.connected:
                writeable = self.rig.WriteableParams
                
                # Use VFO-specific frequency if available, otherwise fall back to Freq
                if self.vfo == 'A' and (writeable & self.PM_FREQA):
                    self.rig.FreqA = int(freq_hz)
                    self._last_freq = freq_hz
                elif self.vfo == 'B' and (writeable & self.PM_FREQB):
                    self.rig.FreqB = int(freq_hz)
                    self._last_freq = freq_hz
                elif writeable & self.PM_FREQ:
                    self.rig.Freq = int(freq_hz)
                    self._last_freq = freq_hz
                else:
                    if self.error_callback:
                        self.error_callback(f"Frequency is not writeable on VFO {self.vfo}")
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Error setting frequency: {e}")
    
    def _set_mode_internal(self, mode: str):
        """Set mode on rig (internal)."""
        try:
            if self.rig and self.connected:
                omnirig_mode = self._string_to_omnirig_mode(mode)
                if omnirig_mode is not None:
                    # Check if mode is writeable
                    writeable = self.rig.WriteableParams
                    if writeable & omnirig_mode:
                        self.rig.Mode = omnirig_mode
                        self._last_mode = mode  # Update cache immediately
                    else:
                        if self.error_callback:
                            self.error_callback(f"Mode {mode} is not writeable on this rig")
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Error setting mode: {e}")
    
    def get_frequency(self) -> Optional[int]:
        """Get cached frequency (thread-safe, non-blocking).
        
        Returns:
            Frequency in Hz, or None if not available
        """
        return self._last_freq
    
    def set_vfo(self, vfo: str):
        """Change the active VFO.
        
        Args:
            vfo: VFO to use ('A' or 'B')
        """
        self.vfo = vfo.upper()
        # Re-read frequency from new VFO
        self._last_freq = self._get_frequency_internal()
        if self.error_callback:
            self.error_callback(f"Switched to VFO {self.vfo}")
    
    def get_vfo(self) -> str:
        """Get current VFO.
        
        Returns:
            Current VFO ('A' or 'B')
        """
        return self.vfo
    
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
        """Get PTT state from rig (internal)."""
        try:
            if self.rig and self.connected:
                # OmniRig Tx property: PM_RX or PM_TX
                tx_state = self.rig.Tx
                return tx_state == self.PM_TX
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Error reading PTT: {e}")
        return None
    
    def set_frequency(self, freq_hz: int):
        """Queue frequency change (thread-safe, non-blocking).
        
        Args:
            freq_hz: Frequency in Hz
        """
        with self._command_lock:
            self._command_queue.append(('freq', freq_hz))
        if self.error_callback:
            self.error_callback(f"DEBUG: Queued freq command: {freq_hz} Hz")
    
    def set_mode(self, mode: str):
        """Queue mode change (thread-safe, non-blocking).
        
        Args:
            mode: Mode string (USB, LSB, CW, AM, FM)
        """
        with self._command_lock:
            self._command_queue.append(('mode', mode))
    
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