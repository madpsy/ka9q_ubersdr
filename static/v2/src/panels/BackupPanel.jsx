// Take everything this browser has learned somewhere else — another machine,
// another browser, or a file kept against the day localStorage is cleared.
//
// The sections come from lib/backup.js rather than from here, so this panel
// lists whatever that file lists. Local bookmarks are the one section that is
// not localStorage: they live in an IndexedDB database shared with v1, so the
// reading and writing of them happens here and the array is handed to the
// bundle.
//
// `minimal` keeps export, import and the choice between merge and replace, and
// drops the per-section switches — the whole lot, which is what most people
// want from a backup anyway.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Button, Field, Icon, Segmented, Switch } from '../components/ui.jsx';
import { downloadFile, localBookmarks, mutate } from '../lib/localBookmarks.js';
import {
    SECTIONS, applyBundle, buildBundle, bundleFilename, inspect, presentCount,
} from '../lib/backup.js';

const MODES = [
    { value: 'merge', label: 'Merge' },
    { value: 'replace', label: 'Replace' },
];

export default function BackupPanel({ minimal }) {
    // Everything is selected to begin with: a backup that quietly left a
    // section out is the failure this panel exists to prevent.
    const [chosen, setChosen] = useState(() => new Set(SECTIONS.map((s) => s.id)));
    const [counts, setCounts] = useState({});
    const [file, setFile] = useState(null);      // { name, bundle, report }
    const [mode, setMode] = useState('merge');
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    // Set once something has been written. Until the page reloads the running
    // stores still hold the old values and will write them back over the new
    // ones, so this is a state the panel has to be honest about.
    const [applied, setApplied] = useState(null);
    const fileRef = useRef(null);

    const refreshCounts = useCallback(() => {
        const next = {};
        for (const s of SECTIONS) {
            if (!s.bookmarks) next[s.id] = presentCount(s.id);
        }
        setCounts(next);
        const m = localBookmarks();
        m.ready.then(
            () => setCounts((c) => ({ ...c, bookmarks: m.getAll().length })),
            () => { /* no database: the section stays at zero */ },
        );
    }, []);

    useEffect(refreshCounts, [refreshCounts]);

    const toggle = (id) => setChosen((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const doExport = async () => {
        setError('');
        try {
            let bookmarks = null;
            if (chosen.has('bookmarks')) {
                const m = localBookmarks();
                await m.ready;
                bookmarks = m.getAll().slice();
            }
            const bundle = buildBundle([...chosen], { bookmarks });
            const settings = Object.keys(bundle.items).length;
            if (!settings && !(bundle.bookmarks && bundle.bookmarks.length)) {
                setStatus('');
                setError('Nothing selected has anything saved yet.');
                return;
            }
            downloadFile(JSON.stringify(bundle, null, 2), bundleFilename(), 'application/json');
            setStatus(`Saved ${settings} setting${settings === 1 ? '' : 's'}`
                + (bundle.bookmarks ? ` and ${bundle.bookmarks.length} bookmarks` : '') + '.');
        } catch (e) {
            setStatus('');
            setError(e.message || 'Export failed.');
        }
    };

    const onFile = async (e) => {
        const picked = e.target.files && e.target.files[0];
        e.target.value = '';                      // so the same file can be picked twice
        if (!picked) return;
        setStatus('');
        setError('');
        setApplied(null);
        let bundle = null;
        try {
            bundle = JSON.parse(await picked.text());
        } catch (err) {
            setFile(null);
            setError('That file is not readable JSON.');
            return;
        }
        const report = inspect(bundle);
        if (!report.ok) {
            setFile(null);
            setError(report.error);
            return;
        }
        setFile({ name: picked.name, bundle, report });
        // Only what the file actually carries, so Apply cannot claim to have
        // restored a section that was never in it.
        setChosen(new Set(report.sections.map((s) => s.id)));
    };

    const apply = async () => {
        if (!file) return;
        setError('');
        try {
            const ids = [...chosen];
            const r = applyBundle(file.bundle, ids, mode);
            let bookmarks = 0;
            if (chosen.has('bookmarks') && Array.isArray(file.bundle.bookmarks)) {
                const res = await mutate((m) => m.importBookmarks(file.bundle.bookmarks, mode));
                bookmarks = res.imported;
            }
            setApplied({ ...r, bookmarks });
            setStatus('');
            refreshCounts();
        } catch (e) {
            setError(e.message || 'Import failed.');
        }
    };

    const listed = SECTIONS.filter((s) => {
        if (!file) return true;
        return file.report.sections.some((r) => r.id === s.id);
    });

    return (
        <div className="stack">
            {!minimal && (
                <div className="note note--tight">
                    A settings file holds what this browser remembers — panels, mappings,
                    shortcuts and bookmarks — so you can move it to another machine or put
                    it back after clearing your browser. Passwords are never included.
                </div>
            )}

            <div className="chip-row chip-row--wrap">
                <Button
                    size="sm"
                    variant="primary"
                    icon={<Icon.Download size={13} />}
                    onClick={doExport}
                    disabled={chosen.size === 0}
                >
                    Export
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon.Upload size={13} />}
                    onClick={() => fileRef.current && fileRef.current.click()}
                >
                    Import…
                </Button>
                <input
                    ref={fileRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: 'none' }}
                    onChange={onFile}
                />
            </div>

            {status && <div className="note note--tight">{status}</div>}
            {error && <div className="note note--warn">{error}</div>}

            {file && (
                <>
                    <div className="divider" />
                    <span className="section-label">
                        {file.name}
                        {file.report.exported && (
                            <span className="section-label__note">
                                {file.report.exported.slice(0, 10)}
                            </span>
                        )}
                    </span>
                    {file.report.warning && (
                        <div className="note note--warn">{file.report.warning}</div>
                    )}
                    {file.report.unknown.length > 0 && (
                        <div className="note note--tight">
                            {file.report.unknown.length} setting
                            {file.report.unknown.length === 1 ? '' : 's'} in this file
                            {file.report.unknown.length === 1 ? ' is' : ' are'} not
                            recognised and will be left out.
                        </div>
                    )}
                </>
            )}

            {!minimal && (
                <div className="bk-list">
                    {listed.map((s) => {
                        const inFile = file
                            ? (file.report.sections.find((r) => r.id === s.id) || {}).count
                            : null;
                        const here = counts[s.id] || 0;
                        return (
                            <div className="bk-row" key={s.id}>
                                <div className="bk-row__head">
                                    <span className="bk-row__name">{s.label}</span>
                                    <span className="bk-row__count">
                                        {file ? `${inFile} in file` : here || '—'}
                                    </span>
                                    <Switch
                                        checked={chosen.has(s.id)}
                                        onChange={() => toggle(s.id)}
                                        title={s.hint}
                                    />
                                </div>
                                <span className="bk-row__hint">{s.hint}</span>
                            </div>
                        );
                    })}
                </div>
            )}

            {file && (
                <>
                    <Field
                        label="On import"
                        hint={mode === 'replace'
                            ? 'settings not in the file are cleared'
                            : 'settings not in the file are kept'}
                    >
                        <Segmented size="sm" options={MODES} value={mode} onChange={setMode} />
                    </Field>

                    <div className="chip-row chip-row--wrap">
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={apply}
                            disabled={chosen.size === 0 || !!applied}
                        >
                            {mode === 'replace' ? 'Replace settings' : 'Merge settings'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => { setFile(null); setApplied(null); }}>
                            Cancel
                        </Button>
                    </div>
                </>
            )}

            {applied && (
                <div className="note note--warn bk-note">
                    <span>
                        Restored {applied.written} setting{applied.written === 1 ? '' : 's'}
                        {applied.removed ? `, cleared ${applied.removed}` : ''}
                        {applied.bookmarks ? `, imported ${applied.bookmarks} bookmarks` : ''}.
                        Reload to use them — until then this page is still running the old ones.
                    </span>
                    <Button size="sm" variant="primary" onClick={() => location.reload()}>
                        Reload
                    </Button>
                </div>
            )}
        </div>
    );
}
