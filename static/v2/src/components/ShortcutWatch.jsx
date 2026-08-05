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
import { runFunction } from '../controls/functions.js';
import { comboFor, isTyping, onShortcutSettings, shortcutSettings } from '../lib/shortcuts.js';

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

    useEffect(() => {
        const onKey = (e) => {
            const { settings: s, ctx: c } = live.current;
            if (!s.enabled) return;
            // Whatever is being typed into owns the keyboard.
            if (isTyping(e.target)) return;
            // A held key repeats; a shortcut is a press. Frequency and volume
            // would otherwise run away while the finger was down.
            if (e.repeat) return;

            const fnId = s.bindings[comboFor(e)];
            if (!fnId) return;
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
