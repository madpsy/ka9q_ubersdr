// QRSS Grabber Extension for ka9q UberSDR
// Narrow-band scrolling spectrogram for visually reading very-slow CW (QRSS)
// and MEPT beacons. Taps the post-demod mono audio, decimates it in an
// AudioWorklet, runs a long overlapping FFT, and paints a high-resolution
// waterfall with frequency/time axes and a dB colour bar.
//
// Design mirrors QrssPiG (github.com/hb9fxx/qrsspig): Hann window, overlapping
// FFT, 10·log10 power → colour map → one column per FFT.
//
// Wrapped in an IIFE: extension scripts share the global scope, so top-level
// names here (e.g. FFT) must not leak or they collide with core scripts.
(function () {
'use strict';

// ─── Colour maps ────────────────────────────────────────────────────────────
// Each map is a list of [pos, r, g, b] control points, interpolated into a
// 256-entry LUT once. Values 0..255.
const QRSS_COLORMAPS = {
    qrss: [
        [0.00,   0,   0,   0], [0.15,   0,   0,  80], [0.35,   0,  80, 160],
        [0.50,   0, 180, 180], [0.65,   0, 200,  60], [0.80, 230, 230,   0],
        [0.92, 230,  60,   0], [1.00, 255, 255, 255]
    ],
    viridis: [
        [0.000,  68,   1,  84], [0.125,  72,  40, 120], [0.250,  62,  74, 137],
        [0.375,  49, 104, 142], [0.500,  38, 130, 142], [0.625,  31, 158, 137],
        [0.750,  53, 183, 121], [0.875, 110, 206,  88], [1.000, 253, 231,  37]
    ],
    inferno: [
        [0.000,   0,   0,   4], [0.125,  31,  12,  72], [0.250,  85,  15, 109],
        [0.375, 136,  34, 106], [0.500, 186,  54,  85], [0.625, 227,  89,  51],
        [0.750, 249, 140,  10], [0.875, 249, 201,  50], [1.000, 252, 255, 164]
    ],
    afmhot: [
        [0.00,   0,   0,   0], [0.33, 170,   0,   0], [0.66, 255, 170,   0],
        [1.00, 255, 255, 255]
    ],
    grayscale: [
        [0.00,   0,   0,   0], [1.00, 255, 255, 255]
    ]
};

function buildColorLUT(name) {
    const pts = QRSS_COLORMAPS[name] || QRSS_COLORMAPS.qrss;
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let a = pts[0], b = pts[pts.length - 1];
        for (let k = 0; k < pts.length - 1; k++) {
            if (t >= pts[k][0] && t <= pts[k + 1][0]) { a = pts[k]; b = pts[k + 1]; break; }
        }
        const span = (b[0] - a[0]) || 1;
        const f = (t - a[0]) / span;
        lut[i * 3]     = a[1] + (b[1] - a[1]) * f;
        lut[i * 3 + 1] = a[2] + (b[2] - a[2]) * f;
        lut[i * 3 + 2] = a[3] + (b[3] - a[3]) * f;
    }
    return lut;
}

// ─── Radix-2 FFT ────────────────────────────────────────────────────────────
// In-place complex FFT with precomputed bit-reversal and twiddle tables.
class FFT {
    constructor(n) {
        this.n = n;
        this.cos = new Float32Array(n / 2);
        this.sin = new Float32Array(n / 2);
        for (let i = 0; i < n / 2; i++) {
            this.cos[i] = Math.cos(-2 * Math.PI * i / n);
            this.sin[i] = Math.sin(-2 * Math.PI * i / n);
        }
        this.rev = new Uint32Array(n);
        let bits = Math.log2(n);
        for (let i = 0; i < n; i++) {
            let x = i, r = 0;
            for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
            this.rev[i] = r;
        }
    }
    // re, im: Float32Array(n). Transformed in place.
    transform(re, im) {
        const n = this.n, rev = this.rev, cos = this.cos, sin = this.sin;
        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
        }
        for (let size = 2; size <= n; size <<= 1) {
            const half = size >> 1, step = n / size;
            for (let i = 0; i < n; i += size) {
                for (let j = i, k = 0; j < i + half; j++, k += step) {
                    const c = cos[k], s = sin[k];
                    const tr = re[j + half] * c - im[j + half] * s;
                    const ti = re[j + half] * s + im[j + half] * c;
                    re[j + half] = re[j] - tr; im[j + half] = im[j] - ti;
                    re[j] += tr; im[j] += ti;
                }
            }
        }
    }
}

// ─── Anti-alias FIR design (windowed sinc) ──────────────────────────────────
function designLowpass(decim) {
    if (decim <= 1) return new Float32Array([1]);
    let taps = Math.min(511, (8 * decim) | 1);
    if ((taps & 1) === 0) taps++;               // force odd
    const fc = 0.5 / decim;                      // cutoff in cycles/sample
    const c = (taps - 1) / 2;
    const h = new Float32Array(taps);
    let sum = 0;
    for (let n = 0; n < taps; n++) {
        const x = n - c;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (taps - 1)); // Hamming
        h[n] = sinc * w;
        sum += h[n];
    }
    for (let n = 0; n < taps; n++) h[n] /= sum;  // unity DC gain
    return h;
}

