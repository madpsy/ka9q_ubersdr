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
import { listProviders, onProviders } from '../controls/radioProviders.js';
import { MAX_FREQ, MIN_FREQ } from '../radio/constants.js';
import { MessageLog, useControlState, useMessages } from '../controls/panel.jsx';

const DIRECTIONS = [
    { value: 'sdr-to-radio', label: 'SDR → radio', title: 'The receiver leads; the rig follows it' },
    { value: 'radio-to-sdr', label: 'Radio → SDR', title: 'The rig leads; the receiver follows it' },
];

// Offered in place of the rig's own maximum, for a cable or a rig that will not
// hold the top rate reliably.
const BAUD_RATES = [0, 4800, 9600, 19200, 38400, 57600, 115200];

// One of a transport's own settings — an address, a port, a password.
//
// Committed when the edit is finished rather than on every keystroke. The value
// is what the transport connects to, and a provider that reconnects when it
// changes — both of the ones that exist do — would otherwise tear the link down
// and rebuild it once per character on the way to typing a port number.
//
// Never locked, not even while connected. Changing the address of a live link
// is exactly how somebody moves it, and both providers treat a new address as
// "go there instead"; disabling the field meant the only way to correct a port
// was to disconnect first, which is not something the panel ever said.
function ConfigField({ field, value, onCommit }) {
    const [draft, setDraft] = useState(() => String(value));
    // Follow the setting when it changes from anywhere else — another window
    // sharing these settings, or the transport being switched.
    useEffect(() => { setDraft(String(value)); }, [value]);

    const commit = () => {
        const next = field.type === 'number' ? Number(draft) : draft;
        if (field.type === 'number' && !Number.isFinite(next)) { setDraft(String(value)); return; }
        if (next !== value) onCommit(next);
    };

    return (
        <input
            className="input"
            type={field.type === 'password' ? 'password' : (field.type === 'number' ? 'number' : 'text')}
            value={draft}
            placeholder={field.placeholder || undefined}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') { commit(); e.currentTarget.blur(); }
                if (e.key === 'Escape') { setDraft(String(value)); e.currentTarget.blur(); }
            }}
        />
    );
}

// The rig readout, whichever transport produced it. One shape from two sources:
// the serial link reports through the sync singleton, a provider through the
// `radio` command, and the panel should look the same either way.
function RigReadout({ frequency, mode, tx, connected }) {
    const freqText = frequency ? `${(frequency / 1e6).toFixed(6)}` : '--.------';
    return (
        <div className="rc-rig">
            <div className="rc-rig__freq">{freqText}<span className="rc-rig__unit">MHz</span></div>
            <div className="rc-rig__row">
                <span className="rc-rig__mode">{mode || '---'}</span>
                <span className={`rc-rig__tx${tx ? ' is-tx' : ''}`}>
                    {connected ? (tx ? 'TX' : 'RX') : '--'}
                </span>
            </div>
        </div>
    );
}

