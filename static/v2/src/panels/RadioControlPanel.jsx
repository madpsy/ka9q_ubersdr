// Radio Control — drive the receiver from hardware instead of the screen.
//
// Three sources, one at a time:
//
//   FlexControl   a FlexRadio USB dial, over Web Serial
//   MIDI          any USB MIDI surface — DJ controller, knob box, fader bank
//   Radio Sync    full CAT control of a transceiver, through Hamlib-in-wasm
//
// Only one runs at once. The first two are the same idea — a control moves, a
// mapped function runs — and share everything but their transport, so they
// share a mapping table here too. Radio Sync is a different animal: nothing is
// mapped, the rig and the receiver simply follow each other.
//
// Why one at a time rather than several: two surfaces mapped to frequency would
// fight, and Radio Sync in "radio to SDR" would fight both. Exclusivity is also
// what makes the panel legible — one connection, one status, one log — and the
// only combination genuinely lost is a MIDI box alongside a rig being driven
// from the SDR, which is a fair trade for not having to explain the rest.
//
// v1 ships these as three separate extensions, each with its own copy of the
// mapping engine and its own way of reaching into the UI (reading slider ranges
// off `document.getElementById('bandwidth-low').min`, and so on). Here the
// logic is shared and everything goes through `actions`, so a mapped control
// takes exactly the path a click takes.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { Button, Empty, Field, Icon, Segmented, Switch } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { TUNING_STEPS, stepLabel } from '../radio/constants.js';
import { catalogue, functionLabel, RETIRED } from '../controls/functions.js';
import {
    Dispatcher, defaultThrottle, exportMappings, importMappings, loadState, saveState,
} from '../controls/mappings.js';
import { flexAvailable, flexKeyLabel } from '../controls/flexcontrol.js';
import { CC, midiAvailable, midiKeyLabel } from '../controls/webmidi.js';
import { serialAvailable } from '../controls/radiosync.js';
import { getSurface, getSync, releaseExcept } from '../controls/sources.js';

const MAX_MESSAGES = 60;

const SOURCE_OPTIONS = [
    { value: 'off', label: 'Off' },
    { value: 'flexcontrol', label: 'FlexControl' },
    { value: 'midi', label: 'MIDI' },
    { value: 'radiosync', label: 'Radio Sync' },
];

export default function RadioControlPanel() {
    const radio = useRadio();
    const [cfg, setCfg] = useState(loadState);
    const [messages, setMessages] = useState([]);

    // The sources run outside React and call into the radio whenever hardware
    // moves, so they read the current state through a ref rather than closing
    // over the render that happened to create them.
    const ctxRef = useRef(null);
    ctxRef.current = {
        actions: radio.actions,
        stepHz: cfg.stepHz,
        state: () => ({
            tuning: radio.tuning,
            audio: radio.audio,
            squelch: radio.squelch,
            dsp: radio.dsp,
        }),
    };
    const ctx = useMemo(() => ({
        get actions() { return ctxRef.current.actions; },
        get stepHz() { return ctxRef.current.stepHz; },
        state: () => ctxRef.current.state(),
    }), []);

    const pushMessage = useCallback((text, tone = 'info') => {
        const at = new Date();
        setMessages((prev) => [{ at, text, tone, id: `${at.getTime()}-${Math.random()}` }, ...prev].slice(0, MAX_MESSAGES));
    }, []);

    const update = useCallback((patch) => {
        setCfg((prev) => {
            const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
            saveState(next);
            return next;
        });
    }, []);

    const source = cfg.source;

    // Exactly one source may hold hardware. This is the only place anything is
    // released: not on unmount, because a panel unmounts every time it is
    // dragged to another dock, and a dock drag must not close a serial port.
    useEffect(() => { releaseExcept(source); }, [source]);

    return (
        <div className="stack">
            <Field label="Source">
                <Segmented
                    options={SOURCE_OPTIONS}
                    value={source}
                    onChange={(v) => update({ source: v })}
                    size="sm"
                    minItemWidth={84}
                />
            </Field>

            {source === 'off' && (
                <div className="note note--tight">
                    Pick a source to control this receiver from hardware. One at a time — two
                    surfaces mapped to the same thing would fight each other.
                </div>
            )}

            {source === 'flexcontrol' && (
                <SurfaceControl
                    key="flexcontrol"
                    id="flexcontrol"
                    cfg={cfg}
                    update={update}
                    ctx={ctx}
                    dspSchemas={radio.dsp.schemas}
                    onMessage={pushMessage}
                />
            )}

            {source === 'midi' && (
                <SurfaceControl
                    key="midi"
                    id="midi"
                    cfg={cfg}
                    update={update}
                    ctx={ctx}
                    dspSchemas={radio.dsp.schemas}
                    onMessage={pushMessage}
                />
            )}

            {source === 'radiosync' && (
                <RadioSyncControl cfg={cfg} update={update} ctx={ctx} onMessage={pushMessage} />
            )}

            {source !== 'off' && <MessageLog messages={messages} onClear={() => setMessages([])} />}
        </div>
    );
}

