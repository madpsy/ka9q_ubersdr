// The right-hand column: what the selection is, and its controls.
//
// One block selected: its parameters, drawn from its type's ParamSpecs so a new
// block needs no new interface; what it costs (latency, CPU) and why it cannot
// run, if it cannot; and, for the two sinks that need them, an output device
// and a recorder's controls. Nothing selected: the graph as a whole.

import React, { useEffect, useMemo, useReducer, useRef, useState } from '../../react.js';
import { Button, Field, Icon, Readout, Segmented, Slider, Switch } from '../../components/ui.jsx';
import { elementSinkSupport, sinkLabel } from '../../lib/audioSinks.js';
import useOutputDevices from '../../lib/useOutputDevices.js';
import { BLOCK_BY_TYPE } from '../blocks/index.js';
import { decimateFactor } from '../blocks/mixing.js';
import { formatCpu, formatLatency, formatRate } from './Canvas.jsx';
import { INSTRUMENTS, Instrument } from './viewers.jsx';
import { PROBES, acrossPair, airSpan, inputOrigin, outputKind, sourceZero } from '../probes.js';
import CardVisual, { ActivityDot, RfLine, Sparkline, activityMeaning, earLevels, inspectorShowsPicture, levelChange, recordingLabel, useLevel } from './CardVisual.jsx';
import { carriesSamples, hasRfLine } from '../geometry.js';
import { controlPort, controllable, inputsOf, outputsOf } from '../block.js';
import { NAME_MAX, nodeName } from '../graph.js';
import { decodeWav } from '../wavfile.js';
import { expandable } from '../expand.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { holdPlayback } from '../../lib/playbackHold.js';
import { EQ_FREQUENCIES, EQ_PRESETS, presetMakeup } from '../../radio/audio-filters.js';
import { isIQ } from '../../radio/constants.js';
import FrequencyDial from '../../components/FrequencyDial.jsx';
import { IQWidths } from '../../panels/ReceiverPanel.jsx';
import { MarginPicker } from '../../panels/AudioPanel.jsx';

/**
 * Buttons that hang an instrument off one output. On an input, `from` is the
 * output that feeds it — probing an input is probing what arrives there.
 */
function ProbeButtons({ kind, onProbe }) {
    return (
        <span className="pg-probe">
            {(PROBES[kind] || []).map((p) => (
                <button key={p.type} type="button" className="pg-probe__btn" title={`Attach ${p.label.toLowerCase()} here`} onClick={() => onProbe(p.type)}>
                    {p.label}
                </button>
            ))}
        </span>
    );
}

/**
 * An IQ player's file: load one, see what it is, start it again. Decoded here,
 * on the page, and handed to the worker whole — see PlaygroundEngine.loadFile.
 */
