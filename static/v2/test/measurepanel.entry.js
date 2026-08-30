// Entry point for the Measure panel's and overlay's render tests.
//
// hookStub first and for its side effect: src/react.js reads window.React at
// module scope and a bundler hoists module bodies above inline code, so it has
// to be in place before anything that leads there. Same rule as
// scopepanel.entry.js.
//
// The store and the maths come out with them because the two components are
// driven by the store rather than by props — a test has to set one up before
// asking what the other drew, and it should do that through the same functions
// the product uses rather than by hand-building a result shape that could drift.
import { deep, render, reset, walk, words } from './hookStub.js';
import MeasurePanel from '../src/panels/MeasurePanel.jsx';
import MeasureOverlay from '../src/components/MeasureOverlay.jsx';
import * as measure from '../src/lib/measure.js';
import * as tool from '../src/lib/measureTool.js';

module.exports = {
    deep, render, reset, walk, words, MeasurePanel, MeasureOverlay, measure, tool,
};
