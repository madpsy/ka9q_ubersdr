// A time-code decoder: the time, off the air, from WWV, WWVH, WWVB, MSF, DCF77
// or ALS162 (France Inter Allouis).
//
// The decoding is ubersdr-ntp's (src/clock/), ported in playground/
// timecode/ — the same carrier searches, matched filters, edge trackers, frame
// logic and the same voter that certifies a time only once consecutive minutes
// agree. Each runs on IQ at 12 kHz with the carrier at `carrierOffsetHz` (0
// when the dial is on it), so a wider stream is filtered and decimated to 12
// kHz first, computing only the samples kept, and every instant the decoder
// reports is mapped back to this block's input.
//
// Out:
//   time     once a second while locked, the time of that second's edge as
//            received — { type: 'timecode', utcMs, ago, quality, station }, `ago`
//            how long before the end of this packet the edge was — for a Clock
//            to keep time by (its "Wired in" source)
//   text     the decoded time each minute, and when lock is gained or lost
//   symbols  each second's symbol: { type: 'symbol', symbol, conf, sof, station }
//   locked   1 or 0, when it changes
//   quality  the voter's confidence in the time, 0–1, each second while locked

import { COMPLEX, CONTROL, MESSAGE, emitControl } from '../block.js';
import { designLowpass } from '../../lib/dsp/fir.js';
import { WwvDecoder } from '../timecode/wwv.js';
import { WwvbDecoder } from '../timecode/wwvb.js';
import { MsfDecoder } from '../timecode/msf.js';
import { Dcf77Decoder } from '../timecode/dcf77.js';
import { AllouisDecoder } from '../timecode/allouis.js';
import { clockText } from './clock.js';

export const DECODE_RATE = 12000;

export const STATIONS = [
    { value: 'wwv-auto', label: 'WWV / WWVH (HF, tagged by its tick)', make: (o) => new WwvDecoder({ ...o, station: 'auto' }) },
    { value: 'wwv', label: 'WWV only', make: (o) => new WwvDecoder({ ...o, station: 'wwv' }) },
    { value: 'wwvh', label: 'WWVH only', make: (o) => new WwvDecoder({ ...o, station: 'wwvh' }) },
    { value: 'wwvb', label: 'WWVB (60 kHz)', make: (o) => new WwvbDecoder(o) },
    { value: 'msf', label: 'MSF (60 kHz)', make: (o) => new MsfDecoder(o) },
    { value: 'dcf77', label: 'DCF77 (77.5 kHz)', make: (o) => new Dcf77Decoder(o) },
    { value: 'als162', label: 'ALS162 / Allouis (162 kHz)', make: (o) => new AllouisDecoder(o) },
];

const SYMBOL_CHAR = { zero: '0', one: '1', marker: 'M', unknown: '·' };

/**
 * A decimating low-pass for IQ: filters at the input rate but works out only
 * the samples it keeps — one in `factor` — so a 192 kHz stream costs what a 12
 * kHz one would. Output sample j stands for input instant j·factor − delay.
 */
export class Decimator {
    constructor(inRate, outRate) {
        this.factor = Math.round(inRate / outRate);
        this.taps = this.factor > 1 ? designLowpass(outRate * 0.42, inRate, outRate * 0.08) : new Float32Array([1]);
        const n = this.taps.length;
        this.n = n;
        this.delay = (n - 1) / 2;
        this.bufI = new Float64Array(n * 2);
        this.bufQ = new Float64Array(n * 2);
        this.pos = 0;
        this.count = 0;
    }

    /** Filter `m` samples; the kept ones into outI/outQ. Returns how many. */
    process(inI, inQ, m, outI, outQ) {
        const { n, taps, bufI, bufQ, factor } = this;
        let pos = this.pos;
        let k = 0;
        for (let i = 0; i < m; i++) {
            bufI[pos] = inI[i]; bufI[pos + n] = inI[i];
            bufQ[pos] = inQ[i]; bufQ[pos + n] = inQ[i];
            pos = pos + 1 === n ? 0 : pos + 1;
            if (this.count++ % factor !== 0) continue;
            let fi = 0;
            let fq = 0;
            for (let t = 0; t < n; t++) {
                fi += taps[t] * bufI[pos + t];
                fq += taps[t] * bufQ[pos + t];
            }
            outI[k] = fi;
            outQ[k] = fq;
            k++;
        }
        this.pos = pos;
        return k;
    }
}

