// Layout control: show/hide panels and reassign them to a dock without
// dragging (which is awkward on touch, and impossible for a hidden panel).

import React from '../react.js';
import { DOCKS, useLayout } from '../layout/LayoutContext.jsx';
import { PANELS } from './registry.jsx';
import { Button, Icon, Segmented, Switch } from '../components/ui.jsx';

const DOCK_LABEL = { left: 'Left', right: 'Right', bottom: 'Bottom' };

export default function LayoutPanel() {
    const { docks, sections, movePanel, setSectionHidden, resetLayout } = useLayout();

    const dockOf = (id) => DOCKS.find((d) => docks[d].panels.includes(id)) || 'left';

    return (
        <div className="stack">
            <div className="note note--tight">
                Drag a panel by its header to move it between docks, or set its
                home here. Drag a dock edge to resize.
            </div>

            <div className="layout-list">
                {PANELS.filter((p) => p.id !== 'layout').map((p) => (
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
                            value={dockOf(p.id)}
                            onChange={(dock) => movePanel(p.id, dock, null)}
                            options={DOCKS.map((d) => ({ value: d, label: DOCK_LABEL[d] }))}
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
