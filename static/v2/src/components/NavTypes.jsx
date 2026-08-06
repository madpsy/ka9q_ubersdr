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
        <Field label={label}>
            <div className="chip-row chip-row--wrap">
                {Object.entries(NAV_LABELS).map(([t, text]) => (
                    <button
                        key={t}
                        type="button"
                        className={`chip chip--button${types.includes(t) ? ' is-active' : ''}`}
                        /* The last one on cannot be turned off — see
                           saveNavTypes, which refuses an empty selection. Said
                           here as well, because a chip that ignores a press
                           without saying why is the worse half of that rule. */
                        title={types.length === 1 && types.includes(t)
                            ? 'The last kind selected — something has to be steppable'
                            : undefined}
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
