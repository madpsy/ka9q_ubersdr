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
    formatScheduleFreq, formatSlot, formatSlotTime, isTunedTo, onAirCount,
    resetSchedule, scheduleDetail, scheduleRows,
    describeSlot, formatOffsetLabel, localOffsetMinutes, shiftHHMM,
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

// ── schedule ────────────────────────────────────────────────────────────────
//
// The panel carries the DRM broadcast schedule, and a row is a tune. Two things
// worth holding: what the list decides to show, and that a row renders at all —
// the rows only exist once a fetch has resolved, so nothing else in this file
// would ever execute that markup.

const SCHEDULE = [
    {
        freq_khz: 5875, freq_hz: 5875000, station: 'BBC World Service', start_utc: 500, end_utc: 600,
        days: 'Daily', days_mask: '1111111', language: 'English', target: 'Europe',
        site: 'Woofferton', country: 'United Kingdom', power_kw: '100', band: 'SW', on_air: true,
    },
    {
        freq_khz: 549, freq_hz: 549000, station: 'Akashvani', start_utc: 0, end_utc: 2400,
        days: 'Daily', days_mask: '1111111', language: 'Hindi', target: 'India',
        site: 'Ranchi', country: 'India', power_kw: '100', band: 'MW', on_air: true,
    },
    {
        freq_khz: 15785, freq_hz: 15785000, station: 'funklust', start_utc: 1030, end_utc: 1100,
        days: 'Tue, Thu', days_mask: '0010100', language: 'German', target: 'Various',
        site: 'Bayreuth', country: 'Germany', power_kw: '1', band: 'SW', on_air: false,
    },
];

t('the list puts what is on air first, then orders by frequency', () => {
    const rows = scheduleRows(SCHEDULE, {});
    assert.deepStrictEqual(rows.map((r) => r.freq_khz), [549, 5875, 15785]);
    // Not merely sorted by frequency: the off-air entry is last despite sitting
    // between the two on-air ones by nothing but chance.
    assert.strictEqual(rows[rows.length - 1].on_air, false);
});

t('“on now” drops everything that is not', () => {
    const rows = scheduleRows(SCHEDULE, { onAirOnly: true });
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every((r) => r.on_air));
    // Still by frequency, and with nothing to promote the order does not change
    // under the operator as slots start and end.
    assert.deepStrictEqual(rows.map((r) => r.freq_khz), [549, 5875]);
});

t('the search reaches past the station name', () => {
    for (const [q, want] of [['bbc', 5875], ['german', 15785], ['ranchi', 549], ['INDIA', 549]]) {
        const rows = scheduleRows(SCHEDULE, { query: q });
        assert.ok(rows.length >= 1, `no match for ${q}`);
        assert.strictEqual(rows[0].freq_khz, want, `${q} matched the wrong entry`);
    }
    assert.strictEqual(scheduleRows(SCHEDULE, { query: 'nothing here' }).length, 0);
});

t('a band filter keeps only that band', () => {
    assert.deepStrictEqual(scheduleRows(SCHEDULE, { band: 'MW' }).map((r) => r.station), ['Akashvani']);
    assert.strictEqual(scheduleRows(SCHEDULE, { band: 'SW' }).length, 2);
});

t('slots, frequencies and details are formatted for a narrow row', () => {
    assert.strictEqual(formatSlotTime(1830), '18:30');
    assert.strictEqual(formatSlotTime(5), '00:05');
    assert.strictEqual(formatSlot(SCHEDULE[0]), '05:00–06:00');
    // An all-day entry says so rather than pretending to a window.
    assert.strictEqual(formatSlot(SCHEDULE[1]), '24h');

    assert.strictEqual(formatScheduleFreq(SCHEDULE[0]), '5875 kHz');
    assert.strictEqual(formatScheduleFreq(SCHEDULE[1]), '549 kHz');
    assert.strictEqual(formatScheduleFreq(SCHEDULE[2]), '15.785 MHz');

    assert.strictEqual(scheduleDetail(SCHEDULE[0]), 'English · Woofferton, United Kingdom · 100 kW · to Europe');
    // The KiwiSDR fallback source carries none of these, and a row of bare
    // separators would be worse than a blank line.
    assert.strictEqual(scheduleDetail({ station: 'x' }), '');
    assert.strictEqual(scheduleDetail({ language: 'French', power_kw: '?' }), 'French');

    assert.strictEqual(onAirCount(SCHEDULE), 2);
    assert.strictEqual(onAirCount(null), 0);
});

