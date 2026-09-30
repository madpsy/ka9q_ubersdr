// The HD Radio panel renders — empty, partly known and fully populated, in
// both views — shows only what the station has sent, and decodes the three
// messages the server sends it. See hookStub.js for what "renders" means.
//
// The panel's drawing is HDRadioView, a component of values alone, so the
// decoding branch can be rendered with any status without the attach hook
// (which would hold a socket open and keep the test from exiting).

const assert = require('assert');

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

const {
    render, reset, walk, words,
    HDRadioExtension, HDRadioView, CallsignMap, EXTENSIONS, EXTENSION_BY_ID, extensionEvent,
    alertAreas, decodeFrame, describeHereMap, formatBer, formatDevice, formatLeapSecond,
    formatUtcOffset, imageMime, pictureFor, programLabel, safeUrl, selectedProgram,
    stationClock, stationZone,
} = require('./.build/hdradiopanel.cjs');

const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

function context(over) {
    const calls = [];
    const ctx = {
        tuning: { frequency: 820_000, mode: 'am', bandwidthLow: -5000, bandwidthHigh: 5000 },
        running: true,
        audioState: 'open',
        audio: { volume: 0.8, muted: false },
        player: { ctx: null, setDucked: (v) => calls.push(['duck', v]) },
        actions: { setMode: (m) => calls.push(['setMode', m]), tuneTo() {}, ensureVisible() {} },
        serverInfo: { receiver: { callsign: 'M9PSY', gps: { lat: 51.5, lon: -0.1 } } },
        server: {},
        set() {},
        ...over,
    };
    ctx.calls = calls;
    return ctx;
}

// ── Status shapes ────────────────────────────────────────────────────────────

// What the binary sends before anything is known.
const EMPTY = {
    t: 'status', sync: false, freqOffset: 0, psmi: 0, merLower: null, merUpper: null, ber: null,
    country: '', facilityId: null, name: '', slogan: '', message: '', alert: '',
    alertCategories: [], alertLocationFormat: '', alertLocations: [], location: null,
    localTime: null, leapSecond: null, exciter: null, importer: null, importerConnected: null,
    dataServices: [], program: 0, audio: false, programs: [],
};

// Everything the binary can send, as WSHE's recording plus the rest.
const FULL = {
    ...EMPTY,
    sync: true, freqOffset: 0.4, psmi: 2, ber: 0.090104, country: 'US', facilityId: 47104,
    name: 'WSHE', slogan: 'HD1 ', message: 'www.thegamut.fm 820 The Gamut!',
    alert: 'Tornado warning', alertCategories: ['Weather', 'Safety'], alertLocationFormat: 'FIPS',
    alertLocations: [17031, 17043],
    location: { lat: 41.88, lon: -87.63, alt: 200 },
    localTime: { utcOffset: -360, dstRegional: true, dstLocal: true, dstSchedule: 'US/Canada' },
    leapSecond: { current: 18, pending: 19, pendingAlfn: 12345 },
    exciter: { manufacturer: 'GG', coreVersion: '1.2.3.4', coreRelease: 'commercial', manufacturerVersion: '2.3.4.5', manufacturerRelease: 'patch' },
    importer: null, importerConnected: true,
    dataServices: [{ type: 31, typeName: 'Emergency', access: 'public', mime: '00000444' }],
    program: 0, audio: true,
    programs: [
        {
            program: 0, type: 7, typeName: 'Adult Hits', serviceName: 'MPS', access: 'public', surround: '',
            title: 'Practice Smiling', artist: 'V.V. Lightbody', album: 'Period Piece [Clear]', genre: 'Indie',
            comments: [{ lang: 'eng', desc: 'Note', text: 'Recorded live' }],
            commercial: { price: 'USD0.99', seller: 'Shop', contactUrl: 'https://shop.example/buy', description: 'Single', validUntil: '2026-12-31' },
            artLot: 33778, audio: true, frames: 443, errors: 2,
        },
        {
            program: 1, type: 11, typeName: 'News', serviceName: 'SPS1', access: 'restricted', surround: 'Dolby Pro Logic II',
            title: '', artist: '', album: '', genre: '', comments: [], commercial: null, artLot: null,
            audio: false, frames: 0, errors: 0,
        },
    ],
};

const PICS = () => ({
    art: new Map([[33778, 'blob:art']]),
    logos: new Map([[0, 'blob:logo']]),
    here: [{ url: 'blob:wx', image: { kind: 'weather', bounds: { north: 41.5, west: -88.5, south: 40.5, east: -87 } } }],
});
const NO_PICS = () => ({ art: new Map(), logos: new Map(), here: [] });

