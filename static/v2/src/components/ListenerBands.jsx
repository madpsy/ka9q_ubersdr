// The Listeners panel's spectrum view: one bar per band, one dot per listener.
//
// The list answers "who is here"; this answers "where is everybody", which is
// the question the bands themselves answer badly in a list — twelve rows of
// frequencies do not add up to "the whole club is on 40" at a glance, and one
// row of dots does.
//
// The geometry is in lib/listenerBands.js, and so is what a dot says when you
// hover it — the marker bar above the spectrum draws the same dots with the
// same tip. This draws the row, and owns the one thing that is neither: the
// line marking where your own dial is.

import React, { useLayoutEffect, useMemo, useRef, useState } from '../react.js';
import { bandRows, dotTitle, gapPct, pctOf } from '../lib/listenerBands.js';

// What the row covers, as the row's own tooltip. Its own formatter rather than
// formatFreqShort: that one drops the decimals from a round megahertz, so a
// band would read "7 MHz – 7.300 MHz" and look like two different scales.
function rangeLabel(min, max) {
    if (min >= 1e6) return `${(min / 1e6).toFixed(3)} – ${(max / 1e6).toFixed(3)} MHz`;
    return `${(min / 1e3).toFixed(0)} kHz – ${(max / 1e6).toFixed(3)} MHz`;
}

function Row({ row, dialHz, now, onTune }) {
    const dial = pctOf(dialHz, row.min, row.max);
    const title = `${row.name} · ${rangeLabel(row.min, row.max)}`;
    // Named bands carry their hue; the catch-all row has none and takes the
    // neutral in the stylesheet instead — a colour would claim it is a band.
    const style = row.hue == null ? undefined : { '--lsn-hue': row.hue };

    return (
        <div className={`lsn-band${row.hue == null ? ' lsn-band--other' : ''}`} style={style}>
            <span className="lsn-band__name" title={title}>{row.name}</span>
            <div className="lsn-band__bar" title={title}>
                {/* Where you are tuned, whether or not you are one of the dots:
                    it is what makes the row a picture of the band rather than a
                    row of strangers. */}
                {dial != null && <i className="lsn-band__dial" style={{ left: `${dial}%` }} />}
                {row.spots.map((spot) => {
                    const many = spot.channels.length > 1;
                    const cls = `lsn-dot${spot.you ? ' is-you' : ''}${many ? ' is-many' : ''}`;
                    const pos = { left: `${spot.pct}%` };
                    const label = many ? String(spot.channels.length) : '';
                    // A dot with nobody to tune to — your own, or an IQ channel
                    // — is read, not pressed, for the same reason the static
                    // list rows are.
                    if (!spot.tune) {
                        return (
                            <span
                                key={spot.key}
                                className={`${cls} is-static`}
                                style={pos}
                                title={dotTitle(spot, now)}
                            >
                                {label}
                            </span>
                        );
                    }
                    return (
                        <button
                            key={spot.key}
                            type="button"
                            className={cls}
                            style={pos}
                            title={dotTitle(spot, now)}
                            onClick={() => onTune(spot.tune)}
                        >
                            {label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export default function ListenerBands({ channels, dialHz, minHz, maxHz, now, onTune }) {
    const wrap = useRef(null);
    // How wide a bar actually is, which is what decides how close two listeners
    // have to be to share a dot. See gapPct: the dock is resizable across a
    // factor of two and a half, and a threshold in percent is wrong at both
    // ends of that.
    const [barPx, setBarPx] = useState(0);

    useLayoutEffect(() => {
        const el = wrap.current;
        if (!el) return undefined;
        const measure = () => {
            // The bar itself rather than the container less the label column:
            // the label is `calc(30px * var(--ui-scale))` and the arithmetic
            // would be this file's copy of a number the stylesheet owns.
            const bar = el.querySelector('.lsn-band__bar');
            const w = bar ? bar.clientWidth : 0;
            // Only a real change, and never a fractional one: this runs after
            // every render, and a setter called with a value that differs in
            // the eighth decimal is a render loop.
            setBarPx((prev) => (Math.abs(prev - w) < 1 ? prev : w));
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        // The dock is dragged wider with nothing here re-rendering.
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const rows = useMemo(
        () => bandRows(channels, minHz, maxHz, gapPct(barPx)),
        [channels, minHz, maxHz, barPx],
    );

    return (
        <div className="lsn-bands" ref={wrap}>
            {rows.map((row) => (
                <Row key={row.name} row={row} dialHz={dialHz} now={now} onTune={onTune} />
            ))}
        </div>
    );
}