function PlayerControls({ pg, node }) {
    const input = useRef(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const reading = pg.readings ? pg.readings[node.id] : null;
    const load = async (file) => {
        if (!file) return;
        setBusy(true);
        setError(null);
        try {
            const data = decodeWav(await file.arrayBuffer(), file.name);
            pg.loadFile(node.id, data, file.name);
        } catch (err) {
            setError(err.message || String(err));
        } finally {
            setBusy(false);
        }
    };
    const has = pg.hasFile(node.id);
    return (
        <div className="pg-insp__section">
            <div className="pg-insp__title">Recording</div>
            <div className="pg-insp__row">
                <Button size="sm" variant={has ? 'default' : 'primary'} icon={<Icon.Upload />} disabled={busy} onClick={() => input.current && input.current.click()}>
                    {busy ? 'Reading…' : has ? 'Load another' : 'Load IQ file'}
                </Button>
                {has && <Button size="sm" variant="ghost" icon={<Icon.RotateLeft />} onClick={() => pg.command(node.id, 'restart')}>From the start</Button>}
            </div>
            <input
                ref={input}
                type="file"
                accept=".wav,audio/wav,audio/x-wav"
                hidden
                onChange={(e) => { load(e.target.files && e.target.files[0]); e.target.value = ''; }}
            />
            {node.params.fileName && (
                <div className="pg-insp__note">
                    {node.params.fileName}
                    {node.params.rateHz ? ` · ${formatRate(node.params.rateHz)} Hz` : ''}
                    {reading && reading.duration ? ` · ${clock(reading.position)} of ${clock(reading.duration)}` : ''}
                </div>
            )}
            {!has && node.params.fileName && <div className="note note--tight">Files are not kept with the graph: load it again to play it.</div>}
            {error && <div className="note note--tight note--warn">{error}</div>}
        </div>
    );
}

/** What a selected wire carries, and the instruments to look at it with. */
function WireInspector({ graph, wire, rates, onProbe, onRemoveWire }) {
    const [fromId, fromPort, toId, toPort] = wire;
    const kind = outputKind(graph, fromId, fromPort);
    return (
        <div className="pg-insp">
            <div className="pg-insp__title">Wire</div>
            <p className="pg-insp__summary">
                {`${fromId}.${fromPort} → ${toId}.${toPort}: a ${kind} signal${rates[fromId] ? ` at ${formatRate(rates[toId] || rates[fromId])} Hz` : ''}.`}
            </p>
            <div className="pg-insp__section">
                <div className="pg-insp__title">Look at it</div>
                <ProbeButtons kind={kind} onProbe={(type) => onProbe(fromId, fromPort, type)} />
            </div>
            <div className="pg-insp__row">
                <Button size="sm" variant="ghost" icon={<Icon.Trash size={13} />} onClick={onRemoveWire}>Remove wire</Button>
            </div>
        </div>
    );
}

/** A number as typed: committed on Enter or on leaving the box. */
function NumberBox({ value, min, max, onChange, unit }) {
    const [draft, setDraft] = useState(null);
    const commit = () => {
        if (draft === null) return;
        const v = Number(draft);
        setDraft(null);
        if (draft.trim() !== '' && Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
    };
    return (
        <span className="pg-num">
            <input
                className="input pg-num__input"
                inputMode="decimal"
                value={draft === null ? String(value) : draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') commit();
                    if (e.key === 'Escape') setDraft(null);
                    e.stopPropagation();
                }}
            />
            {unit && <span className="pg-num__unit">{unit}</span>}
        </span>
    );
}

/**
 * A slider's travel for a parameter. A frequency's declared range covers the
 * widest stream there is; at the rate this block actually works at, anything
 * past Nyquist means nothing, so the slider stops there and the box still
 * takes the rest.
 */
function travel(spec, rate) {
    if (spec.unit !== 'Hz' || !(rate > 0)) return { min: spec.min, max: spec.max };
    const ny = rate / 2;
    return { min: Math.max(spec.min, spec.min < 0 ? -ny : spec.min), max: Math.min(spec.max, ny) };
}

function DeviceField({ value, onChange, error }) {
    const supported = useMemo(elementSinkSupport, []);
    const { devices, refresh } = useOutputDevices(supported);
    if (!supported) {
        return <div className="note note--tight">This browser can only play to the receiver’s own output.</div>;
    }
    const known = !value || devices.some((d) => d.deviceId === value);
    return (
        <Field label="Output">
            <select
                className="select"
                value={value || ''}
                onPointerDown={() => refresh(true)}
                onFocus={() => refresh(false)}
                onChange={(e) => onChange(e.target.value)}
            >
                <option value="">Receiver output</option>
                {devices.filter((d) => d.deviceId).map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                        {d.deviceId === 'default' ? 'System Default' : sinkLabel(d)}
                    </option>
                ))}
                {!known && <option value={value}>Saved device …{value.slice(-6)}</option>}
            </select>
            {error && <div className="note note--tight note--warn">That device could not be used ({error}) — playing on the receiver’s output instead.</div>}
        </Field>
    );
}

/**
 * A parameter's control: the toggle that gives it a control input, and while
 * a wire drives it, the value it has been driven to instead of a slider.
 */
function ControlToggle({ exposed, onExpose }) {
    return (
        <button
            type="button"
            className={`pg-ctl${exposed ? ' is-on' : ''}`}
            title={exposed ? 'Remove this setting’s control input' : 'Give this setting a control input, so another block can drive it'}
            aria-pressed={exposed}
            onClick={() => onExpose(!exposed)}
        >
            ⊸
        </button>
    );
}

export function ParamRow({ name, spec, value, params, rate, onChange, sinkError, exposed, onExpose, drivenBy, drivenValue }) {
    const field = drivenBy ? (
        <Field label={spec.label} hint={drivenValue == null ? '—' : String(Number.isFinite(drivenValue) ? Number(drivenValue.toPrecision(6)) : drivenValue)}>
            <div className="pg-driven">driven by {drivenBy}</div>
        </Field>
    ) : <ParamField name={name} spec={spec} value={value} params={params} rate={rate} onChange={onChange} sinkError={sinkError} />;
    if (!controllable(spec) || !onExpose) return field;
    return (
        <div className="pg-param">
            <div className="pg-param__field">{field}</div>
            <ControlToggle exposed={exposed} onExpose={onExpose} />
        </div>
    );
}

