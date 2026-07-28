"""
UberSDR session management for the callsign scanner.

Two WebSockets, sharing one client-generated user_session_id:

  /ws?frequency=...&mode=...&user_session_id=UUID   — creates the audio session
  /ws/dxcluster?user_session_id=UUID                — extension control + results

The audio session is what gives us (a) something for Whisper to tap and (b) the
"active audio session" that /api/lookup requires for auth. We immediately mute
it: the extension tap is fed in the RTP receive path (audio.go, before the mute
check in streamAudio), so Whisper still receives full-rate audio server-side
while we receive no audio bytes at all. That means no Opus or zstd decoding in
this client — we just drain the socket.

Retuning uses the "tune" control message rather than reconnecting, which keeps
the same radiod channel and leaves the extension tap attached across hops.
"""

import json
import logging
import struct
import threading
import time
import uuid as uuidlib
from dataclasses import dataclass
from typing import Callable, List, Optional

import websocket

log = logging.getLogger(__name__)

# Binary message types from the whisper extension (audio_extensions/whisper/decoder.go)
MSG_SEGMENTS = 0x02
MSG_LANGUAGE = 0x03
MSG_ERROR = 0x04
MSG_SUMMARY = 0x05


@dataclass
class Segment:
    """One transcription segment from Whisper."""

    text: str
    start: float
    end: float
    completed: bool
    received_at: float


