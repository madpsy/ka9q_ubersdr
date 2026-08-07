// The one keyboard listener. Renders nothing.
//
// v1 had four document-level keydown handlers between app.js, bands_state.js,
// rmnoise.js and pages-menu.js, two of which bound the number keys and both of
// which fired — so every band press called setBand twice. There is one here,
// and it dispatches through the same runFunction the MIDI surface and the
// FlexControl dial use, with the same context object, so a key and a knob
// bound to the same function take the same path.
//
// Mounted in App beside IdleWatch and AnnounceWatch: shortcuts have to work
// whether or not the Shortcuts panel is open, and that panel is unmounted
// whenever it is collapsed.

import { useEffect, useRef, useState } from '../react.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { useControlContext } from '../controls/panel.jsx';
import { functionRepeats, runFunction } from '../controls/functions.js';
import {
    comboFor, isTyping, keysClaimed, onShortcutSettings, shortcutSettings,
} from '../lib/shortcuts.js';

// Shortest gap between two firings of a held key.
//
// The browser's own auto-repeat is roughly 30 a second once it starts, which is
// faster than the receiver has any use for — RadioContext already coalesces
// tune commands at 70 ms, so anything quicker is thrown away downstream. 50 ms
// is deliberately at the low end: a held key walking the dial should feel like
// turning it, and a tuning step that lags behind the finger is worse than one
// that occasionally outruns the wire.
const REPEAT_MS = 50;

export default function ShortcutWatch() {
    const display = useDisplay();
    // The same facade the control surfaces get, so `freq_step_up` steps by the
    // size shown in the Receiver panel rather than a number of its own.
    const ctx = useControlContext(display.tuneStep || 500);
    const [settings, setSettings] = useState(shortcutSettings);
    useEffect(() => onShortcutSettings(setSettings), []);

    // Read by the listener, which is registered once: re-registering on every
    // rebind would drop a keystroke landing in the gap.
    const live = useRef({ settings, ctx });
    live.current = { settings, ctx };
    // When each function last ran, for the repeat rate limit. Per function
    // rather than per key, so holding one key while tapping another bound to
    // the same thing cannot double the rate.
    const lastRun = useRef({});

    useEffect(() => {
        const onKey = (e) => {
            const { settings: s, ctx: c } = live.current;
            if (!s.enabled) return;
            // Something on screen is using the keyboard itself — the Morse
            // trainer, typing answers. See claimKeys.
            if (keysClaimed()) return;
            // Whatever is being typed into owns the keyboard.
            if (isTyping(e.target)) return;

            const fnId = s.bindings[comboFor(e)];
            if (!fnId) return;

            // A held key only keeps going for the functions that say they are
            // worth holding — walking the dial, fading the volume. Everything
            // else fires once per press: a held U setting USB thirty times a
            // second achieves nothing, and a held band key would fight the
            // dial. See functionRepeats.
            if (e.repeat) {
                if (!functionRepeats(fnId, c.state().dsp.schemas)) {
                    // Still claimed: the key is bound, so the browser must not
                    // also act on it while it is held.
                    e.preventDefault();
                    return;
                }
                const now = Date.now();
                if (now - (lastRun.current[fnId] || 0) < REPEAT_MS) { e.preventDefault(); return; }
                lastRun.current[fnId] = now;
            } else {
                lastRun.current[fnId] = Date.now();
            }

            // Claimed only once there is something to run, so an unbound key
            // still reaches the browser.
            e.preventDefault();
            runFunction(fnId, { kind: 'trigger' }, c);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    return null;
}
