// Entry point for the DXpeditions panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// drmpanel.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import DXpeditionsPanel from '../src/panels/DXpeditionsPanel.jsx';
import { GROUPS, SOLO } from '../src/panels/groups.jsx';
import { onLookupRequest } from '../src/lib/callsign.js';
import {
    bandLabel, bearingLabel, dxpedKey, dxpeditionState, dxpeditionsPresent,
    isActive, listenFor, placedBy, positionOf, refreshDXpeditions, runLabel,
    visibleDXpeditions, websiteOf,
} from '../src/lib/dxpeditions.js';

module.exports = {
    deep, render, reset, walk, words,
    DXpeditionsPanel, GROUPS, SOLO, onLookupRequest,
    bandLabel, bearingLabel, dxpedKey, dxpeditionState, dxpeditionsPresent,
    isActive, listenFor, placedBy, positionOf, refreshDXpeditions, runLabel,
    visibleDXpeditions, websiteOf,
};
