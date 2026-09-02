// Is anybody looking at this page at all?
//
// The other half of lib/useInView.js. That one answers "is this element on
// screen", which a hidden tab does not change: the panel is still laid out where
// it was, the IntersectionObserver has nothing new to say — and in a background
// tab it is not called at all — so a scrolled-to panel in a tab nobody is
// looking at goes on streaming. Backgrounding the app on a phone is the same
// case, and reaches the page the same way: both Android's WebView and iOS's
// WKWebView fire visibilitychange when the app goes to the background.
//
// This is components/VisibilityWatch.jsx as a value rather than an effect. That
// one closes the *spectrum socket* through the radio context, which a panel
// cannot do for its own connection, and the rule it applies is the one wanted
// here: hidden for HIDDEN_SUSPEND_MS and the stream goes, visible again and it
// comes back. Same constant, so a hidden tab drops the main spectrum and this
// panel's stream at the same moment rather than two seconds apart for no reason
// anybody could see.
//
// The grace period is the point — switching tabs to check something and coming
// straight back must not cost a reconnect — and it is lib/visibilityPause.js,
// which is where that countdown and its guards live.

import { useEffect, useState } from '../react.js';
import { HIDDEN_SUSPEND_MS } from '../radio/idle.js';
import { visibilityPause } from './visibilityPause.js';

const hidden = () => typeof document !== 'undefined' && !!document.hidden;

/**
 * @param opts.delayMs  how long the tab has to be hidden before it counts.
 * @returns {boolean}   whether the page is being looked at right now.
 */
export function usePageVisible({ delayMs = HIDDEN_SUSPEND_MS } = {}) {
    // No grace period on the way in, only on the way out: a panel mounted in a
    // tab that is already in the background — a restored session, a page opened
    // in a new tab — should not open a stream for five seconds first. The
    // countdown exists for the tab that goes away *while* something is running.
    const [visible, setVisible] = useState(() => !hidden());

    useEffect(() => {
        const gate = visibilityPause({
            delayMs,
            isHidden: hidden,
            // Nothing else can stop this one: there is no connection underneath
            // that could have dropped on its own, which is what that guard is
            // for in the socket case.
            isOpen: () => true,
            suspend: () => setVisible(false),
            resume: () => setVisible(true),
        });
        const changed = () => {
            // Ahead of the gate, and not only when it is holding one: a page
            // that started hidden has nothing for the gate to resume, because it
            // never suspended anything. Setting the same value again is free.
            if (!hidden()) setVisible(true);
            gate.changed();
        };
        document.addEventListener('visibilitychange', changed);
        // Once at the start: a tab backgrounded before this mounted is already
        // hidden, and no change event is coming.
        changed();
        return () => {
            document.removeEventListener('visibilitychange', changed);
            gate.stop();
        };
    }, [delayMs]);

    return visible;
}

export default usePageVisible;
