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
// twice.

import React, { useEffect, useMemo, useRef, useState } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import Barrel from '../components/Barrel.jsx';
import FreqEntry from '../components/FreqEntry.jsx';
import { Icon, Segmented, Slider } from '../components/ui.jsx';
import { clamp, formatHz, snrColour, snrFraction } from '../lib/format.js';
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

// Frequency: the readout, the step, and the drum that turns it.
function FreqWheel() {
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
                    >
                        {formatHz(tuning.frequency)}
                        <span className="pad-wheel__unit">Hz</span>
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
function PadRow({ label, value, children }) {
    return (
        <label className="pad-row">
            <span className="pad-row__label">{label}</span>
            {children}
            <span className="pad-row__value">{value}</span>
        </label>
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
            {/* The Signal panel's Auto, on the same line for the same reason it
                is on the same line there: it sets the number the slider sets,
                so it belongs beside it rather than under it. Disabled until
                there is an SNR to place it against — a threshold set from no
                measurement is a guess. */}
            <button
                type="button"
                className="chip chip--button pad-row__act"
                title="Set the threshold just above the recent noise level"
                disabled={snr == null}
                onClick={actions.autoSquelch}
            >
                Auto
            </button>
        </PadRow>
    );
}

// `minimal` keeps the two barrels and drops the rest. They are the controls a
// pad is *for* — the ones with no good small form anywhere else — and the mode,
// the width, the view and the squelch are all a tap away in their own panels.
// See the registry's `minimal`.
export default function MultipadPanel({ minimal }) {
    const { tuning, actions } = useRadio();
    const width = Math.abs(tuning.bandwidthHigh - tuning.bandwidthLow);
    const maxWidth = maxFilterWidth(tuning.mode);

    return (
        <div className="stack stack--tight pad">
            <FreqWheel />

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

                    <PadRow label="Width" value={`${(width / 1000).toFixed(2)}k`}>
                        <Slider
                            value={Math.min(width, maxWidth)}
                            min={FILTER_WIDTH_MIN}
                            max={maxWidth}
                            step={FILTER_WIDTH_STEP}
                            onChange={(w) => actions.setBandwidth(...edgesForWidth(tuning.mode, w, tuning))}
                        />
                    </PadRow>

                    <SquelchRow />
                </>
            )}
        </div>
    );
}
