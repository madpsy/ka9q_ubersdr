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

export function sUnitLabel(dbfs) {
    if (dbfs == null || dbfs <= -998) return '--';
    const s = dbfsToSUnits(dbfs);
    if (s < 1) return 'S0';
    if (s <= 9) return 'S' + Math.round(s);
    return 'S9+' + Math.round(dbfs + 73);
}
