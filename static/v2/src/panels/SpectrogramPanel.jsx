// The last 24 hours of the band, as a picture.
//
// The server keeps a rolling 24-hour spectrogram of the wideband receiver and
// of every band it records, one row per minute, and holds it in memory. This
// panel shows the thumbnail of whichever one matches where the dial is: the
// band you are in if the server records it, otherwise the wideband HF view
// (1.8–30 MHz, AM broadcast left out). Tuning to another band switches the
// picture — that is the point of it being in a panel rather than on its own
// page. Click it and the full-resolution image opens in a modal, with the
// frequency scale and time ticks that say what you are looking at.
//
// Fetching is tied to the panel being open, which costs nothing to arrange:
// Section only mounts a panel body while its section is open, so the mount is
// the "opened" event and the unmount cancels the timer. Nothing is requested
// for a collapsed or hidden panel, and the full-size image — megabytes, where
// the thumbnail is tens of kB — is only ever fetched when the modal opens.
//
// `minimal` is the picture alone: no band label, no age, no range. It is a
// panel someone has shrunk to glance at, and a spectrogram says what it is by
// being one.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { Empty, Icon, Modal } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { bandForFrequency } from '../lib/bands.js';
import {
    POLL_MS, bandForView, bandLabel, formatTzTag, freqTicks, fullUrl, listUrl, metaUrl,
    pageUrl, pointReadout, spectrogramEnabled, thumbUrl, timeTicks,
} from '../lib/spectrogram.js';
import { readoutClearsOn, tipPlacement } from '../lib/hoverTip.js';
import { feedInterval } from '../lib/serverFeeds.js';

export { spectrogramEnabled };

