// The extra VFOs' lifetime, kept away from any panel.
//
// The engine in radio/subReceivers.js plays the VFOs listened to alongside the
// main receiver, and it has the page's lifetime for the reason every watcher in
// App.jsx does: the panel that shows them is unmounted whenever its dock is
// collapsed, and a VFO that stopped playing when somebody folded the panel away
// would be a strange way for listening to end. It draws nothing. What it pushes
// in is what the engine cannot see for itself:
//
//   running, open   the receiver is on; the main audio socket is open. The
//                   server only accepts secondaries beside a live primary.
//   tuning          the main receiver's mode and filter, which every listening
//                   VFO plays in (the mode lock), and its frequency for the
//                   stereo placement. IQ ends listening altogether.
//   format          the main socket's audio format, which every secondary
//                   connects in — read off the connection itself, since that
//                   is what the socket asked for, recorder hold included.
//   threshold       the one squelch threshold every stream shares.
//   held            a recording being played back (lib/playbackHold.js).
//
// TX silence needs nothing from here: the voices end on the player's subOutput,
// which follows setTxSilenced itself.
//
// A refusal ("This receiver allows N VFOs") is raised once as a notification.
// Nothing else a secondary does reaches the operator except through its row —
// see the note on errors in subReceivers.js.

import { useEffect } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { getSubReceivers } from '../radio/subReceivers.js';
import { usePlaybackHold } from '../lib/playbackHold.js';
import { pushNotification } from '../lib/notifications.js';

export default function SubReceiversWatch() {
    const { running, audioState, tuning, squelch, player, view, actions, audio, audioConn } = useRadio();
    const subs = getSubReceivers(player);
    const held = usePlaybackHold();

    // Only read when a VFO starts listening, to seed an unused slot from live.
    useEffect(() => {
        subs.setRadio({ tuning, view, actions });
    }, [subs, tuning, view, actions]);

    const threshold = squelch.enabled ? squelch.threshold : null;
    // RadioContext writes audio.format from the connection in the same step
    // that reopens it, so this re-renders with the new one.
    const format = (audioConn && audioConn.format) || (audio && audio.format) || 'opus';
    useEffect(() => {
        subs.update({ running, open: audioState === 'open', tuning, threshold, held, format });
    }, [subs, running, audioState, tuning, threshold, held, format]);

    useEffect(() => subs.on('refused', ({ id, message }) => {
        pushNotification({
            key: 'vfo-refused',
            severity: 'warn',
            title: `VFO ${id} not available`,
            body: message,
        });
    }), [subs]);

    return null;
}
