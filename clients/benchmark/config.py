"""
BenchmarkConfig - shared configuration dataclass for the UberSDR benchmark tool.
UserState      - per-user mutable state (frequency, mode, spectrum zoom).
"""

from __future__ import annotations

import math
import random
import threading
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Mode constants (mirrors radio_client.py)
# ---------------------------------------------------------------------------

VALID_MODES = (
    'am', 'sam', 'usb', 'lsb', 'fm', 'nfm',
    'cwu', 'cwl',
    'iq', 'iq48', 'iq96', 'iq192', 'iq384',
)

IQ_MODES = ('iq', 'iq48', 'iq96', 'iq192', 'iq384')

# Default bandwidth (low, high) per mode — matches radio_client.py main() exactly.
# IQ modes have no bandwidth (None = don't send bandwidthLow/High).
MODE_BANDWIDTH_DEFAULTS: dict[str, Optional[tuple[int, int]]] = {
    'usb':   (50,    2700),
    'lsb':   (-2700, -50),
    'am':    (-5000, 5000),
    'sam':   (-5000, 5000),
    'cwu':   (-200,  200),
    'cwl':   (-200,  200),
    'fm':    (-8000, 8000),
    'nfm':   (-5000, 5000),
    'iq':    None,
    'iq48':  None,
    'iq96':  None,
    'iq192': None,
    'iq384': None,
}

# Random-frequency range (Hz)
RANDOM_FREQ_MIN_HZ: int = 100_000       # 100 kHz
RANDOM_FREQ_MAX_HZ: int = 29_000_000    # 29 MHz

# Threshold for auto-mode selection
AUTO_MODE_THRESHOLD_HZ: int = 10_000_000  # 10 MHz

# Spectrum zoom levels (kHz) cycled through in random-frequency mode
RANDOM_ZOOM_LEVELS_KHZ: tuple[float, ...] = (50.0, 100.0, 200.0, 500.0, 1000.0)

# How often (seconds) to rotate frequency and zoom in random-frequency mode.
# Each rotation picks a new random interval in [min, max].
RANDOM_ROTATE_INTERVAL_MIN: float = 1.0
RANDOM_ROTATE_INTERVAL_MAX: float = 10.0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def auto_mode_for(frequency_hz: int) -> str:
    """Return 'lsb' for frequencies below 10 MHz, 'usb' for 10 MHz and above."""
    return 'lsb' if frequency_hz < AUTO_MODE_THRESHOLD_HZ else 'usb'


def random_frequency() -> int:
    """Pick a random frequency between RANDOM_FREQ_MIN_HZ and RANDOM_FREQ_MAX_HZ."""
    return random.randint(RANDOM_FREQ_MIN_HZ, RANDOM_FREQ_MAX_HZ)


def random_zoom_khz() -> float:
    """Pick a random spectrum zoom level from RANDOM_ZOOM_LEVELS_KHZ."""
    return random.choice(RANDOM_ZOOM_LEVELS_KHZ)


# ---------------------------------------------------------------------------
# UserState — per-user mutable radio state
# ---------------------------------------------------------------------------

