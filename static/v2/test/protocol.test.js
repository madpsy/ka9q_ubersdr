// Exercises the wire-format decoders against frames built exactly the way
// user_spectrum_websocket.go and websocket.go build them.

const assert = require('assert');
const { SpectrumConnection } = require('./.build/spectrum.cjs');
const { AudioConnection } = require('./.build/audio.cjs');
const {
    MAX_FREQ, MIN_FREQ,
    SQUELCH_MIN, SQUELCH_MAX, SQUELCH_SENTINEL, SQUELCH_STEP,
    autoSquelchValue, bandwidthLimits, maxFilterWidth, snapStep, squelchEnabled, squelchThreshold,
} = require('./.build/constants.cjs');
const dspLib = require('./.build/dsp.cjs');
const mk = require('./.build/markers.cjs');
const ab = require('./.build/audioband.cjs');
const af = require('./.build/audiofilters.cjs');
const eql = require('./.build/eqlevels.cjs');
const mn = require('./.build/mentions.cjs');
const { UI_CONFIG_DEFAULTS, markColors, parseUiConfig } = require('./.build/uiconfig.cjs');
const { PALETTE_NAMES, paletteMarks } = require('./.build/palettes.cjs');
const {
    dbfsToSUnits, formatRate, freqInRange, freqToKHz, parseFreqInput,
    sMeterColour, sMeterColourAt, snrColour, snrColourAt, snrFraction,
    sUnitFraction, sUnitLabel, sUnitLabelAt,
    S_UNITS_MIN, S_UNITS_MAX, SNR_MIN, SNR_MAX,
} = require('./.build/format.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- helpers mirroring the Go packet builders ------------------------------
function specHeader(flags, freq) {
    const buf = new ArrayBuffer(22);
    const v = new DataView(buf);
    v.setUint8(0, 0x53); v.setUint8(1, 0x50); v.setUint8(2, 0x45); v.setUint8(3, 0x43);
    v.setUint8(4, 0x01);
    v.setUint8(5, flags);
    v.setBigUint64(6, BigInt(1700000000000), true);
    v.setBigUint64(14, BigInt(freq), true);
    return buf;
}
function concat(...parts) {
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(new Uint8Array(p), o); o += p.byteLength; }
    return out.buffer;
}

function fullFloat32(values, freq) {
    const body = new ArrayBuffer(values.length * 4);
    const v = new DataView(body);
    values.forEach((x, i) => v.setFloat32(i * 4, x, true));
    return concat(specHeader(0x01, freq), body);
}
function deltaFloat32(changes, freq) {
    const body = new ArrayBuffer(2 + changes.length * 6);
    const v = new DataView(body);
    v.setUint16(0, changes.length, true);
    changes.forEach(([idx, val], i) => {
        v.setUint16(2 + i * 6, idx, true);
        v.setFloat32(2 + i * 6 + 2, val, true);
    });
    return concat(specHeader(0x02, freq), body);
}
function fullUint8(values, freq) {
    return concat(specHeader(0x03, freq), new Uint8Array(values).buffer);
}
function deltaUint8(changes, freq) {
    const body = new ArrayBuffer(2 + changes.length * 3);
    const v = new DataView(body);
    v.setUint16(0, changes.length, true);
    changes.forEach(([idx, val], i) => {
        v.setUint16(2 + i * 3, idx, true);
        v.setUint8(2 + i * 3 + 2, val);
    });
    return concat(specHeader(0x04, freq), body);
}

// --- spectrum --------------------------------------------------------------
function capture(conn) {
    const frames = [];
    conn.on('frame', (f) => frames.push(f));
    return frames;
}

// Emitted frames are in ascending frequency order, so the raw FFT halves
// [DC..+Nyq | -Nyq..DC] arrive swapped. Verified against the live 25 MHz
// reference on m9psy: without the swap the carrier reads half a span low.
const unwrap = (a) => {
    const half = a.length >> 1;
    return [...a.slice(half), ...a.slice(0, half)];
};

t('float32 full frame decodes', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    const raw = [-100, -80.5, -60.25, -40];
    c._onSpectrum(new DataView(fullFloat32(raw, 7100000)));
    assert.strictEqual(frames.length, 1);
    assert.deepStrictEqual([...frames[0].bins], unwrap(raw));
    assert.strictEqual(frames[0].frequency, 7100000);
});

t('FFT halves are swapped into ascending frequency order', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    // A carrier at raw bin 0 is DC — the centre of the span — so it must come
    // out at the middle bin, not the first one.
    const raw = [0, -120, -120, -120, -120, -120, -120, -120];
    c._onSpectrum(new DataView(fullFloat32(raw, 25000000)));
    const bins = [...frames[0].bins];
    assert.strictEqual(bins.indexOf(0), 4, `peak landed at ${bins.indexOf(0)}, want 4`);
});

t('odd bin counts rotate without dropping a bin', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    c._onSpectrum(new DataView(fullFloat32([-1, -2, -3, -4, -5], 7100000)));
    // rotate left by floor(5/2) = 2
    assert.deepStrictEqual([...frames[0].bins], [-3, -4, -5, -1, -2]);
});

t('float32 delta applies in raw bin order, then unwraps', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    c._onSpectrum(new DataView(fullFloat32([-100, -100, -100, -100], 7100000)));
    // The server indexes deltas against raw order, so raw bin 1 must be the
    // one that changes — it surfaces at output position 3.
    c._onSpectrum(new DataView(deltaFloat32([[1, -42.5]], 7100000)));
    assert.deepStrictEqual([...frames[1].bins], [-100, -100, -100, -42.5]);
});

t('delta before any full frame is ignored, not crashed', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    c._onSpectrum(new DataView(deltaFloat32([[0, -10]], 7100000)));
    assert.strictEqual(frames.length, 0);
});

t('uint8 full frame maps 0->-256 and 255->-1', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    c._onSpectrum(new DataView(fullUint8([0, 128, 255, 64], 7100000)));
    assert.deepStrictEqual([...frames[0].bins], unwrap([-256, -128, -1, -192]));
});

t('uint8 delta uses 3-byte entries', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    c._onSpectrum(new DataView(fullUint8([100, 100, 100, 100], 7100000)));
    c._onSpectrum(new DataView(deltaUint8([[2, 200]], 7100000)));
    // raw bin 2 -> output position 0
    assert.deepStrictEqual([...frames[1].bins], [-56, -156, -156, -156]);
});

t('accumulators stay in raw order across frames', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    c._onSpectrum(new DataView(fullFloat32([-10, -20, -30, -40], 7100000)));
    c._onSpectrum(new DataView(deltaFloat32([[0, -99]], 7100000)));
    c._onSpectrum(new DataView(deltaFloat32([[3, -88]], 7100000)));
    // Unwrapping must not feed back into the accumulator: raw is now
    // [-99,-20,-30,-88], which surfaces as [-30,-88,-99,-20].
    assert.deepStrictEqual([...frames[2].bins], [-30, -88, -99, -20]);
});

t('unknown protocol version is dropped', () => {
    const c = new SpectrumConnection();
    const frames = capture(c);
    const buf = fullFloat32([-100], 7100000);
    new DataView(buf).setUint8(4, 0x02);
    c._onSpectrum(new DataView(buf));
    assert.strictEqual(frames.length, 0);
});

t('config message updates geometry and clears stale deltas', () => {
    const c = new SpectrumConnection();
    let cfg = null;
    c.on('config', (x) => { cfg = x; });
    c._onSpectrum(new DataView(fullFloat32([-100, -100], 7100000)));
    c._onControl({ type: 'config', centerFreq: 14200000, binCount: 4, binBandwidth: 25, defaultBinCount: 8, defaultBinBandwidth: 50 });
    assert.strictEqual(cfg.span, 100);
    assert.strictEqual(c._float, null, 'bin-count change must drop the delta accumulator');
});

// --- zoom stepping ---------------------------------------------------------
//
// The server quantises binBandwidth onto a fixed ladder before applying it
// (user_spectrum_websocket.go). A zoom step gentler than the ladder's spacing
// rounds back to the rung it started on, so the view never changes. These tests
// exist to stop the step size drifting back to something "smoother".

// Mirrors the server's safe-bin_bw rounding.
function serverLadder(binBW) {
    if (binBW < 0.75) return 0.5;
    if (binBW < 1.5) return 1;
    if (binBW < 3) return 2;
    if (binBW < 7) return 5;
    if (binBW < 15) return 10;
    if (binBW < 35) return 20;
    if (binBW < 75) return 50;
    if (binBW < 150) return 100;
    if (binBW < 250) return 200;
    if (binBW < 400) return 300;
    if (binBW < 750) return 500;
    if (binBW < 1500) return 1000;
    if (binBW < 3500) return 2000;
    if (binBW < 7500) return 5000;
    return binBW;   // pass-through for full-bandwidth views
}

// The only bin bandwidths a session can actually be sitting at — the ladder is
// not a power-of-two series, so stepping has to be checked from these, not from
// arbitrary values.
const RUNGS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 5000];

t('halving moves to a lower rung from every reachable rung', () => {
    for (const bw of RUNGS.slice(1)) {
        const landed = serverLadder(bw / 2);
        assert.ok(landed < bw, `halving ${bw} landed on ${landed}`);
    }
});

t('doubling moves to a higher rung from every reachable rung', () => {
    for (const bw of RUNGS) {
        const landed = serverLadder(bw * 2);
        assert.ok(landed > bw, `doubling ${bw} landed on ${landed}`);
    }
});

t('a gentle 1.25x step stalls — this is why the step is 2x', () => {
    // Reproduces the original bug: from the 5000 Hz/bin rung neither direction
    // moves, so the spectrum appears frozen at three or four zoom levels.
    assert.strictEqual(serverLadder(5000 * 1.25), 5000);
    assert.strictEqual(serverLadder(5000 * 0.8), 5000);
});

t('UI zoom floor is a span, independent of bin count', () => {
    const c = new SpectrumConnection();
    c._onControl({ type: 'config', centerFreq: 15e6, binCount: 1024, binBandwidth: 29296.875, defaultBinCount: 1024, defaultBinBandwidth: 29296.875 });
    assert.strictEqual(c.minBinBandwidthForUI() * 1024, 2048);
    const d = new SpectrumConnection();
    d._onControl({ type: 'config', centerFreq: 15e6, binCount: 2048, binBandwidth: 14648.4375, defaultBinCount: 2048, defaultBinBandwidth: 14648.4375 });
    assert.strictEqual(d.minBinBandwidthForUI() * 2048, 2048);
});

t('full-span bin bandwidth survives a missing server default', () => {
    const c = new SpectrumConnection();
    // Server that omits defaultBinBandwidth: must still yield the full-view
    // value, or zoom-out clamps to wherever the user happens to be.
    c._onControl({ type: 'config', centerFreq: 15e6, binCount: 2048, binBandwidth: 14648.4375 });
    assert.strictEqual(c.fullSpanBinBandwidth(), 14648.4375);
    assert.ok(c.fullSpanBinBandwidth() * 2048 > 29e6);
});

// --- squelch ---------------------------------------------------------------
//
// Squelch is the server-side audio gate. The slider's floor doubles as "off",
// which is what v1 does — a separate enable flag can disagree with the value.

