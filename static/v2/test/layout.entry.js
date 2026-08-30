// One bundle for the layout test. The stub must come first — see reactStub.js.
import './reactStub.js';

export { defaultLayout, reconcile, insertNear, DOCKS, REV } from '../src/layout/LayoutContext.jsx';
export { PANEL_BY_ID } from '../src/panels/registry.jsx';
// For the one test that has to compare the stored clamp against the measured
// ceiling — they bound the same number and live in different files.
export { dockCeiling } from '../src/lib/dockSize.js';
