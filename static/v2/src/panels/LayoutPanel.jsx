// Layout control: show/hide panels and reassign them to a dock without
// dragging (which is awkward on touch, and impossible for a hidden panel).

import React from '../react.js';
import { PLACEMENTS, useLayout } from '../layout/LayoutContext.jsx';
import { PANELS } from './registry.jsx';
import { Button, Icon, Segmented, Switch } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';

const PLACEMENT_LABEL = { left: 'Left', right: 'Right', bottom: 'Bottom', float: 'Float' };

export default function LayoutPanel() {
    const { sections, movePanel, setSectionHidden, resetLayout, placementOf } = useLayout();
    const { serverInfo } = useRadio();

    return (
        <div className="stack">
            <div className="note note--tight">
                Drag a panel by its header to move it between docks, or set its
                place here. Drag a dock edge to resize. <strong>Float</strong>
                detaches a panel into a window you can move and resize; drop it
                back with the × on its title bar.
            </div>

            <div className="layout-list">
                {PANELS.filter((p) => p.id !== 'layout' && (!p.requires || p.requires(serverInfo))).map((p) => (
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
