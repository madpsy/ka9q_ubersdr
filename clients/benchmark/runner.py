"""
runner.py - BenchmarkRunner: thread pool, ramp-up, lifecycle management.

Architecture
------------
Users are split into batches, one batch per thread.  Each thread creates its
own asyncio event loop and runs all users in that batch concurrently via
asyncio.gather().  This gives:

  - True OS-level parallelism for I/O (each thread has its own selector)
  - asyncio's efficient I/O multiplexing within each thread
  - Isolation: a crash in one thread doesn't kill other threads

Thread communication
--------------------
- stop_event (threading.Event): set by the main thread after *duration*
  seconds; polled by every WebSocket coroutine via _stop_watcher().
- stats_queue (queue.Queue): each thread pushes a snapshot of its users'
  stats every *_STATS_PUSH_INTERVAL* seconds; the StatsReporter drains it.

Example with --users 100 --threads 10:
  10 threads × 10 users × 3 WebSockets = 300 concurrent connections
"""

from __future__ import annotations

import asyncio
import os
import queue
import signal
import sys
import threading
import time
from typing import List

from config import BenchmarkConfig
from stats import StatsReporter, UserStats
from user import make_user
import ws_utils


# How often each worker thread pushes stats snapshots to the queue (seconds)
_STATS_PUSH_INTERVAL = 1.0


