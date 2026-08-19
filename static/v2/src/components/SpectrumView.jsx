// Spectrum + waterfall.
//
// Rendering deliberately bypasses React: the spectrum connection is subscribed
// to directly and frames are drawn on the canvas, so a 10–20 Hz data stream
// causes zero reconciliation. React only owns the surrounding chrome.
//
// The waterfall uses a ring-buffered offscreen canvas: each new row is written
// at a decrementing index and the visible canvas is painted from two slices of
// the ring. That is O(row) per frame and, unlike scrolling by blitting the
// canvas onto itself, never accumulates resampling artefacts. Resizing the pane
// vertically keeps that history and only a width change throws it away — see
// the ring allocation below for why the two differ.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { getPalette } from '../lib/palettes.js';
import {
    clamp, formatFilterWidth, formatFreqExact, formatFreqShort, formatSpan,
} from '../lib/format.js';
import {
    FILTER_WIDTH_STEP, MAX_FREQ, MIN_FREQ, MODE_BY_ID, SQUELCH_MIN,
    edgesForEdgeDrag, edgesForWidth, stepLabel,
} from '../radio/constants.js';
import { DEFAULTS as DISPLAY_DEFAULTS, resolveMaxFps, resolveZoomAnchor, useDisplay } from '../display/DisplayContext.jsx';
import { markColors } from '../display/uiConfig.js';
import { Button, Icon, RangeSlider } from './ui.jsx';
import MarkerBar from './MarkerBar.jsx';
import SpectrumMenu from './SpectrumMenu.jsx';
import AddBookmark from './AddBookmark.jsx';
import { VFO_IDS, getVfos, setVfos, storeInto, vfoSnapshot } from '../lib/vfos.js';
import { useRoomFor } from '../lib/useRoomFor.js';
import {
    RING_BG, RING_BG_RGB, RING_PAD, panTransform, ringHeightFor, ringKeepsHistory,
    ringSlices, smoothInterval,
} from '../lib/waterfallRing.js';
import {
    TRACE_WIDTH, binsToPixels, frequencyTicks, paletteGradients, themeColors,
} from '../lib/spectrumTrace.js';
import { approachFor, retentionFor } from '../lib/timeConstant.js';
import { freqOffset, offsetBand, offsetLabel, offsetTitle } from '../lib/freqRef.js';
import {
    PEAK_GAP_PX, PEAK_REFRESH_MS, PEAK_TAU_MS, averageTrace, findPeaks, layoutPeakLabels,
    peakCount, peakPlace, peakSnr,
} from '../lib/spectrumPeaks.js';
import { HOVER_QUERY, LANDSCAPE_QUERY, MOBILE_QUERY, TOUCH_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { getFlex, getMidi, getSync } from '../controls/sources.js';
import { listSurfaces, onSurfaces } from '../controls/surfaces.js';
import { providerStatus, onProviders } from '../controls/radioProviders.js';
import { controlState, onControlState } from '../controls/mappings.js';
import { useMediaSession } from '../radio/media/MediaSessionContext.jsx';
import { announceSettings, onAnnounceSettings, setAnnounceSettings } from '../lib/announce.js';
import { bridgeAttached, onBridgeAttached } from '../bridge/settings.js';
import { edgeHit } from '../lib/edgeHit.js';
import {
    onSpectrumPaused, resumeSpectrum, setSpectrumPaused, spectrumPaused, suspendSpectrum,
} from '../lib/spectrumPause.js';
import { perSecond, statLines, statsPlace } from '../lib/spectrumStats.js';
import { readAppStats } from '../lib/appStats.js';
import { bandRate } from '../lib/bandSpectrum.js';
import { subscribeListeners } from '../lib/listeners.js';
import { useChat } from '../chat/ChatContext.jsx';
import { fetchMyIp, peekMyIp } from '../lib/myip.js';
import { haptic } from '../lib/haptics.js';
import { fetchWeather, windKmh } from '../lib/weather.js';
import { feedInterval } from '../lib/serverFeeds.js';
import {
    RING_ROWS, clearRows as clearDssRows, createRing as createDssRing, drawSurface,
    edgeLine, pushRow as pushDssRow, resizeRing as resizeDssRing, ringCols,
    shiftRows as shiftDssRows,
    unproject as dssUnproject,
} from '../lib/dss.js';
import { dxCanSpot } from '../lib/dxclusterSession.js';
import SpotOnCluster from './SpotOnCluster.jsx';

// How near a passband edge counts as grabbing it, and how wide the passband
// has to be on screen before either edge can be grabbed at all.
//
// The threshold is three times the smallest zone still worth aiming at, not
// three times the zone above: edgeHit() shrinks the zone to a third of the
// passband as that narrows, so the two can never meet whatever this is set to,
// and what it has to decide is only "is the handle big enough to hit".
//
// Three pixels is enough of one for a mouse. A pointer lands where it is pointed,
// the cursor turns to col-resize before the press to say the edge is there, and a
// miss costs a click that tunes — so the honest answer to "can this be aimed at"
// is close to the smallest thing that can be seen. The threshold used to be a
// 5 px zone, which refused the gesture on a 12 px passband where a 4 px handle
// was perfectly hittable: the operator could see two lines with clear space
// between them and the display would not let go of either.
const EDGE_ZONE_MIN_PX = 3;
const EDGE_GRAB_PX = 6;
const EDGE_MIN_PX = 3 * EDGE_ZONE_MIN_PX;

// The narrowest a drag may leave the passband, in px — wider than the threshold
// for grabbing one, and that gap is the whole point of it being its own number.
//
// A drag used to stop exactly on the threshold, which sounds like the tightest
// correct answer and is in fact a one-way door: at equality the passband is
// grabbable only while nothing rounds it down, and several things do. The width
// is snapped to FILTER_WIDTH_STEP, the receiver applies its own grain and reports
// back what it actually did, the pixels come from a float division by the span.
// Any one of those costs a fraction of a pixel, the edge stops answering, and the
// filter is stuck narrow with the panel as the only way back out — you can close
// it and not reopen it, which is exactly what it felt like.
//
// So the floor keeps four pixels in hand. Zooming out still puts a filter beyond
// reach, as it must — at some span everything is a pixel wide — but that undoes
// itself by zooming back in, and it is not something a gesture did to you.
const EDGE_FLOOR_PX = EDGE_MIN_PX + 4;

// The same, for a finger. Six pixels is not a touch target — a fingertip is
// nearer forty across and the contact point is not where you think it is — so
// touch gets a *zone* it can actually hit wherever the passband has room for one.
//
// The threshold, though, is the mouse's: touch is offered the gesture at exactly
// the same width, and has no business being the stricter of the two.
//
// Three reasons, and the last is the one that settles it:
//
//   * A miss is free here in a way it is not with a pointer. A touch near an edge
//     is a tap until it has travelled TOUCH_SLOP_PX, so missing tunes — which is
//     what the finger was going to do anyway — and taking the wrong edge is
//     undone by dragging back.
//   * A refusal is not free. It is the display declining to let go of a line the
//     operator can see perfectly well, and on a phone there is no fallback with
//     the immediacy of dragging the edge itself: the width lives behind a panel.
//   * A lower threshold does not make an accidental grab more likely. The zone is
//     capped at a third of the passband either way, so at the widths this newly
//     allows the handle is a few pixels — less of the display given to resizing
//     than at any width already permitted, not more. The old threshold was not
//     protecting the pan; it was only withholding the resize.
//
// It also unblocks narrowing. The same number is the narrowest a drag may leave
// the filter (see minHz in onPointerMove), so at 30 px a phone could only ever
// widen: 2.7 kHz of SSB reached 30 px late on the zoom ladder, and by then the
// floor was most of the filter.
const TOUCH_GRAB_PX = 22;
const TOUCH_EDGE_MIN_PX = EDGE_MIN_PX;

// How far a finger must travel before a touch near an edge is a resize rather
// than a tap. The whole reason touch can have a grab zone this size: nothing is
// decided when the finger lands, so a tap meant to tune is still a tap, and only
// a deliberate drag moves the filter.
const TOUCH_SLOP_PX = 8;

// How long a finger has to stay still to mean "right click", and how far it may
// drift while doing it. Section.jsx times the same gesture for panel dragging
// with the same numbers, deliberately: one hold on this interface ought to feel
// like another, and a spectrum that wanted half a second while a panel wanted
// four tenths would be a difference nobody could name but everybody would feel.
const HOLD_MS = 400;
const HOLD_SLOP = 10;

// How often the stats readout re-reads its counters. A second is what a rate
// like this is quoted in, and anything faster is a number too busy to read.
const STATS_MS = 1000;

// Room between the readout and the ruler it sits above, CSS px.
const STATS_GAP = 4;

const SCALE_H = 26;       // frequency ruler height, CSS px
// A second, thinner ruler under the waterfall. The one above it is the scale
// you tune against — it carries the dial pip and doubles as the splitter — and
// this is the one you read a signal's frequency off without looking away from
// the waterfall, which is where a signal actually is. The audio scope panel has
// had one under its waterfall from the start; this is the same idea on the RF
// pane.
//
// Mirrored as `--wf-scale-h` in styles.css, where the strip of minimised windows
// uses it to sit on top of this ruler rather than over it. Duplicated because a
// canvas's height cannot come from a stylesheet — change one, change the other.
const WF_SCALE_H = 14;
// Tick lengths down from the top of that ruler, CSS px. The major stops just
// short of the cap height of the label under it, which is what makes the two
// read as one mark rather than as a line and a number that happen to line up.
// How far the dial pip hangs from the top of the ruler, CSS px. The passband
// bar sits on its point, so the two share the number.
const PIP_H = 7;
const TICK_MAJOR = 9;
const TICK_MINOR = 5;
const MIN_SPECTRUM_H = 60;
const MIN_WATERFALL_H = 40;

// The two toolbar cycles, and what each state's button says.
//
// Written out rather than derived from an array so the wording can say what
// *pressing* does — a cycle whose tooltip only named the current state would
// leave you pressing to find out where it goes.
const NEXT_VIEW = { split: 'spectrum', spectrum: 'waterfall', waterfall: 'split' };
const VIEW_TITLE = {
    split: 'Spectrum above waterfall — click for spectrum only',
    spectrum: 'Spectrum only — click for waterfall only',
    waterfall: 'Waterfall only — click for both',
};
const NEXT_WF = { '2d': '3d', '3d': 'both', both: '2d' };

// The same two settings as named choices, for the right-click menu — where a
// cycle would be the wrong shape (see the menu). One list per setting, in the
// order the buttons cycle through them, so the menu and the toolbar agree about
// what these are called.
const VIEW_CHOICES = [
    { id: 'split', label: 'Show spectrum and waterfall' },
    { id: 'spectrum', label: 'Show spectrum only' },
    { id: 'waterfall', label: 'Show waterfall only' },
];
const WF_CHOICES = [
    { id: '2d', label: 'Waterfall as a heat map' },
    { id: '3d', label: 'Waterfall as a 3D surface' },
    { id: 'both', label: 'Waterfall as both' },
];
const WF_STYLE_TITLE = {
    '2d': 'Waterfall as a heat map — click for the 3D surface',
    '3d': 'Waterfall as a 3D surface — click for both together',
    both: 'Both, newest rows meeting in the middle — click for the heat map',
};

// How much of the waterfall area the surface takes in '2d+3d'.
//
// Slightly less than half. The surface spends the top of its own box on the far,
// squashed rows and the heat map uses every pixel it is given, so an even split
// reads as the surface having more room than it needs.
const DSS_SPLIT = 0.45;

// How far the split may be dragged, as the spectrum's share of the height.
// Exactly the Display panel's slider range, because they are two ways of moving
// the same value and a limit you can reach with one but not the other reads as
// one of them being broken.
const SPLIT_MIN = 0.10;
const SPLIT_MAX = 0.85;

// Least vertical room, in CSS px, between two dB labels before one is dropped.
// The type is 10 px, so this is the line plus a little air.
const DB_LABEL_GAP = 13;

// Weight of the spectrum trace in CSS px. Only drawn when the fill is off — see
// where it is used — so this is always its full weight.

// Width to assume for the cursor-frequency tag before it has ever been on
// screen to measure — a little over what "14.074.00" needs at the default text
// size. Only ever used once: from the first time it is shown, useRoomFor
// remembers the real width.
const CURSOR_TAG_W = 96;

// The same, for the three context tags. Each is measured the first time it is
// drawn; these are only what to assume before that has happened. Icon, a space,
// and the widest reading of each: a span in kHz, a nine-digit centre frequency,
// and an offset in hertz with its sign.
const SPAN_TAG_W = 84;
const CENTRE_TAG_W = 104;
const OFFSET_TAG_W = 72;
// Three characters and the padding, and it never says anything else.
const PCM_TAG_W = 48;

// The first two live pointers, in the order they went down — a pinch, if there
// are two of them. A third finger joins the map but is ignored.
function pinchPair(pts) {
    const [a, b] = pts.values();
    return a && b ? [a, b] : null;
}
function pinchDist([a, b]) { return Math.hypot(b.x - a.x, b.y - a.y); }

// Shortest gap between zoom messages sent from a pinch — a message rate limit,
// not a zoom rate limit. One message now carries however many rungs the fingers
// have asked for (see zoomSteps), so this no longer paces how fast the view can
// move; it only stops a gesture emitting a request per pointermove while the
// server is still answering the last one. The first move of a gesture goes out
// immediately.
const PINCH_MS = 140;

// Rungs of zoom per doubling of the finger separation.
//
// At 1 — the natural reading, where the span follows the fingers exactly — a
// rung costs a √2 spread, two rungs cost 2× and three cost 2.83×. That is fine
// on a trackpad and useless on a phone: the gesture is bounded by the hand and
// the glass, so a pinch that starts at a comfortable separation opens perhaps
// two or three times before it runs out, and is therefore worth one rung, or
// two if you are careful. The band is thirteen rungs deep. Everything past the
// second rung became lift-and-pinch-again, which is what made zooming on a
// phone feel like work.
//
// At 2 the same gesture is worth twice as much: a doubling of separation is
// four times the span, and the first rung comes at a 19% spread — far enough
// apart from a two-finger tap to be deliberate, near enough to be one
// unhurried movement. The loop is unchanged and still self-correcting: this
// only changes what span the gesture is asking for, not how the answer is
// measured.
const PINCH_GAIN = 2;

// Squelch state in the spectrum toolbar. Split into its own component so the
// 10 Hz meter sampling re-renders this tag alone — SpectrumView owns the draw
// loop and must not re-render at meter rate.
function SquelchTag() {
    const { squelch, actions } = useRadio();
    const m = useMeters(10);
    if (!squelch.enabled) return null;
    const open = m.squelchOpen;
    return (
        <button
            type="button"
            className={`tag tag--button tag--sq tag--${open ? 'good' : 'bad'}`}
            title={`Squelch ≥ ${squelch.value.toFixed(1)} dB SNR — ${open ? 'passing audio' : 'muted'}. Click to switch it off`}
            onClick={() => actions.setSquelch(SQUELCH_MIN)}
        >
            {open ? 'open' : 'closed'}
        </button>
    );
}

// Which noise-reduction filter is running, if any. `dsp.enabled` comes from the
// server's dsp_status echo, so this reflects what the server is actually doing
// rather than what was requested.
//
// The filter's own name, with no "NR" in front of it: the names are the ones the
// server publishes and nothing else in this row wears them, so the prefix was
// two characters of a full row spent saying what the word beside it already
// said. The tooltip carries the description for anyone who does not know a name.
function NoiseReductionTag() {
    const { dsp, actions } = useRadio();
    if (!dsp.enabled || !dsp.filter) return null;
    const schema = (dsp.schemas || []).find((f) => f.name === dsp.filter);
    // Switches the insert off but keeps the filter selected, so turning it back
    // on from the Audio panel starts where it left off rather than at the
    // first filter in the list.
    return (
        <button
            type="button"
            className="tag tag--button tag--accent"
            title={`${schema ? schema.description : 'Noise reduction'} — click to switch it off`}
            onClick={() => actions.setDsp(dsp.filter, false)}
        >
            {dsp.filter.toUpperCase()}
        </button>
    );
}

// The client noise stage, tagged exactly as the server's insert is: seeing at
// a glance that the audio is being processed, and one click to stop it. The
// tooltips say "in this client" because the tag next door can read "NR2" for
// the server's filter — two NR tags with nothing saying which machine each
// lives on would be a row that needs the manual.
//
// The blanker's tag blinks red as pulses are cut — the running total lives in
// the Noise panel, next to the threshold it calibrates; here the flash alone
// is the feedback: a tag answering the crackle you can hear is the threshold
// set right, and one flashing on every syllable is eating speech. Polled from
// the player at a few hertz rather than evented per pulse — a storm can run
// at hundreds of pulses a second, and a React render per pulse would be the
// storm twice.
function NbTag() {
    const { noise, player, actions } = useRadio();
    const on = noise.nb.enabled;
    const [hot, setHot] = useState(false);
    const seen = useRef(0);
    const cool = useRef(0);

    useEffect(() => {
        if (!on) { seen.current = 0; setHot(false); return undefined; }
        const t = setInterval(() => {
            const n = player.nbPulses();
            if (n === seen.current) return;
            // Backwards means the stage was rebuilt (re-toggled, new context)
            // and the instances are fresh — follow it down without flashing.
            if (n > seen.current) {
                setHot(true);
                clearTimeout(cool.current);
                cool.current = setTimeout(() => setHot(false), 400);
            }
            seen.current = n;
        }, 200);
        return () => { clearInterval(t); clearTimeout(cool.current); };
    }, [on, player]);

    if (!on) return null;
    return (
        <button
            type="button"
            className={`tag tag--button ${hot ? 'tag--bad' : 'tag--accent'}`}
            title="Noise blanker running in this client — click to switch it off"
            onClick={() => actions.setNoise({ nb: { enabled: false } })}
        >
            NB
        </button>
    );
}

function ClientNoiseTags() {
    const { noise, actions } = useRadio();
    return (
        <>
            <NbTag />
            {noise.nr.enabled && (
                <button
                    type="button"
                    className="tag tag--button tag--accent"
                    title="Noise reduction running in this client — click to switch it off"
                    onClick={() => actions.setNoise({ nr: { enabled: false } })}
                >
                    NR
                </button>
            )}
        </>
    );
}

// The client-side audio filters that are on. Just their names — the settings
// live in the Audio filters panel; this is here so you can see at a glance that
// the audio is being shaped, without hunting for which panel did it.
// Output clipping. Deliberately its own tag rather than part of FilterTags:
// this is a fault to fix, not a setting that is on, and it can happen with no
// filters enabled at all.
/**
 * How far out the receiver's own oscillator is, when it knows.
 *
 * A port of widgets/frequency.widget.html, which put this in the corner of the v1 page.
 * It belongs in this row rather than floating over the canvas: it is a fact about every
 * frequency in the toolbar beside it, and a badge pinned over the waterfall would sit
 * on the signals instead.
 *
 * Absent unless the operator runs the reference monitor *and* it has measured something
 * — see freqOffset. A receiver that does not know its own error is every other
 * receiver, and none of them says so.
 */
function FreqOffsetTag() {
    const { serverInfo } = useRadio();
    const hz = freqOffset(serverInfo);
    if (hz == null) return null;
    const band = offsetBand(hz);
    return (
        <span className={`tag tag--${band}`} data-optional="offset" title={offsetTitle(serverInfo)}>
            Δf {offsetLabel(hz)}
        </span>
    );
}

function ClipTag() {
    const m = useMeters(8);
    if (!m.clipping) return null;
    return (
        <span className="tag tag--bad" title="Audio is hitting full scale — reduce volume, makeup or EQ boost">
            CLIP
        </span>
    );
}

// That the audio is coming down uncompressed, and the one-press way back.
//
// Deliberately the quietest thing in the row: the dim base tone rather than a
// warning colour, because this is a setting the operator chose on purpose after
// being told what it costs, not a fault. It is a reminder that the choice is
// still in force — easy to forget, and it is the receiver's owner who pays for
// it — rather than something demanding to be dealt with.
//
// Pressing it goes back to Opus with no confirmation. The Audio panel asks
// before the expensive direction and says nothing on the way back, and this is
// the way back.
function AudioFormatTag() {
    const { audio, actions } = useRadio();
    if (audio.format !== 'pcm-zstd') return null;
    return (
        <button
            type="button"
            // Red, like the clip tag above it. Grey put it with the tags that
            // report what the receiver is doing, and this is not one of those:
            // it is the one setting here that keeps costing somebody else
            // bandwidth for as long as it is left on, and the whole reason the
            // badge exists is that it is easy to forget. A colour that says
            // "still on" does the job the badge was added for.
            className="tag tag--button tag--bad"
            data-optional="pcm"
            title="Audio is set to Uncompressed — four to eight times the bandwidth of Opus. Click to switch to Opus"
            onClick={() => actions.setAudioFormat('opus')}
        >
            PCM
        </button>
    );
}

function FilterTags() {
    const { filters, actions } = useRadio();
    // [label, the key in the filter state]. The key is what the click turns
    // off, so a tag can never name one filter and disable another.
    const on = [
        filters.gate.enabled && ['GATE', 'gate'],
        filters.eq.enabled && ['EQ', 'eq'],
        filters.notch.enabled && filters.notch.items.length > 0 && ['NOTCH', 'notch'],
        filters.bandpass.enabled && ['BPF', 'bandpass'],
        filters.compressor.enabled && ['COMP', 'compressor'],
        filters.stereo.enabled && ['WIDE', 'stereo'],
    ].filter(Boolean);
    if (!on.length) return null;
    return (
        <>
            {on.map(([name, key]) => (
                <button
                    key={name}
                    type="button"
                    className="tag tag--button tag--accent"
                    title={`${name} filter active — click to switch it off`}
                    onClick={() => actions.setFilters({ [key]: { enabled: false } })}
                >
                    {name}
                </button>
            ))}
        </>
    );
}

// Everything else that is driving, or being driven by, this receiver: a control
// surface on the desk, a rig following the dial, the operating system's own
// transport controls.
//
// Here for the same reason the filter tags are. Each of these is owned by a
// panel that may be collapsed, in another dock, or on a tab of a phone nobody
// is looking at, and "why did the frequency just move?" ought to be answerable
// from the one strip that is always on screen.
//
// Read-only, unlike the filter tags. Clicking those off costs a click to undo;
// dropping a serial link mid-QSO from a 40 px tag does not.
//
// The three surfaces are module singletons outside React (controls/sources.js),
// so each tag subscribes to the object rather than to a context. `read` must
// return a primitive: RadioSync emits on every poll it finds a change in, and
// an equal primitive is a render React skips — which matters here, because this
// strip sits in the component that owns the draw loop.
function useSurface(get, read) {
    const [value, setValue] = useState(() => read(get()));
    useEffect(() => {
        const s = get();
        // It may well have connected before this mounted — the surfaces outlive
        // every panel, and this tag is younger than most of them.
        setValue(read(s));
        return s.on('state', () => setValue(read(s)));
    }, [get, read]);
    return value;
}

const readConnected = (s) => !!s.connected;
const readMidi = (s) => (s.connected ? (s.deviceName || 'MIDI') : '');

// Surfaces something else is hosting — the desktop client's TCI server, so that
// JTDX or a logger connects to *it* and retunes this receiver.
//
// Not in controls/sources.js with the other two because the page does not own
// them: a listening socket is not something a page can be, so they are
// registered over the page API and their state lives in controls/surfaces.js.
// Badged for the same reason FLEX and MIDI are, and with rather more cause —
// what is driving the receiver here is another program entirely, quite possibly
// on another machine.
//
// Only while running. A surface that is registered but switched off is a choice
// in the picker, not something acting on this receiver, and an error is the
// panel's to explain rather than a badge's.
function useProvidedSurfaces() {
    const [all, setAll] = useState(listSurfaces);
    useEffect(() => onSurfaces(setAll), []);
    return all.filter((s) => s.status && s.status.running);
}

// The badge text. A descriptor's label is a human name of up to forty
// characters and this is a badge, so the first word of it — which is what such
// a name leads with. "TCI" survives whole; "TCI server (desktop)" becomes TCI.
const surfaceBadge = (s) => String(s.label || s.id).trim().split(/\s+/)[0].toUpperCase().slice(0, 10);

// What it is, in its own words, and then who is on it. The client count is here
// rather than in a second badge colour: running and running-with-a-client are
// both "something else can retune you", and a badge that changed shade for the
// difference would be asking to be interpreted.
function surfaceTitle(s) {
    const clients = (s.status && s.status.clients) || 0;
    return [
        s.description || `${s.label} is running`,
        clients === 0
            ? 'Nothing is connected to it yet'
            : (clients === 1
                ? 'One program is connected and can retune this receiver'
                : `${clients} programs are connected and can retune this receiver`),
    ].join('\n');
}

// Whether a radio is connected, and whether it is transmitting — whichever
// transport it came in on.
//
// Two states in one primitive so the tag can turn red on TX without
// re-rendering for the frequency readout, which matters here: this strip lives
// in the component that owns the draw loop.
//
// Not tied to the serial link any more. A rig reached through flrig from the
// desktop client or an extension is exactly as connected as one on a cable, and
// a badge that reported only the one the page happens to host itself would be
// silent for half the people using it — see controls/radioProviders.js.
const rigTag = (s) => (s && s.connected ? (s.tx ? 'tx' : 'on') : '');

function useRadioTag() {
    const [value, setValue] = useState('');
    useEffect(() => {
        const sync = getSync();
        const read = () => {
            const transport = (controlState().radiosync || {}).transport || 'serial';
            // The serial link keeps the rig's readout in a nested object; a
            // provider reports the same fields flat. One shape out either way.
            if (transport === 'serial') {
                return rigTag(sync.connected ? { connected: true, tx: !!(sync.rig && sync.rig.tx) } : null);
            }
            return rigTag(providerStatus(transport));
        };
        setValue(read());
        const offs = [
            sync.on('state', () => setValue(read())),
            // A provider's status changes, and the choice of transport changes.
            // Both move this badge, and neither goes through the other.
            onProviders(() => setValue(read())),
            onControlState(() => setValue(read())),
        ];
        return () => offs.forEach((off) => off());
    }, []);
    return value;
}

function ControlTags() {
    const [announce, setAnnounce] = useState(announceSettings);
    useEffect(() => onAnnounceSettings(setAnnounce), []);
    const [attached, setAttached] = useState(bridgeAttached);
    useEffect(() => onBridgeAttached(setAttached), []);
    const mobile = useMediaQuery(MOBILE_QUERY);
    const flex = useSurface(getFlex, readConnected);
    const midi = useSurface(getMidi, readMidi);
    const provided = useProvidedSurfaces();
    const rig = useRadioTag();
    const media = useMediaSession();

    // Metadata-only sessions still count: the OS is showing the card and its
    // buttons move this receiver, which is the thing worth knowing. Guarded
    // because the provider is the app's, not this component's.
    const mediaOn = !!media && media.enabled && media.support.available;

    return (
        <>
            {flex && (
                <span className="tag tag--accent" title="FlexControl connected — the dial is driving this receiver">
                    FLEX
                </span>
            )}
            {midi && (
                <span className="tag tag--accent" title={`${midi} connected — mapped controls are driving this receiver`}>
                    MIDI
                </span>
            )}
            {/* Beside FLEX and MIDI rather than further along, because it is
                one of them as far as the operator is concerned: the same
                picker in SDR Control, mutually exclusive with those two for
                the same reason they are with each other. */}
            {provided.map((s) => (
                <span key={s.id} className="tag tag--accent" title={surfaceTitle(s)}>
                    {surfaceBadge(s)}
                </span>
            ))}
            {rig && (
                <span
                    className={`tag tag--${rig === 'tx' ? 'bad' : 'accent'}`}
                    title={rig === 'tx'
                        ? 'Radio control — the rig is transmitting'
                        : 'Radio control — the rig and this receiver are following each other'}
                >
                    RADIO{rig === 'tx' ? ' TX' : ''}
                </span>
            )}
            {mediaOn && (
                // Clickable, like SPEAK below and unlike the three above it.
                // Those report a connection made somewhere else — a dial, a
                // surface, a rig — and switching one off from a badge would be
                // reaching into another machine. This is a setting of this page
                // and it is on by default on a handset, so the tag is where
                // somebody who does not want the lock-screen card is looking
                // when they notice it: the Media controls panel is two taps and
                // a group away, and the badge is already in front of them.
                <button
                    type="button"
                    className={`tag tag--button tag--${media.status.state === 'active' ? 'accent' : 'ghost'}`}
                    title={media.status.state === 'active'
                        ? 'Media controls live — this receiver answers the system’s play, pause and track keys. Click to switch them off'
                        : 'Media controls enabled — waiting for audio for the system to attach them to. Click to switch them off'}
                    onClick={() => media.setEnabled(false)}
                >
                    MEDIA
                </button>
            )}
            {announce.enabled && (
                // Clickable, unlike the four above it. Those report a
                // connection you would go to its own panel to change; this one
                // is the receiver talking, and the thing you want when it is
                // talking over you is to stop it where you are.
                //
                // Ghost rather than accent when neither reading is selected:
                // switched on and silent is a state worth being able to see,
                // and it is the one the panel has to explain in a note.
                <button
                    type="button"
                    className={`tag tag--button tag--${announce.frequency || announce.mode ? 'accent' : 'ghost'}`}
                    title={announce.frequency || announce.mode
                        ? 'Announcements on — click to silence them'
                        : 'Announcements on, but neither frequency nor mode is selected — click to switch off'}
                    onClick={() => setAnnounceSettings({ enabled: false })}
                >
                    SPEAK
                </button>
            )}
            {attached > 0 && !mobile && (
                // Something outside this page — a browser extension, a
                // userscript — is attached to the page API and can retune this
                // receiver. Not clickable: switching the bridge off from here
                // would be a one-way door with no way back on the same strip,
                // and the SDR Control panel is where the switch lives.
                //
                // Desktop only, on the same grounds as the readouts that left
                // this row: a handset cannot spare the width, and the things
                // that attach — an extension, a userscript, a program on the
                // same machine — are not what is driving a phone. The SDR
                // Control panel still shows the count on every screen.
                <span
                    className="tag tag--accent"
                    title={attached === 1
                        ? 'One program is attached to the receiver'
                        : `${attached} programs are attached to the receiver`}
                >
                    API
                </span>
            )}
        </>
    );
}

// ---------------------------------------------------------------------------
// Station ID overlay
//
// The block v1 paints in the top-right of its spectrum, reproduced line for
// line so both UIs read identically:
//
//   1  bold 13px   "<callsign> - <name>"
//   2  11px, 75%   location (+ the receiver's UTC offset)
//   3  11px, 75%   local weather, when /api/weather is configured
//   4  11px, 75%   active antenna, when the antenna switch is enabled
//
// Colour and the on/off switch are the operator's station_id_color and
// station_id_overlay from /api/ui-config — the same values v1 reads.

// Eight points, not the sixteen lib/weather.js gives the panel. This block is
// v1's, reproduced line for line so both UIs read the same, and v1 rounds to
// eight — "WSW" here where v1 says "SW" would be a visible divergence in the one
// place the two are meant to match.
const WIND_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// No emoji here, unlike v1's thermometer and wind glyphs.
//
// This line is painted into the canvas, and a colour emoji is the one thing in
// the whole block that comes out of a fallback font. Safari lays such a run out
// differently from the rest, which is what put the weather line — and only the
// weather line, the other three being plain text — off the right-hand edge.
// A middle dot separates the parts instead, and reads the same everywhere.
function weatherLine(w) {
    if (!w) return null;
    // Title case, as v1 paints it. lib/weather.js hands over a sentence.
    const desc = w.description.split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    const temp = w.tempC != null ? `${Math.round(w.tempC)}°C` : '';
    let wind = '';
    if (w.windMs != null) {
        const dir = w.windDeg != null
            ? WIND_DIRS[Math.round((((w.windDeg % 360) + 360) % 360) / 45) % 8]
            : '';
        wind = `${windKmh(w.windMs)} km/h${dir ? ` ${dir}` : ''}`;
    }
    return [desc, temp, wind].filter(Boolean).join(' · ') || null;
}

function antennaLine(ant) {
    if (!ant || !ant.enabled) return null;
    if (ant.grounded) return 'Grounded';
    if (ant.active_labels && ant.active_labels.length) return ant.active_labels.join(', ');
    if (ant.selected && ant.selected.length) {
        return ant.selected.map((n) => (ant.antenna_labels && ant.antenna_labels[n - 1]) || `Antenna ${n}`).join(', ');
    }
    return null;
}

// Only fetched while the overlay is actually on screen, so a waterfall-only
// session makes neither request.
function useStationOverlay(enabled) {
    const { serverInfo } = useRadio();
    const [weather, setWeather] = useState(null);
    const [antenna, setAntenna] = useState(null);

    const antEnabled = enabled && !!serverInfo?.ant_switch?.enabled;

    useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        // Through lib/weather.js, which is the Weather panel's source too: one
        // cache and one request between them, rather than two consumers each
        // polling an endpoint that allows one request a second.
        const load = () => fetchWeather()
            .then((r) => { if (!cancelled) setWeather(r.data ? weatherLine(r.data) : null); })
            .catch(() => { /* weather is optional — leave the line off */ });
        // 15 minutes, matching the server-side cache interval v1 tracks. Mostly
        // answered from the shared cache without a request going out.
        const stop = feedInterval(load, 15 * 60 * 1000);
        return () => { cancelled = true; stop(); };
    }, [enabled]);

    useEffect(() => {
        if (!antEnabled) return undefined;
        let cancelled = false;
        setAntenna(antennaLine(serverInfo.ant_switch));   // seed from /api/description
        const load = () => fetch('/api/ant-switch/status')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (!cancelled && d && d.enabled) setAntenna(antennaLine(d)); })
            .catch(() => { /* keep the last known label */ });
        const stop = feedInterval(load, 30000);
        return () => { cancelled = true; stop(); };
    }, [antEnabled, serverInfo]);

    // Memoised: SpectrumView re-renders on every pointer move, and the draw
    // loop only needs a new array when the text itself changes.
    const rx = serverInfo?.receiver;
    return useMemo(() => {
        if (!enabled || !rx) return null;

        const callsign = (rx.callsign || '').trim();
        const name = (rx.name || '').trim();
        if (!callsign && !name) return null;

        // "Dalgety Bay, Scotland, UK (UTC +1h)" — v1 appends the offset, in
        // hours and minutes, whenever the operator configured a timezone.
        let tzSuffix = '';
        if (typeof rx.timezone_offset === 'number') {
            const sign = rx.timezone_offset >= 0 ? '+' : '-';
            const abs = Math.abs(rx.timezone_offset);
            const h = Math.floor(abs / 60);
            const m = abs % 60;
            tzSuffix = m > 0 ? ` (UTC ${sign}${h}h${m}m)` : ` (UTC ${sign}${h}h)`;
        }
        const location = (rx.location || '').trim();
        const locationLine = location ? location + tzSuffix : tzSuffix.trim();

        return [
            { text: callsign && name ? `${callsign} - ${name}` : (callsign || name), bold: true, size: 13, alpha: 1 },
            ...[locationLine, weather, antenna]
                .filter(Boolean)
                .map((text) => ({ text, bold: false, size: 11, alpha: 0.75 })),
        ];
    }, [enabled, rx, weather, antenna]);
}

