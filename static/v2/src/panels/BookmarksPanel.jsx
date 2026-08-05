// Server-published bookmarks (/api/bookmarks), grouped and searchable.

import React, { useEffect, useMemo, useState } from '../react.js';
import GroupPicker, { ALL } from '../components/GroupPicker.jsx';
import { UNGROUPED, groupsOf, hiddenGroups, onGroupsChanged } from '../lib/bookmarkGroups.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Empty, ShowMore } from '../components/ui.jsx';
import { formatFreqShort } from '../lib/format.js';

// Panels do not scroll on their own, so a few hundred bookmarks would make the
// dock unusably long. Render a page at a time and grow on demand.
const PAGE = 10;

export default function BookmarksPanel() {
    const { actions, catalog } = useRadio();
    // The unfiltered list: this panel is where a hidden group is turned back
    // on, so it has to keep listing one. `catalog.bookmarks` is what the rest
    // of the interface sees, which is the filtered one.
    const items = catalog.allBookmarks;
    const [query, setQuery] = useState('');
    // '__all__' rather than '', because '' is a real group — the ungrouped one.
    const [group, setGroup] = useState(ALL);
    const [hidden, setHidden] = useState(hiddenGroups);
    useEffect(() => onGroupsChanged(setHidden), []);
    const [limit, setLimit] = useState(PAGE);

    // Narrowing the search starts from the top again.
    useEffect(() => { setLimit(PAGE); }, [query, group]);

    const groups = useMemo(() => groupsOf(items), [items]);

    const filtered = useMemo(() => {
        if (!items) return null;
        const q = query.trim().toLowerCase();
        return items.filter((b) => {
            if (group !== ALL && (b.group || UNGROUPED) !== group) return false;
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
            <GroupPicker
                groups={groups}
                value={group}
                onChange={setGroup}
                hidden={hidden}
                total={items.length}
            />
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
