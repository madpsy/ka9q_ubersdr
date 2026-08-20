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
        // Children go into props as well, because that is where React puts them
        // and therefore where a component reads them from. Without this a
        // component expanded by deep() renders with no children at all — a
        // <Button>Resume</Button> comes out as an empty button, which looks like
        // the label having been forgotten rather than like the stub having
        // dropped it.
        const p = { ...(props || {}) };
        if (children.length === 1) [p.children] = children;
        else if (children.length > 1) p.children = children;
        return { type, props: p, children };
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

// An element's children, from whichever place they were given. The two are the
// same objects — createElement copies them into props — so exactly one of them
// is followed, or every element below this one would be visited twice and every
// count taken from a tree would be double.
function kids(node) {
    if (node.children && node.children.length) return node.children;
    const c = node.props && node.props.children;
    return c == null ? [] : [c];
}

/** Every element in a tree, depth first — for asserting what was drawn. */
export function walk(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        for (const n of node) walk(n, out);
        return out;
    }
    out.push(node);
    for (const c of kids(node)) walk(c, out);
    return out;
}

/**
 * The same, but calling any function component it meets rather than stopping at
 * it — so a tree can be asserted on by class name and by the words in it.
 *
 * walk() sees only what the component under test returned itself. A panel's own
 * pieces are not exported (there is no reason for them to be), so anything drawn
 * by one of them — an empty state, a cover over the picture — is invisible to a
 * test that can only look at the outer return. That is precisely the part worth
 * asserting on, because it is the part that only appears when something has gone
 * wrong.
 *
 * Each expansion runs in its own hook frame, so a child that does use hooks
 * cannot consume its parent's slots. Effects it registers are discarded: this is
 * for reading a rendered tree, not for mounting one.
 */
export function deep(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        for (const n of node) deep(n, out);
        return out;
    }
    if (typeof node.type === 'function') {
        const outer = { state: hooks.state, i: hooks.i, effects: hooks.effects };
        hooks.state = [];
        hooks.i = 0;
        hooks.effects = [];
        let inner;
        try {
            inner = node.type(node.props || {});
        } finally {
            hooks.state = outer.state;
            hooks.i = outer.i;
            hooks.effects = outer.effects;
        }
        return deep(inner, out);
    }
    out.push(node);
    for (const c of kids(node)) deep(c, out);
    return out;
}

/** The text a subtree reads as, for asserting on what a state actually says. */
export function words(node) {
    return deep(node)
        .flatMap((n) => kids(n).filter((c) => typeof c === 'string'))
        .join(' ');
}
