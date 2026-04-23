"""
BenchmarkConfig - shared configuration dataclass for the UberSDR benchmark tool.
"""

from __future__ import annotations

import math
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
    """HTTP(S) base URL, e.g. ``http://localhost:8073`` or ``https://radio.example.com``.
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
    """Tuned frequency in Hz (e.g. 14200000 = 14.2 MHz)."""

    mode: str = 'usb'
    """Demodulation mode string (see VALID_MODES)."""

    bandwidth_low: Optional[int] = None
    """Low edge of filter in Hz.  ``None`` → use mode default."""

    bandwidth_high: Optional[int] = None
    """High edge of filter in Hz.  ``None`` → use mode default."""

    # --- Spectrum ---
    spectrum_zoom_khz: float = 200.0
    """Total spectrum display bandwidth in kHz sent as the zoom command (default 200 kHz)."""

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