// The stats readout, in a corner of the waterfall. Off unless the Display panel
// says otherwise — see statLines for what each figure is and why it earns a line.
//
// Its own component and its own once-a-second timer, for the reason every other
// live readout here is: the view re-renders on pointer moves and the draw loop
// runs at frame rate, and neither of those should be tied to a diagnostic.
//
// Everything is differenced from counters rather than measured directly. The
// packet path and the draw loop increment an integer and nothing more; the rate
// is this timer's problem. That is also why the counters are read off the
// connection objects rather than from `view` — a closure over context state would
// be a second later, and the whole point is to be able to trust these numbers.
function SpectrumStats({ place, bottom, gfx, onClose }) {
    const { spectrumConn, audioConn, meters } = useRadio();
    const [lines, setLines] = useState([]);
    const prev = useRef(null);

    // How many people are on the receiver, from the poll the Listeners panel
    // uses. Shared and reference-counted (lib/listeners.js), so this joins the
    // existing loop when that panel is open and starts one of its own — a request
    // every ten seconds — when it is not. Held in a ref and read by the tick
    // below rather than kept in state: it changes on its own schedule and there
    // is no reason for it to redraw the readout off-beat.
    // And how many of them are in the chat room. Whatever the Chat panel has —
    // there is no second socket to open here, and none to open at all while that
    // panel is hidden, which is when this reads zero and the bracket is dropped.
    //
    // Mirrored into a ref on every render rather than closed over: a chat message
    // arriving must not rebuild the interval below, and the tick wants the latest
    // value rather than the one from when it was scheduled.
    const chatUsers = useChat().users.length;
    const chatRef = useRef(0);
    chatRef.current = chatUsers;

    // The address the receiver sees this page on. Asked for once a page and
    // shared with the start map, which asks for the same thing to say hello with —
    // see lib/myip.js. Whichever of the two gets there first pays for it.
    const ip = useRef((peekMyIp() || {}).ip || '');
    useEffect(() => {
        let alive = true;
        fetchMyIp().then((d) => { if (alive && d && d.ip) ip.current = d.ip; });
        return () => { alive = false; };
    }, []);

    const listeners = useRef(null);
    useEffect(() => subscribeListeners((state) => {
        const n = ((state && state.channels) || []).length;
        // Zero is not a reading — the list always contains this session, so an
        // empty one is a poll that has not landed or has failed. Leaving the last
        // count is better than blinking to a number that cannot be true.
        if (n > 0) listeners.current = n;
    }), []);

    useEffect(() => {
        prev.current = null;
        const tick = () => {
            const g = gfx.current;
            const now = performance.now();
            const at = {
                t: now,
                bytes: spectrumConn.bytesIn || 0,
                audio: (audioConn && audioConn.bytesIn) || 0,
                frames: spectrumConn.framesIn || 0,
                ticks: g.ticks || 0,
            };
            const was = prev.current;
            prev.current = at;
            // Nothing to difference against on the first tick: a rate needs two
            // readings, and inventing one from a counter's absolute value would
            // report a session's whole history as one second of traffic.
            if (!was) return;
            const ms = at.t - was.t;
            const m = meters.current;
            setLines(statLines({
                fps: perSecond(at.ticks - was.ticks, ms),
                framesIn: perSecond(at.frames - was.frames, ms),
                bytesIn: perSecond(at.bytes - was.bytes, ms),
                audioBytes: perSecond(at.audio - was.audio, ms),
                // Already a rate, measured by the panel that owns that stream —
                // null whenever it is closed, which is whenever the stream is.
                bandBytes: bandRate(),
                binCount: spectrumConn.binCount,
                binHz: spectrumConn.binBandwidth,
                divisor: spectrumConn.rateDivisor,
                // The stream's own figures, not the AudioContext's — see
                // AudioPlayer.streamRate for when those two disagree.
                streamRate: m.streamRate,
                streamChannels: m.channels,
                queuedSec: m.queuedSec,
                outLatSec: m.outLatencySec,
                underruns: m.underruns,
                listeners: listeners.current,
                chatUsers: chatRef.current,
                ip: ip.current,
                // Asked once a second, and the asking is what makes the host
                // measure — see lib/appStats.js. Nothing is read here while the
                // readout is off, which is the point: this is the only line
                // whose cost is paid outside the page.
                app: readAppStats(),
            }));
        };
        tick();
        const t = setInterval(tick, STATS_MS);
        return () => clearInterval(t);
    }, [spectrumConn, audioConn, meters, gfx]);

    if (!lines.length) return null;

    return (
        // Never in the way: a press here has to reach the spectrum underneath, or
        // a readout in the corner would be a patch of display you cannot drag,
        // pan or click-to-tune on. That also means the per-figure titles do not
        // appear as tooltips — they are what the Display panel's note is for, and
        // they are left on the elements so the DOM says what each number is.
        <div className={`spec-stats spec-stats--${place}`} style={{ bottom }}>
            {lines.map((l) => (
                <React.Fragment key={l.key}>
                    <span className="spec-stats__k" title={l.title}>{l.label}</span>
                    <span className="spec-stats__v" title={l.title}>{l.value}</span>
                </React.Fragment>
            ))}
            {/* The way out, on the thing itself. This readout is a diagnostic somebody
                turned on to answer a question, and when it is answered the natural gesture
                is to get rid of it — not to go looking through the Display panel for the
                dropdown that produced it.

                It is the one part of this box that takes a press: the rest deliberately
                lets clicks through to the spectrum, so the button re-enables pointer
                events for itself alone. Small and in the corner, because it sits over a
                display somebody is trying to read and it is not the point of the box. */}
            <button
                type="button"
                className="spec-stats__off"
                title="Hide the stats — turn them back on in the Display panel"
                aria-label="Hide the stats"
                // The press must not reach the wrapper this sits inside, for two reasons —
                // the same pair the paused overlay above guards against, and the reason a
                // click here used to do nothing except retune the receiver:
                //
                //   The wrapper takes pointer capture on pointerdown, for panning. While a
                //   pointer is captured every later event for it — the click included — is
                //   dispatched to the capture target, so the click never arrived at this
                //   button at all.
                //
                //   And a press that goes down and up without moving is a tap, which tunes
                //   to the frequency under it. So the button that was meant to dismiss the
                //   readout moved the dial to whatever was behind it instead.
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.stopPropagation()}
                onClick={onClose}
            >
                <Icon.Close size={9} />
            </button>
        </div>
    );
}

