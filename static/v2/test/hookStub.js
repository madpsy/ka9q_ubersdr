// A React that really runs hooks, and just enough browser to import a panel.
//
// The existing reactStub.js is for modules that only *reach* React on the way to
// something else — its createElement returns null and its hooks do nothing. That
// is deliberately not enough to answer the one question this directory cannot
// otherwise ask: does a panel actually render?
//
// Nothing in the protocol tests exercises the React tree, and unresolved.js is a
// static check, so a name that exists but is wrong — a component used before it
// is defined, a helper called with the arguments in the other order, an effect
// that throws on mount — builds cleanly, passes every test, and blanks the
// interface the moment the panel is opened. This is the smallest thing that
// catches that class: real hook storage, a createElement that refuses an
// undefined type, and effects that are collected so the test can run them.
//
// It is not a renderer. There is no reconciliation, no DOM and no second pass:
// a component is called once with the hook state kept between calls, which is
// enough to prove the render path and the mount effects execute.

const hooks = { state: [], i: 0, effects: [] };

function slot(init) {
    const i = hooks.i++;
    if (!(i in hooks.state)) hooks.state[i] = typeof init === 'function' ? init() : init;
    return i;
}

globalThis.window = globalThis.window || globalThis;

window.React = {
    Fragment: 'Fragment',
    createContext: () => ({ Provider: 'Provider', Consumer: 'Consumer' }),
    createElement: (type, props, ...children) => {
        // The failure this exists for: a component referenced before it is
        // imported is `undefined` here, and React renders nothing rather than
        // throwing. Two panels have shipped blank that way.
        if (type === undefined || type === null) {
            throw new Error('createElement called with an undefined type — a component is missing from the imports');
        }
        return { type, props: props || {}, children };
    },
    memo: (f) => f,
    useCallback: (fn) => fn,
    useContext: () => window.__testContext || null,
    useEffect: (fn, deps) => { hooks.effects.push({ fn, deps }); },
    useLayoutEffect: (fn, deps) => { hooks.effects.push({ fn, deps }); },
    useMemo: (fn) => fn(),
    useReducer: (reducer, init) => {
        const i = slot(init);
        return [hooks.state[i], (action) => { hooks.state[i] = reducer(hooks.state[i], action); }];
    },
    useRef: (init) => {
        const i = slot(() => ({ current: init }));
        return hooks.state[i];
    },
    useState: (init) => {
        const i = slot(init);
        return [hooks.state[i], (v) => {
            hooks.state[i] = typeof v === 'function' ? v(hooks.state[i]) : v;
        }];
    },
};
window.ReactDOM = { createRoot: () => ({ render() {} }) };

/**
 * Call a component, then run the effects it registered.
 *
 * Returns the element tree, and the cleanups, so a caller can prove that
 * unmounting works too — an effect that throws on the way out leaks a listener
 * per open-and-close and is invisible until a session has been running for
 * hours.
 */
export function render(Component, props, context) {
    window.__testContext = context;
    hooks.i = 0;
    hooks.effects = [];
    const tree = Component(props || {});
    const cleanups = [];
    for (const e of hooks.effects) {
        const off = e.fn();
        if (typeof off === 'function') cleanups.push(off);
    }
    return { tree, cleanups };
}

/** Forget the hook state, so the next render is a fresh mount. */
export function reset() {
    hooks.state = [];
    hooks.i = 0;
    hooks.effects = [];
}

/** Every element in a tree, depth first — for asserting what was drawn. */
export function walk(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        for (const n of node) walk(n, out);
        return out;
    }
    out.push(node);
    for (const c of node.children || []) walk(c, out);
    walk(node.props && node.props.children, out);
    return out;
}
