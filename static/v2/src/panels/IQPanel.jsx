// Demodulating the quadrature stream here, in the browser — up to four at once.
//
// Every other way of listening on this receiver asks the server for a
// demodulated channel at the dial: one mode, one passband, one frequency. In
// `iq` the server stops demodulating and sends 12 kHz of baseband instead, and
// this panel is what listens to it. Two things follow that nothing else here can
// do, and between them they are the reason the panel exists:
//
//   * You can listen somewhere other than the dial. The offset picks any point
//     in the twelve kilohertz, at a bandwidth of your own, without retuning and
//     without the receiver knowing.
//   * You can do it more than once. The same samples feed up to four
//     demodulators at the same time, each with its own mode, filter, ear and
//     level — so both sides of a split, or a net and the DX it is working, or
//     four CW signals across a contest pile-up, are one stream and one screen.
//
// ── The layout, and why it is this one ───────────────────────────────────────
//
// Four demodulators is two different jobs and they want opposite things. One is
// survey — where are they, what are they doing, which is muted — which wants
// every one of them visible at once and compact. The other is adjustment, which
// wants full-size controls and only ever concerns one of them.
//
// A row per demodulator with the selected one *opening in place* serves both.
// The list is the picture's legend, so every row carries the colour its passband
// is drawn in; the row you are working on expands where it sits, so there is
// never a question of which one the controls below belong to. With a single
// demodulator — the default — this reads as an ordinary panel with one header
// line above it. With four it is still one set of controls.
//
// The two controls that do *not* wait to be selected are pan and mute, which sit
// on every row. Those are the ones you reach for while juggling several — which
// of these am I listening to, and in which ear — and having to select a
// demodulator before you could silence it would be the wrong way round.
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
// The demodulators themselves, and their lifetime. A collapsed dock section is
// unmounted, so a bank owned by this component would stop the moment somebody
// folded the panel away — leaving the receiver in IQ playing broadband noise
// with no control on screen to explain it. The engine is therefore a plain
// object living in lib/iqDemod.js, exactly as the recorder and the measure tool
// are, and components/IQDemodWatch.jsx is what pushes the mode and the volume
// into it. This file is a view over that object and a set of controls.

