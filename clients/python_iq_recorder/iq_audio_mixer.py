#!/usr/bin/env python3
"""
IQ Audio Channel Mixer
Manages multiple audio channels and mixes their outputs to a shared device
"""

import numpy as np
import threading
from typing import List, Optional, Dict, Any
from collections import deque

from iq_audio_channel import AudioChannel
from iq_audio_output import AudioOutputManager


class AudioChannelMixer:
    """Manages multiple audio preview channels with mixing"""
    
    # Channel color palette
    CHANNEL_COLORS = [
        '#00FFFF',  # Cyan
        '#FF8800',  # Orange
        '#00FF00',  # Green
        '#FF00FF',  # Magenta
        '#FFFF00',  # Yellow
        '#FF0088',  # Pink
    ]
    
    MAX_CHANNELS = 6
    
    def __init__(self, sample_rate: int, center_freq: int, audio_sample_rate: int = 48000):
        """
        Initialize audio channel mixer
        
        Args:
            sample_rate: IQ sample rate in Hz
            center_freq: Center frequency of IQ stream in Hz
            audio_sample_rate: Output audio sample rate in Hz
        """
        self.sample_rate = sample_rate
        self.center_freq = center_freq
        self.audio_sample_rate = audio_sample_rate
        
        # Channel management
        self.channels: List[AudioChannel] = []
        self.next_channel_id = 1
        self.lock = threading.Lock()
        
        # Shared audio output (not used in independent mode)
        self.shared_output: Optional[AudioOutputManager] = None
        self.use_shared_output = False  # Currently using independent outputs per channel
        
        # Mixing settings
        self.auto_gain = True
        self.master_volume = 1.0
        
        # Statistics
        self.clipping_events = 0
        self.last_peak_level = 0.0
    
    def add_channel(self, name: Optional[str] = None, color: Optional[str] = None) -> Optional[AudioChannel]:
        """
        Add a new audio channel
        
        Args:
            name: Custom channel name (auto-generated if None)
            color: Custom color (auto-assigned if None)
            
        Returns:
            AudioChannel instance or None if max channels reached
        """
        with self.lock:
            if len(self.channels) >= self.MAX_CHANNELS:
                print(f"Cannot add channel: maximum of {self.MAX_CHANNELS} channels reached")
                return None
            
            # Assign color from palette
            if color is None:
                color_index = len(self.channels) % len(self.CHANNEL_COLORS)
                color = self.CHANNEL_COLORS[color_index]
            
            # Create channel
            channel = AudioChannel(
                channel_id=self.next_channel_id,
                color=color,
                sample_rate=self.sample_rate,
                center_freq=self.center_freq,
                audio_sample_rate=self.audio_sample_rate,
                name=name
            )
            
            self.channels.append(channel)
            self.next_channel_id += 1
            
            print(f"Added channel {channel.channel_id}: '{channel.name}' ({color})")
            return channel
    
    def remove_channel(self, channel_id: int) -> bool:
        """
        Remove a channel
        
        Args:
            channel_id: ID of channel to remove
            
        Returns:
            True if channel was removed
        """
        with self.lock:
            channel = self.get_channel(channel_id)
            if channel:
                # Stop channel if active
                if channel.is_active():
                    channel.stop()
                
                # Remove from list
                self.channels.remove(channel)
                print(f"Removed channel {channel_id}: '{channel.name}'")
                return True
            
            return False
    
    def get_channel(self, channel_id: int) -> Optional[AudioChannel]:
        """
        Get channel by ID
        
        Args:
            channel_id: Channel ID
            
        Returns:
            AudioChannel or None if not found
        """
        for channel in self.channels:
            if channel.channel_id == channel_id:
                return channel
        return None
    
    def get_channel_by_index(self, index: int) -> Optional[AudioChannel]:
        """
        Get channel by list index
        
        Args:
            index: List index (0-based)
            
        Returns:
            AudioChannel or None if index out of range
        """
        if 0 <= index < len(self.channels):
            return self.channels[index]
        return None
    
    def get_active_channels(self) -> List[AudioChannel]:
        """
        Get list of active channels
        
        Returns:
            List of active AudioChannel instances
        """
        return [ch for ch in self.channels if ch.is_active()]
    
    def get_channel_count(self) -> int:
        """Get total number of channels"""
        return len(self.channels)
    
    def get_active_channel_count(self) -> int:
        """Get number of active channels"""
        return len(self.get_active_channels())
    
    def process_iq_samples(self, iq_samples: np.ndarray):
        """
        Process IQ samples through all active channels
        
        Args:
            iq_samples: Complex IQ samples
        """
        # Each channel processes independently
        # (they have their own AudioPreviewController with output)
        for channel in self.channels:
            if channel.is_active():
                try:
                    channel.process_iq_samples(iq_samples)
                except Exception as e:
                    print(f"Error processing IQ in channel {channel.channel_id}: {e}")
    
    def start_shared_output(self) -> bool:
        """
        Start shared audio output (for future mixing mode)
        
        Returns:
            True if started successfully
        """
        if self.shared_output and self.shared_output.is_running():
            return True
        
        try:
            self.shared_output = AudioOutputManager(
                sample_rate=self.audio_sample_rate,
                channels=2,  # Stereo
                buffer_size=1024
            )
            
            if self.shared_output.start():
                self.use_shared_output = True
                print("Shared audio output started")
                return True
            else:
                self.shared_output = None
                return False
                
        except Exception as e:
            print(f"Error starting shared audio output: {e}")
            self.shared_output = None
            return False
    
    def stop_shared_output(self):
        """Stop shared audio output"""
        if self.shared_output:
            try:
                self.shared_output.stop()
                print("Shared audio output stopped")
            except Exception as e:
                print(f"Error stopping shared audio output: {e}")
            finally:
                self.shared_output = None
        
        self.use_shared_output = False
    
    def mix_and_output(self, buffer_size: int = 1024):
        """
        Mix all channel outputs to shared device (future feature)
        
        Args:
            buffer_size: Audio buffer size in samples
            
        Note:
            Currently not used - each channel has independent output.
            This method is reserved for future shared mixing mode.
        """
        if not self.use_shared_output or not self.shared_output:
            return
        
        # Get active channels
        active_channels = self.get_active_channels()
        if not active_channels:
            return
        
        # Initialize mix buffers
        left_sum = np.zeros(buffer_size, dtype=np.float32)
        right_sum = np.zeros(buffer_size, dtype=np.float32)
        
        # Mix channels
        for channel in active_channels:
            # Get audio buffer from channel (would need to implement buffer access)
            # This is a placeholder for future implementation
            pass
        
        # Create stereo array
        stereo = np.column_stack([left_sum, right_sum])
        
        # Normalize to prevent clipping
        if self.auto_gain:
            stereo = self.normalize_gain(stereo)
        
        # Apply master volume
        stereo *= self.master_volume
        
        # Output to shared device
        if self.shared_output:
            self.shared_output.write(stereo.flatten())
    
    def normalize_gain(self, audio: np.ndarray) -> np.ndarray:
        """
        Normalize audio to prevent clipping
        
        Args:
            audio: Audio samples
            
        Returns:
            Normalized audio
        """
        max_val = np.max(np.abs(audio))
        self.last_peak_level = max_val
        
        if max_val > 0.95:
            # Clipping detected
            self.clipping_events += 1
            
            # Reduce gain
            normalized = audio * (0.9 / max_val)
            return normalized
        
        return audio
    
    def set_master_volume(self, volume: float):
        """
        Set master volume for all channels
        
        Args:
            volume: Volume level (0.0 to 1.0)
        """
        self.master_volume = max(0.0, min(1.0, volume))
    
    def set_auto_gain(self, enabled: bool):
        """
        Enable or disable automatic gain control
        
        Args:
            enabled: True to enable auto-gain
        """
        self.auto_gain = enabled
    
    def start_all_channels(self) -> int:
        """
        Start all channels
        
        Returns:
            Number of channels successfully started
        """
        started = 0
        for channel in self.channels:
            if not channel.is_active():
                if channel.start():
                    started += 1
        
        print(f"Started {started}/{len(self.channels)} channels")
        return started
    
    def stop_all_channels(self):
        """Stop all active channels"""
        for channel in self.channels:
            if channel.is_active():
                channel.stop()
        
        print(f"Stopped all channels")
    
    def clear_all_channels(self):
        """Remove all channels"""
        self.stop_all_channels()
        with self.lock:
            self.channels.clear()
            self.next_channel_id = 1
        print("Cleared all channels")
    
    def get_statistics(self) -> Dict[str, Any]:
        """
        Get mixer statistics
        
        Returns:
            Dictionary of statistics
        """
        return {
            'total_channels': len(self.channels),
            'active_channels': self.get_active_channel_count(),
            'clipping_events': self.clipping_events,
            'last_peak_level': self.last_peak_level,
            'master_volume': self.master_volume,
            'auto_gain': self.auto_gain,
            'use_shared_output': self.use_shared_output
        }
    
    def to_dict(self) -> Dict[str, Any]:
        """
        Serialize mixer configuration to dictionary
        
        Returns:
            Dictionary representation
        """
        return {
            'channels': [ch.to_dict() for ch in self.channels],
            'master_volume': self.master_volume,
            'auto_gain': self.auto_gain
        }
    
    def from_dict(self, data: Dict[str, Any]):
        """
        Restore mixer configuration from dictionary
        
        Args:
            data: Dictionary representation
        """
        # Clear existing channels
        self.clear_all_channels()
        
        # Restore settings
        self.master_volume = data.get('master_volume', 1.0)
        self.auto_gain = data.get('auto_gain', True)
        
        # Restore channels
        with self.lock:
            for ch_data in data.get('channels', []):
                channel = AudioChannel.from_dict(
                    ch_data,
                    self.sample_rate,
                    self.center_freq,
                    self.audio_sample_rate
                )
                self.channels.append(channel)
                
                # Update next_channel_id
                if channel.channel_id >= self.next_channel_id:
                    self.next_channel_id = channel.channel_id + 1
        
        print(f"Restored {len(self.channels)} channels from configuration")
    
    def __repr__(self) -> str:
        """String representation"""
        active = self.get_active_channel_count()
        total = len(self.channels)
        return f"AudioChannelMixer({active}/{total} active channels)"
