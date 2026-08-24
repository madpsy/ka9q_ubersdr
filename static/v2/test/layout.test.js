// First-run layout, per machine — and the one-shot migration that reaches a
// layout somebody already has.
//
// Three machines want three different answers for the same panel, and the rule
// that decides is spread over defaultLayout, firstRun and migrateRev. The part
// worth pinning is not any one of them but the promise they make together: a
// migration must only ever add what this machine has never had an opinion about.

const assert = require('assert');
const { DOCKS, PANEL_BY_ID, REV, defaultLayout, insertNear, reconcile } = require('./.build/layout.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const MOUSE = { phone: false, touch: false };
const TOUCH = { phone: false, touch: true };
const PHONE = { phone: true, touch: true };   // a handset has a touchscreen too

const PAD = 'multipad';
const inAnyDock = (l, id) => DOCKS.some((d) => l.docks[d].panels.includes(id));

// A layout as it would have been stored before any of this existed: the
// Multipad hidden in its dock, no floats, no rev.
const storedOld = (over = {}) => {
    const l = defaultLayout(MOUSE);
    delete l.rev;
    return { ...l, ...over };
};

// --- first run --------------------------------------------------------------

t('a mouse-only desktop does not get the Multipad', () => {
    const l = defaultLayout(MOUSE);
    assert.strictEqual(l.sections[PAD].hidden, true);
    assert.ok(inAnyDock(l, PAD), 'still in its dock, so the layout manager lists it');
    assert.strictEqual(l.floats[PAD], undefined);
});

t('a touchscreen desktop gets it floating, minimal, in the bottom left', () => {
    const l = defaultLayout(TOUCH);
    assert.strictEqual(l.sections[PAD].hidden, false);
    assert.strictEqual(l.sections[PAD].minimal, true, 'the two barrels alone');
    assert.ok(l.floats[PAD], 'floating');
    assert.strictEqual(l.floats[PAD].anchor, 'bottom-left');
    assert.ok(l.floatOrder.includes(PAD));
    // A floating panel belongs to no dock, or it would be drawn twice.
    assert.ok(!inAnyDock(l, PAD), 'must not also be listed in a dock');
});

t('the seeded window is big enough for both barrels and both sliders', () => {
    // The height the registry asks for has to clear the window chrome plus the
    // frequency readout, both barrels and the gaps between them — the whole
    // point of the size being declared rather than left at the default.
    //
    // And both slider rows, each of which this sum has left out once: 188 missed
    // the squelch, 213 missed the width. Both times the panel showed a control
    // the test did not account for, so nothing here objected, and the control
    // adjusted while listening was the one cut off. Measured in the running
    // panel — a floating Multipad at 188 reported scrollHeight 180 against
    // clientHeight 155.
    //
    // Both rows, not one: at this width the minimal view stacks the pair rather
    // than putting them on one line, which is the branch a 390 px window takes
    // — see MultipadPanel. A row is the slider's own 20 px plus the stack's 5 px
    // gap, and .pad-row .btn.pad-row__act pins the width row's reset button to
    // that 20 so the two rows cannot differ.
    const g = defaultLayout(TOUCH).floats[PAD];
    const CHROME = 31 + 10;             // title bar, and the body's bottom padding
    const ROW = 5 + 20;                 // a slider row, and the gap above it
    const CONTENT = 4 + (38 + 5 + 48) + 8 + 38   // .pad, freq head + wheel, gap, zoom
        + ROW                           // the squelch
        + ROW;                          // the width
    assert.ok(g.h >= CHROME + CONTENT, `${g.h} < ${CHROME + CONTENT}`);

    // Width is the head row, which is the widest thing here: a ten-digit
    // readout at its 27 px ceiling, plus the step and mode pickers beside it.
    // The readout has min-width 0 and will shrink into the gap rather than wrap,
    // so too narrow does not look broken — it looks like a frequency with digits
    // missing, which is worse.
    const READOUT = 10 * 16.2 + 22 + 7 + 16;    // digits, "Hz", its gap, padding
    const PICKERS = 72 + 62 + 16;               // step, mode, the gaps either side
    const NEEDED = Math.ceil(READOUT + PICKERS) + 20 + 2;   // body padding, borders
    assert.ok(g.w >= NEEDED, `${g.w} < ${NEEDED} — the head row would not fit`);
});

t('a phone is a phone first, even though it has a touchscreen', () => {
    const l = defaultLayout(PHONE);
    assert.strictEqual(l.sections[PAD].hidden, false);
    // The `mobile` block wins over `touch`: a sheet, not a floating window.
    assert.strictEqual(l.floats[PAD], undefined);
    assert.ok(inAnyDock(l, PAD));
});

t('every panel lands in exactly one place, on every machine', () => {
    for (const env of [MOUSE, TOUCH, PHONE]) {
        const l = defaultLayout(env);
        for (const id of Object.keys(PANEL_BY_ID)) {
            const places = DOCKS.filter((d) => l.docks[d].panels.includes(id)).length
                + (l.floats[id] ? 1 : 0);
            assert.strictEqual(places, 1, `${id} is in ${places} places`);
        }
    }
});

// --- the migration ----------------------------------------------------------

t('a layout stored before this gets the Multipad on a touchscreen desktop', () => {
    const l = reconcile(storedOld(), TOUCH);
    assert.ok(l.floats[PAD], 'floating');
    assert.strictEqual(l.floats[PAD].anchor, 'bottom-left');
    assert.strictEqual(l.sections[PAD].hidden, false);
    assert.strictEqual(l.sections[PAD].minimal, true);
    assert.ok(!inAnyDock(l, PAD));
    assert.strictEqual(l.rev, REV, 'and is recorded, so it happens once');
});

t('it does not happen twice', () => {
    const once = reconcile(storedOld(), TOUCH);
    // Somebody puts it back in a dock afterwards; that has to stick.
    const moved = { ...once, floats: {}, floatOrder: [] };
    moved.docks.left = { ...moved.docks.left, panels: [PAD, ...moved.docks.left.panels] };
    const again = reconcile(moved, TOUCH);
    assert.strictEqual(again.floats[PAD], undefined, 'left where it was put');
    assert.ok(inAnyDock(again, PAD));
});

t('a Multipad somebody had already gone and found is left alone', () => {
    // Unhidden by hand on a machine where the default was hidden: an opinion,
    // so the migration must not touch it.
    const stored = storedOld();
    stored.sections = { ...stored.sections, [PAD]: { ...stored.sections[PAD], hidden: false } };
    const l = reconcile(stored, TOUCH);
    assert.strictEqual(l.floats[PAD], undefined, 'not moved out of its dock');
    assert.ok(inAnyDock(l, PAD));
});

// Neither height it was seeded with had room for everything its minimal view
// shows: 188 was measured without the squelch, 213 without the filter width.
// Correcting either is only safe where nobody has sized the thing themselves.
t('a Multipad still at a height it was given grows to fit both sliders', () => {
    for (const was of [188, 213]) {
        const stored = storedOld();
        stored.rev = 1;
        stored.floats = { [PAD]: { x: 40, y: 400, w: 390, h: was, min: false } };
        stored.floatOrder = [PAD];
        const l = reconcile(stored, TOUCH);
        assert.strictEqual(l.floats[PAD].h, PANEL_BY_ID[PAD].touch.float.h, `from ${was}`);
        assert.strictEqual(l.floats[PAD].w, 390, 'and nothing else about it moves');
        assert.strictEqual(l.floats[PAD].x, 40);
    }
});

t('a height between the two old defaults is somebody’s own', () => {
    // 200 is not a default this project ever shipped, so it is an opinion — and
    // the list is matched exactly rather than as a range for that reason.
    const stored = storedOld();
    stored.rev = 1;
    stored.floats = { [PAD]: { x: 40, y: 400, w: 390, h: 200, min: false } };
    stored.floatOrder = [PAD];
    assert.strictEqual(reconcile(stored, TOUCH).floats[PAD].h, 200);
});

t('a Multipad somebody has resized keeps the height they chose', () => {
    // 188 means "never touched"; any other height is an opinion, and growing it
    // would be undoing an arrangement — the rule every migration here follows.
    const stored = storedOld();
    stored.rev = 1;
    stored.floats = { [PAD]: { x: 40, y: 400, w: 390, h: 150, min: false } };
    stored.floatOrder = [PAD];
    assert.strictEqual(reconcile(stored, TOUCH).floats[PAD].h, 150);
});

t('a Multipad already tall enough is not shrunk to the default', () => {
    const stored = storedOld();
    stored.rev = 1;
    stored.floats = { [PAD]: { x: 40, y: 400, w: 390, h: 400, min: false } };
    stored.floatOrder = [PAD];
    assert.strictEqual(reconcile(stored, TOUCH).floats[PAD].h, 400);
});

t('a Multipad already floating keeps the geometry it was given', () => {
    const stored = storedOld();
    stored.floats = { [PAD]: { x: 500, y: 60, w: 400, h: 300, min: false } };
    stored.floatOrder = [PAD];
    const l = reconcile(stored, TOUCH);
    assert.deepStrictEqual(
        { x: l.floats[PAD].x, y: l.floats[PAD].y, w: l.floats[PAD].w, h: l.floats[PAD].h },
        { x: 500, y: 60, w: 400, h: 300 },
    );
    assert.strictEqual(l.floats[PAD].anchor, undefined, 'a placed window has no anchor');
});

t('nothing happens on a machine the addition is not for', () => {
    for (const env of [MOUSE, PHONE]) {
        const l = reconcile(storedOld(), env);
        assert.strictEqual(l.floats[PAD], undefined);
        // ...and the layout stays *eligible*: the same profile meets a
        // touchscreen later often enough that recording the revision here would
        // quietly cost those machines the panel for ever.
        assert.notStrictEqual(l.rev, 1, 'must not be marked done');
        assert.ok(reconcile(l, TOUCH).floats[PAD], 'so a touchscreen still gets it');
    }
});

t('a stored anchor survives until something places the window', () => {
    // The layer may not have measured before the tab was closed — a panel on a
    // collapsed dock's rail, a window opened and reloaded — and the corner has
    // to still be a corner next time rather than the 0,0 it was stored as.
    const stored = reconcile(storedOld(), TOUCH);
    assert.strictEqual(reconcile(stored, TOUCH).floats[PAD].anchor, 'bottom-left');
});

// The spectrogram panel fetches an image a minute while it is open, so where it
// starts is a bandwidth decision, not only a layout one. Section mounts a
// panel's body only while its section is open — that is what makes "collapsed"
// mean "asks the server for nothing" — so this pins the half of the promise the
// registry is responsible for.
t('the spectrogram panel ships collapsed, on the left, on every machine', () => {
    for (const env of [MOUSE, TOUCH, PHONE]) {
        const l = defaultLayout(env);
        assert.strictEqual(l.sections.spectrogram.open, false, 'must not start open');
    }
    assert.strictEqual(PANEL_BY_ID.spectrogram.dock, 'left');
    assert.ok(inAnyDock(defaultLayout(MOUSE), 'spectrogram'), 'docked, not floating');
});

// Same promise as the spectrogram's, and a heavier one to break: this panel
// holds an EventSource while it is mounted, so shipping it open would put a live
// per-band stream on every session that never opens it.
t('the band spectrum panel ships collapsed, on the left, on every machine', () => {
    for (const env of [MOUSE, TOUCH, PHONE]) {
        assert.strictEqual(defaultLayout(env).sections.bandspectrum.open, false);
    }
    assert.strictEqual(PANEL_BY_ID.bandspectrum.dock, 'left');
    assert.ok(inAnyDock(defaultLayout(MOUSE), 'bandspectrum'), 'docked, not floating');
});

// ── Dragging a panel within its dock ─────────────────────────────────────────
//
// Two things made this hard to aim, and both are here rather than in the
// pointer handling: the panel is removed before it is re-inserted, and the
// anchor is a neighbour's id rather than a position on screen.

t('a panel dropped below its neighbour lands below it', () => {
    // The off-by-one this fixes: with the id removed first, the anchor's index
    // has already shifted, so inserting at the index it had before put the
    // panel one slot too early — dragging down by one did nothing at all.
    assert.deepStrictEqual(insertNear(['a', 'b', 'c'], 'a', 'b', 'after'), ['b', 'a', 'c']);
    assert.deepStrictEqual(insertNear(['a', 'b', 'c'], 'a', 'c', 'after'), ['b', 'c', 'a']);
    assert.deepStrictEqual(insertNear(['a', 'b', 'c'], 'a', 'c', 'before'), ['b', 'a', 'c']);
});

t('a panel dropped above its neighbour lands above it', () => {
    assert.deepStrictEqual(insertNear(['a', 'b', 'c'], 'c', 'a', 'before'), ['c', 'a', 'b']);
    assert.deepStrictEqual(insertNear(['a', 'b', 'c'], 'c', 'b', 'before'), ['a', 'c', 'b']);
    assert.deepStrictEqual(insertNear(['a', 'b', 'c'], 'b', 'a', 'before'), ['b', 'a', 'c']);
});

t('a hidden panel between two visible ones does not move the target', () => {
    // A dock's list holds panels that are hidden, or that this receiver has no
    // use for. Dropping "after the second one you can see" is not the same as
    // inserting at index 2, which is what an index taken from the screen means.
    const dock = ['a', 'hidden1', 'b', 'hidden2', 'c'];
    assert.deepStrictEqual(insertNear(dock, 'c', 'a', 'after'),
        ['a', 'c', 'hidden1', 'b', 'hidden2']);
    assert.deepStrictEqual(insertNear(dock, 'a', 'b', 'after'),
        ['hidden1', 'b', 'a', 'hidden2', 'c']);
});

t('dropping a panel on itself leaves the order alone', () => {
    assert.deepStrictEqual(insertNear(['a', 'b', 'c'], 'b', 'b', 'before'), ['a', 'b', 'c']);
    assert.deepStrictEqual(insertNear(['a', 'b', 'c'], 'b', 'b', 'after'), ['a', 'b', 'c']);
});

t('the panel is never lost, whatever it is dropped on', () => {
    // The bug this pins: with the id stripped from the dock before insertNear
    // ran, a drop anchored on the panel itself removed it and then failed to
    // find an anchor — so the panel disappeared from the layout entirely and
    // only a page reload brought it back.
    const dock = ['a', 'b', 'c'];
    for (const id of dock) {
        for (const anchor of [...dock, 'gone']) {
            for (const edge of ['before', 'after']) {
                const out = insertNear(dock, id, anchor, edge);
                assert.strictEqual(out.filter((p) => p === id).length, 1,
                    `${id} on ${anchor} ${edge}: ${out.join(',')}`);
                assert.strictEqual(out.length, dock.length,
                    `${id} on ${anchor} ${edge} changed the count`);
            }
        }
    }
});

t('a panel arriving from another dock takes the place it was dropped at', () => {
    assert.deepStrictEqual(insertNear(['a', 'b'], 'z', 'a', 'after'), ['a', 'z', 'b']);
    assert.deepStrictEqual(insertNear(['a', 'b'], 'z', 'a', 'before'), ['z', 'a', 'b']);
    assert.deepStrictEqual(insertNear([], 'z', 'nothing', 'before'), ['z']);
});

t('an anchor that is no longer there puts the panel at the end', () => {
    // The layout can change under a drag — another tab, a reset.
    assert.deepStrictEqual(insertNear(['a', 'b'], 'z', 'gone', 'before'), ['a', 'b', 'z']);
});

// --- parked ids -------------------------------------------------------------
//
// An id a stored layout mentions and the registry does not know. It used to be
// dropped, and LayoutProvider writes the layout back on mount — so the pruning
// was persisted before the user had touched anything. A custom panel whose
// manifest has not arrived yet, or whose fetch failed once, would silently lose
// wherever the operator had put it.

const PARKED = 'x:9f3ca1b2-0000-4000-8000-000000000001';

// A stored layout with a custom panel placed in the right dock, sized, and
// switched off — the state a real operator would have.
const storedWithParked = () => {
    const l = defaultLayout(MOUSE);
    l.docks.right.panels = [PARKED, ...l.docks.right.panels];
    l.weights[PARKED] = 2.5;
    l.heights[PARKED] = 260;
    l.sections[PARKED] = { open: false, hidden: true, minimal: true, minimalMobile: false, scale: 1.1 };
    return l;
};

t('an unknown id keeps its place in the dock', () => {
    const l = reconcile(storedWithParked(), MOUSE);
    assert.strictEqual(l.docks.right.panels[0], PARKED, 'parked at the position it was stored at');
});

t('an unknown id keeps its size', () => {
    const l = reconcile(storedWithParked(), MOUSE);
    assert.strictEqual(l.weights[PARKED], 2.5);
    assert.strictEqual(l.heights[PARKED], 260);
});

t('an unknown id keeps hidden, which is an answer somebody already gave', () => {
    const l = reconcile(storedWithParked(), MOUSE);
    assert.ok(l.sections[PARKED], 'section state survives');
    assert.strictEqual(l.sections[PARKED].hidden, true);
    assert.strictEqual(l.sections[PARKED].open, false);
    assert.strictEqual(l.sections[PARKED].minimal, true);
});

t('an unknown id keeps its float geometry', () => {
    const stored = defaultLayout(MOUSE);
    stored.floats[PARKED] = { x: 40, y: 60, w: 300, h: 220, min: false };
    stored.floatOrder = [PARKED, ...stored.floatOrder];
    const l = reconcile(stored, MOUSE);
    assert.deepStrictEqual(
        { x: l.floats[PARKED].x, y: l.floats[PARKED].y, w: l.floats[PARKED].w, h: l.floats[PARKED].h },
        { x: 40, y: 60, w: 300, h: 220 },
    );
    assert.ok(l.floatOrder.includes(PARKED), 'and its place in the float order');
});

t('reconciling twice does not lose a parked id', () => {
    // What actually happens in the app: load, persist, reload. Two rounds is
    // where a fix that only survives the first one shows up.
    const once = reconcile(storedWithParked(), MOUSE);
    const twice = reconcile(once, MOUSE);
    assert.strictEqual(twice.docks.right.panels[0], PARKED);
    assert.strictEqual(twice.weights[PARKED], 2.5);
    assert.strictEqual(twice.sections[PARKED].hidden, true);
});

t('a parked id is not placed again when its panel comes back', () => {
    // Registered panels that are already somewhere in the layout are left
    // alone; the parked entry has to count as "already somewhere", or the panel
    // would be inserted a second time when it returns.
    const l = reconcile(storedWithParked(), MOUSE);
    const all = DOCKS.flatMap((d) => l.docks[d].panels);
    assert.strictEqual(all.filter((id) => id === PARKED).length, 1);
});

t('parking is bounded', () => {
    const stored = defaultLayout(MOUSE);
    const many = Array.from({ length: 400 }, (_, i) => `x:ghost-${i}`);
    stored.docks.right.panels = [...many, ...stored.docks.right.panels];
    const l = reconcile(stored, MOUSE);
    const ghosts = l.docks.right.panels.filter((id) => id.startsWith('x:ghost-'));
    assert.ok(ghosts.length > 0, 'some are kept');
    assert.ok(ghosts.length <= 64, `kept ${ghosts.length}, want at most the cap`);
});

t('a registered panel is still placed and a parked one still renders as nothing', () => {
    // The guarantee the whole thing rests on: nothing downstream has to know
    // about parked ids, because every consumer filters on the registry first.
    const l = reconcile(storedWithParked(), MOUSE);
    for (const dock of DOCKS) {
        for (const id of l.docks[dock].panels) {
            assert.ok(PANEL_BY_ID[id] || id === PARKED, `unexpected id ${id}`);
        }
    }
    assert.ok(PANEL_BY_ID.receiver, 'the registry is what draws them');
    assert.strictEqual(PANEL_BY_ID[PARKED], undefined, 'and it does not know this one');
});

t('junk in a stored layout is still discarded', () => {
    // Parking is for ids, not for anything a hand-edited file might contain.
    const stored = defaultLayout(MOUSE);
    stored.docks.right.panels = [null, 42, '', ...stored.docks.right.panels];
    stored.weights['x:never-placed'] = 3;
    const l = reconcile(stored, MOUSE);
    for (const id of l.docks.right.panels) {
        assert.strictEqual(typeof id, 'string');
        assert.notStrictEqual(id, '');
    }
    assert.strictEqual(l.weights['x:never-placed'], undefined,
        'a weight for an id that is nowhere in the layout is not kept');
});

// ── The minimal flag on a phone ──────────────────────────────────────────────
//
// Older builds wrote `minimalMobile: false` for every panel that had no minimal
// view yet, so a panel that gained one afterwards came up whole on a phone while
// its neighbours came up cut down. See MINIMAL_LATECOMERS.

// A layout as one of those builds left it: the flag on every panel, and no
// record of the repair having run.
const storedPreRepair = (over = {}) => {
    const l = defaultLayout(PHONE);
    delete l.minimalRepaired;
    for (const s of Object.values(l.sections)) {
        s.minimal = !!s.minimal;
        s.minimalMobile = false;
    }
    return { ...l, ...over };
};

t('a panel that gained a minimal view opens cut down on a phone', () => {
    const l = reconcile(storedPreRepair(), PHONE);
    assert.strictEqual(l.sections.layout.minimalMobile, true);
    assert.strictEqual(l.minimalRepaired, true, 'and the layout records that it is done');
});

t('the repair does not run a second time', () => {
    const once = reconcile(storedPreRepair(), PHONE);
    once.sections.layout.minimalMobile = false;   // expanded by hand, afterwards
    assert.strictEqual(reconcile(once, PHONE).sections.layout.minimalMobile, false);
});

t('a panel that has always had one keeps the answer somebody gave', () => {
    // Not a latecomer, so its stored `false` is a choice rather than a flag
    // nobody set.
    const l = reconcile(storedPreRepair(), PHONE);
    assert.strictEqual(l.sections.chat.minimalMobile, false);
});

t('nothing is stored for a panel with no minimal view at all', () => {
    // The `false` that started all this is never written again, so absent stays
    // absent and the next panel to gain a minimal view needs no repair.
    assert.ok(!PANEL_BY_ID.display.minimal, 'the Display panel is one of those');
    for (const l of [defaultLayout(PHONE), reconcile(storedPreRepair(), PHONE)]) {
        assert.strictEqual(l.sections.display.minimalMobile, undefined);
        assert.strictEqual(l.sections.display.minimal, undefined);
        assert.ok(!('minimalMobile' in JSON.parse(JSON.stringify(l)).sections.display),
            'and it does not survive a round trip through localStorage');
    }
});

console.log(`\n${pass} ok`);
