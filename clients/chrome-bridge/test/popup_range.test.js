// The popup's frequency gate, tested against the file that ships.
//
// popup.js is a plain script for a DOM this harness does not have, so rather than mock a
// browser the two pure helpers are lifted out of the shipped source and run as-is. That
// keeps the test honest about *which* code it is checking: if the helpers are renamed or
// removed, the slice fails loudly rather than silently testing nothing.
//
// What matters here is the fallback contract. The gate decides, locally, whether a typed
// frequency is even sent — so when it is wrong the page never sees the command and cannot
// report anything. Getting "the receiver did not say" wrong therefore fails closed, and
// closed means 6 m is unreachable.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.js'), 'utf8');

const start = SRC.indexOf('function tuningLimitsKHz()');
const end = SRC.indexOf("btnSetFreq.addEventListener('click'");
assert.ok(start > 0, 'tuningLimitsKHz not found in popup.js');
assert.ok(end > start, 'could not find the end of the helper block');

const sandbox = { currentState: null };
vm.createContext(sandbox);
vm.runInContext(SRC.slice(start, end), sandbox);

let pass = 0;
const t = (name, fn) => {
    try {
        fn();
        console.log('ok    ' + name);
        pass++;
    } catch (err) {
        console.log('FAIL  ' + name);
        console.log('      ' + (err && err.message));
        process.exitCode = 1;
    }
};

// Spread into an object of *this* realm: the helper builds its result inside the vm
// context, and deepStrictEqual compares prototypes, so an identical-looking object from
// another realm would never match.
const limitsWith = (state) => {
    sandbox.currentState = state;
    return { ...sandbox.tuningLimitsKHz() };
};

const FALLBACK = { min: 10, max: 30000 };

// --- the fallback contract ---------------------------------------------------

t('no state at all is 10 kHz - 30 MHz', () => {
    assert.deepStrictEqual(limitsWith(null), FALLBACK);
});

t('a page that publishes no range is 10 kHz - 30 MHz', () => {
    assert.deepStrictEqual(limitsWith({ freq: 14074000, mode: 'usb' }), FALLBACK);
});

t('zero is not a limit', () => {
    assert.deepStrictEqual(limitsWith({ minFreq: 0, maxFreq: 0 }), FALLBACK);
});

t('null and undefined are not limits', () => {
    assert.deepStrictEqual(limitsWith({ minFreq: null, maxFreq: undefined }), FALLBACK);
});

t('a non-number is not a limit', () => {
    assert.deepStrictEqual(limitsWith({ minFreq: '10000', maxFreq: 'lots' }), FALLBACK);
});

t('an infinite edge is not a limit', () => {
    assert.deepStrictEqual(limitsWith({ minFreq: 10000, maxFreq: Infinity }), FALLBACK);
});

// --- each edge falls back on its own -----------------------------------------

t('a stated top with no bottom keeps the default bottom', () => {
    assert.deepStrictEqual(limitsWith({ maxFreq: 60000000 }), { min: 10, max: 60000 });
});

t('a stated bottom with no top keeps the default top', () => {
    assert.deepStrictEqual(limitsWith({ minFreq: 50000 }), { min: 50, max: 30000 });
});

// --- an inverted range is refused, not adopted -------------------------------

t('a max below the min is refused wholesale', () => {
    assert.deepStrictEqual(limitsWith({ minFreq: 60000000, maxFreq: 10000 }), FALLBACK);
});

t('a degenerate range is refused too', () => {
    assert.deepStrictEqual(limitsWith({ minFreq: 30000000, maxFreq: 30000000 }), FALLBACK);
});

// --- the receiver this whole change is for -----------------------------------

t('a 60 MHz receiver puts 6 m inside the gate', () => {
    const l = limitsWith({ minFreq: 10000, maxFreq: 60000000 });
    assert.deepStrictEqual(l, { min: 10, max: 60000 });
    // 50.313 MHz, the 6 m FT8 frequency, in kHz as the box takes it.
    const typed = 50313;
    assert.ok(typed >= l.min && typed <= l.max, '6 m FT8 is accepted');
});

t('and a 30 MHz receiver still refuses it, as it must', () => {
    const l = limitsWith({ minFreq: 10000, maxFreq: 30000000 });
    assert.ok(!(50313 <= l.max), '6 m is out of range on a 30 MHz receiver');
});

// --- the message the user reads ----------------------------------------------

t('the range is described in the units it belongs in', () => {
    assert.strictEqual(sandbox.describeKHz(10), '10 kHz');
    assert.strictEqual(sandbox.describeKHz(30000), '30 MHz');
    assert.strictEqual(sandbox.describeKHz(60000), '60 MHz');
    // No trailing zeroes on a round number, and no loss on a sharp one.
    assert.strictEqual(sandbox.describeKHz(50313), '50.313 MHz');
});

console.log(`\n${pass} ok`);
