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

Default behaviour
-----------------
  Interactive mode is used whenever --users is NOT specified.
  The tool prompts for number of users and duration, runs the benchmark,
  then prompts again.  Persistent settings (--url, --threads, --audio-format,
  etc.) can be given on the command line and are used as defaults in the loop.

  Pass --users to run once non-interactively and exit.

Usage examples
--------------
# Interactive mode — prompts for users/duration each run
python benchmark.py
python benchmark.py --url http://radio.example.com:8080
python benchmark.py --url http://radio.example.com:8080 --threads 8

# Non-interactive: 10 users for 60 seconds (exits after one run)
python benchmark.py --users 10 --duration 60

# 50 users with random frequencies against a remote server
python benchmark.py --url http://radio.example.com:8080 --users 50

# 50 users, fixed 14.074 MHz USB, 2 minute run
python benchmark.py --url http://localhost:8080 \\
    --users 50 --threads 10 --duration 120 \\
    -f 14074000 -m usb

# 100 users, 7.1 MHz LSB with explicit bandwidth, 500 kHz spectrum zoom
python benchmark.py --url http://radio.example.com:8080 \\
    --users 100 --threads 10 --duration 300 \\
    -f 7100000 -m lsb -b -2700:-50 \\
    --spectrum-zoom 500 --password secret

# Audio only (no spectrum, no DX cluster)
python benchmark.py --url http://localhost:8080 \\
    --users 20 -f 14200000 -m usb \\
    --no-spectrum --no-dxcluster

# IQ mode (no bandwidth sent, as per original client)
python benchmark.py --url http://localhost:8080 \\
    --users 5 -f 14000000 -m iq96 --password bypass_password

# Use lossless pcm-zstd audio (higher server memory, tests zstd path)
python benchmark.py --url http://localhost:8080 \\
    --users 50 -f 14074000 -m usb --audio-format pcm-zstd
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import replace as dataclass_replace
from typing import Optional, Tuple

from config import BenchmarkConfig, VALID_MODES

