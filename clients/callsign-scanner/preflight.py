"""
Pre-flight checks against a target instance.

Run before a scan to find out whether the instance can support one, and which
flags you will need. Every failure mode here produced a confusing error during
development, so each check reports the fix rather than just the symptom.
"""

import uuid as uuidlib
from typing import List, Tuple

import requests

OK = "OK  "
WARN = "WARN"
FAIL = "FAIL"


def _get(base_url: str, path: str, **kw):
    return requests.get(f"{base_url}{path}", timeout=10, **kw)


def run_preflight(base_url: str, password: str = "") -> Tuple[bool, List[str]]:
    """
    Check an instance. Returns (usable, lines_to_print).

    "Usable" means a scan can run at all — warnings still allow it, with
    reduced capability.
    """
    base_url = base_url.rstrip("/")
    lines: List[str] = []
    fatal = False
    suggested: List[str] = []

    # -- Reachability and feature flags ------------------------------------
    try:
        desc = _get(base_url, "/api/description").json()
    except (requests.RequestException, ValueError) as exc:
        return False, [f"{FAIL}  Cannot reach {base_url}/api/description: {exc}"]

    lines.append(f"{OK}  Instance reachable — UberSDR {desc.get('version', '?')}")

    if desc.get("speech_to_text"):
        lines.append(f"{OK}  Speech-to-text enabled")
    else:
        lines.append(
            f"{FAIL}  Speech-to-text disabled — set whisper.enabled: true "
            "and point whisper.server_url at a WhisperLive server"
        )
        fatal = True

    if desc.get("lookup_service"):
        lines.append(f"{OK}  Lookup service enabled")
    else:
        lines.append(
            f"{FAIL}  Lookup service disabled — set lookup_services.enabled: true. "
            "Without QRZ there is nothing to validate against."
        )
        fatal = True

    if desc.get("noise_floor"):
        lines.append(f"{OK}  Noise floor monitoring enabled")
    else:
        lines.append(
            f"{FAIL}  Noise floor monitoring disabled — no voice activity "
            "detection, so the scanner has nothing to hop between"
        )
        fatal = True

    # -- Live targets ------------------------------------------------------
    try:
        activity = _get(
            base_url, "/api/noisefloor/voice-activity/all",
            params={"min_confidence": "0.7"},
        ).json()
        total = activity.get("total_activities", 0)
        bands = len(activity.get("bands") or {})
        if total:
            lines.append(f"{OK}  {total} voice signals active across {bands} band(s)")
        else:
            lines.append(
                f"{WARN}  No voice activity right now — the scanner will wait. "
                "Try again when the bands are open."
            )
    except (requests.RequestException, ValueError) as exc:
        lines.append(f"{WARN}  Could not read voice activity: {exc}")

    # -- Session registration, limits, bypass ------------------------------
    probe_uuid = str(uuidlib.uuid4())
    try:
        payload = {"user_session_id": probe_uuid}
        if password:
            payload["password"] = password
        conn = requests.post(
            f"{base_url}/connection", json=payload, timeout=10
        ).json()
    except (requests.RequestException, ValueError) as exc:
        lines.append(f"{FAIL}  /connection failed: {exc}")
        return False, lines

    if not conn.get("allowed"):
        lines.append(f"{FAIL}  Connection refused: {conn.get('reason', 'unknown')}")
        return False, lines

    bypassed = bool(conn.get("bypassed"))
    max_time = int(conn.get("max_session_time") or 0)

    if bypassed:
        lines.append(
            f"{OK}  Bypassed IP — no lookup rate limit, no session time cap"
        )
    else:
        lines.append(
            f"{WARN}  Not a bypassed IP — QRZ lookups limited to 10/min"
        )
        suggested.append("--lookup-interval 6.0")
        if max_time:
            lines.append(
                f"{WARN}  Session ends after {max_time}s "
                f"({max_time // 60} min); the scan stops there"
            )

    # -- CTY pre-filter ----------------------------------------------------
    try:
        cty = _get(base_url, "/api/cty/lookup", params={"callsign": "W1AW"})
        if cty.status_code == 200:
            lines.append(f"{OK}  CTY available — free unallocated-prefix filter active")
        else:
            lines.append(
                f"{WARN}  CTY unavailable (HTTP {cty.status_code}) — every "
                "candidate will go to QRZ instead"
            )
    except requests.RequestException:
        lines.append(f"{WARN}  CTY unreachable — every candidate will go to QRZ")

    # -- Per-attach recognition parameters ---------------------------------
    # There is no flag for this in /api/description, so infer from version and
    # let the attach itself be the real test.
    lines.append(
        f"{WARN}  Cannot detect whisper.allow_client_params remotely. If the "
        "attach is rejected, rerun with --stock-whisper."
    )

    if suggested:
        lines.append("")
        lines.append(f"Suggested flags: {' '.join(suggested)}")

    return not fatal, lines
