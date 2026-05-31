# UberSDR Audio — REST API Reference

The REST API exposes every capability of the GUI over HTTP/JSON.  It is
**enabled by default** on all interfaces (`0.0.0.0:9770`).  Pass `--no-api`
to disable it.

## Starting the API server

```
UberSDRAudio                              # API on by default: 0.0.0.0:9770
UberSDRAudio --api-port 9771             # custom port
UberSDRAudio --api-bind 127.0.0.1       # restrict to loopback only
UberSDRAudio --no-api                    # disable the API entirely
UberSDRAudio --record-dir /tmp/sdr       # directory for recording files (default: system temp dir)
```

> **Security note:** The API has no authentication.  Bind to `127.0.0.1`
> (the default) unless you understand the implications of exposing it on the
> network.

---

## Base URL

```
http://<bind>:<port>/api/v1
```

All requests and responses use `Content-Type: application/json`.

---

## Common error responses

| HTTP status | Meaning |
|---|---|
| `400 Bad Request` | Malformed JSON body |
| `404 Not Found` | Resource (profile, instance, etc.) not found |
| `409 Conflict` | Valid value but wrong state (e.g. AGC in FM mode) |
| `422 Unprocessable Entity` | Value out of allowed range or invalid enum |
| `503 Service Unavailable` | Feature not available on the connected instance |

Error body:
```json
{
  "error": "human-readable description",
  "field": "field_name",        // present for 422/409
  "value": <submitted value>,   // present for 422
  "constraint": "0–5000"        // present for 422 range errors
}
```

---

## 1. Status

### `GET /api/v1/status`

Returns a complete snapshot of all current state.  This is the single
authoritative source of truth for any polling client.

**Response `200`:**
```json
{
  "connection": {
    "state": "connected",
    "url": "http://g4abc.local:8080",
    "callsign": "G4ABC",
    "name": "My Station",
    "location": "London, UK",
    "session_remaining_s": 3540,
    "session_unlimited": false,
    "bypassed": false,
    "active_users": 3,
    "max_users": 10,
    "throughput_bps": 7200
  },
  "tune": {
    "frequency_hz": 14200000,
    "mode": "usb",
    "bandwidth_low": 0,
    "bandwidth_high": 2700,
    "bandwidth_hz": 2700,
    "step_hz": 1000
  },
  "audio": {
    "volume": 80,
    "muted": false,
    "channel": "both",
    "format": "opus",
    "device_id": "",
    "device_name": "Default Device"
  },
  "agc": {
    "hang_time_s": 1.1,
    "recovery_rate_db_s": 20.0
  },
  "signal": {
    "baseband_dbfs": -62.3,
    "noise_density_dbfs": -80.7,
    "snr_db": 18.4,
    "audio_dbfs": -24.1,
    "updated_at": "2026-05-29T13:45:00Z"
  },
  "dsp": {
    "available": true,
    "enabled": false,
    "filter": "nr4",
    "filters": ["nr4", "rn2"]
  },
  "flrig": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 12345,
    "direction": "both",
    "ptt_mute": true,
    "connected": true,
    "ptt_active": false
  },
  "sinks": {
    "stdout": false,
    "udp": ["127.0.0.1:5005"]
  },
  "settings": {
    "browser_auto_connect": true
  },
  "record": {
    "state": "idle",
    "format": "",
    "max_duration_secs": 3600
  }
}
```

**Field notes:**
- `connection.state`: `"disconnected"`, `"connecting"`, `"connected"`, `"error"`
- `connection.session_remaining_s`: seconds left; `0` when `session_unlimited` is `true`
- `signal.*`: `-999.0` when no data is available (IQ mode, or not yet received)
- `tune.bandwidth_hz`: the slider value (symmetric for AM/FM, upper edge for USB/CWU, etc.)
- `tune.bandwidth_low` / `tune.bandwidth_high`: the actual values sent to the server
- `settings.browser_auto_connect`: mirrors `GET /api/v1/settings`; included here for convenience
- `record`: mirrors `GET /api/v1/record`; included here for convenience (see §13)

---

## 2. Connection

### `POST /api/v1/connect`

Connect to a specific instance URL.  Disconnects any existing session first.

