// The reset beside a filter slider.
//
// Drawn in four places — the Multipad's Width row, the top bar's width popover,
// and both of the Receiver panel's filter fields — for the same reason the width
// slider itself is a component in the Multipad: a button defined inline four
// times is four buttons to keep in step, and this one carries judgements that
// have to come out the same everywhere. What "default" means, and when there is
// nothing left to reset.
//
// ── How much it puts back ───────────────────────────────────────────────────
//
// As much as the view it is in can change, which is not the same answer in all
// four places.
//
// The Multipad and the top bar offer a width and nothing else. A filter can
// still end up shifted there — dragging a passband edge on the spectrum moves
// one edge of an SSB filter, and a bookmark or a shared link carries whatever
// edges it was saved with — and a reset that put the width back and left the
// low edge where it was would leave a filter that reads as its default width
// while sitting somewhere else entirely. So there they restore the whole
// passband: `what` defaults to 'filter', and that is the case to default to.
//
// The Receiver panel has a slider for each of the two numbers, so it asks for
// them separately — 'width' and 'shift'. There, each button moves the slider it
// sits beside and leaves its neighbour alone; a reset that moved a control the
// operator had not pointed at would read as a bug, and anyone wanting the whole
// filter back has the mode buttons a few rows above.
//
// Everything goes through defaultEdges and the edgesFor* pair, which are the
// paths the mode buttons and the sliders themselves take, so none of them can
// disagree about what a default, a width or a shift is.

import React from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Icon } from './ui.jsx';
import {
    defaultEdges, defaultFilterShift, defaultFilterWidth,
    edgesForShift, edgesForWidth, filterShift, isIQ,
} from '../radio/constants.js';

// What each kind of reset is asking for: the edges it would send, whether the
// filter is already there, and how to say so.
function target(what, tuning) {
    const { mode, bandwidthLow: low, bandwidthHigh: high } = tuning;
    if (what === 'width') {
        const want = defaultFilterWidth(mode);
        return {
            edges: edgesForWidth(mode, want, tuning),
            already: Math.round(Math.abs(high - low)) === Math.round(want),
            noun: 'width',
            aria: 'Reset filter width',
            reading: `${(want / 1000).toFixed(2)} kHz`,
        };
    }
    if (what === 'shift') {
        const want = defaultFilterShift(mode);
        return {
            edges: edgesForShift(mode, want, tuning),
            already: Math.round(filterShift(mode, low, high)) === Math.round(want),
            noun: 'shift',
            aria: 'Reset filter shift',
            reading: `${Math.round(want)} Hz`,
        };
    }
    const [wantLow, wantHigh] = defaultEdges(mode);
    return {
        edges: [wantLow, wantHigh],
        already: Math.round(low) === Math.round(wantLow) && Math.round(high) === Math.round(wantHigh),
        noun: 'filter',
        aria: 'Reset filter',
        // Both edges, because both are what this one puts back — and the low one
        // is the part a width reading would not have shown.
        reading: `${wantLow} to ${wantHigh} Hz`,
    };
}

export default function FilterReset({ what = 'filter', className }) {
    const { tuning, actions } = useRadio();
    const { edges, already, noun, aria, reading } = target(what, tuning);

    // Two reasons the button has nothing to do, said the same way. IQ's passband
    // is fixed at the full baseband and setBandwidth refuses to move it at all
    // — see the note there — so a live button would be a lie about what a click
    // does. And a filter already at its default is the ordinary case: the reset
    // is there to be *available*, and should read as spent once it has been used.
    // Rounded because a slider's own step can leave a value a fraction off the
    // figure it displays.
    const iq = isIQ(tuning.mode);
    const label = String(tuning.mode || '').toUpperCase();

    return (
        <Button
            variant="ghost"
            size="sm"
            className={className}
            icon={<Icon.Reset />}
            aria-label={aria}
            title={iq
                ? 'Fixed at the full baseband in IQ'
                : `Back to the ${label} default ${noun} — ${reading}`}
            disabled={iq || already}
            onClick={() => actions.setBandwidth(...edges)}
        />
    );
}
