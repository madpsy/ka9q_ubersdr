// SDR Control — drive this receiver from a hardware surface.
//
// Four of them, one at a time:
//
//   FlexControl   a FlexRadio USB dial, over Web Serial
//   RC-28         an Icom USB dial with three buttons, over WebHID
//   MIDI          any USB MIDI surface — DJ controller, knob box, fader bank
//   Gamepad       a game controller, USB or Bluetooth, over the Gamepad API
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
import { listSurfaces, onSurfaces } from '../controls/surfaces.js';
import { SURFACES, isMappedSurface } from '../controls/mappings.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { TUNING_STEPS, stepLabel } from '../radio/constants.js';
import {
    catalogue, functionIsContinuous, functionLabel, isEncoderFunction, isUnavailable, RETIRED,
} from '../controls/functions.js';
import { hardwareMessages } from '../controls/hardware.js';
import { pickFile } from '../lib/pickFile.js';
import { setLearnHandler, setManualOff, tryAutoConnect } from '../controls/dispatch.js';
import {
    defaultThrottle, exportMappings, importMappings, normaliseMidiMappings,
} from '../controls/mappings.js';
import { flexAvailable } from '../controls/flexcontrol.js';
import { rc28Available } from '../controls/rc28.js';
import { TX_LED_SOURCES, ledSettings } from '../controls/rc28leds.js';
import { isCCKey, midiAvailable } from '../controls/webmidi.js';
import {
    GAMEPAD_DEFAULT_MAPPINGS, gamepadAvailable, gamepadKeyRank, isAxisKey, otherHalf, rumbleSettings,
} from '../controls/gamepad.js';
import { getSurface, surfaceKeyLabel } from '../controls/sources.js';
import {
    bridgeAttached, bridgeSettings, onBridgeAttached, onBridgeSettings, setBridgeSettings,
} from '../bridge/settings.js';
import {
    MessageLog, useControlState, useHardware, useMessages,
} from '../controls/panel.jsx';

const SURFACE_OPTIONS = [
    { value: 'off', label: 'Off' },
    { value: 'flexcontrol', label: 'FlexControl' },
    { value: 'rc28', label: 'RC-28' },
    { value: 'midi', label: 'MIDI' },
    { value: 'gamepad', label: 'Gamepad', title: 'A game controller — Xbox, PlayStation, Switch Pro, 8BitDo — over USB or Bluetooth' },
];

// A pad's id string carries its vendor and product in brackets — "Xbox
// Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)". The
// whole of it is what is remembered; only the name is worth showing.
function padName(name) {
    return String(name || '').replace(/\s*\(.*\)\s*$/, '') || String(name || '');
}

const RUMBLE_STRENGTHS = [
    { value: 0.25, label: 'Light' },
    { value: 0.5, label: 'Medium' },
    { value: 1, label: 'Strong' },
];

