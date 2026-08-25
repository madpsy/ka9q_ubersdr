// Entry point for the Audio scope panel's render test.
//
// hookStub first and for its side effect: src/react.js reads window.React at
// module scope and a bundler hoists module bodies above inline code, so it has
// to be in place before anything that leads there. Same rule as
// ifpanel.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import ScopePanel from '../src/panels/ScopePanel.jsx';
import { DEFAULTS } from '../src/display/DisplayContext.jsx';

module.exports = { deep, render, reset, walk, words, ScopePanel, DEFAULTS };
