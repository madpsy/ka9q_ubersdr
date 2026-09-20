// The NTP addon: the time, off the air, as this receiver hears it.
//
// ubersdr-ntp tunes a receiver to WWV, WWVH or WWVB, decodes the broadcast time code and
// serves it as NTP on port 123 — a stratum-1 radio clock whose reference is a shortwave
// transmitter rather than another server. Beside the radio it keeps a second, deliberately
// different class of source: ordinary upstream NTP servers, measured all the time and used
// when the band dies, which it does every night.
//
// Its own page is the workbench: the signal path, every source's delay model, the event log
// and a day of charts. This is the glance — what time is it, is your own clock right, and
// where is the time coming from.
//
// ── Why the panel does its own arithmetic ────────────────────────────────────
//
// A time display that trusts `Date.now()` is not a time display: it shows the viewer's own
// clock, which is the one thing they came here to check. And a time that arrives over the
// network is late by however long it took to arrive.
//
// So the panel does what an NTP client does. It times its requests to `/api/time`, whose
// answer carries the server's receive and transmit instants, and solves for the offset from
// this page's *monotonic* clock — `performance.now()` — to the broadcast second, taking half
// the round trip as the one-way delay. The wall clock never supplies the instant, only an
// interval since a measurement, so a device three hours out still shows the right time here.
// Its time zone is used for the local reading and for nothing else.
//
// This is the addon's own page's algorithm, kept deliberately identical — see its index.html.
// The arithmetic is RFC 5905's, and the parts worth naming are:
//
//   theta   the offset to add to performance.now() to get the broadcast time.
//   delay   the round trip, less the time the server held the request.
//   err     how far out theta could be: half the round trip, since no timestamp can say
//           which way the delay went. It decays at PHI as the page's clock wanders.
//   jitter  how far out it probably is: the RMS of the other samples about the chosen one.
//           Each sample splits its delay differently, so the scatter shows how much the
//           split varies. A split that never varies would not show in it, which is why err
//           stays the bound and this is only the likely figure.
//
// ── Why /api/time and not the event stream ───────────────────────────────────
//
// The addon also serves `/api/events`, an SSE that ticks on every corrected second and
// carries the whole status document with it. The page uses it and is right to: it is one
// connection and it follows a failover as it happens.
//
// A dock panel is a different bargain. That tick is about 2.5 KB with four sources
// configured, once a second, for as long as the panel is open — 150 KB a minute to redraw a
// clock. And a tick cannot be used for the display anyway: it is stamped when it leaves the
// server, so it arrives late by exactly the amount the arithmetic above exists to remove.
// The round trip is the measurement; the stream would be a second copy of the answer.
//
// So: `/api/time` alone, a burst to converge and then one sample every POLL_MS, which is a
// few hundred bytes a minute and carries the stratum, the refid, the dispersion and the
// source count along with the timestamps. `/api/status` is read once to name the sources,
// and after that only when the served reference actually changes — see staleStatus.

import { clamp } from './format.js';

export const BASE = '/addon/ntp';

export const ADDON_NAME = 'ntp';

/** The addon's own page, the same route the Addons panel links to. */
export const addonUrl = (base = BASE) => `${base}/`;

/** Is the addon on this receiver? Same test the Lightning panel makes. */
export function ntpAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

// `seq` defeats any cache between here and the daemon. A cached time is not a time.
export const timeUrl = (seq, base = BASE) => `${base}/api/time?seq=${seq}`;
export const statusUrl = (base = BASE) => `${base}/api/status`;

// ── The measurement ──────────────────────────────────────────────────────────

// NTP's assumed frequency tolerance: how fast a sample's claim to accuracy decays as the
// page's own clock wanders away from it.
export const PHI = 15e-6;

// How many samples are kept, and the least delayed of them wins. Eight is NTP's filter
// depth and the addon's page's, and at POLL_MS the window spans MAX_SAMPLE_AGE_MS exactly.
export const WINDOW = 8;
export const MAX_SAMPLE_AGE_MS = 120000;

// The burst that starts a measurement: enough samples to fill the filter, close enough
// together that the panel is showing a corrected time within a couple of seconds of being
// looked at. Then it settles to POLL_MS, which is the whole steady-state cost of this panel.
export const BURST_GAP_MS = 250;
export const POLL_MS = 15000;
export const FETCH_TIMEOUT_MS = 3000;

