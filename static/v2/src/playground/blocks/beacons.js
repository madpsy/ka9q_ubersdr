// The NCDXF/IARU International Beacon Project: eighteen beacons round the
// world taking turns on five frequencies, each ten seconds on a band before it
// moves up to the next — the whole cycle three minutes long, on the UTC clock.
// Listening to one frequency, the beacon heard says which part of the world
// the band is open to, now.
//
// Each sends its callsign at 22 wpm, then four one-second dashes at 100 W,
// 10 W, 1 W and 100 mW. Here, a beacon's strength is its loudest second in its
// ten — the 100 W dash — against the noise. The noise is found from the
// quietest tenth of what this frequency has measured over the last three
// minutes (a band of beacons taking turns is always quiet some of that), made
// the noise's mean by the spread a power measured over so many independent
// samples has (chi-square, by Wilson and Hilferty's approximation) — so a slot
// of nothing but noise reads well below 0 dB, not the few dB its own loudest
// moment would.
//
// The band is set, or — `From the tuning` — read from the frequency the
// receiver is on (an IQ stream's `tuned` output), so a Scheduler hopping the
// bands takes the monitor with it. A slot is judged on the band it was mostly
// heard on, so a retune landing a moment after the slot began still counts.
//
// The time comes from a Clock (its `unix` output), so it is whatever time the
// Clock has chosen: off-air, NTP, or the signal's capture times. Without one,
// this device's clock — near enough for ten-second slots if it is set.

import { CONTROL, MESSAGE, REAL, emitControl } from '../block.js';
import { quantile } from '../timecode/dsp.js';

export const NCDXF_BEACONS = [
    { call: '4U1UN', where: 'United Nations, New York' },
    { call: 'VE8AT', where: 'Canada (Nunavut)' },
    { call: 'W6WX', where: 'USA (California)' },
    { call: 'KH6RS', where: 'Hawaii' },
    { call: 'ZL6B', where: 'New Zealand' },
    { call: 'VK6RBP', where: 'Australia (WA)' },
    { call: 'JA2IGY', where: 'Japan' },
    { call: 'RR9O', where: 'Russia (Novosibirsk)' },
    { call: 'VR2B', where: 'Hong Kong' },
    { call: '4S7B', where: 'Sri Lanka' },
    { call: 'ZS6DN', where: 'South Africa' },
    { call: '5Z4B', where: 'Kenya' },
    { call: '4X6TU', where: 'Israel' },
    { call: 'OH2B', where: 'Finland' },
    { call: 'CS3B', where: 'Madeira' },
    { call: 'LU4AA', where: 'Argentina' },
    { call: 'OA4B', where: 'Peru' },
    { call: 'YV5B', where: 'Venezuela' },
];

export const NCDXF_BANDS = [
    { band: '20m', khz: 14100 },
    { band: '17m', khz: 18110 },
    { band: '15m', khz: 21150 },
    { band: '12m', khz: 24930 },
    { band: '10m', khz: 28200 },
];

/** Which beacon is on band `b` (0–4) at Unix time `s` seconds: 4U1UN on 14.100 at the top of each three minutes, each moving up a band every ten. */
export function beaconAt(s, b) {
    const slot = Math.floor((((s % 180) + 180) % 180) / 10);
    return (((slot - b) % 18) + 18) % 18;
}

const FRAME_SEC = 0.2;
const LOUDEST = Math.round(1 / FRAME_SEC);

/** The q-quantile of a power measured with ν degrees of freedom, over its mean (Wilson–Hilferty). */
function chiQuantileRatio(nu, z) {
    const k = 2 / (9 * nu);
    return Math.max(0.05, (1 - k + z * Math.sqrt(k)) ** 3);
}

