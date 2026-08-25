// Server-published bookmarks (/api/bookmarks), grouped and searchable.
//
// `minimal` is the search box and what it finds, and nothing else. A published list runs to
// hundreds of entries on a busy receiver, so the full view's job is browsing — the group
// picker, the page you left off on — and none of that is what a cut-down panel is for. Cut
// down, it answers one question: where is the bookmark called X? Until something is typed
// there is no list at all, which is the point: the panel is then two rows tall.

import React, { useEffect, useMemo, useState } from '../react.js';
import GroupPicker, { ALL } from '../components/GroupPicker.jsx';
import { UNGROUPED, groupsOf, hiddenGroups, onGroupsChanged } from '../lib/bookmarkGroups.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Empty } from '../components/ui.jsx';
import { MINIMAL_ROWS, PAGE_ROWS, Pager, usePager } from '../components/Pager.jsx';
import { formatFreqShort } from '../lib/format.js';
import { bookmarkReachable, bookmarkTarget } from '../lib/bookmarkTune.js';
import { MAX_FREQ, MIN_FREQ } from '../radio/constants.js';

export default function BookmarksPanel({ minimal }) {
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

    // Cut down, the list is only the answer to a search: nothing typed, nothing listed.
    const searching = query.trim().length > 0;
    const listed = minimal && !searching ? null : filtered;

    // Panels do not scroll on their own, so a few hundred bookmarks would make the dock
    // unusably long: one page at a time, and the search or group picker starts over.
    const { start, end, pager } = usePager(listed ? listed.length : 0, {
        // Shorter pages cut down: the view exists to take less of the dock.
        rows: minimal ? MINIMAL_ROWS : PAGE_ROWS,
        deps: [query, group],
    });

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
            {!minimal && (
                <GroupPicker
                    groups={groups}
                    value={group}
                    onChange={setGroup}
                    hidden={hidden}
                    total={items.length}
                />
            )}
            {/* An empty div here would still cost the stack a gap, so the whole list —
                and its pager — is absent rather than blank until there is a search. */}
            {!listed && (
                <div className="note note--tight">{items.length} bookmarks — type to find one.</div>
            )}
            {listed && (
                <div className="list">
                    {listed.length === 0 && <Empty>No match</Empty>}
                    {listed.slice(start, end).map((b, i) => {
                        // A bookmark outside this receiver's range is shown, not hidden —
                        // it is the operator's record and may become reachable again — but
                        // it cannot be clicked. tuneTo would clamp to the band edge and
                        // land on 30 MHz looking like it worked. See bookmarkReachable.
                        const reachable = bookmarkReachable(b, MIN_FREQ, MAX_FREQ);
                        return (
                        <button
                            key={`${b.frequency}-${start + i}`}
                            type="button"
                            className={`list__row${reachable ? '' : ' list__row--disabled'}`}
                            disabled={!reachable}
                            title={reachable
                                ? (b.comment || '')
                                : `${formatFreqShort(b.frequency)} is outside this receiver's range `
                                  + `(${MIN_FREQ / 1000} kHz–${MAX_FREQ / 1e6} MHz)`}
                            // Frequency, mode and the bookmark's passband if it has one, in
                            // one tune — see lib/bookmarkTune.js. A receiver's config.yaml
                            // can set bandwidth_low/high on a bookmark, and it used to be
                            // published, drawn on the marker bar and then ignored here.
                            onClick={() => {
                                actions.tuneTo(bookmarkTarget(b));
                                actions.setSpectrumCenter(b.frequency);
                            }}
                        >
                            <span className="list__title">{b.name}</span>
                            <span className="list__meta">
                                {formatFreqShort(b.frequency)}
                                {b.mode && <span className="chip">{b.mode.toUpperCase()}</span>}
                            </span>
                        </button>
                        );
                    })}
                </div>
            )}
            {listed && <Pager pager={pager} unit="bookmarks" />}
        </div>
    );
}
