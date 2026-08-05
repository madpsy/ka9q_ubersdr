// Mobile layout.
//
// Docks make no sense on a phone, so the same panels are reached through a tab
// bar that opens them as bottom sheets over a full-bleed spectrum. The panel
// components are reused unchanged — only the chrome differs, which is why the
// registry has no notion of "mobile panels".
//
// An open extension is a sheet too. Floating is a desktop idea — a draggable
// window on a phone is not useful — so the window chrome is dropped and the
// extension gets the same sheet a panel would, opened from the Extensions
// panel rather than from the tab bar.
//
// A sheet is not modal. It used to be — a dimmed screen with a scrim that closed
// it on any tap — and that made a panel and the spectrum mutually exclusive:
// reaching for the waterfall shut the panel you opened to use *with* it, which
// on a receiver is most of them.
//
// So it lies over the bottom of the spectrum instead: inside .shell__center, on
// top, taking no space of its own. The waterfall keeps its full height and goes
// on running behind — nothing is resized when a panel opens, and the part still
// showing is live to tune, drag and pinch. The tab bar stays clear below it, so
// one panel can be swapped for another without closing anything, and a sheet
// closes from its own button or from the tab that opened it.

import React, { useState } from '../react.js';
import { PANELS, PANEL_BY_ID, usePanelApplies } from '../panels/registry.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { useExtensions } from '../extensions/ExtensionsContext.jsx';
import SpectrumView from './SpectrumView.jsx';
import TopBar from './TopBar.jsx';
import { Icon } from './ui.jsx';

export default function MobileShell() {
    const { sections, toggleSectionMinimal } = useLayout();
    const applies = usePanelApplies();
    const {
        active: extension, close: closeExtension, minimalOf, toggleMinimal: toggleExtMinimal,
    } = useExtensions();
    const [openId, setOpenId] = useState(null);
    const extMinimal = minimalOf(extension ? extension.id : '');

    const visible = PANELS.filter(
        (p) => !sections[p.id]?.hidden && applies(p),
    );
    // The extension wins the sheet: opening one is the more recent choice, and
    // it is opened from a panel that would otherwise sit on top of it.
    const panel = extension ? null : (openId ? PANEL_BY_ID[openId] : null);
    // Guarded by the panel's own declaration, as Section and FloatingPanel do:
    // a stored flag from a panel that has since dropped its minimal view would
    // otherwise render it a prop it no longer honours.
    //
    // `minimalMobile`, not `minimal`: a panel that has a cut-down form starts in
    // it here, because a sheet over the spectrum has a fraction of a dock's room
    // and the minimal view is the part worth having in that space. Kept apart
    // from the docked flag so expanding one on a phone does not expand it on a
    // desktop that had room for it all along.
    const panelMinimal = !!panel?.minimal && !!sections[panel.id]?.minimalMobile;

    return (
        <div className="shell shell--mobile">
            <TopBar compact />

            <main className="shell__center">
                <SpectrumView />

                {/* `fill` means the panel owns its own scroller and needs a
                    height to fill — the same thing the bottom dock does for the
                    same panels. See .sheet--fill. */}
                {panel && (
                    <div
                        className={`sheet${panel.fill ? ' sheet--fill' : ''}`}
                        role="region"
                        aria-label={panel.title}
                    >
                        <div className="sheet__head">
                            <span className="sheet__grip" />
                            <span className="sheet__title">
                                <span className="sheet__icon">{panel.icon}</span>
                                {panel.title}
                            </span>
                            {/* The same toggle the docked and floating panels
                                carry, but its own stored flag: what a phone has
                                room for and what a dock has room for are not the
                                same question. */}
                            {panel.minimal && (
                                <button
                                    type="button"
                                    className="sheet__act"
                                    title={panelMinimal ? 'Show the full panel' : 'Show the minimal view'}
                                    aria-pressed={panelMinimal}
                                    onClick={() => toggleSectionMinimal(panel.id, true)}
                                >
                                    {panelMinimal ? <Icon.Expand size={16} /> : <Icon.Collapse size={16} />}
                                </button>
                            )}
                            <button type="button" className="sheet__close" onClick={() => setOpenId(null)} aria-label="Close">
                                <Icon.Close size={18} />
                            </button>
                        </div>
                        <div className="sheet__body">
                            <panel.Component minimal={panelMinimal} />
                        </div>
                    </div>
                )}

                {extension && (
                    <div className="sheet sheet--ext" role="region" aria-label={extension.title}>
                        <div className="sheet__head">
                            <span className="sheet__grip" />
                            <span className="sheet__title">
                                <span className="sheet__icon">{extension.icon}</span>
                                {extension.title}
                            </span>
                            {/* Worth more on a phone than anywhere else: the
                                sheet is the smallest this decoder is ever
                                drawn in, so cutting it down buys the most. */}
                            {extension.minimal && (
                                <button
                                    type="button"
                                    className="sheet__act"
                                    title={extMinimal ? 'Show the full extension' : 'Show the minimal view'}
                                    aria-pressed={extMinimal}
                                    onClick={() => toggleExtMinimal(extension.id)}
                                >
                                    {extMinimal ? <Icon.Expand size={16} /> : <Icon.Collapse size={16} />}
                                </button>
                            )}
                            <button type="button" className="sheet__close" onClick={closeExtension} aria-label="Close">
                                <Icon.Close size={18} />
                            </button>
                        </div>
                        <div className="sheet__body sheet__body--ext">
                            <extension.Component minimal={extMinimal} />
                        </div>
                    </div>
                )}
            </main>

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