**Request body:**
```json
{
  "url": "http://192.168.1.10:8080",
  "password": "secret"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | HTTP or HTTPS URL of the instance |
| `password` | string | no | Leave absent or `""` for no password |

**Response `200`:** `{"state": "connecting"}`

**Errors:**
- `422` — `url` is empty or not a valid HTTP/HTTPS URL

---

### `POST /api/v1/disconnect`

Disconnect the current session.  No-op if already disconnected.

**Request body:** none

**Response `200`:** `{"state": "disconnected"}`

---

### `GET /api/v1/instances`

Fetch all discoverable instances: local mDNS (`_ubersdr._tcp`) and the
public registry at `instances.ubersdr.org`.  This triggers a fresh fetch
on every call.

**Response `200`:**
```json
{
  "instances": [
    {
      "source": "local",
      "name": "My Station",
      "callsign": "G4ABC",
      "host": "192.168.1.10",
      "port": 8080,
      "tls": false,
      "location": "London, UK",
      "available_clients": 7,
      "max_clients": 10
    },
    {
      "source": "public",
      "name": "Remote SDR",
      "callsign": "W1AW",
      "host": "sdr.example.com",
      "port": 443,
      "tls": true,
      "location": "Connecticut, USA",
      "available_clients": 0,
      "max_clients": 5
    }
  ]
}
```

**Field notes:**
- `source`: `"local"` (mDNS) or `"public"` (registry)
- `available_clients`: `0` when the instance is full; `-1` when not reported
- `max_clients`: `0` when not reported

---

### `POST /api/v1/instances/connect`

Connect to an instance from the discovered list, matched by callsign, name,
or host/port.  Triggers a fresh discovery fetch before matching.

**Request body** — provide at least one field:
```json
{ "callsign": "G4ABC" }
```
```json
{ "host": "192.168.1.10", "port": 8080 }
```
```json
{ "name": "My Station" }
```

| Field | Type | Notes |
|---|---|---|
| `callsign` | string | Case-insensitive match |
| `name` | string | Case-insensitive substring match |
| `host` | string | Exact match |
| `port` | integer | Used together with `host`; optional if host is unique |
| `password` | string | Optional password for the instance |

Matching priority: `callsign` > `host`+`port` > `name`.  Returns the first
match.

**Response `200`:** `{"state": "connecting", "url": "http://192.168.1.10:8080"}`

**Errors:**
- `404` — no matching instance found
- `422` — no matching fields provided

---

## 3. Connected Instance Description

### `GET /api/v1/instance`

Returns the full description of the currently connected instance, fetched live
from the server's `/api/description` endpoint.

**Response `200`:**
```json
{
  "url": "http://g4abc.local:8080",
  "name": "My Station",
  "callsign": "G4ABC",
  "location": "London, UK",
  "default_frequency": 14200000,
  "default_mode": "usb",
  "max_session_time": 3600,
  "max_clients": 10,
  "dsp": {
    "available": true,
    "filters": ["nr4", "rn2"]
  },
  "allowed_iq_modes": ["iq48", "iq96"]
}
```

**Field notes:**
- `max_session_time`: session length limit in seconds; `0` means unlimited
- `max_clients`: `0` when not reported by the server
- `dsp.available`: `true` when the server has DSP configured and available
- `dsp.filters`: list of filter names the server permits; empty array when DSP is unavailable
- `allowed_iq_modes`: wide IQ modes the server permits; empty array when none are available

**Errors:**
- `503` — not currently connected to an instance
- `503` — connected but the server's `/api/description` could not be fetched

---

## 3a. Bookmarks (proxy)

### `GET /api/v1/bookmarks`

Proxies `GET /api/bookmarks` from the currently connected SDR server.
Passes through any query parameters the caller provides (e.g. `center`,
`width`, `limit`).

**Query parameters** (all optional, forwarded verbatim to the server):

| Parameter | Type | Notes |
|---|---|---|
| `center` | integer | Centre frequency in Hz |
| `width` | integer | Frequency window width in Hz |
| `limit` | integer | Maximum number of bookmarks to return |

**Response `200`:** raw JSON array from the server, e.g.:
```json
[
  { "frequency": 14200000, "mode": "usb", "label": "14 MHz SSB" },
  { "frequency": 7074000,  "mode": "usb", "label": "FT8" }
]
```

The exact shape of each bookmark object is defined by the connected SDR
server; this endpoint passes the response through without modification.

**Errors:**
- `503` — not connected to an SDR server
- `502` — server returned an error or invalid JSON for `/api/bookmarks`

---

## 4. Tuning

### `GET /api/v1/tune`

**Response `200`:**
```json
{
  "frequency_hz": 14200000,
  "mode": "usb",
  "bandwidth_low": 0,
  "bandwidth_high": 2700,
  "bandwidth_hz": 2700,
  "step_hz": 1000,
  "allowed_iq_modes": ["iq", "iq48", "iq96"]
}
```

`allowed_iq_modes` lists the IQ modes the connected server permits.  Empty
when not connected.

---

### `PUT /api/v1/tune`

Set any combination of tuning parameters.  All fields are optional; only
provided fields are changed.  If connected, changes are sent to the server
immediately (same as the GUI).

**Request body:**
```json
{
  "frequency_hz": 14200000,
  "mode": "usb",
  "bandwidth_hz": 2700,
  "step_hz": 1000
}
```

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `frequency_hz` | integer | [10 000, 30 000 000] — **clamped** | 10 kHz – 30 MHz |
| `mode` | string | see Mode table below | |
| `bandwidth_hz` | float | see Bandwidth table below; step 50 Hz | Slider value |
| `bandwidth_low` | integer | — | Direct lo/hi override; ignored if `bandwidth_hz` also provided |
| `bandwidth_high` | integer | — | Direct lo/hi override; ignored if `bandwidth_hz` also provided |
| `step_hz` | integer | one of: 1, 10, 100, 500, 1000, 10000, 100000, 1000000 | |

> **Frequency clamping:** values outside [10 000, 30 000 000] are silently
> clamped (not rejected), matching GUI behaviour.  The response always
> reflects the actual applied value.

**Mode table:**

| Value | Description | Always available |
|---|---|---|
| `"usb"` | Upper sideband | ✓ |
| `"lsb"` | Lower sideband | ✓ |
| `"am"` | AM | ✓ |
| `"sam"` | Synchronous AM | ✓ |
| `"fm"` | FM | ✓ |
| `"cwu"` | CW upper | ✓ |
| `"cwl"` | CW lower | ✓ |
| `"iq"` | IQ (narrow) | ✓ |
| `"iq48"` | IQ 48 kHz | server must permit |
| `"iq96"` | IQ 96 kHz | server must permit |
| `"iq192"` | IQ 192 kHz | server must permit |
| `"iq384"` | IQ 384 kHz | server must permit |

**Bandwidth table** (slider value, Hz):

| Mode(s) | Min | Max | Default |
|---|---|---|---|
| `usb`, `lsb`, `cwu`, `cwl` | 0 | 5000 | 2700 (USB/LSB), 600 (CW) |
| `am`, `sam`, `fm` | 0 | 6000 | 4000 (AM/SAM), 5000 (FM) |
| `iq` | 0 | 12000 | 12000 |
| `iq48`, `iq96`, `iq192`, `iq384` | — | — | **not accepted** |

**Errors:**
- `422` — `mode` not in allowed set
- `409` — wide IQ mode requested but server has not permitted it
- `422` — `bandwidth_hz` out of range for the mode
- `422` — `bandwidth_hz` provided for a wide IQ mode
- `422` — `step_hz` not one of the 8 allowed values

**Response `200`:** the updated tune state (same shape as `GET /tune`).

---

## 5. Audio

### `GET /api/v1/audio`

**Response `200`:**
```json
{
  "volume": 80,
  "muted": false,
  "channel": "both",
  "format": "opus",
  "device_id": "",
  "device_name": "Default Device"
}
```

---

### `PUT /api/v1/audio`

Set any combination of audio settings.  All fields optional.

**Request body:**
```json
{
  "volume": 75,
  "muted": false,
  "channel": "both",
  "format": "opus",
  "device_id": ""
}
```

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `volume` | float | [0, 100] — **clamped** | 0 = silent, 100 = full |
| `muted` | bool | — | `true` = mute (volume preserved for unmute) |
| `channel` | string | `"both"`, `"left"`, `"right"` | |
| `format` | string | `"opus"`, `"pcm-zstd"` | Triggers reconnect if changed while connected |
| `device_id` | string | must be a valid ID from `/audio/devices`, or `""` | `""` = system default |

**Constraints:**
- `format: "opus"` is rejected (`409`) when the current mode is any IQ variant
  (`iq`, `iq48`, `iq96`, `iq192`, `iq384`) — IQ modes require lossless PCM
- Changing `format` while connected triggers a brief disconnect/reconnect,
  identical to the GUI behaviour

**Errors:**
- `422` — `channel` not one of the three allowed values
- `422` — `format` not one of the two allowed values
- `409` — `format: "opus"` requested while in an IQ mode
- `422` — `device_id` not found in the current device list

**Response `200`:** the updated audio state (same shape as `GET /audio`).

---

### `GET /api/v1/audio/devices`

List available audio output devices.

**Response `200`:**
```json
{
  "devices": [
    { "id": "", "name": "Default Device" },
    { "id": "alsa_output.pci-0000_00_1f.3.analog-stereo", "name": "Pci 0000 00 1f 3 analog stereo" }
  ]
}
```

The first entry is always `{"id": "", "name": "Default Device"}`.

---

### `GET /api/v1/audio/stream` *(WebSocket)*

Stream decoded PCM audio frames in real time over a WebSocket connection.
This delivers the same decoded audio that the GUI plays — raw PCM regardless
of whether the server is sending Opus or PCM-zstd on the wire.

**Upgrade:** standard WebSocket handshake (`Upgrade: websocket`).

**Protocol:**

1. Immediately after the upgrade the server sends a **JSON text frame**
   describing the stream:
   ```json
   {"sample_rate": 48000, "channels": 2, "format": "pcm-s16le"}
   ```
   | Field | Type | Description |
   |---|---|---|
   | `sample_rate` | integer | Sample rate in Hz (e.g. 8000, 12000, 16000, 48000) |
   | `channels` | integer | Number of interleaved channels (1 = mono, 2 = stereo) |
   | `format` | string | Always `"pcm-s16le"` — signed 16-bit little-endian PCM |

2. Every subsequent **binary frame** contains one decoded PCM frame
   (~20 ms of audio; typically 320–7680 bytes of little-endian int16 samples,
   interleaved channels).

3. If the stream parameters change mid-session (e.g. the server switches
   sample rate) a new JSON text frame is sent before the next binary frame.

4. The server sends a WebSocket **ping** every 30 s to keep proxies alive.
   Most WebSocket libraries respond with a pong automatically.

**Notes:**
- Volume, mute, and channel-routing settings are **not** applied — the stream
  is raw decoded audio, identical to the stdout/UDP sinks.
- Slow clients have frames dropped rather than buffered indefinitely (per-client
  send buffer holds 8 frames; excess frames are silently discarded).
- Multiple clients may connect simultaneously; each receives an independent copy.
- The endpoint is available regardless of whether the `--stdout` or `--udp-out`
  flags are set.

**Errors (HTTP, before upgrade):**
- `405` — method is not `GET`

**Example (Python `websockets`):**
```python
import asyncio, websockets, json, struct

