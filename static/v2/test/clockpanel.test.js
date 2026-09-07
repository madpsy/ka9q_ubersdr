// The time-signal panel renders, and the readings it draws mean what they say.
//
// Two reasons this test exists beyond "it compiles". The panel has two views
// with quite different contents — the minimal one is the reading alone, the
// expanded one adds an SVG overlay, a 60-cell strip and a staged funnel — and
// either could be written to build cleanly, pass everything else, and blank the
// moment somebody opened it. See hookStub.js for what "renders" means here.
//
// The second reason is that almost everything on screen is a claim about a
// clock: which way round the error is, whether the decode is fresh, and which
// stage of acquisition is at fault. Those are worth pinning down away from a
// renderer, because getting a sign or a staleness window wrong produces a panel
// that looks entirely healthy and tells you the opposite of the truth.

const assert = require('assert');

// Before the bundle: the module graph behind an extension reaches the radio and
// the display settings, and both read the browser at import time.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.TextDecoder = globalThis.TextDecoder || require('util').TextDecoder;
// NOTE: as in drmpanel.test.js, the decoding branch is deliberately not
// rendered. Switching the decoder on reaches useAudioExtension, which holds the
// dxcluster socket open and keeps retry timers alive — the stub harness has no
// way to wind that down, so the test would never exit. What that branch draws is
// built from the frame helpers, which are covered directly below.

