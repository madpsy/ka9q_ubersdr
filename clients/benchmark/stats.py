"""
stats.py - Per-user statistics tracking and live console reporter.

UserStats is written by WebSocket coroutines (in worker threads) and read
by StatsReporter (in the main thread).  Simple integer fields are safe to
read/write without a lock under CPython's GIL; the lock is only used when
swapping out the snapshot list.
"""

from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass, field
from typing import List, Optional


# ---------------------------------------------------------------------------
# UserStats
# ---------------------------------------------------------------------------

@dataclass
class UserStats:
    """Mutable statistics for a single virtual user.

    Written by asyncio coroutines inside a worker thread; read by the
    StatsReporter in the main thread.  Integer increments are GIL-safe in
    CPython, so no per-field lock is needed for counters.
    """

    user_id: int
    session_id: str
    start_time: float = field(default_factory=time.monotonic)

    # --- /connection ---
    connection_checked: bool = False
    connection_allowed: bool = False
    connection_rejected: bool = False
    rejection_reason: str = ""

    # --- Audio WebSocket (/ws) ---
    audio_connected: bool = False
    audio_bytes_rx: int = 0
    audio_messages: int = 0
    audio_errors: int = 0
    audio_last_message_time: float = 0.0
    audio_last_error: str = ""

    # --- Spectrum WebSocket (/ws/user-spectrum) ---
    spectrum_connected: bool = False
    spectrum_bytes_rx: int = 0
    spectrum_messages: int = 0
    spectrum_errors: int = 0
    spectrum_last_error: str = ""

    # --- DX Cluster WebSocket (/ws/dxcluster) ---
    dx_connected: bool = False
    dx_messages: int = 0
    dx_errors: int = 0
    dx_last_error: str = ""

    @property
    def any_ws_connected(self) -> bool:
        """True if at least one WebSocket is currently connected."""
        return self.audio_connected or self.spectrum_connected or self.dx_connected

    @property
    def ever_ws_connected(self) -> bool:
        """True if this user has ever had a successful WS connection
        (i.e. received at least one message on any socket)."""
        return (
            self.audio_messages > 0
            or self.spectrum_messages > 0
            or self.dx_messages > 0
        )

    def snapshot(self) -> "UserStats":
        """Return a shallow copy for thread-safe reporting."""
        import copy
        return copy.copy(self)


# ---------------------------------------------------------------------------
# Aggregated snapshot used by the reporter
# ---------------------------------------------------------------------------

@dataclass
class AggregateStats:
    """Rolled-up numbers across all users at a point in time."""

    elapsed: float = 0.0
    total_users: int = 0

    # Connection
    users_allowed: int = 0
    users_rejected: int = 0

    # Audio
    audio_connected: int = 0
    audio_bytes_rx: int = 0
    audio_messages: int = 0
    audio_errors: int = 0

    # Spectrum
    spectrum_connected: int = 0
    spectrum_bytes_rx: int = 0
    spectrum_messages: int = 0
    spectrum_errors: int = 0

    # DX Cluster
    dx_connected: int = 0
    dx_messages: int = 0
    dx_errors: int = 0


def aggregate(snapshots: List[UserStats], elapsed: float) -> AggregateStats:
    """Aggregate a list of UserStats snapshots into a single AggregateStats."""
    agg = AggregateStats(elapsed=elapsed, total_users=len(snapshots))
    for s in snapshots:
        if s.any_ws_connected:
            agg.users_allowed += 1
        if s.connection_rejected:
            agg.users_rejected += 1

        if s.audio_connected:
            agg.audio_connected += 1
        agg.audio_bytes_rx += s.audio_bytes_rx
        agg.audio_messages += s.audio_messages
        agg.audio_errors += s.audio_errors

        if s.spectrum_connected:
            agg.spectrum_connected += 1
        agg.spectrum_bytes_rx += s.spectrum_bytes_rx
        agg.spectrum_messages += s.spectrum_messages
        agg.spectrum_errors += s.spectrum_errors

        if s.dx_connected:
            agg.dx_connected += 1
        agg.dx_messages += s.dx_messages
        agg.dx_errors += s.dx_errors

    return agg


# ---------------------------------------------------------------------------
# StatsReporter
# ---------------------------------------------------------------------------

