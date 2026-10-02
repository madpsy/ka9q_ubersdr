// The Scheduler, the IQ stream block retuning the receiver, choice settings
// driven by messages (a Demodulator's mode), and the beacon monitor following
// the receiver round the bands.

const assert = require('assert');
const {
    BLOCK_BY_TYPE, makeBuffer, sanitizeParams, choiceFrom, controlPort, inputsOf,
    parseSchedule, parseScheduleFrequency, ncdxfFollowSchedule, beaconAt, NCDXF_BEACONS, NCDXF_BANDS,
    Runtime, GRAPH_VERSION, parseGraph, compile, createWorkerCore, TEMPLATES,
} = require('./.build/playgroundsched.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};
const graph = (nodes, wires) => parseGraph({ v: GRAPH_VERSION, nodes, wires }).graph;

// ── the schedule text ───────────────────────────────────────────────────────

t('frequencies: a point under 1000 is MHz, under 100000 kHz, else Hz — or as the unit says', () => {
    assert.strictEqual(parseScheduleFrequency('14.100'), 14100000);
    assert.strictEqual(parseScheduleFrequency('14100'), 14100000);
    assert.strictEqual(parseScheduleFrequency('7074000'), 7074000);
    assert.strictEqual(parseScheduleFrequency('8.0405MHz'), 8040500);
    assert.strictEqual(parseScheduleFrequency('518kHz'), 518000);
    assert.strictEqual(parseScheduleFrequency('5000Hz'), 5000);
    assert.strictEqual(parseScheduleFrequency('fourteen'), null);
});

t('schedule lines: time, frequency, mode, width= and offset=, a label; comments; sorted; errors by line', () => {
    const { entries, errors } = parseSchedule([
        '# the net',
        '1:00 7.074 USB width=2400 FT8 window',
        '0:00 14.100 cw offset=-700 NCDXF',
        '0:30 - lsb',
        'soon 14.2',
        '2:00 nowhere',
    ].join('\n'));
    assert.deepStrictEqual(entries.map((e) => [e.at, e.frequency, e.mode, e.width, e.offset, e.label]), [
        [0, 14100000, 'cwu', null, -700, 'NCDXF'],
        [30, null, 'lsb', null, null, ''],
        [60, 7074000, 'usb', 2400, null, 'FT8 window'],
    ]);
    assert.deepStrictEqual(errors.map((e) => e.line), [5, 6]);
    const daily = parseSchedule('09:30 8.0405 usb Northwood\n21:45:30 4.610 usb', 'daily').entries;
    assert.deepStrictEqual(daily.map((e) => e.at), [9 * 3600 + 30 * 60, 21 * 3600 + 45 * 60 + 30]);
    assert.strictEqual(parseSchedule('25:00 8.0405', 'daily').errors.length, 1);
});

t('following an NCDXF beacon: on 14.100 in its own slot and a band higher each slot after, as the beacons move', () => {
    for (const index of [0, 6, 17]) {
        const { entries } = parseSchedule(ncdxfFollowSchedule(index));
        assert.strictEqual(entries.length, 5);
        const T = 1700000000 - (1700000000 % 180);
        for (const e of entries) {
            const band = NCDXF_BANDS.findIndex((b) => b.khz * 1000 === e.frequency);
            assert.ok(band >= 0, String(e.frequency));
            // At the entry's time, that beacon is the one on that band.
            assert.strictEqual(beaconAt(T + e.at, band), index, `${NCDXF_BEACONS[index].call} ${NCDXF_BANDS[band].band}`);
            assert.strictEqual(e.mode, 'cwu');
            assert.ok(e.label.startsWith(NCDXF_BEACONS[index].call));
        }
    }
});

// ── the Scheduler block ─────────────────────────────────────────────────────

/** A Scheduler run over `seconds` of 20 ms packets from Unix time T, its Clock's unix control fed each whole second. */
function runScheduler(params, { T, seconds, tuning = null, pps = false }) {
    const def = BLOCK_BY_TYPE.scheduler;
    const inst = def.create();
    inst.configure(sanitizeParams(def, params), 0);
    if (tuning) inst.feed({ tuning });
    const ctl = { seq: 0, value: null };
    const changes = [];
    const rate = 12000;
    const frames = 240;
    for (let k = 0; k < (seconds * rate) / frames; k++) {
        const a = T + (k * frames) / rate;
        const b = T + ((k + 1) * frames) / rate;
        let ppsBuf = null;
        if (Math.floor(b) > Math.floor(a)) {
            ctl.seq++; ctl.value = Math.floor(b);
            if (pps) {
                ppsBuf = makeBuffer('real', frames); ppsBuf.n = frames;
                const at = Math.round((Math.floor(b) - a) * rate);
                for (let j = at; j < Math.min(frames, at + 24); j++) ppsBuf.re[j] = 1;
            }
        }
        const outs = def.outputs.map((o) => makeBuffer(o.kind, 1));
        inst.process([ctl, ppsBuf], outs, 0, { frames, rate });
        const got = {};
        def.outputs.forEach((o, i) => {
            if (o.kind === 'control' && outs[i].seq > 0) got[o.name] = outs[i].value;
            if (o.kind === 'message' && outs[i].list.length) got[o.name] = outs[i].list.map((m) => m.text).join('');
        });
        if (Object.keys(got).length) changes.push({ at: b - T, ...got });
    }
    return { inst, changes };
}

t('Scheduler: each entry at its time into the cycle, with its mode, width and offset; round the cycle again', () => {
    const T = 1700000000 - (1700000000 % 60) + 5; // 5 s into a minute
    const { changes, inst } = runScheduler({ kind: 'repeat', period: 60, schedule: '0:00 14.100 usb width=2700 Twenty\n0:20 7.074 lsb offset=500\n0:40 10.136 cw' }, { T, seconds: 70 });
    // In force at the start (the first entry, from 0:00), then 0:20, 0:40, 1:00 again.
    assert.deepStrictEqual(changes.map((c) => c.frequency), [14100000, 7074000, 10136000, 14100000]);
    assert.deepStrictEqual(changes.map((c) => c.mode), ['usb', 'lsb', 'cwu', 'usb']);
    assert.strictEqual(changes[0].width, 2700);
    assert.strictEqual(changes[1].offset, 500);
    assert.strictEqual(changes[0].label, 'Twenty\n');
    // On time, to a packet: 15 s, 35 s and 55 s after starting 5 s in.
    for (const [i, want] of [[1, 15], [2, 35], [3, 55]]) assert.ok(Math.abs(changes[i].at - want) <= 0.5, `change ${i} at ${changes[i].at}`);
    assert.strictEqual(inst.read().why, '');
    assert.strictEqual(inst.read().current, 0);
});

t('Scheduler: a pps puts the change on the pulse’s edge, to the sample’s packet', () => {
    const T = 1700000000 - (1700000000 % 60) + 9.95;
    const { changes } = runScheduler({ kind: 'repeat', period: 60, schedule: '0:00 14.100\n0:10 18.110' }, { T, seconds: 1, pps: true });
    // Nothing until the Clock speaks, on the second — and then the entry from 0:10.
    assert.deepStrictEqual(changes.map((c) => c.frequency), [18110000]);
    assert.ok(Math.abs(changes[0].at - 0.05) < 0.021, `at ${changes[0].at}`);
});

t('Scheduler: entries outside the receiver’s range are marked and skipped, the one before holding', () => {
    const T = 1700000000 - (1700000000 % 180);
    const { changes, inst } = runScheduler({ preset: 'ncdxf', beacon: 0 }, { T, seconds: 60, tuning: { frequency: 14100000, min: 10000, max: 20000000 } });
    // 4U1UN: 14.100 at 0:00, 18.110 at 0:10, then 21.150, 24.930, 28.200 — out of a 20 MHz receiver's reach.
    assert.deepStrictEqual(changes.map((c) => c.frequency), [14100000, 18110000]);
    const r = inst.read();
    assert.deepStrictEqual(r.entries.map((e) => e.reachable), [true, true, false, false, false]);
    assert.ok(/3 entries are outside/.test(r.skipped), r.skipped);
});

t('Scheduler: daily times in UTC, the last of the day before holding until the first', () => {
    const day = 1700000000 - (1700000000 % 86400);
    const { changes } = runScheduler({ kind: 'daily', schedule: '09:30 8.0405 usb Fax\n09:31 4.610 usb' }, { T: day + 9 * 3600 + 29 * 60 + 58, seconds: 64 });
    assert.deepStrictEqual(changes.map((c) => c.frequency), [4610000, 8040500, 4610000]);
});

t('Scheduler without a Clock: on this device’s clock, and says so', () => {
    const def = BLOCK_BY_TYPE.scheduler;
    const inst = def.create();
    inst.configure(sanitizeParams(def, { kind: 'repeat', period: 10, schedule: '0 14.1' }), 0);
    const outs = def.outputs.map((o) => makeBuffer(o.kind, 1));
    inst.process([null, null], outs, 0, { frames: 240, rate: 12000 });
    assert.strictEqual(outs[0].value, 14100000);
    assert.ok(/device/.test(inst.read().why));
});

// ── the IQ stream block ─────────────────────────────────────────────────────

t('IQ stream: a frequency in range asks to retune (once per new value); out of range is refused and said; tuned reports the receiver', () => {
    const def = BLOCK_BY_TYPE['iq-in'];
    const inst = def.create();
    inst.configure(sanitizeParams(def, {}), 12000);
    inst.feed({ tuning: { frequency: 7000000, min: 10000, max: 30000000 } });
    const run = (ctl) => {
        const outs = def.outputs.map((o) => makeBuffer(o.kind, 240));
        inst.process([ctl], outs, 240, { i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: 12000 });
        return outs;
    };
    let o = run(null);
    assert.strictEqual(o[1].value, 7000000);
    o = run({ seq: 1, value: 14100000 });
    assert.deepStrictEqual(inst.drainEvents(), [{ type: 'tune', frequency: 14100000 }]);
    run({ seq: 1, value: 14100000 });
    run({ seq: 2, value: 14100000 });
    assert.deepStrictEqual(inst.drainEvents(), [], 'the same frequency again is not asked again');
    run({ seq: 3, value: 50000000 });
    assert.deepStrictEqual(inst.drainEvents(), []);
    assert.ok(/50 MHz is outside this receiver’s 0\.01–30 MHz/.test(inst.read().why), inst.read().why);
    // The receiver moved (the page says): tuned follows.
    inst.feed({ tuning: { frequency: 14100000, min: 10000, max: 30000000 } });
    o = run({ seq: 4, value: 18110000 });
    assert.strictEqual(o[1].value, 14100000);
    assert.strictEqual(inst.read().why, '');
});

t('the worker passes a retune out, and the receiver’s tuning in to the blocks that ask', () => {
    const posted = [];
    const core = createWorkerCore((m) => posted.push(m), () => 0);
    core.onMessage({
        t: 'graph', rate: 12000,
        graph: {
            v: GRAPH_VERSION,
            nodes: [{ id: 'sched', type: 'scheduler', params: { kind: 'repeat', period: 60, schedule: '0 14.100\n0:30 50' } }, { id: 'iq', type: 'iq-in' }],
            wires: [['sched', 'frequency', 'iq', 'frequency']],
        },
    });
    assert.ok(posted.find((m) => m.t === 'status').ok, JSON.stringify(posted));
    const tuning = { frequency: 7000000, min: 10000, max: 30000000 };
    for (let k = 0; k < 3; k++) core.onMessage({ t: 'packet', seq: k, i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: 12000, tuning });
    const tunes = posted.filter((m) => m.t === 'out' && m.tune).map((m) => m.tune);
    // 14.100 (or 50 kHz, from 0:30 — inside a 10 kHz–30 MHz range: kHz below 100000).
    assert.strictEqual(tunes.length, 1, JSON.stringify(tunes));
    assert.ok(tunes[0] === 14100000 || tunes[0] === 50000, String(tunes[0]));
});

// ── choice settings driven by messages ──────────────────────────────────────

t('a choice names its option by value or label, any case; anything else chooses nothing', () => {
    const spec = BLOCK_BY_TYPE.demodulator.params.mode;
    assert.strictEqual(choiceFrom(spec, { type: 'text', text: 'LSB' }), 'lsb');
    assert.strictEqual(choiceFrom(spec, { value: 'cwu' }), 'cwu');
    const cw = spec.options.find((o) => o.value === 'cwu');
    assert.strictEqual(choiceFrom(spec, { text: ` ${cw.label.toUpperCase()} ` }), 'cwu');
    assert.strictEqual(choiceFrom(spec, { text: 'wideband voice' }), undefined);
    // Exposed, a choice is a message input; a number stays a control.
    const node = { id: 'd', type: 'demodulator', params: {}, controls: ['mode', 'widthHz'] };
    const ports = inputsOf(node, BLOCK_BY_TYPE.demodulator).filter((p) => p.param);
    assert.deepStrictEqual(ports.map((p) => [p.name, p.kind]), [[controlPort('mode'), 'message'], [controlPort('widthHz'), 'control']]);
});

t('a Demodulator’s mode and width driven from a Scheduler, and kept across a rebuild; unwired, the operator’s again', () => {
    const g = graph(
        [
            { id: 'iq', type: 'iq-in' },
            { id: 'sched', type: 'scheduler', params: { kind: 'repeat', period: 60, schedule: '0 14.1 lsb width=2400' } },
            { id: 'demod', type: 'demodulator', params: { mode: 'usb', widthHz: 2700 }, controls: ['mode', 'widthHz'] },
            { id: 'meter', type: 'meter' },
        ],
        [['sched', 'mode', 'demod', controlPort('mode')], ['sched', 'width', 'demod', controlPort('widthHz')], ['iq', 'out', 'demod', 'in'], ['demod', 'audio', 'meter', 'in']],
    );
    const rate = 12000;
    const rt = new Runtime(g, rate);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    const pkt = () => rt.process({ i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate });
    for (let k = 0; k < 4; k++) pkt();
    assert.deepStrictEqual(rt.driven().demod, { mode: 'lsb', widthHz: 2400 });
    // A rebuild (the operator adding something) keeps what was driven — the
    // mode came by message, one packet's, so it has to be remembered.
    rt.setGraph(g);
    assert.deepStrictEqual(rt.driven().demod, { mode: 'lsb', widthHz: 2400 });
    for (let k = 0; k < 4; k++) assert.ok(pkt());
    const loose = graph(g.nodes, g.wires.filter((w) => w[0] !== 'sched'));
    rt.setGraph(loose);
    assert.deepStrictEqual(rt.driven(), {});
});

t('a driven choice that moves a block’s rate (a PSK slicer, BPSK → QPSK) has the graph planned again with it in force', () => {
    const g = graph(
        [
            { id: 'iq', type: 'iq-in' },
            { id: 'sched', type: 'scheduler', params: { kind: 'repeat', period: 60, schedule: '0 14.1 QPSK' } },
            { id: 'slicer', type: 'psk-slicer', params: { mode: 'dbpsk' }, controls: ['mode'] },
            { id: 'bits', type: 'bit-view' },
        ],
        [['sched', 'label', 'slicer', controlPort('mode')], ['iq', 'out', 'slicer', 'in'], ['slicer', 'bits', 'bits', 'in']],
    );
    const rate = 12000;
    const rt = new Runtime(g, rate);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    assert.strictEqual(rt.plan.outRate.slicer, rate);
    for (let k = 0; k < 3; k++) rt.process({ i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate });
    assert.strictEqual(rt.driven().slicer.mode, 'qpsk');
    assert.strictEqual(rt.plan.outRate.slicer, 2 * rate, 'two bits a symbol');
    assert.strictEqual(rt.plan.inRate.bits, 2 * rate);
});

// ── the beacon monitor following the receiver ───────────────────────────────

t('beacon monitor “from the tuning”: following 4U1UN round the bands, it judges each slot on the band it was on, and logs where it was heard', () => {
    const rate = 4000;
    const T = 1700000000 - (1700000000 % 180);
    const def = BLOCK_BY_TYPE['beacon-monitor'];
    const inst = def.create();
    inst.configure(sanitizeParams(def, { band: -1, toneHz: 700 }), rate);
    const { entries } = parseSchedule(ncdxfFollowSchedule(0));
    // Heard on 20 m and 15 m, not on 17, 12 or 10.
    const loudOn = new Set([14100000, 21150000]);
    let s = 9;
    const g = () => { s = (s * 16807) % 2147483647; const u = s / 2147483647; s = (s * 16807) % 2147483647; return Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * s / 2147483647); };
    const ctl = { seq: 0, value: null };
    const tuned = { seq: 0, value: null };
    const texts = [];
    let ph = 0;
    const P = 320;
    for (let k0 = 0; k0 < 360 * rate; k0 += P) {
        const now = T + k0 / rate;
        // Where the Scheduler has the receiver, 0.2 s late (a retune takes time).
        const ph180 = ((now - 0.2) % 180 + 180) % 180;
        let f = entries[entries.length - 1].frequency;
        for (const e of entries) if (e.at <= ph180) f = e.frequency;
        if (f !== tuned.value) { tuned.seq++; tuned.value = f; }
        const x = makeBuffer('real', P);
        for (let k = 0; k < P; k++) {
            const tt = now + k / rate;
            const into = tt % 10;
            const on = beaconAt(tt, NCDXF_BANDS.findIndex((b) => b.khz * 1000 === f)) === 0;
            const amp = on && loudOn.has(f) && into > 0.3 && into < 9.3 ? 0.3 : 0;
            ph += (2 * Math.PI * 700) / rate;
            x.re[k] = amp * Math.sin(ph) + 0.05 * g();
        }
        x.n = P;
        const b = now + P / rate;
        if (Math.floor(b) > Math.floor(now)) { ctl.seq++; ctl.value = Math.floor(b); }
        const outs = def.outputs.map((o) => makeBuffer(o.kind, 1));
        inst.process([x, ctl, tuned], outs, P);
        for (const e of outs[0].list) texts.push(e.text);
    }
    const all = texts.join('');
    assert.ok(/20m 4U1UN/.test(all) && /15m 4U1UN/.test(all), all);
    assert.ok(!/17m|12m|10m/.test(all), all);
    // Never another beacon: the receiver only ever sat on 4U1UN's slots.
    assert.ok(texts.every((x) => x.includes('4U1UN')), all);
    const r = inst.read();
    const judged = r.heard.filter((h) => h.call === '4U1UN').map((h) => h.band).sort();
    assert.deepStrictEqual(judged, ['10m', '12m', '15m', '17m', '20m']);
});

