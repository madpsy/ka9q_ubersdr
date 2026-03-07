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

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python'))

from radio_client import RadioClient


class IQRecordingClient(RadioClient):
    """Extended RadioClient that captures IQ samples for spectrum display"""
    
    def __init__(self, *args, iq_callback: Optional[Callable] = None, **kwargs):
        """
        Initialize IQ recording client
        
        Args:
            iq_callback: Callback function(i_samples, q_samples) for IQ data
            *args, **kwargs: Passed to RadioClient
        """
        super().__init__(*args, **kwargs)
        self.iq_callback = iq_callback
        self.iq_sample_count = 0
    
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
                print(f"IQ extraction error: {e}")
        
        # Call parent implementation to handle output
        await super().output_audio(pcm_data)
