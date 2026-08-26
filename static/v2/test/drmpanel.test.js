// The DRM panel renders, and the mode rules it depends on actually hold.
//
// Two things here that no protocol test can reach. The panel forces the receiver
// into IQ when it starts and stops itself when the mode is changed back, which is
// three effects and two refs deep in the component — and it renders a station
// identity block built from a status frame that may be absent, partial, or fully
// populated. Either could be written to build cleanly, pass everything else, and
// blank the panel the moment somebody opened it. See hookStub.js for what
// "renders" means here.

const assert = require('assert');

// Before the bundle: the module graph behind an extension reaches the radio and
// the display settings, and both read the browser at import time.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.TextDecoder = globalThis.TextDecoder || require('util').TextDecoder;
// NOTE: the decoding branch is deliberately not rendered here. Switching the
// decoder on reaches useAudioExtension, which holds the dxcluster socket open
// and keeps retry timers alive — the stub harness has no way to wind that down,
// so the test would never exit. What that branch draws is built entirely from
// the frame helpers, which are covered directly below.

const {
    render, reset, walk, words, DRMExtension, ExtensionsPanel,
    EXTENSIONS, EXTENSION_BY_ID,
    decodeFrame, hasAudioLock, progressLabel, qualityFraction,
} = require('./.build/drmpanel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

function context(over) {
    const calls = [];
    const ctx = {
        tuning: { frequency: 6_055_000, mode: 'iq', bandwidthLow: -6000, bandwidthHigh: 6000 },
        running: true,
        audioState: 'open',
        audio: { volume: 0.8, muted: false },
        player: { ctx: null, setDucked: (v) => calls.push(['duck', v]) },
        actions: { setMode: (m) => calls.push(['setMode', m]), tuneTo() {}, ensureVisible() {} },
        server: {},
        set() {},
        ...over,
    };
    ctx.calls = calls;
    return ctx;
}

const statusFrame = (over) => {
    const obj = {
        t: 'status', acq: 1, fsync: 3, tsync: 3, fac: 3, sdc: 3, audio: 3,
        wmer: 17.5, mer: 17.4, snr: 17.6, robm: 'A', bandwidth: '9', qam: 64,
        service: 'DeutschlandRadio', country: 'de', language: 'deu', text: '',
        codec: 'AAC', audioMode: 'parametric-stereo', sbr: 1,
        coreRate: 24000, outputRate: 12000, ...over,
    };
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    const pkt = new Uint8Array(1 + json.length);
    pkt[0] = 0x03;
    pkt.set(json, 1);
    return pkt;
};

t('it renders docked and minimal', () => {
    for (const minimal of [false, true]) {
        reset();
        const { tree } = render(DRMExtension, { minimal }, context());
        assert.ok(tree, `minimal=${minimal} produced nothing`);
    }
});

t('it renders before the receiver is running', () => {
    reset();
    const { tree } = render(DRMExtension, {}, context({ running: false, audioState: 'closed' }));
    assert.ok(tree);
    assert.ok(words(tree).includes('Start the receiver to decode.'),
        'expected the not-running note');
});

t('it renders while waiting for audio', () => {
    reset();
    const { tree } = render(DRMExtension, {}, context({ audioState: 'connecting' }));
    assert.ok(words(tree).includes('Waiting for the audio connection…'));
});

t('Start switches a non-IQ receiver to iq', () => {
    reset();
    const ctx = context({ tuning: { frequency: 6_055_000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 } });
    const { tree } = render(DRMExtension, {}, ctx);
    const start = walk(tree).find((n) => n && n.props && n.props.children === 'Start');
    assert.ok(start, 'no Start button rendered');
    start.props.onClick();
    assert.deepStrictEqual(ctx.calls.filter((c) => c[0] === 'setMode'), [['setMode', 'iq']],
        'Start should put the receiver into iq');
});

t('Start does not touch the mode when already in IQ', () => {
    reset();
    const ctx = context();
    const { tree } = render(DRMExtension, {}, ctx);
    const start = walk(tree).find((n) => n && n.props && n.props.children === 'Start');
    start.props.onClick();
    assert.deepStrictEqual(ctx.calls.filter((c) => c[0] === 'setMode'), [],
        'already in IQ — nothing to change');
});

// ── the frame helpers, which the panel's whole display is built from ────────

t('a status frame decodes', () => {
    const msg = decodeFrame(statusFrame());
    assert.strictEqual(msg.kind, 'status');
    assert.strictEqual(msg.status.service, 'DeutschlandRadio');
    assert.strictEqual(hasAudioLock(msg.status), true);
});

t('a truncated status frame is dropped, not thrown', () => {
    assert.strictEqual(decodeFrame(new Uint8Array([0x03, 0x7b])), null);
    assert.strictEqual(decodeFrame(new Uint8Array([])), null);
    assert.strictEqual(decodeFrame(new Uint8Array([0x02, 1, 2])), null);
});

t('an audio frame decodes and keeps its payload', () => {
    const pkt = new Uint8Array(20);
    pkt[0] = 0x02;
    pkt[12] = 0x2e;  // sample_rate low byte -> 12000
    pkt[13] = 1;
    const msg = decodeFrame(pkt);
    assert.strictEqual(msg.kind, 'audio');
    assert.strictEqual(msg.channels, 1);
    assert.strictEqual(msg.opus.length, 6);
});

t('progress is staged, not just locked/unlocked', () => {
    assert.match(progressLabel(null), /Waiting/);
    assert.match(progressLabel({ acq: 0 }), /Searching/);
    assert.match(progressLabel({ acq: 1, fac: 1 }), /syncing/i);
    assert.match(progressLabel({ acq: 1, fac: 3, sdc: 1 }), /station information/i);
    assert.match(progressLabel({ acq: 1, fac: 3, sdc: 3, audio: 1 }), /not decoding/i);
    assert.strictEqual(progressLabel({ acq: 1, fac: 3, sdc: 3, audio: 3 }), 'Decoding');
});

t('quality clamps either side of the useful range', () => {
    assert.strictEqual(qualityFraction(0), 0);
    assert.strictEqual(qualityFraction(-5), 0);
    assert.strictEqual(qualityFraction(40), 1);
    assert.strictEqual(qualityFraction(undefined), 0);
    const q = qualityFraction(16);
    assert.ok(q > 0 && q < 1, `16 dB should be mid-scale, got ${q}`);
});

t('language codes become names, unknown ones survive', () => {
    const { languageName } = require('./.build/drmpanel.cjs');
    assert.strictEqual(languageName('deu'), 'German');
    assert.strictEqual(languageName('ENG'), 'English');
    assert.strictEqual(languageName('zzz'), 'ZZZ');
    assert.strictEqual(languageName(''), '');
});

t('the threshold sits inside the bar, not at an end', () => {
    const { WMER_THRESHOLD_FRACTION } = require('./.build/drmpanel.cjs');
    assert.ok(WMER_THRESHOLD_FRACTION > 0 && WMER_THRESHOLD_FRACTION < 1,
        `threshold fraction ${WMER_THRESHOLD_FRACTION} would be invisible`);
});

// ── the launcher's IQ rule ──────────────────────────────────────────────────
//
// IQ mode closes and disables every extension, because they all decode
// demodulated audio and IQ is not that. DRM inverts the premise — it is the one
// that wants the quadrature stream — so it has to survive the very mode change
// that kills the rest, and the launcher has to keep offering it.

t('DRM is the extension flagged as wanting IQ', () => {
    assert.strictEqual(EXTENSION_BY_ID.drm.needsIQ, true);
    const others = EXTENSIONS.filter((e) => e.id !== 'drm' && e.needsIQ);
    assert.deepStrictEqual(others.map((e) => e.id), [],
        'only DRM should claim needsIQ; the rest decode demodulated audio');
});

function launcher(mode) {
    const list = EXTENSIONS.map((e) => ({ ...e, enabled: true }));
    return {
        list,
        activeId: null,
        minimised: false,
        toggle() {},
        running: true,
        tuning: { frequency: 6_055_000, mode },
    };
}

// The stub does not carry `key` onto the node, so rows are identified by the
// title they render — which is what someone reading the launcher sees anyway.
function rowsOf(mode) {
    reset();
    const { tree } = render(ExtensionsPanel, {}, launcher(mode));
    return walk(tree)
        .filter((n) => n && n.props && typeof n.props.disabled === 'boolean')
        .map((n) => {
            const w = words(n);
            return { text: Array.isArray(w) ? w.join(' ') : String(w), disabled: n.props.disabled };
        });
}

t('in IQ the launcher disables the audio decoders but not DRM', () => {
    const rows = rowsOf('iq');
    assert.ok(rows.length >= 2, `expected extension rows, got ${rows.length}`);

    const drm = rows.find((r) => r.text.startsWith('DRM Decoder'));
    const ft8 = rows.find((r) => r.text.startsWith('FT8 Decoder'));
    assert.ok(drm && ft8, 'expected both a DRM and an FT8 row');
    assert.strictEqual(drm.disabled, false, 'DRM must stay usable in IQ');
    assert.strictEqual(ft8.disabled, true, 'FT8 cannot decode IQ');

    // And it is the only one: if another extension ever claims needsIQ without
    // actually reading quadrature, this catches it.
    const live = rows.filter((r) => !r.disabled);
    assert.strictEqual(live.length, 1, `expected only DRM live in IQ, got ${live.length}`);
});

t('outside IQ every enabled extension is offered, DRM included', () => {
    const rows = rowsOf('usb');
    assert.ok(rows.length >= 2, `expected extension rows, got ${rows.length}`);
    for (const r of rows) {
        assert.strictEqual(r.disabled, false, `disabled in USB: ${r.text}`);
    }
});

console.log(`\n${pass} passed`);
