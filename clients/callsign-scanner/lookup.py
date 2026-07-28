"""
Callsign validation via the UberSDR QRZ lookup endpoint.

GET /api/lookup?callsign=<call>&uuid=<user_session_id>

This is the only real validation available. It is a genuine callsign lookup: a
200 means QRZ holds a record for that exact callsign, i.e. it is a licensed
station that actually exists. A 404 means no such callsign — which is precisely
what we need to throw out the fabrications the phonetic extractor will inevitably
produce from noise.

/api/cty/lookup is used only as a *negative* pre-filter, never as validation.
CTY is a prefix-to-DXCC map resolved by longest-prefix match, so it returns
"United Kingdom" for G4ZZZZ whether or not such a station is licensed — a hit
proves nothing. A miss, however, means the prefix is not allocated to any DXCC
entity, so the callsign cannot be real, and we can discard it without spending a
QRZ request. That endpoint needs no auth and has no rate limit, so the filter is
free. Anything surviving it still has to be confirmed by QRZ.

Auth: the `uuid` must be a user_session_id with a live *audio* session — the
same UUID the scanner already holds for its Whisper attach. Rate limit is 10/min
per UUID, but bypassed IPs (localhost and RFC1918 by default, see
server.timeout_bypass_ips) are exempt, so running the scanner on the SDR host or
LAN removes the limit. Cache hits are granted 10x the rate regardless.
"""

import logging
import threading
import time
from dataclasses import dataclass
from typing import Dict, Optional

import requests

log = logging.getLogger(__name__)


@dataclass
class LookupResult:
    """Outcome of validating one callsign."""

    callsign: str
    valid: bool                      # True only on a confirmed QRZ record
    checked: bool                    # False if we never got a definitive answer
    name: str = ""
    country: str = ""
    continent: str = ""
    grid: str = ""
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    error: str = ""

    @property
    def summary(self) -> str:
        if not self.checked:
            return f"unverified ({self.error})"
        if not self.valid:
            return "not found in QRZ"
        bits = [b for b in (self.name, self.country) if b]
        return " — ".join(bits) if bits else "found"


