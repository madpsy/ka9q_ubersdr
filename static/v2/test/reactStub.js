// Enough React for a module that only *imports* it.
//
// src/react.js throws unless the UMD globals are present, and the panel registry
// pulls in every panel in the app — so there is no reaching the layout rules
// without React being there first. Imported as a side effect, before anything
// that leads to src/react.js, because a bundler hoists module bodies above
// inline code and the stub has to be in place by then. Nothing here is rendered:
// only the hooks src/react.js destructures have to exist.
const noop = () => () => {};
globalThis.window = globalThis.window || globalThis;
window.React = {
    Fragment: 'Fragment',
    createContext: () => ({ Provider: 'Provider', Consumer: 'Consumer' }),
    createElement: () => null,
    memo: (f) => f,
    useCallback: noop,
    useContext: () => null,
    useEffect: noop,
    useLayoutEffect: noop,
    useMemo: noop,
    useReducer: noop,
    useRef: () => ({ current: null }),
    useState: noop,
};
window.ReactDOM = { createRoot: () => ({ render() {} }) };
