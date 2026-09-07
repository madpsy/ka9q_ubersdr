// Entry point for the DX cluster spot-search test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// dxpeditions.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import DXClusterSearch from '../src/panels/DXClusterSearch.jsx';
import DXClusterPanel from '../src/panels/DXClusterPanel.jsx';
import { _resetDxSession, dxConnect, dxDisconnect } from '../src/lib/dxclusterSession.js';
import {
    ANON_CALLSIGN, DEFAULT_PERIOD, PAGE_SIZE, PERIODS, bandsFrom, dayLabel,
    khzLabel, modeLabel, receiverMode, resultSummary, searchQuery, searchUrl,
    snrLabel, sourcesFrom, spotKey, spotNote, tuneFreq, utcLabel,
} from '../src/lib/dxclusterSearch.js';

module.exports = {
    deep, render, reset, walk, words,
    DXClusterSearch, DXClusterPanel, _resetDxSession, dxConnect, dxDisconnect,
    ANON_CALLSIGN, DEFAULT_PERIOD, PAGE_SIZE, PERIODS, bandsFrom, dayLabel,
    khzLabel, modeLabel, receiverMode, resultSummary, searchQuery, searchUrl,
    snrLabel, sourcesFrom, spotKey, spotNote, tuneFreq, utcLabel,
};