export const BeaconMonitorBlock = {
    type: 'beacon-monitor',
    label: 'Beacon monitor',
    category: 'Radio',
    summary: 'The NCDXF/IARU beacons on one band: which of the eighteen is on now, and how strong each was heard — where the band is open to. Feed it CW audio from the beacon frequency; wire a Clock’s unix output for the time.',
    inputs: [{ name: 'audio', kind: REAL }, { name: 'unix', kind: CONTROL, optional: true }, { name: 'tuned', kind: CONTROL, optional: true }],
    outputs: [{ name: 'text', kind: MESSAGE }, { name: 'snr', kind: CONTROL }],
    params: {
        band: {
            kind: 'choice', label: 'Band', default: 0,
            options: [...NCDXF_BANDS.map((x, i) => ({ value: i, label: `${x.band} — ${(x.khz / 1000).toFixed(3)} MHz` })), { value: -1, label: 'From the tuning (wire tuned in)' }],
        },
        toneHz: { kind: 'number', label: 'CW pitch', unit: 'Hz', default: 700, min: 100, max: 3000, step: 1, live: true },
        bandwidthHz: { kind: 'number', label: 'Bandwidth', unit: 'Hz', default: 100, min: 20, max: 500, step: 5, live: true },
        heardDb: { kind: 'number', label: 'Heard above', unit: 'dB', default: 6, min: 0, max: 30, step: 0.5, live: true },
    },
    create() {
        let rate = 12000;
        let p = {};
        let c = 1; let s = 0; let dc = 1; let ds = 0; let wHz = 0;
        let i1 = 0; let q1 = 0; let i2 = 0; let q2 = 0;
        let acc = 0; let got = 0; let per = 600;
        let t = null;            // Unix seconds at the next sample
        let fromClock = false;
        let seen = -1;
        let slot = null;         // { start, frames: [[power, band]], partial }
        // Each band's last three minutes of frames, and the noise found in them.
        const RING = Math.round(180 / FRAME_SEC);
        const rings = NCDXF_BANDS.map(() => ({ frames: new Float64Array(RING), pos: 0, count: 0, noise: 0, since: 0 }));
        // Every band's frames together: the floor for a band visited too
        // briefly to have one of its own — following a beacon, the receiver
        // is on each band only while that beacon sends, never in its quiet.
        const pooled = { frames: new Float64Array(RING), pos: 0, count: 0, noise: 0, since: 0 };
        const OWN = Math.round(60 / FRAME_SEC);
        const noiseOf = (band) => (rings[band].count >= OWN ? rings[band].noise : pooled.noise);
        let tunedHz = null;
        let seenTuned = -1;
        const heard = new Map(); // `${band}:${beacon}` → { snr, at, heard }
        let last = null;
        /** The band now: as set, or the beacon frequency the receiver is tuned to (within 3 kHz), or -1. */
        const bandNow = () => {
            if (p.band >= 0) return p.band;
            if (!(tunedHz > 0)) return -1;
            return NCDXF_BANDS.findIndex((x) => Math.abs(tunedHz - x.khz * 1000) <= 3000);
        };
        const tune = () => {
            if (p.toneHz === wHz) return;
            wHz = p.toneHz;
            const w = (2 * Math.PI * wHz) / rate;
            dc = Math.cos(-w); ds = Math.sin(-w);
        };
        const close = (outs) => {
            // A slot joined part way through is not judged.
            if (!slot || slot.partial) { slot = null; return; }
            // The band it was mostly heard on, and only the frames heard on it.
            const counts = new Map();
            for (const [, bd] of slot.frames) counts.set(bd, (counts.get(bd) || 0) + 1);
            let band = -1;
            let most = 0;
            for (const [bd, c2] of counts) if (bd >= 0 && c2 > most) { band = bd; most = c2; }
            const own = slot.frames.filter(([, bd]) => bd === band).map(([pw]) => pw);
            const start = slot.start;
            slot = null;
            // Most of the slot on the band, or not judged.
            if (band < 0 || own.length < 0.6 * (10 / FRAME_SEC)) return;
            const noise = noiseOf(band);
            const beacon = beaconAt(start, band);
            const b = NCDXF_BEACONS[beacon];
            // The loudest second: the mean of the top frames.
            const top = own.sort((x, y) => y - x).slice(0, LOUDEST);
            const level = top.length ? top.reduce((x, y) => x + y, 0) / top.length : 0;
            const snr = noise > 0 && top.length === LOUDEST ? 10 * Math.log10(Math.max(level - noise, noise * 1e-3) / noise) : null;
            if (snr == null) return;
            const was = snr >= p.heardDb;
            heard.set(`${band}:${beacon}`, { snr, at: start, heard: was, band });
            last = { call: b.call, where: b.where, snr, heard: was, at: start, band: NCDXF_BANDS[band].band };
            if (was) {
                const hhmm = new Date(start * 1000).toISOString().slice(11, 19);
                outs[0].list.push({ type: 'text', text: `${hhmm} ${NCDXF_BANDS[band].band} ${b.call} (${b.where}) ${snr.toFixed(0)} dB\n` });
            }
            if (outs[1]) emitControl(outs[1], snr);
        };
        return {
            configure(params, r) {
                const bandChanged = p.band !== params.band;
                p = params;
                if (r && r !== rate) { rate = r; wHz = 0; }
                tune();
                per = Math.max(1, Math.round(FRAME_SEC * rate));
                if (bandChanged) { slot = null; last = null; }
            },
            reset() {
                slot = null; t = null; seen = -1; seenTuned = -1; tunedHz = null; heard.clear(); last = null;
                for (const r of [...rings, pooled]) { r.pos = 0; r.count = 0; r.noise = 0; r.since = 0; }
            },
            read() {
                const now = t != null ? t : Date.now() / 1000;
                const band = bandNow();
                const on = band >= 0 ? beaconAt(now, band) : -1;
                return {
                    band: band >= 0 ? NCDXF_BANDS[band].band : null,
                    on: on >= 0 ? { ...NCDXF_BEACONS[on], index: on, secondsLeft: 10 - (((now % 10) + 10) % 10) } : null,
                    heard: Array.from(heard, ([key, h]) => ({ ...NCDXF_BEACONS[Number(key.split(':')[1])], ...h, band: NCDXF_BANDS[h.band].band })),
                    last,
                    noise: band >= 0 ? noiseOf(band) : 0,
                    why: !fromClock ? 'No Clock wired: on this device’s clock'
                        : band < 0 ? (p.band < 0 ? 'Not tuned to a beacon frequency' : '') : '',
                };
            },
            process(ins, outs, n) {
                const x = ins[0];
                const u = ins[1];
                const tu = ins[2];
                if (!x || !x.re) return 0;
                tune();
                if (tu && tu.seq !== seenTuned && tu.value != null) { seenTuned = tu.seq; tunedHz = Number(tu.value); }
                // The Clock speaks once a second, somewhere in a packet: taken as its middle.
                if (u && u.seq !== seen && u.value != null) {
                    seen = u.seq;
                    t = u.value - n / 2 / rate;
                    fromClock = true;
                } else if (t == null || !fromClock) {
                    t = Date.now() / 1000 - n / rate;
                    fromClock = false;
                }
                const band = bandNow();
                const a = 1 - Math.exp((-2 * Math.PI * (p.bandwidthHz / 2)) / rate);
                const v = x.re;
                for (let k = 0; k < n; k++) {
                    const mi = v[k] * c;
                    const mq = v[k] * s;
                    const cn = c * dc - s * ds;
                    s = c * ds + s * dc;
                    c = cn;
                    i1 += a * (mi - i1); q1 += a * (mq - q1);
                    i2 += a * (i1 - i2); q2 += a * (q1 - q2);
                    acc += i2 * i2 + q2 * q2;
                    if (++got < per) continue;
                    const pow = acc / got;
                    acc = 0; got = 0;
                    const now = t + k / rate;
                    const start = Math.floor(now / 10) * 10;
                    if (!slot || slot.start !== start) {
                        close(outs);
                        slot = { start, frames: [], partial: now - start > 0.5 };
                    }
                    slot.frames.push([pow, band]);
                    if (band < 0) continue;
                    for (const ring of [rings[band], pooled]) {
                        ring.frames[ring.pos] = pow;
                        ring.pos = (ring.pos + 1) % RING;
                        if (ring.count < RING) ring.count++;
                        // The floor, refreshed every couple of seconds.
                        if (++ring.since >= 10 || !ring.noise) {
                            ring.since = 0;
                            // Independent complex samples in a frame: the two
                            // one-pole stages pass about π/4 of the bandwidth.
                            const nu = Math.max(2, 2 * (Math.PI / 4) * p.bandwidthHz * FRAME_SEC);
                            ring.noise = quantile(ring.frames.subarray(0, ring.count), 0.1) / chiQuantileRatio(nu, -1.2816);
                        }
                    }
                }
                t += n / rate;
                // Kept on the unit circle.
                const m = Math.hypot(c, s); c /= m; s /= m;
                return 0;
            },
        };
    },
};