import React, { useEffect, useReducer, useRef } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { resolveMaxFps, useDisplay } from '../display/DisplayContext.jsx';
import { markColors } from '../display/uiConfig.js';
import { TOUCH_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { Button, Field, Icon, Readout, Segmented, Slider, Switch } from '../components/ui.jsx';
import { isIQ } from '../radio/constants.js';
import { formatFreqExact, formatSpan } from '../lib/format.js';
import { haptic } from '../lib/haptics.js';
import { cssVar, sizedCanvas } from '../lib/audioWaterfall.js';
import { createLevels, updateLevels } from '../lib/ifSpectrum.js';
import {
    IQSpectrum, aimCancel, aimDown, aimMove, aimUp, binsToPixels, fractionOffset, markerAt,
    newAim, offsetFraction,
} from '../lib/iqSpectrum.js';
import {
    DEMOD_MODES, MAX_VFOS, PANS, PITCH_MAX, PITCH_MIN, VFO_LABELS,
    addVfo, demodMode, getIQDemod, offsetLimits, onDemodSettings, planForVfo, removeVfo,
    selectVfo, tapsFor, updateVfo, vfoPassband, vfoWidth,
} from '../lib/iqDemod.js';

// How often the level meters are redrawn while running. Twelve a second, which
// is the rate the Signal panel's meters are sampled at and as fast as a bar is
// worth reading; the audio itself is not driven from here.
const METER_MS = 80;

// Height of the spectrum, in CSS pixels. Tall enough for the thirty decibels
// between a signal and the noise it is sitting in to be worth looking at, short
// enough to leave room under it for four rows in a dock column.
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

/** The one line a collapsed row gets: what it is, how much of it, and where. */
export function vfoSummary(vfo) {
    const mode = demodMode(vfo.mode);
    return `${mode.label} ${widthLabel(vfoWidth(vfo))} · ${offsetLabel(vfo.offsetHz)}`;
}

/** The theme's four demodulator colours, read once per draw rather than per mark. */
function vfoColours() {
    const fallback = ['#f2b544', '#45d69a', '#f472b6', '#a78bfa'];
    return fallback.map((f, i) => cssVar(`--iq-vfo-${i + 1}`, f));
}

/**
 * The picture of the stream, and the way you aim inside it.
 *
 * This is the panel's reason for being a panel rather than a list of sliders:
 * a demodulator's offset is a place in a piece of spectrum, and a place in a
 * piece of spectrum is something you point at. Every demodulator's passband is
 * drawn here in its own colour, so the picture is the one view that shows all
 * four at once and the rows below are its legend.
 *
 * Pressing has two meanings and the markers tell them apart: a press within a
 * few pixels of one picks *that* demodulator up and drags it — selecting it on
 * the way — and a press anywhere else moves the one already selected. That is
 * what makes all four directly draggable rather than only the current one.
 *
 * The transform is computed here, from the same quadrature the demodulators are
 * listening to — see lib/iqSpectrum.js, and the note there about why a complex
 * transform can show the two sides of the dial apart when the audio analyser
 * behind the Audio scope cannot.
 *
 * It runs whenever the receiver is in IQ, not only while demodulating: looking
 * at what is in the twelve kilohertz before deciding where to listen is the
 * order somebody actually does this in, and a picture that only appeared after
 * Start would be a picture that arrived too late to be used.
 */
function IQScope({ player, live, iq, running, vfos, active, onOffset, onPick, maxFps, marks }) {
    const ref = useRef(null);
    const st = useRef({
        spec: new IQSpectrum(),
        levels: createLevels(),
        px: null,
        last: 0,
        aim: newAim(),
        target: -1,
    });
    // Read by the draw loop, which must not restart on every render — a new tap
    // and a fresh transform each time an offset moved by ten hertz would blank
    // the picture on the one gesture it exists to serve.
    st.current.vfos = vfos;
    st.current.active = active;

    useEffect(() => {
        const s = st.current;
        if (!live || !iq) {
            s.spec.reset();
            s.levels = createLevels();
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

    // Where in the picture the pointer is, in pixels from its left edge, or null
    // if it cannot be measured.
    const xOf = (e) => {
        const canvas = ref.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width) return null;
        return { x: e.clientX - rect.left, w: rect.width };
    };

    const aim = (e) => {
        const at = xOf(e);
        if (!at) return;
        const s = st.current;
        // Committing the pick here rather than on the way down: a press that
        // turns out to be a scroll never reaches this, so a swipe past the
        // picture must not change which demodulator is selected either.
        if (s.target >= 0 && s.target !== s.active) onPick(s.target);
        const index = s.target >= 0 ? s.target : s.active;
        onOffset(index, Math.round(fractionOffset(at.x / at.w, s.spec.rate)));
    };

    const grab = (e) => {
        if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
    };
    const release = (e) => {
        if (e.currentTarget.hasPointerCapture && e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };

    // What each of these means is in lib/iqSpectrum.js, under "Aiming" — the
    // rule is pure, and it is the part that cannot be seen without a touch
    // screen in hand.
    const act = (e, { tune, capture }) => {
        if (capture) grab(e);
        if (tune) aim(e);
    };

    const down = (e) => {
        if (!live || !iq) return;
        const s = st.current;
        const at = xOf(e);
        // Which demodulator this gesture is about, decided once at the start:
        // deciding it again on every move would let a drag hand itself over to
        // whichever marker it happened to pass.
        s.target = at
            ? markerAt(s.vfos.map((v) => v.offsetHz), at.x, at.w, s.spec.rate)
            : -1;
        const r = aimDown(s.aim, e);
        act(e, r);
        if (r.tune) haptic('tune', 'spectrum');
    };
    const move = (e) => act(e, aimMove(st.current.aim, e));
    const up = (e) => {
        const r = aimUp(st.current.aim, e);
        release(e);
        act(e, r);
        if (r.tune) haptic('tune', 'spectrum');
    };
    const cancel = (e) => {
        aimCancel(st.current.aim);
        st.current.target = -1;
        release(e);
    };

    return (
        <div className="iq-scope">
            <canvas
                ref={ref}
                className={`iq-scope__canvas${running ? ' is-live' : ''}`}
                style={{ height: `${SCOPE_H}px` }}
                title="Press or drag to move a demodulator; press a marker to pick that one up"
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={cancel}
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
 * Order matters and is the usual one: the passbands under everything so the
 * trace stays legible over them, the trace, then the marks on top. Among the
 * marks the selected demodulator goes last, so where two sit on the same
 * frequency the one you are working on is the one you can see.
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
    const vfos = s.vfos || [];
    const colours = vfoColours();

    // The filters that are actually running, at the offsets they are actually
    // running at. Drawn whether or not anything has been received yet: they are
    // a statement about the settings, not about the signal.
    for (let i = 0; i < vfos.length; i++) {
        const band = vfoPassband(vfos[i]);
        const x0 = xOf(band.lo);
        const x1 = xOf(band.hi);
        c.globalAlpha = i === s.active ? 0.30 : 0.16;
        c.fillStyle = colours[i % colours.length];
        c.fillRect(x0, 0, Math.max(dpr, x1 - x0), h);
    }
    c.globalAlpha = 1;

    if (bins) {
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
        c.globalAlpha = 0.28;
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

    line(0, marks.dial, [4, 4], 1);

    // Each marker wears its number. With one demodulator that is a redundant
    // label; with four it is the only thing tying a line on the picture to a row
    // in the list, and adding it only once there is more than one would mean the
    // picture changed shape as a demodulator was added.
    const tag = (i, x) => {
        const label = VFO_LABELS[i] || String(i + 1);
        const pad = 3 * dpr;
        c.font = `${Math.round(9 * dpr)}px var(--mono), monospace`;
        const tw = c.measureText(label).width;
        const bw = tw + pad * 2;
        const bh = 12 * dpr;
        // Kept inside the picture: a marker against either edge would otherwise
        // hang its label off the end.
        const bx = Math.max(0, Math.min(w - bw, x - bw / 2));
        c.fillStyle = colours[i % colours.length];
        c.fillRect(bx, 0, bw, bh);
        c.fillStyle = cssVar('--surface-3', '#1a2130');
        c.textBaseline = 'middle';
        c.fillText(label, bx + pad, bh / 2);
    };

    const order = vfos.map((v, i) => i).sort((a, b) => (a === s.active ? 1 : b === s.active ? -1 : 0));
    for (const i of order) {
        const x = xOf(vfos[i].offsetHz);
        line(vfos[i].offsetHz, colours[i % colours.length], [], i === s.active ? 1.6 : 1);
        if (x >= -1 && x <= w + 1) tag(i, x);
    }
}

/**
 * One demodulator: its row, and its controls when it is the one open.
 *
 * The head is a glance and two controls; the body is everything else. Pan and
 * mute live in the head rather than the body deliberately — see the note at the
 * top of this file.
 */
function VfoRow({ index, vfo, open, level, taps, dialHz, minimal, canRemove }) {
    const mode = demodMode(vfo.mode);
    const width = vfoWidth(vfo);
    const limits = offsetLimits(vfo.mode, width);
    const band = vfoPassband(vfo);
    const set = (patch) => updateVfo(index, patch);

    // Coarse enough that the slider crosses twelve kilohertz in a drag, fine
    // enough to land on a carrier: ten hertz is a fifth of the narrowest CW
    // filter offered and well inside any voice passband.
    const widthStep = mode.min < 500 ? 10 : 50;

    return (
        <div
            className={`iq-vfo${open ? ' is-open' : ''}${vfo.muted ? ' is-muted' : ''}`}
            style={{ '--vfo': `var(--iq-vfo-${(index % MAX_VFOS) + 1})` }}
        >
            <div className="iq-vfo__head">
                <button
                    type="button"
                    className="iq-vfo__pick"
                    onClick={() => selectVfo(index)}
                    title={open ? 'The demodulator being edited' : 'Edit this demodulator'}
                >
                    <i className="iq-vfo__swatch" />
                    <span className="iq-vfo__name">{VFO_LABELS[index]}</span>
                    <span className="iq-vfo__sum">{vfoSummary(vfo)}</span>
                </button>
                <Segmented
                    className="iq-vfo__pan"
                    options={PANS}
                    value={vfo.pan}
                    onChange={(pan) => set({ pan })}
                    size="sm"
                />
                <button
                    type="button"
                    className={`iq-vfo__mute${vfo.muted ? ' is-muted' : ''}`}
                    aria-pressed={vfo.muted}
                    title={vfo.muted ? 'Muted — press to hear it again' : 'Mute this demodulator'}
                    onClick={() => set({ muted: !vfo.muted })}
                >
                    {vfo.muted ? <Icon.Mute /> : <Icon.Volume />}
                </button>
            </div>

            {/* The row's own underline. All four are readable at once, which is
                the question you ask of a demodulator you are not editing: is
                anything on it. */}
            <div className="iq-vfo__level">
                <i style={{ width: `${Math.min(100, level * 400)}%` }} />
            </div>

            {open && (
                <div className="iq-vfo__body">
                    <Field label="Offset in stream" hint={offsetLabel(vfo.offsetHz)}>
                        <Slider
                            value={vfo.offsetHz}
                            min={Math.round(limits.min)}
                            max={Math.round(limits.max)}
                            step={10}
                            onChange={(offsetHz) => set({ offsetHz })}
                        />
                    </Field>

                    <Field label="Demodulator">
                        <Segmented
                            options={MODE_OPTIONS}
                            value={vfo.mode}
                            onChange={(m) => set({ mode: m })}
                            size="sm"
                            columns={5}
                        />
                    </Field>

                    <Field
                        label="Bandwidth"
                        hint={`${formatSpan(width)} · ${offsetLabel(band.lo)} to ${offsetLabel(band.hi)}`}
                    >
                        <Segmented
                            options={mode.widths.map((w) => ({ value: w, label: widthLabel(w) }))}
                            value={width}
                            onChange={(w) => set({ widths: { [vfo.mode]: w } })}
                            size="sm"
                            columns={mode.widths.length}
                        />
                    </Field>
                    <Slider
                        value={width}
                        min={mode.min}
                        max={mode.max}
                        step={widthStep}
                        onChange={(w) => set({ widths: { [vfo.mode]: w } })}
                    />

                    {vfo.mode === 'cw' && (
                        <Field label="CW pitch" hint={`${vfo.pitchHz} Hz`}>
                            <Slider
                                value={vfo.pitchHz}
                                min={PITCH_MIN}
                                max={PITCH_MAX}
                                step={10}
                                onChange={(pitchHz) => set({ pitchHz })}
                            />
                        </Field>
                    )}

                    <div className="readout-grid">
                        <Readout label="Listening" value={formatFreqExact(dialHz + vfo.offsetHz)} />
                        <Readout label="Filter" value={taps} unit="taps" />
                    </div>

                    {!minimal && (
                        <>
                            <Switch
                                checked={vfo.agc}
                                onChange={(agc) => set({ agc })}
                                label="Automatic gain"
                                title="Levels this demodulator. Without it the gain below is the only control."
                            />
                            <Field label="Gain" hint={`${vfo.gain.toFixed(2)}×`}>
                                <Slider
                                    value={vfo.gain}
                                    min={0}
                                    max={4}
                                    step={0.05}
                                    onChange={(gain) => set({ gain })}
                                />
                            </Field>
                            {canRemove && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    icon={<Icon.Trash />}
                                    onClick={() => removeVfo(index)}
                                >
                                    Remove demodulator
                                </Button>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * `minimal` keeps what you operate — the picture, the rows, and for the open one
 * where it is listening and how wide — and drops what you set once: the gain,
 * the AGC and the prose. See the registry's `minimal`.
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
    const { vfos, active } = s;
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
                        : hearing ? `Demodulating ${vfos.length > 1 ? `${vfos.length} signals ` : ''}in the browser.`
                            : 'Waiting for the quadrature stream…'}
                </span>
            </div>

            {/* The picture first: it is the map every row below is a legend for,
                and the control the offsets are actually set with. */}
            <IQScope
                player={player}
                live={live}
                iq={iq}
                running={on}
                vfos={vfos}
                active={active}
                onOffset={(index, offsetHz) => updateVfo(index, { offsetHz })}
                onPick={selectVfo}
                maxFps={maxFps}
                marks={marks}
            />

            <div className="iq-vfos">
                {vfos.map((vfo, i) => (
                    <VfoRow
                        key={i}
                        index={i}
                        vfo={vfo}
                        open={i === active}
                        level={hearing ? demod.levelOf(i) : 0}
                        taps={tapsFor(planForVfo(vfo).cutoffHz, demod.rate || 12000)}
                        dialHz={tuning.frequency}
                        minimal={minimal}
                        canRemove={vfos.length > 1}
                    />
                ))}
                {vfos.length < MAX_VFOS && (
                    <Button
                        className="iq-add"
                        size="sm"
                        variant="ghost"
                        icon={<Icon.Plus />}
                        onClick={() => addVfo()}
                    >
                        Add demodulator
                    </Button>
                )}
            </div>

            {!minimal && (
                <div className="note note--tight">
                    Experimental. The receiver sends 12 kHz of raw baseband and this
                    demodulates it here, so each demodulator picks any point inside
                    that span without retuning &mdash; but IQ costs the receiver&rsquo;s
                    owner about six times the bandwidth of Opus, and in IQ the noise
                    blanker, noise reduction and audio filters are all bypassed. The
                    bandwidths above are the only filtering there is.
                </div>
            )}
        </div>
    );
}