async def stream():
    async with websockets.connect("ws://127.0.0.1:9770/api/v1/audio/stream") as ws:
        hdr = json.loads(await ws.recv())          # text frame
        print(hdr)  # {"sample_rate": 48000, "channels": 2, "format": "pcm-s16le"}
        while True:
            frame = await ws.recv()                # binary frame
            samples = struct.unpack(f"<{len(frame)//2}h", frame)
            # process samples …

asyncio.run(stream())
```

---

## 6. AGC

### `GET /api/v1/agc`

**Response `200`:**
```json
{
  "hang_time_s": 1.1,
  "recovery_rate_db_s": 20.0
}
```

---

### `PUT /api/v1/agc`

Set AGC parameters.  Both fields optional; only provided fields are changed.

**Request body:**
```json
{
  "hang_time_s": 1.1,
  "recovery_rate_db_s": 20.0
}
```

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `hang_time_s` | float | [0.0, 10.0], step 0.1 | AGC hang time in seconds |
| `recovery_rate_db_s` | float | [1.0, 100.0], step 1.0 | Recovery rate in dB/s |

**Constraints:**
- AGC only applies in `usb` or `lsb` mode.  Returns `409` for any other mode.
- Changes are sent to the server immediately if connected.

**Errors:**
- `409` — current mode is not `"usb"` or `"lsb"`
- `422` — `hang_time_s` outside [0.0, 10.0]
- `422` — `recovery_rate_db_s` outside [1.0, 100.0]

**Response `200`:** the updated AGC state (same shape as `GET /agc`).

---

## 7. DSP (Noise Reduction)

### `GET /api/v1/dsp`

**Response `200`:**
```json
{
  "available": true,
  "enabled": false,
  "filter": "nr4",
  "filters": ["nr4", "rn2"]
}
```

`available` is `false` when the connected instance has no DSP configured.
`filters` is the list of filter names from the server's `/api/description`.

---

### `PUT /api/v1/dsp`

Enable or disable the DSP noise reduction insert.

**Request body:**
```json
{ "enabled": true, "filter": "nr4", "params": { "strength": 0.8 } }
```
```json
{ "enabled": false }
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `enabled` | bool | yes | |
| `filter` | string | when `enabled=true` | must be in the server's filter list |
| `params` | object | no | initial parameter values; see DSP param rules below |

