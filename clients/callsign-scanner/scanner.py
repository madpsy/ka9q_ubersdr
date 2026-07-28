#!/usr/bin/env python3
"""
UberSDR callsign scanner — proof of concept.

Hops around detected voice activity, feeds each frequency to the Whisper
speech-to-text extension, extracts candidate callsigns from the transcript, and
validates each one against QRZ via /api/lookup.

    python3 scanner.py --host localhost --port 8080

Run it on the SDR host or LAN: those IPs are in server.timeout_bypass_ips by
default, which exempts the session from max_session_time and removes the 10/min
lookup rate limit.

Output is a JSONL log — one record per detection, with the raw transcript that
produced it. That file is the actual deliverable of the PoC: it tells you what
Whisper really produces on live SSB and how much of it survives validation.
"""

import argparse
import json
import logging
import queue
import signal
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional

from activity import ActivityTracker, Target
from lookup import CallsignValidator, LookupResult
from phonetics import (
    Candidate,
    extract_callsigns,
    is_lookupable,
    normalise_callsign,
)
from ubersdr import Segment, UberSDRSession

log = logging.getLogger("scanner")

# Primes Whisper for on-air phonetics. Without this it renders "mike mike three"
# as prose and drifts toward conversational English; with it, spelled-out
# callsigns survive far more often. Kept under the 1024-byte server cap.
DEFAULT_PROMPT = (
    "Amateur radio HF single sideband contact. Operators exchange callsigns "
    "spelled in the NATO phonetic alphabet: alpha bravo charlie delta echo "
    "foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec "
    "romeo sierra tango uniform victor whiskey xray yankee zulu, with digits "
    "zero one two three four five six seven eight nine. Typical speech: "
    "CQ CQ CQ this is mike mike three november delta hotel calling CQ and "
    "standing by. Roger, your signal report is five nine, QTH, QSL, seventy "
    "three, over to you."
)


@dataclass
class Detection:
    """One validated (or rejected) callsign detection, written to the log."""

    time: str
    timestamp: float
    band: str
    frequency: int
    mode: str
    snr: float
    activity_confidence: float
    raw_text: str
    candidate: str
    normalised: str
    source: str
    extract_confidence: float
    strict_tokens: int
    cued: bool
    validated: bool
    lookup_checked: bool
    lookup_summary: str
    name: str = ""
    country: str = ""
    dx_spot: str = ""
    agrees_with_dx_spot: bool = False


