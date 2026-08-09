// The Multipad: the whole receiver under one thumb.
//
// A phone reaches the same panels a desktop does, one sheet at a time, and that
// is the problem this exists for: tuning, changing mode, zooming and riding the
// squelch are one activity, and on a handset they were four sheets. The pad puts
// the five controls that make up "listening to something" — frequency, mode,
// zoom, filter width and squelch — in one place, at a size a thumb can work
// without looking, and in about the height of the Receiver panel's dial alone.
//
// It is off on a desktop by default and on here, which is the honest split: a
// desktop has room for the full panels and the pad would be a worse copy of
// them. See the `mobile` block on its registry entry.
//
// Frequency and zoom are barrels — see components/Barrel.jsx. Everything else
// is the ordinary controls at their compact size, because a control that behaves
// differently here from the panel it duplicates is a control you have to learn
// twice. The ends of the frequency barrel are the Markers panel's prev/next, for
// the same reason: hunting for a signal is one activity, and the marker four
// kilohertz up should be reachable without letting go of the drum.

import React, { useEffect, useMemo, useRef, useState } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import Barrel from '../components/Barrel.jsx';
import FreqEntry from '../components/FreqEntry.jsx';
import NavTypes from '../components/NavTypes.jsx';
import { Icon, Segmented, Slider } from '../components/ui.jsx';
import { countryOf, shortMarkerName } from '../lib/markerNav.js';
import useMarkerNav, { stepToMarker, useNavTypes } from '../lib/useMarkerNav.js';
import {
    clamp, countryFlag, formatFilterWidth, formatFreqShort, formatHz, snrColour, snrFraction,
} from '../lib/format.js';
import { useHeaderFits } from '../lib/useHeaderFits.js';
import { isTap } from '../lib/barrel.js';
import { HAM_BANDS, bandForFrequency, tuneToBand } from '../lib/bands.js';
import {
    bandTip, bandTone, getBandConditions, subscribeBandConditions,
} from '../lib/bandConditions.js';
import { rungOfSpan, spanAtRung, zoomLadder } from '../lib/zoom.js';
import { MIN_ZOOM_SPAN_HZ } from '../radio/spectrum-connection.js';
import {
    FILTER_WIDTH_MIN, FILTER_WIDTH_STEP, MAX_FREQ, MIN_FREQ, MODES, SQUELCH_MAX, SQUELCH_MIN,
    SQUELCH_STEP, TUNING_STEPS, edgesForWidth, maxFilterWidth, snapStep, stepLabel,
} from '../radio/constants.js';

// Detent widths, CSS px. A detent is what one step of the gesture costs, so
// this is really "how hard is it to tune by one step": wide enough that a
// deliberate nudge moves one and not three, narrow enough that a spin covers a
// band. The zoom drum is wider because its detents carry a label each and the
// ladder is only a dozen rungs deep, so there is nothing to spin through.
const FREQ_DETENT = 46;
const ZOOM_DETENT = 66;

// A label every fifth detent on the frequency scale, on the round numbers.
const FREQ_MAJOR_EVERY = 5;

// The scale's own labels, in kHz: five figures at a kilohertz step ("14175"),
// gaining a decimal place as the step gets finer. The full frequency is printed
// above the drum — this is the ruler, and a ruler that repeats every digit is
// one you cannot read while it is moving.
function scaleLabel(hz, step) {
    const dp = step >= 1000 ? 0 : step >= 100 ? 1 : step >= 10 ? 2 : 3;
    return (hz / 1000).toFixed(dp);
}

