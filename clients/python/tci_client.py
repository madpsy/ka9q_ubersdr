#!/usr/bin/env python3
"""
TCI Client for Expert Electronics TCI Protocol

A Python client for controlling TCI-compatible radios (Expert Electronics SDRs)
over WebSocket. Implements the TCI protocol for frequency/mode control and
audio/IQ data reception.

Usage:
    from tci_client import TCIClient
    
    # Connect to TCI server
    tci = TCIClient('192.168.1.100', 40001)
    tci.connect()
    
    # Get/Set frequency
    freq = tci.get_frequency()
    tci.set_frequency(14074000)
    
    # Get/Set mode
    mode = tci.get_mode()
    tci.set_mode('usb')
    
    # Start audio streaming
    tci.start_audio_streaming()
    
    # Disconnect
    tci.disconnect()
"""

import asyncio
import websockets
import threading
import struct
import queue
from typing import Optional, Callable, Dict
from collections import defaultdict


class TCIClient:
    """TCI client for controlling Expert Electronics TCI-compatible radios.
    
    This class implements the TCI protocol over WebSocket for radio control
    and audio/IQ data reception.
    
    Protocol details:
    - Commands are text strings terminated with semicolon
    - Responses are text strings
    - Audio/IQ data sent as binary frames with 64-byte headers
    - Communication over WebSocket (default port 40001)
    
    Attributes:
        host: Hostname or IP address of TCI server
        port: WebSocket port number (default: 40001)
        connected: Connection status
    """
    
    def __init__(self, host: str = '127.0.0.1', port: int = 40001):
        """Initialize TCI client.
        
        Args:
            host: Hostname or IP address of TCI server
            port: WebSocket port number (default: 40001)
        """
        self.host = host
        self.port = port
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.connected = False
        self.running = False
        
        # Event loop for async operations
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.thread: Optional[threading.Thread] = None
        
        # Radio state (cached from server responses)
        self.device_name = "Unknown"
        self.protocol_version = "unknown"
        self.receiver_count = 1
        self.vfo_frequencies: Dict[int, Dict[int, int]] = defaultdict(lambda: defaultdict(int))
        self.modulations: Dict[int, str] = {}
        self.iq_sample_rate = 48000
        self.audio_sample_rate = 48000
        self.rx_enabled: Dict[int, bool] = {}
        self.ptt_state: Dict[int, bool] = {}  # receiver -> PTT state
        self.ready = False
        
        # Callbacks
        self.frequency_callback: Optional[Callable[[int], None]] = None
        self.mode_callback: Optional[Callable[[str], None]] = None
        self.ptt_callback: Optional[Callable[[bool], None]] = None
        self.audio_callback: Optional[Callable[[int, bytes, int], None]] = None
        self.iq_callback: Optional[Callable[[int, bytes, int], None]] = None
        self.error_callback: Optional[Callable[[str], None]] = None
    
    def connect(self) -> bool:
        """Connect to TCI server.
        
        Returns:
            True if connection successful
            
        Raises:
            ConnectionError: If connection fails
        """
        if self.running:
            return True
        
        # Store connection error if any
        self.connection_error = None
        
        self.running = True
        self.thread = threading.Thread(target=self._run_client, daemon=True)
        self.thread.start()
        
        # Wait for connection (up to 5 seconds)
        import time
        max_wait = 5.0
        wait_interval = 0.1
        elapsed = 0.0
        while elapsed < max_wait:
            # Check if connection error occurred
            if self.connection_error:
                self.running = False
                raise ConnectionError(f"Failed to connect to TCI server at {self.host}:{self.port}: {self.connection_error}")
            
            if self.connected and self.ready:
                return True
            time.sleep(wait_interval)
            elapsed += wait_interval
        
        # Connection timeout
        self.running = False
        raise ConnectionError(f"Connection timeout: TCI server at {self.host}:{self.port} did not respond")
    
    def disconnect(self):
        """Disconnect from TCI server."""
        self.running = False
        
        # Stop the event loop
        if self.loop and self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)
        
        # Wait for thread to finish
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2.0)
        
        self.connected = False
        self.ready = False
    
    def _run_client(self):
        """Run the WebSocket client in a separate thread."""
        try:
            self.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.loop)
            
            # Run the async client
            self.loop.run_until_complete(self._async_client())
        except Exception as e:
            # Store connection error for main thread
            self.connection_error = str(e)
            if self.error_callback:
                self.error_callback(f"TCI client error: {e}")
        finally:
            if self.loop:
                try:
                    self.loop.close()
                except:
                    pass
    
    async def _async_client(self):
        """Async WebSocket client loop."""
        uri = f"ws://{self.host}:{self.port}"
        
        try:
            async with websockets.connect(uri, ping_interval=None, open_timeout=5.0) as websocket:
                self.ws = websocket
                self.connected = True
                
                # Process messages
                async for message in websocket:
                    if isinstance(message, str):
                        await self._process_text_message(message)
                    elif isinstance(message, bytes):
                        await self._process_binary_message(message)
        except websockets.exceptions.ConnectionClosed:
            self.connected = False
            self.ready = False
        except (ConnectionRefusedError, OSError) as e:
            # Connection refused or network error
            self.connected = False
            self.ready = False
            self.connection_error = f"Connection refused - no TCI server listening on {self.host}:{self.port}"
            if self.error_callback:
                self.error_callback(self.connection_error)
        except asyncio.TimeoutError:
            # Connection timeout
            self.connected = False
            self.ready = False
            self.connection_error = f"Connection timeout - TCI server at {self.host}:{self.port} did not respond"
            if self.error_callback:
                self.error_callback(self.connection_error)
        except Exception as e:
            self.connected = False
            self.ready = False
            self.connection_error = str(e)
            if self.error_callback:
                self.error_callback(f"TCI connection error: {e}")
    
    async def _process_text_message(self, message: str):
        """Process incoming text message (response/notification).
        
        Args:
            message: Text message from server
        """
        # Split multiple commands
        commands = message.strip().split(';')
        
        for cmd in commands:
            cmd = cmd.strip()
            if not cmd:
                continue
            
            # Parse command and arguments
            if ':' in cmd:
                cmd_name, args_str = cmd.split(':', 1)
                args = args_str.split(',')
            else:
                cmd_name = cmd
                args = []
            
            # Process response
            await self._process_response(cmd_name.lower(), args)
    
    async def _process_response(self, cmd: str, args: list):
        """Process a TCI response/notification.
        
        Args:
            cmd: Command name
            args: Command arguments
        """
        try:
            if cmd == 'device':
                # Device name
                if args:
                    self.device_name = args[0]
            
            elif cmd == 'protocol':
                # Protocol version
                if args:
                    self.protocol_version = args[0]
            
            elif cmd == 'trx_count':
                # Receiver count
                if args:
                    self.receiver_count = int(args[0])
            
            elif cmd == 'vfo':
                # VFO frequency update: vfo:receiver,vfo_num,frequency
                if len(args) >= 3:
                    rx = int(args[0])
                    vfo = int(args[1])
                    freq = int(args[2])
                    self.vfo_frequencies[rx][vfo] = freq
                    
                    # Trigger callback for RX VFO (VFO 0)
                    if rx == 0 and vfo == 0 and self.frequency_callback:
                        self.frequency_callback(freq)
            
            elif cmd == 'dds':
                # DDS (center frequency) update: dds:receiver,frequency
                if len(args) >= 2:
                    rx = int(args[0])
                    freq = int(args[1])
                    self.vfo_frequencies[rx][0] = freq
                    
                    # Trigger callback for main receiver
                    if rx == 0 and self.frequency_callback:
                        self.frequency_callback(freq)
            
            elif cmd == 'modulation':
                # Modulation update: modulation:receiver,mode
                if len(args) >= 2:
                    rx = int(args[0])
                    mode = args[1].lower()
                    self.modulations[rx] = mode
                    
                    # Trigger callback for main receiver
                    if rx == 0 and self.mode_callback:
                        self.mode_callback(mode)
            
            elif cmd == 'iq_samplerate':
                # IQ sample rate: iq_samplerate:rate
                if args:
                    self.iq_sample_rate = int(args[0])
            
            elif cmd == 'audio_samplerate':
                # Audio sample rate: audio_samplerate:rate
                if args:
                    self.audio_sample_rate = int(args[0])
            
            elif cmd == 'rx_enable':
                # RX enable state: rx_enable:receiver,state
                if len(args) >= 2:
                    rx = int(args[0])
                    state = args[1].lower() == 'true'
                    self.rx_enabled[rx] = state
            
            elif cmd == 'trx':
                # PTT state: trx:receiver,state
                if len(args) >= 2:
                    rx = int(args[0])
                    state = args[1].lower() == 'true'
                    self.ptt_state[rx] = state
                    
                    # Trigger callback for main receiver
                    if rx == 0 and self.ptt_callback:
                        self.ptt_callback(state)
            
            elif cmd == 'ready':
                # Server is ready
                self.ready = True
            
            elif cmd == 'start':
                # Radio powered on
                pass
            
            elif cmd == 'stop':
                # Radio powered off
                pass
        
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Error processing TCI response '{cmd}': {e}")
    
    async def _process_binary_message(self, data: bytes):
        """Process incoming binary message (audio/IQ data).
        
        Args:
            data: Binary data frame
        """
        if len(data) < 64:
            return  # Invalid frame
        
        try:
            # Unpack 64-byte header (16 x uint32)
            header = struct.unpack('<IIIIIIIIIIIIIIII', data[:64])
            
            receiver = header[0]
            sample_rate = header[1]
            format_type = header[2]  # 3 = float32
            codec = header[3]
            crc = header[4]
            length = header[5]  # Total number of floats
            stream_type = header[6]  # 0=IQ, 1=Audio
            channels = header[7]
            # header[8:16] are reserved
            
            # Extract data
            frame_data = data[64:]
            
            if stream_type == 0:
                # IQ stream
                if self.iq_callback:
                    self.iq_callback(receiver, frame_data, sample_rate)
            elif stream_type == 1:
                # Audio stream
                if self.audio_callback:
                    self.audio_callback(receiver, frame_data, sample_rate)
        
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Error processing TCI binary frame: {e}")
    
    async def _send_command(self, command: str):
        """Send command to TCI server.
        
        Args:
            command: Command string (with semicolon)
        """
        if not self.ws or not self.connected:
            raise ConnectionError("Not connected to TCI server")
        
        try:
            await self.ws.send(command)
        except Exception as e:
            raise ConnectionError(f"Failed to send TCI command: {e}")
    
    def send_command_sync(self, command: str):
        """Send command synchronously (from main thread).
        
        Args:
            command: Command string (with semicolon)
        """
        if not self.loop or not self.loop.is_running():
            raise ConnectionError("TCI client event loop not running")
        
        future = asyncio.run_coroutine_threadsafe(
            self._send_command(command),
            self.loop
        )
        # Wait for command to be sent (with timeout)
        future.result(timeout=1.0)
    
    def get_frequency(self, rx: int = 0, vfo: int = 0) -> Optional[int]:
        """Get cached frequency for receiver/VFO.
        
        Args:
            rx: Receiver number (default: 0)
            vfo: VFO number (default: 0)
        
        Returns:
            Frequency in Hz, or None if not yet received
        """
        return self.vfo_frequencies.get(rx, {}).get(vfo)
    
    def set_frequency(self, freq_hz: int, rx: int = 0, vfo: int = 0):
        """Set frequency for receiver/VFO.
        
        Args:
            freq_hz: Frequency in Hz
            rx: Receiver number (default: 0)
            vfo: VFO number (default: 0)
        """
        self.send_command_sync(f"vfo:{rx},{vfo},{freq_hz};")
    
    def get_mode(self, rx: int = 0) -> Optional[str]:
        """Get cached mode for receiver.
        
        Args:
            rx: Receiver number (default: 0)
        
        Returns:
            Mode string (e.g., 'usb', 'lsb'), or None if not yet received
        """
        return self.modulations.get(rx)
    
    def set_mode(self, mode: str, rx: int = 0):
        """Set mode for receiver.
        
        Args:
            mode: Mode string (e.g., 'usb', 'lsb', 'cw', 'am', 'fm')
            rx: Receiver number (default: 0)
        """
        self.send_command_sync(f"modulation:{rx},{mode.lower()};")
    
    def get_ptt(self, rx: int = 0) -> bool:
        """Get cached PTT state for receiver.
        
        Args:
            rx: Receiver number (default: 0)
        
        Returns:
            PTT state (True=transmitting, False=receiving)
        """
        return self.ptt_state.get(rx, False)
    
    def set_iq_sample_rate(self, rate: int):
        """Set IQ sample rate.
        
        Args:
            rate: Sample rate in Hz (48000, 96000, 192000, or 384000)
        """
        self.send_command_sync(f"iq_samplerate:{rate};")
    
    def start_iq_streaming(self, rx: int = 0):
        """Start IQ streaming for receiver.
        
        Args:
            rx: Receiver number (default: 0)
        """
        self.send_command_sync(f"iq_start:{rx};")
    
    def stop_iq_streaming(self, rx: int = 0):
        """Stop IQ streaming for receiver.
        
        Args:
            rx: Receiver number (default: 0)
        """
        self.send_command_sync(f"iq_stop:{rx};")
    
    def start_audio_streaming(self, rx: int = 0):
        """Start audio streaming for receiver.
        
        Args:
            rx: Receiver number (default: 0)
        """
        self.send_command_sync(f"audio_start:{rx};")
    
    def stop_audio_streaming(self, rx: int = 0):
        """Stop audio streaming for receiver.
        
        Args:
            rx: Receiver number (default: 0)
        """
        self.send_command_sync(f"audio_stop:{rx};")
    
    def send_spot(self, callsign: str, mode: str, frequency: int, color: str = "", text: str = ""):
        """Send a DX spot to the TCI server.
        
        Args:
            callsign: Station callsign
            mode: Mode string (cw, ssb, ft8, etc.)
            frequency: Frequency in Hz
            color: Color hint (optional)
            text: Comment text (optional)
        """
        self.send_command_sync(f"spot:{callsign},{mode},{frequency},{color},{text};")
    
    def set_callbacks(self,
                     frequency_callback: Optional[Callable[[int], None]] = None,
                     mode_callback: Optional[Callable[[str], None]] = None,
                     ptt_callback: Optional[Callable[[bool], None]] = None,
                     audio_callback: Optional[Callable[[int, bytes, int], None]] = None,
                     iq_callback: Optional[Callable[[int, bytes, int], None]] = None,
                     error_callback: Optional[Callable[[str], None]] = None):
        """Set callbacks for value changes and data reception.
        
        Args:
            frequency_callback: Called when frequency changes (freq_hz)
            mode_callback: Called when mode changes (mode_str)
            ptt_callback: Called when PTT state changes (ptt_state)
            audio_callback: Called when audio data received (rx, data, sample_rate)
            iq_callback: Called when IQ data received (rx, data, sample_rate)
            error_callback: Called when an error occurs (error_msg)
        """
        self.frequency_callback = frequency_callback
        self.mode_callback = mode_callback
        self.ptt_callback = ptt_callback
        self.audio_callback = audio_callback
        self.iq_callback = iq_callback
        self.error_callback = error_callback


