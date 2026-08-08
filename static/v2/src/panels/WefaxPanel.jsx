// WEFAX: the last weather fax page each frequency produced.
//
// The same shape as the NAVTEX panel — a picker, one item, and a modal to read it
// properly — because they are the same job: an addon that watches a couple of
// frequencies and produces one long thing at a time, of which a dock column can show
// the top.
//
// Clicking the page opens it full size. Fax pages are *tall*: about 1800 px across and
// often several thousand lines, so the modal fits them to its width and scrolls, with a
// 1:1 view a click away for reading the small print on a synoptic chart — and quarter-turn
// buttons, because a page arrives in whatever orientation the station sent it and a chart
// on its side is a puzzle. See the rotation notes in lib/wefax.js.
//
// `minimal` drops the picker and the link and keeps the page. The choice is remembered,
// so the minimal view is a way of pinning one frequency's latest chart to the dock.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Button, Empty, Icon, Modal, Segmented } from '../components/ui.jsx';
import { sinceLabel } from '../lib/format.js';
import {
    POLL_MS, addonUrl, channelImagesUrl, channelList, chosenImage, imageUrl, isTall,
    newestImage, pageSize, pickOptions, savePick, savedPick, sideways, sizeLabel, sortNewest,
    statusUrl, tookLabel, totalImages, turnBy, wefaxAvailable,
} from '../lib/wefax.js';

export { wefaxAvailable };

// How often the ages are redrawn. Pages arrive ten minutes apart, so this only keeps
// the "8m ago" honest between polls.
const TICK_MS = 30000;

