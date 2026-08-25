// Entry point for the Olivia panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope, and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// bandstats.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import OliviaExtension from '../src/extensions/olivia/OliviaExtension.jsx';
import { EXTENSION_BY_ID } from '../src/extensions/registry.jsx';
import {
    DEFAULT_MODE, LIMITS, MODES, MODE_ID, OLIVIA_FREQUENCIES, SQUELCH,
    attachParams, modeLabel, modeRates,
} from '../src/extensions/olivia/modes.js';

module.exports = {
    deep, render, reset, walk, words,
    OliviaExtension, EXTENSION_BY_ID,
    DEFAULT_MODE, LIMITS, MODES, MODE_ID, OLIVIA_FREQUENCIES, SQUELCH,
    attachParams, modeLabel, modeRates,
};