export function ParamField({ name, spec, value, params, rate, onChange, sinkError }) {
    switch (spec.kind) {
        case 'text':
            // A placeholder may depend on the block's other settings: what an
            // empty message sends depends on the mode.
            if (spec.multiline) {
                return (
                    <Field label={spec.label}>
                        <textarea
                            className="input pg-insp__textarea"
                            rows={4}
                            value={value}
                            maxLength={spec.max}
                            placeholder={typeof spec.placeholder === 'function' ? spec.placeholder(params || {}) : spec.placeholder}
                            onChange={(e) => onChange(e.target.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                        />
                    </Field>
                );
            }
            return (
                <Field label={spec.label}>
                    <input
                        className="input"
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                    />
                </Field>
            );
        case 'bool':
            return <Switch checked={value} onChange={onChange} label={spec.label} />;
        case 'device':
            return <DeviceField value={value} onChange={onChange} error={sinkError} />;
        case 'choice':
            if (spec.swatches) {
                return (
                    <Field label={spec.label}>
                        <div className="pg-swatches" role="radiogroup" aria-label={spec.label}>
                            {spec.options.map((o) => (
                                <button
                                    key={String(o.value)}
                                    type="button"
                                    role="radio"
                                    aria-checked={value === o.value}
                                    title={o.label}
                                    className={`pg-swatch pg-ann--${o.value}${value === o.value ? ' is-on' : ''}`}
                                    onClick={() => onChange(o.value)}
                                />
                            ))}
                        </div>
                    </Field>
                );
            }
            if (spec.options.length <= 4) {
                return (
                    <Field label={spec.label}>
                        <Segmented options={spec.options} value={value} onChange={onChange} size="sm" />
                    </Field>
                );
            }
            return (
                <Field label={spec.label}>
                    <select
                        className="select"
                        value={String(value)}
                        onChange={(e) => {
                            const o = spec.options.find((x) => String(x.value) === e.target.value);
                            if (o) onChange(o.value);
                        }}
                    >
                        {spec.options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
                    </select>
                </Field>
            );
        default: {
            const t = travel(spec, rate);
            return (
                <Field label={spec.label} hint={<NumberBox value={value} min={spec.min} max={spec.max} unit={spec.unit} onChange={onChange} />}>
                    <Slider
                        value={Math.max(t.min, Math.min(t.max, value))}
                        min={t.min}
                        max={t.max}
                        step={spec.step || 1}
                        onChange={onChange}
                    />
                </Field>
            );
        }
    }
}

/**
 * The receiver, from the IQ stream block: its frequency, and the IQ width the
 * graph is built for, with the Receiver panel's own controls. The frequency is
 * the receiver's and is tuned at once. The width is the graph's — it travels
 * with a shared or saved graph — and PlaygroundWatch puts the receiver on it.
 */
/** Bytes a second, as the Stats panel's throughput reads. */
export function formatBytesPerSec(b) {
    if (!(b >= 0) || !Number.isFinite(b)) return '—';
    if (b >= 1e6) return `${(b / 1e6).toFixed(2)} MB/s`;
    if (b >= 1e3) return `${(b / 1e3).toFixed(b >= 1e5 ? 0 : 1)} kB/s`;
    return `${Math.round(b)} B/s`;
}

/** A count and its share of a whole, as "3 · 0.4%". */
export function countShare(n, of) {
    if (!(of > 0)) return n > 0 ? String(n) : '0';
    const pct = (100 * n) / of;
    return `${n} · ${pct > 0 && pct < 0.1 ? '<0.1' : pct.toFixed(pct < 10 ? 1 : 0)}%`;
}

// How often the stream's counters are read, and how far back the chart goes.
const SNAP_MS = 250;
const CHART_MS = 10000;

/**
 * What the IQ stream is bringing in, while the graph runs from the receiver:
 * the connection's throughput — the audio stream's share of the Stats panel's
 * NET — samples and packets a second against the rate it should run at, and
 * what was lost: the player's dropouts (underruns, as Stats counts them) and
 * the packets the playground let go because the graph was too far behind.
 * Rates over the last second; losses since Start.
 */
function StreamStats({ pg }) {
    const { audioConn } = useRadio();
    const [, tick] = useReducer((n) => n + 1, 0);
    // Snapshots of the counters, a quarter-second apart, back ten seconds:
    // the chart is the throughput between each pair, the cards the last second.
    const snaps = useRef([]);
    useEffect(() => {
        const t = setInterval(tick, SNAP_MS);
        return () => clearInterval(t);
    }, []);
    if (!pg.running || pg.offline) {
        snaps.current = [];
        return (
            <div className="pg-insp__section">
                <div className="pg-insp__title">Stream</div>
                <div className="pg-insp__note">{pg.running ? 'Not used: this graph runs by itself.' : 'Start the graph to see what the stream brings in.'}</div>
            </div>
        );
    }
    const c = pg.streamCounts();
    const now = { t: typeof performance !== 'undefined' ? performance.now() : Date.now(), bytes: (audioConn && audioConn.bytesIn) || 0, ...c };
    const list = snaps.current;
    const prev = list[list.length - 1];
    // A Start since the last one: begin again.
    if (prev && now.packets < prev.packets) list.length = 0;
    if (!list.length || now.t - list[list.length - 1].t >= SNAP_MS / 2) list.push(now);
    while (list.length > 1 && now.t - list[0].t > CHART_MS + SNAP_MS) list.shift();
    const r = streamRates(list);
    const history = throughputHistory(list);
    // How much of what the stream should carry arrived, over the last second.
    const share = r && c.rate > 0 ? r.frames / c.rate : null;
    return (
        <div className="pg-insp__section">
            <div className="pg-insp__title">Stream</div>
            <div className="pg-insp__chart" title="Throughput, the last ten seconds, from zero">
                <Sparkline history={history} height={36} fromZero />
                <span className="pg-insp__chart-label">{r ? formatBytesPerSec(r.bytes) : '—'}</span>
            </div>
            <div className="readout-grid">
                <Readout label="Throughput" value={r ? formatBytesPerSec(r.bytes) : '—'} />
                <Readout
                    label="Samples"
                    value={r ? `${formatRate(r.frames) || '0'}/s` : '—'}
                    tone={share != null && share < 0.98 ? 'weak' : undefined}
                />
                <Readout label="Packets" value={r ? `${r.packets.toFixed(r.packets < 10 ? 1 : 0)}/s` : '—'} />
                <Readout label="Of the rate" value={share == null ? '—' : `${Math.min(999, share * 100).toFixed(1)}%`} tone={share != null && share < 0.98 ? 'weak' : undefined} />
                <Readout label="Dropped" value={countShare(c.underruns, c.packets)} tone={c.underruns > 0 ? 'weak' : undefined} />
                <Readout label="Graph behind" value={countShare(c.behind, c.packets)} tone={c.behind > 0 ? 'weak' : undefined} />
            </div>
            <div className="pg-insp__note">
                Dropped is the player running dry — the stream arriving late or not at all — as the Stats panel counts it. Graph behind is packets let go because the graph could not keep up. Both since Start, as a share of the packets received.
            </div>
        </div>
    );
}

/**
 * Bytes, samples and packets a second over the last second of `snaps` —
 * snapshots of { t, bytes, frames, packets } — or null before there is half
 * a second to go on.
 */
export function streamRates(snaps) {
    if (snaps.length < 2) return null;
    const now = snaps[snaps.length - 1];
    let was = snaps[0];
    for (let k = snaps.length - 2; k >= 0; k--) {
        was = snaps[k];
        if (now.t - was.t >= 1000) break;
    }
    const sec = (now.t - was.t) / 1000;
    if (sec < 0.5) return null;
    return {
        bytes: (now.bytes - was.bytes) / sec,
        frames: (now.frames - was.frames) / sec,
        packets: (now.packets - was.packets) / sec,
    };
}

/** Bytes a second between each pair of snapshots, oldest first: the chart. */
export function throughputHistory(snaps) {
    const out = [];
    for (let k = 1; k < snaps.length; k++) {
        const sec = (snaps[k].t - snaps[k - 1].t) / 1000;
        if (sec > 0) out.push(Math.max(0, (snaps[k].bytes - snaps[k - 1].bytes) / sec));
    }
    return out;
}

function ReceiverControls({ graph, node, onParams }) {
    const { tuning, actions, allowedIQModes } = useRadio();
    const allowed = allowedIQModes || [];
    const width = node.params.width || 'iq';
    const spec = BLOCK_BY_TYPE['iq-in'].params.width;
    const label = (spec.options.find((o) => o.value === width) || spec.options[0]).label;
    const usable = width === 'iq' || allowed.includes(width);
    // Every IQ stream block in the graph, as one: there is one stream.
    const choose = (id) => {
        for (const n of graph.nodes) {
            if (n.type === 'iq-in' && n.params.width !== id) onParams(n.id, { width: id }, 'iq-width');
        }
    };
    let note = null;
    if (!usable) note = `This graph is built for ${label} IQ, which this receiver does not offer you. It runs at 12 kHz.`;
    else if (tuning.mode !== width && !isIQ(tuning.mode)) note = `The receiver goes to ${label} IQ when the graph starts.`;
    return (
        <div className="pg-insp__section">
            <div className="pg-insp__title">Receiver</div>
            <FrequencyDial frequency={tuning.frequency} onChange={actions.setFrequency} />
            <Field label="IQ width">
                <IQWidths mode={width} allowed={allowed} onChoose={choose} />
            </Field>
            {note && <div className="pg-insp__note">{note}</div>}
            {/* The receiver panel's quality slider, the same control: one
                setting for the session's stream, which is this one. */}
            <MarginPicker forIQ />
        </div>
    );
}

/** What a decimator is doing to the rate arriving, in a sentence. */
function decimateNote(p, rate) {
    const D = decimateFactor(rate, p);
    const now = `${formatRate(rate)} Hz in, ${formatRate(rate / D)} Hz out`;
    if (!p.auto) return `Keeping 1 sample in ${D}: ${now}.`;
    return D > 1
        ? `Auto: keeping 1 sample in ${D} — ${now}. Follows the IQ width.`
        : `Auto: the stream is already narrow, so it keeps every sample and only brings the centre to zero — ${now}. Follows the IQ width.`;
}

/** Where on the air a source's samples are from, in a sentence. */
function coverNote(node, dialHz, rate) {
    const c = airSpan(sourceZero(node, dialHz), rate);
    if (c) return `Covers ${c.range}, centred on ${c.centre}${c.width ? ` — ${c.width}` : ''}.`;
    if (node.type === 'signal') return 'Not on the air: the tones are offsets from zero. Give it a centre frequency to put them on real frequencies.';
    if (node.type === 'data-tx') return 'Not on the air: the signal is at an offset from zero. Give it a centre frequency to put it on a real one.';
    return node.type === 'iq-in'
        ? 'Not tuned yet: the range shows once the receiver has a frequency.'
        : 'This file does not say where it was recorded, so the spectra show offsets rather than frequencies. Set the centre frequency if you know it.';
}

function clock(sec) {
    const s = Math.floor(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Everything else quiet while a recording plays back: the receiver ducked,
 * as the Recorder panel ducks it for its own playback, and the playground's
 * and IQ Demod's outputs held (lib/playbackHold.js) — they join the output
 * after the duck, so it alone would leave them playing over the recording.
 * The duck is put back only if it was this that put it down: a running
 * playground holds it down too. Released on pause, end, error, and if the
 * player goes away mid-play.
 *
 * Returns the <audio> element's handlers.
 */
export function useQuietWhilePlaying(player) {
    const held = useRef(null);
    const quiet = () => {
        if (held.current) return;
        const ducked = !!(player && player.ducked);
        if (player && !ducked) player.setDucked(true);
        held.current = { release: holdPlayback(), ducked };
    };
    const loud = () => {
        const h = held.current;
        if (!h) return;
        held.current = null;
        h.release();
        if (player && !h.ducked) player.setDucked(false);
    };
    useEffect(() => loud, []);
    return { onPlay: quiet, onPause: loud, onEnded: loud, onError: loud };
}

/** The graphic EQ's settings for one of the receiver's presets, or flat. */
export function eqPresetParams(name) {
    const preset = EQ_PRESETS[name];
    const out = {};
    for (const hz of EQ_FREQUENCIES) out[`g${hz}`] = preset ? preset[hz] : 0;
    out.makeupDb = preset ? presetMakeup(preset) : 0;
    return out;
}

/**
 * The receiver's EQ presets, for the graphic EQ: the same bands and the same
 * makeup the receiver's EQ panel sets — pulled down so a preset full of
 * boosts does not clip.
 */
function EqPresets({ node, onParams }) {
    const names = ['flat', ...Object.keys(EQ_PRESETS)];
    const current = names.find((n) => {
        const want = eqPresetParams(n);
        return Object.keys(want).every((k) => node.params[k] === want[k]);
    });
    return (
        <div className="pg-insp__section">
            <div className="pg-insp__title">Presets</div>
            <div className="pg-insp__row">
                {names.map((n) => (
                    <Button
                        key={n}
                        size="sm"
                        variant={current === n ? 'primary' : 'ghost'}
                        onClick={() => onParams(node.id, eqPresetParams(n), `eq-preset:${node.id}`)}
                    >
                        {n === 'cw' ? 'CW' : n[0].toUpperCase() + n.slice(1)}
                    </Button>
                ))}
            </div>
        </div>
    );
}

function RecorderControls({ pg, id, maxSeconds, label }) {
    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => {
        const off = pg.on('change', bump);
        const t = setInterval(() => {
            const r = pg.recordings.get(id);
            if (r && r.state === 'recording') bump();
        }, 500);
        return () => { off(); clearInterval(t); };
    }, [pg, id]);
    const rec = pg.recordings.get(id);
    const state = rec ? rec.state : 'idle';
    const [error, setError] = useState(null);
    const quiet = useQuietWhilePlaying(pg.player);
    return (
        <div className="pg-insp__section">
            <div className="pg-insp__title">Recording</div>
            <div className="pg-insp__row">
                {state === 'recording' ? (
                    <Button size="sm" icon={<Icon.Stop />} onClick={() => pg.stopRecording(id)}>Stop</Button>
                ) : (
                    <Button
                        size="sm"
                        variant="primary"
                        icon={<Icon.Record />}
                        disabled={!pg.running}
                        title={pg.running ? undefined : 'Start the playground to record'}
                        onClick={() => pg.startRecording(id, label)}
                    >
                        Record
                    </Button>
                )}
                <span className="pg-insp__clock">
                    {rec && state !== 'idle' ? `${clock(rec.seconds)} of ${clock(rec.limitSeconds)}` : `Limit ${clock(maxSeconds)}`}
                    {rec && rec.channels ? ` · ${rec.channels === 2 ? 'stereo' : 'mono'} ${formatRate(rec.rate)}` : ''}
                </span>
            </div>
            {rec && rec.reason && <div className="note note--tight">{rec.reason}</div>}
            {state === 'held' && (
                <>
                    {/* The browser's own player: it already does scrubbing,
                        volume and the keyboard, on every platform. */}
                    <audio className="pg-insp__audio" controls src={rec.url() || undefined} {...quiet} />
                    <div className="pg-insp__row">
                        <Button
                            size="sm"
                            icon={<Icon.Download />}
                            onClick={() => pg.saveRecording(id).catch((e) => setError(e.message || String(e)))}
                        >
                            Save WAV
                        </Button>
                        <Button size="sm" variant="ghost" icon={<Icon.Trash size={13} />} onClick={() => pg.clearRecording(id)}>
                            Discard
                        </Button>
                    </div>
                    {error && <div className="note note--tight note--warn">{error}</div>}
                </>
            )}
        </div>
    );
}

/**
 * A block's name, as a box to write it in: the type's label shown faintly
 * when it has none, and kept as each letter is typed — one undo step for the
 * lot (see onRename). What is typed is shown as typed until the box is left:
 * the name kept is trimmed, and showing that would eat the space before the
 * next word.
 */
function NameField({ node, def, onRename }) {
    const [draft, setDraft] = useState(null);
    return (
        <Field label="Name">
            <input
                className="input"
                value={draft ?? (node.name || '')}
                placeholder={def.label}
                maxLength={NAME_MAX}
                onChange={(e) => {
                    setDraft(e.target.value);
                    onRename(node.id, e.target.value);
                }}
                onBlur={() => setDraft(null)}
                onKeyDown={(e) => e.stopPropagation()}
            />
        </Field>
    );
}

/** The loudest sample lately, in red at full scale and over: clipping. */
function PeakReadout({ lv }) {
    const over = lv.clip > 0 || lv.peak >= 0;
    const value = lv.peak <= -199 ? 'silent' : `${lv.peak >= 0 ? '+' : ''}${lv.peak.toFixed(1)}`;
    return (
        <Readout
            label={over ? 'Peak — clipping' : 'Peak'}
            value={value}
            unit={lv.peak <= -199 ? undefined : 'dBFS'}
            color={over ? 'var(--bad)' : undefined}
        />
    );
}

/** A level as a readout shows it: to a tenth of a dB, or what it is instead. */
function dbValue(db) {
    return db == null ? '—' : db <= -199 ? 'silent' : db.toFixed(1);
}

/**
 * The block's level in and out, as cards — Audio out's per ear, since its
 * one input goes to the left, the right or both. Its own component so that
 * only it re-renders with the readings.
 */
function LevelReadouts({ pg, node, def }) {
    const lv = useLevel(pg, node.id);
    const unit = (db) => (db == null || db <= -199 ? undefined : 'dBFS');
    if (node.type === 'audio-out') {
        const ears = earLevels(node, lv);
        return (
            <>
                <Readout label={ears.muted ? 'Left (muted)' : 'Left'} value={dbValue(ears.left)} unit={unit(ears.left)} />
                <Readout label={ears.muted ? 'Right (muted)' : 'Right'} value={dbValue(ears.right)} unit={unit(ears.right)} />
                {lv.peak != null && <PeakReadout lv={lv} />}
            </>
        );
    }
    const carries = (p) => p.kind === 'complex' || p.kind === 'real';
    const hasIn = def.inputs.some(carries);
    const hasOut = def.outputs.some(carries);
    const d = levelChange(lv);
    return (
        <>
            {hasIn && <Readout label="Level in" value={dbValue(lv.in)} unit={unit(lv.in)} />}
            {hasOut && <Readout label="Level out" value={dbValue(lv.out)} unit={unit(lv.out)} />}
            {hasIn && hasOut && <Readout label="Change" value={d == null ? '—' : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`} unit={d == null ? undefined : 'dB'} />}
            {lv.peak != null && <PeakReadout lv={lv} />}
        </>
    );
}

export default function Inspector({
    pg, graph, selection, errorsByNode, rates, latencies, stats, onParams, onRemove, onDuplicate, summary,
    look, origins, onProbe, onAcross, onExpose, onExpand, onRename,
}) {
    const ids = [...selection.nodes];
    if (!ids.length && selection.wire != null && graph.wires[selection.wire]) {
        return (
            <WireInspector
                graph={graph}
                wire={graph.wires[selection.wire]}
                rates={rates}
                onProbe={onProbe || (() => {})}
                onRemoveWire={onRemove}
            />
        );
    }
    if (ids.length > 1) {
        return (
            <div className="pg-insp">
                <div className="pg-insp__title">{ids.length} blocks selected</div>
                <div className="pg-insp__row">
                    <Button size="sm" icon={<Icon.Copy />} onClick={onDuplicate}>Duplicate</Button>
                    <Button size="sm" variant="ghost" icon={<Icon.Trash size={13} />} onClick={onRemove}>Remove</Button>
                </div>
            </div>
        );
    }
    const node = ids.length === 1 ? graph.nodes.find((n) => n.id === ids[0]) : null;
    if (!node) return <div className="pg-insp">{summary}</div>;

    const def = BLOCK_BY_TYPE[node.type];
    const errs = errorsByNode[node.id] || [];
    const lat = latencies[node.id];
    const s = stats && stats.nodes ? stats.nodes[node.id] : null;
    const wiresIn = graph.wires.filter((w) => w[2] === node.id);
    return (
        <div className="pg-insp">
            <div className="pg-insp__head">
                <div className="pg-insp__title">
                    {nodeName(node)}
                    {activityMeaning(def) && <ActivityDot pg={pg} id={node.id} meaning={activityMeaning(def)} />}
                </div>
                <div className="pg-insp__id">{node.name ? `${def.label} · ${node.id}` : node.id}</div>
            </div>
            <p className="pg-insp__summary">{def.summary}</p>
            {!def.annotation && onRename && <NameField key={node.id} node={node} def={def} onRename={onRename} />}
            {errs.map((e, i) => <div key={i} className="note note--tight note--warn">{e.message}</div>)}
            {!def.annotation && (
                <div className="readout-grid">
                    <Readout label="Rate" value={formatRate(rates[node.id]) || '—'} unit={rates[node.id] ? 'Hz' : undefined} />
                    <Readout label="Latency" value={lat ? formatLatency(lat.own) : '—'} />
                    <Readout label="From source" value={lat ? formatLatency(lat.total) : '—'} />
                    <Readout label="CPU" value={s ? formatCpu(s.cpu) : '—'} />
                    {carriesSamples(node.type) && <LevelReadouts pg={pg} node={node} def={def} />}
                </div>
            )}
            {def.latencyNote && <div className="pg-insp__note">{def.latencyNote}</div>}
            {node.type === 'iq-in' && (
                <div className="pg-insp__note">
                    {lat && lat.own != null
                        ? 'Latency here is how old the IQ is on arriving: capture at the receiver to this browser, measured from the time stamped on every packet. Every block after this counts it in From source.'
                        : 'How old the IQ is on arriving — capture at the receiver to this browser — shows here once it is arriving.'}
                </div>
            )}
            {hasRfLine(node.type) && (
                <div className="pg-insp__rf">
                    <span className="pg-insp__rf-label">On the air</span>
                    <RfLine pg={pg} graph={graph} node={node} dialHz={look && look.dialHz} origins={origins} />
                </div>
            )}
            {(node.type === 'iq-in' || node.type === 'iq-player' || node.type === 'signal' || node.type === 'data-tx') && (
                <div className="pg-insp__note">{coverNote(node, look && look.dialHz, rates[node.id])}</div>
            )}
            {INSTRUMENTS.has(node.type) && (
                <div className="pg-insp__section pg-insp__large">
                    <Instrument
                        pg={pg}
                        node={node}
                        look={look}
                        origin={origins ? inputOrigin(graph, origins, node.id) : null}
                        large
                    />
                </div>
            )}
            {inspectorShowsPicture(node) && (
                <div className="pg-insp__section pg-insp__large pg-insp__now">
                    <CardVisual
                        pg={pg}
                        node={node}
                        look={look}
                        origin={origins ? inputOrigin(graph, origins, node.id) : null}
                        rate={rates[node.id]}
                        onParams={onParams}
                        large
                    />
                </div>
            )}
            {node.type === 'iq-in' && <StreamStats pg={pg} />}
            {node.type === 'iq-in' && <ReceiverControls graph={graph} node={node} onParams={onParams} />}
            {Object.keys(def.params).length > 0 && node.type !== 'iq-in' && (
                <div className="pg-insp__section">
                    <div className="pg-insp__title">Settings</div>
                    {Object.entries(def.params).map(([name, spec]) => {
                        const exposed = (node.controls || []).includes(name);
                        // Hidden when the block's other settings make it moot —
                        // unless exposed, so its wire and toggle stay in reach.
                        if (spec.showIf && !exposed && !spec.showIf(node.params)) return null;
                        const w = exposed && graph.wires.find((x) => x[2] === node.id && x[3] === controlPort(name));
                        const driven = pg.driven && pg.driven[node.id] ? pg.driven[node.id][name] : undefined;
                        return (
                            <ParamRow
                                key={name}
                                name={name}
                                spec={spec}
                                value={node.params[name]}
                                params={node.params}
                                rate={rates[node.id]}
                                sinkError={spec.kind === 'device' ? pg.sinkErrorOf(node.id) : null}
                                onChange={(v) => onParams(node.id, { [name]: v }, `param:${node.id}:${name}`)}
                                exposed={exposed}
                                onExpose={onExpose ? (on) => onExpose(node.id, name, on) : null}
                                drivenBy={w ? `${w[0]}.${w[1]}` : null}
                                drivenValue={driven === undefined ? null : driven}
                            />
                        );
                    })}
                </div>
            )}
            {(node.type === 'wav-recorder' || node.type === 'iq-recorder') && (
                <RecorderControls
                    pg={pg}
                    id={node.id}
                    maxSeconds={node.params.maxSeconds}
                    label={recordingLabel(node.type, origins ? inputOrigin(graph, origins, node.id) : null)}
                />
            )}
            {node.type === 'iq-player' && <PlayerControls pg={pg} node={node} />}
            {node.type === 'data-tx' && (
                <div className="pg-insp__section">
                    <div className="pg-insp__row">
                        <Button size="sm" variant="ghost" icon={<Icon.RotateLeft />} onClick={() => pg.command(node.id, 'restart')}>Send again</Button>
                    </div>
                </div>
            )}
            {node.type === 'graphic-eq' && <EqPresets node={node} onParams={onParams} />}
            {node.type === 'nr2' && (
                <div className="pg-insp__section">
                    <p className="pg-insp__summary">It learns the noise from what it hears first — 1.3 s at 12 kHz, less at higher rates. If a signal was there then, it is subtracting the signal: learn again while there is only noise.</p>
                    <div className="pg-insp__row">
                        <Button size="sm" variant="ghost" icon={<Icon.RotateLeft />} onClick={() => pg.command(node.id, 'relearn')}>Learn again</Button>
                    </div>
                </div>
            )}
            {node.type === 'decimate' && rates[node.id] > 0 && (
                <div className="pg-insp__note">{decimateNote(node.params, rates[node.id])}</div>
            )}
            {expandable(node) && onExpand && (
                <div className="pg-insp__section">
                    <div className="pg-insp__title">Inside</div>
                    <p className="pg-insp__summary">
                        {node.type === 'demodulator'
                            ? 'This is the IQ Demod panel’s own demodulator. Expand it to replace it with the blocks it is made of — the same sound, every stage of it to adjust and probe.'
                            : 'This decoder is a small graph of the Digital blocks. Expand it to lay them out in its place — the same text, every stage of the modem to adjust and probe.'}
                    </p>
                    <div className="pg-insp__row">
                        <Button size="sm" icon={<Icon.Expand />} onClick={() => onExpand(node.id)}>Expand into blocks</Button>
                    </div>
                </div>
            )}
            {inputsOf(node, def).length > 0 && (
                <div className="pg-insp__section">
                    <div className="pg-insp__title">Inputs</div>
                    {inputsOf(node, def).map((p) => {
                        const w = wiresIn.find((x) => x[3] === p.name);
                        return (
                            <div key={p.name} className="pg-insp__portblock">
                                <div className="pg-insp__port">
                                    <span className={`pg-insp__kind pg-insp__kind--${p.kind}`}>{p.kind}</span>
                                    <span>{p.param ? `${p.label} (control)` : p.name}</span>
                                    <span className="pg-insp__from">{w ? `← ${w[0]}.${w[1]}` : p.optional ? 'optional' : 'not wired'}</span>
                                </div>
                                {w && onProbe && <ProbeButtons kind={p.kind} onProbe={(type) => onProbe(w[0], w[1], type)} />}
                            </div>
                        );
                    })}
                </div>
            )}
            {onAcross && acrossPair(graph, node.id) && (
                <div className="pg-insp__section">
                    <div className="pg-insp__title">Across this block</div>
                    <p className="pg-insp__summary">
                        Compare what goes in with what comes out: the gain and phase it applies at the frequency passing through it.
                    </p>
                    <div className="pg-insp__row">
                        <Button size="sm" icon={<Icon.Target />} onClick={() => onAcross(node.id)}>Measure gain &amp; phase</Button>
                    </div>
                </div>
            )}
            {outputsOf(node, def).length > 0 && onProbe && (
                <div className="pg-insp__section">
                    <div className="pg-insp__title">Outputs — attach an instrument</div>
                    {outputsOf(node, def).map((p) => (
                        <div key={p.name} className="pg-insp__portblock">
                            <div className="pg-insp__port">
                                <span className={`pg-insp__kind pg-insp__kind--${p.kind}`}>{p.kind}</span>
                                <span>{p.name}</span>
                            </div>
                            <ProbeButtons kind={p.kind} onProbe={(type) => onProbe(node.id, p.name, type)} />
                        </div>
                    ))}
                </div>
            )}
            <div className="pg-insp__row">
                <Button size="sm" icon={<Icon.Copy />} onClick={onDuplicate}>Duplicate</Button>
                <Button size="sm" variant="ghost" icon={<Icon.Trash size={13} />} onClick={onRemove}>Remove</Button>
            </div>
        </div>
    );
}
