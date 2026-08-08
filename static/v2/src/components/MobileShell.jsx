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

import React, { useCallback, useRef, useState } from '../react.js';
import { PANELS, PANEL_BY_ID, usePanelApplies } from '../panels/registry.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { useExtensions } from '../extensions/ExtensionsContext.jsx';
import { LANDSCAPE_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { sheetIntent, sheetWants } from '../lib/sheetGesture.js';
import { haptic } from '../lib/haptics.js';
import SpectrumView from './SpectrumView.jsx';
import TopBar from './TopBar.jsx';
import { Icon } from './ui.jsx';
import useWakeProps from '../radio/useWake.js';

/**
 * Tap or drag the title bar to cut a sheet down or open it out.
 *
 * `minimal` is the state now and `toggle` flips it — neither context has a
 * setter, and neither needs one: the gesture says which state it wants (see
 * sheetWants) and this only calls the toggle when that differs from what is
 * showing, so dragging down twice is one change and not two.
 *
 * Returns props for the header, or null when the sheet has only one state to be
 * in — a panel with no minimal view has nothing for this to do, and a bar that
 * responds to a drag on one panel and ignores it on the next is worse than one
 * that never responds at all.
 */
function useHeadGesture(enabled, minimal, toggle) {
    const at = useRef(null);
    // Is the touch now in progress one this bar started? Separate from `at`,
    // which pointerup clears — and touchend runs *after* pointerup.
    const ours = useRef(false);

    const onPointerDown = useCallback((e) => {
        // The buttons on the bar are their own gesture. Without this a tap on
        // Close would land here too and toggle the panel on its way out — and
        // the touchend below would stop the button ever seeing its click.
        if (e.target.closest && e.target.closest('button')) return;
        ours.current = e.pointerType === 'touch';
        // Selection and focus only; this does *not* stop the click — see
        // onTouchEnd, which is the part that does.
        e.preventDefault();
        at.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
        // Captured so a drag that leaves the bar — which a downward one does
        // almost immediately — still ends here rather than being lost.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }, []);

    const onPointerUp = useCallback((e) => {
        const start = at.current;
        at.current = null;
        if (!start || start.id !== e.pointerId) return;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        const want = sheetWants(sheetIntent(e.clientX - start.x, e.clientY - start.y), minimal);
        if (want == null || want === minimal) return;
        toggle();
        // The sheet resizing is the feedback for a tap; a drag needs its own,
        // because the finger is somewhere other than the thing that moved.
        haptic('toggle');
    }, [minimal, toggle]);

    const onPointerCancel = useCallback(() => {
        at.current = null;
        ours.current = false;
    }, []);

    /**
     * The one thing that actually stops the click a touch leaves behind.
     *
     * A touch ends with a delayed mousedown/mouseup/click, and those are
     * hit-tested against the DOM *as it is then* — pointer capture does not
     * retarget them. This gesture resizes the sheet, so by the time that click
     * is dispatched the bar has moved and something else is in that spot:
     * expanding the Multipad grew the sheet upwards until the view row sat where
     * the title bar had been, and a tap in the middle of the bar came back as a
     * tap on "Spectrum" — the middle of that row's three. Shrinking is worse:
     * the sheet moves down and the click lands on the spectrum behind it.
     *
     * Cancelling `pointerdown` looks like it should prevent this and does not.
     * Chrome builds the compatibility mouse events from the *touch* stream, not
     * the pointer stream, so the click arrived regardless — which is why the
     * first attempt at this changed nothing. `touchend` is the event that
     * suppresses them, and cancelling it is the documented way to do so.
     *
     * Registered natively and non-passively, because React registers touch
     * listeners as passive and preventDefault on a passive listener is ignored:
     * an `onTouchEnd` prop here would have been a second no-op.
     */
    const onTouchEnd = useCallback((e) => {
        if (!ours.current) return;
        ours.current = false;
        if (e.cancelable) e.preventDefault();
    }, []);

    // Attached by ref rather than by prop, for the same reason. The listener
    // goes with the node when the sheet closes.
    const bind = useCallback((el) => {
        if (el) el.addEventListener('touchend', onTouchEnd, { passive: false });
    }, [onTouchEnd]);

    if (!enabled) return null;
    return { ref: bind, onPointerDown, onPointerUp, onPointerCancel };
}

export default function MobileShell() {
    const { sections, toggleSectionMinimal } = useLayout();
    const display = useDisplay();
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
    // Both sheet bodies share it — a decoder is as much a reason to be here as a
    // panel is. Not the sheet heads: those are the grab handle and the close
    // button. See radio/useWake.js.
    const wake = useWakeProps();

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

    // Both unconditionally, as hooks have to be — each returns null when its
    // sheet has no second state to be in.
    const panelHead = useHeadGesture(
        !!panel?.minimal,
        panelMinimal,
        useCallback(() => panel && toggleSectionMinimal(panel.id, true), [panel, toggleSectionMinimal]),
    );
    const extHead = useHeadGesture(
        !!extension?.minimal,
        extMinimal,
        useCallback(() => extension && toggleExtMinimal(extension.id), [extension, toggleExtMinimal]),
    );

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
                        {/* The bar is the sheet's own control: tap it, or drag
                            it up and down — see useHeadGesture. The button below
                            stays, because a gesture is not reachable from a
                            keyboard and says nothing to a screen reader. */}
                        <div
                            className={`sheet__head${panelHead ? ' sheet__head--grab' : ''}`}
                            title={panelHead ? 'Tap or drag to show more or less' : undefined}
                            {...panelHead}
                        >
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
                        <div className="sheet__body" {...wake}>
                            <panel.Component minimal={panelMinimal} />
                        </div>
                    </div>
                )}

                {extension && (
                    <div className="sheet sheet--ext" role="region" aria-label={extension.title}>
                        <div
                            className={`sheet__head${extHead ? ' sheet__head--grab' : ''}`}
                            title={extHead ? 'Tap or drag to show more or less' : undefined}
                            {...extHead}
                        >
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
                        <div className="sheet__body sheet__body--ext" {...wake}>
                            <extension.Component minimal={extMinimal} />
                        </div>
                    </div>
                )}
            </main>

            {/* Only with the screen to itself, unless the operator has asked otherwise —
                see the note at the top, and mobileTabsAlways in the display settings.
                The sheet's own × is what brings it back when it is hidden, which is why
                that button exists on every sheet including an extension's.

                Kept on, it is a row of panel names under an open sheet: a tap moves
                straight from one panel to the next, at the cost of a tenth of the height
                the sheet was using. Which of those two matters more depends on whether
                somebody is working across panels or looking at one, and the receiver
                cannot tell — hence a setting rather than a rule. */}
            {(display.mobileTabsAlways || (!panel && !extension)) && (
                <nav className={`tabbar${panel || extension ? ' tabbar--over' : ''}`}>
                    {visible.map((p) => (
                        <button
                            key={p.id}
                            type="button"
                            // Lit while its own sheet is the one showing, which only means
                            // anything when the row stays up: without it, moving between
                            // panels would be moving between identical-looking taps.
                            className={`tabbar__item${panel && panel.id === p.id ? ' is-open' : ''}`}
                            aria-current={panel && panel.id === p.id ? 'true' : undefined}
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
