// Entry point for the NCDXF beacon panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// dxpeditions.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import NCDXFPanel from '../src/panels/NCDXFPanel.jsx';
import BeaconMap from '../src/components/BeaconMap.jsx';
import { GROUPS, SOLO } from '../src/panels/groups.jsx';
import {
    BEACON_BANDS, BEACON_FREQ, BEACON_MODE, WINDOWS,
    RateLimitedError, _resetNcdxf, _seedNcdxf, bandSummary, beaconTarget, cleanRoster, fetchHeard,
    mergeSpots, ncdxfState, notHeard, onNcdxf, receiverAt, refreshNcdxf, resolveBeaconBand,
    rowsForBand, savedPrefs, snrLabel, spotsUrl, statsFor, windowLabel,
} from '../src/lib/ncdxf.js';

module.exports = {
    deep, render, reset, walk, words,
    NCDXFPanel, BeaconMap, GROUPS, SOLO,
    BEACON_BANDS, BEACON_FREQ, BEACON_MODE, WINDOWS,
    RateLimitedError, _resetNcdxf, _seedNcdxf, bandSummary, beaconTarget, cleanRoster, fetchHeard,
    mergeSpots, ncdxfState, notHeard, onNcdxf, receiverAt, refreshNcdxf, resolveBeaconBand,
    rowsForBand, savedPrefs, snrLabel, spotsUrl, statsFor, windowLabel,
};