// Slack beyond the samples' own error bounds before two measurements are taken to disagree.
// A real disagreement means the clock one of them describes no longer exists — the server
// stepped, or this page's monotonic clock stood still while the machine slept.
export const STEP_MS = 25;

// How far the page's monotonic clock may drift against its wall clock before every sample is
// suspect. performance.now() pauses across a sleep in some browsers and Date.now() does not,
// so the two coming apart is how a panel finds out it was asleep.
export const SLEEP_STEP_MS = 1000;

/** The empty measurement. `srv*` track the server's own estimate — see carriedTheta. */
export function newClock() {
    return { list: [], srvOffset: null, srvAt: 0, srvRate: 0 };
}

/**
 * One round trip, from the reply and the two instants this page measured it between.
 *
 * `sent` and `got` are performance.now() readings — ideally Resource Timing's requestStart
 * and responseStart, which are the instants the request reached the socket and the first
 * response byte came back. Timing fetch() itself would fold in the TCP handshake, which is
 * delay in one direction only, and asymmetry is the one error this arithmetic cannot see.
 */
export function sampleFrom(d, sent, got) {
    const rt = d && d.roundtrip;
    if (!rt) return null;
    const rx = Number(rt.receive) * 1000;
    const tx = Number(rt.transmit) * 1000;
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) return null;
    return {
        theta: ((rx - sent) + (tx - got)) / 2,
        delay: Math.max(0, (got - sent) - (tx - rx)),
        at: got,
        srvOffset: Number.isFinite(d.clock_offset_ms) ? d.clock_offset_ms : null,
        srvRate: Number(d.clock_rate_ppm) || 0,
    };
}

/**
 * A sample's offset, carried forward across any change the server has since made to its own
 * estimate.
 *
 * The served time moves against the daemon's own clock at that clock's rate even when
 * nothing has changed, and this page's clock already runs at the served rate, so only the
 * part beyond that steady movement is a change to carry.
 */
export function carriedTheta(s, clock) {
    const drift = clock.srvOffset == null || s.srvOffset == null
        ? 0
        : (clock.srvOffset - s.srvOffset) - clock.srvRate * 1e-6 * (clock.srvAt - s.at);
    return s.theta + drift;
}

/**
 * The least-delayed sample, how far out it could be, and how far out it probably is.
 *
 * @returns {{theta:number, err:number, delay:number, jitter:number|null}|null}
 */
export function bestEstimate(clock, nowPerf) {
    let best = null;
    let bestErr = Infinity;
    for (const s of clock.list) {
        const err = s.delay / 2 + Math.max(0, nowPerf - s.at) * PHI;
        if (err < bestErr) { bestErr = err; best = s; }
    }
    if (!best) return null;
    const theta = carriedTheta(best, clock);
    let sq = 0;
    let n = 0;
    for (const s of clock.list) {
        if (s === best) continue;
        const d = carriedTheta(s, clock) - theta;
        sq += d * d;
        n++;
    }
    return { theta, err: bestErr, delay: best.delay, jitter: n ? Math.sqrt(sq / n) : null };
}

/**
 * Fold a sample in, discarding the window first if it describes a clock that no longer
 * exists. Returns a new clock; the old one is left alone.
 */
export function addSample(clock, s) {
    if (!s) return clock;
    // The server's estimate is taken from this sample before anything is compared against
    // it, so the existing samples are carried forward to the same footing it is on.
    const moved = { list: clock.list, srvOffset: s.srvOffset, srvAt: s.at, srvRate: s.srvRate || 0 };
    const cur = bestEstimate(moved, s.at);
    // Two honest samples cannot disagree by more than their error bounds allow.
    const kept = cur && Math.abs(s.theta - cur.theta) > s.delay / 2 + cur.err + STEP_MS
        ? []
        : moved.list;
    const list = kept.concat([s])
        .filter((x) => s.at - x.at <= MAX_SAMPLE_AGE_MS)
        .slice(-WINDOW);
    return { ...moved, list };
}

/**
 * Is this estimate stale — does it place the broadcast second before a tick that has already
 * been stamped, or is it simply older than the window?
 *
 * Only worth asking of a reading taken while the panel was being looked at: a background tab
 * holds timers back, and a sample that arrived during one is late for reasons that say
 * nothing about the clock.
 */
export function clockAsleep(wallMinusPerf, prev) {
    return prev != null && Math.abs(wallMinusPerf - prev) > SLEEP_STEP_MS;
}

