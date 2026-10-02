// The playground's named graphs, as the window shows them: the name in the title
// bar, and the dialogs for saving, opening and exporting. What is kept and how
// is library.js's; this is only what it looks like.

import React, { useEffect, useRef, useState } from '../../react.js';
import { Button, Icon } from '../../components/ui.jsx';
import { NAME_MAX, cleanGraphName } from '../graph.js';
import { findSaved, sameGraphName } from '../library.js';
import { isAnnotation } from '../geometry.js';

const blocksIn = (g) => {
    const n = (g && Array.isArray(g.nodes) ? g.nodes : []).filter((x) => !isAnnotation(x.type)).length;
    return `${n} ${n === 1 ? 'block' : 'blocks'}`;
};

const when = (ms) => {
    if (!ms) return '';
    try {
        return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (err) {
        return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    }
};

const SAVE_STATE = {
    unsaved: 'Not saved in this browser',
    changed: 'Changed since it was saved',
};

/**
 * The graph's name, in the title bar, renamed where it stands.
 *
 * An input dressed as a title rather than a title with a rename button: the
 * name is the one thing about a graph people want to change on sight. It is as
 * wide as what is in it, up to what the bar can spare, and ends in an ellipsis
 * beyond that — the whole name is in its tooltip, and on focus, where the text
 * scrolls.
 *
 * Taken on Enter or on leaving it, not per keystroke: a name is cleaned of
 * surrounding space as it is kept, and keeping it per keystroke would eat the
 * space before the word being typed. Escape puts it back.
 */
export function GraphName({ name, state, onRename }) {
    const [text, setText] = useState(name || '');
    const editing = useRef(false);
    const cancelled = useRef(false);
    useEffect(() => {
        if (!editing.current) setText(name || '');
    }, [name]);
    const commit = () => {
        editing.current = false;
        if (cancelled.current) {
            cancelled.current = false;
            setText(name || '');
            return;
        }
        const next = cleanGraphName(text);
        setText(next);
        if (next !== (name || '')) onRename(next);
    };
    const shown = text || 'Untitled graph';
    return (
        <span className="pg__name-box">
            <input
                className="pg__name"
                value={text}
                placeholder="Untitled graph"
                maxLength={NAME_MAX}
                aria-label="Graph name"
                title={name ? `${name} — click to rename` : 'Name this graph'}
                spellCheck={false}
                style={{ width: `${Math.min(shown.length, NAME_MAX) + 2}ch` }}
                onFocus={() => { editing.current = true; }}
                onChange={(e) => setText(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    else if (e.key === 'Escape') {
                        // The name back, and the window left open.
                        e.stopPropagation();
                        cancelled.current = true;
                        e.currentTarget.blur();
                    }
                }}
            />
            {SAVE_STATE[state] && (
                <span className={`pg__dirty pg__dirty--${state}`} role="img" aria-label={SAVE_STATE[state]} title={SAVE_STATE[state]} />
            )}
        </span>
    );
}

/** A name to save under: for an unnamed graph, and for Save as. */
export function SaveNameDialog({ initial, title, onCancel, onSave }) {
    const [text, setText] = useState(initial || '');
    const name = cleanGraphName(text);
    const taken = name ? findSaved(name) : null;
    const box = useRef(null);
    useEffect(() => {
        if (box.current && box.current.focus) {
            box.current.focus();
            if (box.current.select) box.current.select();
        }
    }, []);
    const go = () => { if (name) onSave(name); };
    return (
        <div className="pg-dialog pg-confirm pg-save" role="dialog" aria-label={title}>
            <div className="pg-dialog__card">
                <div className="pg-dialog__title">{title}</div>
                <p>Saved in this browser, under this name. It comes with the graph into a file or a link.</p>
                <input
                    ref={box}
                    className="input pg-save__name"
                    value={text}
                    placeholder="Name"
                    maxLength={NAME_MAX}
                    aria-label="Name"
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') go();
                        else if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
                    }}
                />
                {taken && <div className="note note--tight note--warn pg-save__taken">{`Replaces the saved graph called “${taken.name}”.`}</div>}
                <div className="pg-dialog__actions">
                    <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
                    <Button size="sm" variant={taken ? 'danger' : 'primary'} icon={<Icon.Save />} disabled={!name} onClick={go}>
                        {taken ? 'Replace it' : 'Save'}
                    </Button>
                </div>
            </div>
        </div>
    );
}

/** Save would write over a saved graph that this one is not a copy of. */
export function SaveReplaceDialog({ name, onCancel, onRename, onReplace }) {
    return (
        <div className="pg-dialog pg-confirm" role="dialog" aria-label="Replace a saved graph?">
            <div className="pg-dialog__card">
                <div className="pg-dialog__title">{`Replace “${name}”?`}</div>
                <p>{`A different graph is already saved as “${name}”. Saving this one under that name replaces it.`}</p>
                <div className="pg-dialog__actions">
                    <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
                    <span className="pg-dialog__gap" />
                    <Button size="sm" variant="default" onClick={onRename}>Another name…</Button>
                    <Button size="sm" variant="danger" onClick={onReplace}>Replace it</Button>
                </div>
            </div>
        </div>
    );
}

