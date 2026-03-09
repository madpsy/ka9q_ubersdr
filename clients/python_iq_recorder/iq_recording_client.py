#!/usr/bin/env python3
"""
IQ Recording Client
Wrapper around RadioClient that captures IQ data for spectrum display
"""

import sys
import os
import asyncio
import numpy as np
from typing import Optional, Callable
from datetime import datetime

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python'))

from radio_client import RadioClient
from iq_wav_writer import IQWavWriter
from iq_file_manager import IQFileManager


class IQRecordingClient(RadioClient):
    """Extended RadioClient that captures IQ samples for spectrum display"""

    def __init__(self, *args, iq_callback: Optional[Callable] = None,
                 metadata_frequency: Optional[int] = None,
                 metadata_mode: Optional[str] = None,
                 metadata_callsign: Optional[str] = None,
                 metadata_description: Optional[str] = None,
                 error_callback: Optional[Callable[[str, Exception], None]] = None,
                 **kwargs):
        """
        Initialize IQ recording client

        Args:
            iq_callback: Callback function(i_samples, q_samples) for IQ data
            metadata_frequency: Frequency in Hz for metadata
            metadata_mode: IQ mode for metadata
            metadata_callsign: Station callsign for metadata
            metadata_description: Station description for metadata
            error_callback: Callback for I/O errors: callback(error_type, exception)
            *args, **kwargs: Passed to RadioClient
        """
        super().__init__(*args, **kwargs)
        self.iq_callback = iq_callback
        self.iq_sample_count = 0
        self.metadata_frequency = metadata_frequency
        self.metadata_mode = metadata_mode
        self.metadata_callsign = metadata_callsign
        self.metadata_description = metadata_description
        self.error_callback = error_callback
    
    def setup_wav_writer(self):
        """Override to use custom IQWavWriter with metadata and disk space checking."""
        if self.wav_file:
            # Check disk space before starting recording
            try:
                file_manager = IQFileManager(os.path.dirname(self.wav_file) or '.')
                space_info = file_manager.get_disk_space()

                # Estimate required space for recording (if duration is known)
                if hasattr(self, 'duration') and self.duration:
                    required_bytes = file_manager.estimate_recording_size(
                        self.metadata_mode or 'iq96',
                        self.duration
                    )

                    # Add 10% safety margin
                    required_bytes = int(required_bytes * 1.1)

                    # Calculate data rate for logging
                    data_rate_kbps = (required_bytes / self.duration) / 1024  # KB/s

                    print(f"Disk space check: Mode={self.metadata_mode}, "
                          f"Duration={self.duration}s, Rate={data_rate_kbps:.1f} KB/s, "
                          f"Need={file_manager.format_bytes(required_bytes)} (with 10% margin), "
                          f"Available={file_manager.format_bytes(space_info['free'])}", file=sys.stderr)

                    if not file_manager.check_disk_space_available(required_bytes):
                        raise OSError(
                            f"Insufficient disk space: need {file_manager.format_bytes(required_bytes)}, "
                            f"only {file_manager.format_bytes(space_info['free'])} available"
                        )
                else:
                    # Unlimited duration - just log available space
                    print(f"Disk space check (unlimited duration): "
                          f"Mode={self.metadata_mode}, "
                          f"Available={file_manager.format_bytes(space_info['free'])}", file=sys.stderr)

            except OSError:
                # Re-raise OSError (disk space issues)
                raise
            except Exception as e:
                print(f"Warning: Disk space check failed: {e}", file=sys.stderr)

            # Use custom WAV writer that includes metadata
            self.wav_writer = IQWavWriter(
                filename=self.wav_file,
                channels=self.channels,
                sample_width=2,  # 16-bit
                framerate=self.sample_rate,
                frequency_hz=self.metadata_frequency,
                iq_mode=self.metadata_mode,
                timestamp=datetime.now(),
                callsign=self.metadata_callsign,
                description=self.metadata_description,
                error_callback=self.error_callback
            )
            self.wav_writer.open()
            print(f"Recording to WAV file with metadata: {self.wav_file} ({self.channels} channel(s))", file=sys.stderr)
    
    async def output_audio(self, pcm_data: bytes):
        """Override to capture IQ samples before output"""
        # If this is an IQ mode and we have a callback, extract samples
        if self.iq_callback and self.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384'):
            try:
                # PCM data is int16, stereo (I and Q channels)
                # Convert to numpy array
                audio_array = np.frombuffer(pcm_data, dtype=np.int16)

                # De-interleave into I and Q channels
                i_samples = audio_array[0::2].astype(np.float32) / 32768.0
                q_samples = audio_array[1::2].astype(np.float32) / 32768.0

                # Send to callback
                if len(i_samples) > 0 and len(q_samples) > 0:
                    self.iq_callback(i_samples, q_samples)
                    self.iq_sample_count += len(i_samples)
            except Exception as e:
                # Don't let spectrum processing break recording
                print(f"IQ extraction error: {e}", file=sys.stderr)

        # Call parent implementation to handle output
        try:
            await super().output_audio(pcm_data)
        except OSError as e:
            # Handle disk I/O errors gracefully
            print(f"ERROR: Disk write failed: {e}", file=sys.stderr)
            if self.error_callback:
                self.error_callback("write", e)
            # Stop recording on disk error
            self.running = False
            raise
