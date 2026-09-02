"""
tuning_range.py - how much spectrum a receiver covers.

Read from /api/description's `tuning_range` object, which the server builds in
receiver_span.go. Every field is optional, including the whole object: an
instance that predates it, or one behind a proxy that strips it, says nothing
and is assumed to be the RX888 span every receiver had before the field existed.

That assumption used to be hardcoded in several places as "30 MHz", which is now
wrong for real instances -- a 60 MHz receiver is an ordinary configuration, and
one of them refusing to tune 6 m because the client had a constant in it is a
client bug, not a receiver limit.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

#: Defaults for a receiver that publishes no range. These are the server's own
#: fallbacks -- receiverMinFrequency and receiverTodaySpanHz in receiver_span.go.
DEFAULT_MIN_FREQUENCY = 10_000       # 10 kHz
DEFAULT_MAX_FREQUENCY = 30_000_000   # 30 MHz


def tuning_range_from(description: Optional[Dict[str, Any]]) -> Tuple[int, int]:
    """Return (min_hz, max_hz) for a receiver, from its /api/description body.

    Each edge falls back on its own: they are independent facts, and a receiver
    that states one must not reset the other. Anything at or below zero is "not
    said" rather than a limit, so a zero, a missing field, a null or a
    non-numeric value all leave that edge at its default.

    A maximum at or below the minimum is a misconfigured receiver rather than a
    range, and is refused whole rather than adopted inverted -- an inverted range
    would reject every frequency there is.
    """
    lo, hi = DEFAULT_MIN_FREQUENCY, DEFAULT_MAX_FREQUENCY
    if not isinstance(description, dict):
        return lo, hi
    tr = description.get('tuning_range')
    if not isinstance(tr, dict):
        return lo, hi

    def _edge(key: str, fallback: int) -> int:
        value = tr.get(key)
        try:
            value = int(value)
        except (TypeError, ValueError):
            return fallback
        return value if value > 0 else fallback

    new_lo = _edge('min_frequency', lo)
    new_hi = _edge('max_frequency', hi)
    if new_hi <= new_lo:
        return lo, hi
    return new_lo, new_hi


def format_range(min_hz: int, max_hz: int) -> str:
    """The range as MHz, for messages shown to a person."""
    return f"{min_hz / 1e6:.6f} - {max_hz / 1e6:.6f} MHz"
