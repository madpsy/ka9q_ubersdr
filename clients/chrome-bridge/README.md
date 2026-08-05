# UberSDR Bridge — Chrome Extension

A Chrome extension (Manifest V3) that connects to any open UberSDR tab and lets you read and control the radio (frequency, mode, bandwidth) from the browser toolbar popup. It also provides optional bidirectional sync with **flrig** via XML-RPC so your transceiver and SDR stay in tune.

---

## Quick Start

```bash
cd clients/chrome-bridge
make build          # builds dist/ubersdr_bridge_chrome-2.0.0.zip
```

Or without make:

```bash
cd clients/chrome-bridge/extension
zip -r ../dist/ubersdr_bridge_chrome.zip . --exclude "*.DS_Store"
```

---

## Installation

### Developer / Unpacked (no signing required)

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `clients/chrome-bridge/extension/` directory
5. The UberSDR Bridge icon will appear in the toolbar (pin it via the puzzle-piece menu)

Reload the extension from `chrome://extensions` after making changes.

### Chrome Web Store

Build the `.zip` with `make build`, then upload it via the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole).

---

## Features

- **Auto-detects** all open UberSDR tabs — no configuration needed for basic use
- **Multi-instance support** — if you have multiple UberSDR tabs open, pick which one to control
- **Live state display** — frequency, mode, and bandwidth update in real time as you tune
- **Frequency control** — type a frequency in kHz or use ±step buttons (100 Hz → 10 kHz)
- **Mode control** — USB, LSB, CWU, CWL, AM, SAM, FM, NFM
- **Bandwidth control** — set low and high edges independently
- **flrig sync** — optional bidirectional frequency/mode sync with flrig via XML-RPC
- **PTT mute** — silences the receiver while the rig is transmitting, without touching the mute you set
- **VFO A/B** — assign each UberSDR tab to a VFO; switching VFOs in flrig auto-selects the matching tab
- **Profiles** — save and restore sets of UberSDR instances with their frequencies and modes

---

## Tests

```bash
make test          # or npm test — needs esbuild and node, no npm install
```

The content script is tested against the **real** v2 page API rather than a mock
of it: `test/run.sh` bundles the page's own bridge modules and runs the content
script, unedited, against them. A test that presses a popup button therefore
ends in the call the receiver would actually make.

`test/contract.test.js` covers the seams where the two sides can drift apart
silently — the protocol constants duplicated in the content script, the `cmd:*`
messages the service worker and popup send, the manifest, and that this content
script is still identical to the Firefox extension's.

## How It Works

The extension speaks the **UberSDR v2 page API** — the contract is documented in
`static/v2/BRIDGE_API.md`, and this extension is a client of it. It requires the
v2 interface; the older interface is not supported.

`content_script.js` is byte-identical to the one in the Firefox extension, and a
test in each asserts it. That is only possible because the v2 API is a message
channel rather than a JavaScript object: **there is no MAIN-world script any
more**, and with it went the two-world relay, the ping that covered the race
between them, and the eight-second probe.

### Detection

The content script dispatches one `hello` on the page API's event channel, then
listens. A v2 page answers with an `announce` carrying the receiver's identity,
the session, and what it can do; the tab is registered on that. A page that is
not an UberSDR never answers, and the cost there is a single idle listener — no
polling, no timers, and nothing logged.

### State observation

The content script subscribes to the `tuning`, `audio`, `session` and `signal`
topics. The page pushes only what changed, and the signal meter is asked for at
most four readings a second. `content_script.js` maps those topics onto the flat
state object the service worker and popup use, so nothing beyond that file knows
the page's vocabulary.

### Command execution

Commands from the popup are forwarded by the service worker to the content
script, which turns them into page API commands — `tune`, `mode`, `passband`,
`mute`. Each is validated by the page and either succeeds or answers with a
reason, which is logged; a command never silently does nothing. Loading a saved
profile sends frequency, mode and passband as a single `tune`, so the receiver
does not pass through intermediate settings on the way.

### Multi-tab selection

The background service worker maintains a registry of all UberSDR tabs. If only one is open it is selected automatically. If multiple are open, the popup shows a list to choose between them. The selection is persisted in `chrome.storage.local`.

### MV3 / Service Worker

The background script runs as a **service worker** (required by Chrome MV3). Key differences from the Firefox MV2 event page:

- **`chrome.alarms`** is used for the flrig poll keepalive (fires every minute to re-wake the SW if Chrome killed it between poll ticks). The actual 100 ms poll loop runs as a self-scheduling `setTimeout` chain while the SW is alive.
- **`chrome.storage.session`** is used to persist the tab registry and last-known state across SW restarts within a browser session (cleared on browser restart).
- In-memory state (registry, flrig echo-prevention variables) is re-hydrated from `chrome.storage.session` each time the SW starts.

---

## flrig Sync

