// The NAVTEX addon panel.
//
// The addon keys its store by frequency *and* station *and* subject, so a busy 518 kHz
// comes back as half a dozen entries while the panel shows one. Most of what is below is
// that reduction and the choice on top of it — plus the trimming of the message
// framing, which is easy to get wrong in the direction of eating somebody's warning.

const assert = require('assert');
const nx = require('./.build/navtexaddon.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const NOW = Date.UTC(2026, 7, 6, 14, 30, 0);
const iso = (ms) => new Date(ms).toISOString();
const row = (over = {}) => ({
    freq: '518 kHz',
    station: 'E',
    subject: 'A',
    serial: 7,
    timestamp: iso(NOW - 3600000),
    snr_db: 11.4,
    text: 'ZCZC EA07\nNAVAREA I WARNING 123\nBUOY ADRIFT 51-30N 001-20E\nNNNN',
    ...over,
});

// --- is the addon there? -----------------------------------------------------

t('the addon is found in the list by name, whatever its case', () => {
    assert.strictEqual(nx.navtexAvailable({ addons: ['NAVTEX'] }), true);
    assert.strictEqual(nx.navtexAvailable({ addons: ['sstv', 'navtex'] }), true);
});

t('no addon, no panel', () => {
    assert.strictEqual(nx.navtexAvailable({ addons: ['sstv'] }), false);
    assert.strictEqual(nx.navtexAvailable(null), false);
    assert.strictEqual(nx.addonUrl(), '/addon/navtex/');
});

// --- one message ---------------------------------------------------------------

t('a message keeps its identity, its frequency and its age', () => {
    const m = nx.normaliseMessage(row());
    assert.strictEqual(m.id, 'EA07', 'B1B2B3B4, as an operator writes it');
    assert.strictEqual(m.freq, '518 kHz');
    assert.strictEqual(m.short, '518', 'the chip has no room for the unit');
    assert.strictEqual(m.at, NOW - 3600000);
    assert.strictEqual(m.snr, 11.4);
});

t('a serial under ten is padded, because that is how they are written', () => {
    assert.strictEqual(nx.normaliseMessage(row({ serial: 3 })).id, 'EA03');
});

t('a message with no serial still has an identity', () => {
    assert.strictEqual(nx.normaliseMessage(row({ serial: null })).id, 'EA');
});

t('a row with no text is not a message', () => {
    // The addon only publishes complete messages, but an empty one would be a card
    // with a header and nothing under it.
    assert.strictEqual(nx.normaliseMessage(row({ text: '   ' })), null);
    assert.strictEqual(nx.normaliseMessage(row({ freq: '' })), null);
    assert.strictEqual(nx.normaliseMessage(null), null);
});

t('a missing SNR is null, not zero', () => {
    assert.strictEqual(nx.normaliseMessage(row({ snr_db: null })).snr, null);
});

// --- one message per frequency -------------------------------------------------

t('several transmitters on one frequency come down to the newest of them', () => {
    // This is the reduction the panel exists on: the addon keys by station and subject
    // as well as frequency, and "the latest on 518" means the newest of that lot.
    const list = nx.latestPerFreq([
        row({ station: 'E', subject: 'A', timestamp: iso(NOW - 7200000) }),
        row({ station: 'S', subject: 'B', timestamp: iso(NOW - 600000), serial: 12 }),
        row({ station: 'E', subject: 'E', timestamp: iso(NOW - 3600000), serial: 9 }),
    ]);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'SB12');
});

t('each frequency keeps its own latest, newest frequency first', () => {
    const list = nx.latestPerFreq([
        row({ freq: '518 kHz', timestamp: iso(NOW - 7200000) }),
        row({ freq: '490 kHz', timestamp: iso(NOW - 300000), station: 'C', serial: 4 }),
    ]);
    assert.deepStrictEqual(list.map((m) => m.short), ['490', '518']);
});

t('nothing received is an empty list rather than a crash', () => {
    assert.deepStrictEqual(nx.latestPerFreq(null), []);
    assert.deepStrictEqual(nx.latestPerFreq([{}, null, 'x']), []);
});

// --- choosing what to show --------------------------------------------------------

t('the picker offers Latest and the frequencies actually being received', () => {
    // Built from the data, not from a list of NAVTEX frequencies: a receiver watching
    // one should not be offered a chip for the other.
    const list = nx.latestPerFreq([row({ freq: '518 kHz' })]);
    assert.deepStrictEqual(nx.pickOptions(list).map((o) => o.label), ['Latest', '518']);
});

t('a frequency that has been quiet all day is still offered', () => {
    // The addon has no endpoint for its configuration, so the logs are the only thing
    // that remembers a channel which has said nothing since the addon restarted.
    const list = nx.latestPerFreq([row({ freq: '518 kHz' })]);
    const opts = nx.pickOptions(list, ['490 kHz', '518 kHz']);
    assert.deepStrictEqual(opts.map((o) => o.label), ['Latest', '490', '518']);
});

