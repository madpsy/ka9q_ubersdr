// Single point of contact with the React UMD globals.
//
// Everything else in the app imports from here, so moving to a bundled React
// (npm) later means editing this file only.

const React = window.React;
const ReactDOM = window.ReactDOM;

if (!React || !ReactDOM) {
    throw new Error('React UMD bundles failed to load — check static/v2/vendor/');
}

export default React;
export { ReactDOM };

export const {
    Fragment,
    createContext,
    createElement,
    memo,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} = React;
