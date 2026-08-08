// Bookmarks kept in this browser, as opposed to the ones the receiver
// publishes. Storage is v1's exactly — see lib/localBookmarks.js — so the two
// frontends read and write one shared list; only the presentation is v2's.
//
// `minimal` is the search box and its matches, and nothing else: no group picker, no
// Current/Import/Export, no edit or delete beside a row. Everything dropped is *writing* —
// done once, at a desk, in the full panel — and what is left is the only thing anybody does
// to a saved bookmark afterwards, which is tune to it. Nothing typed, nothing listed, so
// the panel is two rows tall until it is being used.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import GroupPicker, { ALL } from '../components/GroupPicker.jsx';
import { UNGROUPED, groupsOf, hiddenGroups, onGroupsChanged } from '../lib/bookmarkGroups.js';
import { Button, Empty, Icon, Menu, MenuItem } from '../components/ui.jsx';
import { MINIMAL_ROWS, PAGE_ROWS, Pager, usePager } from '../components/Pager.jsx';
import { formatFreqShort } from '../lib/format.js';
import { MODES } from '../radio/constants.js';
import {
    EXPORT_FORMATS, downloadFile, exportText, importText,
    localBookmarks, mutate, onLocalBookmarksChanged,
} from '../lib/localBookmarks.js';

const BLANK = { name: '', frequency: '', mode: 'usb', group: '', comment: '' };

