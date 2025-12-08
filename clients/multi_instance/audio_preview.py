#!/usr/bin/env python3
"""
Audio Preview Manager for Multi-Instance Client
Handles audio streaming from up to 2 instances with left/right channel routing
"""

import asyncio
import base64
import json
import struct
import threading
import time
import uuid
from typing import Optional
import numpy as np

# Import timestamp synchronization
try:
    from timestamp_sync import AudioAligner, SyncQualityMetrics
    TIMESTAMP_SYNC_AVAILABLE = True
except ImportError:
    TIMESTAMP_SYNC_AVAILABLE = False
    print("Warning: timestamp_sync module not available, synchronization disabled")

try:
    import sounddevice as sd
    SOUNDDEVICE_AVAILABLE = True
except ImportError:
    SOUNDDEVICE_AVAILABLE = False

try:
    import websockets
    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False


class AudioChannel:
    """Represents a single audio channel (left or right)."""
    
    def __init__(self, channel_name: str):
        self.channel_name = channel_name
        self.ws = None
        self.running = False
        self.buffer = []
        self.instance_id = None
        self.host = None
        self.port = None
        self.tls = False
        self.frequency = 14100000
        self.mode = 'usb'
        self.bandwidth = 2700  # Bandwidth in Hz
        self.task = None
        self.user_session_id = None  # Will be set from instance's session ID
        self.volume = 1.0  # Volume multiplier (0.0 to 1.0)
        self.mono = False  # If True, output to both speakers
        
    def is_active(self) -> bool:
        """Check if channel is actively streaming."""
        return self.running and self.ws is not None


