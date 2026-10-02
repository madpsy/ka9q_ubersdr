// A clock: the time, as pulses, tones, a schedule, words and numbers.
//
// The time is the page's to find (playground/timeSource.js): with every packet
// comes every reading of it there is — the NTP addon's off-air time, the
// receiver's clock, this device's, and the moment the packet's first sample
// was captured — and this block chooses (chooseTime). The choice is the
// `source` setting, and where that clock is not there — a receiver without the
// NTP addon, a graph with no receiver to stamp its samples — the next one is
// used and the card says so. A clock always has some clock, so this block is
// never idle; only less sure.
//
// ── Following the signal, or the page ───────────────────────────────────────
//
// Aligned to the signal (the default), a sample's time is when it was captured
// at the receiver: radiod stamps the stream by counting samples of a GPSDO-
// locked A/D from one anchor (capture_time.go), so the stamps are exact to the
// sample and the sample rate is as good as the GPSDO. A pulse on the UTC second
// then sits where that second fell in the signal itself, and a received time
// signal's tick arrives after it by its propagation and nothing else. The
// stamps are on the receiver's clock; where the NTP addon can be measured too
// they are corrected to its time.
//
// Aligned to the page — or wherever there are no stamps, as in a graph that
// runs without the receiver — a sample's time is the chosen clock's reading as
// the page sends the packet, smoothed from packet to packet so the page's own
// timing does not jitter the pulses.
//
// ── What comes out ──────────────────────────────────────────────────────────
//
//   pps       a pulse every so many seconds, on the second, `ppsWidthMs` long
//   pips      a short tone each second and a long one on the minute, to hear
//   tone      a sine of `toneHz` whose phase is set by the time itself, so two
//             runs, or two receivers, agree on it
//   carrier   the same as a complex tone of `carrierHz` — 0 Hz is the tuned
//             frequency, so on 10 MHz it is a 10 MHz reference to set against
//             a standard-frequency carrier
//   window    1 during a schedule — `windowLength` seconds from `windowFrom`,
//             every `windowEvery` — and 0 outside it
//   text      the time in words, each second, minute, hour or period — and
//             once straight away, so whatever it is wired to shows it now
//   unix, second, minute, hour    as controls, once a second
//   open      the window as a control, when it changes
//   accuracy  how far out the time could be, in ms, once a second (not sent
//             when nobody can say — this device's clock)

import { COMPLEX, CONTROL, MESSAGE, REAL, emitControl } from '../block.js';

const SOURCE_LABEL = {
    ntp: 'NTP add-on (off-air)',
    receiver: 'Receiver clock',
    device: 'This device',
    wired: 'Wired in',
};

/**
 * The UTC of an NMEA sentence, Unix ms, or null: $--RMC (time, status A, date)
 * or $--ZDA (time, day, month, year), any talker. The checksum, where there is
 * one, must match. What a GPS's sentence names is the second that began at its
 * last PPS edge, and it arrives a fraction of a second after it.
 */
export function parseNmea(line) {
    const m = /^\$([A-Z]{2})(RMC|ZDA),([^*]*)(?:\*([0-9A-Fa-f]{2}))?\s*$/.exec(String(line).trim());
    if (!m) return null;
    if (m[4] != null) {
        const body = `${m[1]}${m[2]},${m[3]}`;
        let sum = 0;
        for (let k = 0; k < body.length; k++) sum ^= body.charCodeAt(k);
        if (sum !== parseInt(m[4], 16)) return null;
    }
    const parts = m[3].split(',');
    const hms = (v) => {
        const r = /^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/.exec(v || '');
        return r ? (Number(r[1]) * 3600 + Number(r[2]) * 60 + Number(r[3])) * 1000 : null;
    };
    let tod;
    let y;
    let mo;
    let d;
    if (m[2] === 'RMC') {
        if (parts[1] !== 'A') return null;
        tod = hms(parts[0]);
        const r = /^(\d{2})(\d{2})(\d{2})$/.exec(parts[8] || '');
        if (!r) return null;
        d = Number(r[1]); mo = Number(r[2]); y = 2000 + Number(r[3]);
    } else {
        tod = hms(parts[0]);
        d = Number(parts[1]); mo = Number(parts[2]); y = Number(parts[3]);
    }
    if (tod == null || !(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1970)) return null;
    return Date.UTC(y, mo - 1, d) + tod;
}