function view(over) {
    reset();
    return render(HDRadioView, {
        minimal: false, running: true, live: true, decoding: true, attachState: 'running', problem: null,
        status: FULL, statusStale: false, signal: true, frames: 10, blocked: false, program: 0,
        onChoose() {}, hearAnalogue: false, onToggleAnalogue() {}, onStart() {}, onStop() {},
        pictures: PICS(), picturesVersion: 1, tuning: context().tuning,
        serverInfo: context().serverInfo, now: Date.UTC(2026, 8, 30, 18, 0),
        ...over,
    }, context()).tree;
}

const has = (tree, s) => words(tree).includes(s);
const nodesOf = (tree, type) => walk(tree).filter((n) => n && n.type === type);

// ── The extension ────────────────────────────────────────────────────────────

t('the extension renders docked and minimal, and never asks for a mode change', () => {
    for (const minimal of [false, true]) {
        reset();
        const ctx = context();
        const { tree } = render(HDRadioExtension, { minimal }, ctx);
        assert.ok(tree, `minimal=${minimal} produced nothing`);
        assert.ok(!ctx.calls.some((c) => c[0] === 'setMode'), 'it changed the mode');
    }
});

t('it says why it cannot start', () => {
    reset();
    let tree = render(HDRadioExtension, {}, context({ running: false, audioState: 'closed' })).tree;
    assert.ok(has(tree, 'Start the receiver to decode.'));
    reset();
    tree = render(HDRadioExtension, {}, context({ audioState: 'connecting' })).tree;
    assert.ok(has(tree, 'Waiting for the audio connection…'));
});

// ── The view, fully populated ────────────────────────────────────────────────

t('the full view shows everything the station sent', () => {
    const tree = view();
    for (const s of [
        'WSHE', 'HD1 ', 'Practice Smiling', 'V.V. Lightbody', 'Period Piece [Clear]',
        'www.thegamut.fm 820 The Gamut!', 'Tornado warning', 'FIPS 17031, 17043',
    ]) {
        const joined = words(tree);
        assert.ok(joined.includes(s.trim()), `missing "${s.trim()}"`);
    }
    const all = words(tree);
    assert.ok(all.includes('Alert · Weather, Safety'), 'alert categories');
    assert.ok(all.includes('Adult Hits · MPS'), 'program details');
    assert.ok(all.includes('US 47104'), 'facility');
    assert.ok(all.includes('13:00 UTC−5 (DST)'), 'station local time');
    assert.ok(all.includes('41.8800, -87.6300 · 200 m'), 'location');
    assert.ok(/[\d,]+ km · \d+°/.test(all), 'distance and bearing');
    assert.ok(all.includes('Emergency'), 'data services');
    assert.ok(all.includes('GG · core 1.2.3.4 · mfr 2.3.4.5 (patch)'), 'exciter');
    assert.ok(all.includes('GPS−UTC 18 s (19 s pending)'), 'leap second');
    assert.ok(all.includes('All-digital (MA3)'), 'service mode');
    assert.ok(all.includes('BER 9.01%'), 'BER');
    assert.ok(all.includes('Recorded live'), 'ID3 comment');
    assert.ok(all.includes('USD0.99 · Shop · Single'), `commercial frame: …${all.slice(all.indexOf('For sale'), all.indexOf('For sale') + 90)}…`);
    assert.ok(all.includes('HD1 Adult Hits') && all.includes('HD2 News'), 'program picker');

    const imgs = nodesOf(tree, 'img');
    assert.ok(imgs.some((n) => n.props.src === 'blob:art'), 'album art for the song playing');
    assert.ok(imgs.some((n) => n.props.src === 'blob:wx'), 'HERE weather map');
    const maps = nodesOf(tree, CallsignMap);
    assert.strictEqual(maps.length, 1, 'station map');
    assert.deepStrictEqual(maps[0].props.position, { lat: 41.88, lon: -87.63 });
    assert.ok(maps[0].props.from && maps[0].props.from.label === 'M9PSY', 'receiver pin on the map');
    const links = nodesOf(tree, 'a');
    assert.ok(links.length === 1 && links[0].props.href === 'https://shop.example/buy' && /noopener/.test(links[0].props.rel));
});

t('the minimal view keeps to the basics', () => {
    const tree = view({ minimal: true });
    const all = words(tree);
    for (const s of ['WSHE', 'Practice Smiling', 'V.V. Lightbody', 'Tornado warning']) {
        assert.ok(all.includes(s), `minimal is missing "${s}"`);
    }
    for (const s of ['www.thegamut.fm', 'US 47104', 'Emergency', 'GPS−UTC', 'Period Piece', 'FIPS']) {
        assert.ok(!all.includes(s), `minimal shows "${s}"`);
    }
    assert.strictEqual(nodesOf(tree, CallsignMap).length, 0, 'minimal draws a map');
    assert.ok(nodesOf(tree, 'img').some((n) => n.props.src === 'blob:art'), 'minimal keeps the art thumbnail');
});

