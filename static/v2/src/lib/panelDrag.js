// Which panel is being dragged, while it is being dragged.
//
// The drop indicator has to know, and the drag events cannot say: dataTransfer
// is write-only during `dragover` — the browser exposes the *types* being
// carried but not the data, so a page cannot read what is over it until the
// drop. Everything the indicator does before then — pick the gap nearest the
// pointer, and leave the dragged panel itself out of the candidates, since a
// gap either side of where it already is is not a place to put it — needs the
// id one event earlier than the API will give it.
//
// A module variable rather than context: it changes at pointer rate, nothing
// renders from it, and the dock and the section that started the drag are in
// different branches of the tree.

let dragging = null;

export function setDraggingPanel(id) {
    dragging = id || null;
}

export function draggingPanel() {
    return dragging;
}

/**
 * The gap nearest a point, inside one dock body.
 *
 * Shared by the two ways a panel arrives in a dock: the browser drag from
 * another dock (components/Dock.jsx) and a floating window carried over one
 * (components/FloatingPanel.jsx). One implementation because the answer has to
 * be the same — a drop indicator that promised one gap and a release that chose
 * another would be worse than no indicator.
 *
 * Read from the DOM rather than from the layout, because it is the rendered
 * order and the rendered sizes that the pointer is being compared against.
 * `moving` is left out of the candidates: the gaps either side of where a panel
 * already is are not places to put it.
 *
 * @returns {{id: string, edge: 'before'|'after'} | null}
 */
export function nearestPanelGap(body, clientX, clientY, side, moving) {
    if (!body) return null;
    const vertical = side !== 'bottom';
    const pos = vertical ? clientY : clientX;
    let best = null;
    let bestDist = Infinity;
    for (const el of body.querySelectorAll('[data-panel]')) {
        if (el.dataset.panel === moving) continue;
        const r = el.getBoundingClientRect();
        const mid = vertical ? r.top + r.height / 2 : r.left + r.width / 2;
        const d = Math.abs(pos - mid);
        if (d < bestDist) {
            bestDist = d;
            best = { id: el.dataset.panel, edge: pos < mid ? 'before' : 'after' };
        }
    }
    return best;
}

/**
 * The dock body under a point, if any, as `{ el, side }`.
 *
 * `elementsFromPoint` rather than `elementFromPoint`: during a float drag the
 * window being dragged is itself under the pointer, and the singular call would
 * only ever answer with that.
 */
export function dockBodyAt(clientX, clientY) {
    if (typeof document === 'undefined' || !document.elementsFromPoint) return null;
    for (const el of document.elementsFromPoint(clientX, clientY)) {
        const body = el.closest && el.closest('.dock__body');
        if (!body) continue;
        const dock = body.closest('[data-dock]');
        const side = dock && dock.dataset ? dock.dataset.dock : '';
        if (side) return { el: body, side };
    }
    return null;
}
