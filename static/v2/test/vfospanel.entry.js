// Entry point for the VFOs panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// bandstats.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import VfosPanel from '../src/panels/VfosPanel.jsx';
import { getVfos, setVfos } from '../src/lib/vfos.js';

module.exports = { deep, render, reset, walk, words, VfosPanel, getVfos, setVfos };
