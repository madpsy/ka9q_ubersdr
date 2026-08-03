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

// S-meter: S9 = -73 dBm, 6 dB per S-unit below that, dB over S9 above.
export function sUnitLabel(dbfs) {
    if (dbfs == null || dbfs <= -998) return '--';
    // dBFS from radiod tracks dBm closely enough for a relative meter.
    const s = (dbfs + 127) / 6;
    if (s >= 9) return 'S9+' + Math.round((s - 9) * 6);
    return 'S' + clamp(Math.round(s), 0, 9);
}
