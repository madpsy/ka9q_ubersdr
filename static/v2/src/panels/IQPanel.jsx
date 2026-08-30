// Demodulating the quadrature stream here, in the browser.
//
// Every other way of listening on this receiver asks the server for a
// demodulated channel at the dial: one mode, one passband, one frequency. In
// `iq` the server stops demodulating and sends 12 kHz of baseband instead, and
// this panel is what listens to it — which means the thing it can do that
// nothing else here can is *listen somewhere other than the dial*. The offset
// control is that, and it is why this panel exists rather than being a second
// copy of the Receiver panel's mode buttons.
//
// So: park the dial on a busy 3 kHz of 40 m, switch this on, and walk the
// offset across the twelve kilohertz either side of it, in USB at 2.7 kHz or CW
// at 500 Hz, without retuning the receiver once and without the receiver
// knowing. The stream does not change, the dial does not move, and nobody else
// on the receiver is affected.
//
// ── Experimental, and where the edges are ────────────────────────────────────
//
// The arithmetic is textbook and lib/iqDemod.js justifies every line of it, but
// these are a few hundred lines of JavaScript standing next to ka9q-radio's own
// demodulators and they should not be mistaken for them. Two things in
// particular are worth knowing before judging what comes out:
//
//   * IQ costs the receiver's owner about six times the bandwidth of Opus, on
//     somebody else's bill. That is what the confirmation in front of the mode
//     is about, and it is why this panel does not switch itself on.
//   * The filter is the only filter. In IQ the server's passband is fixed at
//     the full +/-6 kHz and the client DSP chain is out of circuit, so the
//     noise blanker, the noise reduction and the audio filters are all absent —
//     the bandwidth control here is doing the whole job.
//
// ── What is not in this file ─────────────────────────────────────────────────
//
// The demodulator itself, and its lifetime. A collapsed dock section is
// unmounted, so a demodulator owned by this component would stop the moment
// somebody folded the panel away — leaving the receiver in IQ playing broadband
// noise with no control on screen to explain it. The engine is therefore a
// plain object living in lib/iqDemod.js, exactly as the recorder and the measure
// tool are, and components/IQDemodWatch.jsx is what pushes the mode and the
// volume into it. This file is a view over that object and a row of controls.

