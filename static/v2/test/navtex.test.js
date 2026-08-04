// NAVTEX: framing a character stream into messages.
//
// The decoder underneath is the same SITOR-B one FSK uses and is covered by
// fsk.test.js. What is here is the part that is NAVTEX's own — turning a stream
// of characters into numbered messages — and it is worth testing because every
// way of getting it wrong is quiet. Swallow the terminator and two messages
// become one; mis-read the header and a gale warning is filed under someone
// else's station; miss a message with a corrupted header and the panel shows
// nothing while characters are visibly arriving.

const assert = require('assert');

const { appendText } = require('./.build/teleprinter.cjs');
const {
    MAX_MESSAGES, SUBJECTS, NAVTEX_CONFIG, NAVTEX_FREQUENCIES,
    parseMessages, subjectOf,
} = require('./.build/navtex.cjs');
const { tunedOption } = require('./.build/extfreq.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// The console the panel holds, built the way the panel builds it — one append
// per 100 ms flush — so the parser is tested against the shape it really sees.
const consoleOf = (...chunks) => chunks.reduce(
    (lines, c, i) => appendText(lines, c, 1785758415000 + i * 1000),
    [],
);

// --- framing ---------------------------------------------------------------

t('a message is its header, its body and its terminator', () => {
    const msgs = parseMessages(consoleOf('ZCZC IA47\nGALE WARNING\nAREA FORTIES\nNNNN\n'));
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].station, 'I');
    assert.strictEqual(msgs[0].subject, 'A');
    assert.strictEqual(msgs[0].serial, '47');
    assert.strictEqual(msgs[0].body, 'GALE WARNING\nAREA FORTIES');
    assert.strictEqual(msgs[0].complete, true);
});

t('the serial keeps both its digits', () => {
    // 00 is the serial for a message that is sent once and never repeated, and
    // a receiver may not reject it. Storing it as a number would lose that.
    const msgs = parseMessages(consoleOf('ZCZC ID00\nMAYDAY RELAY\nNNNN\n'));
    assert.strictEqual(msgs[0].serial, '00');
    assert.notStrictEqual(msgs[0].serial, 0);
});

t('back-to-back messages stay separate', () => {
    const msgs = parseMessages(consoleOf(
        'ZCZC IA47\nFIRST\nNNNN\n',
        'ZCZC IB48\nSECOND\nNNNN\n',
    ));
    assert.deepStrictEqual(msgs.map((m) => m.body), ['FIRST', 'SECOND']);
    assert.deepStrictEqual(msgs.map((m) => m.subject), ['A', 'B']);
    assert.ok(msgs.every((m) => m.complete));
});

t('a message assembles across the flushes it arrived in', () => {
    // The server flushes every 100 ms, so a header, a body and a terminator are
    // normally three or thirty separate chunks.
    const msgs = parseMessages(consoleOf('ZCZC ', 'IA', '47\nSTORM', ' WARNING\nNN', 'NN\n'));
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].body, 'STORM WARNING');
    assert.strictEqual(msgs[0].complete, true);
});

t('a lost terminator ends the message at the next one, not inside it', () => {
    // Swallowing the next header would file two messages under one serial and
    // attribute the second station's text to the first.
    const msgs = parseMessages(consoleOf('ZCZC IA47\nFIRST\n', 'ZCZC IB48\nSECOND\nNNNN\n'));
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].body, 'FIRST');
    assert.strictEqual(msgs[0].complete, false, 'the one with no NNNN is marked unterminated');
    assert.strictEqual(msgs[1].body, 'SECOND');
    assert.strictEqual(msgs[1].complete, true);
});

t('a message still being received is shown, unterminated', () => {
    // Waiting for NNNN would leave the panel blank for the whole of a long
    // transmission, which is exactly when you are watching it.
    const msgs = parseMessages(consoleOf('ZCZC IA47\nHALF A GALE'));
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].complete, false);
    assert.strictEqual(msgs[0].body, 'HALF A GALE');
});

t('a header the error correction could not recover yields no message', () => {
    // Not a message with a guessed header: attributing a warning to the wrong
    // station is worse than not claiming it. The raw console still has it.
    assert.deepStrictEqual(parseMessages(consoleOf('ZCZC I?47\nGARBLE\nNNNN\n')), []);
    assert.deepStrictEqual(parseMessages(consoleOf('ZCZC IA4X\nGARBLE\nNNNN\n')), []);
    assert.deepStrictEqual(parseMessages(consoleOf('RANDOM PHASING CHARACTERS\n')), []);
    assert.deepStrictEqual(parseMessages([]), []);
});

