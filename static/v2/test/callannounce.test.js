// The callsign announcer: when it goes, when it refuses to, and how long it says it
// will take.
//
// There is no AudioContext and no speechSynthesis in node, and that is the point — the
// announcer's decisions are all made before either is involved, and the Morse length it
// reports comes from the character table rather than from what got scheduled. What is
// below is therefore the real code path, not a stand-in for it. The one thing node
// cannot exercise is the speech branch, which needs a voice: `speak()` returns false
// without one, and the tests check that this is treated as "nothing was said" rather
// than as something that was.

const assert = require('assert');
const {
    CALL_CW, CALL_OFF, CALL_TTS, PHONETIC, announceCall, announcingCall,
    callAnnounceSettings, onCallAnnounce, phonetic, setCallAnnounce, stopCallAnnounce,
    _resetAnnounce,
} = require('./.build/callannounce.cjs');
const { unitMs, unitsFor } = require('./.build/morsecode.cjs');

let pass = 0;
const t = (name, fn) => {
    _resetAnnounce();
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- off unless asked ---------------------------------------------------------

t('off by default: a lookup makes no noise until somebody turns it on', () => {
    assert.strictEqual(callAnnounceSettings().mode, CALL_OFF);
    assert.strictEqual(announceCall('G0RDH'), 0);
    assert.strictEqual(announcingCall(), '');
});

t('on, it sends, and says how long for', () => {
    setCallAnnounce({ mode: CALL_CW, wpm: 20 });
    const ms = announceCall('M0ABC');
    // The PARIS definition, through unitsFor: not a number written out here, which
    // would only be this test agreeing with itself.
    assert.strictEqual(ms, unitsFor('M0ABC') * unitMs(20));
    assert.strictEqual(announcingCall(), 'M0ABC');
});

t('a blank or spaces is not a callsign', () => {
    setCallAnnounce({ mode: CALL_CW });
    assert.strictEqual(announceCall(''), 0);
    assert.strictEqual(announceCall('   '), 0);
    assert.strictEqual(announceCall(null), 0);
});

t('case and stray spaces do not make it a different call', () => {
    setCallAnnounce({ mode: CALL_CW });
    announceCall(' g0rdh ');
    assert.strictEqual(announcingCall(), 'G0RDH');
});

// --- one at a time -----------------------------------------------------------

t('the same call twice while it is still going out is one send', () => {
    // Both mounted copies of the panel answer the same lookup request. The second
    // must not restart the first, or the opening dit stutters.
    setCallAnnounce({ mode: CALL_CW, wpm: 12 });
    assert.ok(announceCall('GM4XYZ') > 0);
    assert.strictEqual(announceCall('GM4XYZ'), 0, 'the repeat is ignored');
});

t('a different call cuts in immediately', () => {
    // Two callsigns run together are one long meaningless string, and the one that
    // matters is the one just asked for.
    setCallAnnounce({ mode: CALL_CW });
    announceCall('G0RDH');
    assert.ok(announceCall('W1AW') > 0);
    assert.strictEqual(announcingCall(), 'W1AW');
});

t('the same call again once it has finished does send', () => {
    // Pressing the same spot twice is the only gesture there is for "once more".
    setCallAnnounce({ mode: CALL_CW });
    announceCall('EA1B');
    stopCallAnnounce();
    assert.ok(announceCall('EA1B') > 0);
});

t('stopping leaves nothing being sent', () => {
    setCallAnnounce({ mode: CALL_CW });
    announceCall('G0RDH');
    stopCallAnnounce();
    assert.strictEqual(announcingCall(), '');
});

t('turning it off stops what is in the air', () => {
    // A switch that let the last callsign finish itself reads as a switch that does
    // not work.
    setCallAnnounce({ mode: CALL_CW });
    announceCall('G0RDH');
    setCallAnnounce({ mode: CALL_OFF });
    assert.strictEqual(announcingCall(), '');
});

// --- the settings ------------------------------------------------------------

t('a patch changes one setting and leaves the others', () => {
    setCallAnnounce({ mode: CALL_CW, pitch: 800, wpm: 25, voice: 'Sonia', rate: 1.4 });
    setCallAnnounce({ wpm: 12 });
    assert.deepStrictEqual(callAnnounceSettings(), {
        mode: CALL_CW, pitch: 800, wpm: 12, voice: 'Sonia', rate: 1.4,
    });
});

t('a voice is whatever the browser called it, and blank means automatic', () => {
    // There is nothing to validate a name against: the list is the browser's and can
    // change under us — a machine without that voice installed falls back at speaking
    // time rather than having the choice refused here. See speak().
    setCallAnnounce({ voice: 'Google UK English Female' });
    assert.strictEqual(callAnnounceSettings().voice, 'Google UK English Female');
    setCallAnnounce({ voice: '' });
    assert.strictEqual(callAnnounceSettings().voice, '');
});

t('a speaking rate snaps to the nearest one offered', () => {
    // The Announcements panel's slider produces 1.3 quite legitimately; this picker
    // does not offer it, and the nearest speed is a better answer than a reset to 1×.
    setCallAnnounce({ rate: 1.3 });
    assert.ok([1.2, 1.4].includes(callAnnounceSettings().rate));
    setCallAnnounce({ rate: 99 });
    assert.strictEqual(callAnnounceSettings().rate, 1.8, 'clamped to the top of the range');
    setCallAnnounce({ rate: 0 });
    assert.strictEqual(callAnnounceSettings().rate, 0.6);
    setCallAnnounce({ rate: 'fast' });
    assert.strictEqual(callAnnounceSettings().rate, 1, 'nonsense is the default, not NaN');
});

t('a pitch or speed that is not on offer falls back rather than being used', () => {
    // The pickers cannot produce these; a stale saved value or a hand-edited key can.
    setCallAnnounce({ pitch: 1500, wpm: 60 });
    assert.strictEqual(callAnnounceSettings().pitch, 600);
    assert.strictEqual(callAnnounceSettings().wpm, 15);
});

t('every listener hears a change, and can stop hearing them', () => {
    const seen = [];
    const off = onCallAnnounce((s) => seen.push(s.mode));
    setCallAnnounce({ mode: CALL_CW });
    off();
    setCallAnnounce({ mode: CALL_OFF });
    assert.deepStrictEqual(seen, [CALL_CW]);
});

// --- one or the other --------------------------------------------------------

t('the mode is one of three, and anything else is off', () => {
    // Two booleans would have four states, one of them "Morse and speech at once",
    // which is worse than either.
    setCallAnnounce({ mode: 'both' });
    assert.strictEqual(callAnnounceSettings().mode, CALL_OFF);
    setCallAnnounce({ mode: CALL_TTS });
    assert.strictEqual(callAnnounceSettings().mode, CALL_TTS);
});

t('switching between the two stops what is in the air', () => {
    // Not just switching off: the Morse of the last callsign finishing underneath the
    // spoken version of it is nobody's intention.
    setCallAnnounce({ mode: CALL_CW });
    announceCall('G0RDH');
    setCallAnnounce({ mode: CALL_TTS });
    assert.strictEqual(announcingCall(), '');
});

t('speech with no voice available says nothing, and records nothing', () => {
    // node has no speechSynthesis, which is the same case as a browser whose voice
    // list is empty. Silence must not be remembered as an announcement, or the dedupe
    // would swallow the retry once a voice does turn up.
    setCallAnnounce({ mode: CALL_TTS });
    assert.strictEqual(announceCall('G0RDH'), 0);
    assert.strictEqual(announcingCall(), '');
});

// --- as it would be said on air ---------------------------------------------

t('a callsign is spoken in NATO phonetics', () => {
    assert.strictEqual(phonetic('G0RDH'), 'Golf Zero Romeo Delta Hotel');
});

t('a portable suffix is spoken as the stroke it is written with', () => {
    assert.strictEqual(phonetic('GM4ABC/P'), 'Golf Mike Four Alpha Bravo Charlie stroke Papa');
});

t('lower case is the same callsign', () => {
    assert.strictEqual(phonetic('w1aw'), phonetic('W1AW'));
});

t('anything with no spoken form is dropped rather than read out', () => {
    assert.strictEqual(phonetic('G0-RDH!'), 'Golf Zero Romeo Delta Hotel');
    assert.strictEqual(phonetic('!!'), '');
});

t('every letter and digit has a word, and they are all different', () => {
    // The table is written out by hand, and the mistake it invites is two letters
    // sharing a word — which would be a callsign that cannot be written down.
    const words = Object.values(PHONETIC);
    assert.strictEqual(new Set(words).size, words.length);
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
        assert.ok(PHONETIC[ch], `${ch} has no phonetic`);
    }
});

t('speed changes the length, and the table decides by how much', () => {
    setCallAnnounce({ mode: CALL_CW, wpm: 12 });
    const slow = announceCall('G0RDH');
    stopCallAnnounce();
    setCallAnnounce({ wpm: 25 });
    const fast = announceCall('G0RDH');
    assert.ok(slow > fast, 'faster is shorter');
    assert.strictEqual(slow / fast, 25 / 12, 'and exactly in proportion to the speed');
});

if (process.exitCode) console.log('\ncallsign announcer tests FAILED');
else console.log(`\nall ${pass} callsign announcer tests passed`);