**Errors:**
- `503` — DSP not available on the connected instance
- `422` — `filter` not in the server's filter list
- `422` — a param value is out of its `[min, max]` range
- `422` — a param key is not a known parameter for the selected filter

**Response `200`:** the updated DSP state (same shape as `GET /dsp`).

---

### `PATCH /api/v1/dsp/params`

Update filter parameters mid-stream without disabling/re-enabling the insert.
Only `runtime_safe: true` parameters may be changed this way.

**Request body** — arbitrary key/value pairs:
```json
{
  "strength": 0.8,
  "threshold": 0.3
}
```

**DSP parameter validation rules:**

| Type | Accepted values | Validation |
|---|---|---|
| `"float"` | number or numeric string | must be within `[min, max]` |
| `"int"` | integer or numeric string | must be within `[min, max]` |
| `"bool"` | `true`, `false`, `1`, `0`, `"true"`, `"false"` | — |
| `"string"` | any string | passed through as-is |

**Errors:**
- `503` — DSP not available or not currently enabled
- `422` — unknown parameter key for the active filter
- `422` — parameter is not `runtime_safe` (init-only parameters cannot be changed mid-stream)
- `422` — value out of `[min, max]` range

**Response `200`:** `{"ok": true}`

---

### `GET /api/v1/dsp/filters`

