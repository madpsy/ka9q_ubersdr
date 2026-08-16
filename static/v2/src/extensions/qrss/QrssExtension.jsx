// QRSS Grabber — v1's extension, rebuilt for v2.
//
// The odd one out: every other extension here asks the server to decode
// something and draws the answer. This one decodes nothing and runs entirely in
// the browser, because QRSS has no decoder — it is Morse at one dot per several
// seconds, read off a waterfall by eye, and the reason it works at all is that
// integrating for seconds per pixel finds a beacon twenty dB under the noise.
//
// So there is no attach, no `useAudioExtension`, and no server-side anything.
// It taps the player's audio, down-converts and decimates it in a worklet, and
// runs a long overlapping FFT per column (see ./dsp.js and ./render.js).
//
// Two things differ from v1 beyond the port:
//
//   * The tap is before the volume control, not after. v1 hung off the recorder
//     node, which sits after the fader — so muting the receiver, or turning the
//     volume down to leave a grabber running overnight, silently froze the
//     waterfall. It also sits before the EQ and notch filters, so a notch set
//     for listening does not put a stripe down the display.
//   * The waterfall keeps its dB values, not just its pixels. Changing palette
//     or contrast recolours the whole history rather than only what arrives
//     next, which is what makes those controls usable on a display that takes
//     ten minutes to fill.
//
// `minimal` keeps the band, the transport and the waterfall, and drops the
// settings row and the readouts under it. What is worth keeping is decided by how
// this one is used: a grabber is started once and left for hours, so the span,
// the resolution and the palette are what you set at the beginning and the band
// is what you keep coming back to — which is why the Tune to… dropdown stays and
// sits in the transport row rather than with the settings. See the registry's
// `minimal`.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Icon, Switch } from '../../components/ui.jsx';
import { tunedOption } from '../frequencies.js';
import {
    AUTO_LEVELS, FFT, FULL_VIEW, PALETTES, QRSS_BANDS, QRSS_CONFIG, RESOLUTIONS, SPANS, SPEEDS,
    WINDOWS, trackFloor, autoSpanOf, buildBinMap, buildColorLUT, colorColumn, derive, designLowpass,
    fmtDuration, fmtShort, hannWindow, panView, pointToFreqTime, powerColumn, zoomView,
} from './dsp.js';
import { MARGINS, dbAt, drawFrame, plotSize } from './render.js';
import { saveFile } from '../../lib/saveFile.js';

const WORKLET_URL = '/qrss-ddc-worklet.js';
const PROCESSOR = 'qrss-ddc-processor-v2';

// QRSS is received in USB. The passband is widened, never narrowed, to reach
// whatever the display is asking for — see ensurePassband below.
const QRSS_MODE = 'usb';