class UserState:
    """Holds the live frequency, mode, bandwidth and spectrum zoom for one user.

    In random-frequency mode this is updated every 1–10 seconds (random
    interval) by a background task inside VirtualUser.  AudioWebSocket and
    SpectrumWebSocket read from this object when (re-)connecting or sending
    zoom commands, so they always use the current values.

    All attribute writes are GIL-safe for simple assignments in CPython.
    """

    def __init__(
        self,
        frequency: int,
        mode: str,
        bandwidth_low: Optional[int],
        bandwidth_high: Optional[int],
        spectrum_zoom_khz: float,
    ) -> None:
        self.frequency = frequency
        self.mode = mode
        self.bandwidth_low = bandwidth_low
        self.bandwidth_high = bandwidth_high
        self.spectrum_zoom_khz = spectrum_zoom_khz

        # Incremented each time the frequency/zoom changes so WS handlers can
        # detect a change and re-send the zoom command.
        self._generation: int = 0
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Read helpers
    # ------------------------------------------------------------------

    @property
    def generation(self) -> int:
        """Monotonically increasing counter; changes whenever state rotates."""
        return self._generation

    @property
    def spectrum_zoom_hz(self) -> float:
        """Spectrum zoom bandwidth in Hz."""
        return self.spectrum_zoom_khz * 1000.0

    @property
    def is_iq_mode(self) -> bool:
        """True when the mode is an IQ capture mode (no bandwidth params)."""
        return self.mode in IQ_MODES

    # ------------------------------------------------------------------
    # Mutation
    # ------------------------------------------------------------------

    def rotate(self, new_frequency: int, new_zoom_khz: float) -> None:
        """Update frequency, auto-select mode, update bandwidth and zoom.

        Called by the VirtualUser background task at a random interval (1–10 s).
        """
        new_mode = auto_mode_for(new_frequency)
        defaults = MODE_BANDWIDTH_DEFAULTS.get(new_mode)
        if defaults is not None:
            new_bw_low, new_bw_high = defaults
        else:
            new_bw_low, new_bw_high = None, None

        with self._lock:
            self.frequency = new_frequency
            self.mode = new_mode
            self.bandwidth_low = new_bw_low
            self.bandwidth_high = new_bw_high
            self.spectrum_zoom_khz = new_zoom_khz
            self._generation += 1


# ---------------------------------------------------------------------------
# BenchmarkConfig
# ---------------------------------------------------------------------------

