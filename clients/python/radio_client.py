#!/usr/bin/env python3
"""
CLI Radio Client for ka9q_ubersdr
Connects to the WebSocket server and outputs audio to PipeWire, stdout, or WAV file.
"""

import argparse
import asyncio
import atexit
import base64
import json
import os
import signal
import stat
import struct
import sys
import time
import uuid
import wave
from typing import Optional, List, Tuple

import aiohttp
import websockets
from urllib.parse import urlparse, parse_qs, urlencode
import numpy as np
import subprocess
import re

# Import NR2 processor (optional, only if scipy is available)
try:
    from nr2 import create_nr2_processor
    NR2_AVAILABLE = True
except ImportError:
    NR2_AVAILABLE = False
    print("Warning: scipy not available, NR2 noise reduction disabled", file=sys.stderr)


def get_pipewire_sinks() -> List[Tuple[str, str]]:
    """Get list of available PipeWire audio sinks.
    
    Returns:
        List of tuples (node_name, description) for audio sinks
    """
    try:
        result = subprocess.run(
            ['pw-cli', 'list-objects', 'Node'],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        sinks = []
        lines = result.stdout.split('\n')
        
        current_node_name = None
        current_nick = None
        current_media_class = None
        
        for line in lines:
            line = line.strip()
            
            # Look for node.name
            if 'node.name = ' in line:
                match = re.search(r'node\.name = "([^"]+)"', line)
                if match:
                    current_node_name = match.group(1)
            
            # Look for node.nick (friendly name)
            elif 'node.nick = ' in line:
                match = re.search(r'node\.nick = "([^"]+)"', line)
                if match:
                    current_nick = match.group(1)
            
            # Look for media.class
            elif 'media.class = ' in line:
                match = re.search(r'media\.class = "([^"]+)"', line)
                if match:
                    current_media_class = match.group(1)
            
            # When we hit a new object ID, process the previous one
            elif line.startswith('id ') and current_node_name:
                # Only include Audio/Sink devices
                if current_media_class == 'Audio/Sink':
                    description = current_nick if current_nick else current_node_name
                    sinks.append((current_node_name, description))
                
                # Reset for next object
                current_node_name = None
                current_nick = None
                current_media_class = None
        
        # Process last object if it was a sink
        if current_node_name and current_media_class == 'Audio/Sink':
            description = current_nick if current_nick else current_node_name
            sinks.append((current_node_name, description))
        
        return sinks
    
    except (subprocess.TimeoutExpired, FileNotFoundError, Exception) as e:
        print(f"Warning: Could not list PipeWire sinks: {e}", file=sys.stderr)
        return []


class RadioClient:
    """WebSocket radio client for receiving and outputting audio."""
    
    def __init__(self, url: Optional[str] = None, host: Optional[str] = None,
                 port: Optional[int] = None, frequency: int = 0, mode: str = '',
                 bandwidth_low: Optional[int] = None, bandwidth_high: Optional[int] = None,
                 output_mode: str = 'pipewire', wav_file: Optional[str] = None,
                 duration: Optional[float] = None, ssl: bool = False,
                 nr2_enabled: bool = False, nr2_strength: float = 40.0,
                 nr2_floor: float = 10.0, nr2_adapt_rate: float = 1.0,
                 auto_reconnect: bool = False, status_callback=None,
                 volume: float = 1.0, channel_left: bool = True, channel_right: bool = True,
                 audio_level_callback=None, recording_callback=None, fifo_path: Optional[str] = None):
        self.url = url
        self.host = host
        self.port = port
        self.frequency = frequency
        self.mode = mode.lower()
        self.bandwidth_low = bandwidth_low
        self.bandwidth_high = bandwidth_high
        self.output_mode = output_mode
        self.wav_file = wav_file
        self.duration = duration
        self.ssl = ssl
        
        self.user_session_id = str(uuid.uuid4())
        self.running = True
        self.start_time = None
        self.sample_rate = 12000  # Default, will be updated from server
        self.ws = None  # WebSocket connection reference for sending messages
        self.server_description = {}  # Server description from /api/description
        self.countries = []  # Country list from /api/cty/countries

        # FIFO (named pipe) output
        self.fifo_path = fifo_path
        self.fifo_fd = None
        self.fifo_created_by_us = False  # Track if we created the FIFO

        # Register cleanup handler for FIFO
        if self.fifo_path:
            atexit.register(self._cleanup_fifo_on_exit)

        # Determine default channels based on mode
        # IQ modes are stereo (I and Q channels), others are mono
        if self.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384'):
            self.channels = 2
        else:
            self.channels = 1

        self.wav_writer = None
        self.pipewire_process = None

        # Auto-reconnect settings
        self.auto_reconnect = auto_reconnect
        self.retry_count = 0
        self.max_backoff = 60  # Maximum backoff time in seconds
        
        # Status callback for GUI integration
        self.status_callback = status_callback
        
        # NR2 noise reduction
        self.nr2_enabled = nr2_enabled
        self.nr2_processor = None
        if self.nr2_enabled:
            if not NR2_AVAILABLE:
                print("Error: NR2 requested but scipy not available", file=sys.stderr)
                print("Install scipy with: pip install scipy", file=sys.stderr)
                sys.exit(1)
            self.nr2_processor = create_nr2_processor(
                sample_rate=self.sample_rate,
                strength=nr2_strength,
                floor=nr2_floor,
                adapt_rate=nr2_adapt_rate
            )
            print(f"NR2 noise reduction enabled (strength={nr2_strength}%, floor={nr2_floor}%, adapt={nr2_adapt_rate}%)", file=sys.stderr)
        
        # Audio controls
        self.volume = max(0.0, min(2.0, volume))  # Clamp between 0.0 and 2.0 (0-200%)
        self.channel_left = channel_left
        self.channel_right = channel_right
        self.status_callback = status_callback
        self.audio_level_callback = audio_level_callback
        self.audio_level_update_counter = 0
        self.recording_callback = recording_callback
    
    def _log(self, message: str):
        """Log a message to stderr and optionally to status callback for GUI."""
        print(message, file=sys.stderr)
        if self.status_callback:
            self.status_callback("info", message)
    
    def build_websocket_url(self) -> str:
        """Build the WebSocket URL with query parameters."""
        # If full URL provided, parse and merge parameters
        if self.url:
            parsed = urlparse(self.url)
            base_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path or '/ws'}"
            
            # Parse existing query parameters
            existing_params = parse_qs(parsed.query)
            params = {}
            
            # Use existing params as defaults, override with our values
            for key, value in existing_params.items():
                params[key] = value[0] if isinstance(value, list) else value
            
            # Override/add our parameters
            params['frequency'] = str(self.frequency)
            params['mode'] = self.mode
            params['user_session_id'] = self.user_session_id
            
            if self.bandwidth_low is not None:
                params['bandwidthLow'] = str(self.bandwidth_low)
            if self.bandwidth_high is not None:
                params['bandwidthHigh'] = str(self.bandwidth_high)
            
            return f"{base_url}?{urlencode(params)}"
        else:
            # Build URL from host/port/ssl
            protocol = 'wss' if self.ssl else 'ws'
            url = f"{protocol}://{self.host}:{self.port}/ws"
            url += f"?frequency={self.frequency}"
            url += f"&mode={self.mode}"
            url += f"&user_session_id={self.user_session_id}"
            
            if self.bandwidth_low is not None:
                url += f"&bandwidthLow={self.bandwidth_low}"
            if self.bandwidth_high is not None:
                url += f"&bandwidthHigh={self.bandwidth_high}"
                
            return url
    
    def setup_wav_writer(self):
        """Initialize WAV file writer."""
        if self.wav_file:
            self.wav_writer = wave.open(self.wav_file, 'wb')
            self.wav_writer.setnchannels(self.channels)  # Mono or stereo
            self.wav_writer.setsampwidth(2)  # 16-bit
            self.wav_writer.setframerate(self.sample_rate)
            print(f"Recording to WAV file: {self.wav_file} ({self.channels} channel(s))", file=sys.stderr)
    
    def setup_fifo(self):
        """Create FIFO file (doesn't open it yet)."""
        if self.fifo_path is None:
            return

        try:
            # Check if path exists
            if os.path.exists(self.fifo_path):
                # Verify it's a FIFO
                if not stat.S_ISFIFO(os.stat(self.fifo_path).st_mode):
                    raise ValueError(f"{self.fifo_path} exists but is not a FIFO")
                print(f"Using existing FIFO: {self.fifo_path}", file=sys.stderr)
            else:
                # Create new FIFO
                os.mkfifo(self.fifo_path)
                self.fifo_created_by_us = True
                print(f"Created FIFO: {self.fifo_path}", file=sys.stderr)

            print(f"FIFO ready at: {self.fifo_path} (will open when reader connects)", file=sys.stderr)

        except Exception as e:
            print(f"Warning: Failed to setup FIFO: {e}", file=sys.stderr)
            self.fifo_path = None

    async def setup_pipewire(self):
        """Start PipeWire playback process."""
        try:
            # Always output as stereo to support left/right channel control
            output_channels = 2

            # Use pw-play for PipeWire audio output
            self.pipewire_process = await asyncio.create_subprocess_exec(
                'pw-play',
                '--format=s16',
                '--rate', str(self.sample_rate),
                f'--channels={output_channels}',
                '-',
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL
            )
            print(f"PipeWire output started (sample rate: {self.sample_rate} Hz, channels: {output_channels})", file=sys.stderr)
        except FileNotFoundError:
            print("Error: pw-play not found. Please install pipewire-utils.", file=sys.stderr)
            sys.exit(1)
    
    def decode_audio(self, base64_data: str) -> bytes:
        """Decode base64 audio data to PCM bytes."""
        # Decode base64
        audio_bytes = base64.b64decode(base64_data)
        
        # The data is big-endian signed 16-bit PCM
        # Convert to little-endian for most audio systems
        num_samples = len(audio_bytes) // 2
        pcm_data = bytearray()
        
        for i in range(num_samples):
            # Read big-endian int16
            high_byte = audio_bytes[i * 2]
            low_byte = audio_bytes[i * 2 + 1]
            sample = (high_byte << 8) | low_byte
            
            # Convert to signed
            if sample >= 0x8000:
                sample -= 0x10000
            
            # Write as little-endian int16
            pcm_data.extend(struct.pack('<h', sample))
        
        return bytes(pcm_data)
    
    async def output_audio(self, pcm_data: bytes):
        """Output audio data based on selected mode."""
        # Write raw PCM to FIFO FIRST (before any processing)
        # This gives the FIFO the original audio straight from the source
        if self.fifo_path is not None:
            # Try to open FIFO if not already open
            if self.fifo_fd is None:
                try:
                    # Try to open in non-blocking mode
                    self.fifo_fd = os.open(self.fifo_path, os.O_WRONLY | os.O_NONBLOCK)
                    print(f"FIFO reader connected!", file=sys.stderr)
                except (OSError, BlockingIOError):
                    # No reader yet, skip this write
                    pass

            # Write to FIFO if open
            if self.fifo_fd is not None:
                try:
                    os.write(self.fifo_fd, pcm_data)
                except (BrokenPipeError, OSError) as e:
                    # Reader disconnected or other error
                    print(f"FIFO reader disconnected", file=sys.stderr)
                    try:
                        os.close(self.fifo_fd)
                    except:
                        pass
                    self.fifo_fd = None

        # Convert PCM bytes to numpy array for processing
        audio_array = np.frombuffer(pcm_data, dtype=np.int16)

        # Reshape for stereo if needed
        if self.channels == 2:
            audio_array = audio_array.reshape(-1, 2)

        # Convert to float32 for processing
        audio_float = audio_array.astype(np.float32) / 32768.0

        # Apply NR2 noise reduction if enabled
        if self.nr2_processor:
            # Process through NR2 (expects and returns normalized float32)
            audio_float = self.nr2_processor.process(audio_float)

            # Apply -3dB makeup gain (matches UI default)
            # -3dB = 10^(-3/20) = 0.7079 gain factor
            audio_float = audio_float * 0.7079

        # Send mono audio to recording callback BEFORE stereo conversion
        # This captures the mono signal before it's duplicated to stereo
        if self.recording_callback and self.channels == 1:
            # audio_float is mono at this point
            self.recording_callback(audio_float)
        
        # Calculate audio level before volume adjustment (for meter)
        if self.audio_level_callback and self.audio_level_update_counter % 5 == 0:
            # Calculate RMS level in dB (update every 5th frame to reduce overhead)
            # Handle both mono and stereo
            if audio_float.ndim == 2:
                # Stereo: average both channels
                rms = np.sqrt(np.mean(audio_float ** 2))
            else:
                # Mono
                rms = np.sqrt(np.mean(audio_float ** 2))
            
            if rms > 1e-10:  # Avoid log of zero
                level_db = 20 * np.log10(rms)
                # Clamp to reasonable range
                level_db = max(-60, min(0, level_db))
            else:
                level_db = -60  # Minimum level
            
            self.audio_level_callback(level_db)
        self.audio_level_update_counter += 1
        
        # Apply volume control
        if self.volume != 1.0:
            audio_float = audio_float * self.volume
        
        # Convert mono to stereo for output (PipeWire always expects stereo)
        if self.channels == 1:
            # Duplicate mono to both channels
            audio_float = np.column_stack((audio_float, audio_float))
        
        # Apply channel selection (now always stereo)
        if not self.channel_left:
            audio_float[:, 0] = 0  # Mute left channel
        if not self.channel_right:
            audio_float[:, 1] = 0  # Mute right channel
        
        # Convert back to int16 and clip
        audio_array = np.clip(audio_float * 32768.0, -32768, 32767).astype(np.int16)
        pcm_data = audio_array.tobytes()
        
        if self.output_mode == 'stdout':
            # Write raw PCM to stdout
            sys.stdout.buffer.write(pcm_data)
            sys.stdout.buffer.flush()
        
        elif self.output_mode == 'pipewire':
            # Write to PipeWire process
            if self.pipewire_process and self.pipewire_process.stdin:
                try:
                    self.pipewire_process.stdin.write(pcm_data)
                    await self.pipewire_process.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    print("PipeWire connection lost", file=sys.stderr)
                    self.running = False
        
        elif self.output_mode == 'wav':
            # Write to WAV file
            if self.wav_writer:
                self.wav_writer.writeframes(pcm_data)
    
    def check_duration(self) -> bool:
        """Check if duration limit has been reached."""
        if self.duration is None:
            return True
        
        if self.start_time is None:
            self.start_time = time.time()
            return True
        
        elapsed = time.time() - self.start_time
        if elapsed >= self.duration:
            print(f"\nRecording duration reached: {elapsed:.1f}s", file=sys.stderr)
            return False
        
        return True
    
    async def handle_message(self, message: dict):
        """Handle incoming WebSocket message."""
        msg_type = message.get('type')
        
        if msg_type == 'audio':
            # Process audio data
            audio_data = message.get('data')
            sample_rate = message.get('sampleRate', self.sample_rate)
            channels = message.get('channels', self.channels)
            
            # Check if sample rate or channels changed (requires restarting PipeWire)
            sample_rate_changed = sample_rate != self.sample_rate
            channels_changed = channels != self.channels
            
            if sample_rate_changed:
                self.sample_rate = sample_rate
                print(f"Sample rate updated: {self.sample_rate} Hz", file=sys.stderr)
            
            if channels_changed:
                self.channels = channels
                print(f"Channels updated: {self.channels}", file=sys.stderr)

            # Restart PipeWire if sample rate or channels changed
            if (sample_rate_changed or channels_changed) and self.output_mode == 'pipewire' and self.pipewire_process:
                print("Restarting PipeWire with new audio configuration...", file=sys.stderr)
                if self.pipewire_process.stdin:
                    self.pipewire_process.stdin.close()
                try:
                    await asyncio.wait_for(self.pipewire_process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    self.pipewire_process.kill()
                    await self.pipewire_process.wait()
                await self.setup_pipewire()

            if audio_data:
                pcm_data = self.decode_audio(audio_data)
                await self.output_audio(pcm_data)
                
                # Check duration limit
                if not self.check_duration():
                    self.running = False
        
        elif msg_type == 'status':
            # Print status information
            session_id = message.get('sessionId', 'unknown')
            freq = message.get('frequency', 0)
            mode = message.get('mode', 'unknown')
            print(f"Status: Session {session_id}, {freq} Hz, mode {mode}", file=sys.stderr)
        
        elif msg_type == 'error':
            # Print error message
            error = message.get('error', 'Unknown error')
            print(f"Server error: {error}", file=sys.stderr)
            self.running = False
        
        elif msg_type == 'pong':
            # Keepalive response
            pass
    
    async def send_keepalive(self, websocket):
        """Send periodic keepalive messages."""
        while self.running:
            try:
                await asyncio.sleep(30)
                if self.running:
                    await websocket.send(json.dumps({'type': 'ping'}))
            except Exception as e:
                print(f"Keepalive error: {e}", file=sys.stderr)
                break
    
    async def fetch_description(self) -> dict:
        """Fetch server description from /api/description endpoint."""
        # Build HTTP URL for description
        protocol = 'https' if self.ssl else 'http'
        
        if self.url:
            # Extract host and port from WebSocket URL
            parsed = urlparse(self.url)
            host = parsed.hostname
            port = parsed.port or (443 if parsed.scheme == 'wss' else 80)
        else:
            host = self.host
            port = self.port
        
        http_url = f"{protocol}://{host}:{port}/api/description"
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    http_url,
                    headers={
                        'User-Agent': 'UberSDR Client 1.0 (python)'
                    },
                    ssl=False if not self.ssl else None
                ) as response:
                    data = await response.json()
                    return data
                    
        except Exception as e:
            print(f"Failed to fetch description: {e}", file=sys.stderr)
            return {}

    async def fetch_countries(self) -> list:
        """Fetch country list from /api/cty/countries endpoint."""
        # Build HTTP URL for countries
        protocol = 'https' if self.ssl else 'http'
        
        if self.url:
            # Extract host and port from WebSocket URL
            parsed = urlparse(self.url)
            host = parsed.hostname
            port = parsed.port or (443 if parsed.scheme == 'wss' else 80)
        else:
            host = self.host
            port = self.port
        
        http_url = f"{protocol}://{host}:{port}/api/cty/countries"
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    http_url,
                    headers={
                        'User-Agent': 'UberSDR Client 1.0 (python)'
                    },
                    ssl=False if not self.ssl else None
                ) as response:
                    data = await response.json()
                    if data.get('success') and 'data' in data:
                        return data['data'].get('countries', [])
                    return []
                    
        except Exception as e:
            print(f"Failed to fetch countries: {e}", file=sys.stderr)
            return []
    
    async def check_connection_allowed(self) -> bool:
        """Check if connection is allowed via /connection endpoint."""
        # Build HTTP URL for connection check
        protocol = 'https' if self.ssl else 'http'
        
        if self.url:
            # Extract host and port from WebSocket URL
            parsed = urlparse(self.url)
            host = parsed.hostname
            port = parsed.port or (443 if parsed.scheme == 'wss' else 80)
        else:
            host = self.host
            port = self.port
        
        http_url = f"{protocol}://{host}:{port}/connection"
        
        # Prepare request body
        request_body = {
            "user_session_id": self.user_session_id
        }
        
        self._log("Checking connection permission...")
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    http_url,
                    json=request_body,
                    headers={
                        'Content-Type': 'application/json',
                        'User-Agent': 'UberSDR Client 1.0 (python)'
                    },
                    ssl=False if not self.ssl else None
                ) as response:
                    data = await response.json()
                    
                    if not data.get('allowed', False):
                        reason = data.get('reason', 'Unknown reason')
                        self._log(f"Connection rejected: {reason}")
                        return False
                    
                    client_ip = data.get('client_ip', 'unknown')
                    self._log(f"Connection allowed (client IP: {client_ip})")
                    return True
                    
        except Exception as e:
            print(f"Connection check failed: {e}", file=sys.stderr)
            print("Attempting connection anyway...", file=sys.stderr)
            return True  # Continue on error (like the web UI does)
    
    async def run_once(self):
        """Single connection attempt."""
        # Check if connection is allowed before attempting WebSocket connection
        if not await self.check_connection_allowed():
            return 1

        # Fetch server description
        description = await self.fetch_description()
        if description:
            # Store description data for GUI access
            self.server_description = description
            receiver_name = description.get('receiver', {}).get('name', '')
            if receiver_name:
                self._log(f"Receiver: {receiver_name}")

        # Fetch country list
        countries = await self.fetch_countries()
        if countries:
            self.countries = countries
            self._log(f"Loaded {len(countries)} countries")

        url = self.build_websocket_url()
        self._log(f"Connecting to {url}")
        self._log(f"Frequency: {self.frequency} Hz, Mode: {self.mode}")
        
        if self.bandwidth_low is not None and self.bandwidth_high is not None:
            self._log(f"Bandwidth: {self.bandwidth_low} to {self.bandwidth_high} Hz")
        
        try:
            async with websockets.connect(
                url,
                ping_interval=None,
                extra_headers={'User-Agent': 'UberSDR Client 1.0 (python)'}
            ) as websocket:
                # Store websocket reference for GUI access
                self.ws = websocket
                self._log("Connected!")

                # Reset retry count on successful connection
                self.retry_count = 0

                # Setup FIFO if configured (independent of output mode)
                self.setup_fifo()

                # Setup output based on mode
                if self.output_mode == 'pipewire':
                    await self.setup_pipewire()
                elif self.output_mode == 'wav':
                    self.setup_wav_writer()
                
                # Start keepalive task
                keepalive_task = asyncio.create_task(self.send_keepalive(websocket))
                
                # Receive and process messages
                while self.running:
                    try:
                        message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                        data = json.loads(message)
                        await self.handle_message(data)
                    except asyncio.TimeoutError:
                        continue
                    except websockets.exceptions.ConnectionClosed:
                        print("Connection closed by server", file=sys.stderr)
                        break
                
                # Cancel keepalive
                keepalive_task.cancel()
                try:
                    await keepalive_task
                except asyncio.CancelledError:
                    pass
                
        except Exception as e:
            print(f"Connection error: {e}", file=sys.stderr)
            return 1
        finally:
            # Clear websocket reference
            self.ws = None
            await self.cleanup()
        
        return 0

    def calculate_backoff(self) -> float:
        """Calculate exponential backoff time with max limit."""
        # Exponential backoff: 2^retry_count seconds, capped at max_backoff
        backoff = min(2 ** self.retry_count, self.max_backoff)
        return backoff

    async def run(self):
        """Main client loop with auto-reconnect support."""
        while self.running:
            exit_code = await self.run_once()

            # If not auto-reconnecting or clean exit, stop
            if not self.auto_reconnect or exit_code == 0:
                return exit_code

            # If user interrupted, stop
            if not self.running:
                return 0

            # Calculate backoff time
            self.retry_count += 1
            backoff = self.calculate_backoff()

            print(f"\nReconnecting in {backoff:.0f}s (attempt {self.retry_count})...", file=sys.stderr)

            # Wait with ability to interrupt
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                print("Reconnect cancelled", file=sys.stderr)
                return 1

        return 0
    
    def _cleanup_fifo_on_exit(self):
        """Cleanup FIFO on exit (called by atexit)."""
        if self.fifo_fd is not None:
            try:
                os.close(self.fifo_fd)
            except:
                pass
            self.fifo_fd = None

        # Remove FIFO file only if we created it
        if self.fifo_path and self.fifo_created_by_us and os.path.exists(self.fifo_path):
            try:
                os.unlink(self.fifo_path)
            except:
                pass

    async def cleanup(self):
        """Clean up resources."""
        print("\nCleaning up...", file=sys.stderr)

        # Close FIFO
        if self.fifo_fd is not None:
            try:
                os.close(self.fifo_fd)
                print(f"FIFO closed: {self.fifo_path}", file=sys.stderr)
            except Exception as e:
                print(f"Error closing FIFO: {e}", file=sys.stderr)
            self.fifo_fd = None

            # Remove FIFO file only if we created it
            if self.fifo_path and self.fifo_created_by_us and os.path.exists(self.fifo_path):
                try:
                    os.unlink(self.fifo_path)
                    print(f"FIFO removed: {self.fifo_path}", file=sys.stderr)
                except Exception as e:
                    print(f"Error removing FIFO: {e}", file=sys.stderr)

        # Close WAV file
        if self.wav_writer:
            self.wav_writer.close()
            print(f"WAV file closed: {self.wav_file}", file=sys.stderr)

        # Close PipeWire process
        if self.pipewire_process:
            if self.pipewire_process.stdin:
                self.pipewire_process.stdin.close()
            try:
                await asyncio.wait_for(self.pipewire_process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                self.pipewire_process.kill()
                await self.pipewire_process.wait()


def parse_bandwidth(value: str) -> tuple[int, int]:
    """Parse bandwidth argument in format 'low:high'."""
    try:
        low, high = value.split(':')
        return int(low), int(high)
    except ValueError:
        raise argparse.ArgumentTypeError(
            "Bandwidth must be in format 'low:high' (e.g., '-5000:5000')"
        )


def main():
    parser = argparse.ArgumentParser(
        description='CLI Radio Client for ka9q_ubersdr',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Listen to 14.074 MHz USB via PipeWire
  %(prog)s -f 14074000 -m usb

  # Launch GUI interface
  %(prog)s --gui -f 14074000 -m usb

  # Connect using full URL
  %(prog)s -u ws://radio.example.com:8073/ws -f 14074000 -m usb

  # Record 1000 kHz AM to WAV file for 60 seconds
  %(prog)s -f 1000000 -m am -o wav -w recording.wav -t 60

  # Output raw PCM to stdout with custom bandwidth
  %(prog)s -f 7100000 -m lsb -b -2700:-50 -o stdout > audio.pcm
        """
    )
    
    parser.add_argument('--gui', action='store_true',
                        help='Launch graphical user interface (Linux only, requires Tkinter)')
    parser.add_argument('-u', '--url',
                        help='Full WebSocket URL (e.g., ws://host:port/ws or wss://host/ws)')
    parser.add_argument('-H', '--host', default='localhost',
                        help='Server hostname (default: localhost, ignored if --url is provided)')
    parser.add_argument('-p', '--port', type=int, default=8080,
                        help='Server port (default: 8080, ignored if --url is provided)')
    parser.add_argument('-f', '--frequency', type=int,
                        help='Frequency in Hz (e.g., 14074000 for 14.074 MHz)')
    parser.add_argument('-m', '--mode',
                        choices=['am', 'sam', 'usb', 'lsb', 'fm', 'nfm', 'cwu', 'cwl', 'iq', 'iq48', 'iq96', 'iq192', 'iq384'],
                        help='Demodulation mode (iq48/iq96/iq192/iq384 require bypassed IP)')
    parser.add_argument('-b', '--bandwidth', type=parse_bandwidth,
                        help='Bandwidth in format low:high (e.g., -5000:5000)')
    parser.add_argument('-o', '--output', choices=['pipewire', 'stdout', 'wav'],
                        default='pipewire',
                        help='Output mode (default: pipewire)')
    parser.add_argument('-w', '--wav-file', metavar='FILE',
                        help='WAV file path (required when output=wav)')
    parser.add_argument('-t', '--time', type=float, metavar='SECONDS',
                        help='Recording duration in seconds (for WAV output)')
    parser.add_argument('-s', '--ssl', action='store_true',
                        help='Use WSS (WebSocket Secure, ignored if --url is provided)')
    parser.add_argument('--nr2', action='store_true',
                        help='Enable NR2 spectral subtraction noise reduction')
    parser.add_argument('--nr2-strength', type=float, default=40.0, metavar='PERCENT',
                        help='NR2 noise reduction strength, 0-100%% (default: 40)')
    parser.add_argument('--nr2-floor', type=float, default=10.0, metavar='PERCENT',
                        help='NR2 spectral floor to prevent musical noise, 0-10%% (default: 10)')
    parser.add_argument('--nr2-adapt-rate', type=float, default=1.0, metavar='PERCENT',
                        help='NR2 noise profile adaptation rate, 0.1-5.0%% (default: 1)')
    parser.add_argument('--auto-reconnect', action='store_true',
                        help='Automatically reconnect on connection loss with exponential backoff (max 60s)')
    
    parser.add_argument('--pipewire-target', type=str, default=None,
                        help='PipeWire target device (node name). Use --list-devices to see available devices.')
    parser.add_argument('--list-devices', action='store_true',
                        help='List available PipeWire audio output devices and exit')
    parser.add_argument('--fifo-path', type=str, metavar='PATH',
                        help='Also write audio to named pipe (FIFO) at this path (non-blocking, works with any output mode)')
    
    args = parser.parse_args()
    
    # List devices mode
    if args.list_devices:
        print("Available PipeWire audio output devices:")
        print()
        sinks = get_pipewire_sinks()
        if sinks:
            for node_name, description in sinks:
                print(f"  {node_name}")
                print(f"    Description: {description}")
                print()
        else:
            print("  No devices found or pw-cli not available")
        sys.exit(0)
    
    # Parse bandwidth early for GUI
    bandwidth_low = None
    bandwidth_high = None
    if args.bandwidth:
        bandwidth_low, bandwidth_high = args.bandwidth
    
    # Launch GUI if requested
    if args.gui:
        try:
            from radio_gui import main as gui_main
            # Determine if we should auto-connect
            # Auto-connect if --url is provided, or if --host/--port were explicitly set (not defaults)
            auto_connect = False
            if args.url:
                # URL was explicitly provided
                auto_connect = True
            else:
                # Check if host or port were explicitly provided (not using defaults)
                # We detect this by checking if they differ from the defaults
                import sys
                # Parse command line to see if --host or --port were actually specified
                if '--host' in sys.argv or '-H' in sys.argv or '--port' in sys.argv or '-p' in sys.argv:
                    auto_connect = True

            # Pass configuration to GUI
            config = {
                'url': args.url,
                'host': args.host,
                'port': args.port,
                'ssl': args.ssl,
                'frequency': args.frequency if args.frequency else 14074000,
                'mode': args.mode if args.mode else 'usb',
                'bandwidth_low': bandwidth_low if bandwidth_low is not None else 50,
                'bandwidth_high': bandwidth_high if bandwidth_high is not None else 2700,
                'auto_connect': auto_connect
            }
            gui_main(config)
            return
        except ImportError as e:
            print(f"Error: Failed to import GUI module: {e}", file=sys.stderr)
            print("Make sure Tkinter is installed (usually included with Python)", file=sys.stderr)
            sys.exit(1)

    # Validate arguments for CLI mode
    if not args.frequency:
        parser.error("--frequency is required (unless using --gui)")
    if not args.mode:
        parser.error("--mode is required (unless using --gui)")

    if args.output == 'wav' and not args.wav_file:
        parser.error("--wav-file is required when output mode is 'wav'")

    if args.time and args.output != 'wav':
        parser.error("--time can only be used with output mode 'wav'")

    # Validate NR2 parameters
    if args.nr2_strength < 0 or args.nr2_strength > 100:
        parser.error("--nr2-strength must be between 0 and 100")
    if args.nr2_floor < 0 or args.nr2_floor > 10:
        parser.error("--nr2-floor must be between 0 and 10")
    if args.nr2_adapt_rate < 0.1 or args.nr2_adapt_rate > 5.0:
        parser.error("--nr2-adapt-rate must be between 0.1 and 5.0")
    
    # Validate URL vs host/port
    if args.url:
        # Parse URL to validate it
        try:
            parsed = urlparse(args.url)
            if parsed.scheme not in ('ws', 'wss'):
                parser.error("URL must use ws:// or wss:// scheme")
        except Exception as e:
            parser.error(f"Invalid URL: {e}")
    
    # Create client
    client = RadioClient(
        url=args.url,
        host=args.host,
        port=args.port,
        frequency=args.frequency,
        mode=args.mode,
        bandwidth_low=bandwidth_low,
        bandwidth_high=bandwidth_high,
        output_mode=args.output,
        wav_file=args.wav_file,
        duration=args.time,
        ssl=args.ssl,
        nr2_enabled=args.nr2,
        nr2_strength=args.nr2_strength,
        nr2_floor=args.nr2_floor,
        nr2_adapt_rate=args.nr2_adapt_rate,
        auto_reconnect=args.auto_reconnect,
        fifo_path=args.fifo_path
    )
    
    # Setup signal handler for graceful shutdown
    def signal_handler(sig, frame):
        print("\nInterrupted, shutting down...", file=sys.stderr)
        client.running = False
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Run client
    try:
        exit_code = asyncio.run(client.run())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\nInterrupted", file=sys.stderr)
        sys.exit(0)


if __name__ == '__main__':
    main()