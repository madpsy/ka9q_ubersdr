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
from typing import Optional


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