// SSTV decoder — v1's extension, rebuilt for v2.
//
// The decoding happens on the server: this attaches the `sstv` audio extension
// and draws the pictures it sends back (see ./frames.js). What makes it more
// than WEFAX with colour is that an SSTV transmission has structure — a VIS
// code announcing the mode, the picture, a slant-corrected redraw of the same
// picture, and an FSK callsign after it — and the panel has to follow that
// sequence or it mislabels the results.
//
// The live picture is a canvas created by the decode path, not by React. That
// is unusual here and deliberate: a line can arrive in the same tick as the
// image-start that created its frame, and a canvas React has not mounted yet
// has nowhere to put it. So the canvas is made synchronously and React is only
// told where to hang it — see CanvasHost.
//
// One change from v1: a finished picture is snapshotted into a gallery the
// panel keeps, each with the mode and callsign it was received under. v1 kept
// live canvases for every image in a grid, which meant an evening on 14.230
// held a hundred of them; and its auto-save existed because there was no other
// way to keep one. Auto-save is still offered and still defaults to off.
//
// `minimal` keeps the frequency, the transport and the pictures, and drops the
// four decoder switches and the status row. This decoder is the one that needs
// setting up least of any of them — the mode is read from the VIS code, so there
// is nothing to choose and no shift or baud rate to find — which makes a cut-down
// SSTV window a picture and a Start button, and the switches the first thing that
// can go. They are a tap on the header away. See the registry's `minimal`.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Empty, Icon, Switch } from '../../components/ui.jsx';
import { useAudioExtension } from '../useAudioExtension.js';
import { tunedOption } from '../frequencies.js';
import {
    KEEP_IMAGES, MIN_KEEPABLE_LINES, SSTV_CONFIG, SSTV_FREQUENCIES,
    attachParams, decodeFrame, keepOnComplete, progressOf, toRGBA,
} from './frames.js';

const SSTV_MODE = 'usb';
const PASSBAND_HZ = 3000;

// The tone readout is emitted on every VIS detection pass — several times a
// second. It is a tuning aid, not a measurement, so it is throttled rather than
// re-rendering the panel at whatever rate the server happens to send.
const TONE_MS = 250;

const stamp = (at) => new Date(at).toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * Hangs a canvas the decode path owns into the React tree.
 *
 * The canvas exists before this renders and outlives it: it is created when the
 * picture starts so the first line has somewhere to go, and React only decides
 * where it is shown.
 */
function CanvasHost({ canvas, className }) {
    const box = useRef(null);
    useEffect(() => {
        const el = box.current;
        if (!el || !canvas) return undefined;
        el.appendChild(canvas);
        return () => { if (canvas.parentNode === el) el.removeChild(canvas); };
    }, [canvas]);
    return <div className={className} ref={box} />;
}

