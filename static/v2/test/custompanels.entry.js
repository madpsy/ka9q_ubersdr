// One bundle for the custom-panel registry test. Order matters: the React stub
// first (see reactStub.js), then the seeded cache, and only then the registry —
// which reads that cache as it is imported.
import './reactStub.js';
import './panelCacheStub.js';

export { SEEDED } from './panelCacheStub.js';
export { PANELS, PANEL_BY_ID } from '../src/panels/registry.jsx';
export { panelEntry, panelEntries } from '../src/panels/custom/manifest.js';
export { PANEL_ICONS, panelIcon, iconName } from '../src/panels/custom/icons.jsx';
export { cachedPanels, panelIds, panelVersion, refreshPanels, resetPanelCache, startPanelPolling, POLL_MS } from '../src/panels/custom/cache.js';
export { GROUPS, SOLO, groupsFor, ungrouped } from '../src/panels/groups.jsx';