export default function QrssExtension({ minimal }) {
    const { running, audioState, tuning, actions, player } = useRadio();
    const live = running && audioState === 'open';

    const [capturing, setCapturing] = useState(false);
    const [frozen, setFrozen] = useState(false);
    const [config, setConfig] = useState(QRSS_CONFIG);
    const [status, setStatus] = useState({ columns: 0, fill: 0, error: '' });
    const [hover, setHover] = useState(null);
    // The plot size is in state as well as in the ref because the derived
    // numbers depend on it: with the window locked, seconds-per-pixel is the
    // window divided by the width, so a resize has to recompute them.
    const [plot, setPlot] = useState({ innerW: 0, innerH: 0 });
    // The dB range is state so the colour bar can show it, but auto-contrast
    // writes to it several times a second at first — see the note on `range`.
    const [range, setRange] = useState({ dbMin: QRSS_CONFIG.dbMin, dbMax: QRSS_CONFIG.dbMax });

    const wrap = useRef(null);
    const canvas = useRef(null);
    // Everything the capture and paint path touches. It runs off the audio
    // thread's messages, not off renders, so none of it may live in state:
    // a setState per FFT column would re-render the panel every hop.
    const g = useRef({
        ctx: null, node: null, sink: null,
        fft: null, re: null, im: null, hann: null,
        ringI: null, ringQ: null, ringPos: 0, total: 0, since: 0,
        wf: null, wfCtx: null, binMap: null, history: [],
        lut: buildColorLUT(QRSS_CONFIG.colormap),
        floorEMA: -110, dbMin: QRSS_CONFIG.dbMin, dbMax: QRSS_CONFIG.dbMax,
        view: FULL_VIEW, innerW: 0, innerH: 0, cssW: 0, cssH: 0, dpr: 1,
        derived: null, frozen: false, dial: 0,
    });

    const sampleRate = (player && player.sampleRate) || 48000;
    const d = useMemo(
        () => derive(config, sampleRate, plot.innerW || 600),
        [config, sampleRate, plot.innerW],
    );

    // What the worklet is built from, as plain numbers: an object identity that
    // changes on every palette tweak would rebuild the audio graph.
    const { fc, decim, inSR, decSR } = d;
    const dRef = useRef(d);
    dRef.current = d;

    // ── painting ────────────────────────────────────────────────────────────

    const repaint = useCallback(() => {
        const s = g.current;
        if (!canvas.current || !s.derived) return;
        drawFrame(canvas.current, {
            wf: s.wf,
            view: s.view,
            innerW: s.innerW,
            innerH: s.innerH,
            cssW: s.cssW,
            cssH: s.cssH,
            dpr: s.dpr,
            fc: s.derived.fc,
            decSR: s.derived.decSR,
            secPerCol: s.derived.secPerCol,
            dial: s.dial,
            binHz: s.derived.binHz,
            dbMin: s.dbMin,
            dbMax: s.dbMax,
            lut: s.lut,
        });
    }, []);

    // Recolour every kept column. What makes palette and contrast changes apply
    // to the hour already on screen rather than only to what comes next.
    const rerenderAll = useCallback(() => {
        const s = g.current;
        if (!s.wfCtx) return;
        s.wfCtx.fillStyle = '#000';
        s.wfCtx.fillRect(0, 0, s.innerW, s.innerH);
        const start = s.innerW - s.history.length;   // newest column at the right edge
        for (let i = 0; i < s.history.length; i++) {
            const col = s.history[i];
            if (!col || col.length !== s.innerH) continue;
            s.wfCtx.putImageData(
                new ImageData(colorColumn(col, s.lut, s.dbMin, s.dbMax), 1, s.innerH),
                start + i, 0,
            );
        }
        repaint();
    }, [repaint]);

    const pushColumn = useCallback((dbCol) => {
        const s = g.current;
        s.history.push(dbCol);
        while (s.history.length > s.innerW) s.history.shift();

        let rangeChanged = false;
        if (s.autoContrast) {
            const next = trackFloor(s.floorEMA, dbCol, s.autoSpan);
            s.floorEMA = next.floorEMA;
            if (next.dbMin !== s.dbMin || next.dbMax !== s.dbMax) {
                s.dbMin = next.dbMin;
                s.dbMax = next.dbMax;
                setRange({ dbMin: next.dbMin, dbMax: next.dbMax });
                rangeChanged = true;
            }
        }

        if (rangeChanged) {
            rerenderAll();
        } else {
            // Scroll left one pixel and append on the right. Drawing the canvas
            // onto itself offset by one is what makes a waterfall cheap.
            s.wfCtx.drawImage(s.wf, -1, 0);
            s.wfCtx.putImageData(
                new ImageData(colorColumn(dbCol, s.lut, s.dbMin, s.dbMax), 1, s.innerH),
                s.innerW - 1, 0,
            );
            repaint();
        }
        setStatus((st) => ({ ...st, columns: st.columns + 1 }));
    }, [repaint, rerenderAll]);

    const computeColumn = useCallback(() => {
        const s = g.current;
        const N = s.fft.n;
        // The ring's write position is also the oldest sample, so this reads the
        // last N samples in chronological order, windowed.
        let idx = s.ringPos;
        for (let i = 0; i < N; i++) {
            s.re[i] = s.ringI[idx] * s.hann[i];
            s.im[i] = s.ringQ[idx] * s.hann[i];
            idx = idx === N - 1 ? 0 : idx + 1;
        }
        s.fft.transform(s.re, s.im);
        pushColumn(powerColumn(s.re, s.im, s.binMap, N));
    }, [pushColumn]);

    const ingest = useCallback((iq) => {
        const s = g.current;
        if (s.frozen || !s.fft || !s.binMap) return;
        const N = s.fft.n;
        for (let i = 0; i < iq.length; i += 2) {
            s.ringI[s.ringPos] = iq[i];
            s.ringQ[s.ringPos] = iq[i + 1];
            s.ringPos = s.ringPos === N - 1 ? 0 : s.ringPos + 1;
            s.total++;
            if (++s.since >= s.derived.hop && s.total >= N) {
                s.since = 0;
                computeColumn();
            }
        }
    }, [computeColumn]);

    // ── sizing ──────────────────────────────────────────────────────────────

    const resize = useCallback(() => {
        const s = g.current;
        const box = wrap.current;
        const c = canvas.current;
        if (!box || !c) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const cssW = Math.max(240, Math.round(box.clientWidth));
        const cssH = Math.max(160, Math.round(box.clientHeight));
        const { innerW, innerH } = plotSize(cssW, cssH);
        if (cssW === s.cssW && cssH === s.cssH && dpr === s.dpr) return;

        c.width = Math.round(cssW * dpr);
        c.height = Math.round(cssH * dpr);
        s.cssW = cssW;
        s.cssH = cssH;
        s.dpr = dpr;
        s.innerW = innerW;
        s.innerH = innerH;

        // A new plot size means new pixel rows, so the bin map and the offscreen
        // buffer are rebuilt. Columns captured at the old height cannot be
        // redrawn at the new one and are dropped by rerenderAll's length check.
        s.wf = document.createElement('canvas');
        s.wf.width = innerW;
        s.wf.height = innerH;
        s.wfCtx = s.wf.getContext('2d');
        s.binMap = buildBinMap(config.fftSize, innerH);
        setPlot({ innerW, innerH });
        rerenderAll();
    }, [config.fftSize, rerenderAll]);

    useEffect(() => {
        resize();
        const ro = new ResizeObserver(resize);
        if (wrap.current) ro.observe(wrap.current);
        return () => ro.disconnect();
    }, [resize]);

    // ── capture ─────────────────────────────────────────────────────────────

    // Mirror the settings the audio path reads into the ref it reads them from.
    useEffect(() => {
        const s = g.current;
        s.derived = d;
        s.autoContrast = config.autoContrast;
        s.autoSpan = autoSpanOf(config.autoLevel);
        s.dial = tuning.frequency;
        if (!config.autoContrast) {
            s.dbMin = config.dbMin;
            s.dbMax = config.dbMax;
        }
        s.binMap = buildBinMap(config.fftSize, s.innerH || 1);
        repaint();
    }, [d, config, tuning.frequency, repaint]);

    useEffect(() => { g.current.frozen = frozen; }, [frozen]);

    useEffect(() => {
        g.current.lut = buildColorLUT(config.colormap);
        rerenderAll();
    }, [config.colormap, rerenderAll]);

    useEffect(() => {
        if (config.autoContrast) return;
        g.current.dbMin = config.dbMin;
        g.current.dbMax = config.dbMax;
        setRange({ dbMin: config.dbMin, dbMax: config.dbMax });
        rerenderAll();
    }, [config.autoContrast, config.dbMin, config.dbMax, rerenderAll]);

    // Widen the receiver's passband if the display is asking for audio above
    // it. Never narrows: the operator's filter is theirs, and a grabber has no
    // business closing down the audio they are listening to.
    const ensurePassband = useCallback((want) => {
        const hi = Math.max(tuning.bandwidthHigh, 0);
        if (want > hi + 1) {
            actions.tuneTo({
                mode: QRSS_MODE,
                bandwidthLow: Math.min(0, tuning.bandwidthLow),
                bandwidthHigh: Math.round(Math.min(6000, want)),
            });
        }
    }, [actions, tuning.bandwidthHigh, tuning.bandwidthLow]);

    useEffect(() => {
        if (capturing && live) ensurePassband(d.hi);
    }, [capturing, live, d.hi, ensurePassband]);

    /**
     * The capture chain.
     *
     * Torn down and rebuilt only when the worklet's own parameters change —
     * it takes them at creation, so a new centre frequency or decimation means
     * a new node. Deliberately *not* rebuilt for a palette or contrast change,
     * which are also in `config`: restarting the capture would reset the
     * integration and leave a gap in the waterfall every time the operator
     * touched a colour control.
     */
    useEffect(() => {
        if (!capturing || !live || !player || !player.ctx || !player.head) return undefined;
        const d = dRef.current;

        const s = g.current;
        const ctx = player.ctx;
        let cancelled = false;

        const N = config.fftSize;
        s.fft = new FFT(N);
        s.re = new Float32Array(N);
        s.im = new Float32Array(N);
        s.hann = hannWindow(N);
        s.ringI = new Float32Array(N);
        s.ringQ = new Float32Array(N);
        s.ringPos = 0;
        s.total = 0;
        s.since = 0;
        s.derived = d;
        s.binMap = buildBinMap(N, s.innerH || 1);
        setStatus((st) => ({ ...st, error: '' }));

        (async () => {
            try {
                await ctx.audioWorklet.addModule(WORKLET_URL);
            } catch (err) {
                // Re-registering a module that is already there is not a
                // failure; the processor name is what matters.
                if (!err.message || !err.message.includes('already')) {
                    if (!cancelled) setStatus((st) => ({ ...st, error: 'Could not load the capture worklet.' }));
                    return;
                }
            }
            if (cancelled) return;

            const node = new AudioWorkletNode(ctx, PROCESSOR, {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                processorOptions: {
                    fc: d.fc,
                    inSR: d.inSR,
                    decim: d.decim,
                    coeffs: designLowpass(d.decim),
                    batch: Math.max(64, Math.min(4096, Math.round(d.decSR * 0.1))),
                },
            });
            node.port.onmessage = (e) => { if (e.data && e.data.iq) ingest(e.data.iq); };

            // Silent sink: the worklet emits nothing, and the connection only
            // guarantees the graph pulls it rather than optimising it away.
            const sink = ctx.createGain();
            sink.gain.value = 0;
            // Before the fader and the filters — see the note at the top.
            player.head.connect(node);
            node.connect(sink);
            sink.connect(ctx.destination);
            node.port.postMessage({ command: 'start' });

            s.node = node;
            s.sink = sink;
        })();

        return () => {
            cancelled = true;
            const cur = g.current;
            if (cur.node) {
                try { cur.node.port.postMessage({ command: 'stop' }); } catch (e) { /* gone */ }
                try { player.head.disconnect(cur.node); } catch (e) { /* gone */ }
                try { cur.node.disconnect(); } catch (e) { /* gone */ }
            }
            if (cur.sink) { try { cur.sink.disconnect(); } catch (e) { /* gone */ } }
            cur.node = null;
            cur.sink = null;
        };
    }, [capturing, live, player, config.fftSize, fc, decim, inSR, decSR, ingest]);

    // Powering the receiver off takes the audio with it.
    useEffect(() => { if (!running && capturing) setCapturing(false); }, [running, capturing]);

    // How long until the first column: a long FFT integrates for N/decSR
    // seconds before it has anything to show, and at Fine over a 100 Hz span
    // that is over a minute of a display that looks broken.
    useEffect(() => {
        if (!capturing) return undefined;
        const id = setInterval(() => {
            const s = g.current;
            const need = s.fft ? s.fft.n : config.fftSize;
            setStatus((st) => ({ ...st, fill: Math.min(1, s.total / need) }));
        }, 250);
        return () => clearInterval(id);
    }, [capturing, config.fftSize]);

    // ── interaction ─────────────────────────────────────────────────────────

    const plotPos = (e) => {
        const c = canvas.current;
        if (!c) return null;
        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const s = g.current;
        if (x < MARGINS.l || x > MARGINS.l + s.innerW || y < MARGINS.t || y > MARGINS.t + s.innerH) return null;
        return { x, y, px: (x - MARGINS.l) / s.innerW, py: (y - MARGINS.t) / s.innerH };
    };

    const drag = useRef(null);

    const onWheel = (e) => {
        const p = plotPos(e);
        if (!p) return;
        e.preventDefault();
        let delta = e.deltaY;
        if (e.deltaMode === 1) delta *= 16;
        else if (e.deltaMode === 2) delta *= g.current.innerH;
        delta = Math.max(-100, Math.min(100, delta));
        if (!delta) return;
        g.current.view = zoomView(g.current.view, Math.exp(delta * 0.003), p.px, p.py);
        repaint();
    };

    const onPointerDown = (e) => {
        const p = plotPos(e);
        if (!p) return;
        drag.current = { x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e) => {
        const s = g.current;
        if (drag.current) {
            const dx = (e.clientX - drag.current.x) / s.innerW * (s.view.x1 - s.view.x0);
            const dy = (e.clientY - drag.current.y) / s.innerH * (s.view.y1 - s.view.y0);
            drag.current = { x: e.clientX, y: e.clientY };
            // Grab-scroll: the content follows the cursor, so dragging right
            // moves the view left.
            s.view = panView(s.view, -dx, -dy);
            repaint();
            return;
        }
        const p = plotPos(e);
        if (!p || !s.derived) { setHover(null); return; }
        const { audio, ago } = pointToFreqTime(s.view, p.px, p.py, {
            fc: s.derived.fc, decSR: s.derived.decSR, secPerCol: s.derived.secPerCol, innerW: s.innerW,
        });
        const db = dbAt(s.history, s.view, p.px, p.py, s.innerW);
        setHover({
            x: p.x, y: p.y,
            rf: s.dial + audio,
            audio,
            ago,
            db,
        });
    };

    const endDrag = (e) => {
        if (!drag.current) return;
        drag.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
    };

    const resetView = () => { g.current.view = FULL_VIEW; repaint(); };

    // ── actions ─────────────────────────────────────────────────────────────

    const set = (patch) => setConfig((prev) => ({ ...prev, ...patch }));

    const tuned = tunedOption(QRSS_BANDS, tuning.frequency);

    const tuneTo = (dialHz) => {
        actions.tuneTo({
            frequency: dialHz,
            mode: QRSS_MODE,
            bandwidthLow: 0,
            bandwidthHigh: 3000,
        });
        actions.ensureVisible(dialHz);
    };

    const clear = () => {
        const s = g.current;
        s.history = [];
        s.view = FULL_VIEW;
        if (s.wfCtx) {
            s.wfCtx.fillStyle = '#000';
            s.wfCtx.fillRect(0, 0, s.innerW, s.innerH);
        }
        setStatus((st) => ({ ...st, columns: 0 }));
        repaint();
    };

    const savePNG = () => {
        const c = canvas.current;
        if (!c) return;
        const band = tuning.frequency ? `${(tuning.frequency / 1e6).toFixed(4)}MHz` : 'audio';
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        c.toBlob((blob) => {
            if (!blob) return;
            saveFile(blob, `qrss_${band}_${ts}.png`);
        });
    };

    const statusLabel = !capturing
        ? 'Idle'
        : (frozen ? 'Frozen' : (status.fill < 1 ? 'Filling' : 'Running'));
    const statusTone = !capturing ? 'off' : (frozen ? 'wait' : (status.fill < 1 ? 'wait' : 'on'));
    const sweep = d.secPerCol * (g.current.innerW || 600);

    return (
        <div className="tp qrss">
            <div className="tp__bar">
                <span className={`tp__status tp__status--${statusTone}`} title="Whether the grabber is capturing">
                    {statusLabel}
                </span>
                {capturing && status.fill < 1 && (
                    <span className="qrss__fill" title="A long FFT has to integrate before its first column exists">
                        {Math.round(status.fill * 100)}%
                    </span>
                )}
                <span className="tp__bar-gap" />

                <select
                    className="select tp__freq qrss__band"
                    value={tuned ? String(tuned.hz) : ''}
                    onChange={(e) => { if (e.target.value) tuneTo(Number(e.target.value)); }}
                    title="Set the dial for a band's QRSS window, in USB, and show which one the receiver is on"
                >
                    <option value="">Tune to…</option>
                    {QRSS_BANDS.map((grp) => (
                        <optgroup key={grp.group} label={grp.group}>
                            {grp.options.map((o) => <option key={o.hz} value={o.hz}>{o.label}</option>)}
                        </optgroup>
                    ))}
                </select>

                {capturing
                    ? (
                        <Button size="sm" onClick={() => { setCapturing(false); setFrozen(false); }} icon={<Icon.Stop size={13} />} title="Stop capturing">
                            Stop
                        </Button>
                    )
                    : (
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setCapturing(true)}
                            disabled={!live}
                            icon={<Icon.Power size={13} />}
                            title={live ? 'Start building the waterfall' : 'Start the receiver first'}
                        >
                            Start
                        </Button>
                    )}
                <Button
                    size="sm"
                    variant="ghost"
                    active={frozen}
                    disabled={!capturing}
                    onClick={() => setFrozen((v) => !v)}
                    icon={<Icon.Eye size={13} />}
                    title="Freeze the waterfall so you can zoom into it and save it without it scrolling out from under you"
                />
                <Button size="sm" variant="ghost" onClick={savePNG} disabled={!status.columns} icon={<Icon.Download size={13} />} title="Download the display, axes and all, as a PNG" />
                <Button size="sm" variant="ghost" onClick={clear} disabled={!status.columns} icon={<Icon.Trash size={13} />} title="Clear the waterfall" />
            </div>

            {/* Span, resolution, speed, palette, contrast — the setting up. It
                goes in the minimal view and the Tune to… dropdown above does not,
                which is the split the whole panel turns on: a grabber is left
                running for hours on one band, so the thing you keep reaching for
                is the band, and the rest is what you did once when you started it.

                Deliberately not the transport row's business, either — Start,
                Freeze and the two file buttons stay, because a display you cannot
                stop or save is not a smaller panel, it is a broken one. */}
            {!minimal && (
                <div className="tp__config">
                    <label className="tp__field" title="Displayed bandwidth. QRSS activity sits inside 100 Hz, so the narrow spans are where you end up; the wide ones are for finding it">
                        <span className="tp__field-label">Span</span>
                        <select className="select" value={config.span} onChange={(e) => set({ span: Number(e.target.value) })}>
                            {SPANS.map((v) => <option key={v} value={v}>{v >= 1000 ? `${v / 1000} kHz` : `${v} Hz`}</option>)}
                        </select>
                    </label>
                    <label className="tp__field" title="Frequency resolution. Finer takes longer to fill before the first column appears — narrowing the Span buys detail without the wait">
                        <span className="tp__field-label">Res</span>
                        <select className="select" value={config.fftSize} onChange={(e) => set({ fftSize: Number(e.target.value) })}>
                            {RESOLUTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                    </label>
                    <label className="tp__field" title="Time per pixel column. Match it to the beacon's dot length — QRSS-30 means thirty-second dots">
                        <span className="tp__field-label">Speed</span>
                        <select
                            className="select"
                            value={config.secPerPixel}
                            disabled={config.windowSec > 0}
                            onChange={(e) => set({ secPerPixel: Number(e.target.value) })}
                        >
                            {SPEEDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </select>
                    </label>
                    <label className="tp__field" title="Lock the total time on screen. Holds the sweep across a window resize, which Speed alone cannot">
                        <span className="tp__field-label">Window</span>
                        <select className="select" value={config.windowSec} onChange={(e) => set({ windowSec: Number(e.target.value) })}>
                            {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                        </select>
                    </label>
                    <label className="tp__field" title="Colour palette. Grey reads faint streaks best; the others separate levels more strongly">
                        <span className="tp__field-label">Palette</span>
                        <select className="select" value={config.colormap} onChange={(e) => set({ colormap: e.target.value })}>
                            {PALETTES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                        </select>
                    </label>

                    <Switch
                        label="Auto"
                        title="Track the noise floor and put the black point on it, so the display stays readable as conditions change"
                        checked={config.autoContrast}
                        onChange={(v) => set({ autoContrast: v })}
                    />
                    {config.autoContrast
                        ? (
                            <label className="tp__field" title="How much range above the noise floor to spread the palette over. High makes a weak signal pop; Low is gentler on a busy band">
                                <span className="tp__field-label">Level</span>
                                <select className="select" value={config.autoLevel} onChange={(e) => set({ autoLevel: e.target.value })}>
                                    {AUTO_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                                </select>
                            </label>
                        )
                        : (
                            <>
                                <label className="tp__field" title="Black point">
                                    <span className="tp__field-label">Min dB</span>
                                    <input
                                        className="input tp__num"
                                        type="range"
                                        min="-160"
                                        max="0"
                                        value={config.dbMin}
                                        onChange={(e) => set({ dbMin: Number(e.target.value) })}
                                    />
                                </label>
                                <label className="tp__field" title="Peak colour">
                                    <span className="tp__field-label">Max dB</span>
                                    <input
                                        className="input tp__num"
                                        type="range"
                                        min="-160"
                                        max="0"
                                        value={config.dbMax}
                                        onChange={(e) => set({ dbMax: Number(e.target.value) })}
                                    />
                                </label>
                            </>
                        )}
                </div>
            )}

            {!minimal && !running && <div className="note note--tight">Start the receiver to capture.</div>}
            {!minimal && running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {!minimal && live && !capturing && (
                <div className="note note--tight">
                    Pick a band, then press Start. Signals appear as faint horizontal streaks — scroll to zoom, drag to pan, double-click to reset.
                </div>
            )}
            {!minimal && capturing && tuning.mode !== QRSS_MODE && (
                <div className="note note--warn">QRSS is read in USB; the frequency scale will be wrong in {tuning.mode.toUpperCase()}.</div>
            )}
            {status.error && <div className="note note--warn">{status.error}</div>}

            {!minimal && (
                <div className="tp__controls qrss__stats">
                    <Stat label="View" value={`${(d.lo / 1000).toFixed(2)}–${(d.hi / 1000).toFixed(2)} kHz`} title="The audio band the display covers" />
                    <Stat label="Res" value={`${d.binHz < 1 ? d.binHz.toFixed(3) : d.binHz.toFixed(2)} Hz`} title="Frequency resolution — one FFT bin" />
                    <Stat label="Speed" value={`${d.secPerCol.toFixed(2)} s/px`} title="Seconds of audio per pixel column" />
                    <Stat label="Sweep" value={fmtDuration(sweep)} title="Total time across the display" />
                    <Stat label="Range" value={`${range.dbMin} … ${range.dbMax} dB`} title="The dB window the palette is spread over" />
                </div>
            )}

            <div className="qrss__plot" ref={wrap}>
                <canvas
                    ref={canvas}
                    className="qrss__canvas"
                    onWheel={onWheel}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onPointerLeave={() => setHover(null)}
                    onDoubleClick={resetView}
                />
                {hover && (
                    <div
                        className="qrss__hover"
                        style={{ left: Math.min(hover.x + 12, (g.current.cssW || 0) - 140), top: hover.y + 12 }}
                    >
                        {(hover.rf / 1e6).toFixed(5)} MHz
                        <br />
                        {hover.audio.toFixed(1)} Hz · -{fmtShort(hover.ago)}
                        {hover.db != null && ` · ${hover.db.toFixed(1)} dB`}
                    </div>
                )}
            </div>
        </div>
    );
}

function Stat({ label, value, title }) {
    return (
        <span className="qrss__stat" title={title}>
            <span className="qrss__stat-label">{label}</span>
            <span className="qrss__stat-value">{value}</span>
        </span>
    );
}