Get the full filter list with parameter metadata.  Triggers a
`get_dsp_filters` request to the server if the metadata has not yet been
fetched.

**Response `200`:**
```json
{
  "available": true,
  "filters": [
    {
      "name": "nr4",
      "description": "Noise reduction filter",
      "params": [
        {
          "name": "strength",
          "type": "float",
          "default": "0.5",
          "min": "0.0",
          "max": "1.0",
          "description": "Reduction strength",
          "runtime_safe": true
        },
        {
          "name": "taps",
          "type": "int",
          "default": "128",
          "min": "32",
          "max": "512",
          "description": "Filter length (init only)",
          "runtime_safe": false
        }
      ]
    }
  ]
}
```

**Errors:**
- `503` — DSP not available on the connected instance

---

## 8. Signal Quality (read-only)

### `GET /api/v1/signal`

Returns the most recently received signal quality readings (snapshot).

**Response `200`:**
```json
{
  "baseband_dbfs": -62.3,
  "noise_density_dbfs": -80.7,
  "snr_db": 18.4,
  "audio_dbfs": -24.1,
  "updated_at": "2026-05-29T13:45:00.123Z"
}
```

**Field notes:**
- All numeric fields return `-999.0` when no data is available (IQ mode,
  not yet connected, or server not sending signal data)
- `snr_db` is derived as `baseband_dbfs − noise_density_dbfs`
- `updated_at` is the timestamp of the last received audio frame that
  contained signal data; `null` if never received

---

### `GET /api/v1/signal/stream`

Server-Sent Events (SSE) stream that pushes signal quality updates at the
same rate the GUI level bars update — approximately every **100 ms** when
connected and receiving audio.

**Request headers required:**
```
Accept: text/event-stream
```

**Response headers:**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**Event format:**

Each event is a single `data:` line containing a JSON object, followed by a
blank line (standard SSE format):

```
data: {"baseband_dbfs":-62.3,"noise_density_dbfs":-80.7,"snr_db":18.4,"audio_dbfs":-24.1,"updated_at":"2026-05-29T13:45:00.123Z"}

data: {"baseband_dbfs":-61.8,"noise_density_dbfs":-80.5,"snr_db":18.7,"audio_dbfs":-23.9,"updated_at":"2026-05-29T13:45:00.223Z"}

```

**Keepalive:** a comment line (`: keepalive`) is sent every **15 seconds**
when no signal data has been received, to prevent proxies and load balancers
from closing idle connections.

**No-data events:** when the SDR disconnects, enters IQ mode, or signal data
is otherwise unavailable, a no-data event is sent immediately:

```
data: {"baseband_dbfs":-999.0,"noise_density_dbfs":-999.0,"snr_db":-999.0,"audio_dbfs":-999.0,"updated_at":null}

```

**Update rate:** driven by the `OnSignalQuality` and `OnAudioLevel` callbacks
in `client.go`, which are throttled to one update per 100 ms by the
`onChunkPlayed` callback in `AudioOutput`.  This matches exactly the rate at
which the GUI level bars refresh.

**Multiple clients:** any number of clients may connect simultaneously; each
gets its own independent stream.  The stream does not close when the SDR
disconnects — it continues sending no-data events until the HTTP client
disconnects or the SDR reconnects.

**Example (curl):**
```bash
curl -N -H "Accept: text/event-stream" http://localhost:9770/api/v1/signal/stream
```

**Example (JavaScript EventSource):**
```javascript
const es = new EventSource('http://localhost:9770/api/v1/signal/stream');
es.onmessage = (e) => {
  const sig = JSON.parse(e.data);
  console.log(`Signal: ${sig.baseband_dbfs} dBFS  SNR: ${sig.snr_db} dB  Audio: ${sig.audio_dbfs} dBFS`);
};
es.onerror = () => {
  // Browser will auto-reconnect after a short delay
};
```

---