export default function WefaxPanel({ minimal }) {
    const [channels, setChannels] = useState([]);
    const [images, setImages] = useState([]);
    const [pick, setPick] = useState(savedPick);
    const [state, setState] = useState('loading');   // loading | ok | error
    const [now, setNow] = useState(() => Date.now());
    // The page opened full size, and how it is being viewed. The image itself rather
    // than a flag: a poll can bring in a newer page while this one is being read, and
    // swapping the chart under the reader would be worse than showing an old one.
    const [viewing, setViewing] = useState(null);
    const [full, setFull] = useState(false);
    // Quarter turns, and the page's pixel size — needed because a page on its side has to be
    // laid out in a box with its axes swapped, not merely transformed. The addon reports the
    // size; `natural` is the fallback for a record that does not carry it, measured by the
    // browser when the image loads.
    const [turn, setTurn] = useState(0);
    const [natural, setNatural] = useState(null);
    const alive = useRef(true);
    // The image count the list was last fetched at. The whole polling strategy: ask a
    // 400-byte question every minute, and pay for the 300 KB answer only when it has
    // changed. See the note at the top of lib/wefax.js.
    const seenTotal = useRef(null);

    useEffect(() => () => { alive.current = false; }, []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(id);
    }, []);

    // One request per channel, in parallel. Not one request for the newest few overall:
    // the frequencies do not produce pages at the same rate, so a busy one fills any
    // window and a quiet one drops out of it — see channelImagesUrl for the live case
    // that showed it.
    const loadImages = useCallback((list) => {
        const chans = list.filter((c) => c.label);
        if (!chans.length) return;
        Promise.all(chans.map((c) => fetch(channelImagesUrl(c.label))
            .then((r) => (r.ok ? r.json() : null))
            .then((payload) => newestImage(payload))
            // One channel failing leaves the others: a missing page is better than an
            // empty panel.
            .catch(() => null)))
            .then((found) => {
                if (!alive.current) return;
                if (found.every((f) => f === null)) throw new Error('nothing answered');
                setImages(sortNewest(found));
                setState('ok');
            })
            .catch(() => {
                if (!alive.current) return;
                // Try again on the next status poll rather than leaving the panel
                // believing it is up to date.
                seenTotal.current = null;
                setState((s) => (s === 'ok' ? s : 'error'));
            });
    }, []);

    useEffect(() => {
        const poll = () => {
            fetch(statusUrl())
                .then((r) => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.json();
                })
                .then((status) => {
                    if (!alive.current) return;
                    const chans = channelList(status);
                    setChannels(chans);
                    setState((s) => (s === 'loading' ? 'ok' : s));
                    const total = totalImages(status);
                    // First time, or something has been decoded since the last look.
                    // The channels come from the same reply, so the fetch below always
                    // asks about the configuration as it stands now.
                    if (total == null || total !== seenTotal.current) {
                        seenTotal.current = total;
                        loadImages(chans);
                    }
                })
                .catch(() => {
                    if (!alive.current) return;
                    setState((s) => (s === 'ok' ? s : 'error'));
                });
        };
        poll();
        const id = setInterval(poll, POLL_MS);
        return () => clearInterval(id);
    }, [loadImages]);

    const choose = (value) => {
        setPick(value);
        savePick(value);
    };

    const open = (img) => {
        setViewing(img);
        // Fitted to the modal's width to begin with, whatever was chosen last time: a
        // chart you cannot see the shape of is not a chart, and 1:1 is a decision about
        // *this* page. Upright for the same reason — the turn that righted the last page
        // says nothing about this one, which may well have come from another station.
        setFull(false);
        setTurn(0);
        setNatural(null);
    };

    // What the modal needs to lay out a turned page: the size it is, and whether the turn
    // swaps its axes. Both are cheap and neither is used when nothing is open.
    const size = pageSize(viewing, natural);
    const side = sideways(turn);

    const options = pickOptions(channels, images);
    const labels = options.slice(1).map((o) => o.value);
    const img = chosenImage(images, pick, labels);
    const shownPick = options.some((o) => o.value === pick) ? pick : options[0].value;
    const waitingOn = options.find((o) => o.value === shownPick);

    if (state === 'loading') return <Empty>Loading…</Empty>;

    return (
        <div className="stack wx">
            {!minimal && options.length > 1 && (
                <Segmented size="sm" options={options} value={shownPick} onChange={choose} />
            )}

            {!img ? (
                <Empty>
                    {state === 'error'
                        ? 'The WEFAX addon is not answering.'
                        : shownPick !== options[0].value
                            ? `Nothing decoded on ${waitingOn ? waitingOn.label : shownPick} kHz yet.`
                            : 'No pages decoded yet.'}
                </Empty>
            ) : (
                <div className="wx__page">
                    <div className="wx__head">
                        <span className="wx__khz">{img.khz} kHz</span>
                        <span className="wx__size" title={`${sizeLabel(img)} pixels`}>{sizeLabel(img)}</span>
                        {img.snr != null && <span className="wx__snr">{Math.round(img.snr)} dB</span>}
                        <span className="wx__age" title={img.at ? new Date(img.at).toISOString() : undefined}>
                            {img.at ? sinceLabel(img.at, now) : '—'}
                        </span>
                    </div>

                    {/* The thumbnail the addon made, not the full page scaled down: the
                        page is 800 KB and this is 45, and a dock column is showing it
                        two inches wide either way. The full one is loaded when it is
                        asked for. */}
                    <button
                        type="button"
                        className="wx__thumb"
                        onClick={() => open(img)}
                        title="Open the full page"
                    >
                        <img src={imageUrl(img.thumb)} alt={`Weather fax from ${img.khz} kHz`} loading="lazy" />
                        <span className="wx__open">View</span>
                    </button>
                </div>
            )}

            {/* Full size. Fitted to the width to start with and scrolling downwards,
                because a fax page is tall and a chart shrunk to fit a screen is a grey
                rectangle; 1:1 is there for reading the isobars, and scrolls both ways.

                Everything here reads `viewing` — the page as it was when opened — and
                never the panel's current selection. A page arriving mid-read must not
                replace the one being looked at. */}
            {viewing && (
                <Modal onClose={() => setViewing(null)} label={`Weather fax ${viewing.khz} kHz`}>
                    <div className="wx__full">
                        <div className="wx__head">
                            <span className="wx__khz">{viewing.khz} kHz</span>
                            <span className="wx__size">{sizeLabel(viewing)}</span>
                            {tookLabel(viewing) && <span className="wx__took">{tookLabel(viewing)}</span>}
                            {viewing.snr != null && <span className="wx__snr">{viewing.snr.toFixed(1)} dB</span>}
                            <span className="wx__age">
                                {viewing.at
                                    ? `${new Date(viewing.at).toISOString().replace('T', ' ').slice(0, 19)} UTC`
                                    : '—'}
                            </span>
                        </div>

                        <div
                            className={`wx__paper${full ? ' is-full' : ''}`
                                + `${isTall(viewing) ? ' is-tall' : ''}`
                                + `${turn ? ' is-turned' : ''}`
                                + `${side ? ' is-side' : ''}`}
                            // The turn is a transform; the two numbers are the box the
                            // rotated page needs, which CSS cannot work out for itself. No
                            // size yet means no rotation offered, so they are never missing
                            // when they are needed.
                            style={{
                                '--turn': `${turn}deg`,
                                '--w': size ? size.w : 1,
                                '--h': size ? size.h : 1,
                            }}
                        >
                            <div className="wx__rot">
                                <img
                                    src={imageUrl(viewing.file)}
                                    alt={`Weather fax from ${viewing.khz} kHz`}
                                    // Only consulted when the record did not carry a size.
                                    onLoad={(e) => setNatural({
                                        w: e.target.naturalWidth,
                                        h: e.target.naturalHeight,
                                    })}
                                />
                            </div>
                        </div>

                        {/* Under the page, because they are things you do *to* it, and left
                            of the actions because turning it upright comes before deciding
                            what to do with it. Relative turns rather than four absolute
                            positions: a station that sends upside down sends every page
                            upside down, so one press is the common case either way. */}
                        <div className="wx__tools">
                            <div className="wx__turns">
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    icon={<Icon.RotateLeft size={13} />}
                                    disabled={!size}
                                    title="Rotate a quarter turn anticlockwise"
                                    aria-label="Rotate left"
                                    onClick={() => setTurn((t) => turnBy(t, -90))}
                                />
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    icon={<Icon.RotateRight size={13} />}
                                    disabled={!size}
                                    title="Rotate a quarter turn clockwise"
                                    aria-label="Rotate right"
                                    onClick={() => setTurn((t) => turnBy(t, 90))}
                                />
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={!size}
                                    title="Turn the page over"
                                    onClick={() => setTurn((t) => turnBy(t, 180))}
                                >
                                    180°
                                </Button>
                                {/* Which way up it is, and the way back. Only when it is not
                                    upright: a chip saying 0° is noise, and after three
                                    presses "how do I undo this" is a fair question. */}
                                {turn !== 0 && (
                                    <button
                                        type="button"
                                        className="wx__turn"
                                        title="Back to how it arrived"
                                        onClick={() => setTurn(0)}
                                    >
                                        {turn}°
                                    </button>
                                )}
                            </div>

                            <div className="row-end">
                            {/* Fit and 1:1, which is the whole of what a viewer for a
                                two-thousand-line chart needs: see the shape, then read
                                the detail. */}
                            <Button
                                size="sm"
                                variant="ghost"
                                active={full}
                                onClick={() => setFull((v) => !v)}
                            >
                                {full ? 'Fit width' : 'Actual size'}
                            </Button>
                            <a
                                className="btn btn--ghost btn--sm"
                                href={imageUrl(viewing.file)}
                                download={viewing.file}
                            >
                                Download
                            </a>
                            <a
                                className="btn btn--ghost btn--sm"
                                href={addonUrl()}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                Open WEFAX
                                <Icon.External size={13} />
                            </a>
                            <Button size="sm" variant="ghost" onClick={() => setViewing(null)}>
                                Close
                            </Button>
                            </div>
                        </div>
                    </div>
                </Modal>
            )}

            {/* The other channels and when they last produced something, so a panel
                showing one frequency does not hide a fresh chart on another. */}
            {!minimal && images.length > 1 && (
                <div className="wx__others">
                    {images.filter((m) => m !== img).map((m) => (
                        <button
                            key={m.label}
                            type="button"
                            className="wx__other"
                            onClick={() => choose(m.label)}
                            title={`${m.khz} kHz — ${sizeLabel(m)}`}
                        >
                            {m.khz} <i>{m.at ? sinceLabel(m.at, now) : '—'}</i>
                        </button>
                    ))}
                </div>
            )}

            {!minimal && (
                <div className="row-end">
                    <a
                        className="btn btn--ghost btn--sm"
                        href={addonUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Open WEFAX
                        <Icon.External size={13} />
                    </a>
                </div>
            )}
        </div>
    );
}
