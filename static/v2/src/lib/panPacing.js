// Pacing for the pan gesture.
//
// A drag emits a pointermove per frame, and on a 120 Hz phone or a trackpad
// that is well over a hundred requests a second. Each one becomes a command to
// radiod, which takes one command per channel per 20 ms block and drops
// whatever arrives while its queue is busy — silently, with no reply and no
// error anywhere. The poll that fetches each frame of bins competes for those
// same slots, so a fast drag both loses retunes and starves the frames that
// would show them.
//
// The one that matters is the last: it decides where the view ends up. When it
// is the one dropped, the session and the client both believe the new centre
// while the bins keep coming from the old one, and the spectrum is left
// labelled with a frequency it was not measured at.
//
// So the rate is capped and the destination is not. Requests inside the gap
// replace each other rather than queueing, and whatever the gesture last asked
// for is sent when it ends — flush() is not an optimisation, it is the part
// that makes the view land where the finger left it.
//
// The zoom gesture already works this way (SpectrumView's PINCH_MS); this is
// the same idea for the other axis.
//
// Not lib/throttle.js, which the audio commands use and which would very nearly
// do: the difference is that the last value here goes out when the gesture ends
// rather than when a timer next fires, and that the decision is a plain
// function of a record and a clock, so what a whole drag sends can be checked
// without waiting for anything.

// Shortest gap between two pan requests, in ms.
//
// Two radiod blocks, matching the server-side pacer's own gap: sending faster
// than that only fills a queue that will drop the surplus. It is also well
// clear of the 10 Hz the bins themselves arrive at, so the view still follows
// the finger as closely as there is anything new to draw.
export const PAN_MS = 40;

// A fresh pacing record. Kept on the gesture, so a new drag starts unthrottled
// however recently the last one ended... which is deliberate: the first request
// of a gesture always goes out at once, and pressing and dragging again should
// feel the same the second time.
export function newPanPace() {
    return { at: 0, last: null, pending: null };
}

// Offer a centre frequency. Returns the value to send now, or null to hold it.
//
// A request identical to the one already sent is never worth sending twice: the
// server answers it with a status message and nothing else, and during a drag
// the pointer often lands on the same pixel twice in a row.
export function panStep(panPace, centre, now, minGap = PAN_MS) {
    if (centre == null || centre === panPace.last) {
        panPace.pending = null;
        return null;
    }
    if (now - panPace.at >= minGap) {
        panPace.at = now;
        panPace.last = centre;
        panPace.pending = null;
        return centre;
    }
    panPace.pending = centre;
    return null;
}

// End of the gesture: whatever was held back, or null if the last thing asked
// for has already gone out.
export function panFlush(panPace, now = 0) {
    const centre = panPace.pending;
    panPace.pending = null;
    if (centre == null) return null;
    panPace.at = now;
    panPace.last = centre;
    return centre;
}
