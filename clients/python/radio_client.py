#!/usr/bin/env python3
"""
CLI Radio Client for ka9q_ubersdr
Connects to the WebSocket server and outputs audio to PipeWire, stdout, or WAV file.
"""

import argparse
import asyncio
import base64
import json
import signal
import struct
import sys
import time
import uuid
import wave
from typing import Optional

import aiohttp
import websockets
from urllib.parse import urlparse, parse_qs, urlencode
import numpy as np

# Import NR2 processor (optional, only if scipy is available)
try:
    from nr2 import create_nr2_processor
    NR2_AVAILABLE = True
except ImportError:
    NR2_AVAILABLE = False
    print("Warning: scipy not available, NR2 noise reduction disabled", file=sys.stderr)


class RadioClient:
    """WebSocket radio client for receiving and outputting audio."""
    
    def __init__(self, url: Optional[str] = None, host: Optional[str] = None,
                 port: Optional[int] = None, frequency: int = 0, mode: str = '',
                 bandwidth_low: Optional[int] = None, bandwidth_high: Optional[int] = None,
                 output_mode: str = 'pipewire', wav_file: Optional[str] = None,
                 duration: Optional[float] = None, ssl: bool = False,
                 nr2_enabled: bool = False, nr2_strength: float = 40.0,
                 nr2_floor: float = 10.0, nr2_adapt_rate: float = 1.0):
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
        self.channels = 1  # Default mono, will be updated from server
        self.wav_writer = None
        self.pipewire_process = None
        
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
    
    async def setup_pipewire(self):
        """Start PipeWire playback process."""
        try:
            # Use pw-play for PipeWire audio output
            self.pipewire_process = await asyncio.create_subprocess_exec(
                'pw-play',
                '--format=s16',
                '--rate', str(self.sample_rate),
                f'--channels={self.channels}',
                '-',
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL
            )
            print(f"PipeWire output started (sample rate: {self.sample_rate} Hz, channels: {self.channels})", file=sys.stderr)
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
        # Apply NR2 noise reduction if enabled
        if self.nr2_processor:
            # Convert PCM bytes to numpy array (int16)
            audio_array = np.frombuffer(pcm_data, dtype=np.int16)
            
            # Normalize to float32 range [-1.0, 1.0] for processing
            audio_float = audio_array.astype(np.float32) / 32768.0
            
            # Process through NR2 (expects and returns normalized float32)
            processed_audio = self.nr2_processor.process(audio_float)
            
            # Apply -3dB makeup gain (matches UI default)
            # -3dB = 10^(-3/20) = 0.7079 gain factor
            processed_audio = processed_audio * 0.7079
            
            # Convert back to int16 range and clip
            processed_audio = np.clip(processed_audio * 32768.0, -32768, 32767).astype(np.int16)
            pcm_data = processed_audio.tobytes()
        
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
            
            # Update sample rate if changed
            if sample_rate != self.sample_rate:
                self.sample_rate = sample_rate
                print(f"Sample rate updated: {self.sample_rate} Hz", file=sys.stderr)
            
            # Update channels if changed (requires restarting PipeWire)
            if channels != self.channels:
                self.channels = channels
                print(f"Channels updated: {self.channels}", file=sys.stderr)

                # Restart PipeWire with new channel count if active
                if self.output_mode == 'pipewire' and self.pipewire_process:
                    print("Restarting PipeWire with new channel configuration...", file=sys.stderr)
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
        
        print(f"Checking connection permission...", file=sys.stderr)
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    http_url,
                    json=request_body,
                    headers={'Content-Type': 'application/json'},
                    ssl=False if not self.ssl else None
                ) as response:
                    data = await response.json()
                    
                    if not data.get('allowed', False):
                        reason = data.get('reason', 'Unknown reason')
                        print(f"Connection rejected: {reason}", file=sys.stderr)
                        return False
                    
                    client_ip = data.get('client_ip', 'unknown')
                    print(f"Connection allowed (client IP: {client_ip})", file=sys.stderr)
                    return True
                    
        except Exception as e:
            print(f"Connection check failed: {e}", file=sys.stderr)
            print("Attempting connection anyway...", file=sys.stderr)
            return True  # Continue on error (like the web UI does)
    
    async def run(self):
        """Main client loop."""
        # Check if connection is allowed before attempting WebSocket connection
        if not await self.check_connection_allowed():
            return 1
        
        url = self.build_websocket_url()
        print(f"Connecting to {url}", file=sys.stderr)
        print(f"Frequency: {self.frequency} Hz, Mode: {self.mode}", file=sys.stderr)
        
        if self.bandwidth_low is not None and self.bandwidth_high is not None:
            print(f"Bandwidth: {self.bandwidth_low} to {self.bandwidth_high} Hz", file=sys.stderr)
        
        try:
            async with websockets.connect(url, ping_interval=None) as websocket:
                print("Connected!", file=sys.stderr)
                
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
            await self.cleanup()
        
        return 0
    
    async def cleanup(self):
        """Clean up resources."""
        print("\nCleaning up...", file=sys.stderr)
        
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
  
  # Connect using full URL
  %(prog)s -u ws://radio.example.com:8073/ws -f 14074000 -m usb
  
  # Record 1000 kHz AM to WAV file for 60 seconds
  %(prog)s -f 1000000 -m am -o wav -w recording.wav -t 60
  
  # Output raw PCM to stdout with custom bandwidth
  %(prog)s -f 7100000 -m lsb -b -2700:-50 -o stdout > audio.pcm
        """
    )
    
    parser.add_argument('-u', '--url',
                        help='Full WebSocket URL (e.g., ws://host:port/ws or wss://host/ws)')
    parser.add_argument('-H', '--host', default='localhost',
                        help='Server hostname (default: localhost, ignored if --url is provided)')
    parser.add_argument('-p', '--port', type=int, default=8080,
                        help='Server port (default: 8080, ignored if --url is provided)')
    parser.add_argument('-f', '--frequency', type=int, required=True,
                        help='Frequency in Hz (e.g., 14074000 for 14.074 MHz)')
    parser.add_argument('-m', '--mode', required=True,
                        choices=['am', 'sam', 'usb', 'lsb', 'fm', 'nfm', 'cwu', 'cwl', 'iq'],
                        help='Demodulation mode')
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
    
    args = parser.parse_args()
    
    # Validate arguments
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
    
    # Parse bandwidth
    bandwidth_low = None
    bandwidth_high = None
    if args.bandwidth:
        bandwidth_low, bandwidth_high = args.bandwidth
    
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
        nr2_adapt_rate=args.nr2_adapt_rate
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