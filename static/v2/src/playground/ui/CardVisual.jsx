// What a block's card draws of what it is doing: a meter's bar, a squelch's
// state, a tracker's lock, a recorder's clock — and, through viewers.jsx, the
// instruments' pictures.
//
// Each one listens to the engine itself rather than being handed readings by
// the canvas. Readings arrive a dozen times a second; re-rendering every card
// and wire on the canvas that often to move one bar would be the editor's whole
// CPU budget, so only the visual that changed draws again.

import React, { useEffect, useReducer, useRef, useState } from '../../react.js';
import { INSTRUMENTS, Instrument } from './viewers.jsx';
import { parseChoices } from '../blocks/controls.js';
import { WAVEFORMS } from '../blocks/sources.js';
import { cssVar, sizedCanvas } from '../../lib/audioWaterfall.js';
import { airSpan, rfLabel, rfOf, shiftLabel, sourceZero } from '../probes.js';
import { hasLevelLine, visualHeight } from '../geometry.js';
import { eqResponse, eqSections } from '../blocks/eq.js';

const FLOOR_DB = -80;

/** A level in dB as a share of the bar. */
const share = (db, floor = FLOOR_DB) => (db == null || !Number.isFinite(db) ? 0 : Math.max(0, Math.min(1, (db - floor) / -floor)));

function useReadings(pg, id) {
    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => pg.on('readings', bump), [pg]);
    return pg.readings ? pg.readings[id] : null;
}

function Bar({ db, label, tag = '', off = false }) {
    const said = db == null ? '—' : db <= -199 ? 'silent' : `${Math.round(db)} dB`;
    const text = `${tag ? `${tag} ` : ''}${said}`;
    const pct = share(db) * 100;
    // The words twice: as they are over the empty track, and dark, clipped to
    // the filled part — so whichever the bar has under it, they can be read.
    return (
        <div className={`pg-vis__bar${off ? ' is-off' : ''}`} title={label}>
            <i style={{ width: `${pct}%` }} />
            <span>{text}</span>
            <span className="pg-vis__bar-on" aria-hidden="true" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>{text}</span>
        </div>
    );
}

/**
 * One block's level, in and out, from the engine's `levels` — dBFS, null for
 * a side it does not have or before anything has arrived. Re-renders with the
 * readings, and only the part that shows it.
 */
export function useLevel(pg, id) {
    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => pg.on('readings', bump), [pg]);
    return (pg.levels && pg.levels[id]) || { in: null, out: null, act: 0 };
}

/**
 * What Audio out sends each ear: its one input, to the left, the right or
 * both, and to neither while muted. For its card's bars and its readouts.
 */
export function earLevels(node, level) {
    const p = node.params || {};
    const db = level ? level.in : null;
    const to = (side) => (p.muted || db == null ? null : p.channel === 'both' || p.channel === side ? db : -200);
    return { left: to('left'), right: to('right'), muted: !!p.muted };
}

function EarBars({ pg, node }) {
    const ears = earLevels(node, useLevel(pg, node.id));
    const why = ears.muted ? ' — muted' : '';
    return (
        <div className="pg-vis__ears">
            <Bar db={ears.left} tag="L" off={ears.muted} label={`To the left ear${why}`} />
            <Bar db={ears.right} tag="R" off={ears.muted} label={`To the right ear${why}`} />
        </div>
    );
}

/** A level for reading: whole dB, 'silent', or a dash for none yet. */
export function dbWords(db) {
    return db == null ? '—' : db <= -199 ? 'silent' : `${Math.round(db)}`;
}

/** How much a block changes the level, in dB, where both sides have one. */
export function levelChange(lv) {
    if (!lv || lv.in == null || lv.out == null || lv.in <= -199 || lv.out <= -199) return null;
    return lv.out - lv.in;
}

