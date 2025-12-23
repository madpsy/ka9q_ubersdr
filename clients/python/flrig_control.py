#!/usr/bin/env python3
"""
flrig XML-RPC Client for Radio Control

A Python client for controlling radios via flrig's XML-RPC interface over TCP/IP.
Implements bidirectional frequency and mode synchronization with physical radios.

Usage:
    from flrig_control import FlrigClient
    
    # Connect to flrig
    rig = FlrigClient('localhost', 12345)
    rig.connect()
    
    # Get/Set frequency
    freq = rig.get_frequency()
    rig.set_frequency(14074000)
    
    # Get/Set mode
    mode = rig.get_mode()
    rig.set_mode('USB')
    
    # Disconnect
    rig.disconnect()
"""

import xmlrpc.client
import threading
import queue
import time
from typing import Optional, Callable, Any


class FlrigClient:
    """Simple flrig XML-RPC client for controlling external radios over TCP/IP.
    
    This class implements the flrig XML-RPC protocol for radio control.
    
    Protocol details:
    - Uses XML-RPC over HTTP
    - Default port is 12345
    - Communication happens over TCP/IP
    
    Attributes:
        host: Hostname or IP address of flrig server
        port: TCP port number (default: 12345)
        connected: Connection status
        vfo: Current VFO ('A' or 'B')
    """
    
    def __init__(self, host: str = '127.0.0.1', port: int = 12345, vfo: str = 'A'):
        """Initialize flrig client.
        
        Args:
            host: Hostname or IP address of flrig server
            port: TCP port number (default: 12345)
            vfo: VFO to use ('A' or 'B')
        """
        self.host = host
        self.port = port
        self.vfo = vfo.upper()
        self.server: Optional[xmlrpc.client.ServerProxy] = None
        self.connected = False
    
    def connect(self) -> bool:
        """Connect to flrig XML-RPC server.
        
        Returns:
            True if connection successful
            
        Raises:
            ConnectionError: If connection fails
        """
        try:
            self.server = xmlrpc.client.ServerProxy(
                f"http://{self.host}:{self.port}",
                allow_none=True
            )
            # Test connection by listing methods
            methods = self.server.system.listMethods()
            self.connected = True
            return True
        except Exception as e:
            self.connected = False
            raise ConnectionError(f"Failed to connect to flrig at {self.host}:{self.port}: {e}")
    
    def disconnect(self):
        """Disconnect from flrig server."""
        self.connected = False
        self.server = None
    
    def get_frequency(self) -> int:
        """Get current frequency in Hz.
        
        Returns:
            Frequency in Hz
            
        Raises:
            ConnectionError: If communication fails
            ValueError: If response cannot be parsed
        """
        if not self.connected or not self.server:
            raise ConnectionError("Not connected to flrig")
        
        try:
            freq_str = self.server.rig.get_vfo()
            return int(float(freq_str))
        except Exception as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")
    
    def set_frequency(self, freq_hz: int):
        """Set frequency in Hz.
        
        Args:
            freq_hz: Frequency in Hz
            
        Raises:
            ConnectionError: If communication fails
        """
        if not self.connected or not self.server:
            raise ConnectionError("Not connected to flrig")
        
        try:
            self.server.rig.set_vfo(float(freq_hz))
        except Exception as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")
    
    def get_mode(self) -> str:
        """Get current mode.
        
        Returns:
            Mode string (e.g., 'USB', 'LSB', 'CW', 'AM', 'FM')
            
        Raises:
            ConnectionError: If communication fails
        """
        if not self.connected or not self.server:
            raise ConnectionError("Not connected to flrig")
        
        try:
            mode = self.server.rig.get_mode()
            return mode if mode else 'Unknown'
        except Exception as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")
    
    def set_mode(self, mode: str):
        """Set mode (USB, LSB, CW, etc.).
        
        Args:
            mode: Mode string (e.g., 'USB', 'LSB', 'CW', 'AM', 'FM')
            
        Raises:
            ConnectionError: If communication fails
        """
        if not self.connected or not self.server:
            raise ConnectionError("Not connected to flrig")
        
        try:
            self.server.rig.set_mode(mode.upper())
        except Exception as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")
    
    def get_vfo(self) -> str:
        """Get current VFO.
        
        Returns:
            VFO string ('A' or 'B')
        """
        return self.vfo
    
    def set_vfo(self, vfo: str):
        """Set VFO and switch to it in flrig.
        
        Args:
            vfo: VFO string ('A' or 'B')
            
        Raises:
            ConnectionError: If communication fails
        """
        if not self.connected or not self.server:
            raise ConnectionError("Not connected to flrig")
        
        vfo = vfo.upper()
        try:
            # Use rig.set_AB to switch VFO in flrig
            # 'A' = VFO A, 'B' = VFO B
            self.server.rig.set_AB(vfo)
            self.vfo = vfo
        except Exception as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")
    
    def get_ptt(self) -> bool:
        """Get PTT (Push-To-Talk) status.
        
        Returns:
            True if PTT is active (transmitting), False otherwise
            
        Raises:
            ConnectionError: If communication fails
        """
        if not self.connected or not self.server:
            raise ConnectionError("Not connected to flrig")
        
        try:
            ptt = self.server.rig.get_ptt()
            return bool(ptt)
        except Exception as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")
    
    def set_ptt(self, state: bool):
        """Set PTT (Push-To-Talk) state.
        
        Args:
            state: True to transmit, False to receive
            
        Raises:
            ConnectionError: If communication fails
        """
        if not self.connected or not self.server:
            raise ConnectionError("Not connected to flrig")
        
        try:
            self.server.rig.set_ptt(1 if state else 0)
        except Exception as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")
    
    def get_xcvr(self) -> str:
        """Get transceiver name.
        
        Returns:
            Transceiver name string
            
        Raises:
            ConnectionError: If communication fails
        """
        if not self.connected or not self.server:
            raise ConnectionError("Not connected to flrig")
        
        try:
            return self.server.rig.get_xcvr()
        except Exception as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")
    
    def get_modes(self) -> list:
        """Get available modes.
        
        Returns:
            List of available mode strings
            
        Raises:
            ConnectionError: If communication fails
        """
        if not self.connected or not self.server:
            raise ConnectionError("Not connected to flrig")
        
        try:
            return self.server.rig.get_modes()
        except Exception as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")
    
    def get_bw(self) -> tuple:
        """Get current bandwidth.
        
        Returns:
            Tuple of (bw1, bw2) bandwidth strings
            
        Raises:
            ConnectionError: If communication fails
        """
        if not self.connected or not self.server:
            raise ConnectionError("Not connected to flrig")
        
        try:
            result = self.server.rig.get_bw()
            if isinstance(result, list) and len(result) >= 2:
                return (result[1], result[0])  # (bw1, bw2)
            return ('', '')
        except Exception as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")
    
    def set_bw(self, bw2: int, bw1: int = -1):
        """Set bandwidth.
        
        Args:
            bw2: Bandwidth index for BW2
            bw1: Bandwidth index for BW1 (optional)
            
        Raises:
            ConnectionError: If communication fails
        """
        if not self.connected or not self.server:
            raise ConnectionError("Not connected to flrig")
        
        try:
            ival = bw2
            if bw1 > -1:
                ival = 256 * (bw1 + 128) + bw2
            self.server.rig.set_bw(ival)
        except Exception as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")


