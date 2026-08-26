// Entry point for the frequency drum's direction tests.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope, and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// bandstats.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import Barrel from '../src/components/Barrel.jsx';
import { DEFAULTS } from '../src/display/DisplayContext.jsx';

module.exports = {
    deep, render, reset, walk, words, Barrel, DEFAULTS,
};
