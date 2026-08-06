// The rolling spectrogram panel's arithmetic: which recorder to show, and the
// two axes that say what the picture is.

const assert = require('assert');
const {
    DEFAULT_BAND, FREQ_LABEL_PX, agoLabel, bandForView, bandLabel, formatRange,
    formatClock, formatTickHz, formatTzTag, freqLabelEvery,
    freqTickStep, freqTicks, pointReadout, timeTickStepMinutes, timeTicks,
} = require('./.build/spectrogram.cjs');
const { readoutClearsOn, tipPlacement } = require('./.build/hovertip.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const BANDS = ['wideband', 'wideband-hf', '160m', '80m', '40m', '20m'];

t('the dial picks the band, when the server records it', () => {
    assert.strictEqual(bandForView(BANDS, '40m'), '40m');
    assert.strictEqual(bandForView(BANDS, '20m'), '20m');
});

t('a band the server does not record falls back to wideband HF', () => {
    // 6m is in nobody's noisefloor.bands by default.
    assert.strictEqual(bandForView(BANDS, '6m'), DEFAULT_BAND);
});

t('off-band, and before the band list has arrived, is wideband HF', () => {
    assert.strictEqual(bandForView(BANDS, null), DEFAULT_BAND);
    assert.strictEqual(bandForView(null, '40m'), DEFAULT_BAND);
});

// ── What the picture covers ──────────────────────────────────────────────────

const RANGES = {
    wideband: { start_freq_hz: 0, end_freq_hz: 30e6 },
    'wideband-hf': { start_freq_hz: 1.8e6, end_freq_hz: 30e6 },
    '40m': { start_freq_hz: 7e6, end_freq_hz: 7.2e6 },
    '20m': { start_freq_hz: 14e6, end_freq_hz: 14.35e6 },
};

t('a band is captioned with the span it covers, not with its own name again', () => {
    // The bug: bandLabel returned the name, so the footer read "40m  40m".
    assert.strictEqual(bandLabel('40m', RANGES), '7.0–7.2 MHz');
    assert.strictEqual(bandLabel('20m', RANGES), '14.000–14.350 MHz');
    assert.notStrictEqual(bandLabel('40m', RANGES), '40m');
});

t('the span is the recorder\'s, not the band plan\'s', () => {
    // 40m runs to 7.3 MHz; this receiver records to 7.2. Saying 7.3 would be a
    // caption that disagrees with the picture under it.
    assert.ok(bandLabel('40m', RANGES).endsWith('7.2 MHz'));
});

t('the wideband views read at a precision that suits them', () => {
    assert.strictEqual(bandLabel('wideband', RANGES), '0–30 MHz');
    assert.strictEqual(bandLabel('wideband-hf', RANGES), '1.8–30.0 MHz');
});

t('an older server, with no ranges to give, still captions the wideband views', () => {
    assert.strictEqual(bandLabel('wideband'), '0–30 MHz');
    assert.strictEqual(bandLabel('wideband-hf'), '1.8–30 MHz');
    // ...and says nothing at all rather than repeating the name.
    assert.strictEqual(bandLabel('40m'), '');
    assert.strictEqual(bandLabel('40m', {}), '');
    assert.strictEqual(bandLabel('40m', { '40m': { start_freq_hz: 7e6, end_freq_hz: 7e6 } }), '');
});

t('both ends of a span are printed at the same precision', () => {
    assert.strictEqual(formatRange(7e6, 7.2e6), '7.0–7.2 MHz');
    assert.strictEqual(formatRange(0, 30e6), '0–30 MHz');
    // Both ends need a decimal to be true: 1.8 is not 2, and printing "2–30"
    // is a caption that says the picture starts somewhere it does not.
    assert.strictEqual(formatRange(1.8e6, 30e6), '1.8–30.0 MHz');
    // 30m: the top end is on a 50 kHz boundary, so both ends go to three.
    assert.strictEqual(formatRange(10.1e6, 10.15e6), '10.100–10.150 MHz');
});

t('frequency tick spacing follows the span, as the spectrogram page does', () => {
    assert.strictEqual(freqTickStep(30e6), 5e6);      // wideband
    assert.strictEqual(freqTickStep(28.2e6), 5e6);    // wideband-hf
    assert.strictEqual(freqTickStep(200e3), 25e3);    // a 40m recorder
    assert.strictEqual(freqTickStep(50e3), 5e3);      // 30m at 100 Hz bins
});

t('frequency ticks land on round numbers inside the range', () => {
    const ticks = freqTicks(7000000, 7200000);
    assert.ok(ticks.length >= 2, 'expected several ticks');
    for (const k of ticks) {
        assert.strictEqual(k.hz % 25e3, 0, `${k.hz} is not a round tick`);
        assert.ok(k.hz > 7000000 && k.hz < 7200000, `${k.hz} is outside the band`);
        assert.ok(k.pct > 0 && k.pct < 100, `${k.pct}% is off the image`);
    }
});

t('a tick sits where its frequency does', () => {
    const [first] = freqTicks(0, 30e6);
    // 5 MHz of 30 MHz is a sixth across.
    assert.strictEqual(first.hz, 5e6);
    assert.ok(Math.abs(first.pct - 100 / 6) < 0.001, `${first.pct}`);
});

t('edge ticks are dropped rather than drawn half off the image', () => {
    // 7.0 MHz exactly is the left edge: it would print at 0%.
    assert.ok(!freqTicks(7000000, 7200000).some((k) => k.pct < 2));
});

t('tick labels read as frequencies', () => {
    assert.strictEqual(formatTickHz(5e6), '5 MHz');
    assert.strictEqual(formatTickHz(7.05e6), '7.050 MHz');
    assert.strictEqual(formatTickHz(14.35e6), '14.350 MHz');
    // The one that matters: a 25 kHz tick on 20m must not print as 14.0 MHz
    // three times running.
    assert.strictEqual(formatTickHz(14025000), '14.025 MHz');
    assert.strictEqual(formatTickHz(14050000), '14.050 MHz');
    assert.strictEqual(formatTickHz(14075000), '14.075 MHz');
    assert.strictEqual(formatTickHz(50e3), '50 kHz');
});

t('a full 24-hour window gets hourly ticks it can fit', () => {
    // 1440 rows is 24 hours: 1 h would be 24 labels, 2 h is 12.
    assert.strictEqual(timeTickStepMinutes(1440), 120);
    assert.strictEqual(timeTickStepMinutes(600), 60);
});

t('time ticks are on the receiver\'s clock, and snap to it', () => {
    // The axis and the readout have to agree, so both are in the receiver's
    // zone — and the snapping is done there too. Snapping in UTC and relabelling
    // would put every tick on the half hour in a half-hour zone.
    const start = Date.UTC(2026, 7, 5, 9, 37) / 1000;
    const rows = Array.from({ length: 1440 }, (_, i) => ({ unix: start + i * 60 }));
    assert.strictEqual(timeTicks(rows, 1440, 120)[0].label, '12:00');
    assert.strictEqual(timeTicks(rows, 1440, 330)[0].label, '16:00');
    assert.strictEqual(timeTicks(rows, 1440, -300)[0].label, '06:00');
});

t('time ticks snap to the clock, not to row zero', () => {
    // A window that starts at 09:37 UTC: the first tick must be 10:00, not 09:37.
    const start = Date.UTC(2026, 7, 5, 9, 37) / 1000;
    const rows = Array.from({ length: 1440 }, (_, i) => ({ unix: start + i * 60 }));
    const ticks = timeTicks(rows, 1440);
    assert.strictEqual(ticks[0].label, '10:00');
    // 23 minutes into 1440 rows.
    assert.ok(Math.abs(ticks[0].pct - (23 / 1440) * 100) < 0.001, String(ticks[0].pct));
    for (const k of ticks) {
        assert.ok(/^\d\d:\d\d$/.test(k.label), k.label);
        assert.ok(k.pct >= 0 && k.pct <= 99, String(k.pct));
    }
});

t('time ticks run oldest at the top, newest at the bottom', () => {
    const start = Date.UTC(2026, 7, 5, 0, 0) / 1000;
    const rows = Array.from({ length: 1440 }, (_, i) => ({ unix: start + i * 60 }));
    const ticks = timeTicks(rows, 1440);
    for (let i = 1; i < ticks.length; i++) {
        assert.ok(ticks[i].pct > ticks[i - 1].pct, 'ticks must descend the image');
        assert.ok(ticks[i].label > ticks[i - 1].label, 'and advance in time');
    }
});

t('no metadata means no axis, not a broken one', () => {
    assert.deepStrictEqual(freqTicks(0, 0), []);
    assert.deepStrictEqual(timeTicks([], 0), []);
    assert.deepStrictEqual(timeTicks([{}], 1), []);   // rows without timestamps
});

// ── Labels that do not overlap ───────────────────────────────────────────────

t('a narrow axis labels every other tick rather than printing them on top', () => {
    // 20m: 14.0-14.35 MHz ticks every 25 kHz — thirteen ticks.
    const wide = freqTicks(14000000, 14350000, 4000);
    assert.ok(wide.every((k) => k.label), 'a wide axis labels everything');

    const narrow = freqTicks(14000000, 14350000, 300);
    const labelled = narrow.filter((k) => k.label);
    assert.strictEqual(narrow.length, wide.length, 'the ticks themselves stay');
    assert.ok(labelled.length < narrow.length, 'but not all of them are labelled');
    // Never more labels than there is room for.
    assert.ok(labelled.length <= Math.floor(300 / FREQ_LABEL_PX) , `${labelled.length} labels in 300px`);
});

t('labels that survive are round numbers, evenly spaced', () => {
    const ticks = freqTicks(0, 30e6, 320);
    const labelled = ticks.filter((k) => k.label);
    assert.ok(labelled.length >= 2);
    const stepHz = labelled[1].hz - labelled[0].hz;
    for (let i = 1; i < labelled.length; i++) {
        assert.strictEqual(labelled[i].hz - labelled[i - 1].hz, stepHz, 'uneven label spacing');
        assert.strictEqual(labelled[i].hz % stepHz, 0, `${labelled[i].hz} is not round`);
    }
});

t('the skip is a whole multiple, so labels never drift off the round values', () => {
    for (const [n, w] of [[13, 300], [6, 1000], [29, 400], [3, 90]]) {
        const every = freqLabelEvery(n, w);
        assert.ok(Number.isInteger(every) && every >= 1, `${every}`);
        assert.ok(Math.ceil(n / every) <= Math.max(1, Math.floor(w / FREQ_LABEL_PX)) || every === n,
            `${n} ticks in ${w}px still overlap at every ${every}`);
    }
});

t('an unmeasured axis labels everything, rather than nothing', () => {
    assert.ok(freqTicks(0, 30e6, 0).every((k) => k.label));
    assert.ok(freqTicks(0, 30e6).every((k) => k.label));
});

// ── The hover readout ────────────────────────────────────────────────────────

const META = {
    start_freq_hz: 7000000,
    end_freq_hz: 7200000,
    bin_width_hz: 500,
    row_count: 1440,
    rows: Array.from({ length: 1440 }, (_, i) => ({
        unix: Date.UTC(2026, 7, 5, 9, 37) / 1000 + i * 60,
    })),
};

t('the readout says the frequency under the pointer', () => {
    assert.strictEqual(pointReadout(META, 0, 0).freq, '7.0000 MHz');
    assert.strictEqual(pointReadout(META, 0.5, 0).freq, '7.1000 MHz');
    assert.strictEqual(pointReadout(META, 1, 0).freq, '7.2000 MHz');
});

t('decimals follow the bin width, not the number', () => {
    // A wideband bin is 7.3 kHz: four decimals would be inventing precision.
    const wide = { ...META, start_freq_hz: 0, end_freq_hz: 30e6, bin_width_hz: 7324 };
    assert.strictEqual(pointReadout(wide, 0.5, 0).freq, '15.000 MHz');
    assert.strictEqual(pointReadout(META, 0.5, 0).freq, '7.1000 MHz');
});

t('the readout says the time of the row under the pointer', () => {
    // Row 0 is 09:37 UTC, and the window runs forward from there.
    assert.strictEqual(pointReadout(META, 0, 0).time, '09:37');
    assert.strictEqual(pointReadout(META, 0, 0.5).time, '21:37');
    assert.strictEqual(pointReadout(META, 0, 1).time, '09:36');
    assert.strictEqual(pointReadout(META, 0, 0).tz, 'UTC');
});

t('the readout is on the receiver\'s clock, not the browser\'s or UTC', () => {
    // The picture is of one receiver's sky: "the band opened at 06:00" means
    // the hour it happened where the antenna is.
    assert.strictEqual(pointReadout(META, 0, 0, 120).time, '11:37');
    assert.strictEqual(pointReadout(META, 0, 0, 120).tz, 'UTC+2');
    assert.strictEqual(pointReadout(META, 0, 0, -300).time, '04:37');
    assert.strictEqual(pointReadout(META, 0, 0, -300).tz, 'UTC-5');
    // Half-hour zones are real places, not an edge case: Kolkata, Adelaide.
    assert.strictEqual(pointReadout(META, 0, 0, 330).time, '15:07');
    assert.strictEqual(pointReadout(META, 0, 0, 330).tz, 'UTC+5:30');
});

t('a time that crosses midnight in the receiver\'s zone still reads as a clock', () => {
    // 09:37 UTC with a -11 h offset is the previous day, 22:37.
    assert.strictEqual(pointReadout(META, 0, 0, -660).time, '22:37');
    assert.strictEqual(formatClock(Date.UTC(2026, 7, 5, 23, 30) / 1000, 60), '00:30');
    assert.strictEqual(formatClock(Date.UTC(2026, 7, 5, 0, 30) / 1000, -60), '23:30');
});

t('the zone tag says which clock the times are on', () => {
    assert.strictEqual(formatTzTag(0), 'UTC');
    assert.strictEqual(formatTzTag(undefined), 'UTC');
    assert.strictEqual(formatTzTag(60), 'UTC+1');
    assert.strictEqual(formatTzTag(-480), 'UTC-8');
    assert.strictEqual(formatTzTag(345), 'UTC+5:45');    // Kathmandu
    assert.strictEqual(formatTzTag(-210), 'UTC-3:30');   // St John's
});

t('the newest row is the bottom of the image', () => {
    assert.strictEqual(pointReadout(META, 0, 1).row, 1439);
    assert.strictEqual(pointReadout(META, 0, 1).ago, 'now');
    assert.strictEqual(pointReadout(META, 0, 0).ago, '23 h 59 min ago');
});

t('a pointer that has strayed off the image is clamped, not wrong', () => {
    assert.strictEqual(pointReadout(META, -0.4, 2).freq, '7.0000 MHz');
    assert.strictEqual(pointReadout(META, 5, -1).row, 0);
});

t('no metadata means no readout', () => {
    assert.strictEqual(pointReadout(null, 0.5, 0.5), null);
    assert.strictEqual(pointReadout({}, 0.5, 0.5), null);
    assert.strictEqual(pointReadout({ start_freq_hz: 0, end_freq_hz: 0, row_count: 10 }, 0.5, 0.5), null);
});

t('ages read the way people say them', () => {
    assert.strictEqual(agoLabel(0), 'now');
    assert.strictEqual(agoLabel(1), '1 min ago');
    assert.strictEqual(agoLabel(59), '59 min ago');
    assert.strictEqual(agoLabel(60), '1 h ago');
    assert.strictEqual(agoLabel(125), '2 h 5 min ago');
});

// ── Touch ────────────────────────────────────────────────────────────────────

t('a tap leaves the readout up — only a mouse leaving clears it', () => {
    // The bug this is here for: treating a tap as a hover puts the answer up on
    // pointerdown and takes it away again on pointerup.
    assert.strictEqual(readoutClearsOn('touch'), false);
    assert.strictEqual(readoutClearsOn('pen'), false);
    assert.strictEqual(readoutClearsOn('mouse'), true);
});

t('on touch the readout sits above the point, clear of the fingertip', () => {
    assert.strictEqual(tipPlacement('touch', 20, 20).above, true);
    assert.strictEqual(tipPlacement('pen', 20, 20).above, true);
    // A mouse pointer is small enough to sit above what it is describing.
    assert.strictEqual(tipPlacement('mouse', 20, 20).above, false);
});

t('at the top of the picture the readout goes below, with nowhere above to go', () => {
    // Flipping up there hangs the tip off the image and scrolls the modal to
    // reach it, which resizes the thing being pointed at.
    assert.strictEqual(tipPlacement('touch', 20, 0).above, false);
    assert.strictEqual(tipPlacement('touch', 20, 5).above, false);
    assert.strictEqual(tipPlacement('touch', 20, 30).above, true);
});

t('the readout flips away from the edges rather than being clipped', () => {
    assert.strictEqual(tipPlacement('mouse', 90, 20).left, true);
    assert.strictEqual(tipPlacement('mouse', 10, 20).left, false);
    assert.strictEqual(tipPlacement('mouse', 10, 95).above, true);
    // Bottom right corner: both ways at once.
    const corner = tipPlacement('touch', 95, 95);
    assert.deepStrictEqual(corner, { left: true, above: true });
});

console.log(`\n${pass} passed`);