// ── Only what has arrived ────────────────────────────────────────────────────

t('nothing is drawn for what the station has not sent', () => {
    for (const minimal of [false, true]) {
        const tree = view({ minimal, status: { ...EMPTY }, pictures: NO_PICS(), signal: false });
        const all = words(tree);
        assert.ok(all.includes('Searching…'), 'waiting text');
        assert.strictEqual(nodesOf(tree, CallsignMap).length, 0, 'a map with no location');
        assert.strictEqual(nodesOf(tree, 'img').length, 0, 'a picture with none received');
        for (const k of ['Facility', 'Local time', 'Location', 'Distance', 'Services', 'Exciter', 'Importer', 'Time', 'Genre', 'For sale', 'Alert']) {
            assert.ok(!all.includes(k), `"${k}" drawn with nothing in it (minimal=${minimal})`);
        }
        assert.strictEqual(walk(tree).filter((n) => n && n.props && n.props.className === 'kv').length, 0, 'empty rows drawn');
    }
});

t('it renders with no status at all, and while stopped', () => {
    for (const minimal of [false, true]) {
        assert.ok(view({ minimal, status: null, pictures: NO_PICS() }));
        assert.ok(view({ minimal, decoding: false, status: null, attachState: 'idle' }));
    }
});

t('a single-program station has no program picker', () => {
    const tree = view({ status: { ...FULL, programs: [FULL.programs[0]] } });
    assert.ok(!words(tree).includes('HD2'), 'picker shown for one program');
});

t('the station logo stands in when the song has no art', () => {
    const status = { ...FULL, programs: [{ ...FULL.programs[0], artLot: null }] };
    const imgs = nodesOf(view({ status }), 'img');
    assert.ok(imgs.some((n) => n.props.src === 'blob:logo'));
});

t('a link the station sends is only a link if it is http(s)', () => {
    const programs = [{ ...FULL.programs[0], commercial: { ...FULL.programs[0].commercial, contactUrl: 'javascript:alert(1)' } }];
    const tree = view({ status: { ...FULL, programs } });
    assert.strictEqual(nodesOf(tree, 'a').length, 0);
});

t('a blocked frequency and an off-raster tuning are explained', () => {
    assert.ok(words(view({ blocked: true })).includes('blocked on this receiver'));
    const tree = view({ status: { ...EMPTY }, signal: false, tuning: { frequency: 823_000, mode: 'am' } });
    assert.ok(words(tree).includes('off the 10 kHz channel raster'));
});

// ── Registration ─────────────────────────────────────────────────────────────

t('it is registered, has a minimal view, and does not claim IQ', () => {
    const e = EXTENSION_BY_ID.hdradio;
    assert.ok(e && e.Component === HDRadioExtension);
    assert.strictEqual(e.minimal, true);
    assert.ok(!e.needsIQ, 'hdradio runs on its own private channel, in any mode');
    assert.ok(EXTENSIONS.includes(e));
});

t('the retuned event reaches the panel', () => {
    const ev = extensionEvent({ type: 'audio_extension_retuned', extension_name: 'hdradio', frequency: 830000, blocked: true });
    assert.deepStrictEqual(ev, { kind: 'retuned', name: 'hdradio', frequency: 830000, blocked: true, error: null });
});

// ── Frames ───────────────────────────────────────────────────────────────────

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0];

function imageFrame(header, bytes, lenOverride) {
    const h = Buffer.from(typeof header === 'string' ? header : JSON.stringify(header), 'utf8');
    const pkt = new Uint8Array(5 + h.length + bytes.length);
    pkt[0] = 0x04;
    new DataView(pkt.buffer).setUint32(1, lenOverride != null ? lenOverride : h.length);
    pkt.set(h, 5);
    pkt.set(bytes, 5 + h.length);
    return pkt;
}

