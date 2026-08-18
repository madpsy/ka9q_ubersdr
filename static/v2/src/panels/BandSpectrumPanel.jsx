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
// While it *is* open the stream is kept open: a failure reopens it on a backoff
// and keeps trying for as long as the panel is there, so a receiver restarted
// under it is found again without anybody touching the panel. See retryDelay in
// lib/bandSpectrum.js for why the browser's own reconnect is not enough.
//
// `minimal` is the chart alone — the range controls are the first thing to go
// when a panel has been shrunk to glance at.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Empty, Icon, Switch } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { bandForFrequency } from '../lib/bands.js';
import { getPalette } from '../lib/palettes.js';
import {
    AUTO_SPAN_DEFAULT, applyFrame, bandsFromConfig, clampDb, configUrl,
    AUTO_BAND, FULL_ZOOM, ZOOM_FACTOR, bandList, chosenBand, createAutoRange, dbFromByte,
    decodeFrame, dialWindow, formatAgeSec,
    ACTIVITY_URL, formatDb, formatMHz, ft8Window, isZoomed, panByFraction, rangeOf,
    reportBandRate,
    rowAt, savePrefs,
    savedPrefs, scaleTicks, streamUrl, updateAutoRange, validValues, viewFrac, zoomAt, zoomBins,
    zoomHz,
} from '../lib/bandSpectrum.js';
import { retryDelay } from '../lib/backoff.js';
import { logEvent } from '../lib/eventLog.js';
import { readoutClearsOn, tipPlacement } from '../lib/hoverTip.js';
import { haptic } from '../lib/haptics.js';
import { getVfos, onVfosChanged } from '../lib/vfos.js';
import { formatRate } from '../lib/format.js';
import { RING_BG, RING_PAD, ringSlices, smoothInterval } from '../lib/waterfallRing.js';
import { TRACE_WIDTH, binsToPixels, paletteGradients, themeColors } from '../lib/spectrumTrace.js';
import { retentionFor } from '../lib/timeConstant.js';
import useFeedsAllowed from '../lib/useServerFeeds.js';

// The card's proportions, from band_activity.html: the block is this much of its
// own width, and the spectrum trace takes the top of it with the waterfall below.
const ASPECT = 200 / 340;
const SPEC_FRACTION = 80 / 200;
const MIN_H = 110;
const MAX_H = 320;          // a dock is not a grid cell — past this it crowds out its neighbours

// The theme variables this pane reads, resolved through the same cached lookup
// the main spectrum uses.
const THEME_VARS = ['--spec-bg', '--spec-grid'];

// Raw rows kept for recolouring. Deeper than fits on screen so the waterfall can
// be repainted from measurements when the range moves, rather than showing two
// scales at once.
const HISTORY_ROWS = 400;

