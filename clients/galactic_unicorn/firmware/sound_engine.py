# Galactic Unicorn Sound Engine — sound_engine.py
# Non-blocking async tone sequencer for alert sounds.
#
# Runs as an independent asyncio task alongside the display engine.
# Sound playback never blocks HTTP request handling or display rendering.
#
# Confirmed Pimoroni audio API (tested on device):
#   ch = gu.synth_channel(n)            — get synth channel 0–7
#   ch.configure(waveforms=ch.SQUARE,   — configure ADSR envelope
#                attack, decay, sustain, release, volume)
#   ch.frequency(freq)                  — set frequency (Hz)
#   ch.volume(vol)                      — set per-channel volume 0.0–1.0
#   ch.trigger_attack()                 — start note
#   ch.trigger_release()                — end note (begin release phase)
#   gu.play_synth()                     — start synth audio output (REQUIRED)
#   gu.stop_playing()                   — stop all audio output
#   gu.set_volume(v)                    — master hardware volume 0.0–1.0
#
# API:
#   engine = SoundEngine(gu)
#   engine.play(request)    — enqueue a SoundRequest (called from HTTP handler)
#   engine.stop()           — immediately stop playback and clear queue
#   engine.set_volume(v)    — set hardware volume (0.0–1.0)
#   engine.get_volume()     — return current volume
#   await engine.run()      — main loop (run as asyncio task)
#
# Sound request dict fields:
#   pattern  : str  — named pattern (see PATTERNS below), or "custom" / "tone"
#   notes    : list — [{freq, duration, volume?}] for custom sequences
#   frequency: int  — Hz for single-tone patterns (default 880)
#   duration : float— seconds for "tone" pattern (default 0.2)
#   volume   : float— 0.0–1.0 override for this request (default: engine volume)
#   repeats  : int  — how many times to repeat the pattern (default 1)
#   gap      : float— seconds of silence between repeats (default 0.1)

import uasyncio as asyncio

# ---------------------------------------------------------------------------
# Named alert patterns
# Each pattern is a list of (frequency_hz, duration_s) tuples.
# frequency=0 means silence (gap between notes).
# ---------------------------------------------------------------------------

PATTERNS = {
    # ── Core semantic alerts (modern UI sound design) ────────────────────────
    #
    # "alert"    — generic attention: clean rising perfect-4th (C5→F5), bright
    # "warning"  — caution: minor-3rd drop (A4→F#4) with a short repeat, tense
    # "error"    — failure: descending tritone (B4→F4), clearly negative
    # "recovery" — resolved/back-to-normal: ascending major triad (C5→E5→G5)
    # "success"  — task complete: quick rising major-3rd then octave (G4→B4→G5)
    # "critical" — urgent: rapid alternating minor-2nd (high/low), very insistent
    #
    # All patterns stay in the 400–1200 Hz range for speaker comfort.
    # Durations are short (≤0.35 s total) so they don't overstay their welcome.

    # Generic attention — two rising tones, clean and modern
    "alert":        [(523, 0.10), (0, 0.04), (698, 0.18)],    # C5 → F5 (perfect 4th)

    # Caution — minor-3rd drop, repeated once: "hmm, check this"
    "warning":      [(880, 0.12), (0, 0.05), (740, 0.12), (0, 0.05), (880, 0.08)],  # A5→F#5→A5

    # Failure — descending tritone: unmistakably wrong
    "error":        [(494, 0.15), (0, 0.04), (370, 0.28)],    # B4 → F#4 (tritone-ish)

    # Recovery / resolved — ascending major triad: "all clear"
    "recovery":     [(523, 0.08), (0, 0.03), (659, 0.08), (0, 0.03), (784, 0.20)],  # C5→E5→G5

    # Success / complete — quick rise then bright high note
    "success":      [(392, 0.07), (0, 0.03), (494, 0.07), (0, 0.03), (784, 0.22)],  # G4→B4→G5

    # Critical / urgent — rapid high/low alternation (4 pairs), very insistent
    "critical":     [(1047, 0.07), (0, 0.04), (784, 0.07), (0, 0.04),
                     (1047, 0.07), (0, 0.04), (784, 0.07), (0, 0.04),
                     (1047, 0.07), (0, 0.04), (784, 0.07)],   # C6/G5 alternating

    # ── Simple utility beeps ─────────────────────────────────────────────────
    "beep":         [(880, 0.12)],                              # standard single beep
    "beep_low":     [(440, 0.15)],                              # lower, softer
    "beep_high":    [(1175, 0.08)],                             # high, brief
    "double_beep":  [(880, 0.09), (0, 0.06), (880, 0.09)],
    "triple_beep":  [(880, 0.08), (0, 0.05), (880, 0.08), (0, 0.05), (880, 0.08)],

    # ── Informational / ambient ──────────────────────────────────────────────
    # Soft two-note rising chime — new notification
    "notify":       [(523, 0.07), (0, 0.04), (784, 0.14)],    # C5 → G5 (perfect 5th)

    # Very short tick — subtle UI feedback
    "tick":         [(1047, 0.025)],

    # Three-note ascending chime — pleasant, non-urgent
    "chime":        [(523, 0.12), (0, 0.04), (659, 0.12), (0, 0.04), (784, 0.22)],  # C→E→G

    # Alarm — rapid 4-pulse, urgent but not as harsh as critical
    "alarm":        [(1047, 0.07), (0, 0.05), (1047, 0.07), (0, 0.05),
                     (1047, 0.07), (0, 0.05), (1047, 0.07)],

    # ── Radio / ham specific ─────────────────────────────────────────────────
    # New DX spot — quick rising two-tone
    "spot":         [(659, 0.07), (0, 0.04), (880, 0.14)],    # E5 → A5

    # DX alert — three-note rising, more emphatic
    "dx":           [(659, 0.08), (0, 0.04), (784, 0.08), (0, 0.04), (1047, 0.20)],  # E5→G5→C6

    # QSO start — gentle two-note
    "qso":          [(523, 0.10), (0, 0.04), (659, 0.14)],    # C5 → E5
}

