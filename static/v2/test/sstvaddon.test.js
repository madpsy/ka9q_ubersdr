// The SSTV addon's images: the query, and how a record is read.
//
// Not to be confused with sstv.test.js, which covers the in-browser decoder
// extension. This is the addon that decodes server-side and keeps the pictures.
//
// Ported from widgets/sstv.widget.html, and these pin the parts of it that are
// easy to get subtly wrong — the query string the addon expects, and the
// conventions where a zero means "not measured" rather than zero.

const assert = require('assert');
const {
    AGE_TICK_MS, DEFAULT_IMAGES, MAX_IMAGES, MODE_NAMES, POLL_MS, clampCount,
    detailRows, downloadName, formatAge, formatFreq, formatSNR, formatTime,
    ADDON_NAME, addonUrl, imageUrl, imagesUrl, modeName, records, sstvAvailable,
} = require('./.build/sstvaddon.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const rec = (o = {}) => ({
    id: 42,
    file: 'sstv_20260805_120000.png',
    sstv_mode: 'M1',
    frequency_hz: 14230000,
    audio_mode: 'usb',
    snr_avg_db: 41.5,
    rx_end: '2026-08-05T12:02:00.000Z',
    ...o,
});

// --- availability ------------------------------------------------------------

t('the panel exists only where the addon does', () => {
    assert.strictEqual(sstvAvailable({ addons: ['sstv', 'wefax'] }), true);
    assert.strictEqual(sstvAvailable({ addons: ['SSTV'] }), true, 'case insensitive');
    assert.strictEqual(sstvAvailable({ addons: ['wefax'] }), false);
    assert.strictEqual(sstvAvailable({}), false);
    assert.strictEqual(sstvAvailable(null), false);
});

// --- the query ---------------------------------------------------------------

t('the query is the one the addon expects', () => {
    // Complete pictures only, above the SNR that filters out noise-only
    // decodes, and without the per-line SNR series nothing here draws.
    const url = imagesUrl(1);
    assert.ok(url.startsWith('/addon/sstv/api/images?'), url);
    for (const part of ['limit=1', 'snr_series=0', 'complete=1', 'min_snr=38', 'offset=0']) {
        assert.ok(url.includes(part), `${part} missing from ${url}`);
    }
});

t('however many are wanted come in one request', () => {
    // The widget fetched one at a time and walked back with an offset, probing
    // for the next one each step. `limit` was there all along.
    assert.ok(imagesUrl(6).includes('limit=6'));
    assert.ok(imagesUrl(6).includes('offset=0'), 'still from the newest');
});

t('the count is held between one and the maximum, whatever it is given', () => {
    assert.strictEqual(clampCount(0), 1);
    assert.strictEqual(clampCount(-3), 1);
    assert.strictEqual(clampCount(99), MAX_IMAGES);
    assert.strictEqual(clampCount(2.6), 3);
    assert.strictEqual(clampCount(null), 1);
    assert.strictEqual(clampCount('4'), 4);
    assert.strictEqual(clampCount(undefined), DEFAULT_IMAGES);
    // And the URL can never ask for more than the addon should serve.
    assert.ok(imagesUrl(1000).includes(`limit=${MAX_IMAGES}`));
});

t('images are served from the addon, by filename', () => {
    assert.strictEqual(imageUrl('a.png'), '/addon/sstv/images/a.png');
});

t('the panel links out to the same route the Addons panel uses', () => {
    // Trailing slash and all: that is the route the server publishes, and the
    // two panels offering the same addon at two different URLs is the kind of
    // thing nobody notices until one of them 404s.
    assert.strictEqual(addonUrl(), `/addon/${ADDON_NAME}/`);
});

t('a response is an array, and anything else is no pictures rather than a crash', () => {
    assert.deepStrictEqual(records([rec()]), [rec()]);
    assert.deepStrictEqual(records([]), []);
    assert.deepStrictEqual(records(null), []);
    assert.deepStrictEqual(records({ id: 1 }), [], 'an object is not the array we asked for');
});

t('a record with no file is not a picture', () => {
    // There is nothing to show and the src would be the addon's image
    // directory, which is not an image.
    assert.deepStrictEqual(records([rec(), { id: 7 }, null]), [rec()]);
});

