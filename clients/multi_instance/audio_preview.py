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

# Import simple alignment system
try:
    from simple_alignment import SimpleAudioAligner
    SIMPLE_ALIGNMENT_AVAILABLE = True
except ImportError:
    SIMPLE_ALIGNMENT_AVAILABLE = False
    print("Warning: simple_alignment module not available")

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
        self.current_level = 0.0  # Current audio level (0.0 to 1.0)

        # Adaptive buffering
        self.target_buffer_ms = 10  # Start with 10ms target
        self.underrun_count = 0  # Track underruns to adapt buffer size
        self.last_underrun_time = 0  # Time of last underrun
        self.learned_minimum_ms = 10  # Learned minimum viable buffer (starts at absolute min)
        self.underrun_history = []  # Track (time, buffer_size) of recent underruns
        self.last_learned_min_decrease = 0  # Time of last learned minimum decrease

    def is_active(self) -> bool:
        """Check if channel is actively streaming."""
        return self.running and self.ws is not None


class AudioPreviewManager:
    """Manages audio preview from up to 2 instances with left/right routing."""

    def __init__(self, sample_rate=12000, use_realtime_alignment=False, use_simple_alignment=True):
        self.sample_rate = sample_rate
        self.output_stream = None
        self.left_channel = AudioChannel("left")
        self.right_channel = AudioChannel("right")
        self.buffer_lock = threading.Lock()
        self.event_loop = None
        self.loop_thread = None
        self.is_running = False
        self.error_callback = None  # Callback for connection errors: callback(channel, error_message)
        # Professional RTP-based audio sync system
        self._audio_timestamps = {}  # instance_id -> {'rtp': rtp_ts, 'wallclock': wc_ms, 'local_time': our_time}
        self._rtp_reference = {}  # instance_id -> {'initial_rtp': rtp, 'initial_wallclock': wc_ms, 'initial_local': our_time}
        self._offset_history = {}  # 'left_id:right_id' -> [(time, offset_ms)] for smoothing
        self._last_offset_update = 0  # Last time we updated offsets
        self._last_applied_offset = {}  # 'left_id:right_id' -> last applied offset
        self.manual_offset_ms = 0.0  # Manual offset adjustment for right channel (-500 to +500 ms)

        # Adaptive buffering parameters
        self.min_buffer_ms = 10  # Minimum buffer (10ms for extreme low latency)
        self.max_buffer_ms = 1000  # Maximum buffer (1 second for poor networks)
        self.underrun_increase_ms = 50  # Increase buffer by 50ms on underrun
        self.stable_decrease_interval = 2.0  # Try to decrease buffer after 2s of stability

        # Sync quality parameters - tuned to prevent oscillation
        self._offset_window_sec = 10.0  # 10 second window for heavy smoothing
        self._min_samples_for_sync = 10  # Minimum samples before applying sync
        self._offset_change_threshold_ms = 20.0  # Apply changes > 20ms (large dead zone to prevent flip-flopping)

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

        # Simple alignment system (uses averaged timestamp offsets from GUI)
        self.use_simple_alignment = use_simple_alignment and SIMPLE_ALIGNMENT_AVAILABLE and not use_realtime_alignment
        if self.use_simple_alignment:
            self.simple_aligner = SimpleAudioAligner(sample_rate=sample_rate)
            print("Simple audio alignment enabled")
        else:
            self.simple_aligner = None

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
            # Adaptive buffering mode
            current_time = time.time()

            with self.buffer_lock:
                left_buf_size = len(self.left_channel.buffer)
                right_buf_size = len(self.right_channel.buffer)

                # Check if we need to prebuffer
                left_active = self.left_channel.is_active()
                right_active = self.right_channel.is_active()

                # Calculate target buffer size in samples for each channel
                left_target_samples = int((self.left_channel.target_buffer_ms / 1000.0) * self.sample_rate)
                right_target_samples = int((self.right_channel.target_buffer_ms / 1000.0) * self.sample_rate)

                # Prebuffer logic for left channel with adaptive target
                if left_active and self.left_channel.prebuffering:
                    if left_buf_size >= left_target_samples:
                        self.left_channel.prebuffering = False
                        print(f"[LEFT] Prebuffering complete ({left_buf_size} samples, {self.left_channel.target_buffer_ms}ms target)")

                # Prebuffer logic for right channel with adaptive target
                if right_active and self.right_channel.prebuffering:
                    if right_buf_size >= right_target_samples:
                        self.right_channel.prebuffering = False
                        print(f"[RIGHT] Prebuffering complete ({right_buf_size} samples, {self.right_channel.target_buffer_ms}ms target)")

                # Get samples (or silence if prebuffering)
                if left_active and not self.left_channel.prebuffering:
                    left_samples = self._get_samples(self.left_channel.buffer, frames)
                    # Check for underrun and adapt buffer size
                    if left_buf_size < frames:
                        self._handle_underrun(self.left_channel, current_time)
                        left_samples = np.zeros(frames, dtype=np.int16)  # Output silence on underrun
                else:
                    left_samples = np.zeros(frames, dtype=np.int16)

                if right_active and not self.right_channel.prebuffering:
                    right_samples = self._get_samples(self.right_channel.buffer, frames)
                    # Check for underrun and adapt buffer size
                    if right_buf_size < frames:
                        self._handle_underrun(self.right_channel, current_time)
                        right_samples = np.zeros(frames, dtype=np.int16)  # Output silence on underrun
                else:
                    right_samples = np.zeros(frames, dtype=np.int16)

                # Try to decrease buffer size if stable for a while
                if left_active and not self.left_channel.prebuffering:
                    self._try_decrease_buffer(self.left_channel, current_time)
                if right_active and not self.right_channel.prebuffering:
                    self._try_decrease_buffer(self.right_channel, current_time)

            # Calculate audio levels (RMS) before volume control with logarithmic scaling
            if len(left_samples) > 0:
                left_rms = np.sqrt(np.mean(left_samples.astype(np.float32) ** 2))
                # Convert to dB scale: 20 * log10(rms / max_value)
                # Range: -60 dB (quiet) to 0 dB (full scale)
                if left_rms > 0:
                    left_db = 20 * np.log10(left_rms / 32768.0)
                    # Map -60dB to 0.0, 0dB to 1.0
                    self.left_channel.current_level = max(0.0, min(1.0, (left_db + 60) / 60))
                else:
                    self.left_channel.current_level = 0.0
            else:
                self.left_channel.current_level = 0.0

            if len(right_samples) > 0:
                right_rms = np.sqrt(np.mean(right_samples.astype(np.float32) ** 2))
                # Convert to dB scale: 20 * log10(rms / max_value)
                # Range: -60 dB (quiet) to 0 dB (full scale)
                if right_rms > 0:
                    right_db = 20 * np.log10(right_rms / 32768.0)
                    # Map -60dB to 0.0, 0dB to 1.0
                    self.right_channel.current_level = max(0.0, min(1.0, (right_db + 60) / 60))
                else:
                    self.right_channel.current_level = 0.0
            else:
                self.right_channel.current_level = 0.0

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

    def _handle_underrun(self, ch: AudioChannel, current_time: float):
        """Handle buffer underrun by increasing target buffer size."""
        ch.underrun_count += 1
        ch.last_underrun_time = current_time

        # Record this underrun in history
        ch.underrun_history.append((current_time, ch.target_buffer_ms))

        # Keep only last 10 underruns for analysis
        ch.underrun_history = ch.underrun_history[-10:]

        # Check if we've had multiple underruns at similar buffer sizes recently
        # This indicates we've found the minimum viable buffer
        # Use conservative criteria: need 5+ underruns over 60 seconds to be confident
        recent_underruns = [
            (t, buf) for t, buf in ch.underrun_history
            if current_time - t < 60.0  # Last 60 seconds
        ]

        if len(recent_underruns) >= 5:
            # Find the highest buffer size that caused underruns
            max_underrun_buffer = max(buf for _, buf in recent_underruns)

            # Only set learned minimum if we've seen consistent failures at this level
            # Check that at least 3 of the underruns were at similar buffer sizes (within 50ms)
            similar_buffer_underruns = [
                buf for _, buf in recent_underruns
                if abs(buf - max_underrun_buffer) <= 50
            ]

            if len(similar_buffer_underruns) >= 3:
                # Set learned minimum to slightly above this (add one increase step)
                new_learned_min = min(max_underrun_buffer + self.underrun_increase_ms, self.max_buffer_ms)

                if new_learned_min > ch.learned_minimum_ms:
                    ch.learned_minimum_ms = new_learned_min
                    print(f"[{ch.channel_name.upper()}] Learned minimum buffer: {ch.learned_minimum_ms}ms "
                          f"(based on {len(recent_underruns)} underruns, {len(similar_buffer_underruns)} at similar levels)")

        # Increase buffer size
        old_target = ch.target_buffer_ms
        ch.target_buffer_ms = min(ch.target_buffer_ms + self.underrun_increase_ms, self.max_buffer_ms)

        # Re-enter prebuffering with new target
        ch.prebuffering = True

        print(f"[{ch.channel_name.upper()}] Buffer underrun #{ch.underrun_count}, "
              f"increasing target: {old_target}ms → {ch.target_buffer_ms}ms")

    def _try_decrease_buffer(self, ch: AudioChannel, current_time: float):
        """Try to decrease buffer size if network has been stable."""
        # Try to decrease learned minimum if we've been stable for a long time
        # This allows the system to adapt to improving network conditions
        if (ch.learned_minimum_ms > self.min_buffer_ms and
            current_time - ch.last_underrun_time > 60.0 and  # 60 seconds stable
            current_time - ch.last_learned_min_decrease > 30.0):  # Don't decrease too often

            # Decrease learned minimum slowly
            old_learned_min = ch.learned_minimum_ms
            ch.learned_minimum_ms = max(
                ch.learned_minimum_ms - (self.underrun_increase_ms // 2),
                self.min_buffer_ms
            )
            ch.last_learned_min_decrease = current_time
            print(f"[{ch.channel_name.upper()}] Long-term stability, decreasing learned minimum: "
                  f"{old_learned_min}ms → {ch.learned_minimum_ms}ms")

        # Only try to decrease if we're above learned minimum and haven't had underruns recently
        if (ch.target_buffer_ms > ch.learned_minimum_ms and
            current_time - ch.last_underrun_time > self.stable_decrease_interval):

            # Decrease by half the increase amount (slow decrease, fast increase)
            old_target = ch.target_buffer_ms
            # Don't go below learned minimum
            ch.target_buffer_ms = max(
                ch.target_buffer_ms - (self.underrun_increase_ms // 2),
                ch.learned_minimum_ms
            )

            if old_target != ch.target_buffer_ms:
                print(f"[{ch.channel_name.upper()}] Network stable, decreasing buffer: "
                      f"{old_target}ms → {ch.target_buffer_ms}ms (learned min: {ch.learned_minimum_ms}ms)")
                # Reset the timer so we don't decrease too quickly
                ch.last_underrun_time = current_time - (self.stable_decrease_interval // 2)

    def set_error_callback(self, callback):
        """Set callback for connection errors.

        Args:
            callback: Function to call on error: callback(channel, error_message)
        """
        self.error_callback = callback

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

            # Clear alignment data for this instance
            if ch.instance_id is not None:
                # Clear timestamp and RTP reference
                if ch.instance_id in self._audio_timestamps:
                    del self._audio_timestamps[ch.instance_id]
                if ch.instance_id in self._rtp_reference:
                    del self._rtp_reference[ch.instance_id]

                # Clear delay buffer in aligner
                if self.use_simple_alignment and self.simple_aligner:
                    self.simple_aligner.clear_offset(ch.instance_id)

        # Clear offset history for any pair involving this instance
        if ch.instance_id is not None:
            keys_to_remove = [k for k in self._offset_history.keys()
                            if str(ch.instance_id) in k.split(':')]
            for key in keys_to_remove:
                del self._offset_history[key]
                if key in self._last_applied_offset:
                    del self._last_applied_offset[key]

        # Stop output stream if both channels are inactive
        if not self.left_channel.is_active() and not self.right_channel.is_active():
            self.stop_output_stream()

    def stop_all(self):
        """Stop all audio preview."""
        self.stop_preview('left')
        self.stop_preview('right')

        # Clear all alignment state
        with self.buffer_lock:
            self._audio_timestamps.clear()
            self._rtp_reference.clear()
            self._offset_history.clear()
            self._last_applied_offset.clear()
            self._last_offset_update = 0

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
                            # Extract both timestamps:
                            # - RTP timestamp: uint32 sample count (drift-free but different per server)
                            # - Wall-clock: NTP-synced time in ms (common reference across servers)
                            rtp_timestamp = data.get('timestamp')  # RTP timestamp (sample count)
                            wallclock_ms = data.get('wallclockMs')  # NTP-synced wall-clock time

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
                                    # Legacy mode: add to buffer (with RTP-based alignment)
                                    with self.buffer_lock:
                                        # RTP-based sync: use RTP timestamps for drift-free tracking
                                        if rtp_timestamp is not None and wallclock_ms is not None:
                                            local_time = time.time()

                                            # Store current timestamps
                                            self._audio_timestamps[ch.instance_id] = {
                                                'rtp': rtp_timestamp,
                                                'wallclock': wallclock_ms,
                                                'local_time': local_time
                                            }

                                            # Initialize RTP reference point on first packet
                                            if ch.instance_id not in self._rtp_reference:
                                                self._rtp_reference[ch.instance_id] = {
                                                    'initial_rtp': rtp_timestamp,
                                                    'initial_wallclock': wallclock_ms,
                                                    'initial_local': local_time
                                                }
                                                print(f"[RTP SYNC] Instance {ch.instance_id} reference: RTP={rtp_timestamp}, "
                                                      f"wallclock={wallclock_ms:.1f}ms")

                                            # Update offsets frequently (every 200ms) for responsive tracking
                                            current_time = time.time()
                                            if current_time - self._last_offset_update >= 0.2:
                                                self._update_audio_offsets()
                                                self._last_offset_update = current_time

                                        # Apply simple alignment if enabled
                                        if self.use_simple_alignment and self.simple_aligner:
                                            try:
                                                audio_array = self.simple_aligner.apply_alignment(ch.instance_id, audio_array)
                                            except Exception as e:
                                                import traceback
                                                print(f"[{ch.channel_name.upper()}] Error applying alignment: {e}")
                                                print(f"[{ch.channel_name.upper()}] Traceback: {traceback.format_exc()}")

                                        ch.buffer.extend(audio_array.tolist())
                                        new_size = len(ch.buffer)

                                        # Only limit buffer to prevent memory issues (very generous limit)
                                        # Don't try to "fix" timing issues with buffer trimming - that causes choppiness
                                        # Timing alignment should be handled by the alignment system, not buffer management
                                        max_buffer_size = self.sample_rate * 30  # 30 seconds absolute max (memory safety only)
                                        if new_size > max_buffer_size:
                                            # Only trim if we hit the absolute memory limit
                                            ch.buffer = ch.buffer[-max_buffer_size:]
                                            print(f"[{ch.channel_name.upper()}] Memory safety trim: {new_size} -> {len(ch.buffer)} samples")

                                        # Periodic debug output
                                        now = time.time()
                                        if now - last_debug_time >= 5.0:
                                            print(f"[{ch.channel_name.upper()}] Buffer: {len(ch.buffer)} samples, Messages: {msg_count}, RTP: {rtp_timestamp}, Wall: {wallclock_ms}")
                                            last_debug_time = now
                                            msg_count = 0

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
            error_msg = str(e)
            print(f"Error connecting {ch.channel_name} channel: {error_msg}")

            # Notify UI of connection error
            if self.error_callback:
                try:
                    self.error_callback(ch.channel_name, error_msg)
                except Exception as callback_error:
                    print(f"Error in error callback: {callback_error}")

        finally:
            ch.ws = None
            ch.running = False
            print(f"{ch.channel_name.capitalize()} channel disconnected")

            # Notify UI of disconnection if it was unexpected (not a clean stop)
            if ch.running and self.error_callback:
                try:
                    self.error_callback(ch.channel_name, "Connection lost")
                except Exception as callback_error:
                    print(f"Error in error callback: {callback_error}")

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

            # Don't clear buffer - let audio continue smoothly during frequency change
            # The server will send audio for the new frequency immediately

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

    def set_manual_offset(self, offset_ms: float):
        """Set manual offset adjustment for right channel.

        Args:
            offset_ms: Offset in milliseconds (-500 to +500)
                      Positive = delay right channel
                      Negative = delay left channel (advance right)
        """
        # Clamp to valid range
        self.manual_offset_ms = max(-500.0, min(500.0, offset_ms))

        # Force immediate offset update
        if self.use_simple_alignment and self.simple_aligner:
            self._update_audio_offsets()

        print(f"[MANUAL OFFSET] Set to {self.manual_offset_ms:.1f}ms")

    def get_manual_offset(self) -> float:
        """Get current manual offset setting.

        Returns:
            Current manual offset in milliseconds
        """
        return self.manual_offset_ms

    def get_audio_levels(self) -> tuple:
        """Get current audio levels for both channels.

        Returns:
            Tuple of (left_level, right_level) where each is 0.0 to 1.0
        """
        return (self.left_channel.current_level, self.right_channel.current_level)

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
    def _update_audio_offsets(self):
        """RTP-based audio synchronization for drift-free alignment.

        Algorithm:
        1. Use wall-clock timestamps for initial alignment (find starting offset)
        2. Use RTP timestamp deltas to track drift-free relative timing
        3. RTP timestamps increment at exact sample rate (12000 Hz) - no clock drift
        4. Convert RTP delta to time using: time_ms = (rtp_delta / sample_rate) * 1000

        This provides:
        - Drift-free tracking (RTP counters are sample-accurate)
        - Initial alignment from wall-clock (handles different RTP starting points)
        - Continuous adjustment as streams drift apart
        """
        if not self.use_simple_alignment or not self.simple_aligner:
            return

        import time
        current_time = time.time()

        # Get data for both channels
        left_id = None
        right_id = None
        left_data = None
        right_data = None
        left_ref = None
        right_ref = None

        if self.left_channel.is_active() and self.left_channel.instance_id in self._audio_timestamps:
            left_id = self.left_channel.instance_id
            left_data = self._audio_timestamps[left_id]
            left_ref = self._rtp_reference.get(left_id)

        if self.right_channel.is_active() and self.right_channel.instance_id in self._audio_timestamps:
            right_id = self.right_channel.instance_id
            right_data = self._audio_timestamps[right_id]
            right_ref = self._rtp_reference.get(right_id)

        # Calculate offset using RTP timestamps
        if (left_data and right_data and left_ref and right_ref and
            left_id is not None and right_id is not None and left_id != right_id):

            # Calculate elapsed time for each stream using RTP timestamps (drift-free)
            # RTP is uint32, handle wraparound
            left_rtp_delta = (left_data['rtp'] - left_ref['initial_rtp']) & 0xFFFFFFFF
            right_rtp_delta = (right_data['rtp'] - right_ref['initial_rtp']) & 0xFFFFFFFF

            # Convert RTP samples to milliseconds
            left_elapsed_ms = (left_rtp_delta / self.sample_rate) * 1000.0
            right_elapsed_ms = (right_rtp_delta / self.sample_rate) * 1000.0

            # Initial offset from wall-clock timestamps (accounts for different RTP starting points)
            initial_offset_ms = right_ref['initial_wallclock'] - left_ref['initial_wallclock']

            # Current offset = initial offset + RTP drift
            # If right has played more samples than left, right is ahead
            rtp_drift_ms = right_elapsed_ms - left_elapsed_ms
            auto_offset_ms = initial_offset_ms + rtp_drift_ms

            # Store in history for smoothing
            history_key = f"{left_id}:{right_id}"
            if history_key not in self._offset_history:
                self._offset_history[history_key] = []

            self._offset_history[history_key].append((current_time, auto_offset_ms))

            # Remove old samples outside window
            cutoff = current_time - self._offset_window_sec
            self._offset_history[history_key] = [
                (t, off) for t, off in self._offset_history[history_key]
                if t >= cutoff
            ]

            # Calculate smoothed offset using weighted average (heavily favor recent, but smooth)
            offset_history = self._offset_history[history_key]
            if len(offset_history) >= self._min_samples_for_sync:
                # Use weighted average with heavy smoothing to prevent oscillation
                total_weight = 0.0
                weighted_sum = 0.0
                oldest_time = offset_history[0][0]
                newest_time = offset_history[-1][0]
                time_range = max(newest_time - oldest_time, 0.001)

                for t, off in offset_history:
                    # Moderate weighting: 0.6 (oldest) to 1.0 (newest)
                    # This provides smoothing while still tracking drift
                    age_ratio = (t - oldest_time) / time_range
                    weight = 0.6 + (0.4 * age_ratio)
                    weighted_sum += off * weight
                    total_weight += weight

                smoothed_auto_offset_ms = weighted_sum / total_weight if total_weight > 0 else offset_history[-1][1]

                # Add manual offset adjustment
                total_offset_ms = smoothed_auto_offset_ms + self.manual_offset_ms

                # Apply dead zone: only update if change is significant
                last_offset = self._last_applied_offset.get(history_key, None)
                if last_offset is None or abs(total_offset_ms - last_offset) > self._offset_change_threshold_ms:

                    # Apply offset: positive = right ahead, delay right; negative = left ahead, delay left
                    if total_offset_ms >= 0:
                        # Right is ahead, delay right
                        self.simple_aligner.update_offset(left_id, 0.0)
                        self.simple_aligner.update_offset(right_id, abs(total_offset_ms))
                        delayed_channel = "Right"
                    else:
                        # Left is ahead, delay left
                        self.simple_aligner.update_offset(left_id, abs(total_offset_ms))
                        self.simple_aligner.update_offset(right_id, 0.0)
                        delayed_channel = "Left"

                    # Log the sync adjustment
                    self._last_applied_offset[history_key] = total_offset_ms
                    manual_str = f" + {self.manual_offset_ms:+.1f}ms manual" if self.manual_offset_ms != 0 else ""

                    print(f"[RTP SYNC] Left: RTP Δ={left_rtp_delta} ({left_elapsed_ms:.1f}ms), "
                          f"Right: RTP Δ={right_rtp_delta} ({right_elapsed_ms:.1f}ms)")
                    print(f"[RTP SYNC] Initial offset: {initial_offset_ms:+.1f}ms, RTP drift: {rtp_drift_ms:+.1f}ms")
                    print(f"[RTP SYNC] Auto offset: {smoothed_auto_offset_ms:+.1f}ms{manual_str} = "
                          f"{total_offset_ms:+.1f}ms total -> Delaying {delayed_channel} channel "
                          f"({len(offset_history)} samples)")

        elif left_id is not None:
            # Only left channel active, no offset needed
            self.simple_aligner.update_offset(left_id, 0.0)
        elif right_id is not None:
            # Only right channel active, no offset needed
            self.simple_aligner.update_offset(right_id, 0.0)

        elif self.use_simple_alignment and self.simple_aligner:
            try:
                metrics = self.simple_aligner.get_metrics()
                return {
                    'offset_updates': metrics.offset_updates,
                    'active_offsets': len(metrics.active_offsets),
                    'success_rate': 1.0 if metrics.offset_updates > 0 else 0.0,
                    'jitter_ms': 0.0  # Simple alignment doesn't track jitter
                }
            except Exception as e:
                print(f"Error getting simple alignment metrics: {e}")
                return None
        return None