t('slider floor means off, and sends the sentinel', () => {
    assert.strictEqual(squelchThreshold(SQUELCH_MIN), SQUELCH_SENTINEL);
    assert.strictEqual(squelchEnabled(SQUELCH_MIN), false);
    // Anything at or below the floor is off, so a stale stored value cannot
    // resurrect as a live threshold. Written against SQUELCH_MIN rather than a
    // literal: the floor is negative now that the scale is a true SNR, and 0 dB
    // — once comfortably below it — is a usable threshold.
    assert.strictEqual(squelchThreshold(SQUELCH_MIN - 10), SQUELCH_SENTINEL);
    assert.strictEqual(squelchEnabled(SQUELCH_MIN - 0.5), false);
});

t('above the floor the slider value is the threshold in dB SNR', () => {
    assert.strictEqual(squelchThreshold(SQUELCH_MIN + 0.5), SQUELCH_MIN + 0.5);
    assert.strictEqual(squelchEnabled(SQUELCH_MIN + 0.5), true);
    assert.strictEqual(squelchThreshold(SQUELCH_MAX), SQUELCH_MAX);
});

t('auto-set sits ABOVE the recent noise, not below it', () => {
    // The gate opens at snr >= threshold, so a threshold under the measured
    // noise leaves it permanently open — the bug this guards against.
    const noise = [30, 30, 30, 30, 30];
    const v = autoSquelchValue(noise);
    assert.ok(v > 30, `auto gave ${v}, which would never close the gate`);
    assert.strictEqual(v, 33);   // avg + 3 dB headroom
});

t('auto-set averages the last five readings only', () => {
    // Older, unrepresentative readings must not drag the result.
    const history = [0, 0, 0, 0, 0, 40, 40, 40, 40, 40];
    assert.strictEqual(autoSquelchValue(history), 43);
});

t('auto-set rounds to the slider step and stays in range', () => {
    assert.strictEqual(autoSquelchValue([30.1, 30.2]) % SQUELCH_STEP, 0);
    // Below the floor it must not land on "off".
    const low = autoSquelchValue([-50]);
    assert.ok(low > SQUELCH_MIN, `${low} would read as off`);
    assert.strictEqual(squelchEnabled(low), true);
    // Above the ceiling it clamps.
    assert.strictEqual(autoSquelchValue([500]), SQUELCH_MAX);
});

t('auto-set with no history does nothing', () => {
    assert.strictEqual(autoSquelchValue([]), null);
    assert.strictEqual(autoSquelchValue(null), null);
});

t('setAudioGate emits the server field names and records for reconnect', () => {
    const a = new AudioConnection();
    const sent = [];
    a.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    global.WebSocket = { OPEN: 1 };

    a.setAudioGate({ minSnr: 30 });
    assert.deepStrictEqual(sent[0], { type: 'set_audio_gate', min_snr: 30 });
    assert.deepStrictEqual(a.lastGate, { minSnr: 30, minPower: undefined });

    a.setAudioGate({ minSnr: SQUELCH_SENTINEL });
    assert.deepStrictEqual(sent[1], { type: 'set_audio_gate', min_snr: -999 });
});

t('setAudioGate with no thresholds is not sent', () => {
    const a = new AudioConnection();
    const sent = [];
    a.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    global.WebSocket = { OPEN: 1 };
    // The server rejects a gate message carrying neither field.
    assert.strictEqual(a.setAudioGate({}), false);
    assert.strictEqual(sent.length, 0);
});

// --- chat mentions ---------------------------------------------------------
//
// Matches v1's chat-ui.js so both frontends agree on what counts as being
// spoken to and how tab completion behaves.

const CHAT_USERS = ['alice', 'alan', 'Bob', 'bobby', 'M0TEST-1', 'me'];

t('a mention query only fires at the caret', () => {
    assert.deepStrictEqual(mn.mentionQuery('hi @al'), { partial: 'al', at: 3 });
    assert.deepStrictEqual(mn.mentionQuery('@'), { partial: '', at: 0 });
    // Not a query: the @ is not adjacent to the caret.
    assert.strictEqual(mn.mentionQuery('hi @alice there'), null);
    assert.strictEqual(mn.mentionQuery('no at sign'), null);
    // A second @ later in the line is the one being completed.
    assert.deepStrictEqual(mn.mentionQuery('@bob hi @al'), { partial: 'al', at: 8 });
});

t('an emoji query needs a colon and at least one letter', () => {
    assert.deepStrictEqual(mn.emojiQuery('nice :fi'), { partial: 'fi', at: 5 });
    // A bare colon is punctuation far more often than the start of an emoji,
    // so it offers nothing — v1 waits for a character too.
    assert.strictEqual(mn.emojiQuery('nice :'), null);
    assert.strictEqual(mn.emojiQuery('hi :fire: there'), null, 'not at the caret');
    // Typing a time does fire a query — v1's pattern is the same — but nothing
    // matches "30", so no list appears. That is the safeguard, not the regex.
    assert.deepStrictEqual(mn.emojiQuery('10:30'), { partial: '30', at: 2 });
    assert.deepStrictEqual(mn.matchShortcodes('30'), []);
});

t('shortcodes complete to the emoji itself, not to :code:', () => {
    assert.deepStrictEqual(mn.matchShortcodes('thumb'), ['thumbsdown', 'thumbsup']);
    const r = mn.applyEmojiCompletion('nice :fi', 8, 'fire');
    assert.strictEqual(r.text, `nice ${mn.EMOJI_SHORTCODES.fire}`);
    assert.strictEqual(r.cursor, r.text.length);
    // Text after the caret survives.
    const mid = mn.applyEmojiCompletion('nice :fi day', 8, 'fire');
    assert.strictEqual(mid.text, `nice ${mn.EMOJI_SHORTCODES.fire} day`);
});

t('a shortcode typed in full is expanded on the way out', () => {
    assert.strictEqual(mn.expandShortcodes('nice :fire:'), `nice ${mn.EMOJI_SHORTCODES.fire}`);
    assert.strictEqual(mn.expandShortcodes(':wave: :wave:'), `${mn.EMOJI_SHORTCODES.wave} ${mn.EMOJI_SHORTCODES.wave}`);
    // Anything that is not a shortcode is left exactly as typed.
    assert.strictEqual(mn.expandShortcodes('at 10:30:00'), 'at 10:30:00');
    assert.strictEqual(mn.expandShortcodes(':nope:'), ':nope:');
    assert.strictEqual(mn.expandShortcodes(''), '');
    assert.strictEqual(mn.expandShortcodes(null), '');
});

t('every picker emoji has a shortcode to type instead', () => {
    // The picker teaches the shortcodes through its tooltips, so an emoji with
    // no name behind it is a dead end.
    const picker = [
        '\u{1F60A}', '\u{1F602}', '\u{1F923}', '\u{1F60D}', '\u{1F60E}', '\u{1F914}', '\u{1F44D}', '\u{1F44E}',
        '\u2764\uFE0F', '\u{1F389}', '\u{1F525}', '\u2B50', '\u2728', '\u{1F4AF}', '\u{1F680}', '\u{1F3AF}',
        '\u{1F44B}', '\u{1F64F}', '\u{1F4AA}', '\u{1F91D}', '\u{1F44F}', '\u{1F3B5}', '\u{1F4FB}', '\u{1F4E1}',
        '\u{1F31F}', '\u{1F4A1}', '\u26A1', '\u{1F308}', '\u2600\uFE0F', '\u{1F319}', '\u2699\uFE0F', '\u{1F527}',
    ];
    for (const e of picker) {
        assert.ok(mn.shortcodeFor(e), `no shortcode for ${e}`);
    }
});

t('candidates are prefix matches, sorted, excluding yourself', () => {
    assert.deepStrictEqual(mn.matchUsernames(CHAT_USERS, 'al', 'me'), ['alan', 'alice']);
    assert.deepStrictEqual(mn.matchUsernames(CHAT_USERS, 'BO', 'me'), ['Bob', 'bobby']);
    assert.ok(!mn.matchUsernames(CHAT_USERS, 'm', 'me').includes('me'), 'offered your own name');
    // An empty partial offers everyone else.
    assert.strictEqual(mn.matchUsernames(CHAT_USERS, '', 'me').length, CHAT_USERS.length - 1);
});

t('completion replaces the partial and leaves a trailing space', () => {
    const r = mn.applyCompletion('hi @al', 6, 'alice');
    assert.strictEqual(r.text, 'hi @alice ');
    assert.strictEqual(r.cursor, r.text.length);
    // Text after the caret is preserved.
    const mid = mn.applyCompletion('hi @al world', 6, 'alice');
    assert.strictEqual(mid.text, 'hi @alice  world');
    assert.strictEqual(mid.cursor, 10);
});

t('completion is a no-op when there is nothing to complete', () => {
    const r = mn.applyCompletion('plain text', 5, 'alice');
    assert.strictEqual(r.text, 'plain text');
});

t('mention detection matches v1: case-insensitive substring', () => {
    assert.strictEqual(mn.isMention('hey @Bob look', 'bob'), true);
    assert.strictEqual(mn.isMention('hey @BOB', 'Bob'), true);
    assert.strictEqual(mn.isMention('hey bob', 'bob'), false, 'no @ is not a mention');
    assert.strictEqual(mn.isMention('hey @bob', ''), false, 'anonymous users are never mentioned');
    assert.strictEqual(mn.isMention('hey @bob', null), false);
    // v1 uses a plain substring, so a longer name also alerts the shorter one.
    // Kept identical on purpose — diverging would make the two frontends
    // disagree about whether you were spoken to.
    assert.strictEqual(mn.isMention('hey @bobby', 'bob'), true);
});

t('highlighting splits out every mention', () => {
    const parts = mn.splitMentions('hi @alice and @Bob!', CHAT_USERS);
    assert.deepStrictEqual(parts.map((p) => p.text), ['hi ', '@alice', ' and ', '@Bob', '!']);
    assert.deepStrictEqual(parts.filter((p) => p.mention).map((p) => p.mention), ['alice', 'Bob']);
});

t('the longest matching name wins, so @bobby is not split as @bob', () => {
    const parts = mn.splitMentions('yo @bobby', CHAT_USERS);
    assert.deepStrictEqual(parts.filter((p) => p.mention).map((p) => p.text), ['@bobby']);
});

t('a name with regex characters cannot break highlighting', () => {
    const parts = mn.splitMentions('hi @a.b+c', ['a.b+c']);
    assert.deepStrictEqual(parts.filter((p) => p.mention).map((p) => p.text), ['@a.b+c']);
    // And a literal that only looks like the pattern is not matched.
    assert.strictEqual(mn.splitMentions('hi @axbyc', ['a.b+c']).some((p) => p.mention), false);
});

t('no users means nothing to highlight', () => {
    assert.deepStrictEqual(mn.splitMentions('hi @alice', []), [{ text: 'hi @alice' }]);
});

// --- marker bar ------------------------------------------------------------
//
// Sample payloads are verbatim from a live server: 2450 bookmarks and 202 band
// allocations. At full span every one is "visible", which is exactly the case
// the density cap and the binary-search window exist for.

