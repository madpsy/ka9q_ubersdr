// Pressing a band button, and the one message it has to be.
//
// Four panels move the receiver to a band through tuneToBand — the Quick bands keys, the
// Multipad's band row, the space weather panel and the band stats panel — so what it does
// is what a band button does everywhere.
//
// It used to centre and zoom in two steps, and that is a trap rather than a style: setView
// keeps the whole window inside the band, and a centre sent without a span is clamped
// against the span already on screen. Zoomed out, that span is the whole receiver, so
// there is exactly one legal centre — the middle — and every band went there. The zoom
// that followed then closed around the middle of the receiver, leaving a correct dial
// beside a spectrum showing the wrong place. Zoomed in, the same code worked, which is
// what made it look like an intermittent glitch instead of a rule.

const assert = require('assert');
const { MIN_BAND_SPAN, tuneToBand } = require('./.build/bands.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A stand-in for the radio actions that records what it was asked to do. Every method the
// real object has that tuneToBand might reach for is here, so calling a wrong one is a
// recorded fact rather than a TypeError that happens to fail the test for another reason.
function recorder() {
    const calls = [];
    const log = (name) => (...args) => calls.push([name, ...args]);
    return {
        calls,
        named: (n) => calls.filter(([name]) => name === n),
        setMode: log('setMode'),
        setFrequency: log('setFrequency'),
        setSpectrumView: log('setSpectrumView'),
        setSpectrumCenter: log('setSpectrumCenter'),
        setSpan: log('setSpan'),
    };
}

const TWENTY = [14000000, 14350000];
const SIX = [50000000, 52000000];

// --- one message, not two ---------------------------------------------------

t('centre and span go together, in a single setSpectrumView', () => {
    const a = recorder();
    tuneToBand(a, ...TWENTY);
    assert.strictEqual(a.named('setSpectrumView').length, 1, 'exactly one view call');
    const [, centre, span] = a.named('setSpectrumView')[0];
    assert.strictEqual(centre, 14175000, 'the middle of the band');
    assert.strictEqual(span, 350000, 'the width of the band');
});

t('the old two-call path is gone', () => {
    // Named explicitly because the bug was invisible: both forms tune correctly and only
    // the view ends up wrong, so nothing here would fail if someone put them back.
    const a = recorder();
    tuneToBand(a, ...TWENTY);
    assert.strictEqual(a.named('setSpectrumCenter').length, 0, 'no separate centre call');
    assert.strictEqual(a.named('setSpan').length, 0, 'no separate span call');
});

t('the dial still goes to the middle of the band', () => {
    const a = recorder();
    tuneToBand(a, ...SIX);
    assert.deepStrictEqual(a.named('setFrequency')[0], ['setFrequency', 51000000]);
});

// --- the span floor ---------------------------------------------------------

t('a band narrower than the floor still gets the floor', () => {
    // 30m is 50 kHz wide; v1 never zooms tighter than 10 kHz on a band press.
    const a = recorder();
    tuneToBand(a, 10100000, 10150000);
    const [, , span] = a.named('setSpectrumView')[0];
    assert.strictEqual(span, 50000, 'wider than the floor, so its own width');

    const b = recorder();
    tuneToBand(b, 10100000, 10100000 + 1000);
    assert.strictEqual(b.named('setSpectrumView')[0][2], MIN_BAND_SPAN, 'floored');
});

// --- the mode that comes with the band --------------------------------------

t('below 10 MHz is LSB, above is USB', () => {
    const low = recorder();
    tuneToBand(low, 3500000, 4000000);
    assert.deepStrictEqual(low.named('setMode')[0], ['setMode', 'lsb']);

    const high = recorder();
    tuneToBand(high, ...TWENTY);
    assert.deepStrictEqual(high.named('setMode')[0], ['setMode', 'usb']);
});

t("a band that declares its own mode keeps it", () => {
    const a = recorder();
    tuneToBand(a, 3500000, 4000000, 'am');
    assert.deepStrictEqual(a.named('setMode')[0], ['setMode', 'am']);
});

// --- why one message rather than two -----------------------------------------
//
// The rule that made the old form fail, asserted directly so the reason survives even if
// tuneToBand is rewritten again. clampCenter is what setView applies to keep the window
// inside the band, and it is the whole story.

const view = require('./.build/tuningrange.cjs');

t('at full zoom-out there is only one legal centre, and it is the middle', () => {
    view.applyTuningRange({
        min_frequency: 10000, max_frequency: 60000000, spectrum_span_hz: 60000000,
    });
    const sixMetreCentre = 51000000;
    // What the old first call did: a centre judged against the span already on screen.
    assert.strictEqual(view.clampCenter(sixMetreCentre, 60000000), 30000000,
        'a 60 MHz window on a 60 MHz receiver can sit nowhere but the middle');
    // Which is correct in itself — the whole band is on screen — and is precisely why the
    // centre must not be sent before the span that makes it meaningful.
});

t('the same centre survives once it is judged against the span being asked for', () => {
    view.applyTuningRange({
        min_frequency: 10000, max_frequency: 60000000, spectrum_span_hz: 60000000,
    });
    assert.strictEqual(view.clampCenter(51000000, 2000000), 51000000,
        '6 m with a 2 MHz window is reachable');
});

t('a low band is pushed off the bottom by a wide span, and fits with a narrow one', () => {
    // The other end of the same rule: 160 m cannot be centred under a 60 MHz window
    // either, so the old form sent every low band to the middle too.
    view.applyTuningRange({
        min_frequency: 10000, max_frequency: 60000000, spectrum_span_hz: 60000000,
    });
    const oneSixty = 1905000;
    assert.strictEqual(view.clampCenter(oneSixty, 60000000), 30000000, 'squashed when wide');
    assert.strictEqual(view.clampCenter(oneSixty, 190000), oneSixty, 'exact when narrow');
});

console.log(`\n${pass} passed`);
