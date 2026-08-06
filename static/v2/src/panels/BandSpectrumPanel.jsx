// The band you are in, at the resolution the receiver records it.
//
// A port of band_activity.html's per-band card, for one band: the one the dial
// is in. That page shows a grid of them because it is a survey of the whole
// receiver; a panel beside the dial wants the band being listened to and nothing
// else, and switches when the dial does.
//
// It is a different picture from the main waterfall above it, which is why it is
// worth the space: the server runs a dedicated FFT per configured band — 40m at
// 500 Hz a bin against the 7.3 kHz a 0–30 MHz view can afford — so the whole
// 200 kHz is on screen at once with every FT8 signal separated. The colours are
// the main waterfall's, from the same palette setting, so the two read as one
// instrument rather than two.
//
// Streaming is tied to the panel being open. Section only mounts a panel's body
// while its section is open, so the EventSource is opened on mount and closed on
// unmount: a collapsed panel holds no connection and the server sends it
// nothing. Same for a hidden panel, a closed mobile sheet, and a dock collapsed
// to its rail.
//
// `minimal` is the chart alone — the range controls are the first thing to go
// when a panel has been shrunk to glance at.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Empty, Switch } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { getPalette } from '../lib/palettes.js';
import { bandForFrequency } from '../lib/bands.js';
import {
    AUTO_SPAN_DEFAULT, applyFrame, bandsFromConfig, binAt, clampDb, configUrl,
    createAutoRange, dbFromByte, decodeFrame, formatAgeSec, formatDb, formatMHz, ft8Window,
    hzAt, rangeOf, rowAt, savePrefs, savedPrefs, scaleTicks, streamUrl, updateAutoRange,
    validValues,
} from '../lib/bandSpectrum.js';
import { readoutClearsOn, tipPlacement } from '../lib/hoverTip.js';
import { formatRate } from '../lib/format.js';

// The card's proportions, from band_activity.html: the block is this much of its
// own width, and the spectrum trace takes the top of it with the waterfall below.
const ASPECT = 200 / 340;
const SPEC_FRACTION = 80 / 200;
const MIN_H = 110;
const MAX_H = 320;          // a dock is not a grid cell — past this it crowds out its neighbours

// Rows of history. Deeper than fits on screen so the waterfall can be recoloured
// from raw values when the range moves, rather than showing two scales at once.
const WF_ROWS = 220;