// The SNR, as a tide behind the frequency scale.
//
// The same reading and the same ramp as the top bar's meter and the Signal
// panel's — `snrFraction` over 30–60 dB, `snrColour` red through yellow to
// green — so a glance at any of the three says the same thing about the same
// signal. What differs is that this one is not a control and is not read: it is
// there to be seen out of the corner of the eye while the thumb is on the drum,
// which is the whole reason it is on the drum and not beside it. Tuning across a
// band on a phone otherwise means watching one panel and working another.
//
// It fills from the left, as the top bar's bar does, because that is where the
// room is: the drum is 48 px tall and about 330 wide, so sideways is seven times
// the travel for the same reading. What sideways costs is an edge — a vertical
// boundary at some x, on a frequency scale, beside an index needle, is read as a
// mark at that frequency — so the fill has none: it dissolves over its last
// third, and what moves is the reach of a glow rather than the position of a
// line. See .barrel__snr.
//
// Its own component so the 10 Hz meter sampling re-renders one span and not the
// drum's thirty, the same split the Signal panel makes for its squelch row.
function SnrWash() {
    const m = useMeters(10);
    const snr = m.snr;
    return (
        <span
            className="barrel__snr"
            aria-hidden="true"
            style={{
                width: `${snrFraction(snr) * 100}%`,
                background: snr == null ? 'transparent' : snrColour(snr),
            }}
        />
    );
}