# Maximum notes in a custom sequence (memory guard on MicroPython)
MAX_CUSTOM_NOTES = 64

# Maximum repeats
MAX_REPEATS = 20

# Synth channel to use (0–7 available on Galactic Unicorn)
SYNTH_CHANNEL = 0


# ---------------------------------------------------------------------------
# SoundRequest — validated, ready-to-play sound
# ---------------------------------------------------------------------------

class SoundRequest:
    """Parsed and validated sound request."""

    def __init__(self, raw):
        """Parse raw dict. Raises ValueError on invalid input."""
        self.pattern = raw.get("pattern", "beep")
        self.volume = raw.get("volume")   # None = use engine default
        if self.volume is not None:
            self.volume = float(self.volume)
            if not (0.0 <= self.volume <= 1.0):
                raise ValueError("volume must be 0.0–1.0")

        self.repeats = int(raw.get("repeats", 1))
        if not (1 <= self.repeats <= MAX_REPEATS):
            raise ValueError(f"repeats must be 1–{MAX_REPEATS}")

        self.gap = float(raw.get("gap", 0.1))
        if self.gap < 0.0:
            raise ValueError("gap must be >= 0")

        # Build the note sequence
        if self.pattern == "custom":
            notes_raw = raw.get("notes")
            if not notes_raw or not isinstance(notes_raw, list):
                raise ValueError("'notes' array required for pattern 'custom'")
            if len(notes_raw) > MAX_CUSTOM_NOTES:
                raise ValueError(f"notes array exceeds maximum of {MAX_CUSTOM_NOTES}")
            self.notes = []
            for i, n in enumerate(notes_raw):
                if not isinstance(n, dict):
                    raise ValueError(f"note {i} must be an object")
                freq = int(n.get("freq", 440))
                dur = float(n.get("duration", 0.1))
                vol = n.get("volume")  # per-note volume override
                if vol is not None:
                    vol = float(vol)
                    if not (0.0 <= vol <= 1.0):
                        raise ValueError(f"note {i} volume must be 0.0–1.0")
                if freq < 0:
                    raise ValueError(f"note {i} freq must be >= 0 (0 = silence)")
                if dur <= 0:
                    raise ValueError(f"note {i} duration must be > 0")
                self.notes.append((freq, dur, vol))

        elif self.pattern == "tone":
            freq = int(raw.get("frequency", 880))
            dur = float(raw.get("duration", 0.2))
            if freq <= 0:
                raise ValueError("frequency must be > 0 for 'tone' pattern")
            if dur <= 0:
                raise ValueError("duration must be > 0 for 'tone' pattern")
            self.notes = [(freq, dur, None)]

        elif self.pattern in PATTERNS:
            # Named pattern — convert (freq, dur) tuples to (freq, dur, None)
            self.notes = [(f, d, None) for f, d in PATTERNS[self.pattern]]

        else:
            valid = ", ".join(sorted(PATTERNS.keys())) + ", tone, custom"
            raise ValueError(f"Unknown pattern '{self.pattern}'. Valid: {valid}")


# ---------------------------------------------------------------------------
# SoundEngine
# ---------------------------------------------------------------------------

