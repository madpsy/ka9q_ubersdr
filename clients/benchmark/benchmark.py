#!/usr/bin/env python3
"""
benchmark.py - UberSDR Load Benchmark Tool

Simulates N concurrent real users against a ka9q_ubersdr instance.
Each user opens up to three WebSocket connections:
  - Audio      (/ws)
  - Spectrum   (/ws/user-spectrum)
  - DX Cluster (/ws/dxcluster)

Users are distributed across multiple threads (each with its own asyncio
event loop) for true parallelism.

Usage examples
--------------
# 50 users, 14.074 MHz USB, default 200 kHz spectrum, 2 minute run
python benchmark.py --url http://localhost:8073 \\
    --users 50 --threads 10 --duration 120 \\
    -f 14074000 -m usb

# 100 users, 7.1 MHz LSB with explicit bandwidth, 500 kHz spectrum zoom
python benchmark.py --url http://radio.example.com:8073 \\
    --users 100 --threads 10 --duration 300 \\
    -f 7100000 -m lsb -b -2700:-50 \\
    --spectrum-zoom 500 --password secret

# Audio only (no spectrum, no DX cluster)
python benchmark.py --url http://localhost:8073 \\
    --users 20 -f 14200000 -m usb \\
    --no-spectrum --no-dxcluster

# IQ mode (no bandwidth sent, as per original client)
python benchmark.py --url http://localhost:8073 \\
    --users 5 -f 14000000 -m iq96 --password bypass_password
"""

from __future__ import annotations

import argparse
import sys
from typing import Optional, Tuple

from config import BenchmarkConfig, VALID_MODES


# ---------------------------------------------------------------------------
# Bandwidth argument parser (mirrors radio_client.py parse_bandwidth())
# ---------------------------------------------------------------------------

def parse_bandwidth(value: str) -> Tuple[int, int]:
    """Parse bandwidth argument in format 'low:high'.

    Examples: '50:2700', '-2700:-50', '-5000:5000'
    """
    try:
        parts = value.split(':')
        if len(parts) != 2:
            raise ValueError
        low = int(parts[0])
        high = int(parts[1])
        return low, high
    except (ValueError, AttributeError):
        raise argparse.ArgumentTypeError(
            f"Bandwidth must be in format 'low:high' (e.g. '50:2700' or '-2700:-50'), "
            f"got: {value!r}"
        )


