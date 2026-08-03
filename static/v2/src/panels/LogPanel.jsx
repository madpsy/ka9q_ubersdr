import React from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Empty, Icon } from '../components/ui.jsx';

// How many entries to render. The dock is the scroller now, so an unbounded
// list would make it arbitrarily long; the provider keeps more than this.
const SHOWN = 60;

export default function LogPanel() {
    const { log, actions } = useRadio();

    // Newest first. With no scroller of its own, the panel cannot scroll itself
    // to the bottom — and doing so would drag the whole dock with it — so the
    // newest entry is put where it is always visible instead.
    const entries = log.slice(-SHOWN).reverse();

    return (
        <div className="stack">
            <div className="row-end">
                <Button size="sm" variant="ghost" icon={<Icon.Close />} onClick={actions.clearLog}>Clear</Button>
            </div>
            <div className="log">
                {entries.length === 0 && <Empty>Nothing logged yet.</Empty>}
                {entries.map((e) => (
                    <div key={e.id} className={`log__row log__row--${e.level}`}>
                        <span className="log__time">{e.at.toLocaleTimeString()}</span>
                        <span className="log__text">{e.text}</span>
                    </div>
                ))}
                {log.length > SHOWN && (
                    <div className="log__more">+{log.length - SHOWN} older</div>
                )}
            </div>
        </div>
    );
}