## 9. FLRig Sync

### `GET /api/v1/flrig`

**Response `200`:**
```json
{
  "enabled": true,
  "host": "127.0.0.1",
  "port": 12345,
  "direction": "both",
  "ptt_mute": true,
  "connected": true,
  "ptt_active": false
}
```

---

### `PUT /api/v1/flrig`

Update flrig configuration.  All fields optional; only provided fields are
changed.  Changes take effect immediately (same as clicking Apply in the GUI).

**Request body:**
```json
{
  "enabled": true,
  "host": "127.0.0.1",
  "port": 12345,
  "direction": "both",
  "ptt_mute": true
}
```

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `enabled` | bool | — | |
| `host` | string | non-empty after trim | defaults to `"127.0.0.1"` if empty |
| `port` | integer | [1, 65535] | defaults to `12345` if out of range |
| `direction` | string | `"sdr-to-rig"`, `"rig-to-sdr"`, `"both"` | |
| `ptt_mute` | bool | — | mute SDR audio during TX |

> **Port defaulting:** an out-of-range port is silently defaulted to `12345`,
> matching GUI behaviour.  The response reflects the actual applied value.

**Errors:**
- `422` — `direction` not one of the three allowed values

**Response `200`:** the updated flrig state (same shape as `GET /flrig`).

---

## 10. Settings

### `GET /api/v1/settings`

Returns the current application settings.

**Response `200`:**
```json
{
  "browser_auto_connect": true
}
```

| Field | Type | Notes |
|---|---|---|
| `browser_auto_connect` | bool | When `true`, opening the web UI auto-connects to the last-used SDR instance and closing all browser tabs auto-disconnects. |

---

### `PUT /api/v1/settings`

Update one or more settings.  All fields are optional; only provided fields are changed.
Changes are persisted immediately (survive app restart).

**Request body:**
```json
{
  "browser_auto_connect": false
}
```

| Field | Type | Notes |
|---|---|---|
| `browser_auto_connect` | bool | Enable/disable browser auto-connect behaviour. |

**Response `200`:** the updated settings (same shape as `GET /settings`).

---

## 11. Profiles

### `GET /api/v1/profiles`

List all saved profiles in alphabetical order.

**Response `200`:**
```json
{
  "profiles": [
    {
      "name": "14MHz SSB",
      "url": "http://g4abc.local:8080",
      "callsign": "G4ABC",
      "frequency_hz": 14200000,
      "mode": "usb",
      "bandwidth": 2700.0,
      "format": "opus",
      "step_index": 4,
      "device_id": "",
      "volume": 80.0,
      "channel": "both"
    }
  ]
}
```

---

### `GET /api/v1/profiles/{name}`

Get a single profile by name.

**Response `200`:** single profile object (same shape as above).

**Errors:**
- `404` — profile not found

---

### `PUT /api/v1/profiles/{name}`

Save the current settings as a named profile.  Creates a new profile or
overwrites an existing one with the same name.

**Request body:** none (current settings are captured automatically)

**Constraints:**
- `name` (URL path segment) must be non-empty after URL-decoding and trimming
  whitespace

**Response `200`:** `{"name": "14MHz SSB", "saved": true}`

**Errors:**
- `422` — name is empty or whitespace-only

---

### `DELETE /api/v1/profiles/{name}`

Delete a saved profile.

**Response `200`:** `{"name": "14MHz SSB", "deleted": true}`

**Errors:**
- `404` — profile not found

---

### `POST /api/v1/profiles/{name}/load`

Load a saved profile and connect.  Equivalent to double-clicking a profile
in the GUI.

**Request body:** none

**Response `200`:** `{"state": "connecting", "url": "http://g4abc.local:8080"}`

**Errors:**
- `404` — profile not found

---

## 12. Output Sinks

These endpoints allow adding and removing PCM output sinks at runtime,
complementing the `--stdout` and `--udp-out` CLI flags.

### `GET /api/v1/sinks`

**Response `200`:**
```json
{
  "stdout": false,
  "udp": ["127.0.0.1:5005", "192.168.1.20:6000"]
}
```

---

### `POST /api/v1/sinks/stdout`

Enable the stdout PCM sink.  No-op if already enabled.

**Request body:** none

**Response `200`:** `{"stdout": true}`

---

### `DELETE /api/v1/sinks/stdout`

Disable the stdout PCM sink.

**Response `200`:** `{"stdout": false}`

---

### `POST /api/v1/sinks/udp`

Add a UDP PCM sink.

**Request body:**
```json
{ "address": "127.0.0.1:5005" }
```

| Field | Type | Constraints |
|---|---|---|
| `address` | string | valid `host:port`; port [1, 65535] |

