// The frequency-reference badge.
//
// A port of widgets/frequency.widget.html, whose whole logic was three branches on one
// number — so what is worth pinning down is the boundaries between them and the several
// ways a receiver can have nothing to say.

const assert = require('assert');
const fr = require('./.build/freqref.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const desc = (ref) => ({ frequency_reference: ref });

// --- is there anything to say? -------------------------------------------------

t('a receiver that does not run the monitor has no badge', () => {
    assert.strictEqual(fr.freqOffset({}), null);
    assert.strictEqual(fr.freqOffset(null), null);
    assert.strictEqual(fr.freqOffset(desc(null)), null);
});

t('a monitor with no history yet has no badge either', () => {
    // The server sends the block with `enabled` alone until it has averaged something,
    // which is the state a receiver is in for the first minute after it starts.
    assert.strictEqual(fr.freqOffset(desc({ enabled: true })), null);
    assert.strictEqual(fr.freqOffset(desc({ enabled: true, frequency_offset: null })), null);
});

t('a field that is not a number is not an offset', () => {
    assert.strictEqual(fr.freqOffset(desc({ frequency_offset: 'x' })), null);
    assert.strictEqual(fr.freqOffset(desc({ frequency_offset: NaN })), null);
});

t('an offset of zero is an offset, not a missing one', () => {
    // The distinction the whole badge turns on: zero is the good case, and treating it
    // as absent would hide the one reading worth confirming.
    assert.strictEqual(fr.freqOffset(desc({ frequency_offset: 0 })), 0);
    assert.strictEqual(fr.offsetBand(0), 'good');
});

// --- the three bands ------------------------------------------------------------

t('green only at zero, amber to five, red beyond', () => {
    assert.strictEqual(fr.offsetBand(0), 'good');
    assert.strictEqual(fr.offsetBand(1), 'warn');
    assert.strictEqual(fr.offsetBand(5), 'warn', 'five is included');
    assert.strictEqual(fr.offsetBand(5.1), 'bad');
    assert.strictEqual(fr.offsetBand(40), 'bad');
});

t('the sign does not change how bad it is', () => {
    // Twelve hertz low is as wrong as twelve hertz high; only the label carries the
    // direction.
    for (const hz of [1, 5, 6, 30]) {
        assert.strictEqual(fr.offsetBand(-hz), fr.offsetBand(hz), `${hz}`);
    }
});

t('nothing to report is no band at all, rather than a good one', () => {
    assert.strictEqual(fr.offsetBand(null), '');
    assert.strictEqual(fr.offsetBand(undefined), '');
    assert.strictEqual(fr.offsetBand('fine'), '');
});

// --- how it reads -----------------------------------------------------------------

t('the label is signed, and rounded to the hertz the monitor reports', () => {
    assert.strictEqual(fr.offsetLabel(3), '+3 Hz');
    assert.strictEqual(fr.offsetLabel(-12), '-12 Hz');
    assert.strictEqual(fr.offsetLabel(2.4), '+2 Hz');
});

t('zero is unsigned: "+0 Hz" reads as an error too small to show, which is not the claim', () => {
    assert.strictEqual(fr.offsetLabel(0), '0 Hz');
    assert.strictEqual(fr.offsetLabel(0.2), '0 Hz');
    assert.strictEqual(fr.offsetLabel(-0.2), '0 Hz');
});

t('the tooltip says whose error it is, and what else is known about it', () => {
    const title = fr.offsetTitle(desc({
        frequency_offset: 7, expected_frequency: 10000000, snr: 24.5,
    }));
    assert.ok(title.includes('+7 Hz'));
    assert.ok(title.includes('10.000 MHz'), 'the station it is measured against');
    assert.ok(title.includes('24.5 dB'));
});

t('an accurate receiver is told so plainly rather than in the language of error', () => {
    const title = fr.offsetTitle(desc({ frequency_offset: 0 }));
    assert.ok(/on frequency/i.test(title));
    assert.ok(!title.includes('away from'));
});

t('nothing measured, nothing said', () => {
    assert.strictEqual(fr.offsetTitle({}), '');
    assert.strictEqual(fr.offsetLabel(null), '');
});

if (process.exitCode) console.log('\nfrequency reference tests FAILED');
else console.log(`\nall ${pass} frequency reference tests passed`);
