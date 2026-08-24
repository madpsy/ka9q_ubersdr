// Entry point for the filter reset button's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope, and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// layout.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import FilterReset from '../src/components/FilterReset.jsx';
import ReceiverPanel from '../src/panels/ReceiverPanel.jsx';
import { DEFAULTS } from '../src/display/DisplayContext.jsx';
import { MODES, MODE_BY_ID } from '../src/radio/constants.js';

module.exports = {
    deep, render, reset, walk, words, FilterReset, ReceiverPanel, DEFAULTS, MODES, MODE_BY_ID,
};
