// Entry point for the Olivia panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// ifpanel.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import OliviaExtension from '../src/extensions/olivia/OliviaExtension.jsx';
import { MODES, DEFAULT_MODE, MODE_ID } from '../src/extensions/olivia/modes.js';

module.exports = { deep, render, reset, walk, words, OliviaExtension, MODES, DEFAULT_MODE, MODE_ID };
