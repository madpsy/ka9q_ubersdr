// Where the client noise stage sits in the audio graph.
//
// Both bugs this file exists for were wiring, not DSP, and neither was visible
// to any amount of testing of the blanker itself: the audio either reaches the
// speakers through the stage or it does not, and the stage happily counts
// pulses either way. So this drives AudioPlayer against a fake AudioContext
// and asserts on the edges of the graph it builds.
//
// The one that shipped: with both stages switched off, a fresh context matched
// the "nothing to change" fast path — nbNode and nrNode are null on a new
// context, which is exactly what "no stages wanted" looks like — and returned
// before joining head to the filter chain. The receiver came up silent and
// stayed silent until a stage was toggled, which forced the rebuild that does
// the wiring.

const assert = require('assert');

// Enough of the Web Audio API for the graph builder: nodes that remember what
// they were connected to.
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
        resume: () => Promise.resolve(),
        close: () => Promise.resolve(),
    };
}

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

global.window = global.window || {};
const { AudioPlayer } = require('./.build/audioplayer.cjs');

// Is there a path from `from` to `to` along the connections made?
function reaches(from, to, seen = new Set()) {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const next of from.out || []) if (reaches(next, to, seen)) return true;
    return false;
}

function playerWith(noise) {
    const player = new AudioPlayer();
    const ctx = fakeContext();
    window.AudioContext = function () { return ctx; };
    player.setNoise(noise);
    player._createContext(48000);
    return player;
}

const OFF = { nb: { enabled: false }, nr: { enabled: false } };
const NB = { nb: { enabled: true, thresholdDb: 15, widthMs: 2 }, nr: { enabled: false } };
const NR = { nb: { enabled: false }, nr: { enabled: true, type: 'lsa', strength: 40, makeupDb: 0 } };

t('audio reaches the output with both stages off', () => {
    // The bug: a fresh context with nothing enabled left head connected to
    // nothing at all, and the receiver played silence.
    const p = playerWith(OFF);
    assert.ok(reaches(p.head, p.gain), 'head does not reach the volume control');
});

t('audio reaches the output through the blanker', () => {
    const p = playerWith(NB);
    assert.ok(p.nbNode, 'no blanker node was built');
    assert.ok(reaches(p.head, p.nbNode), 'the blanker is not fed');
    assert.ok(reaches(p.nbNode, p.gain), 'the blanker does not reach the volume control');
});

t('audio reaches the output through NR', () => {
    const p = playerWith(NR);
    assert.ok(p.nrNode, 'no NR node was built');
    assert.ok(reaches(p.head, p.nrNode) && reaches(p.nrNode, p.gain));
});

t('toggling a stage on and off leaves the audio connected', () => {
    const p = playerWith(OFF);
    for (const spec of [NB, OFF, NR, NB, OFF]) {
        p.setNoise(spec);
        assert.ok(reaches(p.head, p.gain), `audio lost after switching to ${JSON.stringify(spec.nb.enabled)}/${JSON.stringify(spec.nr.enabled)}`);
    }
});

t('the blanker comes before NR when both are on', () => {
    // Not cosmetic ordering: an impulse is precisely what a spectral noise
    // model must not learn, so the clicks have to be gone before NR estimates
    // a floor from the audio. The other way round, every crash teaches NR the
    // band is louder than it is.
    const p = playerWith({
        nb: { enabled: true, thresholdDb: 19, widthMs: 4 },
        nr: { enabled: true, type: 'lsa', strength: 40, makeupDb: 0 },
    });
    assert.ok(p.nbNode && p.nrNode, 'both stages should be built');
    assert.ok(reaches(p.head, p.nbNode), 'the blanker is not fed from the head');
    assert.ok(reaches(p.nbNode, p.nrNode), 'NR does not come after the blanker');
    assert.ok(!reaches(p.nrNode, p.nbNode), 'the blanker is downstream of NR');
    assert.ok(reaches(p.nrNode, p.gain), 'NR does not reach the volume control');
});

t('only one NR engine runs at a time, and switching swaps it', () => {
    // The engines are alternatives, not layers: LSA into NR2 into somebody
    // else's denoiser would be three noise models arguing about the same
    // audio. One `type` field decides, so exclusivity is structural — this is
    // here to keep it that way, and to prove a switch actually swaps the node
    // rather than leaving the old one in the graph beside the new one.
    const engine = (type) => ({
        nb: { enabled: false },
        nr: { enabled: true, type, strength: 40, makeupDb: 0 },
    });
    const p = playerWith(engine('lsa'));
    const first = p.nrNode;
    assert.ok(first, 'no NR node');

    p.setNoise(engine('nr2'));
    assert.notStrictEqual(p.nrNode, first, 'switching engine kept the old node');
    assert.strictEqual(p.nrType, 'nr2');
    assert.ok(reaches(p.head, p.nrNode) && reaches(p.nrNode, p.gain));
    assert.ok(!reaches(first, p.gain), 'the old engine is still wired to the output');

    p.setNoise(engine('rmn'));
    assert.strictEqual(p.nrType, 'rmn');
    assert.strictEqual(p.nr, null, 'the network engine has no local instances');
    assert.ok(reaches(p.head, p.nrNode) && reaches(p.nrNode, p.gain));

    // ...and the blanker is not one of the alternatives: it runs alongside.
    p.setNoise({ nb: { enabled: true, thresholdDb: 19, widthMs: 4 }, nr: { enabled: true, type: 'rmn' } });
    assert.ok(p.nbNode && p.nrNode, 'the blanker and the network engine must coexist');
    assert.ok(reaches(p.nbNode, p.nrNode), 'the blanker must still come first');
});

t('a settings change with the same stages does not rewire anything', () => {
    // The fast path still has to exist: a slider moving must not rebuild a
    // ScriptProcessor, which would tear the audio.
    const p = playerWith(NB);
    const node = p.nbNode;
    p.setNoise({ nb: { enabled: true, thresholdDb: 20, widthMs: 4 }, nr: { enabled: false } });
    assert.strictEqual(p.nbNode, node, 'the blanker was rebuilt for a slider move');
    assert.strictEqual(p.nb[0].thresholdDb, 20, 'the new threshold did not reach the DSP');
});

console.log(`\n${pass} ok`);
// The player keeps a clip-watch interval per context, and nothing here is a
// real receiver that would ever stop it — without this the suite waits for a
// timer that has no reason to fire.
process.exit(process.exitCode || 0);
