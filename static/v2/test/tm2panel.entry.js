// Entry point for the SDR Control panel's render test with the ELAD TM-2
// chosen. The hook stub first, for the reason ifpanel.entry.js gives.
import { deep, render, reset, walk, words } from './hookStub.js';
import SDRControlPanel from '../src/panels/SDRControlPanel.jsx';
import { controlState, updateControlState } from '../src/controls/mappings.js';

module.exports = {
    deep, render, reset, walk, words, SDRControlPanel, controlState, updateControlState,
};