import React, { useEffect, useReducer, useRef } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { resolveMaxFps, useDisplay } from '../display/DisplayContext.jsx';
import { markColors } from '../display/uiConfig.js';
import { TOUCH_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { Bar, Button, Field, Icon, Readout, Segmented, Slider, Switch } from '../components/ui.jsx';
import { isIQ } from '../radio/constants.js';
import { formatFreqExact, formatSpan } from '../lib/format.js';
import { cssVar, sizedCanvas } from '../lib/audioWaterfall.js';
import { createLevels, updateLevels } from '../lib/ifSpectrum.js';
import { IQSpectrum, binsToPixels, fractionOffset, offsetFraction } from '../lib/iqSpectrum.js';
import {
    DEMOD_MODES, PITCH_MAX, PITCH_MIN,
    activeWidth, demodMode, getIQDemod, offsetLimits, onDemodSettings, passbandFor, planFor,
    tapsFor,
} from '../lib/iqDemod.js';

// How often the level meter is redrawn while running. Twelve a second, which is
// the rate the Signal panel's meters are sampled at and as fast as a bar is
// worth reading; the audio itself is not being driven from here.
const METER_MS = 80;

// Height of the spectrum, in CSS pixels. Tall enough for the thirty decibels
// between a signal and the noise it is sitting in to be worth looking at, short
// enough to leave room for the controls under it in a dock column.
const SCOPE_H = 96;

const MODE_OPTIONS = DEMOD_MODES.map((m) => ({
    value: m.id, label: m.label, title: m.summary,
}));

/** A width in the unit it reads best in: hertz below a kilohertz, kHz above. */
function widthLabel(hz) {
    if (hz < 1000) return `${hz}`;
    const k = hz / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
}

/** A signed offset from the dial, in the shape the Measure panel uses. */
function offsetLabel(hz) {
    const r = Math.round(hz);
    if (r === 0) return '0 Hz';
    return `${r > 0 ? '+' : '−'}${formatSpan(Math.abs(r))}`;
}

/**
 * The picture of the stream, and the way you aim inside it.
 *
 * This is the panel's reason for being a panel rather than a row of sliders: the
 * offset is a place in a piece of spectrum, and a place in a piece of spectrum
 * is something you point at. Pressing anywhere on it puts the demodulator there
 * and dragging walks it across the band, with the passband drawn where it will
 * actually land so aiming is a thing you can see rather than a thing you do by
 * ear.
 *
 * The transform is computed here, from the same quadrature the demodulator is
 * listening to — see lib/iqSpectrum.js, and the note there about why a complex
 * transform can show the two sides of the dial apart when the audio analyser
 * behind the Audio scope cannot.
 *
 * It runs whenever the receiver is in IQ, not only while demodulating: looking
 * at what is in the twelve kilohertz before deciding where to listen is the
 * order somebody actually does this in, and a picture that only appeared after
 * Start would be a picture that arrived too late to be used.
 */
function IQScope({ player, live, iq, band, offsetHz, onOffset, maxFps, marks }) {
    const ref = useRef(null);
    const st = useRef({
        spec: new IQSpectrum(),
        levels: createLevels(),
        px: null,
        last: 0,
        ready: false,
    });
    // Read by the draw loop, which must not restart on every render — a new tap
    // and a fresh transform each time the offset moved by ten hertz would blank
    // the picture on the one gesture it exists to serve.
    st.current.band = band;
    st.current.offsetHz = offsetHz;

    useEffect(() => {
        const s = st.current;
        if (!live || !iq) {
            s.spec.reset();
            s.levels = createLevels();
            s.ready = false;
            return undefined;
        }

        const untap = player.onAudio((planes, frames, sampleRate) => {
            // A mono stream is not a quadrature pair, and reading one as though
            // it were would draw a plausible picture of nothing.
            if (planes.length < 2) return;
            s.spec.push(planes[0], planes[1], frames, sampleRate);
        });

        let raf = 0;
        let timer = 0;
        const capMs = maxFps > 0 ? 1000 / maxFps : 0;
        const frame = () => {
            const now = performance.now();
            const dt = s.last ? Math.min(1, (now - s.last) / 1000) : 0.05;
            s.last = now;
            draw(ref.current, s, dt, marks);
            if (capMs) timer = setTimeout(() => { raf = requestAnimationFrame(frame); }, capMs);
            else raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);

        return () => {
            untap();
            cancelAnimationFrame(raf);
            clearTimeout(timer);
            s.last = 0;
        };
    }, [player, live, iq, maxFps, marks.dial, marks.edge]);

    // The press and the drag are the same act, so they run the same line.
    // Pointer capture is what makes a drag that leaves the canvas keep tuning
    // rather than stopping at the edge — which is exactly where somebody chasing
    // a signal towards the end of the span ends up.
    const aim = (e) => {
        const canvas = ref.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width) return;
        const frac = (e.clientX - rect.left) / rect.width;
        onOffset(Math.round(fractionOffset(frac, st.current.spec.rate)));
    };

    const down = (e) => {
        if (!live || !iq) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        aim(e);
    };
    const move = (e) => {
        if (!e.currentTarget.hasPointerCapture || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
        aim(e);
    };
    const up = (e) => {
        if (e.currentTarget.hasPointerCapture && e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };

    return (
        <div className="iq-scope">
            <canvas
                ref={ref}
                className="iq-scope__canvas"
                style={{ height: `${SCOPE_H}px` }}
                title="Press or drag to move the demodulator inside the stream"
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
            />
            {!(live && iq) && (
                <div className="iq-scope__veil">
                    {live ? 'The receiver is not in IQ.' : 'The receiver is off.'}
                </div>
            )}
            <div className="iq-scope__scale">
                <span>−6 kHz</span>
                <span>dial</span>
                <span>+6 kHz</span>
            </div>
        </div>
    );
}

/**
 * One frame of the picture.
 *
 * Order matters and is the usual one: the passband under everything so the
 * trace is legible over it, the trace, then the two marks on top — the dial,
 * which never moves, and the offset, which is the thing being aimed.
 */
function draw(canvas, s, dt, marks) {
    if (!canvas) return;
    const bins = s.spec.frame(dt);
    const { w, h, dpr } = sizedCanvas(canvas, SCOPE_H);
    const c = canvas.getContext('2d');
    if (!c) return;

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = cssVar('--surface-3', '#1a2130');
    c.fillRect(0, 0, w, h);

    const rate = s.spec.rate || 12000;
    const xOf = (hz) => offsetFraction(hz, rate) * w;

    // The filter that is actually running, at the offset it is actually running
    // at. Drawn whether or not anything has been received yet: it is a statement
    // about the settings, not about the signal.
    const band = s.band;
    if (band) {
        const x0 = xOf(band.lo);
        const x1 = xOf(band.hi);
        c.fillStyle = cssVar('--spec-band', 'rgba(139,124,248,0.22)');
        c.fillRect(x0, 0, Math.max(1 * dpr, x1 - x0), h);
    }

    if (bins) {
        s.ready = true;
        if (!s.px || s.px.length !== w) s.px = new Float32Array(w);
        binsToPixels(bins, s.px);
        const { floor, ceil } = updateLevels(s.levels, s.px, dt);
        const span = Math.max(1, ceil - floor);
        const yOf = (db) => h - ((db - floor) / span) * h;

        // Filled to the floor rather than a bare line: at this height a stroke
        // on its own reads as a scribble, and the fill is what makes a carrier
        // look like a carrier.
        c.beginPath();
        c.moveTo(0, h);
        for (let x = 0; x < w; x++) {
            const y = s.px[x];
            c.lineTo(x, Number.isFinite(y) ? Math.max(0, Math.min(h, yOf(y))) : h);
        }
        c.lineTo(w, h);
        c.closePath();
        const accent = cssVar('--accent', '#08a2fb');
        c.globalAlpha = 0.30;
        c.fillStyle = accent;
        c.fill();
        c.globalAlpha = 1;
        c.lineWidth = Math.max(1, dpr);
        c.strokeStyle = accent;
        c.stroke();
    }

    const line = (hz, colour, dash, width) => {
        const x = Math.round(xOf(hz)) + 0.5;
        if (x < -1 || x > w + 1) return;
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, h);
        c.setLineDash(dash.map((d) => d * dpr));
        c.lineWidth = width * dpr;
        c.strokeStyle = colour;
        c.stroke();
        c.setLineDash([]);
    };

    // The dial first and the offset over it, because at an offset of zero the
    // two are the same line and the one worth seeing is where you are listening.
    line(0, marks.dial, [4, 4], 1);
    line(s.offsetHz, marks.edge, [], 1.4);
}

/**
 * `minimal` keeps what you operate — the switch, the mode, where in the stream
 * and how wide — and drops what you set once: the gain, the AGC and the prose.
 * See the registry's `minimal`.
 */
export default function IQPanel({ minimal }) {
    const { running, audioState, tuning, actions, player } = useRadio();
    const display = useDisplay();
    const touch = useMediaQuery(TOUCH_QUERY);
    const maxFps = resolveMaxFps(display.maxFps, touch);
    // The same two colours the main spectrum marks the dial and the passband
    // edges with, so a mark means the same thing in both pictures.
    const marks = markColors(display);
    const demod = getIQDemod(player);

    // The engine is not React state, so a change on it has to be turned into a
    // render by hand — the recorder panel does the same over the same kind of
    // object.
    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => demod.on('change', bump), [demod]);
    useEffect(() => onDemodSettings(bump), []);

    const on = demod.running;
    useEffect(() => {
        if (!on) return undefined;
        const t = setInterval(bump, METER_MS);
        return () => clearInterval(t);
    }, [on]);

    const s = demod.settings;
    const mode = demodMode(s.mode);
    const width = activeWidth(s);
    const limits = offsetLimits(s.mode, width);
    const band = passbandFor(s.mode, s.offsetHz, width);
    // How long the filter will be at this bandwidth, computed from the settings
    // rather than read off the engine: the engine only knows once a packet has
    // arrived, and the number is worth watching while the slider moves — it is
    // what a narrow filter costs, and it is the one figure here that says this
    // is being done in the browser.
    const taps = tapsFor(
        planFor({ mode: s.mode, offsetHz: s.offsetHz, widthHz: width, pitchHz: s.pitchHz }).cutoffHz,
        demod.rate || 12000,
    );
    const iq = isIQ(tuning.mode);
    const live = running && audioState === 'open';
    const hearing = on && demod.quadrature;

    // Start remembers where the operator was, so stopping does not strand them
    // in a mode that plays broadband noise. Asking for IQ from a listening mode
    // puts a confirmation up rather than switching immediately — the engine will
    // not touch the stream until the mode has actually arrived, which is what
    // IQDemodWatch's quadrature flag is for.
    const start = () => {
        demod.restoreMode = iq ? null : tuning.mode;
        if (!iq) actions.setMode('iq');
        demod.start();
    };

    // Stopping puts the mode back, but only if the receiver is still where we
    // put it: if the operator has since chosen a mode themselves, that is the
    // one they want. Same rule as the DRM panel's.
    const stop = () => {
        const back = demod.restoreMode;
        demod.restoreMode = null;
        demod.stop();
        if (back && isIQ(tuning.mode)) actions.setMode(back);
    };

    const setMode = (id) => demod.set({ mode: id });
    const setWidth = (hz) => demod.set({ widths: { [s.mode]: hz } });
    const setOffset = (hz) => demod.set({ offsetHz: hz });

    // Coarse enough that the slider crosses twelve kilohertz in a drag, fine
    // enough to land on a carrier: ten hertz is a fifth of the narrowest CW
    // filter offered and well inside any voice passband.
    const OFFSET_STEP = 10;
    const widthStep = mode.min < 500 ? 10 : 50;

    return (
        <div className="stack">
            {!live && (
                <div className="note note--tight">
                    Start the receiver to demodulate its quadrature stream.
                </div>
            )}

            <div className="iq-run">
                <Button
                    size="sm"
                    variant={on ? 'default' : 'primary'}
                    icon={on ? <Icon.Stop /> : <Icon.Play />}
                    disabled={!live}
                    onClick={on ? stop : start}
                >
                    {on ? 'Stop' : 'Start'}
                </Button>
                <span className="iq-run__hint">
                    {!on ? (iq ? 'Ready — the receiver is in IQ.' : 'Starting will switch the receiver to IQ.')
                        : hearing ? 'Demodulating in the browser.'
                            : 'Waiting for the quadrature stream…'}
                </span>
            </div>

            {/* The picture, and the way the offset below it is actually set.
                Above the controls because it is what you look at while you use
                them, and directly over the offset slider because the two are the
                same control drawn two ways. */}
            <IQScope
                player={player}
                live={live}
                iq={iq}
                band={band}
                offsetHz={s.offsetHz}
                onOffset={setOffset}
                maxFps={maxFps}
                marks={marks}
            />

            <Field label="Demodulator">
                <Segmented
                    options={MODE_OPTIONS}
                    value={s.mode}
                    onChange={setMode}
                    size="sm"
                    columns={5}
                />
            </Field>

            {/* The control this panel is for. The range is what the passband can
                reach without hanging off the end of the stream, so it narrows as
                the bandwidth widens rather than letting the filter run out over
                an edge where there is nothing at all. */}
            <Field
                label="Offset in stream"
                hint={offsetLabel(s.offsetHz)}
            >
                <Slider
                    value={s.offsetHz}
                    min={Math.round(limits.min)}
                    max={Math.round(limits.max)}
                    step={OFFSET_STEP}
                    onChange={setOffset}
                    marker={0}
                    markerTitle="The dial"
                />
            </Field>

            <Field label="Bandwidth" hint={`${formatSpan(width)} · ${offsetLabel(band.lo)} to ${offsetLabel(band.hi)}`}>
                <Segmented
                    options={mode.widths.map((w) => ({ value: w, label: widthLabel(w) }))}
                    value={width}
                    onChange={setWidth}
                    size="sm"
                    columns={mode.widths.length}
                />
            </Field>
            <Slider
                value={width}
                min={mode.min}
                max={mode.max}
                step={widthStep}
                onChange={setWidth}
            />

            {s.mode === 'cw' && (
                <Field label="CW pitch" hint={`${s.pitchHz} Hz`}>
                    <Slider
                        value={s.pitchHz}
                        min={PITCH_MIN}
                        max={PITCH_MAX}
                        step={10}
                        onChange={(hz) => demod.set({ pitchHz: hz })}
                    />
                </Field>
            )}

            <div className="readout-grid">
                <Readout label="Listening" value={formatFreqExact(tuning.frequency + s.offsetHz)} />
                <Readout label="Filter" value={taps} unit="taps" />
            </div>

            <Field label="Output">
                <Bar value={hearing ? Math.min(1, demod.level * 4) : 0} />
            </Field>

            {!minimal && (
                <>
                    <Switch
                        checked={s.agc}
                        onChange={(v) => demod.set({ agc: v })}
                        label="Automatic gain"
                        title="Levels the output. Without it the gain below is the only control."
                    />
                    <Field label="Gain" hint={`${s.gain.toFixed(2)}×`}>
                        <Slider
                            value={s.gain}
                            min={0}
                            max={4}
                            step={0.05}
                            onChange={(v) => demod.set({ gain: v })}
                        />
                    </Field>
                    <div className="note note--tight">
                        Experimental. The receiver sends 12 kHz of raw baseband and this
                        demodulates it here, so the offset picks any point inside that
                        span without retuning &mdash; but IQ costs the receiver&rsquo;s
                        owner about six times the bandwidth of Opus, and in IQ the noise
                        blanker, noise reduction and audio filters are all bypassed. The
                        bandwidth above is the only filtering there is.
                    </div>
                </>
            )}
        </div>
    );
}
