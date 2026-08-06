// Which kinds of marker the prev/next controls step between: one chip per kind.
//
// Two controls have prev/next — the Markers panel's step buttons and the ends of
// the Multipad's frequency drum — and both show this picker, over one shared
// selection (lib/markerNavSettings.js). So it takes no props and holds no state:
// there is nothing for a caller to pass that could differ, and a change made
// here reaches the other copy of the picker as it is made.

import React from '../react.js';
import { Field } from './ui.jsx';
import { useNavTypes } from '../lib/useMarkerNav.js';
import { NAV_LABELS } from '../lib/markerNavSettings.js';

export default function NavTypes({ label = 'Skip between' }) {
    const [types, choose] = useNavTypes();

    return (
        /* Every chip can come off, all the way to none — which is how stepping is
           turned off altogether: the drum's ends give their room back to the
           scale and the panel's buttons say what happened. So the state needs
           saying in words, because "no chips lit" and "no feeds running" look
           identical from here. */
        <Field label={label} hint={types.length ? undefined : 'off'}>
            <div className="chip-row chip-row--wrap">
                {Object.entries(NAV_LABELS).map(([t, text]) => (
                    <button
                        key={t}
                        type="button"
                        className={`chip chip--button${types.includes(t) ? ' is-active' : ''}`}
                        onClick={() => choose(
                            types.includes(t) ? types.filter((x) => x !== t) : [...types, t],
                        )}
                    >
                        {text}
                    </button>
                ))}
            </div>
        </Field>
    );
}
