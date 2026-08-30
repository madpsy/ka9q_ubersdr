// Entry point for the frontend IQ demodulator's tests.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// drmpanel.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import IQPanel from '../src/panels/IQPanel.jsx';
import { PANEL_BY_ID } from '../src/panels/registry.jsx';
import { GROUPS } from '../src/panels/groups.jsx';
import {
    DRAG_SLOP_PX, IQ_FFT_SIZE, IQSpectrum, aimCancel, aimDown, aimMove, aimUp, binsToPixels,
    fftInPlace, fractionOffset, hannWindow, newAim, offsetFraction,
} from '../src/lib/iqSpectrum.js';
import {
    DEMOD_MODES, IQ_HALF_SPAN, DemodChain,
    activeWidth, clampOffset, clampWidth, demodSettings, designLowpass, getIQDemod,
    offsetLimits, passbandFor, planFor, resetDemodSettings, saveDemodSettings, tapsFor,
} from '../src/lib/iqDemod.js';

module.exports = {
    deep, render, reset, walk, words,
    DRAG_SLOP_PX, IQ_FFT_SIZE, IQSpectrum, aimCancel, aimDown, aimMove, aimUp, binsToPixels,
    fftInPlace, fractionOffset, hannWindow, newAim, offsetFraction,
    IQPanel, PANEL_BY_ID, GROUPS,
    DEMOD_MODES, IQ_HALF_SPAN, DemodChain,
    activeWidth, clampOffset, clampWidth, demodSettings, designLowpass, getIQDemod,
    offsetLimits, passbandFor, planFor, resetDemodSettings, saveDemodSettings, tapsFor,
};
