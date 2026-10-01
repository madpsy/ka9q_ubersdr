// The output devices this browser will let a page play to, kept current.
//
// Shared by the two places a device is chosen: the Audio panel's Output, for the
// receiver as a whole, and each IQ demodulator's own. Both need the same three
// things done the same way — the list read on mount and again whenever a device
// comes or goes, and the names the browser withholds until microphone
// permission is granted asked for only when somebody presses Refresh or clicks
// the dropdown — so they are here once rather than in each picker.

import { useCallback, useEffect, useRef, useState } from '../react.js';
import { listOutputDevices, micPermission, unlockDeviceLabels } from './audioSinks.js';

/**
 * @param enabled  false where a device cannot be chosen at all, so nothing is
 *                 read and no listener is added.
 * @returns { devices, hidden, perm, error, setError, busy, setBusy, refresh, alive }
 *          `refresh(true)` may ask for the microphone; `refresh(false)` never
 *          does. `alive` is a ref that is false once the caller has unmounted.
 */
export default function useOutputDevices(enabled) {
    const [devices, setDevices] = useState([]);
    const [hidden, setHidden] = useState(false);
    // Whether the microphone has already been asked about — only to tell "nobody
    // has been asked" apart from "asked, granted, and there is still nothing to
    // list", which look the same from here and want opposite advice.
    const [perm, setPerm] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const alive = useRef(true);

    // `unlock` is what separates the button from the mount and the devicechange
    // event: those re-read silently, the button may also ask for the mic. It
    // asks only when there is something to gain — names that are still hidden
    // after the list has been re-read.
    const refresh = useCallback(async (unlock) => {
        try {
            let { devices: found, hidden: anon } = await listOutputDevices();
            if (!alive.current) return;
            micPermission().then((state) => { if (alive.current) setPerm(state); });
            if (anon && unlock) {
                setBusy(true);
                try {
                    await unlockDeviceLabels();
                    if (!alive.current) return;
                    ({ devices: found, hidden: anon } = await listOutputDevices());
                } catch (permErr) {
                    // Denied, or dismissed. The re-read above still stands, so
                    // keep it and say why the names are missing.
                    if (!alive.current) return;
                    setDevices(found);
                    setHidden(anon);
                    setError('Microphone permission denied — device names stay hidden.');
                    return;
                } finally {
                    if (alive.current) setBusy(false);
                }
                if (!alive.current) return;
            }
            setDevices(found);
            setHidden(anon);
            setError('');
        } catch (err) {
            if (alive.current) setError(err.message || 'could not list devices');
        }
    }, []);

    useEffect(() => {
        alive.current = true;
        if (!enabled) return undefined;
        const reread = () => refresh(false);
        reread();
        // Plugging in a headset should not need the panel reopening.
        const md = navigator.mediaDevices;
        md.addEventListener('devicechange', reread);
        return () => {
            alive.current = false;
            md.removeEventListener('devicechange', reread);
        };
    }, [enabled, refresh]);

    return { devices, hidden, perm, error, setError, busy, setBusy, refresh, alive };
}
