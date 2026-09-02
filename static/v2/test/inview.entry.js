// Bundle entry for the in-view gate's test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope, and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// holdpress.entry.js.
import { render, reset } from './hookStub.js';
import useInView, { IN_VIEW_MARGIN, OFF_SCREEN_MS } from '../src/lib/useInView.js';

module.exports = {
    render, reset, useInView, IN_VIEW_MARGIN, OFF_SCREEN_MS, React: window.React,
};
