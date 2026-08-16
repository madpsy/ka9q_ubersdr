// WEFAX decoder — v1's extension, rebuilt for v2.
//
// The decoding happens on the server: this attaches the `wefax` audio extension
// and paints the scanlines it sends back (see ./image.js). Everything v1 had is
// here — the station quick-tune, the five settings, the automatic start and
// stop, the transmission lamp, save — with one change that is worth stating
// plainly, because it is the difference between the two panels:
//
//   v1 had one canvas. When a transmission ended you either downloaded it there
//   and then or lost it, which is why its auto-download defaulted to on: the
//   alternative was watching for the stop tone yourself. That is a poor trade —
//   a decoder left running overnight writes a directory full of files nobody
//   asked for — so here a finished chart moves into a strip of received images
//   the panel keeps, each with its own download. Auto-download is still offered
//   and now defaults to off, because nothing is lost without it.
//
// The picture is a canvas at the transmission's own width, scaled down by CSS
// to fit the window. Nothing about it goes through React: lines arrive twice a
// second and are painted straight into the bitmap, and the only state that
// re-renders is the counters under it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Empty, Icon, Switch } from '../../components/ui.jsx';
import { useAudioExtension } from '../useAudioExtension.js';
import { tunedOption } from '../frequencies.js';
import { NumberField } from '../TeleprinterUI.jsx';
import {
    BANDWIDTHS, INITIAL_LINES, LIMITS, LPM_OPTIONS, WEFAX_CONFIG, WEFAX_STATIONS,
    attachParams, decodeFrame, growTo, lineSeconds, startsNewImage, stationAt, toRGBA,
} from './image.js';
import { saveFile } from '../../lib/saveFile.js';

// Fax is received in USB with the carrier placed inside the passband, so the
// filter has to be wide enough for the carrier plus its deviation and then some.
const WEFAX_MODE = 'usb';
const PASSBAND_HZ = 3000;

// Finished charts kept in the panel. Each is a PNG blob of a full page, so this
// is a few megabytes at most — and the URLs are revoked as they fall off the
// end, which is the part that leaks if you forget it.
const KEEP_IMAGES = 8;

// Below this a "transmission" is a burst of noise that happened to trip the
// tone detector, not a chart worth keeping. v1's number.
const MIN_KEEPABLE_LINES = 50;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * The receiving lamp: waiting for a start tone, drawing, or finished.
 *
 * Three states rather than a running/stopped pair because the middle one is the
 * question you actually have — a fax schedule has long gaps, and "attached but
 * nothing is being sent" must not look like "not working".
 */
function TransmissionLamp({ phase }) {
    const label = phase === 'receiving' ? 'Receiving' : (phase === 'ended' ? 'Ended' : 'Waiting');
    return (
        <span
            className={`wfx__lamp wfx__lamp--${phase}`}
            title={phase === 'receiving'
                ? 'A transmission is being drawn'
                : (phase === 'ended'
                    ? 'The stop tone was heard and the page is finished'
                    : 'Attached, waiting for a start tone. Fax schedules have long gaps')}
        >
            {label}
        </span>
    );
}

