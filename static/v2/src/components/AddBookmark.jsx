// Save a frequency as a local bookmark, from wherever it was picked.
//
// The store is v1's shared IndexedDB (see lib/localBookmarks.js), so anything
// saved here appears in v1's bookmark list too. Only the name is asked for:
// frequency, mode and passband come from the caller, and the group and comment
// are for the panel, where there is room to edit them properly.

import React, { useEffect, useRef, useState } from '../react.js';
import { Button, Modal } from './ui.jsx';
import { mutate } from '../lib/localBookmarks.js';
import { formatFreqShort } from '../lib/format.js';

/** "7.100 MHz LSB" — enough to tell two bookmarks apart before it is renamed. */
export function defaultName(frequency, mode) {
    return `${formatFreqShort(frequency)} ${String(mode || '').toUpperCase()}`.trim();
}

export default function AddBookmark({ frequency, mode, bandwidthLow, bandwidthHigh, onClose, onSaved }) {
    const [name, setName] = useState(() => defaultName(frequency, mode));
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const inputRef = useRef(null);

    // Focused and selected, so the suggested name can be replaced by typing.
    useEffect(() => {
        const el = inputRef.current;
        if (el) { el.focus(); el.select(); }
    }, []);

    const save = async (e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) { setError('A name is needed.'); return; }
        setBusy(true);
        try {
            await mutate((m) => m.add({
                name: trimmed,
                frequency: Math.round(frequency),
                mode,
                // The passband goes with it, as the panel's own editor does —
                // a bookmark on a narrow CW signal is not the same bookmark at
                // 3 kHz wide.
                bandwidth_low: bandwidthLow,
                bandwidth_high: bandwidthHigh,
            }));
            if (onSaved) onSaved(trimmed);
            onClose();
        } catch (err) {
            // The store refuses a duplicate name, which is the common case here
            // — the suggested name is the frequency, and you may already have
            // bookmarked it.
            setError(err.message || 'Could not save.');
            setBusy(false);
        }
    };

    return (
        <Modal onClose={onClose} label="Add local bookmark">
            <form className="stack addmark" onSubmit={save}>
                <h2 className="addmark__title">Add local bookmark</h2>
                <div className="addmark__at">
                    {formatFreqShort(frequency)} · {String(mode || '').toUpperCase()}
                </div>
                <input
                    ref={inputRef}
                    className="input"
                    value={name}
                    maxLength={80}
                    onChange={(e) => { setName(e.target.value); setError(''); }}
                />
                {error && <div className="note note--warn">{error}</div>}
                <div className="row-end">
                    <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button size="sm" variant="primary" type="submit" disabled={busy}>Save</Button>
                </div>
            </form>
        </Modal>
    );
}