t('the poll is slower than pictures arrive', () => {
    // An SSTV frame takes one to four minutes to send.
    assert.ok(POLL_MS >= 30000 && POLL_MS <= 120000, `${POLL_MS} ms`);
    assert.ok(AGE_TICK_MS < POLL_MS);
});

// --- reading a record --------------------------------------------------------

t('a mode code becomes its name, and an unknown one stays itself', () => {
    assert.strictEqual(modeName('M1'), 'Martin 1');
    assert.strictEqual(modeName('SC2-180'), 'SC2 180');
    assert.strictEqual(modeName('WHAT'), 'WHAT');
    assert.strictEqual(modeName(''), '—');
    assert.strictEqual(modeName(null), '—');
});

t('every mode in the table has a name', () => {
    for (const [code, name] of Object.entries(MODE_NAMES)) {
        assert.ok(name && typeof name === 'string', code);
    }
});

t('a frequency reads in the unit that suits it', () => {
    assert.strictEqual(formatFreq(14230000), '14.230 MHz');
    assert.strictEqual(formatFreq(3730000), '3.730 MHz');
    assert.strictEqual(formatFreq(145500), '145.5 kHz');
    assert.strictEqual(formatFreq(0), '—');
    assert.strictEqual(formatFreq(null), '—');
});

t('an SNR of zero means not measured, not a terrible decode', () => {
    // The addon's own convention, and the widget's.
    assert.strictEqual(formatSNR(41.5), '41.5 dB');
    assert.strictEqual(formatSNR(0), '—');
    assert.strictEqual(formatSNR(null), '—');
    assert.strictEqual(formatSNR(-3), '-3.0 dB');
});

t('times are shown in UTC, because that is what the log says', () => {
    assert.strictEqual(formatTime('2026-08-05T12:02:00.000Z'), '2026-08-05 12:02:00 UTC');
    assert.strictEqual(formatTime(''), '—');
    assert.strictEqual(formatTime('not a date'), '—');
});

t('the age counts up through the units', () => {
    const end = '2026-08-05T12:00:00.000Z';
    const at = (secs) => formatAge(end, Date.parse(end) + secs * 1000);
    assert.strictEqual(at(0), '0s ago');
    assert.strictEqual(at(45), '45s ago');
    assert.strictEqual(at(90), '1m ago');
    assert.strictEqual(at(3600 + 120), '1h 2m ago');
    assert.strictEqual(at(86400 * 3), '3d ago');
    // A picture whose clock is a moment ahead of ours is not from the future.
    assert.strictEqual(at(-5), 'just now');
    assert.strictEqual(formatAge(null), '');
});

t('the detail rows are what the widget showed, in its order', () => {
    assert.deepStrictEqual(detailRows(rec()), [
        ['Mode', 'Martin 1'],
        ['Freq', '14.230 MHz USB'],
        ['SNR', '41.5 dB'],
        ['RX end', '2026-08-05 12:02:00 UTC'],
    ]);
});

t('a callsign is shown only when the decoder read one', () => {
    const rows = detailRows(rec({ callsign: 'GM4ABC' }));
    assert.deepStrictEqual(rows[1], ['Call', 'GM4ABC']);
    assert.ok(!detailRows(rec()).some(([l]) => l === 'Call'));
});

t('a record with nothing in it still renders', () => {
    // The addon fills what it decoded and leaves the rest out.
    assert.deepStrictEqual(detailRows({}), [
        ['Mode', '—'],
        ['Freq', '—'],
        ['SNR', '—'],
        ['RX end', '—'],
    ]);
    assert.deepStrictEqual(detailRows(null), []);
});

t('the download gets a filename, whatever the path looks like', () => {
    assert.strictEqual(downloadName('sstv_20260805.png'), 'sstv_20260805.png');
    assert.strictEqual(downloadName('sub/dir/pic.png'), 'pic.png');
    assert.strictEqual(downloadName(''), 'sstv.png');
    assert.strictEqual(downloadName(null), 'sstv.png');
});

console.log(`\n${pass} ok`);
