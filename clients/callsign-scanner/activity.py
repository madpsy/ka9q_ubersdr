"""
Voice activity tracking — decides where the scanner points next.

Sources, in order of usefulness:

  GET /api/voice-activity/stream        SSE push, all bands, max 2 conns per IP
  GET /api/noisefloor/voice-activity/all  snapshot, rate limited to 1 req / 2 s

The SSE feed is the primary source. The server's background scanner runs every
5 s and pushes each detection once on first sight, then re-pushes every 60 s
while it stays active (or immediately if its DX callsign changes). So an entry
that has not been refreshed in a few minutes is stale and gets expired.

The snapshot endpoint is used once at startup so the scanner does not have to
wait up to 60 s for the SSE feed to redescribe everything already on the air.

Each entry carries `dx_callsign` when the DX cluster has spotted that frequency
within the last 30 minutes. That is free ground truth: if Whisper hears a
callsign there and it matches the spot, confidence is very high — and it is also
how you measure whether the whole approach works at all.
"""

import json
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import requests

log = logging.getLogger(__name__)

# Bands the server never reports voice activity for (voice_activity.go).
EXCLUDED_BANDS = {"2200m", "630m", "30m"}


@dataclass
class Target:
    """One active voice signal."""

    band: str
    dial_freq: int
    mode: str
    snr: float
    confidence: float
    bandwidth: int = 0
    dx_callsign: str = ""
    dx_country: str = ""
    first_seen: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    last_visited: float = 0.0
    visits: int = 0
    callsigns_found: int = 0

    @property
    def key(self) -> Tuple[str, int]:
        return (self.band, self.dial_freq)

    @property
    def age(self) -> float:
        return time.time() - self.last_seen

    def priority(self) -> float:
        """
        Scan priority. Higher is scanned sooner.

        Balances signal quality against starvation: a strong signal is worth
        more, but anything unvisited for a long time climbs regardless, so the
        scanner sweeps rather than camping on the loudest station.
        """
        score = 0.0
        score += min(self.snr, 40.0) / 40.0 * 30.0
        score += self.confidence * 20.0

        if self.last_visited == 0.0:
            score += 40.0  # never visited — strongly prefer
        else:
            idle = time.time() - self.last_visited
            score += min(idle / 60.0, 10.0) * 4.0

        # A DX spot means someone is genuinely working this frequency.
        if self.dx_callsign:
            score += 15.0

        # Somewhere we have already succeeded is worth revisiting.
        if self.callsigns_found:
            score += 10.0

        # Decay stale detections.
        score -= min(self.age / 60.0, 5.0) * 3.0
        return score


