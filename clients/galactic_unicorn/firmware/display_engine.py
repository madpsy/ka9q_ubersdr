# Galactic Unicorn Display Engine
# Handles all rendering: colour parsing, layout, effects, scroll, queue management.
# Runs as an asyncio task on the Pico W.
#
# Note: the hardware module is named 'galactic' (not 'galactic_unicorn') in
# Pimoroni MicroPython v1.24+. Import it as: from galactic import GalacticUnicorn

import math
import time
import uasyncio as asyncio

# ---------------------------------------------------------------------------
# Display constants
# ---------------------------------------------------------------------------
DISPLAY_WIDTH = 53
DISPLAY_HEIGHT = 11

# Font heights in pixels for each size value.
# The default PicoGraphics font (bitmap6) is a 6×6 pixel font at scale=1.
# Heights scale linearly: 6px, 12px, 18px for scales 1, 2, 3.
# The display is only 11px tall, so scale=2 and scale=3 always clip.
# For layout purposes we cap at DISPLAY_HEIGHT so y="middle" stays on screen.
#
# Two size=1 lines: y=0 (rows 0-5) and y=6 (rows 6-11, bottom row clips by 1px).
# This is the best fit possible and is visually acceptable.
FONT_HEIGHTS = {1: 6, 2: 11, 3: 11}

# Approximate character widths in pixels per font size (PicoGraphics bitmap font)
# The built-in font is proportional; these are conservative averages used for
# layout decisions. Actual pixel width is measured via graphics.measure_text().
FONT_CHAR_WIDTHS = {1: 6, 2: 12, 3: 18}

# ---------------------------------------------------------------------------
# Named colour table  (R, G, B)
# ---------------------------------------------------------------------------
NAMED_COLOURS = {
    "white":   (255, 255, 255),
    "red":     (255,   0,   0),
    "green":   (  0, 255,   0),
    "lime":    (  0, 220,  80),
    "blue":    (  0, 100, 255),
    "cyan":    (  0, 255, 255),
    "yellow":  (255, 255,   0),
    "orange":  (255, 128,   0),
    "amber":   (255, 176,   0),
    "gold":    (255, 215,   0),
    "magenta": (255,   0, 255),
    "purple":  (128,   0, 255),
    "pink":    (255, 100, 150),
    "off":     (  0,   0,   0),
    "black":   (  0,   0,   0),
    "rainbow": None,   # sentinel — handled specially
}


# ---------------------------------------------------------------------------
# Colour parsing
# ---------------------------------------------------------------------------

def parse_color(value):
    """Parse any colour specification into (r, g, b) or a special tag string.

    Returns:
        (r, g, b) tuple for solid colours.
        "rainbow" string for rainbow effect.
        ("gradient", (r1,g1,b1), (r2,g2,b2)) tuple for gradient.
    """
    if value is None:
        return (255, 255, 255)

    # RGB array
    if isinstance(value, (list, tuple)) and len(value) == 3:
        return (int(value[0]), int(value[1]), int(value[2]))

    if not isinstance(value, str):
        return (255, 255, 255)

    v = value.strip().lower()

    # Named colour
    if v in NAMED_COLOURS:
        result = NAMED_COLOURS[v]
        if result is None:
            return "rainbow"
        return result

    # Rainbow shorthand
    if v == "rainbow":
        return "rainbow"

    # Gradient: "gradient:<from>:<to>"
    if v.startswith("gradient:"):
        parts = value[9:].split(":", 1)
        if len(parts) == 2:
            c1 = parse_color(parts[0].strip())
            c2 = parse_color(parts[1].strip())
            if isinstance(c1, tuple) and isinstance(c2, tuple):
                return ("gradient", c1, c2)
        return (255, 255, 255)

    # Hex string: #RRGGBB, RRGGBB, #RGB, RGB
    h = v.lstrip("#")
    if len(h) == 3:
        h = h[0]*2 + h[1]*2 + h[2]*2
    if len(h) == 6:
        try:
            r = int(h[0:2], 16)
            g = int(h[2:4], 16)
            b = int(h[4:6], 16)
            return (r, g, b)
        except ValueError:
            pass

    # Comma-separated r,g,b (used inside gradient spec)
    if "," in v:
        parts = v.split(",")
        if len(parts) == 3:
            try:
                return (int(parts[0]), int(parts[1]), int(parts[2]))
            except ValueError:
                pass

    return (255, 255, 255)