// --- the two mapped control surfaces ---------------------------------------

function SurfaceControl({ id, cfg, update, ctx, dspSchemas, onMessage }) {
    const isMidi = id === 'midi';
    const conf = cfg[id];
    const mappings = conf.mappings;

    // The surface outlives this component — see controls/sources.js — so every
    // piece of state below is seeded from it rather than from a default. A
    // remount after a dock drag has to show the connection that is still open.
    const surface = getSurface(id);

    const [connected, setConnected] = useState(() => surface.connected);
    const [devices, setDevices] = useState(() => (isMidi ? surface.devices() : []));
    const [deviceId, setDeviceId] = useState(() => (isMidi && surface.deviceId) || '');
    // Learn: null when idle, otherwise { fn, mapBoth, pressKey }.
    const [learn, setLearn] = useState(null);
    const [pick, setPick] = useState('');
    const fileRef = useRef(null);

    const dispatcher = useMemo(() => new Dispatcher(), []);
    dispatcher.setMappings(mappings);

    // Learn has to see the input before the dispatcher does, and both need the
    // values from this render — so the handler is kept in a ref and the
    // subscription is made once.
    const onInput = useRef(null);
    onInput.current = ({ key, event, isNoteOn, isNoteOff }) => {
        if (learn) {
            // "Map both" waits for the release so one button can fire the same
            // function twice — press to mute, release to unmute.
            if (learn.mapBoth && isNoteOn && !learn.pressKey) {
                setLearn({ ...learn, pressKey: key });
                return;
            }
            if (learn.mapBoth && learn.pressKey) {
                if (!isNoteOff) return;
                commit([learn.pressKey, key], learn.fn);
                return;
            }
            commit([key], learn.fn);
            return;
        }
        dispatcher.handle(key, event, ctx);
    };

    const commit = (keys, fn) => {
        const record = { function: fn, ...defaultThrottle(fn) };
        update((prev) => ({
            ...prev,
            [id]: {
                ...prev[id],
                mappings: Object.fromEntries([
                    ...Object.entries(prev[id].mappings),
                    ...keys.map((k) => [k, record]),
                ]),
            },
        }));
        onMessage(`Mapped ${keys.map(labelFor(isMidi)).join(' + ')} → ${functionLabel(fn, dspSchemas)}`, 'good');
        setLearn(null);
    };

    useEffect(() => {
        const offs = [
            surface.on('input', (e) => onInput.current(e)),
            surface.on('message', ({ text, tone }) => onMessage(text, tone)),
            surface.on('state', (s) => {
                setConnected(s.connected);
                if (!s.connected) setLearn(null);
            }),
        ];
        if (isMidi) offs.push(surface.on('devices', setDevices));
        // Unsubscribe only. The device stays claimed: releasing it belongs to
        // the source switch, not to this component going away.
        return () => offs.forEach((off) => off());
    }, [surface, isMidi, onMessage]);

    // Which CC addresses are endless encoders rather than faders. The surface
    // needs this to decide whether a value is a position or a delta.
    useEffect(() => {
        if (!isMidi) return;
        const rel = {};
        for (const [key, m] of Object.entries(mappings)) if (m.relative) rel[key] = true;
        surface.setRelative(rel);
    }, [isMidi, mappings, surface]);

    // Opening MIDI access is silent and grants no capability on its own, so it
    // happens as soon as this source is chosen; a serial port, by contrast,
    // cannot be opened without a click. The remembered device is preselected
    // but never auto-connected — an input bound behind the operator's back is
    // how a stray fader ends up retuning the receiver.
    useEffect(() => {
        if (!isMidi) return;
        surface.open().then((ok) => {
            if (!ok || surface.connected || !conf.device) return;
            const match = surface.devices().find((d) => d.name === conf.device);
            if (match) setDeviceId(match.id);
        });
    }, [isMidi, surface]);   // eslint-disable-line react-hooks/exhaustive-deps

    const available = isMidi ? midiAvailable() : flexAvailable();
    if (!available) {
        return (
            <div className="note note--warn">
                {isMidi
                    ? 'This browser has no Web MIDI API. Chrome or Edge is needed — Firefox has never shipped it.'
                    : 'This browser has no Web Serial API. Chrome or Edge is needed.'}
            </div>
        );
    }

    const groups = groupCatalogue(dspSchemas);
    const rows = Object.entries(mappings);

    return (
        <>
            <div className="rc-conn">
                <span className={`dot dot--${connected ? 'good' : 'bad'}`} />
                <span className="rc-conn__state">
                    {connected ? (isMidi ? surface.deviceName : 'FlexControl connected') : 'Not connected'}
                </span>
            </div>

            {isMidi && (
                <Field label="Device">
                    <select
                        className="select"
                        value={deviceId}
                        disabled={connected}
                        onChange={(e) => setDeviceId(e.target.value)}
                    >
                        <option value="">
                            {devices.length ? 'Choose a device…' : 'No MIDI devices found'}
                        </option>
                        {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                </Field>
            )}

            <div className="chip-row">
                {connected ? (
                    <Button variant="ghost" size="sm" onClick={() => surface.disconnect()}>
                        Disconnect
                    </Button>
                ) : (
                    <Button
                        variant="primary"
                        size="sm"
                        disabled={isMidi && !deviceId}
                        onClick={() => {
                            if (!isMidi) { surface.connect(); return; }
                            const d = surface.devices().find((x) => x.id === deviceId);
                            if (surface.connect(deviceId) && d) {
                                update((prev) => ({ ...prev, midi: { ...prev.midi, device: d.name } }));
                            }
                        }}
                    >
                        Connect
                    </Button>
                )}
            </div>

            <div className="divider" />

            <Field label="Step size" hint="for “step up” and “step down”">
                <select
                    className="select"
                    value={cfg.stepHz}
                    onChange={(e) => update({ stepHz: Number(e.target.value) })}
                >
                    {TUNING_STEPS.map((hz) => <option key={hz} value={hz}>{stepLabel(hz)}</option>)}
                </select>
            </Field>

            <div className="divider" />

            <span className="section-label">
                Learn
                {!connected && <span className="section-label__note">connect first</span>}
            </span>

            <Field label="Function">
                <select
                    className="select"
                    value={pick}
                    disabled={!connected || !!learn}
                    onChange={(e) => setPick(e.target.value)}
                >
                    <option value="">Choose a function…</option>
                    {groups.map(([name, items]) => (
                        <optgroup key={name} label={name}>
                            {items.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                        </optgroup>
                    ))}
                </select>
            </Field>

            {isMidi && !learn && (
                <Switch
                    checked={!!cfg.midi.mapBoth}
                    onChange={(v) => update((prev) => ({ ...prev, midi: { ...prev.midi, mapBoth: v } }))}
                    label="Map press and release"
                    disabled={!connected}
                />
            )}

            {learn ? (
                <div className="rc-learn">
                    <div className="rc-learn__msg">
                        {learn.mapBoth && learn.pressKey
                            ? 'Press captured — now release it'
                            : `Move the control for “${functionLabel(learn.fn, dspSchemas)}”`}
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setLearn(null)}>Cancel</Button>
                </div>
            ) : (
                <div className="chip-row">
                    <Button
                        variant="primary"
                        size="sm"
                        disabled={!connected || !pick}
                        onClick={() => setLearn({ fn: pick, mapBoth: isMidi && !!cfg.midi.mapBoth, pressKey: null })}
                    >
                        Learn
                    </Button>
                </div>
            )}

            <div className="divider" />

            <span className="section-label">
                Mappings
                <span className="section-label__note">{rows.length}</span>
            </span>

            {rows.length === 0 ? (
                <Empty>Nothing mapped yet.</Empty>
            ) : (
                <div className="rc-map">
                    {rows.map(([key, m]) => (
                        <MappingRow
                            key={key}
                            mapKey={key}
                            mapping={m}
                            isMidi={isMidi}
                            dspSchemas={dspSchemas}
                            onRelative={(v) => update((prev) => ({
                                ...prev,
                                [id]: {
                                    ...prev[id],
                                    mappings: { ...prev[id].mappings, [key]: { ...m, relative: v } },
                                },
                            }))}
                            onDelete={() => update((prev) => {
                                const next = { ...prev[id].mappings };
                                delete next[key];
                                return { ...prev, [id]: { ...prev[id], mappings: next } };
                            })}
                        />
                    ))}
                </div>
            )}

            <div className="chip-row">
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon.Download size={13} />}
                    disabled={!rows.length}
                    onClick={() => onMessage(`Exported ${exportMappings(id, mappings)} mapping(s)`, 'good')}
                >
                    Export
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon.Upload size={13} />}
                    onClick={() => fileRef.current && fileRef.current.click()}
                >
                    Import
                </Button>
                <Button
                    size="sm"
                    variant="danger"
                    icon={<Icon.Trash size={13} />}
                    disabled={!rows.length}
                    onClick={() => {
                        update((prev) => ({ ...prev, [id]: { ...prev[id], mappings: {} } }));
                        onMessage('Cleared all mappings', 'info');
                    }}
                >
                    Clear
                </Button>
                <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                        const file = e.target.files && e.target.files[0];
                        e.target.value = '';   // so the same file can be picked twice
                        if (!file) return;
                        importMappings(file).then(
                            (m) => {
                                update((prev) => ({ ...prev, [id]: { ...prev[id], mappings: m } }));
                                onMessage(`Imported ${Object.keys(m).length} mapping(s)`, 'good');
                            },
                            (err) => onMessage(`Import failed: ${err.message}`, 'error'),
                        );
                    }}
                />
            </div>
        </>
    );
}

