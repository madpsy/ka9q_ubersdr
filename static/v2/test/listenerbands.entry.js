// Entry point for the Listeners panel's band view — the geometry and the render.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope, and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// filterreset.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import ListenerBands from '../src/components/ListenerBands.jsx';
import {
    BANDS_VIEW, CLUSTER_PCT, LIST_VIEW, OTHER_ROW, bandRows, pctOf, saveView, savedView,
} from '../src/lib/listenerBands.js';

module.exports = {
    deep, render, reset, walk, words,
    ListenerBands,
    BANDS_VIEW, CLUSTER_PCT, LIST_VIEW, OTHER_ROW, bandRows, pctOf, saveView, savedView,
};