const {
    render, reset, walk, words, ClockExtension, EXTENSION_BY_ID,
    CLOCK_FREQUENCIES, STRIP_LENGTH, WWVB_CEILING_HZ,
    alignmentSeries, appendSecond, correctedNowMs, decodeFrame, formatClock, formatDate,
    formatDay, formatDut1, formatOffset, frameFlags, funnelStages, localIsUtc, offsetSense,
    offsetTone, polylinePoints, stateLabel, stateTone, stationFor, stationLabel, symbolTone,
    tunedClockOption, zoneLabel,
} = require('./.build/clockpanel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

function context(over) {
    const calls = [];
    const ctx = {
        tuning: { frequency: 9_999_000, mode: 'usb', bandwidthLow: 0, bandwidthHigh: 3000 },
        running: true,
        audioState: 'open',
        audio: { volume: 0.8, muted: false },
        player: { ctx: null, setDucked() {} },
        actions: {
            tuneTo: (a) => calls.push(['tuneTo', a]),
            ensureVisible: (hz) => calls.push(['ensureVisible', hz]),
            setMode() {}, nudge() {},
        },
        server: {},
        set() {},
        ...over,
    };
    ctx.calls = calls;
    return ctx;
}

const jsonFrame = (obj) => new TextEncoder().encode(JSON.stringify(obj));

// ── it renders ──────────────────────────────────────────────────────────────

t('it renders docked and minimal', () => {
    for (const minimal of [false, true]) {
        reset();
        const { tree } = render(ClockExtension, { minimal }, context());
        assert.ok(tree, `minimal=${minimal} produced nothing`);
    }
});

t('it renders before the receiver is running', () => {
    reset();
    const { tree } = render(ClockExtension, {}, context({ running: false, audioState: 'closed' }));
    assert.ok(words(tree).includes('Start the receiver to decode.'));
});

t('it renders while waiting for audio', () => {
    reset();
    const { tree } = render(ClockExtension, {}, context({ audioState: 'connecting' }));
    assert.ok(words(tree).includes('Waiting for the audio connection…'));
});

t('it is in the registry with a minimal view', () => {
    const entry = EXTENSION_BY_ID.clock;
    assert.ok(entry, 'clock is not in the extension registry');
    assert.strictEqual(entry.minimal, true);
    assert.strictEqual(entry.requiresAudio, true);
    // Not an IQ extension: the decoder takes demodulated USB audio, and
    // needsIQ would keep it open in a mode that carries nothing it can read.
    assert.ok(!entry.needsIQ);
});

// The narrow-filter warning is the whole reason the panel bothers to look at
// the passband: it is the one setup mistake that produces a decoder which
// starts cleanly, says nothing for ever, and gives no other clue.
t('a too-narrow passband is called out, and a wide one is not', () => {
    reset();
    // 2100 Hz clips WWVH's 2200 Hz tick image outright and sits on top of
    // WWV's 2000 Hz one. 2400 is the threshold and is deliberately not warned
    // about — a stock 2.4 kHz SSB filter is fine here.
    const narrow = render(ClockExtension, {}, context({
        tuning: { frequency: 9_999_000, mode: 'usb', bandwidthLow: 0, bandwidthHigh: 2100 },
    }));
    assert.ok(words(narrow.tree).includes('2000 Hz image'),
        'expected the narrow-passband warning');

    reset();
    const wide = render(ClockExtension, {}, context());
    assert.ok(!words(wide.tree).includes('2000 Hz image'),
        'a 3 kHz passband should not be warned about');
});

// 60 kHz is shared with MSF (Anthorn), whose time code this decoder cannot
// read. Without the note, a European user gets a strong carrier, a funnel whose
// first stage passes, and no explanation at all.
t('tuning WWVB warns that 60 kHz is shared with MSF', () => {
    reset();
    const { tree } = render(ClockExtension, {}, context({
        tuning: { frequency: 59_000, mode: 'usb', bandwidthLow: 0, bandwidthHigh: 3000 },
    }));
    assert.ok(words(tree).includes('MSF'), 'expected the shared-frequency note');
});

t('an HF dial is not warned about MSF', () => {
    reset();
    const { tree } = render(ClockExtension, {}, context());
    assert.ok(!words(tree).includes('MSF'));
});

t('WWVB is not warned about a narrow passband', () => {
    reset();
    // WWVB carries no tick image — it only needs its ~1 kHz tone — so the
    // WWV-specific warning must not fire on a 60 kHz dial.
    const { tree } = render(ClockExtension, {}, context({
        tuning: { frequency: 59_000, mode: 'usb', bandwidthLow: 0, bandwidthHigh: 1600 },
    }));
    assert.ok(!words(tree).includes('2000 Hz image'));
});

t('the wrong mode is called out', () => {
    reset();
    const { tree } = render(ClockExtension, {}, context({
        tuning: { frequency: 9_999_000, mode: 'am', bandwidthLow: -5000, bandwidthHigh: 5000 },
    }));
    assert.ok(words(tree).includes('received in USB'));
});

t('the tune menu retunes to the offset dial, not the carrier', () => {
    reset();
    const ctx = context({ tuning: { frequency: 7_000_000, mode: 'usb', bandwidthLow: 0, bandwidthHigh: 3000 } });
    const { tree } = render(ClockExtension, {}, ctx);
    const select = walk(tree).find((n) => n && n.props && n.props.className === 'select');
    assert.ok(select, 'no tune menu rendered');
    select.props.onChange({ target: { value: '9999000' } });
    const tuned = ctx.calls.find((c) => c[0] === 'tuneTo');
    assert.ok(tuned, 'selecting a frequency should tune');
    // 9.999 MHz, not 10 MHz: the decoder needs the carrier at 1000 Hz of audio.
    assert.strictEqual(tuned[1].frequency, 9_999_000);
    assert.strictEqual(tuned[1].mode, 'usb');
    assert.strictEqual(tuned[1].bandwidthHigh, 3000);
});

// ── the offset, which is the reading ────────────────────────────────────────

t('the offset keeps its sign and picks a sensible unit', () => {
    assert.strictEqual(formatOffset(0), '+0.0 ms');
    assert.strictEqual(formatOffset(341), '+341 ms');
    assert.strictEqual(formatOffset(-341), '−341 ms');
    assert.strictEqual(formatOffset(2500), '+2.50 s');
    assert.strictEqual(formatOffset(-125000), '−2.1 min');
    assert.strictEqual(formatOffset(null), '—');
    assert.strictEqual(formatOffset(NaN), '—');
});

// offset = broadcast − clock, so positive means the clock reads early.
t('which way the clock is wrong is stated, not implied by a sign', () => {
    assert.strictEqual(offsetSense(500), 'behind');
    assert.strictEqual(offsetSense(-500), 'ahead');
    assert.strictEqual(offsetSense(0), 'in step');
    assert.strictEqual(offsetSense(null), 'in step');
});

t('the offset tone grades in the right direction', () => {
    assert.strictEqual(offsetTone(5), 'good');
    assert.strictEqual(offsetTone(-5), 'good');
    assert.strictEqual(offsetTone(300), 'warn');
    assert.strictEqual(offsetTone(5000), 'bad');
    assert.strictEqual(offsetTone(null), 'off');
});

// ── frames ──────────────────────────────────────────────────────────────────

t('a JSON event frame decodes', () => {
    const ev = decodeFrame(jsonFrame({ type: 'time', utc: '2026-09-07T07:01:59Z', quality: 100 }));
    assert.strictEqual(ev.type, 'time');
    assert.strictEqual(ev.quality, 100);
});

t('rubbish frames are dropped, not thrown', () => {
    assert.strictEqual(decodeFrame(new Uint8Array([0x7b, 0x7b])), null);   // not JSON
    assert.strictEqual(decodeFrame(jsonFrame([1, 2, 3])), null);            // array
    assert.strictEqual(decodeFrame(jsonFrame({ nope: 1 })), null);          // no type
    assert.strictEqual(decodeFrame(new Uint8Array([])), null);
    assert.strictEqual(decodeFrame(42), null);
});

t('the station comes from the dial the same way the server picks it', () => {
    assert.strictEqual(stationFor(59_000), 'wwvb');
    assert.strictEqual(stationFor(9_999_000), 'wwv');
    assert.strictEqual(stationFor(WWVB_CEILING_HZ - 1), 'wwvb');
    assert.strictEqual(stationFor(WWVB_CEILING_HZ), 'wwv');
});

t('every listed frequency is 1 kHz below its carrier', () => {
    for (const g of CLOCK_FREQUENCIES) {
        for (const o of g.options) {
            assert.strictEqual(o.carrier - o.hz, 1000,
                `${o.label} is not offset 1 kHz below its carrier`);
        }
    }
});

t('the menu offers the frequencies these stations actually transmit on', () => {
    const carriers = {};
    for (const g of CLOCK_FREQUENCIES) {
        for (const o of g.options) carriers[o.carrier] = g.group;
    }
    // WWV: 2.5, 5, 10, 15, 20 MHz, plus 25 MHz experimental since 2014.
    for (const mhz of [2.5, 5, 10, 15, 20, 25]) {
        assert.ok(carriers[mhz * 1e6], `${mhz} MHz is missing from the menu`);
    }
    assert.ok(carriers[60_000], 'WWVB 60 kHz is missing');
});

t('20 and 25 MHz are not offered as WWVH, because WWVH is not there', () => {
    // WWVH transmits on 2.5, 5, 10 and 15 MHz only. Grouping 20 MHz under
    // "WWV / WWVH" would send someone listening for a station that does not
    // exist on that frequency, and the decoder's tag could never say WWVH.
    const groupOf = (carrier) => {
        for (const g of CLOCK_FREQUENCIES) {
            for (const o of g.options) if (o.carrier === carrier) return g.group;
        }
        return null;
    };
    for (const mhz of [2.5, 5, 10, 15]) {
        assert.ok(groupOf(mhz * 1e6).includes('WWVH'), `${mhz} MHz should be shared`);
    }
    for (const mhz of [20, 25]) {
        assert.ok(!groupOf(mhz * 1e6).includes('WWVH'), `${mhz} MHz has no WWVH`);
    }
});

t('the tune menu knows when the dial is already on an entry', () => {
    assert.strictEqual(tunedClockOption(9_999_000).label, '10 MHz');
    assert.strictEqual(tunedClockOption(9_999_120).label, '10 MHz');  // a little off
    assert.strictEqual(tunedClockOption(9_990_000), null);
    assert.strictEqual(tunedClockOption(NaN), null);
});

t('an unidentified station reads as unknown rather than a guess', () => {
    assert.strictEqual(stationLabel('unknown'), 'Unknown');
    assert.strictEqual(stationLabel(undefined), 'Unknown');
    assert.strictEqual(stationLabel('wwvh'), 'WWVH');
    assert.strictEqual(stateLabel('acquiring'), 'Acquiring');
    // Acquiring is 'wait', not 'on': working and not there yet.
    assert.strictEqual(stateTone('acquiring'), 'wait');
    assert.strictEqual(stateTone('locked'), 'on');
});

// ── the local clock ─────────────────────────────────────────────────────────

// The instant comes from the radio and the zone from the browser. Every case
// here pins the zone explicitly, so these say the same thing on a machine in
// Tokyo as on one in UTC — a test that reads the runner's TZ proves nothing
// and fails somebody else's afternoon.

t('the clock ticks on from the last decode instead of freezing', () => {
    // WWV emits one time event a minute, so between them the display has to
    // advance or it sits frozen on a panel about what the time is.
    const time = { utc_ms: 1_788_764_519_000, at: 5_000 };
    assert.strictEqual(correctedNowMs(time, 5_000), 1_788_764_519_000);
    assert.strictEqual(correctedNowMs(time, 12_000), 1_788_764_526_000);
    // Elapsed is measured with the browser's clock, which is fine: an interval
    // of at most a minute is borrowed, never an absolute reading.
    assert.strictEqual(correctedNowMs(time, 65_000), 1_788_764_579_000);
});

t('a missing or half-formed decode gives no clock rather than 1970', () => {
    assert.strictEqual(correctedNowMs(null, 1000), null);
    assert.strictEqual(correctedNowMs({ utc_ms: 1 }, 1000), null);
    assert.strictEqual(correctedNowMs({ at: 1 }, 1000), null);
    assert.strictEqual(correctedNowMs({ utc_ms: 1, at: 1 }, NaN), null);
});

t('the same instant reads differently in different zones', () => {
    // 2026-09-07T07:01:59Z. London is on BST (+1) in September, Tokyo +9,
    // and Kolkata is one of the half-hour zones that catch naive arithmetic.
    const ms = Date.UTC(2026, 8, 7, 7, 1, 59);
    assert.strictEqual(formatClock(ms, 'UTC'), '07:01:59');
    assert.strictEqual(formatClock(ms, 'Europe/London'), '08:01:59');
    assert.strictEqual(formatClock(ms, 'Asia/Tokyo'), '16:01:59');
    assert.strictEqual(formatClock(ms, 'Asia/Kolkata'), '12:31:59');
});

t('a zone can put the receiver on a different day to the user', () => {
    // 23:30Z is already tomorrow in Tokyo — which is the whole reason the
    // date is shown under the clocks and not assumed.
    const ms = Date.UTC(2026, 8, 7, 23, 30, 0);
    assert.ok(formatDay(ms, 'UTC').includes('7 Sep'));
    assert.ok(formatDay(ms, 'Asia/Tokyo').includes('8 Sep'));
});

t('no time yet shows placeholders, not the epoch', () => {
    assert.strictEqual(formatClock(null, 'UTC'), '--:--:--');
    assert.strictEqual(formatClock(NaN, 'UTC'), '--:--:--');
    assert.strictEqual(formatDay(null, 'UTC'), '');
});

t('a bad zone degrades rather than throwing', () => {
    // Intl throws on an unknown zone, and a panel must not blank because
    // somebody's browser reported something odd.
    assert.strictEqual(formatClock(Date.UTC(2026, 0, 1), 'Not/AZone'), '--:--:--');
    assert.strictEqual(formatDay(Date.UTC(2026, 0, 1), 'Not/AZone'), '');
    assert.strictEqual(zoneLabel('Not/AZone'), 'Local');
});

t('a zone is always named, so a local time is never ambiguous', () => {
    assert.strictEqual(zoneLabel('UTC'), 'UTC');
    // Whatever the runtime calls it, it must not be empty — an unlabelled
    // local time beside a UTC one is the ambiguity this panel exists to remove.
    assert.ok(zoneLabel('Asia/Tokyo').length > 0);
});

t('a browser already on UTC gets one clock, not two identical ones', () => {
    assert.strictEqual(localIsUtc(0), true);
    assert.strictEqual(localIsUtc(-60), false);   // BST
    assert.strictEqual(localIsUtc(330), false);   // IST, and a half-hour offset
});

// ── the second strip ────────────────────────────────────────────────────────

t('the strip keeps one minute and drops the oldest', () => {
    let strip = [];
    for (let i = 0; i < STRIP_LENGTH + 20; i++) {
        strip = appendSecond(strip, { symbol: i % 3, confidence: 0.5, edge_sample: i, second_of_frame: i % 60 });
    }
    assert.strictEqual(strip.length, STRIP_LENGTH);
    assert.strictEqual(strip[strip.length - 1].id, STRIP_LENGTH + 19);
    assert.strictEqual(strip[0].id, 20);
});

t('a second with no symbol is ignored rather than added blank', () => {
    const strip = appendSecond([], { confidence: 0.5 });
    assert.strictEqual(strip.length, 0);
});

t('a low-margin second reads as weak, not as an error', () => {
    assert.strictEqual(symbolTone({ symbol: 1, confidence: 0.5 }), 'bit');
    assert.strictEqual(symbolTone({ symbol: 2, confidence: 0.5 }), 'marker');
    assert.strictEqual(symbolTone({ symbol: 2, confidence: 0.01 }), 'weak');
    assert.strictEqual(symbolTone(null), 'none');
});

// ── the alignment overlay ───────────────────────────────────────────────────

t('the zero-mean template is rescaled before it is drawn over the envelope', () => {
    const series = alignmentSeries({
        envelope: [0, 0.75, 1.5],
        expected: [-0.2, -0.2, 0.8],
        window_shift: 3,
        series_rate: 200,
        symbol: 1,
    });
    // The envelope arrives normalised against the decoder's running peak of
    // ~1.5 and is only scaled; the template arrives zero-mean and has to be
    // stretched to 0..1 or it would draw partly off the plot.
    assert.deepStrictEqual(series.envelope, [0, 0.5, 1]);
    assert.deepStrictEqual(series.expected, [0, 0, 1]);
    assert.strictEqual(series.shift, 3);
});

t('a flat template does not divide by zero', () => {
    const series = alignmentSeries({ envelope: [1, 1], expected: [0.5, 0.5] });
    assert.deepStrictEqual(series.expected, [0, 0]);
});

t('an alignment with no envelope is null, not an empty plot', () => {
    assert.strictEqual(alignmentSeries(null), null);
    assert.strictEqual(alignmentSeries({ envelope: [] }), null);
});

t('polyline points are offset by the shift so the two curves stay honest', () => {
    const flat = polylinePoints([0, 1], 100, 10, 0);
    assert.strictEqual(flat, '0.0,10.0 100.0,0.0');
    const shifted = polylinePoints([0, 1], 100, 10, 1);
    assert.strictEqual(shifted, '100.0,10.0 200.0,0.0');
});

// ── the acquisition funnel ──────────────────────────────────────────────────

t('only the first failing stage is marked, because the rest follow from it', () => {
    const stages = funnelStages({
        tone_detected: false, phase_locked: false, anchored: false,
        frames_in_window: 0, window_size: 8, refusal: 'none',
    }, 'wwv');
    assert.strictEqual(stages.length, 4);
    assert.strictEqual(stages[0].first, true);
    assert.ok(!stages[1].first && !stages[2].first && !stages[3].first);
    assert.ok(stages[1].blocked && stages[2].blocked && stages[3].blocked);
    // The one hint shown is the one worth acting on.
    assert.ok(stages[0].hint.includes('2.2 kHz'));
});

t('a healthy chain marks every stage ok and blames nobody', () => {
    const stages = funnelStages({
        tone_detected: true, phase_locked: true, anchored: true,
        frames_in_window: 4, window_size: 8, refusal: 'none',
    }, 'wwv');
    assert.ok(stages.every((s) => s.ok));
    assert.ok(!stages.some((s) => s.first));
});

t('the failure moves down the chain as earlier stages come up', () => {
    const stages = funnelStages({
        tone_detected: true, phase_locked: true, anchored: false,
        frames_in_window: 0, window_size: 8,
    }, 'wwv');
    assert.strictEqual(stages[2].first, true);
    assert.ok(!stages[0].first && !stages[1].first);
});

t('a refused lock names the gate that refused it', () => {
    const stages = funnelStages({
        tone_detected: true, phase_locked: true, anchored: true,
        frames_in_window: 4, window_size: 8, refusal: 'plausibility',
    }, 'wwv');
    assert.strictEqual(stages[3].ok, false);
    assert.strictEqual(stages[3].first, true);
    assert.ok(stages[3].hint.includes('more than a day'));
});

t('WWVB is told to check its own carrier, not a tick it does not have', () => {
    const stages = funnelStages({ tone_detected: false }, 'wwvb');
    assert.strictEqual(stages[0].label, 'Carrier tone');
    assert.ok(stages[0].hint.includes('0.059 MHz'));
});

t('no diagnostics yet means no funnel rather than a red one', () => {
    assert.deepStrictEqual(funnelStages(null, 'wwv'), []);
});

// ── frame detail ────────────────────────────────────────────────────────────

t('DUT1 keeps its sign, and zero is a value rather than a blank', () => {
    assert.strictEqual(formatDut1(-3), '−0.3 s');
    assert.strictEqual(formatDut1(3), '+0.3 s');
    assert.strictEqual(formatDut1(0), '0.0 s');
    assert.strictEqual(formatDut1(null), null);
});

t('day-of-year becomes a date', () => {
    assert.strictEqual(formatDate(250, 26), '2026-09-07');
    assert.strictEqual(formatDate(1, 26), '2026-01-01');
    // 2024 was a leap year; doy 366 is real there.
    assert.strictEqual(formatDate(366, 24), '2024-12-31');
    assert.strictEqual(formatDate(0, 26), null);
    assert.strictEqual(formatDate(400, 26), null);
});

t('the DST pair reads as a schedule, not a state', () => {
    const both = frameFlags({ dst1: true, dst2: true });
    assert.strictEqual(both[0].label, 'US DST in effect');
    assert.strictEqual(frameFlags({ dst1: false, dst2: true })[0].label, 'US DST starts today');
    assert.strictEqual(frameFlags({ dst1: true, dst2: false })[0].label, 'US DST ends today');
    assert.deepStrictEqual(frameFlags({ dst1: false, dst2: false }), []);
});

t('a pending leap second is a warning and a leap year is not', () => {
    const flags = frameFlags({ leap_pending: true, leap_year: true });
    assert.strictEqual(flags.find((f) => f.id === 'leap').tone, 'warn');
    assert.strictEqual(flags.find((f) => f.id === 'leapyear').tone, 'info');
    assert.deepStrictEqual(frameFlags(null), []);
});

console.log(`\n${pass} passed`);