class CallsignScanner:
    def __init__(self, args):
        self.args = args
        self.base_url = (
            f"{'https' if args.ssl else 'http'}://{args.host}:{args.port}"
        )

        self.segments: "queue.Queue[Segment]" = queue.Queue()
        self.tracker = ActivityTracker(
            base_url=self.base_url,
            band=args.band,
            min_snr=args.min_snr,
            min_confidence=args.min_confidence,
        )
        self.session: Optional[UberSDRSession] = None
        self.validator: Optional[CallsignValidator] = None

        self._running = True
        self._current: Optional[Target] = None
        self._log_file = None

        self.stats = {
            "dwells": 0,
            "segments": 0,
            "candidates": 0,
            "malformed": 0,
            "validated": 0,
            "rejected": 0,
            "dx_agreements": 0,
        }
        self.confirmed: Dict[str, Detection] = {}

    # -- Setup --------------------------------------------------------------

    def start(self) -> bool:
        if self.args.output:
            self._log_file = open(self.args.output, "a", encoding="utf-8")
            log.info("Logging detections to %s", self.args.output)

        self.tracker.start()

        # Wait briefly for something to point at before opening the session, so
        # the first tune is not an arbitrary frequency.
        deadline = time.time() + 20
        while time.time() < deadline and len(self.tracker) == 0 and self._running:
            time.sleep(1.0)

        first = self.tracker.next_target()
        freq = first.dial_freq if first else 14200000
        mode = first.mode if first else "usb"
        if first is None:
            log.warning(
                "No voice activity reported yet — starting on %.3f MHz and "
                "waiting for the stream", freq / 1e6,
            )

        self.session = UberSDRSession(
            host=self.args.host,
            port=self.args.port,
            use_ssl=self.args.ssl,
            password=self.args.password,
            frequency=freq,
            mode=mode,
            on_segment=self.segments.put,
            on_error=self._on_session_error,
        )

        if not self.session.start():
            log.error("Could not establish the audio session")
            return False

        self.validator = CallsignValidator(
            base_url=self.base_url,
            session_uuid=self.session.user_session_id,
            min_interval=self.args.lookup_interval,
            prefilter=not self.args.no_prefilter,
        )

        attach_kwargs = {}
        if not self.args.stock_whisper:
            attach_kwargs = {
                "initial_prompt": self.args.prompt,
                "task": "transcribe",
                "asr_language": self.args.asr_language,
            }

        if not self.session.attach_whisper(**attach_kwargs):
            if attach_kwargs:
                log.error(
                    "Whisper attach failed. If the server reported that per-attach "
                    "recognition parameters are disabled, set "
                    "whisper.allow_client_params: true in config.yaml, or rerun "
                    "with --stock-whisper."
                )
            else:
                log.error("Whisper attach failed (is whisper.enabled set?)")
            return False

        return True

    def _on_session_error(self, message: str) -> None:
        if "kicked" in message.lower() or "audio session" in message.lower():
            log.error("Session lost: %s", message)
            self._running = False

    # -- Main loop ----------------------------------------------------------

    def run(self) -> None:
        keepalive = time.time()

        while self._running:
            target = self.tracker.next_target()
            if target is None:
                log.info("No active voice targets; waiting")
                if not self._sleep(10.0):
                    break
                continue

            self._dwell(target)

            if time.time() - keepalive > 30:
                self.session.ping()
                keepalive = time.time()

    def _dwell(self, target: Target) -> None:
        """Tune to a target, listen, and process whatever Whisper returns."""
        self._current = target
        log.info(
            "→ %s %.3f MHz %s (SNR %.1f dB, conf %.2f)%s",
            target.band, target.dial_freq / 1e6, target.mode.upper(),
            target.snr, target.confidence,
            f" [DX spot: {target.dx_callsign}]" if target.dx_callsign else "",
        )

        if not self.session.tune(target.dial_freq, target.mode):
            log.warning("Tune failed; skipping")
            return

        # Drop stale audio and clear Whisper's dedup history, otherwise a
        # repeated phrase on this frequency is suppressed as a duplicate of the
        # previous one.
        self._drain_segments()
        self.session.reset_transcript()

        self.stats["dwells"] += 1
        found = 0
        deadline = time.time() + self.args.dwell
        extended = False

        while time.time() < deadline and self._running:
            try:
                segment = self.segments.get(timeout=1.0)
            except queue.Empty:
                continue

            self.stats["segments"] += 1
            if self.args.verbose:
                marker = "✓" if segment.completed else "…"
                log.info("   %s %s", marker, segment.text)

            # Only mine completed segments: incomplete ones are re-sent as they
            # grow and would produce the same candidate repeatedly.
            if not segment.completed:
                continue

            detections = self._process(segment, target)
            found += sum(1 for d in detections if d.validated)

            # Something callsign-shaped turned up — stay a little longer, since
            # exchanges cluster around the start and end of an over.
            if detections and not extended:
                deadline += self.args.dwell_extension
                extended = True

        self.tracker.mark_visited(target, callsigns_found=found)

    def _drain_segments(self) -> None:
        while True:
            try:
                self.segments.get_nowait()
            except queue.Empty:
                return

    # -- Extraction and validation -----------------------------------------

    def _process(self, segment: Segment, target: Target) -> List[Detection]:
        candidates = extract_callsigns(segment.text)
        if not candidates:
            return []

        detections: List[Detection] = []
        for cand in candidates[: self.args.max_candidates]:
            if cand.confidence < self.args.min_extract_confidence:
                continue

            self.stats["candidates"] += 1
            normalised = normalise_callsign(cand.callsign)

            # Re-check the shape after normalisation — stripping a prefix
            # overlay can leave something that is no longer a callsign, and the
            # server would reject it with a 400 anyway.
            if not is_lookupable(normalised):
                self.stats["malformed"] += 1
                if self.args.verbose:
                    log.info("   – %s → %s, not lookupable", cand.callsign, normalised)
                continue

            # QRZ is the arbiter. The extractor will invent callsign-shaped
            # strings out of ordinary speech; only a real registry lookup can
            # tell those apart from genuine stations.
            result = self.validator.validate(normalised)
            detection = self._build_detection(
                segment, target, cand, normalised, result
            )

            if result.valid:
                self.stats["validated"] += 1
                if detection.agrees_with_dx_spot:
                    self.stats["dx_agreements"] += 1
                    log.info(
                        "   ✓✓ %s — %s [matches DX spot]",
                        normalised, result.summary,
                    )
                else:
                    log.info("   ✓ %s — %s", normalised, result.summary)
                self.confirmed[normalised] = detection
            elif result.checked:
                self.stats["rejected"] += 1
                if self.args.verbose:
                    log.info("   ✗ %s — not in QRZ", normalised)
            elif self.args.verbose:
                log.info("   ? %s — %s", normalised, result.error)

            detections.append(detection)
            self._write(detection)

        return detections

    def _build_detection(
        self, segment: Segment, target: Target,
        cand: Candidate, normalised: str, result: LookupResult,
    ) -> Detection:
        agrees = bool(
            target.dx_callsign
            and normalise_callsign(target.dx_callsign) == normalised
        )
        return Detection(
            time=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            timestamp=time.time(),
            band=target.band,
            frequency=target.dial_freq,
            mode=target.mode,
            snr=target.snr,
            activity_confidence=target.confidence,
            raw_text=segment.text,
            candidate=cand.callsign,
            normalised=normalised,
            source=cand.source,
            extract_confidence=round(cand.confidence, 3),
            strict_tokens=cand.strict_tokens,
            cued=cand.cued,
            validated=result.valid,
            lookup_checked=result.checked,
            lookup_summary=result.summary,
            name=result.name,
            country=result.country,
            dx_spot=target.dx_callsign,
            agrees_with_dx_spot=agrees,
        )

    def _write(self, detection: Detection) -> None:
        if self._log_file is None:
            return
        self._log_file.write(json.dumps(asdict(detection)) + "\n")
        self._log_file.flush()

    # -- Shutdown -----------------------------------------------------------

    def _sleep(self, seconds: float) -> bool:
        """Interruptible sleep. Returns False if we should stop."""
        end = time.time() + seconds
        while time.time() < end:
            if not self._running:
                return False
            time.sleep(0.25)
        return self._running

    def stop(self) -> None:
        self._running = False

    def shutdown(self) -> None:
        log.info("Shutting down")
        self.tracker.stop()
        if self.session is not None:
            try:
                self.session.detach_whisper()
                time.sleep(0.4)
            except Exception:
                pass
            self.session.stop()
        if self._log_file is not None:
            self._log_file.close()

    def report(self) -> None:
        print("\n" + "=" * 68)
        print("Scan summary")
        print("=" * 68)
        print(f"  Dwells:               {self.stats['dwells']}")
        print(f"  Segments transcribed: {self.stats['segments']}")
        print(f"  Candidates extracted: {self.stats['candidates']}")
        print(f"  Dropped (malformed):  {self.stats['malformed']}")
        print(f"  Validated by QRZ:     {self.stats['validated']}")
        print(f"  Rejected by QRZ:      {self.stats['rejected']}")
        print(f"  Matched a DX spot:    {self.stats['dx_agreements']}")

        if self.validator is not None:
            stats = self.validator.stats
            print(
                f"  Lookups: {stats['misses']} sent, {stats['hits']} cached, "
                f"{stats['prefiltered']} prefiltered, {stats['errors']} failed"
            )

        if self.confirmed:
            print(f"\nConfirmed callsigns ({len(self.confirmed)}):")
            for call, det in sorted(self.confirmed.items()):
                flag = " [DX]" if det.agrees_with_dx_spot else ""
                where = f"{det.frequency / 1e6:.3f} MHz {det.band}"
                who = det.name or det.country or ""
                print(f"  {call:<10} {where:<20} {who}{flag}")
        else:
            print("\nNo callsigns confirmed.")
        print()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Scan UberSDR voice activity and extract callsigns via Whisper",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    conn = parser.add_argument_group("connection")
    conn.add_argument("--host", default="localhost", help="UberSDR host")
    conn.add_argument("--port", type=int, default=8080, help="UberSDR port")
    conn.add_argument("--ssl", action="store_true", help="Use https/wss")
    conn.add_argument("--password", help="Bypass password, if the instance needs one")

    scan = parser.add_argument_group("scanning")
    scan.add_argument("--band", help="Restrict to one band, e.g. 20m")
    scan.add_argument("--dwell", type=float, default=45.0,
                      help="Seconds to listen on each frequency")
    scan.add_argument("--dwell-extension", type=float, default=30.0,
                      help="Extra seconds once something callsign-shaped is heard")
    scan.add_argument("--min-snr", type=float, default=8.0,
                      help="Ignore activity below this SNR")
    scan.add_argument("--min-confidence", type=float, default=0.7,
                      help="Ignore activity below this detector confidence")

    extract = parser.add_argument_group("extraction")
    extract.add_argument("--min-extract-confidence", type=float, default=0.4,
                         help="Discard candidates below this heuristic confidence")
    extract.add_argument("--max-candidates", type=int, default=3,
                         help="Most candidates to validate per segment")
    extract.add_argument("--lookup-interval", type=float, default=0.0,
                         help="Min seconds between QRZ lookups (use 6.0 if not "
                              "running from a bypassed IP)")
    extract.add_argument("--no-prefilter", action="store_true",
                         help="Skip the free CTY unallocated-prefix filter and "
                              "send every candidate straight to QRZ")

    whisper = parser.add_argument_group("whisper")
    whisper.add_argument("--prompt", default=DEFAULT_PROMPT,
                         help="Whisper initial prompt (max 1024 bytes)")
    whisper.add_argument("--asr-language", default="en",
                         help="Recognition language")
    whisper.add_argument("--stock-whisper", action="store_true",
                         help="Do not send per-attach recognition parameters. "
                              "Required against a server without "
                              "whisper.allow_client_params enabled.")

    out = parser.add_argument_group("output")
    out.add_argument("--output", default="detections.jsonl",
                     help="JSONL detection log ('' to disable)")
    out.add_argument("-v", "--verbose", action="store_true",
                     help="Log every transcript segment and rejection")

    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("websocket").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    if len(args.prompt.encode("utf-8")) > 1024:
        log.error("--prompt exceeds the server's 1024-byte cap")
        return 2

    scanner = CallsignScanner(args)

    def handle_signal(signum, frame):
        log.info("Interrupted")
        scanner.stop()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        if not scanner.start():
            scanner.shutdown()
            return 1
        scanner.run()
    finally:
        scanner.shutdown()
        scanner.report()

    return 0


if __name__ == "__main__":
    sys.exit(main())