// Where the bridge extension itself comes from. The switch below only says the
// page will answer one; somebody who has not installed it yet is looking at a
// switch for something they do not have, and the two stores are the answer.
const BRIDGE_ADDONS = [
    { label: 'Firefox', href: 'https://addons.mozilla.org/en-GB/firefox/addon/ubersdr-bridge/' },
    { label: 'Chrome', href: 'https://chromewebstore.google.com/detail/ubersdr-bridge/lpljgdehjhiojmpibmonpgjlmjfbkpae' },
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

    // Surfaces something else is hosting — the desktop client offering itself
    // as a TCI radio, say. Registered over the page API; see
    // controls/surfaces.js. They join the same picker as the ones this page can
    // open itself, and are exclusive with them for the same reason those are
    // exclusive with each other: two things mapped to frequency fight.
    const [external, setExternal] = useState(listSurfaces);
    useEffect(() => onSurfaces(setExternal), []);
    const provided = external.find((e) => e.id === surface) || null;
    // Chosen, and then whatever was providing it went away.
    const orphaned = surface !== 'off' && !SURFACES.includes(surface) && !provided;
    // One of the ones this page opens itself, and so the only kind with
    // mappings, a learn mode and a hardware connection behind it.
    const mapped = isMappedSurface(surface);

    const options = [
        ...SURFACE_OPTIONS,
        ...external.map((e) => ({ value: e.id, label: e.label, title: e.description || undefined })),
    ];

    const setField = (f, value) => update({
        surfaces: {
            ...(cfg.surfaces || {}),
            [surface]: { ...((cfg.surfaces || {})[surface]), [f.key]: value },
        },
    });

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
                        options={options}
                        value={surface}
                        onChange={(v) => update({ surface: v })}
                        size="sm"
                        minItemWidth={84}
                    />
                </Field>
            )}

            {orphaned && (
                <div className="note note--warn">
                    “{surface}” is not available any more — whatever was providing it has gone.
                    Choose another surface above.
                </div>
            )}

            {provided && (
                <>
                    {provided.description && (
                        <div className="note note--tight">{provided.description}</div>
                    )}
                    {provided.fields.map((f) => (
                        <Field key={f.key} label={f.label}>
                            <input
                                className="input"
                                type={f.type === 'password' ? 'password' : (f.type === 'number' ? 'number' : 'text')}
                                value={((cfg.surfaces || {})[surface] || {})[f.key] ?? f.default}
                                placeholder={f.placeholder || undefined}
                                onChange={(e) => setField(f, f.type === 'number' ? Number(e.target.value) : e.target.value)}
                            />
                        </Field>
                    ))}
                    <div className="note note--tight">
                        {provided.status.error
                            ? provided.status.error
                            : (provided.status.running
                                // The detail is where it can be reached — a
                                // server the operator has to point other
                                // software at is not much use until they know
                                // the address it settled on.
                                ? `${provided.status.detail || 'Running'} · ${provided.status.clients || 0} client${provided.status.clients === 1 ? '' : 's'} connected`
                                : 'Not running')}
                    </div>
                    {provided.audio && (
                        <div className="note note--tight">
                            This surface is sent the receiver&rsquo;s audio, ahead of the volume and
                            mute controls — muting the speakers does not silence it.
                        </div>
                    )}
                </>
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
                    from the Radio control panel is unaffected and can run alongside any of them.
                </div>
            )}

            {/* Only the ones this page hosts itself.
                SurfaceControl is the learn-and-map editor for a knob or a MIDI
                box: it reads `cfg[id].mappings` and drives `getSurface(id)`,
                neither of which exists for a surface somebody else is hosting.
                Rendering it for one is not a degraded panel, it is a crash on
                mount — which is what `surface !== 'off'` alone did the moment
                TCI was picked.

                Keyed on the built-in list rather than on `!provided`, so a
                surface whose provider has gone away is orphaned rather than
                mistaken for a mapped one. See isMappedSurface. */}
            {mapped && (
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

            {mapped && !minimal && <MessageLog messages={messages} onClear={clearMessages} />}
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
                    receiver.
                </div>
            )}
            {/* Shown whether the switch is on or off: off is exactly when
                somebody is deciding whether the extension is worth having, and
                a link that appeared only once they had already said yes would
                arrive after the question it answers. */}
            {!minimal && (
                <div className="bridge-get">
                    <span className="bridge-get__label">Get the extension</span>
                    {BRIDGE_ADDONS.map((a) => (
                        <a
                            key={a.label}
                            className="btn btn--ghost btn--sm"
                            href={a.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`UberSDR Bridge for ${a.label} — opens the store in a new tab`}
                        >
                            {a.label}
                            <Icon.External size={13} />
                        </a>
                    ))}
                </div>
            )}
            <div className="divider" />
        </>
    );
}

// --- the mapped control surfaces --------------------------------------------

