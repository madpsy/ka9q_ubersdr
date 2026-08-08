// The arithmetic behind a paged list. Separated from the controls that draw it because it
// is where the mistakes are: an off-by-one in a chevron is visible, a window that points
// past the end of a list that shrank is a panel that goes blank and nobody can say why.
//
// See components/Pager.jsx for the hook and the row of buttons.

// Rows to a page. Ten was the old "Show more" step, and is about what a dock column shows
// without the panel becoming the whole of it.
export const PAGE_ROWS = 10;

export function pageCount(total, rows = PAGE_ROWS) {
    if (!(total > 0) || !(rows > 0)) return 1;
    // Never zero: an empty list is on page 1 of 1, not page 1 of 0. The controls hide
    // themselves at one page, and "of 0" is not a thing to render.
    return Math.ceil(total / rows);
}

// Which page holds row `at` — the band the receiver is in, in the one case that asks. A
// negative `at` means "no opinion", which is page one.
export function homePage(at, pages, rows = PAGE_ROWS) {
    if (!(at >= 0)) return 0;
    return Math.min(Math.max(1, pages) - 1, Math.floor(at / rows));
}

// The window to render, with the page clamped into the list as it is *now*.
//
// The clamp is the whole point. These lists change under the panel — a bookmark deleted, a
// search narrowed, the server republishing — and the page number outlives the list it was
// chosen for. Clamping here, on the way out, means the caller cannot render a page that no
// longer exists; correcting it afterwards in an effect would show the empty one first.
export function pageWindow(total, page, rows = PAGE_ROWS) {
    const count = total > 0 ? total : 0;
    const pages = pageCount(count, rows);
    const at = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1);
    const start = at * rows;
    return {
        page: at,
        pages,
        start,
        // Short on the last page rather than running past the end.
        end: Math.min(count, start + rows),
        total: count,
    };
}
