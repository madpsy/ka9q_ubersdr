"""
spectrum_ws.py - Spectrum WebSocket handler for the UberSDR benchmark.

Connects to /ws/user-spectrum with the same parameters as spectrum_display.py,
receives binary SPEC frames or gzip-compressed JSON, counts bytes/messages,
and discards the data.

WebSocket URL format (mirrors spectrum_display.py connect()):
    /ws/user-spectrum?user_session_id=<uuid>&mode=binary8[&password=<pw>]

On first config message the real client sends a zoom command:
    {"type": "zoom", "frequency": <tuned_hz>, "binBandwidth": <zoom_hz / binCount>}

In random-frequency mode the handler watches UserState.generation; when it
changes (i.e. the VirtualUser rotation task has picked a new frequency/zoom)
a new zoom message is sent over the existing connection — no reconnect needed.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import threading
from urllib.parse import urlencode

import websockets
import websockets.exceptions

from config import BenchmarkConfig, UserState
from stats import UserStats
from ws_utils import SessionError, debug_log, get_handshake_status, is_retriable_handshake_error

_INVALID_SESSION_PHRASES = ('invalid session', 'please refresh')


# Back-off parameters for network/connection errors (--reconnect)
_BACKOFF_BASE = 2.0
_BACKOFF_MAX = 60.0

# Back-off parameters for server-capacity errors (always retry)
_SERVER_ERROR_BACKOFF_BASE = 2.0
_SERVER_ERROR_BACKOFF_MAX = 15.0

# How often to poll UserState.generation for a frequency/zoom change (seconds)
_GENERATION_POLL_INTERVAL = 0.5

# Binary spectrum protocol magic header
_SPEC_MAGIC = b'SPEC'


class SpectrumWebSocket:
    """Simulates the spectrum WebSocket connection of a real user.

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
                break
            except SessionError:
                # Server says session is invalid — propagate up to VirtualUser
                # so it can re-POST /connection before retrying.
                self._stats.spectrum_connected = False
                raise
            except RuntimeError as exc:
                self._stats.spectrum_connected = False
                self._stats.spectrum_errors += 1
                self._stats.spectrum_last_error = str(exc)
                debug_log(self._stats.user_id, 'spectrum', f"Server error (retry {retry}): {exc}")
                if self._stop.is_set():
                    break
                backoff = min(_SERVER_ERROR_BACKOFF_BASE ** retry, _SERVER_ERROR_BACKOFF_MAX)
                retry += 1
                await self._interruptible_sleep(backoff)
            except websockets.exceptions.WebSocketException as exc:
                self._stats.spectrum_connected = False
                self._stats.spectrum_errors += 1
                self._stats.spectrum_last_error = str(exc)
                status = get_handshake_status(exc)
                debug_log(self._stats.user_id, 'spectrum',
                          f"WS error HTTP {status} (retry {retry}): {exc}")
                if self._stop.is_set():
                    break
                if is_retriable_handshake_error(exc):
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
                self._stats.spectrum_connected = False
                self._stats.spectrum_errors += 1
                self._stats.spectrum_last_error = str(exc)
                debug_log(self._stats.user_id, 'spectrum', f"Network error (retry {retry}): {exc}")
                if not self._cfg.reconnect or self._stop.is_set():
                    break
                backoff = min(_BACKOFF_BASE ** retry, _BACKOFF_MAX)
                retry += 1
                await self._interruptible_sleep(backoff)
            except Exception as exc:
                self._stats.spectrum_connected = False
                self._stats.spectrum_errors += 1
                self._stats.spectrum_last_error = str(exc)
                debug_log(self._stats.user_id, 'spectrum', f"Unexpected error: {exc}")
                break

        self._stats.spectrum_connected = False

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _build_url(self) -> str:
        """Build the spectrum WebSocket URL.

        Mirrors spectrum_display.py connect() URL construction.
        """
        cfg = self._cfg
        params: dict[str, str] = {
            'user_session_id': self._stats.session_id,
            'mode': 'binary8',   # request 8-bit binary encoding (max bandwidth reduction)
        }
        if cfg.password:
            params['password'] = cfg.password

        return f"{cfg.ws_base}/ws/user-spectrum?{urlencode(params)}"

    async def _connect_and_receive(self) -> None:
        """Single connection attempt."""
        url = self._build_url()

        async with websockets.connect(
            url,
            ping_interval=None,
            additional_headers={'User-Agent': 'UberSDR-Benchmark/1.0'},
            open_timeout=15,
            close_timeout=5,
        ) as ws:
            self._stats.spectrum_connected = True

            # Snapshot the generation at connect time
            connected_generation = self._state.generation

            # Shared state for the zoom loop and receive loop to coordinate
            # which bin_count to use when sending zoom commands.
            zoom_state = {'bin_count': 0, 'zoom_sent': False}

            receive_task = asyncio.create_task(
                self._receive_loop(ws, connected_generation, zoom_state)
            )
            zoom_task = asyncio.create_task(
                self._zoom_loop(ws, connected_generation, zoom_state)
            )
            stop_task = asyncio.create_task(self._stop_watcher(ws))

            all_tasks = {receive_task, zoom_task, stop_task}

            try:
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

            self._stats.spectrum_connected = False

            if receive_task.done() and not receive_task.cancelled():
                exc = receive_task.exception()
                if exc:
                    raise exc

    async def _receive_loop(
        self,
        ws: websockets.WebSocketClientProtocol,
        connected_generation: int,
        zoom_state: dict,
    ) -> None:
        """Receive messages, send zoom on first config message.

        After the initial zoom is sent, the dedicated _zoom_loop task handles
        subsequent zoom updates when the generation changes.
        """
        async for message in ws:
            if self._stop.is_set():
                break

            msg_len = (
                len(message)
                if isinstance(message, (bytes, bytearray))
                else len(message.encode())
            )
            self._stats.spectrum_bytes_rx += msg_len
            self._stats.spectrum_messages += 1

            # ---- Binary messages ----
            if isinstance(message, (bytes, bytearray)):
                if len(message) >= 4 and message[0:4] == _SPEC_MAGIC:
                    # Binary SPEC frame — counted, discarded.
                    pass
                else:
                    # Legacy: gzip-compressed JSON
                    if not zoom_state['zoom_sent']:
                        try:
                            data = json.loads(gzip.decompress(message).decode('utf-8'))
                            sent, bin_count = await self._maybe_send_initial_zoom(
                                ws, data, zoom_state['bin_count']
                            )
                            if sent:
                                zoom_state['zoom_sent'] = True
                                zoom_state['bin_count'] = bin_count
                        except Exception:
                            pass
                continue

            # ---- Text (JSON) messages ----
            try:
                data = json.loads(message)
            except (json.JSONDecodeError, AttributeError):
                continue

            if data.get('type') == 'error':
                reason = data.get('error') or 'unknown error'
                status = data.get('status', 0)
                err_str = f"{reason} (status={status})" if status else reason
                self._stats.spectrum_last_error = err_str
                reason_lower = reason.lower()
                if any(p in reason_lower for p in _INVALID_SESSION_PHRASES):
                    raise SessionError(err_str)
                exc = RuntimeError(err_str)
                exc.ws_status = status  # type: ignore[attr-defined]
                raise exc

            if not zoom_state['zoom_sent']:
                sent, bin_count = await self._maybe_send_initial_zoom(
                    ws, data, zoom_state['bin_count']
                )
                if sent:
                    zoom_state['zoom_sent'] = True
                    zoom_state['bin_count'] = bin_count

    async def _zoom_loop(
        self,
        ws: websockets.WebSocketClientProtocol,
        connected_generation: int,
        zoom_state: dict,
    ) -> None:
        """Dedicated task: poll UserState.generation and send zoom on change.

        Runs independently of the receive loop so zoom updates are sent
        promptly (every _GENERATION_POLL_INTERVAL seconds) regardless of
        how frequently the server sends spectrum messages.

        Waits until the initial zoom has been sent (zoom_state['zoom_sent'])
        before watching for generation changes.
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

            # Wait until the receive loop has sent the initial zoom
            if not zoom_state['zoom_sent']:
                continue

            bin_count = zoom_state['bin_count']
            if bin_count <= 0:
                continue

            current_gen = self._state.generation
            if current_gen == last_generation:
                continue

            last_generation = current_gen
            await self._send_zoom(ws, bin_count)

    async def _maybe_send_initial_zoom(
        self,
        ws: websockets.WebSocketClientProtocol,
        data: dict,
        last_bin_count: int,
    ) -> tuple[bool, int]:
        """Send the initial zoom command on the first 'config' message.

        Returns (zoom_sent, bin_count).
        """
        if data.get('type') != 'config':
            return False, last_bin_count

        # --spectrum-default: stay at server defaults, never send zoom.
        if self._cfg.spectrum_default:
            return True, last_bin_count

        bin_count = data.get('binCount', 0)
        if bin_count <= 0:
            return False, last_bin_count

        await self._send_zoom(ws, bin_count)
        return True, bin_count

    async def _send_zoom(
        self,
        ws: websockets.WebSocketClientProtocol,
        bin_count: int,
    ) -> None:
        """Send a zoom command using the current UserState frequency and zoom.

        binBandwidth = desired_total_bandwidth / binCount
        (matches spectrum_display.py _send_zoom_command())
        """
        state = self._state
        bin_bandwidth = state.spectrum_zoom_hz / bin_count

        zoom_cmd = {
            'type': 'zoom',
            'frequency': state.frequency,
            'binBandwidth': bin_bandwidth,
        }

        debug_log(
            self._stats.user_id, 'spectrum',
            f"zoom → {state.frequency / 1e6:.3f} MHz  "
            f"bw={state.spectrum_zoom_khz:.0f} kHz  "
            f"binBw={bin_bandwidth:.2f}"
        )

        try:
            await ws.send(json.dumps(zoom_cmd))
        except websockets.exceptions.ConnectionClosed:
            pass

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
        import time
        deadline = time.monotonic() + seconds
        while not self._stop.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            await asyncio.sleep(min(0.25, remaining))
