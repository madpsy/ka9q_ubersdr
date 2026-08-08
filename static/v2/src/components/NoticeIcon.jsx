// A notification wearing the icon of the panel it came from.
//
// The lookup is here rather than in lib/notifications.js because that file is a plain
// store and importing the panel registry into it would have a lib depending on the panels
// that use it. Here it is the components — the toast and the Notifications panel — asking
// the registry a question about a panel, which is what the registry is for.
//
// Nothing when the source has no panel, or names one that is not registered: an icon that
// is not that panel's icon is worse than no icon, because the whole value of it is being
// recognised without being read.

import React from '../react.js';
import { PANEL_BY_ID } from '../panels/registry.jsx';
import { sourcePanel } from '../lib/notifications.js';

export default function NoticeIcon({ source, className = 'notice-icon' }) {
    const panel = PANEL_BY_ID[sourcePanel(source)];
    if (!panel || !panel.icon) return null;
    return <span className={className} aria-hidden="true">{panel.icon}</span>;
}
