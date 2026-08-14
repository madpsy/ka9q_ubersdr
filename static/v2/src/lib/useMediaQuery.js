import { useEffect, useState } from '../react.js';

export function useMediaQuery(query) {
    const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
        const mq = window.matchMedia(query);
        const onChange = (e) => setMatches(e.matches);
        mq.addEventListener('change', onChange);
        setMatches(mq.matches);
        return () => mq.removeEventListener('change', onChange);
    }, [query]);
    return matches;
}

// The breakpoint at which side docks stop fitting alongside a usable spectrum.
export const MOBILE_QUERY = '(max-width: 900px)';

// Is there a finger available, wherever the primary pointer is?
//
// `any-pointer`, not `pointer`: on a convertible laptop or a touchscreen monitor
// the primary pointer is the mouse, so `pointer: coarse` says no — and the
// question being asked is not "how is this driven" but "can this be poked". A
// control that only earns its place under a fingertip, like the Multipad's
// barrels, wants the second question. Same reasoning as hapticsSupported().
//
// True on every phone and tablet as well, so callers that mean "touch but not a
// handset" have to say `!MOBILE_QUERY && TOUCH_QUERY` — which is exactly the
// machine that has room for docks and a screen worth spinning a drum on.
export const TOUCH_QUERY = '(any-pointer: coarse)';

// Is a finger the *usual* way this machine is driven?
//
// `pointer`, not `any-pointer`, and deliberately the opposite choice from the
// query above — because the question is different. That one asks whether
// something can be poked at all, which is what a control designed for a
// fingertip needs to know. This one asks what to *call* the gesture, and a
// convertible laptop with a mouse plugged in should still be told to click
// even though it could be poked.
export const PRIMARY_TOUCH_QUERY = '(pointer: coarse)';

// Can a pointer be rested on something here?
//
// `hover`, not `any-hover`, and not the inverse of TOUCH_QUERY: the question is
// about the pointer being used, not about one being available somewhere. A
// touchscreen laptop hovers with its trackpad and answers yes; a tablet has no
// way to rest a pointer on anything and answers no, whatever its screen size —
// which is the case this exists for, because a tablet is wide enough to get the
// desktop layout and its docks, and none of the hover behaviour in them.
//
// `pointer: fine` as well, because this is the gate on the dock peek and a peek
// opened by a coarse pointer closes itself: the pointerenter arrives on the same
// tap that is already toggling the dock. Named here rather than written out at
// each site so the control that offers the setting and the code that acts on it
// cannot come to disagree about where it applies.
export const HOVER_QUERY = '(hover: hover) and (pointer: fine)';

// A handset turned on its side: wide enough, and nothing like tall enough.
//
// Keyed on the height, because height is the thing that has run out — a phone
// in landscape has about 390 CSS px of it, against 800 the other way up, and
// every fixed row costs more than a tenth of the screen. The orientation test is
// there to keep a merely short desktop window out of it; the height is what
// decides. 560 rather than 500 covers the taller handsets in landscape without
// reaching an ordinary portrait phone.
export const LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 560px)';