MAX_USERS = 1000  # Hard cap — matches radiod's maximum channel limit


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
        description=(
            'UberSDR Load Benchmark — simulates N concurrent real users.\n\n'
            'By default connects to http://localhost:8080 and runs each user '
            'on a random frequency (100 kHz – 29 MHz), changing frequency and '
            'spectrum zoom every 5 seconds.  Mode is chosen automatically: '
            'LSB below 10 MHz, USB at 10 MHz and above.'
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    # --- Connection ---
    conn = parser.add_argument_group('Connection')
    conn.add_argument(
        '--url', default='http://localhost:8080', metavar='URL',
        help='Server base URL (default: http://localhost:8080). '
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
        help=f'Number of simulated concurrent users (default: 10, max: {MAX_USERS})',
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
        '--random-frequency', action='store_true',
        help=(
            'Each user picks a random frequency between 100 kHz and 29 MHz '
            'and changes it every 5 seconds.  Mode is selected automatically '
            '(LSB below 10 MHz, USB at 10 MHz and above) and spectrum zoom '
            'is also randomised on each change.  '
            'This is the default when neither -f nor -m is specified.'
        ),
    )
    radio.add_argument(
        '-f', '--frequency', type=int, default=None, metavar='HZ',
        help=(
            'Fixed tuned frequency in Hz (e.g. 14200000 = 14.2 MHz). '
            'When set, disables --random-frequency.'
        ),
    )
    radio.add_argument(
        '-m', '--mode', default=None, choices=list(VALID_MODES),
        help=(
            'Fixed demodulation mode. '
            'When set, disables --random-frequency. '
            'Default when -f is given: usb.'
        ),
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
            'Ignored in --random-frequency mode (zoom is randomised).'
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

    # --- Audio format ---
    audio = parser.add_argument_group('Audio format')
    audio.add_argument(
        '--audio-format', default='opus', choices=['opus', 'pcm-zstd'],
        metavar='FMT',
        help=(
            'Audio encoding format requested from the server: '
            '"opus" (default, low memory) or "pcm-zstd" (lossless, higher memory). '
            'IQ modes always use pcm-zstd regardless of this setting.'
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
    if args.users > MAX_USERS:
        parser.error(f"--users cannot exceed {MAX_USERS} (radiod channel limit)")

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

    # Resolve random-frequency mode:
    # - Explicit --random-frequency flag always enables it.
    # - If neither -f nor -m is given, default to random-frequency mode.
    # - If -f or -m is given, use fixed mode (apply defaults for missing values).
    if args.random_frequency:
        # Explicit flag: ignore -f / -m
        if args.frequency is not None or args.mode is not None:
            parser.error(
                "--random-frequency cannot be combined with -f/--frequency or -m/--mode"
            )
    elif args.frequency is None and args.mode is None:
        # Neither specified → default to random-frequency
        args.random_frequency = True
    else:
        # At least one of -f / -m given → fixed mode
        if args.frequency is None:
            args.frequency = 14_200_000
        if args.mode is None:
            args.mode = 'usb'


# ---------------------------------------------------------------------------
# Interactive mode
# ---------------------------------------------------------------------------

def _prompt_int(prompt: str, default: int, min_val: int = 1, max_val: Optional[int] = None) -> Optional[int]:
    """Prompt for an integer, returning None if the user wants to quit."""
    while True:
        try:
            raw = input(f"  {prompt} [{default}]: ").strip()
        except (EOFError, KeyboardInterrupt):
            return None
        if raw == '':
            return default
        if raw.lower() in ('q', 'quit', 'exit'):
            return None
        try:
            val = int(raw)
            if val < min_val:
                print(f"  ✗ Must be at least {min_val}. Try again.")
                continue
            if max_val is not None and val > max_val:
                print(f"  ✗ Cannot exceed {max_val}. Try again.")
                continue
            return val
        except ValueError:
            print(f"  ✗ Please enter a whole number (or press Enter for default).")


def run_interactive(base_config: BenchmarkConfig) -> None:
    """Interactive loop: prompt for users/duration, run, repeat until quit."""
    from runner import BenchmarkRunner

    print()
    print("╔══════════════════════════════════════════════════════════════╗")
    print("║          UberSDR Benchmark — Interactive Mode                ║")
    print("║  Press Enter to accept defaults.  Type 'q' or Ctrl-C to exit.║")
    print("╚══════════════════════════════════════════════════════════════╝")
    print(f"  Server:       {base_config.url}")
    print(f"  Audio format: {base_config.audio_format}")
    print(f"  Threads:      up to {base_config.threads} (capped at user count)")
    print()

    current_config = base_config
    run_number = 0

    while True:
        run_number += 1
        print(f"─── Run #{run_number} ───────────────────────────────────────────────")

        users = _prompt_int("Number of users", default=current_config.users, min_val=1, max_val=MAX_USERS)
        if users is None:
            print("\n  Exiting interactive mode. Goodbye!")
            break

        duration = _prompt_int("Duration (seconds)", default=int(current_config.duration), min_val=1)
        if duration is None:
            print("\n  Exiting interactive mode. Goodbye!")
            break

        # Use the configured thread count, but scale up if users > threads*25
        threads = current_config.threads
        if threads < max(1, min(32, (users + 24) // 25)):
            threads = max(1, min(32, (users + 24) // 25))

        # Build a config for this run (override users/duration/threads only)
        run_config = dataclass_replace(
            current_config,
            users=users,
            duration=float(duration),
            threads=threads,
        )

        print(f"\n  → {users} users for {duration}s on {threads} thread(s)")
        print()

        try:
            runner = BenchmarkRunner(run_config)
            runner.run()
        except KeyboardInterrupt:
            # Ctrl-C during a run: stop the run but stay in the loop
            print("\n  Run interrupted.")

        # Use this run's user/duration as defaults for the next run
        current_config = dataclass_replace(current_config, users=users, duration=float(duration))

        print()
        try:
            again = input("  Run another benchmark? [Y/n]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\n  Exiting interactive mode. Goodbye!")
            break
        if again in ('n', 'no', 'q', 'quit'):
            print("  Goodbye!")
            break


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    # Interactive mode when --users is not explicitly provided.
    # This lets the user specify persistent settings (--url, --threads,
    # --audio-format, etc.) while still getting the interactive prompt loop
    # for per-run values (users, duration).
    # Passing --users explicitly means "run once non-interactively".
    interactive = '--users' not in sys.argv and '-u' not in sys.argv

    if not interactive:
        validate_args(args, parser)

    # Resolve bandwidth from --bandwidth flag or leave as None (config will
    # apply mode defaults in __post_init__)
    bandwidth_low: Optional[int] = None
    bandwidth_high: Optional[int] = None
    if not interactive and args.bandwidth:
        bandwidth_low, bandwidth_high = args.bandwidth

    # Build base config.
    # In interactive mode this holds the persistent settings (url, format,
    # feature flags, etc.) and is used as the template for each run.
    # In non-interactive mode it is used directly for a single run.
    if interactive:
        # Resolve bandwidth for interactive base config too
        if args.bandwidth:
            bandwidth_low, bandwidth_high = args.bandwidth
        # Resolve random_frequency default for interactive base config
        random_freq = args.random_frequency
        if not random_freq and args.frequency is None and args.mode is None:
            random_freq = True
        config = BenchmarkConfig(
            url=args.url,
            ssl=args.ssl,
            password=args.password,
            users=args.users,          # used as default in the prompt
            threads=args.threads,
            duration=args.duration,    # used as default in the prompt
            ramp_up=args.ramp_up,
            report_interval=args.report_interval,
            reconnect=args.reconnect,
            frequency=args.frequency if args.frequency is not None else 14_200_000,
            mode=args.mode if args.mode is not None else 'usb',
            bandwidth_low=bandwidth_low,
            bandwidth_high=bandwidth_high,
            random_frequency=random_freq,
            spectrum_zoom_khz=args.spectrum_zoom,
            spectrum_default=args.spectrum_default,
            audio_format=args.audio_format,
            enable_audio=not args.no_audio,
            enable_spectrum=not args.no_spectrum,
            enable_dxcluster=not args.no_dxcluster,
            debug=args.debug,
        )
    else:
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
            frequency=args.frequency if args.frequency is not None else 14_200_000,
            mode=args.mode if args.mode is not None else 'usb',
            bandwidth_low=bandwidth_low,
            bandwidth_high=bandwidth_high,
            random_frequency=args.random_frequency,
            spectrum_zoom_khz=args.spectrum_zoom,
            spectrum_default=args.spectrum_default,
            audio_format=args.audio_format,
            enable_audio=not args.no_audio,
            enable_spectrum=not args.no_spectrum,
            enable_dxcluster=not args.no_dxcluster,
            debug=args.debug,
        )

    if interactive:
        run_interactive(config)
    else:
        # Import here so import errors are reported cleanly
        from runner import BenchmarkRunner
        runner = BenchmarkRunner(config)
        runner.run()


if __name__ == '__main__':
    main()
