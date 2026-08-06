// Listing audio output devices — specifically, knowing when the browser has not
// really listed any.
//
// This is a browser-behaviour trap rather than a logic one, and it cost a working
// Refresh button on Chrome. Both engines withhold output devices until microphone
// permission is granted, and they withhold them in different shapes: Firefox
// returns none, Chrome returns one anonymous placeholder. A test written from one
// browser's shape passes while the other silently does nothing — which is exactly
// what happened, and why the shapes are written out here as fixtures.

const assert = require('assert');
const { namesHidden, sinkLabel } = require('./.build/audiosinks.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const out = (deviceId, label, groupId = 'g') => ({ kind: 'audiooutput', deviceId, label, groupId });

// What Chrome hands back before microphone permission: the spec's "at least one
// device of each kind the user has" placeholder, with everything blanked.
const CHROME_LOCKED = [out('', '', '')];

// Firefox simply omits them.
const FIREFOX_LOCKED = [];

// Chrome once permission is granted: the system alias, then the real devices.
const CHROME_GRANTED = [
    out('default', 'Default - Speakers (Realtek(R) Audio)'),
    out('a1b2c3', 'Speakers (Realtek(R) Audio)'),
    out('d4e5f6', 'Headphones (Sennheiser USB)'),
];

// Firefox once permission is granted: no 'default' alias of its own.
const FIREFOX_GRANTED = [out('a1b2c3', 'Speakers'), out('d4e5f6', 'Headset')];

t('Chrome before permission counts as hidden', () => {
    // The bug this file exists for. The placeholder has no deviceId, so a test
    // asking "are the real devices all unnamed" found no real devices, concluded
    // nothing was hidden, and never asked for the microphone: Refresh on Chrome
    // produced no prompt, no devices and no explanation.
    assert.strictEqual(namesHidden(CHROME_LOCKED), true);
});

t('Firefox before permission counts as hidden', () => {
    assert.strictEqual(namesHidden(FIREFOX_LOCKED), true);
});

t('a real named device means nothing is being withheld', () => {
    assert.strictEqual(namesHidden(CHROME_GRANTED), false);
    assert.strictEqual(namesHidden(FIREFOX_GRANTED), false);
});

t('the system aliases do not count as devices', () => {
    // 'default' and '' are the browser's own names for "wherever the system is
    // sending audio", which the panel offers as an option of its own. A list
    // containing only those says nothing about what is actually attached, so the
    // names are still hidden.
    assert.strictEqual(namesHidden([out('default', 'Default - Speakers')]), true);
    assert.strictEqual(namesHidden([out('', 'System Default')]), true);
    assert.strictEqual(namesHidden([out('default', 'Default'), out('', '')]), true);
});

t('an id with no name is not worth listing either', () => {
    // Some builds hand over ids while still withholding labels. "Output 3f9a2c…"
    // is not a thing anybody can choose between, so it still counts as hidden and
    // the panel still offers to unlock them.
    assert.strictEqual(namesHidden([out('a1b2c3', ''), out('d4e5f6', '')]), true);
});

t('rubbish in the list does not throw', () => {
    // enumerateDevices is browser-supplied and this runs on every devicechange.
    assert.strictEqual(namesHidden([]), true);
    assert.strictEqual(namesHidden([null, undefined]), true);
    assert.strictEqual(namesHidden([null, out('a1b2c3', 'Speakers')]), false);
});

t('a device with no name is labelled by its id, not left blank', () => {
    assert.strictEqual(sinkLabel(out('a1b2c3', 'Headset')), 'Headset');
    assert.strictEqual(sinkLabel(out('default', '')), 'System Default');
    assert.strictEqual(sinkLabel(out('', '')), 'System Default');
    assert.strictEqual(sinkLabel(out('3f9a2c1122', '')), 'Output 3f9a2c11…');
});

console.log(`\n${pass} ok`);