t('a header missing its space is still a header', () => {
    // The space is in the standard but the error correction can drop it, and
    // losing a whole message to one missing character would be a poor trade.
    assert.strictEqual(parseMessages(consoleOf('ZCZCIA47\nTEXT\nNNNN\n'))[0].serial, '47');
});

t('a message is timed by the line its header arrived on', () => {
    // Not by the line the panel happened to re-parse on: the time is when the
    // station sent it.
    const lines = consoleOf('PHASING\n', 'ZCZC IA47\n', 'BODY\nNNNN\n');
    const msgs = parseMessages(lines);
    assert.strictEqual(msgs[0].at, 1785758415000 + 1000);
});

t('ids are unique, so two messages cannot share a row', () => {
    const msgs = parseMessages(consoleOf(
        'ZCZC IA47\nONE\nNNNN\n',
        'ZCZC IA47\nTWO\nNNNN\n',   // a repeat, same header
    ));
    assert.strictEqual(msgs.length, 2);
    assert.notStrictEqual(msgs[0].id, msgs[1].id);
});

t('the message list is capped from the front, keeping the newest', () => {
    let lines = [];
    for (let i = 0; i < MAX_MESSAGES + 5; i++) {
        lines = appendText(lines, `ZCZC IA${String(i % 100).padStart(2, '0')}\nM${i}\nNNNN\n`, 1000 + i);
    }
    const msgs = parseMessages(lines);
    assert.strictEqual(msgs.length, MAX_MESSAGES);
    assert.strictEqual(msgs[msgs.length - 1].body, `M${MAX_MESSAGES + 4}`);
});

// --- subjects --------------------------------------------------------------

t('the subjects a receiver may not reject are marked', () => {
    // A, B, D and L. A panel that quietly filtered a search-and-rescue message
    // would be doing the one thing the standard forbids.
    assert.deepStrictEqual(
        Object.keys(SUBJECTS).filter((k) => SUBJECTS[k].vital).sort(),
        ['A', 'B', 'D', 'L'],
    );
    assert.strictEqual(subjectOf('D').label, 'Search and rescue');
    assert.strictEqual(subjectOf('z').label, 'No messages on hand');
});

t('a reserved subject letter is not given an invented meaning', () => {
    // M to U are reserved and undefined; the panel shows the letter instead.
    for (const letter of ['M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U']) {
        assert.strictEqual(subjectOf(letter), null, letter);
    }
    assert.strictEqual(subjectOf(''), null);
    assert.strictEqual(subjectOf(undefined), null);
});

// --- settings and stations -------------------------------------------------

t('the decoder settings are SITOR-B, which is what NAVTEX is', () => {
    assert.strictEqual(NAVTEX_CONFIG.framing, '4/7');
    assert.strictEqual(NAVTEX_CONFIG.encoding, 'CCIR476');
    assert.strictEqual(NAVTEX_CONFIG.baud_rate, 100);
    assert.strictEqual(NAVTEX_CONFIG.shift, 170);
    assert.strictEqual(NAVTEX_CONFIG.center_frequency, 500);
});

t('the station menu says which frequency the receiver is on', () => {
    // The entries are assigned frequencies and the dial sits an audio centre
    // below one — v1's tuneToStation arithmetic, run backwards.
    const centre = NAVTEX_CONFIG.center_frequency;
    const dial = 518000 - centre;
    assert.ok(tunedOption(NAVTEX_FREQUENCIES, dial + centre).label.includes('International'));
    assert.strictEqual(tunedOption(NAVTEX_FREQUENCIES, dial + 3000), null);
});

t('every station entry is reachable and distinct', () => {
    const all = NAVTEX_FREQUENCIES.flatMap((g) => g.options);
    assert.strictEqual(all.length, 17);
    for (const o of all) {
        // MIN_FREQ is 10 kHz; an entry below it would tune to the clamp and
        // then never match itself. 490 and 518 kHz are the low ones.
        assert.ok(o.hz >= 10000 && o.hz <= 30000000, o.label);
        assert.ok(o.label, `${o.hz} has no label`);
    }
    assert.strictEqual(new Set(all.map((o) => o.hz)).size, all.length);
    // The two 4.2 MHz assignments are 500 Hz apart and easy to conflate.
    const hz = all.map((o) => o.hz);
    assert.ok(hz.includes(4209500) && hz.includes(4210000));
});

console.log(`\n${pass} NAVTEX checks passed`);