const MARKS = JSON.parse(require('fs').readFileSync(__dirname + '/bookmarks.sample.json', 'utf8'))
    .sort((a, b) => a.frequency - b.frequency);
const BANDS = JSON.parse(require('fs').readFileSync(__dirname + '/bands.sample.json', 'utf8'));
const measure = (b) => Math.min(140, b.name.length * 6 + 10);

t('the visible window is sliced, not scanned', () => {
    // A 10 kHz window out of 0-30 MHz must yield a handful, not thousands.
    const win = mk.visibleBookmarks(MARKS, 7100000, 7110000);
    assert.ok(win.length < 50, `${win.length} in a 10 kHz window`);
    assert.ok(win.every((b) => b.frequency >= 7100000 && b.frequency <= 7110000));
    // And the boundaries are inclusive on both ends.
    const exact = MARKS[100].frequency;
    assert.ok(mk.visibleBookmarks(MARKS, exact, exact).some((b) => b.frequency === exact));
});

// Voice activity markers are laid out after the bookmarks and must not land on
// them — assignRows takes the bookmark placements as already-occupied space.
t('a seeded row is not handed out again', () => {
    const occupied = [{ x: 100, width: 60, row: 0 }];
    const placed = mk.assignRows([{ x: 100, width: 60 }], occupied);
    assert.strictEqual(placed.length, 1);
    assert.strictEqual(placed[0].row, 1, 'should have been pushed to the free row');
});

t('seeded markers are never returned as placements of their own', () => {
    const occupied = [{ x: 10, width: 20, row: 0 }, { x: 200, width: 20, row: 1 }];
    const placed = mk.assignRows([{ x: 100, width: 20 }], occupied);
    assert.strictEqual(placed.length, 1);
    assert.strictEqual(placed[0].x, 100);
});

t('a marker with both rows taken at that x is dropped, not stacked', () => {
    const occupied = [{ x: 50, width: 40, row: 0 }, { x: 50, width: 40, row: 1 }];
    assert.deepStrictEqual(mk.assignRows([{ x: 50, width: 40 }], occupied), []);
});

t('seeding leaves clear space usable', () => {
    const occupied = [{ x: 50, width: 40, row: 0 }, { x: 50, width: 40, row: 1 }];
    const placed = mk.assignRows([{ x: 300, width: 40 }], occupied);
    assert.strictEqual(placed.length, 1);
    assert.strictEqual(placed[0].row, 0);
});

t('with nothing seeded the layout is unchanged', () => {
    const items = [{ x: 10, width: 20 }, { x: 100, width: 20 }];
    assert.deepStrictEqual(
        mk.assignRows(items.map((i) => ({ ...i }))),
        mk.assignRows(items.map((i) => ({ ...i })), []),
    );
});

t('lowerBound finds the first index at or after the target', () => {
    const arr = [10, 20, 30, 40].map((f) => ({ frequency: f }));
    assert.strictEqual(mk.lowerBound(arr, 5), 0);
    assert.strictEqual(mk.lowerBound(arr, 20), 1);
    assert.strictEqual(mk.lowerBound(arr, 25), 2);
    assert.strictEqual(mk.lowerBound(arr, 99), 4);
});

t('a layer that outranks the bookmarks keeps its row', () => {
    // The VFO markers are laid out before the bookmarks and handed to them as
    // occupied space: a VFO is somewhere you put down yourself, and a bookmark
    // shuffling it up a row — or off the bar — would be the wrong way round.
    const vfo = { x: 100, width: 13, row: 1 };
    const placed = mk.layoutBookmarks({
        sorted: [{ name: 'X', frequency: 7.1e6 }],
        startFreq: 7.0e6,
        endFreq: 7.2e6,
        width: 200,
        measure: () => 60,
        occupied: [vfo],
    });
    assert.ok(placed.every((p) => p.row !== vfo.row), 'a bookmark took the VFO row');
    assert.ok(!placed.includes(vfo), 'and the seed is not drawn twice');
});

t('without a seed the bookmarks lay out as they always did', () => {
    const args = {
        sorted: [{ name: 'X', frequency: 7.1e6 }],
        startFreq: 7.0e6, endFreq: 7.2e6, width: 200, measure: () => 60,
    };
    assert.deepStrictEqual(mk.layoutBookmarks(args), mk.layoutBookmarks({ ...args, occupied: [] }));
});

t('full span with 2450 bookmarks yields a readable handful', () => {
    const placed = mk.layoutBookmarks({
        sorted: MARKS, startFreq: 0, endFreq: 30e6, width: 1600, measure,
    });
    assert.ok(placed.length <= mk.MAX_MARKERS, `${placed.length} markers`);
    // Enough to be useful, few enough to read. v1 draws 100 here, most of them
    // stacked on top of each other.
    assert.ok(placed.length >= 15, `only ${placed.length} survived`);
});

t('markers never overlap, at any zoom', () => {
    // The point of dropping: whatever the span or width, no row collides with
    // itself. This is the check that would have caught the overloaded bar.
    for (const [lo, hi, w] of [
        [0, 30e6, 1600], [0, 30e6, 400], [7.0e6, 7.3e6, 1200],
        [7.1e6, 7.11e6, 800], [0, 30e6, 3000],
    ]) {
        const placed = mk.layoutBookmarks({ sorted: MARKS, startFreq: lo, endFreq: hi, width: w, measure });
        for (const row of [0, 1]) {
            const inRow = placed.filter((p) => p.row === row);
            for (let i = 1; i < inRow.length; i++) {
                const gap = (inRow[i].x - inRow[i].width / 2) - (inRow[i - 1].x + inRow[i - 1].width / 2);
                assert.ok(gap >= mk.ROW_GAP_PX,
                    `span ${(hi - lo) / 1e6}MHz w=${w} row ${row}: ${gap.toFixed(1)}px gap`);
            }
        }
    }
});

t('a narrower bar keeps fewer markers', () => {
    const wide = mk.layoutBookmarks({ sorted: MARKS, startFreq: 0, endFreq: 30e6, width: 2400, measure });
    const narrow = mk.layoutBookmarks({ sorted: MARKS, startFreq: 0, endFreq: 30e6, width: 400, measure });
    assert.ok(wide.length > narrow.length, `${wide.length} vs ${narrow.length}`);
});

t('capped markers stay spread across the width', () => {
    const placed = mk.layoutBookmarks({
        sorted: MARKS, startFreq: 0, endFreq: 30e6, width: 1600, measure,
    });
    // Evenly sampled, so both edges of the canvas must be represented — a naive
    // "first 100" would bunch everything at the left.
    const xs = placed.map((p) => p.x);
    assert.ok(Math.min(...xs) < 200, `leftmost at ${Math.min(...xs)}`);
    assert.ok(Math.max(...xs) > 1400, `rightmost at ${Math.max(...xs)}`);
});

t('the density cap keeps local bookmarks and samples the server ones', () => {
    // Five of yours scattered across the band, against a couple of thousand
    // published ones — the cap must not be allowed to drop yours.
    const local = [1.5e6, 7.05e6, 14.2e6, 21.3e6, 28.4e6].map((frequency, i) => ({
        name: `Mine ${i}`, frequency, mode: 'usb', source: 'local',
    }));
    const sorted = MARKS.concat(local).sort((a, b) => a.frequency - b.frequency);

    const placed = mk.layoutBookmarks({ sorted, startFreq: 0, endFreq: 30e6, width: 1600, measure });
    const kept = placed.filter((p) => p.item.source === 'local').map((p) => p.item.name);

    // Row assignment may still drop one that physically collides, but the
    // sampling stage must have carried every one of them through.
    const capped = mk.capDensity(
        sorted.map((b, i) => ({ item: b, x: i, width: 10 })),
        100,
    );
    assert.strictEqual(
        capped.filter((it) => it.item.source === 'local').length, local.length,
        'the density cap dropped a local bookmark',
    );
    assert.ok(capped.length <= 100, `${capped.length} survived a cap of 100`);
    assert.ok(kept.length >= 4, `only ${kept.length} local markers survived layout: ${kept}`);
});

t('both rows are used before anything is dropped', () => {
    const placed = mk.layoutBookmarks({
        sorted: MARKS, startFreq: 7000000, endFreq: 7300000, width: 1200, measure,
    });
    assert.ok(placed.some((p) => p.row === 1), 'nothing was pushed to the second row');
    assert.ok(placed.some((p) => p.row === 0), 'nothing on the first row');
});

t('an empty or absent catalogue lays out nothing', () => {
    assert.deepStrictEqual(mk.layoutBookmarks({ sorted: [], startFreq: 0, endFreq: 1e6, width: 100, measure }), []);
    assert.deepStrictEqual(mk.visibleBookmarks(null, 0, 1e6), []);
    assert.deepStrictEqual(mk.layoutBands({ bands: null, startFreq: 0, endFreq: 1e6, width: 100 }), []);
});

t('a zero-width or zero-span view lays out nothing', () => {
    assert.deepStrictEqual(mk.layoutBookmarks({ sorted: MARKS, startFreq: 0, endFreq: 0, width: 100, measure }), []);
    assert.deepStrictEqual(mk.layoutBookmarks({ sorted: MARKS, startFreq: 0, endFreq: 1e6, width: 0, measure }), []);
});

t('bands are clipped to the view and ordered widest first', () => {
    const spans = mk.layoutBands({ bands: BANDS, startFreq: 7000000, endFreq: 7300000, width: 1000 });
    assert.ok(spans.length > 0);
    for (const s of spans) {
        assert.ok(s.x0 >= 0 && s.x1 <= 1000, `${s.x0}..${s.x1} outside the canvas`);
    }
    // Widest first, so narrow allocations paint on top of the wide ones.
    for (let i = 1; i < spans.length; i++) {
        const prev = spans[i - 1].band.end - spans[i - 1].band.start;
        const cur = spans[i].band.end - spans[i].band.start;
        assert.ok(prev >= cur, 'bands are not widest-first');
    }
});

t('band labels repeat without overlapping, however long the name', () => {
    const xs = mk.bandLabelPositions({ x0: 0, x1: 1000, labelWidth: 80 });
    assert.ok(xs.length >= 2, `${xs.length} labels across 1000px`);
    for (let i = 1; i < xs.length; i++) {
        assert.ok(xs[i] - xs[i - 1] >= 80, `labels ${(xs[i] - xs[i - 1]).toFixed(0)}px apart, need 80`);
    }
    // A very long name simply repeats less often rather than colliding.
    const wide = mk.bandLabelPositions({ x0: 0, x1: 1000, labelWidth: 400 });
    for (let i = 1; i < wide.length; i++) {
        assert.ok(wide[i] - wide[i - 1] >= 400, 'long labels collide');
    }
});

t('narrow bands get no label, and labels stay inside the band', () => {
    assert.deepStrictEqual(mk.bandLabelPositions({ x0: 0, x1: 20, labelWidth: 40 }), []);
    const xs = mk.bandLabelPositions({ x0: 100, x1: 200, labelWidth: 60 });
    for (const x of xs) {
        assert.ok(x - 30 >= 100 - 0.001 && x + 30 <= 200 + 0.001, `label at ${x} escapes 100..200`);
    }
});

