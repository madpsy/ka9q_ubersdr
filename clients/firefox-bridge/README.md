# UberSDR Bridge — Firefox Extension

## Quick Start

```bash
cd clients/firefox-bridge
make build          # installs deps + builds dist/ubersdr_bridge-1.0.0.zip
make dev            # opens Firefox with the extension loaded (live reload)
make lint           # lint with web-ext
make clean          # remove dist/ and node_modules/
```

Or using npm directly:

```bash
cd clients/firefox-bridge
npm install         # install web-ext
npm run build       # → dist/ubersdr_bridge-1.0.0.zip
npm run dev         # live-reload dev mode in Firefox
npm run lint        # lint
```

The built `.zip` file is a valid Firefox `.xpi` — rename it if needed. Load it in Firefox via `about:debugging → This Firefox → Load Temporary Add-on`.

---


A Firefox extension that connects to any open UberSDR tab and lets you read and control the radio (frequency, mode, bandwidth) from the browser toolbar popup. It also provides an optional HTTP relay to a local bridge server so external applications (loggers, CAT control software, WSJT-X, etc.) can interact with UberSDR without touching the server API directly.

---

## Features

- **Auto-detects** all open UberSDR tabs — no configuration needed for basic use
- **Multi-instance support** — if you have multiple UberSDR tabs open, pick which one to control
- **Live state display** — frequency, mode, and bandwidth update in real time as you tune
- **Frequency control** — type a frequency in Hz or use ±step buttons (100 Hz → 10 kHz)
- **Mode control** — USB, LSB, CWU, CWL, AM, SAM, FM, NFM
- **Bandwidth control** — set low and high edges independently
- **Bridge server relay** — optional: POST state to a local HTTP server and poll it for commands

---

## Installation (Developer / Temporary)

Firefox does not require extensions to be signed for temporary installation during development.

1. Open Firefox and navigate to `about:debugging`
2. Click **This Firefox** in the left sidebar
3. Click **Load Temporary Add-on…**
4. Navigate to `clients/firefox-bridge/extension/` and select `manifest.json`
5. The extension icon (📡) will appear in the toolbar

The extension is loaded until Firefox is restarted. Reload it from `about:debugging` after making changes.

### Permanent Installation

To install permanently without signing, use Firefox Developer Edition or Firefox Nightly with `xpinstall.signatures.required` set to `false` in `about:config`. For production use, submit to [addons.mozilla.org](https://addons.mozilla.org).

---

## Icons

The extension expects icon files at:

```
extension/icons/icon48.png   (48×48 px)
extension/icons/icon96.png   (96×96 px)
```

Create simple PNG icons (a radio tower or antenna symbol works well). Without them the extension loads fine but shows a blank toolbar button.

---

## How It Works

### Detection

The content script (`content_script.js`) is injected into every page. It waits up to 5 seconds for `window.radioAPI` and `window.userSessionID` to appear — globals that only exist on UberSDR pages (set by `static/extensions.js` and `static/app.js`). If found, it registers the tab with the background script.

### State observation

The content script subscribes to `window.radioAPI.on('frequency_changed', ...)`, `mode_changed`, and `bandwidth_changed` — the same event bus used by in-page extensions like FT8 and WEFAX. No polling, no DOM scraping, no monkey-patching.

### Command execution

Commands from the popup are forwarded by the background script to the content script in the target tab. The content script calls `window.setFrequency()` (from `app.js`) or `window.radioAPI.setMode()` / `window.radioAPI.setBandwidth()` — the same functions the in-page UI uses.

### Multi-tab selection

The background script maintains a registry of all UberSDR tabs. If only one is open it is selected automatically. If multiple are open, the popup shows a radio-button list to choose between them. The selection is persisted in `browser.storage.local`.

---

## Bridge Server (Optional)

The extension can relay radio state to a local HTTP server and poll it for commands. This lets any local application (running on the same machine) interact with UberSDR without needing browser access.

### Protocol

| Method | Path | Direction | Body / Response |
|--------|------|-----------|-----------------|
| `POST` | `/ubersdr/state` | Extension → Server | JSON: `{ freq, mode, bwLow, bwHigh, sessionId }` |
| `GET`  | `/ubersdr/commands` | Extension → Server | JSON array of command objects (see below) |
| `GET`  | `/ubersdr/ping` | Extension → Server | Any 200 response (used by the Test button) |

### Command objects (returned by `/ubersdr/commands`)

```json
[
  { "type": "cmd:set_freq",      "freq": 14074000 },
  { "type": "cmd:set_mode",      "mode": "usb" },
  { "type": "cmd:set_bandwidth", "low": 50, "high": 2700 },
  { "type": "cmd:adjust_freq",   "delta": 1000 }
]
```

The server should return an empty array `[]` when there are no pending commands. Commands are consumed on each poll (500 ms interval).

### Security

Set a shared secret in the popup's Bridge Server section. The extension sends it as the `X-UberSDR-Secret` HTTP header on every request. Your bridge server should validate this header and reject requests that don't match.

The bridge server should bind to `127.0.0.1` only, not `0.0.0.0`.

### Example bridge server (Python)

```python
#!/usr/bin/env python3
"""Minimal UberSDR bridge server — Python 3.8+"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json, threading, queue

SECRET = 'my-secret'   # Must match the extension setting
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
            body = self.rfile.read(length)
            global last_state
            last_state = json.loads(body)
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

    def log_message(self, *args): pass  # Suppress default logging

# Queue a tune command from your application:
# command_queue.put({"type": "cmd:set_freq", "freq": 14074000})

HTTPServer(('127.0.0.1', 7373), Handler).serve_forever()
```

---

## File Structure

```
clients/firefox-bridge/
├── extension/
│   ├── manifest.json        ← MV2 extension manifest
│   ├── background.js        ← Event page: tab registry, command relay, bridge polling
│   ├── content_script.js    ← Injected into UberSDR pages: state observation & commands
│   ├── popup.html           ← Toolbar popup UI
│   ├── popup.js             ← Popup logic
│   ├── popup.css            ← Popup styles
│   └── icons/
│       ├── icon48.png
│       └── icon96.png
└── README.md
```

---

## Limitations

- **Audio in background tabs** — `window.audioContext` may be suspended by Firefox when a tab is not visible. The extension does not attempt to resume it; audio decoders (FT8, WEFAX, etc.) may pause. Frequency and mode control still work.
- **Frequency range** — clamped to 10 kHz – 30 MHz, matching UberSDR's `setFrequency()` validation.
- **Manifest V2** — uses MV2 for maximum Firefox compatibility. Firefox supports MV3 but MV2 event pages are simpler and more reliable for background polling.
- **CORS** — the bridge server must include `Access-Control-Allow-Origin: *` (or the extension origin) in its responses, otherwise `fetch()` from the background script will be blocked.
