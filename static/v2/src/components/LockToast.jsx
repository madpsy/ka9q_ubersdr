// "Tuning locked", over the bottom of the page, when a press was refused.
//
// A portal into <body> for the same reason the notification toasts are one: the
// refusal can come from a docked panel, a floating window, a control surface or
// the bridge, and a message rendered inside whichever of those asked would be
// clipped to it.
//
// Bottom centre, and fixed there rather than following the operator's
// notification placement. It is not one of those — see lib/tuneLock.js — and it
// wants to be somewhere the eye goes after a gesture that did nothing, which on
// every screen size is below the thing that was pressed. It sits above the
// notification layer's z-index so the one case where they share a corner is
// resolved in favour of the transient one.

import React, { ReactDOM, useEffect, useState } from '../react.js';
import { Icon } from './ui.jsx';
import { lockToastVisible, onLockToast } from '../lib/tuneLock.js';

export default function LockToast() {
    const [show, setShow] = useState(lockToastVisible);

    useEffect(() => onLockToast(setShow), []);

    if (!show) return null;

    return ReactDOM.createPortal(
        // `role="status"` rather than an alert: a screen reader should mention
        // it when it has finished the sentence it is on, not interrupt to say
        // that a button did nothing.
        <div className="lock-toast" role="status" aria-live="polite">
            {/* Two lines, and the split is what the toast is for: the first says
                what happened, the second says what to do about it. Somebody who
                already knows reads one word and looks away; somebody who does
                not — the operator who locked it half an hour ago, or the one who
                did it by accident — needs telling where the switch is, and a
                message that leaves them hunting for it is half a message.
                
                The padlock sits on the first line rather than the second so the
                glyph is beside the state it names, and because the second line
                already names it in words. */}
            <div className="lock-toast__head">
                <span>Tuning Locked</span>
                <Icon.Lock size={15} />
            </div>
            <div className="lock-toast__hint">Press padlock above waterfall</div>
        </div>,
        document.body,
    );
}
