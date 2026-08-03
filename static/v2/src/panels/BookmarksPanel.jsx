// Server-published bookmarks (/api/bookmarks), grouped and searchable.

import React, { useEffect, useMemo, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Empty } from '../components/ui.jsx';
import { formatFreqShort } from '../lib/format.js';

export default function BookmarksPanel() {
    const { actions } = useRadio();
    const [items, setItems] = useState(null);
    const [query, setQuery] = useState('');
    const [group, setGroup] = useState('');

    useEffect(() => {
        fetch('/api/bookmarks')
            .then((r) => r.json())
            .then((list) => setItems(Array.isArray(list) ? list : []))
            .catch(() => setItems([]));
    }, []);

    const groups = useMemo(() => {
        if (!items) return [];
        return [...new Set(items.map((b) => b.group).filter(Boolean))].sort();
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
                    {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
            )}
            <div className="list">
                {filtered.length === 0 && <Empty>No match</Empty>}
                {filtered.slice(0, 400).map((b, i) => (
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
                {filtered.length > 400 && <Empty>Showing first 400 of {filtered.length} — refine the search.</Empty>}
            </div>
        </div>
    );
}
