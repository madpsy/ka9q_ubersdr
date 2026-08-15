// The "🌐 Links" menu from v1 (static/pages-menu.js), hung off the top bar's
// logo instead of a button pinned to the page corner.
//
// Same source and same rules: /api/pages-menu returns groups of pages, each
// group, subgroup and file optionally carrying a `depends_on` key that is
// checked against /api/description — so a receiver without, say, a CW skimmer
// never shows that group. Subgroups nest arbitrarily deep and fly out to the
// right. Internal pages open in a centred popup window, external links and
// downloads in a plain tab. The dynamic add-ons group is appended last.

import React, { ReactDOM, useCallback, useEffect, useLayoutEffect, useRef, useState } from '../react.js';
// The pruning is shared with the desktop client's native Links menu — see
// lib/pagesMenu.js. Two menus over the same receiver must not disagree.
import { buildGroups } from '../lib/pagesMenu.js';

const POPUP_W = 1200;
const POPUP_H = 800;

function openPopup(url) {
    const left = Math.round((screen.width - POPUP_W) / 2);
    const top = Math.round((screen.height - POPUP_H) / 2);
    window.open(
        url,
        '_blank',
        `width=${POPUP_W},height=${POPUP_H},left=${left},top=${top},`
        + 'resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=no,status=no',
    );
}

function LinkItem({ item, onDone }) {
    return (
        <a
            className="links__item"
            href={item.url}
            title={item.tooltip || undefined}
            role="menuitem"
            onClick={(e) => {
                e.preventDefault();
                if (item.external) window.open(item.url, '_blank', 'noopener,noreferrer');
                else openPopup(item.url);
                onDone();
            }}
        >
            {item.label}
        </a>
    );
}

// One row that opens a flyout. Opening stays pure CSS hover, as in v1, so depth
// needs no open/close state — but placement cannot be: this menu nests three
// and four levels deep, and by then a chain of right-opening panels runs past
// the edge of the screen. On hover the panel is measured once and, if it would
// overflow, flipped to the left of its parent and/or lifted up.
function GroupRow({ node, onDone }) {
    const ref = useRef(null);
    const [fit, setFit] = useState({ flip: false, shiftUp: 0 });
    // Tapped open, for pointers that cannot hover. The CSS rule stays exactly
    // as it was and this adds a second way in beside it, so a mouse still opens
    // these by moving over them and nothing about the desktop menu changes.
    //
    // Without it these depend on the browser holding :hover after a tap, which
    // iOS does — until it decides the tap was a click instead, and then a
    // four-deep menu closes itself halfway down.
    const [tapped, setTapped] = useState(false);

    const measure = () => {
        // The CSS :hover has applied by the next frame, so the panel is laid out
        // and has a real rect to measure.
        requestAnimationFrame(() => {
            const el = ref.current;
            if (!el) return;
            const r = el.getBoundingClientRect();
            setFit((prev) => {
                const flip = prev.flip || r.right > window.innerWidth - 8;
                const shiftUp = Math.max(prev.shiftUp, Math.round(r.bottom - (window.innerHeight - 8)));
                return flip === prev.flip && shiftUp === prev.shiftUp ? prev : { flip, shiftUp: Math.max(0, shiftUp) };
            });
        });
    };

    return (
        <div
            className={`links__row${tapped ? ' is-open' : ''}`}
            role="menuitem"
            aria-haspopup="true"
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') measure(); }}
            onPointerLeave={(e) => { if (e.pointerType === 'mouse') setFit({ flip: false, shiftUp: 0 }); }}
            onClick={(e) => {
                // Only the row that was tapped, not every row it sits inside:
                // this menu nests, so the click would otherwise close each
                // ancestor on its way out.
                if (e.target.closest('.links__row') !== e.currentTarget) return;
                setTapped((was) => !was);
                measure();
            }}
        >
            <span className="links__label">{node.name}</span>
            <span className="links__arrow">{fit.flip ? '‹' : '›'}</span>
            <div
                ref={ref}
                className={`links__flyout${fit.flip ? ' is-flipped' : ''}`}
                style={fit.shiftUp ? { top: `${-5 - fit.shiftUp}px` } : undefined}
                role="menu"
            >
                {node.links.map((item) => <LinkItem key={item.url} item={item} onDone={onDone} />)}
                {node.subgroups.map((sg) => <GroupRow key={sg.name} node={sg} onDone={onDone} />)}
            </div>
        </div>
    );
}

