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
// The band picker defaults to following the dial, as the spot lists and the spectrogram do,
// and for the same reason: what somebody wants from a list of who is being heard is almost
// always who is being heard *where they are listening*. The filter is the addon's, not ours
// — see lib/voiceSkimmer.js — because five rows filtered here would be an empty column
// whenever the last five callsigns happened to be on another band.
//
// `minimal` drops the caption, the link and the band picker, and keeps the two columns,
// which are the panel. The filter itself stays in force — it is stored, and on its default
// it follows the dial, which is exactly what a cut-down view wants — but choosing a band is
// setting something up, and a minimal view is what you leave behind afterwards. Each row
// names the band it was heard on, so a pinned band is still legible without the control.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Empty, Field, Icon } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { countryFlag, sinceLabel } from '../lib/format.js';
import { requestLookup } from '../lib/callsign.js';
import { lookupCallsign } from '../compat/legacyBridge.js';
import { bandForFrequency } from '../lib/bands.js';
import {
    AUTO_BAND, BAND_NAMES, BAND_SETTLE_MS, COLUMN_ROWS, POLL_MS, SECOND_QUERY_MS, addonUrl,
    confirmedUrl, freqLabel, matchedCount, resolveBandFilter, saveBand, savedBand, spotList,
    spottedUrl, tuneTarget, tunedToSpot, voiceSkimmerAvailable,
} from '../lib/voiceSkimmer.js';

export { voiceSkimmerAvailable };

// How often the ages are redrawn between polls.
const TICK_MS = 15000;

function Column({ title, rows, count, now, tunedHz, onPick }) {
    return (
        <div className="vs__col">
            <div className="vs__title">
                {title}
                {count != null && <i>{count}</i>}
            </div>
            {rows.length === 0 ? (
                <div className="vs__none">—</div>
            ) : rows.map((s) => {
                // Marked when the receiver is already there — see tunedToSpot. The skimmer
                // hears what this receiver hears, so a listener who has found something
                // interesting by hand has a fair chance of it being in this list, and this
                // is how a callsign gets attached to a voice.
                const here = tunedToSpot(s, tunedHz);
                return (
                <button
                    key={s.key}
                    type="button"
                    className={`vs__row${here ? ' is-tuned' : ''}`}
                    aria-current={here ? 'true' : undefined}
                    onClick={() => onPick(s)}
                    title={`${s.callsign}${s.country ? ` — ${s.country}` : ''} · ${freqLabel(s.hz)} MHz`
                        + `${s.mode ? ` ${s.mode.toUpperCase()}` : ''}`
                        + `${s.snr != null ? ` · ${Math.round(s.snr)} dB` : ''}`
                        + `${here ? ' — you are tuned here' : ' — click to tune'}`}
                >
                    {/* The age sits with the callsign rather than on a line of its
                        own: it is three characters, and a row of its own for it made
                        each entry half again as tall for no more information. */}
                    <span className="vs__call">
                        {s.cc && <span className="vs__flag">{countryFlag(s.cc)}</span>}
                        <span className="vs__sign">{s.callsign}</span>
                        <span className="vs__age">{sinceLabel(s.spottedAt || s.at, now)}</span>
                    </span>
                    <span className="vs__where">
                        <span className="vs__band">{s.band}</span>
                        {freqLabel(s.hz)}
                        {s.mode && <span className="vs__mode">{s.mode.toUpperCase()}</span>}
                    </span>
                </button>
                );
            })}
        </div>
    );
}

