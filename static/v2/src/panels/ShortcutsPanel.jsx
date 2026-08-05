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
import { catalogue, functionLabel } from '../controls/functions.js';
import { useHardware } from '../controls/panel.jsx';
import {
    bindShortcut, comboFor, comboLabel, comboProblem, onShortcutSettings, resetShortcuts,
    setShortcutSettings, shortcutSettings, unbindShortcut,
} from '../lib/shortcuts.js';

const PAGE = 14;

export default function ShortcutsPanel({ minimal }) {
    const radio = useRadio();
    const hw = useHardware();
    const [s, setLocal] = useState(shortcutSettings);
    useEffect(() => onShortcutSettings(setLocal), []);

    // Recording: null when idle, otherwise the function waiting for a key.
    // `combo` on an existing row means "change this one", and the old binding
    // is removed when the new key lands.
    const [recording, setRecording] = useState(null);
    const [pick, setPick] = useState('');
    const [limit, setLimit] = useState(PAGE);
    const [note, setNote] = useState('');

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
        return Object.entries(s.bindings)
            .map(([combo, fn]) => ({ combo, fn, at: order.has(fn) ? order.get(fn) : Infinity }))
            .sort((a, b) => a.at - b.at || a.combo.localeCompare(b.combo));
    }, [s.bindings, all]);

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
            if (problem) { setNote(`${comboLabel(combo)}: ${problem}`); return; }
            // Changing a row's key rather than adding one: the old key goes.
            if (recording.combo && recording.combo !== combo) unbindShortcut(recording.combo);
            const taken = shortcutSettings().bindings[combo];
            bindShortcut(combo, recording.fn);
            setNote(taken && taken !== recording.fn
                ? `${comboLabel(combo)} taken from ${functionLabel(taken, schemas, hw)}`
                : '');
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

            {recording && (
                <div className="rc-learn">
                    <div className="rc-learn__msg">
                        Press a key for “{functionLabel(recording.fn, schemas, hw)}”
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setRecording(null)}>Cancel</Button>
                </div>
            )}

            {note && <div className="note note--tight">{note}</div>}

            <span className="section-label">
                Keys
                <span className="section-label__note">{rows.length}</span>
            </span>

            {rows.length === 0 ? (
                <Empty>No shortcuts. Add one below.</Empty>
            ) : (
                <div className="rc-map">
                    {rows.slice(0, limit).map(({ combo, fn }) => (
                        <ShortcutRow
                            key={combo}
                            combo={combo}
                            fn={fn}
                            schemas={schemas}
                            hw={hw}
                            onRebind={() => { setNote(''); setRecording({ fn, combo }); }}
                            onDelete={() => unbindShortcut(combo)}
                        />
                    ))}
                </div>
            )}

            {rows.length > limit && (
                <ShowMore
                    shown={limit}
                    total={rows.length}
                    onMore={() => setLimit((n) => n + PAGE)}
                    label="Show more shortcuts"
                />
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
                            onClick={() => { setNote(''); setRecording({ fn: pick, combo: null }); }}
                        >
                            Press a key…
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            icon={<Icon.Reset size={13} />}
                            onClick={() => { resetShortcuts(); setNote('Back to the standard keys'); }}
                        >
                            Defaults
                        </Button>
                    </div>

                    <div className="note note--tight">
                        Shortcuts are ignored while you are typing, and a key that is not
                        bound is left to the browser. Every function listed here is the same
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
            </div>
        </div>
    );
}
