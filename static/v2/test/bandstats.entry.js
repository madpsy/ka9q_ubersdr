// Entry point for the Bands panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope, and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// ifpanel.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import BandStatsPanel from '../src/panels/BandStatsPanel.jsx';
import { PANEL_BY_ID } from '../src/panels/registry.jsx';
import { GROUPS } from '../src/panels/groups.jsx';
import { resetBandNoise } from '../src/lib/bandNoise.js';
import { setFeedsAllowed, resetFeeds } from '../src/lib/serverFeeds.js';

module.exports = {
    deep, render, reset, walk, words,
    BandStatsPanel, PANEL_BY_ID, GROUPS,
    resetBandNoise, setFeedsAllowed, resetFeeds,
};
