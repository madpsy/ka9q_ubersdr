// Entry point for the Leaflet base-layer test.
//
// The outline cache lives in lib/worldMap.js, which lib/leafletBase.js imports.
// Bundling the two separately would give the test a second copy of that module
// and a reset that resets nothing, so both come out of one bundle here.
import {
    addBaseLayer, addWorldOutline, arcToLatLngs,
    FAIL_THRESHOLD, OFFLINE_ATTRIBUTION, TILE_ATTRIBUTION, TILE_URL,
} from '../src/lib/leafletBase.js';
import { _resetWorldArcs } from '../src/lib/worldMap.js';

module.exports = {
    addBaseLayer, addWorldOutline, arcToLatLngs,
    FAIL_THRESHOLD, OFFLINE_ATTRIBUTION, TILE_ATTRIBUTION, TILE_URL,
    _resetWorldArcs,
};