function MappingRow({ mapKey, mapping, isMidi, dspSchemas, onRelative, onDelete }) {
    const retired = RETIRED[mapping.function];
    const label = functionLabel(mapping.function, dspSchemas);
    // A CC could be either a fader or an endless encoder and one message cannot
    // tell them apart, so the row carries the switch rather than guessing.
    const isCC = isMidi && String(mapKey).startsWith(`${CC}:`);

    return (
        <div className="rc-map__row">
            <span className="rc-map__key">{labelFor(isMidi)(mapKey)}</span>
            <span className={`rc-map__fn${retired ? ' is-retired' : ''}`} title={retired || label}>
                {label}
            </span>
            {isCC && (
                <button
                    type="button"
                    className={`tag tag--ghost${mapping.relative ? ' tag--accent' : ''}`}
                    title="Endless encoder rather than a fader — sends increments, not a position"
                    onClick={() => onRelative(!mapping.relative)}
                >
                    {mapping.relative ? 'encoder' : 'fader'}
                </button>
            )}
            {mapping.mode === 'rate_limit' && mapping.throttleMs > 0 && (
                <span className="tag tag--ghost" title="Rate limited">{mapping.throttleMs}ms</span>
            )}
            <button type="button" className="rc-map__del" title="Remove" onClick={onDelete}>
                <Icon.Close size={13} />
            </button>
        </div>
    );
}

