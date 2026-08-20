// Entry point for the IF Spectrum panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope, and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// layout.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import IFSpectrumPanel from '../src/panels/IFSpectrumPanel.jsx';
import { PANEL_BY_ID } from '../src/panels/registry.jsx';
import { DEFAULTS } from '../src/display/DisplayContext.jsx';
import { GROUPS } from '../src/panels/groups.jsx';
import { setSpectrumPaused, spectrumPaused } from '../src/lib/spectrumPause.js';

module.exports = { deep, render, reset, walk, words, setSpectrumPaused, spectrumPaused, IFSpectrumPanel, PANEL_BY_ID, DEFAULTS, GROUPS };
