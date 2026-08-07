// The WEFAX addon panel.
//
// The panel's whole polling strategy rests on one number in /api/status, and its whole
// display rests on reducing a list of decoded pages to the newest per channel — so
// those two, and the choice on top of them, are what is worth pinning down. The maths
// is small; the judgements about which page belongs to which chip are not.

const assert = require('assert');
const wx = require('./.build/wefaxaddon.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const NOW = Date.UTC(2026, 7, 7, 16, 47, 28);
const iso = (ms) => new Date(ms).toISOString();

// A record as the addon sends it — the shape taken from a live receiver.
const rec = (over = {}) => ({
    id: 'dc4a9515-0d9d-487e-b7e0-cc251d10f6a2',
    label: '7880000_usb',
    freq_hz: 7880000,
    audio_mode: 'usb',
    started_at: iso(NOW - 683000),
    saved_at: iso(NOW),
    lines: 1277,
    width: 1809,
    image_height: 1277,
    filename: '20260807_164728_dc4a9515.png',
    thumb_file: '20260807_164728_dc4a9515_thumb.png',
    snr: { count: 157622, avg_db: 44.815266, min_db: 19.04, max_db: 75.5, series: [] },
    ...over,
});

const status = (over = {}) => ({
    channels: [
        { label: '7880000_usb', freq_hz: 7880000, audio_mode: 'usb', status: 'running' },
        { label: '4610000_usb', freq_hz: 4610000, audio_mode: 'usb', status: 'running' },
    ],
    total_images: 2135,
    ...over,
});

// --- is the addon there? -----------------------------------------------------

t('the addon is found in the list by name, whatever its case', () => {
    assert.strictEqual(wx.wefaxAvailable({ addons: ['WEFAX'] }), true);
    assert.strictEqual(wx.wefaxAvailable({ addons: ['sstv', 'wefax'] }), true);
    assert.strictEqual(wx.wefaxAvailable({ addons: ['sstv'] }), false);
    assert.strictEqual(wx.wefaxAvailable(null), false);
});

t('the pages are served from the addon, and the name is escaped into the path', () => {
    assert.strictEqual(wx.imageUrl('a b.png'), '/addon/wefax/images/a%20b.png');
    assert.strictEqual(wx.addonUrl(), '/addon/wefax/');
});

t('each channel is asked for its own latest, by label', () => {
    // Not the newest few overall: on a live receiver the eight most recent pages were
    // all from 7880 kHz, and 4610 kHz — which had decoded a 3600-line chart that
    // morning — was outside the window, so the panel said nothing had been received on
    // it. Any fixed limit has that failure; one busy frequency and one quiet one is the
    // normal case.
    const url = wx.channelImagesUrl('7880000_usb');
    assert.ok(url.includes('label=7880000_usb'));
    assert.ok(url.includes('limit=1'));
    assert.ok(wx.channelImagesUrl('a b').includes('label=a%20b'), 'and the label is escaped');
});

// --- the cheap question ---------------------------------------------------------

t('status carries the channels, so a frequency with no pages is still known', () => {
    // Unlike the NAVTEX addon, this one publishes its configuration — which is what
    // lets the picker offer a frequency that has produced nothing today.
    const chans = wx.channelList(status());
    assert.deepStrictEqual(chans.map((c) => c.khz), ['7880', '4610']);
    assert.strictEqual(chans[0].running, true);
});

t("the channels are left in the addon's order, not sorted", () => {
    // Two views of one addon disagreeing about which channel comes first is a small
    // confusion with no upside.
    assert.deepStrictEqual(wx.channelList(status()).map((c) => c.label),
        ['7880000_usb', '4610000_usb']);
});

t('a channel with no label is not a channel', () => {
    assert.deepStrictEqual(wx.channelList({ channels: [{ freq_hz: 1 }] }), []);
    assert.deepStrictEqual(wx.channelList(null), []);
});

t('the image count is what the panel watches, and null when it cannot be read', () => {
    // The whole polling strategy: a 400-byte question every minute, and the 300 KB
    // answer only when this has moved.
    assert.strictEqual(wx.totalImages(status()), 2135);
    assert.strictEqual(wx.totalImages({}), null);
    assert.strictEqual(wx.totalImages(null), null);
});

// --- one page -------------------------------------------------------------------

t('a page keeps its frequency, its size and when it finished', () => {
    const img = wx.normaliseImage(rec());
    assert.strictEqual(img.khz, '7880');
    assert.strictEqual(img.width, 1809);
    assert.strictEqual(img.height, 1277);
    assert.strictEqual(img.at, NOW, 'saved_at — when the transmission finished');
    assert.ok(Math.abs(img.snr - 44.8) < 0.1);
});

t('the age is when it finished, not when it started', () => {
    // A fax takes ten minutes. "20 minutes ago" meaning "started twenty minutes ago and
    // finished ten minutes ago" has people looking for a newer page that is not there.
    const img = wx.normaliseImage(rec());
    assert.strictEqual(wx.tookLabel(img), '11 min');
    assert.ok(img.at > Date.parse(rec().started_at));
});

t('a page with no file is not a page', () => {
    assert.strictEqual(wx.normaliseImage(rec({ filename: '' })), null);
    assert.strictEqual(wx.normaliseImage(null), null);
});

t('a page with no thumbnail falls back to itself', () => {
    // Better a slow tile than a broken one.
    assert.strictEqual(wx.normaliseImage(rec({ thumb_file: '' })).thumb, rec().filename);
});

t('a missing SNR is null rather than zero', () => {
    assert.strictEqual(wx.normaliseImage(rec({ snr: null })).snr, null);
    assert.strictEqual(wx.normaliseImage(rec({ snr: {} })).snr, null);
});

t('a fax page is tall, and that is what decides how the modal shows it', () => {
    assert.strictEqual(wx.isTall(wx.normaliseImage(rec())), false, '1809 across, 1277 down');
    assert.strictEqual(wx.isTall(wx.normaliseImage(rec({ image_height: 3200 }))), true);
    assert.strictEqual(wx.sizeLabel(wx.normaliseImage(rec())), '1809 × 1277');
});

// --- the newest per channel --------------------------------------------------------

t('the newest page in a reply is picked, not the first one in it', () => {
    // The addon returns newest first, but a panel that trusted the order would show the
    // wrong page the day that changed, and taking the maximum costs nothing.
    const img = wx.newestImage({ images: [
        rec({ id: 'a', saved_at: iso(NOW - 3600000) }),
        rec({ id: 'b', saved_at: iso(NOW) }),
    ] });
    assert.strictEqual(img.id, 'b');
});

t('a channel that has decoded nothing answers with nothing', () => {
    assert.strictEqual(wx.newestImage({ images: [] }), null);
    assert.strictEqual(wx.newestImage(null), null);
    assert.strictEqual(wx.newestImage({ images: [null, {}] }), null);
});

t('the channels are shown newest first, and a channel with no page drops out', () => {
    const list = wx.sortNewest([
        wx.normaliseImage(rec({ label: '7880000_usb', saved_at: iso(NOW - 3600000) })),
        null,
        wx.normaliseImage(rec({ label: '4610000_usb', freq_hz: 4610000, saved_at: iso(NOW), id: 'c' })),
    ]);
    assert.deepStrictEqual(list.map((i) => i.khz), ['4610', '7880']);
});

// --- choosing what to show -----------------------------------------------------------

t('the picker offers Latest and every configured channel', () => {
    const chans = wx.channelList(status());
    assert.deepStrictEqual(wx.pickOptions(chans, []).map((o) => o.label),
        ['Latest', '7880', '4610']);
});

t('a page from a channel that has been removed is still reachable', () => {
    // Otherwise the panel would be holding something it could not show.
    const gone = [wx.normaliseImage(rec({ label: '2618000_usb', freq_hz: 2618000 }))];
    const opts = wx.pickOptions(wx.channelList(status()), gone);
    assert.ok(opts.some((o) => o.label === '2618'));
});

t('Latest is whichever channel finished a page most recently', () => {
    const list = wx.sortNewest([
        wx.normaliseImage(rec({ label: '7880000_usb', saved_at: iso(NOW - 3600000) })),
        wx.normaliseImage(rec({ label: '4610000_usb', freq_hz: 4610000, saved_at: iso(NOW), id: 'c' })),
    ]);
    assert.strictEqual(wx.chosenImage(list, wx.PICK_LATEST).khz, '4610');
    assert.strictEqual(wx.chosenImage(list, null).khz, '4610', 'and it is the default');
});

t('a chosen channel is shown even when the other one is newer', () => {
    const list = wx.sortNewest([
        wx.normaliseImage(rec({ label: '7880000_usb', saved_at: iso(NOW - 3600000) })),
        wx.normaliseImage(rec({ label: '4610000_usb', freq_hz: 4610000, saved_at: iso(NOW), id: 'c' })),
    ]);
    assert.strictEqual(wx.chosenImage(list, '7880000_usb').khz, '7880');
});

t("a configured channel with nothing on it shows nothing, not another frequency's chart", () => {
    // A synoptic chart under a chip reading 4610 when it came in on 7880 is worse than
    // an empty panel: the frequency is half of what a fax page is.
    const list = wx.sortNewest([wx.normaliseImage(rec())]);
    const known = ['7880000_usb', '4610000_usb'];
    assert.strictEqual(wx.chosenImage(list, '4610000_usb', known), null);
});

t('a choice nothing knows about falls back to the newest', () => {
    const list = wx.sortNewest([wx.normaliseImage(rec())]);
    assert.strictEqual(wx.chosenImage(list, 'gone', ['7880000_usb']).khz, '7880');
    assert.strictEqual(wx.chosenImage([], 'gone'), null, 'and nothing at all is nothing');
});

if (process.exitCode) console.log('\nWEFAX addon tests FAILED');
else console.log(`\nall ${pass} WEFAX addon tests passed`);
