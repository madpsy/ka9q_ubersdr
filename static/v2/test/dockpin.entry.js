// Entry point for the pinned-panel test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope, and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// layout.entry.js.
import { render, reset, walk } from './hookStub.js';
import Section from '../src/components/Section.jsx';
import Dock from '../src/components/Dock.jsx';
import { PANEL_BY_ID } from '../src/panels/registry.jsx';
import { canPin, pinnedPanel, PINNABLE } from '../src/lib/dockPin.js';
import { defaultLayout, reconcile } from '../src/layout/LayoutContext.jsx';
import { DEFAULTS } from '../src/display/DisplayContext.jsx';
import { Icon } from '../src/components/icons.jsx';

module.exports = {
    render, reset, walk,
    Section, Dock, PANEL_BY_ID, canPin, pinnedPanel, PINNABLE,
    defaultLayout, reconcile, DEFAULTS, Icon,
};
