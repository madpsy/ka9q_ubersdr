#!/usr/bin/env python3
"""
IQ WAV Writer with Metadata
Writes WAV files with auxip XML metadata chunk for Windows compatibility
Matches SDR Console format
"""

import struct
import wave
import os
import tempfile
from datetime import datetime
from typing import Optional, Callable
import xml.etree.ElementTree as ET


class IQWavWriter:
    """
    WAV file writer that includes auxip XML metadata chunk.
    This format is compatible with Windows File Explorer, SDR Console, and other software.
    
    Features:
    - Write buffering (~100 KB) for efficient multi-stream recording
    - Comprehensive error handling for disk full and I/O errors
    - Atomic file operations (write to temp, rename on success)
    - Write verification
    """
    
    # Buffer size for batching writes (100 KB provides good balance)
    WRITE_BUFFER_SIZE = 100 * 1024  # 100 KB
    
    def __init__(self, filename: str, channels: int, sample_width: int, framerate: int,
                 frequency_hz: Optional[int] = None, iq_mode: Optional[str] = None,
                 timestamp: Optional[datetime] = None, callsign: Optional[str] = None,
                 description: Optional[str] = None,
                 error_callback: Optional[Callable[[str, Exception], None]] = None):
        """
        Initialize WAV writer with metadata.
        
        Args:
            filename: Output WAV file path
            channels: Number of audio channels (1=mono, 2=stereo)
            sample_width: Sample width in bytes (2 for 16-bit)
            framerate: Sample rate in Hz
            frequency_hz: Recording frequency in Hz (for metadata)
            iq_mode: IQ mode string (iq48, iq96, iq192) (for metadata)
            timestamp: Recording timestamp (for metadata)
            callsign: Station callsign (for metadata)
            description: Station description (for metadata)
            error_callback: Optional callback for error notifications: callback(error_type, exception)
        """
        self.filename = filename
        self.channels = channels
        self.sample_width = sample_width
        self.framerate = framerate
        self.frequency_hz = frequency_hz
        self.iq_mode = iq_mode
        self.timestamp = timestamp or datetime.now()
        self.callsign = callsign
        self.description = description
        self.error_callback = error_callback
        
        self.file = None
        self.temp_filename = None  # Temporary file for atomic writes
        self.frames_written = 0
        self.data_chunk_start = 0
        self.use_rf64 = False  # Will be set to True if file >4GB
        
        # Write buffering
        self.write_buffer = bytearray()
        self.bytes_written = 0
        self.write_errors = 0
        self.last_error = None
        
    def open(self):
        """Open the WAV file and write headers with metadata."""
        try:
            # Create temporary file in same directory for atomic write
            dir_name = os.path.dirname(self.filename) or '.'
            fd, self.temp_filename = tempfile.mkstemp(
                suffix='.tmp',
                prefix='.iq_recording_',
                dir=dir_name
            )
            
            # Open file descriptor as file object
            self.file = os.fdopen(fd, 'wb')
            
            # Build auxip chunk (for SDR Console)
            auxip_chunk = self._build_auxip_chunk()
            
            # Write RIFF header (placeholder size, will update on close)
            self.file.write(b'RIFF')
            self.file.write(struct.pack('<I', 0))  # Placeholder for file size
            self.file.write(b'WAVE')
            
            # Write fmt chunk (extended format with cbSize field)
            fmt_chunk = self._build_fmt_chunk()
            self.file.write(fmt_chunk)
            
            # Write auxip chunk (for SDR Console) - before data
            if auxip_chunk:
                self.file.write(auxip_chunk)
            
            # Write data chunk header (placeholder size, will update on close)
            self.file.write(b'data')
            self.data_chunk_start = self.file.tell()
            self.file.write(struct.pack('<I', 0))  # Placeholder for data size
            
        except OSError as e:
            self._handle_error("open", e)
            raise
        
    def _build_fmt_chunk(self) -> bytes:
        """Build the fmt chunk with extended format (18 bytes)."""
        # PCM format
        audio_format = 1  # PCM
        byte_rate = self.framerate * self.channels * self.sample_width
        block_align = self.channels * self.sample_width
        bits_per_sample = self.sample_width * 8
        
        # Extended format includes cbSize field (2 bytes) = 0 for PCM
        fmt_data = struct.pack('<HHIIHH',
            audio_format,
            self.channels,
            self.framerate,
            byte_rate,
            block_align,
            bits_per_sample
        )
        fmt_data += struct.pack('<H', 0)  # cbSize = 0 for PCM
        
        return b'fmt ' + struct.pack('<I', len(fmt_data)) + fmt_data
    
    def _build_auxip_chunk(self) -> Optional[bytes]:
        """Build the auxip XML metadata chunk (Windows compatible)."""
        if not self.frequency_hz or not self.iq_mode:
            return None
        
        # Calculate frequency in MHz
        freq_mhz = self.frequency_hz / 1_000_000.0
        
        # Calculate bandwidth in kHz and sample rate
        sample_rates = {
            'iq48': 48000,
            'iq96': 96000,
            'iq192': 192000,
            'iq384': 384000
        }
        sample_rate = sample_rates.get(self.iq_mode.lower(), 48000)
        bandwidth_khz = sample_rate / 1000.0
        
        # Calculate audio parameters
        bits_per_sample = self.sample_width * 8
        bytes_per_second = sample_rate * self.channels * self.sample_width
        
        # Format dates
        date_str = self.timestamp.strftime("%d-%b-%Y %H:%M")
        utc_str = self.timestamp.strftime("%d-%m-%Y %H:%M:%S")
        
        # Unix timestamp
        import time
        utc_seconds = int(self.timestamp.timestamp())
        
        # Build filename from components
        import os
        base_filename = os.path.basename(self.filename)
        
        # Create metadata strings
        title = f"{freq_mhz:.6f} MHz, BW {bandwidth_khz:.0f} kHz, {self.timestamp.strftime('%Y-%m-%d %H:%M')}"
        
        # Album: Callsign and Description
        album_parts = []
        if self.callsign:
            album_parts.append(self.callsign)
        if self.description:
            album_parts.append(self.description)
        album = " - ".join(album_parts) if album_parts else "UberSDR Recording"
        
        # Build XML structure matching SDR Console format EXACTLY
        # Windows reads: RadioCenterFreq, SampleRate, BitsPerSample, BytesPerSecond, UTCSeconds
        xml_str = f'''<?xml version="1.0"?><SDR-XML-Root Description="Saved recording data" Created="{date_str}"><Definition CurrentTimeUTC="{utc_str}" Filename="{base_filename}" FirstFile="{base_filename}" RadioModel="UberSDR" SoftwareName="UberSDR IQ Recorder, RX888 MKII" SoftwareVersion="1.0" UTC="{utc_str}" RadioCenterFreq="{self.frequency_hz}" SampleRate="{sample_rate}" BitsPerSample="{bits_per_sample}" BytesPerSecond="{bytes_per_second}" UTCSeconds="{utc_seconds}"><Receiver Name="{album}" Title="{title}" Frequency="{self.frequency_hz}" Mode="{self.iq_mode}" Bandwidth="{int(bandwidth_khz * 1000)}" /></Definition></SDR-XML-Root>'''
        
        # Encode as UTF-16LE (Windows format)
        xml_bytes = xml_str.encode('utf-16-le')
        
        # Add null terminator
        xml_bytes += b'\x00\x00'
        
        # Pad to even boundary if needed
        if len(xml_bytes) % 2:
            xml_bytes += b'\x00'
        
        # Build auxip chunk
        auxip_chunk = b'auxi' + b'p\x00\x00\x00'  # 'auxip' as chunk ID (4 bytes) + padding
        auxip_chunk = b'auxi'
        auxip_chunk += struct.pack('<I', len(xml_bytes))
        auxip_chunk += xml_bytes
        
        return auxip_chunk
    
    def _build_list_info_chunk(self) -> Optional[bytes]:
        """Build the LIST INFO metadata chunk for Windows compatibility."""
        if not self.frequency_hz or not self.iq_mode:
            return None
        
        # Calculate frequency in MHz
        freq_mhz = self.frequency_hz / 1_000_000.0
        
        # Calculate bandwidth in kHz
        sample_rates = {
            'iq48': 48000,
            'iq96': 96000,
            'iq192': 192000,
            'iq384': 384000
        }
        sample_rate = sample_rates.get(self.iq_mode.lower(), 48000)
        bandwidth_khz = sample_rate / 1000.0
        
        # Format date as yyyy-mm-dd hh:mm
        date_str = self.timestamp.strftime("%Y-%m-%d %H:%M")
        
        # Create metadata strings
        title = f"{freq_mhz:.6f} MHz, BW {bandwidth_khz:.0f} kHz, {date_str}"
        artist = "UberSDR IQ Recorder, RX888 MKII"
        
        # Album: Callsign and Description
        album_parts = []
        if self.callsign:
            album_parts.append(self.callsign)
        if self.description:
            album_parts.append(self.description)
        album = " - ".join(album_parts) if album_parts else "UberSDR Recording"
        
        # Comment with Nyquist bandwidth
        comment = f"Frequency: {self.frequency_hz} Hz, Mode: {self.iq_mode}, Bandwidth: ±{bandwidth_khz/2:.0f} kHz"
        
        # Build INFO chunk data
        info_data = bytearray()
        
        # Add each tag
        for key, value in [('INAM', title), ('IART', artist), ('IPRD', album), ('ICMT', comment)]:
            if value:
                value_bytes = value.encode('latin-1', errors='replace')
                key_bytes = key.encode('latin-1')
                
                info_data += key_bytes[:4].ljust(4, b' ')
                value_with_null = value_bytes + b'\x00'
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
        
        return list_chunk
    
    def writeframes(self, data: bytes):
        """
        Write audio frames to the file with buffering.
        
        Data is buffered until WRITE_BUFFER_SIZE is reached, then flushed to disk.
        This reduces syscall overhead and improves multi-stream performance.
        
        Args:
            data: PCM audio data to write
            
        Raises:
            ValueError: If file not opened
            OSError: If disk write fails (disk full, I/O error, etc.)
        """
        if not self.file:
            raise ValueError("File not opened. Call open() first.")
        
        try:
            # Add data to buffer
            self.write_buffer.extend(data)
            
            # Flush buffer if it exceeds threshold
            if len(self.write_buffer) >= self.WRITE_BUFFER_SIZE:
                self._flush_buffer()
            
            # Update frame count
            self.frames_written += len(data) // (self.channels * self.sample_width)
            
        except OSError as e:
            self._handle_error("write", e)
            raise
    
    def _flush_buffer(self):
        """
        Flush write buffer to disk.
        
        Raises:
            OSError: If disk write fails
        """
        if not self.write_buffer:
            return
        
        try:
            # Write buffer to file
            bytes_to_write = len(self.write_buffer)
            bytes_written = self.file.write(self.write_buffer)
            
            # Verify write completed successfully
            if bytes_written is not None and bytes_written != bytes_to_write:
                raise OSError(f"Partial write: requested {bytes_to_write} bytes, wrote {bytes_written} bytes")
            
            # Track total bytes written
            self.bytes_written += bytes_to_write
            
            # Clear buffer
            self.write_buffer.clear()
            
        except OSError as e:
            self._handle_error("flush", e)
            raise
    
    def _handle_error(self, operation: str, error: Exception):
        """
        Handle I/O errors with logging and callback notification.
        
        Args:
            operation: Operation that failed (open, write, flush, close)
            error: Exception that occurred
        """
        self.write_errors += 1
        self.last_error = error
        
        # Notify via callback if provided
        if self.error_callback:
            try:
                self.error_callback(operation, error)
            except Exception:
                pass  # Don't let callback errors propagate
    
    def close(self):
        """
        Close the file and update chunk sizes atomically.
        
        Uses atomic rename to ensure file is never left in corrupted state.
        Flushes any remaining buffered data before closing.
        """
        if not self.file:
            return
        
        try:
            # Flush any remaining buffered data
            self._flush_buffer()
            
            # Get current position (end of data)
            end_of_data = self.file.tell()
            
            # Calculate data chunk size
            data_size = end_of_data - self.data_chunk_start - 4
            
            # Update data chunk size
            self.file.seek(self.data_chunk_start)
            self.file.write(struct.pack('<I', data_size))
            
            # Seek to end of file to append LIST INFO chunk
            self.file.seek(end_of_data)
            
            # Write LIST INFO chunk AFTER data (for Windows compatibility)
            list_info_chunk = self._build_list_info_chunk()
            if list_info_chunk:
                self.file.write(list_info_chunk)
            
            # Get final file size
            file_size = self.file.tell()
            
            # Update RIFF chunk size (file size - 8 bytes for RIFF header)
            self.file.seek(4)
            self.file.write(struct.pack('<I', file_size - 8))
            
            # Ensure all data is written to disk
            self.file.flush()
            os.fsync(self.file.fileno())
            
            # Close file
            self.file.close()
            self.file = None
            
            # Atomic rename: move temp file to final location
            # This ensures the file is never left in a partially-updated state
            if self.temp_filename:
                os.replace(self.temp_filename, self.filename)
                self.temp_filename = None
                
        except OSError as e:
            self._handle_error("close", e)
            # Clean up temp file on error
            if self.temp_filename and os.path.exists(self.temp_filename):
                try:
                    os.unlink(self.temp_filename)
                except OSError:
                    pass
            raise
        finally:
            # Ensure file is closed even if error occurred
            if self.file:
                try:
                    self.file.close()
                except OSError:
                    pass
                self.file = None
    
    def get_bytes_written(self) -> int:
        """
        Get total bytes written to disk (excluding buffered data).

        Returns:
            Number of bytes written to disk
        """
        return self.bytes_written

    def get_total_bytes(self) -> int:
        """
        Get total bytes including buffered data.

        Returns:
            Number of bytes written + buffered
        """
        return self.bytes_written + len(self.write_buffer)

    def get_stats(self) -> dict:
        """
        Get recording statistics.

        Returns:
            Dictionary with bytes_written, write_errors, buffer_size
        """
        return {
            'bytes_written': self.bytes_written,
            'bytes_buffered': len(self.write_buffer),
            'total_bytes': self.get_total_bytes(),
            'write_errors': self.write_errors,
            'last_error': str(self.last_error) if self.last_error else None
        }
    
    def __enter__(self):
        """Context manager entry."""
        self.open()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        try:
            self.close()
        except OSError:
            # If close fails, ensure temp file is cleaned up
            if self.temp_filename and os.path.exists(self.temp_filename):
                try:
                    os.unlink(self.temp_filename)
                except OSError:
                    pass
            raise
