// Mobile layout.
//
// Docks make no sense on a phone, so the same panels are reached through a tab
// bar that opens them as bottom sheets over a full-bleed spectrum. The panel
// components are reused unchanged — only the chrome differs, which is why the
// registry has no notion of "mobile panels".

import React, { useState } from '../react.js';
import { PANELS, PANEL_BY_ID } from '../panels/registry.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import SpectrumView from './SpectrumView.jsx';
import TopBar from './TopBar.jsx';
import { Icon } from './ui.jsx';

export default function MobileShell() {
    const { sections } = useLayout();
    const { serverInfo } = useRadio();
    const [openId, setOpenId] = useState(null);

    const visible = PANELS.filter(
        (p) => !sections[p.id]?.hidden && (!p.requires || p.requires(serverInfo)),
    );
    const panel = openId ? PANEL_BY_ID[openId] : null;

    return (
        <div className="shell shell--mobile">
            <TopBar compact />

            <main className="shell__center">
                <SpectrumView />
            </main>

            {panel && (
                <>
                    <div className="sheet__scrim" onClick={() => setOpenId(null)} />
                    <div className="sheet" role="dialog" aria-label={panel.title}>
                        <div className="sheet__head">
                            <span className="sheet__grip" />
                            <span className="sheet__title">
                                <span className="sheet__icon">{panel.icon}</span>
                                {panel.title}
                            </span>
                            <button type="button" className="sheet__close" onClick={() => setOpenId(null)} aria-label="Close">
                                <Icon.Close size={18} />
                            </button>
                        </div>
                        <div className="sheet__body">
                            <panel.Component />
                        </div>
                    </div>
                </>
            )}

            <nav className="tabbar">
                {visible.map((p) => (
                    <button
                        key={p.id}
                        type="button"
                        className={`tabbar__item${openId === p.id ? ' is-active' : ''}`}
                        onClick={() => setOpenId((cur) => (cur === p.id ? null : p.id))}
                    >
                        <span className="tabbar__icon">{p.icon}</span>
                        <span className="tabbar__label">{p.title}</span>
                    </button>
                ))}
            </nav>
        </div>
    );
}