class UberSDRSession:
    """A muted audio session with the Whisper extension attached."""

    def __init__(
        self,
        host: str,
        port: int = 8080,
        use_ssl: bool = False,
        password: Optional[str] = None,
        frequency: int = 14200000,
        mode: str = "usb",
        on_segment: Optional[Callable[[Segment], None]] = None,
        on_error: Optional[Callable[[str], None]] = None,
    ):
        self.host = host
        self.port = port
        self.use_ssl = use_ssl
        self.password = password
        self.user_session_id = str(uuidlib.uuid4())

        self.frequency = frequency
        self.mode = mode

        self.on_segment = on_segment
        self.on_error = on_error

        self._ws_scheme = "wss" if use_ssl else "ws"
        self._audio_ws: Optional[websocket.WebSocketApp] = None
        self._dx_ws: Optional[websocket.WebSocketApp] = None
        self._audio_thread: Optional[threading.Thread] = None
        self._dx_thread: Optional[threading.Thread] = None

        self._running = False
        self._audio_ready = threading.Event()
        self._dx_ready = threading.Event()
        self._attached = threading.Event()

        self._lock = threading.Lock()

    # -- URLs ---------------------------------------------------------------

    @property
    def base_http(self) -> str:
        scheme = "https" if self.use_ssl else "http"
        return f"{scheme}://{self.host}:{self.port}"

    def _audio_url(self) -> str:
        params = [
            f"frequency={self.frequency}",
            f"mode={self.mode}",
            f"user_session_id={self.user_session_id}",
            # We never decode audio, but the server requires a valid format.
            "format=pcm-zstd",
            "version=2",
        ]
        if self.password:
            from urllib.parse import quote

            params.append(f"password={quote(self.password)}")
        return f"{self._ws_scheme}://{self.host}:{self.port}/ws?" + "&".join(params)

    def _dx_url(self) -> str:
        return (
            f"{self._ws_scheme}://{self.host}:{self.port}"
            f"/ws/dxcluster?user_session_id={self.user_session_id}"
        )

    # -- Lifecycle ----------------------------------------------------------

    def start(self, timeout: float = 20.0) -> bool:
        """Bring up both sockets. Returns True once the audio session exists."""
        self._running = True

        self._audio_ws = websocket.WebSocketApp(
            self._audio_url(),
            on_open=self._on_audio_open,
            on_message=self._on_audio_message,
            on_error=lambda ws, err: log.debug("Audio WS error: %s", err),
            on_close=self._on_audio_close,
        )
        self._audio_thread = threading.Thread(
            target=self._audio_ws.run_forever,
            kwargs={"ping_interval": 30, "ping_timeout": 10},
            daemon=True,
        )
        self._audio_thread.start()

        if not self._audio_ready.wait(timeout):
            log.error("Timed out waiting for the audio session to open")
            return False

        # The DX socket is rejected unless the UUID is already known to the
        # server, so it must come second.
        self._dx_ws = websocket.WebSocketApp(
            self._dx_url(),
            on_open=self._on_dx_open,
            on_message=self._on_dx_message,
            on_error=lambda ws, err: log.debug("DX WS error: %s", err),
            on_close=lambda ws, code, msg: log.info("DX WS closed (%s)", code),
        )
        self._dx_thread = threading.Thread(
            target=self._dx_ws.run_forever,
            kwargs={"ping_interval": 30, "ping_timeout": 10},
            daemon=True,
        )
        self._dx_thread.start()

        if not self._dx_ready.wait(timeout):
            log.error("Timed out waiting for the DX cluster socket")
            return False

        return True

    def stop(self) -> None:
        self._running = False
        for ws in (self._dx_ws, self._audio_ws):
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass

    # -- Audio socket -------------------------------------------------------

    def _on_audio_open(self, ws) -> None:
        log.info(
            "Audio session open: %s @ %.3f MHz (uuid %s)",
            self.mode, self.frequency / 1e6, self.user_session_id,
        )
        # Suppress the audio downlink. Whisper's tap is upstream of this, so
        # transcription is unaffected — see audio.go:286 vs websocket.go:1618.
        self._send_audio({"type": "set_mute", "muted": True})
        self._audio_ready.set()

    def _on_audio_message(self, ws, message) -> None:
        # Binary frames are audio/silence packets; drain and discard. Text
        # frames are status. We only care about errors and kicks.
        if isinstance(message, bytes):
            return
        try:
            msg = json.loads(message)
        except (ValueError, TypeError):
            return

        mtype = msg.get("type")
        if mtype == "error":
            detail = msg.get("error") or msg.get("message", "")
            log.warning("Audio session error: %s", detail)
            if self.on_error:
                self.on_error(str(detail))
        elif mtype in ("kicked", "session_kicked"):
            log.error("Session kicked by server: %s", msg)
            self._running = False
            if self.on_error:
                self.on_error("session kicked")

    def _on_audio_close(self, ws, code, msg) -> None:
        log.info("Audio WS closed (%s)", code)
        self._audio_ready.clear()

    def _send_audio(self, payload: dict) -> None:
        with self._lock:
            if self._audio_ws is None:
                return
            try:
                self._audio_ws.send(json.dumps(payload))
            except Exception as exc:
                log.debug("Audio send failed: %s", exc)

    # -- DX socket ----------------------------------------------------------

    def _on_dx_open(self, ws) -> None:
        log.info("DX cluster socket open")
        self._dx_ready.set()

    def _on_dx_message(self, ws, message) -> None:
        if isinstance(message, bytes):
            self._handle_binary(message)
            return

        try:
            msg = json.loads(message)
        except (ValueError, TypeError):
            return

        mtype = msg.get("type")
        if mtype == "audio_extension_attached":
            log.info("Whisper attached (%s)", msg.get("started_at", ""))
            self._attached.set()
        elif mtype == "audio_extension_detached":
            log.info("Whisper detached")
            self._attached.clear()
        elif mtype == "audio_extension_error":
            err = msg.get("error", "")
            log.error("Extension error: %s", err)
            self._attached.clear()
            if self.on_error:
                self.on_error(str(err))
        elif mtype == "audio_extension_control_ack":
            log.debug("Control ack: %s", msg.get("control_type"))

    def _handle_binary(self, data: bytes) -> None:
        """Decode [type:1][timestamp:8][len:4][payload:N]."""
        if len(data) < 13:
            return

        msg_type = data[0]
        payload_len = struct.unpack(">I", data[9:13])[0]
        payload = data[13:13 + payload_len]

        if msg_type == MSG_SEGMENTS:
            try:
                segments = json.loads(payload.decode("utf-8", errors="replace"))
            except ValueError:
                return
            if not isinstance(segments, list):
                return
            now = time.time()
            for seg in segments:
                if not isinstance(seg, dict):
                    continue
                text = (seg.get("text") or "").strip()
                if not text:
                    continue
                segment = Segment(
                    text=text,
                    start=float(seg.get("start") or 0.0),
                    end=float(seg.get("end") or 0.0),
                    completed=bool(seg.get("completed")),
                    received_at=now,
                )
                if self.on_segment:
                    self.on_segment(segment)

        elif msg_type == MSG_LANGUAGE:
            try:
                info = json.loads(payload.decode("utf-8", errors="replace"))
                log.debug(
                    "Language detected: %s (%.2f)",
                    info.get("language"), info.get("language_prob", 0.0),
                )
            except ValueError:
                pass

        elif msg_type == MSG_ERROR:
            err = payload.decode("utf-8", errors="replace")
            log.error("Whisper error: %s", err)
            if self.on_error:
                self.on_error(err)

    def _send_dx(self, payload: dict) -> bool:
        with self._lock:
            if self._dx_ws is None:
                return False
            try:
                self._dx_ws.send(json.dumps(payload))
                return True
            except Exception as exc:
                log.warning("DX send failed: %s", exc)
                return False

    # -- Control ------------------------------------------------------------

    def attach_whisper(
        self,
        initial_prompt: Optional[str] = None,
        task: Optional[str] = None,
        asr_language: Optional[str] = None,
        timeout: float = 15.0,
    ) -> bool:
        """
        Attach the Whisper extension.

        initial_prompt / task / asr_language require
        `whisper.allow_client_params: true` on the server; the attach is
        rejected outright otherwise, so leave them unset against a stock
        instance.
        """
        params: dict = {}
        if initial_prompt is not None:
            params["initial_prompt"] = initial_prompt
        if task is not None:
            params["task"] = task
        if asr_language is not None:
            params["asr_language"] = asr_language

        self._attached.clear()
        ok = self._send_dx({
            "type": "audio_extension_attach",
            "extension_name": "whisper",
            "params": params,
        })
        if not ok:
            return False

        if not self._attached.wait(timeout):
            log.error("Whisper attach not confirmed within %.0fs", timeout)
            return False
        return True

    def detach_whisper(self) -> None:
        self._send_dx({"type": "audio_extension_detach"})
        self._attached.clear()

    def reset_transcript(self) -> None:
        """
        Clear Whisper's duplicate-suppression history.

        Essential when hopping: completed segments are dropped if their exact
        text was seen before, so without this a fresh "this is ..." on a new
        frequency gets swallowed as a duplicate of the previous frequency's.
        Requires the reset_transcript control message on the server.
        """
        self._send_dx({
            "type": "audio_extension_control",
            "control_type": "reset_transcript",
        })

    def tune(self, frequency: int, mode: Optional[str] = None) -> bool:
        """Retune in place, keeping the session and the extension tap alive."""
        payload: dict = {"type": "tune", "frequency": int(frequency)}
        if mode:
            payload["mode"] = mode

        if not self._send_audio_checked(payload):
            return False

        self.frequency = int(frequency)
        if mode:
            self.mode = mode
        return True

    def _send_audio_checked(self, payload: dict) -> bool:
        with self._lock:
            if self._audio_ws is None:
                return False
            try:
                self._audio_ws.send(json.dumps(payload))
                return True
            except Exception as exc:
                log.warning("Tune failed: %s", exc)
                return False

    def ping(self) -> None:
        """Application-level keepalive, mirroring what the web UI sends."""
        self._send_audio({"type": "ping"})

    @property
    def attached(self) -> bool:
        return self._attached.is_set()

    @property
    def alive(self) -> bool:
        return self._running and self._audio_ready.is_set()
