// Is this element on screen — not "is it mounted", which is a different question.
//
// For the panels that own a connection rather than a timer. Section only mounts
// a panel's body while its section is open, so collapsing one already closes
// whatever it opened; a hidden panel, a closed sheet and a dock shut to its rail
// are the same case. None of that covers the panel that is open, mounted and
// simply scrolled past: a dock column is taller than the window and a phone's
// stack is much taller, so a panel three screens down is a live stream drawing a
// picture nobody can see, at the server's expense as much as the listener's.
// This is the missing half of that gate, and it reads at the call site the way
// the feed gate does:
//
//     const inView = useInView(wrapRef);
//     useEffect(() => {
//         if (!feeds || !inView) return undefined;
//         …open the stream…
//         return () => …close it…;
//     }, [inView, feeds]);
//
// The intersection is with the viewport, and the browser computes it through
// every scrolling ancestor on the way — so a panel clipped by its dock column
// reads as off screen without this having to know anything about the column.
//
// Leaving is on a countdown and coming back is not, which is lib/visibilityPause.js
// rather than a timer of its own: a hidden tab and an off-screen panel are the
// same problem twice — something expensive nobody can see — and its guards are
// the ones this needs, in particular not arming a second countdown when the
// first is running and re-asking on the way out whether the answer still holds.
// Scrolling from the top of a dock to the bottom takes every panel between the
// two off screen for a few hundred milliseconds, and a stream that closed and
// reopened on each of them would cost more than the one it saved. Coming back
// has no such problem: the panel is being looked at, and the sooner it fills the
// better.
//
// The margin is the other half of that: the stream is already open by the time
// the panel is scrolled to, rather than starting from an empty chart at the
// moment it appears.
//
// Without IntersectionObserver — nothing current, but this is the gate on a
// feature working at all — everything is in view. A missing API is not a reason
// to show somebody a dead panel.

import { useEffect, useState } from '../react.js';
import { visibilityPause } from './visibilityPause.js';

// How long an element has to be off screen before whatever it feeds is stopped.
export const OFF_SCREEN_MS = 2000;

// How far outside the window still counts as on screen. About a panel's height:
// far enough that scrolling one into place finds it already running, near enough
// that the rest of a long column is genuinely stopped.
export const IN_VIEW_MARGIN = '250px';

const supported = () => typeof IntersectionObserver !== 'undefined';

/**
 * @param ref            a ref to the element to watch.
 * @param opts.delayMs   how long off screen before it counts as gone.
 * @param opts.margin    rootMargin for the observer.
 * @returns {boolean}    whether the element is on screen right now.
 */
export function useInView(ref, { delayMs = OFF_SCREEN_MS, margin = IN_VIEW_MARGIN } = {}) {
    // Starts false where there is an observer to answer the question, because
    // the answer arrives before the first frame is drawn: a panel that mounts
    // below the fold then never opens its stream at all, rather than opening one
    // and closing it two seconds later. Where there is no observer it starts
    // true and stays there.
    const [inView, setInView] = useState(() => !supported());

    useEffect(() => {
        const el = ref.current;
        if (!el || !supported()) return undefined;
        let visible = false;

        const gate = visibilityPause({
            delayMs,
            isHidden: () => !visible,
            // Nothing else can stop this one: there is no connection underneath
            // that could have dropped on its own, which is what that guard is
            // for in the socket case.
            isOpen: () => true,
            suspend: () => setInView(false),
            resume: () => setInView(true),
        });

        const io = new IntersectionObserver((entries) => {
            // The last entry is where it ended up: an observer can deliver
            // several at once after a scroll, and only the latest counts.
            if (entries.length) visible = entries[entries.length - 1].isIntersecting;
            // Ahead of the gate, and not only when it is holding one: the very
            // first callback is how a panel that mounted on screen learns it is
            // there, and the gate has nothing to resume at that point because it
            // never suspended anything. Setting the same value again is free.
            if (visible) setInView(true);
            gate.changed();
        }, { rootMargin: margin });

        io.observe(el);
        return () => {
            gate.stop();
            io.disconnect();
        };
    }, [ref, delayMs, margin]);

    return inView;
}

export default useInView;
