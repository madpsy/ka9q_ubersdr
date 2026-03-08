#!/usr/bin/env python3
"""
IQ Audio Channel
Encapsulates all state and behavior for a single audio preview channel
"""

import numpy as np
from typing import Optional, Dict, Any
from iq_audio_preview import AudioPreviewController


class AudioChannel:
    """Represents a single audio preview channel with independent settings"""
    
    def __init__(self, channel_id: int, color: str, sample_rate: int, 
                 center_freq: int, audio_sample_rate: int = 48000, name: Optional[str] = None):
        """
        Initialize audio channel
        
        Args:
            channel_id: Unique channel identifier (1-6)
            color: Hex color code for visual marker (e.g., '#00FFFF')
            sample_rate: IQ sample rate in Hz
            center_freq: Center frequency of IQ stream in Hz
            audio_sample_rate: Output audio sample rate in Hz
            name: Custom channel name (auto-generated if None)
        """
        self.channel_id = channel_id
        self.color = color
        self.sample_rate = sample_rate
        self.center_freq = center_freq
        self.audio_sample_rate = audio_sample_rate
        
        # Channel settings
        self.name = name or self._generate_default_name()
        self.frequency = center_freq  # Target frequency in Hz
        self.mode = 'USB'  # Demodulation mode (USB/LSB/CWU/CWL)
        self.bandwidth = 2700  # Filter bandwidth in Hz
        self.volume = 0.5  # Channel volume (0.0-1.0)
        self.left_enabled = True  # Output to left speaker
        self.right_enabled = True  # Output to right speaker
        self.locked = False  # Frequency locked (not following hover)
        self.enabled = True  # Channel active/inactive
        self.agc_enabled = True  # AGC enabled
        self.device_index = None  # Audio device (None = shared)
        
        # Audio preview controller
        self.audio_preview: Optional[AudioPreviewController] = None
        
        # Canvas marker IDs (for cleanup)
        self.marker_ids = []
    
    def _generate_default_name(self) -> str:
        """Generate default channel name"""
        return f"Channel {self.channel_id}"
    
    def start(self) -> bool:
        """
        Start audio preview for this channel
        
        Returns:
            True if started successfully
        """
        if self.audio_preview and self.audio_preview.is_enabled():
            return True
        
        try:
            # Create audio preview controller
            self.audio_preview = AudioPreviewController(
                sample_rate=self.sample_rate,
                center_freq=self.center_freq,
                audio_sample_rate=self.audio_sample_rate
            )
            
            # Configure settings
            self.audio_preview.set_mode(self.mode)
            self.audio_preview.set_bandwidth(self.bandwidth)
            self.audio_preview.set_volume(self.volume)
            self.audio_preview.set_target_frequency(self.frequency)
            self.audio_preview.set_agc_enabled(self.agc_enabled)
            self.audio_preview.set_channels(self.left_enabled, self.right_enabled)
            
            # Set device index if specified
            if self.device_index is not None and self.audio_preview.audio_output:
                self.audio_preview.audio_output.device_index = self.device_index
            
            # Start preview
            if self.audio_preview.start():
                self.enabled = True
                print(f"Channel {self.channel_id} '{self.name}' started: {self.mode} @ {self.frequency/1e6:.6f} MHz")
                return True
            else:
                self.audio_preview = None
                return False
                
        except Exception as e:
            print(f"Error starting channel {self.channel_id}: {e}")
            self.audio_preview = None
            return False
    
    def stop(self):
        """Stop audio preview for this channel"""
        if self.audio_preview:
            try:
                self.audio_preview.stop()
                print(f"Channel {self.channel_id} '{self.name}' stopped")
            except Exception as e:
                print(f"Error stopping channel {self.channel_id}: {e}")
            finally:
                self.audio_preview = None
        
        self.enabled = False
    
    def set_name(self, name: str):
        """
        Set custom channel name
        
        Args:
            name: New channel name
        """
        self.name = name.strip() or self._generate_default_name()
    
    def set_frequency(self, freq_hz: int):
        """
        Set target frequency
        
        Args:
            freq_hz: Frequency in Hz
        """
        self.frequency = freq_hz
        if self.audio_preview and self.audio_preview.is_enabled():
            self.audio_preview.set_target_frequency(freq_hz)
    
    def set_mode(self, mode: str):
        """
        Set demodulation mode
        
        Args:
            mode: 'USB', 'LSB', 'CWU', or 'CWL'
        """
        if mode in ['USB', 'LSB', 'CWU', 'CWL']:
            self.mode = mode
            if self.audio_preview:
                self.audio_preview.set_mode(mode)
    
    def set_bandwidth(self, bandwidth_hz: int):
        """
        Set filter bandwidth
        
        Args:
            bandwidth_hz: Bandwidth in Hz
        """
        self.bandwidth = bandwidth_hz
        if self.audio_preview and self.audio_preview.is_enabled():
            self.audio_preview.set_bandwidth(bandwidth_hz)
    
    def set_volume(self, volume: float):
        """
        Set channel volume
        
        Args:
            volume: Volume level (0.0 to 1.0)
        """
        self.volume = max(0.0, min(1.0, volume))
        if self.audio_preview and self.audio_preview.is_enabled():
            self.audio_preview.set_volume(self.volume)
    
    def set_output_routing(self, left: bool, right: bool):
        """
        Set L/R output routing
        
        Args:
            left: Enable left channel output
            right: Enable right channel output
        """
        self.left_enabled = left
        self.right_enabled = right
        if self.audio_preview and self.audio_preview.is_enabled():
            self.audio_preview.set_channels(left, right)
    
    def set_agc_enabled(self, enabled: bool):
        """
        Enable or disable AGC
        
        Args:
            enabled: True to enable AGC
        """
        self.agc_enabled = enabled
        if self.audio_preview and self.audio_preview.is_enabled():
            self.audio_preview.set_agc_enabled(enabled)
    
    def set_locked(self, locked: bool):
        """
        Lock or unlock frequency
        
        Args:
            locked: True to lock frequency
        """
        self.locked = locked
    
    def process_iq_samples(self, iq_samples: np.ndarray):
        """
        Process IQ samples through this channel
        
        Args:
            iq_samples: Complex IQ samples
        """
        if self.audio_preview and self.audio_preview.is_enabled() and self.enabled:
            try:
                self.audio_preview.process_iq_samples(iq_samples)
            except Exception as e:
                print(f"Error processing IQ samples in channel {self.channel_id}: {e}")
    
    def is_active(self) -> bool:
        """Check if channel is active and playing"""
        return self.enabled and self.audio_preview is not None and self.audio_preview.is_enabled()
    
    def get_frequency_mhz(self) -> float:
        """Get frequency in MHz"""
        return self.frequency / 1e6
    
    def to_dict(self) -> Dict[str, Any]:
        """
        Serialize channel to dictionary
        
        Returns:
            Dictionary representation of channel
        """
        return {
            'id': self.channel_id,
            'name': self.name,
            'color': self.color,
            'frequency': self.frequency,
            'mode': self.mode,
            'bandwidth': self.bandwidth,
            'volume': self.volume,
            'left_enabled': self.left_enabled,
            'right_enabled': self.right_enabled,
            'locked': self.locked,
            'enabled': self.enabled,
            'agc_enabled': self.agc_enabled,
            'device_index': self.device_index
        }
    
    @staticmethod
    def from_dict(data: Dict[str, Any], sample_rate: int, center_freq: int, 
                  audio_sample_rate: int = 48000) -> 'AudioChannel':
        """
        Deserialize channel from dictionary
        
        Args:
            data: Dictionary representation
            sample_rate: IQ sample rate
            center_freq: Center frequency
            audio_sample_rate: Audio sample rate
            
        Returns:
            AudioChannel instance
        """
        channel = AudioChannel(
            channel_id=data['id'],
            color=data['color'],
            sample_rate=sample_rate,
            center_freq=center_freq,
            audio_sample_rate=audio_sample_rate,
            name=data.get('name')
        )
        
        # Restore settings
        channel.frequency = data.get('frequency', center_freq)
        channel.mode = data.get('mode', 'USB')
        channel.bandwidth = data.get('bandwidth', 2700)
        channel.volume = data.get('volume', 0.5)
        channel.left_enabled = data.get('left_enabled', True)
        channel.right_enabled = data.get('right_enabled', True)
        channel.locked = data.get('locked', False)
        channel.enabled = data.get('enabled', True)
        channel.agc_enabled = data.get('agc_enabled', True)
        channel.device_index = data.get('device_index')
        
        return channel
    
    def __repr__(self) -> str:
        """String representation"""
        status = "active" if self.is_active() else "inactive"
        return (f"AudioChannel(id={self.channel_id}, name='{self.name}', "
                f"freq={self.frequency/1e6:.6f}MHz, mode={self.mode}, {status})")