class ThreadedFlrigClient:
    """Thread-safe flrig client that runs operations in a background thread.
    
    This class wraps FlrigClient and moves all XML-RPC I/O to a background thread,
    preventing GUI blocking. Commands are queued and executed asynchronously, with
    callbacks for results.
    
    Attributes:
        host: Hostname or IP address of flrig server
        port: TCP port number (default: 12345)
        vfo: Current VFO ('A' or 'B')
        connected: Connection status
        running: Thread running status
    """
    
    def __init__(self, host: str = '127.0.0.1', port: int = 12345, vfo: str = 'A'):
        """Initialize threaded flrig client.
        
        Args:
            host: Hostname or IP address of flrig server
            port: TCP port number (default: 12345)
            vfo: VFO to use ('A' or 'B')
        """
        self.host = host
        self.port = port
        self.vfo = vfo.upper()
        self.rig = FlrigClient(host, port, vfo)
        self.connected = False
        self.running = False
        
        # Command queue for thread-safe operations
        self.command_queue: queue.Queue = queue.Queue()
        
        # Result callbacks
        self.frequency_callback: Optional[Callable[[int], None]] = None
        self.mode_callback: Optional[Callable[[str], None]] = None
        self.ptt_callback: Optional[Callable[[bool], None]] = None
        self.error_callback: Optional[Callable[[str], None]] = None
        
        # Worker thread
        self.worker_thread: Optional[threading.Thread] = None
        
        # Cached values for quick access (updated by polling)
        self._cached_frequency: Optional[int] = None
        self._cached_mode: Optional[str] = None
        self._cached_ptt: bool = False
        self._cache_lock = threading.Lock()
    
    def connect(self) -> bool:
        """Connect to flrig server and start worker thread.
        
        Returns:
            True if connection successful
            
        Raises:
            ConnectionError: If connection fails
        """
        # Connect the underlying client
        self.rig.connect()
        self.connected = True
        
        # Start worker thread
        self.running = True
        self.worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
        self.worker_thread.start()
        
        return True
    
    def disconnect(self):
        """Disconnect from flrig server and stop worker thread."""
        self.running = False
        
        # Wait for worker thread to finish
        if self.worker_thread and self.worker_thread.is_alive():
            self.worker_thread.join(timeout=1.0)
        
        # Disconnect underlying client
        if self.connected:
            self.rig.disconnect()
            self.connected = False
    
    def _worker_loop(self):
        """Worker thread loop that processes commands from queue."""
        while self.running:
            try:
                # Get command from queue with timeout
                try:
                    cmd_type, args = self.command_queue.get(timeout=0.02)  # 20ms timeout
                except queue.Empty:
                    continue
                
                # Execute command
                try:
                    if cmd_type == 'get_frequency':
                        freq = self.rig.get_frequency()
                        with self._cache_lock:
                            self._cached_frequency = freq
                        if self.frequency_callback:
                            self.frequency_callback(freq)
                    
                    elif cmd_type == 'set_frequency':
                        freq_hz = args[0]
                        self.rig.set_frequency(freq_hz)
                        with self._cache_lock:
                            self._cached_frequency = freq_hz
                    
                    elif cmd_type == 'get_mode':
                        mode = self.rig.get_mode()
                        with self._cache_lock:
                            self._cached_mode = mode
                        if self.mode_callback:
                            self.mode_callback(mode)
                    
                    elif cmd_type == 'set_mode':
                        mode = args[0]
                        self.rig.set_mode(mode)
                        with self._cache_lock:
                            self._cached_mode = mode
                    
                    elif cmd_type == 'get_ptt':
                        ptt = self.rig.get_ptt()
                        with self._cache_lock:
                            self._cached_ptt = ptt
                        if self.ptt_callback:
                            self.ptt_callback(ptt)
                    
                    elif cmd_type == 'set_ptt':
                        state = args[0]
                        self.rig.set_ptt(state)
                        with self._cache_lock:
                            self._cached_ptt = state
                    
                    elif cmd_type == 'set_vfo':
                        vfo = args[0]
                        self.rig.set_vfo(vfo)
                        self.vfo = vfo
                    
                    elif cmd_type == 'poll':
                        # Poll all values
                        freq = self.rig.get_frequency()
                        mode = self.rig.get_mode()
                        ptt = self.rig.get_ptt()
                        
                        with self._cache_lock:
                            self._cached_frequency = freq
                            self._cached_mode = mode
                            self._cached_ptt = ptt
                        
                        # Trigger callbacks
                        if self.frequency_callback:
                            self.frequency_callback(freq)
                        if self.mode_callback:
                            self.mode_callback(mode)
                        if self.ptt_callback:
                            self.ptt_callback(ptt)
                
                except Exception as e:
                    if self.error_callback:
                        self.error_callback(str(e))
                
                finally:
                    self.command_queue.task_done()
            
            except Exception:
                # Catch any unexpected errors to keep thread alive
                pass
    
    def get_frequency(self) -> Optional[int]:
        """Get cached frequency (non-blocking).
        
        Returns:
            Cached frequency in Hz, or None if not yet polled
        """
        with self._cache_lock:
            return self._cached_frequency
    
    def set_frequency(self, freq_hz: int):
        """Queue frequency change command (non-blocking).
        
        Args:
            freq_hz: Frequency in Hz
        """
        self.command_queue.put(('set_frequency', (freq_hz,)))
    
    def get_mode(self) -> Optional[str]:
        """Get cached mode (non-blocking).
        
        Returns:
            Cached mode string, or None if not yet polled
        """
        with self._cache_lock:
            return self._cached_mode
    
    def set_mode(self, mode: str):
        """Queue mode change command (non-blocking).
        
        Args:
            mode: Mode string (e.g., 'USB', 'LSB', 'CW', 'AM', 'FM')
        """
        self.command_queue.put(('set_mode', (mode,)))
    
    def get_vfo(self) -> str:
        """Get current VFO (non-blocking).
        
        Returns:
            Current VFO ('A' or 'B')
        """
        return self.vfo
    
    def set_vfo(self, vfo: str):
        """Queue VFO change command (non-blocking).
        
        Args:
            vfo: VFO string ('A' or 'B')
        """
        self.command_queue.put(('set_vfo', (vfo,)))
    
    def get_ptt(self) -> bool:
        """Get cached PTT status (non-blocking).
        
        Returns:
            Cached PTT state
        """
        with self._cache_lock:
            return self._cached_ptt
    
    def set_ptt(self, state: bool):
        """Queue PTT change command (non-blocking).
        
        Args:
            state: True to transmit, False to receive
        """
        self.command_queue.put(('set_ptt', (state,)))
    
    def poll(self):
        """Queue a poll command to update all cached values (non-blocking)."""
        self.command_queue.put(('poll', ()))
    
    def set_callbacks(self, 
                     frequency_callback: Optional[Callable[[int], None]] = None,
                     mode_callback: Optional[Callable[[str], None]] = None,
                     ptt_callback: Optional[Callable[[bool], None]] = None,
                     error_callback: Optional[Callable[[str], None]] = None):
        """Set callbacks for value changes.
        
        Args:
            frequency_callback: Called when frequency is polled
            mode_callback: Called when mode is polled
            ptt_callback: Called when PTT status is polled
            error_callback: Called when an error occurs
        """
        self.frequency_callback = frequency_callback
        self.mode_callback = mode_callback
        self.ptt_callback = ptt_callback
        self.error_callback = error_callback


