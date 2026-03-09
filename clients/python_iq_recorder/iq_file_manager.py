#!/usr/bin/env python3
"""
IQ File Manager
Handles file naming, path management, and disk space monitoring for IQ recordings
"""

import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional


class IQFileManager:
    """Manages file paths and naming for IQ recordings"""
    
    # Filename template variables
    TEMPLATE_VARS = {
        'timestamp': 'YYYYMMDD_HHMMSS',
        'date': 'YYYYMMDD',
        'time': 'HHMMSS',
        'freq': 'Frequency in Hz',
        'freq_hz': 'Frequency in Hz (for SDR++ compatibility)',
        'freq_mhz': 'Frequency in MHz (deprecated, use freq_hz)',
        'mode': 'IQ mode (iq48/iq96/iq192)',
        'stream_id': 'Stream ID number'
    }
    
    def __init__(self, base_directory: str = "./recordings"):
        self.base_directory = Path(base_directory)
        self.ensure_directory_exists()
    
    def ensure_directory_exists(self):
        """Create base directory if it doesn't exist"""
        self.base_directory.mkdir(parents=True, exist_ok=True)
    
    def generate_filename(self, frequency: int, iq_mode: str, 
                         stream_id: int = 0, template: str = "default") -> str:
        """
        Generate a filename based on template
        
        Args:
            frequency: Frequency in Hz
            iq_mode: IQ mode string (iq48, iq96, iq192)
            stream_id: Stream ID number
            template: Template name or custom template string
        
        Returns:
            Full path to the output file
        """
        # Get current timestamp
        now = datetime.now()
        timestamp = now.strftime("%Y%m%d_%H%M%S")
        date = now.strftime("%Y%m%d")
        time_str = now.strftime("%H%M%S")
        
        # Calculate frequency in MHz (for backward compatibility)
        freq_mhz = frequency / 1_000_000.0
        
        # Template selection - all templates end with frequency in Hz for compatibility
        templates = {
            'default': '{timestamp}_{mode}_{freq_hz}Hz.wav',
            'simple': '{mode}_{freq_hz}Hz.wav',
            'detailed': 'stream{stream_id}_{timestamp}_{mode}_{freq_hz}Hz.wav'
        }
        
        # Use predefined template or custom
        if template in templates:
            filename_template = templates[template]
        else:
            filename_template = template
        
        # Replace template variables
        filename = filename_template.format(
            timestamp=timestamp,
            date=date,
            time=time_str,
            freq=frequency,
            freq_hz=int(frequency),  # Integer Hz for SDR++ compatibility
            freq_mhz=f"{freq_mhz:.3f}",  # Keep for backward compatibility
            mode=iq_mode,
            stream_id=stream_id
        )
        
        # Ensure .wav extension
        if not filename.lower().endswith('.wav'):
            filename += '.wav'
        
        # Return full path
        return str(self.base_directory / filename)
    
    def get_unique_filename(self, base_path: str) -> str:
        """
        Get a unique filename by adding a counter if file exists
        
        Args:
            base_path: Base file path
        
        Returns:
            Unique file path
        """
        path = Path(base_path)
        
        if not path.exists():
            return str(path)
        
        # File exists, add counter
        stem = path.stem
        suffix = path.suffix
        parent = path.parent
        
        counter = 1
        while True:
            new_path = parent / f"{stem}_{counter}{suffix}"
            if not new_path.exists():
                return str(new_path)
            counter += 1
    
    def get_disk_space(self) -> dict:
        """
        Get disk space information for the recording directory
        
        Returns:
            Dictionary with total, used, and free space in bytes
        """
        try:
            stat = shutil.disk_usage(self.base_directory)
            return {
                'total': stat.total,
                'used': stat.used,
                'free': stat.free,
                'percent_used': (stat.used / stat.total) * 100
            }
        except Exception as e:
            return {
                'total': 0,
                'used': 0,
                'free': 0,
                'percent_used': 0,
                'error': str(e)
            }
    
    def format_bytes(self, bytes_value: int) -> str:
        """Format bytes to human-readable string"""
        if bytes_value < 1024:
            return f"{bytes_value} B"
        elif bytes_value < 1024 * 1024:
            return f"{bytes_value / 1024:.1f} KB"
        elif bytes_value < 1024 * 1024 * 1024:
            return f"{bytes_value / (1024 * 1024):.1f} MB"
        else:
            return f"{bytes_value / (1024 * 1024 * 1024):.2f} GB"
    
    def get_disk_space_summary(self) -> str:
        """Get formatted disk space summary"""
        space = self.get_disk_space()
        if 'error' in space:
            return f"Error: {space['error']}"
        
        free = self.format_bytes(space['free'])
        total = self.format_bytes(space['total'])
        percent = space['percent_used']
        
        return f"{free} free of {total} ({percent:.1f}% used)"
    
    def check_disk_space_available(self, required_bytes: int) -> bool:
        """
        Check if enough disk space is available
        
        Args:
            required_bytes: Required space in bytes
        
        Returns:
            True if enough space available
        """
        space = self.get_disk_space()
        return space['free'] >= required_bytes
    
    def estimate_recording_size(self, iq_mode: str, duration_seconds: int) -> int:
        """
        Estimate recording file size
        
        Args:
            iq_mode: IQ mode (iq48, iq96, iq192)
            duration_seconds: Recording duration in seconds
        
        Returns:
            Estimated size in bytes
        """
        # Sample rates
        sample_rates = {
            'iq48': 48000,
            'iq96': 96000,
            'iq192': 192000
        }
        
        sample_rate = sample_rates.get(iq_mode.lower(), 48000)
        
        # WAV format: 2 channels (I and Q), 32-bit float (4 bytes per sample)
        bytes_per_sample = 4
        channels = 2
        
        # Calculate size
        samples = sample_rate * duration_seconds
        data_size = samples * channels * bytes_per_sample
        
        # Add WAV header overhead (44 bytes)
        total_size = data_size + 44
        
        return total_size
    
    def get_recording_files(self) -> list:
        """
        Get list of all WAV files in the recording directory
        
        Returns:
            List of file paths
        """
        try:
            wav_files = list(self.base_directory.glob("*.wav"))
            return sorted([str(f) for f in wav_files])
        except Exception:
            return []
    
    def get_total_recordings_size(self) -> int:
        """
        Get total size of all recordings
        
        Returns:
            Total size in bytes
        """
        total = 0
        for file_path in self.get_recording_files():
            try:
                total += os.path.getsize(file_path)
            except Exception:
                continue
        return total
    
    def cleanup_old_recordings(self, keep_count: int = 100):
        """
        Remove old recordings, keeping only the most recent ones
        
        Args:
            keep_count: Number of recordings to keep
        """
        files = self.get_recording_files()
        
        if len(files) <= keep_count:
            return
        
        # Sort by modification time
        files_with_time = []
        for file_path in files:
            try:
                mtime = os.path.getmtime(file_path)
                files_with_time.append((file_path, mtime))
            except Exception:
                continue
        
        # Sort by time (oldest first)
        files_with_time.sort(key=lambda x: x[1])
        
        # Remove oldest files
        files_to_remove = files_with_time[:len(files_with_time) - keep_count]
        for file_path, _ in files_to_remove:
            try:
                os.remove(file_path)
            except Exception:
                continue
    
    def validate_filename(self, filename: str) -> bool:
        """
        Validate filename for illegal characters
        
        Args:
            filename: Filename to validate
        
        Returns:
            True if valid
        """
        # Illegal characters in filenames
        illegal_chars = '<>:"|?*'
        
        for char in illegal_chars:
            if char in filename:
                return False
        
        return True
    
    def set_base_directory(self, directory: str):
        """Change the base recording directory"""
        self.base_directory = Path(directory)
        self.ensure_directory_exists()
