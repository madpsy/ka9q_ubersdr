// Entry point for the Layout panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope, and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// layout.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import LayoutPanel from '../src/panels/LayoutPanel.jsx';
import { PANELS, PANEL_BY_ID } from '../src/panels/registry.jsx';
import { DEFAULTS } from '../src/display/DisplayContext.jsx';
import { GROUPS, SOLO, allGroupsFor } from '../src/panels/groups.jsx';

module.exports = {
    deep, render, reset, walk, words,
    LayoutPanel, PANELS, PANEL_BY_ID, DEFAULTS, GROUPS, SOLO, allGroupsFor,
};
