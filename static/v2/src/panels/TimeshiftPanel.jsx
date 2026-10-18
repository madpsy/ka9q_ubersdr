// Timeshift — rewind the last thirty seconds of audio and spectrum, and play
// on from there until Live.
//
// The machinery is lib/timeshift.js and lives outside React, so a collapsed
// panel neither loses the history nor ends a replay; TimeshiftWatch keeps it
// running and sends it back to live on a retune. This file is the transport
// and the scrub bar over that object, and nothing more.

import React, { useEffect, useRef } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Icon } from '../components/ui.jsx';
import { TIMESHIFT_SEC } from '../lib/timeshift.js';
import useTimeshift, { formatBehind, tuningNote } from '../lib/useTimeshift.js';

const SPAN_MS = TIMESHIFT_SEC * 1000;
const SKIP_MS = 10000;
// One column of the level trace per quarter second.
const BUCKETS = TIMESHIFT_SEC * 4;

// The audio level along the scrub bar, so the start of an over is something
// you can see and aim for rather than hunt for by ear.
function drawScrub(canvas, ts) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const g = canvas.getContext('2d');
    const css = getComputedStyle(canvas);
    const colour = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    g.clearRect(0, 0, w, h);

    // What is not held yet, at the left: the first thirty seconds after the
    // receiver starts, or after the panel is brought back.
    const heldFrom = (1 - ts.availableMs / SPAN_MS) * w;
    g.fillStyle = colour('--surface-3', '#223');
    g.fillRect(0, 0, heldFrom, h);

    const levels = ts.levels(BUCKETS);
    const col = w / BUCKETS;
    g.fillStyle = colour('--accent', '#4af');
    g.globalAlpha = 0.55;
    for (let k = 0; k < BUCKETS; k++) {
        const v = levels[k];
        if (v < 0) continue;
        // -60..0 dBFS, as the VU meters read.
        const db = v > 0 ? 20 * Math.log10(v) : -60;
        const frac = Math.max(0.04, Math.min(1, (db + 60) / 60));
        const bh = frac * h;
        g.fillRect(k * col, (h - bh) / 2, Math.max(1, col - dpr), bh);
    }
    g.globalAlpha = 1;

    // The playhead. At the right edge while live.
    const x = Math.round((1 - ts.behindMs / SPAN_MS) * w);
    g.fillStyle = ts.replaying ? colour('--warn', '#fb4') : colour('--good', '#4d9');
    g.fillRect(Math.min(w - 2 * dpr, Math.max(0, x - dpr)), 0, 2 * dpr, h);
}