t('the band-hopping template compiles, drives the receiver and the Demodulator’s mode, and its monitor follows the tuning', () => {
    const tpl = TEMPLATES.find((x) => x.id === 'beacon-hop');
    const g = tpl.build();
    assert.ok(compile(g, 12000).ok, JSON.stringify(compile(g, 12000).errors));
    const has = (w) => g.wires.some((x) => x.join() === w.join());
    assert.ok(has(['schedule', 'frequency', 'iq', 'frequency']));
    assert.ok(has(['schedule', 'mode', 'demod', controlPort('mode')]));
    assert.ok(has(['iq', 'tuned', 'beacons', 'tuned']));
    assert.strictEqual(g.nodes.find((n) => n.id === 'beacons').params.band, -1);
});

// ── lists, in turn ──────────────────────────────────────────────────────────

const NDBS = '380kHz am offset=400 CBL Campbeltown\n394kHz am offset=400 DND Dundee\n341kHz am offset=400 EDN Edinburgh';

t('in turn, lines need no time; one given is ignored, the order kept', () => {
    const { entries, errors } = parseSchedule(NDBS + '\n0:10 355kHz am PIK Prestwick', 'dwell');
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(entries.map((e) => [e.frequency, e.mode, e.offset, e.label]), [
        [380000, 'am', 400, 'CBL Campbeltown'], [394000, 'am', 400, 'DND Dundee'], [341000, 'am', 400, 'EDN Edinburgh'], [355000, 'am', null, 'PIK Prestwick'],
    ]);
});