export default function SpectrogramPanel({ minimal }) {
    const { tuning, serverInfo } = useRadio();
    const [bands, setBands] = useState(null);       // names the server records
    const [ranges, setRanges] = useState(null);     // and what each one covers
    const [tick, setTick] = useState(() => Date.now());
    const [failed, setFailed] = useState(false);
    const [zoomed, setZoomed] = useState(false);
    const aliveRef = useRef(true);

    useEffect(() => () => { aliveRef.current = false; }, []);

    // Which recorder this panel is showing. Follows the dial.
    const band = useMemo(
        () => bandForView(bands, bandForFrequency(tuning.frequency)),
        [bands, tuning.frequency],
    );

    // The band list, once per opening. Cheap, and it is the only way to know
    // whether the band the dial is in is one the server actually records.
    useEffect(() => {
        fetch(listUrl())
            .then((r) => (r.ok ? r.json() : null))
            .then((info) => {
                if (!aliveRef.current || !info) return;
                setBands(Array.isArray(info.bands) ? info.bands : []);
                setRanges(info.band_ranges || null);
            })
            .catch(() => { /* the image request will report the trouble */ });
    }, []);

    const range = bandLabel(band, ranges);
    // The times on the picture are the receiver's wall clock, not the browser's
    // — it is that receiver's sky. Same figure the top bar's Local clock uses.
    const tzOffset = serverInfo?.receiver?.timezone_offset;

    // The window advances one row a minute; so does the picture. The interval
    // dies with the panel, so a closed panel asks for nothing — and it is gated,
    // because the tick is what changes the thumbnail's URL and so is a request
    // a minute in everything but name. See lib/serverFeeds.js.
    useEffect(() => feedInterval(() => setTick(Date.now()), POLL_MS), []);

    // A new band is a new picture, not a stale one that failed.
    useEffect(() => { setFailed(false); }, [band]);

    const minute = Math.floor(tick / POLL_MS);
    const thumb = thumbUrl(band, minute);

    const open = useCallback(() => setZoomed(true), []);

    if (!spectrogramEnabled(serverInfo)) return <Empty>Spectrogram recording is off.</Empty>;

    return (
        <div className="stack">
            <button
                type="button"
                className="sgram__thumb"
                onClick={open}
                title={`Last 24 hours — ${band}${range ? `, ${range}` : ''}. Click for full resolution.`}
            >
                {failed
                    ? <span className="sgram__pending">No spectrogram yet</span>
                    : (
                        <img
                            className="sgram__img"
                            src={thumb}
                            alt={`Rolling 24-hour spectrogram, ${band}`}
                            onError={() => setFailed(true)}
                            onLoad={() => setFailed(false)}
                        />
                    )}
            </button>

            {!minimal && (
                <div className="sgram__foot">
                    <span className="sgram__band">{band === 'wideband-hf' ? 'Wideband HF' : band}</span>
                    {/* The span it covers, when that is something the name does
                        not already say. */}
                    {range && <span className="sgram__range">{range}</span>}
                    <span className="sgram__note">last 24 h</span>
                    {/* The whole page, on the band being shown: zoom, playback,
                        a day at a time and the time-travel view, none of which
                        fits in a dock. Not in the minimal view, which is the
                        picture and nothing else. */}
                    <a
                        className="btn btn--ghost btn--sm sgram__open"
                        href={pageUrl(band)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open the full spectrogram page for this band"
                    >
                        Open
                        <Icon.External size={13} />
                    </a>
                </div>
            )}

            {zoomed && (
                <SpectrogramModal
                    band={band}
                    range={range}
                    minute={minute}
                    tzOffset={tzOffset}
                    onClose={() => setZoomed(false)}
                />
            )}
        </div>
    );
}

// The full-resolution image with its axes.
//
// Only mounted while the modal is open, so the megabyte image and the metadata
// behind the scales are fetched then and not before. The axes are the ones from
// the spectrogram page: frequency across the bottom, UTC time down the left,
// positioned as percentages of the image because it is drawn at one scale here
// — there is no zoom to keep them in step with.
//
// The image's width is measured rather than assumed, for one reason: it decides
// how many frequency labels fit. A 20m recorder ticks every 25 kHz, which is
// fourteen labels across a band that has room for four, and the unmeasured
// version printed them on top of each other.
function SpectrogramModal({ band, range, minute, tzOffset, onClose }) {
    const [meta, setMeta] = useState(null);
    const [state, setState] = useState('loading');  // loading | ok | error
    const [width, setWidth] = useState(0);
    // What the pointer is over, or null when it is not over the picture.
    const [at, setAt] = useState(null);
    const aliveRef = useRef(true);
    const imgWrapRef = useRef(null);

    useEffect(() => () => { aliveRef.current = false; }, []);

    useEffect(() => {
        fetch(metaUrl(band))
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('meta'))))
            .then((m) => { if (aliveRef.current) setMeta(m); })
            .catch(() => { /* the picture is still worth showing without scales */ });
    }, [band]);

    // The modal is sized off the viewport, so this settles once on open and
    // again if the window is resized under it.
    useEffect(() => {
        const el = imgWrapRef.current;
        if (!el) return undefined;
        const measure = () => setWidth(el.getBoundingClientRect().width);
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const fTicks = useMemo(
        () => (meta ? freqTicks(meta.start_freq_hz, meta.end_freq_hz, width) : []),
        [meta, width],
    );
    const tTicks = useMemo(
        () => (meta ? timeTicks(meta.rows, meta.row_count, tzOffset) : []),
        [meta, tzOffset],
    );
    const tzTag = formatTzTag(tzOffset);

    // Pointer rather than mouse, so one handler serves a mouse, a stylus and a
    // finger. On touch the tap is what asks the question — pointerdown puts the
    // readout up, dragging scrubs it along, and lifting leaves it up to be read.
    // Nothing here calls preventDefault or sets touch-action: a tall image in a
    // modal has to stay scrollable with the same finger.
    const read = useCallback((e) => {
        const el = imgWrapRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const xFrac = (e.clientX - r.left) / r.width;
        const yFrac = (e.clientY - r.top) / r.height;
        const point = pointReadout(meta, xFrac, yFrac, tzOffset);
        if (!point) return;
        const xPct = Math.min(100, Math.max(0, xFrac * 100));
        const yPct = Math.min(100, Math.max(0, yFrac * 100));
        setAt({ ...point, xPct, yPct, ...tipPlacement(e.pointerType, xPct, yPct) });
    }, [meta, tzOffset]);

    // A mouse leaving has stopped asking; a finger lifting has not.
    const onLeave = useCallback((e) => {
        if (readoutClearsOn(e.pointerType)) setAt(null);
    }, []);

    return (
        <Modal onClose={onClose} label="Rolling 24-hour spectrogram">
            <div className="sgram-zoom">
                <div className="sgram-zoom__head">
                    <strong>{band === 'wideband-hf' ? 'Wideband HF' : band}</strong>
                    {range && <span>{range}</span>}
                    <span>rolling 24 hours, one row per minute, {tzTag}</span>
                    {/* Nothing that follows the pointer belongs in this row.
                        The readout lived here for a while and was wrong twice
                        over: appearing on hover it widened the modal, and with
                        its width reserved it threw the rest of the row out of
                        alignment. It is on the tip by the cursor, which is
                        absolutely positioned and answers where you are looking
                        rather than where there happened to be room. */}
                </div>

                <div className="sgram-zoom__plot">
                    {/* Time down the left. Oldest at the top, newest at the
                        bottom, which is the way the image is built. */}
                    <div className="sgram-axis sgram-axis--time">
                        {tTicks.map((t) => (
                            <span key={t.label + t.pct} className="sgram-axis__t" style={{ top: `${t.pct}%` }}>
                                {t.label}
                            </span>
                        ))}
                    </div>

                    <div
                        className="sgram-zoom__imgwrap"
                        ref={imgWrapRef}
                        onPointerDown={read}
                        onPointerMove={read}
                        onPointerLeave={onLeave}
                    >
                        <img
                            className="sgram-zoom__img"
                            src={fullUrl(band, minute)}
                            alt={`Rolling 24-hour spectrogram, ${band}`}
                            onLoad={() => setState('ok')}
                            onError={() => setState('error')}
                        />
                        {/* Tick lines over the picture, so a label on the edge
                            still says which column it belongs to — and so an
                            unlabelled tick still marks its interval. */}
                        {fTicks.map((f) => (
                            <span key={f.hz} className="sgram-grid sgram-grid--v" style={{ left: `${f.pct}%` }} />
                        ))}
                        {tTicks.map((t) => (
                            <span key={`g${t.label}${t.pct}`} className="sgram-grid sgram-grid--h" style={{ top: `${t.pct}%` }} />
                        ))}

                        {at && (
                            <>
                                <span className="sgram-cross sgram-cross--v" style={{ left: `${at.xPct}%` }} />
                                <span className="sgram-cross sgram-cross--h" style={{ top: `${at.yPct}%` }} />
                                {/* Above the point on touch, where a fingertip
                                    is not covering it, and flipped away from the
                                    edges so it is never clipped. */}
                                <span
                                    className={`sgram-tip${at.left ? ' sgram-tip--left' : ''}${at.above ? ' sgram-tip--above' : ''}`}
                                    style={{ left: `${at.xPct}%`, top: `${at.yPct}%` }}
                                >
                                    <span className="sgram-tip__row">
                                        <b>{at.freq}</b>
                                        <span className="sgram-tip__time">{at.time} {at.tz}</span>
                                    </span>
                                    <span className="sgram-tip__ago">{at.ago}</span>
                                </span>
                            </>
                        )}

                        {state === 'loading' && <span className="sgram-zoom__wait">Loading full resolution…</span>}
                        {state === 'error' && <span className="sgram-zoom__wait">Image not available</span>}
                    </div>
                </div>

                {/* Frequency across the bottom, inset to clear the time gutter
                    so the two axes meet at the image's own corner. */}
                <div className="sgram-axis sgram-axis--freq">
                    {fTicks.filter((f) => f.label).map((f) => (
                        <span key={f.hz} className="sgram-axis__f" style={{ left: `${f.pct}%` }}>
                            {f.label}
                        </span>
                    ))}
                </div>
            </div>
        </Modal>
    );
}
