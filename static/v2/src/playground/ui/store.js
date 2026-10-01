// Whether the playground's window is open, and a shared graph waiting to be
// offered — page-wide, because the button that opens it lives in a panel that
// can be collapsed (and so unmounted) while the window stays up, and a link
// can arrive before either exists.

import { useEffect, useState } from '../../react.js';

let state = { open: false, pending: null };
const listeners = new Set();

function set(patch) {
    state = { ...state, ...patch };
    for (const fn of Array.from(listeners)) fn(state);
}

export function openPlayground() {
    set({ open: true });
}

export function closePlayground() {
    set({ open: false });
}

/**
 * A graph from a link, waiting for the operator to say whether to load it —
 * never loaded without asking, because it would replace what they have built.
 * `{ graph, errors }` as decodeShare gives it; null clears it.
 */
export function offerSharedGraph(result) {
    set({ pending: result, open: result ? true : state.open });
}

export function playgroundUiState() {
    return state;
}

export function usePlaygroundUi() {
    const [s, setS] = useState(state);
    useEffect(() => {
        listeners.add(setS);
        setS(state);
        return () => listeners.delete(setS);
    }, []);
    return s;
}