// `minimal` keeps the one thing here worth watching on its own: the rig's
// frequency, mode and TX state. See the registry's `minimal`.
export default function RadioControlPanel({ minimal }) {
    const [cfg, update] = useControlState();
    const [messages, pushMessage, clearMessages] = useMessages();

    // Transports something outside the page offers — an extension, the desktop
    // client. Registered over the page API; see controls/radioProviders.js.
    const [providers, setProviders] = useState(listProviders);
    useEffect(() => onProviders(setProviders), []);

    const setSync = (patch) => update((prev) => ({ ...prev, radiosync: { ...prev.radiosync, ...patch } }));
    const transport = cfg.radiosync.transport || 'serial';
    const provider = providers.find((p) => p.id === transport) || null;

    // Also a singleton: an open CAT link and a loaded 14 MB module must both
    // survive this panel being dragged to another dock.
    const sync = getSync();
    const [rigs, setRigs] = useState(() => sync.byManufacturer());
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState(() => sync.snapshot());

    useEffect(() => {
        // Only the serial transport needs Hamlib, and only when it is the one
        // selected: a provider user should not be made to fetch 14 MB of
        // WebAssembly for a transport they are not using.
        if (!serialAvailable() || transport !== 'serial') return undefined;
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
    }, [sync, pushMessage, transport]);

    // Serial where the page can host it, plus whatever registered itself. One
    // button when there is only Serial, so a browser with nothing else attached
    // looks exactly as it did before any of this existed.
    const transports = [
        ...(serialAvailable() ? [{ value: 'serial', label: 'Serial', title: 'A rig on a serial cable, over Hamlib' }] : []),
        ...providers.map((p) => ({ value: p.id, label: p.label, title: `Provided by ${p.label}` })),
    ];

    if (!transports.length) {
        return (
            <div className="stack">
                <div className="note note--warn">
                    This browser has no Web Serial API, and nothing has offered another way to
                    reach a radio. Chrome or Edge can drive a rig on a serial cable; the desktop
                    client and the browser extension can also reach flrig.
                </div>
            </div>
        );
    }

    // A transport that was selected and has since gone away — the extension was
    // disabled, the desktop client closed the page. Saying so beats silently
    // pretending Serial was what they chose.
    const missing = transport !== 'serial' && !provider;

    const rig = provider ? provider.status : status.rig;
    const connected = provider ? !!provider.status.connected : status.connected;
    const busy = provider ? !!provider.status.busy : status.busy;

    // A rig somewhere the receiver cannot go — a 2 m handheld, a transverter's
    // IF — while the rig is the one leading. The tune is refused rather than
    // clamped, which is right, but silently: the readout shows the rig moving
    // and the receiver simply does not follow, with nothing on screen to say
    // why. Only while it matters: with the receiver leading, a rig out of range
    // is about to be brought into it.
    const following = connected && cfg.radiosync.direction === 'radio-to-sdr'
        && cfg.radiosync.syncFrequency;
    const outOfRange = following && rig.frequency
        && (rig.frequency < MIN_FREQ || rig.frequency > MAX_FREQ);

    const readout = (
        <>
            <RigReadout
                frequency={rig.frequency}
                mode={rig.mode}
                tx={rig.tx}
                connected={connected}
            />
            {outOfRange && (
                <div className="note note--warn note--tight">
                    The radio is outside this receiver&rsquo;s range
                    ({MIN_FREQ / 1000} kHz&ndash;{MAX_FREQ / 1e6} MHz), so the frequency
                    cannot follow it.
                </div>
            )}
        </>
    );

    // Always, even when Serial is the only one there is.
    //
    // It was hidden below two options, on the reasoning that a browser with
    // nothing else attached should look as it always had. That was wrong twice
    // over: it hid the answer to "what is this panel about to use", and it made
    // the control appear and disappear depending on whether an extension
    // happened to be installed — so somebody who read about the connection
    // picker could not find it, and had no way to tell why.
    const picker = (
        <Field label="Connection">
            <Segmented
                options={transports}
                value={transport}
                onChange={(v) => setSync({ transport: v, connect: false })}
                size="sm"
            />
        </Field>
    );

    // Whether the radio can say it is transmitting. Serial always can; a
    // provider says so when it registers, and may say otherwise once connected
    // — see radioProviders.js.
    const ptt = !provider || provider.capabilities.includes('ptt');

    // Everything below the transport's own controls is the same question
    // whichever one is in use: which way does the sync run, and what follows
    // what. Shared so the two branches cannot drift into different wording.
    const syncControls = (
        <>
            <div className="divider" />

            <Field label="Direction">
                <Segmented
                    options={DIRECTIONS}
                    value={cfg.radiosync.direction}
                    onChange={(v) => setSync({ direction: v })}
                    size="sm"
                />
            </Field>

            <Switch
                checked={cfg.radiosync.syncFrequency}
                onChange={(v) => setSync({ syncFrequency: v })}
                label="Sync frequency"
                title="Keep the rig and the receiver on the same frequency"
            />

            <Switch
                checked={cfg.radiosync.syncMode}
                onChange={(v) => setSync({ syncMode: v })}
                label="Sync mode"
                title="Keep the rig and the receiver in the same mode"
            />

            {!cfg.radiosync.syncFrequency && !cfg.radiosync.syncMode && (
                <div className="note note--tight">
                    Nothing is being synced — the readout above still follows the radio.
                </div>
            )}

            {/* Disabled rather than removed where the radio cannot report
                transmitting — plenty of Hamlib backends have no PTT to read.
                A control that is present for one connection and absent for
                another reads as a bug, and somebody who has used this switch
                before will go looking for it rather than conclude it was never
                there. The tooltip is where the reason lives. */}
            <Switch
                checked={cfg.radiosync.muteOnTx && ptt}
                disabled={!ptt}
                onChange={(v) => setSync({ muteOnTx: v })}
                label="Mute while the radio transmits"
                title={ptt
                    ? 'Silence the receiver while the radio is transmitting'
                    : 'This radio does not report when it is transmitting, so there is nothing to mute on'}
            />
        </>
    );

    // Just the rig readout: no rig or baud selection, no direction, no log. The
    // link itself is untouched — it lives on the sync singleton, so it stays
    // connected and the readout keeps updating. The load note stays too: 14 MB
    // is long enough that a readout stuck on dashes needs to say it is coming.
    if (minimal) {
        return (
            <div className="stack">
                {readout}
                {loading && transport === 'serial' && <div className="note note--tight">Loading Hamlib…</div>}
            </div>
        );
    }

    if (missing) {
        return (
            <div className="stack">
                {readout}
                {picker}
                <div className="note note--warn">
                    “{transport}” is not available any more — whatever was providing it has gone.
                    Choose another connection above.
                </div>
            </div>
        );
    }

    // A transport somebody else is hosting. The panel knows nothing about it
    // beyond the fields it asked for: it renders those, remembers what was
    // typed, and says whether it wants to be connected. Everything after that
    // — the protocol, the polling, the syncing — happens wherever the provider
    // lives, and comes back as status.
    if (provider) {
        // What was asked for, as against what happened: the two differ while a
        // connection is being refused, and the controls below follow the ask.
        const wantsConnect = !!cfg.radiosync.connect;
        const values = (cfg.radiosync.providers || {})[provider.id] || {};
        const valueOf = (f) => (values[f.key] === undefined ? f.default : values[f.key]);
        const setField = (f, value) => setSync({
            providers: {
                ...(cfg.radiosync.providers || {}),
                [provider.id]: { ...values, [f.key]: value },
            },
        });

        return (
            <div className="stack">
                {readout}
                {picker}

                {provider.fields.map((f) => (
                    <Field key={f.key} label={f.label}>
                        <ConfigField
                            field={f}
                            value={valueOf(f)}
                            onCommit={(v) => setField(f, v)}
                        />
                    </Field>
                ))}

                <div className="chip-row chip-row--split">
                    {wantsConnect ? (
                        <Button variant="ghost" size="sm" onClick={() => setSync({ connect: false })}>
                            {connected ? 'Disconnect' : 'Stop trying'}
                        </Button>
                    ) : (
                        <Button variant="primary" size="sm" onClick={() => setSync({ connect: true })}>
                            Connect
                        </Button>
                    )}
                    {/* Beside the button it governs, at the far end, because it
                        is about the next time the page opens rather than about
                        now — and pressing Connect is still what happens now. */}
                    <Switch
                        checked={!!cfg.radiosync.autoConnect}
                        onChange={(v) => setSync({ autoConnect: v })}
                        label="Auto-connect"
                        title="Connect to this radio on its own whenever the page opens"
                    />
                </div>

                {provider.status.error && (
                    <div className="note note--warn">
                        {provider.status.error}
                        {/* Said once, here, rather than left for somebody to
                            wonder about: the fields above are editable and a
                            correction is picked up without pressing anything. */}
                        {wantsConnect && ' — still trying; correct the settings above and it will pick them up.'}
                    </div>
                )}

                {wantsConnect && !connected && !provider.status.error && (
                    <div className="note note--tight">Connecting…</div>
                )}

                {syncControls}

                <MessageLog messages={messages} onClear={clearMessages} />
            </div>
        );
    }

    return (
        <div className="stack">
            {readout}
            {picker}

            {loading && <div className="note note--tight">Loading Hamlib — 14 MB of WebAssembly, fetched once per session.</div>}

            <Field label="Radio">
                <select
                    className="select"
                    value={cfg.radiosync.rig}
                    disabled={status.connected || loading || !rigs.length}
                    onChange={(e) => setSync({ rig: e.target.value })}
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
                    onChange={(e) => setSync({ baud: Number(e.target.value) })}
                >
                    {BAUD_RATES.map((b) => (
                        <option key={b} value={b}>{b === 0 ? 'Rig default' : b}</option>
                    ))}
                </select>
            </Field>

            <div className="chip-row chip-row--split">
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
                {/* Present but not available here, rather than absent: a control
                    that exists for one connection and not another reads as a
                    bug. Opening a serial port raises the browser's own port
                    picker, and that has to happen on the stack of a click — see
                    the note in controls/radiosync.js — so there is nothing a
                    page can do on load that would not be refused. */}
                <Switch
                    checked={false}
                    disabled
                    onChange={() => {}}
                    label="Auto-connect"
                    title="Not possible over serial: the browser only opens a port in response to a click"
                />
            </div>

            {syncControls}

            <div className="note note--tight">
                A rig sitting in a data mode (PKTUSB, RTTY) is shown but not pushed either way —
                the receiver has no equivalent, and syncing it would drag the rig back out.
            </div>

            <MessageLog messages={messages} onClear={clearMessages} />
        </div>
    );
}
