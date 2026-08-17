// Keeps the addon feeds that raise notifications running with their panels closed.
// Renders nothing.
//
// The same job HardwareNoticeWatch does for the rotator and the antenna switch, and it
// exists for the same reason: a panel is unmounted whenever its dock is collapsed, and a
// notification you only get while looking at the panel it came from is not a notification.
//
// Two gates on each, and the second is the one that matters here. Both of these sources
// ship *off* (see NOTICE_SOURCES), so the default state of this component is to hold
// nothing open at all: with the notifications off and the panel closed, nobody is
// subscribed and there is no poll and no stream. Switching one on is what starts it, and
// switching it off is what stops it — the panel, meanwhile, subscribes for its own reasons
// and the stores share one feed per page however many things are watching.

import { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { onNotifications, sourceEnabled } from '../lib/notifications.js';
import { subscribeConfirmedVoice } from '../lib/voiceConfirmed.js';
import { voiceSkimmerAvailable } from '../lib/voiceSkimmer.js';
import { lightningAvailable } from '../lib/lightning.js';
import { subscribeLightning } from '../lib/lightningStream.js';

export default function AddonNoticeWatch() {
    const { serverInfo } = useRadio();
    // Re-read on any settings change: the switches are in a panel this does not know
    // about, and a store that is subscribed to nothing is a store not polling.
    const [, bump] = useState(0);
    useEffect(() => onNotifications(() => bump((n) => n + 1)), []);

    const wantVoice = voiceSkimmerAvailable(serverInfo) && sourceEnabled('voice-callsign');
    const wantLightning = lightningAvailable(serverInfo) && sourceEnabled('lightning');

    // The callbacks do nothing: subscribing is the point, because that is what starts the
    // feed and the feed is what notices something worth saying.
    useEffect(() => (wantVoice ? subscribeConfirmedVoice(() => {}) : undefined), [wantVoice]);
    useEffect(() => (wantLightning ? subscribeLightning(() => {}) : undefined), [wantLightning]);

    return null;
}
