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
// Clicking the message opens it full size, where it scrolls. The panel's own copy is
// clamped instead: two scrollbars a few millimetres apart is a wheel that scrolls the
// wrong thing half the time.
//
// `minimal` drops the picker and keeps the message. The choice is remembered, so what
// shows in the minimal view is whatever was last chosen in the full one — which makes
// the minimal view a way of pinning 518 kHz to the dock and leaving it there. The modal
// still opens from there, and carries the link out to the addon for the same reason.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Button, Empty, Icon, Modal, Segmented } from '../components/ui.jsx';
import { sinceLabel } from '../lib/format.js';
import { subjectOf } from '../lib/navtexCodes.js';
import {
    METRICS_POLL_MS, POLL_MS, addonUrl, chosenMessage, latestPerFreq, latestUrl,
    messageBody, metricsFreqs, metricsUrl, navtexAvailable, pickOptions, savePick,
    savedPick, shortFreq,
} from '../lib/navtexAddon.js';
import { feedInterval } from '../lib/serverFeeds.js';

export { navtexAvailable };

// How often the "3h ago" line is redrawn. Messages arrive hours apart, so this is only
// keeping the age honest between polls.
const TICK_MS = 30000;

export default function NavtexPanel({ minimal }) {
    const [list, setList] = useState([]);
    const [pick, setPick] = useState(savedPick);
    const [state, setState] = useState('loading');   // loading | ok | error
    const [now, setNow] = useState(() => Date.now());
    // Frequencies the addon has logged at some point, so a channel that has been quiet
    // since it started is still something you can ask for — see metricsUrl.
    const [known, setKnown] = useState([]);
    // The message opened full size, if any. The message itself rather than a flag: a
    // poll can replace what is on screen while the modal is open, and a warning that
    // changed under the reader mid-sentence would be worse than a stale one.
    const [reading, setReading] = useState(null);
    // Whether the preview is showing all of it, which decides the "read all"
    // affordance. Measured rather than guessed from the length: five short lines fit
    // where one long paragraph does not.
    const [clipped, setClipped] = useState(false);
    const textRef = useRef(null);
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
        return feedInterval(poll, POLL_MS);
    }, [poll]);

    // Rarely, and never fatally: with file logging off this answers with nothing, and
    // the picker falls back to the frequencies that have spoken since the addon
    // started, which is what it would have offered anyway.
    useEffect(() => {
        const load = () => {
            fetch(metricsUrl())
                .then((r) => (r.ok ? r.json() : null))
                .then((j) => { if (alive.current && j) setKnown(metricsFreqs(j)); })
                .catch(() => {});
        };
        return feedInterval(load, METRICS_POLL_MS);
    }, []);

    // After every render that could have changed the text: the panel is resizable and
    // the message changes on its own, so this is not a mount-time question.
    useEffect(() => {
        const el = textRef.current;
        setClipped(!!el && el.scrollHeight - el.clientHeight > 2);
    });

    const choose = (value) => {
        setPick(value);
        savePick(value);
    };

    const options = pickOptions(list, known);
    const freqs = options.slice(1).map((o) => o.value);
    const msg = chosenMessage(list, pick, freqs);
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
                        : shownPick !== options[0].value
                            // Named, because the alternative — quietly showing the other
                            // frequency's message — would put it under a chip that says
                            // 490, and a NAVTEX message without its frequency is not one.
                            ? `Nothing on ${shortFreq(shownPick)} kHz yet.`
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

                    {/* The message, clamped, and one click from all of it. Monospace
                        because NAVTEX is written for it: position lists and times line
                        up in columns that fall apart in a proportional face.

                        Clamped rather than scrolled. A scrolling box inside a panel that
                        also scrolls is two scrollbars a few millimetres apart, and the
                        wheel picks the wrong one about half the time — so the panel
                        shows the top of the message and reading it happens in the
                        modal, which has room for it. */}
                    <button
                        type="button"
                        className={`nx__read${clipped ? ' is-more' : ''}`}
                        onClick={() => setReading(msg)}
                        title="Read the whole message"
                    >
                        <pre className="nx__text" ref={textRef}>{messageBody(msg.text)}</pre>
                        {clipped && <span className="nx__more">Read all</span>}
                    </button>
                </div>
            )}

            {/* When the other frequency last said something, so a panel showing 518 does
                not hide the fact that 490 has just had a gale warning. Only worth a line
                when there is more than one. */}
            {!minimal && list.length > 1 && (
                <div className="nx__others">
                    {list.filter((m) => m !== msg).map((m) => (
                        <button
                            key={m.key}
                            type="button"
                            className="nx__other"
                            title={`${m.id} — ${(subjectOf(m.subject) || {}).label || 'unknown subject'}`}
                            // The canonical name, which is what the picker's chips carry —
                            // the addon's own spelling would not match any of them.
                            onClick={() => choose(m.key)}
                        >
                            {m.short} <i>{m.at ? sinceLabel(m.at, now) : '—'}</i>
                        </button>
                    ))}
                </div>
            )}

            {/* Full size, with the same header: a message read on its own still has to
                say which frequency carried it and when. The text scrolls here, where a
                scrollbar has somewhere to be.

                Everything below reads `reading` and never `msg` — the snapshot taken
                when it was opened, not whatever the panel is showing now. A poll landing
                mid-read must not rewrite the warning under the reader, and a message
                that has been replaced is still the one they asked to see. Closing and
                opening again is how you get the current one. */}
            {reading && (
                <Modal onClose={() => setReading(null)} label={`NAVTEX ${reading.id}`}>
                    <div className="nx__full">
                        <div className="nx__head">
                            <span className="nx__id">{reading.id}</span>
                            <span className="nx__freq">{reading.short} kHz</span>
                            <span className="nx__age">
                                {reading.at
                                    ? `${new Date(reading.at).toISOString().replace('T', ' ').slice(0, 19)} UTC`
                                    : '—'}
                            </span>
                        </div>
                        <div className={`nx__subject${(subjectOf(reading.subject) || {}).vital ? ' is-vital' : ''}`}>
                            {(subjectOf(reading.subject) || {}).label || `Subject ${reading.subject || '?'}`}
                            {reading.snr != null && <span className="nx__snr">{reading.snr.toFixed(1)} dB</span>}
                        </div>
                        <pre className="nx__fulltext">{messageBody(reading.text)}</pre>
                        {/* The way out to the addon, here as well as in the panel: the
                            modal covers the panel, and "where did this come from, and
                            what else has it had" is the question a full-size read
                            prompts. Available in the minimal view through this, which
                            has no row of its own to put it in. */}
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
                            <Button size="sm" variant="ghost" onClick={() => setReading(null)}>
                                Close
                            </Button>
                        </div>
                    </div>
                </Modal>
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