const labelFor = (isMidi) => (isMidi ? midiKeyLabel : flexKeyLabel);

function groupCatalogue(dspSchemas) {
    const groups = new Map();
    for (const f of catalogue(dspSchemas)) {
        if (!groups.has(f.group)) groups.set(f.group, []);
        groups.get(f.group).push(f);
    }
    return Array.from(groups.entries());
}

// --- Radio Sync -------------------------------------------------------------

const DIRECTIONS = [
    { value: 'sdr-to-radio', label: 'SDR → radio', title: 'The receiver leads; the rig follows it' },
    { value: 'radio-to-sdr', label: 'Radio → SDR', title: 'The rig leads; the receiver follows it' },
];

// Offered in place of the rig's own maximum, for a cable or a rig that will not
// hold the top rate reliably.
const BAUD_RATES = [0, 4800, 9600, 19200, 38400, 57600, 115200];

function RadioSyncControl({ cfg, update, ctx, onMessage }) {
    // Also a singleton: an open CAT link and a loaded 14 MB module must both
    // survive this panel being dragged to another dock.
    const sync = getSync();
    const [rigs, setRigs] = useState(() => sync.byManufacturer());
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState(() => sync.snapshot());

    sync.setContext(ctx);

    useEffect(() => {
        const offs = [
            sync.on('rigs', () => setRigs(sync.byManufacturer())),
            sync.on('loading', ({ loading: l }) => setLoading(l)),
            sync.on('state', setStatus),
            sync.on('message', ({ text, tone }) => onMessage(text, tone)),
        ];
        // The only place Hamlib is fetched. Choosing this source is the point at
        // which someone has asked for it; nobody who never opens Radio Sync
        // pays for 14 MB of WebAssembly. The promise is cached on the singleton,
        // so remounting this panel costs nothing.
        sync.ensureLoaded().catch(() => { /* reported through 'message' */ });
        return () => offs.forEach((off) => off());
    }, [sync, onMessage]);

    useEffect(() => {
        sync.setDirection(cfg.radiosync.direction);
        sync.setMuteOnTx(cfg.radiosync.muteOnTx);
    }, [sync, cfg.radiosync.direction, cfg.radiosync.muteOnTx]);

    if (!serialAvailable()) {
        return <div className="note note--warn">This browser has no Web Serial API. Chrome or Edge is needed.</div>;
    }

    const { rig } = status;
    const freqText = rig.frequency
        ? `${(rig.frequency / 1e6).toFixed(6)}`
        : '--.------';

    return (
        <>
            <div className="rc-rig">
                <div className="rc-rig__freq">{freqText}<span className="rc-rig__unit">MHz</span></div>
                <div className="rc-rig__row">
                    <span className="rc-rig__mode">{rig.mode || '---'}</span>
                    <span className={`rc-rig__tx${rig.tx ? ' is-tx' : ''}`}>
                        {status.connected ? (rig.tx ? 'TX' : 'RX') : '--'}
                    </span>
                </div>
            </div>

            {loading && <div className="note note--tight">Loading Hamlib — 14 MB of WebAssembly, fetched once per session.</div>}

            <Field label="Radio">
                <select
                    className="select"
                    value={cfg.radiosync.rig}
                    disabled={status.connected || loading || !rigs.length}
                    onChange={(e) => update((prev) => ({ ...prev, radiosync: { ...prev.radiosync, rig: e.target.value } }))}
                >
                    <option value="">{rigs.length ? 'Choose a radio…' : 'Loading rig list…'}</option>
                    {rigs.map(([mfg, models]) => (
                        <optgroup key={mfg} label={mfg}>
                            {models.map((r) => <option key={r.model} value={r.model}>{r.name}</option>)}
                        </optgroup>
                    ))}
                </select>
            </Field>

            <Field label="Baud rate">
                <select
                    className="select"
                    value={cfg.radiosync.baud}
                    disabled={status.connected}
                    onChange={(e) => update((prev) => ({ ...prev, radiosync: { ...prev.radiosync, baud: Number(e.target.value) } }))}
                >
                    {BAUD_RATES.map((b) => (
                        <option key={b} value={b}>{b === 0 ? 'Rig default' : b}</option>
                    ))}
                </select>
            </Field>

            <div className="chip-row">
                {status.connected ? (
                    <Button variant="ghost" size="sm" disabled={status.busy} onClick={() => sync.disconnect()}>
                        Disconnect
                    </Button>
                ) : (
                    <Button
                        variant="primary"
                        size="sm"
                        disabled={status.busy || loading || !cfg.radiosync.rig}
                        onClick={() => sync.connect(cfg.radiosync.rig, cfg.radiosync.baud)}
                    >
                        {status.busy ? 'Connecting…' : 'Connect'}
                    </Button>
                )}
            </div>

            <div className="divider" />

            <Field label="Direction">
                <Segmented
                    options={DIRECTIONS}
                    value={cfg.radiosync.direction}
                    onChange={(v) => update((prev) => ({ ...prev, radiosync: { ...prev.radiosync, direction: v } }))}
                    size="sm"
                />
            </Field>

            <Switch
                checked={cfg.radiosync.muteOnTx}
                onChange={(v) => update((prev) => ({ ...prev, radiosync: { ...prev.radiosync, muteOnTx: v } }))}
                label="Mute while the radio transmits"
            />

            <div className="note note--tight">
                A rig sitting in a data mode (PKTUSB, RTTY) is shown but not pushed either way —
                the receiver has no equivalent, and syncing it would drag the rig back out.
            </div>
        </>
    );
}

// --- shared log -------------------------------------------------------------

function MessageLog({ messages, onClear }) {
    if (!messages.length) return null;
    return (
        <>
            <div className="divider" />
            <span className="section-label">
                Messages
                <button type="button" className="section-label__note rc-log__clear" onClick={onClear}>clear</button>
            </span>
            <div className="log">
                {messages.map((m) => (
                    <div key={m.id} className={`log__row${m.tone === 'error' ? ' log__row--error' : m.tone === 'warn' ? ' log__row--warn' : ''}`}>
                        <span className="log__time">{m.at.toLocaleTimeString()}</span>
                        <span className="log__text">{m.text}</span>
                    </div>
                ))}
            </div>
        </>
    );
}
