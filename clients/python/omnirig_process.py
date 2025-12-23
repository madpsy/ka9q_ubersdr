#!/usr/bin/env python3
"""
OmniRig COM process - runs in isolated process to avoid GIL conflicts.
This process handles all COM operations and communicates via queues.
"""

import multiprocessing
import platform
import sys
import time
from typing import Optional

# Check if we're on Windows and pywin32 is available
if platform.system() != 'Windows':
    print("OmniRig requires Windows", file=sys.stderr)
    sys.exit(1)

try:
    import win32com.client
    import win32com.client.gencache
    import pythoncom
except ImportError:
    print("OmniRig requires pywin32. Install with: pip install pywin32", file=sys.stderr)
    sys.exit(1)


class OmniRigProcessEvents:
    """Event handler for OmniRig COM events in isolated process."""
    
    def __init__(self, event_queue):
        self.event_queue = event_queue
    
    def OnVisibleChange(self):
        """Called when OmniRig dialog visibility changes."""
        pass  # Not used
    
    def OnRigTypeChange(self, RigNumber):
        """Called when rig type changes."""
        try:
            self.event_queue.put(('rig_type_changed', RigNumber))
        except:
            pass  # Queue might be closed
    
    def OnStatusChange(self, RigNumber):
        """Called when rig status changes."""
        try:
            self.event_queue.put(('status_changed', RigNumber))
        except:
            pass
    
    def OnParamsChange(self, RigNumber, Params):
        """Called when rig parameters change."""
        try:
            self.event_queue.put(('params_changed', RigNumber, Params))
        except:
            pass
    
    def OnCustomReply(self, RigNumber, Command, Reply):
        """Called when custom command receives reply."""
        pass  # Not used