def hsv_to_rgb(h, s, v):
    """Convert HSV (0.0–1.0 each) to (r, g, b) 0–255."""
    if s == 0.0:
        c = int(v * 255)
        return (c, c, c)
    i = int(h * 6.0)
    f = (h * 6.0) - i
    p = v * (1.0 - s)
    q = v * (1.0 - s * f)
    t = v * (1.0 - s * (1.0 - f))
    i = i % 6
    if i == 0: return (int(v*255), int(t*255), int(p*255))
    if i == 1: return (int(q*255), int(v*255), int(p*255))
    if i == 2: return (int(p*255), int(v*255), int(t*255))
    if i == 3: return (int(p*255), int(q*255), int(v*255))
    if i == 4: return (int(t*255), int(p*255), int(v*255))
    if i == 5: return (int(v*255), int(p*255), int(q*255))
    return (0, 0, 0)


def lerp_color(c1, c2, t):
    """Linear interpolate between two (r,g,b) tuples. t in 0.0–1.0."""
    return (
        int(c1[0] + (c2[0] - c1[0]) * t),
        int(c1[1] + (c2[1] - c1[1]) * t),
        int(c1[2] + (c2[2] - c1[2]) * t),
    )


# ---------------------------------------------------------------------------
# Layout helpers
# ---------------------------------------------------------------------------