// ── What the figures mean ────────────────────────────────────────────────────

/**
 * This device's own clock against the broadcast, in milliseconds, positive when the device
 * reads ahead.
 *
 * Date.now() is whole milliseconds, truncated, so it is read from the middle of its
 * millisecond and that half is part of the answer.
 */
export function deviceError(est, wallNow, perfNow) {
    if (!est) return null;
    return wallNow + 0.5 - (perfNow + est.theta);
}

/**
 * How close this measurement can claim to be. The likely figure where there is one — the
 * scatter between samples — and the bound where there is not, plus the half millisecond the
 * wall clock's truncation costs.
 */
export function deviceWithin(est) {
    if (!est) return null;
    // The likely figure can come out above the bound when the other samples were slower
    // ones. The bound still holds, so it caps it.
    const likely = est.jitter == null ? null : Math.min(est.jitter, est.err);
    return 0.5 + (likely == null ? est.err : likely);
}

/**
 * The device's error as a person reads it. Inside the measurement's own uncertainty it is
 * not called fast or slow, because at that point the measurement cannot tell.
 */
export function deviceLabel(device, within) {
    if (device == null) return 'measuring…';
    const a = Math.abs(device);
    if (within != null && a <= within) return `within ±${within.toFixed(within < 1 ? 1 : 0)} ms`;
    const mag = a < 1000 ? `${a.toFixed(0)} ms`
        : a < 60000 ? `${(a / 1000).toFixed(1)} s`
            : formatDur(a / 1000);
    return `${mag} ${device > 0 ? 'fast' : 'slow'}`;
}

/**
 * Green, amber or red for a device clock.
 *
 * 20 ms is the floor on "fine" whatever the measurement claims: below that the error is
 * smaller than the jitter of the path it was measured over, and nobody's clock needs to be
 * better than that to be right. Half a second is where it stops being a curiosity — that is
 * a clock a person would notice against a phone, and enough to matter to a logging program.
 */
export function deviceTone(device, within) {
    if (device == null) return 'dim';
    const a = Math.abs(device);
    if (a <= Math.max(20, within || 0)) return 'ok';
    return a < 500 ? 'warn' : 'bad';
}

/** The addon's own thresholds for root dispersion, so a figure amber here is amber there. */
export function dispersionTone(ms) {
    if (ms == null || !Number.isFinite(ms)) return 'dim';
    return ms < 50 ? 'ok' : ms < 250 ? 'warn' : 'bad';
}

// ── The dial ─────────────────────────────────────────────────────────────────
//
// The device's error, drawn rather than read: a scale with the broadcast at the centre, the
// measurement's own uncertainty as a band around it, and a marker where this machine's clock
// actually sits. A number says 42 ms; the dial says whether 42 ms is a lot, which depends
// entirely on how well the time got here — and that is the band.

// The narrowest the scale goes. Tighter than this and the marker jitters across the whole
// width on a clock that is, for every practical purpose, correct.
export const DIAL_MIN_MS = 50;

export const DIAL_STEPS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];

/**
 * Half the scale, in milliseconds: a round number wide enough for the marker and for the
 * uncertainty band, so the axis labels stay readable and the scale does not change on every
 * sample.
 */
export function dialSpan(device, within) {
    const need = Math.max(
        Math.abs(device || 0) * 1.25,
        (within || 0) * 3,
        DIAL_MIN_MS,
    );
    for (const step of DIAL_STEPS) if (need <= step) return step;
    return Math.ceil(need / 60000) * 60000;
}

/** Where a figure sits on the dial, 0 at the left edge and 1 at the right. */
export function dialPos(ms, span) {
    if (!span) return 0.5;
    return clamp(0.5 + (Number(ms) || 0) / (2 * span), 0, 1);
}

/** The axis label for the dial's ends, which are ±span. */
export function dialEdge(span) {
    return span >= 1000 ? `${span / 1000}s` : `${span}ms`;
}

// ── Where the time is coming from ────────────────────────────────────────────

export const STATION_LABEL = { wwv: 'WWV', wwvh: 'WWVH', wwvb: 'WWVB' };

/**
 * Which stations are in the answer, commonest first.
 *
 * The refid is one four-character label and has to name a single station, but the served
 * time can be a consensus over two of them at once — so the refid alone says "WWVH" while
 * two of three sources are on WWV. The mix is what is true; the refid stays in the tooltip,
 * because it is the value a client sees on the wire.
 *
 * Ties are broken alphabetically so the order cannot flicker between reads.
 */
