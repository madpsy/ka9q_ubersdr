"""
user.py - VirtualUser: orchestrates one simulated user's full connection lifecycle.

Each VirtualUser:
  1. Waits for its ramp-up delay (to stagger connections).
  2. POSTs to /connection to check whether the server will accept it
     (mirrors radio_client.py check_connection_allowed()).
  3. Launches up to three asyncio tasks concurrently:
       - AudioWebSocket    (/ws)
       - SpectrumWebSocket (/ws/user-spectrum)
       - DXClusterWebSocket (/ws/dxcluster)
  4. Runs until the shared stop_event fires.
"""

from __future__ import annotations

import asyncio
import threading
import uuid
from typing import Optional

import aiohttp

from audio_ws import AudioWebSocket
from config import BenchmarkConfig
from dxcluster_ws import DXClusterWebSocket
from spectrum_ws import SpectrumWebSocket
from stats import UserStats
from ws_utils import SessionError, debug_log


class VirtualUser:
    """One simulated user with up to three concurrent WebSocket connections."""

    def __init__(
        self,
        user_id: int,
        config: BenchmarkConfig,
        stats: UserStats,
        stop_event: threading.Event,
    ) -> None:
        self._id = user_id
        self._cfg = config
        self._stats = stats
        self._stop = stop_event

    # ------------------------------------------------------------------
    # Public entry point (called as an asyncio coroutine)
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Full lifecycle for this virtual user.

        The outer loop handles the case where the server rejects a WebSocket
        with "Invalid session" — this means the session registered by
        POST /connection has expired (e.g. due to backoff delays).  We
        re-POST /connection to get a fresh session and restart all WS tasks.
        """
        # 1. Ramp-up delay — stagger connections across the ramp_up window
        delay = self._cfg.ramp_delay_for(self._id)
        if delay > 0:
            await self._interruptible_sleep(delay)

        if self._stop.is_set():
            return

        # 2. POST /connection — check whether the server will accept us
        allowed = await self._check_connection()
        if not allowed:
            return

        # 3. Run WebSocket tasks, re-doing /connection if the session expires.
        session_retry = 0
        _SESSION_RETRY_MAX = 10
        _SESSION_RETRY_BACKOFF_BASE = 2.0
        _SESSION_RETRY_BACKOFF_MAX = 30.0

        while not self._stop.is_set():
            if self._stop.is_set():
                return

            # Build fresh WS handler instances each iteration so they start
            # with a clean retry counter and the latest session_id.
            tasks = []

            if self._cfg.enable_audio:
                audio = AudioWebSocket(self._cfg, self._stats, self._stop)
                tasks.append(asyncio.create_task(audio.run(), name=f"audio-{self._id}"))

            if self._cfg.enable_spectrum:
                spectrum = SpectrumWebSocket(self._cfg, self._stats, self._stop)
                tasks.append(asyncio.create_task(spectrum.run(), name=f"spectrum-{self._id}"))

            if self._cfg.enable_dxcluster:
                dxcluster = DXClusterWebSocket(self._cfg, self._stats, self._stop)
                tasks.append(asyncio.create_task(dxcluster.run(), name=f"dxcluster-{self._id}"))

            if not tasks:
                return

            # Run all WS tasks concurrently; collect results/exceptions.
            results = await asyncio.gather(*tasks, return_exceptions=True)

            # Check whether any task raised SessionError.
            session_errors = [r for r in results if isinstance(r, SessionError)]
            if not session_errors:
                # Normal exit (stop_event fired or all tasks finished cleanly).
                break

            # At least one WS reported "Invalid session" — cancel any still-
            # running tasks (gather already awaited them all, but cancel any
            # that may still be pending due to gather semantics).
            for t in tasks:
                if not t.done():
                    t.cancel()

            if self._stop.is_set():
                break

            if session_retry >= _SESSION_RETRY_MAX:
                debug_log(self._id, 'user',
                          f"Giving up after {session_retry} session re-registrations")
                break

            # Back off briefly, then re-POST /connection for a fresh session.
            backoff = min(
                _SESSION_RETRY_BACKOFF_BASE ** session_retry,
                _SESSION_RETRY_BACKOFF_MAX,
            )
            debug_log(self._id, 'user',
                      f"Session expired — re-registering in {backoff:.1f}s "
                      f"(attempt {session_retry + 1}/{_SESSION_RETRY_MAX})")
            await self._interruptible_sleep(backoff)

            if self._stop.is_set():
                break

            # Rotate to a fresh session UUID, then re-POST /connection so the
            # server registers it before we open new WebSocket connections.
            self._stats.session_id = str(uuid.uuid4())
            allowed = await self._check_connection()
            if not allowed:
                break

            session_retry += 1

    # ------------------------------------------------------------------
    # /connection check (mirrors radio_client.py check_connection_allowed())
    # ------------------------------------------------------------------

    async def _check_connection(self) -> bool:
        """POST /connection and update stats.

        Returns True if the server allows the connection (or if the check
        fails with a network error, in which case we proceed anyway — same
        behaviour as the real client).
        """
        url = f"{self._cfg.http_url}/connection"
        body: dict = {'user_session_id': self._stats.session_id}
        if self._cfg.password:
            body['password'] = self._cfg.password

        self._stats.connection_checked = True

        try:
            ssl_ctx: Optional[bool] = False if not self._cfg.ssl else None
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url,
                    json=body,
                    headers={
                        'Content-Type': 'application/json',
                        'User-Agent': 'UberSDR-Benchmark/1.0',
                    },
                    ssl=ssl_ctx,
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    data = await resp.json(content_type=None)

            if not data.get('allowed', False):
                reason = data.get('reason', 'unknown')
                self._stats.connection_rejected = True
                self._stats.rejection_reason = reason
                return False

            self._stats.connection_allowed = True
            return True

        except aiohttp.ClientError:
            # Network error — proceed anyway (matches real client behaviour)
            self._stats.connection_allowed = True
            return True
        except Exception:
            # Any other error — proceed anyway
            self._stats.connection_allowed = True
            return True

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _interruptible_sleep(self, seconds: float) -> None:
        """Sleep for *seconds* but wake early if stop_event fires."""
        import time
        deadline = time.monotonic() + seconds
        while not self._stop.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            await asyncio.sleep(min(0.25, remaining))


def make_user(
    user_id: int,
    config: BenchmarkConfig,
    stop_event: threading.Event,
) -> tuple[VirtualUser, UserStats]:
    """Factory: create a VirtualUser and its associated UserStats.

    Returns both so the caller can register the stats for reporting.
    """
    session_id = str(uuid.uuid4())
    stats = UserStats(user_id=user_id, session_id=session_id)
    user = VirtualUser(user_id, config, stats, stop_event)
    return user, stats