// `minimal` keeps the settings, the transport and the picture, and drops the
// view switches and the station readout row. See the registry's `minimal`.
export default function WefaxExtension({ minimal }) {
    const { running, audioState, tuning, actions } = useRadio();
    // Attaching needs the audio session, not merely the power switch — see the
    // note on the same line in FT8Extension.jsx.
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [config, setConfig] = useState(WEFAX_CONFIG);
    const [opts, setOpts] = useState({ autoScroll: true, autoDownload: false });
    // Only what has to be drawn in the DOM. The picture itself is in the canvas.
    const [status, setStatus] = useState({ lines: 0, width: 0, phase: 'waiting' });
    const [received, setReceived] = useState([]);

    const canvas = useRef(null);
    const scroller = useRef(null);
    // Everything the painting needs that must survive a render without causing
    // one: the canvas' allocated height, how much of it has been written, the
    // last line number seen, how far it has already been saved, and the scratch
    // buffer a line is converted in.
    //
    // `lines` lives here as well as in state, and that is the point: finishing
    // a page is a side effect, and reading the count out of a state updater to
    // decide whether to run it would run it twice under StrictMode.
    const paint = useRef({ height: 0, lines: 0, saved: 0, lastLine: null, rgba: null });

    const params = useMemo(() => attachParams(config), [config]);

    // ── the canvas ──────────────────────────────────────────────────────────

    const resetCanvas = useCallback((width) => {
        const c = canvas.current;
        if (!c) return;
        c.width = width;
        c.height = INITIAL_LINES;
        const ctx = c.getContext('2d');
        // Fax paper is white, and an unwritten page should look like one rather
        // than like a black rectangle the decoder failed to fill.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        paint.current.height = INITIAL_LINES;
        paint.current.lines = 0;
        paint.current.saved = 0;
        paint.current.lastLine = null;
    }, []);

    /**
     * Snapshot the lines drawn so far as a PNG and put it in the strip.
     *
     * Cropped to the lines actually received: the canvas is allocated in
     * doublings, so saving it whole would append a page of blank paper.
     */
    const finishImage = useCallback(() => {
        const c = canvas.current;
        const state = paint.current;
        const lineCount = state.lines;
        const width = c ? c.width : 0;
        // Nothing new since the last time this page was put away: a stop tone
        // followed by a start tone is two chances to save the same picture.
        if (!c || lineCount <= state.saved || lineCount < MIN_KEEPABLE_LINES) return;
        state.saved = lineCount;
        const crop = document.createElement('canvas');
        crop.width = width;
        crop.height = lineCount;
        crop.getContext('2d').drawImage(c, 0, 0, width, lineCount, 0, 0, width, lineCount);
        crop.toBlob((blob) => {
            if (!blob) return;
            const item = {
                id: `${Date.now()}-${lineCount}`,
                at: Date.now(),
                url: URL.createObjectURL(blob),
                width,
                height: lineCount,
            };
            setReceived((prev) => {
                const next = [item, ...prev];
                // Revoke what falls off the end, or the browser holds every
                // page of a night's reception until the tab closes.
                for (const old of next.slice(KEEP_IMAGES)) URL.revokeObjectURL(old.url);
                return next.slice(0, KEEP_IMAGES);
            });
            if (opts.autoDownload) download(item.url, `wefax_${stamp()}.png`);
        }, 'image/png');
    }, [opts.autoDownload]);

    const drawLine = useCallback((frame) => {
        const c = canvas.current;
        if (!c) return;

        // A width change means the settings changed under us; start again
        // rather than painting a narrow line into a wide page.
        if (c.width !== frame.width) resetCanvas(frame.width);

        const state = paint.current;
        if (startsNewImage(frame.line, state.lastLine)) {
            finishImage();
            resetCanvas(frame.width);
        }
        state.lastLine = frame.line;

        const want = frame.line + 1;
        if (want > state.height) {
            const height = growTo(state.height, want);
            if (height > state.height) {
                // Growing a canvas clears it, so the picture has to be carried
                // across rather than redrawn from lines we no longer hold.
                const keep = document.createElement('canvas');
                keep.width = c.width;
                keep.height = state.height;
                keep.getContext('2d').drawImage(c, 0, 0);
                c.height = height;
                const ctx = c.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, c.width, c.height);
                ctx.drawImage(keep, 0, 0);
                state.height = height;
            }
        }
        if (frame.line >= state.height) return;

        state.rgba = toRGBA(frame.pixels, state.rgba);
        const ctx = c.getContext('2d');
        ctx.putImageData(new ImageData(state.rgba.subarray(0, frame.width * 4), frame.width, 1), 0, frame.line);

        state.lines = Math.max(state.lines, want);
        setStatus((s) => (
            s.lines === state.lines && s.width === frame.width && s.phase === 'receiving'
                ? s
                : { lines: state.lines, width: frame.width, phase: 'receiving' }
        ));
    }, [finishImage, resetCanvas]);

    const onResult = (frame) => {
        if (frame.kind === 'line') {
            drawLine(frame);
        } else if (frame.kind === 'start') {
            // The server has just reset its line counter, so this is a new page
            // whether or not the numbering has told us yet.
            const width = canvas.current ? canvas.current.width : params.image_width;
            finishImage();
            resetCanvas(width);
            setStatus({ lines: 0, width, phase: 'receiving' });
        } else if (frame.kind === 'stop') {
            finishImage();
            setStatus((s) => ({ ...s, phase: 'ended' }));
        }
    };

    const { state: attachState, error } = useAudioExtension({
        name: 'wefax',
        params,
        active: decoding && live,
        parse: decodeFrame,
        onResult,
    });

    // Set the paper up once there is a canvas to set up, and again whenever the
    // configured width changes — the decoder will start sending that width, and
    // a page half drawn at the old one cannot be continued at the new.
    useEffect(() => {
        resetCanvas(params.image_width);
        setStatus((s) => (s.lines === 0 ? s : { ...s, lines: 0, width: params.image_width }));
    }, [params.image_width, resetCanvas]);

    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);
    useEffect(() => {
        if (!decoding) setStatus((s) => ({ ...s, phase: 'waiting' }));
    }, [decoding]);

    // Following the page down as it draws, which is the natural way to watch a
    // fax arrive.
    useEffect(() => {
        if (!opts.autoScroll || !scroller.current) return;
        scroller.current.scrollTop = scroller.current.scrollHeight;
    }, [status.lines, opts.autoScroll]);

    // Every kept image holds a blob alive; closing the window must let them go.
    const receivedRef = useRef(received);
    receivedRef.current = received;
    useEffect(() => () => {
        for (const item of receivedRef.current) URL.revokeObjectURL(item.url);
    }, []);

    const set = (patch) => setOpts((prev) => ({ ...prev, ...patch }));
    const setCfg = (patch) => setConfig((prev) => ({ ...prev, ...patch }));

    // The menu holds assigned frequencies and the dial sits a carrier below one,
    // so the comparison has to add that back.
    const tuned = tunedOption(WEFAX_STATIONS, tuning.frequency + params.carrier);

    const tuneTo = (hz) => {
        const station = stationAt(hz);
        // In USB the audio frequency is the offset above the dial, so putting
        // the fax carrier where the decoder listens means tuning that far below
        // the assigned frequency. This is v1's tuneToStation arithmetic.
        const dial = Math.round(hz - params.carrier);
        actions.tuneTo({
            frequency: dial,
            mode: WEFAX_MODE,
            bandwidthLow: 0,
            bandwidthHigh: PASSBAND_HZ,
        });
        actions.ensureVisible(dial);
        // A station's rate is part of what it is, as it was in v1's menu.
        if (station && station.lpm && station.lpm !== config.lpm) setCfg({ lpm: station.lpm });
    };

    const clear = () => {
        for (const item of received) URL.revokeObjectURL(item.url);
        setReceived([]);
        resetCanvas(canvas.current ? canvas.current.width : params.image_width);
        setStatus((s) => ({ ...s, lines: 0, phase: decoding ? 'waiting' : s.phase }));
    };

    const saveCurrent = () => {
        const c = canvas.current;
        if (!c || !status.lines) return;
        const crop = document.createElement('canvas');
        crop.width = c.width;
        crop.height = status.lines;
        crop.getContext('2d').drawImage(c, 0, 0, c.width, status.lines, 0, 0, c.width, status.lines);
        crop.toBlob((blob) => {
            if (!blob) return;
            saveFile(blob, `wefax_${stamp()}.png`);
        }, 'image/png');
    };

    const statusLabel = !decoding
        ? 'Stopped'
        : (attachState === 'running' ? 'Running' : (attachState === 'error' ? 'Error' : 'Starting…'));
    const statusTone = !decoding
        ? 'off'
        : (attachState === 'running' ? 'on' : (attachState === 'error' ? 'bad' : 'wait'));

    // How long the page on screen represents, which is the readable form of a
    // line count: a chart is ten minutes, and "1200 lines" is not.
    const minutes = status.lines * lineSeconds(config.lpm) / 60;

    return (
        <div className="tp wfx">
            <div className="tp__bar">
                <span
                    className={`tp__status tp__status--${statusTone}`}
                    title="Whether the decoder is attached to your audio session on the server"
                >
                    {statusLabel}
                </span>
                {decoding && <TransmissionLamp phase={status.phase} />}
                <span className="tp__bar-gap" />

                <select
                    className="select tp__freq wfx__freq"
                    value={tuned ? String(tuned.hz) : ''}
                    onChange={(e) => { if (e.target.value) tuneTo(Number(e.target.value)); }}
                    title={`Tune so the fax carrier lands on ${params.carrier} Hz of audio, in USB, and show which station the receiver is on. Choosing one also sets its line rate`}
                >
                    <option value="">Tune to…</option>
                    {WEFAX_STATIONS.map((g) => (
                        <optgroup key={g.group} label={g.group}>
                            {g.options.map((o) => <option key={o.hz} value={o.hz}>{o.label}</option>)}
                        </optgroup>
                    ))}
                </select>

                {decoding
                    ? (
                        <Button size="sm" onClick={() => setDecoding(false)} icon={<Icon.Stop size={13} />} title="Stop decoding and release the decoder on the server">
                            Stop
                        </Button>
                    )
                    : (
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setDecoding(true)}
                            disabled={!live}
                            icon={<Icon.Power size={13} />}
                            title={live
                                ? 'Start decoding the audio this receiver is tuned to'
                                : 'Start the receiver first — the decoder runs on your audio session'}
                        >
                            Start
                        </Button>
                    )}
                <Button size="sm" variant="ghost" onClick={saveCurrent} disabled={!status.lines} icon={<Icon.Download size={13} />} title="Download the page being drawn as a PNG" />
                <Button size="sm" variant="ghost" onClick={clear} disabled={!status.lines && !received.length} icon={<Icon.Trash size={13} />} title="Clear the page and every image kept" />
            </div>

            <div className="tp__config">
                <label className="tp__field" title="Lines per minute. 120 for almost every meteorological service">
                    <span className="tp__field-label">LPM</span>
                    <select className="select" value={config.lpm} onChange={(e) => setCfg({ lpm: Number(e.target.value) })}>
                        {LPM_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                </label>

                <NumberField
                    label="Carrier"
                    title="Audio frequency the fax carrier sits at, in Hz. 1900 is standard; this is also what the station menu tunes the signal onto"
                    value={config.carrier}
                    limits={LIMITS.carrier}
                    onCommit={(v) => setCfg({ carrier: v })}
                />
                <NumberField
                    label="Deviation"
                    title="How far the carrier swings between black and white, in Hz. 400 is standard"
                    value={config.deviation}
                    limits={LIMITS.deviation}
                    onCommit={(v) => setCfg({ deviation: v })}
                />
                <NumberField
                    label="Width"
                    title="Page width in pixels. 1809 matches the standard index of co-operation; changing it starts a new page"
                    value={config.image_width}
                    limits={LIMITS.image_width}
                    onCommit={(v) => setCfg({ image_width: v })}
                />

                <label className="tp__field" title="Demodulator input filter. Narrow rejects more noise but softens the picture">
                    <span className="tp__field-label">Filter</span>
                    <select className="select" value={config.bandwidth} onChange={(e) => setCfg({ bandwidth: Number(e.target.value) })}>
                        {BANDWIDTHS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                    </select>
                </label>

                <Switch
                    label="Phasing"
                    title="Use the phasing pulses that precede a chart to line the page up. Without it the picture is drawn correctly but slanted or split down the middle"
                    checked={!!config.use_phasing}
                    onChange={(v) => setCfg({ use_phasing: v })}
                />
                <Switch
                    label="Auto-start"
                    title="Wait for a start tone before drawing, so a page begins at the top rather than wherever you pressed Start"
                    checked={!!config.auto_start}
                    onChange={(v) => setCfg({ auto_start: v })}
                />
                <Switch
                    label="Auto-stop"
                    title="Stop drawing on the stop tone, so the page ends where the chart does"
                    checked={!!config.auto_stop}
                    onChange={(v) => setCfg({ auto_stop: v })}
                />
            </div>

            {!minimal && !running && <div className="note note--tight">Start the receiver to decode.</div>}
            {!minimal && running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {!minimal && live && !decoding && <div className="note note--tight">Tune to a fax frequency in USB, then press Start. Schedules have long gaps — leave it running.</div>}
            {decoding && tuning.mode !== 'usb' && tuning.mode !== 'lsb' && (
                <div className="note note--warn">
                    Fax needs a sideband mode; nothing will decode in {tuning.mode.toUpperCase()}.
                </div>
            )}
            {attachState === 'error' && <div className="note note--warn">{error}</div>}

            {!minimal && (
            <div className="tp__controls">
                <Switch
                    label="Auto-scroll"
                    title="Follow the page down as it draws"
                    checked={opts.autoScroll}
                    onChange={(v) => set({ autoScroll: v })}
                />
                <Switch
                    label="Auto-download"
                    title={`Save each finished page to disk as well as keeping it here. Off by default — the last ${KEEP_IMAGES} pages are kept either way, so nothing is lost without it`}
                    checked={opts.autoDownload}
                    onChange={(v) => set({ autoDownload: v })}
                />
                <span className="tp__bar-gap" />
                <span className="wfx__count" title="Lines drawn on the page, and how long that is at this line rate">
                    {status.lines
                        ? `${status.lines} lines · ${minutes.toFixed(1)} min`
                        : 'No lines yet'}
                </span>
            </div>
            )}

            {/* The canvas is at the transmission's own width and scaled down by
                CSS, so the picture is never resampled by us — the browser does
                it at draw time and a saved page is full resolution. */}
            <div className="tp__console wfx__paper" ref={scroller}>
                {status.lines === 0 && (
                    <Empty>
                        {decoding
                            ? 'Waiting for a transmission. Fax schedules have long gaps.'
                            : 'No page yet.'}
                    </Empty>
                )}
                <canvas
                    ref={canvas}
                    className="wfx__canvas"
                    style={{ display: status.lines ? 'block' : 'none' }}
                />
            </div>

            {received.length > 0 && (
                <div className="wfx__strip">
                    <span className="wfx__strip-label" title={`The last ${KEEP_IMAGES} finished pages, newest first. Click one to download it`}>
                        Received
                    </span>
                    {received.map((item) => (
                        <a
                            key={item.id}
                            className="wfx__thumb"
                            href={item.url}
                            download={`wefax_${new Date(item.at).toISOString().replace(/[:.]/g, '-')}.png`}
                            title={`${item.width} × ${item.height}, ${new Date(item.at).toLocaleTimeString()} — click to download`}
                        >
                            <img src={item.url} alt="" />
                        </a>
                    ))}
                </div>
            )}
        </div>
    );
}

// The images are held as blob URLs — that is what an <img> wants — and the
// saver wants the bytes, so they are read back out here. `fetch` on a blob URL
// hands over the same buffer rather than copying it, and the alternative would
// be keeping every decoded picture twice for the sake of the one that gets
// saved. See lib/saveFile.js for why an anchor is not enough.
async function download(url, name) {
    try {
        await saveFile(await (await fetch(url)).blob(), name);
    } catch (e) {
        console.error('save failed', e);
    }
}
