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

# Import real-time alignment system
try:
    from realtime_alignment import ContinuousAlignmentThread, RealtimeAlignmentMetrics
    REALTIME_ALIGNMENT_AVAILABLE = True
except ImportError:
    REALTIME_ALIGNMENT_AVAILABLE = False
    print("Warning: realtime_alignment module not available, using legacy mode")

# Import timestamp synchronization (for metrics only)
try:
    from timestamp_sync import AudioAligner, SyncQualityMetrics
    TIMESTAMP_SYNC_AVAILABLE = True
except ImportError:
    TIMESTAMP_SYNC_AVAILABLE = False

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
        self.prebuffering = True  # Start in prebuffering mode
        
    def is_active(self) -> bool:
        """Check if channel is actively streaming."""
        return self.running and self.ws is not None


class AudioPreviewManager:
    """Manages audio preview from up to 2 instances with left/right routing."""
    
    def __init__(self, sample_rate=12000, use_realtime_alignment=False):
        self.sample_rate = sample_rate
        self.output_stream = None
        self.left_channel = AudioChannel("left")
        self.right_channel = AudioChannel("right")
        self.buffer_lock = threading.Lock()
        self.event_loop = None
        self.loop_thread = None
        self.is_running = False
        
        # Real-time alignment system - DISABLED by default due to performance issues
        # The continuous alignment approach still causes lock contention and audio glitches
        # To enable: AudioPreviewManager(use_realtime_alignment=True)
        self.use_realtime_alignment = use_realtime_alignment and REALTIME_ALIGNMENT_AVAILABLE
        if self.use_realtime_alignment:
            self.alignment_thread = ContinuousAlignmentThread(
                sample_rate=sample_rate,
                target_buffer_ms=150  # 150ms buffer
            )
            print("Real-time audio alignment enabled")
        else:
            self.alignment_thread = None
            print("Using legacy audio mode (no alignment)")
        
        # Legacy timestamp sync (DISABLED - causes performance issues)
        self.audio_aligner = None
        
    def start_output_stream(self) -> bool:
        """Start the audio output stream."""
        if not SOUNDDEVICE_AVAILABLE:
            print("Error: sounddevice not available")
            return False
        
        if self.output_stream is not None:
            return True  # Already running
        
        # Start alignment thread if using real-time alignment
        if self.use_realtime_alignment and self.alignment_thread and not self.alignment_thread.running:
            self.alignment_thread.start()
            print("Alignment thread started")
        
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
        # Stop alignment thread first
        if self.use_realtime_alignment and self.alignment_thread and self.alignment_thread.running:
            self.alignment_thread.stop()
            print("Alignment thread stopped")
        
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
            print(f"[AUDIO_CALLBACK] Status: {status}")
        
        if self.use_realtime_alignment and self.alignment_thread:
            # Real-time alignment mode: read from playback buffer (lock-free)
            samples = self.alignment_thread.output_buffer.read_samples(frames)
            
            # Convert mono to stereo
            outdata[:, 0] = samples
            outdata[:, 1] = samples
        else:
            # Legacy mode: use direct buffer access with prebuffering
            MIN_BUFFER_SIZE = self.sample_rate // 2  # 500ms minimum buffer
            
            with self.buffer_lock:
                left_buf_size = len(self.left_channel.buffer)
                right_buf_size = len(self.right_channel.buffer)
                
                # Check if we need to prebuffer
                left_active = self.left_channel.is_active()
                right_active = self.right_channel.is_active()
                
                # Prebuffer logic for left channel
                if left_active and self.left_channel.prebuffering:
                    if left_buf_size >= MIN_BUFFER_SIZE:
                        self.left_channel.prebuffering = False
                        print(f"[LEFT] Prebuffering complete, starting playback ({left_buf_size} samples)")
                
                # Prebuffer logic for right channel
                if right_active and self.right_channel.prebuffering:
                    if right_buf_size >= MIN_BUFFER_SIZE:
                        self.right_channel.prebuffering = False
                        print(f"[RIGHT] Prebuffering complete, starting playback ({right_buf_size} samples)")
                
                # Get samples (or silence if prebuffering)
                if left_active and not self.left_channel.prebuffering:
                    left_samples = self._get_samples(self.left_channel.buffer, frames)
                    # Re-enter prebuffering if buffer gets too low
                    if left_buf_size < frames and left_buf_size < MIN_BUFFER_SIZE // 4:
                        self.left_channel.prebuffering = True
                        print(f"[LEFT] Buffer underrun, re-entering prebuffer mode ({left_buf_size} samples)")
                else:
                    left_samples = np.zeros(frames, dtype=np.int16)
                
                if right_active and not self.right_channel.prebuffering:
                    right_samples = self._get_samples(self.right_channel.buffer, frames)
                    # Re-enter prebuffering if buffer gets too low
                    if right_buf_size < frames and right_buf_size < MIN_BUFFER_SIZE // 4:
                        self.right_channel.prebuffering = True
                        print(f"[RIGHT] Buffer underrun, re-entering prebuffer mode ({right_buf_size} samples)")
                else:
                    right_samples = np.zeros(frames, dtype=np.int16)
            
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
        
        return

    def _audio_callback_legacy(self, outdata, frames, time_info, status):
        """Legacy audio callback implementation."""
        if status:
            print(f"Audio callback status: {status}")
        
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
        
        # Clear buffer and reset prebuffering
        with self.buffer_lock:
            ch.buffer.clear()
            ch.prebuffering = True
        
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
                msg_count = 0
                last_debug_time = time.time()
                
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
                                
                                msg_count += 1
                                
                                if self.use_realtime_alignment and self.alignment_thread:
                                    # Real-time alignment mode: feed alignment thread
                                    try:
                                        self.alignment_thread.add_data(ch.instance_id, timestamp, audio_array)
                                    except Exception as e:
                                        print(f"[{ch.channel_name.upper()}] Error adding data to alignment thread: {e}")
                                else:
                                    # Legacy mode: add to buffer
                                    with self.buffer_lock:
                                        old_size = len(ch.buffer)
                                        ch.buffer.extend(audio_array.tolist())
                                        new_size = len(ch.buffer)
                                        
                                        # Limit buffer size to prevent memory issues
                                        # Use a more generous limit and gradual trimming
                                        max_buffer_size = self.sample_rate * 5  # 5 seconds max
                                        if new_size > max_buffer_size:
                                            # Trim to 3 seconds instead of aggressive truncation
                                            trim_to = self.sample_rate * 3
                                            ch.buffer = ch.buffer[-trim_to:]
                                            print(f"[{ch.channel_name.upper()}] Buffer trimmed: {new_size} -> {len(ch.buffer)} samples")
                                        
                                        # Periodic debug output
                                        now = time.time()
                                        if now - last_debug_time >= 5.0:
                                            print(f"[{ch.channel_name.upper()}] Buffer: {len(ch.buffer)} samples, Messages: {msg_count}, Timestamp: {timestamp}")
                                            last_debug_time = now
                                            msg_count = 0
                                
                                # Also add to legacy aligner for metrics (only if not using realtime alignment)
                                if not self.use_realtime_alignment and self.audio_aligner and timestamp:
                                    try:
                                        self.audio_aligner.add_data(ch.instance_id, timestamp, audio_array)
                                    except Exception as e:
                                        pass
                        
                        elif data.get('type') == 'error':
                            error = data.get('error', 'Unknown error')
                            print(f"[{ch.channel_name.upper()}] Error from server: {error}")
                            break
                    
                    except asyncio.TimeoutError:
                        # Debug: Log timeout if we haven't received data in a while
                        now = time.time()
                        if now - last_debug_time >= 5.0:
                            with self.buffer_lock:
                                print(f"[{ch.channel_name.upper()}] Timeout - Buffer: {len(ch.buffer)} samples")
                            last_debug_time = now
                        continue
                    except websockets.exceptions.ConnectionClosed as e:
                        print(f"[{ch.channel_name.upper()}] Connection closed: {e}")
                        break
                    except Exception as e:
                        print(f"[{ch.channel_name.upper()}] Unexpected error: {e}")
                        import traceback
                        traceback.print_exc()
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
    
    def get_sync_metrics(self) -> Optional[dict]:
        """
        Get synchronization quality metrics.
        
        Returns:
            Dict of metrics or None if sync not available
        """
        if self.use_realtime_alignment and self.alignment_thread:
            try:
                metrics = self.alignment_thread.get_metrics()
                return {
                    'jitter_ms': metrics.timestamp_jitter_ms,
                    'success_rate': metrics.alignment_success_rate,
                    'drift_rate': metrics.clock_drift_rate,
                    'buffer_util': metrics.playback_buffer_utilization,
                    'underruns': metrics.underrun_count,
                    'alignment_fps': metrics.alignment_thread_fps
                }
            except Exception as e:
                print(f"Error getting metrics: {e}")
                return None
        elif self.audio_aligner:
            try:
                metrics = self.audio_aligner.get_metrics()
                return {
                    'jitter_ms': metrics.timestamp_jitter_ms,
                    'success_rate': metrics.alignment_success_rate,
                    'drift_rate': metrics.clock_drift_rate
                }
            except:
                return None
        return None