export default function VoiceSkimmerPanel({ minimal }) {
    const { actions, serverInfo, tuning } = useRadio();
    // Kept in storage rather than in state: this panel is unmounted every time its dock
    // collapses, and a filter that reset itself on every peek would be no filter at all.
    const [choice, setChoice] = useState(savedBand);
    const [confirmed, setConfirmed] = useState([]);
    const [spotted, setSpotted] = useState([]);
    const [totals, setTotals] = useState({ confirmed: null, spotted: null });
    const [state, setState] = useState('loading');   // loading | ok | error
    const [now, setNow] = useState(() => Date.now());
    const alive = useRef(true);
    const second = useRef(null);
    // The opening poll goes out at once; every later one is a band change, which waits.
    const first = useRef(true);

    useEffect(() => () => { alive.current = false; clearTimeout(second.current); }, []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(id);
    }, []);

    // What the picker means right now. 'auto' is the band the dial is in — and 'all' when the
    // dial is between bands, which is most of the shortwave spectrum: somebody parked on a
    // broadcast station should see the whole list, not an empty one.
    const dialBand = bandForFrequency(tuning.frequency);
    const band = resolveBandFilter(choice, dialBand);

    const pickBand = (v) => { setChoice(v); saveBand(v); };

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
            ask(confirmedUrl(COLUMN_ROWS, band), (rows, n) => {
                setConfirmed(rows);
                setTotals((t) => ({ ...t, confirmed: n }));
            });
            clearTimeout(second.current);
            second.current = setTimeout(() => {
                ask(spottedUrl(COLUMN_ROWS, band), (rows, n) => {
                    setSpotted(rows);
                    setTotals((t) => ({ ...t, spotted: n }));
                });
            }, SECOND_QUERY_MS);
        };

        // Read once, because the branch below clears it and the settle timer has to know
        // which run this was rather than what the flag says afterwards.
        const opening = first.current;
        // A new band is a new question, and the rows on screen are the old one's answer —
        // each carries the band it was heard on, so leaving them up would be visibly wrong.
        // Cleared rather than left to be overwritten, and without going back to 'loading',
        // which would take the picker off screen along with them.
        if (opening) {
            first.current = false;
            poll();
        } else {
            setConfirmed([]);
            setSpotted([]);
            setTotals({ confirmed: null, spotted: null });
        }

        // On auto the band follows the dial, and a dial being swept passes through several
        // bands in a couple of seconds. Waiting for it to settle makes that one query
        // instead of a burst against an endpoint that allows one a second.
        const settle = opening ? null : setTimeout(poll, BAND_SETTLE_MS);
        const id = setInterval(poll, POLL_MS);
        return () => {
            clearTimeout(settle);
            clearInterval(id);
            clearTimeout(second.current);
        };
    }, [ask, band]);

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

    const dead = state === 'error' && !confirmed.length && !spotted.length;

    return (
        <div className="stack vs">
            {/* Above the columns, and drawn even while they are loading or failing: it is
                how you get off a band with nothing on it, which is exactly when somebody
                reaches for it. Auto names the band it has settled on — "Auto (20m)" — so a
                short list is explained by the control rather than being a mystery. */}
            {!minimal && (
                <Field label="Band" inline>
                    <select
                        className="select"
                        value={choice}
                        onChange={(e) => pickBand(e.target.value)}
                        title="Which band the two columns are asking the skimmer about"
                    >
                        {/* Auto first, because it is the default and because it is the question
                            a list of heard callsigns is usually being asked. */}
                        <option value={AUTO_BAND}>
                            {dialBand ? `Auto (${dialBand})` : 'Auto (all bands)'}
                        </option>
                        <option value="all">All bands</option>
                        {BAND_NAMES.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                </Field>
            )}

            {state === 'loading' && <Empty>Loading…</Empty>}
            {dead && <Empty>The voice skimmer addon is not answering.</Empty>}

            {/* Side by side rather than one list with a badge: spotted is a subset of
                confirmed, and the interesting thing is the gap between the two — how
                much of what the receiver hears it is prepared to put its name to. */}
            {state !== 'loading' && !dead && (
                <div className="vs__cols">
                    <Column
                        title="Confirmed"
                        rows={confirmed}
                        count={minimal ? null : totals.confirmed}
                        now={now}
                        tunedHz={tuning.frequency}
                        onPick={pick}
                    />
                    <Column
                        title="Spotted"
                        rows={spotted}
                        count={minimal ? null : totals.spotted}
                        now={now}
                        tunedHz={tuning.frequency}
                        onPick={pick}
                    />
                </div>
            )}

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
