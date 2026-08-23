# Writing a panel for UberSDR

A **panel** is a piece of a receiver's interface that somebody other than the
receiver's author wrote. It sits in a dock beside the built-in panels, can be
floated, minimised, moved to a phone's tab row and switched off, and it can drive
the receiver.

You publish one to the shared collector; an operator enables it on their
instance; it appears for everyone listening to that receiver.

This is the author's guide. The design and its reasoning are in
`CUSTOM_PANELS.md`; the page API a panel talks is `BRIDGE_API.md`, and nearly all
of it applies here unchanged.

A complete worked example lives at **`/v2/example-panel.html`** on any receiver
running this version. Start from it.

---

## 1. The shape of a bundle

One HTML file. It must be wrapped in a `<template>` and it must carry a manifest.

```html
<template id="ubersdr-panel">
<script type="application/ubersdr-panel+json">
{ "ui": 2, "schema": 1, "title": "Memories", "icon": "Bookmark", "group": "tune" }
</script>

<style> .row { display: flex; gap: 6px; } </style>
<div class="row" id="out"></div>

<script type="module">
  const sdr = await ubersdr.ready();
  sdr.on('tuning', (t) => { document.getElementById('out').textContent = t.frequency; });
  await sdr.subscribe(['tuning']);
</script>
</template>
```

Three rules, all of which the collector enforces when you publish:

**The `<template id="ubersdr-panel">` wrapper is required.** It is what makes a
bundle inert anywhere that does not understand it — template content is parsed
into a fragment that is never rendered, whose styles never apply and whose
scripts never run. That matters because the same collector serves receivers still
running the old interface, which would otherwise inject your CSS into their page.

**`<script type="module">` is required for your code.** The API is asynchronous,
and `await ubersdr.ready()` is a syntax error in a classic script in every
browser. A panel without it would publish, enable, and then fail to run.

**It is a fragment, not a document.** No `<html>`, `<head>` or `<body>`; no
external `<script src>`, stylesheet, `<base href>` or `<meta http-equiv=refresh>`.
Inline everything.

---

## 2. The manifest

| Key | Required | Meaning |
|---|---|---|
| `ui` | yes | The interface this panel is for. **`2`**. |
| `schema` | yes | Manifest format version. **`1`**. |
| `title` | yes | Header text, tab label, and the name in the layout manager. |
| `icon` | yes | One of the names in §3. |
| `group` | yes | One of the group ids in §4. |
| `dock` | no | `left`, `right` or `bottom`. Default `left`. |
| `defaultOpen` | no | `false` to ship collapsed. Default `true`. |
| `defaultHidden` | no | `true` to ship hidden but listed. Default `false`. |
| `minimal` | no | `true` if you honour `sdr.minimal` (§6). Default `false`. |
| `fill` | no | `true` to stretch to the dock's height. Bottom dock only. |
| `weight` | no | Share of the bottom dock's width, 0.1–4. Default `1`. |
| `height` | no | Starting height in px, 60–2000, before your panel reports its own. |
| `uses` | no | What you use: `{ "topics": [], "commands": [], "run": [] }`. |

**Placement is a first-run default, not a setting.** `dock`, `defaultOpen`,
`defaultHidden`, `fill`, `weight` and `height` apply the first time somebody's
layout is built. After that their arrangement is theirs, and publishing a new
version will not move your panel about on them.

**`uses` is a declaration, not a permission request.** Nothing enforces it. It is
there so an operator deciding whether to enable your panel can see what it does.
Fill it in honestly.

Anything the receiver cannot make sense of degrades rather than failing: an
unknown `dock` becomes `left`, an unknown `icon` becomes a generic one, an
unknown `group` still leaves your panel reachable. One bad field costs you that
field, not the panel.

---

## 3. Icons

`icon` names one of the interface's own glyphs, so your panel looks like the ones
beside it. The names, as of this version:

```
Anchor Announce Antenna Archive Bars Bell Bolt Bookmark Captions Chat
Chevron ChevronLeft ChevronRight ChevronUp Clock Close Cloud Collapse
Compass Copy Custom Dice Download Drag Expand External Eye EyeOff Fax Gauge
Grid Info Keyboard Knob Layers Link List LockScreen Mic Minus Moon Morse
Mute News Packet Pad Pause Picture Play Plug Plus Podium Pointer Power
Puzzle Radio Record Reset RotateLeft RotateRight Search Share Sliders Snail
Span Stop Sun Target Teleprinter Tick Trash Upload Users ViewSpectrum
ViewSplit ViewWaterfall Volume Waves Wf2D Wf3D WfBoth Wheel Wind ZoomIn
ZoomOut
```

An unknown name gets `Custom`. These names never change — once published, a
manifest naming one keeps working — but new ones are added, so a receiver older
than your panel may fall back for a glyph it does not have yet.

---

## 4. Groups

On a phone the panels are behind six group buttons rather than a long row, and
`group` says which one yours belongs to:

| id | Shown as | What it holds |
|---|---|---|
| `tune` | Tune | Where the receiver is pointed: frequency, markers, bands, bookmarks, rotator, antenna. |
| `activity` | Activity | What is out there: spots, band statistics, space weather, lightning, maps. |
| `decode` | Decode | What a signal is saying: decoders, images, text. |
| `audio` | Audio | How it sounds: volume, filters, noise reduction, recording. |
| `shack` | Shack | Things around the radio: chat, listeners, news, weather, clocks. |
| `setup` | Setup | Set once and forgotten: display, layout, notifications, backup, control surfaces. |

Pick by the question a user is asking when they reach for your panel, not by what
it is built from. An unknown or missing group still leaves the panel reachable —
it rides with the last group — but it will be somewhere nobody expects.

---

## 5. The API

`await ubersdr.ready()` resolves once the receiver has connected the panel. Do it
first; everything else needs it.

```js
const sdr = await ubersdr.ready();

// ── The receiver ─────────────────────────────────────────────────────────────
sdr.receiver                      // { id, name, callsign, location, url, … }

// ── State ────────────────────────────────────────────────────────────────────
await sdr.subscribe(['tuning', 'signal']);
sdr.on('tuning', (t) => { /* t.frequency, t.mode, t.bandwidthLow, … */ });
const now = await sdr.get('signal');   // one-off read
sdr.state('tuning');                   // last value, synchronously, once subscribed
```

**`on` is given the current value, not only later changes.** Underneath, the page
API is a *patch* protocol — subscribing answers with a snapshot and everything
after is a diff — so a topic that does not change produces no further message at
all. A handler that drew only from its own callback would never draw on a
receiver that was already tuned and running, and the panel would sit on its own
"Loading…" for ever. The panel runtime seeds your handler with the opening value,
whether you register it before or after `subscribe`.

```js

// ── Driving it ───────────────────────────────────────────────────────────────
await sdr.command('tune', { frequency: 14074000, mode: 'usb' });
await sdr.command('volume', { volume: 0.7 });
await sdr.run('freq_step_up');         // anything in the function catalogue

// ── Your own data ────────────────────────────────────────────────────────────
sdr.store.all()                        // synchronous: it arrived with the connection
sdr.store.get('cities')
await sdr.store.set('cities', [...]);  // returns null, or why it was refused

// ── The receiver's API ───────────────────────────────────────────────────────
const res = await sdr.fetch('/api/cty/countries');   // /api/ only
if (res.ok) JSON.parse(res.body);

// ── Presentation ─────────────────────────────────────────────────────────────
sdr.minimal                            // is the operator showing you cut down?
                                       // (a value, not an event: changing it
                                       //  restarts the panel with the new answer)
sdr.height(180);                       // usually unnecessary — see §6
```

The topics (`tuning`, `audio`, `signal`, `spectrum`, `session`, `page`, `layout`,
`modes`, `bands`, `functions`), the commands and the `run` catalogue are all
documented in **`BRIDGE_API.md`**, and behave here exactly as they do there. Two
notes worth repeating:

- **`tune` carries mode and passband in one call.** Sending them separately walks
  the receiver through intermediate states, which is audible.
- **`signal` changes continuously** and is rate limited to ten messages a second.
  Ask for less with `subscribe(['signal'], { minIntervalMs: 500 })` if a meter is
  all you need.

### What you may do

Anything a built-in panel may do. There is no capability list and no permission
prompt. If a rotator or antenna switch is fitted and the user has authenticated
for it, your panel can drive it exactly as the built-in one does — and cannot if
they have not, for exactly the same reason.

### What you cannot do

Your panel runs in a sandboxed frame with an opaque origin. It cannot reach the
receiver page's DOM, its storage or its cookies, and it cannot see another panel.

`sdr.fetch` reaches this receiver's `/api/` endpoints and nothing else. It runs
in the page rather than in your frame, so it carries the operator's session, and
that is why it is limited to the read API rather than to everything on the host.
For anything else on the internet, call `fetch()` directly — that works for any
service sending permissive CORS headers, and your requests carry no cookies.

---

## 6. Size, theme and the minimal view

**Height looks after itself.** The panel's document is measured from inside and
reported, so write ordinary flowing HTML and it will fit. `sdr.height(px)` is
there for the rare case where you are drawing to a canvas that has no natural
height.

**Width is not yours to choose, and it changes under you.** A side dock is
220–560 px and the operator drags its edge; a floating window starts at 320×320
and is resized freely; the bottom dock is the window's width; a phone sheet is
the screen's. Design for **220 px first**, then let the panel use more room.

**Media queries inside your bundle measure the panel, not the screen** — it is a
document in its own frame, so its viewport *is* the panel. This is the tool for
adapting, and it needs no JavaScript:

```css
@media (max-width: 280px) { .side-by-side { flex-direction: column; } }
```

**Put `min-width: 0` on flex children that grow**, or a long callsign or URL
pushes the panel wider than its dock and the whole thing gets a scrollbar. Wide
tables and diagrams go in their own `overflow-x: auto` container.

**Do not set a background on `body`.** The dock has already painted the panel's
surface and the frame is transparent over it; painting your own puts a slab
inside the panel. The frame is also told the page's `color-scheme`, so form
controls and scrollbars match the theme without you doing anything.

