// Everything about how the spectrum and waterfall *look*, kept separate from
// the radio state so a display tweak never touches the signal path (and so the
// canvas can read a single object out of a ref).

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from '../react.js';
import { UI_CONFIG_DEFAULTS, parseUiConfig } from './uiConfig.js';
import { UI_COLOR_VARS, uiColorVars } from '../lib/uiColors.js';
import { invalidateThemeColors } from '../lib/spectrumTrace.js';
import { IF_VIEW_DEFAULT } from '../lib/ifSpectrum.js';
import { SHAPE_SEC_DEFAULT } from '../lib/ifShape.js';

const STORAGE_KEY = 'ubersdr.v2.display';

export const DEFAULTS = {
    // The first-run palette. Classic over turbo: black-blue-cyan-yellow-white
    // is what an SDR waterfall has looked like since the first ones, so it is
    // the one people arrive already able to read. A stored choice wins — see
    // load() — so this only decides what a new visitor gets.
    palette: 'classic',
    contrast: 1.0,          // gamma applied to the waterfall colour mapping
    autoRange: true,
    // Minimum dynamic range in auto-level mode, dB. null follows the operator's
    // `min_span` from /api/ui-config; 0 means no minimum ("Auto"), as in v1.
    autoMinSpan: null,
    floorDb: -110,
    ceilDb: -40,
    smoothing: 0.5,         // 0 = off, ->1 = heavier temporal averaging
    fill: true,             // solid area under the spectrum trace
    peakHold: false,
    peakDecay: 6,           // dB per second; 0 = hold indefinitely
    grid: false,
    // The receiver's name, location and conditions, drawn in the top right of the
    // spectrum — see drawStationId. On, because it is what says whose receiver
    // this is, and a screenshot without it is a waterfall from nowhere.
    //
    // The operator can switch it off for everybody (station_id_overlay in the
    // server's ui-config); this is the listener's half of the same question, for
    // somebody who would rather have those pixels of spectrum back. Neither
    // overrides the other — off at either end is off.
    stationInfo: true,
    waterfallRate: 20,      // committed rows per second
    rowHeight: 2,           // device px per row
    // Slide each new row into view over the gap until the next one, instead of
    // letting it appear in a single frame. It costs nothing per frame — the
    // slide is a composited transform, and the canvas is still painted once per
    // row — but it is a switch because the browser resamples the picture while
    // it is in flight, which is very slightly soft on a non-HiDPI screen.
    smoothScroll: true,
    // What the waterfall's history does when the view moves under it.
    //
    //   'follow' — the history is shifted with the axis, so a signal stays in
    //              its own column and the whole picture keeps meaning one
    //              frequency scale. What moves in from the edge is black,
    //              because there is no history for a part of the band that was
    //              not on screen. The default: a waterfall is a picture of the
    //              band, and one whose old rows say a carrier was 3 kHz from
    //              where it is now is a picture that has to be read twice — once
    //              for the trace and once for how far it has been dragged since.
    //              Black at the edge is honestly nothing, and reads as nothing.
    //   'hold'    — the rows stay where they were painted. A signal's trail keeps
    //              the exact shape it had and nothing is ever thrown away, which
    //              is what every waterfall of this kind has always done and why
    //              it is still here: the cost is that after a pan the history no
    //              longer lines up with the frequency axis.
    waterfallPan: 'follow',
    // How the waterfall's history is drawn: '2d' is the heat map, '3d' is the
    // perspective surface (lib/dss.js), 'both' splits the pane between them.
    //
    // '2d' everywhere, including where the machine could clearly manage more.
    // The surface is a different way of reading a band rather than a better one
    // — it occludes, which the heat map never does — so it is something to go
    // and find, not something to be given.
    waterfallMode: '2d',
    // How far back the surface reaches, in seconds. Literally that: a row is
    // placed by how long ago it arrived, so this is the span on screen and not a
    // number something else is derived from. See lib/dss.js, and the note there
    // on the two designs that were tried before it and why they failed.
    dssSeconds: 10,
    markerBands: true,      // band allocations in the marker bar
    markerBookmarks: true,       // bookmark pills the receiver publishes
    markerLocalBookmarks: true,  // bookmark pills saved in this browser
    markerVoice: true,           // detected voice activity (only where the receiver has it)
    // Callsigns the voice skimmer has heard and validated — the addon's Confirmed
    // column, on the bar. A different question from markerVoice above: that one is
    // "speech was heard here in the last ninety seconds", this one is "this station
    // identified itself". Only where the voiceskimmer addon is installed.
    markerVoiceConfirmed: true,
    // The other VFOs — where A, B, C and D are parked. Not the one you are on:
    // that is the dial, and the spectrum already marks it.
    markerVfos: true,
    // Packet channels, from the packet addon: a pill per configured channel carrying
    // the stations heard on it. Only where the addon is installed. Unlike every other
    // marker this one is a *shared* frequency rather than one station, which is why its
    // tooltip is a list — see packetTip in MarkerBar.
    markerPacket: true,
    // Spot markers, per feed and only where the instance has it. Digital spots
    // are deliberately absent: a decoder band puts every station on one
    // frequency, so they would stack into a single illegible pile rather than
    // showing you where to tune.
    markerDxSpots: true,
    markerCwSpots: true,
    viewMode: 'split',      // 'split' | 'spectrum' | 'waterfall'
    split: 0.25,            // fraction of the centre area used by the spectrum
                            // (only consulted in 'split' mode)
    // Whether the frequency scale doubles as a splitter that can be dragged.
    //
    // On by default, because grabbing the join is how you would expect to move
    // it and the slider is two panels away. Off for the operator who keeps
    // catching it: the scale is also the strip you point at to read a frequency
    // off, and on a touchscreen a finger that meant to do that and moved four
    // pixels has re-shared the display instead. Only the drag goes — the slider
    // and the double-click reset both still work, so nothing becomes unreachable.
    splitDrag: true,
    // Whether the passband edges on the spectrum can be dragged to set the
    // filter width.
    //
    // On by default, and for the same reason the splitter drag is: grabbing the
    // edge of the passband is how you would expect to widen it, and it is the
    // only way to set the two sides independently without opening a panel.
    //
    // Off is for the operator who keeps catching it. The edges sit either side
    // of the dial, which is exactly where you click to tune — and a click that
    // landed a few pixels out has changed what you are listening *through*
    // rather than what you are listening to, which is a harder mistake to spot
    // and to undo than a mistuned dial. A touchscreen makes it likelier still,
    // since the grab zone is widened for a fingertip. Only the drag goes: the
    // Receiver panel's slider, the top bar's filter chip and the Multipad's
    // width row all still set it.
    edgeDrag: true,
    // Resting opacity of floating panel windows, 0.5..1 from the Layout panel.
    // 1 is solid, i.e. the effect off.
    floatOpacity: 0.8,
    // The Receiver panel's step size, shared so click-to-tune on the spectrum
    // lands on the same grid as the +/- buttons. 500 Hz suits SSB, which is
    // what most of this band is.
    tuneStep: 500,
    // What the wheel does over the spectrum: 'zoom' or 'tune' by tuneStep.
    wheelAction: 'zoom',
    // What a zoom holds still: 'cursor' keeps the frequency under the pointer
    // or the fingers where it is, 'tuned' re-centres on the dial each step
    // (which is what the toolbar's +/- buttons do). Read by the wheel and by
    // the spectrum's pinch; only consulted when wheelAction is 'zoom'.
    //
    // 'auto' is the default and means cursor on a pointer, tuned on a phone —
    // see resolveZoomAnchor. The two devices genuinely want opposite things.
    // A wheel is precise and sits over the signal you are already pointing at,
    // so holding that still is exactly right. A pinch is two fat fingers whose
    // midpoint is wherever they happened to land, on a screen where the dial is
    // the only thing you are actually interested in — anchoring on the fingers
    // there walks the view off the signal you were listening to.
    zoomAnchor: 'auto',
    // Halve the spectrum poll rate after a few minutes with no input, and put
    // it back on the first sign of life (IdleWatch). On by default, as it is in
    // v1, because the data it saves is data nobody was looking at — but it is a
    // switch because "nobody is looking" is a guess, and someone watching a
    // band for a signal to appear is not idle in the sense that matters.
    // Hovering a collapsed dock's rail slides it out over the centre, the way
    // an auto-hidden taskbar does. On by default: the docks that ship collapsed
    // are otherwise a click each to look into and a click each to put back.
    //
    // A peek never becomes the stored state — see Dock — so this changes what
    // hovering does and nothing about what a click means.
    hoverPanels: true,
    // Minutes of nothing happening before the spectrum drops to half rate, one
    // of THROTTLE_CHOICES in radio/idle.js. 0 is never.
    //
    // null means "not chosen" and resolves per device — sooner on a phone, where
    // the connection is likelier to be metered — which is the only way one
    // stored value can mean the right thing on both. See throttleMinutes.
    idleThrottleMin: null,
    // Minutes of nothing happening before the spectrum socket is closed
    // altogether, one of PAUSE_CHOICES. 0 is never, and on a desktop that is what
    // "not chosen" resolves to — see pauseMinutes. Unlike the throttle this does
    // not undo itself on the next mousemove: the display says it is paused and
    // waits to be asked, because a socket reopening because somebody walked past
    // the desk is the saving thrown away.
    idlePauseMin: null,
    // The diagnostic readout over the waterfall: 'off', 'left' or 'right'.
    //
    // null means "not chosen" and resolves per device, the same shape as the two
    // idle delays above: bottom left on a desktop, off on a phone. A desktop has
    // the room and the operator is usually sitting in front of the receiver
    // working out why something looks wrong; a phone has neither the pixels nor
    // the corner to spare — the pad, the sheet and the chips are all down there —
    // and one of the figures is the address you are connecting from, which is not
    // something to have on screen by default on a device used in public.
    //
    // See statsPlace, and lib/spectrumStats.js for what it shows.
    spectrumStats: null,
    // How many peak markers to point at the strongest signals in the view. Off, because
    // the trace already shows where the signals are and this is for when you want them
    // named — a spectrum that arrives covered in labels has decided that for you.
    // Spectrum pane only: see lib/spectrumPeaks.js and drawPeakMarks in SpectrumView.
    peakMarks: 0,
    // How far above the noise floor a signal has to be, in dB, to earn one of those
    // markers — named to differ from the peakSnr clamp it is passed through, since a
    // bare key here reads exactly like a use of that function. The count above is
    // therefore a ceiling and not a quota: on a quiet band
    // this is what leaves the spectrum clear instead of filling it with markers on
    // noise. Ten decibels is a signal you can hear. See lib/spectrumPeaks.js.
    peakMinSnr: 10,
    // Whether those markers sit in a row along the top of the pane with a hairline down
    // to each signal ('top', the default, because a row of labels at one height reads as
    // a list and never covers a peak) or ride the trace on their own peaks ('signal').
    // See PEAK_PLACES; the key is named apart from the peakPlace clamp for the reason
    // given above.
    peakMarksAt: 'top',
    // Phone only: whether the row of panel names stays on screen while a sheet is open.
    //
    // True by default: moving between panels is one tap rather than close-then-open, and
    // the row always being there is what most people expect of a tab bar. It costs about
    // a tenth of a handset's height, so somebody who wants every pixel for the sheet can
    // turn it off and get the older close-then-open behaviour — see the note at the top
    // of MobileShell.
    mobileTabsAlways: true,
    // Whether the Quick bands panel paints its amateur band keys with the FT8
    // conditions (see bandTone). On, because that colouring is most of why the
    // panel is worth a glance — but a receiver used for one band, or an operator
    // who reads the conditions from the space weather table and finds a wall of
    // green and amber noisy, can have the keys plain.
    //
    // The Multipad's band row keeps its colours either way: the toggle is in the
    // Quick bands panel, and a switch in one panel silently restyling another is
    // worse than the two disagreeing. On a phone the colour is also the whole
    // reason that row is there.
    bandColours: true,
    scopeView: 'both',      // audio scope panel: 'both' | 'scope' | 'waterfall'
    scopeFft: 4096,         // analyser FFT size while that panel is open
    scopeTimebase: 20,      // ms across the oscilloscope
    // What the scope canvas draws: 'bars' (the spectrum as a bar meter) or
    // 'wave' (the oscilloscope). Tapping the canvas swaps them — see
    // ScopePanel.
    //
    // Bars by default because they answer the question most people open this
    // panel with — what is in the audio — where the waveform answers a narrower
    // one that mostly matters for CW and carriers. The waveform is one tap
    // away and the choice is remembered.
    // Frames a second the spectrum loop may run at, 0 being the display's own
    // rate and the default. Not a debug setting, though it started as one: it is
    // the single largest thing an operator can do about what this page costs a
    // machine, and a laptop on battery watching a quiet band has every reason to
    // draw at fifteen. Armed from a timer rather than gated inside the animation
    // frame — a loop that re-arms every frame and returns early keeps the tab
    // continuously animating, which is the cost being avoided. See SpectrumView.
    //
    // null is "not chosen", and the default splits by device — see
    // resolveMaxFps. An explicit 0 is a choice like any other and survives,
    // which is the same rule statsPlace and the idle delays follow.
    maxFps: null,
    scopeShape: 'bars',
    // ── The IF Spectrum panel ───────────────────────────────────────────────
    //
    // Its own settings rather than the main display's, because the two panes are
    // watched for different things: the main waterfall is a survey of a band and
    // wants a slow, wide, calm picture, and this one is a magnifier held over a
    // signal you are working. The palette, contrast, fill, grid and smoothing
    // *are* shared — those are what the display looks like, and two panes of one
    // instrument disagreeing about that would read as two instruments.
    //
    // Which of the five pictures it draws. Fusion to begin with — the trace laid
    // over its own waterfall rather than beside it. See IF_VIEW_DEFAULT for why:
    // a dock column cannot afford to halve a pane this short, and the two layers
    // are the same measurement at two ages, so they do not compete.
    ifView: IF_VIEW_DEFAULT,
    // Multiplier on the fitted window — the passband and the dial, with a
    // quarter again around them, which is the shape the mode gives it. 1 is the
    // fit, which is the panel's whole proposition, and also the hard stop: the
    // window can be opened but never closed past it. Continuous, because the
    // wheel and the pinch move this value.
    ifSpan: 1,
    // Whether the picture takes the wheel, a pinch and a drag at all. On,
    // because dragging the spectrum under the dial line is the best fine-tuning
    // control in the interface — but it is a picture inside a scrolling dock
    // column, so a wheel over it has two plausible meanings and only one can
    // win. Off gives the wheel back to the column; the span slider and
    // click-to-tune still work.
    ifGestures: true,
    // Whether a plain click on the picture retunes.
    //
    // Off, unlike everywhere else in this interface, and the difference is what
    // this pane is for. The main spectrum is a map you click to travel across;
    // this one is a magnifier held over the signal you have already arrived at,
    // and every reason to point at it — reading an offset off the ruler, finding
    // the edge of an interfering carrier, checking where the passband sits — is
    // a reason to *look*, not to move. A click that tuned by a few hundred hertz
    // while you were studying a signal is a mistake you have to notice before
    // you can undo it. Dragging stays live either way: that one cannot be done
    // by accident, and it is the best fine-tuning control in the interface.
    ifClickTune: false,
    // Seconds of frames the Shape view averages over.
    //
    // Two, because that is about the shortest window that settles the noise
    // without smearing what a voice is doing — a syllable is a couple of hundred
    // milliseconds, so a two-second average still shows speech as a shape while
    // holding a carrier perfectly still. Longer is for digging a weak steady
    // signal out; shorter is for watching something change.
    ifShapeSec: SHAPE_SEC_DEFAULT,
    ifRate: 20,             // committed rows a second, as the main waterfall's
    // Auto by default and for the same reason the audio scope's is: it is right
    // until the question becomes "how strong is this", which is what an absolute
    // scale answers.
    ifAuto: true,
    ifFloor: -110,
    ifCeil: -20,
    // Whether the audio scope and waterfall find their own dB window or use a
    // floor the operator set. Auto by default: it is right until the question
    // is "how quiet is this", which is what the manual scale answers.
    scopeAuto: true,
    scopeFloor: -90,        // bottom of the manual scale, in dBFS
    scopeContrast: 1.0,     // gamma on the audio waterfall's colour mapping
    // Signal panel meters: 'bar' or the analogue 'needle'. Clicking a meter
    // switches both — see SignalPanel.
    meterStyle: 'bar',
    // Which reading the top bar's meter shows: 'signal' (the S-meter, in dBFS)
    // or 'snr'. Clicking the meter swaps it. Signal by default because it is
    // the one that answers "is anything there".
    topMeter: 'signal',
    theme: 'dark',
    // The interface's own colours: the accent everything is highlighted in, the
    // text, and the two quieter greys under it — labels, units, the clocks.
    //
    // Each is null until chosen, and null means the theme's own value rather than
    // a colour written out here: that is what keeps "I have changed nothing"
    // meaning nothing has changed, on a theme this build has not thought of as
    // much as on the two it has. A chosen colour applies to both themes, because
    // somebody who picked amber picked amber, not amber-when-dark.
    //
    // The greys follow the text unless chosen themselves, and `station` — the
    // receiver's name over the spectrum — follows the operator's own colour
    // before either. See lib/uiColors.js, which also derives what goes on top of
    // an accent fill.
    uiColors: {
        accent: null, text: null, dim: null, faint: null, station: null,
    },
    uiScale: 1,             // multiplier on every font-size (top bar A-/A+)
    // Vibration on touch: 'off' | 'light' | 'medium' | 'strong'. On by default,
    // because a phone's controls have no travel and nothing else says a tap
    // landed — see lib/haptics.js. It costs nothing where there is no vibrator:
    // every device with a pointer rather than a finger fails hapticsSupported()
    // and never fires, which is also why the Display panel hides these controls
    // there rather than offering settings with no effect.
    haptics: 'medium',
    // …and what it applies to. Two switches rather than one because they answer
    // different questions: hapticButtons is confirmation of something you did
    // to a control you were looking at, hapticSpectrum is the waterfall telling
    // you a tap tuned, a pinch took a step or a drag grabbed a filter edge —
    // results that land somewhere other than under your finger. Wanting one
    // without the other is a normal preference, not an edge case.
    hapticButtons: true,
    hapticSpectrum: true,
    // ── Debug ───────────────────────────────────────────────────────────────
    //
    // A bisect kit for "the page is using a lot of GPU", which on this display is
    // a question about *compositing* rather than about drawing: measured here,
    // stopping every canvas draw in the app saved five points of fifty-three,
    // while removing the waterfall from the DOM saved twenty-three. Drawing is
    // not the bill — the number of large layers the compositor re-blends on every
    // frame it produces is.
    //
    // Each switch below therefore removes one *suspect* while leaving the picture
    // otherwise running, so the operator's own GPU readout answers the question
    // rather than a theory about it. They are settings and not a build flag
    // because the machines this matters on are other people's.
    //
    // `debug` off means every one of them is inert, whatever it is stored as: the
    // panel section is hidden and nothing reads them. So a switch left flipped
    // cannot follow somebody around after they have stopped looking.
    debug: false,
    // The waterfall canvas's `will-change: transform`, which commits it to a GPU
    // texture of its own for the life of the page whether or not it ever
    // animates — and, because the marks canvas sits directly on top of it, gets
    // that one promoted by overlap too. Two full-width layers, re-blended every
    // frame. The first thing to try.
    dbgWfLayer: true,
    // The other three promotions: the top bar, the frequency barrel's strip and
    // the band panel's waterfall.
    dbgUiLayers: true,
    // The marks canvas alone — the dial and passband lines over the waterfall.
    // Left drawing, just not composited, which separates "that layer costs" from
    // "drawing those lines costs".
    dbgWfMarks: true,

    // Multiplier on the canvas backing stores, i.e. how many device pixels the
    // spectrum is rendered at. Cuts texture memory and upload bandwidth
    // quadratically; should *not* move a cost that is per-composited-frame,
    // since the layers still cover the same screen pixels. Which is exactly what
    // makes it worth having here — it tells the two apart.
    dbgRenderScale: 1,
    // Overrides for the dial line and the passband edges, *per palette*:
    //
    //     { classic: { dial: '#ff2ec4', edge: '#5cff8f' }, … }
    //
    // Absent means "follow the palette", which is what almost everyone should
    // leave them on: a marker has to contrast with a colour map that covers a
    // whole hue arc, and paletteMarks() in lib/palettes.js picks hues each map
    // never reaches. But colour vision and screens vary in exactly the way a
    // fixed pair of hues cannot accommodate, which is why this is a setting and
    // not just a better default.
    //
    // Keyed by palette rather than held as one pair, because the question the
    // setting answers is "what shows up against *this* colour map" — a magenta
    // dial chosen to beat the classic waterfall's blues is the worst possible
    // choice over magma, so one global override would have to be re-picked on
    // every palette change. Switching palettes now brings back whatever was
    // chosen for it last time.
    markOverrides: {},
};