# ---------------------------------------------------------------------------
# Argument parser
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='benchmark.py',
        description='UberSDR Load Benchmark — simulates N concurrent real users.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    # --- Connection ---
    conn = parser.add_argument_group('Connection')
    conn.add_argument(
        '--url', required=True, metavar='URL',
        help='Server base URL, e.g. http://localhost:8073 or https://radio.example.com. '
             'WebSocket URLs are derived automatically (http→ws, https→wss).',
    )
    conn.add_argument(
        '--password', metavar='PW', default=None,
        help='Bypass password (sent to POST /connection and audio WebSocket)',
    )
    conn.add_argument(
        '--ssl', action='store_true',
        help='Force WSS/HTTPS (also inferred automatically from a wss:// URL)',
    )

    # --- Scale ---
    scale = parser.add_argument_group('Scale')
    scale.add_argument(
        '--users', type=int, default=10, metavar='N',
        help='Number of simulated concurrent users (default: 10)',
    )
    scale.add_argument(
        '--threads', type=int, default=4, metavar='N',
        help='Number of OS threads; each runs its own asyncio event loop (default: 4)',
    )
    scale.add_argument(
        '--duration', type=float, default=60.0, metavar='SECS',
        help='Benchmark duration in seconds (default: 60)',
    )
    scale.add_argument(
        '--ramp-up', type=float, default=5.0, metavar='SECS',
        help='Seconds over which all users are staggered at startup (default: 5)',
    )
    scale.add_argument(
        '--report-interval', type=float, default=5.0, metavar='SECS',
        help='Seconds between live console reports (default: 5)',
    )
    scale.add_argument(
        '--reconnect', action='store_true',
        help='Auto-reconnect individual WebSockets on disconnect',
    )

    # --- Audio / demodulation (mirrors radio_client.py CLI) ---
    radio = parser.add_argument_group('Radio / Demodulation')
    radio.add_argument(
        '-f', '--frequency', type=int, default=14_200_000, metavar='HZ',
        help='Tuned frequency in Hz (default: 14200000 = 14.2 MHz)',
    )
    radio.add_argument(
        '-m', '--mode', default='usb', choices=list(VALID_MODES),
        help='Demodulation mode (default: usb)',
    )
    radio.add_argument(
        '-b', '--bandwidth', type=parse_bandwidth, metavar='LOW:HIGH',
        help=(
            'Bandwidth override in format low:high Hz '
            '(e.g. -b 50:2700 or -b -2700:-50). '
            'If omitted, mode-appropriate defaults are used: '
            'usb=50:2700, lsb=-2700:-50, am=-5000:5000, '
            'cwu=-200:200, fm=-8000:8000, nfm=-5000:5000. '
            'Ignored for IQ modes.'
        ),
    )

    # --- Spectrum ---
    spec = parser.add_argument_group('Spectrum')
    spec.add_argument(
        '--spectrum-zoom', type=float, default=200.0, metavar='KHZ',
        help=(
            'Spectrum display bandwidth in kHz sent as the zoom command '
            'after the first config message (default: 200 kHz). '
            'Matches spectrum_display.py behaviour.'
        ),
    )
    spec.add_argument(
        '--spectrum-default', action='store_true',
        help=(
            'Do not send a zoom command after the config message — stay at '
            'the server\'s default spectrum parameters. '
            'All users with this flag share a single radiod spectrum channel '
            '(the shared-default-spectrum-channel feature). '
            'Mutually exclusive with --spectrum-zoom having any effect.'
        ),
    )

    # --- Feature flags ---
    feat = parser.add_argument_group('Feature flags')
    feat.add_argument(
        '--no-audio', action='store_true',
        help='Disable audio WebSocket connections (/ws)',
    )
    feat.add_argument(
        '--no-spectrum', action='store_true',
        help='Disable spectrum WebSocket connections (/ws/user-spectrum)',
    )
    feat.add_argument(
        '--no-dxcluster', action='store_true',
        help='Disable DX cluster WebSocket connections (/ws/dxcluster)',
    )
    feat.add_argument(
        '--debug', action='store_true',
        help='Print per-connection error details to stderr (useful for diagnosing failures)',
    )

    return parser


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def validate_args(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    """Validate argument combinations and print helpful errors."""
    if args.users < 1:
        parser.error("--users must be at least 1")

    if args.threads < 1:
        parser.error("--threads must be at least 1")

    if args.threads > args.users:
        # More threads than users is wasteful but not an error; clamp silently
        args.threads = args.users

    if args.duration <= 0:
        parser.error("--duration must be positive")

    if args.ramp_up < 0:
        parser.error("--ramp-up must be >= 0")

    if args.report_interval <= 0:
        parser.error("--report-interval must be positive")

    if args.spectrum_zoom <= 0:
        parser.error("--spectrum-zoom must be positive")

    if args.no_audio and args.no_spectrum and args.no_dxcluster:
        parser.error(
            "All WebSocket types are disabled (--no-audio --no-spectrum --no-dxcluster). "
            "Enable at least one."
        )

    # Validate URL scheme
    url = args.url.lower()
    if not (url.startswith('http://') or url.startswith('https://')
            or url.startswith('ws://') or url.startswith('wss://')):
        parser.error(
            f"--url must start with http://, https://, ws://, or wss://, got: {args.url!r}"
        )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    validate_args(args, parser)

    # Resolve bandwidth from --bandwidth flag or leave as None (config will
    # apply mode defaults in __post_init__)
    bandwidth_low: Optional[int] = None
    bandwidth_high: Optional[int] = None
    if args.bandwidth:
        bandwidth_low, bandwidth_high = args.bandwidth

    # Build config
    config = BenchmarkConfig(
        url=args.url,
        ssl=args.ssl,
        password=args.password,
        users=args.users,
        threads=args.threads,
        duration=args.duration,
        ramp_up=args.ramp_up,
        report_interval=args.report_interval,
        reconnect=args.reconnect,
        frequency=args.frequency,
        mode=args.mode,
        bandwidth_low=bandwidth_low,
        bandwidth_high=bandwidth_high,
        spectrum_zoom_khz=args.spectrum_zoom,
        spectrum_default=args.spectrum_default,
        enable_audio=not args.no_audio,
        enable_spectrum=not args.no_spectrum,
        enable_dxcluster=not args.no_dxcluster,
        debug=args.debug,
    )

    # Import here so import errors are reported cleanly
    from runner import BenchmarkRunner
    runner = BenchmarkRunner(config)
    runner.run()


if __name__ == '__main__':
    main()
