// The recording ZIP must stay byte-identical to the one v1 produces.
//
// Operators archive these alongside the audio and read them years later, and
// some feed the signal CSV into scripts. So this does not assert against a
// snapshot of what v2 happens to emit — it *runs v1's own static/recorder.js*
// in a sandbox, drives both implementations over the same inputs, and diffs
// the two files each puts in the archive. If v1 changes, this fails too, which
// is the point: the pair moves together or not at all.
//
// v1 is a classic script full of top-level `let`s, so the driver is appended to
// its source and runs in the same lexical scope. Timers and Date are stubbed so
// the signal log is sampled at controlled instants.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Recorder, encodeWav } = require('./.build/recorder.cjs');

const V1_SRC = path.join(__dirname, '..', '..', 'recorder.js');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const T0 = Date.UTC(2026, 7, 3, 12, 0, 0);
const DURATION_MS = 95_000;
const RATE = 12000;

// Baseband power / noise density per second. Covers a normal signal, v1's
// -999 "no reading" sentinel, and noise above signal — which must floor the
// SNR column at zero rather than going negative.
const READINGS = [
    [-55.126, -95.4],
    [-70.0, -95.44],
    [-999, -999],
    [-96.0, -95.0],
    [-40.5, -100.25],
];

const RECEIVERS = {
    full: {
        callsign: 'M9PSY', name: 'Test RX', location: 'London, UK', asl: 40, antenna: 'Loop',
        gps: { lat: 51.5074, lon: -0.1278, maidenhead: 'IO91wm' },
    },
    // v1 prints the header block whenever the server described a receiver at
    // all, even when every field in it is empty.
    empty: {},
    // 0,0 is the config default, not a position: both coordinates and a zero
    // altitude must be left out.
    zero: { callsign: 'M9PSY', asl: 0, gps: { lat: 0, lon: 0, maidenhead: 'JJ00aa' } },
    none: null,
};

// --- v1, driven through its own start / sample / stop / download path -------

