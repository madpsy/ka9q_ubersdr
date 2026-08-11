# Multi-monitor — where these files came from

Everything in this directory except this file is a **verbatim copy** of the
collector's multi-monitor page:

| here | upstream (`ubersdr-aux`) |
| --- | --- |
| `index.html` | `collector/static/multi_monitor.html` |
| `multi_monitor.js` | `collector/static/multi_monitor.js` |
| `minimal-radio.js` | `collector/static/minimal-radio.js` |
| `websdr-nr.js` | `collector/static/websdr-nr.js` |
| `shared_session.js` | `collector/static/shared_session.js` |
| `hamlib-control.js` | `collector/static/hamlib-control.js` |

Copied on 2026-08-11. The five `.js` files are byte-for-byte identical and
deliberately unmodified — they are the merge base that matters. `index.html` has
one change, described under "What the page needs" below.

## Smart Listen

The feature this port exists for, and it came across whole: all sixteen of its
functions — `openSnrHistoryModal`, `buildSnrHistoryChart`, `applyPlayBest`,
`setPlayBestHold`, `movingAvgSnr` and the rest — are inside `multi_monitor.js`,
and it makes no server calls at all. The SNR it ranks on is measured from each
instance's own audio stream, so it needs nothing but the receivers it is already
listening to.

Its one external dependency is Chart.js, staged as `vendor/chart.umd.min.js`.

The `snr_history.html` in the nav bar is **not** part of it — that is a separate
collector page that happens to share the name.

## Why a copy and not a rewrite

The logic is not the interesting part of bringing this page across — the look
is. Nearly nine and a half thousand lines of audio scheduling, SNR ranking,
session save and restore, panning and rig control already work, and the protocol
they speak is not going to change. Rewriting them would reintroduce bugs into
all of it for nothing.

What does not fit is the presentation, and that turns out to be well separated:
around 2,400 lines of inline CSS across 211 classes in the HTML, against only
15 `innerHTML` assignments, 51 `class=` and 26 inline `style=` in the whole of
`multi_monitor.js`. The port is therefore a new stylesheet and about ninety
touched lines, not a reimplementation.

## Why they are still unmodified

So that every change made from here is a reviewable diff against a known-good
original. A single commit that both copied five thousand lines and adapted them
would hide a typo in the SNR comparator perfectly.

The upstream is live — `multi_monitor.js` and `hamlib-control.js` were both
touched on 28 July 2026 — so this also leaves a merge base if an improvement is
ever worth pulling across. If this is instead allowed to become a hard fork,
that decision belongs in this file, replacing this paragraph.

## What the page needs that is not here

The libraries are staged by `../build.sh` rather than committed, exactly as
`chooser/vendor/` is, because they are somebody else's files and they already
live in `static/`:

- `vendor/` — leaflet, `L.Terminator.js`, `chart.umd.min.js`,
  `opus-decoder.min.js`, the Twemoji flags subset
- `hamlib/` — `hamlib.js`, `hamlib-serial-bridge.js`, `hamlib.wasm`, as a
  directory because `hamlib-control.js` loads it as a relative base

All of them were checked byte-identical to the copies the collector page loads,
so this is the same file by a shorter path rather than a substitution.

Two upstream stylesheets are **deliberately not** brought over:

- `all.min.css` — 102 KB of Font Awesome, used by this page for exactly one
  glyph (`fa-rotate-right`, on the refresh button). The restyling pass replaces
  it with the icon treatment the rest of the client uses.
- `fonts.css` — the Twemoji flags `@font-face`, which `chooser.css` already
  declares against the same staged `.woff2`.

Until the restyle, that means one missing icon and system flag emoji. Both are
cosmetic and neither stops the page working.

`index.html` therefore differs from upstream in exactly one respect: those two
stylesheet links are gone, and the remaining libraries are loaded from
`vendor/` rather than flat beside the source. The alternative was staging them
flat to keep the file identical, but `.gitignore` excludes staged libraries by
directory, and a flat layout is one forgotten line away from committing 14 MB
of `hamlib.wasm`. This file is the one being restyled wholesale anyway.

## What else was removed from index.html

**The nav bar.** Seven links to sibling pages on the collector's site, plus one
back to its front page. This is a window, not a site, and the way out of it is
to close it. Removed rather than repointed at the public collector, which would
have been a row of buttons that quietly leave the application.

**The "Install Extension" buttons**, both of them, and the inline script that
sniffed the user agent to choose between the Firefox add-on and the Chrome one.
The bridge is built into this client, so they offer nothing — and they were not
merely inert: `useragent.js` keeps Chrome's token in the user agent, so the
Chrome branch matched and the button appeared with a broken image where
`chrome.png` would have been.

`confirmNavAway()` in `multi_monitor.js` is now unreferenced. Left alone: it is
in one of the verbatim files, and dead code there costs less than a diff
against upstream.

Still outstanding: `logo.png` in the `<h1>`, which is a broken image until the
restyle decides what belongs there.

## How it is served

`../monitorserver.js`, on `http://127.0.0.1:<random>`, started with the window
and stopped when it closes. Not `loadFile` like the chooser, because the page
needs a real origin twice over: `hamlib.js` fetches `hamlib.wasm` at run time
and `fetch()` is not allowed on `file://`, and the directory API will not answer
a request from `Origin: null`. That file explains it at more length.

## Two endpoints

`multi_monitor.js` calls `/api/instances?conditions=true&online_only=false` and
`/api/myip`; `discovery.js` in the client above already fetches both from
`https://instances.ubersdr.org`. `minimal-radio.js`, `websdr-nr.js` and
`hamlib-control.js` make no server calls at all — they are audio, DSP and Web
Serial, and connect straight to each instance's own `public_url`.

`shared_session.js` is the exception, and the reason it is last in any plan: it
is the only module with a backend of its own, five `/api/shared-sessions`
endpoints on the collector.
