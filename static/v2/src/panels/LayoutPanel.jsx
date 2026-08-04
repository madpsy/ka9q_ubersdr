// Layout control: show/hide panels and reassign them to a dock without
// dragging (which is awkward on touch, and impossible for a hidden panel).

import React from '../react.js';
import { PLACEMENTS, useLayout } from '../layout/LayoutContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { PANELS, usePanelApplies } from './registry.jsx';
import { Button, Field, Icon, Segmented, Slider, Switch } from '../components/ui.jsx';

const PLACEMENT_LABEL = { left: 'Left', right: 'Right', bottom: 'Bottom', float: 'Float' };

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
