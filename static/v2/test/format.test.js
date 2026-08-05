// Frequency formatting.
//
// Two formatters with different jobs, and the difference matters: one labels a
// bookmark or an axis tick and rounds to whatever the zoom can show, the other
// is the cursor readout and must not round at all.

const assert = require('assert');
const { formatFreqExact, formatFreqShort, formatHz } = require('./.build/format.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('the cursor readout keeps every hertz, whatever the zoom', () => {
    // The complaint this fixes: formatFreqShort takes the span, and at a wide
    // one it was rounding the cursor to the nearest kilohertz.
    assert.strictEqual(formatFreqExact(14074001), '14.074001 MHz');
    assert.strictEqual(formatFreqExact(14074000), '14.074000 MHz');
    assert.strictEqual(formatFreqExact(7100001), '7.100001 MHz');
});

t('a 1 Hz step is visible in the readout', () => {
    // The whole point: two frequencies one hertz apart must not print the same.
    for (const hz of [1810000, 7100000, 14074000, 28500000]) {
        assert.notStrictEqual(formatFreqExact(hz), formatFreqExact(hz + 1), String(hz));
    }
});

t('below a megahertz it reads in kHz, still to the hertz', () => {
    assert.strictEqual(formatFreqExact(475000), '475.000 kHz');
    assert.strictEqual(formatFreqExact(475001), '475.001 kHz');
    assert.strictEqual(formatFreqExact(198000), '198.000 kHz');
});

t('the width does not move as the digits change', () => {
    // These update as the pointer moves. Trimming trailing zeros would make the
    // readout jitter and shuffle the badge along beside it.
    const widths = new Set([14000000, 14074001, 14999999].map((hz) => formatFreqExact(hz).length));
    assert.strictEqual(widths.size, 1, 'MHz readouts changed width');
    const kHz = new Set([100000, 475001, 999999].map((hz) => formatFreqExact(hz).length));
    assert.strictEqual(kHz.size, 1, 'kHz readouts changed width');
});

t('a fractional hertz is rounded rather than printed', () => {
    // freqAtX maps a pixel to a frequency and does not land on integers.
    assert.strictEqual(formatFreqExact(14074000.4), '14.074000 MHz');
    assert.strictEqual(formatFreqExact(14074000.6), '14.074001 MHz');
});

t('nothing to show is still something to print', () => {
    assert.strictEqual(formatFreqExact(0), '0.000 kHz');
    assert.strictEqual(formatFreqExact(null), '0.000 kHz');
    assert.strictEqual(formatFreqExact(undefined), '0.000 kHz');
});

t('the short label still rounds to the zoom, which is its job', () => {
    // Unchanged, and deliberately: it labels axis ticks, bookmarks and menu
    // entries, where every hertz would be noise.
    assert.strictEqual(formatFreqShort(14074000, 5e3), '14074.00 kHz');
    assert.strictEqual(formatFreqShort(14074000, 50e3), '14074.0 kHz');
    assert.strictEqual(formatFreqShort(14074000), '14.074 MHz');
    assert.strictEqual(formatFreqShort(14000000), '14 MHz');
});

t('formatHz groups the way the dial does', () => {
    assert.strictEqual(formatHz(14175000), '14.175.000');
    assert.strictEqual(formatHz(475000), '0.475.000');
});

console.log(`\n${pass} ok`);