// The panel edits the fields v1's form exposes. `extension` and the bandwidth
// pair are preserved untouched on edit rather than being dropped, because
// imports (KiwiSDR passbands especially) carry them.
function Form({ initial, onSave, onCancel, error }) {
    const [f, setF] = useState(initial);
    const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

    return (
        <div className="lb-form">
            <input className="input" placeholder="Name" value={f.name} onChange={set('name')} autoFocus />
            <div className="lb-form__row">
                <input
                    className="input"
                    placeholder="Frequency (Hz)"
                    inputMode="numeric"
                    value={f.frequency}
                    onChange={set('frequency')}
                />
                <select className="select" value={f.mode} onChange={set('mode')}>
                    {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
            </div>
            <div className="lb-form__row">
                <input className="input" placeholder="Group" value={f.group || ''} onChange={set('group')} />
                <input className="input" placeholder="Comment" value={f.comment || ''} onChange={set('comment')} />
            </div>
            {error && <div className="note note--warn">{error}</div>}
            <div className="row-end">
                <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
                <Button size="sm" variant="primary" onClick={() => onSave(f)}>Save</Button>
            </div>
        </div>
    );
}

export default function LocalBookmarksPanel({ minimal }) {
    const { actions, tuning } = useRadio();
    const [items, setItems] = useState(null);
    const [query, setQuery] = useState('');
    const [group, setGroup] = useState(ALL);
    const [hidden, setHidden] = useState(hiddenGroups);
    const [editing, setEditing] = useState(null);   // { original, values } | 'new'
    const [error, setError] = useState('');
    const [status, setStatus] = useState('');
    const [confirming, setConfirming] = useState(null);   // name awaiting a second click
    const fileRef = useRef(null);

    const refresh = useCallback(() => {
        const m = localBookmarks();
        m.ready.then(() => setItems(m.getAll().slice()), () => setItems([]));
    }, []);

    useEffect(() => {
        refresh();
        return onLocalBookmarksChanged(refresh);
    }, [refresh]);

    const groups = useMemo(() => groupsOf(items), [items]);
    useEffect(() => onGroupsChanged(setHidden), []);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return (items || [])
            .filter((b) => {
                if (group !== ALL && (b.group || UNGROUPED) !== group) return false;
                if (!q) return true;
                return `${b.name} ${b.comment || ''} ${b.group || ''} ${b.mode} ${b.frequency}`
                    .toLowerCase().includes(q);
            })
            .sort((a, b) => a.frequency - b.frequency);
    }, [items, query, group]);

    // Cut down, the list is only the answer to a search: nothing typed, nothing listed.
    const searching = query.trim().length > 0;
    const listed = minimal && !searching ? null : filtered;

    // One page at a time — the dock scrolls, the panel does not. Deleting a bookmark can
    // empty the last page, which the pager clamps for us rather than leaving a blank list.
    const { start, end, pager } = usePager(listed ? listed.length : 0, {
        // Shorter pages cut down: the view exists to take less of the dock.
        rows: minimal ? MINIMAL_ROWS : PAGE_ROWS,
        deps: [query, group],
    });

    const tune = (b) => {
        if (b.mode) actions.setMode(b.mode);
        actions.setFrequency(b.frequency);
        // v1 restores a bookmark's saved passband too, when it has one.
        if (typeof b.bandwidth_low === 'number' && typeof b.bandwidth_high === 'number') {
            actions.setBandwidth(b.bandwidth_low, b.bandwidth_high);
        }
        actions.ensureVisible(b.frequency);
    };

    const save = async (values) => {
        const record = {
            name: values.name.trim(),
            frequency: parseInt(values.frequency, 10),
            mode: values.mode,
            group: values.group ? values.group.trim() : null,
            comment: values.comment ? values.comment.trim() : null,
        };
        if (!record.name || !Number.isFinite(record.frequency) || !record.mode) {
            setError('Name, frequency and mode are required.');
            return;
        }
        try {
            if (editing && editing.original) {
                await mutate((m) => m.update(editing.original, record));
            } else {
                await mutate((m) => m.add(record));
            }
            setEditing(null);
            setError('');
        } catch (e) {
            setError(e.message || 'Could not save.');
        }
    };

    // Two-step delete rather than v1's confirm() dialog: there is no undo, and a
    // modal in a dock panel is heavier than the action deserves.
    const remove = async (b) => {
        if (confirming !== b.name) {
            setConfirming(b.name);
            return;
        }
        setConfirming(null);
        try {
            await mutate((m) => m.delete(b.name));
        } catch (e) {
            setError(e.message || 'Could not delete.');
        }
    };

    const onFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';                      // allow re-importing the same file
        if (!file) return;
        try {
            const text = await file.text();
            const r = await mutate((m) => importText(m, file.name, text, 'merge'));
            setStatus(`Imported ${r.imported}, skipped ${r.skipped}${r.errors ? `, ${r.errors} errors` : ''}`);
        } catch (err) {
            setStatus('');
            setError(err.message || 'Import failed.');
        }
    };

    const doExport = (fmt) => {
        const m = localBookmarks();
        const stamp = new Date().toISOString().slice(0, 10);
        downloadFile(exportText(m, fmt.id), `ubersdr-bookmarks-${stamp}.${fmt.ext}`, fmt.type);
    };

    if (items == null) return <Empty>Loading local bookmarks…</Empty>;

    return (
        <div className="stack">
            {!minimal && (
            <div className="lb-tools">
                <Button
                    size="sm"
                    variant="primary"
                    icon={<Icon.Plus size={13} />}
                    title="Save the current frequency and mode"
                    onClick={() => {
                        setError('');
                        setEditing({
                            original: null,
                            values: {
                                ...BLANK,
                                frequency: String(Math.round(tuning.frequency)),
                                mode: tuning.mode,
                            },
                        });
                    }}
                >
                    Current
                </Button>
                <Button size="sm" variant="ghost" onClick={() => fileRef.current && fileRef.current.click()}>
                    Import
                </Button>
                <Menu trigger={<span className="btn btn--ghost btn--sm">Export</span>}>
                    {EXPORT_FORMATS.map((f) => (
                        <MenuItem key={f.id} onClick={() => doExport(f)} disabled={items.length === 0}>
                            {f.label}
                        </MenuItem>
                    ))}
                </Menu>
                <input
                    ref={fileRef}
                    type="file"
                    accept=".json,.yaml,.yml,.csv"
                    style={{ display: 'none' }}
                    onChange={onFile}
                />
            </div>
            )}

            {status && <div className="note note--tight">{status}</div>}
            {error && !editing && <div className="note note--warn">{error}</div>}

            {editing && (
                <Form
                    initial={editing.values}
                    error={error}
                    onSave={save}
                    onCancel={() => { setEditing(null); setError(''); }}
                />
            )}

            {items.length > 0 && (
                <>
                    <input
                        className="input"
                        placeholder="Search local bookmarks…"
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
                </>
            )}

            {/* Absent rather than empty: a blank list still costs the stack a gap. */}
            {items.length > 0 && !listed && (
                <div className="note note--tight">{items.length} saved — type to find one.</div>
            )}

            {items.length === 0 && !editing && (
                // The full panel can name the button that fixes this; cut down, that button
                // is not there to name.
                <Empty>
                    {minimal
                        ? 'Nothing saved yet.'
                        : 'Nothing saved yet — "Current" stores where you are now.'}
                </Empty>
            )}

            {listed && (
            <div className="list">
                {items.length > 0 && listed.length === 0 && <Empty>No match</Empty>}
                {listed.slice(start, end).map((b) => (
                    <div className="lb-row" key={b.name}>
                        <button type="button" className="list__row lb-row__main" onClick={() => tune(b)}>
                            <span className="list__title">
                                {b.name}
                                {b.group && <span className="chip">{b.group}</span>}
                            </span>
                            <span className="list__meta">
                                {formatFreqShort(b.frequency)}
                                <span className="chip">{b.mode.toUpperCase()}</span>
                                {b.comment && <span className="lb-row__note">{b.comment}</span>}
                            </span>
                        </button>
                        {/* Editing and deleting are the writing half of the panel, and the
                            full view is where writing happens — cut down, a row is a thing
                            to tune to, and the two buttons are most of its width. */}
                        {!minimal && (
                        <div className="lb-row__actions">
                            <Button
                                size="sm"
                                variant="ghost"
                                icon={<Icon.Sliders size={13} />}
                                title="Edit"
                                onClick={() => {
                                    setError('');
                                    setEditing({
                                        original: b.name,
                                        values: {
                                            name: b.name,
                                            frequency: String(b.frequency),
                                            mode: b.mode,
                                            group: b.group || '',
                                            comment: b.comment || '',
                                        },
                                    });
                                }}
                            />
                            <Button
                                size="sm"
                                variant={confirming === b.name ? 'danger' : 'ghost'}
                                icon={confirming === b.name ? undefined : <Icon.Close size={13} />}
                                title={confirming === b.name ? 'Click again to delete' : `Delete ${b.name}`}
                                onClick={() => remove(b)}
                                onBlur={() => setConfirming((n) => (n === b.name ? null : n))}
                            >
                                {confirming === b.name ? 'Delete?' : undefined}
                            </Button>
                        </div>
                        )}
                    </div>
                ))}
            </div>
            )}

            {listed && <Pager pager={pager} unit="bookmarks" />}
        </div>
    );
}