t('band colours follow v1 intensity', () => {
    const mid = mk.bandColors(0.5);
    assert.strictEqual(mid.length, 10);
    assert.ok(mid[0].endsWith('0.2)'), mid[0]);
    const full = mk.bandColors(1);
    assert.ok(full[0].endsWith('0.8)'), full[0]);
    // Out-of-range or missing config falls back to the pastel default.
    assert.deepStrictEqual(mk.bandColors(undefined), mid);
    assert.deepStrictEqual(mk.bandColors(0), mid);
});

// --- tuning steps ----------------------------------------------------------

t('stepping snaps to the step boundary from an odd frequency', () => {
    // 7.100123 MHz, 500 Hz step -> 7.100500 up, 7.100000 down.
    assert.strictEqual(snapStep(7100123, 500, 1), 7100500);
    assert.strictEqual(snapStep(7100123, 500, -1), 7100000);
    assert.strictEqual(snapStep(7100001, 1000, 1), 7101000);
    assert.strictEqual(snapStep(7100999, 1000, -1), 7100000);
});

t('already on a boundary, a press moves one whole step', () => {
    assert.strictEqual(snapStep(7100000, 500, 1), 7100500);
    assert.strictEqual(snapStep(7100000, 500, -1), 7099500);
    assert.strictEqual(snapStep(14200000, 100000, 1), 14300000);
});

t('a press never moves the opposite way', () => {
    // Rounding to nearest would send + downwards when just past a boundary.
    for (const step of [1, 10, 100, 500, 1000, 5000, 9000, 10000]) {
        for (const f of [7100001, 7100499, 7100999, 14200321, 9599999]) {
            assert.ok(snapStep(f, step, 1) > f, `+${step} from ${f}`);
            assert.ok(snapStep(f, step, -1) < f, `-${step} from ${f}`);
        }
    }
});

t('every landing point is a multiple of the step', () => {
    for (const step of [10, 100, 500, 1000, 9000, 10000]) {
        for (const f of [123456, 7100123, 14200321, 29999999]) {
            assert.strictEqual(snapStep(f, step, 1) % step, 0, `+${step} from ${f}`);
            assert.strictEqual(snapStep(f, step, -1) % step, 0, `-${step} from ${f}`);
        }
    }
});

t('a 1 Hz step still moves by exactly 1 Hz', () => {
    assert.strictEqual(snapStep(7100123, 1, 1), 7100124);
    assert.strictEqual(snapStep(7100123, 1, -1), 7100122);
});

// --- S-meter ---------------------------------------------------------------
//
// Mapping matches v1's s-meter-needle.js: S9 = -73 dBFS, 6 dB per S-unit below,
// 10 dB per unit above. The bar and the S label must agree, and both must line
// up with the printed scale.

t('S-unit mapping matches v1 (S1 = -121, S9 = -73 dBFS)', () => {
    assert.strictEqual(dbfsToSUnits(-121), 1);
    assert.strictEqual(dbfsToSUnits(-97), 5);
    assert.strictEqual(dbfsToSUnits(-73), 9);
    assert.strictEqual(dbfsToSUnits(-53), 11);   // S9+20, 10 dB per unit above S9
    assert.strictEqual(dbfsToSUnits(-13), 15);   // S9+60
    assert.strictEqual(dbfsToSUnits(-130), 0);
});

t('labels read the same as v1', () => {
    assert.strictEqual(sUnitLabel(-121), 'S1');
    assert.strictEqual(sUnitLabel(-97), 'S5');
    assert.strictEqual(sUnitLabel(-73), 'S9');
    assert.strictEqual(sUnitLabel(-53), 'S9+20');
    assert.strictEqual(sUnitLabel(-13), 'S9+60');
    assert.strictEqual(sUnitLabel(-130), 'S0');
    assert.strictEqual(sUnitLabel(null), '--');
    assert.strictEqual(sUnitLabel(-999), '--');
});

t('the bar lines up with the printed scale', () => {
    // The scale prints eight evenly spaced ticks, so each must land on an even
    // fraction of the bar. A linear dBFS bar put S1 at 16% and clipped +60.
    const ticks = [
        ['S1', -121], ['S3', -109], ['S5', -97], ['S7', -85],
        ['S9', -73], ['+20', -53], ['+40', -33], ['+60', -13],
    ];
    ticks.forEach(([name, dbfs], i) => {
        const want = i / (ticks.length - 1);
        const got = sUnitFraction(dbfs);
        assert.ok(Math.abs(got - want) < 1e-9,
            `${name} at ${(got * 100).toFixed(1)}%, printed scale puts it at ${(want * 100).toFixed(1)}%`);
    });
});

t('the S-meter colours are v1s ramp: red at S1, yellow at S5, green from S9', () => {
    assert.strictEqual(sMeterColour(-121), 'hsl(0, 90%, 55%)');    // S1
    assert.strictEqual(sMeterColour(-97), 'hsl(60, 90%, 55%)');    // S5
    assert.strictEqual(sMeterColour(-73), 'hsl(120, 90%, 55%)');   // S9
    // The colour runs out at S9; everything above it is as green as it gets.
    assert.strictEqual(sMeterColour(-33), sMeterColour(-73));
    // No reading is grey, not red — red is a real, weak signal.
    assert.strictEqual(sMeterColour(null), 'hsl(0, 0%, 55%)');
    assert.strictEqual(sMeterColour(-999), 'hsl(0, 0%, 55%)');
});

t('a colour from a meter position matches the colour from the reading', () => {
    // The needle knows where it points, not what dBFS put it there, so the two
    // ways in must agree or the needle and its own scale differ.
    for (const dbfs of [-121, -109, -97, -85, -73, -53, -13]) {
        assert.strictEqual(sMeterColourAt(sUnitFraction(dbfs)), sMeterColour(dbfs), `${dbfs} dBFS`);
    }
    // Positions taken from snrFraction rather than an open-coded span, so the
    // pair stays honest when the scale moves — as it did when the SNR stopped
    // being S/N0 in dB·Hz and became an SNR in dB.
    for (const snr of [SNR_MIN, -2, 0, 5, 10, 15, 20, SNR_MAX]) {
        assert.strictEqual(snrColourAt(snrFraction(snr)), snrColour(snr), `${snr} dB`);
    }
});

t('the held S value reads the same as a live one at the same place', () => {
    // The peak is carried as a position on the scale, so its label has to come
    // out the same as the live label for the reading that put it there — a hold
    // of S9+20 printed as S9+19 would be its own bug report.
    for (let dbfs = -121; dbfs <= -13; dbfs += 0.5) {
        assert.strictEqual(sUnitLabelAt(sUnitFraction(dbfs)), sUnitLabel(dbfs), `${dbfs} dBFS`);
    }
    assert.strictEqual(sUnitLabelAt(1), 'S9+60');
    // Below S1 there is no position to hold: the scale starts at S1, so
    // everything quieter sits at 0 alongside it. The panel prints no hold at
    // all down there rather than choosing between S0 and S1.
    assert.strictEqual(sUnitFraction(-130), sUnitFraction(-121));
    assert.strictEqual(sUnitLabelAt(0), 'S1');
});

// --- the type-in frequency box ----------------------------------------------
//
// Both places you can type a frequency — the top bar's readout and the Receiver
// panel's dial — are the same FreqEntry over parseFreqInput, so this is the
// whole contract for what either of them accepts.

t('a bare number is kHz, with or without a decimal point', () => {
    assert.strictEqual(parseFreqInput('14175'), 14175000);
    assert.strictEqual(parseFreqInput('7100'), 7100000);
    assert.strictEqual(parseFreqInput('198'), 198000);
    // Sub-kHz precision is still reachable, which is what the decimal is for.
    assert.strictEqual(parseFreqInput('14175.5'), 14175500);
    assert.strictEqual(parseFreqInput('7100.001'), 7100001);
});

t('a written unit is taken at its word, whatever the number looks like', () => {
    assert.strictEqual(parseFreqInput('7.1M'), 7100000);
    assert.strictEqual(parseFreqInput('7.1mhz'), 7100000);
    assert.strictEqual(parseFreqInput('7100k'), 7100000);
    assert.strictEqual(parseFreqInput('7100khz'), 7100000);
    assert.strictEqual(parseFreqInput('7100000hz'), 7100000);
    // Spacing and case are noise.
    assert.strictEqual(parseFreqInput('  7100 KHz '), 7100000);
});

t('the readout\'s own grouped form pastes straight back in', () => {
    // What the dial displays for 14.175 MHz — two separators, so it can only be
    // the grouped Hz form and never a decimal.
    assert.strictEqual(parseFreqInput('14.175.000'), 14175000);
    assert.strictEqual(parseFreqInput('0.198.000'), 198000);
});

t('nothing usable reads as nothing, never as zero', () => {
    assert.strictEqual(parseFreqInput(''), null);
    assert.strictEqual(parseFreqInput('   '), null);
    assert.strictEqual(parseFreqInput(null), null);
    assert.strictEqual(parseFreqInput('abc'), null);
    // A suffix with no number left to scale — Number('') is 0, which would
    // otherwise tune to DC instead of being refused.
    assert.strictEqual(parseFreqInput('k'), null);
    assert.strictEqual(parseFreqInput('mhz'), null);
    assert.strictEqual(parseFreqInput('.'), null);
});

t('the range is the receiver\'s, and both ends are inclusive', () => {
    assert.ok(freqInRange(MIN_FREQ));
    assert.ok(freqInRange(MAX_FREQ));
    assert.ok(freqInRange(14175000));
    assert.ok(!freqInRange(MIN_FREQ - 1));
    assert.ok(!freqInRange(MAX_FREQ + 1));
    assert.ok(!freqInRange(0));
    assert.ok(!freqInRange(-7100000));
    assert.ok(!freqInRange(null));
    assert.ok(!freqInRange(NaN));
});

t('typing the range\'s own bounds in kHz lands exactly on them', () => {
    assert.strictEqual(parseFreqInput('10'), MIN_FREQ);
    assert.strictEqual(parseFreqInput('30000'), MAX_FREQ);
    // And a step outside either is refused rather than clamped.
    assert.ok(!freqInRange(parseFreqInput('9.999')));
    assert.ok(!freqInRange(parseFreqInput('30000.001')));
});

t('the box opens on the current frequency, in kHz, without trailing zeros', () => {
    assert.strictEqual(freqToKHz(14175000), '14175');
    assert.strictEqual(freqToKHz(7100000), '7100');
    assert.strictEqual(freqToKHz(10000), '10');
    assert.strictEqual(freqToKHz(14175500), '14175.5');
    assert.strictEqual(freqToKHz(null), '');
});

t('what the box opens with is what it would commit unchanged', () => {
    // Open, touch nothing, press Enter: the frequency must not move. This is
    // the round trip that a unit change is most likely to break.
    for (const hz of [10000, 198000, 7100000, 14175500, 27500123, 30000000]) {
        const back = parseFreqInput(freqToKHz(hz));
        assert.strictEqual(Math.round(back), hz, `${hz} Hz did not survive the round trip`);
        assert.ok(freqInRange(back), `${hz} Hz came back out of range`);
    }
});

