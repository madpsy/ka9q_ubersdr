// SDR Control — drive this receiver from a hardware surface.
//
// Two of them, one at a time:
//
//   FlexControl   a FlexRadio USB dial, over Web Serial
//   MIDI          any USB MIDI surface — DJ controller, knob box, fader bank
//
// They are the same idea — a control moves, a mapped function runs — and share
// everything but their transport, so they share a mapping table here too. Only
// one runs at once: two surfaces mapped to frequency would fight each other,
// and one connection, one status and one log is what makes the panel legible.
//
// Radio Sync used to be a third choice in this picker and is now the Radio
// Control panel, because it is a different animal — nothing is mapped, the rig
// and the receiver simply follow each other — and because there was never a
// real conflict in running a knob box alongside a rig that tracks the receiver.
// The two panels still share their settings blob and this file's helpers.
//
// v1 ships these as separate extensions, each with its own copy of the mapping
// engine and its own way of reaching into the UI (reading slider ranges off
// `document.getElementById('bandwidth-low').min`, and so on). Here the logic is
// shared and everything goes through `actions`, so a mapped control takes
// exactly the path a click takes.

import React, { useEffect, useMemo, useRef, useState } from '../react.js';
import { Button, Empty, Field, Icon, Segmented, Switch } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { TUNING_STEPS, stepLabel } from '../radio/constants.js';
import { catalogue, functionLabel, RETIRED } from '../controls/functions.js';
import { Dispatcher, defaultThrottle, exportMappings, importMappings } from '../controls/mappings.js';
import { flexAvailable, flexKeyLabel } from '../controls/flexcontrol.js';
import { CC, midiAvailable, midiKeyLabel } from '../controls/webmidi.js';
import { getSurface, releaseSurfaceExcept } from '../controls/sources.js';
import { MessageLog, useControlContext, useControlState, useMessages } from '../controls/panel.jsx';

const SURFACE_OPTIONS = [
    { value: 'off', label: 'Off' },
    { value: 'flexcontrol', label: 'FlexControl' },
    { value: 'midi', label: 'MIDI' },
];

// `minimal` leaves the connection line alone — the indicator, the surface's
// name and the button that connects or drops it. Everything else here is setup:
// the picker, the step size, learn, the mapping table and the log are worked at
// once and then only occasionally, while whether the dial is still attached is
// worth a glance at any time. See the registry's `minimal`.
export default function SDRControlPanel({ minimal }) {
    const radio = useRadio();
    const [cfg, update] = useControlState();
    const [messages, pushMessage, clearMessages] = useMessages();
    const ctx = useControlContext(cfg.stepHz);

    const surface = cfg.surface;

    // Exactly one surface may hold hardware. This is the only place either is
    // released: not on unmount, because a panel unmounts every time it is
    // dragged to another dock, and a dock drag must not close a serial port.
    useEffect(() => { releaseSurfaceExcept(surface); }, [surface]);

    return (
        <div className="stack">
            {!minimal && (
                <Field label="Surface">
                    <Segmented
                        options={SURFACE_OPTIONS}
                        value={surface}
                        onChange={(v) => update({ surface: v })}
                        size="sm"
                        minItemWidth={84}
                    />
                </Field>
            )}

            {/* Minimal has no picker, so it says so rather than leaving the
                panel blank with nothing to explain why. */}
            {surface === 'off' && minimal && (
                <div className="note note--tight">No surface chosen — expand the panel to pick one.</div>
            )}

            {surface === 'off' && !minimal && (
                <div className="note note--tight">
                    Pick a surface to control this receiver from hardware. One at a time — two
                    surfaces mapped to the same thing would fight each other. A radio synced
                    from the Radio control panel is unaffected and can run alongside either.
                </div>
            )}

            {surface !== 'off' && (
                <SurfaceControl
                    key={surface}
                    id={surface}
                    cfg={cfg}
                    update={update}
                    ctx={ctx}
                    dspSchemas={radio.dsp.schemas}
                    onMessage={pushMessage}
                    minimal={minimal}
                />
            )}

            {surface !== 'off' && !minimal && <MessageLog messages={messages} onClear={clearMessages} />}
        </div>
    );
}

// --- the two mapped control surfaces ---------------------------------------

function SurfaceControl({ id, cfg, update, ctx, dspSchemas, onMessage, minimal }) {
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
        // the surface switch, not to this component going away.
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
    // happens as soon as this surface is chosen; a serial port, by contrast,
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

    const conn = (
        <div className="rc-conn">
            <span className={`dot dot--${connected ? 'good' : 'bad'}`} />
            <span className="rc-conn__state">
                {connected ? (isMidi ? surface.deviceName : 'FlexControl connected') : 'Not connected'}
            </span>
        </div>
    );

    const button = connected ? (
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
    );

    // The connection line and nothing else. The subscriptions above still run,
    // so a device unplugged while the panel is minimal turns the dot red here
    // just as it would in the full view — and a MIDI device remembered from
    // last time is already preselected, so Connect works without the picker.
    if (minimal) {
        return (
            <>
                {conn}
                <div className="chip-row">{button}</div>
            </>
        );
    }

    const groups = groupCatalogue(dspSchemas);
    const rows = Object.entries(mappings);

    return (
        <>
            {conn}

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

            <div className="chip-row">{button}</div>

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