def resolve_y(y_spec, size, line_index, prev_line_bottom):
    """Resolve a y specification to an integer pixel offset.

    Args:
        y_spec:          "auto", "top", "middle", "bottom", or integer.
        size:            Font size (1, 2, or 3).
        line_index:      0-based index of this line.
        prev_line_bottom: Pixel just below the previous line (for auto stacking).

    Returns:
        Integer y pixel offset (0–10).

    Font height notes (bitmap6 font, 6×6 px at scale=1):
        size=1 → 6 px tall  (two lines: y=0 rows 0-5, y=5 rows 5-10 — share row 5)
        size=2 → 12 px tall (clips on 11 px display; best position is y=0)
        size=3 → 18 px tall (clips heavily; best position is y=0)
    """
    font_h = FONT_HEIGHTS.get(size, 6)

    if y_spec == "auto":
        if line_index == 0:
            return 0
        # Pack lines tightly with no gap — the display is only 11px tall.
        # prev_line_bottom is already the first pixel below the previous line.
        return min(prev_line_bottom, DISPLAY_HEIGHT - font_h)

    if y_spec == "top":
        return 0

    if y_spec == "middle":
        return max(0, (DISPLAY_HEIGHT - font_h) // 2)

    if y_spec == "bottom":
        return max(0, DISPLAY_HEIGHT - font_h)

    if isinstance(y_spec, int):
        return max(0, min(DISPLAY_HEIGHT - 1, y_spec))

    return 0


def measure_text(graphics, text, size):
    """Return the pixel width of text at the given size scale."""
    scale = size  # PicoGraphics scale parameter maps directly to our size
    return graphics.measure_text(text, scale=scale)


# ---------------------------------------------------------------------------
# DisplayMessage — internal representation of a queued message
# ---------------------------------------------------------------------------

class DisplayMessage:
    """Parsed, validated display message ready for rendering."""

    def __init__(self, raw):
        """Parse a raw dict (from JSON) into a DisplayMessage.

        Raises ValueError with a descriptive message on invalid input.
        """
        import urandom
        self.id = raw.get("id") or "msg-{:08x}".format(urandom.getrandbits(32))
        self.priority = int(raw.get("priority", 5))
        if not (0 <= self.priority <= 10):
            raise ValueError("priority must be 0–10")

        dur = raw.get("duration", "forever")
        if dur == "forever":
            self.duration = None  # None = forever
        else:
            self.duration = float(dur)
            if self.duration <= 0:
                raise ValueError("duration must be > 0 or 'forever'")

        self.transition = raw.get("transition", "cut")
        if self.transition not in ("cut", "fade", "wipe_left", "wipe_right"):
            self.transition = "cut"

        br = raw.get("brightness")
        self.brightness = float(br) if br is not None else None
        if self.brightness is not None and not (0.0 <= self.brightness <= 1.0):
            raise ValueError("brightness must be 0.0–1.0")

        self.bg_color = parse_color(raw.get("bg_color", [0, 0, 0]))

        lines_raw = raw.get("lines")
        if not lines_raw or not isinstance(lines_raw, list):
            raise ValueError("'lines' must be a non-empty array")
        if len(lines_raw) > 2:
            raise ValueError("maximum 2 lines per message")

        self.lines = [LineSpec(l, i) for i, l in enumerate(lines_raw)]

        # Resolve y positions now that we know all line sizes
        prev_bottom = 0
        for i, line in enumerate(self.lines):
            y = resolve_y(line.y_spec, line.size, i, prev_bottom)
            line.y = y
            prev_bottom = y + FONT_HEIGHTS.get(line.size, 6)

        # Timestamps set when message becomes active
        self.started_at = None


class LineSpec:
    """Parsed line object.

    Supports an optional ``segments`` field for multi-colour text within a
    single line.  When present, ``segments`` is a list of dicts each with
    ``text`` and ``color`` keys.  The ``text`` and ``color`` fields at the
    top level are ignored when ``segments`` is provided.

    Example JSON::

        {
            "segments": [
                {"text": "20m ", "color": "lime"},
                {"text": "17m ", "color": "amber"},
                {"text": "40m",  "color": "red"}
            ],
            "size": 1,
            "effect": "static",
            "y": "bottom"
        }
    """

    def __init__(self, raw, index):
        if not isinstance(raw, dict):
            raise ValueError(f"line {index} must be an object")

        # --- segments (multi-colour) vs plain text ---
        segs_raw = raw.get("segments")
        if segs_raw is not None:
            if not isinstance(segs_raw, list) or len(segs_raw) == 0:
                raise ValueError(f"line {index}: 'segments' must be a non-empty array")
            self.segments = []
            for si, seg in enumerate(segs_raw):
                if not isinstance(seg, dict):
                    raise ValueError(f"line {index} segment {si} must be an object")
                seg_text = seg.get("text")
                if seg_text is None:
                    raise ValueError(f"line {index} segment {si}: 'text' is required")
                self.segments.append({
                    "text": str(seg_text),
                    "color": parse_color(seg.get("color", "white")),
                })
            # Synthesise a combined text string for width measurement and scroll
            self.text = "".join(s["text"] for s in self.segments)
            self.color = None  # unused when segments present
        else:
            text = raw.get("text")
            if text is None:
                raise ValueError(f"line {index}: 'text' is required")
            self.text = str(text)
            self.segments = None
            self.color = parse_color(raw.get("color", "white"))

        self.size = int(raw.get("size", 1))
        if self.size not in (1, 2, 3):
            raise ValueError(f"line {index}: size must be 1, 2, or 3")

        self.effect = raw.get("effect", "auto")
        if self.effect not in ("static", "scroll", "auto", "blink", "pulse"):
            self.effect = "auto"

        self.align = raw.get("align", "left")
        if self.align not in ("left", "center", "right"):
            self.align = "left"

        self.y_spec = raw.get("y", "auto")
        self.y = 0  # resolved later by DisplayMessage.__init__

        self.scroll_speed = max(1, min(200, int(raw.get("scroll_speed", 40))))
        self.scroll_pause = max(0.0, float(raw.get("scroll_pause", 1.0)))
        self.scroll_loop = bool(raw.get("scroll_loop", True))
        self.scroll_start = raw.get("scroll_start", "right")
        if self.scroll_start not in ("right", "left", "center"):
            self.scroll_start = "right"

        self.blink_rate = max(0.1, min(20.0, float(raw.get("blink_rate", 2.0))))
        self.pulse_speed = max(0.1, min(10.0, float(raw.get("pulse_speed", 1.0))))
        self.pulse_min = max(0.0, min(1.0, float(raw.get("pulse_min", 0.1))))

        # Scroll state (mutable, reset each time message becomes active)
        self.scroll_x = 0.0          # current x offset (float for sub-pixel accuracy)
        self.scroll_phase = "pause"  # "pause" | "scrolling" | "done"
        self.scroll_pause_start = 0.0
        self.text_width = 0          # measured pixel width, set by engine on first render


# ---------------------------------------------------------------------------
# DisplayQueue — priority queue with replace-by-id semantics
# ---------------------------------------------------------------------------

class DisplayQueue:
    """Simple priority queue for DisplayMessage objects."""

    def __init__(self, max_size=16):
        self._items = []
        self._max_size = max_size

    def push(self, msg):
        """Add a message. Replaces existing entry with same id if present.
        If queue is full, discards the lowest-priority oldest entry.
        Returns True if added, False if rejected (queue full, lower priority).
        """
        # Replace existing entry with same id
        for i, existing in enumerate(self._items):
            if existing.id == msg.id:
                self._items[i] = msg
                return True

        # Enforce queue size limit
        if len(self._items) >= self._max_size:
            # Find lowest-priority item (stable: last one if tied)
            min_pri = msg.priority
            min_idx = -1
            for i, existing in enumerate(self._items):
                if existing.priority < min_pri:
                    min_pri = existing.priority
                    min_idx = i
            if min_idx == -1:
                return False  # All queued items have >= priority; reject incoming
            self._items.pop(min_idx)

        self._items.append(msg)
        # Sort by priority descending, preserving arrival order for equal priority
        self._items.sort(key=lambda m: -m.priority)
        return True

    def pop_next(self):
        """Remove and return the highest-priority message, or None if empty."""
        if self._items:
            return self._items.pop(0)
        return None

    def peek_priority(self):
        """Return the priority of the next queued message, or -1 if empty."""
        if self._items:
            return self._items[0].priority
        return -1

    def cancel(self, msg_id):
        """Remove a message by id. Returns True if found and removed."""
        for i, m in enumerate(self._items):
            if m.id == msg_id:
                self._items.pop(i)
                return True
        return False

    def clear(self):
        self._items.clear()

    def __len__(self):
        return len(self._items)

    def snapshot(self):
        """Return a list of dicts describing queued items (for /status)."""
        return [
            {"id": m.id, "priority": m.priority,
             "duration": m.duration if m.duration is not None else "forever"}
            for m in self._items
        ]


# ---------------------------------------------------------------------------
# DisplayEngine — main rendering loop
# ---------------------------------------------------------------------------

class DisplayEngine:
    """Manages the display queue and renders frames to the Galactic Unicorn."""

    def __init__(self, gu, graphics, brightness=0.5):
        self._gu = gu
        self._g = graphics
        self._brightness = brightness
        self._gu.set_brightness(brightness)

        self._queue = DisplayQueue()
        self._active = None          # Currently displayed DisplayMessage
        self._active_brightness = None  # Saved brightness override

        self._rainbow_phase = 0.0    # Advances each frame for rainbow effect
        self._frame_time = 0.0       # yield to scheduler each frame; rate controlled by ticks_ms
        self._min_frame_ms = 20      # minimum ms between renders (~50 fps cap)

        # Transition state
        self._transition_active = False
        self._transition_type = "cut"
        self._transition_progress = 0.0  # 0.0 → 1.0
        self._transition_speed = 4.0     # Completes in ~0.25 s

    # ------------------------------------------------------------------
    # Public API (called from HTTP handler coroutine)
    # ------------------------------------------------------------------

    def set_message(self, msg):
        """Install a new DisplayMessage. Interrupts active if higher priority."""
        if self._active is None:
            self._start_message(msg)
            return {"queued": False}

        if msg.id == self._active.id:
            # Replace active message in-place (same id)
            self._start_message(msg)
            return {"queued": False}

        if msg.priority > self._active.priority:
            # Interrupt: push active back onto queue if it has remaining time
            if self._active.duration is not None and self._active.started_at is not None:
                elapsed = time.time() - self._active.started_at
                remaining = self._active.duration - elapsed
                if remaining > 0.5:
                    self._active.duration = remaining
                    self._queue.push(self._active)
            self._start_message(msg)
            return {"queued": False}

        # Queue it
        added = self._queue.push(msg)
        return {"queued": True, "queue_depth": len(self._queue), "added": added}

    def set_brightness(self, value):
        """Set global brightness (0.0–1.0)."""
        self._brightness = max(0.0, min(1.0, value))
        self._gu.set_brightness(self._brightness)

    def get_brightness(self):
        return self._brightness

    def clear(self):
        """Blank display and clear queue."""
        self._queue.clear()
        self._active = None
        self._g.set_pen(self._g.create_pen(0, 0, 0))
        self._g.clear()
        self._gu.update(self._g)

    def cancel(self, msg_id):
        """Cancel a queued or active message by id."""
        if self._active and self._active.id == msg_id:
            self._active = None
            self._advance_queue()
            return True
        return self._queue.cancel(msg_id)

    def status(self):
        """Return a dict describing current state."""
        active_info = None
        if self._active:
            elapsed = 0.0
            if self._active.started_at:
                elapsed = time.time() - self._active.started_at
            active_info = {
                "id": self._active.id,
                "priority": self._active.priority,
                "duration": self._active.duration if self._active.duration is not None else "forever",
                "elapsed": round(elapsed, 1),
            }
        return {
            "ok": True,
            "brightness": self._brightness,
            "active": active_info,
            "queue_depth": len(self._queue),
            "queue": self._queue.snapshot(),
        }

    # ------------------------------------------------------------------
    # Main render loop (run as asyncio task)
    # ------------------------------------------------------------------

    async def run(self):
        """Main display loop. Call once as an asyncio task.

        Uses asyncio.sleep(0) to yield to other tasks each iteration, but
        gates actual rendering behind _min_frame_ms so we don't burn CPU
        rendering faster than needed. This gives smooth animation while
        keeping the HTTP server and button handler responsive.
        """
        last_render_ms = time.ticks_ms()
        last_ms = time.ticks_ms()
        while True:
            # Always yield first so HTTP/button tasks get CPU time
            await asyncio.sleep(0)

            now_ms = time.ticks_ms()

            # Only render if enough time has passed since last frame
            elapsed_since_render = time.ticks_diff(now_ms, last_render_ms)
            if elapsed_since_render < self._min_frame_ms:
                continue

            dt = time.ticks_diff(now_ms, last_ms) / 1000.0
            last_ms = now_ms
            last_render_ms = now_ms

            # Clamp dt to avoid huge jumps after pauses (e.g. GC, HTTP handling)
            if dt > 0.1:
                dt = 0.1

            self._rainbow_phase = (self._rainbow_phase + dt * 0.5) % 1.0

            # Check if active message has expired (use wall time for duration)
            now_wall = time.time()
            if self._active is not None and self._active.duration is not None:
                elapsed = now_wall - self._active.started_at
                if elapsed >= self._active.duration:
                    # Restore brightness if it was overridden
                    if self._active_brightness is not None:
                        self._gu.set_brightness(self._brightness)
                        self._active_brightness = None
                    self._active = None
                    self._advance_queue()

            # Render current frame
            try:
                if self._active is not None:
                    self._render_frame(dt)
                else:
                    # Blank display
                    self._g.set_pen(self._g.create_pen(0, 0, 0))
                    self._g.clear()
                    self._gu.update(self._g)
            except Exception as e:
                print(f"Render error: {e}")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _start_message(self, msg):
        """Make msg the active message, applying transition and brightness."""
        msg.started_at = time.time()  # wall time — used for duration expiry only

        # Reset scroll state for each line
        # scroll_pause_start uses ticks_ms for millisecond precision
        now_ms = time.ticks_ms()
        for line in msg.lines:
            line.scroll_x = 0.0
            line.scroll_phase = "pause"
            line.scroll_pause_start = now_ms
            line.text_width = 0  # will be measured on first render

        # Apply brightness override
        if msg.brightness is not None:
            self._active_brightness = self._brightness
            self._gu.set_brightness(msg.brightness)
        elif self._active_brightness is not None:
            self._gu.set_brightness(self._brightness)
            self._active_brightness = None

        # Set up transition
        self._transition_type = msg.transition
        if msg.transition != "cut":
            self._transition_active = True
            self._transition_progress = 0.0
        else:
            self._transition_active = False

        self._active = msg

    def _advance_queue(self):
        """Pop the next message from the queue and make it active."""
        next_msg = self._queue.pop_next()
        if next_msg:
            self._start_message(next_msg)

    def _render_frame(self, dt):
        """Render one frame of the active message."""
        msg = self._active
        g = self._g

        # Clear background
        bg = msg.bg_color
        if isinstance(bg, tuple) and len(bg) == 3:
            g.set_pen(g.create_pen(bg[0], bg[1], bg[2]))
        else:
            g.set_pen(g.create_pen(0, 0, 0))
        g.clear()

        # Render each line
        for line in msg.lines:
            self._render_line(line, dt)

        # Apply transition overlay if active
        if self._transition_active:
            self._apply_transition(dt)

        self._gu.update(g)

    def _render_line(self, line, dt):
        """Render a single line onto the graphics buffer."""
        g = self._g
        # Use millisecond time for smooth animation (time.time() is integer seconds)
        now_ms = time.ticks_ms()
        now_s = now_ms / 1000.0  # float seconds for blink/pulse phase calculations

        # Measure text width on first render
        if line.text_width == 0:
            line.text_width = measure_text(g, line.text, line.size)

        text_w = line.text_width
        font_h = FONT_HEIGHTS.get(line.size, 6)
        y = line.y

        # Determine effective effect
        effect = line.effect
        if effect == "auto":
            effect = "scroll" if text_w > DISPLAY_WIDTH else "static"

        # --- Scroll logic ---
        if effect == "scroll":
            # Initialise scroll_x on first call
            if line.scroll_phase == "pause" and line.scroll_x == 0.0:
                if line.scroll_start == "right":
                    line.scroll_x = float(DISPLAY_WIDTH)
                elif line.scroll_start == "left":
                    line.scroll_x = 0.0
                    line.scroll_phase = "scrolling"
                elif line.scroll_start == "center":
                    line.scroll_x = float((DISPLAY_WIDTH - text_w) // 2)
                    line.scroll_phase = "scrolling"

            if line.scroll_phase == "pause":
                elapsed_pause_ms = time.ticks_diff(now_ms, line.scroll_pause_start)
                if elapsed_pause_ms >= line.scroll_pause * 1000:
                    line.scroll_phase = "scrolling"
            elif line.scroll_phase == "scrolling":
                line.scroll_x -= line.scroll_speed * dt
                # Check if text has fully scrolled off left edge
                if line.scroll_x + text_w < 0:
                    if line.scroll_loop:
                        line.scroll_x = float(DISPLAY_WIDTH)
                        line.scroll_phase = "pause"
                        line.scroll_pause_start = now_ms
                    else:
                        line.scroll_phase = "done"
                        line.scroll_x = -float(text_w)

            # PicoGraphics text() requires an integer x position
            x = int(line.scroll_x)

        # --- Static / blink / pulse logic ---
        else:
            if line.align == "center":
                x = max(0, (DISPLAY_WIDTH - text_w) // 2)
            elif line.align == "right":
                x = max(0, DISPLAY_WIDTH - text_w)
            else:
                x = 0

            if effect == "blink":
                period = 1.0 / line.blink_rate
                phase = (now_s % period) / period
                if phase > 0.5:
                    return  # invisible half of blink cycle

            elif effect == "pulse":
                period = 1.0 / line.pulse_speed
                phase = (now_s % period) / period
                brightness_mult = line.pulse_min + (1.0 - line.pulse_min) * (
                    0.5 + 0.5 * math.sin(2 * math.pi * phase - math.pi / 2)
                )
                # We'll apply this as a colour scale below

        # --- Colour resolution ---

        # Multi-colour segments: draw each segment in its own colour at x offset
        if line.segments is not None:
            self._draw_segments(line.segments, x, y, line.size)
            return

        color_spec = line.color

        if color_spec == "rainbow":
            # Draw character by character with cycling hue
            self._draw_rainbow_text(line.text, x, y, line.size, text_w)
            return

        if isinstance(color_spec, tuple) and len(color_spec) == 3 and color_spec[0] == "gradient":
            # Gradient: draw character by character
            self._draw_gradient_text(line.text, x, y, line.size, text_w,
                                     color_spec[1], color_spec[2])
            return

        # Solid colour
        if isinstance(color_spec, tuple) and len(color_spec) == 3:
            r, g_c, b = color_spec
        else:
            r, g_c, b = 255, 255, 255

        # Apply pulse brightness multiplier if needed
        if effect == "pulse":
            period = 1.0 / line.pulse_speed
            phase = (now_s % period) / period
            bm = line.pulse_min + (1.0 - line.pulse_min) * (
                0.5 + 0.5 * math.sin(2 * math.pi * phase - math.pi / 2)
            )
            r = int(r * bm)
            g_c = int(g_c * bm)
            b = int(b * bm)

        pen = self._g.create_pen(r, g_c, b)
        self._g.set_pen(pen)
        self._g.text(line.text, x, y, scale=line.size)

    def _draw_segments(self, segments, x, y, size):
        """Draw multi-colour segments sequentially from x, each in its own colour."""
        g = self._g
        cx = x
        for seg in segments:
            text = seg["text"]
            color_spec = seg["color"]
            if isinstance(color_spec, tuple) and len(color_spec) == 3:
                r, gv, b = color_spec
            else:
                r, gv, b = 255, 255, 255
            g.set_pen(g.create_pen(r, gv, b))
            g.text(text, cx, y, scale=size)
            cx += measure_text(g, text, size)

    def _draw_rainbow_text(self, text, x, y, size, text_w):
        """Draw text with per-character rainbow colouring."""
        g = self._g
        cx = x
        for ch in text:
            ch_w = measure_text(g, ch, size)
            # Hue based on position across display + global phase
            hue = (self._rainbow_phase + cx / DISPLAY_WIDTH) % 1.0
            r, gv, b = hsv_to_rgb(hue, 1.0, 1.0)
            g.set_pen(g.create_pen(r, gv, b))
            g.text(ch, cx, y, scale=size)
            cx += ch_w

    def _draw_gradient_text(self, text, x, y, size, text_w, c1, c2):
        """Draw text with a left-to-right gradient between c1 and c2."""
        g = self._g
        cx = x
        for ch in text:
            ch_w = measure_text(g, ch, size)
            if text_w > 0:
                t = max(0.0, min(1.0, (cx - x) / text_w))
            else:
                t = 0.0
            r, gv, b = lerp_color(c1, c2, t)
            g.set_pen(g.create_pen(r, gv, b))
            g.text(ch, cx, y, scale=size)
            cx += ch_w

    def _apply_transition(self, dt):
        """Overlay a transition effect on the current frame."""
        self._transition_progress += dt * self._transition_speed
        if self._transition_progress >= 1.0:
            self._transition_active = False
            return

        p = self._transition_progress  # 0.0 → 1.0

        if self._transition_type == "fade":
            # Fade in: draw a black overlay with decreasing opacity
            # Approximate by drawing black pixels over a fraction of the display
            # (True alpha blending not available; use brightness ramp instead)
            fade_brightness = p
            if self._active and self._active.brightness is not None:
                self._gu.set_brightness(self._active.brightness * fade_brightness)
            else:
                self._gu.set_brightness(self._brightness * fade_brightness)

        elif self._transition_type == "wipe_left":
            # Reveal from right to left: black out the right portion
            reveal_x = int(DISPLAY_WIDTH * p)
            g = self._g
            g.set_pen(g.create_pen(0, 0, 0))
            for px in range(reveal_x, DISPLAY_WIDTH):
                for py in range(DISPLAY_HEIGHT):
                    g.pixel(px, py)

        elif self._transition_type == "wipe_right":
            # Reveal from left to right: black out the left portion
            reveal_x = int(DISPLAY_WIDTH * (1.0 - p))
            g = self._g
            g.set_pen(g.create_pen(0, 0, 0))
            for px in range(0, reveal_x):
                for py in range(DISPLAY_HEIGHT):
                    g.pixel(px, py)
