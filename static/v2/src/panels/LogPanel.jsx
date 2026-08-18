import React, { useEffect, useState } from '../react.js';
import { Button, Empty, Icon, ShowMore } from '../components/ui.jsx';
import { LOG_CAP, clearEventLog, eventLog, onEventLog } from '../lib/eventLog.js';

// Rows before the first press of Show more.
//
// Smaller than the other lists' page, and deliberately: this panel is a place to
// glance at what just happened, not a list to read through. Five lines cover a
// connect, a drop and the retries between them — and a panel that opens several
// screens deep in a dock that scrolls as one is a panel nobody leaves open.
// Everything the store holds is still reachable, a press at a time.
const PAGE = 5;

export default function LogPanel() {
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

    return (
        <div className="stack">
            <div className="row-end">
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon.Close />}
                    onClick={() => { clearEventLog(); setLimit(PAGE); }}
                >
                    Clear
                </Button>
            </div>
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
                there has been. */}
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