t('slot times can be read in the operator’s own zone', () => {
    // Half-hour and three-quarter-hour zones are not a curiosity here: India is
    // most of the mediumwave schedule and Nepal listens to it.
    assert.strictEqual(shiftHHMM(500, 330), 1030);   // 05:00 UTC in India
    assert.strictEqual(shiftHHMM(500, 345), 1045);   // and in Nepal
    assert.strictEqual(shiftHHMM(2330, 60), 30);      // wraps forward past midnight
    assert.strictEqual(shiftHHMM(30, -60), 2330);     // and backward
    assert.strictEqual(shiftHHMM(500, 0), 500);

    // A window that straddles local midnight reads as crossing it, because it
    // does — no special case needed.
    assert.strictEqual(formatSlot({ start_utc: 1700, end_utc: 1800 }, 390), '23:30–00:30');
    // An all-day entry is on air at every moment, so it stays "24h" rather than
    // becoming an arithmetically correct and useless "05:45–05:45".
    assert.strictEqual(formatSlot({ start_utc: 0, end_utc: 2400 }, 345), '24h');

    assert.strictEqual(formatOffsetLabel(0), 'UTC');
    assert.strictEqual(formatOffsetLabel(345), 'UTC+5:45');
    assert.strictEqual(formatOffsetLabel(-240), 'UTC−4');
    assert.strictEqual(formatOffsetLabel(60), 'UTC+1');

    // Whichever the row shows, the other is in the tooltip — and the days are
    // UTC days whatever zone the times are read in.
    const both = describeSlot({ start_utc: 500, end_utc: 600, days: 'Tue, Thu' }, 345);
    assert.ok(both.includes('05:00–06:00 UTC'), both);
    assert.ok(both.includes('10:45–11:45 UTC+5:45'), both);
    assert.ok(both.includes('UTC days'), both);
    // On a machine already keeping UTC there is only one reading to give.
    const one = describeSlot({ start_utc: 500, end_utc: 600, days: 'Daily' }, 0);
    assert.strictEqual(one, '05:00–06:00 UTC');

    assert.strictEqual(typeof localOffsetMinutes(), 'number');
});

t('the tuned row is matched with the tolerance a hunt needs', () => {
    assert.ok(isTunedTo(SCHEDULE[0], 5_875_000));
    // Off centre while hunting for the lock still counts — losing the highlight
    // exactly when it is most wanted would be the wrong answer.
    assert.ok(isTunedTo(SCHEDULE[0], 5_877_000));
    assert.ok(!isTunedTo(SCHEDULE[0], 5_890_000));
    assert.ok(!isTunedTo(SCHEDULE[0], NaN));
});

