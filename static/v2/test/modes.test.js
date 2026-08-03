// Mode passbands: defaults, limits, and the invariant between them.
//
// The bug that prompted these: `bandwidthLimits` described CW as a
// single-sideband mode, so `tuneTo` — which clamps into those limits — turned
// CW's own symmetric -200..+200 default into 0..200. The mode changed
// correctly, and the spectrum's passband overlay drew exactly what it was
// given, so the only visible symptom was a narrow one-sided band on the
// waterfall after clicking a CW spot. Nothing threw, and picking CW from the
// mode buttons (which goes through `setMode`, and does not clamp) looked fine.

const assert = require('assert');
const {
    MODES, MODE_BY_ID, bandwidthLimits, maxFilterWidth,
} = require('./.build/constants.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// What RadioContext's tuneTo does to a passband when the mode changes.
function clampToMode(mode, low, high) {
    const l = bandwidthLimits(mode);
    return [clamp(Math.round(low), l.min, l.max), clamp(Math.round(high), l.min, l.max)];
}

// --- the invariant ----------------------------------------------------------

t('every mode’s default passband survives its own limits', () => {
    // This is the whole bug in one assertion. A default outside its limits is
    // silently rewritten the moment anything clamps — and tuning to a spot does.
    for (const m of MODES) {
        const [low, high] = clampToMode(m.id, m.low, m.high);
        assert.strictEqual(low, m.low, `${m.id} low ${m.low} clamped to ${low}`);
        assert.strictEqual(high, m.high, `${m.id} high ${m.high} clamped to ${high}`);
    }
});

t('every mode’s default passband has the low edge below the high edge', () => {
    for (const m of MODES) {
        assert.ok(m.low < m.high, `${m.id}: ${m.low}..${m.high}`);
    }
});

t('every mode’s limits admit a usable filter', () => {
    for (const m of MODES) {
        assert.ok(maxFilterWidth(m.id) >= 100, `${m.id} allows only ${maxFilterWidth(m.id)} Hz`);
    }
});

// --- CW ---------------------------------------------------------------------

t('CW is symmetric about the carrier in both sidebands', () => {
    // v1's combinedValueToLowHigh returns [-v, v] for cwu and cwl alike. The
    // name says which sideband the tone is on, not which side the filter is.
    for (const id of ['cwu', 'cwl']) {
        const m = MODE_BY_ID[id];
        assert.strictEqual(m.low, -m.high, `${id}: ${m.low}..${m.high}`);
        assert.strictEqual(bandwidthLimits(id).sideband, 'both');
    }
});

t('tuning to a CW spot keeps the symmetric passband', () => {
    // The reported symptom, both sides of the 10 MHz crossover.
    for (const id of ['cwu', 'cwl']) {
        const m = MODE_BY_ID[id];
        assert.deepStrictEqual(clampToMode(id, m.low, m.high), [-200, 200]);
    }
});

t('CW limits match v1’s sliders: -500..0 and 0..500', () => {
    for (const id of ['cwu', 'cwl']) {
        assert.deepStrictEqual(bandwidthLimits(id), { min: -500, max: 500, sideband: 'both' });
    }
});

// --- the sideband modes, which are genuinely one-sided ----------------------

t('USB and LSB stay one-sided', () => {
    // The fix must not make everything symmetric: these really do occupy one
    // side, and the width/shift sliders key off `sideband` to edit the right
    // edge.
    assert.strictEqual(bandwidthLimits('usb').sideband, 'upper');
    assert.strictEqual(bandwidthLimits('lsb').sideband, 'lower');
    assert.ok(bandwidthLimits('usb').min >= 0);
    assert.ok(bandwidthLimits('lsb').max <= 0);
});

t('LSB’s passband is entirely below the carrier, USB’s entirely above', () => {
    assert.ok(MODE_BY_ID.lsb.low < 0 && MODE_BY_ID.lsb.high < 0);
    assert.ok(MODE_BY_ID.usb.low > 0 && MODE_BY_ID.usb.high > 0);
});

// --- the other symmetric modes ---------------------------------------------

t('FM keeps its full ±8 kHz, as v1 allows', () => {
    // Same latent fault as CW: FM's ±8000 default sat outside the shared ±6000
    // default limit, so tuning to it would have narrowed the filter.
    const m = MODE_BY_ID.fm;
    assert.deepStrictEqual(clampToMode('fm', m.low, m.high), [m.low, m.high]);
    assert.strictEqual(maxFilterWidth('fm'), 16000);
});

t('AM, SAM and NFM are symmetric', () => {
    for (const id of ['am', 'sam', 'nfm']) {
        const m = MODE_BY_ID[id];
        assert.strictEqual(m.low, -m.high, `${id}: ${m.low}..${m.high}`);
        assert.strictEqual(bandwidthLimits(id).sideband, 'both');
    }
});

console.log(`\nall ${pass} mode passband tests passed`);
