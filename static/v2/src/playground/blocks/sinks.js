// Where a graph's results go: to the speakers, to a meter, to a picture.
//
// Sinks have no outputs. What they hold is read by the runtime's caller — the
// audio to schedule, the level to draw — through `read()`.

import { COMPLEX, CONTROL, MESSAGE, REAL, emitControl } from '../block.js';
import { SpectrumRing } from '../../lib/dsp/scope.js';

/**
 * Audio to hear, on any output the browser knows about.
 *
 * `device` is the output — '' for wherever the receiver's own audio goes —
 * and `channel` which side of it: left, right or both. Two of these can share
 * one pair of headphones, one in each ear, while a third plays on the
 * speakers. Applied by the page's audio graph, not here (see
 * lib/audioRoutes.js); this keeps the last block in single precision, as Web
 * Audio wants it, valid until the next.
 */
export const AudioOutBlock = {
    type: 'audio-out',
    label: 'Audio out',
    category: 'Sinks',
    summary: 'To speakers or headphones — any output, left, right or both.',
    inputs: [{ name: 'in', kind: REAL }],
    outputs: [],
    params: {
        device: { kind: 'device', label: 'Output', default: '' },
        channel: {
            kind: 'choice',
            label: 'Channel',
            default: 'both',
            options: [{ value: 'left', label: 'Left' }, { value: 'both', label: 'Both' }, { value: 'right', label: 'Right' }],
        },
        muted: { kind: 'bool', label: 'Muted', default: false },
    },
    create() {
        let samples = new Float32Array(0);
        let frames = 0;
        let rate = 12000;
        let p = {};
        return {
            configure(params, r) { p = params; rate = r; },
            reset() { frames = 0; },
            read() {
                return {
                    samples: samples.subarray(0, frames), frames, rate,
                    device: p.device, channel: p.channel, muted: p.muted,
                };
            },
            process(ins, outs, n) {
                if (samples.length < n) samples = new Float32Array(n);
                samples.set(ins[0].re.subarray(0, n));
                frames = n;
                return 0;
            },
        };
    },
};

/**
 * A WAV file of what arrives: mono from `left` alone, stereo with `right` too —
 * a pair of demodulators, or I and Q through a real part and an imaginary
 * part.
 *
 * The recording itself is kept by the page (playground/recording.js),
 * which starts, stops, saves and plays it back; this hands over each block, as
 * Audio out does. `maxSeconds` is where it stops on its own, and a recording
 * also stops at a memory ceiling, which on a wide stream comes first.
 */
export const WavRecorderBlock = {
    type: 'wav-recorder',
    label: 'WAV recorder',
    category: 'Sinks',
    summary: 'Records to a 16-bit WAV file: mono, or stereo with the second input.',
    inputs: [{ name: 'left', kind: REAL }, { name: 'right', kind: REAL, optional: true }],
    outputs: [],
    params: {
        maxSeconds: { kind: 'number', label: 'Time limit', unit: 's', default: 600, min: 1, max: 3600, step: 1 },
    },
    create() {
        let left = new Float32Array(0);
        let right = new Float32Array(0);
        let stereo = false;
        let frames = 0;
        let rate = 12000;
        let p = {};
        return {
            configure(params, r) { p = params; rate = r; },
            reset() { frames = 0; },
            read() {
                return {
                    left: left.subarray(0, frames),
                    right: stereo ? right.subarray(0, frames) : null,
                    frames, rate, maxSeconds: p.maxSeconds,
                };
            },
            process(ins, outs, n) {
                if (left.length < n) {
                    left = new Float32Array(n);
                    right = new Float32Array(n);
                }
                left.set(ins[0].re.subarray(0, n));
                stereo = !!ins[1];
                if (stereo) right.set(ins[1].re.subarray(0, n));
                frames = n;
                return 0;
            },
        };
    },
};

/**
 * A complex wire to a stereo WAV file, I on the left and Q on the right — the
 * form every IQ tool reads, and the IQ player plays back. Kept by the page as
 * the WAV recorder's are; named with the frequency it was recorded at, where
 * that is known, so the player can label it again.
 */
export const IqRecorderBlock = {
    type: 'iq-recorder',
    label: 'IQ recorder',
    category: 'Sinks',
    summary: 'Records a complex signal to a stereo IQ WAV file, I left and Q right.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [],
    params: {
        maxSeconds: { kind: 'number', label: 'Time limit', unit: 's', default: 300, min: 1, max: 3600, step: 1 },
    },
    create() {
        let left = new Float32Array(0);
        let right = new Float32Array(0);
        let frames = 0;
        let rate = 12000;
        let p = {};
        return {
            configure(params, r) { p = params; rate = r; },
            reset() { frames = 0; },
            read() {
                return { left: left.subarray(0, frames), right: right.subarray(0, frames), frames, rate, maxSeconds: p.maxSeconds };
            },
            process(ins, outs, n) {
                if (left.length < n) {
                    left = new Float32Array(n);
                    right = new Float32Array(n);
                }
                left.set(ins[0].re.subarray(0, n));
                right.set(ins[0].im.subarray(0, n));
                frames = n;
                return 0;
            },
        };
    },
};

