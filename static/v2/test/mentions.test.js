// Frequencies in chat, and which of them become links.
//
// The interesting half is that this is a property of the *receiver*, not of the
// software: the same message is a link on a 60 MHz front end and plain text on a
// 30 MHz one. v1 hardcoded 10 kHz–30 MHz and shipped a list of eight modes, and
// both outlived the assumption behind them.

const assert = require('assert');
const m = require('./.build/mentions.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// The one part of a split that this file is about.
const freqs = (msg) => m.splitMessage(msg, []).filter((p) => p.freq).map((p) => p.freq);
const plain = (msg) => m.splitMessage(msg, []).map((p) => p.text).join('');

// --- the default receiver, before /api/description lands -----------------------

t('a shared HF frequency is a link', () => {
    assert.deepStrictEqual(freqs('on 14175.000 KHz (USB) now'), [{ hz: 14175000, mode: 'usb' }]);
});

t('6 m is not, on a 30 MHz receiver', () => {
    assert.deepStrictEqual(freqs('try 50313.000 KHz (USB)'), []);
});

t('a rejected frequency stays in the text, whole', () => {
    // The run is left plain rather than dropped: the words are still what
    // somebody typed.
    assert.strictEqual(plain('try 50313.000 KHz (USB)'), 'try 50313.000 KHz (USB)');
});

t('every mode the receiver has is linkable', () => {
    for (const mode of ['usb', 'lsb', 'am', 'sam', 'fm', 'nfm', 'cwu', 'cwl', 'iq']) {
        assert.deepStrictEqual(
            freqs(`7100.000 KHz (${mode.toUpperCase()})`),
            [{ hz: 7100000, mode }],
            mode,
        );
    }
});

t('a mode the receiver does not have is not', () => {
    assert.deepStrictEqual(freqs('7100.000 KHz (DRM)'), []);
    assert.deepStrictEqual(freqs('7100.000 KHz (WFM)'), []);
});

t('below the bottom of the band is not', () => {
    assert.deepStrictEqual(freqs('9.000 KHz (AM)'), []);
    assert.deepStrictEqual(freqs('10.000 KHz (AM)'), [{ hz: 10000, mode: 'am' }]);
});

// --- the same messages, on a 129.6 Msps receiver -------------------------------

t('a wider receiver links what a narrow one would not', () => {
    m.applyTuningRange({ min_frequency: 10000, max_frequency: 60000000 });
    assert.strictEqual(m.MAX_FREQ, 60000000);
    assert.deepStrictEqual(freqs('try 50313.000 KHz (USB)'), [{ hz: 50313000, mode: 'usb' }]);
    // And still refuses what is past even that.
    assert.deepStrictEqual(freqs('144300.000 KHz (USB)'), []);
});

t('the edge is the receiver\'s own top, exactly', () => {
    assert.deepStrictEqual(freqs('60000.000 KHz (USB)'), [{ hz: 60000000, mode: 'usb' }]);
    assert.deepStrictEqual(freqs('60000.001 KHz (USB)'), []);
});

// --- the other parts still work ------------------------------------------------

t('a URL beats a frequency inside it', () => {
    const parts = m.splitMessage('see https://x.test/7100.000 KHz (USB)', []);
    assert.strictEqual(parts[1].url, 'https://x.test/7100.000');
});

t('mentions, links and frequencies come out in order', () => {
    const parts = m.splitMessage('@bob 7100.000 KHz (USB) https://x.test', ['bob']);
    assert.strictEqual(parts[0].mention, 'bob');
    assert.ok(parts.some((p) => p.freq && p.freq.hz === 7100000));
    assert.ok(parts.some((p) => p.url === 'https://x.test'));
});

console.log(`\n${pass} passed`);
