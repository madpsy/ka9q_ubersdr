// Layout control: show/hide panels and reassign them to a dock without
// dragging (which is awkward on touch, and impossible for a hidden panel).

import React, { useMemo, useState } from '../react.js';
import { PLACEMENTS, useLayout } from '../layout/LayoutContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { PANELS, usePanelApplies } from './registry.jsx';
import { allGroupsFor } from './groups.jsx';
import { Button, Field, Icon, Segmented, Slider, Switch } from '../components/ui.jsx';

const PLACEMENT_LABEL = { left: 'Left', right: 'Right', bottom: 'Bottom', float: 'Float' };

/** One line of provenance for a custom panel: who published it, and which version. */
function panelSource(from) {
    const parts = [];
    if (from.callsign) parts.push(`By ${from.callsign}`);
    if (from.version) parts.push(`v${from.version}`);
    const head = parts.join(' · ');
    if (head && from.description) return `${head} — ${from.description}`;
    return head || from.description || 'Added to this receiver';
}

// Lowest resting opacity offered for floating windows — below this an idle
// window is hard to read and hard to aim at.
const FLOAT_MIN_PCT = 50;

/** One panel: whether it is shown at all, and which dock it lives in. */
function PanelRow({ panel, hidden, onShown, placement, onPlace, minimal }) {
    return (
        <div className="layout-row">
            <div className="layout-row__head">
                <span className="layout-row__icon">{panel.icon}</span>
                <span className="layout-row__name">{panel.title}</span>
                <Switch checked={!hidden} onChange={(on) => onShown(on)} />
            </div>
            {/* Who wrote this one, for the panels that did not ship with the
                receiver. Whether to leave the switch above on is a question
                about code the operator pulled off a shared collector, and this
                row is the only place it gets asked — a built-in panel needs
                nothing of the sort. Turning it off does not merely hide it: a
                hidden panel is never mounted, so nothing of it runs.

                It is a paragraph per custom panel, which is why the minimal view
                drops it: read once when the panel arrives, and never again. The
                full view is a scroll away. */}
            {panel.custom && !minimal && (
                <div className="note note--tight">{panelSource(panel.custom)}</div>
            )}
            <Segmented
                size="sm"
                value={placement}
                onChange={onPlace}
                options={PLACEMENTS.map((d) => ({ value: d, label: PLACEMENT_LABEL[d] }))}
            />
        </div>
    );
}

export default function LayoutPanel({ minimal }) {
    const { sections, movePanel, setSectionHidden, resetLayout, placementOf } = useLayout();
    const d = useDisplay();
    const applies = usePanelApplies();

    // Every panel this receiver offers, bar this one: a switch that could hide
    // the panel carrying the switch is a door that locks from the inside.
    const shown = useMemo(
        () => PANELS.filter((p) => p.id !== 'layout' && applies(p)),
        [applies],
    );
    const groups = useMemo(() => allGroupsFor(shown), [shown]);

    // Grouped or flat, and which groups are open. Both are for this sitting
    // rather than stored: the list is opened to find one panel, and where you
    // last left it is no help in finding the next one.
    //
    // Grouped and collapsed to start, because that is the view that fits — six
    // headers against fifty rows of scrolling. Expanded groups are the flat list
    // with headings in it, which is what the All side is already for.
    const [grouped, setGrouped] = useState(true);
    const [open, setOpen] = useState({});

    // Resting opacity of floating windows. 100 % is solid, i.e. the effect off;
    // the floor keeps an idle window legible rather than a ghost. Values from
    // outside that range (an older stored setting) clamp in.
    const floatRaw = Number(d.floatOpacity);
    const floatPct = Number.isFinite(floatRaw) && floatRaw > 0
        ? Math.min(100, Math.max(FLOAT_MIN_PCT, Math.round(floatRaw * 100)))
        : 100;

    const row = (p) => (
        <PanelRow
            key={p.id}
            panel={p}
            hidden={!!sections[p.id]?.hidden}
            onShown={(on) => setSectionHidden(p.id, !on)}
            placement={placementOf(p.id)}
            onPlace={(dock) => movePanel(p.id, dock, null)}
            minimal={minimal}
        />
    );

    // How many of a group's panels are on, which is the thing worth knowing
    // about a group you have not opened.
    const liveCount = (g) => g.items.filter((p) => !sections[p.id]?.hidden).length;

    return (
        <div className="stack">
            {/* Everything above the list is set once and left — the resting
                opacity of a floating window, what the dock chooser and the
                window buttons mean, and whether the list is grouped. The list
                itself is what the panel is opened for, so it is all the minimal
                view keeps. */}
            {!minimal && (
                <>
                    <Field
                        label="Float opacity"
                        hint={floatPct < 100 ? `${floatPct} %` : 'solid'}
                    >
                        <Slider
                            value={floatPct}
                            min={FLOAT_MIN_PCT}
                            max={100}
                            step={5}
                            onChange={(v) => d.set({ floatOpacity: v / 100 })}
                        />
                    </Field>
                    <div className="note note--tight">
                        Floating windows rest at this opacity and go solid when
                        you point at them. At 100 % they are always solid.
                    </div>

                    <div className="divider" />

                    <div className="note note--tight">
                        Drag a panel by its header to move it between docks, or
                        set its place here. Drag a dock edge to resize.{' '}
                        <strong>Float</strong> detaches a panel into a window you
                        can move and resize; − parks it in the strip along the
                        bottom, and × drops it back into its dock.
                    </div>

                    <Segmented
                        size="sm"
                        value={grouped ? 'groups' : 'all'}
                        onChange={(v) => setGrouped(v === 'groups')}
                        options={[
                            { value: 'groups', label: 'Grouped', title: 'The same groups the phone tab bar uses' },
                            { value: 'all', label: 'All', title: 'Every panel in one list' },
                        ]}
                    />
                </>
            )}
            {grouped && (
                <div className="layout-groupbar">
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon.Collapse />}
                        onClick={() => setOpen({})}
                    >
                        Collapse all
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon.Expand />}
                        onClick={() => setOpen(Object.fromEntries(groups.map((g) => [g.id, true])))}
                    >
                        Expand all
                    </Button>
                </div>
            )}

            {grouped ? (
                <div className="layout-groups">
                    {groups.map((g) => (
                        <div key={g.id} className={`layout-group${open[g.id] ? ' is-open' : ''}`}>
                            <button
                                type="button"
                                className="layout-group__head"
                                aria-expanded={!!open[g.id]}
                                onClick={() => setOpen((o) => ({ ...o, [g.id]: !o[g.id] }))}
                            >
                                <span className="layout-group__chev">
                                    {open[g.id] ? <Icon.ChevronUp /> : <Icon.Chevron />}
                                </span>
                                <span className="layout-group__icon">{g.icon}</span>
                                <span className="layout-group__name">{g.title}</span>
                                <span className="layout-group__count">
                                    {liveCount(g)}/{g.items.length}
                                </span>
                            </button>
                            {open[g.id] && (
                                <div className="layout-list layout-group__body">
                                    {g.items.map(row)}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            ) : (
                <div className="layout-list">{shown.map(row)}</div>
            )}

            {!minimal && (
                <div className="row-end">
                    <Button size="sm" variant="ghost" icon={<Icon.Reset />} onClick={resetLayout}>Reset layout</Button>
                </div>
            )}
        </div>
    );
}
