// Entry point for the Stats panel's render test.
//
// hookStub first and for its side effect: src/react.js reads window.React at
// module scope and a bundler hoists module bodies above inline code, so it has
// to be in place before anything that leads there. Same rule as
// measurepanel.entry.js.
//
// spectrumStats comes out with it because the panel and the waterfall's corner
// readout are two views of one sample — the test asserts the panel prints the
// same figures the readout words, and it should ask the real formatter rather
// than hard-code what it currently says.
import { deep, render, reset, walk, words } from './hookStub.js';
import StatsPanel from '../src/panels/StatsPanel.jsx';
import * as stats from '../src/lib/spectrumStats.js';

module.exports = {
    deep, render, reset, walk, words, StatsPanel, stats,
};
