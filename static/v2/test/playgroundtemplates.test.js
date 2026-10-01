// The templates: each loads, compiles at any rate, runs, and does what its
// summary says it does.

const assert = require('assert');
const { compile, Runtime, TEMPLATES, controlPort } = require('./.build/playground.cjs');

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

t('template ids are unique, and so are the control wires’ ports', () => {
    assert.strictEqual(new Set(TEMPLATES.map((x) => x.id)).size, TEMPLATES.length);
    const afc = byId.afc.build();
    assert.ok(afc.wires.some((w) => w[3] === controlPort('frequencyHz')));
});

console.log(`\n${pass} passed`);
