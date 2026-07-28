"""
Frequency attribution for a continuously-running Whisper stream.

The scanner never tears down the audio session or the Whisper attach — it hops
by retuning in place, so audio flows without interruption for the whole run.
That is the right design, but it means transcript segments cannot simply be
attributed to "wherever we are pointing now".

Whisper is a pipeline. WhisperLive's VAD accumulates up to 15 seconds of speech
(`max_speech_duration_s`) before closing a segment, and transcription adds more
lag on top. So a segment that lands two seconds after a hop is almost always
audio from the *previous* frequency. Naively attributing it to the new target
puts a real callsign on the wrong frequency in the log — worse than missing it,
because it looks like a confident result.

This module keeps a history of tune events and maps each segment back onto the
frequency that was actually tuned while its audio was being captured:

    audio_end   ≈ received_at − pipeline_latency
    audio_start ≈ audio_end − segment_duration

If both ends fall inside the same tune window the attribution is certain. If the
segment straddles a hop it is attributed to whichever frequency covered more of
it, and flagged uncertain so the log can be filtered later.
"""

import threading
import time
from dataclasses import dataclass
from typing import List, Optional, Tuple, TypeVar

T = TypeVar("T")


@dataclass
class TuneEvent:
    """A moment at which the receiver was pointed somewhere new."""

    at: float
    target: object          # activity.Target, kept loose to avoid a cycle
    stream_note: str = ""


@dataclass
class Attribution:
    """Where a segment's audio actually came from."""

    target: Optional[object]
    certain: bool
    audio_start: float
    audio_end: float
    straddled: bool = False
    overlap_fraction: float = 1.0


class FrequencyTimeline:
    """Maps transcript segments back to the frequency that produced them."""

    def __init__(self, pipeline_latency: float = 2.0, history: float = 300.0):
        """
        Args:
            pipeline_latency: estimated seconds between audio being received by
                the server and the resulting segment reaching us. Covers
                WhisperLive's buffering plus inference time.
            history: how long to retain tune events.
        """
        self.pipeline_latency = pipeline_latency
        self.history = history
        self._events: List[TuneEvent] = []
        self._lock = threading.Lock()

    def record(self, target: object, at: Optional[float] = None) -> None:
        """Note that we retuned to `target`."""
        event = TuneEvent(at=at if at is not None else time.time(), target=target)
        with self._lock:
            self._events.append(event)
            cutoff = event.at - self.history
            # Keep one event older than the cutoff so a long segment that began
            # before it can still be resolved.
            keep_from = 0
            for i, ev in enumerate(self._events):
                if ev.at < cutoff:
                    keep_from = i
                else:
                    break
            if keep_from > 0:
                self._events = self._events[keep_from:]

    def _active_at(self, when: float) -> Optional[TuneEvent]:
        """The tune event in force at wall-clock time `when`."""
        active = None
        for event in self._events:
            if event.at <= when:
                active = event
            else:
                break
        return active

    def attribute(
        self, received_at: float, duration: float
    ) -> Attribution:
        """
        Resolve which frequency produced a segment.

        Args:
            received_at: wall clock when the segment arrived
            duration:    length of audio the segment covers, in seconds
        """
        duration = max(duration, 0.0)
        audio_end = received_at - self.pipeline_latency
        audio_start = audio_end - duration

        with self._lock:
            start_event = self._active_at(audio_start)
            end_event = self._active_at(audio_end)

            if start_event is None and end_event is None:
                return Attribution(None, False, audio_start, audio_end)

            # Entirely within one tune window — unambiguous.
            if start_event is end_event and start_event is not None:
                return Attribution(start_event.target, True, audio_start, audio_end)

            # Straddles at least one hop. Attribute to whichever window covered
            # the larger share of the audio.
            if start_event is None:
                return Attribution(
                    end_event.target, False, audio_start, audio_end,
                    straddled=True, overlap_fraction=1.0,
                )

            boundary = end_event.at if end_event is not None else audio_end
            before = max(0.0, boundary - audio_start)
            after = max(0.0, audio_end - boundary)
            total = before + after

            if total <= 0:
                return Attribution(
                    start_event.target, False, audio_start, audio_end, straddled=True
                )

            if before >= after:
                return Attribution(
                    start_event.target, False, audio_start, audio_end,
                    straddled=True, overlap_fraction=before / total,
                )
            return Attribution(
                end_event.target, False, audio_start, audio_end,
                straddled=True, overlap_fraction=after / total,
            )

    def current(self) -> Optional[object]:
        """Whatever we are pointed at right now."""
        with self._lock:
            return self._events[-1].target if self._events else None

    def settled_for(self) -> float:
        """Seconds since the last hop."""
        with self._lock:
            if not self._events:
                return 0.0
            return time.time() - self._events[-1].at