class ActivityTracker:
    """Maintains the live set of scan targets."""

    def __init__(
        self,
        base_url: str,
        band: Optional[str] = None,
        min_snr: float = 0.0,
        min_confidence: float = 0.0,
        expiry: float = 600.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.band = band
        self.min_snr = min_snr
        self.min_confidence = min_confidence
        self.expiry = expiry

        self._targets: Dict[Tuple[str, int], Target] = {}
        self._lock = threading.Lock()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._http = requests.Session()

    # -- Lifecycle ----------------------------------------------------------

    def start(self) -> None:
        self._running = True
        self.seed_from_snapshot()
        self._thread = threading.Thread(target=self._sse_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running = False

    # -- Ingest -------------------------------------------------------------

    def seed_from_snapshot(self) -> int:
        """Prime the target set so we do not wait on the SSE feed."""
        params = {}
        if self.min_confidence > 0:
            params["min_confidence"] = str(self.min_confidence)

        try:
            resp = self._http.get(
                f"{self.base_url}/api/noisefloor/voice-activity/all",
                params=params,
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
        except (requests.RequestException, ValueError) as exc:
            log.warning("Voice activity snapshot failed: %s", exc)
            return 0

        count = 0
        for band, activities in (data.get("bands") or {}).items():
            if band in EXCLUDED_BANDS:
                continue
            if self.band and band != self.band:
                continue
            for act in activities or []:
                if self._ingest(
                    band=band,
                    dial_freq=int(act.get("estimated_dial_freq") or 0),
                    mode=act.get("mode", ""),
                    snr=float(act.get("snr") or 0.0),
                    confidence=float(act.get("confidence") or 0.0),
                    bandwidth=int(act.get("bandwidth") or 0),
                    dx_callsign=act.get("dx_callsign", "") or "",
                    dx_country=act.get("dx_country", "") or "",
                ):
                    count += 1

        log.info("Seeded %d targets from snapshot", count)
        return count

    def _sse_loop(self) -> None:
        """Consume the SSE feed, reconnecting with backoff."""
        url = f"{self.base_url}/api/voice-activity/stream"
        params = {"band": self.band} if self.band else {}
        backoff = 2.0

        while self._running:
            try:
                with self._http.get(
                    url, params=params, stream=True, timeout=(10, 90),
                    headers={"Accept": "text/event-stream"},
                ) as resp:
                    resp.raise_for_status()
                    log.info("Voice activity stream connected")
                    backoff = 2.0

                    for raw in resp.iter_lines(decode_unicode=True):
                        if not self._running:
                            break
                        if not raw or not raw.startswith("data:"):
                            continue
                        payload = raw[5:].strip()
                        if not payload:
                            continue
                        try:
                            event = json.loads(payload)
                        except ValueError:
                            continue
                        if event.get("type") != "voice_activity":
                            continue  # heartbeats and anything else

                        band = event.get("band", "")
                        if band in EXCLUDED_BANDS:
                            continue
                        self._ingest(
                            band=band,
                            dial_freq=int(event.get("estimated_dial_freq") or 0),
                            mode=event.get("mode", ""),
                            snr=float(event.get("snr") or 0.0),
                            confidence=float(event.get("confidence") or 0.0),
                            bandwidth=int(event.get("bandwidth") or 0),
                            dx_callsign=event.get("dx_callsign", "") or "",
                            dx_country=event.get("dx_country", "") or "",
                        )
            except requests.RequestException as exc:
                if self._running:
                    log.warning("Voice activity stream dropped (%s); retrying", exc)

            if self._running:
                time.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    def _ingest(
        self, band: str, dial_freq: int, mode: str, snr: float,
        confidence: float, bandwidth: int, dx_callsign: str, dx_country: str,
    ) -> bool:
        if dial_freq <= 0:
            return False
        if snr < self.min_snr or confidence < self.min_confidence:
            return False

        key = (band, dial_freq)
        now = time.time()

        with self._lock:
            existing = self._targets.get(key)
            if existing is not None:
                existing.last_seen = now
                existing.snr = snr
                existing.confidence = confidence
                if dx_callsign:
                    existing.dx_callsign = dx_callsign
                    existing.dx_country = dx_country
                return False

            self._targets[key] = Target(
                band=band,
                dial_freq=dial_freq,
                mode=(mode or "USB").lower(),
                snr=snr,
                confidence=confidence,
                bandwidth=bandwidth,
                dx_callsign=dx_callsign,
                dx_country=dx_country,
            )
            return True

    # -- Query --------------------------------------------------------------

    def _expire(self) -> None:
        cutoff = time.time() - self.expiry
        dead = [k for k, t in self._targets.items() if t.last_seen < cutoff]
        for key in dead:
            del self._targets[key]

    def next_target(self, exclude: Optional[Tuple[str, int]] = None) -> Optional[Target]:
        """Highest-priority target, or None if nothing is active."""
        with self._lock:
            self._expire()
            candidates = [
                t for t in self._targets.values()
                if exclude is None or t.key != exclude
            ]
            if not candidates:
                return None
            return max(candidates, key=lambda t: t.priority())

    def mark_visited(self, target: Target, callsigns_found: int = 0) -> None:
        with self._lock:
            live = self._targets.get(target.key)
            if live is not None:
                live.last_visited = time.time()
                live.visits += 1
                live.callsigns_found += callsigns_found

    def snapshot(self) -> List[Target]:
        with self._lock:
            self._expire()
            return sorted(
                self._targets.values(), key=lambda t: t.priority(), reverse=True
            )

    def __len__(self) -> int:
        with self._lock:
            return len(self._targets)
