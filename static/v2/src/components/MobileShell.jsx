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
// showing is live to tune, drag and pinch.
//
// The tab bar, though, does go: it is a row of labelled icons that on a handset
// is worth about a tenth of the screen, and while a sheet is open it is a
// navigation control nobody is using in front of a panel somebody is. Hiding it
// gives that back to the spectrum *and* to the sheet, which is a share of the
// centre area and so grows with it. The cost is that swapping panels is two taps
// rather than one — close, then open the next — which is the trade a phone is
// worth making and a desktop is not.

import React, { useState } from '../react.js';
import { PANELS, PANEL_BY_ID, usePanelApplies } from '../panels/registry.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { useExtensions } from '../extensions/ExtensionsContext.jsx';
import { LANDSCAPE_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import SpectrumView from './SpectrumView.jsx';
import TopBar from './TopBar.jsx';
import { Icon } from './ui.jsx';

export default function MobileShell() {
    const { sections, toggleSectionMinimal } = useLayout();
    // Turned on its side, everything above the marker bar goes — see below.
    const landscape = useMediaQuery(LANDSCAPE_QUERY);
    const applies = usePanelApplies();
    const {
        active: extension, close: closeExtension, minimalOf, toggleMinimal: toggleExtMinimal,
    } = useExtensions();
    // Which sheet the app opens on. A registry `mobile.open` panel is showing
    // from the start — the Multipad, whose whole claim is that it is the panel
    // you were going to open anyway — and nothing else is, so a phone still
    // arrives at a full-bleed spectrum with one sheet over the foot of it.
    //
    // Not remembered between visits, deliberately: the open sheet is where you
    // are, not a setting, and closing it is one tap.
    const [openId, setOpenId] = useState(() => {
        const first = PANELS.find((p) => p.mobile && p.mobile.open && !sections[p.id]?.hidden);
        return first ? first.id : null;
    });
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
        <div className={`shell shell--mobile${landscape ? ' shell--landscape' : ''}`}>
            {/* Not in landscape. A handset on its side has about 390 px of
                height against 800 the other way up, and this row is a tenth of
                it — spent on a readout the Multipad's own carries and controls
                a rotation away. The receiver is started from the overlay rather
                than from here, so nothing is unreachable before there is
                anything to listen to; Stop is the one thing that is, and it is
                one rotation off. Not rendered rather than hidden: it samples
                the meters eight times a second and would go on doing it. */}
            {!landscape && <TopBar compact />}

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

            {/* Only with the screen to itself — see the note at the top. The
                sheet's own × is what brings it back, which is why that button
                exists on every sheet including an extension's. */}
            {!panel && !extension && (
                <nav className="tabbar">
                    {visible.map((p) => (
                        <button
                            key={p.id}
                            type="button"
                            className="tabbar__item"
                            onClick={() => setOpenId(p.id)}
                        >
                            <span className="tabbar__icon">{p.icon}</span>
                            <span className="tabbar__label">{p.title}</span>
                        </button>
                    ))}
                </nav>
            )}
        </div>
    );
}
