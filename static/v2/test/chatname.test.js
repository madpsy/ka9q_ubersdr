// The suggested chat name.
//
// Worth testing because every interesting case is one nobody would look for by
// opening the panel: a room that already holds the name that came up, a name
// that differs only in case, and a room so full that the search has to give up.

const assert = require('assert');
const { suggestUsername } = require('./.build/chatname.cjs');
const { validateUsername } = require('./.build/dxcluster.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A generator that walks a list of values, so a "random" pick is a known one.
const feed = (...values) => {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
};

t('a name is userNNN, three digits, no leading zero', () => {
    for (const r of [0, 0.5, 0.999999]) {
        const name = suggestUsername([], () => r);
        assert.match(name, /^user[1-9][0-9][0-9]$/, name);
    }
});

t('whatever it suggests is a name the server would accept', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
        assert.strictEqual(validateUsername(suggestUsername([], () => r)), null);
    }
});

t('a name already in the room is skipped', () => {
    // First pick is user100, which is taken; the second is user101.
    const name = suggestUsername(['user100'], feed(0, 1 / 900));
    assert.strictEqual(name, 'user101');
});

t('taken is compared without case', () => {
    // Two names differing only in case are the same name to everyone reading
    // the log, whatever the server makes of them.
    const name = suggestUsername(['USER100'], feed(0, 1 / 900));
    assert.strictEqual(name, 'user101');
});

t('rubbish in the user list is ignored rather than thrown over', () => {
    // The list comes off a socket: nulls and non-strings are the server's
    // business, not a reason for the box to come up empty.
    const name = suggestUsername([null, undefined, 42, '', 'user100'], feed(0, 1 / 900));
    assert.strictEqual(name, 'user101');
});

t('a full room still gets a name', () => {
    const everyone = [];
    for (let n = 100; n <= 999; n++) everyone.push(`user${n}`);
    const name = suggestUsername(everyone, () => 0.5);
    assert.ok(name && name.startsWith('user'), name);
    // And it is still a name the server would take.
    assert.strictEqual(validateUsername(name), null);
});

console.log(`\n${pass} ok`);