**Never use `vh`/`vw`, `height: 100%` on `body`, or `position: fixed`.** The
viewport they refer to is the frame, whose height is whatever your panel last
reported — a circular measurement. Give a canvas an explicit pixel height.

**Colours come from the operator's theme**, as CSS custom properties. Use them
and your panel follows the interface, including when they switch:

| Variable | What it is |
|---|---|
| `--bg` | The page behind everything. Rarely what a panel wants. |
| `--surface` | A panel's own surface — the dock has already painted it, so use this only for something raised *on* your panel. |
| `--surface-2` | One step up: buttons, chips, a header row. |
| `--surface-3` | Sunken: input fields, wells, a code block. |
| `--surface-hover` | The hover state of something pressable. |
| `--text` | Body text. **This is the one you want** for ordinary content. |
| `--text-dim` | Labels, units, secondary text. |
| `--text-faint` | Timestamps, hints, anything at the edge of attention. |
| `--border` | Ordinary rules and outlines. |
| `--border-strong` | A divider that needs to be seen. |
| `--accent` | The one interactive thing. Links, the active control. |
| `--accent-ink` | Text *on* an accent-filled surface. |
| `--accent-soft` | An accent-tinted background. |
| `--accent-line` | An accent-tinted border. |
| `--good` `--warn` `--bad` | State. Never the only signal — pair with a word. |
| `--font` | The interface's UI face. |
| `--mono` | Its monospace face — frequencies, callsigns, anything columnar. |
| `--radius` `--radius-sm` `--radius-lg` | Corner radii, so your boxes match the dock's. |
| `--ui-scale` | The operator's zoom for this panel. The base font size already applies it. |

Always give a fallback — `color: var(--text-dim, #9aa4b2)` — because a receiver
older than a variable will not send it.

`--ui-scale` carries the operator's zoom for this panel, and the frame's base
font size already applies it — so **size text in `em`/`rem` and the zoom buttons
in your panel's header work**. Sizing everything in `px` opts out of them.
Palette and zoom changes are pushed to an open panel; you need not poll.

## 6a. Making it look designed

Correct is not the same as finished. A panel whose content sits flush in the
top-left at body size looks like a debug readout, however good its code is. The
interface has a house look — these patterns are taken from its own meters:

**A single reading is centred, large, monospace, and accent-coloured**, with the
unit small and faint *after* the number and the name a quiet label:

```css
.reading {
    display: flex; justify-content: center; align-items: baseline; gap: 10px;
    font-family: var(--mono, monospace); font-size: 1.7em; font-weight: 600;
    color: var(--accent, #7aa2f7); font-variant-numeric: tabular-nums;
}
.reading__value { min-width: 5ch; text-align: center; }
.reading__unit  { font-size: 0.6em; font-weight: 400; letter-spacing: 0.08em;
                  color: var(--text-faint, #6b7482); }
.reading__name  { text-align: center; font-size: 0.85em; color: var(--text-dim, #9aa4b2); }
```

**Reserve a live value's width in `ch`.** A number growing from `7.2` to `-12.4`
shifts everything around it on every update; `min-width: 5ch` holds the slot. Hide
an absent value with `visibility: hidden`, not `display: none`, for the same
reason.

**Several numbers go in a two-up grid** of small boxed cells
(`--surface-3` background, `--border`, `--radius-sm`), collapsing to one column
below about 260 px — not a list of rows.

**Centre a display; left-align a list.** A reading, a clock or a gauge is
centred. Anything scannable needs a fixed left edge. Numbers in a column are
right-aligned with `tabular-nums`.

**One accent per panel.** It marks the thing that matters. If three things are
accented, none of them is.

**Rhythm:** 9 px between blocks, 4–6 px between tight related rows.

---

**The minimal view** is the operator saying "keep this, but smaller". If you
declare `"minimal": true`, honour `sdr.minimal` by dropping what is set-and-forget
and keeping what is watched. You decide what survives; nothing does it for you.

---

## 7. Publishing

Through the admin interface — **UI → Widgets** — or the AI assistant on the same
page, which writes and publishes for you.

The collector checks the bundle as you save it and refuses one that cannot work:
a missing wrapper or manifest, a classic script where a module is required, an
external script or stylesheet, a full document rather than a fragment, or a
JavaScript syntax error. The message says which.

Each save is a version. An operator's receiver notices within about fifteen
minutes and reloads the panel in place — anyone watching sees the new one without
touching anything, and whatever the old one held is gone, which is what an update
means.

A panel written for a later interface than a receiver runs is simply not offered
to it. That is what `ui` is for.

---

## 8. Being a good guest

You are on somebody else's receiver, in a panel they can switch off in one click.

- **Do not retune without being asked.** The dial is shared with whatever else
  the user is doing.
- **Use `duck`, never `mute`**, for anything transient. `mute` is the operator's
  own setting and yours to leave alone.
- **Poll gently.** A receiver serves many listeners, and every one of them is
  running your panel.
- **Fail quietly and visibly.** Say what went wrong in your own panel rather than
  throwing; nobody can see your console.
- **Store little.** A couple of megabytes is the cap, and it is shared with the
  browser's own storage for the site.
