#!/usr/bin/env python3
"""
Serial CAT Control for Kenwood TS-480 Protocol

Direct serial port communication using Kenwood CAT commands.
Cross-platform support via pyserial.

Usage:
    from serial_cat import SerialCATClient
    
    # Connect to serial port
    cat = SerialCATClient('/dev/ttyUSB0')  # or 'COM3' on Windows
    cat.connect()
    
    # Get/Set frequency
    freq = cat.get_frequency()
    cat.set_frequency(14074000)
    
    # Get/Set mode
    mode = cat.get_mode()
    cat.set_mode('USB')
    
    # Disconnect
    cat.disconnect()
"""

import serial
import serial.tools.list_ports
import threading
import queue
import time
from typing import Optional, Callable, List, Tuple


def list_serial_ports() -> List[Tuple[str, str]]:
    """List available serial ports (cross-platform).
    
    Returns:
        List of (port_name, description) tuples
    """
    ports = []
    for port in serial.tools.list_ports.comports():
        ports.append((port.device, f"{port.description} ({port.device})"))
    return ports


class SerialCATClient:
    """Simple serial CAT client for controlling radios via Kenwood TS-480 protocol.
    
    This class implements the Kenwood CAT protocol, which is a simple text-based
    command/response protocol over RS-232 serial.
    
    Protocol details:
    - Commands are ASCII text terminated with semicolon (;)
    - Responses echo the command with data
    - Communication happens over RS-232 serial port
    - Default baud rate: 57600 (TS-480 default)
    
    Attributes:
        port: Serial port device name (e.g., '/dev/ttyUSB0' or 'COM3')
        baudrate: Serial baud rate (default: 57600)
        vfo: Active VFO ('A' or 'B')
        connected: Connection status
    """
    
    def __init__(self, port: str, baudrate: int = 57600, vfo: str = 'A'):
        """Initialize serial CAT client.
        
        Args:
            port: Serial port device name (e.g., '/dev/ttyUSB0' or 'COM3')
            baudrate: Serial baud rate (default: 57600 for TS-480)
            vfo: Active VFO ('A' or 'B')
        """
        self.port = port
        self.baudrate = baudrate
        self.vfo = vfo.upper()
        self.ser: Optional[serial.Serial] = None
        self.connected = False
    
    def connect(self) -> bool:
        """Connect to serial port.
        
        Returns:
            True if connection successful
            
        Raises:
            ConnectionError: If connection fails
        """
        try:
            self.ser = serial.Serial(
                port=self.port,
                baudrate=self.baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=1.0,
                write_timeout=1.0
            )
            # Clear any pending data
            self.ser.reset_input_buffer()
            self.ser.reset_output_buffer()
            self.connected = True
            return True
        except (serial.SerialException, OSError) as e:
            self.connected = False
            raise ConnectionError(f"Failed to connect to serial port {self.port}: {e}")
    
    def disconnect(self):
        """Disconnect from serial port."""
        if self.ser:
            try:
                self.ser.close()
            except:
                pass
            self.ser = None
        self.connected = False
    
    def send_command(self, command: str) -> str:
        """Send command to radio and return response.
        
        Args:
            command: Command string (with or without semicolon)
            
        Returns:
            Response string from radio (without semicolon)
            
        Raises:
            ConnectionError: If not connected or communication fails
        """
        if not self.connected or not self.ser:
            raise ConnectionError("Not connected to serial port")
        
        try:
            # Ensure command ends with semicolon
            if not command.endswith(';'):
                command += ';'
            
            # Send command
            self.ser.write(command.encode('ascii'))
            
            # Read response (terminated by semicolon)
            response = self.ser.read_until(b';').decode('ascii').strip()
            
            # Remove trailing semicolon
            if response.endswith(';'):
                response = response[:-1]
            
            return response
        except (serial.SerialException, OSError) as e:
            self.connected = False
            raise ConnectionError(f"Communication error: {e}")
    
    def set_vfo(self, vfo: str):
        """Set active VFO.
        
        Args:
            vfo: VFO to use ('A' or 'B')
        """
        self.vfo = vfo.upper()
    
    def get_frequency(self) -> int:
        """Get current frequency in Hz.
        
        Returns:
            Frequency in Hz
            
        Raises:
            ConnectionError: If communication fails
            ValueError: If response cannot be parsed
        """
        # Use FA for VFO A, FB for VFO B
        cmd = 'FA' if self.vfo == 'A' else 'FB'
        response = self.send_command(cmd + ';')
        
        # Response format: FA00014074000 or FB00014074000
        if not response.startswith(cmd):
            raise ValueError(f"Invalid response: {response}")
        
        freq_str = response[2:]  # Remove command prefix (FA or FB)
        return int(freq_str)
    
    def set_frequency(self, freq_hz: int):
        """Set frequency in Hz.
        
        Args:
            freq_hz: Frequency in Hz
            
        Raises:
            ConnectionError: If communication fails
        """
        # Use FA for VFO A, FB for VFO B
        cmd = 'FA' if self.vfo == 'A' else 'FB'
        # Format: FA00014074000; (11 digits, padded with zeros)
        command = f'{cmd}{freq_hz:011d};'
        self.send_command(command)
    
    def get_mode(self) -> str:
        """Get current mode.
        
        Returns:
            Mode string (e.g., 'USB', 'LSB', 'CW', 'AM', 'FM')
            
        Raises:
            ConnectionError: If communication fails
        """
        response = self.send_command('MD;')
        
        # Response format: MD2 (where 2 = USB)
        if not response.startswith('MD'):
            raise ValueError(f"Invalid response: {response}")
        
        mode_code = response[2:]
        
        # Kenwood mode codes
        mode_map = {
            '1': 'LSB',
            '2': 'USB',
            '3': 'CW',
            '4': 'FM',
            '5': 'AM',
            '6': 'FSK',
            '7': 'CW-R',
            '8': 'FSK-R',
            '9': 'PSK'
        }
        
        return mode_map.get(mode_code, 'USB')
    
    def set_mode(self, mode: str):
        """Set mode (USB, LSB, CW, etc.).
        
        Args:
            mode: Mode string (e.g., 'USB', 'LSB', 'CW', 'AM', 'FM')
            
        Raises:
            ConnectionError: If communication fails
        """
        # Map mode names to Kenwood codes
        mode_map = {
            'LSB': '1',
            'USB': '2',
            'CW': '3',
            'FM': '4',
            'AM': '5',
            'FSK': '6',
            'CW-R': '7',
            'CWR': '7',
            'FSK-R': '8',
            'PSK': '9'
        }
        
        mode_code = mode_map.get(mode.upper(), '2')  # Default to USB
        self.send_command(f'MD{mode_code};')
    
    def get_ptt(self) -> bool:
        """Get PTT (Push-To-Talk) status.
        
        Returns:
            True if PTT is active (transmitting), False otherwise
            
        Raises:
            ConnectionError: If communication fails
        """
        response = self.send_command('IF;')
        
        # Response format: IF00014074000... (38 characters)
        # Character 28 is TX status: 0=RX, 1=TX
        if len(response) >= 29 and response.startswith('IF'):
            tx_status = response[28]
            return tx_status == '1'
        
        return False
    
    def set_ptt(self, state: bool):
        """Set PTT (Push-To-Talk) state.
        
        Args:
            state: True to transmit, False to receive
            
        Raises:
            ConnectionError: If communication fails
        """
        if state:
            self.send_command('TX;')
        else:
            self.send_command('RX;')