const signed = (d) => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`;

/**
 * The picture for a block with none of its own: its level in and out, and
 * what it changed — the cut a noise reducer or a filter makes, the gain an
 * AGC is giving.
 */
function InOut({ pg, id }) {
    const lv = useLevel(pg, id);
    const d = levelChange(lv);
    let text;
    if (lv.in != null && lv.out != null) text = `${dbWords(lv.in)} → ${dbWords(lv.out)} dB${d == null ? '' : ` (${signed(d)})`}`;
    else if (lv.out != null) text = `out ${dbWords(lv.out)} dB`;
    else if (lv.in != null) text = `in ${dbWords(lv.in)} dB`;
    else text = '—';
    return <div className="pg-vis__state pg-vis__inout" title="Level in → level out, dBFS, and the change">{text}</div>;
}

// How long the clip pill stays lit after the last clipped sample: long
// enough that one overload is seen, not just one that lasts.
export const CLIP_HOLD_MS = 1500;

/**
 * Whether a block has audio in or out: something that can clip. Not a key
 * level, a power or a soft decision — real streams that are not sound, and
 * sit at 1 by design (their ports say `audio: false`).
 */
export function canClip(def) {
    return !!def && [...def.inputs, ...def.outputs].some((p) => p.kind === 'real' && p.audio !== false);
}

/**
 * CLIP, in red, while the block's audio is over full scale and for a moment
 * after — nothing at all otherwise. `now` is for the test.
 */
export function ClipPill({ pg, id, now = () => Date.now() }) {
    const lv = useLevel(pg, id);
    const last = useRef(-Infinity);
    const [, bump] = useReducer((n) => n + 1, 0);
    const t = now();
    if (lv.clip > 0) last.current = t;
    const lit = t - last.current < CLIP_HOLD_MS;
    // Put out on time even if no more readings come — a graph stopped while
    // it was clipping.
    useEffect(() => {
        if (!lit) return undefined;
        const timer = setTimeout(bump, CLIP_HOLD_MS - (t - last.current) + 20);
        return () => clearTimeout(timer);
    });
    if (!lit) return null;
    return (
        <span className="pg-clip" title={`Over full scale: clips at the speakers or in a file${lv.peak != null ? ` · peak ${lv.peak >= 0 ? '+' : ''}${lv.peak.toFixed(1)} dBFS` : ''}`}>
            CLIP
        </span>
    );
}

/**
 * Whether a block's card has an activity dot, and what it means: lit while
 * text or messages arrive — a character at a time for text — or, for a type
 * that says what its activity is (a Morse decoder: the key going down),
 * that. Null for no dot.
 */
export function activityMeaning(def) {
    if (!def) return null;
    if (def.activity) return def.activity;
    return def.inputs.some((p) => p.kind === 'message') ? 'Receiving' : null;
}

/** The dot itself: lit while there was activity since the last readings. */
export function ActivityDot({ pg, id, meaning }) {
    const lv = useLevel(pg, id);
    const on = lv.act > 0;
    return <i className={`pg-act${on ? ' is-on' : ''}`} title={on ? meaning : `${meaning}: not just now`} aria-hidden="true" />;
}

/**
 * A hairline along the foot of a card, as long as the block's level: enough
 * to see at a glance that something is going through. The output's level, or
 * the input's for a block with no output of samples.
 */
export function LevelStrip({ pg, id }) {
    const lv = useLevel(pg, id);
    const db = lv.out != null ? lv.out : lv.in;
    const which = lv.out != null ? 'Out' : 'In';
    return (
        <i
            className="pg-card__level"
            style={{ width: `${share(db) * 100}%` }}
            title={db == null ? 'Nothing through it yet' : `${which}: ${db <= -199 ? 'silent' : `${db.toFixed(1)} dBFS`}`}
        />
    );
}

function clock(sec) {
    const s = Math.floor(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What a recording is called after: an IQ recording, the frequency it is of. */
export function recordingLabel(type, zeroHz) {
    if (type !== 'iq-recorder') return '';
    return zeroHz > 0 ? `iq-${Math.round(zeroHz)}Hz` : 'iq';
}

function Recorder({ pg, id, label }) {
    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => {
        const offs = [pg.on('change', bump)];
        // The clock moves while recording, and nothing else says so.
        const t = setInterval(() => {
            const r = pg.recordings.get(id);
            if (r && r.state === 'recording') bump();
        }, 500);
        return () => { offs.forEach((f) => f()); clearInterval(t); };
    }, [pg, id]);
    const rec = pg.recordings.get(id);
    const state = rec ? rec.state : 'idle';
    const on = state === 'recording';
    return (
        <div className="pg-vis__rec">
            <button
                type="button"
                className={`pg-vis__rec-btn${on ? ' is-on' : ''}`}
                disabled={!pg.running}
                title={on ? 'Stop recording' : pg.running ? 'Record' : 'Start the playground to record'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => (on ? pg.stopRecording(id) : pg.startRecording(id, label))}
            >
                {on ? '■' : '●'}
            </button>
            <span>
                {state === 'idle' ? 'Ready'
                    : `${clock(rec.seconds)} / ${clock(rec.limitSeconds)}${state === 'held' ? ' · held' : ''}`}
            </span>
        </div>
    );
}

/**
 * The visual for one node, or nothing for a type that has none. `look` is the
 * page's palette and dial, and `origin` where a complex input's zero is on the
 * air (probes.js) — both for the instruments. `rate` is the block's own, for
 * the sources to say how much of the air they cover.
 */
/**
 * `grow` is how much taller than natural the card has been made: the room
 * its picture has to fill (geometry.js cardGrow).
 */
export default function CardVisual({ pg, node, look, origin, rate, onParams, large = false, grow = 0 }) {
    if (INSTRUMENTS.has(node.type)) return <Instrument pg={pg} node={node} look={look} origin={origin} large={large} grow={grow} />;
    if (KNOBS.has(node.type)) return <Knob node={node} onParams={onParams} />;
    if (node.type === 'iq-in') return <Coverage zeroHz={sourceZero(node, look && look.dialHz)} rate={rate} />;
    return <SimpleVisual pg={pg} node={node} origin={origin} rate={rate} large={large} grow={grow} />;
}

// Cards whose picture the inspector shows some other way: knobs as its
// settings, recorders and the player with controls of their own, the
// stream with the receiver's.
// (KNOBS is declared further down, so it is read when asked, not here.)
const SHOWN_ELSEWHERE = new Set(['iq-in', 'wav-recorder', 'iq-recorder', 'iq-player']);

/**
 * Whether the inspector repeats a block's card picture, larger: any block
 * with a picture of its own that it does not already show another way. The
 * instruments have their own large views; the level line is the inspector's
 * level readouts.
 */
export function inspectorShowsPicture(node) {
    return !INSTRUMENTS.has(node.type) && !SHOWN_ELSEWHERE.has(node.type) && !KNOBS.has(node.type)
        && !hasLevelLine(node.type) && visualHeight(node.type, node.params) > 0;
}

/**
 * Where on the air a block is working, and its offset from the source's
 * centre — on every card along a chain, so the frequency can be followed
 * from the stream to the decoder. Most never move while running and are
 * worked out once; one that a control drives, or an auto-tuning decoder,
 * follows the engine's readings.
 */
export function RfLine({ pg, graph, node, dialHz, origins }) {
    const still = rfOf(graph, node, dialHz, origins);
    const [, bump] = useReducer((n) => n + 1, 0);
    const live = !!(still && still.live);
    useEffect(() => (live ? pg.on('readings', bump) : undefined), [pg, live]);
    const info = live && pg.running
        ? rfOf(graph, node, dialHz, origins, { driven: pg.driven, reading: pg.readings ? pg.readings[node.id] : null })
        : still;
    if (!info) return null;
    const what = info.listening ? 'Listening at' : 'The zero of this block’s output is';
    return (
        <div
            className={`pg-card__rf${info.hz == null ? ' is-unknown' : ''}`}
            title={info.hz == null
                ? 'Not a frequency on the air here: after a generator, a mirror or a mix, or a control not yet heard from.'
                : `${what} ${rfLabel(info.hz)}${info.shiftHz != null ? `, ${shiftLabel(info.shiftHz)} from the source’s centre` : ''}`}
        >
            <span className="pg-card__rf-hz">{info.hz == null ? 'RF —' : rfLabel(info.hz)}</span>
            {info.shiftHz != null && <span className="pg-card__rf-shift">{shiftLabel(info.shiftHz)}</span>}
        </div>
    );
}

/** The stretch of the air a source covers, and where its centre is. */
function Coverage({ zeroHz, rate, quiet = false }) {
    const c = airSpan(zeroHz, rate);
    if (!c) return quiet ? null : <div className="pg-vis__state">Not tuned</div>;
    return (
        <div className="pg-vis__cover" title={`Centred on ${c.centre}${c.width ? `, ${c.width}` : ''}`}>
            <div className="pg-vis__cover-range">{c.range}</div>
            <div className="pg-vis__state">{`centre ${c.centre}${c.width ? ` · ${c.width}` : ''}`}</div>
        </div>
    );
}

// ── controls, worked on the card ────────────────────────────────────────────

const KNOBS = new Set(['slider', 'number', 'toggle', 'dropdown']);

/** Keep a press on a control from also picking the card up. */
const hold = (e) => e.stopPropagation();

/** A number formatted to as many places as a step needs. */
function stepped(v, step) {
    const places = step > 0 && step < 1 ? Math.min(6, Math.ceil(-Math.log10(step) - 1e-9)) : 0;
    return Number(v).toFixed(places);
}

function NumberKnob({ value, onCommit }) {
    const [draft, setDraft] = useState(null);
    const commit = () => {
        if (draft === null) return;
        const v = Number(draft);
        setDraft(null);
        if (draft.trim() !== '' && Number.isFinite(v)) onCommit(v);
    };
    return (
        <input
            className="input pg-knob__num"
            inputMode="decimal"
            value={draft === null ? String(value) : draft}
            onPointerDown={hold}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }}
        />
    );
}

function Knob({ node, onParams }) {
    const p = node.params;
    const set = (patch, key) => onParams && onParams(node.id, patch, `param:${node.id}:${key}`);
    switch (node.type) {
        case 'slider': {
            const lo = Math.min(p.min, p.max);
            const hi = Math.max(p.min, p.max);
            return (
                <div className="pg-knob">
                    <input
                        type="range"
                        className="pg-knob__range"
                        min={lo}
                        max={hi}
                        step={p.step > 0 ? p.step : 'any'}
                        value={Math.max(lo, Math.min(hi, p.value))}
                        onPointerDown={hold}
                        onChange={(e) => set({ value: Number(e.target.value) }, 'value')}
                    />
                    <span className="pg-knob__val">{stepped(p.value, p.step)}</span>
                </div>
            );
        }
        case 'number':
            return <div className="pg-knob"><NumberKnob value={p.value} onCommit={(v) => set({ value: v }, 'value')} /></div>;
        case 'toggle':
            return (
                <div className="pg-knob">
                    <button
                        type="button"
                        role="switch"
                        aria-checked={p.on}
                        className={`switch${p.on ? ' is-on' : ''}`}
                        onPointerDown={hold}
                        onClick={() => set({ on: !p.on }, 'on')}
                    >
                        <span className="switch__track"><span className="switch__thumb" /></span>
                        <span className="switch__label">{p.on ? 'On — 1' : 'Off — 0'}</span>
                    </button>
                </div>
            );
        case 'dropdown': {
            const list = parseChoices(p.choices);
            return (
                <div className="pg-knob">
                    <select
                        className="select pg-knob__select"
                        value={String(Math.min(list.length - 1, Math.max(0, Math.round(p.index))))}
                        onPointerDown={hold}
                        onChange={(e) => set({ index: Number(e.target.value) }, 'index')}
                    >
                        {list.map((v, i) => <option key={i} value={String(i)}>{v}</option>)}
                    </select>
                </div>
            );
        }
        default:
            return null;
    }
}

/**
 * A line of a history, newest at the right. Scaled to its own range, or from
 * zero with `fromZero` — for a rate, where a halving should look like one.
 */
export function Sparkline({ history, height = 44, fromZero = false }) {
    const ref = useRef(null);
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const { w, h, dpr } = sizedCanvas(canvas, height);
        const c = canvas.getContext('2d');
        if (!c) return;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.fillStyle = cssVar('--surface-3', '#1a2130');
        c.fillRect(0, 0, w, h);
        if (!history || history.length < 2) return;
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of history) { if (v < lo) lo = v; if (v > hi) hi = v; }
        if (fromZero) lo = Math.min(0, lo);
        const span = hi - lo || Math.abs(hi) || 1;
        c.beginPath();
        for (let k = 0; k < history.length; k++) {
            const x = (k / (history.length - 1)) * w;
            const y = h - 3 * dpr - ((history[k] - lo) / span) * (h - 6 * dpr);
            if (k === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.lineWidth = Math.max(1, 1.5 * dpr);
        c.strokeStyle = cssVar('--good', '#45d69a');
        c.stroke();
    });
    return <canvas ref={ref} className="pg-vis__spark" style={{ height: `${height}px` }} />;
}

function SimpleVisual({ pg, node, origin, rate, large = false, grow = 0 }) {
    const reading = useReadings(pg, node.id);
    switch (node.type) {
        case 'audio-out':
            return <EarBars pg={pg} node={node} />;
        case 'meter':
            return <Bar db={reading ? reading.db : null} label="RMS level" />;
        case 'level-detector':
            return <Bar db={reading ? reading.db : null} label="Smoothed power" />;
        case 'squelch': {
            const open = reading ? reading.open : null;
            return (
                <div className={`pg-vis__state${open === false ? ' is-shut' : open ? ' is-open' : ''}`}>
                    {open == null ? '—' : open ? 'Open' : 'Closed'}
                </div>
            );
        }
        case 'carrier-tracker': {
            const s = reading && reading.state;
            const words = { locked: 'Locked', hold: 'Holding', acquire: 'Locking', search: 'Searching' };
            // Which it is, first: SAM and ECSS chains are the same blocks, and
            // this is the one place they differ. Auto says which side it chose.
            const p = node.params;
            const side = { usb: 'USB', lsb: 'LSB', both: 'Both', auto: 'Auto' }[p.sideband] || p.sideband;
            const chosen = reading && reading.side ? String(reading.side).toUpperCase() : null;
            const how = p.mode === 'sam' ? 'SAM · both sidebands'
                : `ECSS · ${side}${p.sideband === 'auto' && chosen ? ` → ${chosen}` : ''}`;
            return (
                <div className="pg-vis__tracker">
                    <div className="pg-vis__state">{how}</div>
                    <div className={`pg-vis__state${s === 'locked' || s === 'hold' ? ' is-open' : ''}`}>
                        {s ? words[s] || s : '—'}
                        {reading && reading.carrierHz != null ? ` · ${reading.carrierHz.toFixed(1)} Hz` : ''}
                    </div>
                </div>
            );
        }
        case 'wav-recorder':
        case 'iq-recorder':
            return <Recorder pg={pg} id={node.id} label={recordingLabel(node.type, origin)} />;
        case 'demodulator': {
            const r = reading || {};
            const mode = String(node.params.mode || '').toUpperCase().replace('CWU', 'CW-U').replace('CWL', 'CW-L');
            const lock = r.ecss ? ({ locked: ' · locked', hold: ' · holding', acquire: ' · locking', search: ' · searching' })[r.ecss.state] || '' : '';
            return (
                <div className="pg-vis__demod">
                    <div className="pg-vis__state">{`${mode} ${node.params.widthHz || 0} Hz · ${node.params.offsetHz >= 0 ? '+' : ''}${node.params.offsetHz || 0} Hz${lock}`}</div>
                    <Bar db={r.sigDb == null || r.sigDb <= -159 ? null : r.sigDb} label="Signal in the passband" />
                </div>
            );
        }
        case 'costas-loop':
            return <div className="pg-vis__state">{reading ? `tracking ${reading.hz >= 0 ? '+' : ''}${reading.hz.toFixed(2)} Hz` : '—'}</div>;
        case 'morse-decoder':
            return <div className="pg-vis__state">{reading ? `${reading.wpm.toFixed(0)} wpm${reading.pattern ? ` · ${reading.pattern}` : ''}` : '—'}</div>;
        case 'uart':
            return <div className="pg-vis__state">{reading ? `${reading.chars} characters${reading.errors ? ` · ${reading.errors} framing errors` : ''}` : '—'}</div>;
        case 'sitor-decoder':
            return (
                <div className={`pg-vis__state${reading && reading.locked ? ' is-open' : ''}`}>
                    {reading ? (reading.locked ? `In step · ${reading.chars} characters` : 'Looking for the characters…') : '—'}
                </div>
            );
        case 'fsk-detector':
            return (
                <div className="pg-vis__state">
                    {reading && reading.markDb != null ? `mark ${reading.markDb.toFixed(0)} · space ${reading.spaceDb.toFixed(0)} dB` : '—'}
                </div>
            );
        case 'noise-blanker':
            return (
                <div className="pg-vis__state">
                    {!reading ? '—' : !reading.on ? 'Off'
                        : `${reading.pulses} ${reading.pulses === 1 ? 'pulse' : 'pulses'} · ${(reading.cut * 100).toFixed(1)}% cut · ${reading.reductionDb.toFixed(1)} dB`}
                </div>
            );
        case 'nr2':
            return <Nr2State pg={pg} id={node.id} reading={reading} />;
        case 'compressor':
            return <CompressorState reading={reading} />;
        case 'graphic-eq':
        case 'parametric-eq':
            return <EqCurve node={node} rate={rate} height={(large ? 140 : 56) + (large ? 0 : Math.max(0, grow))} />;
        case 'ook-detector':
            return <div className="pg-vis__state">{reading && reading.snrDb != null ? `${reading.snrDb.toFixed(0)} dB over the noise` : '—'}</div>;
        case 'rtty-decoder':
        case 'psk31-decoder':
        case 'cw-decoder':
        case 'navtex-decoder':
            return (
                <div className="pg-vis__state">
                    {!reading ? '—' : `${reading.chars} characters${reading.tunedHz != null ? ` · tuned ${reading.tunedHz >= 0 ? '+' : ''}${reading.tunedHz.toFixed(1)} Hz` : ''}`}
                </div>
            );
        case 'signal': {
            const p = node.params;
            const shape = (WAVEFORMS.find((w) => w.value === p.waveform) || WAVEFORMS[0]).label;
            const zero = sourceZero(node);
            const at = (hz) => (zero != null ? rfLabel(zero + hz) : shiftLabel(hz));
            return (
                <div className="pg-vis__player">
                    <div className="pg-vis__state">{`${shape} ${at(p.frequencyHz)}`}</div>
                    {p.tone2 && <div className="pg-vis__state">{`${shape} ${at(p.frequency2Hz)}`}</div>}
                </div>
            );
        }
        case 'data-tx': {
            const p = node.params;
            const r = reading || {};
            const how = {
                cw: `CW ${p.wpm} wpm`,
                rtty: `RTTY ${p.baud} Bd ${p.shiftHz} Hz`,
                psk: `PSK${Math.round(p.pskBaud)}`,
                navtex: 'NAVTEX',
            }[p.mode] || '';
            const zero = sourceZero(node);
            const at = zero != null ? rfLabel(zero + p.offsetHz) : shiftLabel(p.offsetHz);
            return (
                <div className="pg-vis__player">
                    <div className="pg-vis__state">{`${how} · ${at}${p.noise ? ` · SNR ${p.snrDb} dB` : ''}`}</div>
                    <div className="pg-counter__gate"><i style={{ width: `${Math.round((r.progress || 0) * 100)}%` }} /></div>
                </div>
            );
        }
        case 'iq-player': {
            const r = reading || {};
            const has = pg.hasFile ? pg.hasFile(node.id) : false;
            const pos = r.duration ? r.position / r.duration : 0;
            return (
                <div className="pg-vis__player">
                    <div className="pg-vis__state" title={node.params.fileName || undefined}>
                        {has ? (node.params.fileName || 'Loaded') : node.params.fileName ? `Load ${node.params.fileName} again` : 'No file — load one in the inspector'}
                    </div>
                    <div className="pg-counter__gate"><i style={{ width: `${Math.round(pos * 100)}%` }} /></div>
                    <Coverage zeroHz={sourceZero(node)} rate={rate} quiet />
                </div>
            );
        }
        case 'control-scale':
        case 'integrator':
            return (
                <div className="pg-vis__state pg-vis__value">
                    {reading && reading.value != null ? Number(reading.value.toPrecision(7)) : '—'}
                    {node.type === 'integrator' && (
                        <button
                            type="button"
                            className="pg-vis__mini"
                            title="Back to the start value"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => pg.command(node.id, 'reset')}
                        >
                            reset
                        </button>
                    )}
                </div>
            );
        case 'control-plot':
            return (
                <div className="pg-vis__plot">
                    <div className="pg-vis__state pg-vis__value">{reading && reading.value != null ? Number(reading.value.toPrecision(7)) : '—'}</div>
                    <Sparkline history={reading && reading.history} height={large ? 140 : 44 + Math.max(0, grow)} />
                </div>
            );
        default:
            return hasLevelLine(node.type) ? <InOut pg={pg} id={node.id} /> : null;
    }
}

// The EQ curve's scale: ±this many dB, from this frequency up.
const EQ_SPAN_DB = 15;
const EQ_LOW_HZ = 30;

/**
 * An EQ's response, drawn: dB against frequency on a log scale, from 30 Hz to
 * the top of the audio, with the 0 dB line — and for the parametric EQ a dot
 * at each band it is using. Computed from the settings, so it is right before
 * any audio has run.
 */
export function EqCurve({ node, rate, height = 56 }) {
    const ref = useRef(null);
    const r = rate > 0 ? rate : 12000;
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const { w, h, dpr } = sizedCanvas(canvas, height);
        const c = canvas.getContext('2d');
        if (!c) return;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.fillStyle = cssVar('--surface-3', '#1a2130');
        c.fillRect(0, 0, w, h);
        const top = Math.min(r / 2, 20000);
        const lx = (hz) => (Math.log(hz / EQ_LOW_HZ) / Math.log(top / EQ_LOW_HZ)) * w;
        const ly = (db) => h / 2 - (Math.max(-EQ_SPAN_DB, Math.min(EQ_SPAN_DB, db)) / EQ_SPAN_DB) * (h / 2 - 3 * dpr);
        // The 0 dB line, and faint ±6.
        c.lineWidth = dpr;
        c.strokeStyle = cssVar('--border', '#2a3240');
        for (const db of [-6, 6]) { c.beginPath(); c.moveTo(0, ly(db)); c.lineTo(w, ly(db)); c.stroke(); }
        c.strokeStyle = cssVar('--text-faint', '#5c6779');
        c.beginPath(); c.moveTo(0, ly(0)); c.lineTo(w, ly(0)); c.stroke();
        const n = Math.max(32, Math.round(w / (2 * dpr)));
        const freqs = Array.from({ length: n }, (_, k) => EQ_LOW_HZ * Math.pow(top / EQ_LOW_HZ, k / (n - 1)));
        const db = eqResponse(node.type, node.params, r, freqs);
        c.beginPath();
        freqs.forEach((hz, k) => { if (k === 0) c.moveTo(lx(hz), ly(db[k])); else c.lineTo(lx(hz), ly(db[k])); });
        c.lineWidth = Math.max(1, 1.5 * dpr);
        c.strokeStyle = cssVar('--accent', '#4aa8ff');
        c.stroke();
        if (node.type === 'parametric-eq') {
            c.fillStyle = cssVar('--accent', '#4aa8ff');
            for (const s of eqSections(node.type, node.params)) {
                if (s.hz < EQ_LOW_HZ || s.hz > top) continue;
                const [d] = eqResponse(node.type, node.params, r, [s.hz]);
                c.beginPath(); c.arc(lx(s.hz), ly(d), 2.5 * dpr, 0, 2 * Math.PI); c.fill();
            }
        }
    });
    return <canvas ref={ref} className="pg-vis__spark pg-vis__eq" style={{ height: `${height}px` }} title={`Response, ±${EQ_SPAN_DB} dB, ${EQ_LOW_HZ} Hz to ${Math.round(Math.min(r / 2, 20000))} Hz`} />;
}

// The most gain reduction the compressor's bar shows.
const REDUCTION_SPAN_DB = 24;

/**
 * What the compressor is taking: a bar that grows with the reduction — the
 * other way from a level — and the limiter's share on the line under it.
 */
function CompressorState({ reading }) {
    if (!reading) return <div className="pg-vis__state">—</div>;
    if (!reading.on) return <div className="pg-vis__state">Off</div>;
    const gr = Math.min(0, reading.reductionDb || 0);
    const lim = Math.min(0, reading.limitDb || 0);
    return (
        <div className="pg-vis__comp">
            <div className="pg-vis__bar pg-vis__bar--gr" title="Gain reduction: how much the compressor is taking off">
                <i style={{ width: `${Math.min(1, -gr / REDUCTION_SPAN_DB) * 100}%` }} />
                <span>{`GR ${gr > -0.05 ? '0.0' : gr.toFixed(1)} dB`}</span>
                <span className="pg-vis__bar-on" aria-hidden="true" style={{ clipPath: `inset(0 ${100 - Math.min(1, -gr / REDUCTION_SPAN_DB) * 100}% 0 0)` }}>
                    {`GR ${gr > -0.05 ? '0.0' : gr.toFixed(1)} dB`}
                </span>
            </div>
            <div className={`pg-vis__state${lim < -0.05 ? ' is-shut' : ''}`}>
                {!reading.limit ? 'Limiter off' : lim < -0.05 ? `Limiting ${lim.toFixed(1)} dB` : 'Limiter idle'}
            </div>
        </div>
    );
}

/** NR's state, and once it is subtracting, by how much. */
function Nr2State({ pg, id, reading }) {
    const d = levelChange(useLevel(pg, id));
    const subtracting = reading && reading.on && !reading.learning;
    return (
        <div className={`pg-vis__state${subtracting ? ' is-open' : ''}`}>
            {!reading ? '—' : !reading.on ? 'Off' : reading.learning ? 'Learning the noise…'
                : `Subtracting${d == null ? '' : ` · ${signed(d)} dB`}`}
        </div>
    );
}
