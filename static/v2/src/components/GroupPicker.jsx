// The bookmark group dropdown, and the switch for what a group is allowed to do.
//
// One control rather than a list of switches, because a receiver can publish
// hundreds of groups: a native select scrolls, and typing jumps to a name,
// which is the only thing that works at that size. Selecting a group is
// therefore both "show me this one" and "this is the one I am talking about".
//
// The two meanings are kept apart in what they affect. The selection filters
// the list in the panel below; the eye decides whether the group propagates at
// all — the marker bar, the ⏮/⏭ neighbours, the Markers panel, the lock screen.
// Neither changes the other.
//
// A hidden group stays in the dropdown, marked as hidden. It has to: it is the
// only way back.

import React from '../react.js';
import { Icon } from './ui.jsx';
import {
    UNGROUPED, UNGROUPED_LABEL, isGroupHidden, setGroupHidden, showAllGroups,
} from '../lib/bookmarkGroups.js';

// Not '' — that is a real group here, the ungrouped one.
export const ALL = '__all__';

export default function GroupPicker({ groups, value, onChange, hidden, total }) {
    if (!groups.length) return null;

    const label = (g) => (g.name === UNGROUPED ? UNGROUPED_LABEL : g.name);
    const selected = groups.find((g) => g.name === value);
    // "All groups" is a view, not a group — there is nothing for the eye to act
    // on, and hiding everything at once is what `show all` exists to undo.
    const canToggle = !!selected;
    const isHidden = canToggle && hidden.has(selected.name);
    const hiddenCount = hidden.size;

    return (
        <>
            <div className="bmg">
                <select
                    className="select bmg__select"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                >
                    <option value={ALL}>All groups ({total})</option>
                    {groups.map((g) => (
                        <option key={g.name} value={g.name}>
                            {label(g)} ({g.count}){hidden.has(g.name) ? ' · hidden' : ''}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    className={`bmg__eye${isHidden ? ' is-hidden' : ''}`}
                    disabled={!canToggle}
                    title={!canToggle
                        ? 'Pick a group to show or hide it'
                        : isHidden
                            ? `${label(selected)} is hidden from markers and skipping — click to use it again`
                            : `Stop using ${label(selected)} for markers and skipping`}
                    onClick={() => setGroupHidden(selected.name, !isHidden)}
                >
                    {isHidden ? <Icon.EyeOff size={14} /> : <Icon.Eye size={14} />}
                </button>
            </div>

            {hiddenCount > 0 && (
                <div className="bmg__note">
                    {hiddenCount === 1 ? '1 group hidden' : `${hiddenCount} groups hidden`}
                    {' — '}
                    <button type="button" className="bmg__reset" onClick={showAllGroups}>
                        show all
                    </button>
                </div>
            )}
        </>
    );
}

export { isGroupHidden };