export default function LinksMenu({ serverInfo, compact }) {
    const [open, setOpen] = useState(false);
    const [groups, setGroups] = useState(null);
    const ref = useRef(null);
    const panelRef = useRef(null);
    const fetched = useRef(false);

    // Where the panel goes: under the logo, as its absolute `top: 100%` used to
    // put it. Measured now, because the panel is portalled to <body> — the top
    // bar's `contain: paint` (see .topbar in styles.css) clips and re-bases
    // anything positioned inside it, so hung off the wrapper the menu was
    // cropped to the bar's own strip.
    const [at, setAt] = useState(null);
    useLayoutEffect(() => {
        if (!open) {
            setAt(null);
            return;
        }
        const r = ref.current.getBoundingClientRect();
        setAt({ left: r.left, top: r.bottom + 6 });
    }, [open]);

    // Fetched on first open — a receiver whose operator never opens this menu
    // should not pay for the request.
    useEffect(() => {
        if (!open || fetched.current) return;
        fetched.current = true;
        fetch('/api/pages-menu')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => setGroups(d ? buildGroups(d, serverInfo) : []))
            .catch(() => setGroups([]));
    }, [open, serverInfo]);

    // Rebuild when the receiver description lands after the menu was opened.
    useEffect(() => { fetched.current = false; }, [serverInfo]);

    useEffect(() => {
        if (!open) return undefined;
        // The panel is DOM-wise a child of <body>, not of the wrapper, so it
        // has to be asked separately or a click inside it would count as
        // outside and close the menu under the pointer.
        const onDown = (e) => {
            if (ref.current && ref.current.contains(e.target)) return;
            if (panelRef.current && panelRef.current.contains(e.target)) return;
            setOpen(false);
        };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const close = useCallback(() => setOpen(false), []);

    // On a phone the logo is a logo and nothing more.
    //
    // Every page in this menu is a v1 page built for a desktop — analytics tables, maps,
    // the admin pages — and opening one on a handset replaces the receiver with something
    // that cannot be read, from a control in the corner that looks like branding. The
    // pages are still reachable: they are ordinary URLs, and a phone has an address bar.
    //
    // Not merely hidden, because the mark is worth keeping: it says which receiver this is
    // beside its callsign. It stops being a button.
    if (compact) {
        return (
            <div className="links links--static">
                <span className="topbar__logo">
                    <img
                        className="topbar__logo-img"
                        src="/images/apple-touch-icon.png"
                        alt=""
                        width={26}
                        height={26}
                        draggable="false"
                    />
                </span>
            </div>
        );
    }

    return (
        <div
            className="links"
            ref={ref}
            // Hover opens and leaving closes, as v1's does. The panel is a child
            // of this wrapper, so moving down into it never counts as leaving —
            // and its ::before bridges the gap under the button.
            //
            // Pointer events rather than mouse ones, and only for a real mouse.
            // A tap synthesises the whole mouse sequence: enter (which opened
            // it) and then click (which toggled it shut again), so the menu
            // answered every other tap and felt broken rather than fussy. The
            // pointer type is asked at the event instead of the device being
            // asked in a media query, because an iPad with a trackpad is both
            // — and this way it hovers with the trackpad and taps with a
            // finger, which is what somebody holding one expects.
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') setOpen(true); }}
            onPointerLeave={(e) => { if (e.pointerType === 'mouse') setOpen(false); }}
        >
            <button
                type="button"
                className={`topbar__logo links__btn${open ? ' is-open' : ''}`}
                title="Pages and links"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
            >
                {/* The receiver's own mark rather than a generic glyph. The
                    artwork is a full-bleed square — Apple rounds its own — so
                    the corners are the stylesheet's to choose; see
                    .topbar__logo. Decorative: the button is already labelled,
                    and a second name here would be read out twice. */}
                <img
                    className="topbar__logo-img"
                    src="/images/apple-touch-icon.png"
                    alt=""
                    width={compact ? 26 : 32}
                    height={compact ? 26 : 32}
                    draggable="false"
                />
            </button>

            {/* In the React tree the panel is still a child of the hover
                wrapper, so moving the pointer down into it never counts as
                leaving — the portal only moves where it lives in the DOM. */}
            {open && ReactDOM.createPortal(
                <div
                    ref={panelRef}
                    className="links__panel"
                    role="menu"
                    style={at ? { left: at.left, top: at.top } : { visibility: 'hidden' }}
                >
                    {groups == null && <div className="links__note">Loading…</div>}
                    {groups && groups.length === 0 && <div className="links__note">No pages published.</div>}
                    {(groups || []).map((g) => <GroupRow key={g.name} node={g} onDone={close} />)}
                </div>,
                document.body,
            )}
        </div>
    );
}
