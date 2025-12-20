#!/usr/bin/env python3
"""
Rigctl Client for Hamlib rigctld Network Protocol

A simple Python client for controlling radios via Hamlib's rigctld daemon
over TCP/IP. Implements the basic rigctl network protocol for frequency
and mode control.

Usage:
    from rigctl import RigctlClient
    
    # Connect to rigctld
    rig = RigctlClient('localhost', 4532)
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

import socket
import threading
import queue
from typing import Optional, Callable, Any


class RigctlClient:
    """Simple rigctl client for controlling external radios over TCP/IP.
    
    This class implements the Hamlib rigctld network protocol, which is a
    simple text-based command/response protocol over TCP/IP.
    
    Protocol details:
    - Commands are sent as text strings terminated with newline
    - Responses are received as text strings
    - Communication happens over TCP/IP (default port 4532)
    
    Attributes:
        host: Hostname or IP address of rigctld server
        port: TCP port number (default: 4532)
        connected: Connection status
    """
    
    def __init__(self, host: str = 'localhost', port: int = 4532):
        """Initialize rigctl client.
        
        Args:
            host: Hostname or IP address of rigctld server
            port: TCP port number (default: 4532)
        """
        self.host = host
        self.port = port
        self.sock: Optional[socket.socket] = None
        self.connected = False
    
    def connect(self) -> bool:
        """Connect to rigctld server.
        
        Returns:
            True if connection successful
            
        Raises:
            ConnectionError: If connection fails
        """
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.settimeout(5.0)
            self.sock.connect((self.host, self.port))
            self.connected = True
            return True
        except (socket.error, socket.timeout) as e:
            self.connected = False
            raise ConnectionError(f"Failed to connect to rigctld at {self.host}:{self.port}: {e}")
    
    def disconnect(self):
        """Disconnect from rigctld server."""
        if self.sock:
            try:
                self.sock.close()
            except:
                pass
            self.sock = None
        self.connected = False
    
    def send_command(self, command: str) -> str:
        """Send command to rigctld and return response.
        
        Args:
            command: Command string (without newline)
            
        Returns:
            Response string from rigctld
            
        Raises:
            ConnectionError: If not connected or communication fails
        """
        if not self.connected or not self.sock:
            raise ConnectionError("Not connected to rigctld")
        
        try:
            self.sock.sendall((command + '\n').encode('utf-8'))
            response = self.sock.recv(1024).decode('utf-8').strip()
            return response
        except socket.error as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")
    
    def get_frequency(self) -> int:
        """Get current frequency in Hz.
        
        Returns:
            Frequency in Hz
            
        Raises:
            ConnectionError: If communication fails
            ValueError: If response cannot be parsed
        """
        response = self.send_command('f')
        return int(response)
    
    def set_frequency(self, freq_hz: int):
        """Set frequency in Hz.
        
        Args:
            freq_hz: Frequency in Hz
            
        Raises:
            ConnectionError: If communication fails
        """
        self.send_command(f'F {freq_hz}')
    
    def get_mode(self) -> str:
        """Get current mode.
        
        Returns:
            Mode string (e.g., 'USB', 'LSB', 'CW', 'AM', 'FM')
            
        Raises:
            ConnectionError: If communication fails
        """
        response = self.send_command('m')
        # Response format: "MODE\nBW\n" - we only want the mode
        mode = response.split('\n')[0] if response else 'Unknown'
        return mode
    
    def set_mode(self, mode: str):
        """Set mode (USB, LSB, CW, etc.).
        
        Args:
            mode: Mode string (e.g., 'USB', 'LSB', 'CW', 'AM', 'FM')
            
        Raises:
            ConnectionError: If communication fails
        """
        self.send_command(f'M {mode.upper()} 0')
    
    def get_vfo(self) -> str:
        """Get current VFO.
        
        Returns:
            VFO string (e.g., 'VFOA', 'VFOB')
            
        Raises:
            ConnectionError: If communication fails
        """
        response = self.send_command('v')
        return response
    
    def set_vfo(self, vfo: str):
        """Set VFO.
        
        Args:
            vfo: VFO string (e.g., 'VFOA', 'VFOB')
            
        Raises:
            ConnectionError: If communication fails
        """
        self.send_command(f'V {vfo.upper()}')
    
    def get_ptt(self) -> bool:
        """Get PTT (Push-To-Talk) status.
        
        Returns:
            True if PTT is active (transmitting), False otherwise
            
        Raises:
            ConnectionError: If communication fails
        """
        response = self.send_command('t')
        return response == '1'
    
    def set_ptt(self, state: bool):
        """Set PTT (Push-To-Talk) state.
        
        Args:
            state: True to transmit, False to receive
            
        Raises:
            ConnectionError: If communication fails
        """
        self.send_command(f'T {1 if state else 0}')


class ThreadedRigctlClient:
    """Thread-safe rigctl client that runs operations in a background thread.
    
    This class wraps RigctlClient and moves all socket I/O to a background thread,
    preventing GUI blocking. Commands are queued and executed asynchronously, with
    callbacks for results.
    
    Attributes:
        host: Hostname or IP address of rigctld server
        port: TCP port number (default: 4532)
        connected: Connection status
        running: Thread running status
    """
    
    def __init__(self, host: str = 'localhost', port: int = 4532):
        """Initialize threaded rigctl client.
        
        Args:
            host: Hostname or IP address of rigctld server
            port: TCP port number (default: 4532)
        """
        self.host = host
        self.port = port
        self.rig = RigctlClient(host, port)
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
        """Connect to rigctld server and start worker thread.
        
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
        """Disconnect from rigctld server and stop worker thread."""
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
    """Example usage of RigctlClient."""
    import sys
    
    # Parse command line arguments
    host = sys.argv[1] if len(sys.argv) > 1 else 'localhost'
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 4532
    
    try:
        # Connect to rigctld
        print(f"Connecting to rigctld at {host}:{port}...")
        rig = RigctlClient(host, port)
        rig.connect()
        print("✓ Connected")
        
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
        freq = rig.get_frequency()
        print(f"New frequency: {freq/1e6:.6f} MHz")
        
        # Example: Set mode to USB
        print("\nSetting mode to USB...")
        rig.set_mode('USB')
        
        # Verify
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