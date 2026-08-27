// The reset beside the wheel-spin slider.
//
// Drawn in two places — the popover the spectrum toolbar's wheel button opens,
// and the Display panel's field — and a component rather than a button written
// out twice for the reason FilterReset gives at more length: the two judgements
// in here have to come out the same in both, and an inline copy is a second
// place for them to drift.
//
// The judgements are what "default" is and when there is nothing left to do.
// Both are the same question asked of lib/wheelStep.js, which is also what the
// wheel itself asks, so the button and the behaviour cannot disagree about which
// rung is home.

import React from '../react.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { Button, Icon } from './ui.jsx';
import { WHEEL_ACCEL_DEFAULT, nearestWheelAccel, wheelAccelLabel } from '../lib/wheelStep.js';

export default function WheelAccelReset({ className }) {
    const d = useDisplay();
    // Through nearestWheelAccel rather than compared raw: a stored value off the
    // ladder is what the wheel would actually use, so it is what "already there"
    // has to be judged against — otherwise a setting the wheel treats as the
    // default would leave the button live with nothing to put back.
    const already = nearestWheelAccel(d.wheelAccel) === WHEEL_ACCEL_DEFAULT;

    return (
        <Button
            variant="ghost"
            size="sm"
            className={className}
            icon={<Icon.Reset />}
            aria-label="Reset wheel spin"
            title={`Back to the default — ${wheelAccelLabel(WHEEL_ACCEL_DEFAULT).toLowerCase()}`}
            // Spent once it has been used, which is the state a reset should
            // read as: it is here to be *available*, and a live button that
            // would change nothing says the setting is somewhere it is not.
            disabled={already}
            onClick={() => d.set({ wheelAccel: WHEEL_ACCEL_DEFAULT })}
        />
    );
}
