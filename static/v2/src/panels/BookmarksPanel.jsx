// Server-published bookmarks (/api/bookmarks), grouped and searchable.

import React, { useEffect, useMemo, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Empty, ShowMore } from '../components/ui.jsx';
import { formatFreqShort } from '../lib/format.js';

// Panels do not scroll on their own, so a few hundred bookmarks would make the
// dock unusably long. Render a page at a time and grow on demand.
const PAGE = 10;

export default function BookmarksPanel() {
    const { actions, catalog } = useRadio();
    const items = catalog.bookmarks;
    const [query, setQuery] = useState('');
    const [group, setGroup] = useState('');
    const [limit, setLimit] = useState(PAGE);

    // Narrowing the search starts from the top again.
    useEffect(() => { setLimit(PAGE); }, [query, group]);

    const groups = useMemo(() => {
        if (!items) return [];
        // Counted here rather than filtered per option: the list is walked once
        // either way, and a group with nothing in it is worth seeing as 0
        // rather than silently reading as an empty selection.
        const counts = new Map();
        for (const b of items) {
            if (b.group) counts.set(b.group, (counts.get(b.group) || 0) + 1);
        }
        return [...counts.entries()]
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [items]);

    const filtered = useMemo(() => {
        if (!items) return null;
        const q = query.trim().toLowerCase();
        return items.filter((b) => {
            if (group && b.group !== group) return false;
            if (!q) return true;
            return `${b.name} ${b.comment || ''} ${b.group || ''}`.toLowerCase().includes(q);
        });
    }, [items, query, group]);

    if (!filtered) return <Empty>Loading bookmarks…</Empty>;
    if (!items.length) return <Empty>No bookmarks published by this receiver.</Empty>;

    return (
        <div className="stack">
            <input
                className="input"
                placeholder="Search bookmarks…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            {groups.length > 0 && (
                <select className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
                    <option value="">All groups ({items.length})</option>
                    {groups.map((g) => (
                        <option key={g.name} value={g.name}>{g.name} ({g.count})</option>
                    ))}
                </select>
            )}
            <div className="list">
                {filtered.length === 0 && <Empty>No match</Empty>}
                {filtered.slice(0, limit).map((b, i) => (
                    <button
                        key={`${b.frequency}-${i}`}
                        type="button"
                        className="list__row"
                        title={b.comment || ''}
                        onClick={() => {
                            if (b.mode) actions.setMode(b.mode);
                            actions.setFrequency(b.frequency);
                            actions.setSpectrumCenter(b.frequency);
                        }}
                    >
                        <span className="list__title">{b.name}</span>
                        <span className="list__meta">
                            {formatFreqShort(b.frequency)}
                            {b.mode && <span className="chip">{b.mode.toUpperCase()}</span>}
                        </span>
                    </button>
                ))}
            </div>
            <ShowMore
                shown={Math.min(limit, filtered.length)}
                total={filtered.length}
                onMore={() => setLimit((n) => n + PAGE)}
            />
        </div>
    );
}
