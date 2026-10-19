// Entry point for the SDR Control panel's render test, with a game controller
// chosen. The hook stub first, for the reason ifpanel.entry.js gives.
import { deep, render, rerender, reset, walk, words } from './hookStub.js';
import SDRControlPanel from '../src/panels/SDRControlPanel.jsx';
import { getGamepad } from '../src/controls/sources.js';
import { controlState, updateControlState } from '../src/controls/mappings.js';
import { GAMEPAD_DEFAULT_MAPPINGS } from '../src/controls/gamepad.js';
import { watchSurface } from '../src/controls/dispatch.js';

module.exports = {
    deep, render, rerender, reset, walk, words,
    SDRControlPanel, getGamepad, controlState, updateControlState, GAMEPAD_DEFAULT_MAPPINGS, watchSurface,
};
