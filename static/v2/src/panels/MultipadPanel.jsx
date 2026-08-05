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

import React, { useRef, useState } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import Barrel from '../components/Barrel.jsx';
import FreqEntry from '../components/FreqEntry.jsx';
import { Segmented, Slider } from '../components/ui.jsx';
import { clamp, formatHz, formatSpan } from '../lib/format.js';
import { deepestRung, rungOfSpan, spanAtRung } from '../lib/zoom.js';
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
                {/* Native select on purpose: a phone gives it a full-height
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
            </div>
            <Barrel
                detent={FREQ_DETENT}
                label={label}
                onStep={tune}
                ariaLabel="Frequency wheel"
                className="barrel--freq"
            />
        </div>
    );
}

// Zoom, as the ladder it actually is: one detent per rung, each rung half the
// span of the one before it — the same factor of two the zoom buttons take,
// because anything gentler rounds back to the rung it started on.
function ZoomWheel() {
    const { view, tuning, actions } = useRadio();
    // Only to redraw the labels while the drum is driving; the rung itself is
    // the ref below. The server confirms a zoom a round trip later, so a spin
    // that read `view` would ask for the same rung several frames running.
    const [, redraw] = useState(0);
    const rungRef = useRef(0);
    const owned = useRef(false);

    const fullSpan = view.defaultBinBandwidth * view.defaultBinCount;
    // Mirrors SpectrumConnection.minBinBandwidthForUI, which is the same floor
    // expressed per bin: a span, so the depth of the ladder does not change with
    // the server's bin count, and never finer than the 0.5 Hz/bin it will serve.
    const minSpan = Math.max(MIN_ZOOM_SPAN_HZ, 0.5 * view.defaultBinCount);
    const deepest = deepestRung(fullSpan, minSpan);
    const ready = fullSpan > 0 && view.span > 0;

    // Follow the spectrum whenever the drum is not the one moving it: a pinch,
    // a bookmark or the toolbar's buttons all show up here with no wiring.
    if (!owned.current) rungRef.current = rungOfSpan(view.span, fullSpan);
    const rung = rungRef.current;

    const label = (i) => {
        if (!ready) return undefined;
        const k = rung + i;
        if (k < 0 || k > deepest) return undefined;     // the ends of the ladder
        return formatSpan(spanAtRung(k, fullSpan));
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
        else actions.setSpectrumView(tuning.frequency, spanAtRung(next, fullSpan));
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
        >
            <span className="barrel__caption">Zoom</span>
        </Barrel>
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
        </PadRow>
    );
}

// `minimal` keeps the two barrels and drops the rest. They are the controls a
// pad is *for* — the ones with no good small form anywhere else — and the mode,
// the width and the squelch are all a tap away in their own panels. See the
// registry's `minimal`.
export default function MultipadPanel({ minimal }) {
    const { tuning, actions } = useRadio();
    const width = Math.abs(tuning.bandwidthHigh - tuning.bandwidthLow);
    const maxWidth = maxFilterWidth(tuning.mode);

    return (
        <div className="stack stack--tight pad">
            <FreqWheel />
            <ZoomWheel />

            {!minimal && (
                <>
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