// Prev/next marker, on the two ends of the frequency drum.
//
// The same act as the Markers panel's step buttons, in the place the thumb
// already is: the drum is what you are holding while you hunt, so "there is
// something 4 kHz up" and "take me to it" belong on it rather than in a panel
// you have to go and open. Which markers count is the picker below — see
// NavTypes — and it is the same selection the Markers panel offers, because
// these are the same act and a drum that disagreed with the panel above it would
// be a bug however it was documented.
//
// The name is shortened to about six characters (shortMarkerName): a callsign,
// which is what most of these are, fits whole, and a bookmark called "Shannon
// Volmet" reads as "Shannon". The full name and the frequency are in the title,
// and the colour says which feed it came from — the same three colours the
// panel's type chips use.
//
// Its own component, and not for tidiness: the spot feeds land every few seconds
// and re-rendering the drum's thirty detent cells for a marker two kilohertz away
// would be the same waste SnrWash exists to avoid.
//
// These sit *on* the drum and take none of it away: a press on an end starts a
// spin exactly as a press on the middle does, and only a press that goes nowhere
// steps to the marker. See isTap in lib/barrel.js for the distinction and the
// press handling below for why it is done with window listeners.
function MarkerEdges() {
    const radio = useRadio();
    const [types] = useNavTypes();
    const markers = useMarkerNav(radio, types);

    // A press in progress: which pointer, where it started, how far it has
    // strayed since, and what to do if it turns out to have been a tap.
    //
    // Watched on the window rather than on the button, because by then the button
    // cannot see it: the press is deliberately left to bubble to the barrel, which
    // captures the pointer, and every move and release from that moment is
    // delivered to the barrel and not to us. It still passes the window on its way
    // up, which is the one place both halves of the gesture can be seen.
    //
    // The action is stored with the press rather than looked up on release, so
    // these listeners never need re-binding as the markers change — the marker a
    // tap steps to is the one that was under the thumb when it landed.
    const press = useRef(null);
    useEffect(() => {
        const stray = (e) => {
            const p = press.current;
            if (!p || e.pointerId !== p.id) return;
            p.dev = Math.max(p.dev, Math.abs(e.clientX - p.x), Math.abs(e.clientY - p.y));
        };
        const release = (e) => {
            const p = press.current;
            if (!p || e.pointerId !== p.id) return;
            press.current = null;
            if (isTap(p.dev, (e.timeStamp || performance.now()) - p.t)) p.act();
        };
        const drop = (e) => {
            const p = press.current;
            if (p && e.pointerId === p.id) press.current = null;
        };
        window.addEventListener('pointermove', stray);
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', drop);
        return () => {
            window.removeEventListener('pointermove', stray);
            window.removeEventListener('pointerup', release);
            window.removeEventListener('pointercancel', drop);
        };
    }, []);

    // Nothing selected means no stepping, and no stepping means no buttons: the
    // ends of the drum go back to being drum, which is the point — they are also
    // where a spin can be started from, so an operator who does not want to skip
    // between markers gets the whole scale to throw. Two disabled chevrons would
    // be the worst of both, holding the room without doing anything with it.
    //
    // Only for an empty selection, and not for "prev happens to be null": that
    // comes and goes as the dial moves, and buttons that appeared and vanished
    // under a thumb would be unusable.
    if (!types.length) return null;

    const edge = (m, side) => {
        const flag = countryOf(m);
        const label = m ? (shortMarkerName(m) || formatFreqShort(m.freq)) : '';
        const chevron = side === 'prev'
            ? <Icon.ChevronLeft size={12} />
            : <Icon.ChevronRight size={12} />;
        const act = () => stepToMarker(radio.actions, m);
        return (
            <button
                type="button"
                className={`barrel__edge barrel__edge--${side}`}
                data-type={m ? m.type : undefined}
                /* aria-disabled, not `disabled`: browsers disagree about whether
                   a disabled button dispatches pointer events at all, and one
                   that swallowed the press would give the drum back a dead third
                   at exactly the moment there is nothing that way to step to.
                   Drawn as unavailable, ignored by both handlers below, and the
                   delegated haptics already read this attribute (hapticKindFor),
                   so it does not buzz either. */
                aria-disabled={m ? undefined : 'true'}
                title={m
                    ? `${m.name || 'Marker'} — ${formatFreqShort(m.freq)}`
                    : `Nothing ${side === 'prev' ? 'below' : 'above'} the dial`}
                aria-label={m
                    ? `${side === 'prev' ? 'Previous' : 'Next'} marker: ${m.name || formatFreqShort(m.freq)}`
                    : undefined}
                /* Deliberately not stopped: the drum is meant to take this press
                   as well, so the full width of the scale is still somewhere to
                   spin from. What happens next is decided on release — a gesture
                   that went nowhere was a tap and steps to the marker; one that
                   moved was a spin, and the drum has already been tuning as it
                   moved. */
                onPointerDown={(e) => {
                    if (!m) return;
                    press.current = {
                        id: e.pointerId, x: e.clientX, y: e.clientY, dev: 0,
                        t: e.timeStamp || performance.now(), act,
                    };
                }}
                /* Keyboard only. A pointer's click is ignored here because the
                   press above has already dealt with it — and browsers disagree
                   about whether a click even arrives at a button whose pointer was
                   captured by an ancestor mid-gesture, so relying on it would make
                   the tap work on some and not others. `detail === 0` is the
                   keyboard's signature: Enter and Space on a focused button carry
                   no click count, a mouse or finger always does. */
                onClick={(e) => { if (m && e.detail === 0) act(); }}
            >
                {chevron}
                {/* The name is a caption on the button, not part of it: it hangs
                    off the inner side and takes no pointer events, so the target
                    stays the narrow box around the chevron however long the
                    marker is called. Its own wrapper because that is what can be
                    hung there as one piece — the flag sits between the name and
                    the middle of the drum, as in the Markers panel, so the two
                    flags face each other rather than hugging the chevrons. */}
                <span className="barrel__edge-text">
                    {side === 'next' && flag && <span className="barrel__edge-flag">{countryFlag(flag)}</span>}
                    {label && <span className="barrel__edge-label">{label}</span>}
                    {side === 'prev' && flag && <span className="barrel__edge-flag">{countryFlag(flag)}</span>}
                </span>
            </button>
        );
    };

    return <>{edge(markers.prev, 'prev')}{edge(markers.next, 'next')}</>;
}

// Frequency: the readout, the step, and the drum that turns it.
// What the passband chip costs the readout: "12.00k" at the size below, and the
// gap in front of it.
const BW_W = 52;

