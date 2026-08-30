// Entry point for the pad's IQ-mode tests.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// holdpress.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import MultipadPanel from '../src/panels/MultipadPanel.jsx';
import NoisePanel from '../src/panels/NoisePanel.jsx';
import { DEFAULTS } from '../src/display/DisplayContext.jsx';

module.exports = {
    deep, render, reset, walk, words, MultipadPanel, NoisePanel, DEFAULTS,
};
