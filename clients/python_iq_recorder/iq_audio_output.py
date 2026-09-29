#!/usr/bin/env python3
"""
IQ Audio Output Manager
Handles audio output using PyAudio with buffering and volume control
"""

import numpy as np
import threading
from typing import Optional

# Try to import PyAudio
try:
    import pyaudio
    PYAUDIO_AVAILABLE = True
except ImportError:
    PYAUDIO_AVAILABLE = False
    print("Warning: PyAudio not available. Audio preview disabled.")


class AudioOutputManager:
    """Manages audio output with a jitter buffer and volume control.

    IQ arrives in packets of a few milliseconds each (360 frames at iq96 is
    3.75 ms), and not evenly: the network delivers them in bursts. Audio is
    therefore held in a ring buffer measured in time, playback does not start
    until it holds PRIME_SECONDS, and an underrun re-primes rather than playing
    each late packet the moment it lands. Draining happens in PortAudio's
    callback, so nothing depends on a Python writer thread getting scheduled.

    The server's sample clock and the sound card's are not the same clock, so
    the buffer slowly fills or empties. When it passes MAX_SECONDS the oldest
    audio is dropped back to PRIME_SECONDS, one skip rather than a stream of
    small ones.
    """

    PRIME_SECONDS = 0.2
    MAX_SECONDS = 0.6
    CAPACITY_SECONDS = 1.0

    def __init__(self, sample_rate: int = 48000, channels: int = 1,
                 buffer_size: int = 1024, device_index: Optional[int] = None):
        """
        Initialize audio output manager

        Args:
            sample_rate: Audio sample rate in Hz (default 48000)
            channels: Number of audio channels (default 1 = mono)
            buffer_size: PortAudio buffer size in frames (default 1024)
            device_index: PyAudio device index (None = default device)
        """
        self.sample_rate = sample_rate
        self.channels = channels
        self.buffer_size = buffer_size
        self.device_index = device_index

        # Audio state
        self.pyaudio_instance = None
        self.audio_stream = None
        self.running = False
        self.volume = 0.5  # 0.0 to 1.0

        # Channel control (for stereo output)
        self.left_enabled = True
        self.right_enabled = True

        # Ring buffer of int16 frames, shared with the PortAudio callback.
        self._lock = threading.Lock()
        self._capacity = int(sample_rate * self.CAPACITY_SECONDS)
        self._ring = np.zeros((self._capacity, channels), dtype=np.int16)
        self._read = 0
        self._fill = 0
        self._primed = False
        self._prime_frames = int(sample_rate * self.PRIME_SECONDS)
        self._max_frames = int(sample_rate * self.MAX_SECONDS)

        # Statistics
        self.underruns = 0
        self.overruns = 0

    def start(self) -> bool:
        """
        Start audio output

        Returns:
            True if started successfully, False otherwise
        """
        if not PYAUDIO_AVAILABLE:
            print("Error: PyAudio not available")
            return False

        if self.running:
            return True

        try:
            self._reset_buffer()

            # Initialize PyAudio
            self.pyaudio_instance = pyaudio.PyAudio()

            # Open audio stream
            stream_kwargs = {
                'format': pyaudio.paInt16,
                'channels': self.channels,
                'rate': self.sample_rate,
                'output': True,
                'frames_per_buffer': self.buffer_size,
                'stream_callback': self._callback,
            }

            if self.device_index is not None:
                stream_kwargs['output_device_index'] = self.device_index
                device_info = self.pyaudio_instance.get_device_info_by_index(self.device_index)
                device_name = device_info.get('name', 'Unknown')
                print(f"Audio output: {device_name} @ {self.sample_rate} Hz")
            else:
                print(f"Audio output: Default device @ {self.sample_rate} Hz")

            self.running = True
            self.audio_stream = self.pyaudio_instance.open(**stream_kwargs)
            self.audio_stream.start_stream()
            return True

        except Exception as e:
            print(f"Error starting audio output: {e}")
            self.stop()
            return False

    def stop(self):
        """Stop audio output"""
        self.running = False

        # Close audio stream
        if self.audio_stream:
            try:
                self.audio_stream.stop_stream()
                self.audio_stream.close()
            except:
                pass
            self.audio_stream = None

        # Terminate PyAudio
        if self.pyaudio_instance:
            try:
                self.pyaudio_instance.terminate()
            except:
                pass
            self.pyaudio_instance = None

        self._reset_buffer()

    def _reset_buffer(self):
        with self._lock:
            self._read = 0
            self._fill = 0
            self._primed = False

    def write(self, audio_samples: np.ndarray):
        """
        Write audio samples to the jitter buffer

        Args:
            audio_samples: Mono audio samples (float32, -1.0 to 1.0)
        """
        if not self.running or len(audio_samples) == 0:
            return

        # Apply volume and convert to int16
        audio_int16 = np.clip(np.asarray(audio_samples) * (self.volume * 32767),
                              -32768, 32767).astype(np.int16)

        if self.channels == 2:
            frames = np.zeros((len(audio_int16), 2), dtype=np.int16)
            if self.left_enabled:
                frames[:, 0] = audio_int16
            if self.right_enabled:
                frames[:, 1] = audio_int16
        else:
            frames = audio_int16.reshape(-1, 1)

        n = len(frames)
        cap = self._capacity
        if n > cap:
            frames = frames[-cap:]
            n = cap

        with self._lock:
            # Too far ahead of the sound card: skip back to the priming level
            # in one step, making room for this write at the same time.
            excess = self._fill + n - self._max_frames
            if excess > 0:
                drop = min(self._fill, self._fill + n - self._prime_frames)
                self._read = (self._read + drop) % cap
                self._fill -= drop
                self.overruns += 1

            w = (self._read + self._fill) % cap
            first = min(n, cap - w)
            self._ring[w:w + first] = frames[:first]
            if first < n:
                self._ring[:n - first] = frames[first:]
            self._fill += n

            if not self._primed and self._fill >= self._prime_frames:
                self._primed = True

    def _callback(self, in_data, frame_count, time_info, status):
        """PortAudio callback: hand over frame_count frames, or silence."""
        out = np.zeros((frame_count, self.channels), dtype=np.int16)
        if not self.running:
            return (out.tobytes(), pyaudio.paComplete)

        with self._lock:
            if self._primed:
                n = min(frame_count, self._fill)
                cap = self._capacity
                r = self._read
                first = min(n, cap - r)
                out[:first] = self._ring[r:r + first]
                if first < n:
                    out[first:n] = self._ring[:n - first]
                self._read = (r + n) % cap
                self._fill -= n
                if n < frame_count:
                    # Ran dry: wait for a full priming buffer again rather
                    # than stuttering through each packet as it arrives.
                    self._primed = False
                    self.underruns += 1

        return (out.tobytes(), pyaudio.paContinue)

    def set_volume(self, volume: float):
        """
        Set output volume

        Args:
            volume: Volume level (0.0 to 1.0)
        """
        self.volume = max(0.0, min(1.0, volume))

    def get_volume(self) -> float:
        """Get current volume level"""
        return self.volume

    def get_stats(self) -> dict:
        """Get audio statistics"""
        return {
            'underruns': self.underruns,
            'overruns': self.overruns,
            'buffered_ms': 1000.0 * self._fill / self.sample_rate,
            'running': self.running
        }

    def is_available(self) -> bool:
        """Check if PyAudio is available"""
        return PYAUDIO_AVAILABLE

    def is_running(self) -> bool:
        """Check if audio output is running"""
        return self.running

    def set_channels(self, left_enabled: bool, right_enabled: bool):
        """
        Set which channels are enabled (for stereo output)

        Args:
            left_enabled: Enable left channel
            right_enabled: Enable right channel
        """
        self.left_enabled = left_enabled
        self.right_enabled = right_enabled


def get_audio_devices():
    """
    Get list of available audio output devices
    
    Returns:
        List of tuples (device_index, device_name)
    """
    if not PYAUDIO_AVAILABLE:
        return []
    
    devices = []
    try:
        p = pyaudio.PyAudio()
        for i in range(p.get_device_count()):
            try:
                info = p.get_device_info_by_index(i)
                # Only include output devices
                if info.get('maxOutputChannels', 0) > 0:
                    name = info.get('name', f'Device {i}')
                    devices.append((i, name))
            except:
                pass
        p.terminate()
    except Exception as e:
        print(f"Error enumerating audio devices: {e}")
    
    return devices
