"""
ws_utils.py - Shared WebSocket utilities for the UberSDR benchmark.
"""

from __future__ import annotations

import sys
import threading


class SessionError(RuntimeError):
    """Raised when the server rejects a WebSocket with 'Invalid session'.

    This signals VirtualUser to re-POST /connection before retrying.
    """
    pass


def is_retriable_handshake_error(exc: Exception) -> bool:
    """Return True if the WebSocket handshake failed with a retriable HTTP status.

    HTTP 429 (Too Many Requests) and 503/502/504 (server unavailable) are
    retriable — the server is rate-limiting or temporarily full.
    Other 4xx errors (e.g. 403 Forbidden) are not retriable.
    """
    # websockets >= 13: InvalidStatus has a .response attribute
    if hasattr(exc, 'response') and exc.response is not None:
        status = getattr(exc.response, 'status_code', None)
        if status in (429, 503, 502, 504):
            return True
    # websockets legacy: InvalidStatusCode has a .status_code attribute
    if hasattr(exc, 'status_code'):
        if exc.status_code in (429, 503, 502, 504):
            return True
    return False


def get_handshake_status(exc: Exception) -> int | None:
    """Extract the HTTP status code from a WebSocket handshake exception, or None."""
    if hasattr(exc, 'response') and exc.response is not None:
        return getattr(exc.response, 'status_code', None)
    if hasattr(exc, 'status_code'):
        return exc.status_code
    return None


# ---------------------------------------------------------------------------
# Debug logging
# ---------------------------------------------------------------------------

_debug_lock = threading.Lock()
_debug_enabled = False


def set_debug(enabled: bool) -> None:
    global _debug_enabled
    _debug_enabled = enabled


def debug_log(user_id: int, ws_type: str, message: str) -> None:
    """Print a debug line to stderr if debug mode is enabled."""
    if not _debug_enabled:
        return
    with _debug_lock:
        print(f"[DEBUG user={user_id} {ws_type}] {message}", file=sys.stderr)