class BenchmarkRunner:
    """Orchestrates the full benchmark run."""

    # How often (seconds) to check the system load average for the abort threshold
    _LOAD_CHECK_INTERVAL = 5.0

    def __init__(self, config: BenchmarkConfig) -> None:
        self._cfg = config
        self._stop_event = threading.Event()
        self._stats_queue: queue.Queue[List[UserStats]] = queue.Queue()

        # All UserStats objects, keyed by user_id (populated before threads start)
        self._all_stats: dict[int, UserStats] = {}
        self._stats_lock = threading.Lock()

        # Set to a non-empty string if the run was aborted early (e.g. high load)
        self._abort_reason: str = ""

        # Reporter
        self._reporter = StatsReporter(
            stats_queue=self._stats_queue,
            report_interval=config.report_interval,
            total_users=config.users,
            enable_audio=config.enable_audio,
            enable_spectrum=config.enable_spectrum,
            enable_dxcluster=config.enable_dxcluster,
            http_url=config.http_url,
            admin_password=config.admin_password,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(self) -> None:
        """Run the benchmark synchronously; blocks until duration expires."""
        cfg = self._cfg
        batches = cfg.user_batches()

        from config import RANDOM_FREQ_MIN_HZ, RANDOM_FREQ_MAX_HZ, RANDOM_ROTATE_INTERVAL_MIN, RANDOM_ROTATE_INTERVAL_MAX

        print(f"\nUberSDR Benchmark")
        print(f"{'─' * 50}")
        print(f"  URL:             {cfg.url}")
        print(f"  Users:           {cfg.users}")
        print(f"  Threads:         {cfg.actual_threads}")
        print(f"  Users/thread:    {cfg.users_per_thread}")
        print(f"  Duration:        {cfg.duration:.0f}s")
        print(f"  Ramp-up:         {cfg.ramp_up:.1f}s")
        if cfg.random_frequency:
            print(f"  Frequency:       random {RANDOM_FREQ_MIN_HZ / 1e3:.0f} kHz – "
                  f"{RANDOM_FREQ_MAX_HZ / 1e6:.0f} MHz "
                  f"(rotates every {RANDOM_ROTATE_INTERVAL_MIN:.0f}–{RANDOM_ROTATE_INTERVAL_MAX:.0f}s)")
            print(f"  Mode:            auto (LSB <10 MHz, USB ≥10 MHz)")
            print(f"  Spectrum zoom:   random (rotates with frequency)")
        else:
            print(f"  Frequency:       {cfg.frequency / 1e6:.6f} MHz")
            print(f"  Mode:            {cfg.mode.upper()}")
            if not cfg.is_iq_mode and cfg.bandwidth_low is not None:
                print(f"  Bandwidth:       {cfg.bandwidth_low} to {cfg.bandwidth_high} Hz")
            print(f"  Spectrum zoom:   {cfg.spectrum_zoom_khz:.0f} kHz")
        print(f"  Audio WS:        {'yes' if cfg.enable_audio else 'no'}")
        print(f"  Spectrum WS:     {'yes' if cfg.enable_spectrum else 'no'}")
        print(f"  DX Cluster WS:   {'yes' if cfg.enable_dxcluster else 'no'}")
        print(f"{'─' * 50}")
        print(f"  Starting {cfg.users} users across {len(batches)} thread(s)...")
        print()

        # Install Ctrl-C handler so we can stop cleanly
        original_sigint = signal.getsignal(signal.SIGINT)
        signal.signal(signal.SIGINT, self._handle_sigint)

        # Enable debug logging if requested
        ws_utils.set_debug(cfg.debug)

        # Start the stats reporter
        self._reporter.start()

        # Start one thread per batch
        threads: List[threading.Thread] = []
        for batch in batches:
            t = threading.Thread(
                target=self._run_batch,
                args=(batch,),
                daemon=True,
                name=f"bench-batch-{batch[0]}",
            )
            t.start()
            threads.append(t)

        # Wait for the configured duration (or until Ctrl-C / high-load abort)
        start = time.monotonic()
        last_load_check = time.monotonic()
        try:
            while not self._stop_event.is_set():
                elapsed = time.monotonic() - start
                if elapsed >= cfg.duration:
                    break

                # Periodically check system load average
                now = time.monotonic()
                if now - last_load_check >= self._LOAD_CHECK_INTERVAL:
                    last_load_check = now
                    self._check_load_abort()

                time.sleep(0.1)
        finally:
            # Signal all workers to stop (idempotent)
            self._stop_event.set()

            # Tell the reporter to suppress further periodic updates — the
            # partial teardown state (connections closing) is misleading.
            self._reporter.mark_shutting_down()

            if self._abort_reason:
                print(f"\n  ⚠  Aborting benchmark: {self._abort_reason}")
            print(f"\n  Stopping all users (waiting up to 10s)...")

            # Wait for all threads to finish
            for t in threads:
                t.join(timeout=10.0)

            # Stop reporter and print final summary
            self._reporter.stop()
            self._reporter.print_final_summary(
                abort_reason=self._abort_reason or None
            )

            # Restore original SIGINT handler
            signal.signal(signal.SIGINT, original_sigint)

    # ------------------------------------------------------------------
    # Thread worker
    # ------------------------------------------------------------------

    def _run_batch(self, user_ids: List[int]) -> None:
        """Run a batch of users in this thread's own asyncio event loop."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._run_batch_async(user_ids))
        except Exception as exc:
            # Don't let a thread crash silently
            print(f"[Thread {threading.current_thread().name}] Error: {exc}", file=sys.stderr)
        finally:
            try:
                # Cancel any remaining tasks
                pending = asyncio.all_tasks(loop)
                if pending:
                    for task in pending:
                        task.cancel()
                    loop.run_until_complete(
                        asyncio.gather(*pending, return_exceptions=True)
                    )
            finally:
                loop.close()

    async def _run_batch_async(self, user_ids: List[int]) -> None:
        """Async entry point for a batch: create users, gather, push stats."""
        cfg = self._cfg

        # Create all users and their stats objects
        users_and_stats = [make_user(uid, cfg, self._stop_event) for uid in user_ids]

        # Register stats with the shared dict so the reporter can see them
        with self._stats_lock:
            for _, stats in users_and_stats:
                self._all_stats[stats.user_id] = stats

        # Start the stats-push background task for this thread
        local_stats = [s for _, s in users_and_stats]
        push_task = asyncio.create_task(
            self._push_stats_loop(local_stats),
            name="stats-push",
        )

        # Run all users concurrently
        user_tasks = [
            asyncio.create_task(user.run(), name=f"user-{uid}")
            for (user, _), uid in zip(users_and_stats, user_ids)
        ]

        try:
            await asyncio.gather(*user_tasks, return_exceptions=True)
        finally:
            push_task.cancel()
            try:
                await push_task
            except asyncio.CancelledError:
                pass
            # Final stats push
            self._push_stats_now(local_stats)

    async def _push_stats_loop(self, stats_list: List[UserStats]) -> None:
        """Periodically push snapshots of this thread's stats to the queue."""
        while not self._stop_event.is_set():
            await asyncio.sleep(_STATS_PUSH_INTERVAL)
            self._push_stats_now(stats_list)

    def _push_stats_now(self, stats_list: List[UserStats]) -> None:
        """Take a snapshot of each UserStats and push to the reporter queue."""
        snapshots = [s.snapshot() for s in stats_list]
        try:
            self._stats_queue.put_nowait(snapshots)
        except queue.Full:
            pass  # Reporter is behind; skip this push

    # ------------------------------------------------------------------
    # Signal handling
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Load-average abort check
    # ------------------------------------------------------------------

    def _check_load_abort(self) -> None:
        """Abort the benchmark if the 1-minute load average exceeds 1.5× the CPU count.

        Uses os.getloadavg() which is available on Linux/macOS but not Windows.
        On Windows (or any platform where getloadavg is unavailable) this is a
        no-op so the benchmark continues normally.

        Does nothing when config.load_abort is False.
        """
        if not self._cfg.load_abort:
            return

        try:
            l1, _l5, _l15 = os.getloadavg()
        except (AttributeError, OSError):
            # Not available on this platform — skip the check
            return

        n_cpus = os.cpu_count() or 1
        threshold = n_cpus * 1.5
        if l1 > threshold:
            self._abort_reason = (
                f"1-minute load average {l1:.2f} exceeds 1.5× CPU count ({n_cpus} × 1.5 = {threshold:.1f})"
            )
            self._stop_event.set()

    def _handle_sigint(self, signum, frame) -> None:
        """Handle Ctrl-C: set stop_event and let the run() loop exit cleanly.

        Uses os.write() (async-signal-safe) instead of print() to avoid
        reentrant I/O crashes.  Restores SIG_DFL immediately so a second
        Ctrl-C performs a hard kill rather than re-entering this handler.
        """
        # Restore default handler immediately — second Ctrl-C will hard-kill
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        os.write(sys.stderr.fileno(), b"\n\n  Interrupted \xe2\x80\x94 stopping benchmark...\n")
        self._stop_event.set()
