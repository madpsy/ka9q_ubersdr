#!/usr/bin/env python3
"""
CLI Radio Client for ka9q_ubersdr
Connects to the WebSocket server and outputs audio to PipeWire, stdout, or WAV file.
"""

import argparse
import asyncio
import atexit
import base64
import json
import os
import platform
import signal
import socket
import stat
import struct
import sys
import time
import uuid
import wave
from typing import Optional, List, Tuple, Dict

import aiohttp
import websockets
import requests
from urllib.parse import urlparse, parse_qs, urlencode
import numpy as np
import subprocess
import re

# Import Opus decoder (optional)
try:
    import opuslib
    OPUS_AVAILABLE = True
except ImportError:
    OPUS_AVAILABLE = False
    print("Warning: opuslib not available, Opus decoding disabled", file=sys.stderr)
    print("Install with: pip install opuslib", file=sys.stderr)

# Import NR2 processor (optional, only if scipy is available)
try:
    from nr2 import create_nr2_processor
    NR2_AVAILABLE = True
except ImportError:
    NR2_AVAILABLE = False
    print("Warning: scipy not available, NR2 noise reduction disabled", file=sys.stderr)

# Import scipy for audio filter (optional)
try:
    from scipy import signal as scipy_signal
    SCIPY_AVAILABLE = True
except ImportError:
    SCIPY_AVAILABLE = False
    print("Warning: scipy not available, audio bandpass filter disabled", file=sys.stderr)

# Import PyAudio for cross-platform audio output (optional)
try:
    import pyaudio
    PYAUDIO_AVAILABLE = True
except ImportError:
    PYAUDIO_AVAILABLE = False

# Import sounddevice for better cross-platform audio (optional)
try:
    import sounddevice as sd
    SOUNDDEVICE_AVAILABLE = True
except ImportError:
    SOUNDDEVICE_AVAILABLE = False

# Import samplerate for high-quality streaming resampling (optional)
try:
    import samplerate
    SAMPLERATE_AVAILABLE = True
except ImportError:
    SAMPLERATE_AVAILABLE = False
    print("Warning: samplerate not available, audio resampling disabled", file=sys.stderr)
    print("Install with: pip install samplerate", file=sys.stderr)


