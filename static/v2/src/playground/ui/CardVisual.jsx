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
import { cssVar, sizedCanvas } from '../../lib/audioWaterfall.js';
import { airSpan, rfLabel, rfOf, shiftLabel, sourceZero } from '../probes.js';

const FLOOR_DB = -80;

/** A level in dB as a share of the bar. */
const share = (db, floor = FLOOR_DB) => (db == null || !Number.isFinite(db) ? 0 : Math.max(0, Math.min(1, (db - floor) / -floor)));

function useReadings(pg, id) {
    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => pg.on('readings', bump), [pg]);
    return pg.readings ? pg.readings[id] : null;
}

function Bar({ db, label }) {
    return (
        <div className="pg-vis__bar" title={label}>
            <i style={{ width: `${share(db) * 100}%` }} />
            <span>{db == null ? '—' : `${Math.round(db)} dB`}</span>
        </div>
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
export default function CardVisual({ pg, node, look, origin, rate, onParams }) {
    if (INSTRUMENTS.has(node.type)) return <Instrument pg={pg} node={node} look={look} origin={origin} />;
    if (KNOBS.has(node.type)) return <Knob node={node} onParams={onParams} />;
    if (node.type === 'iq-in') return <Coverage zeroHz={sourceZero(node, look && look.dialHz)} rate={rate} />;
    return <SimpleVisual pg={pg} node={node} origin={origin} rate={rate} />;
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

function Sparkline({ history }) {
    const ref = useRef(null);
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const { w, h, dpr } = sizedCanvas(canvas, 44);
        const c = canvas.getContext('2d');
        if (!c) return;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.fillStyle = cssVar('--surface-3', '#1a2130');
        c.fillRect(0, 0, w, h);
        if (!history || history.length < 2) return;
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of history) { if (v < lo) lo = v; if (v > hi) hi = v; }
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
    return <canvas ref={ref} className="pg-vis__spark" style={{ height: '44px' }} />;
}

function SimpleVisual({ pg, node, origin, rate }) {
    const reading = useReadings(pg, node.id);
    switch (node.type) {
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
            return (
                <div className={`pg-vis__state${s === 'locked' || s === 'hold' ? ' is-open' : ''}`}>
                    {s ? words[s] || s : '—'}
                    {reading && reading.carrierHz != null ? ` · ${reading.carrierHz.toFixed(1)} Hz` : ''}
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
                    <Sparkline history={reading && reading.history} />
                </div>
            );
        default:
            return null;
    }
}
