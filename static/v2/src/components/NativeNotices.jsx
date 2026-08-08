// Hands notifications to the browser, for the ones the store marked for the desktop.
//
// The other half of Toasts.jsx, and mounted beside it for the same reason: App mounts it once
// and never unmounts it, so a notification does not depend on which panels happen to be open.
//
// It renders nothing. Everything it does happens outside the page — which is the point, since
// the notifications worth having arrive while the tab is behind something else.
//
// The decision of *where* a notification goes is not made here: pushNotification makes it once
// and marks the item (see deliveryFor). This obeys the mark. Two renderers each deciding for
// themselves would eventually disagree, and the way they would disagree is a notification that
// neither of them showed.

import { useEffect, useRef } from '../react.js';
import { useLayout } from '../layout/LayoutContext.jsx';
import { onNotifications, sourcePanel } from '../lib/notifications.js';
import { showNative } from '../lib/nativeNotices.js';

export default function NativeNotices() {
    const { revealPanel } = useLayout();
    // Which ids have been handed over. The store's history is a rolling list that is re-sent in
    // full on every change, so without this every notification would be shown again each time
    // the next one arrived.
    const shown = useRef(new Set());
    // Kept so a click can find its way to the right panel without this component re-subscribing
    // whenever the layout changes.
    const reveal = useRef(revealPanel);
    reveal.current = revealPanel;

    useEffect(() => onNotifications(({ history }) => {
        // Oldest first, so a burst arrives in the order it happened rather than reversed.
        for (const item of [...history].reverse()) {
            if (!item.native || shown.current.has(item.id)) continue;
            shown.current.add(item.id);
            showNative(item, (n) => {
                // Clicking one takes you to the panel it came from — the rotator popup to the
                // rotator, a mention to chat. That is the answer to "what do I do about this",
                // and it is why a notification names its source at all.
                const panel = sourcePanel(n.source);
                if (panel) reveal.current(panel);
            });
        }
        // The store keeps fifty; anything below that has long since been handed over or
        // dropped, so the set has no reason to grow past a session's worth.
        if (shown.current.size > 500) shown.current.clear();
    }), []);

    return null;
}
