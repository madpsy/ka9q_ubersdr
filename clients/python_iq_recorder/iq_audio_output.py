#!/usr/bin/env python3
"""
IQ Audio Output Manager
Handles audio output using PyAudio with buffering and volume control
"""

import numpy as np
import threading
import queue
from typing import Optional

# Try to import PyAudio
try:
    import pyaudio
    PYAUDIO_AVAILABLE = True
except ImportError:
    PYAUDIO_AVAILABLE = False
    print("Warning: PyAudio not available. Audio preview disabled.")


class AudioOutputManager:
    """Manages audio output with buffering and volume control"""
    
    def __init__(self, sample_rate: int = 48000, channels: int = 1,
                 buffer_size: int = 1024, device_index: Optional[int] = None):
        """
        Initialize audio output manager
        
        Args:
            sample_rate: Audio sample rate in Hz (default 48000)
            channels: Number of audio channels (default 1 = mono)
            buffer_size: Audio buffer size in samples (default 1024)
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
        
        # Audio queue for thread-safe buffering
        self.audio_queue = queue.Queue(maxsize=10)
        self.output_thread = None
        
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
            # Initialize PyAudio
            self.pyaudio_instance = pyaudio.PyAudio()
            
            # Open audio stream
            stream_kwargs = {
                'format': pyaudio.paInt16,
                'channels': self.channels,
                'rate': self.sample_rate,
                'output': True,
                'frames_per_buffer': self.buffer_size,
            }
            
            if self.device_index is not None:
                stream_kwargs['output_device_index'] = self.device_index
                device_info = self.pyaudio_instance.get_device_info_by_index(self.device_index)
                device_name = device_info.get('name', 'Unknown')
                print(f"Audio output: {device_name} @ {self.sample_rate} Hz")
            else:
                print(f"Audio output: Default device @ {self.sample_rate} Hz")
            
            self.audio_stream = self.pyaudio_instance.open(**stream_kwargs)
            
            # Start output thread
            self.running = True
            self.output_thread = threading.Thread(target=self._output_worker, daemon=True)
            self.output_thread.start()
            
            return True
            
        except Exception as e:
            print(f"Error starting audio output: {e}")
            self.stop()
            return False
    
    def stop(self):
        """Stop audio output"""
        self.running = False
        
        # Wait for output thread to finish
        if self.output_thread and self.output_thread.is_alive():
            self.output_thread.join(timeout=1.0)
        
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
        
        # Clear queue
        while not self.audio_queue.empty():
            try:
                self.audio_queue.get_nowait()
            except:
                break
    
    def write(self, audio_samples: np.ndarray):
        """
        Write audio samples to output queue
        
        Args:
            audio_samples: Audio samples (float32, -1.0 to 1.0)
        """
        if not self.running:
            return
        
        try:
            # Apply volume
            audio_scaled = audio_samples * self.volume
            
            # Convert to int16
            audio_int16 = np.clip(audio_scaled * 32767, -32768, 32767).astype(np.int16)
            
            # Handle stereo output with channel control
            if self.channels == 2:
                # Create stereo from mono
                stereo = np.zeros((len(audio_int16), 2), dtype=np.int16)
                if self.left_enabled:
                    stereo[:, 0] = audio_int16
                if self.right_enabled:
                    stereo[:, 1] = audio_int16
                audio_int16 = stereo
            
            # Add to queue (non-blocking)
            self.audio_queue.put_nowait(audio_int16.tobytes())
            
        except queue.Full:
            # Queue full - drop samples to prevent blocking
            self.overruns += 1
    
    def _output_worker(self):
        """Worker thread that outputs audio from queue"""
        silence = np.zeros(self.buffer_size, dtype=np.int16).tobytes()
        
        while self.running:
            try:
                # Get audio from queue with timeout
                audio_data = self.audio_queue.get(timeout=0.1)
                
                # Write to audio stream
                if self.audio_stream:
                    self.audio_stream.write(audio_data)
                    
            except queue.Empty:
                # No audio available - output silence to prevent underrun
                if self.audio_stream:
                    try:
                        self.audio_stream.write(silence)
                        self.underruns += 1
                    except:
                        pass
            except Exception as e:
                # Handle errors gracefully
                pass
    
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
            'queue_size': self.audio_queue.qsize(),
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