function SurfaceControl({ id, cfg, update, dspSchemas, hw, onMessage, minimal }) {
    const isMidi = id === 'midi';
    const isRc28 = id === 'rc28';
    const isPad = id === 'gamepad';
    // The two that list their devices and remember one by name.
    const listed = isMidi || isPad;
    // The two whose buttons send a release as well as a press.
    const pressRelease = isMidi || isPad;
    const keyLabel = surfaceKeyLabel(id);
    const conf = cfg[id];
    const mappings = conf.mappings;

    // The surface outlives this component — see controls/sources.js — so every
    // piece of state below is seeded from it rather than from a default. A
    // remount after a dock drag has to show the connection that is still open.
    const surface = getSurface(id);

    const [connected, setConnected] = useState(() => surface.connected);
    const [devices, setDevices] = useState(() => (listed ? surface.devices() : []));
    const [deviceId, setDeviceId] = useState(() => (listed && surface.deviceId) || '');
    // Learn: null when idle, otherwise { fn, mapBoth, pressKey }.
    const [learn, setLearn] = useState(null);
    // The pad's setup mode, the other way round from learn: press a control,
    // then say what it does. Null when off, otherwise { key } — the key last
    // pressed, or null before anything has been.
    const [assign, setAssign] = useState(null);
    // The pad's last control, shown with what it is mapped to — the answer
    // to "which one is the right bumper?" without opening a manual.
    const [lastKey, setLastKey] = useState(null);
    // In the desktop client the pad drives one receiver window at a time —
    // see GamepadControl.setActive. False while another window has it.
    const [padActive, setPadActive] = useState(() => !isPad || surface.active !== false);
    const [pick, setPick] = useState('');
    const [limit, setLimit] = useState(PAGE);

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
    onInput.current = ({ key, isNoteOn, isNoteOff, repeat }) => {
        if (assign) {
            // Releases and repeats are the same control again, not a new one.
            if (!isNoteOff && !repeat) setAssign((a) => (a && a.key === key ? a : { key }));
            return true;
        }
        if (!learn) return false;
        // "Map both" waits for the release so one button can fire the same
        // function twice — press to mute, release to unmute.
        // A stick half has no release to wait for, so it maps as one.
        if (learn.mapBoth && isNoteOn && !learn.pressKey && !isAxisKey(key)) {
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
        // The RC-28 paces its own dial (see rc28.js), so a limit here would
        // only drop the counts it gathered.
        // A pad paces itself as well: its sticks send at a rate, and a limit
        // would drop detents rather than slow them.
        const record = { function: fn, ...(isRc28 || isPad ? { throttleMs: 0, mode: 'none' } : defaultThrottle(fn)) };
        // Learn cannot tell an encoder from a fader by watching one message, but
        // the function can: the frequency encoders and the zoom dial take
        // nothing else, so a CC landing on one is an encoder and is recorded as
        // such. Without this the mapping stores a fader, every detent arrives as
        // a position, and the wheel does nothing.
        const encoder = isMidi && isEncoderFunction(fn, dspSchemas);
        const recordFor = (k) => (encoder && isCCKey(k) ? { ...record, relative: true } : record);
        // A stick learned for something it can turn up and down takes both
        // directions: pushing right to tune up, and left had better tune down.
        // For a press — "Next mode" — only the way it was pushed.
        if (isPad && functionIsContinuous(fn, dspSchemas, hw)) {
            keys = keys.flatMap((k) => (isAxisKey(k) ? [k, otherHalf(k)] : [k]));
        }
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
        const sorted = sortRows(Object.entries(next[id].mappings), id, keyLabel);
        const last = Math.max(...keys.map((k) => sorted.findIndex(([rk]) => rk === k)));
        setLimit((n) => Math.max(n, last + 1));
        onMessage(`Mapped ${keys.map(keyLabel).join(' + ')} → ${functionLabel(fn, dspSchemas, hw)}`, 'good');
        setLearn(null);
        if (isPad) padConfirm();
    };

    const padConfirm = () => {
        const r = rumbleSettings(conf.rumble);
        if (r.enabled && r.confirm) surface.rumble('confirm', r.strength);
    };

    // Setup mode's own write: one control, one function, or none. A stick
    // half given something it can turn up and down takes its other half too,
    // as in learn; clearing one clears only it.
    const assignTo = (key, fn) => {
        update((prev) => {
            const next = { ...prev[id].mappings };
            if (!fn) {
                delete next[key];
            } else {
                const record = { function: fn, throttleMs: 0, mode: 'none' };
                next[key] = record;
                if (isAxisKey(key) && functionIsContinuous(fn, dspSchemas, hw)) next[otherHalf(key)] = record;
            }
            return { ...prev, [id]: { ...prev[id], mappings: next } };
        });
        if (fn) {
            onMessage(`Mapped ${keyLabel(key)} → ${functionLabel(fn, dspSchemas, hw)}`, 'good');
            padConfirm();
        } else {
            onMessage(`Cleared ${keyLabel(key)}`, 'info');
        }
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
                if (!s.connected) { setLearn(null); setAssign(null); }
            }),
        ];
        if (isPad) {
            // Releases and repeats are not a new control, and a stick sends a
            // stream — the same key again is no re-render.
            offs.push(surface.on('input', (e) => { if (!e.isNoteOff && !e.repeat) setLastKey(e.key); }));
            offs.push(surface.on('active', setPadActive));
        }
        // A surface that was not attached at load appears in this list when it
        // is plugged in. Connecting to it on the strength of that is
        // ControlWatch's — it has to happen with the panel closed too — so all
        // that is left here is showing it in the picker.
        if (listed) offs.push(surface.on('devices', setDevices));
        // Unsubscribe only. The device stays claimed: releasing it belongs to
        // the surface switch, not to this component going away.
        return () => offs.forEach((off) => off());
    }, [surface, listed, isPad, onMessage]);

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
        if (!listed) return;
        surface.open().then((ok) => {
            if (!ok || surface.connected || !conf.device) return;
            const match = surface.devices().find((d) => d.name === conf.device);
            if (match) setDeviceId(match.id);
        });
    }, [listed, surface]);   // eslint-disable-line react-hooks/exhaustive-deps

    // A pad appears only once a button on it is pressed, and usually there is
    // one. Whatever turns up is chosen for the operator — the remembered one
    // if it is among them — so pressing a button and then Connect is all of it.
    useEffect(() => {
        if (!isPad || connected || !devices.length) return;
        if (devices.some((d) => d.id === deviceId)) return;
        const match = devices.find((d) => d.name === conf.device) || devices[0];
        setDeviceId(match.id);
    }, [isPad, connected, devices, deviceId, conf.device]);

    const available = isMidi ? midiAvailable()
        : (isRc28 ? rc28Available() : (isPad ? gamepadAvailable() : flexAvailable()));
    if (!available) {
        // Chrome hides WebHID, Web Serial and Web MIDI from plain-http pages,
        // so there the browser is right and the address is what is wrong.
        if (typeof window !== 'undefined' && window.isSecureContext === false) {
            return (
                <div className="note note--warn">
                    {isMidi ? 'MIDI devices' : (isRc28 ? 'The RC-28' : (isPad ? 'Game controllers' : 'Serial ports'))} need this receiver to be opened over https — browsers only offer them to secure pages.
                </div>
            );
        }
        return (
            <div className="note note--warn">
                {isMidi && 'This browser has no Web MIDI API. Chrome or Edge is needed — Firefox has never shipped it.'}
                {isRc28 && 'This browser has no WebHID API. Chrome or Edge is needed — Firefox and Safari have not shipped it.'}
                {isPad && 'This browser has no Gamepad API.'}
                {!isMidi && !isRc28 && !isPad && 'This browser has no Web Serial API. Chrome or Edge is needed.'}
            </div>
        );
    }

    const conn = (
        <div className="rc-conn">
            <span className={`dot dot--${connected ? 'good' : 'bad'}`} />
            <span className="rc-conn__state">
                {connected
                    ? (isMidi ? surface.deviceName
                        : (isPad ? padName(surface.deviceName) : `${isRc28 ? 'RC-28' : 'FlexControl'} connected`))
                    : 'Not connected'}
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
            disabled={listed && !deviceId}
            onClick={() => {
                setManualOff(id, false);
                if (!listed) { surface.connect(); return; }
                const d = surface.devices().find((x) => x.id === deviceId);
                if (surface.connect(deviceId) && d) {
                    update((prev) => ({ ...prev, [id]: { ...prev[id], device: d.name } }));
                }
            }}
        >
            Connect
        </Button>
    );

    // What autoconnect will reach for, said plainly: it can only ever be the
    // remembered MIDI device or a serial port already granted, and if there is
    // none the switch is honest about having nothing to do yet.
    const autoHint = listed
        ? (conf.device ? `Reconnects to ${isPad ? padName(conf.device) : conf.device}` : 'Connect once first, so there is a device to remember')
        : (isRc28
            ? 'Reopens the dial once you have picked it here'
            : 'Reopens the dial once you have picked its port here');

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
    const rows = sortRows(Object.entries(mappings), id, keyLabel);
    const lastMapping = lastKey ? mappings[lastKey] : null;

    return (
        <>
            {conn}

            {listed && (
                <Field label={isPad ? 'Controller' : 'Device'}>
                    <select
                        className="select"
                        value={deviceId}
                        disabled={connected}
                        onChange={(e) => setDeviceId(e.target.value)}
                    >
                        <option value="">
                            {devices.length
                                ? 'Choose a device…'
                                : (isPad ? 'Press a button on the controller…' : 'No MIDI devices found')}
                        </option>
                        {devices.map((d) => (
                            <option key={d.id} value={d.id}>{isPad ? padName(d.name) : d.name}</option>
                        ))}
                    </select>
                </Field>
            )}

            {/* The browser shows no controller until one of its buttons is
                pressed, so the empty list above is the first thing everybody
                sees. These are the steps out of it. */}
            {isPad && !connected && (
                <ol className="note note--tight pad-steps">
                    <li>Pair the controller in your computer&rsquo;s Bluetooth settings, or plug it in.</li>
                    <li>Press any button on it, so the browser lets this page see it.</li>
                    <li>Press Connect. It arrives mapped — sticks tune, the D-pad steps and zooms.</li>
                </ol>
            )}

            <div className="chip-row">{button}</div>

            {auto}

            {isPad && connected && !padActive && (
                <div className="note note--tight">
                    Another receiver window has the controller. Click this window to take it.
                </div>
            )}

            {isPad && connected && padActive && !learn && !assign && (
                <div className="note note--tight" aria-live="polite">
                    {lastKey
                        ? <>Last: <strong>{keyLabel(lastKey)}</strong> → {lastMapping
                            ? functionLabel(lastMapping.function, dspSchemas, hw)
                            : 'nothing mapped'}</>
                        : 'Press a control to see what it does. Works while this page is on screen.'}
                </div>
            )}

            {isPad && (
                <PadRumble
                    rumble={rumbleSettings(conf.rumble)}
                    connected={connected}
                    canRumble={connected && surface.canRumble()}
                    onTest={() => {
                        const r = rumbleSettings(conf.rumble);
                        if (!surface.rumble('on', r.strength)) onMessage('This controller has no motor the browser can reach', 'warn');
                    }}
                    onChange={(patch) => update((prev) => ({
                        ...prev,
                        gamepad: { ...prev.gamepad, rumble: { ...rumbleSettings(prev.gamepad.rumble), ...patch } },
                    }))}
                />
            )}

            {isRc28 && (
                <RC28Leds
                    leds={ledSettings(conf.leds)}
                    onChange={(patch) => update((prev) => ({
                        ...prev,
                        rc28: { ...prev.rc28, leds: { ...ledSettings(prev.rc28.leds), ...patch } },
                    }))}
                />
            )}

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
                    disabled={!connected || !!learn || !!assign}
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

            {pressRelease && !learn && !assign && (
                <Switch
                    checked={!!conf.mapBoth}
                    onChange={(v) => update((prev) => ({ ...prev, [id]: { ...prev[id], mapBoth: v } }))}
                    label="Map press and release"
                    disabled={!connected}
                />
            )}

            {assign ? (
                <PadAssign
                    assignKey={assign.key}
                    mapping={assign.key ? mappings[assign.key] : null}
                    keyLabel={keyLabel}
                    groups={groups}
                    onPick={(fn) => assignTo(assign.key, fn)}
                    onDone={() => setAssign(null)}
                />
            ) : learn ? (
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
                        onClick={() => setLearn({ fn: pick, mapBoth: pressRelease && !!conf.mapBoth, pressKey: null })}
                    >
                        Learn
                    </Button>
                    {/* The other way round, for a pad: press a control and
                        choose what it does, one after another, with nothing
                        reaching the receiver meanwhile. */}
                    {isPad && (
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={!connected}
                            title="Press each control in turn and pick what it does — the receiver ignores the pad meanwhile"
                            onClick={() => setAssign({ key: null })}
                        >
                            Set up by pressing
                        </Button>
                    )}
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
                            isPad={isPad}
                            keyLabel={keyLabel}
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

            {/* `count` off: ShowMore's other branch is a "34 shown" line, and the section
                label above already says 34. No longer gated on there being more to see —
                a fully grown list is when the "Show fewer" under it is wanted. */}
            <ShowMore
                shown={limit}
                total={rows.length}
                base={PAGE}
                count={false}
                onMore={() => setLimit((n) => n + PAGE)}
                onLess={() => setLimit(PAGE)}
                label="Show more mappings"
            />

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
                {/* The picker is lib/pickFile.js, not a hidden input beside
                    this button — see the note there: a panel need not survive
                    the dialog it opened, and a change event on an unmounted
                    input is delivered to nothing at all. */}
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon.Upload size={13} />}
                    onClick={async () => {
                        const file = await pickFile({ accept: 'application/json,.json' });
                        if (!file) return;
                        try {
                            const m = await importMappings(file);
                            // A v1 file carries no encoder flag — see
                            // normaliseMidiMappings.
                            const next = isMidi ? normaliseMidiMappings(m) : m;
                            update((prev) => ({ ...prev, [id]: { ...prev[id], mappings: next } }));
                            // A fresh list, so back to the first page —
                            // importing forty mappings must not leave the panel
                            // forty rows tall.
                            setLimit(PAGE);
                            onMessage(`Imported ${Object.keys(next).length} mapping(s)`, 'good');
                        } catch (err) {
                            onMessage(`Import failed: ${err.message}`, 'error');
                        }
                    }}
                >
                    Import
                </Button>
                {isPad && (
                    <Button
                        size="sm"
                        variant="ghost"
                        title="Put back the mapping the controller arrives with"
                        onClick={() => {
                            update((prev) => ({ ...prev, gamepad: { ...prev.gamepad, mappings: GAMEPAD_DEFAULT_MAPPINGS } }));
                            setLimit(PAGE);
                            onMessage('Restored the default controller mapping', 'info');
                        }}
                    >
                        Defaults
                    </Button>
                )}
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
            </div>
        </>
    );
}

