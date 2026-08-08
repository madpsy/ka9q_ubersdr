// Who else is on the receiver — v1's "Active Channels" block, in the dock.
//
// v1 puts this at the foot of the page as a wide table (frequency, mode,
// bandwidth, age, country, chat name, Go) with a "Show Map" button above it.
// A dock column is not wide enough for eight columns, so each listener is two
// lines instead: where they are tuned on the first, who and how recently on the
// second — the same fields, stacked. The map is the same popup, and it is the
// reason the compat bridge publishes `activeChannels` at all.
//
// Clicking a row tunes to that channel, as v1's Go button does. Your own row
// does not tune anywhere, and neither does an IQ channel: there is no audio in
// it and its passband means something else.

import React, { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Empty, Icon, ShowMore } from '../components/ui.jsx';
import { countryFlag, formatFreqShort } from '../lib/format.js';
import { openChannelsMap } from '../compat/legacyBridge.js';
import { activeLabel, subscribeListeners, tunable } from '../lib/listeners.js';

// The age column counts up on its own — a list that only moves every ten
// seconds reads as frozen, and "12s ago" that stays at 12 for ten seconds is
// worse than no number.
const TICK_MS = 1000;

// Rows before "show more", and how many each press adds. Smaller than the spot
// list's page because this panel sits in a side dock among several others, and
// because your own row is always one of the five.
const PAGE = 5;

function Row({ channel, now, current, onTune }) {
    const flag = countryFlag(channel.countryCode);
    const where = [
        formatFreqShort(channel.frequency),
        channel.mode ? channel.mode.toUpperCase() : '',
    ].filter(Boolean).join(' ');
    const who = [
        channel.chatUsername,
        [flag, channel.country].filter(Boolean).join(' '),
    ].filter(Boolean).join(' · ');

    const title = [
        `${(channel.frequency / 1000).toFixed(3)} kHz ${channel.mode.toUpperCase()}`,
        `Passband ${channel.bandwidthLow} to ${channel.bandwidthHigh} Hz`,
        channel.country || '',
        channel.chatUsername ? `Chat: ${channel.chatUsername}` : '',
        channel.you ? 'This is you' : (tunable(channel) ? 'Click to listen here' : ''),
    ].filter(Boolean).join('\n');

    const cells = (
        <>
            <span className="lsn-row__where">{where}</span>
            <span className="lsn-row__who">{who || (channel.you ? 'You' : '')}</span>
            <span className="lsn-row__age">{activeLabel(channel.lastActive, now)}</span>
        </>
    );

    // A reading row rather than a disabled button, for the same reason the spot
    // rows are: a disabled button dims its text and leaves the accessibility
    // tree, and this row is still worth reading.
    if (!tunable(channel)) {
        return (
            <div className={`list__row lsn-row lsn-row--static${channel.you ? ' is-you' : ''}`} title={title}>
                {cells}
            </div>
        );
    }

    return (
        <button
            type="button"
            className={`list__row lsn-row${current ? ' is-active' : ''}`}
            title={title}
            onClick={() => onTune(channel)}
        >
            {cells}
        </button>
    );
}

// `minimal` drops the header — the count and the map button — and the pager
// under the list, leaving the first five listeners. See the registry's
// `minimal`.
export default function ListenersPanel({ minimal }) {
    const { tuning, actions } = useRadio();
    const [state, setState] = useState(null);      // null until the first reply
    const [now, setNow] = useState(() => Date.now());
    const [shown, setShown] = useState(PAGE);

    useEffect(() => subscribeListeners(setState), []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(id);
    }, []);

    const channels = (state && state.channels) || [];
    const others = channels.filter((c) => !c.you).length;
    // Minimal is the first page and no way to grow it, so a list left expanded
    // does not stay expanded when the panel is cut down.
    const page = channels.slice(0, minimal ? PAGE : shown);

    // One tune, so the receiver never passes through an intermediate
    // mode/passband on the way — the same call the spot rows make.
    const tune = (c) => actions.tuneTo({
        frequency: c.frequency,
        mode: c.mode,
        bandwidthLow: c.bandwidthLow,
        bandwidthHigh: c.bandwidthHigh,
    });

    return (
        <div className="stack">
            {!minimal && (
                <div className="lsn-head">
                    <span className="lsn-count">
                        {state === null
                            ? 'Loading…'
                            : `${others} other listener${others === 1 ? '' : 's'}`}
                    </span>
                    {/* The map feeds itself from this panel's poll for as long
                        as it is open — see compat/legacyBridge.js. */}
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon.External />}
                        title="Open the listener map"
                        onClick={() => openChannelsMap(subscribeListeners)}
                    >
                        Map
                    </Button>
                </div>
            )}

            {state && state.error && (
                <div className="note note--warn">Could not load listeners: {state.error}</div>
            )}

            <div className="list lsn-list">
                {state === null && <Empty>Loading…</Empty>}
                {state !== null && channels.length === 0 && <Empty>Nobody is listening.</Empty>}
                {page.map((c) => (
                    <Row
                        key={`${c.index}-${c.frequency}-${c.chatUsername}`}
                        channel={c}
                        now={now}
                        current={!c.you && Math.abs(c.frequency - tuning.frequency) < 200}
                        onTune={tune}
                    />
                ))}
            </div>

            {!minimal && (
                <ShowMore
                    shown={page.length}
                    total={channels.length}
                    base={PAGE}
                    onMore={() => setShown((n) => n + PAGE)}
                    onLess={() => setShown(PAGE)}
                />
            )}
        </div>
    );
}
