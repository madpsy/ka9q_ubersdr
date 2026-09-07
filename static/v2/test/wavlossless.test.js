// Choosing WAV in the recorder raises the audio stream to lossless.
//
// The reason is that the two settings are really one: MediaRecorder's WebM is a
// second Opus encode of audio the browser has already Opus-decoded, and WAV
// skips that second encode but cannot put back what the first threw away. A WAV
// taken off an Opus stream is therefore an uncompressed copy of a lossy signal
// — every byte of PCM and none of the fidelity — which is the one combination
// nobody would choose on purpose.
//
// So the assertions come in pairs, the way padiq's do, because the bug this
// guards against is the halves disagreeing: the recorder asking for the hold,
// and the Audio panel showing the stream as fixed at lossless without
// forgetting the operator's standing choice underneath it. Either one alone is
// a receiver whose two panels contradict each other.

const assert = require('assert');

// Before the bundle: the panels reach the radio and the display settings, and
// several modules on the way read the browser at import time.
globalThis.window = globalThis.window || globalThis;
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
// Plain HTTP, so the output-device picker takes its unsupported path and asks
// the browser for nothing. Nothing here is about output devices.
globalThis.location = { protocol: 'http:', hostname: 'radio.example' };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
// What wavSupported() looks for. Without both, the panel refuses WAV for a
// reason that has nothing to do with this file.
globalThis.window.isSecureContext = true;
globalThis.window.AudioWorkletNode = class {};
// The panels mount intervals (the meter poll, the recording clock). Left on
// Node's real timer they fire after the last assertion, against stubs that were
// never built, and take the process down behind a passing scoreboard.
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