t('a link rate reads in bits, and scales', () => {
    // Bytes per second in, bits per second out — a socket is quoted in bits.
    assert.strictEqual(formatRate(0), '0.0 kbit/s');
    assert.strictEqual(formatRate(1000), '8.0 kbit/s');       // 8 kbit
    assert.strictEqual(formatRate(6000), '48 kbit/s');        // Opus + control
    assert.strictEqual(formatRate(250000), '2.00 Mbit/s');
    // Nothing measured yet is not the same as nothing flowing.
    assert.strictEqual(formatRate(null), '—');
    assert.strictEqual(formatRate(NaN), '—');
});

t('the bar and the S label never disagree', () => {
    // Walk the whole range: wherever the label says S9, the bar must be at the
    // S9 tick, and so on.
    for (let dbfs = -130; dbfs <= -10; dbfs += 0.5) {
        const frac = sUnitFraction(dbfs);
        const units = S_UNITS_MIN + frac * (S_UNITS_MAX - S_UNITS_MIN);
        const fromLabel = dbfsToSUnits(dbfs);
        if (fromLabel >= S_UNITS_MIN && fromLabel <= S_UNITS_MAX) {
            assert.ok(Math.abs(units - fromLabel) < 1e-9,
                `at ${dbfs} dBFS bar=${units.toFixed(2)} label=${fromLabel.toFixed(2)} S-units`);
        }
    }
});

t('the bar clamps instead of overflowing', () => {
    assert.strictEqual(sUnitFraction(-200), 0);
    assert.strictEqual(sUnitFraction(0), 1);
    assert.strictEqual(sUnitFraction(null), 0);
    assert.strictEqual(sUnitFraction(-999), 0);
});

// --- operator UI config ----------------------------------------------------
//
// ui-config.sample.json is a verbatim /api/ui-config reply from a live server.

const UI_SAMPLE = JSON.parse(require('fs').readFileSync(__dirname + '/ui-config.sample.json', 'utf8'));

t('the whole ui-config is kept, not just the keys in use', () => {
    const parsed = parseUiConfig(UI_SAMPLE);
    assert.strictEqual(parsed.loaded, true);
    // Every operator setting must stay reachable for future features.
    for (const k of Object.keys(UI_SAMPLE)) {
        assert.ok(k in parsed.config, `dropped ${k}`);
    }
    assert.deepStrictEqual(parsed.config, UI_SAMPLE);
    // Nested objects survive intact too.
    assert.strictEqual(typeof parsed.config.theme, 'object');
});

t('backdrop settings are parsed and validated onto the top level', () => {
    const parsed = parseUiConfig(UI_SAMPLE);
    assert.strictEqual(parsed.bgImage, UI_SAMPLE.spectrum_bg_image);
    assert.strictEqual(parsed.bgOpacity, UI_SAMPLE.spectrum_bg_opacity);
});

t("the operator's default audio buffer is read from the same reply", () => {
    // Sent as a string of milliseconds; the player works in seconds.
    assert.strictEqual(parseUiConfig(UI_SAMPLE).bufferSec, 0.2);
    assert.strictEqual(parseUiConfig({ default_buffer: '500' }).bufferSec, 0.5);
    assert.strictEqual(parseUiConfig({ default_buffer: 50 }).bufferSec, 0.05);
    // Absent or unusable is null, not zero: "the operator did not say" has to
    // be distinguishable from "no buffer at all", or every listener on a server
    // that never configured it would be forced to the minimum.
    assert.strictEqual(parseUiConfig({}).bufferSec, null);
    assert.strictEqual(parseUiConfig({ default_buffer: 'soon' }).bufferSec, null);
    assert.strictEqual(parseUiConfig({ default_buffer: '0' }).bufferSec, null);
    // Out of range is clamped rather than refused.
    assert.strictEqual(parseUiConfig({ default_buffer: '9000' }).bufferSec, 2);
});

// --- the operator's v2 defaults --------------------------------------------
//
// The `v2` block of the same reply: this interface's own defaults, which the
// display context applies to a browser that has never stored settings of its
// own. Everything in it is optional, so the tests below are mostly about the
// difference between "not chosen" and "chose the thing that happens to be the
// default" — getting that wrong freezes every listener on whatever the server
// last serialised.

t('an operator who set nothing produces no patch', () => {
    assert.deepStrictEqual(parseUiConfig({}).v2Defaults, {});
    assert.deepStrictEqual(parseUiConfig({ v2: {} }).v2Defaults, {});
    // Not an object, from a server that means something else by the key.
    assert.deepStrictEqual(parseUiConfig({ v2: 'yes' }).v2Defaults, {});
    assert.deepStrictEqual(parseUiConfig({ v2: [1, 2] }).v2Defaults, {});
    assert.deepStrictEqual(parseUiConfig({ v2: null }).v2Defaults, {});
});

t('a colour scheme carries its colours and its base together', () => {
    // Exactly what the Colours menu does when somebody picks one, so an
    // operator default and a listener's own choice land on identical settings.
    const paper = parseUiConfig({ v2: { color_scheme: 'paper' } }).v2Defaults;
    assert.strictEqual(paper.theme, 'light');
    assert.strictEqual(paper.uiColors.accent, '#0a5ea8');
    // A scheme that leaves a colour out clears it rather than leaving the
    // previous scheme's behind.
    assert.strictEqual(paper.uiColors.dim, null);

    // The stock scheme sets no colours at all — it is what "nothing chosen"
    // looks like — but it still says which base it is for.
    const stock = parseUiConfig({ v2: { color_scheme: 'default' } }).v2Defaults;
    assert.strictEqual(stock.theme, 'dark');
    assert.deepStrictEqual(stock.uiColors, {
        accent: null, text: null, dim: null, faint: null, station: null,
    });

    // A scheme this build does not have is ignored, not applied blank.
    assert.deepStrictEqual(parseUiConfig({ v2: { color_scheme: 'chartreuse' } }).v2Defaults, {});
});

t('a palette is applied only if this build has it', () => {
    assert.strictEqual(parseUiConfig({ v2: { palette: 'radar' } }).v2Defaults.palette, 'radar');
    // jet is the classic interface's default and one this one does not have.
    // Storing it would leave the listener on turbo (getPalette's fallback) with
    // a settings blob claiming otherwise.
    assert.deepStrictEqual(parseUiConfig({ v2: { palette: 'jet' } }).v2Defaults, {});
});

t('words are checked against the choices, switches against being booleans', () => {
    const d = parseUiConfig({
        v2: {
            view_mode: 'waterfall', waterfall_mode: 'both', waterfall_pan: 'hold',
            peak_hold: true, grid: false, fill: true, smooth_scroll: false,
        },
    }).v2Defaults;
    assert.strictEqual(d.viewMode, 'waterfall');
    assert.strictEqual(d.waterfallMode, 'both');
    assert.strictEqual(d.waterfallPan, 'hold');
    // false is a choice like any other and must survive.
    assert.strictEqual(d.grid, false);
    assert.strictEqual(d.smoothScroll, false);
    assert.strictEqual(d.peakHold, true);
    assert.strictEqual(d.fill, true);

    // Neither a word off the list nor a string that looks like a switch.
    const bad = parseUiConfig({
        v2: { view_mode: 'panoramic', waterfall_mode: '4d', peak_hold: 'true', grid: 1 },
    }).v2Defaults;
    assert.deepStrictEqual(bad, {});
});

t('numbers are clamped to the sliders that set them', () => {
    const d = parseUiConfig({
        v2: {
            ui_scale: 1.25, contrast: 1.4, smoothing: 0, waterfall_rate: 8,
            row_height: 3, dss_seconds: 20,
        },
    }).v2Defaults;
    assert.deepStrictEqual(d, {
        uiScale: 1.25, contrast: 1.4, smoothing: 0, waterfallRate: 8,
        rowHeight: 3, dssSeconds: 20,
    });

    // A hand-edited ui.yaml is the only way past the admin UI and the server's
    // own check, and the nearest legal value beats ignoring it.
    const wild = parseUiConfig({
        v2: { ui_scale: 12, contrast: -3, smoothing: 5, row_height: 0 },
    }).v2Defaults;
    assert.deepStrictEqual(wild, {
        uiScale: 1.6, contrast: 0.4, smoothing: 0.92, rowHeight: 1,
    });

    // Not a number at all is dropped, rather than clamped to a bound.
    assert.deepStrictEqual(parseUiConfig({ v2: { contrast: 'high' } }).v2Defaults, {});
});

t('a key this build does not know is ignored', () => {
    // A receiver may be running a server newer than its client. An unusable
    // value written into the settings is one the listener then has to find.
    const d = parseUiConfig({ v2: { palette: 'ice', spectrum_hologram: 'on' } }).v2Defaults;
    assert.deepStrictEqual(d, { palette: 'ice' });
});

t('the v2 block is still kept verbatim under config', () => {
    const cfg = { v2: { palette: 'ice', future_key: 7 } };
    assert.deepStrictEqual(parseUiConfig(cfg).config.v2, cfg.v2);
});

// --- marker colours --------------------------------------------------------

