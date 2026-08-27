// "Tuning locked", over the middle of the page, when a press was refused — and
// "Tuning unlocked" when the lock comes off again.
//
// A portal into <body> for the same reason the notification toasts are one: the
// refusal can come from a docked panel, a floating window, a control surface or
// the bridge, and a message rendered inside whichever of those asked would be
// clipped to it.
//
// Centred, and fixed there rather than following the operator's notification
// placement. It is not one of those — see lib/tuneLock.js — and it wants to be
// somewhere the eye goes after a gesture, which on every screen size is not the
// corner they filed their notifications into. It sits above the notification
// layer's z-index so the one case where they share a corner is resolved in
// favour of the transient one.

import React, { ReactDOM, useEffect, useState } from '../react.js';
import { Icon } from './ui.jsx';
import { lockToastState, onLockToast } from '../lib/tuneLock.js';

export default function LockToast() {
    const [state, setState] = useState(lockToastState);

    useEffect(() => onLockToast(setState), []);

    if (!state) return null;

    const locked = state === 'locked';

    return ReactDOM.createPortal(
        // `role="status"` rather than an alert: a screen reader should mention
        // it when it has finished the sentence it is on, not interrupt to say
        // that a button did nothing.
        <div
            className={`lock-toast${locked ? '' : ' lock-toast--open'}`}
            role="status"
            aria-live="polite"
        >
            {/* Locked gets two lines, and the split is what the toast is for: the
                first says what happened, the second says what to do about it.
                Somebody who already knows reads one word and looks away;
                somebody who does not — the operator who locked it half an hour
                ago, or the one who did it by accident, or the one whose MIDI
                button did it — needs telling where the switch is, and a message
                that leaves them hunting for it is half a message.

                Unlocked gets one line and no directions. It is the end of a
                state rather than the start of one: nothing is being refused,
                there is nothing to go and undo, and a second line pointing at a
                padlock would be telling the operator how to get back into the
                condition they just left.

                The padlock sits on the first line either way, so the glyph is
                beside the state it names. */}
            <div className="lock-toast__head">
                <span>{locked ? 'Tuning Locked' : 'Tuning Unlocked'}</span>
                {locked ? <Icon.Lock size={15} /> : <Icon.Unlock size={15} />}
            </div>
            {locked && <div className="lock-toast__hint">Press padlock above waterfall</div>}
        </div>,
        document.body,
    );
}
