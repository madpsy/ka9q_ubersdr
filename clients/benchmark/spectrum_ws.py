"""
spectrum_ws.py - Spectrum WebSocket handler for the UberSDR benchmark.

Connects to /ws/user-spectrum with the same parameters as spectrum_display.py,
receives binary SPEC frames or gzip-compressed JSON, counts bytes/messages,
and discards the data.

WebSocket URL format (mirrors spectrum_display.py connect()):
    /ws/user-spectrum?user_session_id=<uuid>&mode=binary8[&password=<pw>]

On first config message the real client sends a zoom command:
    {"type": "zoom", "frequency": <tuned_hz>, "binBandwidth": <zoom_hz / binCount>}

This is replicated here so the server behaves identically to a real user.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import struct
import threading
from urllib.parse import urlencode

import websockets
import websockets.exceptions

from config import BenchmarkConfig
from stats import UserStats
from ws_utils import SessionError, debug_log, get_handshake_status, is_retriable_handshake_error

_INVALID_SESSION_PHRASES = ('invalid session', 'please refresh')


# Back-off parameters for network/connection errors (--reconnect)
_BACKOFF_BASE = 2.0
_BACKOFF_MAX = 60.0

# Back-off parameters for server-capacity errors (always retry)
_SERVER_ERROR_BACKOFF_BASE = 2.0
_SERVER_ERROR_BACKOFF_MAX = 15.0

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
        stop_event: threading.Event,
    ) -> None:
        self._cfg = config
        self._stats = stats
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

            receive_task = asyncio.create_task(self._receive_loop(ws))
            stop_task = asyncio.create_task(self._stop_watcher(ws))

            try:
                done, pending = await asyncio.wait(
                    {receive_task, stop_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                for t in (receive_task, stop_task):
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

    async def _receive_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        """Receive messages, send zoom on first config, discard all data."""
        zoom_sent = False

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
                # Check for binary SPEC protocol (magic header b'SPEC')
                if len(message) >= 4 and message[0:4] == _SPEC_MAGIC:
                    # Binary spectrum frame — just counted, discarded
                    pass
                else:
                    # Legacy: gzip-compressed JSON
                    if not zoom_sent:
                        try:
                            decompressed = gzip.decompress(message)
                            data = json.loads(decompressed.decode('utf-8'))
                            zoom_sent = await self._maybe_send_zoom(ws, data, zoom_sent)
                        except Exception:
                            pass
                continue

            # ---- Text (JSON) messages ----
            try:
                data = json.loads(message)
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
                zoom_sent = await self._maybe_send_zoom(ws, data, zoom_sent)
            except (json.JSONDecodeError, AttributeError):
                pass

    async def _maybe_send_zoom(
        self,
        ws: websockets.WebSocketClientProtocol,
        data: dict,
        zoom_sent: bool,
    ) -> bool:
        """Send a zoom command after the first config message.

        Mirrors spectrum_display.py _websocket_handler() / _handle_message():
        on the first 'config' message, compute binBandwidth from the server's
        binCount and send a zoom command centred on the tuned frequency.

        When ``config.spectrum_default`` is True the zoom command is skipped
        entirely so the server keeps the session at its default spectrum
        parameters — this exercises the shared-default-spectrum-channel path
        where all such users share a single radiod channel.

        Returns the new value of zoom_sent.
        """
        if zoom_sent:
            return True

        if data.get('type') != 'config':
            return False

        # --spectrum-default: stay at server defaults, never send zoom.
        if self._cfg.spectrum_default:
            return True  # mark as "done" so we never try again

        bin_count = data.get('binCount', 0)
        if bin_count <= 0:
            return False

        # binBandwidth = desired_total_bandwidth / binCount
        # (matches spectrum_display.py _send_zoom_command())
        bin_bandwidth = self._cfg.spectrum_zoom_hz / bin_count

        zoom_cmd = {
            'type': 'zoom',
            'frequency': self._cfg.frequency,   # tuned frequency, not spectrum centre
            'binBandwidth': bin_bandwidth,
        }

        try:
            await ws.send(json.dumps(zoom_cmd))
        except websockets.exceptions.ConnectionClosed:
            pass

        return True

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
