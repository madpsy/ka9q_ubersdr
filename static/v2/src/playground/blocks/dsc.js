// The DSC decoder as a block: IQ tuned to a DSC frequency in, the calls out.
// The decoding is playground/dsc/dsc.js — ubersdr_dsc's port of SDRangel's.
// A wider stream than 12 kHz is decimated to it first (the 301-tap filters
// run per sample, and at 192 kHz that is a lot of multiplying for 100 baud).

import { COMPLEX, CONTROL, MESSAGE, emitControl } from '../block.js';
import { DscDemod, messageText } from '../dsc/dsc.js';
import { Decimator } from './timecode.js';

const RATE = 12000;

export const DscBlock = {
    type: 'dsc-decoder',
    label: 'DSC decoder',
    category: 'Radio',
    summary: 'Digital Selective Calling on MF/HF (2187.5, 4207.5, 6312, 8414.5, 12577, 16804.5 kHz): the calls — distress, safety, routine — with their MMSIs, positions and channels. Tune to the frequency.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [
        { name: 'text', kind: MESSAGE },
        { name: 'calls', kind: MESSAGE },
        { name: 'count', kind: CONTROL },
    ],
    activity: 'Receiving a call',
    params: {
        centreHz: { kind: 'number', label: 'Centre at', unit: 'Hz', default: 0, min: -4000, max: 4000, step: 1, control: false },
        invalid: { kind: 'bool', label: 'Show calls that fail their checks', default: false, live: true },
    },
    create() {
        let p = {};
        let key = '';
        let demod = null;
        let dec = null;
        let why = '';
        let bi = new Float64Array(0);
        let bq = new Float64Array(0);
        let pending = [];
        let good = 0;
        let bad = 0;
        let last = null;
        return {
            configure(params, r) {
                p = params;
                const k = `${params.centreHz}/${r}`;
                if (k === key) return;
                key = k;
                why = '';
                demod = null;
                if (!(r > 0) || r % RATE !== 0) { why = `Needs IQ at a multiple of 12 kHz (this is ${r} Hz).`; return; }
                dec = new Decimator(r, RATE);
                demod = new DscDemod(RATE, (m, errors, rssi) => pending.push({ m, errors, rssi }), params.centreHz || 0);
            },
            reset() { key = ''; pending = []; good = 0; bad = 0; last = null; },
            read() {
                return {
                    why,
                    receiving: !!(demod && demod.gotSop),
                    mark: demod ? demod.markEnv : 0,
                    space: demod ? demod.spaceEnv : 0,
                    good, bad,
                    last: last ? { text: last.text, valid: last.valid, at: last.at } : null,
                };
            },
            activity() { return demod && demod.gotSop ? 1 : 0; },
            process(ins, outs, n) {
                const x = ins[0];
                if (!demod || !x || !x.re) return 0;
                const m = x.n != null ? x.n : n;
                if (bi.length < m) { bi = new Float64Array(m); bq = new Float64Array(m); }
                const k = dec.process(x.re, x.im, m, bi, bq);
                demod.process(bi, bq, k);
                for (const { m: msg, errors, rssi } of pending) {
                    if (msg.valid) good++; else bad++;
                    if (!msg.valid && !p.invalid) continue;
                    const text = `${msg.valid ? '' : '[failed checks] '}${messageText(msg)}`;
                    last = { text, valid: msg.valid, at: Date.now() };
                    if (outs[0] && outs[0].list) outs[0].list.push({ type: 'text', text: `${text}\n` });
                    if (outs[1] && outs[1].list) outs[1].list.push({ type: 'dsc', ...msg, data: undefined, errors, rssiDb: rssi });
                }
                if (pending.length && outs[2]) emitControl(outs[2], good);
                pending = [];
                return 0;
            },
        };
    },
};
