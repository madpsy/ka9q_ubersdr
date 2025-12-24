#!/usr/bin/env python3
"""
TCI Server for UberSDR

Emulates an Expert Electronics TCI-compatible radio server.
Allows JTDX and other TCI clients to connect directly to UberSDR
for both CAT control and IQ / audio streaming.

Usage:
    from tci_server import TCIServer

    # Create server
    server = TCIServer(radio_client, port=40001)
    server.start()

    # Stop server
    server.stop()
"""

import asyncio
import websockets
import threading
import struct
import time
import json
import sys
from typing import Optional, Dict, Set, Callable
from collections import defaultdict
from datetime import datetime


class TCIServer:
    """TCI server that emulates an Expert Electronics SDR.

    Provides WebSocket-based TCI protocol for CAT control and audio streaming.
    Bridges between TCI clients (like JTDX) and UberSDR's native WebSocket API.

    Attributes:
        radio_client: Reference to radio client for getting/setting frequency/mode
        port: WebSocket server port (default: 40001)
        host: WebSocket server host (default: 0.0.0.0 for all interfaces)
        running: Server running status
    """

    def __init__(self, radio_client, port: int = 40001, host: str = '0.0.0.0', gui_callback=None, websocket_manager=None):
        """Initialize TCI server.

        Args:
            radio_client: Radio client instance to control
            port: WebSocket server port (default: 40001)
            host: WebSocket server host (default: 0.0.0.0)
            gui_callback: Optional callback to GUI for frequency/mode changes
            websocket_manager: Optional DXClusterWebSocket manager for injecting spots
        """
        self.radio_client = radio_client
        self.port = port
        self.host = host
        self.running = False
        self.server = None
        self.thread: Optional[threading.Thread] = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.gui_callback = gui_callback
        self.websocket_manager = websocket_manager
        self.start_error: Optional[Exception] = None  # Store startup errors

        # TCI spot storage for SPOT_DELETE and SPOT_CLEAR commands
        self.tci_spots: Dict[str, Dict] = {}  # callsign -> spot_data

        # Mode change debouncing to prevent rate limit errors
        self.last_mode_change_time = 0
        self.mode_change_cooldown = 0.6  # 600ms cooldown between mode changes (accounts for server's 500ms delay)
        self.pending_mode_change = None  # Store pending mode change during cooldown
        self.mode_change_lock = threading.Lock()

        # Connected clients
        self.clients: Set[websockets.WebSocketServerProtocol] = set()
        self.connected_client_ip: Optional[str] = None  # Track connected client IP

        # Radio state
        self.device_name = "UberSDR"
        self.protocol_version = "ubersdr,1.0"
        self.receiver_count = 2  # RX1 and RX2
        self.channel_count = 2  # Number of channels per receiver (VFO A and VFO B)
        self.vfo_limits = (0, 60000000)  # 0 Hz to 60 MHz
        self.audio_sample_rate = 48000
        self.audio_streaming = defaultdict(bool)  # receiver -> streaming state

        # Initialize IQ sample rate from radio_client's current mode
        initial_mode = getattr(radio_client, 'mode', 'usb').lower()
        if initial_mode in ['iq48', 'iq96', 'iq192', 'iq384']:
            # Extract sample rate from mode name (e.g., 'iq96' -> 96000)
            rate_khz = int(initial_mode.replace('iq', ''))
            self.iq_sample_rate = rate_khz * 1000
            self.current_iq_mode = initial_mode  # Track that we're starting in IQ mode
            print(f"TCI server: Initialized in {initial_mode} mode with sample rate {self.iq_sample_rate} Hz")
        else:
            self.iq_sample_rate = 48000  # Default for non-IQ modes
            self.current_iq_mode = None

        self.iq_streaming = defaultdict(bool)  # receiver -> IQ streaming state
        self.previous_mode = None  # Store mode before switching to IQ

        # Initialize VFO state from radio_client's current frequency
        initial_freq = getattr(radio_client, 'frequency', 14074000)
        self.vfo_frequencies = {
            0: {0: initial_freq, 1: initial_freq},  # RX1: VFO A, VFO B
            1: {0: initial_freq, 1: initial_freq}   # RX2: VFO A, VFO B
        }

        # Initialize modulation from radio_client's current mode
        # Map UberSDR modes to TCI modes
        initial_mode = getattr(radio_client, 'mode', 'usb').lower()
        mode_map = {
            'usb': 'usb', 'lsb': 'lsb', 'cw': 'cw', 'cwu': 'cw', 'cwl': 'cw',
            'am': 'am', 'sam': 'sam', 'fm': 'nfm', 'nfm': 'nfm', 'wfm': 'wfm'
        }
        tci_mode = mode_map.get(initial_mode, 'usb')
        self.modulations = {0: tci_mode, 1: tci_mode}  # receiver -> mode
        self.split_enabled = {0: False, 1: False}  # receiver -> split state
        self.rx_enabled = {0: True, 1: False}  # receiver -> enabled state
        self.ptt_state = {0: False, 1: False}  # receiver -> PTT state
        self.power_on = True
        self.signal_level = {0: -127, 1: -127}  # receiver -> signal level in dBm

        # Spectrum display reference for signal level updates
        self.spectrum_display = None

        # Audio callback
        self.audio_callback: Optional[Callable] = None

    def start(self) -> bool:
        """Start the TCI server.

        Returns:
            True if server started successfully, False otherwise
        """
        if self.running:
            return True

        self.running = True
        self.start_error = None  # Clear any previous error
        self.thread = threading.Thread(target=self._run_server, daemon=True)
        self.thread.start()

        # Wait for event loop to be ready (up to 2 seconds)
        max_wait = 2.0
        wait_interval = 0.1
        elapsed = 0.0
        while elapsed < max_wait:
            # Check if an error occurred during startup
            if self.start_error:
                self.running = False
                return False

            if self.loop and self.loop.is_running():
                return True
            time.sleep(wait_interval)
            elapsed += wait_interval

        # If we get here, loop didn't start in time
        print("WARNING: TCI server event loop did not start within timeout")
        self.running = False
        return False

    def stop(self):
        """Stop the TCI server."""
        self.running = False

        # Stop the event loop
        if self.loop and self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)

        # Wait for thread to finish
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2.0)

        self.clients.clear()

    def _run_server(self):
        """Run the WebSocket server in a separate thread."""
        try:
            self.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.loop)

            print(f"TCI server: Creating WebSocket server on {self.host}:{self.port}")

            # Create an async function to start the server
            async def start_server():
                return await websockets.serve(
                    self._handle_client,
                    self.host,
                    self.port,
                    ping_interval=None  # Disable ping/pong for compatibility
                )

            # Start the server using run_until_complete
            self.server = self.loop.run_until_complete(start_server())
            print(f"✓ TCI server started on ws://{self.host}:{self.port}")

            # Run until stopped
            self.loop.run_forever()
        except OSError as e:
            # Store the error so start() can detect it
            self.start_error = e
            if e.errno == 98:  # Address already in use
                print(f"✗ TCI server error: Port {self.port} is already in use")
            else:
                print(f"✗ TCI server error: {e}")
        except Exception as e:
            # Store the error so start() can detect it
            self.start_error = e
            print(f"✗ TCI server error: {e}")
            import traceback
            traceback.print_exc()
        finally:
            if self.server:
                try:
                    self.server.close()
                    self.loop.run_until_complete(self.server.wait_closed())
                except:
                    pass
            if self.loop:
                try:
                    self.loop.close()
                except:
                    pass

    async def _handle_client(self, websocket):
        """Handle a connected TCI client.

        Args:
            websocket: WebSocket connection (ServerConnection object in newer websockets)
        """
        # Check if a client is already connected
        if self.clients:
            print(f"TCI client connection rejected from {websocket.remote_address} - client already connected")
            await websocket.close(1008, "Only one TCI client allowed at a time")
            return

        self.clients.add(websocket)
        # Store connected client IP (extract IP from remote_address tuple)
        if websocket.remote_address:
            self.connected_client_ip = websocket.remote_address[0]
        print(f"TCI client connected from {websocket.remote_address}")

        try:
            # Send initial state
            await self._send_initial_state(websocket)

            # Process messages
            async for message in websocket:
                if isinstance(message, str):
                    await self._process_text_message(websocket, message)
                elif isinstance(message, bytes):
                    await self._process_binary_message(websocket, message)
        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception as e:
            print(f"TCI client error: {e}")
        finally:
            self.clients.discard(websocket)
            self.connected_client_ip = None  # Clear IP on disconnect
            print(f"TCI client disconnected")

    async def _send_initial_state(self, websocket):
        """Send initial radio state to newly connected client.

        Args:
            websocket: WebSocket connection
        """
        # Send device info
        await self._send_text(websocket, f"device:{self.device_name};")
        await self._send_text(websocket, f"protocol:{self.protocol_version};")

        # Send receive-only status
        await self._send_text(websocket, f"receive_only:true;")

        # Send receiver count
        await self._send_text(websocket, f"trx_count:{self.receiver_count};")

        # Send channel count (number of VFOs per receiver: A/B)
        await self._send_text(websocket, f"channel_count:{self.channel_count};")

        # Send VFO limits
        await self._send_text(websocket, f"vfo_limits:{self.vfo_limits[0]},{self.vfo_limits[1]};")

        # Send IF limits (intermediate frequency filter limits)
        # For IQ modes, this represents the bandwidth available
        if_low = -48000  # -48 kHz
        if_high = 48000  # +48 kHz
        await self._send_text(websocket, f"if_limits:{if_low},{if_high};")

        # Send modulation list
        modes = "am,sam,dsb,lsb,usb,cw,nfm,wfm,digl,digu,spec,drm"
        await self._send_text(websocket, f"modulations_list:{modes};")

        # Send audio sample rate
        await self._send_text(websocket, f"audio_samplerate:{self.audio_sample_rate};")

        # Send IQ sample rate
        await self._send_text(websocket, f"iq_samplerate:{self.iq_sample_rate};")

        # Send current state for each receiver
        for rx in range(self.receiver_count):
            # RX enable state
            await self._send_text(websocket, f"rx_enable:{rx},{str(self.rx_enabled[rx]).lower()};")

            # DDS (receiver center frequency) - send before VFO
            dds_freq = self.vfo_frequencies[rx][0]  # Use VFO A as center frequency
            await self._send_text(websocket, f"dds:{rx},{dds_freq};")

            # VFO frequencies
            for vfo in [0, 1]:
                freq = self.vfo_frequencies[rx][vfo]
                await self._send_text(websocket, f"vfo:{rx},{vfo},{freq};")

            # Modulation
            await self._send_text(websocket, f"modulation:{rx},{self.modulations[rx]};")

            # Split state
            await self._send_text(websocket, f"split_enable:{rx},{str(self.split_enabled[rx]).lower()};")

            # PTT state
            await self._send_text(websocket, f"trx:{rx},{str(self.ptt_state[rx]).lower()};")

        # Send ready signal
        await self._send_text(websocket, "ready;")

        # Send power state
        if self.power_on:
            await self._send_text(websocket, "start;")

    async def _process_text_message(self, websocket, message: str):
        """Process incoming text message (command).

        Args:
            websocket: WebSocket connection
            message: Text message
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

            # Log all commands for debugging
            print(f"DEBUG TCI: Received command: {cmd_name} {args}", file=sys.stderr)

            # Process command
            await self._process_command(websocket, cmd_name.lower(), args)

    async def _process_command(self, websocket, cmd: str, args: list):
        """Process a TCI command.

        Args:
            websocket: WebSocket connection
            cmd: Command name
            args: Command arguments
        """
        try:
            if cmd == 'dds':
                # Set DDS (receiver center frequency): dds:receiver,frequency
                if len(args) >= 2:
                    rx = int(args[0])
                    freq = int(args[1])
                    # DDS sets the center frequency, which we treat as VFO A
                    await self._set_vfo_frequency(rx, 0, freq)
                    # Also broadcast DDS command to all clients
                    await self._broadcast_text(f"dds:{rx},{freq};")
                elif len(args) >= 1:
                    # Query DDS
                    rx = int(args[0])
                    freq = self.vfo_frequencies[rx][0]
                    await self._send_text(websocket, f"dds:{rx},{freq};")

            elif cmd == 'vfo':
                # Set VFO frequency: vfo:receiver,vfo_num,frequency
                if len(args) >= 3:
                    rx = int(args[0])
                    vfo = int(args[1])
                    freq = int(args[2])
                    await self._set_vfo_frequency(rx, vfo, freq)

            elif cmd == 'modulation':
                # Set modulation: modulation:receiver,mode
                if len(args) >= 2:
                    rx = int(args[0])
                    mode = args[1].lower()
                    await self._set_modulation(rx, mode)

            elif cmd == 'trx':
                # Set PTT: trx:receiver,state
                if len(args) >= 2:
                    rx = int(args[0])
                    state = args[1].lower() == 'true'
                    await self._set_ptt(rx, state)

            elif cmd == 'split_enable':
                # Set split: split_enable:receiver,state
                if len(args) >= 2:
                    rx = int(args[0])
                    state = args[1].lower() == 'true'
                    await self._set_split(rx, state)

            elif cmd == 'rx_enable':
                # Enable/disable receiver: rx_enable:receiver,state
                if len(args) >= 2:
                    rx = int(args[0])
                    state = args[1].lower() == 'true'
                    await self._set_rx_enable(rx, state)

            elif cmd == 'audio_start':
                # Start audio streaming: audio_start:receiver
                if len(args) >= 1:
                    rx = int(args[0])
                    await self._start_audio_streaming(rx)

            elif cmd == 'audio_stop':
                # Stop audio streaming: audio_stop:receiver
                if len(args) >= 1:
                    rx = int(args[0])
                    await self._stop_audio_streaming(rx)

            elif cmd == 'iq_samplerate':
                # Set IQ sample rate: iq_samplerate:rate
                if len(args) >= 1:
                    rate = int(args[0])
                    print(f"TCI server: Received iq_samplerate command from client: {rate} Hz")
                    await self._set_iq_samplerate(rate)

            elif cmd == 'iq_start':
                # Start IQ streaming: iq_start:receiver
                if len(args) >= 1:
                    rx = int(args[0])
                    await self._start_iq_streaming(rx)

            elif cmd == 'iq_stop':
                # Stop IQ streaming: iq_stop:receiver
                if len(args) >= 1:
                    rx = int(args[0])
                    await self._stop_iq_streaming(rx)

            elif cmd == 'start':
                # Power on
                self.power_on = True
                await self._broadcast_text("start;")

            elif cmd == 'stop':
                # Power off
                self.power_on = False
                await self._broadcast_text("stop;")

            elif cmd == 'device':
                # Query device name
                await self._send_text(websocket, f"device:{self.device_name};")

            elif cmd == 'protocol':
                # Query protocol version
                await self._send_text(websocket, f"protocol:{self.protocol_version};")

            elif cmd == 'rx_smeter':
                # S-meter query: rx_smeter:receiver,channel
                # JTDX sends this to request signal level
                # We respond with current signal level
                if len(args) >= 2:
                    rx = int(args[0])
                    channel = int(args[1])
                    level = self.signal_level.get(rx, -127)
                    await self._send_text(websocket, f"rx_smeter:{rx},{channel},{level};")

            elif cmd == 'if_limits' or cmd == 'if':
                # Query IF limits (some clients send 'if' instead of 'if_limits')
                if_low = -48000
                if_high = 48000
                await self._send_text(websocket, f"if_limits:{if_low},{if_high};")

            elif cmd == 'drive':
                # TX power control - we're receive-only, so respond with 0
                if len(args) >= 1:
                    rx = int(args[0])
                    # Ignore the set request, just acknowledge with 0 power
                    await self._send_text(websocket, f"drive:{rx},0;")
                else:
                    # Query - respond with 0 power
                    await self._send_text(websocket, f"drive:0,0;")

            elif cmd == 'tune_drive':
                # Tune power control - we're receive-only, so respond with 0
                if len(args) >= 1:
                    rx = int(args[0])
                    await self._send_text(websocket, f"tune_drive:{rx},0;")
                else:
                    await self._send_text(websocket, f"tune_drive:0,0;")

            elif cmd == 'tune':
                # Tune mode - we're receive-only, ignore but acknowledge
                if len(args) >= 2:
                    rx = int(args[0])
                    state = args[1].lower()
                    # Always respond with false (not tuning)
                    await self._send_text(websocket, f"tune:{rx},false;")

            elif cmd == 'tx_enable':
                # TX enable query - we're receive-only
                if len(args) >= 1:
                    rx = int(args[0])
                    # Always respond with false (TX not enabled)
                    await self._send_text(websocket, f"tx_enable:{rx},false;")

            elif cmd == 'spot':
                # Receive spot from TCI client: spot:callsign,mode,frequency,color,text
                if len(args) >= 3:
                    await self._handle_spot(args)

            elif cmd == 'spot_delete':
                # Delete spot by callsign: spot_delete:callsign
                if len(args) >= 1:
                    await self._handle_spot_delete(args[0])

            elif cmd == 'spot_clear':
                # Clear all TCI spots: spot_clear
                await self._handle_spot_clear()

            else:
                # Unknown command - log but don't error
                print(f"Unknown TCI command: {cmd}")

        except Exception as e:
            print(f"Error processing TCI command '{cmd}': {e}")

    async def _set_vfo_frequency(self, rx: int, vfo: int, freq: int, skip_callback: bool = False):
        """Set VFO frequency.

        Args:
            rx: Receiver number (0 or 1)
            vfo: VFO number (0=RX, 1=TX for split)
            freq: Frequency in Hz
            skip_callback: If True, don't call GUI callback (prevents feedback loop)
        """
        if rx not in self.vfo_frequencies:
            return

        self.vfo_frequencies[rx][vfo] = freq

        # Log frequency change
        print(f"TCI server: Received frequency change - RX{rx} VFO{vfo} = {freq/1e6:.6f} MHz")

        # Update GUI if this is the active receiver and RX VFO (unless skip_callback is True)
        if rx == 0 and vfo == 0 and self.gui_callback and not skip_callback:
            # Call GUI callback to update frequency
            self.gui_callback('frequency', freq)

        # Broadcast to all clients
        # If this is VFO A (the RX VFO), also broadcast DDS (center frequency)
        if vfo == 0:
            await self._broadcast_text(f"dds:{rx},{freq};")
        await self._broadcast_text(f"vfo:{rx},{vfo},{freq};")

    async def _set_modulation(self, rx: int, mode: str, skip_callback: bool = False):
        """Set modulation mode.

        Args:
            rx: Receiver number
            mode: Mode string (usb, lsb, cw, etc.)
            skip_callback: If True, don't call GUI callback (prevents feedback loop)
        """
        if rx not in self.modulations:
            return

        # Only update if mode actually changed
        if self.modulations[rx] == mode:
            print(f"TCI server: Modulation already set to {mode}, no change needed")
            return

        self.modulations[rx] = mode

        # Modulation command only updates TCI state, not radio mode
        # Radio mode only changes when audio streaming is explicitly requested
        # If in IQ mode, save this as the mode to use when audio is requested
        audio_modes = ['usb', 'lsb', 'cw', 'digu', 'digl', 'am', 'sam', 'fm', 'nfm', 'wfm']
        if mode.lower() in audio_modes:
            if hasattr(self.radio_client, 'mode'):
                current_mode = getattr(self.radio_client, 'mode', '').lower()
                if current_mode in ['iq', 'iq48', 'iq96', 'iq192', 'iq384']:
                    # In IQ mode: just save the modulation for when audio is requested
                    mode_map = {
                        'usb': 'usb',
                        'lsb': 'lsb',
                        'cw': 'cwu',
                        'digu': 'usb',
                        'digl': 'lsb',
                        'am': 'am',
                        'sam': 'sam',
                        'fm': 'fm',
                        'nfm': 'nfm',
                        'wfm': 'fm'
                    }
                    radio_mode = mode_map.get(mode.lower(), 'usb')
                    self.previous_mode = radio_mode
                    print(f"TCI server: Modulation set to {mode} (saved as {radio_mode}, will apply when audio requested)")
                    # Don't switch mode - modulation command alone doesn't change radio mode

        # Update GUI if this is the active receiver (unless skip_callback is True)
        # BUT: Don't update GUI if we're in IQ mode - that would trigger unwanted mode changes
        if rx == 0 and self.gui_callback and not skip_callback:
            # Skip GUI callback if we're currently in IQ mode
            if self.current_iq_mode is not None:
                print(f"TCI server: Skipping GUI callback for modulation change while in IQ mode")
            else:
                # Map TCI modes to UberSDR modes
                mode_map = {
                    'usb': 'USB',
                    'lsb': 'LSB',
                    'cw': 'CWU',
                    'digu': 'USB',  # Digital upper
                    'digl': 'LSB',  # Digital lower
                    'am': 'AM',
                    'sam': 'SAM',
                    'fm': 'FM',
                    'nfm': 'NFM',
                    'wfm': 'FM'
                }
                ubersdr_mode = mode_map.get(mode, 'USB')
                # Call GUI callback to update mode
                self.gui_callback('mode', ubersdr_mode)

        # Broadcast to all clients
        await self._broadcast_text(f"modulation:{rx},{mode};")

    async def _set_ptt(self, rx: int, state: bool):
        """Set PTT state.

        Args:
            rx: Receiver number
            state: PTT state (True=transmit, False=receive)
        """
        if rx not in self.ptt_state:
            return

        self.ptt_state[rx] = state

        # Broadcast to all clients
        await self._broadcast_text(f"trx:{rx},{str(state).lower()};")

    async def _set_split(self, rx: int, state: bool):
        """Set split operation state.

        Args:
            rx: Receiver number
            state: Split state
        """
        if rx not in self.split_enabled:
            return

        self.split_enabled[rx] = state

        # Broadcast to all clients
        await self._broadcast_text(f"split_enable:{rx},{str(state).lower()};")

    async def _set_rx_enable(self, rx: int, state: bool):
        """Enable/disable receiver.

        Args:
            rx: Receiver number
            state: Enable state
        """
        if rx not in self.rx_enabled:
            return

        self.rx_enabled[rx] = state

        # Broadcast to all clients
        await self._broadcast_text(f"rx_enable:{rx},{str(state).lower()};")

    async def _start_audio_streaming(self, rx: int):
        """Start audio streaming for receiver.

        Args:
            rx: Receiver number
        """
        self.audio_streaming[rx] = True
        print(f"TCI server: Audio streaming STARTED for RX{rx}")

        # If currently in IQ mode, switch back to previous audio mode
        if self.current_iq_mode is not None:
            # Restore previous mode, or default to USB if none saved
            restore_mode = self.previous_mode if self.previous_mode else 'usb'
            print(f"TCI server: Switching from IQ mode to {restore_mode} for audio streaming")

            # Use debounced mode change
            await self._debounced_mode_change(restore_mode, is_iq_mode=False)

        # Broadcast to all clients
        await self._broadcast_text(f"audio_start:{rx};")

    async def _stop_audio_streaming(self, rx: int):
        """Stop audio streaming for receiver.

        Args:
            rx: Receiver number
        """
        self.audio_streaming[rx] = False

        # Broadcast to all clients
        await self._broadcast_text(f"audio_stop:{rx};")

    async def _set_iq_samplerate(self, rate: int):
        """Set IQ sample rate.

        Args:
            rate: Sample rate in Hz (48000, 96000, 192000, or 384000)
        """
        # Validate sample rate against protocol specification
        valid_rates = [48000, 96000, 192000, 384000]
        if rate not in valid_rates:
            print(f"TCI server: Invalid IQ sample rate {rate}, using 48000")
            rate = 48000

        # Check if this rate is allowed by the radio client instance
        # Map sample rates to IQ mode names
        rate_to_mode = {
            48000: 'iq48',
            96000: 'iq96',
            192000: 'iq192',
            384000: 'iq384'
        }

        mode_name = rate_to_mode.get(rate)
        if mode_name:
            # Check if radio client has allowed_iq_modes list
            allowed_modes = getattr(self.radio_client, 'allowed_iq_modes', [])
            if allowed_modes and mode_name not in allowed_modes:
                # This rate is not allowed by the instance
                print(f"TCI server: IQ sample rate {rate} Hz ({mode_name}) not allowed by this instance")
                print(f"TCI server: Allowed IQ modes: {allowed_modes}")

                # Find the highest allowed rate, or fall back to 48 kHz
                allowed_rates = []
                for allowed_mode in allowed_modes:
                    if allowed_mode in ['iq48', 'iq96', 'iq192', 'iq384']:
                        mode_rate = int(allowed_mode.replace('iq', '')) * 1000
                        allowed_rates.append(mode_rate)

                if allowed_rates:
                    rate = max(allowed_rates)
                    print(f"TCI server: Using highest allowed rate: {rate} Hz")
                else:
                    # No IQ modes allowed, reject the request
                    print(f"TCI server: No IQ modes allowed by this instance")
                    return

        # Only update if rate actually changed
        if self.iq_sample_rate != rate:
            self.iq_sample_rate = rate
            print(f"TCI server: IQ sample rate set to {rate} Hz")

            # If TCI client is requesting a different rate than current IQ mode,
            # switch to the appropriate IQ mode to honor the client's request
            target_mode = rate_to_mode.get(rate)
            if target_mode and self.current_iq_mode != target_mode:
                print(f"TCI server: TCI client requested {rate} Hz, switching from {self.current_iq_mode} to {target_mode}")
                # Update mode tracking and switch via GUI callback
                self.current_iq_mode = target_mode
                if self.gui_callback:
                    self.gui_callback('mode', target_mode.upper())

            # Broadcast to all clients
            await self._broadcast_text(f"iq_samplerate:{rate};")
        else:
            print(f"TCI server: IQ sample rate already {rate} Hz, no change needed")

    async def _start_iq_streaming(self, rx: int):
        """Start IQ streaming for receiver.

        Args:
            rx: Receiver number
        """
        self.iq_streaming[rx] = True

        # If we're already in an IQ mode, keep that mode instead of switching
        # based on self.iq_sample_rate (which may not be updated yet due to race conditions)
        if self.current_iq_mode is not None:
            # Already in an IQ mode - just start streaming, don't switch modes
            # Extract sample rate from current mode for logging
            mode_to_rate = {
                'iq48': 48000,
                'iq96': 96000,
                'iq192': 192000,
                'iq384': 384000
            }
            current_rate = mode_to_rate.get(self.current_iq_mode, self.iq_sample_rate)
            print(f"TCI server: IQ streaming STARTED for RX{rx} at {current_rate} Hz (already in {self.current_iq_mode} mode)")
        else:
            # Not in IQ mode yet - determine target mode based on sample rate
            print(f"TCI server: IQ streaming STARTED for RX{rx} at {self.iq_sample_rate} Hz")

            rate_to_mode = {
                48000: 'iq48',
                96000: 'iq96',
                192000: 'iq192',
                384000: 'iq384'
            }
            iq_mode = rate_to_mode.get(self.iq_sample_rate, 'iq48')

            # Need to switch to IQ mode - use debounced mode change
            await self._debounced_mode_change(iq_mode, is_iq_mode=True)

        # Broadcast IQ start to all clients
        await self._broadcast_text(f"iq_start:{rx};")

        # Send current center frequency (DDS) so client knows what frequency the IQ data corresponds to
        # This is critical for applications like CW Skimmer that need to know the center frequency
        # According to TCI Protocol v2.0, DDS is the receiver center frequency command
        freq = self.vfo_frequencies[rx][0]  # Get RX VFO (VFO A)
        print(f"TCI server: Sending center frequency to client: RX{rx} = {freq/1e6:.6f} MHz")
        await self._broadcast_text(f"dds:{rx},{freq};")
        await self._broadcast_text(f"vfo:{rx},0,{freq};")

    async def _debounced_mode_change(self, target_mode: str, is_iq_mode: bool):
        """Perform a debounced mode change to prevent rate limiting.

        Args:
            target_mode: Target mode to switch to
            is_iq_mode: True if switching to IQ mode, False if switching to audio mode
        """
        with self.mode_change_lock:
            current_time = time.time()
            time_since_last_change = current_time - self.last_mode_change_time

            if time_since_last_change < self.mode_change_cooldown:
                # Too soon - wait for cooldown
                wait_time = self.mode_change_cooldown - time_since_last_change
                print(f"TCI server: Mode change debounced, waiting {wait_time:.3f}s before switching to {target_mode}")
                await asyncio.sleep(wait_time)

            # Perform the mode change
            if is_iq_mode:
                # Switching to IQ mode
                if hasattr(self.radio_client, 'mode'):
                    current_mode = getattr(self.radio_client, 'mode', 'usb').lower()

                    # If switching from audio mode, save it (but only if we haven't already saved one)
                    if current_mode not in ['iq', 'iq48', 'iq96', 'iq192', 'iq384'] and self.current_iq_mode is None:
                        self.previous_mode = current_mode
                        print(f"TCI server: Saved previous mode: {self.previous_mode}")

                    if self.current_iq_mode is not None:
                        print(f"TCI server: Switching from {self.current_iq_mode} to {target_mode} mode")
                    else:
                        print(f"TCI server: Switching to {target_mode} mode")

                    self.current_iq_mode = target_mode  # Track that we're now in this IQ mode

                    # Use GUI callback to change mode
                    if self.gui_callback:
                        self.gui_callback('mode', target_mode.upper())
            else:
                # Switching to audio mode
                # Clear saved mode and IQ mode tracking
                self.previous_mode = None
                self.current_iq_mode = None

                # Use GUI callback to change mode
                if self.gui_callback:
                    self.gui_callback('mode', target_mode.upper())

            # Update last mode change time
            self.last_mode_change_time = time.time()

    async def _stop_iq_streaming(self, rx: int):
        """Stop IQ streaming for receiver.

        Args:
            rx: Receiver number
        """
        self.iq_streaming[rx] = False
        print(f"TCI server: IQ streaming STOPPED for RX{rx}")

        # Don't automatically switch mode when IQ streaming stops
        # The client should explicitly request audio streaming or change modulation
        # if they want to switch away from IQ mode
        # Just keep the previous_mode saved for when they do request audio

        # Broadcast to all clients
        await self._broadcast_text(f"iq_stop:{rx};")

    async def _process_binary_message(self, websocket, data: bytes):
        """Process incoming binary message.

        Args:
            websocket: WebSocket connection
            data: Binary data
        """
        # TCI clients shouldn't send binary data to server
        # This is for TX audio in the future
        pass

    async def _send_text(self, websocket, message: str):
        """Send text message to specific client.

        Args:
            websocket: WebSocket connection
            message: Text message
        """
        try:
            await websocket.send(message)
        except Exception as e:
            print(f"Error sending TCI text message: {e}")

    async def _broadcast_text(self, message: str):
        """Broadcast text message to all connected clients.

        Args:
            message: Text message
        """
        if not self.clients:
            return

        # Send to all clients
        websockets.broadcast(self.clients, message)

    def send_audio_data(self, rx: int, audio_data: bytes, sample_rate: int = 48000):
        """Send audio data to connected clients.

        This should be called from the main thread when audio data is available.

        Args:
            rx: Receiver number
            audio_data: Audio data as float32 stereo samples
            sample_rate: Sample rate in Hz
        """
        if not self.audio_streaming.get(rx, False):
            # Audio streaming not enabled for this receiver
            return

        if not self.clients:
            # No clients connected
            return

        # Schedule sending in the event loop
        if not self.loop or not self.loop.is_running():
            return

        try:
            asyncio.run_coroutine_threadsafe(
                self._send_audio_frame(rx, audio_data, sample_rate),
                self.loop
            )
        except Exception as e:
            # Don't log audio errors (too verbose)
            pass

    async def _send_audio_frame(self, rx: int, audio_data: bytes, sample_rate: int):
        """Send audio frame to all clients.

        Args:
            rx: Receiver number
            audio_data: Audio data as float32 stereo samples (interleaved L,R,L,R,...)
            sample_rate: Sample rate in Hz
        """
        # Create TCI audio frame header (64 bytes)
        # Based on JTDX TCITransceiver.hpp Data_Stream structure:
        # typedef struct {
        #     quint32 receiver;       // offset 0
        #     quint32 sampleRate;     // offset 4
        #     quint32 format;         // offset 8  (0=int16, 1=int24, 2=int32, 3=float32, 4=float64)
        #     quint32 codec;          // offset 12
        #     quint32 crc;            // offset 16
        #     quint32 length;         // offset 20 (number of STEREO PAIRS, not individual floats)
        #     quint32 type;           // offset 24 (RxAudioStream = 1)
        #     quint32 reserv[9];      // offset 28-60 (9 reserved uint32s)
        #     float   data[8192];     // offset 64 (audio data starts here)
        # }Data_Stream;

        # CRITICAL: length field is TOTAL NUMBER OF FLOATS (not stereo pairs!)
        # According to JTDX TCITransceiver.hpp line 31: "к-во float чисел" (number of float numbers)
        # Each float32 = 4 bytes, so total_floats = total_bytes / 4
        num_floats = len(audio_data) // 4
        num_sample_pairs = num_floats // 2  # For logging only

        # Build header (16 x 32-bit integers = 64 bytes) - CORRECT ORDER
        header = struct.pack(
            '<IIIIIIIIIIIIIIII',
            rx,                  # receiver (offset 0)
            sample_rate,         # sampleRate (offset 4)
            3,                   # format: float32 (offset 8)
            0,                   # codec (offset 12)
            0,                   # crc (offset 16)
            num_floats,          # length: TOTAL NUMBER OF FLOATS (offset 20)
            1,                   # type: RxAudioStream (offset 24)
            0, 0, 0, 0, 0, 0, 0, 0, 0  # reserved[9] (offset 28-60)
        )

        # Combine header and audio data
        frame = header + audio_data

        # Broadcast to all clients
        if self.clients:
            websockets.broadcast(self.clients, frame)

    def send_iq_data(self, rx: int, iq_data: bytes, sample_rate: int = 48000):
        """Send IQ data to connected clients.

        This should be called from the main thread when IQ data is available.

        Args:
            rx: Receiver number
            iq_data: IQ data as float32 complex samples (interleaved I,Q,I,Q,...)
            sample_rate: Sample rate in Hz
        """
        if not self.iq_streaming.get(rx, False):
            # IQ streaming not enabled for this receiver
            if not hasattr(self, '_iq_not_streaming_logged'):
                print(f"DEBUG TCI: IQ streaming not enabled for RX{rx}", file=sys.stderr)
                self._iq_not_streaming_logged = True
            return

        if not self.clients:
            # No clients connected
            if not hasattr(self, '_no_clients_logged'):
                print(f"DEBUG TCI: No TCI clients connected", file=sys.stderr)
                self._no_clients_logged = True
            return

        # Log first IQ data transmission
        if not hasattr(self, '_iq_data_logged'):
            print(f"DEBUG TCI: Sending IQ data to client (size: {len(iq_data)} bytes, rate: {sample_rate} Hz)", file=sys.stderr)
            self._iq_data_logged = True

        # Schedule sending in the event loop
        if not self.loop or not self.loop.is_running():
            return

        try:
            asyncio.run_coroutine_threadsafe(
                self._send_iq_frame(rx, iq_data, sample_rate),
                self.loop
            )
        except Exception as e:
            # Don't log IQ errors (too verbose)
            pass

    async def _send_iq_frame(self, rx: int, iq_data: bytes, sample_rate: int):
        """Send IQ frame to all clients.

        Args:
            rx: Receiver number
            iq_data: IQ data as float32 complex samples (interleaved I,Q,I,Q,...)
            sample_rate: Sample rate in Hz
        """
        # Create TCI IQ frame header (64 bytes)
        # Based on TCI protocol specification:
        # typedef struct {
        #     quint32 receiver;       // offset 0
        #     quint32 sampleRate;     // offset 4
        #     quint32 format;         // offset 8  (0=int16, 1=int24, 2=int32, 3=float32)
        #     quint32 codec;          // offset 12
        #     quint32 crc;            // offset 16
        #     quint32 length;         // offset 20 (number of FLOATS, not complex samples)
        #     quint32 type;           // offset 24 (IQ_STREAM = 0)
        #     quint32 channels;       // offset 28 (always 2 for IQ: I and Q)
        #     quint32 reserv[8];      // offset 32-60 (8 reserved uint32s)
        #     float   data[...];      // offset 64 (IQ data starts here)
        # }

        # Calculate number of floats (I and Q are separate floats)
        num_floats = len(iq_data) // 4

        # Build header (16 x 32-bit integers = 64 bytes)
        header = struct.pack(
            '<IIIIIIIIIIIIIIII',
            rx,                  # receiver (offset 0)
            sample_rate,         # sampleRate (offset 4)
            3,                   # format: float32 (offset 8)
            0,                   # codec (offset 12)
            0,                   # crc (offset 16)
            num_floats,          # length: TOTAL NUMBER OF FLOATS (offset 20)
            0,                   # type: IQ_STREAM (offset 24)
            2,                   # channels: always 2 for IQ (I and Q) (offset 28)
            0, 0, 0, 0, 0, 0, 0, 0  # reserved[8] (offset 32-60)
        )

        # Combine header and IQ data
        frame = header + iq_data

        # Broadcast to all clients
        if self.clients:
            websockets.broadcast(self.clients, frame)

    def update_frequency(self, freq_hz: int, rx: int = 0, vfo: int = 0, skip_callback: bool = False):
        """Update frequency from radio client.

        Args:
            freq_hz: Frequency in Hz
            rx: Receiver number
            vfo: VFO number
            skip_callback: If True, don't call GUI callback (prevents feedback loop)
        """
        if not self.loop or not self.loop.is_running():
            print(f"TCI server: Cannot update frequency - event loop not running")
            return

        try:
            asyncio.run_coroutine_threadsafe(
                self._set_vfo_frequency(rx, vfo, freq_hz, skip_callback),
                self.loop
            )
        except Exception as e:
            print(f"TCI server: Error updating frequency: {e}")

    def update_mode(self, mode: str, rx: int = 0, skip_callback: bool = False):
        """Update mode from radio client.

        Args:
            mode: Mode string
            rx: Receiver number
            skip_callback: If True, don't call GUI callback (prevents feedback loop)
        """
        if not self.loop or not self.loop.is_running():
            print(f"TCI server: Cannot update mode - event loop not running")
            return

        # Check if this is an IQ mode change
        mode_lower = mode.lower()
        if mode_lower in ['iq48', 'iq96', 'iq192', 'iq384']:
            # Extract sample rate from mode name (e.g., 'iq96' -> 96000)
            rate_khz = int(mode_lower.replace('iq', ''))
            new_rate = rate_khz * 1000

            # Update IQ sample rate and notify TCI clients
            if self.iq_sample_rate != new_rate:
                print(f"TCI server: IQ mode changed to {mode}, updating sample rate to {new_rate} Hz")
                try:
                    asyncio.run_coroutine_threadsafe(
                        self._set_iq_samplerate(new_rate),
                        self.loop
                    )
                except Exception as e:
                    print(f"TCI server: Error updating IQ sample rate: {e}")

            # Update current IQ mode tracking
            self.current_iq_mode = mode_lower
            return

        # Map UberSDR modes to TCI modes
        mode_map = {
            'USB': 'usb',
            'LSB': 'lsb',
            'CW': 'cw',
            'CWU': 'cw',
            'CWL': 'cw',
            'AM': 'am',
            'SAM': 'sam',
            'FM': 'nfm',
            'NFM': 'nfm',
            'WFM': 'wfm'
        }
        tci_mode = mode_map.get(mode.upper(), 'usb')

        try:
            asyncio.run_coroutine_threadsafe(
                self._set_modulation(rx, tci_mode, skip_callback),
                self.loop
            )
        except Exception as e:
            print(f"TCI server: Error updating mode: {e}")

    def update_signal_level(self, level_dbm: float, rx: int = 0):
        """Update signal level from spectrum data.

        Args:
            level_dbm: Signal level in dBm (typically -127 to -54 for S0 to S9)
            rx: Receiver number
        """
        if not self.loop or not self.loop.is_running():
            return

        # Store the level
        self.signal_level[rx] = int(level_dbm)

        # Broadcast to all clients
        try:
            asyncio.run_coroutine_threadsafe(
                self._broadcast_text(f"rx_smeter:{rx},0,{int(level_dbm)};"),
                self.loop
            )
        except Exception as e:
            # Don't log S-meter errors (too verbose)
            pass

    def set_spectrum_display(self, spectrum_display):
        """Set reference to spectrum display for signal level updates.

        Args:
            spectrum_display: SpectrumDisplay instance
        """
        self.spectrum_display = spectrum_display

    def update_signal_level_from_spectrum(self, bandwidth_low: int, bandwidth_high: int, rx: int = 0):
        """Update signal level from spectrum display data.

        This should be called periodically (e.g., every 250ms) to update the S-meter.

        Args:
            bandwidth_low: Low edge of bandwidth in Hz (relative to tuned frequency)
            bandwidth_high: High edge of bandwidth in Hz (relative to tuned frequency)
            rx: Receiver number
        """
        if not self.spectrum_display:
            return

        # Get signal metrics from spectrum
        peak_db, floor_db, snr_db = self.spectrum_display.get_bandwidth_signal(bandwidth_low, bandwidth_high)

        if peak_db is not None:
            # Use peak_db as the signal level (this is dBFS from the spectrum)
            # JTDX expects values around -127 to -54 dBm range
            # The spectrum gives us dBFS which we can use directly
            self.update_signal_level(peak_db, rx)


    async def _handle_spot(self, args: list):
        """Handle incoming SPOT command from TCI client.

        Args:
            args: List of arguments [callsign, mode, frequency, color, text]
        """
        if not self.websocket_manager:
            print("TCI server: No WebSocket manager available for spot injection")
            return

        try:
            # Parse TCI spot format: callsign, mode, frequency, color, text
            callsign = args[0] if len(args) > 0 else ""
            mode = args[1] if len(args) > 1 else "CW"
            frequency = int(args[2]) if len(args) > 2 else 0
            # color = args[3] if len(args) > 3 else ""  # Not used in our format
            comment = args[4] if len(args) > 4 else ""

            # Determine band from frequency
            band = self._frequency_to_band(frequency)

            # Create spot data matching server CW spot format
            spot_data = {
                'time': datetime.utcnow().isoformat() + 'Z',
                'frequency': frequency,
                'band': band,
                'dx_call': callsign,
                'country': '',  # TCI doesn't provide country
                'distance_km': None,  # TCI doesn't provide distance
                'bearing_deg': None,  # TCI doesn't provide bearing
                'snr': 0,  # TCI doesn't provide SNR
                'wpm': 0,  # TCI doesn't provide WPM
                'comment': 'TCI'  # Always just 'TCI' to identify source
            }

            # Store spot for potential deletion
            self.tci_spots[callsign] = spot_data

            # Inject spot into WebSocket manager's CW spot callback system
            print(f"TCI server: Received spot - {callsign} on {frequency/1e6:.3f} MHz ({band})")
            self.websocket_manager._notify_cw_spot(spot_data)

        except Exception as e:
            print(f"TCI server: Error handling spot: {e}")

    async def _handle_spot_delete(self, callsign: str):
        """Handle SPOT_DELETE command from TCI client.

        Args:
            callsign: Callsign of spot to delete
        """
        if callsign in self.tci_spots:
            del self.tci_spots[callsign]
            print(f"TCI server: Deleted spot for {callsign}")
        else:
            print(f"TCI server: No spot found for {callsign}")

    async def _handle_spot_clear(self):
        """Handle SPOT_CLEAR command from TCI client."""
        count = len(self.tci_spots)
        self.tci_spots.clear()
        print(f"TCI server: Cleared {count} TCI spot(s)")

    def _frequency_to_band(self, freq_hz: int) -> str:
        """Convert frequency in Hz to band name.

        Args:
            freq_hz: Frequency in Hz

        Returns:
            Band name (e.g., "20m") or empty string if not in amateur band
        """
        # Amateur band ranges (in Hz)
        bands = [
            (1800000, 2000000, "160m"),
            (3500000, 4000000, "80m"),
            (5330500, 5406500, "60m"),
            (7000000, 7300000, "40m"),
            (10100000, 10150000, "30m"),
            (14000000, 14350000, "20m"),
            (18068000, 18168000, "17m"),
            (21000000, 21450000, "15m"),
            (24890000, 24990000, "12m"),
            (28000000, 29700000, "10m"),
        ]

        for low, high, band_name in bands:
            if low <= freq_hz <= high:
                return band_name

        return ""


def main():
    """Example usage of TCIServer."""
    import sys

    print("TCI Server for UberSDR")
    print("Emulates Expert Electronics TCI protocol")
    print()
    print("This module requires integration with radio_client.py")
    print("Use the TCI server option in the radio client instead.")
    sys.exit(1)


if __name__ == '__main__':
    main()