/** A Frequency list into a Scheduler, by hand, for `seconds` of 20 ms packets; `nextAt` the seconds a next arrives. */
function runList(listParams, schedParams, seconds, nextAt = [], T = null) {
    const L = BLOCK_BY_TYPE['frequency-list'];
    const S = BLOCK_BY_TYPE.scheduler;
    const li = L.create();
    li.configure(sanitizeParams(L, listParams), 0);
    const si = S.create();
    si.configure(sanitizeParams(S, schedParams), 0);
    const next = { seq: 0, value: null };
    const changes = [];
    const frames = 240;
    const rate = 12000;
    for (let k = 0; k < (seconds * rate) / frames; k++) {
        const at = (k * frames) / rate;
        if (nextAt.some((x) => Math.abs(x - at) < 0.01)) { next.seq++; next.value = 1; }
        let unix = null;
        let pps = null;
        if (T != null) {
            // A Clock: its unix each whole second, and a pulse on the second's edge.
            const a = T + at;
            const b = T + at + frames / rate;
            unix = runList.ctl || (runList.ctl = { seq: 0, value: null });
            pps = makeBuffer('real', frames); pps.n = frames;
            if (Math.floor(b) > Math.floor(a)) {
                unix.seq++; unix.value = Math.floor(b);
                const edge = Math.round((Math.floor(b) - a) * rate);
                for (let j = edge; j < Math.min(frames, edge + 24); j++) pps.re[j] = 1;
            }
        }
        const lo = L.outputs.map((o) => makeBuffer(o.kind, 1));
        li.process([], lo, 0);
        const outs = S.outputs.map((o) => makeBuffer(o.kind, 1));
        si.process([unix, pps, lo[0], next], outs, 0, { frames, rate });
        if (outs[0].seq > 0) changes.push({ at, frequency: outs[0].value, offset: outs[3].seq > 0 ? outs[3].value : null, label: outs[4].list.map((m) => m.text).join('') });
    }
    return { changes, si };
}