def main():
    """Example usage of FlrigClient."""
    import sys
    
    # Parse command line arguments
    host = sys.argv[1] if len(sys.argv) > 1 else '127.0.0.1'
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 12345
    
    try:
        # Connect to flrig
        print(f"Connecting to flrig at {host}:{port}...")
        rig = FlrigClient(host, port)
        rig.connect()
        print("✓ Connected")
        
        # Get transceiver name
        try:
            xcvr = rig.get_xcvr()
            print(f"Transceiver: {xcvr}")
        except:
            print("Could not get transceiver name")
        
        # Get current frequency
        freq = rig.get_frequency()
        print(f"Current frequency: {freq/1e6:.6f} MHz")
        
        # Get current mode
        mode = rig.get_mode()
        print(f"Current mode: {mode}")
        
        # Example: Set frequency to 14.074 MHz
        print("\nSetting frequency to 14.074 MHz...")
        rig.set_frequency(14074000)
        
        # Verify
        time.sleep(0.5)
        freq = rig.get_frequency()
        print(f"New frequency: {freq/1e6:.6f} MHz")
        
        # Example: Set mode to USB
        print("\nSetting mode to USB...")
        rig.set_mode('USB')
        
        # Verify
        time.sleep(0.5)
        mode = rig.get_mode()
        print(f"New mode: {mode}")
        
        # Disconnect
        rig.disconnect()
        print("\n✓ Disconnected")
        
    except ConnectionError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        if rig.connected:
            rig.disconnect()
        sys.exit(0)


if __name__ == '__main__':
    main()