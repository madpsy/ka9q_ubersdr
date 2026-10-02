// SSTV as two blocks, so its parts can be used apart: a demodulator (audio in;
// the frequency and the sync tone's strength out, sample for sample) and a
// raster (those in; pictures, words and the callsign out). Together they are
// the SSTV block's decoder (image/sstv.js, a port of slowrx by Oona Räisänen
// OH2EIQ) — split where its streams are plain numbers anything can use.
//
// Why there and nowhere else: the demodulator's frequency is the whole of
// what the picture is made from, and a frequency is useful on its own — a
// scope of it is a picture of the scan lines, a slicer on it reads any FSK in
// the band, another raster could draw WEFAX from it. Its sync ratio keeps
// slowrx's power test (the 1200 Hz tone against the video band), which
// survives noise that a frequency threshold would not. Everything after needs
// the picture's timing — the VIS header's end, the line rate the slant fit
// finds, the FSK ID after the last line — and messages carry no time, so the
// header, the lines, the slant and the ID stay in one block, reading the
// streams by their sample positions.
//
// The demodulator cannot know the header's frequency shift (it is read
// downstream), so it measures over a band wide enough for any likely shift
// and the raster takes the shift off.

import { CONTROL, MESSAGE, REAL, emitControl, ensureBuffer } from '../block.js';
import { SSTV_MODES, SstvDemodulator, SstvRaster } from '../image/sstv.js';

export const SstvDemodBlock = {
    type: 'sstv-demod',
    label: 'SSTV demodulator',
    category: 'Radio',
    summary: 'slowrx’s video demodulator: the audio’s frequency, sample by sample, from a short windowed DFT whose length follows the SNR (850–2550 Hz), and the strength of the 1200 Hz sync tone against the video band. Feed an SSTV raster, or watch the scan lines on a scope.',
    inputs: [{ name: 'audio', kind: REAL }],
    outputs: [
        { name: 'hz', kind: REAL, audio: false },
        { name: 'sync', kind: REAL, audio: false },
        { name: 'snr', kind: CONTROL },
    ],
    params: {
        adaptive: { kind: 'bool', label: 'Window by SNR', default: true, control: false },
    },
    create() {
        let demod = null;
        let rate = 0;
        let lastSnr = null;
        return {
            configure(p, r) {
                if (!demod || r !== rate) { demod = new SstvDemodulator({ sampleRate: r, adaptive: p.adaptive }); rate = r; lastSnr = null; }
                demod.adaptive = p.adaptive !== false;
            },
            reset() { if (demod) demod.reset(); lastSnr = null; },
            latency() { return demod ? demod.delay : 0; },
            read() { return { snr: demod ? demod.snr : null }; },
            process(ins, outs, n) {
                const x = ins[0];
                if (!demod || !x || !x.re) return 0;
                const hz = ensureBuffer(outs[0], n);
                const sy = ensureBuffer(outs[1], n);
                demod.process(x.re, n, hz.re, sy.re);
                // The SNR only moves every 256 samples' worth; said when it does.
                if (outs[2] && demod.snr !== lastSnr) { lastSnr = demod.snr; emitControl(outs[2], lastSnr); }
                return n;
            },
        };
    },
};

export const SstvRasterBlock = {
    type: 'sstv-raster',
    label: 'SSTV raster',
    category: 'Radio',
    summary: 'Pictures from an SSTV demodulator’s frequency and sync: the mode from the VIS header (Martin, Scottie, Robot, PD, Wraase, Pasokon), the lines laid out as they arrive, the slant straightened and the picture redrawn when it ends, the sender’s FSK ID read after. Wire its images to an Image viewer.',
    inputs: [{ name: 'hz', kind: REAL, audio: false }, { name: 'sync', kind: REAL, audio: false }],
    outputs: [
        { name: 'images', kind: MESSAGE },
        { name: 'text', kind: MESSAGE },
        { name: 'callsign', kind: MESSAGE },
        { name: 'receiving', kind: CONTROL },
        { name: 'progress', kind: CONTROL },
    ],
    activity: 'Receiving',
    params: {
        mode: { kind: 'choice', label: 'Mode', default: 'auto', options: [{ value: 'auto', label: 'From the VIS header' }, ...SSTV_MODES.map((m) => ({ value: m, label: m }))] },
        slant: { kind: 'bool', label: 'Straighten the slant', default: true, control: false },
    },
    create() {
        let raster = null;
        let key = '';
        let receiving = null;
        let progress = null;
        const say = (buf, v) => { if (buf) emitControl(buf, v); };
        return {
            configure(p, r) {
                const k = `${p.mode}/${p.slant}/${r}`;
                if (k === key) return;
                key = k;
                raster = new SstvRaster({ sampleRate: r, mode: p.mode, slant: p.slant });
                receiving = null;
                progress = null;
            },
            reset() { if (raster) raster.reset(); receiving = null; progress = null; },
            read() { return raster ? raster.status() : { state: 'off', mode: null, detail: { line: 0, of: 0, vis: null, callsign: null } }; },
            activity() { return raster && raster.status().state === 'receiving' ? 1 : 0; },
            process(ins, outs, n) {
                const hz = ins[0];
                const sy = ins[1];
                if (!raster || !hz || !hz.re || !sy || !sy.re) return 0;
                raster.process(hz.re, sy.re, n);
                const [images, text, callsign] = outs;
                let ended = false;
                for (const e of raster.drain()) {
                    if (e.type === 'text') { if (text && text.list) text.list.push(e); continue; }
                    if (e.type !== 'image') continue;
                    if (images && images.list) images.list.push(e);
                    if (e.event === 'start') { progress = 0; say(outs[4], 0); }
                    if (e.event === 'end') ended = true;
                    // Just the callsign, for whatever speaks or logs it.
                    if (e.event === 'info' && e.callsign && callsign && callsign.list) callsign.list.push({ type: 'text', text: e.callsign });
                }
                const st = raster.status();
                const on = st.state === 'receiving' ? 1 : 0;
                if (on !== receiving) { receiving = on; say(outs[3], on); }
                if (ended) {
                    if (progress !== 1) { progress = 1; say(outs[4], 1); }
                } else if (on && st.detail.of) {
                    // Rows drawn so far, said each time another hundredth is in.
                    const f = st.detail.line / st.detail.of;
                    if (progress === null || f - progress >= 0.01) { progress = f; say(outs[4], f); }
                }
                return 0;
            },
        };
    },
};