t('a Frequency list worked in turn, 30 s on each, round again — frequency, offset and name each time', () => {
    runList.ctl = null;
    const { changes, si } = runList({ entries: NDBS }, { preset: 'input', kind: 'dwell', dwell: 30 }, 100);
    assert.deepStrictEqual(changes.map((c) => c.frequency), [380000, 394000, 341000, 380000]);
    assert.deepStrictEqual(changes.map((c) => Math.round(c.at)), [0, 30, 60, 90]);
    assert.ok(changes.every((c) => c.offset === 400));
    assert.strictEqual(changes[1].label, 'DND Dundee\n');
    const r = si.read();
    assert.strictEqual(r.fromList, true);
    assert.strictEqual(r.listWired, true);
    assert.strictEqual(r.why, '', 'in turn needs no Clock');
    assert.strictEqual(r.entries.length, 3);
});

t('next moves on at once, and the 30 s starts again from there', () => {
    const { changes } = runList({ entries: NDBS }, { preset: 'input', kind: 'dwell', dwell: 30 }, 50, [5]);
    assert.deepStrictEqual(changes.map((c) => [Math.round(c.at), c.frequency]), [[0, 380000], [5, 394000], [35, 341000]]);
});

t('in turn, aligned to the clock: hops on :00 and :30 to the pulse’s edge, each entry the time’s to say; next still moves on', () => {
    const T = 1700000000 - (1700000000 % 90) + 20.5; // 20.5 s into a 90 s round of three
    runList.ctl = null;
    const { changes, si } = runList({ entries: NDBS }, { preset: 'input', kind: 'dwell', dwell: 30, align: true }, 75, [], T);
    // Waits for the Clock (half a second), then the entry for that half minute: period number mod 3.
    const period = (x) => Math.floor(x / 30);
    const want = (x) => [380000, 394000, 341000][((period(x) % 3) + 3) % 3];
    assert.deepStrictEqual(changes.map((c) => c.frequency), [want(T + 1), want(T + 10), want(T + 40), want(T + 70)]);
    // On the half minutes, to the packet: 9.5, 39.5 and 69.5 s after starting 20.5 s in.
    for (const [i, x] of [[1, 9.5], [2, 39.5], [3, 69.5]]) assert.ok(Math.abs(changes[i].at - x) < 0.021, `hop ${i} at ${changes[i].at}`);
    assert.strictEqual(si.read().why, '');
    // Without a Clock, aligned, it says it is on the device's.
    runList.ctl = null;
    assert.ok(/device/.test(runList({ entries: NDBS }, { preset: 'input', kind: 'dwell', dwell: 30, align: true }, 1).si.read().why));
    // next: one entry on, and the hops stay on the half minutes.
    runList.ctl = null;
    const moved = runList({ entries: NDBS }, { preset: 'input', kind: 'dwell', dwell: 30, align: true }, 45, [3], T).changes;
    assert.strictEqual(moved[1].frequency, [380000, 394000, 341000][(((period(T + 3) + 1) % 3) + 3) % 3]);
    assert.ok(Math.abs(moved[2].at - 9.5) < 0.021, `after next, hop at ${moved[2].at}`);
});

