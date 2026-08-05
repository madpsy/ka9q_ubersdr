// What the receiver remembers between visits.
//
// Small file, one rule, and it is here because breaking that rule loses the
// operator's settings silently: the save merges, so a caller that does not
// mention a field leaves it alone.

const assert = require('assert');
const { loadRadioSettings, saveRadioSettings } = require('./.build/radiosettings.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        refuse: false,
        get length() { return map.size; },
        key: (i) => [...map.keys()][i] ?? null,
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) {
            if (this.refuse) throw new Error('quota exceeded');
            map.set(k, String(v));
        },
        removeItem(k) { map.delete(k); },
    };
}

const KEY = 'ubersdr.v2.radio';
const install = (initial) => { globalThis.localStorage = fakeStorage(initial); return globalThis.localStorage; };
const stored = (s) => JSON.parse(s.getItem(KEY));

t('a partial save leaves everything it did not mention alone', () => {
    // The bug this exists for: the settings effect spreads the spectrum view in
    // only once the server has said what it is, and the first write of the
    // session happens before that. A replacing save wrote the whole blob
    // without those fields and erased the view the page was about to resume.
    const s = install({ [KEY]: JSON.stringify({ frequency: 14074000, spectrumCenter: 14.1e6 }) });
    saveRadioSettings({ frequency: 7100000 });
    assert.deepStrictEqual(stored(s), { frequency: 7100000, spectrumCenter: 14.1e6 });
});

t('a mentioned field is overwritten, including with a falsy value', () => {
    const s = install({ [KEY]: JSON.stringify({ muted: true, volume: 0.7 }) });
    saveRadioSettings({ muted: false, volume: 0 });
    assert.deepStrictEqual(stored(s), { muted: false, volume: 0 });
});

t('an object field is replaced whole rather than merged into', () => {
    // Filters and DSP params are written as complete objects; a deep merge
    // would resurrect a filter the operator had removed.
    const s = install({ [KEY]: JSON.stringify({ filters: { notch: [100, 200] } }) });
    saveRadioSettings({ filters: { notch: [] } });
    assert.deepStrictEqual(stored(s).filters, { notch: [] });
});

t('nothing stored reads as nothing, not as a crash', () => {
    install({});
    assert.deepStrictEqual(loadRadioSettings(), {});
});

t('a corrupt or wrong-shaped blob is ignored rather than thrown', () => {
    install({ [KEY]: 'not json' });
    assert.deepStrictEqual(loadRadioSettings(), {});
    install({ [KEY]: '[1,2,3]' });
    assert.deepStrictEqual(loadRadioSettings(), {}, 'an array is not a settings object');
    install({ [KEY]: 'null' });
    assert.deepStrictEqual(loadRadioSettings(), {});
});

t('a corrupt blob is replaced rather than merged into', () => {
    const s = install({ [KEY]: 'not json' });
    saveRadioSettings({ frequency: 7100000 });
    assert.deepStrictEqual(stored(s), { frequency: 7100000 });
});

t('a storage that refuses the write does not take the render down with it', () => {
    const s = install({});
    s.refuse = true;
    assert.doesNotThrow(() => saveRadioSettings({ frequency: 7100000 }));
});

console.log(`\n${pass} ok`);
