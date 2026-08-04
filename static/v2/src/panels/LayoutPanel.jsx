// Layout control: show/hide panels and reassign them to a dock without
// dragging (which is awkward on touch, and impossible for a hidden panel).

import React from '../react.js';
import { PLACEMENTS, useLayout } from '../layout/LayoutContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { PANELS, usePanelApplies } from './registry.jsx';
import { Button, Field, Icon, Segmented, Slider, Switch } from '../components/ui.jsx';

const PLACEMENT_LABEL = { left: 'Left', right: 'Right', bottom: 'Bottom', float: 'Float' };

export default function LayoutPanel() {
    const { sections, movePanel, setSectionHidden, resetLayout, placementOf } = useLayout();
    const d = useDisplay();
    const applies = usePanelApplies();

    // 0 is off — floating windows stay solid. Anything above is their resting
    // opacity, so the slider is one control rather than a switch plus a level.
    // A stored 1 (the old "fully opaque" default) reads as off, same effect.
    const floatRaw = Number(d.floatOpacity);
    const floatPct = Number.isFinite(floatRaw) && floatRaw > 0 && floatRaw < 1
        ? Math.round(floatRaw * 100)
        : 0;

    return (
        <div className="stack">
            <Field
                label="Float transparency"
                hint={floatPct > 0 ? `${floatPct} % opacity` : 'off'}
            >
                <Slider
                    value={floatPct}
                    min={0}
                    max={95}
                    step={5}
                    onChange={(v) => d.set({ floatOpacity: v / 100 })}
                />
            </Field>
            <div className="note note--tight">
                At 0 floating windows are solid. Above it they rest at that
                opacity and go solid when you point at them.
            </div>

            <div className="divider" />

            <div className="note note--tight">
                Drag a panel by its header to move it between docks, or set its
                place here. Drag a dock edge to resize. <strong>Float</strong>
                detaches a panel into a window you can move and resize; drop it
                back with the × on its title bar.
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