class QRSSExtension extends DecoderExtension {
    constructor() {
        super('qrss', { displayName: 'QRSS Grabber', autoTune: false });

        this.config = {
            span: 3000,            // displayed bandwidth (Hz) — the zoom width
            centerHz: null,        // audio centre frequency; null → span/2 (view [0, span])
            fftSize: 16384,
            secPerPixel: 1.0,      // waterfall time resolution (seconds per column)
            windowSec: 0,          // 0 = Auto (Speed-driven); >0 locks total on-screen time
            colormap: 'qrss',
            dbMin: -110,
            dbMax: -60,
            autoContrast: true,
            autoFloorOffset: -4,   // black point relative to tracked noise floor (dB)
            autoSpan: 50           // dynamic range above the black point (dB)
        };

        // DSP state
        this.running = false;
        this.paused = false;
        this.workletNode = null;
        this.sinkNode = null;
        this.fft = null;
        this.fftRe = null;
        this.fftIm = null;
        this.hann = null;
        this.ringI = null;         // circular complex window buffer (baseband I/Q)
        this.ringQ = null;
        this.ringPos = 0;
        this.totalIn = 0;
        this.sinceLast = 0;
        this.decim = 1;
        this.decSR = 0;
        this.fc = 0;               // active audio centre frequency
        this.hop = 0;
        this.dialFreq = 0;

        // Render state
        this.canvas = null;
        this.ctx = null;
        this.wf = null;            // offscreen waterfall pixel buffer
        this.wfCtx = null;
        this.colLUT = buildColorLUT('qrss');
        this.binMap = null;        // per-pixel [binLo, binHi] mapping
        this.floorEMA = -110;      // running noise-floor estimate for auto-contrast
        this.margins = { l: 62, r: 56, t: 24, b: 22 };
        this.lastColTime = 0;

        // Display magnifier: a normalised sub-rectangle of the waterfall content
        // that is scaled to fill the plot area. x: 0=oldest(left)…1=newest(right);
        // y: 0=top(highest freq)…1=bottom. Full view = {0,0,1,1}.
        this.view = { x0: 0, y0: 0, x1: 1, y1: 1 };
        this._dragging = false;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────
    // The host injects template.html into the extension panel and calls
    // onActivate() afterwards on every (re)open — that is where we bind to the
    // freshly-created DOM. onInitialize also polls as a first-open fallback.
    onInitialize() { this._waitForDOM(); }
    onActivate() { this._domBound = false; this._waitForDOM(); }

    _waitForDOM(attempt = 0) {
        if (this._domBound) return;
        const canvas = document.getElementById('qrss-canvas');
        const startBtn = document.getElementById('qrss-start-btn');
        if (canvas && startBtn) {
            this._domBound = true;
            this._setupCanvas();
            this._bindControls();
            this._updateDerived();
        } else if (attempt < 30) {
            setTimeout(() => this._waitForDOM(attempt + 1), 100);
        }
    }

    onDisable() { this.stop(); this._domBound = false; }
    onDeactivate() { this.stop(); this._domBound = false; }
    onFrequencyChanged(freq) { this._showDial(freq); }
    onBandwidthChanged() { this._updateBandInfo(); }   // reflect RX passband changes
    processAudio() { /* QRSS taps a dedicated worklet, not the shared analyser */ }
    onProcessAudio() { /* unused */ }

    // ── UI wiring ─────────────────────────────────────────────────────────────
    _setupCanvas() {
        this.canvas = document.getElementById('qrss-canvas');
        this.ctx = this.canvas.getContext('2d');
        this._resizeCanvas();
        if (this._resizeObserver) this._resizeObserver.disconnect();
        this._resizeObserver = new ResizeObserver(() => this._resizeCanvas());
        this._resizeObserver.observe(this.canvas.parentElement);

        // Magnifier: scroll = zoom, drag = pan, double-click = reset to fit.
        this.canvas.addEventListener('mousedown', (e) => this._onDragStart(e));
        this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this._onDragEnd());
        this.canvas.addEventListener('mouseleave', () => {
            this._onDragEnd();
            const h = document.getElementById('qrss-hover'); if (h) h.hidden = true;
        });
        this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        this.canvas.addEventListener('dblclick', (e) => { e.preventDefault(); this._resetView(); });
    }

