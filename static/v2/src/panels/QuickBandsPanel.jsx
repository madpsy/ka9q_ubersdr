// Band buttons, matching v1's band status bar.
//
// Top row: the ten HF amateur bands v1 shows, with the same ranges (app.js
// `bandRanges`) and the same condition colouring — average FT8 SNR over the
// last ten minutes from /api/noisefloor/aggregate, refreshed once a minute,
// bucketed exactly as static/bands_state.js does it.
//
// The conditions themselves are in lib/bandConditions.js, shared with the
// Multipad's band row: one poll, one answer, two panels that cannot disagree.
//
// Bottom row, under a divider: this instance's own quick-tune bands, i.e. the
// entries in /api/bands that the operator gave a `button_name`. v1 renders
// those as a second row too. They carry no conditions data, so they are styled
// neutrally rather than being painted permanently green — the same key, in the
// colour that means "nothing has been said about this band".
//
// Clicking either kind does what v1's setBand() does: tune to the middle of the
// band, take the band's mode (LSB below 10 MHz, USB above, unless the band
// declares one) and zoom the spectrum to the band's width.

import React, { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { HAM_BANDS, tuneToBand } from '../lib/bands.js';
import {
    bandTip, bandTone, getBandConditions, subscribeBandConditions,
} from '../lib/bandConditions.js';

// `minimal` drops the operator's own quick-tune row and leaves the amateur
// bands. See the registry's `minimal`.
export default function QuickBandsPanel({ minimal }) {
    const { tuning, actions, serverInfo, catalog } = useRadio();
    // Shared with the Multipad's band row — see lib/bandConditions.js for why
    // the poll is not this panel's own.
    const [states, setStates] = useState(getBandConditions);

    const conditions = !!(serverInfo && serverInfo.noise_floor);

    useEffect(
        () => (conditions ? subscribeBandConditions(setStates) : undefined),
        [conditions],
    );

    // One tune action for both rows — and the same one the band conditions
    // table uses, see lib/bands.js.
    const go = (min, max, mode) => tuneToBand(actions, min, max, mode);

    const custom = (catalog.bands || []).filter((b) => b.button_name && b.button_name.trim());

    return (
        <div className="stack">
            <div className="chip-row chip-row--wrap chip-row--center">
                {HAM_BANDS.map(([name, min, max]) => {
                    const state = states[name];
                    const active = tuning.frequency >= min && tuning.frequency <= max;
                    return (
                        <button
                            key={name}
                            type="button"
                            title={bandTip(name, state, conditions)}
                            className={`band-btn band-btn--${bandTone(state, conditions)}${active ? ' is-current' : ''}`}
                            onClick={() => go(min, max)}
                        >
                            {name}
                        </button>
                    );
                })}
            </div>

            {!minimal && custom.length > 0 && (
                <>
                    <div className="divider" />
                    <div className="chip-row chip-row--wrap chip-row--center">
                        {custom.map((b) => {
                            const active = tuning.frequency >= b.start && tuning.frequency <= b.end;
                            const tip = [
                                b.label,
                                `${(b.start / 1000).toFixed(1)}–${(b.end / 1000).toFixed(1)} kHz`,
                                b.group ? `Group: ${b.group}` : '',
                                b.mode ? `Mode: ${b.mode.toUpperCase()}` : '',
                            ].filter(Boolean).join('\n');
                            return (
                                <button
                                    key={`${b.button_name}-${b.start}`}
                                    type="button"
                                    title={tip}
                                    /* The same key as the row above, in its
                                       no-conditions colour: these are the same
                                       act — tune to a band — and looked like two
                                       different kinds of control when one row was
                                       keys and the other pills. */
                                    className={`band-btn band-btn--none${active ? ' is-current' : ''}`}
                                    onClick={() => go(b.start, b.end, b.mode)}
                                >
                                    {b.button_name}
                                </button>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
}
