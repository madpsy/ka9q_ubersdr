// The timeshift buffer as React sees it: re-renders on every transport change,
// and ticks at `hz` while there is something moving to watch: when not live the
// distance behind moves (a pause falls further behind every second), and while
// live the scrub bar's level trace scrolls.
//
// `whileLive` false ticks only while replaying, which is all a badge needs.

import { useEffect, useReducer } from '../react.js';
import { getTimeshift, tuningDiffers } from './timeshift.js';
import { formatFilterWidth } from './format.js';

export default function useTimeshift(hz = 4, whileLive = true) {
    const ts = getTimeshift();
    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => ts.on('change', bump), [ts]);

    const ticking = ts.enabled && (ts.replaying || whileLive);
    useEffect(() => {
        if (!ticking) return undefined;
        const t = setInterval(bump, 1000 / hz);
        return () => clearInterval(t);
    }, [ticking, hz]);

    return ts;
}

// "-12.4 s" — tenths below ten seconds, where a skip of a few seconds is
// visible, and whole seconds above it, where the tenths only flicker.
export function formatBehind(ms) {
    const s = ms / 1000;
    return `−${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

/**
 * What a replayed moment was tuned to, in as few words as tell it apart from
 * the dial now — '' when it is the same. The frequency and mode when either
 * moved ("7074 kHz USB"); the filter width alone when only the passband did
 * ("2.70k"), since repeating a frequency the dial already shows says nothing.
 */
export function tuningNote(then, now) {
    if (!then || !now || !tuningDiffers(then, now)) return '';
    if (then.frequency !== now.frequency || then.mode !== now.mode) {
        const khz = Number((then.frequency / 1e3).toFixed(2));
        return `${khz} kHz ${String(then.mode || '').toUpperCase()}`.trim();
    }
    return formatFilterWidth(then.bandwidthLow, then.bandwidthHigh);
}
