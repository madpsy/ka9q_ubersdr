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

Channel capacity
----------------
  radiod has a hard limit of 2000 channels.  Each simulated user consumes
  2 channels (one audio + one spectrum).  On startup the tool attempts to
  fetch the current channel count from GET /admin/radiod-channels using the
  X-Admin-Password header (requires --admin-password).  If successful it
  shows how many channels are already in use and automatically clamps the
  requested user count so the total never exceeds 2000 channels.

  If the admin password is not provided, or the request fails, a warning is
  printed and the hard cap of MAX_USERS is used instead.

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

# Fetch live channel count and auto-clamp user limit
python benchmark.py --url http://localhost:8080 \\
    --users 100 --admin-password mypassword
"""

from __future__ import annotations

import argparse
import json
import os
import re as _re
import subprocess as _subprocess
import sys
import urllib.error
import urllib.request
try:
    import termios as _termios
except ImportError:
    _termios = None  # type: ignore[assignment]
from dataclasses import replace as dataclass_replace
from typing import Optional, Tuple

from config import BenchmarkConfig, VALID_MODES

MAX_USERS = 1000          # Hard cap when channel count cannot be determined
RADIOD_CHANNEL_LIMIT = 2000  # radiod's absolute maximum channel count
CHANNELS_PER_USER = 2     # Each user needs 1 audio + 1 spectrum channel


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
# Channel count fetcher
# ---------------------------------------------------------------------------

def _fetch_radiod_channels(http_url: str, admin_password: str) -> Optional[dict]:
    """Fetch the full /admin/radiod-channels JSON response.

    Returns the parsed dict on success, or None on any failure.
    """
    url = f"{http_url.rstrip('/')}/admin/radiod-channels"
    req = urllib.request.Request(url)
    req.add_header("X-Admin-Password", admin_password)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        print(f"  ⚠  Could not fetch radiod channels: HTTP {exc.code} from {url}", file=sys.stderr)
    except urllib.error.URLError as exc:
        print(f"  ⚠  Could not fetch radiod channels: {exc.reason}", file=sys.stderr)
    except Exception as exc:
        print(f"  ⚠  Could not fetch radiod channels: {exc}", file=sys.stderr)
    return None


def fetch_existing_channel_count(http_url: str, admin_password: str) -> Optional[int]:
    """Fetch the current radiod channel count from GET /admin/radiod-channels.

    Returns the total_channels integer on success, or None on any failure.
    """
    data = _fetch_radiod_channels(http_url, admin_password)
    if data is None:
        return None
    return int(data.get("total_channels", 0))


def fetch_radiod_cpu_stats(http_url: str, admin_password: str) -> Optional[dict]:
    """Fetch the cpu_stats block from GET /admin/radiod-channels.

    Returns a dict with keys: available, num_logical_cpus, total_pct,
    proc_rx888_pct, fft_pct, channels_pct, other_pct — or None on failure.
    """
    data = _fetch_radiod_channels(http_url, admin_password)
    if data is None:
        return None
    cpu = data.get("cpu_stats")
    if not isinstance(cpu, dict) or not cpu.get("available"):
        return None
    return cpu


def compute_max_users(existing_channels: int) -> int:
    """Return the maximum number of users that can be added without exceeding
    the radiod channel limit of RADIOD_CHANNEL_LIMIT.

    Each user consumes CHANNELS_PER_USER channels.
    """
    available = max(0, RADIOD_CHANNEL_LIMIT - existing_channels)
    return available // CHANNELS_PER_USER


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
        '--admin-password', metavar='PW', default=None,
        help=(
            'Admin password used to query GET /admin/radiod-channels via the '
            'X-Admin-Password header.  When provided, the tool fetches the '
            'current channel count at startup and automatically clamps --users '
            'so the total never exceeds the radiod limit of '
            f'{RADIOD_CHANNEL_LIMIT} channels '
            f'({CHANNELS_PER_USER} channels per user).'
        ),
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
        '--no-load-abort', action='store_true',
        help=(
            'Disable the automatic abort when the 1-minute system load average '
            'exceeds the number of logical CPUs.  By default the benchmark stops '
            'early and shows a warning if the machine appears overloaded.'
        ),
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
# Admin password auto-discovery (mirrors get-password.sh)
# ---------------------------------------------------------------------------

# Path to the UberSDR config inside the Docker volume — same as get-password.sh
_CONFIG_PATH = "/var/lib/docker/volumes/ubersdr_ubersdr-config/_data/config.yaml"


def _parse_admin_password(lines: list) -> Optional[str]:
    """Extract the admin password value from a list of config.yaml lines.

    Looks for the pattern:
        admin:
          ...
          password: "somevalue"

    Returns the password string, or None if not found or still the default.
    """
    in_admin = False
    for line in lines:
        stripped = line.rstrip('\n')
        if stripped.startswith('admin:'):
            in_admin = True
            continue
        if in_admin:
            # Stop at the next top-level key
            if stripped and not stripped[0].isspace():
                break
            m = _re.match(r'\s+password:\s+"([^"]+)"', stripped)
            if m:
                pw = m.group(1)
                if pw and pw != 'mypassword':
                    return pw
                return None  # default / empty — treat as not found
    return None


def read_admin_password_from_config(path: str = _CONFIG_PATH) -> Optional[str]:
    """Try to extract the admin password from the UberSDR config.yaml.

    Replicates the logic of get-password.sh.  The Docker volume file is
    owned by root, so a direct open() may fail for non-root users.
    Resolution order:
      1. Direct open() — works when running as root or if permissions allow.
      2. ``sudo cat <path>`` — mirrors the ``sudo grep`` used in get-password.sh;
         requires the user to have passwordless sudo for cat, or for sudo to
         be configured to allow it (standard UberSDR install grants this).

    Returns the password string on success, or None on any failure.
    """
    # 1. Try direct read first (fast path — works as root)
    try:
        with open(path, 'r') as fh:
            lines = fh.readlines()
        return _parse_admin_password(lines)
    except OSError:
        pass

    # 2. Fall back to sudo cat (mirrors get-password.sh's use of sudo grep)
    try:
        result = _subprocess.run(
            ['sudo', 'cat', path],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            return _parse_admin_password(result.stdout.splitlines(keepends=True))
    except (OSError, _subprocess.TimeoutExpired):
        pass

    return None


# ---------------------------------------------------------------------------
# Channel-capacity check (run once at startup)
# ---------------------------------------------------------------------------

def check_channel_capacity(http_url: str, admin_password: Optional[str],
                            requested_users: int) -> Tuple[int, int]:
    """Query the server for the current channel count and compute the effective
    user limit.

    *admin_password* should already be resolved by the caller (via
    ``read_admin_password_from_config()`` or the ``--admin-password`` flag).

    Returns (effective_users, dynamic_max) where:
      - effective_users  is the (possibly clamped) number of users to run
      - dynamic_max      is the computed cap (MAX_USERS if lookup failed)

    Prints informational / warning messages to stdout/stderr.
    """
    if not admin_password:
        print(
            f"  ⚠  No admin password available; "
            f"skipping live channel count check. "
            f"Using hard cap of {MAX_USERS} users.",
            file=sys.stderr,
        )
        dynamic_max = MAX_USERS
    else:
        print("  Checking current radiod channel usage…", end=' ', flush=True)
        existing = fetch_existing_channel_count(http_url, admin_password)
        if existing is None:
            print("failed.", file=sys.stderr)
            print(
                f"  ⚠  Could not determine channel count; using hard cap of {MAX_USERS} users.",
                file=sys.stderr,
            )
            dynamic_max = MAX_USERS
        else:
            dynamic_max = compute_max_users(existing)
            available_channels = RADIOD_CHANNEL_LIMIT - existing
            print(
                f"\n"
                f"  📡 radiod channels in use: {existing} / {RADIOD_CHANNEL_LIMIT}\n"
                f"     Available channels: {available_channels}  "
                f"→  max testable users: {dynamic_max} "
                f"({CHANNELS_PER_USER} channels each)"
            )

    effective_users = requested_users
    if effective_users > dynamic_max:
        print(
            f"\n  ⚠  WARNING: requested {requested_users} users but only {dynamic_max} "
            f"can be tested without exceeding the {RADIOD_CHANNEL_LIMIT}-channel radiod limit.\n"
            f"     Clamping to {dynamic_max} users.",
            file=sys.stderr,
        )
        effective_users = dynamic_max

    if effective_users < 1:
        print(
            "  ⚠  WARNING: no capacity for any users (server is at or near channel limit).",
            file=sys.stderr,
        )
        effective_users = 0

    return effective_users, dynamic_max


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


def _prompt_bool(prompt: str, default: bool) -> Optional[bool]:
    """Prompt for a yes/no answer, returning None if the user wants to quit."""
    default_str = "Y/n" if default else "y/N"
    while True:
        try:
            raw = input(f"  {prompt} [{default_str}]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return None
        if raw == '':
            return default
        if raw in ('q', 'quit', 'exit'):
            return None
        if raw in ('y', 'yes'):
            return True
        if raw in ('n', 'no'):
            return False
        print(f"  ✗ Please enter y or n (or press Enter for default).")


def run_interactive(base_config: BenchmarkConfig, admin_password: Optional[str]) -> None:
    """Interactive loop: prompt for users/duration, run, repeat until quit.

    The channel count is re-fetched before every run so the cap always
    reflects the current server state (previous runs add/remove channels,
    real users connect/disconnect between runs).
    """
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

    try:
        while True:
            run_number += 1
            print(f"─── Run #{run_number} ───────────────────────────────────────────────")

            # Re-fetch channel count before every run so the cap is always fresh.
            # Pass current_config.users as the "requested" value purely so
            # check_channel_capacity can print a clamp warning if needed; we use
            # the returned dynamic_max (not effective_users) to drive the prompt.
            _, dynamic_max = check_channel_capacity(
                base_config.http_url,
                admin_password,
                current_config.users,
            )

            users = _prompt_int(
                "Number of users",
                default=min(current_config.users, dynamic_max),
                min_val=1,
                max_val=dynamic_max,
            )
            if users is None:
                print("\n  Exiting interactive mode. Goodbye!")
                break

            # Warn and clamp if somehow above dynamic_max (shouldn't happen with max_val set)
            if users > dynamic_max:
                print(
                    f"  ⚠  Clamping {users} → {dynamic_max} users "
                    f"(radiod channel limit).",
                    file=sys.stderr,
                )
                users = dynamic_max

            duration = _prompt_int("Duration (seconds)", default=int(current_config.duration), min_val=1)
            if duration is None:
                print("\n  Exiting interactive mode. Goodbye!")
                break

            # Prompt for load-abort (yes/no, default matches current_config)
            load_abort = _prompt_bool(
                "Abort if system load exceeds CPU count",
                default=current_config.load_abort,
            )
            if load_abort is None:
                print("\n  Exiting interactive mode. Goodbye!")
                break

            # Use the configured thread count, but scale up if users > threads*25
            threads = current_config.threads
            if threads < max(1, min(32, (users + 24) // 25)):
                threads = max(1, min(32, (users + 24) // 25))

            # Build a config for this run (override users/duration/threads/load_abort)
            run_config = dataclass_replace(
                current_config,
                users=users,
                duration=float(duration),
                threads=threads,
                load_abort=load_abort,
            )

            load_abort_str = "enabled" if load_abort else "disabled"
            print(f"\n  → {users} users for {duration}s on {threads} thread(s)  (load-abort: {load_abort_str})")
            print()

            try:
                runner = BenchmarkRunner(run_config)
                runner.run()
            except KeyboardInterrupt:
                # Ctrl-C during a run: stop the run but stay in the loop
                print("\n  Run interrupted.")

            # Use this run's user/duration/load_abort as defaults for the next run
            current_config = dataclass_replace(
                current_config,
                users=users,
                duration=float(duration),
                load_abort=load_abort,
            )

            # Drain any newlines/characters that were buffered in stdin during
            # the benchmark run (e.g. Enter presses while waiting).  Without
            # this the "Run another?" input() call consumes them immediately
            # and skips the prompt.
            if _termios is not None:
                try:
                    _termios.tcflush(sys.stdin, _termios.TCIFLUSH)
                except Exception:
                    pass  # Not a tty — ignore

            print()
            try:
                again = input("  Run another benchmark? [Y/n]: ").strip().lower()
            except EOFError:
                print("\n  Exiting interactive mode. Goodbye!")
                break
            if again in ('n', 'no', 'q', 'quit'):
                print("  Goodbye!")
                break

    except KeyboardInterrupt:
        # Ctrl-C at any prompt (users, duration, "run again?") — exit cleanly.
        # Use os.write() (async-signal-safe) instead of print() to avoid a
        # second KeyboardInterrupt being raised inside the handler itself,
        # which happens in PyInstaller binaries when the signal arrives during
        # a buffered write to stdout.
        try:
            sys.stdout.flush()
        except Exception:
            pass
        os.write(sys.stdout.fileno(), b"\n\n  Exiting interactive mode. Goodbye!\n")


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
            load_abort=not args.no_load_abort,
            debug=args.debug,
            admin_password=None,  # filled in after password resolution below
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
            load_abort=not args.no_load_abort,
            debug=args.debug,
            admin_password=None,  # filled in after password resolution below
        )

    # ── Resolve admin password (flag → config file → None) ───────────────
    # check_channel_capacity does this internally too, but we resolve it once
    # here so we can store it in BenchmarkConfig for the StatsReporter to use.
    resolved_admin_pw: Optional[str] = args.admin_password
    if not resolved_admin_pw:
        resolved_admin_pw = read_admin_password_from_config()
        if resolved_admin_pw:
            print(f"  🔑 Admin password read from config file ({_CONFIG_PATH})")
    config = dataclass_replace(config, admin_password=resolved_admin_pw)

    # ── Channel capacity check ────────────────────────────────────────────
    # Derive the HTTP base URL from the config (already normalised in __post_init__)
    effective_users, dynamic_max = check_channel_capacity(
        config.http_url,
        resolved_admin_pw,
        config.users,
    )

    if not interactive:
        if effective_users == 0:
            print("  No capacity available — aborting.", file=sys.stderr)
            sys.exit(1)
        if effective_users != config.users:
            config = dataclass_replace(config, users=effective_users)
    else:
        # In interactive mode, clamp the default suggestion but let the prompt
        # enforce the cap via max_val.
        if effective_users != config.users:
            config = dataclass_replace(config, users=effective_users)

    if interactive:
        run_interactive(config, resolved_admin_pw)
    else:
        # Import here so import errors are reported cleanly
        from runner import BenchmarkRunner
        runner = BenchmarkRunner(config)
        runner.run()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        # Top-level safety net: suppress traceback for Ctrl-C at any point
        # outside the interactive loop (e.g. during startup checks).
        try:
            sys.stdout.flush()
        except Exception:
            pass
        os.write(sys.stdout.fileno(), b"\n  Interrupted.\n")
        sys.exit(0)
