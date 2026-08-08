// Keeps the "Most used" leaderboard counting with its panel closed. Renders nothing.
//
// The clock used to live in the panel, which meant the leaderboard only counted the time you
// spent with the panel open — and a side dock spends most of its life collapsed, which
// unmounts everything in it. So a list of where the dial actually sits was being built from
// whatever fraction of the session that panel happened to be on screen, which is the one
// thing it must not be.
//
// Here for the same reason the announcers and the hardware polls are here: App mounts this
// once and never unmounts it. All it does is tell the store what the receiver is doing; the
// timing, the crediting and the storing are all in lib/topFreq.js.

import { useEffect } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { trackDwell } from '../lib/topFreq.js';

export default function TopFreqWatch() {
    const { running, tuning } = useRadio();
    const hz = Math.round(tuning.frequency || 0);
    const mode = tuning.mode || '';

    // Three things, and any of them changing starts a new stay — including `running`, because
    // a minute with the audio stopped is a minute nobody spent listening.
    useEffect(() => {
        trackDwell({ running, hz, mode });
    }, [running, hz, mode]);

    return null;
}
