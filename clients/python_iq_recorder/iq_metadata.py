#!/usr/bin/env python3
"""
IQ Metadata Writer
Adds metadata tags to WAV files using RIFF INFO chunks inserted before the data chunk
"""

from datetime import datetime
from typing import Optional
import struct
import os


def add_riff_info_before_data(filename: str, info_dict: dict) -> bool:
    """
    Add RIFF INFO chunk to WAV file, inserting it BEFORE the data chunk.
    This is required for SDR Console and other software to read the metadata.
    
    Args:
        filename: Path to WAV file
        info_dict: Dictionary of INFO tags (e.g., {'INAM': 'Title', 'IART': 'Artist'})
    
    Returns:
        True if successful, False otherwise
    """
    try:
        with open(filename, 'rb') as f:
            data = bytearray(f.read())
        
        # Verify it's a RIFF/WAVE file
        if data[0:4] != b'RIFF' or data[8:12] != b'WAVE':
            return False
        
        # Find the data chunk position
        pos = 12  # Skip RIFF header
        data_chunk_pos = None
        
        while pos < len(data) - 8:
            chunk_id = data[pos:pos+4]
            chunk_size = struct.unpack('<I', data[pos+4:pos+8])[0]
            
            if chunk_id == b'data':
                data_chunk_pos = pos
                break
            
            pos += 8 + chunk_size
            if chunk_size % 2:
                pos += 1
        
        if data_chunk_pos is None:
            print("Warning: Could not find data chunk")
            return False
        
        # Build INFO chunk data
        info_data = bytearray()
        for key, value in info_dict.items():
            if isinstance(value, str):
                value = value.encode('latin-1', errors='replace')
            elif not isinstance(value, bytes):
                value = str(value).encode('latin-1', errors='replace')
            
            # Each INFO tag: 4-byte key, 4-byte size, data with null terminator, optional padding
            key_bytes = key.encode('latin-1') if isinstance(key, str) else key
            info_data += key_bytes[:4].ljust(4, b' ')  # Ensure 4 bytes
            
            value_with_null = value + b'\x00'
            info_data += struct.pack('<I', len(value_with_null))
            info_data += value_with_null
            
            # Pad to even boundary
            if len(value_with_null) % 2:
                info_data += b'\x00'
        
        # Wrap in LIST INFO chunk
        list_chunk = b'LIST'
        list_chunk += struct.pack('<I', len(info_data) + 4)  # +4 for 'INFO' tag
        list_chunk += b'INFO'
        list_chunk += info_data
        
        # Insert LIST chunk before data chunk
        new_data = data[:data_chunk_pos] + list_chunk + data[data_chunk_pos:]
        
        # Update RIFF size (total file size - 8 bytes for RIFF header)
        riff_size = len(new_data) - 8
        new_data[4:8] = struct.pack('<I', riff_size)
        
        # Write back
        with open(filename, 'wb') as f:
            f.write(new_data)
        
        return True
        
    except Exception as e:
        print(f"Warning: Could not add RIFF INFO to {filename}: {e}")
        import traceback
        traceback.print_exc()
        return False


def add_wav_metadata(wav_file: str, frequency_hz: int, iq_mode: str,
                     timestamp: Optional[datetime] = None,
                     callsign: Optional[str] = None,
                     description: Optional[str] = None) -> bool:
    """
    Add metadata tags to a WAV file using RIFF INFO chunks.
    The metadata is inserted BEFORE the data chunk for maximum compatibility.
    
    Args:
        wav_file: Path to the WAV file
        frequency_hz: Frequency in Hz
        iq_mode: IQ mode string (iq48, iq96, iq192)
        timestamp: Recording timestamp (defaults to now)
        callsign: Station callsign (optional)
        description: Station description (optional)
    
    Returns:
        True if metadata was added successfully, False otherwise
    """
    try:
        # Use provided timestamp or current time
        if timestamp is None:
            timestamp = datetime.now()
        
        # Calculate frequency in MHz
        freq_mhz = frequency_hz / 1_000_000.0
        
        # Calculate bandwidth in kHz based on IQ mode
        # For IQ modes, the sample rate equals the bandwidth (not sample_rate/2)
        # because IQ sampling captures the full bandwidth
        sample_rates = {
            'iq48': 48000,
            'iq96': 96000,
            'iq192': 192000,
            'iq384': 384000
        }
        
        sample_rate = sample_rates.get(iq_mode.lower(), 48000)
        bandwidth_khz = sample_rate / 1000.0  # Convert to kHz
        
        # Format date as yyyy-mm-dd hh:mm
        date_str = timestamp.strftime("%Y-%m-%d %H:%M")
        
        # Create title: "<frequency in MHz>, BW <bandwidth in kHz>, <date>"
        title = f"{freq_mhz:.6f} MHz, BW {bandwidth_khz:.0f} kHz, {date_str}"
        
        # Artist: Fixed string
        artist = "UberSDR IQ Recorder, RX888 MKII"

        # Album: Callsign and Description (name)
        album_parts = []
        if callsign:
            album_parts.append(callsign)
        if description:
            album_parts.append(description)
        album = " - ".join(album_parts) if album_parts else "UberSDR Recording"
        
        # Comment with additional details (use ±bandwidth/2 for Nyquist)
        comment = f"Frequency: {frequency_hz} Hz, Mode: {iq_mode}, Bandwidth: ±{bandwidth_khz/2:.0f} kHz"
        
        # Add RIFF INFO chunks (inserted before data chunk for compatibility)
        riff_info = {
            'INAM': title,      # Title/Name
            'IART': artist,     # Artist
            'IPRD': album,      # Product/Album
            'ICMT': comment,    # Comment
        }
        
        success = add_riff_info_before_data(wav_file, riff_info)
        
        if success:
            print(f"✓ Added metadata to {wav_file}")
        
        return success

    except Exception as e:
        # Don't fail silently - show the error so user knows what's wrong
        print(f"Warning: Could not add metadata to {wav_file}: {e}")
        import traceback
        traceback.print_exc()
        return False


def is_metadata_supported() -> bool:
    """
    Check if metadata writing is supported.
    
    Returns:
        True (always supported with built-in struct module)
    """
    return True
