// Keeps the rotator and antenna-switch polls running with every panel closed. Renders
// nothing.
//
// The notifications those two raise are about slow physical things that finish after you
// have looked away — see lib/hardwareNotices.js — so they have to be watched whether their
// panels are open or not. That is the whole job: subscribe, and let the store do the rest.
//
// Only where the receiver has the hardware, and only while that source's notifications are
// wanted: switching the rotator off in the Notifications panel stops the polling as well as
// the toasts, because a request a second for something nobody wants to be told about is
// worse than pointless.
//
// The panels subscribe to the same stores, so an open panel does not double the requests —
// there is one poll per subsystem however many things are watching it.

import { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { onNotifications, sourceEnabled } from '../lib/notifications.js';
import { subscribeAntenna, subscribeRotator } from '../lib/hardwareNotices.js';

export default function HardwareNoticeWatch() {
    const { serverInfo } = useRadio();
    // Re-read on any settings change: the switches are in a panel this does not know
    // about, and a store that is subscribed to nothing is a store not polling.
    const [, bump] = useState(0);
    useEffect(() => onNotifications(() => bump((n) => n + 1)), []);

    const hasRotator = !!(serverInfo && serverInfo.rotator && serverInfo.rotator.enabled);
    const hasAntenna = !!(serverInfo && serverInfo.ant_switch && serverInfo.ant_switch.enabled);
    const wantRotator = hasRotator && sourceEnabled('rotator');
    const wantAntenna = hasAntenna && sourceEnabled('antenna');

    // The callback does nothing: subscribing is the point, because that is what starts the
    // poll and the poll is what notices the change.
    useEffect(() => (wantRotator ? subscribeRotator(() => {}) : undefined), [wantRotator]);
    useEffect(() => (wantAntenna ? subscribeAntenna(() => {}) : undefined), [wantAntenna]);

    return null;
}
