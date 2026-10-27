// The main player's side of simultaneous VFOs: the sub bus the extra VFOs play
// into, and the stereo placement of the main receiver itself.
//
// The bus has to go wherever the main audio goes — one device, one element on
// the browsers that need one — and yet not be gated with it when the Media
// Session HTTP stream takes over the main receiver's playback, since that
// stream carries none of the others. A rig on the air silences both.

const assert = require('assert');

function fakeContext() {
    const node = (kind) => ({
        kind,
        out: new Set(),
        gain: { value: 1, setTargetAtTime(v) { this.value = v; } },
        connect(to) { this.out.add(to); return to; },
        disconnect() { this.out.clear(); },
    });
    return {
        sampleRate: 48000,
        currentTime: 0,
        state: 'running',
        destination: node('destination'),
        createGain: () => node('gain'),
        createScriptProcessor: () => node('script'),
        createChannelSplitter: () => node('splitter'),
        createChannelMerger: () => node('merger'),
        createAnalyser: () => ({ ...node('analyser'), fftSize: 2048, smoothingTimeConstant: 0.5, getFloatTimeDomainData() {} }),
        createMediaStreamDestination: () => ({ ...node('streamdest'), stream: {} }),
        createBufferSource: () => node('source'),
        createDelay: () => node('delay'),
        createBiquadFilter: () => ({ ...node('biquad'), frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, type: 'peaking' }),
        createDynamicsCompressor: () => node('comp'),
        resume: () => Promise.resolve(),
        close: () => Promise.resolve(),
        addEventListener() {},
        removeEventListener() {},
    };
}

global.window = global.window || {};
global.document = {
    body: { appendChild(el) { el.parentNode = this; }, removeChild() {} },
    createElement: () => ({
        style: {},
        setAttribute() {},
        play: () => Promise.resolve(),
        pause() {},
    }),
};
const { AudioPlayer } = require('./.build/audioplayer.cjs');

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

function playerOn(ctx) {
    const player = new AudioPlayer();
    window.AudioContext = function () { return ctx; };
    player._createContext(48000);
    return player;
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

t('the sub bus plays to the device, beside the main output rather than through it', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    assert.ok(p.subOutput, 'there is one');
    assert.ok(p.subOutput.out.has(ctx.destination));
    assert.notStrictEqual(p.subOutput, p.outputBus);
});

t('the HTTP stream taking over the main receiver leaves the sub bus playing', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    p.setExternalPlayback(true);
    assert.strictEqual(p.outputBus.gain.value, 0);
    assert.strictEqual(p.subOutput.gain.value, 1);
});

t('TX silences the sub bus with the main audio, and a new context remembers', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    p.setTxSilenced(true);
    assert.strictEqual(p.subOutput.gain.value, 0);
    p._createContext(12000);
    assert.strictEqual(p.subOutput.gain.value, 0, 'rebuilt silent');
    p.setTxSilenced(false);
    assert.strictEqual(p.subOutput.gain.value, 1);
});

t('a rebuilt context says so, and brings a new bus', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    const old = p.subOutput;
    let heard = null;
    p.on('context', (epoch) => { heard = epoch; });
    p._createContext(24000);
    assert.strictEqual(heard, p.contextEpoch);
    assert.notStrictEqual(p.subOutput, old);
});

t('where an element carries the audio, the sub bus goes into it too', async () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    await p.setAnchorWanted(true);
    const dest = p.element._dest;
    assert.ok(p.outputBus.out.has(dest));
    assert.ok(p.subOutput.out.has(dest), 'same element as the main audio');
    assert.ok(!p.subOutput.out.has(ctx.destination));
    await p.setAnchorWanted(false);
    assert.ok(p.subOutput.out.has(ctx.destination), 'and back to the device after');
});

t('a pan is equal-power on the two sides', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    p.setPan(-1);
    assert.ok(near(p.leftGain.gain.value, 1) && near(p.rightGain.gain.value, 0));
    p.setPan(1);
    assert.ok(near(p.leftGain.gain.value, 0) && near(p.rightGain.gain.value, 1));
    p.setPan(0);
    assert.ok(near(p.leftGain.gain.value, Math.SQRT1_2) && near(p.rightGain.gain.value, Math.SQRT1_2));
});

t('a pan wins over the channel picker, which comes back when it is cleared', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    p.setChannelMode('left');
    p.setPan(1);
    assert.ok(near(p.rightGain.gain.value, 1), 'the pan is in force');
    p.setChannelMode('both');
    assert.ok(near(p.leftGain.gain.value, 0), 'the picker does not undo a pan');
    p.setPan(null);
    assert.strictEqual(p.leftGain.gain.value, 1);
    assert.strictEqual(p.rightGain.gain.value, 1);
    assert.strictEqual(p.channelMode, 'both');
});

t('the lead-in is the player\'s own cushion', () => {
    const p = playerOn(fakeContext());
    p.setBufferSec(0.2);
    assert.ok(near(p.leadInSec(), 0.12));
    p.setBufferSec(0.1);
    assert.ok(near(p.leadInSec(), 0.075), 'never more than three quarters of the ceiling');
});

(async () => {
    for (const [name, fn] of queue) {
        try {
            await fn();
            console.log('ok    ' + name);
            pass++;
        } catch (e) {
            console.log('FAIL  ' + name + '\n      ' + (e && e.message));
            process.exitCode = 1;
        }
    }
    if (!process.exitCode) console.log(`\n${pass} passed`);
    process.exit(process.exitCode || 0);
})();
