// Radio-side constants. Values mirror the server (websocket.go) so the UI and
// the backend agree on defaults without a round-trip.

export const MIN_FREQ = 10000;      // 10 kHz
export const MAX_FREQ = 30000000;   // 30 MHz

// Mode table. `low`/`high` are the passband edges in Hz relative to the tuned
// frequency and match the server-side defaults in websocket.go.
export const MODES = [
    { id: 'lsb', label: 'LSB', group: 'voice', low: -2700, high: -50 },
    { id: 'usb', label: 'USB', group: 'voice', low: 50, high: 2700 },
    { id: 'am', label: 'AM', group: 'voice', low: -5000, high: 5000 },
    { id: 'sam', label: 'SAM', group: 'voice', low: -5000, high: 5000 },
    { id: 'nfm', label: 'NFM', group: 'voice', low: -5000, high: 5000 },
    { id: 'fm', label: 'FM', group: 'voice', low: -8000, high: 8000 },
    { id: 'cwl', label: 'CW-L', group: 'cw', low: -200, high: 200 },
    { id: 'cwu', label: 'CW-U', group: 'cw', low: -200, high: 200 },
];
// IQ modes are deliberately absent: the server switches them to a lossless
// pcm-zstd stream, which would pull a zstd decoder into the bundle for a mode
// meant to feed external tools rather than the browser's speakers.

export const MODE_BY_ID = Object.fromEntries(MODES.map((m) => [m.id, m]));

// Widest passband edge the bandwidth sliders will offer, per mode family.
export function bandwidthLimits(mode) {
    switch (mode) {
        case 'usb': return { min: 0, max: 6000, sideband: 'upper' };
        case 'lsb': return { min: -6000, max: 0, sideband: 'lower' };
        case 'cwu': return { min: 0, max: 2000, sideband: 'upper' };
        case 'cwl': return { min: -2000, max: 0, sideband: 'lower' };
        case 'fm': return { min: -12000, max: 12000, sideband: 'both' };
        default: return { min: -10000, max: 10000, sideband: 'both' };
    }
}

// CW modes are tuned to the carrier, so the audible tone sits at the offset.
export const CW_TONE_OFFSET = 700;

export const TUNING_STEPS = [1, 10, 100, 500, 1000, 5000, 9000, 10000, 100000];

export function stepLabel(hz) {
    if (hz >= 1000) return (hz / 1000) + ' kHz';
    return hz + ' Hz';
}

// Squelch is expressed in dB SNR; -999 is the server's "always open" sentinel.
export const SQUELCH_ALWAYS_OPEN = -999;
