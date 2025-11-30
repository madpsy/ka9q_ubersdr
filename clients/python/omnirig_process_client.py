#!/usr/bin/env python3
"""
OmniRig process client - communicates with isolated OmniRig process.
Provides the same API as OmniRigController but uses multiprocessing for isolation.
"""

import platform
import multiprocessing
import time
from typing import Optional, Callable
import queue

# Check if we're on Windows and pywin32 is available
OMNIRIG_AVAILABLE = False
if platform.system() == 'Windows':
    try:
        # Check if pywin32 is available first
        import win32com.client
        import pythoncom
        # Then import the process module
        from omnirig_process import run_omnirig_process
        OMNIRIG_AVAILABLE = True
    except ImportError:
        pass


class OmniRigProcessClient:
    """OmniRig client that communicates with isolated COM process.
    
    This class provides the same API as OmniRigController but runs OmniRig
    in a separate process to avoid GIL conflicts with the main application.
    """
    
    def __init__(self, rig_number: int = 1, vfo: str = 'A'):
        """Initialize OmniRig process client.
        
        Args:
            rig_number: Rig number (1 or 2) in OmniRig
            vfo: VFO to use ('A' or 'B')
        """
        if not OMNIRIG_AVAILABLE:
            raise ImportError("OmniRig requires Windows and pywin32. Install with: pip install pywin32")
        
        self.rig_number = rig_number
        self.vfo = vfo.upper()
        self.connected = False
        self.running = False
        
        # Multiprocessing queues for IPC
        self.command_queue = None
        self.event_queue = None
        self.process = None
        
        # Callbacks
        self.frequency_callback: Optional[Callable[[int], None]] = None
        self.mode_callback: Optional[Callable[[str], None]] = None
        self.ptt_callback: Optional[Callable[[bool], None]] = None
        self.error_callback: Optional[Callable[[str], None]] = None
        
        # Cache for current state
        self._last_freq: Optional[int] = None
        self._last_mode: Optional[str] = None
        self._last_ptt: Optional[bool] = None
    
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
        """Connect to OmniRig via isolated process.
        
        Returns:
            True if connection successful, False otherwise
        """
        try:
            # Create queues for IPC
            self.command_queue = multiprocessing.Queue()
            self.event_queue = multiprocessing.Queue()
            
            # Start OmniRig process
            self.process = multiprocessing.Process(
                target=run_omnirig_process,
                args=(self.command_queue, self.event_queue),
                daemon=True  # Process will terminate when main process exits
            )
            self.process.start()
            
            # Send connect command
            self.command_queue.put(('connect', self.rig_number, self.vfo))
            
            # Wait for connection result (with timeout)
            timeout = 5.0  # 5 seconds
            start_time = time.time()
            
            while time.time() - start_time < timeout:
                try:
                    event = self.event_queue.get(timeout=0.1)
                    if event[0] == 'connected':
                        self.connected = event[1]
                        self.running = self.connected
                        return self.connected
                    elif event[0] == 'error':
                        if self.error_callback:
                            self.error_callback(event[1])
                        return False
                except queue.Empty:
                    continue
            
            # Timeout
            if self.error_callback:
                self.error_callback("Connection timeout")
            return False
        
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Failed to start OmniRig process: {e}")
            return False
    
    def disconnect(self):
        """Disconnect from OmniRig and stop process."""
        self.running = False
        self.connected = False
        
        if self.command_queue:
            try:
                self.command_queue.put(('shutdown',))
            except:
                pass
        
        if self.process and self.process.is_alive():
            self.process.join(timeout=2.0)
            if self.process.is_alive():
                self.process.terminate()
        
        self.process = None
        self.command_queue = None
        self.event_queue = None
    
    def poll(self):
        """Poll for events from OmniRig process.
        
        This must be called regularly (e.g., every 20ms) from the main thread
        to process events from the OmniRig process.
        """
        if not self.connected or not self.event_queue:
            return
        
        try:
            # Process all pending events (non-blocking)
            while True:
                try:
                    event = self.event_queue.get_nowait()
                    self._handle_event(event)
                except queue.Empty:
                    break
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Poll error: {e}")
    
    def _handle_event(self, event):
        """Handle an event from the OmniRig process.
        
        Args:
            event: Tuple of (event_type, *args)
        """
        try:
            event_type = event[0]
            
            if event_type == 'freq_changed':
                freq = event[1]
                if freq != self._last_freq:
                    self._last_freq = freq
                    if self.frequency_callback:
                        self.frequency_callback(freq)
            
            elif event_type == 'mode_changed':
                mode = event[1]
                if mode != self._last_mode:
                    self._last_mode = mode
                    if self.mode_callback:
                        self.mode_callback(mode)
            
            elif event_type == 'ptt_changed':
                ptt = event[1]
                if ptt != self._last_ptt:
                    self._last_ptt = ptt
                    if self.ptt_callback:
                        self.ptt_callback(ptt)
            
            elif event_type == 'vfo_changed':
                self.vfo = event[1]
            
            elif event_type == 'error':
                if self.error_callback:
                    self.error_callback(event[1])
            
            elif event_type == 'disconnected':
                self.connected = False
                self.running = False
        
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Event handling error: {e}")
    
    def get_frequency(self) -> Optional[int]:
        """Get cached frequency (thread-safe, non-blocking).
        
        Returns:
            Frequency in Hz, or None if not available
        """
        return self._last_freq
    
    def set_frequency(self, freq_hz: int):
        """Set frequency on rig (non-blocking).
        
        Args:
            freq_hz: Frequency in Hz
        """
        if self.connected and self.command_queue:
            try:
                self.command_queue.put(('set_freq', freq_hz))
            except Exception as e:
                if self.error_callback:
                    self.error_callback(f"Error queuing frequency command: {e}")
    
    def get_mode(self) -> Optional[str]:
        """Get cached mode (thread-safe, non-blocking).
        
        Returns:
            Mode string, or None if not available
        """
        return self._last_mode
    
    def set_mode(self, mode: str):
        """Set mode on rig (non-blocking).
        
        Args:
            mode: Mode string (USB, LSB, CW, AM, FM)
        """
        if self.connected and self.command_queue:
            try:
                self.command_queue.put(('set_mode', mode))
            except Exception as e:
                if self.error_callback:
                    self.error_callback(f"Error queuing mode command: {e}")
    
    def get_ptt(self) -> Optional[bool]:
        """Get cached PTT state (thread-safe, non-blocking).
        
        Returns:
            PTT state (True=transmitting, False=receiving), or None if not available
        """
        return self._last_ptt
    
    def set_vfo(self, vfo: str):
        """Change the active VFO.
        
        Args:
            vfo: VFO to use ('A' or 'B')
        """
        if self.connected and self.command_queue:
            try:
                self.command_queue.put(('set_vfo', vfo.upper()))
                self.vfo = vfo.upper()
            except Exception as e:
                if self.error_callback:
                    self.error_callback(f"Error queuing VFO command: {e}")
    
    def get_vfo(self) -> str:
        """Get current VFO.
        
        Returns:
            Current VFO ('A' or 'B')
        """
        return self.vfo


# Alias for compatibility
ThreadedOmniRigClient = OmniRigProcessClient