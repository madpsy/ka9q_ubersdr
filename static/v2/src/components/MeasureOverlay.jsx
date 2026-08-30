// The measurement, drawn over the spectrum.
//
// DOM and not canvas, deliberately. Everything here is text or a rule between
// two frequencies, both of which the browser lays out better than a canvas
// does, and none of it is per-frame work: the region moves when somebody drags
// it and the derived edges move five times a second, which is nothing. Putting
// it on the canvas would mean threading a dozen values into the draw loop and
// re-implementing text measurement to place the labels — for a layer that is
// static most of the time it is on screen.
//
// It sits inside the canvas box and takes no pointer events, so the gesture
// underneath is untouched. The one exception is the badge along the bottom,
// which has buttons on it and says so.
//
// ── Where things are put ─────────────────────────────────────────────────────
//
// The region itself is drawn where it is: a wash across both panes with an edge
// line either side, so it reads as a column of the display rather than as a box
// floating over it. Everything *derived* — the x-dB callipers, the occupied
// bandwidth, the badge — is stacked along the bottom instead, in one block.
//
// That grouping is the whole layout decision. The alternative, a vertical
// hairline per measured edge, is ten lines down the picture at the default
// settings and turns the waterfall into a cage. Callipers say the same thing
// horizontally — this wide, at this level — which is also how a bench analyser
// draws it and how anybody reading it already thinks about it. Along the bottom
// because that end of the waterfall is the oldest history and the least
// informative part of the display, and because keeping every part of the tool
// in one strip means the rest of the screen still reads as the receiver.

import React, { useEffect, useState } from '../react.js';
import { Icon } from './ui.jsx';
import { formatFreqExact, formatSpan } from '../lib/format.js';
import { useMeasureResult, useMeasureState } from '../lib/useMeasure.js';
import { setMeasureFrozen, stopMeasure } from '../lib/measureTool.js';
import { onSpectrumPaused, spectrumPaused } from '../lib/spectrumPause.js';

// Height of one calliper row, in CSS px. Enough for a 10 px label and the rule
// under it without the stack becoming a wall of text at three levels plus the
// occupied bandwidth.
const ROW_H = 15;

// How much room the badge needs above the bottom of the box, in CSS px, so the
// calliper stack starts clear of it. Only reserved while the badge is there:
// stopped, the callipers move down into the space it was using, which is also
// what says the tool is no longer running.
const HUD_H = 30;

/** Where a frequency sits across the view, 0..1, or null with no view. */
function fracOf(hz, view) {
    if (!view || !(view.span > 0)) return null;
    return (hz - (view.centerFreq - view.span / 2)) / view.span;
}

const pct = (f) => `${(f * 100).toFixed(4)}%`;

/**
 * A span across the view as CSS, clipped to it, or null when none of it shows.
 *
 * Clipped rather than allowed to overflow: the box has other things in it, and
 * a rule running off the side of the spectrum and under the dock is not a
 * measurement anybody can read.
 */
function spanStyle(loHz, hiHz, view) {
    const a = fracOf(loHz, view);
    const b = fracOf(hiHz, view);
    if (a == null || b == null) return null;
    const lo = Math.max(0, Math.min(1, a));
    const hi = Math.max(0, Math.min(1, b));
    if (!(hi > lo)) return null;
    return { left: pct(lo), width: pct(hi - lo), clippedLeft: a < 0, clippedRight: b > 1 };
}

/** One horizontal calliper: a rule between two frequencies, with a label on it. */
function Calliper({ loHz, hiHz, view, kind, label }) {
    const s = spanStyle(loHz, hiHz, view);
    if (!s) return null;
    return (
        <div className={`measure-cal measure-cal--${kind}`} style={{ left: s.left, width: s.width }}>
            <span className="measure-cal__label">{label}</span>
        </div>
    );
}

/**
 * @param view    the spectrum's own view state — the overlay places everything
 *                against the same centre and span the trace is drawn from.
 * @param bottom  how far to clear the bottom of the canvas box, in CSS px. The
 *                ruler under the waterfall is a different height in each view
 *                mode, and the caller is the only one that knows which.
 */
