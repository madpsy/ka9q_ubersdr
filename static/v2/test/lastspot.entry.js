// Entry point for the callsign panel's last-heard line.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// dxsearch.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import { LastSpot } from '../src/panels/CallsignPanel.jsx';
import {
    LAST_SPOT_DAYS, dxClusterAvailable, fetchLastSpot, heardHere, lastSpotUrl,
    modeLabel, receiverMode, spotAge,
} from '../src/lib/dxclusterSearch.js';

module.exports = {
    deep, render, reset, walk, words,
    LastSpot,
    LAST_SPOT_DAYS, dxClusterAvailable, fetchLastSpot, heardHere, lastSpotUrl,
    modeLabel, receiverMode, spotAge,
};
