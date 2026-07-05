# UberSDR — Galactic Unicorn Display Client

Displays UberSDR notification events on a **Pimoroni Galactic Unicorn** LED matrix display (53×11 RGB LEDs, Raspberry Pi Pico W).

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

Copy all three files from [`firmware/`](firmware/) to the root of the Pico W filesystem using [Thonny](https://thonny.org/) or `mpremote`:

```
firmware/
├── config.py         ← edit this first
├── display_engine.py
└── main.py
```

Using `mpremote`:
```bash
mpremote cp firmware/config.py :config.py
mpremote cp firmware/display_engine.py :display_engine.py
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

You can also POST display commands directly to the Pico W without going through UberSDR's notification system. See [`DISPLAY_PROTOCOL.md`](DISPLAY_PROTOCOL.md) for the full specification.

### Quick examples

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

---

## Hardware Button Behaviour

The Galactic Unicorn's built-in brightness buttons work at all times:

| Button | Action |
|--------|--------|
| **Brightness ▲** | Increase brightness by 0.1 (configurable in `config.py`) |
| **Brightness ▼** | Decrease brightness by 0.1 (minimum 0.05) |

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
├── DISPLAY_PROTOCOL.md        ← full JSON protocol specification
├── flash.py                   ← automated firmware flasher (Python 3)
├── flash.sh                   ← shell wrapper for flash.py (Linux/macOS)
└── firmware/
    ├── .gitignore             ← prevents config.py and *.uf2 from being committed
    ├── config.py.example      ← template showing all config options (safe to commit)
    ├── config.py              ← GENERATED by flash.py — contains Wi-Fi credentials,
    │                             gitignored, never committed
    ├── display_engine.py      ← rendering engine (colour, layout, effects, queue)
    └── main.py                ← HTTP server, boot animation, button handler
```

Go source files in the UberSDR server root:
```
galactic_unicorn_notifier.go   ← NotificationChannel implementation
notification_config.go         ← channel config fields + validation (galactic_unicorn section)
notification_manager.go        ← channel registration (buildChannels + Reload)
notification_admin_api.go      ← admin UI channel type descriptor
```