// Text-size range and step for the top bar's zoom buttons.
export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.6;
export const UI_SCALE_STEP = 0.05;

// Bumped when a stored value has to be reinterpreted rather than merely added
// to. Everything in this file is persisted, defaults included — the save effect
// writes the whole object on mount — so a stored value cannot be assumed to be
// a choice somebody made, and a new default reaches nobody without this.
const SETTINGS_VERSION = 7;



function migrate(saved) {
    // v2: zoomAnchor gained 'auto', which is tuned on a phone.
    //
    // A stored 'cursor' from before this is the old default written out on
    // first load, not a preference — and on a phone it cannot have been one at
    // all, because the pinch ignored this setting entirely until now, so there
    // was nothing to choose between. Dropping it lets 'auto' apply. An explicit
    // 'tuned' is left alone: that one could only have been set on purpose.
    if (!(saved.v >= 2) && saved.zoomAnchor === 'cursor') delete saved.zoomAnchor;

    // v3: the idle throttle became a delay rather than a switch.
    //
    // Off is the one thing the old switch could say that the new list still
    // says, so it carries over as "never" — and it is the only value worth
    // carrying: `true` was the default written out on first load and says
    // nothing about how long anybody wanted to wait, which is the question the
    // list asks. Those become null and take the device's default.
    if (!(saved.v >= 3)) {
        if (saved.idleThrottle === false) saved.idleThrottleMin = 0;
        delete saved.idleThrottle;
    }

    // v4: the stats overlay's default became per-device rather than flat 'off'.
    //
    // A stored 'off' from before this is the old default written out on first
    // load — every setting is persisted whole, so everyone has one — and it would
    // hold the new default off for ever on machines that should now have it. Any
    // other stored value is a corner somebody picked and is left alone.
    if (!(saved.v >= 4) && saved.spectrumStats === 'off') delete saved.spectrumStats;

    // v5: the phone tab bar now stays up over an open sheet by default.
    //
    // A stored false from before this is the old default written out on first
    // load, not a choice — the switch is phone-only and most people never open
    // the display panel at all — so it is dropped and the new default applies.
    // A stored true was already what somebody asked for and stays.
    if (!(saved.v >= 5) && saved.mobileTabsAlways === false) delete saved.mobileTabsAlways;

    // v6: the waterfall's history now follows the frequency scale by default.
    //
    // A stored 'hold' from before this is the old default written out on first
    // load — every setting here is persisted whole, so everybody has one — and
    // it would hold the new default off for ever. 'follow' is the only value
    // that could have been chosen deliberately under the old default, and it is
    // left alone by being the thing this does not touch.
    if (!(saved.v >= 6) && saved.waterfallPan === 'hold') delete saved.waterfallPan;

    // maxFps briefly shipped with a stored default of 0 before the default
    // became per-device, and settings are persisted whole — so everybody who
    // ran that build has an explicit 0 that would hold the touch default off
    // for ever. A stored 0 from then is indistinguishable from a deliberate
    // "no limit", but under that build 0 *was* the default, so almost every
    // copy of it is nobody's choice. Positive caps were always deliberate and
    // are kept.
    if (!(saved.v >= 7) && saved.maxFps === 0) delete saved.maxFps;

    return saved;
}

