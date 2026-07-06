# Galactic Unicorn Display Protocol Specification

**Version:** 1.0  
**Target Hardware:** Pimoroni Galactic Unicorn (53×11 RGB LED matrix, Raspberry Pi Pico W)  
**Transport:** HTTP POST to `http://<pico-ip>/display` with `Content-Type: application/json`

---

## Table of Contents

1. [Display Hardware Reference](#1-display-hardware-reference)
2. [Message Types](#2-message-types)
3. [Display Message](#3-display-message)
4. [Line Object](#4-line-object)
5. [Colour Specification](#5-colour-specification)
6. [Effects](#6-effects)
7. [Layout & Positioning](#7-layout--positioning)
8. [Priority & Queue](#8-priority--queue)
9. [Control Commands](#9-control-commands)
10. [HTTP API Endpoints](#10-http-api-endpoints)
11. [Error Responses](#11-error-responses)
12. [Complete Examples](#12-complete-examples)
13. [Field Reference Summary](#13-field-reference-summary)

---

## 1. Display Hardware Reference

| Property | Value |
|----------|-------|
| Width | 53 pixels |
| Height | 11 pixels |
| LEDs | 583 RGB LEDs |
| Colour depth | 24-bit (8-bit per channel) |
| Brightness control | Hardware (0.0 – 1.0) |

### Font Sizes and Line Capacity

The default font (`bitmap6`) is a 6×6 pixel font at scale=1. Heights scale linearly.

| `size` | Font height | Fits on 11 px display? | Two-line auto layout |
|--------|------------|------------------------|----------------------|
| `1` | 6 px | Yes — 5 px spare | Line 0: y=0 (rows 0–5), Line 1: y=5 (rows 5–10), share row 5 |
| `2` | 12 px | Clips 1 px at bottom | Single line only; best at y=0 |
| `3` | 18 px | Clips 7 px at bottom | Single line only; best at y=0 |

> **Two-line layouts with size=1:** Both lines fit. The firmware packs them tightly (no gap) so both are fully visible. `y="top"` places line 0 at y=0; `y="bottom"` places a line at y=5 (rows 5–10).
>
> **size=2 and size=3:** The font is taller than the display. Text is always drawn from y=0 and the bottom 1–7 rows are clipped by the hardware. Use `y="top"` or `y=0` explicitly; `y="middle"` and `y="bottom"` both resolve to y=0 for these sizes.

---

## 2. Message Types

Every JSON body sent to `/display` must contain a `type` field:

| `type` value | Purpose |
|-------------|---------|
| `"display"` | Show content on the LED matrix |
| `"control"` | Send a control command (clear, brightness, cancel, etc.) |

---

## 3. Display Message

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"display"` | Must be the string `"display"` |
| `lines` | array of [Line Objects](#4-line-object) | 1 or 2 line objects |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | auto-generated UUID | Unique identifier. Sending a message with the same `id` as an active or queued message **replaces** it in-place. Use stable IDs for persistent displays (e.g. `"frequency"`) and unique IDs for one-shot events. |
| `priority` | integer 0–10 | `5` | Display priority. See [Priority & Queue](#8-priority--queue). |
| `duration` | number \| `"forever"` | `"forever"` | How long (seconds) to show this message before reverting to the next queued item. `"forever"` means the message stays until explicitly replaced or cancelled. |
| `transition` | string | `"cut"` | Animation when switching to this message. One of: `"cut"`, `"fade"`, `"soft_fade"`, `"wipe_left"`, `"wipe_right"`. |
| `brightness` | number 0.0–1.0 | `null` | Override global brightness for this message only. `null` means use the current global brightness. Restored after message expires. |
| `bg_color` | [Colour](#5-colour-specification) | `[0, 0, 0]` | Background colour for all pixels not drawn by text. |

### Minimal Valid Display Message

```json
{
  "type": "display",
  "lines": [
    { "text": "Hello" }
  ]
}
```

---

## 4. Line Object

Each entry in the `lines` array is a Line Object. A maximum of **2 line objects** are supported per message.

### Required Fields

Either `text` **or** `segments` must be provided (not both).

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | The text to render. UTF-8. Printable ASCII characters are guaranteed supported. |
| `segments` | array of Segment Objects | Multi-colour text. Each segment has its own `text` and `color`. When present, the top-level `text` and `color` fields are ignored. See [Segments](#45-segments). |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `color` | [Colour](#5-colour-specification) | `"white"` | Text colour. Ignored when `segments` is present. |
| `size` | integer 1–3 | `1` | Font size. See [Display Hardware Reference](#1-display-hardware-reference). |
| `effect` | string | `"auto"` | Rendering effect. See [Effects](#6-effects). |
| `align` | string | `"left"` | Horizontal alignment for static text. One of: `"left"`, `"center"`, `"right"`. Ignored when `effect` is `"scroll"`. |
| `y` | integer \| string | `"auto"` | Vertical pixel position. See [Layout & Positioning](#7-layout--positioning). |
| `scroll_speed` | integer 1–200 | `40` | Scroll speed in pixels per second. Only used when `effect` is `"scroll"` or `"auto"` triggers scrolling. |
| `scroll_pause` | number ≥ 0 | `1.0` | Seconds to pause at the start position before scrolling begins, and again after one full pass before looping. |
| `scroll_loop` | boolean | `true` | If `true`, scroll loops continuously. If `false`, text scrolls once and then holds at the end position until the message expires. |
| `scroll_start` | string | `"right"` | Starting position for scroll. One of: `"right"` (text enters from right edge), `"left"` (text starts at x=0 and scrolls left immediately), `"center"` (text starts centred, then scrolls left). |
| `blink_rate` | number 0.1–20 | `2.0` | Blink frequency in Hz. Only used when `effect` is `"blink"`. |
| `pulse_speed` | number 0.1–10 | `1.0` | Pulse cycles per second. Only used when `effect` is `"pulse"`. |
| `pulse_min` | number 0.0–1.0 | `0.1` | Minimum brightness multiplier during pulse. `0.0` = fully off at trough. |

### 4.5 Segments

The `segments` field enables **multi-colour text within a single line**. Each segment is rendered sequentially left-to-right, each in its own colour. This is useful for displaying per-item status indicators (e.g. band conditions) where each item needs a different colour.

#### Segment Object Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | **Yes** | The text for this segment. |
| `color` | [Colour](#5-colour-specification) | No | Colour for this segment. Default: `"white"`. |

#### Example — Band Conditions with Per-Band Colour

```json
{
  "type": "display",
  "id": "band-conditions",
  "priority": 3,
  "duration": 12.0,
  "lines": [
    {
      "segments": [
        {"text": "20m ", "color": "lime"},
        {"text": "17m ", "color": "lime"},
        {"text": "40m ", "color": "amber"},
        {"text": "80m",  "color": "amber"}
      ],
      "size": 1,
      "effect": "static",
      "align": "left",
      "y": "top"
    },
    {
      "segments": [
        {"text": "15m ", "color": "lime"},
        {"text": "10m ", "color": "lime"},
        {"text": "30m",  "color": "amber"}
      ],
      "size": 1,
      "effect": "static",
      "align": "left",
      "y": "bottom"
    }
  ]
}
```

**Visual layout:**
```
┌─────────────────────────────────────────────────────┐
│ 20m 17m 40m 80m                                     │  lime lime amber amber
│ 15m 10m 30m                                         │  lime lime amber
└─────────────────────────────────────────────────────┘
```

> **Note:** `effect`, `align`, `scroll_*`, `blink_*`, and `pulse_*` fields apply to the line as a whole when `segments` is used. The combined text of all segments is used for width measurement and scroll distance. Scroll and blink/pulse effects work correctly with segmented lines.

---

## 5. Colour Specification

The `color` field (on both the top-level message and each line object) accepts any of the following formats. All formats are case-insensitive.

### 5.1 RGB Array

A JSON array of three integers, each in the range 0–255, representing Red, Green, Blue.

```json
"color": [255, 128, 0]
```

### 5.2 Hex String

A CSS-style hex colour string, with or without the leading `#`.

```json
"color": "#FF8000"
"color": "FF8000"
```

Both 6-digit (`#RRGGBB`) and 3-digit (`#RGB`, expanded to `#RRGGBB`) forms are accepted.

```json
"color": "#F80"    // equivalent to "#FF8800"
```

### 5.3 Named Colour

A string from the following table:

| Name | RGB | Hex |
|------|-----|-----|
| `"white"` | `[255, 255, 255]` | `#FFFFFF` |
| `"red"` | `[255, 0, 0]` | `#FF0000` |
| `"green"` | `[0, 255, 0]` | `#00FF00` |
| `"lime"` | `[0, 220, 80]` | `#00DC50` |
| `"blue"` | `[0, 100, 255]` | `#0064FF` |
| `"cyan"` | `[0, 255, 255]` | `#00FFFF` |
| `"yellow"` | `[255, 255, 0]` | `#FFFF00` |
| `"orange"` | `[255, 128, 0]` | `#FF8000` |
| `"amber"` | `[255, 176, 0]` | `#FFB000` |
| `"gold"` | `[255, 215, 0]` | `#FFD700` |
| `"magenta"` | `[255, 0, 255]` | `#FF00FF` |
| `"purple"` | `[128, 0, 255]` | `#8000FF` |
| `"pink"` | `[255, 100, 150]` | `#FF6496` |
| `"off"` | `[0, 0, 0]` | `#000000` |
| `"black"` | `[0, 0, 0]` | `#000000` |

### 5.4 Special Colour Effects

These string values trigger animated colour effects on the text. They override the `effect` field for colour only — the text layout effect (scroll, static, etc.) still applies independently.

| Value | Description |
|-------|-------------|
| `"rainbow"` | Hue cycles through the full HSV spectrum across the text width, animating over time. |
| `"gradient:<from>:<to>"` | Static left-to-right gradient between two colours. `<from>` and `<to>` can be any named colour, hex string, or RGB array encoded as `r,g,b`. |

**Gradient examples:**

```json
"color": "gradient:red:blue"
"color": "gradient:#FF0000:#0000FF"
"color": "gradient:255,0,0:0,0,255"
```

---

## 6. Effects

The `effect` field on a Line Object controls how the text is rendered and animated.

| Value | Description |
|-------|-------------|
| `"static"` | Text is drawn at a fixed position. `align` controls horizontal placement. |
| `"scroll"` | Text scrolls horizontally from right to left. `align` is ignored; use `scroll_start` instead. |
| `"auto"` | **Recommended default.** If the rendered text width ≤ 53 px, behaves as `"static"` (respecting `align`). If the text is wider than 53 px, behaves as `"scroll"`. |
| `"blink"` | Text alternates between visible and invisible at `blink_rate` Hz. Position is static; `align` applies. |
| `"pulse"` | Text brightness pulses sinusoidally between `pulse_min` and 1.0 at `pulse_speed` cycles per second. Position is static; `align` applies. |

> **Note:** `"rainbow"` is a **colour** effect, not a layout effect. Set `"color": "rainbow"` and `"effect": "scroll"` independently to get scrolling rainbow text.

---

## 7. Layout & Positioning

### 7.1 The `y` Field

Controls the vertical pixel position of the top of the text for each line.

| Value | Type | Description |
|-------|------|-------------|
| `"auto"` | string | Firmware auto-stacks lines. Line 0 starts at y=0; Line 1 starts at y = (line_0_font_height + 1). |
| `"top"` | string | Equivalent to `y = 0`. |
| `"middle"` | string | Centres the text vertically: `y = (11 - font_height) // 2`. |
| `"bottom"` | string | Aligns text to the bottom row: `y = 11 - font_height`. |
| integer | number | Exact pixel offset from the top of the display. Valid range: 0–10. |

### 7.2 Auto-Layout Rules

When `y` is `"auto"` on all lines, the firmware applies these rules:

1. **1 line:** Placed at y=0.
2. **2 lines, same size:** Line 0 at y=0, Line 1 at y = (font_height + 1).
3. **2 lines, different sizes:** Line 0 at y=0, Line 1 at y = (line_0_font_height + 1). If this causes overflow (combined height > 11), the firmware clips Line 1 at the bottom edge and logs a warning.

### 7.3 Horizontal Alignment (`align`)

Applies only when `effect` is `"static"`, `"blink"`, or `"pulse"` (i.e. not scrolling).

| Value | Description |
|-------|-------------|
| `"left"` | Text starts at x=0. |
| `"center"` | Text is centred within the 53 px width. Calculated as `x = (53 - text_pixel_width) // 2`. If text is wider than 53 px, falls back to `"left"`. |
| `"right"` | Text ends at x=52. Calculated as `x = 53 - text_pixel_width`. If text is wider than 53 px, falls back to `"left"`. |

### 7.4 Scroll Start Position (`scroll_start`)

Applies only when `effect` is `"scroll"` (or `"auto"` triggers scrolling).

| Value | Description |
|-------|-------------|
| `"right"` | Text begins fully off the right edge (x = 53) and scrolls left. Default. |
| `"left"` | Text begins at x=0 and scrolls left immediately (no entry animation). |
| `"center"` | Text begins centred (x = (53 - text_width) // 2) and then scrolls left. |

---

## 8. Priority & Queue

### 8.1 Priority Values

| Priority | Suggested use |
|----------|--------------|
| `0` | Screensaver / idle display |
| `1–2` | Persistent background info (frequency, time) |
| `3–4` | Low-importance notifications |
| `5` | Default — spots, chat messages |
| `6–7` | Important events |
| `8` | High-priority alerts |
| `9–10` | Critical / emergency alerts |

### 8.2 Queue Behaviour

- **Higher priority interrupts lower priority immediately.** The interrupted message is pushed back onto the queue (if it has remaining duration) or discarded (if `duration` has expired).
- **Equal priority messages queue** in arrival order. The current message finishes its `duration` before the next begins.
- **Lower priority messages** are inserted into the queue in priority order. They will not display until all higher-priority messages have finished.
- **`duration: "forever"` messages** at a given priority block all lower-priority messages indefinitely until replaced or cancelled.
- **Replacing by `id`:** If a new message arrives with the same `id` as an active or queued message, it replaces that entry in-place, preserving its queue position but updating all other fields.

### 8.3 Queue Capacity

The firmware maintains a queue of up to **16 messages**. If the queue is full, the lowest-priority queued message is discarded to make room. If all queued messages have equal priority, the oldest is discarded.

---

## 9. Control Commands

Control commands use `"type": "control"` and a `"cmd"` field.

### 9.1 `clear`

Immediately blanks the display and clears the entire queue.

```json
{
  "type": "control",
  "cmd": "clear"
}
```

### 9.2 `brightness`

Sets the global display brightness. Persists until changed again or the device reboots.

```json
{
  "type": "control",
  "cmd": "brightness",
  "value": 0.4
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `value` | number 0.0–1.0 | Yes | New global brightness level. |

### 9.3 `cancel`

Cancels a specific message by `id`. If the message is currently displayed, the next queued message is shown immediately. If it is queued, it is removed from the queue.

```json
{
  "type": "control",
  "cmd": "cancel",
  "id": "spot-cw-001"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | The `id` of the message to cancel. |

### 9.4 `cancel_all`

Cancels all queued messages. The currently displayed message (if any) finishes its current scroll pass, then the display goes blank.

```json
{
  "type": "control",
  "cmd": "cancel_all"
}
```

### 9.5 `status`

Requests the current device status. The firmware responds with a JSON body (see [HTTP API Endpoints](#10-http-api-endpoints)).

```json
{
  "type": "control",
  "cmd": "status"
}
```

---

## 10. HTTP API Endpoints

### `POST /display`

Send a display or control message.

**Request headers:**
```
Content-Type: application/json
```

**Success response (200 OK):**
```json
{
  "ok": true,
  "id": "spot-cw-001",
  "queued": false,
  "queue_depth": 0
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | `true` on success. |
| `id` | string | The `id` assigned to the message (echoed back, or auto-generated if not provided). |
| `queued` | boolean | `true` if the message was added to the queue rather than displayed immediately. |
| `queue_depth` | integer | Number of messages currently in the queue (not counting the active display). |

### `GET /status`

Returns the current device state without sending a command.

**Response (200 OK):**
```json
{
  "ok": true,
  "uptime_seconds": 3600,
  "brightness": 0.5,
  "active": {
    "id": "frequency",
    "priority": 1,
    "duration": "forever",
    "elapsed": 120.4
  },
  "queue_depth": 2,
  "queue": [
    { "id": "spot-cw-001", "priority": 5, "duration": 10.0 },
    { "id": "chat-001",    "priority": 5, "duration": 8.0  }
  ]
}
```

### `POST /brightness`

Convenience endpoint — equivalent to sending a `brightness` control command.

**Request body:**
```json
{ "value": 0.5 }
```

**Response (200 OK):**
```json
{ "ok": true, "brightness": 0.5 }
```

---

## 11. Error Responses

All errors return a non-200 HTTP status code and a JSON body.

### 400 Bad Request

Returned when the JSON is malformed or a required field is missing or invalid.

```json
{
  "ok": false,
  "error": "missing_field",
  "message": "Field 'lines' is required for type 'display'",
  "field": "lines"
}
```

### 422 Unprocessable Entity

Returned when the message is structurally valid JSON but contains out-of-range values.

```json
{
  "ok": false,
  "error": "out_of_range",
  "message": "Field 'priority' must be an integer between 0 and 10, got 15",
  "field": "priority"
}
```

### 507 Insufficient Storage

Returned when the queue is full and the incoming message has the lowest priority.

```json
{
  "ok": false,
  "error": "queue_full",
  "message": "Queue is full (16 items) and incoming priority (3) is not high enough to displace any queued message"
}
```

---

## 12. Complete Examples

### 12.1 Permanent Frequency Display

A low-priority, permanent display showing the current frequency. Sent once on startup; updated by re-sending with the same `id`.

```json
{
  "type": "display",
  "id": "frequency",
  "priority": 1,
  "duration": "forever",
  "lines": [
    {
      "text": "14.225 MHz USB",
      "color": "amber",
      "size": 2,
      "effect": "static",
      "align": "center",
      "y": "middle"
    }
  ]
}
```

---

### 12.2 CW Spot — Scrolling, Expires After 10 Seconds

```json
{
  "type": "display",
  "id": "spot-cw-001",
  "priority": 5,
  "duration": 10.0,
  "transition": "wipe_left",
  "lines": [
    {
      "text": "W1AW 14025 CW 599",
      "color": "lime",
      "size": 1,
      "effect": "scroll",
      "scroll_speed": 35,
      "scroll_pause": 0.5,
      "scroll_loop": false,
      "y": "middle"
    }
  ]
}
```

---

### 12.3 Two-Line: Static Frequency + Scrolling Spot

```json
{
  "type": "display",
  "id": "freq-and-spot",
  "priority": 5,
  "duration": 12.0,
  "lines": [
    {
      "text": "14.225 USB",
      "color": "amber",
      "size": 1,
      "effect": "static",
      "align": "center",
      "y": "top"
    },
    {
      "text": "W1AW spotted — 599 — CW",
      "color": "lime",
      "size": 1,
      "effect": "scroll",
      "scroll_speed": 30,
      "scroll_loop": true,
      "y": "bottom"
    }
  ]
}
```

**Visual layout:**
```
┌─────────────────────────────────────────────────────┐  53 px wide
│          14.225 USB          │  amber, centred, y=0
│W1AW spotted — 599 — CW >>>  │  lime, scrolling, y=6
└─────────────────────────────────────────────────────┘  11 px tall
```

---

### 12.4 Chat Message — Cyan Scroll, 8 Seconds

```json
{
  "type": "display",
  "id": "chat-g4abc-001",
  "priority": 6,
  "duration": 8.0,
  "transition": "fade",
  "lines": [
    {
      "text": "G4ABC: great signal tonight!",
      "color": "cyan",
      "size": 1,
      "effect": "auto",
      "scroll_speed": 28,
      "scroll_pause": 1.0,
      "y": "middle"
    }
  ]
}
```

---

### 12.5 Two-Line: Two Independent Scrolling Spots

```json
{
  "type": "display",
  "id": "dual-spots",
  "priority": 5,
  "duration": 15.0,
  "lines": [
    {
      "text": "FT8: K1ABC -12dB 7074",
      "color": "blue",
      "size": 1,
      "effect": "scroll",
      "scroll_speed": 25,
      "scroll_loop": true,
      "y": "top"
    },
    {
      "text": "CW: W1AW 14025 599",
      "color": "lime",
      "size": 1,
      "effect": "scroll",
      "scroll_speed": 35,
      "scroll_loop": true,
      "y": "bottom"
    }
  ]
}
```

---

### 12.6 High-Priority Alert — Blinking Red

```json
{
  "type": "display",
  "id": "alert-noise",
  "priority": 9,
  "duration": 5.0,
  "transition": "cut",
  "brightness": 1.0,
  "bg_color": [20, 0, 0],
  "lines": [
    {
      "text": "HIGH NOISE",
      "color": "red",
      "size": 2,
      "effect": "blink",
      "blink_rate": 4.0,
      "align": "center",
      "y": "middle"
    }
  ]
}
```

---

### 12.7 Two-Line: Right-Aligned Callsign + Left-Aligned Frequency

```json
{
  "type": "display",
  "id": "qso-info",
  "priority": 6,
  "duration": "forever",
  "lines": [
    {
      "text": "G4ABC",
      "color": "cyan",
      "size": 1,
      "effect": "static",
      "align": "right",
      "y": "top"
    },
    {
      "text": "14.225 USB",
      "color": "amber",
      "size": 1,
      "effect": "static",
      "align": "left",
      "y": "bottom"
    }
  ]
}
```

**Visual layout:**
```
┌─────────────────────────────────────────────────────┐
│                                                G4ABC│  cyan, right-aligned
│14.225 USB                                           │  amber, left-aligned
└─────────────────────────────────────────────────────┘
```

---

### 12.8 Rainbow Scrolling Screensaver

```json
{
  "type": "display",
  "id": "screensaver",
  "priority": 0,
  "duration": "forever",
  "lines": [
    {
      "text": "UberSDR",
      "color": "rainbow",
      "size": 3,
      "effect": "scroll",
      "scroll_speed": 20,
      "scroll_pause": 2.0,
      "scroll_loop": true,
      "y": "top"
    }
  ]
}
```

---

### 12.9 Gradient Text — Static, Centred

```json
{
  "type": "display",
  "id": "gradient-demo",
  "priority": 3,
  "duration": 10.0,
  "lines": [
    {
      "text": "14.225 MHz",
      "color": "gradient:orange:red",
      "size": 2,
      "effect": "static",
      "align": "center",
      "y": "middle"
    }
  ]
}
```

---

### 12.10 Pulsing Noise Floor Reading

```json
{
  "type": "display",
  "id": "noise-floor",
  "priority": 2,
  "duration": "forever",
  "lines": [
    {
      "text": "NF -120dBm",
      "color": "purple",
      "size": 1,
      "effect": "pulse",
      "pulse_speed": 0.5,
      "pulse_min": 0.3,
      "align": "center",
      "y": "middle"
    }
  ]
}
```

---

### 12.11 Control: Set Brightness

```json
{
  "type": "control",
  "cmd": "brightness",
  "value": 0.35
}
```

---

### 12.12 Control: Cancel a Specific Message

```json
{
  "type": "control",
  "cmd": "cancel",
  "id": "spot-cw-001"
}
```

---

### 12.13 Control: Clear Everything

```json
{
  "type": "control",
  "cmd": "clear"
}
```

---

## 13. Field Reference Summary

### Display Message Top-Level Fields

| Field | Type | Required | Default | Valid Values |
|-------|------|----------|---------|-------------|
| `type` | string | **Yes** | — | `"display"` |
| `lines` | array | **Yes** | — | 1–2 Line Objects |
| `id` | string | No | auto UUID | Any string ≤ 64 chars |
| `priority` | integer | No | `5` | `0` – `10` |
| `duration` | number \| string | No | `"forever"` | `> 0.0` or `"forever"` |
| `transition` | string | No | `"cut"` | `"cut"`, `"fade"`, `"soft_fade"`, `"wipe_left"`, `"wipe_right"` |
| `brightness` | number \| null | No | `null` | `0.0` – `1.0` or `null` |
| `bg_color` | Colour | No | `[0,0,0]` | Any valid Colour |

### Line Object Fields

| Field | Type | Required | Default | Valid Values |
|-------|------|----------|---------|-------------|
| `text` | string | **Yes** | — | Any printable string |
| `color` | Colour | No | `"white"` | Any valid Colour |
| `size` | integer | No | `1` | `1`, `2`, `3` |
| `effect` | string | No | `"auto"` | `"static"`, `"scroll"`, `"auto"`, `"blink"`, `"pulse"` |
| `align` | string | No | `"left"` | `"left"`, `"center"`, `"right"` |
| `y` | integer \| string | No | `"auto"` | `0`–`10`, `"auto"`, `"top"`, `"middle"`, `"bottom"` |
| `scroll_speed` | integer | No | `40` | `1` – `200` |
| `scroll_pause` | number | No | `1.0` | `0.0` – `30.0` |
| `scroll_loop` | boolean | No | `true` | `true`, `false` |
| `scroll_start` | string | No | `"right"` | `"right"`, `"left"`, `"center"` |
| `blink_rate` | number | No | `2.0` | `0.1` – `20.0` |
| `pulse_speed` | number | No | `1.0` | `0.1` – `10.0` |
| `pulse_min` | number | No | `0.1` | `0.0` – `1.0` |

### Colour Formats

| Format | Example | Notes |
|--------|---------|-------|
| RGB array | `[255, 128, 0]` | Three integers 0–255 |
| Hex 6-digit | `"#FF8000"` | With or without `#` |
| Hex 3-digit | `"#F80"` | Expanded to `#FF8800` |
| Named colour | `"amber"` | See named colour table |
| Rainbow effect | `"rainbow"` | Animated HSV cycle |
| Gradient | `"gradient:red:blue"` | Left-to-right, any two colours |

### Control Command Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"control"` | **Yes** | Must be `"control"` |
| `cmd` | string | **Yes** | `"clear"`, `"brightness"`, `"cancel"`, `"cancel_all"`, `"status"` |
| `value` | number | For `brightness` | `0.0` – `1.0` |