The extension can sync frequency and mode bidirectionally with [flrig](http://www.w1hkj.com/flrig-help/) running on the same machine.

### Setup

1. Open the popup and expand the **flrig Sync** section
2. Enable the toggle
3. Set the host (`127.0.0.1`) and port (`12345`, flrig's default)
4. Choose direction: **Both ways**, **SDR → rig**, or **Rig → SDR**
5. Click **Save** — the extension will connect and show a green dot when ready

### VFO A/B

If you have two UberSDR tabs open, assign each to VFO A or B using the dropdown in the tab list. Switching VFOs on the radio (or in flrig) will automatically bring the matching tab to the foreground and unmute it.

### PTT Mute

When enabled (📡 button in the header), the selected SDR tab is muted at the browser level while the rig is transmitting (PTT active). It is unmuted automatically when the rig returns to RX.

---

## Bridge Server (Optional)

The extension can relay radio state to a local HTTP server and poll it for commands. This lets any local application interact with UberSDR without needing browser access.

### Protocol

| Method | Path | Direction | Body / Response |
|--------|------|-----------|-----------------|
| `POST` | `/ubersdr/state` | Extension → Server | JSON: `{ freq, mode, bwLow, bwHigh, sessionId }` |
| `GET`  | `/ubersdr/commands` | Extension → Server | JSON array of command objects |
| `GET`  | `/ubersdr/ping` | Extension → Server | Any 200 response |

### Command objects

```json
[
  { "type": "cmd:set_freq",      "freq": 14074000 },
  { "type": "cmd:set_mode",      "mode": "usb" },
  { "type": "cmd:set_bandwidth", "low": 50, "high": 2700 },
  { "type": "cmd:adjust_freq",   "delta": 1000 }
]
```

The server should return `[]` when there are no pending commands.

### Example bridge server (Python)

```python
#!/usr/bin/env python3
"""Minimal UberSDR bridge server — Python 3.8+"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json, queue

SECRET = 'my-secret'
command_queue = queue.Queue()
last_state = {}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not self._check_secret(): return
        if self.path == '/ubersdr/ping':
            self._respond(200, b'ok')
        elif self.path == '/ubersdr/commands':
            cmds = []
            while not command_queue.empty():
                cmds.append(command_queue.get_nowait())
            self._respond(200, json.dumps(cmds).encode())
        else:
            self._respond(404, b'not found')

    def do_POST(self):
        if not self._check_secret(): return
        if self.path == '/ubersdr/state':
            length = int(self.headers.get('Content-Length', 0))
            global last_state
            last_state = json.loads(self.rfile.read(length))
            print(f"State: {last_state}")
            self._respond(200, b'ok')
        else:
            self._respond(404, b'not found')

    def _check_secret(self):
        if SECRET and self.headers.get('X-UberSDR-Secret') != SECRET:
            self._respond(403, b'forbidden')
            return False
        return True

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args): pass

HTTPServer(('127.0.0.1', 7373), Handler).serve_forever()
```

---

## File Structure

```
clients/chrome-bridge/
├── extension/
│   ├── manifest.json        ← MV3 extension manifest
│   ├── background.js        ← Service worker: tab registry, command relay, flrig polling
│   ├── content_script.js    ← Injected into UberSDR pages: state observation & commands
│   ├── popup.html           ← Toolbar popup UI
│   ├── popup.js             ← Popup logic
│   ├── popup.css            ← Popup styles
│   └── icons/
│       ├── icon_source.png  ← Source icon (any size)
│       ├── icon48.png
│       ├── icon96.png
│       └── icon128.png
├── build.mjs                ← Node.js build script (no dependencies)
├── Makefile                 ← Convenience build targets
└── README.md
```

---

## Differences from the Firefox Extension

| Feature | Firefox (`clients/firefox-bridge`) | Chrome (`clients/chrome-bridge`) |
|---|---|---|
| Manifest version | MV2 | **MV3** |
| Background script | Event page (`background.scripts`) | **Service worker** (`background.service_worker`) |
| Toolbar button key | `browser_action` | **`action`**  |
| Host permissions | Inline in `permissions` | **Separate `host_permissions` key** |
| Poll loop | `setInterval` | **`chrome.alarms` keepalive + `setTimeout` chain** |
| State persistence | In-memory (event page stays alive) | **`chrome.storage.session`** (survives SW restarts) |
| Browser API namespace | `browser.*` (Promise-based) | `chrome.*` (shim at top of each JS file) |
| Build tooling | `web-ext` | Plain `zip` / `build.mjs` |

---

## Limitations

- **Audio in background tabs** — Chrome may throttle or suspend audio in non-visible tabs. Frequency and mode control still work; audio decoders (FT8, WEFAX, etc.) may pause.
- **Frequency range** — 10 kHz – 30 MHz. The page refuses anything outside it with a reason rather than clamping silently; a relative step stops at the band edge, as the dial does.
- **Service worker lifetime** — Chrome can kill the service worker after ~30 seconds of inactivity. The `chrome.alarms` keepalive re-wakes it every minute; the poll chain restarts automatically. There may be a brief gap in flrig polling while the SW is asleep.
- **CORS** — the bridge server must include `Access-Control-Allow-Origin: *` in its responses.