export default function SpectrumView() {
    const radio = useRadio();
    const display = useDisplay();
    const { spectrumConn, tuning, actions, view, meters } = radio;

    // The spectrum socket has been closed after a long spell of nothing (see
    // IdleWatch, and PAUSE_CHOICES for why that is a setting and not a rule).
    // Mirrored into state here because it changes what this draws: the last frame
    // stays on the canvas, dimmed, with the only way back in the middle of it.
    const [paused, setPaused] = useState(spectrumPaused);
    useEffect(() => onSpectrumPaused(setPaused), []);


    // Stopping and starting it by hand, which is the toolbar's toggle and the
    // overlay's button. The same state either way: there is one paused spectrum,
    // whether the timer closed it or somebody did, and it comes back the same way.
    const togglePause = () => {
        if (paused) resumeSpectrum(spectrumConn);
        else suspendSpectrum(spectrumConn);
        setSpectrumPaused(!paused);
    };

    const wrapRef = useRef(null);
    const specRef = useRef(null);
    const wfRef = useRef(null);
    const dssRef = useRef(null);
    // The tuning marks and the hover line, on a canvas of their own over the
    // waterfall. They have to be off the scrolling canvas: it is translated
    // between rows, and a marker that slid with it would not be pointing at the
    // frequency it names. Keeping them apart also stops them being repainted
    // for a scroll that does not move them.
    const wfMarksRef = useRef(null);
    const scaleRef = useRef(null);
    const wfScaleRef = useRef(null);
    // The ruler between the surface and the heat map, in '2d+3d' only.
    const midScaleRef = useRef(null);

    // Everything the draw loop needs, kept out of React state.
    const gfx = useRef({
        bins: null,
        peak: null,
        peakAt: 0,
        smoothed: null,
        ring: null,          // offscreen canvas
        ringCtx: null,
        ringHead: 0,
        // The surface's own magnitude ring, and whether its canvas needs
        // repainting. Null until a mode that draws one is chosen, so 2D pays
        // nothing for a feature it is not using.
        dss: null,
        // The view the surface's rows were recorded in, for the pan setting.
        dssCentre: 0,
        dssSpan: 0,
        // The level mapping the surface was last handed. Between-rows frames do
        // not compute one — that work belongs to the full draw — so they reuse
        // this. NaN until the first full frame, which drawSurface reads as
        // nothing to draw rather than drawing at a nonsense height.
        dssFloor: NaN,
        dssRange: NaN,
        ringHeight: 0,
        ringWidth: 0,
        dirty: false,
        dpr: 1,
        rowsPending: 0,
        // Ever-increasing counters for the stats readout, differenced once a
        // second by SpectrumStats. Declared here and not left to `g.ticks++` to
        // create: incrementing an undefined field gives NaN, which then reads
        // back through `|| 0` as a perfectly plausible zero — the readout showed
        // "0.0" for both of these while the loop ran perfectly well.
        //
        // `ticks` is every animation frame, drawn or not. Counting only the drawn
        // ones measured the *feed* — the loop paints when a frame arrives and
        // sleeps otherwise, so "FPS" and "frames in" were the same number twice.
        // The rate the browser is managing is a different fact, and the only one
        // of the two this counter can tell you.
        ticks: 0,            // animation frames, i.e. what the browser is managing
        autoFloor: -110,
        autoCeil: -40,
        hover: null,         // {x, y} in CSS px
        drag: null,
        hold: null,          // a finger being held still, waiting to become a menu
        held: false,         // ...and whether it got there, which a tap must not undo
        pts: new Map(),      // live pointers, id -> {x, y}; two of them is a pinch
        pinch: null,         // {dist, bw, last} the view the fingers went down on
        bgImage: null,       // operator backdrop, split view only
        bgOpacity: 0,
        bgUrl: '',
    });

    // Mirrors of React values the draw loop reads; refs avoid re-subscribing.
    const cfgRef = useRef({ centerFreq: 0, span: 0, binCount: 0, binBandwidth: 0 });
    cfgRef.current = view;
    const tuneRef = useRef(tuning);
    tuneRef.current = tuning;
    const dispRef = useRef(display);
    dispRef.current = display;

    const [hoverInfo, setHoverInfo] = useState(null);
    const hovering = hoverInfo != null;
    const [sizes, setSizes] = useState({ w: 0, h: 0 });

    // How the centre area is divided. The scale sits between the two panes, so
    // in spectrum-only it ends up along the bottom and in waterfall-only along
    // the top — both the conventional placement — with no special casing.
    const viewMode = display.viewMode || 'split';
    // Whether the waterfall's history is dragged onto the new axis when the view
    // moves, or left where it was painted. See alignRingToView.
    const panFollows = display.waterfallPan === 'follow';

    // Station ID overlay: split view only, and only if the operator left it on.
    // The lines go into the gfx ref because the draw loop, not React, paints
    // them — they change every few minutes at most.
    // Split view only — it goes in the spectrum pane, and there is not one in the
    // other two — and only while both ends want it: the operator's ui-config and
    // the listener's own switch in the Display panel.
    const station = useStationOverlay(
        viewMode === 'split'
        && display.server.stationIdOverlay
        && display.stationInfo !== false,
    );
    useEffect(() => {
        gfx.current.station = station;
        gfx.current.stationColor = display.server.stationIdColor;
        gfx.current.dirty = true;
    }, [station, display.server.stationIdColor]);

    // The display's frame interval, measured once and kept across restarts of
    // the draw loop below. Why it cannot be measured per start: see the burst.
    const vsyncRef = useRef(0);

    // ---- sizing ---------------------------------------------------------

    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return undefined;
        const ro = new ResizeObserver(() => {
            const r = el.getBoundingClientRect();
            setSizes({ w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height)) });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // The bottom ruler only exists where there is a waterfall to put it under.
    const wfScaleH = viewMode === 'spectrum' ? 0 : WF_SCALE_H;
    const avail = Math.max(0, sizes.h - SCALE_H - wfScaleH);
    let specH;
    if (viewMode === 'spectrum') {
        specH = avail;
    } else if (viewMode === 'waterfall') {
        specH = 0;
    } else {
        // Keep both panes usable, but never demand more height than exists.
        const minSpec = Math.min(MIN_SPECTRUM_H, avail);
        const minWf = Math.min(MIN_WATERFALL_H, Math.max(0, avail - minSpec));
        specH = clamp(Math.round(avail * display.split), minSpec, avail - minWf);
    }
    const wfH = avail - specH;

    // How the waterfall area is shared. The surface is drawn on its own canvas
    // rather than into the waterfall's, so the 2D path — the ring, the smooth
    // scroll transform, the marks — is exactly the code it always was and the
    // default mode cannot regress.
    //
    // In 'both' the surface takes the top half. That is not arbitrary: our
    // waterfall runs newest-at-the-top downward, and the surface runs
    // newest-at-the-front upward, so with the surface above the heat map the two
    // newest rows meet at the seam and time runs outward in both directions from
    // the same instant.
    //
    // With both on screen they get a ruler between them. The seam is where the
    // two newest rows meet, so it is the one place in the pane where a frequency
    // can be read against *both* pictures at once — and without it the surface's
    // front edge runs straight into the heat map's top row with nothing to say
    // they are the same instant.
    // The frame cap in force — 30 by default on anything touch-driven, the
    // display's rate elsewhere (see resolveMaxFps). Above the draw loop that
    // reads it, which is not a style preference: this file has a test that
    // fails a dependency declared below its effect.
    const touch = useMediaQuery(TOUCH_QUERY);
    const maxFps = resolveMaxFps(display.maxFps, touch);

    const wfMode = viewMode === 'spectrum' ? '2d' : (display.waterfallMode || '2d');
    const midH = wfMode === 'both' && wfH > WF_SCALE_H * 4 ? WF_SCALE_H : 0;
    const dssH = wfMode === '3d' ? wfH
        : wfMode === 'both' ? Math.round((wfH - midH) * DSS_SPLIT)
            : 0;
    const heatH = wfH - dssH - midH;

    // Debug only, and 1 — i.e. nothing — unless the section is open and has been
    // set. Clamped here rather than trusted from storage, since a stored 0 would
    // size every canvas to a single pixel and leave no way back but the console.
    const renderScale = display.debug
        ? clamp(Number(display.dbgRenderScale) || 1, 0.25, 1)
        : 1;

    // Size the backing stores for device pixels and rebuild the waterfall ring.
    //
    // A layout effect, not an ordinary one: this clears every canvas, and an
    // ordinary effect runs after the browser has painted — which is a painted
    // frame with nothing in it. Here the clearing, the ring rebuild and the
    // redraw below all happen before that paint.
    useLayoutEffect(() => {
        const dpr = Math.min(2, window.devicePixelRatio || 1) * renderScale;
        const g = gfx.current;
        g.dpr = dpr;

        const w = Math.max(1, Math.round(sizes.w * dpr));

        // Setting a canvas's width or height clears it, and the marks are drawn
        // only when they change — so the record of what is on them has to go
        // with the pixels, or a resize would leave them blank until the dial
        // next moved.
        g.marksKey = '';

        // Everything except the waterfall is sized to exactly what it shows.
        for (const [ref, h] of [
            // The marks belong to the heat map, not to the surface: a VFO line
            // drawn straight down a receding trapezoid would cross a different
            // frequency on every row of it. The surface carries its own
            // frequency sense through unproject instead.
            [specRef, specH], [scaleRef, SCALE_H], [wfMarksRef, heatH], [wfScaleRef, wfScaleH],
        ]) {
            const c = ref.current;
            if (!c) continue;
            c.width = w;
            c.height = Math.max(1, Math.round(h * dpr));
            c.style.width = sizes.w + 'px';
            c.style.height = h + 'px';
        }

        // The waterfall is RING_PAD taller than its container, which clips it.
        // That overhang is what the smooth scroll slides: the newest row is
        // painted above the top edge and travels down into view, so the picture
        // moves continuously between rows instead of jumping when one arrives.
        const midc = midScaleRef.current;
        if (midc) {
            midc.width = w;
            midc.height = Math.max(1, Math.round(midH * dpr));
            midc.style.width = sizes.w + 'px';
            midc.style.height = midH + 'px';
        }

        const dssc = dssRef.current;
        if (dssc) {
            dssc.width = w;
            dssc.height = Math.max(1, Math.round(dssH * dpr));
            dssc.style.width = sizes.w + 'px';
            dssc.style.height = dssH + 'px';
        }

        const h = Math.max(1, Math.round(heatH * dpr)) + RING_PAD;
        const wfc = wfRef.current;
        if (wfc) {
            wfc.width = w;
            wfc.height = h;
            wfc.style.width = sizes.w + 'px';
            wfc.style.height = (h / dpr) + 'px';
        }
        // How tall the ring is kept, which is not how tall the pane is: see
        // ringHeightFor. `h` is what is shown; this is what is remembered.
        const ringH = ringHeightFor(h, g.ringHeight, dpr);
        if (g.ringWidth !== w || g.ringHeight !== ringH) {
            // A resize needs a new ring; the history moves across into it.
            //
            // A height change is free — a row is a finished scanline and the
            // height only says how many fit. A width change is a rescale: the
            // columns are frequencies, and the axis they sit on has just been
            // redrawn at a different length. Both are what dragging the window
            // edge, the splitter or a dock beside it produce, and wiping the
            // last few minutes of the band for either was pure loss. See
            // ringKeepsHistory.
            const oldW = g.ringWidth;
            const keep = ringKeepsHistory(
                { ring: g.ring, width: oldW, height: g.ringHeight }, w,
            );

            const ring = document.createElement('canvas');
            ring.width = w;
            ring.height = ringH;
            const ctx = ring.getContext('2d', { alpha: false });
            ctx.fillStyle = RING_BG;
            ctx.fillRect(0, 0, w, ringH);

            if (keep) {
                // Nearest neighbour, as the zoom path uses: a column of history
                // is duplicated or dropped rather than blended with the one
                // beside it, so a one-pixel carrier stays a line instead of
                // becoming a smear. Smoothing is what would turn a week of
                // history into porridge over a long drag.
                ctx.imageSmoothingEnabled = false;
                // Copied out unrolled, newest first — the same read the paint
                // does, which is why the head can then be 0. Growing leaves the
                // background showing below the oldest row we have, since that
                // history does not exist yet; shrinking drops the oldest rows,
                // which are the ones about to scroll off anyway. The horizontal
                // extents differ where the width changed, which is the rescale.
                for (const s of ringSlices(g.ringHead, g.ringHeight, Math.min(g.ringHeight, ringH))) {
                    ctx.drawImage(g.ring, 0, s.sy, oldW, s.sh, 0, s.dy, w, s.sh);
                }
            }

            g.ring = ring;
            g.ringCtx = ctx;
            g.ringWidth = w;
            g.ringHeight = ringH;
            g.ringHead = 0;
            // A kept history is still in the view it was painted in — a rescale
            // changes how many pixels it takes, not which frequencies it covers,
            // so the recorded centre and span stand. A dropped one has no view,
            // and the next draw records the current one.
            if (!keep) g.ringSpan = 0;
        }
        g.dirty = true;
    }, [sizes.w, sizes.h, specH, wfH, heatH, dssH, midH, wfScaleH, renderScale]);

    // ---- data -----------------------------------------------------------

    useEffect(() => {
        const off = spectrumConn.on('frame', ({ bins }) => {
            const g = gfx.current;
            g.bins = bins;
            g.rowsPending++;
            g.dirty = true;
        });
        return off;
    }, [spectrumConn]);

    // ---- draw loop ------------------------------------------------------
    //
    // Stopped entirely while the spectrum is paused, rather than left ticking
    // over its own early return.
    //
    // A requestAnimationFrame loop that keeps re-arming keeps the browser's
    // refresh driver at the display's full rate for as long as the page is open
    // — a hundred and twenty callbacks a second on a fast panel, each one
    // returning immediately because there is nothing to draw. The callbacks
    // themselves are nearly free; keeping the tab in a continuously animating
    // state is not, and it is charged to the compositor rather than to this
    // file, which is why every attempt to find it by removing *drawing* came
    // back "no difference".
    //
    // Paused is the case where stopping is provably safe: no frames arrive, the
    // overlay covers the canvas so there is no hover to track, and resuming
    // re-runs this effect and starts a fresh loop. Nothing needs a frame in
    // between.
    // A layout effect, like the sizing above it and for the same reason: this is
    // what puts the picture back after a resize has cleared it, and an ordinary
    // effect runs after the browser has painted — which is one painted frame of
    // empty canvas per resize, i.e. per frame of a splitter drag.
    useLayoutEffect(() => {
        if (paused) return undefined;
        let raf = 0;
        let timer = 0;
        let lastRow = 0;

        // How long a frame should last, 0 for the display's own rate.
        const capMs = maxFps > 0 ? 1000 / maxFps : 0;

        // Capped, the next frame is asked for by a timer and only *then* by the
        // animation frame — which is the whole difference between this and an
        // early return inside the callback.
        //
        // An early return would still leave a frame request outstanding at all
        // times, so the browser would still be driving its frame pipeline at the
        // display's rate and the cost described above would be unchanged; all it
        // would save is the drawing, which is measurably not what this display
        // spends its time on. With no outstanding request between ticks there is
        // nothing to drive.
        //
        // Still an animation frame at the end of the wait, rather than drawing
        // straight from the timer: that is what keeps the paint on a vsync
        // boundary, and what still stops the loop dead in a hidden tab.
        // Capped, the schedule is built on the display's own grid, because that
        // grid is where frames actually land. Three separate things made a
        // plain "wait capMs, then ask" jerky, and each is handled by name:
        //
        //   * **Paints happen at vsyncs, so the period must be a whole number
        //     of them.** 30 on a 60 Hz panel is every second frame and comes
        //     out even; 20 on a 90 Hz panel is four and a half, which the
        //     display delivers as 44 ms, 56 ms, 44 ms — jerk built into the
        //     target itself. So the display's frame interval is measured (a
        //     one-off burst of a few animation frames, below) and the period is
        //     rounded *up* to whole frames. Up, never to nearest: nearest could
        //     exceed the chosen rate, and the cap is a promise about cost
        //     before it is one about smoothness.
        //
        //   * **A late timer must not be paid back.** Each frame is anchored to
        //     the timestamp of the one just painted — rephase, not catch-up. A
        //     tick that slips a vsync is followed by evenly spaced frames from
        //     where it landed; the old schedule followed it with a *short*
        //     frame to make the average, and a long-short pair is the most
        //     visible stutter there is. The cost of rephasing is that a slip
        //     lowers the average rate slightly, which is the right side to err
        //     on for both smoothness and cost.
        //
        //   * **The wake has to beat the vsync it is aiming at.** setTimeout
        //     runs late under load, and every late wake is a slipped frame. The
        //     timer therefore wakes almost a whole display frame early — the
        //     next vsync after the wake *is* the target, so waking early by
        //     less than one frame cannot land a frame early, and the slack is
        //     lateness budget for free.
        //
        // The saving is untouched by all of this: between ticks there is still
        // no outstanding frame request at all, which is the whole difference
        // between this and an early return inside the callback (see below).
        let vsyncMs = vsyncRef.current;
        let due = 0;

        const arm = (ts) => {
            if (capMs <= 0) { raf = requestAnimationFrame(loop); return; }
            const measured = vsyncMs > 2;
            const period = measured
                ? Math.max(1, Math.ceil((capMs - 1) / vsyncMs)) * vsyncMs
                : capMs;
            const slack = measured ? Math.min(12, vsyncMs * 0.8) : 6;
            due = (ts || performance.now()) + period;
            timer = setTimeout(() => { raf = requestAnimationFrame(loop); },
                Math.max(0, due - performance.now() - slack));
        };

        // The display's frame interval, measured rather than assumed: 60 Hz is
        // only the common case, and phones and external monitors run at 90,
        // 120 and 144. A short burst of consecutive animation frames, median
        // of the gaps — the median because any one gap can be stretched by a
        // busy main thread, and the middle of nine is not. Measured once and
        // then remembered in vsyncRef, because this loop restarts far more
        // often than the display changes — every resize, every cap change,
        // every pause — and a burst that draws nothing on each of those is a
        // pane that goes blank whenever it is re-sized. A window dragged to a
        // different monitor keeps the old figure, which costs a rounding of the
        // frame period and nothing else, where a continuous measurement would
        // be the pipeline this cap exists to stop.
        const stamps = [];
        const calibrate = (ts) => {
            stamps.push(ts);
            if (stamps.length < 10) { raf = requestAnimationFrame(calibrate); return; }
            const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
            vsyncMs = gaps[Math.floor(gaps.length / 2)];
            vsyncRef.current = vsyncMs;
            loop(ts);
        };

        // Armed, then painted. The two were one function, and separating
        // them is what lets a resize paint out of band without also asking for
        // a second frame — see `repaint` and the sizing effect.
        const loop = (ts) => { arm(ts); paint(ts); };

        const paint = (ts) => {
            const g = gfx.current;
            g.ticks++;              // before the early return: an idle frame is still a frame
            const d = dispRef.current;
            if (!g.bins) return;

            const now = performance.now();
            // How long the gap between rows is *actually* turning out to be,
            // which is what the surface slides across. Not 1000 / waterfallRate:
            // that setting is a cap, a row needs a spectrum frame to carry it,
            // and on a server sending fewer frames a second than the cap asks
            // for the real gap is several times longer. Measured against the
            // nominal one, the slide finished in the first third of every row
            // and then sat frozen until the next — glide, freeze, snap, twenty
            // times a second. g.rowDt is the same measurement the heat map's
            // scroll animation is timed from, so the two move together.
            // The surface moves *between* rows — see drawSurface's `progress` —
            // so it is the one thing here that wants every animation frame. The
            // heat map does not: its slide is a compositor transform and costs
            // no JS at all, which is exactly why it looks the way it does.
            if (!g.dirty) {
                if (dssH > 0) {
                    drawDss(g, d, dssRef.current, dssH, Math.max(1, Math.round(sizes.w * g.dpr)),
                        g.dssFloor, g.dssRange, false, now,
                        cfgRef.current, tuneRef.current);
                }
                return;
            }
            // Waterfall speed throttles how often a row is committed, so a fast
            // server feed can still be shown as a slow-scrolling history.
            const rowInterval = 1000 / d.waterfallRate;
            const commitRow = g.rowsPending > 0 && now - lastRow >= rowInterval;
            if (commitRow) {
                // How long the last row took to arrive, which is the best guess
                // at how long the next one will — and so how long this one has
                // to slide into view. The raw gap is kept as well as the
                // estimate: two arrivals that agree with each other and not with
                // the estimate are a change of rate rather than a late frame.
                // See smoothInterval.
                if (lastRow) {
                    const gap = now - lastRow;
                    g.rowDt = smoothInterval(g.rowDt, gap, g.lastGap);
                    g.lastGap = gap;
                }
                lastRow = now;
                g.rowsPending = 0;
            }

            drawFrame(g, d, {
                spec: specRef.current,
                wf: wfRef.current,
                dss: dssRef.current,
                dssH,
                heatH,
                // The clock the surface places its rows against — see
                // drawSurface. Nothing is accumulated; `now` moving is the whole
                // animation.
                drawAt: now,
                wfMarks: wfMarksRef.current,
                scale: scaleRef.current,
                wfScale: wfScaleRef.current,
                midScale: midScaleRef.current,
                midH,
                cfg: cfgRef.current,
                tuning: tuneRef.current,
                width: sizes.w,
                specH,
                wfH,
                commitRow,
                // Seconds since the last draw, which is what makes the trace
                // smoothing and the auto-levels settle in the same time however
                // often frames arrive.
                dt: g.drawAt ? (now - g.drawAt) / 1000 : 0,
            });
            g.drawAt = now;
            g.dirty = false;
        };

        // The picture, now: this effect restarts on every change of the sizes
        // below, and the sizing effect has just cleared every canvas it is
        // about to redraw. Before the arming, so that a burst of restarts —
        // which is what a splitter drag is — still paints on each of them.
        paint(performance.now());

        // Straight in uncapped; through the measurement burst when capped, and
        // only when the interval is not already known. The burst draws nothing
        // and takes ten animation frames, which is fine once on a loop that
        // runs for as long as the receiver does — and was the whole bug when it
        // ran on every restart. Dragging the splitter restarts this loop on
        // every frame of the drag, so the burst never finished, nothing was
        // ever drawn, and the pane stayed black until the drag stopped. See
        // vsyncRef.
        if (capMs > 0 && !vsyncMs) raf = requestAnimationFrame(calibrate);
        else arm();
        return () => {
            cancelAnimationFrame(raf);
            clearTimeout(timer);
            // A held `fill: forwards` animation outlives the loop that started
            // it, and would leave the canvas parked a row out of place for
            // whatever draws next.
            const g = gfx.current;
            if (g.scroll) {
                g.scroll.cancel();
                g.scroll = null;
            }
        };
    }, [sizes.w, specH, wfH, dssH, heatH, midH, paused, display.debug, maxFps]);

    // Redraw when a display setting changes even if no new frame arrived.
    useEffect(() => {
        const g = gfx.current;
        g.dirty = true;
        // Turning the scroll off has to put the canvas back straight away. The
        // next committed row would do it, but on a feed that has gone quiet
        // there may not be one, and the picture would sit a row out of place.
        if (display.smoothScroll === false && g.scroll) {
            g.scroll.cancel();
            g.scroll = null;
            if (wfRef.current) wfRef.current.style.transform = '';
        }
    }, [display]);

    // Operator-supplied backdrop for the spectrum, behind the trace.
    //
    // Only fetched once split view is actually used — the image can be a
    // several-hundred-kilobyte PNG, and there is no reason to pull it for
    // someone who only ever looks at the waterfall. Once loaded it is kept, so
    // toggling view modes does not re-fetch it.
    const { bgImage: bgUrl, bgOpacity } = display.server;
    useEffect(() => {
        const g = gfx.current;
        g.bgOpacity = bgOpacity;
        g.dirty = true;
        if (viewMode !== 'split' || !bgUrl || g.bgUrl === bgUrl) return undefined;

        g.bgUrl = bgUrl;
        const img = new Image();
        img.onload = () => {
            if (gfx.current.bgUrl !== bgUrl) return;   // config changed mid-flight
            gfx.current.bgImage = img;
            gfx.current.dirty = true;
        };
        img.onerror = () => {
            console.warn('spectrum: background image failed to load', bgUrl);
            if (gfx.current.bgUrl === bgUrl) gfx.current.bgImage = null;
        };
        // Cache-bust so a freshly uploaded image is picked up, as v1 does.
        img.src = bgUrl + (bgUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        return () => { img.onload = null; img.onerror = null; };
    }, [bgUrl, bgOpacity, viewMode]);

    // ---- right-click menu -------------------------------------------------
    //
    // { x, y, freq } while open. `freq` is where the pointer was, captured at
    // the click rather than read back later — the view can pan or zoom under an
    // open menu. Each entry decides whether it is about that spot or about the
    // dial; adding a bookmark is about the dial.
    const [menu, setMenu] = useState(null);
    const [adding, setAdding] = useState(null);
    // The frequency being spotted, while the dialog is up. See SpotOnCluster.
    const [spotting, setSpotting] = useState(null);

    // Which of the toolbar's readouts still fit beside the tags that are state.
    //
    // The squelch, the noise reduction, the filters, the control surfaces and the
    // clip warning are never dropped: each says something is *happening* that
    // nothing else on screen says, and a wrapped second row of them is better
    // than a missing one. The rest are context, and every one of them is
    // already written somewhere else — so they are what gives way to keep the
    // row on one line.
    //
    // In keep order, most important last to go:
    //
    //   span     what the ruler's whole width means. First to be kept because
    //            it is the one that changes as you work — a zoom is the
    //            commonest thing done to this display.
    //   centre   where the view is. The ruler says it too, in more detail, but
    //            only if you read a tick.
    //   offset   the receiver's own frequency error. A standing fact about the
    //            hardware rather than about this moment.
    //   cursor   where the pointer is. Transient, and the tooltip under the
    //            pointer is already saying it.
    //   pcm      the audio format, and the only one here that is state rather
    //            than context — so it is the exception to the paragraph above,
    //            and last because being state does not make it urgent. It says
    //            a deliberate setting is still in force, which will still be
    //            true in a minute, and the Audio panel shows and changes it
    //            whether or not there is room for the badge. Nothing is missed
    //            by dropping it first; a wrapped row would cost more.
    const metaRef = useRef(null);
    const room = useRoomFor(metaRef, [
        { key: 'span', width: SPAN_TAG_W },
        { key: 'centre', width: CENTRE_TAG_W },
        { key: 'offset', width: OFFSET_TAG_W },
        { key: 'cursor', width: CURSOR_TAG_W },
        { key: 'pcm', width: PCM_TAG_W },
    ]);

    // The centre frequency goes on a phone: the ruler under the spectrum already
    // has it, and the tags left of the zoom buttons are the scarcest row in the
    // layout there.
    const mobile = useMediaQuery(MOBILE_QUERY);
    // Is anything here able to scroll a wheel? See the toolbar below.
    const hasWheel = useMediaQuery(HOVER_QUERY);

    // The diagnostic readout in a corner of the waterfall, and which corner. Not
    // chosen resolves per device — see statsPlace — which is why it is worked out
    // here rather than higher up: it needs `mobile`.
    const statsAt = statsPlace(display.spectrumStats, mobile);
    // Peak markers. Resolved here and left on the gfx ref, as bgOpacity and the station
    // colour are, rather than being dug out of the settings inside the draw.
    gfx.current.peaksWanted = peakCount(display.peakMarks);
    gfx.current.peaksSnr = peakSnr(display.peakMinSnr);
    gfx.current.peaksPlace = peakPlace(display.peakMarksAt);

    // A handset on its side gives the whole toolbar up, tags and all. With the
    // top bar gone too (see MobileShell) the spectrum starts at the marker bar,
    // which is about a fifth of the screen back on a display with 390 px of
    // height to begin with. Nothing is lost for good: pinch zooms, a drag pans,
    // the marker bar is untouched, and a rotation brings the row back.
    const shortLandscape = useMediaQuery(LANDSCAPE_QUERY);
    const bare = mobile && shortLandscape;

    // The pointer handlers below are registered once and must not close over a
    // stale answer, so this goes in a ref like `display` does.
    const mobileRef = useRef(mobile);
    mobileRef.current = mobile;
    const anchorNow = () => resolveZoomAnchor(dispRef.current.zoomAnchor, mobileRef.current);

    // What the pointer is on: the dial line, or anywhere in the passband.
    //
    // Separate from edgeAtX, and deliberately without its width threshold: that
    // one decides whether an edge can be *grabbed*, and there is no point
    // offering a handle too narrow to aim at. Saying what a line is costs
    // nothing, so it answers at any zoom, and the dial wins a tie because when
    // the passband collapses to a pixel the dial is what you are pointing at.
    const markAtX = useCallback((clientX) => {
        const el = wrapRef.current;
        const cfg = cfgRef.current;
        const t = tuneRef.current;
        if (!el || !cfg.span || !(t.frequency > 0)) return null;
        const r = el.getBoundingClientRect();
        if (!r.width) return null;
        const x = clientX - r.left;
        const xAt = (hz) => ((hz - (cfg.centerFreq - cfg.span / 2)) / cfg.span) * r.width;
        // The dial first, and only within a few pixels: it is a line, and when
        // the passband collapses to nothing it is what is under the pointer.
        if (Math.abs(x - xAt(t.frequency)) <= EDGE_GRAB_PX) return 'dial';
        // Then anywhere in the passband — the shaded area, edges included.
        // Pointing at the middle of the filter is asking the same question as
        // pointing at its edge, and the shading is a far easier target than a
        // line is.
        const a = xAt(t.frequency + t.bandwidthLow);
        const b = xAt(t.frequency + t.bandwidthHigh);
        const lo = Math.min(a, b) - EDGE_GRAB_PX;
        const hi = Math.max(a, b) + EDGE_GRAB_PX;
        return x >= lo && x <= hi ? 'filter' : null;
    }, []);

    // Which passband edge is under the pointer, if either. The geometry and the
    // reasoning about the zone sizes are in lib/edgeHit.js; this is the part
    // that reads the live view.
    const edgeAtX = useCallback((clientX, touch = false) => {
        const el = wrapRef.current;
        const cfg = cfgRef.current;
        if (!el || !cfg.span) return null;
        // Switched off in the display settings, and switched off *here* so the
        // whole gesture goes with it — the grab, the drag and the col-resize
        // cursor that advertises them. Refusing it further down would have left
        // the pointer still changing shape over a line that no longer answers.
        if (dispRef.current.edgeDrag === false) return null;
        const r = el.getBoundingClientRect();
        return edgeHit(
            clientX - r.left, r.width, cfg.span, cfg.centerFreq, tuneRef.current,
            touch ? TOUCH_GRAB_PX : EDGE_GRAB_PX,
            touch ? TOUCH_EDGE_MIN_PX : EDGE_MIN_PX,
        );
    }, []);

    // ---- pointer interaction --------------------------------------------

    // The frequency under a point.
    //
    // Flat everywhere except inside the 3D surface, where a row's width shrinks
    // with depth and a column of screen is a different frequency on every row of
    // it. Passing clientY is what lets a click on a peak three seconds back tune
    // to the frequency it was actually on — the same promise clicking partway
    // down the heat map makes, which is the whole reason the surface can live in
    // the waterfall pane at all. Omit it and the mapping is the flat one, which
    // is right for everything outside that box.
    const freqAtX = useCallback((clientX, clientY) => {
        const el = wrapRef.current;
        const cfg = cfgRef.current;
        if (!el || !cfg.span) return null;
        const r = el.getBoundingClientRect();
        let frac = (clientX - r.left) / r.width;

        const d = dssRef.current;
        if (d != null && clientY != null) {
            const dr = d.getBoundingClientRect();
            if (dr.height > 0 && clientY >= dr.top && clientY <= dr.bottom) {
                const u = dssUnproject(
                    (clientX - dr.left) / dr.width,
                    (clientY - dr.top) / dr.height,
                );
                // Beside the trapezoid rather than on it: there is no frequency
                // under the pointer there, and clamping would silently tune to
                // the band edge instead of doing nothing.
                if (u.freqUnit < 0 || u.freqUnit > 1) return null;
                frac = u.freqUnit;
            }
        }

        frac = clamp(frac, 0, 1);
        return cfg.centerFreq - cfg.span / 2 + frac * cfg.span;
    }, []);

    // ---- dragging the scale to re-share the height ----------------------
    //
    // The frequency scale sits exactly on the join between the two panes, which
    // makes it the obvious thing to grab — it is where a window manager would
    // put a splitter, and it is already the one strip of the display that is
    // neither spectrum nor waterfall. So it doubles as one, and does the same
    // thing as the Display panel's Split slider between the same limits.
    //
    // The press is swallowed rather than allowed to reach the container, which
    // would otherwise read it as the start of a pan and retune the receiver on
    // release.
    //
    // Switchable from the Display panel, under the Split slider. The scale is
    // also the strip you point at to read a frequency off, and those two uses
    // are hard to tell apart from a few pixels of travel — so an operator who
    // keeps re-sharing the display by accident can turn the drag off and keep
    // the slider. The double-click reset stays either way: it cannot be
    // triggered by aiming at something.
    const canSplitDrag = viewMode === 'split' && display.splitDrag !== false;
    const splitDrag = useRef(null);
    const splitRaf = useRef(0);
    const splitNext = useRef(0);

    // Coalesced to one write per animation frame. A pointer can report far
    // faster than the screen refreshes — a high-rate mouse is 1 kHz — and every
    // write here re-renders each panel that reads the display settings and
    // re-allocates the waterfall ring for the new height. One per frame is all
    // that can be shown, so it is all that is done.
    // Through dispRef rather than `display` so this and the handlers below keep
    // their identity for the whole gesture: `display` is a new object on every
    // settings change — including each of these writes — and a handler that was
    // replaced between two moves would have React re-attaching listeners
    // mid-drag. `set` itself is stable.
    const setSplit = useCallback((v) => {
        splitNext.current = v;
        if (splitRaf.current) return;
        splitRaf.current = requestAnimationFrame(() => {
            splitRaf.current = 0;
            dispRef.current.set({ split: splitNext.current });
        });
    }, []);

    useEffect(() => () => { if (splitRaf.current) cancelAnimationFrame(splitRaf.current); }, []);

    const onSplitDown = useCallback((e) => {
        // Only in split view: with one pane there is nothing to share, and the
        // scale is then an ordinary part of the display that a press should
        // reach. A right-click is the context menu's, in every mode.
        if (viewMode !== 'split' || e.button === 2) return;
        // Deliberately no preventDefault: on pointerdown it suppresses the
        // compatibility mouse events, and the double-click reset below is one of
        // them. Selection is held off with user-select in the stylesheet
        // instead, which is what preventDefault would have been for.
        //
        // Swallowed before the switch is consulted, so turning the drag off
        // leaves the scale inert rather than handing the press to tap-to-tune.
        // The reason for turning it off is a gesture aimed at reading a
        // frequency that keeps re-sharing the display; replacing that with a
        // gesture that retunes the receiver would be the worse accident.
        e.stopPropagation();
        if (!canSplitDrag || avail <= 0) return;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        // The share at the moment of the press. Every move is measured against
        // this and the total travel, not accumulated step by step, so the
        // boundary tracks the pointer exactly however the moves are batched.
        splitDrag.current = { y: e.clientY, split: dispRef.current.split };
        haptic('grab', 'spectrum');
    }, [viewMode, canSplitDrag, avail]);

    const onSplitMove = useCallback((e) => {
        const d0 = splitDrag.current;
        if (!d0) return;
        e.stopPropagation();
        // The pointer moves the boundary, so a pixel of travel is a pixel of
        // spectrum — which is what makes it feel like dragging the edge rather
        // than operating a control that happens to live there.
        setSplit(clamp(d0.split + (e.clientY - d0.y) / avail, SPLIT_MIN, SPLIT_MAX));
    }, [avail, setSplit]);

    const onSplitUp = useCallback((e) => {
        if (!splitDrag.current) return;
        splitDrag.current = null;
        e.stopPropagation();
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }, []);

    // Back to the default share, the way a window manager's splitter evens two
    // panes out on a double-click.
    const onSplitDouble = useCallback((e) => {
        if (viewMode !== 'split') return;
        e.stopPropagation();
        dispRef.current.set({ split: DISPLAY_DEFAULTS.split });
    }, [viewMode]);

    // The menu, however it was asked for. Answers at most once per press: the
    // two ways in below can both fire for the same finger, and the second must
    // not re-open what the first opened or pulse a second time.
    const openMenu = useCallback((x, y) => {
        const g = gfx.current;
        if (g.held) return false;
        const f = freqAtX(x, y);
        if (f == null) return false;   // no view yet; leave the browser menu alone
        if (g.hold) { clearTimeout(g.hold.timer); g.hold = null; }
        g.held = true;
        // A long press has no click and no release to tell you it worked — the
        // menu simply appears, some way into a press you were holding for an
        // unknown length of time. The pulse is what says "now", and it is the
        // same one a right button gets.
        haptic('grab', 'spectrum');
        setMenu({ x, y, freq: Math.round(f) });
        return true;
    }, [freqAtX]);

    const onContextMenu = useCallback((e) => {
        if (openMenu(e.clientX, e.clientY)) e.preventDefault();
    }, [openMenu]);

    const onPointerDown = useCallback((e) => {
        // Right button: the context menu handler deals with it, and starting a
        // pan here would drag the view out from under the menu.
        if (e.button === 2) return;
        const el = wrapRef.current;
        if (!el) return;
        el.setPointerCapture(e.pointerId);
        const g = gfx.current;
        g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        // A fresh press: whatever the last one opened, this one has not.
        g.held = false;
        if (g.hold) { clearTimeout(g.hold.timer); g.hold = null; }

        // Second finger down: this is a pinch, not a drag. The first finger has
        // a drag open — drop it, or the release at the end of the pinch reads as
        // a tap and tunes the receiver to wherever the fingers happened to be.
        if (g.pts.size === 2) {
            // Two fingers are a pinch and never a menu.
            if (g.hold) { clearTimeout(g.hold.timer); g.hold = null; }
            g.drag = null;
            g.edge = null;
            g.hover = null;
            setHoverInfo(null);
            const pair = pinchPair(g.pts);
            g.pinch = {
                dist: pinchDist(pair),
                bw: cfgRef.current.binBandwidth,
                // What the gesture zooms about, decided once, here.
                //
                // Two reasons it is not recomputed per step. The setting is the
                // first: 'tuned' means the dial stays centred, which zoomCenter
                // takes as a null point, and pinch used to ignore that and
                // always anchor on the fingers — so on a phone, where pinch is
                // the only way to zoom, the one control for this did nothing.
                //
                // The second is the walk. A pinch is quantised onto the server's
                // ladder and takes a step at most every PINCH_MS, and fingers do
                // not spread symmetrically — one travels further than the other,
                // so the midpoint slides. Re-reading it per step anchored each
                // one on a different frequency and marched the view along the
                // band. Fixed at the start, the whole gesture turns about a
                // single point, which is what the fingers are asking for.
                about: anchorNow() === 'tuned'
                    ? null
                    : freqAtX((pair[0].x + pair[1].x) / 2),
                last: 0,
            };
            return;
        }
        if (g.pts.size > 2) return;   // a third finger changes nothing

        // An edge under the pointer takes the gesture: no pan, and no tune on
        // release. Checked before the pan so the two cannot both be live.
        //
        // A finger gets a much larger zone and, in exchange, no say yet. The
        // silent failure to avoid is a tap meant to tune landing on an edge,
        // tuning nothing and quietly resizing the filter instead — so touch
        // starts *pending*: it is a resize only once the finger has moved, and a
        // tap that never moves still tunes. See onPointerMove and onPointerUp.
        const touch = e.pointerType === 'touch';
        const edge = edgeAtX(e.clientX, touch);
        if (edge) {
            // No zone size is carried: the floor a drag clamps to is the same for
            // a finger and a pointer, because the width at which an edge can be
            // grabbed now is (see TOUCH_EDGE_MIN_PX).
            g.edge = { which: edge, pending: touch, startX: e.clientX };
            g.drag = null;
            return;
        }

        g.drag = {
            startX: e.clientX,
            startCenter: cfgRef.current.centerFreq,
            moved: false,
            pointerId: e.pointerId,
        };

        // A finger held still is a right-click, timed here rather than left to
        // the browser.
        //
        // Android's WebView answers a long press with a `contextmenu` event and
        // iOS's does not — WebKit has no such event on a touchscreen at all, and
        // answers the press with its own text callout instead. So the menu was
        // reachable on one phone and not the other, from the same gesture,
        // with nothing on screen to say why.
        //
        // Both paths go through openMenu and it answers once, so this changes
        // nothing where the event does arrive: whichever gets there first opens
        // the menu and the other finds it already open. The numbers are
        // Section.jsx's, which times the same gesture for panel dragging — one
        // hold ought to feel like another.
        if (e.pointerType !== 'mouse') {
            g.hold = {
                x: e.clientX,
                y: e.clientY,
                timer: setTimeout(() => {
                    const now = gfx.current;
                    now.hold = null;
                    // The drag and any pending edge grab are dropped, or the
                    // finger that opened the menu would also pan the view out
                    // from under it and tune on release.
                    now.drag = null;
                    now.edge = null;
                    openMenu(e.clientX, e.clientY);
                }, HOLD_MS),
            };
        }
    }, [freqAtX, edgeAtX, openMenu]);

    /// Nothing is being held any more — moved too far, lifted, or taken away.
    const dropHold = useCallback(() => {
        const g = gfx.current;
        if (!g.hold) return;
        clearTimeout(g.hold.timer);
        g.hold = null;
    }, []);

    const onPointerMove = useCallback((e) => {
        const el = wrapRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const g = gfx.current;

        if (g.pts.has(e.pointerId)) g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

        // Moved too far to be a hold. Generous rather than exact: a finger
        // resting on glass wanders a few pixels on its own, and a menu that
        // refused to open because of that would look like a menu that does not
        // work here either.
        if (g.hold && Math.hypot(e.clientX - g.hold.x, e.clientY - g.hold.y) > HOLD_SLOP) dropHold();

        // ---- pinch ------------------------------------------------------
        //
        // Zoom is a ladder the server snaps to, so a continuous gesture has to
        // be quantised onto it. How far the fingers have opened since they went
        // down gives the span the gesture is asking for; the difference between
        // that and the span actually on screen, in rungs, says whether to take a
        // step. Rounding puts the threshold at the geometric mean between rungs
        // — spreading to √2 of the starting separation zooms one step.
        //
        // Measuring against the live view rather than a running total is what
        // keeps this honest: a step only counts once the server has confirmed
        // it, so a request that is refused at the zoom floor, or one still in
        // flight, cannot leave the gesture believing it got somewhere it did
        // not. The throttle is there because pointermove fires far faster than
        // any of that settles.
        if (g.pinch) {
            const pair = pinchPair(g.pts);
            const dist = pair ? pinchDist(pair) : 0;
            const now = performance.now();
            const bwNow = cfgRef.current.binBandwidth;
            if (dist > 0 && g.pinch.bw > 0 && bwNow > 0 && now - g.pinch.last >= PINCH_MS) {
                const want = g.pinch.bw / ((dist / g.pinch.dist) ** PINCH_GAIN);
                const steps = Math.round(Math.log2(bwNow / want));
                if (steps !== 0) {
                    // All of them at once, not one per tick. `steps` is how far
                    // behind the fingers the view is, and taking a single rung
                    // from it meant a wide pinch needed a server round trip per
                    // rung to catch up — which is what made zooming feel stuck
                    // on a phone while the same code felt instant on a wheel.
                    // The anchor is fixed when the fingers go down; see
                    // onPointerDown.
                    actions.zoomSteps(steps, g.pinch.about);
                    // One pulse per rung actually asked for. The view is the
                    // only other feedback a pinch has, and it arrives a server
                    // round trip later — so on a slow link this is what tells
                    // the fingers the gesture is being heard at all.
                    haptic('step', 'spectrum');
                    g.pinch.last = now;
                }
            }
            // No hover readout and no pan for the rest of the gesture, up to and
            // including the finger still down after the first one lifts.
            return;
        }

        g.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
        g.dirty = true;

        const cfg = cfgRef.current;
        const f = freqAtX(e.clientX, e.clientY);
        if (f != null) {
            // v1's readout: what is under the cursor, and the strongest signal
            // in view (spectrum-display.js:3303). g.px is the per-pixel dB
            // column the trace is drawn from, so both come out of one array.
            const px = g.px;
            let db = null;
            let peakDb = null;
            let peakFreq = null;
            if (px && px.length) {
                const i = clamp(Math.round((e.clientX - r.left) * g.dpr), 0, px.length - 1);
                db = px[i];
                let best = 0;
                for (let k = 1; k < px.length; k++) if (px[k] > px[best]) best = k;
                peakDb = px[best];
                peakFreq = cfg.span
                    ? cfg.centerFreq - cfg.span / 2 + (best / px.length) * cfg.span
                    : null;
            }
            setHoverInfo({
                freq: f, db, peakDb, peakFreq,
                mark: markAtX(e.clientX),
                x: e.clientX - r.left,
                y: e.clientY - r.top,
            });
        }

        if (g.edge) {
            // Still undecided: a finger resting near an edge, which is a tap
            // until it travels far enough to be a drag.
            if (g.edge.pending) {
                if (Math.abs(e.clientX - g.edge.startX) < TOUCH_SLOP_PX) return;
                g.edge.pending = false;
                // The moment the finger stops being a tap and takes hold of the
                // filter. Worth saying out loud: the two gestures start
                // identically, and this is the only instant at which the
                // difference is decided.
                haptic('grab', 'spectrum');
            }
            const t = tuneRef.current;
            const raw = f == null ? null : f - t.frequency;
            if (raw != null) {
                // Snapped to the same grain the width slider moves in, so a
                // dragged filter reads as a round number rather than as
                // whatever pixel the pointer stopped on.
                const offset = Math.round(raw / FILTER_WIDTH_STEP) * FILTER_WIDTH_STEP;
                // Never narrower than the same gesture can comfortably pick up
                // again — comfortably being the operative word, and EDGE_FLOOR_PX
                // is where the margin is argued. Dragging an edge through the
                // other one would otherwise shut the filter to its 100 Hz floor,
                // which at any normal zoom is a fraction of a pixel: the two lines
                // sit on top of each other with nothing left to take hold of, and
                // the only way back out is the panel.
                const minHz = EDGE_FLOOR_PX * (cfg.span / r.width);
                const [low, high] = edgesForEdgeDrag(t.mode, g.edge.which, offset, t, minHz);
                if (low !== t.bandwidthLow || high !== t.bandwidthHigh) {
                    actions.setBandwidth(low, high);
                }
            }
            return;
        }

        // The affordance. Without it nothing says the lines can be grabbed.
        if (e.pointerType !== 'touch') {
            el.style.cursor = edgeAtX(e.clientX) ? 'col-resize' : '';
        }

        if (g.drag) {
            const dx = e.clientX - g.drag.startX;
            if (Math.abs(dx) > 3 && !g.drag.moved) {
                g.drag.moved = true;
                // Once, at the instant the press stops being a tap. Same
                // reasoning as the filter edge above: a tap tunes and a drag
                // pans, the two start identically, and this is the moment the
                // choice is made — after which the release will *not* tune, so
                // without it nothing says why.
                haptic('grab', 'spectrum');
            }
            if (g.drag.moved && cfg.span) {
                const hzPerPx = cfg.span / r.width;
                const want = g.drag.startCenter - dx * hzPerPx;
                const center = clamp(want, MIN_FREQ, MAX_FREQ);
                // Panning itself is silent — it is continuous, and a pulse per
                // move is a buzz. The end of the band is the one event in it:
                // fired once, when the view first stops following the finger,
                // and re-armed as soon as it is following again.
                if (center !== want) {
                    if (!g.drag.bumped) { g.drag.bumped = true; haptic('bump', 'spectrum'); }
                } else {
                    g.drag.bumped = false;
                }
                actions.setSpectrumCenter(center);
            }
        }
    }, [actions, freqAtX, edgeAtX, markAtX, dropHold]);

    // A release that means "tune here". Snapped to whatever the Receiver panel's
    // step is set to, so clicking the spectrum and pressing +/- agree about where
    // the channels are.
    const tuneAt = useCallback((clientX, clientY) => {
        const f = freqAtX(clientX, clientY);
        if (f == null) return;
        const step = dispRef.current.tuneStep || 1;
        actions.setFrequency(step > 1 ? Math.round(f / step) * step : f);
        // The receiver moved, and on a phone the finger is covering the place it
        // moved to. This is the confirmation.
        haptic('tune', 'spectrum');
    }, [actions, freqAtX]);

    const onPointerUp = useCallback((e) => {
        const g = gfx.current;
        g.pts.delete(e.pointerId);
        try { wrapRef.current.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        dropHold();

        // The press that opened the menu ends here and does nothing else. Without
        // this the finger lifting off would read as a tap and tune the receiver
        // to whatever is under the menu it just opened.
        if (g.held) {
            g.held = false;
            g.drag = null;
            g.edge = null;
            return;
        }

        // Lifting one finger of a pinch leaves the other one resting on the
        // spectrum. Stay out of the way until the hand is off entirely, or that
        // finger picks up a pan from wherever it happens to be.
        if (g.pinch) {
            if (g.pts.size === 0) g.pinch = null;
            return;
        }

        // An edge drag is finished, and never tunes: the pointer went down on
        // the filter, not on a frequency.
        //
        // Unless it never became a drag. A finger that landed in the touch grab
        // zone and lifted without moving was always a tap, and this is where
        // that is settled — which is what lets the zone be finger-sized without
        // taking taps away from tuning.
        if (g.edge) {
            const tapped = g.edge.pending;
            g.edge = null;
            if (tapped) tuneAt(e.clientX, e.clientY);
            return;
        }

        const drag = g.drag;
        g.drag = null;
        if (!drag) return;
        if (drag.moved) return;
        tuneAt(e.clientX, e.clientY);
    }, [tuneAt, dropHold]);

    // A gesture taken away from us — the browser claiming it, the window losing
    // the pointer — is abandoned, not completed. Sharing onPointerUp would tune
    // to wherever the finger happened to be when it was cancelled, which is not
    // something anybody asked for.
    const onPointerCancel = useCallback((e) => {
        const g = gfx.current;
        g.pts.delete(e.pointerId);
        try { wrapRef.current.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        dropHold();
        g.held = false;
        g.edge = null;
        g.drag = null;
        if (g.pts.size === 0) g.pinch = null;
    }, [dropHold]);

    // The readout has to follow the data, not the mouse: standing still over a
    // signal and watching it fade should change the numbers. Recomputed from
    // the last pointer position a few times a second — frame rate would be
    // pointless React churn for a two-line label.
    useEffect(() => {
        if (!hovering) return undefined;
        const id = setInterval(() => {
            const g = gfx.current;
            const cfg = cfgRef.current;
            if (!g.hover || !g.px || !g.px.length) return;
            const px = g.px;
            const i = clamp(Math.round(g.hover.x * g.dpr), 0, px.length - 1);
            let best = 0;
            for (let k = 1; k < px.length; k++) if (px[k] > px[best]) best = k;
            setHoverInfo((prev) => (prev ? {
                ...prev,
                db: px[i],
                peakDb: px[best],
                peakFreq: cfg.span
                    ? cfg.centerFreq - cfg.span / 2 + (best / px.length) * cfg.span
                    : null,
            } : prev));
        }, 150);
        return () => clearInterval(id);
    }, [hovering]);

    const onPointerLeave = useCallback(() => {
        gfx.current.hover = null;
        gfx.current.dirty = true;
        setHoverInfo(null);
    }, []);

    // Trackpads emit many small deltas per physical gesture, so accumulate to a
    // threshold — otherwise one flick would fire a dozen factor-of-two zooms.
    const wheelAcc = useRef(0);
    const onWheel = useCallback((e) => {
        e.preventDefault();
        const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        wheelAcc.current += step;
        if (Math.abs(wheelAcc.current) < 50) return;
        const dir = wheelAcc.current < 0 ? -1 : 1;
        wheelAcc.current = 0;

        // Shift: the filter width, which works at any zoom — including the
        // wide views where the passband is too narrow on screen to grab an edge
        // of. Up is wider, on the same "up is more" reading as the volume and
        // gain controls.
        if (e.shiftKey) {
            const t = tuneRef.current;
            const width = Math.abs(t.bandwidthHigh - t.bandwidthLow);
            const next = width + (dir < 0 ? FILTER_WIDTH_STEP : -FILTER_WIDTH_STEP);
            actions.setBandwidth(...edgesForWidth(t.mode, next, t));
            return;
        }

        // Wheel either zooms or tunes, per the Display panel. Tuning uses the
        // Receiver panel's step and its snapping, so it agrees with the +/-
        // buttons and with click-to-tune; scrolling up goes up in frequency,
        // matching the frequency dial's digits.
        if (dispRef.current.wheelAction === 'tune') {
            actions.stepBy(dispRef.current.tuneStep || 500, dir < 0 ? 1 : -1);
            return;
        }
        // Anchor per the Display panel: 'cursor' holds the frequency under the
        // pointer still, 'tuned' re-centres on the dial the way the toolbar's
        // +/- buttons do — which zoomCenter() takes as a null point.
        const f = anchorNow() === 'tuned' ? null : freqAtX(e.clientX, e.clientY);
        if (dir < 0) actions.zoomIn(f); else actions.zoomOut(f);
    }, [actions, freqAtX]);

    // React's onWheel is passive, so preventDefault there is a no-op — the
    // listener has to be registered explicitly as non-passive.
    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return undefined;
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [onWheel]);

    const span = view.span || 0;
    const anchorTuned = resolveZoomAnchor(display.zoomAnchor, mobile) === 'tuned';
    const wheelTunes = (display.wheelAction || 'zoom') === 'tune';

    return (
        <div className="spectrum">
            {!bare && (
                <div className="spectrum__toolbar">
                    <div className="spectrum__meta" ref={metaRef}>
                        {/* The span, the centre and the receiver's frequency accuracy are
                            all off on a phone, and the first to go on anything else — see
                            the keep order above. They are context rather than control:
                            the ruler under the spectrum says where the view is and how
                            wide it is, the accuracy is a standing fact about the receiver
                            rather than something that changes while you listen, and the
                            row they are in is the same one holding the squelch, the
                            filter and the DSP tags — which are state you are actually
                            working with. A phone drops them outright because the row
                            there has space for one kind of tag and these are the other
                            kind. */}
                        {/* Icons rather than words. Both of these are labels on a
                            number in a row that is otherwise all state, and the
                            words were the widest part of each: "centre" is five
                            characters spent saying what a crosshair says at a
                            glance — the same crosshair the toolbar's own
                            centre-on-tuned button carries, so it is a word this
                            interface has already taught. The span had no label at
                            all and now says what it is, which is the other half of
                            the trade: one tag lost a word, the other gained a
                            meaning. The tooltips carry the words for anyone who
                            wants them, and the aria-labels carry them always. */}
                        {!mobile && room.span && (
                            <span className="tag tag--accent tag--ico" data-optional="span" title="Span of the view">
                                <Icon.Span size={11} />
                                <span aria-label={`Span ${formatSpan(span)}`}>{formatSpan(span)}</span>
                            </span>
                        )}
                        {!mobile && room.centre && (
                            <span className="tag tag--ico" data-optional="centre" title="Centre frequency of the view">
                                <Icon.Target size={11} />
                                <span aria-label={`Centre ${formatFreqShort(view.centerFreq || 0)}`}>
                                    {formatFreqShort(view.centerFreq || 0)}
                                </span>
                            </span>
                        )}
                        {/* Next to the frequencies it qualifies, and before the audio
                            tags: this one is about what the numbers on screen mean,
                            not about what is being done to the sound. */}
                        {!mobile && room.offset && <FreqOffsetTag />}
                        <SquelchTag />
                        <NoiseReductionTag />
                        {/* Client stage after the server's, matching the audio
                            path: the receiver's insert ran first, these run on
                            what it sent. */}
                        <ClientNoiseTags />
                        <FilterTags />
                        <ControlTags />
                        <ClipTag />
                        {/* Shown on a handset as well as the desktop, unlike the
                            context tags: a phone is where the bandwidth this is
                            about is most likely to be somebody's own data. */}
                        {room.pcm && <AudioFormatTag />}
                        {/* Last in the row, and that is the whole point of where it is:
                            it comes and goes with every pointer movement, so anywhere
                            else it would shove the squelch, the filter and the DSP tags
                            sideways each time the pointer crossed the spectrum. At the
                            end it appends and nothing else moves.

                            Not on a handset. It is the least useful of these there by
                            some distance: with no pointer it only says where a finger
                            last touched, and the hover tip under the finger already says
                            that with the level beside it. */}
                        {!mobile && hoverInfo && room.cursor && (
                            <span className="tag tag--ghost" data-optional="cursor">{formatFreqExact(hoverInfo.freq)}</span>
                        )}
                    </div>
                    <div className="spectrum__tools">
                        {/* Zoom first, and first because it is the pair that
                            gets pressed: everything after it is a setting about
                            how zooming behaves, or a one-off. Putting the two
                            that are used constantly at the near end of the row
                            also keeps them from moving — the wheel and anchor
                            buttons come and go with the mobile breakpoint and
                            with the wheel's own mode, which shifted the zoom
                            pair sideways underneath a pointer that was already
                            aiming at it.

                            Not on a handset, where the row is the scarcest space
                            in the layout and these two are the only buttons in
                            it with a gesture that already does the same job:
                            pinch zooms, and it zooms better than the buttons do
                            — continuously, about the fingers, and without taking
                            a thumb to the top of the screen. Everything after
                            them has no gesture, so it stays. */}
                        {!mobile && <Button size="sm" variant="ghost" icon={<Icon.ZoomOut />} title="Zoom out around the tuned frequency" onClick={() => actions.zoomOut()} />}
                        {!mobile && <Button size="sm" variant="ghost" icon={<Icon.ZoomIn />} title="Zoom in on the tuned frequency" onClick={() => actions.zoomIn()} />}
                        {/* What the wheel does over the spectrum, mirroring the
                            Display panel's setting. Only where there is a wheel
                            to set — a control that cannot be used is worse than
                            an absent one, and the row has no space to spare.

                            Asked as "is a pointer driving this?" rather than by
                            screen width, which is what it used to be. A tablet
                            is wider than the mobile breakpoint and has no wheel,
                            so this button sat in the toolbar of every iPad
                            offering to change what an absent wheel did. The same
                            query keeps it for a tablet with a trackpad
                            attached, where a two-finger scroll *is* a wheel.

                            Highlighted when it tunes rather than carrying two
                            glyphs, because both states are the same wheel doing
                            something — and the anchor button beside it already
                            uses the two-icon form for a genuine either/or. */}
                        {hasWheel && (
                            <Button
                                size="sm"
                                variant="ghost"
                                active={wheelTunes}
                                icon={<Icon.Wheel />}
                                title={wheelTunes
                                    ? `Wheel tunes in ${stepLabel(display.tuneStep || 500)} steps — click to zoom instead`
                                    : 'Wheel zooms — click to tune with it instead'}
                                aria-label="What the scroll wheel does"
                                onClick={() => display.set({ wheelAction: wheelTunes ? 'zoom' : 'tune' })}
                            />
                        )}
                        {/* Only while there is a zoom for it to apply to. With a
                            wheel that is the wheel set to zoom; without one it is
                            always, because a pinch is a zoom and uses this same
                            setting — see the pinch handler, which reads the
                            anchor when it decides what the gesture turns about.
                            Left as `!wheelTunes` alone, a touch device that had
                            picked up "wheel tunes" from a desktop through the
                            shared settings lost the only control over its own
                            pinch.

                            Shows the anchor in force rather than the one it
                            would switch to, so the toolbar reads as state. */}
                        {(!wheelTunes || !hasWheel) && (
                            <Button
                                size="sm"
                                variant="ghost"
                                icon={anchorTuned ? <Icon.Knob /> : <Icon.Pointer />}
                                title={anchorTuned
                                    ? 'Zoom keeps the tuned frequency centred — click to zoom about the pointer'
                                    : 'Zoom holds the frequency under the pointer still — click to zoom about the tuned frequency'}
                                aria-label="Zoom anchor"
                                onClick={() => display.set({ zoomAnchor: anchorTuned ? 'cursor' : 'tuned' })}
                            />
                        )}
                        {/* What the centre area shows, and — where there is a
                            waterfall in it — how that waterfall is drawn. Both
                            mirror the Display panel, and both are here for the
                            reason the anchor button is: they are the settings
                            you change *while* looking at a signal, and going to
                            a panel to swap to the waterfall means looking away
                            from the thing that made you want to.

                            Cycles rather than a menu. Three states, all cheap to
                            pass through and all instantly legible when you land
                            on them, is the case a cycle is for — and it costs one
                            button of a row that is already full.

                            Down here rather than at the near end, and beside the
                            pan button, for the reason the zoom pair is first:
                            the style button comes and goes with the view mode,
                            and a control that appears and disappears must not sit
                            where it would push the constantly-pressed pair
                            sideways under a pointer already aiming at them.

                            The icon is the state it is in, not the one it would
                            move to, which is the rule the anchor and wheel
                            buttons follow: the toolbar reads as state, and the
                            tooltip says what pressing does. */}
                        <Button
                            size="sm"
                            variant="ghost"
                            icon={viewMode === 'spectrum' ? <Icon.ViewSpectrum />
                                : viewMode === 'waterfall' ? <Icon.ViewWaterfall />
                                    : <Icon.ViewSplit />}
                            title={VIEW_TITLE[viewMode] || VIEW_TITLE.split}
                            aria-label="What the display shows"
                            onClick={() => display.set({ viewMode: NEXT_VIEW[viewMode] || 'spectrum' })}
                        />
                        {/* Only where there is a waterfall to draw: in
                            spectrum-only view the surface has no pane, and a
                            button that could not change anything would be a
                            control promising something that is not there. The
                            depth in seconds stays in the Display panel — it is a
                            slider, and a thing you set once. */}
                        {viewMode !== 'spectrum' && (
                            <Button
                                size="sm"
                                variant="ghost"
                                active={wfMode !== '2d'}
                                icon={wfMode === '3d' ? <Icon.Wf3D />
                                    : wfMode === 'both' ? <Icon.WfBoth />
                                        : <Icon.Wf2D />}
                                title={WF_STYLE_TITLE[wfMode] || WF_STYLE_TITLE['2d']}
                                aria-label="How the waterfall is drawn"
                                onClick={() => display.set({ waterfallMode: NEXT_WF[wfMode] || '2d' })}
                            />
                        )}
                        {/* What the waterfall's history does when the view moves
                            under it, mirroring the Display panel's setting.

                            Here rather than only in the panel because it is a
                            thing you change *while* panning — you drag, you see
                            the trail step sideways, and the answer to that
                            should be one press away from the drag that raised
                            it. Highlighted when the history follows, so the
                            toolbar reads as state; the plain state is the one
                            this display has always had.

                            Only with a waterfall on screen: there is no history
                            to move in spectrum-only view. */}
                        {viewMode !== 'spectrum' && (
                            <Button
                                size="sm"
                                variant="ghost"
                                active={panFollows}
                                icon={<Icon.Anchor />}
                                title={panFollows
                                    ? 'Waterfall history is held to the frequency scale: it moves with the view and new ground comes in black — click to leave it where it was drawn'
                                    : 'Waterfall history stays where it was drawn, so after a pan it no longer lines up with the frequency scale — click to move it with the view'}
                                aria-label="Waterfall history when panning"
                                onClick={() => display.set({ waterfallPan: panFollows ? 'hold' : 'follow' })}
                            />
                        )}
                        {/* Auto or manual levelling, and the two limits when it is
                            manual. Here as well as in the Display panel because it is
                            the setting you reach for *while* looking at a signal: auto
                            follows the noise floor, which is right until a strong
                            carrier or a burst of QRM drags the whole picture with it,
                            and the answer to that is two thumbs and a glance rather
                            than opening a panel.

                            Highlighted while auto, so the toolbar reads as state.

                            Not on a handset, where the row is the scarcest space in
                            the layout and this is the least likely of its buttons to
                            be wanted mid-listen: automatic is right nearly always,
                            and the case for overriding it — a carrier dragging the
                            colours — is one somebody sits down to fix rather than
                            catches on a phone. The Display panel's "Auto level"
                            switch is the same setting, so nothing is lost with it;
                            the sliders below still appear there when it is off, so a
                            range set on a desktop can still be adjusted. */}
                        {!mobile && (
                            <Button
                                size="sm"
                                variant="ghost"
                                active={display.autoRange}
                                icon={<Icon.Gauge />}
                                title={display.autoRange
                                    ? 'Levels follow the noise floor — click to set them by hand'
                                    : `Levels set by hand, ${display.floorDb} to ${display.ceilDb} dB — click to follow the noise floor`}
                                aria-label="Level range"
                                onClick={() => display.set({ autoRange: !display.autoRange })}
                            />
                        )}
                        {/* On a phone too. This was desktop-only on the grounds that the
                            tools row is the scarcest space in the layout, and that was
                            true until the four readouts left the row beside it — but it
                            was the wrong call anyway: a toggle whose effect only appears
                            on some screens is a toggle that looks broken on the others,
                            and "set the levels by hand" with no way to set them is worse
                            than not offering it. It is narrower there; see the CSS. */}
                        {!display.autoRange && (
                            <span className={`spectrum__range${mobile ? ' is-narrow' : ''}`}>
                                {/* The floor and the ceiling on one track, because they
                                    are one setting: what dB range the colours cover.
                                    Ten decibels apart at the least — see RangeSlider's
                                    `gap` — since a range narrower than that is a
                                    two-colour display. */}
                                <RangeSlider
                                    low={display.floorDb}
                                    high={display.ceilDb}
                                    min={-160}
                                    max={0}
                                    step={1}
                                    gap={10}
                                    format={(v) => `${v} dB`}
                                    onChange={({ low, high }) => display.set({ floorDb: low, ceilDb: high })}
                                />
                                <span className="spectrum__range-read">
                                    {display.floorDb}/{display.ceilDb}
                                </span>
                            </span>
                        )}
                        <Button size="sm" variant="ghost" icon={<Icon.Target />} title="Centre on tuned frequency" onClick={actions.centerOnTuned} />
                        {/* Not on a handset, where this row is the scarcest space in
                            the layout and this is the one button in it that is not
                            the only way to its action: the zoom ladder in the
                            Multipad resets on its bottom rung — the same
                            resetSpectrum, chosen there so the private radiod channel
                            is handed back — and "Reset zoom" can be mapped to a pad.
                            Centre-on-tuned beside it has neither, so it stays. */}
                        {!mobile && (
                            <Button size="sm" variant="ghost" icon={<Icon.Reset />} title="Full span" onClick={actions.resetSpectrum} />
                        )}
                        {/* Pause by hand, next to the other things you do to the
                            whole display. Exactly what the idle pause does, so
                            the button reads as the switch for a thing the setting
                            can also do on its own — and shows as active while it
                            is off, because a display that is not live has to be
                            legible as such from the toolbar as well as from the
                            overlay over it. Nothing to close if the receiver is
                            not running.

                            Not on a handset. Pausing by hand is a desktop habit —
                            a phone's spectrum pauses itself when the screen goes
                            or the tab does (see IdleWatch and VisibilityWatch),
                            which is the whole reason somebody would press this —
                            and the row there is short enough that a button nobody
                            reaches for costs one somebody does. Getting back is
                            unaffected either way: the paused overlay carries its
                            own Resume. */}
                        {!mobile && (
                            <Button
                                size="sm"
                                variant="ghost"
                                active={paused}
                                disabled={!spectrumConn}
                                icon={paused ? <Icon.Play /> : <Icon.Pause />}
                                title={paused
                                    ? 'Resume the spectrum'
                                    : 'Pause the spectrum — closes the connection and stops the server producing for it, until you resume'}
                                onClick={togglePause}
                            />
                        )}
                    </div>
                </div>
            )}

            <MarkerBar width={sizes.w} />

            <div
                className="spectrum__canvas"
                ref={wrapRef}
                onContextMenu={onContextMenu}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onPointerLeave={onPointerLeave}
            >
                {/* Paused: the display is not live, and says so over the middle
                    of itself. Inside the canvas box on purpose — it dims the
                    spectrum and the waterfall and nothing else, so the toolbar
                    above it still works and no panel is covered by it, floating
                    or docked.

                    It takes the presses over that area rather than letting them
                    through. Clicking a waterfall to tune to a signal that was
                    there twenty minutes ago is the one thing a stale display must
                    not offer, and the gesture it would otherwise start belongs to
                    the wrapper this sits inside — hence the stopPropagation. */}
                {paused && (
                    <div
                        className="spectrum__paused"
                        onPointerDown={(e) => e.stopPropagation()}
                        onPointerUp={(e) => e.stopPropagation()}
                        onContextMenu={(e) => e.stopPropagation()}
                    >
                        <button
                            type="button"
                            className="spectrum__resume"
                            title="Reopen the spectrum socket and carry on where it left off"
                            onClick={togglePause}
                        >
                            <Icon.Play size={15} />
                            <span>Resume</span>
                        </button>
                        {/* Says what is stopped, and by implication what is not:
                            the audio, the decoders and the session all carry on,
                            and this is the one thing that has gone quiet. Neutral
                            about how it got here, because the toolbar's toggle and
                            the idle setting arrive at the same state. */}
                        <span className="spectrum__paused-note">
                            <Icon.Pause size={11} />
                            Spectrum paused — the audio carries on
                        </span>
                    </div>
                )}
                {/* The same corner in every view mode. What is at the bottom of
                    the box changes — the 14 px waterfall ruler in split and
                    waterfall views, the 26 px frequency scale in spectrum-only —
                    so the offset clears whichever one it is and the readout sits
                    in the same place on screen either way, rather than moving up
                    and down as the view is switched. */}
                {statsAt !== 'off' && (
                    <SpectrumStats
                        place={statsAt}
                        bottom={(wfScaleH || SCALE_H) + STATS_GAP}
                        gfx={gfx}
                        onClose={() => display.set({ spectrumStats: 'off' })}
                    />
                )}
                {hoverInfo && hoverInfo.db != null && (
                    <div
                        className="spec-tip"
                        style={{
                            // Sits right of the cursor, flipping left near the
                            // edge so it never leaves the canvas — as v1 does.
                            left: hoverInfo.x + (hoverInfo.x > sizes.w - 150 ? -14 : 14),
                            top: hoverInfo.y + 12,
                            transform: hoverInfo.x > sizes.w - 150 ? 'translateX(-100%)' : undefined,
                        }}
                    >
                        {hoverInfo.mark && (
                            <div className="spec-tip__mark">
                                {hoverInfo.mark === 'dial' ? 'Tuned' : 'Filter'}
                                {': '}
                                {formatFreqExact(tuning.frequency)}
                                {' '}
                                {(MODE_BY_ID[tuning.mode] || {}).label || tuning.mode}
                                {' · '}
                                {formatFilterWidth(tuning.bandwidthLow, tuning.bandwidthHigh)}
                            </div>
                        )}
                        <div>Cursor: {formatFreqExact(hoverInfo.freq)} | {hoverInfo.db.toFixed(1)} dB</div>
                        {hoverInfo.peakFreq != null && (
                            <div>Peak: {formatFreqExact(hoverInfo.peakFreq)} | {hoverInfo.peakDb.toFixed(1)} dB</div>
                        )}
                    </div>
                )}
                {specH > 0 && <canvas ref={specRef} className="spectrum__pane" />}
                {/* Doubles as the splitter between the two panes — see
                    onSplitDown. It sits exactly on the join, so grabbing it is
                    grabbing the edge. */}
                <canvas
                    ref={scaleRef}
                    className={'spectrum__pane spectrum__pane--scale'
                        + (viewMode === 'split' ? ' spectrum__pane--split' : '')
                        + (canSplitDrag ? ' spectrum__pane--grab' : '')}
                    title={viewMode === 'split'
                        ? (canSplitDrag
                            ? 'Drag up or down to share the height between the spectrum and the waterfall — double-click to reset'
                            : 'Double-click to reset the split — dragging is switched off in the Display panel')
                        : undefined}
                    onPointerDown={onSplitDown}
                    onPointerMove={onSplitMove}
                    onPointerUp={onSplitUp}
                    onPointerCancel={onSplitUp}
                    onDoubleClick={onSplitDouble}
                />
                {/* The waterfall canvas overhangs this box and the box clips it,
                    which is what gives the scroll a row to slide in. The marks
                    sit above, still, on a canvas that is not translated. */}
                {wfH > 0 && (
                    <div className="spectrum__wf" style={{ height: wfH }}>
                        {/* Above the heat map, so the two newest rows meet at the
                            seam — see the note where dssH is worked out. Its own
                            canvas, so nothing about the 2D path changes. */}
                        {dssH > 0 && (
                            <canvas
                                ref={dssRef}
                                className="spectrum__wf-dss"
                                style={{ height: dssH }}
                            />
                        )}
                        {/* The seam ruler, and the only place a frequency can be
                            read against both pictures at once. */}
                        {midH > 0 && (
                            <canvas
                                ref={midScaleRef}
                                className="spectrum__wf-mid"
                                style={{ top: dssH }}
                            />
                        )}
                        {/* The heat map gets its own clipping box.
                            The canvas is RING_PAD taller than its slot and the
                            smooth scroll translates it up by a row, so without a
                            clip of its own that overhang slides over whatever is
                            above it. With the waterfall filling this container
                            that was the container's own edge and nothing showed;
                            with a ruler at the seam it was the ruler, flickering
                            once per row. The marks ride inside it so they cannot
                            drift from the picture they mark. */}
                        {heatH > 0 && (
                            <div
                                className="spectrum__wf-heat"
                                style={{ top: dssH + midH, height: heatH }}
                            >
                                <canvas ref={wfRef} className="spectrum__wf-pane" />
                                <canvas ref={wfMarksRef} className="spectrum__wf-marks" />
                            </div>
                        )}
                    </div>
                )}
                {/* Notches under the waterfall, on the same frequencies as the
                    scale above it. Not a splitter and not a drag target — just
                    somewhere to read a signal's frequency without looking away
                    from the waterfall it is in. */}
                {wfScaleH > 0 && (
                    <canvas ref={wfScaleRef} className="spectrum__pane spectrum__pane--wfscale" />
                )}
            </div>

            {menu && (
                <SpectrumMenu
                    at={menu}
                    onClose={() => setMenu(null)}
                    items={[
                        {
                            key: 'bookmark',
                            // The dial, not the click: a bookmark is somewhere
                            // you are listening, with the mode and passband you
                            // settled on. `menu.freq` is kept for entries that
                            // are about the spot under the pointer.
                            label: `Add local bookmark — ${formatFreqShort(tuning.frequency, span)}`,
                            title: 'Save what the receiver is tuned to, in this browser',
                            onSelect: () => setAdding({
                                frequency: tuning.frequency,
                                mode: tuning.mode,
                                bandwidthLow: tuning.bandwidthLow,
                                bandwidthHigh: tuning.bandwidthHigh,
                            }),
                        },
                        // Only where it can actually be used. dxCanSpot is
                        // connected *and* authenticated for spot submission —
                        // the cluster says so in its banner when the login line
                        // carried the right password. Hidden rather than
                        // disabled: on a receiver whose operator has not enabled
                        // spotting at all this could never be pressed, and a
                        // permanently dead entry is worse than no entry. Read
                        // during render like getVfos below, which is fine for a
                        // menu built at the moment it opens.
                        ...(dxCanSpot() ? [{ key: 'sep-dx', separator: true }, {
                            key: 'dx-spot',
                            // The dial, not the click, for the same reason the
                            // bookmark above uses it: you spot what you have
                            // tuned and listened to, not a peak you happened to
                            // right-click near.
                            label: `Spot on DX cluster — ${formatFreqShort(tuning.frequency, span)}`,
                            title: 'Submit this frequency to the cluster as a spot',
                            onSelect: () => setSpotting(tuning.frequency),
                        }] : []),
                        { key: 'sep-vfo', separator: true },
                        // Copy the receiver as it stands into a VFO without
                        // going there — the Receiver panel's buttons only ever
                        // write the one you are leaving.
                        ...VFO_IDS.map((id) => {
                            const vfos = getVfos();
                            const held = vfos.slots[id];
                            const inUse = vfos.active === id;
                            return {
                                key: `vfo-${id}`,
                                label: `Store to VFO ${id}`,
                                disabled: inUse,
                                title: inUse
                                    ? `VFO ${id} is in use — it already holds these settings`
                                    : held
                                        ? `Replaces ${formatFreqShort(held.frequency)} ${held.mode.toUpperCase()}`
                                        : `VFO ${id} is unused`,
                                onSelect: () => setVfos(
                                    storeInto(getVfos(), id, vfoSnapshot(tuning, view)),
                                ),
                            };
                        }),
                        // What the display shows, and how it draws it — the two
                        // toolbar buttons above the spectrum, as named choices.
                        //
                        // Named rather than cycled, which is the difference
                        // between a menu and a button: a button that cycles is
                        // fine when it shows its own state and is one press
                        // from anywhere, and a menu entry called "next view"
                        // would be asking somebody to press it repeatedly with
                        // the menu shutting each time. The current one is
                        // disabled and says so, as the top bar's mode picker
                        // does.
                        { key: 'sep-view', separator: true },
                        ...VIEW_CHOICES.map((choice) => ({
                            key: `view-${choice.id}`,
                            label: choice.label,
                            disabled: viewMode === choice.id,
                            title: viewMode === choice.id ? 'What the display is showing now' : undefined,
                            onSelect: () => display.set({ viewMode: choice.id }),
                        })),
                        // How the waterfall is drawn, and only where there is
                        // one: in spectrum-only view these three would set a
                        // setting nothing on screen could show, and the toolbar
                        // hides its own button for the same reason. Choosing a
                        // *view* with a waterfall in it brings them back, which
                        // is the dependency the right way round — the view
                        // decides whether the style is a question at all.
                        ...(viewMode === 'spectrum' ? [] : [
                            { key: 'sep-wf', separator: true },
                            ...WF_CHOICES.map((choice) => ({
                                key: `wf-${choice.id}`,
                                label: choice.label,
                                disabled: wfMode === choice.id,
                                title: wfMode === choice.id ? 'How the waterfall is drawn now' : undefined,
                                onSelect: () => display.set({ waterfallMode: choice.id }),
                            })),
                        ]),
                        // What a zoom holds still, on the same terms as the
                        // toolbar's anchor button: offered only where there is a
                        // zoom for it to apply to, which is a wheel set to zoom
                        // or a device that pinches instead.
                        //
                        // The second entry is named after the thing that will
                        // actually be held — a pointer on a desktop, the fingers
                        // on a tablet. The setting is one setting; what it is
                        // called should still be true on the device reading it.
                        ...(!wheelTunes || !hasWheel ? [
                            { key: 'sep-anchor', separator: true },
                            {
                                key: 'anchor-tuned',
                                label: 'Zoom about the tuned frequency',
                                disabled: anchorTuned,
                                title: anchorTuned ? 'What zooming holds still now' : undefined,
                                onSelect: () => display.set({ zoomAnchor: 'tuned' }),
                            },
                            {
                                key: 'anchor-cursor',
                                label: hasWheel ? 'Zoom about the pointer' : 'Zoom about the pinch',
                                disabled: !anchorTuned,
                                title: !anchorTuned ? 'What zooming holds still now' : undefined,
                                onSelect: () => display.set({ zoomAnchor: 'cursor' }),
                            },
                        ] : []),
                    ]}
                />
            )}

            {spotting != null && (
                <SpotOnCluster
                    frequency={spotting}
                    onClose={() => setSpotting(null)}
                />
            )}

            {adding && (
                <AddBookmark
                    frequency={adding.frequency}
                    mode={adding.mode}
                    bandwidthLow={adding.bandwidthLow}
                    bandwidthHigh={adding.bandwidthHigh}
                    onClose={() => setAdding(null)}
                />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

// The theme variables this view reads. Resolved through themeColors(), which
// caches them per theme — getComputedStyle forces a style recalculation, so
// calling it inside the draw loop would cost more than the rendering itself.
const THEME_VARS = [
    '--spec-bg', '--spec-grid', '--spec-band',
    '--scale-bg', '--scale-text', '--scale-tick', '--accent',
    // The ink for anything drawn *over* the canvas. Light in both themes, and
    // following a chosen text colour where that stays legible on a waterfall —
    // see specInk in lib/uiColors.js.
    '--spec-ink', '--station-ink',
];
const colors = () => themeColors(THEME_VARS);

// Minimum dynamic range, v1's `autoMinSpan` (spectrum-display.js updateAutoRange).
//
// On a quiet band auto-levelling compresses the window until noise wobble fills
// the whole height and every ripple looks like a signal. This guarantees at
// least `minSpan` dB are shown, expanding 75% upward (headroom for signals) and
// 25% downward, and only re-commits when the new edges move more than 3 dB —
// without that dead-band the grid ticks jitter as the smoothed values drift.
//
// It reads g.autoFloor/g.autoCeil and writes only g.clampedFloor/g.clampedCeil.
// Keeping those two pairs apart is what stops the dead band from latching the
// auto-range; see the note at the end of this function.
const CLAMP_HYSTERESIS = 3;

function applyMinSpan(g, minSpan) {
    // Both, always, whenever the clamp is not in force. Nulling only the floor
    // was survivable while the caller read autoFloor/autoCeil — the write-back
    // kept those in step — but the draw site reads the clamped pair directly
    // now, and a clampedCeil left behind became the displayed ceiling for good.
    // Committed on a quiet band at, say, -90, it stayed there while the eased
    // ceiling rose to meet a -70 signal, and the signal was drawn clipped flat
    // against a scale that had stopped moving hours ago.
    if (!(minSpan > 0) || g.autoCeil - g.autoFloor >= minSpan) {
        g.clampedFloor = null;
        g.clampedCeil = null;
        return;
    }
    const range = g.autoCeil - g.autoFloor;
    const deficit = minSpan - range;
    const ceil = Math.round(g.autoCeil + deficit * 0.75);
    const floor = Math.round(g.autoFloor - deficit * 0.25);
    if (g.clampedFloor == null
        || Math.abs(floor - g.clampedFloor) > CLAMP_HYSTERESIS
        || Math.abs(ceil - g.clampedCeil) > CLAMP_HYSTERESIS) {
        g.clampedFloor = floor;
        g.clampedCeil = ceil;
    }
    // The clamped pair is what gets drawn, and deliberately nothing more. It
    // used to be written back into autoFloor/autoCeil, which is where the whole
    // thing came unstuck: those two are the values autoRange eases towards the
    // signal, and feeding the clamp back into them closed a loop with the dead
    // band above.
    //
    // Each frame eases 8% of the way to the target and the dead band ignores a
    // move under 3 dB, so once the remaining error fell below 3/0.08 — about 37
    // dB — a frame's easing could no longer clear the band, the write-back put
    // the levels back where they were, and the auto-range stopped dead that far
    // from the truth. Come to a quiet band from a loud one and the noise floor
    // sat tens of dB below the bottom of the display, invisible, for as long as
    // you cared to wait. Zooming out only fixed it because the jump in the data
    // was large enough to clear the band again — and it would re-latch.
}

// How far the auto-levels move towards their target in one 20 Hz frame. Slow,
// because the floor and ceiling set the whole picture's contrast and a level
// that chased each frame would make the noise shimmer.
const AUTO_RANGE_K = 0.08;

// `px` is the live pixel row, which the waterfall draws and which the
// percentiles below are taken from. `trace` is what the *spectrum* draws — the
// same array when smoothing is off, and the smoothed one when it is not.
//
// Both have to be covered, and passing only `px` was the whole of the bug this
// signature exists to prevent. Smoothing is an exponential average, so it lags
// in both directions: while a signal decays the smoothed trace sits *above* the
// live pixels. Measuring the ceiling from `px` alone therefore let it fall away
// under a trace that was still up there, and the spectrum drew clipped flat
// against the top for as long as the tail lasted — every syllable, with the
// default smoothing of 0.5.
function autoRange(px, trace, g, k) {
    // Robust floor: a low percentile is immune to the strong carriers that
    // would drag a plain minimum or mean around.
    const n = px.length;
    if (!n) return;
    const sample = [];
    const stride = Math.max(1, Math.floor(n / 512));
    for (let i = 0; i < n; i += stride) sample.push(px[i]);
    sample.sort((a, b) => a - b);
    // The tallest pixel anything will draw, over every one of them rather than
    // the strided sample, and over both rows rather than just the live one.
    // This is the only thing that guarantees a signal is drawn inside the scale
    // rather than flat against the top of it.
    let peak = -Infinity;
    for (let i = 0; i < n; i++) if (px[i] > peak) peak = px[i];
    if (trace !== px && trace && trace.length === n) {
        for (let i = 0; i < n; i++) if (trace[i] > peak) peak = trace[i];
    }
    const floor = sample[Math.floor(sample.length * 0.25)];
    const ceil = sample[Math.floor(sample.length * 0.995)];
    const targetFloor = floor - 4;
    // Three terms, each covering a case the others get wrong:
    //
    //   floor + 25   a dead band has no signal to scale to, and without a
    //                minimum the noise wobble fills the height.
    //   p995 + 12    generous headroom over the general signal level on a busy
    //                band, and immune to one hot pixel.
    //   peak + 3     the guarantee. The percentile is taken from ~512 strided
    //                samples of a canvas two thousand pixels wide, so a carrier
    //                two or three pixels across contributes at most one sample
    //                and cannot move a 99.5th percentile that needs about three
    //                — it reads the noise instead, the ceiling drops to
    //                floor + 25, and a signal 20 dB above it is drawn clipped
    //                to the top of the scale with its peak cut off. One extra
    //                linear pass is what that costs.
    //
    // A single spurious pixel setting the ceiling is damped by the easing
    // below: one frame moves it 8% of the way, and it decays back when the
    // spike is gone.
    const targetCeil = Math.max(targetFloor + 25, ceil + 12, peak + 3);
    // Ease towards the target so the display does not flicker frame to frame.
    g.autoFloor += (targetFloor - g.autoFloor) * k;
    g.autoCeil += (targetCeil - g.autoCeil) * k;

    // The ceiling rises at once and only falls slowly.
    //
    // Easing both ways cannot work at the top, because the easing is a 0.6 s
    // time constant and signals are not continuous. Speech, CW, a beacon: the
    // peak appears for a couple of hundred milliseconds — a fraction of the way
    // into the climb — and is gone before the ceiling arrives, whereupon the
    // ceiling starts back down. It settles somewhere between the noise and the
    // signal and every burst is drawn clipped flat against the top of the
    // scale. Making the target track the peak is not enough on its own; the
    // approach has to be instant.
    //
    // So the peak is a hard floor under the ceiling rather than something to
    // ease towards, which is the attack-and-decay a level meter uses and for
    // the same reason. A spurious pixel now moves it at once, but only by as
    // much as that pixel, and the eased decay takes it back.
    const hardCeil = peak + 3;
    if (g.autoCeil < hardCeil) g.autoCeil = hardCeil;
}

function drawFrame(g, d, ctx) {
    const {
        spec, wf, wfMarks, scale, wfScale, cfg, tuning, width, specH, wfH, commitRow, dt,
        dss, dssH, heatH, drawAt, midScale, midH,
    } = ctx;
    // Either pane may be absent — the view mode can hide one of them entirely.
    if (!width) return;

    const dpr = g.dpr;
    const pxW = Math.max(1, Math.round(width * dpr));

    if (!g.px || g.px.length !== pxW) {
        g.px = new Float32Array(pxW);
        g.peak = new Float32Array(pxW).fill(-200);
        g.smoothed = null;
    }
    binsToPixels(g.bins, pxW, g.px);

    // Optional temporal smoothing of the trace.
    //
    // The retention is per unit *time*, not per frame: the receiver sends about
    // half as many frames a second on a wide span as on a narrow one, and a
    // per-frame factor would make the same slider setting lag several times
    // longer purely because you had zoomed out. See lib/timeConstant.js.
    let trace = g.px;
    if (d.smoothing > 0) {
        if (!g.smoothed || g.smoothed.length !== pxW) g.smoothed = Float32Array.from(g.px);
        const a = retentionFor(d.smoothing, dt);
        for (let i = 0; i < pxW; i++) g.smoothed[i] = g.smoothed[i] * a + g.px[i] * (1 - a);
        trace = g.smoothed;
    }

    if (d.autoRange) {
        // Same reasoning: the levels have to settle in the same number of
        // seconds however often the frames arrive.
        // After the smoothing above, so `trace` is the row that will actually
        // be drawn — see autoRange.
        autoRange(g.px, trace, g, approachFor(AUTO_RANGE_K, dt));
        // null means "follow the operator's default"; 0 means no minimum.
        applyMinSpan(g, d.autoMinSpan != null ? d.autoMinSpan : d.server.autoMinSpan);
    }
    // The clamped pair when a minimum span is in force, the eased pair
    // otherwise — applyMinSpan sets clampedFloor to null when it has nothing to
    // add, which is also what it does when the minimum is switched off.
    const floor = d.autoRange ? (g.clampedFloor != null ? g.clampedFloor : g.autoFloor) : d.floorDb;
    const ceil = d.autoRange ? (g.clampedCeil != null ? g.clampedCeil : g.autoCeil) : d.ceilDb;
    const range = Math.max(1, ceil - floor);

    const { dial: colVfoLine, edge: colEdge } = markColors(d);

    drawWaterfall(g, d, wf, wfMarks, heatH != null ? heatH : wfH, pxW, floor, range,
        commitRow, cfg, tuning, colVfoLine, colEdge);
    drawDss(g, d, dss, dssH, pxW, floor, range, commitRow, drawAt, cfg, tuning);
    drawSpectrum(g, d, spec, specH, pxW, trace, floor, range, cfg, tuning, width, colVfoLine, colEdge);
    drawScale(g, d, scale, pxW, cfg, tuning, width, colVfoLine, colEdge);
    drawWaterfallScale(g, wfScale, pxW, cfg, tuning, width, colVfoLine);
    // The seam ruler carries a pip into each picture: the surface's newest row is
    // just above it and the heat map's is just below, and they are the same
    // instant. See drawWaterfallScale's `both`.
    drawWaterfallScale(g, midScale, pxW, cfg, tuning, width, colVfoLine, midH, true);
}


// A vertical marker, outlined.
//
// The outline is the whole trick. Over the spectrum there is a dark background
// to sit on and a thin coloured line is enough; over the waterfall there is no
// background at all — the palette runs from near-black to near-white and the
// line crosses every value of it on the way down, so any single colour is
// invisible somewhere. Stroking the same path twice, dark and wide underneath,
// gives every mark its own contrast to stand against wherever it lands. It is
// what a map label does over aerial photography, for the same reason.
const MARK_HALO = 'rgba(0, 0, 0, 0.72)';

// A CSS pixel of dark either side, so the outline is the same thickness to the
// eye on a phone as on a desk monitor. A flat number of device pixels here would
// be a third of that on a 3× screen — which is exactly the class of display the
// marks were hardest to see on.
const MARK_HALO_PX = 1;

// How much clear space a passband edge needs from the dial before it is worth
// drawing, in CSS px between the two centres.
//
// The dial is 1.6 px of colour plus a halo either side, an edge 1.4 plus the
// same: nearly 4 px of ink each. Zoomed out, the passband is a fraction of a
// pixel wide — an SSB filter is 3 kHz and a 30 MHz view is ~30 kHz per pixel —
// so both edges land on the dial and the three marks smear into one fat,
// lopsided smudge with the dashes of each beating against the others. Worse,
// the smudge is not centred on the dial, so the line you tune by stops looking
// like it is where it is.
//
// 5 px is the point either side of which the answer is unambiguous: below it
// the halos are touching, above it there is background visible between them and
// three separate marks is what you see. Nothing is lost by dropping an edge
// there, because at that width it was never telling you anything you could read
// off it — the passband shading is still drawn, and is what shows the filter at
// wide spans.
const MARK_MIN_GAP_PX = 5;

// Dash patterns, [ink, gap] in CSS px.
//
// The two marks are told apart by their rhythm before anything else. The dial
// is nearly solid, two parts ink to one of gap; an edge has the same length of
// dash with twice the gap, so it reads as intermittent where the dial reads as
// continuous. They were 4-on/4-off against 6-on/3-off, which is a real
// difference on paper and not one you see at a glance on a moving waterfall —
// both were simply "a dashed line", and the passband edges were mistakable for
// the line you tune by.
//
// Doubling the gap rather than shortening the dash on purpose: the dash length
// is what carries the mark's weight against a busy waterfall, and these marks
// stopped relying on alpha for their difference precisely because faded edges
// vanished there.
const DIAL_DASH = [6, 3];
const EDGE_DASH = [4, 8];

// `width` and the dash are in CSS px; everything below works in device px.
function markLine(c, x, H, dpr, colour, dash, width) {
    const xr = Math.round(x) + 0.5;
    c.beginPath();
    c.moveTo(xr, 0);
    c.lineTo(xr, H);
    c.setLineDash([dash[0] * dpr, dash[1] * dpr]);
    c.lineCap = 'butt';
    c.lineWidth = (width + 2 * MARK_HALO_PX) * dpr;
    c.strokeStyle = MARK_HALO;
    c.stroke();
    c.lineWidth = width * dpr;
    c.strokeStyle = colour;
    c.stroke();
    c.setLineDash([]);
}

// The tuned frequency and the edges of what is being demodulated, drawn on
// both panes so the waterfall shows what you are listening to rather than
// leaving you to line it up against the spectrum above.
//
// The dial stays the loud one and the edges stay quieter — they are context,
// not the thing you are aiming with — but the difference is carried by the dash
// and the weight rather than by fading the edges out. They were drawn at 0.38
// alpha with a 2-on/4-off dash, so a third of a faint line: legible on the
// spectrum's flat background and effectively gone over a busy waterfall, which
// is where they matter most, since the waterfall is what you read a signal's
// width off.
//
// The dashes are DIAL_DASH and EDGE_DASH above, and the gap between them is
// what says which line is which.
// How strong the hover passband is against the tuned one, which is the same colour at
// full strength. Half: it has to read as the same thing — this is the filter you
// already have — while never being mistaken for where the receiver actually is.
const HOVER_BAND_ALPHA = 0.5;

/**
 * The passband the current filter would give you, at the pointer.
 *
 * The point of it is that a filter is a width rather than a frequency: the hover line
 * says which frequency clicking would tune, and this says what you would then be
 * listening to — which is the question you are actually asking while looking for the
 * edge of a crowded signal.
 *
 * The tuned offsets, moved, and not a symmetrical band of the same total width: an SSB
 * filter is lopsided about the dial (+50 to +2900 on USB), so a band centred on the
 * cursor would be a lie about where the audio would come from. Same shape, new place.
 *
 * `hoverPx` is in device pixels, like everything else drawn here. Both panes call this,
 * because they share one frequency axis and shading one of them only would leave you
 * eyeballing the other.
 *
 * Not while a gesture is running, though — see the call sites. Dragging a passband edge
 * *is* setting the filter, and a ghost of the same filter trailing the pointer while you
 * do it is two answers to one question; a pan does not change the frequency under the
 * pointer at all, so there would be nothing to say.
 */
const hoverBandPx = (g, dpr) => (g.hover && !g.drag && !g.edge ? g.hover.x * dpr : null);

// Peak markers: a caret above each of the strongest signals, and its frequency.
//
// Deliberately drawn *at the signal* rather than as ticks along the top edge. A column
// marker says "something is at this frequency", which the trace under it already said;
// a caret sitting on the peak says "this one, this tall", and the eye follows it down
// to the shape it belongs to. It is also how every bench analyser does it, so it needs
// no explaining.
const PEAK_CARET_PX = 5;        // half-width of the caret; its height is the same
const PEAK_LABEL_GAP_PX = 4;    // caret tip to text
const PEAK_TOP_PAD_PX = 11;     // never above this, so a strong signal keeps its label

/**
 * The averaged trace, updated every frame, and the peaks re-found four times a second.
 *
 * Two different rates on purpose. The average has to see every frame or it is not an
 * average of anything — it is one multiply-add per pixel, which is nothing next to the
 * drawing. Finding peaks is a sort and a walk, and doing it per frame would buy nothing:
 * what the markers point at changes on the timescale of the averaging, not the frame.
 *
 * Both live on the gfx ref rather than in state. The ranking of two similar signals
 * changes several times a second even after averaging, and a React render per change
 * would be expensive *and* unreadable.
 *
 * A moved view resets the average outright. Levels measured against the old span belong
 * to other frequencies, and sweeping from them to the new ones would drag every marker
 * across the screen for a second after each zoom.
 */
function refreshPeaks(g, trace, count, snr, cfg, pxW, now) {
    const key = `${cfg.centerFreq}|${cfg.span}|${pxW}|${count}|${snr}`;
    if (g.peaksKey !== key || !g.peakAvg || g.peakAvg.length !== pxW) {
        g.peaksKey = key;
        g.peakAvg = new Float32Array(pxW);
        g.peakAvgAt = 0;
        g.peaks = [];
        g.peaksAt = 0;
    }
    averageTrace(g.peakAvg, trace, now - g.peakAvgAt, PEAK_TAU_MS, !g.peakAvgAt);
    g.peakAvgAt = now;

    if (now - g.peaksAt >= PEAK_REFRESH_MS) {
        g.peaksAt = now;
        // The previous answer goes in, for the membership hysteresis: without it two
        // signals a decibel apart hand the last marker back and forth.
        g.peaks = findPeaks(g.peakAvg, {
            count, minAbove: snr, gap: PEAK_GAP_PX * g.dpr, prev: g.peaks,
        });
    }
    return g.peaks;
}

// The hairline from a fixed mark down to the signal it belongs to. Faint: it is a
// pointer, not a reading, and a dozen full-strength verticals over a trace would look
// like a comb of signals that are not there.
const PEAK_DROP_ALPHA = 0.3;

// The backing behind each label.
//
// A shadow was not enough, and could not be: the spectrum pane can have an operator's
// photograph behind it, the palette runs from near-black to bright yellow, and a strong
// signal is a wall of colour going through exactly where the text is. One ink cannot be
// legible on all of that, and a shadow only helps where the background is light *and*
// busy — over a bright backdrop it is a smudge.
//
// So each label carries its own background: the spectrum's own colour, at enough alpha
// to knock back whatever is under it while the trace still shows faintly through. It is
// the same answer a bench analyser gives its marker readouts, and unlike a full-width
// gutter along the top it covers only where there is text — which matters, because the
// top of the pane is exactly where the strongest signals are.
const PEAK_PLATE_ALPHA = 0.78;
const PEAK_PLATE_PAD_X = 3;
const PEAK_PLATE_PAD_Y = 2;

// A rounded rectangle by hand. ctx.roundRect is recent enough that the marker bar and
// the countries map both carry their own, and a canvas in the hot path is no place to
// find out which browsers have it.
function plate(c, x, y, w, h, r) {
    const rad = Math.min(r, h / 2, w / 2);
    c.beginPath();
    c.moveTo(x + rad, y);
    c.arcTo(x + w, y, x + w, y + h, rad);
    c.arcTo(x + w, y + h, x, y + h, rad);
    c.arcTo(x, y + h, x, y, rad);
    c.arcTo(x, y, x + w, y, rad);
    c.closePath();
}

function drawPeakMarks(c, g, peaks, pxW, H, dpr, cfg, yOf, colInk, colBg, place) {
    if (!peaks.length || !cfg.span) return;
    const hz0 = cfg.centerFreq - cfg.span / 2;

    c.save();
    c.font = `${10 * dpr}px ui-monospace, monospace`;
    c.textBaseline = 'bottom';
    c.textAlign = 'left';

    // Measured before anything is drawn, because which labels fit is decided for the
    // whole set at once — see layoutPeakLabels.
    const texts = peaks.map((p) => {
        const hz = hz0 + (p.x / pxW) * cfg.span;
        // The level as an SNR rather than as an absolute figure: it is the same
        // quantity the threshold is set in, and "18 dB out of the noise" says whether a
        // signal is worth tuning to in a way that a raw dBFS number does not. The sign
        // is what distinguishes it from the axis labels down the left.
        //
        // One space between them, not two: the unit already separates the two figures,
        // and in a monospace face a double space is a gap wide enough to read as two
        // labels that happen to be next to each other.
        return `${formatFreqShort(hz, cfg.span)} +${Math.round(p.snr)}`;
    });
    // The receiver-info block counts as occupied space, so a label that would land
    // under it is dropped exactly as one colliding with another label is — its mark and
    // its hairline stay. Two texts on top of each other are both unreadable, and this
    // one is somebody's callsign.
    //
    // Only in the fixed row, where the labels are at the block's own height. On the
    // signal they are wherever their peaks are, and a peak that tall in that corner is
    // rare enough not to be worth refusing a label for.
    const blocked = [];
    if (place !== 'signal' && g.stationBox) blocked.push([g.stationBox.x0, g.stationBox.x1]);
    const placed = layoutPeakLabels(
        peaks,
        texts.map((t) => c.measureText(t).width),
        pxW,
        { pad: PEAK_LABEL_GAP_PX * dpr, blocked },
    );

    const caret = PEAK_CARET_PX * dpr;
    // In the fixed style every mark is at the same height, worked out once: the label
    // row sits under the top edge and the carets hang below it, pointing down.
    const rowLabelY = PEAK_TOP_PAD_PX * dpr;
    const rowTip = rowLabelY + (PEAK_LABEL_GAP_PX * dpr) + caret;

    for (let i = 0; i < placed.length; i++) {
        const p = placed[i];
        const x = p.x;
        // On the signal, the caret's tip goes just clear of the trace — positioned by
        // the *averaged* level, which is what was actually measured: the live trace
        // flickers a decibel either side of it, so a caret pinned to the live sample
        // would twitch while the thing it points at does not.
        const onSignal = Math.max(caret + 1, yOf(p.db) - 2 * dpr);
        const tip = place === 'signal' ? onSignal : rowTip;

        // Fixed marks are joined to their signal, or a row of frequencies along the top
        // is a row of frequencies belonging to nothing in particular.
        if (place !== 'signal' && onSignal > tip + caret) {
            c.save();
            c.globalAlpha = PEAK_DROP_ALPHA;
            c.strokeStyle = colInk;
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(Math.round(x) + 0.5, tip + 1);
            c.lineTo(Math.round(x) + 0.5, onSignal);
            c.stroke();
            c.restore();
        }

        c.fillStyle = colInk;
        c.beginPath();
        c.moveTo(x, tip);
        c.lineTo(x - caret, tip - caret);
        c.lineTo(x + caret, tip - caret);
        c.closePath();
        c.fill();

        if (!p.label) continue;
        // Above the caret, or pinned under the top edge for a signal that reaches it:
        // a label drawn off the top of the canvas is a label nobody reads.
        const y = place === 'signal'
            ? Math.max(PEAK_TOP_PAD_PX * dpr, tip - caret - PEAK_LABEL_GAP_PX * dpr)
            : rowLabelY;
        const padX = PEAK_PLATE_PAD_X * dpr;
        const padY = PEAK_PLATE_PAD_Y * dpr;
        const textH = 10 * dpr;
        c.globalAlpha = PEAK_PLATE_ALPHA;
        c.fillStyle = colBg;
        plate(c, p.left - padX, y - textH - padY, p.width + padX * 2, textH + padY * 2, 3 * dpr);
        c.fill();
        c.globalAlpha = 1;
        c.fillStyle = colInk;
        c.fillText(texts[i], p.left, y);
    }
    c.restore();
}

function drawHoverBand(c, pxW, H, cfg, tuning, hoverPx, colBand) {
    if (hoverPx == null || !cfg.span) return;
    const hz0 = cfg.centerFreq - cfg.span / 2;
    const at = hz0 + (hoverPx / pxW) * cfg.span;
    const hzToX = (hz) => ((hz - hz0) / cfg.span) * pxW;
    const x0 = hzToX(at + tuning.bandwidthLow);
    const x1 = hzToX(at + tuning.bandwidthHigh);
    const left = Math.min(x0, x1);
    const w = Math.abs(x1 - x0);
    // Off the side of the view, or a filter too narrow at this zoom to have a width:
    // the hover line is already drawn and is the whole of the answer in that case.
    if (w < 1 || left > pxW || left + w < 0) return;
    c.save();
    // globalAlpha rather than a second colour: --spec-band can be any CSS colour the
    // theme fancies, and this multiplies whatever alpha it already carries instead of
    // trying to take a hex or an rgba() apart.
    c.globalAlpha = HOVER_BAND_ALPHA;
    c.fillStyle = colBand;
    c.fillRect(left, 0, w, H);
    c.restore();
}

function drawTuningMarks(c, pxW, H, cfg, tuning, dpr, dialColor, edgeColor) {
    if (!cfg.span) return;
    const hzToX = (hz) => ((hz - (cfg.centerFreq - cfg.span / 2)) / cfg.span) * pxW;

    // Where the dial is, whether or not it is on screen: an edge just off the
    // left of the view is still crowding a dial just off it too.
    const dial = hzToX(tuning.frequency);
    const gap = MARK_MIN_GAP_PX * dpr;

    for (const edge of [tuning.frequency + tuning.bandwidthLow, tuning.frequency + tuning.bandwidthHigh]) {
        const x = hzToX(edge);
        if (x < 0 || x > pxW) continue;
        // Each edge is judged on its own, so the near one goes first — an SSB
        // passband is lopsided about the dial and its 50 Hz side is on top of it
        // long before the 3 kHz side is. Zoom out further and the far one
        // reaches the same test and goes too, which is right: two marks a pixel
        // apart are not a passband, they are a thicker dial. Zooming back in
        // brings them back one at a time, in the order they became readable.
        if (Math.abs(x - dial) < gap) continue;
        markLine(c, x, H, dpr, edgeColor, EDGE_DASH, 1.4);
    }

    // Last, so where the passband collapses to nothing the dial is what is left
    // on top — it is the line you tune by.
    const x = hzToX(tuning.frequency);
    if (x >= 0 && x <= pxW) markLine(c, x, H, dpr, dialColor, DIAL_DASH, 1.6);
}

/**
 * The waterfall as terrain — see lib/dss.js.
 *
 * On its own canvas, so the heat map's ring, its smooth-scroll transform and its
 * marks are untouched code in every mode. Repainted only when a row arrives or
 * something about the picture changed, exactly as the waterfall repaints only
 * when a row arrives: the whole surface is rebuilt from the ring each time, so
 * there is no history in its pixels to preserve and nothing to scroll.
 */
function drawDss(g, d, dss, dssH, pxW, floor, range, commitRow, now, cfg, tuning) {
    if (!dss || !dssH || dssH <= 0) {
        // Dropped rather than kept: coming back to 2D should not hold a megabyte
        // of history for a canvas that is not on screen, and the surface fills
        // again in a few seconds.
        g.dss = null;
        return;
    }

    // One column per device pixel of the pane, so a one-pixel carrier is a
    // one-column ridge. A width change is a different history — the stored rows
    // were taken at the old width — so the ring is remade rather than resampled.
    //
    // Always the same number of rows, whatever the depth setting is. Which of
    // them are drawn is decided by their age when the surface is painted, so the
    // setting costs nothing to change and — the part that matters — cannot
    // throw the history away by changing.
    const cols = ringCols(pxW);
    if (!g.dss) {
        g.dss = createDssRing(RING_ROWS, cols);
        // A new ring has no recorded view, so the next align call adopts the
        // live one rather than trying to carry a history that does not exist.
        g.dssSpan = 0;
    } else if (g.dss.cols !== cols) {
        // A resized pane, resampled rather than emptied — the same answer the
        // heat map's ring gets, since the surface behind it is the same history
        // seen a second way and the two going blank at different moments would
        // be worse than either. The recorded view stands: a rescale changes how
        // many columns the history takes, not which frequencies it covers.
        g.dss = resizeDssRing(g.dss, cols);
    }

    // Bring the history onto the axis it is about to be drawn against, if that
    // is the mode. Before the new row is written, so the row lands in the column
    // its frequency belongs to — the same order, and the same rule, as the heat
    // map's own realignment.
    alignDssToView(g, d, cfg);

    // Stamped with the clock it will be placed against. There is no rate to
    // measure and nothing to keep in step: the row knows when it arrived, and
    // where it belongs follows from that and from `now`.
    if (commitRow) pushDssRow(g.dss, g.px, now);

    // Remembered so the between-rows frames — which are handed the last known
    // mapping rather than a fresh one — draw against the same numbers.
    if (Number.isFinite(floor)) g.dssFloor = floor;
    if (Number.isFinite(range)) g.dssRange = range;

    // Every frame, and no dirty check: the surface is in motion whenever the
    // clock is, because every row's depth is its own age. Affordable because the
    // rasteriser writes each pixel once however many rows are in range.
    const ctx = dss.getContext('2d', { alpha: false });
    drawSurface(ctx, g.dss, dss.width, dss.height, {
        now,
        spanMs: Math.max(1, d.dssSeconds) * 1000,
        floor: g.dssFloor,
        range: g.dssRange,
        contrast: d.contrast,
        lut: getPalette(d.palette),
        bg: RING_BG_RGB,
    });

    // Over the terrain, after it — the rasteriser writes the whole canvas, so
    // anything drawn before it would be painted out.
    if (cfg && tuning) {
        const { dial, edge } = markColors(d);
        drawDssMarks(ctx, dss.width, dss.height, cfg, tuning, g.dpr, dial, edge);
    }
}

function drawWaterfall(g, d, wf, wfMarks, wfH, pxW, floor, range, commitRow, cfg, tuning, colVfo, colEdge) {
    if (!wf || wfH <= 0 || !g.ring) return;
    const ring = g.ring;
    const rctx = g.ringCtx;
    const H = g.ringHeight;
    const rowH = Math.max(1, Math.round(d.rowHeight * g.dpr));

    // Bring the history onto the axis it is about to be drawn against, if that
    // is the mode. Before the new row is written, so the row lands in the
    // column its frequency belongs to.
    alignRingToView(g, d, cfg);

    if (commitRow) {
        const lut = getPalette(d.palette);
        const img = rctx.createImageData(pxW, 1);
        const data = img.data;
        // A little extra contrast at the bottom of the range keeps weak signals
        // from disappearing into the noise floor colour.
        const gammaInv = 1 / d.contrast;
        for (let x = 0; x < pxW; x++) {
            let t = (g.px[x] - floor) / range;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            if (d.contrast !== 1) t = Math.pow(t, gammaInv);
            const idx = (t * 255) | 0;
            const o = x * 4;
            data[o] = lut[idx * 3];
            data[o + 1] = lut[idx * 3 + 1];
            data[o + 2] = lut[idx * 3 + 2];
            data[o + 3] = 255;
        }

        for (let r = 0; r < rowH; r++) {
            g.ringHead = (g.ringHead - 1 + H) % H;
            rctx.putImageData(img, 0, g.ringHead);
        }
    }

    const octx = wf.getContext('2d', { alpha: false });
    octx.imageSmoothingEnabled = false;
    // Newest row sits at `head`; time runs downward through increasing indices,
    // wrapping once — so the run wanted is one or two contiguous pieces. The
    // resize reads it back the same way; see lib/waterfallRing.js.
    //
    // Only as many rows as the canvas can show, which is fewer than the ring
    // holds: the rest is history kept against the pane being made taller again.
    // Reading the whole ring here would draw the reserve past the bottom edge,
    // where the canvas clips it — harmless, and a blit of rows nobody sees.
    for (const s of ringSlices(g.ringHead, H, Math.min(H, wf.height))) {
        octx.drawImage(ring, 0, s.sy, pxW, s.sh, 0, s.dy, pxW, s.sh);
    }

    // The picture has just moved down a row within the canvas, so putting the
    // canvas back up by the same amount leaves the screen exactly as it was —
    // and sliding it from there to nothing is the row arriving, spread over the
    // time until the next one instead of landing in a single frame.
    //
    // The slide is a transform animation and nothing else, which is the whole
    // reason this is affordable: transforms are composited, so the browser
    // moves a texture it already has rather than calling back into this file.
    // The painting above still happens once per row, exactly as it did when the
    // waterfall jumped.
    if (commitRow) scrollRow(g, wf, d.smoothScroll === false ? 0 : rowH / g.dpr, g.rowDt);

    drawWaterfallMarks(g, wfMarks, wfH, pxW, cfg, tuning, colVfo, colEdge);
}

/**
 * Move the waterfall's history to match the view it is drawn against.
 *
 * The ring's pixels were painted against whatever centre and span were current
 * when each row arrived, and a pan or a zoom changes what a column means. Two
 * answers, and which is right depends on what you are doing:
 *
 *   'hold'   — leave them. The trail keeps exactly the shape it had, and a
 *              carrier's history sits at the frequency it *was* drawn at, which
 *              after a pan is not the frequency the axis now says. Nothing is
 *              ever lost, and this is what the display has always done.
 *   'follow' — shift the whole bitmap by the same distance the axis moved, so
 *              a carrier stays in its column and the history keeps meaning one
 *              scale. What comes in from the edge is background: there is no
 *              history for a part of the band that was not on screen.
 *
 * A pure pan is rounded to a whole pixel and copied — no resampling, so dragging
 * across the band does not smear the history a little more with every frame. The
 * rounding error is carried in the recorded centre rather than dropped, so it
 * cannot accumulate either. A zoom has to resample, and does it once.
 */
/**
 * The surface's history, held to the frequency scale — the Display panel's
 * "Waterfall pan" setting, applied to the terrain as well as to the heat map.
 *
 * Same rule and the same transform as alignRingToView below, because it is the
 * same question: an operator who has asked for the history to move with the view
 * has not asked for half of it to. In '2d+3d' the two pictures sit against one
 * ruler, and one of them ignoring the setting is visible at the seam.
 *
 * What differs is the doing. The heat map slides a bitmap with one drawImage;
 * the surface has to move the numbers its ridge heights come from, which is
 * shiftRows.
 */
function alignDssToView(g, d, cfg) {
    if (!g.dss || !cfg || !cfg.span) return;

    // Nothing recorded yet — a fresh ring is by definition in the current view.
    if (!g.dssSpan) {
        g.dssCentre = cfg.centerFreq;
        g.dssSpan = cfg.span;
        return;
    }
    // In hold mode the rows stay put, so the recorded view follows the live one
    // without touching them: switching to follow later starts from where the
    // picture actually is rather than replaying every past pan.
    if (d.waterfallPan !== 'follow') {
        g.dssCentre = cfg.centerFreq;
        g.dssSpan = cfg.span;
        return;
    }

    const t = panTransform(
        { centre: g.dssCentre, span: g.dssSpan },
        { centre: cfg.centerFreq, span: cfg.span },
        g.dss.cols,
    );
    if (!t) return;

    g.dssCentre = t.centre;
    g.dssSpan = t.span;
    if (t.still) return;
    if (t.drop) { clearDssRows(g.dss); return; }
    shiftDssRows(g.dss, t.offset, t.scale);
}

function alignRingToView(g, d, cfg) {
    if (!g.ring || !cfg || !cfg.span) return;

    // Nothing recorded yet — a fresh ring is by definition in the current view.
    if (!g.ringSpan) {
        g.ringCentre = cfg.centerFreq;
        g.ringSpan = cfg.span;
        return;
    }
    // In hold mode the pixels stay put, so the recorded view follows the live
    // one without touching them: switching to follow later then starts from
    // where the picture actually is rather than replaying every past pan.
    if (d.waterfallPan !== 'follow') {
        g.ringCentre = cfg.centerFreq;
        g.ringSpan = cfg.span;
        return;
    }

    const t = panTransform(
        { centre: g.ringCentre, span: g.ringSpan },
        { centre: cfg.centerFreq, span: cfg.span },
        g.ringWidth,
    );
    if (!t) return;

    g.ringCentre = t.centre;
    g.ringSpan = t.span;
    if (t.still) return;

    const W = g.ringWidth;
    const H = g.ringHeight;
    const c = g.ringCtx;

    if (t.drop) {
        c.fillStyle = RING_BG;
        c.fillRect(0, 0, W, H);
        return;
    }

    if (!g.ringTmp || g.ringTmp.width !== W || g.ringTmp.height !== H) {
        g.ringTmp = document.createElement('canvas');
        g.ringTmp.width = W;
        g.ringTmp.height = H;
        g.ringTmpCtx = g.ringTmp.getContext('2d', { alpha: false });
    }
    g.ringTmpCtx.drawImage(g.ring, 0, 0);

    c.imageSmoothingEnabled = false;
    c.fillStyle = RING_BG;
    c.fillRect(0, 0, W, H);
    c.drawImage(g.ringTmp, 0, 0, W, H, t.offset, 0, W * t.scale, H);
}

/**
 * Slide the waterfall canvas up by one row and let it fall back.
 *
 * `rowCss` of 0 means no animation — smooth scrolling turned off, or a first
 * row with nothing to time against — and leaves the canvas at rest, where it
 * shows the same thing the animation ends on.
 */
function scrollRow(g, wf, rowCss, duration) {
    if (g.scroll) {
        g.scroll.cancel();
        g.scroll = null;
    }
    if (!(rowCss > 0) || !(duration > 0) || typeof wf.animate !== 'function') {
        wf.style.transform = '';
        return;
    }
    g.scroll = wf.animate(
        [{ transform: `translateY(${-rowCss}px)` }, { transform: 'translateY(0px)' }],
        // Linear, because the row is a constant slice of time and any easing
        // would show it arriving faster at one end than the other. Held at the
        // end so a feed that pauses rests in the right place rather than
        // snapping back to where the slide began.
        { duration, easing: 'linear', fill: 'forwards' },
    );
}

/**
 * The tuning marks and the hover line, on the fixed canvas above the waterfall.
 *
 * Never in the ring — they would scroll away with the history — and no longer
 * on the waterfall canvas either, which now moves between rows.
 *
 * Redrawn only when one of them has actually moved. On its old canvas that came
 * free, because the ring blit overwrote everything underneath anyway; on a
 * canvas of its own it would be a clear and three strokes per frame for a
 * picture that changes when the dial does, which is orders of magnitude less
 * often than the feed arrives.
 */
function drawWaterfallMarks(g, marks, wfH, pxW, cfg, tuning, colVfo, colEdge) {
    if (!marks) return;
    const H = Math.max(1, Math.round(wfH * g.dpr));

    // The band's colour is in the key too. Everything else here is geometry, and a
    // theme change moves none of it — without this, switching palette would leave the
    // shading painted in the old scheme's colour until the dial moved.
    const colBand = colors()['--spec-band'] || 'rgba(124,108,247,0.20)';
    const key = `${pxW}|${H}|${cfg.centerFreq}|${cfg.span}|${tuning.frequency}|`
        + `${tuning.bandwidthLow}|${tuning.bandwidthHigh}|${g.hover ? g.hover.x : ''}|`
        // Whether a gesture is running, because it decides whether the hover band is
        // drawn: without it, letting go of an edge without moving the pointer would
        // leave the band missing until the next flicker of the mouse.
        + `${g.drag ? 'd' : ''}${g.edge ? 'e' : ''}|`
        + `${colVfo}|${colEdge}|${colBand}`;
    if (g.marksKey === key) return;
    g.marksKey = key;

    const c = marks.getContext('2d');
    c.clearRect(0, 0, pxW, H);

    // Under the hover line, which is what it belongs to.
    drawHoverBand(c, pxW, H, cfg, tuning, hoverBandPx(g, g.dpr), colBand);

    if (g.hover) {
        const hx = Math.round(g.hover.x * g.dpr) + 0.5;
        c.strokeStyle = 'rgba(255,255,255,0.25)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(hx, 0);
        c.lineTo(hx, H);
        c.stroke();
    }
    drawTuningMarks(c, pxW, H, cfg, tuning, g.dpr, colVfo, colEdge);
}

/**
 * The dial and the passband edges, across the surface.
 *
 * The same three marks the heat map carries, and the same rules for when each is
 * drawn — but each is a *pair* of converging lines rather than one.
 *
 * A ridge stands vertically off the ground plane, so at a given frequency the
 * terrain fills a face between the ground and a full-height crest. One line on
 * the ground answered for the wrong depth everywhere above the plane, and
 * signals comfortably inside the passband appeared outside the edge meant to
 * contain them. The ground line and the crest line together bound every place a
 * ridge at that frequency can be drawn, so what is between them is inside. See
 * edgeLine.
 *
 * Painted over the terrain rather than into it. Properly they would pass behind
 * a ridge that stands in front of them, which is what a depth buffer is for and
 * is a great deal of machinery for a dashed line — and a dial mark that
 * disappeared behind a strong signal would be hiding exactly when it is most
 * wanted. The halo under each line is what keeps them readable over bright
 * terrain, and it is the same halo the flat marks use.
 */
function drawDssMarks(c, pxW, H, cfg, tuning, dpr, dialColor, edgeColor) {
    if (!cfg.span) return;
    const unit = (hz) => (hz - (cfg.centerFreq - cfg.span / 2)) / cfg.span;

    const line = (u, colour, dash, width) => {
        // The ground first, then the crest above it. One path, two segments, so
        // the halo is laid down under both before either is drawn — otherwise
        // the second line's halo cuts a dark notch through the first.
        c.beginPath();
        for (const lift of [0, 1]) {
            const e = edgeLine(u, lift);
            c.moveTo(e.x0 * pxW, e.y0 * H);
            c.lineTo(e.x1 * pxW, e.y1 * H);
        }
        c.setLineDash([dash[0] * dpr, dash[1] * dpr]);
        c.lineCap = 'butt';
        c.lineWidth = (width + 2 * MARK_HALO_PX) * dpr;
        c.strokeStyle = MARK_HALO;
        c.stroke();
        c.lineWidth = width * dpr;
        c.strokeStyle = colour;
        c.stroke();
        c.setLineDash([]);
    };

    const dialU = unit(tuning.frequency);
    // Judged in screen pixels at the *front*, where the row is widest and the
    // two are furthest apart. Judging at the back would drop an edge that is
    // still perfectly readable along most of its length.
    const gap = (MARK_MIN_GAP_PX * dpr) / pxW;

    for (const hz of [tuning.frequency + tuning.bandwidthLow,
        tuning.frequency + tuning.bandwidthHigh]) {
        const u = unit(hz);
        if (u < 0 || u > 1) continue;
        if (Math.abs(u - dialU) < gap) continue;
        line(u, edgeColor, EDGE_DASH, 1.4);
    }

    // Last, so where the passband collapses the dial is what is left on top.
    if (dialU >= 0 && dialU <= 1) line(dialU, dialColor, DIAL_DASH, 1.6);
}

function drawSpectrum(g, d, spec, specH, pxW, trace, floor, range, cfg, tuning, cssW, colVfo, colEdge) {
    if (!spec || specH <= 0) return;
    const c = spec.getContext('2d', { alpha: false });
    const H = Math.max(1, Math.round(specH * g.dpr));
    const dpr = g.dpr;

    const col = colors();
    const colBg = col['--spec-bg'] || '#0a0d14';
    const colGrid = col['--spec-grid'] || 'rgba(255,255,255,0.06)';
    const colBand = col['--spec-band'] || 'rgba(124,108,247,0.20)';

    // Gradients depend only on palette, contrast and height — not on the live
    // dB range — so they survive auto-levelling and are rebuilt rarely. Keyed on
    // the canvas too: a CanvasGradient belongs to the context that made it, and
    // switching view modes can replace the element at the same height.
    const gradKey = `${d.palette}|${d.contrast}|${H}`;
    if (g.gradKey !== gradKey || g.gradCanvas !== spec) {
        const grads = paletteGradients(c, H, d.palette, d.contrast);
        g.traceGrad = grads.trace;
        g.fillGrad = grads.fill;
        g.gradKey = gradKey;
        g.gradCanvas = spec;
    }

    c.fillStyle = colBg;
    c.fillRect(0, 0, pxW, H);

    // Operator backdrop, stretched to the spectrum area and blended over the
    // background colour — split view only, where there is enough height for it
    // to read as anything other than a smear.
    const overImage = d.viewMode === 'split' && !!g.bgImage && g.bgOpacity > 0;
    if (overImage) {
        c.save();
        c.globalAlpha = Math.max(0, Math.min(1, g.bgOpacity));
        c.drawImage(g.bgImage, 0, 0, pxW, H);
        c.restore();
    }

    // Station block sits on the backdrop, under everything else: the trace, the
    // fill and the passband shading pass over it, so it reads as part of the
    // background rather than as a label floating above the signal.
    drawStationId(g, c, pxW, dpr);

    const yOf = (db) => H - ((db - floor) / range) * H;

    // Where the dB scale is marked: every 10 dB, or every 20 when the range is
    // wide enough that ten would be a thicket.
    //
    // Worked out here and used twice, because the two halves of the scale belong
    // in different layers. The lines are a backdrop and are drawn now, under the
    // trace. The labels are drawn last, over everything — see the end of this
    // function.
    const step = range > 80 ? 20 : 10;
    const startDb = Math.ceil(floor / step) * step;
    const ticks = [];
    for (let db = startDb; db < floor + range; db += step) ticks.push(db);

    // Over a backdrop the usual near-transparent white is invisible on anything
    // but a dark image, so the lines are strengthened.
    if (d.grid) {
        c.strokeStyle = overImage ? 'rgba(255,255,255,0.32)' : colGrid;
        c.lineWidth = 1;
        for (const db of ticks) {
            const y = Math.round(yOf(db)) + 0.5;
            c.beginPath();
            c.moveTo(0, y);
            c.lineTo(pxW, y);
            c.stroke();
        }
    }

    // Passband shading around the tuned frequency.
    if (cfg.span) {
        const hzToX = (hz) => ((hz - (cfg.centerFreq - cfg.span / 2)) / cfg.span) * pxW;
        const x0 = hzToX(tuning.frequency + tuning.bandwidthLow);
        const x1 = hzToX(tuning.frequency + tuning.bandwidthHigh);
        if (x1 > 0 && x0 < pxW) {
            c.fillStyle = colBand;
            c.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), H);
        }
    }

    // ...and the same filter at the pointer, lighter. Here rather than beside the
    // hover line further down, so it lies under the trace exactly as the tuned band
    // does: a signal must never be dimmed by a shade that follows the mouse.
    drawHoverBand(c, pxW, H, cfg, tuning, hoverBandPx(g, dpr), colBand);

    // Peak hold, drawn beneath the live trace.
    // Peak hold decays in dB per *second*, not per frame: the draw rate follows
    // the server's frame rate, so a per-frame decay made the hold time depend
    // on how fast the spectrum happened to be arriving. 0 holds indefinitely.
    if (d.peakHold) {
        const now = performance.now();
        const dt = g.peakAt ? Math.min(1, (now - g.peakAt) / 1000) : 0;
        g.peakAt = now;
        const drop = (d.peakDecay || 0) * dt;
        for (let x = 0; x < pxW; x++) {
            const v = trace[x];
            g.peak[x] = v > g.peak[x] ? v : g.peak[x] - drop;
        }
    } else if (g.peak) {
        g.peak.fill(-200);
        g.peakAt = 0;
    }

    // Solid area under the trace. Turning this off leaves a bare line, which
    // shows the whole backdrop and makes overlapping signals easier to separate.
    const filled = d.fill !== false;
    if (filled) {
        c.beginPath();
        c.moveTo(0, H);
        for (let x = 0; x < pxW; x++) c.lineTo(x, yOf(trace[x]));
        c.lineTo(pxW, H);
        c.closePath();
        c.fillStyle = g.fillGrad;
        c.fill();
    }

    if (d.peakHold) {
        c.beginPath();
        for (let x = 0; x < pxW; x++) {
            const y = yOf(g.peak[x]);
            if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.strokeStyle = 'rgba(255,255,255,0.55)';
        c.lineWidth = dpr;
        c.stroke();
    }

    // The line, and only when there is no fill under it.
    //
    // Filled, the shape is what you read and the line adds nothing: it follows
    // the same path the fill already ends on, so all it does is thicken every
    // peak by its own width and close up the gap between two signals that are
    // nearly touching. It used to be drawn at half weight for that reason, which
    // was treating the symptom. Unfilled the line *is* the trace and carries it
    // on its own, at full weight.
    if (!filled) {
        c.beginPath();
        for (let x = 0; x < pxW; x++) {
            const y = yOf(trace[x]);
            if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.strokeStyle = g.traceGrad;
        c.lineWidth = TRACE_WIDTH * dpr;
        c.stroke();
    }

    drawTuningMarks(c, pxW, H, cfg, tuning, dpr, colVfo, colEdge);

    // Peak markers, over the trace they point at. Spectrum only: in waterfall-only
    // view there is no trace for a caret to sit on, and a row of frequencies floating
    // over the history would be pointing at whichever row happened to be at the top.
    if (g.peaksWanted) {
        drawPeakMarks(
            c, g,
            refreshPeaks(g, trace, g.peaksWanted, g.peaksSnr, cfg, pxW, performance.now()),
            pxW, H, dpr, cfg, yOf,
            colors()['--accent'] || '#08a2fb', colBg, g.peaksPlace,
        );
    }

    // Hover crosshair. Drawn whenever the pointer is anywhere over the view,
    // not only when it is over this pane: the two panes share one frequency
    // axis, and a line on just one of them makes you eyeball the other.
    if (g.hover) {
        const x = Math.round(g.hover.x * dpr) + 0.5;
        c.strokeStyle = 'rgba(255,255,255,0.25)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, H);
        c.stroke();
    }

    // The dB labels, last of all and so on top of the signal.
    //
    // They are an axis, not decoration: reading a level off the display is
    // exactly what you are doing when a signal is large, which is precisely when
    // a label drawn under the trace disappears behind it. So they are always
    // over the top, and always shadowed — the fill takes its colour from the
    // palette and can be anything from near-black to bright yellow, and only the
    // shadow makes one colour of text legible against all of them.
    //
    // Independent of the gridlines: the horizontal rules are a visual aid some
    // people find noisy over a waterfall, whereas the numbers are the only thing
    // saying what the vertical axis means. The Display panel's switch turns off
    // the first and leaves the second alone.
    c.save();
    c.font = `${10 * dpr}px ui-monospace, monospace`;
    c.textBaseline = 'bottom';
    c.textAlign = 'left';
    c.fillStyle = overImage ? '#ffffff' : (col['--scale-text'] || '#8b96a9');
    c.shadowColor = 'rgba(0,0,0,0.85)';
    c.shadowBlur = 3 * dpr;
    // Thinned to whatever fits. The tick spacing follows the dB range, so a
    // short spectrum pane — a low split, or the bottom dock — can want a label
    // every few pixels, and unthinned they overprint into a grey smear.
    let lastY = Infinity;
    for (const db of ticks) {
        const y = Math.round(yOf(db)) + 0.5;
        if (lastY - y < DB_LABEL_GAP * dpr) continue;
        lastY = y;
        c.fillText(`${db.toFixed(0)}`, 4 * dpr, y - 2 * dpr);
    }
    c.restore();
}

// Measured line widths, keyed by font and text — see drawStationId.
const STATION_W = new Map();

// Top-right station block. Geometry is v1's: 6 px inset, 16 px line pitch, and
// a 1 px black drop shadow under every line so the text stays legible over a
// bright backdrop image or a strong signal.
function drawStationId(g, c, pxW, dpr) {
    // Where it ended up, for anything else that draws in the same corner — the peak
    // labels, which are a row along the top and would otherwise run straight under it.
    // Cleared first: it is stale the moment the operator turns the block off.
    g.stationBox = null;
    const lines = g.station;
    if (!lines || !lines.length) return;

    const rightX = pxW - 6 * dpr;
    let y = 6 * dpr;
    // Three answers, asked in this order — the same order stationInk documents.
    // A listener who picked a colour for *this* meant it, so that outranks even
    // the operator's; the operator's is their receiver's name in their own
    // colour, which a scheme nobody chose should not overrule; and failing both,
    // the interface's ink over the canvas, so an amber or green scheme does not
    // have one white block in the corner of it.
    const theme = colors();
    const col = theme['--station-ink'] || g.stationColor || theme['--spec-ink'] || '#ffffff';

    c.save();
    // Placed by measurement rather than by textAlign: an operator's name or
    // location can carry anything, and a run the browser aligns by its own
    // rules is how the weather line ended up off the edge in Safari. Measuring
    // and drawing from the left uses one number we can see.
    c.textAlign = 'left';
    c.textBaseline = 'top';
    for (const line of lines) {
        const font = `${line.bold ? 'bold ' : ''}${line.size * dpr}px ui-sans-serif, system-ui, sans-serif`;
        c.font = font;
        // Cached: this runs on every frame, the text changes every 15 minutes,
        // and shaping a string is the expensive half of drawing it.
        const key = `${font}|${line.text}`;
        let w = STATION_W.get(key);
        if (w === undefined) {
            if (STATION_W.size > 32) STATION_W.clear();   // dpr and text both vary
            w = c.measureText(line.text).width;
            STATION_W.set(key, w);
        }
        // A width the browser could not work out must not push the line off
        // screen — anchor it at the edge instead.
        const x = Number.isFinite(w) && w > 0 ? rightX - w : rightX;
        c.globalAlpha = 1;
        c.fillStyle = 'rgba(0,0,0,0.55)';
        c.fillText(line.text, x + dpr, y + dpr);
        c.globalAlpha = line.alpha;
        c.fillStyle = col;
        c.fillText(line.text, x, y);
        y += 16 * dpr;
        const box = g.stationBox;
        g.stationBox = {
            x0: Math.min(box ? box.x0 : Infinity, x),
            x1: rightX,
            y1: y,
        };
    }
    c.restore();
}

// The ruler under the waterfall: notches and their frequencies, nothing else.
// No dial pip and no splitter — those belong to the scale above, and repeating
// them here would be two of each on one view.
/**
 * The slim ruler under the waterfall, and the one between the two pictures in
 * '2d+3d'.
 *
 * `both` is the seam: notches hang from the top edge *and* rise from the bottom,
 * and there is a pip aimed into each picture. That is the one place in the pane
 * where the surface's newest row and the heat map's newest row are the same
 * instant, so it is the one ruler that belongs to two displays at once.
 */
function drawWaterfallScale(g, scale, pxW, cfg, tuning, cssW, colVfo, cssH = WF_SCALE_H,
    both = false) {
    if (!scale || cssH <= 0) return;
    const c = scale.getContext('2d', { alpha: false });
    const dpr = g.dpr;
    const H = Math.round(cssH * dpr);
    const col = colors();
    c.fillStyle = col['--scale-bg'] || '#0e131c';
    c.fillRect(0, 0, pxW, H);
    if (!cfg.span) return;

    const textCol = col['--scale-text'] || '#8a95a8';
    const tickCol = col['--scale-tick'] || 'rgba(255,255,255,0.3)';
    const w = Math.max(1, Math.round(dpr));

    c.font = `${9 * dpr}px ui-monospace, SFMono-Regular, monospace`;
    c.textBaseline = 'middle';
    c.textAlign = 'center';

    for (const t of frequencyTicks(cfg, cssW).ticks) {
        const cx = t.frac * pxW;
        c.fillStyle = t.major ? textCol : tickCol;
        // Notches hang from the top edge, so they meet the waterfall they
        // belong to rather than the panel below. At the seam they do both, so
        // neither picture is the one the ruler is not for.
        const len = Math.round((t.major ? 4 : 2.5) * dpr);
        c.fillRect(Math.round(cx - w / 2), 0, w, len);
        if (both) c.fillRect(Math.round(cx - w / 2), H - len, w, len);
        if (t.major) c.fillText(formatFreqShort(t.hz, cfg.span), Math.round(cx), H * 0.72);
    }

    // Tuned-frequency pip, answering the one on the scale above.
    //
    // The reason for a second one is that the first is at the wrong end. The top
    // scale's pip sits above the waterfall and the history runs down away from
    // it, so on a tall pane the dial frequency is marked only where the picture
    // is newest — and a column of signal near the bottom has nothing beside it
    // to line up against. Two pips give it a pair, one at each end.
    //
    // Point at the top edge rather than base-on-the-bottom, which is what a
    // straight mirror of the pip above would be. This bar is fourteen pixels to
    // that one's twenty-six and its labels are centred at ten, so a triangle
    // rising from the bottom edge lands on the numbers. Standing it on its point
    // against the waterfall clears them, covers only the notches — which is what
    // the pip above does to its own — and aims at the thing being marked.
    const x = ((tuning.frequency - (cfg.centerFreq - cfg.span / 2)) / cfg.span) * pxW;
    if (x >= 0 && x <= pxW) {
        c.fillStyle = colVfo;
        c.beginPath();
        c.moveTo(x - 5 * dpr, 6 * dpr);
        c.lineTo(x + 5 * dpr, 6 * dpr);
        c.lineTo(x, 0);
        c.closePath();
        c.fill();
        // And down into the other picture, where there is one below as well.
        if (both) {
            c.beginPath();
            c.moveTo(x - 5 * dpr, H - 6 * dpr);
            c.lineTo(x + 5 * dpr, H - 6 * dpr);
            c.lineTo(x, H);
            c.closePath();
            c.fill();
        }
    }
}

function drawScale(g, d, scale, pxW, cfg, tuning, cssW, colVfo, colEdge) {
    if (!scale) return;
    const c = scale.getContext('2d', { alpha: false });
    const dpr = g.dpr;
    const H = Math.round(SCALE_H * dpr);
    const col = colors();
    c.fillStyle = col['--scale-bg'] || '#0e131c';
    c.fillRect(0, 0, pxW, H);

    if (!cfg.span) return;
    const lo = cfg.centerFreq - cfg.span / 2;
    const hi = cfg.centerFreq + cfg.span / 2;

    const textCol = col['--scale-text'] || '#8a95a8';
    const tickCol = col['--scale-tick'] || 'rgba(255,255,255,0.3)';

    c.font = `${11 * dpr}px ui-monospace, SFMono-Regular, monospace`;
    c.textBaseline = 'middle';
    c.textAlign = 'center';

    // Ticks are filled rectangles rather than stroked lines. A stroke of an
    // even number of device pixels wants an integer centre and an odd one wants
    // a half-pixel centre, so a single `+ 0.5` is right at one scale factor and
    // blurs at the other; a rect snapped to the device grid is crisp at every
    // one. It also makes the width honest: this used to stroke at lineWidth 1 in
    // an unscaled context, which is one *device* pixel — a half-CSS-pixel
    // hairline on any 2× display, at 16% white, which is why the ruler read as
    // smudges rather than as notches.
    const w = Math.max(1, Math.round(dpr));

    // Stepped by index, so "is this a major" is `i % 5` rather than a
    // floating-point comparison against an epsilon. The epsilon version was not
    // wrong — swept across the whole dial at every span and width it never once
    // disagreed with this — but it left the label positions resting on a
    // tolerance that nothing states a bound for, and an index does not.
    for (const t of frequencyTicks(cfg, cssW).ticks) {
        const cx = t.frac * pxW;
        // Majors take the label's own colour: a tick and the number under it
        // are one mark, and the minors between them are the subdivision.
        c.fillStyle = t.major ? textCol : tickCol;
        c.fillRect(Math.round(cx - w / 2), 0, w, Math.round((t.major ? TICK_MAJOR : TICK_MINOR) * dpr));
        if (t.major) c.fillText(formatFreqShort(t.hz, cfg.span), Math.round(cx), H * 0.65);
    }

    // Tuned-frequency pip: a downward triangle hanging from the top edge, with
    // the frequency itself in a badge under it.
    //
    // The badge is here rather than only in the top bar because this is where
    // you are looking. Reading a signal off the ruler means working out which
    // side of which label it falls on and interpolating; the one frequency worth
    // knowing exactly is the one you are tuned to, and it belongs at the mark
    // that says where that is.
    //
    // It sits over the tick labels near the dial, which is deliberate — it is
    // drawn last for that reason. A number under the pip is the dial; a number
    // it is covering is a tick you can read two of either side.
    const x = ((tuning.frequency - lo) / cfg.span) * pxW;
    if (x >= 0 && x <= pxW) {
        c.fillStyle = colVfo;
        c.beginPath();
        c.moveTo(x - 5 * dpr, 0);
        c.lineTo(x + 5 * dpr, 0);
        c.lineTo(x, PIP_H * dpr);
        c.closePath();
        c.fill();

        // The same formatting as the ticks it sits among, so the badge and the
        // ruler cannot disagree about how many decimals this span deserves.
        const label = formatFreqShort(tuning.frequency, cfg.span);
        const padX = 4 * dpr;
        const bw = Math.ceil(c.measureText(label).width) + padX * 2;
        const bh = Math.round(13 * dpr);
        // Sat on the same line as the tick labels, rather than tucked up under
        // the pip. They are all frequencies on one ruler and reading along a row
        // is what makes the dial's number comparable with the ones either side
        // of it — the badge is a label with a plate behind it, not a separate
        // thing that happens to contain a number. H * 0.65 is the ticks' own
        // baseline; taking it from there means the two cannot drift apart.
        const labelY = H * 0.65;
        const by = Math.round(labelY - bh / 2);
        // Kept inside the ruler when the dial is near an edge: a badge half off
        // the canvas is a frequency you cannot read at the moment you most want
        // it, which is while tuning towards the edge.
        const bx = clamp(Math.round(x - bw / 2), 0, Math.max(0, pxW - bw));

        c.fillStyle = MARK_HALO;
        c.fillRect(bx, by, bw, bh);
        c.fillStyle = colVfo;
        c.fillText(label, bx + bw / 2, labelY);

        // The passband, along the badge's top edge: from the low edge to the
        // high one, in the edge marks' own colour so it reads as the same thing
        // they are. This replaced a plain rule that was there to cap the badge
        // and said nothing — a line across a frequency ruler ought to mean a
        // span of frequency, and this is the span that matters.
        //
        // Drawn after the badge so it is not painted over, and it runs past the
        // badge on both sides whenever the passband is wider than the number is,
        // which is most of the time at a narrow span. Lopsided about the dial for
        // SSB, as it should be.
        //
        // Sits on the pip's point rather than on the badge's top edge, which is
        // where it ended up when the number moved down to join the tick labels.
        // The pip marks the dial and the bar is the passband about that dial, so
        // the two belong together — with the number under them both rather than
        // between them.
        const lox = ((tuning.frequency + tuning.bandwidthLow - lo) / cfg.span) * pxW;
        const hix = ((tuning.frequency + tuning.bandwidthHigh - lo) / cfg.span) * pxW;
        const x0 = clamp(Math.min(lox, hix), 0, pxW);
        const x1 = clamp(Math.max(lox, hix), 0, pxW);
        if (x1 - x0 >= 1) {
            // Dashed on EDGE_DASH, the same pattern the vertical passband edges
            // are drawn with. Solid, it read as its own kind of mark; sharing
            // the dash says it is the same thing seen end-on — the span those
            // two lines bound.
            //
            // One CSS pixel, which is thinner than the 1.4 the edge marks
            // themselves take: this is a short bar read as a span rather than a
            // line read as a position, and it does not need the weight.
            const y = Math.round(PIP_H * dpr) + 0.5;
            c.beginPath();
            c.moveTo(Math.round(x0), y);
            c.lineTo(Math.round(x1), y);
            c.setLineDash([EDGE_DASH[0] * dpr, EDGE_DASH[1] * dpr]);
            c.lineCap = 'butt';
            c.lineWidth = Math.max(1, Math.round(dpr));
            c.strokeStyle = colEdge;
            c.stroke();
            c.setLineDash([]);
        }
    }
}
