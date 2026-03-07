#!/usr/bin/env python3
"""
IQ Stream Configuration
Manages configuration for individual IQ recording streams
"""

import time
from typing import Optional
from enum import Enum


class StreamStatus(Enum):
    """Status of an IQ recording stream"""
    IDLE = "Idle"
    CONNECTING = "Connecting"
    RECORDING = "Recording"
    STOPPING = "Stopping"
    STOPPED = "Stopped"
    ERROR = "Error"


class IQMode(Enum):
    """Supported IQ modes with their sample rates"""
    IQ48 = ("iq48", 48000, "±24 kHz")
    IQ96 = ("iq96", 96000, "±48 kHz")
    IQ192 = ("iq192", 192000, "±96 kHz")
    
    def __init__(self, mode_name: str, sample_rate: int, bandwidth: str):
        self.mode_name = mode_name
        self.sample_rate = sample_rate
        self.bandwidth = bandwidth
    
    @classmethod
    def from_string(cls, mode_str: str):
        """Get IQMode from string"""
        mode_str = mode_str.lower()
        for mode in cls:
            if mode.mode_name == mode_str:
                return mode
        raise ValueError(f"Invalid IQ mode: {mode_str}")
    
    def __str__(self):
        return self.mode_name


class StreamConfig:
    """Configuration for a single IQ recording stream"""
    
    def __init__(self, stream_id: int, frequency: int, iq_mode: IQMode,
                 filename_template: str = "default",
                 recording_enabled: bool = True):
        self.stream_id = stream_id
        self.frequency = frequency  # Hz
        self.iq_mode = iq_mode
        self.filename_template = filename_template  # Template name, not actual filename
        self.output_file = None  # Generated when recording starts
        self.recording_enabled = recording_enabled  # Whether to write to disk
        
        # Runtime state
        self.status = StreamStatus.IDLE
        self.error_message = ""
        self.client = None  # RadioClient instance
        self.thread = None  # Recording thread
        self.start_time = None
        self.stop_time = None
        self.bytes_recorded = 0
        self.samples_recorded = 0
        
    @property
    def frequency_mhz(self) -> float:
        """Get frequency in MHz"""
        return self.frequency / 1_000_000.0
    
    @property
    def duration(self) -> float:
        """Get recording duration in seconds"""
        if self.start_time is None:
            return 0.0
        end_time = self.stop_time if self.stop_time else time.time()
        return end_time - self.start_time
    
    @property
    def file_size_mb(self) -> float:
        """Get recorded file size in MB"""
        return self.bytes_recorded / (1024 * 1024)
    
    @property
    def data_rate_mbps(self) -> float:
        """Get data rate in Mbps"""
        duration = self.duration
        if duration == 0:
            return 0.0
        bits = self.bytes_recorded * 8
        return (bits / duration) / 1_000_000
    
    def format_duration(self) -> str:
        """Format duration as HH:MM:SS"""
        duration = int(self.duration)
        hours = duration // 3600
        minutes = (duration % 3600) // 60
        seconds = duration % 60
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    
    def format_size(self) -> str:
        """Format file size with appropriate unit"""
        size = self.bytes_recorded
        if size < 1024:
            return f"{size} B"
        elif size < 1024 * 1024:
            return f"{size / 1024:.1f} KB"
        elif size < 1024 * 1024 * 1024:
            return f"{size / (1024 * 1024):.1f} MB"
        else:
            return f"{size / (1024 * 1024 * 1024):.2f} GB"
    
    def to_dict(self) -> dict:
        """Convert to dictionary for serialization"""
        return {
            'stream_id': self.stream_id,
            'frequency': self.frequency,
            'iq_mode': self.iq_mode.mode_name,
            'filename_template': self.filename_template,
            'recording_enabled': self.recording_enabled
        }
    
    @classmethod
    def from_dict(cls, data: dict):
        """Create from dictionary"""
        iq_mode = IQMode.from_string(data['iq_mode'])
        return cls(
            stream_id=data['stream_id'],
            frequency=data['frequency'],
            iq_mode=iq_mode,
            filename_template=data.get('filename_template', 'default'),
            recording_enabled=data.get('recording_enabled', True)
        )
    
    def __repr__(self):
        return (f"StreamConfig(id={self.stream_id}, freq={self.frequency_mhz:.3f} MHz, "
                f"mode={self.iq_mode.mode_name}, status={self.status.value})")