export default function SstvExtension({ minimal }) {
    const { running, audioState, tuning, actions } = useRadio();
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [config, setConfig] = useState(SSTV_CONFIG);
    const [opts, setOpts] = useState({ autoSave: false });
    // The picture being received: its geometry, what the VIS said it is, and
    // how far in it has got.
    const [current, setCurrent] = useState(null);
    const [status, setStatus] = useState('');
    const [tone, setTone] = useState(0);
    const [gallery, setGallery] = useState([]);

    // Everything the decode path touches. It runs off socket frames, not
    // renders, so none of it may live in state.
    const g = useRef({
        canvas: null, ctx: null, rgba: null,
        width: 0, height: 0, lines: 0, saved: false,
        // The VIS arrives before the picture it describes, so a mode is held
        // here until the image-start that uses it.
        pendingMode: '', mode: '', callsign: '',
        redrawing: false, redrawn: false, at: 0, toneAt: 0,
    });

    const params = useMemo(() => attachParams(config), [config]);

    // ── the picture ─────────────────────────────────────────────────────────

    /** Snapshot the picture on the canvas into the gallery, once. */
    const keepImage = useCallback(() => {
        const s = g.current;
        if (!s.canvas || s.saved || s.lines < MIN_KEEPABLE_LINES) return;
        s.saved = true;
        const { mode, callsign, at, width, height, lines } = s;
        s.canvas.toBlob((blob) => {
            if (!blob) return;
            const item = {
                id: `${at}-${lines}`,
                at,
                mode,
                callsign,
                width,
                height,
                lines,
                url: URL.createObjectURL(blob),
            };
            setGallery((prev) => {
                const next = [item, ...prev];
                for (const old of next.slice(KEEP_IMAGES)) URL.revokeObjectURL(old.url);
                return next.slice(0, KEEP_IMAGES);
            });
            if (opts.autoSave) download(item.url, `sstv_${stamp(at)}.png`);
        }, 'image/png');
    }, [opts.autoSave]);

    const startImage = useCallback((width, height) => {
        const s = g.current;
        // Whatever was on the canvas is finished with, complete or not — a
        // transmission cut short is still a picture worth keeping.
        keepImage();

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.className = 'sstv__canvas';
        const ctx = canvas.getContext('2d');
        // Mid grey rather than black: an SSTV frame that never fills reads as a
        // partial picture this way, and as a decoder failure the other.
        ctx.fillStyle = '#20242c';
        ctx.fillRect(0, 0, width, height);

        s.canvas = canvas;
        s.ctx = ctx;
        s.width = width;
        s.height = height;
        s.lines = 0;
        s.saved = false;
        s.at = Date.now();
        // The VIS that announced this picture arrived before it.
        s.mode = s.pendingMode;
        s.callsign = '';
        s.redrawing = false;
        s.redrawn = false;

        setCurrent({
            canvas, width, height, lines: 0, mode: s.mode, callsign: '', complete: false,
        });
    }, [keepImage]);

    const onResult = useCallback((frame) => {
        const s = g.current;
        switch (frame.kind) {
            case 'start':
                startImage(frame.width, frame.height);
                break;

            case 'mode':
                // Always about the picture that has not started yet. The server
                // sends the mode and the image-start as adjacent statements —
                // sendModeDetected then sendImageStart, with nothing between —
                // so a mode never describes the picture on screen. v1 applied
                // it to the current image when it was not redrawing, which
                // relabelled the *last* station's picture with the next one's
                // mode a moment before replacing it.
                s.pendingMode = frame.name;
                break;

            case 'line': {
                if (!s.ctx || frame.line >= s.height || frame.width !== s.width) break;
                s.rgba = toRGBA(frame.rgb, frame.width, s.rgba);
                s.ctx.putImageData(
                    new ImageData(s.rgba.subarray(0, frame.width * 4), frame.width, 1),
                    0, frame.line,
                );
                // A redraw repaints lines already drawn, so the count is the
                // furthest line reached and not the number of lines received.
                s.lines = Math.max(s.lines, frame.line + 1);
                // Painting again means what is on screen is no longer what was
                // saved, so a redraw is saved over the un-corrected version.
                s.saved = false;
                setCurrent((c) => (c && c.lines === s.lines ? c : (c ? { ...c, lines: s.lines } : c)));
                break;
            }

            case 'status':
                setStatus(frame.text);
                break;

            case 'redraw':
                s.redrawing = true;
                s.redrawn = true;
                setStatus('Redrawing with slant correction…');
                break;

            case 'complete':
                s.redrawing = false;
                setCurrent((c) => (c ? { ...c, complete: true } : c));
                setStatus(`Complete — ${frame.lines} lines`);
                // Not necessarily this picture's last word: with slant
                // correction on, the straightened version is still to come.
                if (keepOnComplete({ autoSync: config.auto_sync, redrawn: s.redrawn })) keepImage();
                break;

            case 'callsign':
                if (!frame.callsign) break;
                s.callsign = frame.callsign;
                setCurrent((c) => (c ? { ...c, callsign: frame.callsign } : c));
                // The callsign arrives after the picture, so the copy already
                // in the gallery has none. Label it now rather than leaving the
                // one identified picture of the evening anonymous.
                setGallery((prev) => (prev.length && !prev[0].callsign
                    ? [{ ...prev[0], callsign: frame.callsign }, ...prev.slice(1)]
                    : prev));
                break;

            case 'sync':
                break;

            case 'tone': {
                const now = Date.now();
                if (now - s.toneAt < TONE_MS) break;
                s.toneAt = now;
                setTone(frame.hz);
                break;
            }

            default:
                break;
        }
    }, [startImage, keepImage, config.auto_sync]);

    const { state: attachState, error } = useAudioExtension({
        name: 'sstv',
        params,
        active: decoding && live,
        parse: decodeFrame,
        onResult,
    });

    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);

    useEffect(() => {
        if (decoding) return;
        setStatus('');
        setTone(0);
        g.current.redrawing = false;
    }, [decoding]);

    // Every kept picture holds a blob alive; closing the window must let go.
    const galleryRef = useRef(gallery);
    galleryRef.current = gallery;
    useEffect(() => () => {
        for (const item of galleryRef.current) URL.revokeObjectURL(item.url);
    }, []);

    // ── actions ─────────────────────────────────────────────────────────────

    const set = (patch) => setOpts((prev) => ({ ...prev, ...patch }));
    const setCfg = (patch) => setConfig((prev) => ({ ...prev, ...patch }));

    const tuned = tunedOption(SSTV_FREQUENCIES, tuning.frequency);

    const tuneTo = (hz) => {
        actions.tuneTo({
            frequency: hz,
            mode: SSTV_MODE,
            bandwidthLow: 0,
            bandwidthHigh: PASSBAND_HZ,
        });
        actions.ensureVisible(hz);
    };

    const clear = () => {
        for (const item of gallery) URL.revokeObjectURL(item.url);
        setGallery([]);
        const s = g.current;
        s.canvas = null;
        s.ctx = null;
        s.lines = 0;
        s.saved = true;
        setCurrent(null);
    };

    const saveCurrent = () => {
        const s = g.current;
        if (!s.canvas || !s.lines) return;
        s.canvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            download(url, `sstv_${stamp(s.at)}.png`);
            URL.revokeObjectURL(url);
        }, 'image/png');
    };

    const statusLabel = !decoding
        ? 'Stopped'
        : (attachState === 'running' ? 'Running' : (attachState === 'error' ? 'Error' : 'Starting…'));
    const statusTone = !decoding
        ? 'off'
        : (attachState === 'running' ? 'on' : (attachState === 'error' ? 'bad' : 'wait'));

    const progress = current ? progressOf(current.lines, current.height) : 0;

    return (
        <div className="tp sstv">
            <div className="tp__bar">
                <span className={`tp__status tp__status--${statusTone}`} title="Whether the decoder is attached to your audio session on the server">
                    {statusLabel}
                </span>
                {current && current.mode && (
                    <span className="sstv__mode" title="The mode the VIS code announced">{current.mode}</span>
                )}
                {current && current.callsign && (
                    <span className="sstv__call" title="Callsign decoded from the FSK ident after the picture">{current.callsign}</span>
                )}
                <span className="tp__bar-gap" />

                <select
                    className="select tp__freq sstv__freq"
                    value={tuned ? String(tuned.hz) : ''}
                    onChange={(e) => { if (e.target.value) tuneTo(Number(e.target.value)); }}
                    title="Tune to an SSTV calling frequency in USB, and show which one the receiver is on"
                >
                    <option value="">Tune to…</option>
                    {SSTV_FREQUENCIES.map((grp) => (
                        <optgroup key={grp.group} label={grp.group}>
                            {grp.options.map((o) => <option key={o.hz} value={o.hz}>{o.label}</option>)}
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
                <Button size="sm" variant="ghost" onClick={saveCurrent} disabled={!current || !current.lines} icon={<Icon.Download size={13} />} title="Download the picture on screen as a PNG" />
                <Button size="sm" variant="ghost" onClick={clear} disabled={!current && !gallery.length} icon={<Icon.Trash size={13} />} title="Clear the picture and everything kept" />
            </div>

            {/* The four switches and the tone, in one box that goes as a box: it
                is bordered and padded, so keeping a corner of it — the tone
                readout on its own — would leave a panel with one number in it
                costing the same room the whole row did.

                Nothing here has to be set to get a picture, which is what makes
                this the right thing to drop: the mode comes from the VIS code,
                and the two switches worth having on are on already. */}
            {!minimal && (
                <div className="tp__config">
                    <Switch
                        label="Auto-sync"
                        title="Measure the sync pulses and re-send the picture with the slant corrected. Almost always wanted — without it a picture leans"
                        checked={!!config.auto_sync}
                        onChange={(v) => setCfg({ auto_sync: v })}
                    />
                    <Switch
                        label="FSK ident"
                        title="Decode the callsign some stations send as FSK after the picture"
                        checked={!!config.decode_fsk_id}
                        onChange={(v) => setCfg({ decode_fsk_id: v })}
                    />
                    <Switch
                        label="Adaptive"
                        title="Size the demodulator's window from the signal-to-noise ratio — wider when the signal is weak, sharper when it is strong. Almost always wanted"
                        checked={!!config.adaptive}
                        onChange={(v) => setCfg({ adaptive: v })}
                    />
                    <Switch
                        label="Auto-save"
                        title={`Save each finished picture to disk as well as keeping it here. Off by default — the last ${KEEP_IMAGES} are kept either way, so nothing is lost without it`}
                        checked={opts.autoSave}
                        onChange={(v) => set({ autoSave: v })}
                    />
                    <span className="tp__bar-gap" />
                    {decoding && (
                        <span className="sstv__tone" title="The tone the VIS detector is hearing. It settles on 1200 Hz when a header is being read">
                            {tone ? `${tone.toFixed(1)} Hz` : '— Hz'}
                        </span>
                    )}
                </div>
            )}

            {!minimal && !running && <div className="note note--tight">Start the receiver to decode.</div>}
            {!minimal && running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {!minimal && live && !decoding && (
                <div className="note note--tight">Tune to 14.230 MHz USB and press Start. The mode is detected from the VIS code — there is nothing to choose.</div>
            )}
            {decoding && tuning.mode !== SSTV_MODE && (
                <div className="note note--warn">SSTV is USB; nothing will decode in {tuning.mode.toUpperCase()}.</div>
            )}
            {attachState === 'error' && <div className="note note--warn">{error}</div>}

            {!minimal && (
                <div className="tp__controls">
                    <span className="sstv__status">{status || (decoding ? 'Waiting for a transmission…' : 'Stopped')}</span>
                    <span className="tp__bar-gap" />
                    {current && (
                        <span className="sstv__lines" title="Lines drawn, of the mode's total">
                            {current.lines} / {current.height}
                        </span>
                    )}
                </div>
            )}

            <div className="tp__console sstv__frame">
                {!current && (
                    <Empty>
                        {decoding
                            ? 'Waiting for a transmission. The mode is read from the VIS code that precedes it.'
                            : 'No picture yet.'}
                    </Empty>
                )}
                {current && <CanvasHost canvas={current.canvas} className="sstv__paper" />}
                {current && !current.complete && (
                    <div className="sstv__progress" aria-hidden="true">
                        <span style={{ width: `${progress * 100}%` }} />
                    </div>
                )}
            </div>

            {gallery.length > 0 && (
                <div className="sstv__gallery">
                    {gallery.map((item) => (
                        <a
                            key={item.id}
                            className="sstv__card"
                            href={item.url}
                            download={`sstv_${stamp(item.at)}.png`}
                            title={`${item.mode || 'Unknown mode'}${item.callsign ? ` · ${item.callsign}` : ''} · ${item.width}×${item.height} · ${new Date(item.at).toLocaleTimeString()} — click to download`}
                        >
                            <img src={item.url} alt="" />
                            <span className="sstv__card-meta">
                                <span className="sstv__card-mode">{item.mode || '—'}</span>
                                {item.callsign && <span className="sstv__card-call">{item.callsign}</span>}
                            </span>
                        </a>
                    ))}
                </div>
            )}
        </div>
    );
}

function download(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}
