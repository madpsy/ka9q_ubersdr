// All four VFOs at once.
//
// The Receiver panel already has a VfoBar — four buttons, A to D, with the
// frequency each holds in its tooltip. That is the right control when you are
// tuning: it switches, and it costs one row. It is the wrong thing for the
// question this panel answers, which is "where are my four?" — a tooltip shows
// one at a time and only to a mouse, and comparing two of them means hovering
// each in turn and remembering.
//
// So this is the same four VFOs laid out rather than collapsed: frequency, mode
// and filter width for each, with the one in use marked. Clicking a row switches
// to it, which is the same selectVfo the buttons, the spectrum's right-click
// menu and a MIDI mapping all call — a VFO must be switched exactly one way or
// two of them disagree about what "B" holds.

import React, { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { VFO_IDS, getVfos, onVfosChanged, selectVfo } from '../lib/vfos.js';
import { formatFilterWidth, formatHz } from '../lib/format.js';
import { bandForFrequency } from '../lib/bands.js';

/**
 * What each slot holds, with the active one taken from live tuning.
 *
 * lib/vfos.js deliberately leaves the active slot's stored copy stale — while a
 * VFO is selected the live receiver *is* that VFO, and the store is written only
 * when you switch away, which saves a write on every turn of the dial. Reading
 * the store for the active slot would show wherever the dial was when it was
 * last selected, which is the one row guaranteed to be wrong.
 */
function rowsFor(vfos, tuning) {
    return VFO_IDS.map((id) => {
        const active = vfos.active === id;
        const s = active ? tuning : vfos.slots[id];
        if (!s || !(s.frequency > 0)) return { id, active, empty: true };
        return {
            id,
            active,
            empty: false,
            frequency: s.frequency,
            mode: (s.mode || '').toUpperCase(),
            width: formatFilterWidth(s.bandwidthLow, s.bandwidthHigh),
            band: bandForFrequency(s.frequency),
        };
    });
}

export default function VfosPanel({ minimal }) {
    const radio = useRadio();
    const { tuning } = radio;
    // Not `setVfos`: lib/vfos.js exports one of those and it *writes the
    // store*. This only mirrors it into local state.
    const [vfos, setLocal] = useState(getVfos);

    useEffect(() => onVfosChanged(setLocal), []);

    const rows = rowsFor(vfos, tuning);

    return (
        <div className="stack stack--tight">
            <div className="vfos">
                {rows.map((v) => (
                    <button
                        key={v.id}
                        type="button"
                        className={`vfos__row${v.active ? ' is-active' : ''}`}
                        aria-pressed={v.active}
                        // An unused slot takes a copy of what is live rather than
                        // doing nothing, which is what the Receiver panel's
                        // buttons do and what a radio does.
                        title={v.active
                            ? `VFO ${v.id} — in use`
                            : v.empty
                                ? `Switch to VFO ${v.id} — unused, so it takes the current settings`
                                : `Switch to VFO ${v.id}`}
                        onClick={() => selectVfo(radio, v.id)}
                    >
                        <span className="vfos__id">{v.id}</span>
                        {v.empty ? (
                            <span className="vfos__empty">unused</span>
                        ) : (
                            <>
                                <span className="vfos__freq">{formatHz(v.frequency)}</span>
                                <span className="vfos__mode">{v.mode}</span>
                                {/* The filter width and the band are what a
                                    narrow dock loses first: they qualify the
                                    frequency rather than being it. */}
                                {!minimal && v.width && <span className="vfos__width">{v.width}</span>}
                                {!minimal && v.band && <span className="vfos__band">{v.band}</span>}
                            </>
                        )}
                    </button>
                ))}
            </div>
            {!minimal && (
                <div className="note note--tight">
                    Switching stores what is live into the VFO you are leaving, so
                    you never lose the frequency you were on.
                </div>
            )}
        </div>
    );
}
