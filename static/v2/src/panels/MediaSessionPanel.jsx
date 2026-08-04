import React from '../react.js';
import { Field, Readout, Segmented, Switch } from '../components/ui.jsx';
import { SKIP_MODES, useMediaSession } from '../radio/media/MediaSessionContext.jsx';
import { buildMetadata } from '../radio/media/metadata.js';
import { useRadio } from '../radio/RadioContext.jsx';

// What the anchor means for the operator, rather than for the code. Nobody
// needs to know what a MediaStreamDestination is; they need to know whether
// turning this on changes anything else about how the receiver behaves.
const ANCHOR_NOTE = {
    none: 'Metadata only — nothing is playing that the OS can attach controls to. '
        + 'If no controls appear, this browser needs one of the other two.',
    bridge: 'Anchored to a hidden audio element fed from the existing stream. '
        + 'No extra bandwidth and no change to how audio is decoded.',
    stream: 'Anchored to a direct audio stream from the receiver. Same bandwidth — '
        + 'the server sends it instead of over the WebSocket, not as well as — '
        + 'but the audio scope, recorder and audio filters see nothing while it runs.',
};

// Which anchor a browser needs is not written down anywhere and moves between
// releases, so the detected one is a default rather than a verdict. Exposed
// because the failure mode is silent: nothing appears, and no error says why.
const ANCHOR_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: 'none', label: 'Metadata' },
    { value: 'bridge', label: 'Element' },
    { value: 'stream', label: 'Stream' },
];

const TYPE_LABELS = {
    cw: 'CW spots',
    dx: 'DX spots',
    voice: 'Voice',
    'bookmark-server': 'Bookmarks',
    'bookmark-local': 'My bookmarks',
};

function StateBadge({ state }) {
    const tone = state === 'active' ? 'open' : state === 'waiting' ? 'closed' : 'idle';
    const label = state === 'active' ? 'ON AIR' : state === 'waiting' ? 'WAITING' : 'OFF';
    return <span className={`badge badge--${tone}`}>{label}</span>;
}

// A preview of the card the OS is showing. Worth the space: this is the one
// feature of the receiver whose output you cannot see from the receiver, and
// without it the only way to check the album line is to pick up the phone.
function NowPlaying() {
    const { tuning, serverInfo } = useRadio();
    const { marker, lookup } = useMediaSession();

    const meta = buildMetadata({
        frequency: tuning.frequency,
        mode: tuning.mode,
        receiver: (serverInfo && serverInfo.receiver && serverInfo.receiver.callsign) || '',
        marker,
        lookup,
    });

    return (
        <div className="ms-card">
            {lookup && lookup.photo
                ? <img className="ms-card__art" src={lookup.photo} alt="" loading="lazy" />
                : <div className="ms-card__art ms-card__art--placeholder" aria-hidden="true" />}
            <div className="ms-card__text">
                <div className="ms-card__title">{meta.title}</div>
                <div className="ms-card__artist">{meta.artist}</div>
                <div className="ms-card__album">{meta.album}</div>
            </div>
        </div>
    );
}

// `minimal` drops the explanation and the ⏮/⏭ configuration, keeping the switch
// and the card — what you glance at, without what you set once.
export default function MediaSessionPanel({ minimal }) {
    const ms = useMediaSession();
    const { support, status, enabled, setEnabled, skipMode, setSkipMode,
        navTypes, setNavTypes, navTypeOptions, neighbours, anchor, setAnchor } = ms;

    if (!support.available) {
        return (
            <div className="stack">
                <div className="note note--tight">
                    This browser has no Media Session support, so there are no OS
                    media controls to drive.
                </div>
            </div>
        );
    }

    const toggleType = (type) => {
        const current = navTypes || navTypeOptions;
        const next = current.includes(type)
            ? current.filter((t) => t !== type)
            : navTypeOptions.filter((t) => current.includes(t) || t === type);
        // Everything selected is the same as no filter, and storing it as null
        // means a marker type added later is included rather than silently off.
        setNavTypes(next.length === navTypeOptions.length || next.length === 0 ? null : next);
    };

    return (
        <div className="stack">
            <div className="ms-head">
                <StateBadge state={status.state} />
                <span className="ms-head__note">
                    {status.state !== 'waiting' ? ''
                        : !status.running ? 'waiting for audio'
                        : 'connecting\u2026'}
                </span>
                <Switch checked={enabled} onChange={setEnabled} label={enabled ? 'On' : 'Off'} />
            </div>

            {status.error && <div className="note note--tight note--warn">{status.error}</div>}

            {enabled && <NowPlaying />}

            {!minimal && (
                <>
                    <Field
                        label="Anchor"
                        hint={anchor === 'auto' ? `auto → ${status.anchor}` : 'forced'}
                    >
                        <Segmented options={ANCHOR_OPTIONS} value={anchor} onChange={setAnchor} size="sm" />
                    </Field>
                    <div className="note note--tight">{ANCHOR_NOTE[status.anchor]}</div>

                    {/* The one thing that tells "the browser ignored us" apart
                        from "we never set anything". */}
                    {enabled && (
                        <div className="ms-head__note">
                            {status.card ? `OS card set: ${status.card}` : 'No OS card set yet.'}
                        </div>
                    )}

                    <div className="divider" />

                    <Field label="Skip buttons" hint={skipMode === 'marker' ? 'to spots' : 'by step'}>
                        <Segmented options={SKIP_MODES} value={skipMode} onChange={setSkipMode} size="sm" />
                    </Field>
                    <div className="note note--tight">
                        {skipMode === 'marker'
                            ? 'Previous and next jump to the nearest marker either side, falling back to a tuning step when there is none.'
                            : 'Previous and next step the dial by the tuning step set in the Receiver panel.'}
                    </div>

                    {skipMode === 'marker' && (
                        <>
                            <div className="chip-row chip-row--wrap">
                                {navTypeOptions.map((type) => {
                                    const on = !navTypes || navTypes.includes(type);
                                    return (
                                        <button
                                            key={type}
                                            type="button"
                                            className={`chip chip--button${on ? ' is-active' : ''}`}
                                            onClick={() => toggleType(type)}
                                        >
                                            {TYPE_LABELS[type] || type}
                                        </button>
                                    );
                                })}
                            </div>
                            <div className="ms-neighbours">
                                <Readout label="Prev" value={neighbours.prev ? neighbours.prev.name : '--'} />
                                <Readout label="Next" value={neighbours.next ? neighbours.next.name : '--'} />
                            </div>
                        </>
                    )}

                    {status.anchor === 'stream' && (
                        <div className="note note--tight">
                            On this browser the lock-screen controls need a direct
                            audio stream, which the server sends instead of the
                            WebSocket rather than as well as it — so bandwidth is
                            unchanged, but the audio scope, the recorder and the
                            audio filters have nothing to work on while this is on.
                            The S-meter and squelch are unaffected.
                            {status.streamMode === 'direct' &&
                                ' This browser could not use low-latency streaming, so expect a few seconds of delay.'}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
