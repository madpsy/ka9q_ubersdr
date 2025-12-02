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
import stat
import struct
import sys
import time
import uuid
import wave
from typing import Optional, List, Tuple

import aiohttp
import websockets
from urllib.parse import urlparse, parse_qs, urlencode
import numpy as np
import subprocess
import re

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
                 sounddevice_device_index: Optional[int] = None):
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
            # Always output as stereo to support left/right channel control
            output_channels = 2

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
            sys.exit(1)
    
    async def setup_pyaudio(self):
        """Start PyAudio playback stream."""
        if not PYAUDIO_AVAILABLE:
            print("Error: PyAudio not available. Install with: pip install pyaudio", file=sys.stderr)
            sys.exit(1)

        try:
            # Always output as stereo to support left/right channel control
            output_channels = 2

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
            sys.exit(1)

    async def setup_sounddevice(self):
        """Start sounddevice playback stream."""
        if not SOUNDDEVICE_AVAILABLE:
            print("Error: sounddevice not available. Install with: pip install sounddevice", file=sys.stderr)
            sys.exit(1)

        try:
            # Always output as stereo to support left/right channel control
            output_channels = 2

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
            sys.exit(1)

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
    
    async def output_audio(self, pcm_data: bytes):
        """Output audio data based on selected mode."""
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
        
        # Convert mono to stereo for output (PipeWire always expects stereo)
        if self.channels == 1:
            # Duplicate mono to both channels
            audio_float = np.column_stack((audio_float, audio_float))
        
        # Apply channel selection (now always stereo)
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
                    audio_array_for_sd = np.frombuffer(pcm_data, dtype=np.int16).reshape(-1, 2)
                    self.sounddevice_stream.write(audio_array_for_sd)
                except Exception as e:
                    print(f"sounddevice error: {e}", file=sys.stderr)
                    self.running = False

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
                # Store websocket reference for GUI access
                self.ws = websocket
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
                
                # Start keepalive task
                keepalive_task = asyncio.create_task(self.send_keepalive(websocket))
                
                # Receive and process messages
                while self.running:
                    try:
                        message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
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
                
        except Exception as e:
            print(f"Connection error: {e}", file=sys.stderr)
            return 1
        finally:
            # Clear websocket reference
            self.ws = None
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


def main():
    parser = argparse.ArgumentParser(
        description='CLI Radio Client for ka9q_ubersdr',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Launch GUI interface (default)
  %(prog)s

  # Listen to 14.074 MHz USB via PipeWire (CLI mode)
  %(prog)s --no-gui -f 14074000 -m usb

  # Connect using full URL (CLI mode)
  %(prog)s --no-gui -u ws://radio.example.com:8073/ws -f 14074000 -m usb

  # Record 1000 kHz AM to WAV file for 60 seconds (CLI mode)
  %(prog)s --no-gui -f 1000000 -m am -o wav -w recording.wav -t 60

  # Output raw PCM to stdout with custom bandwidth (CLI mode)
  %(prog)s --no-gui -f 7100000 -m lsb -b -2700:-50 -o stdout > audio.pcm
        """
    )
    
    parser.add_argument('--no-gui', action='store_true',
                        help='Disable GUI and use command-line interface (requires --frequency and --mode)')
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
    parser.add_argument('-o', '--output', choices=['pipewire', 'pyaudio', 'sounddevice', 'stdout', 'wav'],
                        default='sounddevice',
                        help='Output mode (default: sounddevice)')
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
    parser.add_argument('--fifo-path', type=str, metavar='PATH',
                        help='Also write audio to named pipe (FIFO) at this path (non-blocking, works with any output mode)')

    parser.add_argument('--audio-filter', action='store_true',
                        help='Enable audio bandpass filter')
    parser.add_argument('--audio-filter-low', type=float, default=300.0, metavar='HZ',
                        help='Audio filter low cutoff frequency in Hz (default: 300)')
    parser.add_argument('--audio-filter-high', type=float, default=2700.0, metavar='HZ',
                        help='Audio filter high cutoff frequency in Hz (default: 2700)')

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
            auto_connect = False
            if args.url:
                # URL was explicitly provided
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
                'output_mode': args.output
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
    
    # Create client
    client = RadioClient(
        url=args.url,
        host=args.host,
        port=args.port,
        frequency=args.frequency,
        mode=args.mode,
        bandwidth_low=bandwidth_low,
        bandwidth_high=bandwidth_high,
        output_mode=args.output,
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
        sounddevice_device_index=None  # TODO: Add command-line argument for device selection
    )
    
    # Setup signal handler for graceful shutdown
    def signal_handler(sig, frame):
        print("\nInterrupted, shutting down...", file=sys.stderr)
        client.running = False
    
    signal.signal(signal.SIGINT, signal_handler)
    # SIGTERM not available on Windows
    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, signal_handler)
    
    # Run client
    try:
        exit_code = asyncio.run(client.run())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\nInterrupted", file=sys.stderr)
        sys.exit(0)


if __name__ == '__main__':
    # CRITICAL: freeze_support() must be the FIRST thing called in __main__
    # It detects if this is a spawned child process in a frozen executable and exits
    import multiprocessing
    multiprocessing.freeze_support()
    
    main()