/**
 * The saved graphs: open one, or delete one. Deleting asks on its own row,
 * where the press was, rather than in a dialog over this one.
 */
export function OpenDialog({ graphs, current, onOpen, onDelete, onSaveAs, onCancel }) {
    const [doomed, setDoomed] = useState(null);
    return (
        <div className="pg-dialog pg-confirm pg-lib" role="dialog" aria-label="Saved graphs">
            <div className="pg-dialog__card pg-lib__card">
                <div className="pg-dialog__title">Saved graphs</div>
                {graphs.length === 0 ? (
                    <p>Nothing saved yet. Name the graph in the title bar and press Save — it is kept in this browser.</p>
                ) : (
                    <div className="pg-lib__list" role="list">
                        {graphs.map((e) => {
                            const open = current && sameGraphName(current, e.name);
                            return (
                                <div key={e.name} className={`pg-lib__row${open ? ' is-current' : ''}`} role="listitem">
                                    <div className="pg-lib__what">
                                        <div className="pg-lib__name" title={e.name}>{e.name}</div>
                                        <div className="pg-lib__meta">{`${blocksIn(e.graph)} · ${when(e.savedAt)}${open ? ' · open now' : ''}`}</div>
                                    </div>
                                    {doomed === e.name ? (
                                        <span className="pg-lib__acts">
                                            <Button size="sm" variant="ghost" onClick={() => setDoomed(null)}>Keep</Button>
                                            <Button size="sm" variant="danger" onClick={() => { setDoomed(null); onDelete(e); }}>Delete</Button>
                                        </span>
                                    ) : (
                                        <span className="pg-lib__acts">
                                            <Button size="sm" variant="ghost" icon={<Icon.Trash />} title={`Delete “${e.name}”`} aria-label={`Delete ${e.name}`} onClick={() => setDoomed(e.name)} />
                                            <Button size="sm" variant="primary" onClick={() => onOpen(e)}>Open</Button>
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
                <div className="pg-dialog__actions">
                    <Button size="sm" variant="ghost" icon={<Icon.Save />} onClick={onSaveAs}>Save this graph as…</Button>
                    <span className="pg-dialog__gap" />
                    <Button size="sm" variant="ghost" onClick={onCancel}>Close</Button>
                </div>
            </div>
        </div>
    );
}

/**
 * What to export: the graph open now, any of the saved ones, or all of them.
 * One ticked is a graph file, as Export has always made; more than one is a
 * file of graphs, which Import adds to the saved ones.
 */
export function ExportDialog({ current, graphs, onCancel, onExport }) {
    const [withCurrent, setWithCurrent] = useState(true);
    const [picked, setPicked] = useState(() => new Set());
    const toggle = (name) => setPicked((s) => {
        const next = new Set(s);
        if (next.has(name)) next.delete(name); else next.add(name);
        return next;
    });
    const all = graphs.length > 0 && graphs.every((e) => picked.has(e.name));
    const count = (withCurrent ? 1 : 0) + picked.size;
    return (
        <div className="pg-dialog pg-confirm pg-lib" role="dialog" aria-label="Export">
            <div className="pg-dialog__card pg-lib__card">
                <div className="pg-dialog__title">Export</div>
                <p>One graph exports as a graph file. Several export as one file of graphs, which Import adds to the saved graphs.</p>
                <div className="pg-lib__list" role="list">
                    <label className="pg-lib__row pg-lib__pick" role="listitem">
                        <input type="checkbox" checked={withCurrent} onChange={() => setWithCurrent(!withCurrent)} />
                        <span className="pg-lib__what">
                            <span className="pg-lib__name">{current.name || 'Untitled graph'}</span>
                            <span className="pg-lib__meta">{`The graph open now · ${blocksIn(current)}`}</span>
                        </span>
                    </label>
                    {graphs.map((e) => (
                        <label key={e.name} className="pg-lib__row pg-lib__pick" role="listitem">
                            <input type="checkbox" checked={picked.has(e.name)} onChange={() => toggle(e.name)} />
                            <span className="pg-lib__what">
                                <span className="pg-lib__name" title={e.name}>{e.name}</span>
                                <span className="pg-lib__meta">{`Saved · ${blocksIn(e.graph)} · ${when(e.savedAt)}`}</span>
                            </span>
                        </label>
                    ))}
                </div>
                <div className="pg-dialog__actions">
                    {graphs.length > 0 && (
                        <Button size="sm" variant="ghost" onClick={() => setPicked(all ? new Set() : new Set(graphs.map((e) => e.name)))}>
                            {all ? 'None saved' : 'All saved'}
                        </Button>
                    )}
                    <span className="pg-dialog__gap" />
                    <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
                    <Button
                        size="sm"
                        variant="primary"
                        icon={<Icon.Download />}
                        disabled={count === 0}
                        onClick={() => onExport({ current: withCurrent, names: graphs.filter((e) => picked.has(e.name)).map((e) => e.name) })}
                    >
                        {count > 1 ? `Export ${count}` : 'Export'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