// Everything below needs the fetch to have resolved, so it is one chain and the
// summary prints at the end of it.
const scheduleChain = (async () => {
    const ta = async (name, fn) => {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    };

    // Two renders: the panel fetches on the first render after the toggle is
    // clicked, and the rows appear on the one after the fetch resolves.
    const openSchedule = async (over) => {
        resetSchedule();
        globalThis.fetch = () => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
                enabled: true, loaded: true, now_utc: '2026-08-26T05:30:00Z',
                source: 'https://www.drmrx.org/schedules/drmschedules.php',
                entries: SCHEDULE,
            }),
        });

        reset();
        const ctx = context(over);
        let out = render(DRMExtension, { minimal: false }, ctx);

        const toggle = walk(out.tree).find((n) => {
            const w = words(n);
            const text = Array.isArray(w) ? w.join(' ') : String(w);
            return n.props && n.props.onClick && text.includes('Schedule');
        });
        assert.ok(toggle, 'no Schedule toggle in the panel');
        toggle.props.onClick();

        out = render(DRMExtension, { minimal: false }, ctx);   // fetch starts here
        await new Promise((r) => setTimeout(r, 0));
        out = render(DRMExtension, { minimal: false }, ctx);   // rows are in this one
        return { out, ctx };
    };

    await ta('the schedule opens and draws its rows', async () => {
        const { out } = await openSchedule();
        const text = walk(out.tree).map((n) => {
            const w = words(n);
            return Array.isArray(w) ? w.join(' ') : String(w);
        }).join(' | ');

        for (const want of ['BBC World Service', 'Akashvani', '5875 kHz', '05:00–06:00', 'Woofferton']) {
            assert.ok(text.includes(want), `schedule row missing ${want}: ${text.slice(0, 400)}`);
        }
        // "On now" is the view it opens in, so the off-air entry is not drawn.
        assert.ok(!text.includes('funklust'), 'an off-air entry was listed under "on now"');
    });

    await ta('a row tunes, and does not force IQ while stopped', async () => {
        // In AM, with the decoder stopped — the state someone is in when they
        // open the schedule to go looking for a broadcast.
        const { out, ctx } = await openSchedule({
            tuning: { frequency: 6_055_000, mode: 'am', bandwidthLow: -3000, bandwidthHigh: 3000 },
        });
        const tunes = [];
        ctx.actions.tuneTo = (req) => tunes.push(req);

        const row = walk(out.tree).find((n) => {
            const w = words(n);
            const text = Array.isArray(w) ? w.join(' ') : String(w);
            return n.props && n.props.onClick && text.includes('BBC World Service');
        });
        assert.ok(row, 'no BBC row to click');
        row.props.onClick();

        assert.strictEqual(tunes.length, 1);
        assert.strictEqual(tunes[0].frequency, 5875000);
        // The receiver is in AM here and the decoder is stopped: switching to IQ
        // would leave it playing broadband noise with nothing ducking it.
        assert.strictEqual(tunes[0].mode, 'am');
    });

    // A helper for the cases where the request succeeds but the server has no
    // schedule to give.
    const openWithBody = async (body) => {
        resetSchedule();
        globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        reset();
        const ctx = context();
        let out = render(DRMExtension, { minimal: false }, ctx);
        const toggle = walk(out.tree).find((n) => {
            const w = words(n);
            const text = Array.isArray(w) ? w.join(' ') : String(w);
            return n.props && n.props.onClick && text.includes('Schedule');
        });
        toggle.props.onClick();
        render(DRMExtension, { minimal: false }, ctx);
        await new Promise((r) => setTimeout(r, 0));
        out = render(DRMExtension, { minimal: false }, ctx);
        return walk(out.tree).map((n) => {
            const w = words(n);
            return Array.isArray(w) ? w.join(' ') : String(w);
        }).join(' ');
    };

    await ta('a receiver that could not reach drmrx.org says which end failed', async () => {
        const text = await openWithBody({
            enabled: true, loaded: false, entries: [],
            last_error: 'both sources failed: HTTP 500',
        });
        assert.ok(text.includes('could not fetch the schedule from drmrx.org'), text.slice(0, 400));
        assert.ok(text.includes('Retry'), 'no way to ask again');
    });

    await ta('a schedule too old to trust is flagged but still listed', async () => {
        const text = await openWithBody({
            enabled: true, loaded: true, stale: true, entries: SCHEDULE,
        });
        assert.ok(text.includes('more than two days old'), text.slice(0, 400));
        // Still shown: a DRM schedule changes twice a year, so an old copy is
        // very probably still right and dropping it would help nobody.
        assert.ok(text.includes('BBC World Service'), 'the stale list was dropped');
    });

    await ta('a disabled schedule says so, without offering a retry', async () => {
        const text = await openWithBody({ enabled: false, loaded: false, entries: [] });
        assert.ok(text.includes('switched off on this receiver'), text.slice(0, 300));
        assert.ok(!text.includes('Retry'), 'offered to retry something that is turned off');
    });

    await ta('a failed fetch says so instead of blanking the list', async () => {
        resetSchedule();
        globalThis.fetch = () => Promise.reject(new Error('offline'));

        reset();
        const ctx = context();
        let out = render(DRMExtension, { minimal: false }, ctx);
        const toggle = walk(out.tree).find((n) => {
            const w = words(n);
            const text = Array.isArray(w) ? w.join(' ') : String(w);
            return n.props && n.props.onClick && text.includes('Schedule');
        });
        toggle.props.onClick();
        render(DRMExtension, { minimal: false }, ctx);
        await new Promise((r) => setTimeout(r, 0));
        out = render(DRMExtension, { minimal: false }, ctx);

        const text = walk(out.tree).map((n) => {
            const w = words(n);
            return Array.isArray(w) ? w.join(' ') : String(w);
        }).join(' ');
        assert.ok(text.includes('could not be loaded'), `expected a failure note, got: ${text.slice(0, 300)}`);

        // Retry asks again rather than sitting on the failure. The failure is
        // not cached, so this is the whole of the recovery path.
        let calls = 0;
        globalThis.fetch = () => {
            calls++;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ enabled: true, loaded: true, entries: SCHEDULE }),
            });
        };
        const retry = walk(out.tree).find((n) => {
            const w = words(n);
            const label = Array.isArray(w) ? w.join(' ') : String(w);
            return n.props && n.props.onClick && label === 'Retry';
        });
        assert.ok(retry, 'no Retry button on a failed fetch');
        retry.props.onClick();
        render(DRMExtension, { minimal: false }, ctx);
        await new Promise((r) => setTimeout(r, 0));
        out = render(DRMExtension, { minimal: false }, ctx);

        // At least once: hookStub re-runs every effect on every render, so the
        // exact count is the harness's, not the component's.
        assert.ok(calls >= 1, 'Retry did not re-request');
        const after = walk(out.tree).map((n) => {
            const w = words(n);
            return Array.isArray(w) ? w.join(' ') : String(w);
        }).join(' ');
        assert.ok(after.includes('BBC World Service'), `retry did not load the list: ${after.slice(0, 300)}`);
    });
})();

scheduleChain.then(() => {
    console.log(`\n${pass} passed`);
});