t('the NDB template: through the worker, the receiver retuned to each NDB every 30 s, the decoder moved to each one’s tone', () => {
    const tpl = TEMPLATES.find((x) => x.id === 'ndb-hop');
    const full = tpl.build();
    assert.ok(compile(full, 12000).ok, JSON.stringify(compile(full, 12000).errors));
    // On the clock, the template: its Clock's unix and pps into the Scheduler, aligned.
    const has = (w) => full.wires.some((x) => x.join() === w.join());
    assert.ok(has(['clock', 'unix', 'schedule', 'unix']) && has(['clock', 'pps', 'schedule', 'pps']));
    assert.strictEqual(full.nodes.find((n) => n.id === 'schedule').params.align, true);
    // Run here by the stream's own time — the same graph unaligned, without its
    // Clock, so when it hops does not depend on the time of day the test runs.
    const g = {
        ...full,
        nodes: full.nodes.filter((n) => n.id !== 'clock').map((n) => (n.id === 'schedule' ? { ...n, params: { ...n.params, align: false } } : n)),
        wires: full.wires.filter((w) => w[0] !== 'clock'),
    };
    const posted = [];
    const core = createWorkerCore((m) => posted.push(m), () => 0);
    core.onMessage({ t: 'graph', rate: 12000, graph: g });
    assert.ok(posted.find((m) => m.t === 'status').ok);
    const tuning = { frequency: 7000000, min: 10000, max: 30000000 };
    const tunes = [];
    for (let k = 0; k < 65 * 50; k++) {
        const before = posted.length;
        core.onMessage({ t: 'packet', seq: k, i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: 12000, tuning });
        for (const m of posted.slice(before)) if (m.t === 'out' && m.tune) tunes.push([Math.round(k / 50), m.tune]);
    }
    assert.deepStrictEqual(tunes, [[0, 380000], [30, 394000], [60, 341000]]);
});

t('Running off: nothing sent while stopped; started again, the entry in force sent at once', () => {
    const S = BLOCK_BY_TYPE.scheduler;
    const si = S.create();
    const params = { kind: 'dwell', dwell: 30, schedule: '380kHz am CBL\n394kHz am DND' };
    si.configure(sanitizeParams(S, params), 0);
    const step = () => {
        const outs = S.outputs.map((o) => makeBuffer(o.kind, 1));
        si.process([null, null, null, null], outs, 0, { frames: 240, rate: 12000 });
        return outs[0].seq > 0 ? outs[0].value : null;
    };
    assert.strictEqual(step(), 380000);
    assert.strictEqual(si.activity(), 1);
    si.configure(sanitizeParams(S, { ...params, running: false }), 0);
    for (let k = 0; k < 50 * 40; k++) assert.strictEqual(step(), null, 'sent while stopped');
    assert.strictEqual(si.read().running, false);
    assert.strictEqual(si.activity(), 0);
    si.configure(sanitizeParams(S, { ...params, running: true }), 0);
    assert.ok(step() != null, 'nothing sent on starting again');
    assert.strictEqual(si.read().running, true);
});