    _resizeCanvas() {
        if (!this.canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        const w = Math.max(320, Math.floor(rect.width));
        const h = Math.max(240, Math.floor(rect.height));
        this.canvas.width = Math.floor(w * dpr);
        this.canvas.height = Math.floor(h * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.cssW = w; this.cssH = h;

        const m = this.margins;
        const prevW = this.innerW, prevH = this.innerH;
        this.innerW = Math.max(64, w - m.l - m.r);
        this.innerH = Math.max(64, h - m.t - m.b);
        // Stored dB columns are indexed by pixel height, so drop them if the
        // waterfall was resized (the scaled bitmap copy bridges the gap visually).
        if (this.innerH !== prevH || this.innerW !== prevW) this.dbHistory = [];

        // (Re)allocate the offscreen waterfall buffer, preserving old pixels
        const old = this.wf;
        this.wf = document.createElement('canvas');
        this.wf.width = this.innerW; this.wf.height = this.innerH;
        this.wfCtx = this.wf.getContext('2d');
        this.wfCtx.fillStyle = '#000';
        this.wfCtx.fillRect(0, 0, this.innerW, this.innerH);
        if (old) this.wfCtx.drawImage(old, 0, 0, this.innerW, this.innerH);

        this._buildBinMap();
        // Compute derived timing/frequency values before painting so the axes
        // render sensibly from the first frame (and holds a locked window across
        // resizes). Safe to call pre-start — it only reads config + sample rate.
        this._updateDerived();
        this._redraw();
    }

    _bindControls() {
        const bind = (id, ev, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(ev, fn);
            return el;
        };

        const bandSel = bind('qrss-band-select', 'change', (e) => {
            const hz = parseInt(e.target.value);
            if (hz) this._tuneBand(hz);
        });

        bind('qrss-start-btn', 'click', () => this.start());
        bind('qrss-stop-btn', 'click', () => this.stop());
        bind('qrss-pause-btn', 'click', () => this.togglePause());
        bind('qrss-clear-btn', 'click', () => this.clearWaterfall());
        bind('qrss-save-btn', 'click', () => this.savePNG());

        const spanSel = document.getElementById('qrss-span');
        if (spanSel) { spanSel.value = String(this.config.span); spanSel.addEventListener('change', (e) => { this.config.span = parseInt(e.target.value); this.clearWaterfall(); this._restartIfRunning(); }); }
        const fftSel = document.getElementById('qrss-fft');
        if (fftSel) { fftSel.value = String(this.config.fftSize); fftSel.addEventListener('change', (e) => { this.config.fftSize = parseInt(e.target.value); this._restartIfRunning(); }); }
        const spdSel = document.getElementById('qrss-speed');
        if (spdSel) {
            spdSel.value = String(this.config.secPerPixel);
            spdSel.disabled = this.config.windowSec > 0;
            spdSel.addEventListener('change', (e) => { this.config.secPerPixel = parseFloat(e.target.value); this._recalcHop(); this._updateDerived(); });
        }
        // Window: 0 = Auto (Speed-driven); a value locks the total on-screen time
        // and disables Speed (which becomes derived and shown in the status bar).
        const winSel = document.getElementById('qrss-window');
        if (winSel) {
            winSel.value = String(this.config.windowSec);
            winSel.addEventListener('change', (e) => {
                this.config.windowSec = parseInt(e.target.value) || 0;
                if (this.config.windowSec === 0 && spdSel) {
                    // Returning to Auto: snap s/px to the nearest Speed option
                    const nv = this._nearestSpeed(this.config.secPerPixel);
                    this.config.secPerPixel = parseFloat(nv);
                    spdSel.value = nv;
                }
                if (spdSel) spdSel.disabled = this.config.windowSec > 0;
                this._recalcHop();
                this._updateDerived();
            });
        }
        const cmSel = document.getElementById('qrss-colormap');
        if (cmSel) { cmSel.value = this.config.colormap; cmSel.addEventListener('change', (e) => { this.config.colormap = e.target.value; this.colLUT = buildColorLUT(e.target.value); this._rerenderAll(); }); }

        const auto = bind('qrss-auto-contrast', 'change', (e) => {
            this.config.autoContrast = e.target.checked;
            this._syncDbUI();
            // Leaving auto on keeps the tracked range; the next column re-balances.
        });
        if (auto) auto.checked = this.config.autoContrast;
        const dbMin = document.getElementById('qrss-dbmin');
        const dbMax = document.getElementById('qrss-dbmax');
        const onDb = () => {
            let lo = parseInt(dbMin.value), hi = parseInt(dbMax.value);
            if (lo >= hi) { lo = Math.min(lo, hi - 1); dbMin.value = lo; }
            this.config.dbMin = lo; this.config.dbMax = hi;
            this.config.autoContrast = false;               // dragging switches to manual
            const a = document.getElementById('qrss-auto-contrast'); if (a) a.checked = false;
            this._syncDbUI();
            this._rerenderAll();                            // apply to the whole waterfall
        };
        if (dbMin) { dbMin.value = this.config.dbMin; dbMin.addEventListener('input', onDb); }
        if (dbMax) { dbMax.value = this.config.dbMax; dbMax.addEventListener('input', onDb); }
        this._syncDbUI();

        // Reflect current dial frequency (updates handled via onFrequencyChanged)
        this._showDial(this.radio.getFrequency());
    }

    _syncDbUI() {
        const r = document.getElementById('qrss-db-readout');
        if (r) r.textContent = `${this.config.dbMin} … ${this.config.dbMax} dB`.replace(/-/g, '−');
        const box = document.querySelector('.qrss-range');
        if (box) box.style.opacity = this.config.autoContrast ? 0.4 : 1;
    }

    _tuneBand(dialHz) {
        this.dialFreq = dialHz;
        if (this.radio.getMode && this.radio.getMode() !== 'usb') this.radio.setMode('usb');
        this.radio.setFrequency(dialHz);
        if (this.radio.setBandwidth) this.radio.setBandwidth(0, 3000);
        this._showDial(dialHz);
    }

    _showDial(hz) {
        this.dialFreq = hz || this.dialFreq;
        const el = document.getElementById('qrss-dial-freq');
        if (el) el.textContent = this.radio.formatFrequency(this.dialFreq);
    }

    // ── Derived-parameter helpers ─────────────────────────────────────────────
    // Hop = samples advanced between FFTs = seconds-per-pixel × decimated rate.
    // Deriving it from a time target (rather than an overlap fraction) keeps the
    // time axis stable when the FFT size or window is changed.
    _recalcHop() {
        const decSR = this.decSR || ((window.audioContext && window.audioContext.sampleRate) || 48000) / Math.max(1, this.decim || 1);
        this.hop = Math.max(1, Math.round(this.config.secPerPixel * decSR));
    }

    // Nearest value among the Speed dropdown options (for snapping on Auto).
    _nearestSpeed(v) {
        const opts = [0.25, 0.5, 1, 2, 3, 5, 10, 15, 20];
        let best = opts[0];
        for (const o of opts) if (Math.abs(o - v) < Math.abs(best - v)) best = o;
        return String(best);
    }

    _updateDerived() {
        const inSR = (window.audioContext && window.audioContext.sampleRate) || 48000;
        this.inSR = inSR;
        // Decimate so the complex baseband bandwidth ≈ the requested span.
        this.decim = Math.max(1, Math.round(inSR / this.config.span));
        this.decSR = inSR / this.decim;          // full displayed bandwidth (complex)
        this.effSpan = this.decSR;
        // Centre: default puts the view at [0, span]; keep it inside [0, Nyquist].
        let fc = (this.config.centerHz == null) ? this.decSR / 2 : this.config.centerHz;
        fc = Math.max(0, Math.min(inSR / 2, fc));
        this.fc = fc;
        // Window-lock mode: hold the total on-screen time by deriving s/px from
        // the current pixel width (so it stays constant when the panel resizes).
        if (this.config.windowSec > 0 && this.innerW) {
            this.config.secPerPixel = this.config.windowSec / this.innerW;
        }
        this._recalcHop();
        const binHz = this.decSR / this.config.fftSize;
        const secPerCol = this.hop / this.decSR;
        const sweep = secPerCol * (this.innerW || 600);
        const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
        set('qrss-stat-bin', `${binHz < 1 ? binHz.toFixed(3) : binHz.toFixed(2)} Hz`);
        set('qrss-stat-rate', `${secPerCol.toFixed(2)} s/px`);
        set('qrss-stat-sweep', this._fmtDuration(sweep));
        this._updateBandInfo();
    }

    // Read the receiver's current audio passband (like the audio widget does) and
    // show it, so the user can see the bandwidth the zoom is working within.
    _passband() {
        let bw = null;
        try { bw = this.radio.getBandwidth && this.radio.getBandwidth(); } catch (_) {}
        let lo = bw ? bw.low : window.currentBandwidthLow;
        let hi = bw ? bw.high : window.currentBandwidthHigh;
        if (typeof lo !== 'number' || typeof hi !== 'number') return { start: 0, end: (this.inSR || 48000) / 2 };
        // Convert to an absolute [start,end] audio window (mirrors getBandFreqRange)
        if (lo < 0 && hi > 0) return { start: 0, end: Math.max(-lo, hi) };
        if (lo < 0 && hi <= 0) return { start: -hi, end: -lo };
        return { start: Math.max(0, lo), end: hi };
    }

    _updateBandInfo() {
        const pb = this._passband();
        const lo = this.fc - this.decSR / 2, hi = this.fc + this.decSR / 2;
        const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
        set('qrss-stat-view', `${(lo / 1000).toFixed(2)}–${(hi / 1000).toFixed(2)} kHz`);
        set('qrss-stat-rxbw', `${(pb.start / 1000).toFixed(1)}–${(pb.end / 1000).toFixed(1)} kHz`);
    }

    _fmtDuration(s) {
        if (s < 90) return `${s.toFixed(0)} s`;
        const m = s / 60;
        if (m < 90) return `${m.toFixed(1)} min`;
        return `${(m / 60).toFixed(1)} h`;
    }

    // ── Frequency → pixel mapping ─────────────────────────────────────────────
    // Complex spectrum: bins span [-N/2, +N/2) around DC (== centre frequency),
    // in fftshift order. A pixel's frequency fraction maps linearly to a signed
    // bin; paint indexes the FFT output with modulo N. Top pixel = highest freq.
    _buildBinMap() {
        const N = this.config.fftSize, H = this.innerH;
        this.binMap = new Int32Array(H * 2);
        for (let y = 0; y < H; y++) {
            const bLoF = (0.5 - (y + 1) / H) * N;   // lower-freq edge of this pixel
            const bHiF = (0.5 - y / H) * N;         // upper-freq edge
            const start = Math.round(bLoF);
            this.binMap[y * 2] = start;             // signed start bin
            this.binMap[y * 2 + 1] = Math.max(1, Math.round(bHiF) - start); // bin count
        }
    }

    // ── Capture control ───────────────────────────────────────────────────────
    async start() {
        if (this.running) return;
        if (!window.audioContext) {
            this._setStatus('No audio — start listening first', 'err');
            return;
        }
        const ctx = window.audioContext;
        this._updateDerived();

        // Build DSP objects for the current settings
        this.fft = new FFT(this.config.fftSize);
        this.fftRe = new Float32Array(this.config.fftSize);
        this.fftIm = new Float32Array(this.config.fftSize);
        this.hann = new Float32Array(this.config.fftSize);
        for (let i = 0; i < this.config.fftSize; i++)
            this.hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (this.config.fftSize - 1)));
        this.ringI = new Float32Array(this.config.fftSize);
        this.ringQ = new Float32Array(this.config.fftSize);
        this.ringPos = 0; this.totalIn = 0; this.sinceLast = 0;

        // Widen the receiver passband if the requested view needs more audio
        this._ensurePassband();

        // Ensure the shared recorder tap node exists; the per-buffer audio chain
        // connects outputNode → recorderGainNode when it is present, giving us a
        // continuous post-demod stream (same path the WAV recorder uses).
        if (!window.recorderGainNode) {
            window.recorderGainNode = ctx.createGain();
            window.recorderGainNode.gain.value = 1.0;
        }

        try {
            await ctx.audioWorklet.addModule('/extensions/qrss/qrss-worklet.js');
        } catch (e) {
            if (!e.message || !e.message.includes('already')) {
                this._setStatus('Worklet load failed', 'err');
                console.error('QRSS: worklet load failed', e);
                return;
            }
        }

        const coeffs = designLowpass(this.decim);
        const batch = Math.max(64, Math.min(4096, Math.round(this.decSR * 0.1)));
        this.workletNode = new AudioWorkletNode(ctx, 'qrss-ddc-processor', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            processorOptions: { fc: this.fc, inSR: this.inSR, decim: this.decim, coeffs, batch }
        });
        this.workletNode.port.onmessage = (e) => {
            if (e.data && e.data.iq) this._ingest(e.data.iq);
        };

