#!/usr/bin/env python3
"""
Audio Decoders for Multi-Instance Client
Handles Opus and PCM-zstd audio decoding
"""

import struct
import numpy as np

# Import Opus decoder (optional)
try:
    import opuslib
    OPUS_AVAILABLE = True
except ImportError:
    OPUS_AVAILABLE = False

# Import zstandard for pcm-zstd (required)
try:
    import zstandard as zstd
    ZSTD_AVAILABLE = True
except ImportError:
    ZSTD_AVAILABLE = False


def decode_opus_binary(binary_data: bytes, opus_decoder, opus_sample_rate, opus_channels, channel_name: str = "AUDIO"):
    """Decode binary Opus packet to PCM bytes.

    Binary packet format from server:
    - 8 bytes: timestamp (uint64, little-endian)
    - 4 bytes: sample rate (uint32, little-endian)
    - 1 byte: channels (uint8)
    - remaining: Opus encoded data

    Args:
        binary_data: Binary packet from server
        opus_decoder: Existing Opus decoder instance (or None to create new)
        opus_sample_rate: Current decoder sample rate (or None)
        opus_channels: Current decoder channel count (or None)
        channel_name: Channel name for logging

    Returns:
        Tuple of (pcm_data, new_decoder, new_sample_rate, new_channels)
        pcm_data is bytes (int16, little-endian) or empty bytes on error
    """
    if len(binary_data) < 13:
        print(f"[{channel_name}] Warning: Binary packet too short: {len(binary_data)} bytes")
        return b'', opus_decoder, opus_sample_rate, opus_channels

    # Parse header
    timestamp = struct.unpack('<Q', binary_data[0:8])[0]
    sample_rate = struct.unpack('<I', binary_data[8:12])[0]
    channels = binary_data[12]
    opus_data = binary_data[13:]

    # Create decoder on first packet or if parameters changed
    if opus_decoder is None or opus_sample_rate != sample_rate or opus_channels != channels:
        if not OPUS_AVAILABLE:
            print(f"[{channel_name}] ERROR: opuslib not available")
            return b'', None, None, None

        try:
            opus_decoder = opuslib.Decoder(sample_rate, channels)
            opus_sample_rate = sample_rate
            opus_channels = channels
            print(f"[{channel_name}] Opus decoder initialized: {sample_rate} Hz, {channels} channel(s)")
        except Exception as e:
            print(f"[{channel_name}] ERROR: Failed to initialize Opus decoder: {e}")
            return b'', None, None, None

    try:
        # Calculate frame size based on sample rate (20ms frame = sample_rate * 0.02)
        # Opus typically uses 20ms frames
        frame_size = int(sample_rate * 0.02)

        # Decode Opus to PCM (returns int16 samples as bytes)
        # CRITICAL: Must match working implementation exactly
        pcm_data = opus_decoder.decode(opus_data, frame_size)
        
        # pcm_data is already bytes (int16, little-endian) - return as-is
        return pcm_data, opus_decoder, opus_sample_rate, opus_channels
    except Exception as e:
        print(f"[{channel_name}] Warning: Opus decode error: {e}")
        import traceback
        print(f"[{channel_name}] Traceback: {traceback.format_exc()}")
        return b'', opus_decoder, opus_sample_rate, opus_channels


def decode_pcm_zstd_binary(binary_data: bytes, zstd_decompressor, channel_name: str = "AUDIO"):
    """Decode binary PCM-zstd packet to PCM bytes.

    Binary packet format from server:
    - Entire packet is zstd-compressed
    - After decompression, contains PCM header + data

    Args:
        binary_data: Binary packet from server (zstd-compressed)
        zstd_decompressor: Zstandard decompressor instance
        channel_name: Channel name for logging

    Returns:
        PCM data as bytes (int16, little-endian) or empty bytes on error
    """
    if not ZSTD_AVAILABLE or zstd_decompressor is None:
        print(f"[{channel_name}] Warning: Received zstd-compressed PCM but zstandard not available")
        return b''

    try:
        # Decompress entire packet
        decompressed = zstd_decompressor.decompress(binary_data)

        if len(decompressed) < 4:
            print(f"[{channel_name}] Warning: Decompressed packet too short: {len(decompressed)} bytes")
            return b''

        # Check magic bytes (little-endian uint16)
        magic = struct.unpack('<H', decompressed[0:2])[0]

        if magic == 0x5043:  # "PC" - Full header (29 bytes)
            if len(decompressed) < 29:
                print(f"[{channel_name}] Warning: Full header packet too short")
                return b''

            # Parse full header
            sample_rate = struct.unpack('<I', decompressed[20:24])[0]
            channels = decompressed[24]
            pcm_data = decompressed[29:]

        elif magic == 0x504D:  # "PM" - Minimal header (13 bytes)
            if len(decompressed) < 13:
                print(f"[{channel_name}] Warning: Minimal header packet too short")
                return b''

            pcm_data = decompressed[13:]

        else:
            print(f"[{channel_name}] Warning: Invalid PCM magic bytes: {hex(magic)}")
            return b''

        # Convert from big-endian to little-endian
        pcm_array = np.frombuffer(pcm_data, dtype='>i2')
        pcm_array_le = pcm_array.astype('<i2')
        return pcm_array_le.tobytes()

    except Exception as e:
        print(f"[{channel_name}] Warning: PCM-zstd decode error: {e}")
        return b''