t('a list with no times, for a Scheduler set to a cycle: nothing sent, and one plain hint why', () => {
    runList.ctl = null;
    const { changes, si } = runList({ entries: NDBS }, { preset: 'input', kind: 'repeat' }, 2);
    assert.deepStrictEqual(changes, []);
    assert.ok(/No times on these lines — set Timing to “In turn”/.test(si.read().hint), si.read().hint);
});

// ── matching and the status board ───────────────────────────────────────────

/** One block's instance, and a step that runs it on message lists by input name. */
function blockOf(type, params = {}) {
    const def = BLOCK_BY_TYPE[type];
    const inst = def.create();
    inst.configure(sanitizeParams(def, params), 12000);
    const ctl = {};
    const step = (byName = {}) => {
        const ins = def.inputs.map((port) => {
            const v = byName[port.name];
            if (v == null) return byName.__wired && byName.__wired.includes(port.name) ? { kind: 'message', list: [] } : null;
            if (port.kind === 'control') { ctl[port.name] = ctl[port.name] || { seq: 0, value: null }; ctl[port.name].seq++; ctl[port.name].value = v; return ctl[port.name]; }
            return { kind: 'message', list: (Array.isArray(v) ? v : [v]).map((t) => (typeof t === 'string' ? { type: 'text', text: t } : t)) };
        });
        const outs = def.outputs.map((o) => makeBuffer(o.kind, 1));
        inst.process(ins, outs, 0, { frames: 240, rate: 12000 });
        const got = {};
        def.outputs.forEach((o, i) => { got[o.name] = o.kind === 'control' ? (outs[i].seq > 0 ? outs[i].value : null) : outs[i].list; });
        return got;
    };
    return { inst, step };
}

t('console: matching the first word of a label, only the matched words shown, each sent on matched', () => {
    const c = blockOf('console');
    c.step({ match: 'CBL Campbeltown\n', in: 'E T CBL TT ' });
    let r = c.inst.read();
    assert.strictEqual(r.matching, 'CBL');
    assert.strictEqual(r.matches, 1);
    assert.ok(/\d\d:\d\d:\d\d {2}CBL\n$/.test(r.text) && !/TT/.test(r.text), JSON.stringify(r.text));
    // Glued to noise, still a match; a wrong letter is not, unless allowed.
    let out = c.step({ __wired: ['match'], in: 'ECBL CBI ' });
    assert.deepStrictEqual(out.matched.map((m) => m.heard), ['ECBL']);
    const f = blockOf('console', { fuzzy: true });
    f.step({ match: 'CBL', in: '' });
    out = f.step({ __wired: ['match'], in: 'CBI XYZ ' });
    assert.deepStrictEqual(out.matched.map((m) => [m.text, m.heard, m.exact]), [['CBL', 'CBI', false]]);
    assert.ok(/CBI \(CBL\?\)/.test(f.inst.read().text));
    // A new label: a new word watched for.
    c.step({ match: 'DND Dundee', in: '' });
    assert.strictEqual(c.inst.read().matching, 'DND');
    // Showing everything while still matching.
    const all = blockOf('console', { onlyMatches: false });
    all.step({ match: 'EDN', in: 'QQ EDN QQ ' });
    assert.ok(/QQ EDN QQ/.test(all.inst.read().text));
    assert.strictEqual(all.inst.read().matches, 1);
    // Whole text, spacing aside.
    const whole = blockOf('console', { matchOn: 'all' });
    out = whole.step({ match: 'CQ DE M9PSY', in: 'XX CQ  DE M9PSY K' });
    assert.strictEqual(out.matched.length, 1);
    // Nothing wired to match: a console as it always was.
    const plain = blockOf('console');
    plain.step({ in: 'HELLO ' });
    assert.strictEqual(plain.inst.read().text, 'HELLO ');
    assert.strictEqual(plain.inst.read().matching, null);
});

t('Frequency list: labels, every entry’s name, for a board', () => {
    const l = blockOf('frequency-list', { entries: NDBS });
    const out = l.step({});
    assert.deepStrictEqual(out.labels[0].items, ['CBL Campbeltown', 'DND Dundee', 'EDN Edinburgh']);
});

t('Status: every item from the list; each settled heard or not as the next comes; history, summary, a line each, heard as a control', () => {
    const st = blockOf('status');
    st.step({ items: { type: 'items', items: ['CBL Campbeltown', 'DND Dundee', 'EDN Edinburgh'] }, unix: 1700000000 });
    let r = st.inst.read();
    assert.deepStrictEqual(r.rows.map((x) => [x.key, x.state]), [['CBL', 'pending'], ['DND', 'pending'], ['EDN', 'pending']]);
    st.step({ current: 'CBL Campbeltown\n' });
    st.step({ hit: { type: 'text', text: 'CBL' } });
    assert.strictEqual(st.inst.read().rows[0].state, 'listening');
    assert.strictEqual(st.inst.read().rows[0].hits, 1);
    let out = st.step({ current: 'DND Dundee\n' });
    assert.deepStrictEqual(out.text.map((m) => m.text.slice(9)), ['CBL heard\n']);
    assert.strictEqual(out.heard, 1);
    out = st.step({ current: 'EDN Edinburgh' });
    assert.deepStrictEqual(out.text.map((m) => m.text.slice(9)), ['DND not heard\n']);
    assert.strictEqual(out.heard, 0);
    st.step({ current: 'CBL Campbeltown' });
    r = st.inst.read();
    assert.deepStrictEqual(r.rows.map((x) => [x.key, x.state, x.history.join('')]), [['CBL', 'listening', '1'], ['DND', 'missed', '0'], ['EDN', 'missed', '0']]);
    assert.strictEqual(r.current, 'CBL');
    assert.strictEqual(r.summary, '0 of 3 heard · listening to CBL', 'CBL heard last round, not yet this one');
    assert.ok(r.rows[0].lastHeard === 1700000000 * 1000, 'heard at the Clock’s time');
    assert.strictEqual(st.inst.activity(), 1);
    // Clear: every thing back to not checked, its times and history gone; the current one still listened for.
    st.inst.command('clear');
    r = st.inst.read();
    assert.deepStrictEqual(r.rows.map((x) => [x.key, x.state, x.history.length, x.lastHeard]), [['CBL', 'listening', 0, null], ['DND', 'pending', 0, null], ['EDN', 'pending', 0, null]]);
});

