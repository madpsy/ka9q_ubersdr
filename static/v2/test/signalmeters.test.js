// The Signal panel's two meters: the face swaps bar and needle for both, the
// numbers step one meter through S, dBFS and SNR, and the two are independent.
// See hookStub.js for what "renders" means here.

const assert = require('assert');

globalThis.window = globalThis.window || globalThis;
globalThis.performance = { now: () => 1000 };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { deep, render, reset, words, SignalPanel, DEFAULTS, drawChart } = require('./.build/signalmeters.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

function panel(settings = {}, { power = -87, snr = 12 } = {}) {
    reset();
    const sets = [];
    const ctx = {
        running: true,
        squelch: -999,
        tuning: { mode: 'usb', frequency: 14_200_000, bandwidthLow: 50, bandwidthHigh: 2700 },
        audio: { bufferSec: 0.5 },
        meters: { current: { snr, basebandPower: power, noisePower: power - snr, snrHistory: [] } },
        actions: { setSquelch() {}, autoSquelch() {} },
        ...DEFAULTS,
        ...settings,
        set: (patch) => sets.push(patch),
    };
    const { tree, cleanups } = render(SignalPanel, { minimal: true }, ctx);
    const nodes = deep(tree);
    // The panel samples on a real interval; leave nothing running.
    for (const off of cleanups) off();
    const meters = nodes.filter((n) => n.props?.className === 'meter');
    const part = (meter, cls) => deep(meter).find((n) => n.props?.className?.split(' ').includes(cls));
    return {
        sets,
        meters: meters.map((m) => ({
            face: part(m, 'meter__face'),
            value: part(m, 'meter__value'),
            text: words(part(m, 'meter__value')),
            scale: words(part(m, 'meter__scale') || []),
        })),
    };
}

t('by default the top meter reads S-units and the bottom one SNR', () => {
    const { meters } = panel();
    assert.strictEqual(meters.length, 2);
    assert.match(meters[0].text, /S\d/);
    assert.match(meters[1].text, /SNR/);
});

t('clicking the numbers steps that meter S → dBFS → SNR → S', () => {
    for (const [from, to] of [['s', 'dbfs'], ['dbfs', 'snr'], ['snr', 's']]) {
        const { meters, sets } = panel({ signalMeterTop: from });
        meters[0].value.props.onClick();
        assert.deepStrictEqual(sets, [{ signalMeterTop: to }], from);
    }
    const { meters, sets } = panel();
    meters[1].value.props.onClick();
    assert.deepStrictEqual(sets, [{ signalMeterBottom: 's' }], 'the bottom one has its own setting');
});

t('either meter can show any reading, both the same included', () => {
    const { meters } = panel({ signalMeterTop: 'snr', signalMeterBottom: 'snr' });
    assert.match(meters[0].text, /SNR/);
    assert.match(meters[1].text, /SNR/);
});

t('the dBFS reading prints dBFS on a scale fitted around it', () => {
    const { meters } = panel({ signalMeterTop: 'dbfs' }, { power: -87.4 });
    assert.match(meters[0].text, /-\s*87/);
    assert.match(meters[0].text, /dBFS/);
    // -87 alone: -90 up to -60, every 10 dB.
    assert.deepStrictEqual(meters[0].scale.split(' '), ['-90', '-80', '-70', '-60']);
});

t('the face still swaps bar and needle for both, whatever they read', () => {
    const { meters, sets } = panel({ signalMeterTop: 'dbfs' });
    meters[0].face.props.onClick();
    meters[1].face.props.onClick();
    assert.deepStrictEqual(sets, [{ meterStyle: 'needle' }, { meterStyle: 'needle' }]);
});

t('the numbers are not inside the face button', () => {
    const { meters } = panel();
    for (const m of meters) {
        assert.ok(!deep(m.face).includes(m.value), 'a button inside a button');
    }
});

t('an unknown stored reading falls back to the default', () => {
    const { meters } = panel({ signalMeterTop: 'bogus', signalMeterBottom: undefined });
    assert.match(meters[0].text, /S\d/);
    assert.match(meters[1].text, /SNR/);
});

t('needle style renders every reading', () => {
    for (const r of ['s', 'dbfs', 'snr']) {
        const { meters } = panel({ meterStyle: 'needle', signalMeterTop: r });
        assert.ok(meters[0].face, r);
    }
});

t('no reading yet: dashes, and no dBFS scale invented', () => {
    const { meters } = panel({ signalMeterTop: 'dbfs' }, { power: -999, snr: null });
    assert.match(meters[0].text, /--/);
    assert.strictEqual(meters[0].scale, '');
});

// Several renders in a row, as the meter clock gives them. Hook state carries
// from one to the next, as it does in the browser, and the clock is ticked by
// hand: useMeters keeps a snapshot that only its interval refreshes, so each
// reading is put on the meters and the captured ticks fired before the next
// render. Effects run after each render, so a hold set by one reading shows on
// the render after it.
function sequence(readings, settings = {}, { minimal = true } = {}) {
    reset();
    const meters = { current: null };
    const ctx = {
        running: true,
        squelch: { value: 6, enabled: true },
        tuning: { mode: 'usb', frequency: 14_200_000, bandwidthLow: 50, bandwidthHigh: 2700 },
        audio: { bufferSec: 0.5 },
        meters,
        actions: { setSquelch() {}, autoSquelch() {} },
        ...DEFAULTS,
        ...settings,
        set: () => {},
    };
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    let ticks = [];
    globalThis.setInterval = (fn) => { ticks.push(fn); return ticks.length; };
    globalThis.clearInterval = () => {};
    let last = null;
    try {
        for (const { power = -87, snr = 12 } of readings) {
            meters.current = { snr, basebandPower: power, noisePower: power - snr, snrHistory: [] };
            for (const tick of ticks) tick();
            ticks = [];
            const r = render(SignalPanel, { minimal }, ctx);
            for (const off of r.cleanups) off();
            last = deep(r.tree);
        }
    } finally {
        globalThis.setInterval = realSet;
        globalThis.clearInterval = realClear;
    }
    const faces = last.filter((n) => n.props?.className === 'meter');
    const cls = (root, c) => deep(root).filter((n) => n.props?.className?.split(' ').includes(c));
    return {
        text: faces.map((m) => words(cls(m, 'meter__value')[0])),
        stats: cls(last, 'sigchart__stats').map((n) => words(n)),
        head: cls(last, 'sigchart__head').map((n) => words(n)),
    };
}

t('the SNR meter holds its peak beside the live reading', () => {
    const { text } = sequence([{ snr: 18.4 }, { snr: 4.1 }]);
    // Live first, then the hold, then the unit once.
    assert.match(text[1], /4\.1\s+18\.4\s*dB SNR/);
});

t('an SNR hold is not clamped to the end of the scale', () => {
    const { text } = sequence([{ snr: 38.2 }, { snr: 12 }]);
    assert.match(text[1], /38\.2/);
});

t('no SNR reading clears the hold rather than printing a stale one', () => {
    const { text } = sequence([{ snr: 18.4 }, { snr: null }, { snr: null }]);
    assert.doesNotMatch(text[1], /18\.4/);
    assert.match(text[1], /--/);
});

t('the chart prints the lowest, mean and highest of what it shows', () => {
    // The figures are a child component, drawn after the render's own sample
    // has landed, so all three readings are in them.
    const { stats, head } = sequence([{ snr: 4 }, { snr: 10 }, { snr: 16 }], {}, { minimal: false });
    assert.match(stats[0], /Min\s+4\.0\s+Avg\s+10\.0\s+Max\s+16\.0/);
    assert.match(head[0], /SNR\s+dB/);
});

t('the chart in dBFS prints dBFS figures', () => {
    const { stats, head } = sequence(
        [{ power: -90 }, { power: -80 }], { signalChart: 'dbfs' }, { minimal: false },
    );
    assert.match(stats[0], /Min\s+-\s*90\.0\s+Avg\s+-\s*85\.0\s+Max\s+-\s*80\.0/);
    assert.match(head[0], /Signal\s+dBFS/);
});

t('before any reading the chart figures are dashes', () => {
    const { stats } = sequence([{ snr: null, power: -999 }], {}, { minimal: false });
    assert.match(stats[0], /Min\s+—\s+Avg\s+—\s+Max\s+—/);
});

// A 2D context that records what was drawn: the text, and every stroke's
// colour and the dash it was drawn with.
function recorder(width = 300, height = 80) {
    const log = { text: [], strokes: [] };
    let dash = [];
    const ctx = {
        font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: '', textBaseline: '',
        lineJoin: '', lineCap: '', globalAlpha: 1,
        clearRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, translate() {},
        moveTo() {}, lineTo() {}, bezierCurveTo() {},
        setLineDash(d) { dash = d; },
        strokeText() {},
        measureText: (s) => ({ width: s.length * 6 }),
        fillText(s, x, y) { log.text.push({ s, x, y }); },
        stroke() { log.strokes.push({ colour: ctx.strokeStyle, dash: dash.length > 0 }); },
    };
    const canvas = { clientWidth: width, clientHeight: height, width: 0, height: 0, getContext: () => ctx };
    return { canvas, log };
}

const series = (vals, now = 20_000) => vals.map((v, i) => ({ t: now - 9000 + i * 1000, snr: v, dbfs: v - 100 }));
const SNR_CHART = { key: 'snr', colour: () => '#0f0', label: 'SNR', unit: 'dB', digits: 2 };

t('the chart draws a labelled dB grid around the trace', () => {
    const { canvas, log } = recorder();
    drawChart(canvas, series([4, 8, 12, 16, 9, 6]), 20_000, SNR_CHART, null);
    assert.deepStrictEqual(log.text.map((l) => l.s), ['0', '5', '10', '15', '20']);
    // Every label in the gutter, left of where the plot starts.
    assert.ok(log.text.every((l) => l.x < 30), JSON.stringify(log.text));
});

t('the squelch threshold is drawn on the SNR chart, marked SQ', () => {
    const { canvas, log } = recorder();
    drawChart(canvas, series([4, 8, 12, 16, 9, 6]), 20_000, SNR_CHART, 10);
    assert.ok(log.text.some((l) => l.s === 'SQ'));
});

t('no squelch line when it is off the scale, or the chart is in dBFS', () => {
    let r = recorder();
    drawChart(r.canvas, series([4, 8, 12]), 20_000, SNR_CHART, 40);
    assert.ok(!r.log.text.some((l) => l.s === 'SQ'));
    r = recorder();
    drawChart(r.canvas, series([4, 8, 12]), 20_000, { ...SNR_CHART, key: 'dbfs' }, -95);
    assert.ok(!r.log.text.some((l) => l.s === 'SQ'));
});

t('fewer than two readings in view draws nothing at all', () => {
    const { canvas, log } = recorder();
    drawChart(canvas, series([4]), 20_000, SNR_CHART, null);
    assert.strictEqual(log.text.length + log.strokes.length, 0);
});

t('a collapsed chart draws nothing and does not throw', () => {
    const { canvas, log } = recorder(0, 0);
    drawChart(canvas, series([4, 8, 12]), 20_000, SNR_CHART, null);
    assert.strictEqual(log.text.length, 0);
});

console.log(`\n${pass} ok`);
