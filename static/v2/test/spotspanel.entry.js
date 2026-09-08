// Entry point for the Spots panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// dxpeditions.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import SpotsPanel from '../src/panels/SpotsPanel.jsx';
import SpotMap from '../src/components/SpotMap.jsx';
import SpotsWorldMap, { placeable } from '../src/components/SpotsWorldMap.jsx';
import { normaliseCW, normaliseDigital, normaliseDX } from '../src/lib/spots.js';

module.exports = {
    deep, render, reset, walk, words,
    SpotsPanel, SpotMap, SpotsWorldMap, placeable,
    normaliseCW, normaliseDigital, normaliseDX,
};