@dataclass
class BenchmarkConfig:
    """All settings for a benchmark run.

    Constructed by benchmark.py from parsed CLI arguments, then passed
    (read-only) to every VirtualUser and WebSocket handler.
    """

    # --- Connection ---
    url: str
    """HTTP(S) base URL, e.g. ``http://localhost:8080`` or ``https://radio.example.com``.
    WebSocket URLs are derived automatically by swapping the scheme."""

    ssl: bool = False
    """Use WSS / HTTPS (also inferred automatically from an ``https://`` URL)."""

    password: Optional[str] = None
    """Bypass password sent to ``POST /connection`` and audio WS."""

    # --- Scale ---
    users: int = 10
    """Total number of simulated concurrent users."""

    threads: int = 4
    """Number of OS threads.  Each thread runs its own asyncio event loop."""

    duration: float = 60.0
    """How long (seconds) to run the benchmark before stopping."""

    ramp_up: float = 5.0
    """Seconds over which all users are staggered at startup (avoids thundering herd)."""

    report_interval: float = 5.0
    """Seconds between live console reports."""

    reconnect: bool = False
    """Auto-reconnect individual WebSockets on disconnect."""

    # --- Audio / demodulation ---
    frequency: int = 14_200_000
    """Tuned frequency in Hz (e.g. 14200000 = 14.2 MHz).  Ignored when
    random_frequency is True."""

    mode: str = 'usb'
    """Demodulation mode string (see VALID_MODES).  Ignored when
    random_frequency is True (mode is derived automatically from frequency)."""

    bandwidth_low: Optional[int] = None
    """Low edge of filter in Hz.  ``None`` → use mode default."""

    bandwidth_high: Optional[int] = None
    """High edge of filter in Hz.  ``None`` → use mode default."""

    # --- Random frequency ---
    random_frequency: bool = False
    """When True, each user picks a random frequency (100 kHz – 29 MHz) and
    rotates it every 1–10 seconds (random per-user interval).  Mode is selected
    automatically (lsb / usb) and spectrum zoom is also randomised."""

    # --- Spectrum ---
    spectrum_zoom_khz: float = 200.0
    """Total spectrum display bandwidth in kHz sent as the zoom command (default 200 kHz).
    Ignored when random_frequency is True (zoom is randomised per rotation)."""

    spectrum_default: bool = False
    """When True, do not send a zoom command after the config message — use the server's
    default spectrum parameters.  This exercises the shared-default-spectrum-channel path
    where all users at default params share a single radiod channel."""

    # --- Feature flags ---
    enable_audio: bool = True
    """Connect the audio WebSocket (``/ws``)."""

    enable_spectrum: bool = True
    """Connect the spectrum WebSocket (``/ws/user-spectrum``)."""

    enable_dxcluster: bool = True
    """Connect the DX cluster WebSocket (``/ws/dxcluster``)."""

    debug: bool = False
    """Print per-user error details to stderr (useful for diagnosing connection failures)."""

    # --- Derived (set in __post_init__) ---
    http_url: str = field(init=False, repr=False)
    """Normalised HTTP base URL (no trailing slash, no path) used for ``POST /connection``."""

    ws_base: str = field(init=False, repr=False)
    """WebSocket base URL derived from *url* by swapping ``http`` → ``ws`` / ``https`` → ``wss``."""

    def __post_init__(self) -> None:
        from urllib.parse import urlparse

        # Normalise: strip trailing slash / path so we always build paths ourselves
        parsed = urlparse(self.url.rstrip('/'))
        scheme = parsed.scheme.lower()

        # Accept http/https as input; also accept ws/wss for backwards compat
        if scheme in ('http', 'ws'):
            http_scheme = 'http'
            ws_scheme = 'ws'
        elif scheme in ('https', 'wss'):
            http_scheme = 'https'
            ws_scheme = 'wss'
            self.ssl = True
        else:
            # Fall back: treat as plain http
            http_scheme = 'http'
            ws_scheme = 'ws'

        netloc = parsed.netloc
        self.http_url = f"{http_scheme}://{netloc}"
        self.ws_base = f"{ws_scheme}://{netloc}"

        if not self.random_frequency:
            # Resolve bandwidth defaults from mode
            defaults = MODE_BANDWIDTH_DEFAULTS.get(self.mode)
            if defaults is not None:
                low_default, high_default = defaults
                if self.bandwidth_low is None:
                    self.bandwidth_low = low_default
                if self.bandwidth_high is None:
                    self.bandwidth_high = high_default
            # IQ modes: leave bandwidth_low/high as None (don't send them)

    # --- Convenience properties ---

    @property
    def is_iq_mode(self) -> bool:
        """True when the mode is an IQ capture mode (no bandwidth params)."""
        return self.mode in IQ_MODES

    @property
    def spectrum_zoom_hz(self) -> float:
        """Spectrum zoom bandwidth in Hz."""
        return self.spectrum_zoom_khz * 1000.0

    @property
    def users_per_thread(self) -> int:
        """Number of users assigned to each thread (ceiling division)."""
        return math.ceil(self.users / max(1, self.threads))

    def user_batches(self) -> list[list[int]]:
        """Split user IDs (0-based) into per-thread batches.

        Returns a list of lists, one inner list per thread.
        """
        all_ids = list(range(self.users))
        size = self.users_per_thread
        return [all_ids[i:i + size] for i in range(0, self.users, size)]

    def ramp_delay_for(self, user_id: int) -> float:
        """Return the pre-connect sleep duration (seconds) for a given user.

        Users are staggered evenly across *ramp_up* seconds so that all
        ``self.users`` connections are spread out rather than hitting the
        server simultaneously.
        """
        if self.users <= 1 or self.ramp_up <= 0:
            return 0.0
        return (user_id / (self.users - 1)) * self.ramp_up

    def make_user_state(self) -> "UserState":
        """Create a fresh UserState for one virtual user.

        In random-frequency mode the initial frequency and zoom are randomised;
        otherwise the configured fixed values are used.
        """
        if self.random_frequency:
            freq = random_frequency()
            mode = auto_mode_for(freq)
            defaults = MODE_BANDWIDTH_DEFAULTS.get(mode)
            bw_low, bw_high = defaults if defaults else (None, None)
            zoom = random_zoom_khz()
        else:
            freq = self.frequency
            mode = self.mode
            bw_low = self.bandwidth_low
            bw_high = self.bandwidth_high
            zoom = self.spectrum_zoom_khz

        return UserState(
            frequency=freq,
            mode=mode,
            bandwidth_low=bw_low,
            bandwidth_high=bw_high,
            spectrum_zoom_khz=zoom,
        )
