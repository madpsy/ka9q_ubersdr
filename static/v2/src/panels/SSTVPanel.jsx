// The pictures the SSTV addon has decoded.
//
// A port of widgets/sstv.widget.html, with one thing done differently: the
// widget fetched a single picture and walked backwards through the history with
// an offset, probing for the next one each time to decide whether its ← button
// should be live. The endpoint takes a `limit`, so this asks for however many
// you want to see in one request — the walk was working around a parameter that
// was there all along.
//
// How many is yours to choose, up to six, and it is remembered.
//
// `minimal` is the pictures and nothing else — no ages, no labels, no details,
// no download, no picker. It is a panel you have shrunk to glance at, and a
// decoded picture says what it is by being one.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Button, Empty, Field, Modal, Segmented } from '../components/ui.jsx';
import {
    AGE_TICK_MS, MAX_IMAGES, POLL_MS, detailRows, downloadName, formatAge,
    imageUrl, imagesUrl, records, saveCount, savedCount, sstvAvailable,
} from '../lib/sstv.js';

export { sstvAvailable };

const COUNTS = Array.from({ length: MAX_IMAGES }, (_, i) => ({
    value: i + 1,
    label: String(i + 1),
}));

export default function SSTVPanel({ minimal }) {
    const [count, setCount] = useState(savedCount);
    const [shots, setShots] = useState([]);
    const [state, setState] = useState('loading');   // loading | ok | empty | error
    const [now, setNow] = useState(() => Date.now());
    // The picture opened full size, or null.
    const [zoomed, setZoomed] = useState(null);
    const aliveRef = useRef(true);

    useEffect(() => () => { aliveRef.current = false; }, []);

    const load = useCallback((n) => {
        fetch(imagesUrl(n))
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((payload) => {
                if (!aliveRef.current) return;
                const list = records(payload);
                setShots(list);
                setState(list.length ? 'ok' : 'empty');
            })
            .catch(() => {
                if (!aliveRef.current) return;
                // A failed refresh leaves what is on screen: the pictures are
                // still the last ones decoded, whatever the addon is doing now.
                setState((s) => (s === 'ok' ? s : 'error'));
            });
    }, []);

    // Reloads when the count changes as well as on the timer, because asking
    // for more is asking for them now.
    useEffect(() => {
        load(count);
        const id = setInterval(() => load(count), POLL_MS);
        return () => clearInterval(id);
    }, [load, count]);

    // The age labels count up on their own.
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
        return () => clearInterval(id);
    }, []);

    const choose = (n) => {
        setCount(n);
        saveCount(n);
    };

    if (state === 'loading') return <Empty>Loading…</Empty>;
    if (state === 'error') return <Empty>The SSTV addon is not answering.</Empty>;

    return (
        <div className="stack">
            {!minimal && (
                <Field label="Pictures" hint={count === 1 ? 'latest only' : `latest ${count}`}>
                    <Segmented size="sm" options={COUNTS} value={count} onChange={choose} />
                </Field>
            )}

            {shots.length === 0 ? (
                <Empty>No pictures decoded yet.</Empty>
            ) : (
                <div className="sstv-grid">
                    {shots.map((rec, i) => {
                    const src = imageUrl(rec.file);
                    return (
                        <div className="sstv-shot" key={rec.id != null ? rec.id : src}>
                            {!minimal && (
                                <div className="sstv-shot__head">
                                    {/* Only worth labelling once there is more than
                                        one to tell apart. */}
                                    {shots.length > 1 && (
                                        <span className="sstv-shot__n">{i === 0 ? 'Latest' : `−${i}`}</span>
                                    )}
                                    <span className="sstv-shot__age">{formatAge(rec.rx_end, now)}</span>
                                    <a
                                        className="sstv-shot__dl"
                                        href={src}
                                        download={downloadName(rec.file)}
                                        title="Download this picture"
                                    >
                                        ⬇
                                    </a>
                                </div>
                            )}

                            {/* A tile is far smaller than the frame, and the
                                detail is the point of the picture — so it opens
                                here rather than in a tab you then have to come
                                back from. */}
                            <button
                                type="button"
                                className="sstv-shot__open"
                                title="Open full size"
                                onClick={() => setZoomed(rec)}
                            >
                                <img src={src} alt={`SSTV received ${rec.rx_end || ''}`} loading="lazy" />
                            </button>

                            {!minimal && (
                                <dl className="sstv-info">
                                    {detailRows(rec).map(([label, value]) => (
                                        <React.Fragment key={label}>
                                            <dt>{label}</dt>
                                            <dd title={value}>{value}</dd>
                                        </React.Fragment>
                                    ))}
                                </dl>
                            )}
                        </div>
                        );
                    })}
                </div>
            )}

            {zoomed && (
                <Modal onClose={() => setZoomed(null)} label="SSTV picture">
                    <div className="sstv-zoom">
                        {/* Twice the size it was decoded at, measured from the
                            picture itself rather than assumed: SSTV frames are
                            320 or 640 across depending on the mode, so a fixed
                            width would enlarge one and shrink the other. */}
                        <img
                            className="sstv-zoom__img"
                            src={imageUrl(zoomed.file)}
                            alt={`SSTV received ${zoomed.rx_end || ''}`}
                            onLoad={(e) => {
                                const w = e.target.naturalWidth;
                                if (w) e.target.style.width = `${w * 2}px`;
                            }}
                        />
                        <dl className="sstv-info">
                            {detailRows(zoomed).map(([label, value]) => (
                                <React.Fragment key={label}>
                                    <dt>{label}</dt>
                                    <dd title={value}>{value}</dd>
                                </React.Fragment>
                            ))}
                        </dl>
                        <div className="row-end">
                            <a
                                className="btn btn--ghost btn--sm"
                                href={imageUrl(zoomed.file)}
                                download={downloadName(zoomed.file)}
                            >
                                Download
                            </a>
                            <Button size="sm" variant="ghost" onClick={() => setZoomed(null)}>
                                Close
                            </Button>
                        </div>
                    </div>
                </Modal>
            )}
        </div>
    );
}
