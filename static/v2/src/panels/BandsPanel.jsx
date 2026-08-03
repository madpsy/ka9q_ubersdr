// Band list from /api/bands. The server returns every allocation across
// 0–30 MHz — hundreds of entries — so the list is searchable and the current
// frequency's band is highlighted and scrolled into view.

import React, { useEffect, useMemo, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Empty } from '../components/ui.jsx';
import { formatFreqShort } from '../lib/format.js';

// The API packs a second line after a "|" and sometimes uses tabs as spacing.
function cleanLabel(raw) {
    return String(raw || '').split('|').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ');
}

export default function BandsPanel() {
    const { tuning, actions } = useRadio();
    const [bands, setBands] = useState(null);
    const [query, setQuery] = useState('');
    const activeRef = useRef(null);

    useEffect(() => {
        fetch('/api/bands')
            .then((r) => r.json())
            .then((list) => setBands(Array.isArray(list) ? list : []))
            .catch(() => setBands([]));
    }, []);

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

    useEffect(() => {
        if (activeRef.current) activeRef.current.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);

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
                {filtered.map((b, i) => (
                    <button
                        key={`${b.start}-${i}`}
                        type="button"
                        ref={i === activeIndex ? activeRef : null}
                        className={`list__row${i === activeIndex ? ' is-active' : ''}`}
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
        </div>
    );
}
