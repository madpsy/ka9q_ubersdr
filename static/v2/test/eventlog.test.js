// The event log store.
//
// Small, but it has the two things a log always gets wrong: keys that collide
// when two lines land in the same millisecond, and a repeated line drowning
// everything else. Both are only visible at speed, which is exactly when a log
// is being read — a reconnect loop is the case it exists for.

const assert = require('assert');
const el = require('./.build/eventlog.cjs');

let pass = 0;
const t = (name, fn) => {
    el._resetEventLog();
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('a line is recorded with its level and a time', () => {
    el.logEvent('warn', 'Spectrum closed (1006)');
    const [e] = el.eventLog();
    assert.strictEqual(e.level, 'warn');
    assert.strictEqual(e.text, 'Spectrum closed (1006)');
    assert.ok(e.at instanceof Date);
});

t('empty text is not a line', () => {
    el.logEvent('info', '');
    el.logEvent('info', null);
    el.logEvent('info', undefined);
    assert.strictEqual(el.eventLog().length, 0);
});

t('ids are unique even within one millisecond', () => {
    // The original used Date.now() + Math.random() as a React key. Two lines in
    // the same tick is the normal case here — a socket closing logs a close and
    // a reconnect together — and a duplicate key silently drops a row.
    for (let i = 0; i < 500; i++) el.logEvent('info', `line ${i}`);
    const ids = el.eventLog().map((e) => e.id);
    assert.strictEqual(new Set(ids).size, ids.length);
});

t('the list is a ring of LOG_CAP, keeping the newest', () => {
    assert.strictEqual(el.LOG_CAP, 100);
    for (let i = 0; i < el.LOG_CAP + 60; i++) el.logEvent('info', `line ${i}`);
    const held = el.eventLog();
    assert.strictEqual(held.length, el.LOG_CAP);
    assert.strictEqual(held[held.length - 1].text, `line ${el.LOG_CAP + 59}`, 'newest kept');
    assert.strictEqual(held[0].text, 'line 60', 'oldest dropped');
});

t('an immediate repeat is counted, not repeated', () => {
    // A component remounting in a loop can emit the same line many times a
    // second, and a log that is 90% one sentence hides the thing being looked for.
    el.logEvent('warn', 'Band spectrum lost');
    el.logEvent('warn', 'Band spectrum lost');
    el.logEvent('warn', 'Band spectrum lost');
    const held = el.eventLog();
    assert.strictEqual(held.length, 1);
    assert.strictEqual(held[0].repeats, 3);
});

t('a repeat is a new object, so subscribers notice it', () => {
    // The count changes in place otherwise, and a subscriber comparing by
    // identity — which is what React does — renders the old number for ever.
    const seen = [];
    el.onEventLog((list) => seen.push(list));
    el.logEvent('warn', 'same');
    el.logEvent('warn', 'same');
    assert.strictEqual(seen.length, 2);
    assert.notStrictEqual(seen[0], seen[1], 'a new list');
    assert.notStrictEqual(seen[0][0], seen[1][0], 'and a new entry');
});

t('different text, or a different level, is a different line', () => {
    el.logEvent('warn', 'a');
    el.logEvent('warn', 'b');
    el.logEvent('error', 'b');
    assert.strictEqual(el.eventLog().length, 3);
});

t('only an immediate repeat collapses', () => {
    el.logEvent('warn', 'a');
    el.logEvent('warn', 'b');
    el.logEvent('warn', 'a');
    // Not adjacent, so the third stands on its own — a retry that came back a
    // minute later is news, not a repetition.
    assert.strictEqual(el.eventLog().length, 3);
});

t('subscribers hear changes and can stop hearing them', () => {
    let heard = 0;
    const off = el.onEventLog(() => { heard += 1; });
    el.logEvent('info', 'one');
    off();
    el.logEvent('info', 'two');
    assert.strictEqual(heard, 1);
});

t('a subscriber that throws does not take the others down', () => {
    let heard = 0;
    el.onEventLog(() => { throw new Error('bad subscriber'); });
    el.onEventLog(() => { heard += 1; });
    el.logEvent('info', 'one');
    assert.strictEqual(heard, 1);
});

t('clearing empties it, and says so once', () => {
    el.logEvent('info', 'one');
    let heard = 0;
    el.onEventLog(() => { heard += 1; });
    el.clearEventLog();
    assert.strictEqual(el.eventLog().length, 0);
    assert.strictEqual(heard, 1);
    el.clearEventLog();
    assert.strictEqual(heard, 1, 'clearing an empty log is not a change');
});

if (!process.exitCode) console.log(`\n${pass} passed`);
