// Band buttons, matching v1's band status bar.
//
// Top row: the ten HF amateur bands v1 shows, with the same ranges (app.js
// `bandRanges`) and the same condition colouring — average FT8 SNR over the
// last ten minutes from /api/noisefloor/aggregate, refreshed once a minute,
// bucketed exactly as static/bands_state.js does it.
//
// Bottom row, under a divider: this instance's own quick-tune bands, i.e. the
// entries in /api/bands that the operator gave a `button_name`. v1 renders
// those as a second row too. They carry no conditions data, so they are styled
// neutrally rather than being painted permanently green.
//
// Clicking either kind does what v1's setBand() does: tune to the middle of the
// band, take the band's mode (LSB below 10 MHz, USB above, unless the band
// declares one) and zoom the spectrum to the band's width.

import React, { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';

// [label, min, max] — v1's ranges verbatim, in v1's order.
const HAM_BANDS = [
    ['160m', 1810000, 2000000],
    ['80m', 3500000, 4000000],
    ['60m', 5250000, 5450000],
    ['40m', 7000000, 7300000],
    ['30m', 10100000, 10150000],
    ['20m', 14000000, 14350000],
    ['17m', 18068000, 18168000],
    ['15m', 21000000, 21450000],
    ['12m', 24890000, 24990000],
    ['10m', 28000000, 29700000],
];

const BAND_NAMES = HAM_BANDS.map(([name]) => name);
const POLL_MS = 60 * 1000;
const WINDOW_MIN = 10;      // minutes of history averaged
const MIN_SPAN = 10000;     // v1 never zooms tighter than 10 kHz

// v1's thresholds (static/bands_state.js).
function classify(snr) {
    if (snr < 6) return 'POOR';
    if (snr < 20) return 'FAIR';
    if (snr < 30) return 'GOOD';
    return 'EXCELLENT';
}

// Average ft8_snr per band over the returned window, as v1 does.
function summarise(primary) {
    const out = {};
    for (const band of BAND_NAMES) {
        const points = (primary || {})[band];
        let total = 0;
        let n = 0;
        for (const p of points || []) {
            const v = p.values && p.values.ft8_snr;
            if (v != null) { total += v; n++; }
        }
        out[band] = n ? { status: classify(total / n), snr: total / n } : { status: 'UNKNOWN', snr: null };
    }
    return out;
}

export default function QuickBandsPanel() {
    const { tuning, actions, serverInfo, catalog } = useRadio();
    const [states, setStates] = useState({});

    const conditions = !!(serverInfo && serverInfo.noise_floor);

    useEffect(() => {
        if (!conditions) return undefined;
        let cancelled = false;

        const load = () => {
            const to = new Date();
            const from = new Date(to.getTime() - WINDOW_MIN * 60 * 1000);
            fetch('/api/noisefloor/aggregate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    primary: { from: from.toISOString(), to: to.toISOString() },
                    bands: BAND_NAMES,
                    fields: ['ft8_snr'],
                    interval: 'minute',
                }),
            })
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => { if (!cancelled && d) setStates(summarise(d.primary)); })
                .catch(() => { /* leave the last known conditions up */ });
        };

        load();
        const id = setInterval(load, POLL_MS);
        return () => { cancelled = true; clearInterval(id); };
    }, [conditions]);

    // One tune action for both rows.
    const go = (min, max, mode) => {
        const centre = Math.round((min + max) / 2);
        actions.setMode(mode || (centre < 10000000 ? 'lsb' : 'usb'));
        actions.setFrequency(centre);
        actions.setSpectrumCenter(centre);
        actions.setSpan(Math.max(max - min, MIN_SPAN));
    };

    const custom = (catalog.bands || []).filter((b) => b.button_name && b.button_name.trim());

    return (
        <div className="stack">
            <div className="chip-row chip-row--wrap">
                {HAM_BANDS.map(([name, min, max]) => {
                    const state = states[name];
                    // v1 shows a band with no data as open rather than greying
                    // it out, so an instance without FT8 history still reads.
                    const status = !conditions ? 'none'
                        : !state || state.status === 'UNKNOWN' ? 'excellent' : state.status.toLowerCase();
                    const active = tuning.frequency >= min && tuning.frequency <= max;
                    const tip = state && state.snr != null
                        ? `${name}: ${state.status}\nFT8 SNR: ${state.snr.toFixed(2)} dB`
                        : `${name}: No data available`;
                    return (
                        <button
                            key={name}
                            type="button"
                            title={conditions ? tip : name}
                            className={`chip chip--button band-chip band-chip--${status}${active ? ' is-current' : ''}`}
                            onClick={() => go(min, max)}
                        >
                            {name}
                        </button>
                    );
                })}
            </div>

            {custom.length > 0 && (
                <>
                    <div className="divider" />
                    <div className="chip-row chip-row--wrap">
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
                                    className={`chip chip--button${active ? ' is-active' : ''}`}
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