export default function BandSpectrumPanel({ minimal }) {
    const { tuning, actions } = useRadio();
    const display = useDisplay();
    const [bands, setBands] = useState(null);       // name → config, or null while loading
    const [prefs, setPrefs] = useState(savedPrefs);
    // Bytes a second on the stream, or null before the first second is up.
    // A rate says both things the word "live" did and one it did not: whether
    // anything is arriving, and what it costs — a busy band's deltas are bigger
    // than a quiet one's, and a stall reads as 0 rather than as a still picture.
    const [rate, setRate] = useState(null);
    // Which VFO the dial belongs to, for the label on its marker. From the same
    // store the Receiver panel's buttons and the marker bar read.
    const [vfoId, setVfoId] = useState(() => getVfos().active);
    useEffect(() => onVfosChanged((v) => setVfoId(v.active)), []);
    const aliveRef = useRef(true);

    useEffect(() => () => { aliveRef.current = false; }, []);

    // Which band the panel is on: the pinned one, or the one the dial is in.
    const band = chosenBand(prefs.band, bands, bandForFrequency(tuning.frequency));
    const meta = bands && band ? bands[band] : null;
    const following = !bands || !prefs.band || prefs.band === AUTO_BAND || !bands[prefs.band];

    // Which bands have a dedicated FFT. Fetched on open — the panel is not
    // mounted until then, so a collapsed panel does not ask for this either.
    useEffect(() => {
        fetch(configUrl())
            .then((r) => (r.ok ? r.json() : null))
            .then((cfg) => { if (aliveRef.current && cfg) setBands(bandsFromConfig(cfg)); })
            .catch(() => { if (aliveRef.current) setBands({}); });
    }, []);

    // Clicking the chart tunes there, the same way clicking the main spectrum
    // does: the current mode is kept — you are inside a band you are already
    // listening to — and the frequency is snapped to the Receiver panel's step,
    // so the chart and the +/- buttons agree about where the channels are.
    const tune = useCallback((hz) => {
        const step = display.tuneStep || 1;
        actions.setFrequency(step > 1 ? Math.round(hz / step) * step : hz);
        // The receiver moved, and on a phone the finger is over the place it
        // moved to. This is the confirmation.
        haptic('tune', 'spectrum');
    }, [actions, display.tuneStep]);

    const setPref = useCallback((patch) => {
        setPrefs((p) => {
            const next = { ...p, ...patch };
            savePrefs(next);
            return next;
        });
    }, []);

    if (bands === null) return <Empty>Loading…</Empty>;
    if (!meta) {
        // Only reachable while following the dial: a pinned band is one the
        // receiver records, or the pin has already fallen back to following.
        return (
            <div className="stack">
                <Empty>
                    {band ? `No dedicated spectrum for ${band}.` : 'Tune into a band to see its spectrum.'}
                </Empty>
                {!minimal && <BandPicker bands={bands} value={prefs.band} onChange={setPref} />}
            </div>
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
                display={display}
                tuning={tuning}
                vfoId={vfoId}
                onTune={tune}
                onRate={setRate}
            />

            {!minimal && (
                <>
                    <div className="bsp__foot">
                        <span className="bsp__band">{band}</span>
                        {!following && <span className="bsp__pinned" title="Pinned — not following the dial">pinned</span>}
                        <span className="bsp__range">{formatSpanMHz(meta)}</span>
                        <span
                            className={`bsp__state${rate ? ' is-live' : ''}`}
                            title="Data arriving on this band's spectrum stream"
                        >
                            {formatRate(rate)}
                        </span>
                    </div>

                    <div className="bsp__ctl">
                        <BandPicker bands={bands} value={prefs.band} onChange={setPref} live={band} />
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

                    {/* v1's band activity page: every band at once, over hours. Last,
                        under the controls, because it is where you go when this panel has
                        raised a question it cannot answer — one band, live, is a good look
                        at now and no help at all with "which band has been busy this
                        afternoon".

                        Not in the minimal view, like every other link out of a panel: it
                        opens a second window, and a panel cut down to its picture is not
                        the place to be offered one. */}
                    <div className="bsp__foot-row">
                        {/* Sharing the last row with the link out, on the left: it is a
                            setting rather than one of the range controls above, and this is
                            the one row with space going spare. */}
                        <Switch
                            checked={prefs.zoom !== false}
                            onChange={(v) => setPref({ zoom: v })}
                            label="Zoom"
                            title="Wheel and pinch zoom the chart. Off gives the wheel back to the dock column it sits in"
                        />
                        <a
                            className="btn btn--ghost btn--sm"
                            href={ACTIVITY_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Band Activity
                            <Icon.External size={13} />
                        </a>
                    </div>
                </>
            )}
        </div>
    );
}

// Which band to show. Auto is the panel as it was: it follows the dial, and
// switching band on the receiver switches the picture. Pinning one is for
// watching a band you are not listening to — 20m while you work 40m — and it
// survives a reload, because a pin you have to set again every session is not
// a pin.
function BandPicker({ bands, value, onChange, live }) {
    const choice = value || AUTO_BAND;
    return (
        <select
            className="select bsp__band-pick"
            value={bands[choice] ? choice : AUTO_BAND}
            onChange={(e) => onChange({ band: e.target.value })}
            title="Which band this panel shows"
            aria-label="Band"
        >
            {/* Auto says what it resolved to, so the row does not have to be
                read twice to find out which band is on screen. */}
            <option value={AUTO_BAND}>{live && choice === AUTO_BAND ? `Auto — ${live}` : 'Auto'}</option>
            {bandList(bands).map((b) => (
                <option key={b.name} value={b.name}>{b.name}</option>
            ))}
        </select>
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
function BandChart({ band, meta, prefs, display, tuning, vfoId, onTune, onRate }) {
    const feeds = useFeedsAllowed();
    const wrapRef = useRef(null);
    const specRef = useRef(null);
    const wfRef = useRef(null);
    const clipRef = useRef(null);
    // What the pointer is over, or null. State rather than a ref: it is drawn as
    // DOM, and it changes at pointer speed rather than frame speed.
    const [at, setAt] = useState(null);
    // Measured width, which decides how many scale labels fit, and the height
    // the waterfall's clip box gets.
    const [width, setWidth] = useState(0);
    const [wfCss, setWfCss] = useState(0);
    // The window on the band, as fractions of it. Full band by default.
    const [zoom, setZoom] = useState(FULL_ZOOM);
    const zoomed = isZoomed(zoom);

    // Everything the draw path touches lives in one ref: React state per frame
    // at 4 Hz would re-render the panel forty times a minute for a picture that
    // is drawn imperatively anyway.
    const st = useRef({
        bins: null,
        rows: [],                    // raw dBFS history, newest last
        auto: createAutoRange(),
        prefs,
        // The palette as packed ABGR, one entry per level — what colouring a
        // waterfall row wants. Filled by the palette effect, which runs before
        // any frame can arrive.
        cmap: null,
        // The waterfall ring, in device pixels — the same shape as the main
        // waterfall's, so the same scroll works on it.
        ring: null, ringCtx: null,
        ringH: 0,                    // ring height in device px
        rowH: 2,                     // device px per row
        rowPx: null, rowBuf: null,
        head: 0,
        // Estimated gap between rows, which is how long a row has to slide.
        rowDt: 0, lastGap: 0, lastRow: 0,
        smooth: true,
        dpr: 1,
        scroll: null,                // the running slide, cancelled by the next
        scrolled: true,              // nothing to slide until a row arrives
        dirty: false,
        ft8: null,
        // Inter-arrival period, for putting an age on a waterfall row. Measured
        // rather than assumed: the rate is the server's, not ours.
        period: 250, lastAt: 0,
        // Bytes since the throughput was last read.
        bytes: 0,
        // Where the pointer is resting, so the readout can follow the data.
        ptr: null,
        // Whether this pointer sequence moved: a drag or a pinch, not a click.
        moved: false,
        // The trace, in pixels rather than bins — the main pane's arrangement,
        // so the same smoothing and peak hold work on it.
        px: null, smoothed: null, peak: null, peakAt: 0,
        gradKey: '', traceGrad: null, fillGrad: null,
        drawnAt: 0,
        d: null,
    }).current;

    st.prefs = prefs;
    st.ft8 = ft8Window(meta);
    st.dial = dialWindow(meta, tuning);
    st.bandName = band;
    st.vfoId = vfoId;
    // The Display panel's settings, read on every render: this pane honours the
    // same ones the main spectrum and waterfall do, so one switch governs both
    // and neither drifts away from the other.
    st.d = display;
    st.zoom = zoom;
    st.rowH = Math.max(1, Math.round(display.rowHeight || 2));
    st.smooth = display.smoothScroll !== false;

    // Palette as one Uint32 per level, which is what writing a waterfall row
    // wants — the LUT is three bytes a level for the main view's ImageData.
    useEffect(() => {
        const lut = getPalette(display.palette);
        const cmap = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            cmap[i] = (255 << 24) | (lut[i * 3 + 2] << 16) | (lut[i * 3 + 1] << 8) | lut[i * 3];
        }
        st.cmap = cmap;
        st.gradKey = '';                     // gradients belong to the old palette
        repaintHistory(st, meta.bin_count);
        st.dirty = true;
    }, [display.palette, display.contrast, meta.bin_count, st]);

    // A range change recolours the whole history, so old and new rows share one
    // scale rather than the waterfall showing a seam. A row-height change is a
    // different picture again, so the ring is rebuilt from the same rows.
    useEffect(() => {
        st.ring = null;
        ensureRing(st, meta.bin_count);
        st.dirty = true;
    }, [prefs.auto, prefs.min, prefs.max, meta.bin_count, display.rowHeight, st]);

    // Turning the scroll off has to put the canvas back straight away: the next
    // row would do it, but on a stream that has gone quiet there may not be one
    // and the picture would sit a row out of place.
    useEffect(() => {
        st.dirty = true;                     // a setting changed; redraw with it
        if (display.smoothScroll !== false) return;
        if (st.scroll) { st.scroll.cancel(); st.scroll = null; }
        if (wfRef.current) wfRef.current.style.transform = '';
    }, [display, st]);

    // ── The stream ───────────────────────────────────────────────────────────
    //
    // Opened here and closed by the cleanup, which is what ties it to the panel
    // being open: an unmounted panel — collapsed, hidden, or a sheet that is not
    // showing — has no EventSource at all.
    //
    // And reopened by this effect rather than by the browser. EventSource retries
    // a dropped stream itself, on a fixed timer and only for that one case; a
    // failure at the HTTP level closes it for good and leaves the panel showing a
    // picture that will never be added to. See retryDelay for the whole argument.
    // Every error is treated the same way here — close it and come back on the
    // curve — so there is one policy rather than the browser's timer running
    // alongside ours.
    useEffect(() => {
        // Gated with the rest of the app's feeds: this is a continuous stream,
        // and the loudest thing a stopped receiver was still asking for. See
        // lib/serverFeeds.js.
        if (!feeds) return undefined;
        let es = null;
        let retry = null;
        let attempts = 0;
        let stopped = false;
        let seen = false;
        // Whether this *attempt* has been reported as connected. Separate from
        // `seen`, which says whether the stream has ever produced — the rate
        // readout below leans on that to report a stall as 0 rather than as
        // nothing, so it must survive a reconnect.
        let logged = false;

        const open = () => {
            es = new EventSource(streamUrl(band));

            es.addEventListener('spectrum', (e) => {
                // Counted before decoding, and as delivered: this is what the
                // stream costs, not what the picture is worth.
                st.bytes += e.data.length;
                // A frame is proof the stream works, which is what resets the
                // backoff. Deliberately not the `open` event: a server that
                // accepts the connection and drops it immediately — a proxy with
                // nothing behind it — would reset the delay on every attempt and
                // turn this back into a fixed-rate retry.
                // First frame after a (re)connect is the only one worth a line:
                // this stream runs for as long as the panel is open, so logging
                // every frame would be logging the whole session.
                if (!logged) { logged = true; logEvent('info', `Band spectrum connected (${band})`); }
                attempts = 0;
                const frame = decodeFrame(e.data);
                if (!frame) return;
                const next = applyFrame(st.bins, frame, meta.bin_count);
                if (!next) return;                  // a delta with no full frame yet
                st.bins = next;
                commit(st, meta.bin_count);
                seen = true;
            });
            es.addEventListener('heartbeat', (e) => {
                st.bytes += (e.data || '').length;
                attempts = 0;
            });

            es.addEventListener('error', () => {
                // Ours now: closing it stops the browser retrying on its own
                // schedule as well, which would otherwise mean two clients asking
                // for the same stream at two different rates.
                if (es) { es.close(); es = null; }
                if (stopped || retry) return;
                const wait = retryDelay(attempts);
                attempts++;
                logEvent('warn', `Band spectrum (${band}) lost — retrying in ${Math.round(wait / 1000)}s (attempt ${attempts})`);
                logged = false;
                retry = setTimeout(() => { retry = null; if (!stopped) open(); }, wait);
            });
        };

        open();

        // Throughput, read once a second. A stall then reads as 0 rather than
        // leaving the last figure up, which is the thing worth knowing — and a
        // stream waiting to be reopened is exactly such a stall, so the readout
        // says so for as long as it lasts.
        let last = performance.now();
        const rateTimer = setInterval(() => {
            const now = performance.now();
            const elapsed = now - last;
            last = now;
            const bytes = st.bytes;
            st.bytes = 0;
            if (elapsed > 0 && (seen || bytes)) {
                const bps = (bytes * 1000) / elapsed;
                onRate(bps);
                // And into the shared reading, so the spectrum's stats overlay
                // can count this stream in the session total — it is the third
                // thing on the wire and the only one with a panel of its own.
                reportBandRate(bps);
            }
        }, 1000);

        return () => {
            stopped = true;
            clearTimeout(retry);
            clearInterval(rateTimer);
            if (es) es.close();
            // Closing the panel closes the stream, and that was the one thing
            // here the log did not say. The connect and the retries were both
            // reported, so a collapsed dock left a "Band spectrum connected"
            // as the last word on a stream that had stopped — or worse, a
            // "retrying in 30s" for a retry that would never happen.
            logEvent('info', `Band spectrum closed (${band})`);
            onRate(null);
            reportBandRate(null);
        };
    }, [band, meta.bin_count, st, onRate, feeds]);

    useEffect(() => { st.dirty = true; }, [zoom, st]);
    useEffect(() => {
        st.dirty = true;
    }, [tuning.frequency, tuning.bandwidthLow, tuning.bandwidthHigh, vfoId, st]);

    // ── Zoom and pan ─────────────────────────────────────────────────────────
    //
    // A wheel notch zooms about the pointer, so rolling over a signal pulls that
    // signal closer instead of scrolling the band past it. Two fingers do the
    // same thing about the point between them.
    //
    // The wheel listener is attached by hand rather than with onWheel: React
    // registers that one passively, and a passive listener cannot stop the page
    // scrolling underneath the zoom.
    //
    // All of it can be switched off — see the Zoom toggle at the foot of the panel. A chart
    // in a scrolling dock column is the reason: a wheel over it has two plausible meanings,
    // this one claims it, and somebody who would rather scroll the column can say so. Off
    // means the listener is not attached at all rather than attached and doing nothing, so
    // the wheel is the column's again including its preventDefault.
    const canZoom = prefs.zoom !== false;

    // Switched off while zoomed in: back to the whole band, because the pan and reset
    // buttons only exist while zoomed and turning the gestures off would otherwise leave a
    // window nothing could move.
    useEffect(() => {
        if (!canZoom) setZoom(FULL_ZOOM);
    }, [canZoom]);

    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap || !canZoom) return undefined;
        const onWheel = (e) => {
            e.preventDefault();
            const r = wrap.getBoundingClientRect();
            if (!r.width) return;
            const at = (e.clientX - r.left) / r.width;
            setZoom((z) => zoomAt(z, at, e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR));
        };
        wrap.addEventListener('wheel', onWheel, { passive: false });
        return () => wrap.removeEventListener('wheel', onWheel);
    }, [canZoom]);

    // Pinch. Two pointers down and the distance between them is the zoom, the
    // point between them is what it zooms about — the same gesture as a photo,
    // and the same anchor rule as the wheel.
    const pinch = useRef(new Map()).current;
    const pinchRef = useRef(null);
    // A drag in progress, once it has travelled far enough to be one.
    const drag = useRef(null);

    const onPointerDown = useCallback((e) => {
        // Nothing to track with the gestures off — but the press is still a click, and a
        // click still tunes, so `moved` has to be cleared as it is below.
        if (!canZoom) { st.moved = false; return; }
        pinch.set(e.pointerId, e.clientX);
        if (pinch.size === 2) {
            const xs = [...pinch.values()];
            pinchRef.current = { dist: Math.abs(xs[0] - xs[1]) };
            drag.current = null;             // two fingers is a pinch, not a drag
            st.moved = true;                 // and never a click
            return;
        }
        st.moved = false;
        // Zoomed, and not a press on one of the buttons sitting over the chart.
        if (!zoomed || (e.target.closest && e.target.closest('button'))) return;
        drag.current = { id: e.pointerId, x: e.clientX, moved: false };
        if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
    }, [canZoom, pinch, st, zoomed]);

    const onPointerUp = useCallback((e) => {
        pinch.delete(e.pointerId);
        if (pinch.size < 2) pinchRef.current = null;
        if (drag.current && drag.current.id === e.pointerId) drag.current = null;
        if (wrapRef.current) wrapRef.current.style.cursor = '';
    }, [pinch]);

    // Drag the band under the window. Returns true when the move was a pan, so
    // the readout knows to stay out of the way — dragging is a gesture about
    // where you are looking, not a question about a pixel.
    const onDragMove = useCallback((e) => {
        if (!canZoom) return false;
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return false;
        // A mouse with no button down is a hover that happens to follow a click.
        if (e.pointerType === 'mouse' && !e.buttons) { drag.current = null; return false; }

        const dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) < 3) return false;   // still a click, not a drag
        const wrap = wrapRef.current;
        const r = wrap ? wrap.getBoundingClientRect() : null;
        if (!r || !r.width) return false;

        d.moved = true;
        st.moved = true;                    // ...so the release is not a click
        d.x = e.clientX;
        if (wrap) wrap.style.cursor = 'grabbing';
        // Dragging right moves the band right, which is moving the window left.
        setZoom((z) => panByFraction(z, -(dx / r.width)));
        return true;
    }, [canZoom]);

    // A drag belongs to the pointer, not to the element it started on.
    //
    // It used to be driven from the chart's own pointermove and ended by its
    // pointerleave, and with a mouse that is the same thing: the press captures
    // the pointer, so the moves keep arriving and the leave never fires until it
    // is over. A finger is not the same thing. Safari does not hold a touch to
    // the element it went down on the way the capture asks it to, so a pan that
    // crossed onto the frequency strip — or over a readout that unmounted from
    // under it, which happens on the first move of every drag — raised a
    // pointerleave, and the leave ended the gesture. What was left was a pan
    // that moved a few pixels per touch and then stopped, which is exactly what
    // it looked like.
    //
    // So the moves are taken from the window and the gesture ends on pointerup
    // or pointercancel, wherever those land. Nothing about crossing a boundary
    // can stop a drag now, because nothing is listening for one.
    useEffect(() => {
        const onMove = (e) => { if (drag.current) onDragMove(e); };
        const onEnd = (e) => onPointerUp(e);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onEnd);
            window.removeEventListener('pointercancel', onEnd);
        };
    }, [onDragMove, onPointerUp]);

    const onPinchMove = useCallback((e) => {
        if (!canZoom) return false;
        if (!pinch.has(e.pointerId)) return false;
        pinch.set(e.pointerId, e.clientX);
        if (pinch.size !== 2 || !pinchRef.current) return false;

        const wrap = wrapRef.current;
        const r = wrap ? wrap.getBoundingClientRect() : null;
        if (!r || !r.width) return true;
        const xs = [...pinch.values()];
        const dist = Math.abs(xs[0] - xs[1]);
        const prev = pinchRef.current.dist;
        if (dist > 4 && prev > 4) {
            const at = ((xs[0] + xs[1]) / 2 - r.left) / r.width;
            setZoom((z) => zoomAt(z, at, dist / prev));
        }
        pinchRef.current.dist = dist;
        return true;                        // a pinch is not a hover
    }, [canZoom, pinch]);

    // ── Hover readout ────────────────────────────────────────────────────────
    //
    // Frequency from the band's own edges, level from the nearest bin — over the
    // trace that is the live frame, over the waterfall it is the stored row
    // under the pointer, which is a measurement from a minute ago rather than
    // one reconstructed from a colour.
    // The readout for a point on screen. Separate from the pointer handler
    // because it is wanted twice: when the pointer moves, and when a frame
    // arrives under a pointer that has not — a spectrum whose numbers are from
    // whenever you last twitched the mouse is not a live readout.
    const compute = useCallback((pt) => {
        const wrap = wrapRef.current;
        const spec = specRef.current;
        if (!wrap || !spec || !st.bins || !pt) return null;
        const r = wrap.getBoundingClientRect();
        if (!r.width || !r.height) return null;

        const xFrac = (pt.x - r.left) / r.width;
        const xPct = Math.min(100, Math.max(0, xFrac * 100));
        const yPct = Math.min(100, Math.max(0, ((pt.y - r.top) / r.height) * 100));

        // Frequency across the *visible* window, and the bin under it.
        const win = zoomHz(meta, st.zoom);
        const hz = Math.round(win.start + Math.min(1, Math.max(0, xFrac)) * (win.end - win.start));
        const b = zoomBins(st.bins.length, st.zoom);
        const bin = Math.min(b.last, b.first + Math.round(Math.min(1, Math.max(0, xFrac)) * (b.count - 1)));

        // Which pane the pointer is on, by its own box rather than by the
        // fraction — the two are not the same height.
        const overWf = pt.y > spec.getBoundingClientRect().bottom;

        let db = dbFromByte(st.bins[bin]);
        let age = null;
        if (overWf) {
            // The clip box, not the canvas: the canvas is sliding within it,
            // and measuring against a moving box would step the reading a row
            // back and forth as the scroll animates.
            const clip = clipRef.current ? clipRef.current.getBoundingClientRect() : null;
            const yf = clip && clip.height ? (pt.y - clip.top) / clip.height : 0;
            const idx = rowAt(st.rows.length, yf, Math.floor(st.ringH / st.rowH) || 1);
            if (idx >= 0 && st.rows[idx] && bin < st.rows[idx].length) {
                db = st.rows[idx][bin];
                age = (st.rows.length - 1 - idx) * st.period;
            }
        }

        return {
            freq: formatMHz(hz),
            db: formatDb(db),
            age: age === null ? null : formatAgeSec(age / 1000),
            xPct,
            yPct,
            ...tipPlacement(pt.type, xPct, yPct),
        };
    }, [meta, st]);

    const read = useCallback((e) => {
        // A second finger is a pinch, and a held button is a pan. Neither is a
        // reading, and both leave the tip behind if it is not cleared.
        //
        // The pan is only *detected* here, never applied: this fires for the same
        // move the window listener above is already panning on, and doing it in
        // both places would move the band twice as far as the finger.
        if (onPinchMove(e) || (drag.current && drag.current.moved)) { st.ptr = null; setAt(null); return; }
        // Kept so the readout can be recomputed against the next frame without
        // the pointer having to move.
        st.ptr = { x: e.clientX, y: e.clientY, type: e.pointerType };
        const v = compute(st.ptr);
        if (v) setAt(v);
    }, [compute, onPinchMove, st]);

    // A press that neither panned nor pinched, and did not land on one of the
    // buttons over the chart, is a tune. Read from the same window arithmetic
    // the tooltip uses, so it tunes to the frequency it was showing.
    const onClick = useCallback((e) => {
        if (st.moved) { st.moved = false; return; }
        if (e.target.closest && e.target.closest('button')) return;
        const wrap = wrapRef.current;
        const r = wrap ? wrap.getBoundingClientRect() : null;
        if (!r || !r.width) return;
        const at = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const win = zoomHz(meta, st.zoom);
        onTune(Math.round(win.start + at * (win.end - win.start)));
    }, [meta, onTune, st]);

    const leave = useCallback((e) => {
        if (!readoutClearsOn(e.pointerType)) return;
        st.ptr = null;
        setAt(null);
    }, [st]);

    // ── Drawing ──────────────────────────────────────────────────────────────
    useEffect(() => {
        let raf = 0;
        const loop = () => {
            if (st.dirty) {
                st.dirty = false;
                draw(st, specRef.current, wfRef.current);
                // A frame has landed: whatever the pointer is resting on now
                // says something different from what it said before.
                if (st.ptr) {
                    const v = compute(st.ptr);
                    if (v) setAt(v);
                }
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, [compute, st]);

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

            const spec = specRef.current;
            if (spec) {
                spec.style.height = `${specH}px`;
                spec.width = Math.round(w * dpr);
                spec.height = Math.round(specH * dpr);
            }

            // The waterfall canvas is RING_PAD device pixels taller than the box
            // that clips it: that overhang is what the slide moves, so there is
            // always a row in hand to travel into view.
            const wf = wfRef.current;
            const ringH = Math.max(1, Math.round(wfH * dpr)) + RING_PAD;
            if (wf) {
                wf.style.height = `${wfH + RING_PAD / dpr}px`;
                wf.width = Math.round(w * dpr);
                wf.height = ringH;
            }
            st.dpr = dpr;
            st.ringH = ringH;
            setWfCss(wfH);
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
            className={`bsp__chart${zoomed ? ' bsp__chart--zoomed' : ''}`}
            ref={wrapRef}
            onPointerDown={(e) => { onPointerDown(e); read(e); }}
            onPointerMove={read}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onClick={onClick}
            /* The readout only. A gesture ends when the pointer is released,
               which the window listener hears wherever that happens — see the
               note there. */
            onPointerLeave={leave}
        >
            <canvas className="bsp__spec" ref={specRef} />

            {/* The frequency scale, between the two pictures it belongs to
                equally. No unit: the strip is 14 px tall and "MHz" three times
                over says nothing the band name has not already. */}
            <div className="bsp__scale">
                {scaleTicks(zoomHz(meta, zoom), width).map((k) => (
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

            {/* The clip for the waterfall's overhang — the canvas is taller
                than this box and slides within it. */}
            <div className="bsp__wfclip" ref={clipRef} style={{ height: `${wfCss}px` }}>
                <canvas className="bsp__wf" ref={wfRef} />
            </div>
            {/* Only while zoomed: at full span there is nowhere to pan and
                nothing to reset, and three buttons over a small chart would be
                three things covering the picture for no reason. */}
            {zoomed && (
                <>
                    <button
                        type="button"
                        className="bsp__nav bsp__nav--left"
                        title="Pan left"
                        aria-label="Pan left"
                        onClick={() => setZoom((z) => panByFraction(z, -0.25))}
                    >
                        <Icon.ChevronLeft size={14} />
                    </button>
                    <button
                        type="button"
                        className="bsp__nav bsp__nav--right"
                        title="Pan right"
                        aria-label="Pan right"
                        onClick={() => setZoom((z) => panByFraction(z, 0.25))}
                    >
                        <Icon.ChevronRight size={14} />
                    </button>
                    <button
                        type="button"
                        className="bsp__reset"
                        title="Show the whole band"
                        aria-label="Reset zoom"
                        onClick={() => setZoom(FULL_ZOOM)}
                    >
                        <Icon.Reset size={13} />
                    </button>
                </>
            )}

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
    if (st.rows.length > HISTORY_ROWS) st.rows.shift();

    let moved = false;
    const valid = validValues(st.bins);
    if (valid) moved = updateAutoRange(st.auto, valid, valid.length, now);

    // How long the last row took to arrive is the best guess at how long this
    // one has to slide into view. Estimated the way the main waterfall does it,
    // so jitter is damped and a genuine change of rate is adopted at once.
    if (st.lastRow) {
        const gap = now - st.lastRow;
        st.rowDt = smoothInterval(st.rowDt, gap, st.lastGap);
        st.lastGap = gap;
    }
    st.lastRow = now;

    // A fresh ring has just been painted from the history, this row included, so
    // writing it again would put a duplicate at the other end of the buffer.
    const built = ensureRing(st, binCount);
    if (moved && st.prefs.auto) {
        repaintHistory(st, binCount);       // one scale across the whole history
    } else if (!built) {
        writeRow(st, row);
    }
    st.scrolled = false;                    // the slide is started by the draw
    st.dirty = true;
}

function range(st) {
    return rangeOf(st.prefs.auto, st.auto, st.prefs, AUTO_SPAN_DEFAULT);
}

// Returns true when it built (or rebuilt) the ring, which repaints the history.
//
// The ring is the main waterfall's shape: device pixels tall, RING_PAD taller
// than the box that clips it, newest row written at a decrementing head. That
// overhang is what the smooth scroll slides — the newest row is painted above
// the top edge and travels down into view, so the picture moves continuously
// between rows instead of jumping when one arrives.
function ensureRing(st, binCount) {
    if (st.ring && st.ring.width === binCount && st.ring.height === st.ringH) return false;
    if (!st.ringH) return false;                 // not measured yet
    st.ring = document.createElement('canvas');
    st.ring.width = binCount;
    st.ring.height = st.ringH;
    st.ringCtx = st.ring.getContext('2d');
    st.ringCtx.fillStyle = RING_BG;
    st.ringCtx.fillRect(0, 0, binCount, st.ringH);
    st.rowPx = st.ringCtx.createImageData(binCount, 1);
    st.rowBuf = new Uint32Array(st.rowPx.data.buffer);
    st.head = 0;
    repaintHistory(st, binCount);
    return true;
}

// Colour one row and write it above the head, `rowH` device rows deep.
function writeRow(st, row) {
    if (!st.ring || row.length !== st.ring.width || !st.cmap) return;
    colourInto(st, row);
    for (let r = 0; r < st.rowH; r++) {
        st.head = (st.head - 1 + st.ringH) % st.ringH;
        st.ringCtx.putImageData(st.rowPx, 0, st.head);
    }
}

function colourInto(st, row) {
    const { lo, hi } = range(st);
    const span = (hi - lo) || 1;
    const buf = st.rowBuf;
    for (let i = 0; i < row.length; i++) {
        const t = (row[i] - lo) / span;
        buf[i] = st.cmap[t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255)];
    }
}

// Recolour every stored row in one blit, newest at the top. This runs on each
// auto-range step, and doing it as one putImageData per row made for a long
// frame at exactly the wrong moment.
function repaintHistory(st, binCount) {
    if (!st.ring || st.ring.width !== binCount || !st.cmap) return;
    const H = st.ringH;
    const img = st.ringCtx.createImageData(binCount, H);
    const buf = new Uint32Array(img.data.buffer);
    // Same background as the main waterfall's ring, so a panel with no history
    // yet reads as "nothing received" rather than as black data.
    const bg = 0xFF000000 | (parseInt(RING_BG.slice(5, 7), 16) << 16)
        | (parseInt(RING_BG.slice(3, 5), 16) << 8) | parseInt(RING_BG.slice(1, 3), 16);
    buf.fill(bg);

    const { lo, hi } = range(st);
    const span = (hi - lo) || 1;
    const rows = st.rows;
    let y = 0;
    for (let r = rows.length - 1; r >= 0 && y < H; r--) {
        const src = rows[r];
        if (src.length !== binCount) continue;
        for (let k = 0; k < st.rowH && y < H; k++, y++) {
            const base = y * binCount;
            for (let i = 0; i < binCount; i++) {
                const t = (src[i] - lo) / span;
                buf[base + i] = st.cmap[t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255)];
            }
        }
    }
    st.ringCtx.putImageData(img, 0, 0);
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
    const d = st.d || {};
    const c = canvas.getContext('2d', { alpha: false });

    const col = themeColors(THEME_VARS);
    c.fillStyle = col['--spec-bg'] || '#0a0d14';
    c.fillRect(0, 0, w, h);

    const bins = st.bins;
    if (!bins || !bins.length) return;

    // Gradients depend only on palette, contrast and height — not on the live dB
    // range — so they survive auto-levelling and are rebuilt rarely.
    const gradKey = `${d.palette}|${d.contrast}|${h}`;
    if (st.gradKey !== gradKey) {
        const grads = paletteGradients(c, h, d.palette || 'classic', d.contrast || 1);
        st.traceGrad = grads.trace;
        st.fillGrad = grads.fill;
        st.gradKey = gradKey;
    }

    // Bins onto pixels by the maximum of each pixel's range, so a carrier
    // narrower than a pixel survives being drawn — the same collapse the main
    // pane uses, and the reason a 1000-bin band in a 300 px dock still shows its
    // FT8 signals rather than whichever bin happened to land on the pixel.
    if (!st.px || st.px.length !== w) {
        st.px = new Float32Array(w);
        st.peak = new Float32Array(w).fill(-200);
        st.smoothed = null;
    }
    const dbRow = st.rows.length ? st.rows[st.rows.length - 1] : null;
    if (!dbRow) return;
    // Only the bins in the window: zooming is not a canvas transform, it is a
    // smaller slice of the band drawn across the same pixels, so a carrier gets
    // more of them rather than being magnified.
    const zb = zoomBins(dbRow.length, st.zoom);
    binsToPixels(dbRow.subarray(zb.first, zb.last + 1), w, st.px);

    // Seconds since the last draw, so the smoothing and the peak decay settle in
    // the same time however often frames arrive.
    const now = performance.now();
    const dt = st.drawnAt ? Math.min(1, (now - st.drawnAt) / 1000) : 0;
    st.drawnAt = now;

    // Temporal smoothing, per unit time rather than per frame — see
    // lib/timeConstant.js.
    let trace = st.px;
    if (d.smoothing > 0) {
        if (!st.smoothed || st.smoothed.length !== w) st.smoothed = Float32Array.from(st.px);
        const a = retentionFor(d.smoothing, dt);
        for (let i = 0; i < w; i++) st.smoothed[i] = st.smoothed[i] * a + st.px[i] * (1 - a);
        trace = st.smoothed;
    }

    const { lo, hi } = range(st);
    const span = (hi - lo) || 1;
    const yOf = (db) => h - ((Math.max(lo, Math.min(hi, db)) - lo) / span) * h;

    // The dB grid, on the same switch as the main pane's and at the same
    // spacing: every 10 dB, or 20 when ten would be a thicket.
    if (d.grid) {
        c.strokeStyle = col['--spec-grid'] || 'rgba(255,255,255,0.06)';
        c.lineWidth = 1;
        const step = span > 80 ? 20 : 10;
        for (let db = Math.ceil(lo / step) * step; db < hi; db += step) {
            const y = Math.round(yOf(db)) + 0.5;
            c.beginPath();
            c.moveTo(0, y);
            c.lineTo(w, y);
            c.stroke();
        }
    }

    // The labels along the top of the trace: the band's name, the dial, and the
    // FT8 window. All three want the same corner, and on most bands two of them
    // are within a few kHz of each other — 7.074 is inside 40m's FT8 window — so
    // each is placed on the first line it fits, in that order of precedence. The
    // band's name goes first because it is the one that says what you are
    // looking at rather than where something is in it.
    const labelSize = Math.max(9, Math.round(h / 9));
    const labelLine = labelSize + 2;
    const labelTop = 3;
    const placed = [];
    const placeLabel = (x, tw) => {
        for (let line = 0; line < 3; line++) {
            const clash = placed.some((q) => q.line === line
                && x < q.x + q.w + 4 && x + tw + 4 > q.x);
            if (!clash) {
                placed.push({ line, x, w: tw });
                return labelTop + line * labelLine;
            }
        }
        return labelTop + 2 * labelLine;
    };

    c.font = `${labelSize}px ui-monospace, monospace`;
    c.textBaseline = 'top';
    c.textAlign = 'left';

    // The band, in the corner. White, because it is the caption for the whole
    // picture rather than a mark on part of it.
    if (st.bandName) {
        const tw = c.measureText(st.bandName).width;
        const y = placeLabel(4, tw);
        c.fillStyle = 'rgba(255, 255, 255, 0.95)';
        c.fillText(st.bandName, 4, y);
    }

    let dialLabel = null;
    if (st.dial) {
        const dx = viewFrac(st.zoom, st.dial.at) * w;
        if (dx >= 0 && dx <= w) {
            const text = `VFO ${st.vfoId || 'A'}`;
            const tw = c.measureText(text).width;
            const x = dx + tw + 6 > w ? Math.max(0, dx - tw - 4) : dx + 4;
            dialLabel = { text, x, w: tw, y: placeLabel(x, tw) };
        }
    }

    // ── The FT8 window ───────────────────────────────────────────────────────
    // The band's configured dial frequency and the 3 kHz of USB above it, which
    // is where the traffic that makes a band look busy actually is. Under the
    // trace, so it reads as a region of the band rather than as data. The main
    // pane has no equivalent: it does not know which band it is looking at.
    if (st.ft8) {
        const x1 = Math.max(0, viewFrac(st.zoom, st.ft8.start) * w);
        const x2 = Math.min(w, viewFrac(st.zoom, st.ft8.end) * w);
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

            c.font = `${labelSize}px ui-monospace, monospace`;
            c.textBaseline = 'top';
            c.textAlign = 'left';
            c.fillStyle = 'rgba(190,240,190,0.9)';
            const tw = c.measureText('FT8').width;
            const lx = x1 + tw + 6 > w ? Math.max(0, x1 - tw - 4) : x1 + 4;
            c.fillText('FT8', lx, placeLabel(lx, tw));
        }
    }

    // ── Where the receiver is listening ──────────────────────────────────────
    // The same form as the FT8 window — shaded passband, a line at the dial and
    // a label — because it is the same kind of thing: a region of the band that
    // means something, drawn under the trace so it never competes with it. The
    // colour is the marker bar's VFO crimson, so "the VFO" is one colour
    // wherever it appears.
    if (st.dial) {
        const dx = viewFrac(st.zoom, st.dial.at) * w;
        if (dx >= 0 && dx <= w) {
            const x1 = Math.max(0, viewFrac(st.zoom, st.dial.start) * w);
            const x2 = Math.min(w, viewFrac(st.zoom, st.dial.end) * w);
            if (x2 > x1) {
                c.fillStyle = 'rgba(233, 30, 99, 0.14)';
                c.fillRect(x1, 0, Math.max(x2 - x1, 1), h);
            }

            c.strokeStyle = 'rgba(233, 30, 99, 0.75)';
            c.lineWidth = 1;
            c.setLineDash([3, 3]);
            c.beginPath();
            c.moveTo(Math.round(dx) + 0.5, 0);
            c.lineTo(Math.round(dx) + 0.5, h);
            c.stroke();
            c.setLineDash([]);

            if (dialLabel) {
                c.font = `${labelSize}px ui-monospace, monospace`;
                c.textBaseline = 'top';
                c.textAlign = 'left';
                c.fillStyle = 'rgba(255, 190, 215, 0.95)';
                c.fillText(dialLabel.text, dialLabel.x, dialLabel.y);
            }
        }
    }

    // Peak hold under the live trace, decaying in dB per second so the hold
    // time does not depend on how fast the stream happens to be arriving.
    if (d.peakHold) {
        const drop = (d.peakDecay || 0) * dt;
        for (let x = 0; x < w; x++) {
            const v = trace[x];
            st.peak[x] = v > st.peak[x] ? v : st.peak[x] - drop;
        }
    } else if (st.peak) {
        st.peak.fill(-200);
    }

    // Solid area under the trace, and the line only when there is none: filled,
    // the line follows the path the fill already ends on and all it does is
    // thicken every peak by its own width.
    const filled = d.fill !== false;
    if (filled) {
        c.beginPath();
        c.moveTo(0, h);
        for (let x = 0; x < w; x++) c.lineTo(x, yOf(trace[x]));
        c.lineTo(w, h);
        c.closePath();
        c.fillStyle = st.fillGrad;
        c.fill();
    }

    if (d.peakHold) {
        c.beginPath();
        for (let x = 0; x < w; x++) {
            const y = yOf(st.peak[x]);
            if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.strokeStyle = 'rgba(255,255,255,0.55)';
        c.lineWidth = st.dpr;
        c.stroke();
    }

    if (!filled) {
        c.beginPath();
        for (let x = 0; x < w; x++) {
            const y = yOf(trace[x]);
            if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.strokeStyle = st.traceGrad;
        c.lineWidth = TRACE_WIDTH * st.dpr;
        c.stroke();
    }
}

function drawWaterfall(st, canvas) {
    const w = canvas.width;
    if (!w || !st.ring) return;
    const c = canvas.getContext('2d', { alpha: false });
    c.imageSmoothingEnabled = false;
    // Newest row sits at the head; time runs downward through increasing
    // indices, wrapping once — so the whole ring is one or two contiguous runs.
    // Shared with the main waterfall; see lib/waterfallRing.js.
    // The window's columns, stretched across the canvas — the same slice the
    // trace above is drawn from, so the two stay in step.
    const rw = st.ring.width;
    const sx = st.zoom.start * rw;
    const sw = Math.max(1, (st.zoom.end - st.zoom.start) * rw);
    for (const s2 of ringSlices(st.head, st.ringH, st.ringH)) {
        c.drawImage(st.ring, sx, s2.sy, sw, s2.sh, 0, s2.dy, w, s2.sh);
    }

    // The picture has just moved down a row within the canvas, so putting the
    // canvas back up by the same amount leaves the screen exactly as it was —
    // and sliding it from there to nothing is the row arriving, spread over the
    // time until the next one instead of landing in a single frame. A composited
    // transform, so the browser moves a texture it already has.
    if (!st.scrolled) {
        st.scrolled = true;
        scrollRow(st, canvas, st.smooth ? st.rowH / st.dpr : 0, st.rowDt);
    }
}

// Slide the waterfall canvas up by one row and let it fall back. `rowCss` of 0
// is smooth scrolling turned off, or a first row with nothing to time against.
function scrollRow(st, wf, rowCss, duration) {
    if (st.scroll) {
        st.scroll.cancel();
        st.scroll = null;
    }
    if (!(rowCss > 0) || !(duration > 0) || typeof wf.animate !== 'function') {
        wf.style.transform = '';
        return;
    }
    st.scroll = wf.animate(
        // Linear, because the row is a constant slice of time and any easing
        // would show it arriving faster at one end than the other. Held at the
        // end so a feed that pauses rests in the right place.
        [{ transform: `translateY(${-rowCss}px)` }, { transform: 'translateY(0px)' }],
        { duration, easing: 'linear', fill: 'forwards' },
    );
}