const {
    deep, render, reset, words,
    RecorderPanel, RecorderFormatWatch, AudioPanel, FormatPicker, getRecorder,
} = require('./.build/wavlossless.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const player = { setDucked() {}, contextEpoch: 0 };
const rec = getRecorder(player);

// `audio` as RadioContext holds it: what the socket is asking for, the standing
// choice underneath, and whether something is holding the first away from the
// second.
function ctxFor({ format = 'opus', formatPref = 'opus', formatHold = false, mode = 'usb' } = {}) {
    const calls = [];
    const formats = [];
    return {
        calls,
        formats,
        ctx: {
            tuning: { mode, frequency: 14_200_000, bandwidthLow: 50, bandwidthHigh: 2700 },
            running: true,
            player,
            serverInfo: {},
            meters: { current: {} },
            audio: {
                volume: 0.7,
                muted: false,
                ducked: false,
                bufferSec: 0.2,
                channel: 'both',
                minMargin: 0,
                sinkId: '',
                format,
                formatPref,
                formatHold,
            },
            actions: {
                setLosslessHold(on) { calls.push(on); },
                setAudioFormat(f) { formats.push(f); },
                setAudioMargin() {},
                setVolume() {},
                setChannel() {},
                toggleMute() {},
                setBufferSec() {},
                setAudioSink() { return Promise.resolve(); },
            },
        },
    };
}

/** What the watch asked for with the recorder set to `pref`. */
function holdFor(pref) {
    rec.preferredFormat = pref;
    const { calls, ctx } = ctxFor();
    reset();
    render(RecorderFormatWatch, {}, ctx);
    return calls;
}

t('the recorder announces a change of format', () => {
    // The whole mechanism rests on this: preferredFormat is an accessor so that
    // something outside the panel can follow it. A plain field would leave the
    // watch reading a value nobody told it had moved.
    rec.preferredFormat = 'webm';
    let heard = 0;
    const off = rec.on('change', () => { heard++; });
    rec.preferredFormat = 'wav';
    assert.strictEqual(heard, 1, 'setting WAV emitted');
    rec.preferredFormat = 'wav';
    assert.strictEqual(heard, 1, 'setting the same value again said nothing');
    rec.preferredFormat = 'webm';
    assert.strictEqual(heard, 2, 'going back emitted');
    off();
});

t('WAV asks for the hold, Opus lets it go', () => {
    assert.deepStrictEqual(holdFor('wav'), [true], 'WAV holds the stream at lossless');
    assert.deepStrictEqual(holdFor('webm'), [false], 'Opus releases it');
});

// The buttons of the segmented control that offers `label`, as drawn.
//
// By the rendered buttons rather than by the options handed to Segmented,
// because deep() calls every function component it meets — the control itself
// included — so what is left in the tree is what the operator would see and
// press, which is the right thing to be asserting on anyway.
function segmented(tree, label) {
    for (const node of deep(tree)) {
        const cls = node.props && node.props.className;
        if (typeof cls !== 'string' || !/^segmented segmented--/.test(cls)) continue;
        const buttons = [].concat(node.props.children || []).filter(Boolean);
        if (buttons.some((b) => b.props && b.props.children === label)) return buttons;
    }
    return null;
}

/** Which option a segmented control is showing as chosen. */
function chosen(buttons) {
    const hit = buttons.find((b) => / is-active/.test(b.props.className));
    return hit ? hit.props.children : null;
}

// The button whose label reads `label`. ui.jsx's Button wraps its children in a
// span so an icon can sit beside them, so the words are one level down rather
// than on the button itself.
function button(tree, label) {
    return deep(tree).find((n) => n.type === 'button'
        && [].concat(n.props.children || []).some((c) => c && c.props
            && c.props.children === label));
}

t('the recorder panel offers WAV, and asks before spending the bandwidth', () => {
    // The same question the Audio panel asks before lossless, because it is the
    // same bandwidth and the same person paying for it: choosing WAV raises the
    // stream. Cancel therefore has to leave the recorder on Opus — a dialog
    // whose Cancel still made the change would be worse than no dialog.
    rec.preferredFormat = 'webm';
    reset();
    const { ctx } = ctxFor();
    const first = render(RecorderPanel, {}, ctx).tree;
    const buttons = segmented(first, 'WAV');
    assert.ok(buttons, 'the format control is drawn');
    assert.strictEqual(chosen(buttons), 'Opus', 'and starts on Opus');

    buttons.find((b) => b.props.children === 'WAV').props.onClick();
    assert.strictEqual(rec.preferredFormat, 'webm', 'nothing changes until it is answered');

    const asked = render(RecorderPanel, {}, ctx).tree;
    assert.ok(/High bandwidth warning/.test(words(asked)), 'the warning is up');
    assert.ok(/2. more bandwidth/.test(words(asked)), 'with the same figures as the Audio panel');
    button(asked, 'Cancel').props.onClick();
    assert.strictEqual(rec.preferredFormat, 'webm', 'Cancel leaves it on Opus');

    segmented(render(RecorderPanel, {}, ctx).tree, 'WAV')
        .find((b) => b.props.children === 'WAV').props.onClick();
    button(render(RecorderPanel, {}, ctx).tree, 'Use lossless').props.onClick();
    assert.strictEqual(rec.preferredFormat, 'wav', 'accepting lands the choice on the recorder');
});

t('and does not ask when lossless was already the standing choice', () => {
    // Nothing is being raised, so there is nothing to warn about — the dialog
    // would be a stop sign in front of a change that costs nobody anything.
    rec.preferredFormat = 'webm';
    reset();
    const { ctx } = ctxFor({ format: 'pcm-zstd', formatPref: 'pcm-zstd' });
    const tree = render(RecorderPanel, {}, ctx).tree;
    segmented(tree, 'WAV').find((b) => b.props.children === 'WAV').props.onClick();
    assert.strictEqual(rec.preferredFormat, 'wav', 'the choice goes straight through');
    assert.ok(!/High bandwidth/.test(words(render(RecorderPanel, {}, ctx).tree)), 'and nothing asked');
});

t('the recorder panel says the stream has been raised', () => {
    rec.preferredFormat = 'wav';
    reset();
    const { ctx } = ctxFor();
    const { tree } = render(RecorderPanel, {}, ctx);
    const said = words(tree);
    assert.ok(/lossless/.test(said), 'it names what the stream is now');
    assert.ok(/two to three times/.test(said), 'and what that costs the owner');
});

t('and does not, when lossless was already the standing choice', () => {
    // Nothing has been raised and nobody is paying more, so the sentence about
    // the cost would be describing a change that did not happen.
    rec.preferredFormat = 'wav';
    reset();
    const { ctx } = ctxFor({ format: 'pcm-zstd', formatPref: 'pcm-zstd', formatHold: true });
    const said = words(render(RecorderPanel, {}, ctx).tree);
    assert.ok(!/two to three times/.test(said), 'no bandwidth warning');
});

/** The Audio panel's format buttons, as drawn for `audio`. */
function formatControl(opts) {
    reset();
    return segmented(render(AudioPanel, {}, ctxFor(opts).ctx).tree, 'Lossless');
}

t('the Audio panel shows the stream as fixed while the hold is on', () => {
    const buttons = formatControl({ format: 'pcm-zstd', formatPref: 'opus', formatHold: true });
    assert.ok(buttons, 'the format control is drawn');
    assert.strictEqual(chosen(buttons), 'Lossless', 'it reads lossless');
    assert.ok(buttons.every((b) => b.props.disabled), 'and takes no input');
});

t('the standing choice is untouched underneath, and said so', () => {
    // The half that matters a fortnight later: the hold must not be mistaken
    // for the operator having chosen lossless, or they are left on it in every
    // session afterwards having never asked for it.
    reset();
    const ctx = ctxFor({ format: 'pcm-zstd', formatPref: 'opus', formatHold: true }).ctx;
    const said = words(render(AudioPanel, {}, ctx).tree);
    assert.ok(/recorder is set to WAV/.test(said), 'it says what raised the stream');
    assert.ok(/comes back/.test(said), 'and that the usual choice returns');
    assert.strictEqual(ctx.audio.formatPref, 'opus', 'the preference was not rewritten');
});

t('the Audio panel still asks its own question, out of the same dialog', () => {
    // The half the extraction could have broken: the warning moved into a
    // shared component, and the panel it came from must still raise it and
    // still only change the format once it has been answered.
    // The picker itself rather than the whole panel: deep() gives every nested
    // component a throwaway hook frame, so a dialog opened inside one is gone
    // by the next look at the tree.
    reset();
    const { formats, ctx } = ctxFor();
    segmented(render(FormatPicker, {}, ctx).tree, 'Lossless')
        .find((b) => b.props.children === 'Lossless').props.onClick();
    assert.deepStrictEqual(formats, [], 'nothing changes until it is answered');
    const asked = render(FormatPicker, {}, ctx).tree;
    assert.ok(/High bandwidth warning/.test(words(asked)), 'the warning is up');
    button(asked, 'Use lossless').props.onClick();
    assert.deepStrictEqual(formats, ['pcm-zstd'], 'accepting changes the format');
});

t('with no hold the control is live and reads the preference', () => {
    // The other side of the guard: it must be the hold doing this, not the
    // format buttons having been disabled for everybody.
    const buttons = formatControl({ format: 'opus', formatPref: 'opus' });
    assert.strictEqual(chosen(buttons), 'Opus', 'it reads the standing choice');
    assert.ok(buttons.every((b) => !b.props.disabled), 'and takes input');
});

console.log(`\n${pass} passed`);
