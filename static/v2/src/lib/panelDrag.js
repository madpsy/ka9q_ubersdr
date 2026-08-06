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
