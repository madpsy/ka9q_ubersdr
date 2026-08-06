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
// Both rows are the Receiver panel's mode control: the same Segmented, the same
// track, the same keys, each painted by its band's conditions. They were pills
// before, which read as stickers stuck on the panel rather than as part of the
// receiver — and a row of "pick one of these" buttons already has a shape in this
// interface, which is the one the modes use. The Multipad's band row has been that
// all along, so this also stops the app's two rows of bands being two different
// kinds of control.
//
// Clicking either kind does what v1's setBand() does: tune to the middle of the
// band, take the band's mode (LSB below 10 MHz, USB above, unless the band
// declares one) and zoom the spectrum to the band's width.

import React, { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Segmented } from '../components/ui.jsx';
import { HAM_BANDS, bandForFrequency, tuneToBand } from '../lib/bands.js';
import {
    bandTip, bandTone, getBandConditions, subscribeBandConditions,
} from '../lib/bandConditions.js';

// Narrowest a key may be before the row wraps, CSS px.
//
// Between the Multipad's 26 and the mode buttons' 54: "160m" is four characters,
// and this is a dock column rather than a pad squeezing ten bands into one row at
// any cost. At 46 a normal dock takes five to a row, so the ten wrap into a tidy
// two — which is also how they read, the low bands above the high ones.
const BAND_MIN_PX = 46;

// The operator's own bands are named rather than numbered — "Marine", "Airband" —
// so they need the room a word takes.
const CUSTOM_MIN_PX = 66;

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

    // Which key is lit: the band the dial is in above, and below it the entry
    // whose range the dial falls in — identified by the same key the options are
    // built with, because two quick-tune bands may share a name.
    const customKey = (b) => `${b.button_name}-${b.start}`;
    const tunedCustom = custom.find(
        (b) => tuning.frequency >= b.start && tuning.frequency <= b.end,
    );

    return (
        <div className="stack">
            <Segmented
                className="band-keys"
                minItemWidth={BAND_MIN_PX}
                size="sm"
                value={bandForFrequency(tuning.frequency) || ''}
                onChange={(name) => {
                    const b = HAM_BANDS.find(([n]) => n === name);
                    if (b) go(b[1], b[2]);
                }}
                options={HAM_BANDS.map(([name]) => ({
                    value: name,
                    label: name,
                    title: bandTip(name, states[name], conditions),
                    className: `band-key band-key--${bandTone(states[name], conditions)}`,
                }))}
            />

            {!minimal && custom.length > 0 && (
                <>
                    <div className="divider" />
                    <Segmented
                        className="band-keys"
                        minItemWidth={CUSTOM_MIN_PX}
                        size="sm"
                        value={tunedCustom ? customKey(tunedCustom) : ''}
                        onChange={(key) => {
                            const b = custom.find((x) => customKey(x) === key);
                            if (b) go(b.start, b.end, b.mode);
                        }}
                        options={custom.map((b) => ({
                            value: customKey(b),
                            label: b.button_name,
                            title: [
                                b.label,
                                `${(b.start / 1000).toFixed(1)}–${(b.end / 1000).toFixed(1)} kHz`,
                                b.group ? `Group: ${b.group}` : '',
                                b.mode ? `Mode: ${b.mode.toUpperCase()}` : '',
                            ].filter(Boolean).join('\n'),
                            className: 'band-key band-key--none',
                        }))}
                    />
                </>
            )}
        </div>
    );
}