export function stationMix(sources) {
    const counts = new Map();
    for (const s of sources || []) {
        if (s.kind !== 'radio' || !s.in_use) continue;
        const name = STATION_LABEL[s.station]
            || (s.station ? String(s.station).toUpperCase() : '');
        if (!name) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
    }
    if (!counts.size) return null;
    const by = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
        text: by.map((e) => e[0]).join(' + '),
        detail: by.map((e) => `${e[1]} × ${e[0]}`).join(', '),
    };
}

/**
 * What the panel says the reference is: a label, the sources behind it, and which class.
 *
 * `time` is the last `/api/time`, which always exists once anything has answered. `status`
 * is the last `/api/status`, which names the sources and may be absent or a few minutes old
 * — so everything here degrades to what the timestamps alone can say.
 *
 * The stratum decides the class, and it is not always 1: it is 1 while a radio source is in
 * the answer, and one below the upstream's when the time has failed over to an NTP server.
 * Saying "stratum 1" regardless would be the one lie this panel could tell that somebody
 * would act on.
 */
export function referenceOf(time, status) {
    if (!time || !time.synchronised) {
        return { kind: 'none', text: '—', sub: 'unsynchronised', detail: '' };
    }
    const served = (status && status.served) || null;
    const names = (served && served.used_names) || [];
    const mix = stationMix(status && status.sources);
    const refid = time.refid || '';
    if (mix) {
        return {
            kind: 'radio',
            text: mix.text,
            sub: names.length ? names.join(', ') : 'off air',
            detail: `${mix.detail} · refid ${refid}`,
        };
    }
    // No radio source in the answer. Either the status document has not been read yet — in
    // which case the stratum still says which class is serving — or the time has failed over
    // to an upstream, whose refid is its address.
    const upstream = Number(time.stratum) > 1;
    if (!upstream && !status) {
        return { kind: 'radio', text: refid || 'radio', sub: 'naming sources…', detail: '' };
    }
    return {
        kind: upstream ? 'ntp' : 'radio',
        text: upstream ? 'NTP' : (refid || 'radio'),
        sub: names.length ? names.join(', ') : (refid || '—'),
        detail: `refid ${refid}`,
    };
}

/**
 * Whether the arrangement is the one it was set up to be, said in a few words.
 *
 * Null when there is nothing to report, which is the common case and the one worth keeping
 * quiet: a panel that says "serving from the radio" every second of every day has spent a
 * line on something that was never in doubt.
 */
export function servingNote(status) {
    const k = (status && status.clock) || null;
    if (!k) return null;
    if (k.serving === 'secondary') {
        return { tone: 'bad', text: `failed over to ${k.secondary || 'standby'}` };
    }
    if (k.serving === 'coasting') {
        return { tone: 'warn', text: 'coasting — no source is ready' };
    }
    if (k.serving === 'none') return { tone: 'bad', text: 'no source' };
    if (k.failover_in_seconds != null) {
        return { tone: 'warn', text: `failing over in ${Math.round(k.failover_in_seconds)}s` };
    }
    if (k.failback_in_seconds != null) {
        return { tone: 'warn', text: `failing back in ${Math.round(k.failback_in_seconds)}s` };
    }
    return null;
}

/**
 * Should `/api/status` be read again?
 *
 * It is the expensive document — every source's decoder, delay model and link, which is
 * kilobytes — and almost all of it is unchanged from one minute to the next. What does
 * change is which sources are in the answer, and `/api/time` says so on every sample: the
 * stratum, the refid and how many sources were used. So the panel reads the status document
 * when that key moves, and otherwise only often enough to catch a source coming or going
 * without changing the answer.
 *
 * @param prevKey  the key the current status document was fetched for, or null.
 * @param key      the key the newest /api/time gives.
 * @param age      how long ago the status document was fetched, in ms.
 */
export const STATUS_MIN_MS = 10000;
export const STATUS_MAX_MS = 300000;

export function staleStatus(prevKey, key, age) {
    if (prevKey == null) return true;
    if (age >= STATUS_MAX_MS) return true;
    return key !== prevKey && age >= STATUS_MIN_MS;
}

/** The key above: what `/api/time` can say about where the time came from. */
export function referenceKey(time) {
    if (!time) return '';
    return `${time.synchronised ? 1 : 0}|${time.stratum}|${time.refid || ''}|${time.sources_used}`;
}