t('every palette names a dial and a passband colour', () => {
    // The marks have to contrast with the colour map, so a palette added
    // without a pair silently falls back to a fixed one that may sit right in
    // the middle of it.
    for (const name of PALETTE_NAMES) {
        const m = paletteMarks(name);
        assert.ok(/^#[0-9a-f]{6}$/i.test(m.vfo), `${name} dial: ${m.vfo}`);
        assert.ok(/^#[0-9a-f]{6}$/i.test(m.edge), `${name} passband: ${m.edge}`);
        assert.notStrictEqual(m.vfo.toLowerCase(), m.edge.toLowerCase(),
            `${name}: the dial and the passband must be told apart`);
    }
});

t('marker colours resolve browser over palette', () => {
    const marks = paletteMarks('classic');
    const base = { palette: 'classic', server: {} };

    // Nothing chosen: the palette's own pair.
    assert.deepStrictEqual(markColors(base), { dial: marks.vfo, edge: marks.edge });

    // This browser's picker wins, per mark.
    assert.deepStrictEqual(
        markColors({ ...base, markOverrides: { classic: { dial: '#123456', edge: '#abcdef' } } }),
        { dial: '#123456', edge: '#abcdef' },
    );
    assert.deepStrictEqual(
        markColors({ ...base, markOverrides: { classic: { edge: '#abcdef' } } }),
        { dial: marks.vfo, edge: '#abcdef' },
    );
});

t('an override belongs to the palette it was picked for', () => {
    const over = { markOverrides: { classic: { dial: '#123456' } }, server: {} };
    assert.strictEqual(markColors({ ...over, palette: 'classic' }).dial, '#123456');
    // Switching palette brings back that palette's own choice, not the one
    // picked to stand out against a different colour map.
    assert.strictEqual(markColors({ ...over, palette: 'magma' }).dial, paletteMarks('magma').vfo);
});

t("the operator's v1 bandwidth colour does not override the palette", () => {
    // The regression this exists for: /api/ui-config always carries
    // bandwidth_indicator_color, because the server substitutes "green" when the
    // operator set nothing. Treated as a source it therefore won every time, and
    // every palette drew green passband edges — radar included, where green is
    // the one hue the colour map is made of.
    //
    // It is v1's first-run seed for a per-user setting, not a mandate, and v2's
    // equivalent of that setting is the per-palette picker.
    for (const name of PALETTE_NAMES) {
        const d = { palette: name, server: parseUiConfig(UI_SAMPLE) };
        assert.strictEqual(UI_SAMPLE.bandwidth_indicator_color, 'green', 'the sample still says green');
        assert.deepStrictEqual(markColors(d), {
            dial: paletteMarks(name).vfo,
            edge: paletteMarks(name).edge,
        }, name);
    }
    // And most palettes do not answer green, which is the whole point.
    const greens = PALETTE_NAMES.filter((n) => paletteMarks(n).edge.toLowerCase() === '#00ff00');
    assert.strictEqual(greens.length, 0, `still fixed on green: ${greens}`);
});

t('opacity is clamped and survives odd values', () => {
    assert.strictEqual(parseUiConfig({ spectrum_bg_opacity: 5 }).bgOpacity, 1);
    assert.strictEqual(parseUiConfig({ spectrum_bg_opacity: -2 }).bgOpacity, 0);
    // A string is what an older server sends; a bad one falls back.
    assert.strictEqual(parseUiConfig({ spectrum_bg_opacity: '0.42' }).bgOpacity, 0.42);
    assert.strictEqual(parseUiConfig({ spectrum_bg_opacity: 'nope' }).bgOpacity, UI_CONFIG_DEFAULTS.bgOpacity);
});

t('a missing or malformed reply yields defaults, not a crash', () => {
    for (const bad of [null, undefined, 'oops', [], 42]) {
        const p = parseUiConfig(bad);
        assert.strictEqual(p.loaded, false, String(bad));
        assert.strictEqual(p.bgImage, '');
    }
});

// --- filter width limits ---------------------------------------------------

t('am, sam and nfm top out at a 12 kHz filter', () => {
    for (const mode of ['am', 'sam', 'nfm']) {
        assert.strictEqual(maxFilterWidth(mode), 12000, `${mode} allows ${maxFilterWidth(mode)} Hz`);
        const l = bandwidthLimits(mode);
        assert.deepStrictEqual([l.min, l.max], [-6000, 6000], mode);
    }
});

t('FM reaches ±8 kHz, which is both its default and v1’s limit', () => {
    // Not folded into the case above: FM's own default passband is ±8000, so
    // the shared ±6000 limit silently narrowed it the moment anything clamped.
    // v1 sets minLow -8000 / maxHigh 8000 for this mode. See modes.test.js.
    assert.deepStrictEqual(bandwidthLimits('fm'), { min: -8000, max: 8000, sideband: 'both' });
    assert.strictEqual(maxFilterWidth('fm'), 16000);
});

t('sideband modes keep their own widths', () => {
    assert.strictEqual(maxFilterWidth('usb'), 6000);
    assert.strictEqual(maxFilterWidth('lsb'), 6000);
    // CW is symmetric, so its width is both sides of ±500 — v1's slider range.
    // It was 2000 here while CW was wrongly modelled as single-sideband.
    assert.strictEqual(maxFilterWidth('cwu'), 1000);
    assert.strictEqual(maxFilterWidth('cwl'), 1000);
});

t('an unknown mode falls back to the symmetric limit', () => {
    assert.strictEqual(maxFilterWidth('whatever'), 12000);
});

// --- DSP filter schemas -----------------------------------------------------
//
// Schemas below are the verbatim `get_dsp_filters` reply from a live server, so
// these test the shapes actually sent rather than an idealised version.

const NR2 = {
    name: 'nr2',
    description: 'SpectralNR — MMSE-LSA + OSMS spectral subtraction',
    params: [
        { name: 'gain-method', type: 'int', default: '2', min: '0', max: '3', description: 'Gain method: 0=Linear 1=Log 2=Gamma 3=Trained', runtime_safe: true },
        { name: 'npe-method', type: 'int', default: '0', min: '0', max: '2', description: 'NPE method: 0=OSMS 1=MMSE 2=NSTAT', runtime_safe: true },
        { name: 'gain-max', type: 'float', default: '1.0', min: '0', max: '2.0', description: 'Max gain cap', runtime_safe: true },
        { name: 'gain-smooth', type: 'float', default: '0.85', min: '0', max: '1.0', description: 'Temporal gain smoothing', runtime_safe: true },
        { name: 'qspp', type: 'float', default: '0.2', min: '0', max: '1.0', description: 'Speech presence probability prior', runtime_safe: true },
        { name: 'ae', type: 'bool', default: 'true', description: 'Artifact elimination post-processing', runtime_safe: true },
    ],
};
const RN2 = { name: 'rn2', description: 'RNNoise — Mozilla/Xiph RNN-based suppressor', params: null };
const DFNR = {
    name: 'dfnr',
    description: 'DeepFilterNet3 — neural network denoiser',
    params: [
        { name: 'model', type: 'string', default: '', description: 'Model path', runtime_safe: false },
        { name: 'atten-limit', type: 'float', default: '20', min: '0', max: '100', description: 'Attenuation limit', runtime_safe: true },
        { name: 'pf-beta', type: 'float', default: '0', min: '0', max: '0.3', description: 'Post-filter beta', runtime_safe: true },
    ],
};

t('init-only params are hidden — the server would reject them', () => {
    const names = dspLib.runtimeParams(DFNR).map((p) => p.name);
    assert.deepStrictEqual(names, ['atten-limit', 'pf-beta']);
    assert.ok(!names.includes('model'));
});

t('a filter with no params is handled, not crashed', () => {
    assert.deepStrictEqual(dspLib.runtimeParams(RN2), []);
    assert.deepStrictEqual(dspLib.defaultParams(RN2), {});
});

t('defaults come from the schema, as strings', () => {
    assert.deepStrictEqual(dspLib.defaultParams(NR2), {
        'gain-method': '2', 'npe-method': '0', 'gain-max': '1.0',
        'gain-smooth': '0.85', 'qspp': '0.2', 'ae': 'true',
    });
});

t('control kind follows the declared type and range', () => {
    const kind = (f, n) => dspLib.controlKind(f.params.find((p) => p.name === n));
    assert.strictEqual(kind(NR2, 'ae'), 'bool');
    assert.strictEqual(kind(NR2, 'gain-method'), 'enum');   // enumerated in its description
    assert.strictEqual(kind(NR2, 'npe-method'), 'enum');
    assert.strictEqual(kind(NR2, 'gain-max'), 'slider');
    assert.strictEqual(kind(DFNR, 'model'), 'text');        // string, no range
});

t('enum options are parsed from the description', () => {
    const p = NR2.params.find((x) => x.name === 'gain-method');
    assert.deepStrictEqual(dspLib.parseEnum(p), [
        { value: 0, label: 'Linear' }, { value: 1, label: 'Log' },
        { value: 2, label: 'Gamma' }, { value: 3, label: 'Trained' },
    ]);
});

t('a description that does not cover the full range is not an enum', () => {
    // Only two labels for a 0..3 range — rendering it as choices would hide
    // values the filter accepts, so it must stay a slider.
    const p = { name: 'x', type: 'int', min: '0', max: '3', description: 'Mode: 0=A 1=B' };
    assert.strictEqual(dspLib.parseEnum(p), null);
    assert.strictEqual(dspLib.controlKind(p), 'slider');
});

t('integer sliders step by 1', () => {
    // A 0..3 range would otherwise inherit a 0.1 step and send fractions.
    const p = { name: 'x', type: 'int', min: '0', max: '3', description: '' };
    assert.strictEqual(dspLib.computeStep(p), 1);
});

t('float slider steps scale with the range', () => {
    const step = (min, max) => dspLib.computeStep({ type: 'float', min, max });
    assert.strictEqual(step('0', '0.3'), 0.01);
    assert.strictEqual(step('0', '2.0'), 0.1);
    assert.strictEqual(step('0', '40'), 1);
    assert.strictEqual(step('0', '1000'), 100);
});

t('values format according to type and range', () => {
    const f = (v, p) => dspLib.formatParamValue(v, p);
    assert.strictEqual(f('2', { type: 'int', min: '0', max: '3' }), '2');
    assert.strictEqual(f('0.85', { type: 'float', min: '0', max: '1.0' }), '0.850');
    assert.strictEqual(f('1.0', { type: 'float', min: '0', max: '2.0' }), '1.00');
    assert.strictEqual(f('10', { type: 'float', min: '0', max: '40' }), '10.0');
});

t('enum labels are not repeated in the help text', () => {
    const p = NR2.params.find((x) => x.name === 'gain-method');
    assert.strictEqual(dspLib.paramHelp(p), 'Gain method');
    // Non-enum help is passed through untouched.
    assert.strictEqual(dspLib.paramHelp(NR2.params.find((x) => x.name === 'qspp')),
        'Speech presence probability prior');
});

t('names read as labels', () => {
    assert.strictEqual(dspLib.formatParamName('gain-method'), 'Gain method');
    assert.strictEqual(dspLib.formatParamName('atten_limit'), 'Atten limit');
});

t('params go on the wire as strings', () => {
    assert.strictEqual(dspLib.toWire(true), 'true');
    assert.strictEqual(dspLib.toWire(false), 'false');
    assert.strictEqual(dspLib.toWire(0.85), '0.85');
    assert.strictEqual(dspLib.toWire('2'), '2');
});

t('setDSPParams sends the server message shape, and skips empty updates', () => {
    const a = new AudioConnection();
    const sent = [];
    a.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    global.WebSocket = { OPEN: 1 };
    a.setDSPParams({ reduction: '20' });
    assert.deepStrictEqual(sent[0], { type: 'set_dsp_params', params: { reduction: '20' } });
    assert.strictEqual(a.setDSPParams({}), false);
    assert.strictEqual(sent.length, 1);
});

// --- audio -----------------------------------------------------------------
function audioPacket({ sampleRate = 12000, channels = 1, power = -55.5, noise = -95.25, payload = [1, 2, 3, 4] }) {
    const buf = new ArrayBuffer(21 + payload.length);
    const v = new DataView(buf);
    v.setBigUint64(0, BigInt(Date.now()) * 1000000n, true);
    v.setUint32(8, sampleRate, true);
    v.setUint8(12, channels);
    v.setFloat32(13, power, true);
    v.setFloat32(17, noise, true);
    new Uint8Array(buf, 21).set(payload);
    return buf;
}

t('v3 audio header parses and strips the 21-byte prefix', () => {
    const a = new AudioConnection();
    let opus = null; let quality = null;
    a.on('opus', (x) => { opus = x; });
    a.on('quality', (x) => { quality = x; });
    a._onBinary(audioPacket({ payload: [9, 8, 7] }));
    assert.strictEqual(opus.sampleRate, 12000);
    assert.strictEqual(opus.channels, 1);
    assert.deepStrictEqual([...opus.data], [9, 8, 7]);
    assert.ok(Math.abs(quality.basebandPower + 55.5) < 0.01);
    assert.ok(Math.abs(quality.noisePower + 95.25) < 0.01);
});

t('-999 sentinels become null rather than a fake -999 dB reading', () => {
    const a = new AudioConnection();
    let quality = null;
    a.on('quality', (x) => { quality = x; });
    a._onBinary(audioPacket({ power: -999, noise: -999 }));
    assert.strictEqual(quality.basebandPower, null);
    assert.strictEqual(quality.noisePower, null);
});

t('header-only packet is ignored', () => {
    const a = new AudioConnection();
    let called = false;
    a.on('opus', () => { called = true; });
    a._onBinary(new ArrayBuffer(21));
    assert.strictEqual(called, false);
});

t('JSON PCM fallback deinterleaves stereo', () => {
    const a = new AudioConnection();
    let pcm = null;
    a.on('pcm', (x) => { pcm = x; });
    const samples = Int16Array.from([1000, -1000, 2000, -2000]);   // L R L R
    const bytes = new Uint8Array(samples.buffer);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    global.atob = (s) => s;   // the module's atob receives the raw string back
    a._onMessage({ data: JSON.stringify({ type: 'audio', data: bin, sampleRate: 24000, channels: 2 }) });
    assert.strictEqual(pcm.channels, 2);
    assert.ok(Math.abs(pcm.planes[0][0] - 1000 / 32768) < 1e-6);
    assert.ok(Math.abs(pcm.planes[1][0] + 1000 / 32768) < 1e-6);
});


// ── Audio scope: which part of the decoded audio carries the signal ──────────
// v1 works this out in app.js getFrequencyBinMapping. Getting it wrong shows an
// empty waterfall (LSB mapped to negative bins) or a mostly-empty one (drawing
// the whole Nyquist when only 2.7 kHz is in use).

t('USB shows its passband', () => {
    assert.deepStrictEqual(ab.audioWindow(50, 2700), { startFreq: 50, endFreq: 2700 });
});

t('LSB is mirrored into positive audio frequencies', () => {
    // -2700..-50 demodulates to 50..2700 Hz of audio, not to negative bins.
    assert.deepStrictEqual(ab.audioWindow(-2700, -50), { startFreq: 50, endFreq: 2700 });
});

t('AM straddles zero, so the window starts at DC', () => {
    assert.deepStrictEqual(ab.audioWindow(-5000, 5000), { startFreq: 0, endFreq: 5000 });
});

t('CW is centred on the 500 Hz tone offset', () => {
    // radiod puts the CW note at 500 Hz, so a +/-200 Hz filter is 300..700 Hz.
    assert.deepStrictEqual(ab.audioWindow(-200, 200), { startFreq: 300, endFreq: 700 });
    assert.ok(ab.isCwPassband(-200, 200));
    assert.ok(!ab.isCwPassband(50, 2700));
});

t('bins cover the passband, not the whole Nyquist', () => {
    // 12 kHz stream -> 6 kHz Nyquist; USB 50..2700 is under half of it.
    const { start, count } = ab.audioBins(50, 2700, 12000, 1024);
    assert.strictEqual(start, Math.floor((50 / 6000) * 1024));
    assert.strictEqual(count, Math.round((2650 / 6000) * 1024));
    assert.ok(start + count <= 1024);
});

t('a passband wider than the stream is clamped to Nyquist', () => {
    // AM +/-8 kHz on a 12 kHz stream: the audio above 6 kHz does not exist.
    const r = ab.audioBins(-8000, 8000, 12000, 1024);
    assert.strictEqual(r.endFreq, 6000);
    assert.ok(r.start + r.count <= 1024);
});

t('a degenerate rate or bin count yields no bins', () => {
    assert.strictEqual(ab.audioBins(50, 2700, 0, 1024).count, 0);
    assert.strictEqual(ab.audioBins(50, 2700, 12000, 0).count, 0);
});


// ── Chat message parts: mentions, URLs and tunable frequencies ──────────────
// v1 linkifies URLs, then frequencies, then mentions (chat-ui.js:2067). The
// frequency form is the one its "share frequency" button produces, and both
// frontends must agree or a link shared from one is dead text in the other.

t('a shared frequency becomes a tunable part', () => {
    const parts = mn.splitMessage('on 14175.000 KHz (USB) now', []);
    const freq = parts.find((p) => p.freq);
    assert.deepStrictEqual(freq.freq, { hz: 14175000, mode: 'usb' });
    assert.strictEqual(parts.map((p) => p.text).join(''), 'on 14175.000 KHz (USB) now');
});

t('frequency forms v1 accepts are accepted here', () => {
    for (const [text, hz, mode] of [
        ['7100 KHz (LSB)', 7100000, 'lsb'],
        ['198 kHz (am)', 198000, 'am'],
        ['10125.5 KHz (CWU)', 10125500, 'cwu'],
    ]) {
        const p = mn.splitMessage(text, []).find((x) => x.freq);
        assert.ok(p, text);
        assert.strictEqual(p.freq.hz, hz);
        assert.strictEqual(p.freq.mode, mode);
    }
});

t('out-of-band or unknown-mode frequencies stay plain text', () => {
    // v1 validates 10 kHz-30 MHz and a known mode before linking.
    for (const text of ['5 KHz (USB)', '45000 KHz (USB)', '14175.000 KHz (XYZ)']) {
        const parts = mn.splitMessage(text, []);
        assert.ok(!parts.some((p) => p.freq), text);
        assert.strictEqual(parts.map((p) => p.text).join(''), text);
    }
});

t('URLs are linked, and a URL wins over anything inside it', () => {
    const parts = mn.splitMessage('see https://example.com/7100-KHz-(LSB) ok', []);
    assert.strictEqual(parts.filter((p) => p.url).length, 1);
    assert.ok(!parts.some((p) => p.freq));
    assert.strictEqual(parts.map((p) => p.text).join(''), 'see https://example.com/7100-KHz-(LSB) ok');
});

t('mentions, links and frequencies coexist in one message', () => {
    const text = '@bob try 14175.000 KHz (USB) or https://example.com';
    const parts = mn.splitMessage(text, ['bob']);
    assert.strictEqual(parts.filter((p) => p.mention).length, 1);
    assert.strictEqual(parts.filter((p) => p.freq).length, 1);
    assert.strictEqual(parts.filter((p) => p.url).length, 1);
    // Nothing may be lost or duplicated by the single-pass split.
    assert.strictEqual(parts.map((p) => p.text).join(''), text);
});

t('a plain message survives the split unchanged', () => {
    const text = 'hello, nothing special here';
    assert.deepStrictEqual(mn.splitMessage(text, ['bob']), [{ text }]);
});


// ── Audio filters: EQ, notch and bandpass parameters ────────────────────────
// The maths that turns a slider into a biquad's Q is v1's (static/filters.js).
// A mistake here is inaudible until someone notices the notch is in the wrong
// place, so the numbers are pinned.

t('bandpass Q follows centre, width and stage count', () => {
    // v1: Q = max(0.7, (centre / width) * (stages / 2))
    assert.strictEqual(af.bandpassQ({ center: 800, width: 200, stages: 4, autoQ: true }), 8);
    assert.strictEqual(af.bandpassQ({ center: 800, width: 200, stages: 2, autoQ: true }), 4);
    // A wide, low filter must not drop below the floor.
    assert.strictEqual(af.bandpassQ({ center: 300, width: 1000, stages: 1, autoQ: true }), 0.7);
});

t('manual Q scales the automatic value', () => {
    const spec = { center: 800, width: 200, stages: 4, autoQ: false, qMultiplier: 0.5 };
    assert.strictEqual(af.bandpassQ(spec), 4);
});

t('notch Q spreads width across its six stages', () => {
    // v1: Q = max(0.7, centre / (width * 3)) with NOTCH_STAGES cascaded.
    assert.strictEqual(af.notchQ(1500, 50), 10);
    assert.strictEqual(af.notchQ(1500, 100), 5);
    assert.strictEqual(af.notchQ(100, 500), 0.7);
    assert.strictEqual(af.NOTCH_STAGES, 6);
});

t('EQ presets are v1\'s tables', () => {
    const voice = af.presetGains('voice');
    assert.strictEqual(voice.gains.length, af.EQ_FREQUENCIES.length);
    assert.strictEqual(voice.gains[0], -6);      // 60 Hz
    assert.strictEqual(voice.gains[5], 4);       // 1500 Hz
    assert.strictEqual(af.presetGains('cw').gains[3], 6);      // 600 Hz
    assert.strictEqual(af.presetGains('music').gains[0], 4);   // 60 Hz
    assert.strictEqual(af.presetGains('nope'), null);
});

t('a boosting preset pulls the makeup gain down', () => {
    // v1 compensates by 70% of the average positive band gain, so a preset
    // cannot clip on the way in.
    for (const name of ['voice', 'cw', 'music']) {
        const p = af.presetGains(name);
        assert.ok(p.makeup <= 0, `${name} makeup ${p.makeup}`);
        assert.ok(p.makeup >= af.EQ_GAIN_MIN);
    }
    assert.strictEqual(af.presetGains('voice').makeup, -2);
});

t('the live preset is detected from the band gains', () => {
    assert.strictEqual(af.detectPreset(af.presetGains('cw').gains), 'cw');
    assert.strictEqual(af.detectPreset(af.EQ_FREQUENCIES.map(() => 0)), null);
    const tweaked = af.presetGains('voice').gains.slice();
    tweaked[0] += 0.5;
    assert.strictEqual(af.detectPreset(tweaked), null);
});

t('the bandpass range follows the mode passband', () => {
    // LSB is mirrored, so the controls work in positive audio frequencies.
    assert.deepStrictEqual(af.bandpassRange(ab.audioWindow(-2700, -50)), { min: 50, max: 2700 });
    // AM starts at DC, but a bandpass centred below 50 Hz is not useful.
    assert.strictEqual(af.bandpassRange(ab.audioWindow(-5000, 5000)).min, 50);
    // CW sits around the 500 Hz tone.
    assert.deepStrictEqual(af.bandpassRange(ab.audioWindow(-200, 200)), { min: 300, max: 700 });
});


// ── EQ band meters ──────────────────────────────────────────────────────────
// Each band's meter is weighted by that band's own filter response, so a wide
// band reads what it actually controls rather than a fixed slice of bins.

t('band weighting peaks at the centre and stops at the -6 dB point', () => {
    const sr = 16000;
    const bins = 512;
    const [w] = eql.bandWeights([1000], 1.0, sr, bins);
    const at = (hz) => w[Math.floor((hz / (sr / 2)) * bins)];

    assert.ok(at(1000) > 0.99, `centre ${at(1000)}`);
    // The -3 dB points of the underlying bandpass still read about half way up
    // the rescaled weight.
    assert.ok(at(618) > 0.35 && at(618) < 0.5, `lower ${at(618)}`);
    assert.ok(at(1618) > 0.35 && at(1618) < 0.5, `upper ${at(1618)}`);
    // Beyond the -6 dB point the band has no say at all. Without this gate,
    // loud low-frequency speech leaked into every high band and a 12 dB boost
    // moved its own meter by ~1 dB.
    assert.strictEqual(at(400), 0, 'below the band');
    assert.strictEqual(at(2500), 0, 'above the band');
    assert.strictEqual(at(7000), 0, 'far above the band');
});

t('a higher Q makes a narrower band', () => {
    const sr = 16000;
    const bins = 512;
    const [wide] = eql.bandWeights([1000], 0.5, sr, bins);
    const [narrow] = eql.bandWeights([1000], 4.0, sr, bins);
    const at = (w, hz) => w[Math.floor((hz / (sr / 2)) * bins)];
    assert.ok(at(narrow, 1500) < at(wide, 1500));
    assert.ok(at(narrow, 1000) > 0.99 && at(wide, 1000) > 0.99);
});

t('boosting a band moves that band\'s meter, not its neighbours', () => {
    // The bug this guards: with un-gated weights, loud audio elsewhere in the
    // spectrum dominated every band's average.
    const sr = 16000;
    const bins = 1024;
    const freqs = [500, 8000];
    const weights = eql.bandWeights(freqs, 1.0, sr, bins);

    const data = new Float32Array(bins).fill(-100);
    const binOf = (hz) => Math.floor((hz / (sr / 2)) * bins);
    for (let i = binOf(400); i < binOf(650); i++) data[i] = -30;    // loud speech
    for (let i = binOf(7000); i < binOf(7990); i++) data[i] = -70;  // quiet hiss

    const before = eql.bandLevels(data, weights);
    for (let i = binOf(7000); i < binOf(7990); i++) data[i] = -58;  // +12 dB
    const after = eql.bandLevels(data, weights);

    assert.ok(after[1] - before[1] > 10, `8k band moved ${(after[1] - before[1]).toFixed(1)} dB`);
    assert.ok(Math.abs(after[0] - before[0]) < 0.5, 'the 500 Hz band must not move');
});

t('a tone lands in the band that controls it', () => {
    const sr = 16000;
    const bins = 512;
    const freqs = [60, 1000, 8000];
    const weights = eql.bandWeights(freqs, 1.0, sr, bins);

    // A single tone at 1 kHz, everything else at the floor.
    const data = new Float32Array(bins).fill(-120);
    data[Math.floor((1000 / (sr / 2)) * bins)] = -20;

    const levels = eql.bandLevels(data, weights);
    assert.ok(levels[1] > levels[0], '1 kHz band should beat 60 Hz');
    assert.ok(levels[1] > levels[2], '1 kHz band should beat 8 kHz');
});

t('meter fractions follow the loudest band and clamp', () => {
    const state = { ceil: -40 };
    // Feed a steady picture until the ceiling settles.
    let frac;
    for (let i = 0; i < 200; i++) frac = eql.meterFractions([-30, -60, -Infinity], state);
    assert.ok(Math.abs(state.ceil - -30) < 0.5, `ceil ${state.ceil}`);
    assert.ok(frac[0] > 0.98, `loudest ${frac[0]}`);
    assert.ok(frac[1] > 0.2 && frac[1] < 0.5, `mid ${frac[1]}`);
    assert.strictEqual(frac[2], 0, 'a silent band reads empty');
});


// ── Gate, compressor and widener parameters ─────────────────────────────────

t('the gate has hysteresis, so it cannot chatter on the threshold', () => {
    // Closed: needs to cross the threshold proper. Open: hangs on until it
    // drops a further GATE_HYSTERESIS_DB.
    assert.strictEqual(af.gateOpen(-44, -45, false), true);
    assert.strictEqual(af.gateOpen(-46, -45, false), false);
    assert.strictEqual(af.gateOpen(-46, -45, true), true, 'must not close inside the hysteresis');
    assert.strictEqual(af.gateOpen(-49, -45, true), false);
    // No signal yet: hold whatever state we were in rather than flapping.
    assert.strictEqual(af.gateOpen(-Infinity, -45, true), true);
});

t('frame level is RMS in dBFS', () => {
    const flat = new Uint8Array(256).fill(128);
    assert.strictEqual(af.frameLevelDb(flat), -Infinity, 'digital silence');

    // Full-scale square wave: RMS 1.0 -> 0 dBFS.
    const square = new Uint8Array(256);
    for (let i = 0; i < square.length; i++) square[i] = i % 2 ? 255 : 1;
    assert.ok(Math.abs(af.frameLevelDb(square)) < 0.2, af.frameLevelDb(square));

    // Half amplitude is about -6 dB.
    const half = new Uint8Array(256);
    for (let i = 0; i < half.length; i++) half[i] = i % 2 ? 192 : 64;
    assert.ok(Math.abs(af.frameLevelDb(half) + 6) < 0.3, af.frameLevelDb(half));
});

t('makeup backs off when the output is already at the ceiling', () => {
    // The bug this guards: reduction says how far the peaks were pulled down,
    // not how much room is left above them. A signal already at full scale has
    // none, and handing back "what was taken" clipped it.
    const hot = af.nextMakeupDb({ current: 6, reductionDb: -10, peakDb: 0 });
    assert.ok(hot < 6, `should retreat from a 0 dBFS peak, got ${hot}`);

    // Repeatedly: it must settle at its target, not oscillate — and the target
    // is well below the limiter, so the limiter is not engaged continuously.
    let db = 6;
    for (let i = 0; i < 400; i++) db = af.nextMakeupDb({ current: db, reductionDb: -10, peakDb: 0 + (db - 6) });
    const settledPeak = 0 + (db - 6);
    assert.ok(Math.abs(settledPeak - af.MAKEUP_TARGET_DB) < 0.3, `settled with peak at ${settledPeak}`);
    assert.ok(af.MAKEUP_TARGET_DB < af.CEILING_DB - 3, 'makeup must aim clear of the limiter');

    // Backing off is fast, coming back is slow — distortion is immediate,
    // a slow recovery is inaudible.
    const down = 6 - af.nextMakeupDb({ current: 6, reductionDb: -10, peakDb: 3 });
    const up = af.nextMakeupDb({ current: 0, reductionDb: -10, peakDb: -40 }) - 0;
    assert.ok(down > up, `retreat ${down} should outpace recovery ${up}`);

    // Headroom to spare: it may rise, but never past what was compressed away.
    const quiet = af.nextMakeupDb({ current: 0, reductionDb: -6, peakDb: -40 });
    assert.ok(quiet > 0 && quiet <= af.makeupFromReduction(-6));

    // No peak reading yet (a node that has not run): fall back to reduction.
    assert.ok(af.nextMakeupDb({ current: 0, reductionDb: -6, peakDb: -Infinity }) > 0);
});

t('auto makeup only gives back what the compressor took', () => {
    // The bug this guards: estimating makeup from threshold and ratio assumes
    // the audio peaks at 0 dBFS. On a signal peaking near -20 that handed back
    // ~11 dB for ~5 dB of real reduction, and enabling the compressor
    // distorted immediately. Driving it from the node's own reduction meter
    // cannot over-boost.
    assert.strictEqual(af.makeupFromReduction(0), 0, 'nothing compressed, nothing given back');
    assert.ok(af.makeupFromReduction(-6) < 6, 'must stay under unity');
    assert.ok(af.makeupFromReduction(-6) > af.makeupFromReduction(-3), 'more reduction, more makeup');
    assert.strictEqual(af.makeupFromReduction(-6), 6 * af.MAKEUP_FACTOR);
    // Bounded, and unbothered by a node that has not reported yet.
    assert.strictEqual(af.makeupFromReduction(-100), af.MAKEUP_MAX_DB);
    assert.strictEqual(af.makeupFromReduction(NaN), 0);
    assert.strictEqual(af.makeupFromReduction(undefined), 0);
});

t('every filter section has defaults and ships disabled', () => {
    for (const [name, section] of Object.entries(af.FILTER_DEFAULTS)) {
        assert.strictEqual(section.enabled, false, `${name} must ship off`);
    }
    assert.deepStrictEqual(
        Object.keys(af.FILTER_DEFAULTS).sort(),
        ['bandpass', 'compressor', 'eq', 'gate', 'notch', 'stereo'],
    );
});


// The widener normalisation, checked as maths rather than through Web Audio:
// each side is dry +/- wet, so without 1/(1+w) the peak grows with the width.
t('the stereo widener cannot add gain', () => {
    for (const width of [0, 25, 50, 75, 100]) {
        const w = width / 100;
        const norm = 1 / (1 + w);
        const worstCase = norm + w * norm;      // dry and wet aligned
        assert.ok(Math.abs(worstCase - 1) < 1e-9, `width ${width}% peaks at x${worstCase}`);
    }
});


// Which filter edits need the graph rebuilt, and which can be retuned live.
// Getting this wrong is audible: rebuilding drops whatever is in flight, which
// is what tore the audio on every compressor slider move.
t('parameter changes keep the same chain shape', () => {
    const base = JSON.parse(JSON.stringify(af.FILTER_DEFAULTS));
    base.compressor.enabled = true;
    base.eq.enabled = true;
    base.bandpass.enabled = true;
    base.notch.enabled = true;
    base.notch.items = [{ center: 1000, width: 50 }];
    const shape = af.shapeKey(base);

    const tweak = (fn) => { const s2 = JSON.parse(JSON.stringify(base)); fn(s2); return af.shapeKey(s2); };

    // Values only — retune, do not rebuild.
    assert.strictEqual(tweak((s2) => { s2.compressor.threshold = -40; }), shape);
    assert.strictEqual(tweak((s2) => { s2.compressor.ratio = 8; }), shape);
    assert.strictEqual(tweak((s2) => { s2.compressor.attack = 40; }), shape);
    assert.strictEqual(tweak((s2) => { s2.compressor.knee = 0; }), shape);
    assert.strictEqual(tweak((s2) => { s2.eq.gains[3] = 6; }), shape);
    assert.strictEqual(tweak((s2) => { s2.eq.makeup = 3; }), shape);
    assert.strictEqual(tweak((s2) => { s2.bandpass.center = 1200; }), shape);
    assert.strictEqual(tweak((s2) => { s2.bandpass.width = 400; }), shape);
    assert.strictEqual(tweak((s2) => { s2.notch.items[0].center = 1800; }), shape);
    assert.strictEqual(tweak((s2) => { s2.stereo.width = 80; }), shape);
});

t('structural changes do force a rebuild', () => {
    const base = JSON.parse(JSON.stringify(af.FILTER_DEFAULTS));
    base.compressor.enabled = true;
    base.bandpass.enabled = true;
    base.notch.enabled = true;
    base.notch.items = [{ center: 1000, width: 50 }];
    const shape = af.shapeKey(base);
    const tweak = (fn) => { const s2 = JSON.parse(JSON.stringify(base)); fn(s2); return af.shapeKey(s2); };

    assert.notStrictEqual(tweak((s2) => { s2.eq.enabled = true; }), shape, 'a section switched on');
    assert.notStrictEqual(tweak((s2) => { s2.compressor.enabled = false; }), shape, 'a section switched off');
    assert.notStrictEqual(tweak((s2) => { s2.bandpass.stages = 6; }), shape, 'more filter stages');
    assert.notStrictEqual(
        tweak((s2) => { s2.notch.items.push({ center: 2000, width: 50 }); }), shape, 'another notch',
    );
    assert.notStrictEqual(
        tweak((s2) => { s2.compressor.autoMakeup = false; }), shape, 'makeup changes who drives the gain',
    );
});

console.log(process.exitCode ? '\nPROTOCOL TESTS FAILED' : `\nall ${pass} protocol tests passed`);
