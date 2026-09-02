// Bundle entry for the in-view gate's test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope, and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// holdpress.entry.js.
import { render, reset } from './hookStub.js';
import useInView, { IN_VIEW_MARGIN, OFF_SCREEN_MS } from '../src/lib/useInView.js';
import usePageVisible from '../src/lib/usePageVisible.js';
import { HIDDEN_SUSPEND_MS } from '../src/radio/idle.js';

module.exports = {
    render, reset, useInView, usePageVisible,
    IN_VIEW_MARGIN, OFF_SCREEN_MS, HIDDEN_SUSPEND_MS, React: window.React,
};
