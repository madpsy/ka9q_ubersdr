// The top bar's clock, and the three states it cycles through.
//
// Small, but it is a control somebody will press by accident and then want back where it
// was, so the cycle has to be predictable and the stored value has to be trustworthy.

const assert = require('assert');
const tc = require('./.build/topclock.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('both clocks is the default, and what anything unrecognised comes to', () => {
    // The pair is the behaviour the bar has always had, so it is what a receiver with
    // nothing stored — or something odd stored — shows.
    assert.strictEqual(tc.CLOCK_MODES[0], 'both');
    for (const v of [undefined, null, '', 'zulu', 3, {}]) {
        assert.strictEqual(tc.clockMode(v), 'both', String(v));
    }
});

t('the cycle is both, UTC, local, and round again', () => {
    // UTC before local: it is what somebody reaching for one clock on a radio usually
    // wants, and putting it last would mean two clicks to reach the obvious answer.
    assert.strictEqual(tc.nextClockMode('both'), 'utc');
    assert.strictEqual(tc.nextClockMode('utc'), 'local');
    assert.strictEqual(tc.nextClockMode('local'), 'both');
});

t('three clicks come back to where they started', () => {
    let m = 'both';
    for (let i = 0; i < 3; i++) m = tc.nextClockMode(m);
    assert.strictEqual(m, 'both');
});

t('a cycle from nonsense still lands somewhere sensible', () => {
    assert.strictEqual(tc.nextClockMode('nonsense'), 'utc');
    assert.strictEqual(tc.nextClockMode(undefined), 'utc');
});

t('the tooltip says what the next click does, not what is on screen', () => {
    // The clock already shows what it is showing; what it cannot show is that it is a
    // control at all, which is the tooltip's job.
    assert.ok(/UTC only/.test(tc.clockHint('both')));
    assert.ok(/local time only/.test(tc.clockHint('utc')));
    assert.ok(/both/.test(tc.clockHint('local')));
});

t('every mode has a hint, including one that should not exist', () => {
    for (const m of [...tc.CLOCK_MODES, 'rubbish']) {
        assert.ok(tc.clockHint(m).length > 0, m);
    }
});

t('the receiver zone is a second line, not tacked onto the first', () => {
    // Two questions, two lines: what a click does, and whose clock this is.
    const hint = tc.clockHint('utc', 'Europe/London');
    const lines = hint.split('\n');
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0], tc.clockHint('utc'));
    assert.ok(/Europe\/London/.test(lines[1]), lines[1]);
    // Named as the receiver's, because the local clock here is its wall clock
    // and not the browser's — which is the whole reason for printing it.
    assert.ok(/receiver/i.test(lines[1]), lines[1]);
});

t('every mode carries the zone', () => {
    for (const m of [...tc.CLOCK_MODES, 'rubbish']) {
        assert.ok(tc.clockHint(m, 'Pacific/Auckland').endsWith('Pacific/Auckland'), m);
    }
});

t('no zone means no second line, rather than an empty one', () => {
    // A server from before the name was published, or an operator who left it
    // unset. Guessing the browser's zone here would be a wrong answer that looks
    // right, since that is exactly when the clock falls back to browser time.
    for (const z of [undefined, null, '', '   ', 42, {}]) {
        assert.strictEqual(tc.clockHint('both', z), tc.clockHint('both'), String(z));
        assert.ok(!tc.clockHint('both', z).includes('\n'), String(z));
    }
});

if (process.exitCode) console.log('\ntop clock tests FAILED');
else console.log(`\nall ${pass} top clock tests passed`);
