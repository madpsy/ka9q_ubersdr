// Entry point for the Band Spectrum panel's render test. The hook stub comes
// first, for the reason ifpanel.entry.js gives.
import { render, reset, rerender, walk } from './hookStub.js';
import BandSpectrumPanel from '../src/panels/BandSpectrumPanel.jsx';
import { DEFAULTS } from '../src/display/DisplayContext.jsx';

module.exports = { render, reset, rerender, walk, BandSpectrumPanel, DEFAULTS };
