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
    FILTER_WIDTH_MIN, MODES, MODE_BY_ID, bandwidthLimits, edgesForEdgeDrag,
    edgesForWidth, maxFilterWidth,
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

// --- editing the filter ------------------------------------------------------
//
// Three controls set the same thing now — the Receiver panel's width slider,
// dragging a passband edge on the spectrum, and shift+wheel over it — so the
// rule lives here and all three call it.

const at = (mode) => ({ mode, bandwidthLow: MODE_BY_ID[mode].low, bandwidthHigh: MODE_BY_ID[mode].high });

t('a width grows the sideband away from the carrier', () => {
    assert.deepStrictEqual(edgesForWidth('usb', 3000, at('usb')), [50, 3050]);
    assert.deepStrictEqual(edgesForWidth('lsb', 3000, at('lsb')), [-3050, -50]);
});

t('a width grows a symmetric mode either side of where it already is', () => {
    assert.deepStrictEqual(edgesForWidth('am', 8000, at('am')), [-4000, 4000]);
    // And keeps the shift: an AM filter offset by 1 kHz stays offset.
    assert.deepStrictEqual(
        edgesForWidth('am', 8000, { mode: 'am', bandwidthLow: -4000, bandwidthHigh: 6000 }),
        [-3000, 5000],
    );
});

t('a width is held between the narrowest useful filter and the mode maximum', () => {
    assert.deepStrictEqual(edgesForWidth('usb', 10, at('usb')), [50, 50 + FILTER_WIDTH_MIN]);
    const [low, high] = edgesForWidth('usb', 99999, at('usb'));
    const l = bandwidthLimits('usb');
    assert.ok(low >= l.min && high <= l.max, `${low}..${high} outside ${l.min}..${l.max}`);
});

t('dragging an SSB edge moves that edge and leaves the other alone', () => {
    assert.deepStrictEqual(edgesForEdgeDrag('usb', 'high', 2000, at('usb')), [50, 2000]);
    assert.deepStrictEqual(edgesForEdgeDrag('usb', 'low', 300, at('usb')), [300, 2700]);
    assert.deepStrictEqual(edgesForEdgeDrag('lsb', 'low', -2000, at('lsb')), [-2000, -50]);
});

t('dragging a symmetric mode mirrors, about the passband it already has', () => {
    // An AM filter with one side longer than the other is almost never what
    // dragging an edge meant; the shift slider is there for when it is.
    assert.deepStrictEqual(edgesForEdgeDrag('am', 'high', 3000, at('am')), [-3000, 3000]);
    assert.deepStrictEqual(edgesForEdgeDrag('am', 'low', -3000, at('am')), [-3000, 3000]);
    // CW is symmetric too, whatever its name says about sidebands.
    assert.deepStrictEqual(edgesForEdgeDrag('cwu', 'high', 400, at('cwu')), [-400, 400]);
    // A shifted filter stays shifted.
    assert.deepStrictEqual(
        edgesForEdgeDrag('am', 'high', 5000, { mode: 'am', bandwidthLow: 0, bandwidthHigh: 2000 }),
        [-3000, 5000],
    );
});

t('an edge cannot be dragged through the other one', () => {
    // Past it, the filter would be inside out. It stops at the narrowest the
    // width slider offers.
    const [low, high] = edgesForEdgeDrag('usb', 'high', -5000, at('usb'));
    assert.strictEqual(low, 50);
    assert.strictEqual(high, 50 + FILTER_WIDTH_MIN);
    const dragged = edgesForEdgeDrag('usb', 'low', 9000, at('usb'));
    assert.deepStrictEqual(dragged, [2700 - FILTER_WIDTH_MIN, 2700]);
});

// Every mode, by name, because "symmetric" is a property of the mode rather
// than of the code editing it — and the one that bit before was CW, which is
// symmetric despite a name that says sideband.
const SYMMETRY = {
    usb: 'upper', lsb: 'lower',
    am: 'both', sam: 'both', nfm: 'both', fm: 'both', cwu: 'both', cwl: 'both',
};

t('every mode is covered by the symmetry table', () => {
    assert.deepStrictEqual(MODES.map((m) => m.id).sort(), Object.keys(SYMMETRY).sort());
});

for (const [id, sideband] of Object.entries(SYMMETRY)) {
    t(`${id}: ${sideband === 'both' ? 'a dragged edge mirrors' : 'a dragged edge moves alone'}`, () => {
        assert.strictEqual(bandwidthLimits(id).sideband, sideband, `${id} changed sideband class`);
        const start = at(id);
        const l = bandwidthLimits(id);
        // Somewhere inside the mode's limits and clear of the other edge.
        const target = Math.round(l.max * 0.6);

        const [low, high] = edgesForEdgeDrag(id, 'high', target, start);
        if (sideband === 'both') {
            const mid = (start.bandwidthLow + start.bandwidthHigh) / 2;
            assert.strictEqual(high - mid, mid - low, `${id} came out lopsided: ${low}..${high}`);
            assert.notStrictEqual(low, start.bandwidthLow, `${id} left the far edge behind`);
        } else if (sideband === 'upper') {
            assert.strictEqual(low, start.bandwidthLow, `${id} moved the edge nobody grabbed`);
            assert.strictEqual(high, target);
        } else {
            // The low edge is the outer one below the carrier; grabbing `high`
            // moves the inner edge and leaves the outer where it was.
            assert.strictEqual(low, start.bandwidthLow, `${id} moved the edge nobody grabbed`);
        }
    });
}

t('a drag cannot shut the filter to something it can no longer grab', () => {
    // The trap: dragging an edge through the other one closed the filter to its
    // 100 Hz floor, which at any normal zoom is a fraction of a pixel wide. The
    // two lines then sat on top of each other with nothing to take hold of, and
    // the gesture had reached a state it could not undo. The spectrum passes
    // the width of its own grab zone as the floor.
    const MIN = 600;   // whatever the grab zone works out to in Hz at this zoom
    for (const id of Object.keys(SYMMETRY)) {
        const start = at(id);
        for (const which of ['low', 'high']) {
            // Dragged hard through the other edge, from both directions.
            for (const offset of [-99999, 99999]) {
                const [low, high] = edgesForEdgeDrag(id, which, offset, start, MIN);
                const width = high - low;
                const room = maxFilterWidth(id);
                assert.ok(width >= Math.min(MIN, room) - 1e-9,
                    `${id} ${which} ${offset}: ${width} Hz is narrower than ${MIN}`);
            }
        }
    }
});

t('the floor never overrides the mode floor downwards', () => {
    // A zoom so deep that the grab zone is only a few Hz wide must not let the
    // filter go below what the width slider offers.
    const [low, high] = edgesForEdgeDrag('usb', 'high', -9999, at('usb'), 5);
    assert.strictEqual(high - low, FILTER_WIDTH_MIN);
});

t('a dragged edge stays inside the mode limits', () => {
    for (const m of MODES) {
        const l = bandwidthLimits(m.id);
        for (const which of ['low', 'high']) {
            for (const offset of [-99999, 99999]) {
                const [low, high] = edgesForEdgeDrag(m.id, which, offset, at(m.id));
                assert.ok(low >= l.min && high <= l.max,
                    `${m.id} ${which} ${offset}: ${low}..${high} outside ${l.min}..${l.max}`);
                assert.ok(high > low, `${m.id} ${which} ${offset}: inside out`);
            }
        }
    }
});

console.log(`\nall ${pass} mode passband tests passed`);
