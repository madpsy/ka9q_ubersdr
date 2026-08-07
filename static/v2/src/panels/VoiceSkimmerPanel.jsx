// Voice skimmer: callsigns heard spoken on SSB, in two columns.
//
// Confirmed on the left — heard, extracted from the transcript and validated — and
// Spotted on the right, the subset the addon was sure enough of to submit to the DX
// cluster. The distinction is the addon's and it is worth keeping: one is what this
// receiver heard, the other is what it is willing to tell the world.
//
// Clicking a callsign tunes to it, in the mode it was heard in, and asks for a lookup —
// the same thing clicking a spot does everywhere else in the interface.
//
// `minimal` drops the caption and the link and keeps the two columns, which are the
// panel.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Empty, Icon } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { countryFlag, sinceLabel } from '../lib/format.js';
import { requestLookup } from '../lib/callsign.js';
import { lookupCallsign } from '../compat/legacyBridge.js';
import {
    COLUMN_ROWS, POLL_MS, SECOND_QUERY_MS, addonUrl, confirmedUrl, freqLabel, matchedCount,
    spotList, spottedUrl, tuneTarget, voiceSkimmerAvailable,
} from '../lib/voiceSkimmer.js';

export { voiceSkimmerAvailable };

// How often the ages are redrawn between polls.
const TICK_MS = 15000;

function Column({ title, rows, count, now, onPick }) {
    return (
        <div className="vs__col">
            <div className="vs__title">
                {title}
                {count != null && <i>{count}</i>}
            </div>
            {rows.length === 0 ? (
                <div className="vs__none">—</div>
            ) : rows.map((s) => (
                <button
                    key={s.key}
                    type="button"
                    className="vs__row"
                    onClick={() => onPick(s)}
                    title={`${s.callsign}${s.country ? ` — ${s.country}` : ''} · ${freqLabel(s.hz)} MHz`
                        + `${s.mode ? ` ${s.mode.toUpperCase()}` : ''}`
                        + `${s.snr != null ? ` · ${Math.round(s.snr)} dB` : ''} — click to tune`}
                >
                    <span className="vs__call">
                        {s.cc && <span className="vs__flag">{countryFlag(s.cc)}</span>}
                        {s.callsign}
                    </span>
                    <span className="vs__where">
                        <span className="vs__band">{s.band}</span>
                        {freqLabel(s.hz)}
                        {s.mode && <span className="vs__mode">{s.mode.toUpperCase()}</span>}
                    </span>
                    <span className="vs__age">
                        {sinceLabel(s.spottedAt || s.at, now)}
                    </span>
                </button>
            ))}
        </div>
    );
}

export default function VoiceSkimmerPanel({ minimal }) {
    const { actions, serverInfo } = useRadio();
    const [confirmed, setConfirmed] = useState([]);
    const [spotted, setSpotted] = useState([]);
    const [totals, setTotals] = useState({ confirmed: null, spotted: null });
    const [state, setState] = useState('loading');   // loading | ok | error
    const [now, setNow] = useState(() => Date.now());
    const alive = useRef(true);
    const second = useRef(null);

    useEffect(() => () => { alive.current = false; clearTimeout(second.current); }, []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(id);
    }, []);

    const ask = useCallback((url, apply) => fetch(url)
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then((payload) => {
            if (!alive.current) return;
            apply(spotList(payload), matchedCount(payload));
            setState('ok');
        })
        .catch(() => {
            if (!alive.current) return;
            // A failed poll leaves what is on screen: these are stations that were
            // heard, and they were still heard whatever the addon is doing now.
            setState((s) => (s === 'ok' ? s : 'error'));
        }), []);

    useEffect(() => {
        // Two queries, one after the other. /api/spots allows one request per second per
        // address, so firing both together would have one of them answered with a 429 —
        // and it is a real filter on the server, which is why it is worth two requests
        // rather than one and a split here. See lib/voiceSkimmer.js.
        const poll = () => {
            ask(confirmedUrl(COLUMN_ROWS), (rows, n) => {
                setConfirmed(rows);
                setTotals((t) => ({ ...t, confirmed: n }));
            });
            clearTimeout(second.current);
            second.current = setTimeout(() => {
                ask(spottedUrl(COLUMN_ROWS), (rows, n) => {
                    setSpotted(rows);
                    setTotals((t) => ({ ...t, spotted: n }));
                });
            }, SECOND_QUERY_MS);
        };
        poll();
        const id = setInterval(poll, POLL_MS);
        return () => { clearInterval(id); clearTimeout(second.current); };
    }, [ask]);

    // Clicking a callsign: tune to where it was heard, in the mode it was heard in, and
    // ask for a lookup — exactly what clicking a spot does in the Spots panel and on the
    // marker bar, so a callsign behaves the same way wherever it appears.
    const pick = (spot) => {
        const target = tuneTarget(spot);
        if (!target) return;
        actions.tuneTo(target);
        actions.ensureVisible(target.frequency);
        if (serverInfo && serverInfo.lookup_service && !requestLookup(spot.callsign)) {
            lookupCallsign(spot.callsign);
        }
    };

    if (state === 'loading') return <Empty>Loading…</Empty>;

    if (state === 'error' && !confirmed.length && !spotted.length) {
        return <Empty>The voice skimmer addon is not answering.</Empty>;
    }

    return (
        <div className="stack vs">
            {/* Side by side rather than one list with a badge: spotted is a subset of
                confirmed, and the interesting thing is the gap between the two — how
                much of what the receiver hears it is prepared to put its name to. */}
            <div className="vs__cols">
                <Column
                    title="Confirmed"
                    rows={confirmed}
                    count={minimal ? null : totals.confirmed}
                    now={now}
                    onPick={pick}
                />
                <Column
                    title="Spotted"
                    rows={spotted}
                    count={minimal ? null : totals.spotted}
                    now={now}
                    onPick={pick}
                />
            </div>

            {!minimal && (
                <div className="row-end">
                    <a
                        className="btn btn--ghost btn--sm"
                        href={addonUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Open skimmer
                        <Icon.External size={13} />
                    </a>
                </div>
            )}
        </div>
    );
}