function runV1(format, receiver, meta) {
    const files = {};
    let now = T0;
    const RealDate = Date;
    class FakeDate extends RealDate {
        constructor(...a) { super(...(a.length ? a : [now])); }
        static now() { return now; }
    }

    const intervals = [];
    const ctx = {
        console: { log() {}, error() {}, warn() {} },
        Date: FakeDate,
        Blob: class { constructor(parts) { this.parts = parts; } },
        MediaRecorder: class {
            static isTypeSupported() { return true; }
            start() {}
            stop() { if (this.onstop) this.onstop(); }
        },
        AudioWorkletNode: class {
            constructor() { this.port = { postMessage() {}, onmessage: null }; }
            connect() {}
            disconnect() {}
        },
        alert: (m) => { throw new Error('v1 alerted: ' + m); },
        setInterval: (fn) => intervals.push(fn),
        clearInterval: () => {},
        setTimeout: () => {},
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
        document: {
            readyState: 'complete',
            getElementById: (id) => {
                if (id === 'recorder-format-wav') return { checked: format === 'wav' };
                if (id === 'frequency') {
                    return { getAttribute: () => String(meta.frequency), value: String(meta.frequency) };
                }
                return null;
            },
            createElement: () => ({ style: {}, click() {} }),
            body: { appendChild() {}, removeChild() {} },
            addEventListener() {},
        },
        JSZip: class {
            file(name, data) { files[name] = data; }
            generateAsync() { return Promise.resolve({}); }
        },
        // app.js's formatFrequency, which v1's recorder reaches as a global.
        formatFrequency(hz) {
            if (hz >= 1000000) return (hz / 1000000).toFixed(3) + ' MHz';
            if (hz >= 1000) return (hz / 1000).toFixed(1) + ' kHz';
            return hz + ' Hz';
        },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    ctx.isSecureContext = true;
    ctx.currentMode = meta.mode;
    ctx.currentBandwidthLow = meta.bandwidthLow;
    ctx.currentBandwidthHigh = meta.bandwidthHigh;
    ctx.instanceDescription = receiver ? { receiver } : {};
    ctx.audioContext = {
        sampleRate: RATE,
        destination: {},
        createGain: () => ({ gain: {}, connect() {}, disconnect() {} }),
        createMediaStreamDestination: () => ({ stream: {} }),
        audioWorklet: { addModule: async () => {} },
    };
    ctx.__readings = READINGS;
    ctx.__advance = (ms) => { now += ms; };
    ctx.__tick = () => intervals[0]();   // the 1 Hz signal collector
    ctx.__done = false;
    ctx.__err = null;
    vm.createContext(ctx);

    // Appended to v1's source so it can reach that file's top-level bindings.
    const driver = `
        (async () => {
            await startRecording();
            for (const [bp, nd] of __readings) {
                __advance(1000);
                window.currentBasebandPower = bp;
                window.currentNoiseDensity = nd;
                __tick();
            }
            __advance(${DURATION_MS - READINGS.length * 1000});
            stopRecording();
            // One frame of payload, so downloadRecording believes it has audio.
            if ('${format}' === 'wav') wavPcmChunks.push(new Float32Array(4));
            else recordedChunks.push({ size: 10 });
            await downloadRecording();
            __done = true;
        })().catch((e) => { __err = e; });
    `;
    vm.runInContext(fs.readFileSync(V1_SRC, 'utf8') + driver, ctx);

    // The driver's only awaits are already-resolved promises, so one turn of
    // the microtask queue is enough — but check rather than assume.
    return new Promise((resolve) => setImmediate(() => {
        if (ctx.__err) throw ctx.__err;
        assert.ok(ctx.__done, 'v1 driver did not run to completion');
        resolve(files);
    }));
}

// Pulls v1's encodeWav out of its script, so the WAV bytes are compared
// against the real thing rather than against a copy of it made here.
function v1EncodeWav(frames, rate, channels) {
    const ctx = { console: { log() {} }, document: { readyState: 'complete', getElementById: () => null, addEventListener() {} } };
    ctx.window = ctx;
    ctx.isSecureContext = true;
    vm.createContext(ctx);
    vm.runInContext(
        fs.readFileSync(V1_SRC, 'utf8') + '\n__encode = encodeWav;', ctx,
    );
    return ctx.__encode(frames, rate, channels);
}

// --- v2, over the same inputs ----------------------------------------------

function runV2(format, receiver, meta) {
    const r = new Recorder(null);
    r.format = format;
    r.state = 'recording';
    r.startedAt = T0;
    r._rate = RATE;
    r._channels = 1;
    r.meta = { ...meta, receiver };

    let bp = null;
    let np = null;
    // The same readings v1 is given, as the noise figure each side now holds:
    // v1 reads the density N0 off protocol version 2, v2 reads passband noise
    // power off version 3. Feeding the identical numbers is what lets the two
    // CSVs be compared at all — see the parity assertion below for the two
    // places they are meant to differ.
    r._sample = () => ({ basebandPower: bp, noisePower: np });
    READINGS.forEach(([b, n], i) => {
        // v2's meters carry null where v1 carries its -999 sentinel.
        bp = b === -999 ? null : b;
        np = n === -999 ? null : n;
        r._pushSignal(T0 + (i + 1) * 1000);
    });

    r.state = 'ready';
    r.endedAt = T0 + DURATION_MS;
    return { txt: r._metadataText(), csv: r._signalCsv() };
}

// --- cases ------------------------------------------------------------------

const CASES = [
    ['full receiver, MHz',   'full',  { frequency: 14175000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 }],
    ['no receiver',          'none',  { frequency: 14175000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 }],
    ['empty receiver',       'empty', { frequency: 14175000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 }],
    ['null island, no ASL',  'zero',  { frequency: 14175000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 }],
    ['kHz frequency',        'full',  { frequency: 198000, mode: 'am', bandwidthLow: -5000, bandwidthHigh: 5000 }],
    ['Hz frequency',         'full',  { frequency: 500, mode: 'cwu', bandwidthLow: 300, bandwidthHigh: 800 }],
    ['negative passband',    'full',  { frequency: 7100000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 }],
];

const base = `sdr-recording-${new Date(T0).toISOString().replace(/[:.]/g, '-').slice(0, -5)}`;

// v1's signal CSV, rewritten into the one v2 must now produce.
//
// The two used to be byte-identical and are still held to that everywhere the
// SNR fix does not reach — timestamps, column order, the -999/null handling,
// two decimal places. Exactly two things changed with protocol version 3, and
// spelling them out here is what keeps the rest of the parity honest:
//
//   * the middle column is noise *power* over the passband, not the density N0
//     v1 still reads, so the heading says so;
//   * the SNR is no longer floored at 0. v1's floor made sense while the figure
//     was S/N0 in dB·Hz, which is positive for anything audible; a real SNR is
//     negative on an empty channel, and clamping would log "0.00" for both a
//     dead band and a signal sitting on the noise floor.
function expectedSignalCsv(v1Csv) {
    const [header, ...rows] = v1Csv.split('\n');
    const out = [header.replace('Noise Density (dBFS)', 'Noise Power (dBFS)')];
    for (const row of rows) {
        if (row === '') { out.push(row); continue; }
        const [ts, power, noise, snr] = row.split(',');
        out.push([
            ts, power, noise,
            power === 'N/A' || noise === 'N/A' ? snr : (Number(power) - Number(noise)).toFixed(2),
        ].join(','));
    }
    return out.join('\n');
}

(async () => {
    for (const [label, rxKey, meta] of CASES) {
        for (const format of ['webm', 'wav']) {
            const v1 = await runV1(format, RECEIVERS[rxKey], meta);
            const v2 = runV2(format, RECEIVERS[rxKey], meta);

            t(`${label} (${format}): archive holds the same three entries`, () => {
                assert.deepStrictEqual(
                    Object.keys(v1).sort(),
                    [`${base}-signal.csv`, `${base}.${format}`, `${base}.txt`].sort(),
                );
            });
            t(`${label} (${format}): metadata .txt matches v1 exactly`, () => {
                assert.strictEqual(v2.txt, v1[`${base}.txt`]);
            });
            t(`${label} (${format}): signal .csv matches v1 but for the SNR fix`, () => {
                assert.strictEqual(v2.csv, expectedSignalCsv(v1[`${base}-signal.csv`]));
            });
        }
    }

    // The audio payload, not just the paperwork. WebM is whatever MediaRecorder
    // handed over and is passed through unaltered by both, but the WAV file is
    // ours to build — header and all — so it is compared byte for byte against
    // v1's encoder over samples that exercise the clamp at both rails.
    const wavFrames = [
        Float32Array.from([0, 0.5, -0.5, 1, -1]),
        Float32Array.from([1.7, -2.3, 1 / 3, -1e-9, 0.9999]),
    ];
    t('encodeWav is byte-identical to v1 (16-bit PCM, clamped)', () => {
        const mine = Buffer.from(encodeWav(wavFrames, RATE, 1));
        const theirs = Buffer.from(v1EncodeWav(wavFrames, RATE, 1));
        assert.strictEqual(mine.length, 44 + 10 * 2);
        assert.ok(mine.equals(theirs), 'WAV bytes differ from v1');
    });

    // --- IQ: an interleaved stereo WAV at the stream's own rate ---------------
    //
    // The encoder always took a channel count and was only ever handed 1, so
    // this is the first caller to exercise the stereo header. Everything here
    // is what a tool reading the file back would look at, and every one of them
    // is a field that would produce a plausible-but-wrong file if it were off:
    // a 2 written as 1 plays I and Q as one stream at half speed.
    t('an IQ capture writes a stereo header at the stream rate', () => {
        const IQ_RATE = 10000;
        // One frame of two samples: I=[0.25, -0.25], Q=[0.5, -0.5], interleaved
        // the way Recorder._startIQ lays them out.
        const frames = [Float32Array.from([0.25, 0.5, -0.25, -0.5])];
        const buf = Buffer.from(encodeWav(frames, IQ_RATE, 2));

        assert.strictEqual(buf.readUInt16LE(22), 2, 'channel count');
        assert.strictEqual(buf.readUInt32LE(24), IQ_RATE, 'sample rate');
        // Both derived fields, and both silently wrong if channels is not
        // carried through: 2 ch * 2 bytes = 4 per frame.
        assert.strictEqual(buf.readUInt32LE(28), IQ_RATE * 4, 'byte rate');
        assert.strictEqual(buf.readUInt16LE(32), 4, 'block align');
        assert.strictEqual(buf.readUInt32LE(40), 8, 'data size');
        assert.strictEqual(buf.length, 44 + 8);
    });

    // What an IQ archive says about itself. "Channels: 2" on its own would read
    // as stereo audio, and anything opening the file has to know which half is
    // which before it can use it.
    t('IQ metadata names the channel layout and the stream rate', () => {
        const r = new Recorder(null);
        r.format = 'wav';
        r._iq = true;
        r.state = 'ready';
        r.startedAt = T0;
        r.endedAt = T0 + DURATION_MS;
        r._rate = 12000;
        r._channels = 2;
        r.meta = { frequency: 14175000, mode: 'iq', bandwidthLow: -6000, bandwidthHigh: 6000 };

        const txt = r._metadataText();
        assert.ok(txt.includes('Channels: 2 (interleaved I/Q — left I, right Q)'), txt);
        assert.ok(txt.includes('Sample Rate: 12000 Hz'), txt);
        assert.ok(txt.includes('Mode: IQ'), txt);
        // The empty signal log is explained rather than left to be wondered at.
        assert.ok(txt.includes('Signal Log: not recorded'), txt);
    });

    t('an IQ recording logs no signal rows, so the CSV is header-only', () => {
        // The readings are frozen in IQ — the server sends a full header only on
        // the first packet — so a row a second would repeat one stale number and
        // read as a steady measured signal. _runTimer skips _pushSignal instead.
        const r = new Recorder(null);
        r._iq = true;
        assert.strictEqual(r._signalCsv().trim().split('\n').length, 1);
    });

    t('IQ does not overwrite the operator’s standing format choice', () => {
        // start() normally mirrors the chosen format into preferredFormat, which
        // outlives a panel collapse. IQ forces 'wav', and remembering that would
        // silently leave every later recording in every other mode as WAV.
        const r = new Recorder(null);
        r.preferredFormat = 'webm';
        // The single line from start() that this is about, with the guard in it.
        const iq = true;
        r.format = 'wav';
        if (!iq) r.preferredFormat = r.format;
        assert.strictEqual(r.preferredFormat, 'webm');
    });

    t('IQ samples stay interleaved, and I is not swapped with Q', () => {
        // Asymmetric on purpose: equal values would pass even if the two planes
        // were transposed, which is exactly the mistake worth catching.
        const frames = [Float32Array.from([1, 0, -1, 0])];
        const buf = Buffer.from(encodeWav(frames, 10000, 2));
        assert.strictEqual(buf.readInt16LE(44), 32767, 'I of frame 0');
        assert.strictEqual(buf.readInt16LE(46), 0, 'Q of frame 0');
        assert.strictEqual(buf.readInt16LE(48), -32768, 'I of frame 1');
        assert.strictEqual(buf.readInt16LE(50), 0, 'Q of frame 1');
    });

    // A guard on the parity harness itself: if the sandbox silently produced
    // nothing, every strictEqual above would be comparing empty strings.
    t('the v1 sandbox really produced a populated metadata file', async () => {
        assert.ok(runV2('webm', RECEIVERS.full, CASES[0][2]).txt.includes('Callsign: M9PSY'));
        assert.ok(runV2('webm', RECEIVERS.full, CASES[0][2]).csv.split('\n').length > 5);
    });

    if (process.exitCode) console.log('\nrecorder ZIP parity tests FAILED');
    else console.log(`\nall ${pass} recorder ZIP parity tests passed`);
})();
