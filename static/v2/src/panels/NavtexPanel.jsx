// NAVTEX: the last maritime safety broadcast each frequency carried.
//
// One message at a time, and a picker that decides which: whichever spoke most
// recently, or a frequency you have chosen. That is the whole panel, and the shape is
// deliberate — a NAVTEX message is two hundred words of plain text, so a column showing
// two of them shows neither, and the addon's own page is where the full history lives.
//
// The picker is built from the frequencies actually being received, so a receiver
// watching one is not offered a chip for the other. See pickOptions.
//
// `minimal` drops the picker and keeps the message. The choice is remembered, so what
// shows in the minimal view is whatever was last chosen in the full one — which makes
// the minimal view a way of pinning 518 kHz to the dock and leaving it there.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Empty, Icon, Segmented } from '../components/ui.jsx';
import { sinceLabel } from '../lib/format.js';
import { subjectOf } from '../lib/navtexCodes.js';
import {
    POLL_MS, addonUrl, chosenMessage, latestPerFreq, latestUrl, messageBody,
    navtexAvailable, pickOptions, savePick, savedPick,
} from '../lib/navtexAddon.js';

export { navtexAvailable };

// How often the "3h ago" line is redrawn. Messages arrive hours apart, so this is only
// keeping the age honest between polls.
const TICK_MS = 30000;

export default function NavtexPanel({ minimal }) {
    const [list, setList] = useState([]);
    const [pick, setPick] = useState(savedPick);
    const [state, setState] = useState('loading');   // loading | ok | error
    const [now, setNow] = useState(() => Date.now());
    const alive = useRef(true);

    useEffect(() => () => { alive.current = false; }, []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(id);
    }, []);

    const poll = useCallback(() => {
        fetch(latestUrl())
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((rows) => {
                if (!alive.current) return;
                setList(latestPerFreq(Array.isArray(rows) ? rows : []));
                setState('ok');
            })
            .catch(() => {
                if (!alive.current) return;
                // A failed poll leaves what is on screen. The message is still the last
                // one that frequency carried, whatever the addon is doing now — and for
                // a broadcast that comes round every four hours, that stays true for a
                // long time.
                setState((s) => (s === 'ok' ? s : 'error'));
            });
    }, []);

    useEffect(() => {
        poll();
        const id = setInterval(poll, POLL_MS);
        return () => clearInterval(id);
    }, [poll]);

    const choose = (value) => {
        setPick(value);
        savePick(value);
    };

    const msg = chosenMessage(list, pick);
    const options = pickOptions(list);
    // What the picker should read as selected. A chosen frequency that has stopped
    // being received leaves the control pointing at a chip that is no longer there, so
    // it falls back to what is actually being shown — see chosenMessage.
    const shownPick = options.some((o) => o.value === pick) ? pick : options[0].value;
    const subject = msg && subjectOf(msg.subject);

    if (state === 'loading') return <Empty>Loading…</Empty>;

    return (
        <div className="stack nx">
            {/* Two frequencies and a "whichever spoke last" — three choices, mutually
                exclusive, all visible. A dropdown would hide half of that behind a
                click to save a few pixels of a row that has them. */}
            {!minimal && options.length > 1 && (
                <Segmented size="sm" options={options} value={shownPick} onChange={choose} />
            )}

            {!msg ? (
                <Empty>
                    {state === 'error'
                        ? 'The NAVTEX addon is not answering.'
                        : 'No complete message received yet.'}
                </Empty>
            ) : (
                <div className="nx__msg">
                    <div className="nx__head">
                        {/* B1B2B3B4 — the four characters that identify a NAVTEX
                            message, and what you would quote asking whether somebody
                            else copied it. */}
                        <span className="nx__id" title="Station, subject and serial">{msg.id}</span>
                        <span className="nx__freq">{msg.short} kHz</span>
                        <span className="nx__age" title={new Date(msg.at).toISOString()}>
                            {msg.at ? sinceLabel(msg.at, now) : '—'}
                        </span>
                    </div>

                    {/* What kind of message it is, which is the one thing a NAVTEX
                        header says that a reader cannot work out from the text at a
                        glance. Search and rescue, navigational and meteorological
                        warnings are marked: the standard forbids a receiver filtering
                        those out, and it would be a strange panel that showed them in
                        the same grey as a pilot service notice. */}
                    <div className={`nx__subject${subject && subject.vital ? ' is-vital' : ''}`}>
                        {subject ? subject.label : `Subject ${msg.subject || '?'}`}
                        {msg.snr != null && <span className="nx__snr">{msg.snr.toFixed(1)} dB</span>}
                    </div>

                    {/* The message. Monospace because NAVTEX is written for it — position
                        lists and times line up in columns that fall apart in a
                        proportional face — and scrolling rather than clamped, because a
                        navigational warning cut off at four lines is a warning you have
                        not read. */}
                    <pre className="nx__text">{messageBody(msg.text)}</pre>
                </div>
            )}

            {/* When the other frequency last said something, so a panel showing 518 does
                not hide the fact that 490 has just had a gale warning. Only worth a line
                when there is more than one. */}
            {!minimal && list.length > 1 && (
                <div className="nx__others">
                    {list.filter((m) => m !== msg).map((m) => (
                        <button
                            key={m.freq}
                            type="button"
                            className="nx__other"
                            title={`${m.id} — ${(subjectOf(m.subject) || {}).label || 'unknown subject'}`}
                            onClick={() => choose(m.freq)}
                        >
                            {m.short} <i>{m.at ? sinceLabel(m.at, now) : '—'}</i>
                        </button>
                    ))}
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
                        Open NAVTEX
                        <Icon.External size={13} />
                    </a>
                </div>
            )}
        </div>
    );
}
