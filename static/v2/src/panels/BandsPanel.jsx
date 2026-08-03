// Band list from /api/bands. The server returns every allocation across
// 0–30 MHz — hundreds of entries — and panels do not scroll on their own, so
// the list renders a page at a time. With no search term the page is positioned
// around the band the receiver is currently in, which is the part worth seeing.

import React, { useEffect, useMemo, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Empty, ShowMore } from '../components/ui.jsx';
import { formatFreqShort } from '../lib/format.js';

const PAGE = 25;

// The API packs a second line after a "|" and sometimes uses tabs as spacing.
function cleanLabel(raw) {
    return String(raw || '').split('|').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ');
}

export default function BandsPanel() {
    const { tuning, actions } = useRadio();
    const [bands, setBands] = useState(null);
    const [query, setQuery] = useState('');
    const [limit, setLimit] = useState(PAGE);

    useEffect(() => {
        fetch('/api/bands')
            .then((r) => r.json())
            .then((list) => setBands(Array.isArray(list) ? list : []))
            .catch(() => setBands([]));
    }, []);

    // A new search starts from the top again.
    useEffect(() => { setLimit(PAGE); }, [query]);

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

    // Show the current band in context rather than the bottom of the LF end.
    const start = query.trim() || activeIndex < 0 ? 0 : Math.max(0, activeIndex - 4);
    const visible = filtered ? filtered.slice(start, start + limit) : [];

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
            <ShowMore
                shown={Math.min(start + limit, filtered.length) - start}
                total={filtered.length - start}
                onMore={() => setLimit((n) => n + PAGE)}
            />
        </div>
    );
}
