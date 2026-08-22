// Layout control: show/hide panels and reassign them to a dock without
// dragging (which is awkward on touch, and impossible for a hidden panel).

import React from '../react.js';
import { PLACEMENTS, useLayout } from '../layout/LayoutContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { PANELS, usePanelApplies } from './registry.jsx';
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

export default function LayoutPanel() {
    const { sections, movePanel, setSectionHidden, resetLayout, placementOf } = useLayout();
    const d = useDisplay();
    const applies = usePanelApplies();

    // Resting opacity of floating windows. 100 % is solid, i.e. the effect off;
    // the floor keeps an idle window legible rather than a ghost. Values from
    // outside that range (an older stored setting) clamp in.
    const floatRaw = Number(d.floatOpacity);
    const floatPct = Number.isFinite(floatRaw) && floatRaw > 0
        ? Math.min(100, Math.max(FLOAT_MIN_PCT, Math.round(floatRaw * 100)))
        : 100;

    return (
        <div className="stack">
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
                Floating windows rest at this opacity and go solid when you
                point at them. At 100 % they are always solid.
            </div>

            <div className="divider" />

            <div className="note note--tight">
                Drag a panel by its header to move it between docks, or set its
                place here. Drag a dock edge to resize. <strong>Float</strong>
                detaches a panel into a window you can move and resize; − parks
                it in the strip along the bottom, and × drops it back into its
                dock.
            </div>

            <div className="layout-list">
                {PANELS.filter((p) => p.id !== 'layout' && applies(p)).map((p) => (
                    <div key={p.id} className="layout-row">
                        <div className="layout-row__head">
                            <span className="layout-row__icon">{p.icon}</span>
                            <span className="layout-row__name">{p.title}</span>
                            <Switch
                                checked={!sections[p.id]?.hidden}
                                onChange={(on) => setSectionHidden(p.id, !on)}
                            />
                        </div>
                        {/* Who wrote this one, for the panels that did not ship
                            with the receiver. Whether to leave the switch above
                            on is a question about code the operator pulled off a
                            shared collector, and this row is the only place it
                            gets asked — a built-in panel needs nothing of the
                            sort. Turning it off does not merely hide it: a
                            hidden panel is never mounted, so nothing of it
                            runs. */}
                        {p.custom && (
                            <div className="note note--tight">
                                {panelSource(p.custom)}
                            </div>
                        )}
                        <Segmented
                            size="sm"
                            value={placementOf(p.id)}
                            onChange={(dock) => movePanel(p.id, dock, null)}
                            options={PLACEMENTS.map((d) => ({ value: d, label: PLACEMENT_LABEL[d] }))}
                        />
                    </div>
                ))}
            </div>

            <div className="row-end">
                <Button size="sm" variant="ghost" icon={<Icon.Reset />} onClick={resetLayout}>Reset layout</Button>
            </div>
        </div>
    );
}
