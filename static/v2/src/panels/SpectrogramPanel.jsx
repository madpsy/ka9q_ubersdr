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
import { Empty, Modal } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { bandForFrequency } from '../lib/bands.js';
import {
    POLL_MS, bandForView, bandLabel, freqTicks, fullUrl, listUrl, metaUrl,
    spectrogramEnabled, thumbUrl, timeTicks,
} from '../lib/spectrogram.js';

export { spectrogramEnabled };

export default function SpectrogramPanel({ minimal }) {
    const { tuning, serverInfo } = useRadio();
    const [bands, setBands] = useState(null);       // names the server records
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
            })
            .catch(() => { /* the image request will report the trouble */ });
    }, []);

    // The window advances one row a minute; so does the picture. The interval
    // dies with the panel, so a closed panel asks for nothing.
    useEffect(() => {
        const id = setInterval(() => setTick(Date.now()), POLL_MS);
        return () => clearInterval(id);
    }, []);

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
                title={`Last 24 hours — ${bandLabel(band)}. Click for full resolution.`}
            >
                {failed
                    ? <span className="sgram__pending">No spectrogram yet</span>
                    : (
                        <img
                            className="sgram__img"
                            src={thumb}
                            alt={`Rolling 24-hour spectrogram, ${bandLabel(band)}`}
                            onError={() => setFailed(true)}
                            onLoad={() => setFailed(false)}
                        />
                    )}
            </button>

            {!minimal && (
                <div className="sgram__foot">
                    <span className="sgram__band">{band === 'wideband-hf' ? 'Wideband HF' : band}</span>
                    <span className="sgram__range">{bandLabel(band)}</span>
                    <span className="sgram__note">last 24 h</span>
                </div>
            )}

            {zoomed && (
                <SpectrogramModal band={band} minute={minute} onClose={() => setZoomed(false)} />
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
function SpectrogramModal({ band, minute, onClose }) {
    const [meta, setMeta] = useState(null);
    const [state, setState] = useState('loading');  // loading | ok | error
    const aliveRef = useRef(true);

    useEffect(() => () => { aliveRef.current = false; }, []);

    useEffect(() => {
        fetch(metaUrl(band))
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('meta'))))
            .then((m) => { if (aliveRef.current) setMeta(m); })
            .catch(() => { /* the picture is still worth showing without scales */ });
    }, [band]);

    const fTicks = useMemo(
        () => (meta ? freqTicks(meta.start_freq_hz, meta.end_freq_hz) : []),
        [meta],
    );
    const tTicks = useMemo(
        () => (meta ? timeTicks(meta.rows, meta.row_count) : []),
        [meta],
    );

    return (
        <Modal onClose={onClose} label="Rolling 24-hour spectrogram">
            <div className="sgram-zoom">
                <div className="sgram-zoom__head">
                    <strong>{band === 'wideband-hf' ? 'Wideband HF' : band}</strong>
                    <span>{bandLabel(band)}</span>
                    <span>rolling 24 hours, one row per minute, UTC</span>
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

                    <div className="sgram-zoom__imgwrap">
                        <img
                            className="sgram-zoom__img"
                            src={fullUrl(band, minute)}
                            alt={`Rolling 24-hour spectrogram, ${bandLabel(band)}`}
                            onLoad={() => setState('ok')}
                            onError={() => setState('error')}
                        />
                        {/* Tick lines over the picture, so a label on the edge
                            still says which column it belongs to. */}
                        {fTicks.map((f) => (
                            <span key={f.hz} className="sgram-grid sgram-grid--v" style={{ left: `${f.pct}%` }} />
                        ))}
                        {tTicks.map((t) => (
                            <span key={`g${t.label}${t.pct}`} className="sgram-grid sgram-grid--h" style={{ top: `${t.pct}%` }} />
                        ))}
                        {state === 'loading' && <span className="sgram-zoom__wait">Loading full resolution…</span>}
                        {state === 'error' && <span className="sgram-zoom__wait">Image not available</span>}
                    </div>
                </div>

                {/* Frequency across the bottom, inset to clear the time gutter
                    so the two axes meet at the image's own corner. */}
                <div className="sgram-axis sgram-axis--freq">
                    {fTicks.map((f) => (
                        <span key={f.hz} className="sgram-axis__f" style={{ left: `${f.pct}%` }}>
                            {f.label}
                        </span>
                    ))}
                </div>
            </div>
        </Modal>
    );
}