class AudioPreviewManager:
    """Manages audio preview from up to 2 instances with left/right routing."""
    
    def __init__(self, sample_rate=12000):
        self.sample_rate = sample_rate
        self.output_stream = None
        self.left_channel = AudioChannel("left")
        self.right_channel = AudioChannel("right")
        self.buffer_lock = threading.Lock()
        self.event_loop = None
        self.loop_thread = None
        self.is_running = False
        
        # Timestamp synchronization - DISABLED due to audio quality issues
        self.use_timestamp_sync = False
        self.audio_aligner = None
        
        # Original code (disabled):
        # self.use_timestamp_sync = TIMESTAMP_SYNC_AVAILABLE
        # if self.use_timestamp_sync:
        #     self.audio_aligner = AudioAligner(
        #         buffer_size_ms=150,
        #         alignment_tolerance_ms=50,
        #         interpolation_enabled=True
        #     )
        #     print("Audio timestamp synchronization enabled")
        # else:
        #     self.audio_aligner = None
        
    def start_output_stream(self) -> bool:
        """Start the audio output stream."""
        if not SOUNDDEVICE_AVAILABLE:
            print("Error: sounddevice not available")
            return False
        
        if self.output_stream is not None:
            return True  # Already running
        
        try:
            self.output_stream = sd.OutputStream(
                samplerate=self.sample_rate,
                channels=2,  # Stereo
                dtype='int16',
                blocksize=1024,
                latency='low',
                callback=self._audio_callback
            )
            self.output_stream.start()
            print(f"Audio output stream started: {self.sample_rate} Hz, stereo")
            return True
        except Exception as e:
            print(f"Error starting audio output: {e}")
            return False
    
    def stop_output_stream(self):
        """Stop the audio output stream."""
        if self.output_stream:
            try:
                self.output_stream.stop()
                self.output_stream.close()
                print("Audio output stream stopped")
            except Exception as e:
                print(f"Error stopping audio output: {e}")
            finally:
                self.output_stream = None
    
    def _audio_callback(self, outdata, frames, time_info, status):
        """Sounddevice callback - mix left and right channels."""
        if status:
            print(f"Audio callback status: {status}")
        
        # Use timestamp-based alignment if available
        if self.use_timestamp_sync and self.audio_aligner:
            try:
                # Calculate target timestamp (current time - buffer delay)
                target_ts = time.time() * 1000 - 100  # 100ms buffer delay
                
                # Get aligned samples from both channels
                instance_ids = []
                if self.left_channel.is_active():
                    instance_ids.append(self.left_channel.instance_id)
                if self.right_channel.is_active():
                    instance_ids.append(self.right_channel.instance_id)
                
                if instance_ids:
                    aligned = self.audio_aligner.get_aligned_samples(target_ts, frames, instance_ids)
                    
                    if aligned:
                        left_samples = aligned.get(self.left_channel.instance_id, np.zeros(frames, dtype=np.int16))
                        right_samples = aligned.get(self.right_channel.instance_id, np.zeros(frames, dtype=np.int16))
                    else:
                        # No aligned data available, fall back to legacy mode
                        with self.buffer_lock:
                            left_samples = self._get_samples(self.left_channel.buffer, frames)
                            right_samples = self._get_samples(self.right_channel.buffer, frames)
                else:
                    left_samples = np.zeros(frames, dtype=np.int16)
                    right_samples = np.zeros(frames, dtype=np.int16)
            except Exception as e:
                # If sync fails, fall back to legacy mode
                with self.buffer_lock:
                    left_samples = self._get_samples(self.left_channel.buffer, frames)
                    right_samples = self._get_samples(self.right_channel.buffer, frames)
        else:
            # Legacy mode: use direct buffer access (no timestamp sync)
            with self.buffer_lock:
                left_samples = self._get_samples(self.left_channel.buffer, frames)
                right_samples = self._get_samples(self.right_channel.buffer, frames)
        
        # Apply volume control
        left_samples = (left_samples * self.left_channel.volume).astype(np.int16)
        right_samples = (right_samples * self.right_channel.volume).astype(np.int16)
        
        # Handle mono mode independently for each channel
        # Start with normal stereo routing
        left_output = left_samples
        right_output = right_samples
        
        # If left channel is in mono, add it to right output
        if self.left_channel.mono:
            right_output = ((right_output.astype(np.int32) + left_samples.astype(np.int32)) // 2).astype(np.int16)
        
        # If right channel is in mono, add it to left output
        if self.right_channel.mono:
            left_output = ((left_output.astype(np.int32) + right_samples.astype(np.int32)) // 2).astype(np.int16)
        
        # Output final mixed audio
        outdata[:, 0] = left_output
        outdata[:, 1] = right_output
    
    def _get_samples(self, buffer, frames) -> np.ndarray:
        """Extract samples from buffer, pad with zeros if needed."""
        if len(buffer) >= frames:
            samples = np.array(buffer[:frames], dtype=np.int16)
            del buffer[:frames]
        else:
            # Not enough samples, pad with zeros
            samples = np.zeros(frames, dtype=np.int16)
            if buffer:
                samples[:len(buffer)] = buffer
                buffer.clear()
        return samples
    
    def start_preview(self, channel: str, instance_id: int, host: str, port: int,
                     tls: bool, frequency: int, mode: str, user_session_id: str,
                     bandwidth: int = 2700) -> bool:
        """Start audio preview for a channel.
        
        Args:
            channel: 'left' or 'right'
            instance_id: Instance ID for tracking
            host: Server hostname
            port: Server port
            tls: Use TLS/SSL
            frequency: Frequency in Hz
            mode: Demodulation mode (usb, lsb, cwu, cwl, am, fm, etc.)
            user_session_id: Session ID from the spectrum instance
            bandwidth: Bandwidth in Hz (default: 2700)
        
        Returns:
            True if started successfully
        """
        if not SOUNDDEVICE_AVAILABLE or not WEBSOCKETS_AVAILABLE:
            print("Error: Required libraries not available")
            return False
        
        # Get the channel object
        ch = self.left_channel if channel == 'left' else self.right_channel
        
        # Stop existing preview on this channel
        if ch.is_active():
            self.stop_preview(channel)
        
        # Store connection info
        ch.instance_id = instance_id
        ch.host = host
        ch.port = port
        ch.tls = tls
        ch.frequency = frequency
        ch.mode = mode
        ch.user_session_id = user_session_id  # Use instance's session ID
        ch.bandwidth = bandwidth  # Store bandwidth for reconnection
        
        # Start event loop if not running
        if not self.is_running:
            self._start_event_loop()
        
        # Start output stream if not running
        if not self.start_output_stream():
            return False
        
        # Start WebSocket connection in event loop
        if self.event_loop:
            asyncio.run_coroutine_threadsafe(
                self._connect_channel(ch),
                self.event_loop
            )
            return True
        
        return False
    
    def stop_preview(self, channel: str):
        """Stop audio preview for a channel.
        
        Args:
            channel: 'left' or 'right'
        """
        ch = self.left_channel if channel == 'left' else self.right_channel
        
        if ch.is_active():
            ch.running = False
            if self.event_loop and ch.task:
                asyncio.run_coroutine_threadsafe(
                    self._disconnect_channel(ch),
                    self.event_loop
                )
        
        # Clear buffer
        with self.buffer_lock:
            ch.buffer.clear()
        
        # Stop output stream if both channels are inactive
        if not self.left_channel.is_active() and not self.right_channel.is_active():
            self.stop_output_stream()
    
    def stop_all(self):
        """Stop all audio preview."""
        self.stop_preview('left')
        self.stop_preview('right')
        self._stop_event_loop()
    
    def _start_event_loop(self):
        """Start the asyncio event loop in a separate thread."""
        if self.is_running:
            return
        
        def run_loop():
            self.event_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.event_loop)
            self.event_loop.run_forever()
        
        self.loop_thread = threading.Thread(target=run_loop, daemon=True)
        self.loop_thread.start()
        self.is_running = True
        print("Audio event loop started")
    
    def _stop_event_loop(self):
        """Stop the asyncio event loop."""
        if self.event_loop and self.is_running:
            self.event_loop.call_soon_threadsafe(self.event_loop.stop)
            if self.loop_thread:
                self.loop_thread.join(timeout=2.0)
            self.is_running = False
            print("Audio event loop stopped")
    
    def _calculate_bandwidth_edges(self, mode: str, bandwidth: int) -> tuple:
        """Calculate bandwidth edges based on mode.
        
        Args:
            mode: Demodulation mode
            bandwidth: Bandwidth in Hz
            
        Returns:
            Tuple of (bandwidth_low, bandwidth_high)
        """
        if mode == 'usb':
            # Upper sideband: 0 to +bandwidth
            bandwidth_low = 0
            bandwidth_high = bandwidth
        elif mode == 'lsb':
            # Lower sideband: -bandwidth to 0
            bandwidth_low = -bandwidth
            bandwidth_high = 0
        elif mode == 'cwu':
            # CW upper: 0 to +bandwidth
            bandwidth_low = 0
            bandwidth_high = bandwidth
        elif mode == 'cwl':
            # CW lower: -bandwidth to 0
            bandwidth_low = -bandwidth
            bandwidth_high = 0
        elif mode == 'am':
            # AM: symmetric around carrier
            bandwidth_low = -bandwidth // 2
            bandwidth_high = bandwidth // 2
        elif mode == 'fm':
            # FM: symmetric around carrier
            bandwidth_low = -bandwidth // 2
            bandwidth_high = bandwidth // 2
        else:
            # Default: symmetric
            bandwidth_low = -bandwidth // 2
            bandwidth_high = bandwidth // 2
        
        return bandwidth_low, bandwidth_high
    
    async def _connect_channel(self, ch: AudioChannel):
        """Connect WebSocket for a channel and start receiving audio."""
        protocol = 'wss' if ch.tls else 'ws'
        
        # Build WebSocket URL with audio parameters
        url = f"{protocol}://{ch.host}:{ch.port}/ws"
        url += f"?frequency={ch.frequency}"
        url += f"&mode={ch.mode}"
        url += f"&user_session_id={ch.user_session_id}"  # Add session ID for authentication
        
        # Calculate bandwidth based on mode and bandwidth setting
        bandwidth_low, bandwidth_high = self._calculate_bandwidth_edges(ch.mode, ch.bandwidth)
        url += f"&bandwidthLow={bandwidth_low}&bandwidthHigh={bandwidth_high}"
        
        print(f"Connecting {ch.channel_name} channel to {url}")
        
        try:
            async with websockets.connect(url, ping_interval=None) as websocket:
                ch.ws = websocket
                ch.running = True
                print(f"{ch.channel_name.capitalize()} channel connected")
                
                # Receive and process audio messages
                while ch.running:
                    try:
                        message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                        data = json.loads(message)
                        
                        if data.get('type') == 'audio':
                            audio_data = data.get('data')
                            timestamp = data.get('timestamp')  # Extract timestamp
                            
                            if audio_data:
                                pcm_data = self._decode_audio(audio_data)
                                # Convert to int16 array
                                audio_array = np.frombuffer(pcm_data, dtype=np.int16)
                                
                                # Always add to legacy buffer as fallback
                                with self.buffer_lock:
                                    ch.buffer.extend(audio_array.tolist())
                                    # Limit buffer size to prevent memory issues
                                    if len(ch.buffer) > self.sample_rate * 2:  # 2 seconds max
                                        ch.buffer = ch.buffer[-self.sample_rate:]
                                
                                # Also add to timestamp sync if available
                                if self.use_timestamp_sync and self.audio_aligner and timestamp:
                                    try:
                                        self.audio_aligner.add_data(ch.instance_id, timestamp, audio_array)
                                    except Exception as e:
                                        # Don't let sync errors stop audio
                                        pass
                        
                        elif data.get('type') == 'error':
                            error = data.get('error', 'Unknown error')
                            print(f"{ch.channel_name.capitalize()} channel error: {error}")
                            break
                    
                    except asyncio.TimeoutError:
                        continue
                    except websockets.exceptions.ConnectionClosed:
                        print(f"{ch.channel_name.capitalize()} channel connection closed")
                        break
        
        except Exception as e:
            print(f"Error connecting {ch.channel_name} channel: {e}")
        
        finally:
            ch.ws = None
            ch.running = False
            print(f"{ch.channel_name.capitalize()} channel disconnected")
    
    async def _send_tune_command(self, ch: AudioChannel, frequency: int, mode: str, bandwidth: int):
        """Send tune command to change parameters without reconnecting.
        
        Args:
            ch: Audio channel
            frequency: New frequency in Hz
            mode: New mode
            bandwidth: New bandwidth in Hz
        """
        if not ch.ws or not ch.running:
            return
        
        # Calculate bandwidth edges based on mode
        bandwidth_low, bandwidth_high = self._calculate_bandwidth_edges(mode, bandwidth)
        
        tune_msg = {
            'type': 'tune',
            'frequency': frequency,
            'mode': mode,
            'bandwidthLow': bandwidth_low,
            'bandwidthHigh': bandwidth_high
        }
        
        try:
            await ch.ws.send(json.dumps(tune_msg))
            print(f"Sent tune command to {ch.channel_name} channel: {frequency/1e6:.6f} MHz, {mode}, {bandwidth_low}-{bandwidth_high} Hz")
        except Exception as e:
            print(f"Error sending tune command to {ch.channel_name} channel: {e}")
    
    async def _disconnect_channel(self, ch: AudioChannel):
        """Disconnect WebSocket for a channel."""
        if ch.ws:
            try:
                await ch.ws.close()
            except Exception as e:
                print(f"Error closing {ch.channel_name} channel: {e}")
        ch.ws = None
        ch.running = False
    
    def _decode_audio(self, base64_data: str) -> bytes:
        """Decode base64 audio data to PCM bytes.
        
        Args:
            base64_data: Base64-encoded audio data
        
        Returns:
            PCM bytes (little-endian int16)
        """
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
    
    def update_frequency(self, channel: str, frequency: int):
        """Update frequency for a channel without reconnecting."""
        ch = self.left_channel if channel == 'left' else self.right_channel
        
        if ch.is_active():
            # Store new frequency
            old_freq = ch.frequency
            ch.frequency = frequency
            
            # Send tune command over existing WebSocket
            if self.event_loop:
                asyncio.run_coroutine_threadsafe(
                    self._send_tune_command(ch, ch.frequency, ch.mode, ch.bandwidth),
                    self.event_loop
                )
            print(f"Updated {channel} channel frequency: {old_freq/1e6:.6f} → {frequency/1e6:.6f} MHz")
    
    def update_mode(self, channel: str, mode: str):
        """Update mode for a channel without reconnecting."""
        ch = self.left_channel if channel == 'left' else self.right_channel
        
        if ch.is_active():
            # Store new mode
            ch.mode = mode
            
            # Send tune command over existing WebSocket
            if self.event_loop:
                asyncio.run_coroutine_threadsafe(
                    self._send_tune_command(ch, ch.frequency, ch.mode, ch.bandwidth),
                    self.event_loop
                )
            print(f"Updated {channel} channel mode: {mode}")
    
    def update_bandwidth(self, channel: str, bandwidth: int):
        """Update bandwidth for a channel without reconnecting."""
        ch = self.left_channel if channel == 'left' else self.right_channel
        
        if ch.is_active():
            # Store new bandwidth
            ch.bandwidth = bandwidth
            
            # Send tune command over existing WebSocket
            if self.event_loop:
                asyncio.run_coroutine_threadsafe(
                    self._send_tune_command(ch, ch.frequency, ch.mode, ch.bandwidth),
                    self.event_loop
                )
            print(f"Updated {channel} channel bandwidth: {bandwidth} Hz")
    
    def set_volume(self, channel: str, volume: float):
        """Set volume for a channel.
        
        Args:
            channel: 'left' or 'right'
            volume: Volume level (0.0 to 1.0)
        """
        ch = self.left_channel if channel == 'left' else self.right_channel
        ch.volume = max(0.0, min(1.0, volume))  # Clamp to 0.0-1.0
    
    def set_mono(self, channel: str, mono: bool):
        """Set mono mode for a channel.
        
        Args:
            channel: 'left' or 'right'
            mono: If True, output to both speakers
        """
        ch = self.left_channel if channel == 'left' else self.right_channel
        ch.mono = mono
    
    def get_sync_metrics(self) -> Optional[SyncQualityMetrics]:
        """
        Get synchronization quality metrics.
        
        Returns:
            SyncQualityMetrics object or None if sync not available
        """
        if self.use_timestamp_sync and self.audio_aligner:
            return self.audio_aligner.get_metrics()
        return None