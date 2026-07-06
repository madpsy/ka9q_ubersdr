# Galactic Unicorn Display Firmware — main.py
# Boot entry point: connects to Wi-Fi, starts HTTP server, runs display engine.
#
# Files required on the Pico W:
#   main.py           (this file)
#   config.py         (Wi-Fi credentials and defaults)
#   display_engine.py (rendering engine)
#
# MicroPython version: 1.22+ with Pimoroni firmware
# Hardware: Pimoroni Galactic Unicorn
#
# Button assignments:
#   A     — Show IP address (cyan scroll)
#   B     — Show Wi-Fi status (SSID + connected/disconnected)
#   C     — Clear display queue
#   D     — Step brightness up by BRIGHTNESS_STEP (10%); wraps after max; hold to repeat
#   LUX + / LUX - (SWITCH_BRIGHTNESS_UP/DOWN) — Adjust brightness by BRIGHTNESS_STEP

import gc
import json
import network
import time
import uasyncio as asyncio

from galactic import GalacticUnicorn
from picographics import PicoGraphics, DISPLAY_GALACTIC_UNICORN

import config
from display_engine import DisplayEngine, DisplayMessage

# ---------------------------------------------------------------------------
# Hardware initialisation
# ---------------------------------------------------------------------------

gu = GalacticUnicorn()
graphics = PicoGraphics(display=DISPLAY_GALACTIC_UNICORN)
engine = DisplayEngine(gu, graphics, brightness=config.DEFAULT_BRIGHTNESS)

# ---------------------------------------------------------------------------
# Global state (set during boot, used by button handlers)
# ---------------------------------------------------------------------------

_wlan = None          # network.WLAN object — set in connect_wifi()
_device_ip = None     # IP string or "0.0.0.0" — set in main()

# Auto-brightness: tracks when the user last manually adjusted brightness so
# auto-brightness can pause and then resume after a configurable delay.
_manual_brightness_at = None   # ticks_ms() of last manual change, or None

# ---------------------------------------------------------------------------
# Boot animation helpers (synchronous — asyncio not running yet)
# ---------------------------------------------------------------------------

def _hsv_to_rgb(h, s, v):
    """Convert HSV (0.0–1.0 each) to (r, g, b) 0–255. Pure Python, no imports."""
    if s == 0.0:
        c = int(v * 255)
        return c, c, c
    i = int(h * 6.0)
    f = (h * 6.0) - i
    p = v * (1.0 - s)
    q = v * (1.0 - s * f)
    t = v * (1.0 - s * (1.0 - f))
    i = i % 6
    if i == 0: return int(v*255), int(t*255), int(p*255)
    if i == 1: return int(q*255), int(v*255), int(p*255)
    if i == 2: return int(p*255), int(v*255), int(t*255)
    if i == 3: return int(p*255), int(q*255), int(v*255)
    if i == 4: return int(t*255), int(p*255), int(v*255)
    return int(v*255), int(p*255), int(q*255)


def _draw_rainbow_bar(y_start, height, hue_offset):
    """Draw a full-width horizontal rainbow bar from y_start for 'height' rows."""
    for x in range(53):
        hue = (hue_offset + x / 53.0) % 1.0
        r, g, b = _hsv_to_rgb(hue, 1.0, 0.9)
        graphics.set_pen(graphics.create_pen(r, g, b))
        for y in range(y_start, y_start + height):
            graphics.pixel(x, y)


def _draw_rainbow_text(text, x, y, scale, hue_offset):
    """Draw text with per-character rainbow colouring. hue_offset cycles 0.0–1.0."""
    cx = x
    for ch in text:
        w = graphics.measure_text(ch, scale=scale)
        # Hue based on character position + animated offset
        hue = (hue_offset + cx / 53.0) % 1.0
        r, g, b = _hsv_to_rgb(hue, 1.0, 1.0)
        graphics.set_pen(graphics.create_pen(r, g, b))
        graphics.text(ch, cx, y, scale=scale)
        cx += w


