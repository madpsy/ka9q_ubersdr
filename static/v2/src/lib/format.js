// Frequency / number formatting shared across panels and the spectrum canvas.

import { MAX_FREQ, MIN_FREQ } from '../radio/constants.js';

// 14175000 -> "14.175.000"  (grouped in the ham-radio convention: MHz.kHz.Hz)
export function formatHz(hz) {
    const n = Math.max(0, Math.round(hz || 0));
    const mhz = Math.floor(n / 1e6);
    const khz = Math.floor((n % 1e6) / 1e3);
    const rest = n % 1e3;
    return `${mhz}.${String(khz).padStart(3, '0')}.${String(rest).padStart(3, '0')}`;
}

/**
 * Every hertz of it, at a width that does not move.
 *
 * For the cursor readouts, where the point is to read a frequency off the
 * spectrum precisely — formatFreqShort rounds to the zoom, which is right for a
 * bookmark or a menu label and wrong here: at a wide span it was rounding the
 * cursor to the nearest kilohertz.
 *
 * Fixed decimals rather than trimmed ones, deliberately. These numbers update
 * as the pointer moves, and a label that changes width as the digits change
 * makes the readout jitter and the badge beside it shuffle along.
 */
export function formatFreqExact(hz) {
    const n = Math.round(hz || 0);
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(6) + ' MHz';
    return (n / 1e3).toFixed(3) + ' kHz';
}

/**
 * A passband as one number: its width.
 *
 * That is what a filter is called when anybody talks about one. Sub-kilohertz
 * filters — CW, and a narrowed SSB — read in hertz, because "0.25k" is a worse
 * way of writing 250 Hz.
 */
export function formatFilterWidth(low, high) {
    const hz = Math.abs((high || 0) - (low || 0));
    if (!hz) return '';
    return hz < 1000 ? `${Math.round(hz)}` : `${(hz / 1000).toFixed(2)}k`;
}

// Compact axis/readout label: picks kHz or MHz based on magnitude.
export function formatFreqShort(hz, spanHz) {
    if (spanHz != null && spanHz < 100e3) {
        return (hz / 1e3).toFixed(spanHz < 10e3 ? 2 : 1) + ' kHz';
    }
    if (hz >= 1e6) return (hz / 1e6).toFixed(hz % 1e6 === 0 ? 0 : 3) + ' MHz';
    return (hz / 1e3).toFixed(0) + ' kHz';
}

// A link rate from bytes per second. Bits, because that is what a link is
// quoted in, and two significant-ish figures — this is a "is it working and
// roughly how much" readout, not a measurement.
export function formatRate(bytesPerSec) {
    if (bytesPerSec == null || !Number.isFinite(bytesPerSec) || bytesPerSec < 0) return '—';
    const kbit = (bytesPerSec * 8) / 1000;
    if (kbit >= 1000) return `${(kbit / 1000).toFixed(2)} Mbit/s`;
    if (kbit >= 10) return `${kbit.toFixed(0)} kbit/s`;
    return `${kbit.toFixed(1)} kbit/s`;
}

export function formatSpan(hz) {
    if (hz >= 1e6) return (hz / 1e6).toFixed(2) + ' MHz';
    if (hz >= 1e3) return (hz / 1e3).toFixed(hz >= 100e3 ? 0 : 1) + ' kHz';
    return Math.round(hz) + ' Hz';
}

// Reads a typed frequency and returns Hz, or null for anything unusable.
//
// The unit is kHz. A bare number is kHz whether or not it has a decimal point —
// "14175", "14175.5" and "475" all mean what an operator would say out loud —
// and that is the whole rule, so there is nothing to work out before typing.
//
// It used to guess from the shape of the number: a decimal point meant MHz and
// a plain integer meant Hz, so "7100" was 7.1 kHz and "7.1" was 7.1 MHz — a
// thousandfold difference resting on a keystroke. One fixed unit is worth more
// than the convenience that cost.
//
// A unit written out is still taken at its word, since those cannot be
// misread: "7.1M", "7100k" and "7100000hz" are all the same frequency.
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

    // Grouped form "14.175.000" — the readout's own format, and unambiguous
    // because nothing else carries two separators. Read back as Hz, so what the
    // dial displays can be pasted straight back into it.
    if (mult === null && (s.match(/\./g) || []).length > 1) {
        const digits = s.replace(/\./g, '');
        const n = digits === '' ? NaN : Number(digits);
        return Number.isFinite(n) ? n : null;
    }

    s = s.replace(/,/g, '');
    // A suffix on its own ("k") leaves nothing to scale, and Number('') is 0 —
    // which would tune to DC rather than being rejected.
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;

    return n * (mult === null ? 1e3 : mult);
}

// Is a frequency one this receiver can be tuned to? The bounds are the same
// ones every other path clamps against, so the type-in box accepts exactly what
// the dial, the spectrum drag and a bookmark can reach.
export function freqInRange(hz) {
    return hz != null && Number.isFinite(hz) && hz >= MIN_FREQ && hz <= MAX_FREQ;
}

// A frequency as the number the type-in box works in. Trailing zeros are gone —
// 14175000 Hz is "14175", not "14175.000" — because it is a value to be edited,
// not a readout to be lined up with others.
export function freqToKHz(hz) {
    if (hz == null || !Number.isFinite(hz)) return '';
    return String(Math.round(hz) / 1000);
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

// The same label from a position on the meter rather than a reading — for the
// peak hold, which is carried as a position so that one number drives both the
// hold needle and the text beside the live value.
export function sUnitLabelAt(fraction) {
    const f = Number.isFinite(fraction) ? clamp(fraction, 0, 1) : 0;
    // The trip out to a fraction and back is not exact: S9+3.5 comes back as
    // 3.4999999996 and rounds *down*, so a hold could print one dB below the
    // live reading that set it. EPS restores the half-up rounding sUnitLabel
    // does on the raw value — and it goes inside the rounding, not on `s`
    // itself, or an exact S9 would fall through to the "S9+0" branch.
    const EPS = 1e-9;
    const s = S_UNITS_MIN + f * (S_UNITS_MAX - S_UNITS_MIN);
    if (s < 1) return 'S0';
    if (s <= 9 + EPS) return 'S' + Math.round(s + EPS);
    return 'S9+' + Math.round((s - 9) * 10 + EPS);
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

// v1's VU zones on the same -60..0 dBFS scale (app.js updateVUMeter): green to
// -20 dB, yellow to -10, orange to -5, red over the last 5 dB. v1 paints them
// across a bar and reveals as much as the reading has reached; here they colour
// the volume slider's own fill, so the zone is the whole of the message and the
// boundaries are the same ones.
export function audioLevelColour(percent, clipping) {
    if (clipping) return '#dc3545';
    const p = Number.isFinite(percent) ? percent : 0;
    // The boundaries as exact fractions of the -60..0 scale rather than the
    // rounded 66.67 / 83.33 / 91.67 the old gradient used: a level sitting
    // exactly on -10 dBFS is 83.333%, which is not below 83.33, so it read as
    // the zone above its own.
    const at = (db) => ((db - AUDIO_FLOOR_DB) / -AUDIO_FLOOR_DB) * 100;
    if (p <= at(-20)) return '#28a745';
    if (p <= at(-10)) return '#ffc107';
    if (p <= at(-5)) return '#ff9800';
    return '#dc3545';
}
