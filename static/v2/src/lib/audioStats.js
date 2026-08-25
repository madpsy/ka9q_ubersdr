// Numbers read off the audio spectrum, for the scope's Stats row.
//
// The picture answers "is there something there"; these answer "what is it and
// where". Peak frequency is the one that gets used — zero-beating a carrier,
// checking a tone is where it should be, seeing which way a drifting signal is
// going — and the rest give it context: how far above the noise it is, and
// whether the energy is really at the peak or spread either side of it.
//
// Everything is measured inside the passband, the same window audioBins gives
// the drawing, so the readings describe what is on screen and not the whole
// stream. Audio above the filter is not part of the signal being listened to.

import { audioBins } from './audioBand.js';
import { approachFor } from './timeConstant.js';

// How fast the averaged spectrum follows the live one, as an approach rate at
// timeConstant's reference frame interval. About a third of a second to settle.
//
// A single FFT frame is far too jittery to read as text. The peak bin of a
// voice hops around the harmonics several times a second, and a number that
// changes faster than it can be read is worse than no number: it invites being
// stared at rather than glanced at. Averaging first is also what makes the
// noise floor meaningful, since a single frame's floor is one sample of a
// random variable.
const SPECTRUM_APPROACH = 0.22;

// Frames further apart than this are a stall — a backgrounded tab, a paused
// stream — and are taken as a fresh start rather than eased across.
const MAX_GAP_S = 1;

/** Accumulator state. One per instrument; not shared. */
export function newAudioStats() {
    return { power: null, start: 0, count: 0, at: 0, frames: 0 };
}

/**
 * Fold one FFT frame into the average.
 *
 * `frame` is what subscribeAudioSpectrum delivers: `bins` as dBFS, plus
 * `binCount` and `sampleRate`. `tuning` supplies the passband.
 *
 * Averaging happens in the power domain, not in dB. A mean of decibels is the
 * geometric mean of the power, which sits below the arithmetic one and drags
 * further below it the more the value varies — so a peak that is present half
 * the time reads several dB low, and the noise floor reads lower than the noise
 * actually is. Converting first costs an exp per bin and makes the numbers mean
 * what they say.
 *
 * `nowMs` is injectable for tests; it defaults to the frame clock.
 */
export function accumulateAudioStats(state, frame, tuning, nowMs) {
    if (!state || !frame || !frame.bins || !(frame.binCount > 0)) return state;

    const { start, count } = audioBins(
        tuning ? tuning.bandwidthLow : 0,
        tuning ? tuning.bandwidthHigh : 0,
        frame.sampleRate,
        frame.binCount,
    );
    if (!count) return state;

    const now = Number.isFinite(nowMs) ? nowMs : (typeof performance === 'object' ? performance.now() : 0);
    const dt = state.at ? (now - state.at) / 1000 : 0;
    state.at = now;

    // A different window means the old average describes a different band.
    // Keeping it would blend two bands together and read as neither.
    if (!state.power || state.power.length !== count || state.start !== start) {
        state.power = new Float64Array(count);
        state.start = start;
        state.count = count;
        state.frames = 0;
    }

    const fresh = state.frames === 0 || !(dt > 0) || dt > MAX_GAP_S;
    const k = fresh ? 1 : approachFor(SPECTRUM_APPROACH, dt);

    for (let i = 0; i < count; i++) {
        const db = frame.bins[start + i];
        // -Infinity is what an empty analyser bin reads as; treat it as silence
        // rather than letting it poison the average.
        const p = Number.isFinite(db) ? Math.pow(10, db / 10) : 0;
        state.power[i] = fresh ? p : state.power[i] + (p - state.power[i]) * k;
    }
    state.frames++;
    return state;
}

/**
 * The readings, or null before enough has arrived to have any.
 *
 * `sampleRate` and `binCount` describe the frames that went in, and are what
 * turns a bin index back into a frequency — the same mapping the ruler and the
 * hover readout use.
 */
export function readAudioStats(state, sampleRate, binCount, tuning) {
    if (!state || !state.power || !state.frames || !(binCount > 0)) return null;
    const { start, count, startFreq, endFreq } = audioBins(
        tuning ? tuning.bandwidthLow : 0,
        tuning ? tuning.bandwidthHigh : 0,
        sampleRate,
        binCount,
    );
    if (!count || count !== state.count || start !== state.start) return null;

    const power = state.power;
    let peak = 0;
    let total = 0;
    let weighted = 0;
    for (let i = 0; i < count; i++) {
        const p = power[i];
        if (p > power[peak]) peak = i;
        total += p;
        weighted += p * i;
    }
    if (!(total > 0)) return null;

    const binHz = (endFreq - startFreq) / count;
    const freqOf = (bin) => startFreq + bin * binHz;

    return {
        peakHz: freqOf(interpolatePeak(power, peak)),
        peakDb: toDb(power[peak]),
        // Where the energy actually sits. A clean carrier puts this on the
        // peak; speech and noise spread it, and a centroid far from the peak is
        // the difference between a tone and a hiss with a bump in it.
        centroidHz: freqOf(weighted / total),
        floorDb: toDb(medianPower(power)),
        // Peak over the median bin. Not a receiver SNR — it is a within-the-
        // passband ratio measured after demodulation and AGC — but it is the
        // number that says whether the peak is a signal or the loudest part of
        // the noise.
        snrDb: toDb(power[peak]) - toDb(medianPower(power)),
        binHz,
    };
}

/**
 * Sub-bin peak position by parabolic interpolation on the log magnitudes.
 *
 * A peak almost never falls on a bin centre, so the bin index alone quantises
 * the reading to the bin width — 11.7 Hz at the default 4096-point FFT, which
 * is coarse enough to see when zero-beating. Fitting a parabola through the
 * peak and its two neighbours recovers most of the difference, and is the
 * standard correction for a windowed FFT.
 */
export function interpolatePeak(power, peak) {
    if (peak <= 0 || peak >= power.length - 1) return peak;
    const l = toDb(power[peak - 1]);
    const c = toDb(power[peak]);
    const r = toDb(power[peak + 1]);
    const denom = l - 2 * c + r;
    if (!Number.isFinite(denom) || denom === 0) return peak;
    const offset = (0.5 * (l - r)) / denom;
    // A well-formed peak lands within half a bin. Anything further is not a
    // peak being interpolated, it is a slope, and the bin itself is the better
    // answer.
    return Math.abs(offset) <= 0.5 ? peak + offset : peak;
}

/**
 * The median bin power, as the noise floor.
 *
 * Median rather than mean: the mean of a passband containing a strong signal is
 * dragged up by the signal, so a loud carrier would raise its own noise floor
 * and hide the SNR it was meant to reveal. Half the bins being below the median
 * is true whatever the loudest one is doing.
 */
export function medianPower(power) {
    const n = power.length;
    if (!n) return 0;
    const sorted = Float64Array.from(power).sort();
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function toDb(p) {
    return p > 0 ? 10 * Math.log10(p) : -Infinity;
}
