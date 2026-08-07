// The one place a callsign lookup is announced from. Renders nothing.
//
// It began in the Callsign panel, next to the setting that turns it on, and that was
// wrong twice over:
//
//   Most lookups are not the panel's. Landing on a marker, clicking a spot, an FT8
//   decode, the Media Session fetching artwork for the lock screen — all of those look
//   a callsign up, and the panel only ever announced the ones it made itself.
//
//   A panel is unmounted whenever its dock section is collapsed. An announcer that
//   goes quiet because somebody folded away the panel it is configured in is a puzzle,
//   not a feature — the same reasoning that put AnnounceWatch beside IdleWatch rather
//   than inside the Announcements panel.
//
// So the trigger is the answer itself, from lib/callsign.js, which every route in the
// app passes through. Nothing that asks for a lookup knows this file exists.

import { useEffect } from '../react.js';
import { identified, onLookupAnswer } from '../lib/callsign.js';
import { announceCall } from '../lib/callsignAnnounce.js';

export default function CallsignAnnounceWatch() {
    useEffect(() => onLookupAnswer((call, data) => {
        // Only a lookup that found somebody. A provider that answers a typo with an
        // empty record has not, and announcing that would read out every mistake —
        // see identified().
        if (!identified(data)) return;
        // Off is decided inside, along with which way to say it and whether the same
        // call is already going out. Nothing about that is this file's business.
        announceCall(call);
    }), []);
    return null;
}
