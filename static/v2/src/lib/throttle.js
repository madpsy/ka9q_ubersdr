// Trailing-edge throttle: fires immediately, then at most once per `waitMs`
// with the most recent arguments. Used to keep dragging a slider from turning
// into a WebSocket command per pointer event.
export function throttle(fn, waitMs) {
    let last = 0;
    let timer = null;
    let pending = null;

    const invoke = () => {
        last = Date.now();
        timer = null;
        const args = pending;
        pending = null;
        fn(...args);
    };

    const wrapped = (...args) => {
        pending = args;
        const elapsed = Date.now() - last;
        if (elapsed >= waitMs) {
            if (timer) { clearTimeout(timer); timer = null; }
            invoke();
        } else if (!timer) {
            timer = setTimeout(invoke, waitMs - elapsed);
        }
    };

    wrapped.cancel = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        pending = null;
    };
    return wrapped;
}