        // Keep the node pulled without emitting audio
        this.sinkNode = ctx.createGain();
        this.sinkNode.gain.value = 0;
        window.recorderGainNode.connect(this.workletNode);
        this.workletNode.connect(this.sinkNode);
        this.sinkNode.connect(ctx.destination);
        this.workletNode.port.postMessage({ command: 'start' });

        this.running = true;
        this.paused = false;
        this.lastColTime = performance.now();
        this._setStatus('Running', 'ok');
        this._toggleButtons(true);
    }

    stop() {
        if (!this.running && !this.workletNode) { this._toggleButtons(false); return; }
        this.running = false;
        this.paused = false;
        try {
            if (this.workletNode) {
                this.workletNode.port.postMessage({ command: 'stop' });
                try { window.recorderGainNode && window.recorderGainNode.disconnect(this.workletNode); } catch (_) {}
                this.workletNode.disconnect();
            }
            if (this.sinkNode) this.sinkNode.disconnect();
        } catch (_) {}
        this.workletNode = null; this.sinkNode = null;
        this._setStatus('Stopped', 'idle');
        this._toggleButtons(false);
    }

    // Freeze/unfreeze the waterfall without tearing down capture, so the current
    // image can be inspected and saved without new columns pushing it along.
    togglePause() {
        if (!this.running) return;
        this.paused = !this.paused;
        const b = document.getElementById('qrss-pause-btn');
        if (b) { b.textContent = this.paused ? 'Live' : 'Freeze'; b.classList.toggle('qrss-btn-active', this.paused); }
        this._setStatus(this.paused ? 'Frozen' : 'Running', this.paused ? 'idle' : 'ok');
    }

    _restartIfRunning() {
        this._updateDerived();
        this._buildBinMap();
        this._redraw();
        if (this.running) { this.stop(); this.start(); }
    }

    _toggleButtons(on) {
        const s = document.getElementById('qrss-start-btn');
        const t = document.getElementById('qrss-stop-btn');
        const p = document.getElementById('qrss-pause-btn');
        if (s) s.disabled = on;
        if (t) t.disabled = !on;
        if (p) { p.disabled = !on; if (!on) { p.textContent = 'Freeze'; p.classList.remove('qrss-btn-active'); } }
    }

    _setStatus(text, kind) {
        const b = document.getElementById('qrss-status-badge');
        if (!b) return;
        b.textContent = text;
        b.className = 'qrss-badge qrss-badge-' + (kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : 'idle');
    }

    // ── Sample ingest & FFT ───────────────────────────────────────────────────
    // samples: interleaved complex baseband [I0,Q0,I1,Q1,…] from the DDC worklet.
    _ingest(samples) {
        if (this.paused) return;                 // frozen: drop incoming audio
        const N = this.config.fftSize;
        for (let i = 0; i < samples.length; i += 2) {
            this.ringI[this.ringPos] = samples[i];
            this.ringQ[this.ringPos] = samples[i + 1];
            this.ringPos = this.ringPos === N - 1 ? 0 : this.ringPos + 1;
            this.totalIn++;
            if (++this.sinceLast >= this.hop && this.totalIn >= N) {
                this.sinceLast = 0;
                this._computeColumn();
            }
        }
    }

    _computeColumn() {
        const N = this.config.fftSize;
        const re = this.fftRe, im = this.fftIm, hann = this.hann, ringI = this.ringI, ringQ = this.ringQ;
        // Copy the last N complex samples in chronological order, windowed
        let idx = this.ringPos; // oldest sample position
        for (let i = 0; i < N; i++) {
            re[i] = ringI[idx] * hann[i];
            im[i] = ringQ[idx] * hann[i];
            idx = idx === N - 1 ? 0 : idx + 1;
        }
        this.fft.transform(re, im);
        this._paintColumn(re, im);
    }

    _paintColumn(re, im) {
        const H = this.innerH, W = this.innerW;
        if (!this.wfCtx || H <= 0) return;
        const N = this.config.fftSize;
        const norm = 1 / (N * 0.5);            // window/coherent gain normalisation
        const binMap = this.binMap;

        // Per-pixel dB (max over the pixel's bin range). Bins are fftshift-signed,
        // so index the FFT output modulo N.
        const dbCol = new Float32Array(H);
        for (let y = 0; y < H; y++) {
            const start = binMap[y * 2], count = binMap[y * 2 + 1];
            let maxP = 0;
            for (let c = 0; c < count; c++) {
                const b = ((start + c) % N + N) % N;
                const p = re[b] * re[b] + im[b] * im[b];
                if (p > maxP) maxP = p;
            }
            dbCol[y] = 10 * Math.log10(maxP * norm * norm + 1e-20);
        }

        // Keep the raw dB column so contrast/palette changes can recolour the
        // whole visible waterfall, not just newly-arriving columns.
        this._pushHistory(dbCol);

        // Auto-contrast: track a smoothed noise floor. When the derived range
        // shifts, recolour the entire display so it stays balanced.
        let rangeChanged = false;
        if (this.config.autoContrast) {
            this.floorEMA = 0.9 * this.floorEMA + 0.1 * this._median(dbCol);
            const nMin = Math.round(this.floorEMA + this.config.autoFloorOffset);
            const nMax = Math.round(this.floorEMA + this.config.autoFloorOffset + this.config.autoSpan);
            if (nMin !== this.config.dbMin || nMax !== this.config.dbMax) {
                this.config.dbMin = nMin; this.config.dbMax = nMax;
                this._reflectDbUI();
                rangeChanged = true;
            }
        }

        if (rangeChanged) {
            this._rerenderAll();
        } else {
            // Fast path: scroll left 1px and append the new column on the right
            this.wfCtx.drawImage(this.wf, -1, 0);
            this.wfCtx.putImageData(new ImageData(this._colorColumn(dbCol), 1, H), W - 1, 0);
            this._redraw();
        }
    }

    // Map one raw-dB column to RGBA pixels using the current range and palette.
    _colorColumn(dbCol) {
        const H = dbCol.length, lut = this.colLUT;
        const dbMin = this.config.dbMin, range = (this.config.dbMax - this.config.dbMin) || 1;
        const col = new Uint8ClampedArray(H * 4);
        for (let y = 0; y < H; y++) {
            let t = (dbCol[y] - dbMin) / range;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ci = (t * 255) | 0;
            col[y * 4]     = lut[ci * 3];
            col[y * 4 + 1] = lut[ci * 3 + 1];
            col[y * 4 + 2] = lut[ci * 3 + 2];
            col[y * 4 + 3] = 255;
        }
        return col;
    }

    _pushHistory(dbCol) {
        if (!this.dbHistory) this.dbHistory = [];
        this.dbHistory.push(dbCol);
        while (this.dbHistory.length > this.innerW) this.dbHistory.shift();
    }

    // Recolour every stored column — used when contrast, palette or auto range
    // changes so the adjustment applies to the whole waterfall instantly.
    _rerenderAll() {
        if (!this.wfCtx) return;
        const H = this.innerH, W = this.innerW;
        this.wfCtx.fillStyle = '#000';
        this.wfCtx.fillRect(0, 0, W, H);
        const hist = this.dbHistory || [];
        const start = W - hist.length;   // right-align newest column at W-1
        for (let i = 0; i < hist.length; i++) {
            if (hist[i].length !== H) continue;   // skip columns from a prior size
            this.wfCtx.putImageData(new ImageData(this._colorColumn(hist[i]), 1, H), start + i, 0);
        }
        this._redraw();
    }

    _reflectDbUI() {
        this._syncDbUI();
        const dn = document.getElementById('qrss-dbmin'); if (dn) dn.value = this.config.dbMin;
        const dx = document.getElementById('qrss-dbmax'); if (dx) dx.value = this.config.dbMax;
    }

    _median(arr) {
        const c = Array.prototype.slice.call(arr).sort((a, b) => a - b);
        return c[c.length >> 1];
    }

    // ── Compositing (axes, colour bar, header) ────────────────────────────────
    _redraw() {
        if (!this.ctx) return;
        const ctx = this.ctx, m = this.margins;
        const W = this.cssW, Hc = this.cssH;
        ctx.clearRect(0, 0, W, Hc);
        ctx.fillStyle = '#0a0e14';
        ctx.fillRect(0, 0, W, Hc);

        // Waterfall — draw the magnifier's sub-rectangle scaled to fill the plot
        if (this.wf) {
            const v = this.view, ww = this.wf.width, wh = this.wf.height;
            const sx = v.x0 * ww, sy = v.y0 * wh;
            const sw = (v.x1 - v.x0) * ww, sh = (v.y1 - v.y0) * wh;
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(this.wf, sx, sy, sw, sh, m.l, m.t, this.innerW, this.innerH);
        }
        ctx.strokeStyle = '#2a3340';
        ctx.strokeRect(m.l + 0.5, m.t + 0.5, this.innerW, this.innerH);

        this._drawFreqAxis(ctx);
        this._drawTimeAxis(ctx);
        this._drawColorbar(ctx);
        this._drawHeader(ctx);
    }

    // Frequency axis labelled in absolute RF: dial + audio (fc + FFT offset).
    // Reflects the magnifier's visible frequency sub-range.
    _drawFreqAxis(ctx) {
        const m = this.margins, H = this.innerH, v = this.view;
        const decSR = this.decSR || this.config.span;
        const fullHi = this.fc + decSR / 2;
        // Visible band (y0 top = highest freq)
        const visHi = fullHi - v.y0 * decSR;
        const visLo = fullHi - v.y1 * decSR;
        const visRange = visHi - visLo;
        ctx.fillStyle = '#8aa0b8';
        ctx.font = '10px -apple-system, Segoe UI, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const step = this._niceStep(visRange, 6);
        const decimals = Math.max(1, Math.min(3, Math.ceil(Math.log10(1000 / step))));
        const first = Math.ceil(visLo / step) * step;
        if (visRange > 0 && isFinite(visRange) && step > 0) {
            for (let fa = first; fa <= visHi + 0.001; fa += step) {
                const y = m.t + H * (1 - (fa - visLo) / visRange);
                ctx.strokeStyle = 'rgba(255,255,255,0.06)';
                ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + this.innerW, y); ctx.stroke();
                const rfk = (this.dialFreq + fa) / 1000;   // kHz
                ctx.fillStyle = '#8aa0b8';
                ctx.fillText(rfk.toFixed(decimals), m.l - 6, y);
            }
        }
        ctx.save();
        ctx.translate(11, m.t + H / 2); ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center'; ctx.fillStyle = '#5f7488';
        ctx.fillText(this.dialFreq ? 'Frequency (kHz)' : 'Audio (kHz)', 0, 0);
        ctx.restore();
    }

    _drawTimeAxis(ctx) {
        const m = this.margins, W = this.innerW, v = this.view;
        const secPerCol = this.hop / (this.decSR || 1);
        const total = secPerCol * W;
        // Visible time span (x1 right = newest → smallest age)
        const agoLeft = total * (1 - v.x0);   // oldest visible (left edge)
        const agoRight = total * (1 - v.x1);  // newest visible (right edge)
        const visRange = agoLeft - agoRight;
        ctx.fillStyle = '#8aa0b8';
        ctx.font = '10px -apple-system, Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const step = this._niceStep(visRange, 6);
        if (visRange > 0 && isFinite(visRange) && step > 0) {
            const first = Math.ceil(agoRight / step) * step;
            for (let s = first; s <= agoLeft + 0.001; s += step) {
                const x = m.l + W * (1 - (s - agoRight) / visRange);
                ctx.fillText('-' + this._fmtShort(s), x, m.t + this.innerH + 4);
            }
        }
        ctx.textAlign = 'right'; ctx.fillStyle = '#5f7488';
        ctx.fillText('now', m.l + W, m.t + this.innerH + 4);
    }

    _drawColorbar(ctx) {
        const m = this.margins, H = this.innerH;
        const x = m.l + this.innerW + 14, w = 12;
        for (let y = 0; y < H; y++) {
            const t = 1 - y / H;
            const ci = (t * 255) | 0;
            ctx.fillStyle = `rgb(${this.colLUT[ci * 3]},${this.colLUT[ci * 3 + 1]},${this.colLUT[ci * 3 + 2]})`;
            ctx.fillRect(x, m.t + y, w, 1);
        }
        ctx.strokeStyle = '#2a3340'; ctx.strokeRect(x + 0.5, m.t + 0.5, w, H);
        ctx.fillStyle = '#8aa0b8'; ctx.font = '9px sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(String(this.config.dbMax).replace('-', '−'), x + w + 3, m.t + 4);
        ctx.fillText(String(this.config.dbMin).replace('-', '−'), x + w + 3, m.t + H - 4);
        ctx.save(); ctx.translate(x + w + 22, m.t + H / 2); ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center'; ctx.fillStyle = '#5f7488'; ctx.fillText('dB', 0, 0); ctx.restore();
    }

    _drawHeader(ctx) {
        const m = this.margins;
        ctx.fillStyle = '#e6edf3';
        ctx.font = '600 11px -apple-system, Segoe UI, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const dial = this.dialFreq ? this.radio.formatFrequency(this.dialFreq) : '—';
        ctx.fillText(`QRSS · USB dial ${dial}`, m.l, m.t / 2);
        ctx.textAlign = 'right'; ctx.fillStyle = '#5f7488';
        const binHz = (this.decSR / this.config.fftSize);
        ctx.fillText(`${binHz < 1 ? binHz.toFixed(3) : binHz.toFixed(2)} Hz/bin`, this.cssW - m.r, m.t / 2);
    }

    _niceStep(range, targetTicks) {
        if (!(range > 0) || !isFinite(range)) return 1;   // guard: never 0/NaN (would hang tick loops)
        const raw = range / targetTicks;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const n = raw / mag;
        const step = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
        return step * mag;
    }

    _fmtShort(s) {
        if (s < 60) return s.toFixed(0) + 's';
        const m = Math.floor(s / 60), r = Math.round(s % 60);
        return r ? `${m}m${r}s` : `${m}m`;
    }

    _onHover(e) {
        if (!this.decSR) return;
        const p = this._pos(e);
        const h = document.getElementById('qrss-hover');
        if (!p) { if (h) h.hidden = true; return; }
        const { audio, ago } = this._pointToFreqTime(p.x, p.y);
        const rf = this.dialFreq + audio;
        if (h) {
            h.hidden = false;
            h.style.left = Math.min(p.x + 12, this.cssW - 130) + 'px';
            h.style.top = (p.y + 12) + 'px';
            h.innerHTML = `${(rf / 1e6).toFixed(5)} MHz<br>${audio.toFixed(1)} Hz · -${this._fmtShort(ago)}`;
        }
    }

    // Pointer position within the plot area (device-independent px), or null.
    _pos(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top, m = this.margins;
        if (x < m.l || x > m.l + this.innerW || y < m.t || y > m.t + this.innerH) return null;
        return { x, y };
    }

    // Plot pixel → audio frequency + age, through the magnifier view transform.
    _pointToFreqTime(x, y) {
        const m = this.margins, v = this.view, decSR = this.decSR || this.config.span;
        const px = (x - m.l) / this.innerW, py = (y - m.t) / this.innerH;
        const cxn = v.x0 + px * (v.x1 - v.x0);   // content time  (0=oldest, 1=newest)
        const cyn = v.y0 + py * (v.y1 - v.y0);   // content freq  (0=top/high, 1=bottom/low)
        const audio = (this.fc + decSR / 2) - cyn * decSR;
        const secPerCol = this.hop / (decSR || 1);
        const ago = secPerCol * this.innerW * (1 - cxn);
        return { audio, ago };
    }

    // ── Magnifier: zoom + pan the displayed waterfall (no re-tuning) ───────────
    _onWheel(e) {
        const p = this._pos(e);
        if (!p) return;
        e.preventDefault();
        // Normalise delta across wheel modes (line/page) and pixel (trackpad).
        let d = e.deltaY;
        if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= this.innerH;
        d = Math.max(-100, Math.min(100, d));
        if (!d) return;
        const f = Math.exp(d * 0.003);            // >1 zoom out, <1 zoom in
        const px = (p.x - this.margins.l) / this.innerW;
        const py = (p.y - this.margins.t) / this.innerH;
        this._zoomView(f, px, py);
        this._redraw();
    }

    _zoomView(f, px, py) {
        const v = this.view, minW = 0.02;         // up to ~50× magnification
        let wx = v.x1 - v.x0, wy = v.y1 - v.y0;
        const cx = v.x0 + px * wx, cy = v.y0 + py * wy;   // content point under cursor
        wx = Math.min(1, Math.max(minW, wx * f));
        wy = Math.min(1, Math.max(minW, wy * f));
        const x0 = Math.min(1 - wx, Math.max(0, cx - px * wx));
        const y0 = Math.min(1 - wy, Math.max(0, cy - py * wy));
        this.view = { x0, y0, x1: x0 + wx, y1: y0 + wy };
    }

    _onDragStart(e) {
        const p = this._pos(e);
        if (!p) return;
        this._dragging = true;
        this._dragLast = p;
        this.canvas.style.cursor = 'grabbing';
    }

    _onDragEnd() {
        if (!this._dragging) return;
        this._dragging = false;
        if (this.canvas) this.canvas.style.cursor = 'crosshair';
    }

    _onMouseMove(e) {
        if (this._dragging) {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left, y = e.clientY - rect.top;
            const dxn = (x - this._dragLast.x) / this.innerW * (this.view.x1 - this.view.x0);
            const dyn = (y - this._dragLast.y) / this.innerH * (this.view.y1 - this.view.y0);
            this._dragLast = { x, y };
            this._panView(-dxn, -dyn);            // grab-scroll: content follows the cursor
            this._redraw();
        } else {
            this._onHover(e);
        }
    }

    _panView(dxn, dyn) {
        const v = this.view, wx = v.x1 - v.x0, wy = v.y1 - v.y0;
        const x0 = Math.min(1 - wx, Math.max(0, v.x0 + dxn));
        const y0 = Math.min(1 - wy, Math.max(0, v.y0 + dyn));
        this.view = { x0, y0, x1: x0 + wx, y1: y0 + wy };
    }

    _resetView() {
        this.view = { x0: 0, y0: 0, x1: 1, y1: 1 };
        this._redraw();
    }

    // Widen the receiver passband (never narrows) so the requested view is
    // actually delivered as audio. Uses the same setBandwidth path as the UI.
    _ensurePassband() {
        if (!this.radio.setBandwidth) return;
        const need = Math.min((this.inSR || 48000) / 2, this.fc + this.decSR / 2);
        const pb = this._passband();
        if (need > pb.end + 1) this.radio.setBandwidth(0, Math.round(need));
    }

    clearWaterfall() {
        this.dbHistory = [];
        this.view = { x0: 0, y0: 0, x1: 1, y1: 1 };   // content remapped — reset magnifier
        if (this.wfCtx) { this.wfCtx.fillStyle = '#000'; this.wfCtx.fillRect(0, 0, this.innerW, this.innerH); }
        this._redraw();
    }

    savePNG() {
        if (!this.canvas) return;
        const band = this.dialFreq ? (this.dialFreq / 1e6).toFixed(4) + 'MHz' : 'audio';
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        this.canvas.toBlob((blob) => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `qrss_${band}_${ts}.png`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });
    }
}

// Register the extension
if (window.decoderManager) {
    window.qrssExtensionInstance = new QRSSExtension();
    window.decoderManager.register(window.qrssExtensionInstance);
    console.log('QRSS Grabber extension registered');
} else {
    console.error('QRSS: decoderManager not available');
}

})();
