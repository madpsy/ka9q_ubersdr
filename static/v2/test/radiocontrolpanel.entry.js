// Entry point for the Radio Control panel's render test. The hook stub first,
// for the reason ifpanel.entry.js gives.
import { deep, render, reset, walk, words } from './hookStub.js';
import RadioControlPanel from '../src/panels/RadioControlPanel.jsx';
import ControlWatch from '../src/components/ControlWatch.jsx';
import { updateControlState, controlState } from '../src/controls/mappings.js';
import { registerProvider, setProviderStatus, resetProviders } from '../src/controls/radioProviders.js';
import { getSync } from '../src/controls/sources.js';

module.exports = {
    deep, render, reset, walk, words,
    RadioControlPanel, ControlWatch, updateControlState, controlState,
    registerProvider, setProviderStatus, resetProviders, getSync,
};
