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
// The tab bar stays up over the sheet by default, so swapping panels is one tap
// rather than close-then-open. It can be sent away instead — see mobileTabsAlways
// in the display settings — which is worth doing on a small handset: the row of
// labelled icons costs about a tenth of the screen, and hidden it gives that back
// to the spectrum *and* to the sheet, which is a share of the centre area and so
// grows with it. Which way round is better depends on whether somebody is working
// across panels or looking at one, so it is a setting rather than a rule.

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
import PanelZoom, { usePanelScale } from './PanelZoom.jsx';
import { SOLO, groupsFor } from '../panels/groups.jsx';

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
    // The row: the solo panel, then the groups this receiver has anything to put
    // in. See panels/groups.jsx.
    const solo = visible.find((p) => p.id === SOLO) || null;
    const groups = groupsFor(visible.filter((p) => p.id !== SOLO));
    // Which group's list is showing, if any. Not remembered: a menu is a thing
    // you are in the middle of, and coming back to a phone with one hanging open
    // over the spectrum would be coming back to a mess.
    const [menuId, setMenuId] = useState(null);
    const menu = menuId ? groups.find((g) => g.id === menuId) || null : null;
    // The extension wins the sheet: opening one is the more recent choice, and
    // it is opened from a panel that would otherwise sit on top of it.
    // Through `visible`, not through PANEL_BY_ID: the row is gated and the sheet
    // has to be gated with it. A sheet chosen by id alone would draw a panel
    // this receiver does not serve — the row would not offer it, and it would be
    // on screen anyway. `openId` is not remembered between visits, so this is a
    // guard rather than a thing that happens daily; it is here because every
    // other surface that draws a panel asks the same question, and the one that
    // did not is what put "This panel could not be loaded" on a receiver that
    // never had the panel. See usePanelApplies.
    const panel = extension ? null : (openId ? visible.find((p) => p.id === openId) || null : null);
    // A group is lit when the sheet showing belongs to it, which is the only way
    // to tell where you are once the row is groups rather than panels. Below
    // `panel` and not above it: a const read before its declaration is a
    // ReferenceError, and this one is read on every render of the shell.
    const openGroup = panel ? groups.find((g) => g.items.some((p) => p.id === panel.id)) : null;
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

    // The open sheet's own text size. Unconditional, as a hook has to be: with
    // no sheet open it reads the layout for a panel id of undefined and returns
    // the global size, which is what an element that is not drawn should get.
    const panelZoom = usePanelScale(panel?.id);

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

                {/* `fill` means the panel owns its own scroller and has to be
                    told where its bottom is — the same thing the bottom dock
                    does for the same panels. On a sheet that is a cap rather
                    than a height: a panel with little in it gets a short sheet
                    and leaves the spectrum showing. See .sheet--fill. */}
                {panel && (
                    <div
                        className={`sheet${panel.fill ? ' sheet--fill' : ''}`}
                        role="region"
                        aria-label={panel.title}
                        /* So the stylesheet can say something about one panel's
                           sheet without the shell having to know which — see
                           .sheet[data-panel="chat"]. */
                        data-panel={panel.id}
                        /* This panel's own text size, if it has been given one —
                           see PanelZoom. A phone is where it earns the most: the
                           sheet is a third of a dock's room, and which panels
                           want smaller type to fit and which want larger type to
                           be read at arm's length is not the same answer. */
                        style={panelZoom.style}
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
                            {/* Full width to work with, so this one is never
                                short of room — the pair is drawn on every sheet
                                rather than being the first thing dropped as it is
                                in a dock header. */}
                            <PanelZoom panelId={panel.id} className="sheet__act" size={16} />
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
                <div className="tabdock">
                    {/* The list a group opens, over the row it opened from.
                        Dismissed by anything else being touched — a menu you have
                        to aim at a close button to be rid of is a menu in the way,
                        and every tap outside it is already a tap at something the
                        operator would rather be doing. */}
                    {menu && (
                        <div
                            className="groupmenu__scrim"
                            /* On the click, not the pointerdown. A tap is a
                               pointerdown, a pointerup and then a click, and the
                               click is hit-tested against the DOM *as it is
                               then* — so dismissing on the way down took the
                               scrim out from under a tap that had not finished,
                               and the click landed on the sheet behind it. The
                               menu closed and the panel underneath acted on the
                               same tap. Closing on the click means the scrim is
                               still there to receive it, which is the whole job
                               of a scrim: to be the thing that gets hit. */
                            onClick={() => setMenuId(null)}
                            aria-hidden="true"
                        />
                    )}
                    {menu && (
                        <nav className="groupmenu" aria-label={menu.title}>
                            <div className="groupmenu__head">{menu.title}</div>
                            {menu.items.map((p) => (
                                <button
                                    key={p.id}
                                    type="button"
                                    className={`groupmenu__item${panel && panel.id === p.id ? ' is-open' : ''}`}
                                    aria-current={panel && panel.id === p.id ? 'true' : undefined}
                                    onClick={() => { setOpenId(p.id); setMenuId(null); }}
                                >
                                    <span className="groupmenu__icon">{p.icon}</span>
                                    <span className="groupmenu__label">{p.title}</span>
                                    {p.Badge && <p.Badge />}
                                </button>
                            ))}
                        </nav>
                    )}

                    <nav className={`tabbar${panel || extension ? ' tabbar--over' : ''}`}>
                        {/* Alone and first — see SOLO. It opens its panel rather
                            than a list, because a group in front of the dial is a
                            tap in the one place that cannot afford one. */}
                        {solo && (
                            <button
                                type="button"
                                className={`tabbar__item${panel && panel.id === solo.id ? ' is-open' : ''}`}
                                aria-current={panel && panel.id === solo.id ? 'true' : undefined}
                                onClick={() => { setMenuId(null); setOpenId(solo.id); }}
                            >
                                <span className="tabbar__icon">{solo.icon}</span>
                                <span className="tabbar__label">{solo.title}</span>
                            </button>
                        )}
                        {groups.map((g) => (
                            <button
                                key={g.id}
                                type="button"
                                // Lit while the sheet showing is one of its own, and
                                // marked separately while its list is open: those are
                                // two different things to know, and on a row of six
                                // identical shapes both are worth saying.
                                className={`tabbar__item${openGroup && openGroup.id === g.id ? ' is-open' : ''}${menuId === g.id ? ' is-menu' : ''}`}
                                aria-expanded={menuId === g.id}
                                aria-haspopup="menu"
                                onClick={() => setMenuId((id) => (id === g.id ? null : g.id))}
                            >
                                <span className="tabbar__icon">{g.icon}</span>
                                <span className="tabbar__label">{g.title}</span>
                                {/* Its children's badges, on the group. A mention
                                    that only badged the Chat panel would be a
                                    mention nobody could see: the panel is two taps
                                    inside a list that is not open. */}
                                {g.items.map((p) => (p.Badge ? <p.Badge key={p.id} /> : null))}
                            </button>
                        ))}
                    </nav>
                </div>
            )}
        </div>
    );
}