// ── Formatting ───────────────────────────────────────────────────────────────

const pad = (n, w = 2) => String(n).padStart(w, '0');

// ── The milliseconds, and what they cost ─────────────────────────────────────
//
// Showing them is the point of the panel: a clock that ticks on the broadcast second rather
// than on this machine's is only visibly doing so if the fraction is moving. But a three
// digit readout has to be repainted every frame, which means an animation frame callback for
// as long as the panel is on screen — and somebody watching a waterfall does not necessarily
// want a 60 Hz repaint in the corner for a figure they are not reading.
//
// So it is a choice, and turning it off is a real saving rather than a cosmetic one: with
// the fraction hidden the panel stops using requestAnimationFrame altogether and redraws
// once a second, on a timer that re-aims itself at each corrected second boundary. See
// nextSecondDelay, and the paint effect in TimePanel.

const MS_KEY = 'ubersdr.v2.time.showMs';

/** Whether to draw the fraction. On by default — see above. */
export function savedShowMs() {
    try {
        return localStorage.getItem(MS_KEY) !== '0';
    } catch (err) {
        return true;
    }
}

export function saveShowMs(on) {
    try { localStorage.setItem(MS_KEY, on ? '1' : '0'); } catch (err) { /* private browsing */ }
}

// Whether the reference is drawn: "WWV · local-10", or "NTP · time.cloudflare.com".
//
// On by default, because a time whose source is not stated is worth less than one that is —
// a clock reading the same to the millisecond means something quite different coming off WWV
// than off a server on the other side of an ocean, and the whole argument for a radio clock
// is about where the time came from rather than what it says.
//
// It is a choice because it is a *label*: somebody who has checked once that this receiver
// is serving from the radio knows what the source is, and on a phone that line is a fifth of
// the panel. Like the fraction, the answer applies wherever the panel is drawn.
//
// What it deliberately does NOT hide is a failover. "Failed over to ntp" is not a label, it
// is news — the arrangement is not the one it was set up to be — and a display preference
// that could quietly suppress it would be the one thing in this panel capable of misleading
// somebody. See servingNote, which the full view draws whether or not this is on.
//
// The cut-down view drops that sentence, because there it is not lost: the pill is already
// amber and already reads NTP, which is the same fact in the space there is for it.
//
// It changes nothing about what is fetched: the reference is known either way.
const REF_KEY = 'ubersdr.v2.time.showRef';

export function savedShowRef() {
    try {
        return localStorage.getItem(REF_KEY) !== '0';
    } catch (err) {
        return true;
    }
}

export function saveShowRef(on) {
    try { localStorage.setItem(REF_KEY, on ? '1' : '0'); } catch (err) { /* private browsing */ }
}

// ── The three clocks, and which of them is the big one ───────────────────────
//
// There are three times worth knowing in front of a remote receiver, and they are all
// different: UTC, because that is what the radio world is logged and scheduled in; the
// receiver's own wall clock, because a net at "19:30 local" means local to the aerial and
// not to the listener; and the listener's, because that is when supper is.
//
// So the big figures are a cycle rather than a switch: clicking the clock moves to the next
// one and the others stay beneath it, small. Which one is big is remembered, because it is
// about how somebody operates rather than about this minute. Same three-state reasoning as
// the top bar's clock — see lib/topClock.js — arrived at from the same place.
//
// Two of them coincide more often than not: most receivers are set to UTC, and the ones that
// are not are quite often in the operator's own zone. Two clocks reading the same figure
// twice looks like a bug, so faces that land on the same offset are merged into one that
// says so — "UTC · receiver", "receiver · you" — and the cycle then has two stops, or one.
// Merging on the offset rather than on the zone name is deliberate: two different zones on
// the same offset are the same reading for as long as they stay that way, and the panel
// redraws them every second, so a summer-time boundary splits them apart on its own.

export const CLOCK_KEYS = ['utc', 'rx', 'me'];

const BIG_KEY = 'ubersdr.v2.time.bigClock';

/** Which clock is in the big figures. UTC by default — it is what the panel is for. */
export function savedBigClock() {
    try {
        const v = localStorage.getItem(BIG_KEY);
        return CLOCK_KEYS.includes(v) ? v : CLOCK_KEYS[0];
    } catch (err) {
        return CLOCK_KEYS[0];
    }
}