t('a frequency in both sources is one chip, not two', () => {
    const list = nx.latestPerFreq([row({ freq: '518 kHz' })]);
    assert.strictEqual(nx.pickOptions(list, ['518 kHz']).length, 2);
});

t('the metrics payload is read for its frequencies and nothing else', () => {
    assert.deepStrictEqual(nx.metricsFreqs({ freqs: ['518 kHz', ' 490 kHz '] }), ['518 kHz', '490 kHz']);
    // Logging switched off answers with an empty object, which is not an error.
    assert.deepStrictEqual(nx.metricsFreqs({}), []);
    assert.deepStrictEqual(nx.metricsFreqs(null), []);
});

t('the chips are in frequency order, whatever order the messages arrived in', () => {
    // The newest-first ordering is right for choosing what to show and wrong for a
    // control somebody is aiming at: chips that reshuffle when a message lands are
    // chips you press by mistake.
    const list = nx.latestPerFreq([
        row({ freq: '518 kHz', timestamp: iso(NOW - 7200000) }),
        row({ freq: '490 kHz', timestamp: iso(NOW - 60000) }),
    ]);
    assert.deepStrictEqual(nx.pickOptions(list).map((o) => o.label), ['Latest', '490', '518']);
});

t('Latest is whichever frequency spoke most recently', () => {
    const list = nx.latestPerFreq([
        row({ freq: '518 kHz', timestamp: iso(NOW - 7200000) }),
        row({ freq: '490 kHz', timestamp: iso(NOW - 60000), station: 'C' }),
    ]);
    assert.strictEqual(nx.chosenMessage(list, nx.PICK_LATEST).short, '490');
    assert.strictEqual(nx.chosenMessage(list, null).short, '490', 'and it is the default');
});

t('a chosen frequency is shown even when the other one is newer', () => {
    const list = nx.latestPerFreq([
        row({ freq: '518 kHz', timestamp: iso(NOW - 7200000) }),
        row({ freq: '490 kHz', timestamp: iso(NOW - 60000), station: 'C' }),
    ]);
    assert.strictEqual(nx.chosenMessage(list, '518 kHz').short, '518');
});

t('a frequency that is not offered at all falls back to the newest', () => {
    // The addon reconfigured, or a choice saved against a different receiver: better
    // the newest anything than an empty panel about a frequency nothing knows about.
    const list = nx.latestPerFreq([row({ freq: '518 kHz' })]);
    assert.strictEqual(nx.chosenMessage(list, '490 kHz', ['518 kHz']).short, '518');
});

t('a chosen frequency with nothing on it yet shows nothing, not somebody else\'s message', () => {
    // The case the frequency list is passed in for. Falling back here would put a
    // 518 kHz warning under a chip reading 490, and a NAVTEX message without its own
    // frequency attached is not a NAVTEX message.
    const list = nx.latestPerFreq([row({ freq: '518 kHz' })]);
    assert.strictEqual(nx.chosenMessage(list, '490 kHz', ['490 kHz', '518 kHz']), null);
});

t('nothing at all is nothing to show', () => {
    assert.strictEqual(nx.chosenMessage([], '518 kHz'), null);
});

// --- the body -----------------------------------------------------------------------

t('the framing comes off, because the header already says it', () => {
    const body = nx.messageBody('ZCZC EA07\nBUOY ADRIFT 51-30N\nNNNN');
    assert.strictEqual(body, 'BUOY ADRIFT 51-30N');
});

t('a message caught mid-transmission keeps everything it has', () => {
    // No ZCZC means the decoder came in late, and the first line is the part that
    // survived — cutting it off would be throwing away the message to tidy it.
    assert.strictEqual(nx.messageBody('GALE WARNING\nSEA AREA DOGGER'), 'GALE WARNING\nSEA AREA DOGGER');
    assert.strictEqual(nx.messageBody('GALE WARNING\nNNNN'), 'GALE WARNING');
});

t('a body that only had framing in it is empty rather than mangled', () => {
    assert.strictEqual(nx.messageBody('ZCZC EA07\nNNNN'), '');
    assert.strictEqual(nx.messageBody(''), '');
    assert.strictEqual(nx.messageBody(null), '');
});

t('a line that merely starts with the letters is not a marker', () => {
    // "NNNN" ends a message; a message about a buoy at NNNN-something does not.
    assert.strictEqual(nx.messageBody('ZCZC EA07\nPOSITION NNNN IS WRONG\nNNNN'),
        'POSITION NNNN IS WRONG');
});

if (process.exitCode) console.log('\nNAVTEX addon tests FAILED');
else console.log(`\nall ${pass} NAVTEX addon tests passed`);
