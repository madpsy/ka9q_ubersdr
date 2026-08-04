// The teleprinter decoders' shared machinery, and FSK/RTTY's own settings.
//
// This is the extension where a mistake is quietest. The frames are packed
// bytes rather than JSON, so a wrong offset does not throw — it yields a
// plausible timestamp and a string of mojibake, or a baud error of 1e-310 that
// pins the meter and looks like a badly tuned signal. The console has the same
// property: a line-splitting rule that drops a character, or keeps a carriage
// return, produces text that reads almost right.

const assert = require('assert');

const {
    FRAME_TEXT, FRAME_BAUD, FRAME_STATE, MAX_LINES, BAUD_ERROR_MAX,
    FRAMINGS, ENCODINGS, LIMITS,
    decodeFrame, stateFlags, appendText, formatTime, toText, attachParams, markSpace,
} = require('./.build/teleprinter.cjs');
const {
    PRESETS, DEFAULT_PRESET, FSK_FREQUENCIES, presetConfig, presetOf,
} = require('./.build/fskpresets.cjs');
const { waveLevelDb } = require('./.build/tonespectrum.cjs');
const { tunedOption } = require('./.build/extfreq.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// One frame exactly as audio_extensions/fsk/decoder.go writes it:
// [type:1][unix seconds:8 BE][length:4 BE][utf-8 text].
function textFrame(text, unixSeconds) {
    const body = Buffer.from(text, 'utf8');
    const b = Buffer.alloc(13 + body.length);
    b[0] = FRAME_TEXT;
    b.writeUInt32BE(0, 1);
    b.writeUInt32BE(unixSeconds, 5);
    b.writeUInt32BE(body.length, 9);
    body.copy(b, 13);
    return b;
}

const asArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

// --- frames ----------------------------------------------------------------

t('a text frame carries its own decode time, not the arrival time', () => {
    // The server stamps the 100 ms flush, so a line is timed by when the
    // characters were decoded rather than when the browser got to them.
    const f = decodeFrame(asArrayBuffer(textFrame('RYRYRY', 1785758415)));
    assert.strictEqual(f.kind, 'text');
    assert.strictEqual(f.text, 'RYRYRY');
    assert.strictEqual(f.at, 1785758415000);
    assert.strictEqual(formatTime(f.at), '12:00:15');
});

t('a frame arrives as an ArrayBuffer or a view of one', () => {
    const b = textFrame('CQ', 1785758415);
    assert.strictEqual(decodeFrame(asArrayBuffer(b)).text, 'CQ');
    assert.strictEqual(decodeFrame(new Uint8Array(asArrayBuffer(b))).text, 'CQ');
    // A view at a non-zero offset must read from the view, not the buffer.
    const padded = Buffer.concat([Buffer.alloc(4), b]);
    assert.strictEqual(decodeFrame(padded.subarray(4)).text, 'CQ');
});

t('a timestamp the server never filled in falls back to now', () => {
    const before = Date.now();
    const f = decodeFrame(asArrayBuffer(textFrame('X', 0)));
    assert.ok(f.at >= before, 'a zero stamp must not date the line to 1970');
});

t('the baud error and the state are read where the server put them', () => {
    const baud = Buffer.alloc(9);
    baud[0] = FRAME_BAUD;
    baud.writeDoubleBE(-3.25, 1);
    assert.deepStrictEqual(decodeFrame(asArrayBuffer(baud)), { kind: 'baud', error: -3.25 });

    const state = Buffer.from([FRAME_STATE, 3]);
    assert.deepStrictEqual(decodeFrame(asArrayBuffer(state)), { kind: 'state', state: 3 });
});

t('a frame that is not one of the three is dropped, not thrown on', () => {
    // Null is the only failure signal, so every caller has one case to handle.
    assert.strictEqual(decodeFrame(asArrayBuffer(Buffer.from([0x09, 1, 2]))), null);
    assert.strictEqual(decodeFrame(asArrayBuffer(Buffer.alloc(0))), null);
    assert.strictEqual(decodeFrame(asArrayBuffer(Buffer.from([FRAME_STATE]))), null);
    assert.strictEqual(decodeFrame(asArrayBuffer(Buffer.alloc(5))), null);
    assert.strictEqual(decodeFrame(null), null);
    assert.strictEqual(decodeFrame('not binary'), null);
});

t('a length that runs past the frame is a truncated frame', () => {
    // Trusting it would decode whatever bytes happen to follow in the buffer.
    const b = textFrame('HELLO', 1785758415);
    b.writeUInt32BE(500, 9);
    assert.strictEqual(decodeFrame(asArrayBuffer(b)), null);
});

t('the lamps are cumulative, so how far they light says where it stopped', () => {
    assert.deepStrictEqual(stateFlags(0), { signal: false, sync: false, decode: false });
    assert.deepStrictEqual(stateFlags(1), { signal: true, sync: false, decode: false });
    assert.deepStrictEqual(stateFlags(2), { signal: true, sync: true, decode: false });
    assert.deepStrictEqual(stateFlags(3), { signal: true, sync: true, decode: true });
    assert.deepStrictEqual(stateFlags(undefined), { signal: false, sync: false, decode: false });
});

// --- the console -----------------------------------------------------------

const textOf = (lines) => lines.map((l) => l.text);

t('text arriving in chunks builds one line until a newline ends it', () => {
    // The server flushes every 100 ms whether or not a character was decoded,
    // so a line is normally assembled over several frames.
    let lines = appendText([], 'CQ ', 1000);
    lines = appendText(lines, 'CQ DE ', 2000);
    lines = appendText(lines, 'G0ABC\n', 3000);
    assert.deepStrictEqual(textOf(lines), ['CQ CQ DE G0ABC']);
    // The time is when the line started, which is what a console timestamp is.
    assert.strictEqual(lines[0].at, 1000);
    lines = appendText(lines, 'K', 4000);
    assert.deepStrictEqual(textOf(lines), ['CQ CQ DE G0ABC', 'K']);
    assert.strictEqual(lines[1].at, 4000);
});

t('a teleprinter’s CR LF ends one line, not one line and a blank', () => {
    // A machine ends a line with CR LF, and often CR CR LF to give the carriage
    // time to travel. Keeping the CR would put a stray character or an empty
    // line at the end of every line of copy.
    const lines = appendText([], 'ONE\r\r\nTWO\r\n', 1000);
    assert.deepStrictEqual(textOf(lines), ['ONE', 'TWO']);
});

t('a blank line the sender asked for survives', () => {
    assert.deepStrictEqual(textOf(appendText([], 'A\n\nB', 1000)), ['A', '', 'B']);
});

t('the control characters the Baudot tables emit are not text', () => {
    // ITA2 maps the all-zero code to NUL and one figures code to BEL, and a
    // noisy channel produces both by the dozen. Dropping them here means they
    // are gone from what you copy as well as from what you read.
    assert.deepStrictEqual(textOf(appendText([], 'A\x00B\x07C', 1000)), ['ABC']);
    // A chunk of nothing but controls leaves the console untouched — not an
    // empty line per flush.
    const lines = appendText([], 'X', 1000);
    assert.strictEqual(appendText(lines, '\x00\x00', 2000), lines);
});

t('ids stay unique as old lines are dropped', () => {
    // They are the React key: an id reused after the cap trimmed the front
    // would make two different lines look like the same one.
    let lines = [];
    for (let i = 0; i < MAX_LINES + 50; i++) lines = appendText(lines, `line ${i}\n`, 1000 + i);
    assert.strictEqual(lines.length, MAX_LINES);
    assert.strictEqual(lines[0].text, 'line 50');
    assert.strictEqual(new Set(lines.map((l) => l.id)).size, MAX_LINES);
    // Monotonic, so they never collide with a line still on screen.
    assert.ok(lines.every((l, i) => i === 0 || l.id > lines[i - 1].id));
});

t('appending never writes through the list it was given', () => {
    const first = appendText([], 'AB', 1000);
    const second = appendText(first, 'CD', 2000);
    assert.deepStrictEqual(textOf(first), ['AB'], 'the earlier state is unchanged');
    assert.deepStrictEqual(textOf(second), ['ABCD']);
});

t('what you copy is what you were reading', () => {
    const lines = appendText(appendText([], 'ONE\n', 1785758415000), 'TWO', 1785758416000);
    assert.strictEqual(toText(lines, false), 'ONE\nTWO');
    assert.strictEqual(toText(lines, true), '[12:00:15] ONE\n[12:00:16] TWO');
});

// --- settings --------------------------------------------------------------

t('every preset is a complete set of the six parameters', () => {
    // A partial preset would leave a setting behind from the last one, which is
    // how you end up decoding NAVTEX framing at 45 baud and blaming the band.
    const keys = ['center_frequency', 'shift', 'baud_rate', 'framing', 'encoding', 'inverted'];
    for (const p of PRESETS) {
        assert.deepStrictEqual(Object.keys(p.config).sort(), [...keys].sort(), p.id);
        assert.ok(FRAMINGS.includes(p.config.framing), p.id);
        assert.ok(ENCODINGS.includes(p.config.encoding), p.id);
    }
    // Amateur RTTY is what this is opened for.
    assert.deepStrictEqual(presetConfig(DEFAULT_PRESET), {
        center_frequency: 1000, shift: 170, baud_rate: 45.45,
        framing: '5N1.5', encoding: 'ITA2', inverted: false,
    });
});

t('the preset menu is derived from the settings, not remembered beside them', () => {
    const ham = presetConfig('ham');
    assert.strictEqual(presetOf(ham), 'ham');
    assert.strictEqual(presetOf({ ...ham, shift: 425 }), 'custom');
    // And editing back by hand reads as the preset again — there is no second
    // copy of the state to disagree with the controls.
    const edited = { ...ham, shift: 425 };
    assert.strictEqual(presetOf({ ...edited, shift: 170 }), 'ham');
    assert.strictEqual(presetOf(presetConfig('navtex')), 'navtex');
});

t('an unknown preset falls back rather than yielding undefined settings', () => {
    assert.deepStrictEqual(presetConfig('nonsense'), presetConfig(DEFAULT_PRESET));
});

t('a number the server would refuse is clamped, not sent', () => {
    // The server refuses an out-of-range value outright, and a refused attach
    // is an error the operator has to clear rather than a setting they can
    // nudge back.
    const p = attachParams({ center_frequency: 99999, shift: -5, baud_rate: 1e6, framing: 'nope', encoding: 'nope' });
    assert.strictEqual(p.center_frequency, LIMITS.center_frequency.max);
    assert.strictEqual(p.shift, LIMITS.shift.min);
    assert.strictEqual(p.baud_rate, LIMITS.baud_rate.max);
    assert.strictEqual(p.framing, '5N1.5');
    assert.strictEqual(p.encoding, 'ITA2');
    assert.strictEqual(p.inverted, false);
});

t('the attach carries the six field names the server reads', () => {
    // audio_extensions/fsk/extension.go reads these keys and ignores anything
    // else, silently falling back to its NAVTEX defaults.
    assert.deepStrictEqual(Object.keys(attachParams(presetConfig('ham'))).sort(), [
        'baud_rate', 'center_frequency', 'encoding', 'framing', 'inverted', 'shift',
    ]);
    // The numbers go as numbers: a string is dropped by the Go type assertion.
    const p = attachParams({ ...presetConfig('ham'), shift: '425' });
    assert.strictEqual(p.shift, 425);
    assert.strictEqual(typeof p.baud_rate, 'number');
});

t('inverted swaps the two markers, as it swaps the two tones', () => {
    // v1 drew them without it, so an inverted mode — which weather RTTY is —
    // labelled mark and space the wrong way round.
    assert.deepStrictEqual(markSpace({ center_frequency: 1000, shift: 170 }), { mark: 1085, space: 915 });
    assert.deepStrictEqual(
        markSpace({ center_frequency: 1000, shift: 450, inverted: true }),
        { mark: 775, space: 1225 },
    );
});

t('the baud meter’s range is the one the panel draws against', () => {
    assert.strictEqual(BAUD_ERROR_MAX, 8);
});

// --- the frequency menu ----------------------------------------------------

t('the menu says which of its entries the receiver is on', () => {
    // The list holds signal frequencies and the dial sits an audio centre
    // below one, so the lookup has to add the centre back — and the answer
    // follows the centre, because moving it moves where the decoder listens.
    const centre = 1000;
    const dial = 14080000 - centre;
    assert.strictEqual(tunedOption(FSK_FREQUENCIES, dial + centre).hz, 14080000);
    assert.strictEqual(tunedOption(FSK_FREQUENCIES, dial + 2000), null);
    // Off the list entirely: the menu falls back to its placeholder rather
    // than claiming the nearest band.
    assert.strictEqual(tunedOption(FSK_FREQUENCIES, 14200000), null);
});

t('a hertz of rounding does not lose the match', () => {
    // Tuning is `signal − centre` rounded, so recovering the signal frequency
    // can land either side of where it started. A hertz on an HF dial is not a
    // different frequency.
    assert.ok(tunedOption(FSK_FREQUENCIES, 7646001));
    assert.ok(tunedOption(FSK_FREQUENCIES, 7645999));
    assert.strictEqual(tunedOption(FSK_FREQUENCIES, 7646002), null);
});

t('an unknown dial position is not a match', () => {
    assert.strictEqual(tunedOption(FSK_FREQUENCIES, NaN), null);
    assert.strictEqual(tunedOption(FSK_FREQUENCIES, undefined), null);
    assert.strictEqual(tunedOption([], 14080000), null);
    assert.strictEqual(tunedOption(undefined, 14080000), null);
});

t('every menu entry is a frequency the receiver can reach', () => {
    // MIN_FREQ is 10 kHz: an entry below it would tune to the clamp instead,
    // and then never match itself.
    const all = FSK_FREQUENCIES.flatMap((g) => g.options);
    assert.strictEqual(all.length, 12);
    for (const o of all) {
        assert.ok(o.hz >= 10000 && o.hz <= 30000000, o.label);
        assert.ok(o.label, `${o.hz} has no label`);
    }
    // Unique, or two entries would fight over being the selected one.
    assert.strictEqual(new Set(all.map((o) => o.hz)).size, all.length);
});

// --- audio level -----------------------------------------------------------

t('the audio level reads the analyser’s bytes as a signal centred on 128', () => {
    // Not as unsigned magnitudes: silence is 128, not 0, and treating it as 0
    // would report digital silence as a full-scale signal.
    assert.strictEqual(waveLevelDb(new Uint8Array(64).fill(128)), -Infinity);
    // A square wave at half scale is -6 dBFS.
    const half = Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 192 : 64));
    assert.ok(Math.abs(waveLevelDb(half) - -6.02) < 0.05, `got ${waveLevelDb(half)}`);
    assert.strictEqual(waveLevelDb(null), -Infinity);
});

console.log(`\n${pass} FSK checks passed`);
