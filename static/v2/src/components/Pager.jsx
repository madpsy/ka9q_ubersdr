// Paging for the long lists — bookmarks, local bookmarks, bands.
//
// Panels have no scroller of their own (the dock scrolls), so a list of a few hundred rows
// cannot simply be rendered. The lists used to grow instead: a "Show more" button that
// added ten rows a press. That works for a glance at the top and badly for anything else —
// the twelfth press has made the dock several screens long, there is no way back short of
// reopening the panel, and nothing tells you where in the list you are.
//
// So: a fixed window and a way to move it. The panel stays one dock-height whatever the
// list contains, "31–40 of 118" says where you are, and the same press that went forward
// goes back.
//
// `usePager` holds the page number; lib/paging.js does the arithmetic, including the part
// that matters most — the page is clamped into the list on the way *out* of the hook,
// during render, rather than corrected afterwards in an effect. These lists change under
// the panel (a bookmark deleted, a search narrowed, the server republishing) and a page
// number left pointing past the end would otherwise render an empty list for one frame.

import React, { useCallback, useMemo, useState } from '../react.js';
import { Icon } from './ui.jsx';
import { PAGE_ROWS, homePage, pageCount, pageWindow } from '../lib/paging.js';

export { PAGE_ROWS };

// First/last are only worth their width once there is somewhere to jump: with three pages
// the ‹ › pair already reaches everything, and a dock column has no room to spare.
const JUMPS_FROM = 4;

// One page of `total` rows, and the controls to move it.
//
// `deps` are the things that mean "a different list" rather than a changed one — a search
// term, a group filter. Changing any of them goes back to the first page, because page 4
// of the old list says nothing about the new one. A list that merely gains or loses rows
// stays where it is.
export function usePager(total, { rows = PAGE_ROWS, deps = [], at = -1 } = {}) {
    const [state, setState] = useState({ page: 0, key: '' });
    const key = JSON.stringify(deps);

    // Where `at` lands, when the caller has a row it wants shown. Only consulted for the
    // opening page — after that the page is wherever it was left.
    const home = homePage(at, pageCount(total, rows), rows);
    const want = state.key === key ? state.page : home;
    const { page, pages, start, end } = pageWindow(total, want, rows);

    const go = useCallback((n) => {
        // Keyed by the deps it was chosen for, so the next change of search or filter is
        // recognised as a different list rather than inherited.
        setState({ page: Math.max(0, n), key });
    }, [key]);

    // A stable identity for the props a Pager needs, so nothing memoised downstream is
    // redrawn by the pager alone.
    const control = useMemo(() => ({
        page, pages, start, end, total, go,
    }), [page, pages, start, end, total, go]);

    return {
        // What to render: `slice(start, end)` of whatever the caller is paging.
        start,
        end,
        page,
        pages,
        go,
        pager: control,
    };
}

// The row of controls. Given `usePager`'s `pager`, so a panel passes one prop.
export function Pager({ pager, unit = 'rows' }) {
    const { page, pages, start, end, total, go } = pager;

    // Nothing to page through. The count still shows: it is the answer to "is that all of
    // them?", which a list that ends without a control leaves open.
    if (pages <= 1) {
        return total > 0 ? <div className="list__count">{total} shown</div> : null;
    }

    const jumps = pages >= JUMPS_FROM;
    const first = page === 0;
    const last = page >= pages - 1;

    return (
        <div className="pager" role="group" aria-label={`${unit} pages`}>
            {jumps && (
                <button
                    type="button"
                    className="pager__btn"
                    onClick={() => go(0)}
                    disabled={first}
                    title="First page"
                    aria-label="First page"
                >
                    <Icon.ChevronLeft size={13} />
                    <Icon.ChevronLeft size={13} className="pager__second" />
                </button>
            )}
            <button
                type="button"
                className="pager__btn"
                onClick={() => go(page - 1)}
                disabled={first}
                title="Previous page"
                aria-label="Previous page"
            >
                <Icon.ChevronLeft size={14} />
            </button>
            {/* The range rather than "page 3 of 12": a list is rows, and "31–40 of 118"
                answers both where you are and how much is left, in the same width. */}
            <span className="pager__at" aria-live="polite">
                <span className="pager__range">{start + 1}–{end}</span>
                <span className="pager__total">of {total}</span>
            </span>
            <button
                type="button"
                className="pager__btn"
                onClick={() => go(page + 1)}
                disabled={last}
                title="Next page"
                aria-label="Next page"
            >
                <Icon.ChevronRight size={14} />
            </button>
            {jumps && (
                <button
                    type="button"
                    className="pager__btn"
                    onClick={() => go(pages - 1)}
                    disabled={last}
                    title="Last page"
                    aria-label="Last page"
                >
                    <Icon.ChevronRight size={13} />
                    <Icon.ChevronRight size={13} className="pager__second" />
                </button>
            )}
        </div>
    );
}

export default Pager;