/** RMS of each block, the figure the IQ Demod panel's audio meter shows. */
export const MeterBlock = {
    type: 'meter',
    label: 'Level meter',
    category: 'Viewers',
    summary: 'RMS level of each block, in dBFS.',
    inputs: [{ name: 'in', kind: REAL }],
    // The level in dBFS, as a control, every packet.
    outputs: [{ name: 'db', kind: CONTROL }],
    params: {},
    create() {
        let level = 0;
        return {
            configure() {},
            reset() { level = 0; },
            read() { return { level, db: level > 0 ? 20 * Math.log10(level) : null }; },
            process(ins, outs, n) {
                const x = ins[0].re;
                let sumSq = 0;
                for (let k = 0; k < n; k++) sumSq += x[k] * x[k];
                if (n) level = Math.sqrt(sumSq / n);
                if (n && outs[0]) emitControl(outs[0], level > 0 ? 20 * Math.log10(level) : -200);
                return 0;
            },
        };
    },
};

/** The spectrum of a real signal's last `size` samples, on request. */
export const AudioSpectrumBlock = {
    type: 'audio-spectrum',
    label: 'Audio spectrum',
    category: 'Viewers',
    summary: 'What a real signal contains, DC to Nyquist — spectrum, waterfall or both.',
    inputs: [{ name: 'in', kind: REAL }],
    outputs: [],
    params: {
        size: {
            kind: 'choice',
            label: 'Points',
            default: 1024,
            options: [256, 512, 1024, 2048, 4096].map((v) => ({ value: v, label: String(v) })),
        },
        display: {
            kind: 'choice',
            label: 'Show',
            default: 'spectrum',
            options: [
                { value: 'spectrum', label: 'Spectrum' },
                { value: 'waterfall', label: 'Waterfall' },
                { value: 'both', label: 'Both' },
            ],
        },
        peakHold: { kind: 'bool', label: 'Peak hold', default: false },
    },
    create() {
        let ring = null;
        let rate = 12000;
        return {
            configure(p, r) {
                rate = r;
                if (!ring || ring.size !== p.size) ring = new SpectrumRing(p.size);
            },
            reset() { if (ring) ring.reset(); },
            read() { return { db: ring.spectrum(), binHz: rate / ring.size, rate, size: ring.size, sided: 1 }; },
            process(ins, outs, n) {
                ring.push(ins[0].re, n);
                return 0;
            },
        };
    },
};

/**
 * Text read aloud: whatever a decoder or a console sends it. The speaking is
 * the page's (playground/speech.js), since a worker has no voice; this only
 * hands on what arrived each packet, as Audio out hands on its samples.
 */
export const TtsBlock = {
    type: 'tts',
    label: 'Text to speech',
    category: 'Sinks',
    summary: 'Reads text aloud — a decoder’s, or a console’s — in the receiver’s voice or one of your choosing. Letters spells each word, for CW and callsigns; Words reads phrases, for RTTY and NAVTEX.',
    inputs: [{ name: 'in', kind: MESSAGE }],
    outputs: [],
    params: {
        read: {
            kind: 'choice',
            label: 'Read as',
            default: 'letters',
            options: [{ value: 'letters', label: 'Letters' }, { value: 'words', label: 'Words' }],
        },
        // By name: voices are the browser's and differ from machine to
        // machine, so a graph from another one may name a voice this one has
        // not got — and is then read in the receiver's (playground/speech.js).
        voice: { kind: 'voice', label: 'Voice', default: '' },
        rate: { kind: 'number', label: 'Speed', unit: '×', default: 1, min: 0.5, max: 2, step: 0.1, live: true },
        pitch: { kind: 'number', label: 'Pitch', unit: '×', default: 1, min: 0.5, max: 2, step: 0.1, live: true },
        volume: { kind: 'number', label: 'Volume', unit: '%', default: 100, min: 0, max: 100, step: 5, live: true },
        muted: { kind: 'bool', label: 'Muted', default: false },
    },
    create() {
        let said = '';
        let p = {};
        return {
            configure(params) { p = params; },
            reset() { said = ''; },
            // This packet's text, and how to say it.
            read() { return { text: said, read: p.read, rate: p.rate, muted: p.muted }; },
            process(ins) {
                said = '';
                const input = ins[0];
                if (!input || !input.list) return 0;
                for (const m of input.list) if (m && m.type === 'text' && m.text) said += m.text;
                return 0;
            },
        };
    },
};