function FreqWheel({ headRef, showBw }) {
    const { tuning, actions } = useRadio();
    const display = useDisplay();
    // Shared with click-to-tune on the spectrum and with the Receiver panel's
    // ± buttons, so the pad tunes on the same grid as everything else.
    const step = display.tuneStep || 500;
    const [editing, setEditing] = useState(false);

    // A spin outruns React: the drum asks for a step per frame and the prop it
    // would read is the one from the frame before. Same ref trick the Receiver
    // panel's dial uses, and for the same reason.
    const freqRef = useRef(tuning.frequency);
    freqRef.current = tuning.frequency;

    // Snapped, not added: a spin from an odd frequency lands on round numbers,
    // which is what the ± buttons do and what the grid is for.
    const tune = (n) => {
        const from = freqRef.current;
        const dir = n > 0 ? 1 : -1;
        const first = snapStep(from, step, dir);
        const target = clamp(first + (Math.abs(n) - 1) * step * dir, MIN_FREQ, MAX_FREQ);
        if (target === from) return 0;      // at the end of the band
        freqRef.current = target;
        actions.setFrequency(target);
        return n;
    };

    const major = step * FREQ_MAJOR_EVERY;
    const label = (i) => {
        const hz = tuning.frequency + i * step;
        if (hz < MIN_FREQ || hz > MAX_FREQ) return undefined;   // no scale past the band
        // The detent nearest each round multiple carries the text, but the text
        // is that detent's own frequency: printing the multiple instead would be
        // a scale that lies by up to half a step whenever the dial is off grid.
        const near = Math.round(hz / major) * major;
        return Math.abs(hz - near) <= step / 2 ? scaleLabel(hz, step) : null;
    };

    return (
        <div className="pad-wheel">
            <div className="pad-wheel__head">
                {editing ? (
                    <FreqEntry
                        frequency={tuning.frequency}
                        className="pad-wheel__input"
                        onDone={(hz) => { setEditing(false); if (hz != null) actions.setFrequency(hz); }}
                    />
                ) : (
                    <button
                        type="button"
                        className="pad-wheel__freq"
                        title="Tap to type a frequency"
                        onClick={() => setEditing(true)}
                        ref={headRef}
                    >
                        {/* Wrapped rather than left as a bare text node, so the
                            fit measurement below has an element to ask how wide
                            the digits are. Layout is unchanged: an anonymous
                            flex item and an explicit one lay out the same. */}
                        <span className="pad-wheel__digits">{formatHz(tuning.frequency)}</span>
                        <span className="pad-wheel__unit">Hz</span>
                        {/* The passband, after the frequency, as the top bar
                            shows it after the mode — and dropped the same way
                            when the row has no room for it. The pad's readout is
                            the one place a phone reads its own dial from, and
                            what you are listening *through* belongs beside what
                            you are listening to.

                            Inside the button rather than beside it, which is
                            what makes the room measurable: the button is the
                            row's flexible child, so every spare pixel in the
                            head is inside this box and nowhere else. It reads
                            rather than does — pressing it opens the frequency
                            entry like the rest of the button — because the
                            Receiver panel's slider is where a passband is set
                            and a second way in from here would be a chip that
                            did something different from the thing around it. */}
                        {showBw && !editing && (
                            <span className="pad-wheel__bw">
                                {formatFilterWidth(tuning.bandwidthLow, tuning.bandwidthHigh)}
                            </span>
                        )}
                    </button>
                )}
                {/* Native selects on purpose: a phone gives them a full-height
                    picker, which beats anything a 30 px chip could offer. */}
                <select
                    className="pad-wheel__step"
                    value={step}
                    aria-label="Tuning step"
                    title="How far one detent of the wheel tunes"
                    onChange={(e) => display.set({ tuneStep: Number(e.target.value) })}
                >
                    {TUNING_STEPS.map((s) => <option key={s} value={s}>{stepLabel(s)}</option>)}
                </select>
                {/* Mode, here as well as in the row of buttons below.
                    Deliberately not instead of them: eight buttons are one tap
                    and are worth the room where there is room. This is the
                    minimal view's copy, where there is not — and mode is the one
                    thing you cannot do without on a pad whose whole claim is
                    that it is the panel you were going to open anyway. Tuning
                    across a band edge without it means opening the Receiver
                    panel to turn LSB into USB.

                    A select rather than more buttons because the head is a row
                    that already holds a 27 px frequency readout: two more chips
                    would either wrap it or squeeze the readout to nothing. */}
                <select
                    className="pad-wheel__step pad-wheel__mode"
                    value={tuning.mode}
                    aria-label="Mode"
                    title="Demodulation mode"
                    onChange={(e) => actions.setMode(e.target.value)}
                >
                    {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
            </div>
            <Barrel
                detent={FREQ_DETENT}
                label={label}
                onStep={tune}
                ariaLabel="Frequency wheel"
                className="barrel--freq"
            >
                <SnrWash />
                <MarkerEdges />
            </Barrel>
        </div>
    );
}

// Zoom, one detent per rung of the ladder the server actually offers — see
// zoomLadder in lib/zoom.js. Not powers of two below the full span: those are
// right for the first two rungs, drift after that, and put the floor half a rung
// past the end, which left the drum a detent short of where the zoom buttons and
// a pinch both stop.
function ZoomWheel() {
    const { view, tuning, actions } = useRadio();
    // Only to redraw the labels while the drum is driving; the rung itself is
    // the ref below. The server confirms a zoom a round trip later, so a spin
    // that read `view` would ask for the same rung several frames running.
    const [, redraw] = useState(0);
    const rungRef = useRef(0);
    const owned = useRef(false);

    // Mirrors SpectrumConnection.minBinBandwidthForUI: a span floor expressed
    // per bin, so the depth of the ladder does not change with the bin count,
    // and never finer than the 0.5 Hz/bin the server will serve.
    const minBinBW = Math.max(0.5, MIN_ZOOM_SPAN_HZ / (view.defaultBinCount || 1));
    const ladder = useMemo(
        () => zoomLadder(view.defaultBinBandwidth, view.defaultBinCount, minBinBW),
        [view.defaultBinBandwidth, view.defaultBinCount, minBinBW],
    );
    const deepest = ladder.length - 1;
    const ready = ladder.length > 1 && view.span > 0;

    // Follow the spectrum whenever the drum is not the one moving it: a pinch,
    // a bookmark or the toolbar's buttons all show up here with no wiring.
    if (!owned.current) rungRef.current = rungOfSpan(view.span, ladder);
    const rung = rungRef.current;

    // Labelled by how far in it is, not by the span it produces.
    //
    // "6×" says what the control is; "5.12 MHz" says what the spectrum will
    // show, which the spectrum's own scale is about to say anyway — and it left
    // the drum needing a caption to explain that a column of kilohertz was a
    // zoom. A magnification is also the one reading here that means the same
    // thing on every receiver: the spans depend on the bin count, and rung 6 is
    // 307.2 kHz on one instance and something else on the next.
    const label = (i) => {
        if (!ready) return undefined;
        const k = rung + i;
        if (k < 0 || k > deepest) return undefined;     // the ends of the ladder
        return `${Math.round(ladder[0] / ladder[k])}×`;
    };

    const zoom = (n) => {
        if (!ready) return 0;
        const from = rungRef.current;
        const next = clamp(from + n, 0, deepest);
        if (next === from) return 0;
        owned.current = true;
        rungRef.current = next;
        redraw((v) => v + 1);
        // Rung 0 goes through reset rather than a span request: that is what
        // hands the private radiod channel back instead of leaving one
        // allocated at full span. Same rule zoomOut follows.
        if (next === 0) actions.resetSpectrum();
        else actions.setSpectrumView(tuning.frequency, spanAtRung(next, ladder));
        return next - from;
    };

    // The drum has stopped: hand the rung back to the server's answer, which is
    // also how a request it clamped differently corrects itself.
    const settle = () => {
        if (!owned.current) return;
        owned.current = false;
        redraw((v) => v + 1);
    };

    return (
        <Barrel
            detent={ZOOM_DETENT}
            label={label}
            onStep={zoom}
            onSettle={settle}
            disabled={!ready}
            ariaLabel="Zoom wheel"
            className="barrel--zoom"
        />
    );
}

// Noise reduction, as one control: which filter, or off.
//
// The Audio panel has the whole of it — the switch, the filter chips and each
// filter's parameters — and this is not a second copy. It is the one question
// worth a place on a pad: NR is the thing you reach for the moment a signal gets
// hard to hear, which is the same moment you are working the dial, and going to
// another panel for it means taking your hand off the barrel.
//
// Beside the zoom drum rather than on a line of its own, because a line costs
// as much height here as a barrel and this is one dropdown. It is in the
// minimal view for the same reason the barrels are: at the size a pad gets cut
// down to, this is still a control with nowhere better to be.
//
// Off is an option in the list rather than a switch beside it — "which filter"
// and "any filter at all" are one choice from where you are sitting — and it
// reads "NR Off", so the closed dropdown says what it is without a label taking
// a third of the row. Turning it off keeps the filter that was chosen, so
// turning it back on returns to it.
//
// Absent entirely when the receiver has no filters to offer, rather than a
// disabled control promising something that is not there.
function NoiseSelect() {
    const { dsp, actions, running } = useRadio();
    if (!running || !dsp.schemas || dsp.schemas.length === 0) return null;

    return (
        <select
            className="select pad__nr"
            value={dsp.enabled ? dsp.filter : 'off'}
            onChange={(e) => {
                const v = e.target.value;
                if (v === 'off') actions.setDsp(dsp.filter, false);
                else actions.setDsp(v, true);
            }}
            title="Noise reduction"
            aria-label="Noise reduction"
        >
            <option value="off">NR Off</option>
            {dsp.schemas.map((f) => (
                <option key={f.name} value={f.name} title={f.description || f.name}>
                    {f.name.toUpperCase()}
                </option>
            ))}
        </select>
    );
}

// What the spectrum shows: split, spectrum alone, or waterfall alone.
//
// It lives directly under the zoom drum because it belongs to the same
// question — how the spectrum is drawn, not what the receiver is doing — and
// because on a phone the pad's sheet sits over the foot of that spectrum, so a
// press here changes something already in view. The setting is the one the
// Display panel writes (`display.viewMode`); this is a second way to reach it,
// not a second copy of it, which is the same relation the pad's mode row has to
// the Receiver panel's.
//
// Icon and word rather than either alone: three icons on a phone have no
// tooltip to fall back on, and three words at this size read as a fourth row of
// the same buttons the modes and the bands already are. `minItemWidth` wraps it
// to two rows in a floating panel too narrow for three, as the band row wraps.
function ViewRow() {
    const display = useDisplay();

    const options = [
        { value: 'split', icon: <Icon.ViewSplit size={13} />, label: 'Split', title: 'Spectrum above waterfall' },
        { value: 'spectrum', icon: <Icon.ViewSpectrum size={13} />, label: 'Spectrum', title: 'Spectrum only' },
        { value: 'waterfall', icon: <Icon.ViewWaterfall size={13} />, label: 'Waterfall', title: 'Waterfall only' },
    ];

    return (
        <Segmented
            className="pad-view"
            minItemWidth={68}
            size="sm"
            value={display.viewMode || 'split'}
            onChange={(v) => display.set({ viewMode: v })}
            options={options.map((o) => ({
                value: o.value,
                title: o.title,
                label: <>{o.icon}<span>{o.label}</span></>,
            }))}
        />
    );
}

// The ten HF bands, in one row under the modes: the pad answers "what am I
// listening to" and this is the other half of it, "where should I be". Same
// track and same items as the mode row above — on a pad this size a second kind
// of button would read as a different kind of control — but each one painted
// with that band's conditions, which is the one thing here that is about the
// ionosphere rather than about the receiver.
//
// The tuned band is the selected item, so which one you are in needs no separate
// marking, and pressing one does exactly what the Quick bands panel does: the
// middle of the band, its mode, and the spectrum zoomed to its width.
function BandRow() {
    const { tuning, actions, serverInfo } = useRadio();
    const [states, setStates] = useState(getBandConditions);
    const conditions = !!(serverInfo && serverInfo.noise_floor);

    useEffect(
        () => (conditions ? subscribeBandConditions(setStates) : undefined),
        [conditions],
    );

    const options = HAM_BANDS.map(([name]) => ({
        value: name,
        label: name,
        title: bandTip(name, states[name], conditions),
        className: `pad-band pad-band--${bandTone(states[name], conditions)}`,
    }));

    const go = (name) => {
        const b = HAM_BANDS.find(([n]) => n === name);
        if (b) tuneToBand(actions, b[1], b[2]);
    };

    return (
        <Segmented
            className="pad-bands"
            minItemWidth={26}
            size="sm"
            value={bandForFrequency(tuning.frequency)}
            onChange={go}
            options={options}
        />
    );
}

// One line: what it is, the control, what it reads. Two of these are the whole
// bottom half of the pad, and keeping them identical is what makes it scan.
// `action` is a button that belongs to the row — squelch's Auto. It sits
// *outside* the label rather than among its children: a label's job is to hand
// a click to the control it names, and a button inside one is a click two
// elements want. The spec says the button wins; not every browser has always
// agreed, and the row reads the same either way.
function PadRow({ label, value, children, action }) {
    return (
        <div className="pad-row">
            <label className="pad-row__field">
                <span className="pad-row__label">{label}</span>
                {children}
            </label>
            {action}
            <span className="pad-row__value">{value}</span>
        </div>
    );
}

// The filter width. Its own component because it is drawn in two places — on a
// line of its own, or beside the squelch where the pad is wide enough for the
// pair — and a slider defined inline twice is two sliders to keep in step.
function WidthRow() {
    const { tuning, actions } = useRadio();
    const width = Math.abs(tuning.bandwidthHigh - tuning.bandwidthLow);
    const maxWidth = maxFilterWidth(tuning.mode);

    return (
        <PadRow label="Width" value={`${(width / 1000).toFixed(2)}k`}>
            <Slider
                value={Math.min(width, maxWidth)}
                min={FILTER_WIDTH_MIN}
                max={maxWidth}
                step={FILTER_WIDTH_STEP}
                onChange={(w) => actions.setBandwidth(...edgesForWidth(tuning.mode, w, tuning))}
            />
        </PadRow>
    );
}

// Its own component so the 12 Hz meter sampling behind the live SNR marker
// re-renders this line alone, and not the barrels above it.
function SquelchRow() {
    const { squelch, actions } = useRadio();
    const m = useMeters(12);
    const snr = m.snr;

    return (
        <PadRow
            label="Squelch"
            value={squelch.enabled ? `${squelch.value.toFixed(0)} dB` : 'Off'}
            /* The Signal panel's Auto, on the same line for the same reason it
               is on the same line there: it sets the number the slider sets, so
               it belongs beside it rather than under it. It also turns the
               squelch on, because the threshold it picks is above the floor and
               the floor is what "off" means here.

               Disabled until there is an SNR to measure against, and it says so
               — a threshold set from no measurement would be a guess. */
            action={(
                <button
                    type="button"
                    className="chip chip--button pad-row__act"
                    title={snr == null
                        ? 'Waiting for a signal reading to set the threshold from'
                        : 'Set the threshold just above the recent noise level'}
                    disabled={snr == null}
                    onClick={actions.autoSquelch}
                >
                    Auto
                </button>
            )}
        >
            <Slider
                value={squelch.value}
                min={SQUELCH_MIN}
                max={SQUELCH_MAX}
                step={SQUELCH_STEP}
                onChange={actions.setSquelch}
                marker={snr == null ? null : snr}
                markerTone={squelch.enabled && !m.squelchOpen ? 'closed' : 'open'}
                markerTitle={snr == null ? undefined : `Current SNR: ${snr.toFixed(1)} dB`}
            />
        </PadRow>
    );
}

// `minimal` keeps the two barrels and the squelch, and drops the rest.
//
// The barrels are the controls a pad is *for* — the ones with no good small form
// anywhere else — and the mode, the width and the view are all a tap away in
// their own panels. The squelch is here on the strength of when it is reached
// for rather than where else it lives: it is the one setting on this panel you
// adjust *while listening*, against a signal that is fading in and out, and the
// pad is what a phone has open while that is happening. Sending somebody to the
// Signal panel for it means covering the dial they are working to hear.
//
// It also costs a line rather than a block: one slider and its reading, on the
// row it already shares with Auto. See the registry's `minimal`.
export default function MultipadPanel({ minimal }) {
    const { tuning, actions } = useRadio();

    // How wide the pad is, asked once and answered in two places: whether the
    // readout carries the passband, and whether the squelch and the width fit on
    // one line. It is the same question — is there a spare chip's worth of room —
    // and a second measurement with a threshold of its own would give a pad that
    // showed the passband but stacked the sliders, or the other way about, at
    // whatever widths the two happened to disagree on.
    //
    // Measured on the readout rather than the row it sits in: the readout is the
    // row's only flexible child, so the row's spare width is *inside* it and a
    // measurement of the row would read zero however wide the panel got. See
    // lib/headerRoom.js for the hysteresis that keeps the answer still.
    const headRef = useRef(null);
    const wide = useHeaderFits(headRef, '.pad-wheel__digits', BW_W);

    return (
        <div className="stack stack--tight pad">
            <FreqWheel headRef={headRef} showBw={wide} />

            {/* Which markers the drum's ends step to. Directly under the drum it
                controls, rather than down with the other settings: five chips
                reading "DX CW Voice…" mean something under a frequency wheel with
                markers on its ends, and nothing at all at the foot of the pad. It
                does separate the two barrels, which are a pair — but only in the
                full view; the minimal one, where that pairing is the whole
                layout, does not have this.

                The edges still work in the minimal view, on whatever was last
                chosen here or in the Markers panel — it is one setting, so a pad
                cut down to the two wheels has not lost the way to change it. */}
            {!minimal && <NavTypes />}

            {/* The zoom drum and the NR dropdown share a line: the drum takes
                what is left after the dropdown, which is as wide as its widest
                filter name. */}
            <div className="pad__zoomrow">
                <ZoomWheel />
                <NoiseSelect />
            </div>

            {!minimal && (
                <>
                    <ViewRow />

                    {/* The Receiver panel's own mode control, not a second one
                        that behaves almost like it — but at a width that puts
                        all eight on one row. A second row of modes is the pad's
                        most expensive line: it costs as much height as the zoom
                        barrel to say what four extra buttons already say.

                        32, not the Receiver panel's 54: that is the narrowest a
                        four-character label fits in (see .pad .segmented), and
                        it holds one row down to a 320 px handset. Still
                        auto-fit, so a 220 px floating panel wraps rather than
                        clipping. */}
                    <Segmented
                        minItemWidth={32}
                        size="sm"
                        value={tuning.mode}
                        onChange={actions.setMode}
                        options={MODES.map((m) => ({ value: m.id, label: m.label }))}
                    />

                    <BandRow />
                </>
            )}

            {/* The two sliders you work while listening: on one line where there
                is room for two, stacked where there is not.

                Squelch on the left in both arrangements. It is the one the
                minimal view keeps on its own, so it is the one whose position an
                operator learns — the width joins it on the right rather than
                displacing it.

                In the full view this is where the Width row went. It was a line
                of its own directly above the squelch, and half of that line was
                empty at any width that can hold the pair. */}
            {wide ? (
                <div className="pad__pair">
                    <SquelchRow />
                    <WidthRow />
                </div>
            ) : (
                <>
                    {!minimal && <WidthRow />}
                    <SquelchRow />
                </>
            )}
        </div>
    );
}
