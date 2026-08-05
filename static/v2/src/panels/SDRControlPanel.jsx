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

import React, { useEffect, useRef, useState } from '../react.js';
import { Button, Empty, Field, Icon, Segmented, ShowMore, Switch } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { TUNING_STEPS, stepLabel } from '../radio/constants.js';
import {
    catalogue, functionLabel, isEncoderFunction, isUnavailable, RETIRED,
} from '../controls/functions.js';
import { hardwareMessages } from '../controls/hardware.js';
import { setLearnHandler, setManualOff, tryAutoConnect } from '../controls/dispatch.js';
import {
    defaultThrottle, exportMappings, importMappings, normaliseMidiMappings,
} from '../controls/mappings.js';
import { flexAvailable, flexKeyLabel } from '../controls/flexcontrol.js';
import { isCCKey, midiAvailable, midiKeyLabel } from '../controls/webmidi.js';
import { getSurface } from '../controls/sources.js';
import {
    bridgeAttached, bridgeSettings, onBridgeAttached, onBridgeSettings, setBridgeSettings,
} from '../bridge/settings.js';
import {
    MessageLog, useControlState, useHardware, useMessages,
} from '../controls/panel.jsx';

const SURFACE_OPTIONS = [
    { value: 'off', label: 'Off' },
    { value: 'flexcontrol', label: 'FlexControl' },
    { value: 'midi', label: 'MIDI' },
];

// Mapping rows shown before "show more". A dock panel never scrolls itself —
// the dock is the only scroller — so a fader bank with forty controls learned
// would otherwise make this panel a couple of thousand pixels tall and push
// everything below it out of the dock. Same answer as the band and bookmark
// lists, which page for the same reason.
const PAGE = 12;

// `minimal` leaves the connection line alone — the indicator, the surface's
// name and the button that connects or drops it. Everything else here is setup:
// the picker, the step size, learn, the mapping table and the log are worked at
// once and then only occasionally, while whether the dial is still attached is
// worth a glance at any time. See the registry's `minimal`.
export default function SDRControlPanel({ minimal }) {
    const radio = useRadio();
    const [cfg, update] = useControlState();
    const [messages, pushMessage, clearMessages] = useMessages();
    const hw = useHardware();

    const surface = cfg.surface;

    return (
        <div className="stack">
            {/* Above the surfaces because it is not one of them: the three
                below are mutually exclusive and hold hardware, and this holds
                nothing and runs alongside any of them. It is also the one most
                people here are looking for. */}
            <BridgeSwitch minimal={minimal} />

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
                    dspSchemas={radio.dsp.schemas}
                    hw={hw}
                    onMessage={pushMessage}
                    minimal={minimal}
                />
            )}

            {surface !== 'off' && !minimal && <MessageLog messages={messages} onClear={clearMessages} />}
        </div>
    );
}

// The page API, here because a browser extension driving this receiver is a
// control surface — the same list of functions, reached over a message channel
// instead of a knob. It is not one of the three above: those are mutually
// exclusive because they hold hardware, and this holds nothing.
//
// Minimal keeps the switch and the count, and drops the explanation.
function BridgeSwitch({ minimal }) {
    const [settings, setSettings] = useState(bridgeSettings);
    const [attached, setAttached] = useState(bridgeAttached);
    useEffect(() => onBridgeSettings(setSettings), []);
    useEffect(() => onBridgeAttached(setAttached), []);
    const on = settings.enabled !== false;

    return (
        <>
            <span className="section-label">
                Browser bridge
                {on && attached > 0 && (
                    <span className="section-label__note">
                        {attached === 1 ? '1 attached' : `${attached} attached`}
                    </span>
                )}
            </span>
            <Field label="Allow" inline>
                <Switch
                    checked={on}
                    onChange={(v) => setBridgeSettings({ enabled: v })}
                    label={on ? 'On' : 'Off'}
                    title="Lets a browser extension or userscript read and drive this receiver"
                />
            </Field>
            {!minimal && (
                <div className="note note--tight">
                    Lets a browser extension or userscript on this page read and drive this
                    receiver. Nothing on another site can reach it, and no password is shared.
                </div>
            )}
            <div className="divider" />
        </>
    );
}

// --- the two mapped control surfaces ---------------------------------------