t('status, audio and image messages decode', () => {
    const json = Buffer.from(JSON.stringify(FULL), 'utf8');
    const st = new Uint8Array(1 + json.length);
    st[0] = 0x03;
    st.set(json, 1);
    assert.strictEqual(decodeFrame(st).status.name, 'WSHE');

    const au = new Uint8Array(20);
    au[0] = 0x02;
    new DataView(au.buffer).setUint32(9, 48000);
    au[13] = 2;
    const a = decodeFrame(au);
    assert.ok(a.kind === 'audio' && a.sampleRate === 48000 && a.channels === 2 && a.opus.length === 6);

    const im = decodeFrame(imageFrame({ t: 'image', kind: 'art', program: 0, lot: 33778, mime: 'image/jpeg', name: 'c.jpg', bounds: null }, JPEG));
    assert.ok(im.kind === 'image' && im.image.kind === 'art' && im.image.lot === 33778 && im.image.mime === 'image/jpeg');
    assert.strictEqual(im.bytes.length, JPEG.length);
    const png = decodeFrame(imageFrame({ t: 'image', kind: 'logo', program: 1, lot: 7, mime: 'image/jpeg' }, PNG));
    assert.strictEqual(png.image.mime, 'image/png', 'the mime comes from the bytes, not the header');
});

t('malformed messages are dropped, not thrown', () => {
    const bad = [
        new Uint8Array(0),
        new Uint8Array([0x03, 0x7b]), // truncated JSON
        new Uint8Array([0x02, 0, 0]), // short audio
        imageFrame({ t: 'image', kind: 'art' }, [1, 2, 3]), // not an image
        imageFrame({ t: 'image', kind: 'virus' }, JPEG), // unknown kind
        imageFrame('not json', JPEG),
        imageFrame({ t: 'image', kind: 'art' }, JPEG, 999999), // header length past the end
        new Uint8Array([0x04, 0, 0]),
        new Uint8Array([0x09, 1, 2, 3]),
    ];
    for (const b of bad) assert.strictEqual(decodeFrame(b), null);
    assert.strictEqual(imageMime(new Uint8Array([0x47, 0x49, 0x46])), '', 'GIF is not accepted');
});

// ── Helpers ──────────────────────────────────────────────────────────────────

t('presentation helpers', () => {
    assert.strictEqual(programLabel(0), 'HD1');
    assert.strictEqual(formatUtcOffset(-360), 'UTC−6');
    assert.strictEqual(formatUtcOffset(330), 'UTC+5:30');
    assert.strictEqual(formatUtcOffset(0), 'UTC');
    const noon = Date.UTC(2026, 0, 1, 12, 0);
    assert.strictEqual(stationClock({ utcOffset: -360, dstRegional: false, dstLocal: false }, noon), '06:00');
    assert.strictEqual(stationClock({ utcOffset: -360, dstRegional: true, dstLocal: true }, noon), '07:00');
    assert.strictEqual(stationClock({ utcOffset: -360, dstRegional: true, dstLocal: false }, noon), '06:00');
    assert.strictEqual(stationZone({ utcOffset: -360, dstRegional: true, dstLocal: true }), 'UTC−5 (DST)');
    assert.strictEqual(stationClock(null, noon), '');
    assert.strictEqual(formatBer(0.090104), '9.01%');
    assert.strictEqual(formatBer(0.0004), '0.04%');
    assert.strictEqual(formatBer(null), '');
    assert.strictEqual(formatDevice(null), '');
    assert.strictEqual(alertAreas({ alertLocations: [], alertLocationFormat: 'FIPS' }), '');
    assert.strictEqual(alertAreas({ alertLocations: Array.from({ length: 14 }, (_, i) => i), alertLocationFormat: 'SAME' }),
        'SAME 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 +2');
    assert.strictEqual(safeUrl('https://a.example/x'), 'https://a.example/x');
    for (const u of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x', ' ', null, 'http://a b']) assert.strictEqual(safeUrl(u), '');
    assert.strictEqual(formatLeapSecond({ current: 18, pending: 18 }), 'GPS−UTC 18 s');
    assert.strictEqual(formatLeapSecond(null), '');
    assert.strictEqual(describeHereMap({ kind: 'traffic', bounds: null }), 'Traffic map');
    assert.strictEqual(selectedProgram({ program: 1, programs: FULL.programs }).typeName, 'News');
    assert.strictEqual(selectedProgram(null), null);
});

t('the picture is art, then that program\'s logo, then any logo, then nothing', () => {
    const art = new Map([[5, 'blob:a']]);
    const logos = new Map([[1, 'blob:l1'], [0, 'blob:l0']]);
    assert.deepStrictEqual(pictureFor({ program: 0, artLot: 5 }, art, logos), { url: 'blob:a', kind: 'art' });
    assert.deepStrictEqual(pictureFor({ program: 0, artLot: 6 }, art, logos), { url: 'blob:l0', kind: 'logo' });
    assert.deepStrictEqual(pictureFor({ program: 2, artLot: null }, art, logos), { url: 'blob:l1', kind: 'logo' });
    assert.strictEqual(pictureFor({ program: 0, artLot: null }, new Map(), new Map()), null);
});