t('the NDB template wires the match and the board: label → console match and Status current, matched → hit, labels → items', () => {
    const g = TEMPLATES.find((x) => x.id === 'ndb-hop').build();
    assert.ok(compile(g, 12000).ok, JSON.stringify(compile(g, 12000).errors));
    const has = (w) => g.wires.some((x) => x.join() === w.join());
    for (const w of [['schedule', 'label', 'idents', 'match'], ['idents', 'matched', 'heard', 'hit'], ['schedule', 'label', 'heard', 'current'], ['ndbs', 'labels', 'heard', 'items'], ['heard', 'text', 'log', 'in']]) {
        assert.ok(has(w), w.join(' '));
    }
});

t('Status takes a Frequency list’s list output as well as its labels', () => {
    const st = blockOf('status');
    st.step({ items: { type: 'schedule', schedule: NDBS } });
    assert.deepStrictEqual(st.inst.read().rows.map((x) => x.key), ['CBL', 'DND', 'EDN']);
});

t('Status forgets “last heard” after its time (5 minutes unless set); 0 keeps it', () => {
    for (const [forgetMin, kept] of [[5, false], [0, true], [20, true]]) {
        const st = blockOf('status', { forgetMin });
        const T = 1700000000;
        st.step({ items: { type: 'items', items: ['CBL', 'DND'] }, current: 'CBL', unix: T });
        st.step({ hit: 'CBL', unix: T + 1 });
        st.step({ current: 'DND', unix: T + 30 });
        assert.strictEqual(st.inst.read().rows[0].lastHeard, (T + 1) * 1000);
        st.step({ unix: T + 6 * 60 });
        const r = st.inst.read().rows[0];
        assert.strictEqual(r.lastHeard != null, kept, `forget after ${forgetMin} min`);
        assert.strictEqual(r.state, 'heard', 'the round’s result is not forgotten');
        assert.deepStrictEqual(r.history, [1]);
    }
});

t('Status: the one listened for counts as heard the moment it is, not only when the Scheduler moves on', () => {
    const st = blockOf('status');
    st.step({ items: { type: 'items', items: ['CBL', 'DND'] }, current: 'CBL' });
    assert.strictEqual(st.inst.read().summary, '0 of 2 heard · listening to CBL · 1 not checked yet');
    let out = st.step({ hit: 'CBL' });
    assert.deepStrictEqual(out.summary.map((m) => m.text), ['1 of 2 heard · 1 not checked yet']);
    st.step({ current: 'DND' });
    out = st.step({ hit: 'DND' });
    assert.deepStrictEqual(out.summary.map((m) => m.text), ['2 of 2 heard']);
    // Round two: CBL, heard last round but not yet this one, is not counted as heard.
    st.step({ current: 'CBL' });
    assert.strictEqual(st.inst.read().summary, '1 of 2 heard · listening to CBL');
    st.step({ hit: 'CBL' });
    assert.strictEqual(st.inst.read().summary, '2 of 2 heard');
    // Moved on unheard: settled not heard.
    st.step({ current: 'DND' });
    st.step({ current: 'CBL' });
    assert.strictEqual(st.inst.read().summary, '0 of 2 heard · listening to CBL');
});

t('Frequency list as a preset picker: the chosen entry’s frequency, mode, offset, label and number; chosen by setting or by name/number on select', () => {
    const l = blockOf('frequency-list', { entries: NDBS });
    let out = l.step({});
    assert.deepStrictEqual([out.frequency, out.mode.map((m) => m.value)[0], out.offset, out.label[0].text, out.index], [380000, 'am', 400, 'CBL Campbeltown\n', 1]);
    // Nothing sent again while nothing changes.
    out = l.step({});
    assert.strictEqual(out.frequency, null);
    // By name, first word or whole; by number.
    out = l.step({ select: 'DND' });
    assert.strictEqual(out.frequency, 394000);
    out = l.step({ select: 'EDN Edinburgh' });
    assert.strictEqual(out.frequency, 341000);
    out = l.step({ select: '1' });
    assert.strictEqual(out.frequency, 380000);
    out = l.step({ select: 'nowhere' });
    assert.strictEqual(out.frequency, null, 'a name not on the list changes nothing');
    // The setting (a click on the card) wins over an earlier select.
    l.inst.configure(sanitizeParams(BLOCK_BY_TYPE['frequency-list'], { entries: NDBS, select: 3 }), 12000);
    out = l.step({});
    assert.strictEqual(out.frequency, 341000);
    assert.strictEqual(l.inst.read().selected, 2);
});

t('a Frequency list wired straight to the IQ stream compiles, and through the worker retunes the receiver to the chosen entry', () => {
    const posted = [];
    const core = createWorkerCore((m) => posted.push(m), () => 0);
    core.onMessage({
        t: 'graph', rate: 12000,
        graph: {
            v: GRAPH_VERSION,
            nodes: [{ id: 'l', type: 'frequency-list', params: { entries: NDBS, select: 2 } }, { id: 'iq', type: 'iq-in' }],
            wires: [['l', 'frequency', 'iq', 'frequency']],
        },
    });
    assert.ok(posted.find((m) => m.t === 'status').ok);
    const tuning = { frequency: 7000000, min: 10000, max: 30000000 };
    for (let k = 0; k < 3; k++) core.onMessage({ t: 'packet', seq: k, i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: 12000, tuning });
    assert.deepStrictEqual(posted.filter((m) => m.t === 'out' && m.tune).map((m) => m.tune), [394000]);
});