export default function TimeshiftPanel({ minimal }) {
    const { running, tuning } = useRadio();
    const ts = useTimeshift(8);
    const canvasRef = useRef(null);
    const dragging = useRef(false);

    useEffect(() => {
        if (canvasRef.current) drawScrub(canvasRef.current, ts);
    });

    const behind = ts.behindMs;
    const held = ts.availableMs;
    const live = !ts.replaying;
    const then = tuningNote(ts.replayTuning, tuning);

    // Where on the bar a pointer is, as a distance behind live. The bar is
    // always the full thirty seconds, so a given point means the same moment
    // whether or not the history has filled up to it yet.
    const behindAt = (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
        return (1 - frac) * SPAN_MS;
    };
    const onDown = (e) => {
        if (!held) return;
        dragging.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        ts.seekBehind(behindAt(e));
    };
    const onMove = (e) => {
        if (dragging.current) ts.seekBehind(behindAt(e));
    };
    const onUp = () => { dragging.current = false; };

    const status = live ? 'live' : ts.paused ? 'paused' : 'replay';
    const badge = { live: 'badge--open', paused: 'badge--idle', replay: 'badge--warn' }[status];

    return (
        <div className="stack">
            <div className="rec-status">
                <span className={`badge ${badge}`}>
                    {{ live: 'LIVE', paused: 'PAUSED', replay: 'REPLAY' }[status]}
                </span>
                {/* Compact, this line is the clock: how far behind, or how
                    much is held while live. */}
                <span className={`rec-status__hint${minimal && !live ? ' is-behind' : ''}`}>
                    {minimal && !live
                        ? `${formatBehind(behind)} behind live`
                        : held >= SPAN_MS - 500
                            ? `${TIMESHIFT_SEC} s held`
                            : `${Math.floor(held / 1000)} of ${TIMESHIFT_SEC} s held`}
                </span>
            </div>

            {/* Where the moment playing was tuned, when it is not where the
                dial is now. Nothing is retuned: the dial is the receiver, and
                this is the history. */}
            {then && (
                <div className="tshift-then" title="What the receiver was tuned to at the moment playing">
                    Tuned to <strong>{then}</strong> then
                </div>
            )}

            {!minimal && (
                <div className={`rec-time${live ? '' : ' is-behind'}`}>
                    {live ? 'Live' : formatBehind(behind)}
                </div>
            )}

            <div
                className="tshift-scrub"
                role="slider"
                aria-label="Position in the timeshift buffer"
                aria-valuemin={-TIMESHIFT_SEC}
                aria-valuemax={0}
                aria-valuenow={-Math.round(behind / 1000)}
                tabIndex={0}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') { ts.skip(-5000); e.preventDefault(); }
                    else if (e.key === 'ArrowRight') { ts.skip(5000); e.preventDefault(); }
                }}
                title="Click or drag to play from that moment"
            >
                <canvas ref={canvasRef} className="tshift-scrub__canvas" />
                {!minimal && (
                    <div className="tshift-scrub__ticks" aria-hidden="true">
                        <span>{`−${TIMESHIFT_SEC} s`}</span>
                        <span>{`−${TIMESHIFT_SEC / 2} s`}</span>
                        <span>now</span>
                    </div>
                )}
            </div>

            <div className="tshift-transport">
                <Button
                    size="sm"
                    icon={<Icon.ToStart />}
                    disabled={!held}
                    title="Back to the oldest moment held"
                    aria-label="Back to the start of the buffer"
                    onClick={() => ts.toStart()}
                />
                <Button
                    size="sm"
                    icon={<Icon.Rewind />}
                    disabled={!held}
                    title="Back 10 seconds"
                    onClick={() => ts.skip(-SKIP_MS)}
                >
                    10
                </Button>
                <Button
                    size="sm"
                    icon={ts.paused ? <Icon.Play /> : <Icon.Pause />}
                    disabled={!held || !running}
                    title={ts.paused ? 'Play on from here' : 'Pause — the receiver keeps recording behind you'}
                    aria-label={ts.paused ? 'Play' : 'Pause'}
                    onClick={() => ts.toggle()}
                />
                <Button
                    size="sm"
                    icon={<Icon.Forward />}
                    disabled={live}
                    title="Forward 10 seconds — past the end is live"
                    onClick={() => ts.skip(SKIP_MS)}
                >
                    10
                </Button>
                <Button
                    size="sm"
                    variant={live ? 'default' : 'primary'}
                    disabled={live}
                    title="Back to live"
                    onClick={() => ts.goLive()}
                >
                    Live
                </Button>
            </div>

            {!running && (
                <div className="note note--tight">Start the receiver to fill the buffer.</div>
            )}

            {!minimal && (
                <div className="note note--tight">
                    Keeps the last {TIMESHIFT_SEC} seconds of the audio and the spectrum, and plays
                    them back together from any point. Filters, noise reduction and volume apply
                    to the replay. The S-meter, squelch and decoders stay live. Tuning goes back
                    to live; where the history was tuned elsewhere it is named here and outlined
                    on the spectrum.
                </div>
            )}
        </div>
    );
}

// The header's reminder that what you are hearing is not now.
export function TimeshiftBadge() {
    const ts = useTimeshift(5, false);
    if (!ts.replaying) return null;
    return <span className="badge badge--warn">{formatBehind(ts.behindMs)}</span>;
}
