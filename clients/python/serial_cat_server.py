#!/usr/bin/env python3
"""
Serial CAT Server for Kenwood TS-480 Protocol

Makes UberSDR appear as a Kenwood TS-480 to external software like WSJT-X.
Listens on a serial port and responds to CAT commands.

Usage:
    from serial_cat_server import SerialCATServer
    
    # Create server
    server = SerialCATServer('/dev/ttyUSB0', radio_gui)
    server.start()
    
    # Stop server
    server.stop()
"""

import serial
import serial.tools.list_ports
import threading
import time
from typing import Optional, Callable, List


def list_serial_ports() -> List[str]:
    """List available serial ports.
    
    Returns:
        List of serial port device names
    """
    ports = serial.tools.list_ports.comports()
    return [port.device for port in ports]


class SerialCATServer:
    """Serial CAT server that emulates a Kenwood TS-480.
    
    Responds to CAT commands from external software (like WSJT-X) and
    bridges them to/from UberSDR through the radio GUI.
    
    Attributes:
        port: Serial port device name
        baudrate: Serial baud rate (default: 57600 for TS-480)
        radio_gui: Reference to RadioGUI instance for getting/setting frequency/mode
        running: Server running status
    """
    
    def __init__(self, port: str, radio_gui, baudrate: int = 57600):
        """Initialize serial CAT server.
        
        Args:
            port: Serial port device name (e.g., '/dev/ttyUSB0' or 'COM3')
            radio_gui: RadioGUI instance to control
            baudrate: Serial baud rate (default: 57600 for TS-480)
        """
        self.port = port
        self.baudrate = baudrate
        self.radio_gui = radio_gui
        self.ser: Optional[serial.Serial] = None
        self.running = False
        self.thread: Optional[threading.Thread] = None
        
        # VFO state (A or B)
        self.vfo = 'A'
        
        # Cached frequency for each VFO (in Hz)
        self.vfo_a_freq = 14074000
        self.vfo_b_freq = 14074000
    
    def start(self) -> bool:
        """Start the CAT server.
        
        Returns:
            True if server started successfully
            
        Raises:
            ConnectionError: If serial port cannot be opened
        """
        try:
            self.ser = serial.Serial(
                port=self.port,
                baudrate=self.baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=0.1,  # Short timeout for responsive reads
                write_timeout=1.0
            )
            
            # Clear any pending data
            self.ser.reset_input_buffer()
            self.ser.reset_output_buffer()
            
            # Start server thread
            self.running = True
            self.thread = threading.Thread(target=self._server_loop, daemon=True)
            self.thread.start()
            
            return True
        except (serial.SerialException, OSError) as e:
            self.running = False
            raise ConnectionError(f"Failed to open serial port {self.port}: {e}")
    
    def stop(self):
        """Stop the CAT server."""
        self.running = False
        
        # Wait for thread to finish
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1.0)
        
        # Close serial port
        if self.ser:
            try:
                self.ser.close()
            except:
                pass
            self.ser = None
    
    def _server_loop(self):
        """Main server loop that processes incoming commands."""
        buffer = ""
        
        while self.running:
            try:
                # Read available data
                if self.ser and self.ser.in_waiting > 0:
                    data = self.ser.read(self.ser.in_waiting).decode('ascii', errors='ignore')
                    buffer += data
                    
                    # Process complete commands (terminated by semicolon)
                    while ';' in buffer:
                        cmd, buffer = buffer.split(';', 1)
                        cmd = cmd.strip()
                        if cmd:
                            response = self._process_command(cmd)
                            if response:
                                self._send_response(response)
                
                # Small delay to prevent CPU spinning
                time.sleep(0.01)
                
            except Exception as e:
                print(f"CAT server error: {e}")
                time.sleep(0.1)
    
    def _process_command(self, cmd: str) -> Optional[str]:
        """Process a CAT command and return response.
        
        Args:
            cmd: Command string (without semicolon)
            
        Returns:
            Response string (with semicolon) or None
        """
        cmd = cmd.upper().strip()
        
        # ID - Request rig ID
        if cmd == 'ID':
            return 'ID019;'  # TS-480 ID
        
        # AI - Auto Information (disable)
        elif cmd == 'AI':
            return 'AI0;'
        elif cmd.startswith('AI'):
            return 'AI0;'  # Acknowledge but keep disabled
        
        # FA - VFO A frequency
        elif cmd == 'FA':
            freq = self._get_current_frequency()
            return f'FA{freq:011d};'
        elif cmd.startswith('FA'):
            # Set VFO A frequency
            try:
                freq_str = cmd[2:]
                freq = int(freq_str)
                self.vfo_a_freq = freq
                self._set_frequency(freq)
                return f'FA{freq:011d};'
            except ValueError:
                return None
        
        # FB - VFO B frequency
        elif cmd == 'FB':
            return f'FB{self.vfo_b_freq:011d};'
        elif cmd.startswith('FB'):
            # Set VFO B frequency
            try:
                freq_str = cmd[2:]
                freq = int(freq_str)
                self.vfo_b_freq = freq
                # Don't change radio frequency for VFO B
                return f'FB{freq:011d};'
            except ValueError:
                return None
        
        # MD - Mode
        elif cmd == 'MD':
            mode_code = self._get_current_mode_code()
            return f'MD{mode_code};'
        elif cmd.startswith('MD'):
            # Set mode
            try:
                mode_code = cmd[2]
                self._set_mode(mode_code)
                return f'MD{mode_code};'
            except (IndexError, ValueError):
                return None
        
        # IF - Information (frequency, mode, etc.)
        elif cmd == 'IF':
            freq = self._get_current_frequency()
            mode_code = self._get_current_mode_code()
            # IF format: IF00014074000     +000000000200000000;
            # Hamlib expects exactly 37 data characters (not counting semicolon)
            # IF(2) + freq(11) + spaces(5) + RIT(9) + mode(1) + remaining(9) = 37
            return f'IF{freq:011d}     +000000000{mode_code}00000000;'
        
        # TX - Transmit
        elif cmd == 'TX' or cmd == 'TX0' or cmd == 'TX1':
            return 'TX0;'  # Acknowledge but don't actually transmit
        
        # RX - Receive
        elif cmd == 'RX':
            return 'RX;'
        
        # FT - VFO select (0=A, 1=B)
        elif cmd == 'FT':
            return f'FT{0 if self.vfo == "A" else 1};'
        elif cmd.startswith('FT'):
            try:
                vfo_num = int(cmd[2])
                self.vfo = 'A' if vfo_num == 0 else 'B'
                return f'FT{vfo_num};'
            except (IndexError, ValueError):
                return None
        
        # FR - VFO receive (0=A, 1=B)
        elif cmd == 'FR':
            return f'FR{0 if self.vfo == "A" else 1};'
        elif cmd.startswith('FR'):
            try:
                vfo_num = int(cmd[2])
                self.vfo = 'A' if vfo_num == 0 else 'B'
                return f'FR{vfo_num};'
            except (IndexError, ValueError):
                return None
        
        # PS - Power status (always on)
        elif cmd == 'PS':
            return 'PS1;'
        elif cmd.startswith('PS'):
            return 'PS1;'  # Acknowledge
        
        # FW - Firmware version (query only, no set)
        elif cmd == 'FW':
            # Hamlib expects format: FWxxxx; where xxxx is 4-digit firmware version
            # TS-480 format: FW1100 = firmware 1.10
            return 'FW1100;'
        
        # KS - Keyer speed (CW)
        elif cmd == 'KS':
            # Return default keyer speed (20 WPM = 020)
            return 'KS020;'
        elif cmd.startswith('KS'):
            # Set keyer speed - acknowledge but don't actually change anything
            try:
                speed = cmd[2:5]  # 3-digit speed
                return f'KS{speed};'
            except (IndexError, ValueError):
                return None
        
        # Unknown command - no response but log for debugging
        else:
            print(f"Unknown CAT command: {cmd}")
            return None
    
    def _send_response(self, response: str):
        """Send response to serial port.
        
        Args:
            response: Response string (should include semicolon)
        """
        if self.ser:
            try:
                self.ser.write(response.encode('ascii'))
            except Exception as e:
                print(f"Failed to send CAT response: {e}")
    
    def _get_current_frequency(self) -> int:
        """Get current frequency from radio GUI.
        
        Returns:
            Frequency in Hz
        """
        try:
            if self.vfo == 'A':
                # Get frequency from radio GUI
                freq = self.radio_gui.get_frequency_hz()
                self.vfo_a_freq = freq
                return freq
            else:
                return self.vfo_b_freq
        except Exception:
            return self.vfo_a_freq
    
    def _set_frequency(self, freq_hz: int):
        """Set frequency in radio GUI.
        
        Args:
            freq_hz: Frequency in Hz
        """
        try:
            # Update GUI frequency display
            self.radio_gui.set_frequency_hz(freq_hz)
            
            # Apply to radio if connected
            if self.radio_gui.connected:
                self.radio_gui.apply_frequency()
        except Exception as e:
            print(f"Failed to set frequency: {e}")
    
    def _get_current_mode_code(self) -> str:
        """Get current mode code from radio GUI.
        
        Returns:
            Kenwood mode code (1=LSB, 2=USB, etc.)
        """
        try:
            mode = self.radio_gui.mode_var.get().upper()
            
            # Map GUI modes to Kenwood codes
            mode_map = {
                'LSB': '1',
                'USB': '2',
                'CW': '3',
                'CWU': '3',
                'CWL': '7',
                'FM': '4',
                'NFM': '4',
                'AM': '5',
                'SAM': '5',
                'FSK': '6',
                'PSK': '9'
            }
            
            return mode_map.get(mode, '2')  # Default to USB
        except Exception:
            return '2'  # Default to USB
    
    def _set_mode(self, mode_code: str):
        """Set mode in radio GUI.
        
        Args:
            mode_code: Kenwood mode code (1=LSB, 2=USB, etc.)
        """
        try:
            # Map Kenwood codes to GUI modes
            mode_map = {
                '1': 'LSB',
                '2': 'USB',
                '3': 'CWU',
                '4': 'FM',
                '5': 'AM',
                '6': 'USB',  # FSK -> USB
                '7': 'CWL',
                '8': 'USB',  # FSK-R -> USB
                '9': 'USB'   # PSK -> USB
            }
            
            gui_mode = mode_map.get(mode_code, 'USB')
            
            # Update GUI mode
            self.radio_gui.mode_var.set(gui_mode)
            self.radio_gui.on_mode_changed()
            
            # Apply to radio if connected
            if self.radio_gui.connected:
                self.radio_gui.apply_mode()
        except Exception as e:
            print(f"Failed to set mode: {e}")


def main():
    """Example usage of SerialCATServer."""
    import sys
    
    print("Serial CAT Server for UberSDR")
    print("Emulates Kenwood TS-480 protocol")
    print()
    
    if len(sys.argv) < 2:
        print("Usage: python serial_cat_server.py <serial_port>")
        print("Example: python serial_cat_server.py /dev/ttyUSB0")
        print("Example: python serial_cat_server.py COM3")
        sys.exit(1)
    
    port = sys.argv[1]
    
    print(f"Starting CAT server on {port}...")
    print("Press Ctrl+C to stop")
    print()
    
    # Note: This example requires a RadioGUI instance
    # In practice, this would be integrated into radio_gui.py
    print("ERROR: This module requires integration with radio_gui.py")
    print("Use the 'CAT Server' option in the GUI instead.")
    sys.exit(1)


if __name__ == '__main__':
    main()