// Pacing the pan gesture.
//
// The failure this guards against is the silent one: a drag that ends a little
// short of where it was aimed, because the last pointermove fell inside the
// pacing gap and was never sent. That looks exactly like a lost command, which
// is the thing the pacing exists to prevent — so the trailing send is as much
// the point here as the throttle.

const assert = require('assert');
const { PAN_MS, newPanPace, panFlush, panStep } = require('./.build/panpacing.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('the first request of a gesture goes out at once', () => {
    // Pacing must not cost latency on a view that has been sitting still.
    const p = newPanPace();
    assert.strictEqual(panStep(p, 7100000, 1000), 7100000);
});

t('requests inside the gap are held, not queued', () => {
    const p = newPanPace();
    panStep(p, 7100000, 1000);
    assert.strictEqual(panStep(p, 7101000, 1000 + PAN_MS / 4), null);
    assert.strictEqual(panStep(p, 7102000, 1000 + PAN_MS / 2), null);
    // Only the newest survives: an intermediate position of a drag is of no
    // interest once the finger has moved past it.
    assert.strictEqual(p.pending, 7102000);
});

t('a request after the gap goes out', () => {
    const p = newPanPace();
    panStep(p, 7100000, 1000);
    assert.strictEqual(panStep(p, 7101000, 1000 + PAN_MS), 7101000);
});

t('a whole drag is capped at one request per gap', () => {
    // 120 pointer events over a second, the shape of a real drag on a fast
    // screen. Uncapped that is 120 commands to radiod for one channel, against
    // the 50 a second it will take with nothing else using the queue.
    const p = newPanPace();
    let sent = 0;
    for (let i = 0; i < 120; i++) {
        if (panStep(p, 7100000 + i * 500, i * (1000 / 120)) != null) sent++;
    }
    assert.ok(sent <= Math.ceil(1000 / PAN_MS) + 1, `${sent} requests for one second of dragging`);
    assert.ok(sent >= 2, 'the drag sent almost nothing');
});

t('the end of the gesture sends what was held', () => {
    const p = newPanPace();
    panStep(p, 7100000, 1000);
    panStep(p, 7105000, 1010);          // held
    assert.strictEqual(panFlush(p, 1020), 7105000);
});

t('the end of the gesture sends nothing when nothing was held', () => {
    // A gesture whose last move went out on its own must not be followed by a
    // duplicate: the server answers a request for the view it already has, and
    // a needless one is a needless command to radiod.
    const p = newPanPace();
    panStep(p, 7100000, 1000);
    assert.strictEqual(panFlush(p, 1100), null);
});

t('flushing twice does not send twice', () => {
    const p = newPanPace();
    panStep(p, 7100000, 1000);
    panStep(p, 7105000, 1010);
    assert.strictEqual(panFlush(p, 1020), 7105000);
    assert.strictEqual(panFlush(p, 1030), null);
});

t('the flushed value is where the drag ended', () => {
    // The whole gesture, paced: what reaches the server last must be the last
    // place the finger was, not the last place the throttle happened to let
    // through.
    const p = newPanPace();
    const sent = [];
    for (let i = 0; i < 50; i++) {
        const v = panStep(p, 7100000 + i * 100, i * 8);
        if (v != null) sent.push(v);
    }
    const trailing = panFlush(p, 50 * 8);
    if (trailing != null) sent.push(trailing);
    assert.strictEqual(sent[sent.length - 1], 7100000 + 49 * 100);
});

t('a repeated centre is not sent twice', () => {
    // A pointer that lands on the same pixel twice, and the moment a drag
    // reverses direction over one.
    const p = newPanPace();
    panStep(p, 7100000, 1000);
    assert.strictEqual(panStep(p, 7100000, 1000 + PAN_MS * 2), null);
    assert.strictEqual(panFlush(p, 1200), null);
});

t('a held request the drag returns from is dropped', () => {
    // Moved away and back inside one gap: the view is already where it belongs,
    // so the gesture ends with nothing to send.
    const p = newPanPace();
    panStep(p, 7100000, 1000);
    panStep(p, 7105000, 1005);
    panStep(p, 7100000, 1010);
    assert.strictEqual(panFlush(p, 1020), null);
});

t('each gesture starts unthrottled', () => {
    // A new press is a new record, so pressing and dragging again feels the
    // same the second time however soon it comes.
    const p1 = newPanPace();
    panStep(p1, 7100000, 1000);
    const p2 = newPanPace();
    assert.strictEqual(panStep(p2, 7200000, 1001), 7200000);
});

console.log(`\n${pass} passed`);
