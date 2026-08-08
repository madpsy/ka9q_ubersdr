// The DX cluster terminal: reading a spot out of cluster text.
//
// The transport is a WebSocket carrying a telnet session, so there is no
// structured spot to parse — a spot is a line that looks like one, and every
// rule for recognising it and deciding what mode to listen in comes from
// widgets/dxcluster.widget.html. These pin that behaviour, because the widget
// and this panel have to agree about where a click sends the receiver.

const assert = require('assert');
const {
    QUICK_COMMANDS, SCROLLBACK_LIMIT, modeFromSpot, parseSpotLine, spotCommand, trimLines,
} = require('./.build/dxterminal.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// The shape the cluster sends, from the widget's own comment.
const SSB = 'DX de N0CALL:      14205.0  R6AU           CQ DX             1701Z';
const CW = 'DX de W1AW-#:     14033.0  R6AU           13 dB  23 WPM  CQ   1701Z';
const FT8 = 'DX de W1AW-#:     14074.0  EA1ABC         FT8  -12 dB       1701Z';
const LOW = 'DX de N0CALL:       7150.0  GM4XYZ         LSB net           1701Z';

// --- what counts as a spot ---------------------------------------------------

t('a spot line is read for its frequency, callsign and comment', () => {
    const spot = parseSpotLine(SSB);
    assert.strictEqual(spot.hz, 14205000);
    assert.strictEqual(spot.callsign, 'R6AU');
    assert.strictEqual(spot.khz, '14205.0');
    assert.strictEqual(spot.utc, '1701');
    assert.strictEqual(spot.comment, 'CQ DX');
});

t('ordinary cluster output is not a spot', () => {
    // Everything else the server says has to stay unclickable.
    for (const line of [
        '',
        'Hello and welcome to the cluster',
        'M9PSY de GB7DXS 5-Aug-2026 1701Z >',
        'DX de N0CALL:      14205.0  R6AU           CQ DX',        // no time
        'WWV de VE7CC <18Z> : SFI=180, A=12, K=3',
        '> show/dx',
    ]) {
        assert.strictEqual(parseSpotLine(line), null, JSON.stringify(line));
    }
});

t('a trailing newline does not stop a line being a spot', () => {
    // Output arrives in arbitrary chunks and lines are split off with their
    // terminators still attached.
    assert.ok(parseSpotLine(`${SSB}\r\n`));
    assert.ok(parseSpotLine(`${SSB}\n`));
});

// --- which mode to listen in -------------------------------------------------

t('WPM in the comment means CW, and the sideband follows the 10 MHz split', () => {
    assert.strictEqual(parseSpotLine(CW).mode, 'cwu');
    assert.strictEqual(modeFromSpot(7030000, '13 dB  23 WPM  CQ'), 'cwl');
    assert.strictEqual(modeFromSpot(10000000, '23 WPM'), 'cwu', 'the boundary itself is upper');
});

t('a skimmer spot is CW even though it also reports dB', () => {
    // The order of the tests matters: a CW skimmer spot carries WPM *and* a dB
    // figure, so checking for a digital decode first would refuse every one.
    assert.strictEqual(parseSpotLine(CW).mode, 'cwu');
});

t('a comment beginning USB or LSB is taken at its word', () => {
    assert.strictEqual(parseSpotLine(LOW).mode, 'lsb');
    assert.strictEqual(modeFromSpot(14200000, 'USB net'), 'usb');
    assert.strictEqual(modeFromSpot(7150000, 'lsb net'), 'lsb', 'case insensitive');
    // Only at the start: "CQ USB" is a comment about a mode, not a mode.
    assert.strictEqual(modeFromSpot(7150000, 'CQ USB'), 'lsb');
});

t('a digital decode is not tuneable at all', () => {
    // There is nothing to listen to, so the line stays unclickable rather than
    // tuning you to a carrier.
    assert.strictEqual(parseSpotLine(FT8), null);
    assert.strictEqual(modeFromSpot(14074000, 'FT8  -12 dB'), '');
    assert.strictEqual(modeFromSpot(14074000, 'JS8 -7 dB'), '');
});

t('anything else falls back to the band plan', () => {
    assert.strictEqual(modeFromSpot(14205000, 'CQ DX'), 'usb');
    assert.strictEqual(modeFromSpot(3760000, 'net'), 'lsb');
    assert.strictEqual(modeFromSpot(10000000, ''), 'usb');
    assert.strictEqual(modeFromSpot(9999999, ''), 'lsb');
});

t('every mode a spot can produce is one the receiver has', () => {
    const modes = new Set();
    for (const hz of [3700000, 14200000]) {
        for (const comment of ['23 WPM', 'USB net', 'LSB net', 'CQ DX']) {
            modes.add(modeFromSpot(hz, comment));
        }
    }
    for (const m of modes) assert.ok(['usb', 'lsb', 'cwu', 'cwl'].includes(m), m);
});

// --- the transcript ----------------------------------------------------------

t('the transcript is trimmed from the front, in whole lines', () => {
    const text = Array.from({ length: 2600 }, (_, i) => `line ${i}`).join('\n');
    const kept = trimLines(text);
    const lines = kept.split('\n');
    assert.strictEqual(lines.length, SCROLLBACK_LIMIT);
    assert.strictEqual(lines[lines.length - 1], 'line 2599', 'kept the wrong end');
    assert.strictEqual(lines[0], 'line 600');
});

t('a short transcript is left exactly as it is', () => {
    assert.strictEqual(trimLines('one\ntwo'), 'one\ntwo');
    assert.strictEqual(trimLines(''), '');
});

// --- the commands ------------------------------------------------------------

t('the quick commands are the widget\'s, and each does one thing', () => {
    assert.deepStrictEqual(
        QUICK_COMMANDS.map((q) => q.label),
        ['sh/dx', 'last 10', 'filters', 'status', 'time', 'upstream', 'qrz', 'check call', 'help'],
    );
    for (const q of QUICK_COMMANDS) {
        assert.ok(!!q.cmd !== !!q.prompt, `${q.label} must either send or prompt, not both`);
    }
});

// --- submitting a spot ------------------------------------------------------
//
// The receiver works in Hz and the cluster wants kHz, which is the kind of unit
// boundary that produces a spot three decimal places out and nobody noticing.

t('a spot is DX, the frequency in kHz, then the callsign', () => {
    assert.strictEqual(spotCommand({ hz: 14074000, callsign: 'MM3NDH' }), 'DX 14074.0 MM3NDH');
});

t('the callsign is uppercased and trimmed, as the cluster would anyway', () => {
    assert.strictEqual(spotCommand({ hz: 7100000, callsign: '  mm3ndh ' }), 'DX 7100.0 MM3NDH');
});

t('a comment goes on the end when there is one, and nothing when there is not', () => {
    assert.strictEqual(
        spotCommand({ hz: 14074000, callsign: 'MM3NDH', comment: 'FT8 -12 dB' }),
        'DX 14074.0 MM3NDH FT8 -12 dB',
    );
    // No trailing space: the far end splits on whitespace, but a command that ends
    // in one is a command that reads as though something was dropped.
    assert.strictEqual(spotCommand({ hz: 14074000, callsign: 'MM3NDH', comment: '   ' }), 'DX 14074.0 MM3NDH');
});

t('a newline in the comment cannot become a second command', () => {
    assert.strictEqual(
        spotCommand({ hz: 14074000, callsign: 'MM3NDH', comment: 'nice\r\nBYE' }),
        'DX 14074.0 MM3NDH nice BYE',
    );
});

t('the dial is rounded to 100 Hz, which is as fine as a spot means anything', () => {
    assert.strictEqual(spotCommand({ hz: 14074123, callsign: 'MM3NDH' }), 'DX 14074.1 MM3NDH');
    assert.strictEqual(spotCommand({ hz: 3573000, callsign: 'MM3NDH' }), 'DX 3573.0 MM3NDH');
});

t('nothing sendable gives no command rather than a malformed one', () => {
    assert.strictEqual(spotCommand({ hz: 14074000, callsign: '' }), '');
    assert.strictEqual(spotCommand({ hz: 0, callsign: 'MM3NDH' }), '');
    assert.strictEqual(spotCommand({ hz: NaN, callsign: 'MM3NDH' }), '');
});

console.log(`\n${pass} ok`);
