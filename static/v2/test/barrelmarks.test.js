// Which markers get drawn inside the frequency drum.
//
// Every rule here is about refusing to draw: a busy band puts dozens of spots
// across one span, and the failure mode is not a crash but a smear of names
// over the numbers underneath — which is invisible in a test that only asks
// whether something was returned. So these ask *what* survives, and what the
// spacing is when it does.

const assert = require('assert');
const {
    EDGE_RESERVE_PX, MIN_GAP_PX, markId, placeBarrelMarks,
} = require('./.build/barrelmarks.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A drum tuned to 7,100 kHz with 500 Hz detents 46 px apart: one detent is
// 500 Hz, so 46 px is 500 Hz and a kilohertz is 92 px.
const base = { centreHz: 7100000, stepHz: 500, detentPx: 46, widthPx: 900, edges: true };
const at = (khz, extra) => ({ freq: 7100000 + khz * 1000, type: 'dx', name: `M${khz}`, ...extra });

t('nothing to draw is nothing drawn', () => {
    assert.deepStrictEqual(placeBarrelMarks({ ...base, markers: [] }), []);
    assert.deepStrictEqual(placeBarrelMarks({ ...base, markers: null }), []);
});

t('a drum too narrow for the middle draws none at all', () => {
    // A phone's pad with the step buttons up: both ends are spoken for and what
    // is left is not worth scattering names across.
    const markers = [at(0), at(1)];
    assert.deepStrictEqual(placeBarrelMarks({ ...base, markers, widthPx: 360 }), []);
    // The same drum without the buttons has the room.
    assert.ok(placeBarrelMarks({ ...base, markers, widthPx: 360, edges: false }).length > 0);
});

t('a narrow drum still shows the marker under the dial', () => {
    // The one mark that cannot be read off the numbers, in the one place on the
    // drum furthest from the step buttons. A phone in portrait.
    const here = at(0, { name: 'HERE' });
    // 390 px is a handset's pad: 110 px of middle once both ends are reserved.
    const marks = placeBarrelMarks({
        ...base, markers: [here, at(1)], widthPx: 390, currentHz: here.freq,
    });
    assert.deepStrictEqual(marks.map((m) => m.marker.name), ['HERE']);
    assert.strictEqual(marks[0].x, 0);
    // Capped to the room, so a long name cannot reach under a step button's
    // own caption.
    assert.ok(marks[0].maxWidthPx > 0 && marks[0].maxWidthPx <= 390 - 2 * EDGE_RESERVE_PX);
});

t('a narrow drum with nothing under the dial stays plain', () => {
    assert.deepStrictEqual(
        placeBarrelMarks({ ...base, markers: [at(1)], widthPx: 390, currentHz: null }), [],
    );
    // ...and one too narrow even for a name in the middle shows nothing.
    const here = at(0, { name: 'HERE' });
    assert.deepStrictEqual(
        placeBarrelMarks({ ...base, markers: [here], widthPx: 300, currentHz: here.freq }), [],
    );
});

t('markers off the visible scale are left out', () => {
    // 900 px wide, 140 reserved each end, so ±310 px — about ±3.4 kHz.
    const marks = placeBarrelMarks({ ...base, markers: [at(0), at(20)] });
    assert.deepStrictEqual(marks.map((m) => m.marker.name), ['M0']);
});

t('two markers closer than the gap do not both appear', () => {
    // 0.4 kHz apart is 37 px, well inside the minimum.
    const marks = placeBarrelMarks({ ...base, markers: [at(1), at(1.4)] });
    assert.strictEqual(marks.length, 1);
});

t('what is kept is spaced by at least the minimum', () => {
    const markers = [];
    for (let k = -3; k <= 3; k += 0.25) markers.push(at(k));
    const marks = placeBarrelMarks({ ...base, markers });
    for (let i = 1; i < marks.length; i++) {
        assert.ok(marks[i].x - marks[i - 1].x >= MIN_GAP_PX,
            `${marks[i - 1].x} and ${marks[i].x} are too close`);
    }
});

t('never more than the cap, however busy the band', () => {
    const markers = [];
    for (let k = -3; k <= 3; k += 0.1) markers.push(at(k));
    assert.ok(placeBarrelMarks({ ...base, markers }).length <= 4);
});

t('the dial’s own marker is kept even when crowded out', () => {
    // Two markers either side of the dial, both nearer than the gap: without
    // the priority the dial's own would lose to whichever was measured first.
    const here = at(0, { name: 'HERE' });
    const markers = [at(-0.5), here, at(0.5), at(3)];
    const marks = placeBarrelMarks({ ...base, markers, currentHz: here.freq });
    assert.ok(marks.some((m) => m.marker.name === 'HERE'), 'the dial’s marker was dropped');
});

t('marks come back in scale order, left to right', () => {
    const marks = placeBarrelMarks({ ...base, markers: [at(2), at(-2), at(0)] });
    const xs = marks.map((m) => m.x);
    assert.deepStrictEqual(xs.slice().sort((a, b) => a - b), xs);
});

t('the ends are reserved for the step buttons', () => {
    // A marker that would land under an edge caption is not drawn there.
    const marks = placeBarrelMarks({ ...base, markers: [at(4)] });
    assert.deepStrictEqual(marks, []);
    // ...and the same marker is fine once the buttons are gone.
    assert.strictEqual(placeBarrelMarks({ ...base, markers: [at(4)], edges: false }).length, 1);
    assert.ok(EDGE_RESERVE_PX > 100);
});

t('the same marker keeps its identity as its frequency wobbles', () => {
    // A voice-activity marker is re-detected a few hertz off; treating that as
    // a different mark unmounted and remounted it, which is a blink where
    // nothing moved.
    assert.strictEqual(markId({ type: 'voice', freq: 7100040 }), markId({ type: 'voice', freq: 7100010 }));
    // A different feed at the same spot is still a different mark.
    assert.notStrictEqual(markId({ type: 'dx', freq: 7100000 }), markId({ type: 'cw', freq: 7100000 }));
});

t('what is on screen stays on screen while it is still in view', () => {
    // Two markers too close for both. Whichever is already shown keeps the
    // place — otherwise they trade it as the dial moves, which is the flicker
    // this exists to stop.
    const a = at(1);          // 92 px right of centre
    const b = at(1.5);        // 138 px — 46 px apart, inside the gap
    const first = placeBarrelMarks({ ...base, markers: [a, b] });
    assert.strictEqual(first.length, 1);
    const kept = first[0].marker;
    const other = kept === a ? b : a;
    const again = placeBarrelMarks({
        ...base, markers: [other, kept], keep: first.map((m) => m.id),
    });
    assert.deepStrictEqual(again.map((m) => m.marker.name), [kept.name]);
});

t('a kept mark still gives way to the dial’s own', () => {
    const here = at(0, { name: 'HERE' });
    const near = at(0.5, { name: 'NEAR' });
    const first = placeBarrelMarks({ ...base, markers: [near] });
    assert.deepStrictEqual(first.map((m) => m.marker.name), ['NEAR']);
    const again = placeBarrelMarks({
        ...base, markers: [near, here], currentHz: here.freq, keep: first.map((m) => m.id),
    });
    assert.deepStrictEqual(again.map((m) => m.marker.name), ['HERE']);
});

console.log(`\n${pass} ok`);
