// Band list from /api/bands. The server returns every allocation across
// 0–30 MHz — hundreds of entries — and panels do not scroll on their own, so
// the list renders a page at a time. With no search term it opens on the page
// holding the band the receiver is currently in, which is the part worth seeing.

import React, { useMemo, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Empty } from '../components/ui.jsx';
import { PAGE_ROWS, Pager, usePager } from '../components/Pager.jsx';
import { formatFreqShort } from '../lib/format.js';

// The API packs a second line after a "|" and sometimes uses tabs as spacing.
function cleanLabel(raw) {
    return String(raw || '').split('|').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ');
}

export default function BandsPanel() {
    const { tuning, actions, catalog } = useRadio();
    const bands = catalog.bands;
    const [query, setQuery] = useState('');

    const filtered = useMemo(() => {
        if (!bands) return null;
        const q = query.trim().toLowerCase();
        if (!q) return bands;
        return bands.filter((b) => cleanLabel(b.label).toLowerCase().includes(q));
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
    const home = query.trim() ? -1 : activeIndex;
    const homePage = home < 0 ? -1 : Math.floor(home / PAGE_ROWS);
    const { start, end, pager } = usePager(filtered ? filtered.length : 0, {
        at: home,
        deps: [query, homePage],
    });
    const visible = filtered ? filtered.slice(start, end) : [];

    if (!filtered) return <Empty>Loading bands…</Empty>;

    return (
        <div className="stack">
            <input
                className="input"
                placeholder="Search bands…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            <div className="list">
                {filtered.length === 0 && <Empty>No match</Empty>}
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
                            {b.mode && <span className="chip">{b.mode.toUpperCase()}</span>}
                        </span>
                    </button>
                ))}
            </div>
            <Pager pager={pager} unit="bands" />
        </div>
    );
}
