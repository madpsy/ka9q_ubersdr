// Keyboard shortcuts: what each key does, and how to change it.
//
// The list is built from the two halves rather than written out here — the key
// comes from lib/shortcuts.js and everything shown about the function (its
// name, its hint, the group it belongs to) comes from the same catalogue the
// MIDI and FlexControl panels read. Adding a function to that catalogue puts it
// in this dropdown with no edit here, which is the point of the arrangement.
//
// `minimal` keeps the switch and the list, and drops adding and resetting.

import React, { useEffect, useMemo, useState } from '../react.js';
import { Button, Empty, Field, Icon, ShowMore, Switch } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { catalogue, functionLabel, functionRepeats } from '../controls/functions.js';
import { useHardware } from '../controls/panel.jsx';
import {
    bindShortcut, comboFor, comboLabel, comboProblem, onShortcutSettings, resetShortcuts,
    setShortcutSettings, shortcutSettings, unbindShortcut,
} from '../lib/shortcuts.js';

const PAGE = 14;
// Below this the list is shorter than the box would be useful for, and the box
// is one more thing between the switch and what it controls.
const SEARCH_FROM = 8;

export default function ShortcutsPanel({ minimal }) {
    const radio = useRadio();
    const hw = useHardware();
    const [s, setLocal] = useState(shortcutSettings);
    useEffect(() => onShortcutSettings(setLocal), []);

    // Recording: null when idle, otherwise the function waiting for a key.
    // `combo` on an existing row means "change this one", and the old binding
    // is removed when the new key lands.
    const [recording, setRecording] = useState(null);
    // A key press waiting to be confirmed, because it would take the key off
    // another function: { combo, fn, from, taken }.
    const [pending, setPending] = useState(null);
    const [pick, setPick] = useState('');
    const [query, setQuery] = useState('');
    const [limit, setLimit] = useState(PAGE);

    // A new search starts from the top again, as the band and bookmark lists do.
    useEffect(() => { setLimit(PAGE); }, [query]);
    // What just happened, and how to put it back. A key can only run one
    // function, so giving it to a second takes it off the first — see the note
    // in lib/shortcuts.js. That is the right behaviour, but it is not one to
    // discover afterwards, so the displaced function is named and the whole
    // previous map is kept for one press of Undo.
    const [note, setNote] = useState(null);

    const schemas = radio.dsp.schemas;
    const all = useMemo(() => catalogue(schemas, hw), [schemas, hw]);
    const groups = useMemo(() => {
        const out = new Map();
        for (const f of all) {
            if (!out.has(f.group)) out.set(f.group, []);
            out.get(f.group).push(f);
        }
        return Array.from(out.entries());
    }, [all]);

    // One row per binding, in the catalogue's own order so the list reads the
    // way the dropdown does — frequency, mode, band, VFO, audio, and so on —
    // rather than in whatever order the keys were assigned.
    const rows = useMemo(() => {
        const order = new Map(all.map((f, i) => [f.id, i]));
        const groupOf = new Map(all.map((f) => [f.id, f.group]));
        return Object.entries(s.bindings)
            .map(([combo, fn]) => ({
                combo,
                fn,
                at: order.has(fn) ? order.get(fn) : Infinity,
                // What a search looks at: the name shown, the group it sits
                // under, and the key itself in both spellings — so "left"
                // finds ArrowLeft and "shift + k" finds Shift+k.
                hay: [
                    functionLabel(fn, schemas, hw),
                    groupOf.get(fn) || '',
                    combo,
                    comboLabel(combo),
                ].join(' ').toLowerCase(),
            }))
            .sort((a, b) => a.at - b.at || a.combo.localeCompare(b.combo));
    }, [s.bindings, all, schemas, hw]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return rows;
        // Every word has to appear somewhere, in any order: "usb mode" and
        // "mode usb" both find the same row.
        const words = q.split(/\s+/);
        return rows.filter((r) => words.every((w) => r.hay.includes(w)));
    }, [rows, query]);

    // `from` is the key the function is moving off, when this is a rebind rather
    // than an addition — it has to be released or the function keeps both.
    const applyBind = (fn, from, combo) => {
        if (from && from !== combo) unbindShortcut(from);
        bindShortcut(combo, fn);
    };

    // While recording, the next keystroke is the binding rather than a
    // shortcut. Registered above the watcher's own listener by being on the
    // window with capture, so a key that is already bound is captured here
    // instead of running what it is bound to.
    useEffect(() => {
        if (!recording) return undefined;
        const onKey = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { setRecording(null); return; }
            const combo = comboFor(e);
            if (!combo) return;              // a modifier on its own: keep waiting
            const problem = comboProblem(combo);
            if (problem) { setNote({ text: `${comboLabel(combo)} — ${problem}` }); return; }

            const taken = shortcutSettings().bindings[combo];
            // A key that already runs something else is asked about rather than
            // taken. One key runs one function, so this is always a loss for
            // whatever held it — and an Undo offered afterwards is no help to
            // someone who did not notice what they had just undone.
            if (taken && taken !== recording.fn) {
                setPending({ combo, fn: recording.fn, from: recording.combo, taken });
                setRecording(null);
                return;
            }
            applyBind(recording.fn, recording.combo, combo);
            setNote(null);
            setRecording(null);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [recording, schemas, hw]);

    return (
        <div className="stack">
            <Field label="Shortcuts" inline>
                <Switch
                    checked={s.enabled}
                    onChange={(v) => setShortcutSettings({ enabled: v })}
                    label={s.enabled ? 'On' : 'Off'}
                    title="Keys do nothing at all while this is off — the bindings are kept"
                />
            </Field>

            <span className="section-label">
                Keys
                <span className="section-label__note">
                    {query.trim() && filtered.length !== rows.length
                        ? `${filtered.length} of ${rows.length}`
                        : rows.length}
                </span>
            </span>

            {rows.length > SEARCH_FROM && (
                <input
                    className="input"
                    placeholder="Search by function or key…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
            )}

            {filtered.length === 0 ? (
                <Empty>
                    {rows.length === 0 ? 'No shortcuts. Add one below.' : 'No match'}
                </Empty>
            ) : (
                <div className="rc-map">
                    {filtered.slice(0, limit).map(({ combo, fn }) => (
                        <ShortcutRow
                            key={combo}
                            combo={combo}
                            fn={fn}
                            schemas={schemas}
                            hw={hw}
                            onRebind={() => { setNote(null); setPending(null); setRecording({ fn, combo }); }}
                            onDelete={() => unbindShortcut(combo)}
                        />
                    ))}
                </div>
            )}

            {filtered.length > limit && (
                <ShowMore
                    shown={limit}
                    total={filtered.length}
                    onMore={() => setLimit((n) => n + PAGE)}
                    label="Show more shortcuts"
                />
            )}

            {/* Everything the editor has to say, kept together at the foot of
                the panel beside the picker that starts it.
                
                This list runs to thirty rows and the panel is taller than the
                dock, so a prompt at the top was off screen exactly when it
                mattered — the moment after pressing a key. Shown in the minimal
                view too, where the picker is not: a rebind can be started from
                any row's key chip, and it must be able to answer. */}
            {(recording || pending || note) && (
                <>
                    <div className="divider" />
                    {recording && (
                        <div className="rc-learn">
                            <div className="rc-learn__msg">
                                Press a key for “{functionLabel(recording.fn, schemas, hw)}”
                            </div>
                            <Button variant="ghost" size="sm" onClick={() => setRecording(null)}>
                                Cancel
                            </Button>
                        </div>
                    )}

                    {pending && (
                        <div className="note note--warn shortcut-note">
                            <span>
                                {comboLabel(pending.combo)} already runs{' '}
                                <strong>{functionLabel(pending.taken, schemas, hw)}</strong>.
                                Give it to {functionLabel(pending.fn, schemas, hw)}?
                            </span>
                            <Button
                                size="sm"
                                variant="primary"
                                onClick={() => {
                                    applyBind(pending.fn, pending.from, pending.combo);
                                    const kept = Object.values(shortcutSettings().bindings)
                                        .includes(pending.taken);
                                    setNote({
                                        text: `${functionLabel(pending.taken, schemas, hw)} `
                                            + (kept ? 'kept its other key' : 'now has no key'),
                                    });
                                    setPending(null);
                                }}
                            >
                                Replace
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                                Keep
                            </Button>
                        </div>
                    )}

                    {note && (
                        <div className="note note--tight shortcut-note">
                            <span>{note.text}</span>
                            {note.undo && (
                                <button
                                    type="button"
                                    className="chip chip--button"
                                    onClick={() => {
                                        setShortcutSettings({ bindings: note.undo });
                                        setNote(null);
                                    }}
                                >
                                    Undo
                                </button>
                            )}
                        </div>
                    )}
                </>
            )}

            {!minimal && (
                <>
                    <div className="divider" />

                    <span className="section-label">Add</span>
                    <Field label="Function">
                        <select
                            className="select"
                            value={pick}
                            onChange={(e) => setPick(e.target.value)}
                        >
                            <option value="">Choose a function…</option>
                            {groups.map(([name, items]) => (
                                <optgroup key={name} label={name}>
                                    {items.map((f) => (
                                        <option key={f.id} value={f.id}>{f.label}</option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                    </Field>

                    <div className="chip-row">
                        <Button
                            size="sm"
                            variant="primary"
                            disabled={!pick || !!recording}
                            onClick={() => {
                                setNote(null);
                                setPending(null);
                                setRecording({ fn: pick, combo: null });
                            }}
                        >
                            Press a key…
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            icon={<Icon.Reset size={13} />}
                            onClick={() => {
                                const before = { ...shortcutSettings().bindings };
                                resetShortcuts();
                                setNote({ text: 'Back to the standard keys', undo: before });
                            }}
                        >
                            Defaults
                        </Button>
                    </div>

                    <div className="note note--tight">
                        Shortcuts are ignored while you are typing, and a key that is not
                        bound is left to the browser. A key marked <em>hold</em> repeats
                        while it is held down; the rest act once per press. Every function listed here is the same
                        one the SDR control panel maps a hardware surface to — one list,
                        reached by key, by knob or by pad.
                    </div>
                </>
            )}
        </div>
    );
}

function ShortcutRow({ combo, fn, schemas, hw, onRebind, onDelete }) {
    const label = functionLabel(fn, schemas, hw);
    const repeats = functionRepeats(fn, schemas, hw);
    return (
        <div className="rc-map__row">
            <span className="rc-map__fn" title={label}>{label}</span>
            <button type="button" className="rc-map__del" title="Remove" onClick={onDelete}>
                <Icon.Close size={13} />
            </button>
            <div className="rc-map__meta">
                <button
                    type="button"
                    className="tag rc-map__mode"
                    title="Press to give this a different key"
                    onClick={onRebind}
                >
                    {comboLabel(combo)}
                </button>
                {/* Which keys keep going when held. The row is the only place
                    that says so, and holding a key is not a thing anyone tries
                    on the off chance. */}
                {repeats && (
                    <span className="tag tag--ghost" title="Keeps going while the key is held">
                        hold
                    </span>
                )}
            </div>
        </div>
    );
}