function SurfaceControl({ id, cfg, update, dspSchemas, hw, onMessage, minimal }) {
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
    const [limit, setLimit] = useState(PAGE);
    const fileRef = useRef(null);

    // Learning is the one part of control that belongs to the panel: it only
    // means anything while somebody is watching for the light to come on.
    // Everything else — the mapping table driving the receiver — is
    // ControlWatch's, so it keeps working when this panel is collapsed.
    //
    // The handler is kept in a ref and installed once, because it needs the
    // values from the current render and the subscription must not churn.
    // Returning true means the event was taken and the dispatcher must not also
    // see it: while learning, every control on the surface is being offered up
    // rather than acted on.
    const onInput = useRef(null);
    onInput.current = ({ key, isNoteOn, isNoteOff }) => {
        if (!learn) return false;
        // "Map both" waits for the release so one button can fire the same
        // function twice — press to mute, release to unmute.
        if (learn.mapBoth && isNoteOn && !learn.pressKey) {
            setLearn({ ...learn, pressKey: key });
            return true;
        }
        if (learn.mapBoth && learn.pressKey) {
            if (isNoteOff) commit([learn.pressKey, key], learn.fn);
            return true;
        }
        commit([key], learn.fn);
        return true;
    };

    useEffect(() => setLearnHandler((e) => onInput.current(e)), []);

    const commit = (keys, fn) => {
        const record = { function: fn, ...defaultThrottle(fn) };
        // Learn cannot tell an encoder from a fader by watching one message, but
        // the function can: the frequency encoders and the zoom dial take
        // nothing else, so a CC landing on one is an encoder and is recorded as
        // such. Without this the mapping stores a fader, every detent arrives as
        // a position, and the wheel does nothing.
        const encoder = isMidi && isEncoderFunction(fn, dspSchemas);
        const recordFor = (k) => (encoder && isCCKey(k) ? { ...record, relative: true } : record);
        const next = update((prev) => ({
            ...prev,
            [id]: {
                ...prev[id],
                mappings: Object.fromEntries([
                    ...Object.entries(prev[id].mappings),
                    ...keys.map((k) => [k, recordFor(k)]),
                ]),
            },
        }));
        // Reveal what was just learned. The rows are in address order and the
        // list pages, so a new mapping can sort past the end of the page — and
        // learning a control only to watch nothing appear is exactly the
        // failure the message log exists to prevent.
        const sorted = sortRows(Object.entries(next[id].mappings), isMidi);
        const last = Math.max(...keys.map((k) => sorted.findIndex(([rk]) => rk === k)));
        setLimit((n) => Math.max(n, last + 1));
        onMessage(`Mapped ${keys.map(labelFor(isMidi)).join(' + ')} → ${functionLabel(fn, dspSchemas, hw)}`, 'good');
        setLearn(null);
    };

    // Autoconnect, when the operator has asked for it.
    //
    // Only ever to hardware already granted: a MIDI input whose name was
    // remembered from a Connect, a serial port already picked out of the OS
    // dialog. Neither can be claimed without that first deliberate act, which
    // is what makes doing it unattended reasonable. Nothing here reports a
    // failure — no dial plugged in is the normal state of a receiver nobody is
    // sitting at, not an error worth a line in the log.
    //
    // The rule itself, and the Disconnect that outranks it, live in dispatch.js
    // — ControlWatch runs the same one on load and on hotplug, which is what
    // makes an unattended receiver come up with its dial live. This is only the
    // panel's own triggers: the switch being turned on, and access being
    // granted while somebody is sitting here.
    const tryAuto = useRef(null);
    tryAuto.current = () => tryAutoConnect(id, conf);

    useEffect(() => {
        const offs = [
            surface.on('message', ({ text, tone }) => onMessage(text, tone)),
            surface.on('state', (s) => {
                setConnected(s.connected);
                // Whoever connected it — this panel, or ControlWatch on load or
                // on a hotplug — the picker shows what is actually open.
                setDeviceId(surface.deviceId || '');
                if (!s.connected) setLearn(null);
            }),
        ];
        // A surface that was not attached at load appears in this list when it
        // is plugged in. Connecting to it on the strength of that is
        // ControlWatch's — it has to happen with the panel closed too — so all
        // that is left here is showing it in the picker.
        if (isMidi) offs.push(surface.on('devices', setDevices));
        // Unsubscribe only. The device stays claimed: releasing it belongs to
        // the surface switch, not to this component going away.
        return () => offs.forEach((off) => off());
    }, [surface, isMidi, onMessage]);

    // The rotator and the antenna switch answer over HTTP, long after the press
    // that asked them to, and their failures are the ones an operator cannot
    // guess at: a password the panel never saved, thunderstorm mode, a bearing
    // the rotator would not take. They go in the same log as the surface's own
    // messages, which is the only thing on screen when the knob is the UI.
    useEffect(() => hardwareMessages.on('message', ({ text, tone }) => onMessage(text, tone)), [onMessage]);

    // Turning the switch on is the operator asking, so it clears a previous
    // manual Disconnect and connects there and then if the hardware is already
    // sitting there. Hotplug is ControlWatch's — it has to happen whether this
    // panel is open or not.
    useEffect(() => {
        if (conf.autoConnect) setManualOff(id, false);
        tryAuto.current();
    }, [conf.autoConnect, id]);   // eslint-disable-line react-hooks/exhaustive-deps

    // Opening MIDI access is silent and grants no capability on its own, so it
    // happens as soon as this surface is chosen; a serial port, by contrast,
    // cannot be opened without a click. The remembered device is preselected
    // and left there unless autoconnect is on — an input bound behind the
    // operator's back is how a stray fader ends up retuning the receiver.
    // Seeds the picker with the remembered surface so Connect is ready to press.
    // Connecting to it is ControlWatch's, which asks for access too — this only
    // needs the list once it is there.
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
        <Button
            variant="ghost"
            size="sm"
            onClick={() => {
                setManualOff(id, true);
                surface.disconnect();
            }}
        >
            Disconnect
        </Button>
    ) : (
        <Button
            variant="primary"
            size="sm"
            disabled={isMidi && !deviceId}
            onClick={() => {
                setManualOff(id, false);
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

    // What autoconnect will reach for, said plainly: it can only ever be the
    // remembered MIDI device or a serial port already granted, and if there is
    // none the switch is honest about having nothing to do yet.
    const autoHint = isMidi
        ? (conf.device ? `Reconnects to ${conf.device}` : 'Connect once first, so there is a device to remember')
        : 'Reopens the dial once you have picked its port here';

    const auto = (
        <Switch
            checked={!!conf.autoConnect}
            onChange={(v) => update((prev) => ({ ...prev, [id]: { ...prev[id], autoConnect: v } }))}
            label="Connect automatically"
            title={autoHint}
        />
    );

    // The connection line and nothing else. The subscriptions above still run,
    // so a device unplugged while the panel is minimal turns the dot red here
    // just as it would in the full view — and a MIDI device remembered from
    // last time is already preselected, so Connect works without the picker.
    // Autoconnect is setup rather than a connection state, so it stays in the
    // full view; it still works here, which is the point of it.
    if (minimal) {
        return (
            <>
                {conn}
                <div className="chip-row">{button}</div>
            </>
        );
    }

    const groups = groupCatalogue(dspSchemas, hw);
    const rows = sortRows(Object.entries(mappings), isMidi);

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

            {auto}

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
                            : `Move the control for “${functionLabel(learn.fn, dspSchemas, hw)}”`}
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
                    {rows.slice(0, limit).map(([key, m]) => (
                        <MappingRow
                            key={key}
                            mapKey={key}
                            mapping={m}
                            isMidi={isMidi}
                            dspSchemas={dspSchemas}
                            hw={hw}
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

            {/* Only when there is more to see: ShowMore's other branch is a
                "34 shown" line, and the section label above already says 34. */}
            {rows.length > limit && (
                <ShowMore
                    shown={limit}
                    total={rows.length}
                    onMore={() => setLimit((n) => n + PAGE)}
                    label="Show more mappings"
                />
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
                        setLimit(PAGE);
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
                                // A v1 file carries no encoder flag — see
                                // normaliseMidiMappings.
                                const next = isMidi ? normaliseMidiMappings(m) : m;
                                update((prev) => ({ ...prev, [id]: { ...prev[id], mappings: next } }));
                                // A fresh list, so back to the first page —
                                // importing forty mappings must not leave the
                                // panel forty rows tall.
                                setLimit(PAGE);
                                onMessage(`Imported ${Object.keys(next).length} mapping(s)`, 'good');
                            },
                            (err) => onMessage(`Import failed: ${err.message}`, 'error'),
                        );
                    }}
                />
            </div>
        </>
    );
}

// One mapping, on two lines: what it does, then which control does it.
//
// It was one line — control, function, chips, delete — and that only ever fit
// the panel floated wide. Docked at its usual width the key took its 42% and
// the function name, the thing you are actually scanning for, ellipsised to
// "Passb…". So the function goes on top with the full width to itself and wraps
// rather than truncates, and the address drops to a second line with the chips
// it qualifies. Nothing is hidden at any width the panel can be dragged to.
function MappingRow({ mapKey, mapping, isMidi, dspSchemas, hw, onRelative, onDelete }) {
    const retired = RETIRED[mapping.function];
    const label = functionLabel(mapping.function, dspSchemas, hw);
    // A mapping that came from a receiver with a rotator, or an antenna past
    // this switch's count. Kept, named, and marked — deleting it on arrival
    // would quietly edit a file the operator carries between two receivers.
    const missing = !retired && isUnavailable(mapping.function, dspSchemas, hw);
    // A CC could be either a fader or an endless encoder and one message cannot
    // tell them apart, so the row carries the switch rather than guessing.
    const isCC = isMidi && isCCKey(mapKey);

    return (
        <div className="rc-map__row">
            <span className={`rc-map__fn${retired ? ' is-retired' : ''}`} title={retired || label}>
                {label}
            </span>
            <button type="button" className="rc-map__del" title="Remove" onClick={onDelete}>
                <Icon.Close size={13} />
            </button>
            <div className="rc-map__meta">
                <span className="rc-map__key">{labelFor(isMidi)(mapKey)}</span>
                {isCC && (
                    <button
                        type="button"
                        className={`tag rc-map__mode${mapping.relative ? ' is-encoder' : ''}`}
                        title="Endless encoder rather than a fader — sends increments, not a position"
                        onClick={() => onRelative(!mapping.relative)}
                    >
                        {mapping.relative ? 'encoder' : 'fader'}
                    </button>
                )}
                {mapping.mode === 'rate_limit' && mapping.throttleMs > 0 && (
                    <span className="tag tag--ghost" title="Rate limited">{mapping.throttleMs}ms</span>
                )}
                {missing && (
                    <span className="tag tag--bad" title="This receiver has no such hardware — the mapping is kept for one that does">
                        not here
                    </span>
                )}
            </div>
        </div>
    );
}

const labelFor = (isMidi) => (isMidi ? midiKeyLabel : flexKeyLabel);

// Rows in the order they were learned, which is the order they arrive in from
// storage, are unordered by the time there are twenty of them — you learn the
// dial, then a button, then the dial's other direction. So they are laid out by
// address instead: the panel then matches the hardware, and the row you want is
// where the control is under your hand.
//
// MIDI sorts by channel, then CCs before notes, then number — which is also
// what keeps a "map both" pair adjacent, since a button's press and release
// share a number and differ only in type. Anything unparseable sorts last
// rather than throwing the order out.
function sortRows(entries, isMidi) {
    if (!isMidi) {
        return entries.slice().sort((a, b) => flexKeyLabel(a[0]).localeCompare(flexKeyLabel(b[0])));
    }
    const rank = (key) => {
        const [type, channel, number] = String(key).split(':').map(Number);
        if (![type, channel, number].every(Number.isFinite)) return null;
        return [channel, isCCKey(key) ? 0 : 1, number, type];
    };
    return entries.slice().sort((a, b) => {
        const ra = rank(a[0]);
        const rb = rank(b[0]);
        if (!ra || !rb) return (ra ? 0 : 1) - (rb ? 0 : 1);
        for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] - rb[i];
        return 0;
    });
}

function groupCatalogue(dspSchemas, hw) {
    const groups = new Map();
    for (const f of catalogue(dspSchemas, hw)) {
        if (!groups.has(f.group)) groups.set(f.group, []);
        groups.get(f.group).push(f);
    }
    return Array.from(groups.entries());
}