export default function MeasureOverlay({ view, bottom = 0 }) {
    const { active, selection, drawing, frozen } = useMeasureState();
    const result = useMeasureResult();
    // A paused spectrum sends no frames, so the reading simply stops. The badge
    // has to say so: a pulsing "Measuring" over a display that has stopped
    // arriving is the one thing here that would be a lie.
    const [paused, setPaused] = useState(spectrumPaused);
    useEffect(() => onSpectrumPaused(setPaused), []);
    const live = !paused && !frozen;

    if (!active && !selection) return null;

    const band = selection && spanStyle(selection.loHz, selection.hiHz, view);
    const stats = result && result.stats;
    // Only the ones there is something to draw. The reading keeps a place for
    // every level asked for, so the panel's rows hold still (see measure.js);
    // a calliper with no width is not a mark, it is nothing.
    const widths = ((result && result.widths) || []).filter((w) => w.widthHz != null);
    const obw = result && result.obw;

    // The stack grows upward from the badge. Counted rather than laid out with
    // flexbox because each row is absolutely positioned inside the box — a
    // calliper's left and width are frequencies, not content.
    const rows = widths.length + (obw ? 1 : 0);
    const stackBase = bottom + (active ? HUD_H : 2);

    return (
        <>
            <div className="measure" aria-hidden="true">
                {band && (
                    <>
                        <div
                            className={`measure__band${drawing ? ' measure__band--drawing' : ''}${active ? '' : ' measure__band--held'}`}
                            style={{ left: band.left, width: band.width }}
                        />
                        {/* The edges are separate from the wash so that a region
                            running off the side of the view loses its edge line
                            and not just the fill — which is what says "this
                            carries on past here". */}
                        {!band.clippedLeft && <div className="measure__edge" style={{ left: band.left }} />}
                        {!band.clippedRight && (
                            <div
                                className="measure__edge"
                                style={{ left: pct(Math.min(1, fracOf(selection.hiHz, view))) }}
                            />
                        )}
                    </>
                )}
                {/* Where the energy is, as against where the region is. The peak
                    is the loudest bin and the centroid is the middle of what is
                    above the floor; on a clean carrier they are the same line
                    and on a wide or lopsided signal they are not, which is the
                    whole reason both are drawn. */}
                {stats && fracOf(stats.peakHz, view) != null && (
                    <div
                        className="measure__peak"
                        style={{ left: pct(Math.max(0, Math.min(1, fracOf(stats.peakHz, view)))) }}
                    />
                )}
                {stats && stats.centroidHz != null && (
                    <div
                        className="measure__centroid"
                        style={{ left: pct(Math.max(0, Math.min(1, fracOf(stats.centroidHz, view)))) }}
                    />
                )}

                <div className="measure__stack" style={{ bottom: stackBase, height: rows * ROW_H }}>
                    {widths.map((w, i) => (
                        <div key={w.downDb} className="measure__row" style={{ top: i * ROW_H }}>
                            <Calliper
                                loHz={w.loHz}
                                hiHz={w.hiHz}
                                view={view}
                                kind="width"
                                // The bound, not the value, when the skirt ran
                                // out of region: a ">" is the difference between
                                // a measurement and a guess.
                                label={`−${w.downDb} dB ${w.clipped ? '>' : ''}${formatSpan(w.widthHz)}`}
                            />
                        </div>
                    ))}
                    {obw && (
                        <div className="measure__row" style={{ top: widths.length * ROW_H }}>
                            <Calliper
                                loHz={obw.loHz}
                                hiHz={obw.hiHz}
                                view={view}
                                kind="obw"
                                label={`${obw.percent}% ${formatSpan(obw.widthHz)}`}
                            />
                        </div>
                    )}
                </div>
            </div>

            {/* The badge. The one interactive thing in here, and the reason it
                exists at all: with the tool running a click on the spectrum does
                not tune, and an operator who left it on an hour ago needs
                somewhere on the display itself that says so and turns it off. It
                is also the whole readout on a phone, where the panel is in a
                sheet over the picture being measured. */}
            {active && (
                <div
                    className="measure-hud"
                    style={{ bottom }}
                    // The badge sits inside the box whose presses the tool has
                    // taken, so its own presses have to be stopped here or
                    // pressing Stop would first draw a region under it.
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerMove={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.stopPropagation()}
                >
                    <span className={`measure-hud__dot${live ? '' : ' measure-hud__dot--held'}`} />
                    <span className="measure-hud__title">
                        {paused ? 'Paused' : (frozen ? 'Held' : 'Measuring')}
                    </span>
                    {!selection && <span className="measure-hud__hint">drag across the spectrum</span>}
                    {selection && stats && (
                        <>
                            <span className="measure-hud__num">{formatSpan(stats.widthHz)}</span>
                            <span className="measure-hud__num">{stats.snrDb.toFixed(1)} dB SNR</span>
                            <span className="measure-hud__num measure-hud__num--dim">
                                {formatFreqExact(stats.peakHz)}
                            </span>
                        </>
                    )}
                    {selection && !stats && (
                        <span className="measure-hud__hint">{whyNot(result)}</span>
                    )}
                    <button
                        type="button"
                        className="measure-hud__btn"
                        title={frozen
                            ? 'Let the reading follow the band again'
                            : 'Hold the reading still so it can be read — the run stops counting while it is held'}
                        onClick={() => setMeasureFrozen(!frozen)}
                    >
                        {frozen ? <Icon.Play size={12} /> : <Icon.Pause size={12} />}
                    </button>
                    <button
                        type="button"
                        className="measure-hud__btn measure-hud__btn--stop"
                        title="Stop measuring — the region and its reading are cleared, and clicks on the spectrum go back to tuning"
                        onClick={stopMeasure}
                    >
                        <Icon.Stop size={12} />
                    </button>
                </div>
            )}
        </>
    );
}

/**
 * Why there is no reading — three situations that all look like an empty panel
 * and each of which has a different thing to do about it.
 */
function whyNot(result) {
    if (!result) return 'waiting for the spectrum';
    if (result.reason === 'outside') return 'the region is off this view — pan back to it';
    if (result.reason === 'narrow') return 'too few bins at this zoom — zoom in';
    return 'waiting for the spectrum';
}