**Errors:**
- `422` — `address` is not a valid `host:port`
- `409` — a sink for this address already exists

**Response `200`:** `{"address": "127.0.0.1:5005", "added": true}`

---

### `DELETE /api/v1/sinks/udp/{address}`

Remove a UDP PCM sink.  `address` in the path should be URL-encoded
(e.g. `127.0.0.1%3A5005`).

**Response `200`:** `{"address": "127.0.0.1:5005", "removed": true}`

**Errors:**
- `404` — no sink for this address

---

## 13. Recording

Record the decoded audio to a file on the host.  The recording is written to
the directory specified by `--record-dir` (default: system temp dir).

Filenames are generated automatically:
```
ubersdr-YYYYMMDD-HHMMSS-<freq>kHz-<mode>.<ext>
```
e.g. `ubersdr-20260531-143000-14200kHz-usb.ogg`

**Recording state machine:**

```
idle ──POST /record/start──► recording ──POST /record/stop──► ready
                                 │                               │
                             auto-stop (60 min)          POST /record/start
                                 │                         (deletes old file)
                                 └──────────────────────────────►│
                                                              recording
```

- `idle` — no recording in progress, no file available
- `recording` — actively recording; file is being written
- `ready` — recording stopped; file is available for download

**Auto-stop:** recordings are automatically stopped after **60 minutes**.
The file is properly finalised (WAV header rewritten / OGG EOS page written).

**Disconnect auto-stop:** if the SDR instance disconnects while recording,
the recording is automatically stopped and finalised.

---

### `GET /api/v1/record`

Get the current recording status.

**Response `200` — idle:**
```json
{
  "state": "idle",
  "format": "",
  "max_duration_secs": 3600
}
```

**Response `200` — recording:**
```json
{
  "state": "recording",
  "format": "opus",
  "max_duration_secs": 3600,
  "filename": "ubersdr-20260531-143000-14200kHz-usb.ogg",
  "size_bytes": 245760,
  "started_at": "2026-05-31T14:30:00Z",
  "elapsed_secs": 42.3,
  "remaining_secs": 3557.7
}
```

**Response `200` — ready:**
```json
{
  "state": "ready",
  "format": "opus",
  "max_duration_secs": 3600,
  "filename": "ubersdr-20260531-143000-14200kHz-usb.ogg",
  "size_bytes": 1048576,
  "started_at": "2026-05-31T14:30:00Z",
  "elapsed_secs": 120.0,
  "stopped_at": "2026-05-31T14:32:00Z",
  "duration_secs": 120.0,
  "auto_stopped": false
}
```

| Field | Type | Present when | Notes |
|---|---|---|---|
| `state` | string | always | `"idle"`, `"recording"`, `"ready"` |
| `format` | string | always | `"pcm"`, `"opus"`, or `""` when idle |
| `max_duration_secs` | integer | always | Always `3600` (60 minutes) |
| `filename` | string | state ≠ idle | Base filename only (no path) |
| `size_bytes` | integer | state ≠ idle | Current file size in bytes |
| `started_at` | string | state ≠ idle | ISO-8601 timestamp |
| `elapsed_secs` | float | state ≠ idle | Seconds elapsed since start |
| `remaining_secs` | float | state = recording | Seconds until auto-stop |
| `stopped_at` | string | state = ready | ISO-8601 timestamp |
| `duration_secs` | float | state = ready | Total recording duration |
| `auto_stopped` | bool | state = ready | `true` if stopped by the 60-min timer or disconnect |

---

### `POST /api/v1/record/start`

Start a new recording.  If a completed recording already exists it is deleted
first.

