import { useEffect } from '../react.js';

// Clears a drag-hover highlight when the drag finishes, wherever it finishes.
//
// `dragleave` and `drop` are not enough on their own: dropping onto a nested
// target that calls stopPropagation() means the outer element never sees the
// drop, so its highlight stays lit. `dragend` always fires on the drag source
// and bubbles to the window, whether the drag was completed or cancelled — so
// it is the one signal every participant reliably receives.
export function useDragEndReset(active, reset) {
    useEffect(() => {
        if (!active) return undefined;
        window.addEventListener('dragend', reset);
        window.addEventListener('drop', reset);
        return () => {
            window.removeEventListener('dragend', reset);
            window.removeEventListener('drop', reset);
        };
    }, [active, reset]);
}
