// Frequency / number formatting shared across panels and the spectrum canvas.

// 14175000 -> "14.175.000"  (grouped in the ham-radio convention: MHz.kHz.Hz)
export function formatHz(hz) {
    const n = Math.max(0, Math.round(hz || 0));
    const mhz = Math.floor(n / 1e6);
    const khz = Math.floor((n % 1e6) / 1e3);
    const rest = n % 1e3;
    return `${mhz}.${String(khz).padStart(3, '0')}.${String(rest).padStart(3, '0')}`;
}

// Compact axis/readout label: picks kHz or MHz based on magnitude.
export function formatFreqShort(hz, spanHz) {
    if (spanHz != null && spanHz < 100e3) {
        return (hz / 1e3).toFixed(spanHz < 10e3 ? 2 : 1) + ' kHz';
    }
    if (hz >= 1e6) return (hz / 1e6).toFixed(hz % 1e6 === 0 ? 0 : 3) + ' MHz';
    return (hz / 1e3).toFixed(0) + ' kHz';
}

export function formatSpan(hz) {
    if (hz >= 1e6) return (hz / 1e6).toFixed(2) + ' MHz';
    if (hz >= 1e3) return (hz / 1e3).toFixed(hz >= 100e3 ? 0 : 1) + ' kHz';
    return Math.round(hz) + ' Hz';
}

// Accepts "14.175", "14175000", "14175 k", "7.1M" — returns Hz or null.
export function parseFreqInput(text) {
    if (text == null) return null;
    let s = String(text).trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return null;

    let mult = null;
    if (s.endsWith('mhz')) { mult = 1e6; s = s.slice(0, -3); }
    else if (s.endsWith('khz')) { mult = 1e3; s = s.slice(0, -3); }
    else if (s.endsWith('hz')) { mult = 1; s = s.slice(0, -2); }
    else if (s.endsWith('m')) { mult = 1e6; s = s.slice(0, -1); }
    else if (s.endsWith('k')) { mult = 1e3; s = s.slice(0, -1); }

    // Grouped form "14.175.000" is unambiguous — treat separators as thousands.
    if (mult === null && (s.match(/\./g) || []).length > 1) {
        const digits = s.replace(/\./g, '');
        const n = Number(digits);
        return Number.isFinite(n) ? n : null;
    }

    s = s.replace(/,/g, '');
    const n = Number(s);
    if (!Number.isFinite(n)) return null;

    if (mult !== null) return n * mult;
    // Bare number: a decimal point means MHz, otherwise assume Hz.
    if (s.includes('.')) return n * 1e6;
    return n;
}