export default function BandSpectrumPanel({ minimal }) {
    const { tuning } = useRadio();
    const display = useDisplay();
    const [bands, setBands] = useState(null);       // name → config, or null while loading
    const [prefs, setPrefs] = useState(savedPrefs);
    // Bytes a second on the stream, or null before the first second is up.
    // A rate says both things the word "live" did and one it did not: whether
    // anything is arriving, and what it costs — a busy band's deltas are bigger
    // than a quiet one's, and a stall reads as 0 rather than as a still picture.
    const [rate, setRate] = useState(null);
    const aliveRef = useRef(true);

    useEffect(() => () => { aliveRef.current = false; }, []);

    const band = bandForFrequency(tuning.frequency);
    const meta = bands && band ? bands[band] : null;

    // Which bands have a dedicated FFT. Fetched on open — the panel is not
    // mounted until then, so a collapsed panel does not ask for this either.
    useEffect(() => {
        fetch(configUrl())
            .then((r) => (r.ok ? r.json() : null))
            .then((cfg) => { if (aliveRef.current && cfg) setBands(bandsFromConfig(cfg)); })
            .catch(() => { if (aliveRef.current) setBands({}); });
    }, []);

    const setPref = useCallback((patch) => {
        setPrefs((p) => {
            const next = { ...p, ...patch };
            savePrefs(next);
            return next;
        });
    }, []);

    if (bands === null) return <Empty>Loading…</Empty>;
    if (!meta) {
        return (
            <Empty>
                {band ? `No dedicated spectrum for ${band}.` : 'Tune into a band to see its spectrum.'}
            </Empty>
        );
    }

    return (
        <div className="stack">
            <BandChart
                // Keyed on the band: tuning to another one is a new stream, a
                // new bin count and an empty history, so a fresh component says
                // it better than an effect unpicking the old one.
                key={band}
                band={band}
                meta={meta}
                prefs={prefs}
                palette={display.palette}
                onRate={setRate}
            />

            {!minimal && (
                <>
                    <div className="bsp__foot">
                        <span className="bsp__band">{band}</span>
                        <span className="bsp__range">{formatSpanMHz(meta)}</span>
                        <span
                            className={`bsp__state${rate ? ' is-live' : ''}`}
                            title="Data arriving on this band's spectrum stream"
                        >
                            {formatRate(rate)}
                        </span>
                    </div>

                    <div className="bsp__ctl">
                        <Switch
                            checked={prefs.auto}
                            onChange={(v) => setPref({ auto: v })}
                            label="Auto range"
                            title="Track the noise floor and the strongest signal, and hold the scale still between moves"
                        />
                        {!prefs.auto && (
                            <span className="bsp__manual">
                                <label>
                                    <span>min</span>
                                    <input
                                        type="number"
                                        className="input bsp__num"
                                        value={prefs.min}
                                        min={-160}
                                        max={0}
                                        step={1}
                                        onChange={(e) => setPref({ min: clampDb(e.target.value) })}
                                    />
                                </label>
                                <label>
                                    <span>max</span>
                                    <input
                                        type="number"
                                        className="input bsp__num"
                                        value={prefs.max}
                                        min={-160}
                                        max={0}
                                        step={1}
                                        onChange={(e) => setPref({ max: clampDb(e.target.value) })}
                                    />
                                </label>
                                <span className="bsp__unit">dBFS</span>
                            </span>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

function formatSpanMHz(meta) {
    const start = (meta.start || 0) / 1e6;
    const end = (meta.end || 0) / 1e6;
    const dp = end - start >= 1 ? 1 : 3;
    return `${start.toFixed(dp)}–${end.toFixed(dp)} MHz`;
}

// The chart itself: trace over waterfall, one canvas each.
//
// Keyed on the band by its caller, so tuning to another band remounts it — a
// new stream, a new bin count and an empty history, which is what changing band
// means. Nothing here has to unpick the old band's state.
function BandChart({ band, meta, prefs, palette, onRate }) {
    const wrapRef = useRef(null);
    const specRef = useRef(null);
    const wfRef = useRef(null);
    // What the pointer is over, or null. State rather than a ref: it is drawn as
    // DOM, and it changes at pointer speed rather than frame speed.
    const [at, setAt] = useState(null);
    // Measured width, which decides how many scale labels fit.
    const [width, setWidth] = useState(0);

    // Everything the draw path touches lives in one ref: React state per frame
    // at 4 Hz would re-render the panel forty times a minute for a picture that
    // is drawn imperatively anyway.
    const st = useRef({
        bins: null,
        rows: [],                    // raw dBFS history, newest last
        auto: createAutoRange(),
        prefs,
        lut: getPalette(palette),
        cmap: null,                  // palette as packed ABGR, for row writes
        off: null, offCtx: null,     // waterfall ring buffer
        rowPx: null, rowBuf: null,
        head: 0,
        dirty: false,
        ft8: null,
        // Inter-arrival period, for putting an age on a waterfall row. Measured
        // rather than assumed: the rate is the server's, not ours.
        period: 250, lastAt: 0,
        // Bytes since the throughput was last read.
        bytes: 0,
    }).current;

    st.prefs = prefs;
    st.ft8 = ft8Window(meta);

    // Palette as one Uint32 per level, which is what writing a waterfall row
    // wants — the LUT is three bytes a level for the main view's ImageData.
    useEffect(() => {
        const lut = getPalette(palette);
        const cmap = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            cmap[i] = (255 << 24) | (lut[i * 3 + 2] << 16) | (lut[i * 3 + 1] << 8) | lut[i * 3];
        }
        st.lut = lut;
        st.cmap = cmap;
        repaintHistory(st, meta.bin_count);
        st.dirty = true;
    }, [palette, meta.bin_count, st]);

    // A range change recolours the whole history, so old and new rows share one
    // scale rather than the waterfall showing a seam.
    useEffect(() => {
        repaintHistory(st, meta.bin_count);
        st.dirty = true;
    }, [prefs.auto, prefs.min, prefs.max, meta.bin_count, st]);

    // ── The stream ───────────────────────────────────────────────────────────
    //
    // Opened here and closed by the cleanup, which is what ties it to the panel
    // being open: an unmounted panel — collapsed, hidden, or a sheet that is not
    // showing — has no EventSource at all.
    useEffect(() => {
        const es = new EventSource(streamUrl(band));
        let seen = false;

        es.addEventListener('spectrum', (e) => {
            // Counted before decoding, and as delivered: this is what the
            // stream costs, not what the picture is worth.
            st.bytes += e.data.length;
            const frame = decodeFrame(e.data);
            if (!frame) return;
            const next = applyFrame(st.bins, frame, meta.bin_count);
            if (!next) return;                  // a delta with no full frame yet
            st.bins = next;
            commit(st, meta.bin_count);
            seen = true;
        });
        es.addEventListener('heartbeat', (e) => { st.bytes += (e.data || '').length; });

        // Throughput, read once a second. A stall then reads as 0 rather than
        // leaving the last figure up, which is the thing worth knowing.
        let last = performance.now();
        const rateTimer = setInterval(() => {
            const now = performance.now();
            const elapsed = now - last;
            last = now;
            const bytes = st.bytes;
            st.bytes = 0;
            if (elapsed > 0 && (seen || bytes)) onRate((bytes * 1000) / elapsed);
        }, 1000);

        return () => {
            clearInterval(rateTimer);
            es.close();
            onRate(null);
        };
    }, [band, meta.bin_count, st, onRate]);

    // ── Drawing ──────────────────────────────────────────────────────────────
    useEffect(() => {
        let raf = 0;
        const loop = () => {
            if (st.dirty) {
                st.dirty = false;
                draw(st, specRef.current, wfRef.current);
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, [st]);

    // ── Hover readout ────────────────────────────────────────────────────────
    //
    // Frequency from the band's own edges, level from the nearest bin — over the
    // trace that is the live frame, over the waterfall it is the stored row
    // under the pointer, which is a measurement from a minute ago rather than
    // one reconstructed from a colour.
    const read = useCallback((e) => {
        const wrap = wrapRef.current;
        const spec = specRef.current;
        if (!wrap || !spec || !st.bins) return;
        const r = wrap.getBoundingClientRect();
        if (!r.width || !r.height) return;

        const xFrac = (e.clientX - r.left) / r.width;
        const xPct = Math.min(100, Math.max(0, xFrac * 100));
        const yPct = Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100));

        const hz = hzAt(meta, xFrac);
        const bin = binAt(st.bins.length, xFrac);

        // Which canvas the pointer is on, by its own box rather than by the
        // fraction — the two are not the same height.
        const specBox = spec.getBoundingClientRect();
        const overWf = e.clientY > specBox.bottom;

        let db = dbFromByte(st.bins[bin]);
        let age = null;
        if (overWf) {
            const wfBox = wfRef.current ? wfRef.current.getBoundingClientRect() : null;
            const yf = wfBox && wfBox.height ? (e.clientY - wfBox.top) / wfBox.height : 0;
            const idx = rowAt(st.rows.length, yf, WF_ROWS);
            if (idx >= 0 && st.rows[idx] && bin < st.rows[idx].length) {
                db = st.rows[idx][bin];
                age = (st.rows.length - 1 - idx) * st.period;
            }
        }

        setAt({
            freq: formatMHz(hz),
            db: formatDb(db),
            age: age === null ? null : formatAgeSec(age / 1000),
            xPct,
            yPct,
            ...tipPlacement(e.pointerType, xPct, yPct),
        });
    }, [meta, st]);

    const leave = useCallback((e) => {
        if (readoutClearsOn(e.pointerType)) setAt(null);
    }, []);

    // Canvas pixels follow the box and the display density, so the trace is a
    // hairline on a phone as on a monitor.
    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap) return undefined;
        const size = () => {
            const w = wrap.clientWidth;
            if (!w) return;
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const h = Math.max(MIN_H, Math.min(MAX_H, Math.round(w * ASPECT)));
            const specH = Math.round(h * SPEC_FRACTION);
            const wfH = h - specH;
            for (const [c, cssH] of [[specRef.current, specH], [wfRef.current, wfH]]) {
                if (!c) continue;
                c.style.height = `${cssH}px`;
                c.width = Math.round(w * dpr);
                c.height = Math.round(cssH * dpr);
            }
            setWidth(w);
            st.dirty = true;
        };
        size();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(size);
        ro.observe(wrap);
        return () => ro.disconnect();
    }, [st]);

    return (
        <div
            className="bsp__chart"
            ref={wrapRef}
            onPointerDown={read}
            onPointerMove={read}
            onPointerLeave={leave}
        >
            <canvas className="bsp__spec" ref={specRef} />

            {/* The frequency scale, between the two pictures it belongs to
                equally. No unit: the strip is 14 px tall and "MHz" three times
                over says nothing the band name has not already. */}
            <div className="bsp__scale">
                {scaleTicks(meta, width).map((k) => (
                    <React.Fragment key={k.hz}>
                        <span
                            className="bsp__notch"
                            style={k.align === 'end' ? { right: 0 } : { left: `${k.pct}%` }}
                        />
                        <span
                            className={`bsp__tick bsp__tick--${k.align}`}
                            style={k.align === 'center' ? { left: `${k.pct}%` } : undefined}
                        >
                            {k.label}
                        </span>
                    </React.Fragment>
                ))}
            </div>

            <canvas className="bsp__wf" ref={wfRef} />
            {at && (
                <>
                    <span className="bsp__cross" style={{ left: `${at.xPct}%` }} />
                    <span
                        className={`bsp__tip${at.left ? ' bsp__tip--left' : ''}${at.above ? ' bsp__tip--above' : ''}`}
                        style={{ left: `${at.xPct}%`, top: `${at.yPct}%` }}
                    >
                        <span className="bsp__tip-row">
                            <b>{at.freq}</b>
                            <span className="bsp__tip-db">{at.db}</span>
                        </span>
                        {at.age && <span className="bsp__tip-age">{at.age}</span>}
                    </span>
                </>
            )}
        </div>
    );
}

// ── Frame handling, outside React ────────────────────────────────────────────

// A frame has arrived: keep it, re-run the auto range, push a waterfall row.
function commit(st, binCount) {
    const now = Date.now();
    if (st.lastAt) {
        const gap = now - st.lastAt;
        // Plausible gaps only: a stall or a throttled tab is not the data rate.
        if (gap >= 60 && gap <= 4000) st.period += (gap - st.period) * 0.2;
    }
    st.lastAt = now;

    const n = st.bins.length;
    const row = new Float32Array(n);
    for (let i = 0; i < n; i++) row[i] = dbFromByte(st.bins[i]);
    st.rows.push(row);
    if (st.rows.length > WF_ROWS) st.rows.shift();

    let moved = false;
    const valid = validValues(st.bins);
    if (valid) moved = updateAutoRange(st.auto, valid, valid.length, now);

    // A fresh ring has just been painted from the history, this row included, so
    // writing it again would put a duplicate at the other end of the buffer.
    const built = ensureRing(st, binCount);
    if (moved && st.prefs.auto) {
        repaintHistory(st, binCount);       // one scale across the whole history
    } else if (!built) {
        st.head = (st.head - 1 + WF_ROWS) % WF_ROWS;
        writeRow(st, row, st.head);
    }
    st.dirty = true;
}

function range(st) {
    return rangeOf(st.prefs.auto, st.auto, st.prefs, AUTO_SPAN_DEFAULT);
}

// Returns true when it built (or rebuilt) the ring, which repaints the history.
function ensureRing(st, binCount) {
    if (st.off && st.off.width === binCount) return false;
    st.off = document.createElement('canvas');
    st.off.width = binCount;
    st.off.height = WF_ROWS;
    st.offCtx = st.off.getContext('2d');
    st.offCtx.fillStyle = '#000';
    st.offCtx.fillRect(0, 0, binCount, WF_ROWS);
    st.rowPx = st.offCtx.createImageData(binCount, 1);
    st.rowBuf = new Uint32Array(st.rowPx.data.buffer);
    st.head = 0;
    repaintHistory(st, binCount);
    return true;
}

function writeRow(st, row, y) {
    if (!st.off || row.length !== st.off.width || !st.cmap) return;
    const { lo, hi } = range(st);
    const span = (hi - lo) || 1;
    const buf = st.rowBuf;
    for (let i = 0; i < row.length; i++) {
        const t = (row[i] - lo) / span;
        buf[i] = st.cmap[t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255)];
    }
    st.offCtx.putImageData(st.rowPx, 0, y);
}

// Recolour every stored row in one blit. This runs on each auto-range step, and
// doing it as WF_ROWS separate putImageData calls made for a long frame at
// exactly the wrong moment.
function repaintHistory(st, binCount) {
    if (!st.off || st.off.width !== binCount || !st.cmap) return;
    const img = st.offCtx.createImageData(binCount, WF_ROWS);
    const buf = new Uint32Array(img.data.buffer);
    buf.fill(0xFF000000);                    // opaque black where there is no history
    const { lo, hi } = range(st);
    const span = (hi - lo) || 1;
    const rows = st.rows;
    for (let r = rows.length - 1, y = 0; r >= 0 && y < WF_ROWS; r--, y++) {
        const src = rows[r];
        if (src.length !== binCount) continue;
        const base = y * binCount;
        for (let i = 0; i < binCount; i++) {
            const t = (src[i] - lo) / span;
            buf[base + i] = st.cmap[t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255)];
        }
    }
    st.offCtx.putImageData(img, 0, 0);
    st.head = 0;
}

function draw(st, spec, wf) {
    if (spec) drawSpectrum(st, spec);
    if (wf) drawWaterfall(st, wf);
}

function drawSpectrum(st, canvas) {
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, w, h);

    const { lo, hi } = range(st);
    const span = (hi - lo) || 1;

    // Horizontal grid every 10 dB, which is what makes the trace a measurement
    // rather than a shape.
    c.strokeStyle = 'rgba(255,255,255,0.07)';
    c.lineWidth = 1;
    const stepDb = span > 80 ? 20 : 10;
    for (let db = Math.ceil(lo / stepDb) * stepDb; db <= hi; db += stepDb) {
        const y = Math.round(h - ((db - lo) / span) * h) + 0.5;
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
    }

    // ── The FT8 window ───────────────────────────────────────────────────────
    // The band's configured dial frequency and the 3 kHz of USB above it, which
    // is where the traffic that makes a band look busy actually is. Drawn under
    // the trace so it reads as a region of the band rather than as data.
    if (st.ft8) {
        const x1 = Math.max(0, st.ft8.start * w);
        const x2 = Math.min(w, st.ft8.end * w);
        if (x2 > x1) {
            c.fillStyle = 'rgba(76,175,80,0.12)';
            c.fillRect(x1, 0, Math.max(x2 - x1, 1), h);
            c.strokeStyle = 'rgba(76,175,80,0.6)';
            c.lineWidth = 1;
            c.setLineDash([3, 3]);
            c.beginPath();
            c.moveTo(Math.round(x1) + 0.5, 0);
            c.lineTo(Math.round(x1) + 0.5, h);
            c.stroke();
            c.setLineDash([]);

            const size = Math.max(9, Math.round(h / 9));
            c.font = `${size}px ui-monospace, monospace`;
            c.textBaseline = 'top';
            c.fillStyle = 'rgba(190,240,190,0.9)';
            const tw = c.measureText('FT8').width;
            c.fillText('FT8', x1 + tw + 6 > w ? Math.max(0, x1 - tw - 4) : x1 + 4, 3);
        }
    }

    const bins = st.bins;
    if (!bins || !bins.length) return;
    const n = bins.length;

    // The trace is stroked with a vertical gradient built from the palette, so a
    // point's colour is the colour that same level has in the waterfall below —
    // peaks in the hot end, the noise floor in the cold — without changing
    // colour per sample while drawing.
    const grad = c.createLinearGradient(0, h, 0, 0);
    const lut = st.lut;
    for (let s = 0; s <= 8; s++) {
        const i = Math.round((s / 8) * 255);
        grad.addColorStop(s / 8, `rgb(${lut[i * 3]},${lut[i * 3 + 1]},${lut[i * 3 + 2]})`);
    }

    const yOf = (db) => {
        const t = (Math.max(lo, Math.min(hi, db)) - lo) / span;
        return h - t * h;
    };

    c.beginPath();
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const y = yOf(dbFromByte(bins[i]));
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.lineTo(w, h);
    c.lineTo(0, h);
    c.closePath();
    c.globalAlpha = 0.28;
    c.fillStyle = grad;
    c.fill();
    c.globalAlpha = 1;

    c.beginPath();
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const y = yOf(dbFromByte(bins[i]));
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.strokeStyle = grad;
    c.lineWidth = Math.max(1, Math.round(w / 900));
    c.stroke();
}

function drawWaterfall(st, canvas) {
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h || !st.off) return;
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    // The ring is drawn in two blits, newest row at the top.
    const first = Math.min(WF_ROWS - st.head, WF_ROWS);
    const scale = h / WF_ROWS;
    c.drawImage(st.off, 0, st.head, st.off.width, first, 0, 0, w, first * scale);
    if (first < WF_ROWS) {
        c.drawImage(st.off, 0, 0, st.off.width, WF_ROWS - first,
            0, first * scale, w, (WF_ROWS - first) * scale);
    }
}
