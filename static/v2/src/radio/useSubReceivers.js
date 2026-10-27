// The extra VFOs' live state, for a panel.
//
// radio/subReceivers.js is plain JS and holds per-VFO signal readings that
// change at the packet rate. Re-rendering on each would be dozens of renders a
// second for a meter nobody reads that fast, so this samples them at `hz`, the
// way useMeters does for the main receiver, and re-renders at once on anything
// structural — a VFO starting or stopping, a socket changing state, a refusal.
//
// Returns { subs, snap }: the engine, for its imperative API (tuneVfo,
// setListening, setOutput, setVolume, setMuted), and its snapshot() — see there
// for the fields.

import { useEffect, useState } from '../react.js';
import { useRadio } from './RadioContext.jsx';
import { getSubReceivers } from './subReceivers.js';
import { getVfoLimit, onVfoLimit } from './session.js';

// What a panel sees before there is a player to hang the engine on — a test, or
// the first render of a page still building its radio: one VFO and nothing heard.
const NO_SUBS = Object.freeze({
    limit: 1, listenBlocked: null, format: 'opus', mainPan: null, vfos: Object.freeze({}),
});

export function useSubReceivers(hz = 8) {
    const { player } = useRadio() || {};
    const subs = getSubReceivers(player);
    const [snap, setSnap] = useState(() => (subs ? subs.snapshot() : NO_SUBS));
    useEffect(() => {
        if (!subs) return undefined;
        const read = () => setSnap(subs.snapshot());
        const off = subs.on('change', read);
        const t = setInterval(read, 1000 / hz);
        read();
        return () => { off(); clearInterval(t); };
    }, [subs, hz]);
    return { subs, snap };
}

/**
 * Whether the stereo field is being shared out between VFOs just now — more
 * than one being heard, and the main receiver not in IQ. While it is, the main
 * receiver's left/right is the VFO routing's and not the channel picker's (see
 * AudioPlayer.setPan). Re-renders only when that changes.
 */
export function useMultiVfoRouting() {
    const { player } = useRadio();
    const subs = getSubReceivers(player);
    const [on, setOn] = useState(() => !!subs && subs.mainPan != null);
    useEffect(() => {
        if (!subs) return undefined;
        const read = () => setOn(subs.mainPan != null);
        read();
        return subs.on('change', read);
    }, [subs]);
    return on;
}

/**
 * The server's VFO count alone, main included — for a control that only needs
 * to know whether listening is on offer at all, and should not re-render at the
 * meter rate useSubReceivers samples at.
 */
export function useVfoLimit() {
    const [n, setN] = useState(getVfoLimit);
    useEffect(() => {
        const off = onVfoLimit(setN);
        setN(getVfoLimit());
        return () => { off(); };
    }, []);
    return n;
}