class ThreadedSerialCATClient:
    """Thread-safe serial CAT client that runs operations in a background thread.
    
    This class wraps SerialCATClient and moves all serial I/O to a background thread,
    preventing GUI blocking. Commands are queued and executed asynchronously, with
    callbacks for results.
    
    Attributes:
        port: Serial port device name
        baudrate: Serial baud rate
        vfo: Active VFO ('A' or 'B')
        connected: Connection status
        running: Thread running status
    """
    
    def __init__(self, port: str, vfo: str = 'A', baudrate: int = 57600):
        """Initialize threaded serial CAT client.
        
        Args:
            port: Serial port device name (e.g., '/dev/ttyUSB0' or 'COM3')
            vfo: Active VFO ('A' or 'B')
            baudrate: Serial baud rate (default: 57600)
        """
        self.port = port
        self.baudrate = baudrate
        self.vfo = vfo.upper()
        self.cat = SerialCATClient(port, baudrate, vfo)
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
        """Connect to serial port and start worker thread.
        
        Returns:
            True if connection successful
            
        Raises:
            ConnectionError: If connection fails
        """
        # Connect the underlying client
        self.cat.connect()
        self.connected = True
        
        # Start worker thread
        self.running = True
        self.worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
        self.worker_thread.start()
        
        return True
    
    def disconnect(self):
        """Disconnect from serial port and stop worker thread."""
        self.running = False
        
        # Wait for worker thread to finish
        if self.worker_thread and self.worker_thread.is_alive():
            self.worker_thread.join(timeout=1.0)
        
        # Disconnect underlying client
        if self.connected:
            self.cat.disconnect()
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
                        freq = self.cat.get_frequency()
                        with self._cache_lock:
                            self._cached_frequency = freq
                        if self.frequency_callback:
                            self.frequency_callback(freq)
                    
                    elif cmd_type == 'set_frequency':
                        freq_hz = args[0]
                        self.cat.set_frequency(freq_hz)
                        with self._cache_lock:
                            self._cached_frequency = freq_hz
                    
                    elif cmd_type == 'get_mode':
                        mode = self.cat.get_mode()
                        with self._cache_lock:
                            self._cached_mode = mode
                        if self.mode_callback:
                            self.mode_callback(mode)
                    
                    elif cmd_type == 'set_mode':
                        mode = args[0]
                        self.cat.set_mode(mode)
                        with self._cache_lock:
                            self._cached_mode = mode
                    
                    elif cmd_type == 'get_ptt':
                        ptt = self.cat.get_ptt()
                        with self._cache_lock:
                            self._cached_ptt = ptt
                        if self.ptt_callback:
                            self.ptt_callback(ptt)
                    
                    elif cmd_type == 'set_ptt':
                        state = args[0]
                        self.cat.set_ptt(state)
                        with self._cache_lock:
                            self._cached_ptt = state
                    
                    elif cmd_type == 'set_vfo':
                        vfo = args[0]
                        self.cat.set_vfo(vfo)
                        self.vfo = vfo
                    
                    elif cmd_type == 'poll':
                        # Poll all values
                        freq = self.cat.get_frequency()
                        mode = self.cat.get_mode()
                        ptt = self.cat.get_ptt()
                        
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
    
    def set_vfo(self, vfo: str):
        """Queue VFO change command (non-blocking).
        
        Args:
            vfo: VFO to use ('A' or 'B')
        """
        self.command_queue.put(('set_vfo', (vfo.upper(),)))
    
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
    """Example usage of SerialCATClient."""
    import sys
    
    # List available ports
    print("Available serial ports:")
    ports = list_serial_ports()
    if not ports:
        print("  No serial ports found!")
        sys.exit(1)
    
    for i, (port, desc) in enumerate(ports):
        print(f"  {i+1}. {desc}")
    
    # Parse command line arguments
    if len(sys.argv) > 1:
        port = sys.argv[1]
    else:
        # Use first available port
        port = ports[0][0]
        print(f"\nUsing port: {port}")
    
    try:
        # Connect to serial port
        print(f"\nConnecting to {port}...")
        cat = SerialCATClient(port)
        cat.connect()
        print("✓ Connected")
        
        # Get current frequency
        freq = cat.get_frequency()
        print(f"Current frequency: {freq/1e6:.6f} MHz")
        
        # Get current mode
        mode = cat.get_mode()
        print(f"Current mode: {mode}")
        
        # Example: Set frequency to 14.074 MHz
        print("\nSetting frequency to 14.074 MHz...")
        cat.set_frequency(14074000)
        
        # Verify
        freq = cat.get_frequency()
        print(f"New frequency: {freq/1e6:.6f} MHz")
        
        # Example: Set mode to USB
        print("\nSetting mode to USB...")
        cat.set_mode('USB')
        
        # Verify
        mode = cat.get_mode()
        print(f"New mode: {mode}")
        
        # Disconnect
        cat.disconnect()
        print("\n✓ Disconnected")
        
    except ConnectionError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        if cat.connected:
            cat.disconnect()
        sys.exit(0)


if __name__ == '__main__':
    main()