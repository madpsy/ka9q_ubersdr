// The templates: each loads, compiles at any rate, runs, and does what its
// summary says it does.

const assert = require('assert');
const { compile, Runtime, TEMPLATES, TEST_MESSAGES, controlPort, MORSE } = require('./.build/playground.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const RATE = 12000;
const byId = Object.fromEntries(TEMPLATES.map((x) => [x.id, x]));

/** Carriers over a little noise, packet by packet. */
function band(carriers, rate = RATE) {
    let k = 0;
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const phase = carriers.map(() => 0);
    return () => {
        const n = Math.round(rate * 0.02);
        const I = new Float32Array(n);
        const Q = new Float32Array(n);
        for (let j = 0; j < n; j++, k++) {
            let i = 0.002 * rnd();
            let q = 0.002 * rnd();
            carriers.forEach((c, x) => {
                const hz = c.hz + (c.drift || 0) * (k / rate);
                phase[x] += (2 * Math.PI * hz) / rate;
                i += c.amp * Math.cos(phase[x]);
                q += c.amp * Math.sin(phase[x]);
            });
            I[j] = i;
            Q[j] = q;
        }
        return { i: I, q: Q, frames: n, rate };
    };
}

for (const tpl of TEMPLATES) {
    t(`${tpl.title}: well formed, compiles at 12k and 192k, and runs`, () => {
        assert.ok(tpl.title && tpl.summary.length > 40, 'no title or summary');
        const g = tpl.build();
        assert.ok(g.nodes.length >= 2);
        assert.ok(g.nodes.some((n) => n.x || n.y), 'not laid out');
        assert.notStrictEqual(tpl.build(), g, 'each load must be a fresh graph');
        for (const rate of [12000, 192000]) {
            const c = compile(g, rate);
            assert.ok(c.ok, `${rate}: ${JSON.stringify(c.errors)}`);
            const rt = new Runtime(g, rate);
            const next = band([{ hz: 1000, amp: 0.05 }], rate);
            for (let p = 0; p < 10; p++) assert.ok(rt.process(next()));
        }
    });
}

t('“Lock to a carrier” locks to a drifting carrier', () => {
    const rt = new Runtime(byId.afc.build(), RATE);
    const next = band([{ hz: 180, amp: 0.1, drift: 2 }]);
    for (let p = 0; p < 50 * 6; p++) rt.process(next());
    const carrier = 180 + 2 * 6;
    assert.ok(Math.abs(rt.read('counter').hz) < 1, `still ${rt.read('counter').hz} Hz off after the shift`);
    assert.ok(Math.abs(rt.driven().shift.frequencyHz + carrier) < 2, `shift at ${rt.driven().shift.frequencyHz}, carrier at ${carrier}`);
    assert.ok(rt.read('plot').history.length > 10, 'the plot shows nothing settling');
});

t('“Tune to the strongest signal” tunes to it', () => {
    const rt = new Runtime(byId.strongest.build(), RATE);
    const next = band([{ hz: -2100, amp: 0.1 }, { hz: 1400, amp: 0.01 }]);
    for (let p = 0; p < 100; p++) rt.process(next());
    assert.ok(Math.abs(rt.driven().demod.offsetHz + 2100) < 3, `tuned to ${rt.driven().demod.offsetHz}`);
    assert.ok(rt.read('log').lines.some((l) => l.type === 'appeared'), 'the log is empty');
});

t('“Look at a filter” shows the filter’s gain and phase, with no receiver', () => {
    const g = byId['filter-bench'].build();
    assert.ok(!g.nodes.some((n) => n.type === 'iq-in'), 'the bench needs a receiver');
    const rt = new Runtime(g, 48000);
    for (let p = 0; p < 100; p++) rt.process({ i: null, q: null, frames: 960, rate: 48000 });
    const m = rt.read('phase');
    assert.ok(Math.abs(m.hz - 800) < 2, `measured at ${m.hz} Hz`);
    assert.ok(Math.abs(m.gainDb) < 0.1, `passband gain ${m.gainDb} dB`);
    assert.ok(m.phaseDeg !== null);
    assert.ok(rt.read('scope').b, 'the scope has no second trace');
});

t('“Play an IQ file” needs no receiver; the others that listen do', () => {
    assert.ok(!byId.player.build().nodes.some((n) => n.type === 'iq-in'));
    for (const id of ['listen', 'strongest', 'afc', 'record', 'audio-bench']) {
        assert.ok(byId[id].build().nodes.some((n) => n.type === 'iq-in'), id);
    }
});

t('every IQ Demod mode has a template, drawn out in blocks, its decimator on Auto', () => {
    const modes = TEMPLATES.filter((x) => x.id.startsWith('mode-')).map((x) => x.id.slice(5));
    assert.deepStrictEqual(modes.sort(), ['am', 'cwl', 'cwu', 'ecss', 'lsb', 'nfm', 'sam', 'usb']);
    for (const id of modes) {
        const g = byId[`mode-${id}`].build();
        assert.ok(!g.nodes.some((n) => n.type === 'demodulator'), `${id} is one Demodulator block`);
        assert.ok(g.nodes.some((n) => n.type === 'iq-in') && g.nodes.some((n) => n.type === 'audio-out'), id);
        assert.strictEqual(g.nodes.some((n) => n.type === 'carrier-tracker'), id === 'sam' || id === 'ecss', `${id}: carrier tracker`);
        for (const rate of [12000, 192000]) {
            const d = byId[`mode-${id}`].build(rate).nodes.find((n) => n.type === 'decimate');
            assert.ok(d && d.params.auto, `${id} built at ${rate} has no decimator on Auto`);
        }
        // SAM and ECSS are told by wires what the decimator mixed from and
        // where the stream's edges are.
        if (id === 'sam' || id === 'ecss') {
            for (const [out, param] of [['centre', 'baseHz'], ['middle', 'middleHz']]) {
                assert.ok(g.wires.some((w) => w[0] === 'decimate' && w[1] === out && w[2] === 'tracker' && w[3] === controlPort(param)), `${id}: no ${out} wire`);
            }
        }
    }
    const ecss = byId['mode-ecss'].build().nodes.find((n) => n.type === 'carrier-tracker');
    assert.strictEqual(ecss.params.sideband, 'both', 'ECSS starts on the panel’s default sideband');
});

/**
 * A non-directional beacon as received: a carrier that never stops, AM by a
 * tone keyed with `ident` at `wpm`, the ident repeated after `gapSec`, over
 * noise. The sidebands sit `depth / 2` under the carrier — EDN on 341 kHz
 * measured 18 dB down, which is 0.25 here.
 */
function beacon({ ident, toneHz, wpm = 7, gapSec = 6, depth = 0.25, carrierHz = 0, noise = 0.01, rate = RATE }) {
    const dit = (1.2 / wpm) * rate;
    const marks = [];
    let at = rate;
    const add = () => {
        for (const ch of ident) {
            for (const s of MORSE[ch]) {
                const len = (s === '.' ? 1 : 3) * dit;
                marks.push([Math.round(at), Math.round(at + len)]);
                at += len + dit;
            }
            at += 2 * dit;
        }
        at += gapSec * rate;
    };
    let k = 0;
    let m = 0;
    let seed = 5;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    return () => {
        const n = Math.round(rate * 0.02);
        const I = new Float32Array(n);
        const Q = new Float32Array(n);
        for (let j = 0; j < n; j++, k++) {
            while (!marks.length || marks[marks.length - 1][1] <= k) add();
            while (marks[m][1] <= k) m++;
            const on = k >= marks[m][0];
            const t = k / rate;
            const a = 0.05 * (1 + (on ? 2 * depth : 0) * Math.cos(2 * Math.PI * toneHz * t));
            I[j] = a * Math.cos(2 * Math.PI * carrierHz * t) + noise * rnd();
            Q[j] = a * Math.sin(2 * Math.PI * carrierHz * t) + noise * rnd();
        }
        return { i: I, q: Q, frames: n, rate };
    };
}

t('“Decode an NDB ident” reads the ident off the tone, on 400 Hz as loaded and on 1020 Hz once set', () => {
    const read = (graph, opts, secs = 40) => {
        const rt = new Runtime(graph, RATE);
        const next = beacon(opts);
        for (let p = 0; p < 50 * secs; p++) rt.process(next());
        return rt.read('console').text;
    };
    const tpl = byId.ndb.build();
    assert.match(read(tpl, { ident: 'EDN', toneHz: 400 }), /EDN EDN EDN/);
    // A few hertz out, a slow sender, a weak one: as beacons are.
    assert.match(read(tpl, { ident: 'EDN', toneHz: 404, carrierHz: 20, wpm: 5, noise: 0.03 }), /EDN EDN/);
    const tone1020 = byId.ndb.build();
    tone1020.nodes.find((n) => n.id === 'ident').params.offsetHz = 1020;
    assert.match(read(tone1020, { ident: 'GLW', toneHz: 1020, wpm: 10 }), /GLW GLW GLW/);
    // On 400 Hz, a 1020 Hz beacon's ident is not read — a stray E from the
    // noise at most: it is the tone that is read, not the carrier.
    assert.doesNotMatch(read(tpl, { ident: 'GLW', toneHz: 1020 }, 20), /GLW|[^E\s]/);
});

t('each decoder test bench decodes its transmitter, with no receiver', () => {
    for (const mode of ['cw', 'rtty', 'psk', 'navtex']) {
        const g = byId[`bench-${mode}`].build();
        assert.ok(!g.nodes.some((n) => n.type === 'iq-in'), `${mode}: the bench needs a receiver`);
        const rt = new Runtime(g, 48000);
        for (let p = 0; p < 50 * 25; p++) rt.process({ i: null, q: null, frames: 960, rate: 48000 });
        assert.ok(rt.read('console').text.length > 20 && /CQ|ZCZC/.test(rt.read('console').text), `${mode}: ${JSON.stringify(rt.read('console').text)}`);
        // The sent console has the message too.
        const first = TEST_MESSAGES[mode].split('\n')[0];
        assert.ok(rt.read('sent').text.startsWith(first), `${mode}: sent ${JSON.stringify(rt.read('sent').text)}`);
    }
});

t('template ids are unique, and so are the control wires’ ports', () => {
    assert.strictEqual(new Set(TEMPLATES.map((x) => x.id)).size, TEMPLATES.length);
    const afc = byId.afc.build();
    assert.ok(afc.wires.some((w) => w[3] === controlPort('frequencyHz')));
});

console.log(`\n${pass} passed`);
