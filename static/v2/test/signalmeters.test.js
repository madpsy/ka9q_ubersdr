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
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { deep, render, reset, words, SignalPanel, DEFAULTS } = require('./.build/signalmeters.cjs');

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

console.log(`\n${pass} ok`);
