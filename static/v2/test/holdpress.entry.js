// Entry point for the hold-press gesture's test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope, and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// layout.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import useHoldPress, { HOLD_MS } from '../src/lib/useHoldPress.js';
import MultipadPanel from '../src/panels/MultipadPanel.jsx';
import { DEFAULTS } from '../src/display/DisplayContext.jsx';
import { SQUELCH_MIN } from '../src/radio/constants.js';

module.exports = {
    deep, render, reset, walk, words, useHoldPress, HOLD_MS,
    MultipadPanel, DEFAULTS, SQUELCH_MIN,
};