t('the SSTV template tunes by a Frequency list: 14.230 MHz chosen, frequency to the IQ stream, mode to the Demodulator', () => {
    const g = TEMPLATES.find((x) => x.id === 'sstv').build();
    assert.ok(compile(g, 12000).ok, JSON.stringify(compile(g, 12000).errors));
    const has = (w) => g.wires.some((x) => x.join() === w.join());
    assert.ok(has(['freqs', 'frequency', 'iq', 'frequency']) && has(['freqs', 'mode', 'demod', controlPort('mode')]));
    const l = blockOf('frequency-list', g.nodes.find((n) => n.id === 'freqs').params);
    const out = l.step({});
    assert.strictEqual(out.frequency, 14230000);
    assert.strictEqual(out.mode[0].value, 'usb');
});

t('a frequency in Hz into a strip chart is not audio: no level in dBFS, no clipping (the SSTV template’s chart)', () => {
    const g = TEMPLATES.find((x) => x.id === 'sstv').build();
    const rt = new Runtime(g, 12000);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    rt.measureLevels = true;
    // A 1900 Hz tone as the audio: the demodulator reads ~1900, far past 1 if taken for audio.
    const f = new Float32Array(240);
    for (let k = 0; k < 100; k++) {
        const i = new Float32Array(240);
        const q = new Float32Array(240);
        for (let j = 0; j < 240; j++) { const ph = (2 * Math.PI * 1900 * (k * 240 + j)) / 12000; i[j] = 0.3 * Math.cos(ph); q[j] = 0.3 * Math.sin(ph); }
        rt.process({ i, q, frames: 240, rate: 12000 });
    }
    const lv = rt.levels().freq;
    assert.ok(lv, JSON.stringify(Object.keys(rt.levels())));
    assert.ok(!lv.clip, `the chart clipped: ${JSON.stringify(lv)}`);
    assert.ok(lv.in == null || lv.in < 10, `level in read as audio, in dBFS: ${JSON.stringify(lv)}`);
    assert.strictEqual(lv.peak, undefined, "judged as audio at all");
});

t('a Clock’s pps into a Scheduler is its level line: the pulse shows on its card, as on the Clock’s', () => {
    const g = TEMPLATES.find((x) => x.id === 'beacon-hop').build();
    const rt = new Runtime(g, 12000);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    rt.measureLevels = true;
    // Over two seconds, then a packet at a time until the pulse is high: it
    // must read on the Scheduler the same as on the Clock.
    let on = null;
    for (let k = 0; k < 150 && !on; k++) {
        rt.process({ i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: 12000 });
        const lv = rt.levels();
        if (k >= 100 && lv.clock && lv.clock.out != null && lv.clock.out > -1) on = lv;
    }
    assert.ok(on, 'the Clock’s pulse never went high');
    assert.ok(on.schedule.in != null && on.schedule.in > -1, `the Scheduler shows no pulse: ${JSON.stringify(on.schedule)}`);
    assert.ok(!on.schedule.clip, 'a pulse is not audio: nothing to clip');
});

t('a real Clock into a Scheduler: its unix keeps the time, not this device’s, and its pps puts a change in the right packet', () => {
    // This device's clock 0.5 s short of 0:10, then jumping 30 s two seconds
    // in. 5 ms early: the 0:20 change due at 19.995 s, in the packet ending at
    // 20 — only the pulse's edge places the time finely enough to say so.
    const base = 1700000000 - (1700000000 % 60);
    const run = (wires) => {
        let fake = (base + 9.5) * 1000;
        const real = Date.now;
        Date.now = () => fake;
        try {
            const rt = new Runtime(graph([
                { id: 'iq', type: 'iq-in' },
                { id: 'clock', type: 'clock', params: { source: 'device' } },
                { id: 'schedule', type: 'scheduler', params: { kind: 'repeat', period: 60, leadMs: 5, schedule: '0:00 14.100\n0:10 18.110\n0:20 21.150' } },
            ], wires), 12000);
            assert.ok(rt.ok, JSON.stringify(rt.errors));
            const sch = rt.nodes.get('schedule');
            const changes = [];
            let seq = -1;
            for (let k = 0; k < 600; k++) {
                fake += k === 100 ? 30000 : 20;
                rt.process({ i: new Float32Array(240), q: new Float32Array(240), frames: 240, rate: 12000 });
                const f = sch.outs[0];
                if (f.seq !== seq && f.value != null) { seq = f.seq; changes.push([k, f.value]); }
            }
            return { changes, why: sch.inst.read().why };
        } finally { Date.now = real; }
    };
    const both = run([['clock', 'unix', 'schedule', 'unix'], ['clock', 'pps', 'schedule', 'pps']]);
    const unix = run([['clock', 'unix', 'schedule', 'unix']]);
    const none = run([]);
    // Waits for the Clock, then 0:10 on its first second; the device's jump ignored.
    assert.deepStrictEqual(both.changes, [[25, 18110000], [524, 21150000]]);
    assert.strictEqual(both.why, '');
    // Without the pulse, the second placed mid-packet: a packet late.
    assert.deepStrictEqual(unix.changes, [[25, 18110000], [525, 21150000]]);
    // No Clock: this device's clock, jump and all.
    assert.deepStrictEqual(none.changes.map((c) => c[1]), [14100000, 18110000, 21150000]);
    assert.ok(none.changes[2][0] <= 101, JSON.stringify(none.changes));
    assert.ok(none.why);
});

console.log(`\n${pass} passed`);