**Request body** (all fields optional):
```json
{ "format": "opus" }
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `format` | string | matches current transport format | `"pcm"` (WAV) or `"opus"` (OGG/Opus) |

- If `format` is omitted, the recording format matches the current transport
  format: `"opus"` when the audio format is `"opus"`, otherwise `"pcm"`.
- On platforms where libopus is unavailable (non-Linux, non-Windows), `"opus"`
  silently falls back to `"pcm"`.

**Response `200`:** recording status (same shape as `GET /record` with `state: "recording"`).

**Errors:**
- `409` — already recording (response includes `elapsed_secs` and `remaining_secs`)
- `422` — `format` not `"pcm"` or `"opus"`
- `500` — could not create the recording file (e.g. disk full, bad directory)

---

### `POST /api/v1/record/stop`

Stop the active recording and finalise the file.

**Request body:** none

**Response `200`:** recording status (same shape as `GET /record` with `state: "ready"`).

**Errors:**
- `409` — not currently recording

---

### `GET /api/v1/record/download`

Download the last completed recording file.

**Response `200`:**
- `Content-Type: audio/ogg` (Opus) or `audio/wav` (PCM)
- `Content-Disposition: attachment; filename="ubersdr-…ogg"`
- Body: raw file bytes

**Errors:**
- `404` — no completed recording available (state is `idle` or `recording`)
- `404` — file not found on disk (deleted externally)

---

### `DELETE /api/v1/record`

Delete the completed recording file and reset state to `idle`.

**Response `200`:** `{"deleted": true}`

**Errors:**
- `404` — no completed recording to delete (state is `idle` or `recording`)

---

## PCM stream format (stdout / UDP)

All PCM sinks output:

- **Encoding:** signed 16-bit little-endian integers
- **Channels:** as received from the server (typically 1 or 2)
- **Sample rate:** as received from the server (8000, 12000, 16000, or 48000 Hz)
- **Frame size:** one decoded frame per UDP datagram (~20 ms; typically 320–7680 bytes)
- **Volume/mute/channel routing:** **not applied** — raw decoded audio only

Stream parameters are printed to stderr on the first frame and whenever they
change:

```
ubersdr-audio: stdout PCM stream: 48000 Hz, 2 channel(s), signed 16-bit little-endian
  ffmpeg:  ffmpeg -f s16le -ar 48000 -ac 2 -i - output.mp3
  aplay:   aplay -f S16_LE -r 48000 -c 2
```

---

## Implementation files

| File | Purpose |
|---|---|
| `api.go` | HTTP server setup, flag parsing (`--no-api`, `--api-port`, `--api-bind`, `--record-dir`), route registration |
| `api_handlers_connection.go` | `GET /status`, `POST /connect`, `POST /disconnect`, `GET /instances`, `POST /instances/connect` |
| `api_handlers_instance.go` | `GET /instance` — live fetch of connected server's `/api/description` |
| `api_handlers_tune.go` | `GET /tune`, `PUT /tune` |
| `api_handlers_audio.go` | `GET /audio`, `PUT /audio`, `GET /audio/devices` |
| `api_audio_ws.go` | WebSocket broker for `GET /audio/stream` — fan-out decoded PCM to connected WS clients |
| `api_handlers_agc.go` | `GET /agc`, `PUT /agc` |
| `api_handlers_dsp.go` | `GET /dsp`, `PUT /dsp`, `PATCH /dsp/params`, `GET /dsp/filters` |
| `api_handlers_signal.go` | `GET /signal` |
| `api_handlers_flrig.go` | `GET /flrig`, `PUT /flrig` |
| `api_handlers_settings.go` | `GET /settings`, `PUT /settings` |
| `api_handlers_profiles.go` | `GET /profiles`, `GET /profiles/{name}`, `PUT /profiles/{name}`, `DELETE /profiles/{name}`, `POST /profiles/{name}/load` |
| `api_handlers_bookmarks.go` | `GET /bookmarks` — proxy to connected server's `/api/bookmarks` |
| `api_handlers_sinks.go` | `GET /sinks`, `POST /sinks/stdout`, `DELETE /sinks/stdout`, `POST /sinks/udp`, `DELETE /sinks/udp/{address}` |
| `api_handlers_record.go` | `GET /record`, `POST /record/start`, `POST /record/stop`, `GET /record/download`, `DELETE /record` |
| `recording_manager.go` | `RecordingManager` (implements `StreamSink`), WAV writer, OGG/Opus writer, 60-min auto-stop |
| `opus_encoder_linux.go` | CGo libopus encoder (Linux) |
| `opus_encoder_windows.go` | DLL-based Opus encoder (Windows) |
| `opus_encoder_other.go` | Stub — falls back to WAV on unsupported platforms |
| `api_sse.go` | SSE broker for `/signal/stream` — fan-out to connected clients; `OnCountChange` callback drives browser auto-connect |
| `app_state.go` | `AppState` struct — shared mutable state between GUI and API |

The `AppState` struct holds all values currently stored as local variables
inside `main()` (frequency, mode, bandwidth, volume, mute, channel, format,
device, AGC values, DSP state, flrig config, latest signal readings).  Both
the Fyne GUI callbacks and the HTTP handlers read/write `AppState`.  Fyne
widget methods are goroutine-safe and can be called directly from HTTP
handlers to keep the GUI in sync.

The SSE broker in `api_sse.go` maintains a set of subscriber channels.
The existing `client.OnSignalQuality` and `client.OnAudioLevel` callbacks
(already throttled to ~100 ms in `AudioOutput.onChunkPlayed`) publish to the
broker, which fans out to all connected SSE clients.  No additional throttling
is needed — the broker fires at exactly the same rate as the GUI bars.