class CallsignValidator:
    """Validates callsigns against QRZ, with a local cache and backoff."""

    def __init__(
        self,
        base_url: str,
        session_uuid: str,
        timeout: float = 8.0,
        min_interval: float = 0.0,
        prefilter: bool = True,
    ):
        """
        Args:
            base_url:     http(s)://host:port of the UberSDR instance
            session_uuid: user_session_id with a live audio session
            timeout:      per-request timeout in seconds
            min_interval: minimum seconds between outbound lookups. Leave at 0
                          on a bypassed IP; set ~6.0 to stay inside the default
                          10/min limit when running remotely.
            prefilter:    discard callsigns whose prefix matches no DXCC entity
                          before spending a QRZ request (negative filter only)
        """
        self.base_url = base_url.rstrip("/")
        self.session_uuid = session_uuid
        self.timeout = timeout
        self.min_interval = min_interval
        self.prefilter = prefilter

        self._cache: Dict[str, LookupResult] = {}
        self._prefix_cache: Dict[str, bool] = {}
        self._lock = threading.Lock()
        self._last_request = 0.0
        self._http = requests.Session()

        self.stats = {
            "hits": 0, "misses": 0, "valid": 0,
            "not_found": 0, "errors": 0, "prefiltered": 0,
        }

    def set_session_uuid(self, session_uuid: str) -> None:
        """Point at a new session UUID after the audio session was rebuilt."""
        with self._lock:
            self.session_uuid = session_uuid

    def _throttle(self) -> None:
        if self.min_interval <= 0:
            return
        with self._lock:
            elapsed = time.time() - self._last_request
            wait = self.min_interval - elapsed
            if wait > 0:
                time.sleep(wait)
            self._last_request = time.time()

    def validate(self, callsign: str) -> LookupResult:
        """
        Look up one callsign. Cached, so repeated hits on the same station
        during a dwell cost nothing.
        """
        callsign = callsign.upper().strip()

        with self._lock:
            cached = self._cache.get(callsign)
        if cached is not None:
            self.stats["hits"] += 1
            return cached

        # Free negative filter: a prefix belonging to no DXCC entity cannot be a
        # real callsign. Saves a QRZ request on the extractor's worst output.
        if self.prefilter and not self._prefix_plausible(callsign):
            self.stats["prefiltered"] += 1
            result = LookupResult(
                callsign, valid=False, checked=True,
                error="prefix not allocated to any DXCC entity",
            )
            with self._lock:
                self._cache[callsign] = result
            return result

        self.stats["misses"] += 1
        result = self._fetch(callsign)

        # Cache definitive answers only. A transport error or rate-limit refusal
        # is not evidence about the callsign, so leave it retryable.
        if result.checked:
            with self._lock:
                self._cache[callsign] = result

        return result

    def _prefix_plausible(self, callsign: str) -> bool:
        """
        True unless CTY can positively tell us the prefix is unallocated.

        Negative evidence only — a CTY hit says nothing about whether the
        station exists. On any error we return True, so a CTY outage degrades
        into "send it to QRZ anyway" rather than silently dropping real
        callsigns.
        """
        with self._lock:
            cached = self._prefix_cache.get(callsign)
        if cached is not None:
            return cached

        try:
            resp = self._http.get(
                f"{self.base_url}/api/cty/lookup",
                params={"callsign": callsign},
                timeout=self.timeout,
            )
        except requests.RequestException:
            return True

        if resp.status_code == 404:
            plausible = False
        elif resp.status_code == 200:
            plausible = True
        else:
            # Including 503 when the CTY database is not loaded.
            return True

        with self._lock:
            self._prefix_cache[callsign] = plausible
        return plausible

    def _fetch(self, callsign: str) -> LookupResult:
        self._throttle()

        try:
            resp = self._http.get(
                f"{self.base_url}/api/lookup",
                params={"callsign": callsign, "uuid": self.session_uuid},
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            self.stats["errors"] += 1
            return LookupResult(callsign, valid=False, checked=False, error=str(exc))

        if resp.status_code == 200:
            self.stats["valid"] += 1
            try:
                data = resp.json()
            except ValueError:
                return LookupResult(
                    callsign, valid=False, checked=False, error="malformed JSON"
                )
            return self._parse(callsign, data)

        if resp.status_code == 404:
            # Definitive: QRZ has no such callsign.
            self.stats["not_found"] += 1
            return LookupResult(callsign, valid=False, checked=True)

        if resp.status_code == 429:
            self.stats["errors"] += 1
            log.warning(
                "Lookup rate limited on %s — raise --lookup-interval, or run from "
                "a bypassed IP (localhost/RFC1918) for unlimited lookups",
                callsign,
            )
            return LookupResult(
                callsign, valid=False, checked=False, error="rate limited"
            )

        if resp.status_code == 401:
            self.stats["errors"] += 1
            log.error(
                "Lookup rejected: no active audio session for uuid %s. The audio "
                "session likely dropped (max_session_time?) and must be rebuilt.",
                self.session_uuid,
            )
            return LookupResult(
                callsign, valid=False, checked=False, error="no active audio session"
            )

        if resp.status_code == 503:
            self.stats["errors"] += 1
            return LookupResult(
                callsign,
                valid=False,
                checked=False,
                error="lookup service disabled on this instance",
            )

        self.stats["errors"] += 1
        detail = ""
        try:
            detail = resp.json().get("error", "")
        except ValueError:
            detail = resp.text[:120]
        return LookupResult(
            callsign, valid=False, checked=False, error=f"HTTP {resp.status_code}: {detail}"
        )

    @staticmethod
    def _parse(callsign: str, data: dict) -> LookupResult:
        cty = data.get("cty") or {}

        def pick(*keys):
            for key in keys:
                value = data.get(key)
                if value:
                    return value
            return ""

        lat = data.get("lat") or cty.get("latitude")
        lon = data.get("lon") or cty.get("longitude")

        return LookupResult(
            callsign=callsign,
            valid=True,
            checked=True,
            name=pick("name", "fname", "callsign_name"),
            country=pick("country") or cty.get("country", ""),
            continent=cty.get("continent", ""),
            grid=pick("grid", "locator"),
            latitude=float(lat) if isinstance(lat, (int, float)) else None,
            longitude=float(lon) if isinstance(lon, (int, float)) else None,
        )