export const TimecodeBlock = {
    type: 'timecode',
    label: 'Time code decoder',
    category: 'Digital',
    summary: 'The time off the air — WWV, WWVH, WWVB, MSF, DCF77 or ALS162 — decoded and voted across minutes as ubersdr-ntp does, for a Clock or a console. Tune to the carrier.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [
        { name: 'time', kind: MESSAGE },
        { name: 'text', kind: MESSAGE },
        { name: 'symbols', kind: MESSAGE },
        { name: 'locked', kind: CONTROL },
        { name: 'quality', kind: CONTROL },
    ],
    activity: 'Locked',
    params: {
        station: { kind: 'choice', label: 'Station', default: 'wwv-auto', options: STATIONS.map(({ value, label }) => ({ value, label })) },
        carrierOffsetHz: { kind: 'number', label: 'Carrier at', unit: 'Hz', default: 0, min: -4000, max: 4000, step: 0.1, control: false },
    },
    create() {
        let p = {};
        let inRate = 0;
        let key = '';
        let decoder = null;
        let dec = null;
        let why = '';
        let bufI = new Float64Array(0);
        let bufQ = new Float64Array(0);
        let consumed = 0;          // input samples, ever
        let lastLock = null;       // { utcMs, edge } of the latest certified time
        let lastSentEdge = -Infinity;
        let lastMinute = null;
        let wasLocked = null;
        let latest = null;         // { utcMs at the end of the last packet, quality }
        let recent = '';
        let busy = false;
        const build = () => {
            const s = STATIONS.find((x) => x.value === p.station) || STATIONS[0];
            decoder = null;
            dec = null;
            why = '';
            lastLock = null; lastSentEdge = -Infinity; lastMinute = null; wasLocked = null; latest = null; recent = '';
            if (!(inRate > 0) || inRate % DECODE_RATE !== 0) {
                why = `Needs IQ at a multiple of 12 kHz (this is ${inRate} Hz).`;
                return;
            }
            try {
                decoder = s.make({ sampleRate: DECODE_RATE, carrierOffsetHz: p.carrierOffsetHz || 0, referenceNow: () => Date.now() });
                dec = new Decimator(inRate, DECODE_RATE);
            } catch (err) {
                why = (err && err.message) || String(err);
                decoder = null;
            }
        };
        // A decoder instant (12 kHz sample) as an instant of this block's input.
        const toInput = (edge) => edge * dec.factor - dec.delay;
        return {
            configure(params, r) {
                p = params;
                inRate = r || inRate;
                const k = `${params.station}/${params.carrierOffsetHz}/${inRate}`;
                if (k !== key) { key = k; consumed = 0; build(); }
            },
            reset() { consumed = 0; build(); },
            read() {
                const st = decoder ? decoder.status() : null;
                return {
                    why,
                    state: st ? st.state : 'off',
                    station: st ? st.station : null,
                    refusal: st ? st.refusal : null,
                    detail: st ? st.detail : null,
                    utcMs: latest ? latest.utcMs : null,
                    quality: latest ? latest.quality : null,
                    recent,
                };
            },
            activity() {
                const was = busy;
                busy = false;
                return was ? 1 : 0;
            },
            process(ins, outs, n) {
                const x = ins[0];
                const m = x && x.n != null ? x.n : n;
                if (!decoder || !x || !x.re) { consumed += m; return 0; }
                if (bufI.length < m) { bufI = new Float64Array(m); bufQ = new Float64Array(m); }
                const k = dec.process(x.re, x.im, m, bufI, bufQ);
                decoder.process(bufI, bufQ, k);
                consumed += m;
                const st = decoder.status();
                const locked = st.state === 'locked';
                const station = st.station || '';
                const sendTime = (utcMs, edge, quality) => {
                    if (edge <= lastSentEdge + DECODE_RATE * 0.5) return;
                    lastSentEdge = edge;
                    const ago = (consumed - toInput(edge)) / inRate;
                    if (outs[0] && outs[0].list) outs[0].list.push({ type: 'timecode', utcMs, ago, quality, station });
                    if (outs[4]) emitControl(outs[4], quality);
                    latest = { utcMs: utcMs + ago * 1000, quality };
                    busy = true;
                    // The time in words, once a minute and on locking.
                    const minute = Math.floor(utcMs / 60000);
                    if (minute !== lastMinute) {
                        lastMinute = minute;
                        if (outs[1] && outs[1].list) outs[1].list.push({ type: 'text', text: `${clockText(utcMs, 'iso', 'utc')} ${station} ${Math.round(quality * 100)}%\n` });
                    }
                };
                for (const e of decoder.drain()) {
                    if (e.type === 'second') {
                        recent = (recent + (SYMBOL_CHAR[e.symbol] || '?')).slice(-60);
                        if (outs[2] && outs[2].list) outs[2].list.push({ type: 'symbol', symbol: e.symbol, conf: e.conf, sof: e.sof, station });
                        // Every servable second while locked carries the time on
                        // from the last certified one, a second at a time.
                        if (locked && lastLock && e.servable && Number.isFinite(e.edge)) {
                            const secs = Math.round((e.edge - lastLock.edge) / DECODE_RATE);
                            sendTime(lastLock.utcMs + secs * 1000, e.edge, lastLock.quality);
                        }
                    } else if (e.type === 'time' && Number.isFinite(e.edge)) {
                        lastLock = { utcMs: e.utcMs, edge: e.edge, quality: e.quality };
                        sendTime(e.utcMs, e.edge, e.quality);
                    }
                }
                if (locked !== wasLocked) {
                    if (outs[3]) emitControl(outs[3], locked ? 1 : 0);
                    if (wasLocked !== null && outs[1] && outs[1].list) {
                        outs[1].list.push({ type: 'text', text: locked ? `${station || 'Time code'}: locked\n` : `${station || 'Time code'}: lock lost${st.refusal && st.refusal !== 'none' ? ` (${st.refusal})` : ''}\n` });
                    }
                    wasLocked = locked;
                    if (!locked) lastLock = null;
                }
                return 0;
            },
        };
    },
};
