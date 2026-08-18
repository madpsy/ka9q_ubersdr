import React, { useEffect, useState } from '../react.js';
import { Button, Empty, Icon, ShowMore } from '../components/ui.jsx';
import { LOG_CAP, clearEventLog, eventLog, onEventLog } from '../lib/eventLog.js';
import { saveText } from '../lib/saveFile.js';

// Rows before the first press of Show more.
//
// Smaller than the other lists' page, and deliberately: this panel is a place to
// glance at what just happened, not a list to read through. Five lines cover a
// connect, a drop and the retries between them — and a panel that opens several
// screens deep in a dock that scrolls as one is a panel nobody leaves open.
// Everything the store holds is still reachable, a press at a time.
const PAGE = 5;

// One line per entry, oldest first — the order things happened, which is the
// order somebody reading a log wants and the reverse of the order the panel
// shows them in. ISO timestamps rather than the panel's local clock: an exported
// log is going to be read somewhere else, quite possibly by the operator rather
// than the listener, and a bare "17:09:49" does not say where or when that was.
function toText(entries) {
    return entries.map((e) => {
        const repeat = e.repeats > 1 ? ` (×${e.repeats})` : '';
        return `${e.at.toISOString()}  ${e.level.padEnd(5)}  ${e.text}${repeat}`;
    }).join('\n');
}

export default function LogPanel({ minimal }) {
    // Straight from the store rather than through the radio context.
    //
    // The log used to be state in RadioProvider, which meant two things: only
    // code inside that provider could write to it — so the EventSource feeds,
    // the audio extensions and the spectrogram loader all logged nothing — and
    // every line re-rendered every consumer of useRadio(). Subscribing here
    // fixes both; see lib/eventLog.js.
    const [entries, setEntries] = useState(eventLog);
    const [limit, setLimit] = useState(PAGE);

    useEffect(() => {
        setEntries(eventLog());          // in case a line arrived before this ran
        return onEventLog(setEntries);
    }, []);

    // Newest first. With no scroller of its own, the panel cannot scroll itself
    // to the bottom — and doing so would drag the whole dock with it — so the
    // newest entry is put where it is always visible instead.
    //
    // Which also means the window grows *downwards* into the past: a press of
    // Show more reveals older lines and never moves the newest one off the top,
    // so the thing being watched stays where it was.
    const newest = entries.slice().reverse();
    const shown = newest.slice(0, limit);

    const save = () => saveText(
        toText(entries),
        `ubersdr-events_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
        'text/plain',
    );

    return (
        <div className="stack">
            {/* The minimal view is the last few lines and nothing else.
                Clear and Export are both about the log as a whole rather than
                about what just happened, and a panel that has been asked to
                take less of the dock should spend what it has on entries. Both
                are a toggle away, and neither is something anybody reaches for
                in a hurry. */}
            {!minimal && (
                <div className="row-end">
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon.Download size={13} />}
                        disabled={!entries.length}
                        title="Save everything logged as a text file"
                        onClick={save}
                    >
                        Export
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon.Close />}
                        onClick={() => { clearEventLog(); setLimit(PAGE); }}
                    >
                        Clear
                    </Button>
                </div>
            )}
            <div className="log">
                {shown.length === 0 && <Empty>Nothing logged yet.</Empty>}
                {shown.map((e) => (
                    <div key={e.id} className={`log__row log__row--${e.level}`}>
                        <span className="log__time">{e.at.toLocaleTimeString()}</span>
                        <span className="log__text">{e.text}</span>
                        {/* A line that repeated straight away is counted rather
                            than listed — see REPEAT_MS. */}
                        {e.repeats > 1 && <span className="log__count">×{e.repeats}</span>}
                    </div>
                ))}
            </div>
            {/* `count` off: "40 shown" under a log says nothing, and the store
                is a ring — the total is how much history survives, not how much
                there has been.

                Kept in the minimal view, unlike the buttons above. Growing the
                list is the one thing this panel does that is about what is on
                screen rather than about the log, and a minimal view with no way
                to see the line before last is a panel that has to be un-minimised
                to be read. */}
            <ShowMore
                shown={Math.min(limit, newest.length)}
                total={newest.length}
                base={PAGE}
                count={false}
                onMore={() => setLimit((n) => Math.min(n + PAGE, LOG_CAP))}
                onLess={() => setLimit(PAGE)}
                label="Show more events"
            />
        </div>
    );
}