function load() {
    try {
        const saved = migrate(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {});
        return { ...DEFAULTS, ...saved, v: SETTINGS_VERSION };
    } catch (e) {
        return { ...DEFAULTS, v: SETTINGS_VERSION };
    }
}

// Whether anything has been stored here before, which is how the operator's own
// defaults know whether they are looking at a first visit. Deliberately not
// derived from the loaded settings: those are the defaults filled in whatever
// happened, so they look identical either way.
function stored() {
    try { return localStorage.getItem(STORAGE_KEY) != null; } catch (e) { return false; }
}

// The frame cap in force. Not chosen, it splits by device: anything driven by
// touch — a phone or tablet in a browser, and both mobile apps — is capped at
// 30, everything else runs at the display's rate.
//
// The split is about who pays. On a desktop the cost of an uncapped loop is
// share of a machine that is plugged into a wall; on a handheld it is battery
// and heat in somebody's hand, spent on frames a waterfall cannot show —
// spectrum frames arrive well under 30 a second, so past that the loop is
// mostly repainting the picture it already drew. Touch rather than screen
// width, because width lies about tablets: an iPad in landscape is wider than
// the mobile breakpoint and runs on the same battery.
export function resolveMaxFps(value, touch) {
    if (Number.isFinite(value)) return value;
    return touch ? 30 : 0;
}

