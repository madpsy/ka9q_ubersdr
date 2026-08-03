// A one-tap row of the bands people actually hop between. Laid out as a wrapping
// chip row so it works equally well in the bottom dock and in a narrow side dock.

import React from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';

// { label, centre frequency, sensible default mode }
const QUICK = [
    ['LW', 200000, 'am'],
    ['MW', 909000, 'am'],
    ['160m', 1900000, 'lsb'],
    ['80m', 3700000, 'lsb'],
    ['75m SW', 3950000, 'am'],
    ['60m', 5357000, 'usb'],
    ['49m SW', 6100000, 'am'],
    ['40m', 7100000, 'lsb'],
    ['41m SW', 7300000, 'am'],
    ['31m SW', 9600000, 'am'],
    ['30m', 10125000, 'cwu'],
    ['25m SW', 11800000, 'am'],
    ['20m', 14200000, 'usb'],
    ['19m SW', 15400000, 'am'],
    ['17m', 18120000, 'usb'],
    ['16m SW', 17700000, 'am'],
    ['15m', 21250000, 'usb'],
    ['13m SW', 21600000, 'am'],
    ['12m', 24940000, 'usb'],
    ['11m CB', 27185000, 'usb'],
    ['10m', 28400000, 'usb'],
];

export default function QuickBandsPanel() {
    const { tuning, actions } = useRadio();

    return (
        <div className="chip-row chip-row--wrap">
            {QUICK.map(([label, hz, mode]) => {
                // Highlight whichever entry the current frequency is nearest,
                // within a band's worth of slack.
                const active = Math.abs(tuning.frequency - hz) < 400000;
                return (
                    <button
                        key={label}
                        type="button"
                        className={`chip chip--button${active ? ' is-active' : ''}`}
                        onClick={() => {
                            actions.setMode(mode);
                            actions.setFrequency(hz);
                            actions.setSpectrumCenter(hz);
                        }}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
}