// The pad's setup mode: press a control, pick what it does, press the next.
// Learn asks for the function first, which suits a knob box whose controls
// have no names; a pad's controls do have names, and somebody holding one
// thinks "what should this button do", not "which button should do this".
// The function list writes as soon as it changes, so there is no save step to
// forget, and nothing reaches the receiver while the mode is on.
function PadAssign({ assignKey, mapping, keyLabel, groups, onPick, onDone }) {
    return (
        <div className="rc-learn rc-learn--assign">
            <div className="rc-learn__msg">
                {assignKey
                    ? <>
                        <strong>{keyLabel(assignKey)}</strong>
                        {isAxisKey(assignKey) && ' — a function that goes up and down takes both directions'}
                    </>
                    : 'Press or move any control on the controller'}
            </div>
            {assignKey && (
                <select
                    className="select"
                    value={mapping ? mapping.function : ''}
                    onChange={(e) => onPick(e.target.value)}
                    aria-label={`What ${keyLabel(assignKey)} does`}
                >
                    <option value="">Nothing</option>
                    {groups.map(([name, items]) => (
                        <optgroup key={name} label={name}>
                            {items.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                        </optgroup>
                    ))}
                </select>
            )}
            <Button variant="primary" size="sm" onClick={onDone}>Done</Button>
        </div>
    );
}

// Rumble, all of it optional. Shown before connecting so it can be set up
// first; the note about a missing motor only once there is a pad to ask.
function PadRumble({ rumble, connected, canRumble, onTest, onChange }) {
    return (
        <>
            <div className="divider" />
            <span className="section-label">Rumble</span>
            <Switch
                checked={rumble.enabled}
                onChange={(v) => onChange({ enabled: v })}
                label="Rumble for feedback"
                title="Short pulses from the controller's motors — only for the things ticked below"
            />
            {rumble.enabled && (
                <>
                    <Field label="Strength" inline>
                        <Segmented
                            options={RUMBLE_STRENGTHS}
                            value={RUMBLE_STRENGTHS.reduce((best, o) => (
                                Math.abs(o.value - rumble.strength) < Math.abs(best.value - rumble.strength) ? o : best
                            )).value}
                            onChange={(v) => onChange({ strength: v })}
                            size="sm"
                        />
                    </Field>
                    <Switch
                        checked={rumble.toggles}
                        onChange={(v) => onChange({ toggles: v })}
                        label="On/off: one pulse for on, two for off"
                        title="For toggles — mute, tuning lock, squelch and the like — so you know which way it went without looking"
                    />
                    <Switch
                        checked={rumble.refused}
                        onChange={(v) => onChange({ refused: v })}
                        label="Buzz when a control is ignored"
                        title="The control is mapped to something it cannot drive"
                    />
                    <Switch
                        checked={rumble.confirm}
                        onChange={(v) => onChange({ confirm: v })}
                        label="Pulse on connect and when a control is mapped"
                    />
                    <Switch
                        checked={rumble.ticks}
                        onChange={(v) => onChange({ ticks: v })}
                        label="Tick at each step while tuning"
                        title="Like the detents of a dial: a tick each time the frequency crosses a multiple of the step size"
                    />
                    <div className="chip-row">
                        <Button size="sm" variant="ghost" disabled={!connected} onClick={onTest}>Test</Button>
                    </div>
                    {connected && !canRumble && (
                        <div className="note note--tight">
                            The browser cannot reach a motor on this controller. Chrome and Edge drive
                            Xbox and PlayStation pads; others vary.
                        </div>
                    )}
                </>
            )}
        </>
    );
}

// What the RC-28's four lamps show. Every one is the operator's to turn off —
// see controls/rc28leds.js for what each means and why the defaults are what
// they are. Usable before connecting, so it can be set up and then plugged in.
function RC28Leds({ leds, onChange }) {
    return (
        <>
            <div className="divider" />
            <span className="section-label">LEDs</span>
            <Switch
                checked={leds.linkBlink}
                onChange={(v) => onChange({ linkBlink: v })}
                label="Blink Link while the receiver is not streaming"
                title="Link is lit while the dial is connected; this makes it blink while the receiver's audio is down or reconnecting"
            />
            <Switch
                checked={leds.follow}
                onChange={(v) => onChange({ follow: v })}
                label="Light F1 and F2 while what they control is on"
                title="For on/off functions and modes — tuning lock, mute, squelch, noise reduction, announcements, USB and the rest. Uses the tap mapping, or the hold mapping if the tap has none"
            />
            <Switch
                checked={leds.hold}
                onChange={(v) => onChange({ hold: v })}
                label="Flip a button's LED once a press counts as a hold"
                title="Holds fire on release; this shows the moment letting go stops being a tap"
            />
            <Field label="TX LED">
                <select
                    className="select"
                    value={leds.tx}
                    onChange={(e) => onChange({ tx: e.target.value })}
                >
                    {TX_LED_SOURCES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
            </Field>
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
function MappingRow({ mapKey, mapping, isMidi, isPad, keyLabel, dspSchemas, hw, onRelative, onDelete }) {
    const retired = RETIRED[mapping.function];
    const label = functionLabel(mapping.function, dspSchemas, hw);
    // A mapping that came from a receiver with a rotator, an antenna past
    // this switch's count, or a band this receiver cannot reach. Kept, named, and marked — deleting it on arrival
    // would quietly edit a file the operator carries between two receivers.
    const missing = !retired && isUnavailable(mapping.function, dspSchemas, hw);
    // A CC could be either a fader or an endless encoder and one message cannot
    // tell them apart, so the row carries the switch rather than guessing.
    const isCC = isMidi && isCCKey(mapKey);
    // A stick half is a rate or a single press depending on its function —
    // see controls/gamepad.js — and that is worth seeing on the row.
    const stick = isPad && isAxisKey(mapKey);
    const rate = stick && functionIsContinuous(mapping.function, dspSchemas, hw);

    return (
        <div className="rc-map__row">
            <span className={`rc-map__fn${retired ? ' is-retired' : ''}`} title={retired || label}>
                {label}
            </span>
            <button type="button" className="rc-map__del" title="Remove" onClick={onDelete}>
                <Icon.Close size={13} />
            </button>
            <div className="rc-map__meta">
                <span className="rc-map__key">{keyLabel(mapKey)}</span>
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
                {stick && (
                    <span
                        className="tag tag--ghost"
                        title={rate ? 'Sends faster the further it is pushed' : 'One press each time it is pushed over'}
                    >
                        {rate ? 'rate' : 'press'}
                    </span>
                )}
                {mapping.mode === 'rate_limit' && mapping.throttleMs > 0 && (
                    <span className="tag tag--ghost" title="Rate limited">{mapping.throttleMs}ms</span>
                )}
                {missing && (
                    <span className="tag tag--bad" title="This receiver has no such hardware, or cannot tune that band — the mapping is kept for one that can">
                        not here
                    </span>
                )}
            </div>
        </div>
    );
}

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
function sortRows(entries, id, keyLabel) {
    if (id === 'gamepad') return sortByRank(entries, gamepadKeyRank);
    if (id !== 'midi') {
        return entries.slice().sort((a, b) => keyLabel(a[0]).localeCompare(keyLabel(b[0])));
    }
    return sortByRank(entries, (key) => {
        const [type, channel, number] = String(key).split(':').map(Number);
        if (![type, channel, number].every(Number.isFinite)) return null;
        return [channel, isCCKey(key) ? 0 : 1, number, type];
    });
}

// A pad sorts sticks first, then buttons in the order the pad numbers them —
// which puts the D-pad's four together and each release beside its press.
function sortByRank(entries, rank) {
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
