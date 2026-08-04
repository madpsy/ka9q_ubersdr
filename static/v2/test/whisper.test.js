// Speech-to-text: the wire frames, the transcript, and reading it aloud.
//
// Three families of quiet mistake live here, and none of them raises anything:
//
//   * The envelope. Every frame is [type][timestamp:8][length:4][payload], and
//     an off-by-one on that header decodes plausible-looking garbage — a JSON
//     parse that fails is silent by design, so a transcript that has simply
//     stopped appearing is all you see.
//   * The provisional last segment. Get its handling wrong and you get either
//     the same sentence twice (once settled, once as the live line it became)
//     or a live line that never clears.
//   * The speech buffering. Overlap removal and sentence extraction are what
//     stand between "reads the transcript" and "repeats half of every sentence,
//     with a pause in the middle of each clause". Wrong terminator set and a
//     non-Latin transcript never flushes and is never spoken at all.

const assert = require('assert');

const {
    EMPTY, FRAME_ERROR, FRAME_LANGUAGE, FRAME_SEGMENTS, FRAME_SUMMARY, MAX_SEGMENTS,
    allSegments, applySegments, boldParts, decodeFrame, formatSince, saveFilename,
    toText, visibleSegments,
} = require('./.build/whisper.cjs');
const {
    FLUSH_AT, bufferSpeech, extractSentences, preferredVoice, removeOverlap,
    voiceForLanguage, voiceGroups,
} = require('./.build/whisperspeech.cjs');
const { languageName, LANGUAGE_MENU } = require('./.build/whisperlang.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A frame exactly as audio_extensions/whisper/decoder.go writes one:
// [type:1][unix_nanoseconds:8][length:4][payload].
function frame(type, payload) {
    const body = Buffer.from(payload, 'utf8');
    const buf = Buffer.alloc(13 + body.length);
    buf[0] = type;
    buf.writeBigUInt64BE(1785758415123456789n, 1);
    buf.writeUInt32BE(body.length, 9);
    body.copy(buf, 13);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const seg = (text, start, completed) => ({ text, start, end: start + 2, completed });

// --- the envelope ----------------------------------------------------------

t('a segments frame carries its JSON array', () => {
    const f = decodeFrame(frame(FRAME_SEGMENTS, JSON.stringify([seg('this is g4abc', 3, true)])));
    assert.strictEqual(f.kind, 'segments');
    assert.strictEqual(f.segments.length, 1);
    assert.strictEqual(f.segments[0].text, 'this is g4abc');
});

t('a language frame carries the code and the confidence', () => {
    const f = decodeFrame(frame(FRAME_LANGUAGE, '{"language":"de","language_prob":0.87}'));
    assert.deepStrictEqual(f, { kind: 'language', code: 'de', prob: 0.87 });
});

t('an error frame is plain text, not JSON', () => {
    // The one payload that is not JSON. Parsing it as JSON would drop every
    // error message the server sends, which is the only way it can say the
    // upstream transcriber is unreachable.
    const f = decodeFrame(frame(FRAME_ERROR, 'Connection failed: dial tcp: refused'));
    assert.strictEqual(f.kind, 'error');
    assert.strictEqual(f.error, 'Connection failed: dial tcp: refused');
});

t('a summary frame carries the text and how much of it was used', () => {
    const f = decodeFrame(frame(FRAME_SUMMARY, JSON.stringify({
        summary: 'A net on 40m.', segments_used: 12, segments_requested: 30, target_language: 'en',
    })));
    assert.deepStrictEqual(f, {
        kind: 'summary', text: 'A net on 40m.', used: 12, requested: 30, language: 'en',
    });
});

t('a truncated frame is dropped rather than half-read', () => {
    const full = Buffer.from(frame(FRAME_SEGMENTS, JSON.stringify([seg('hello', 0, true)])));
    // A length field promising more than the frame holds: the bytes after it
    // are not ours to decode.
    assert.strictEqual(decodeFrame(full.buffer.slice(0, 20)), null);
    assert.strictEqual(decodeFrame(Buffer.alloc(4).buffer), null);
});

t('an unparseable payload is dropped, not thrown on', () => {
    assert.strictEqual(decodeFrame(frame(FRAME_SEGMENTS, 'not json')), null);
    // A JSON object where an array is expected: not a segments frame.
    assert.strictEqual(decodeFrame(frame(FRAME_SEGMENTS, '{"text":"x"}')), null);
    assert.strictEqual(decodeFrame(frame(FRAME_LANGUAGE, 'nope')), null);
    assert.strictEqual(decodeFrame(0x02), null);
});

t('an unknown frame type is ignored', () => {
    assert.strictEqual(decodeFrame(frame(0x7f, '{}')), null);
});

// --- the transcript --------------------------------------------------------

const BASE = 1785758415000;

t('a settled segment joins the transcript and is announced', () => {
    const { state, settled } = applySegments(EMPTY, [seg('good evening', 4, true)], BASE);
    assert.strictEqual(state.done.length, 1);
    assert.strictEqual(state.live, null);
    // `settled` is what gets read aloud, so it must hold the new lines only.
    assert.deepStrictEqual(settled.map((s) => s.text), ['good evening']);
});

t('the live segment is rewritten in place, not appended', () => {
    let s = applySegments(EMPTY, [seg('good', 4, false)], BASE).state;
    s = applySegments(s, [seg('good eve', 4, false)], BASE).state;
    s = applySegments(s, [seg('good evening all', 4, false)], BASE).state;
    assert.strictEqual(s.done.length, 0);
    assert.strictEqual(s.live.text, 'good evening all');
    // One element, so React keeps the same node and the text simply changes.
    assert.strictEqual(allSegments(s).length, 1);
});

t('nothing provisional is ever spoken', () => {
    const { settled } = applySegments(EMPTY, [seg('good eve', 4, false)], BASE);
    assert.deepStrictEqual(settled, []);
});

t('a settled line clears the live line it became', () => {
    // This is v1's duplicated last line: it kept the provisional segment on
    // screen after the same words arrived settled, so the sentence appeared
    // twice — once as history and once as if still being spoken.
    let s = applySegments(EMPTY, [seg('good evening', 4, false)], BASE).state;
    s = applySegments(s, [seg('good evening all', 4, true)], BASE).state;
    assert.strictEqual(s.live, null);
    assert.deepStrictEqual(allSegments(s).map((x) => x.text), ['good evening all']);
});

t('a batch of settled plus provisional keeps both', () => {
    // The usual shape on the wire: WhisperLive runs with send_last_n_segments=1,
    // so a batch is the segment that has just settled and the one still running.
    const { state, settled } = applySegments(
        EMPTY,
        [seg('this is g4abc', 4, true), seg('calling', 7, false)],
        BASE,
    );
    assert.deepStrictEqual(state.done.map((s) => s.text), ['this is g4abc']);
    assert.strictEqual(state.live.text, 'calling');
    assert.deepStrictEqual(settled.map((s) => s.text), ['this is g4abc']);
});

t('an empty segment is not a line', () => {
    // The server's text filter can empty a segment out entirely; a blank line
    // in the transcript is worse than no line.
    const { state } = applySegments(EMPTY, [seg('   ', 4, true), seg('', 6, false)], BASE);
    assert.strictEqual(state.done.length, 0);
    assert.strictEqual(state.live, null);
});

t('a line is stamped with when it was spoken, not when it arrived', () => {
    // `start` is seconds into the stream and the stream restarts on every
    // re-attach, so resolving it once against the base in force at the time is
    // what stops old lines jumping when the clock restarts underneath them.
    const { state } = applySegments(EMPTY, [seg('hello', 12.5, true)], BASE);
    assert.strictEqual(state.done[0].at, BASE + 12500);
    // WhisperLive sometimes sends the times as strings.
    const asText = applySegments(EMPTY, [{ text: 'hello', start: '12.5', end: '14', completed: true }], BASE);
    assert.strictEqual(asText.state.done[0].at, BASE + 12500);
});

t('ids are unique and the live line keeps one of its own', () => {
    let s = EMPTY;
    for (let i = 0; i < 5; i++) s = applySegments(s, [seg(`line ${i}`, i, true)], BASE).state;
    s = applySegments(s, [seg('running', 6, false)], BASE).state;
    const ids = allSegments(s).map((x) => x.id);
    assert.strictEqual(new Set(ids).size, ids.length);
});

t('the transcript is capped rather than growing without bound', () => {
    let s = EMPTY;
    // In batches, as they really arrive.
    for (let i = 0; i < MAX_SEGMENTS + 200; i += 100) {
        const batch = [];
        for (let j = 0; j < 100; j++) batch.push(seg(`line ${i + j}`, i + j, true));
        s = applySegments(s, batch, BASE).state;
    }
    assert.strictEqual(s.done.length, MAX_SEGMENTS);
    // The oldest go, not the newest.
    assert.strictEqual(s.done[s.done.length - 1].text, `line ${MAX_SEGMENTS + 199}`);
});

t('an empty batch changes nothing at all', () => {
    const { state, settled } = applySegments(EMPTY, [], BASE);
    assert.strictEqual(state, EMPTY);
    assert.deepStrictEqual(settled, []);
});

// --- what is drawn ---------------------------------------------------------

function transcript(n, withLive) {
    let s = EMPTY;
    for (let i = 0; i < n; i++) s = applySegments(s, [seg(`line ${i}`, i, true)], BASE).state;
    if (withLive) s = applySegments(s, [seg('running', n, false)], BASE).state;
    return s;
}

t('the line limit trims the oldest, and 0 means all of them', () => {
    const s = transcript(30, false);
    assert.strictEqual(visibleSegments(s, 'all', 10).length, 10);
    assert.strictEqual(visibleSegments(s, 'all', 10)[0].text, 'line 20');
    assert.strictEqual(visibleSegments(s, 'all', 0).length, 30);
});

t('the limit counts settled lines, so the live one is never trimmed away', () => {
    const s = transcript(30, true);
    const rows = visibleSegments(s, 'all', 10);
    assert.strictEqual(rows.length, 11);
    assert.strictEqual(rows[rows.length - 1].text, 'running');
});

t('the three views show what they say', () => {
    const s = transcript(3, true);
    assert.deepStrictEqual(visibleSegments(s, 'live', 10).map((x) => x.text), ['running']);
    assert.deepStrictEqual(visibleSegments(s, 'done', 10).map((x) => x.text), ['line 0', 'line 1', 'line 2']);
    assert.strictEqual(visibleSegments(s, 'all', 10).length, 4);
});

t('the live view is empty when nothing is being decoded', () => {
    assert.deepStrictEqual(visibleSegments(transcript(3, false), 'live', 10), []);
});

// --- export ----------------------------------------------------------------

t('the export is one line per segment, with the times if they are shown', () => {
    const s = transcript(2, true);
    assert.strictEqual(toText(allSegments(s), false), 'line 0\nline 1\nrunning');
    const stamped = toText(allSegments(s), true).split('\n');
    assert.ok(/^\[\d\d:\d\d:\d\d\] line 0$/.test(stamped[0]), stamped[0]);
});

t('the filename says who, where, in what mode and over what span', () => {
    const name = saveFilename({
        callsign: 'M9PSY', frequency: 7078500, mode: 'usb',
        from: Date.UTC(2026, 7, 4, 10, 15, 30), to: Date.UTC(2026, 7, 4, 10, 47, 5),
    });
    assert.strictEqual(name, 'M9PSY_7.079MHz_USB_2026-08-04T10-15-30_to_2026-08-04T10-47-05.txt');
    // Nothing in it may be a character a filesystem refuses.
    assert.ok(!/[:*?"<>|]/.test(name), name);
});

t('a receiver with no callsign still produces a filename', () => {
    const name = saveFilename({ callsign: '', frequency: 0, mode: '', from: NaN, to: NaN });
    assert.ok(name.startsWith('UNKNOWN_0.000MHz_USB_'), name);
    assert.ok(name.endsWith('.txt'));
});

t('the last-heard readout counts in seconds, then minutes', () => {
    assert.strictEqual(formatSince(0), '0s');
    assert.strictEqual(formatSince(45000), '45s');
    assert.strictEqual(formatSince(65000), '1m05s');
    assert.strictEqual(formatSince(3600000), '60m00s');
    // A clock that has gone backwards is not a negative age.
    assert.strictEqual(formatSince(-5000), '0s');
});

t('the summary keeps its bold runs and nothing else', () => {
    assert.deepStrictEqual(boldParts('a **b** c'), [
        { text: 'a ', bold: false },
        { text: 'b', bold: true },
        { text: ' c', bold: false },
    ]);
    // No markers is one plain run; an unclosed marker is not bold.
    assert.deepStrictEqual(boldParts('plain'), [{ text: 'plain', bold: false }]);
    assert.deepStrictEqual(boldParts('**open'), [{ text: '**open', bold: false }]);
    assert.deepStrictEqual(boldParts(''), []);
});

// --- reading it aloud ------------------------------------------------------

t('a repeated word at a segment boundary is said once', () => {
    // The decoder re-decodes the tail of its buffer, so a settled segment often
    // starts with the end of the one before it: "…has been / has been detained".
    assert.strictEqual(removeOverlap('the station has been', 'has been detained'), 'detained');
    assert.strictEqual(removeOverlap('good evening', 'evening all'), 'all');
    assert.strictEqual(removeOverlap('one two three', 'one two three four'), 'four');
});

t('overlap matching ignores case and stops at three words', () => {
    assert.strictEqual(removeOverlap('This Is', 'this is g4abc'), 'g4abc');
    assert.strictEqual(removeOverlap('one two three four', 'two three four five'), 'five');
    // Four words of repeat is past the window, and the answer is to say them
    // rather than to guess: erring towards a word heard twice is much better
    // than erring towards one silently dropped.
    assert.strictEqual(removeOverlap('one two three four', 'one two three four five'), 'one two three four five');
});

t('text with no overlap is left alone', () => {
    assert.strictEqual(removeOverlap('good evening', 'this is g4abc'), 'this is g4abc');
    assert.strictEqual(removeOverlap('', 'first line'), 'first line');
});

t('only whole sentences are spoken', () => {
    const r = extractSentences('This is a test. And another one! A third');
    assert.deepStrictEqual(r.sentences, ['This is a test.', 'And another one!']);
    assert.strictEqual(r.remainder, 'A third');
});

t('the terminator stays with its sentence', () => {
    // A synthesiser reads "Hello." and "Hello" with different intonation, and
    // the full stop is the only thing telling it which this was.
    assert.deepStrictEqual(extractSentences('Hello?').sentences, ['Hello?']);
});

t('a non-Latin transcript still flushes', () => {
    // The reason the terminator set is not [.!?]: with a Western-only test the
    // buffer never fills a sentence and nothing is ever spoken at all.
    assert.deepStrictEqual(extractSentences('这是一个测试。').sentences, ['这是一个测试。']);
    assert.deepStrictEqual(extractSentences('यह एक परीक्षण है।').sentences, ['यह एक परीक्षण है।']);
});

t('extraction is not left holding state between calls', () => {
    // A `g` regex carries lastIndex; a shared one would make the second call
    // start wherever the first stopped.
    const first = extractSentences('One. Two.');
    const second = extractSentences('One. Two.');
    assert.deepStrictEqual(first, second);
});

t('the buffer holds a part sentence until it finishes', () => {
    let b = bufferSpeech('', 'This is g4abc');
    assert.deepStrictEqual(b.sentences, []);
    assert.strictEqual(b.buffer, 'This is g4abc');

    b = bufferSpeech(b.buffer, 'g4abc calling cq.');
    // The overlap goes, and what is left completes the sentence.
    assert.deepStrictEqual(b.sentences, ['This is g4abc calling cq.']);
    assert.strictEqual(b.buffer, '');
});

t('the tail of a batch stays buffered for the next one', () => {
    const b = bufferSpeech('', 'Done. Starting');
    assert.deepStrictEqual(b.sentences, ['Done.']);
    assert.strictEqual(b.buffer, 'Starting');
});

t('text that never punctuates is spoken anyway once it is long enough', () => {
    // Otherwise a speaker the decoder never hears a full stop from is buffered
    // for the whole session and never read out at all, which looks exactly like
    // speech being broken.
    let b = { buffer: '', sentences: [] };
    for (let i = 0; i < 40 && !b.sentences.length; i++) {
        b = bufferSpeech(b.buffer, `word${i} and more text here`);
    }
    assert.strictEqual(b.sentences.length, 1);
    assert.ok(b.sentences[0].length >= FLUSH_AT, `flushed at ${b.sentences[0].length}`);
    assert.strictEqual(b.buffer, '');
});

t('a segment that is entirely overlap adds nothing', () => {
    const b = bufferSpeech('good evening', 'good evening');
    assert.deepStrictEqual(b.sentences, []);
    assert.strictEqual(b.buffer, 'good evening');
});

// --- voices ----------------------------------------------------------------

const voice = (name, lang) => ({ name, lang });

t('the best English voice wins over the browser default', () => {
    const voices = [
        voice('Microsoft David - English (United States)', 'en-US'),
        voice('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'),
        voice('Google UK English Female', 'en-GB'),
    ];
    assert.strictEqual(preferredVoice(voices).name, 'Google UK English Female');
    // Without Chrome's, Edge's online UK voice — its neural one, and far better
    // than the local fallback listed beside it.
    assert.ok(preferredVoice(voices.slice(0, 2)).name.includes('Sonia'));
});

t('no English voice at all is null, not a wrong-language one', () => {
    assert.strictEqual(preferredVoice([voice('Anna', 'de-DE')]), null);
    assert.strictEqual(preferredVoice([]), null);
    assert.strictEqual(preferredVoice(undefined), null);
});

t('a language picks a voice that speaks it', () => {
    const voices = [
        voice('Google UK English Female', 'en-GB'),
        voice('Microsoft Hedda', 'de-DE'),
        voice('Google Deutsch', 'de-DE'),
    ];
    assert.strictEqual(voiceForLanguage(voices, 'de').name, 'Google Deutsch');
    assert.strictEqual(voiceForLanguage(voices, 'en').name, 'Google UK English Female');
});

t('a language with no voice is null rather than the wrong phoneme set', () => {
    const voices = [voice('Google UK English Female', 'en-GB')];
    assert.strictEqual(voiceForLanguage(voices, 'th'), null);
    assert.strictEqual(voiceForLanguage(voices, ''), null);
});

t('a two-letter code matches a full locale', () => {
    // The API names locales; Whisper and LibreTranslate use two-letter codes.
    assert.ok(voiceForLanguage([voice('Kyoko', 'ja-JP')], 'ja'));
    assert.ok(voiceForLanguage([voice('Ting-Ting', 'zh-CN')], 'zh'));
    assert.ok(voiceForLanguage([voice('Zosia', 'pl_PL')], 'pl'));
});

t('the voice menu puts English first and drops empty groups', () => {
    const groups = voiceGroups([voice('Anna', 'de-DE'), voice('Daniel', 'en-GB')]);
    assert.deepStrictEqual(groups.map((g) => g.label), ['English', 'Other languages']);
    assert.strictEqual(groups[0].options[0].value, 'Daniel');
    assert.deepStrictEqual(voiceGroups([]), []);
    assert.deepStrictEqual(voiceGroups([voice('Anna', 'de-DE')]).map((g) => g.label), ['Other languages']);
});

// --- languages -------------------------------------------------------------

t('the language menu is sorted and has English in it', () => {
    const names = LANGUAGE_MENU.map((l) => l.name);
    assert.deepStrictEqual(names, names.slice().sort((a, b) => a.localeCompare(b)));
    assert.ok(LANGUAGE_MENU.some((l) => l.code === 'en'));
});

t('a detected language we cannot name is shown as itself', () => {
    // The code comes from Whisper, not from the LibreTranslate list, so it may
    // well be one that is not in it — "yue" is still an answer.
    assert.strictEqual(languageName('de'), 'German');
    assert.strictEqual(languageName('yue'), 'YUE');
    assert.strictEqual(languageName(''), '');
});

console.log(`\n${pass} passed`);
