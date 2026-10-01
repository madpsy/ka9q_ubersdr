// An AudioContext the system has taken away, and the player putting it back.
//
// WebKit interrupts an AudioContext for reasons the page cannot see, and leaves
// it in 'interrupted' with no way back of its own accord. Nothing in v2 used to
// listen for that: on iOS it was silence that only closing and reopening the
// receiver could clear, because the host's rescue runs on didBecomeActive and a
// receiver opened while the app is already in front never sees one.
//
// The stub context here is deliberately the same shape as the one in
// noisegraph.test.js — a state that a test sets by hand, and a `fire` that is
// the system telling the page about it.

const assert = require('assert');

function fakeContext() {
    const node = (kind) => ({
        kind,
        out: new Set(),
        gain: { value: 1, setTargetAtTime() {} },
        connect(to) { this.out.add(to); return to; },
        disconnect() { this.out.clear(); },
    });
    return {
        sampleRate: 48000,
        currentTime: 0,
        state: 'running',
        resumes: 0,
        destination: node('destination'),
        createGain: () => node('gain'),
        createScriptProcessor: () => node('script'),
        createChannelSplitter: () => node('splitter'),
        createChannelMerger: () => node('merger'),
        createAnalyser: () => ({ ...node('analyser'), fftSize: 2048, smoothingTimeConstant: 0.5, getFloatTimeDomainData() {} }),
        createMediaStreamDestination: () => node('streamdest'),
        createBufferSource: () => node('source'),
        createDelay: () => node('delay'),
        createBiquadFilter: () => ({ ...node('biquad'), frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, type: 'peaking' }),
        createDynamicsCompressor: () => node('comp'),
        resume() { this.resumes++; return Promise.resolve(); },
        close: () => Promise.resolve(),
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        removeEventListener(type, fn) {
            const at = (this.listeners[type] || []).indexOf(fn);
            if (at >= 0) this.listeners[type].splice(at, 1);
        },
        fire(type) { for (const fn of this.listeners[type] || []) fn(); },
    };
}

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

global.window = global.window || {};
const { AudioPlayer } = require('./.build/audioplayer.cjs');

// A player with a context of our own, built the way the real one is.
function playerOn(ctx) {
    const player = new AudioPlayer();
    window.AudioContext = function () { return ctx; };
    player._createContext(48000);
    return player;
}

t('an interrupted context is resumed', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    p.started = true;
    const before = ctx.resumes;
    ctx.state = 'interrupted';
    ctx.fire('statechange');
    assert.strictEqual(ctx.resumes, before + 1, 'the context was left interrupted');
});

t('a suspended context is resumed too', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    p.started = true;
    const before = ctx.resumes;
    ctx.state = 'suspended';
    ctx.fire('statechange');
    assert.strictEqual(ctx.resumes, before + 1);
});

t('a deliberate suspend is not undone', () => {
    // `started` false is the operator having stopped the receiver. Resuming
    // there would restart audio nobody asked for.
    const ctx = fakeContext();
    playerOn(ctx);
    const before = ctx.resumes;
    ctx.state = 'suspended';
    ctx.fire('statechange');
    assert.strictEqual(ctx.resumes, before, 'a stopped receiver was restarted');
});

t('reaching running again is not a reason to do anything', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    p.started = true;
    const before = ctx.resumes;
    ctx.fire('statechange');          // still 'running'
    assert.strictEqual(ctx.resumes, before);
});

t('a closed context is left closed', () => {
    const ctx = fakeContext();
    const p = playerOn(ctx);
    p.started = true;
    const before = ctx.resumes;
    ctx.state = 'closed';
    ctx.fire('statechange');
    assert.strictEqual(ctx.resumes, before, 'a closed context cannot be resumed');
});

t('a context the system is holding down cannot become a loop', () => {
    // The shape that matters: a refused resume answers with a statechange of
    // its own. Without the rate limit that is a loop, and it pins a core.
    const ctx = fakeContext();
    const p = playerOn(ctx);
    p.started = true;
    const before = ctx.resumes;
    ctx.state = 'interrupted';
    for (let i = 0; i < 50; i++) ctx.fire('statechange');
    assert.strictEqual(ctx.resumes, before + 1, 'resume was called again within the second');
});

t('the context left behind by a rate change is not resumed', () => {
    // A mode change rebuilds the context; the old one is closing and its
    // listener must let it go rather than fight for it.
    const old = fakeContext();
    const p = playerOn(old);
    p.started = true;
    const fresh = fakeContext();
    window.AudioContext = function () { return fresh; };
    p._createContext(24000);
    const before = old.resumes;
    old.state = 'interrupted';
    old.fire('statechange');
    assert.strictEqual(old.resumes, before, 'the replaced context was resumed');
});

// ── short packets ────────────────────────────────────────────────────────────
//
// IQ 192 arrives as ~550 packets a second of 1.8 ms each. One AudioBuffer and
// one source node per packet wore the browser down until the audio stopped
// after half a minute, so short packets are joined into MIN_BLOCK_SEC blocks
// before they are scheduled. Anything already that long — every other mode —
// must go through exactly as it did.

function scheduling(rate, channels, frames, packets) {
    const ctx = fakeContext();
    const started = [];
    ctx.createBuffer = (ch, n, r) => ({ numberOfChannels: ch, length: n, sampleRate: r, duration: n / r, copyToChannel() {} });
    ctx.createBufferSource = () => {
        const n = { connect() {}, disconnect() {}, start() { started.push(n.buffer); } };
        return n;
    };
    const p = playerOn(ctx);
    const tapped = [];
    p.onAudio((planes, n) => tapped.push(n));
    const planes = Array.from({ length: channels }, () => new Float32Array(frames));
    // The clock moves as the packets arrive, as it would live — a clock held
    // still would have the queue ceiling dropping everything past 200 ms.
    for (let i = 0; i < packets; i++) {
        p._schedule(planes, frames, rate);
        ctx.currentTime += frames / rate;
    }
    return { started, tapped };
}

t('a 20 ms packet is one buffer, as it always was', () => {
    const { started } = scheduling(12000, 1, 240, 50);
    assert.strictEqual(started.length, 50);
    assert.ok(started.every((b) => b.length === 240));
});

t('IQ 192’s 1.8 ms packets are joined into 20 ms buffers, and none is lost', () => {
    const { started, tapped } = scheduling(192000, 2, 349, 550);
    // A second of IQ 192: about fifty buffers rather than five hundred and fifty.
    assert.ok(started.length <= 51, `${started.length} buffers for one second`);
    assert.ok(started.every((b) => b.duration >= 0.02 && b.numberOfChannels === 2), 'a short or mono buffer');
    const queued = started.reduce((n, b) => n + b.length, 0);
    const pending = 550 * 349 - queued;
    assert.ok(pending >= 0 && pending < 3840, `${pending} frames unaccounted for`);
    // And whatever taps the stream still sees every packet as it came.
    assert.strictEqual(tapped.length, 550);
    assert.ok(tapped.every((n) => n === 349));
});

console.log('\n' + pass + ' ok');
// Same reason noisegraph.test.js does: every context built here leaves a
// clip-watch interval behind, and nothing in a test is a receiver that would
// ever stop one.
process.exit(process.exitCode || 0);