def _draw_scroll_rainbow(text, scroll_x, hue_offset):
    """Draw scrolling rainbow text filling the full 11-pixel display height.

    Layout (11 rows total):
      rows 0-7  : text at scale 1 (8px bitmap font), y=0
      rows 8-10 : animated rainbow bar (3px)
    """
    graphics.set_pen(graphics.create_pen(0, 0, 0))
    graphics.clear()

    # Text row (rows 0-7)
    cx = int(scroll_x)
    for ch in text:
        w = graphics.measure_text(ch, scale=1)
        if cx + w > 0 and cx < 53:  # only draw visible characters
            hue = (hue_offset + (cx + w // 2) / 53.0) % 1.0
            r, g, b = _hsv_to_rgb(hue, 1.0, 1.0)
            graphics.set_pen(graphics.create_pen(r, g, b))
            graphics.text(ch, cx, 0, scale=1)
        cx += w

    # Rainbow bar (rows 8-10) — shifts opposite direction for cool effect
    _draw_rainbow_bar(8, 3, (1.0 - hue_offset) % 1.0)

    gu.update(graphics)


# ---------------------------------------------------------------------------
# Wi-Fi connection (with animated rainbow splash)
# ---------------------------------------------------------------------------

def connect_wifi():
    """Connect to Wi-Fi. Animates rainbow 'UberSDR' scroll while connecting.
    Returns (wlan, ip_string) — ip is None on timeout."""
    global _wlan
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    _wlan = wlan

    if wlan.isconnected():
        return wlan, wlan.ifconfig()[0]

    print(f"Connecting to Wi-Fi: {config.WIFI_SSID}")
    wlan.connect(config.WIFI_SSID, config.WIFI_PASSWORD)

    splash_text = config.SPLASH_TEXT or "UberSDR"
    # _draw_scroll_rainbow handles layout: 8px text (rows 0-7) + 3px bar (rows 8-10)
    text_width = graphics.measure_text(splash_text, scale=1)

    # Scroll state
    scroll_x = float(53)          # start off right edge
    scroll_speed = 30.0           # pixels per second
    hue_offset = 0.0
    hue_speed = 0.4               # hue cycles per second

    deadline = time.time() + config.WIFI_CONNECT_TIMEOUT
    last_ms = time.ticks_ms()

    while not wlan.isconnected():
        if time.time() > deadline:
            print("Wi-Fi connection timed out")
            return wlan, None

        now_ms = time.ticks_ms()
        dt = time.ticks_diff(now_ms, last_ms) / 1000.0
        last_ms = now_ms

        # Advance scroll
        scroll_x -= scroll_speed * dt
        if scroll_x + text_width < 0:
            scroll_x = float(53)  # loop back

        # Advance hue
        hue_offset = (hue_offset + hue_speed * dt) % 1.0

        # Draw frame — fills all 11 rows (8px text + 3px rainbow bar)
        _draw_scroll_rainbow(splash_text, scroll_x, hue_offset)

        time.sleep_ms(33)  # ~30 fps

    ip = wlan.ifconfig()[0]
    print(f"Wi-Fi connected: {ip}")
    return wlan, ip


# ---------------------------------------------------------------------------
# HTTP request parser
# ---------------------------------------------------------------------------

def parse_http_request(raw_bytes):
    """Parse raw HTTP bytes into (method, path, headers, body_bytes).

    Returns None if the request is incomplete or malformed.
    """
    try:
        # Split headers from body on double CRLF
        header_end = raw_bytes.find(b"\r\n\r\n")
        if header_end == -1:
            return None

        header_section = raw_bytes[:header_end].decode("utf-8", "ignore")
        body_bytes = raw_bytes[header_end + 4:]

        lines = header_section.split("\r\n")
        if not lines:
            return None

        # Request line
        parts = lines[0].split(" ", 2)
        if len(parts) < 2:
            return None
        method = parts[0].upper()
        path = parts[1]

        # Headers
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, _, v = line.partition(":")
                headers[k.strip().lower()] = v.strip()

        # Content-Length: read exactly that many body bytes
        content_length = int(headers.get("content-length", 0))
        body = body_bytes[:content_length]

        return method, path, headers, body

    except Exception as e:
        print(f"HTTP parse error: {e}")
        return None


def http_response(status_code, status_text, body_dict):
    """Build an HTTP response bytes object from a dict (JSON body)."""
    body = json.dumps(body_dict)
    body_bytes = body.encode("utf-8")
    response = (
        f"HTTP/1.1 {status_code} {status_text}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(body_bytes)}\r\n"
        f"Connection: close\r\n"
        f"\r\n"
    ).encode("utf-8") + body_bytes
    return response


# ---------------------------------------------------------------------------
# Request handlers
# ---------------------------------------------------------------------------

def handle_display_post(body_bytes):
    """Handle POST /display — parse and enqueue a display or control message."""
    if not body_bytes:
        return http_response(400, "Bad Request",
                             {"ok": False, "error": "empty_body",
                              "message": "Request body is empty"})

    try:
        raw = json.loads(body_bytes.decode("utf-8"))
    except Exception as e:
        return http_response(400, "Bad Request",
                             {"ok": False, "error": "invalid_json",
                              "message": f"JSON parse error: {e}"})

    msg_type = raw.get("type")

    # --- Control command ---
    if msg_type == "control":
        return handle_control(raw)

    # --- Display message ---
    if msg_type != "display":
        return http_response(400, "Bad Request",
                             {"ok": False, "error": "unknown_type",
                              "message": f"'type' must be 'display' or 'control', got: {msg_type!r}"})

    try:
        msg = DisplayMessage(raw)
    except ValueError as e:
        return http_response(422, "Unprocessable Entity",
                             {"ok": False, "error": "validation_error",
                              "message": str(e)})
    except Exception as e:
        return http_response(400, "Bad Request",
                             {"ok": False, "error": "parse_error",
                              "message": str(e)})

    result = engine.set_message(msg)
    gc.collect()

    return http_response(200, "OK", {
        "ok": True,
        "id": msg.id,
        "queued": result.get("queued", False),
        "queue_depth": result.get("queue_depth", 0),
    })


def handle_control(raw):
    """Handle a control command dict."""
    cmd = raw.get("cmd")

    if cmd == "clear":
        engine.clear()
        return http_response(200, "OK", {"ok": True, "cmd": "clear"})

    elif cmd == "brightness":
        value = raw.get("value")
        if value is None or not isinstance(value, (int, float)):
            return http_response(422, "Unprocessable Entity",
                                 {"ok": False, "error": "missing_field",
                                  "message": "'value' (number 0.0–1.0) is required for brightness command"})
        value = float(value)
        if not (0.0 <= value <= 1.0):
            return http_response(422, "Unprocessable Entity",
                                 {"ok": False, "error": "out_of_range",
                                  "message": f"'value' must be 0.0–1.0, got {value}"})
        engine.set_brightness(value)
        return http_response(200, "OK", {"ok": True, "brightness": value})

    elif cmd == "cancel":
        msg_id = raw.get("id")
        if not msg_id:
            return http_response(422, "Unprocessable Entity",
                                 {"ok": False, "error": "missing_field",
                                  "message": "'id' is required for cancel command"})
        found = engine.cancel(msg_id)
        return http_response(200, "OK", {"ok": True, "cancelled": found, "id": msg_id})

    elif cmd == "cancel_all":
        engine.clear()
        return http_response(200, "OK", {"ok": True, "cmd": "cancel_all"})

    elif cmd == "status":
        status = engine.status()
        return http_response(200, "OK", status)

    else:
        return http_response(400, "Bad Request",
                             {"ok": False, "error": "unknown_cmd",
                              "message": f"Unknown control command: {cmd!r}. "
                                         f"Valid: clear, brightness, cancel, cancel_all, status"})


def handle_brightness_post(body_bytes):
    """Handle POST /brightness — convenience endpoint."""
    try:
        raw = json.loads(body_bytes.decode("utf-8"))
    except Exception:
        return http_response(400, "Bad Request",
                             {"ok": False, "error": "invalid_json",
                              "message": "Request body must be JSON"})
    value = raw.get("value")
    if value is None:
        return http_response(422, "Unprocessable Entity",
                             {"ok": False, "error": "missing_field",
                              "message": "'value' is required"})
    value = float(value)
    if not (0.0 <= value <= 1.0):
        return http_response(422, "Unprocessable Entity",
                             {"ok": False, "error": "out_of_range",
                              "message": f"'value' must be 0.0–1.0, got {value}"})
    engine.set_brightness(value)
    return http_response(200, "OK", {"ok": True, "brightness": value})


def handle_status_get():
    """Handle GET /status."""
    status = engine.status()
    return http_response(200, "OK", status)


def handle_not_found(path):
    return http_response(404, "Not Found",
                         {"ok": False, "error": "not_found",
                          "message": f"No endpoint at {path}. "
                                     f"Available: POST /display, GET /status, POST /brightness"})


def handle_method_not_allowed(method, path):
    return http_response(405, "Method Not Allowed",
                         {"ok": False, "error": "method_not_allowed",
                          "message": f"{method} is not allowed on {path}"})


# ---------------------------------------------------------------------------
# HTTP server coroutine
# ---------------------------------------------------------------------------

async def handle_client(reader, writer):
    """Handle a single HTTP client connection."""
    try:
        # Read request with timeout
        raw = b""
        deadline = time.time() + config.HTTP_READ_TIMEOUT
        while True:
            try:
                chunk = await asyncio.wait_for(reader.read(1024), timeout=1.0)
                if not chunk:
                    break
                raw += chunk
                # Stop reading once we have headers + declared body
                if b"\r\n\r\n" in raw:
                    header_end = raw.find(b"\r\n\r\n")
                    header_section = raw[:header_end].decode("utf-8", "ignore")
                    content_length = 0
                    for line in header_section.split("\r\n")[1:]:
                        if line.lower().startswith("content-length:"):
                            content_length = int(line.split(":", 1)[1].strip())
                            break
                    body_received = len(raw) - header_end - 4
                    if body_received >= content_length:
                        break
            except asyncio.TimeoutError:
                break
            if time.time() > deadline:
                break

        parsed = parse_http_request(raw)
        if parsed is None:
            response = http_response(400, "Bad Request",
                                     {"ok": False, "error": "bad_request",
                                      "message": "Could not parse HTTP request"})
        else:
            method, path, headers, body = parsed

            # Route the request
            if path == "/display" or path == "/display/":
                if method == "POST":
                    response = handle_display_post(body)
                else:
                    response = handle_method_not_allowed(method, path)

            elif path == "/status" or path == "/status/":
                if method == "GET":
                    response = handle_status_get()
                else:
                    response = handle_method_not_allowed(method, path)

            elif path == "/brightness" or path == "/brightness/":
                if method == "POST":
                    response = handle_brightness_post(body)
                else:
                    response = handle_method_not_allowed(method, path)

            else:
                response = handle_not_found(path)

        writer.write(response)
        await writer.drain()

    except Exception as e:
        print(f"Client handler error: {e}")
    finally:
        writer.close()
        await writer.wait_closed()
        gc.collect()


# ---------------------------------------------------------------------------
# Button action helpers
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Config helpers — safe getattr with defaults so old config.py files work
# ---------------------------------------------------------------------------

def _cfg(key, default):
    """Return config.KEY if it exists, otherwise default."""
    return getattr(config, key, default)


def _btn_show_ip():
    """Button A — display the device IP address as a high-priority timed message."""
    ip = _device_ip or "0.0.0.0"
    connected = _wlan is not None and _wlan.isconnected()
    color = _cfg("BTN_IP_COLOR", "cyan") if connected else "red"
    raw = {
        "type": "display",
        "id": "btn-ip",
        "priority": _cfg("BTN_IP_PRIORITY", 8),
        "duration": _cfg("BTN_IP_DURATION", 5.0),
        "transition": "cut",
        "lines": [{
            "text": ip,
            "color": color,
            "size": 1,
            "effect": "auto",
            "align": "center",
            "y": "middle",
            "scroll_speed": 30,
            "scroll_pause": 0.5,
            "scroll_loop": False,
        }]
    }
    try:
        msg = DisplayMessage(raw)
        engine.set_message(msg)
        print(f"[BTN A] Showing IP: {ip}")
    except Exception as e:
        print(f"[BTN A] Error: {e}")


def _btn_show_wifi():
    """Button B — display Wi-Fi SSID (top line) and connection status (bottom line).

    Two size=1 lines fit on the 11px display: y=0 (rows 0-4) and y=6 (rows 6-10).
    """
    connected = _wlan is not None and _wlan.isconnected()
    ssid = getattr(config, "WIFI_SSID", None) or "?"

    if connected:
        status_text = "WiFi OK"
        status_color = "lime"
    else:
        status_text = "No WiFi"
        status_color = "red"

    raw = {
        "type": "display",
        "id": "btn-wifi",
        "priority": _cfg("BTN_WIFI_PRIORITY", 8),
        "duration": _cfg("BTN_WIFI_DURATION", 5.0),
        "transition": "cut",
        "lines": [
            {
                "text": ssid,
                "color": "cyan",
                "size": 1,
                "effect": "auto",
                "align": "center",
                "y": "top",
                "scroll_speed": 28,
                "scroll_pause": 0.5,
                "scroll_loop": False,
            },
            {
                "text": status_text,
                "color": status_color,
                "size": 1,
                "effect": "static",
                "align": "center",
                "y": "bottom",
            },
        ]
    }
    try:
        msg = DisplayMessage(raw)
        engine.set_message(msg)
        print(f"[BTN B] Showing WiFi: {ssid} / {status_text}")
    except Exception as e:
        print(f"[BTN B] Error: {e}")


def _btn_clear():
    """Button C — clear the display queue and blank the screen."""
    engine.clear()
    # Reinstall idle display so the screen doesn't stay blank forever
    install_idle_display()
    print("[BTN C] Display cleared")


def _mark_manual_brightness():
    """Record that the user just manually adjusted brightness.

    Auto-brightness will pause for AUTO_BRIGHTNESS_RESUME_S seconds before
    resuming.  Call this from any code path that changes brightness in response
    to a button press.
    """
    global _manual_brightness_at
    _manual_brightness_at = time.ticks_ms()


def _btn_step_brightness():
    """Button D — step brightness up by BRIGHTNESS_STEP, wrapping after max.

    Each press (or hold-repeat) increments the global brightness by BRIGHTNESS_STEP
    (default 10%).  After reaching BRIGHTNESS_MAX the next step wraps back to
    BRIGHTNESS_MIN so the user can cycle through the full range without needing
    the rocker buttons.
    """
    step    = _cfg("BRIGHTNESS_STEP", 0.1)
    br_min  = _cfg("BRIGHTNESS_MIN",  0.05)
    br_max  = _cfg("BRIGHTNESS_MAX",  1.0)

    current = engine.get_brightness()
    new_br  = round(current + step, 2)
    if new_br > br_max + 0.001:   # overshoot → wrap to minimum
        new_br = br_min

    engine.set_brightness(new_br)
    _mark_manual_brightness()

    label = f"{int(round(new_br * 100))}%"
    raw = {
        "type": "display",
        "id": "btn-brightness",
        "priority": _cfg("BTN_BRIGHTNESS_PRIORITY", 8),
        "duration": _cfg("BTN_BRIGHTNESS_DURATION", 1.0),
        "transition": "cut",
        "lines": [{
            "text": label,
            "color": "amber",
            "size": 1,
            "effect": "static",
            "align": "center",
            "y": "middle",
        }]
    }
    try:
        msg = DisplayMessage(raw)
        engine.set_message(msg)
        print(f"[BTN D] Brightness → {new_br:.2f} ({label})")
    except Exception as e:
        print(f"[BTN D] Error: {e}")


# ---------------------------------------------------------------------------
# Hardware button handler
# ---------------------------------------------------------------------------

# Hold-repeat timing for button D (brightness step).
# First repeat fires after BTN_D_HOLD_DELAY_MS ms; subsequent repeats every
# BTN_D_REPEAT_MS ms.  Both are configurable via config.py.
_BTN_D_HOLD_DELAY_MS = 500   # ms before first auto-repeat
_BTN_D_REPEAT_MS     = 300   # ms between subsequent auto-repeats


async def button_handler():
    """Poll hardware buttons and respond to presses.

    LUX + / LUX -   — adjust global brightness by BRIGHTNESS_STEP (SWITCH_BRIGHTNESS_UP/DOWN)
    A               — show IP address
    B               — show Wi-Fi SSID + status
    C               — clear display queue
    D               — step brightness up by BRIGHTNESS_STEP; hold to repeat
    """
    # Verify that the A/B/C/D switch constants exist on this firmware build.
    # Older Pimoroni builds may not expose them; log a warning but keep running.
    _has_abcd = all(
        hasattr(GalacticUnicorn, sw)
        for sw in ("SWITCH_A", "SWITCH_B", "SWITCH_C", "SWITCH_D")
    )
    if _has_abcd:
        print("Button handler: A/B/C/D switches available")
    else:
        print("Button handler: WARNING — SWITCH_A/B/C/D not found on this firmware; "
              "only LUX buttons will work")

    hold_delay_ms  = _cfg("BTN_D_HOLD_DELAY_MS", _BTN_D_HOLD_DELAY_MS)
    repeat_ms      = _cfg("BTN_D_REPEAT_MS",      _BTN_D_REPEAT_MS)

    # Per-button debounce state: tracks whether the button was held last tick
    _held = {
        "lux_up":  False,
        "lux_dn":  False,
        "a":       False,
        "b":       False,
        "c":       False,
    }

    # Button D hold-repeat state
    _d_held_since_ms = None   # ticks_ms() when D was first pressed, or None
    _d_last_fire_ms  = None   # ticks_ms() of last step action

    while True:
        try:
            # --- LUX + — brightness up, no wrap ---
            pressed = gu.is_pressed(GalacticUnicorn.SWITCH_BRIGHTNESS_UP)
            if pressed and not _held["lux_up"]:
                new_br = min(_cfg("BRIGHTNESS_MAX", 1.0),
                             engine.get_brightness() + _cfg("BRIGHTNESS_STEP", 0.1))
                engine.set_brightness(new_br)
                _mark_manual_brightness()
            _held["lux_up"] = pressed

            # --- LUX - — brightness down, no wrap ---
            pressed = gu.is_pressed(GalacticUnicorn.SWITCH_BRIGHTNESS_DOWN)
            if pressed and not _held["lux_dn"]:
                new_br = max(_cfg("BRIGHTNESS_MIN", 0.05),
                             engine.get_brightness() - _cfg("BRIGHTNESS_STEP", 0.1))
                engine.set_brightness(new_br)
                _mark_manual_brightness()
            _held["lux_dn"] = pressed

            if _has_abcd:
                # --- Button A: show IP ---
                pressed = gu.is_pressed(GalacticUnicorn.SWITCH_A)
                if pressed and not _held["a"]:
                    _btn_show_ip()
                _held["a"] = pressed

                # --- Button B: show Wi-Fi status ---
                pressed = gu.is_pressed(GalacticUnicorn.SWITCH_B)
                if pressed and not _held["b"]:
                    _btn_show_wifi()
                _held["b"] = pressed

                # --- Button C: clear queue ---
                pressed = gu.is_pressed(GalacticUnicorn.SWITCH_C)
                if pressed and not _held["c"]:
                    _btn_clear()
                _held["c"] = pressed

                # --- Button D: step brightness (with hold-repeat) ---
                pressed = gu.is_pressed(GalacticUnicorn.SWITCH_D)
                now_ms = time.ticks_ms()
                if pressed:
                    if _d_held_since_ms is None:
                        # Fresh press — fire immediately
                        _d_held_since_ms = now_ms
                        _d_last_fire_ms  = now_ms
                        _btn_step_brightness()
                    else:
                        held_ms = time.ticks_diff(now_ms, _d_held_since_ms)
                        since_last = time.ticks_diff(now_ms, _d_last_fire_ms)
                        if held_ms >= hold_delay_ms and since_last >= repeat_ms:
                            _d_last_fire_ms = now_ms
                            _btn_step_brightness()
                else:
                    _d_held_since_ms = None
                    _d_last_fire_ms  = None

        except Exception as e:
            print(f"Button handler error: {e}")

        await asyncio.sleep(0.05)  # 20 Hz poll — fast enough for responsive feel


# ---------------------------------------------------------------------------
# Splash screen
# ---------------------------------------------------------------------------

def show_splash():
    """Show a brief static splash before Wi-Fi animation begins.
    The main rainbow animation runs inside connect_wifi() itself."""
    if not config.SPLASH_TEXT:
        return
    graphics.set_pen(graphics.create_pen(0, 0, 0))
    graphics.clear()
    # Text at y=0 (rows 0-7), rainbow bar at rows 8-10
    _draw_rainbow_text(config.SPLASH_TEXT, 0, 0, 1, 0.0)
    _draw_rainbow_bar(8, 3, 0.0)
    gu.update(graphics)
    time.sleep_ms(200)  # brief flash before scroll begins


def show_ip(ip):
    """Scroll the IP address across the display in cyan after connecting.
    Uses rows 0-7 for text, rows 8-10 for a static cyan bar."""
    text = "  " + ip + "  "   # padding so it scrolls fully on and off
    text_width = graphics.measure_text(text, scale=1)
    scroll_x = float(53)
    scroll_speed = 28.0
    last_ms = time.ticks_ms()

    # Scroll the IP once fully across the display
    while scroll_x + text_width > 0:
        now_ms = time.ticks_ms()
        dt = time.ticks_diff(now_ms, last_ms) / 1000.0
        last_ms = now_ms

        scroll_x -= scroll_speed * dt

        graphics.set_pen(graphics.create_pen(0, 0, 0))
        graphics.clear()
        graphics.set_pen(graphics.create_pen(0, 220, 255))  # cyan
        graphics.text(text, int(scroll_x), 0, scale=1)
        # Cyan bar on rows 8-10
        for x in range(53):
            graphics.set_pen(graphics.create_pen(0, 180, 220))
            graphics.pixel(x, 8)
            graphics.pixel(x, 9)
            graphics.pixel(x, 10)
        gu.update(graphics)
        time.sleep_ms(33)

    # Hold blank for a moment before handing off to the engine
    graphics.set_pen(graphics.create_pen(0, 0, 0))
    graphics.clear()
    gu.update(graphics)
    time.sleep_ms(300)


def show_error(message):
    """Show an error message on the display."""
    graphics.set_pen(graphics.create_pen(0, 0, 0))
    graphics.clear()
    graphics.set_pen(graphics.create_pen(255, 0, 0))
    graphics.text("ERR", 0, 3, scale=1)
    gu.update(graphics)
    print(f"ERROR: {message}")


# ---------------------------------------------------------------------------
# Idle display
# ---------------------------------------------------------------------------

def install_idle_display():
    """Install the idle screensaver message if configured."""
    if not config.IDLE_TEXT:
        return
    idle_raw = {
        "type": "display",
        "id": "idle",
        "priority": 0,
        "duration": "forever",
        "lines": [{
            "text": config.IDLE_TEXT,
            "color": config.IDLE_COLOR,
            "size": config.IDLE_SIZE,
            "effect": config.IDLE_EFFECT,
            "align": config.IDLE_ALIGN,
            "y": "middle",
        }]
    }
    try:
        msg = DisplayMessage(idle_raw)
        engine.set_message(msg)
    except Exception as e:
        print(f"Failed to install idle display: {e}")


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

async def main():
    global _device_ip, _wlan

    show_splash()   # brief static rainbow flash on first boot

    _wlan, ip = connect_wifi()  # rainbow scroll animation runs here during Wi-Fi wait
    if ip is None:
        show_error("No WiFi")
        # Continue without network — display still works locally via buttons
        _device_ip = "0.0.0.0"
    else:
        _device_ip = ip
        show_ip(ip)

    print(f"HTTP server starting on {_device_ip}:{config.HTTP_PORT}")

    # Install idle display (lowest priority — shown when queue is empty)
    install_idle_display()

    # Start HTTP server
    server = await asyncio.start_server(
        handle_client,
        config.HTTP_HOST,
        config.HTTP_PORT,
        backlog=4
    )

    print(f"Ready. POST JSON to http://{_device_ip}:{config.HTTP_PORT}/display")
    print("Buttons: A=IP  B=WiFi  C=Clear  D=Step brightness (hold to repeat)  LUX+/-=Brightness")

    # Run all tasks concurrently
    await asyncio.gather(
        engine.run(),
        button_handler(),
        server.wait_closed(),
    )


# Run
asyncio.run(main())
