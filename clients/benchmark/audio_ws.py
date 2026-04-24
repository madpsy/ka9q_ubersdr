"""
audio_ws.py - Audio WebSocket handler for the UberSDR benchmark.

Connects to /ws with the same URL parameters as radio_client.py, receives
binary PCM-zstd (or Opus) frames, counts bytes/messages, and discards the
data.  No decoding or audio output is performed.

WebSocket URL format (mirrors radio_client.py build_websocket_url()):
    /ws?frequency=<hz>&mode=<mode>&format=pcm-zstd&version=2
        &user_session_id=<uuid>[&bandwidthLow=<n>&bandwidthHigh=<n>]
        [&password=<pw>]

Keepalive: {"type": "ping"} every 30 seconds (matches real client).

In random-frequency mode the handler watches UserState.generation; when it
changes (i.e. the VirtualUser rotation task has picked a new frequency) a
{"type": "tune", ...} message is sent over the existing connection — no
reconnect is needed (mirrors how radio_client.py / the GUI retune).
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from urllib.parse import urlencode

import websockets
import websockets.exceptions

from config import BenchmarkConfig, UserState
from stats import UserStats
from ws_utils import SessionError, debug_log, get_handshake_status, is_retriable_handshake_error

_INVALID_SESSION_PHRASES = ('invalid session', 'please refresh')


# How often to send a JSON ping keepalive (seconds) — matches real client
_KEEPALIVE_INTERVAL = 30.0

# How often to poll UserState.generation for a frequency change (seconds)
_GENERATION_POLL_INTERVAL = 0.5

# Back-off parameters for network/connection errors (--reconnect)
_BACKOFF_BASE = 2.0
_BACKOFF_MAX = 60.0

# Back-off parameters for server-capacity errors (always retry)
# Shorter cap so we fill slots quickly once the server has room.
_SERVER_ERROR_BACKOFF_BASE = 2.0
_SERVER_ERROR_BACKOFF_MAX = 15.0


class AudioWebSocket:
    """Simulates the audio WebSocket connection of a real user.

    Instantiated once per VirtualUser.  Call ``run()`` as an asyncio task.
    """

    def __init__(
        self,
        config: BenchmarkConfig,
        stats: UserStats,
        state: UserState,
        stop_event: threading.Event,
    ) -> None:
        self._cfg = config
        self._stats = stats
        self._state = state
        self._stop = stop_event

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Connect, receive, and reconnect until stop_event is set.

        Retry behaviour:
        - HTTP 429/503 (rate limit / server full): always retry with backoff.
        - Server {"type": "error"} message: always retry with backoff.
        - Other network / connection errors: retry only if --reconnect is set.
        - Clean stop (stop_event fired): exit immediately.
        """
        retry = 0
        while not self._stop.is_set():
            try:
                await self._connect_and_receive()
                # Clean exit (stop_event fired inside _stop_watcher)
                break
            except SessionError:
                # Server says session is invalid — propagate up to VirtualUser
                # so it can re-POST /connection before retrying.
                self._stats.audio_connected = False
                raise
            except RuntimeError as exc:
                # Server sent {"type": "error"} — capacity limit or similar.
                self._stats.audio_connected = False
                self._stats.audio_errors += 1
                self._stats.audio_last_error = str(exc)
                debug_log(self._stats.user_id, 'audio', f"Server error (retry {retry}): {exc}")
                if self._stop.is_set():
                    break
                backoff = min(_SERVER_ERROR_BACKOFF_BASE ** retry, _SERVER_ERROR_BACKOFF_MAX)
                retry += 1
                await self._interruptible_sleep(backoff)
            except websockets.exceptions.WebSocketException as exc:
                self._stats.audio_connected = False
                self._stats.audio_errors += 1
                self._stats.audio_last_error = str(exc)
                status = get_handshake_status(exc)
                debug_log(self._stats.user_id, 'audio',
                          f"WS error HTTP {status} (retry {retry}): {exc}")
                if self._stop.is_set():
                    break
                if is_retriable_handshake_error(exc):
                    # HTTP 429/503 — always retry
                    backoff = min(_SERVER_ERROR_BACKOFF_BASE ** retry, _SERVER_ERROR_BACKOFF_MAX)
                    retry += 1
                    await self._interruptible_sleep(backoff)
                elif self._cfg.reconnect:
                    backoff = min(_BACKOFF_BASE ** retry, _BACKOFF_MAX)
                    retry += 1
                    await self._interruptible_sleep(backoff)
                else:
                    break
            except (OSError, asyncio.TimeoutError) as exc:
                self._stats.audio_connected = False
                self._stats.audio_errors += 1
                self._stats.audio_last_error = str(exc)
                debug_log(self._stats.user_id, 'audio', f"Network error (retry {retry}): {exc}")
                if not self._cfg.reconnect or self._stop.is_set():
                    break
                backoff = min(_BACKOFF_BASE ** retry, _BACKOFF_MAX)
                retry += 1
                await self._interruptible_sleep(backoff)
            except Exception as exc:
                self._stats.audio_connected = False
                self._stats.audio_errors += 1
                self._stats.audio_last_error = str(exc)
                debug_log(self._stats.user_id, 'audio', f"Unexpected error: {exc}")
                break

        self._stats.audio_connected = False

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _build_url(self) -> str:
        """Build the audio WebSocket URL using the current UserState.

        Mirrors ``RadioClient.build_websocket_url()`` in radio_client.py.
        The URL is built once at connect time; subsequent frequency/mode
        changes are sent as 'tune' messages over the live connection.
        """
        cfg = self._cfg
        state = self._state
        params: dict[str, str] = {
            'frequency': str(state.frequency),
            'mode': state.mode,
            'user_session_id': self._stats.session_id,
            'format': 'opus',
            'version': '2',
        }

        # Only include bandwidth for non-IQ modes (matches original client)
        if not state.is_iq_mode:
            if state.bandwidth_low is not None:
                params['bandwidthLow'] = str(state.bandwidth_low)
            if state.bandwidth_high is not None:
                params['bandwidthHigh'] = str(state.bandwidth_high)

        if cfg.password:
            params['password'] = cfg.password

        return f"{cfg.ws_base}/ws?{urlencode(params)}"

    async def _connect_and_receive(self) -> None:
        """Single connection attempt: connect → receive loop → disconnect."""
        url = self._build_url()

        async with websockets.connect(
            url,
            ping_interval=None,          # we handle keepalive ourselves
            additional_headers={'User-Agent': 'UberSDR-Benchmark/1.0'},
            open_timeout=15,
            close_timeout=5,
        ) as ws:
            self._stats.audio_connected = True

            # Request initial status (matches real client run_once())
            await ws.send(json.dumps({'type': 'get_status'}))

            # Snapshot the generation at connect time so we can detect changes
            connected_generation = self._state.generation

            # Run receive loop, keepalive, stop-watcher, and (optionally)
            # tune-sender concurrently.
            receive_task = asyncio.create_task(self._receive_loop(ws))
            keepalive_task = asyncio.create_task(self._keepalive_loop(ws))
            stop_task = asyncio.create_task(self._stop_watcher(ws))
            tune_task = asyncio.create_task(
                self._tune_loop(ws, connected_generation)
            )

            all_tasks = {receive_task, keepalive_task, stop_task, tune_task}

            try:
                # Wait for whichever finishes first
                done, pending = await asyncio.wait(
                    all_tasks,
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                for t in all_tasks:
                    if not t.done():
                        t.cancel()
                        try:
                            await t
                        except (asyncio.CancelledError, Exception):
                            pass

            self._stats.audio_connected = False

            # Re-raise any exception from the receive task
            if receive_task.done() and not receive_task.cancelled():
                exc = receive_task.exception()
                if exc:
                    raise exc

    async def _receive_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        """Receive messages and count bytes; discard all data."""
        async for message in ws:
            if self._stop.is_set():
                break
            msg_len = len(message) if isinstance(message, (bytes, bytearray)) else len(message.encode())
            self._stats.audio_bytes_rx += msg_len
            self._stats.audio_messages += 1
            self._stats.audio_last_message_time = time.monotonic()

            # Handle JSON control messages (status, error, pong)
            if isinstance(message, str):
                try:
                    data = json.loads(message)
                    msg_type = data.get('type')
                    if msg_type == 'error':
                        # Server sent {"type":"error","error":"...","status":N}
                        reason = data.get('error') or 'unknown error'
                        status = data.get('status', 0)
                        err_str = f"{reason} (status={status})" if status else reason
                        self._stats.audio_last_error = err_str
                        reason_lower = reason.lower()
                        if any(p in reason_lower for p in _INVALID_SESSION_PHRASES):
                            raise SessionError(err_str)
                        exc = RuntimeError(err_str)
                        exc.ws_status = status  # type: ignore[attr-defined]
                        raise exc
                except (json.JSONDecodeError, AttributeError):
                    pass
            # Binary frames (PCM-zstd): just counted above, discarded

    async def _tune_loop(
        self,
        ws: websockets.WebSocketClientProtocol,
        connected_generation: int,
    ) -> None:
        """Watch for frequency/mode changes and send a 'tune' message.

        Only active in random-frequency mode.  Polls UserState.generation;
        when it differs from the last seen value, sends a tune message over
        the existing connection — no reconnect needed.

        Mirrors the tune message sent by radio_client.py / the GUI when the
        user changes frequency or mode:
            {"type": "tune", "frequency": <hz>, "mode": <mode>,
             "bandwidthLow": <n>, "bandwidthHigh": <n>}

        In non-random-frequency mode this task sleeps indefinitely and is
        cancelled by the caller when the connection closes.
        """
        if not self._cfg.random_frequency:
            # Not in random-frequency mode — sleep indefinitely until cancelled
            try:
                await asyncio.sleep(float('inf'))
            except asyncio.CancelledError:
                pass
            return

        last_generation = connected_generation

        while not self._stop.is_set():
            await asyncio.sleep(_GENERATION_POLL_INTERVAL)

            if self._stop.is_set():
                break

            current_gen = self._state.generation
            if current_gen == last_generation:
                continue

            last_generation = current_gen
            state = self._state

            tune_msg: dict = {
                'type': 'tune',
                'frequency': state.frequency,
                'mode': state.mode,
            }
            if not state.is_iq_mode:
                if state.bandwidth_low is not None:
                    tune_msg['bandwidthLow'] = state.bandwidth_low
                if state.bandwidth_high is not None:
                    tune_msg['bandwidthHigh'] = state.bandwidth_high

            debug_log(
                self._stats.user_id, 'audio',
                f"tune → {state.frequency / 1e6:.3f} MHz {state.mode.upper()}"
            )

            try:
                await ws.send(json.dumps(tune_msg))
            except websockets.exceptions.ConnectionClosed:
                break

    async def _keepalive_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        """Send {"type": "ping"} every 30 seconds (matches real client)."""
        while not self._stop.is_set():
            await asyncio.sleep(_KEEPALIVE_INTERVAL)
            if self._stop.is_set():
                break
            try:
                await ws.send(json.dumps({'type': 'ping'}))
            except websockets.exceptions.ConnectionClosed:
                break

    async def _stop_watcher(self, ws: websockets.WebSocketClientProtocol) -> None:
        """Poll the threading.Event and close the WebSocket when it fires."""
        while not self._stop.is_set():
            await asyncio.sleep(0.25)
        try:
            await ws.close()
        except Exception:
            pass

    async def _interruptible_sleep(self, seconds: float) -> None:
        """Sleep for *seconds* but wake early if stop_event fires."""
        deadline = time.monotonic() + seconds
        while not self._stop.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            await asyncio.sleep(min(0.25, remaining))
