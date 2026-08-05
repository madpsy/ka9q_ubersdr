// Radio Control — full CAT control of a transceiver, through Hamlib-in-wasm.
//
// Nothing is mapped here: the rig and the receiver simply follow each other,
// one leading and the other following, in whichever direction is chosen. That
// is what separates this from the mapped surfaces in SDR Control, where a
// control moves and a function runs — and why the two are separate panels. They
// can be used together: a MIDI box on the receiver and a rig tracking it are no
// conflict, only two ways of moving the same dial.
//
// Hamlib is fetched when this panel is first opened, and only then: it is 14 MB
// of WebAssembly, the panel ships collapsed, and opening it is the point at
// which someone has asked for CAT. The link and the loaded module then live on
// a singleton (controls/sources.js), so dragging the panel to another dock —
// which unmounts it — neither drops the rig nor re-downloads anything.

import React, { useEffect, useState } from '../react.js';
import { Button, Field, Segmented, Switch } from '../components/ui.jsx';
import { serialAvailable } from '../controls/radiosync.js';
import { getSync } from '../controls/sources.js';
import { MessageLog, useControlState, useMessages } from '../controls/panel.jsx';

const DIRECTIONS = [
    { value: 'sdr-to-radio', label: 'SDR → radio', title: 'The receiver leads; the rig follows it' },
    { value: 'radio-to-sdr', label: 'Radio → SDR', title: 'The rig leads; the receiver follows it' },
];

// Offered in place of the rig's own maximum, for a cable or a rig that will not
// hold the top rate reliably.
const BAUD_RATES = [0, 4800, 9600, 19200, 38400, 57600, 115200];

// `minimal` keeps the one thing here worth watching on its own: the rig's
// frequency, mode and TX state. See the registry's `minimal`.
export default function RadioControlPanel({ minimal }) {
    const [cfg, update] = useControlState();
    const [messages, pushMessage, clearMessages] = useMessages();

    // Also a singleton: an open CAT link and a loaded 14 MB module must both
    // survive this panel being dragged to another dock.
    const sync = getSync();
    const [rigs, setRigs] = useState(() => sync.byManufacturer());
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState(() => sync.snapshot());

    useEffect(() => {
        if (!serialAvailable()) return undefined;
        const offs = [
            sync.on('rigs', () => setRigs(sync.byManufacturer())),
            sync.on('loading', ({ loading: l }) => setLoading(l)),
            sync.on('state', setStatus),
            sync.on('message', ({ text, tone }) => pushMessage(text, tone)),
        ];
        // The only place Hamlib is fetched. Nobody who never opens this panel
        // pays for 14 MB of WebAssembly. The promise is cached on the singleton,
        // so remounting costs nothing.
        sync.ensureLoaded().catch(() => { /* reported through 'message' */ });
        return () => offs.forEach((off) => off());
    }, [sync, pushMessage]);

    if (!serialAvailable()) {
        return (
            <div className="stack">
                <div className="note note--warn">This browser has no Web Serial API. Chrome or Edge is needed.</div>
            </div>
        );
    }

    const { rig } = status;
    const freqText = rig.frequency
        ? `${(rig.frequency / 1e6).toFixed(6)}`
        : '--.------';

    const readout = (
        <div className="rc-rig">
            <div className="rc-rig__freq">{freqText}<span className="rc-rig__unit">MHz</span></div>
            <div className="rc-rig__row">
                <span className="rc-rig__mode">{rig.mode || '---'}</span>
                <span className={`rc-rig__tx${rig.tx ? ' is-tx' : ''}`}>
                    {status.connected ? (rig.tx ? 'TX' : 'RX') : '--'}
                </span>
            </div>
        </div>
    );

    // Just the rig readout: no rig or baud selection, no direction, no log. The
    // link itself is untouched — it lives on the sync singleton, so it stays
    // connected and the readout keeps updating. The load note stays too: 14 MB
    // is long enough that a readout stuck on dashes needs to say it is coming.
    if (minimal) {
        return (
            <div className="stack">
                {readout}
                {loading && <div className="note note--tight">Loading Hamlib…</div>}
            </div>
        );
    }

    return (
        <div className="stack">
            {readout}

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
                checked={cfg.radiosync.syncFrequency}
                onChange={(v) => update((prev) => ({ ...prev, radiosync: { ...prev.radiosync, syncFrequency: v } }))}
                label="Sync frequency"
                title="Keep the rig and the receiver on the same frequency"
            />

            <Switch
                checked={cfg.radiosync.syncMode}
                onChange={(v) => update((prev) => ({ ...prev, radiosync: { ...prev.radiosync, syncMode: v } }))}
                label="Sync mode"
                title="Keep the rig and the receiver in the same mode"
            />

            {!cfg.radiosync.syncFrequency && !cfg.radiosync.syncMode && (
                <div className="note note--tight">
                    Nothing is being synced — the readout above still follows the radio.
                </div>
            )}

            <Switch
                checked={cfg.radiosync.muteOnTx}
                onChange={(v) => update((prev) => ({ ...prev, radiosync: { ...prev.radiosync, muteOnTx: v } }))}
                label="Mute while the radio transmits"
            />

            <div className="note note--tight">
                A rig sitting in a data mode (PKTUSB, RTTY) is shown but not pushed either way —
                the receiver has no equivalent, and syncing it would drag the rig back out.
            </div>

            <MessageLog messages={messages} onClear={clearMessages} />
        </div>
    );
}
