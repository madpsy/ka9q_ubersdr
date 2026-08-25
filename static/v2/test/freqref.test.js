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

// --- the marks on the spectrum -------------------------------------------------

const REF = {
    enabled: true,
    expected_frequency: 10_000_000,
    detected_frequency: 10_000_004,
    frequency_offset: 4,
    snr: 22.5,
};

t('the marks are absent for every reason the badge is', () => {
    assert.strictEqual(fr.refMarks(null), null);
    assert.strictEqual(fr.refMarks(desc(null)), null);
    assert.strictEqual(fr.refMarks(desc({ enabled: false })), null);
    // Running, but nothing measured yet: the server sends `enabled` alone.
    assert.strictEqual(fr.refMarks(desc({ enabled: true })), null);
});

t('a reference with no expected frequency cannot be drawn', () => {
    // The badge can still show an offset here; the marks cannot, because there
    // is nowhere to put them.
    assert.strictEqual(fr.refMarks(desc({ enabled: true, frequency_offset: 4 })), null);
    assert.strictEqual(fr.refMarks(desc({ ...REF, expected_frequency: 0 })), null);
});

t('the two frequencies are where the station is and where it is heard', () => {
    const m = fr.refMarks(desc(REF));
    assert.strictEqual(m.expectedHz, 10_000_000);
    assert.strictEqual(m.actualHz, 10_000_004);
    assert.strictEqual(m.offsetHz, 4);
});

t('the offset drawn is the gap between the lines, whatever the server called it', () => {
    // The two must agree or the picture contradicts the badge beside it.
    const m = fr.refMarks(desc({ ...REF, detected_frequency: 9_999_990, frequency_offset: 4 }));
    assert.strictEqual(m.offsetHz, -10, 'the offset should follow the frequencies actually drawn');
});

t('a missing detected frequency falls back to the reported offset', () => {
    const m = fr.refMarks(desc({ enabled: true, expected_frequency: 10e6, frequency_offset: -7 }));
    assert.strictEqual(m.actualHz, 9_999_993);
    assert.strictEqual(m.offsetHz, -7);
});

t('the second line waits until the zoom can separate it', () => {
    const m = fr.refMarks(desc(REF));   // 4 Hz out
    // A full-span view: 4 Hz is a ten-thousandth of a pixel.
    assert.strictEqual(fr.refMarksSeparate(m, 30e6, 1000), false);
    // 100 kHz across 1000 px is 100 Hz/px — still one line.
    assert.strictEqual(fr.refMarksSeparate(m, 100e3, 1000), false);
    // 500 Hz across 1000 px is 0.5 Hz/px, so 4 Hz is 8 px — clear of the gap,
    // and the zoom at which a few hertz of error is worth looking at.
    assert.strictEqual(fr.refMarksSeparate(m, 500, 1000), true);
});

t('the boundary is where the halos stop touching', () => {
    const m = fr.refMarks(desc(REF));   // 4 Hz
    // Separation in px is |offset| / span * width. Solve for exactly the gap.
    const span = (4 / fr.REF_MIN_GAP_PX) * 1000;
    assert.strictEqual(fr.refMarksSeparate(m, span, 1000), true, 'exactly the gap should draw');
    assert.strictEqual(fr.refMarksSeparate(m, span * 1.02, 1000), false, 'just under it should not');
});

t('a receiver exactly on frequency draws one line, not two on the same pixel', () => {
    const m = fr.refMarks(desc({ ...REF, detected_frequency: 10e6, frequency_offset: 0 }));
    assert.strictEqual(m.offsetHz, 0);
    // However far in you zoom, there is only one frequency to point at.
    assert.strictEqual(fr.refMarksSeparate(m, 1000, 1000), false);
});

t('nothing to draw is never separate', () => {
    assert.strictEqual(fr.refMarksSeparate(null, 1000, 1000), false);
    const m = fr.refMarks(desc(REF));
    assert.strictEqual(fr.refMarksSeparate(m, 0, 1000), false);
    assert.strictEqual(fr.refMarksSeparate(m, 1000, 0), false);
});

t('each line says what it is', () => {
    const expected = fr.refMarkTitle(desc(REF), 'expected');
    assert.ok(/10\.000000 MHz/.test(expected), expected);
    assert.ok(/\+4 Hz/.test(expected), expected);
    assert.ok(/22\.5 dB/.test(expected), expected);

    const actual = fr.refMarkTitle(desc(REF), 'actual');
    assert.ok(/10\.000004 MHz/.test(actual), actual);
    assert.ok(/high/.test(actual), 'a positive offset reads high');

    const low = fr.refMarkTitle(desc({ ...REF, detected_frequency: 9_999_996, frequency_offset: -4 }), 'actual');
    assert.ok(/low/.test(low), 'a negative offset reads low');
});

t('a receiver on frequency says so rather than reporting a zero error', () => {
    const on = fr.refMarkTitle(desc({ ...REF, detected_frequency: 10e6, frequency_offset: 0 }), 'expected');
    assert.ok(/exactly/.test(on), on);
});

t('there is no title when there are no marks', () => {
    assert.strictEqual(fr.refMarkTitle(desc({ enabled: false }), 'expected'), '');
    assert.strictEqual(fr.refTipText(desc({ enabled: false }), 'ref-expected'), '');
});

t('the hover line is short enough for the readout box', () => {
    const tip = fr.refTipText(desc(REF), 'ref-expected');
    assert.ok(tip.length < 60, `too long for the tip box: ${tip}`);
    assert.ok(/Reference/.test(tip), tip);

    const actual = fr.refTipText(desc(REF), 'ref-actual');
    assert.ok(/10\.000004 MHz/.test(actual), actual);
});

if (process.exitCode) console.log('\nfrequency reference tests FAILED');
else console.log(`\nall ${pass} frequency reference tests passed`);
