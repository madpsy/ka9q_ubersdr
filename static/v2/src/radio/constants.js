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

// Widest passband the bandwidth sliders will offer, per mode family.
//
// These are passband *edges* relative to the tuned frequency, so a symmetric
// mode's maximum filter width is twice the edge: ±6000 Hz gives a 12 kHz
// filter. Single-sideband modes only occupy one side, so their edge value is
// the width directly.
export function bandwidthLimits(mode) {
    switch (mode) {
        case 'usb': return { min: 0, max: 6000, sideband: 'upper' };
        case 'lsb': return { min: -6000, max: 0, sideband: 'lower' };
        // CW is symmetric about the carrier in both sidebands, not one-sided.
        // The name says which sideband the tone is on; the filter still sits
        // either side of the dial — v1's combinedValueToLowHigh returns [-v, v]
        // for cwu and cwl alike, and its sliders run -500..0 and 0..500.
        //
        // Declaring it 'upper'/'lower' clamped the mode's own ±200 default down
        // to 0..200, so tuning to a CW spot drew a narrow one-sided passband on
        // the spectrum instead of a symmetric one, and the width and shift
        // sliders edited the wrong edge.
        case 'cwu':
        case 'cwl':
            return { min: -500, max: 500, sideband: 'both' };
        // v1: minLow -8000, maxHigh 8000. The shared default below is ±6000,
        // which would clamp FM's own ±8000 default the same way CW's was.
        case 'fm': return { min: -8000, max: 8000, sideband: 'both' };
        // am, sam, nfm — 12 kHz maximum width.
        default: return { min: -6000, max: 6000, sideband: 'both' };
    }
}

// Widest filter the sliders allow for a mode, in Hz.
export function maxFilterWidth(mode) {
    const l = bandwidthLimits(mode);
    return Math.abs(l.max - l.min);
}

// CW modes are tuned to the carrier, so the audible tone sits at the offset.
export const CW_TONE_OFFSET = 700;

export const TUNING_STEPS = [1, 10, 100, 500, 1000, 5000, 9000, 10000, 100000];

export function stepLabel(hz) {
    if (hz >= 1000) return (hz / 1000) + ' kHz';
    return hz + ' Hz';
}

// Next frequency on a `step` boundary in the given direction.
//
// Stepping is a snap, not an add: from 7.100123 MHz with a 500 Hz step, up lands
// on 7.100500 and down on 7.100000, so the dial ends up on round numbers however
// it got to where it was. Already on a boundary, it moves a full step.
export function snapStep(frequency, step, dir) {
    if (!(step > 0)) return frequency;
    const f = frequency / step;
    // floor/ceil rather than round, so a press never moves the opposite way.
    return (dir > 0 ? Math.floor(f) + 1 : Math.ceil(f) - 1) * step;
}

// AGC.
//
// Only USB and LSB expose these — v1 keys them off a per-mode settings table
// containing just those two. There is deliberately no enable/disable switch:
// the server accepts `agcEnable` but v1 never sends it and never reports it
// back, so a toggle would show a state nothing else agrees with.
//
// Defaults match share/presets.conf. The server applies the operator's
// config.yaml `ssb_agc` values over them for every new SSB session and again on
// each mode change, then reports the result via `agc_state`, so the server is
// the authority and these are only a first guess.
export const AGC_CONTROLS = [
    { id: 'agcHangTime', label: 'Hang time', min: 0, max: 10, step: 0.1, default: 1.1, unit: 's', decimals: 1 },
    { id: 'agcRecoveryRate', label: 'Recovery', min: 1, max: 100, step: 1, default: 20, unit: 'dB/s', decimals: 0 },
    { id: 'agcThreshold', label: 'Threshold', min: -30, max: 0, step: 1, default: -15, unit: 'dB', decimals: 0 },
];

export function hasAGCSettings(mode) {
    return mode === 'usb' || mode === 'lsb';
}

export function defaultAGC() {
    return Object.fromEntries(AGC_CONTROLS.map((c) => [c.id, c.default]));
}

// Squelch.
//
// This is the server-side audio gate (`set_audio_gate` with `min_snr`), not
// radiod's `set_squelch`. v1 ships with `FM_SQUELCH_ENABLED = false` and only
// ever sends squelchOpen -999, so the gate is the control users actually have.
// The gate drops audio before encoding and keeps the signal-quality packets
// flowing, so SNR stays live on screen while muted.
export const SQUELCH_MIN = 24;        // far-left slider position — means "off"
export const SQUELCH_MAX = 80;
export const SQUELCH_STEP = 0.5;
export const SQUELCH_SENTINEL = -999; // value the server reads as "disabled"

// Server-side gate behaviour, mirrored so the open/closed indicator matches
// what the server is actually doing (see audioGateAllows in websocket.go).
export const SQUELCH_HANG_MS = 500;

// Slider position -> threshold to send. The floor doubles as the off switch.
export function squelchThreshold(sliderValue) {
    const v = Number(sliderValue);
    return v <= SQUELCH_MIN ? SQUELCH_SENTINEL : v;
}

export function squelchEnabled(sliderValue) {
    return squelchThreshold(sliderValue) > SQUELCH_SENTINEL + 1;
}

// Auto-set, mirroring v1: average the last few SNR readings and sit a few dB
// *above* them, so the threshold lands just over the noise the receiver is
// actually hearing. Sitting below it would leave the gate permanently open.
export const SQUELCH_AUTO_SAMPLES = 5;
export const SQUELCH_AUTO_HEADROOM_DB = 3;

// `snrHistory` is oldest-first. Returns a slider position, or null if there is
// nothing to measure yet.
export function autoSquelchValue(snrHistory) {
    if (!snrHistory || snrHistory.length === 0) return null;
    const recent = snrHistory.slice(-SQUELCH_AUTO_SAMPLES);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const stepped = Math.round((avg + SQUELCH_AUTO_HEADROOM_DB) / SQUELCH_STEP) * SQUELCH_STEP;
    // Never land on the floor, which would read as "off".
    return Math.max(SQUELCH_MIN + SQUELCH_STEP, Math.min(SQUELCH_MAX, stepped));
}