class OmniRigProcess:
    """OmniRig COM controller running in isolated process."""
    
    # OmniRig status constants
    ST_NOTCONFIGURED = 0
    ST_DISABLED = 1
    ST_PORTBUSY = 2
    ST_NOTRESPONDING = 3
    ST_ONLINE = 4
    
    def __init__(self, command_queue, event_queue):
        """Initialize OmniRig process.
        
        Args:
            command_queue: Queue for receiving commands from main process
            event_queue: Queue for sending events to main process
        """
        self.command_queue = command_queue
        self.event_queue = event_queue
        self.omnirig = None
        self.rig = None
        self.rig_number = None
        self.vfo = 'A'
        self.connected = False
        self.running = True
        
        # Cache for change detection
        self._last_freq = None
        self._last_mode = None
        self._last_ptt = None
        
        # OmniRig constants (will be loaded from COM)
        self.constants = None
    
    def run(self):
        """Main process loop - handles COM and processes commands."""
        try:
            # Initialize COM in this process
            pythoncom.CoInitialize()
            
            # Main loop
            while self.running:
                # Process commands from main process
                self._process_commands()
                
                # Pump COM messages if connected
                if self.connected:
                    pythoncom.PumpWaitingMessages()
                    self._check_for_changes()
                
                # Small sleep to prevent busy loop
                time.sleep(0.01)  # 10ms
        
        except Exception as e:
            self.event_queue.put(('error', f"Process error: {e}"))
        
        finally:
            # Cleanup
            self._disconnect_internal()
            pythoncom.CoUninitialize()
    
    def _process_commands(self):
        """Process commands from command queue."""
        try:
            # Non-blocking check for commands
            while not self.command_queue.empty():
                try:
                    cmd = self.command_queue.get_nowait()
                    self._handle_command(cmd)
                except:
                    break  # Queue empty
        except Exception as e:
            self.event_queue.put(('error', f"Command processing error: {e}"))
    
    def _handle_command(self, cmd):
        """Handle a single command.
        
        Args:
            cmd: Tuple of (command_type, *args)
        """
        try:
            cmd_type = cmd[0]
            
            if cmd_type == 'connect':
                rig_number = cmd[1]
                vfo = cmd[2] if len(cmd) > 2 else 'A'
                success = self._connect_internal(rig_number, vfo)
                self.event_queue.put(('connected', success))
            
            elif cmd_type == 'disconnect':
                self._disconnect_internal()
                self.event_queue.put(('disconnected',))
            
            elif cmd_type == 'set_freq':
                freq_hz = cmd[1]
                self._set_frequency_internal(freq_hz)
            
            elif cmd_type == 'set_mode':
                mode = cmd[1]
                self._set_mode_internal(mode)
            
            elif cmd_type == 'set_vfo':
                vfo = cmd[1]
                self._set_vfo_internal(vfo)
            
            elif cmd_type == 'shutdown':
                self.running = False
        
        except Exception as e:
            self.event_queue.put(('error', f"Command error ({cmd_type}): {e}"))
    
    def _connect_internal(self, rig_number: int, vfo: str) -> bool:
        """Connect to OmniRig COM server.
        
        Args:
            rig_number: Rig number (1 or 2)
            vfo: VFO to use ('A' or 'B')
        
        Returns:
            True if connection successful
        """
        try:
            self.rig_number = rig_number
            self.vfo = vfo.upper()
            
            # Create OmniRig COM object with events
            # Note: We need to create a class that inherits from the event handler
            # to avoid metaclass conflicts with multiprocessing
            event_queue = self.event_queue
            
            class OmniRigEvents:
                """Event handler for OmniRig COM events."""
                
                def OnVisibleChange(self):
                    """Called when OmniRig dialog visibility changes."""
                    pass
                
                def OnRigTypeChange(self, RigNumber):
                    """Called when rig type changes."""
                    try:
                        event_queue.put(('rig_type_changed', RigNumber))
                    except:
                        pass
                
                def OnStatusChange(self, RigNumber):
                    """Called when rig status changes."""
                    try:
                        event_queue.put(('status_changed', RigNumber))
                    except:
                        pass
                
                def OnParamsChange(self, RigNumber, Params):
                    """Called when rig parameters change."""
                    try:
                        event_queue.put(('params_changed', RigNumber, Params))
                    except:
                        pass
                
                def OnCustomReply(self, RigNumber, Command, Reply):
                    """Called when custom command receives reply."""
                    pass
            
            self.omnirig = win32com.client.DispatchWithEvents("OmniRig.OmniRigX", OmniRigEvents)
            
            # Load constants
            omnirig_module = win32com.client.gencache.EnsureModule(
                '{4FE359C5-A58F-459D-BE95-CA559FB4F270}', 0, 1, 0)
            self.constants = omnirig_module.constants
            
            # Get the specified rig
            if self.rig_number == 1:
                self.rig = self.omnirig.Rig1
            else:
                self.rig = self.omnirig.Rig2
            
            # Check if rig is configured
            if self.rig.Status == self.ST_NOTCONFIGURED:
                self.event_queue.put(('error', "Rig not configured in OmniRig"))
                return False
            
            # Check if rig is online
            if self.rig.Status != self.ST_ONLINE:
                self.event_queue.put(('error', f"Rig not online (status: {self.rig.Status})"))
                return False
            
            self.connected = True
            
            # Initialize cache with current values
            self._last_freq = self._get_frequency_internal()
            self._last_mode = self._get_mode_internal()
            self._last_ptt = self._get_ptt_internal()
            
            # Send initial state
            if self._last_freq is not None:
                self.event_queue.put(('freq_changed', self._last_freq))
            if self._last_mode is not None:
                self.event_queue.put(('mode_changed', self._last_mode))
            if self._last_ptt is not None:
                self.event_queue.put(('ptt_changed', self._last_ptt))
            
            return True
        
        except Exception as e:
            self.event_queue.put(('error', f"Connection error: {e}"))
            return False
    
    def _disconnect_internal(self):
        """Disconnect from OmniRig."""
        self.connected = False
        self.rig = None
        self.omnirig = None
    
    def _check_for_changes(self):
        """Check for parameter changes and send events."""
        try:
            # Check frequency
            freq = self._get_frequency_internal()
            if freq is not None and freq != self._last_freq:
                self._last_freq = freq
                self.event_queue.put(('freq_changed', freq))
            
            # Check mode
            mode = self._get_mode_internal()
            if mode is not None and mode != self._last_mode:
                self._last_mode = mode
                self.event_queue.put(('mode_changed', mode))
            
            # Check PTT
            ptt = self._get_ptt_internal()
            if ptt is not None and ptt != self._last_ptt:
                self._last_ptt = ptt
                self.event_queue.put(('ptt_changed', ptt))
        
        except Exception as e:
            self.event_queue.put(('error', f"Change detection error: {e}"))
    
    def _get_frequency_internal(self) -> Optional[int]:
        """Get frequency from rig."""
        try:
            if self.rig and self.connected:
                readable = self.rig.ReadableParams
                
                # Use VFO-specific frequency if available
                if self.vfo == 'A' and (readable & self.constants.PM_FREQA):
                    return int(self.rig.FreqA)
                elif self.vfo == 'B' and (readable & self.constants.PM_FREQB):
                    return int(self.rig.FreqB)
                elif readable & self.constants.PM_FREQ:
                    return int(self.rig.Freq)
        except:
            pass
        return None
    
    def _get_mode_internal(self) -> Optional[str]:
        """Get mode from rig."""
        try:
            if self.rig and self.connected:
                mode_value = self.rig.Mode
                return self._omnirig_mode_to_string(mode_value)
        except:
            pass
        return None
    
    def _get_ptt_internal(self) -> Optional[bool]:
        """Get PTT state from rig."""
        try:
            if self.rig and self.connected:
                tx_state = self.rig.Tx
                return tx_state == self.constants.PM_TX
        except:
            pass
        return None
    
    def _set_frequency_internal(self, freq_hz: int):
        """Set frequency on rig."""
        try:
            if self.rig and self.connected:
                writeable = self.rig.WriteableParams
                
                # Use VFO-specific frequency if available
                if self.vfo == 'A' and (writeable & self.constants.PM_FREQA):
                    self.rig.FreqA = int(freq_hz)
                    self._last_freq = freq_hz
                elif self.vfo == 'B' and (writeable & self.constants.PM_FREQB):
                    self.rig.FreqB = int(freq_hz)
                    self._last_freq = freq_hz
                elif writeable & self.constants.PM_FREQ:
                    self.rig.Freq = int(freq_hz)
                    self._last_freq = freq_hz
        except Exception as e:
            self.event_queue.put(('error', f"Error setting frequency: {e}"))
    
    def _set_mode_internal(self, mode: str):
        """Set mode on rig."""
        try:
            if self.rig and self.connected:
                omnirig_mode = self._string_to_omnirig_mode(mode)
                if omnirig_mode is not None:
                    writeable = self.rig.WriteableParams
                    if writeable & omnirig_mode:
                        self.rig.Mode = omnirig_mode
                        self._last_mode = mode
        except Exception as e:
            self.event_queue.put(('error', f"Error setting mode: {e}"))
    
    def _set_vfo_internal(self, vfo: str):
        """Change active VFO."""
        self.vfo = vfo.upper()
        # Re-read frequency from new VFO
        freq = self._get_frequency_internal()
        if freq is not None:
            self._last_freq = freq
            self.event_queue.put(('freq_changed', freq))
        self.event_queue.put(('vfo_changed', self.vfo))
    
    def _omnirig_mode_to_string(self, mode_value) -> str:
        """Convert OmniRig mode constant to string."""
        c = self.constants
        if mode_value == c.PM_SSB_U or mode_value == c.PM_DIG_U:
            return 'USB'
        elif mode_value == c.PM_SSB_L or mode_value == c.PM_DIG_L:
            return 'LSB'
        elif mode_value == c.PM_CW_U or mode_value == c.PM_CW_L:
            return 'CW'
        elif mode_value == c.PM_AM:
            return 'AM'
        elif mode_value == c.PM_FM:
            return 'FM'
        else:
            return 'USB'  # Default
    
    def _string_to_omnirig_mode(self, mode: str) -> Optional[int]:
        """Convert mode string to OmniRig mode constant."""
        c = self.constants
        mode_upper = mode.upper()
        
        if mode_upper == 'USB':
            return c.PM_SSB_U
        elif mode_upper == 'LSB':
            return c.PM_SSB_L
        elif mode_upper == 'CW':
            return c.PM_CW_U
        elif mode_upper == 'AM':
            return c.PM_AM
        elif mode_upper == 'FM':
            return c.PM_FM
        else:
            return None


def run_omnirig_process(command_queue, event_queue):
    """Entry point for OmniRig process.
    
    Args:
        command_queue: Queue for receiving commands
        event_queue: Queue for sending events
    """
    process = OmniRigProcess(command_queue, event_queue)
    process.run()


if __name__ == '__main__':
    # Required for multiprocessing in frozen executables
    multiprocessing.freeze_support()
    
    # This module is designed to be imported and used via multiprocessing.Process
    # If run directly, just exit cleanly
    pass