// Entry point for the Scanner panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// vfospanel.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import ScannerPanel from '../src/panels/ScannerPanel.jsx';
import { _resetScanSettings, saveScanSettings, savedScanSettings } from '../src/lib/scannerSettings.js';
import { PANEL_BY_ID } from '../src/panels/registry.jsx';
import { GROUPS } from '../src/panels/groups.jsx';
import { defaultLayout } from '../src/layout/LayoutContext.jsx';

module.exports = {
    deep, render, reset, walk, words,
    ScannerPanel, _resetScanSettings, saveScanSettings, savedScanSettings,
    PANEL_BY_ID, GROUPS, defaultLayout,
};