// Which anchor is in force. 'auto' is the default and splits by device: a phone
// gets the tuned frequency held still, anything with a pointer gets the cursor.
export function resolveZoomAnchor(value, mobile) {
    if (value === 'tuned' || value === 'cursor') return value;
    return mobile ? 'tuned' : 'cursor';
}

const DisplayContext = createContext(null);


export function DisplayProvider({ children }) {
    const [state, setState] = useState(load);
    const [server, setServer] = useState(UI_CONFIG_DEFAULTS);
    // Whether this browser arrived with no display settings of its own, read
    // *before* the save effect below writes the first copy — which it does on
    // mount, defaults and all, so a moment later the question is unanswerable.
    const firstVisit = useRef(!stored());

    useEffect(() => {
        let cancelled = false;
        fetch('/api/ui-config')
            .then((r) => r.json())
            .then((cfg) => {
                if (cancelled) return;
                const parsed = parseUiConfig(cfg);
                setServer(parsed);
                // The operator's defaults for this interface, to somebody who
                // has not been here before. Only then: they are a first
                // impression, not a policy, and a listener who has chosen a
                // palette should not find it changed on them because the
                // receiver's owner set one. Same rule as v1's, and the same
                // rule the audio buffer already follows in App.jsx.
                //
                // Applied once and stored like any other change, so the next
                // load has settings and this does nothing.
                if (!firstVisit.current) return;
                firstVisit.current = false;
                const patch = parsed.v2Defaults;
                if (patch && Object.keys(patch).length) setState((s) => ({ ...s, ...patch }));
            })
            .catch(() => { /* non-fatal — the spectrum just has no backdrop */ });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    }, [state]);

    useEffect(() => {
        document.documentElement.dataset.theme = state.theme;
    }, [state.theme]);

    // The chosen colours, as properties on the root. Every property the group
    // owns is visited every time: one that is set gets written, one that is not
    // gets *removed*, which is what lets the stylesheet's own per-theme value
    // apply again rather than being overwritten with a copy of itself.
    //
    // Keyed on the theme as well: the ink that goes on top of an accent fill and
    // the alphas of its wash both differ between them.
    useEffect(() => {
        const root = document.documentElement.style;
        const vars = uiColorVars(state.uiColors, state.theme);
        for (const name of UI_COLOR_VARS) {
            if (vars[name]) root.setProperty(name, vars[name]);
            else root.removeProperty(name);
        }
        // The spectrum resolves its colours once per theme and caches them —
        // --accent among them, for the dial line — so a colour changed without
        // the theme changing would not reach the canvas until something else
        // did. See themeColors.
        invalidateThemeColors();
    }, [state.uiColors, state.theme]);

    // The debug switches that are answered in CSS, as attributes on the root.
    //
    // Attributes rather than props threaded down to the elements: two of the
    // three targets are not this file's to reach — the top bar and the band
    // panel — and a promotion is a stylesheet decision in the first place, so the
    // override belongs beside the rule it overrides.
    //
    // Only ever *removes* a promotion, and only while `debug` is on: with it off
    // every attribute goes, whatever the individual switches are stored as.
    useEffect(() => {
        const el = document.documentElement;
        const flag = (name, off) => {
            if (state.debug && off) el.dataset[name] = 'off';
            else delete el.dataset[name];
        };
        flag('dbgWfLayer', state.dbgWfLayer === false);
        flag('dbgUiLayers', state.dbgUiLayers === false);
        flag('dbgWfMarks', state.dbgWfMarks === false);
    }, [state.debug, state.dbgWfLayer, state.dbgUiLayers, state.dbgWfMarks]);

    // Exposed as a custom property rather than an inline style so every
    // floating window picks it up without re-rendering — the same approach v1
    // uses for its controls_opacity setting.
    // Clamped so a stale or bogus stored value can never hide the windows.
    useEffect(() => {
        const o = Number(state.floatOpacity);
        const eff = Number.isFinite(o) && o > 0 ? Math.min(1, Math.max(0.5, o)) : 1;
        document.documentElement.style.setProperty('--float-opacity', String(eff));
    }, [state.floatOpacity]);

    // Every font-size in styles.css is calc(Npx * var(--ui-scale)), so this one
    // property resizes all the text — including panels that are not mounted yet.
    useEffect(() => {
        document.documentElement.style.setProperty('--ui-scale', String(state.uiScale ?? 1));
    }, [state.uiScale]);

    const set = useCallback((patch) => setState((s) => ({ ...s, ...patch })), []);
    const reset = useCallback(() => setState({ ...DEFAULTS, v: SETTINGS_VERSION }), []);

    // One marker colour for one palette. `hex` empty puts that mark back on the
    // palette's own choice, and a palette left with neither override drops out
    // of the map entirely rather than sitting there as an empty object.
    const setMarkColor = useCallback((palette, which, hex) => setState((s) => {
        const all = s.markOverrides || {};
        const one = { ...(all[palette] || {}) };
        if (hex) one[which] = hex; else delete one[which];
        const next = { ...all };
        if (Object.keys(one).length) next[palette] = one; else delete next[palette];
        return { ...s, markOverrides: next };
    }), []);

    // One of the interface's own colours. `hex` empty puts it back on the theme's
    // — or, for the two greys, back on following the text colour.
    const setUiColor = useCallback((which, hex) => setState((s) => ({
        ...s,
        uiColors: { ...(s.uiColors || {}), [which]: hex || null },
    })), []);

    const value = useMemo(
        () => ({ ...state, server, set, reset, setMarkColor, setUiColor }),
        [state, server, set, reset, setMarkColor, setUiColor],
    );
    return <DisplayContext.Provider value={value}>{children}</DisplayContext.Provider>;
}

export function useDisplay() {
    const ctx = useContext(DisplayContext);
    if (!ctx) throw new Error('useDisplay outside DisplayProvider');
    return ctx;
}
