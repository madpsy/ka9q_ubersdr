// One listener that gives every button in the app its haptic tap.
//
// The alternative was a call in each control primitive and each panel that
// builds its own button, which is forty files and a standing invitation to
// forget one. A single delegated pointerdown at the document sees them all —
// including panels that are not mounted yet, extensions loaded later, and the
// legacy v1 markup the bridge renders — and decides from the element itself
// what it is worth (lib/haptics.js: hapticKindFor).
//
// pointerdown rather than click, because the pulse has to arrive when the
// finger lands. A click fires on release, ~100 ms later on a phone, by which
// point it reads as a response to the action rather than as the press.
//
// Capture phase, so a control that stops propagation — menus and popovers do —
// is still felt.
//
// Renders nothing.

import { useEffect } from '../react.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { haptic, hapticKindFor, setHapticMode, setHapticScopes } from '../lib/haptics.js';

export default function HapticWatch() {
    const d = useDisplay();
    const mode = d.haptics;
    // The two scopes are separate switches, so somebody who finds buzzing
    // buttons fussy can still have the waterfall talk back — see lib/haptics.js.
    const ui = d.hapticButtons !== false;
    const spectrum = d.hapticSpectrum !== false;

    // Pushed into the module rather than read from context by the callers: the
    // spectrum's gesture handlers and this listener both run outside React's
    // render path and must not re-subscribe to find out whether to buzz.
    useEffect(() => { setHapticMode(mode); }, [mode]);
    useEffect(() => { setHapticScopes({ ui, spectrum }); }, [ui, spectrum]);

    useEffect(() => {
        // Mouse presses are not felt and would only spend the rate limit. Touch
        // and pen are; a stylus on a tablet is still a finger as far as the
        // vibrator is concerned.
        const onDown = (e) => {
            if (e.pointerType === 'mouse') return;
            const kind = hapticKindFor(e.target);
            // 'ui' for all of them: this listener only ever sees controls. The
            // spectrum's own canvas is not pressable, so its gestures reach
            // haptic() themselves with the other scope.
            if (kind) haptic(kind, 'ui');
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
    }, []);

    return null;
}