class SoundEngine:
    """Non-blocking async sound sequencer.

    Runs as an asyncio task. Sound requests are enqueued from the HTTP handler
    coroutine and played back without blocking display rendering or HTTP serving.

    Uses the Pimoroni GalacticUnicorn synth API:
      gu.synth_channel(n), ch.configure(), ch.frequency(), ch.trigger_attack(),
      ch.trigger_release(), gu.play_synth(), gu.stop_playing()
    """

    def __init__(self, gu, volume=0.5):
        self._gu = gu
        self._volume = max(0.0, min(1.0, volume))
        self._channel = None   # initialised lazily in run() after asyncio starts
        self._synth_running = False  # tracks whether gu.play_synth() is active

        try:
            self._gu.set_volume(self._volume)
        except Exception:
            pass

        self._queue = []
        self._playing = False
        self._stop_flag = False

    # ------------------------------------------------------------------
    # Internal: initialise synth channel
    # ------------------------------------------------------------------

    def _init_channel(self):
        """Initialise the PicoSynth channel. Called once from run()."""
        if self._channel is not None:
            return
        try:
            self._channel = self._gu.synth_channel(SYNTH_CHANNEL)
            # Configure ADSR for a clean beep-like tone:
            # fast attack, no decay, full sustain, short release
            # Note: keyword arg is 'waveforms' (plural), not 'waveform'
            self._channel.configure(
                waveforms=self._channel.SQUARE,
                attack=0.001,
                decay=0.0,
                sustain=1.0,
                release=0.02,
                volume=self._volume,
            )
            print(f"[SoundEngine] Synth channel {SYNTH_CHANNEL} initialised")
        except Exception as e:
            print(f"[SoundEngine] WARNING: could not init synth channel: {e}")
            self._channel = None

    def _start_synth(self):
        """Start the synth audio output if not already running."""
        if not self._synth_running:
            try:
                self._gu.play_synth()
                self._synth_running = True
            except Exception as e:
                print(f"[SoundEngine] play_synth error: {e}")

    def _stop_synth(self):
        """Stop the synth audio output."""
        if self._synth_running:
            try:
                self._gu.stop_playing()
                self._synth_running = False
            except Exception as e:
                print(f"[SoundEngine] stop_playing error: {e}")

    def _play_freq(self, freq, vol):
        """Start playing a frequency on the synth channel."""
        if self._channel is None:
            return
        try:
            self._channel.frequency(freq)
            self._channel.volume(vol)
            self._channel.trigger_attack()
            self._start_synth()
        except Exception as e:
            print(f"[SoundEngine] play_freq error: {e}")

    def _stop_freq(self):
        """Stop the current tone (trigger release phase)."""
        if self._channel is None:
            return
        try:
            self._channel.trigger_release()
        except Exception as e:
            print(f"[SoundEngine] stop_freq error: {e}")

    # ------------------------------------------------------------------
    # Public API (called from HTTP handler / button handler)
    # ------------------------------------------------------------------

    def play(self, request):
        """Enqueue a SoundRequest for playback."""
        self._queue.append(request)

    def stop(self):
        """Immediately stop playback and clear the sound queue."""
        self._queue.clear()
        self._stop_flag = True
        self._stop_freq()
        self._stop_synth()

    def set_volume(self, value):
        """Set hardware volume (0.0–1.0). Persists across requests."""
        self._volume = max(0.0, min(1.0, value))
        try:
            self._gu.set_volume(self._volume)
        except Exception:
            pass
        # Also update channel volume if initialised
        if self._channel is not None:
            try:
                self._channel.volume(self._volume)
            except Exception:
                pass

    def get_volume(self):
        return self._volume

    def status(self):
        """Return a dict describing current sound state."""
        return {
            "playing": self._playing,
            "volume": self._volume,
            "queue_depth": len(self._queue),
        }

    # ------------------------------------------------------------------
    # Main async loop
    # ------------------------------------------------------------------

    async def run(self):
        """Main sound loop. Run as an asyncio task — never blocks."""
        self._init_channel()
        while True:
            if self._queue:
                request = self._queue.pop(0)
                await self._play_request(request)
            else:
                await asyncio.sleep(0.02)

    # ------------------------------------------------------------------
    # Internal playback
    # ------------------------------------------------------------------

    async def _play_request(self, request):
        """Play all repeats of a SoundRequest, yielding between notes."""
        self._playing = True
        self._stop_flag = False

        req_volume = request.volume if request.volume is not None else self._volume

        try:
            for rep in range(request.repeats):
                if self._stop_flag:
                    break

                for freq, dur, note_vol in request.notes:
                    if self._stop_flag:
                        break

                    vol = note_vol if note_vol is not None else req_volume

                    if freq == 0:
                        # Silence: stop tone but keep synth running
                        self._stop_freq()
                    else:
                        self._play_freq(freq, vol)

                    await self._sleep_interruptible(dur)

                # Gap between repeats
                if rep < request.repeats - 1 and not self._stop_flag:
                    self._stop_freq()
                    if request.gap > 0:
                        await self._sleep_interruptible(request.gap)

        finally:
            self._stop_freq()
            # Brief pause to let release phase complete before stopping synth
            await asyncio.sleep(0.05)
            self._stop_synth()
            self._playing = False
            self._stop_flag = False

    async def _sleep_interruptible(self, seconds):
        """Sleep for `seconds` in 20 ms chunks, checking stop_flag each chunk."""
        remaining = seconds
        chunk = 0.02
        while remaining > 0 and not self._stop_flag:
            sleep_for = min(chunk, remaining)
            await asyncio.sleep(sleep_for)
            remaining -= sleep_for