export function saveBigClock(key) {
    const v = CLOCK_KEYS.includes(key) ? key : CLOCK_KEYS[0];
    try { localStorage.setItem(BIG_KEY, v); } catch (err) { /* private browsing */ }
    return v;
}

// A formatter per zone, because building one is the expensive part and this is asked once a
// second. A zone the engine does not know throws on construction, and the null is cached
// too — there is no point finding that out sixty times a minute either.
const zoneFmt = new Map();

/**
 * Minutes east of UTC for an IANA zone at `at`, or null if it cannot be resolved.
 *
 * Read out of the zone database rather than taken from the server's number, so it is still
 * right on the far side of a summer-time change in a session that was left open across one —
 * `receiver.timezone_offset` is computed when /api/description is answered and then never
 * again. The number is the fallback for a server too old to send the name, or an operator
 * who left it unset: see receiverOffsetMin.
 */
export function zoneOffsetMin(zone, at = Date.now()) {
    const name = typeof zone === 'string' ? zone.trim() : '';
    if (!name) return null;
    let fmt = zoneFmt.get(name);
    if (fmt === undefined) {
        try {
            fmt = new Intl.DateTimeFormat('en-GB', {
                timeZone: name,
                hour12: false,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
            });
        } catch (err) {
            fmt = null;                       // not a zone this engine knows
        }
        zoneFmt.set(name, fmt);
    }
    if (!fmt) return null;
    try {
        const part = {};
        for (const p of fmt.formatToParts(new Date(at))) part[p.type] = p.value;
        // hour12:false says 24 for midnight on some engines and 0 on others.
        const hour = Number(part.hour) % 24;
        const wall = Date.UTC(
            Number(part.year), Number(part.month) - 1, Number(part.day),
            hour, Number(part.minute), Number(part.second),
        );
        if (!Number.isFinite(wall)) return null;
        // Against the same instant truncated to the second, which is what the parts are.
        return Math.round((wall - Math.floor(at / 1000) * 1000) / 60000);
    } catch (err) {
        return null;
    }
}

/**
 * The receiver's offset from UTC, or null where the receiver has not said.
 *
 * `rx` is `receiver` from /api/description: `timezone` is the IANA name and
 * `timezone_offset` the DST-adjusted minutes, both from the operator's one `admin.timezone`
 * setting. The name is preferred because it keeps working — see zoneOffsetMin. Null means
 * there is no receiver clock to show at all, rather than a guess: the browser's own zone
 * would be a plausible-looking wrong answer, and this panel is about not doing that.
 */