class ThreadedTCIClient:
    """Thread-safe TCI client that runs operations in a background thread.
    
    This class wraps TCIClient and provides a non-blocking interface compatible
    with the radio_gui.py radio control system (similar to ThreadedRigctlClient).
    
    Attributes:
        host: Hostname or IP address of TCI server
        port: WebSocket port number (default: 40001)
        connected: Connection status
        running: Thread running status
    """
    
    def __init__(self, host: str = '127.0.0.1', port: int = 40001):
        """Initialize threaded TCI client.
        
        Args:
            host: Hostname or IP address of TCI server
            port: WebSocket port number (default: 40001)
        """
        self.host = host
        self.port = port
        self.tci = TCIClient(host, port)
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
        
        # Cached values for quick access
        self._cached_frequency: Optional[int] = None
        self._cached_mode: Optional[str] = None
        self._cached_ptt: bool = False
        self._cache_lock = threading.Lock()
    
    def connect(self) -> bool:
        """Connect to TCI server and start worker thread.
        
        Returns:
            True if connection successful
            
        Raises:
            ConnectionError: If connection fails
        """
        # Set up TCI callbacks before connecting
        self.tci.set_callbacks(
            frequency_callback=self._on_frequency_changed,
            mode_callback=self._on_mode_changed,
            ptt_callback=self._on_ptt_changed,
            error_callback=self._on_error
        )
        
        # Connect the underlying client
        self.tci.connect()
        self.connected = True
        
        # Start worker thread for command processing
        self.running = True
        self.worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
        self.worker_thread.start()
        
        return True
    
    def disconnect(self):
        """Disconnect from TCI server and stop worker thread."""
        self.running = False
        
        # Wait for worker thread to finish
        if self.worker_thread and self.worker_thread.is_alive():
            self.worker_thread.join(timeout=1.0)
        
        # Disconnect underlying client
        if self.connected:
            self.tci.disconnect()
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
                    if cmd_type == 'set_frequency':
                        freq_hz = args[0]
                        self.tci.set_frequency(freq_hz)
                        with self._cache_lock:
                            self._cached_frequency = freq_hz
                    
                    elif cmd_type == 'set_mode':
                        mode = args[0]
                        # Map UberSDR modes to TCI modes
                        mode_map = {
                            'USB': 'usb', 'LSB': 'lsb',
                            'CW': 'cw', 'CWU': 'cw', 'CWL': 'cw',
                            'AM': 'am', 'SAM': 'sam',
                            'FM': 'nfm', 'NFM': 'nfm', 'WFM': 'wfm'
                        }
                        tci_mode = mode_map.get(mode.upper(), 'usb')
                        self.tci.set_mode(tci_mode)
                        with self._cache_lock:
                            self._cached_mode = mode
                    
                    elif cmd_type == 'poll':
                        # Poll is not needed for TCI - server pushes updates
                        # Just update cache from TCI client state
                        freq = self.tci.get_frequency()
                        mode = self.tci.get_mode()
                        
                        if freq is not None:
                            with self._cache_lock:
                                self._cached_frequency = freq
                        
                        if mode is not None:
                            with self._cache_lock:
                                self._cached_mode = mode
                        
                        # Also check PTT state during poll
                        ptt = self.tci.get_ptt()
                        with self._cache_lock:
                            old_ptt = self._cached_ptt
                            self._cached_ptt = ptt
                        
                        # Trigger PTT callback if state changed
                        if ptt != old_ptt and self.ptt_callback:
                            self.ptt_callback(ptt)
                
                except Exception as e:
                    if self.error_callback:
                        self.error_callback(str(e))
                
                finally:
                    self.command_queue.task_done()
            
            except Exception:
                # Catch any unexpected errors to keep thread alive
                pass
    
    def _on_frequency_changed(self, freq_hz: int):
        """Internal callback when TCI server sends frequency update."""
        with self._cache_lock:
            self._cached_frequency = freq_hz
        
        # Trigger user callback
        if self.frequency_callback:
            self.frequency_callback(freq_hz)
    
    def _on_mode_changed(self, tci_mode: str):
        """Internal callback when TCI server sends mode update."""
        # Map TCI modes to UberSDR modes
        mode_map = {
            'usb': 'USB', 'lsb': 'LSB',
            'cw': 'CW',
            'digu': 'USB', 'digl': 'LSB',
            'am': 'AM', 'sam': 'SAM',
            'nfm': 'FM', 'wfm': 'FM',
            'fm': 'FM'
        }
        ubersdr_mode = mode_map.get(tci_mode.lower(), 'USB')
        
        with self._cache_lock:
            self._cached_mode = ubersdr_mode
        
        # Trigger user callback
        if self.mode_callback:
            self.mode_callback(ubersdr_mode)
    
    def _on_ptt_changed(self, ptt_state: bool):
        """Internal callback when TCI server sends PTT update."""
        with self._cache_lock:
            self._cached_ptt = ptt_state
        
        # Trigger user callback
        if self.ptt_callback:
            self.ptt_callback(ptt_state)
    
    def _on_error(self, error_msg: str):
        """Internal callback when TCI client encounters an error."""
        if self.error_callback:
            self.error_callback(error_msg)
    
    def get_frequency(self) -> Optional[int]:
        """Get cached frequency (non-blocking).
        
        Returns:
            Cached frequency in Hz, or None if not yet received
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
            Cached mode string, or None if not yet received
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
    
    def send_spot(self, callsign: str, mode: str, frequency: int, color: str = "", text: str = ""):
        """Send a DX spot to the TCI server (non-blocking).
        
        Args:
            callsign: Station callsign
            mode: Mode string (cw, ssb, ft8, etc.)
            frequency: Frequency in Hz
            color: Color hint (optional)
            text: Comment text (optional)
        """
        try:
            self.tci.send_spot(callsign, mode, frequency, color, text)
        except Exception as e:
            if self.error_callback:
                self.error_callback(f"Failed to send spot: {e}")
    
    def poll(self):
        """Queue a poll command to update cached values (non-blocking).
        
        Note: TCI servers push updates automatically, so polling is minimal.
        """
        self.command_queue.put(('poll', ()))
    
    def set_callbacks(self,
                     frequency_callback: Optional[Callable[[int], None]] = None,
                     mode_callback: Optional[Callable[[str], None]] = None,
                     ptt_callback: Optional[Callable[[bool], None]] = None,
                     error_callback: Optional[Callable[[str], None]] = None):
        """Set callbacks for value changes.
        
        Args:
            frequency_callback: Called when frequency changes
            mode_callback: Called when mode changes
            ptt_callback: Called when PTT state changes
            error_callback: Called when an error occurs
        """
        self.frequency_callback = frequency_callback
        self.mode_callback = mode_callback
        self.ptt_callback = ptt_callback
        self.error_callback = error_callback


def main():
    """Example usage of TCIClient."""
    import sys
    
    # Parse command line arguments
    host = sys.argv[1] if len(sys.argv) > 1 else '127.0.0.1'
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 40001
    
    try:
        # Connect to TCI server
        print(f"Connecting to TCI server at {host}:{port}...")
        tci = TCIClient(host, port)
        tci.connect()
        print("✓ Connected")
        print(f"Device: {tci.device_name}")
        print(f"Protocol: {tci.protocol_version}")
        
        # Get current frequency
        freq = tci.get_frequency()
        if freq:
            print(f"Current frequency: {freq/1e6:.6f} MHz")
        
        # Get current mode
        mode = tci.get_mode()
        if mode:
            print(f"Current mode: {mode.upper()}")
        
        # Example: Set frequency to 14.074 MHz
        print("\nSetting frequency to 14.074 MHz...")
        tci.set_frequency(14074000)
        
        # Example: Set mode to USB
        print("Setting mode to USB...")
        tci.set_mode('usb')
        
        # Keep running to receive updates
        print("\nListening for updates (Ctrl+C to exit)...")
        import time
        while True:
            time.sleep(1)
        
    except ConnectionError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        if tci.connected:
            tci.disconnect()
        sys.exit(0)


if __name__ == '__main__':
    main()
