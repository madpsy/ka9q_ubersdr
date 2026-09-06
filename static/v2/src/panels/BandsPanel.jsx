// Band list from /api/bands. The server returns every allocation across
// 0–30 MHz — hundreds of entries — and panels do not scroll on their own, so
// the list renders a page at a time. With no search term it opens on the page
// holding the band the receiver is currently in, which is the part worth seeing.
//
// `minimal` is the search box and its matches alone. Full, the panel is for reading down a
// band plan; cut down it is for looking one allocation up — "where is 60m", "what is at
// 4 MHz" — so there is no list until something is typed, and the panel is two rows tall
// until then. The current band is not shown there either: the dial and the marker bar are
// both already saying where you are, and this is the view you shrank to get that space back.

import React, { useMemo, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Empty } from '../components/ui.jsx';
import { MINIMAL_ROWS, PAGE_ROWS, Pager, usePager } from '../components/Pager.jsx';
import { formatFreqShort } from '../lib/format.js';

// The API packs a second line after a "|" and sometimes uses tabs as spacing.
function cleanLabel(raw) {
    return String(raw || '').split('|').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ');
}

export default function BandsPanel({ minimal }) {
    const { tuning, actions, catalog } = useRadio();
    const bands = catalog.bands;
    const [query, setQuery] = useState('');

    const filtered = useMemo(() => {
        if (!bands) return null;
        const q = query.trim().toLowerCase();
        if (!q) return bands;
        // The group is searched alongside the name, so a receiver that organises
        // its plan — "HF", "Model Control", "Blocked" — can be asked for a whole
        // category rather than only for one allocation at a time.
        return bands.filter((b) => `${cleanLabel(b.label)} ${b.group || ''}`.toLowerCase().includes(q));
    }, [bands, query]);

    const activeIndex = useMemo(() => {
        if (!filtered) return -1;
        return filtered.findIndex((b) => tuning.frequency >= b.start && tuning.frequency < b.end);
    }, [filtered, tuning.frequency]);

    // Where the list should open: the page holding the current band, so somebody who
    // opens the panel sees where they are rather than the bottom of the LF end. A search
    // overrides it — the matches are then the point, and the first of them is the answer.
    //
    // It is also a dep, so tuning into a *different* allocation brings the list with you.
    // Paging by hand stays put, because the dial has not moved: nothing recomputes until
    // the band under it changes.
    const searching = query.trim().length > 0;
    // Cut down, only a search produces a list — and then it starts at the first match, so
    // there is no band to open on.
    const listed = minimal && !searching ? null : filtered;
    // Shorter pages cut down: the view exists to take less of the dock.
    const rows = minimal ? MINIMAL_ROWS : PAGE_ROWS;
    const home = searching || minimal ? -1 : activeIndex;
    const homePage = home < 0 ? -1 : Math.floor(home / rows);
    const { start, end, pager } = usePager(listed ? listed.length : 0, {
        rows,
        at: home,
        deps: [query, homePage],
    });
    const visible = listed ? listed.slice(start, end) : [];

    if (!filtered) return <Empty>Loading bands…</Empty>;

    return (
        <div className="stack">
            <input
                className="input"
                placeholder="Search bands…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            {/* Absent rather than empty: a blank list still costs the stack a gap. */}
            {!listed && (
                <div className="note note--tight">{filtered.length} allocations — type to find one.</div>
            )}
            {listed && (
                <div className="list">
                    {listed.length === 0 && <Empty>No match</Empty>}
                    {visible.map((b, i) => (
                        <button
                            key={`${b.start}-${start + i}`}
                            type="button"
                            className={`list__row${start + i === activeIndex ? ' is-active' : ''}`}
                            onClick={() => {
                                const centre = Math.round((b.start + b.end) / 2);
                                if (b.mode) actions.setMode(b.mode);
                                actions.setFrequency(centre);
                                actions.setSpectrumCenter(centre);
                            }}
                        >
                            <span className="list__title">{b.button_name || cleanLabel(b.label)}</span>
                            <span className="list__meta">
                                {formatFreqShort(b.start)}–{formatFreqShort(b.end)}
                                {/* As typed, not upper-cased like the mode: a group is a
                                    name the operator wrote ("Model Control", "Blocked"),
                                    not an abbreviation. */}
                                {b.group && <span className="chip">{b.group}</span>}
                                {b.mode && <span className="chip">{b.mode.toUpperCase()}</span>}
                            </span>
                        </button>
                    ))}
                </div>
            )}
            {listed && <Pager pager={pager} unit="bands" />}
        </div>
    );
}