export function receiverOffsetMin(rx, at = Date.now()) {
    if (!rx) return null;
    const fromZone = zoneOffsetMin(rx.timezone, at);
    if (fromZone != null) return fromZone;
    const n = Number(rx.timezone_offset);
    return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * The clocks this panel can show, in the order they are offered, with coincidences merged.
 *
 * Each face is `{ key, keys, offsetMin, label, zone, zones }`: `key` is what is remembered
 * and cycled on, `keys` everything the face stands for once merged, and `label` reads as the
 * merge — "UTC", "receiver · you". There is always at least one, and UTC is always in it.
 *
 * `zone` is the face's place, and only where the merged clocks agree on one. Two zones on
 * the same offset are the same reading but not the same place — somebody in Lisbon
 * listening to a receiver in London is reading one figure for two countries — and naming
 * either of them would put the wrong country under half the people's clocks. So a
 * disagreement leaves the face nameless and faceText falls back to the offset, which is
 * true of both. `zones` keeps what was actually offered, in order, for anything that wants
 * to say more than one line's worth.
 */
export function clockFaces(rx, at = Date.now()) {
    const faces = [];
    const add = (key, offsetMin, label, zone) => {
        if (offsetMin == null || !Number.isFinite(offsetMin)) return;
        const same = faces.find((f) => f.offsetMin === offsetMin);
        if (same) {
            same.keys.push(key);
            same.label = `${same.label} · ${label}`;
            if (zone && !same.zones.includes(zone)) same.zones.push(zone);
            same.zone = same.zones.length === 1 ? same.zones[0] : '';
            return;
        }
        faces.push({
            key, keys: [key], offsetMin, label, zone: zone || '', zones: zone ? [zone] : [],
        });
    };
    const rxZone = rx && typeof rx.timezone === 'string' ? rx.timezone.trim() : '';
    add('utc', 0, 'UTC', '');
    add('rx', receiverOffsetMin(rx, at), 'receiver', rxZone);
    add('me', -new Date(at).getTimezoneOffset(), 'you', browserZone());
    return faces;
}

/** The face a remembered key means now — the one that stands for it, or the first. */
export function faceFor(faces, key) {
    const list = faces || [];
    return list.find((f) => f.keys.includes(key)) || list[0] || null;
}

/** The next one round the cycle. */
export function nextFaceKey(faces, key) {
    const list = faces || [];
    if (!list.length) return CLOCK_KEYS[0];
    const at = list.indexOf(faceFor(list, key));
    return list[(at + 1) % list.length].key;
}

/**
 * What a face says it is, beside the figures.
 *
 * `long` adds where it is — the zone name where one is known, and the offset where one is
 * not, which is the case for a receiver on an old server and for a browser with no zone
 * database. Neither is added where it would only repeat the label: "UTC · UTC+00:00" tells
 * nobody anything, and a receiver whose zone is literally named UTC has already said so.
 */
export function faceText(face, long) {
    if (!face) return '';
    if (!long) return face.label;
    const zone = face.zone && face.zone.toUpperCase() !== 'UTC' ? face.zone : '';
    const where = zone || (face.offsetMin !== 0 ? offsetText(face.offsetMin) : '');
    return where ? `${face.label} · ${where}` : face.label;
}

/** A face's reading at `t`, from the UTC fields of a shifted epoch — as the top bar does. */
export function facePartsAt(face, t) {
    return clockParts(t + (face ? face.offsetMin : 0) * 60000, true);
}

/** The date that belongs to that reading, which is not always UTC's. */
export function faceDateAt(face, t) {
    return new Date(t + (face ? face.offsetMin : 0) * 60000).toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
}

// How long after the boundary the once-a-second redraw aims for. Landing a hair late is
// right and landing early is not: a redraw that arrives at 11.9997 s paints the second
// before, and the clock then reads a second slow until the next one.
export const SECOND_MARGIN_MS = 4;

/**
 * How long until just after `t` crosses its next second boundary.
 *
 * Re-aimed from the corrected time on every redraw rather than set once at 1000 ms, because
 * the corrected second moves whenever the served offset does — which is precisely what is
 * happening during a failover, the one time somebody is watching.
 */
export function nextSecondDelay(t) {
    const into = ((t % 1000) + 1000) % 1000;
    return 1000 - into + SECOND_MARGIN_MS;
}

/** HH:MM:SS and the milliseconds separately, so the fraction can be set smaller. */
export function clockParts(ms, utc = true) {
    const d = new Date(ms);
    const h = utc ? d.getUTCHours() : d.getHours();
    const m = utc ? d.getUTCMinutes() : d.getMinutes();
    const s = utc ? d.getUTCSeconds() : d.getSeconds();
    const f = utc ? d.getUTCMilliseconds() : d.getMilliseconds();
    return { hms: `${pad(h)}:${pad(m)}:${pad(s)}`, frac: pad(f, 3) };
}

/** An offset in minutes east of UTC, as a person writes it. */
export function offsetText(min) {
    const off = Number.isFinite(min) ? Math.round(min) : 0;
    const sign = off >= 0 ? '+' : '−';
    return `UTC${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** This machine's offset from UTC, as a person writes it. */
export function utcOffsetText(date) {
    return offsetText(-date.getTimezoneOffset());
}

/** The IANA zone the browser is in, where it will name one. */
export function browserZone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (err) {
        return '';                            // an engine with no zone database
    }
}

/** The IANA zone where the browser will name one, and the offset either way. */
export function zoneLabel(date) {
    const zone = browserZone();
    const off = utcOffsetText(date);
    return zone ? `${zone} · ${off}` : off;
}

/** Whether local time is UTC, in which case showing both is showing one thing twice. */
export function localIsUtc(date) {
    return date.getTimezoneOffset() === 0;
}

export function formatDur(s) {
    if (s == null || !Number.isFinite(s) || s >= 1e8) return 'never';
    if (s < 90) return `${s.toFixed(0)}s`;
    if (s < 5400) return `${(s / 60).toFixed(0)}m`;
    if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
}

/** A millisecond figure at a sensible number of places for its size. */
export function formatMs(ms, places) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const a = Math.abs(ms);
    const dp = places != null ? places : a < 10 ? 1 : 0;
    return `${ms.toFixed(dp)}`;
}