def get_pipewire_sinks() -> List[Tuple[str, str]]:
    """Get list of available PipeWire audio sinks.
    
    Returns:
        List of tuples (node_name, description) for audio sinks, sorted alphabetically. Empty list on Windows or if PipeWire not available.
    """
    import platform

    # PipeWire not available on Windows
    if platform.system() == 'Windows':
        return []

    try:
        result = subprocess.run(
            ['pw-cli', 'list-objects', 'Node'],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        sinks = []
        lines = result.stdout.split('\n')
        
        current_node_name = None
        current_nick = None
        current_media_class = None
        
        for line in lines:
            line = line.strip()
            
            # Look for node.name
            if 'node.name = ' in line:
                match = re.search(r'node\.name = "([^"]+)"', line)
                if match:
                    current_node_name = match.group(1)
            
            # Look for node.nick (friendly name)
            elif 'node.nick = ' in line:
                match = re.search(r'node\.nick = "([^"]+)"', line)
                if match:
                    current_nick = match.group(1)
            
            # Look for media.class
            elif 'media.class = ' in line:
                match = re.search(r'media\.class = "([^"]+)"', line)
                if match:
                    current_media_class = match.group(1)
            
            # When we hit a new object ID, process the previous one
            elif line.startswith('id ') and current_node_name:
                # Only include Audio/Sink devices
                if current_media_class == 'Audio/Sink':
                    description = current_nick if current_nick else current_node_name
                    sinks.append((current_node_name, description))
                
                # Reset for next object
                current_node_name = None
                current_nick = None
                current_media_class = None
        
        # Process last object if it was a sink
        if current_node_name and current_media_class == 'Audio/Sink':
            description = current_nick if current_nick else current_node_name
            sinks.append((current_node_name, description))
        
        # Sort sinks alphabetically by description (case-insensitive)
        sinks.sort(key=lambda x: x[1].lower())

        return sinks

    except (subprocess.TimeoutExpired, FileNotFoundError, Exception) as e:
        print(f"Warning: Could not list PipeWire sinks: {e}", file=sys.stderr)
        return []


def get_pyaudio_devices() -> List[Tuple[int, str]]:
    """Get list of available PyAudio output devices.

    Returns:
        List of tuples (device_index, device_name) for output devices, sorted alphabetically. Empty list if PyAudio not available.
    """
    if not PYAUDIO_AVAILABLE:
        return []

    try:
        p = pyaudio.PyAudio()
        devices = []

        # Get default output device info
        try:
            default_info = p.get_default_output_device_info()
            default_index = default_info['index']
        except:
            default_index = None

        # Enumerate all devices
        for i in range(p.get_device_count()):
            try:
                info = p.get_device_info_by_index(i)
                # Only include output devices (maxOutputChannels > 0)
                if info['maxOutputChannels'] > 0:
                    name = info['name']

                    # Get host API info to differentiate between subsystems
                    host_api_index = info.get('hostApi', 0)
                    host_api_info = p.get_host_api_info_by_index(host_api_index)
                    host_api_name = host_api_info.get('name', 'Unknown')

                    # Format: "Device Name [API]" or "Device Name [API] (default)"
                    display_name = f"{name} [{host_api_name}]"

                    # Mark default device
                    if i == default_index:
                        display_name = f"{display_name} (default)"

                    devices.append((i, display_name))
            except Exception:
                continue

        p.terminate()

        # Sort devices alphabetically by name (case-insensitive)
        devices.sort(key=lambda x: x[1].lower())

        return devices

    except Exception as e:
        print(f"Warning: Could not list PyAudio devices: {e}", file=sys.stderr)
        return []


def get_sounddevice_devices(wasapi_only: bool = False) -> List[Tuple[int, str]]:
    """Get list of available sounddevice output devices.

    Args:
        wasapi_only: On Windows, only show WASAPI devices (default: False shows all except DirectSound)

    Returns:
        List of tuples (device_index, device_name) for output devices, sorted alphabetically. Empty list if sounddevice not available.
    """
    if not SOUNDDEVICE_AVAILABLE:
        return []

    try:
        devices = []
        device_list = sd.query_devices()
        default_device = sd.default.device[1]  # Output device

        for i, info in enumerate(device_list):
            # Only include output devices (max_output_channels > 0)
            if info['max_output_channels'] > 0:
                name = info['name']
                host_api_name = sd.query_hostapis(info['hostapi'])['name']

                # On Windows, filter devices based on wasapi_only flag
                if platform.system() == 'Windows':
                    # Always hide DirectSound devices (poor format support)
                    if 'DirectSound' in host_api_name:
                        continue

                    # If wasapi_only is True, only show WASAPI devices
                    if wasapi_only and 'WASAPI' not in host_api_name:
                        continue

                # Format: "Device Name [API]" or "Device Name [API] (default)"
                display_name = f"{name} [{host_api_name}]"

                # Mark default device
                if i == default_device:
                    display_name = f"{display_name} (default)"

                devices.append((i, display_name))

        # Sort devices alphabetically by name (case-insensitive)
        devices.sort(key=lambda x: x[1].lower())

        return devices

    except Exception as e:
        print(f"Warning: Could not list sounddevice devices: {e}", file=sys.stderr)
        return []


class RadioClient:
    """WebSocket radio client for receiving and outputting audio."""
    
    def __init__(self, url: Optional[str] = None, host: Optional[str] = None,
                 port: Optional[int] = None, frequency: int = 0, mode: str = '',
                 bandwidth_low: Optional[int] = None, bandwidth_high: Optional[int] = None,
                 output_mode: str = 'pipewire', wav_file: Optional[str] = None,
                 duration: Optional[float] = None, ssl: bool = False, password: Optional[str] = None,
                 nr2_enabled: bool = False, nr2_strength: float = 40.0,
                 nr2_floor: float = 10.0, nr2_adapt_rate: float = 1.0,
                 auto_reconnect: bool = False, status_callback=None,
                 volume: float = 1.0, channel_left: bool = True, channel_right: bool = True,
                 audio_level_callback=None, recording_callback=None, fifo_path: Optional[str] = None,
                 audio_filter_enabled: bool = False, audio_filter_low: float = 300.0,
                 audio_filter_high: float = 2700.0, pyaudio_device_index: Optional[int] = None,
                 sounddevice_device_index: Optional[int] = None, udp_host: Optional[str] = None,
                 udp_port: Optional[int] = None, output_channels: Optional[int] = None,
                 udp_enabled: bool = False, udp_stereo: bool = False, use_opus: bool = False):
        self.url = url
        self.host = host
        self.port = port
        self.frequency = frequency
        self.mode = mode.lower()
        self.bandwidth_low = bandwidth_low
        self.bandwidth_high = bandwidth_high
        self.output_mode = output_mode
        self.wav_file = wav_file
        self.duration = duration
        self.ssl = ssl
        self.password = password
        
        self.user_session_id = str(uuid.uuid4())
        self.server_session_id = None  # Will be set from server's status message
        self.running = True
        self.start_time = None
        self.sample_rate = 12000  # Default, will be updated from server
        self.ws = None  # WebSocket connection reference for sending messages
        self.server_description = {}  # Server description from /api/description
        self.countries = []  # Country list from /api/cty/countries
        self.bypassed = False  # Connection bypassed status from /connection endpoint (deprecated)
        self.allowed_iq_modes = []  # List of allowed IQ modes from /connection endpoint
        self.max_session_time = 0  # Maximum session time in seconds (0 = unlimited)
        self.connection_start_time = None  # Time when connection was established
        self.connection_rejected = False  # Flag indicating if connection was rejected
        self.rejection_reason = ""  # Reason for connection rejection

        # Opus support (disabled for IQ modes as they need lossless data)
        is_iq_mode = self.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')
        self.use_opus = use_opus and OPUS_AVAILABLE and not is_iq_mode
        self.opus_decoder = None
        if self.use_opus:
            try:
                # Create Opus decoder (48 kHz, stereo for compatibility)
                # Server will send at actual sample rate, we'll handle resampling if needed
                self.opus_decoder = opuslib.Decoder(48000, 2)
                print(f"Opus decoder initialized (bandwidth savings: ~90%)", file=sys.stderr)
            except Exception as e:
                print(f"Warning: Failed to initialize Opus decoder: {e}", file=sys.stderr)
                self.use_opus = False
        elif use_opus and is_iq_mode:
            print("Warning: Opus not supported for IQ modes (lossless required)", file=sys.stderr)

        # FIFO (named pipe) output
        self.fifo_path = fifo_path
        self.fifo_fd = None
        self.fifo_created_by_us = False  # Track if we created the FIFO

        # Register cleanup handler for FIFO
        if self.fifo_path:
            atexit.register(self._cleanup_fifo_on_exit)

        # Determine default channels based on mode
        # IQ modes are stereo (I and Q channels), others are mono
        if self.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384'):
            self.channels = 2
        else:
            self.channels = 1

        # Output channels: number of channels to output (can differ from input channels)
        # Default: 1 for stdout/udp (for compatibility), 2 for other outputs (for left/right control)
        # Can be overridden with output_channels parameter
        if output_channels is not None:
            self.output_channels = output_channels
        elif output_mode in ('stdout', 'udp'):
            # Default to 1 channel for stdout/udp for better compatibility
            self.output_channels = 1
        else:
            # Default to 2 channels for audio devices to support left/right channel control
            self.output_channels = 2

        self.wav_writer = None
        self.pipewire_process = None
        
        # PyAudio output
        self.pyaudio_instance = None
        self.pyaudio_stream = None
        self.pyaudio_device_index = pyaudio_device_index  # Device index for PyAudio (None = default)

        # sounddevice output
        self.sounddevice_stream = None
        self.sounddevice_device_index = sounddevice_device_index  # Device index for sounddevice (None = default)
        self.sounddevice_output_rate = self.sample_rate  # Output sample rate (may differ from input)
        self.sounddevice_wasapi_checked = False  # Cache flag to avoid repeated WASAPI lookups

        # Resample to 48 kHz for better compatibility across all platforms
        # Most audio hardware doesn't support 12 kHz natively
        # Use samplerate library for stateful, click-free resampling
        # IMPORTANT: Never resample IQ modes - they need exact sample rates
        is_iq_mode = self.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')
        self.needs_resampling = (output_mode == 'sounddevice' and SAMPLERATE_AVAILABLE and not is_iq_mode)
        self.resampler_left = None  # Stateful resampler for left channel
        self.resampler_right = None  # Stateful resampler for right channel

        # Auto-reconnect settings
        self.auto_reconnect = auto_reconnect
        self.retry_count = 0
        self.max_backoff = 60  # Maximum backoff time in seconds
        
        # Status callback for GUI integration
        self.status_callback = status_callback
        
        # NR2 noise reduction
        self.nr2_enabled = nr2_enabled
        self.nr2_processor = None
        if self.nr2_enabled:
            if not NR2_AVAILABLE:
                print("Error: NR2 requested but scipy not available", file=sys.stderr)
                print("Install scipy with: pip install scipy", file=sys.stderr)
                sys.exit(1)
            self.nr2_processor = create_nr2_processor(
                sample_rate=self.sample_rate,
                strength=nr2_strength,
                floor=nr2_floor,
                adapt_rate=nr2_adapt_rate
            )
            print(f"NR2 noise reduction enabled (strength={nr2_strength}%, floor={nr2_floor}%, adapt={nr2_adapt_rate}%)", file=sys.stderr)
        
        # Audio controls
        self.volume = max(0.0, min(2.0, volume))  # Clamp between 0.0 and 2.0 (0-200%)
        self.channel_left = channel_left
        self.channel_right = channel_right
        self.status_callback = status_callback
        self.audio_level_callback = audio_level_callback
        self.audio_level_update_counter = 0
        self.recording_callback = recording_callback
        
        # Audio bandpass filter
        self.audio_filter_enabled = audio_filter_enabled
        self.audio_filter_low = audio_filter_low
        self.audio_filter_high = audio_filter_high
        self.audio_filter_taps = None  # FIR filter coefficients
        self.audio_filter_zi = None    # Filter state for continuous filtering
        if self.audio_filter_enabled:
            if not SCIPY_AVAILABLE:
                print("Error: Audio filter requested but scipy not available", file=sys.stderr)
                print("Install scipy with: pip install scipy", file=sys.stderr)
                sys.exit(1)
            self._init_audio_filter()
            print(f"Audio bandpass filter enabled ({audio_filter_low:.0f}-{audio_filter_high:.0f} Hz)", file=sys.stderr)
        
        # 10-band equalizer
        self.eq_enabled = False
        self.eq_band_gains = {}  # Dictionary of {frequency: gain_db}
        self.eq_sos = None       # Combined second-order sections for all EQ bands
        self.eq_zi = None        # Filter state for EQ
        
        # UDP output (can work as additional output alongside main output)
        self.udp_socket = None
        self.udp_host = udp_host if udp_host else '127.0.0.1'
        self.udp_port = udp_port if udp_port else 8888
        self.udp_enabled = udp_enabled
        self.udp_stereo = udp_stereo  # UDP stereo mode (default: mono)

        # Initialize UDP socket if enabled (works with any output mode)
        if self.udp_enabled or self.output_mode == 'udp':
            try:
                self.udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                stereo_str = "stereo" if self.udp_stereo else "mono"
                print(f"UDP output configured: {self.udp_host}:{self.udp_port} ({stereo_str})", file=sys.stderr)
            except Exception as e:
                print(f"Warning: Failed to create UDP socket: {e}", file=sys.stderr)
                self.udp_enabled = False
    
    def _prepare_udp_audio(self, audio_float):
        """Prepare audio for UDP output (mono by default, stereo if enabled).

        This method processes audio independently of the main output channel selection.
        UDP output is always mono unless udp_stereo is True.

        Args:
            audio_float: Audio data before channel selection (mono or stereo)

        Returns:
            Processed audio for UDP (mono or stereo based on udp_stereo setting)
        """
        # audio_float at this point is after volume/NR2/filter/EQ but before channel selection
        # It's mono for non-IQ modes, stereo for IQ modes or if converted from mono

        if self.udp_stereo:
            # Stereo mode: ensure we have 2 channels
            if audio_float.ndim == 1:
                # Mono input - duplicate to stereo
                return np.column_stack((audio_float, audio_float))
            else:
                # Already stereo
                return audio_float
        else:
            # Mono mode (default): convert to mono if needed
            if audio_float.ndim == 2:
                # Stereo input - mix to mono
                return np.mean(audio_float, axis=1)
            else:
                # Already mono
                return audio_float

    def _init_audio_filter(self):
        """Initialize audio bandpass filter using FIR design."""
        if not SCIPY_AVAILABLE:
            return

        # Validate filter parameters
        if self.audio_filter_low >= self.audio_filter_high:
            print(f"Warning: Invalid filter range {self.audio_filter_low}-{self.audio_filter_high} Hz", file=sys.stderr)
            self.audio_filter_enabled = False
            return

        nyquist = self.sample_rate / 2.0
        if self.audio_filter_high >= nyquist:
            print(f"Warning: Filter high cutoff {self.audio_filter_high} Hz exceeds Nyquist {nyquist} Hz", file=sys.stderr)
            self.audio_filter_enabled = False
            return

        try:
            # Design an FIR bandpass filter using firwin
            # FIR filters have linear phase and no overshoot/ringing issues
            # Use a reasonable number of taps based on sample rate
            numtaps = min(int(self.sample_rate / 10), 1001)  # Cap at 1001 taps
            if numtaps % 2 == 0:
                numtaps += 1  # Must be odd for bandpass

            self.audio_filter_taps = scipy_signal.firwin(
                numtaps,
                [self.audio_filter_low, self.audio_filter_high],
                pass_zero=False,  # Bandpass filter
                fs=self.sample_rate
            )
            # Initialize filter state for continuous filtering
            self.audio_filter_zi = scipy_signal.lfilter_zi(self.audio_filter_taps, 1.0) * 0.0
        except Exception as e:
            print(f"Warning: Failed to create audio filter: {e}", file=sys.stderr)
            self.audio_filter_enabled = False

    def update_audio_filter(self, low: float, high: float):
        """Update audio filter parameters dynamically.

        Args:
            low: Low cutoff frequency in Hz
            high: High cutoff frequency in Hz
        """
        self.audio_filter_low = low
        self.audio_filter_high = high

        if self.audio_filter_enabled and SCIPY_AVAILABLE:
            self._init_audio_filter()

    def update_eq(self, band_gains: dict):
        """Update EQ band gains and reinitialize filters.

        Args:
            band_gains: Dictionary of {frequency: gain_db}
        """
        if not SCIPY_AVAILABLE:
            return

        self.eq_band_gains = band_gains.copy()

        # Design second-order sections (SOS) for each EQ band
        # SOS format is more numerically stable than transfer function
        sos_list = []

        # Nyquist frequency (half of sample rate)
        nyquist = self.sample_rate / 2.0

        for freq, gain_db in sorted(band_gains.items()):
            if abs(gain_db) < 0.1:
                # Skip bands with negligible gain
                continue

            # Skip frequencies too close to Nyquist (need some margin for filter design)
            # Use 80% of Nyquist as safe limit
            if freq >= nyquist * 0.8:
                continue

            try:
                # Design a proper peaking EQ filter using Audio EQ Cookbook formulas
                # Reference: https://www.w3.org/TR/audio-eq-cookbook/
                Q = 1.0  # Q factor (bandwidth) - 1.0 gives about 1.3 octave bandwidth
                A = 10 ** (gain_db / 40.0)  # Amplitude (not power), so divide by 40 not 20

                # Calculate intermediate values
                w0 = 2 * np.pi * freq / self.sample_rate
                cos_w0 = np.cos(w0)
                sin_w0 = np.sin(w0)
                alpha = sin_w0 / (2 * Q)

                # Peaking EQ biquad coefficients (from Audio EQ Cookbook)
                b0 = 1 + alpha * A
                b1 = -2 * cos_w0
                b2 = 1 - alpha * A
                a0 = 1 + alpha / A
                a1 = -2 * cos_w0
                a2 = 1 - alpha / A

                # Normalize and create SOS section [b0, b1, b2, a0, a1, a2]
                sos_section = np.array([[b0/a0, b1/a0, b2/a0, 1.0, a1/a0, a2/a0]])

                sos_list.append(sos_section)

            except Exception as e:
                print(f"Warning: Failed to create EQ filter for {freq} Hz: {e}", file=sys.stderr)

        if sos_list:
            # Concatenate all SOS sections into one filter
            self.eq_sos = np.vstack(sos_list)
            # Initialize filter state - must match the number of sections
            # sosfilt_zi returns shape (n_sections, 2) for the filter state
            self.eq_zi = scipy_signal.sosfilt_zi(self.eq_sos)
        else:
            self.eq_sos = None
            self.eq_zi = None

    def _log(self, message: str):
        """Log a message to stderr and optionally to status callback for GUI."""
        print(message, file=sys.stderr)
        if self.status_callback:
            self.status_callback("info", message)
    
    def build_websocket_url(self) -> str:
        """Build the WebSocket URL with query parameters."""
        # Check if this is an IQ mode (bandwidth should not be sent for IQ modes)
        is_iq_mode = self.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')

        # If full URL provided, parse and merge parameters
        if self.url:
            parsed = urlparse(self.url)
            base_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path or '/ws'}"
            
            # Parse existing query parameters
            existing_params = parse_qs(parsed.query)
            params = {}
            
            # Use existing params as defaults, override with our values
            for key, value in existing_params.items():
                params[key] = value[0] if isinstance(value, list) else value
            
            # Override/add our parameters
            params['frequency'] = str(self.frequency)
            params['mode'] = self.mode
            params['user_session_id'] = self.user_session_id
            
            # Only include bandwidth for non-IQ modes
            if not is_iq_mode:
                if self.bandwidth_low is not None:
                    params['bandwidthLow'] = str(self.bandwidth_low)
                if self.bandwidth_high is not None:
                    params['bandwidthHigh'] = str(self.bandwidth_high)
            
            # Add password if provided
            if self.password:
                params['password'] = self.password
            
            # Add format parameter for Opus
            if self.use_opus:
                params['format'] = 'opus'

            return f"{base_url}?{urlencode(params)}"
        else:
            # Build URL from host/port/ssl
            protocol = 'wss' if self.ssl else 'ws'
            url = f"{protocol}://{self.host}:{self.port}/ws"
            url += f"?frequency={self.frequency}"
            url += f"&mode={self.mode}"
            url += f"&user_session_id={self.user_session_id}"
            
            # Only include bandwidth for non-IQ modes
            if not is_iq_mode:
                if self.bandwidth_low is not None:
                    url += f"&bandwidthLow={self.bandwidth_low}"
                if self.bandwidth_high is not None:
                    url += f"&bandwidthHigh={self.bandwidth_high}"
            
            # Add password if provided
            if self.password:
                from urllib.parse import quote
                url += f"&password={quote(self.password)}"
            
            # Add format parameter for Opus
            if self.use_opus:
                url += "&format=opus"

            return url
    
    def setup_wav_writer(self):
        """Initialize WAV file writer."""
        if self.wav_file:
            self.wav_writer = wave.open(self.wav_file, 'wb')
            self.wav_writer.setnchannels(self.channels)  # Mono or stereo
            self.wav_writer.setsampwidth(2)  # 16-bit
            self.wav_writer.setframerate(self.sample_rate)
            print(f"Recording to WAV file: {self.wav_file} ({self.channels} channel(s))", file=sys.stderr)
    
    def setup_fifo(self):
        """Create FIFO file (doesn't open it yet)."""
        if self.fifo_path is None:
            return

        try:
            # Check if path exists
            if os.path.exists(self.fifo_path):
                # Verify it's a FIFO
                if not stat.S_ISFIFO(os.stat(self.fifo_path).st_mode):
                    raise ValueError(f"{self.fifo_path} exists but is not a FIFO")
                print(f"Using existing FIFO: {self.fifo_path}", file=sys.stderr)
            else:
                # Create new FIFO
                os.mkfifo(self.fifo_path)
                self.fifo_created_by_us = True
                print(f"Created FIFO: {self.fifo_path}", file=sys.stderr)

            print(f"FIFO ready at: {self.fifo_path} (will open when reader connects)", file=sys.stderr)

        except Exception as e:
            print(f"Warning: Failed to setup FIFO: {e}", file=sys.stderr)
            self.fifo_path = None

    async def setup_pipewire(self):
        """Start PipeWire playback process."""
        try:
            # Use configured output channels
            output_channels = self.output_channels

            # Use pw-play for PipeWire audio output
            self.pipewire_process = await asyncio.create_subprocess_exec(
                'pw-play',
                '--format=s16',
                '--rate', str(self.sample_rate),
                f'--channels={output_channels}',
                '-',
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL
            )
            print(f"PipeWire output started (sample rate: {self.sample_rate} Hz, channels: {output_channels})", file=sys.stderr)
            # Only show "Loading GUI" message when GUI is active (status_callback is set)
            if self.status_callback:
                print("Loading GUI (may take a moment)...", file=sys.stderr)
        except FileNotFoundError:
            print("Error: pw-play not found. Please install pipewire-utils.", file=sys.stderr)
            # Don't terminate the program - just disable PipeWire output
            # This allows TCI server, UDP, FIFO and other functionality to continue
            self.pipewire_process = None
            # Don't set self.running = False - that would stop everything
            # Just log the error and continue without PipeWire output
            if self.status_callback:
                self.status_callback("error", "pw-play not found. Please install pipewire-utils.")
    
    async def setup_pyaudio(self):
        """Start PyAudio playback stream."""
        if not PYAUDIO_AVAILABLE:
            print("Error: PyAudio not available. Install with: pip install pyaudio", file=sys.stderr)
            sys.exit(1)

        try:
            # Use configured output channels
            output_channels = self.output_channels

            self.pyaudio_instance = pyaudio.PyAudio()

            # On Windows, use 48 kHz to avoid high latency from resampling
            # Windows audio APIs (MME/DirectSound) don't support 12 kHz natively
            if self.pyaudio_needs_resampling:
                self.pyaudio_output_rate = 48000
                if not SCIPY_AVAILABLE:
                    print("Error: Windows PyAudio requires scipy for resampling. Install with: pip install scipy", file=sys.stderr)
                    sys.exit(1)
                print(f"Windows detected: Resampling {self.sample_rate} Hz -> {self.pyaudio_output_rate} Hz for low latency", file=sys.stderr)
            else:
                self.pyaudio_output_rate = self.sample_rate

            # Build kwargs for stream opening
            stream_kwargs = {
                'format': pyaudio.paInt16,
                'channels': output_channels,
                'rate': self.pyaudio_output_rate,
                'output': True,
                'frames_per_buffer': 1024
            }

            # Add device index if specified
            if self.pyaudio_device_index is not None:
                stream_kwargs['output_device_index'] = self.pyaudio_device_index
                device_info = self.pyaudio_instance.get_device_info_by_index(self.pyaudio_device_index)
                device_name = device_info.get('name', 'Unknown')
                print(f"PyAudio output started on device [{self.pyaudio_device_index}] {device_name} (sample rate: {self.pyaudio_output_rate} Hz, channels: {output_channels})", file=sys.stderr)
            else:
                print(f"PyAudio output started (sample rate: {self.pyaudio_output_rate} Hz, channels: {output_channels})", file=sys.stderr)

            self.pyaudio_stream = self.pyaudio_instance.open(**stream_kwargs)

            # Only show "Loading GUI" message when GUI is active (status_callback is set)
            if self.status_callback:
                print("Loading GUI (may take a moment)...", file=sys.stderr)
        except Exception as e:
            print(f"Error: Failed to initialize PyAudio: {e}", file=sys.stderr)
            # Don't terminate the program - just disable PyAudio output
            # This allows TCI server, UDP, FIFO and other functionality to continue
            self.pyaudio_stream = None
            # Don't set self.running = False - that would stop everything
            # Just log the error and continue without PyAudio output
            if self.status_callback:
                self.status_callback("error", f"Failed to initialize PyAudio: {e}")

    async def setup_sounddevice(self):
        """Start sounddevice playback stream."""
        if not SOUNDDEVICE_AVAILABLE:
            print("Error: sounddevice not available. Install with: pip install sounddevice", file=sys.stderr)
            sys.exit(1)

        try:
            # Use configured output channels
            output_channels = self.output_channels

            # Use 48 kHz for better hardware compatibility across all platforms
            # Most audio hardware doesn't support 12 kHz natively
            if self.needs_resampling:
                self.sounddevice_output_rate = 48000
                if not SAMPLERATE_AVAILABLE:
                    print("Error: sounddevice requires samplerate for resampling. Install with: pip install samplerate", file=sys.stderr)
                    sys.exit(1)

                print(f"Resampling {self.sample_rate} Hz -> {self.sounddevice_output_rate} Hz using samplerate (stateful, click-free)", file=sys.stderr)
            else:
                self.sounddevice_output_rate = self.sample_rate

            # Configure sounddevice stream
            device_info = None
            if self.sounddevice_device_index is not None:
                device_info = sd.query_devices(self.sounddevice_device_index)
                device_name = device_info['name']
                host_api_name = sd.query_hostapis(device_info['hostapi'])['name']
                print(f"sounddevice output started on device [{self.sounddevice_device_index}] {device_name} (sample rate: {self.sounddevice_output_rate} Hz, channels: {output_channels})", file=sys.stderr)
                print(f"Using host API: {host_api_name}", file=sys.stderr)
            else:
                print(f"sounddevice output started (sample rate: {self.sounddevice_output_rate} Hz, channels: {output_channels})", file=sys.stderr)

            # On Windows, prefer WASAPI over DirectSound for better format support
            # WASAPI is the modern Windows audio API with lower latency and better compatibility
            # Only do this lookup once and cache the result to avoid stalls on frequency changes
            extra_settings = None
            if platform.system() == 'Windows' and not self.sounddevice_wasapi_checked:
                self.sounddevice_wasapi_checked = True
                # Try to find WASAPI host API
                try:
                    wasapi_hostapi = None
                    for i, api in enumerate(sd.query_hostapis()):
                        if 'WASAPI' in api['name']:
                            wasapi_hostapi = i
                            break

                    if wasapi_hostapi is not None:
                        # Determine which device to check
                        device_to_check = self.sounddevice_device_index
                        if device_to_check is None:
                            # Use default output device
                            device_to_check = sd.default.device[1]
                        
                        # Get device info
                        device = sd.query_devices(device_to_check)
                        device_name = device['name']
                        current_hostapi = device['hostapi']
                        
                        # Only apply WASAPI settings if device is already WASAPI or we can find WASAPI equivalent
                        if current_hostapi == wasapi_hostapi:
                            # Device is already WASAPI, use WASAPI settings
                            extra_settings = sd.WasapiSettings(exclusive=False)
                            print("Using WASAPI (Windows Audio Session API) for better compatibility", file=sys.stderr)
                        else:
                            # Try to find WASAPI device with same name
                            wasapi_device_found = False
                            for i, dev in enumerate(sd.query_devices()):
                                if dev['hostapi'] == wasapi_hostapi and dev['name'] == device_name and dev['max_output_channels'] > 0:
                                    self.sounddevice_device_index = i
                                    extra_settings = sd.WasapiSettings(exclusive=False)
                                    print(f"Switched to WASAPI device: [{i}] {device_name}", file=sys.stderr)
                                    print("Using WASAPI (Windows Audio Session API) for better compatibility", file=sys.stderr)
                                    wasapi_device_found = True
                                    break
                            
                            if not wasapi_device_found:
                                warning_msg = "Audio latency may be high with non-WASAPI device. Please select a WASAPI device from the output device dropdown for better performance."
                                print(f"WARNING: {warning_msg}", file=sys.stderr)
                                # Send warning to GUI if callback is available
                                if self.status_callback:
                                    self.status_callback("wasapi_warning", warning_msg)
                except Exception as e:
                    print(f"Note: Could not configure WASAPI, using default: {e}", file=sys.stderr)
            elif platform.system() == 'Windows' and self.sounddevice_wasapi_checked:
                # Already checked, only use WASAPI settings if device is confirmed WASAPI
                try:
                    device_to_check = self.sounddevice_device_index
                    if device_to_check is None:
                        device_to_check = sd.default.device[1]
                    
                    device = sd.query_devices(device_to_check)
                    host_api_name = sd.query_hostapis(device['hostapi'])['name']
                    
                    # Only apply WASAPI settings if device is actually WASAPI
                    if 'WASAPI' in host_api_name:
                        extra_settings = sd.WasapiSettings(exclusive=False)
                except:
                    pass

            # Open output stream
            self.sounddevice_stream = sd.OutputStream(
                samplerate=self.sounddevice_output_rate,
                channels=output_channels,
                dtype='int16',
                device=self.sounddevice_device_index,
                blocksize=1024,
                latency='low',  # Request low latency
                extra_settings=extra_settings
            )
            self.sounddevice_stream.start()

            # Only show "Loading GUI" message when GUI is active (status_callback is set)
            if self.status_callback:
                print("Loading GUI (may take a moment)...", file=sys.stderr)
        except Exception as e:
            print(f"Error: Failed to initialize sounddevice: {e}", file=sys.stderr)
            # Don't terminate the program - just disable sounddevice output
            # This allows TCI server, UDP, FIFO and other functionality to continue
            self.sounddevice_stream = None
            # Don't set self.running = False - that would stop everything
            # Just log the error and continue without sounddevice output
            if self.status_callback:
                self.status_callback("error", f"Failed to initialize sounddevice: {e}")

    def decode_audio(self, base64_data: str) -> bytes:
        """Decode base64 audio data to PCM bytes."""
        # Decode base64
        audio_bytes = base64.b64decode(base64_data)

        # The data is big-endian signed 16-bit PCM
        # Convert to little-endian for most audio systems
        num_samples = len(audio_bytes) // 2
        pcm_data = bytearray()

        for i in range(num_samples):
            # Read big-endian int16
            high_byte = audio_bytes[i * 2]
            low_byte = audio_bytes[i * 2 + 1]
            sample = (high_byte << 8) | low_byte

            # Convert to signed
            if sample >= 0x8000:
                sample -= 0x10000

            # Write as little-endian int16
            pcm_data.extend(struct.pack('<h', sample))

        return bytes(pcm_data)

    def decode_opus_binary(self, binary_data: bytes) -> bytes:
        """Decode binary Opus packet to PCM bytes.

        Binary packet format from server:
        - 8 bytes: timestamp (uint64, little-endian)
        - 4 bytes: sample rate (uint32, little-endian)
        - 1 byte: channels (uint8)
        - remaining: Opus encoded data

        Returns:
            PCM data as bytes (int16, little-endian)
        """
        if len(binary_data) < 13:
            print(f"Warning: Binary packet too short: {len(binary_data)} bytes", file=sys.stderr)
            return b''

        # Parse header
        timestamp = struct.unpack('<Q', binary_data[0:8])[0]
        sample_rate = struct.unpack('<I', binary_data[8:12])[0]
        channels = binary_data[12]
        opus_data = binary_data[13:]

        # Decode Opus data
        if not self.opus_decoder:
            print("Warning: Opus decoder not initialized", file=sys.stderr)
            return b''

        try:
            # Decode Opus to PCM (returns int16 samples)
            # Frame size is determined by Opus packet (typically 960 samples at 48kHz = 20ms)
            pcm_data = self.opus_decoder.decode(opus_data, frame_size=960)

            # Convert to bytes (already little-endian int16)
            return pcm_data
        except Exception as e:
            print(f"Warning: Opus decode error: {e}", file=sys.stderr)
            return b''
    
    async def output_audio(self, pcm_data: bytes):
        """Output audio data based on selected mode."""
        # Send audio/IQ to TCI server if enabled (before any processing)
        if hasattr(self, 'tci_server') and self.tci_server:
            try:
                # Check if this is an IQ mode
                is_iq_mode = self.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')
                
                # Convert PCM int16 to float32 for TCI
                audio_array = np.frombuffer(pcm_data, dtype=np.int16)
                
                # Convert to float32 normalized to [-1.0, 1.0]
                audio_float32 = audio_array.astype(np.float32) / 32768.0
                
                if is_iq_mode:
                    # IQ MODE: Send as IQ stream (type 0)
                    # IQ data is already stereo (I and Q channels) and at the correct sample rate
                    # CRITICAL: Do NOT resample IQ data - it must maintain exact sample rate

                    # IQ data should already be interleaved (I,Q,I,Q,...)
                    # Convert to bytes for TCI transmission
                    audio_float32_le = audio_float32.astype('<f4')  # Little-endian float32
                    tci_iq_bytes = audio_float32_le.tobytes()

                    # Send to TCI server as IQ stream (receiver 0, at current sample rate)
                    self.tci_server.send_iq_data(0, tci_iq_bytes, self.sample_rate)
                else:
                    # AUDIO MODE: Send as audio stream (type 1)
                    # TCI expects float32 stereo audio at 48 kHz
                    # CRITICAL: Audio must be INTERLEAVED stereo (L,R,L,R,L,R,...)

                    tci_sample_rate = self.tci_server.audio_sample_rate
                    if self.sample_rate != tci_sample_rate:
                        if SAMPLERATE_AVAILABLE:
                            # Initialize TCI resampler if needed (only need one for mono)
                            if not hasattr(self, 'tci_resampler') or self.tci_resampler is None:
                                self.tci_resampler = samplerate.Resampler('sinc_best', channels=1)

                            # Calculate resampling ratio
                            ratio = tci_sample_rate / self.sample_rate

                            # Handle mono vs stereo input for resampling
                            if self.channels == 1:
                                # Mono: resample directly
                                audio_resampled = self.tci_resampler.process(audio_float32, ratio)
                            else:
                                # Stereo: de-interleave, resample each channel, re-interleave
                                left_channel = audio_float32[0::2]
                                right_channel = audio_float32[1::2]

                                # Need separate resamplers for stereo
                                if not hasattr(self, 'tci_resampler_right'):
                                    self.tci_resampler_right = samplerate.Resampler('sinc_best', channels=1)

                                left_resampled = self.tci_resampler.process(left_channel, ratio)
                                right_resampled = self.tci_resampler_right.process(right_channel, ratio)

                                # Re-interleave - use minimum length to handle variable resampler output
                                # Stateful resamplers can produce different output lengths during warmup
                                n_resampled = min(len(left_resampled), len(right_resampled))
                                audio_resampled = np.empty(n_resampled * 2, dtype=np.float32)
                                audio_resampled[0::2] = left_resampled[:n_resampled]
                                audio_resampled[1::2] = right_resampled[:n_resampled]
                        else:
                            audio_resampled = audio_float32
                    else:
                        audio_resampled = audio_float32

                    # NOW create stereo from resampled mono (if needed)
                    if self.channels == 1:
                        # Mono input: create proper stereo by interleaving L and R channels
                        # We want: [L0, R0, L1, R1, L2, R2, ...] where L=R for mono
                        n_samples = len(audio_resampled)
                        audio_float32_stereo = np.empty(n_samples * 2, dtype=np.float32)
                        audio_float32_stereo[0::2] = audio_resampled  # Left channel (even indices)
                        audio_float32_stereo[1::2] = audio_resampled  # Right channel (odd indices)
                    else:
                        # Already stereo and interleaved
                        audio_float32_stereo = audio_resampled

                    # Convert to bytes for TCI transmission (already interleaved)
                    # CRITICAL: Ensure little-endian byte order for compatibility
                    # Use astype with explicit dtype to force little-endian
                    audio_float32_le = audio_float32_stereo.astype('<f4')  # Little-endian float32
                    tci_audio_bytes = audio_float32_le.tobytes()

                    # Send to TCI server (receiver 0, at TCI's sample rate)
                    self.tci_server.send_audio_data(0, tci_audio_bytes, tci_sample_rate)
            except Exception as e:
                print(f"TCI audio error: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc()
        
        # Write raw PCM to FIFO FIRST (before any processing)
        # This gives the FIFO the original audio straight from the source
        if self.fifo_path is not None:
            # Try to open FIFO if not already open
            if self.fifo_fd is None:
                try:
                    # Try to open in non-blocking mode
                    self.fifo_fd = os.open(self.fifo_path, os.O_WRONLY | os.O_NONBLOCK)
                    print(f"FIFO reader connected!", file=sys.stderr)
                except (OSError, BlockingIOError):
                    # No reader yet, skip this write
                    pass

            # Write to FIFO if open
            if self.fifo_fd is not None:
                try:
                    os.write(self.fifo_fd, pcm_data)
                except (BrokenPipeError, OSError) as e:
                    # Reader disconnected or other error
                    print(f"FIFO reader disconnected", file=sys.stderr)
                    try:
                        os.close(self.fifo_fd)
                    except:
                        pass
                    self.fifo_fd = None

        # Convert PCM bytes to numpy array for processing
        audio_array = np.frombuffer(pcm_data, dtype=np.int16)

        # Reshape for stereo if needed
        if self.channels == 2:
            audio_array = audio_array.reshape(-1, 2)

        # Convert to float32 for processing
        audio_float = audio_array.astype(np.float32) / 32768.0

        # Apply NR2 noise reduction if enabled
        if self.nr2_processor:
            # Process through NR2 (expects and returns normalized float32)
            audio_float = self.nr2_processor.process(audio_float)

            # Apply -3dB makeup gain (matches UI default)
            # -3dB = 10^(-3/20) = 0.7079 gain factor
            audio_float = audio_float * 0.7079

        # Apply audio bandpass filter if enabled (BEFORE sending to recording callback)
        if self.audio_filter_enabled and self.audio_filter_taps is not None:
            try:
                # Apply FIR filter with state for continuous filtering
                if self.audio_filter_zi is not None:
                    audio_float, self.audio_filter_zi = scipy_signal.lfilter(
                        self.audio_filter_taps, 1.0, audio_float, zi=self.audio_filter_zi
                    )
                else:
                    audio_float = scipy_signal.lfilter(self.audio_filter_taps, 1.0, audio_float)
            except Exception as e:
                # Disable filter on error to avoid repeated failures
                print(f"Warning: Audio filter error: {e}", file=sys.stderr)
                self.audio_filter_enabled = False

        # Apply 10-band EQ if enabled (AFTER audio filter, BEFORE recording callback)
        # Using second-order sections (SOS) for numerical stability
        if self.eq_enabled and self.eq_sos is not None and SCIPY_AVAILABLE:
            try:
                # Apply EQ using sosfilt (second-order sections filter)
                # This is the standard, numerically stable way to apply cascaded biquads
                if self.eq_zi is not None:
                    audio_float, self.eq_zi = scipy_signal.sosfilt(
                        self.eq_sos, audio_float, zi=self.eq_zi
                    )
                else:
                    audio_float = scipy_signal.sosfilt(self.eq_sos, audio_float)
            except Exception as e:
                # Disable EQ on error to avoid repeated failures
                print(f"Warning: EQ error: {e}", file=sys.stderr)
                self.eq_enabled = False

        # Send mono audio to recording callback AFTER filtering but BEFORE stereo conversion
        # This captures the filtered mono signal (if filter is enabled) before it's duplicated to stereo
        if self.recording_callback and self.channels == 1:
            # audio_float is mono at this point, and filtered if audio_filter_enabled
            self.recording_callback(audio_float)
        
        # Calculate audio level before volume adjustment (for meter)
        if self.audio_level_callback and self.audio_level_update_counter % 5 == 0:
            # Calculate RMS level in dB (update every 5th frame to reduce overhead)
            # Handle both mono and stereo
            if audio_float.ndim == 2:
                # Stereo: average both channels
                rms = np.sqrt(np.mean(audio_float ** 2))
            else:
                # Mono
                rms = np.sqrt(np.mean(audio_float ** 2))
            
            if rms > 1e-10:  # Avoid log of zero
                level_db = 20 * np.log10(rms)
                # Clamp to reasonable range
                level_db = max(-60, min(0, level_db))
            else:
                level_db = -60  # Minimum level
            
            self.audio_level_callback(level_db)
        self.audio_level_update_counter += 1
        
        # Apply volume control
        if self.volume != 1.0:
            audio_float = audio_float * self.volume
        # Save audio before channel selection for UDP output
        # UDP needs audio before L/R channel muting is applied
        audio_before_channel_selection = audio_float.copy()

        
        # Convert mono to stereo if needed for output
        if self.channels == 1 and self.output_channels == 2:
            # Duplicate mono to both channels
            audio_float = np.column_stack((audio_float, audio_float))
        
        # Apply channel selection (only if stereo output)
        if self.output_channels == 2:
            if not self.channel_left:
                audio_float[:, 0] = 0  # Mute left channel
            if not self.channel_right:
                audio_float[:, 1] = 0  # Mute right channel

        # Resample for sounddevice if needed (12 kHz -> 48 kHz)
        # This avoids hardware rejection of unsupported sample rates
        # Using samplerate library for stateful, click-free resampling
        if self.output_mode == 'sounddevice' and self.needs_resampling:
            if self.sounddevice_output_rate != self.sample_rate:
                if SAMPLERATE_AVAILABLE:
                    # Initialize resamplers on first use
                    if self.resampler_left is None:
                        # Use 'sinc_best' for highest quality, or 'sinc_medium' for lower CPU usage
                        self.resampler_left = samplerate.Resampler('sinc_best', channels=1)
                        self.resampler_right = samplerate.Resampler('sinc_best', channels=1)

                    # Calculate resampling ratio
                    ratio = self.sounddevice_output_rate / self.sample_rate

                    # Resample each channel with stateful resamplers
                    # This maintains filter state across chunks, eliminating clicks
                    left_resampled = self.resampler_left.process(audio_float[:, 0], ratio)
                    right_resampled = self.resampler_right.process(audio_float[:, 1], ratio)
                    audio_float = np.column_stack((left_resampled, right_resampled))

        # Convert back to int16 and clip
        audio_array = np.clip(audio_float * 32768.0, -32768, 32767).astype(np.int16)
        pcm_data = audio_array.tobytes()
        
        if self.output_mode == 'stdout':
            # Write raw PCM to stdout
            sys.stdout.buffer.write(pcm_data)
            sys.stdout.buffer.flush()
        
        elif self.output_mode == 'pipewire':
            # Write to PipeWire process (skip if in IQ mode)
            is_iq_mode = self.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')
            if not is_iq_mode and self.pipewire_process and self.pipewire_process.stdin:
                try:
                    self.pipewire_process.stdin.write(pcm_data)
                    await self.pipewire_process.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    print("PipeWire connection lost", file=sys.stderr)
                    self.running = False
        
        elif self.output_mode == 'pyaudio':
            # Write to PyAudio stream (skip if in IQ mode)
            is_iq_mode = self.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')
            if not is_iq_mode and self.pyaudio_stream:
                try:
                    self.pyaudio_stream.write(pcm_data)
                except Exception as e:
                    print(f"PyAudio error: {e}", file=sys.stderr)
                    self.running = False

        elif self.output_mode == 'sounddevice':
            # Write to sounddevice stream (skip if in IQ mode)
            is_iq_mode = self.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')
            if not is_iq_mode and self.sounddevice_stream:
                try:
                    # sounddevice expects numpy array, not bytes
                    audio_array_for_sd = np.frombuffer(pcm_data, dtype=np.int16).reshape(-1, self.output_channels)
                    self.sounddevice_stream.write(audio_array_for_sd)
                except Exception as e:
                    print(f"sounddevice error: {e}", file=sys.stderr)
                    self.running = False

        elif self.output_mode == 'udp':
            # Send to UDP socket (main output mode)
            if self.udp_socket and self.udp_host and self.udp_port:
                try:
                    # Prepare UDP-specific audio (mono by default, stereo if enabled)
                    # Use audio BEFORE channel selection was applied
                    udp_audio = self._prepare_udp_audio(audio_before_channel_selection)
                    udp_pcm = np.clip(udp_audio * 32768.0, -32768, 32767).astype(np.int16).tobytes()
                    self.udp_socket.sendto(udp_pcm, (self.udp_host, self.udp_port))
                except Exception as e:
                    print(f"UDP send error: {e}", file=sys.stderr)
                    self.running = False

        # Send UDP output if enabled as additional output (works alongside any output mode)
        if self.udp_enabled and self.udp_socket and self.output_mode != 'udp':
            try:
                # Prepare UDP-specific audio (mono by default, stereo if enabled)
                # Use audio BEFORE channel selection was applied
                udp_audio = self._prepare_udp_audio(audio_before_channel_selection)
                udp_pcm = np.clip(udp_audio * 32768.0, -32768, 32767).astype(np.int16).tobytes()
                self.udp_socket.sendto(udp_pcm, (self.udp_host, self.udp_port))
            except Exception as e:
                print(f"UDP send error: {e}", file=sys.stderr)
        
        elif self.output_mode == 'wav':
            # Write to WAV file
            if self.wav_writer:
                self.wav_writer.writeframes(pcm_data)
    
    def check_duration(self) -> bool:
        """Check if duration limit has been reached."""
        if self.duration is None:
            return True
        
        if self.start_time is None:
            self.start_time = time.time()
            return True
        
        elapsed = time.time() - self.start_time
        if elapsed >= self.duration:
            print(f"\nRecording duration reached: {elapsed:.1f}s", file=sys.stderr)
            return False
        
        return True
    
    async def handle_message(self, message: dict):
        """Handle incoming WebSocket message."""
        msg_type = message.get('type')
        
        if msg_type == 'audio':
            # Process audio data
            audio_data = message.get('data')
            sample_rate = message.get('sampleRate', self.sample_rate)
            channels = message.get('channels', self.channels)
            
            # Check if sample rate or channels changed (requires restarting PipeWire)
            sample_rate_changed = sample_rate != self.sample_rate
            channels_changed = channels != self.channels

            if sample_rate_changed:
                self.sample_rate = sample_rate
                print(f"Sample rate updated: {self.sample_rate} Hz", file=sys.stderr)

                # Recalculate needs_resampling based on current mode
                # IQ modes should never be resampled as they have fixed bandwidths
                is_iq_mode = self.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')
                self.needs_resampling = (self.output_mode == 'sounddevice' and SAMPLERATE_AVAILABLE and not is_iq_mode)

                # Reinitialize audio filter with new sample rate
                if self.audio_filter_enabled and SCIPY_AVAILABLE:
                    self._init_audio_filter()
                    print(f"Audio filter reinitialized for {self.sample_rate} Hz", file=sys.stderr)

                # Reinitialize EQ with new sample rate
                if self.eq_enabled and self.eq_band_gains and SCIPY_AVAILABLE:
                    self.update_eq(self.eq_band_gains)
                    print(f"EQ reinitialized for {self.sample_rate} Hz", file=sys.stderr)

            if channels_changed:
                self.channels = channels
                print(f"Channels updated: {self.channels}", file=sys.stderr)

            # Restart PipeWire if sample rate or channels changed
            if (sample_rate_changed or channels_changed) and self.output_mode == 'pipewire' and self.pipewire_process:
                print("Restarting PipeWire with new audio configuration...", file=sys.stderr)
                if self.pipewire_process.stdin:
                    self.pipewire_process.stdin.close()
                try:
                    await asyncio.wait_for(self.pipewire_process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    self.pipewire_process.kill()
                    await self.pipewire_process.wait()
                await self.setup_pipewire()
            
            # Restart PyAudio if sample rate or channels changed
            if (sample_rate_changed or channels_changed) and self.output_mode == 'pyaudio' and self.pyaudio_stream:
                print("Restarting PyAudio with new audio configuration...", file=sys.stderr)
                self.pyaudio_stream.stop_stream()
                self.pyaudio_stream.close()
                self.pyaudio_stream = None
                await self.setup_pyaudio()

            # Restart sounddevice if sample rate or channels changed
            if (sample_rate_changed or channels_changed) and self.output_mode == 'sounddevice' and self.sounddevice_stream:
                restart_start = time.time()
                print("Restarting sounddevice with new audio configuration...", file=sys.stderr)
                self.sounddevice_stream.stop()
                self.sounddevice_stream.close()
                self.sounddevice_stream = None
                # Reset resamplers if sample rate changed
                if sample_rate_changed and self.needs_resampling:
                    # Reset resampler instances to reinitialize with new sample rate
                    self.resampler_left = None
                    self.resampler_right = None
                await self.setup_sounddevice()
                restart_time = (time.time() - restart_start) * 1000
                print(f"Sounddevice restart took {restart_time:.1f}ms", file=sys.stderr)

            if audio_data:
                pcm_data = self.decode_audio(audio_data)
                await self.output_audio(pcm_data)
                
                # Check duration limit
                if not self.check_duration():
                    self.running = False
        
        elif msg_type == 'status':
            # Store session ID from server (like web UI does)
            session_id = message.get('sessionId', 'unknown')
            if session_id != 'unknown':
                self.server_session_id = session_id
            freq = message.get('frequency', 0)
            mode = message.get('mode', 'unknown')
            # print(f"Status: Session {session_id}, {freq} Hz, mode {mode}", file=sys.stderr)  # Removed: too verbose during rapid frequency changes
        
        elif msg_type == 'error':
            # Print error message and notify via callback
            error = message.get('error', 'Unknown error')
            print(f"Server error: {error}", file=sys.stderr)
            if self.status_callback:
                self.status_callback("server_error", error)
            self.running = False
        
        elif msg_type == 'pong':
            # Keepalive response
            pass
    
    async def send_keepalive(self, websocket):
        """Send periodic keepalive messages."""
        while self.running:
            try:
                await asyncio.sleep(30)
                if self.running:
                    await websocket.send(json.dumps({'type': 'ping'}))
            except Exception as e:
                print(f"Keepalive error: {e}", file=sys.stderr)
                break
    
    async def fetch_description(self) -> dict:
        """Fetch server description from /api/description endpoint."""
        # Build HTTP URL for description
        protocol = 'https' if self.ssl else 'http'
        
        if self.url:
            # Extract host and port from WebSocket URL
            parsed = urlparse(self.url)
            host = parsed.hostname
            port = parsed.port or (443 if parsed.scheme == 'wss' else 80)
        else:
            host = self.host
            port = self.port
        
        http_url = f"{protocol}://{host}:{port}/api/description"
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    http_url,
                    headers={
                        'User-Agent': 'UberSDR Client 1.0 (python)'
                    },
                    ssl=False if not self.ssl else None
                ) as response:
                    data = await response.json()
                    return data
                    
        except Exception as e:
            print(f"Failed to fetch description: {e}", file=sys.stderr)
            return {}

    async def fetch_countries(self) -> list:
        """Fetch country list from /api/cty/countries endpoint."""
        # Build HTTP URL for countries
        protocol = 'https' if self.ssl else 'http'
        
        if self.url:
            # Extract host and port from WebSocket URL
            parsed = urlparse(self.url)
            host = parsed.hostname
            port = parsed.port or (443 if parsed.scheme == 'wss' else 80)
        else:
            host = self.host
            port = self.port
        
        http_url = f"{protocol}://{host}:{port}/api/cty/countries"
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    http_url,
                    headers={
                        'User-Agent': 'UberSDR Client 1.0 (python)'
                    },
                    ssl=False if not self.ssl else None
                ) as response:
                    data = await response.json()
                    if data.get('success') and 'data' in data:
                        return data['data'].get('countries', [])
                    return []
                    
        except Exception as e:
            print(f"Failed to fetch countries: {e}", file=sys.stderr)
            return []
    
    async def check_connection_allowed(self) -> tuple[bool, str]:
        """Check if connection is allowed via /connection endpoint.

        Returns:
            Tuple of (allowed, reason) where:
            - allowed: True if connection is allowed, False otherwise
            - reason: Rejection reason if not allowed, empty string if allowed
        """
        # Build HTTP URL for connection check
        protocol = 'https' if self.ssl else 'http'
        
        if self.url:
            # Extract host and port from WebSocket URL
            parsed = urlparse(self.url)
            host = parsed.hostname
            port = parsed.port or (443 if parsed.scheme == 'wss' else 80)
        else:
            host = self.host
            port = self.port
        
        http_url = f"{protocol}://{host}:{port}/connection"
        
        # Prepare request body
        request_body = {
            "user_session_id": self.user_session_id
        }
        
        # Add password if provided
        if self.password:
            request_body["password"] = self.password
        
        self._log("Checking connection permission...")
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    http_url,
                    json=request_body,
                    headers={
                        'Content-Type': 'application/json',
                        'User-Agent': 'UberSDR Client 1.0 (python)'
                    },
                    ssl=False if not self.ssl else None
                ) as response:
                    data = await response.json()
                    
                    if not data.get('allowed', False):
                        reason = data.get('reason', 'Unknown reason')
                        self._log(f"Connection rejected: {reason}")
                        return False, reason
                    
                    # Store bypassed status (deprecated), allowed IQ modes, and session time
                    self.bypassed = data.get('bypassed', False)
                    self.allowed_iq_modes = data.get('allowed_iq_modes', [])
                    self.max_session_time = data.get('max_session_time', 0)
                    self.connection_start_time = time.time()

                    client_ip = data.get('client_ip', 'unknown')
                    bypassed_msg = " (bypassed)" if self.bypassed else ""
                    iq_modes_msg = f", allowed IQ modes: {', '.join(self.allowed_iq_modes)}" if self.allowed_iq_modes else ""
                    session_msg = f", max session: {self.max_session_time}s" if self.max_session_time > 0 else ""
                    self._log(f"Connection allowed (client IP: {client_ip}){bypassed_msg}{iq_modes_msg}{session_msg}")
                    return True, ""
                    
        except Exception as e:
            print(f"Connection check failed: {e}", file=sys.stderr)
            print("Attempting connection anyway...", file=sys.stderr)
            return True, ""  # Continue on error (like the web UI does)
    
    async def run_once(self):
        """Single connection attempt."""
        # Check if connection is allowed before attempting WebSocket connection
        allowed, reason = await self.check_connection_allowed()
        if not allowed:
            # Store rejection reason for GUI to handle
            self.connection_rejected = True
            self.rejection_reason = reason
            return 1

        # Fetch server description
        description = await self.fetch_description()
        if description:
            # Store description data for GUI access
            self.server_description = description
            receiver_name = description.get('receiver', {}).get('name', '')
            if receiver_name:
                self._log(f"Receiver: {receiver_name}")

        # Fetch country list
        countries = await self.fetch_countries()
        if countries:
            self.countries = countries
            self._log(f"Loaded {len(countries)} countries")

        url = self.build_websocket_url()
        self._log(f"Connecting to {url}")
        self._log(f"Frequency: {self.frequency} Hz, Mode: {self.mode}")
        
        if self.bandwidth_low is not None and self.bandwidth_high is not None:
            self._log(f"Bandwidth: {self.bandwidth_low} to {self.bandwidth_high} Hz")
        
        try:
            async with websockets.connect(
                url,
                ping_interval=None,
                additional_headers={'User-Agent': 'UberSDR Client 1.0 (python)'}
            ) as websocket:
                # Store websocket reference and event loop for GUI access and radio control
                self.ws = websocket
                self._event_loop = asyncio.get_event_loop()
                self._log("Connected!")

                # Reset retry count on successful connection
                self.retry_count = 0

                # Setup FIFO if configured (independent of output mode)
                self.setup_fifo()

                # Setup output based on mode
                if self.output_mode == 'pipewire':
                    await self.setup_pipewire()
                elif self.output_mode == 'pyaudio':
                    await self.setup_pyaudio()
                elif self.output_mode == 'sounddevice':
                    await self.setup_sounddevice()
                elif self.output_mode == 'wav':
                    self.setup_wav_writer()
                elif self.output_mode == 'stdout':
                    print(f"stdout output: {self.sample_rate} Hz, {self.output_channels} channel(s)", file=sys.stderr)
                elif self.output_mode == 'udp':
                    print(f"UDP output to {self.udp_host}:{self.udp_port}: {self.sample_rate} Hz, {self.output_channels} channel(s)", file=sys.stderr)
                    print(f"VLC command: vlc --demux=rawaud \"udp://@:{self.udp_port}\" --rawaud-channels={self.output_channels} --rawaud-samplerate={self.sample_rate}", file=sys.stderr)
                
                # Start keepalive task
                keepalive_task = asyncio.create_task(self.send_keepalive(websocket))
                
                # Start radio polling task if radio control is enabled
                radio_poll_task = None
                if hasattr(self, 'radio_control') and self.radio_control:
                    if hasattr(self, 'radio_sync_direction') and self.radio_sync_direction in ('rig-to-sdr', 'bidirectional'):
                        async def poll_radio():
                            """Poll radio for changes."""
                            while self.running:
                                try:
                                    self.radio_control.poll()
                                    await asyncio.sleep(0.1)  # Poll every 100ms
                                except Exception as e:
                                    print(f"Radio poll error: {e}", file=sys.stderr)
                                    break

                        radio_poll_task = asyncio.create_task(poll_radio())

                # Receive and process messages
                while self.running:
                    try:
                        message = await asyncio.wait_for(websocket.recv(), timeout=1.0)

                        # Handle binary messages (Opus format)
                        if isinstance(message, bytes):
                            if self.use_opus:
                                # Decode binary Opus packet
                                pcm_data = self.decode_opus_binary(message)
                                if pcm_data:
                                    await self.output_audio(pcm_data)

                                # Check duration limit
                                if not self.check_duration():
                                    self.running = False
                            else:
                                print("Warning: Received binary message but Opus not enabled", file=sys.stderr)
                        else:
                            # Handle JSON messages (standard format)
                            data = json.loads(message)
                            await self.handle_message(data)
                    except asyncio.TimeoutError:
                        continue
                    except websockets.exceptions.ConnectionClosed:
                        print("Connection closed by server", file=sys.stderr)
                        break
                
                # Cancel keepalive
                keepalive_task.cancel()
                try:
                    await keepalive_task
                except asyncio.CancelledError:
                    pass

                # Cancel radio polling task if it exists
                if radio_poll_task:
                    radio_poll_task.cancel()
                    try:
                        await radio_poll_task
                    except asyncio.CancelledError:
                        pass
                
        except Exception as e:
            print(f"Connection error: {e}", file=sys.stderr)
            return 1
        finally:
            # Clear websocket and event loop references
            self.ws = None
            self._event_loop = None
            await self.cleanup()
        
        return 0

    def calculate_backoff(self) -> float:
        """Calculate exponential backoff time with max limit."""
        # Exponential backoff: 2^retry_count seconds, capped at max_backoff
        backoff = min(2 ** self.retry_count, self.max_backoff)
        return backoff

    async def run(self):
        """Main client loop with auto-reconnect support."""
        while self.running:
            exit_code = await self.run_once()

            # If not auto-reconnecting or clean exit, stop
            if not self.auto_reconnect or exit_code == 0:
                return exit_code

            # If user interrupted, stop
            if not self.running:
                return 0

            # Calculate backoff time
            self.retry_count += 1
            backoff = self.calculate_backoff()

            print(f"\nReconnecting in {backoff:.0f}s (attempt {self.retry_count})...", file=sys.stderr)

            # Wait with ability to interrupt
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                print("Reconnect cancelled", file=sys.stderr)
                return 1

        return 0
    
    def _cleanup_fifo_on_exit(self):
        """Cleanup FIFO on exit (called by atexit)."""
        if self.fifo_fd is not None:
            try:
                os.close(self.fifo_fd)
            except:
                pass
            self.fifo_fd = None

        # Remove FIFO file only if we created it
        if self.fifo_path and self.fifo_created_by_us and os.path.exists(self.fifo_path):
            try:
                os.unlink(self.fifo_path)
            except:
                pass

    async def cleanup(self):
        """Clean up resources."""
        print("\nCleaning up...", file=sys.stderr)

        # Close FIFO
        if self.fifo_fd is not None:
            try:
                os.close(self.fifo_fd)
                print(f"FIFO closed: {self.fifo_path}", file=sys.stderr)
            except Exception as e:
                print(f"Error closing FIFO: {e}", file=sys.stderr)
            self.fifo_fd = None

            # Remove FIFO file only if we created it
            if self.fifo_path and self.fifo_created_by_us and os.path.exists(self.fifo_path):
                try:
                    os.unlink(self.fifo_path)
                    print(f"FIFO removed: {self.fifo_path}", file=sys.stderr)
                except Exception as e:
                    print(f"Error removing FIFO: {e}", file=sys.stderr)

        # Close WAV file
        if self.wav_writer:
            self.wav_writer.close()
            print(f"WAV file closed: {self.wav_file}", file=sys.stderr)

        # Close PipeWire process
        if self.pipewire_process:
            if self.pipewire_process.stdin:
                self.pipewire_process.stdin.close()
            try:
                await asyncio.wait_for(self.pipewire_process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                self.pipewire_process.kill()
                await self.pipewire_process.wait()
        
        # Close PyAudio stream
        if self.pyaudio_stream:
            try:
                self.pyaudio_stream.stop_stream()
                self.pyaudio_stream.close()
                print("PyAudio stream closed", file=sys.stderr)
            except Exception as e:
                print(f"Error closing PyAudio stream: {e}", file=sys.stderr)
            self.pyaudio_stream = None
        
        if self.pyaudio_instance:
            try:
                self.pyaudio_instance.terminate()
                print("PyAudio terminated", file=sys.stderr)
            except Exception as e:
                print(f"Error terminating PyAudio: {e}", file=sys.stderr)
            self.pyaudio_instance = None

        # Close sounddevice stream
        if self.sounddevice_stream:
            try:
                self.sounddevice_stream.stop()
                self.sounddevice_stream.close()
                print("sounddevice stream closed", file=sys.stderr)
            except Exception as e:
                print(f"Error closing sounddevice stream: {e}", file=sys.stderr)
            self.sounddevice_stream = None

        # Close UDP socket
        if self.udp_socket:
            try:
                self.udp_socket.close()
                print("UDP socket closed", file=sys.stderr)
            except Exception as e:
                print(f"Error closing UDP socket: {e}", file=sys.stderr)
            self.udp_socket = None
        
        # Clean up resamplers
        if self.resampler_left is not None:
            self.resampler_left = None
        if self.resampler_right is not None:
            self.resampler_right = None


def parse_bandwidth(value: str) -> tuple[int, int]:
    """Parse bandwidth argument in format 'low:high'."""
    try:
        low, high = value.split(':')
        return int(low), int(high)
    except ValueError:
        raise argparse.ArgumentTypeError(
            "Bandwidth must be in format 'low:high' (e.g., '-5000:5000')"
        )

def list_local_instances():
    """List local UberSDR instances discovered via mDNS."""
    try:
        from zeroconf import ServiceBrowser, ServiceListener, Zeroconf
    except ImportError:
        print("Error: zeroconf library not available. Install with: pip install zeroconf", file=sys.stderr)
        sys.exit(1)
    
    print("Discovering local UberSDR instances via mDNS...")
    print()
    
    instances = {}
    
    class InstanceListener(ServiceListener):
        def add_service(self, zc: 'Zeroconf', type_: str, name: str) -> None:
            info = zc.get_service_info(type_, name)
            if info:
                host = info.parsed_addresses()[0] if info.parsed_addresses() else None
                port = info.port
                
                if host and port:
                    # Parse TXT records
                    txt_records = {}
                    if info.properties:
                        for key, value in info.properties.items():
                            try:
                                txt_records[key.decode('utf-8')] = value.decode('utf-8')
                            except:
                                pass
                    
                    version = txt_records.get('version', 'Unknown')
                    display_name = name.replace('._ubersdr._tcp.local.', '')
                    
                    # Fetch detailed info from /api/description
                    try:
                        protocol = 'http'  # Local instances typically don't use TLS
                        url = f"{protocol}://{host}:{port}/api/description"
                        response = requests.get(url, timeout=5)
                        response.raise_for_status()
                        description = response.json()
                        
                        instances[name] = {
                            'name': display_name,
                            'host': host,
                            'port': port,
                            'version': version,
                            'description': description
                        }
                    except Exception:
                        # If fetch fails, skip this instance
                        pass
        
        def remove_service(self, zc: 'Zeroconf', type_: str, name: str) -> None:
            pass
        
        def update_service(self, zc: 'Zeroconf', type_: str, name: str) -> None:
            pass
    
    # Start discovery
    zeroconf = Zeroconf()
    listener = InstanceListener()
    browser = ServiceBrowser(zeroconf, "_ubersdr._tcp.local.", listener)
    
    # Wait for discovery
    print("Searching for 5 seconds...")
    time.sleep(5)
    
    # Stop discovery
    browser.cancel()
    zeroconf.close()
    
    # Display results
    print()
    if not instances:
        print("No local instances found")
        return
    
    print(f"Found {len(instances)} local instance(s):")
    print()
    
    for service_name, info in sorted(instances.items(), key=lambda x: x[1]['name']):
        description = info.get('description', {})
        receiver = description.get('receiver', {})
        
        name = receiver.get('name', info['name'])
        callsign = receiver.get('callsign', '')
        location = receiver.get('location', '')
        version = description.get('version', info.get('version', 'Unknown'))
        public_uuid = description.get('public_uuid', '')
        
        # Connection info
        host = info['host']
        port = info['port']
        url = f"http://{host}:{port}/"
        
        # Capabilities
        available_clients = description.get('available_clients', 0)
        max_clients = description.get('max_clients', 0)
        max_session_time = description.get('max_session_time', 0)
        cw_skimmer = description.get('cw_skimmer', False)
        digital_decodes = description.get('digital_decodes', False)
        noise_floor = description.get('noise_floor', False)
        public_iq_modes = description.get('public_iq_modes', [])
        
        print(f"  Name:     {name}")
        if callsign:
            print(f"  Callsign: {callsign}")
        if location:
            print(f"  Location: {location}")
        if public_uuid:
            print(f"  UUID:     {public_uuid}")
        print(f"  URL:      {url}")
        print(f"  Host:     {host}")
        print(f"  Port:     {port}")
        print(f"  Version:  {version}")
        print(f"  Users:    {available_clients}/{max_clients}")
        if max_session_time > 0:
            print(f"  Session:  {max_session_time // 60}m")
        
        # Capabilities
        capabilities = []
        if cw_skimmer:
            capabilities.append("CW Skimmer")
        if digital_decodes:
            capabilities.append("Digital Decodes")
        if noise_floor:
            capabilities.append("Noise Floor")
        if public_iq_modes:
            iq_numbers = []
            for mode in public_iq_modes:
                digits = ''.join(filter(str.isdigit, mode))
                if digits:
                    iq_numbers.append(digits)
            if iq_numbers:
                capabilities.append(f"IQ: {', '.join(iq_numbers)} kHz")
        
        if capabilities:
            print(f"  Features: {', '.join(capabilities)}")
        
        print()


def list_public_instances():
    """List public UberSDR instances from the central registry."""
    print("Fetching public UberSDR instances...")
    print()
    
    try:
        response = requests.get('https://instances.ubersdr.org/api/instances', timeout=10)
        response.raise_for_status()
        data = response.json()
        
        # Extract instances array from response
        instances = data.get('instances', []) if isinstance(data, dict) else data
        
        if not instances:
            print("No public instances found")
            return
        
        print(f"Found {len(instances)} public instance(s):")
        print()
        
        for instance in sorted(instances, key=lambda x: x.get('name', '')):
            name = instance.get('name', 'Unknown')
            callsign = instance.get('callsign', '')
            location = instance.get('location', '')
            version = instance.get('version', '')
            public_url = instance.get('public_url', '')
            uuid = instance.get('id', '')
            
            # Connection info
            host = instance.get('host', '')
            port = instance.get('port', 0)
            tls = instance.get('tls', False)
            
            # Capabilities
            available_clients = instance.get('available_clients', 0)
            max_clients = instance.get('max_clients', 0)
            max_session_time = instance.get('max_session_time', 0)
            cw_skimmer = instance.get('cw_skimmer', False)
            digital_decodes = instance.get('digital_decodes', False)
            noise_floor = instance.get('noise_floor', False)
            public_iq_modes = instance.get('public_iq_modes', [])
            
            print(f"  Name:     {name}")
            if callsign:
                print(f"  Callsign: {callsign}")
            if location:
                print(f"  Location: {location}")
            if uuid:
                print(f"  UUID:     {uuid}")
            if public_url:
                print(f"  URL:      {public_url}")
            if host and port:
                protocol = 'wss' if tls else 'ws'
                print(f"  Connect:  {protocol}://{host}:{port}/ws")
            if version:
                print(f"  Version:  {version}")
            print(f"  Users:    {available_clients}/{max_clients}")
            if max_session_time > 0:
                print(f"  Session:  {max_session_time // 60}m")
            
            # Capabilities
            capabilities = []
            if cw_skimmer:
                capabilities.append("CW Skimmer")
            if digital_decodes:
                capabilities.append("Digital Decodes")
            if noise_floor:
                capabilities.append("Noise Floor")
            if public_iq_modes:
                iq_numbers = []
                for mode in public_iq_modes:
                    digits = ''.join(filter(str.isdigit, mode))
                    if digits:
                        iq_numbers.append(digits)
                if iq_numbers:
                    capabilities.append(f"IQ: {', '.join(iq_numbers)} kHz")
            
            if capabilities:
                print(f"  Features: {', '.join(capabilities)}")
            
            print()
    
    except requests.exceptions.RequestException as e:
        print(f"Error fetching instances: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        sys.exit(1)



def main():
    parser = argparse.ArgumentParser(
        description='CLI Radio Client for ka9q_ubersdr',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Launch GUI interface (default)
  %(prog)s

  # List public instances
  %(prog)s --list-public

  # List local instances on your network
  %(prog)s --list-local

  # Connect to instance by UUID (GUI mode)
  %(prog)s --uuid 3a44a51b-f87f-4c6e-8e2f-5dc31c0c265a

  # Connect to instance by callsign (GUI mode)
  %(prog)s --callsign M9PSY-1

  # Connect to instance by UUID (CLI mode)
  %(prog)s --no-gui --uuid 3a44a51b-f87f-4c6e-8e2f-5dc31c0c265a -f 14074000 -m usb

  # Connect to instance by callsign (CLI mode)
  %(prog)s --no-gui --callsign M9PSY-1 -f 14074000 -m usb

  # Listen to 14.074 MHz USB via PipeWire (CLI mode)
  %(prog)s --no-gui -f 14074000 -m usb

  # Connect using full URL (CLI mode)
  %(prog)s --no-gui -u ws://radio.example.com:8073/ws -f 14074000 -m usb

  # Record 1000 kHz AM to WAV file for 60 seconds (CLI mode)
  %(prog)s --no-gui -f 1000000 -m am -o wav -w recording.wav -t 60

  # Output raw PCM to stdout with custom bandwidth (CLI mode)
  %(prog)s --no-gui -f 7100000 -m lsb -b -2700:-50 -o stdout > audio.pcm

  # Stream audio to UDP endpoint with default (127.0.0.1:8888)
  %(prog)s --no-gui -f 14074000 -m usb -o udp

  # Stream audio to custom UDP endpoint
  %(prog)s --no-gui -f 14074000 -m usb -o udp:192.168.1.100:9999

  # CLI mode with rigctl radio control (SDR to rig sync)
  %(prog)s --no-gui -f 14074000 -m usb --radio-control-type rigctl --radio-host localhost --radio-port 4532 --radio-sync-direction sdr-to-rig

  # CLI mode with flrig radio control (rig to SDR sync)
  %(prog)s --no-gui -f 14074000 -m usb --radio-control-type flrig --radio-host localhost --radio-port 12345 --radio-vfo A --radio-sync-direction rig-to-sdr

  # CLI mode with OmniRig radio control (bidirectional sync)
  %(prog)s --no-gui -f 14074000 -m usb --radio-control-type omnirig --radio-rig 1 --radio-vfo A

  # CLI mode with Serial CAT control (bidirectional sync)
  %(prog)s --no-gui -f 14074000 -m usb --radio-control-type serial --radio-serial-port /dev/ttyUSB0 --radio-vfo A
        """
    )
    
    parser.add_argument('--no-gui', action='store_true',
                        help='Disable GUI and use command-line interface (requires --frequency and --mode)')
    
    # Create mutually exclusive group for UUID and callsign
    instance_group = parser.add_mutually_exclusive_group()
    instance_group.add_argument('--uuid', type=str,
                        help='Connect to instance by UUID (fetches connection details from central registry)')
    instance_group.add_argument('--callsign', type=str,
                        help='Connect to instance by callsign (resolves to UUID via central registry)')
    
    parser.add_argument('-u', '--url',
                        help='Full WebSocket URL (e.g., ws://host:port/ws or wss://host/ws)')
    parser.add_argument('-H', '--host', default='localhost',
                        help='Server hostname (default: localhost, ignored if --url is provided)')
    parser.add_argument('-p', '--port', type=int, default=8080,
                        help='Server port (default: 8080, ignored if --url is provided)')
    parser.add_argument('-f', '--frequency', type=int,
                        help='Frequency in Hz (e.g., 14074000 for 14.074 MHz)')
    parser.add_argument('-m', '--mode',
                        choices=['am', 'sam', 'usb', 'lsb', 'fm', 'nfm', 'cwu', 'cwl', 'iq', 'iq48', 'iq96', 'iq192', 'iq384'],
                        help='Demodulation mode (iq48/iq96/iq192/iq384 require bypassed IP)')
    parser.add_argument('-b', '--bandwidth', type=parse_bandwidth,
                        help='Bandwidth in format low:high (e.g., -5000:5000)')
    parser.add_argument('-o', '--output',
                        default='sounddevice',
                        help='Output mode: pipewire, pyaudio, sounddevice, stdout, wav, udp (defaults to 127.0.0.1:8888), or udp:host:port (default: sounddevice)')
    parser.add_argument('-w', '--wav-file', metavar='FILE',
                        help='WAV file path (required when output=wav)')
    parser.add_argument('-t', '--time', type=float, metavar='SECONDS',
                        help='Recording duration in seconds (for WAV output)')
    parser.add_argument('-s', '--ssl', action='store_true',
                        help='Use WSS (WebSocket Secure, ignored if --url is provided)')
    parser.add_argument('--nr2', action='store_true',
                        help='Enable NR2 spectral subtraction noise reduction')
    parser.add_argument('--nr2-strength', type=float, default=40.0, metavar='PERCENT',
                        help='NR2 noise reduction strength, 0-100%% (default: 40)')
    parser.add_argument('--nr2-floor', type=float, default=10.0, metavar='PERCENT',
                        help='NR2 spectral floor to prevent musical noise, 0-10%% (default: 10)')
    parser.add_argument('--nr2-adapt-rate', type=float, default=1.0, metavar='PERCENT',
                        help='NR2 noise profile adaptation rate, 0.1-5.0%% (default: 1)')
    parser.add_argument('--auto-reconnect', action='store_true',
                        help='Automatically reconnect on connection loss with exponential backoff (max 60s)')
    parser.add_argument('--password', type=str, default=None,
                        help='Bypass password for accessing wide IQ modes and bypassing session limits')
    
    parser.add_argument('--pipewire-target', type=str, default=None,
                        help='PipeWire target device (node name). Use --list-devices to see available devices.')
    parser.add_argument('--list-devices', action='store_true',
                        help='List available audio output devices and exit (PyAudio or PipeWire depending on --output)')
    parser.add_argument('--list-local', action='store_true',
                        help='List local UberSDR instances discovered via mDNS and exit')
    parser.add_argument('--list-public', action='store_true',
                        help='List public UberSDR instances from the central registry and exit')
    parser.add_argument('--fifo-path', type=str, metavar='PATH',
                        help='Also write audio to named pipe (FIFO) at this path (non-blocking, works with any output mode)')

    parser.add_argument('--audio-filter', action='store_true',
                        help='Enable audio bandpass filter')
    parser.add_argument('--audio-filter-low', type=float, default=300.0, metavar='HZ',
                        help='Audio filter low cutoff frequency in Hz (default: 300)')
    parser.add_argument('--audio-filter-high', type=float, default=2700.0, metavar='HZ',
                        help='Audio filter high cutoff frequency in Hz (default: 2700)')

    parser.add_argument('--opus', action='store_true',
                        help='Use Opus compression for audio (90-95%% bandwidth savings, not supported for IQ modes)')

    parser.add_argument('--channels', type=int, choices=[1, 2], metavar='N',
                        help='Number of output channels: 1 (mono) or 2 (stereo). Default: 1 for stdout/udp, 2 for audio devices. IQ modes always use 2 channels.')

    # Radio control arguments
    parser.add_argument('--radio-control-type', type=str, choices=['rigctl', 'flrig', 'omnirig', 'serial', 'tci', 'none'], default='none',
                        help='Radio control type: rigctl, flrig, omnirig, serial, tci, or none (default: none)')
    parser.add_argument('--tci-server-port', type=int, default=40001,
                        help='TCI server port (default: 40001) - used when radio-control-type is tci')
    parser.add_argument('--radio-host', type=str, default='localhost',
                        help='Radio control host (for rigctl/flrig, default: localhost)')
    parser.add_argument('--radio-port', type=int,
                        help='Radio control port (default: 4532 for rigctl, 12345 for flrig)')
    parser.add_argument('--radio-serial-port', type=str,
                        help='Serial port for CAT control (e.g., /dev/ttyUSB0, COM3) - required for serial control type')
    parser.add_argument('--radio-vfo', type=str, choices=['A', 'B'], default='A',
                        help='Radio VFO (for flrig/omnirig/serial, default: A)')
    parser.add_argument('--radio-rig', type=int, choices=[1, 2], default=1,
                        help='Radio rig number (for omnirig, default: 1)')
    parser.add_argument('--radio-sync-direction', type=str, choices=['sdr-to-rig', 'rig-to-sdr'], default='sdr-to-rig',
                        help='Radio sync direction: sdr-to-rig or rig-to-sdr (default: sdr-to-rig)')
    parser.add_argument('--list-serial-ports', action='store_true',
                        help='List available serial ports and exit')

    args = parser.parse_args()
    
    # List devices mode
    if args.list_devices:
        output_mode = args.output

        if output_mode == 'pyaudio':
            print("Available PyAudio audio output devices:")
            print()
            devices = get_pyaudio_devices()
            if devices:
                for device_index, device_name in devices:
                    print(f"  [{device_index}] {device_name}")
                print()
            else:
                print("  No devices found or PyAudio not available")
        elif output_mode == 'sounddevice':
            print("Available sounddevice audio output devices:")
            print()
            devices = get_sounddevice_devices()
            if devices:
                for device_index, device_name in devices:
                    print(f"  [{device_index}] {device_name}")
                print()
            else:
                print("  No devices found or sounddevice not available")
        else:
            print("Available PipeWire audio output devices:")
            print()
            sinks = get_pipewire_sinks()
            if sinks:
                for node_name, description in sinks:
                    print(f"  {node_name}")
                    print(f"    Description: {description}")
                    print()
            else:
                print("  No devices found or pw-cli not available")
        sys.exit(0)
    
    # List serial ports mode
    if args.list_serial_ports:
        try:
            from serial_cat import list_serial_ports
            print("Available serial ports:")
            print()
            ports = list_serial_ports()
            if ports:
                for port, desc, hwid in ports:
                    print(f"  {port}")
                    if desc and desc != 'n/a':
                        print(f"    Description: {desc}")
                    if hwid and hwid != 'n/a':
                        print(f"    Hardware ID: {hwid}")
                    print()
            else:
                print("  No serial ports found")
        except ImportError:
            print("Error: pyserial not available. Install with: pip install pyserial", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)

    # List local instances mode
    if args.list_local:
        list_local_instances()
        sys.exit(0)
    
    # List public instances mode
    if args.list_public:
        list_public_instances()
        sys.exit(0)
    
    # Handle callsign-based connection (resolve to UUID first)
    if args.callsign:
        print(f"Resolving callsign: {args.callsign}")
        try:
            response = requests.get(f'https://instances.ubersdr.org/api/callsign/{args.callsign}', timeout=10)
            response.raise_for_status()
            data = response.json()
            
            # Extract UUID from callsign response
            uuid = data.get('public_uuid')
            if not uuid:
                print(f"Error: Could not resolve callsign {args.callsign} to UUID", file=sys.stderr)
                sys.exit(1)
            
            print(f"Resolved to UUID: {uuid}")
            # Set args.uuid so the UUID handling code below will process it
            args.uuid = uuid
            
        except requests.exceptions.RequestException as e:
            print(f"Error resolving callsign: {e}", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            print(f"Unexpected error: {e}", file=sys.stderr)
            sys.exit(1)
    
    # Handle UUID-based connection
    if args.uuid:
        print(f"Fetching instance details for UUID: {args.uuid}")
        try:
            response = requests.get(f'https://instances.ubersdr.org/api/instances/{args.uuid}', timeout=10)
            response.raise_for_status()
            instance = response.json()
            
            # Extract connection details
            host = instance.get('host')
            port = instance.get('port')
            tls = instance.get('tls', False)
            name = instance.get('name', 'Unknown')
            
            if not host or not port:
                print(f"Error: Instance {args.uuid} does not provide connection information", file=sys.stderr)
                sys.exit(1)
            
            # Override connection parameters with instance details
            # Don't set args.url - let the client build it properly with host/port/ssl
            args.host = host
            args.port = port
            args.ssl = tls
            # Clear any existing URL to ensure host/port/ssl are used
            args.url = None
            
            print(f"Connecting to: {name}")
            print(f"  Host: {host}")
            print(f"  Port: {port}")
            print(f"  TLS:  {tls}")
            print()
            
            # Mark that we should auto-connect in GUI mode
            # This is checked later when determining auto_connect flag
            args._uuid_or_callsign_provided = True
            
        except requests.exceptions.RequestException as e:
            print(f"Error fetching instance details: {e}", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            print(f"Unexpected error: {e}", file=sys.stderr)
            sys.exit(1)
    
    # Parse output mode and UDP parameters
    output_mode = args.output
    udp_host = None
    udp_port = None
    
    # Check if output is UDP format: udp or udp:host:port
    if output_mode == 'udp':
        # Default to localhost:8888
        udp_host = '127.0.0.1'
        udp_port = 8888
        output_mode = 'udp'
    elif output_mode.startswith('udp:'):
        parts = output_mode.split(':')
        if len(parts) != 3:
            parser.error("UDP output must be in format: udp:host:port (e.g., udp:127.0.0.1:8888) or just 'udp' for default (127.0.0.1:8888)")
        try:
            udp_host = parts[1]
            udp_port = int(parts[2])
            output_mode = 'udp'
        except ValueError:
            parser.error("UDP port must be a valid integer")
    elif output_mode not in ['pipewire', 'pyaudio', 'sounddevice', 'stdout', 'wav']:
        parser.error(f"Invalid output mode: {output_mode}. Must be one of: pipewire, pyaudio, sounddevice, stdout, wav, udp, or udp:host:port")
    
    # Parse bandwidth early for GUI
    bandwidth_low = None
    bandwidth_high = None
    if args.bandwidth:
        bandwidth_low, bandwidth_high = args.bandwidth
    
    # Set bandwidth defaults based on mode if not explicitly provided
    # This ensures correct defaults for both CLI and GUI modes
    if bandwidth_low is None or bandwidth_high is None:
        mode = args.mode if args.mode else 'usb'
        mode_defaults = {
            'usb': (50, 2700),
            'lsb': (-2700, -50),
            'am': (-5000, 5000),
            'sam': (-5000, 5000),
            'cwu': (-200, 200),
            'cwl': (-200, 200),
            'fm': (-8000, 8000),
            'nfm': (-5000, 5000),
            'iq': (-5000, 5000),
            'iq48': (-5000, 5000),
            'iq96': (-5000, 5000),
            'iq192': (-5000, 5000),
            'iq384': (-5000, 5000)
        }
        default_low, default_high = mode_defaults.get(mode, (50, 2700))
        if bandwidth_low is None:
            bandwidth_low = default_low
        if bandwidth_high is None:
            bandwidth_high = default_high

    # Launch GUI by default (unless --no-gui is specified)
    if not args.no_gui:
        try:
            from radio_gui import main as gui_main
            # Determine if we should auto-connect
            # Auto-connect if --url is provided, or if --host/--port were explicitly set (not defaults)
            # Also auto-connect if --uuid or --callsign was used
            auto_connect = False
            if args.url:
                # URL was explicitly provided
                auto_connect = True
            elif hasattr(args, '_uuid_or_callsign_provided') and args._uuid_or_callsign_provided:
                # UUID or callsign was provided, so we should auto-connect
                auto_connect = True
            else:
                # Check if host or port were explicitly provided (not using defaults)
                # Parse command line to see if --host or --port were actually specified
                if '--host' in sys.argv or '-H' in sys.argv or '--port' in sys.argv or '-p' in sys.argv:
                    auto_connect = True

            # Pass configuration to GUI (bandwidth defaults already set above)
            config = {
                'url': args.url,
                'host': args.host,
                'port': args.port,
                'ssl': args.ssl,
                'password': args.password,
                'frequency': args.frequency if args.frequency else 14100000,
                'mode': args.mode if args.mode else 'usb',
                'bandwidth_low': bandwidth_low,
                'bandwidth_high': bandwidth_high,
                'auto_connect': auto_connect,
                'output_mode': output_mode
            }
            gui_main(config)
            return
        except ImportError as e:
            print(f"Error: Failed to import GUI module: {e}", file=sys.stderr)
            print("Make sure Tkinter is installed (usually included with Python)", file=sys.stderr)
            sys.exit(1)

    # Validate arguments for CLI mode
    if not args.frequency:
        parser.error("--frequency is required in CLI mode (use --no-gui)")
    if not args.mode:
        parser.error("--mode is required in CLI mode (use --no-gui)")

    if args.output == 'wav' and not args.wav_file:
        parser.error("--wav-file is required when output mode is 'wav'")

    if args.time and args.output != 'wav':
        parser.error("--time can only be used with output mode 'wav'")

    # Validate NR2 parameters
    if args.nr2_strength < 0 or args.nr2_strength > 100:
        parser.error("--nr2-strength must be between 0 and 100")
    if args.nr2_floor < 0 or args.nr2_floor > 10:
        parser.error("--nr2-floor must be between 0 and 10")
    if args.nr2_adapt_rate < 0.1 or args.nr2_adapt_rate > 5.0:
        parser.error("--nr2-adapt-rate must be between 0.1 and 5.0")
    
    # Validate URL vs host/port
    if args.url:
        # Parse URL to validate it
        try:
            parsed = urlparse(args.url)
            if parsed.scheme not in ('ws', 'wss'):
                parser.error("URL must use ws:// or wss:// scheme")
        except Exception as e:
            parser.error(f"Invalid URL: {e}")
    
    # Determine output channels
    output_channels = None
    if hasattr(args, 'channels') and args.channels is not None:
        output_channels = args.channels

    # Initialize radio control (but not TCI server yet - needs client first)
    radio_control = None
    tci_server = None
    tci_server_port = None
    
    # Store TCI port for later initialization
    if args.radio_control_type == 'tci':
        tci_server_port = args.tci_server_port
    elif args.radio_control_type != 'none':
        # Determine default port based on control type
        radio_port = args.radio_port
        if radio_port is None:
            if args.radio_control_type == 'rigctl':
                radio_port = 4532
            elif args.radio_control_type == 'flrig':
                radio_port = 12345
            else:  # omnirig doesn't use port
                radio_port = 0
        
        try:
            if args.radio_control_type == 'rigctl':
                from rigctl import ThreadedRigctlClient
                print(f"Connecting to rigctl at {args.radio_host}:{radio_port}...", file=sys.stderr)
                radio_control = ThreadedRigctlClient(args.radio_host, radio_port)
                radio_control.connect()
                print("✓ Connected to rigctl", file=sys.stderr)
            
            elif args.radio_control_type == 'flrig':
                from flrig_control import ThreadedFlrigClient
                print(f"Connecting to flrig at {args.radio_host}:{radio_port} (VFO {args.radio_vfo})...", file=sys.stderr)
                radio_control = ThreadedFlrigClient(args.radio_host, radio_port, args.radio_vfo)
                radio_control.connect()
                print("✓ Connected to flrig", file=sys.stderr)
            
            elif args.radio_control_type == 'omnirig':
                from omnirig_control import ThreadedOmniRigClient
                print(f"Connecting to OmniRig (Rig {args.radio_rig}, VFO {args.radio_vfo})...", file=sys.stderr)
                radio_control = ThreadedOmniRigClient(args.radio_rig, args.radio_vfo)
                if not radio_control.connect():
                    print("ERROR: Failed to connect to OmniRig", file=sys.stderr)
                    sys.exit(1)
                print("✓ Connected to OmniRig", file=sys.stderr)

            elif args.radio_control_type == 'serial':
                if not args.radio_serial_port:
                    print("ERROR: --radio-serial-port is required for serial control type", file=sys.stderr)
                    print("Use --list-serial-ports to see available ports", file=sys.stderr)
                    sys.exit(1)

                from serial_cat import ThreadedSerialCATClient
                print(f"Connecting to Serial CAT on {args.radio_serial_port} (VFO {args.radio_vfo})...", file=sys.stderr)
                radio_control = ThreadedSerialCATClient(args.radio_serial_port, args.radio_vfo)
                if not radio_control.connect():
                    print(f"ERROR: Failed to connect to serial port {args.radio_serial_port}", file=sys.stderr)
                    print("Check that the port exists and you have permission to access it", file=sys.stderr)
                    sys.exit(1)
                print(f"✓ Connected to Serial CAT on {args.radio_serial_port} VFO-{args.radio_vfo} (Kenwood TS-480 protocol)", file=sys.stderr)

        except ImportError as e:
            print(f"ERROR: Failed to import radio control module: {e}", file=sys.stderr)
            if args.radio_control_type == 'serial':
                print("Install pyserial with: pip install pyserial", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            print(f"ERROR: Failed to connect to radio control: {e}", file=sys.stderr)
            sys.exit(1)

    # Create client
    client = RadioClient(
        url=args.url,
        host=args.host,
        port=args.port,
        frequency=args.frequency,
        mode=args.mode,
        bandwidth_low=bandwidth_low,
        bandwidth_high=bandwidth_high,
        output_mode=output_mode,
        wav_file=args.wav_file,
        duration=args.time,
        ssl=args.ssl,
        password=args.password,
        nr2_enabled=args.nr2,
        nr2_strength=args.nr2_strength,
        nr2_floor=args.nr2_floor,
        nr2_adapt_rate=args.nr2_adapt_rate,
        auto_reconnect=args.auto_reconnect,
        fifo_path=args.fifo_path,
        audio_filter_enabled=args.audio_filter,
        audio_filter_low=args.audio_filter_low,
        audio_filter_high=args.audio_filter_high,
        sounddevice_device_index=None,  # TODO: Add command-line argument for device selection
        udp_host=udp_host,
        udp_port=udp_port,
        output_channels=output_channels,
        udp_stereo=False,  # CLI default: mono (can be added as argument if needed)
        use_opus=args.opus
    )
    
    # Initialize TCI server now that client exists
    if tci_server_port is not None:
        try:
            from tci_server import TCIServer
            print(f"Starting TCI server on port {tci_server_port}...", file=sys.stderr)

            # Create callback to handle TCI frequency/mode changes
            def tci_callback(param_type: str, value):
                """Handle TCI parameter changes by sending to WebSocket."""
                if param_type == 'frequency':
                    # Update client's frequency state
                    client.frequency = value
                    # Send tune message to WebSocket
                    if client.ws and hasattr(client, '_event_loop') and client._event_loop:
                        # Check if this is an IQ mode - IQ modes don't accept bandwidth parameters
                        is_iq_mode = client.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')

                        tune_msg = {
                            'type': 'tune',
                            'frequency': value,
                            'mode': client.mode
                        }

                        # Only include bandwidth for non-IQ modes
                        if not is_iq_mode:
                            tune_msg['bandwidthLow'] = client.bandwidth_low
                            tune_msg['bandwidthHigh'] = client.bandwidth_high

                        future = asyncio.run_coroutine_threadsafe(
                            client.ws.send(json.dumps(tune_msg)),
                            client._event_loop
                        )
                        try:
                            future.result(timeout=1.0)
                            print(f"TCI → SDR: {value} Hz", file=sys.stderr)
                        except Exception as e:
                            print(f"Failed to send frequency: {e}", file=sys.stderr)

                elif param_type == 'mode':
                    # Update client's mode state
                    client.mode = value.lower()
                    # Send tune message to WebSocket
                    if client.ws and hasattr(client, '_event_loop') and client._event_loop:
                        # Check if this is an IQ mode - IQ modes don't accept bandwidth parameters
                        is_iq_mode = client.mode in ('iq', 'iq48', 'iq96', 'iq192', 'iq384')

                        tune_msg = {
                            'type': 'tune',
                            'frequency': client.frequency,
                            'mode': client.mode
                        }

                        # Only include bandwidth for non-IQ modes
                        if not is_iq_mode:
                            tune_msg['bandwidthLow'] = client.bandwidth_low
                            tune_msg['bandwidthHigh'] = client.bandwidth_high

                        future = asyncio.run_coroutine_threadsafe(
                            client.ws.send(json.dumps(tune_msg)),
                            client._event_loop
                        )
                        try:
                            future.result(timeout=1.0)
                            print(f"TCI → SDR: {value}", file=sys.stderr)
                        except Exception as e:
                            print(f"Failed to send mode: {e}", file=sys.stderr)

            tci_server = TCIServer(client, port=tci_server_port, gui_callback=tci_callback)
            if not tci_server.start():
                print(f"ERROR: Failed to start TCI server on port {tci_server_port}", file=sys.stderr)
                print(f"Port {tci_server_port} may already be in use", file=sys.stderr)
                sys.exit(1)
            print(f"✓ TCI server started successfully", file=sys.stderr)
            print(f"✓ TCI server listening on ws://0.0.0.0:{tci_server_port}", file=sys.stderr)
            print(f"✓ TCI clients can now connect to this server", file=sys.stderr)
        except ImportError as e:
            print(f"ERROR: Failed to import TCI server module: {e}", file=sys.stderr)
            print("Install websockets with: pip install websockets", file=sys.stderr)
            sys.exit(1)
        except OSError as e:
            if e.errno == 98:  # Address already in use
                print(f"ERROR: TCI server port {tci_server_port} is already in use", file=sys.stderr)
                print(f"Another application may be using this port", file=sys.stderr)
            else:
                print(f"ERROR: Failed to start TCI server: {e}", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            print(f"ERROR: Failed to start TCI server: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc()
            sys.exit(1)
    
    # Setup radio control callbacks if enabled
    if radio_control:
        sync_direction = args.radio_sync_direction
        
        # Track last values to avoid feedback loops
        last_sdr_freq = args.frequency
        last_sdr_mode = args.mode
        last_rig_freq = None
        last_rig_mode = None
        
        # Mode mapping: SDR modes to radio modes
        sdr_to_radio_mode = {
            'usb': 'USB',
            'lsb': 'LSB',
            'am': 'AM',
            'sam': 'AM',
            'fm': 'FM',
            'nfm': 'FM',
            'cwu': 'CW',
            'cwl': 'CW'
        }
        
        # Mode mapping: radio modes to SDR modes
        radio_to_sdr_mode = {
            'USB': 'usb',
            'LSB': 'lsb',
            'AM': 'am',
            'FM': 'fm',
            'CW': 'cwu'
        }
        
        def on_rig_frequency_change(freq_hz: int):
            """Called when rig frequency changes."""
            nonlocal last_rig_freq, last_sdr_freq
            if sync_direction in ('rig-to-sdr', 'bidirectional'):
                # Avoid feedback loop
                if last_rig_freq != freq_hz and abs(freq_hz - last_sdr_freq) > 100:
                    last_rig_freq = freq_hz
                    last_sdr_freq = freq_hz
                    # Update SDR frequency via WebSocket (use 'tune' message type like GUI does)
                    if client.ws and hasattr(client, '_event_loop') and client._event_loop:
                        # Schedule the coroutine and get the future
                        future = asyncio.run_coroutine_threadsafe(
                            client.ws.send(json.dumps({
                                'type': 'tune',
                                'frequency': freq_hz,
                                'mode': client.mode,
                                'bandwidthLow': client.bandwidth_low,
                                'bandwidthHigh': client.bandwidth_high
                            })),
                            client._event_loop
                        )
                        # Wait for completion with timeout to ensure it actually sends
                        try:
                            future.result(timeout=1.0)
                            print(f"Radio → SDR: {freq_hz} Hz", file=sys.stderr)
                        except Exception as e:
                            print(f"Failed to send frequency: {e}", file=sys.stderr)

        def on_rig_mode_change(mode: str):
            """Called when rig mode changes."""
            nonlocal last_rig_mode, last_sdr_mode
            if sync_direction in ('rig-to-sdr', 'bidirectional'):
                # Avoid feedback loop
                if last_rig_mode != mode:
                    last_rig_mode = mode
                    sdr_mode = radio_to_sdr_mode.get(mode.upper(), 'usb')
                    if sdr_mode != last_sdr_mode:
                        last_sdr_mode = sdr_mode
                        # Update client's mode state
                        client.mode = sdr_mode
                        # Update SDR mode via WebSocket (use 'tune' message type like GUI does)
                        if client.ws and hasattr(client, '_event_loop') and client._event_loop:
                            # Schedule the coroutine and get the future
                            future = asyncio.run_coroutine_threadsafe(
                                client.ws.send(json.dumps({
                                    'type': 'tune',
                                    'frequency': client.frequency,
                                    'mode': sdr_mode,
                                    'bandwidthLow': client.bandwidth_low,
                                    'bandwidthHigh': client.bandwidth_high
                                })),
                                client._event_loop
                            )
                            # Wait for completion with timeout to ensure it actually sends
                            try:
                                future.result(timeout=1.0)
                                print(f"Radio → SDR: {mode} → {sdr_mode}", file=sys.stderr)
                            except Exception as e:
                                print(f"Failed to send mode: {e}", file=sys.stderr)
        
        def on_rig_error(error: str):
            """Called when radio control error occurs."""
            print(f"Radio control error: {error}", file=sys.stderr)
        
        # Set up callbacks for rig-to-SDR sync
        if sync_direction in ('rig-to-sdr', 'bidirectional'):
            radio_control.set_callbacks(
                frequency_callback=on_rig_frequency_change,
                mode_callback=on_rig_mode_change,
                error_callback=on_rig_error
            )
            print(f"Radio sync: {sync_direction}", file=sys.stderr)

        # Set up SDR-to-rig sync by modifying client's handle_message
        if sync_direction in ('sdr-to-rig', 'bidirectional'):
            original_handle_message = client.handle_message

            async def handle_message_with_sync(message: dict):
                """Wrapper to sync SDR changes to rig."""
                nonlocal last_sdr_freq, last_sdr_mode, last_rig_freq, last_rig_mode

                # Call original handler
                await original_handle_message(message)

                # Check for frequency/mode changes in status messages
                msg_type = message.get('type')
                if msg_type == 'status':
                    freq = message.get('frequency')
                    mode = message.get('mode', '').lower()

                    # Sync frequency to rig
                    if freq and freq != last_sdr_freq:
                        # Avoid feedback loop
                        if last_rig_freq is None or abs(freq - last_rig_freq) > 100:
                            last_sdr_freq = freq
                            radio_control.set_frequency(freq)
                            print(f"SDR → Radio: {freq} Hz", file=sys.stderr)

                    # Sync mode to rig
                    if mode and mode != last_sdr_mode:
                        radio_mode = sdr_to_radio_mode.get(mode, 'USB')
                        # Avoid feedback loop
                        if last_rig_mode is None or radio_mode.upper() != last_rig_mode.upper():
                            last_sdr_mode = mode
                            radio_control.set_mode(radio_mode)
                            print(f"SDR → Radio: {mode} → {radio_mode}", file=sys.stderr)

            client.handle_message = handle_message_with_sync

            # Perform initial sync from SDR to rig
            # This ensures the rig is set to the initial frequency/mode when starting
            print(f"Initial sync: Setting radio to {args.frequency} Hz, {args.mode}", file=sys.stderr)
            radio_mode = sdr_to_radio_mode.get(args.mode, 'USB')
            radio_control.set_frequency(args.frequency)
            radio_control.set_mode(radio_mode)
            last_sdr_freq = args.frequency
            last_sdr_mode = args.mode
            last_rig_freq = args.frequency
            last_rig_mode = radio_mode

        # Store radio control and sync settings on client for later use
        client.radio_control = radio_control
        client.radio_sync_direction = sync_direction
    
    # Store TCI server reference on client
    if tci_server:
        client.tci_server = tci_server
        
        # Set up callbacks to update TCI server when SDR state changes
        original_handle_message = client.handle_message
        
        async def handle_message_with_tci(message: dict):
            """Wrapper to update TCI server on SDR changes."""
            # Call original handler
            await original_handle_message(message)
            
            # Update TCI server with SDR state changes
            msg_type = message.get('type')
            if msg_type == 'status':
                freq = message.get('frequency')
                mode = message.get('mode', '').lower()
                
                if freq:
                    tci_server.update_frequency(freq)
                if mode:
                    tci_server.update_mode(mode)
        
        client.handle_message = handle_message_with_tci
    
    # Setup signal handler for graceful shutdown
    def signal_handler(sig, frame):
        print("\nInterrupted, shutting down...", file=sys.stderr)
        client.running = False
        if radio_control:
            radio_control.disconnect()
        if tci_server:
            tci_server.stop()
    
    signal.signal(signal.SIGINT, signal_handler)
    # SIGTERM not available on Windows
    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, signal_handler)
    
    # Run client
    try:
        exit_code = asyncio.run(client.run())
        if radio_control:
            radio_control.disconnect()
        if tci_server:
            tci_server.stop()
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\nInterrupted", file=sys.stderr)
        if radio_control:
            radio_control.disconnect()
        if tci_server:
            tci_server.stop()
        sys.exit(0)


if __name__ == '__main__':
    # CRITICAL: freeze_support() must be the FIRST thing called in __main__
    # It detects if this is a spawned child process in a frozen executable and exits
    import multiprocessing
    multiprocessing.freeze_support()
    
    main()