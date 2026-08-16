// Frequency formatting.
//
// Two formatters with different jobs, and the difference matters: one labels a
// bookmark or an axis tick and rounds to whatever the zoom can show, the other
// is the cursor readout and must not round at all.

const assert = require('assert');
const {
    formatFilterWidth, formatFreqExact, formatFreqShort, formatHz, padReading,
} = require('./.build/format.cjs');

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

// --- the filter width --------------------------------------------------------

t('a passband reads as its width, in the unit that suits it', () => {
    // Shown in the top bar beside the mode, and in the spectrum tooltip when
    // the pointer is on the filter.
    assert.strictEqual(formatFilterWidth(50, 2700), '2.65k');
    assert.strictEqual(formatFilterWidth(-2700, -50), '2.65k', 'lower sideband is the same width');
    assert.strictEqual(formatFilterWidth(-5000, 5000), '10.00k');
    // Under a kilohertz reads in hertz: "0.25k" is a worse way of writing 250.
    assert.strictEqual(formatFilterWidth(-125, 125), '250');
    assert.strictEqual(formatFilterWidth(-200, 200), '400');
});

t('a passband with no width says nothing rather than zero', () => {
    assert.strictEqual(formatFilterWidth(0, 0), '');
    assert.strictEqual(formatFilterWidth(null, null), '');
    assert.strictEqual(formatFilterWidth(undefined, undefined), '');
});

// --- a live reading that holds its columns -----------------------------------
//
// The Signal and Noise cards meter something that wanders across -100 dBFS, and
// the point of the padding is that the decimal point does not move when it does.

const NBSP = '\u00a0';

t('a reading past a hundred and one short of it are the same width', () => {
    assert.strictEqual(padReading(-100.4), '-100.4');
    assert.strictEqual(padReading(-90.5), `-${NBSP}90.5`);
    assert.strictEqual(padReading(-90.5).length, padReading(-100.4).length);
    // ...and the point lands in the same column, which is the part the eye reads.
    assert.strictEqual(padReading(-90.5).indexOf('.'), padReading(-100.4).indexOf('.'));
});

t('the sign has a column of its own', () => {
    // So a positive reading does not sit one place left of a negative one.
    assert.strictEqual(padReading(9.5), `${NBSP}${NBSP}${NBSP}9.5`);
    assert.strictEqual(padReading(9.5).length, padReading(-100.4).length);
});

t('the pad is a no-break space, because HTML eats the other kind', () => {
    assert.ok(!padReading(-90.5).includes(' '), 'an ordinary space would collapse');
});

t('nothing to show is an em dash, not a padded zero', () => {
    // The reservation on the card holds the width in this case — a placeholder
    // padded out to six characters would read as a measurement of nothing.
    for (const v of [null, undefined, NaN, Infinity]) assert.strictEqual(padReading(v), '\u2014');
});

t('a reading wider than the reservation is printed in full', () => {
    // Never truncated: a meter that lies is worse than one that reflows.
    assert.strictEqual(padReading(-1234.5), '-1234.5');
});

console.log(`\n${pass} ok`);