// ISO 3166-1 alpha-2 -> flag emoji, via the regional indicator letters.
// 'GB' -> the two code points U+1F1EC U+1F1E7, which fonts render as a flag.
export function countryFlag(code) {
    if (!code || code.length !== 2) return '';
    return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

// S-meter, matching v1's s-meter-needle.js so both frontends read the same.
//
// ITU: S9 = -73 dBFS with 6 dB per S-unit below it, so S1 = -121 dBFS. Above S9
// the scale switches to 10 dB per unit, which is what makes the printed scale
// (S1 S3 S5 S7 S9 +20 +40 +60) evenly spaced: those land on S-units
// 1, 3, 5, 7, 9, 11, 13, 15.
export const S_UNITS_MIN = 1;    // S1,     -121 dBFS
export const S_UNITS_MAX = 15;   // S9+60,   -13 dBFS

export function dbfsToSUnits(dbfs) {
    if (dbfs < -121) return 0;
    if (dbfs < -73) return 1 + (dbfs + 121) / 6;
    return 9 + (dbfs + 73) / 10;
}

// Position on the S-meter bar, 0..1. Bars must use this rather than a linear
// dBFS ramp, or the needle disagrees with both the printed scale and the S
// value next to it — the scale is not linear in dB.
export function sUnitFraction(dbfs) {
    if (dbfs == null || dbfs <= -998) return 0;
    const s = dbfsToSUnits(dbfs);
    return clamp((s - S_UNITS_MIN) / (S_UNITS_MAX - S_UNITS_MIN), 0, 1);
}

// v1's S-meter ramp (s-meter-needle.js `sMeterColour`): red at S1 through
// yellow around S5 to green at S9, and green all the way up from there. Same
// idea as the SNR ramp — the colour runs out before the scale does, because a
// signal at S9 is already as strong as the colour has anything to say about.
export const S_COLOUR_MIN = 1;    // S-units,  -121 dBFS
export const S_COLOUR_MAX = 9;    //           -73 dBFS

export function sUnitColour(sUnits) {
    if (sUnits == null || !Number.isFinite(sUnits)) return 'hsl(0, 0%, 55%)';
    const c = clamp(sUnits, S_COLOUR_MIN, S_COLOUR_MAX);
    const hue = Math.round(((c - S_COLOUR_MIN) / (S_COLOUR_MAX - S_COLOUR_MIN)) * 120);
    return `hsl(${hue}, 90%, 55%)`;
}

export function sMeterColour(dbfs) {
    if (dbfs == null || dbfs <= -998) return 'hsl(0, 0%, 55%)';
    return sUnitColour(dbfsToSUnits(dbfs));
}

// The same colour from a position on the meter rather than a reading, for the
// needle and its peak hold — those know where they are pointing, not what dBFS
// put them there.
export function sMeterColourAt(fraction) {
    const f = Number.isFinite(fraction) ? clamp(fraction, 0, 1) : 0;
    return sUnitColour(S_UNITS_MIN + f * (S_UNITS_MAX - S_UNITS_MIN));
}

export function sUnitLabel(dbfs) {
    if (dbfs == null || dbfs <= -998) return '--';
    const s = dbfsToSUnits(dbfs);
    if (s < 1) return 'S0';
    if (s <= 9) return 'S' + Math.round(s);
    return 'S9+' + Math.round(dbfs + 73);
}

// SNR meter, matching v1's scales so a signal reads the same in both UIs.
//
// v1 puts SNR on a 30–60 dB meter (s-meter-needle.js `snrMin`/`snrMax`, mirrored
// in signal-meter.js as SNR_MIN/SNR_MAX) and colours it on a shorter ramp: red
// at or below 30 dB through yellow at 40 to green at or above 50
// (s-meter-needle.js `snrColour`, app.js `snrColourForValue`). The two are
// deliberately different: the meter has headroom above the point where a signal
// is already as good as it gets.
export const SNR_MIN = 30;
export const SNR_MAX = 60;
export const SNR_COLOUR_MIN = 30;
export const SNR_COLOUR_MAX = 50;

// Position on an SNR meter, 0..1.
export function snrFraction(snr) {
    if (snr == null || !Number.isFinite(snr)) return 0;
    return clamp((snr - SNR_MIN) / (SNR_MAX - SNR_MIN), 0, 1);
}

// v1's hue ramp: 0 (red) at 30 dB to 120 (green) at 50 dB.
export function snrColour(snr) {
    if (snr == null || !Number.isFinite(snr)) return 'hsl(0, 0%, 55%)';
    const c = clamp(snr, SNR_COLOUR_MIN, SNR_COLOUR_MAX);
    const hue = Math.round(((c - SNR_COLOUR_MIN) / (SNR_COLOUR_MAX - SNR_COLOUR_MIN)) * 120);
    return `hsl(${hue}, 90%, 55%)`;
}

// From a position on the meter rather than a reading — see sMeterColourAt.
export function snrColourAt(fraction) {
    const f = Number.isFinite(fraction) ? clamp(fraction, 0, 1) : 0;
    return snrColour(SNR_MIN + f * (SNR_MAX - SNR_MIN));
}

// Audio level, on v1's VU scale (app.js updateVUMeter).
//
// The player reports a linear RMS amplitude, where ordinary speech sits around
// 0.05–0.2 — reading that as a percentage makes loud audio look like 10%. v1
// converts to dBFS and maps −60 dB..0 dB onto 0..100%, which is what a VU meter
// is expected to do, so 0.1 RMS (−20 dBFS) shows as 67%.
export const AUDIO_FLOOR_DB = -60;

export function audioLevelPercent(rms) {
    if (rms == null || !Number.isFinite(rms) || rms <= 0) return 0;
    const db = clamp(20 * Math.log10(rms), AUDIO_FLOOR_DB, 0);
    return ((db - AUDIO_FLOOR_DB) / -AUDIO_FLOOR_DB) * 100;
}
