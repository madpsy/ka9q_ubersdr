// The reset beside a filter slider.
//
// Drawn in four places — the Multipad's Width row, the Receiver panel's Filter
// width and Filter shift fields, and the top bar's width popover — for the same
// reason the width slider itself is a component in the Multipad: a button
// defined inline four times is four buttons to keep in step, and this one
// carries two judgements that have to come out the same everywhere. What
// "default" means, and when there is nothing left to reset.
//
// Each one puts back only the number its own slider sets: a width reset keeps
// whatever shift is in force, and a shift reset keeps the width. A reset sitting
// beside one slider resets that slider — in the Receiver panel the two are
// stacked one above the other, and moving both from either would be a control
// changing without being touched. Both go through the edgesFor* pair, which is
// the path the sliders themselves take, so none of them can disagree about what
// a width or a shift is.

import React from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Icon } from './ui.jsx';
import {
    defaultFilterShift, defaultFilterWidth, edgesForShift, edgesForWidth, filterShift, isIQ,
} from '../radio/constants.js';

export default function FilterReset({ what = 'width', className }) {
    const { tuning, actions } = useRadio();
    const shift = what === 'shift';

    const now = shift
        ? filterShift(tuning.mode, tuning.bandwidthLow, tuning.bandwidthHigh)
        : Math.abs(tuning.bandwidthHigh - tuning.bandwidthLow);
    const want = shift ? defaultFilterShift(tuning.mode) : defaultFilterWidth(tuning.mode);

    // Two reasons the button has nothing to do, said the same way. IQ's passband
    // is fixed at the full baseband and setBandwidth refuses to move it at all
    // — see the note there — so a live button would be a lie about what a click
    // does. And a filter already at its default is the ordinary case: the reset
    // is there to be *available*, and it should read as spent once it has been
    // used. Rounded because a slider's own step can leave a value a fraction off
    // the figure it displays.
    const iq = isIQ(tuning.mode);
    const already = Math.round(now) === Math.round(want);
    const reading = shift ? `${Math.round(want)} Hz` : `${(want / 1000).toFixed(2)} kHz`;
    const label = String(tuning.mode || '').toUpperCase();

    return (
        <Button
            variant="ghost"
            size="sm"
            className={className}
            icon={<Icon.Reset />}
            aria-label={shift ? 'Reset filter shift' : 'Reset filter width'}
            title={iq
                ? 'Fixed at the full baseband in IQ'
                : `Back to the ${label} default — ${reading}`}
            disabled={iq || already}
            onClick={() => actions.setBandwidth(...(shift
                ? edgesForShift(tuning.mode, want, tuning)
                : edgesForWidth(tuning.mode, want, tuning)))}
        />
    );
}
