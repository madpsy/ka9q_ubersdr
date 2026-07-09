# UberSDR — Galactic Unicorn Display Client

Displays UberSDR notification events on a **Pimoroni Galactic Unicorn** LED matrix display (53×11 RGB LEDs, Raspberry Pi Pico W). Also supports alert sounds via the built-in speaker and automatic brightness control via the ambient light sensor.

```
┌─────────────────────────────────────────────────────┐  53 px wide
│          14.225 MHz USB          │  ← amber, centred
│W1AW 14025 CW 599 >>>             │  ← lime, scrolling
└─────────────────────────────────────────────────────┘  11 px tall
```

---

## How It Works

1. **Firmware** runs on the Pico W — a tiny MicroPython HTTP server that accepts JSON display commands.
2. **UberSDR** sends notification events to the Galactic Unicorn channel via the notification system, which POSTs JSON to the Pico W's HTTP server.
3. The Pico W renders the text with the configured colour, size, effect, and scroll settings, managing a priority queue autonomously.

---

## Hardware Required

- [Pimoroni Galactic Unicorn](https://shop.pimoroni.com/products/galactic-unicorn) (53×11 RGB LED matrix, Pico W)
- USB cable (for flashing firmware)
- Wi-Fi network that both the Pico W and UberSDR server can reach

---

## Firmware Setup

### Quick Setup (Recommended)

Use the included [`flash.py`](flash.py) script — it handles everything automatically:

```bash
# Install the only dependency
pip install mpremote

# Run the flasher (interactive — prompts for Wi-Fi credentials)
cd clients/galactic_unicorn
./flash.sh

# Or with Python directly
python3 flash.py

# Specify model (default is galactic)
python3 flash.py --model stellar    # Stellar Unicorn 16×16
python3 flash.py --model cosmic     # Cosmic Unicorn 32×32

# Non-interactive (CI / scripted setup)
python3 flash.py --ssid "MyNetwork" --password "secret" --model galactic

# Skip UF2 flash (only update Python files on an already-flashed device)
python3 flash.py --no-flash --ssid "MyNetwork" --password "secret"

# Preview without making changes
python3 flash.py --dry-run
```

The script will:
1. Download the latest Pimoroni MicroPython UF2 for your model from GitHub
2. Wait for you to put the Pico W into BOOTSEL mode, then copy the UF2
3. Wait for the Pico W to reboot into MicroPython
4. Generate a `config.py` with your Wi-Fi credentials
5. Copy `display_engine.py`, `config.py`, and `main.py` via `mpremote`
6. Reset the device and verify the files

**Requirements:** Python 3.8+, `mpremote` (`pip install mpremote`)

---

### Manual Setup

If you prefer to flash manually:

#### 1. Flash Pimoroni MicroPython

Download the latest **Pimoroni MicroPython** firmware (not the standard Raspberry Pi firmware — Pimoroni's build includes the `galactic_unicorn` and `picographics` modules):

- https://github.com/pimoroni/pimoroni-pico/releases

Hold **BOOTSEL** while plugging in USB, then drag the `.uf2` file onto the `RPI-RP2` drive.

#### 2. Copy firmware files to the Pico W

Copy all four files from [`firmware/`](firmware/) to the root of the Pico W filesystem using [Thonny](https://thonny.org/) or `mpremote`:

```
firmware/
├── config.py         ← edit this first
├── display_engine.py
├── sound_engine.py
└── main.py
```

Using `mpremote`:
```bash
mpremote cp firmware/config.py :config.py
mpremote cp firmware/display_engine.py :display_engine.py
mpremote cp firmware/sound_engine.py :sound_engine.py
mpremote cp firmware/main.py :main.py
```

#### 3. Edit `config.py`

Open `config.py` and set your Wi-Fi credentials:

```python
WIFI_SSID = "YourNetworkName"
WIFI_PASSWORD = "YourNetworkPassword"
```

Optionally adjust defaults:

```python
DEFAULT_BRIGHTNESS = 0.5   # 0.0–1.0
SPLASH_TEXT = "UberSDR"    # shown while connecting to Wi-Fi
IDLE_TEXT = ""             # shown when queue is empty ("" = blank)
```

#### 4. Boot the Pico W

Power cycle or press **Reset**. The display will show the splash text while connecting to Wi-Fi, then briefly show the assigned IP address (e.g. `192.168.1.42`).

The HTTP server is now listening on port 80. Test it:

```bash
curl -s http://192.168.1.42/status | python3 -m json.tool
```

---

## UberSDR Notification Channel Setup

Add a `galactic_unicorn` channel to your `notifications.yaml`:

```yaml
enabled: true

channels:
  shack_display:
    type: galactic_unicorn
    galactic_unicorn_url: http://192.168.1.42   # ← your Pico W IP
    galactic_unicorn_color: amber
    galactic_unicorn_size: 1
    galactic_unicorn_effect: auto
    galactic_unicorn_scroll_speed: 35
    galactic_unicorn_duration: 10.0
    galactic_unicorn_priority: 5
    galactic_unicorn_transition: wipe_left

rules:
  - name: cw-spots-display
    event: cw_spot
    channels: [shack_display]
    dedup_by: [callsign, band]
    dedup_window_minutes: 5
    template: "{{ .DXCall }} {{ divf .Frequency 1000 | printf \"%.1f\" }} CW {{ .SNR }}dB"

  - name: chat-display
    event: chat
    channels: [shack_display]
    galactic_unicorn_color: cyan
    galactic_unicorn_priority: 6
    galactic_unicorn_duration: 8.0
    template: "{{ .Username }}: {{ .Message }}"

  - name: ft8-spots-display
    event: digital_decode
    channels: [shack_display]
    filter:
      mode: FT8
    dedup_by: [callsign, band]
    dedup_window_minutes: 10
    template: "FT8 {{ .DXCall }} {{ .Band }} {{ .SNR }}dB"
```

### Channel Configuration Reference

| Field | Default | Description |
|-------|---------|-------------|
| `galactic_unicorn_url` | **required** | Base URL of the Pico W, e.g. `http://192.168.1.42` |
| `galactic_unicorn_color` | `white` | Text colour — named, hex `#RRGGBB`, `rainbow`, or `gradient:c1:c2` |
| `galactic_unicorn_size` | `1` | Font size: `1` (5 px), `2` (7 px), `3` (11 px full height) |
| `galactic_unicorn_effect` | `auto` | `auto`, `static`, `scroll`, `blink`, `pulse` |
| `galactic_unicorn_align` | `left` | `left`, `center`, `right` — for static text only |
| `galactic_unicorn_scroll_speed` | `40` | Pixels per second (1–200) |
| `galactic_unicorn_scroll_pause` | `1.0` | Seconds to pause before scrolling begins |
| `galactic_unicorn_duration` | `10` | Seconds to show message; `0` = forever |
| `galactic_unicorn_priority` | `5` | Queue priority 0–10; higher interrupts lower |
| `galactic_unicorn_transition` | `cut` | `cut`, `fade`, `wipe_left`, `wipe_right` |
| `galactic_unicorn_bg_color` | `""` (black) | Background colour |
| `galactic_unicorn_brightness` | `0.0` | Override brightness 0.0–1.0; `0.0` = don't override |
| `galactic_unicorn_timeout_seconds` | `5` | HTTP request timeout (1–30 s) |
| `galactic_unicorn_insecure_skip_verify` | `false` | Skip TLS verification (LAN self-signed certs only) |
| `rate_limit_minutes` | `0` | Suppress duplicate rule+subject within this window |
| `max_per_minute` | `0` | Hard throughput cap (0 = unlimited) |

### Named Colours

`white`, `red`, `green`, `lime`, `blue`, `cyan`, `yellow`, `orange`, `amber`, `gold`, `magenta`, `purple`, `pink`, `off` / `black`

Special values: `rainbow` (animated HSV cycle), `gradient:orange:red` (left-to-right gradient between any two colours)

---

## HTTP API (Direct Use)

You can POST display and sound commands directly to the Pico W without going through UberSDR's notification system. See [`DISPLAY_PROTOCOL.md`](DISPLAY_PROTOCOL.md) for the full specification.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/display` | Send a display message or control command |
| `POST` | `/sound` | Play an alert sound (non-blocking) |
| `POST` | `/brightness` | Set brightness (`{"value":0.5}`) or toggle auto mode (`{"auto":true/false}`) |
| `GET` | `/status` | Query device state (display, sound, light sensor, auto-brightness) |

### Display examples

**Static centred text:**
```bash
curl -X POST http://192.168.1.42/display \
  -H "Content-Type: application/json" \
  -d '{"type":"display","lines":[{"text":"14.225 USB","color":"amber","size":2,"effect":"static","align":"center","y":"middle"}]}'
```

**Scrolling spot:**
```bash
curl -X POST http://192.168.1.42/display \
  -H "Content-Type: application/json" \
  -d '{
    "type": "display",
    "id": "spot-001",
    "priority": 5,
    "duration": 10.0,
    "transition": "wipe_left",
    "lines": [{
      "text": "W1AW 14025 CW 599",
      "color": "lime",
      "size": 1,
      "effect": "scroll",
      "scroll_speed": 35
    }]
  }'
```

**Two-line layout:**
```bash
curl -X POST http://192.168.1.42/display \
  -H "Content-Type: application/json" \
  -d '{
    "type": "display",
    "lines": [
      {"text": "14.225 USB", "color": "amber", "size": 1, "effect": "static", "align": "center", "y": "top"},
      {"text": "W1AW spotted CW", "color": "lime", "size": 1, "effect": "scroll", "y": "bottom"}
    ]
  }'
```

**Set brightness:**
```bash
curl -X POST http://192.168.1.42/brightness \
  -H "Content-Type: application/json" \
  -d '{"value": 0.4}'
```

**Clear display:**
```bash
curl -X POST http://192.168.1.42/display \
  -H "Content-Type: application/json" \
  -d '{"type":"control","cmd":"clear"}'
```

**Check status:**
```bash
curl -s http://192.168.1.42/status | python3 -m json.tool
```

The status response includes display queue, active message, light sensor reading, sound state, and whether auto-brightness is active:
```json
{
  "ok": true,
  "brightness": 0.5,
  "light_sensor": 1842,
  "auto_brightness": false,
  "active": {"id": "spot-001", "priority": 5, "duration": 10.0, "elapsed": 3.1},
  "queue_depth": 0,
  "queue": [],
  "last_message": {"id": "spot-001", "priority": 5, "duration": 10.0, "lines": [...]},
  "sound": {"playing": false, "volume": 0.5, "queue_depth": 0}
}
```

### Sound examples

Sound playback is **fully non-blocking** — the display continues rendering while audio plays. You can fire a sound and a display request back-to-back and both execute concurrently.

**Simple beep:**
```bash
curl -X POST http://192.168.1.42/sound \
  -H "Content-Type: application/json" \
  -d '{"pattern": "beep"}'
```

**DX alert — loud, repeated:**
```bash
curl -X POST http://192.168.1.42/sound \
  -H "Content-Type: application/json" \
  -d '{"pattern": "dx", "volume": 0.9, "repeats": 2, "gap": 0.3}'
```

**Single tone:**
```bash
curl -X POST http://192.168.1.42/sound \
  -H "Content-Type: application/json" \
  -d '{"pattern": "tone", "frequency": 1000, "duration": 0.5}'
```

**Custom melody:**
```bash
curl -X POST http://192.168.1.42/sound \
  -H "Content-Type: application/json" \
  -d '{
    "pattern": "custom",
    "volume": 0.7,
    "notes": [
      {"freq": 523, "duration": 0.1},
      {"freq": 659, "duration": 0.1},
      {"freq": 784, "duration": 0.1},
      {"freq": 1047, "duration": 0.2}
    ]
  }'
```

**Alert + display simultaneously:**
```bash
# Fire both — they run concurrently
curl -X POST http://192.168.1.42/sound -H "Content-Type: application/json" \
  -d '{"pattern": "alarm", "repeats": 3}'
curl -X POST http://192.168.1.42/display -H "Content-Type: application/json" \
  -d '{"type":"display","priority":9,"lines":[{"text":"HIGH NOISE","color":"red","effect":"blink"}]}'
```

#### Named sound patterns

**Semantic alerts** — use these for application events:

| Pattern | Character | Use for |
|---------|-----------|---------|
| `alert` | Rising perfect 4th (C5→F5) — bright, clean | Generic attention / new event |
| `warning` | Minor-3rd drop + return — tense | Caution, degraded state |
| `error` | Descending tritone — clearly negative | Failure, fault condition |
| `recovery` | Ascending major triad (C5→E5→G5) — bright | Resolved, back to normal |
| `success` | Rising G4→B4→G5 — bright high finish | Task complete, positive outcome |
| `critical` | Rapid C6/G5 alternation (6 pulses) — urgent | Critical fault, immediate action |

**Utility beeps:**

| Pattern | Description |
|---------|-------------|
| `beep` | Single beep (880 Hz) |
| `beep_low` | Single beep (440 Hz) |
| `beep_high` | Single short beep (1175 Hz) |
| `double_beep` | Two quick beeps |
| `triple_beep` | Three quick beeps |

**Informational / ambient:**

| Pattern | Description |
|---------|-------------|
| `notify` | Soft rising C5→G5 — new notification |
| `tick` | Very short click — subtle UI feedback |
| `chime` | Rising C→E→G arpeggio — pleasant |
| `alarm` | Rapid 4-pulse — urgent but not harsh |

**Radio / ham specific:**

| Pattern | Description |
|---------|-------------|
| `spot` | Quick rising E5→A5 — new DX spot |
| `dx` | Three-note rising E5→G5→C6 — DX alert |
| `qso` | Two-tone C5→E5 — QSO event |

**Raw / custom:**

| Pattern | Description |
|---------|-------------|
| `tone` | Raw continuous tone (`frequency` Hz, `duration` s) |
| `custom` | Custom sequence via `notes` array |

---

## Hardware Button Behaviour

All buttons are active at all times — they work regardless of what is currently displayed and interrupt any queued content with a high-priority timed message that expires automatically.

| Button | Action | Config keys |
|--------|--------|-------------|
| **A** | Show the device IP address (cyan if connected, red if not) | `BTN_IP_PRIORITY`, `BTN_IP_DURATION`, `BTN_IP_COLOR` |
| **B** | Show Wi-Fi SSID (top line) + `WiFi OK` / `No WiFi` (bottom line) | `BTN_WIFI_PRIORITY`, `BTN_WIFI_DURATION` |
| **C** | Clear the display queue and restore the idle display | — |
| **D** | Step brightness up by `BRIGHTNESS_STEP`; after max enters **AUTO** mode; press again to exit AUTO and wrap to min. Hold for auto-repeat. | `BRIGHTNESS_STEP`, `BRIGHTNESS_MIN`, `BRIGHTNESS_MAX`, `BTN_D_HOLD_DELAY_MS`, `BTN_D_REPEAT_MS` |
| **LUX ▲** | Increase brightness by `BRIGHTNESS_STEP` (exits AUTO mode if active) | `BRIGHTNESS_STEP`, `BRIGHTNESS_MAX` |
| **LUX ▼** | Decrease brightness by `BRIGHTNESS_STEP` (exits AUTO mode if active) | `BRIGHTNESS_STEP`, `BRIGHTNESS_MIN` |
| **VOL ▲** | Increase speaker volume by `VOLUME_STEP` | `VOLUME_STEP`, `VOLUME_MAX` |
| **VOL ▼** | Decrease speaker volume by `VOLUME_STEP` | `VOLUME_STEP`, `VOLUME_MIN` |

### Auto-brightness mode

Pressing button D past `BRIGHTNESS_MAX` enters **AUTO** mode — the display shows `AUTO` in cyan and the firmware begins reading the ambient light sensor (`gu.light()`) to set brightness automatically.

The brightness cycle is:
```
MIN → +10% → ... → MAX → AUTO → MIN → ...
```

Pressing **D** again or any **LUX** button exits AUTO mode immediately and returns to manual control.

Auto-brightness can also be enabled/disabled via HTTP:

```bash
# Enable auto-brightness
curl -X POST http://<ip>/brightness -H "Content-Type: application/json" -d '{"auto": true}'

# Disable and set a specific level
curl -X POST http://<ip>/brightness -H "Content-Type: application/json" -d '{"auto": false, "value": 0.5}'
```

> **Note:** When auto-brightness is active, any `brightness` field in a display message is **ignored** — the light sensor always wins. This ensures the display always reflects ambient conditions regardless of what content is being shown. Per-message brightness overrides only apply when auto mode is off.

Four heuristics prevent constant micro-adjustments from sensor noise:

| Heuristic | Config key | Default | Effect |
|-----------|-----------|---------|--------|
| EMA smoothing | `AUTO_BRIGHTNESS_SMOOTHING` | `0.2` | Damps rapid fluctuations before any decision |
| Dead-band | `AUTO_BRIGHTNESS_DEADBAND` | `0.02` | Ignores changes < 2% from last written value |
| Stability window | `AUTO_BRIGHTNESS_STABLE_READS` | `2` | Requires 2 consecutive reads outside dead-band |
| Min write interval | `AUTO_BRIGHTNESS_MIN_WRITE_S` | `2.0` | Enforces ≥ 2 s between brightness writes |

```python
# config.py — auto-brightness
AUTO_BRIGHTNESS_INTERVAL_S   = 1.0      # Seconds between sensor reads
AUTO_BRIGHTNESS_SMOOTHING    = 0.2      # EMA factor (lower = smoother)
AUTO_BRIGHTNESS_CURVE        = "linear" # "linear" or "sqrt"
AUTO_BRIGHTNESS_DEADBAND     = 0.02     # Min change to act on (2%)
AUTO_BRIGHTNESS_STABLE_READS = 2        # Reads required before committing
AUTO_BRIGHTNESS_MIN_WRITE_S  = 2.0      # Min seconds between writes

# Sensor calibration — match to your environment (check GET /status → light_sensor)
# Typical indoor shack: dark/covered ~30, bright room ~130
AUTO_BRIGHTNESS_SENSOR_MIN   = 30       # Raw sensor value → BRIGHTNESS_MIN
AUTO_BRIGHTNESS_SENSOR_MAX   = 130      # Raw sensor value → BRIGHTNESS_MAX
```

### Button configuration (`config.py`)

```python
# Brightness step (shared by LUX buttons and button D)
BRIGHTNESS_STEP = 0.1       # Change per press
BRIGHTNESS_MIN  = 0.15      # Floor in auto mode (never fully off)
BRIGHTNESS_MAX  = 1.0       # Ceiling

# Volume step (VOL buttons)
VOLUME_STEP = 0.1
VOLUME_MIN  = 0.0
VOLUME_MAX  = 1.0

# Button A — show IP address
BTN_IP_PRIORITY = 8         # Interrupts most content (0–10)
BTN_IP_DURATION = 5.0       # Seconds before reverting
BTN_IP_COLOR    = "cyan"    # Colour when connected; red when disconnected

# Button B — show Wi-Fi status
BTN_WIFI_PRIORITY = 8
BTN_WIFI_DURATION = 5.0

# Button D — brightness step / AUTO
BTN_BRIGHTNESS_PRIORITY  = 8
BTN_BRIGHTNESS_DURATION  = 1.5   # How long the label stays on screen
BTN_D_HOLD_DELAY_MS      = 500   # ms before auto-repeat begins
BTN_D_REPEAT_MS          = 300   # ms between auto-repeat steps
```

---

## Troubleshooting

**Display shows `WiFi....` and never connects**
- Check `WIFI_SSID` and `WIFI_PASSWORD` in `config.py`
- Ensure the Pico W is within range of the 2.4 GHz network (Pico W does not support 5 GHz)
- Increase `WIFI_CONNECT_TIMEOUT` in `config.py`

**UberSDR can't reach the display**
- Confirm the IP shown on boot matches `galactic_unicorn_url` in `notifications.yaml`
- Check firewall rules — the Pico W listens on TCP port 80
- Try `ping <pico-ip>` from the UberSDR server

**Text is cut off / doesn't scroll**
- Set `"effect": "scroll"` explicitly instead of `"auto"` if the text is borderline width
- Reduce `galactic_unicorn_size` to `1` for longer messages

**Display is too bright / too dim**
- Adjust `DEFAULT_BRIGHTNESS` in `config.py` (0.0–1.0)
- Or use the hardware brightness buttons
- Or set `galactic_unicorn_brightness` per-channel in `notifications.yaml`

**Pico W crashes / reboots**
- Check available RAM: MicroPython on the Pico W has ~200 KB free heap
- Reduce `QUEUE_MAX_SIZE` in `config.py` if memory is tight
- Ensure you're using Pimoroni's MicroPython firmware, not the standard Raspberry Pi build

---

## File Structure

```
clients/galactic_unicorn/
├── README.md                  ← this file
├── DISPLAY_PROTOCOL.md        ← full JSON protocol specification (display + sound)
├── flash.py                   ← automated firmware flasher (Python 3)
├── flash.sh                   ← shell wrapper for flash.py (Linux/macOS)
└── firmware/
    ├── .gitignore             ← prevents config.py and *.uf2 from being committed
    ├── config.py.example      ← template showing all config options (safe to commit)
    ├── config.py              ← GENERATED by flash.py — contains Wi-Fi credentials,
    │                             gitignored, never committed
    ├── display_engine.py      ← rendering engine (colour, layout, effects, queue)
    ├── sound_engine.py        ← async sound sequencer (named patterns, custom notes)
    └── main.py                ← HTTP server, boot animation, button handler,
                                  auto-brightness loop
```

Go source files in the UberSDR server root:
```
galactic_unicorn_notifier.go   ← NotificationChannel implementation
notification_config.go         ← channel config fields + validation (galactic_unicorn section)
notification_manager.go        ← channel registration (buildChannels + Reload)
notification_admin_api.go      ← admin UI channel type descriptor
```