class StatsReporter:
    """Periodically prints a live summary table to stdout.

    The reporter runs in its own daemon thread.  Worker threads push
    snapshots of their UserStats lists into *stats_queue* every second;
    the reporter drains the queue and prints a consolidated table every
    *report_interval* seconds.
    """

    def __init__(
        self,
        stats_queue: "queue.Queue[List[UserStats]]",
        report_interval: float,
        total_users: int,
        enable_audio: bool = True,
        enable_spectrum: bool = True,
        enable_dxcluster: bool = True,
    ) -> None:
        self._queue = stats_queue
        self._interval = report_interval
        self._total_users = total_users
        self._enable_audio = enable_audio
        self._enable_spectrum = enable_spectrum
        self._enable_dxcluster = enable_dxcluster

        self._start_time = time.monotonic()
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        # Keep the last two aggregates to compute per-second rates
        self._prev_agg: Optional[AggregateStats] = None
        self._prev_agg_time: float = 0.0

        # Latest merged snapshot list (updated from queue)
        self._latest_snapshots: List[UserStats] = []
        self._snapshots_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the background reporter thread."""
        self._start_time = time.monotonic()
        self._thread = threading.Thread(
            target=self._run, name="StatsReporter", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        """Signal the reporter to stop and wait for it to finish."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5.0)

    def print_final_summary(self) -> None:
        """Print a final summary after the benchmark ends."""
        elapsed = time.monotonic() - self._start_time
        with self._snapshots_lock:
            snapshots = list(self._latest_snapshots)
        agg = aggregate(snapshots, elapsed)
        print()
        print("=" * 60)
        print("  FINAL BENCHMARK SUMMARY")
        print("=" * 60)
        self._print_table(agg, prev=self._prev_agg, interval=elapsed)
        print("=" * 60)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _run(self) -> None:
        """Reporter thread main loop."""
        next_report = time.monotonic() + self._interval

        while not self._stop_event.is_set():
            # Drain the queue, merging all incoming snapshots
            self._drain_queue()

            now = time.monotonic()
            if now >= next_report:
                elapsed = now - self._start_time
                with self._snapshots_lock:
                    snapshots = list(self._latest_snapshots)
                agg = aggregate(snapshots, elapsed)
                self._print_table(agg, prev=self._prev_agg, interval=self._interval)
                self._prev_agg = agg
                self._prev_agg_time = now
                next_report = now + self._interval

            time.sleep(0.1)

    def _drain_queue(self) -> None:
        """Pull all pending snapshot batches from the queue and merge them."""
        # Each item in the queue is a list of UserStats from one thread.
        # We keep the latest snapshot per user_id.
        incoming: dict[int, UserStats] = {}
        try:
            while True:
                batch: List[UserStats] = self._queue.get_nowait()
                for s in batch:
                    incoming[s.user_id] = s
        except queue.Empty:
            pass

        if not incoming:
            return

        with self._snapshots_lock:
            # Build a dict from existing snapshots
            merged: dict[int, UserStats] = {
                s.user_id: s for s in self._latest_snapshots
            }
            merged.update(incoming)
            self._latest_snapshots = list(merged.values())

    # ------------------------------------------------------------------
    # Formatting helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _fmt_bytes(n: int) -> str:
        """Format a byte count as a human-readable string."""
        if n >= 1_073_741_824:
            return f"{n / 1_073_741_824:.1f} GB"
        if n >= 1_048_576:
            return f"{n / 1_048_576:.1f} MB"
        if n >= 1_024:
            return f"{n / 1_024:.1f} KB"
        return f"{n} B"

    @staticmethod
    def _fmt_rate(delta_bytes: int, interval: float) -> str:
        """Format a bytes-per-second rate."""
        if interval <= 0:
            return "—"
        bps = delta_bytes / interval
        if bps >= 1_048_576:
            return f"{bps / 1_048_576:.1f} MB/s"
        if bps >= 1_024:
            return f"{bps / 1_024:.1f} KB/s"
        return f"{bps:.0f} B/s"

    @staticmethod
    def _fmt_msg_rate(delta_msgs: int, interval: float) -> str:
        """Format a messages-per-second rate."""
        if interval <= 0:
            return "—"
        rate = delta_msgs / interval
        if rate >= 1000:
            return f"{rate / 1000:.1f}k/s"
        return f"{rate:.0f}/s"

    @staticmethod
    def _fmt_elapsed(seconds: float) -> str:
        """Format elapsed seconds as Xm Ys."""
        m = int(seconds) // 60
        s = int(seconds) % 60
        if m:
            return f"{m}m {s:02d}s"
        return f"{s}s"

    def _print_table(
        self,
        agg: AggregateStats,
        prev: Optional[AggregateStats],
        interval: float,
    ) -> None:
        """Print the live report table."""
        elapsed_str = self._fmt_elapsed(agg.elapsed)

        # Compute deltas vs previous aggregate
        if prev is not None:
            d_audio_bytes = agg.audio_bytes_rx - prev.audio_bytes_rx
            d_audio_msgs = agg.audio_messages - prev.audio_messages
            d_spec_bytes = agg.spectrum_bytes_rx - prev.spectrum_bytes_rx
            d_spec_msgs = agg.spectrum_messages - prev.spectrum_messages
            d_dx_msgs = agg.dx_messages - prev.dx_messages
            d_total_bytes = (
                (agg.audio_bytes_rx + agg.spectrum_bytes_rx)
                - (prev.audio_bytes_rx + prev.spectrum_bytes_rx)
            )
        else:
            d_audio_bytes = agg.audio_bytes_rx
            d_audio_msgs = agg.audio_messages
            d_spec_bytes = agg.spectrum_bytes_rx
            d_spec_msgs = agg.spectrum_messages
            d_dx_msgs = agg.dx_messages
            d_total_bytes = agg.audio_bytes_rx + agg.spectrum_bytes_rx

        total_rx = agg.audio_bytes_rx + agg.spectrum_bytes_rx
        total_rate = self._fmt_rate(d_total_bytes, interval)

        # "connected" in the header = users with at least one active WS right now
        ws_connected = max(
            agg.audio_connected if self._enable_audio else 0,
            agg.spectrum_connected if self._enable_spectrum else 0,
            agg.dx_connected if self._enable_dxcluster else 0,
        )
        print()
        print(f"{'─' * 62}")
        print(
            f"  Benchmark  T+{elapsed_str:<8}  "
            f"Users: {ws_connected}/{self._total_users} connected  "
            f"Rejected: {agg.users_rejected}"
        )
        print(f"{'─' * 62}")

        # Header
        print(
            f"  {'WebSocket':<16} {'Connected':>10} {'Msgs/s':>10} "
            f"{'Bytes/s':>12} {'Total RX':>12} {'Errors':>7}"
        )
        print(f"  {'─' * 16} {'─' * 10} {'─' * 10} {'─' * 12} {'─' * 12} {'─' * 7}")

        if self._enable_audio:
            print(
                f"  {'Audio':<16} "
                f"{agg.audio_connected:>4}/{self._total_users:<5} "
                f"{self._fmt_msg_rate(d_audio_msgs, interval):>10} "
                f"{self._fmt_rate(d_audio_bytes, interval):>12} "
                f"{self._fmt_bytes(agg.audio_bytes_rx):>12} "
                f"{agg.audio_errors:>7}"
            )

        if self._enable_spectrum:
            print(
                f"  {'Spectrum':<16} "
                f"{agg.spectrum_connected:>4}/{self._total_users:<5} "
                f"{self._fmt_msg_rate(d_spec_msgs, interval):>10} "
                f"{self._fmt_rate(d_spec_bytes, interval):>12} "
                f"{self._fmt_bytes(agg.spectrum_bytes_rx):>12} "
                f"{agg.spectrum_errors:>7}"
            )

        if self._enable_dxcluster:
            print(
                f"  {'DX Cluster':<16} "
                f"{agg.dx_connected:>4}/{self._total_users:<5} "
                f"{self._fmt_msg_rate(d_dx_msgs, interval):>10} "
                f"{'—':>12} "
                f"{'—':>12} "
                f"{agg.dx_errors:>7}"
            )

        print(f"{'─' * 62}")
        print(
            f"  Total RX: {self._fmt_bytes(total_rx):<14}  "
            f"Rate: {total_rate}"
        )
