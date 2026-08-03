// Bookmarks kept in this browser, as opposed to the ones the receiver
// publishes. Storage is v1's exactly — see lib/localBookmarks.js — so the two
// frontends read and write one shared list; only the presentation is v2's.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Empty, Icon, Menu, MenuItem, ShowMore } from '../components/ui.jsx';
import { formatFreqShort } from '../lib/format.js';
import { MODES } from '../radio/constants.js';
import {
    EXPORT_FORMATS, download, exportText, importText,
    localBookmarks, mutate, onLocalBookmarksChanged,
} from '../lib/localBookmarks.js';

const PAGE = 10;

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

export default function LocalBookmarksPanel() {
    const { actions, tuning } = useRadio();
    const [items, setItems] = useState(null);
    const [query, setQuery] = useState('');
    const [group, setGroup] = useState('');
    const [limit, setLimit] = useState(PAGE);
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

    useEffect(() => { setLimit(PAGE); }, [query, group]);

    const groups = useMemo(
        () => [...new Set((items || []).map((b) => b.group).filter(Boolean))].sort(),
        [items],
    );

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return (items || [])
            .filter((b) => {
                if (group && b.group !== group) return false;
                if (!q) return true;
                return `${b.name} ${b.comment || ''} ${b.group || ''} ${b.mode} ${b.frequency}`
                    .toLowerCase().includes(q);
            })
            .sort((a, b) => a.frequency - b.frequency);
    }, [items, query, group]);

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
        download(exportText(m, fmt.id), `ubersdr-bookmarks-${stamp}.${fmt.ext}`, fmt.type);
    };

    if (items == null) return <Empty>Loading local bookmarks…</Empty>;

    return (
        <div className="stack">
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
                    Add current
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
                    {groups.length > 0 && (
                        <select className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
                            <option value="">All groups ({items.length})</option>
                            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                        </select>
                    )}
                </>
            )}

            {items.length === 0 && !editing && (
                <Empty>Nothing saved yet — "Add current" stores where you are now.</Empty>
            )}

            <div className="list">
                {items.length > 0 && filtered.length === 0 && <Empty>No match</Empty>}
                {filtered.slice(0, limit).map((b) => (
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
                    </div>
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