// How long what is wired in counts as fresh: a time code decoder speaks each
// second, a GPS each second, a PPS each second.
const WIRED_FRESH_MS = 5000;
const PPS_FRESH_MS = 2500;
// How hard a PPS edge pulls the clock onto its second.
const PPS_GAIN = 0.3;

/**
 * Which time a Clock with settings `p` takes from a packet's `time`, as
 * `{ t0, err, src, signal, label, note }`: the time of the packet's first
 * sample in Unix ms, how far out it could be (null where nobody can say), which
 * clock it came from, whether it follows the signal, a label for the card, and
 * a note where it is not what was asked for.
 */
export function chooseTime(time, p) {
    if (!time) return null;
    // "Wired in" falls back as "best there is" does when nothing wired speaks.
    const want = !p.source || p.source === 'wired' ? 'auto' : p.source;
    const ntpMissing = !time.ntpOffered
        ? 'No NTP add-on on this receiver'
        : 'The NTP add-on is not answering yet';
    const rxLabel = `${SOURCE_LABEL.receiver}${time.hostSynced ? ', synchronised' : ', not known to be synchronised'}`;
    // Following the signal: the capture stamps, on the receiver's clock,
    // corrected to the addon's time where both have been measured.
    if (p.align !== 'page' && time.capture != null && want !== 'device') {
        const corrected = (want === 'auto' || want === 'ntp') && time.hostToUtc;
        let note = '';
        if (want === 'ntp' && !time.hostToUtc) note = `${ntpMissing} — the signal's capture times on the receiver's clock instead`;
        return {
            t0: time.capture + (corrected ? time.hostToUtc.off : 0),
            err: corrected ? time.hostToUtc.err : null,
            src: corrected ? 'ntp' : 'receiver',
            signal: true,
            label: corrected ? `${SOURCE_LABEL.ntp}, at the signal` : `${rxLabel}, at the signal`,
            note,
        };
    }
    const order = want === 'device' ? ['device'] : want === 'receiver' ? ['receiver', 'device'] : ['ntp', 'receiver', 'device'];
    for (const k of order) {
        const c = time[k];
        if (!c) continue;
        let note = '';
        if (k !== order[0] && want !== 'auto') {
            note = `${order[0] === 'ntp' ? ntpMissing : 'The receiver\'s clock has not been measured yet'} — using ${k === 'device' ? 'this device\'s clock' : 'the receiver\'s clock'}`;
        }
        if (p.align !== 'page' && want !== 'device') {
            note = note ? `${note}. ` : '';
            note += time.capture == null ? 'No capture times here, so it follows the page' : '';
        }
        return { t0: c.t0, err: c.err, src: k, signal: false, label: k === 'receiver' ? rxLabel : SOURCE_LABEL[k], note: note.trim() };
    }
    return null;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** The parts of a time, in UTC or this machine's zone. */
export function timeParts(ms, zone) {
    const d = new Date(ms);
    const utc = zone !== 'local';
    return {
        y: utc ? d.getUTCFullYear() : d.getFullYear(),
        mo: (utc ? d.getUTCMonth() : d.getMonth()) + 1,
        d: utc ? d.getUTCDate() : d.getDate(),
        h: utc ? d.getUTCHours() : d.getHours(),
        m: utc ? d.getUTCMinutes() : d.getMinutes(),
        s: utc ? d.getUTCSeconds() : d.getSeconds(),
        offMin: utc ? 0 : -d.getTimezoneOffset(),
    };
}

/** A time as the Clock's text output writes it. */
export function clockText(ms, format, zone) {
    const t = timeParts(ms, zone);
    const z = zone === 'local' ? '' : ' UTC';
    switch (format) {
        case 'iso': {
            const off = t.offMin === 0 && zone !== 'local' ? 'Z'
                : `${t.offMin < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(t.offMin) / 60))}:${pad(Math.abs(t.offMin) % 60)}`;
            return `${t.y}-${pad(t.mo)}-${pad(t.d)}T${pad(t.h)}:${pad(t.m)}:${pad(t.s)}${off}`;
        }
        case 'hhmmz':
            return `${pad(t.h)}${pad(t.m)}${zone === 'local' ? '' : 'Z'}`;
        case 'spoken':
            return t.s ? `It is ${pad(t.h)}:${pad(t.m)} and ${t.s} second${t.s === 1 ? '' : 's'}${z}` : `It is ${pad(t.h)}:${pad(t.m)}${z}`;
        default:
            return `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}${z}`;
    }
}

// The fraction of a cycle a tone of `hz` is through at Unix time `ms`, taken
// in two parts so the whole seconds — a large number — do not cost the
// fraction its precision.
function cycles(hz, ms) {
    const sec = Math.floor(ms / 1000);
    const frac = (ms - sec * 1000) / 1000;
    const whole = hz * sec;
    const c = (whole - Math.floor(whole)) + hz * frac;
    return c - Math.floor(c);
}

const mod = (a, b) => ((a % b) + b) % b;

// How far the page's reading of a packet may be from where this clock already
// is before it is taken as a step, not jitter.
const STEP_MS = 200;
// How much of the gap to the page's reading is closed each packet.
const SLEW = 0.1;

const num = (label, def, extra = {}) => ({ kind: 'number', label, default: def, live: true, ...extra });
const choice = (label, def, options) => ({ kind: 'choice', label, default: def, options });

export const ClockBlock = {
    type: 'clock',
    label: 'Clock',
    category: 'Sources',
    summary: 'The time — off the air from the NTP add-on where there is one — as a 1 PPS pulse, pips, a time-locked tone or carrier, a schedule window, words and numbers.',
    // Optional: time wired in from the graph — a Time code decoder's, or a
    // GPS's NMEA from a Serial port — and a PPS whose edges mark the seconds.
    inputs: [
        { name: 'time', kind: MESSAGE, optional: true },
        { name: 'pps', kind: REAL, optional: true, audio: false },
    ],
    outputs: [
        { name: 'pps', kind: REAL, audio: false },
        { name: 'pips', kind: REAL },
        { name: 'tone', kind: REAL },
        { name: 'carrier', kind: COMPLEX },
        { name: 'window', kind: REAL, audio: false },
        { name: 'text', kind: MESSAGE },
        { name: 'unix', kind: CONTROL },
        { name: 'second', kind: CONTROL },
        { name: 'minute', kind: CONTROL },
        { name: 'hour', kind: CONTROL },
        { name: 'open', kind: CONTROL },
        { name: 'accuracy', kind: CONTROL },
    ],
    params: {
        source: choice('Source', 'auto', [
            { value: 'auto', label: 'Best there is' },
            { value: 'ntp', label: 'NTP add-on (off-air)' },
            { value: 'receiver', label: 'Receiver clock' },
            { value: 'device', label: 'This device' },
            { value: 'wired', label: 'Wired in (time code, GPS, PPS)' },
        ]),
        propagationMs: num('Propagation delay', 0, { unit: 'ms', min: 0, max: 200, step: 0.01 }),
        align: choice('Align to', 'signal', [
            { value: 'signal', label: 'The signal (when it was captured)' },
            { value: 'page', label: 'The page (now)' },
        ]),
        zone: choice('Time zone', 'utc', [{ value: 'utc', label: 'UTC' }, { value: 'local', label: 'This machine\'s' }]),
        ppsEvery: choice('Pulse every', 1, [1, 2, 5, 10, 15, 30, 60].map((s) => ({ value: s, label: s === 60 ? 'minute' : `${s} s` }))),
        ppsWidthMs: num('Pulse width', 100, { unit: 'ms', min: 0.1, max: 900, step: 0.1 }),
        ppsOffsetMs: num('Pulse offset', 0, { unit: 'ms', min: -500, max: 500, step: 0.1 }),
        pipHz: num('Pip pitch', 1000, { unit: 'Hz', min: 100, max: 4000, step: 10 }),
        pipMs: num('Pip length', 100, { unit: 'ms', min: 5, max: 500, step: 5 }),
        minutePipMs: num('Minute pip length', 500, { unit: 'ms', min: 5, max: 900, step: 5 }),
        toneHz: num('Tone', 1000, { unit: 'Hz', min: 0, max: 24000, step: 0.001 }),
        carrierHz: num('Carrier offset', 0, { unit: 'Hz', min: -96000, max: 96000, step: 0.001 }),
        windowEvery: num('Window every', 60, { unit: 's', min: 1, max: 86400, step: 1 }),
        windowFrom: num('Window from', 0, { unit: 's', min: 0, max: 86400, step: 0.1 }),
        windowLength: num('Window lasts', 15, { unit: 's', min: 0.1, max: 86400, step: 0.1 }),
        announce: choice('Say the time', 'minute', [
            { value: 'off', label: 'Never' },
            { value: 'second', label: 'Every second' },
            { value: 'period', label: 'Every pulse' },
            { value: 'minute', label: 'Every minute' },
            { value: 'hour', label: 'Every hour' },
        ]),
        format: choice('Written as', 'hms', [
            { value: 'hms', label: '12:34:56 UTC' },
            { value: 'iso', label: 'ISO 8601' },
            { value: 'hhmmz', label: '1234Z (for CW)' },
            { value: 'spoken', label: 'It is 12:34 UTC (to speak)' },
        ]),
    },
    create() {
        let p = {};
        let rate = 48000;
        let t = null;          // Unix ms of the next sample
        let chosen = null;     // chooseTime's answer, as last fed
        let pending = null;
        let stepKey = '';
        let open = null;
        // Whether the time has been said since starting, or since "Say the
        // time" changed: it is said once at once, so a console wired to it
        // shows something now rather than at the top of the next minute.
        let saidFirst = false;
        let announce = null;
        // What is wired in: when it last spoke (in this clock's time), what it
        // was, and the PPS's prior level and residuals.
        let wiredAt = -Infinity;
        let wiredWhat = '';
        let ppsAt = -Infinity;
        let ppsPrev = null;
        let ppsResid = [];
        let nmeaPartial = '';
        return {
            configure(params, r) {
                p = params;
                rate = r || rate;
                if (params.announce !== announce) { announce = params.announce; saidFirst = false; }
            },
            reset() {
                t = null; chosen = null; pending = null; stepKey = ''; open = null; saidFirst = false;
                wiredAt = -Infinity; wiredWhat = ''; ppsAt = -Infinity; ppsPrev = null; ppsResid = []; nmeaPartial = '';
            },
            feed(data) { if (data && data.time) pending = data.time; },
            read() {
                return {
                    t, zone: p.zone,
                    err: chosen ? chosen.err : null,
                    src: chosen ? chosen.src : 'device',
                    signal: !!(chosen && chosen.signal),
                    label: chosen ? chosen.label : SOURCE_LABEL.device,
                    note: chosen ? chosen.note : '',
                };
            },
            process(ins, outs, n) {
                const dt = 1000 / rate;
                // Where this packet's first sample is, in time.
                if (pending) {
                    const c = chooseTime(pending, p);
                    pending = null;
                    // While something wired in is fresh it has the clock; the
                    // page's readings wait in the wings.
                    const wiredNow = (p.source === 'wired' || p.source === 'auto') && t !== null
                        && (t - wiredAt < WIRED_FRESH_MS || t - ppsAt < PPS_FRESH_MS);
                    if (c && !wiredNow) {
                        chosen = c;
                        const key = `${c.src}/${c.signal}`;
                        if (t === null || key !== stepKey || Math.abs(c.t0 - t) > STEP_MS) t = c.t0;
                        // The stamps are exact; the page's readings are not, and
                        // are followed gently.
                        else t = c.signal ? c.t0 : t + (c.t0 - t) * SLEW;
                        stepKey = key;
                    }
                }
                if (t === null) {
                    // Nothing from the page yet: this machine's clock, for now.
                    t = Date.now() - n * dt;
                    chosen = { t0: t, err: null, src: 'device', signal: false, label: SOURCE_LABEL.device, note: '' };
                }

                // ── what is wired in ──
                const prop = p.propagationMs || 0;
                const wantWired = p.source === 'wired' || p.source === 'auto';
                const timeIn = ins && ins[0];
                if (timeIn && timeIn.list && wantWired) {
                    for (const msg of timeIn.list) {
                        if (!msg) continue;
                        if (msg.type === 'timecode' && Number.isFinite(msg.utcMs)) {
                            // UTC at the end of this packet, from the decoder's edge;
                            // a received code is late by its path, which is added back.
                            const end = msg.utcMs + (msg.ago || 0) * 1000 + prop;
                            t = end - n * dt;
                            wiredAt = t;
                            wiredWhat = `${msg.station || 'Time code'}${msg.quality != null ? `, quality ${Math.round(msg.quality * 100)}%` : ''}`;
                        } else if (msg.type === 'text' && typeof msg.text === 'string') {
                            const lines = (nmeaPartial + msg.text).split(/\r?\n/);
                            nmeaPartial = lines.pop().slice(-200);
                            for (const line of lines) {
                                const utc = parseNmea(line);
                                if (utc == null) continue;
                                // To the second only: the sentence arrives late by
                                // an unknown fraction, so it names the second and a
                                // PPS, if there is one, places it.
                                const here = t + n * dt;
                                if (Math.abs(utc - here) > 1500 || here - ppsAt > PPS_FRESH_MS) t = utc + 500 - n * dt;
                                wiredAt = t;
                                wiredWhat = 'GPS (NMEA)';
                            }
                        }
                    }
                }
                // A PPS: each rising edge is a whole second. Placed by the clock
                // as it stands, then the clock is pulled onto it.
                const ppsIn = ins && ins[1] && ins[1].re;
                if (ppsIn) {
                    const m = ins[1].n != null ? ins[1].n : n;
                    for (let k = 0; k < m; k++) {
                        const v = ppsIn[k];
                        const a = ppsPrev;
                        ppsPrev = v;
                        if (a === null || !(a < 0.5 && v >= 0.5)) continue;
                        const frac = (0.5 - a) / (v - a);
                        const at = t + (k - 1 + frac) * dt;
                        const label = Math.round(at / 1000) * 1000;
                        const e = label - at;
                        ppsResid.push(e);
                        if (ppsResid.length > 30) ppsResid.shift();
                        t += Math.abs(e) > STEP_MS ? e : e * PPS_GAIN;
                        ppsAt = t + k * dt;
                    }
                }
                const here = t + n * dt;
                const wiredFresh = here - wiredAt < WIRED_FRESH_MS;
                const ppsFresh = here - ppsAt < PPS_FRESH_MS;
                if ((wiredFresh || ppsFresh) && wantWired) {
                    const rms = ppsResid.length > 2 ? Math.sqrt(ppsResid.reduce((x, e) => x + e * e, 0) / ppsResid.length) : null;
                    chosen = {
                        t0: t,
                        err: ppsFresh && rms != null ? rms : null,
                        src: 'wired',
                        signal: false,
                        label: `${SOURCE_LABEL.wired}: ${[wiredFresh ? wiredWhat : '', ppsFresh ? 'PPS' : ''].filter(Boolean).join(' + ')}${prop ? `, +${prop} ms path` : ''}`,
                        note: '',
                    };
                    stepKey = 'wired';
                } else if (p.source === 'wired' && chosen && chosen.src !== 'wired') {
                    chosen = { ...chosen, note: `Nothing wired in is speaking — ${chosen.label} meanwhile` };
                } else if (p.source === 'wired' && chosen && chosen.src === 'wired') {
                    chosen = { ...chosen, label: `${SOURCE_LABEL.wired} (silent — holding)`, note: 'Nothing wired in has spoken for a while' };
                }
                const pps = outs[0] && outs[0].re;
                const pips = outs[1] && outs[1].re;
                const tone = outs[2] && outs[2].re;
                const car = outs[3];
                const win = outs[4] && outs[4].re;
                const everyMs = (Number(p.ppsEvery) || 1) * 1000;
                const width = Math.min(p.ppsWidthMs, everyMs);
                const wEvery = p.windowEvery * 1000;
                let wNow = 0;
                for (let k = 0; k < n; k++) {
                    const tk = t + k * dt;
                    if (pps) pps[k] = mod(tk - p.ppsOffsetMs, everyMs) < width ? 1 : 0;
                    if (pips) {
                        const into = mod(tk, 1000);
                        const sec = mod(Math.floor(tk / 1000), 60);
                        const len = sec === 0 ? p.minutePipMs : p.pipMs;
                        pips[k] = into < len ? 0.5 * Math.sin(2 * Math.PI * p.pipHz * (into / 1000)) : 0;
                    }
                    if (tone) tone[k] = Math.sin(2 * Math.PI * cycles(p.toneHz, tk));
                    if (car && car.re) {
                        const ph = 2 * Math.PI * cycles(p.carrierHz, tk);
                        car.re[k] = Math.cos(ph);
                        car.im[k] = Math.sin(ph);
                    }
                    wNow = mod(tk - p.windowFrom * 1000, wEvery) < p.windowLength * 1000 ? 1 : 0;
                    if (win) win[k] = wNow;
                }
                // Each whole second this packet reached: the controls, and the
                // words where one is due.
                const first = Math.ceil(t / 1000);
                const end = t + n * dt;
                for (let s = first; s * 1000 < end; s++) {
                    const ms = s * 1000;
                    const parts = timeParts(ms, p.zone);
                    if (outs[6]) emitControl(outs[6], s);
                    if (outs[7]) emitControl(outs[7], parts.s);
                    if (outs[8]) emitControl(outs[8], parts.m);
                    if (outs[9]) emitControl(outs[9], parts.h);
                    if (outs[11] && chosen && chosen.err != null) emitControl(outs[11], chosen.err);
                    const due = p.announce === 'second'
                        || (p.announce === 'period' && mod(s, Number(p.ppsEvery) || 1) === 0)
                        || (p.announce === 'minute' && parts.s === 0)
                        || (p.announce === 'hour' && parts.s === 0 && parts.m === 0);
                    if (due && outs[5] && outs[5].list) outs[5].list.push({ type: 'text', text: `${clockText(ms, p.format, p.zone)}\n` });
                }
                // The first time, said at once rather than waiting for its turn.
                if (!saidFirst && p.announce !== 'off' && outs[5] && outs[5].list) {
                    if (!outs[5].list.length) outs[5].list.push({ type: 'text', text: `${clockText(Math.floor(end / 1000) * 1000, p.format, p.zone)}\n` });
                    saidFirst = true;
                }
                if (outs[10] && wNow !== open) {
                    open = wNow;
                    emitControl(outs[10], wNow);
                }
                t = end;
                return n;
            },
        };
    },
};
