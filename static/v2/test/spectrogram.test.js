// The rolling spectrogram panel's arithmetic: which recorder to show, and the
// two axes that say what the picture is.

const assert = require('assert');
const {
    DEFAULT_BAND, bandForView, formatTickHz, freqTickStep, freqTicks,
    timeTickStepMinutes, timeTicks,
} = require('./.build/spectrogram.cjs');

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

console.log(`\n${pass} passed`);
