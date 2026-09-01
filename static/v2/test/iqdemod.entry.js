// Entry point for the frontend IQ demodulator's tests.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// drmpanel.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import IQPanel, { ListeningCard, VFO_FALLBACK, vfoSummary } from '../src/panels/IQPanel.jsx';
import { PANEL_BY_ID } from '../src/panels/registry.jsx';
import { GROUPS } from '../src/panels/groups.jsx';
import {
    DRAG_SLOP_PX, IQ_FFT_SIZE, IQSpectrum, MARKER_GRAB_PX, aimCancel, aimDown, aimMove, aimUp,
    binsToPixels, fftInPlace, fractionOffset, hannWindow, markerAt, newAim, offsetFraction,
    squelchLineDb,
} from '../src/lib/iqSpectrum.js';
import {
    DEMOD_MODES, IQ_HALF_SPAN, MAX_VFOS, PANS, SIGNAL_FLOOR_DB, SQUELCH_MAX, SQUELCH_OFF,
    VFO_LABELS, DemodChain, addVfo, clampOffset, clampWidth, collapseVfos, demodSettings,
    designLowpass, expandActiveVfo, getIQDemod, offsetLimits, passbandFor, planFor,
    planForVfo, removeVfo,
    resetDemodSettings, saveDemodSettings, selectVfo, signalMeter, tapsFor, toggleVfo, updateVfo,
    vfoPassband, vfoWidth,
} from '../src/lib/iqDemod.js';

module.exports = {
    deep, render, reset, walk, words,
    DRAG_SLOP_PX, IQ_FFT_SIZE, IQSpectrum, MARKER_GRAB_PX, aimCancel, aimDown, aimMove, aimUp,
    binsToPixels, fftInPlace, fractionOffset, hannWindow, markerAt, newAim, offsetFraction,
    squelchLineDb,
    IQPanel, ListeningCard, VFO_FALLBACK, vfoSummary, PANEL_BY_ID, GROUPS,
    DEMOD_MODES, IQ_HALF_SPAN, MAX_VFOS, PANS, SIGNAL_FLOOR_DB, SQUELCH_MAX, SQUELCH_OFF,
    VFO_LABELS, DemodChain, addVfo, clampOffset, clampWidth, collapseVfos, demodSettings,
    designLowpass, expandActiveVfo, getIQDemod, offsetLimits, passbandFor, planFor,
    planForVfo, removeVfo,
    resetDemodSettings, saveDemodSettings, selectVfo, signalMeter, tapsFor, toggleVfo, updateVfo,
    vfoPassband, vfoWidth,
};
